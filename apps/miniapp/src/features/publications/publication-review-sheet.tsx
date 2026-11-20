import { PublicationRemoteVideo, type PublicationVideoRead } from './publication-remote-video';
import { publicationAlbum } from './publication-album';
import { PublicationVideoPlayer } from './publication-video-preview';
import { useState } from 'react';
import type { ApiTransport } from '../../lib/api/transport';
import { MaxMarkdownPreview } from '../../components/max-markdown-preview';
import { ActionConfirmSheet } from '../../components/ui/action-confirm-sheet';
import {
  getPublicationTargetKey,
  getPublicationTargetTitle,
  type PublicationDraft,
} from './publication-model';
import { buildPublicationReviewButtonRows } from './publication-review-buttons';
import { PublicationReviewTiming } from './publication-review-timing';
import type { PublicationSaveRequestContext } from './publication-save-request';
import type { PublisherPostImportAssetPreview } from './use-publisher-post-import-asset-previews';
import './publication-review-sheet.css';

export function PublicationReviewSheet({
  open,
  draft,
  previews,
  videoRead,
  facts,
  timingContext,
  api,
  confirmLabel,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  draft: PublicationDraft;
  videoRead?: PublicationVideoRead;
  previews: readonly PublisherPostImportAssetPreview[];
  facts: string[];
  timingContext?: PublicationSaveRequestContext;
  api: ApiTransport;
  confirmLabel: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [targetKey, setTargetKey] = useState('');
  const target =
    draft.targets.find((item) => getPublicationTargetKey(item) === targetKey) ?? draft.targets[0];
  const signature = target?.entityType === 'channel' ? target.publisherChannelPostSignature : null;
  const buttonRows = buildPublicationReviewButtonRows(target, draft);
  const media = publicationAlbum(draft).map((item) => ({
    id: item.key,
    assetId: item.assetId,
    type: item.type,
    name: item.name,
    url: item.preview ?? previews.find((preview) => preview.assetId === item.assetId)?.url,
  }));
  return (
    <ActionConfirmSheet
      id="publication-review"
      className="publication-review-sheet"
      open={open}
      title="Проверка публикации"
      confirmLabel={confirmLabel}
      confirmBusyLabel="Сохраняем..."
      cancelLabel="Назад"
      tone="accent"
      isBusy={busy}
      onClose={onClose}
      onConfirm={onConfirm}
      previewTitle={
        <div className="publication-preview">
          {draft.targets.length > 1 ? (
            <label className="publication-preview__recipient">
              <span>Получатель</span>
              <select
                aria-label="Получатель в проверке публикации"
                value={target ? getPublicationTargetKey(target) : ''}
                onChange={(event) => setTargetKey(event.target.value)}
              >
                {draft.targets.map((item) => (
                  <option key={getPublicationTargetKey(item)} value={getPublicationTargetKey(item)}>
                    {getPublicationTargetTitle(item)}
                  </option>
                ))}
              </select>
            </label>
          ) : target ? (
            <strong className="publication-preview__recipient">
              {getPublicationTargetTitle(target)}
            </strong>
          ) : null}
          {media.length ? (
            <div className={`publication-preview__media${media.length > 1 ? ' is-album' : ''}`}>
              {media.map((item, index) => (
                <div key={item.id}>
                  {item.url ? (
                    item.type === 'video' ? (
                      <PublicationVideoPlayer
                        key={item.url}
                        url={item.url}
                        label={item.name || 'Видео публикации'}
                      />
                    ) : (
                      <img src={item.url} alt={item.name || `Фото ${index + 1}`} />
                    )
                  ) : item.type === 'video' && item.assetId && videoRead ? (
                    <PublicationRemoteVideo
                      source={{
                        ...videoRead,
                        publicationId:
                          draft.retainedAssets.find((asset) => asset.id === item.assetId)
                            ?.sourcePublicationId ?? videoRead.publicationId,
                      }}
                      assetId={item.assetId}
                      label={item.name || 'Видео'}
                    />
                  ) : (
                    <span className="publication-preview__unavailable">
                      {item.type === 'video' ? 'Видео' : `Фото ${index + 1}`} · Предпросмотр
                      недоступен
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : null}
          <MaxMarkdownPreview
            value={draft.text}
            sourceFormat={draft.textFormat}
            className="publication-preview__text"
          />
          {signature?.enabled && signature.presentation === 'signature' ? (
            <p className="publication-preview__signature">{signature.text}</p>
          ) : null}
          {buttonRows.length ? (
            <div className="publication-preview__buttons" aria-label="Кнопки публикации">
              {buttonRows.map((row, rowIndex) => (
                <div key={rowIndex} className="publication-preview__button-row">
                  {row.map((button, index) => (
                    <span key={index} title={button.url}>
                      {button.text}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      }
      previewMeta={
        <>
          <ul className="publication-preview__facts">
            {facts.map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
          {open && timingContext ? (
            <PublicationReviewTiming api={api} draft={draft} context={timingContext} />
          ) : null}
        </>
      }
    />
  );
}
