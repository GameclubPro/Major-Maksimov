import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { CommercialLlmError, parseCommercialLlmEnvelope } from './commercial-llm.client';
import {
  buildCommercialLlmRequest,
  COMMERCIAL_LLM_POLICY_VERSION,
  type CommercialLlmClassifier,
  type CommercialLlmObservationResult,
} from './commercial-llm.protocol';
import type {
  CommercialLlmPoolMailbox,
  CommercialLlmPoolReservation,
} from './commercial-llm-pool.mailbox';
import {
  COMMERCIAL_LLM_POOL_PROFILES,
  commercialLlmPoolMinRemainingMs,
  COMMERCIAL_LLM_POOL_TIMEOUT_MS,
  POOL_NODE_IDS,
  commercialLlmPoolJobKey,
  type CommercialLlmPoolNodeId,
} from './commercial-llm-pool.protocol';

export type CommercialLlmPoolClientOptions = {
  jobId: string;
  deadlineAtMs: number;
  policy: 'confirm-positive' | 'direct-4b';
  confirmPersonalSales?: boolean;
  primaryFinished: () => Promise<void>;
  canStartConsultation: () => Promise<boolean>;
  consultationFinished?: () => Promise<void>;
  routingStats?: CommercialLlmPoolRoutingStats;
};
type Mailbox = Pick<CommercialLlmPoolMailbox, 'available' | 'reserve' | 'wait' | 'release'>;
export type CommercialLlmPoolServerDispatch = (
  reservation: CommercialLlmPoolReservation,
  signal: AbortSignal,
) => Promise<void>;

type RoutingSample = {
  latencyMs: number;
  sampled: boolean;
  failurePenaltyMs: number;
  penaltyAtMs: number;
  completedAttempts: number;
  failedAttempts: number;
  lastCompletedAt: string | null;
  lastFailureAt: string | null;
};

// FLAG: Process-local, bounded to the four trusted profiles. These measurements choose only
// among ready nodes; they never authorize moderation, create work, or override Redis capacity.
export class CommercialLlmPoolRoutingStats {
  private readonly samples: Record<CommercialLlmPoolNodeId, RoutingSample> = {
    'server-9b': this.seed(),
    'pc-a-4b': this.seed(),
    'pc-b-9b': this.seed(),
    'pc-a-cpu-9b': this.seed(),
  };

  rank(nodes: readonly CommercialLlmPoolNodeId[], nowMs = Date.now()): CommercialLlmPoolNodeId[] {
    return nodes
      .map((nodeId, index) => ({ nodeId, index, cost: this.cost(nodeId, nowMs) }))
      .sort((a, b) => a.cost - b.cost || a.index - b.index)
      .map(({ nodeId }) => nodeId);
  }

  recordSuccess(nodeId: CommercialLlmPoolNodeId, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const sample = this.samples[nodeId];
    const observed = Math.max(1, Math.min(COMMERCIAL_LLM_POOL_TIMEOUT_MS, durationMs));
    sample.latencyMs = sample.sampled ? sample.latencyMs * 0.75 + observed * 0.25 : observed;
    sample.sampled = true;
    sample.failurePenaltyMs = 0;
    sample.completedAttempts = Math.min(Number.MAX_SAFE_INTEGER, sample.completedAttempts + 1);
    sample.lastCompletedAt = new Date().toISOString();
  }

  recordFailure(nodeId: CommercialLlmPoolNodeId, nowMs = Date.now()): void {
    const sample = this.samples[nodeId];
    sample.failurePenaltyMs = Math.min(20_000, this.penalty(sample, nowMs) + 5000);
    sample.penaltyAtMs = nowMs;
    sample.failedAttempts = Math.min(Number.MAX_SAFE_INTEGER, sample.failedAttempts + 1);
    sample.lastFailureAt = new Date(nowMs).toISOString();
  }

  snapshot() {
    return POOL_NODE_IDS.map((nodeId) => {
      const sample = this.samples[nodeId];
      return {
        nodeId,
        completedAttempts: sample.completedAttempts,
        failedAttempts: sample.failedAttempts,
        lastCompletedAt: sample.lastCompletedAt,
        lastFailureAt: sample.lastFailureAt,
        ewmaDurationMs: sample.sampled ? Math.round(sample.latencyMs) : null,
      };
    });
  }

  private seed(): RoutingSample {
    return {
      latencyMs: 4000,
      sampled: false,
      failurePenaltyMs: 0,
      penaltyAtMs: 0,
      completedAttempts: 0,
      failedAttempts: 0,
      lastCompletedAt: null,
      lastFailureAt: null,
    };
  }

  private cost(nodeId: CommercialLlmPoolNodeId, nowMs: number): number {
    const sample = this.samples[nodeId];
    return sample.latencyMs + this.penalty(sample, nowMs);
  }

  private penalty(sample: RoutingSample, nowMs: number): number {
    return (
      sample.failurePenaltyMs * Math.pow(0.5, Math.max(0, nowMs - sample.penaltyAtMs) / 30_000)
    );
  }
}

export class CommercialLlmPoolClient implements CommercialLlmClassifier {
  constructor(
    private readonly mailbox: Mailbox,
    private readonly dispatchServer: CommercialLlmPoolServerDispatch,
    private readonly options: CommercialLlmPoolClientOptions,
  ) {
    commercialLlmPoolJobKey(options.jobId);
    if (
      !Number.isSafeInteger(options.deadlineAtMs) ||
      options.deadlineAtMs > Date.now() + COMMERCIAL_LLM_POOL_TIMEOUT_MS ||
      !['confirm-positive', 'direct-4b'].includes(options.policy)
    )
      throw new CommercialLlmError('INVALID_INPUT');
  }

  async classify(
    excerpt: string,
    signal?: AbortSignal,
    mayContinue?: () => Promise<boolean>,
  ): Promise<CommercialLlmObservationResult> {
    const startedAt = performance.now();
    const controller = new AbortController();
    const onAbort = () => {
      // AbortSignal.timeout uses DOMException, whose Error prototype can belong to another realm.
      const reason: unknown = signal?.reason;
      const timedOut =
        Date.now() >= this.options.deadlineAtMs ||
        (reason !== null &&
          typeof reason === 'object' &&
          'name' in reason &&
          reason.name === 'TimeoutError');
      controller.abort(new CommercialLlmError(timedOut ? 'TIMEOUT' : 'ABORTED'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timeout = setTimeout(
      () => controller.abort(new CommercialLlmError('TIMEOUT')),
      Math.max(0, this.options.deadlineAtMs - Date.now()),
    );
    const current = async () => {
      this.checkSignal(controller.signal);
      if (mayContinue && !(await this.bounded(mayContinue(), controller.signal)))
        throw new CommercialLlmError('ABORTED');
      this.checkSignal(controller.signal);
      if (Date.now() >= this.options.deadlineAtMs) throw new CommercialLlmError('TIMEOUT');
    };
    try {
      let primary: CommercialLlmObservationResult;
      try {
        await current();
        try {
          buildCommercialLlmRequest(excerpt);
        } catch {
          throw new CommercialLlmError('INVALID_INPUT');
        }
        primary = await this.primary(excerpt, controller.signal, current);
      } finally {
        // FLAG: The source remains owned, but another source may now use this chat's primary slot.
        await this.options.primaryFinished();
      }
      await current();
      const needsConsultation =
        primary.pool!.nodeId === 'pc-a-4b' &&
        this.options.policy === 'confirm-positive' &&
        (primary.classification === 'UNSURE' ||
          (this.options.confirmPersonalSales === true &&
            primary.classification === 'NOT_COMMERCIAL' &&
            primary.reasonCodes.length === 1 &&
            primary.reasonCodes[0] === 'PERSONAL_SALE') ||
          primary.classification === 'COMMERCIAL');
      if (!needsConsultation) return { ...primary, durationMs: elapsed(startedAt) };
      if (this.options.deadlineAtMs - Date.now() < 1000)
        return this.unresolved(primary, 'budget_exhausted', startedAt);
      if (!(await this.bounded(this.options.canStartConsultation(), controller.signal))) {
        await current();
        return this.unresolved(primary, 'no_capacity', startedAt);
      }
      try {
        await current();
        // FLAG: A consultation has its own terminal fence, never renews the source deadline,
        // never retries, and may reserve only idle 9B capacity after an atomic primary-priority check.
        const reservation = await this.reserve(
          excerpt,
          randomUUID(),
          1,
          new Set(),
          true,
          controller.signal,
          current,
        );
        if (!reservation) {
          await current();
          return this.unresolved(primary, 'no_capacity', startedAt);
        }
        const consulted = await this.run(reservation, controller.signal);
        await current();
        return {
          ...consulted,
          durationMs: elapsed(startedAt),
          pool: {
            ...consulted.pool!,
            route: 'consulted',
            attempts: primary.pool!.attempts,
            primaryNodeId: 'pc-a-4b',
            primaryClassification: primary.classification,
            primaryDurationMs: primary.durationMs,
            consultationDurationMs: consulted.durationMs,
            consultationOutcome: 'completed',
          },
        };
      } finally {
        await this.options.consultationFinished?.();
      }
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (error instanceof CommercialLlmError) throw error;
      throw new CommercialLlmError('UNAVAILABLE');
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async primary(
    excerpt: string,
    signal: AbortSignal,
    current: () => Promise<void>,
  ): Promise<CommercialLlmObservationResult> {
    const attempted = new Set<CommercialLlmPoolNodeId>();
    let lastError = new CommercialLlmError('BUSY');
    for (const attempt of [1, 2] as const) {
      await current();
      const reservation = await this.reserve(
        excerpt,
        this.options.jobId,
        attempt,
        attempted,
        false,
        signal,
        current,
      );
      if (!reservation) throw lastError;
      attempted.add(reservation.nodeId);
      try {
        const result = await this.run(reservation, signal);
        await current();
        return result;
      } catch (error) {
        this.checkSignal(signal);
        if (
          error instanceof CommercialLlmError &&
          ['ABORTED', 'INVALID_INPUT'].includes(error.kind)
        )
          throw error;
        lastError =
          error instanceof CommercialLlmError ? error : new CommercialLlmError('UNAVAILABLE');
      }
    }
    throw lastError;
  }

  private async reserve(
    excerpt: string,
    jobId: string,
    attempt: 1 | 2,
    attempted: Set<CommercialLlmPoolNodeId>,
    consultation: boolean,
    signal: AbortSignal,
    current: () => Promise<void>,
  ): Promise<CommercialLlmPoolReservation | null> {
    const available = await this.bounded(this.mailbox.available(), signal);
    // FLAG: Ready 9B capacity precedes 4B overflow. Measurements rank peers within each
    // model class; atomic reservation failure never waits or extends the original deadline.
    const offset = Number.parseInt(this.options.jobId.slice(-8), 16) % POOL_NODE_IDS.length;
    const order = [...POOL_NODE_IDS.slice(offset), ...POOL_NODE_IDS.slice(0, offset)];
    const ranked = this.options.routingStats?.rank(order) ?? order;
    const prioritized = [
      ...ranked.filter((nodeId) => COMMERCIAL_LLM_POOL_PROFILES[nodeId].model === '9b'),
      ...ranked.filter((nodeId) => COMMERCIAL_LLM_POOL_PROFILES[nodeId].model === '4b'),
    ];
    for (const nodeId of prioritized) {
      if (
        attempted.has(nodeId) ||
        !available.includes(nodeId) ||
        (consultation && COMMERCIAL_LLM_POOL_PROFILES[nodeId].model !== '9b')
      )
        continue;
      await current();
      // FLAG: Keep the measured CPU budget even after awaited authority checks;
      // a shorter original deadline may still use an available GPU, never a doomed CPU POST.
      if (this.options.deadlineAtMs - Date.now() < commercialLlmPoolMinRemainingMs(nodeId))
        continue;
      const reservation = await this.mailbox.reserve(
        nodeId,
        {
          jobId,
          attempt,
          deadlineAtMs: this.options.deadlineAtMs,
          body: JSON.stringify({
            ...buildCommercialLlmRequest(excerpt),
            model: COMMERCIAL_LLM_POOL_PROFILES[nodeId].identity.modelAlias,
          }),
        },
        { consultation },
      );
      if (reservation) return reservation;
    }
    return null;
  }

  private async run(
    reservation: CommercialLlmPoolReservation,
    signal: AbortSignal,
  ): Promise<CommercialLlmObservationResult> {
    const startedAt = performance.now();
    try {
      this.checkSignal(signal);
      if (reservation.nodeId === 'server-9b')
        await this.bounded(this.dispatchServer(reservation, signal), signal);
      const outcome = await this.bounded(this.mailbox.wait(reservation, signal), signal);
      this.checkSignal(signal);
      if (outcome.outcome !== 'COMPLETE')
        throw new CommercialLlmError(
          outcome.outcome === 'FAILED' ? 'INVALID_RESPONSE' : outcome.outcome,
          outcome.outcome === 'FAILED' ? outcome.responseIssue : undefined,
        );
      const identity = COMMERCIAL_LLM_POOL_PROFILES[reservation.nodeId].identity;
      const decision = parseCommercialLlmEnvelope(JSON.parse(outcome.body), identity.modelAlias);
      this.options.routingStats?.recordSuccess(reservation.nodeId, elapsed(startedAt));
      return {
        ...identity,
        ...decision,
        policyVersion: COMMERCIAL_LLM_POLICY_VERSION,
        durationMs: elapsed(startedAt),
        pool: {
          version: 'commercial-pool-v2',
          nodeId: reservation.nodeId,
          route: 'direct',
          policy: this.options.policy,
          attempts: reservation.attempt,
        },
      };
    } catch (error) {
      if (
        !signal.aborted ||
        (signal.reason instanceof CommercialLlmError && signal.reason.kind === 'TIMEOUT')
      )
        this.options.routingStats?.recordFailure(reservation.nodeId);
      throw error;
    } finally {
      // release() fences abandonment but deliberately retains uncertain physical computation.
      await this.mailbox.release(reservation).catch(() => undefined);
    }
  }

  private unresolved(
    primary: CommercialLlmObservationResult,
    outcome: 'no_capacity' | 'budget_exhausted',
    startedAt: number,
  ): CommercialLlmObservationResult {
    return {
      ...primary,
      classification: 'UNSURE',
      reasonCodes: ['INSUFFICIENT_CONTEXT'],
      durationMs: elapsed(startedAt),
      pool: {
        ...primary.pool!,
        primaryNodeId: 'pc-a-4b',
        primaryClassification: primary.classification,
        primaryDurationMs: primary.durationMs,
        consultationOutcome: outcome,
      },
    };
  }

  private checkSignal(signal: AbortSignal): void {
    if (signal.aborted)
      throw signal.reason instanceof CommercialLlmError
        ? signal.reason
        : new CommercialLlmError('ABORTED');
  }

  private async bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
    let rejectAborted: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = () => reject(signal.reason);
      signal.addEventListener('abort', rejectAborted, { once: true });
      if (signal.aborted) rejectAborted();
    });
    try {
      return await Promise.race([operation, aborted]);
    } finally {
      if (rejectAborted) signal.removeEventListener('abort', rejectAborted);
    }
  }
}

function elapsed(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}
