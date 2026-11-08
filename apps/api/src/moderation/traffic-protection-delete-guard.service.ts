import {
  prepareDeleteAuthority,
  finalizeDeleteAuthority,
  type DeleteAuthorityPreparation,
} from './moderation-delete-authority-preparation';
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { AutomaticDeleteAuthorAccessService } from '../max/automatic-delete-author-access.service';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../max/max-client.service';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookParser } from '../webhook/webhook.parser';
import { detectMediaFlags } from './moderation-update-extractors';
import { ParticipantModerationImmunityService } from './participant-moderation-immunity.service';
import { DUPLICATE_EVENT_MAX_FUTURE_SKEW_MS } from './duplicate-state';
import { MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES } from './moderation.service.support';
import {
  fingerprintTrafficSource,
  hasTrafficMedia,
  trafficRuleInterval,
  trafficPolicyEffectiveAtMs,
  TRAFFIC_PROTECTION_DELETE_RULE_CODES,
  TRAFFIC_PROTECTION_MAX_DELETE_AGE_MS,
  type TrafficProtectionRule,
  type TrafficProtectionSettings,
} from './traffic-protection';

export class TrafficProtectionGuardRejectedError extends Error {
  readonly code = 'traffic_protection_delete_no_longer_authorized';
}

@Injectable()
export class TrafficProtectionDeleteGuardService {
  private readonly parser = new WebhookParser();
  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly maxBotLink: MaxBotLinkService,
    private readonly immunity: ParticipantModerationImmunityService,
    private readonly config: ConfigService,
    @Optional() private readonly automaticDeleteAuthorAccess?: AutomaticDeleteAuthorAccessService,
  ) {}

  async assertIntentStillActionable(params: {
    intentId: string;
    chatId: string;
    messageId: string;
    subjectUserId: string | null;
    botId?: string;
    ownedReasonsOnly?: boolean;
    includeDeadlinePermit?: boolean;
  }): Promise<'allowed' | 'absent' | 'not_applicable' | { deadlineAtMs: number }> {
    return finalizeDeleteAuthority(await this.prepareForDispatch(params));
  }

  async prepareForDispatch(
    params: Parameters<TrafficProtectionDeleteGuardService['assertIntentStillActionable']>[0],
  ): Promise<
    DeleteAuthorityPreparation<
      Awaited<ReturnType<TrafficProtectionDeleteGuardService['assertIntentStillActionable']>>
    >
  > {
    const allReasons = await this.prisma.moderationDeleteIntentReason.findMany({
      where: { intentId: params.intentId },
      select: { ruleCode: true, metadata: true },
    });
    const reasons = params.ownedReasonsOnly
      ? allReasons.filter((reason) => TRAFFIC_PROTECTION_DELETE_RULE_CODES.has(reason.ruleCode))
      : allReasons;
    // FLAG: Independently authorized reasons retain their own guards. Turning off
    // slow mode must not suppress a separate stop-word or other durable deletion.
    if (
      !reasons.length ||
      reasons.some((reason) => !TRAFFIC_PROTECTION_DELETE_RULE_CODES.has(reason.ruleCode))
    )
      return 'not_applicable';
    const userId = params.subjectUserId;
    if (!userId || this.maxBotLink.isKnownBotUserId(userId)) this.reject();
    const settings = await this.load(params.chatId, userId);
    const viableReasons = reasons.filter((reason) => this.matchesPolicy(reason, settings));
    if (!viableReasons.length) this.reject();
    const options = {
      botId: params.botId,
      bypassCache: true,
      trafficClass: 'critical' as const,
      actionHealthLane: 'critical' as const,
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      ignoreFailureMetricStatuses: MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES,
      timeoutMs: this.config.get<number>('MODERATION_DELETE_INTENT_TIMEOUT_MS') ?? 5000,
    };
    const author = await this.automaticDeleteAuthorAccess?.resolve(params.chatId, userId, options, {
      requireMembership: true,
    });
    const access = author
      ? author.member
      : await this.maxClient.getChatMemberAccess(params.chatId, userId, options);
    if (!access || (author?.isAdmin ?? Boolean(access.isAdmin || access.isOwner))) this.reject();
    if (access.userId !== null && access.userId !== userId)
      throw new Error('Traffic protection author access unavailable');
    const row = await this.maxClient.getExactMessageRow(params.chatId, params.messageId, options);
    if (!row) return 'absent';
    const update = this.parser.parse({
      type: 'message_created',
      updateId: 'traffic-delete-guard',
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
    const media = detectMediaFlags(update);
    const fingerprint = fingerprintTrafficSource(message.text, media);
    const matching = viableReasons.filter((reason) => {
      const metadata = record(reason.metadata);
      return (
        metadata.trafficSourceSha256 === fingerprint &&
        (reason.ruleCode !== 'STICKER_BLOCKED_DELETE' || media.hasStickerAttachment) &&
        (reason.ruleCode !== 'MEDIA_RATE_LIMIT_DELETE' || hasTrafficMedia(media))
      );
    });
    if (!matching.length) this.reject();
    if (
      (await this.immunity.consumeForMessage({
        chatId: params.chatId,
        userId,
        messageId: params.messageId,
        scope: 'traffic-protection:v1',
        nightModeTimezone: settings.nightModeTimezone,
      })) === 'granted'
    )
      this.reject();
    return prepareDeleteAuthority(async () => {
      const finalSettings = await this.load(params.chatId, userId);
      const stillMatching = matching.filter((reason) => this.matchesPolicy(reason, finalSettings));
      if (!stillMatching.length) this.reject();
      if (params.includeDeadlinePermit) {
        return {
          deadlineAtMs: Math.max(
            ...stillMatching.map((reason) => record(reason.metadata).trafficDeadlineAtMs as number),
          ),
        };
      }
      return 'allowed';
    });
  }

  private matchesPolicy(
    reason: { ruleCode: string; metadata: unknown },
    settings: TrafficProtectionSettings,
  ): boolean {
    const data = record(reason.metadata);
    const interval = trafficRuleInterval(
      reason.ruleCode.slice(0, -7) as TrafficProtectionRule,
      settings,
    );
    const occurredAt = data.trafficEventTimestampMs;
    const deadline = data.trafficDeadlineAtMs;
    return (
      data.trafficPolicyVersion === 1 &&
      data.trafficPolicyRevision === settings.trafficPolicyRevision &&
      interval !== null &&
      interval === data.trafficIntervalSeconds &&
      typeof occurredAt === 'number' &&
      Number.isSafeInteger(occurredAt) &&
      occurredAt > 0 &&
      occurredAt >= trafficPolicyEffectiveAtMs(settings.trafficPolicyEffectiveAt) &&
      occurredAt - Date.now() <= DUPLICATE_EVENT_MAX_FUTURE_SKEW_MS &&
      typeof deadline === 'number' &&
      deadline === occurredAt + Math.min(interval * 1000, TRAFFIC_PROTECTION_MAX_DELETE_AGE_MS) &&
      Date.now() < deadline &&
      data.messageDisposition === 'DELETE' &&
      data.userSanction === 'NONE'
    );
  }

  private async load(chatId: string, userId: string) {
    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId },
      select: {
        slowModeEnabled: true,
        slowModeIntervalSeconds: true,
        mediaMessageCooldownEnabled: true,
        mediaMessageCooldownSeconds: true,
        stickerMessagesEnabled: true,
        trafficPolicyRevision: true,
        trafficPolicyEffectiveAt: true,
        nightModeTimezone: true,
        chat: { select: { entityType: true, admins: { select: { userId: true } } } },
      },
    });
    if (
      !settings ||
      settings.chat.entityType !== 'CHAT' ||
      settings.chat.admins.some((admin) => admin.userId === userId)
    )
      this.reject();
    return settings;
  }

  private reject(): never {
    throw new TrafficProtectionGuardRejectedError(
      'Traffic protection deletion is no longer authorized',
    );
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
