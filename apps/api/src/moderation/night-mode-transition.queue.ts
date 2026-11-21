import { createHash } from 'node:crypto';
import { matchesNightModeRecoveryBoundaryTime } from './night-mode-recovery-time-compat.util';
import type { QueueJobEnvelope, QueueRetryPolicyName } from '../common/queue-job-envelope';
import {
  buildNightModeTransitionSessionKey,
  parseNightModeTransitionSessionKey,
  resolveNightModeTransitionSessionCloseAt,
  type NightModeTransitionKind,
} from './night-mode-transition-time.util';

export const NIGHT_MODE_TRANSITION_QUEUE = 'night-mode-transitions';
export const NIGHT_MODE_TRANSITION_JOB_NAME = 'night-mode-transition';
export const NIGHT_MODE_ROUTE_VERIFICATION_JOB_NAME = 'night-mode-route-verification';
export const NIGHT_MODE_ROUTE_VERIFICATION_KIND = 'close_notice_presence' as const;
export const NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY = 'close_notice_event' as const;
export const NIGHT_MODE_TRANSITION_OPEN_EVENT_RECOVERY = 'open_notice_event' as const;
export const NIGHT_MODE_TRANSITION_CLOSE_CLEANUP_RECOVERY = 'close_notice_cleanup' as const;
export const NIGHT_MODE_INDEPENDENT_RECOVERY_READER_VERSION = 2;
export const NIGHT_MODE_RECOVERY_UNSAFE_PREFIX = 'Night mode recovery proof is unsafe';
export class NightModeRecoveryUnsafeError extends Error {
  constructor(reason: string) {
    super(`${NIGHT_MODE_RECOVERY_UNSAFE_PREFIX}: ${reason}`);
    this.name = 'NightModeRecoveryUnsafeError';
  }
}
export const NIGHT_MODE_STICKY_ROUTE_PROBE_KIND = 'future_night_close' as const;
export const NIGHT_MODE_TRANSITION_POST_EXECUTION_CLEANUP_FAILURE_PREFIX =
  'Night mode transition post-execution scheduling failed';
export const NIGHT_MODE_TRANSITION_LOCK_BUSY_FAILURE_PREFIX = 'Night mode transition lock is busy';

export type NightModeTransitionRecoveryOnly = {
  kind: typeof NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY;
  version: 1;
  sessionKey: string;
  messageId: string;
  botId: string;
  timezone: string;
  startMinutes: number;
  endMinutes: number;
};

export type NightModeTransitionOpenEventRecovery = Omit<NightModeTransitionRecoveryOnly, 'kind'> & {
  kind: typeof NIGHT_MODE_TRANSITION_OPEN_EVENT_RECOVERY;
};

export type NightModeTransitionCloseCleanupRecovery = {
  kind: typeof NIGHT_MODE_TRANSITION_CLOSE_CLEANUP_RECOVERY;
  version: 1;
  sessionKey: string;
  timezone: string;
  startMinutes: number;
  endMinutes: number;
  openScheduledFor: string;
  scheduleFingerprint: string;
  sideEffectFingerprint: string;
};

export type NightModeTransitionRecoveryObligation =
  | NightModeTransitionRecoveryOnly
  | NightModeTransitionOpenEventRecovery
  | NightModeTransitionCloseCleanupRecovery;

export type NightModeRouteVerification = {
  kind: typeof NIGHT_MODE_ROUTE_VERIFICATION_KIND;
  version: 1;
  sessionKey: string;
  messageId: string;
  botId: string;
  sentAt: string;
  attemptCount: number;
  presentCount: number;
  absentCount: number;
};

export type NightModeRouteVerificationProof = {
  chatId: string;
  sessionKey: string;
  messageId: string;
  botId: string;
  sentAt: Date;
};

export type NightModeStickyRouteProbe = {
  kind: typeof NIGHT_MODE_STICKY_ROUTE_PROBE_KIND;
  version: 1;
  authorizedAt: string;
  scheduledFor: string;
  sessionKey: string;
  scheduleFingerprint: string;
};

export type NightModeTransitionJob = QueueJobEnvelope<
  {
    chatId: string;
    transition: NightModeTransitionKind;
    scheduledFor: string;
    sessionKey: string;
  },
  {
    retryPolicyName?: Extract<QueueRetryPolicyName, 'night-mode-transition'>;
    createdAt?: string;
    transitionRuntimeVersion?: 2 | 3 | 4;
    scheduleFingerprint?: string;
    stickyRouteProbe?: NightModeStickyRouteProbe;
    recoveryOnly?: NightModeTransitionRecoveryObligation;
    routeVerification?: NightModeRouteVerification;
  }
>;

export type NightModeTransitionProcessResult = {
  shouldEnqueueNext: boolean;
  waitForManualOpening?: true;
};

export const NIGHT_MODE_TRANSITION_PROCESS_CONTINUE: NightModeTransitionProcessResult = {
  shouldEnqueueNext: true,
};

export const NIGHT_MODE_TRANSITION_PROCESS_STOP: NightModeTransitionProcessResult = {
  shouldEnqueueNext: false,
};

export function buildNightModeTransitionJobId(
  chatId: string,
  transition: NightModeTransitionKind,
  scheduledFor: string,
  sessionKey: string,
): string {
  // FLAG: SHA-1 preserves IDs for persisted BullMQ jobs; it is not a security boundary.
  const occurrenceDigest = createHash('sha1')
    .update(`${chatId}:${transition}:${scheduledFor}:${sessionKey}`)
    .digest('hex');
  return `${buildNightModeTransitionJobIdPrefix(chatId)}${transition}__${occurrenceDigest}`;
}

export function buildNightModeTransitionJobIdPrefix(chatId: string): string {
  // FLAG: Keep this aligned with the legacy occurrence digest until queued jobs are migrated.
  const chatDigest = createHash('sha1').update(chatId).digest('hex');
  return `night-mode-transition__${chatDigest}__`;
}

export function buildNightModeTransitionRecoveryJobId(
  chatId: string,
  recovery: NightModeTransitionRecoveryObligation,
): string {
  const digest = createHash('sha256')
    .update(
      [
        chatId.trim(),
        recovery.kind,
        recovery.version,
        recovery.sessionKey,
        ...(recovery.kind === NIGHT_MODE_TRANSITION_CLOSE_CLEANUP_RECOVERY
          ? [
              recovery.openScheduledFor,
              recovery.scheduleFingerprint,
              recovery.sideEffectFingerprint,
            ]
          : [recovery.messageId, recovery.botId]),
      ].join('\u001f'),
    )
    .digest('hex');
  return `${buildNightModeTransitionJobIdPrefix(chatId)}recovery__${digest}`;
}

export function buildNightModeRouteVerificationJobId(
  chatId: string,
  verification: Pick<
    NightModeRouteVerification,
    'kind' | 'version' | 'sessionKey' | 'messageId' | 'botId' | 'sentAt'
  >,
): string {
  const digest = createHash('sha256')
    .update(
      [
        chatId.trim(),
        verification.kind,
        verification.version,
        verification.sessionKey,
        verification.messageId,
        verification.botId,
        verification.sentAt,
      ].join('\u001f'),
    )
    .digest('hex');
  return `${buildNightModeTransitionJobIdPrefix(chatId)}verify__${digest}`;
}

export function parseNightModeTransitionRecoveryOnly(
  value: unknown,
): NightModeTransitionRecoveryOnly | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const sessionKey = boundedString(record.sessionKey, 512);
  const messageId = boundedString(record.messageId, 256);
  const botId = boundedString(record.botId, 256);
  const timezone = boundedString(record.timezone, 128);
  const startMinutes = record.startMinutes;
  const endMinutes = record.endMinutes;
  if (
    record.kind !== NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY ||
    record.version !== 1 ||
    !sessionKey ||
    !messageId ||
    !botId ||
    !timezone ||
    !Number.isInteger(startMinutes) ||
    typeof startMinutes !== 'number' ||
    startMinutes < 0 ||
    startMinutes > 1_439 ||
    !Number.isInteger(endMinutes) ||
    typeof endMinutes !== 'number' ||
    endMinutes < 0 ||
    endMinutes > 1_439
  ) {
    return null;
  }
  const sessionDateKey = sessionKey.slice(-10);
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(sessionDateKey) ||
    buildNightModeTransitionSessionKey({
      timezone,
      startMinutes,
      endMinutes,
      sessionDateKey,
    }) !== sessionKey
  ) {
    return null;
  }
  return {
    kind: NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY,
    version: 1,
    sessionKey,
    messageId,
    botId,
    timezone,
    startMinutes,
    endMinutes,
  };
}

export function parseNightModeTransitionRecoveryObligation(
  value: unknown,
): NightModeTransitionRecoveryObligation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY) {
    return parseNightModeTransitionRecoveryOnly(value);
  }
  if (record.kind === NIGHT_MODE_TRANSITION_OPEN_EVENT_RECOVERY) {
    const receipt = parseNightModeTransitionRecoveryOnly({
      ...record,
      kind: NIGHT_MODE_TRANSITION_CLOSE_EVENT_RECOVERY,
    });
    return receipt && parseNightModeTransitionSessionKey(receipt.sessionKey)
      ? { ...receipt, kind: NIGHT_MODE_TRANSITION_OPEN_EVENT_RECOVERY }
      : null;
  }
  const sessionKey = boundedString(record.sessionKey, 512);
  const session = sessionKey ? parseNightModeTransitionSessionKey(sessionKey) : null;
  const openScheduledFor = boundedString(record.openScheduledFor, 64);
  const scheduleFingerprint = boundedString(record.scheduleFingerprint, 128);
  const sideEffectFingerprint = boundedString(record.sideEffectFingerprint, 128);
  if (
    record.kind !== NIGHT_MODE_TRANSITION_CLOSE_CLEANUP_RECOVERY ||
    record.version !== 1 ||
    !sessionKey ||
    !session ||
    record.timezone !== session.timezone ||
    record.startMinutes !== session.startMinutes ||
    record.endMinutes !== session.endMinutes ||
    !openScheduledFor ||
    !matchesNightModeRecoveryBoundaryTime({
      sessionKey,
      transition: 'open',
      scheduledFor: openScheduledFor,
    }) ||
    !scheduleFingerprint ||
    !/^sha256:[a-f0-9]{64}$/u.test(scheduleFingerprint) ||
    !sideEffectFingerprint ||
    !/^sha256:[a-f0-9]{64}$/u.test(sideEffectFingerprint)
  )
    return null;
  return {
    kind: NIGHT_MODE_TRANSITION_CLOSE_CLEANUP_RECOVERY,
    version: 1,
    sessionKey,
    timezone: session.timezone,
    startMinutes: session.startMinutes,
    endMinutes: session.endMinutes,
    openScheduledFor,
    scheduleFingerprint,
    sideEffectFingerprint,
  };
}

export function parseNightModeRouteVerification(value: unknown): NightModeRouteVerification | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const sessionKey = boundedString(record.sessionKey, 512);
  const messageId = boundedString(record.messageId, 256);
  const botId = boundedString(record.botId, 256);
  const sentAt = boundedString(record.sentAt, 64);
  const sentAtMs = sentAt ? Date.parse(sentAt) : Number.NaN;
  const attemptCount = boundedCounter(record.attemptCount, 6);
  const presentCount = boundedCounter(record.presentCount, 2);
  const absentCount = boundedCounter(record.absentCount, 3);
  if (
    record.kind !== NIGHT_MODE_ROUTE_VERIFICATION_KIND ||
    record.version !== 1 ||
    !sessionKey ||
    !messageId ||
    !botId ||
    !sentAt ||
    !Number.isFinite(sentAtMs) ||
    new Date(sentAtMs).toISOString() !== sentAt ||
    attemptCount === null ||
    presentCount === null ||
    absentCount === null
  ) {
    return null;
  }
  if (
    presentCount > attemptCount ||
    absentCount > attemptCount ||
    (presentCount > 0 && absentCount > 0)
  ) {
    return null;
  }
  return {
    kind: NIGHT_MODE_ROUTE_VERIFICATION_KIND,
    version: 1,
    sessionKey,
    messageId,
    botId,
    sentAt,
    attemptCount,
    presentCount,
    absentCount,
  };
}

export function parseNightModeStickyRouteProbe(value: unknown): NightModeStickyRouteProbe | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 6 ||
    keys.join('\u0000') !==
      ['authorizedAt', 'kind', 'scheduleFingerprint', 'scheduledFor', 'sessionKey', 'version'].join(
        '\u0000',
      )
  ) {
    return null;
  }
  const authorizedAt = canonicalIsoDate(record.authorizedAt);
  const scheduledFor = canonicalIsoDate(record.scheduledFor);
  const sessionKey = boundedString(record.sessionKey, 512);
  const scheduleFingerprint = boundedString(record.scheduleFingerprint, 80);
  const session = sessionKey ? parseNightModeTransitionSessionKey(sessionKey) : null;
  const sessionCloseAt = sessionKey ? resolveNightModeTransitionSessionCloseAt(sessionKey) : null;
  if (
    record.kind !== NIGHT_MODE_STICKY_ROUTE_PROBE_KIND ||
    record.version !== 1 ||
    !authorizedAt ||
    !scheduledFor ||
    Date.parse(authorizedAt) >= Date.parse(scheduledFor) ||
    !sessionKey ||
    !session ||
    !sessionCloseAt ||
    sessionCloseAt.toISOString() !== scheduledFor ||
    !scheduleFingerprint ||
    !/^sha256:[a-f0-9]{64}$/u.test(scheduleFingerprint)
  ) {
    return null;
  }
  return {
    kind: NIGHT_MODE_STICKY_ROUTE_PROBE_KIND,
    version: 1,
    authorizedAt,
    scheduledFor,
    sessionKey,
    scheduleFingerprint,
  };
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : null;
}

function boundedCounter(value: unknown, max: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max
    ? value
    : null;
}

function canonicalIsoDate(value: unknown): string | null {
  const normalized = boundedString(value, 64);
  if (!normalized) {
    return null;
  }
  const time = Date.parse(normalized);
  return Number.isFinite(time) && new Date(time).toISOString() === normalized ? normalized : null;
}
