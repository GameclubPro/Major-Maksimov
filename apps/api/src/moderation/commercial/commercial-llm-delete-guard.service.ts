import {
  prepareDeleteAuthority,
  finalizeDeleteAuthority,
  isPreparedDeleteAuthority,
  type DeleteAuthorityPreparation,
} from '../moderation-delete-authority-preparation';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../../max/max-client.service';
import { MaxBotLinkService } from '../../max/max-bot-link.service';
import { WebhookParser } from '../../webhook/webhook.parser';
import { ParticipantModerationImmunityService } from '../participant-moderation-immunity.service';
import { MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES } from '../moderation.service.support';
import { CommercialLlmEnforcementService } from './commercial-llm-enforcement.service';
import {
  fingerprintCommercialDeleteSettings,
  fingerprintCommercialDeleteText,
} from './commercial-delete-binding';
import {
  commercialLlmSourceSchema,
  commercialLlmSourceCurrent,
  commercialLlmSourceKey,
  COMMERCIAL_LLM_DELETE_RULE_CODE,
  type CommercialLlmSource,
} from './commercial-llm-enforcement.protocol';

export class CommercialLlmGuardRejectedError extends Error {
  readonly code = 'commercial_ai_delete_no_longer_authorized';
  constructor() {
    super('Commercial AI delete authority expired or changed');
  }
}
const reject = (): never => {
  throw new CommercialLlmGuardRejectedError();
};
type Reason = { ruleCode: string; reasonKey: string; metadata: unknown };
type AuthorizationInput = {
  chatId: string;
  messageId: string;
  subjectUserId: string | null;
  botId: string;
  reasons: readonly Reason[];
};
type Authorization = 'absent' | { deadlineAtMs: number; reasonKeys: string[] };

@Injectable()
export class CommercialLlmDeleteGuardService {
  private readonly parser = new WebhookParser();
  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly maxBotLink: MaxBotLinkService,
    private readonly immunity: ParticipantModerationImmunityService,
    private readonly config: ConfigService,
    private readonly admission: CommercialLlmEnforcementService,
  ) {}

  async authorize(params: AuthorizationInput): Promise<Authorization> {
    try {
      return await finalizeDeleteAuthority(await this.prepareForDispatch(params));
    } catch {
      // FLAG: An unavailable optional AI proof rejects only AI authority. Independent
      // reasons must still pass their own guards without inheriting this dependency failure.
      return reject();
    }
  }

  async prepareForDispatch(
    params: AuthorizationInput,
  ): Promise<DeleteAuthorityPreparation<Authorization>> {
    try {
      const preparation = await this.prepareFresh(params);
      if (!isPreparedDeleteAuthority(preparation)) return preparation;
      return prepareDeleteAuthority(async (finalizeNested) => {
        try {
          return await finalizeNested(preparation);
        } catch {
          return reject();
        }
      });
    } catch {
      return reject();
    }
  }

  private async prepareFresh(
    params: AuthorizationInput,
  ): Promise<DeleteAuthorityPreparation<Authorization>> {
    if (
      !this.admission.enabled() ||
      !params.subjectUserId ||
      this.maxBotLink.isKnownBotUserId(params.subjectUserId)
    )
      reject();
    const selected = params.reasons.filter(
      (reason) => reason.ruleCode === COMMERCIAL_LLM_DELETE_RULE_CODE,
    );
    if (!selected.length || selected.length > 64) reject();
    const sources = selected.map((reason) => {
      const metadata =
        reason.metadata && typeof reason.metadata === 'object' && !Array.isArray(reason.metadata)
          ? (reason.metadata as Record<string, unknown>)
          : {};
      const source = commercialLlmSourceSchema.safeParse(metadata.commercialLlmSource);
      if (
        !source.success ||
        reason.reasonKey !==
          `${COMMERCIAL_LLM_DELETE_RULE_CODE}:${commercialLlmSourceKey(source.data)}`
      )
        return reject();
      return source.data;
    });
    const latest = Math.max(...sources.map((source) => source.eventAtMs));
    const candidates = sources.filter((source) => source.eventAtMs === latest);
    const source = candidates[0]!;
    if (
      candidates.some(
        (candidate) =>
          candidate.sourceSha256 !== source.sourceSha256 ||
          candidate.settingsSha256 !== source.settingsSha256,
      ) ||
      source.chatId !== params.chatId ||
      source.messageId !== params.messageId ||
      source.userId !== params.subjectUserId ||
      !commercialLlmSourceCurrent(source)
    )
      reject();
    await this.currentSettings(source);
    const options = {
      botId: params.botId,
      bypassCache: true,
      trafficClass: 'critical' as const,
      actionHealthLane: 'critical' as const,
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      ignoreFailureMetricStatuses: MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES,
      timeoutMs: this.config.get<number>('MODERATION_DELETE_INTENT_TIMEOUT_MS') ?? 5000,
    };
    const access = await this.maxClient.getChatMemberAccess(
      params.chatId,
      params.subjectUserId!,
      options,
    );
    // FLAG: Unknown rights never authorize an AI decision; departure is a skip in this new mode.
    if (
      !access ||
      access.userId !== params.subjectUserId ||
      access.isAdmin !== false ||
      access.isOwner !== false
    )
      reject();
    const row = await this.maxClient.getExactMessageRow(params.chatId, params.messageId, options);
    if (!row) return 'absent';
    const message = this.parser.parse({
      type: 'message_created',
      updateId: 'commercial-ai-guard',
      message: row,
    }).message;
    if (
      !message ||
      message.chatId !== params.chatId ||
      message.messageId !== params.messageId ||
      message.senderId !== params.subjectUserId ||
      message.entityType === 'channel' ||
      fingerprintCommercialDeleteText(message.text) !== source.sourceSha256
    )
      reject();
    // FLAG: Remote source/access reads can outlive AI authority. Revalidate before
    // spending the logical message's daily protection; final dispatch checks still apply.
    const settings = await this.currentSettings(source);
    if (
      (await this.immunity.consumeForMessage({
        chatId: params.chatId,
        userId: params.subjectUserId!,
        messageId: params.messageId,
        scope: 'commercial-ai-delete:v1',
        nightModeTimezone: settings.nightModeTimezone,
      })) === 'granted'
    )
      reject();
    // FLAG: Recheck after all remote work. A cached model answer cannot override a changed
    // policy, expiry, immune author or missing proof at the actual DELETE attempt.
    return prepareDeleteAuthority(async () => {
      await this.currentSettings(source);
      return {
        deadlineAtMs: source.deadlineAtMs,
        reasonKeys: selected
          .filter((_, index) => sources[index] === source)
          .map((reason) => reason.reasonKey),
      };
    });
  }

  private async currentSettings(source: CommercialLlmSource) {
    if (!this.admission.enabled() || !commercialLlmSourceCurrent(source)) reject();
    const settings = await this.settings(source.chatId, source.userId);
    if (
      fingerprintCommercialDeleteSettings(settings) !== source.settingsSha256 ||
      !(await this.admission.hasProof(source)) ||
      !this.admission.enabled() ||
      !commercialLlmSourceCurrent(source)
    )
      reject();
    return settings;
  }

  private async settings(chatId: string, userId: string) {
    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId },
      select: {
        commercialAdsFilterEnabled: true,
        commercialAdsSensitivity: true,
        commercialAdsWarnThreshold: true,
        commercialAdsDeleteThreshold: true,
        nightModeTimezone: true,
        textFiltersWarnEnabled: true,
        textFiltersMuteEnabled: true,
        textFiltersBanEnabled: true,
        textFiltersMuteDurationHours: true,
        textFiltersBotMessageEnabled: true,
        chat: { select: { entityType: true, admins: { select: { userId: true } } } },
      },
    });
    if (
      !settings?.commercialAdsFilterEnabled ||
      settings.chat.entityType !== 'CHAT' ||
      settings.chat.admins.some((admin) => admin.userId === userId)
    )
      return reject();
    return settings;
  }
}
