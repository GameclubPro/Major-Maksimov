import {
  resolveNightModeTransitionSessionAliases,
  type NightModeTransitionKind,
} from './night-mode-transition-time.util';
import { withMarketplaceModerationMessage } from '../max/marketplace-publication-button';
import { Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import {
  MAX_MESSAGE_TEXT_LENGTH,
  prepareFormattedTextForMaxDelivery,
} from '../common/max-markdown.util';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  type MaxActionDispatchOptions,
  type MaxSendMessageOptions,
} from '../max/max-client.service';
import { buildNightModeNoticeIdempotencyKey } from '../max/max-action-idempotency.util';
import { MaxActionLedgerService } from '../max/max-action-ledger.service';
import {
  wasMaxPreDispatchGuardRejected,
  withMaxFinalAuthorityCheckpoint,
} from '../max/max-action-pre-dispatch-guard';
import {
  ManagedEntityAccessLossService,
  classifyMaxTerminalChatActionError,
  resolveManagedEntityAccessLossReason,
} from '../max/managed-entity-access-loss.service';
import { MaxRoutedPublicationService } from '../max/max-routed-publication.service';
import {
  buildNightModeClosedNoticeForDelivery,
  buildNightModeOpenedNoticeForDelivery,
  type NightModeBotSpeechProfile,
} from './night-mode-transition-notice.util';
import {
  NIGHT_MODE_TRANSITION_PROCESS_CONTINUE,
  NIGHT_MODE_TRANSITION_PROCESS_STOP,
  NightModeRecoveryUnsafeError,
  type NightModeStickyRouteProbe,
  type NightModeTransitionProcessResult,
  type NightModeTransitionRecoveryObligation,
} from './night-mode-transition.queue';
import type {
  NightModeRecoveredCloseNoticeEvent,
  NightModeRecoverCloseNoticeEventFromLedgerParams,
  NightModeRecoverCloseNoticeEventParams,
  NightModeTransitionNoticeResult,
  NightModeTransitionRuntimeHooks,
  NightModeTransitionRuntimeSettings,
} from './night-mode-transition-runtime.service';
import { BotSpeechMediaService } from './bot-speech-media.service';
import {
  NightModeTransitionEventService,
  type NightModeTransitionEventParams,
} from './night-mode-transition-event.service';
import { NightModeTransitionNoticeEventPersistenceError } from './night-mode-transition-notice-persistence-error';
import { NightModeTransitionStaleStateError } from './night-mode-transition-stale-state-error';
import { ModerationDeleteIntentService } from './moderation-delete-intent.service';
import { NightModeRouteVerificationService } from './night-mode-route-verification.service';
import { NightModeTransitionSchedulerService } from './night-mode-transition-scheduler.service';
import {
  NIGHT_MODE_CLOSE_NOTICE_CLEANUP_RULE_CODE,
  type NightModeCloseNoticeCleanupBinding,
} from './night-mode-close-notice-cleanup-binding';

export type NightModeTransitionDeliveryOperation =
  | 'send-close-notice'
  | 'send-open-notice'
  | 'delete-close-notice';

export type NightModeTransitionDeliverySnapshot = {
  startMinutes: number;
  endMinutes: number;
  timezone: string;
  sessionKey: string;
  stickyRouteProbe?: NightModeStickyRouteProbe;
};

export type NightModeTransitionDeliveryAdapters = {
  getBotSpeechProfile(botId?: string | null): NightModeBotSpeechProfile;
  buildClosedNoticeOptions(
    settings: NightModeTransitionRuntimeSettings,
  ): MaxSendMessageOptions | null;
  resolveBotId(chatId: string): Promise<string | null>;
};

@Injectable()
export class NightModeTransitionDeliveryService {
  private readonly logger = new Logger(NightModeTransitionDeliveryService.name);

  constructor(
    private readonly maxClient: MaxClientService,
    private readonly botSpeechMediaService: BotSpeechMediaService,
    private readonly nightModeTransitionEventService: NightModeTransitionEventService,
    @Optional()
    private readonly managedEntityAccessLossService?: ManagedEntityAccessLossService,
    @Optional()
    private readonly maxRoutedPublicationService?: MaxRoutedPublicationService,
    @Optional()
    private readonly moderationDeleteIntentService?: ModerationDeleteIntentService,
    @Optional()
    private readonly maxActionLedgerService?: MaxActionLedgerService,
    @Optional()
    private readonly nightModeRouteVerificationService?: NightModeRouteVerificationService,
    @Optional()
    private readonly nightModeTransitionScheduler?: NightModeTransitionSchedulerService,
  ) {}

  createHooks(adapters: NightModeTransitionDeliveryAdapters): NightModeTransitionRuntimeHooks {
    return {
      recoverClosedNoticeEvent: (params) => this.recoverClosedNoticeEvent(params),
      recoverClosedNoticeEventFromLedger: (params) =>
        this.recoverClosedNoticeEventFromLedger(params),
      recoverOpenedNoticeEvent: (params) => this.recoverOpenedNoticeEvent(params),
      recoverOpenedNoticeEventFromLedger: (params) =>
        this.recoverOpenedNoticeEventFromLedger(params),
      scheduleRecoveryObligation: (chatId, recovery) =>
        this.scheduleRecoveryObligation(chatId, recovery),
      sendClosedNotice: (settings, snapshot, validateBeforeDispatch) =>
        this.sendClosedNotice(settings, snapshot, adapters, validateBeforeDispatch),
      sendOpenedNotice: (settings, snapshot, validateBeforeDispatch) =>
        this.sendOpenedNotice(settings, snapshot, adapters, validateBeforeDispatch),
      deleteClosedNotice: (chatId, messageId, originBotId, binding, validateBeforeDispatch) =>
        this.deleteClosedNotice(
          chatId,
          messageId,
          originBotId,
          binding,
          adapters,
          validateBeforeDispatch,
        ),
    };
  }

  async scheduleRecoveryObligation(
    chatId: string,
    recovery: NightModeTransitionRecoveryObligation,
  ): Promise<void> {
    if (!this.nightModeTransitionScheduler) {
      throw new ServiceUnavailableException('Night mode durable recovery scheduler is unavailable');
    }
    await this.nightModeTransitionScheduler.scheduleRecoveryObligation(chatId, recovery);
  }

  async recoverOpenedNoticeEvent(
    params: NightModeRecoverCloseNoticeEventParams,
  ): Promise<NightModeRecoveredCloseNoticeEvent> {
    return this.recoverOpenedNoticeEventFromLedger(params, params);
  }

  async recoverOpenedNoticeEventFromLedger(
    params: NightModeRecoverCloseNoticeEventFromLedgerParams,
    exactReceipt: Pick<NightModeRecoverCloseNoticeEventParams, 'messageId' | 'botId'>,
  ): Promise<NightModeRecoveredCloseNoticeEvent>;
  async recoverOpenedNoticeEventFromLedger(
    params: NightModeRecoverCloseNoticeEventFromLedgerParams,
  ): Promise<NightModeRecoveredCloseNoticeEvent | null>;
  async recoverOpenedNoticeEventFromLedger(
    params: NightModeRecoverCloseNoticeEventFromLedgerParams,
    exactReceipt?: Pick<NightModeRecoverCloseNoticeEventParams, 'messageId' | 'botId'>,
  ): Promise<NightModeRecoveredCloseNoticeEvent | null> {
    const expectedJobId = buildNightModeNoticeIdempotencyKey(
      'open',
      params.chatId,
      params.sessionKey,
    );
    if (!this.maxActionLedgerService) {
      throw new ServiceUnavailableException(
        `Night mode open-event recovery ledger is unavailable (${expectedJobId})`,
      );
    }
    const proof =
      await this.maxActionLedgerService.inspectCompletedNightModeOpenNoticeDispatch(params);
    if (proof.kind === 'missing' && !exactReceipt) {
      return null;
    }
    // FLAG: Event recovery settles only this accepted opening receipt. It never dispatches SEND,
    // and neither a CLOSE receipt nor a mismatched bot/message can authorize the event.
    if (
      proof.kind !== 'completed' ||
      proof.jobId !== expectedJobId ||
      (exactReceipt &&
        (proof.remoteMessageId !== exactReceipt.messageId ||
          proof.dispatchBotId !== exactReceipt.botId))
    ) {
      throw new ServiceUnavailableException(
        `Exact completed night mode open send is not proven (${expectedJobId})`,
      );
    }
    const event = await this.nightModeTransitionEventService.ensureTransitionEvent({
      ...params,
      ruleCode: 'NIGHT_MODE_OPEN_NOTICE',
      messageId: proof.remoteMessageId,
      botId: proof.dispatchBotId,
    });
    return {
      eventId: event.id,
      sessionKey: params.sessionKey,
      messageId: proof.remoteMessageId,
      botId: proof.dispatchBotId,
    };
  }

  async recoverClosedNoticeEvent(
    params: NightModeRecoverCloseNoticeEventParams,
  ): Promise<NightModeRecoveredCloseNoticeEvent> {
    const expectedJobId = buildNightModeNoticeIdempotencyKey(
      'close',
      params.chatId,
      params.sessionKey,
    );
    if (
      !this.maxActionLedgerService ||
      typeof this.maxActionLedgerService.getExactCompletedNightModeCloseNoticeDispatch !==
        'function'
    ) {
      throw new ServiceUnavailableException(
        `Night mode close-event recovery ledger is unavailable (${expectedJobId})`,
      );
    }

    const proof = await this.maxActionLedgerService.getExactCompletedNightModeCloseNoticeDispatch({
      chatId: params.chatId,
      sessionKey: params.sessionKey,
      messageId: params.messageId,
      dispatchBotId: params.botId,
    });
    if (!proof || proof.jobId !== expectedJobId) {
      throw new ServiceUnavailableException(
        `Exact completed night mode close send is not proven (${expectedJobId})`,
      );
    }

    return this.ensureRecoveredCloseNoticeEvent(params, proof);
  }

  async recoverClosedNoticeEventFromLedger(
    params: NightModeRecoverCloseNoticeEventFromLedgerParams,
  ): Promise<NightModeRecoveredCloseNoticeEvent | null> {
    const expectedJobId = buildNightModeNoticeIdempotencyKey(
      'close',
      params.chatId,
      params.sessionKey,
    );
    if (
      !this.maxActionLedgerService ||
      typeof this.maxActionLedgerService.inspectCompletedNightModeCloseNoticeDispatch !== 'function'
    ) {
      throw new ServiceUnavailableException(
        `Night mode close-event recovery ledger is unavailable (${expectedJobId})`,
      );
    }

    const lookup =
      await this.maxActionLedgerService.inspectCompletedNightModeCloseNoticeDispatch(params);
    if (lookup.kind === 'missing') {
      return null;
    }
    if (lookup.kind !== 'completed' || lookup.jobId !== expectedJobId) {
      throw new NightModeRecoveryUnsafeError(
        `Night mode close send ledger provenance is unsafe (${expectedJobId})`,
      );
    }
    return this.ensureRecoveredCloseNoticeEvent(params, lookup);
  }

  private async ensureRecoveredCloseNoticeEvent(
    params: NightModeRecoverCloseNoticeEventFromLedgerParams,
    proof: {
      remoteMessageId: string;
      dispatchBotId: string;
      completedAt: Date;
      routeHalfOpenProbe: boolean;
    },
  ): Promise<NightModeRecoveredCloseNoticeEvent> {
    if (proof.routeHalfOpenProbe) {
      await this.scheduleCloseRouteVerification({
        chatId: params.chatId,
        sessionKey: params.sessionKey,
        messageId: proof.remoteMessageId,
        botId: proof.dispatchBotId,
        sentAt: proof.completedAt,
      });
    }
    const event = await this.nightModeTransitionEventService.ensureTransitionEvent({
      chatId: params.chatId,
      messageId: proof.remoteMessageId,
      botId: proof.dispatchBotId,
      ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
      sessionKey: params.sessionKey,
      timezone: params.timezone,
      startMinutes: params.startMinutes,
      endMinutes: params.endMinutes,
    });
    return {
      eventId: event.id,
      sessionKey: params.sessionKey,
      messageId: proof.remoteMessageId,
      botId: proof.dispatchBotId,
    };
  }

  async sendClosedNotice(
    settings: NightModeTransitionRuntimeSettings,
    snapshot: NightModeTransitionDeliverySnapshot,
    adapters: NightModeTransitionDeliveryAdapters,
    validateBeforeDispatch?: () => Promise<boolean>,
  ): Promise<NightModeTransitionNoticeResult> {
    const buildMessageText = (botId?: string | null) =>
      buildNightModeClosedNoticeForDelivery({
        startMinutes: snapshot.startMinutes,
        endMinutes: snapshot.endMinutes,
        timezone: snapshot.timezone,
        templateText: settings.nightModeBotMessageText,
        botSpeechStyle: settings.botSpeechStyle,
        activeBotSpeechProfile: adapters.getBotSpeechProfile(botId),
      });
    const messageOptions = adapters.buildClosedNoticeOptions(settings);
    const canScheduleCloseRouteVerification = this.canScheduleCloseRouteVerification();

    let sent: { messageId: string | null; botId: string | null };
    let attemptedBotId: string | null = null;
    let dispatchAttemptStartedAt: Date | null = null;
    try {
      sent = await this.sendNotice({
        chatId: settings.chatId,
        transition: 'close',
        sessionKey: snapshot.sessionKey,
        logicalIdempotencyKey: buildNightModeNoticeIdempotencyKey(
          'close',
          settings.chatId,
          snapshot.sessionKey,
        ),
        messageText: buildMessageText(),
        resolveMessageText: buildMessageText,
        messageOptions,
        mediaSettings: settings,
        mediaFieldKey: 'nightModeBotMessageText',
        allowHalfOpenProbe: canScheduleCloseRouteVerification,
        stickyRouteProbe: canScheduleCloseRouteVerification ? snapshot.stickyRouteProbe : undefined,
        adapters,
        validateBeforeDispatch,
        onDispatchAttempt: (botId, startedAt) => {
          attemptedBotId = botId;
          dispatchAttemptStartedAt = startedAt;
        },
      });
    } catch (error: unknown) {
      const terminalResult = await this.handleTerminalError({
        chatId: settings.chatId,
        botId: attemptedBotId,
        operation: 'send-close-notice',
        error,
        lifecycleEventAt: dispatchAttemptStartedAt,
      });
      if (terminalResult) {
        return {
          ...terminalResult,
          messageId: null,
          botId: null,
        };
      }
      throw error;
    }

    if (sent.messageId && sent.botId && canScheduleCloseRouteVerification) {
      const proof =
        await this.maxActionLedgerService!.getExactCompletedNightModeCloseNoticeDispatch({
          chatId: settings.chatId,
          sessionKey: snapshot.sessionKey,
          messageId: sent.messageId,
          dispatchBotId: sent.botId,
        });
      if (!proof) {
        throw new ServiceUnavailableException(
          `Exact completed night mode close send is not proven for route verification (${settings.chatId})`,
        );
      }
      if (proof.routeHalfOpenProbe) {
        await this.scheduleCloseRouteVerification({
          chatId: settings.chatId,
          sessionKey: snapshot.sessionKey,
          messageId: proof.remoteMessageId,
          botId: proof.dispatchBotId,
          sentAt: proof.completedAt,
        });
      }
    }
    await this.createEventAfterAcceptedNotice({
      chatId: settings.chatId,
      messageId: sent.messageId,
      botId: sent.botId,
      ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
      sessionKey: snapshot.sessionKey,
      timezone: snapshot.timezone,
      startMinutes: snapshot.startMinutes,
      endMinutes: snapshot.endMinutes,
    });

    return {
      ...NIGHT_MODE_TRANSITION_PROCESS_CONTINUE,
      messageId: sent.messageId,
      botId: sent.botId,
    };
  }

  async sendOpenedNotice(
    settings: Pick<
      NightModeTransitionRuntimeSettings,
      'chatId' | 'nightModeOpenMessageText' | 'botSpeechStyle' | 'botSpeechMedia'
    >,
    snapshot: NightModeTransitionDeliverySnapshot,
    adapters: NightModeTransitionDeliveryAdapters,
    validateBeforeDispatch?: () => Promise<boolean>,
  ): Promise<NightModeTransitionProcessResult> {
    const buildMessageText = (botId?: string | null) =>
      buildNightModeOpenedNoticeForDelivery({
        startMinutes: snapshot.startMinutes,
        endMinutes: snapshot.endMinutes,
        timezone: snapshot.timezone,
        templateText: settings.nightModeOpenMessageText,
        botSpeechStyle: settings.botSpeechStyle,
        activeBotSpeechProfile: adapters.getBotSpeechProfile(botId),
      });
    let sent: { messageId: string | null; botId: string | null };
    let attemptedBotId: string | null = null;
    let dispatchAttemptStartedAt: Date | null = null;
    try {
      sent = await this.sendNotice({
        chatId: settings.chatId,
        transition: 'open',
        sessionKey: snapshot.sessionKey,
        logicalIdempotencyKey: buildNightModeNoticeIdempotencyKey(
          'open',
          settings.chatId,
          snapshot.sessionKey,
        ),
        messageText: buildMessageText(),
        resolveMessageText: buildMessageText,
        messageOptions: undefined,
        mediaSettings: settings,
        mediaFieldKey: 'nightModeOpenMessageText',
        adapters,
        validateBeforeDispatch,
        onDispatchAttempt: (botId, startedAt) => {
          attemptedBotId = botId;
          dispatchAttemptStartedAt = startedAt;
        },
      });
    } catch (error: unknown) {
      const terminalResult = await this.handleTerminalError({
        chatId: settings.chatId,
        botId: attemptedBotId,
        operation: 'send-open-notice',
        error,
        lifecycleEventAt: dispatchAttemptStartedAt,
      });
      if (terminalResult) {
        return terminalResult;
      }
      throw error;
    }

    await this.createEventAfterAcceptedNotice({
      chatId: settings.chatId,
      messageId: sent.messageId,
      botId: sent.botId,
      ruleCode: 'NIGHT_MODE_OPEN_NOTICE',
      sessionKey: snapshot.sessionKey,
      timezone: snapshot.timezone,
      startMinutes: snapshot.startMinutes,
      endMinutes: snapshot.endMinutes,
    });
    return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
  }

  private async sendNotice(params: {
    transition: NightModeTransitionKind;
    sessionKey: string;
    chatId: string;
    logicalIdempotencyKey: string;
    messageText: string;
    resolveMessageText?: (botId: string | null) => string;
    messageOptions: MaxSendMessageOptions | null | undefined;
    mediaSettings: { botSpeechMedia?: unknown };
    mediaFieldKey: 'nightModeBotMessageText' | 'nightModeOpenMessageText';
    allowHalfOpenProbe?: boolean;
    stickyRouteProbe?: NightModeStickyRouteProbe;
    adapters: NightModeTransitionDeliveryAdapters;
    validateBeforeDispatch?: () => Promise<boolean>;
    onDispatchAttempt: (botId: string | null, startedAt: Date) => void;
  }): Promise<{ messageId: string | null; botId: string | null }> {
    const assertNoAlias = async () => {
      if (resolveNightModeTransitionSessionAliases(params.sessionKey).length <= 1) return;
      if (
        !this.maxActionLedgerService ||
        (await this.maxActionLedgerService.hasNightModeAliasSendProvenance(params))
      ) {
        throw new NightModeRecoveryUnsafeError(
          'A merged night session retains another SEND identity',
        );
      }
    };
    await assertNoAlias();
    const sourceTextFormat = params.messageOptions?.textFormat ?? 'markdown';
    const prepareMessage = (text: string) => {
      const prepared = prepareFormattedTextForMaxDelivery(text, sourceTextFormat);
      if (!prepared) {
        throw new Error(
          `MAX night mode notice exceeds ${MAX_MESSAGE_TEXT_LENGTH} characters after formatting`,
        );
      }
      return prepared;
    };
    const baseMessage = prepareMessage(params.messageText);
    const buildMessageOptions = (
      textFormat: MaxSendMessageOptions['textFormat'],
    ): MaxSendMessageOptions =>
      withMarketplaceModerationMessage(
        {
          ...(params.messageOptions ?? {}),
          textFormat,
        },
        params.chatId,
        'MODERATION_NOTICE',
        'NIGHT_MODE',
      );
    const media = this.botSpeechMediaService.resolveMedia(
      params.mediaSettings,
      params.mediaFieldKey,
    );
    if (!this.maxRoutedPublicationService && process.env.NODE_ENV === 'production') {
      throw new ServiceUnavailableException(
        'Routed MAX publication service is required for production night mode notices',
      );
    }
    if (this.maxRoutedPublicationService) {
      return this.maxRoutedPublicationService.publish({
        entityId: params.chatId,
        logicalIdempotencyKey: params.logicalIdempotencyKey,
        text: baseMessage.text,
        options: buildMessageOptions(baseMessage.textFormat),
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.NIGHT_MODE_TRANSITION,
        hydrateMessageUrl: false,
        ignoreFailureMetricStatuses: [403, 404],
        ...(params.allowHalfOpenProbe
          ? { sendRouteHalfOpenProbe: 'publication_exact_verification' as const }
          : {}),
        ...(params.allowHalfOpenProbe && params.stickyRouteProbe
          ? {
              sendRouteStickyProbe: {
                kind: 'future_night_close_v1' as const,
                authorizedAt: params.stickyRouteProbe.authorizedAt,
                failureBefore: params.stickyRouteProbe.scheduledFor,
                sessionKey: params.stickyRouteProbe.sessionKey,
                scheduleFingerprint: params.stickyRouteProbe.scheduleFingerprint,
              },
            }
          : {}),
        prepareAttempt: async ({ botId }) => {
          const message = prepareMessage(params.resolveMessageText?.(botId) ?? params.messageText);
          return {
            text: message.text,
            options: await this.botSpeechMediaService.withMediaOptions(
              buildMessageOptions(message.textFormat),
              media,
              {
                botId,
                sourceTag: MAX_API_SOURCE_TAGS.NIGHT_MODE_TRANSITION,
              },
            ),
          };
        },
        onDispatchAttempt: ({ botId }) => {
          params.onDispatchAttempt(botId, new Date());
        },
        beforeSendMutation: async () => {
          await this.assertCurrentTransitionState(params.chatId, params.validateBeforeDispatch);
          await assertNoAlias();
        },
      });
    }

    const botId = await params.adapters.resolveBotId(params.chatId);
    const message = prepareMessage(params.resolveMessageText?.(botId) ?? params.messageText);
    const messageOptionsWithMedia = await this.botSpeechMediaService.withMediaOptions(
      buildMessageOptions(message.textFormat),
      media,
      { botId, sourceTag: MAX_API_SOURCE_TAGS.NIGHT_MODE_TRANSITION },
    );
    const dispatchAttemptStartedAt = new Date();
    params.onDispatchAttempt(botId, dispatchAttemptStartedAt);
    const sent = await this.maxClient.sendMessage(
      params.chatId,
      message.text,
      messageOptionsWithMedia,
      {
        ...this.buildRequestOptions(botId),
        immediate: true,
        idempotencyKey: params.logicalIdempotencyKey,
        beforeImmediateSendMutation: withMaxFinalAuthorityCheckpoint(async (revalidateRoute) => {
          await revalidateRoute?.();
          await this.assertCurrentTransitionState(params.chatId, params.validateBeforeDispatch);
          await assertNoAlias();
        }),
      },
    );
    if (!sent?.messageId) {
      throw new Error(
        `Immediate MAX night mode publication ${params.logicalIdempotencyKey} completed without a message id`,
      );
    }
    return {
      messageId: sent.messageId,
      botId,
    };
  }

  private async createEvent(params: NightModeTransitionEventParams): Promise<void> {
    await this.nightModeTransitionEventService.createTransitionEvent(params);
  }

  private async createEventAfterAcceptedNotice(
    params: NightModeTransitionEventParams,
  ): Promise<void> {
    try {
      await this.createEvent(params);
    } catch (error: unknown) {
      const messageId = params.messageId?.trim() ?? '';
      if (messageId) {
        throw new NightModeTransitionNoticeEventPersistenceError(
          {
            ...params,
            messageId,
            botId: params.botId?.trim() || null,
          },
          error,
        );
      }
      throw error;
    }
  }

  private canScheduleCloseRouteVerification(): boolean {
    return Boolean(
      this.nightModeRouteVerificationService?.isSchedulingAvailable() &&
      this.maxActionLedgerService &&
      typeof this.maxActionLedgerService.getExactCompletedNightModeCloseNoticeDispatch ===
        'function',
    );
  }

  private async scheduleCloseRouteVerification(params: {
    chatId: string;
    sessionKey: string;
    messageId: string;
    botId: string;
    sentAt: Date;
  }): Promise<void> {
    if (!this.canScheduleCloseRouteVerification()) {
      return;
    }
    await this.nightModeRouteVerificationService!.schedule(params);
  }

  async deleteClosedNotice(
    chatId: string,
    messageId: string,
    originBotId: string | null,
    binding: NightModeCloseNoticeCleanupBinding,
    adapters: NightModeTransitionDeliveryAdapters,
    validateBeforeDispatch?: () => Promise<boolean>,
  ): Promise<NightModeTransitionProcessResult> {
    const persistedOriginBotId = originBotId?.trim() || null;
    if (this.moderationDeleteIntentService && persistedOriginBotId) {
      try {
        await this.assertCurrentTransitionState(chatId, validateBeforeDispatch);
        const intent = await this.moderationDeleteIntentService.ensureIntent({
          chatId,
          messageId,
          reasonKey: NIGHT_MODE_CLOSE_NOTICE_CLEANUP_RULE_CODE,
          ruleCode: NIGHT_MODE_CLOSE_NOTICE_CLEANUP_RULE_CODE,
          entityType: 'CHAT',
          messageAuthorKind: 'bot',
          originBotId: persistedOriginBotId,
          routingPolicy: 'origin_only',
          event: {
            eventType: 'SYSTEM',
            metadata: {
              nightModeCloseNoticeCleanup: binding,
            },
          },
        });
        if (
          intent.rollout === 'execute' ||
          this.moderationDeleteIntentService.getRolloutForChat(chatId) === 'execute'
        ) {
          return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
        }
      } catch (error: unknown) {
        if (error instanceof NightModeTransitionStaleStateError) {
          throw error;
        }
        if (this.moderationDeleteIntentService.getRolloutForChat(chatId) === 'execute') {
          throw error;
        }
        this.logger.warn(
          {
            chatId,
            messageId,
            botId: persistedOriginBotId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to persist shadow night mode close notice delete intent; using legacy delete',
        );
      }
    }

    const botId = persistedOriginBotId ?? (await adapters.resolveBotId(chatId));
    const requestOptions = {
      immediate: true,
      beforeImmediateDeleteMutation: async () => {
        await this.assertCurrentTransitionState(chatId, validateBeforeDispatch);
      },
      ...this.buildRequestOptions(botId),
    };
    let dispatchAttemptStartedAt: Date | null = null;
    try {
      await this.assertCurrentTransitionState(chatId, validateBeforeDispatch);
      dispatchAttemptStartedAt = new Date();
      await this.maxClient.deleteMessage(chatId, messageId, requestOptions);
    } catch (error: unknown) {
      const terminalResult = await this.handleTerminalError({
        chatId,
        botId,
        messageId,
        operation: 'delete-close-notice',
        error,
        lifecycleEventAt: dispatchAttemptStartedAt,
      });
      if (terminalResult) {
        return terminalResult;
      }
      throw error;
    }
    return NIGHT_MODE_TRANSITION_PROCESS_CONTINUE;
  }

  private async assertCurrentTransitionState(
    chatId: string,
    validateBeforeDispatch?: () => Promise<boolean>,
  ): Promise<void> {
    if (validateBeforeDispatch && !(await validateBeforeDispatch())) {
      throw new NightModeTransitionStaleStateError(chatId);
    }
  }

  private async handleTerminalError(params: {
    chatId: string;
    botId: string | null;
    messageId?: string;
    operation: NightModeTransitionDeliveryOperation;
    error: unknown;
    lifecycleEventAt: Date | null;
  }): Promise<NightModeTransitionProcessResult | null> {
    if (wasMaxPreDispatchGuardRejected(params.error)) {
      return null;
    }
    if (this.wasManagedEntityAccessLossRecorded(params.error)) {
      this.logTerminalError(params);
      return NIGHT_MODE_TRANSITION_PROCESS_STOP;
    }
    if (!params.lifecycleEventAt) {
      return null;
    }

    const classification = classifyMaxTerminalChatActionError(params.error);
    if (!classification) {
      return null;
    }

    this.logTerminalError(params);
    const accessLossReason = resolveManagedEntityAccessLossReason(
      this.mapOperation(params.operation),
      classification,
    );
    if (!accessLossReason) {
      return params.operation === 'delete-close-notice' &&
        classification.kind === 'message_not_found'
        ? NIGHT_MODE_TRANSITION_PROCESS_CONTINUE
        : null;
    }

    await this.managedEntityAccessLossService?.recordManagedEntityAccessLost({
      chatId: params.chatId,
      botId: params.botId,
      reason: accessLossReason,
      source: `night_mode_transition:${params.operation}`,
      lastMaxErrorCode: classification.code,
      lastMaxErrorMessage: classification.message,
      lastMaxStatusCode: classification.statusCode,
      lifecycleEventAt: params.lifecycleEventAt,
      lifecycleEventType: 'live_probe',
      lifecycleSource: 'live_probe',
    });
    return NIGHT_MODE_TRANSITION_PROCESS_STOP;
  }

  private wasManagedEntityAccessLossRecorded(error: unknown): boolean {
    return (
      Boolean(error) &&
      typeof error === 'object' &&
      (error as { maxManagedEntityAccessLossRecorded?: unknown })
        .maxManagedEntityAccessLossRecorded === true
    );
  }

  private mapOperation(operation: NightModeTransitionDeliveryOperation): 'send' | 'delete' {
    return operation === 'delete-close-notice' ? 'delete' : 'send';
  }

  private logTerminalError(params: {
    chatId: string;
    messageId?: string;
    operation: NightModeTransitionDeliveryOperation;
    error: unknown;
  }): void {
    this.logger.debug(
      {
        chatId: params.chatId,
        ...(params.messageId ? { messageId: params.messageId } : {}),
        operation: params.operation,
        status: this.extractStatusCode(params.error),
        code: this.extractMaxErrorCode(params.error),
        error: params.error instanceof Error ? params.error.message : String(params.error),
      },
      'Skipped terminal night mode transition action',
    );
  }

  private buildRequestOptions(botId: string | null): MaxActionDispatchOptions {
    return {
      trafficClass: 'background',
      actionHealthLane: 'background',
      sourceTag: MAX_API_SOURCE_TAGS.NIGHT_MODE_TRANSITION,
      ignoreFailureMetricStatuses: [403, 404],
      ...(botId ? { botId } : {}),
    };
  }

  private extractStatusCode(error: unknown): number | null {
    const maybeResponse = (error as { response?: { status?: unknown }; status?: unknown }) ?? {};
    const status = maybeResponse.response?.status ?? maybeResponse.status;
    return typeof status === 'number' ? status : null;
  }

  private extractMaxErrorCode(error: unknown): string | null {
    const data = (error as { response?: { data?: unknown } })?.response?.data;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      const code = (data as Record<string, unknown>).code;
      return typeof code === 'string' && code.trim().length > 0 ? code.trim() : null;
    }
    return null;
  }
}
