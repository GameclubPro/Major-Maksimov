import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { SuggestionReviewDetail } from '@maxim/contracts/publisher';
import type { ApiTransport } from '../lib/api/transport';
import { AppIcon } from '../components/ui/app-icon';

const ImageViewer = lazy(() => import('../components/channel-suggestion-image-viewer'));

export function SuggestionReviewMedia({
  api,
  suggestionId,
  asset,
}: {
  api: ApiTransport;
  suggestionId: string;
  asset: SuggestionReviewDetail['media'][number];
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!asset.available) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    setUrl(null);
    setFailed(false);
    void api
      .request(
        `/suggestion-reviews/${encodeURIComponent(suggestionId)}/assets/${encodeURIComponent(asset.id)}`,
        { responseType: 'blob' },
      )
      .then((blob) => {
        if (cancelled) return;
        if (!(blob instanceof Blob)) throw new Error('Invalid media response');
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [api, asset.available, asset.id, suggestionId, attempt]);
  return (
    <figure className="suggestion-review__asset" aria-busy={asset.available && !url && !failed}>
      {url && !failed ? (
        asset.type === 'image' ? (
          <button
            ref={buttonRef}
            type="button"
            className="suggestion-review__photo"
            aria-label={`Открыть фото: ${asset.name}`}
            onClick={() => setExpanded(true)}
          >
            <img src={url} alt={asset.name} decoding="async" onError={() => setFailed(true)} />
            <span className="suggestion-review__zoom">
              <AppIcon icon="OpenNewWindow" />
            </span>
          </button>
        ) : (
          <video
            src={url}
            controls
            playsInline
            preload="metadata"
            aria-label={asset.name}
            onError={() => setFailed(true)}
          />
        )
      ) : (
        <div className="suggestion-review__media-placeholder">
          <AppIcon icon={asset.type === 'video' ? 'VideoCamera' : 'Camera'} />
          <span>
            {!asset.available || failed
              ? 'Предпросмотр недоступен'
              : asset.type === 'video'
                ? 'Загрузка видео…'
                : 'Загрузка фото…'}
          </span>
          {failed && asset.available ? (
            <button type="button" onClick={() => setAttempt((n) => n + 1)}>
              Повторить
            </button>
          ) : null}
        </div>
      )}
      {expanded && url ? (
        <Suspense fallback={null}>
          <ImageViewer
            photos={[{ previewUrl: url, fileName: asset.name }]}
            initialIndex={0}
            returnFocusRef={buttonRef}
            onClose={() => setExpanded(false)}
          />
        </Suspense>
      ) : null}
    </figure>
  );
}
