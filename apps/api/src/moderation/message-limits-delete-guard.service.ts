import {
  prepareDeleteAuthority,
  finalizeDeleteAuthority,
  type DeleteAuthorityPreparation,
} from './moderation-delete-authority-preparation';
import { fingerprintModerationSettings } from './moderation-settings-fingerprint';
import { VOICE_SOURCE_LIFETIME_MS } from './voice-webhook-source';
export { fingerprintModerationSettings } from './moderation-settings-fingerprint';
import type { ChatSettings } from '../prisma/prisma-client';
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { MaxUpdate } from '@maxim/contracts';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { AutomaticDeleteAuthorAccessService } from '../max/automatic-delete-author-access.service';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../max/max-client.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookParser } from '../webhook/webhook.parser';
import { ParticipantModerationImmunityService } from './participant-moderation-immunity.service';
import {
  calculateEffectiveMessageLength,
  detectMediaFlags,
  hasForwardedMessage,
  shouldSkipAntiSpamBurstForForward,
} from './moderation-update-extractors';
import { extractBlockedPhoneNumbers } from './phone-blocking-evidence';
import { MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES } from './moderation.service.support';

export const MESSAGE_LIMITS_CURRENT_CONTENT_RULES = new Set([
  'MESSAGE_TOO_LONG_DELETE',
  'PHONE_NUMBER_BLOCKED_DELETE',
  'PHOTO_BLOCKED_DELETE',
  'VIDEO_BLOCKED_DELETE',
  'FILE_BLOCKED_DELETE',
  'VOICE_BLOCKED_DELETE',
  'FORWARDED_MESSAGE_BLOCKED_DELETE',
]);

export const MESSAGE_LIMITS_STATEFUL_RULES = new Set([
  'MESSAGE_RATE_LIMIT_DELETE',
  'MESSAGE_COUNT_LIMIT_DELETE',
  'PHOTO_RATE_LIMIT_DELETE',
  'STICKER_RATE_LIMIT_DELETE',
]);
export const MESSAGE_LIMITS_GUARDED_RULES = new Set([
  ...MESSAGE_LIMITS_CURRENT_CONTENT_RULES,
  ...MESSAGE_LIMITS_STATEFUL_RULES,
]);

export function bindMessageLimitEvidence(
  settings: ChatSettings,
  eventTimestampMs: number,
  ruleCode: string,
  quotaAnchorTimestampMs?: unknown,
) {
  // FLAG: Later parts of one album retain the original quota decision's expiry.
  const evidenceTimestampMs =
    ruleCode.replace(/_DELETE$/u, '') === 'MESSAGE_COUNT_LIMIT' &&
    typeof quotaAnchorTimestampMs === 'number' &&
    Number.isSafeInteger(quotaAnchorTimestampMs) &&
    quotaAnchorTimestampMs > 0 &&
    quotaAnchorTimestampMs <= eventTimestampMs
      ? quotaAnchorTimestampMs
      : eventTimestampMs;
  return {
    messageLimitEvidenceVersion: 1,
    messageLimitPolicySha256: fingerprintModerationSettings(settings, ruleCode),
    messageLimitEventTimestampMs: evidenceTimestampMs,
    messageLimitDeadlineAtMs: evidenceTimestampMs + 5 * 60_000,
  };
}

export class MessageLimitsDeleteGuardRejectedError extends Error {
  readonly code = 'message_limits_delete_no_longer_authorized';
}

type Reason = { ruleCode: string; reasonKey: string; metadata?: unknown };
type Settings = Awaited<ReturnType<MessageLimitsDeleteGuardService['loadSettings']>>;

@Injectable()
export class MessageLimitsDeleteGuardService {
  private readonly parser = new WebhookParser();
  constructor(
    private readonly prisma: PrismaService,
    private readonly max: MaxClientService,
    private readonly bots: MaxBotLinkService,
    private readonly immunity: ParticipantModerationImmunityService,
    private readonly config: ConfigService,
    @Optional() private readonly automaticDeleteAuthorAccess?: AutomaticDeleteAuthorAccessService,
  ) {}

  async authorize(params: {
    chatId: string;
    messageId: string;
    subjectUserId: string | null;
    sourceMessageAt?: Date | null;
    botId: string;
    reasons: readonly Reason[];
  }): Promise<
    | 'not_applicable'
    | 'absent'
    | {
        reasonKeys: string[];
        deadlineAtMs?: number;
        reasonDeadlines?: { reasonKey: string; deadlineAtMs: number }[];
      }
  > {
    return finalizeDeleteAuthority(await this.prepareForDispatch(params));
  }

  async prepareForDispatch(
    params: Parameters<MessageLimitsDeleteGuardService['authorize']>[0],
  ): Promise<
    DeleteAuthorityPreparation<Awaited<ReturnType<MessageLimitsDeleteGuardService['authorize']>>>
  > {
    const owned = params.reasons.filter((reason) =>
      MESSAGE_LIMITS_GUARDED_RULES.has(reason.ruleCode),
    );
    if (!owned.length) return 'not_applicable';
    const userId = params.subjectUserId;
    if (!userId || this.bots.isKnownBotUserId(userId)) this.reject();
    const settings = await this.loadSettings(params.chatId, userId);
    // FLAG: Known expired stateful authority cannot be renewed by a MAX read retry.
    // A current-content reason or unproven expiry still requires ordinary preparation.
    const now = Date.now();
    if (owned.every((reason) => this.isExpiredStatefulReason(reason, settings, now))) this.reject();
    const options = {
      botId: params.botId,
      bypassCache: true,
      timeoutMs: this.config.get<number>('MODERATION_DELETE_INTENT_TIMEOUT_MS') ?? 5000,
      trafficClass: 'critical' as const,
      actionHealthLane: 'critical' as const,
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      ignoreFailureMetricStatuses: MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES,
    };
    const author = await this.automaticDeleteAuthorAccess?.resolve(params.chatId, userId, options, {
      requireMembership: true,
      module: 'messageLimits',
    });
    const access = author
      ? author.member
      : await this.max.getChatMemberAccess(params.chatId, userId, options);
    if (!access || (author?.isAdmin ?? Boolean(access.isAdmin || access.isOwner))) this.reject();
    if (
      access.userId !== userId ||
      typeof access.isAdmin !== 'boolean' ||
      typeof access.isOwner !== 'boolean'
    )
      throw new Error('Message limits author access unavailable');
    const voiceReasons = owned.filter(
      (reason) =>
        reason.ruleCode === 'VOICE_BLOCKED_DELETE' &&
        this.metadata(reason.metadata).voiceSourceEvidenceVersion === 1,
    );
    if (voiceReasons.length) {
      // FLAG: Authenticated native voice evidence has its own short-lived authority.
      // It grants only this reason; it never supplies current content to another rule.
      return this.authorizeVoiceSource(params, userId, voiceReasons, settings);
    }
    // FLAG: Delayed generic reasons authorize only the exact current message through this
    // attempt's selected bot. A stored length, excerpt or receiver token is not proof.
    const row = await this.max.getExactMessageRow(params.chatId, params.messageId, options);
    if (!row) return 'absent';
    const update = this.parser.parse({
      type: 'message_created',
      updateId: 'message-limits-delete-guard',
      message: row,
    });
    const message = update.message;
    if (
      !message ||
      message.chatId !== params.chatId ||
      message.messageId !== params.messageId ||
      message.senderId !== userId ||
      message.entityType === 'channel'
    )
      this.reject();
    if (!owned.some((reason) => this.matchesReason(reason, update, settings))) this.reject();
    if (
      (await this.immunity.consumeForMessage({
        chatId: params.chatId,
        userId,
        messageId: params.messageId,
        scope: 'message-limits-delete:v1',
        nightModeTimezone: settings.nightModeTimezone,
      })) === 'granted'
    )
      this.reject();
    return prepareDeleteAuthority(async () => {
      const finalSettings = await this.loadSettings(params.chatId, userId);
      const reasonKeys = owned
        .filter((reason) => this.matchesReason(reason, update, finalSettings))
        .map((reason) => reason.reasonKey);
      if (!reasonKeys.length) this.reject();
      const matched = owned.filter((reason) => reasonKeys.includes(reason.reasonKey));
      const hasContentReason = matched.some((reason) =>
        MESSAGE_LIMITS_CURRENT_CONTENT_RULES.has(reason.ruleCode),
      );
      const reasonDeadlines = matched
        .filter((reason) => MESSAGE_LIMITS_STATEFUL_RULES.has(reason.ruleCode))
        .map((reason) => ({
          reasonKey: reason.reasonKey,
          deadlineAtMs: Number(this.metadata(reason.metadata).messageLimitDeadlineAtMs),
        }));
      return {
        reasonKeys,
        ...(reasonDeadlines.length ? { reasonDeadlines } : {}),
        ...(hasContentReason
          ? {}
          : {
              deadlineAtMs: Math.max(...reasonDeadlines.map((reason) => reason.deadlineAtMs)),
            }),
      };
    });
  }

  async loadSettings(chatId: string, userId: string) {
    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId },
      include: {
        chat: {
          select: {
            entityType: true,
            admins: { where: { userId }, select: { userId: true } },
          },
        },
      },
    });
    if (!settings || settings.chat.entityType !== 'CHAT' || settings.chat.admins.length)
      this.reject();
    return settings;
  }

  private async authorizeVoiceSource(
    params: { chatId: string; messageId: string; sourceMessageAt?: Date | null },
    userId: string,
    reasons: Reason[],
    settings: Settings,
  ) {
    const check = async (current: Settings) => {
      if (current.voiceMessagesEnabled) this.reject();
      const source = await this.prisma.moderationVoiceSource.findUnique({
        where: { chatId_messageId: { chatId: params.chatId, messageId: params.messageId } },
      });
      const at = source?.sourceAt?.getTime();
      const deadlineAtMs = source?.deadlineAt?.getTime();
      if (
        !source ||
        source.invalidatedAt ||
        source.userId !== userId ||
        !source.receiptId ||
        !at ||
        !deadlineAtMs ||
        at !== params.sourceMessageAt?.getTime() ||
        deadlineAtMs !== at + VOICE_SOURCE_LIFETIME_MS ||
        at > Date.now() + 1_000 ||
        Date.now() >= deadlineAtMs
      )
        this.reject();
      const reasonKeys = reasons
        .filter((reason) => {
          const proof = this.metadata(reason.metadata);
          return (
            proof.voiceSourceAtMs === at &&
            proof.voiceSourceDeadlineAtMs === deadlineAtMs &&
            proof.voiceSourcePolicySha256 ===
              fingerprintModerationSettings(current, reason.ruleCode)
          );
        })
        .map((reason) => reason.reasonKey);
      if (!reasonKeys.length) this.reject();
      return {
        reasonKeys,
        deadlineAtMs,
        reasonDeadlines: reasonKeys.map((reasonKey) => ({ reasonKey, deadlineAtMs })),
      };
    };
    await check(settings);
    if (
      (await this.immunity.consumeForMessage({
        chatId: params.chatId,
        userId,
        messageId: params.messageId,
        scope: 'message-limits-delete:v1',
        nightModeTimezone: settings.nightModeTimezone,
      })) === 'granted'
    )
      this.reject();
    // FLAG: Re-read edits/removals and policy after awaited immunity work. The intent
    // executor also fences this same absolute reason deadline with the database clock.
    return prepareDeleteAuthority(async () =>
      check(await this.loadSettings(params.chatId, userId)),
    );
  }

  private metadata(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private isExpiredStatefulReason(reason: Reason, settings: Settings, now: number): boolean {
    if (!MESSAGE_LIMITS_STATEFUL_RULES.has(reason.ruleCode)) return false;
    const proof = this.metadata(reason.metadata);
    const eventAt = Number(proof.messageLimitEventTimestampMs);
    const deadlineAt = Number(proof.messageLimitDeadlineAtMs);
    return (
      proof.messageLimitEvidenceVersion === 1 &&
      proof.messageLimitPolicySha256 === fingerprintModerationSettings(settings, reason.ruleCode) &&
      Number.isSafeInteger(eventAt) &&
      eventAt > 0 &&
      eventAt <= now &&
      deadlineAt === eventAt + 5 * 60_000 &&
      now >= deadlineAt
    );
  }

  private matchesReason(reason: Reason, update: MaxUpdate, settings: Settings): boolean {
    if (!MESSAGE_LIMITS_STATEFUL_RULES.has(reason.ruleCode))
      return this.matches(reason.ruleCode, update, settings);
    // FLAG: A retry never counts again. Only the original detector's bounded durable evidence
    // under the unchanged policy can authorize a current eligible source message.
    const proof = this.metadata(reason.metadata);
    const eventAt = Number(proof.messageLimitEventTimestampMs);
    const deadlineAt = Number(proof.messageLimitDeadlineAtMs);
    if (
      proof.messageLimitEvidenceVersion !== 1 ||
      proof.messageLimitPolicySha256 !== fingerprintModerationSettings(settings, reason.ruleCode) ||
      !Number.isSafeInteger(eventAt) ||
      eventAt <= 0 ||
      eventAt > Date.now() ||
      deadlineAt !== eventAt + 5 * 60_000 ||
      Date.now() >= deadlineAt
    )
      return false;
    const media = detectMediaFlags(update);
    switch (reason.ruleCode) {
      case 'MESSAGE_RATE_LIMIT_DELETE':
        return (
          settings.antiSpamEnabled &&
          !media.hasPhotoAttachment &&
          !media.hasVideoAttachment &&
          !media.hasFileAttachment &&
          !media.hasVoiceAttachment &&
          !media.hasMediaBatch &&
          !shouldSkipAntiSpamBurstForForward(update)
        );
      case 'MESSAGE_COUNT_LIMIT_DELETE':
        return settings.messageCountLimitEnabled;
      case 'PHOTO_RATE_LIMIT_DELETE':
        return settings.photoMessageCooldownEnabled && media.hasPhotoAttachment;
      case 'STICKER_RATE_LIMIT_DELETE':
        return settings.stickerMessageCooldownEnabled && media.hasStickerAttachment;
      default:
        return false;
    }
  }

  private matches(ruleCode: string, update: MaxUpdate, settings: Settings): boolean {
    const media = detectMediaFlags(update);
    switch (ruleCode) {
      case 'MESSAGE_TOO_LONG_DELETE':
        return (
          settings.maxMessageLengthEnabled &&
          calculateEffectiveMessageLength(update) > settings.maxMessageLength
        );
      case 'PHONE_NUMBER_BLOCKED_DELETE':
        return (
          !settings.phoneNumbersEnabled &&
          extractBlockedPhoneNumbers(update.message?.text ?? '').length > 0
        );
      case 'PHOTO_BLOCKED_DELETE':
        return !settings.photoMessagesEnabled && media.hasPhotoAttachment;
      case 'VIDEO_BLOCKED_DELETE':
        return !settings.videoMessagesEnabled && media.hasVideoAttachment;
      case 'FILE_BLOCKED_DELETE':
        return !settings.fileMessagesEnabled && media.hasFileAttachment;
      case 'VOICE_BLOCKED_DELETE':
        return !settings.voiceMessagesEnabled && media.hasVoiceAttachment;
      case 'FORWARDED_MESSAGE_BLOCKED_DELETE':
        return settings.forwardedMessagesEnabled === false && hasForwardedMessage(update);
      default:
        return false;
    }
  }

  private reject(): never {
    throw new MessageLimitsDeleteGuardRejectedError();
  }
}
