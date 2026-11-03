import { setTimeout as delay } from 'node:timers/promises';
import { Queue, Worker, type Job } from 'bullmq';
import type { Config } from './config.js';
import { MaxError, type MaxTransport } from './max.js';
import { Store, CHAT_BUFFER, HOUSEKEEPING_INTERVAL_MS } from './store.js';
import { ServiceError, type Lane } from './types.js';
import { ProgressLog } from './progress-log.js';
import type { HousekeepingHealth } from './housekeeping.js';

export const MAX_WAKEUPS = 64;
export const MAX_SAFETY_WAKEUPS = 2;
export const ERASER_CONNECTION_REQUEST_VERSION = 1;
export const MAX_CONNECTION_WAKEUPS = 16;
const WORKER_PROGRESS_LIMIT_MS = 120_000;
const DIAGNOSTIC_LOG_INTERVAL_MS = 30_000;
export type Wakeup = { chatId: string; leaseToken: string; purpose?: 'due' | 'safety' };
type WorkerErrorCode = 'worker_error' | 'job_failed' | 'job_stalled' | 'worker_closed';
type WorkerObservation = {
  ready: boolean;
  sampledAt: number | null;
  occupiedSlots: number;
  oldestOccupiedAt: number | null;
  lastCompletedAt: number | null;
  lastErrorAt: number | null;
  lastErrorCode: WorkerErrorCode | null;
  errorPending: boolean;
  lastLoggedAt: number | null;
  activeJobs: number;
  drained: boolean;
};
type WorkerHealth = {
  healthy: boolean;
  ready: boolean;
  running: boolean;
  sampledAt: string | null;
  occupiedSlots: number;
  oldestOccupiedAt: string | null;
  lastCompletedAt: string | null;
  lastErrorAt: string | null;
  lastErrorCode: WorkerErrorCode | null;
  progressOverdue: boolean;
};
function workerObservation(): WorkerObservation {
  return {
    ready: false,
    sampledAt: null,
    occupiedSlots: 0,
    oldestOccupiedAt: null,
    lastCompletedAt: null,
    lastErrorAt: null,
    lastErrorCode: null,
    errorPending: false,
    lastLoggedAt: null,
    activeJobs: 0,
    drained: false,
  };
}
export class CleanupRuntime {
  private queue: Queue<Wakeup, void, 'visit'> | null = null;
  private worker: Worker<Wakeup, void, 'visit'> | null = null;
  private connectionQueue: Queue<Wakeup, void, 'connect'> | null = null;
  private connectionWorker: Worker<Wakeup, void, 'connect'> | null = null;
  private connectionRunning = false;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopping = false;
  private lastMaintenance = Date.now();
  private lastSchedulerAt: number | null = null;
  private lastConnectionSchedulerAt: number | null = null;
  private readonly cleanupObservation = workerObservation();
  private readonly connectionObservation = workerObservation();
  private readonly progressLog = new ProgressLog();
  constructor(
    private readonly store: Store,
    private readonly max: MaxTransport,
    private readonly config: Pick<Config, 'redisUrl' | 'enabled'>,
    private readonly prefix = 'eraser',
  ) {}
  async start(): Promise<void> {
    if (!this.config.enabled || this.stopping) return;
    this.queue = new Queue<Wakeup, void, 'visit'>('cleanup', {
      connection: { url: this.config.redisUrl, maxRetriesPerRequest: 1 },
      prefix: this.prefix,
    });
    await this.queue.setGlobalConcurrency(8);
    if (this.stopping) return;
    this.worker = new Worker<Wakeup, void, 'visit'>(
      'cleanup',
      async (job: Job<Wakeup>) => this.visit(job.data),
      {
        connection: { url: this.config.redisUrl, maxRetriesPerRequest: null },
        prefix: this.prefix,
        concurrency: 8,
        lockDuration: 60_000,
      },
    );
    this.observeWorker(this.worker, this.cleanupObservation, 'cleanup');
    this.connectionQueue = new Queue<Wakeup, void, 'connect'>('connections', {
      connection: { url: this.config.redisUrl, maxRetriesPerRequest: 1 },
      prefix: this.prefix,
    });
    await this.connectionQueue.setGlobalConcurrency(2);
    if (this.stopping) return;
    this.connectionWorker = new Worker<Wakeup, void, 'connect'>(
      'connections',
      async (job: Job<Wakeup>) => this.connect(job.data),
      {
        connection: { url: this.config.redisUrl, maxRetriesPerRequest: null },
        prefix: this.prefix,
        concurrency: 2,
        lockDuration: 60_000,
      },
    );
    this.observeWorker(this.connectionWorker, this.connectionObservation, 'connection');
    this.timer = setInterval(() => {
      void this.tick().catch(() => this.progressLog.failure('cleanup_scheduler_failed'));
      void this.tickConnections().catch(() =>
        this.progressLog.failure('connection_scheduler_failed'),
      );
    }, 1000);
  }
  private observeWorker<Name extends 'visit' | 'connect'>(
    worker: Worker<Wakeup, void, Name>,
    observation: WorkerObservation,
    component: 'cleanup' | 'connection',
  ): void {
    const recoverIdle = () => {
      // FLAG: Drained may precede the last job's failure. Combine actual consumer events;
      // a fresh scheduler sample alone cannot certify recovery of an idle worker.
      if (
        observation.drained &&
        observation.activeJobs === 0 &&
        worker.isRunning() &&
        !worker.isPaused() &&
        !worker.closing
      )
        observation.errorPending = false;
    };
    const failure = (code: WorkerErrorCode) => {
      observation.errorPending = true;
      observation.lastErrorAt = Date.now();
      observation.lastErrorCode = code;
      // FLAG: Emit only bounded allowlisted diagnostics, never job IDs, payloads or Error text.
      if (
        !this.stopping &&
        (observation.lastLoggedAt === null ||
          Date.now() - observation.lastLoggedAt >= DIAGNOSTIC_LOG_INTERVAL_MS)
      ) {
        observation.lastLoggedAt = Date.now();
        process.stderr.write(JSON.stringify({ service: 'eraser', component, code }) + '\n');
      }
    };
    worker.on('ready', () => {
      observation.ready = true;
      if (observation.lastErrorCode === 'worker_error') observation.errorPending = false;
    });
    worker.on('completed', () => {
      observation.activeJobs = Math.max(0, observation.activeJobs - 1);
      observation.lastCompletedAt = Date.now();
      observation.errorPending = false;
    });
    worker.on('active', () => {
      observation.activeJobs++;
      observation.drained = false;
    });
    worker.on('drained', () => {
      observation.drained = true;
      recoverIdle();
    });
    worker.on('error', () => failure('worker_error'));
    worker.on('failed', (job) => {
      if (job) observation.activeJobs = Math.max(0, observation.activeJobs - 1);
      failure('job_failed');
      recoverIdle();
    });
    worker.on('stalled', () => failure('job_stalled'));
    worker.on('closed', () => {
      observation.ready = false;
      failure('worker_closed');
    });
  }
  private sampleWorker(
    observation: WorkerObservation,
    slots: Array<{ occupied: boolean; timestamp: number | null }>,
  ): void {
    observation.sampledAt = Date.now();
    observation.occupiedSlots = slots.filter((slot) => slot.occupied).length;
    const timestamps = slots.flatMap((slot) => (slot.timestamp === null ? [] : [slot.timestamp]));
    observation.oldestOccupiedAt = timestamps.length ? Math.min(...timestamps) : null;
  }
  async tickConnections(): Promise<void> {
    if (this.connectionRunning || this.stopping || !this.connectionQueue) return;
    this.connectionRunning = true;
    try {
      const slots = await Promise.all(
        Array.from({ length: MAX_CONNECTION_WAKEUPS }, async (_, index) => {
          const id = `slot-${index}`;
          const job = await this.connectionQueue!.getJob(id);
          return { id, occupied: Boolean(job), timestamp: job?.timestamp ?? null };
        }),
      );
      this.sampleWorker(this.connectionObservation, slots);
      const available = slots.filter((slot) => !slot.occupied);
      if (available.length) {
        const reserved = await this.store.reserveConnections(available.length);
        for (const [index, wakeup] of reserved.entries()) {
          const jobId = available[index]!.id;
          try {
            await this.connectionQueue.add('connect', wakeup, {
              jobId,
              removeOnComplete: true,
              removeOnFail: true,
              attempts: 1,
            });
            const persisted = await this.connectionQueue.getJob(jobId);
            if (persisted && persisted.data.leaseToken !== wakeup.leaseToken)
              await this.store.finishConnection(
                wakeup.chatId,
                wakeup.leaseToken,
                'pending',
                'queue_race',
                1000,
              );
          } catch {
            await this.store.finishConnection(
              wakeup.chatId,
              wakeup.leaseToken,
              'pending',
              'queue_unavailable',
              5000,
            );
          }
        }
      }
      this.lastConnectionSchedulerAt = Date.now();
    } finally {
      this.connectionRunning = false;
    }
  }
  async connect({ chatId, leaseToken }: Wakeup): Promise<void> {
    let actorCheck = false;
    try {
      const request = await this.store.connectionRequest(chatId, leaseToken);
      if (!request || this.stopping || !this.config.enabled) return;
      const before = async () => {
        const current = await this.store.connectionRequest(chatId, leaseToken);
        if (current && current.connection_generation !== request.connection_generation)
          throw new MaxError(0, 'connection_guard_changed', false);
        if (this.stopping || !this.config.enabled || !current)
          throw new ServiceError(
            409,
            'ERASER_CONNECTION_STOPPED',
            'Ожидание подключения завершено.',
          );
      };
      // FLAG: The callback runs after MAX rate admission, so a delayed job cannot send new probes
      // beyond its explicit opt-in, lease or cancellation deadline.
      await this.max.rights(chatId, before);
      const botCheckedAt = Date.now();
      await before();
      actorCheck = true;
      await this.max.actorRights(chatId, request.actor_user_id, async () => {
        await before();
        if (Date.now() - botCheckedAt > 10_000)
          throw new MaxError(0, 'connection_proof_stale', false);
      });
      if (Date.now() - botCheckedAt > 15_000)
        throw new MaxError(0, 'connection_proof_stale', false);
      const activated = await this.store.activateConnection(chatId, leaseToken, {
        chatId,
        connectionGeneration: request.connection_generation,
        expiresAt: new Date(botCheckedAt + 15_000),
      });
      if (!activated)
        await this.store.finishConnection(
          chatId,
          leaseToken,
          'pending',
          'connection_guard_changed',
          30_000,
        );
    } catch (failure) {
      if (failure instanceof MaxError && failure.code === 'eraser_rights_missing')
        await this.store.connection(chatId, 'no_access');
      const cancelled =
        actorCheck &&
        failure instanceof MaxError &&
        failure.status === 403 &&
        failure.code === 'actor_rights_missing';
      const wait =
        failure instanceof MaxError && failure.status === 429
          ? Math.max(30_000, failure.retryAfterMs)
          : 30_000;
      await this.store.finishConnection(
        chatId,
        leaseToken,
        cancelled ? 'cancelled' : 'pending',
        failure instanceof MaxError || failure instanceof ServiceError
          ? failure.code
          : 'connection_check_failed',
        wait,
      );
    }
  }
  async tick(): Promise<void> {
    if (this.running || this.stopping || !this.queue) return;
    this.running = true;
    try {
      // FLAG: Fixed slot IDs bound queued work across scheduler replicas, not just one process.
      const slots = await Promise.all(
        Array.from({ length: MAX_WAKEUPS }, async (_, index) => {
          const id = `slot-${index}`;
          const job = await this.queue!.getJob(id);
          return {
            id,
            purpose: index < MAX_WAKEUPS - MAX_SAFETY_WAKEUPS ? 'due' : 'safety',
            occupied: Boolean(job),
            timestamp: job?.timestamp ?? null,
          };
        }),
      );
      this.sampleWorker(this.cleanupObservation, slots);
      // FLAG: Reserve only two fixed slots for the shared safety budget. A backlog of slow
      // safety probes cannot occupy all ordinary slots or expire their health deadline.
      // Reserve them first so continuous due history cannot monopolize the same chat's lease.
      for (const purpose of ['safety', 'due'] as const) {
        const available = slots.filter((slot) => !slot.occupied && slot.purpose === purpose);
        if (!available.length) continue;
        const reserved = await this.store.reserve(available.length, purpose);
        for (const [index, wakeup] of reserved.entries()) {
          const jobId = available[index]!.id;
          try {
            await this.queue.add('visit', wakeup, {
              jobId,
              removeOnComplete: true,
              removeOnFail: true,
              attempts: 1,
            });
            const persisted = await this.queue.getJob(jobId);
            if (persisted && persisted.data.leaseToken !== wakeup.leaseToken)
              await this.store.finishVisit(wakeup.chatId, wakeup.leaseToken, null, 1000);
          } catch {
            await this.store.finishVisit(
              wakeup.chatId,
              wakeup.leaseToken,
              'queue_unavailable',
              5000,
            );
          }
        }
      }
      if (Date.now() - this.lastMaintenance >= HOUSEKEEPING_INTERVAL_MS) {
        // FLAG: Attempt time bounds failure retries too; maintenance failure cannot stall dispatch.
        this.lastMaintenance = Date.now();
        await this.store
          .housekeeping()
          .catch(() => this.progressLog.failure('housekeeping_failed'));
      }
      this.lastSchedulerAt = Date.now();
    } finally {
      this.running = false;
      if (!this.stopping) this.progressLog.progress(this.health(), this.max.metrics?.());
    }
  }
  async visit(wakeup: Wakeup): Promise<void> {
    const { chatId, leaseToken, purpose = 'due' } = wakeup;
    let error: string | null = null,
      wait = 1000;
    try {
      let policy = await this.store.active(chatId, leaseToken);
      if (!policy || this.stopping || !this.config.enabled) return;
      // FLAG: Unknown DELETE journals have no automatic readback or replay. Only a positive
      // acknowledgement or authenticated removal event can settle the original attempt.
      let rightsAt = 0;
      let candidates = await this.store.nextCandidates(chatId, policy.hours);
      if (
        (purpose === 'safety' || candidates.every((candidate) => candidate.lane !== 'live')) &&
        (await this.store.bufferSize(chatId)) <= CHAT_BUFFER - 100
      ) {
        // FLAG: Current expiry wins admission. History uses only the visit's spare capacity.
        const lanes: readonly Lane[] = purpose === 'safety' ? ['live'] : ['live', 'history'];
        for (const lane of lanes) {
          policy = await this.store.active(chatId, leaseToken);
          if (!policy || this.stopping) return;
          const window = await this.store.openScan(policy, lane, purpose);
          if (!window) continue;
          // FLAG: Evidence begins before admission/request; reusing it never extends freshness.
          if (Date.now() - rightsAt >= 30_000) {
            rightsAt = Date.now();
            await this.max.rights(chatId, undefined, purpose === 'safety' ? 'safety' : undefined);
            await this.store.connection(chatId, 'connected');
          }
          const page = await this.max.page(
            chatId,
            window.upper,
            window.lower,
            purpose === 'safety' ? 'safety' : undefined,
          );
          await this.store.savePage(policy, lane, page, purpose);
          candidates = await this.store.nextCandidates(chatId, policy.hours);
          if (candidates.length) break;
        }
      }
      let pinAt = 0;
      let pin: string | null = null;
      for (const candidate of candidates) {
        policy = await this.store.active(chatId, leaseToken);
        if (!policy || this.stopping) break;
        const due = Number(candidate.source_ms) + policy.hours * 3_600_000;
        if (due > Date.now()) {
          await this.store.defer(candidate, 'not_due', Math.min(due - Date.now(), 3_600_000));
          continue;
        }
        if (Date.now() - rightsAt >= 30_000) {
          rightsAt = Date.now();
          await this.max.rights(chatId);
          await this.store.connection(chatId, 'connected');
        }
        if (Date.now() - pinAt >= 5000) {
          pinAt = Date.now();
          pin = await this.max.pin(chatId);
        }
        if (pin === candidate.message_id) {
          await this.store.defer(candidate, 'pinned', 60_000);
          continue;
        }
        let issued = candidate;
        try {
          await this.max.remove(chatId, candidate.message_id, async () => {
            if (this.stopping)
              throw new ServiceError(409, 'ERASER_GUARD_CHANGED', 'Удаление отложено.');
            const dispatch = await this.store.assertAndMarkDispatch(
              candidate,
              leaseToken,
              rightsAt,
              pinAt,
            );
            issued = { ...candidate, state: 'dispatching', dispatch_id: dispatch };
          });
          await this.store.settle(issued, 'deleted', 'deleted');
        } catch (failure) {
          if (failure instanceof ServiceError) {
            if (failure.code === 'ERASER_PROTECTED')
              await this.store.settle(candidate, 'protected', 'protected');
            else if (failure.code === 'ERASER_PROTECTION_PENDING')
              await this.store.deferProtection(candidate);
            else await this.store.defer(candidate, 'policy_changed', 1000);
          } else if (failure instanceof MaxError && failure.status === 429 && !failure.attempted) {
            await this.store.settle(issued, 'pending', 'rate_limited', failure.retryAfterMs);
            throw failure;
          } else if (issued !== candidate) {
            // FLAG: Timeout, malformed acknowledgement and generic errors retain mutation uncertainty.
            await this.store.settle(issued, 'uncertain', 'reconciliation', 10_000);
            throw failure;
          } else throw failure;
        }
      }
    } catch (failure) {
      if (failure instanceof MaxError) {
        error = failure.code;
        wait =
          failure.status === 429 ? failure.retryAfterMs : failure.status === 403 ? 300_000 : 5000;
        if (failure.code === 'eraser_rights_missing')
          await this.store.connection(chatId, 'no_access');
      } else {
        error = 'worker_error';
        wait = 5000;
      }
    } finally {
      await this.store.finishVisit(chatId, leaseToken, error, wait);
    }
  }
  health(): {
    schedulerLastSuccessfulAt: string | null;
    schedulerHealthy: boolean;
    connectionSchedulerLastSuccessfulAt?: string | null;
    connectionSchedulerHealthy?: boolean;
    workers?: { cleanup: WorkerHealth; connection: WorkerHealth };
    housekeeping?: HousekeepingHealth;
  } {
    const now = Date.now();
    const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString());
    const workerHealth = <Name extends 'visit' | 'connect'>(
      worker: Worker<Wakeup, void, Name> | null,
      observation: WorkerObservation,
    ): WorkerHealth => {
      const running = Boolean(worker?.isRunning() && !worker.isPaused() && !worker.closing);
      // FLAG: An idle ready worker needs no completion heartbeat. Occupied slots do: their
      // age includes queue wait and exposes a stuck consumer even when scheduler ticks succeed.
      const progressOverdue =
        observation.oldestOccupiedAt !== null &&
        now - observation.oldestOccupiedAt >= WORKER_PROGRESS_LIMIT_MS;
      return {
        healthy:
          !this.config.enabled ||
          (!this.stopping &&
            running &&
            observation.ready &&
            !observation.errorPending &&
            observation.sampledAt !== null &&
            now - observation.sampledAt < 10_000 &&
            !progressOverdue),
        ready: observation.ready,
        running,
        sampledAt: iso(observation.sampledAt),
        occupiedSlots: observation.occupiedSlots,
        oldestOccupiedAt: iso(observation.oldestOccupiedAt),
        lastCompletedAt: iso(observation.lastCompletedAt),
        lastErrorAt: iso(observation.lastErrorAt),
        lastErrorCode: observation.lastErrorCode,
        progressOverdue,
      };
    };
    const workers = {
      cleanup: workerHealth(this.worker, this.cleanupObservation),
      connection: workerHealth(this.connectionWorker, this.connectionObservation),
    };
    const connectionHealthy =
      !this.config.enabled ||
      (this.lastConnectionSchedulerAt !== null &&
        Date.now() - this.lastConnectionSchedulerAt < 10_000);
    return {
      schedulerLastSuccessfulAt: this.lastSchedulerAt
        ? new Date(this.lastSchedulerAt).toISOString()
        : null,
      schedulerHealthy:
        !this.config.enabled ||
        (this.lastSchedulerAt !== null &&
          Date.now() - this.lastSchedulerAt < 10_000 &&
          connectionHealthy &&
          workers.cleanup.healthy &&
          workers.connection.healthy),
      connectionSchedulerLastSuccessfulAt: this.lastConnectionSchedulerAt
        ? new Date(this.lastConnectionSchedulerAt).toISOString()
        : null,
      connectionSchedulerHealthy: connectionHealthy,
      workers,
      housekeeping: this.store.housekeepingHealth(),
    };
  }
  stopAdmission(): void {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  async close(): Promise<void> {
    this.stopAdmission();
    while (this.running || this.connectionRunning) await delay(10);
    // FLAG: BullMQ pause reconnects its blocking client. Never pause an already closing worker.
    if (this.worker && !this.worker.closing) await this.worker.pause();
    if (this.connectionWorker && !this.connectionWorker.closing)
      await this.connectionWorker.pause();
    await this.worker?.close();
    await this.connectionWorker?.close();
    await this.queue?.close();
    await this.connectionQueue?.close();
  }
}
