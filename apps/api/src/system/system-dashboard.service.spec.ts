import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { extractSqlText } from '../admin/admin-service-test-support';
import {
  MAX_ACTION_BACKGROUND_QUEUE,
  MAX_ACTION_CRITICAL_QUEUE,
  MAX_ACTION_INTERACTIVE_QUEUE,
  MAX_ACTION_LEGACY_QUEUE,
} from '../max/max-action.queue';
import {
  CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1,
  CHANNEL_SUGGESTION_PUBLICATION_SOURCE_TAG,
  buildChannelSuggestionPublicationLedgerJobId,
  withChannelSuggestionPublicationContextDigest,
} from '../admin/admin-channel-suggestion-publication-protocol';
import {
  DEFAULT_WEBHOOK_WORKER_GROUP_NAMES,
  type WebhookDynamicLeasesMode,
} from '../runtime/runtime-topology';
import { readLeaseHeartbeats } from '../runtime/default-webhook-fleet-observation';
import { SystemDashboardService } from './system-dashboard.service';

const execFileAsync = promisify(execFile);

function createConfigMock(values: Partial<Record<string, number>> = {}): ConfigService {
  return {
    get: jest.fn((key: string, fallback?: number) => {
      if (key in values) {
        return values[key];
      }
      return fallback;
    }),
  } as unknown as ConfigService;
}

function createWebhookSubscriptionSnapshot(
  overrides: Partial<{
    status: 'healthy' | 'warning' | 'critical' | 'disabled';
    configured: boolean;
    url: string | null;
    checkedAt: string | null;
    reconciledAt: string | null;
    requiredUpdateTypes: string[];
    actualUpdateTypes: string[];
    missingUpdateTypes: string[];
    extraUpdateTypes: string[];
    otherSubscriptionsCount: number;
    lastError: string | null;
    note: string | null;
    botCount: number;
    bots: Record<string, unknown>;
    operationalDiagnostics: {
      warningBotCount: number;
      warningBotIds: string[];
      noActiveMembershipBotIds: string[];
      noIncomingWebhookBotIds: string[];
    };
  }> = {},
) {
  return {
    status: 'healthy' as const,
    configured: true,
    url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/***',
    checkedAt: '2026-03-29T12:00:00.000Z',
    reconciledAt: '2026-03-29T12:00:00.000Z',
    requiredUpdateTypes: ['message_created', 'message_callback', 'user_added'],
    actualUpdateTypes: ['message_created', 'message_callback', 'user_added'],
    missingUpdateTypes: [],
    extraUpdateTypes: [],
    otherSubscriptionsCount: 0,
    lastError: null,
    note: 'Webhook coverage OK',
    botCount: 1,
    bots: {},
    ...overrides,
  };
}

function createSuggestionPublicationContext() {
  return withChannelSuggestionPublicationContextDigest({
    protocol: CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1,
    preparedAt: '2026-08-20T10:01:00.000Z',
    messageDigest: 'a'.repeat(64),
    botId: 'bot-1',
    threadId: null,
    buttons: [],
    includeCommentsButton: false,
    includeSuggestButton: false,
    suggestButtonText: null,
    suggestionEntryMode: 'BOT',
    authorAttribution: {
      userId: 'user-1',
      displayName: 'Автор',
      mentionDisplayName: 'Автор',
      username: null,
      profileUrl: null,
    },
  });
}

function createSuggestionClaimPayload(
  suggestionId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    type: 'suggest',
    reviewStatus: 'publishing',
    reviewAction: 'publish',
    reviewPublicationProtocol: CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1,
    reviewPublicationLedgerJobId: buildChannelSuggestionPublicationLedgerJobId(suggestionId),
    reviewClaimToken: `claim-${suggestionId}`,
    reviewClaimedAt: '2026-08-20T10:00:00.000Z',
    reviewClaimedByUserId: 'admin-1',
    ...overrides,
  };
}

function createSuggestionLedgerFields(
  suggestionId: string,
  overrides: Record<string, unknown> = {},
) {
  const context = createSuggestionPublicationContext();
  return {
    jobId: buildChannelSuggestionPublicationLedgerJobId(suggestionId),
    actionType: 'SEND_MESSAGE',
    ledgerChatId: 'channel-1',
    sourceTag: CHANNEL_SUGGESTION_PUBLICATION_SOURCE_TAG,
    status: 'IN_PROGRESS',
    ambiguous: false,
    terminal: false,
    dispatchToken: null,
    dispatchStartedAt: null,
    dispatchBotId: null,
    remoteMessageId: null,
    metadata: {
      ledgerContext: {
        suggestionId,
        publicationProtocol: CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1,
        claimToken: `claim-${suggestionId}`,
        actorUserId: 'user-1',
        messageDigest: context.messageDigest,
        contextDigest: context.contextDigest,
      },
    },
    ...overrides,
  };
}

function createHealthyPublishedSuggestionLedgerRow(suggestionId: string, updatedAt: Date) {
  const context = createSuggestionPublicationContext();
  const messageId = `mid-${suggestionId}`;
  return {
    ledgerId: `ledger-${suggestionId}`,
    updatedAt,
    ...createSuggestionLedgerFields(suggestionId, {
      status: 'SUCCEEDED',
      terminal: true,
      dispatchToken: `dispatch-${suggestionId}`,
      dispatchStartedAt: updatedAt,
      dispatchBotId: 'bot-1',
      remoteMessageId: messageId,
    }),
    auditId: suggestionId,
    auditChatId: 'channel-1',
    actorUserId: 'user-1',
    auditAction: 'CHANNEL_DIALOG_SUGGESTION',
    payload: {
      type: 'suggest',
      reviewStatus: 'published',
      reviewPublicationProtocol: CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1,
      reviewPublicationLedgerJobId: buildChannelSuggestionPublicationLedgerJobId(suggestionId),
      reviewPublicationContext: context,
      publishedMessageId: messageId,
    },
  };
}

function paginateSuggestionLedgerRows<T extends { ledgerId: string; updatedAt: Date }>(
  rows: T[],
  queryArgs: unknown[],
): T[] {
  const values = readRawSqlValues(queryArgs);
  const limit = values.at(-1);
  const afterLedgerId = values.at(-2);
  if (typeof limit !== 'number') {
    throw new Error('Suggestion ledger page query is missing its numeric limit');
  }
  const ordered = [...rows].sort(
    (left, right) =>
      right.updatedAt.getTime() - left.updatedAt.getTime() ||
      right.ledgerId.localeCompare(left.ledgerId),
  );
  const start =
    typeof afterLedgerId === 'string'
      ? ordered.findIndex((row) => row.ledgerId === afterLedgerId) + 1
      : 0;
  return ordered.slice(start, start + limit);
}

function readRawSqlValues(queryArgs: unknown[]): unknown[] {
  const query = queryArgs[0] as { values?: unknown[] } | undefined;
  return Array.isArray(query?.values) ? query.values : queryArgs.slice(1);
}

function createSuggestionProtocolPrismaMock(queryRaw: jest.Mock) {
  const transaction = jest.fn(
    async (callback: (tx: { $queryRaw: jest.Mock }) => Promise<unknown>) =>
      callback({ $queryRaw: queryRaw }),
  );
  return { $queryRaw: queryRaw, $transaction: transaction };
}

function createDefaultWorkerGroups(
  overrides: Partial<
    Record<
      | 'api-moderation'
      | 'api-moderation-realtime-b'
      | 'api-moderation-realtime-c'
      | 'api-moderation-realtime-d',
      {
        queues: string[];
        counters: {
          waiting: number;
          active: number;
          delayed: number;
          failed: number;
          completed: number;
        };
      }
    >
  > = {},
) {
  return {
    'api-moderation': {
      queues: [
        'moderation-default-0',
        'moderation-default-4',
        'moderation-default-8',
        'moderation-default-12',
      ],
      counters: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
    },
    'api-moderation-realtime-b': {
      queues: [
        'moderation-default-1',
        'moderation-default-5',
        'moderation-default-9',
        'moderation-default-13',
      ],
      counters: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
    },
    'api-moderation-realtime-c': {
      queues: [
        'moderation-default-2',
        'moderation-default-6',
        'moderation-default-10',
        'moderation-default-14',
      ],
      counters: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
    },
    'api-moderation-realtime-d': {
      queues: [
        'moderation-default-3',
        'moderation-default-7',
        'moderation-default-11',
        'moderation-default-15',
      ],
      counters: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
    },
    ...overrides,
  };
}

function createHealthyQueueSnapshot(overrides: Record<string, unknown> = {}) {
  const counters = { waiting: 0, prioritized: 0, active: 0, delayed: 0, failed: 0, completed: 0 };
  const statusMetrics = {
    count: 0,
    oldestEventId: null,
    oldestCreatedAt: null,
    oldestLagSec: 0,
  };
  return {
    moderation: counters,
    webhookCritical: counters,
    webhookJoin: counters,
    webhookJoinShards: {},
    webhookDefault: counters,
    webhookDefaultShards: {},
    webhookDefaultWorkerGroups: createDefaultWorkerGroups(),
    webhookBackground: counters,
    webhookLegacy: counters,
    actions: counters,
    globalSpammerDenorm: counters,
    auxiliaryQueues: {},
    webhookEvents: {
      received: statusMetrics,
      queued: statusMetrics,
      failed: statusMetrics,
    },
    userFacingWebhookEvents: {
      received: statusMetrics,
      queued: statusMetrics,
      failed: statusMetrics,
    },
    actionHealth: {
      windowSec: 60,
      total: 12,
      success: 12,
      failure: 0,
      critical: 0,
      errorRate: 0,
      criticalRate: 0,
    },
    webhookDynamicLeases: null,
    bots: {},
    oldestQueuedEventId: null,
    oldestQueuedCreatedAt: null,
    oldestQueuedLagSec: 0,
    oldestReceivedEventId: null,
    oldestReceivedCreatedAt: null,
    oldestReceivedLagSec: 0,
    effectiveLagSec: 0,
    userFacingOldestQueuedEventId: null,
    userFacingOldestQueuedCreatedAt: null,
    userFacingOldestQueuedLagSec: 0,
    userFacingOldestReceivedEventId: null,
    userFacingOldestReceivedCreatedAt: null,
    userFacingOldestReceivedLagSec: 0,
    userFacingEffectiveLagSec: 0,
    generatedAt: '2026-03-29T12:00:00.000Z',
    ...overrides,
  };
}

describe('SystemDashboardService', () => {
  it('builds a healthy summary when queues and MAX action health are clean', async () => {
    const service = new SystemDashboardService(
      {
        getSnapshot: jest.fn().mockResolvedValue({
          moderation: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookCritical: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookDefault: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookDefaultWorkerGroups: createDefaultWorkerGroups(),
          webhookBackground: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookLegacy: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          actions: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookEvents: {
            received: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            queued: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            failed: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
          },
          actionHealth: {
            windowSec: 60,
            total: 12,
            success: 12,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
          oldestQueuedEventId: null,
          oldestQueuedCreatedAt: null,
          oldestQueuedLagSec: 0,
          oldestReceivedEventId: null,
          oldestReceivedCreatedAt: null,
          oldestReceivedLagSec: 0,
          effectiveLagSec: 0,
          generatedAt: '2026-03-29T12:00:00.000Z',
        }),
      } as never,
      {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'normal',
          source: 'auto',
          reason: 'system healthy',
          updatedAt: '2026-03-29T12:00:00.000Z',
          manualMode: null,
          queueLagSec: 0,
          action: {
            windowSec: 60,
            total: 12,
            success: 12,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
        }),
      } as never,
      createConfigMock({ QUEUE_LAG_DEGRADE_SEC: 10 }),
      {
        getSnapshot: jest.fn().mockResolvedValue(createWebhookSubscriptionSnapshot()),
      } as never,
    );

    await expect(service.getSnapshot()).resolves.toMatchObject({
      summary: {
        status: 'healthy',
        title: 'Бот работает ровно',
        stabilizing: false,
      },
      alerts: [],
      runtimeProfile: {
        appRole: 'all',
        serviceName: 'api-all',
        queueProfile: 'all-in-one',
        topologySource: 'fallback',
        targetWebhookP95Ms: 400,
      },
      canaryState: {
        status: 'disabled',
        recommendation: 'observe',
      },
      rollbackReadiness: {
        status: 'ready',
        webhookSloOk: true,
        queueLagOk: true,
      },
      queueGroupHealth: {
        status: 'healthy',
      },
    });
  });

  it('returns action latency diagnostics fail-soft', async () => {
    const actionLatency = {
      generatedAt: '2026-08-15T12:00:00.000Z',
      basis: 'terminal_outcomes',
    };
    const actionLatencyService = {
      getSnapshot: jest
        .fn()
        .mockResolvedValueOnce(actionLatency)
        .mockRejectedValueOnce(new Error('latency query unavailable')),
    };
    const service = new SystemDashboardService(
      {
        getSnapshot: jest.fn().mockResolvedValue(createHealthyQueueSnapshot()),
      } as never,
      {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'normal',
          source: 'auto',
          reason: 'system healthy',
          updatedAt: '2026-08-15T12:00:00.000Z',
          manualMode: null,
          queueLagSec: 0,
          action: {
            windowSec: 60,
            total: 12,
            success: 12,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
        }),
      } as never,
      createConfigMock({ QUEUE_LAG_DEGRADE_SEC: 10 }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      actionLatencyService as never,
    );
    const loggerWarn = jest
      .spyOn((service as unknown as { logger: Logger }).logger, 'warn')
      .mockImplementation();

    await expect(service.getSnapshot()).resolves.toMatchObject({ actionLatency });
    const fallback = await service.getSnapshot();

    expect(fallback).not.toHaveProperty('actionLatency');
    expect(actionLatencyService.getSnapshot).toHaveBeenCalledTimes(2);
    expect(loggerWarn).toHaveBeenCalledWith(
      { err: 'latency query unavailable' },
      'Action latency dashboard snapshot is unavailable; response remains fail-soft',
    );
  });

  it('surfaces VK parsing guard warnings without marking the dashboard critical', async () => {
    const service = new SystemDashboardService(
      {
        getSnapshot: jest.fn().mockResolvedValue(createHealthyQueueSnapshot()),
      } as never,
      {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'normal',
          source: 'auto',
          reason: 'system healthy',
          updatedAt: '2026-03-29T12:00:00.000Z',
          manualMode: null,
          queueLagSec: 0,
          action: {
            windowSec: 60,
            total: 12,
            success: 12,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
        }),
      } as never,
      createConfigMock({ QUEUE_LAG_DEGRADE_SEC: 10 }),
      {
        getSnapshot: jest.fn().mockResolvedValue(createWebhookSubscriptionSnapshot()),
      } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([
            {
              activeSources: 12,
              sourceFailureCount: 4,
              circuitOpenSources: 1,
            },
          ])
          .mockResolvedValueOnce([
            {
              recentMediaChecks: 10,
              recentMediaFailures: 3,
            },
          ])
          .mockResolvedValueOnce([
            {
              publishBacklog: 2,
              oldestPublishBacklogAgeSec: 900,
            },
          ]),
      } as never,
    );

    await expect(service.getSnapshot()).resolves.toMatchObject({
      summary: { status: 'warning' },
      alerts: [
        expect.objectContaining({
          code: 'vk-parsing-health',
          level: 'warning',
        }),
      ],
    });
  });

  it('surfaces delivery ledger risks as operator warnings without automatic retries', async () => {
    const context = createSuggestionPublicationContext();
    const auditDate = new Date('2026-08-20T10:00:00.000Z');
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([
        {
          activeSources: 12,
          sourceFailureCount: 0,
          circuitOpenSources: 0,
        },
      ])
      .mockResolvedValueOnce([
        {
          recentMediaChecks: 10,
          recentMediaFailures: 0,
        },
      ])
      .mockResolvedValueOnce([
        {
          publishBacklog: 0,
          oldestPublishBacklogAgeSec: 0,
        },
      ])
      .mockResolvedValueOnce([
        {
          actionAmbiguous: 1,
          actionStaleInProgress: 29,
          actionStaleRetryable: 8,
          actionOldestRiskAgeSec: 86_400,
          actionRecentAutoDeleteAccessAmbiguous: 4,
          actionOldestAutoDeleteAccessAmbiguousAgeSec: 7_200,
        },
      ])
      .mockResolvedValueOnce([
        {
          broadcastAmbiguous: 3,
          broadcastStaleSending: 1,
          broadcastRiskBroadcasts: 2,
          broadcastOldestRiskAgeSec: 3_600,
        },
      ])
      .mockResolvedValueOnce([
        {
          suggestionAmbiguous: 0,
          suggestionTerminalFailed: 229,
          suggestionStaleSending: 0,
          suggestionRiskSuggestions: 12,
          suggestionOldestRiskAgeSec: 172_800,
        },
      ])
      .mockResolvedValueOnce([
        {
          deleteIntentSafelyExpirable: 476,
          deleteIntentStaleExpiredInProgress: 2,
          deleteIntentOldestExpiredAgeSec: 259_200,
          deleteIntentRiskCapped: false,
          deleteIntentStaleExpiredInProgressCapped: false,
          deleteIntentAgedWaitingCapability: 0,
          deleteIntentAgedWaitingCapabilityChats: 0,
          deleteIntentOldestWaitingCapabilityAgeSec: 0,
          deleteIntentAgedWaitingCapabilityCapped: false,
        },
      ])
      .mockResolvedValueOnce([
        {
          suggestionId: 'safe',
          chatId: 'channel-1',
          actorUserId: 'user-1',
          createdAt: auditDate,
          claimAt: auditDate,
          payload: createSuggestionClaimPayload('safe'),
          jobId: null,
        },
        {
          suggestionId: 'completed',
          chatId: 'channel-1',
          actorUserId: 'user-1',
          createdAt: auditDate,
          claimAt: auditDate,
          payload: createSuggestionClaimPayload('completed', {
            reviewPublicationContext: context,
          }),
          ...createSuggestionLedgerFields('completed', {
            status: 'SUCCEEDED',
            terminal: true,
            dispatchToken: 'dispatch-completed',
            dispatchStartedAt: auditDate,
            dispatchBotId: 'bot-1',
            remoteMessageId: 'mid-completed',
          }),
        },
        {
          suggestionId: 'manual',
          chatId: 'channel-1',
          actorUserId: 'user-1',
          createdAt: auditDate,
          claimAt: auditDate,
          payload: createSuggestionClaimPayload('manual', {
            reviewPublicationContext: context,
          }),
          ...createSuggestionLedgerFields('manual', {
            dispatchToken: 'dispatch-manual',
            dispatchStartedAt: auditDate,
            dispatchBotId: 'bot-1',
          }),
        },
        {
          suggestionId: 'legacy',
          chatId: 'channel-1',
          actorUserId: 'user-1',
          createdAt: auditDate,
          claimAt: auditDate,
          payload: {
            type: 'suggest',
            reviewStatus: 'publishing',
            reviewAction: 'publish',
            reviewClaimedAt: auditDate.toISOString(),
            reviewClaimedByUserId: 'admin-1',
          },
          jobId: null,
        },
      ])
      .mockResolvedValueOnce([
        {
          ledgerId: 'ledger-missing',
          updatedAt: auditDate,
          ...createSuggestionLedgerFields('missing'),
          auditId: null,
          auditChatId: null,
          actorUserId: null,
          auditAction: null,
          payload: null,
        },
        {
          ledgerId: 'ledger-pending',
          updatedAt: auditDate,
          ...createSuggestionLedgerFields('pending'),
          auditId: 'pending',
          auditChatId: 'channel-1',
          actorUserId: 'user-1',
          auditAction: 'CHANNEL_DIALOG_SUGGESTION',
          payload: { type: 'suggest', reviewStatus: 'pending' },
        },
        {
          ledgerId: 'ledger-published',
          updatedAt: auditDate,
          ...createSuggestionLedgerFields('published', {
            status: 'SUCCEEDED',
            terminal: true,
            dispatchToken: 'dispatch-published',
            dispatchStartedAt: auditDate,
            dispatchBotId: 'bot-1',
            remoteMessageId: 'mid-published',
          }),
          auditId: 'published',
          auditChatId: 'channel-1',
          actorUserId: 'user-1',
          auditAction: 'CHANNEL_DIALOG_SUGGESTION',
          payload: {
            type: 'suggest',
            reviewStatus: 'published',
            reviewPublicationProtocol: CHANNEL_SUGGESTION_PUBLICATION_PROTOCOL_V1,
            reviewPublicationLedgerJobId: buildChannelSuggestionPublicationLedgerJobId('published'),
            reviewPublicationContext: context,
            publishedMessageId: 'mid-published',
          },
        },
        {
          ledgerId: 'ledger-mismatch',
          updatedAt: auditDate,
          ...createSuggestionLedgerFields('mismatch'),
          auditId: 'mismatch',
          auditChatId: 'other-channel',
          actorUserId: 'user-1',
          auditAction: 'CHANNEL_DIALOG_SUGGESTION',
          payload: { type: 'suggest', reviewStatus: 'pending' },
        },
        {
          ledgerId: 'ledger-linked',
          updatedAt: auditDate,
          ...createSuggestionLedgerFields('linked'),
          auditId: 'linked',
          auditChatId: 'channel-1',
          actorUserId: 'user-1',
          auditAction: 'CHANNEL_DIALOG_SUGGESTION',
          payload: createSuggestionClaimPayload('linked'),
        },
      ]);
    const service = new SystemDashboardService(
      {
        getSnapshot: jest.fn().mockResolvedValue(createHealthyQueueSnapshot()),
      } as never,
      {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'normal',
          source: 'auto',
          reason: 'system healthy',
          updatedAt: '2026-03-29T12:00:00.000Z',
          manualMode: null,
          queueLagSec: 0,
          action: {
            windowSec: 60,
            total: 12,
            success: 12,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
        }),
      } as never,
      createConfigMock({ QUEUE_LAG_DEGRADE_SEC: 10 }),
      {
        getSnapshot: jest.fn().mockResolvedValue(createWebhookSubscriptionSnapshot()),
      } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      createSuggestionProtocolPrismaMock(queryRaw) as never,
    );

    const snapshot = await service.getSnapshot();
    const alert = snapshot.alerts.find((alert) => alert.code === 'delivery-ledger-risk');

    expect(snapshot.summary.status).toBe('warning');
    expect(alert).toMatchObject({
      level: 'warning',
      detail: expect.stringContaining('stale in-progress 29'),
      recommendedAction: expect.stringContaining('не ретрайте автоматически'),
    });
    expect(alert?.detail).toContain('managed broadcast delivery: ambiguous 3');
    expect(alert?.detail).toContain(
      'MAX auto-delete verification за 24 ч: access-ambiguous 4, oldest 7200 сек',
    );
    expect(alert?.detail).toContain(
      'moderation delete intents: safely expirable 476, stale expired in-progress 2',
    );
    expect(alert?.detail).not.toContain('publishing');
    expect(alert?.recommendedAction).toContain(
      'npm run moderation:repair-bot-auto-delete-presence --workspace @maxim/api -- --discover-access-ambiguous --json',
    );

    expect(snapshot.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'channel-suggestion-publishing-stale',
          level: 'warning',
          detail: expect.stringContaining('safe pre-dispatch 1, completed 1, manual 1, legacy 1'),
          recommendedAction: expect.stringContaining('не сбрасывайте claim'),
        }),
        expect.objectContaining({
          code: 'channel-suggestion-ledger-audit',
          level: 'warning',
          detail: expect.stringContaining('missing audit 1, pending audit 1, mismatched 1'),
        }),
      ]),
    );

    const findQuery = (fragment: string) =>
      queryRaw.mock.calls.find((call) => extractSqlText(call).includes(fragment));
    const actionLedgerQuery = findQuery('from max_action_ledger');
    const actionLedgerSql = extractSqlText(actionLedgerQuery);
    expect(actionLedgerSql).toContain("action_type = 'DELETE_MESSAGE'");
    expect(actionLedgerSql).toContain("status = 'FAILED_RETRYABLE'");
    expect(actionLedgerSql).toContain('terminal = true');
    expect(actionLedgerSql).toContain('ambiguous = false');
    expect(actionLedgerSql).toContain("source_tag = 'moderation_notice'");
    expect(actionLedgerSql).toContain(
      "last_error_code = 'send_auto_delete_exact_verification_access_ambiguous'",
    );
    expect(actionLedgerSql).toContain('updated_at >=');
    const actionLedgerDates = readRawSqlValues(actionLedgerQuery ?? []).filter(
      (value): value is Date => value instanceof Date,
    );
    const newestActionLedgerDateMs = Math.max(...actionLedgerDates.map((value) => value.getTime()));
    const autoDeleteCutoffDates = actionLedgerDates.filter(
      (value) => value.getTime() < newestActionLedgerDateMs,
    );
    expect(autoDeleteCutoffDates).toHaveLength(3);
    expect(newestActionLedgerDateMs - autoDeleteCutoffDates[0]!.getTime()).toBe(
      24 * 60 * 60_000 - 15 * 60_000,
    );
    const suggestionPublishingQuery = findQuery('with publishing_candidates as materialized');
    const suggestionPublishingSql = extractSqlText(suggestionPublishingQuery);
    expect(suggestionPublishingSql).toContain("audit.payload->>'reviewStatus' = 'publishing'");
    expect(suggestionPublishingSql).toContain("audit.payload->>'type' = 'suggest'");
    expect(suggestionPublishingSql).toContain('jsonb_build_object');
    expect(suggestionPublishingSql).toContain('pg_input_is_valid(');
    expect(suggestionPublishingSql).toContain('audit.created_at <');
    expect(suggestionPublishingSql).toContain('and claim."claimAt" <');
    expect(suggestionPublishingSql).toContain(
      'order by claim."claimAt" asc, audit.created_at asc, audit.id asc',
    );
    expect(suggestionPublishingSql.indexOf('and claim."claimAt" <')).toBeLessThan(
      suggestionPublishingSql.indexOf('limit'),
    );
    expect(suggestionPublishingSql).toContain('limit');

    const suggestionLedgerQuery = findQuery('with suggestion_ledger_page as materialized');
    const suggestionLedgerSql = extractSqlText(suggestionLedgerQuery);
    expect(suggestionLedgerSql).toContain("ledger.action_type = 'SEND_MESSAGE'");
    expect(suggestionLedgerSql).toContain("ledger.source_tag = 'suggestion_delivery'");
    expect(suggestionLedgerSql).toContain("ledger.job_id like 'channel-suggestion:publish:v1:%'");
    expect(suggestionLedgerSql).toContain('and ledger.updated_at <=');
    expect(suggestionLedgerSql.match(/::timestamp\(3\)/gu)).toHaveLength(3);
    expect(suggestionLedgerSql).toContain('(ledger.updated_at, ledger.id) <');
    expect(suggestionLedgerSql).toContain('order by ledger.updated_at desc, ledger.id desc');
    expect(suggestionLedgerSql).toContain('left join audit_logs audit');
    expect(suggestionLedgerSql).not.toContain('and not coalesce(');
    expect(suggestionLedgerSql.indexOf('limit')).toBeLessThan(
      suggestionLedgerSql.indexOf('left join audit_logs audit'),
    );

    const deleteIntentQuery = findQuery('with risk_candidates as');
    const deleteIntentSql = extractSqlText(deleteIntentQuery);
    expect(deleteIntentSql).toContain('with risk_candidates as');
    expect(deleteIntentSql).toContain('stale_in_progress_candidates as');
    expect(deleteIntentSql).toContain('limit');
    expect(deleteIntentSql).toContain('intent.remote_delete_succeeded_at is null');
    expect(deleteIntentSql).toContain('intent.delete_dispatch_started_at is null');
    expect(deleteIntentSql).toContain('intent.lease_expires_at is null');
    expect(deleteIntentSql).toContain('intent.lease_expires_at <= current_timestamp');
    expect(deleteIntentSql).toContain('waiting_capability_candidates as');
    expect(deleteIntentSql).toContain("intent.status = 'WAITING_CAPABILITY'");
    expect(deleteIntentSql).toContain('intent.retry_until_at > current_timestamp');
    expect(deleteIntentSql).toContain('intent.first_attempt_at <=');
    expect(deleteIntentSql).toContain('order by intent.next_attempt_at asc, intent.execute_at asc');
    const deleteIntentParams = deleteIntentQuery?.slice(1) ?? [];
    expect(deleteIntentParams[2]).toBeInstanceOf(Date);
    expect(deleteIntentParams.filter((value: unknown) => typeof value === 'number')).toEqual([
      1_001, 1_001, 1_001, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000,
    ]);
  });

  it('caps stale publishing at 1000 while accounting for every bounded ledger row', async () => {
    const auditDate = new Date('2026-08-20T10:00:00.000Z');
    const publishingRows = Array.from({ length: 1_001 }, (_, index) => {
      const suggestionId = `safe-${index}`;
      return {
        suggestionId,
        chatId: 'channel-1',
        actorUserId: 'user-1',
        createdAt: auditDate,
        claimAt: auditDate,
        payload: createSuggestionClaimPayload(suggestionId),
        jobId: null,
      };
    });
    const ledgerRows = Array.from({ length: 1_001 }, (_, index) => {
      const suggestionId = `linked-${index}`;
      return {
        ledgerId: `ledger-${index}`,
        updatedAt: auditDate,
        ...createSuggestionLedgerFields(suggestionId),
        auditId: suggestionId,
        auditChatId: 'channel-1',
        actorUserId: 'user-1',
        auditAction: 'CHANNEL_DIALOG_SUGGESTION',
        payload: createSuggestionClaimPayload(suggestionId),
      };
    });
    const queryRaw = jest.fn(async (...args: unknown[]) => {
      const sql = extractSqlText(args);
      if (sql.includes('with publishing_candidates as materialized')) {
        return publishingRows;
      }
      if (sql.includes('with suggestion_ledger_page as materialized')) {
        return paginateSuggestionLedgerRows(ledgerRows, args);
      }
      throw new Error(`Unexpected suggestion protocol query: ${sql}`);
    });
    const prisma = createSuggestionProtocolPrismaMock(queryRaw);
    const service = new SystemDashboardService(
      {} as never,
      {} as never,
      createConfigMock(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      prisma as never,
    );

    const protocol = await (service as any).loadSuggestionPublicationProtocolSnapshot();

    expect(protocol.publishing).toMatchObject({
      safeRelease: 1_000,
      audited: 1_000,
      capped: true,
    });
    expect(protocol.ledgerAudit).toMatchObject({
      linkedPublishing: 1_001,
      audited: 1_001,
      capped: false,
    });
    expect(
      protocol.ledgerAudit.missingAudit +
        protocol.ledgerAudit.pendingAudit +
        protocol.ledgerAudit.publishedAudit +
        protocol.ledgerAudit.mismatchedAudit +
        protocol.ledgerAudit.linkedPublishing,
    ).toBe(protocol.ledgerAudit.audited);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'RepeatableRead',
      timeout: 15_000,
    });
    expect((service as any).buildSuggestionPublishingRiskAlert(protocol)).toMatchObject({
      level: 'warning',
      detail: expect.stringContaining('Выборка ограничена'),
    });
    expect((service as any).buildSuggestionLedgerAuditAlert(protocol)).toBeNull();
  });

  it('filters more than 1000 fresh claims before limiting stale publishing candidates', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-21T12:00:00.000Z'));
    try {
      const freshClaimAt = new Date('2026-08-21T11:59:00.000Z');
      const staleClaimAt = new Date('2026-08-21T10:00:00.000Z');
      const freshRows = Array.from({ length: 1_001 }, (_, index) => {
        const suggestionId = `fresh-old-${index}`;
        return {
          suggestionId,
          chatId: 'channel-1',
          actorUserId: 'user-1',
          createdAt: new Date(`2025-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`),
          claimAt: freshClaimAt,
          payload: createSuggestionClaimPayload(suggestionId, {
            reviewClaimedAt: freshClaimAt.toISOString(),
          }),
          jobId: null,
        };
      });
      const staleRow = {
        suggestionId: 'actually-stale',
        chatId: 'channel-1',
        actorUserId: 'user-1',
        createdAt: new Date('2026-08-20T12:00:00.000Z'),
        claimAt: staleClaimAt,
        payload: createSuggestionClaimPayload('actually-stale', {
          reviewClaimedAt: staleClaimAt.toISOString(),
        }),
        jobId: null,
      };
      const databaseRows = [...freshRows, staleRow];
      const staleBefore = new Date('2026-08-21T11:45:00.000Z');
      const queryRaw = jest.fn(async (...args: unknown[]) => {
        const sql = extractSqlText(args);
        if (sql.includes('with publishing_candidates as materialized')) {
          return databaseRows
            .filter((row) => row.claimAt < staleBefore)
            .sort(
              (left, right) =>
                left.claimAt.getTime() - right.claimAt.getTime() ||
                left.createdAt.getTime() - right.createdAt.getTime() ||
                left.suggestionId.localeCompare(right.suggestionId),
            )
            .slice(0, 1_001);
        }
        if (sql.includes('with suggestion_ledger_page as materialized')) {
          return [];
        }
        throw new Error(`Unexpected suggestion protocol query: ${sql}`);
      });
      const service = new SystemDashboardService(
        {} as never,
        {} as never,
        createConfigMock(),
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        createSuggestionProtocolPrismaMock(queryRaw) as never,
      );

      const protocol = await (service as any).loadSuggestionPublicationProtocolSnapshot();

      const createdAtLimitedWindow = [...databaseRows]
        .sort(
          (left, right) =>
            left.createdAt.getTime() - right.createdAt.getTime() ||
            left.suggestionId.localeCompare(right.suggestionId),
        )
        .slice(0, 1_001);
      expect(createdAtLimitedWindow).not.toContain(staleRow);
      expect(protocol.publishing).toMatchObject({
        safeRelease: 1,
        audited: 1,
        capped: false,
      });

      const publishingCall = queryRaw.mock.calls.find((call) =>
        extractSqlText(call).includes('with publishing_candidates as materialized'),
      );
      const publishingSql = extractSqlText(publishingCall);
      expect(publishingSql).toContain(
        'order by claim."claimAt" asc, audit.created_at asc, audit.id asc',
      );
      expect(publishingSql.indexOf('and claim."claimAt" <')).toBeLessThan(
        publishingSql.indexOf('limit'),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('finds a new orphan after more than 1000 healthy published ledgers', async () => {
    const healthyUpdatedAt = new Date('2026-08-20T10:00:00.000Z');
    const healthyHistory = Array.from({ length: 1_001 }, (_, index) =>
      createHealthyPublishedSuggestionLedgerRow(`healthy-${index}`, healthyUpdatedAt),
    );
    const orphan = {
      ledgerId: 'ledger-new-orphan',
      updatedAt: new Date('2026-08-21T10:00:00.000Z'),
      ...createSuggestionLedgerFields('new-orphan'),
      auditId: null,
      auditChatId: null,
      actorUserId: null,
      auditAction: null,
      payload: null,
    };
    const databaseRows = [...healthyHistory, orphan];
    const queryRaw = jest.fn(async (...args: unknown[]) => {
      const sql = extractSqlText(args);
      if (sql.includes('with publishing_candidates as materialized')) {
        return [];
      }
      if (sql.includes('with suggestion_ledger_page as materialized')) {
        return paginateSuggestionLedgerRows(databaseRows, args);
      }
      throw new Error(`Unexpected suggestion protocol query: ${sql}`);
    });
    const service = new SystemDashboardService(
      {} as never,
      {} as never,
      createConfigMock(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createSuggestionProtocolPrismaMock(queryRaw) as never,
    );

    const protocol = await (service as any).loadSuggestionPublicationProtocolSnapshot();

    expect(
      [...databaseRows]
        .sort(
          (left, right) =>
            right.updatedAt.getTime() - left.updatedAt.getTime() ||
            right.ledgerId.localeCompare(left.ledgerId),
        )
        .slice(0, 1_001),
    ).toContain(orphan);
    expect(protocol.ledgerAudit).toMatchObject({
      missingAudit: 1,
      publishedAudit: 1_001,
      audited: 1_002,
      capped: false,
    });

    const ledgerCalls = queryRaw.mock.calls.filter((call) =>
      extractSqlText(call).includes('with suggestion_ledger_page as materialized'),
    );
    expect(ledgerCalls).toHaveLength(5);
    expect(readRawSqlValues(ledgerCalls[1])).toContainEqual(expect.any(Date));
    expect(readRawSqlValues(ledgerCalls[1])).toContainEqual(
      expect.stringMatching(/^ledger-healthy-/u),
    );
    const ledgerSql = extractSqlText(ledgerCalls[0]);
    expect(ledgerSql).not.toContain('and not coalesce(');
    expect(ledgerSql.indexOf('limit')).toBeLessThan(
      ledgerSql.indexOf('left join audit_logs audit'),
    );
  });

  it('does not cap or warn on healthy published ledger history alone', async () => {
    const healthyHistory = Array.from({ length: 1_500 }, (_, index) =>
      createHealthyPublishedSuggestionLedgerRow(
        `healthy-only-${index}`,
        new Date('2026-08-20T10:00:00.000Z'),
      ),
    );
    const queryRaw = jest.fn(async (...args: unknown[]) => {
      const sql = extractSqlText(args);
      if (sql.includes('with publishing_candidates as materialized')) {
        return [];
      }
      if (sql.includes('with suggestion_ledger_page as materialized')) {
        return paginateSuggestionLedgerRows(healthyHistory, args);
      }
      throw new Error(`Unexpected suggestion protocol query: ${sql}`);
    });
    const service = new SystemDashboardService(
      {} as never,
      {} as never,
      createConfigMock(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createSuggestionProtocolPrismaMock(queryRaw) as never,
    );

    const protocol = await (service as any).loadSuggestionPublicationProtocolSnapshot();

    expect(healthyHistory).toHaveLength(1_500);
    expect(protocol.ledgerAudit).toMatchObject({
      missingAudit: 0,
      pendingAudit: 0,
      publishedAudit: 1_500,
      mismatchedAudit: 0,
      linkedPublishing: 0,
      audited: 1_500,
      capped: false,
    });
    expect((service as any).buildSuggestionLedgerAuditAlert(protocol)).toBeNull();
  });

  it('keeps a deliberate fail-closed warning and still finds newest risk past the scan cap', async () => {
    const healthyHistory = Array.from({ length: 2_001 }, (_, index) =>
      createHealthyPublishedSuggestionLedgerRow(
        `bounded-healthy-${index}`,
        new Date('2026-08-20T10:00:00.000Z'),
      ),
    );
    const newestOrphan = {
      ledgerId: 'ledger-bounded-newest-orphan',
      updatedAt: new Date('2026-08-21T10:00:00.000Z'),
      ...createSuggestionLedgerFields('bounded-newest-orphan'),
      auditId: null,
      auditChatId: null,
      actorUserId: null,
      auditAction: null,
      payload: null,
    };
    const databaseRows = [...healthyHistory, newestOrphan];
    const queryRaw = jest.fn(async (...args: unknown[]) => {
      const sql = extractSqlText(args);
      if (sql.includes('with publishing_candidates as materialized')) {
        return [];
      }
      if (sql.includes('with suggestion_ledger_page as materialized')) {
        return paginateSuggestionLedgerRows(databaseRows, args);
      }
      throw new Error(`Unexpected suggestion protocol query: ${sql}`);
    });
    const service = new SystemDashboardService(
      {} as never,
      {} as never,
      createConfigMock(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createSuggestionProtocolPrismaMock(queryRaw) as never,
    );

    const protocol = await (service as any).loadSuggestionPublicationProtocolSnapshot();

    expect(protocol.ledgerAudit).toMatchObject({
      missingAudit: 1,
      publishedAudit: 1_999,
      audited: 2_000,
      capped: true,
    });
    expect(
      protocol.ledgerAudit.missingAudit +
        protocol.ledgerAudit.pendingAudit +
        protocol.ledgerAudit.publishedAudit +
        protocol.ledgerAudit.mismatchedAudit +
        protocol.ledgerAudit.linkedPublishing,
    ).toBe(protocol.ledgerAudit.audited);
    const alert = (service as any).buildSuggestionLedgerAuditAlert(protocol);
    expect(alert).toMatchObject({
      level: 'warning',
      detail: expect.stringContaining('Выборка ограничена последними 2000 ledger'),
      recommendedAction: expect.stringContaining('неполную диагностику'),
    });
    expect(alert.detail).toContain('более старая история не проверена');
    expect(alert.detail).toContain('предупреждение о неполном покрытии');
    expect(
      queryRaw.mock.calls.filter((call) =>
        extractSqlText(call).includes('with suggestion_ledger_page as materialized'),
      ),
    ).toHaveLength(8);
  });

  it('keeps a capped but healthy newest sample in warning instead of claiming full coverage', () => {
    const service = new SystemDashboardService({} as never, {} as never, createConfigMock());
    const protocol = {
      checkedAt: '2026-08-21T10:00:00.000Z',
      publishing: {
        safeRelease: 0,
        completed: 0,
        manual: 0,
        legacy: 0,
        audited: 0,
        oldestAgeSec: 0,
        capped: false,
      },
      ledgerAudit: {
        missingAudit: 0,
        pendingAudit: 0,
        publishedAudit: 2_000,
        mismatchedAudit: 0,
        linkedPublishing: 0,
        audited: 2_000,
        oldestAgeSec: 86_400,
        capped: true,
      },
    };

    const alert = (service as any).buildSuggestionLedgerAuditAlert(protocol);

    expect(alert).toMatchObject({
      level: 'warning',
      detail: expect.stringContaining('более старая история не проверена'),
      recommendedAction: expect.stringContaining('неполную диагностику'),
    });
    expect(alert.detail).toContain('orphan/mismatch 0');
  });

  it('classifies a forged context digest in TypeScript instead of filtering it as healthy SQL', async () => {
    const row = createHealthyPublishedSuggestionLedgerRow(
      'forged-context',
      new Date('2026-08-20T10:00:00.000Z'),
    );
    const payload = row.payload as Record<string, unknown>;
    const context = payload.reviewPublicationContext as Record<string, unknown>;
    const metadata = row.metadata as { ledgerContext: Record<string, unknown> };
    const forgedDigest = context.contextDigest === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    const forgedRow = {
      ...row,
      payload: {
        ...payload,
        reviewPublicationContext: { ...context, contextDigest: forgedDigest },
      },
      metadata: {
        ...metadata,
        ledgerContext: { ...metadata.ledgerContext, contextDigest: forgedDigest },
      },
    };
    const queryRaw = jest.fn(async (...args: unknown[]) => {
      const sql = extractSqlText(args);
      if (sql.includes('with publishing_candidates as materialized')) {
        return [];
      }
      if (sql.includes('with suggestion_ledger_page as materialized')) {
        return paginateSuggestionLedgerRows([forgedRow], args);
      }
      throw new Error(`Unexpected suggestion protocol query: ${sql}`);
    });
    const service = new SystemDashboardService(
      {} as never,
      {} as never,
      createConfigMock(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createSuggestionProtocolPrismaMock(queryRaw) as never,
    );

    const protocol = await (service as any).loadSuggestionPublicationProtocolSnapshot();

    expect(protocol.ledgerAudit).toMatchObject({
      mismatchedAudit: 1,
      publishedAudit: 0,
      audited: 1,
      capped: false,
    });
  });

  it('fails the suggestion protocol snapshot soft when a later ledger page fails', async () => {
    const healthyHistory = Array.from({ length: 300 }, (_, index) =>
      createHealthyPublishedSuggestionLedgerRow(
        `page-failure-${index}`,
        new Date('2026-08-20T10:00:00.000Z'),
      ),
    );
    let ledgerPageCalls = 0;
    const queryRaw = jest.fn(async (...args: unknown[]) => {
      const sql = extractSqlText(args);
      if (sql.includes('with publishing_candidates as materialized')) {
        return [];
      }
      if (sql.includes('with suggestion_ledger_page as materialized')) {
        ledgerPageCalls += 1;
        if (ledgerPageCalls === 2) {
          throw new Error('ledger page unavailable');
        }
        return paginateSuggestionLedgerRows(healthyHistory, args);
      }
      throw new Error(`Unexpected suggestion protocol query: ${sql}`);
    });
    const service = new SystemDashboardService(
      {} as never,
      {} as never,
      createConfigMock(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      createSuggestionProtocolPrismaMock(queryRaw) as never,
    );

    await expect((service as any).loadSuggestionPublicationProtocolSnapshot()).resolves.toBeNull();
    expect(ledgerPageCalls).toBe(2);
  });

  it('does not warn for fully bound published suggestion ledgers alone', () => {
    const service = new SystemDashboardService({} as never, {} as never, createConfigMock());
    const protocol = {
      checkedAt: '2026-08-21T10:00:00.000Z',
      publishing: {
        safeRelease: 0,
        completed: 0,
        manual: 0,
        legacy: 0,
        audited: 0,
        oldestAgeSec: 0,
        capped: false,
      },
      ledgerAudit: {
        missingAudit: 0,
        pendingAudit: 0,
        publishedAudit: 20,
        mismatchedAudit: 0,
        linkedPublishing: 0,
        audited: 20,
        oldestAgeSec: 86_400,
        capped: false,
      },
    };

    expect((service as any).buildSuggestionPublishingRiskAlert(protocol)).toBeNull();
    expect((service as any).buildSuggestionLedgerAuditAlert(protocol)).toBeNull();
  });

  it('warns when active moderation deletions wait for capability longer than five minutes', async () => {
    const service = new SystemDashboardService(
      {
        getSnapshot: jest.fn().mockResolvedValue(createHealthyQueueSnapshot()),
      } as never,
      {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'normal',
          source: 'auto',
          reason: 'system healthy',
          updatedAt: '2026-08-20T01:00:00.000Z',
          manualMode: null,
          queueLagSec: 0,
          action: {
            windowSec: 60,
            total: 12,
            success: 12,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
        }),
      } as never,
      createConfigMock({ QUEUE_LAG_DEGRADE_SEC: 10 }),
      {
        getSnapshot: jest.fn().mockResolvedValue(createWebhookSubscriptionSnapshot()),
      } as never,
    );
    jest
      .spyOn(
        service as unknown as {
          loadDeliveryLedgerRiskSnapshot: () => Promise<unknown>;
        },
        'loadDeliveryLedgerRiskSnapshot',
      )
      .mockResolvedValue({
        checkedAt: '2026-08-20T01:00:00.000Z',
        actionAmbiguous: 0,
        actionStaleInProgress: 0,
        actionStaleRetryable: 0,
        actionOldestRiskAgeSec: 0,
        actionRecentAutoDeleteAccessAmbiguous: 0,
        actionOldestAutoDeleteAccessAmbiguousAgeSec: 0,
        broadcastAmbiguous: 0,
        broadcastStaleSending: 0,
        broadcastRiskBroadcasts: 0,
        broadcastOldestRiskAgeSec: 0,
        suggestionAmbiguous: 0,
        suggestionTerminalFailed: 0,
        suggestionStaleSending: 0,
        suggestionRiskSuggestions: 0,
        suggestionOldestRiskAgeSec: 0,
        deleteIntentSafelyExpirable: 0,
        deleteIntentStaleExpiredInProgress: 0,
        deleteIntentOldestExpiredAgeSec: 0,
        deleteIntentRiskCapped: false,
        deleteIntentStaleExpiredInProgressCapped: false,
        deleteIntentAgedWaitingCapability: 23,
        deleteIntentAgedWaitingCapabilityChats: 3,
        deleteIntentOldestWaitingCapabilityAgeSec: 1_800,
        deleteIntentAgedWaitingCapabilityCapped: false,
      });

    const snapshot = await service.getSnapshot();

    expect(snapshot.summary.status).toBe('warning');
    expect(snapshot.alerts).toEqual([
      expect.objectContaining({
        code: 'moderation-delete-capability-backlog',
        level: 'warning',
        detail: expect.stringContaining(
          '23 delete intents сейчас в WAITING_CAPABILITY, а их первая попытка была больше 5 мин назад',
        ),
        recommendedAction: expect.stringContaining('требуется write'),
      }),
    ]);
    expect(snapshot.alerts[0]?.detail).toContain('Затронуто чатов: 3');
    expect(snapshot.alerts[0]?.detail).toContain(
      'максимальный возраст от первой попытки: 1800 сек',
    );
    expect(snapshot.alerts[0]?.recommendedAction).toContain('unverified 404');

    const subject = service as unknown as {
      buildDeleteCapabilityBacklogAlert: (
        input: Record<string, string | number | boolean>,
      ) => { detail: string } | null;
    };
    expect(
      subject.buildDeleteCapabilityBacklogAlert({
        checkedAt: '2026-08-20T01:00:00.000Z',
        actionAmbiguous: 0,
        actionStaleInProgress: 0,
        actionStaleRetryable: 0,
        actionOldestRiskAgeSec: 0,
        actionRecentAutoDeleteAccessAmbiguous: 0,
        actionOldestAutoDeleteAccessAmbiguousAgeSec: 0,
        broadcastAmbiguous: 0,
        broadcastStaleSending: 0,
        broadcastRiskBroadcasts: 0,
        broadcastOldestRiskAgeSec: 0,
        suggestionAmbiguous: 0,
        suggestionTerminalFailed: 0,
        suggestionStaleSending: 0,
        suggestionRiskSuggestions: 0,
        suggestionOldestRiskAgeSec: 0,
        deleteIntentSafelyExpirable: 0,
        deleteIntentStaleExpiredInProgress: 0,
        deleteIntentOldestExpiredAgeSec: 0,
        deleteIntentRiskCapped: false,
        deleteIntentStaleExpiredInProgressCapped: false,
        deleteIntentAgedWaitingCapability: 1_000,
        deleteIntentAgedWaitingCapabilityChats: 17,
        deleteIntentOldestWaitingCapabilityAgeSec: 7_200,
        deleteIntentAgedWaitingCapabilityCapped: true,
      })?.detail,
    ).toContain(
      '>=1000 delete intents сейчас в WAITING_CAPABILITY, а их первая попытка была больше 5 мин назад. В ограниченной выборке чатов: 17, максимальный возраст от первой попытки: 7200 сек.',
    );
  });

  it('warns only after repeated critical internal limiter rejects', async () => {
    const criticalLimiter = { windowSec: 600, internalRejects: 3 };
    const getCriticalLimiterSnapshot = jest
      .fn()
      .mockResolvedValueOnce(criticalLimiter)
      .mockRejectedValueOnce(new Error('limiter metrics unavailable'));
    const service = new SystemDashboardService(
      {
        getSnapshot: jest.fn().mockResolvedValue(createHealthyQueueSnapshot()),
      } as never,
      {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'normal',
          source: 'auto',
          reason: 'system healthy',
          updatedAt: '2026-08-20T01:00:00.000Z',
          manualMode: null,
          queueLagSec: 0,
          action: {
            windowSec: 60,
            total: 12,
            success: 12,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
        }),
      } as never,
      createConfigMock({ QUEUE_LAG_DEGRADE_SEC: 10 }),
      {
        getSnapshot: jest.fn().mockResolvedValue(createWebhookSubscriptionSnapshot()),
      } as never,
      undefined,
      undefined,
      {
        getDashboardBudgetSummary: jest.fn().mockResolvedValue(undefined),
        getCriticalLimiterSnapshot,
      } as never,
    );
    const loggerWarn = jest
      .spyOn((service as unknown as { logger: Logger }).logger, 'warn')
      .mockImplementation();

    const snapshot = await service.getSnapshot();

    expect(snapshot.summary.status).toBe('warning');
    expect(snapshot.alerts).toEqual([
      expect.objectContaining({
        code: 'max-api-critical-limiter-rejects',
        level: 'warning',
        detail: '3 critical rejects за 10 мин. (warning threshold 3).',
      }),
    ]);

    const subject = service as unknown as {
      buildCriticalLimiterAlert: (input: { windowSec: number; internalRejects: number }) => unknown;
    };
    expect(subject.buildCriticalLimiterAlert({ windowSec: 600, internalRejects: 2 })).toBeNull();
    expect(subject.buildCriticalLimiterAlert({ windowSec: 1_800, internalRejects: 8 })).toBeNull();
    expect(subject.buildCriticalLimiterAlert({ windowSec: 1_800, internalRejects: 9 })).toEqual(
      expect.objectContaining({ code: 'max-api-critical-limiter-rejects' }),
    );

    await expect(service.getSnapshot()).resolves.toMatchObject({
      summary: { status: 'healthy' },
      alerts: [],
    });
    expect(getCriticalLimiterSnapshot).toHaveBeenCalledTimes(2);
    expect(loggerWarn).toHaveBeenCalledWith(
      { err: 'limiter metrics unavailable' },
      'Critical limiter dashboard snapshot is unavailable; response remains fail-soft',
    );
  });

  it('keeps a healthy dashboard clean when delivery ledger risk aggregates are empty', async () => {
    const service = new SystemDashboardService(
      {
        getSnapshot: jest.fn().mockResolvedValue(createHealthyQueueSnapshot()),
      } as never,
      {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'normal',
          source: 'auto',
          reason: 'system healthy',
          updatedAt: '2026-03-29T12:00:00.000Z',
          manualMode: null,
          queueLagSec: 0,
          action: {
            windowSec: 60,
            total: 12,
            success: 12,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
        }),
      } as never,
      createConfigMock({ QUEUE_LAG_DEGRADE_SEC: 10 }),
      {
        getSnapshot: jest.fn().mockResolvedValue(createWebhookSubscriptionSnapshot()),
      } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([
            {
              activeSources: 12,
              sourceFailureCount: 0,
              circuitOpenSources: 0,
            },
          ])
          .mockResolvedValueOnce([
            {
              recentMediaChecks: 10,
              recentMediaFailures: 0,
            },
          ])
          .mockResolvedValueOnce([
            {
              publishBacklog: 0,
              oldestPublishBacklogAgeSec: 0,
            },
          ])
          .mockResolvedValueOnce([
            {
              actionAmbiguous: 0,
              actionStaleInProgress: 0,
              actionStaleRetryable: 0,
              actionOldestRiskAgeSec: 0,
              actionRecentAutoDeleteAccessAmbiguous: 0,
              actionOldestAutoDeleteAccessAmbiguousAgeSec: 0,
            },
          ])
          .mockResolvedValueOnce([
            {
              broadcastAmbiguous: 0,
              broadcastStaleSending: 0,
              broadcastRiskBroadcasts: 0,
              broadcastOldestRiskAgeSec: 0,
            },
          ])
          .mockResolvedValueOnce([
            {
              suggestionAmbiguous: 0,
              suggestionTerminalFailed: 0,
              suggestionStaleSending: 0,
              suggestionRiskSuggestions: 0,
              suggestionOldestRiskAgeSec: 0,
            },
          ])
          .mockResolvedValueOnce([
            {
              suggestionStalePublishing: 0,
              suggestionOldestPublishingAgeSec: 0,
              suggestionStalePublishingCapped: false,
            },
          ])
          .mockResolvedValueOnce([
            {
              deleteIntentSafelyExpirable: 0,
              deleteIntentStaleExpiredInProgress: 0,
              deleteIntentOldestExpiredAgeSec: 0,
              deleteIntentRiskCapped: false,
              deleteIntentStaleExpiredInProgressCapped: false,
            },
          ]),
      } as never,
    );

    await expect(service.getSnapshot()).resolves.toMatchObject({
      summary: { status: 'healthy' },
      alerts: [],
    });
  });

  it('surfaces slow webhook hot path completions before they become timeouts', async () => {
    const service = new SystemDashboardService(
      {
        getSnapshot: jest.fn().mockResolvedValue(createHealthyQueueSnapshot()),
      } as never,
      {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'normal',
          source: 'auto',
          reason: 'system healthy',
          updatedAt: '2026-03-29T12:00:00.000Z',
          manualMode: null,
          queueLagSec: 0,
          action: {
            windowSec: 60,
            total: 12,
            success: 12,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
        }),
      } as never,
      createConfigMock({ QUEUE_LAG_DEGRADE_SEC: 10 }),
      {
        getSnapshot: jest.fn().mockResolvedValue(createWebhookSubscriptionSnapshot()),
      } as never,
      undefined,
      {
        recordQueueLagSnapshot: jest.fn().mockResolvedValue(undefined),
        getDashboardSnapshot: jest.fn().mockResolvedValue({
          burst: {
            active: false,
            peakLagSec: 0,
            peakBotId: null,
            startedAt: null,
            lastRecoveredAt: null,
            sampleAgeMs: 1000,
          },
          hotPath: {
            windowSec: 900,
            failOpenCount: 0,
            stages: [
              {
                stage: 'user-facing-total',
                count: 2,
                slowCount: 2,
                timeoutCount: 0,
                skipCount: 0,
                failOpenCount: 0,
                avgElapsedMs: 7100,
                maxElapsedMs: 8032,
                lastObservedAt: '2026-03-29T12:00:00.000Z',
              },
            ],
          },
          hotChats: { windowSec: 1800, items: [] },
          membershipLookup: {
            windowSec: 900,
            hotChannels: 0,
            backoffActiveChats: 0,
            transientIssues: 0,
            terminalIssues: 0,
            hotChannelsSample: [],
            backoffSample: [],
            issueSample: [],
          },
          problemChats: { windowSec: 3600, items: [] },
          spammerSurfaces: { windowSec: 900, timings: [] },
          spammerReadModel: {
            windowSec: 900,
            profileReads: { hits: 0, misses: 0, stale: 0, fallbacks: 0, hitRate: 1 },
            shadow: {
              compared: 0,
              matched: 0,
              mismatched: 0,
              scoreDrift: 0,
              scoreDriftRate: 0,
              mismatchRate: 0,
            },
            profileWrites: { success: 0, failure: 0 },
            denormJobs: {
              enqueued: 0,
              enqueueFailed: 0,
              fastPathEnqueued: 0,
              fastPathFallbacks: 0,
              fastPathReplayed: 0,
              fastPathReplayMissing: 0,
              processed: 0,
              failed: 0,
              avgAgeMs: 0,
              maxAgeMs: 0,
              lastSuccessAt: null,
              lastFailureAt: null,
            },
          },
        }),
      } as never,
    );

    await expect(service.getSnapshot()).resolves.toMatchObject({
      summary: { status: 'warning' },
      alerts: [
        expect.objectContaining({
          code: 'webhook-hot-path-slow',
          level: 'warning',
          detail: expect.stringContaining('user-facing-total'),
        }),
      ],
    });
  });

  it('does not raise a failed-webhooks alert for stale historical FAILED tails without recent failures', async () => {
    const service = new SystemDashboardService(
      {
        getSnapshot: jest.fn().mockResolvedValue({
          moderation: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookCritical: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookJoin: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookJoinShards: {},
          webhookDefault: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookDefaultShards: {},
          webhookDefaultWorkerGroups: createDefaultWorkerGroups(),
          webhookBackground: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookLegacy: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          actions: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookEvents: {
            received: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            queued: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            failed: {
              count: 141,
              activeCount: 0,
              staleCount: 141,
              activeWindowSec: 21600,
              oldestEventId: 'evt-stale-1',
              oldestCreatedAt: null,
              oldestLagSec: 86400,
            },
          },
          userFacingWebhookEvents: {
            received: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            queued: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            failed: {
              count: 141,
              activeCount: 0,
              staleCount: 141,
              activeWindowSec: 21600,
              oldestEventId: 'evt-stale-1',
              oldestCreatedAt: null,
              oldestLagSec: 86400,
            },
          },
          actionHealth: {
            windowSec: 60,
            total: 12,
            success: 12,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
          webhookDynamicLeases: null,
          bots: {},
          oldestQueuedEventId: null,
          oldestQueuedCreatedAt: null,
          oldestQueuedLagSec: 0,
          oldestReceivedEventId: null,
          oldestReceivedCreatedAt: null,
          oldestReceivedLagSec: 0,
          effectiveLagSec: 0,
          userFacingOldestQueuedEventId: null,
          userFacingOldestQueuedCreatedAt: null,
          userFacingOldestQueuedLagSec: 0,
          userFacingOldestReceivedEventId: null,
          userFacingOldestReceivedCreatedAt: null,
          userFacingOldestReceivedLagSec: 0,
          userFacingEffectiveLagSec: 0,
          generatedAt: '2026-03-29T12:00:00.000Z',
        }),
      } as never,
      {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'normal',
          source: 'auto',
          reason: 'system healthy',
          updatedAt: '2026-03-29T12:00:00.000Z',
          manualMode: null,
          queueLagSec: 0,
          action: {
            windowSec: 60,
            total: 12,
            success: 12,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
        }),
      } as never,
      createConfigMock({ QUEUE_LAG_DEGRADE_SEC: 10 }),
      {
        getSnapshot: jest.fn().mockResolvedValue(createWebhookSubscriptionSnapshot()),
      } as never,
    );

    await expect(service.getSnapshot()).resolves.toMatchObject({
      summary: {
        status: 'healthy',
        title: 'Бот работает ровно',
      },
      alerts: [],
    });
  });

  it('builds a critical summary with operator guidance during degrade', async () => {
    const service = new SystemDashboardService(
      {
        getSnapshot: jest.fn().mockResolvedValue({
          moderation: { waiting: 2, active: 1, delayed: 0, failed: 0, completed: 120 },
          webhookCritical: { waiting: 0, active: 1, delayed: 0, failed: 0, completed: 25 },
          webhookDefault: { waiting: 4, active: 2, delayed: 0, failed: 1, completed: 90 },
          webhookDefaultWorkerGroups: createDefaultWorkerGroups({
            'api-moderation-realtime-c': {
              queues: [
                'moderation-default-2',
                'moderation-default-6',
                'moderation-default-10',
                'moderation-default-14',
              ],
              counters: { waiting: 4, active: 2, delayed: 0, failed: 0, completed: 45 },
            },
          }),
          webhookBackground: { waiting: 3, active: 0, delayed: 0, failed: 0, completed: 10 },
          webhookLegacy: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          actions: { waiting: 1, active: 1, delayed: 0, failed: 0, completed: 42 },
          webhookEvents: {
            received: { count: 9, oldestEventId: 'evt-1', oldestCreatedAt: null, oldestLagSec: 8 },
            queued: { count: 5, oldestEventId: 'evt-2', oldestCreatedAt: null, oldestLagSec: 13 },
            failed: { count: 141, oldestEventId: 'evt-3', oldestCreatedAt: null, oldestLagSec: 55 },
          },
          actionHealth: {
            windowSec: 60,
            total: 220,
            success: 194,
            failure: 26,
            critical: 14,
            errorRate: 0.118,
            criticalRate: 0.063,
          },
          oldestQueuedEventId: 'evt-2',
          oldestQueuedCreatedAt: null,
          oldestQueuedLagSec: 13,
          oldestReceivedEventId: 'evt-1',
          oldestReceivedCreatedAt: null,
          oldestReceivedLagSec: 8,
          effectiveLagSec: 13,
          generatedAt: '2026-03-29T12:10:00.000Z',
        }),
      } as never,
      {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'degrade',
          source: 'auto',
          reason: 'queue lag 13.0s; critical MAX API rate 6.30%',
          updatedAt: '2026-03-29T12:10:00.000Z',
          manualMode: null,
          queueLagSec: 13,
          action: {
            windowSec: 60,
            total: 220,
            success: 194,
            failure: 26,
            critical: 14,
            errorRate: 0.118,
            criticalRate: 0.063,
          },
        }),
      } as never,
      createConfigMock({ QUEUE_LAG_DEGRADE_SEC: 10 }),
      {
        getSnapshot: jest.fn().mockResolvedValue(createWebhookSubscriptionSnapshot()),
      } as never,
    );

    await expect(service.getSnapshot()).resolves.toMatchObject({
      summary: {
        status: 'critical',
        title: 'Нужна реакция оператора',
      },
      alerts: expect.arrayContaining([
        expect.objectContaining({ code: 'queue-lag', level: 'critical' }),
        expect.objectContaining({ code: 'failed-webhooks', level: 'critical' }),
        expect.objectContaining({ code: 'critical-rate', level: 'critical' }),
        expect.objectContaining({ code: 'default-worker-skew', level: 'warning' }),
      ]),
    });
  });

  it('adds runtime diagnostics and background budget fields when the services are available', async () => {
    const service = new SystemDashboardService(
      {
        getSnapshot: jest.fn().mockResolvedValue({
          moderation: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookCritical: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookJoin: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookJoinShards: {},
          webhookDefault: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookDefaultShards: {},
          webhookDefaultWorkerGroups: createDefaultWorkerGroups(),
          webhookBackground: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookLegacy: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          actions: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookEvents: {
            received: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            queued: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            failed: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
          },
          userFacingWebhookEvents: {
            received: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            queued: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            failed: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
          },
          actionHealth: {
            windowSec: 60,
            total: 0,
            success: 0,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
          bots: {},
          webhookDynamicLeases: null,
          oldestQueuedEventId: null,
          oldestQueuedCreatedAt: null,
          oldestQueuedLagSec: 0,
          oldestReceivedEventId: null,
          oldestReceivedCreatedAt: null,
          oldestReceivedLagSec: 0,
          effectiveLagSec: 0,
          userFacingOldestQueuedEventId: null,
          userFacingOldestQueuedCreatedAt: null,
          userFacingOldestQueuedLagSec: 0,
          userFacingOldestReceivedEventId: null,
          userFacingOldestReceivedCreatedAt: null,
          userFacingOldestReceivedLagSec: 0,
          userFacingEffectiveLagSec: 0,
          generatedAt: '2026-03-29T12:00:00.000Z',
        }),
      } as never,
      {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'normal',
          source: 'auto',
          reason: 'system healthy',
          updatedAt: '2026-03-29T12:00:00.000Z',
          manualMode: null,
          queueLagSec: 0,
          action: {
            windowSec: 60,
            total: 0,
            success: 0,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
        }),
      } as never,
      createConfigMock({ QUEUE_LAG_DEGRADE_SEC: 10 }),
      {
        getSnapshot: jest.fn().mockResolvedValue(createWebhookSubscriptionSnapshot()),
      } as never,
      undefined,
      {
        recordQueueLagSnapshot: jest.fn().mockResolvedValue(undefined),
        getDashboardSnapshot: jest.fn().mockResolvedValue({
          burst: {
            active: false,
            peakLagSec: 0,
            peakBotId: null,
            startedAt: null,
            lastRecoveredAt: '2026-03-29T11:58:00.000Z',
            sampleAgeMs: 1200,
          },
          hotPath: {
            windowSec: 900,
            failOpenCount: 2,
            stages: [
              {
                stage: 'required-subscription',
                count: 10,
                slowCount: 2,
                timeoutCount: 1,
                skipCount: 1,
                failOpenCount: 2,
                avgElapsedMs: 1800,
                maxElapsedMs: 6200,
                lastObservedAt: '2026-03-29T12:00:00.000Z',
              },
            ],
          },
          hotChats: {
            windowSec: 1800,
            items: [
              {
                chatId: 'chat-1',
                messageCreatedCount: 42,
                botsSeen: 2,
                lastSeenAt: '2026-03-29T12:00:00.000Z',
              },
            ],
          },
          membershipLookup: {
            windowSec: 900,
            hotChannels: 1,
            backoffActiveChats: 1,
            transientIssues: 1,
            terminalIssues: 0,
            hotChannelsSample: [],
            backoffSample: [],
            issueSample: [],
          },
          spammerSurfaces: {
            windowSec: 900,
            timings: [
              {
                surface: 'spammer-review',
                stage: 'total',
                count: 4,
                avgMs: 180,
                p95Ms: 300,
                p99Ms: 500,
                maxMs: 420,
                lastObservedAt: '2026-03-29T12:00:00.000Z',
              },
            ],
          },
          spammerReadModel: {
            windowSec: 900,
            profileReads: {
              hits: 12,
              misses: 3,
              stale: 1,
              fallbacks: 2,
              hitRate: 0.75,
            },
            shadow: {
              compared: 10,
              matched: 9,
              mismatched: 1,
              scoreDrift: 2,
              scoreDriftRate: 0.2,
              mismatchRate: 0.1,
            },
            profileWrites: {
              success: 8,
              failure: 0,
            },
            denormJobs: {
              enqueued: 9,
              enqueueFailed: 0,
              fastPathEnqueued: 4,
              fastPathFallbacks: 0,
              fastPathReplayed: 4,
              fastPathReplayMissing: 0,
              processed: 7,
              failed: 0,
              avgAgeMs: 1_200,
              maxAgeMs: 2_400,
              lastSuccessAt: '2026-03-29T12:00:00.000Z',
              lastFailureAt: null,
            },
          },
        }),
      } as never,
      {
        getDashboardBudgetSummary: jest.fn().mockResolvedValue({
          windowSec: 600,
          backgroundShare: 0.45,
          stackLoad: {
            windowSec: 60,
            smoothedLoad: 0.52,
            peakLoad: 0.8,
            avgLoad: 0.2,
            slowThreshold: 0.35,
            pauseThreshold: 0.7,
          },
          botLoad: {
            maxSmoothedLoad: 0.24,
            maxPeakLoad: 0.4,
            slowThreshold: 0.35,
            pauseThreshold: 0.7,
            topBots: [
              {
                botId: 'id613002203036_bot',
                smoothedLoad: 0.24,
                peakLoad: 0.4,
                avgLoad: 0.1,
              },
            ],
          },
          topSources: [
            {
              sourceTag: 'managed_refresh',
              totalRequests: 150,
              avgRps: 0.25,
              peakRps: 5,
            },
          ],
          pauseReasons: [
            {
              component: 'admin-managed-refresh',
              sourceTag: 'managed_refresh',
              action: 'pause',
              reason: 'recovery window in progress',
              count: 3,
              lastObservedAt: '2026-03-29T12:00:00.000Z',
            },
          ],
        }),
      } as never,
    );

    await expect(service.getSnapshot()).resolves.toMatchObject({
      burst: {
        active: false,
        sampleAgeMs: 1200,
      },
      hotPath: {
        failOpenCount: 2,
      },
      hotChats: {
        items: [expect.objectContaining({ chatId: 'chat-1', botsSeen: 2 })],
      },
      backgroundBudget: {
        backgroundShare: 0.45,
        stackLoad: {
          windowSec: 60,
          smoothedLoad: 0.52,
        },
        botLoad: {
          topBots: [expect.objectContaining({ botId: 'id613002203036_bot' })],
        },
      },
      membershipLookup: {
        hotChannels: 1,
      },
      spammerSurfaces: {
        timings: [expect.objectContaining({ surface: 'spammer-review', stage: 'total' })],
      },
      spammerReadModel: {
        profileReads: {
          hitRate: 0.75,
        },
        shadow: {
          scoreDrift: 2,
          scoreDriftRate: 0.2,
        },
        denormJobs: {
          avgAgeMs: 1_200,
        },
      },
    });
  });

  it('adds a critical alert when webhook subscription coverage is broken', async () => {
    const service = new SystemDashboardService(
      {
        getSnapshot: jest.fn().mockResolvedValue({
          moderation: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookCritical: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookDefault: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookDefaultWorkerGroups: createDefaultWorkerGroups(),
          webhookBackground: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookLegacy: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          actions: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookEvents: {
            received: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            queued: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            failed: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
          },
          actionHealth: {
            windowSec: 60,
            total: 12,
            success: 12,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
          oldestQueuedEventId: null,
          oldestQueuedCreatedAt: null,
          oldestQueuedLagSec: 0,
          oldestReceivedEventId: null,
          oldestReceivedCreatedAt: null,
          oldestReceivedLagSec: 0,
          effectiveLagSec: 0,
          generatedAt: '2026-03-29T12:00:00.000Z',
        }),
      } as never,
      {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'normal',
          source: 'auto',
          reason: 'system healthy',
          updatedAt: '2026-03-29T12:00:00.000Z',
          manualMode: null,
          queueLagSec: 0,
          action: {
            windowSec: 60,
            total: 12,
            success: 12,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
        }),
      } as never,
      createConfigMock({ QUEUE_LAG_DEGRADE_SEC: 10 }),
      {
        getSnapshot: jest.fn().mockResolvedValue(
          createWebhookSubscriptionSnapshot({
            status: 'critical',
            actualUpdateTypes: ['message_created'],
            missingUpdateTypes: ['message_callback', 'user_added'],
            note: 'Coverage drift',
          }),
        ),
      } as never,
    );

    await expect(service.getSnapshot()).resolves.toMatchObject({
      summary: {
        status: 'critical',
      },
      alerts: expect.arrayContaining([
        expect.objectContaining({ code: 'webhook-subscription-critical', level: 'critical' }),
      ]),
    });
  });

  it('adds a warning alert when an active subscribed bot has no runtime footprint', async () => {
    const service = new SystemDashboardService(
      {
        getSnapshot: jest.fn().mockResolvedValue(createHealthyQueueSnapshot()),
      } as never,
      {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'normal',
          source: 'auto',
          reason: 'system healthy',
          updatedAt: '2026-03-29T12:00:00.000Z',
          manualMode: null,
          queueLagSec: 0,
          action: {
            windowSec: 60,
            total: 12,
            success: 12,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
        }),
      } as never,
      createConfigMock({ QUEUE_LAG_DEGRADE_SEC: 10 }),
      {
        getSnapshot: jest.fn().mockResolvedValue(
          createWebhookSubscriptionSnapshot({
            status: 'warning',
            otherSubscriptionsCount: 1,
            operationalDiagnostics: {
              warningBotCount: 1,
              warningBotIds: ['id613000010769_6_bot'],
              noActiveMembershipBotIds: ['id613000010769_6_bot'],
              noIncomingWebhookBotIds: ['id613000010769_6_bot'],
            },
            bots: {
              id613000010769_6_bot: {
                botId: 'id613000010769_6_bot',
                status: 'warning',
                configured: true,
                url: 'https://major-maksimov.ru/api/webhook/max/id613000010769_6_bot/***',
                checkedAt: '2026-03-29T12:00:00.000Z',
                reconciledAt: null,
                requiredUpdateTypes: ['message_created'],
                actualUpdateTypes: ['message_created'],
                missingUpdateTypes: [],
                extraUpdateTypes: [],
                otherSubscriptionsCount: 1,
                lastError: null,
                note: 'Активный бот id613000010769_6_bot имеет webhook subscription, но нет active chat_bot_memberships.',
                operationalDiagnostics: {
                  lifecycleState: 'active',
                  activeMemberships: 0,
                  hasCurrentSubscription: true,
                  lastIncomingWebhookAt: null,
                  lastMembershipWebhookAt: null,
                  issueCodes: ['no-active-memberships', 'no-incoming-webhooks'],
                },
              },
            },
          }),
        ),
      } as never,
    );

    await expect(service.getSnapshot()).resolves.toMatchObject({
      summary: {
        status: 'warning',
      },
      alerts: expect.arrayContaining([
        expect.objectContaining({
          code: 'webhook-operational-bot-idle',
          level: 'warning',
          detail: expect.stringContaining('id613000010769_6_bot'),
        }),
      ]),
    });
  });

  it.each([
    {
      mode: 'shadow',
      workers: ['shadow'],
      pressure: 8,
      summaryMode: 'shadow',
      recommendation: 'hold',
      alert: 'dynamic-lease-shadow',
      warning: true,
    },
    {
      mode: 'canary',
      workers: ['off'],
      pressure: 0,
      summaryMode: 'off',
      recommendation: 'hold',
      alert: null,
      warning: true,
    },
    {
      mode: 'canary',
      workers: ['off'],
      pressure: 50,
      summaryMode: 'canary',
      recommendation: 'rollback',
      alert: 'dynamic-lease-handoff',
      warning: true,
    },
    {
      mode: 'canary',
      workers: [],
      pressure: 50,
      summaryMode: 'canary',
      recommendation: 'rollback',
      alert: 'dynamic-lease-handoff',
      warning: true,
    },
    {
      mode: 'off',
      workers: ['off', 'off', 'off', 'off'],
      pressure: 50,
      summaryMode: 'canary',
      recommendation: 'hold',
      alert: null,
      warning: true,
    },
    {
      mode: 'canary',
      workers: ['canary', 'canary', 'canary', 'canary'],
      pressure: 0,
      summaryMode: 'canary',
      recommendation: 'hold',
      alert: 'dynamic-lease-handoff',
      warning: false,
    },
  ] as const)(
    'reports $mode/$recommendation with $workers and $summaryMode',
    async ({ mode, workers, pressure, summaryMode, recommendation, alert, warning }) => {
      const environment = jest.replaceProperty(process, 'env', {
        ...process.env,
        APP_SERVICE_NAME: 'api-admin',
        APP_ROLE: 'admin',
        WEBHOOK_DYNAMIC_LEASES_MODE: 'off',
      });
      const now = Date.now();
      const observation = readLeaseHeartbeats(
        DEFAULT_WEBHOOK_WORKER_GROUP_NAMES.flatMap((group, index) => {
          const workerMode: WebhookDynamicLeasesMode | undefined = workers[index];
          const value = workerMode
            ? JSON.stringify({ workerGroupName: group, mode: workerMode, updatedAtMs: now })
            : null;
          return [
            [null, value],
            [null, workerMode ? 24_000 : -2],
          ] as const;
        }),
        now,
        24_000,
      );
      try {
        const service = new SystemDashboardService(
          {
            getSnapshot: jest.fn().mockResolvedValue(
              createHealthyQueueSnapshot({
                webhookDefaultWorkerGroups: createDefaultWorkerGroups({
                  'api-moderation-realtime-b': {
                    queues: ['moderation-default-0'],
                    counters: { waiting: 50, active: 0, delayed: 0, failed: 0, completed: 0 },
                  },
                }),
                webhookDynamicLeases: {
                  mode: summaryMode,
                  generatedAt: new Date(now).toISOString(),
                  liveWorkerGroups: [
                    'api-moderation',
                    'api-moderation-realtime-b',
                    'api-moderation-realtime-c',
                    'api-moderation-realtime-d',
                  ],
                  queues: {
                    'moderation-default-0': {
                      homeOwner: 'api-moderation',
                      actualOwner: 'api-moderation',
                      desiredOwner: 'api-moderation-realtime-b',
                      eligibleForDynamicLeases: true,
                      handoffPending: true,
                      activeJobs: 0,
                      pressure,
                      reason: 'rebalance-least-loaded',
                      claimFencingToken: null,
                      claimLeaseUntil: null,
                      lastHandoffAt: null,
                    },
                  },
                },
              }),
            ),
          } as never,
          {
            getEffectiveSnapshot: jest.fn().mockResolvedValue({
              mode: 'normal',
              source: 'auto',
              reason: 'system healthy',
              updatedAt: '2026-03-31T00:00:00.000Z',
              manualMode: null,
              queueLagSec: 0,
              action: {
                windowSec: 60,
                total: 12,
                success: 12,
                failure: 0,
                critical: 0,
                errorRate: 0,
                criticalRate: 0,
              },
            }),
          } as never,
          createConfigMock({ QUEUE_LAG_DEGRADE_SEC: 10 }),
          {
            getSnapshot: jest.fn().mockResolvedValue(createWebhookSubscriptionSnapshot()),
          } as never,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          { getHeartbeatObservation: async () => ({ ...observation, summaryTtlMs: 20_000 }) },
        );
        const result = await service.getSnapshot();
        expect(result.runtimeProfile).toMatchObject({
          serviceName: 'api-admin',
          dynamicLeasesMode: 'off',
        });
        expect(result.canaryState).toMatchObject({
          mode,
          recommendation,
          liveWorkerGroups: [...DEFAULT_WEBHOOK_WORKER_GROUP_NAMES].slice(0, workers.length),
        });
        if (mode === 'off') {
          expect(result.queues.webhookDynamicLeases).toBeNull();
          expect(result.queues.webhookDefaultWorkerGroups).toEqual({});
          expect(result.alerts.some((entry) => entry.code === 'default-worker-skew')).toBe(false);
        } else {
          expect(result.queues.webhookDynamicLeases).toMatchObject({
            liveWorkerGroups: result.canaryState?.liveWorkerGroups,
          });
          expect(result.alerts.some((entry) => entry.code === 'default-worker-skew')).toBe(true);
        }
        expect(result.alerts.some((entry) => entry.code === 'dynamic-lease-worker-pool')).toBe(
          warning,
        );
        if (alert)
          expect(result.alerts).toEqual(
            expect.arrayContaining([expect.objectContaining({ code: alert, level: 'info' })]),
          );
        else
          expect(
            result.alerts.some(
              (entry) =>
                entry.code === 'dynamic-lease-handoff' || entry.code === 'dynamic-lease-shadow',
            ),
          ).toBe(false);
        expect(JSON.stringify(result)).not.toMatch(/summaryTtlMs|expiresAtMs|unreadable/);
      } finally {
        environment.restore();
      }
    },
  );

  it('surfaces ownership foundation gaps as rollout guidance without marking runtime unhealthy', async () => {
    const service = new SystemDashboardService(
      {
        getSnapshot: jest.fn().mockResolvedValue({
          moderation: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookCritical: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookDefault: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookDefaultWorkerGroups: createDefaultWorkerGroups(),
          webhookBackground: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookLegacy: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          actions: { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 },
          webhookEvents: {
            received: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            queued: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
            failed: { count: 0, oldestEventId: null, oldestCreatedAt: null, oldestLagSec: 0 },
          },
          actionHealth: {
            windowSec: 60,
            total: 12,
            success: 12,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
          oldestQueuedEventId: null,
          oldestQueuedCreatedAt: null,
          oldestQueuedLagSec: 0,
          oldestReceivedEventId: null,
          oldestReceivedCreatedAt: null,
          oldestReceivedLagSec: 0,
          effectiveLagSec: 0,
          generatedAt: '2026-03-31T00:10:00.000Z',
        }),
      } as never,
      {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'normal',
          source: 'auto',
          reason: 'system healthy',
          updatedAt: '2026-03-31T00:10:00.000Z',
          manualMode: null,
          queueLagSec: 0,
          action: {
            windowSec: 60,
            total: 12,
            success: 12,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
        }),
      } as never,
      createConfigMock({ QUEUE_LAG_DEGRADE_SEC: 10 }),
      {
        getSnapshot: jest.fn().mockResolvedValue(createWebhookSubscriptionSnapshot()),
      } as never,
      {
        getSnapshot: jest.fn().mockResolvedValue({
          generatedAt: '2026-03-31T00:10:00.000Z',
          bots: {
            configured: 2,
            adminVisible: 2,
            active: 1,
            dormant: 1,
            draining: 0,
            disabled: 0,
          },
          entities: {
            total: { total: 100, withPrimary: 72, withoutPrimary: 28, coverageRatio: 0.72 },
            chats: { total: 90, withPrimary: 66, withoutPrimary: 24, coverageRatio: 0.7333 },
            channels: { total: 10, withPrimary: 6, withoutPrimary: 4, coverageRatio: 0.6 },
          },
          anomalies: {
            noPrimary: 26,
            recoverableLegacyOnly: 2,
            recoverableFromMemberships: 1,
            noEligibleBot: 0,
            unbound: 23,
            primaryBotUnknown: 0,
            legacyBotUnknown: 0,
            activeMembershipBotUnknown: 0,
            primaryWithoutActiveMembership: 0,
            primaryWithoutAdminAccess: 0,
            sharedChats: 0,
          },
          repair: {
            enabled: true,
            activeOnThisRole: true,
            intervalMs: 300_000,
            rebalanceMode: 'shadow',
            rebalanceCanaryPercent: 1,
            rebalanceMaxMovesPerRun: 25,
            recommendedMoves: 18,
            lastAppliedMoves: 0,
            lastRunAt: '2026-03-31T00:10:00.000Z',
            lastSuccessAt: '2026-03-31T00:10:00.000Z',
            lastError: null,
            lastAppliedChanges: 3,
            totalAppliedChanges: 12,
          },
        }),
      } as never,
    );

    await expect(service.getSnapshot()).resolves.toMatchObject({
      summary: {
        status: 'healthy',
      },
      alerts: expect.arrayContaining([
        expect.objectContaining({ code: 'ownership-foundation', level: 'warning' }),
      ]),
      ownership: expect.objectContaining({
        entities: expect.objectContaining({
          total: expect.objectContaining({ withoutPrimary: 28 }),
        }),
      }),
    });
  });

  it('surfaces auxiliary queue groups without treating scheduled delayed jobs as dashboard warnings', async () => {
    const service = new SystemDashboardService(
      {
        getSnapshot: jest.fn().mockResolvedValue(
          createHealthyQueueSnapshot({
            auxiliaryQueues: {
              'night-mode-transitions': {
                waiting: 0,
                prioritized: 0,
                active: 0,
                delayed: 3073,
                failed: 0,
                completed: 120,
              },
            },
          }),
        ),
      } as never,
      {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'normal',
          source: 'auto',
          reason: 'system healthy',
          updatedAt: '2026-03-29T12:00:00.000Z',
          manualMode: null,
          queueLagSec: 0,
          action: {
            windowSec: 60,
            total: 12,
            success: 12,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
        }),
      } as never,
      createConfigMock({ QUEUE_LAG_DEGRADE_SEC: 10 }),
      {
        getSnapshot: jest.fn().mockResolvedValue(createWebhookSubscriptionSnapshot()),
      } as never,
    );

    await expect(service.getSnapshot()).resolves.toMatchObject({
      summary: {
        status: 'healthy',
      },
      queues: {
        auxiliaryQueues: {
          'night-mode-transitions': {
            delayed: 3073,
          },
        },
      },
      queueGroupHealth: {
        status: 'healthy',
        groups: expect.arrayContaining([
          expect.objectContaining({
            name: 'aux:night-mode-transitions',
            delayed: 3073,
            pressure: 0,
            status: 'healthy',
          }),
        ]),
      },
    });
  });

  it('surfaces webhook enqueue SLO details in dashboard aliases and alert detail', async () => {
    const webhookSlo = {
      status: 'warning' as const,
      windowSec: 900,
      targetProcessingMs: 400,
      totalEvents: 12,
      processedEvents: 12,
      failedEvents: 0,
      sampledProcessedEvents: 12,
      p95ProcessingMs: 420,
      p99ProcessingMs: 650,
      underTargetRatio: 0.917,
      oldestUnprocessedLagSec: 0,
      oldestUnprocessedEventId: null,
      lastProcessedAt: '2026-03-31T00:10:00.000Z',
      ingress: {
        available: true,
        targetMs: 2_000,
        attemptedReceipts: 13,
        persistedReceipts: 12,
        failedReceipts: 1,
        rejectedReceipts: 0,
        sampledReceipts: 12,
        p95LatencyMs: 1_500,
        p99LatencyMs: 2_000,
        underTargetRatio: 1,
        bots: {},
        route: {
          attemptedRequests: 20,
          outcomes: {
            accepted: 12,
            authentication_rejected: 2,
            admission_rejected: 1,
            invalid_json: 1,
            invalid_payload: 1,
            payload_too_large: 1,
            timed_out: 1,
            failed: 1,
          },
          bots: {},
        },
      },
      enqueue: {
        targetMs: 1_000,
        sampledEvents: 12,
        p95LatencyMs: 1_800,
        p99LatencyMs: 2_100,
        underTargetRatio: 0.833,
        oldestPendingLagSec: 7.5,
        oldestPendingEventId: 'evt-pending-enqueue',
        lastQueuedAt: '2026-03-31T00:09:59.000Z',
      },
      canonicalExecution: {
        receipts: 12,
        executionClaims: 7,
        claimsPerReceiptRatio: 0.583,
      },
      generatedAt: '2026-03-31T00:10:00.000Z',
    };
    const service = new SystemDashboardService(
      {
        getSnapshot: jest.fn().mockResolvedValue(createHealthyQueueSnapshot()),
      } as never,
      {
        getEffectiveSnapshot: jest.fn().mockResolvedValue({
          mode: 'normal',
          source: 'auto',
          reason: 'system healthy',
          updatedAt: '2026-03-31T00:10:00.000Z',
          manualMode: null,
          queueLagSec: 0,
          action: {
            windowSec: 60,
            total: 12,
            success: 12,
            failure: 0,
            critical: 0,
            errorRate: 0,
            criticalRate: 0,
          },
        }),
      } as never,
      createConfigMock({ QUEUE_LAG_DEGRADE_SEC: 10 }),
      {
        getSnapshot: jest.fn().mockResolvedValue(createWebhookSubscriptionSnapshot()),
      } as never,
      undefined,
      undefined,
      undefined,
      {
        getSnapshot: jest.fn().mockResolvedValue(webhookSlo),
      } as never,
    );

    await expect(service.getSnapshot()).resolves.toMatchObject({
      summary: {
        status: 'warning',
      },
      alerts: expect.arrayContaining([
        expect.objectContaining({
          code: 'webhook-slo',
          level: 'warning',
          detail: expect.stringMatching(
            /ingress available.*receipt capacity rejects 0; route attempts 20 \[accepted 12, auth rejected 2, admission rejected 1, invalid JSON 1, invalid payload 1, oversized 1, timed out 1, failed 1\].*enqueue p95 1800 мс.*receipts\/EXECUTION claims 12\/7/u,
          ),
        }),
      ]),
      webhookSlo: {
        enqueue: {
          p95LatencyMs: 1_800,
          oldestPendingEventId: 'evt-pending-enqueue',
        },
        ingress: {
          p99LatencyMs: 2_000,
          failedReceipts: 1,
        },
        canonicalExecution: {
          receipts: 12,
          executionClaims: 7,
        },
      },
      slo: {
        enqueue: {
          p95LatencyMs: 1_800,
          oldestPendingEventId: 'evt-pending-enqueue',
        },
      },
    });
  });

  it('explains a webhook SLO alert caused only by detached cache failures', () => {
    const service = Object.create(SystemDashboardService.prototype) as SystemDashboardService;
    const buildWebhookSloAlert = (
      service as unknown as {
        buildWebhookSloAlert(snapshot: unknown): { detail: string } | null;
      }
    ).buildWebhookSloAlert.bind(service);

    const alert = buildWebhookSloAlert({
      status: 'warning',
      underTargetRatio: 1,
      p95ProcessingMs: 100,
      p99ProcessingMs: 150,
      failedEvents: 0,
      oldestUnprocessedLagSec: 0,
      ingress: {
        available: true,
        p95LatencyMs: 100,
        p99LatencyMs: 150,
        underTargetRatio: 1,
        failedReceipts: 0,
        rejectedReceipts: 0,
        membershipCache: {
          lua: { timing: { p95DurationMs: 10 } },
          budget: { timing: { p95DurationMs: 20 } },
          detached: {
            completed: 17,
            timeout: 0,
            failure: 2,
            rejected: 1,
            peakInFlight: 64,
          },
        },
      },
      membershipCache: {
        status: 'warning',
        precheckFailOpen: { ratio: 0 },
        luaConflict: { ratio: 0 },
        luaTerminalFailure: { ratio: 0 },
        budgetTimeout: { ratio: 0 },
        detachedFailure: { ratio: 0.15 },
      },
      canonicalExecution: {
        receipts: 20,
        executionClaims: 20,
        claimsPerReceiptRatio: 1,
      },
    });

    expect(alert?.detail).toContain('detached failures/rejections 15.0%');
    expect(alert?.detail).toContain('failed 2, rejected 1, completed 17, peak in-flight 64');
  });

  it('raises an explicit critical alert when the action ledger watchdog quarantines an action', () => {
    const service = new SystemDashboardService(
      {} as never,
      {} as never,
      createConfigMock({ QUEUE_LAG_DEGRADE_SEC: 10 }),
    );
    const subject = service as unknown as {
      buildActionLedgerWatchdogAlert: (snapshot: unknown) => {
        code: string;
        level: string;
        detail: string;
      } | null;
      resolveStatus: (input: Record<string, unknown>) => string;
    };

    const alert = subject.buildActionLedgerWatchdogAlert({
      enabled: true,
      activeOnThisRole: true,
      staleAfterSec: 300,
      intervalSec: 60,
      lastRunAt: '2026-07-11T00:00:00.000Z',
      lastSuccessAt: '2026-07-11T00:00:01.000Z',
      lastError: null,
      lastRunReason: 'scheduled',
      staleCount: 1,
      staleEnqueuedCount: 0,
      staleInProgressCount: 1,
      oldestStaleAgeSec: 601,
      lastScannedCount: 1,
      lastReconciledCount: 1,
      lastQuarantinedCount: 1,
      lastTerminalFailedCount: 0,
      lastRecoveredSucceededCount: 0,
      lastDeferredCount: 0,
      lastConflictCount: 0,
      lastScanTruncated: false,
      generatedAt: '2026-07-11T00:00:02.000Z',
    });

    expect(alert).toEqual(
      expect.objectContaining({
        code: 'action-ledger-watchdog-quarantine',
        level: 'critical',
        detail: expect.stringContaining('quarantined 1'),
      }),
    );
    expect(
      subject.resolveStatus({
        mode: 'normal',
        queueLagSec: 0,
        failedCount: 0,
        criticalRate: 0,
        errorRate: 0,
        webhookSubscriptionStatus: 'healthy',
        actionLedgerWatchdogCritical: true,
      }),
    ).toBe('critical');
  });

  it('raises a critical alert for a sustained critical action lane backlog', () => {
    const service = new SystemDashboardService(
      {} as never,
      {} as never,
      createConfigMock({ QUEUE_LAG_DEGRADE_SEC: 10 }),
    );
    const subject = service as unknown as {
      buildActionQueueLaneAlert: (snapshot: unknown) => {
        code: string;
        level: string;
        detail: string;
      } | null;
      resolveStatus: (input: Record<string, unknown>) => string;
    };
    const counters = {
      prioritized: 0,
      active: 0,
      delayed: 0,
      failed: 0,
      completed: 0,
    };

    const alert = subject.buildActionQueueLaneAlert({
      [MAX_ACTION_LEGACY_QUEUE]: { ...counters, waiting: 0 },
      [MAX_ACTION_CRITICAL_QUEUE]: { ...counters, waiting: 6 },
      [MAX_ACTION_INTERACTIVE_QUEUE]: { ...counters, waiting: 2 },
      [MAX_ACTION_BACKGROUND_QUEUE]: { ...counters, waiting: 20 },
    });

    expect(alert).toEqual(
      expect.objectContaining({
        code: 'action-queue-critical-backlog',
        level: 'critical',
        detail: expect.stringContaining('critical 6'),
      }),
    );
    expect(
      subject.resolveStatus({
        mode: 'normal',
        queueLagSec: 0,
        failedCount: 0,
        criticalRate: 0,
        errorRate: 0,
        webhookSubscriptionStatus: 'healthy',
        actionQueueLaneCritical: true,
      }),
    ).toBe('critical');
  });

  it('reports watchdog errors as warning alerts', () => {
    const service = new SystemDashboardService(
      {} as never,
      {} as never,
      createConfigMock({ QUEUE_LAG_DEGRADE_SEC: 10 }),
    );
    const alert = (
      service as unknown as {
        buildActionLedgerWatchdogAlert: (snapshot: unknown) => {
          code: string;
          level: string;
          detail: string;
        } | null;
      }
    ).buildActionLedgerWatchdogAlert({
      enabled: true,
      activeOnThisRole: true,
      staleAfterSec: 300,
      intervalSec: 60,
      lastRunAt: '2026-07-11T00:00:00.000Z',
      lastSuccessAt: null,
      lastError: 'redis unavailable',
      lastRunReason: 'scheduled',
      staleCount: 0,
      staleEnqueuedCount: 0,
      staleInProgressCount: 0,
      oldestStaleAgeSec: 0,
      lastScannedCount: 0,
      lastReconciledCount: 0,
      lastQuarantinedCount: 0,
      lastTerminalFailedCount: 0,
      lastRecoveredSucceededCount: 0,
      lastDeferredCount: 0,
      lastConflictCount: 0,
      lastScanTruncated: false,
      generatedAt: '2026-07-11T00:00:02.000Z',
    });

    expect(alert).toEqual(
      expect.objectContaining({
        code: 'action-ledger-watchdog',
        level: 'warning',
        detail: expect.stringContaining('redis unavailable'),
      }),
    );
  });

  it('does not treat primary bots without admin rights as ownership blockers', () => {
    const service = new SystemDashboardService(
      {} as never,
      {} as never,
      createConfigMock({ QUEUE_LAG_DEGRADE_SEC: 10 }),
    );

    const alert = (
      service as unknown as {
        buildOwnershipCoverageAlert: (ownership: unknown) => unknown;
      }
    ).buildOwnershipCoverageAlert({
      generatedAt: '2026-03-31T00:10:00.000Z',
      bots: {
        configured: 2,
        adminVisible: 2,
        active: 2,
        dormant: 0,
        draining: 0,
        disabled: 0,
      },
      entities: {
        total: { total: 100, withPrimary: 100, withoutPrimary: 0, coverageRatio: 1 },
        chats: { total: 90, withPrimary: 90, withoutPrimary: 0, coverageRatio: 1 },
        channels: { total: 10, withPrimary: 10, withoutPrimary: 0, coverageRatio: 1 },
      },
      anomalies: {
        noPrimary: 0,
        recoverableLegacyOnly: 0,
        recoverableFromMemberships: 0,
        noEligibleBot: 0,
        unbound: 0,
        primaryBotUnknown: 0,
        legacyBotUnknown: 0,
        activeMembershipBotUnknown: 0,
        primaryWithoutActiveMembership: 0,
        primaryWithoutAdminAccess: 42,
        sharedChats: 0,
      },
      repair: {
        enabled: true,
        activeOnThisRole: true,
        intervalMs: 300_000,
        rebalanceMode: 'shadow',
        rebalanceCanaryPercent: 1,
        rebalanceMaxMovesPerRun: 25,
        recommendedMoves: 0,
        lastAppliedMoves: 0,
        lastRunAt: '2026-03-31T00:10:00.000Z',
        lastSuccessAt: '2026-03-31T00:10:00.000Z',
        lastError: null,
        lastAppliedChanges: 0,
        totalAppliedChanges: 0,
      },
    });

    expect(alert).toBeNull();
  });

  it('bounds manual, due, and stale-lease reconcile risks independently', async () => {
    const queryRaw = jest.fn().mockResolvedValue([
      {
        manualBlocked: 4,
        unsafePriorDispatch: 2,
        unsafePriorProvenance: 1,
        noFreshAccess: 1,
        failedJobUnclassified: 0,
        agedDue: 3,
        staleLeases: 1,
        oldestManualBlockedAgeSec: 900,
        oldestDueAgeSec: 700,
        oldestStaleLeaseAgeSec: 120,
        manualCapped: false,
        dueCapped: true,
        staleLeaseCapped: false,
      },
    ]);
    const service = new SystemDashboardService(
      {} as never,
      {} as never,
      createConfigMock(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { $queryRaw: queryRaw } as never,
    );
    const subject = service as unknown as {
      loadNightModeReconcileRiskSnapshot(): Promise<Record<string, unknown> | null>;
      buildNightModeReconcileRiskAlert(snapshot: Record<string, unknown> | null): {
        code: string;
        level: string;
        detail: string;
      } | null;
      resolveStatus(input: Record<string, unknown>): string;
    };

    const snapshot = await subject.loadNightModeReconcileRiskSnapshot();
    const alert = subject.buildNightModeReconcileRiskAlert(snapshot);

    expect(snapshot).toEqual(
      expect.objectContaining({
        manualBlocked: 4,
        unsafePriorDispatch: 2,
        agedDue: 3,
        staleLeases: 1,
        manualCapped: false,
        dueCapped: true,
        staleLeaseCapped: false,
      }),
    );
    expect(alert).toEqual(
      expect.objectContaining({
        code: 'night-mode-transition-reconcile',
        level: 'warning',
        detail: expect.stringContaining('unsafe dispatch 2'),
      }),
    );
    expect(alert?.detail).toContain('manual blocked 4');
    expect(alert?.detail).not.toContain('manual blocked >=4');
    expect(alert?.detail).toContain('aged due >=3');
    expect(
      subject.resolveStatus({
        mode: 'normal',
        queueLagSec: 0,
        failedCount: 0,
        criticalRate: 0,
        errorRate: 0,
        webhookSubscriptionStatus: 'healthy',
        nightModeReconcileWarning: true,
      }),
    ).toBe('warning');
    const sql = (queryRaw.mock.calls[0]?.[0] as readonly string[]).join('?');
    expect(sql).toMatch(
      /WITH manual_candidates AS \([\s\S]+?LIMIT \?\s*\),\s*aged_due_candidates AS \(/u,
    );
    expect(sql).toMatch(
      /aged_due_candidates AS \([\s\S]+?LIMIT \?\s*\),\s*stale_lease_candidates AS \(/u,
    );
    expect(sql).toMatch(
      /stale_lease_candidates AS \([\s\S]+?LIMIT \?\s*\),\s*manual_summary AS \(/u,
    );
    expect(sql).toMatch(
      /manual_blocked_at" IS NOT NULL\s+AND request\."generation" = request\."manual_blocked_generation"\s+AND request\."manual_acknowledged_at" IS NULL/u,
    );
    expect(
      sql.match(/request\."generation" > request\."manual_blocked_generation"/gu),
    ).toHaveLength(2);
    expect(queryRaw.mock.calls[0]?.filter((value: unknown) => value === 1_001)).toHaveLength(3);
    expect(queryRaw.mock.calls[0]?.filter((value: unknown) => value instanceof Date)).toHaveLength(
      4,
    );

    const call = queryRaw.mock.calls[0] as unknown as [readonly string[], ...unknown[]];
    const [strings, ...values] = call;
    const postgresSql = strings
      .map((part, index) => `${part}${index < values.length ? `$${index + 1}` : ''}`)
      .join('');
    const payload = Buffer.from(
      JSON.stringify({
        sql: postgresSql,
        values: values.map((value) => (value instanceof Date ? value.toISOString() : value)),
      }),
    ).toString('base64');
    const scriptPath = join(__dirname, 'system-dashboard-night-mode-reconcile.pglite.mjs');
    const { stdout, stderr } = await execFileAsync(process.execPath, [scriptPath, payload], {
      timeout: 20_000,
      maxBuffer: 1_000_000,
    });

    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual({ ok: true });
  }, 30_000);

  it('does not apply the manual reconcile cap marker to an uncapped due snapshot', () => {
    const service = new SystemDashboardService({} as never, {} as never, createConfigMock());
    const alert = (
      service as unknown as {
        buildNightModeReconcileRiskAlert(snapshot: Record<string, unknown>): {
          detail: string;
        } | null;
      }
    ).buildNightModeReconcileRiskAlert({
      checkedAt: '2026-08-21T00:00:00.000Z',
      manualBlocked: 1_000,
      unsafePriorDispatch: 1_000,
      unsafePriorProvenance: 0,
      noFreshAccess: 0,
      failedJobUnclassified: 0,
      agedDue: 1,
      staleLeases: 0,
      oldestManualBlockedAgeSec: 900,
      oldestDueAgeSec: 120,
      oldestStaleLeaseAgeSec: 0,
      manualCapped: true,
      dueCapped: false,
      staleLeaseCapped: false,
    });

    expect(alert?.detail).toContain('manual blocked >=1000');
    expect(alert?.detail).toContain('aged due 1');
    expect(alert?.detail).not.toContain('aged due >=1');
  });

  it('reports a stale-lease cap without marking the broader due sample as capped', () => {
    const service = new SystemDashboardService({} as never, {} as never, createConfigMock());
    const alert = (
      service as unknown as {
        buildNightModeReconcileRiskAlert(snapshot: Record<string, unknown>): {
          detail: string;
        } | null;
      }
    ).buildNightModeReconcileRiskAlert({
      checkedAt: '2026-08-21T00:00:00.000Z',
      manualBlocked: 0,
      unsafePriorDispatch: 0,
      unsafePriorProvenance: 0,
      noFreshAccess: 0,
      failedJobUnclassified: 0,
      agedDue: 1_000,
      staleLeases: 1_000,
      oldestManualBlockedAgeSec: 0,
      oldestDueAgeSec: 900,
      oldestStaleLeaseAgeSec: 700,
      manualCapped: false,
      dueCapped: false,
      staleLeaseCapped: true,
    });

    expect(alert?.detail).toContain('aged due 1000');
    expect(alert?.detail).not.toContain('aged due >=1000');
    expect(alert?.detail).toContain('stale leases >=1000');
  });

  it('keeps the dashboard fail-soft when night-mode reconcile diagnostics fail', async () => {
    const service = new SystemDashboardService(
      {} as never,
      {} as never,
      createConfigMock(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { $queryRaw: jest.fn().mockRejectedValue(new Error('relation unavailable')) } as never,
    );
    const subject = service as unknown as {
      loadNightModeReconcileRiskSnapshot(): Promise<unknown>;
      buildNightModeReconcileRiskAlert(snapshot: unknown): unknown;
    };

    await expect(subject.loadNightModeReconcileRiskSnapshot()).resolves.toBeNull();
    expect(subject.buildNightModeReconcileRiskAlert(null)).toBeNull();
  });

  it('detects default worker skew from prioritized-only backlog', () => {
    const service = Object.create(SystemDashboardService.prototype) as SystemDashboardService;
    const subject = service as unknown as {
      buildDefaultWorkerSkewAlert(workerGroups: Record<string, unknown>): {
        code: string;
        level: string;
        detail: string;
      } | null;
    };

    const alert = subject.buildDefaultWorkerSkewAlert({
      'api-moderation': {
        queues: ['moderation-default-0'],
        counters: {
          waiting: 0,
          prioritized: 8,
          active: 0,
          delayed: 0,
          failed: 0,
          completed: 0,
        },
      },
    });

    expect(alert).toMatchObject({
      code: 'default-worker-skew',
      level: 'critical',
    });
    expect(alert?.detail).toContain('8 из 8 active+pending');
  });

  it('uses the structured mode condition before legacy stabilization heuristics', () => {
    const service = Object.create(SystemDashboardService.prototype) as SystemDashboardService;
    const isStabilizing = (
      service as unknown as {
        isStabilizing(mode: Record<string, unknown>, queueLagSec: number): boolean;
      }
    ).isStabilizing.bind(service);
    const healthyAction = {
      windowSec: 60,
      total: 150,
      success: 150,
      failure: 0,
      critical: 0,
      errorRate: 0,
      criticalRate: 0,
    };

    expect(
      isStabilizing(
        {
          mode: 'degrade',
          source: 'auto',
          condition: 'max_api',
          action: healthyAction,
        },
        0,
      ),
    ).toBe(false);
    expect(
      isStabilizing(
        {
          mode: 'degrade',
          source: 'auto',
          condition: 'stabilizing',
          action: healthyAction,
        },
        12,
      ),
    ).toBe(true);
  });
});
