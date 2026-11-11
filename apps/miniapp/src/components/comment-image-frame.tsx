import { useEffect, useRef, useState, type PointerEvent } from 'react';
import './comment-image-frame.css';

type Point = { x: number; y: number };
type View = Point & { scale: number };
type Gesture = {
  points: Point[];
  view: View;
  moved: boolean;
  pinched: boolean;
};

const initialView: View = { scale: 1, x: 0, y: 0 };
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export function CommentImageFrame({
  src,
  alt,
  onPrevious,
  onNext,
}: {
  src: string;
  alt: string;
  onPrevious?: () => void;
  onNext?: () => void;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const lastTap = useRef<{ point: Point; time: number } | null>(null);
  const currentView = useRef(initialView);
  const [view, setView] = useState(initialView);

  const updateView = (next: View) => {
    const frame = frameRef.current;
    const image = imageRef.current;
    const scale = Math.max(1, Math.min(4, next.scale));
    const maxX =
      frame && image ? Math.max(0, (image.clientWidth * scale - frame.clientWidth) / 2) : 0;
    const maxY =
      frame && image ? Math.max(0, (image.clientHeight * scale - frame.clientHeight) / 2) : 0;
    const bounded = {
      scale,
      x: Math.max(-maxX, Math.min(maxX, next.x)),
      y: Math.max(-maxY, Math.min(maxY, next.y)),
    };
    currentView.current = bounded;
    setView(bounded);
  };

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const observer = new ResizeObserver(() => updateView(currentView.current));
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const toggleZoom = () => updateView(view.scale > 1 ? initialView : { scale: 2, x: 0, y: 0 });
  const startGesture = (pinched = false) => {
    if (pinched) lastTap.current = null;
    gesture.current = {
      points: [...pointers.current.values()],
      view: currentView.current,
      moved: pinched,
      pinched,
    };
  };
  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest('button')) return;
    event.preventDefault();
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.currentTarget.setPointerCapture(event.pointerId);
    startGesture(pointers.current.size > 1);
  };
  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId) || !gesture.current) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointers.current.values()];
    const start = gesture.current;
    if (points.length >= 2 && start.points.length >= 2) {
      const frame = frameRef.current!.getBoundingClientRect();
      const origin = midpoint(start.points[0]!, start.points[1]!);
      const target = midpoint(points[0]!, points[1]!);
      const scale = Math.max(
        1,
        Math.min(
          4,
          (start.view.scale * distance(points[0]!, points[1]!)) /
            Math.max(1, distance(start.points[0]!, start.points[1]!)),
        ),
      );
      const ratio = scale / start.view.scale;
      updateView({
        scale,
        x:
          target.x -
          frame.x -
          frame.width / 2 -
          (origin.x - frame.x - frame.width / 2 - start.view.x) * ratio,
        y:
          target.y -
          frame.y -
          frame.height / 2 -
          (origin.y - frame.y - frame.height / 2 - start.view.y) * ratio,
      });
      start.moved = true;
    } else if (points[0] && start.points[0]) {
      const dx = points[0].x - start.points[0].x;
      const dy = points[0].y - start.points[0].y;
      if (Math.hypot(dx, dy) > 8) {
        start.moved = true;
        lastTap.current = null;
      }
      if (start.view.scale > 1)
        updateView({ ...start.view, x: start.view.x + dx, y: start.view.y + dy });
    }
  };
  const finishPointer = (event: PointerEvent<HTMLDivElement>, cancelled = false) => {
    if (!pointers.current.has(event.pointerId)) return;
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    const start = gesture.current;
    if (pointers.current.size) {
      startGesture(true);
      return;
    }
    gesture.current = null;
    if (!start || cancelled || start.pinched) return;
    const point = { x: event.clientX, y: event.clientY };
    const dx = point.x - start.points[0]!.x;
    const dy = point.y - start.points[0]!.y;
    if (start.view.scale === 1 && Math.abs(dx) >= 48 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      if (dx < 0) onNext?.();
      else onPrevious?.();
    } else if (!start.moved) {
      const previous = lastTap.current;
      if (
        previous &&
        event.timeStamp - previous.time < 300 &&
        distance(previous.point, point) < 30
      ) {
        toggleZoom();
        lastTap.current = null;
      } else lastTap.current = { point, time: event.timeStamp };
    }
  };

  return (
    <div
      ref={frameRef}
      className="channel-dialog-image-viewer__frame"
      data-zoomed={view.scale > 1}
      tabIndex={0}
      role="group"
      aria-label="Фото"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={(event) => finishPointer(event)}
      onPointerCancel={(event) => finishPointer(event, true)}
      onLostPointerCapture={(event) => finishPointer(event, true)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || view.scale === 1) return;
        const directions: Record<string, Point> = {
          ArrowLeft: { x: 40, y: 0 },
          ArrowRight: { x: -40, y: 0 },
          ArrowUp: { x: 0, y: 40 },
          ArrowDown: { x: 0, y: -40 },
        };
        const delta = directions[event.key];
        if (!delta) return;
        event.preventDefault();
        event.stopPropagation();
        updateView({ ...view, x: view.x + delta.x, y: view.y + delta.y });
      }}
    >
      <img
        ref={imageRef}
        src={src}
        alt={alt}
        loading="eager"
        draggable={false}
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        onLoad={() => updateView(currentView.current)}
      />
      <button
        type="button"
        className="channel-dialog-image-viewer__zoom"
        onClick={toggleZoom}
        aria-label={view.scale > 1 ? 'Вернуть исходный масштаб' : 'Увеличить фото'}
        aria-pressed={view.scale > 1}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <circle cx="10" cy="10" r="6.5" />
          <path d="m15 15 5.5 5.5M6.5 10h7" />
          {view.scale === 1 ? <path d="M10 6.5v7" /> : null}
        </svg>
      </button>
    </div>
  );
}
