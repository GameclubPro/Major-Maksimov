import type { CustomPostButtonSettings } from '../common/channel-custom-post-buttons';
import type { ChannelSettings } from '../prisma/prisma-client';

type Decorations = Pick<
  ChannelSettings,
  | 'postSignatureEnabled'
  | 'quickButtonsEnabled'
  | 'commentsEnabled'
  | 'postSuggestionsEnabled'
  | 'updatedAt'
> &
  CustomPostButtonSettings;

export function hasChannelDecorations(settings: Decorations): boolean {
  return (
    settings.postSignatureEnabled ||
    settings.quickButtonsEnabled ||
    settings.commentsEnabled ||
    settings.postSuggestionsEnabled
  );
}

/** Each feature starts at its own explicit enablement, never at another feature's baseline. */
export function channelDecorationStart(
  settings: Decorations,
  marketplaceAt: Date | null,
): number | null {
  const legacy = hasChannelDecorations(settings) ? settings.updatedAt.getTime() : null;
  const marketplace = marketplaceAt?.getTime() ?? null;
  const custom = settings.customPostButtonsEnabled
    ? (settings.customPostButtonsSince?.getTime() ?? null)
    : null;
  const baselines = [legacy, marketplace, custom].filter(
    (value): value is number => value !== null,
  );
  return baselines.length ? Math.min(...baselines) : null;
}

export function marketplacePostIsEligible(
  sourceAt: string | null | undefined,
  activation: Date | null,
): boolean {
  const timestamp = Date.parse(sourceAt ?? '');
  return activation !== null && Number.isFinite(timestamp) && timestamp >= activation.getTime();
}

export function channelSettingsForSource<T extends Decorations>(
  settings: T,
  sourceAt: string | null | undefined,
): T {
  const timestamp = Date.parse(sourceAt ?? '');
  if (!Number.isFinite(timestamp) || timestamp >= settings.updatedAt.getTime()) return settings;
  return {
    ...settings,
    postSignatureEnabled: false,
    quickButtonsEnabled: false,
    commentsEnabled: false,
    postSuggestionsEnabled: false,
  };
}
