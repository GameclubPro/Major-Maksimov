import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isTopmostModalDialog, useDialogFocusTrap } from '../../lib/dialog-focus';
import { useNativeBackHandler } from '../../lib/native-back';
import { useVisualViewportOverlayStyle } from '../../lib/use-visual-viewport-overlay-style';
import './publication-video-preview.css';

export function PublicationVideoPlayer({ url, label }: { url: string; label: string }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const video = videoRef.current;
    return () => {
      if (!video) return;
      video.pause();
    };
  }, [url]);
  return failed ? (
    <p role="status">Не удалось воспроизвести видео. Файл остаётся в публикации.</p>
  ) : (
    <video
      ref={videoRef}
      src={url}
      controls
      playsInline
      preload="metadata"
      tabIndex={0}
      aria-label={label}
      onError={() => setFailed(true)}
    />
  );
}

export function PublicationVideoPreview({
  url,
  label,
  onClose,
}: {
  url: string;
  label: string;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const overlayStyle = useVisualViewportOverlayStyle(true);
  useDialogFocusTrap(true, panelRef, closeRef);
  useNativeBackHandler(
    () => {
      onClose();
      return true;
    },
    { enabled: true, priority: 740 },
  );
  useEffect(() => {
    const bodyOverflow = document.body.style.overflow;
    const documentOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = documentOverflow;
    };
  }, []);
  const portal =
    window.__MAXIM_FORCE_NATIVE_VISUAL_MODE__ === true
      ? document.body
      : (document.querySelector('.design-preview__device-screen') ?? document.body);
  return createPortal(
    <div
      className="publication-video-overlay"
      style={overlayStyle}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && panelRef.current && isTopmostModalDialog(panelRef.current)) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <button
        className="publication-video-overlay__backdrop"
        tabIndex={-1}
        type="button"
        aria-label="Закрыть видео"
        onClick={onClose}
      />
      <section
        ref={panelRef}
        className="publication-video-preview"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header>
          <h3 id={titleId}>Видео: {label}</h3>
          <button ref={closeRef} type="button" aria-label="Закрыть видео" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="publication-video-preview__body">
          <PublicationVideoPlayer key={url} url={url} label={label} />
        </div>
      </section>
    </div>,
    portal,
  );
}
