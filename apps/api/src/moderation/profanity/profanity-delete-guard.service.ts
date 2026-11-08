import {
  prepareDeleteAuthority,
  finalizeDeleteAuthority,
  type DeleteAuthorityPreparation,
} from '../moderation-delete-authority-preparation';
import type { MaxUpdate } from '@maxim/contracts';
import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { MaxBotLinkService } from '../../max/max-bot-link.service';
import { AutomaticDeleteAuthorAccessService } from '../../max/automatic-delete-author-access.service';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../../max/max-client.service';
import { PrismaService } from '../../prisma/prisma.service';
import { WebhookParser } from '../../webhook/webhook.parser';
import { ParticipantModerationImmunityService } from '../participant-moderation-immunity.service';
import { RuleEngineService } from '../rule-engine.service';
import { MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES } from '../moderation.service.support';

export const PROFANITY_DELETE_RULE_CODE = 'PROFANITY_DELETE';
const PROFANITY_PARTICIPANT_IMMUNITY_SCOPE = 'profanity-delete:v1';

export class ProfanityDeleteGuardRejectedError extends Error {
  constructor(
    readonly code:
      | 'profanity_settings_disabled'
      | 'profanity_author_immune'
      | 'profanity_author_not_member'
      | 'profanity_message_identity_changed'
      | 'profanity_violation_no_longer_present',
    message: string,
  ) {
    super(message);
    this.name = 'ProfanityDeleteGuardRejectedError';
  }
}

type ProfanityDeleteGuardInput = {
  chatId: string;
  messageId: string;
  subjectUserId: string | null;
  botId?: string;
  minimumScore?: number;
  beforeFinalAuthority?: () => Promise<void>;
};

@Injectable()
export class ProfanityDeleteGuardService {
  private readonly parser = new WebhookParser();
  private readonly timeoutMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly maxBotLinkService: MaxBotLinkService,
    private readonly participantImmunity: ParticipantModerationImmunityService,
    private readonly ruleEngine: RuleEngineService,
    configService: ConfigService,
    @Optional() private readonly automaticDeleteAuthorAccess?: AutomaticDeleteAuthorAccessService,
  ) {
    this.timeoutMs = configService.get<number>('MODERATION_DELETE_INTENT_TIMEOUT_MS') ?? 5_000;
  }

  async assertIntentStillActionable(
    params: ProfanityDeleteGuardInput & { intentId: string; ownedReasonsOnly?: boolean },
  ): Promise<'allowed' | 'absent' | 'not_applicable' | 'missing_reason'> {
    return finalizeDeleteAuthority(
      await this.prepareForDispatch(params),
      params.beforeFinalAuthority,
    );
  }

  async prepareForDispatch(
    params: Parameters<ProfanityDeleteGuardService['assertIntentStillActionable']>[0],
  ): Promise<
    DeleteAuthorityPreparation<
      Awaited<ReturnType<ProfanityDeleteGuardService['assertIntentStillActionable']>>
    >
  > {
    const allReasons = await this.prisma.moderationDeleteIntentReason.findMany({
      where: { intentId: params.intentId },
      select: { ruleCode: true, score: true },
    });
    const reasons = params.ownedReasonsOnly
      ? allReasons.filter((reason) => reason.ruleCode === PROFANITY_DELETE_RULE_CODE)
      : allReasons;
    if (params.ownedReasonsOnly && !reasons.length) return 'not_applicable';
    // FLAG: Only profanity-owned deletion is fenced here. Independent durable reasons retain
    // their existing policy, including when a writer adds one after the intent was claimed.
    if (reasons.length === 0) {
      return 'missing_reason';
    }
    if (reasons.some((reason) => reason.ruleCode !== PROFANITY_DELETE_RULE_CODE)) {
      return 'not_applicable';
    }
    return this.prepareMessageForDispatch({
      ...params,
      minimumScore: Math.max(...reasons.map((reason) => reason.score)),
    });
  }

  async assertMessageStillActionable(
    params: ProfanityDeleteGuardInput,
  ): Promise<'allowed' | 'absent'> {
    return finalizeDeleteAuthority(
      await this.prepareMessageForDispatch(params),
      params.beforeFinalAuthority,
    );
  }

  async prepareMessageForDispatch(
    params: Parameters<ProfanityDeleteGuardService['assertMessageStillActionable']>[0],
  ): Promise<
    DeleteAuthorityPreparation<
      Awaited<ReturnType<ProfanityDeleteGuardService['assertMessageStillActionable']>>
    >
  > {
    const senderId = params.subjectUserId;
    if (!senderId) {
      throw new ProfanityDeleteGuardRejectedError(
        'profanity_message_identity_changed',
        'Profanity deletion no longer identifies its message author',
      );
    }
    if (this.maxBotLinkService.isKnownBotUserId(senderId)) {
      throw new ProfanityDeleteGuardRejectedError(
        'profanity_author_immune',
        'Configured bot messages are exempt from profanity deletion',
      );
    }
    const settings = await this.loadSettings(params.chatId, senderId);
    const requestOptions = {
      botId: params.botId,
      bypassCache: true,
      trafficClass: 'critical' as const,
      actionHealthLane: 'critical' as const,
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      ignoreFailureMetricStatuses: MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES,
      timeoutMs: this.timeoutMs,
    };
    const author = await this.automaticDeleteAuthorAccess?.resolve(
      params.chatId,
      senderId,
      requestOptions,
      { requireMembership: true, module: 'profanity' },
    );
    const access = author
      ? author.member
      : await this.maxClient.getChatMemberAccess(params.chatId, senderId, requestOptions);
    if (author?.isAdmin) {
      throw new ProfanityDeleteGuardRejectedError(
        'profanity_author_immune',
        'Saved chat administrators are exempt from profanity deletion',
      );
    }
    // FLAG: A complete roster decides role immunity, never current membership. A real absent
    // member still cancels without sanctions; transport/malformed errors retain their retry.
    if (!access) {
      throw new ProfanityDeleteGuardRejectedError(
        'profanity_author_not_member',
        'Profanity deletion author is no longer a chat member',
      );
    }
    if (access.userId !== null && access.userId !== senderId) {
      throw new Error('Profanity deletion author access is unavailable');
    }
    if (author?.isAdmin ?? Boolean(access.isAdmin || access.isOwner)) {
      throw new ProfanityDeleteGuardRejectedError(
        'profanity_author_immune',
        'Current chat administrators are exempt from profanity deletion',
      );
    }

    // FLAG: Webhook text and old decision metadata cannot authorize a delayed DELETE. Read one
    // exact current message per transport attempt; never persist or log the returned plaintext.
    const exactRow = await this.maxClient.getExactMessageRow(
      params.chatId,
      params.messageId,
      requestOptions,
    );
    if (!exactRow) {
      return 'absent';
    }
    let message: MaxUpdate['message'];
    try {
      message = this.parser.parse({
        type: 'message_created',
        updateId: 'profanity-delete-guard',
        message: exactRow,
      }).message;
    } catch {
      throw new Error('Profanity deletion exact message could not be verified');
    }
    if (
      !message ||
      message.chatId !== params.chatId ||
      message.messageId !== params.messageId ||
      message.senderId !== senderId ||
      message.entityType === 'channel'
    ) {
      throw new ProfanityDeleteGuardRejectedError(
        'profanity_message_identity_changed',
        'Exact message identity no longer matches the profanity deletion',
      );
    }
    const decision = this.ruleEngine.detectProfanityForSettings(message.text, settings);
    // FLAG: An edited mild insult must not inherit a stronger stored decision's sanctions.
    if (!decision || decision.score < (params.minimumScore ?? 0)) {
      throw new ProfanityDeleteGuardRejectedError(
        'profanity_violation_no_longer_present',
        'Current message text no longer violates the profanity policy',
      );
    }
    const immunity = await this.participantImmunity.consumeForMessage({
      chatId: params.chatId,
      userId: senderId,
      messageId: params.messageId,
      scope: PROFANITY_PARTICIPANT_IMMUNITY_SCOPE,
      nightModeTimezone: settings.nightModeTimezone,
    });
    if (immunity === 'granted') {
      throw new ProfanityDeleteGuardRejectedError(
        'profanity_author_immune',
        'Message author has active participant moderation immunity',
      );
    }

    return prepareDeleteAuthority(async () => {
      const finalSettings = await this.loadSettings(params.chatId, senderId);
      const finalDecision = this.ruleEngine.detectProfanityForSettings(message.text, finalSettings);
      if (!finalDecision || finalDecision.score < (params.minimumScore ?? 0)) {
        throw new ProfanityDeleteGuardRejectedError(
          'profanity_violation_no_longer_present',
          'Profanity policy no longer authorizes the deletion',
        );
      }
      return 'allowed' as const;
    });
  }

  private async loadSettings(chatId: string, senderId: string) {
    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId },
      select: {
        russianProfanityFilterEnabled: true,
        profanitySensitivity: true,
        nightModeTimezone: true,
        chat: { select: { entityType: true, admins: { select: { userId: true } } } },
      },
    });
    if (!settings?.russianProfanityFilterEnabled || settings.chat.entityType !== 'CHAT') {
      throw new ProfanityDeleteGuardRejectedError(
        'profanity_settings_disabled',
        'Profanity deletion is no longer enabled for this chat',
      );
    }
    if (settings.chat.admins.some((admin) => admin.userId === senderId)) {
      throw new ProfanityDeleteGuardRejectedError(
        'profanity_author_immune',
        'Current chat administrators are exempt from profanity deletion',
      );
    }
    return settings;
  }
}
