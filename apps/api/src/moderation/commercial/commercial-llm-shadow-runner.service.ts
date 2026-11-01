import { Injectable, Logger, type OnModuleInit, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { createPrismaClient, type PrismaClient } from '../../prisma/prisma-client';
import { BackgroundRuntimeGovernorService } from '../../system/background-runtime-governor.service';
import { CommercialLlmClient } from './commercial-llm.client';
import {
  CommercialLlmShadowStore,
  COMMERCIAL_LLM_PRISMA_POOL,
} from './commercial-llm-shadow.store';
import {
  CommercialLlmShadowProcessor,
  commercialLlmHostHasHeadroom,
} from './commercial-llm-shadow.processor';
import { CommercialLlmCascadeClient } from './commercial-llm-cascade.client';
import { CommercialLlmWorkstationMailbox } from './commercial-llm-workstation.mailbox';
import {
  CommercialLlmShadowLease,
  createCommercialLlmRedis,
  COMMERCIAL_LLM_INTERVAL_MS,
  COMMERCIAL_LLM_STATUS_KEY,
} from './commercial-llm-shadow.lease';

@Injectable()
export class CommercialLlmShadowRunnerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CommercialLlmShadowRunnerService.name);
  private readonly controller = new AbortController();
  private timer: NodeJS.Timeout | null = null;
  private redis: Redis | null = null;
  private prisma: PrismaClient | null = null;
  private active: Promise<void> | null = null;
  private lastSuccessAt: string | null = null;
  constructor(
    private readonly config: ConfigService,
    private readonly governor: BackgroundRuntimeGovernorService,
  ) {}

  onModuleInit(): void {
    // FLAG: No timer/connection outside the single background role; disabled by default.
    if (
      this.config.get<string>('APP_SERVICE_NAME') !== 'api-moderation-background' ||
      this.config.get<boolean>('COMMERCIAL_LLM_ENFORCEMENT_ENABLED', false) === true ||
      this.config.get<boolean>('COMMERCIAL_LLM_SHADOW_ENABLED', false) !== true
    )
      return;
    this.timer = setInterval(() => {
      if (this.active || this.controller.signal.aborted) return;
      this.active = this.run().finally(() => {
        this.active = null;
      });
    }, COMMERCIAL_LLM_INTERVAL_MS);
    this.timer.unref();
    this.logger.log(
      { stage: 'commercial-llm-shadow', mode: 'SHADOW', intervalMs: COMMERCIAL_LLM_INTERVAL_MS },
      'Commercial LLM shadow consumer enabled',
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.controller.abort();
    await this.active;
    this.redis?.disconnect();
    await this.prisma?.$disconnect();
  }

  private async run(): Promise<void> {
    try {
      if (!this.redis || this.redis.status !== 'ready') {
        this.redis?.disconnect();
        this.redis = createCommercialLlmRedis(this.config.getOrThrow<string>('REDIS_URL'));
        await this.redis.connect();
      }
      this.prisma ??= createPrismaClient(
        this.config.getOrThrow<string>('DATABASE_URL'),
        COMMERCIAL_LLM_PRISMA_POOL,
      );
      const redis = this.redis;
      const processor = new CommercialLlmShadowProcessor(
        new CommercialLlmShadowStore(this.prisma),
        new CommercialLlmShadowLease(redis),
        (scope) =>
          new CommercialLlmCascadeClient(
            new CommercialLlmWorkstationMailbox(redis),
            scope.classifier(
              new CommercialLlmClient({
                endpoint: this.config.getOrThrow<string>('COMMERCIAL_LLM_ENDPOINT'),
                timeoutMs: 60_000,
              }),
            ),
            async () => {
              const decision = await this.governor.decide({
                component: 'commercial-llm-shadow',
                sourceTag: 'commercial-llm-shadow',
              });
              return decision.action === 'run' && (await commercialLlmHostHasHeadroom());
            },
          ),
        this.governor,
      );
      const result = await processor.run(this.controller.signal);
      if (result.outcome === 'COMPLETE') this.lastSuccessAt = new Date().toISOString();
      const status = {
        stage: 'commercial-llm-shadow',
        mode: 'SHADOW',
        heartbeatAt: new Date().toISOString(),
        lastSuccessAt: this.lastSuccessAt,
        ...result,
      };
      await this.redis.set(COMMERCIAL_LLM_STATUS_KEY, JSON.stringify(status), 'EX', 300);
      this.logger.log(status, 'Commercial LLM shadow observation');
    } catch {
      // No prompts, excerpts, credentials or remote-generated errors enter operational logs.
      this.logger.warn(
        {
          stage: 'commercial-llm-shadow',
          outcome: 'dependency_unavailable',
          heartbeatAt: new Date().toISOString(),
        },
        'Commercial LLM shadow poll unavailable',
      );
    }
  }
}
