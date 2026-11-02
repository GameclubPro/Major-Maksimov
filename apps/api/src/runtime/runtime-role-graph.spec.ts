import 'reflect-metadata';
import { getQueueToken } from '@nestjs/bullmq';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUNTIME_SERVICE_PROFILES } from './runtime-topology';

jest.mock('ioredis', () => {
  class Redis {
    status = 'wait';
    on() {
      return this;
    }
    duplicate() {
      return new Redis();
    }
    defineCommand() {}
    disconnect() {}
    async quit() {
      return 'OK';
    }
    async set() {
      return 'OK';
    }
  }
  return { __esModule: true, default: Redis };
});

describe('runtime role dependency graphs', () => {
  const services = Object.values(RUNTIME_SERVICE_PROFILES);

  // FLAG: Compile actual role providers without starting lifecycle hooks or workers.
  // Only external transports are replaced; missing safety/provider imports must fail DI.
  it.each(services)(
    'resolves the complete $serviceName graph',
    async (service) => {
      const previous = { ...process.env };
      const previousProcessListeners = new Map(
        process.eventNames().map((event) => [event, new Set(process.rawListeners(event))]),
      );
      const fixtureDirectory = mkdtempSync(join(tmpdir(), 'maxim-role-graph-'));
      const tokenFile = join(fixtureDirectory, 'publisher-token');
      const webhookFile = join(fixtureDirectory, 'publisher-webhook.json');
      const signingFile = join(fixtureDirectory, 'publisher-signing.json');
      const publisherId = 'graph-publisher-bot';
      writeFileSync(tokenFile, 'graph_test_publisher_token_12345678901234567890', { mode: 0o600 });
      writeFileSync(
        webhookFile,
        JSON.stringify({
          version: 1,
          botId: publisherId,
          secretPath: 'graph-publisher-path-12345',
          headerSecrets: ['graph-publisher-header-12345'],
        }),
        { mode: 0o600 },
      );
      writeFileSync(
        signingFile,
        JSON.stringify({
          version: 1,
          botId: publisherId,
          keys: [Buffer.alloc(32, 7).toString('base64')],
        }),
        { mode: 0o600 },
      );
      Object.assign(process.env, {
        NODE_ENV: 'production',
        APP_ROLE: service.appRole,
        APP_SERVICE_NAME: service.serviceName,
        APP_BASE_URL: 'https://example.com',
        MAX_BOT_ID: 'graph-major-bot',
        MAX_BOT_TOKEN: 'graph-major-token-12345',
        MAX_WEBHOOK_SECRET_PATH: 'graph-major-path-12345',
        MAX_WEBHOOK_HEADER_SECRET: 'graph-major-header-12345',
        MAX_PUBLISHER_BOT_ID: publisherId,
        MAX_PUBLISHER_BOT_TOKEN_FILE: tokenFile,
        MAX_PUBLISHER_WEBHOOK_CREDENTIALS_FILE: webhookFile,
        MAX_PUBLISHER_DIALOG_SIGNING_KEY_FILE: signingFile,
        ADMIN_ACCESS_CODE: 'graph-owner-code-12345',
        DATABASE_URL: 'postgresql://maxim:maxim@localhost:5432/maxim',
        REDIS_URL: 'redis://localhost:6379',
        COMMERCIAL_OCR_ROLLOUT_MODE: 'off',
        COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH: '/run/maxim-ocr/graph-ocr.sock',
        PHOTO_NATIVE_SANDBOX_SOCKET_PATH: '/run/maxim-photo/native-photo.sock',
        MODERATION_ENABLED_QUEUES: service.moderationQueues.join(','),
      });
      for (const key of [
        'MAX_BOTS_JSON',
        'MAX_BOT_TOKEN_PREVIOUS',
        'MAX_ENTRY_BOT_ID',
        'MAX_PUBLISHER_INIT_DATA_KEYS_FILE',
      ])
        delete process.env[key];
      if (service.appRole === 'publisher') {
        process.env.MAX_BOT_ID = publisherId;
        delete process.env.MAX_BOT_TOKEN;
      }

      try {
        await jest.isolateModulesAsync(async () => {
          const { Test } = await import('@nestjs/testing');
          const { QueueKeys } = await import('bullmq');
          const { loadRuntimeRootModule } = await import('./runtime-root-module');
          const { PrismaService } = await import('../prisma/prisma.service');
          const { WebhookLegacyHoldService } =
            await import('../webhook/webhook-legacy-hold.service');
          const { QueueMetricsService } = await import('../system/queue-metrics.service');
          const { SystemModeService } = await import('../system/system-mode.service');
          const { BackgroundRuntimeGovernorService } =
            await import('../system/background-runtime-governor.service');
          const { SystemRuntimeModule } = await import('../system/system-runtime.module');
          const { MESSAGE_DUPLICATE_NOTICE_AUTHORITY } =
            await import('../moderation/message-duplicate/message-duplicate-guard.contract');
          const { MessageDuplicateDeleteGuardService } =
            await import('../moderation/message-duplicate/message-duplicate-delete-guard.service');
          const root = await loadRuntimeRootModule(service.appRole);
          const modules = new Set<unknown>();
          const queueTokens = new Set<string>();
          const providerNames = new Set<string>();
          function visit(value: unknown): void {
            if (!value || modules.has(value)) return;
            modules.add(value);
            const moduleClass =
              typeof value === 'function' ? value : (value as { module?: unknown }).module;
            if (!moduleClass) return;
            const dynamic = typeof value === 'function' ? {} : (value as Record<string, unknown[]>);
            for (const provider of [
              ...(Reflect.getMetadata(MODULE_METADATA.PROVIDERS, moduleClass) ?? []),
              ...(dynamic.providers ?? []),
            ]) {
              if (typeof provider === 'function') providerNames.add(provider.name);
              else if (
                typeof provider?.provide === 'string' &&
                provider.provide.startsWith('BullQueue_')
              )
                queueTokens.add(provider.provide);
            }
            for (const dependency of [
              ...(Reflect.getMetadata(MODULE_METADATA.IMPORTS, moduleClass) ?? []),
              ...(dynamic.imports ?? []),
            ])
              visit(dependency);
          }
          visit(root);
          expect(modules.has(SystemRuntimeModule)).toBe(true);
          expect(providerNames.has('MaxActionLedgerWatchdogService')).toBe(true);
          expect(providerNames.has('ModerationDeleteIntentService')).toBe(true);
          expect(providerNames.has('MessageRetentionDeleteGuard')).toBe(true);
          const builder = Test.createTestingModule({ imports: [root] })
            .overrideProvider(PrismaService)
            .useValue({});
          const queueKeys = new QueueKeys('bull');
          for (const token of queueTokens) {
            const name = token.slice('BullQueue_'.length);
            builder.overrideProvider(token).useValue({
              name,
              opts: { connection: { host: '127.0.0.1', port: 6379 } },
              keys: queueKeys.getKeys(name),
              toKey: (suffix: string) => queueKeys.toKey(name, suffix),
            });
          }
          const context = await builder.compile();
          if (providerNames.has('WebhookOutboxService')) {
            const { WebhookOutboxService } = await import('../webhook/webhook-outbox.service');
            const { WebhookDependencyQuarantineService } =
              await import('../webhook/webhook-dependency-quarantine.service');
            // FLAG: Optional constructor compatibility for old fixtures must never silently
            // disable the production quarantine writer through a missing module provider.
            const outbox = context.get(WebhookOutboxService) as unknown as {
              dependencyQuarantine: unknown;
            };
            expect(outbox.dependencyQuarantine).toBe(
              context.get(WebhookDependencyQuarantineService),
            );
            const { WebhookService } = await import('../webhook/webhook.service');
            const webhook = context.get(WebhookService) as unknown as {
              dependencyQuarantine: unknown;
            };
            expect(webhook.dependencyQuarantine).toBe(
              context.get(WebhookDependencyQuarantineService),
            );
          }
          if (providerNames.has('MarketplaceAccessService')) {
            const { MarketplaceAccessService } =
              await import('../integrations/marketplace/marketplace-access.service');
            const access = context.get(MarketplaceAccessService) as unknown as {
              governor: unknown;
            };
            expect(access.governor).toBe(context.get(BackgroundRuntimeGovernorService));
          }
          const legacyHolds = context.get(WebhookLegacyHoldService);
          expect(() => legacyHolds.onApplicationBootstrap()).not.toThrow();
          expect(WebhookLegacyHoldService.forPrisma(context.get(PrismaService))).toBe(legacyHolds);
          try {
            expect(context.get(MESSAGE_DUPLICATE_NOTICE_AUTHORITY)).toBe(
              context.get(MessageDuplicateDeleteGuardService),
            );
            expect(context.get(QueueMetricsService)).toBeInstanceOf(QueueMetricsService);
            expect(context.get(SystemModeService)).toBeInstanceOf(SystemModeService);
            expect(context.get(BackgroundRuntimeGovernorService)).toBeInstanceOf(
              BackgroundRuntimeGovernorService,
            );
            expect(context.get(getQueueToken('message-retention'))).toBeDefined();
            if (service.appRole !== 'message-retention') {
              const { SystemModule } = await import('../system/system.module');
              const { SystemDashboardService } = await import('../system/system-dashboard.service');
              const { AdminModule } = await import('../admin/admin.module');
              const { HealthModule } = await import('../health/health.module');
              const { OcrReadinessHeartbeatService } =
                await import('../health/ocr-readiness-heartbeat.service');
              const { OcrReadinessStateService } =
                await import('../health/ocr-readiness-state.service');
              const { AdminStopWordsService } = await import('../admin/admin-stop-words.service');
              expect(context.select(SystemModule).get(QueueMetricsService)).toBe(
                context.select(SystemRuntimeModule).get(QueueMetricsService),
              );
              expect(context.get(SystemDashboardService)).toBeInstanceOf(SystemDashboardService);
              const state = context.get(OcrReadinessStateService);
              expect(context.select(AdminModule).get(OcrReadinessStateService)).toBe(state);
              expect(context.select(HealthModule).get(OcrReadinessStateService)).toBe(state);
              const heartbeat = context.get(OcrReadinessHeartbeatService) as unknown as {
                state: InstanceType<typeof OcrReadinessStateService>;
              };
              expect(heartbeat.state).toBe(state);
              const stopWords = context.get(AdminStopWordsService) as unknown as {
                ocrReadiness: InstanceType<typeof OcrReadinessStateService>;
              };
              expect(stopWords.ocrReadiness).toBe(state);
            }
          } finally {
            await context.close();
          }
        });
      } finally {
        for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
        Object.assign(process.env, previous);
        rmSync(fixtureDirectory, { recursive: true, force: true });
        // FLAG: Isolated third-party imports can register process shutdown handlers.
        // Remove only handlers added by this fixture, preserving every pre-existing listener.
        for (const event of process.eventNames()) {
          const previousListeners = previousProcessListeners.get(event);
          for (const listener of process.rawListeners(event)) {
            if (!previousListeners?.has(listener))
              process.removeListener(event, listener as (...args: unknown[]) => void);
          }
        }
      }
    },
    30_000,
  );
});
