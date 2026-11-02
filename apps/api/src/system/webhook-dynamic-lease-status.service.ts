import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import {
  DEFAULT_WEBHOOK_LEASE_SUMMARY_KEY,
  type DefaultWebhookLeaseSummary,
} from '../runtime/default-webhook-dynamic-leases';

@Injectable()
export class WebhookDynamicLeaseStatusService implements OnModuleDestroy {
  private readonly logger = new Logger(WebhookDynamicLeaseStatusService.name);
  private readonly redis: Redis;
  private summaryCache: DefaultWebhookLeaseSummary | null = null;
  private summaryCacheAtMs = 0;

  constructor(configService: ConfigService) {
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
