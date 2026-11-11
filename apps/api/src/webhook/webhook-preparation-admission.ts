import { WebhookPreparationDeferredError } from '../common/webhook-preparation-deferred.error';
import { addWebhookMetric, WebhookPreparationRuntimeMetrics } from './webhook-runtime-metrics';

type WorkClass = 'ordinary' | 'interactive' | 'lifecycle';
type ReservedWorkClass = Exclude<WorkClass, 'ordinary'>;
export type WebhookPreparationSchedulingState =
  | 'available'
  | 'shared_capacity'
  | 'scope_capacity'
  | 'closed';
const DURATION_BOUNDS_MS = [5, 25, 100, 1_000, 5_000, 15_000, 30_000];

export class WebhookPreparationAdmission {
  readonly maxInFlight: number;
  private readonly byBot = new Map<string, Record<WorkClass, number>>();
  private readonly active = new Set<Promise<void>>();
  private readonly byClass = { ordinary: 0, interactive: 0, lifecycle: 0 };
  private closed = false;
  private readonly reservations = new Map<ReservedWorkClass, number>();
  private windowStartedAt = Date.now();
  private metrics = this.emptyMetrics();
  private readonly runtimeMetrics = new WebhookPreparationRuntimeMetrics();

  constructor(
    poolMax: number,
    private readonly report: (metric: Record<string, unknown>) => void,
  ) {
    if (!Number.isSafeInteger(poolMax) || poolMax < 1)
      throw new Error('Invalid webhook preparation pool budget');
    this.maxInFlight = Math.max(1, Math.min(12, Math.floor(poolMax / 2)));
  }

  private availability(botId: string, workClass: WorkClass) {
    const botCounts = this.byBot.get(botId) ?? { ordinary: 0, interactive: 0, lifecycle: 0 };
    const botActive = botCounts[workClass];
    // FLAG: Keep half the SQL pool outside preparation and at least three bot/class
    // shares in expanded pools. Interactive work still has its independent one-slot cap.
    const botClassLimit =
      this.maxInFlight <= 8
        ? Math.max(1, Math.min(2, Math.floor(this.maxInFlight / 2)))
        : Math.floor(this.maxInFlight / 3);
    const globalFull = this.active.size >= this.maxInFlight;
    const now = Date.now();
    for (const [reservedClass, until] of this.reservations)
      if (until <= now) this.reservations.delete(reservedClass);
    const nextClass = this.reservations.keys().next().value;
    const reserved =
      nextClass !== undefined &&
      workClass !== nextClass &&
      this.active.size >= this.maxInFlight - 1;
    const limited =
      this.closed ||
      globalFull ||
      reserved ||
      botActive >= botClassLimit ||
      (workClass === 'interactive' && this.byClass.interactive >= 1);
    return { botCounts, botActive, botClassLimit, globalFull, reserved, limited };
  }

  canRun(botId: string, workClass: WorkClass): boolean {
    return this.schedulingState(botId, workClass) === 'available';
  }

  schedulingState(botId: string, workClass: WorkClass): WebhookPreparationSchedulingState {
    const availability = this.availability(botId, workClass);
    this.reserveNextSlot(workClass, availability);
    if (this.closed) return 'closed';
    // FLAG: Shared saturation/reservation must not erase a scanned receipt's FIFO
    // position. Only a scope-specific limit with spare shared capacity releases it.
    if (availability.globalFull) return 'shared_capacity';
    if (
      availability.botActive >= availability.botClassLimit ||
      (workClass === 'interactive' && this.byClass.interactive >= 1)
    )
      return 'scope_capacity';
    return availability.reserved ? 'shared_capacity' : 'available';
  }

  nextCompletion(): Promise<void> | null {
    return this.active.size > 0 ? Promise.race(this.active) : null;
  }

  private reserveNextSlot(
    workClass: WorkClass,
    availability: ReturnType<WebhookPreparationAdmission['availability']>,
  ) {
    // FLAG: Only eligible priority classes reserve the last free slot. Keep at most
    // two expiring class hints, in first-wait order: repeated lifecycle or command
    // traffic must not overtake the other class. Payloads stay in the durable outbox.
    if (
      workClass !== 'ordinary' &&
      !this.closed &&
      (availability.globalFull || availability.reserved) &&
      availability.botActive < availability.botClassLimit &&
      (workClass !== 'interactive' || this.byClass.interactive < 1)
    )
      this.reservations.set(workClass, Date.now() + 5_000);
  }

  run<T>(botId: string, workClass: WorkClass, task: () => Promise<T>): Promise<T> {
    // FLAG: No waiting promises are retained on overload. The existing receipt/outbox
    // remains the queue, with a typed non-exhausting retry instead of RAM-only work.
    const availability = this.availability(botId, workClass);
    const { botCounts, limited } = availability;
    if (limited) {
      // FLAG: Work blocked by its own bot/class quota cannot reserve idle shared capacity.
      this.reserveNextSlot(workClass, availability);
      this.metrics.deferred[workClass] += 1;
      this.runtimeMetrics.deferred[workClass] = addWebhookMetric(
        this.runtimeMetrics.deferred[workClass],
      );
      this.flushIfDue();
      return Promise.reject(
        new WebhookPreparationDeferredError('Webhook preparation capacity unavailable', 1_000),
      );
    }
    // FLAG: Admission consumes the next-slot reservation. Never clear it on completion,
    // which could erase a newer reservation created while this task was running.
    if (workClass !== 'ordinary') this.reservations.delete(workClass);
    botCounts[workClass] += 1;
    this.byBot.set(botId, botCounts);
    this.byClass[workClass] += 1;
    const startedAt = performance.now();
    const finish = (failed: boolean) => {
      this.runtimeMetrics.finish(workClass, startedAt, failed);
      this.active.delete(tracked);
      botCounts[workClass] -= 1;
      if (Object.values(botCounts).every((count) => count === 0)) this.byBot.delete(botId);
      this.byClass[workClass] -= 1;
      const duration = Math.max(0, performance.now() - startedAt);
      const bucket = DURATION_BOUNDS_MS.findIndex((limit) => duration <= limit);
      this.metrics.durationHistogram[bucket < 0 ? DURATION_BOUNDS_MS.length : bucket] += 1;
      this.flushIfDue();
    };
    const operation = Promise.resolve()
      .then(task)
      .then(
        (value) => {
          finish(false);
          return value;
        },
        (error: unknown) => {
          finish(true);
          throw error;
        },
      );
    const tracked = operation.then(
      () => undefined,
      () => undefined,
    );
    this.active.add(tracked);
    this.metrics.peakInFlight = Math.max(this.metrics.peakInFlight, this.active.size);
    this.metrics.admitted[workClass] += 1;
    this.runtimeMetrics.admitted[workClass] = addWebhookMetric(
      this.runtimeMetrics.admitted[workClass],
    );
    this.runtimeMetrics.peakInFlight = Math.max(this.runtimeMetrics.peakInFlight, this.active.size);
    return operation;
  }

  stop(): void {
    this.closed = true;
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.active]);
  }
  snapshot() {
    return { inFlight: this.active.size, pending: 0, botScopes: this.byBot.size, ...this.byClass };
  }

  runtimeSnapshot() {
    const { inFlight, botScopes, ordinary, interactive, lifecycle } = this.snapshot();
    return {
      maxInFlight: this.maxInFlight,
      inFlight,
      botScopes,
      active: { ordinary, interactive, lifecycle },
      closed: this.closed,
      admitted: { ...this.runtimeMetrics.admitted },
      deferred: { ...this.runtimeMetrics.deferred },
      completed: { ...this.runtimeMetrics.completed },
      errors: { ...this.runtimeMetrics.errors },
      peakInFlight: this.runtimeMetrics.peakInFlight,
      duration: {
        ...this.runtimeMetrics.duration,
        buckets: { ...this.runtimeMetrics.duration.buckets },
      },
    };
  }

  flush(): void {
    try {
      this.report({
        metric: 'webhook_preparation_admission_v1',
        ...this.metrics,
        ...this.snapshot(),
        maxInFlight: this.maxInFlight,
        durationUpperBoundsMs: [...DURATION_BOUNDS_MS, null],
        windowMs: Date.now() - this.windowStartedAt,
      });
    } catch {
      /* FLAG: Metrics do not change durable preparation outcomes. */
    }
    this.metrics = this.emptyMetrics();
    this.windowStartedAt = Date.now();
  }
  private flushIfDue(): void {
    if (Date.now() - this.windowStartedAt >= 60_000) this.flush();
  }
  private emptyMetrics() {
    return {
      admitted: { ordinary: 0, interactive: 0, lifecycle: 0 },
      deferred: { ordinary: 0, interactive: 0, lifecycle: 0 },
      peakInFlight: 0,
      durationHistogram: Array<number>(DURATION_BOUNDS_MS.length + 1).fill(0),
    };
  }
}
