import { MaxWebhookSubscriptionReconcilerService } from './max-webhook-subscription-reconciler.service';
import { MAX_API_SOURCE_TAGS } from './max-client.service';
import {
  MAX_BASE_REQUIRED_WEBHOOK_UPDATE_TYPES,
  MAX_REQUIRED_WEBHOOK_UPDATE_TYPES,
} from './max-webhook-subscription.constants';

describe('MaxWebhookSubscriptionReconcilerService', () => {
  const originalAppRole = process.env.APP_ROLE;

  afterEach(() => {
    if (originalAppRole === undefined) {
      delete process.env.APP_ROLE;
    } else {
      process.env.APP_ROLE = originalAppRole;
    }
    jest.clearAllMocks();
  });

  function createPrismaMock(
    params: {
      latestWebhookByBot?: Record<string, Date | null>;
      activeMembershipsByBot?: Record<string, { count: number; lastWebhookAt: Date | null }>;
    } = {},
  ) {
    const latestWebhookByBot = params.latestWebhookByBot ?? {};
    const activeMembershipsByBot = params.activeMembershipsByBot ?? {};
    return {
      chatBotMembership: {
        aggregate: jest.fn().mockResolvedValue({ _max: { lastWebhookAt: null } }),
        groupBy: jest.fn().mockImplementation((args: { where?: { status?: unknown } }) => {
          if (args.where?.status === 'ACTIVE') {
            return Promise.resolve(
              Object.entries(activeMembershipsByBot).map(([botId, value]) => ({
                botId,
                _count: { _all: value.count },
                _max: { lastWebhookAt: value.lastWebhookAt },
              })),
            );
          }

          return Promise.resolve(
            Object.entries(latestWebhookByBot)
              .filter(([, value]) => value !== null)
              .map(([botId, value]) => ({
                botId,
                _max: { lastWebhookAt: value },
              })),
          );
        }),
      },
    };
  }

  function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
      resolve = promiseResolve;
      reject = promiseReject;
    });
    return { promise, resolve, reject };
  }

  async function flushPromises() {
    await new Promise((resolve) => setImmediate(resolve));
  }

  it('survives unavailable Redis error reporting and recovers on the next scheduled check', async () => {
    process.env.APP_ROLE = 'ingress';
    jest.useFakeTimers();
    const statusService = {
      getSyncState: jest
        .fn()
        .mockRejectedValueOnce(new Error('Redis unavailable'))
        .mockResolvedValue(null),
      getSnapshot: jest.fn().mockRejectedValue(new Error('Redis unavailable')),
      writeSnapshot: jest
        .fn()
        .mockRejectedValueOnce(new Error('Redis unavailable'))
        .mockResolvedValue(undefined),
      writeSyncState: jest.fn().mockResolvedValue(undefined),
    };
    const service = new MaxWebhookSubscriptionReconcilerService(
      {} as never,
      { getAllBots: jest.fn().mockReturnValue([]) } as never,
      statusService as never,
      createPrismaMock() as never,
      { get: jest.fn((_key: string, fallback: unknown) => fallback) } as never,
    );

    try {
      await expect(service.onModuleInit()).resolves.toBeUndefined();
      expect(statusService.writeSyncState).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(60_000);

      expect(statusService.getSyncState).toHaveBeenCalledTimes(2);
      expect(statusService.writeSyncState).toHaveBeenCalledTimes(1);
      expect(statusService.writeSnapshot).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'disabled', lastError: null }),
      );
    } finally {
      await service.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('repairs missing webhook update types and stores a healthy snapshot', async () => {
    process.env.APP_ROLE = 'ingress';

    const botRegistry = {
      getAllBots: jest.fn().mockReturnValue([
        {
          id: '777000_bot',
          webhookHeaderSecrets: ['secret-header-current'],
        },
      ]),
      getDefaultBot: jest.fn().mockReturnValue({ id: '777000_bot' }),
      computeWebhookHeaderSecretFingerprint: jest.fn().mockReturnValue('fingerprint-777000_bot'),
    };
    const statusService = {
      getSyncState: jest.fn().mockResolvedValue(null),
      writeSnapshot: jest.fn().mockResolvedValue(undefined),
      writeSyncState: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn(),
    };
    const maxClient = {
      getConfiguredWebhookSubscriptionTarget: jest.fn().mockReturnValue({
        url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
        maskedUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/***',
      }),
      listWebhookSubscriptions: jest
        .fn()
        .mockResolvedValueOnce([
          {
            url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
            updateTypes: ['message_created', 'message_callback', 'user_added'],
          },
        ])
        .mockResolvedValueOnce([
          {
            url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
            updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
          },
        ]),
      matchesConfiguredWebhookUrl: jest.fn().mockImplementation((url: string) => {
        return url === 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path';
      }),
      deleteWebhookSubscription: jest.fn().mockResolvedValue(undefined),
      ensureWebhookSubscription: jest.fn().mockResolvedValue({
        url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
        updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
      }),
    };
    const service = new MaxWebhookSubscriptionReconcilerService(
      maxClient as never,
      botRegistry as never,
      statusService as never,
      createPrismaMock() as never,
      {
        get: jest.fn((key: string, fallback?: number) => {
          if (key === 'MAX_WEBHOOK_RECONCILE_INTERVAL_MS') {
            return 60_000;
          }
          return fallback;
        }),
      } as never,
    );

    await service.onModuleInit();

    expect(maxClient.ensureWebhookSubscription).toHaveBeenCalledWith(
      [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
      {
        trafficClass: 'background',
        botId: '777000_bot',
        sourceTag: MAX_API_SOURCE_TAGS.WEBHOOK_SUBSCRIPTION_RECONCILE,
        forceUpsert: true,
      },
    );
    expect(maxClient.listWebhookSubscriptions).toHaveBeenCalledTimes(2);
    expect(statusService.writeSyncState).toHaveBeenCalledWith(
      expect.objectContaining({
        bots: expect.objectContaining({
          '777000_bot': expect.objectContaining({
            configuredUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
          }),
        }),
      }),
    );
    expect(statusService.writeSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'healthy',
        configured: true,
        url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/***',
        missingUpdateTypes: [],
        actualUpdateTypes: expect.arrayContaining([...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES]),
        botCount: 1,
        bots: expect.objectContaining({
          '777000_bot': expect.objectContaining({
            configured: true,
            status: 'healthy',
          }),
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('subscribes to extended lifecycle events for observation in shadow mode', async () => {
    process.env.APP_ROLE = 'ingress';

    const botRegistry = {
      getAllBots: jest
        .fn()
        .mockReturnValue([{ id: '777000_bot', webhookHeaderSecrets: ['secret-header-current'] }]),
      getDefaultBot: jest.fn().mockReturnValue({ id: '777000_bot' }),
      computeWebhookHeaderSecretFingerprint: jest.fn().mockReturnValue('fingerprint-777000_bot'),
    };
    const statusService = {
      getSyncState: jest.fn().mockResolvedValue(null),
      writeSnapshot: jest.fn().mockResolvedValue(undefined),
      writeSyncState: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn(),
    };
    const maxClient = {
      getConfiguredWebhookSubscriptionTarget: jest.fn().mockReturnValue({
        url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
        maskedUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/***',
      }),
      listWebhookSubscriptions: jest
        .fn()
        .mockResolvedValueOnce([
          {
            url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
            updateTypes: [...MAX_BASE_REQUIRED_WEBHOOK_UPDATE_TYPES],
          },
        ])
        .mockResolvedValueOnce([
          {
            url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
            updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
          },
        ]),
      matchesConfiguredWebhookUrl: jest.fn().mockReturnValue(true),
      deleteWebhookSubscription: jest.fn(),
      ensureWebhookSubscription: jest.fn(),
    };
    const service = new MaxWebhookSubscriptionReconcilerService(
      maxClient as never,
      botRegistry as never,
      statusService as never,
      createPrismaMock() as never,
      {
        get: jest.fn((key: string, fallback?: unknown) =>
          key === 'MAX_EXTENDED_WEBHOOK_LIFECYCLE_MODE' ? 'shadow' : fallback,
        ),
      } as never,
    );

    await service.onModuleInit();

    expect(maxClient.ensureWebhookSubscription).toHaveBeenCalledWith(
      [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
      expect.objectContaining({ botId: '777000_bot' }),
    );
    expect(maxClient.deleteWebhookSubscription).not.toHaveBeenCalled();
    expect(statusService.writeSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'healthy',
        requiredUpdateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
        missingUpdateTypes: [],
      }),
    );

    await service.onModuleDestroy();
  });

  it('replaces a full lifecycle subscription with the base set when mode changes to off', async () => {
    process.env.APP_ROLE = 'ingress';

    const webhookUrl = 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path';
    const botRegistry = {
      getAllBots: jest
        .fn()
        .mockReturnValue([{ id: '777000_bot', webhookHeaderSecrets: ['secret-header-current'] }]),
      getDefaultBot: jest.fn().mockReturnValue({ id: '777000_bot' }),
      computeWebhookHeaderSecretFingerprint: jest.fn().mockReturnValue('fingerprint-777000_bot'),
    };
    const statusService = {
      getSyncState: jest.fn().mockResolvedValue(null),
      writeSnapshot: jest.fn().mockResolvedValue(undefined),
      writeSyncState: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn(),
    };
    const maxClient = {
      getConfiguredWebhookSubscriptionTarget: jest.fn().mockReturnValue({
        url: webhookUrl,
        maskedUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/***',
      }),
      listWebhookSubscriptions: jest
        .fn()
        .mockResolvedValueOnce([
          {
            url: webhookUrl,
            updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
          },
        ])
        .mockResolvedValueOnce([
          {
            url: webhookUrl,
            updateTypes: [...MAX_BASE_REQUIRED_WEBHOOK_UPDATE_TYPES],
          },
        ]),
      matchesConfiguredWebhookUrl: jest.fn().mockReturnValue(true),
      deleteWebhookSubscription: jest.fn(),
      ensureWebhookSubscription: jest.fn(),
    };
    const service = new MaxWebhookSubscriptionReconcilerService(
      maxClient as never,
      botRegistry as never,
      statusService as never,
      createPrismaMock() as never,
      {
        get: jest.fn((key: string, fallback?: unknown) =>
          key === 'MAX_EXTENDED_WEBHOOK_LIFECYCLE_MODE' ? 'off' : fallback,
        ),
      } as never,
    );

    await service.onModuleInit();

    expect(maxClient.ensureWebhookSubscription).toHaveBeenCalledWith(
      [...MAX_BASE_REQUIRED_WEBHOOK_UPDATE_TYPES],
      expect.objectContaining({
        botId: '777000_bot',
        replaceUpdateTypes: true,
      }),
    );
    expect(maxClient.deleteWebhookSubscription).not.toHaveBeenCalled();
    expect(statusService.writeSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'healthy',
        requiredUpdateTypes: [...MAX_BASE_REQUIRED_WEBHOOK_UPDATE_TYPES],
        actualUpdateTypes: [...MAX_BASE_REQUIRED_WEBHOOK_UPDATE_TYPES].sort(),
        missingUpdateTypes: [],
        extraUpdateTypes: [],
      }),
    );

    await service.onModuleDestroy();
  });

  it('reconciles multiple operational bots sequentially to avoid background MAX API bursts', async () => {
    process.env.APP_ROLE = 'ingress';

    const bots = [
      {
        id: 'first_bot',
        webhookHeaderSecrets: ['secret-header-current'],
      },
      {
        id: 'second_bot',
        webhookHeaderSecrets: ['secret-header-current'],
      },
    ];
    const botRegistry = {
      getAllBots: jest.fn().mockReturnValue(bots),
      getDefaultBot: jest.fn().mockReturnValue({ id: 'first_bot' }),
      computeWebhookHeaderSecretFingerprint: jest
        .fn()
        .mockImplementation((botId: string) => `fingerprint-${botId}`),
    };
    const statusService = {
      getSyncState: jest.fn().mockResolvedValue(null),
      writeSnapshot: jest.fn().mockResolvedValue(undefined),
      writeSyncState: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn(),
    };
    const firstListSubscriptions = createDeferred<Array<{ url: string; updateTypes: string[] }>>();
    const startedBots: string[] = [];
    const maxClient = {
      getConfiguredWebhookSubscriptionTarget: jest.fn().mockImplementation((botId: string) => ({
        url: `https://major-maksimov.ru/api/webhook/max/${botId}/secret-path`,
        maskedUrl: `https://major-maksimov.ru/api/webhook/max/${botId}/***`,
      })),
      listWebhookSubscriptions: jest.fn().mockImplementation(({ botId }: { botId: string }) => {
        startedBots.push(botId);
        if (botId === 'first_bot') {
          return firstListSubscriptions.promise;
        }
        return Promise.resolve([
          {
            url: `https://major-maksimov.ru/api/webhook/max/${botId}/secret-path`,
            updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
          },
        ]);
      }),
      matchesConfiguredWebhookUrl: jest
        .fn()
        .mockImplementation(
          (url: string, botId: string) =>
            url === `https://major-maksimov.ru/api/webhook/max/${botId}/secret-path`,
        ),
      deleteWebhookSubscription: jest.fn().mockResolvedValue(undefined),
      ensureWebhookSubscription: jest.fn().mockImplementation((updateTypes, { botId }) =>
        Promise.resolve({
          url: `https://major-maksimov.ru/api/webhook/max/${botId}/secret-path`,
          updateTypes,
        }),
      ),
    };
    const service = new MaxWebhookSubscriptionReconcilerService(
      maxClient as never,
      botRegistry as never,
      statusService as never,
      createPrismaMock({
        latestWebhookByBot: {
          first_bot: new Date('2026-07-03T12:00:00.000Z'),
          second_bot: new Date('2026-07-03T12:00:00.000Z'),
        },
        activeMembershipsByBot: {
          first_bot: { count: 1, lastWebhookAt: new Date('2026-07-03T12:00:00.000Z') },
          second_bot: { count: 1, lastWebhookAt: new Date('2026-07-03T12:00:00.000Z') },
        },
      }) as never,
      {
        get: jest.fn((key: string, fallback?: number | string) => {
          if (key === 'MAX_WEBHOOK_RECONCILE_INTERVAL_MS') {
            return 60_000;
          }
          return fallback;
        }),
      } as never,
    );

    const initPromise = service.onModuleInit();
    await flushPromises();

    expect(startedBots).toEqual(['first_bot']);
    expect(maxClient.listWebhookSubscriptions).toHaveBeenCalledTimes(1);

    firstListSubscriptions.resolve([
      {
        url: 'https://major-maksimov.ru/api/webhook/max/first_bot/secret-path',
        updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
      },
    ]);
    await initPromise;

    expect(startedBots).toEqual(['first_bot', 'first_bot', 'second_bot', 'second_bot']);
    expect(maxClient.listWebhookSubscriptions).toHaveBeenCalledTimes(4);
    expect(statusService.writeSyncState).toHaveBeenCalledWith(
      expect.objectContaining({
        bots: expect.objectContaining({
          first_bot: expect.any(Object),
          second_bot: expect.any(Object),
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('continues after one bot subscription reconcile fails and preserves its last known state', async () => {
    process.env.APP_ROLE = 'ingress';

    const firstBotUrl = 'https://major-maksimov.ru/api/webhook/max/first_bot/secret-path';
    const secondBotUrl = 'https://major-maksimov.ru/api/webhook/max/second_bot/secret-path';
    const firstBotSyncState = {
      configuredUrl: firstBotUrl,
      headerSecretFingerprint: 'fingerprint-first_bot',
      updatedAt: '2026-07-10T09:00:00.000Z',
      lastIncomingWebhookAt: '2026-07-10T09:05:00.000Z',
      lastAutoRecreateAt: '2026-07-10T09:01:00.000Z',
    };
    const firstBotSnapshot = {
      botId: 'first_bot',
      status: 'healthy' as const,
      configured: true,
      url: 'https://major-maksimov.ru/api/webhook/max/first_bot/***',
      checkedAt: '2026-07-10T09:00:00.000Z',
      reconciledAt: '2026-07-10T09:00:00.000Z',
      requiredUpdateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
      actualUpdateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
      missingUpdateTypes: [],
      extraUpdateTypes: [],
      otherSubscriptionsCount: 0,
      lastError: null,
      note: 'Webhook coverage was healthy before the failed reconcile.',
    };
    const botRegistry = {
      getAllBots: jest.fn().mockReturnValue([
        { id: 'first_bot', webhookHeaderSecrets: ['first-secret'] },
        { id: 'second_bot', webhookHeaderSecrets: ['second-secret'] },
      ]),
      getDefaultBot: jest.fn().mockReturnValue({ id: 'first_bot' }),
      computeWebhookHeaderSecretFingerprint: jest
        .fn()
        .mockImplementation((botId: string) => `fingerprint-${botId}`),
    };
    const statusService = {
      getSyncState: jest.fn().mockResolvedValue({
        bots: { first_bot: firstBotSyncState },
        lastGlobalIncomingWebhookAt: firstBotSyncState.lastIncomingWebhookAt,
        lastGlobalAutoRecreateAt: firstBotSyncState.lastAutoRecreateAt,
      }),
      getSnapshot: jest.fn().mockResolvedValue({
        bots: { first_bot: firstBotSnapshot },
      }),
      writeSnapshot: jest.fn().mockResolvedValue(undefined),
      writeSyncState: jest.fn().mockResolvedValue(undefined),
    };
    let secondBotListCalls = 0;
    const maxClient = {
      getConfiguredWebhookSubscriptionTarget: jest.fn().mockImplementation((botId: string) => ({
        url: botId === 'first_bot' ? firstBotUrl : secondBotUrl,
        maskedUrl: `https://major-maksimov.ru/api/webhook/max/${botId}/***`,
      })),
      listWebhookSubscriptions: jest.fn().mockImplementation(({ botId }: { botId: string }) => {
        if (botId === 'first_bot') {
          return Promise.reject(new Error('MAX subscriptions endpoint unavailable'));
        }

        secondBotListCalls += 1;
        return Promise.resolve([
          {
            url: secondBotUrl,
            updateTypes:
              secondBotListCalls === 1
                ? MAX_REQUIRED_WEBHOOK_UPDATE_TYPES.slice(0, -1)
                : [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
          },
        ]);
      }),
      matchesConfiguredWebhookUrl: jest
        .fn()
        .mockImplementation(
          (url: string, botId: string) =>
            url === (botId === 'first_bot' ? firstBotUrl : secondBotUrl),
        ),
      deleteWebhookSubscription: jest.fn().mockResolvedValue(undefined),
      ensureWebhookSubscription: jest.fn().mockResolvedValue(undefined),
    };
    const service = new MaxWebhookSubscriptionReconcilerService(
      maxClient as never,
      botRegistry as never,
      statusService as never,
      createPrismaMock() as never,
      {
        get: jest.fn((key: string, fallback?: number) => {
          if (key === 'MAX_WEBHOOK_RECONCILE_INTERVAL_MS') {
            return 60_000;
          }
          return fallback;
        }),
      } as never,
    );

    await service.onModuleInit();

    expect(maxClient.listWebhookSubscriptions).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'second_bot' }),
    );
    expect(maxClient.ensureWebhookSubscription).toHaveBeenCalledWith(
      [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
      expect.objectContaining({ botId: 'second_bot' }),
    );
    expect(statusService.writeSyncState).toHaveBeenCalledWith(
      expect.objectContaining({
        bots: expect.objectContaining({
          first_bot: firstBotSyncState,
          second_bot: expect.objectContaining({
            configuredUrl: secondBotUrl,
            headerSecretFingerprint: 'fingerprint-second_bot',
          }),
        }),
      }),
    );
    expect(statusService.writeSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'warning',
        lastError: 'Не удалось синхронизировать webhook subscription для first_bot (Error).',
        note: expect.stringContaining('first_bot'),
        bots: expect.objectContaining({
          first_bot: expect.objectContaining({
            status: 'warning',
            url: firstBotSnapshot.url,
            actualUpdateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
            lastError: 'Не удалось синхронизировать webhook subscription для first_bot (Error).',
          }),
          second_bot: expect.objectContaining({ status: 'healthy', lastError: null }),
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('marks an active bot with a subscription but no memberships or incoming webhook as warning', async () => {
    process.env.APP_ROLE = 'ingress';

    const botRegistry = {
      getAllBots: jest.fn().mockReturnValue([
        {
          id: 'idle_bot',
          state: 'active',
          webhookHeaderSecrets: ['secret-header-current'],
        },
      ]),
      getDefaultBot: jest.fn().mockReturnValue({ id: 'idle_bot' }),
      computeWebhookHeaderSecretFingerprint: jest.fn().mockReturnValue('fingerprint-idle_bot'),
    };
    const statusService = {
      getSyncState: jest.fn().mockResolvedValue({
        bots: {},
        lastGlobalIncomingWebhookAt: null,
        lastGlobalAutoRecreateAt: null,
      }),
      writeSnapshot: jest.fn().mockResolvedValue(undefined),
      writeSyncState: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn(),
    };
    const maxClient = {
      getConfiguredWebhookSubscriptionTarget: jest.fn().mockReturnValue({
        url: 'https://major-maksimov.ru/api/webhook/max/idle_bot/secret-path',
        maskedUrl: 'https://major-maksimov.ru/api/webhook/max/idle_bot/***',
      }),
      listWebhookSubscriptions: jest.fn().mockResolvedValue([
        {
          url: 'https://major-maksimov.ru/api/webhook/max/idle_bot/secret-path',
          updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
        },
      ]),
      matchesConfiguredWebhookUrl: jest.fn().mockImplementation((url: string) => {
        return url === 'https://major-maksimov.ru/api/webhook/max/idle_bot/secret-path';
      }),
      deleteWebhookSubscription: jest.fn().mockResolvedValue(undefined),
      ensureWebhookSubscription: jest.fn().mockResolvedValue({
        url: 'https://major-maksimov.ru/api/webhook/max/idle_bot/secret-path',
        updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
      }),
    };
    const service = new MaxWebhookSubscriptionReconcilerService(
      maxClient as never,
      botRegistry as never,
      statusService as never,
      createPrismaMock() as never,
      {
        get: jest.fn((key: string, fallback?: number) => {
          if (key === 'MAX_WEBHOOK_RECONCILE_INTERVAL_MS') {
            return 60_000;
          }
          return fallback;
        }),
      } as never,
    );

    await service.onModuleInit();

    expect(maxClient.deleteWebhookSubscription).not.toHaveBeenCalled();
    expect(maxClient.ensureWebhookSubscription).toHaveBeenCalledWith(
      [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
      expect.objectContaining({ botId: 'idle_bot', forceUpsert: true }),
    );
    expect(statusService.writeSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'warning',
        operationalDiagnostics: {
          warningBotCount: 1,
          warningBotIds: ['idle_bot'],
          noActiveMembershipBotIds: ['idle_bot'],
          noIncomingWebhookBotIds: ['idle_bot'],
        },
        bots: expect.objectContaining({
          idle_bot: expect.objectContaining({
            status: 'warning',
            operationalDiagnostics: {
              lifecycleState: 'active',
              activeMemberships: 0,
              hasCurrentSubscription: true,
              lastIncomingWebhookAt: null,
              lastMembershipWebhookAt: null,
              issueCodes: ['no-active-memberships', 'no-incoming-webhooks'],
            },
            note: expect.stringContaining('нет active chat_bot_memberships'),
          }),
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('preserves foreign-origin subscriptions when sync-state lost the previous URL', async () => {
    process.env.APP_ROLE = 'ingress';

    const botRegistry = {
      getAllBots: jest.fn().mockReturnValue([
        {
          id: '777000_bot',
          webhookHeaderSecrets: ['secret-header-current'],
        },
      ]),
      getDefaultBot: jest.fn().mockReturnValue({ id: '777000_bot' }),
      computeWebhookHeaderSecretFingerprint: jest.fn().mockReturnValue('fingerprint-777000_bot'),
    };
    const statusService = {
      getSyncState: jest.fn().mockResolvedValue(null),
      writeSnapshot: jest.fn().mockResolvedValue(undefined),
      writeSyncState: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn(),
    };
    const maxClient = {
      getConfiguredWebhookSubscriptionTarget: jest.fn().mockReturnValue({
        url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
        maskedUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/***',
      }),
      listWebhookSubscriptions: jest
        .fn()
        .mockResolvedValueOnce([
          {
            url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
            updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
          },
          {
            url: 'https://hook.maxim.play-team.ru/api/webhook/max/777000_bot/old-secret',
            updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
          },
          {
            url: 'https://example.test/third-party/webhook',
            updateTypes: ['message_created'],
          },
        ])
        .mockResolvedValueOnce([
          {
            url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
            updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
          },
          {
            url: 'https://hook.maxim.play-team.ru/api/webhook/max/777000_bot/old-secret',
            updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
          },
          {
            url: 'https://example.test/third-party/webhook',
            updateTypes: ['message_created'],
          },
        ]),
      matchesConfiguredWebhookUrl: jest.fn().mockImplementation((url: string) => {
        return url === 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path';
      }),
      deleteWebhookSubscription: jest.fn().mockResolvedValue(undefined),
      ensureWebhookSubscription: jest.fn().mockResolvedValue({
        url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
        updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
      }),
    };
    const service = new MaxWebhookSubscriptionReconcilerService(
      maxClient as never,
      botRegistry as never,
      statusService as never,
      createPrismaMock() as never,
      {
        get: jest.fn((key: string, fallback?: number) => {
          if (key === 'MAX_WEBHOOK_RECONCILE_INTERVAL_MS') {
            return 60_000;
          }
          return fallback;
        }),
      } as never,
    );

    await service.onModuleInit();

    expect(maxClient.ensureWebhookSubscription).toHaveBeenCalledWith(
      [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
      expect.objectContaining({ botId: '777000_bot', forceUpsert: true }),
    );
    expect(maxClient.deleteWebhookSubscription).not.toHaveBeenCalled();
    expect(maxClient.listWebhookSubscriptions).toHaveBeenCalledTimes(2);
    expect(statusService.writeSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'warning',
        otherSubscriptionsCount: 2,
        bots: expect.objectContaining({
          '777000_bot': expect.objectContaining({
            otherSubscriptionsCount: 2,
          }),
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it.each(['missing', 'incomplete', 'unavailable'] as const)(
    'retains the old subscription when the new target is %s after an upsert',
    async (condition) => {
      process.env.APP_ROLE = 'ingress';
      const botId = '777000_bot';
      const oldUrl = `https://old.example/api/webhook/max/${botId}/old-secret`;
      const targetUrl = `https://major-maksimov.ru/api/webhook/max/${botId}/new-secret`;
      const previous = {
        configuredUrl: oldUrl,
        headerSecretFingerprint: 'old-fingerprint',
        updatedAt: '2026-03-30T00:00:00.000Z',
        lastIncomingWebhookAt: null,
        lastAutoRecreateAt: null,
      };
      const statusService = {
        getSyncState: jest.fn().mockResolvedValue({ bots: { [botId]: previous } }),
        getSnapshot: jest.fn().mockResolvedValue(null),
        writeSyncState: jest.fn().mockResolvedValue(undefined),
        writeSnapshot: jest.fn().mockResolvedValue(undefined),
      };
      const list = jest
        .fn()
        .mockResolvedValueOnce([
          { url: oldUrl, updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES] },
        ]);
      if (condition === 'unavailable') list.mockRejectedValueOnce(new Error('unavailable'));
      else
        list.mockResolvedValueOnce(
          condition === 'missing'
            ? []
            : [{ url: targetUrl, updateTypes: MAX_REQUIRED_WEBHOOK_UPDATE_TYPES.slice(1) }],
        );
      const maxClient = {
        getConfiguredWebhookSubscriptionTarget: jest
          .fn()
          .mockReturnValue({ url: targetUrl, maskedUrl: 'masked' }),
        listWebhookSubscriptions: list,
        matchesConfiguredWebhookUrl: jest.fn((url: string) => url === targetUrl),
        ensureWebhookSubscription: jest.fn().mockResolvedValue({
          url: targetUrl,
          updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
        }),
        deleteWebhookSubscription: jest.fn(),
      };
      const registry = {
        getAllBots: jest
          .fn()
          .mockReturnValue([{ id: botId, webhookHeaderSecrets: ['new-secret'] }]),
        getDefaultBot: jest.fn().mockReturnValue({ id: botId }),
        computeWebhookHeaderSecretFingerprint: jest.fn().mockReturnValue('new-fingerprint'),
      };
      const service = new MaxWebhookSubscriptionReconcilerService(
        maxClient as never,
        registry as never,
        statusService as never,
        createPrismaMock() as never,
        { get: jest.fn((_: string, fallback?: unknown) => fallback) } as never,
      );
      await service.onModuleInit();
      expect(maxClient.ensureWebhookSubscription).toHaveBeenCalledTimes(1);
      expect(maxClient.ensureWebhookSubscription).toHaveBeenCalledWith(
        [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
        expect.objectContaining({ botId, forceUpsert: true }),
      );
      expect(maxClient.deleteWebhookSubscription).not.toHaveBeenCalled();
      expect(statusService.writeSyncState).toHaveBeenCalledWith(
        expect.objectContaining({
          bots: expect.objectContaining({ [botId]: expect.objectContaining(previous) }),
        }),
      );
      expect(statusService.writeSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          bots: expect.objectContaining({
            [botId]: expect.objectContaining({ status: 'warning' }),
          }),
        }),
      );
      await service.onModuleDestroy();
    },
  );

  it('removes a recorded previous host only after the new subscription is confirmed', async () => {
    process.env.APP_ROLE = 'ingress';
    const botId = '777000_bot';
    const oldUrl = `https://old.example/api/webhook/max/${botId}/old-secret`;
    const foreignUrl = `https://foreign.example/api/webhook/max/${botId}/foreign-secret`;
    const targetUrl = `https://major-maksimov.ru/api/webhook/max/${botId}/new-secret`;
    const full = (url: string) => ({ url, updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES] });
    const statusService = {
      getSyncState: jest.fn().mockResolvedValue({
        bots: {
          [botId]: {
            configuredUrl: oldUrl,
            headerSecretFingerprint: 'old',
            updatedAt: '2026-03-30T00:00:00.000Z',
            lastIncomingWebhookAt: null,
            lastAutoRecreateAt: null,
          },
        },
      }),
      getSnapshot: jest.fn().mockResolvedValue(null),
      writeSyncState: jest.fn().mockResolvedValue(undefined),
      writeSnapshot: jest.fn().mockResolvedValue(undefined),
    };
    const maxClient = {
      getConfiguredWebhookSubscriptionTarget: jest
        .fn()
        .mockReturnValue({ url: targetUrl, maskedUrl: 'masked' }),
      listWebhookSubscriptions: jest
        .fn()
        .mockResolvedValueOnce([full(oldUrl), full(foreignUrl)])
        .mockResolvedValueOnce([full(oldUrl), full(foreignUrl), full(targetUrl)])
        .mockResolvedValueOnce([full(foreignUrl), full(targetUrl)]),
      matchesConfiguredWebhookUrl: jest.fn((url: string) => url === targetUrl),
      ensureWebhookSubscription: jest.fn().mockResolvedValue(full(targetUrl)),
      deleteWebhookSubscription: jest.fn().mockResolvedValue(undefined),
    };
    const registry = {
      getAllBots: jest.fn().mockReturnValue([{ id: botId, webhookHeaderSecrets: ['new-secret'] }]),
      getDefaultBot: jest.fn().mockReturnValue({ id: botId }),
      computeWebhookHeaderSecretFingerprint: jest.fn().mockReturnValue('new'),
    };
    const service = new MaxWebhookSubscriptionReconcilerService(
      maxClient as never,
      registry as never,
      statusService as never,
      createPrismaMock() as never,
      { get: jest.fn((_: string, fallback?: unknown) => fallback) } as never,
    );
    await service.onModuleInit();
    expect(maxClient.deleteWebhookSubscription).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteWebhookSubscription).toHaveBeenCalledWith(
      oldUrl,
      expect.objectContaining({ botId }),
    );
    expect(maxClient.listWebhookSubscriptions.mock.invocationCallOrder[1]).toBeLessThan(
      maxClient.deleteWebhookSubscription.mock.invocationCallOrder[0]!,
    );
    await service.onModuleDestroy();
  });

  it('upserts the secret when its applied fingerprint is unknown, then retains the verified fingerprint', async () => {
    process.env.APP_ROLE = 'ingress';
    const botId = '777000_bot';
    const url = `https://major-maksimov.ru/api/webhook/max/${botId}/secret-path`;
    let savedState: unknown = null;
    const statusService = {
      getSyncState: jest.fn(async () => savedState),
      writeSyncState: jest.fn(async (value: unknown) => {
        savedState = value;
      }),
      writeSnapshot: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn().mockResolvedValue(null),
    };
    const maxClient = {
      getConfiguredWebhookSubscriptionTarget: jest
        .fn()
        .mockReturnValue({ url, maskedUrl: 'masked' }),
      listWebhookSubscriptions: jest
        .fn()
        .mockResolvedValue([{ url, updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES] }]),
      matchesConfiguredWebhookUrl: jest.fn((candidate: string) => candidate === url),
      ensureWebhookSubscription: jest
        .fn()
        .mockResolvedValue({ url, updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES] }),
      deleteWebhookSubscription: jest.fn(),
    };
    const registry = {
      getAllBots: jest.fn().mockReturnValue([{ id: botId, webhookHeaderSecrets: ['new-secret'] }]),
      getDefaultBot: jest.fn().mockReturnValue({ id: botId }),
      computeWebhookHeaderSecretFingerprint: jest.fn().mockReturnValue('new-fingerprint'),
    };
    const service = new MaxWebhookSubscriptionReconcilerService(
      maxClient as never,
      registry as never,
      statusService as never,
      createPrismaMock() as never,
      { get: jest.fn((_: string, fallback?: unknown) => fallback) } as never,
    );
    await service.onModuleInit();
    await (service as unknown as { reconcile(reason: 'scheduled'): Promise<void> }).reconcile(
      'scheduled',
    );
    expect(maxClient.ensureWebhookSubscription).toHaveBeenCalledTimes(1);
    expect(maxClient.ensureWebhookSubscription).toHaveBeenCalledWith(
      [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
      expect.objectContaining({ botId, forceUpsert: true }),
    );
    expect(savedState).toEqual(
      expect.objectContaining({
        bots: expect.objectContaining({
          [botId]: expect.objectContaining({ headerSecretFingerprint: 'new-fingerprint' }),
        }),
      }),
    );
    await service.onModuleDestroy();
  });

  it('leaves the shared snapshot untouched when reconcile is not active on the current app role', async () => {
    process.env.APP_ROLE = 'admin';

    const botRegistry = {
      getAllBots: jest.fn().mockReturnValue([
        {
          id: '777000_bot',
          webhookHeaderSecrets: ['secret-header-current'],
        },
      ]),
      getDefaultBot: jest.fn().mockReturnValue({ id: '777000_bot' }),
      computeWebhookHeaderSecretFingerprint: jest.fn().mockReturnValue('fingerprint-777000_bot'),
    };
    const statusService = {
      getSyncState: jest.fn(),
      writeSnapshot: jest.fn().mockResolvedValue(undefined),
      writeSyncState: jest.fn(),
      getSnapshot: jest.fn(),
    };
    const maxClient = {
      getConfiguredWebhookSubscriptionTarget: jest.fn(),
      listWebhookSubscriptions: jest.fn(),
      matchesConfiguredWebhookUrl: jest.fn(),
      deleteWebhookSubscription: jest.fn(),
      ensureWebhookSubscription: jest.fn(),
    };
    const service = new MaxWebhookSubscriptionReconcilerService(
      maxClient as never,
      botRegistry as never,
      statusService as never,
      createPrismaMock() as never,
      {
        get: jest.fn((_: string, fallback?: number) => fallback),
      } as never,
    );

    await service.onModuleInit();

    expect(maxClient.listWebhookSubscriptions).not.toHaveBeenCalled();
    expect(statusService.writeSnapshot).not.toHaveBeenCalled();
    expect(statusService.writeSyncState).not.toHaveBeenCalled();
  });

  it.each([
    [['secret-header-current', 'secret-header-previous'], null],
    [['secret-header-current', 'secret-header-previous'], 'old-fingerprint'],
    [['secret-header-current'], 'old-fingerprint'],
  ])(
    'upserts a rotated webhook secret without deleting its subscription (%j, %s)',
    async (webhookHeaderSecrets, headerSecretFingerprint) => {
      process.env.APP_ROLE = 'ingress';

      const botRegistry = {
        getAllBots: jest.fn().mockReturnValue([
          {
            id: '777000_bot',
            webhookHeaderSecrets,
          },
        ]),
        getDefaultBot: jest.fn().mockReturnValue({ id: '777000_bot' }),
        computeWebhookHeaderSecretFingerprint: jest.fn().mockReturnValue('fingerprint-777000_bot'),
      };
      const statusService = {
        getSyncState: jest.fn().mockResolvedValue({
          bots: {
            '777000_bot': {
              configuredUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
              headerSecretFingerprint,
              updatedAt: '2026-03-30T00:00:00.000Z',
              lastIncomingWebhookAt: null,
              lastAutoRecreateAt: null,
            },
          },
          lastGlobalIncomingWebhookAt: null,
          lastGlobalAutoRecreateAt: null,
        }),
        writeSnapshot: jest.fn().mockResolvedValue(undefined),
        writeSyncState: jest.fn().mockResolvedValue(undefined),
        getSnapshot: jest.fn(),
      };
      const maxClient = {
        getConfiguredWebhookSubscriptionTarget: jest.fn().mockReturnValue({
          url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
          maskedUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/***',
        }),
        listWebhookSubscriptions: jest.fn().mockResolvedValue([
          {
            url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
            updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
          },
        ]),
        matchesConfiguredWebhookUrl: jest.fn().mockImplementation((url: string) => {
          return url === 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path';
        }),
        deleteWebhookSubscription: jest.fn().mockResolvedValue(undefined),
        ensureWebhookSubscription: jest.fn().mockResolvedValue({
          url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
          updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
        }),
      };
      const service = new MaxWebhookSubscriptionReconcilerService(
        maxClient as never,
        botRegistry as never,
        statusService as never,
        createPrismaMock() as never,
        {
          get: jest.fn((key: string, fallback?: number | string) => {
            if (key === 'MAX_WEBHOOK_RECONCILE_INTERVAL_MS') {
              return 60_000;
            }
            return fallback;
          }),
        } as never,
      );

      await service.onModuleInit();

      expect(maxClient.deleteWebhookSubscription).not.toHaveBeenCalled();
      expect(maxClient.ensureWebhookSubscription).toHaveBeenCalledWith(
        [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
        {
          trafficClass: 'background',
          botId: '777000_bot',
          sourceTag: MAX_API_SOURCE_TAGS.WEBHOOK_SUBSCRIPTION_RECONCILE,
          forceUpsert: true,
        },
      );
      expect(statusService.writeSyncState).toHaveBeenCalledWith(
        expect.objectContaining({
          bots: expect.objectContaining({
            '777000_bot': expect.objectContaining({
              configuredUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
              headerSecretFingerprint: expect.any(String),
            }),
          }),
        }),
      );

      await service.onModuleDestroy();
    },
  );

  it('establishes the exact URL before deleting a same-origin trailing-slash URL', async () => {
    process.env.APP_ROLE = 'ingress';

    const configuredUrl = 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path';
    const currentUrl = `${configuredUrl}/`;
    const botRegistry = {
      getAllBots: jest.fn().mockReturnValue([
        {
          id: '777000_bot',
          webhookHeaderSecrets: ['secret-header-current', 'secret-header-previous'],
        },
      ]),
      getDefaultBot: jest.fn().mockReturnValue({ id: '777000_bot' }),
      computeWebhookHeaderSecretFingerprint: jest.fn().mockReturnValue('fingerprint-777000_bot'),
    };
    const statusService = {
      getSyncState: jest.fn().mockResolvedValue({
        bots: {
          '777000_bot': {
            configuredUrl,
            headerSecretFingerprint: null,
            updatedAt: '2026-03-30T00:00:00.000Z',
            lastIncomingWebhookAt: null,
            lastAutoRecreateAt: null,
          },
        },
        lastGlobalIncomingWebhookAt: null,
        lastGlobalAutoRecreateAt: null,
      }),
      writeSnapshot: jest.fn().mockResolvedValue(undefined),
      writeSyncState: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn(),
    };
    const maxClient = {
      getConfiguredWebhookSubscriptionTarget: jest.fn().mockReturnValue({
        url: configuredUrl,
        maskedUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/***',
      }),
      listWebhookSubscriptions: jest
        .fn()
        .mockResolvedValueOnce([
          { url: currentUrl, updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES] },
        ])
        .mockResolvedValueOnce([
          { url: configuredUrl, updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES] },
          { url: currentUrl, updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES] },
        ])
        .mockResolvedValueOnce([
          { url: configuredUrl, updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES] },
        ]),
      matchesConfiguredWebhookUrl: jest
        .fn()
        .mockImplementation((url: string) => url === configuredUrl),
      deleteWebhookSubscription: jest.fn().mockResolvedValue(undefined),
      ensureWebhookSubscription: jest.fn().mockResolvedValue({
        url: configuredUrl,
        updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
      }),
    };
    const service = new MaxWebhookSubscriptionReconcilerService(
      maxClient as never,
      botRegistry as never,
      statusService as never,
      createPrismaMock() as never,
      {
        get: jest.fn((key: string, fallback?: number | string) => {
          if (key === 'MAX_WEBHOOK_RECONCILE_INTERVAL_MS') {
            return 60_000;
          }
          return fallback;
        }),
      } as never,
    );

    await service.onModuleInit();

    expect(maxClient.deleteWebhookSubscription).toHaveBeenCalledWith(
      currentUrl,
      expect.objectContaining({ botId: '777000_bot' }),
    );
    expect(maxClient.listWebhookSubscriptions.mock.invocationCallOrder[1]).toBeLessThan(
      maxClient.deleteWebhookSubscription.mock.invocationCallOrder[0]!,
    );
    expect(maxClient.ensureWebhookSubscription).toHaveBeenCalledWith(
      [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
      expect.objectContaining({
        botId: '777000_bot',
        forceUpsert: true,
      }),
    );

    await service.onModuleDestroy();
  });

  it('keeps a healthy subscription intact when ingress is quiet', async () => {
    process.env.APP_ROLE = 'ingress';

    const botRegistry = {
      getAllBots: jest.fn().mockReturnValue([
        {
          id: '777000_bot',
          webhookHeaderSecrets: ['secret-header-current'],
        },
      ]),
      getDefaultBot: jest.fn().mockReturnValue({ id: '777000_bot' }),
      computeWebhookHeaderSecretFingerprint: jest.fn().mockReturnValue('fingerprint-777000_bot'),
    };
    const staleAt = new Date(Date.now() - 40 * 60 * 1_000).toISOString();
    const statusService = {
      getSyncState: jest.fn().mockResolvedValue({
        bots: {
          '777000_bot': {
            configuredUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
            headerSecretFingerprint: 'fingerprint-777000_bot',
            updatedAt: '2026-03-30T00:00:00.000Z',
            lastIncomingWebhookAt: staleAt,
            lastAutoRecreateAt: null,
          },
        },
        lastGlobalIncomingWebhookAt: staleAt,
        lastGlobalAutoRecreateAt: null,
      }),
      writeSnapshot: jest.fn().mockResolvedValue(undefined),
      writeSyncState: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn(),
    };
    const maxClient = {
      getConfiguredWebhookSubscriptionTarget: jest.fn().mockReturnValue({
        url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
        maskedUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/***',
      }),
      listWebhookSubscriptions: jest.fn().mockResolvedValue([
        {
          url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
          updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
        },
      ]),
      matchesConfiguredWebhookUrl: jest.fn().mockImplementation((url: string) => {
        return url === 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path';
      }),
      deleteWebhookSubscription: jest.fn().mockResolvedValue(undefined),
      ensureWebhookSubscription: jest.fn().mockResolvedValue({
        url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
        updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
      }),
    };
    const service = new MaxWebhookSubscriptionReconcilerService(
      maxClient as never,
      botRegistry as never,
      statusService as never,
      createPrismaMock() as never,
      {
        get: jest.fn((key: string, fallback?: number | string) => {
          if (key === 'MAX_WEBHOOK_RECONCILE_INTERVAL_MS') {
            return 60_000;
          }
          if (key === 'MAX_WEBHOOK_STALE_INGRESS_MS') {
            return 10 * 60 * 1_000;
          }
          if (key === 'MAX_WEBHOOK_STALE_RECREATE_COOLDOWN_MS') {
            return 30 * 60 * 1_000;
          }
          return fallback;
        }),
      } as never,
    );

    await service.onModuleInit();

    expect(maxClient.deleteWebhookSubscription).not.toHaveBeenCalled();
    expect(maxClient.ensureWebhookSubscription).not.toHaveBeenCalled();
    expect(statusService.writeSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'warning',
        bots: expect.objectContaining({
          '777000_bot': expect.objectContaining({
            status: 'warning',
            note: expect.stringContaining('оставлена без разрыва доставки'),
          }),
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('reports only the quiet bot without recreating either healthy subscription', async () => {
    process.env.APP_ROLE = 'ingress';

    const botRegistry = {
      getAllBots: jest.fn().mockReturnValue([
        {
          id: 'fresh_bot',
          webhookHeaderSecrets: ['secret-header-current'],
        },
        {
          id: 'stale_bot',
          webhookHeaderSecrets: ['secret-header-current'],
        },
      ]),
      getDefaultBot: jest.fn().mockReturnValue({ id: 'fresh_bot' }),
      computeWebhookHeaderSecretFingerprint: jest
        .fn()
        .mockImplementation((botId: string) => `fingerprint-${botId}`),
    };
    const freshAt = new Date(Date.now() - 60_000).toISOString();
    const staleAt = new Date(Date.now() - 40 * 60 * 1_000).toISOString();
    const statusService = {
      getSyncState: jest.fn().mockResolvedValue({
        bots: {
          fresh_bot: {
            configuredUrl: 'https://major-maksimov.ru/api/webhook/max/fresh_bot/secret-path',
            headerSecretFingerprint: 'fingerprint-fresh_bot',
            updatedAt: '2026-03-30T00:00:00.000Z',
            lastIncomingWebhookAt: freshAt,
            lastAutoRecreateAt: null,
          },
          stale_bot: {
            configuredUrl: 'https://major-maksimov.ru/api/webhook/max/stale_bot/secret-path',
            headerSecretFingerprint: 'fingerprint-stale_bot',
            updatedAt: '2026-03-30T00:00:00.000Z',
            lastIncomingWebhookAt: staleAt,
            lastAutoRecreateAt: null,
          },
        },
        lastGlobalIncomingWebhookAt: freshAt,
        lastGlobalAutoRecreateAt: null,
      }),
      writeSnapshot: jest.fn().mockResolvedValue(undefined),
      writeSyncState: jest.fn().mockResolvedValue(undefined),
      getSnapshot: jest.fn(),
    };
    const maxClient = {
      getConfiguredWebhookSubscriptionTarget: jest.fn().mockImplementation((botId: string) => ({
        url: `https://major-maksimov.ru/api/webhook/max/${botId}/secret-path`,
        maskedUrl: `https://major-maksimov.ru/api/webhook/max/${botId}/***`,
      })),
      listWebhookSubscriptions: jest.fn().mockImplementation(({ botId }: { botId: string }) =>
        Promise.resolve([
          {
            url: `https://major-maksimov.ru/api/webhook/max/${botId}/secret-path`,
            updateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
          },
        ]),
      ),
      matchesConfiguredWebhookUrl: jest
        .fn()
        .mockImplementation(
          (url: string, botId: string) =>
            url === `https://major-maksimov.ru/api/webhook/max/${botId}/secret-path`,
        ),
      deleteWebhookSubscription: jest.fn().mockResolvedValue(undefined),
      ensureWebhookSubscription: jest.fn().mockImplementation((updateTypes, { botId }) =>
        Promise.resolve({
          url: `https://major-maksimov.ru/api/webhook/max/${botId}/secret-path`,
          updateTypes,
        }),
      ),
    };
    const service = new MaxWebhookSubscriptionReconcilerService(
      maxClient as never,
      botRegistry as never,
      statusService as never,
      createPrismaMock() as never,
      {
        get: jest.fn((key: string, fallback?: number | string) => {
          if (key === 'MAX_WEBHOOK_RECONCILE_INTERVAL_MS') {
            return 60_000;
          }
          if (key === 'MAX_WEBHOOK_STALE_INGRESS_MS') {
            return 10 * 60 * 1_000;
          }
          if (key === 'MAX_WEBHOOK_STALE_RECREATE_COOLDOWN_MS') {
            return 30 * 60 * 1_000;
          }
          return fallback;
        }),
      } as never,
    );

    await service.onModuleInit();

    expect(maxClient.deleteWebhookSubscription).not.toHaveBeenCalled();
    expect(maxClient.ensureWebhookSubscription).not.toHaveBeenCalled();
    expect(statusService.writeSnapshot).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'warning',
        bots: expect.objectContaining({
          fresh_bot: expect.objectContaining({ status: 'healthy' }),
          stale_bot: expect.objectContaining({
            status: 'warning',
            note: expect.stringContaining('оставлена без разрыва доставки'),
          }),
        }),
      }),
    );
    expect(statusService.writeSyncState).toHaveBeenCalledWith(
      expect.objectContaining({
        lastGlobalIncomingWebhookAt: freshAt,
      }),
    );

    await service.onModuleDestroy();
  });
});
