import { useEffect, useState } from 'react';
import type { ApiTransport } from '../../lib/api/transport';
import type { PublicationEditorContext, PublicationRetainedAsset } from './publication-model';
import { usePublicationAssetPreviews } from './use-publication-asset-previews';
import type { PublisherPostImportAssetPreview } from './use-publisher-post-import-asset-previews';

type LocalVideo = {
  assetId: string;
  file: File;
  api: ApiTransport;
  userId: string;
  sessionKey: string | null;
};

export function getPublicationVideoPreviewSessionKey(
  session: PublicationEditorContext | null,
): string | null {
  if (!session) return null;
  return JSON.stringify([
    session.kind,
    'publicationId' in session ? session.publicationId : null,
    session.kind === 'import' ? session.sessionId : null,
  ]);
}

export function useLocalPublicationVideoPreview({
  api,
  userId,
  session,
  publicationId,
  assets,
}: {
  api: ApiTransport;
  userId: string;
  session: PublicationEditorContext | null;
  publicationId: string | null;
  assets: readonly PublicationRetainedAsset[];
}) {
  const sessionKey = getPublicationVideoPreviewSessionKey(session);
  const savedPreviews = usePublicationAssetPreviews(api, publicationId, assets);
  const [localVideo, setLocalVideo] = useState<LocalVideo | null>(null);
  const [preview, setPreview] = useState<PublisherPostImportAssetPreview | null>(null);
  const active =
    localVideo &&
    session &&
    localVideo.sessionKey === sessionKey &&
    localVideo.api === api &&
    localVideo.userId === userId &&
    assets.some((asset) => asset.id === localVideo.assetId && asset.type === 'video')
      ? localVideo
      : null;

  useEffect(() => {
    if (!active) setLocalVideo(null);
  }, [active, localVideo]);

  useEffect(() => {
    setPreview(null);
    if (!active) return;
    const url = URL.createObjectURL(active.file);
    setPreview({ assetId: active.assetId, url });
    return () => URL.revokeObjectURL(url);
  }, [active]);

  const currentPreview = active && preview?.assetId === active.assetId ? preview : null;
  return {
    previews: currentPreview
      ? [...savedPreviews.filter((item) => item.assetId !== currentPreview.assetId), currentPreview]
      : savedPreviews,
    rememberVideo: (assetId: string, file: File) =>
      setLocalVideo({ assetId, file, api, userId, sessionKey }),
  };
}
