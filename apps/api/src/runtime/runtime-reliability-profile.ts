import type {
  SystemCanaryState,
  SystemDashboardResponse,
  SystemDashboardWebhookSlo,
  SystemDynamicLeasesMode,
  SystemQueueGroup,
  SystemQueueGroupHealth,
  SystemQueueGroupStatus,
  SystemRollbackReadiness,
  SystemRuntimeProfile,
} from '@maxim/contracts/system';
import {
  getEnabledModerationProcessorQueues,
  getWebhookDynamicLeasesMode,
  getWebhookDynamicLeasesWorkerGroup,
} from './moderation-runtime';
import { resolveRuntimeServiceProfile, type RuntimeRoleCapabilities } from './runtime-topology';
import {
  currentLeaseSummaryMode,
  expectedLeaseMode,
  type LeaseHeartbeatObservation,
  observeLeaseFleet,
} from './default-webhook-fleet-observation';
import type { QueueMetricsSnapshot } from '../system/queue-metrics.service';
import { MAX_ACTION_ALL_QUEUE_NAMES } from '../max/max-action.queue';
import { LEGACY_WEBHOOK_QUEUE } from '../webhook/webhook-queues';
import { COMMERCIAL_OCR_QUEUE } from '../moderation/commercial-ocr/commercial-ocr.queue';

export const DEFAULT_WEBHOOK_P95_TARGET_MS = 400;
const QUEUE_GROUP_WAITING_WARNING = 1;
const QUEUE_GROUP_WAITING_CRITICAL = 50;

export type RuntimeRoleProfile = RuntimeRoleCapabilities;

type DashboardQueueCounters = NonNullable<SystemDashboardResponse['queues']['webhookCritical']>;

type RuntimeReliabilityInput = {
  dashboardStatus: 'healthy' | 'warning' | 'critical';
  queueLagSec: number;
  queueLagCriticalThresholdSec: number;
  activeFailedWebhooks: number;
  webhookSlo?: SystemDashboardWebhookSlo | null;
};

export function buildSystemRuntimeProfile(
  targetWebhookP95Ms = DEFAULT_WEBHOOK_P95_TARGET_MS,
): SystemRuntimeProfile {
  const runtimeService = resolveRuntimeServiceProfile();
  const service = runtimeService.service;
  const workerGroup = getWebhookDynamicLeasesWorkerGroup();
  const enabledQueues = new Set<string>(getEnabledModerationProcessorQueues());
  if (service.capabilities.actionEnabled) {
    MAX_ACTION_ALL_QUEUE_NAMES.forEach((queueName) => enabledQueues.add(queueName));
  }
  if (service.queueProfile === 'commercial-image-ocr') {
    enabledQueues.add(COMMERCIAL_OCR_QUEUE);
  }
  if (service.queueProfile === 'message-retention') enabledQueues.add('message-retention');

  return {
    appRole: service.appRole,
    serviceName: service.serviceName,
    serviceTitle: service.serviceTitle,
    queueProfile: service.queueProfile,
    queuePriority: service.queuePriority,
    topologySource: runtimeService.source,
    ...service.capabilities,
    enabledQueues: Array.from(enabledQueues).sort(),
    dynamicLeasesMode: getWebhookDynamicLeasesMode(),
    dynamicLeasesWorkerGroup: workerGroup,
    canaryShardIds: readCsvEnv('WEBHOOK_DYNAMIC_LEASES_CANARY_SHARDS', service.canaryShardIds),
    targetWebhookP95Ms,
    generatedAt: new Date().toISOString(),
  };
}

export function buildSystemQueueGroupHealth(
  queues: Pick<
    SystemDashboardResponse['queues'],
    | 'webhookCritical'
    | 'webhookJoinShards'
    | 'webhookJoin'
    | 'webhookDefaultWorkerGroups'
    | 'webhookBackground'
    | 'webhookLegacy'
    | 'actions'
    | 'globalSpammerDenorm'
    | 'auxiliaryQueues'
  >,
): SystemQueueGroupHealth {
  const groups: SystemQueueGroup[] = [
    buildQueueGroup('webhook-critical', ['moderation-critical'], queues.webhookCritical),
    buildQueueGroup(
      'webhook-join',
      Object.keys(queues.webhookJoinShards ?? {}),
      queues.webhookJoin,
    ),
    ...Object.entries(queues.webhookDefaultWorkerGroups ?? {}).map(([groupName, group]) =>
      buildQueueGroup(groupName, group.queues, group.counters),
    ),
    buildQueueGroup('webhook-background', ['moderation-background'], queues.webhookBackground),
    buildQueueGroup('webhook-legacy', [LEGACY_WEBHOOK_QUEUE], queues.webhookLegacy),
    buildQueueGroup('actions', [...MAX_ACTION_ALL_QUEUE_NAMES], queues.actions),
    buildQueueGroup('spammer-denorm', ['global-spammer-denorm'], queues.globalSpammerDenorm),
    ...Object.entries(queues.auxiliaryQueues ?? {}).map(([queueName, counters]) =>
      buildQueueGroup(`aux:${queueName}`, [queueName], counters, { ignoreDelayedForStatus: true }),
    ),
  ];

  return {
    status: resolveWorstQueueGroupStatus(groups),
    groups,
    generatedAt: new Date().toISOString(),
  };
}

export function getSystemLeaseFleet(
  queues: QueueMetricsSnapshot,
  profile: SystemRuntimeProfile,
  evidence?: LeaseHeartbeatObservation & { summaryTtlMs: number },
) {
  const expected = expectedLeaseMode(profile.serviceName, profile.dynamicLeasesMode);
  const now = Date.now();
  const snapshot = queues.webhookDynamicLeases;
  const summaryMode = currentLeaseSummaryMode(snapshot, evidence?.summaryTtlMs ?? 0, now);
  const fleet = observeLeaseFleet(evidence, expected, summaryMode, now);
  // FLAG: A single writer can leave its previous mode in Redis after all workers switch off.
  const contradictedByDisabledFleet =
    fleet.consensus && fleet.mode === 'off' && fleet.summaryConflict;
  return {
    ...fleet,
    summaryMode,
    snapshot: summaryMode && !contradictedByDisabledFleet ? snapshot : null,
  };
}

export function buildSystemCanaryState(
  input: RuntimeReliabilityInput,
  profile: SystemRuntimeProfile,
  fleet: ReturnType<typeof getSystemLeaseFleet>,
): SystemCanaryState {
  const mode = fleet.mode;
  const dynamicLeaseQueues = mode === 'off' ? [] : Object.entries(fleet.snapshot?.queues ?? {});
  const canaryShardIds =
    mode === 'canary' && fleet.summaryMode === 'canary'
      ? dynamicLeaseQueues
          .filter(([, queue]) => queue.eligibleForDynamicLeases)
          .map(([name]) => name)
          .sort()
      : [];
  const handoffPendingQueues = dynamicLeaseQueues
    .filter(([, queue]) => queue.handoffPending)
    .map(([queueName]) => queueName)
    .sort();
  const unhealthyQueues = dynamicLeaseQueues
    .filter(
      ([, queue]) => queue.pressure >= QUEUE_GROUP_WAITING_CRITICAL || queue.reason === 'stale',
    )
    .map(([queueName]) => queueName)
    .sort();

  if (mode === 'off') {
    return {
      enabled: false,
      mode,
      status: 'disabled',
      recommendation: fleet.summaryConflict ? 'hold' : 'observe',
      workerGroup: profile.dynamicLeasesWorkerGroup,
      canaryShardIds,
      liveWorkerGroups: fleet.liveWorkerGroups,
      handoffPendingQueues,
      unhealthyQueues,
      reason: fleet.summaryConflict
        ? 'All workers report off. Wait for the independently read shard summary to match.'
        : fleet.consensus
          ? 'All workers report that dynamic leases are disabled.'
          : 'Dynamic leases are disabled in this runtime profile.',
    };
  }

  const status = resolveCanaryStatus({
    mode,
    dashboardStatus: input.dashboardStatus,
    webhookSlo: input.webhookSlo ?? null,
    unhealthyQueues,
  });
  const decision = describeCanaryDecision(status, mode, handoffPendingQueues, fleet);

  return {
    enabled: true,
    mode,
    status,
    ...decision,
    workerGroup: profile.dynamicLeasesWorkerGroup,
    canaryShardIds,
    liveWorkerGroups: fleet.liveWorkerGroups,
    handoffPendingQueues,
    unhealthyQueues,
  };
}

export function buildSystemRollbackReadiness(
  input: RuntimeReliabilityInput,
): SystemRollbackReadiness {
  const webhookSloOk = !input.webhookSlo || input.webhookSlo.status === 'healthy';
  const queueLagOk = input.queueLagSec <= input.queueLagCriticalThresholdSec;
  const failedWebhookOk = input.activeFailedWebhooks === 0;
  const readyOk = input.dashboardStatus !== 'critical' && webhookSloOk && queueLagOk;
  const reasons = [
    ...(webhookSloOk ? [] : ['Webhook SLO is outside the target window.']),
    ...(queueLagOk
      ? []
      : [`Queue lag ${input.queueLagSec.toFixed(1)}s is above the critical threshold.`]),
    ...(failedWebhookOk ? [] : [`${input.activeFailedWebhooks} active failed webhook events.`]),
    ...(input.dashboardStatus === 'critical' ? ['System dashboard status is critical.'] : []),
  ];
  const status =
    input.dashboardStatus === 'critical' || !webhookSloOk
      ? 'rollback-recommended'
      : readyOk
        ? 'ready'
        : 'blocked';

  return {
    status,
    canRollbackRuntime: true,
    liveOk: true,
    readyOk,
    webhookSloOk,
    queueLagOk,
    failedWebhookOk,
    reasons,
    command:
      './infra/scripts/vps-connect.sh rollback-runtime <git-ref> api-enqueue api-moderation api-moderation-critical api-moderation-join api-moderation-realtime-b api-moderation-realtime-c api-moderation-realtime-d api-moderation-background api-media-analysis api-action api-publisher api-ingress api-admin',
  };
}

function buildQueueGroup(
  name: string,
  queues: readonly string[],
  counters: DashboardQueueCounters | undefined,
  options: { ignoreDelayedForStatus?: boolean } = {},
): SystemQueueGroup {
  const safeCounters = counters ?? {
    waiting: 0,
    active: 0,
    delayed: 0,
    failed: 0,
    completed: 0,
    prioritized: 0,
  };
  const pending = safeCounters.waiting + (safeCounters.prioritized ?? 0);
  const pressure =
    pending +
    safeCounters.active +
    (options.ignoreDelayedForStatus === true ? 0 : safeCounters.delayed);

  return {
    name,
    queues: [...queues],
    waiting: safeCounters.waiting,
    active: safeCounters.active,
    delayed: safeCounters.delayed,
    failed: safeCounters.failed,
    completed: safeCounters.completed,
    pressure,
    status: resolveQueueGroupStatus(safeCounters, options),
  };
}

function resolveQueueGroupStatus(
  counters: DashboardQueueCounters,
  options: { ignoreDelayedForStatus?: boolean } = {},
): SystemQueueGroupStatus {
  const pending = counters.waiting + (counters.prioritized ?? 0);
  if (pending >= QUEUE_GROUP_WAITING_CRITICAL) {
    return 'critical';
  }

  if (
    pending >= QUEUE_GROUP_WAITING_WARNING ||
    (options.ignoreDelayedForStatus !== true && counters.delayed > 0) ||
    counters.failed > 0
  ) {
    return 'warning';
  }

  return 'healthy';
}

function resolveWorstQueueGroupStatus(groups: readonly SystemQueueGroup[]): SystemQueueGroupStatus {
  if (groups.some((group) => group.status === 'critical')) {
    return 'critical';
  }

  if (groups.some((group) => group.status === 'warning')) {
    return 'warning';
  }

  return 'healthy';
}

function resolveCanaryStatus(input: {
  mode: SystemDynamicLeasesMode;
  dashboardStatus: 'healthy' | 'warning' | 'critical';
  webhookSlo: SystemDashboardWebhookSlo | null;
  unhealthyQueues: readonly string[];
}): SystemCanaryState['status'] {
  if (
    input.dashboardStatus === 'critical' ||
    input.webhookSlo?.status === 'critical' ||
    input.unhealthyQueues.length > 0
  ) {
    return 'degraded';
  }

  if (input.mode === 'shadow') {
    return 'shadow';
  }

  if (input.mode === 'on') {
    return 'active';
  }

  return 'canary';
}

function describeCanaryDecision(
  status: SystemCanaryState['status'],
  mode: SystemDynamicLeasesMode,
  handoffPendingQueues: readonly string[],
  fleet: ReturnType<typeof getSystemLeaseFleet>,
): Pick<SystemCanaryState, 'recommendation' | 'reason'> {
  if (status === 'degraded') {
    return {
      recommendation: 'rollback',
      reason: 'A critical runtime signal was observed during the rollout.',
    };
  }
  if (fleet.mixed || fleet.summaryConflict) {
    return {
      recommendation: 'hold',
      reason: 'Worker rollout modes disagree. Wait for the reported modes to converge.',
    };
  }
  if (!fleet.consensus) {
    return {
      recommendation: 'hold',
      reason:
        fleet.source === 'expected'
          ? 'The displayed mode is the topology expectation. Worker coverage is incomplete.'
          : 'The displayed mode is from a partial observation. Worker coverage is incomplete.',
    };
  }
  if (!fleet.summaryMode) {
    return {
      recommendation: 'hold',
      reason: 'The worker mode is confirmed. A current shard summary is unavailable.',
    };
  }
  if (handoffPendingQueues.length) {
    return { recommendation: 'hold', reason: 'A shard handoff is in progress.' };
  }
  if (mode === 'canary') {
    // FLAG: A single set of worker heartbeats cannot prove a complete observation window across all ingress writers.
    return {
      recommendation: 'hold',
      reason:
        'Keep the current canary until every expected ingress writer is observed for a full window.',
    };
  }
  return {
    recommendation: 'observe',
    reason: 'Continue observing the current worker mode and webhook latency.',
  };
}

function readCsvEnv(key: string, fallback: readonly string[] = []): string[] {
  const rawValue = process.env[key];
  if (typeof rawValue !== 'string') {
    return [...fallback].sort();
  }

  return rawValue
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .sort();
}
