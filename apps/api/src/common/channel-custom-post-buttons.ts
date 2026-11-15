import { channelCustomPostButtonsSchema } from '@maxim/contracts/channel-post-signature';
import type { MaxMessageButton } from '../max/max-client.service';

export type CustomPostButtonSettings = {
  customPostButtonsEnabled?: boolean;
  customPostButtons?: unknown;
  customPostButtonsSince?: Date | null;
};

export function channelCustomButtonsEligible(
  settings: CustomPostButtonSettings | null | undefined,
  sourceAt?: string | null,
): boolean {
  if (!settings?.customPostButtonsEnabled) return false;
  if (sourceAt === undefined) return true;
  const timestamp = Date.parse(sourceAt ?? '');
  return Boolean(
    settings.customPostButtonsSince &&
    Number.isFinite(timestamp) &&
    timestamp >= settings.customPostButtonsSince.getTime(),
  );
}

export function buildChannelCustomPostButtons(
  settings: CustomPostButtonSettings | null | undefined,
  sourceAt?: string | null,
): MaxMessageButton[][] {
  // FLAG: A late observation of an older post never acquires new channel button settings.
  // Undefined is reserved for preparation of a new send; unknown observed time is null.
  if (!channelCustomButtonsEligible(settings, sourceAt)) return [];
  const parsed = channelCustomPostButtonsSchema.safeParse(settings?.customPostButtons);
  if (!parsed.success) return [];
  return parsed.data.map(({ text, url }) => [{ type: 'link', text, url }]);
}
