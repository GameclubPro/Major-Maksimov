import type { ChatSettings } from '../prisma/prisma-client';
import {
  resolveManualChatClosure,
  resolveNightModeTransitionSnapshot,
} from './night-mode-transition-time.util';

export const NIGHT_MODE_OPEN_NOTICE_CLEANUP_RULE_CODE = 'NIGHT_MODE_OPEN_NOTICE_CLEANUP';
export const NIGHT_MODE_OPEN_NOTICE_CLEANUP_STALE_CODE = 'night_mode_open_notice_cleanup_stale';
export const NIGHT_MODE_OPEN_NOTICE_TRIGGER_MAX_AGE_MS = 5 * 60_000;

export type NightModeOpenNoticeCleanupSettings = Pick<
  ChatSettings,
  | 'chatId'
  | 'nightModeEnabled'
  | 'nightModeStartTimeMinutes'
  | 'nightModeEndTimeMinutes'
  | 'nightModeTimezone'
  | 'nightModeOpenMessageEnabled'
  | 'nightModeOpenMessageDeleteOnFirstMessageEnabled'
  | 'nightModeForceCloseEnabled'
  | 'nightModeForceCloseForever'
  | 'nightModeForceCloseUntil'
>;

export type NightModeOpenNoticeCleanupBinding = {
  version: 1;
  sessionKey: string;
  eventId: string;
  messageId: string;
  botId: string;
  sendCompletedAt: string;
  trigger: { messageId: string; userId: string; createdAt: string };
};

export class NightModeOpenNoticeCleanupRejectedError extends Error {
  readonly code = NIGHT_MODE_OPEN_NOTICE_CLEANUP_STALE_CODE;

  constructor() {
    super('Night mode opening notice cleanup no longer has its exact current authority');
    this.name = 'NightModeOpenNoticeCleanupRejectedError';
  }
}

export function resolveNightModeOpenNoticeCleanupSession(
  settings: NightModeOpenNoticeCleanupSettings,
  now = new Date(),
): string | null {
  if (
    !settings.nightModeOpenMessageEnabled ||
    !settings.nightModeOpenMessageDeleteOnFirstMessageEnabled ||
    resolveManualChatClosure(settings, now).active
  )
    return null;
  const snapshot = resolveNightModeTransitionSnapshot(settings, now);
  return snapshot?.status === 'open' ? snapshot.sessionKey : null;
}

export function parseNightModeOpenNoticeCleanupBinding(
  input: unknown,
): NightModeOpenNoticeCleanupBinding | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  const trigger = value.trigger as Record<string, unknown> | undefined;
  const nonempty = (entry: unknown): entry is string =>
    typeof entry === 'string' && entry.trim().length > 0;
  if (
    value.version !== 1 ||
    !nonempty(value.sessionKey) ||
    !nonempty(value.eventId) ||
    !nonempty(value.messageId) ||
    !nonempty(value.botId) ||
    !nonempty(value.sendCompletedAt) ||
    !trigger ||
    !nonempty(trigger.messageId) ||
    !nonempty(trigger.userId) ||
    !nonempty(trigger.createdAt)
  )
    return null;
  const completedAt = Date.parse(value.sendCompletedAt);
  const triggerAt = Date.parse(trigger.createdAt);
  if (
    !Number.isFinite(completedAt) ||
    !Number.isFinite(triggerAt) ||
    triggerAt <= completedAt ||
    trigger.messageId === value.messageId
  )
    return null;
  return {
    version: 1,
    sessionKey: value.sessionKey,
    eventId: value.eventId,
    messageId: value.messageId,
    botId: value.botId,
    sendCompletedAt: value.sendCompletedAt,
    trigger: {
      messageId: trigger.messageId,
      userId: trigger.userId,
      createdAt: trigger.createdAt,
    },
  };
}
