import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import {
  monitorEventLoopDelay,
  PerformanceObserver,
  type IntervalHistogram,
} from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import {
  OptimizationRuntimeMetrics,
  sanitizeOptimizationRuntimeMetrics,
} from './optimization-runtime-metrics';
import {
  CHAT_CONTEXT_ACTIVITY_FIELDS,
  CHAT_CONTEXT_INVALIDATION_REASONS,
} from '../chat-context/chat-context-cache-metrics';
import { isRuntimeServiceName, RUNTIME_SERVICE_NAMES } from '../runtime/runtime-topology';
import {
  connectionAdmissionMetrics,
  sanitizeConnectionAdmissionMetrics,
  type ConnectionAdmissionSnapshot,
} from '../prisma/connection-admission-metrics';

export const STORAGE_RUNTIME_METRICS_PREFIX = 'runtime:storage-cost:v1:';
export const STORAGE_RUNTIME_MAX_REPORT_BYTES = 24_576;
export const STORAGE_RUNTIME_COUNTERS = [
  'deleteLeaseChecks',
  'deleteLeaseRenewals',
  'deleteLeaseReads',
  'deleteLeaseLost',
  'deleteLeaseErrors',
] as const;
export type StorageRuntimeCounter = (typeof STORAGE_RUNTIME_COUNTERS)[number];
export const STORAGE_DELETE_RECONCILER_PHASES = [
  'staleSendFences',
  'replacementRecovery',
  'dueSweep',
  'retainedPurge',
] as const;
export type StorageDeleteReconcilerPhase = (typeof STORAGE_DELETE_RECONCILER_PHASES)[number];
export const STORAGE_DELETE_DUE_SWEEP_STAGES = ['expire', 'select', 'handoff'] as const;
const DELETE_RECONCILER_FIELDS = ['tickCalls', 'skippedInFlight', 'completedTicks'] as const;
const DELETE_RECONCILER_PHASE_FIELDS = ['calls', 'succeeded', 'errors', 'returnedCount'] as const;
const DELETE_DUE_SWEEP_FIELDS = [
  'calls',
  'completed',
  'errors',
  'executionDisabled',
  'selectedCount',
  'handoffAttemptedCount',
  'handoffAcknowledgedCount',
  'handoffErrorCount',
  'handoffInsertionUnknownCount',
] as const;
const DELETE_DUE_SWEEP_STAGE_FIELDS = [
  ...DELETE_RECONCILER_PHASE_FIELDS,
  'totalDurationMs',
  'maxDurationMs',
] as const;
const DELETE_HANDOFF_OUTCOME_FIELDS = [
  'insertedCount',
  'existingCount',
  'reusedCount',
  'observationErrorCount',
] as const;
const PROCESS_MEMORY_FIELDS = [
  'rssBytes',
  'heapUsedBytes',
  'heapTotalBytes',
  'externalBytes',
  'arrayBuffersBytes',
  'heapLimitBytes',
] as const;
const GC_FIELDS = ['count', 'totalDurationUs'] as const;
const EVENT_LOOP_DELAY_FIELDS = ['resolutionMs', 'samples', 'meanUs', 'p95Us', 'maxUs'] as const;
const CACHE_FIELDS = [
  'entries',
  'estimatedBytes',
  'maxEntries',
  'maxBytes',
  'maxEntryBytes',
  'hits',
  'misses',
  'writes',
  'oversizedSkips',
  'capacityEvictions',
  'expiredEvictions',
  'invalidations',
  'sweepInspected',
] as const;
const SETTINGS_TEMPLATE_FIELDS = [
  'entries',
  'estimatedBytes',
  'maxEntries',
  'maxBytes',
  'maxEntryBytes',
  'hits',
  'misses',
  'writes',
  'oversizedSkips',
  'capacityEvictions',
  'fullLoads',
  'shellReads',
  'reuses',
] as const;
const SETTINGS_TEMPLATE_SEGMENT_FIELDS = [
  'compactBytes',
  'maxCompactBytes',
  'maxCompactEntryBytes',
  'mediaBytes',
  'maxMediaBytes',
  'mediaEntries',
  'sharedMediaReuses',
  'mediaCapacityEvictions',
] as const;
const DELETE_AUTHOR_FIELDS = ['roster', 'protected', 'legacy', 'membership', 'shared'] as const;
const VK_FIELDS = [
  'batches',
  'postsAttempted',
  'rowsWritten',
  'rowsSkippedOrFenced',
  'failedBatches',
] as const;
const VK_MEDIA_ADMISSION_FIELDS = [
  'budgetBytes',
  'reservedBytes',
  'active',
  'waiting',
  'peakReservedBytes',
  'peakWaiting',
] as const;
const DURATION_FIELDS = ['under100Ms', 'under500Ms', 'under2000Ms', 'atLeast2000Ms'] as const;
const REPORT_INTERVAL_MS = 30_000;
const REPORT_TTL_MS = 90_000;
const EVENT_LOOP_RESOLUTION_MS = 100;

function fixedNumbers(value: unknown, fields: readonly string[]): Record<string, number> {
  const source = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return Object.fromEntries(
    fields.map((field) => {
      const number = source[field];
      return [
        field,
        typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : 0,
      ];
    }),
  );
}

function checkedNumbers(value: unknown, fields: readonly string[]): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (
    fields.some(
      (field) =>
        typeof source[field] !== 'number' ||
        !Number.isSafeInteger(source[field]) ||
        (source[field] as number) < 0,
    )
  )
    return null;
  return Object.fromEntries(fields.map((field) => [field, source[field] as number]));
}

function sanitizeSettingsTemplates(value: unknown) {
  const counters = checkedNumbers(value, SETTINGS_TEMPLATE_FIELDS);
  if (!counters) return null;
  const segments = checkedNumbers(
    (value as Record<string, unknown>).segments,
    SETTINGS_TEMPLATE_SEGMENT_FIELDS,
  );
  // FLAG: Older writers remain readable; absent segment metrics never imply empty media.
  return { ...counters, ...(segments ? { segments } : {}) };
}

function sanitizeChatContextActivity(value: unknown) {
  const counters = checkedNumbers(value, CHAT_CONTEXT_ACTIVITY_FIELDS);
  if (!counters) return null;
  const source = value as Record<string, unknown>;
  if (
    !source.invalidationsByReason ||
    typeof source.invalidationsByReason !== 'object' ||
    Array.isArray(source.invalidationsByReason)
  )
    return null;
  const reasons = source.invalidationsByReason as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const reason of CHAT_CONTEXT_INVALIDATION_REASONS) {
    const counts = checkedNumbers(reasons[reason], ['events', 'evictedEntries']);
    if (!counts || counts.evictedEntries! > counts.events!) return null;
    sanitized[reason] = counts;
  }
  return { ...counters, invalidationsByReason: sanitized };
}

function sanitizeVkMediaAdmission(value: unknown) {
  const counters = checkedNumbers(value, VK_MEDIA_ADMISSION_FIELDS);
  if (!counters || typeof (value as Record<string, unknown>).stopping !== 'boolean') return null;
  if (
    counters.budgetBytes! < 1 ||
    counters.reservedBytes! > counters.budgetBytes! ||
    counters.peakReservedBytes! > counters.budgetBytes! ||
    counters.reservedBytes! > counters.peakReservedBytes! ||
    counters.waiting! > counters.peakWaiting!
  )
    return null;
  return { ...counters, stopping: (value as Record<string, unknown>).stopping as boolean };
}

function sanitizeDeleteReconcilerSnapshot(value: unknown) {
  const counters = checkedNumbers(value, DELETE_RECONCILER_FIELDS);
  if (!counters) return null;
  const source = value as Record<string, unknown>;
  if (!source.phases || typeof source.phases !== 'object' || Array.isArray(source.phases))
    return null;
  const phases = source.phases as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const phase of STORAGE_DELETE_RECONCILER_PHASES) {
    const counters = checkedNumbers(phases[phase], DELETE_RECONCILER_PHASE_FIELDS);
    const value = phases[phase] as Record<string, unknown> | undefined;
    const durationBuckets = checkedNumbers(value?.durationBuckets, DURATION_FIELDS);
    if (!counters || !durationBuckets) return null;
    sanitized[phase] = { ...counters, durationBuckets };
  }
  return { ...counters, phases: sanitized };
}

function sanitizeDeleteDueSweepSnapshot(value: unknown) {
  const counters = checkedNumbers(value, DELETE_DUE_SWEEP_FIELDS);
  if (!counters) return null;
  const source = value as Record<string, unknown>;
  if (!source.stages || typeof source.stages !== 'object' || Array.isArray(source.stages))
    return null;
  const stages = source.stages as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const stage of STORAGE_DELETE_DUE_SWEEP_STAGES) {
    const counters = checkedNumbers(stages[stage], DELETE_DUE_SWEEP_STAGE_FIELDS);
    const value = stages[stage] as Record<string, unknown> | undefined;
    const durationBuckets = checkedNumbers(value?.durationBuckets, DURATION_FIELDS);
    if (!counters || !durationBuckets) return null;
    sanitized[stage] = { ...counters, durationBuckets };
  }
  // FLAG: Older writers have no outcome attribution. Never turn missing or invalid
  // observations into zero inserts; acknowledgements alone do not prove new jobs.
  return {
    ...counters,
    handoffOutcomes: checkedNumbers(source.handoffOutcomes, DELETE_HANDOFF_OUTCOME_FIELDS),
    stages: sanitized,
  };
}

function sanitizeProcessPerformance(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  return {
    gc: source.gc == null ? null : checkedNumbers(source.gc, GC_FIELDS),
    eventLoopDelay:
      source.eventLoopDelay == null
        ? null
        : checkedNumbers(source.eventLoopDelay, EVENT_LOOP_DELAY_FIELDS),
  };
}

export function sanitizeStorageRuntimeSnapshot(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  if (
    source.schemaVersion !== 1 ||
    typeof source.startedAt !== 'number' ||
    !Number.isSafeInteger(source.startedAt) ||
    typeof source.observedAt !== 'number' ||
    !Number.isSafeInteger(source.observedAt) ||
    source.startedAt <= 0 ||
    source.startedAt > source.observedAt
  )
    return null;
  const vk = source.vkPersistence as Record<string, unknown> | undefined;
  const counters = checkedNumbers(source.counters, STORAGE_RUNTIME_COUNTERS);
  const cache =
    source.chatContextCache == null ? null : checkedNumbers(source.chatContextCache, CACHE_FIELDS);
  const vkCounters = source.vkPersistence == null ? null : checkedNumbers(vk, VK_FIELDS);
  const durations =
    source.vkPersistence == null ? null : checkedNumbers(vk?.durationBuckets, DURATION_FIELDS);
  const deleteReconciler =
    source.deleteReconciler == null
      ? null
      : sanitizeDeleteReconcilerSnapshot(source.deleteReconciler);
  if (
    !counters ||
    (source.chatContextCache != null && !cache) ||
    (source.vkPersistence != null && (!vkCounters || !durations)) ||
    (source.deleteReconciler != null && !deleteReconciler)
  )
    return null;
  const prismaAdmission: ConnectionAdmissionSnapshot | null = sanitizeConnectionAdmissionMetrics(
    source.prismaAdmission,
  );
  return {
    schemaVersion: 1,
    startedAt: source.startedAt,
    observedAt: source.observedAt,
    counters,
    chatContextCache: cache
      ? {
          ...cache,
          // FLAG: Older writers have no attribution. Missing or invalid measurements remain
          // unavailable; never report inferred zeroes or retain arbitrary invalidation labels.
          activity: sanitizeChatContextActivity(
            (source.chatContextCache as Record<string, unknown>).activity,
          ),
          // FLAG: Older reports lack template measurements. Preserve their context counters
          // while keeping missing or corrupt settings-cache coverage explicitly unavailable.
          settingsTemplates: sanitizeSettingsTemplates(
            (source.chatContextCache as Record<string, unknown>).settingsTemplates,
          ),
        }
      : null,
    deleteReconciler,
    // FLAG: Additive diagnostic fields preserve old reports. Missing or corrupt
    // optional measurements are missing coverage, never inferred healthy zeroes.
    deleteDueSweep:
      source.deleteDueSweep == null ? null : sanitizeDeleteDueSweepSnapshot(source.deleteDueSweep),
    automaticDeleteAuthors: checkedNumbers(source.automaticDeleteAuthors, DELETE_AUTHOR_FIELDS),
    optimization: sanitizeOptimizationRuntimeMetrics(source.optimization),
    prismaAdmission,
    processMemory:
      source.processMemory == null
        ? null
        : checkedNumbers(source.processMemory, PROCESS_MEMORY_FIELDS),
    processPerformance: sanitizeProcessPerformance(source.processPerformance),
    vkMediaAdmission: sanitizeVkMediaAdmission(source.vkMediaAdmission),
    vkPersistence: vk
      ? {
          ...vkCounters,
          durationBuckets: durations,
        }
      : null,
  };
}

export async function readStorageRuntimeFleet(redis: Pick<Redis, 'mget'>) {
  try {
    const values = await redis.mget(
      ...RUNTIME_SERVICE_NAMES.map((service) => `${STORAGE_RUNTIME_METRICS_PREFIX}${service}`),
    );
    return {
      available: true,
      observedAt: Date.now(),
      // Each role has an independent cumulative epoch; missing reports are
      // missing coverage, never healthy zeroes or an inferred process restart.
      services: RUNTIME_SERVICE_NAMES.map((service, index) => {
        let snapshot = null;
        try {
          const raw = values[index];
          if (raw && Buffer.byteLength(raw) <= STORAGE_RUNTIME_MAX_REPORT_BYTES)
            snapshot = sanitizeStorageRuntimeSnapshot(JSON.parse(raw));
        } catch {
          /* Missing coverage. */
        }
        if (
          snapshot &&
          (Date.now() - snapshot.observedAt > REPORT_TTL_MS ||
            snapshot.observedAt > Date.now() + 5_000)
        )
          snapshot = null;
        return { service, snapshot };
      }),
    };
  } catch {
    return { available: false, observedAt: Date.now(), services: [] };
  }
}

// FLAG: Only fixed scalar metrics leave a worker. No chat/bot IDs, payloads,
// error text, credentials, arbitrary labels, SQL, or environment are persisted.
@Injectable()
export class StorageRuntimeMetricsService implements OnModuleInit, OnModuleDestroy {
  readonly optimization = new OptimizationRuntimeMetrics();
  private readonly redis: Redis;
  private readonly startedAt = Date.now();
  private readonly serviceName: string | null;
  private readonly counters = fixedNumbers({}, STORAGE_RUNTIME_COUNTERS);
  private cacheProvider: (() => unknown) | null = null;
  private vkProvider: (() => unknown) | null = null;
  private vkMediaAdmissionProvider: (() => unknown) | null = null;
  private deleteReconcilerProvider: (() => unknown) | null = null;
  private deleteDueSweepProvider: (() => unknown) | null = null;
  private deleteAuthorProvider: (() => unknown) | null = null;
  private gcObserver: PerformanceObserver | null = null;
  private eventLoopDelay: IntervalHistogram | null = null;
  private readonly gcCounters = { count: 0, totalDurationUs: 0 };
  private initialized = false;
  private destroyed = false;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(config: ConfigService) {
    const name = config.get<string>('APP_SERVICE_NAME');
    this.serviceName = isRuntimeServiceName(name) ? name : null;
    this.redis = new Redis(config.getOrThrow<string>('REDIS_URL'), {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: 1_000,
      commandTimeout: 1_000,
    });
    this.redis.on('error', () => undefined);
  }

  onModuleInit(): void {
    if (this.initialized || this.destroyed) return;
    this.initialized = true;
    void this.redis.connect().catch(() => undefined);
    if (!this.serviceName) return;
    // FLAG: GC/event-loop coverage begins at module initialization, not process startup.
    this.startProcessMonitoring();
    this.timer = setInterval(() => void this.publish(), REPORT_INTERVAL_MS);
    this.timer.unref();
  }

  increment(counter: StorageRuntimeCounter): void {
    if (this.counters[counter] < Number.MAX_SAFE_INTEGER) this.counters[counter]++;
  }

  registerChatContextCacheSnapshot(provider: () => unknown): void {
    this.cacheProvider = provider;
  }
  registerVkPersistenceSnapshot(provider: () => unknown): void {
    this.vkProvider = provider;
  }
  registerVkMediaAdmissionSnapshot(provider: () => unknown): void {
    this.vkMediaAdmissionProvider = provider;
  }
  registerDeleteReconcilerSnapshot(provider: () => unknown): void {
    this.deleteReconcilerProvider = provider;
  }
  registerDeleteDueSweepSnapshot(provider: () => unknown): void {
    this.deleteDueSweepProvider = provider;
  }
  registerAutomaticDeleteAuthorSnapshot(provider: () => unknown): void {
    this.deleteAuthorProvider = provider;
  }

  private startProcessMonitoring(): void {
    // FLAG: Keep only cumulative fixed scalars and a bounded native histogram.
    // No GC is requested, no event entries are retained, and snapshot reads do not reset the epoch.
    try {
      this.gcObserver = new PerformanceObserver((list) => {
        if (this.destroyed) return;
        for (const entry of list.getEntries()) {
          const durationUs = Math.ceil(entry.duration * 1_000);
          if (entry.entryType !== 'gc' || !Number.isSafeInteger(durationUs) || durationUs < 0)
            continue;
          this.gcCounters.count = Math.min(Number.MAX_SAFE_INTEGER, this.gcCounters.count + 1);
          this.gcCounters.totalDurationUs = Math.min(
            Number.MAX_SAFE_INTEGER,
            this.gcCounters.totalDurationUs + durationUs,
          );
        }
      });
      this.gcObserver.observe({ entryTypes: ['gc'] });
    } catch {
      this.gcObserver?.disconnect();
      this.gcObserver = null;
    }
    try {
      this.eventLoopDelay = monitorEventLoopDelay({ resolution: EVENT_LOOP_RESOLUTION_MS });
      this.eventLoopDelay.enable();
    } catch {
      this.eventLoopDelay?.disable();
      this.eventLoopDelay = null;
    }
  }

  private readProcessMemory() {
    try {
      const memory = process.memoryUsage();
      // FLAG: These gauges overlap: heapUsed is part of heapTotal and arrayBuffers
      // is part of external. Do not sum them into RSS or infer a billable memory total.
      return {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external,
        arrayBuffersBytes: memory.arrayBuffers,
        heapLimitBytes: getHeapStatistics().heap_size_limit,
      };
    } catch {
      return null;
    }
  }

  private readProcessPerformance() {
    if (!this.gcObserver && !this.eventLoopDelay) return null;
    let eventLoopDelay = null;
    try {
      const histogram = this.eventLoopDelay;
      if (histogram && histogram.count > 0)
        eventLoopDelay = {
          // FLAG: Raw delay includes this sampling interval; percentiles cover the
          // cumulative monitoring window, not request latency or a 30-second report window.
          resolutionMs: EVENT_LOOP_RESOLUTION_MS,
          samples: histogram.count,
          meanUs: Math.ceil(histogram.mean / 1_000),
          p95Us: Math.ceil(histogram.percentile(95) / 1_000),
          maxUs: Math.ceil(histogram.max / 1_000),
        };
    } catch {
      // The independent GC measurement remains available.
    }
    return { gc: this.gcObserver ? this.gcCounters : null, eventLoopDelay };
  }

  getLocalSnapshot() {
    const readProvider = (provider: (() => unknown) | null) => {
      try {
        return provider?.();
      } catch {
        return null;
      }
    };
    return sanitizeStorageRuntimeSnapshot({
      schemaVersion: 1,
      startedAt: this.startedAt,
      observedAt: Date.now(),
      counters: this.counters,
      chatContextCache: readProvider(this.cacheProvider),
      vkPersistence: readProvider(this.vkProvider),
      deleteReconciler: readProvider(this.deleteReconcilerProvider),
      deleteDueSweep: readProvider(this.deleteDueSweepProvider),
      automaticDeleteAuthors: readProvider(this.deleteAuthorProvider),
      optimization: this.optimization.snapshot(),
      prismaAdmission: readProvider(() => connectionAdmissionMetrics.snapshot()),
      processMemory: this.readProcessMemory(),
      processPerformance: this.readProcessPerformance(),
      vkMediaAdmission: readProvider(this.vkMediaAdmissionProvider),
    });
  }

  publish(): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    if (!this.serviceName) return Promise.resolve();
    this.inFlight = Promise.resolve()
      .then(() =>
        this.redis.set(
          `${STORAGE_RUNTIME_METRICS_PREFIX}${this.serviceName}`,
          JSON.stringify(this.getLocalSnapshot()),
          'PX',
          REPORT_TTL_MS,
        ),
      )
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  getFleetSnapshot() {
    return readStorageRuntimeFleet(this.redis);
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.gcObserver?.disconnect();
    this.gcObserver = null;
    this.eventLoopDelay?.disable();
    this.eventLoopDelay = null;
    await this.inFlight;
    this.redis.disconnect();
  }
}
