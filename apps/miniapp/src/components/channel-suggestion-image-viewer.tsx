import { useEffect, useRef, useState, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import type { PreparedSuggestionAttachment } from '../lib/channel-suggestion-media';
import { useDialogFocusTrap, isTopmostModalDialog } from '../lib/dialog-focus';
import { useNativeBackHandler } from '../lib/native-back';
import { CommentImageFrame } from './comment-image-frame';
import { AppIcon } from './ui/app-icon';
import '../styles/channel-suggestion-image-viewer.css';

export default function ChannelSuggestionImageViewer({
  photos,
  initialIndex,
  returnFocusRef,
  onClose,
}: {
  photos: Array<Pick<PreparedSuggestionAttachment, 'previewUrl' | 'fileName'>>;
  initialIndex: number;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(initialIndex);
  const panelRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const activeIndex = Math.min(Math.max(0, index), photos.length - 1);
  const photo = photos[activeIndex];
  const step = (direction: -1 | 1) =>
    setIndex((current) => (current + direction + photos.length) % photos.length);
  useDialogFocusTrap(true, panelRef, closeRef, returnFocusRef);
  useNativeBackHandler(
    () => {
      onClose();
      return true;
    },
    { priority: 730 },
  );
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!panelRef.current || !isTopmostModalDialog(panelRef.current)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      } else if (photos.length > 1 && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.preventDefault();
        step(event.key === 'ArrowLeft' ? -1 : 1);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  });
  if (!photo?.previewUrl) return null;
  return createPortal(
    <div className="channel-suggestion-image-viewer">
      <div className="channel-suggestion-image-viewer__backdrop" aria-hidden />
      <section
        ref={panelRef}
        className="channel-suggestion-image-viewer__panel"
        role="dialog"
        aria-modal="true"
        aria-label="Просмотр фото"
        tabIndex={-1}
      >
        <div className="channel-suggestion-image-viewer__topbar">
          <span className="channel-suggestion-image-viewer__counter" aria-live="polite">
            {activeIndex + 1} / {photos.length}
          </span>
          <button
            ref={closeRef}
            type="button"
            className="channel-suggestion-image-viewer__close"
            aria-label="Закрыть просмотр"
            onClick={onClose}
          >
            <AppIcon icon="Xmark" aria-hidden />
          </button>
        </div>
        <div className="channel-suggestion-image-viewer__stage">
          <CommentImageFrame
            key={`${activeIndex}:${photo.previewUrl}`}
            src={photo.previewUrl}
            alt={photo.fileName || `Фото ${activeIndex + 1}`}
            onPrevious={photos.length > 1 ? () => step(-1) : undefined}
            onNext={photos.length > 1 ? () => step(1) : undefined}
          />
          {photos.length > 1 ? (
            <>
              <button
                type="button"
                className="channel-suggestion-image-viewer__nav"
                aria-label="Предыдущее фото"
                onClick={() => step(-1)}
              >
                <AppIcon icon="NavArrowLeft" aria-hidden />
              </button>
              <button
                type="button"
                className="channel-suggestion-image-viewer__nav is-next"
                aria-label="Следующее фото"
                onClick={() => step(1)}
              >
                <AppIcon icon="NavArrowLeft" aria-hidden />
              </button>
            </>
          ) : null}
        </div>
      </section>
    </div>,
    document.body,
  );
}
