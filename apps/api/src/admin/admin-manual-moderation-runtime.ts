import {
  resolveManualMuteResultFromLedger,
  isAmbiguousAttemptedMaxMemberMutation,
  isManualModerationTransientMaxError,
  isRetryableManualFanoutPreparationError,
  isManualModerationOrderingFailure,
  summarizeManualModerationCleanup,
  summarizeManualMuteFanout,
  summarizeManualBanFanout,
  buildManualModerationFanoutOperationKey,
  extractHttpErrorMessage,
  escapeMarkdownPlainText,
} from './admin-manual-moderation-values';
import { readTrimmedString } from './admin-legacy-utils';
import { BotCapabilityRequiredException } from './bot-capability-required.error';
import { extractMaxApiErrorMessage } from './admin-chat-rules';
import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  manualModerationActionResultSchema,
  normalizeDeleteBotMessagesDelayMinutes,
  type ManualModerationActionResult,
} from '@maxim/contracts';
import { createHash, randomUUID } from 'node:crypto';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { normalizeMaxUserDisplayName } from '../common/max-user-display-name.util';
import {
  MAX_API_SOURCE_TAGS,
  wasMaxMemberMutationAttempted,
  wasMaxMemberMutationConfirmed,
  wasMaxMessageSendAttempted,
  type MaxActionDispatchOptions,
} from '../max/max-client.service';
import { isAmbiguousMaxSendError } from '../max/max-send-ambiguity.util';
import {
  ModerationSanctionStateLockBusyError,
  ModerationSanctionStateLockLeaseLostError,
  ModerationSanctionStateLockUnavailableError,
} from '../moderation/moderation-sanction-state-lock.service';
import { withModerationReleaseButton } from '../moderation/moderation-release-callback.util';
import { withMarketplaceModerationMessage } from '../max/marketplace-publication-button';
import {
  ManualModerationFanoutLedgerStatus as PrismaManualModerationFanoutLedgerStatus,
  type Prisma,
} from '../prisma/prisma-client';
import {
  type AdminManualBanFanoutJob,
  type AdminManualBanSourceCleanupJob,
  type AdminManualFanoutJob,
  type AdminManualGroupModerationCommandJob,
  type AdminManualMuteFanoutJob,
} from './admin-manual-fanout.queue';
import type { AdminSuperBanJob } from './admin-super-ban.queue';
import { formatManualModerationUserLabel } from './manual-moderation-notice.util';
import { ManualGroupCommandNoticeAuthorityRejectedError } from './admin-manual-group-command-notice-authority';
import type {
  AdminManualModerationRuntimeContext,
  ManualBanFollowUpInput,
  ManualBanFollowUpSummary,
  ManualBanSourceCleanupInput,
  ManualModerationCleanupSummary,
  ManualMuteFollowUpInput,
  ManualMuteFollowUpSummary,
} from './admin-manual-moderation-runtime-context';
import {
  ADMIN_ACTION_HEALTH_LANE,
  ADMIN_MANUAL_FANOUT_QUEUE_PRIORITY,
  ADMIN_MANUAL_GROUP_COMMAND_QUEUE_PRIORITY,
  ADMIN_SUPER_BAN_QUEUE_PRIORITY,
  DEFAULT_GROUP_COMMAND_MUTE_DURATION_HOURS,
  type AdminActionSource,
  type ManualBanFollowUpSource,
  type ManualModerationExecutionOptions,
  type ManualModerationFanoutSource,
} from './admin.service.support';

const MANUAL_GROUP_COMMAND_COMPLETED_JOB_RETENTION = {
  age: 24 * 60 * 60,
  count: 10_000,
} as const;

export class ManualModerationOutcomeUncertainError extends BadRequestException {}

export type ManualGroupCommandNoticeInput = {
  chatId: string;
  botId?: string;
  ledger?: {
    jobId: string;
    rootIntentKey?: string | null;
    outcome: 'SUCCESS' | 'FAILURE' | 'UNCERTAIN';
    actorUserId: string;
    targetUserId: string;
    commandMessageId: string;
    action: 'BAN' | 'MUTE';
    issuedAtMs?: number;
  };
  text: string;
  release?: {
    action: 'UNBAN' | 'UNMUTE';
    sanctionEventId: string;
  };
  deleteBotMessagesEnabled: boolean;
  deleteBotMessagesDelayMinutes: number;
};

export type ManualFanoutActorInput = {
  userId: string;
  username: string | null;
  displayName: string | null;
  chatId?: string | null;
  chatTitle?: string | null;
};

export type ManualMuteFanoutTargetPreparation =
  | {
      kind: 'ready';
      operationKey: string;
      lockToken: string;
      botId: string | undefined;
      metadata: Prisma.InputJsonObject;
    }
  | {
      kind: 'settled';
      outcome: 'muted' | 'skipped' | 'failed';
      retryable: boolean;
    };

export class AdminManualModerationRuntime {
  constructor(private readonly context: AdminManualModerationRuntimeContext) {}

  private get adminSuperBanQueue() {
    return this.context.adminSuperBanQueue;
  }

  private get adminManualFanoutQueue() {
    return this.context.adminManualFanoutQueue;
  }

  private get adminManualCommandQueue() {
    return this.context.adminManualCommandQueue;
  }

  private get logger() {
    return this.context.logger;
  }

  private enqueueManualModerationFanoutViaContext(
    job: Parameters<AdminManualModerationRuntimeContext['enqueueManualModerationFanout']>[0],
  ): Promise<boolean> {
    return this.context.enqueueManualModerationFanout(job);
  }

  private isKnownRuntimeBotUserId(userId: string | null | undefined): boolean {
    return this.context.isKnownRuntimeBotUserId(userId);
  }

  private isSuperBanDeveloperUserId(userId: string | null | undefined): boolean {
    return this.context.isSuperBanDeveloperUserId(userId);
  }

  private processDeveloperSuperBanJob(job: AdminSuperBanJob): Promise<void> {
    return this.context.processDeveloperSuperBanJob(job);
  }

  async fanoutGroupMuteAfterNotice(
    job: AdminManualGroupModerationCommandJob,
    actor: AuthUser,
    result: ManualModerationActionResult,
  ): Promise<void> {
    if (job.action !== 'MUTE' || job.fanoutAllChats !== true) {
      return;
    }

    await this.resolveManualMuteCommandFollowUpSummaries({
      sourceChatId: job.sourceChatId,
      targetUserId: job.targetUserId,
      actor,
      rootIntentKey: job.jobId,
      muteDurationHours: result.muteDurationHours,
      muteExpiresAt: result.muteExpiresAt ? new Date(result.muteExpiresAt) : null,
      mutePermanent: job.mutePermanent === true,
      source: 'group_command',
    });
  }

  async enqueueManualGroupModerationCommand(params: {
    sourceChatId: string;
    commandBotId?: string | null;
    targetUserId: string;
    targetSenderName?: string | null;
    targetMessageId?: string | null;
    commandMessageId: string;
    actor: AuthUser;
    action: 'BAN' | 'MUTE';
    fanoutAllChats?: boolean;
    muteDurationHours?: number | null;
    mutePermanent?: boolean;
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
  }): Promise<boolean> {
    const job = this.buildManualGroupModerationCommandJob(params);
    return this.enqueueManualModerationFanoutViaContext(job);
  }

  async enqueueDeveloperSuperBanCommand(params: {
    sourceChatId: string;
    commandBotId?: string | null;
    targetUserId: string;
    targetSenderName?: string | null;
    targetMessageId?: string | null;
    commandMessageId: string;
    actor: AuthUser;
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
  }): Promise<boolean> {
    if (!this.isSuperBanDeveloperUserId(params.actor.userId)) {
      throw new ForbiddenException(
        'Недостаточно прав: команду `супер бан` может запускать только разработчик бота.',
      );
    }

    if (this.isKnownRuntimeBotUserId(params.targetUserId)) {
      throw new BadRequestException(
        'Команда `супер бан` отклонена: настроенные боты MAX защищены от блокировки.',
      );
    }

    const job = this.buildDeveloperSuperBanCommandJob(params);
    if (!this.adminSuperBanQueue) {
      void this.processDeveloperSuperBanJob(job).catch((error: unknown) => {
        this.logger.warn(
          {
            jobId: job.jobId,
            sourceChatId: job.sourceChatId,
            targetUserId: job.targetUserId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to process developer super ban without queue',
        );
      });
      return true;
    }

    try {
      await this.adminSuperBanQueue.add('execute-admin-super-ban', job, {
        jobId: job.jobId,
        priority: ADMIN_SUPER_BAN_QUEUE_PRIORITY,
        attempts: 5,
        removeOnComplete: true,
        removeOnFail: false,
        backoff: {
          type: 'exponential',
          delay: 1_000,
        },
      });
      return true;
    } catch (error: unknown) {
      this.logger.warn(
        {
          jobId: job.jobId,
          sourceChatId: job.sourceChatId,
          targetUserId: job.targetUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to enqueue developer super ban command',
      );
      return false;
    }
  }

  buildManualGroupModerationCommandJob(params: {
    sourceChatId: string;
    commandBotId?: string | null;
    targetUserId: string;
    targetSenderName?: string | null;
    targetMessageId?: string | null;
    commandMessageId: string;
    actor: AuthUser;
    action: 'BAN' | 'MUTE';
    fanoutAllChats?: boolean;
    muteDurationHours?: number | null;
    mutePermanent?: boolean;
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
  }): AdminManualGroupModerationCommandJob {
    return {
      kind: 'manual_group_moderation_command',
      issuedAtMs: Date.now(),
      jobId: this.buildManualGroupModerationCommandJobId(
        params.sourceChatId,
        params.commandMessageId,
        params.targetUserId,
        params.action,
        params.fanoutAllChats,
      ),
      sourceChatId: params.sourceChatId,
      commandBotId: readTrimmedString(params.commandBotId),
      targetUserId: params.targetUserId,
      targetSenderName: params.targetSenderName ?? null,
      targetMessageId: params.targetMessageId ?? null,
      commandMessageId: params.commandMessageId,
      actor: {
        userId: params.actor.userId,
        username: params.actor.username ?? null,
        displayName: params.actor.displayName ?? null,
        chatId: params.actor.chatId ?? null,
        chatTitle: params.actor.chatTitle ?? null,
      },
      action: params.action,
      fanoutAllChats: params.fanoutAllChats === true,
      muteDurationHours: params.muteDurationHours ?? null,
      mutePermanent: params.mutePermanent === true,
      deleteBotMessagesEnabled: params.deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes: params.deleteBotMessagesDelayMinutes,
    };
  }

  buildDeveloperSuperBanCommandJob(params: {
    sourceChatId: string;
    commandBotId?: string | null;
    targetUserId: string;
    targetSenderName?: string | null;
    targetMessageId?: string | null;
    commandMessageId: string;
    actor: AuthUser;
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
  }): AdminSuperBanJob {
    return {
      kind: 'developer_super_ban',
      jobId: this.buildDeveloperSuperBanCommandJobId(
        params.sourceChatId,
        params.commandMessageId,
        params.targetUserId,
      ),
      sourceChatId: params.sourceChatId,
      commandBotId: readTrimmedString(params.commandBotId),
      targetUserId: params.targetUserId,
      targetSenderName: params.targetSenderName ?? null,
      targetMessageId: params.targetMessageId ?? null,
      commandMessageId: params.commandMessageId,
      actor: {
        userId: params.actor.userId,
        username: params.actor.username ?? null,
        displayName: params.actor.displayName ?? null,
        chatId: params.actor.chatId ?? null,
        chatTitle: params.actor.chatTitle ?? null,
      },
      deleteBotMessagesEnabled: params.deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes: params.deleteBotMessagesDelayMinutes,
      retryPolicyName: 'manual-fanout',
      createdAt: new Date().toISOString(),
    };
  }

  buildManualGroupModerationCommandJobId(
    sourceChatId: string,
    commandMessageId: string,
    targetUserId: string,
    action: 'BAN' | 'MUTE',
    fanoutAllChats?: boolean,
  ): string {
    const digest = createHash('sha256')
      .update(
        `${sourceChatId}\n${commandMessageId}\n${targetUserId}\n${action}\n${
          fanoutAllChats === true ? 'all' : 'local'
        }`,
      )
      .digest('hex')
      .slice(0, 32);
    return `manual_group_moderation_command__${digest}`;
  }

  buildDeveloperSuperBanCommandJobId(
    sourceChatId: string,
    commandMessageId: string,
    targetUserId: string,
  ): string {
    const digest = createHash('sha256')
      .update(`${sourceChatId}\n${commandMessageId}\n${targetUserId}\ndeveloper_super_ban`)
      .digest('hex')
      .slice(0, 32);
    return `developer_super_ban__${digest}`;
  }

  async processManualModerationFanoutJob(job: AdminManualFanoutJob): Promise<void> {
    if (this.isKnownRuntimeBotUserId(job.targetUserId)) {
      this.logger.warn(
        {
          jobId: job.jobId,
          kind: job.kind,
          sourceChatId: job.sourceChatId,
          targetUserId: job.targetUserId,
        },
        'Skipped queued manual moderation job for configured MAX bot user',
      );
      return;
    }

    if (job.kind === 'manual_group_moderation_command') {
      await this.processManualGroupModerationCommandJob(job);
      return;
    }

    if (job.kind === 'manual_mute_fanout') {
      const actor = this.buildManualFanoutActor(job.actor);
      const targetChats = await this.context.resolveManualCommandFanoutChats(
        actor,
        job.sourceChatId,
      );
      if (job.cleanupSourceChatMessages) {
        await this.context.runManualSourceCleanupWithLedger({
          jobId: job.jobId,
          rootIntentKey: job.rootIntentKey ?? null,
          sourceKind: job.kind,
          sourceChatId: job.sourceChatId,
          targetUserId: job.targetUserId,
          actorUserId: job.actor.userId,
          logMessage: 'Failed to run deferred recent message cleanup after manual mute',
          botId: job.botId ?? undefined,
        });
      }
      const result = await this.context.applyManualMuteFanout({
        jobId: job.jobId,
        rootIntentKey: job.rootIntentKey ?? null,
        sourceChatId: job.sourceChatId,
        targetUserId: job.targetUserId,
        actor,
        muteDurationHours: job.muteDurationHours,
        muteExpiresAt: job.muteExpiresAt ? new Date(job.muteExpiresAt) : null,
        mutePermanent: job.mutePermanent === true,
        source: job.source,
        targetChats,
      });
      this.throwManualFanoutRetryableFailureIfNeeded(result);
      return;
    }

    if (job.kind === 'manual_ban_source_cleanup') {
      await this.context.runManualSourceCleanupWithLedger({
        jobId: job.jobId,
        rootIntentKey: job.rootIntentKey ?? null,
        sourceKind: job.kind,
        sourceChatId: job.sourceChatId,
        targetUserId: job.targetUserId,
        actorUserId: job.actor.userId,
        logMessage: 'Failed to run deferred recent message cleanup after manual system ban',
        botId: job.botId ?? undefined,
      });
      return;
    }

    const actor = this.buildManualFanoutActor(job.actor);
    const targetChats = await this.context.resolveManualCommandFanoutChats(actor, job.sourceChatId);
    await this.context.runManualSourceCleanupWithLedger({
      jobId: job.jobId,
      rootIntentKey: job.rootIntentKey ?? null,
      sourceKind: job.kind,
      sourceChatId: job.sourceChatId,
      targetUserId: job.targetUserId,
      actorUserId: job.actor.userId,
      logMessage: 'Failed to run deferred recent message cleanup after manual system ban',
    });

    const result = await this.context.applyManualSystemBanFanout({
      jobId: job.jobId,
      rootIntentKey: job.rootIntentKey ?? null,
      source: job.source,
      sourceChatId: job.sourceChatId,
      targetUserId: job.targetUserId,
      actor,
      targetChats,
    });
    this.throwManualFanoutRetryableFailureIfNeeded(result);
  }

  async prepareManualMuteFanoutTarget(params: {
    jobId?: string | null;
    rootIntentKey?: string | null;
    sourceChatId: string;
    targetChatId: string;
    targetUserId: string;
    actorUserId: string;
    muteDurationHours: number | null;
    muteExpiresAt: Date | null;
    mutePermanent: boolean;
    source: ManualModerationFanoutSource;
  }): Promise<ManualMuteFanoutTargetPreparation> {
    const operationKey = buildManualModerationFanoutOperationKey({
      operation: 'FANOUT_MUTE_RECORD',
      sourceChatId: params.sourceChatId,
      targetChatId: params.targetChatId,
      targetUserId: params.targetUserId,
      jobId: params.jobId,
      rootIntentKey: params.rootIntentKey,
      extra: [
        params.mutePermanent ? 'permanent' : 'timed',
        params.mutePermanent ? '' : params.muteDurationHours,
        params.muteExpiresAt ? params.muteExpiresAt.toISOString() : '',
      ],
    });
    const metadata = {
      source: params.source,
      sourceChatId: params.sourceChatId,
      muteDurationHours: params.muteDurationHours,
      muteExpiresAt: params.muteExpiresAt ? params.muteExpiresAt.toISOString() : null,
      mutePermanent: params.mutePermanent,
    } satisfies Prisma.InputJsonObject;
    const claim = await this.context.claimManualModerationFanoutLedgerEntry({
      operationKey,
      jobId: params.jobId,
      rootIntentKey: params.rootIntentKey,
      sourceKind: 'manual_mute_fanout',
      operation: 'FANOUT_MUTE_RECORD',
      sourceChatId: params.sourceChatId,
      targetChatId: params.targetChatId,
      targetUserId: params.targetUserId,
      actorUserId: params.actorUserId,
      logicalAction: 'MUTE',
      botId: null,
      metadata,
    });
    if (!claim.claimed) {
      return {
        kind: 'settled',
        outcome:
          claim.row?.status === PrismaManualModerationFanoutLedgerStatus.SUCCEEDED
            ? 'muted'
            : claim.row?.status === PrismaManualModerationFanoutLedgerStatus.SKIPPED
              ? 'skipped'
              : 'failed',
        retryable: false,
      };
    }

    let botId: string | undefined;
    try {
      botId = await this.context.resolveManualModerationActionBotAssignment({
        chatId: params.targetChatId,
        action: 'delete_message',
      });
    } catch (error: unknown) {
      return this.settleManualMuteFanoutPreparationFailure({
        operationKey,
        lockToken: claim.lockToken,
        botId,
        metadata,
        error,
        logContext: params,
        logMessage: 'Manual mute fanout has no eligible bot route',
      });
    }

    try {
      await this.context.assertBotCanDeleteMessages(params.targetChatId, botId);
    } catch (error: unknown) {
      return this.settleManualMuteFanoutPreparationFailure({
        operationKey,
        lockToken: claim.lockToken,
        botId,
        metadata,
        error,
        logContext: params,
        logMessage: 'Skipped manual mute fanout because the bot cannot delete messages in chat',
      });
    }

    return { kind: 'ready', operationKey, lockToken: claim.lockToken, botId, metadata };
  }

  private async settleManualMuteFanoutPreparationFailure(params: {
    operationKey: string;
    lockToken: string;
    botId: string | undefined;
    metadata: Prisma.InputJsonObject;
    error: unknown;
    logContext: { targetChatId: string; targetUserId: string; actorUserId: string };
    logMessage: string;
  }): Promise<ManualMuteFanoutTargetPreparation> {
    const retryable = isRetryableManualFanoutPreparationError(params.error);
    const persistedError =
      params.error && typeof params.error === 'object' && 'cause' in params.error
        ? ((params.error as { cause?: unknown }).cause ?? params.error)
        : params.error;
    await this.context.markManualModerationFanoutLedgerFailed({
      operationKey: params.operationKey,
      lockToken: params.lockToken,
      status: retryable
        ? PrismaManualModerationFanoutLedgerStatus.FAILED_RETRYABLE
        : PrismaManualModerationFanoutLedgerStatus.FAILED_TERMINAL,
      error: persistedError,
      botId: params.botId ?? null,
      metadata: params.metadata,
      requireClaim: true,
    });
    this.logger.warn(
      {
        chatId: params.logContext.targetChatId,
        targetUserId: params.logContext.targetUserId,
        actorUserId: params.logContext.actorUserId,
        err: params.error instanceof Error ? params.error.message : String(params.error),
      },
      params.logMessage,
    );
    return { kind: 'settled', outcome: 'failed', retryable };
  }

  private throwManualFanoutRetryableFailureIfNeeded(result: {
    retryableFailedChatIds?: string[];
  }): void {
    const retryableFailedChatIds = result.retryableFailedChatIds ?? [];
    if (retryableFailedChatIds.length === 0) {
      return;
    }

    throw new ServiceUnavailableException(
      `Не удалось применить часть fanout-операций (${retryableFailedChatIds.length}). Повторите попытку.`,
    );
  }

  private async processManualGroupModerationCommandJob(
    job: AdminManualGroupModerationCommandJob,
  ): Promise<void> {
    const settledOutcomeKind = await this.resolveSettledManualGroupCommandOutcome({
      jobId: job.jobId,
      chatId: job.sourceChatId,
      targetUserId: job.targetUserId,
    });
    if (
      settledOutcomeKind &&
      !(
        settledOutcomeKind === 'legacy_success' &&
        job.action === 'MUTE' &&
        job.fanoutAllChats === true
      )
    ) {
      return;
    }

    const actor = this.buildManualFanoutActor(job.actor);
    if (
      settledOutcomeKind === 'legacy_success' &&
      job.action === 'MUTE' &&
      job.fanoutAllChats === true
    ) {
      const sourceMuteLedger = await this.context.readManualModerationFanoutIntentRow({
        rootIntentKey: job.jobId,
        operation: 'COMMAND_SOURCE_MUTE',
        sourceChatId: job.sourceChatId,
        targetChatId: job.sourceChatId,
        targetUserId: job.targetUserId,
      });
      if (
        !sourceMuteLedger ||
        sourceMuteLedger.status !== PrismaManualModerationFanoutLedgerStatus.SUCCEEDED
      ) {
        this.logger.warn(
          {
            jobId: job.jobId,
            chatId: job.sourceChatId,
            targetUserId: job.targetUserId,
            sourceLedgerStatus: sourceMuteLedger?.status ?? null,
          },
          'Cannot recover legacy successful group mute fanout without a succeeded source intent',
        );
        return;
      }
      const result = resolveManualMuteResultFromLedger(sourceMuteLedger, {
        userId: job.targetUserId,
        muteDurationHours:
          job.mutePermanent === true
            ? null
            : (job.muteDurationHours ?? DEFAULT_GROUP_COMMAND_MUTE_DURATION_HOURS),
        muteExpiresAt: null,
        mutePermanent: job.mutePermanent === true,
      });
      await this.fanoutGroupMuteAfterNotice(job, actor, result);
      return;
    }

    const queuedDisplayName = normalizeMaxUserDisplayName(job.targetSenderName, job.targetUserId);
    const targetDisplayName =
      queuedDisplayName ??
      (await this.context.resolveManualModerationTargetDisplayName(
        job.sourceChatId,
        job.targetUserId,
        {
          botId: job.commandBotId ?? undefined,
          allowRemoteLookup: true,
        },
      ));
    const commandOptions: ManualModerationExecutionOptions = {
      actorAlreadyVerified: true,
      preferredBotId: job.commandBotId ?? null,
      targetDisplayNameHint: targetDisplayName,
      allowTargetDisplayNameRemoteLookup: false,
      fanoutAllChats: job.action === 'BAN' && job.fanoutAllChats === true,
      fanoutLedgerJobId: job.jobId,
    };
    let sanctionEventId: string | null = null;
    let actionAlreadyApplied = false;
    commandOptions.onModerationEventRecorded = (eventId) => {
      sanctionEventId = eventId;
    };
    commandOptions.onAlreadyApplied = () => {
      actionAlreadyApplied = true;
    };

    let result: ManualModerationActionResult;
    try {
      result =
        job.action === 'BAN'
          ? await this.context.processManualSystemBan(
              job.sourceChatId,
              job.targetUserId,
              actor,
              'group_command',
              commandOptions,
            )
          : await this.context.processManualModerationAction(
              job.sourceChatId,
              job.targetUserId,
              actor,
              {
                action: 'MUTE',
                scope: 'current_chat',
                ...(job.mutePermanent === true
                  ? { mutePermanent: true }
                  : {
                      muteDurationHours:
                        job.muteDurationHours ?? DEFAULT_GROUP_COMMAND_MUTE_DURATION_HOURS,
                    }),
              },
              'group_command',
              commandOptions,
            );
    } catch (error: unknown) {
      this.logger.warn(
        {
          jobId: job.jobId,
          chatId: job.sourceChatId,
          actorUserId: job.actor.userId,
          targetUserId: job.targetUserId,
          err: this.extractManualGroupCommandErrorMessage(error),
        },
        'Failed to apply queued group admin moderation command',
      );

      const failedActionLabel =
        job.action === 'BAN' ? (job.fanoutAllChats === true ? 'Бан!' : 'бан') : 'мут';
      if (wasMaxMemberMutationConfirmed(error) && sanctionEventId) {
        result = manualModerationActionResultSchema.parse({
          ok: true,
          action: job.action,
          userId: job.targetUserId,
          muteDurationHours:
            job.action === 'MUTE' && job.mutePermanent !== true
              ? (job.muteDurationHours ?? DEFAULT_GROUP_COMMAND_MUTE_DURATION_HOURS)
              : null,
          muteExpiresAt: null,
          message:
            job.action === 'BAN'
              ? 'Бан включён.'
              : job.mutePermanent === true
                ? 'Мут включён без срока.'
                : `Мут включён на ${job.muteDurationHours ?? DEFAULT_GROUP_COMMAND_MUTE_DURATION_HOURS} ч.`,
        });
      } else if (
        error instanceof ManualModerationOutcomeUncertainError ||
        wasMaxMemberMutationConfirmed(error) ||
        isAmbiguousAttemptedMaxMemberMutation(error)
      ) {
        const targetLabel = formatManualModerationUserLabel(targetDisplayName, job.targetUserId);
        const noticeBotId = await this.resolveManualGroupCommandNoticeBotId(
          job.sourceChatId,
          job.commandBotId,
        );
        await this.sendManualGroupCommandNotice({
          chatId: job.sourceChatId,
          botId: noticeBotId,
          ledger: {
            jobId: job.jobId,
            outcome: 'UNCERTAIN',
            actorUserId: job.actor.userId,
            targetUserId: job.targetUserId,
            commandMessageId: job.commandMessageId,
            action: job.action,
          },
          text: `Действие для участника ${targetLabel} было отправлено в MAX, но итог не удалось надёжно подтвердить. Проверьте статус участника перед повтором.`,
          deleteBotMessagesEnabled: job.deleteBotMessagesEnabled,
          deleteBotMessagesDelayMinutes: job.deleteBotMessagesDelayMinutes,
        });
        return;
      } else {
        const publicErrorMessage = this.extractExpectedManualGroupCommandErrorMessage(error);
        if (this.shouldRetryManualGroupCommandSilently(error) || !publicErrorMessage) {
          throw error;
        }

        const noticeBotId = await this.resolveManualGroupCommandNoticeBotId(
          job.sourceChatId,
          job.commandBotId,
        );
        await this.sendManualGroupCommandNotice({
          chatId: job.sourceChatId,
          botId: noticeBotId,
          ledger: {
            jobId: job.jobId,
            outcome: 'FAILURE',
            actorUserId: job.actor.userId,
            targetUserId: job.targetUserId,
            commandMessageId: job.commandMessageId,
            action: job.action,
          },
          text: `Команда «${failedActionLabel}» не выполнена: ${escapeMarkdownPlainText(
            publicErrorMessage,
          )}`,
          deleteBotMessagesEnabled: job.deleteBotMessagesEnabled,
          deleteBotMessagesDelayMinutes: job.deleteBotMessagesDelayMinutes,
        });
        return;
      }
    }

    const cleanupBotId = await this.context.resolveManualGroupCommandCleanupBotId(
      job.sourceChatId,
      job.commandBotId,
    );
    await this.context.deleteManualGroupCommandTargetMessage(job, { botId: cleanupBotId });
    await this.context.deleteManualGroupCommandMessage(job.sourceChatId, job.commandMessageId, {
      botId: cleanupBotId,
      originBotId: job.commandBotId,
      actorUserId: job.actor.userId,
    });
    if (actionAlreadyApplied) {
      return;
    }

    const targetLabel = formatManualModerationUserLabel(targetDisplayName, job.targetUserId);
    const noticeBotId = await this.resolveManualGroupCommandNoticeBotId(
      job.sourceChatId,
      job.commandBotId,
    );
    await this.fanoutGroupMuteAfterNotice(job, actor, result);
    await this.sendManualGroupCommandNotice({
      chatId: job.sourceChatId,
      botId: noticeBotId,
      ledger: {
        jobId: job.jobId,
        outcome: 'SUCCESS',
        actorUserId: job.actor.userId,
        targetUserId: job.targetUserId,
        commandMessageId: job.commandMessageId,
        action: job.action,
        ...(Number.isSafeInteger(job.issuedAtMs) && job.issuedAtMs! > 0
          ? { issuedAtMs: job.issuedAtMs }
          : {}),
      },
      text:
        job.action === 'BAN'
          ? result.message.toLowerCase().includes('удал')
            ? `Участник ${targetLabel} удалён из чата.`
            : `Для участника ${targetLabel} включён бан.`
          : `${result.message}\nУчастник: ${targetLabel}`,
      release: sanctionEventId
        ? {
            action: job.action === 'BAN' ? 'UNBAN' : 'UNMUTE',
            sanctionEventId,
          }
        : undefined,
      deleteBotMessagesEnabled: job.deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes: job.deleteBotMessagesDelayMinutes,
    });
  }

  buildManualFanoutActor(actor: ManualFanoutActorInput): AuthUser {
    return {
      userId: actor.userId,
      username: actor.username,
      displayName: actor.displayName,
      chatId: actor.chatId ?? undefined,
      chatTitle: actor.chatTitle ?? undefined,
    };
  }

  async resolveManualGroupCommandCleanupBotId(
    chatId: string,
    preferredBotId?: string | null,
  ): Promise<string | undefined> {
    const normalizedPreferredBotId = this.context.normalizeManualModerationBotId(preferredBotId);
    if (normalizedPreferredBotId && !this.context.canResolveCurrentChatMemberAccess()) {
      return normalizedPreferredBotId;
    }

    try {
      return await this.context.resolveManualModerationActionBotAssignment({
        chatId,
        action: 'delete_message',
        options: { preferredBotId: preferredBotId ?? null },
      });
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          preferredBotId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve queued group command cleanup bot',
      );
      return normalizedPreferredBotId ?? undefined;
    }
  }

  async resolveManualGroupCommandNoticeBotId(
    chatId: string,
    preferredBotId?: string | null,
  ): Promise<string | undefined> {
    try {
      return (
        (await this.context.resolveDeliveryBotAssignment(chatId)) ??
        this.context.normalizeManualModerationBotId(preferredBotId) ??
        undefined
      );
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          preferredBotId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve queued group command notice bot',
      );
      return this.context.normalizeManualModerationBotId(preferredBotId) ?? undefined;
    }
  }

  async sendManualGroupCommandNotice(params: ManualGroupCommandNoticeInput): Promise<void> {
    // FLAG: Unbound legacy/developer notices and diagnostic outcomes stay out of groups.
    // Only an explicit, durably recorded successful administrator command may publish.
    if (!params.ledger) return;
    const textHash = createHash('sha256').update(params.text).digest('hex').slice(0, 32);
    let operationKey: string | null = null;
    let ledgerLockToken: string | null = null;
    if (params.ledger) {
      if (
        await this.resolveSettledManualGroupCommandOutcome({
          jobId: params.ledger.jobId,
          chatId: params.chatId,
          targetUserId: params.ledger.targetUserId,
        })
      ) {
        return;
      }
      operationKey = buildManualModerationFanoutOperationKey({
        operation: 'COMMAND_NOTICE_OUTCOME',
        sourceChatId: params.chatId,
        targetChatId: params.chatId,
        targetUserId: params.ledger.targetUserId,
        jobId: params.ledger.jobId,
        rootIntentKey: params.ledger.rootIntentKey,
        extra: [params.ledger.commandMessageId, params.ledger.action],
      });
      const claim = await this.context.claimManualModerationFanoutLedgerEntry({
        operationKey,
        jobId: params.ledger.jobId,
        rootIntentKey: params.ledger.rootIntentKey,
        sourceKind: 'manual_group_moderation_command',
        operation: 'COMMAND_NOTICE_OUTCOME',
        sourceChatId: params.chatId,
        targetChatId: params.chatId,
        targetUserId: params.ledger.targetUserId,
        actorUserId: params.ledger.actorUserId,
        logicalAction: 'NOTICE',
        botId: params.botId ?? null,
        metadata: {
          action: params.ledger.action,
          outcome: params.ledger.outcome,
          commandMessageId: params.ledger.commandMessageId,
          textHash,
          ...(params.ledger.issuedAtMs !== undefined
            ? { issuedAtMs: params.ledger.issuedAtMs }
            : {}),
          ...(params.ledger.outcome !== 'SUCCESS'
            ? { suppressed: true, resultText: params.text }
            : {}),
        },
      });
      if (!claim.claimed) {
        return;
      }
      ledgerLockToken = claim.lockToken;
    }

    if (params.ledger.outcome !== 'SUCCESS') {
      await this.context.completeManualModerationFanoutLedgerEntry({
        operationKey: operationKey!,
        lockToken: ledgerLockToken!,
        botId: params.botId ?? null,
      });
      return;
    }

    const dispatchOptions = this.buildManualGroupCommandNoticeDispatchOptions({
      deleteBotMessagesEnabled: params.deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes: params.deleteBotMessagesDelayMinutes,
      botId: params.botId,
    });

    let noticeSendAttempted = false;
    dispatchOptions.ledgerContext = { moderationNoticeEnvelope: { version: 1 } };
    dispatchOptions.beforeImmediateSendMutation = async (revalidateRoute) => {
      await revalidateRoute?.();
      if (operationKey && ledgerLockToken) {
        await this.context.markManualModerationFanoutLedgerFailed({
          operationKey,
          lockToken: ledgerLockToken,
          status: PrismaManualModerationFanoutLedgerStatus.AMBIGUOUS,
          error: new Error(
            'manual group command notice send started; outcome unknown until confirmed',
          ),
          botId: params.botId ?? null,
          retainClaim: true,
          requireClaim: true,
        });
      }
      await this.context.assertManualGroupCommandSuccessNoticeAuthority({
        ...params.ledger!,
        operationKey: operationKey!,
        lockToken: ledgerLockToken!,
        chatId: params.chatId,
        textHash,
      });
      noticeSendAttempted = true;
    };
    if (operationKey) {
      dispatchOptions.idempotencyKey = operationKey;
    }

    let noticeSendConfirmed = false;
    try {
      const sentMessage = await this.context.sendMessage(
        params.chatId,
        params.text,
        withMarketplaceModerationMessage(
          params.release
            ? withModerationReleaseButton({ textFormat: 'markdown' }, params.release)
            : { textFormat: 'markdown' },
          params.chatId,
          'MODERATION_NOTICE',
        ),
        dispatchOptions,
      );
      noticeSendConfirmed = true;
      if (operationKey && ledgerLockToken) {
        await this.context.completeManualModerationFanoutLedgerEntry({
          operationKey,
          lockToken: ledgerLockToken,
          botId: params.botId ?? null,
          remoteMessageId: sentMessage?.messageId ?? null,
        });
      }
    } catch (error: unknown) {
      const ambiguousSend =
        noticeSendConfirmed ||
        (noticeSendAttempted &&
          (isAmbiguousMaxSendError(error) || wasMaxMessageSendAttempted(error)));
      if (operationKey && ledgerLockToken) {
        await this.context.markManualModerationFanoutLedgerFailed({
          operationKey,
          lockToken: ledgerLockToken,
          status:
            error instanceof ManualGroupCommandNoticeAuthorityRejectedError
              ? PrismaManualModerationFanoutLedgerStatus.SKIPPED
              : ambiguousSend
                ? PrismaManualModerationFanoutLedgerStatus.AMBIGUOUS
                : PrismaManualModerationFanoutLedgerStatus.FAILED_RETRYABLE,
          error,
          botId: params.botId ?? null,
          ...(error instanceof ManualGroupCommandNoticeAuthorityRejectedError
            ? { terminal: true }
            : {}),
        });
      }
      this.logger.debug(
        {
          chatId: params.chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to send manual group command notice',
      );
      if (!ambiguousSend && !(error instanceof ManualGroupCommandNoticeAuthorityRejectedError)) {
        throw error;
      }
    }
  }

  extractManualGroupCommandErrorMessage(error: unknown): string {
    const expectedMessage = this.extractExpectedManualGroupCommandErrorMessage(error);
    if (expectedMessage) {
      return expectedMessage;
    }

    return (
      extractMaxApiErrorMessage(error) ||
      extractHttpErrorMessage(error) ||
      (error instanceof Error ? error.message : 'Unknown error')
    );
  }

  extractExpectedManualGroupCommandErrorMessage(error: unknown): string | null {
    if (
      error instanceof BadRequestException ||
      error instanceof ForbiddenException ||
      error instanceof BotCapabilityRequiredException
    ) {
      const response = error.getResponse();
      if (typeof response === 'string' && response.trim()) {
        return this.normalizeManualModerationUserErrorMessage(response);
      }
      if (response && typeof response === 'object') {
        const message = (response as { message?: unknown }).message;
        if (typeof message === 'string' && message.trim()) {
          return this.normalizeManualModerationUserErrorMessage(message);
        }
      }
    }
    return null;
  }

  private async resolveSettledManualGroupCommandOutcome(params: {
    jobId: string;
    chatId: string;
    targetUserId: string;
  }): Promise<'current' | 'legacy_success' | 'legacy_failure' | null> {
    const rows = await this.context.findSettledManualGroupCommandOutcomeRows(params);
    if (rows.some((row) => row.operation === 'COMMAND_NOTICE_OUTCOME')) {
      return 'current';
    }
    if (rows.some((row) => row.operation === 'COMMAND_NOTICE_SUCCESS')) {
      return 'legacy_success';
    }
    return rows.length > 0 ? 'legacy_failure' : null;
  }

  private buildManualGroupCommandNoticeDispatchOptions(params: {
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
    botId?: string;
  }): MaxActionDispatchOptions {
    const options: MaxActionDispatchOptions = {
      immediate: true,
      trafficClass: 'interactive',
      actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_NOTICE,
    };
    if (params.botId) {
      options.botId = params.botId;
    }
    if (params.deleteBotMessagesEnabled) {
      options.autoDeleteDelayMs =
        normalizeDeleteBotMessagesDelayMinutes(params.deleteBotMessagesDelayMinutes) * 60 * 1_000;
    }
    return options;
  }

  private normalizeManualModerationUserErrorMessage(value: string): string | null {
    const normalized = value.trim();
    if (!normalized || normalized.length > 1_000 || !/[А-Яа-яЁё]/u.test(normalized)) {
      return null;
    }
    return normalized;
  }

  private shouldRetryManualGroupCommandSilently(error: unknown): boolean {
    if (error instanceof ModerationSanctionStateLockBusyError) {
      return true;
    }
    if (
      (error instanceof ModerationSanctionStateLockUnavailableError ||
        error instanceof ModerationSanctionStateLockLeaseLostError) &&
      !wasMaxMemberMutationAttempted(error) &&
      !wasMaxMemberMutationConfirmed(error)
    ) {
      return true;
    }
    if (isManualModerationTransientMaxError(error)) {
      return true;
    }

    const message = this.extractManualGroupCommandErrorMessage(error).toLowerCase();
    return (
      message.includes('rate limit exceeded') ||
      message.includes('circuit breaker') ||
      message.includes('timeout') ||
      message.includes('временно огранич') ||
      message.includes('повторите попытку')
    );
  }

  async resolveManualMuteCommandFollowUpSummaries(
    params: ManualMuteFollowUpInput,
  ): Promise<ManualMuteFollowUpSummary> {
    const queuedJob = this.buildManualMuteFanoutJob({
      ...params,
      cleanupSourceChatMessages: true,
    });
    if (await this.enqueueManualModerationFanoutViaContext(queuedJob)) {
      return {
        sourceMessageCleanup: this.buildQueuedManualModerationCleanupSummary(queuedJob.jobId),
        crossChatMuteFanout: this.buildQueuedManualMuteFanoutSummary(queuedJob.jobId),
      };
    }

    let sourceCleanup = {
      candidateMessageIds: [] as string[],
      deletedMessageIds: [] as string[],
      pendingMessageIds: [] as string[],
      failedMessageIds: [] as string[],
    };
    try {
      sourceCleanup = await this.context.deleteRecentTrackedMessagesForManualAction(
        params.sourceChatId,
        params.targetUserId,
        {
          botId: await this.context.resolveManualModerationActionBotAssignment({
            chatId: params.sourceChatId,
            action: 'delete_message',
          }),
          leaseGuard: params.leaseGuard,
        },
      );
    } catch (error: unknown) {
      if (isManualModerationOrderingFailure(error)) {
        throw error;
      }
      this.logger.warn(
        {
          chatId: params.sourceChatId,
          targetUserId: params.targetUserId,
          actorUserId: params.actor.userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to run recent message cleanup after manual mute',
      );
    }

    try {
      const fanout = await this.context.applyManualMuteFanout(params);
      return {
        sourceMessageCleanup: summarizeManualModerationCleanup(sourceCleanup),
        crossChatMuteFanout: summarizeManualMuteFanout(fanout),
      };
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: params.sourceChatId,
          targetUserId: params.targetUserId,
          actorUserId: params.actor.userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to run manual mute fanout after source chat mute',
      );
      return {
        sourceMessageCleanup: summarizeManualModerationCleanup(sourceCleanup),
        crossChatMuteFanout: summarizeManualMuteFanout({
          mutedChatIds: [],
          skippedChatIds: [],
          failedChatIds: [],
        }),
      };
    }
  }

  async resolveManualBanFollowUpSummaries(
    params: ManualBanFollowUpInput,
  ): Promise<ManualBanFollowUpSummary> {
    const queuedJob = this.buildManualBanFanoutJob({
      sourceChatId: params.sourceChatId,
      targetUserId: params.targetUserId,
      actor: params.actor,
      source: params.source,
      rootIntentKey: params.rootIntentKey ?? null,
    });
    if (await this.enqueueManualModerationFanoutViaContext(queuedJob)) {
      return {
        sourceMessageCleanup: this.buildQueuedManualModerationCleanupSummary(queuedJob.jobId),
        crossChatFanout: this.buildQueuedManualBanFanoutSummary(queuedJob.jobId),
      };
    }

    const sourceCleanup = await this.context.runManualBanSourceCleanup(
      params.sourceChatId,
      params.targetUserId,
      params.actor.userId,
      { leaseGuard: params.leaseGuard },
    );
    return {
      sourceMessageCleanup: summarizeManualModerationCleanup(sourceCleanup),
      crossChatFanout: await this.context.runManualBanFanoutInlineSummary(params),
    };
  }

  async resolveManualBanSourceCleanupSummary(
    params: ManualBanSourceCleanupInput,
  ): Promise<ManualModerationCleanupSummary> {
    const queuedJob = this.buildManualBanSourceCleanupJob(params);
    if (await this.enqueueManualModerationFanoutViaContext(queuedJob)) {
      return this.buildQueuedManualModerationCleanupSummary(queuedJob.jobId);
    }

    return summarizeManualModerationCleanup(
      await this.context.runManualBanSourceCleanup(
        params.sourceChatId,
        params.targetUserId,
        params.actor.userId,
        {
          botId: params.botId ?? undefined,
          leaseGuard: params.leaseGuard,
        },
      ),
    );
  }

  async resolveManualBanFanoutSummary(params: {
    sourceChatId: string;
    targetUserId: string;
    actor: AuthUser;
    source: Extract<AdminActionSource, 'group_command' | 'private_command'>;
    rootIntentKey?: string | null;
  }): Promise<ManualBanFollowUpSummary['crossChatFanout']> {
    const queuedJob = this.buildManualBanFanoutJob(params);
    if (await this.enqueueManualModerationFanoutViaContext(queuedJob)) {
      return this.buildQueuedManualBanFanoutSummary(queuedJob.jobId);
    }

    try {
      const fanout = await this.context.applyManualSystemBanFanout(params);
      return summarizeManualBanFanout(fanout);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: params.sourceChatId,
          targetUserId: params.targetUserId,
          actorUserId: params.actor.userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to run manual system ban fanout after source chat ban',
      );
      return summarizeManualBanFanout({
        removedChatIds: [],
        skippedChatIds: [],
        failedChatIds: [],
        deletedMessageCount: 0,
        failedMessageDeleteCount: 0,
      });
    }
  }

  private buildManualMuteFanoutJob(params: {
    sourceChatId: string;
    targetUserId: string;
    rootIntentKey?: string | null;
    cleanupSourceChatMessages?: boolean;
    actor: AuthUser;
    muteDurationHours: number | null;
    muteExpiresAt: Date | null;
    mutePermanent: boolean;
    source: ManualModerationFanoutSource;
    botId?: string | null;
  }): AdminManualMuteFanoutJob {
    return {
      kind: 'manual_mute_fanout',
      jobId: this.buildManualModerationFanoutJobId(
        'manual_mute_fanout',
        params.sourceChatId,
        params.targetUserId,
        params.source,
      ),
      rootIntentKey: params.rootIntentKey ?? null,
      sourceChatId: params.sourceChatId,
      targetUserId: params.targetUserId,
      cleanupSourceChatMessages: params.cleanupSourceChatMessages,
      botId: params.botId ?? null,
      actor: {
        userId: params.actor.userId,
        username: params.actor.username ?? null,
        displayName: params.actor.displayName ?? null,
        chatId: params.actor.chatId ?? null,
        chatTitle: params.actor.chatTitle ?? null,
      },
      muteDurationHours: params.muteDurationHours,
      muteExpiresAt: params.muteExpiresAt ? params.muteExpiresAt.toISOString() : null,
      mutePermanent: params.mutePermanent,
      source: params.source,
    };
  }

  private buildManualBanFanoutJob(params: {
    sourceChatId: string;
    targetUserId: string;
    rootIntentKey?: string | null;
    actor: AuthUser;
    source: ManualBanFollowUpSource;
  }): AdminManualBanFanoutJob {
    return {
      kind: 'manual_ban_fanout',
      jobId: this.buildManualModerationFanoutJobId(
        'manual_ban_fanout',
        params.sourceChatId,
        params.targetUserId,
        params.source,
      ),
      rootIntentKey: params.rootIntentKey ?? null,
      sourceChatId: params.sourceChatId,
      targetUserId: params.targetUserId,
      actor: {
        userId: params.actor.userId,
        username: params.actor.username ?? null,
        displayName: params.actor.displayName ?? null,
        chatId: params.actor.chatId ?? null,
        chatTitle: params.actor.chatTitle ?? null,
      },
      source: params.source,
    };
  }

  private buildManualBanSourceCleanupJob(
    params: ManualBanSourceCleanupInput,
  ): AdminManualBanSourceCleanupJob {
    return {
      kind: 'manual_ban_source_cleanup',
      jobId: this.buildManualModerationFanoutJobId(
        'manual_ban_source_cleanup',
        params.sourceChatId,
        params.targetUserId,
        params.source,
      ),
      rootIntentKey: params.rootIntentKey ?? null,
      sourceChatId: params.sourceChatId,
      targetUserId: params.targetUserId,
      actor: {
        userId: params.actor.userId,
        username: params.actor.username ?? null,
        displayName: params.actor.displayName ?? null,
        chatId: params.actor.chatId ?? null,
        chatTitle: params.actor.chatTitle ?? null,
      },
      source: params.source,
      botId: params.botId ?? null,
    };
  }

  private buildManualModerationFanoutJobId(
    kind: AdminManualFanoutJob['kind'],
    sourceChatId: string,
    targetUserId: string,
    source: Extract<AdminActionSource, 'miniapp' | 'group_command' | 'private_command'>,
  ): string {
    return `${kind}__${source}__${sourceChatId}__${targetUserId}__${randomUUID()}`;
  }

  async enqueueManualModerationFanout(job: AdminManualFanoutJob): Promise<boolean> {
    const isCommand = job.kind === 'manual_group_moderation_command';
    const queue = isCommand ? this.adminManualCommandQueue : this.adminManualFanoutQueue;
    if (!queue) {
      return false;
    }

    try {
      if (isCommand) {
        // FLAG: Queue namespaces do not share BullMQ dedupe. Retained legacy jobs
        // keep their original state and timing; an unavailable lookup is not absence.
        if (!this.adminManualFanoutQueue) return false;
        const retained = await this.adminManualFanoutQueue.getJob(job.jobId);
        if (retained) return true;
      }
      await queue.add('execute-admin-manual-fanout', job, {
        jobId: job.jobId,
        priority: this.resolveManualModerationFanoutQueuePriority(job),
        attempts: 5,
        removeOnComplete:
          job.kind === 'manual_group_moderation_command'
            ? MANUAL_GROUP_COMMAND_COMPLETED_JOB_RETENTION
            : true,
        removeOnFail: false,
        backoff: {
          type: 'exponential',
          delay: 1_000,
        },
      });
      return true;
    } catch (error: unknown) {
      this.logger.warn(
        {
          jobId: job.jobId,
          kind: job.kind,
          sourceChatId: job.sourceChatId,
          targetUserId: job.targetUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to enqueue manual moderation fanout',
      );
      return false;
    }
  }

  private resolveManualModerationFanoutQueuePriority(job: AdminManualFanoutJob): number {
    return job.kind === 'manual_group_moderation_command'
      ? ADMIN_MANUAL_GROUP_COMMAND_QUEUE_PRIORITY
      : ADMIN_MANUAL_FANOUT_QUEUE_PRIORITY;
  }

  private buildQueuedManualModerationCleanupSummary(jobId: string): ManualModerationCleanupSummary {
    return {
      mode: 'queued',
      jobId,
      candidateCount: 0,
      deletedCount: 0,
      pendingCount: 0,
      failedCount: 0,
    };
  }

  private buildQueuedManualMuteFanoutSummary(jobId: string) {
    return {
      mode: 'queued' as const,
      jobId,
      mutedChatsCount: 0,
      mutedChatIds: [] as string[],
      skippedChatsCount: 0,
      skippedChatIds: [] as string[],
      failedChatsCount: 0,
      failedChatIds: [] as string[],
    };
  }

  private buildQueuedManualBanFanoutSummary(jobId: string) {
    return {
      mode: 'queued' as const,
      jobId,
      removedChatsCount: 0,
      removedChatIds: [] as string[],
      skippedChatsCount: 0,
      skippedChatIds: [] as string[],
      failedChatsCount: 0,
      failedChatIds: [] as string[],
      deletedMessageCount: 0,
      failedMessageDeleteCount: 0,
    };
  }
}
