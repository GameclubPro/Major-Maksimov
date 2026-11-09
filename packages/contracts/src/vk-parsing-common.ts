export const VK_PARSING_MAX_PHOTOS = 10,
  VK_PARSING_MAX_VIDEOS = 1,
  VK_PARSING_MAX_LINKS = 20;
export const VK_PARSING_MAX_PUBLISH_TEXT_LENGTH = 4_000;
export const VK_PARSING_MAX_CHANNEL_LINK_TEXT_LENGTH = 120;
export const VK_PARSING_MAX_CHANNEL_LINK_URL_LENGTH = 256;
export const VK_PARSING_DEFAULT_CHANNEL_LINK_TEXT = 'Подписаться на канал';

export const VK_PARSING_MAX_DELETE_AFTER_MINUTES = 43_200;
export const VK_PARSING_MAX_SOURCE_LINK_URL_LENGTH = 2048;

export function normalizeVkParsingSourceLink(value: string): string | null {
  if (
    [...value].some((character) => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127)
  )
    return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
    const normalized = url.href.replace(
      /[()[\]<>]/gu,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    return normalized.length <= VK_PARSING_MAX_SOURCE_LINK_URL_LENGTH ? normalized : null;
  } catch {
    return null;
  }
}

export function buildVkParsingSourceLink(
  postUrl: string,
  settings: { sourceLinkEnabled?: boolean; sourceLinkUrl?: string },
): { url: string; html: string; markdown: string } | null {
  if (!settings.sourceLinkEnabled) return null;
  const url = normalizeVkParsingSourceLink(settings.sourceLinkUrl?.trim() || postUrl);
  if (!url) return null;
  const escaped = url.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;');
  return { url, html: `<a href="${escaped}">Источник</a>`, markdown: `[Источник](${url})` };
}
