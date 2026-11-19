import { useEffect, useRef, useState } from 'react';
import type { ApiTransport } from '../../lib/api/transport';
import { getPublicationAsset } from '../../lib/api/publication-drafts-client';
import { PublicationVideoPreview } from './publication-video-preview';

export type PublicationVideoRead = { api: ApiTransport; publicationId: string | null };

export function PublicationRemoteVideo({
  source,
  assetId,
  label,
}: {
  source: PublicationVideoRead;
  assetId: string;
  label: string;
}) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const current = useRef<AbortController | null>(null);
  useEffect(() => () => current.current?.abort(), [source.api, source.publicationId, assetId]);
  useEffect(
    () => () => {
      if (url) URL.revokeObjectURL(url);
    },
    [url],
  );
  async function open() {
    if (current.current || !source.publicationId) return;
    const request = new AbortController();
    current.current = request;
    setPending(true);
    setFailed(false);
    try {
      const blob = await getPublicationAsset(
        source.api,
        source.publicationId,
        assetId,
        request.signal,
      );
      if (!request.signal.aborted) setUrl(URL.createObjectURL(blob));
    } catch {
      if (!request.signal.aborted) setFailed(true);
    } finally {
      current.current = null;
      if (!request.signal.aborted) setPending(false);
    }
  }
  return (
    <div className="publication-album__remote">
      <button
        type="button"
        disabled={pending || !source.publicationId}
        aria-label={'Посмотреть видео: ' + label}
        onClick={() => void open()}
      >
        {pending ? 'Загрузка…' : 'Смотреть'}
      </button>
      {failed ? (
        <small role="status">Предпросмотр недоступен. Видео остаётся в посте.</small>
      ) : null}
      {url ? (
        <PublicationVideoPreview url={url} label={label} onClose={() => setUrl(null)} />
      ) : null}
    </div>
  );
}
