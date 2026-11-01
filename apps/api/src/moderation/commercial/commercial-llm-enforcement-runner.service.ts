import { randomUUID } from 'node:crypto';
import { Injectable, Logger, Optional, type OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { BackgroundRuntimeGovernorService } from '../../system/background-runtime-governor.service';
import { ModerationDeleteIntentService } from '../moderation-delete-intent.service';
import { CommercialLlmEnforcementService } from './commercial-llm-enforcement.service';
import { CommercialLlmEnforcementProcessor } from './commercial-llm-enforcement.processor';
import { CommercialLlmCascadeClient } from './commercial-llm-cascade.client';
import { CommercialLlmClient, CommercialLlmError } from './commercial-llm.client';
import type { CommercialLlmClassifier } from './commercial-llm.protocol';
import { CommercialLlmWorkstationMailbox } from './commercial-llm-workstation.mailbox';
import { CommercialLlmShadowLease, createCommercialLlmRedis } from './commercial-llm-shadow.lease';
import { commercialLlmHostHasHeadroom } from './commercial-llm-shadow.processor';
import {
  COMMERCIAL_LLM_ENFORCEMENT_KEYS,
  COMMERCIAL_LLM_POLL_INTERVAL_MS,
} from './commercial-llm-enforcement.mailbox';
import { CommercialLlmSecondaryScheduler } from './commercial-llm-secondary-scheduler';
import { CommercialLlmPoolMailbox } from './commercial-llm-pool.mailbox';
import {
  CommercialLlmPoolClient,
  CommercialLlmPoolRoutingStats,
} from './commercial-llm-pool.client';
import { CommercialLlmPoolServer } from './commercial-llm-pool-server';
import { COMMERCIAL_LLM_POOL_ADMISSION_KEYS } from './commercial-llm-pool-admission.mailbox';
import { CommercialAiObservationService } from './commercial-ai-observation.service';
import { CommercialAiObservationGate } from './commercial-ai-runtime-observation';

@Injectable()
export class CommercialLlmEnforcementRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CommercialLlmEnforcementRunnerService.name);
  private readonly worker = randomUUID();
  private readonly observationProcessId = randomUUID();
  private readonly observationStartedAt = new Date().toISOString();
  private readonly controller = new AbortController();
  private redis: Redis | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polling: Promise<void> | null = null;
  private readonly active = new Set<Promise<void>>();
  private secondary: CommercialLlmSecondaryScheduler | null = null;
  private pool: CommercialLlmPoolMailbox | null = null;
  private poolServer: CommercialLlmPoolServer | null = null;
  private readonly retiredPoolServers = new Set<Promise<void>>();
  private readonly poolRoutingStats = new CommercialLlmPoolRoutingStats();
  private readonly poolConsultations = { completed: 0, noCapacity: 0, budgetExhausted: 0 };
  private lastSuccessAt: string | null = null;
  private lastStatusAt = 0;
  private lastFailureAt = 0;
  private readonly outcomes: Record<string, number> = {};
  private availabilityState: 'unknown' | 'ready' | 'governor_paused' | 'headroom_paused' =
    'unknown';
  private availabilityObservedAt: string | null = null;
  constructor(
    private readonly config: ConfigService,
    private readonly admission: CommercialLlmEnforcementService,
    private readonly governor: BackgroundRuntimeGovernorService,
    private readonly intents: ModerationDeleteIntentService,
    @Optional() private readonly observations?: CommercialAiObservationService,
    @Optional()
    private readonly observationGate: CommercialAiObservationGate = new CommercialAiObservationGate(),
  ) {}

  onModuleInit(): void {
    if (
      (!this.admission.enabled() && !this.poolWorkersEnabled()) ||
      this.config.get<string>('APP_SERVICE_NAME') !== 'api-moderation-background'
    )
      return;
    this.timer = setInterval(() => this.wake(), COMMERCIAL_LLM_POLL_INTERVAL_MS);
    this.timer.unref();
  }

  private wake(): void {
    if (this.polling || this.controller.signal.aborted) return;
    this.polling = this.poll()
      .catch(() => this.logDependencyFailure())
      .finally(() => {
        this.polling = null;
      });
  }

  private logDependencyFailure(): void {
    if (Date.now() - this.lastFailureAt < 10_000) return;
    this.lastFailureAt = Date.now();
    this.logger.warn(
      {
        stage: 'commercial-ai-worker',
        ...this.observationIdentity(),
        outcome: 'dependency_unavailable',
      },
      'Commercial AI poll unavailable',
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.controller.abort();
    await this.polling;
    // FLAG: Drain actual work before closing Redis; a stopped poll never releases an unfinished model lease.
    await Promise.allSettled([...this.active]);
    await this.poolServer?.close();
    await Promise.allSettled([...this.retiredPoolServers]);
    await this.admission
      .mailbox()
      .then((mailbox) => mailbox.withdraw(this.worker))
      .catch(() => undefined);
    this.redis?.disconnect();
  }

  private async mayRun(): Promise<boolean> {
    const decision = await this.governor.decide({
      component: 'commercial-llm-shadow',
      sourceTag: 'commercial-llm-shadow',
      // FLAG: Resume classification in healthy automatic recovery; fresh queue/host pressure,
      // manual/MAX degradation and the final source-bound DELETE guards still apply.
      allowRecoveryWindowRun: true,
    });
    const headroom =
      decision.action === 'run' &&
      (!!this.admission.poolPolicy() || (await commercialLlmHostHasHeadroom()));
    // FLAG: Observe the existing gate only. This is its last completed check, not model
    // readiness or authority to start another request; the status retains that observation clock.
    this.availabilityState =
      decision.action !== 'run' ? 'governor_paused' : headroom ? 'ready' : 'headroom_paused';
    this.availabilityObservedAt = new Date().toISOString();
    return headroom;
  }

  private poolWorkersEnabled(): boolean {
    return this.config.get<boolean>('COMMERCIAL_LLM_POOL_WORKERS_ENABLED', false) === true;
  }

  private async writeStatus(outcome = 'idle'): Promise<void> {
    if (!this.redis) return;
    this.lastStatusAt = Date.now();
    const pendingDiscards = await (await this.admission.mailbox()).readObservations();
    const status = {
      stage: 'commercial-ai',
      schemaVersion: 2,
      ...this.observationIdentity(),
      mode: 'ENFORCE',
      heartbeatAt: new Date().toISOString(),
      lastSuccessAt: this.lastSuccessAt,
      outcome: this.active.size > 0 ? 'active' : outcome,
      active: this.active.size,
      availabilityState: this.availabilityState,
      availabilityObservedAt: this.availabilityObservedAt,
      outcomeBasis: 'process_cumulative',
      outcomes: { ...this.outcomes },
      pendingDiscardBasis: 'redis_namespace_cumulative',
      pendingDiscards,
      evidenceWrites: this.observationGate.snapshot(),
      ...(this.admission.poolPolicy()
        ? {
            poolDiagnostics: {
              schemaVersion: 1,
              nodes: this.poolRoutingStats.snapshot(),
              consultations: { ...this.poolConsultations },
            },
          }
        : {}),
    };
    await this.redis.set(
      (this.admission.poolPolicy()
        ? COMMERCIAL_LLM_POOL_ADMISSION_KEYS
        : COMMERCIAL_LLM_ENFORCEMENT_KEYS
      ).status,
      JSON.stringify(status),
      'EX',
      30,
    );
    this.logger.log(
      { ...status, stage: 'commercial-ai-cumulative' },
      'Commercial AI cumulative results',
    );
  }

  private observationIdentity() {
    return {
      observationProcessId: this.observationProcessId,
      observationStartedAt: this.observationStartedAt,
    };
  }

  private async poll(): Promise<void> {
    if (this.controller.signal.aborted) return;
    const mailbox = this.admission.enabled() ? await this.admission.mailbox() : null;
    if (mailbox && !(await mailbox.heartbeat(this.worker))) return;
    if (!this.redis || this.redis.status !== 'ready') {
      if (this.poolServer) {
        // FLAG: A Redis replacement never abandons an older adapter's actual HTTP drain.
        const closing = this.poolServer
          .close()
          .finally(() => this.retiredPoolServers.delete(closing));
        this.retiredPoolServers.add(closing);
      }
      this.redis?.disconnect();
      this.redis = createCommercialLlmRedis(this.config.getOrThrow<string>('REDIS_URL'));
      await this.redis.connect();
      const client = new CommercialLlmClient({
        endpoint: this.config.getOrThrow<string>('COMMERCIAL_LLM_ENDPOINT'),
      });
      this.secondary = new CommercialLlmSecondaryScheduler(
        new CommercialLlmShadowLease(this.redis),
        client,
        (outcome, waitMs) =>
          this.logger.log(
            {
              stage: 'commercial-ai-secondary',
              ...this.observationIdentity(),
              outcome,
              waitMs,
            },
            'Commercial AI confirmation admission',
          ),
      );
      if (this.poolWorkersEnabled()) {
        this.pool = new CommercialLlmPoolMailbox(this.redis);
        this.poolServer = new CommercialLlmPoolServer(
          this.redis,
          this.pool,
          this.config.getOrThrow<string>('COMMERCIAL_LLM_ENDPOINT'),
          commercialLlmHostHasHeadroom,
        );
      }
    }
    await this.poolServer?.tick();
    if (!mailbox || this.controller.signal.aborted) return;
    if (Date.now() - this.lastStatusAt >= 10_000) await this.writeStatus();
    if (!(await this.mayRun())) {
      await mailbox.withdraw(this.worker);
      return;
    }
    const poolHasNoCapacity =
      !!this.admission.poolPolicy() && !(await this.pool!.available()).length;
    if (poolHasNoCapacity && this.active.size === 0) {
      await mailbox.withdraw(this.worker);
      return;
    }
    await mailbox.advertise(this.worker);
    // FLAG: At most primary running + secondary running + one waiting confirmation.
    // The mailbox admits a second pending input only when both starts fit their original budget.
    if (this.active.size >= 3 || poolHasNoCapacity) return;
    const redis = this.redis;
    const secondary = this.secondary!;
    const processor = new CommercialLlmEnforcementProcessor(
      mailbox,
      ({ raw, request, deadlineAtMs }) => {
        const policy = this.admission.poolPolicy();
        if (policy) {
          if (request.source.version !== 2 || request.source.poolPolicy !== policy)
            throw new CommercialLlmError('INVALID_INPUT');
          const server = this.poolServer!;
          return new CommercialLlmPoolClient(
            this.pool!,
            (reservation, signal) => server.dispatch(reservation, signal),
            {
              jobId: request.source.nonce,
              routingStats: this.poolRoutingStats,
              deadlineAtMs,
              policy,
              primaryFinished: async () => {
                await mailbox.releasePrimary(raw, this.worker);
                this.wake();
              },
              canStartConsultation: async () =>
                (await this.mayRun()) && mailbox.claimSecondary(raw, this.worker),
              consultationFinished: async () => {
                await mailbox.releaseSecondary(raw, this.worker);
              },
            },
          );
        }
        if (request.source.version !== 1) throw new CommercialLlmError('INVALID_INPUT');
        const trace = {
          ...this.observationIdentity(),
          traceId: request.source.nonce,
          admittedAtMs: request.submittedAtMs,
        };
        const primary = new CommercialLlmWorkstationMailbox(redis);
        // FLAG: Both confirmation paths reserve the chat in Redis before server admission.
        // Releasing this claim never releases the exact active source or its DELETE proof.
        const withSecondary = async (
          classify: () => ReturnType<CommercialLlmClassifier['classify']>,
        ) => {
          if (!(await mailbox.claimSecondary(raw, this.worker)))
            throw new CommercialLlmError('BUSY');
          try {
            return await classify();
          } finally {
            await mailbox.releaseSecondary(raw, this.worker).catch(() => undefined);
          }
        };
        return new CommercialLlmCascadeClient(
          {
            classify: async (excerpt, signal) => {
              const result = await primary.classify(excerpt, signal);
              this.logger.log(
                {
                  stage: 'commercial-ai-primary',
                  ...trace,
                  outcome: result.outcome,
                  ...(result.outcome === 'COMPLETE'
                    ? { durationMs: result.result.durationMs }
                    : {}),
                },
                'Commercial AI primary result',
              );
              return result;
            },
          },
          {
            classify: (excerpt, signal, valid) =>
              withSecondary(() =>
                secondary.classifyWithin(excerpt, deadlineAtMs, signal, valid, (outcome, waitMs) =>
                  this.logger.log(
                    { stage: 'commercial-ai-secondary', ...trace, outcome, waitMs },
                    'Commercial AI confirmation admission',
                  ),
                ),
              ),
          },
          () => this.mayRun(),
          undefined,
          async () => {
            await mailbox.releasePrimary(raw, this.worker);
            this.wake();
          },
          // Audit negatives never occupy the one waiting slot needed by an actionable confirmation.
          {
            classify: (excerpt, signal, valid) =>
              withSecondary(() => secondary.classifyAudit(excerpt, signal, valid)),
          },
        );
      },
      this.intents,
      () => this.mayRun(),
      this.observations ? { writer: this.observations, gate: this.observationGate } : undefined,
    );
    const work = processor
      .run(this.worker, this.controller.signal)
      .then(async (result) => {
        const outcome = String(result.outcome);
        if (outcome === 'idle') return;
        if (outcome === 'kept' || outcome === 'unsure' || outcome === 'delete_registered')
          this.lastSuccessAt = new Date().toISOString();
        this.outcomes[outcome] = (this.outcomes[outcome] ?? 0) + 1;
        const consultation = result.consultationOutcome;
        const key =
          consultation === 'completed'
            ? 'completed'
            : consultation === 'no_capacity'
              ? 'noCapacity'
              : consultation === 'budget_exhausted'
                ? 'budgetExhausted'
                : null;
        if (key)
          this.poolConsultations[key] = Math.min(
            Number.MAX_SAFE_INTEGER,
            this.poolConsultations[key] + 1,
          );
        this.logger.log(
          {
            stage: 'commercial-ai',
            ...this.observationIdentity(),
            mode: 'ENFORCE',
            heartbeatAt: new Date().toISOString(),
            lastSuccessAt: this.lastSuccessAt,
            ...result,
          },
          'Commercial AI result',
        );
      })
      .catch(() => {
        this.outcomes.dependency_unavailable = (this.outcomes.dependency_unavailable ?? 0) + 1;
        this.logDependencyFailure();
      })
      .finally(() => {
        this.active.delete(work);
      });
    this.active.add(work);
  }
}
