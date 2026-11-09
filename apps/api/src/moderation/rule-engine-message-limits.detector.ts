import type { ChatSettings } from '../prisma/prisma-client';
import { createHash } from 'node:crypto';
import { raceWithTimeout } from '../common/promise-timeout.util';
import { classifyDuplicateEventTime } from './duplicate-enforcement-safety';
import { resolveDuplicateHistoryRetentionSeconds } from './duplicate-state';
import { isRedisCounterPreDispatchUnavailable, RedisCounterService } from './redis-counter.service';
import { extractBlockedPhoneNumbers } from './phone-blocking-evidence';
import type { RuleViolation } from './rule-engine.contract';
import { MessageLimitsBlockedDomainDetector } from './rule-engine-blocked-domains.detector';
import { MessageLimitsBlockedWordDetector } from './rule-engine-blocked-words.detector';
import type { RuleEvaluationObserver } from './rule-engine-observation';

export const ANTI_SPAM_BURST_LIMIT = 5;
export const ANTI_SPAM_BURST_WINDOW_SEC = 6;
const ANTI_SPAM_STATE_LOOKUP_TIMEOUT_MS = 120;
const MESSAGE_LIMIT_STATE_TIMEOUT_MS = 250;
const PHONE_NUMBER_CANDIDATE_PATTERN = /(?:^|[^\d+])(\+?\d[\d\s().-]{7,}\d)(?=$|[^\d])/gu;
const PHONE_CONTEXT_WORD_PATTERN =
  /(?:тел|телефон|номер|звон|звонить|связь|связаться|whatsapp|ватсап|wa|вайбер|viber|личк|лс)/iu;

type MessageLimitStateRule =
  | 'anti-spam-burst'
  | 'message-count-limit'
  | 'photo-cooldown'
  | 'sticker-cooldown';
export type MessageLimitStateObservation = Readonly<{
  rule: MessageLimitStateRule;
  reason: 'deadline' | 'pre_dispatch_unavailable';
}>;
type MessageLimitStateObserver = (value: MessageLimitStateObservation) => void | Promise<void>;
type MessageLimitCounters = Pick<
  RedisCounterService,
  'incrementWithTtl' | 'claimEventCooldown' | 'replaceRevisionedSetMembershipsBeforeDeadline'
>;

export class RuleEngineMessageLimitsDetector {
  private readonly blockedWordDetector = new MessageLimitsBlockedWordDetector();
  private readonly blockedDomainDetector = new MessageLimitsBlockedDomainDetector();

  constructor(
    private readonly redisCounter: MessageLimitCounters,
    private readonly observeUnavailableState?: MessageLimitStateObserver,
  ) {}

  async detectAntiSpamBurstLimit(params: {
    chatId: string;
    userId: string;
    messageId?: string;
    eventTimestampMs?: number;
    settings: ChatSettings;
    hasExcludedAttachment?: boolean;
    skipAntiSpamBurstLimit?: boolean;
    observer?: RuleEvaluationObserver;
  }): Promise<RuleViolation | null> {
    const { chatId, userId, settings, hasExcludedAttachment, skipAntiSpamBurstLimit } = params;
    params.observer?.configured(settings.antiSpamEnabled);
    if (!settings.antiSpamEnabled || hasExcludedAttachment || skipAntiSpamBurstLimit) {
      params.observer?.finish({
        kind: 'skip',
        reason: !settings.antiSpamEnabled
          ? 'disabled'
          : hasExcludedAttachment
            ? 'content'
            : 'state',
      });
      return null;
    }

    const key = `message:anti-spam-burst:v2:${chatId}:${userId}:${ANTI_SPAM_BURST_LIMIT}:${ANTI_SPAM_BURST_WINDOW_SEC}`;
    const count = await this.countEventWindow({
      rule: 'anti-spam-burst',
      key,
      messageId: params.messageId,
      eventTimestampMs: params.eventTimestampMs,
      windowSeconds: ANTI_SPAM_BURST_WINDOW_SEC,
      countLimit: ANTI_SPAM_BURST_LIMIT + 1,
      timeoutMs: ANTI_SPAM_STATE_LOOKUP_TIMEOUT_MS,
      observer: params.observer,
    });
    if (count !== null)
      params.observer?.finish({ kind: 'evaluated', matched: count > ANTI_SPAM_BURST_LIMIT });
    if (count === null || count <= ANTI_SPAM_BURST_LIMIT) {
      return null;
    }

    return {
      ruleCode: 'MESSAGE_RATE_LIMIT',
      score: 0.9,
      reason: `Messages are limited to ${ANTI_SPAM_BURST_LIMIT} per ${ANTI_SPAM_BURST_WINDOW_SEC}s`,
      metadata: {
        count,
        maxMessages: ANTI_SPAM_BURST_LIMIT,
        windowSec: ANTI_SPAM_BURST_WINDOW_SEC,
      },
    };
  }

  detectMessageLengthLimit(params: {
    measuredLength: number;
    settings: ChatSettings;
    observer?: RuleEvaluationObserver;
  }): RuleViolation | null {
    const { measuredLength, settings } = params;
    params.observer?.configured(settings.maxMessageLengthEnabled);
    if (settings.maxMessageLengthEnabled) params.observer?.eligible();
    if (!settings.maxMessageLengthEnabled || measuredLength <= settings.maxMessageLength) {
      params.observer?.finish(
        settings.maxMessageLengthEnabled
          ? { kind: 'evaluated', matched: false }
          : { kind: 'skip', reason: 'disabled' },
      );
      return null;
    }

    params.observer?.finish({ kind: 'evaluated', matched: true });
    return {
      ruleCode: 'MESSAGE_TOO_LONG',
      score: 0.82,
      reason: `Message length ${measuredLength} exceeds limit ${settings.maxMessageLength}`,
    };
  }

  async detectMessageCountLimit(params: {
    chatId: string;
    userId: string;
    messageId?: string;
    eventTimestampMs?: number;
    settings: ChatSettings;
    observer?: RuleEvaluationObserver;
  }): Promise<RuleViolation | null> {
    const { chatId, userId, settings } = params;
    params.observer?.configured(settings.messageCountLimitEnabled);
    if (!settings.messageCountLimitEnabled) {
      params.observer?.finish({ kind: 'skip', reason: 'disabled' });
      return null;
    }

    const windowHours = Math.min(24, Math.max(1, settings.messageCountLimitWindowHours));
    const maxMessages = Math.min(10, Math.max(1, settings.messageCountLimitMessages));
    const key = `message:count-limit:v2:${chatId}:${userId}:${maxMessages}:${windowHours}`;
    const count = await this.countEventWindow({
      rule: 'message-count-limit',
      key,
      messageId: params.messageId,
      eventTimestampMs: params.eventTimestampMs,
      windowSeconds: windowHours * 60 * 60,
      countLimit: maxMessages + 1,
      timeoutMs: MESSAGE_LIMIT_STATE_TIMEOUT_MS,
      observer: params.observer,
    });
    if (count !== null)
      params.observer?.finish({ kind: 'evaluated', matched: count > maxMessages });
    if (count === null || count <= maxMessages) {
      return null;
    }

    return {
      ruleCode: 'MESSAGE_COUNT_LIMIT',
      score: 0.87,
      reason: `Messages are limited to ${maxMessages} per ${windowHours}h`,
    };
  }

  detectBlockedWordLimit(params: {
    text: string;
    settings: ChatSettings;
    observer?: RuleEvaluationObserver;
  }): RuleViolation | null {
    const blockedWord = this.blockedWordDetector.detect(
      params.text,
      params.settings.messageLimitsBlockedWords,
      params.observer,
    );
    if (!blockedWord) {
      return null;
    }

    return {
      ruleCode: 'MESSAGE_BLOCKED_WORD',
      score: 0.89,
      reason: `Blocked word detected: ${blockedWord.blockedWord}`,
      metadata: {
        blockedWord: blockedWord.blockedWord,
        matchKind: blockedWord.matchKind,
      },
    };
  }

  detectBlockedDomainLimit(params: {
    text: string;
    settings: ChatSettings;
    isLinkAllowlisted?: (link: string) => boolean;
    observer?: RuleEvaluationObserver;
  }): RuleViolation | null {
    const blockedDomain = this.blockedDomainDetector.detect(
      params.text,
      params.settings.messageLimitsBlockedDomains,
      {
        isLinkAllowlisted: params.isLinkAllowlisted,
        observer: params.observer,
      },
    );
    if (!blockedDomain) {
      return null;
    }

    return {
      ruleCode: 'MESSAGE_BLOCKED_DOMAIN',
      score: 0.9,
      reason: `Blocked domain detected: ${blockedDomain.blockedDomain}`,
      metadata: {
        blockedDomain: blockedDomain.blockedDomain,
        matchedDomain: blockedDomain.matchedDomain,
        matchedLink: blockedDomain.matchedLink,
      },
    };
  }

  detectPhoneNumberLimit(params: {
    text: string;
    settings: ChatSettings;
    observer?: RuleEvaluationObserver;
  }): RuleViolation | null {
    params.observer?.configured(!params.settings.phoneNumbersEnabled);
    if (params.settings.phoneNumbersEnabled) {
      params.observer?.finish({ kind: 'skip', reason: 'disabled' });
      return null;
    }

    params.observer?.eligible();
    const phoneCount = extractBlockedPhoneNumbers(params.text).length;
    params.observer?.finish({ kind: 'evaluated', matched: phoneCount > 0 });
    if (phoneCount === 0) {
      return null;
    }

    return {
      ruleCode: 'PHONE_NUMBER_BLOCKED',
      score: 0.88,
      reason: 'Phone numbers are disabled by chat settings',
      metadata: {
        phoneCount,
      },
    };
  }

  detectAttachmentLimits(params: {
    settings: ChatSettings;
    hasPhotoAttachment?: boolean;
    hasVideoAttachment?: boolean;
    hasFileAttachment?: boolean;
    hasVoiceAttachment?: boolean;
    hasForwardedMessage?: boolean;
    observer?: RuleEvaluationObserver;
  }): RuleViolation[] {
    const violations: RuleViolation[] = [];
    const {
      settings,
      hasPhotoAttachment,
      hasVideoAttachment,
      hasFileAttachment,
      hasVoiceAttachment,
      hasForwardedMessage,
    } = params;
    const configured =
      !settings.photoMessagesEnabled ||
      !settings.videoMessagesEnabled ||
      !settings.fileMessagesEnabled ||
      !settings.voiceMessagesEnabled ||
      settings.forwardedMessagesEnabled === false;
    params.observer?.configured(configured);
    const hasContent = Boolean(
      hasPhotoAttachment ||
      hasVideoAttachment ||
      hasFileAttachment ||
      hasVoiceAttachment ||
      hasForwardedMessage,
    );
    if (configured && hasContent) params.observer?.eligible();

    if (hasPhotoAttachment && !settings.photoMessagesEnabled) {
      violations.push({
        ruleCode: 'PHOTO_BLOCKED',
        score: 0.88,
        reason: 'Photo messages are disabled by chat settings',
      });
    }

    if (hasVideoAttachment && !settings.videoMessagesEnabled) {
      violations.push({
        ruleCode: 'VIDEO_BLOCKED',
        score: 0.88,
        reason: 'Video messages are disabled by chat settings',
      });
    }

    if (hasFileAttachment && !settings.fileMessagesEnabled) {
      violations.push({
        ruleCode: 'FILE_BLOCKED',
        score: 0.88,
        reason: 'File messages are disabled by chat settings',
      });
    }

    if (hasVoiceAttachment && !settings.voiceMessagesEnabled) {
      violations.push({
        ruleCode: 'VOICE_BLOCKED',
        score: 0.88,
        reason: 'Voice messages are disabled by chat settings',
      });
    }

    if (hasForwardedMessage && settings.forwardedMessagesEnabled === false) {
      violations.push({
        ruleCode: 'FORWARDED_MESSAGE_BLOCKED',
        score: 0.88,
        reason: 'Forwarded messages are disabled by chat settings',
      });
    }

    params.observer?.finish(
      !configured
        ? { kind: 'skip', reason: 'disabled' }
        : !hasContent
          ? { kind: 'skip', reason: 'content' }
          : { kind: 'evaluated', matched: violations.length > 0 },
    );
    return violations;
  }

  async detectMediaCooldownLimits(params: {
    chatId: string;
    userId: string;
    messageId?: string;
    eventTimestampMs?: number;
    settings: ChatSettings;
    hasPhotoAttachment?: boolean;
    hasStickerAttachment?: boolean;
    photoObserver?: RuleEvaluationObserver;
    stickerObserver?: RuleEvaluationObserver;
  }): Promise<RuleViolation[]> {
    const violations: RuleViolation[] = [];
    const { chatId, userId, settings, hasPhotoAttachment, hasStickerAttachment } = params;
    params.photoObserver?.configured(settings.photoMessageCooldownEnabled);
    if (!settings.photoMessageCooldownEnabled || !hasPhotoAttachment)
      params.photoObserver?.finish({
        kind: 'skip',
        reason: !settings.photoMessageCooldownEnabled ? 'disabled' : 'content',
      });

    if (hasPhotoAttachment && settings.photoMessageCooldownEnabled) {
      const cooldownSec = settings.photoMessageCooldownHours * 60 * 60;
      const key = buildMediaCooldownKey(
        'photo',
        chatId,
        userId,
        settings.photoMessageCooldownHours,
      );
      const blocked = await this.isMediaCooldownBlocked({
        rule: 'photo-cooldown',
        key,
        messageId: params.messageId,
        eventTimestampMs: params.eventTimestampMs,
        windowSeconds: cooldownSec,
        observer: params.photoObserver,
      });
      if (blocked) {
        violations.push({
          ruleCode: 'PHOTO_RATE_LIMIT',
          score: 0.86,
          reason: `Messages with photos are limited to one per ${settings.photoMessageCooldownHours}h`,
        });
      }
    }

    params.stickerObserver?.configured(settings.stickerMessageCooldownEnabled);
    if (!settings.stickerMessageCooldownEnabled || !hasStickerAttachment)
      params.stickerObserver?.finish({
        kind: 'skip',
        reason: !settings.stickerMessageCooldownEnabled ? 'disabled' : 'content',
      });
    if (hasStickerAttachment && settings.stickerMessageCooldownEnabled) {
      const cooldownSec = settings.stickerMessageCooldownMinutes * 60;
      const key = buildMediaCooldownKey(
        'sticker',
        chatId,
        userId,
        settings.stickerMessageCooldownMinutes,
      );
      const blocked = await this.isMediaCooldownBlocked({
        rule: 'sticker-cooldown',
        key,
        messageId: params.messageId,
        eventTimestampMs: params.eventTimestampMs,
        windowSeconds: cooldownSec,
        observer: params.stickerObserver,
      });
      if (blocked) {
        violations.push({
          ruleCode: 'STICKER_RATE_LIMIT',
          score: 0.86,
          reason: `Stickers are limited to one per ${settings.stickerMessageCooldownMinutes}m`,
        });
      }
    }

    return violations;
  }

  private async isMediaCooldownBlocked(params: {
    rule: MessageLimitStateRule;
    key: string;
    messageId?: string;
    eventTimestampMs?: number;
    windowSeconds: number;
    observer?: RuleEvaluationObserver;
  }): Promise<boolean> {
    const messageId = params.messageId?.trim();
    if (!messageId) {
      params.observer?.eligible();
      const blocked =
        (await this.redisCounter.incrementWithTtl(`${params.key}:legacy`, params.windowSeconds)) >
        1;
      params.observer?.finish({ kind: 'evaluated', matched: blocked });
      return blocked;
    }
    const eventTimestampMs = params.eventTimestampMs;
    if (!Number.isSafeInteger(eventTimestampMs) || !eventTimestampMs || eventTimestampMs <= 0) {
      params.observer?.finish({ kind: 'skip', reason: 'state' });
      return false;
    }

    params.observer?.eligible();
    const messageHash = createHash('sha256').update(messageId).digest('hex').slice(0, 20);
    const deadlineAtMs = Date.now() + MESSAGE_LIMIT_STATE_TIMEOUT_MS;
    const result = await this.withCounterAdmission(params.rule, () =>
      raceWithTimeout({
        operation: () =>
          this.redisCounter.claimEventCooldown({
            key: params.key,
            memberKey: `${params.key}:msg:${messageHash}`,
            eventTimestampMs,
            windowSeconds: params.windowSeconds,
            deadlineAtMs,
            requireReadyBeforeDispatch: true,
          }),
        timeoutMs: MESSAGE_LIMIT_STATE_TIMEOUT_MS,
        onTimeout: () => 'deadline_exceeded' as const,
      }),
    );
    // FLAG: Unknown cooldown state cannot prove a violation or strand the started engine.
    // Keep the Redis absolute deadline; a late response never authorizes a sanction.
    if (result === null) {
      params.observer?.finish({ kind: 'skip', reason: 'state' });
      return false;
    }
    if (result === 'deadline_exceeded') {
      this.observeState({ rule: params.rule, reason: 'deadline' });
      params.observer?.finish({ kind: 'skip', reason: 'expired' });
      return false;
    }
    if (result === 'stale') {
      params.observer?.finish({ kind: 'skip', reason: 'state' });
      return false;
    }
    params.observer?.finish({ kind: 'evaluated', matched: result === 'blocked' });
    return result === 'blocked';
  }

  private async countEventWindow(params: {
    rule: MessageLimitStateRule;
    key: string;
    messageId?: string;
    eventTimestampMs?: number;
    windowSeconds: number;
    countLimit: number;
    timeoutMs: number;
    observer?: RuleEvaluationObserver;
  }): Promise<number | null> {
    const messageId = params.messageId?.trim();
    if (!messageId) {
      params.observer?.eligible();
      const result = await raceWithTimeout({
        operation: () =>
          this.redisCounter.incrementWithTtl(`${params.key}:legacy`, params.windowSeconds),
        timeoutMs: params.timeoutMs,
        onTimeout: () => null,
      });
      if (result === null) this.observeState({ rule: params.rule, reason: 'deadline' });
      if (result === null) params.observer?.finish({ kind: 'skip', reason: 'expired' });
      return result;
    }
    const eventTimestampMs = params.eventTimestampMs;
    if (
      !Number.isSafeInteger(eventTimestampMs) ||
      !eventTimestampMs ||
      eventTimestampMs <= 0 ||
      classifyDuplicateEventTime({ eventTimestampMs, windowSec: params.windowSeconds })
    ) {
      params.observer?.finish({ kind: 'skip', reason: 'state' });
      return null;
    }
    params.observer?.eligible();
    const messageHash = createHash('sha256').update(messageId).digest('hex').slice(0, 20);
    const deadlineAtMs = Date.now() + params.timeoutMs;
    const result = await this.withCounterAdmission(params.rule, () =>
      raceWithTimeout({
        operation: () =>
          this.redisCounter.replaceRevisionedSetMembershipsBeforeDeadline({
            stateKey: `${params.key}:msg:${messageHash}`,
            member: messageHash,
            revision: eventTimestampMs,
            membershipKeys: [params.key],
            windowSeconds: params.windowSeconds,
            ttlSeconds: resolveDuplicateHistoryRetentionSeconds(params.windowSeconds),
            countLimit: params.countLimit,
            deadlineAtMs,
            requireReadyBeforeDispatch: true,
          }),
        timeoutMs: params.timeoutMs,
        onTimeout: () => ({ kind: 'deadline_exceeded' as const }),
      }),
    );
    // FLAG: An unavailable count skips only this rule, without replaying the started engine.
    // Redis still owns the absolute write deadline, including after the local wait expires.
    if (result === null) {
      params.observer?.finish({ kind: 'skip', reason: 'state' });
      return null;
    }
    if (result.kind === 'deadline_exceeded') {
      this.observeState({ rule: params.rule, reason: 'deadline' });
      params.observer?.finish({ kind: 'skip', reason: 'expired' });
      return null;
    }
    if (result.kind === 'stale') params.observer?.finish({ kind: 'skip', reason: 'state' });
    return result.kind === 'stale' ? null : (result.counts[0] ?? 0);
  }

  private async withCounterAdmission<T>(
    rule: MessageLimitStateRule,
    operation: () => Promise<T>,
  ): Promise<T | null> {
    try {
      return await operation();
    } catch (error) {
      // FLAG: Only the counter's own no-dispatch refusal can skip this rule.
      // An unknown write outcome keeps its original error and the started-handler fence.
      if (!isRedisCounterPreDispatchUnavailable(error)) throw error;
      this.observeState({ rule, reason: 'pre_dispatch_unavailable' });
      return null;
    }
  }

  private observeState(value: MessageLimitStateObservation): void {
    try {
      // FLAG: Best-effort diagnostics cannot delay moderation or change its decision.
      const pending = this.observeUnavailableState?.(value);
      if (pending) void pending.catch(() => undefined);
    } catch {
      // FLAG: The unavailable rule remains unverified even when diagnostics fail.
    }
  }
}

function buildMediaCooldownKey(
  mediaKind: 'photo' | 'sticker',
  chatId: string,
  userId: string,
  windowValue: number,
): string {
  return `${mediaKind}:cooldown:v3:${chatId}:${userId}:${windowValue}`;
}

export function extractDetectedPhoneNumbers(text: string): string[] {
  const phones: string[] = [];
  for (const match of text.matchAll(PHONE_NUMBER_CANDIDATE_PATTERN)) {
    const candidate = match[1];
    if (candidate && isPhoneNumberCandidate(candidate, text, match.index ?? 0)) {
      phones.push(normalizePhoneNumberCandidate(candidate));
    }
  }

  return Array.from(new Set(phones));
}

export function stripDetectedPhoneNumbers(text: string): string {
  // FLAG: Ignore only recognized phones, not dates, prices or numeric ranges. The regex's
  // leading boundary belongs to the surrounding text and must survive replacement.
  return text.replace(PHONE_NUMBER_CANDIDATE_PATTERN, (match, candidate: string, index: number) =>
    isPhoneNumberCandidate(candidate, text, index)
      ? `${match.slice(0, match.length - candidate.length)} `
      : match,
  );
}

function isPhoneNumberCandidate(
  candidate: string,
  sourceText: string,
  matchIndex: number,
): boolean {
  const digits = candidate.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) {
    return false;
  }

  if (isLikelyDateOrNumberRange(candidate)) {
    return false;
  }

  const trimmed = candidate.trim();
  if (trimmed.startsWith('+')) {
    return true;
  }

  if (digits.length === 11 && (digits.startsWith('7') || digits.startsWith('8'))) {
    return true;
  }

  if (digits.length !== 10) {
    return false;
  }

  if (digits.startsWith('9')) {
    return true;
  }

  return (
    /\(\s*\d{3}\s*\)|\d{3}[\s.-]+\d{3}[\s.-]+\d{2}[\s.-]+\d{2}/u.test(candidate) ||
    hasPhoneContext(sourceText, matchIndex)
  );
}

function normalizePhoneNumberCandidate(candidate: string): string {
  const digits = candidate.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) {
    return `7${digits.slice(1)}`;
  }
  if (digits.length === 10 && digits.startsWith('9')) {
    return `7${digits}`;
  }
  return digits;
}

function isLikelyDateOrNumberRange(candidate: string): boolean {
  const normalized = candidate.trim();
  if (
    normalized.startsWith('+') ||
    /\(\s*\d{3}\s*\)/u.test(normalized) ||
    /(?:^|\D)(?:\d[\s-]*)?\d{3}[\s.-]+\d{3}[\s.-]+\d{2}[\s.-]+\d{2}(?:\D|$)/u.test(normalized)
  ) {
    return false;
  }

  if (/\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/u.test(normalized)) {
    return true;
  }

  return /^\d{1,4}(?:[.,]\d+)?(?:\s*[-–]\s*\d{1,4}(?:[.,]\d+)?){2,}$/u.test(normalized);
}

function hasPhoneContext(sourceText: string, matchIndex: number): boolean {
  const start = Math.max(0, matchIndex - 40);
  const end = Math.min(sourceText.length, matchIndex + 80);
  return PHONE_CONTEXT_WORD_PATTERN.test(sourceText.slice(start, end));
}
