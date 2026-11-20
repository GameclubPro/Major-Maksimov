import { useEffect, useRef, useState } from 'react';
import type { ApiTransport } from '../../lib/api/transport';
import type { PublicationEditorContext, PublicationRetainedAsset } from './publication-model';
import { usePublicationAssetPreviews } from './use-publication-asset-previews';
import type { PublisherPostImportAssetPreview } from './use-publisher-post-import-asset-previews';

type LocalVideo = {
  assetId: string;
  url: string;
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
  const [localVideos, setLocalVideos] = useState<LocalVideo[]>([]);
  const currentUrls = useRef(new Set<string>());
  const matches = (item: LocalVideo) =>
    Boolean(
      session &&
      item.api === api &&
      item.userId === userId &&
      item.sessionKey === sessionKey &&
      assets.some((asset) => asset.id === item.assetId && asset.type === 'video'),
    );
  const active = localVideos.filter(matches);
  useEffect(
    () => () => {
      for (const url of currentUrls.current) URL.revokeObjectURL(url);
      currentUrls.current.clear();
    },
    [],
  );
  useEffect(() => {
    const expired = localVideos.filter((item) => !matches(item));
    if (!expired.length) return;
    for (const item of expired) {
      URL.revokeObjectURL(item.url);
      currentUrls.current.delete(item.url);
    }
    setLocalVideos((items) => items.filter((item) => !expired.includes(item)));
  }, [api, assets, userId, sessionKey, session, localVideos]);
  return {
    previews: [
      ...savedPreviews,
      ...active.map(({ assetId, url }): PublisherPostImportAssetPreview => ({ assetId, url })),
    ],
    rememberVideo: (assetId: string, file: File) => {
      const url = URL.createObjectURL(file);
      currentUrls.current.add(url);
      setLocalVideos((items) => [...items, { assetId, url, api, userId, sessionKey }]);
    },
  };
}
