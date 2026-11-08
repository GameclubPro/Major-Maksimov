import {
  prepareDeleteAuthority,
  finalizeDeleteAuthority,
  type DeleteAuthorityPreparation,
} from './moderation-delete-authority-preparation';
import { isStateVoiceReason, readStateVoiceReasonKeys } from './state-voice-delete-source';
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { AutomaticDeleteAuthorAccessService } from '../max/automatic-delete-author-access.service';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../max/max-client.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookParser } from '../webhook/webhook.parser';
import { DUPLICATE_EVENT_MAX_FUTURE_SKEW_MS } from './duplicate-state';
import { ParticipantModerationImmunityService } from './participant-moderation-immunity.service';
import { MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES } from './moderation.service.support';
import {
  formatMinutesAsTime,
  resolveNextNightModeTransitionOccurrences,
  resolveNightModeTransitionSnapshot,
  resolveManualChatClosure,
} from './night-mode-transition-time.util';

export const CLOSED_CHAT_DELETE_RULE_CODES = new Set([
  'NIGHT_MODE_DELETE',
  'MANUAL_GROUP_CLOSE_DELETE',
]);

export class ClosedChatDeleteGuardRejectedError extends Error {
  readonly code = 'closed_chat_delete_no_longer_authorized';
}

type Reason = { ruleCode: string; reasonKey: string; metadata: unknown };
type Settings = Awaited<ReturnType<ClosedChatDeleteGuardService['loadSettings']>>;

@Injectable()
export class ClosedChatDeleteGuardService {
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
    sourceMessageAt: Date | null;
    botId: string;
    reasons: readonly Reason[];
  }): Promise<
    | 'not_applicable'
    | 'absent'
    | {
        reasonKeys: string[];
        deadlineAtMs: number;
        reasonDeadlines: { reasonKey: string; deadlineAtMs: number }[];
      }
  > {
    return finalizeDeleteAuthority(await this.prepareForDispatch(params));
  }

  async prepareForDispatch(
    params: Parameters<ClosedChatDeleteGuardService['authorize']>[0],
  ): Promise<
    DeleteAuthorityPreparation<Awaited<ReturnType<ClosedChatDeleteGuardService['authorize']>>>
  > {
    let owned = params.reasons.filter((reason) =>
      CLOSED_CHAT_DELETE_RULE_CODES.has(reason.ruleCode),
    );
    if (!owned.length) return 'not_applicable';
    const userId = params.subjectUserId;
    const sourceAt = params.sourceMessageAt?.getTime() ?? NaN;
    if (!userId || this.bots.isKnownBotUserId(userId) || !Number.isFinite(sourceAt)) this.reject();
    const settings = await this.loadSettings(params.chatId, userId);
    if (!owned.some((reason) => this.matches(reason, settings, sourceAt))) this.reject();
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
      throw new Error('Closed chat author access unavailable');
    const voiceReasons = owned.filter(isStateVoiceReason);
    if (voiceReasons.length) {
      const keys = await readStateVoiceReasonKeys(this.prisma, params, voiceReasons);
      owned = voiceReasons.filter((reason) => keys.includes(reason.reasonKey));
      if (!owned.length) this.reject();
    } else {
      const row = await this.max.getExactMessageRow(params.chatId, params.messageId, options);
      if (!row) return 'absent';
      const message = this.parser.parse({
        type: 'message_created',
        updateId: 'closed-chat-delete-guard',
        message: row,
      }).message;
      if (
        !message ||
        message.chatId !== params.chatId ||
        message.messageId !== params.messageId ||
        message.senderId !== userId ||
        message.entityType === 'channel' ||
        Date.parse(message.createdAt) !== sourceAt
      )
        this.reject();
    }
    if (
      (await this.immunity.consumeForMessage({
        chatId: params.chatId,
        userId,
        messageId: params.messageId,
        scope: 'closed-chat-delete:v1',
        nightModeTimezone: settings.nightModeTimezone,
      })) === 'granted'
    )
      this.reject();
    return prepareDeleteAuthority(async () => {
      const finalSettings = await this.loadSettings(params.chatId, userId);
      if (voiceReasons.length) {
        const keys = await readStateVoiceReasonKeys(this.prisma, params, owned);
        owned = owned.filter((reason) => keys.includes(reason.reasonKey));
      }
      const validReasons = owned.filter((reason) => this.matches(reason, finalSettings, sourceAt));
      const reasonDeadlines = validReasons
        .map((reason) => {
          const closureDeadline =
            reason.ruleCode === 'MANUAL_GROUP_CLOSE_DELETE'
              ? finalSettings.nightModeForceCloseForever
                ? Infinity
                : Date.parse(finalSettings.nightModeForceCloseUntil)
              : (resolveNextNightModeTransitionOccurrences(finalSettings)
                  .find((item) => item.transition === 'open')
                  ?.dueAt.getTime() ?? Infinity);
          return {
            reasonKey: reason.reasonKey,
            deadlineAtMs: Math.min(sourceAt + 5 * 60_000, closureDeadline),
          };
        })
        .filter((reason) => Date.now() < reason.deadlineAtMs);
      if (!reasonDeadlines.length) this.reject();
      return {
        reasonKeys: reasonDeadlines.map((r) => r.reasonKey),
        deadlineAtMs: Math.max(...reasonDeadlines.map((r) => r.deadlineAtMs)),
        reasonDeadlines,
      };
    });
  }

  async loadSettings(chatId: string, userId: string) {
    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId },
      select: {
        nightModeEnabled: true,
        nightModeStartTimeMinutes: true,
        nightModeEndTimeMinutes: true,
        nightModeTimezone: true,
        nightModeForceCloseEnabled: true,
        nightModeForceCloseForever: true,
        nightModeForceCloseUntil: true,
        chat: {
          select: {
            entityType: true,
            chatControlOrderAt: true,
            admins: { where: { userId }, select: { userId: true } },
          },
        },
      },
    });
    if (!settings || settings.chat.entityType !== 'CHAT' || settings.chat.admins.length)
      this.reject();
    return settings;
  }

  private matches(reason: Reason, settings: Settings, sourceAt: number): boolean {
    const now = Date.now();
    // FLAG: A later open/reclose cannot revive an older message. The original five-minute
    // deadline and night session survive retries and executor changes.
    if (
      sourceAt > now + DUPLICATE_EVENT_MAX_FUTURE_SKEW_MS ||
      now >= sourceAt + 5 * 60_000 ||
      (settings.chat.chatControlOrderAt && settings.chat.chatControlOrderAt.getTime() > sourceAt)
    )
      return false;
    const metadata = record(reason.metadata);
    if (reason.ruleCode === 'MANUAL_GROUP_CLOSE_DELETE') {
      return (
        resolveManualChatClosure(settings, new Date(now)).active &&
        (settings.nightModeForceCloseForever
          ? metadata.closeMode === 'forever' && metadata.closeUntil === null
          : metadata.closeMode === 'timed' &&
            metadata.closeUntil === settings.nightModeForceCloseUntil &&
            Date.parse(settings.nightModeForceCloseUntil) > now)
      );
    }
    const current = resolveNightModeTransitionSnapshot(settings, new Date(now));
    const original = resolveNightModeTransitionSnapshot(settings, new Date(sourceAt));
    return (
      current?.status === 'closed' &&
      original?.status === 'closed' &&
      current.sessionKey === original.sessionKey &&
      metadata.nightModeTimezone === current.timezone &&
      metadata.nightModeStartTime === formatMinutesAsTime(current.startMinutes) &&
      metadata.nightModeEndTime === formatMinutesAsTime(current.endMinutes)
    );
  }

  private reject(): never {
    throw new ClosedChatDeleteGuardRejectedError('Closed chat deletion is no longer authorized');
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
