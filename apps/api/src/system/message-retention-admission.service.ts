import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { cpus, loadavg } from 'node:os';
import { getQueueToken } from '@nestjs/bullmq';
import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import type { Queue } from 'bullmq';
import Redis from 'ioredis';
import { getAppRole } from '../runtime/app-role';
import {
  buildRetentionPriorityQueueDescriptors,
  HIGHER_PRIORITY_ACTIVITY_KEY,
  HIGHER_PRIORITY_ACTIVITY_UNAVAILABLE_KEY,
  RETENTION_PRIORITY_PERMIT_KEY,
  RETENTION_PRIORITY_STATUS_KEY,
  RETENTION_PRIORITY_TRAFFIC_KEY_PREFIX,
  RETENTION_PRIORITY_TRAFFIC_TTL_SEC,
  RETENTION_PRIORITY_VERSION,
  retentionPriorityQueueKeys,
} from '../max/retention-priority-admission';
import {
  evaluateRetentionWindow,
  RETENTION_MAX_ARRIVALS_PER_MINUTE,
  RETENTION_MAX_NON_RETENTION_HTTP_PER_MINUTE,
  RETENTION_SAMPLE_MAX_GAP_MS,
  type RetentionAdmissionReason,
  type RetentionObservation,
  type RetentionWindowSummary,
} from './message-retention-admission.policy';
import {
  RETENTION_ADMISSION_COLLECTOR_KEY,
  RETENTION_COMMIT_SAMPLE_SCRIPT,
  RETENTION_RELEASE_COLLECTOR_SCRIPT,
  RETENTION_SAMPLE_SCRIPT,
} from './message-retention-admission.redis';

export type { RetentionAdmissionReason } from './message-retention-admission.policy';
export type RetentionAdmissionDecision = {
  allowed: boolean;
  reason: RetentionAdmissionReason;
  retryAfterMs: number;
};
export type RetentionResources = {
  available: boolean;
  cpuRatio: number | null;
  loadRatio: number | null;
  memoryRatio: number | null;
  ioWaitRatio: number | null;
};
type RetentionAdmissionDetail = 'activity_unavailable' | 'stale_activity';
const MISSING_RESOURCES: RetentionResources = {
  available: false,
  cpuRatio: null,
  loadRatio: null,
  memoryRatio: null,
  ioWaitRatio: null,
};

export type RetentionAdmissionStatus = RetentionAdmissionDecision & {
  detail?: RetentionAdmissionDetail;
  version: typeof RETENTION_PRIORITY_VERSION;
  observedAtMs: number;
  sampleStartedAtMs: number;
  window: RetentionWindowSummary;
  quietSinceMs: number | null;
  healthySinceMs: number | null;
  queues: { ready: number; active: number; dueDelayed: number };
  resources: RetentionResources;
};

function counter(value: unknown): number {
  if (typeof value !== 'string' && typeof value !== 'number')
    throw new Error('Missing retention observation');
  if (value === '') throw new Error('Missing retention counter');
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('Invalid retention counter');
  return result;
}

@Injectable()
export class MessageRetentionAdmissionService implements OnModuleInit, OnModuleDestroy {
  private readonly redis: Redis;
  private readonly descriptors = buildRetentionPriorityQueueDescriptors();
  private timer: NodeJS.Timeout | null = null;
  private pending: Promise<void> | null = null;
  private stopping = false;
  private collectorToken: string | null = null;
  private samples: RetentionObservation[] = [];
  private previousCounters: { minute: number; arrivals: number; http: number } | null = null;
  private cumulativeArrivals = 0;
  private cumulativeHttp = 0;
  private previousCpu: { total: number; idle: number; ioWait: number } | null = null;

  constructor(
    config: ConfigService,
    private readonly moduleRef: ModuleRef,
  ) {
    this.redis = new Redis(config.getOrThrow<string>('REDIS_URL'), {
      lazyConnect: true,
      commandTimeout: 800,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
  }

  async onModuleInit(): Promise<void> {
    if (!['all', 'message-retention'].includes(getAppRole())) return;
    await this.redis.connect().catch(() => undefined);
    this.timer = setInterval(() => void this.tick(), 1_000);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.pending;
    if (this.collectorToken && this.redis.status === 'ready') {
      await this.redis
        .eval(
          RETENTION_RELEASE_COLLECTOR_SCRIPT,
          2,
          RETENTION_ADMISSION_COLLECTOR_KEY,
          RETENTION_PRIORITY_PERMIT_KEY,
          this.collectorToken,
        )
        .catch(() => undefined);
    }
    this.redis.disconnect();
  }

  async status(): Promise<RetentionAdmissionStatus | null> {
    try {
      if (this.redis.status === 'wait') await this.redis.connect();
      const raw = await this.redis.get(RETENTION_PRIORITY_STATUS_KEY);
      if (!raw) return null;
      const value = JSON.parse(raw) as RetentionAdmissionStatus;
      if (
        value.version !== RETENTION_PRIORITY_VERSION ||
        !Number.isSafeInteger(value.observedAtMs) ||
        value.observedAtMs > Date.now() ||
        Date.now() - value.observedAtMs > RETENTION_SAMPLE_MAX_GAP_MS ||
        !Number.isSafeInteger(value.sampleStartedAtMs) ||
        value.sampleStartedAtMs > value.observedAtMs ||
        value.observedAtMs - value.sampleStartedAtMs > RETENTION_SAMPLE_MAX_GAP_MS ||
        typeof value.allowed !== 'boolean' ||
        typeof value.reason !== 'string' ||
        (value.detail !== undefined &&
          (value.allowed ||
            value.reason !== 'metrics_unavailable' ||
            (value.detail !== 'activity_unavailable' && value.detail !== 'stale_activity'))) ||
        !Number.isSafeInteger(value.retryAfterMs) ||
        value.retryAfterMs <= 0 ||
        value.retryAfterMs > 60_000 ||
        !value.window ||
        !Number.isFinite(value.window.coverage) ||
        value.window.coverage < 0 ||
        value.window.coverage > 1 ||
        !value.queues ||
        Object.values(value.queues).some((item) => !Number.isSafeInteger(item) || item < 0) ||
        !value.resources ||
        typeof value.resources.available !== 'boolean'
      )
        return null;
      if (
        value.allowed &&
        (value.reason !== 'allowed' ||
          !value.window.complete ||
          value.window.coverage !== 1 ||
          !Number.isSafeInteger(value.window.coveredMs) ||
          value.window.coveredMs < 60_000 ||
          value.window.coveredMs > 62_000 ||
          !Number.isSafeInteger(value.window.arrivalsPerMinute) ||
          value.window.arrivalsPerMinute! < 0 ||
          value.window.arrivalsPerMinute! > RETENTION_MAX_ARRIVALS_PER_MINUTE ||
          !Number.isSafeInteger(value.window.httpPerMinute) ||
          value.window.httpPerMinute! < 0 ||
          value.window.httpPerMinute! > RETENTION_MAX_NON_RETENTION_HTTP_PER_MINUTE ||
          !value.resources.available ||
          value.queues.ready + value.queues.active + value.queues.dueDelayed !== 0 ||
          value.quietSinceMs === null ||
          value.healthySinceMs === null ||
          !Number.isSafeInteger(value.quietSinceMs) ||
          !Number.isSafeInteger(value.healthySinceMs) ||
          value.observedAtMs - value.quietSinceMs < 60_000 ||
          value.observedAtMs - value.healthySinceMs < 60_000)
      )
        return null;
      return value;
    } catch {
      return null;
    }
  }

  async decide(): Promise<RetentionAdmissionDecision> {
    const status = await this.status();
    if (!status) return { allowed: false, reason: 'collector_unavailable', retryAfterMs: 1_000 };
    return { allowed: status.allowed, reason: status.reason, retryAfterMs: status.retryAfterMs };
  }

  tick(): Promise<void> {
    if (this.pending || this.stopping) return this.pending ?? Promise.resolve();
    this.pending = this.collect()
      .catch(() => {
        this.samples = [];
        this.previousCounters = null;
        // FLAG: A missing observation never renews the previous short transport permit.
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }

  private async becomeCollector(): Promise<boolean> {
    const ownsLease =
      this.collectorToken !== null &&
      (await this.redis.get(RETENTION_ADMISSION_COLLECTOR_KEY)) === this.collectorToken;
    if (ownsLease) return true;
    const token = randomUUID();
    if (
      (await this.redis.set(RETENTION_ADMISSION_COLLECTOR_KEY, token, 'PX', 4_000, 'NX')) !== 'OK'
    )
      return false;
    this.collectorToken = token;
    this.samples = [];
    this.previousCounters = null;
    this.previousCpu = null;
    return true;
  }

  private assertQueueCoverage(): void {
    for (const descriptor of this.descriptors) {
      const queue = this.moduleRef.get<Queue>(getQueueToken(descriptor.name), { strict: false });
      if (
        !queue ||
        queue.toKey('wait') !== descriptor.wait ||
        queue.toKey('delayed') !== descriptor.delayed
      )
        throw new Error(`Missing retention priority queue ${descriptor.name}`);
    }
  }

  private async collect(): Promise<void> {
    if (!(await this.becomeCollector())) return;
    this.assertQueueCoverage();
    const raw = await this.redis.eval(
      RETENTION_SAMPLE_SCRIPT,
      3 + this.descriptors.length * 5,
      RETENTION_PRIORITY_TRAFFIC_KEY_PREFIX,
      HIGHER_PRIORITY_ACTIVITY_KEY,
      HIGHER_PRIORITY_ACTIVITY_UNAVAILABLE_KEY,
      ...retentionPriorityQueueKeys(this.descriptors),
      String(RETENTION_PRIORITY_TRAFFIC_TTL_SEC),
    );
    if (!Array.isArray(raw)) throw new Error('Invalid retention sample');
    if (raw.length === 2 && (raw[1] === 'activity_unavailable' || raw[1] === 'stale_activity')) {
      // FLAG: An activity hold breaks continuous coverage. The next valid sample
      // starts a new window even when the collector has kept its lease.
      this.samples = [];
      this.previousCounters = null;
      this.previousCpu = null;
      const atMs = counter(raw[0]);
      await this.publishStatus(
        {
          version: RETENTION_PRIORITY_VERSION,
          observedAtMs: atMs,
          sampleStartedAtMs: atMs,
          allowed: false,
          reason: 'metrics_unavailable',
          detail: raw[1],
          retryAfterMs: 1_000,
          window: evaluateRetentionWindow([], atMs).window,
          quietSinceMs: null,
          healthySinceMs: null,
          queues: { ready: 0, active: 0, dueDelayed: 0 },
          resources: MISSING_RESOURCES,
        },
        false,
      );
      return;
    }
    if (raw.length !== 8) throw new Error('Invalid retention sample');
    const resources = await this.readResources();
    const [atMs, ready, active, dueDelayed, arrivals, http] = raw.slice(0, 6).map(counter);
    const minute = Math.floor(atMs! / 60_000) * 60;
    let complete = true;
    if (this.previousCounters) {
      let arrivalDelta: number;
      let httpDelta: number;
      if (this.previousCounters.minute === minute) {
        arrivalDelta = arrivals! - this.previousCounters.arrivals;
        httpDelta = http! - this.previousCounters.http;
      } else if (this.previousCounters.minute + 60 === minute) {
        arrivalDelta = counter(raw[6]) - this.previousCounters.arrivals + arrivals!;
        httpDelta = counter(raw[7]) - this.previousCounters.http + http!;
      } else {
        arrivalDelta = 0;
        httpDelta = 0;
        complete = false;
      }
      if (arrivalDelta < 0 || httpDelta < 0) throw new Error('Retention counters moved backwards');
      this.cumulativeArrivals += arrivalDelta;
      this.cumulativeHttp += httpDelta;
    }
    this.previousCounters = { minute, arrivals: arrivals!, http: http! };
    const resourcesHealthy =
      resources.available &&
      resources.cpuRatio! <= 0.5 &&
      resources.loadRatio! <= 0.7 &&
      resources.memoryRatio! <= 0.8 &&
      resources.ioWaitRatio! <= 0.1;
    this.samples.push({
      atMs: atMs!,
      complete,
      cumulativeArrivals: this.cumulativeArrivals,
      cumulativeHttp: this.cumulativeHttp,
      resourcesHealthy,
    });
    this.samples = this.samples.filter((sample) => sample.atMs >= atMs! - 62_000);
    const evaluated = evaluateRetentionWindow(this.samples, atMs!);
    const reason: RetentionAdmissionReason = !evaluated.ready
      ? evaluated.reason
      : active! > 0
        ? 'higher_priority_active'
        : ready! + dueDelayed! > 0
          ? 'higher_priority_ready'
          : 'allowed';
    const status: RetentionAdmissionStatus = {
      version: RETENTION_PRIORITY_VERSION,
      observedAtMs: atMs!,
      sampleStartedAtMs: atMs!,
      allowed: reason === 'allowed',
      reason,
      retryAfterMs: 1_000,
      window: evaluated.window,
      quietSinceMs: evaluated.quietSinceMs,
      healthySinceMs: evaluated.healthySinceMs,
      queues: { ready: ready!, active: active!, dueDelayed: dueDelayed! },
      resources,
    };
    await this.publishStatus(status, evaluated.ready);
  }

  private async publishStatus(
    status: RetentionAdmissionStatus,
    renewPermit: boolean,
  ): Promise<void> {
    const result = await this.redis.eval(
      RETENTION_COMMIT_SAMPLE_SCRIPT,
      3,
      RETENTION_ADMISSION_COLLECTOR_KEY,
      RETENTION_PRIORITY_STATUS_KEY,
      RETENTION_PRIORITY_PERMIT_KEY,
      this.collectorToken!,
      String(status.sampleStartedAtMs),
      JSON.stringify(status),
      renewPermit ? '1' : '0',
    );
    if (result !== 1) throw new Error('Retention collector lost ownership');
  }

  private async readResources(): Promise<RetentionResources> {
    try {
      const [stat, memory] = await Promise.all([
        readFile('/proc/stat', 'utf8'),
        readFile('/proc/meminfo', 'utf8'),
      ]);
      if (stat.length > 262_144 || memory.length > 32_768) return MISSING_RESOURCES;
      const cpu = stat.split('\n')[0]?.trim().split(/\s+/).slice(1, 9).map(Number);
      const totalMemory = Number(/^MemTotal:\s+(\d+)/m.exec(memory)?.[1]);
      const availableMemory = Number(/^MemAvailable:\s+(\d+)/m.exec(memory)?.[1]);
      const loadRatio = loadavg()[0]! / Math.max(1, cpus().length);
      if (
        !cpu ||
        cpu.length < 8 ||
        cpu.some((value) => !Number.isFinite(value) || value < 0) ||
        !(totalMemory > 0) ||
        !(availableMemory >= 0 && availableMemory <= totalMemory) ||
        !Number.isFinite(loadRatio)
      )
        return MISSING_RESOURCES;
      const current = {
        total: cpu.reduce((sum, value) => sum + value, 0),
        idle: cpu[3]! + cpu[4]!,
        ioWait: cpu[4]!,
      };
      const previous = this.previousCpu;
      this.previousCpu = current;
      if (
        !previous ||
        current.total <= previous.total ||
        current.idle < previous.idle ||
        current.ioWait < previous.ioWait
      )
        return MISSING_RESOURCES;
      const delta = current.total - previous.total;
      return {
        available: true,
        cpuRatio: Math.max(0, 1 - (current.idle - previous.idle) / delta),
        ioWaitRatio: (current.ioWait - previous.ioWait) / delta,
        loadRatio,
        memoryRatio: 1 - availableMemory / totalMemory,
      };
    } catch {
      return MISSING_RESOURCES;
    }
  }
}
