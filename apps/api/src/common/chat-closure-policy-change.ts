import type { ChatSettings, Prisma } from '../prisma/prisma-client';
import { resolveManualChatClosure } from '../moderation/night-mode-transition-time.util';

export const CHAT_CLOSURE_POLICY_SELECT = {
  nightModeEnabled: true,
  nightModeStartTimeMinutes: true,
  nightModeEndTimeMinutes: true,
  nightModeTimezone: true,
  nightModeForceCloseEnabled: true,
  nightModeForceCloseForever: true,
  nightModeForceCloseUntil: true,
} as const satisfies Prisma.ChatSettingsSelect;

export type ChatClosurePolicy = Pick<ChatSettings, keyof typeof CHAT_CLOSURE_POLICY_SELECT>;

export function isChatClosurePolicyChanged(
  previous: ChatClosurePolicy,
  candidate: ChatClosurePolicy,
  now = Date.now(),
): boolean {
  if (previous.nightModeEnabled !== candidate.nightModeEnabled) return true;
  if (
    candidate.nightModeEnabled &&
    (previous.nightModeStartTimeMinutes !== candidate.nightModeStartTimeMinutes ||
      previous.nightModeEndTimeMinutes !== candidate.nightModeEndTimeMinutes ||
      previous.nightModeTimezone !== candidate.nightModeTimezone)
  )
    return true;

  // FLAG: Clearing an expired timer or editing inactive presets cannot supersede a command.
  const at = new Date(now);
  const before = resolveManualChatClosure(previous, at);
  const after = resolveManualChatClosure(candidate, at);
  return before.mode !== after.mode || before.until !== after.until;
}
