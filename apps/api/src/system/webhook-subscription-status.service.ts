import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  webhookSubscriptionSnapshotSchema,
  type WebhookSubscriptionSnapshot,
} from '@maxim/contracts/system';
import Redis from 'ioredis';
import { resolveRequiredWebhookUpdateTypes } from '../max/max-webhook-subscription.constants';

const WEBHOOK_SUBSCRIPTION_STATUS_KEY = 'system:webhook-subscription:status:v1';
const WEBHOOK_SUBSCRIPTION_SYNC_STATE_KEY = 'system:webhook-subscription:sync-state:v1';
const WEBHOOK_SUBSCRIPTION_INGRESS_KEY = 'system:webhook-subscription:ingress:v1';
const LOCAL_SNAPSHOT_CACHE_TTL_MS = 2_000;
const MARK_INCOMING_WEBHOOK_LUA = `
local key = KEYS[1]
local botField = ARGV[1]
local incoming = tonumber(ARGV[2]) or 0
local currentBot = tonumber(redis.call('HGET', key, botField) or '0')
if incoming > currentBot then
  redis.call('HSET', key, botField, tostring(incoming))
end
local currentGlobal = tonumber(redis.call('HGET', key, 'global') or '0')
if incoming > currentGlobal then
  redis.call('HSET', key, 'global', tostring(incoming))
end
return 1
`;

export type WebhookSubscriptionBotSyncState = {
  configuredUrl: string | null;
  headerSecretFingerprint: string | null;
  updatedAt: string;
  lastIncomingWebhookAt: string | null;
  lastAutoRecreateAt: string | null;
};

export type WebhookSubscriptionSyncState = {
  bots: Record<string, WebhookSubscriptionBotSyncState>;
  lastGlobalIncomingWebhookAt: string | null;
  lastGlobalAutoRecreateAt: string | null;
};

@Injectable()
export class WebhookSubscriptionStatusService implements OnModuleDestroy {
  private readonly logger = new Logger(WebhookSubscriptionStatusService.name);
  private readonly redis: Redis;
  private readonly requiredUpdateTypes: readonly string[];
  private cachedSnapshot: WebhookSubscriptionSnapshot | null = null;
  private cachedAtMs = 0;

  constructor(configService: ConfigService) {
    this.redis = new Redis(configService.getOrThrow<string>('REDIS_URL'));
    this.requiredUpdateTypes = resolveRequiredWebhookUpdateTypes(
      configService.get?.<string>('MAX_EXTENDED_WEBHOOK_LIFECYCLE_MODE', 'shadow') ?? 'shadow',
    );
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }

  async getSnapshot(): Promise<WebhookSubscriptionSnapshot> {
    if (this.cachedSnapshot && Date.now() - this.cachedAtMs <= LOCAL_SNAPSHOT_CACHE_TTL_MS) {
      return this.cachedSnapshot;
    }

    const raw = await this.redis.get(WEBHOOK_SUBSCRIPTION_STATUS_KEY);
    if (!raw) {
      const fallback = this.createPendingSnapshot();
      this.cacheSnapshot(fallback);
      return fallback;
    }

    try {
      const parsed = webhookSubscriptionSnapshotSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        const fallback = this.createPendingSnapshot();
        this.cacheSnapshot(fallback);
        return fallback;
      }

      this.cacheSnapshot(parsed.data);
      return parsed.data;
    } catch (error: unknown) {
      this.logger.warn(
        {
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to parse cached webhook subscription snapshot',
      );
      const fallback = this.createPendingSnapshot();
      this.cacheSnapshot(fallback);
      return fallback;
    }
  }

  async writeSnapshot(snapshot: WebhookSubscriptionSnapshot): Promise<void> {
    this.cacheSnapshot(snapshot);
    await this.redis.set(WEBHOOK_SUBSCRIPTION_STATUS_KEY, JSON.stringify(snapshot));
  }

  async getSyncState(): Promise<WebhookSubscriptionSyncState | null> {
    try {
      const [raw, ingressState] = await Promise.all([
        this.redis.get(WEBHOOK_SUBSCRIPTION_SYNC_STATE_KEY),
        this.redis.hgetall(WEBHOOK_SUBSCRIPTION_INGRESS_KEY),
      ]);
      if (!raw) {
        return Object.keys(ingressState).length > 0
          ? this.mergeAtomicIngressState(
              {
                bots: {},
                lastGlobalIncomingWebhookAt: null,
                lastGlobalAutoRecreateAt: null,
              },
              ingressState,
            )
          : null;
      }

      const parsed = JSON.parse(raw) as Partial<WebhookSubscriptionSyncState> & {
        configuredUrl?: unknown;
        headerSecretFingerprint?: unknown;
        updatedAt?: unknown;
      };
      const parsedBots =
        parsed.bots && typeof parsed.bots === 'object' && !Array.isArray(parsed.bots)
          ? Object.fromEntries(
              Object.entries(parsed.bots).map(([botId, value]) => {
                const row =
                  value && typeof value === 'object' && !Array.isArray(value)
                    ? (value as Partial<WebhookSubscriptionBotSyncState>)
                    : {};
                return [
                  botId,
                  {
                    configuredUrl:
                      typeof row.configuredUrl === 'string' && row.configuredUrl.trim().length > 0
                        ? row.configuredUrl
                        : null,
                    headerSecretFingerprint:
                      typeof row.headerSecretFingerprint === 'string' &&
                      row.headerSecretFingerprint.trim().length > 0
                        ? row.headerSecretFingerprint
                        : null,
                    // FLAG: Older snapshots copied membership repair times; only ingress proves receipt.
                    lastIncomingWebhookAt: null,
                    lastAutoRecreateAt:
                      typeof row.lastAutoRecreateAt === 'string' &&
                      row.lastAutoRecreateAt.trim().length > 0
                        ? row.lastAutoRecreateAt
                        : null,
                    updatedAt:
                      typeof row.updatedAt === 'string' && row.updatedAt.trim().length > 0
                        ? row.updatedAt
                        : new Date(0).toISOString(),
                  } satisfies WebhookSubscriptionBotSyncState,
                ];
              }),
            )
          : {};

      if (Object.keys(parsedBots).length > 0) {
        return this.mergeAtomicIngressState(
          {
            bots: parsedBots,
            lastGlobalIncomingWebhookAt: null,
            lastGlobalAutoRecreateAt:
              typeof parsed.lastGlobalAutoRecreateAt === 'string' &&
              parsed.lastGlobalAutoRecreateAt.trim().length > 0
                ? parsed.lastGlobalAutoRecreateAt
                : null,
          },
          ingressState,
        );
      }

      return this.mergeAtomicIngressState(
        {
          bots: {},
          lastGlobalIncomingWebhookAt: null,
          lastGlobalAutoRecreateAt: null,
        },
        ingressState,
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to read cached webhook subscription sync state',
      );
      // FLAG: An unreadable secret fingerprint must not trigger a fleet-wide subscription update.
      throw error;
    }
  }

  async writeSyncState(state: WebhookSubscriptionSyncState): Promise<void> {
    await this.redis.set(WEBHOOK_SUBSCRIPTION_SYNC_STATE_KEY, JSON.stringify(state));
  }

  async markIncomingWebhook(botId: string, occurredAt = new Date().toISOString()): Promise<void> {
    const normalizedBotId = botId.trim();
    if (!normalizedBotId) {
      return;
    }

    const occurredAtMs = Date.parse(occurredAt);
    const normalizedOccurredAtMs = Number.isFinite(occurredAtMs) ? occurredAtMs : Date.now();
    await this.redis.eval(
      MARK_INCOMING_WEBHOOK_LUA,
      1,
      WEBHOOK_SUBSCRIPTION_INGRESS_KEY,
      `bot:${normalizedBotId}`,
      String(normalizedOccurredAtMs),
    );
  }

  private mergeAtomicIngressState(
    state: WebhookSubscriptionSyncState,
    ingressState: Record<string, string>,
  ): WebhookSubscriptionSyncState {
    const bots = { ...state.bots };
    for (const [field, value] of Object.entries(ingressState)) {
      if (!field.startsWith('bot:')) {
        continue;
      }
      const botId = field.slice('bot:'.length).trim();
      const occurredAt = this.parseIngressTimestamp(value);
      if (!botId || !occurredAt) {
        continue;
      }
      const existing = bots[botId];
      bots[botId] = {
        configuredUrl: existing?.configuredUrl ?? null,
        headerSecretFingerprint: existing?.headerSecretFingerprint ?? null,
        updatedAt: existing?.updatedAt ?? occurredAt,
        lastIncomingWebhookAt: occurredAt,
        lastAutoRecreateAt: existing?.lastAutoRecreateAt ?? null,
      };
    }

    const globalIncomingAt = this.parseIngressTimestamp(ingressState.global);
    return {
      ...state,
      bots,
      lastGlobalIncomingWebhookAt: globalIncomingAt,
    };
  }

  private parseIngressTimestamp(value: string | undefined): string | null {
    const timestampMs = Number(value);
    return Number.isFinite(timestampMs) && timestampMs > 0
      ? new Date(timestampMs).toISOString()
      : null;
  }

  createPendingSnapshot(
    note = 'Первая проверка webhook subscription ещё не завершилась.',
  ): WebhookSubscriptionSnapshot {
    return {
      status: 'warning',
      configured: false,
      url: null,
      checkedAt: null,
      reconciledAt: null,
      requiredUpdateTypes: [...this.requiredUpdateTypes],
      actualUpdateTypes: [],
      missingUpdateTypes: [...this.requiredUpdateTypes],
      extraUpdateTypes: [],
      otherSubscriptionsCount: 0,
      lastError: null,
      note,
      botCount: 0,
      bots: {},
    };
  }

  private cacheSnapshot(snapshot: WebhookSubscriptionSnapshot) {
    this.cachedSnapshot = snapshot;
    this.cachedAtMs = Date.now();
  }
}
