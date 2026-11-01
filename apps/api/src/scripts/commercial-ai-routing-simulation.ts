import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  COMMERCIAL_LLM_CHAT_ACTIVE_LIMIT,
  COMMERCIAL_LLM_POLL_INTERVAL_MS,
} from '../moderation/commercial/commercial-llm-enforcement.mailbox';
import {
  commercialLlmPoolEnforcementIdentity,
  COMMERCIAL_LLM_EFFECT_MAX_AGE_MS,
  COMMERCIAL_LLM_INFERENCE_TIMEOUT_MS,
  COMMERCIAL_LLM_PENDING_MAX_AGE_MS,
} from '../moderation/commercial/commercial-llm-enforcement.protocol';
import { COMMERCIAL_LLM_POOL_ACTIVE_LIMIT } from '../moderation/commercial/commercial-llm-pool-admission.mailbox';
import {
  COMMERCIAL_LLM_POOL_CPU_MIN_REMAINING_MS,
  COMMERCIAL_LLM_POOL_PROFILES,
  POOL_NODE_IDS,
  type CommercialLlmPoolNodeId,
} from '../moderation/commercial/commercial-llm-pool.protocol';

const MAX_HORIZON = 86_400_000;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const clock = z.number().int().min(0).max(MAX_HORIZON);
const nodeId = z.enum(POOL_NODE_IDS);
const classification = z.enum(['COMMERCIAL', 'NOT_COMMERCIAL', 'UNSURE']);
const observation = z
  .object({
    nodeId,
    phase: z.enum(['PRIMARY', 'CONSULTATION']),
    attempt: z.union([z.literal(1), z.literal(2)]),
    evidenceSha256: digest,
    outcome: z.enum(['COMPLETE', 'FAILURE', 'TIMEOUT']),
    durationMs: z.number().int().min(1).max(90_000),
    classification: classification.nullable(),
    physicalCompletionMs: z.number().int().min(1).max(MAX_HORIZON).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.outcome === 'COMPLETE') !== (value.classification !== null) ||
      (value.outcome === 'COMPLETE' && value.physicalCompletionMs !== value.durationMs) ||
      (value.physicalCompletionMs !== null && value.physicalCompletionMs < value.durationMs) ||
      (value.phase === 'CONSULTATION' && (value.attempt !== 1 || value.nodeId === 'pc-a-4b'))
    )
      context.addIssue({ code: 'custom', message: 'Contradictory bounded observation.' });
  });
const costs = z.object({ 'server-9b': clock, 'pc-a-4b': clock, 'pc-b-9b': clock }).strict();

export const commercialAiRoutingScenarioSchema = z
  .object({
    schemaVersion: z.literal('commercial-ai-routing-scenario/v1'),
    mode: z.enum(['MEASURED_TRACE', 'DECLARED_SCENARIO']),
    inputObservationSha256: digest,
    classifierIdentitySha256: digest,
    topologySha256: digest,
    seed: z.number().int().min(0).max(0xffff_ffff),
    horizonMs: clock.min(1),
    frozenRanking: z
      .object({
        evidenceSha256: digest,
        frozenAtMs: z.number().int().min(-MAX_HORIZON).max(0),
        expectedUsefulCompletionCostMs: costs,
      })
      .strict(),
    nodeIntervals: z
      .array(
        z
          .object({
            nodeId,
            kind: z.enum(['OUTAGE', 'HELD']),
            startMs: clock,
            endMs: clock.nullable(),
          })
          .strict(),
      )
      .max(1000)
      .default([]),
    arrivals: z
      .array(
        z
          .object({
            sourceKey: digest,
            chatKey: digest,
            messageKey: digest,
            eventAtMs: clock,
            offeredAtMs: clock,
            observations: z.array(observation).max(8),
          })
          .strict(),
      )
      .max(10_000),
  })
  .strict()
  .superRefine((value, context) => {
    const sources = new Set<string>();
    for (const arrival of value.arrivals) {
      const keys = arrival.observations.map(
        (item) => `${item.nodeId}:${item.phase}:${item.attempt}`,
      );
      if (
        sources.has(arrival.sourceKey) ||
        arrival.offeredAtMs < arrival.eventAtMs ||
        arrival.offeredAtMs > value.horizonMs ||
        new Set(keys).size !== keys.length
      )
        context.addIssue({ code: 'custom', message: 'Duplicate or invalid bounded source.' });
      sources.add(arrival.sourceKey);
    }
    for (const interval of value.nodeIntervals)
      if (
        interval.startMs > value.horizonMs ||
        (interval.endMs !== null &&
          (interval.endMs <= interval.startMs || interval.endMs > value.horizonMs))
      )
        context.addIssue({ code: 'custom', message: 'Invalid bounded node interval.' });
    for (const id of POOL_NODE_IDS) {
      const intervals = value.nodeIntervals
        .filter((item) => item.nodeId === id)
        .sort((a, b) => a.startMs - b.startMs);
      if (
        intervals.some(
          (item, index) => index > 0 && (intervals[index - 1]!.endMs ?? Infinity) > item.startMs,
        )
      )
        context.addIssue({ code: 'custom', message: 'Node intervals must not overlap.' });
    }
  });
export type CommercialAiRoutingScenario = z.infer<typeof commercialAiRoutingScenarioSchema>;
type Arrival = CommercialAiRoutingScenario['arrivals'][number];
type Observation = z.infer<typeof observation>;
type Outcome =
  | 'COMMERCIAL'
  | 'NOT_COMMERCIAL'
  | 'UNSURE'
  | 'TECHNICAL_FAILURE'
  | 'COUNTERFACTUAL_UNKNOWN'
  | 'EXPIRED';
type Strategy = 'CURRENT_EWMA' | 'FROZEN_USEFUL_COMPLETION';
type Job = {
  arrival: Arrival;
  startedAt: number;
  deadline: number;
  phase: 'PRIMARY' | 'CONSULTATION';
  tried: Set<CommercialLlmPoolNodeId>;
  attempt: 1 | 2;
  running: { nodeId: CommercialLlmPoolNodeId; endAt: number; observed: Observation | null } | null;
};
type NodeState = {
  physicalUntil: number;
  physicalUnknown: boolean;
  logicalUntil: number;
  latency: number;
  sampled: boolean;
  penalty: number;
  penaltyAt: number;
  busyMs: number;
  heldMs: number;
  outageMs: number;
  reservations: number;
  missingObservations: number;
};

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function commercialAiRoutingExpectedIdentity() {
  return {
    classifierIdentitySha256: commercialLlmPoolEnforcementIdentity('confirm-positive'),
    topologySha256: hash({
      profiles: COMMERCIAL_LLM_POOL_PROFILES,
      active: COMMERCIAL_LLM_POOL_ACTIVE_LIMIT,
      pending: 2,
      chatActive: COMMERCIAL_LLM_CHAT_ACTIVE_LIMIT,
      pollMs: COMMERCIAL_LLM_POLL_INTERVAL_MS,
      pendingMs: COMMERCIAL_LLM_PENDING_MAX_AGE_MS,
      inferenceMs: COMMERCIAL_LLM_INFERENCE_TIMEOUT_MS,
      effectMs: COMMERCIAL_LLM_EFFECT_MAX_AGE_MS,
      cpuFloorMs: COMMERCIAL_LLM_POOL_CPU_MIN_REMAINING_MS,
      policy: 'confirm-positive',
      primaryClaims: 'per-chat',
      primaryAttempts: 2,
      consultation: 'immediate-idle-9b-no-retry',
    }),
  };
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

function simulate(scenario: CommercialAiRoutingScenario, strategy: Strategy) {
  const nodes = Object.fromEntries(
    POOL_NODE_IDS.map((id) => [
      id,
      {
        physicalUntil: 0,
        physicalUnknown: false,
        logicalUntil: 0,
        latency: 4000,
        sampled: false,
        penalty: 0,
        penaltyAt: 0,
        busyMs: 0,
        heldMs: 0,
        outageMs: 0,
        reservations: 0,
        missingObservations: 0,
      },
    ]),
  ) as Record<CommercialLlmPoolNodeId, NodeState>;
  const ordered = [...scenario.arrivals].sort(
    (a, b) => a.offeredAtMs - b.offeredAtMs || a.sourceKey.localeCompare(b.sourceKey),
  );
  const intervalsByNode = Object.fromEntries(
    POOL_NODE_IDS.map((id) => [
      id,
      scenario.nodeIntervals
        .filter((item) => item.nodeId === id)
        .sort((a, b) => a.startMs - b.startMs),
    ]),
  ) as Record<CommercialLlmPoolNodeId, CommercialAiRoutingScenario['nodeIntervals']>;
  const intervalBoundaries = [
    ...new Set(
      scenario.nodeIntervals.flatMap((item) =>
        item.endMs === null ? [item.startMs] : [item.startMs, item.endMs],
      ),
    ),
  ].sort((a, b) => a - b);
  let intervalBoundaryIndex = 0;
  const pending: Arrival[] = [];
  const active: Job[] = [];
  const rejected: Record<string, number> = {};
  const outcomes: Record<Outcome, number> = {
    COMMERCIAL: 0,
    NOT_COMMERCIAL: 0,
    UNSURE: 0,
    TECHNICAL_FAILURE: 0,
    COUNTERFACTUAL_UNKNOWN: 0,
    EXPIRED: 0,
  };
  const consult = { demand: 0, completed: 0, noCapacity: 0, budgetExhausted: 0, failed: 0 };
  const waits: number[] = [];
  const latencies: number[] = [];
  let admitted = 0;
  let started = 0;
  let retries = 0;
  let cpuFloorSkips = 0;
  let maxActive = 0;
  let maxPending = 0;
  let index = 0;
  let time = 0;
  let nextPoll = 0;
  const increment = (key: string) => {
    rejected[key] = (rejected[key] ?? 0) + 1;
  };
  const intervalAt = (id: CommercialLlmPoolNodeId, at: number) => {
    const intervals = intervalsByNode[id];
    let low = 0;
    let high = intervals.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (intervals[middle]!.startMs <= at) low = middle + 1;
      else high = middle;
    }
    const item = intervals[low - 1];
    return item && (item.endMs === null || item.endMs > at) ? item : undefined;
  };
  const idle = (id: CommercialLlmPoolNodeId, at: number) =>
    !intervalAt(id, at) && nodes[id].physicalUntil <= at && !nodes[id].physicalUnknown;
  const chatBusy = (arrival: Arrival) => {
    const related = active.filter((job) => job.arrival.chatKey === arrival.chatKey);
    return (
      related.length >= COMMERCIAL_LLM_CHAT_ACTIVE_LIMIT ||
      related.some(
        (job) => job.phase === 'PRIMARY' || job.arrival.messageKey === arrival.messageKey,
      )
    );
  };
  const finish = (job: Job, outcome: Outcome, at: number) => {
    outcomes[outcome] += 1;
    latencies.push(at - job.arrival.offeredAtMs);
    active.splice(active.indexOf(job), 1);
    job.running = null;
  };
  const decayedPenalty = (node: NodeState, at: number) =>
    node.penalty * Math.pow(0.5, Math.max(0, at - node.penaltyAt) / 30_000);
  const reserve = (job: Job, at: number): boolean => {
    // FLAG: Seeded source-key ties are shared across strategies; call order never invents a sample.
    const offset =
      Number.parseInt(hash([scenario.seed, job.arrival.sourceKey]).slice(-8), 16) %
      POOL_NODE_IDS.length;
    const order = [...POOL_NODE_IDS.slice(offset), ...POOL_NODE_IDS.slice(0, offset)];
    const rank = (id: CommercialLlmPoolNodeId) =>
      strategy === 'CURRENT_EWMA'
        ? nodes[id].latency + decayedPenalty(nodes[id], at)
        : scenario.frozenRanking.expectedUsefulCompletionCostMs[id];
    const available = order
      .map((id, position) => ({ id, position }))
      .sort((a, b) => rank(a.id) - rank(b.id) || a.position - b.position);
    for (const { id } of available) {
      if (
        !idle(id, at) ||
        job.tried.has(id) ||
        (job.phase === 'CONSULTATION' && COMMERCIAL_LLM_POOL_PROFILES[id].model !== '9b')
      )
        continue;
      if (id === 'server-9b' && job.deadline - at < COMMERCIAL_LLM_POOL_CPU_MIN_REMAINING_MS) {
        cpuFloorSkips += 1;
        continue;
      }
      const observed =
        job.arrival.observations.find(
          (item) => item.nodeId === id && item.phase === job.phase && item.attempt === job.attempt,
        ) ?? null;
      const endAt = Math.min(
        job.deadline,
        at + (observed?.durationMs ?? COMMERCIAL_LLM_INFERENCE_TIMEOUT_MS),
      );
      const state = nodes[id];
      state.reservations += 1;
      state.logicalUntil = endAt;
      state.physicalUnknown = observed?.physicalCompletionMs == null;
      state.physicalUntil =
        observed?.physicalCompletionMs == null
          ? scenario.horizonMs
          : at + observed.physicalCompletionMs;
      if (!observed) state.missingObservations += 1;
      job.tried.add(id);
      job.running = { nodeId: id, endAt, observed };
      return true;
    }
    return false;
  };
  const complete = (job: Job, at: number) => {
    const run = job.running!;
    const state = nodes[run.nodeId];
    const observed = run.observed;
    job.running = null;
    const completed = !!observed && observed.outcome === 'COMPLETE' && at < job.deadline;
    if (completed) {
      const duration = Math.max(
        1,
        Math.min(COMMERCIAL_LLM_INFERENCE_TIMEOUT_MS, observed.durationMs),
      );
      state.latency = state.sampled ? state.latency * 0.75 + duration * 0.25 : duration;
      state.sampled = true;
      state.penalty = 0;
    } else {
      state.penalty = Math.min(20_000, decayedPenalty(state, at) + 5000);
      state.penaltyAt = at;
    }
    if (at >= job.deadline) {
      if (job.phase === 'CONSULTATION') consult.failed += 1;
      finish(job, observed ? 'EXPIRED' : 'COUNTERFACTUAL_UNKNOWN', at);
      return;
    }
    if (!completed) {
      if (job.phase === 'PRIMARY' && job.attempt === 1) {
        job.attempt = 2;
        retries += 1;
        if (reserve(job, at)) return;
      }
      if (job.phase === 'CONSULTATION') consult.failed += 1;
      finish(job, observed ? 'TECHNICAL_FAILURE' : 'COUNTERFACTUAL_UNKNOWN', at);
      return;
    }
    if (job.phase === 'CONSULTATION') {
      consult.completed += 1;
      finish(job, observed.classification!, at);
      return;
    }
    const needsConsultation =
      run.nodeId === 'pc-a-4b' && observed.classification !== 'NOT_COMMERCIAL';
    if (!needsConsultation) {
      finish(job, observed.classification!, at);
      return;
    }
    consult.demand += 1;
    job.phase = 'CONSULTATION';
    job.attempt = 1;
    job.tried = new Set();
    if (job.deadline - at < 1000) {
      consult.budgetExhausted += 1;
      finish(job, 'UNSURE', at);
      return;
    }
    const anotherSecondary = active.some(
      (other) =>
        other !== job &&
        other.phase === 'CONSULTATION' &&
        other.arrival.chatKey === job.arrival.chatKey,
    );
    // FLAG: An admitted primary waiting for a node keeps priority over an immediate consultation.
    const dispatchPending =
      pending.length > 0 ||
      active.some((other) => other !== job && other.phase === 'PRIMARY' && !other.running);
    if (anotherSecondary || dispatchPending || !reserve(job, at)) {
      consult.noCapacity += 1;
      finish(job, 'UNSURE', at);
    }
  };
  while (time <= scenario.horizonMs) {
    for (const job of [...active])
      if (job.running && job.running.endAt <= time) complete(job, time);
    for (let position = pending.length - 1; position >= 0; position -= 1) {
      const arrival = pending[position]!;
      if (
        time >=
        Math.min(
          arrival.offeredAtMs + COMMERCIAL_LLM_PENDING_MAX_AGE_MS,
          arrival.eventAtMs + COMMERCIAL_LLM_EFFECT_MAX_AGE_MS,
        )
      ) {
        pending.splice(position, 1);
        increment('pending_expired');
      }
    }
    while (index < ordered.length && ordered[index]!.offeredAtMs <= time) {
      const arrival = ordered[index++]!;
      if (arrival.eventAtMs + COMMERCIAL_LLM_EFFECT_MAX_AGE_MS <= time) increment('source_expired');
      else if (time - arrival.eventAtMs > 10_000) increment('source_stale');
      else if (!active.length && !POOL_NODE_IDS.some((id) => idle(id, time)))
        increment('not_ready');
      else if (chatBusy(arrival) || pending.some((item) => item.chatKey === arrival.chatKey))
        increment('chat_busy');
      else if (pending.length >= 2) increment('buffer_full');
      else {
        pending.push(arrival);
        admitted += 1;
        maxPending = Math.max(maxPending, pending.length);
      }
    }
    if (time === nextPoll) {
      if (
        pending.length &&
        active.length < COMMERCIAL_LLM_POOL_ACTIVE_LIMIT &&
        POOL_NODE_IDS.some((id) => idle(id, time))
      ) {
        const arrival = pending[0]!;
        if (!chatBusy(arrival)) {
          pending.shift();
          const job: Job = {
            arrival,
            startedAt: time,
            deadline: Math.min(
              time + COMMERCIAL_LLM_INFERENCE_TIMEOUT_MS,
              arrival.eventAtMs + COMMERCIAL_LLM_EFFECT_MAX_AGE_MS,
            ),
            phase: 'PRIMARY',
            tried: new Set(),
            attempt: 1,
            running: null,
          };
          active.push(job);
          started += 1;
          waits.push(time - arrival.offeredAtMs);
          maxActive = Math.max(maxActive, active.length);
          if (!reserve(job, time)) finish(job, 'TECHNICAL_FAILURE', time);
        }
      }
      nextPoll += COMMERCIAL_LLM_POLL_INTERVAL_MS;
    }
    if (time === scenario.horizonMs) break;
    const candidates = [scenario.horizonMs, nextPoll];
    if (index < ordered.length) candidates.push(ordered[index]!.offeredAtMs);
    while (
      intervalBoundaryIndex < intervalBoundaries.length &&
      intervalBoundaries[intervalBoundaryIndex]! <= time
    )
      intervalBoundaryIndex += 1;
    if (intervalBoundaryIndex < intervalBoundaries.length)
      candidates.push(intervalBoundaries[intervalBoundaryIndex]!);
    for (const job of active) if (job.running) candidates.push(job.running.endAt);
    for (const arrival of pending)
      candidates.push(
        Math.min(
          arrival.offeredAtMs + COMMERCIAL_LLM_PENDING_MAX_AGE_MS,
          arrival.eventAtMs + COMMERCIAL_LLM_EFFECT_MAX_AGE_MS,
        ),
      );
    for (const id of POOL_NODE_IDS) {
      if (nodes[id].physicalUntil > time && !nodes[id].physicalUnknown)
        candidates.push(nodes[id].physicalUntil);
    }
    const next = Math.min(...candidates.filter((value) => value > time));
    for (const id of POOL_NODE_IDS) {
      const state = nodes[id];
      const interval = intervalAt(id, time);
      const elapsed = next - time;
      if (interval?.kind === 'OUTAGE') state.outageMs += elapsed;
      else if (
        interval?.kind === 'HELD' ||
        (state.physicalUntil > time && (state.physicalUnknown || state.logicalUntil <= time))
      )
        state.heldMs += elapsed;
      else if (state.physicalUntil > time) state.busyMs += elapsed;
    }
    time = next;
  }
  const completed = Object.values(outcomes).reduce((sum, value) => sum + value, 0);
  const censored = active.length + pending.length;
  const rejectionTotal = Object.entries(rejected)
    .filter(([reason]) => reason !== 'pending_expired')
    .reduce((sum, [, value]) => sum + value, 0);
  const pendingExpired = rejected.pending_expired ?? 0;
  const accountingGap = ordered.length - rejectionTotal - pendingExpired - completed - censored;
  const definitive = outcomes.COMMERCIAL + outcomes.NOT_COMMERCIAL;
  return {
    strategy,
    arrivals: ordered.length,
    admitted,
    started,
    rejected,
    outcomes,
    completed,
    censored,
    closed: ordered.length - censored,
    definitiveDecisions: definitive,
    definitivePer1000Arrivals: ordered.length ? (definitive / ordered.length) * 1000 : null,
    definitivePerMinute: (definitive / scenario.horizonMs) * 60_000,
    consultations: consult,
    primaryRetryOpportunities: retries,
    cpuFloorSkips,
    waitMs: {
      p50: percentile(waits, 0.5),
      p95: percentile(waits, 0.95),
      p99: percentile(waits, 0.99),
    },
    completedLatencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
    },
    maximumActive: maxActive,
    maximumPending: maxPending,
    accountingGap,
    nodes: POOL_NODE_IDS.map((id) => ({
      nodeId: id,
      busyMs: nodes[id].busyMs,
      heldMs: nodes[id].heldMs,
      outageMs: nodes[id].outageMs,
      idleMs: scenario.horizonMs - nodes[id].busyMs - nodes[id].heldMs - nodes[id].outageMs,
      reservations: nodes[id].reservations,
      missingObservations: nodes[id].missingObservations,
      unknownPhysicalCompletionAtBoundary: nodes[id].physicalUnknown,
      physicalCompletionAfterBoundary:
        !nodes[id].physicalUnknown && nodes[id].physicalUntil > scenario.horizonMs,
    })),
    invariantViolations: [
      ...(maxActive > COMMERCIAL_LLM_POOL_ACTIVE_LIMIT ? ['active_limit'] : []),
      ...(maxPending > 2 ? ['pending_limit'] : []),
      ...(accountingGap !== 0 ? ['source_conservation'] : []),
    ],
  };
}

// FLAG: This bounded offline model applies no effects and cannot establish production recovery or quality.
export function simulateCommercialAiRouting(input: CommercialAiRoutingScenario) {
  const parsed = commercialAiRoutingScenarioSchema.safeParse(input);
  if (!parsed.success) throw new Error('Commercial AI routing scenario schema is invalid');
  const scenario = parsed.data;
  const identity = commercialAiRoutingExpectedIdentity();
  if (
    scenario.classifierIdentitySha256 !== identity.classifierIdentitySha256 ||
    scenario.topologySha256 !== identity.topologySha256
  )
    throw new Error('Commercial AI routing identity is stale');
  return {
    schemaVersion: 'commercial-ai-routing-report/v1',
    inputSha256: hash(scenario),
    mode: scenario.mode,
    seed: scenario.seed,
    horizonMs: scenario.horizonMs,
    ...identity,
    frozenRankingSha256: hash(scenario.frozenRanking),
    runtimeChangesApplied: false,
    runtimeReplay: false,
    qualityEvaluated: false,
    promotionAuthorized: false,
    topology: 'current-pool-v2-confirm-positive',
    initialState: 'empty-except-declared-node-intervals',
    warmupExcluded: false,
    observedProductionRecovery: false,
    assumptions: [
      'healthy-worker-and-governor',
      '250ms-poll-without-immediate-wakes',
      'zero-transport-and-authority-check-overhead',
      'provided-per-source-node-phase-attempt-evidence-only',
      'unknown-physical-completion-held-to-boundary',
      'frozen-useful-costs-are-external-declarations',
      'no-quality-or-effect-inference',
    ],
    strategies: [
      simulate(scenario, 'CURRENT_EWMA'),
      simulate(scenario, 'FROZEN_USEFUL_COMPLETION'),
    ],
  };
}
