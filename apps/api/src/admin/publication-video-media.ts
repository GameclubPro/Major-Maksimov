export const PUBLICATION_MAX_VIDEO_BYTES = 24_000_000;

export const PUBLICATION_VIDEO_ASSET_ID_FIELD = '__publicationVideoAssetId';
export const PUBLICATION_VIDEO_SOURCE_PUBLICATION_ID_FIELD =
  '__publicationVideoSourcePublicationId';
export const PUBLICATION_VIDEO_INLINE_BASE64_FIELD = '__publicationVideoInlineBase64';
export const PUBLICATION_UPLOADED_VIDEO_FIELD = '__publicationUploadedVideo';

export function readPublicationUploadedVideo(
  value: unknown,
  botId: string,
): { token: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const marker = (value as Record<string, unknown>)[PUBLICATION_UPLOADED_VIDEO_FIELD];
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null;
  const data = marker as Record<string, unknown>;
  if (
    data.version !== 1 ||
    data.botId !== botId ||
    typeof data.token !== 'string' ||
    !data.token.trim() ||
    data.token.length > 512
  )
    return null;
  return { token: data.token };
}

export function hasPublicationVideoInternalMarker(value: Record<string, unknown>): boolean {
  return (
    PUBLICATION_VIDEO_ASSET_ID_FIELD in value ||
    PUBLICATION_VIDEO_SOURCE_PUBLICATION_ID_FIELD in value ||
    PUBLICATION_VIDEO_INLINE_BASE64_FIELD in value ||
    PUBLICATION_UPLOADED_VIDEO_FIELD in value
  );
}
