import { PublicationRemoteVideo, type PublicationVideoRead } from './publication-remote-video';
import { useState, type Dispatch, type SetStateAction } from 'react';
import type { PublicationDraft } from './publication-model';
import type { PublisherPostImportAssetPreview } from './use-publisher-post-import-asset-previews';
import {
  publicationAlbum,
  moveAlbumItem,
  removeAlbumItem,
  replaceAlbumItem,
} from './publication-album';
import { PublicationVideoPreview } from './publication-video-preview';
import { describeUserFacingError } from '../../lib/user-facing-error';
import './publication-album-editor.css';

export function PublicationAlbumEditor({
  draft,
  setDraft,
  previews,
  videoRead,
  busy,
  onVideoFile,
  onPreparing,
  onError,
}: {
  draft: PublicationDraft;
  setDraft: Dispatch<SetStateAction<PublicationDraft>>;
  previews: readonly PublisherPostImportAssetPreview[];
  videoRead: PublicationVideoRead;
  busy: boolean;
  onVideoFile: (file: File, replaceKey?: string) => Promise<void>;
  onPreparing: (busy: boolean) => void;
  onError: (message: string) => void;
}) {
  const [playing, setPlaying] = useState<string | null>(null);
  const items = publicationAlbum(draft);
  const resolveUrl = (item: (typeof items)[number]) =>
    item.preview ?? previews.find((preview) => preview.assetId === item.assetId)?.url;
  const active = items.find((item) => item.key === playing);
  const activeUrl = active && resolveUrl(active);
  async function replace(file: File | undefined, item: (typeof items)[number]) {
    if (!file || busy) return;
    onError('');
    try {
      if (item.type === 'video') {
        await onVideoFile(file, item.key);
      } else {
        onPreparing(true);
        const { prepareComposerImageFiles } = await import('../../lib/broadcast-image-preparation');
        const remaining = draft.images.filter((_, index) => index !== item.localIndex);
        const result = await prepareComposerImageFiles({
          files: [file],
          currentImages: remaining,
          signal: new AbortController().signal,
        });
        if (!result.addedCount)
          throw new Error(
            result.failedMessages[0] ||
              (result.duplicateCount
                ? 'Такое фото уже есть в альбоме.'
                : 'Не удалось добавить фото этого размера.'),
          );
        const photo = result.images.at(-1)!;
        setDraft((current) => replaceAlbumItem(current, item.key, { photo }));
      }
    } catch (error) {
      onError(
        error instanceof Error && error.name === 'AbortError'
          ? 'Загрузка видео отменена.'
          : describeUserFacingError(error, 'Не удалось заменить вложение.'),
      );
    } finally {
      if (item.type === 'image') onPreparing(false);
    }
  }
  if (!items.length) return null;
  return (
    <>
      <ol className="publication-album" aria-label="Порядок вложений">
        {items.map((item, index) => {
          const url = resolveUrl(item);
          const label = item.type === 'video' ? 'Видео' : 'Фото';
          return (
            <li
              key={item.key}
              className={
                item.type === 'video'
                  ? 'publication-album__item publication-retained-media'
                  : 'publication-album__item'
              }
            >
              <div className="publication-album__summary">
                {item.type === 'image' && url ? (
                  <img src={url} alt="" />
                ) : item.type === 'video' && url ? (
                  <button
                    type="button"
                    className="publication-album__play"
                    aria-label={'Посмотреть видео: ' + (item.name || label)}
                    onClick={() => setPlaying(item.key)}
                  >
                    <video src={url} playsInline preload="metadata" muted />
                    <b aria-hidden>▶</b>
                  </button>
                ) : item.type === 'video' && item.assetId ? (
                  <PublicationRemoteVideo
                    source={{
                      ...videoRead,
                      publicationId:
                        draft.retainedAssets.find((asset) => asset.id === item.assetId)
                          ?.sourcePublicationId ?? videoRead.publicationId,
                    }}
                    assetId={item.assetId}
                    label={item.name || label}
                  />
                ) : (
                  <span className="publication-album__placeholder" aria-hidden>
                    {item.type === 'image' ? '▧' : '▷'}
                  </span>
                )}
                <span className="publication-album__caption">
                  <strong>
                    {index + 1} · {label}
                  </strong>
                  <small>{item.name}</small>
                </span>
              </div>
              <div className="publication-album__actions">
                {items.length > 1 ? (
                  <>
                    <button
                      type="button"
                      aria-label={'Переместить раньше: ' + label + ' ' + (index + 1)}
                      disabled={busy || index === 0}
                      onClick={() => setDraft((current) => moveAlbumItem(current, item.key, -1))}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      aria-label={'Переместить позже: ' + label + ' ' + (index + 1)}
                      disabled={busy || index === items.length - 1}
                      onClick={() => setDraft((current) => moveAlbumItem(current, item.key, 1))}
                    >
                      ↓
                    </button>
                  </>
                ) : null}
                <label className="publication-album__replace">
                  Заменить
                  <input
                    aria-label={'Заменить ' + label.toLowerCase() + ' ' + (index + 1)}
                    type="file"
                    accept={item.type === 'video' ? 'video/*,.mp4,.mov,.mkv,.webm' : 'image/*'}
                    disabled={busy}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = '';
                      void replace(file, item);
                    }}
                  />
                </label>
                <button
                  type="button"
                  aria-label={
                    items.length === 1 && item.type === 'video'
                      ? 'Убрать видео'
                      : 'Убрать ' + label.toLowerCase() + ' ' + (index + 1)
                  }
                  disabled={busy}
                  onClick={() => setDraft((current) => removeAlbumItem(current, item.key))}
                >
                  Убрать
                </button>
              </div>
            </li>
          );
        })}
      </ol>
      {active && activeUrl ? (
        <PublicationVideoPreview
          url={activeUrl}
          label={active.name || 'Видео'}
          onClose={() => setPlaying(null)}
        />
      ) : null}
    </>
  );
}
