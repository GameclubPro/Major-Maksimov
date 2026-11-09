import { KaravanMarketplaceResolverService } from '../integrations/karavan-marketplace/karavan-marketplace-resolver.service';
import { isMaxMutationOutcomeAmbiguous } from './max-mutation-outcome.util';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StorageRuntimeMetricsService } from '../system/storage-runtime-metrics.service';
import { optimizationElapsed, optimizationNow } from '../system/optimization-runtime-metrics';
import { UnrecoverableError } from 'bullmq';
import {
  isMaxActionRouteQuarantinedError,
  MaxActionNoExecutableRouteError,
  MaxActionRouteQuarantinedError,
} from './max-action-dispatch-error';
import { MaxActionLedgerService } from './max-action-ledger.service';
import {
  markMaxPreDispatchGuardRejected,
  MAX_DELETE_PRE_DISPATCH_GUARD_REJECTED_CODE,
  MAX_MEMBER_PRE_DISPATCH_GUARD_REJECTED_CODE,
  MAX_SEND_PRE_DISPATCH_GUARD_REJECTED_CODE,
  wasMaxPreDispatchGuardRejected,
} from './max-action-pre-dispatch-guard';
import {
  assertLegacyActionAllowed,
  WebhookLegacyHoldService,
  WebhookLegacyHoldRejectedError,
} from '../webhook/webhook-legacy-hold.service';
import { MaxBotLinkService, type MaxBotRouteRequest } from './max-bot-link.service';
import {
  isMaxApiCircuitOpenError,
  MaxClientService,
  type MaxActionLedgerContext,
  type MaxActionJob,
  type MaxPublishedMessage,
  type MaxSendMessageOptions,
} from './max-client.service';
import {
  ManagedEntityAccessLossService,
  type ManagedEntityAccessLossOperation,
} from './managed-entity-access-loss.service';
import {
  normalizeMaxRoutedMutationCanaryPercent,
  normalizeMaxRoutedMutationMode,
  parseMaxRoutedMutationCanaryEntityIds,
  shouldEnforceMaxRoutedMutation,
  type MaxRoutedMutationMode,
} from './max-routed-mutation-rollout.util';
import { readMaxSendAutoDeleteVerificationDiagnostic } from './max-send-auto-delete-verification-error';
import { parseMaxFutureNightStickyRouteProbe } from './max-send-route-sticky-probe';
import { resolveExplicitMembershipAccessDenial } from './max-membership-access-error';
import {
  MaxSendCapacityDeadlineError,
  readMaxSendCapacityDeferral,
} from './max-send-capacity-deferral';

type TerminalManagedEntityOutcome =
  | {
      kind: 'failed';
      error: UnrecoverableError;
      replacementBotId: string | null;
    }
  | {
      kind: 'skipped';
      reason: string;
    };

type HalfOpenRouteState = {
  candidateBotIds: Set<string>;
  retryAt: Date | null;
};

export type MaxActionDispatchResult = MaxPublishedMessage & {
  botId: string | null;
};

export type MaxActionDispatchExecutionOptions = {
  finalAttempt?: boolean;
  enqueuedAt?: Date;
  deferSendCapacity?: boolean;
  prepareAttempt?: (params: { botId: string | null; job: MaxActionJob }) => Promise<{
    text?: string;
    options?: MaxSendMessageOptions;
    ledgerContext?: MaxActionLedgerContext;
  }>;
  onDispatchAttempt?: (params: { botId: string | null; job: MaxActionJob }) => void | Promise<void>;
  beforeSendMutation?: (params: {
    botId: string | null;
    job: MaxActionJob;
  }) => void | Promise<void>;
};

export {
  isMaxActionNoExecutableRouteError,
  isMaxActionRouteQuarantinedError,
  MAX_ACTION_NO_EXECUTABLE_ROUTE_ERROR_CODE,
  MAX_ACTION_ROUTE_QUARANTINED_ERROR_CODE,
  MaxActionNoExecutableRouteError,
  MaxActionRouteQuarantinedError,
} from './max-action-dispatch-error';

const ROUTED_SEND_ACCESS_MAX_AGE_MS = 15 * 60_000;
const ROUTED_DESTRUCTIVE_ACCESS_MAX_AGE_MS = 5 * 60_000;

@Injectable()
export class MaxActionDispatchService {
  private readonly logger = new Logger(MaxActionDispatchService.name);
  private readonly routedMutationsMode: MaxRoutedMutationMode;
  private readonly routedMutationsCanaryPercent: number;
  private readonly routedMutationsCanaryEntityIds: ReadonlySet<string>;
  private readonly crossBotEditDeleteEnabled: boolean;

  constructor(
    private readonly maxClient: MaxClientService,
    @Optional()
    private readonly managedEntityAccessLossService?: ManagedEntityAccessLossService,
    @Optional()
    private readonly actionLedgerService?: MaxActionLedgerService,
    @Optional()
    private readonly maxBotLinkService?: MaxBotLinkService,
    @Optional() configService?: ConfigService,
    @Optional() private readonly legacyHolds?: WebhookLegacyHoldService,
    @Optional() private readonly karavanMarketplaces?: KaravanMarketplaceResolverService,
    @Optional() private readonly metrics?: StorageRuntimeMetricsService,
  ) {
    this.routedMutationsMode = normalizeMaxRoutedMutationMode(
      configService?.get('MAX_ROUTED_MUTATIONS_MODE'),
    );
    this.routedMutationsCanaryPercent = normalizeMaxRoutedMutationCanaryPercent(
      configService?.get('MAX_ROUTED_MUTATIONS_CANARY_PERCENT'),
    );
    this.routedMutationsCanaryEntityIds = parseMaxRoutedMutationCanaryEntityIds(
      configService?.get('MAX_ROUTED_MUTATIONS_CANARY_ENTITY_IDS'),
    );
    this.crossBotEditDeleteEnabled = this.readBoolean(
      configService?.get('MAX_CROSS_BOT_EDIT_DELETE_ENABLED'),
      false,
    );
  }

  async recoverCompletedSend(job: MaxActionJob): Promise<MaxActionDispatchResult | null> {
    const completedSendDispatch =
      typeof this.actionLedgerService?.getCompletedSendDispatchResult === 'function'
        ? await this.actionLedgerService.getCompletedSendDispatchResult(job)
        : null;
    const completedSendMessageId =
      completedSendDispatch?.remoteMessageId ??
      (typeof this.actionLedgerService?.getCompletedSendDispatchResult !== 'function'
        ? await this.actionLedgerService?.getCompletedSendDispatch?.(job)
        : null);
    if (!completedSendMessageId) {
      return null;
    }

    const requiredBotId = this.readTrimmedString(job.routing?.requiredBotId);
    const persistedDispatchBotId = this.readTrimmedString(completedSendDispatch?.dispatchBotId);
    if (requiredBotId && persistedDispatchBotId !== requiredBotId) {
      throw new UnrecoverableError(
        `Completed MAX SEND_MESSAGE ${job.idempotencyKey} is not bound to required bot ${requiredBotId}`,
      );
    }

    if (
      typeof job.autoDeleteDelayMs === 'number' &&
      Number.isFinite(job.autoDeleteDelayMs) &&
      job.autoDeleteDelayMs > 0
    ) {
      try {
        // FLAG: A saved SEND can settle without new-effect authority. Its DELETE
        // child still requires fresh parent source admission.
        if (this.legacyHolds) await assertLegacyActionAllowed(this.legacyHolds, job);
        await this.maxClient.ensureSendAutoDeleteScheduled(job, {
          remoteMessageId: completedSendMessageId,
          dispatchBotId: persistedDispatchBotId,
          completedAt: completedSendDispatch?.completedAt ?? null,
        });
      } catch (error: unknown) {
        if (!(error instanceof WebhookLegacyHoldRejectedError)) throw error;
      }
    }

    return {
      messageId: completedSendMessageId,
      url: null,
      botId: persistedDispatchBotId,
    };
  }

  async execute(
    job: MaxActionJob,
    options: MaxActionDispatchExecutionOptions = {},
  ): Promise<MaxActionDispatchResult | void> {
    if (job.actionType !== 'SEND_MESSAGE' || !this.metrics)
      return this.executeObserved(job, options);
    const started = optimizationNow();
    let failed = true;
    if (options.enqueuedAt) {
      const enqueuedAt = options.enqueuedAt.getTime();
      const scheduledAt = job.scheduledFor == null ? enqueuedAt : Date.parse(job.scheduledFor);
      const readyAt = Math.max(enqueuedAt, scheduledAt);
      const now = Date.now();
      this.metrics.optimization.timing(
        job.attempt > 1 ? 'sendRetryQueue' : 'sendFirstQueue',
        Number.isFinite(readyAt) && enqueuedAt > 0 && readyAt <= now ? now - readyAt : null,
      );
    }
    try {
      const result = await this.executeObserved(job, options);
      failed = false;
      return result;
    } finally {
      this.metrics.optimization.timing('sendDispatch', optimizationElapsed(started), failed);
    }
  }

  private async executeObserved(
    job: MaxActionJob,
    options: MaxActionDispatchExecutionOptions,
  ): Promise<MaxActionDispatchResult | void> {
    const completedSend = await this.recoverCompletedSend(job);
    if (completedSend) {
      return completedSend;
    }
    if (this.legacyHolds) {
      try {
        await assertLegacyActionAllowed(this.legacyHolds, job);
      } catch (error) {
        // FLAG: An exact positive receipt wins a concurrent hold lookup. This path only
        // settles the saved send; it never lends its identity to another HTTP attempt.
        const recovered = await this.recoverCompletedSend(job);
        if (recovered) return recovered;
        throw error;
      }
    }
    await this.actionLedgerService?.assertCanExecute?.(job);
    const routedMutationEnforced = this.shouldEnforceRoutedFailover(job);
    const crossBotOperationAllowed =
      job.actionType !== 'DELETE_MESSAGE' || this.crossBotEditDeleteEnabled;
    const routedFailoverEnabled = routedMutationEnforced && crossBotOperationAllowed;
    const allowHalfOpenProbe =
      job.routing?.sendRouteHalfOpenProbe === 'publication_exact_verification';
    const candidateResolution = await this.resolveExecutionCandidateBotIds(job, {
      enforceFreshRoute: routedFailoverEnabled,
      allowHalfOpenProbe,
    });
    const candidateBotIds = candidateResolution.candidateBotIds;
    const halfOpenRouteState: HalfOpenRouteState = {
      candidateBotIds: new Set(candidateResolution.halfOpenCandidateBotIds),
      retryAt: candidateResolution.retryAt,
    };
    if (this.isRoutedJob(job) && !routedFailoverEnabled && candidateBotIds.length > 1) {
      candidateBotIds.splice(1);
    }
    if (this.isRoutedJob(job)) {
      const executableCandidateBotIds = candidateBotIds.filter((botId) => {
        if (this.isExecutableCandidate(botId)) {
          return true;
        }
        this.logger.warn(
          {
            actionType: job.actionType,
            chatId: job.chatId,
            botId,
          },
          'Skipped non-executable routed MAX action candidate before execution claim',
        );
        return false;
      });
      candidateBotIds.splice(0, candidateBotIds.length, ...executableCandidateBotIds);
      if (candidateBotIds.length === 0) {
        throw new MaxActionNoExecutableRouteError(job.actionType, job.chatId);
      }
    }
    if (options.enqueuedAt) {
      await this.actionLedgerService?.recordStarted(job, options.enqueuedAt);
    } else {
      await this.actionLedgerService?.recordStarted(job);
    }
    const attemptedBotIds: string[] = [];
    let lastAccessError: UnrecoverableError | null = null;
    let lastPreDispatchError: Error | null = null;
    const allowImplicitDefaultAttempt = !this.isRoutedJob(job) && candidateBotIds.length === 0;
    const trackAttemptedBotIds = this.isRoutedJob(job) || Boolean(job.attemptedBotIds?.length);

    while (
      candidateBotIds.length > 0 ||
      (allowImplicitDefaultAttempt && attemptedBotIds.length === 0)
    ) {
      const candidateBotId = candidateBotIds.shift();
      if (
        candidateBotId &&
        !this.isRequiredBotCandidate(candidateBotId, job.routing?.requiredBotId)
      ) {
        this.logger.warn(
          {
            actionType: job.actionType,
            chatId: job.chatId,
            botId: candidateBotId,
            requiredBotId: job.routing?.requiredBotId ?? null,
          },
          'Skipped routed MAX action candidate outside the required bot fence',
        );
        continue;
      }
      if (candidateBotId && !this.isExecutableCandidate(candidateBotId)) {
        this.logger.warn(
          {
            actionType: job.actionType,
            chatId: job.chatId,
            botId: candidateBotId,
          },
          'Skipped non-executable routed MAX action candidate before dispatch',
        );
        continue;
      }

      let attemptJob: MaxActionJob = {
        ...job,
        ...(candidateBotId ? { botId: candidateBotId } : {}),
        ...(trackAttemptedBotIds
          ? { attemptedBotIds: [...attemptedBotIds, ...(candidateBotId ? [candidateBotId] : [])] }
          : {}),
      };
      if (candidateBotId) {
        attemptedBotIds.push(candidateBotId);
      }

      let dispatchAttemptStartedAt: Date | null = null;
      let halfOpenClaimedUntil: Date | null = null;
      const releaseHalfOpenClaim = async () => {
        if (!candidateBotId || !halfOpenClaimedUntil) {
          return;
        }
        const claimedUntil = halfOpenClaimedUntil;
        halfOpenClaimedUntil = null;
        await this.releaseSendRouteHalfOpenSafely(job, candidateBotId, claimedUntil);
      };
      try {
        if (
          candidateBotId &&
          job.routing?.purpose !== 'publisher_exact_send' &&
          routedFailoverEnabled &&
          !(await this.refreshStaleRoutedCandidateAccess(
            attemptJob,
            candidateBotIds,
            attemptedBotIds,
            halfOpenRouteState,
            allowHalfOpenProbe,
          ))
        ) {
          continue;
        }
        const prepared = await options.prepareAttempt?.({
          botId: candidateBotId ?? null,
          job: attemptJob,
        });
        if (prepared) {
          attemptJob = {
            ...attemptJob,
            ...(prepared.text !== undefined ? { text: prepared.text } : {}),
            ...(prepared.options !== undefined ? { options: prepared.options } : {}),
            ...(prepared.ledgerContext !== undefined
              ? { ledgerContext: prepared.ledgerContext }
              : {}),
          };
          await this.actionLedgerService?.recordPrepared?.(attemptJob);
        }
        if (candidateBotId && halfOpenRouteState.candidateBotIds.has(candidateBotId)) {
          halfOpenClaimedUntil = await this.claimSendRouteHalfOpen(job, candidateBotId);
          if (!halfOpenClaimedUntil) {
            throw new MaxActionRouteQuarantinedError(
              job.actionType,
              job.chatId,
              halfOpenRouteState.retryAt ?? new Date(Date.now() + 15 * 60_000),
              [candidateBotId],
            );
          }
        }
        await options.onDispatchAttempt?.({
          botId: candidateBotId ?? null,
          job: attemptJob,
        });
        dispatchAttemptStartedAt = new Date();
        let executionOptions: Parameters<MaxClientService['executeActionJob']>[1] = undefined;
        // FLAG: A permanent-hold check cannot supply the live caller authority needed to unban.
        if (this.legacyHolds && attemptJob.actionType === 'DELETE_MESSAGE') {
          executionOptions = {
            beforeDeleteMutation: () => this.assertLegacyEffectsAllowed(attemptJob),
          };
        } else if (
          this.legacyHolds &&
          attemptJob.actionType !== 'SEND_MESSAGE' &&
          attemptJob.actionType !== 'TRY_UNBAN_MEMBER'
        ) {
          executionOptions = {
            beforeMemberMutation: () => this.assertLegacyEffectsAllowed(attemptJob),
          };
        } else if (
          attemptJob.actionType === 'SEND_MESSAGE' &&
          (this.legacyHolds ||
            options.beforeSendMutation ||
            attemptJob.ledgerContext?.karavanMarketplacePublication !== undefined ||
            attemptJob.ledgerContext?.karavanStorefrontRelay !== undefined ||
            attemptJob.sourceTag === 'karavan_storefront_relay')
        ) {
          executionOptions = {
            beforeSendMutation: async () => {
              // FLAG: Shared holds precede the feature's final deadline/authority guard.
              // An unchanged route or prepared body cannot waive a permanent disposition.
              await this.assertLegacyEffectsAllowed(attemptJob);
              if (
                attemptJob.ledgerContext?.karavanMarketplacePublication !== undefined ||
                attemptJob.ledgerContext?.karavanStorefrontRelay !== undefined ||
                attemptJob.sourceTag === 'karavan_storefront_relay'
              ) {
                if (!this.karavanMarketplaces)
                  throw new UnrecoverableError('Karavan marketplace dispatch guard unavailable');
                await this.karavanMarketplaces.assertDispatch(attemptJob, candidateBotId ?? null);
              }
              await options.beforeSendMutation?.({
                botId: candidateBotId ?? null,
                job: attemptJob,
              });
            },
          };
        }
        const executionResult = executionOptions
          ? await this.maxClient.executeActionJob(attemptJob, executionOptions)
          : await this.maxClient.executeActionJob(attemptJob);
        const recoveredSendDispatch = executionResult?.recoveredSendDispatch;
        if (!recoveredSendDispatch) {
          const ledgerStarted = optimizationNow();
          let ledgerFailed = true;
          try {
            await this.recordLedgerSucceeded(attemptJob);
            ledgerFailed = false;
          } finally {
            if (attemptJob.actionType === 'SEND_MESSAGE')
              this.metrics?.optimization.timing(
                'sendLedger',
                optimizationElapsed(ledgerStarted),
                ledgerFailed,
              );
          }
        }
        if (executionResult) {
          const publishedMessage = { ...executionResult };
          delete publishedMessage.recoveredSendDispatch;
          const recoveredDispatchBotId = this.readTrimmedString(
            recoveredSendDispatch?.dispatchBotId,
          );
          const requiredBotId = this.readTrimmedString(job.routing?.requiredBotId);
          if (recoveredSendDispatch && requiredBotId && recoveredDispatchBotId !== requiredBotId) {
            throw new UnrecoverableError(
              `Completed MAX SEND_MESSAGE ${job.idempotencyKey} is not bound to required bot ${requiredBotId}`,
            );
          }
          return {
            ...publishedMessage,
            botId: recoveredSendDispatch
              ? recoveredDispatchBotId
              : (candidateBotId ?? attemptJob.botId?.trim() ?? null),
          };
        }
        return;
      } catch (error: unknown) {
        if (!dispatchAttemptStartedAt) {
          await releaseHalfOpenClaim();
        }
        const capacityDeferral =
          options.deferSendCapacity === true && this.actionLedgerService
            ? readMaxSendCapacityDeferral(error, attemptJob)
            : null;
        if (capacityDeferral && this.actionLedgerService) {
          await releaseHalfOpenClaim();
          // FLAG: Only a certified unattempted notice can keep its final ordinary
          // attempt. Persist the retry state before moving the same locked job.
          const expired = capacityDeferral instanceof MaxSendCapacityDeadlineError;
          await this.actionLedgerService.recordFailed(
            attemptJob,
            expired ? capacityDeferral : error,
            { exhausted: expired },
          );
          throw capacityDeferral;
        }
        // FLAG: Ambiguous verification is not deletion success. Stop BullMQ retries only after
        // the durable ledger owns the terminal, manually repairable outcome.
        if (
          attemptJob.actionType === 'DELETE_MESSAGE' &&
          Boolean(attemptJob.sendAutoDelete) &&
          readMaxSendAutoDeleteVerificationDiagnostic(error)?.kind === 'access_ambiguous'
        ) {
          if (await this.persistAccessAmbiguousAutoDeleteFailure(attemptJob, error)) {
            throw new UnrecoverableError(
              'MAX send-side auto-delete exact presence verification is access-ambiguous',
            );
          }
          throw error;
        }
        if (wasMaxPreDispatchGuardRejected(error)) {
          await releaseHalfOpenClaim();
          if (
            (error as { code?: string })?.code === 'max_action_executor_proof_rejected' &&
            this.isRoutedJob(job) &&
            routedFailoverEnabled &&
            candidateBotId
          ) {
            await this.refreshStaleRoutedCandidateAccess(
              attemptJob,
              candidateBotIds,
              attemptedBotIds,
              halfOpenRouteState,
              allowHalfOpenProbe,
              true,
            );
            if (candidateBotIds.length > 0) continue;
          }
          await this.recordLedgerFailed(attemptJob, error, {
            exhausted: options.finalAttempt === true,
          });
          throw error;
        }
        if (isMaxApiCircuitOpenError(error)) {
          await releaseHalfOpenClaim();
          if (this.isRoutedJob(job) && routedFailoverEnabled) {
            lastPreDispatchError = error;
            this.logger.warn(
              {
                actionType: job.actionType,
                chatId: job.chatId,
                skippedBotId: candidateBotId ?? error.botId,
                nextBotId: candidateBotIds[0] ?? null,
                retryAfterMs: error.retryAfterMs,
              },
              'Skipped routed MAX action candidate with an open shared circuit before dispatch',
            );
            continue;
          }

          await this.recordLedgerFailed(attemptJob, error, {
            exhausted: options.finalAttempt === true,
          });
          throw error;
        }

        if (!dispatchAttemptStartedAt) {
          if (
            this.isDefinitivePreparationCandidateRejection(error) &&
            candidateBotIds.length > 0 &&
            this.isRoutedJob(job) &&
            routedFailoverEnabled
          ) {
            lastPreDispatchError = error instanceof Error ? error : new Error(String(error));
            this.logger.warn(
              {
                actionType: job.actionType,
                chatId: job.chatId,
                failedBotId: candidateBotId ?? null,
                nextBotId: candidateBotIds[0] ?? null,
                statusCode: this.extractStatusCode(error),
              },
              'Retrying routed MAX action preparation with survivor after a definitive bot-scoped request rejection',
            );
            continue;
          }
          await this.recordLedgerFailed(attemptJob, error, {
            exhausted: options.finalAttempt === true,
          });
          throw error;
        }

        const terminalManagedEntityOutcome = await this.resolveTerminalManagedEntityOutcome(
          attemptJob,
          error,
          dispatchAttemptStartedAt,
        );
        if (terminalManagedEntityOutcome?.kind === 'skipped') {
          await this.recordLedgerSkipped(attemptJob, terminalManagedEntityOutcome.reason);
          return;
        }
        if (terminalManagedEntityOutcome?.kind === 'failed') {
          lastAccessError = terminalManagedEntityOutcome.error;
          const replacementBotId = terminalManagedEntityOutcome.replacementBotId;
          if (
            replacementBotId &&
            this.isRequiredBotCandidate(replacementBotId, job.routing?.requiredBotId) &&
            !attemptedBotIds.includes(replacementBotId) &&
            !candidateBotIds.includes(replacementBotId)
          ) {
            candidateBotIds.unshift(replacementBotId);
          }
          if (candidateBotIds.length > 0 && this.isRoutedJob(job) && routedFailoverEnabled) {
            this.logger.warn(
              {
                actionType: job.actionType,
                chatId: job.chatId,
                failedBotId: candidateBotId ?? null,
                nextBotId: candidateBotIds[0] ?? null,
              },
              'Retrying routed MAX action with survivor after definitive bot-scoped access rejection',
            );
            continue;
          }

          await this.recordLedgerFailed(attemptJob, terminalManagedEntityOutcome.error);
          throw terminalManagedEntityOutcome.error;
        }
        if (
          !isMaxMutationOutcomeAmbiguous(error) &&
          this.extractStatusCode(error) === 403 &&
          this.isRoutedJob(job) &&
          routedFailoverEnabled &&
          candidateBotId &&
          (job.actionType === 'DELETE_MESSAGE' ||
            job.actionType === 'BAN_MEMBER' ||
            job.actionType === 'KICK_MEMBER')
        ) {
          await this.refreshStaleRoutedCandidateAccess(
            attemptJob,
            candidateBotIds,
            attemptedBotIds,
            halfOpenRouteState,
            allowHalfOpenProbe,
            true,
          );
          if (candidateBotIds.length > 0) continue;
        }
        await this.recordLedgerFailed(attemptJob, error, {
          exhausted: options.finalAttempt === true,
        });
        throw error;
      }
    }

    const terminalError =
      lastAccessError ??
      lastPreDispatchError ??
      new UnrecoverableError(
        `MAX ${job.actionType} has no executable routed bot candidate for chat ${job.chatId}`,
      );
    await this.recordLedgerFailed(
      {
        ...job,
        ...(trackAttemptedBotIds ? { attemptedBotIds } : {}),
      },
      terminalError,
    );
    throw terminalError;
  }

  private async assertLegacyEffectsAllowed(job: MaxActionJob): Promise<void> {
    if (!this.legacyHolds) return;
    try {
      await assertLegacyActionAllowed(this.legacyHolds, job);
    } catch (error) {
      // FLAG: Preserve denial for the client's exact SEND receipt recovery. Turning
      // a saved receipt into permission would still run the caller's new-effect guard.
      const code =
        job.actionType === 'SEND_MESSAGE'
          ? MAX_SEND_PRE_DISPATCH_GUARD_REJECTED_CODE
          : job.actionType === 'DELETE_MESSAGE'
            ? MAX_DELETE_PRE_DISPATCH_GUARD_REJECTED_CODE
            : MAX_MEMBER_PRE_DISPATCH_GUARD_REJECTED_CODE;
      throw markMaxPreDispatchGuardRejected(error, code);
    }
  }

  private async resolveExecutionCandidateBotIds(
    job: MaxActionJob,
    options: { enforceFreshRoute: boolean; allowHalfOpenProbe: boolean },
  ): Promise<{
    candidateBotIds: string[];
    halfOpenCandidateBotIds: string[];
    retryAt: Date | null;
  }> {
    const storedCandidates = this.filterRequiredBotCandidate(
      this.normalizeBotIds([job.botId, ...(job.candidateBotIds ?? [])]),
      job.routing?.requiredBotId,
    );
    // FLAG: Publisher readiness owns this route. Publik deliberately has no ChatBotMembership,
    // so the generic ownership resolver must not replace or reject its exact stored candidate.
    if (job.routing?.purpose === 'publisher_exact_send') {
      return { candidateBotIds: storedCandidates, halfOpenCandidateBotIds: [], retryAt: null };
    }
    if (!job.routing || !this.maxBotLinkService) {
      return { candidateBotIds: storedCandidates, halfOpenCandidateBotIds: [], retryAt: null };
    }

    try {
      const route =
        job.routing.purpose === 'channel_poll' &&
        typeof this.maxBotLinkService.resolveBotRouteForManagedPoll === 'function'
          ? await this.maxBotLinkService.resolveBotRouteForManagedPoll({ chatId: job.chatId })
          : await this.maxBotLinkService.resolveBotRoute(this.buildRouteRequest(job));
      const routingVersionChanged =
        typeof job.routing.routingVersion === 'number' &&
        typeof route.routingVersion === 'number' &&
        job.routing.routingVersion !== route.routingVersion;
      if (routingVersionChanged) {
        this.logger.warn(
          {
            actionType: job.actionType,
            chatId: job.chatId,
            queuedRoutingVersion: job.routing.routingVersion,
            currentRoutingVersion: route.routingVersion,
          },
          'Recalculated stale routed MAX action before dispatch',
        );
      }
      const refreshedCandidates = this.filterRequiredBotCandidate(
        this.normalizeBotIds(route.candidateBotIds),
        job.routing?.requiredBotId,
      );
      if (refreshedCandidates.length === 0) {
        if (
          route.purpose === 'send_message' &&
          (route.quarantinedCandidateBotIds?.length ?? 0) > 0 &&
          route.retryAt
        ) {
          throw new MaxActionRouteQuarantinedError(
            job.actionType,
            job.chatId,
            route.retryAt,
            route.quarantinedCandidateBotIds ?? [],
          );
        }
        return { candidateBotIds: [], halfOpenCandidateBotIds: [], retryAt: null };
      }
      const halfOpenCandidateBotId = this.normalizeBotIds(
        route.purpose === 'send_message' ? (route.halfOpenCandidateBotIds ?? []) : [],
      ).find((botId) => refreshedCandidates.includes(botId));
      if (halfOpenCandidateBotId) {
        if (!options.allowHalfOpenProbe) {
          throw new MaxActionRouteQuarantinedError(
            job.actionType,
            job.chatId,
            route.purpose === 'send_message' && route.retryAt
              ? route.retryAt
              : new Date(Date.now() + 15 * 60_000),
            [halfOpenCandidateBotId],
          );
        }
      }
      if (routingVersionChanged) {
        return {
          candidateBotIds: refreshedCandidates,
          halfOpenCandidateBotIds: halfOpenCandidateBotId ? [halfOpenCandidateBotId] : [],
          retryAt: route.purpose === 'send_message' ? (route.retryAt ?? null) : null,
        };
      }
      const stillEligibleStoredCandidates = storedCandidates.filter((botId) =>
        refreshedCandidates.includes(botId),
      );
      return {
        candidateBotIds: options.enforceFreshRoute
          ? refreshedCandidates
          : stillEligibleStoredCandidates.length > 0
            ? [
                ...stillEligibleStoredCandidates,
                ...refreshedCandidates.filter(
                  (botId) => !stillEligibleStoredCandidates.includes(botId),
                ),
              ]
            : refreshedCandidates,
        halfOpenCandidateBotIds: halfOpenCandidateBotId ? [halfOpenCandidateBotId] : [],
        retryAt: route.purpose === 'send_message' ? (route.retryAt ?? null) : null,
      };
    } catch (error: unknown) {
      if (isMaxActionRouteQuarantinedError(error)) {
        throw error;
      }
      this.logger.warn(
        {
          actionType: job.actionType,
          chatId: job.chatId,
          error: this.extractErrorMessage(error),
        },
        options.enforceFreshRoute || options.allowHalfOpenProbe
          ? 'Failed to refresh routed MAX action candidates in worker; retrying before dispatch'
          : 'Failed to refresh routed MAX action candidates in shadow mode; using queued candidates',
      );
      // FLAG: A half-open candidate is executable only with authoritative route state and its
      // atomic claim. Falling back to a stored candidate would bypass the quarantine fence.
      if (options.enforceFreshRoute || options.allowHalfOpenProbe) {
        throw error;
      }
      return { candidateBotIds: storedCandidates, halfOpenCandidateBotIds: [], retryAt: null };
    }
  }

  private buildRouteRequest(job: MaxActionJob): MaxBotRouteRequest {
    const stickyProbeFailureBefore = this.readFutureNightStickyProbeFailureBefore(job);
    return job.routing?.purpose === 'send_message' || job.routing?.purpose === 'channel_poll'
      ? {
          purpose: 'send_message',
          chatId: job.chatId,
          fallbackToPrimary: true,
          allowHalfOpenProbe:
            job.routing?.sendRouteHalfOpenProbe === 'publication_exact_verification',
          ...(stickyProbeFailureBefore
            ? { stickyHalfOpenProbeFailureBefore: stickyProbeFailureBefore }
            : {}),
        }
      : {
          purpose: 'moderation_action',
          chatId: job.chatId,
          action: job.routing?.action ?? 'moderate_member',
          fallbackToPrimary: true,
        };
  }

  private async claimSendRouteHalfOpen(job: MaxActionJob, botId: string): Promise<Date | null> {
    const claim = (
      this.maxBotLinkService as
        | (MaxBotLinkService & {
            claimSendRouteHalfOpen?: MaxBotLinkService['claimSendRouteHalfOpen'];
          })
        | undefined
    )?.claimSendRouteHalfOpen;
    if (typeof claim !== 'function' || !this.maxBotLinkService) {
      return null;
    }
    const stickyProbeFailureBefore = this.readFutureNightStickyProbeFailureBefore(job);
    return claim.call(this.maxBotLinkService, {
      chatId: job.chatId,
      botId,
      ...(stickyProbeFailureBefore ? { stickyProbeFailureBefore } : {}),
    });
  }

  private async releaseSendRouteHalfOpenSafely(
    job: MaxActionJob,
    botId: string,
    claimedUntil: Date,
  ): Promise<void> {
    const release = (
      this.maxBotLinkService as
        | (MaxBotLinkService & {
            releaseSendRouteHalfOpen?: MaxBotLinkService['releaseSendRouteHalfOpen'];
          })
        | undefined
    )?.releaseSendRouteHalfOpen;
    if (typeof release !== 'function' || !this.maxBotLinkService) {
      return;
    }
    try {
      const stickyProbeFailureBefore = this.readFutureNightStickyProbeFailureBefore(job);
      await release.call(this.maxBotLinkService, {
        chatId: job.chatId,
        botId,
        claimedUntil,
        ...(stickyProbeFailureBefore ? { stickyProbeFailureBefore } : {}),
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          actionType: job.actionType,
          chatId: job.chatId,
          botId,
          error: this.extractErrorMessage(error),
        },
        'Failed to release a pre-dispatch MAX send-route half-open claim',
      );
    }
  }

  private async refreshStaleRoutedCandidateAccess(
    job: MaxActionJob,
    remainingCandidateBotIds: string[],
    attemptedBotIds: readonly string[],
    halfOpenRouteState: HalfOpenRouteState,
    allowHalfOpenProbe = false,
    force = false,
  ): Promise<boolean> {
    const botId = job.botId?.trim() ?? '';
    const maxAgeMs = this.resolveAccessSnapshotMaxAgeMs(job.actionType);
    const linkService = this.maxBotLinkService as
      | (MaxBotLinkService & {
          isBotAccessSnapshotStale?: MaxBotLinkService['isBotAccessSnapshotStale'];
          recordBotAccessProbe?: MaxBotLinkService['recordBotAccessProbe'];
        })
      | undefined;
    if (
      !botId ||
      maxAgeMs === null ||
      typeof linkService?.isBotAccessSnapshotStale !== 'function' ||
      typeof linkService.recordBotAccessProbe !== 'function'
    ) {
      return true;
    }

    const stale = await linkService.isBotAccessSnapshotStale({
      chatId: job.chatId,
      botId,
      maxAgeMs,
    });
    if (!stale && !force) {
      return true;
    }

    const accessProbeStartedAt = new Date();
    let access: Awaited<ReturnType<MaxClientService['getCurrentChatMemberAccess']>> | null;
    let lastErrorCode: string | null = null;
    let terminalAccessLookupError: unknown | null = null;
    try {
      access = await this.maxClient.getCurrentChatMemberAccess(job.chatId, {
        botId,
        bypassCache: true,
        trafficClass: job.trafficClass ?? 'critical',
        actionHealthLane: job.actionHealthLane,
        sourceTag: job.sourceTag ?? 'routed_action_access_preflight',
        timeoutMs: job.timeoutMs,
      });
    } catch (error: unknown) {
      // FLAG: Opaque member lookup errors abort this preflight without erasing
      // the persisted grant or fabricating a new denial epoch.
      lastErrorCode = resolveExplicitMembershipAccessDenial(error);
      if (!lastErrorCode) {
        throw error;
      }
      terminalAccessLookupError = error;
      access = null;
    }
    const persisted = await linkService.recordBotAccessProbe({
      chatId: job.chatId,
      botId,
      access,
      source: 'routed_action_preflight',
      checkedAt: accessProbeStartedAt,
      ...(lastErrorCode ? { lastErrorCode } : {}),
    });
    if (terminalAccessLookupError && this.managedEntityAccessLossService) {
      await this.managedEntityAccessLossService.recordIfManagedEntityAccessLost({
        chatId: job.chatId,
        botId,
        operation: 'lookup',
        source: 'max_action:routed_access_preflight',
        error: terminalAccessLookupError,
        lifecycleEventAt: accessProbeStartedAt,
        lifecycleEventType: 'live_probe',
        lifecycleSource: 'live_probe',
      });
    }
    if (!persisted) {
      if (!job.routing) {
        return false;
      }

      // Another lifecycle/probe write won the CAS. Re-read its persisted route:
      // a removal must stay closed, while a newer confirmed grant may proceed.
      const currentResolution = await this.resolveExecutionCandidateBotIds(job, {
        enforceFreshRoute: true,
        allowHalfOpenProbe,
      });
      this.replaceHalfOpenRouteState(halfOpenRouteState, currentResolution);
      this.replaceRemainingCandidates(
        remainingCandidateBotIds,
        currentResolution.candidateBotIds,
        attemptedBotIds,
      );
      return currentResolution.candidateBotIds.includes(botId);
    }

    if (!job.routing) {
      return true;
    }
    const refreshedResolution = await this.resolveExecutionCandidateBotIds(job, {
      enforceFreshRoute: true,
      allowHalfOpenProbe,
    });
    this.replaceHalfOpenRouteState(halfOpenRouteState, refreshedResolution);
    const refreshedCandidates = refreshedResolution.candidateBotIds;
    this.replaceRemainingCandidates(remainingCandidateBotIds, refreshedCandidates, attemptedBotIds);
    if (refreshedCandidates.includes(botId)) {
      return true;
    }

    this.logger.warn(
      {
        actionType: job.actionType,
        chatId: job.chatId,
        botId,
        nextBotId: remainingCandidateBotIds[0] ?? null,
      },
      'Skipped routed MAX action candidate after a fresh access probe removed its capability',
    );
    return false;
  }

  private replaceRemainingCandidates(
    remainingCandidateBotIds: string[],
    authoritativeCandidateBotIds: readonly string[],
    attemptedBotIds: readonly string[],
  ): void {
    const attempted = new Set(attemptedBotIds);
    remainingCandidateBotIds.splice(
      0,
      remainingCandidateBotIds.length,
      ...authoritativeCandidateBotIds.filter((candidateBotId) => !attempted.has(candidateBotId)),
    );
  }

  private replaceHalfOpenRouteState(
    state: HalfOpenRouteState,
    resolution: { halfOpenCandidateBotIds: readonly string[]; retryAt: Date | null },
  ): void {
    state.candidateBotIds.clear();
    for (const botId of resolution.halfOpenCandidateBotIds) {
      state.candidateBotIds.add(botId);
    }
    state.retryAt = resolution.retryAt;
  }

  private readFutureNightStickyProbeFailureBefore(job: MaxActionJob): string | undefined {
    if (
      job.actionType !== 'SEND_MESSAGE' ||
      job.routing?.purpose !== 'send_message' ||
      job.routing.sendRouteHalfOpenProbe !== 'publication_exact_verification'
    ) {
      return undefined;
    }
    return (
      parseMaxFutureNightStickyRouteProbe(job.routing.sendRouteStickyProbe, {
        chatId: job.chatId,
        idempotencyKey: job.idempotencyKey,
        sourceTag: job.sourceTag,
        occurredAt: job.createdAt,
      })?.failureBefore ?? undefined
    );
  }

  private resolveAccessSnapshotMaxAgeMs(actionType: MaxActionJob['actionType']): number | null {
    if (actionType === 'SEND_MESSAGE' || actionType === 'NOTIFY_MODERATORS') {
      return ROUTED_SEND_ACCESS_MAX_AGE_MS;
    }
    if (
      actionType === 'DELETE_MESSAGE' ||
      actionType === 'KICK_MEMBER' ||
      actionType === 'BAN_MEMBER' ||
      actionType === 'TRY_UNBAN_MEMBER' ||
      actionType === 'UNBAN_MEMBER'
    ) {
      return ROUTED_DESTRUCTIVE_ACCESS_MAX_AGE_MS;
    }
    return null;
  }

  private isExecutableCandidate(botId: string): boolean {
    if (!botId || !this.maxBotLinkService) {
      return true;
    }
    return Boolean(this.maxBotLinkService.getExecutableBotById(botId));
  }

  private isDefinitivePreparationCandidateRejection(error: unknown): boolean {
    const statusCode = this.extractStatusCode(error);
    return statusCode === 401 || statusCode === 403;
  }

  private isRoutedJob(job: MaxActionJob): boolean {
    return Boolean(job.routing) || (job.candidateBotIds?.length ?? 0) > 1;
  }

  private shouldEnforceRoutedFailover(job: MaxActionJob): boolean {
    if (!this.isRoutedJob(job)) {
      return false;
    }

    return shouldEnforceMaxRoutedMutation({
      mode: this.routedMutationsMode,
      canaryPercent: this.routedMutationsCanaryPercent,
      canaryEntityIds: this.routedMutationsCanaryEntityIds,
      entityId: job.chatId,
      rolloutKey: `${job.idempotencyKey}:${job.chatId}`,
    });
  }

  private readBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value !== 'string') {
      return fallback;
    }
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
    return fallback;
  }

  private readTrimmedString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private normalizeBotIds(values: readonly unknown[]): string[] {
    return Array.from(
      new Set(
        values
          .map((value) => (typeof value === 'string' ? value.trim() : ''))
          .filter((value) => value.length > 0),
      ),
    );
  }

  private filterRequiredBotCandidate(candidateBotIds: string[], requiredBotId: unknown): string[] {
    const required = typeof requiredBotId === 'string' ? requiredBotId.trim() : '';
    if (!required) {
      return candidateBotIds;
    }
    return candidateBotIds.includes(required) ? [required] : [];
  }

  private isRequiredBotCandidate(botId: string, requiredBotId: unknown): boolean {
    const required = typeof requiredBotId === 'string' ? requiredBotId.trim() : '';
    return !required || botId === required;
  }

  private async resolveTerminalManagedEntityOutcome(
    job: MaxActionJob,
    error: unknown,
    dispatchAttemptStartedAt: Date,
  ): Promise<TerminalManagedEntityOutcome | null> {
    if (isMaxMutationOutcomeAmbiguous(error)) return null;
    // Publisher access failures update PublisherEntityBinding through the publisher health hook.
    // Writing them through the generic path would incorrectly create ChatBotMembership ownership.
    if (job.routing?.purpose === 'publisher_exact_send') {
      return null;
    }
    if (!this.managedEntityAccessLossService) {
      return null;
    }

    const operation = this.resolveAccessLossOperation(job);
    if (!operation) {
      return null;
    }

    const result = await this.managedEntityAccessLossService.recordIfManagedEntityAccessLost({
      chatId: job.chatId,
      botId: job.botId,
      operation,
      source: `max_action:${job.actionType.toLowerCase()}`,
      error,
      lifecycleEventAt: dispatchAttemptStartedAt,
      lifecycleEventType: 'live_probe',
      lifecycleSource: 'live_probe',
    });

    if (!result) {
      return null;
    }

    if (result.classification.kind === 'message_not_found' && job.actionType === 'DELETE_MESSAGE') {
      this.logger.debug(
        {
          chatId: job.chatId,
          messageId: job.messageId,
          actionType: job.actionType,
          code: result.classification.code,
        },
        'Skipped queued MAX delete for already missing message',
      );
      return {
        kind: 'skipped',
        reason: this.extractErrorMessage(error),
      };
    }

    if (result.reason) {
      return {
        kind: 'failed',
        error: this.createTerminalManagedEntityError(
          job,
          result.reason,
          error,
          Boolean(result.recorded),
        ),
        replacementBotId: result.recorded?.nextOwnerBotId ?? null,
      };
    }

    return null;
  }

  private resolveAccessLossOperation(job: MaxActionJob): ManagedEntityAccessLossOperation | null {
    switch (job.actionType) {
      case 'DELETE_MESSAGE':
        return 'delete';
      case 'SEND_MESSAGE':
      case 'NOTIFY_MODERATORS':
        return 'send';
      case 'KICK_MEMBER':
      case 'BAN_MEMBER':
      case 'TRY_UNBAN_MEMBER':
      case 'UNBAN_MEMBER':
        return 'member_moderation';
      default:
        return null;
    }
  }

  private async recordLedgerSucceeded(job: MaxActionJob): Promise<void> {
    try {
      if (job.sendAutoDelete && !this.actionLedgerService) {
        throw new Error('Send-side auto-delete success requires the MAX action ledger');
      }
      await this.actionLedgerService?.recordSucceeded(job);
    } catch (error: unknown) {
      if (job.sendAutoDelete && this.actionLedgerService) {
        try {
          if (await this.actionLedgerService.hasRecordedVerifiedSendAutoDeleteSuccess(job)) {
            return;
          }
        } catch {
          // Preserve the original write failure for the worker retry path.
        }
      }
      this.logger.warn(
        {
          actionType: job.actionType,
          chatId: job.chatId,
          botId: job.botId,
          error: this.extractErrorMessage(error),
        },
        'Failed to record successful MAX action ledger outcome',
      );
      if (job.sendAutoDelete) {
        throw error;
      }
    }
  }

  private async recordLedgerSkipped(job: MaxActionJob, reason: string): Promise<void> {
    try {
      await this.actionLedgerService?.recordSkipped(job, reason);
    } catch (error: unknown) {
      this.logger.warn(
        {
          actionType: job.actionType,
          chatId: job.chatId,
          botId: job.botId,
          error: this.extractErrorMessage(error),
        },
        'Failed to record skipped MAX action ledger outcome',
      );
    }
  }

  private async recordLedgerFailed(
    job: MaxActionJob,
    error: unknown,
    options: { exhausted?: boolean } = {},
  ): Promise<void> {
    try {
      if (options.exhausted === undefined) {
        await this.actionLedgerService?.recordFailed(job, error);
      } else {
        await this.actionLedgerService?.recordFailed(job, error, options);
      }
    } catch (ledgerError: unknown) {
      this.logger.warn(
        {
          actionType: job.actionType,
          chatId: job.chatId,
          botId: job.botId,
          error: this.extractErrorMessage(ledgerError),
          originalError: this.extractErrorMessage(error),
        },
        'Failed to record failed MAX action ledger outcome',
      );
    }
  }

  private async persistAccessAmbiguousAutoDeleteFailure(
    job: MaxActionJob,
    error: unknown,
  ): Promise<boolean> {
    if (!this.actionLedgerService) {
      return false;
    }

    try {
      await this.actionLedgerService.recordFailed(job, error, { exhausted: true });
      return true;
    } catch {
      this.logger.warn(
        { actionType: job.actionType },
        'Failed to terminalize access-ambiguous send-side auto-delete verification in the ledger',
      );
      return false;
    }
  }

  private createTerminalManagedEntityError(
    job: MaxActionJob,
    reason: string,
    error: unknown,
    accessLossRecorded: boolean,
  ): UnrecoverableError {
    const terminalError = new UnrecoverableError(
      `MAX ${job.actionType} cannot be retried for chat ${job.chatId}: ${reason}`,
    );
    const response = (error as { response?: unknown })?.response;
    if (response !== undefined) {
      (terminalError as UnrecoverableError & { response?: unknown }).response = response;
    }
    const code = (error as { code?: unknown })?.code;
    if (code !== undefined) {
      (terminalError as UnrecoverableError & { code?: unknown }).code = code;
    }
    (
      terminalError as UnrecoverableError & { maxManagedEntityAccessLossRecorded?: boolean }
    ).maxManagedEntityAccessLossRecorded = accessLossRecorded;
    return terminalError;
  }

  private extractErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message.trim();
    }

    return String(error).trim();
  }

  private extractStatusCode(error: unknown): number | null {
    const statusCode = (error as { response?: { status?: unknown } })?.response?.status;
    return typeof statusCode === 'number' && Number.isInteger(statusCode) ? statusCode : null;
  }
}
