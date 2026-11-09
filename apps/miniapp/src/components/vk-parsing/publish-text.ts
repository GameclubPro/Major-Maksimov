import { channelPostSignatureUrlSchema } from '@maxim/contracts/channel-post-signature';
import {
  VK_PARSING_MAX_CHANNEL_LINK_URL_LENGTH,
  type VkParsingPost,
} from '@maxim/contracts/vk-parsing';
import {
  containsSupportedMarkdownUrl,
  renderSupportedMarkdownAsHtml,
} from '../../lib/max-markdown';
import { normalizeLegacyMultilineMarkdown } from '../../lib/max-markdown-multiline';

export function measureVkParsingPublishTextLength(params: {
  text: string;
  textFormat: VkParsingPost['textFormat'];
  linkUrls: string[];
  stripLinksEnabled: boolean;
  appendChannelLinkEnabled: boolean;
  channelLinkText: string;
  channelLinkUrl?: string;
  customChannelLinkUrl?: string;
  preserveLinkUrls?: string[];
  sourceLinkHtml?: string;
}): number {
  const usesRichText = params.textFormat === 'markdown';
  const preservedLinks = new Set(params.preserveLinkUrls ?? []);
  const linkUrls = params.stripLinksEnabled
    ? params.linkUrls.filter((url) => preservedLinks.has(url))
    : params.linkUrls;
  const strippedText = params.stripLinksEnabled
    ? stripVkParsingLinksFromText(params.text)
    : params.text;
  const text = usesRichText
    ? strippedText.trim()
    : composeVkParsingPublishText(strippedText, linkUrls);
  const normalizedText = usesRichText ? normalizeLegacyMultilineMarkdown(text) : text;
  const formattedText =
    usesRichText && normalizedText.trim()
      ? renderSupportedMarkdownAsHtml(normalizedText, { blockMode: 'raw' })
      : normalizedText;
  const missingLinkUrls = usesRichText
    ? linkUrls.filter((url) => !containsSupportedMarkdownUrl(normalizedText, url))
    : [];
  const renderedLinkHtml = missingLinkUrls.map(
    (url) => `<a href="${escapeHtmlAttribute(url)}">${escapeHtmlText(url)}</a>`,
  );
  let contentHtml = usesRichText
    ? [formattedText.trim(), ...renderedLinkHtml].filter(Boolean).join('\n')
    : formattedText;

  if (params.sourceLinkHtml) {
    contentHtml = [
      usesRichText ? contentHtml.trim() : escapeHtmlText(contentHtml.trim()),
      params.sourceLinkHtml,
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  if (!params.appendChannelLinkEnabled) {
    return Math.max(params.text.length, text.length, contentHtml.length);
  }

  const baseHtml =
    usesRichText || params.sourceLinkHtml ? contentHtml : escapeHtmlText(formattedText);
  const normalizedChannelLink = params.customChannelLinkUrl?.trim()
    ? normalizePostSignatureLink(params.customChannelLinkUrl)
    : normalizeMaxChannelLink(params.channelLinkUrl);
  const signatureHref = normalizedChannelLink
    ? escapeHtmlAttribute(normalizedChannelLink)
    : 'x'.repeat(VK_PARSING_MAX_CHANNEL_LINK_URL_LENGTH);
  const signatureHtml = `<a href="${signatureHref}">${escapeHtmlText(
    params.channelLinkText.trim(),
  )}</a>`;
  const maxText = [baseHtml.trim(), signatureHtml].filter(Boolean).join('\n\n');
  return Math.max(params.text.length, text.length, maxText.length);
}

function composeVkParsingPublishText(text: string, linkUrls: string[]): string {
  const base = text.trim();
  const missingLinks = linkUrls.filter((url) => !base.includes(url));
  return [base, ...missingLinks].filter(Boolean).join('\n');
}

const VK_INLINE_LINK_PATTERN =
  /(?:https?:\/\/|www\.|(?:vk\.cc|vk\.com|vk\.ru|t\.me|telegram\.me|wa\.me|max\.ru)\/)(?:\\[\\`*_[\]()~+]|[^\s<>()\]["'`{}])+/giu;
const VK_MARKDOWN_LINK_PATTERN = /\[([^\]\n]+)\]\((?:https?:\/\/|max:\/\/)[^\s)]+\)/giu;

export function stripVkParsingLinksFromText(text: string): string {
  VK_MARKDOWN_LINK_PATTERN.lastIndex = 0;
  VK_INLINE_LINK_PATTERN.lastIndex = 0;
  return text
    .replace(VK_MARKDOWN_LINK_PATTERN, '$1')
    .replace(VK_INLINE_LINK_PATTERN, '')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n[ \t]+/gu, '\n')
    .replace(/[ \t]{2,}/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replace(/"/gu, '&quot;');
}

function normalizePostSignatureLink(value: string | undefined): string | null {
  const parsed = channelPostSignatureUrlSchema.safeParse(value ?? '');
  if (!parsed.success || !parsed.data) {
    return null;
  }

  return parsed.data;
}

function normalizeMaxChannelLink(value: string | undefined): string | null {
  const normalized = value?.trim();
  if (!normalized || normalized.length > VK_PARSING_MAX_CHANNEL_LINK_URL_LENGTH) {
    return null;
  }

  try {
    const parsed = new URL(normalized);
    const hostname = parsed.hostname.toLowerCase();
    if (
      (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
      (hostname !== 'max.ru' && hostname !== 'www.max.ru') ||
      Boolean(parsed.username || parsed.password || parsed.port) ||
      parsed.pathname === '/'
    ) {
      return null;
    }
    parsed.protocol = 'https:';
    parsed.hostname = 'max.ru';
    parsed.hash = '';
    parsed.search = '';
    const canonical = parsed.toString();
    return escapeHtmlAttribute(canonical).length <= VK_PARSING_MAX_CHANNEL_LINK_URL_LENGTH
      ? canonical
      : null;
  } catch {
    return null;
  }
}
