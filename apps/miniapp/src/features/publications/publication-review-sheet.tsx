import { PublicationVideoPlayer } from './publication-video-preview';
import { useState } from 'react';
import { MaxMarkdownPreview } from '../../components/max-markdown-preview';
import { ActionConfirmSheet } from '../../components/ui/action-confirm-sheet';
import { trimBroadcastLinkButtons } from '../../lib/broadcast-link-buttons';
import {
  buildPublicationSystemButtons,
  getPublicationTargetKey,
  getPublicationTargetTitle,
  type PublicationDraft,
} from './publication-model';
import type { PublisherPostImportAssetPreview } from './use-publisher-post-import-asset-previews';
import './publication-review-sheet.css';

export function PublicationReviewSheet({
  open,
  draft,
  previews,
  facts,
  confirmLabel,
  busy,
  onClose,
  onConfirm,
}: {
  open: boolean;
  draft: PublicationDraft;
  previews: readonly PublisherPostImportAssetPreview[];
  facts: string[];
  confirmLabel: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [targetKey, setTargetKey] = useState('');
  const target =
    draft.targets.find((item) => getPublicationTargetKey(item) === targetKey) ?? draft.targets[0];
  const signature = target?.entityType === 'channel' ? target.publisherChannelPostSignature : null;
  const systemButtons = buildPublicationSystemButtons(target ? [target] : []);
  const customButtons = draft.buttonEnabled ? trimBroadcastLinkButtons(draft.buttons) : [];
  const media = [
    ...draft.retainedAssets.map((asset) => ({
      id: asset.id,
      type: asset.type,
      name: asset.fileName,
      url: previews.find((preview) => preview.assetId === asset.id)?.url,
    })),
    ...draft.images.map((image, index) => ({
      id: `local-${index}`,
      type: 'image' as const,
      name: image.fileName,
      url: `data:${image.mimeType};base64,${image.base64}`,
    })),
    ...(draft.mediaType === 'video' && draft.mediaBase64
      ? [
          {
            id: 'local-video',
            type: 'video' as const,
            name: draft.mediaFileName,
            url: `data:${draft.mediaMimeType};base64,${draft.mediaBase64}`,
          },
        ]
      : []),
  ];
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
          {systemButtons.length || customButtons.length ? (
            <div className="publication-preview__buttons" aria-label="Кнопки публикации">
              {customButtons.map((button, index) => (
                <span key={`custom-${index}`} title={button.url}>
                  {button.text}
                </span>
              ))}
              {systemButtons.map((button) => (
                <span key={button.kind}>{button.text}</span>
              ))}
            </div>
          ) : null}
        </div>
      }
      previewMeta={
        <ul className="publication-preview__facts">
          {facts.map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
      }
    />
  );
}
