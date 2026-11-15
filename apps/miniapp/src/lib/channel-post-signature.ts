import {
  channelPostSignatureSettingsSchema,
  channelPostSignatureUrlSchema,
  type ChannelPostSignatureSettings,
  type UpdateChannelPostSignatureRequest,
} from '@maxim/contracts/channel-post-signature';

export function normalizePostSignatureSettings(
  value: ChannelPostSignatureSettings,
): ChannelPostSignatureSettings {
  const parsedUrl = parseChannelPostSignatureUrl(value.url);
  return {
    ...(value.revision !== undefined ? { revision: value.revision } : {}),
    enabled: value.enabled,
    presentation: value.presentation,
    text: value.text.trim(),
    url: parsedUrl.error ? value.url.trim() : parsedUrl.url,
    customButtonsEnabled: value.customButtonsEnabled ?? false,
    customButtons: value.customButtons ?? [],
  };
}

export function validatePostSignatureSettings(value: ChannelPostSignatureSettings) {
  return channelPostSignatureSettingsSchema.safeParse(normalizePostSignatureSettings(value));
}

export function buildPostSignaturePatch(
  next: ChannelPostSignatureSettings,
  previous: ChannelPostSignatureSettings | null,
): UpdateChannelPostSignatureRequest {
  return {
    expectedRevision: previous?.revision ?? next.revision ?? 0,
    ...((next.customButtonsEnabled ?? false) !== (previous?.customButtonsEnabled ?? false)
      ? { customButtonsEnabled: next.customButtonsEnabled }
      : {}),
    ...(JSON.stringify(next.customButtons ?? []) !== JSON.stringify(previous?.customButtons ?? [])
      ? { customButtons: next.customButtons }
      : {}),
    ...(next.enabled !== previous?.enabled ? { enabled: next.enabled } : {}),
    ...(next.presentation !== previous?.presentation ? { presentation: next.presentation } : {}),
    ...(next.text !== previous?.text ? { text: next.text } : {}),
    ...(next.url !== previous?.url ? { url: next.url } : {}),
  };
}

export function reconcilePostSignatureSave(
  submitted: ChannelPostSignatureSettings,
  latest: ChannelPostSignatureSettings,
  saved: ChannelPostSignatureSettings,
): ChannelPostSignatureSettings {
  const changes: Partial<UpdateChannelPostSignatureRequest> = buildPostSignaturePatch(
    latest,
    submitted,
  );
  delete changes.expectedRevision;
  return { ...saved, ...changes };
}

export type ParsedChannelPostSignatureUrl = {
  error: string | null;
  url: string;
};

export function parseChannelPostSignatureUrl(value: string): ParsedChannelPostSignatureUrl {
  const normalized = value.trim();
  if (!normalized) {
    return { error: null, url: '' };
  }

  const parsed = channelPostSignatureUrlSchema.safeParse(normalized);
  if (parsed.success) {
    return { error: null, url: parsed.data };
  }

  return {
    error: parsed.error.issues[0]?.message ?? 'Укажите корректную ссылку (http/https).',
    url: '',
  };
}

export function resolveChannelPostSignaturePreviewUrl(
  customUrl: string,
  channelFallbackUrl: string,
): ParsedChannelPostSignatureUrl {
  if (customUrl.trim()) {
    return parseChannelPostSignatureUrl(customUrl);
  }

  return {
    error: null,
    url: parseChannelPostSignatureUrl(channelFallbackUrl).url,
  };
}
