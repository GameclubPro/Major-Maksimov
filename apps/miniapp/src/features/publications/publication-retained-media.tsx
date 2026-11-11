import { useState } from 'react';
import { PublicationVideoPreview } from './publication-video-preview';
import { AppIcon as IconoirSprite } from '../../components/ui/app-icon';
import type { PublicationAsset } from '@maxim/contracts/publication';

import { cn } from '../../lib/cn';
import type { PublisherPostImportAssetPreview } from './use-publisher-post-import-asset-previews';
import './publication-retained-media.css';

export function PublicationRetainedMedia({
  assets,
  previews,
  disabled,
  onRemove,
}: {
  assets: readonly PublicationAsset[];
  previews: readonly PublisherPostImportAssetPreview[];
  disabled: boolean;
  onRemove: (assetId: string) => void;
}) {
  const [previewAssetId, setPreviewAssetId] = useState<string | null>(null);
  if (assets.length === 0) {
    return null;
  }
  const previewByAssetId = new Map(previews.map((preview) => [preview.assetId, preview.url]));

  const previewAsset = assets.find(
    (asset) => asset.id === previewAssetId && asset.type === 'video',
  );
  const videoUrl = previewAsset ? previewByAssetId.get(previewAsset.id) : null;
  return (
    <>
      {assets.map((asset, index) => {
        const previewUrl = previewByAssetId.get(asset.id);
        const label =
          asset.fileName.trim() || (asset.type === 'video' ? 'Видео' : `Фото ${index + 1}`);
        return (
          <div
            key={asset.id}
            className={cn('publication-retained-media', previewUrl && 'has-previews')}
          >
            {asset.type === 'video' && previewUrl ? (
              <button
                type="button"
                className="publication-retained-media__open"
                aria-label={`Посмотреть видео: ${label}`}
                onClick={() => setPreviewAssetId(asset.id)}
              >
                <span className="publication-retained-media__previews" aria-hidden>
                  <video src={previewUrl} muted playsInline preload="metadata" />
                  <IconoirSprite variant="iconoir" icon="Play" aria-hidden />
                </span>
                <span>{label}</span>
              </button>
            ) : (
              <>
                {previewUrl ? (
                  <div className="publication-retained-media__previews" aria-hidden>
                    <img src={previewUrl} alt="" />
                  </div>
                ) : null}
                <span>{label}</span>
              </>
            )}
            <button
              type="button"
              onClick={() => onRemove(asset.id)}
              disabled={disabled}
              aria-label={
                asset.type === 'video' ? 'Убрать видео' : `Убрать сохранённое фото ${index + 1}`
              }
              title="Убрать"
            >
              <IconoirSprite variant="iconoir" icon="Xmark" aria-hidden />
            </button>
          </div>
        );
      })}
      {previewAsset && videoUrl ? (
        <PublicationVideoPreview
          key={videoUrl}
          url={videoUrl}
          label={previewAsset.fileName.trim() || 'Видео публикации'}
          onClose={() => setPreviewAssetId(null)}
        />
      ) : null}
    </>
  );
}
