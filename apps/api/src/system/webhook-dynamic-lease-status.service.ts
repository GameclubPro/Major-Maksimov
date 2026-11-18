import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { DEFAULT_WEBHOOK_WORKER_GROUP_NAMES } from '../runtime/runtime-topology';
import { readLeaseHeartbeats } from '../runtime/default-webhook-fleet-observation';
import {
  DEFAULT_WEBHOOK_LEASE_SUMMARY_KEY,
  buildDefaultWebhookWorkerHeartbeatKey,
  type DefaultWebhookLeaseSummary,
} from '../runtime/default-webhook-dynamic-leases';

@Injectable()
export class WebhookDynamicLeaseStatusService implements OnModuleDestroy {
  private readonly logger = new Logger(WebhookDynamicLeaseStatusService.name);
  private readonly redis: Redis;
  private summaryCache: DefaultWebhookLeaseSummary | null = null;
  private summaryCacheAtMs = 0;

  private readonly summaryTtlMs: number;
  private readonly heartbeatTtlMs: number;
  constructor(configService: ConfigService) {
    this.summaryTtlMs = configService.get<number>('WEBHOOK_DYNAMIC_LEASES_SUMMARY_TTL_MS', 20_000);
    this.heartbeatTtlMs = Math.max(
      configService.get<number>('WEBHOOK_DYNAMIC_LEASES_HEARTBEAT_MS', 3_000) * 3,
      configService.get<number>('WEBHOOK_DYNAMIC_LEASES_LEASE_TTL_MS', 12_000) * 2,
    );
    this.redis = new Redis(configService.getOrThrow<string>('REDIS_URL'), {
      commandTimeout: 500,
      connectTimeout: 1_000,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    this.redis.on('error', () => undefined);
  }

  async onModuleDestroy() {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }

  async getHeartbeatObservation() {
    const readStartedAtMs = Date.now();
    // FLAG: Read all groups and their TTLs in the same Redis transaction during a mode change.
    const transaction = this.redis.multi();
    for (const group of DEFAULT_WEBHOOK_WORKER_GROUP_NAMES) {
      const key = buildDefaultWebhookWorkerHeartbeatKey(group);
      transaction.get(key).pttl(key);
    }
    const replies = await transaction.exec().catch(() => null);
    return {
      ...readLeaseHeartbeats(replies, Date.now(), this.heartbeatTtlMs, readStartedAtMs),
      summaryTtlMs: this.summaryTtlMs,
    };
  }

  async getSummary(maxAgeMs = 0): Promise<DefaultWebhookLeaseSummary | null> {
    if (this.summaryCache && maxAgeMs > 0 && Date.now() - this.summaryCacheAtMs <= maxAgeMs) {
      return this.summaryCache;
    }

    try {
      const raw = await this.redis.get(DEFAULT_WEBHOOK_LEASE_SUMMARY_KEY);
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw) as DefaultWebhookLeaseSummary;
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }

      this.summaryCache = parsed;
      this.summaryCacheAtMs = Date.now();
      return parsed;
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to load webhook dynamic lease summary',
      );
      return null;
    }
  }
}
