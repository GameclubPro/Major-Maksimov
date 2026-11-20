import { createHash } from 'node:crypto';
import {
  parseVkWallPostAttachments,
  type VkParsingUnsupportedAttachmentSummary,
} from './vk-parsing-attachments';

export type VkParsingSkipReason = 'AD' | 'EMPTY_AFTER_LINK_FILTER' | 'NO_SUPPORTED_CONTENT';
export type VkParsingTextFormat = 'plain' | 'markdown';

export type PreparedVkPublishPayload = {
  text: string;
  textFormat: VkParsingTextFormat;
  photoUrls: string[];
  videoUrls: string[];
  linkUrls: string[];
};

export type PrepareVkParsingPublishPayloadOptions = {
  preserveLinkUrls?: string[];
};

export type VkParsingContentSettings = {
  stripLinksEnabled: boolean;
  skipAdsEnabled: boolean;
};

export type VkParsingPostSkipCandidate = {
  text: string;
  photoUrls: string[];
  videoUrls?: string[];
  linkUrls: string[];
  attachments: Array<Record<string, unknown>>;
  raw: Record<string, unknown>;
  isAdvertising?: unknown;
  advertisingMarkers?: string[];
};

export type ResolveVkParsingPostSkipReasonOptions = {
  preserveLinkUrls?: string[];
};

export type VkParsingPostContentHashInput = {
  text: string;
  photoUrls: string[];
  videoUrls?: string[];
  linkUrls: string[];
  attachmentTypes?: string[];
  unsupportedAttachments?: VkParsingUnsupportedAttachmentSummary[];
  copyHistoryText?: string[];
  advertisingMarkers?: string[];
};

export const VK_POST_SKIP_REASON_AD: VkParsingSkipReason = 'AD';
export const VK_POST_SKIP_REASON_EMPTY_AFTER_LINK_FILTER: VkParsingSkipReason =
  'EMPTY_AFTER_LINK_FILTER';
export const VK_POST_SKIP_REASON_NO_SUPPORTED_CONTENT: VkParsingSkipReason = 'NO_SUPPORTED_CONTENT';

const VK_INLINE_LINK_PATTERN =
  /(?:https?:\/\/|www\.|(?:vk\.cc|vk\.com|vk\.ru|t\.me|telegram\.me|wa\.me|max\.ru)\/)(?:\\[\\`*_[\]()~+]|[^\s<>()\]["'`{}])+/giu;
const VK_MARKDOWN_LINK_SCHEME = /(?:https?|max):\/\//iuy;
const VK_IMPORTED_STRONG_MARKUP_PATTERN =
  /(?<![\\*])\*\*(?!\*)[^\r\n\u2028\u2029*]*[^\s*][^\r\n\u2028\u2029*]*(?<!\\)\*\*(?!\*)/u;

export function hasVkParsingImportedStrongMarkup(text: string): boolean {
  return VK_IMPORTED_STRONG_MARKUP_PATTERN.test(text);
}

export function resolveEffectiveVkParsingTextFormat(params: {
  text: string;
  textFormat: unknown;
  manualContentEditedAt?: Date | string | null;
}): VkParsingTextFormat {
  if (params.textFormat === 'markdown') {
    return 'markdown';
  }
  if (params.manualContentEditedAt !== null && params.manualContentEditedAt !== undefined) {
    return 'plain';
  }
  return hasVkParsingImportedStrongMarkup(params.text) ? 'markdown' : 'plain';
}

export function composeVkParsingPublishText(text: string, linkUrls: string[]): string {
  const base = text.trim();
  const missingLinks = linkUrls.filter((url) => !base.includes(url));
  return [base, ...missingLinks].filter(Boolean).join('\n');
}

export function prepareVkParsingPublishPayload(
  payload: PreparedVkPublishPayload,
  settings: Pick<VkParsingContentSettings, 'stripLinksEnabled'>,
  options: PrepareVkParsingPublishPayloadOptions = {},
): PreparedVkPublishPayload {
  const preservedLinks = new Set(options.preserveLinkUrls ?? []);
  const text = settings.stripLinksEnabled
    ? stripVkParsingLinksFromText(payload.text)
    : payload.text;
  const linkUrls = settings.stripLinksEnabled
    ? payload.linkUrls.filter((url) => preservedLinks.has(url))
    : payload.linkUrls;
  return {
    text:
      payload.textFormat === 'markdown' ? text.trim() : composeVkParsingPublishText(text, linkUrls),
    textFormat: payload.textFormat,
    photoUrls: payload.photoUrls,
    videoUrls: payload.videoUrls,
    linkUrls,
  };
}

export function stripVkParsingLinksFromText(text: string): string {
  VK_INLINE_LINK_PATTERN.lastIndex = 0;
  return replaceVkMarkdownLinksWithLabels(text)
    .replace(VK_INLINE_LINK_PATTERN, '')
    .replace(/[ \t]+/gu, (spaces: string, offset: number, value: string) => {
      if (value[offset - 1] === '\n' || value[offset + spaces.length] === '\n') {
        return '';
      }
      return spaces.length === 1 ? spaces : ' ';
    })
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function replaceVkMarkdownLinksWithLabels(text: string): string {
  const parts: string[] = [];
  let copiedThrough = 0;
  let labelStart = -1;
  let targetEnd = 0;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character === '[' && labelStart === -1) {
      labelStart = index;
      continue;
    }
    if (character === '\n') {
      labelStart = -1;
      continue;
    }
    if (character !== ']' || labelStart === -1) {
      continue;
    }

    const start = labelStart;
    labelStart = -1;
    if (index === start + 1 || text[index + 1] !== '(') {
      continue;
    }
    VK_MARKDOWN_LINK_SCHEME.lastIndex = index + 2;
    if (!VK_MARKDOWN_LINK_SCHEME.test(text)) {
      continue;
    }

    const targetStart = VK_MARKDOWN_LINK_SCHEME.lastIndex;
    // FLAG: Reuse the end of the run so overlapping failed targets take one pass.
    if (targetStart > targetEnd) {
      targetEnd = targetStart;
      while (targetEnd < text.length && !/[\s)]/u.test(text[targetEnd]!)) {
        targetEnd += 1;
      }
    }
    if (targetEnd === targetStart || text[targetEnd] !== ')') {
      continue;
    }

    parts.push(text.slice(copiedThrough, start), text.slice(start + 1, index));
    copiedThrough = targetEnd + 1;
    index = targetEnd;
  }

  return copiedThrough === 0 ? text : parts.join('') + text.slice(copiedThrough);
}

export function resolveVkParsingPostSkipReason(
  post: VkParsingPostSkipCandidate,
  settings: VkParsingContentSettings,
  options: ResolveVkParsingPostSkipReasonOptions = {},
): VkParsingSkipReason | null {
  if (settings.skipAdsEnabled && isVkParsingAdvertisingPost(post)) {
    return VK_POST_SKIP_REASON_AD;
  }

  const preservedLinks = new Set(options.preserveLinkUrls ?? []);
  const hasPreservedLink = post.linkUrls.some((url) => preservedLinks.has(url));
  if (
    settings.stripLinksEnabled &&
    post.photoUrls.length === 0 &&
    (post.videoUrls?.length ?? 0) === 0 &&
    stripVkParsingLinksFromText(post.text).length === 0 &&
    (post.linkUrls.length > 0 || hasVkParsingInlineLinks(post.text)) &&
    !hasPreservedLink
  ) {
    return VK_POST_SKIP_REASON_EMPTY_AFTER_LINK_FILTER;
  }

  return null;
}

export function hasVkParsingInlineLinks(text: string): boolean {
  VK_INLINE_LINK_PATTERN.lastIndex = 0;
  return VK_INLINE_LINK_PATTERN.test(text);
}

export function isVkParsingAdvertisingPost(post: VkParsingPostSkipCandidate): boolean {
  if (readBooleanFlag(post.isAdvertising)) {
    return true;
  }

  const markers = post.advertisingMarkers?.length
    ? post.advertisingMarkers
    : parseVkWallPostAttachments({
        attachments: post.attachments,
        rawPost: post.raw,
        text: post.text,
        maxPhotos: 0,
        maxLinks: 0,
      }).advertisingMarkers;
  return markers.length > 0 || readBooleanFlag(post.raw.marked_as_ads);
}

export function describeVkParsingSkipReason(reason: VkParsingSkipReason): string {
  if (reason === VK_POST_SKIP_REASON_AD) {
    return 'Пост пропущен фильтром рекламы.';
  }
  if (reason === VK_POST_SKIP_REASON_NO_SUPPORTED_CONTENT) {
    return 'Пост пропущен: в VK-записи нет поддерживаемого текста, фото, видео или ссылок.';
  }

  return 'Пост пропущен: после удаления ссылок не осталось содержимого.';
}

export function computeVkParsingPostContentHash(params: VkParsingPostContentHashInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        text: params.text.trim(),
        photoUrls: params.photoUrls,
        videoUrls: params.videoUrls ?? [],
        linkUrls: params.linkUrls,
        attachmentTypes: params.attachmentTypes ?? [],
        unsupportedAttachments: params.unsupportedAttachments ?? [],
        copyHistoryText: params.copyHistoryText ?? [],
        advertisingMarkers: params.advertisingMarkers ?? [],
      }),
    )
    .digest('hex');
}

function readBooleanFlag(value: unknown): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value === 1;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
  }
  return false;
}
