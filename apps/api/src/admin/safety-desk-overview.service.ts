import { Inject, Injectable, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import {
  safetyDeskOverviewResponseSchema,
  type SafetyDeskOverviewResponse,
  type SafetyDeskOverviewObservation,
  type SafetyDeskOverviewPending,
  type SafetyDeskOverviewHistoryPoint,
} from '@maxim/contracts/safety-desk';
import { webhookSubscriptionSnapshotSchema } from '@maxim/contracts/system';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { QueueMetricsService } from '../system/queue-metrics.service';
import { readStorageRuntimeFleet } from '../system/storage-runtime-metrics.service';
import {
  buildPublisherRuntimeHeartbeatKey,
  parsePublisherRuntimeHeartbeat,
} from '../publisher/publisher-runtime-heartbeat.service';
import { getAppRole, roleRunsAdmin } from '../runtime/app-role';
import {
  SafetyDeskOverviewStore,
  OverviewInvalidEvidenceError,
} from './safety-desk-overview-store';
import { SafetyDeskOverviewActionsService } from './safety-desk-overview-actions.service';
import { SafetyDeskOverviewPendingService } from './safety-desk-overview-pending.service';

export const OVERVIEW_CHEAP_INTERVAL_MS = 10000;
export const OVERVIEW_EXPENSIVE_INTERVAL_MS = 30000;
export const OVERVIEW_COLLECTOR_LOCK_KEY = 'safety-desk:overview:v1:collector';
const CHEAP_STALE_MS = 25000;
const EXPENSIVE_STALE_MS = 65000;
const SUBSCRIPTION_STALE_MS = 150000;
type Bot = SafetyDeskOverviewResponse['bots'][number];

function missing<T>(): SafetyDeskOverviewObservation<T> {
  return { availability: 'UNAVAILABLE', observedAt: null, value: null };
}
function observed<T>(value: T, at: string): SafetyDeskOverviewObservation<T> {
  return { availability: 'FRESH', observedAt: at, value };
}
function failed<T>(old: SafetyDeskOverviewObservation<T>): SafetyDeskOverviewObservation<T> {
  return old.value !== null && old.observedAt !== null
    ? { ...old, availability: 'STALE' }
    : missing();
}
function age<T>(
  row: SafetyDeskOverviewObservation<T>,
  now: number,
  ttl: number,
): SafetyDeskOverviewObservation<T> {
  if (row.value === null || row.observedAt === null) return row;
  const at = Date.parse(row.observedAt);
  if (!Number.isFinite(at) || at > now + 5000)
    return { availability: 'INVALID', observedAt: null, value: null };
  return now - at >= ttl ? { ...row, availability: 'STALE' } : row;
}
function ageMs(at: string | null, now: number): number | null {
  if (at === null) return null;
  const value = now - Date.parse(at);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid overview pending clock');
  return value;
}
function pending(
  countLowerBound: number,
  sampleComplete: boolean,
  oldestAgeMs: number | null,
  ageBasis: SafetyDeskOverviewPending['ageBasis'],
): SafetyDeskOverviewPending {
  return { countLowerBound, sampleComplete, oldestAgeMs, ageBasis };
}

export function overviewHistoryPoint(
  snapshot: SafetyDeskOverviewResponse,
): SafetyDeskOverviewHistoryPoint {
  const queues = snapshot.queues.availability === 'FRESH' ? snapshot.queues.value?.rows : null;
  const sum = (key: 'waiting' | 'active' | 'delayed') =>
    queues
      ? queues.reduce(
          (total, row) => total + row[key] + (key === 'waiting' ? row.prioritized : 0),
          0,
        )
      : null;
  const latency =
    snapshot.actions.availability === 'FRESH' ? snapshot.actions.value?.latency : null;
  return {
    at: new Date(Math.floor(Date.parse(snapshot.generatedAt) / 60000) * 60000).toISOString(),
    waiting: sum('waiting'),
    active: sum('active'),
    delayed: sum('delayed'),
    oldestReceiptAgeMs:
      snapshot.receipts.availability === 'FRESH'
        ? (snapshot.receipts.value?.oldestAgeMs ?? null)
        : null,
    oldestActionAgeMs:
      snapshot.unfinishedActions.availability === 'FRESH'
        ? (snapshot.unfinishedActions.value?.oldestAgeMs ?? null)
        : null,
    p50Ms: latency?.p50Ms ?? null,
    p95Ms: latency?.p95Ms ?? null,
    p99Ms: latency?.p99Ms ?? null,
  };
}

export function ageOverview(
  snapshot: SafetyDeskOverviewResponse,
  now: number,
): SafetyDeskOverviewResponse {
  const at = snapshot.collector.observedAt ? Date.parse(snapshot.collector.observedAt) : NaN;
  const collectorAvailability =
    !Number.isFinite(at) || at > now + 5000
      ? 'INVALID'
      : now - at >= CHEAP_STALE_MS
        ? 'STALE'
        : snapshot.collector.availability;
  return {
    ...snapshot,
    generatedAt: new Date(now).toISOString(),
    collector: { ...snapshot.collector, availability: collectorAvailability },
    queues: age(snapshot.queues, now, CHEAP_STALE_MS),
    workers: age(snapshot.workers, now, CHEAP_STALE_MS),
    receipts: age(snapshot.receipts, now, EXPENSIVE_STALE_MS),
    unfinishedActions: age(snapshot.unfinishedActions, now, EXPENSIVE_STALE_MS),
    actions: age(snapshot.actions, now, EXPENSIVE_STALE_MS),
    bots: snapshot.bots.map((bot) => ({
      ...bot,
      subscription: age(bot.subscription, now, SUBSCRIPTION_STALE_MS),
      publisher: bot.publisher ? age(bot.publisher, now, 45000) : null,
      pendingReceipts: age(bot.pendingReceipts, now, EXPENSIVE_STALE_MS),
      unfinishedActions: age(bot.unfinishedActions, now, EXPENSIVE_STALE_MS),
      actionLatency: age(bot.actionLatency, now, EXPENSIVE_STALE_MS),
      lastTerminalAt: age(bot.lastTerminalAt, now, EXPENSIVE_STALE_MS),
      outcomes: age(bot.outcomes, now, EXPENSIVE_STALE_MS),
    })),
  };
}

@Injectable()
export class SafetyDeskOverviewService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private collecting: Promise<void> | null = null;
  private reading: Promise<SafetyDeskOverviewResponse> | null = null;
  private readCache: { at: number; snapshot: SafetyDeskOverviewResponse } | null = null;
  private observerReading: Promise<SafetyDeskOverviewResponse | null> | null = null;
  private observerReadCache: { at: number; snapshot: SafetyDeskOverviewResponse | null } | null =
    null;
  private latest: SafetyDeskOverviewResponse | null = null;
  private lastExpensiveAt: number | null = null;

  constructor(
    @Inject(SafetyDeskOverviewStore)
    private readonly store: Pick<
      SafetyDeskOverviewStore,
      'connection' | 'readSnapshot' | 'readHistory' | 'write' | 'invalidate'
    >,
    @Inject(QueueMetricsService)
    private readonly queues: Pick<QueueMetricsService, 'getOverviewCounters'>,
    @Inject(MaxBotRegistryService)
    private readonly registry: Pick<
      MaxBotRegistryService,
      'getAllBots' | 'getPublisherBotDescriptor' | 'getDefaultBot'
    >,
    @Inject(SafetyDeskOverviewPendingService)
    private readonly pendingReader: Pick<SafetyDeskOverviewPendingService, 'getSnapshot'>,
    @Inject(SafetyDeskOverviewActionsService)
    private readonly actionsReader: Pick<SafetyDeskOverviewActionsService, 'getSnapshot'>,
  ) {}

  onModuleInit(): void {
    if (!roleRunsAdmin(getAppRole())) return;
    const tick = () => {
      void this.collect().catch(() => {
        /* Readers retain original evidence timestamps after a failed collection. */
      });
    };
    tick();
    this.timer = setInterval(tick, OVERVIEW_CHEAP_INTERVAL_MS);
    this.timer.unref();
  }
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.collecting?.catch(() => {
      /* Already-running reads settle within their existing command/transaction budgets. */
    });
  }

  private empty(): SafetyDeskOverviewResponse {
    const bots: Bot[] = this.registry.getAllBots().map((bot) => ({
      botId: bot.id,
      label: bot.label,
      kind: 'moderator',
      state: bot.state,
      subscription: missing(),
      publisher: null,
      pendingReceipts: missing(),
      actionLatency: missing(),
      unfinishedActions: missing(),
      lastTerminalAt: missing(),
      outcomes: missing(),
    }));
    const publisher = this.registry.getPublisherBotDescriptor();
    bots.push({
      botId: publisher.id,
      label: publisher.label,
      kind: 'publisher',
      state: 'configured',
      subscription: missing(),
      publisher: missing(),
      pendingReceipts: missing(),
      actionLatency: missing(),
      unfinishedActions: missing(),
      lastTerminalAt: missing(),
      outcomes: missing(),
    });
    if (bots.length > 32 || new Set(bots.map((bot) => bot.botId)).size !== bots.length)
      throw new Error('Invalid overview bot catalog');
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      collector: { availability: 'UNAVAILABLE', observedAt: null, lastSuccessfulAt: null },
      queues: missing(),
      receipts: missing(),
      unfinishedActions: missing(),
      actions: missing(),
      workers: missing(),
      bots,
      history: {
        availability: 'UNAVAILABLE',
        observedAt: null,
        windowSec: 86400,
        bucketSec: 60,
        retentionPoints: 1440,
        points: [],
      },
    };
  }

  collect(): Promise<void> {
    if (this.stopping || !roleRunsAdmin(getAppRole())) return Promise.resolve();
    if (this.collecting) return this.collecting;
    const request = this.refresh();
    this.collecting = request;
    const clear = () => {
      if (this.collecting === request) this.collecting = null;
    };
    void request.then(clear, clear);
    return request;
  }

  private async refresh(): Promise<void> {
    const redis = await this.store.connection();
    if (this.stopping) return;
    const token = randomUUID();
    try {
      if ((await redis.set(OVERVIEW_COLLECTOR_LOCK_KEY, token, 'PX', 60000, 'NX')) !== 'OK') return;
      try {
        if (this.stopping) return;
        await this.refreshUnderLease(redis);
      } finally {
        await redis.eval(
          "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0",
          1,
          OVERVIEW_COLLECTOR_LOCK_KEY,
          token,
        );
      }
    } catch (error) {
      this.store.invalidate();
      throw error;
    }
  }

  private async refreshUnderLease(redis: Redis): Promise<void> {
    const now = Date.now(),
      at = new Date(now).toISOString();
    if (!this.latest) {
      try {
        this.latest = await this.store.readSnapshot();
      } catch {
        /* Invalid persisted data is replaced by observed evidence. */
      }
    }
    if (this.stopping) return;
    const catalog = this.empty();
    const previous = this.latest ?? catalog;
    const snapshot: SafetyDeskOverviewResponse = {
      ...previous,
      generatedAt: at,
      bots: catalog.bots.map((bot) => ({
        ...(previous.bots.find((old) => old.botId === bot.botId) ?? bot),
        botId: bot.botId,
        label: bot.label,
        kind: bot.kind,
        state: bot.state,
      })),
      history: catalog.history,
    };
    const publisher = snapshot.bots.find((bot) => bot.kind === 'publisher')!;
    const cheap = await Promise.allSettled([
      this.queues.getOverviewCounters(redis),
      readStorageRuntimeFleet(redis),
      redis.get('system:webhook-subscription:status:v1'),
      redis.get(buildPublisherRuntimeHeartbeatKey(publisher.botId)),
    ]);
    if (this.stopping) return;
    const counters = cheap[0];
    snapshot.queues =
      counters.status === 'fulfilled'
        ? observed({ rows: counters.value.rows }, counters.value.observedAt)
        : failed(snapshot.queues);
    const workers = cheap[1];
    const allInOne = getAppRole() === 'all';
    const workerServices =
      workers.status === 'fulfilled'
        ? workers.value.services.filter((row) =>
            allInOne ? row.service === 'api-all' : row.service !== 'api-all',
          )
        : [];
    snapshot.workers =
      workers.status === 'fulfilled' && workers.value.available
        ? observed(
            {
              expectedCount: workerServices.length,
              freshCount: workerServices.filter((row) => row.snapshot !== null).length,
              rows: workerServices.map((row) => ({
                service: row.service,
                observedAt: row.snapshot ? new Date(row.snapshot.observedAt).toISOString() : null,
              })),
            },
            at,
          )
        : failed(snapshot.workers);
    let subscription: ReturnType<typeof webhookSubscriptionSnapshotSchema.parse> | null = null;
    if (cheap[2].status === 'fulfilled' && cheap[2].value) {
      try {
        if (Buffer.byteLength(cheap[2].value) <= 250000)
          subscription = webhookSubscriptionSnapshotSchema.parse(JSON.parse(cheap[2].value));
      } catch {
        /* Missing or malformed source observations remain unavailable. */
      }
    }
    snapshot.bots = snapshot.bots.map((bot) => {
      const row = subscription?.bots[bot.botId];
      const diagnostics = row?.operationalDiagnostics;
      const current =
        row?.checkedAt && diagnostics
          ? age(
              observed(
                {
                  configured: row.configured,
                  subscribed: diagnostics.hasCurrentSubscription,
                  lastIncomingAt: diagnostics.lastIncomingWebhookAt,
                },
                row.checkedAt,
              ),
              now,
              SUBSCRIPTION_STALE_MS,
            )
          : failed(bot.subscription);
      return { ...bot, subscription: current };
    });
    const rawPublisher = cheap[3].status === 'fulfilled' ? cheap[3].value : null;
    const heartbeat =
      rawPublisher && Buffer.byteLength(rawPublisher) <= 8192
        ? parsePublisherRuntimeHeartbeat(rawPublisher, publisher.botId, now)
        : null;
    const publisherRow = snapshot.bots.find((bot) => bot.kind === 'publisher')!;
    publisherRow.publisher = heartbeat
      ? observed(
          { dispatchEnabled: heartbeat.dispatchEnabled, blocker: heartbeat.blocker },
          heartbeat.observedAt,
        )
      : failed(publisherRow.publisher ?? missing());

    if (
      this.lastExpensiveAt === null ||
      now < this.lastExpensiveAt ||
      now - this.lastExpensiveAt >= OVERVIEW_EXPENSIVE_INTERVAL_MS
    ) {
      this.lastExpensiveAt = now;
      const ids = snapshot.bots.map((bot) => bot.botId),
        defaultBotId = this.registry.getDefaultBot().id;
      try {
        const sample = await this.pendingReader.getSnapshot(ids, defaultBotId);
        const sampleAt = Date.parse(sample.observedAt);
        snapshot.bots = snapshot.bots.map((bot) => {
          const row = sample.bots.find((item) => item.botId === bot.botId);
          if (!row)
            return {
              ...bot,
              pendingReceipts: failed(bot.pendingReceipts),
              unfinishedActions: failed(bot.unfinishedActions),
            };
          const receiptAges = [
            ageMs(row.received.oldestAt, sampleAt),
            ageMs(row.queued.oldestAt, sampleAt),
          ].filter((value): value is number => value !== null);
          return {
            ...bot,
            pendingReceipts: observed(
              pending(
                row.received.countLowerBound + row.queued.countLowerBound,
                !row.received.truncated && !row.queued.truncated,
                receiptAges.length ? Math.max(...receiptAges) : null,
                'receipt_created',
              ),
              sample.observedAt,
            ),
            unfinishedActions: observed(
              pending(
                row.unfinishedActions.countLowerBound,
                !row.unfinishedActions.truncated,
                ageMs(row.unfinishedActions.oldestStateAt, sampleAt),
                'state_updated_sample',
              ),
              sample.observedAt,
            ),
          };
        });
        const receipts = snapshot.bots.map((bot) => bot.pendingReceipts.value!);
        const receiptAges = receipts.flatMap((row) =>
          row.oldestAgeMs === null ? [] : [row.oldestAgeMs],
        );
        snapshot.receipts = observed(
          pending(
            receipts.reduce((sum, row) => sum + row.countLowerBound, 0),
            receipts.every((row) => row.sampleComplete),
            receiptAges.length ? Math.max(...receiptAges) : null,
            'receipt_created',
          ),
          sample.observedAt,
        );
        snapshot.unfinishedActions = observed(
          pending(
            sample.unfinishedActions.countLowerBound,
            !sample.unfinishedActions.truncated,
            ageMs(sample.unfinishedActions.oldestStateAt, sampleAt),
            'state_updated_sample',
          ),
          sample.observedAt,
        );
      } catch {
        snapshot.receipts = failed(snapshot.receipts);
        snapshot.unfinishedActions = failed(snapshot.unfinishedActions);
        snapshot.bots = snapshot.bots.map((bot) => ({
          ...bot,
          pendingReceipts: failed(bot.pendingReceipts),
          unfinishedActions: failed(bot.unfinishedActions),
        }));
      }
      if (this.stopping) return;
      try {
        const sample = await this.actionsReader.getSnapshot(ids, defaultBotId);
        snapshot.actions = observed(sample.actions, sample.observedAt);
        snapshot.bots = snapshot.bots.map((bot) => {
          const row = sample.bots.find((item) => item.botId === bot.botId);
          return row
            ? {
                ...bot,
                actionLatency: observed(row.latency, sample.observedAt),
                lastTerminalAt: observed({ at: row.lastTerminalAt }, sample.observedAt),
                outcomes: observed(row.outcomes, sample.observedAt),
              }
            : bot;
        });
      } catch {
        snapshot.actions = failed(snapshot.actions);
        snapshot.bots = snapshot.bots.map((bot) => ({
          ...bot,
          actionLatency: failed(bot.actionLatency),
          lastTerminalAt: failed(bot.lastTerminalAt),
          outcomes: failed(bot.outcomes),
        }));
      }
    }
    if (this.stopping) return;
    snapshot.collector = {
      availability: 'FRESH',
      observedAt: at,
      lastSuccessfulAt: [
        snapshot.queues,
        snapshot.receipts,
        snapshot.unfinishedActions,
        snapshot.actions,
        snapshot.workers,
      ].every((row) => row.availability === 'FRESH')
        ? at
        : previous.collector.lastSuccessfulAt,
    };
    const valid = safetyDeskOverviewResponseSchema.parse(snapshot);
    await this.store.write(valid, overviewHistoryPoint(valid));
    this.latest = valid;
    this.readCache = null;
    this.observerReadCache = null;
  }

  async getObserverSnapshot(): Promise<SafetyDeskOverviewResponse> {
    try {
      const now = Date.now();
      let stored: SafetyDeskOverviewResponse | null;
      if (
        this.observerReadCache &&
        now >= this.observerReadCache.at &&
        now - this.observerReadCache.at < 1000
      ) {
        stored = this.observerReadCache.snapshot;
      } else {
        const reading = this.observerReading ?? this.store.readSnapshot();
        this.observerReading = reading;
        try {
          stored = await reading;
          this.observerReadCache = { snapshot: stored, at: Date.now() };
        } finally {
          if (this.observerReading === reading) this.observerReading = null;
        }
      }
      if (!stored) return this.empty();
      // FLAG: Machine reads reuse bounded shared evidence; they never collect or read history.
      return ageOverview(
        {
          ...stored,
          history: { ...stored.history, availability: 'UNAVAILABLE', observedAt: null, points: [] },
        },
        Date.now(),
      );
    } catch (error) {
      const unavailable = this.empty();
      if (error instanceof OverviewInvalidEvidenceError)
        unavailable.collector.availability = 'INVALID';
      return unavailable;
    }
  }

  getSnapshot(): Promise<SafetyDeskOverviewResponse> {
    const now = Date.now();
    if (this.readCache && now >= this.readCache.at && now - this.readCache.at < 1000)
      return Promise.resolve(ageOverview(this.readCache.snapshot, now));
    if (this.reading) return this.reading;
    const request = (async () => {
      try {
        const [stored, points] = await Promise.all([
          this.store.readSnapshot(),
          this.store.readHistory(now),
        ]);
        if (!stored) return this.empty();
        const latestPoint = points.at(-1)?.at ?? null;
        const snapshot = ageOverview(
          {
            ...stored,
            history: {
              ...stored.history,
              points,
              observedAt: latestPoint,
              availability: latestPoint
                ? now - Date.parse(latestPoint) < 120000
                  ? 'FRESH'
                  : 'STALE'
                : 'UNAVAILABLE',
            },
          },
          now,
        );
        this.readCache = { snapshot, at: now };
        return snapshot;
      } catch (error) {
        // FLAG: Redis failure must never turn a local process's empty counters into fleet health.
        const unavailable = this.empty();
        if (error instanceof OverviewInvalidEvidenceError) {
          unavailable.collector.availability = 'INVALID';
          unavailable.history.availability = 'INVALID';
        }
        return unavailable;
      }
    })();
    this.reading = request;
    const clear = () => {
      if (this.reading === request) this.reading = null;
    };
    void request.then(clear, clear);
    return request;
  }
}
