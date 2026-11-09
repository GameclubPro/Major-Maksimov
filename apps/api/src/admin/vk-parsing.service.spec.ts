import { PublisherSetupRequiredException } from '../publisher/publisher-errors';
import { VK_PARSING_MAX_PUBLISH_TEXT_LENGTH } from '@maxim/contracts';
import {
  ChatEntityType,
  PublicationDispatchProfile,
  VkParsingOwnerProfile,
} from '../prisma/prisma-client';
import { MAX_API_SOURCE_TAGS } from '../max/max-client.service';
import * as publicHttpsMedia from '../common/public-https-media';
import {
  VK_MEDIA_CACHE_UPLOAD_BOT_ID_FIELD,
  VkParsingMediaCacheService,
  type VkParsingMediaCacheRow,
} from './vk-parsing-media-cache.service';
import { VkParsingPostImportRepository } from './vk-parsing-post-import.repository';
import { VkParsingAccessService } from './vk-parsing-access.service';
import { VkApiClientService } from './vk-api-client.service';
import {
  buildVkAutoPublishScheduleFingerprint,
  VK_AUTOPUBLISH_PENDING_SCHEDULE_FINGERPRINT,
} from './vk-autopublish-policy';
import { computeVkParsingPostContentHash } from './vk-parsing-content';
import { VkParsingFeedService } from './vk-parsing-feed.service';
import { VkApiRequestError } from './vk-parsing-errors';
import { VkParsingRateLimitService } from './vk-parsing-rate-limit.service';
import { VkParsingService } from './vk-parsing.service';
import { VkParsingOwnershipService } from './vk-parsing-ownership.service';
import { VkPublishService } from './vk-publish.service';
import { VkSourceService } from './vk-source.service';
import { VkSyncService } from './vk-sync.service';

type MockFetchResponse = {
  ok: boolean;
  status?: number;
  body?: {
    cancel: () => Promise<void>;
  };
  headers?: Headers;
  json?: () => Promise<unknown>;
  arrayBuffer?: () => Promise<ArrayBuffer>;
};

type VkParsingServiceTestHarness = Omit<VkParsingService, 'processPublishPostJob'> & {
  processPublishPostJob(
    params: Omit<
      Parameters<VkParsingService['processPublishPostJob']>[0],
      'dispatchProfile' | 'requiredBotId'
    > & {
      dispatchProfile?: 'PUBLIK_V1';
      requiredBotId?: string;
    },
  ): ReturnType<VkParsingService['processPublishPostJob']>;
};

function createConfig(values: Record<string, unknown> = {}) {
  return {
    get: jest.fn((key: string) => values[key]),
  };
}

function createJsonFetchResponse(payload: unknown): MockFetchResponse {
  return {
    ok: true,
    json: async () => payload,
  };
}

function createMaxApiError(status: number, message: string, code?: string): Error {
  return Object.assign(new Error(message), {
    response: {
      status,
      data: {
        ...(code ? { code } : {}),
        message,
      },
    },
  });
}

function readExecuteRawValues(prisma: { $executeRaw: jest.Mock }): unknown[] {
  return prisma.$executeRaw.mock.calls.flatMap(([query]) => {
    const values = (query as { values?: unknown[] })?.values;
    return Array.isArray(values) ? values : [];
  });
}

function readExecuteRawSql(prisma: { $executeRaw: jest.Mock }): string {
  return prisma.$executeRaw.mock.calls
    .map(([query]) => {
      const strings = (query as { strings?: readonly string[] })?.strings;
      return Array.isArray(strings) ? strings.join('?') : '';
    })
    .join('\n');
}

function readQueryRawSql(prisma: { $queryRaw: jest.Mock }): string {
  return prisma.$queryRaw.mock.calls
    .map(([query]) => {
      if (Array.isArray(query)) {
        return query.join('?');
      }
      const strings = (query as { strings?: readonly string[] })?.strings;
      return Array.isArray(strings) ? strings.join('?') : '';
    })
    .join('\n');
}

describe('VkParsingService', () => {
  const originalFetch = global.fetch;
  let mediaFetch: jest.SpyInstance<
    ReturnType<typeof publicHttpsMedia.fetchPublicHttpsMedia>,
    Parameters<typeof publicHttpsMedia.fetchPublicHttpsMedia>
  >;
  let unexpectedMediaRequests = 0;

  beforeEach(() => {
    unexpectedMediaRequests = 0;
    mediaFetch = jest
      .spyOn(publicHttpsMedia, 'fetchPublicHttpsMedia')
      .mockImplementation(async () => {
        unexpectedMediaRequests += 1;
        throw new Error('Unexpected VK media request in test');
      });
  });

  afterEach(() => {
    jest.useRealTimers();
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    expect(unexpectedMediaRequests).toBe(0);
  });

  function createFixture(
    config: Record<string, unknown> = {},
    dependencies: { maxRoutedPublicationService?: { publish: jest.Mock } } = {},
  ) {
    const prisma = {
      publisherEntityBinding: { findUnique: jest.fn().mockResolvedValue(null) },
      chat: {
        findUnique: jest.fn().mockResolvedValue({ entityType: ChatEntityType.CHANNEL }),
      },
      vkParsingSource: {
        upsert: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
      },
      vkParsingPost: {
        findUnique: jest.fn(),
        upsert: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(0),
        aggregate: jest.fn().mockResolvedValue({
          _max: { lastSeenAt: null },
          _min: { publishQueuedAt: null },
        }),
      },
      vkParsingSettings: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(),
      },
      channelAudienceSnapshot: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      managedBotChatCatalog: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      vkParsingMediaCache: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation((payload) =>
          Promise.resolve({
            id: 'media-1',
            url: payload.data.url,
            mediaIdentity: payload.data.mediaIdentity ?? null,
            status: payload.data.status,
            mimeType: payload.data.mimeType ?? null,
            contentLength: payload.data.contentLength ?? null,
            maxUploadPayload: payload.data.maxUploadPayload ?? null,
            maxUploadToken: payload.data.maxUploadToken ?? null,
            maxUploadedAt: payload.data.maxUploadedAt ?? null,
            uploadAttemptCount: payload.data.uploadAttemptCount ?? 0,
            lastCheckedAt: payload.data.lastCheckedAt,
            lastError: payload.data.lastError ?? null,
            createdAt: new Date('2026-05-25T10:00:00.000Z'),
            updatedAt: new Date('2026-05-25T10:00:00.000Z'),
          }),
        ),
        update: jest.fn().mockImplementation((payload) =>
          Promise.resolve({
            id: payload.where.id,
            url: payload.data.url ?? 'https://sun1.example/large.jpg',
            status: payload.data.status,
            mimeType: payload.data.mimeType ?? null,
            contentLength: payload.data.contentLength ?? null,
            mediaIdentity: payload.data.mediaIdentity ?? null,
            maxUploadPayload: payload.data.maxUploadPayload ?? null,
            maxUploadToken: payload.data.maxUploadToken ?? null,
            maxUploadedAt: payload.data.maxUploadedAt ?? null,
            uploadAttemptCount: 1,
            lastCheckedAt: payload.data.lastCheckedAt,
            lastError: payload.data.lastError ?? null,
            createdAt: new Date('2026-05-25T10:00:00.000Z'),
            updatedAt: new Date('2026-05-25T10:00:00.000Z'),
          }),
        ),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(0),
        upsert: jest.fn().mockImplementation((payload) =>
          Promise.resolve({
            id: 'media-1',
            url: payload.create.url,
            mediaIdentity: payload.create.mediaIdentity ?? null,
            status: payload.create.status,
            mimeType: payload.create.mimeType ?? null,
            contentLength: payload.create.contentLength ?? null,
            maxUploadPayload: payload.create.maxUploadPayload ?? null,
            maxUploadToken: payload.create.maxUploadToken ?? null,
            maxUploadedAt: payload.create.maxUploadedAt ?? null,
            uploadAttemptCount: payload.create.uploadAttemptCount ?? 0,
            lastCheckedAt: payload.create.lastCheckedAt,
            lastError: payload.create.lastError ?? null,
            createdAt: new Date('2026-05-25T10:00:00.000Z'),
            updatedAt: new Date('2026-05-25T10:00:00.000Z'),
          }),
        ),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([
        {
          id: 'channel-1',
          attemptedSources: 0,
          successfulSources: 0,
          circuitOpenSourceCount: 0,
          p95SyncDurationMs: null,
        },
      ]),
      $transaction: jest.fn(),
    };
    const transactionSourceFindFirst = jest.fn(async (query: unknown) => {
      const explicit = await prisma.vkParsingSource.findFirst(query);
      if (explicit !== undefined) {
        return explicit;
      }
      for (const result of [...prisma.vkParsingSource.findUnique.mock.results].reverse()) {
        try {
          const candidate = await result.value;
          if (candidate) {
            return candidate;
          }
        } catch {
          // A rejected lookup cannot be the source whose lease was acquired.
        }
      }
      return null;
    });
    const transactionClient = {
      ...prisma,
      vkParsingSource: {
        ...prisma.vkParsingSource,
        findFirst: transactionSourceFindFirst,
      },
    };
    prisma.$transaction.mockImplementation((operation: unknown, _options?: unknown) =>
      typeof operation === 'function'
        ? (operation as (tx: unknown) => Promise<unknown>)(transactionClient)
        : Promise.all(operation as Promise<unknown>[]),
    );
    const adminService = {
      assertChatAdmin: jest.fn().mockResolvedValue(undefined),
      buildChannelPublicationEngagementContext: jest.fn().mockResolvedValue({
        buttons: [],
        threadId: null,
        includeCommentsButton: false,
        includeSuggestButton: false,
        suggestButtonText: null,
        suggestionEntryMode: 'BOT',
      }),
      recordChannelPublicationEngagement: jest.fn().mockResolvedValue(undefined),
    };
    const publisherPolicyService = {
      getEntity: jest.fn(
        async (entityType: 'chat' | 'channel', chatId: string, user: { userId: string }) => {
          await adminService.assertChatAdmin(chatId, user.userId, entityType);
          return { id: chatId, entityType };
        },
      ),
    };
    const maxClient = {
      uploadImage: jest.fn(),
      uploadVideo: jest.fn(),
      sendMessageImmediateWithResolvedLink: jest.fn(),
      getChatSnapshot: jest.fn(),
    };
    const vkRateLimitService: jest.Mocked<
      Pick<
        VkParsingRateLimitService,
        'reserveVkApiSlot' | 'publishVkApiCooldown' | 'recordVkApiOutcome' | 'getRecentVkApiMetrics'
      >
    > = {
      reserveVkApiSlot: jest.fn().mockResolvedValue(undefined),
      publishVkApiCooldown: jest.fn().mockResolvedValue(undefined),
      recordVkApiOutcome: jest.fn().mockResolvedValue(undefined),
      getRecentVkApiMetrics: jest.fn().mockResolvedValue({
        rps: 0,
        errorRate: 0,
        recentErrors: [],
      }),
    };
    const syncQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const publishQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const configService = createConfig({
      MAX_PUBLISHER_BOT_ID: 'publisher-bot',
      MAX_PUBLISHER_DISPATCH_ENABLED: true,
      VK_SERVICE_TOKEN: 'vk-service-token',
      VK_API_BASE_URL: 'https://api.vk.ru',
      VK_API_VERSION: '5.199',
      VK_PARSING_SYNC_INTERVAL_MS: 600_000,
      VK_PARSING_FETCH_COUNT: 100,
      VK_PARSING_MIN_PAGES: 1,
      VK_PARSING_MAX_PAGES: 1,
      VK_PARSING_MISSING_CONFIRMATION_THRESHOLD: 3,
      VK_API_TIMEOUT_MS: 10_000,
      VK_API_MAX_ATTEMPTS: 3,
      VK_PARSING_QUEUE_BATCH_SIZE: 100,
      VK_PARSING_LEASE_TTL_MS: 120_000,
      VK_PARSING_MEDIA_PREFLIGHT_TTL_MS: 86_400_000,
      VK_PARSING_MEDIA_FAILED_PREFLIGHT_TTL_MS: 120_000,
      VK_PARSING_MEDIA_CONCURRENCY: 3,
      ...config,
    });
    const mediaCache = new VkParsingMediaCacheService(prisma as never, configService as never);
    const ownership = new VkParsingOwnershipService(
      createConfig({ MAX_PUBLISHER_BOT_ID: 'publisher-bot' }) as never,
    );
    const postImportRepository = new VkParsingPostImportRepository(prisma as never);
    const accessService = new VkParsingAccessService(
      prisma as never,
      publisherPolicyService as never,
      configService as never,
    );
    const feedService = new VkParsingFeedService(
      prisma as never,
      vkRateLimitService as never,
      configService as never,
    );
    const vkApiClient = new VkApiClientService(configService as never, vkRateLimitService as never);
    const publisherReadiness = {
      assertEntityReady: jest.fn().mockResolvedValue({
        chatId: 'channel-1',
        entityType: 'channel',
        requiredBotId: 'publisher-bot',
        policyRevision: 1,
      }),
    };
    const publisherRuntimeBoundary = {
      dispatchEnabled: true,
      assertDispatchEnabled: jest.fn(),
    };
    const publisherDispatchHealth = {
      assertDispatchAllowed: jest.fn().mockResolvedValue(undefined),
      isGloballyPaused: jest.fn().mockResolvedValue(false),
      recordSendSuccess: jest.fn().mockResolvedValue(undefined),
      recordSendFailure: jest.fn().mockResolvedValue('transient'),
    };
    const publisherDialogContext = {
      version: 1,
      dialogBotId: 'publisher-bot',
      buttons: [],
      reference: null,
    };
    const publisherDialogContextService = {
      prepare: jest.fn().mockResolvedValue(publisherDialogContext),
      read: jest.fn((value: unknown, expectedBotId: string) => {
        const context = value as typeof publisherDialogContext | null;
        return context?.version === 1 && context.dialogBotId === expectedBotId ? context : null;
      }),
    };
    const defaultMaxRoutedPublicationService = {
      publish: jest.fn(async (request: any) => {
        const botId = request.publisherExactBotId;
        const postId = String(request.logicalIdempotencyKey).split(':')[2];
        let loadedPost: any = null;
        for (const result of [...prisma.vkParsingPost.findFirst.mock.results].reverse()) {
          const candidate = await result.value;
          if (candidate?.id === postId && candidate.source) {
            loadedPost = candidate;
            break;
          }
        }
        const claim = [...prisma.vkParsingPost.updateMany.mock.calls]
          .reverse()
          .find(
            ([query]) => query.where.id === postId && query.data.publishLockedAt instanceof Date,
          );
        if (loadedPost && claim) {
          loadedPost.publishLockedAt = claim[0].data.publishLockedAt;
        }
        const prepared = await request.prepareAttempt({ botId, job: {} });
        await request.beforeSendMutation?.();
        request.onDispatchAttempt?.({ botId, job: {} });
        const sent = await maxClient.sendMessageImmediateWithResolvedLink(
          request.entityId,
          request.text,
          prepared.options,
          {
            botId,
            trafficClass: request.trafficClass,
            sourceTag: request.sourceTag,
          },
        );
        return {
          ...sent,
          botId,
          candidateBotIds: [botId],
          routingVersion: null,
        };
      }),
    };
    const maxRoutedPublicationService =
      dependencies.maxRoutedPublicationService ?? defaultMaxRoutedPublicationService;
    const sourceService = new VkSourceService(
      prisma as never,
      feedService,
      vkApiClient,
      syncQueue as never,
      configService as never,
      ownership,
    );
    const publishService = new VkPublishService(
      prisma as never,
      accessService,
      maxClient as never,
      mediaCache,
      feedService,
      configService as never,
      ownership,
      undefined,
      maxRoutedPublicationService as never,
      publishQueue as never,
      publisherReadiness as never,
      publisherRuntimeBoundary as never,
      publisherDispatchHealth as never,
      publisherDialogContextService as never,
    );
    const syncService = new VkSyncService(
      prisma as never,
      vkApiClient,
      publishService,
      mediaCache,
      postImportRepository,
      configService as never,
      ownership,
    );

    const service = new VkParsingService(
      prisma as never,
      accessService,
      feedService,
      sourceService,
      syncService,
      publishService,
      ownership,
    );
    const processPublishPostJob = service.processPublishPostJob.bind(service);
    (service as any).processPublishPostJob = (params: Record<string, unknown>) =>
      processPublishPostJob({
        ...params,
        dispatchProfile: params.dispatchProfile ?? 'PUBLIK_V1',
        requiredBotId: params.requiredBotId ?? 'publisher-bot',
      } as never);

    return {
      service: service as VkParsingServiceTestHarness,
      prisma,
      adminService,
      maxClient,
      vkRateLimitService,
      syncQueue,
      publishQueue,
      mediaCache,
      postImportRepository,
      accessService,
      feedService,
      vkApiClient,
      sourceService,
      syncService,
      publishService,
      maxRoutedPublicationService,
      publisherReadiness,
      publisherRuntimeBoundary,
      publisherDispatchHealth,
      publisherDialogContextService,
    };
  }

  function createSource(overrides: Record<string, unknown> = {}) {
    return {
      id: 'source-1',
      chatId: 'channel-1',
      ownerProfile: VkParsingOwnerProfile.PUBLISHER,
      ownerBotId: 'publisher-bot',
      ownerId: 36819802,
      wallOwnerId: -36819802,
      screenName: 'avto_prodaja_rb',
      title: 'Авторынок Уфа',
      url: 'https://vk.ru/avto_prodaja_rb',
      status: 'ACTIVE',
      importEnabled: true,
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      autoPublishPausedAt: null,
      autoPublishPausedReason: null,
      publishIntervalMinutes: 60,
      dailyLimit: 3,
      minPublishIntervalMinutes: 30,
      publishMode: 'QUEUE',
      priority: 'NORMAL',
      quietHoursStart: null,
      quietHoursEnd: null,
      lastAutoPublishedAt: null,
      syncStatus: 'IDLE',
      nextSyncAt: new Date('2026-05-25T10:00:00.000Z'),
      lastSyncAt: null,
      lastSuccessAt: null,
      syncStartedAt: null,
      syncLockedAt: null,
      syncLockedBy: null,
      syncLockDeadlineAt: null,
      syncHeartbeatAt: null,
      syncAttemptCount: 0,
      consecutiveFailures: 0,
      terminalFailureCount: 0,
      circuitOpenedAt: null,
      circuitReasonCode: null,
      circuitReason: null,
      circuitRetryAt: null,
      lastErrorCode: null,
      lastImportedCount: 0,
      lastFetchedCount: 0,
      lastFetchedPages: 0,
      lastFetchedOffsets: [],
      lastVkNewestPostId: null,
      lastVkNewestPublishedAt: null,
      adaptiveIntervalMs: null,
      lastSyncDurationMs: null,
      lastError: null,
      createdByUserId: '183470701',
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
      ...overrides,
    };
  }

  function createPublisherSource(overrides: Record<string, unknown> = {}) {
    return createSource({
      ownerProfile: VkParsingOwnerProfile.PUBLISHER,
      ownerBotId: 'publisher-bot',
      ...overrides,
    });
  }

  function mockVkSourceLookup(): void {
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          groups: [{ id: 36819802, screen_name: 'avto_prodaja_rb', name: 'Авторынок Уфа' }],
          items: [{ owner_id: -36819802, id: 101, date: 1_779_708_000, text: 'Пост' }],
        },
      }),
    ) as unknown as typeof fetch;
  }

  function createQueueJob(state: string, data: Record<string, unknown> = {}) {
    return {
      data: {
        kind: 'publish',
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: 'publisher-bot',
        ...data,
      },
      getState: jest.fn().mockResolvedValue(state),
      remove: jest.fn().mockResolvedValue(undefined),
      updateData: jest.fn().mockResolvedValue(undefined),
      retry: jest.fn().mockResolvedValue(undefined),
    };
  }

  function createSyncQueueJob(state: string, data: Record<string, unknown> = {}) {
    return createQueueJob(state, {
      sourceId: 'source-1',
      reason: 'scheduled',
      ownerProfile: 'PUBLISHER',
      ownerBotId: 'publisher-bot',
      ...data,
    });
  }

  function createPostRow(overrides: Record<string, unknown> = {}) {
    const source = createSource((overrides.source as Record<string, unknown> | undefined) ?? {});
    const defaultScheduleFingerprint = buildVkAutoPublishScheduleFingerprint(
      {
        schedulerTimezone: 'Europe/Moscow',
        quietHoursStart: null,
        quietHoursEnd: null,
        workHoursStart: '00:00',
        workHoursEnd: '00:00',
        distributeEvenlyEnabled: true,
        roundRobinEnabled: true,
      },
      source,
    );
    const publisherDialogContext = {
      version: 1,
      dialogBotId: 'publisher-bot',
      buttons: [],
      reference: null,
    };
    return {
      id: 'post-1',
      sourceId: source.id,
      chatId: source.chatId,
      ownerProfile: source.ownerProfile,
      ownerBotId: source.ownerBotId,
      vkOwnerId: -36819802,
      vkPostId: 101,
      vkPublishedAt: new Date('2026-05-25T10:00:00.000Z'),
      text: 'Продам авто',
      textFormat: 'plain',
      manualContentEditedAt: null,
      url: 'https://vk.ru/wall-36819802_101',
      photoUrls: [],
      videoUrls: [],
      linkUrls: [],
      attachments: [],
      attachmentTypes: [],
      unsupportedAttachments: [],
      hasUnsupportedAttachments: false,
      isAdvertising: false,
      advertisingMarkers: [],
      raw: {},
      contentHash: 'content-hash',
      publishedContentHash: null,
      status: 'NEW',
      publishedMessageId: null,
      publishedUrl: null,
      publishedAtMax: null,
      autoPublishedAt: null,
      autoPublishError: null,
      skippedAt: null,
      skipReason: null,
      lastSeenAt: new Date('2026-05-25T10:00:00.000Z'),
      missingSinceAt: null,
      missingSeenCount: 0,
      lastAvailabilityCheckedAt: new Date('2026-05-25T10:00:00.000Z'),
      unavailableAt: null,
      publishQueuedAt: null,
      publishScheduledAt: null,
      publishCancelledAt: null,
      publishCancelledByUserId: null,
      publishLockedAt: null,
      publishAttemptCount: 0,
      publishIdempotencyKey: null,
      publishReason: null,
      publishScheduleFingerprint: defaultScheduleFingerprint,
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      requiredBotId: 'publisher-bot',
      dialogBotId: 'publisher-bot',
      publishDialogContext: publisherDialogContext,
      publicationPolicyRevision: 1,
      publishActorUserId: null,
      publishedBotId: null,
      dispatchBlockerCode: null,
      dispatchBlockedAt: null,
      rollbackQueuedAt: null,
      rollbackLockedAt: null,
      rollbackDeletedAt: null,
      rollbackAttemptCount: 0,
      rollbackIdempotencyKey: null,
      rollbackLastError: null,
      lastError: null,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
      source,
      ...overrides,
    };
  }

  function createFreshQueuedPublishTimes() {
    const now = Date.now();
    return {
      publishQueuedAt: new Date(now - 2 * 60_000),
      publishScheduledAt: new Date(now - 60_000),
    };
  }

  it('pauses VK autopublish when the background governor is unavailable', async () => {
    const { publishService } = createFixture();
    const backgroundRuntimeGovernorService = {
      decide: jest.fn().mockRejectedValue(new Error('timeout exceeded when trying to connect')),
    };
    const testPublishService = publishService as unknown as {
      backgroundRuntimeGovernorService?: unknown;
      decideBackgroundAutoPublish: () => Promise<unknown>;
    };
    testPublishService.backgroundRuntimeGovernorService = backgroundRuntimeGovernorService;

    await expect(testPublishService.decideBackgroundAutoPublish()).resolves.toEqual({
      action: 'pause',
      retryAfterMs: 180_000,
      reason: 'background governor unavailable',
    });
    expect(backgroundRuntimeGovernorService.decide).toHaveBeenCalledWith({
      component: 'vk_parsing_autopublish',
      sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
    });
  });

  it('allows any channel admin to use VK parsing', async () => {
    const { service, prisma, adminService } = createFixture();

    await expect(
      service.listVkParsing('channel-1', { userId: 'not-allowlisted' } as never),
    ).resolves.toMatchObject({
      capabilities: { enabled: true, canUse: true },
    });
    expect(adminService.assertChatAdmin).toHaveBeenCalledWith(
      'channel-1',
      'not-allowlisted',
      'channel',
    );
    expect(prisma.vkParsingSettings.findUnique).toHaveBeenCalledWith({
      where: {
        chatId_ownerProfile_ownerBotId: {
          chatId: 'channel-1',
          ownerProfile: VkParsingOwnerProfile.PUBLISHER,
          ownerBotId: 'publisher-bot',
        },
      },
    });
    expect(prisma.vkParsingSource.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'channel-1',
          ownerProfile: VkParsingOwnerProfile.PUBLISHER,
          ownerBotId: 'publisher-bot',
        }),
      }),
    );
    for (const [request] of prisma.vkParsingPost.findMany.mock.calls) {
      expect(request.where).toEqual(
        expect.objectContaining({
          chatId: 'channel-1',
          ownerProfile: VkParsingOwnerProfile.PUBLISHER,
          ownerBotId: 'publisher-bot',
          source: expect.objectContaining({
            ownerProfile: VkParsingOwnerProfile.PUBLISHER,
            ownerBotId: 'publisher-bot',
          }),
        }),
      );
    }
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  it('keeps queued and cancelled posts out of the incoming view', async () => {
    const { service, prisma } = createFixture();
    await service.listVkParsing('channel-1', { userId: 'channel-admin' } as never, {
      status: 'NEW',
    });
    expect(prisma.vkParsingPost.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'NEW',
          publishQueuedAt: null,
          publishCancelledAt: null,
          ownerProfile: 'PUBLISHER',
          ownerBotId: 'publisher-bot',
        }),
      }),
    );
  });

  it('orders the paginated publication queue by send time, not VK creation time', async () => {
    const { service, prisma } = createFixture();
    await service.listVkParsing('channel-1', { userId: 'channel-admin' } as never, {
      status: 'QUEUED',
      sourceId: 'source-1',
    });
    expect(prisma.vkParsingPost.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceId: 'source-1',
          publishQueuedAt: { not: null },
          status: { in: ['NEW', 'FAILED'] },
        }),
        orderBy: [{ publishScheduledAt: 'asc' }, { publishQueuedAt: 'asc' }, { id: 'asc' }],
        take: 50,
      }),
    );
  });

  it('keeps posts changed in VK visible in published history', async () => {
    const { service, prisma } = createFixture();
    await service.listVkParsing('channel-1', { userId: 'channel-admin' } as never, {
      status: 'PUBLISHED',
    });
    expect(prisma.vkParsingPost.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: { in: ['PUBLISHED', 'CHANGED_AFTER_PUBLISH'] } }),
      }),
    );
  });

  it('rejects invalid feed filters without reading posts or operational diagnostics', async () => {
    const { service, prisma, vkRateLimitService } = createFixture();
    await expect(
      service.listVkParsing('channel-1', { userId: 'channel-admin' } as never, {
        status: 'INVALID',
      }),
    ).rejects.toThrow('Некорректные параметры');
    expect(prisma.vkParsingPost.findMany).not.toHaveBeenCalled();
    expect(vkRateLimitService.getRecentVkApiMetrics).not.toHaveBeenCalled();
  });

  it('reports VK parsing as not configured to channel admins when the VK token is missing', async () => {
    const { service, adminService } = createFixture({ VK_SERVICE_TOKEN: '' });

    await expect(
      service.getCapability('channel-1', { userId: 'channel-admin' } as never),
    ).resolves.toEqual({
      enabled: false,
      canUse: false,
      reasonCode: 'NOT_CONFIGURED',
      reason: 'VK_SERVICE_TOKEN не настроен на сервере.',
    });
    expect(adminService.assertChatAdmin).toHaveBeenCalledWith(
      'channel-1',
      'channel-admin',
      'channel',
    );
  });

  it('does not expose VK token configuration to users without admin access', async () => {
    const { service, adminService } = createFixture({ VK_SERVICE_TOKEN: '' });
    adminService.assertChatAdmin.mockRejectedValue(new Error('not admin'));

    await expect(service.getCapability('channel-1', { userId: 'guest' } as never)).resolves.toEqual(
      {
        enabled: true,
        canUse: false,
        reasonCode: 'ACCESS_DENIED',
        reason: 'Недостаточно прав администратора.',
      },
    );
  });

  it('fails VK parsing operations early when the VK token is missing', async () => {
    const { service } = createFixture({ VK_SERVICE_TOKEN: '' });

    await expect(
      service.listVkParsing('channel-1', { userId: 'channel-admin' } as never),
    ).rejects.toThrow('VK_SERVICE_TOKEN не настроен на сервере.');
  });

  it('allows chat admins to use VK parsing in chats', async () => {
    const { service, prisma, adminService } = createFixture();
    prisma.chat.findUnique.mockResolvedValue({ entityType: ChatEntityType.CHAT });

    await expect(
      service.listVkParsing('chat-1', { userId: 'chat-admin' } as never),
    ).resolves.toMatchObject({
      capabilities: { enabled: true, canUse: true },
    });
    expect(adminService.assertChatAdmin).toHaveBeenCalledWith('chat-1', 'chat-admin', 'chat');
  });

  it('keeps source retry in the feed and loads operational metrics only through summary', async () => {
    const { service, prisma, vkRateLimitService } = createFixture();
    const retryAt = new Date('2026-05-25T10:30:00.000Z');
    prisma.vkParsingSource.findMany.mockResolvedValue([
      createSource({
        syncStatus: 'BACKOFF',
        nextSyncAt: retryAt,
        terminalFailureCount: 1,
        circuitRetryAt: retryAt,
      }),
    ]);
    prisma.vkParsingPost.findMany.mockResolvedValue([]);
    prisma.vkParsingSource.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);
    const feed = await service.listVkParsing('channel-1', { userId: '183470701' } as never);
    expect(feed.summary).toBeNull();
    expect(feed.auditEvents).toEqual([]);
    expect(vkRateLimitService.getRecentVkApiMetrics).not.toHaveBeenCalled();
    expect(prisma.vkParsingMediaCache.count).not.toHaveBeenCalled();
    expect(prisma.vkParsingSource.count).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        omit: { raw: true, attachments: true, publishDialogContext: true },
      }),
    );
    prisma.$queryRaw.mockResolvedValueOnce([
      {
        attemptedSources: 2,
        successfulSources: 1,
        circuitOpenSourceCount: 1,
        p95SyncDurationMs: 1500,
      },
    ]);

    expect(feed.sources[0]).toMatchObject({
      syncStatus: 'BACKOFF',
      nextRetryAt: retryAt.toISOString(),
      terminalFailureCount: 1,
      circuitRetryAt: retryAt.toISOString(),
    });
    const summary = await service.getHealthSummary('channel-1', { userId: '183470701' } as never);
    expect(summary.staleSyncLockCount).toBe(2);
    expect(summary).toMatchObject({
      circuitOpenSourceCount: 1,
      importSuccessRate: 0.5,
      p95SyncDurationMs: 1500,
    });
  });

  it('persists attribution and deletion on first save without changing published posts', async () => {
    const { service, prisma, publishQueue } = createFixture();
    const patch = {
      sourceLinkEnabled: true,
      sourceLinkUrl: 'https://example.com/original',
      deleteAfterMinutes: 1440,
    };
    await service.updateSettings('channel-1', { userId: '183470701' } as never, patch);
    expect(prisma.vkParsingSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining(patch),
        update: patch,
      }),
    );
    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
    expect(publishQueue.add).not.toHaveBeenCalled();
  });

  it('updates VK parsing automation settings for a channel', async () => {
    const { service, prisma } = createFixture();
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T10:01:00.000Z'),
      stripLinksEnabled: true,
      skipAdsEnabled: true,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:05:00.000Z'),
    });

    const feed = await service.updateSettings('channel-1', { userId: '183470701' } as never, {
      autoPublishEnabled: true,
      stripLinksEnabled: true,
      skipAdsEnabled: true,
    });

    expect(prisma.vkParsingSettings.upsert).toHaveBeenCalledWith({
      where: {
        chatId_ownerProfile_ownerBotId: {
          chatId: 'channel-1',
          ownerProfile: VkParsingOwnerProfile.PUBLISHER,
          ownerBotId: 'publisher-bot',
        },
      },
      create: expect.objectContaining({
        chatId: 'channel-1',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-05-25T10:01:00.000Z'),
        stripLinksEnabled: true,
        skipAdsEnabled: true,
        autoPublishKillSwitchEnabled: false,
        workHoursStart: '09:00',
        workHoursEnd: '22:00',
      }),
      update: {
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-05-25T10:01:00.000Z'),
        autoPublishKillSwitchEnabled: false,
        stripLinksEnabled: true,
        skipAdsEnabled: true,
      },
    });
    expect(feed.settings).toMatchObject({
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: '2026-05-25T10:01:00.000Z',
      stripLinksEnabled: true,
      skipAdsEnabled: true,
      autoPublishKillSwitchEnabled: false,
      updatedAt: '2026-05-25T10:05:00.000Z',
    });
  });

  it('repairs healthy manual Publisher sources when global Auto is already enabled', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-28T09:00:00.000Z'));
    const { service, prisma, publishQueue } = createFixture();
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-08-27T09:00:00.000Z'),
      autoPublishKillSwitchEnabled: false,
      createdAt: new Date('2026-08-27T09:00:00.000Z'),
      updatedAt: new Date('2026-08-27T09:00:00.000Z'),
    });

    await service.updateSettings('channel-1', { userId: 'admin-1' } as never, {
      autoPublishMode: 'AUTO',
    });

    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith({
      where: {
        chatId: 'channel-1',
        ownerProfile: VkParsingOwnerProfile.PUBLISHER,
        ownerBotId: 'publisher-bot',
        status: 'ACTIVE',
        importEnabled: true,
        autoPublishEnabled: false,
        publishMode: { notIn: ['REVIEW', 'BOT_REVIEW'] },
        syncStatus: { not: 'ERROR' },
        terminalFailureCount: 0,
        circuitOpenedAt: null,
        OR: [
          { autoPublishPausedReason: null },
          { autoPublishPausedReason: { in: ['manual', 'preset'] } },
        ],
      },
      data: {
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-08-28T09:00:00.000Z'),
        autoPublishPausedAt: null,
        autoPublishPausedReason: null,
      },
    });
    const settingsWrite = prisma.vkParsingSettings.upsert.mock.calls[0]?.[0];
    expect(settingsWrite.create).not.toHaveProperty('autoPublishMode');
    expect(settingsWrite.update).not.toHaveProperty('autoPublishMode');
    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
    expect(publishQueue.add).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(readQueryRawSql(prisma)).toContain('FOR UPDATE OF chat');
  });

  it('resumes entity Pause without changing source Auto baselines or circuit state', async () => {
    const { service, prisma } = createFixture();
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-08-27T09:00:00.000Z'),
      autoPublishKillSwitchEnabled: true,
      createdAt: new Date('2026-08-27T09:00:00.000Z'),
      updatedAt: new Date('2026-08-27T09:00:00.000Z'),
    });

    await service.updateSettings('channel-1', { userId: 'admin-1' } as never, {
      autoPublishMode: 'AUTO',
    });

    expect(prisma.vkParsingSource.updateMany).not.toHaveBeenCalled();
    expect(prisma.vkParsingSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          autoPublishEnabled: true,
          autoPublishEnabledAt: new Date('2026-08-27T09:00:00.000Z'),
          autoPublishKillSwitchEnabled: false,
        },
      }),
    );
  });

  it('normalizes stale-client raw Auto flags into the source cascade', async () => {
    const { service, prisma } = createFixture();
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-08-27T09:00:00.000Z'),
      autoPublishKillSwitchEnabled: false,
    });

    await service.updateSettings('channel-1', { userId: 'admin-1' } as never, {
      autoPublishEnabled: true,
      autoPublishKillSwitchEnabled: false,
    });

    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ownerProfile: VkParsingOwnerProfile.PUBLISHER,
          ownerBotId: 'publisher-bot',
          autoPublishEnabled: false,
        }),
        data: expect.objectContaining({ autoPublishEnabled: true }),
      }),
    );
    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
  });

  it('normalizes stale-client raw Manual flags and clears automatic intents', async () => {
    const { service, prisma } = createFixture();
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-08-27T09:00:00.000Z'),
      autoPublishKillSwitchEnabled: true,
    });

    await service.updateSettings('channel-1', { userId: 'admin-1' } as never, {
      autoPublishEnabled: false,
      autoPublishKillSwitchEnabled: true,
    });

    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'ACTIVE' }),
        data: expect.objectContaining({
          autoPublishEnabled: false,
          autoPublishEnabledAt: null,
          autoPublishPausedReason: 'manual',
        }),
      }),
    );
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalled();
    expect(prisma.vkParsingSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ autoPublishKillSwitchEnabled: false }),
      }),
    );
  });

  it('normalizes stale-client raw Pause flags without changing sources or intents', async () => {
    const { service, prisma } = createFixture();
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-08-27T09:00:00.000Z'),
      autoPublishKillSwitchEnabled: false,
    });

    await service.updateSettings('channel-1', { userId: 'admin-1' } as never, {
      autoPublishEnabled: true,
      autoPublishKillSwitchEnabled: true,
    });

    expect(prisma.vkParsingSource.updateMany).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
    expect(prisma.vkParsingSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          autoPublishEnabled: true,
          autoPublishKillSwitchEnabled: true,
        }),
      }),
    );
  });

  it('cascades global Manual to every active Publisher source and clears queued autopublish', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-28T09:05:00.000Z'));
    const { service, prisma } = createFixture();
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-08-27T09:00:00.000Z'),
      autoPublishKillSwitchEnabled: false,
      createdAt: new Date('2026-08-27T09:00:00.000Z'),
      updatedAt: new Date('2026-08-27T09:00:00.000Z'),
    });

    await service.updateSettings('channel-1', { userId: 'admin-1' } as never, {
      autoPublishMode: 'MANUAL',
    });

    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith({
      where: {
        chatId: 'channel-1',
        ownerProfile: VkParsingOwnerProfile.PUBLISHER,
        ownerBotId: 'publisher-bot',
        status: 'ACTIVE',
      },
      data: {
        autoPublishEnabled: false,
        autoPublishEnabledAt: null,
        autoPublishPausedAt: new Date('2026-08-28T09:05:00.000Z'),
        autoPublishPausedReason: 'manual',
      },
    });
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'channel-1',
          ownerProfile: VkParsingOwnerProfile.PUBLISHER,
          ownerBotId: 'publisher-bot',
          OR: expect.arrayContaining([
            expect.objectContaining({ publishReason: 'autopublish' }),
            expect.objectContaining({
              publishReason: null,
              publishScheduleFingerprint: { not: null },
              publishQueuedAt: null,
              publishLockedAt: null,
              publishIdempotencyKey: null,
              publishScheduledAt: null,
              publishCancelledAt: null,
              publishCancelledByUserId: null,
              publishActorUserId: null,
              dispatchBlockerCode: null,
              dispatchBlockedAt: null,
            }),
          ]),
        }),
      }),
    );
  });

  it('keeps source Auto flags unchanged when the entity is temporarily paused', async () => {
    const { service, prisma } = createFixture();
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-08-27T09:00:00.000Z'),
      autoPublishKillSwitchEnabled: false,
      createdAt: new Date('2026-08-27T09:00:00.000Z'),
      updatedAt: new Date('2026-08-27T09:00:00.000Z'),
    });

    await service.updateSettings('channel-1', { userId: 'admin-1' } as never, {
      autoPublishMode: 'PAUSED',
    });

    expect(prisma.vkParsingSource.updateMany).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
    expect(prisma.vkParsingSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { autoPublishKillSwitchEnabled: true },
      }),
    );
  });

  it('rejects an autopublish dry-run for a missing owned active source', async () => {
    const { service, prisma } = createFixture();
    prisma.vkParsingSource.findMany.mockResolvedValue([]);

    await expect(
      service.dryRunAutoPublish('channel-1', { userId: 'admin-1' } as never, {
        sourceId: 'missing-source',
      }),
    ).rejects.toThrow('VK-источник не найден.');

    expect(prisma.vkParsingSource.findMany).toHaveBeenCalledWith({
      where: {
        chatId: 'channel-1',
        ownerProfile: VkParsingOwnerProfile.PUBLISHER,
        ownerBotId: 'publisher-bot',
        status: 'ACTIVE',
        id: 'missing-source',
      },
    });
  });

  it('enables the Publisher VK channel link only from the exact Publisher catalog', async () => {
    const { service, prisma, maxClient } = createFixture({
      MAX_PUBLISHER_BOT_ID: 'publisher-bot',
    });
    prisma.managedBotChatCatalog.findFirst.mockResolvedValue({
      link: 'https://max.ru/our-publisher-channel',
    });

    await service.updateSettings('channel-1', { userId: '183470701' } as never, {
      appendChannelLinkEnabled: true,
      channelLinkText: 'Наш канал',
    });

    expect(prisma.vkParsingSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          chatId_ownerProfile_ownerBotId: {
            chatId: 'channel-1',
            ownerProfile: VkParsingOwnerProfile.PUBLISHER,
            ownerBotId: 'publisher-bot',
          },
        },
        create: expect.objectContaining({
          appendChannelLinkEnabled: true,
          channelLinkText: 'Наш канал',
        }),
        update: {
          appendChannelLinkEnabled: true,
          channelLinkText: 'Наш канал',
        },
      }),
    );
    expect(prisma.channelAudienceSnapshot.findFirst).not.toHaveBeenCalled();
    expect(prisma.managedBotChatCatalog.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ botId: 'publisher-bot' }),
      }),
    );
    expect(maxClient.getChatSnapshot).not.toHaveBeenCalled();
  });

  it('clears queued VK autopublish state when autoposting is disabled', async () => {
    const { service, prisma } = createFixture();
    prisma.vkParsingSettings.findUnique
      .mockResolvedValueOnce({
        id: 'settings-1',
        chatId: 'channel-1',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-05-25T10:01:00.000Z'),
        stripLinksEnabled: false,
        skipAdsEnabled: false,
        createdAt: new Date('2026-05-25T10:00:00.000Z'),
        updatedAt: new Date('2026-05-25T10:05:00.000Z'),
      })
      .mockResolvedValueOnce({
        id: 'settings-1',
        chatId: 'channel-1',
        autoPublishEnabled: false,
        autoPublishEnabledAt: null,
        stripLinksEnabled: false,
        skipAdsEnabled: false,
        createdAt: new Date('2026-05-25T10:00:00.000Z'),
        updatedAt: new Date('2026-05-25T10:06:00.000Z'),
      });

    await service.updateSettings('channel-1', { userId: '183470701' } as never, {
      autoPublishEnabled: false,
    });

    expect(prisma.vkParsingSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          autoPublishEnabled: false,
          autoPublishEnabledAt: null,
          autoPublishKillSwitchEnabled: false,
        },
      }),
    );
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'channel-1',
          status: { in: ['NEW', 'FAILED'] },
        }),
        data: {
          publishQueuedAt: null,
          publishLockedAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
          publishScheduledAt: null,
          publishScheduleFingerprint: null,
        },
      }),
    );
  });

  it('rejects an invalid VK scheduler timezone instead of silently saving Moscow behavior', async () => {
    const { service, prisma } = createFixture();

    await expect(
      service.updateSettings('channel-1', { userId: 'admin-1' } as never, {
        schedulerTimezone: 'Mars/Olympus',
      }),
    ).rejects.toThrow('корректный часовой пояс IANA');

    expect(prisma.vkParsingSettings.upsert).not.toHaveBeenCalled();
  });

  it('validates active source quiet hours in bounded keyset pages', async () => {
    const { service, prisma } = createFixture();
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-09-04T08:00:00.000Z'),
      autoPublishKillSwitchEnabled: false,
      schedulerTimezone: 'UTC',
      quietHoursStart: null,
      quietHoursEnd: null,
      workHoursStart: '00:00',
      workHoursEnd: '00:00',
    });
    const sources = Array.from({ length: 501 }, (_, index) => ({
      id: `source-${String(index + 1).padStart(4, '0')}`,
      quietHoursStart: index === 500 ? '09:00' : null,
      quietHoursEnd: index === 500 ? '18:00' : null,
    }));
    prisma.vkParsingSource.findMany
      .mockResolvedValueOnce(sources.slice(0, 500))
      .mockResolvedValueOnce(sources.slice(500));

    await expect(
      service.updateSettings('channel-1', { userId: 'admin-1' } as never, {
        workHoursStart: '09:00',
        workHoursEnd: '18:00',
      }),
    ).rejects.toThrow('Рабочее время полностью перекрыто паузами публикации.');

    expect(prisma.vkParsingSource.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.vkParsingSource.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        orderBy: { id: 'asc' },
        take: 500,
      }),
    );
    expect(prisma.vkParsingSource.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({ id: { gt: 'source-0500' } }),
        orderBy: { id: 'asc' },
        take: 500,
      }),
    );
    expect(prisma.vkParsingSettings.upsert).not.toHaveBeenCalled();
  });

  it('validates manually paused source quiet hours before global Auto enables them', async () => {
    const { service, prisma } = createFixture();
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      autoPublishEnabled: false,
      autoPublishEnabledAt: null,
      autoPublishKillSwitchEnabled: false,
      schedulerTimezone: 'UTC',
      quietHoursStart: null,
      quietHoursEnd: null,
      workHoursStart: '09:00',
      workHoursEnd: '18:00',
    });
    prisma.vkParsingSource.findMany.mockResolvedValue([
      { id: 'source-1', quietHoursStart: '09:00', quietHoursEnd: '18:00' },
    ]);

    await expect(
      service.updateSettings('channel-1', { userId: 'admin-1' } as never, {
        autoPublishMode: 'AUTO',
      }),
    ).rejects.toThrow('Рабочее время полностью перекрыто паузами публикации.');

    expect(prisma.vkParsingSource.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({ autoPublishEnabled: true, autoPublishPausedAt: null }),
            expect.objectContaining({
              autoPublishEnabled: false,
              syncStatus: { not: 'ERROR' },
              OR: expect.arrayContaining([
                { autoPublishPausedReason: null },
                { autoPublishPausedReason: { in: ['manual', 'preset'] } },
              ]),
            }),
          ]),
        }),
      }),
    );
    expect(prisma.vkParsingSettings.upsert).not.toHaveBeenCalled();
  });

  it('clears queued VK autopublish state when a source is switched to review mode', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findFirst.mockResolvedValue(source);

    await service.updateSource('channel-1', 'source-1', { userId: '183470701' } as never, {
      publishMode: 'REVIEW',
    });

    expect(prisma.vkParsingSource.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'source-1' },
        data: expect.objectContaining({
          publishMode: 'REVIEW',
        }),
      }),
    );
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'channel-1',
          sourceId: { in: ['source-1'] },
          status: { in: ['NEW', 'FAILED'] },
        }),
        data: expect.objectContaining({
          publishQueuedAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
        }),
      }),
    );
    expect(readQueryRawSql(prisma)).toContain('FOR UPDATE OF chat');
  });

  it('lowers a stale minimum pause when the requested publish interval becomes shorter', async () => {
    const { service, prisma } = createFixture();
    prisma.vkParsingSource.findFirst.mockResolvedValue(
      createSource({ publishIntervalMinutes: 180, minPublishIntervalMinutes: 180 }),
    );

    await service.updateSource('channel-1', 'source-1', { userId: 'admin-1' } as never, {
      publishIntervalMinutes: 30,
    });

    expect(prisma.vkParsingSource.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          publishIntervalMinutes: 30,
          minPublishIntervalMinutes: 30,
        }),
      }),
    );
  });

  it('serializes source update, preset, and removal behind the parent Chat lock', async () => {
    const { service, prisma } = createFixture();
    const source = createPublisherSource();
    prisma.vkParsingSource.findFirst.mockResolvedValue(source);
    prisma.vkParsingSource.findMany.mockResolvedValue([]);

    await service.updateSource('channel-1', 'source-1', { userId: 'admin-1' } as never, {
      priority: 'HIGH',
    });
    await service.applySourcePreset('channel-1', { userId: 'admin-1' } as never, {
      sourceIds: ['source-1'],
      preset: 'NEWS',
    });
    await service.removeSource('channel-1', 'source-1', { userId: 'admin-1' } as never);

    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    const lockMatches = readQueryRawSql(prisma).match(/FOR UPDATE OF chat/gu) ?? [];
    expect(lockMatches).toHaveLength(3);
  });

  it('keeps existing source Auto baselines when applying an Auto preset', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-28T09:30:00.000Z'));
    const { service, prisma } = createFixture();
    prisma.vkParsingSource.findMany.mockResolvedValue([]);

    await service.applySourcePreset('channel-1', { userId: 'admin-1' } as never, {
      sourceIds: ['source-1'],
      preset: 'NEWS',
    });

    const [alreadyEnabledWrite, newlyEnabledWrite] = prisma.vkParsingSource.updateMany.mock.calls;
    expect(newlyEnabledWrite?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({ autoPublishEnabled: false }),
        data: expect.objectContaining({
          autoPublishEnabled: true,
          autoPublishEnabledAt: new Date('2026-08-28T09:30:00.000Z'),
        }),
      }),
    );
    expect(alreadyEnabledWrite?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({ autoPublishEnabled: true }),
        data: expect.objectContaining({ autoPublishEnabled: true }),
      }),
    );
    expect(alreadyEnabledWrite?.[0]?.data).not.toHaveProperty('autoPublishEnabledAt');
    expect(alreadyEnabledWrite?.[0]?.data).not.toHaveProperty('autoPublishPausedAt');
    expect(alreadyEnabledWrite?.[0]?.data).not.toHaveProperty('autoPublishPausedReason');
  });

  it('adds a VK source from the wall owner, not the first extended group', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          groups: [
            { id: 1, screen_name: 'unrelated_group', name: 'Чужая группа' },
            { id: 36819802, screen_name: 'avto_prodaja_rb', name: 'Авторынок Уфа' },
          ],
          items: [{ owner_id: -36819802, id: 101, date: 1_779_708_000, text: 'Пост' }],
        },
      }),
    ) as unknown as typeof fetch;
    prisma.vkParsingSource.upsert.mockResolvedValue(source);

    await service.addSource('channel-1', { userId: '183470701' } as never, {
      url: 'https://vk.com/avto_prodaja_rb',
    });

    expect(prisma.vkParsingSource.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          chatId_ownerProfile_ownerBotId_wallOwnerId: {
            chatId: 'channel-1',
            ownerProfile: VkParsingOwnerProfile.PUBLISHER,
            ownerBotId: 'publisher-bot',
            wallOwnerId: -36819802,
          },
        },
        create: expect.objectContaining({
          ownerId: 36819802,
          wallOwnerId: -36819802,
          screenName: 'avto_prodaja_rb',
          title: 'Авторынок Уфа',
          url: 'https://vk.ru/avto_prodaja_rb',
        }),
        update: expect.objectContaining({
          ownerId: 36819802,
          screenName: 'avto_prodaja_rb',
          title: 'Авторынок Уфа',
          url: 'https://vk.ru/avto_prodaja_rb',
        }),
      }),
    );
  });

  it('adds a Publisher VK source in Auto when entity Auto is enabled', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-28T10:00:00.000Z'));
    const { service, prisma } = createFixture();
    mockVkSourceLookup();
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      autoPublishEnabled: true,
      autoPublishKillSwitchEnabled: false,
    });
    prisma.vkParsingSource.upsert.mockResolvedValue(createPublisherSource());

    await service.addSource('channel-1', { userId: 'admin-1' } as never, {
      url: 'https://vk.com/avto_prodaja_rb',
    });

    expect(prisma.vkParsingSettings.findUnique).toHaveBeenCalledWith({
      where: {
        chatId_ownerProfile_ownerBotId: {
          chatId: 'channel-1',
          ownerProfile: VkParsingOwnerProfile.PUBLISHER,
          ownerBotId: 'publisher-bot',
        },
      },
      select: { autoPublishEnabled: true },
    });
    expect(prisma.vkParsingSource.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          autoPublishEnabled: true,
          autoPublishEnabledAt: new Date('2026-08-28T10:00:00.000Z'),
          autoPublishPausedAt: null,
          autoPublishPausedReason: null,
        }),
      }),
    );
  });

  it('adds a Publisher VK source with desired Auto preserved during entity Pause', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-28T10:05:00.000Z'));
    const { service, prisma } = createFixture();
    mockVkSourceLookup();
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      autoPublishEnabled: true,
      autoPublishKillSwitchEnabled: true,
    });
    prisma.vkParsingSource.upsert.mockResolvedValue(createPublisherSource());

    await service.addSource('channel-1', { userId: 'admin-1' } as never, {
      url: 'https://vk.com/avto_prodaja_rb',
    });

    expect(prisma.vkParsingSource.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          autoPublishEnabled: true,
          autoPublishEnabledAt: new Date('2026-08-28T10:05:00.000Z'),
          autoPublishPausedAt: null,
          autoPublishPausedReason: null,
        }),
      }),
    );
  });

  it('keeps an already active Publisher VK source and its sync lease unchanged on re-add', async () => {
    const { service, prisma, syncQueue } = createFixture();
    mockVkSourceLookup();
    const activeSource = createPublisherSource({
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-08-27T08:00:00.000Z'),
      autoPublishPausedAt: new Date('2026-08-28T08:00:00.000Z'),
      autoPublishPausedReason: 'max.access_lost',
      syncStatus: 'SYNCING',
      syncLockedAt: new Date('2026-08-28T09:59:00.000Z'),
      syncLockedBy: 'worker-existing',
      syncLockDeadlineAt: new Date('2026-08-28T10:01:00.000Z'),
      circuitOpenedAt: new Date('2026-08-28T09:58:00.000Z'),
      circuitReasonCode: 'max.access_lost',
    });
    prisma.vkParsingSource.findUnique.mockResolvedValue(activeSource);

    const result = await service.addSource('channel-1', { userId: 'admin-1' } as never, {
      url: 'https://vk.com/avto_prodaja_rb',
    });

    expect(result.queued).toBe(0);
    expect(prisma.vkParsingSource.upsert).not.toHaveBeenCalled();
    expect(prisma.vkParsingSource.updateMany).not.toHaveBeenCalled();
    expect(syncQueue.add).not.toHaveBeenCalled();
    expect(prisma.vkParsingSettings.findUnique).not.toHaveBeenCalledWith(
      expect.objectContaining({ select: { autoPublishEnabled: true } }),
    );
  });

  it('reactivates a removed Publisher VK source in Auto with a fresh baseline', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-28T10:10:00.000Z'));
    const { service, prisma } = createFixture();
    mockVkSourceLookup();
    prisma.vkParsingSettings.findUnique.mockResolvedValue({ autoPublishEnabled: true });
    prisma.vkParsingSource.upsert.mockResolvedValue(
      createPublisherSource({
        status: 'DISABLED',
        autoPublishEnabled: false,
        autoPublishEnabledAt: null,
        autoPublishPausedAt: new Date('2026-08-28T09:00:00.000Z'),
        autoPublishPausedReason: 'removed',
      }),
    );
    prisma.vkParsingSource.findUnique.mockResolvedValue(
      createPublisherSource({
        status: 'DISABLED',
        autoPublishEnabled: false,
        autoPublishEnabledAt: null,
        autoPublishPausedAt: new Date('2026-08-28T09:00:00.000Z'),
        autoPublishPausedReason: 'removed',
      }),
    );

    await service.addSource('channel-1', { userId: 'admin-1' } as never, {
      url: 'https://vk.com/avto_prodaja_rb',
    });

    expect(prisma.vkParsingSource.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: 'ACTIVE',
          importEnabled: true,
          autoPublishEnabled: true,
          autoPublishEnabledAt: new Date('2026-08-28T10:10:00.000Z'),
          autoPublishPausedAt: null,
          autoPublishPausedReason: null,
        }),
      }),
    );
    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
  });

  it('reactivates a removed Publisher VK source in Manual when entity Auto is disabled', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-28T10:15:00.000Z'));
    const { service, prisma } = createFixture();
    mockVkSourceLookup();
    prisma.vkParsingSettings.findUnique.mockResolvedValue({ autoPublishEnabled: false });
    prisma.vkParsingSource.upsert.mockResolvedValue(
      createPublisherSource({
        status: 'DISABLED',
        autoPublishEnabled: false,
        autoPublishEnabledAt: null,
        autoPublishPausedAt: new Date('2026-08-28T09:00:00.000Z'),
        autoPublishPausedReason: 'removed',
      }),
    );
    prisma.vkParsingSource.findUnique.mockResolvedValue(
      createPublisherSource({
        status: 'DISABLED',
        autoPublishEnabled: false,
        autoPublishEnabledAt: null,
        autoPublishPausedAt: new Date('2026-08-28T09:00:00.000Z'),
        autoPublishPausedReason: 'removed',
      }),
    );

    await service.addSource('channel-1', { userId: 'admin-1' } as never, {
      url: 'https://vk.com/avto_prodaja_rb',
    });

    expect(prisma.vkParsingSource.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: 'ACTIVE',
          importEnabled: true,
          autoPublishEnabled: false,
          autoPublishEnabledAt: null,
          autoPublishPausedAt: new Date('2026-08-28T10:15:00.000Z'),
          autoPublishPausedReason: 'manual',
        }),
      }),
    );
    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
  });

  it('keeps persisted history before a fresh source Auto baseline ineligible', async () => {
    const { publishService, prisma, publishQueue } = createFixture();
    const baseline = new Date('2026-08-28T10:20:00.000Z');
    const source = createPublisherSource({
      autoPublishEnabled: true,
      autoPublishEnabledAt: baseline,
      autoPublishPausedAt: null,
      autoPublishPausedReason: null,
      lastSuccessAt: new Date('2026-08-28T10:00:00.000Z'),
    });
    const historicalPost = createPostRow({
      source,
      ownerProfile: VkParsingOwnerProfile.PUBLISHER,
      ownerBotId: 'publisher-bot',
      createdAt: new Date('2026-08-28T09:00:00.000Z'),
      vkPublishedAt: new Date('2026-08-28T08:55:00.000Z'),
      publishScheduleFingerprint: null,
    });
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      autoPublishEnabled: true,
      autoPublishEnabledAt: baseline,
      autoPublishKillSwitchEnabled: false,
    });

    await publishService.enqueueAutoPublishImportedPosts('channel-1', [historicalPost] as never);

    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
    expect(publishQueue.add).not.toHaveBeenCalled();
  });

  it('arms a pending post whose transaction createdAt predates the Auto baseline', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-28T10:30:00.000Z'));
    const { publishService, prisma, publishQueue } = createFixture();
    const baseline = new Date('2026-08-28T10:20:00.000Z');
    const source = createSource({
      autoPublishEnabled: true,
      autoPublishEnabledAt: baseline,
      autoPublishPausedAt: null,
    });
    const post = createPostRow({
      source,
      createdAt: new Date('2026-08-28T10:19:59.000Z'),
      vkPublishedAt: new Date('2026-08-28T10:20:01.000Z'),
      publishScheduleFingerprint: VK_AUTOPUBLISH_PENDING_SCHEDULE_FINGERPRINT,
    });
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      autoPublishEnabled: true,
      autoPublishEnabledAt: baseline,
      autoPublishKillSwitchEnabled: true,
      schedulerTimezone: 'UTC',
      workHoursStart: '00:00',
      workHoursEnd: '00:00',
      distributeEvenlyEnabled: true,
      roundRobinEnabled: false,
      circuitBreakerEnabled: true,
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });

    await publishService.enqueueAutoPublishImportedPosts('channel-1', [post] as never);

    expect(prisma.vkParsingPost.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        chatId: 'channel-1',
        sourceId: 'source-1',
        autoPublishedAt: {
          gte: new Date('2026-08-28T00:00:00.000Z'),
          lt: new Date('2026-08-29T00:00:00.000Z'),
        },
      }),
    });
    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { publishScheduleFingerprint: null } }),
    );
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'post-1' }),
        data: expect.objectContaining({
          publishQueuedAt: new Date('2026-08-28T10:30:00.000Z'),
          publishReason: 'autopublish',
        }),
      }),
    );
    expect(publishQueue.add).toHaveBeenCalledWith(
      'publish-vk-post',
      expect.objectContaining({ postId: 'post-1', reason: 'autopublish' }),
      expect.objectContaining({ attempts: 5 }),
    );
  });

  it.each([false, true])(
    'stops an exact pre-dispatch refusal once per batch (lease=%s)',
    async (leased) => {
      const { publishService, prisma, publisherReadiness, publishQueue, maxClient } =
        createFixture();
      const source = createSource({ syncLockedBy: 'sync-attempt', syncAttemptCount: 7 });
      const posts = Array.from({ length: 3 }, (_, index) =>
        createPostRow({
          source,
          id: `post-${index}`,
          vkPostId: 100 + index,
          publishScheduleFingerprint: VK_AUTOPUBLISH_PENDING_SCHEDULE_FINGERPRINT,
        }),
      );
      prisma.vkParsingPost.findFirst.mockResolvedValue(posts[0]);
      prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date(0),
        autoPublishKillSwitchEnabled: false,
        circuitBreakerEnabled: false,
      });
      publisherReadiness.assertEntityReady.mockRejectedValueOnce(
        new PublisherSetupRequiredException(['channel-1'], 'write_permission_missing'),
      );
      await publishService.enqueueAutoPublishImportedPosts(
        'channel-1',
        posts as never,
        leased ? (source as never) : undefined,
      );
      expect(publisherReadiness.assertEntityReady).toHaveBeenCalledTimes(1);
      expect(publishQueue.add).not.toHaveBeenCalled();
      expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
      expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ publishReason: 'autopublish' }),
        }),
      );
      // A refusal is local to this batch. A subsequent valid proof permits the same candidates.
      publisherReadiness.assertEntityReady.mockClear();
      await publishService.enqueueAutoPublishImportedPosts(
        'channel-1',
        posts as never,
        leased ? (source as never) : undefined,
      );
      expect(publisherReadiness.assertEntityReady).toHaveBeenCalledTimes(3);
      expect(publishQueue.add).toHaveBeenCalledTimes(3);
    },
  );

  it.each([
    new Error('temporary route failure'),
    new PublisherSetupRequiredException(['another-chat'], 'write_permission_missing'),
  ])('does not stop unrelated candidates for an unproved scope refusal', async (error) => {
    const { publishService, prisma, publisherReadiness, publishQueue } = createFixture();
    const posts = [1, 2, 3].map((index) => createPostRow({ id: `post-${index}`, vkPostId: index }));
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date(0),
      circuitBreakerEnabled: false,
    });
    publisherReadiness.assertEntityReady.mockRejectedValueOnce(error);
    await publishService.enqueueAutoPublishImportedPosts('channel-1', posts as never);
    expect(publisherReadiness.assertEntityReady).toHaveBeenCalledTimes(3);
    expect(publishQueue.add).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])(
    'preserves pending imports across passes while exact durable access is denied (lease=%s)',
    async (leased) => {
      const { publishService, prisma, publisherReadiness, publishQueue } = createFixture();
      const source = createSource({ syncLockedBy: 'sync-attempt', syncAttemptCount: 7 });
      const post = createPostRow({
        source,
        publishScheduleFingerprint: VK_AUTOPUBLISH_PENDING_SCHEDULE_FINGERPRINT,
      });
      prisma.publisherEntityBinding.findUnique.mockResolvedValue({
        publisherBotId: 'publisher-bot',
        status: 'ACTIVE',
        botAccessState: 'CONFIRMED_ADMIN',
        permissionsSnapshot: {
          isAdmin: true,
          isOwner: false,
          permissionsKnown: true,
          permissions: [],
        },
      });
      for (let pass = 0; pass < 2; pass += 1) {
        await publishService.enqueueAutoPublishImportedPosts(
          'channel-1',
          [post] as never,
          leased ? (source as never) : undefined,
        );
      }
      expect(prisma.publisherEntityBinding.findUnique).toHaveBeenCalledTimes(2);
      expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
      expect(prisma.vkParsingSource.updateMany).not.toHaveBeenCalled();
      expect(publisherReadiness.assertEntityReady).not.toHaveBeenCalled();
      expect(publishQueue.add).not.toHaveBeenCalled();
      expect(post.publishScheduleFingerprint).toBe(VK_AUTOPUBLISH_PENDING_SCHEDULE_FINGERPRINT);
    },
  );

  it('uses current source policy instead of an imported snapshot while holding the sync lease', async () => {
    const { publishService, prisma, publishQueue } = createFixture();
    const source = createSource({ syncLockedBy: 'sync-attempt', syncAttemptCount: 7 });
    const candidate = createPostRow({
      source,
      publishScheduleFingerprint: VK_AUTOPUBLISH_PENDING_SCHEDULE_FINGERPRINT,
    });
    const current = createPostRow({
      source: { ...source, autoPublishEnabled: false },
      publishScheduleFingerprint: VK_AUTOPUBLISH_PENDING_SCHEDULE_FINGERPRINT,
    });
    prisma.vkParsingPost.findFirst.mockResolvedValue(current);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date(0),
    });

    await publishService.enqueueAutoPublishImportedPosts(
      'channel-1',
      [candidate] as never,
      source as never,
    );

    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { publishScheduleFingerprint: null },
      }),
    );
    expect(publishQueue.add).not.toHaveBeenCalled();
  });

  it('does not claim a publish intent after sync ownership is lost during route preparation', async () => {
    const { publishService, prisma, publishQueue } = createFixture();
    const source = createSource({ syncLockedBy: 'sync-attempt', syncAttemptCount: 7 });
    const post = createPostRow({
      source,
      publishScheduleFingerprint: VK_AUTOPUBLISH_PENDING_SCHEDULE_FINGERPRINT,
    });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date(0),
      autoPublishKillSwitchEnabled: false,
      circuitBreakerEnabled: false,
    });
    let leaseChecks = 0;
    prisma.$queryRaw.mockImplementation(
      async (query: { strings?: readonly string[] } | TemplateStringsArray) => {
        const sql = Array.isArray(query)
          ? query.join('')
          : ((query as { strings?: readonly string[] }).strings?.join('') ?? '');
        if (sql.includes('FROM "vk_parsing_sources"') && ++leaseChecks === 3) return [];
        return [{ id: 'channel-1' }];
      },
    );

    await expect(
      publishService.enqueueAutoPublishImportedPosts('channel-1', [post] as never, source as never),
    ).rejects.toThrow('no longer owns');

    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ publishReason: 'autopublish' }),
      }),
    );
    expect(publishQueue.add).not.toHaveBeenCalled();
  });

  it('keeps the requested VK source when extended groups omit the wall owner', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          groups: [{ id: 1, screen_name: 'unrelated_group', name: 'Чужая группа' }],
          items: [{ owner_id: -36819802, id: 101, date: 1_779_708_000, text: 'Пост' }],
        },
      }),
    ) as unknown as typeof fetch;
    prisma.vkParsingSource.upsert.mockResolvedValue(source);

    await service.addSource('channel-1', { userId: '183470701' } as never, {
      url: 'https://vk.com/avto_prodaja_rb',
    });

    expect(prisma.vkParsingSource.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          chatId_ownerProfile_ownerBotId_wallOwnerId: {
            chatId: 'channel-1',
            ownerProfile: VkParsingOwnerProfile.PUBLISHER,
            ownerBotId: 'publisher-bot',
            wallOwnerId: -36819802,
          },
        },
        create: expect.objectContaining({
          ownerId: 36819802,
          wallOwnerId: -36819802,
          screenName: 'avto_prodaja_rb',
          title: 'avto_prodaja_rb',
          url: 'https://vk.ru/avto_prodaja_rb',
        }),
        update: expect.objectContaining({
          ownerId: 36819802,
          screenName: 'avto_prodaja_rb',
          title: 'avto_prodaja_rb',
          url: 'https://vk.ru/avto_prodaja_rb',
        }),
      }),
    );
  });

  it('rejects malformed VK source links as bad requests', async () => {
    const { service } = createFixture();

    await expect(
      service.addSource('channel-1', { userId: '183470701' } as never, {
        url: 'https://',
      }),
    ).rejects.toThrow('Некорректная ссылка на VK-сообщество.');
  });

  it('does not reset an active VK source sync lease on manual refresh', async () => {
    const { service, prisma, syncQueue } = createFixture();
    const source = createSource({
      syncStatus: 'SYNCING',
      syncLockedAt: new Date('2026-05-25T10:00:00.000Z'),
      syncLockedBy: 'worker-1',
      syncLockDeadlineAt: new Date(Date.now() + 60_000),
      syncHeartbeatAt: new Date('2026-05-25T10:00:15.000Z'),
    });
    prisma.vkParsingSource.findFirst.mockResolvedValue(source);
    prisma.vkParsingSource.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await service.refreshSource('channel-1', 'source-1', {
      userId: '183470701',
    } as never);

    expect(result.queued).toBe(0);
    expect(syncQueue.add).not.toHaveBeenCalled();
    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'source-1',
          OR: expect.arrayContaining([
            expect.objectContaining({
              syncStatus: 'SYNCING',
            }),
          ]),
        }),
      }),
    );
  });

  it('keeps a manual source refresh accepted when the BullMQ add fails after the database CAS', async () => {
    const { service, prisma, syncQueue } = createFixture();
    prisma.vkParsingSource.findFirst.mockResolvedValue(createSource());
    syncQueue.add.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(
      service.refreshSource('channel-1', 'source-1', {
        userId: '183470701',
      } as never),
    ).resolves.toMatchObject({ queued: 1 });

    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'source-1' }),
        data: expect.objectContaining({
          syncStatus: 'QUEUED',
          nextSyncAt: expect.any(Date),
        }),
      }),
    );
    expect(syncQueue.add).toHaveBeenCalledWith(
      'sync-vk-source',
      expect.objectContaining({ sourceId: 'source-1', reason: 'manual' }),
      expect.objectContaining({ jobId: 'vk-parsing-sync__source-1' }),
    );
  });

  it('keeps a durable manual source refresh accepted when the exact BullMQ state is unavailable', async () => {
    const { service, prisma, syncQueue } = createFixture();
    prisma.vkParsingSource.findFirst.mockResolvedValue(createSource());
    syncQueue.getJob.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(
      service.refreshSource('channel-1', 'source-1', {
        userId: '183470701',
      } as never),
    ).resolves.toMatchObject({ queued: 1 });

    expect(syncQueue.add).not.toHaveBeenCalled();
  });

  it('continues a manual all-source refresh after one BullMQ add failure', async () => {
    const { service, prisma, syncQueue } = createFixture();
    prisma.vkParsingSource.findMany.mockResolvedValueOnce([
      createSource({ id: 'source-1' }),
      createSource({ id: 'source-2' }),
    ]);
    syncQueue.add.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(
      service.refresh('channel-1', { userId: '183470701' } as never),
    ).resolves.toMatchObject({ queued: 2 });

    expect(syncQueue.add).toHaveBeenCalledTimes(2);
    expect(syncQueue.add).toHaveBeenNthCalledWith(
      2,
      'sync-vk-source',
      expect.objectContaining({ sourceId: 'source-2', reason: 'manual' }),
      expect.objectContaining({ jobId: 'vk-parsing-sync__source-2' }),
    );
  });

  it('recovers an existing failed VK source sync job instead of leaving it failed', async () => {
    const { service, prisma, syncQueue } = createFixture();
    const source = createSource({
      syncStatus: 'QUEUED',
      updatedAt: new Date('2026-05-25T09:55:00.000Z'),
    });
    const failedJob = createSyncQueueJob('failed', { reason: 'manual' });
    prisma.vkParsingSource.findFirst.mockResolvedValue(source);
    prisma.vkParsingSource.updateMany.mockResolvedValueOnce({ count: 1 });
    syncQueue.getJob.mockResolvedValueOnce(failedJob);

    const result = await service.refreshSource('channel-1', 'source-1', {
      userId: '183470701',
    } as never);

    expect(result.queued).toBe(1);
    expect(syncQueue.getJob).toHaveBeenCalledWith('vk-parsing-sync__source-1');
    expect(failedJob.updateData).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceId: 'source-1',
        reason: 'manual',
        ownerProfile: 'PUBLISHER',
        ownerBotId: 'publisher-bot',
        retryPolicyName: 'vk-parsing-sync',
      }),
    );
    expect(failedJob.retry).toHaveBeenCalledWith('failed', {
      resetAttemptsMade: true,
      resetAttemptsStarted: true,
    });
    expect(syncQueue.add).not.toHaveBeenCalled();
  });

  it('replaces an orphaned VK source sync job whose BullMQ state is unknown', async () => {
    const { service, prisma, syncQueue } = createFixture();
    const source = createSource({
      syncStatus: 'QUEUED',
      updatedAt: new Date('2026-05-25T09:55:00.000Z'),
    });
    const orphanedJob = createQueueJob('unknown');
    prisma.vkParsingSource.findFirst.mockResolvedValue(source);
    prisma.vkParsingSource.updateMany.mockResolvedValueOnce({ count: 1 });
    syncQueue.getJob.mockResolvedValueOnce(orphanedJob);

    const result = await service.refreshSource('channel-1', 'source-1', {
      userId: '183470701',
    } as never);

    expect(result.queued).toBe(1);
    expect(orphanedJob.remove).toHaveBeenCalledTimes(1);
    expect(syncQueue.add).toHaveBeenCalledWith(
      'sync-vk-source',
      expect.objectContaining({ sourceId: 'source-1', reason: 'manual' }),
      expect.objectContaining({ jobId: 'vk-parsing-sync__source-1' }),
    );
  });

  it.each(['waiting', 'delayed', 'failed', 'completed'])(
    'replaces an inactive %s VK source sync job with a stale ownership envelope',
    async (state) => {
      const { service, prisma, syncQueue } = createFixture();
      const source = createSource({
        syncStatus: 'QUEUED',
        updatedAt: new Date('2026-05-25T09:55:00.000Z'),
      });
      const staleJob = createSyncQueueJob(state, {
        ownerProfile: 'MAJOR',
        ownerBotId: '',
      });
      prisma.vkParsingSource.findFirst.mockResolvedValue(source);
      prisma.vkParsingSource.updateMany.mockResolvedValueOnce({ count: 1 });
      syncQueue.getJob.mockResolvedValueOnce(staleJob);

      const result = await service.refreshSource('channel-1', 'source-1', {
        userId: '183470701',
      } as never);

      expect(result.queued).toBe(1);
      expect(staleJob.remove).toHaveBeenCalledTimes(1);
      expect(staleJob.updateData).not.toHaveBeenCalled();
      expect(staleJob.retry).not.toHaveBeenCalled();
      expect(syncQueue.add).toHaveBeenCalledWith(
        'sync-vk-source',
        expect.objectContaining({
          sourceId: 'source-1',
          ownerProfile: 'PUBLISHER',
          ownerBotId: 'publisher-bot',
        }),
        expect.objectContaining({ jobId: 'vk-parsing-sync__source-1' }),
      );
    },
  );

  it('replaces an inactive VK source sync job with a stale reason', async () => {
    const { service, prisma, syncQueue } = createFixture();
    const source = createSource({
      syncStatus: 'QUEUED',
      updatedAt: new Date('2026-05-25T09:55:00.000Z'),
    });
    const staleJob = createSyncQueueJob('waiting', { reason: 'source-added' });
    prisma.vkParsingSource.findFirst.mockResolvedValue(source);
    prisma.vkParsingSource.updateMany.mockResolvedValueOnce({ count: 1 });
    syncQueue.getJob.mockResolvedValueOnce(staleJob);

    const result = await service.refreshSource('channel-1', 'source-1', {
      userId: '183470701',
    } as never);

    expect(result.queued).toBe(1);
    expect(staleJob.remove).toHaveBeenCalledTimes(1);
    expect(syncQueue.add).toHaveBeenCalledWith(
      'sync-vk-source',
      expect.objectContaining({ sourceId: 'source-1', reason: 'manual' }),
      expect.objectContaining({ jobId: 'vk-parsing-sync__source-1' }),
    );
  });

  it('replaces an inactive VK source sync job with malformed data', async () => {
    const { service, prisma, syncQueue } = createFixture();
    const source = createSource({
      syncStatus: 'QUEUED',
      updatedAt: new Date('2026-05-25T09:55:00.000Z'),
    });
    const staleJob = createSyncQueueJob('delayed');
    staleJob.data = null as never;
    prisma.vkParsingSource.findFirst.mockResolvedValue(source);
    prisma.vkParsingSource.updateMany.mockResolvedValueOnce({ count: 1 });
    syncQueue.getJob.mockResolvedValueOnce(staleJob);

    const result = await service.refreshSource('channel-1', 'source-1', {
      userId: '183470701',
    } as never);

    expect(result.queued).toBe(1);
    expect(staleJob.remove).toHaveBeenCalledTimes(1);
    expect(syncQueue.add).toHaveBeenCalledWith(
      'sync-vk-source',
      expect.objectContaining({
        sourceId: 'source-1',
        ownerProfile: 'PUBLISHER',
        ownerBotId: 'publisher-bot',
      }),
      expect.objectContaining({ jobId: 'vk-parsing-sync__source-1' }),
    );
  });

  it('quarantines an active VK source sync job with a stale ownership envelope', async () => {
    const { service, prisma, syncQueue } = createFixture();
    const source = createSource({
      syncStatus: 'QUEUED',
      updatedAt: new Date('2026-05-25T09:55:00.000Z'),
    });
    const staleJob = createSyncQueueJob('active', {
      ownerProfile: undefined,
      ownerBotId: undefined,
    });
    prisma.vkParsingSource.findFirst.mockResolvedValue(source);
    prisma.vkParsingSource.updateMany.mockResolvedValueOnce({ count: 1 });
    syncQueue.getJob.mockResolvedValueOnce(staleJob);

    const result = await service.refreshSource('channel-1', 'source-1', {
      userId: '183470701',
    } as never);

    expect(result.queued).toBe(0);
    expect(staleJob.remove).not.toHaveBeenCalled();
    expect(staleJob.updateData).not.toHaveBeenCalled();
    expect(staleJob.retry).not.toHaveBeenCalled();
    expect(syncQueue.add).not.toHaveBeenCalled();
  });

  it('does not acquire or execute a Major-owned VK source', async () => {
    const { service, prisma } = createFixture();
    prisma.vkParsingSource.findUnique.mockResolvedValue(
      createSource({ ownerProfile: VkParsingOwnerProfile.MAJOR, ownerBotId: '' }),
    );
    global.fetch = jest.fn() as unknown as typeof fetch;

    await expect(service.processSyncSourceJob('source-1', 'scheduled')).resolves.toBe(0);

    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'source-1',
          ownerProfile: VkParsingOwnerProfile.PUBLISHER,
          ownerBotId: 'publisher-bot',
        }),
      }),
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('imports text, direct VK videos and links from a public VK community', async () => {
    const { service, prisma, syncQueue } = createFixture();
    const source = createSource();
    const videoUrl = 'https://vkvd.example/video-720.mp4';
    const wallPayload = {
      response: {
        groups: [{ id: 36819802, screen_name: 'avto_prodaja_rb', name: 'Авторынок Уфа' }],
        items: [
          {
            owner_id: -36819802,
            id: 101,
            date: 1_779_708_000,
            text: 'Продам авто',
            attachments: [
              {
                type: 'photo',
                photo: {
                  sizes: [
                    { width: 320, height: 240, url: 'https://sun1.example/small.jpg' },
                    { width: 1280, height: 960, url: 'https://sun1.example/large.jpg' },
                  ],
                },
              },
              {
                type: 'link',
                link: { url: 'https://example.com/car' },
              },
              {
                type: 'video',
                video: {
                  id: 42,
                  owner_id: -36819802,
                  title: 'Видеообзор',
                  files: {
                    external: 'https://vk.com/video_ext.php?oid=-36819802&id=42',
                    hls: 'https://vkvd.example/video.m3u8',
                    mp4_360: 'https://vkvd.example/video-360.mp4',
                    mp4_720: videoUrl,
                  },
                },
              },
            ],
          },
        ],
      },
    };
    global.fetch = jest
      .fn()
      .mockResolvedValue(createJsonFetchResponse(wallPayload)) as unknown as typeof fetch;
    prisma.vkParsingSource.upsert.mockResolvedValue(source);
    prisma.vkParsingSource.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(source);
    prisma.vkParsingPost.findMany.mockResolvedValue([]);
    prisma.vkParsingSource.findMany.mockResolvedValue([source]);

    await service.addSource('channel-1', { userId: '183470701' } as never, {
      url: 'https://vk.ru/avto_prodaja_rb',
    });
    expect(syncQueue.add).toHaveBeenCalledWith(
      'sync-vk-source',
      expect.objectContaining({
        sourceId: 'source-1',
        reason: 'source-added',
        retryPolicyName: 'vk-parsing-sync',
      }),
      expect.objectContaining({
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnFail: 500,
      }),
    );
    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const rawValues = readExecuteRawValues(prisma);
    expect(rawValues).toContain('Продам авто');
    expect(rawValues).toContain(JSON.stringify([]));
    expect(rawValues).toContain(JSON.stringify([videoUrl]));
    expect(rawValues).toContain(JSON.stringify(['https://example.com/car']));
    expect(rawValues).not.toContain(
      JSON.stringify(['https://vk.com/video_ext.php?oid=-36819802&id=42']),
    );
  });

  it('imports paired VK strong markup as markdown', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    const text = '**АРАХИСОВАЯ ПАСТА: ПОЛЬЗА И ВРЕД**';
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValue([]);
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [
            {
              owner_id: -36819802,
              id: 101,
              date: 1_779_708_000,
              text,
            },
          ],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    const rawValues = readExecuteRawValues(prisma);
    const textIndex = rawValues.indexOf(text);
    expect(textIndex).toBeGreaterThanOrEqual(0);
    expect(rawValues[textIndex + 1]).toBe('markdown');
    expect(readExecuteRawSql(prisma)).toContain('"text_format"');
  });

  it('hydrates VK video attachments through video.get when wall.get omits direct files', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    const videoUrl = 'https://vkvd.example/video-720.mp4';
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValue([]);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        createJsonFetchResponse({
          response: {
            items: [
              {
                owner_id: -36819802,
                id: 103,
                date: 1_779_708_000,
                text: '',
                attachments: [
                  {
                    type: 'video',
                    video: {
                      id: 42,
                      owner_id: -36819802,
                      access_key: 'video-key',
                      title: 'Видеообзор',
                      duration: 12,
                    },
                  },
                ],
              },
            ],
            groups: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        createJsonFetchResponse({
          response: {
            count: 1,
            items: [
              {
                id: 42,
                owner_id: -36819802,
                access_key: 'video-key',
                title: 'Видеообзор',
                duration: 12,
                files: {
                  external: 'https://vk.com/video_ext.php?oid=-36819802&id=42',
                  hls: 'https://vkvd.example/video.m3u8',
                  mp4_360: 'https://vkvd.example/video-360.mp4',
                  mp4_720: videoUrl,
                },
              },
            ],
          },
        }),
      ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('/method/video.get?'),
      expect.any(Object),
    );
    expect(decodeURIComponent(String((global.fetch as jest.Mock).mock.calls[1][0]))).toContain(
      'videos=-36819802_42_video-key',
    );
    const rawValues = readExecuteRawValues(prisma);
    expect(rawValues).toContain(JSON.stringify([videoUrl]));
    expect(rawValues).toContain(JSON.stringify([]));
    expect(rawValues).not.toContain('Нет прямого HTTPS-файла видео');
  });

  it('keeps a VK post link for short videos when VK does not provide direct files', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValue([]);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        createJsonFetchResponse({
          response: {
            items: [
              {
                owner_id: -36819802,
                id: 104,
                date: 1_779_708_000,
                text: '',
                attachments: [
                  {
                    type: 'video',
                    video: {
                      id: 42,
                      owner_id: -36819802,
                      access_key: 'video-key',
                      title: 'Clip from СПОРТ ИНСАЙДЕР',
                      type: 'short_video',
                      duration: 16,
                    },
                  },
                ],
              },
            ],
            groups: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        createJsonFetchResponse({
          response: {
            count: 1,
            items: [
              {
                id: 42,
                owner_id: -36819802,
                access_key: 'video-key',
                title: 'Clip from СПОРТ ИНСАЙДЕР',
                type: 'short_video',
                duration: 16,
                image: [{ url: 'https://iv.okcdn.ru/getVideoPreview?id=1', width: 720 }],
                first_frame: [{ url: 'https://iv.okcdn.ru/getVideoPreview?id=1', width: 720 }],
              },
            ],
          },
        }),
      ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    const rawValues = readExecuteRawValues(prisma);
    expect(rawValues).toContain(JSON.stringify([]));
    expect(rawValues).toContain(JSON.stringify(['https://vk.ru/wall-36819802_104']));
    const parsedJsonValues = rawValues
      .filter((value): value is string => typeof value === 'string')
      .map((value) => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          return null;
        }
      });
    expect(parsedJsonValues).toContainEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'video',
          reason: 'Нет прямого HTTPS-файла видео',
        }),
      ]),
    );
  });

  it('ignores wall posts whose owner does not match the source owner', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValue([]);
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [
            { owner_id: -1, id: 1, date: 1_779_707_999, text: 'Чужой пост' },
            { owner_id: -36819802, id: 101, date: 1_779_708_000, text: 'Наш пост' },
          ],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const rawValues = readExecuteRawValues(prisma);
    expect(rawValues).toContain('Наш пост');
    expect(rawValues).not.toContain('Чужой пост');
    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'source-1', syncLockedBy: expect.any(String) }),
        data: expect.objectContaining({
          lastFetchedCount: 1,
        }),
      }),
    );
  });

  it('imports modern VK attachment facts from src photos, copy history, ads and unsupported types', async () => {
    const { service, prisma, mediaCache } = createFixture();
    const preflightSpy = jest.spyOn(mediaCache, 'preflightMediaUrl');
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValue([]);
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [
            {
              owner_id: -36819802,
              id: 102,
              date: 1_779_708_000,
              text: 'Рекламный материал ERID abc123',
              marked_as_ads: 1,
              attachments: [
                {
                  type: 'photo',
                  photo: {
                    id: 11,
                    owner_id: -36819802,
                    sizes: [{ width: 640, height: 480, src: 'https://sun2.example/src.jpg' }],
                  },
                },
                { type: 'photos_list', photos_list: ['-36819802_12', '-36819802_13'] },
                { type: 'video', video: { title: 'Видеообзор' } },
                { type: 'doc', doc: { title: 'Прайс.pdf', url: 'https://vk.ru/doc.pdf' } },
                { type: 'poll', poll: { question: 'Брать?' } },
                { type: 'article', article: { title: 'Разбор', url: 'https://vk.ru/@club-post' } },
              ],
              copy_history: [
                {
                  owner_id: -1,
                  id: 1,
                  text: 'Текст репоста',
                  attachments: [{ type: 'link', link: { url: 'https://example.com/from-copy' } }],
                },
              ],
            },
          ],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    mediaFetch.mockResolvedValueOnce(
      new Response(null, {
        headers: { 'content-type': 'image/jpeg', 'content-length': '3' },
      }),
    );

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(preflightSpy).toHaveBeenCalledTimes(1);
    const preflight = preflightSpy.mock.results[0];
    if (!preflight || preflight.type !== 'return') {
      throw new Error('Expected the imported photo preflight to start');
    }
    await preflight.value;

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(mediaFetch).toHaveBeenCalledTimes(1);
    expect(mediaFetch).toHaveBeenCalledWith(new URL('https://sun2.example/src.jpg'), {
      method: 'HEAD',
      signal: expect.any(AbortSignal),
    });

    const rawValues = readExecuteRawValues(prisma);
    expect(rawValues).toContain(JSON.stringify(['https://sun2.example/src.jpg']));
    expect(rawValues).toContain(JSON.stringify(['https://example.com/from-copy']));
    const parsedJsonValues = rawValues
      .filter((value): value is string => typeof value === 'string')
      .map((value) => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          return null;
        }
      });
    const attachmentTypes = parsedJsonValues.find(
      (value): value is string[] =>
        Array.isArray(value) && value.includes('photos_list') && value.includes('link'),
    );
    expect(attachmentTypes).toEqual(
      expect.arrayContaining(['photo', 'photos_list', 'video', 'doc', 'poll', 'article', 'link']),
    );
    const unsupportedAttachments = parsedJsonValues.find(
      (value): value is Array<{ type: string }> =>
        Array.isArray(value) &&
        value.some((item) => item?.type === 'photos_list') &&
        value.some((item) => item?.type === 'copy_history'),
    );
    expect(unsupportedAttachments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'photos_list' }),
        expect.objectContaining({ type: 'video', title: 'Видеообзор' }),
        expect.objectContaining({ type: 'doc', title: 'Прайс.pdf' }),
        expect.objectContaining({ type: 'poll', title: 'Брать?' }),
        expect.objectContaining({ type: 'article', title: 'Разбор' }),
        expect.objectContaining({ type: 'copy_history' }),
      ]),
    );
    expect(rawValues).toContain(true);
    const advertisingMarkers = parsedJsonValues.find(
      (value): value is string[] => Array.isArray(value) && value.includes('VK marked_as_ads'),
    );
    expect(advertisingMarkers).toEqual(expect.arrayContaining(['VK marked_as_ads']));
  });

  it('does not preflight media for the initial source-added backfill', async () => {
    const { service, prisma, mediaCache } = createFixture();
    const source = createSource();
    const preflightSpy = jest.spyOn(mediaCache, 'preflightMediaUrl');
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValue([]);
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [
            {
              owner_id: -36819802,
              id: 101,
              date: 1_779_708_000,
              text: 'Фото из начального бэкфилла',
              attachments: [
                {
                  type: 'photo',
                  photo: {
                    id: 1,
                    owner_id: -36819802,
                    access_key: 'photo-key',
                    sizes: [
                      {
                        url: 'https://sun1.example/backfill.jpg',
                        width: 1280,
                        height: 720,
                      },
                    ],
                  },
                },
              ],
            },
          ],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'source-added');

    expect(preflightSpy).not.toHaveBeenCalled();
  });

  it('skips media preflight for unchanged scheduled posts', async () => {
    const { service, prisma, mediaCache } = createFixture();
    const source = createSource({ lastSuccessAt: new Date('2026-05-25T09:00:00.000Z') });
    const photoUrl = 'https://sun1.example/unchanged.jpg';
    const contentHash = computeVkParsingPostContentHash({
      text: 'Без изменений',
      photoUrls: [photoUrl],
      linkUrls: [],
      attachmentTypes: ['photo'],
    });
    const preflightSpy = jest.spyOn(mediaCache, 'preflightMediaUrl');
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany
      .mockResolvedValueOnce([
        {
          id: 'post-1',
          vkOwnerId: -36819802,
          vkPostId: 101,
          status: 'NEW',
          contentHash,
          publishedContentHash: null,
        },
      ])
      .mockResolvedValueOnce([]);
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [
            {
              owner_id: -36819802,
              id: 101,
              date: 1_779_708_000,
              text: 'Без изменений',
              attachments: [
                {
                  type: 'photo',
                  photo: {
                    id: 1,
                    owner_id: -36819802,
                    access_key: 'photo-key',
                    sizes: [{ url: photoUrl, width: 1280, height: 720 }],
                  },
                },
              ],
            },
          ],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(preflightSpy).not.toHaveBeenCalled();
  });

  it('uses VK API 5.199 and overlap pagination offsets for scheduled sync', async () => {
    const { service, prisma } = createFixture({
      VK_PARSING_FETCH_COUNT: 2,
      VK_PARSING_MIN_PAGES: 3,
      VK_PARSING_MAX_PAGES: 3,
    });
    const source = createSource({ lastSuccessAt: new Date('2026-05-25T09:00:00.000Z') });
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValue([]);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        createJsonFetchResponse({
          response: {
            items: [
              { owner_id: -36819802, id: 103, date: 1_779_708_003, text: 'Пост 103' },
              { owner_id: -36819802, id: 102, date: 1_779_708_002, text: 'Пост 102' },
            ],
            groups: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        createJsonFetchResponse({
          response: {
            items: [
              { owner_id: -36819802, id: 101, date: 1_779_708_001, text: 'Пост 101' },
              { owner_id: -36819802, id: 100, date: 1_779_708_000, text: 'Пост 100' },
            ],
            groups: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        createJsonFetchResponse({
          response: {
            items: [{ owner_id: -36819802, id: 99, date: 1_779_707_999, text: 'Пост 99' }],
            groups: [],
          },
        }),
      ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    const requestedUrls = (global.fetch as jest.Mock).mock.calls.map((call) => String(call[0]));
    expect(requestedUrls[0]).toContain('v=5.199');
    expect(requestedUrls[0]).not.toContain('offset=');
    expect(requestedUrls[1]).toContain('offset=2');
    expect(requestedUrls[2]).toContain('offset=4');
    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastFetchedPages: 3,
          lastFetchedOffsets: [0, 2, 4],
          adaptiveIntervalMs: expect.any(Number),
        }),
      }),
    );
  });

  it('keeps VK polling cadence independent from the publication interval', () => {
    const { syncService } = createFixture();
    const now = new Date('2026-09-04T12:00:00.000Z');
    const posts = [
      {
        vkPostId: 101,
        vkPublishedAt: new Date('2026-09-02T12:00:00.000Z'),
      },
    ];

    const slow = (syncService as any).resolveAdaptiveSyncIntervalMs(
      createSource({ publishIntervalMinutes: 180 }),
      posts,
      now,
    );
    const fast = (syncService as any).resolveAdaptiveSyncIntervalMs(
      createSource({ publishIntervalMinutes: 30 }),
      posts,
      now,
    );

    expect(fast).toBe(slow);
    expect(syncService.getSchedulerIntervalMs()).toBe(120_000);
  });

  it('queues newly imported scheduled VK posts for background publish', async () => {
    const { service, prisma, maxClient, publishQueue } = createFixture();
    const source = createSource({ lastSuccessAt: new Date('2026-05-25T09:30:00.000Z') });
    const post = createPostRow({
      source,
      text: 'Продам авто https://example.com\nvk.com/club',
      linkUrls: ['https://example.com/car'],
      publishScheduleFingerprint: VK_AUTOPUBLISH_PENDING_SCHEDULE_FINGERPRINT,
    });
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findMany.mockImplementation(async (query: any) =>
      query.include?.source ? [post] : [],
    );
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: true,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [
            {
              owner_id: -36819802,
              id: 101,
              date: 1_779_708_000,
              text: 'Продам авто https://example.com\nvk.com/club',
              attachments: [{ type: 'link', link: { url: 'https://example.com/car' } }],
            },
          ],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(readExecuteRawValues(prisma)).toContain(VK_AUTOPUBLISH_PENDING_SCHEDULE_FINGERPRINT);
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'post-1' }),
        data: expect.objectContaining({
          publishQueuedAt: expect.any(Date),
          publishIdempotencyKey: expect.any(String),
          publishReason: 'autopublish',
          publishScheduleFingerprint: expect.stringMatching(/^[a-f0-9]{32}$/u),
        }),
      }),
    );
    expect(publishQueue.add).toHaveBeenCalledWith(
      'publish-vk-post',
      expect.objectContaining({
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'autopublish',
        retryPolicyName: 'vk-parsing-publish',
      }),
      expect.objectContaining({
        attempts: 5,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnFail: 1000,
      }),
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('retries an eligible unqueued post after transient Publisher readiness blocked its first enqueue', async () => {
    const { service, prisma, publishQueue } = createFixture();
    const source = createSource({ lastSuccessAt: new Date('2026-05-25T09:30:00.000Z') });
    const post = createPostRow({
      source,
      publishScheduleFingerprint: VK_AUTOPUBLISH_PENDING_SCHEDULE_FINGERPRINT,
    });
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.findMany.mockImplementation(async (query: any) => {
      if (query.select?.contentHash) {
        return [
          {
            id: post.id,
            vkOwnerId: post.vkOwnerId,
            vkPostId: post.vkPostId,
            status: 'NEW',
            contentHash: post.contentHash,
            publishedContentHash: null,
            publishQueuedAt: null,
            publishIdempotencyKey: null,
            publishReason: null,
            publishCancelledAt: null,
            publishScheduleFingerprint: VK_AUTOPUBLISH_PENDING_SCHEDULE_FINGERPRINT,
          },
        ];
      }
      return query.include?.source ? [post] : [];
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      schedulerTimezone: 'UTC',
      workHoursStart: '00:00',
      workHoursEnd: '00:00',
      distributeEvenlyEnabled: true,
      roundRobinEnabled: true,
      circuitBreakerEnabled: false,
    });
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [
            {
              owner_id: post.vkOwnerId,
              id: post.vkPostId,
              date: Math.floor(post.vkPublishedAt.getTime() / 1_000),
              text: post.text,
            },
          ],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob(source.id, 'scheduled');

    expect(publishQueue.add).toHaveBeenCalledWith(
      'publish-vk-post',
      expect.objectContaining({ postId: post.id, reason: 'autopublish' }),
      expect.any(Object),
    );
  });

  it('recovers a bounded pending autopublish post outside the current VK fetch page', async () => {
    const { service, prisma, publishQueue } = createFixture();
    const source = createSource({
      lastSuccessAt: new Date('2026-05-25T09:15:00.000Z'),
      publishMode: 'IMMEDIATE',
    });
    const fetchedPost = createPostRow({
      source,
      id: 'post-current',
      vkPostId: 102,
      vkPublishedAt: new Date('2026-05-25T10:10:00.000Z'),
      text: 'Текущий пост',
    });
    const pendingPost = createPostRow({
      source,
      id: 'post-pending',
      vkPostId: 101,
      vkPublishedAt: new Date('2026-05-25T09:30:00.000Z'),
      publishScheduleFingerprint: VK_AUTOPUBLISH_PENDING_SCHEDULE_FINGERPRINT,
    });
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findFirst.mockResolvedValue(pendingPost);
    prisma.vkParsingPost.findMany.mockImplementation(async (query: any) => {
      if (query.select?.contentHash) {
        return [
          {
            id: fetchedPost.id,
            vkOwnerId: fetchedPost.vkOwnerId,
            vkPostId: fetchedPost.vkPostId,
            status: fetchedPost.status,
            contentHash: fetchedPost.contentHash,
            publishedContentHash: fetchedPost.publishedContentHash,
            publishQueuedAt: null,
            publishIdempotencyKey: null,
            publishReason: null,
            publishCancelledAt: null,
            publishScheduleFingerprint: null,
          },
        ];
      }
      return query.include?.source ? [pendingPost] : [];
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      chatId: source.chatId,
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      autoPublishKillSwitchEnabled: false,
      schedulerTimezone: 'UTC',
      workHoursStart: '00:00',
      workHoursEnd: '00:00',
      quietHoursStart: null,
      quietHoursEnd: null,
      distributeEvenlyEnabled: true,
      roundRobinEnabled: true,
      circuitBreakerEnabled: false,
    });
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [
            {
              owner_id: fetchedPost.vkOwnerId,
              id: fetchedPost.vkPostId,
              date: Math.floor(fetchedPost.vkPublishedAt.getTime() / 1_000),
              text: fetchedPost.text,
            },
          ],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    await expect(service.processSyncSourceJob(source.id, 'scheduled')).resolves.toBe(0);

    const recoveryQuery = prisma.vkParsingPost.findMany.mock.calls.find(
      ([query]) => query.include?.source && query.where?.publishScheduleFingerprint,
    )?.[0];
    expect(recoveryQuery).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceId: source.id,
          chatId: source.chatId,
          status: 'NEW',
          publishQueuedAt: null,
          publishScheduledAt: null,
          publishLockedAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
          publishCancelledAt: null,
          publishScheduleFingerprint: { not: null },
        }),
        take: 100,
      }),
    );
    expect(recoveryQuery?.where).not.toHaveProperty('vkPostId');
    expect(publishQueue.add).toHaveBeenCalledWith(
      'publish-vk-post',
      expect.objectContaining({ postId: pendingPost.id, reason: 'autopublish' }),
      expect.any(Object),
    );
  });

  it('spaces a same-source autopublish batch linearly from the live queue tail', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-25T10:00:00.000Z'));
    try {
      const { publishService, prisma } = createFixture();
      const source = createSource();
      const posts = ['post-1', 'post-2', 'post-3'].map((id, index) =>
        createPostRow({
          source,
          id,
          vkPostId: 101 + index,
          vkPublishedAt: new Date(`2026-05-25T10:0${index}:00.000Z`),
          createdAt: new Date(`2026-05-25T10:0${index}:00.000Z`),
        }),
      );
      const scheduledSlots: Date[] = [];
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        id: 'settings-1',
        chatId: 'channel-1',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
        autoPublishKillSwitchEnabled: false,
        schedulerTimezone: 'UTC',
        workHoursStart: '00:00',
        workHoursEnd: '00:00',
        distributeEvenlyEnabled: true,
        roundRobinEnabled: false,
        circuitBreakerEnabled: false,
        stripLinksEnabled: false,
        skipAdsEnabled: false,
        createdAt: new Date('2026-05-25T09:00:00.000Z'),
        updatedAt: new Date('2026-05-25T09:00:00.000Z'),
      });
      prisma.vkParsingPost.aggregate.mockImplementation(async () => ({
        _max: { publishScheduledAt: scheduledSlots.at(-1) ?? null },
      }));
      prisma.vkParsingPost.updateMany.mockImplementation(async ({ data }) => {
        if (data.publishReason === 'autopublish' && data.publishScheduledAt instanceof Date) {
          scheduledSlots.push(data.publishScheduledAt);
        }
        return { count: 1 };
      });

      await publishService.enqueueAutoPublishImportedPosts('channel-1', posts as never);

      expect(scheduledSlots).toEqual([
        new Date('2026-05-25T10:00:00.000Z'),
        new Date('2026-05-25T11:00:00.000Z'),
        new Date('2026-05-25T12:00:00.000Z'),
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('uses only the minimum source interval when even distribution is disabled', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-25T10:00:00.000Z'));
    try {
      const { publishService, prisma } = createFixture();
      const source = createSource();
      const posts = ['post-1', 'post-2'].map((id, index) =>
        createPostRow({
          source,
          id,
          vkPostId: 101 + index,
          vkPublishedAt: new Date(`2026-05-25T10:0${index}:00.000Z`),
          createdAt: new Date(`2026-05-25T10:0${index}:00.000Z`),
        }),
      );
      const scheduledSlots: Date[] = [];
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        id: 'settings-1',
        chatId: 'channel-1',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
        autoPublishKillSwitchEnabled: false,
        schedulerTimezone: 'UTC',
        workHoursStart: '00:00',
        workHoursEnd: '00:00',
        distributeEvenlyEnabled: false,
        roundRobinEnabled: false,
        circuitBreakerEnabled: false,
        stripLinksEnabled: false,
        skipAdsEnabled: false,
        createdAt: new Date('2026-05-25T09:00:00.000Z'),
        updatedAt: new Date('2026-05-25T09:00:00.000Z'),
      });
      prisma.vkParsingPost.aggregate.mockImplementation(async () => ({
        _max: { publishScheduledAt: scheduledSlots.at(-1) ?? null },
      }));
      prisma.vkParsingPost.updateMany.mockImplementation(async ({ data }) => {
        if (data.publishReason === 'autopublish' && data.publishScheduledAt instanceof Date) {
          scheduledSlots.push(data.publishScheduledAt);
        }
        return { count: 1 };
      });

      await publishService.enqueueAutoPublishImportedPosts('channel-1', posts as never);

      expect(scheduledSlots).toEqual([
        new Date('2026-05-25T10:00:00.000Z'),
        new Date('2026-05-25T10:30:00.000Z'),
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('replans a persisted 180-minute autopublish tail with the current 30-minute policy', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-04T10:00:00.000Z'));
    try {
      const { publishService, prisma, publishQueue } = createFixture();
      const source = createSource({
        publishIntervalMinutes: 30,
        dailyLimit: 500,
        minPublishIntervalMinutes: 30,
        lastAutoPublishedAt: new Date('2026-09-04T09:30:00.000Z'),
      });
      const posts = [
        createPostRow({
          id: 'post-1',
          source,
          publishQueuedAt: new Date('2026-09-04T09:00:00.000Z'),
          publishScheduledAt: new Date('2026-09-04T13:00:00.000Z'),
          publishIdempotencyKey: 'old-180-key-1',
          publishReason: 'autopublish',
          publishScheduleFingerprint: 'old-180-policy',
        }),
        createPostRow({
          id: 'post-2',
          vkPostId: 102,
          source,
          publishQueuedAt: new Date('2026-09-04T09:01:00.000Z'),
          publishScheduledAt: new Date('2026-09-04T16:00:00.000Z'),
          publishIdempotencyKey: 'old-180-key-2',
          publishReason: 'autopublish',
          publishScheduleFingerprint: 'old-180-policy',
        }),
      ];
      prisma.vkParsingPost.findMany.mockResolvedValueOnce(posts).mockResolvedValueOnce([]);
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        chatId: 'channel-1',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-09-04T08:00:00.000Z'),
        schedulerTimezone: 'UTC',
        workHoursStart: '00:00',
        workHoursEnd: '00:00',
        distributeEvenlyEnabled: true,
        roundRobinEnabled: true,
      });
      prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });

      await expect(publishService.reconcileAutoPublishSchedules()).resolves.toBe(2);

      const scheduleUpdates = prisma.vkParsingPost.updateMany.mock.calls
        .map(([query]) => query)
        .filter((query) => typeof query.data.publishIdempotencyKey === 'string');
      expect(scheduleUpdates.map((query) => query.data.publishScheduledAt)).toEqual([
        new Date('2026-09-04T10:00:00.000Z'),
        new Date('2026-09-04T10:30:00.000Z'),
      ]);
      expect(scheduleUpdates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            data: expect.objectContaining({
              publishScheduleFingerprint: expect.stringMatching(/^[a-f0-9]{32}$/u),
            }),
          }),
        ]),
      );
      expect(publishQueue.add).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('treats a current schedule fingerprint as authoritative during forced reconciliation', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-04T10:00:00.000Z'));
    const { publishService, prisma } = createFixture();
    const source = createSource({
      publishIntervalMinutes: 30,
      minPublishIntervalMinutes: 30,
    });
    const settings = {
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-09-04T08:00:00.000Z'),
      schedulerTimezone: 'UTC',
      quietHoursStart: null,
      quietHoursEnd: null,
      workHoursStart: '00:00',
      workHoursEnd: '00:00',
      distributeEvenlyEnabled: true,
      roundRobinEnabled: false,
    };
    const fingerprint = buildVkAutoPublishScheduleFingerprint(settings, source);
    const posts = Array.from({ length: 501 }, (_, index) =>
      createPostRow({
        id: `post-${String(index + 1).padStart(4, '0')}`,
        vkPostId: 1_000 + index,
        source,
        publishQueuedAt: new Date('2026-09-04T09:00:00.000Z'),
        publishScheduledAt: new Date(Date.parse('2026-09-04T10:00:00.000Z') + index * 30 * 60_000),
        publishIdempotencyKey: `current-key-${index}`,
        publishReason: 'autopublish',
        publishScheduleFingerprint: fingerprint,
      }),
    );
    prisma.vkParsingSettings.findUnique.mockResolvedValue(settings);
    prisma.vkParsingPost.findMany.mockImplementation(async (query: any) => {
      const afterId = query.where.id?.gt as string | undefined;
      return posts.filter((post) => !afterId || post.id > afterId).slice(0, query.take);
    });

    await expect(publishService.reconcileAutoPublishSchedules({ force: true })).resolves.toBe(0);
    await expect(publishService.reconcileAutoPublishSchedules()).resolves.toBe(0);
    await expect(publishService.reconcileAutoPublishSchedules()).resolves.toBe(0);

    expect(prisma.vkParsingPost.findMany).toHaveBeenCalledTimes(3);
    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.aggregate).not.toHaveBeenCalled();
  });

  it('reconciles stale source work after published and canonical queued daily quota', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-04T18:00:00.000Z'));
    try {
      const { publishService, prisma, publishQueue } = createFixture();
      const source = createSource({
        publishIntervalMinutes: 30,
        dailyLimit: 3,
        minPublishIntervalMinutes: 30,
        lastAutoPublishedAt: new Date('2026-09-04T17:30:00.000Z'),
      });
      const settings = {
        chatId: 'channel-1',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-09-04T08:00:00.000Z'),
        schedulerTimezone: 'Europe/Moscow',
        quietHoursStart: null,
        quietHoursEnd: null,
        workHoursStart: '09:00',
        workHoursEnd: '22:00',
        distributeEvenlyEnabled: true,
        roundRobinEnabled: false,
      };
      const fingerprint = buildVkAutoPublishScheduleFingerprint(settings, source);
      const stalePosts = ['stale-1', 'stale-2'].map((id, index) =>
        createPostRow({
          id,
          vkPostId: 201 + index,
          source,
          publishQueuedAt: new Date('2026-09-04T17:00:00.000Z'),
          publishScheduledAt: new Date(
            Date.parse('2026-09-04T18:30:00.000Z') + index * 60 * 60_000,
          ),
          publishIdempotencyKey: `old-key-${index + 1}`,
          publishReason: 'autopublish',
          publishScheduleFingerprint: 'interval-only-v1',
        }),
      );
      const canonicalSlot = {
        id: 'canonical-existing',
        publishScheduledAt: new Date('2026-09-04T18:15:00.000Z'),
      };
      prisma.vkParsingSettings.findUnique.mockResolvedValue(settings);
      prisma.vkParsingPost.count.mockResolvedValue(2);
      prisma.vkParsingPost.findMany.mockImplementation(async (query: any) => {
        if (query.include?.source) {
          return stalePosts;
        }
        if (query.where.publishReason === 'autopublish') {
          return [canonicalSlot];
        }
        return [];
      });
      prisma.vkParsingPost.aggregate.mockResolvedValue({
        _max: { publishScheduledAt: canonicalSlot.publishScheduledAt },
      });
      prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });

      await expect(publishService.reconcileAutoPublishSchedules()).resolves.toBe(2);

      expect(prisma.vkParsingPost.count).toHaveBeenCalledWith({
        where: {
          chatId: 'channel-1',
          sourceId: source.id,
          ownerProfile: VkParsingOwnerProfile.PUBLISHER,
          ownerBotId: 'publisher-bot',
          autoPublishedAt: {
            gte: new Date('2026-09-03T21:00:00.000Z'),
            lt: new Date('2026-09-04T21:00:00.000Z'),
          },
        },
      });
      expect(prisma.vkParsingPost.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            sourceId: source.id,
            publishReason: 'autopublish',
            id: { notIn: stalePosts.map((post) => post.id) },
            AND: expect.arrayContaining([
              {
                OR: [
                  { publishScheduleFingerprint: fingerprint },
                  { publishAttemptCount: { gt: 0 } },
                ],
              },
            ]),
          }),
          orderBy: [{ publishScheduledAt: 'asc' }, { id: 'asc' }],
          take: 5_000,
        }),
      );
      const replans = prisma.vkParsingPost.updateMany.mock.calls
        .map(([query]) => query)
        .filter((query) => stalePosts.some((post) => post.id === query.where.id));
      expect(replans.map((query) => query.data.publishScheduledAt)).toEqual([
        new Date('2026-09-05T06:00:00.000Z'),
        new Date('2026-09-05T06:30:00.000Z'),
      ]);
      expect(replans.every((query) => query.data.publishScheduleFingerprint === fingerprint)).toBe(
        true,
      );
      expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: canonicalSlot.id }) }),
      );
      expect(publishQueue.add).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('reserves the effective next work window for an overdue canonical source intent', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-04T22:30:00.000Z'));
    try {
      const { publishService, prisma, publishQueue } = createFixture();
      const source = createSource({
        publishIntervalMinutes: 30,
        dailyLimit: 2,
        minPublishIntervalMinutes: 30,
        lastAutoPublishedAt: new Date('2026-09-04T20:30:00.000Z'),
      });
      const settings = {
        chatId: 'channel-1',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-09-04T08:00:00.000Z'),
        schedulerTimezone: 'UTC',
        quietHoursStart: null,
        quietHoursEnd: null,
        workHoursStart: '09:00',
        workHoursEnd: '22:00',
        distributeEvenlyEnabled: true,
        roundRobinEnabled: false,
      };
      const stalePosts = ['stale-after-overdue-1', 'stale-after-overdue-2'].map((id, index) =>
        createPostRow({
          id,
          vkPostId: 251 + index,
          source,
          publishQueuedAt: new Date('2026-09-04T20:00:00.000Z'),
          publishScheduledAt: new Date(
            Date.parse('2026-09-04T21:30:00.000Z') + index * 30 * 60_000,
          ),
          publishIdempotencyKey: `stale-after-overdue-key-${index + 1}`,
          publishReason: 'autopublish',
          publishScheduleFingerprint: 'old-policy',
        }),
      );
      const canonicalAttemptedSlot = {
        id: 'canonical-attempted-overdue',
        publishScheduledAt: new Date('2026-09-04T21:30:00.000Z'),
      };
      prisma.vkParsingSettings.findUnique.mockResolvedValue(settings);
      prisma.vkParsingPost.count.mockResolvedValue(0);
      prisma.vkParsingPost.findMany.mockImplementation(async (query: any) => {
        if (query.include?.source) {
          return stalePosts;
        }
        if (query.where.publishReason === 'autopublish') {
          return [canonicalAttemptedSlot];
        }
        return [];
      });
      prisma.vkParsingPost.aggregate.mockResolvedValue({
        _max: { publishScheduledAt: canonicalAttemptedSlot.publishScheduledAt },
      });
      prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });

      await expect(publishService.reconcileAutoPublishSchedules()).resolves.toBe(2);

      const replans = prisma.vkParsingPost.updateMany.mock.calls
        .map(([query]) => query)
        .filter((query) => stalePosts.some((post) => post.id === query.where.id));
      expect(replans.map((query) => query.data.publishScheduledAt)).toEqual([
        new Date('2026-09-05T09:30:00.000Z'),
        new Date('2026-09-06T09:00:00.000Z'),
      ]);
      expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: canonicalAttemptedSlot.id }),
        }),
      );
      expect(publishQueue.add).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps tomorrow quota available across round-robin planning iterations', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-04T18:30:00.000Z'));
    try {
      const { publishService, prisma } = createFixture();
      const source = createSource({
        publishIntervalMinutes: 30,
        dailyLimit: 2,
        minPublishIntervalMinutes: 30,
        lastAutoPublishedAt: new Date('2026-09-04T18:00:00.000Z'),
      });
      const settings = {
        chatId: 'channel-1',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-09-04T08:00:00.000Z'),
        schedulerTimezone: 'Europe/Moscow',
        quietHoursStart: null,
        quietHoursEnd: null,
        workHoursStart: '09:00',
        workHoursEnd: '22:00',
        distributeEvenlyEnabled: true,
        roundRobinEnabled: true,
      };
      const stalePosts = ['stale-1', 'stale-2', 'stale-3'].map((id, index) =>
        createPostRow({
          id,
          vkPostId: 301 + index,
          source,
          publishQueuedAt: new Date('2026-09-04T17:00:00.000Z'),
          publishScheduledAt: new Date(
            Date.parse('2026-09-04T18:30:00.000Z') + index * 30 * 60_000,
          ),
          publishIdempotencyKey: `old-round-robin-key-${index + 1}`,
          publishReason: 'autopublish',
          publishScheduleFingerprint: 'interval-only-v1',
        }),
      );
      prisma.vkParsingSettings.findUnique.mockResolvedValue(settings);
      prisma.vkParsingPost.count.mockResolvedValue(2);
      prisma.vkParsingPost.findMany.mockImplementation(async (query: any) =>
        query.include?.source ? stalePosts : [],
      );
      prisma.vkParsingPost.aggregate.mockResolvedValue({
        _max: { publishScheduledAt: null },
      });
      prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });

      await expect(publishService.reconcileAutoPublishSchedules()).resolves.toBe(3);

      const replans = prisma.vkParsingPost.updateMany.mock.calls
        .map(([query]) => query)
        .filter((query) => stalePosts.some((post) => post.id === query.where.id));
      expect(replans.map((query) => query.data.publishScheduledAt)).toEqual([
        new Date('2026-09-05T06:00:00.000Z'),
        new Date('2026-09-05T06:30:00.000Z'),
        new Date('2026-09-06T06:00:00.000Z'),
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('continues schedule reconciliation after a 500-post page using the current source tail', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-04T10:00:00.000Z'));
    try {
      const { publishService, prisma } = createFixture();
      const source = createSource({
        publishIntervalMinutes: 30,
        dailyLimit: 500,
        minPublishIntervalMinutes: 30,
        lastAutoPublishedAt: new Date('2026-09-04T09:30:00.000Z'),
      });
      const settings = {
        chatId: 'channel-1',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-09-04T08:00:00.000Z'),
        schedulerTimezone: 'UTC',
        quietHoursStart: null,
        quietHoursEnd: null,
        workHoursStart: '00:00',
        workHoursEnd: '00:00',
        distributeEvenlyEnabled: true,
        roundRobinEnabled: false,
      };
      const fingerprint = buildVkAutoPublishScheduleFingerprint(settings, source);
      const posts = Array.from({ length: 501 }, (_, index) =>
        createPostRow({
          id: `post-${String(index + 1).padStart(4, '0')}`,
          vkPostId: 1_000 + index,
          source,
          publishQueuedAt: new Date('2026-09-04T09:00:00.000Z'),
          publishScheduledAt: new Date(
            Date.parse('2026-09-04T13:00:00.000Z') + index * 180 * 60_000,
          ),
          publishIdempotencyKey: `old-key-${index}`,
          publishReason: 'autopublish',
          publishScheduleFingerprint: 'old-policy',
        }),
      );
      prisma.vkParsingSettings.findUnique.mockResolvedValue(settings);
      prisma.vkParsingPost.findMany.mockImplementation(async (query: any) => {
        if (query.where.publishReason === 'autopublish' && query.select?.publishScheduledAt) {
          return [];
        }
        const afterId = query.where.id?.gt as string | undefined;
        return posts.filter((post) => !afterId || post.id > afterId).slice(0, query.take);
      });
      prisma.vkParsingPost.aggregate.mockImplementation(async (query: any) => {
        const excludedIds = new Set<string>(query.where.id?.notIn ?? []);
        const requestedFingerprint = query.where.AND?.[0]?.OR?.[0]?.publishScheduleFingerprint;
        const currentRows = posts.filter(
          (post) =>
            !excludedIds.has(post.id) && post.publishScheduleFingerprint === requestedFingerprint,
        );
        return {
          _max: {
            publishScheduledAt:
              currentRows.reduce<Date | null>((latest, post) => {
                const scheduledAt = (post as { publishScheduledAt: Date | null })
                  .publishScheduledAt;
                return scheduledAt && (!latest || scheduledAt > latest) ? scheduledAt : latest;
              }, null) ?? null,
          },
        };
      });
      prisma.vkParsingPost.updateMany.mockImplementation(async (query: any) => {
        const post = posts.find((candidate) => candidate.id === query.where.id);
        if (!post) {
          return { count: 0 };
        }
        if (query.data.publishScheduledAt instanceof Date) {
          post.publishScheduledAt = query.data.publishScheduledAt;
        }
        if (typeof query.data.publishScheduleFingerprint === 'string') {
          post.publishScheduleFingerprint = query.data.publishScheduleFingerprint;
        }
        return { count: 1 };
      });

      await expect(publishService.reconcileAutoPublishSchedules()).resolves.toBe(500);
      await expect(publishService.reconcileAutoPublishSchedules()).resolves.toBe(1);

      expect(posts[499]!.publishScheduledAt).toEqual(
        new Date(Date.parse('2026-09-04T10:00:00.000Z') + 499 * 30 * 60_000),
      );
      expect(posts[500]!.publishScheduledAt).toEqual(
        new Date(Date.parse('2026-09-04T10:00:00.000Z') + 500 * 30 * 60_000),
      );
      expect(posts.every((post) => post.publishScheduleFingerprint === fingerprint)).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('pages through more than 5000 occupied chat slots without deferring reconciliation', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-04T10:00:00.000Z'));
    try {
      const { publishService, prisma } = createFixture();
      const source = createSource({
        publishIntervalMinutes: 30,
        minPublishIntervalMinutes: 30,
        lastAutoPublishedAt: new Date('2026-09-04T09:30:00.000Z'),
      });
      const post = createPostRow({
        source,
        publishQueuedAt: new Date('2026-09-04T09:00:00.000Z'),
        publishScheduledAt: new Date('2026-09-04T13:00:00.000Z'),
        publishIdempotencyKey: 'old-key',
        publishReason: 'autopublish',
        publishScheduleFingerprint: 'old-policy',
      });
      const occupied = Array.from({ length: 5_001 }, (_, index) => ({
        id: `occupied-${String(index + 1).padStart(5, '0')}`,
        publishScheduledAt: new Date(Date.parse('2026-09-04T10:00:00.000Z') + index * 60_000),
      }));
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        chatId: 'channel-1',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-09-04T08:00:00.000Z'),
        schedulerTimezone: 'UTC',
        workHoursStart: '00:00',
        workHoursEnd: '00:00',
        distributeEvenlyEnabled: true,
        roundRobinEnabled: true,
      });
      prisma.vkParsingPost.findMany
        .mockResolvedValueOnce([post])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(occupied.slice(0, 5_000))
        .mockResolvedValueOnce(occupied.slice(5_000));
      prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });

      await expect(publishService.reconcileAutoPublishSchedules()).resolves.toBe(1);

      expect(prisma.vkParsingPost.findMany).toHaveBeenCalledTimes(4);
      expect(prisma.vkParsingPost.findMany).toHaveBeenNthCalledWith(
        4,
        expect.objectContaining({
          where: expect.objectContaining({
            OR: [
              {
                publishScheduledAt: {
                  gt: occupied[4_999]!.publishScheduledAt,
                },
              },
              {
                publishScheduledAt: occupied[4_999]!.publishScheduledAt,
                id: { gt: occupied[4_999]!.id },
              },
            ],
          }),
          take: 5_000,
        }),
      );
      const scheduleUpdate = prisma.vkParsingPost.updateMany.mock.calls[0]?.[0];
      expect(scheduleUpdate.data.publishScheduledAt).toEqual(
        new Date(Date.parse('2026-09-04T10:00:00.000Z') + 5_001 * 60_000),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails closed when occupied-slot pagination exhausts its bounded scan budget', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-04T10:00:00.000Z'));
    try {
      const { publishService, prisma } = createFixture();
      const source = createSource({
        publishIntervalMinutes: 30,
        minPublishIntervalMinutes: 30,
        lastAutoPublishedAt: new Date('2026-09-04T09:30:00.000Z'),
      });
      const post = createPostRow({
        source,
        publishQueuedAt: new Date('2026-09-04T09:00:00.000Z'),
        publishScheduledAt: new Date('2026-09-04T13:00:00.000Z'),
        publishIdempotencyKey: 'old-key',
        publishReason: 'autopublish',
        publishScheduleFingerprint: 'old-policy',
      });
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        chatId: 'channel-1',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-09-04T08:00:00.000Z'),
        schedulerTimezone: 'UTC',
        workHoursStart: '00:00',
        workHoursEnd: '00:00',
        distributeEvenlyEnabled: true,
        roundRobinEnabled: true,
      });
      let occupiedPage = 0;
      prisma.vkParsingPost.findMany.mockImplementation(async (query: any) => {
        if (query.include?.source) {
          return [post];
        }
        if (query.where.publishReason === 'autopublish') {
          return [];
        }
        const page = occupiedPage;
        occupiedPage += 1;
        return Array.from({ length: 5_000 }, (_, index) => {
          const offset = page * 5_000 + index;
          return {
            id: `occupied-${String(offset + 1).padStart(6, '0')}`,
            publishScheduledAt: new Date(Date.parse('2026-09-04T10:00:00.000Z') + offset * 60_000),
          };
        });
      });

      await expect(publishService.reconcileAutoPublishSchedules()).resolves.toBe(0);

      expect(occupiedPage).toBe(20);
      expect(prisma.vkParsingPost.findMany).toHaveBeenCalledTimes(22);
      expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('fails closed when canonical source quota pagination exhausts its bounded scan budget', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-04T10:00:00.000Z'));
    try {
      const { publishService, prisma } = createFixture();
      const source = createSource({ dailyLimit: 500, publishIntervalMinutes: 30 });
      const post = createPostRow({
        source,
        publishQueuedAt: new Date('2026-09-04T09:00:00.000Z'),
        publishScheduledAt: new Date('2026-09-04T13:00:00.000Z'),
        publishIdempotencyKey: 'old-key',
        publishReason: 'autopublish',
        publishScheduleFingerprint: 'old-policy',
      });
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        chatId: 'channel-1',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-09-04T08:00:00.000Z'),
        schedulerTimezone: 'UTC',
        workHoursStart: '00:00',
        workHoursEnd: '00:00',
        distributeEvenlyEnabled: true,
        roundRobinEnabled: false,
      });
      let quotaPage = 0;
      prisma.vkParsingPost.findMany.mockImplementation(async (query: any) => {
        if (query.include?.source) {
          return [post];
        }
        if (query.where.publishReason !== 'autopublish') {
          return [];
        }
        const page = quotaPage;
        quotaPage += 1;
        return Array.from({ length: 5_000 }, (_, index) => {
          const offset = page * 5_000 + index;
          return {
            id: `quota-${String(offset + 1).padStart(6, '0')}`,
            publishScheduledAt: new Date(
              Date.parse('2026-09-04T10:00:00.000Z') + offset * 30 * 60_000,
            ),
          };
        });
      });

      await expect(publishService.reconcileAutoPublishSchedules()).resolves.toBe(0);

      expect(quotaPage).toBe(20);
      expect(prisma.vkParsingPost.findMany).toHaveBeenCalledTimes(21);
      expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('replans a queue-to-immediate source transition at the next allowed time', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-04T10:00:00.000Z'));
    try {
      const { publishService, prisma } = createFixture();
      const source = createSource({
        publishMode: 'IMMEDIATE',
        publishIntervalMinutes: 180,
        minPublishIntervalMinutes: 30,
        lastAutoPublishedAt: new Date('2026-09-04T09:30:00.000Z'),
      });
      const post = createPostRow({
        source,
        publishQueuedAt: new Date('2026-09-04T09:00:00.000Z'),
        publishScheduledAt: new Date('2026-09-04T13:00:00.000Z'),
        publishIdempotencyKey: 'queued-mode-key',
        publishReason: 'autopublish',
        publishScheduleFingerprint: 'queued-mode-policy',
      });
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        chatId: 'channel-1',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-09-04T08:00:00.000Z'),
        schedulerTimezone: 'UTC',
        workHoursStart: '00:00',
        workHoursEnd: '00:00',
        distributeEvenlyEnabled: true,
        roundRobinEnabled: true,
      });
      prisma.vkParsingPost.findMany.mockResolvedValueOnce([post]);
      prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });

      await expect(publishService.reconcileAutoPublishSchedules()).resolves.toBe(1);

      expect(prisma.vkParsingPost.aggregate).not.toHaveBeenCalled();
      expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            publishScheduledAt: new Date('2026-09-04T10:00:00.000Z'),
          }),
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('limits schedule reconciliation to publish intents with no dispatch attempt', async () => {
    const { publishService, prisma } = createFixture();

    await expect(publishService.reconcileAutoPublishSchedules()).resolves.toBe(0);

    expect(prisma.vkParsingPost.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ publishAttemptCount: 0 }),
      }),
    );
  });

  it('clears an overdue legacy schedule instead of refreshing its 24-hour horizon', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-04T10:00:00.000Z'));
    try {
      const { publishService, prisma, publishQueue } = createFixture();
      const post = createPostRow({
        publishQueuedAt: new Date('2026-09-02T08:00:00.000Z'),
        publishScheduledAt: new Date('2026-09-02T10:00:00.000Z'),
        publishIdempotencyKey: 'legacy-key',
        publishReason: 'autopublish',
        publishScheduleFingerprint: null,
      });
      prisma.vkParsingPost.findMany.mockResolvedValueOnce([post]);
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        chatId: 'channel-1',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-09-01T08:00:00.000Z'),
      });
      prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });

      await expect(publishService.reconcileAutoPublishSchedules()).resolves.toBe(1);

      expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith({
        where: {
          id: post.id,
          publishReason: 'autopublish',
          publishIdempotencyKey: 'legacy-key',
          publishLockedAt: null,
          publishAttemptCount: 0,
          publishScheduledAt: new Date('2026-09-02T10:00:00.000Z'),
          lastError: null,
          status: 'NEW',
        },
        data: {
          publishQueuedAt: null,
          publishScheduledAt: null,
          publishLockedAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
          publishScheduleFingerprint: null,
        },
      });
      expect(prisma.vkParsingPost.aggregate).not.toHaveBeenCalled();
      expect(publishQueue.add).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears an overdue legacy schedule at the worker boundary before fingerprint replan', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-04T10:00:00.000Z'));
    try {
      const { service, prisma, maxClient, publishQueue } = createFixture();
      const post = createPostRow({
        createdAt: new Date('2026-09-01T09:00:00.000Z'),
        vkPublishedAt: new Date('2026-09-01T09:00:00.000Z'),
        publishQueuedAt: new Date('2026-09-02T08:00:00.000Z'),
        publishScheduledAt: new Date('2026-09-02T10:00:00.000Z'),
        publishIdempotencyKey: 'legacy-key',
        publishReason: 'autopublish',
        publishScheduleFingerprint: null,
      });
      prisma.vkParsingPost.findFirst.mockResolvedValue(post);
      prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-09-01T08:00:00.000Z'),
        autoPublishKillSwitchEnabled: false,
      });

      await service.processPublishPostJob({
        postId: post.id,
        chatId: post.chatId,
        reason: 'autopublish',
        idempotencyKey: 'legacy-key',
      });

      expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            publishQueuedAt: null,
            publishScheduledAt: null,
            publishLockedAt: null,
            publishIdempotencyKey: null,
            publishReason: null,
            publishScheduleFingerprint: null,
          },
        }),
      );
      expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ publishScheduledAt: expect.any(Date) }),
        }),
      );
      expect(publishQueue.add).not.toHaveBeenCalled();
      expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the logical publish key when an attempted intent has a stale fingerprint', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-25T10:00:00.000Z'));
    try {
      const { service, prisma, maxClient, maxRoutedPublicationService } = createFixture();
      const post = createPostRow({
        publishQueuedAt: new Date('2026-05-25T09:59:00.000Z'),
        publishScheduledAt: new Date('2026-05-25T10:00:00.000Z'),
        publishIdempotencyKey: 'attempted-key',
        publishReason: 'autopublish',
        publishScheduleFingerprint: 'stale-policy',
        publishAttemptCount: 1,
      });
      prisma.vkParsingPost.findFirst.mockResolvedValue(post);
      prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
        autoPublishKillSwitchEnabled: false,
        schedulerTimezone: 'UTC',
        workHoursStart: '00:00',
        workHoursEnd: '00:00',
      });
      maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
        messageId: 'max-message-1',
        url: 'https://max.ru/channel-1/max-message-1',
      });

      await service.processPublishPostJob({
        postId: post.id,
        chatId: post.chatId,
        reason: 'autopublish',
        idempotencyKey: 'attempted-key',
      });

      expect(maxRoutedPublicationService.publish).toHaveBeenCalledWith(
        expect.objectContaining({
          logicalIdempotencyKey: 'vk-parsing:publish:post-1:attempted-key',
        }),
      );
      expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ publishIdempotencyKey: expect.any(String) }),
        }),
      );
      expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            publishAttemptCount: 1,
            publishScheduleFingerprint: 'stale-policy',
          }),
          data: {
            publishScheduleFingerprint: expect.stringMatching(/^[a-f0-9]{32}$/u),
          },
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('defers a due unattempted intent when its current policy requires a later slot', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-04T10:00:00.000Z'));
    try {
      const { service, prisma, maxClient, publishQueue } = createFixture();
      const source = createSource({
        publishIntervalMinutes: 180,
        minPublishIntervalMinutes: 30,
        lastAutoPublishedAt: new Date('2026-09-04T09:30:00.000Z'),
      });
      const post = createPostRow({
        source,
        createdAt: new Date('2026-09-04T09:00:00.000Z'),
        vkPublishedAt: new Date('2026-09-04T09:00:00.000Z'),
        publishQueuedAt: new Date('2026-09-04T09:59:00.000Z'),
        publishScheduledAt: new Date('2026-09-04T10:00:00.000Z'),
        publishIdempotencyKey: 'old-30-minute-key',
        publishReason: 'autopublish',
        publishScheduleFingerprint: 'old-30-minute-policy',
        publishAttemptCount: 0,
      });
      prisma.vkParsingPost.findFirst.mockResolvedValue(post);
      prisma.vkParsingPost.aggregate.mockResolvedValue({
        _max: { publishScheduledAt: null },
      });
      prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-09-04T08:00:00.000Z'),
        autoPublishKillSwitchEnabled: false,
        schedulerTimezone: 'UTC',
        quietHoursStart: null,
        quietHoursEnd: null,
        workHoursStart: '00:00',
        workHoursEnd: '00:00',
        distributeEvenlyEnabled: true,
        roundRobinEnabled: false,
      });

      await service.processPublishPostJob({
        postId: post.id,
        chatId: post.chatId,
        reason: 'autopublish',
        idempotencyKey: 'old-30-minute-key',
      });

      const deferred = prisma.vkParsingPost.updateMany.mock.calls.find(
        ([query]) => query.data.publishScheduledAt instanceof Date,
      )?.[0];
      expect(deferred).toEqual(
        expect.objectContaining({
          where: {
            id: post.id,
            publishIdempotencyKey: 'old-30-minute-key',
            publishReason: 'autopublish',
            publishLockedAt: null,
            publishAttemptCount: 0,
            lastError: null,
          },
          data: expect.objectContaining({
            publishScheduledAt: new Date('2026-09-04T12:30:00.000Z'),
            publishIdempotencyKey: expect.not.stringMatching(/^old-30-minute-key$/u),
            publishScheduleFingerprint: expect.stringMatching(/^[a-f0-9]{32}$/u),
          }),
        }),
      );
      expect(publishQueue.add).toHaveBeenCalledWith(
        'publish-vk-post',
        expect.objectContaining({
          postId: post.id,
          idempotencyKey: deferred?.data.publishIdempotencyKey,
        }),
        expect.objectContaining({ delay: 150 * 60_000 }),
      );
      expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('persists an automatic publish and its source timestamp in one transaction', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-25T10:00:00.000Z'));
    try {
      const { service, prisma, maxClient } = createFixture();
      const source = createSource();
      const settings = {
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
        autoPublishKillSwitchEnabled: false,
        schedulerTimezone: 'UTC',
        quietHoursStart: null,
        quietHoursEnd: null,
        workHoursStart: '00:00',
        workHoursEnd: '00:00',
        distributeEvenlyEnabled: true,
        roundRobinEnabled: false,
      };
      const post = createPostRow({
        source,
        publishQueuedAt: new Date('2026-05-25T09:59:00.000Z'),
        publishScheduledAt: new Date('2026-05-25T10:00:00.000Z'),
        publishIdempotencyKey: 'publish-key-1',
        publishReason: 'autopublish',
        publishScheduleFingerprint: buildVkAutoPublishScheduleFingerprint(settings, source),
      });
      const rollupError = new Error('source rollup failed');
      const transactionalPostUpdate = jest.fn().mockResolvedValue({ count: 1 });
      const transactionalSourceUpdate = jest.fn().mockRejectedValue(rollupError);
      prisma.vkParsingPost.findFirst.mockResolvedValue(post);
      prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
      prisma.vkParsingSettings.findUnique.mockResolvedValue(settings);
      prisma.$transaction.mockImplementationOnce(async (operation: any) =>
        operation({
          ...prisma,
          vkParsingPost: { ...prisma.vkParsingPost, updateMany: transactionalPostUpdate },
          vkParsingSource: { ...prisma.vkParsingSource, updateMany: transactionalSourceUpdate },
        }),
      );
      maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
        messageId: 'max-message-1',
        url: 'https://max.ru/channel-1/max-message-1',
      });

      await expect(
        service.processPublishPostJob({
          postId: post.id,
          chatId: post.chatId,
          reason: 'autopublish',
          idempotencyKey: 'publish-key-1',
        }),
      ).rejects.toMatchObject({
        name: 'VkConfirmedPublishPersistenceError',
        persistenceCause: rollupError,
      });

      expect(transactionalPostUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'PUBLISHED',
            autoPublishedAt: new Date('2026-05-25T10:00:00.000Z'),
          }),
        }),
      );
      expect(transactionalSourceUpdate).toHaveBeenCalledWith({
        where: {
          id: source.id,
          chatId: source.chatId,
          ownerProfile: source.ownerProfile,
          ownerBotId: source.ownerBotId,
          OR: [
            { lastAutoPublishedAt: null },
            {
              lastAutoPublishedAt: { lt: new Date('2026-05-25T10:00:00.000Z') },
            },
          ],
        },
        data: { lastAutoPublishedAt: new Date('2026-05-25T10:00:00.000Z') },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps an invalid legacy schedule deferred across consecutive worker runs', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-04T10:00:00.000Z'));
    try {
      const { service, prisma, maxClient, publishQueue } = createFixture();
      let storedPost = createPostRow({
        createdAt: new Date('2026-09-04T09:00:00.000Z'),
        vkPublishedAt: new Date('2026-09-04T09:00:00.000Z'),
        publishQueuedAt: new Date('2026-09-04T09:59:00.000Z'),
        publishScheduledAt: new Date('2026-09-04T10:00:00.000Z'),
        publishIdempotencyKey: 'legacy-key',
        publishReason: 'autopublish',
        publishScheduleFingerprint: null,
      });
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-09-04T08:00:00.000Z'),
        autoPublishKillSwitchEnabled: false,
        schedulerTimezone: 'UTC',
        workHoursStart: '09:00',
        workHoursEnd: '18:00',
        quietHoursStart: '09:00',
        quietHoursEnd: '18:00',
        roundRobinEnabled: false,
      });
      prisma.vkParsingPost.findFirst.mockImplementation(async () => ({ ...storedPost }));
      prisma.vkParsingPost.updateMany.mockImplementation(async (query: any) => {
        if (
          query.where.publishIdempotencyKey !== undefined &&
          query.where.publishIdempotencyKey !== storedPost.publishIdempotencyKey
        ) {
          return { count: 0 };
        }
        storedPost = { ...storedPost, ...query.data };
        return { count: 1 };
      });

      const firstResult = await service.processPublishPostJob({
        postId: storedPost.id,
        chatId: storedPost.chatId,
        reason: 'autopublish',
        idempotencyKey: 'legacy-key',
      });
      const firstDeferredKey = storedPost.publishIdempotencyKey!;
      expect(firstDeferredKey).toBe('legacy-key');
      expect(storedPost.publishScheduledAt).toEqual(new Date('2026-09-04T11:00:00.000Z'));
      expect(firstResult).toEqual({
        deferUntil: new Date('2026-09-04T11:00:00.000Z'),
      });

      jest.setSystemTime(new Date('2026-09-04T11:00:00.000Z'));
      const secondResult = await service.processPublishPostJob({
        postId: storedPost.id,
        chatId: storedPost.chatId,
        reason: 'autopublish',
        idempotencyKey: firstDeferredKey,
      });

      expect(storedPost.status).toBe('NEW');
      expect(storedPost.lastError).toBeNull();
      expect(storedPost.publishIdempotencyKey).toBe('legacy-key');
      expect(storedPost.publishScheduledAt).toEqual(new Date('2026-09-04T12:00:00.000Z'));
      expect(secondResult).toEqual({
        deferUntil: new Date('2026-09-04T12:00:00.000Z'),
      });
      expect(publishQueue.add).not.toHaveBeenCalled();
      expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('fills a nearby round-robin gap instead of appending after the global queue tail', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-04T10:00:00.000Z'));
    try {
      const { publishService, prisma } = createFixture();
      const post = createPostRow({
        source: createSource({
          publishIntervalMinutes: 30,
          minPublishIntervalMinutes: 30,
          autoPublishEnabledAt: new Date('2026-09-04T09:00:00.000Z'),
        }),
      });
      prisma.vkParsingPost.aggregate.mockResolvedValueOnce({
        _max: { publishScheduledAt: null },
      });
      prisma.vkParsingPost.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
        { id: 'occupied-1', publishScheduledAt: new Date('2026-09-04T10:00:00.000Z') },
        { id: 'occupied-2', publishScheduledAt: new Date('2026-09-04T16:00:00.000Z') },
      ]);
      const settings = {
        schedulerTimezone: 'UTC',
        workHoursStart: '00:00',
        workHoursEnd: '00:00',
        quietHoursStart: null,
        quietHoursEnd: null,
        distributeEvenlyEnabled: true,
        roundRobinEnabled: true,
      };

      await expect(
        (publishService as any).resolveInitialAutoPublishAt(post, settings),
      ).resolves.toEqual(new Date('2026-09-04T10:01:00.000Z'));
    } finally {
      jest.useRealTimers();
    }
  });

  it('applies the daily limit in the configured timezone and resumes at local work start', async () => {
    const { publishService, prisma } = createFixture();
    const post = createPostRow({
      publishScheduledAt: new Date('2026-09-04T18:00:00.000Z'),
      source: createSource({ dailyLimit: 3 }),
    });
    prisma.vkParsingPost.count.mockResolvedValue(3);
    const settings = {
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-09-04T08:00:00.000Z'),
      autoPublishKillSwitchEnabled: false,
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      appendChannelLinkEnabled: false,
      channelLinkText: 'Подписаться на канал',
      schedulerTimezone: 'Europe/Moscow',
      quietHoursStart: null,
      quietHoursEnd: null,
      workHoursStart: '09:00',
      workHoursEnd: '22:00',
      distributeEvenlyEnabled: true,
      roundRobinEnabled: true,
      circuitBreakerEnabled: true,
      circuitBreakerWindowMinutes: 10,
      circuitBreakerPostLimit: 10,
      updatedAt: null,
    };

    await expect(
      (publishService as any).resolveDeferredPublishAt(
        post,
        settings,
        new Date('2026-09-04T18:00:00.000Z'),
      ),
    ).resolves.toEqual(new Date('2026-09-05T06:00:00.000Z'));
    expect(prisma.vkParsingPost.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          autoPublishedAt: {
            gte: new Date('2026-09-03T21:00:00.000Z'),
            lt: new Date('2026-09-04T21:00:00.000Z'),
          },
        }),
      }),
    );
  });

  it('does not queue newly imported VK posts while source autopublish is paused', async () => {
    const { service, prisma, publishQueue } = createFixture();
    const source = createSource({
      lastSuccessAt: new Date('2026-05-25T09:30:00.000Z'),
      autoPublishPausedAt: new Date('2026-05-25T09:45:00.000Z'),
      autoPublishPausedReason: 'max.access_lost',
    });
    const post = createPostRow({
      source,
      text: 'Пост из остановленного источника',
    });
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([post]);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [
            {
              owner_id: -36819802,
              id: 101,
              date: 1_779_708_000,
              text: 'Пост из остановленного источника',
            },
          ],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'post-1' }),
        data: expect.objectContaining({
          publishQueuedAt: expect.any(Date),
        }),
      }),
    );
    expect(publishQueue.add).not.toHaveBeenCalled();
  });

  it('does not queue newly imported VK posts published before autopublish was enabled', async () => {
    const { service, prisma, publishQueue } = createFixture();
    const source = createSource({ lastSuccessAt: new Date('2026-05-25T09:30:00.000Z') });
    const post = createPostRow({
      source,
      text: 'Старый пост из свежего импорта',
      createdAt: new Date('2026-05-25T12:10:00.000Z'),
      vkPublishedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([post]);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T12:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T12:00:00.000Z'),
    });
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [
            {
              owner_id: -36819802,
              id: 101,
              date: 1_779_708_000,
              text: 'Старый пост из свежего импорта',
            },
          ],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'post-1' }),
      }),
    );
    expect(publishQueue.add).not.toHaveBeenCalled();
  });

  it('does not queue newly imported VK posts without a VK publish date', async () => {
    const { service, prisma, publishQueue } = createFixture();
    const source = createSource({ lastSuccessAt: new Date('2026-05-25T09:30:00.000Z') });
    const post = createPostRow({
      source,
      text: 'Пост без даты VK',
      createdAt: new Date('2026-05-25T12:10:00.000Z'),
      vkPublishedAt: null,
    });
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([post]);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T12:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T12:00:00.000Z'),
    });
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [
            {
              owner_id: -36819802,
              id: 101,
              text: 'Пост без даты VK',
            },
          ],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'post-1' }),
      }),
    );
    expect(publishQueue.add).not.toHaveBeenCalled();
  });

  it('quarantines legacy stale publish rows without an explicit ownership reason', async () => {
    const { service, prisma, publishQueue } = createFixture();
    const source = createSource();
    const now = Date.now();
    const post = createPostRow({
      source,
      publishQueuedAt: new Date(now - 5 * 60_000),
      publishLockedAt: new Date(now - 4 * 60_000),
      publishIdempotencyKey: 'publish-key-1',
      publishReason: null,
    });
    prisma.vkParsingPost.findMany.mockResolvedValueOnce([post]);

    await expect(service.recoverStalePublishJobs()).resolves.toBe(0);

    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
    expect(prisma.vkParsingSettings.findUnique).not.toHaveBeenCalled();
    expect(publishQueue.getJob).not.toHaveBeenCalled();
    expect(publishQueue.add).not.toHaveBeenCalled();
  });

  it('recovers overdue VK publish jobs before scanning future delayed jobs', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-25T12:00:00.000Z'));
    try {
      const { service, prisma, publishQueue } = createFixture({
        VK_PARSING_QUEUE_BATCH_SIZE: 1,
      });
      const source = createSource();
      const duePost = createPostRow({
        source,
        id: 'post-due',
        publishQueuedAt: new Date('2026-05-25T10:01:00.000Z'),
        publishScheduledAt: new Date('2026-05-25T11:55:00.000Z'),
        publishLockedAt: new Date('2026-05-25T10:01:05.000Z'),
        publishIdempotencyKey: 'publish-key-due',
        publishReason: 'autopublish',
      });
      prisma.vkParsingPost.findMany.mockResolvedValueOnce([duePost]);
      prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        id: 'settings-1',
        chatId: 'channel-1',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
        stripLinksEnabled: false,
        skipAdsEnabled: false,
        createdAt: new Date('2026-05-25T10:00:00.000Z'),
        updatedAt: new Date('2026-05-25T10:00:00.000Z'),
      });

      await expect(service.recoverStalePublishJobs()).resolves.toBe(1);

      expect(prisma.vkParsingPost.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.vkParsingPost.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              {
                OR: [
                  { publishScheduledAt: null },
                  { publishScheduledAt: { lte: new Date('2026-05-25T12:00:00.000Z') } },
                ],
              },
            ]),
          }),
          orderBy: { id: 'asc' },
          take: 1,
        }),
      );
      expect(publishQueue.add).toHaveBeenCalledWith(
        'publish-vk-post',
        expect.objectContaining({
          postId: 'post-due',
          idempotencyKey: 'publish-key-due',
        }),
        expect.objectContaining({
          delay: 0,
          jobId: 'vk-parsing-publish__post-due__publish-key-due',
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('advances past a healthy due batch and recovers a missing job later in the backlog', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-25T12:00:00.000Z'));
    try {
      const { service, prisma, publishQueue } = createFixture({
        VK_PARSING_QUEUE_BATCH_SIZE: 2,
      });
      const posts = ['post-1', 'post-2', 'post-3'].map((id, index) =>
        createPostRow({
          id,
          publishQueuedAt: new Date(`2026-05-25T10:0${index}:00.000Z`),
          publishScheduledAt: new Date(`2026-05-25T11:0${index}:00.000Z`),
          publishIdempotencyKey: `publish-key-${index + 1}`,
          publishReason: 'autopublish',
        }),
      );
      prisma.vkParsingPost.findMany
        .mockResolvedValueOnce(posts.slice(0, 2))
        .mockResolvedValueOnce(posts.slice(2))
        .mockResolvedValueOnce([]);
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        id: 'settings-1',
        chatId: 'channel-1',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
        stripLinksEnabled: false,
        skipAdsEnabled: false,
        createdAt: new Date('2026-05-25T09:00:00.000Z'),
        updatedAt: new Date('2026-05-25T09:00:00.000Z'),
      });
      publishQueue.getJob
        .mockResolvedValueOnce(
          createQueueJob('waiting', {
            postId: posts[0]!.id,
            chatId: posts[0]!.chatId,
            reason: 'autopublish',
            idempotencyKey: posts[0]!.publishIdempotencyKey,
          }),
        )
        .mockResolvedValueOnce(
          createQueueJob('waiting', {
            postId: posts[1]!.id,
            chatId: posts[1]!.chatId,
            reason: 'autopublish',
            idempotencyKey: posts[1]!.publishIdempotencyKey,
          }),
        );

      await expect(service.recoverStalePublishJobs()).resolves.toBe(0);
      await expect(service.recoverStalePublishJobs()).resolves.toBe(1);

      expect(prisma.vkParsingPost.findMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([{ id: { gt: 'post-2' } }]),
          }),
          orderBy: { id: 'asc' },
          take: 2,
        }),
      );
      expect(publishQueue.add).toHaveBeenCalledWith(
        'publish-vk-post',
        expect.objectContaining({ postId: 'post-3', idempotencyKey: 'publish-key-3' }),
        expect.objectContaining({ delay: 0 }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears historical overdue autopublish intents instead of replaying them', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
    try {
      const { service, prisma, publishQueue } = createFixture();
      const source = createSource();
      const explicitPost = createPostRow({
        source,
        id: 'post-explicit',
        publishQueuedAt: new Date('2026-07-04T10:00:00.000Z'),
        publishScheduledAt: new Date('2026-07-04T10:05:00.000Z'),
        publishIdempotencyKey: 'publish-key-explicit',
        publishReason: 'autopublish',
      });
      const legacyPost = createPostRow({
        source,
        id: 'post-legacy',
        publishQueuedAt: new Date('2026-07-05T10:00:00.000Z'),
        publishScheduledAt: null,
        publishIdempotencyKey: 'publish-key-legacy',
        publishReason: null,
      });
      prisma.vkParsingPost.findMany.mockResolvedValueOnce([explicitPost, legacyPost]);
      prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
        autoPublishKillSwitchEnabled: false,
      });

      await expect(service.recoverStalePublishJobs()).resolves.toBe(0);

      expect(prisma.vkParsingSettings.findUnique).toHaveBeenCalled();
      expect(publishQueue.getJob).toHaveBeenCalledWith(
        'vk-parsing-publish__post-explicit__publish-key-explicit',
      );
      expect(publishQueue.add).not.toHaveBeenCalled();
      expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'post-explicit',
          publishReason: 'autopublish',
          publishIdempotencyKey: 'publish-key-explicit',
          publishLockedAt: null,
          publishAttemptCount: 0,
          publishScheduledAt: new Date('2026-07-04T10:05:00.000Z'),
          lastError: null,
          status: 'NEW',
        },
        data: {
          publishQueuedAt: null,
          publishScheduledAt: null,
          publishLockedAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
          publishScheduleFingerprint: null,
        },
      });
      expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 'post-legacy' }) }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps old autopublish ownership until its effective scheduled time is overdue', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
    try {
      const { service, prisma, publishQueue } = createFixture();
      const post = createPostRow({
        createdAt: new Date('2026-07-27T10:00:00.000Z'),
        vkPublishedAt: new Date('2026-07-27T10:00:00.000Z'),
        publishQueuedAt: new Date('2026-07-04T10:00:00.000Z'),
        publishScheduledAt: new Date('2026-07-28T10:00:00.000Z'),
        publishIdempotencyKey: 'old-ownership-future-schedule',
        publishReason: 'autopublish',
      });
      const delayedJob = createQueueJob('delayed', {
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'autopublish',
        idempotencyKey: 'old-ownership-future-schedule',
      });
      prisma.vkParsingPost.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([post]);
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        id: 'settings-1',
        chatId: 'channel-1',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-07-04T09:00:00.000Z'),
        stripLinksEnabled: false,
        skipAdsEnabled: false,
        createdAt: new Date('2026-07-04T09:00:00.000Z'),
        updatedAt: new Date('2026-07-04T09:00:00.000Z'),
      });
      publishQueue.getJob.mockResolvedValueOnce(delayedJob);

      await expect(service.recoverStalePublishJobs()).resolves.toBe(0);

      expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
      expect(publishQueue.getJob).toHaveBeenCalledWith(
        'vk-parsing-publish__post-1__old-ownership-future-schedule',
      );
      expect(publishQueue.add).not.toHaveBeenCalled();
      expect(delayedJob.remove).not.toHaveBeenCalled();
      expect(delayedJob.retry).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('blocks a historical autopublish job that starts before recovery can clear it', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
    try {
      const { service, prisma, maxClient, publishQueue } = createFixture();
      const workerLock = new Date('2026-07-27T12:00:00.000Z');
      const post = createPostRow({
        publishQueuedAt: new Date('2026-07-04T10:00:00.000Z'),
        publishScheduledAt: new Date('2026-07-04T10:05:00.000Z'),
        publishLockedAt: workerLock,
        publishIdempotencyKey: 'historical-auto-key',
        publishReason: 'autopublish',
      });
      prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
      prisma.vkParsingPost.findFirst.mockResolvedValue(post);
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
        autoPublishKillSwitchEnabled: false,
      });

      await service.processPublishPostJob({
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'autopublish',
        idempotencyKey: 'historical-auto-key',
      });

      expect(prisma.vkParsingPost.updateMany).toHaveBeenLastCalledWith({
        where: {
          id: 'post-1',
          publishReason: 'autopublish',
          publishIdempotencyKey: 'historical-auto-key',
          publishLockedAt: workerLock,
          publishAttemptCount: 0,
          publishScheduledAt: new Date('2026-07-04T10:05:00.000Z'),
          lastError: null,
          status: 'NEW',
        },
        data: {
          publishQueuedAt: null,
          publishScheduledAt: null,
          publishLockedAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
          publishScheduleFingerprint: null,
        },
      });
      expect(prisma.vkParsingSettings.findUnique).toHaveBeenCalled();
      expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
      expect(publishQueue.add).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(['delayed', 'waiting', 'active'])(
    'keeps a healthy future %s publish job and its canonical schedule unchanged',
    async (state) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
      try {
        const { service, prisma, publishQueue } = createFixture();
        const post = createPostRow({
          createdAt: new Date('2026-07-27T11:40:00.000Z'),
          vkPublishedAt: new Date('2026-07-27T11:40:00.000Z'),
          publishQueuedAt: new Date('2026-07-27T11:45:00.000Z'),
          publishScheduledAt: new Date('2026-07-27T13:00:00.000Z'),
          publishIdempotencyKey: `publish-key-${state}`,
          publishReason: 'autopublish',
        });
        const queueJob = createQueueJob(state, {
          postId: 'post-1',
          chatId: 'channel-1',
          reason: 'autopublish',
          idempotencyKey: `publish-key-${state}`,
        });
        prisma.vkParsingPost.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([post]);
        prisma.vkParsingSettings.findUnique.mockResolvedValue({
          id: 'settings-1',
          chatId: 'channel-1',
          autoPublishEnabled: true,
          autoPublishEnabledAt: new Date('2026-07-27T09:00:00.000Z'),
          stripLinksEnabled: false,
          skipAdsEnabled: false,
          createdAt: new Date('2026-07-27T09:00:00.000Z'),
          updatedAt: new Date('2026-07-27T09:00:00.000Z'),
        });
        publishQueue.getJob.mockResolvedValueOnce(queueJob);

        await expect(service.recoverStalePublishJobs()).resolves.toBe(0);

        expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
        expect(publishQueue.add).not.toHaveBeenCalled();
        expect(queueJob.remove).not.toHaveBeenCalled();
        expect(queueJob.updateData).not.toHaveBeenCalled();
        expect(queueJob.retry).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('replaces an inactive publish job when its ownership payload does not match', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
    try {
      const { service, prisma, publishQueue } = createFixture();
      const post = createPostRow({
        createdAt: new Date('2026-07-27T11:40:00.000Z'),
        vkPublishedAt: new Date('2026-07-27T11:40:00.000Z'),
        publishQueuedAt: new Date('2026-07-27T11:45:00.000Z'),
        publishScheduledAt: new Date('2026-07-27T13:00:00.000Z'),
        publishIdempotencyKey: 'expected-key',
        publishReason: 'autopublish',
      });
      const mismatchedJob = createQueueJob('delayed', {
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'manual-schedule',
        idempotencyKey: 'wrong-key',
      });
      prisma.vkParsingPost.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([post]);
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        id: 'settings-1',
        chatId: 'channel-1',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-07-27T09:00:00.000Z'),
        stripLinksEnabled: false,
        skipAdsEnabled: false,
        createdAt: new Date('2026-07-27T09:00:00.000Z'),
        updatedAt: new Date('2026-07-27T09:00:00.000Z'),
      });
      publishQueue.getJob.mockResolvedValueOnce(mismatchedJob);

      await expect(service.recoverStalePublishJobs()).resolves.toBe(1);

      expect(mismatchedJob.remove).toHaveBeenCalledTimes(1);
      expect(publishQueue.add).toHaveBeenCalledWith(
        'publish-vk-post',
        expect.objectContaining({
          reason: 'autopublish',
          idempotencyKey: 'expected-key',
        }),
        expect.objectContaining({ delay: 60 * 60_000 }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('replaces an inactive delayed job when its schedule drifts from the database', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
    try {
      const { service, prisma, publishQueue } = createFixture();
      const post = createPostRow({
        createdAt: new Date('2026-07-27T11:40:00.000Z'),
        vkPublishedAt: new Date('2026-07-27T11:40:00.000Z'),
        publishQueuedAt: new Date('2026-07-27T11:45:00.000Z'),
        publishScheduledAt: new Date('2026-07-27T13:00:00.000Z'),
        publishIdempotencyKey: 'expected-key',
        publishReason: 'autopublish',
      });
      const driftedJob = {
        ...createQueueJob('delayed', {
          postId: post.id,
          chatId: post.chatId,
          reason: 'autopublish',
          idempotencyKey: post.publishIdempotencyKey,
        }),
        timestamp: Date.now(),
        delay: 4 * 60 * 60_000,
      };
      prisma.vkParsingPost.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([post]);
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        id: 'settings-1',
        chatId: 'channel-1',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-07-27T09:00:00.000Z'),
        stripLinksEnabled: false,
        skipAdsEnabled: false,
        createdAt: new Date('2026-07-27T09:00:00.000Z'),
        updatedAt: new Date('2026-07-27T09:00:00.000Z'),
      });
      publishQueue.getJob.mockResolvedValueOnce(driftedJob);

      await expect(service.recoverStalePublishJobs()).resolves.toBe(1);

      expect(driftedJob.remove).toHaveBeenCalledTimes(1);
      expect(publishQueue.add).toHaveBeenCalledWith(
        'publish-vk-post',
        expect.objectContaining({ postId: post.id, idempotencyKey: post.publishIdempotencyKey }),
        expect.objectContaining({ delay: 60 * 60_000 }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('recreates a failed publish job at its future canonical database schedule', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
    try {
      const { service, prisma, publishQueue } = createFixture();
      const post = createPostRow({
        status: 'FAILED',
        createdAt: new Date('2026-07-27T11:40:00.000Z'),
        vkPublishedAt: new Date('2026-07-27T11:40:00.000Z'),
        publishQueuedAt: new Date('2026-07-27T11:45:00.000Z'),
        publishScheduledAt: new Date('2026-07-27T13:30:00.000Z'),
        publishIdempotencyKey: 'failed-future-key',
        publishReason: 'autopublish',
        publishAttemptCount: 5,
      });
      const failedJob = createQueueJob('failed', {
        postId: post.id,
        chatId: post.chatId,
        reason: 'autopublish',
        idempotencyKey: 'failed-future-key',
      });
      prisma.vkParsingPost.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([post]);
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        id: 'settings-1',
        chatId: 'channel-1',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-07-27T09:00:00.000Z'),
        stripLinksEnabled: false,
        skipAdsEnabled: false,
        createdAt: new Date('2026-07-27T09:00:00.000Z'),
        updatedAt: new Date('2026-07-27T09:00:00.000Z'),
      });
      publishQueue.getJob.mockResolvedValueOnce(failedJob);

      await expect(service.recoverStalePublishJobs()).resolves.toBe(1);

      expect(failedJob.remove).toHaveBeenCalledTimes(1);
      expect(failedJob.updateData).not.toHaveBeenCalled();
      expect(failedJob.retry).not.toHaveBeenCalled();
      expect(publishQueue.add).toHaveBeenCalledWith(
        'publish-vk-post',
        expect.objectContaining({
          postId: post.id,
          reason: 'autopublish',
          idempotencyKey: 'failed-future-key',
        }),
        expect.objectContaining({
          delay: 90 * 60_000,
          jobId: 'vk-parsing-publish__post-1__failed-future-key',
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not treat a delayed retry backoff as canonical schedule drift', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
    try {
      const { service, prisma, publishQueue } = createFixture();
      const post = createPostRow({
        createdAt: new Date('2026-07-27T11:40:00.000Z'),
        vkPublishedAt: new Date('2026-07-27T11:40:00.000Z'),
        publishQueuedAt: new Date('2026-07-27T11:45:00.000Z'),
        publishScheduledAt: new Date('2026-07-27T13:00:00.000Z'),
        publishIdempotencyKey: 'retry-key',
        publishReason: 'autopublish',
      });
      const retryingJob = {
        ...createQueueJob('delayed', {
          postId: post.id,
          chatId: post.chatId,
          reason: 'autopublish',
          idempotencyKey: post.publishIdempotencyKey,
        }),
        timestamp: Date.now() - 60 * 60_000,
        delay: 60_000,
        attemptsMade: 1,
        attemptsStarted: 1,
        processedOn: Date.now() - 30_000,
      };
      prisma.vkParsingPost.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([post]);
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        id: 'settings-1',
        chatId: 'channel-1',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-07-27T09:00:00.000Z'),
        stripLinksEnabled: false,
        skipAdsEnabled: false,
        createdAt: new Date('2026-07-27T09:00:00.000Z'),
        updatedAt: new Date('2026-07-27T09:00:00.000Z'),
      });
      publishQueue.getJob.mockResolvedValueOnce(retryingJob);

      await expect(service.recoverStalePublishJobs()).resolves.toBe(0);

      expect(retryingJob.remove).not.toHaveBeenCalled();
      expect(retryingJob.retry).not.toHaveBeenCalled();
      expect(publishQueue.add).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('quarantines an active publish job when its ownership payload does not match', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
    try {
      const { service, prisma, publishQueue } = createFixture();
      const post = createPostRow({
        createdAt: new Date('2026-07-27T11:40:00.000Z'),
        vkPublishedAt: new Date('2026-07-27T11:40:00.000Z'),
        publishQueuedAt: new Date('2026-07-27T11:45:00.000Z'),
        publishScheduledAt: new Date('2026-07-27T13:00:00.000Z'),
        publishIdempotencyKey: 'expected-key',
        publishReason: 'autopublish',
      });
      const mismatchedJob = createQueueJob('active', {
        postId: 'other-post',
        chatId: 'channel-1',
        reason: 'autopublish',
        idempotencyKey: 'expected-key',
      });
      prisma.vkParsingPost.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([post]);
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        id: 'settings-1',
        chatId: 'channel-1',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-07-27T09:00:00.000Z'),
        stripLinksEnabled: false,
        skipAdsEnabled: false,
        createdAt: new Date('2026-07-27T09:00:00.000Z'),
        updatedAt: new Date('2026-07-27T09:00:00.000Z'),
      });
      publishQueue.getJob.mockResolvedValueOnce(mismatchedJob);

      await expect(service.recoverStalePublishJobs()).resolves.toBe(0);

      expect(mismatchedJob.remove).not.toHaveBeenCalled();
      expect(mismatchedJob.updateData).not.toHaveBeenCalled();
      expect(mismatchedJob.retry).not.toHaveBeenCalled();
      expect(publishQueue.add).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('advances past a healthy future batch and recovers a missing job later in the backlog', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
    try {
      const { service, prisma, publishQueue } = createFixture({
        VK_PARSING_QUEUE_BATCH_SIZE: 2,
      });
      const source = createSource();
      const posts = ['post-1', 'post-2', 'post-3'].map((id, index) =>
        createPostRow({
          source,
          id,
          createdAt: new Date(`2026-07-27T11:4${index}:00.000Z`),
          vkPublishedAt: new Date(`2026-07-27T11:4${index}:00.000Z`),
          publishQueuedAt: new Date(`2026-07-27T11:5${index}:00.000Z`),
          publishScheduledAt: new Date(`2026-07-27T13:0${index}:00.000Z`),
          publishIdempotencyKey: `publish-key-${index + 1}`,
          publishReason: 'autopublish',
        }),
      );
      prisma.vkParsingPost.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(posts.slice(0, 2))
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(posts.slice(2));
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        id: 'settings-1',
        chatId: 'channel-1',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-07-27T09:00:00.000Z'),
        stripLinksEnabled: false,
        skipAdsEnabled: false,
        createdAt: new Date('2026-07-27T09:00:00.000Z'),
        updatedAt: new Date('2026-07-27T09:00:00.000Z'),
      });
      const delayedJobs = posts.slice(0, 2).map((post, index) =>
        createQueueJob('delayed', {
          postId: post.id,
          chatId: post.chatId,
          reason: 'autopublish',
          idempotencyKey: `publish-key-${index + 1}`,
        }),
      );
      publishQueue.getJob
        .mockResolvedValueOnce(delayedJobs[0])
        .mockResolvedValueOnce(delayedJobs[1]);

      await expect(service.recoverStalePublishJobs()).resolves.toBe(0);
      await expect(service.recoverStalePublishJobs()).resolves.toBe(1);

      expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
      expect(prisma.vkParsingPost.aggregate).not.toHaveBeenCalled();
      expect(prisma.vkParsingPost.findMany).toHaveBeenNthCalledWith(
        4,
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              {
                OR: [
                  { publishScheduledAt: { gt: new Date('2026-07-27T13:01:00.000Z') } },
                  {
                    publishScheduledAt: new Date('2026-07-27T13:01:00.000Z'),
                    publishQueuedAt: { gt: new Date('2026-07-27T11:51:00.000Z') },
                  },
                  {
                    publishScheduledAt: new Date('2026-07-27T13:01:00.000Z'),
                    publishQueuedAt: new Date('2026-07-27T11:51:00.000Z'),
                    updatedAt: { gt: new Date('2026-05-25T10:00:00.000Z') },
                  },
                  {
                    publishScheduledAt: new Date('2026-07-27T13:01:00.000Z'),
                    publishQueuedAt: new Date('2026-07-27T11:51:00.000Z'),
                    updatedAt: new Date('2026-05-25T10:00:00.000Z'),
                    id: { gt: 'post-2' },
                  },
                ],
              },
            ]),
          }),
        }),
      );
      expect(publishQueue.add).toHaveBeenCalledWith(
        'publish-vk-post',
        expect.objectContaining({ postId: 'post-3', idempotencyKey: 'publish-key-3' }),
        expect.objectContaining({ delay: 62 * 60_000 }),
      );
      for (const delayedJob of delayedJobs) {
        expect(delayedJob.remove).not.toHaveBeenCalled();
        expect(delayedJob.retry).not.toHaveBeenCalled();
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps overdue manual schedules outside the autopublish recovery horizon', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
    try {
      const { service, prisma, publishQueue } = createFixture();
      const post = createPostRow({
        source: createSource({ publishMode: 'REVIEW' }),
        publishQueuedAt: new Date('2026-07-04T10:00:00.000Z'),
        publishScheduledAt: new Date('2026-07-04T10:05:00.000Z'),
        publishIdempotencyKey: 'manual-schedule-key',
        publishReason: 'manual-schedule',
      });
      prisma.vkParsingPost.findMany.mockResolvedValueOnce([post]);

      await expect(service.recoverStalePublishJobs()).resolves.toBe(1);

      expect(publishQueue.add).toHaveBeenCalledWith(
        'publish-vk-post',
        expect.objectContaining({
          postId: 'post-1',
          reason: 'manual-schedule',
          idempotencyKey: 'manual-schedule-key',
        }),
        expect.objectContaining({ delay: 0 }),
      );
      expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not clear manual ownership that replaced a historical autopublish intent', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
    try {
      const { service, prisma, publishQueue } = createFixture();
      const staleSnapshot = createPostRow({
        publishQueuedAt: new Date('2026-07-04T10:00:00.000Z'),
        publishScheduledAt: new Date('2026-07-04T10:05:00.000Z'),
        publishLockedAt: new Date('2026-07-04T10:05:10.000Z'),
        publishIdempotencyKey: 'stale-auto-key',
        publishReason: 'autopublish',
      });
      const currentOwnership = {
        publishIdempotencyKey: 'new-manual-key',
        publishReason: 'manual-schedule',
        publishLockedAt: null,
      };
      prisma.vkParsingPost.findMany.mockResolvedValueOnce([staleSnapshot]);
      prisma.vkParsingPost.updateMany.mockImplementation(async ({ where }) => ({
        count:
          where.publishIdempotencyKey === currentOwnership.publishIdempotencyKey &&
          where.publishReason === currentOwnership.publishReason &&
          where.publishLockedAt === currentOwnership.publishLockedAt
            ? 1
            : 0,
      }));

      await expect(service.recoverStalePublishJobs()).resolves.toBe(0);

      expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 'post-1',
            publishReason: 'autopublish',
            publishIdempotencyKey: 'stale-auto-key',
            publishLockedAt: new Date('2026-07-04T10:05:10.000Z'),
            publishAttemptCount: 0,
            publishScheduledAt: new Date('2026-07-04T10:05:00.000Z'),
            lastError: null,
            status: 'NEW',
          },
        }),
      );
      expect(currentOwnership).toEqual({
        publishIdempotencyKey: 'new-manual-key',
        publishReason: 'manual-schedule',
        publishLockedAt: null,
      });
      expect(publishQueue.add).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('recreates a missing future publish job at the canonical database schedule', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
    try {
      const { service, prisma, publishQueue } = createFixture();
      const post = createPostRow({
        createdAt: new Date('2026-07-27T11:40:00.000Z'),
        vkPublishedAt: new Date('2026-07-27T11:40:00.000Z'),
        publishQueuedAt: new Date('2026-07-27T11:45:00.000Z'),
        publishScheduledAt: new Date('2026-07-27T13:30:00.000Z'),
        publishLockedAt: null,
        publishIdempotencyKey: 'missing-future-key',
        publishReason: 'autopublish',
      });
      prisma.vkParsingPost.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([post]);
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        id: 'settings-1',
        chatId: 'channel-1',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-07-27T09:00:00.000Z'),
        stripLinksEnabled: false,
        skipAdsEnabled: false,
        createdAt: new Date('2026-07-27T09:00:00.000Z'),
        updatedAt: new Date('2026-07-27T09:00:00.000Z'),
      });

      await expect(service.recoverStalePublishJobs()).resolves.toBe(1);

      expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
      expect(publishQueue.add).toHaveBeenCalledWith(
        'publish-vk-post',
        expect.objectContaining({
          postId: 'post-1',
          idempotencyKey: 'missing-future-key',
        }),
        expect.objectContaining({
          delay: 90 * 60_000,
          jobId: 'vk-parsing-publish__post-1__missing-future-key',
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not clear overdue autopublish after a worker acquires a fresh lock', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
    try {
      const { service, prisma, publishQueue } = createFixture();
      const historicalSnapshot = createPostRow({
        id: 'post-historical',
        publishQueuedAt: new Date('2026-07-04T10:00:00.000Z'),
        publishScheduledAt: new Date('2026-07-04T10:05:00.000Z'),
        publishLockedAt: null,
        publishIdempotencyKey: 'historical-auto-key',
        publishReason: 'autopublish',
      });
      const newlyAcquiredLock = new Date('2026-07-27T11:59:30.000Z');
      prisma.vkParsingPost.findMany.mockResolvedValueOnce([historicalSnapshot]);
      prisma.vkParsingPost.updateMany.mockImplementation(async ({ where }) => ({
        count:
          where.publishLockedAt instanceof Date &&
          where.publishLockedAt.getTime() === newlyAcquiredLock.getTime()
            ? 1
            : 0,
      }));
      await expect(service.recoverStalePublishJobs()).resolves.toBe(0);

      expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'post-historical',
            publishIdempotencyKey: 'historical-auto-key',
            publishLockedAt: null,
          }),
          data: expect.objectContaining({ publishIdempotencyKey: null }),
        }),
      );
      expect(publishQueue.getJob).toHaveBeenCalledWith(
        'vk-parsing-publish__post-historical__historical-auto-key',
      );
      expect(publishQueue.add).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not clear overdue autopublish while its exact queue job is active', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
    try {
      const { service, prisma, publishQueue } = createFixture();
      const post = createPostRow({
        id: 'post-historical',
        publishQueuedAt: new Date('2026-07-04T10:00:00.000Z'),
        publishScheduledAt: new Date('2026-07-04T10:05:00.000Z'),
        publishLockedAt: null,
        publishIdempotencyKey: 'historical-auto-key',
        publishReason: 'autopublish',
      });
      const activeJob = createQueueJob('active', {
        postId: post.id,
        chatId: post.chatId,
        reason: 'autopublish',
        idempotencyKey: post.publishIdempotencyKey,
      });
      prisma.vkParsingPost.findMany.mockResolvedValueOnce([post]);
      publishQueue.getJob.mockResolvedValueOnce(activeJob);

      await expect(service.recoverStalePublishJobs()).resolves.toBe(0);

      expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
      expect(activeJob.remove).not.toHaveBeenCalled();
      expect(publishQueue.add).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('removes an exact inactive queue job before clearing overdue autopublish ownership', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
    try {
      const { service, prisma, publishQueue } = createFixture();
      const post = createPostRow({
        id: 'post-historical',
        publishQueuedAt: new Date('2026-07-04T10:00:00.000Z'),
        publishScheduledAt: new Date('2026-07-04T10:05:00.000Z'),
        publishLockedAt: null,
        publishIdempotencyKey: 'historical-auto-key',
        publishReason: 'autopublish',
      });
      const waitingJob = createQueueJob('waiting', {
        postId: post.id,
        chatId: post.chatId,
        reason: 'autopublish',
        idempotencyKey: post.publishIdempotencyKey,
      });
      prisma.vkParsingPost.findMany.mockResolvedValueOnce([post]);
      prisma.vkParsingPost.updateMany.mockResolvedValueOnce({ count: 1 });
      publishQueue.getJob.mockResolvedValueOnce(waitingJob);

      await expect(service.recoverStalePublishJobs()).resolves.toBe(0);

      expect(waitingJob.remove).toHaveBeenCalledTimes(1);
      expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledTimes(1);
      expect(waitingJob.remove.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.vkParsingPost.updateMany.mock.invocationCallOrder[0]!,
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not clear overdue autopublish when a waiting job becomes active before removal', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
    try {
      const { service, prisma, publishQueue } = createFixture();
      const post = createPostRow({
        id: 'post-historical',
        publishQueuedAt: new Date('2026-07-04T10:00:00.000Z'),
        publishScheduledAt: new Date('2026-07-04T10:05:00.000Z'),
        publishLockedAt: null,
        publishIdempotencyKey: 'historical-auto-key',
        publishReason: 'autopublish',
      });
      const transitioningJob = createQueueJob('waiting', {
        postId: post.id,
        chatId: post.chatId,
        reason: 'autopublish',
        idempotencyKey: post.publishIdempotencyKey,
      });
      transitioningJob.remove.mockRejectedValueOnce(
        new Error('Job could not be removed because it is locked by another worker'),
      );
      prisma.vkParsingPost.findMany.mockResolvedValueOnce([post]);
      publishQueue.getJob.mockResolvedValueOnce(transitioningJob);

      await expect(service.recoverStalePublishJobs()).resolves.toBe(0);

      expect(transitioningJob.remove).toHaveBeenCalledTimes(1);
      expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
      expect(publishQueue.add).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not remove a queue job whose payload does not match overdue ownership', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
    try {
      const { service, prisma, publishQueue } = createFixture();
      const post = createPostRow({
        id: 'post-historical',
        publishQueuedAt: new Date('2026-07-04T10:00:00.000Z'),
        publishScheduledAt: new Date('2026-07-04T10:05:00.000Z'),
        publishLockedAt: null,
        publishIdempotencyKey: 'historical-auto-key',
        publishReason: 'autopublish',
      });
      const mismatchedJob = createQueueJob('waiting', {
        postId: post.id,
        chatId: 'another-chat',
        reason: 'autopublish',
        idempotencyKey: post.publishIdempotencyKey,
      });
      prisma.vkParsingPost.findMany.mockResolvedValueOnce([post]);
      publishQueue.getJob.mockResolvedValueOnce(mismatchedJob);

      await expect(service.recoverStalePublishJobs()).resolves.toBe(0);

      expect(mismatchedJob.getState).not.toHaveBeenCalled();
      expect(mismatchedJob.remove).not.toHaveBeenCalled();
      expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not clear overdue autopublish when its queue state cannot be read', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
    try {
      const { service, prisma, publishQueue } = createFixture();
      const post = createPostRow({
        id: 'post-historical',
        publishQueuedAt: new Date('2026-07-04T10:00:00.000Z'),
        publishScheduledAt: new Date('2026-07-04T10:05:00.000Z'),
        publishLockedAt: null,
        publishIdempotencyKey: 'historical-auto-key',
        publishReason: 'autopublish',
      });
      prisma.vkParsingPost.findMany.mockResolvedValueOnce([post]);
      publishQueue.getJob.mockRejectedValueOnce(new Error('redis unavailable'));

      await expect(service.recoverStalePublishJobs()).resolves.toBe(0);

      expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
      expect(publishQueue.add).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not clear overdue autopublish when reading the exact job state fails', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-27T12:00:00.000Z'));
    try {
      const { service, prisma, publishQueue } = createFixture();
      const post = createPostRow({
        id: 'post-historical',
        publishQueuedAt: new Date('2026-07-04T10:00:00.000Z'),
        publishScheduledAt: new Date('2026-07-04T10:05:00.000Z'),
        publishLockedAt: null,
        publishIdempotencyKey: 'historical-auto-key',
        publishReason: 'autopublish',
      });
      const unreadableJob = createQueueJob('waiting', {
        postId: post.id,
        chatId: post.chatId,
        reason: 'autopublish',
        idempotencyKey: post.publishIdempotencyKey,
      });
      unreadableJob.getState.mockRejectedValueOnce(new Error('redis state read failed'));
      prisma.vkParsingPost.findMany.mockResolvedValueOnce([post]);
      publishQueue.getJob.mockResolvedValueOnce(unreadableJob);

      await expect(service.recoverStalePublishJobs()).resolves.toBe(0);

      expect(unreadableJob.remove).not.toHaveBeenCalled();
      expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
      expect(publishQueue.add).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it.each(['failed', 'completed'])(
    'recovers an existing %s VK publish job instead of re-adding a duplicate jobId',
    async (state) => {
      const { service, prisma, publishQueue } = createFixture();
      const source = createSource();
      const now = Date.now();
      const post = createPostRow({
        source,
        publishQueuedAt: new Date(now - 5 * 60_000),
        publishLockedAt: new Date(now - 4 * 60_000),
        publishIdempotencyKey: 'publish-key-1',
        publishReason: 'autopublish',
      });
      const terminalJob = createQueueJob(state, {
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'autopublish',
        idempotencyKey: 'publish-key-1',
      });
      prisma.vkParsingPost.findMany.mockResolvedValueOnce([post]);
      prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        id: 'settings-1',
        chatId: 'channel-1',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
        stripLinksEnabled: false,
        skipAdsEnabled: false,
        createdAt: new Date('2026-05-25T10:00:00.000Z'),
        updatedAt: new Date('2026-05-25T10:00:00.000Z'),
      });
      publishQueue.getJob.mockResolvedValueOnce(terminalJob);

      await expect(service.recoverStalePublishJobs()).resolves.toBe(1);

      expect(publishQueue.getJob).toHaveBeenCalledWith('vk-parsing-publish__post-1__publish-key-1');
      expect(terminalJob.updateData).toHaveBeenCalledWith(
        expect.objectContaining({
          postId: 'post-1',
          chatId: 'channel-1',
          reason: 'autopublish',
          idempotencyKey: 'publish-key-1',
          retryPolicyName: 'vk-parsing-publish',
        }),
      );
      expect(terminalJob.retry).toHaveBeenCalledWith(state, {
        resetAttemptsMade: true,
        resetAttemptsStarted: true,
      });
      expect(publishQueue.add).not.toHaveBeenCalled();
    },
  );

  it('replaces an orphaned VK publish job whose BullMQ state is unknown', async () => {
    const { service, prisma, publishQueue } = createFixture();
    const source = createSource();
    const now = Date.now();
    const post = createPostRow({
      source,
      publishQueuedAt: new Date(now - 5 * 60_000),
      publishScheduledAt: new Date(now - 4 * 60_000),
      publishIdempotencyKey: 'publish-key-1',
      publishReason: 'autopublish',
    });
    const orphanedJob = createQueueJob('unknown');
    prisma.vkParsingPost.findMany.mockResolvedValueOnce([post]);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    publishQueue.getJob.mockResolvedValueOnce(orphanedJob);

    await expect(service.recoverStalePublishJobs()).resolves.toBe(1);

    expect(orphanedJob.remove).toHaveBeenCalledTimes(1);
    expect(publishQueue.add).toHaveBeenCalledWith(
      'publish-vk-post',
      expect.objectContaining({
        postId: 'post-1',
        idempotencyKey: 'publish-key-1',
      }),
      expect.objectContaining({
        jobId: 'vk-parsing-publish__post-1__publish-key-1',
      }),
    );
  });

  it('recovers stale manual retry rows without the autopublish eligibility gate', async () => {
    const { service, prisma, publishQueue } = createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      publishQueuedAt: new Date('2026-05-25T10:01:00.000Z'),
      publishLockedAt: new Date('2026-05-25T10:01:05.000Z'),
      publishIdempotencyKey: 'publish-key-1',
      publishReason: 'manual-retry',
    });
    prisma.vkParsingPost.findMany.mockResolvedValueOnce([post]);
    prisma.vkParsingPost.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: false,
      autoPublishEnabledAt: null,
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });

    await expect(service.recoverStalePublishJobs()).resolves.toBe(1);

    expect(publishQueue.add).toHaveBeenCalledWith(
      'publish-vk-post',
      expect.objectContaining({
        reason: 'manual-retry',
        idempotencyKey: 'publish-key-1',
      }),
      expect.any(Object),
    );
    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ publishIdempotencyKey: null }),
      }),
    );
  });

  it.each(['SKIPPED', 'CHANGED_AFTER_PUBLISH'])(
    'recovers an armed manual send from %s with its original ledger key',
    async (status) => {
      const { service, prisma, publishQueue } = createFixture();
      const post = createPostRow({
        source: createSource({ publishMode: 'REVIEW' }),
        status,
        publishQueuedAt: new Date('2026-05-25T10:01:00.000Z'),
        publishScheduledAt: new Date('2026-05-25T10:01:00.000Z'),
        publishLockedAt: new Date('2026-05-25T10:01:05.000Z'),
        publishIdempotencyKey: `manual-${status.toLowerCase()}`,
        publishReason: 'manual-retry',
      });
      prisma.vkParsingPost.findMany.mockResolvedValueOnce([post]);

      await expect(service.recoverStalePublishJobs()).resolves.toBe(1);

      expect(publishQueue.add).toHaveBeenCalledWith(
        'publish-vk-post',
        expect.objectContaining({
          postId: 'post-1',
          reason: 'manual-retry',
          idempotencyKey: `manual-${status.toLowerCase()}`,
        }),
        expect.objectContaining({
          jobId: `vk-parsing-publish__post-1__manual-${status.toLowerCase()}`,
        }),
      );
      expect(prisma.vkParsingPost.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              expect.objectContaining({
                OR: expect.arrayContaining([
                  {
                    publishReason: { in: ['manual-retry', 'manual-schedule'] },
                    status: { notIn: ['PUBLISHED', 'UNAVAILABLE'] },
                  },
                ]),
              }),
            ]),
          }),
        }),
      );
    },
  );

  it('limits bulk autopublish cleanup to autopublish-owned rows', async () => {
    const { publishService, prisma } = createFixture();
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });

    await publishService.clearQueuedAutoPublishForChat('channel-1');
    await publishService.clearQueuedAutoPublishForSources('channel-1', ['source-1', 'source-1']);

    expect(prisma.vkParsingPost.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'channel-1',
          OR: expect.arrayContaining([
            expect.objectContaining({ publishReason: 'autopublish' }),
            expect.objectContaining({
              publishReason: null,
              publishScheduleFingerprint: { not: null },
              publishQueuedAt: null,
              publishLockedAt: null,
              publishIdempotencyKey: null,
              publishScheduledAt: null,
              publishCancelledAt: null,
              publishCancelledByUserId: null,
              publishActorUserId: null,
              dispatchBlockerCode: null,
              dispatchBlockedAt: null,
            }),
          ]),
        }),
      }),
    );
    expect(prisma.vkParsingPost.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'channel-1',
          sourceId: { in: ['source-1'] },
          OR: expect.arrayContaining([
            expect.objectContaining({ publishReason: 'autopublish' }),
            expect.objectContaining({
              publishReason: null,
              publishScheduleFingerprint: { not: null },
              publishQueuedAt: null,
              publishLockedAt: null,
              publishIdempotencyKey: null,
              publishScheduledAt: null,
              publishCancelledAt: null,
              publishCancelledByUserId: null,
              publishActorUserId: null,
              dispatchBlockerCode: null,
              dispatchBlockedAt: null,
            }),
          ]),
        }),
      }),
    );
  });

  it('clears stale autopublish rows that no longer pass the enable baseline', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-25T12:00:00.000Z'));
    const { service, prisma, publishQueue } = createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      publishQueuedAt: new Date('2026-05-25T10:01:00.000Z'),
      publishLockedAt: new Date('2026-05-25T10:01:05.000Z'),
      publishIdempotencyKey: 'publish-key-1',
      publishReason: 'autopublish',
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      vkPublishedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    prisma.vkParsingPost.findMany.mockResolvedValueOnce([post]);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T10:05:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:05:00.000Z'),
    });

    await expect(service.recoverStalePublishJobs()).resolves.toBe(0);

    expect(publishQueue.add).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'post-1',
          publishIdempotencyKey: 'publish-key-1',
          publishReason: 'autopublish',
          publishLockedAt: new Date('2026-05-25T10:01:05.000Z'),
          publishAttemptCount: 0,
          publishScheduledAt: null,
          lastError: null,
          status: 'NEW',
        },
        data: {
          publishQueuedAt: null,
          publishLockedAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
          publishScheduledAt: null,
          publishScheduleFingerprint: null,
        },
      }),
    );
  });

  it('renders imported VK strong markup in queued background publications', async () => {
    const maxRoutedPublicationService = {
      publish: jest.fn().mockImplementation(async (request: any) => {
        const prepared = await request.prepareAttempt({ botId: 'publisher-bot', job: {} });
        request.onDispatchAttempt({ botId: 'publisher-bot', job: { options: prepared.options } });
        return {
          messageId: 'mid-1',
          url: 'https://max.ru/channels/channel-1/message/mid-1',
          botId: 'publisher-bot',
          candidateBotIds: ['publisher-bot'],
          routingVersion: 5,
        };
      }),
    };
    const { service, prisma, maxClient, adminService } = createFixture(
      {},
      { maxRoutedPublicationService },
    );
    const source = createSource();
    const post = createPostRow({
      source,
      text: '**Продам авто** https://example.com\nvk.com/club',
      linkUrls: ['https://example.com/car'],
      publishIdempotencyKey: 'publish-key-1',
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: true,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    prisma.vkParsingPost.update.mockResolvedValue({
      ...post,
      status: 'PUBLISHED',
      publishedMessageId: 'mid-1',
      publishedUrl: 'https://max.ru/channels/channel-1/message/mid-1',
      publishedAtMax: new Date('2026-05-25T10:05:00.000Z'),
      autoPublishedAt: new Date('2026-05-25T10:05:00.000Z'),
    });
    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'autopublish',
      idempotencyKey: 'publish-key-1',
    });

    expect(maxRoutedPublicationService.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'channel-1',
        logicalIdempotencyKey: 'vk-parsing:publish:post-1:publish-key-1',
        text: '<strong>Продам авто</strong>',
        options: expect.objectContaining({ textFormat: 'html' }),
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
      }),
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'post-1' }),
        data: expect.objectContaining({
          status: 'PUBLISHED',
          autoPublishedAt: expect.any(Date),
          autoPublishError: null,
          publishQueuedAt: null,
          publishReason: null,
        }),
      }),
    );
    expect(adminService.recordChannelPublicationEngagement).not.toHaveBeenCalled();
  });

  it('fails closed in production when routed VK publication wiring is missing', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const { publishService, maxClient } = createFixture();
    (publishService as any).maxRoutedPublicationService = undefined;

    try {
      await expect(
        (publishService as any).sendMessageWithAttachmentRetry({
          postId: 'post-1',
          chatId: 'channel-1',
          logicalIdempotencyKey: 'vk-parsing:publish:post-1:publish-key-1',
          text: 'VK publication',
          baseOptions: {},
          trafficClass: 'background',
          videoAttachment: false,
          publisherExactBotId: 'publisher-bot',
          prepareAttempt: jest.fn(),
        }),
      ).rejects.toThrow('Routed MAX publication service is required for Publik VK publications');
      expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it('retries video attachment readiness across the extended processing window', async () => {
    const notReady = createMaxApiError(400, 'Video is still processing', 'attachment.not.ready');
    const publish = jest
      .fn()
      .mockRejectedValueOnce(notReady)
      .mockRejectedValueOnce(notReady)
      .mockRejectedValueOnce(notReady)
      .mockRejectedValueOnce(notReady)
      .mockRejectedValueOnce(notReady)
      .mockResolvedValue({
        messageId: 'mid-video-ready',
        botId: 'publisher-bot',
        candidateBotIds: ['publisher-bot'],
        routingVersion: 1,
      });
    const { publishService } = createFixture({}, { maxRoutedPublicationService: { publish } });
    const sleep = jest.spyOn(publishService as any, 'sleep').mockResolvedValue(undefined);

    await expect(
      (publishService as any).sendMessageWithAttachmentRetry({
        postId: 'post-1',
        chatId: 'channel-1',
        logicalIdempotencyKey: 'vk-parsing:publish:post-1:video-ready',
        text: 'VK video publication',
        baseOptions: {},
        trafficClass: 'background',
        videoAttachment: true,
        publisherExactBotId: 'publisher-bot',
        prepareAttempt: jest.fn(),
      }),
    ).resolves.toEqual(expect.objectContaining({ messageId: 'mid-video-ready' }));

    expect(publish).toHaveBeenCalledTimes(6);
    expect(sleep.mock.calls.map(([delayMs]) => delayMs)).toEqual([
      1_500, 3_000, 6_000, 12_000, 24_000,
    ]);
  });

  it('does not retry an ambiguous VK video send transport failure', async () => {
    const timeout = Object.assign(new Error('timeout of 30000ms exceeded'), {
      code: 'ECONNABORTED',
    });
    const publish = jest.fn().mockRejectedValue(timeout);
    const { publishService } = createFixture({}, { maxRoutedPublicationService: { publish } });
    const sleep = jest.spyOn(publishService as any, 'sleep').mockResolvedValue(undefined);

    await expect(
      (publishService as any).sendMessageWithAttachmentRetry({
        postId: 'post-1',
        chatId: 'channel-1',
        logicalIdempotencyKey: 'vk-parsing:publish:post-1:ambiguous-video',
        text: 'VK video publication',
        baseOptions: {},
        trafficClass: 'background',
        videoAttachment: true,
        publisherExactBotId: 'publisher-bot',
        prepareAttempt: jest.fn(),
      }),
    ).rejects.toBe(timeout);

    expect(publish).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('reuses cached MAX upload payloads only for the bot that created them', () => {
    const { publishService, mediaCache } = createFixture();
    const row = {
      maxUploadPayload: {
        token: 'cached-video-token',
        [VK_MEDIA_CACHE_UPLOAD_BOT_ID_FIELD]: 'bot-1',
      },
      maxUploadToken: 'cached-video-token',
    };

    expect((publishService as any).readUploadPayload(row, 'bot-1')).toEqual({
      token: 'cached-video-token',
    });
    expect((publishService as any).readUploadPayload(row, 'bot-2')).toBeNull();
    expect((mediaCache as any).hasReusableUpload(row, 'bot-1')).toBe(true);
    expect((mediaCache as any).hasReusableUpload(row, 'bot-2')).toBe(false);
    expect(
      (publishService as any).readUploadPayload(
        { maxUploadPayload: { token: 'legacy-untagged-token' } },
        'bot-1',
      ),
    ).toBeNull();
  });

  it('handles Publisher access loss only through Publisher dispatch health', async () => {
    const maxSendAttemptStartedAt = new Date('2026-08-20T12:00:00.123Z');
    jest.useFakeTimers().setSystemTime(maxSendAttemptStartedAt);
    const { service, prisma, maxClient, publishQueue, publisherDispatchHealth } = createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      ...createFreshQueuedPublishTimes(),
      publishIdempotencyKey: 'publish-key-1',
      publishReason: 'autopublish',
    });
    const error = createMaxApiError(403, 'Request failed with status code 403', 'chat.denied');
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    maxClient.sendMessageImmediateWithResolvedLink.mockRejectedValue(error);

    await expect(
      service.processPublishPostJob({
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'autopublish',
        idempotencyKey: 'publish-key-1',
      }),
    ).rejects.toBe(error);

    expect(publisherDispatchHealth.recordSendFailure).toHaveBeenCalledWith(
      'channel-1',
      error,
      maxSendAttemptStartedAt,
    );
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'post-1' }),
        data: expect.objectContaining({
          status: 'FAILED',
          publishQueuedAt: null,
          publishScheduledAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
          publishLockedAt: null,
        }),
      }),
    );
    expect(publishQueue.add).not.toHaveBeenCalled();
  });

  it('quarantines autopublish after an ambiguous MAX send timeout', async () => {
    const { service, publishService, prisma, maxClient, publishQueue } = createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      ...createFreshQueuedPublishTimes(),
      publishIdempotencyKey: 'publish-key-1',
      publishReason: 'autopublish',
    });
    const timeoutError = new Error('request timed out before response body arrived');
    let persistedPost = { ...post };
    prisma.vkParsingPost.updateMany.mockImplementation(async ({ where, data }) => {
      if (
        where.publishIdempotencyKey !== undefined &&
        where.publishIdempotencyKey !== persistedPost.publishIdempotencyKey
      ) {
        return { count: 0 };
      }
      persistedPost = { ...persistedPost, ...data };
      return { count: 1 };
    });
    prisma.vkParsingPost.findFirst.mockImplementation(async ({ where }) => {
      if (
        where.publishIdempotencyKey !== undefined &&
        where.publishIdempotencyKey !== persistedPost.publishIdempotencyKey
      ) {
        return null;
      }
      return { ...persistedPost };
    });
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    maxClient.sendMessageImmediateWithResolvedLink.mockRejectedValue(timeoutError);

    await expect(
      service.processPublishPostJob({
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'autopublish',
        idempotencyKey: 'publish-key-1',
      }),
    ).rejects.toBe(timeoutError);

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'post-1' }),
        data: expect.objectContaining({
          status: 'FAILED',
          lastError: expect.stringContaining('[max.send_ambiguous]'),
          autoPublishError: expect.stringContaining('manual verification'),
          publishQueuedAt: null,
          publishScheduledAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
          publishLockedAt: null,
        }),
      }),
    );
    expect(persistedPost.lastError).toEqual(expect.stringContaining('[max.send_ambiguous]'));
    expect(persistedPost.publishIdempotencyKey).toBeNull();
    expect(persistedPost.publishReason).toBeNull();

    await expect(publishService.retryPost('channel-1', 'post-1')).rejects.toThrow(
      'MAX мог уже принять эту публикацию',
    );

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    expect(publishQueue.add).not.toHaveBeenCalled();
  });

  it('queues Safety Desk manual publish through Publisher without direct MAX dispatch', async () => {
    const { publishService, prisma, maxClient, publishQueue } = createFixture();
    const source = createSource({ publishMode: 'REVIEW' });
    const post = createPostRow({
      source,
      text: 'Материал Safety Desk',
      photoUrls: [],
      linkUrls: [],
    });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      publishService.publishPost('channel-1', 'post-1', 'safety-desk-owner', {
        text: 'Материал Safety Desk',
        photoUrls: [],
        linkUrls: [],
      }),
    ).resolves.toMatchObject({ queued: 1 });

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(publishQueue.add).toHaveBeenCalledWith(
      'publish-vk-post',
      expect.objectContaining({
        kind: 'publish',
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: 'publisher-bot',
        postId: 'post-1',
      }),
      expect.any(Object),
    );
  });

  it('defers VK autopublish jobs while the runtime governor reports pressure', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-25T10:00:00.000Z'));
    try {
      const { service, prisma, maxClient, publishQueue, publishService } = createFixture();
      const source = createSource();
      const post = createPostRow({
        source,
        publishQueuedAt: new Date('2026-05-25T09:59:00.000Z'),
        publishScheduledAt: new Date('2026-05-25T10:00:00.000Z'),
        publishIdempotencyKey: 'publish-key-1',
        publishReason: 'autopublish',
      });
      const governor = {
        decide: jest.fn().mockResolvedValue({
          action: 'pause',
          retryAfterMs: 60_000,
          reason: 'runtime pressure',
        }),
      };
      (
        publishService as unknown as {
          backgroundRuntimeGovernorService: typeof governor;
        }
      ).backgroundRuntimeGovernorService = governor;
      prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
      prisma.vkParsingPost.findFirst.mockResolvedValue(post);
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
        autoPublishKillSwitchEnabled: false,
      });

      await service.processPublishPostJob({
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'autopublish',
        idempotencyKey: 'publish-key-1',
      });

      expect(governor.decide).toHaveBeenCalledWith({
        component: 'vk_parsing_autopublish',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
      });
      expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
      expect(prisma.vkParsingPost.updateMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: {
            id: 'post-1',
            publishIdempotencyKey: 'publish-key-1',
            publishReason: 'autopublish',
            publishLockedAt: null,
            publishAttemptCount: 0,
            lastError: null,
          },
          data: expect.objectContaining({
            publishScheduledAt: new Date('2026-05-25T10:01:00.000Z'),
            publishLockedAt: null,
            publishReason: 'autopublish',
          }),
        }),
      );
      expect(publishQueue.add).toHaveBeenCalledWith(
        'publish-vk-post',
        expect.objectContaining({
          postId: 'post-1',
          chatId: 'channel-1',
          reason: 'autopublish',
          retryPolicyName: 'vk-parsing-publish',
        }),
        expect.objectContaining({
          delay: 60_000,
          attempts: 5,
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('defers a due VK autopublish intent while entity Auto is paused', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-25T10:00:00.000Z'));
    try {
      const { service, prisma, maxClient, publishQueue, publishService } = createFixture();
      const source = createSource();
      const post = createPostRow({
        source,
        publishQueuedAt: new Date('2026-05-25T09:59:00.000Z'),
        publishScheduledAt: new Date('2026-05-25T10:00:00.000Z'),
        publishIdempotencyKey: 'publish-key-1',
        publishReason: 'autopublish',
      });
      const governor = { decide: jest.fn() };
      (
        publishService as unknown as {
          backgroundRuntimeGovernorService: typeof governor;
        }
      ).backgroundRuntimeGovernorService = governor;
      prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
      prisma.vkParsingPost.findFirst.mockResolvedValue(post);
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
        autoPublishKillSwitchEnabled: true,
      });

      await service.processPublishPostJob({
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'autopublish',
        idempotencyKey: 'publish-key-1',
      });

      expect(governor.decide).not.toHaveBeenCalled();
      expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
      expect(prisma.vkParsingPost.updateMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: {
            id: 'post-1',
            publishIdempotencyKey: 'publish-key-1',
            publishReason: 'autopublish',
            publishLockedAt: null,
            publishAttemptCount: 0,
            lastError: null,
          },
          data: expect.objectContaining({
            publishScheduledAt: new Date('2026-05-25T10:01:00.000Z'),
            publishLockedAt: null,
            publishReason: 'autopublish',
          }),
        }),
      );
      expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: { publishAttemptCount: { increment: 1 } },
        }),
      );
      expect(publishQueue.add).toHaveBeenCalledWith(
        'publish-vk-post',
        expect.objectContaining({ postId: 'post-1', reason: 'autopublish' }),
        expect.objectContaining({ delay: 60_000, attempts: 5 }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('returns an old paused VK autopublish intent to the inbox after 24 hours', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-26T10:01:00.000Z'));
    try {
      const { service, prisma, maxClient, publishQueue } = createFixture();
      const source = createSource();
      const post = createPostRow({
        source,
        publishQueuedAt: new Date('2026-05-25T10:00:00.000Z'),
        publishScheduledAt: new Date('2026-05-26T10:01:00.000Z'),
        publishIdempotencyKey: 'publish-key-old-pause',
        publishReason: 'autopublish',
      });
      prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
      prisma.vkParsingPost.findFirst.mockResolvedValue(post);
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
        autoPublishKillSwitchEnabled: true,
      });

      await service.processPublishPostJob({
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'autopublish',
        idempotencyKey: 'publish-key-old-pause',
      });

      expect(prisma.vkParsingPost.updateMany).toHaveBeenNthCalledWith(2, {
        where: {
          id: 'post-1',
          publishReason: 'autopublish',
          publishIdempotencyKey: 'publish-key-old-pause',
          publishLockedAt: post.publishLockedAt,
          publishAttemptCount: post.publishAttemptCount,
          publishScheduledAt: post.publishScheduledAt,
          lastError: post.lastError,
          status: post.status,
        },
        data: {
          publishQueuedAt: null,
          publishScheduledAt: null,
          publishLockedAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
          publishScheduleFingerprint: null,
        },
      });
      expect(publishQueue.add).not.toHaveBeenCalled();
      expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('defers a paused PUBLIK_V1 autopublish intent on the Publisher queue', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-25T10:00:00.000Z'));
    try {
      const { service, prisma, maxClient, publishQueue, publishService } = createFixture();
      const publisherQueue = {
        add: jest.fn().mockResolvedValue(undefined),
        getJob: jest.fn().mockResolvedValue(null),
      };
      const runtimeBoundary = { assertDispatchEnabled: jest.fn() };
      const dispatchHealth = { assertDispatchAllowed: jest.fn().mockResolvedValue(undefined) };
      Object.assign(publishService as object, {
        publisherQueue,
        publisherRuntimeBoundaryService: runtimeBoundary,
        publisherDispatchHealthService: dispatchHealth,
      });
      const source = createPublisherSource({
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      });
      const post = createPostRow({
        source,
        ownerProfile: VkParsingOwnerProfile.PUBLISHER,
        ownerBotId: 'publisher-bot',
        dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        requiredBotId: 'publisher-bot',
        dialogBotId: 'publisher-bot',
        publicationPolicyRevision: 3,
        publishQueuedAt: new Date('2026-05-25T09:59:00.000Z'),
        publishScheduledAt: new Date('2026-05-25T10:00:00.000Z'),
        publishIdempotencyKey: 'publisher-pause-key',
        publishReason: 'autopublish',
      });
      prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
      prisma.vkParsingPost.findFirst.mockResolvedValue(post);
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
        autoPublishKillSwitchEnabled: true,
      });

      await service.processPublishPostJob({
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'autopublish',
        idempotencyKey: 'publisher-pause-key',
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: 'publisher-bot',
      });

      expect(runtimeBoundary.assertDispatchEnabled).toHaveBeenCalled();
      expect(dispatchHealth.assertDispatchAllowed).toHaveBeenCalled();
      expect(prisma.vkParsingPost.updateMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: expect.objectContaining({
            dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
            ownerProfile: VkParsingOwnerProfile.PUBLISHER,
            ownerBotId: 'publisher-bot',
            requiredBotId: 'publisher-bot',
          }),
        }),
      );
      const deferData = prisma.vkParsingPost.updateMany.mock.calls[1]?.[0]?.data;
      expect(deferData).toEqual(
        expect.objectContaining({
          publishScheduledAt: new Date('2026-05-25T10:01:00.000Z'),
          publishLockedAt: null,
          publishReason: 'autopublish',
        }),
      );
      expect(deferData).not.toHaveProperty('dispatchProfile');
      expect(deferData).not.toHaveProperty('requiredBotId');
      expect(deferData).not.toHaveProperty('dialogBotId');
      expect(publisherQueue.add).toHaveBeenCalledWith(
        'publish-vk-post',
        expect.objectContaining({
          kind: 'publish',
          dispatchProfile: 'PUBLIK_V1',
          requiredBotId: 'publisher-bot',
          postId: 'post-1',
          chatId: 'channel-1',
          reason: 'autopublish',
        }),
        expect.objectContaining({ delay: 60_000, attempts: 5 }),
      );
      expect(publishQueue.add).not.toHaveBeenCalled();
      expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { publishAttemptCount: { increment: 1 } } }),
      );
      expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
      expect(maxClient.uploadImage).not.toHaveBeenCalled();
      expect(maxClient.uploadVideo).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('continues VK autopublish jobs while the runtime governor only asks to slow down', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-25T10:00:00.000Z'));
    try {
      const { service, prisma, maxClient, publishQueue, publishService } = createFixture();
      const source = createSource();
      const post = createPostRow({
        source,
        publishQueuedAt: new Date('2026-05-25T09:59:00.000Z'),
        publishScheduledAt: new Date('2026-05-25T10:00:00.000Z'),
        publishIdempotencyKey: 'publish-key-1',
        publishReason: 'autopublish',
        publishScheduleFingerprint: buildVkAutoPublishScheduleFingerprint(
          {
            schedulerTimezone: 'Europe/Moscow',
            quietHoursStart: null,
            quietHoursEnd: null,
            workHoursStart: '09:00',
            workHoursEnd: '22:00',
            distributeEvenlyEnabled: true,
            roundRobinEnabled: true,
          },
          source,
        ),
      });
      const governor = {
        decide: jest.fn().mockResolvedValue({
          action: 'slow',
          retryAfterMs: 60_000,
          reason: 'background share 92%',
        }),
      };
      (
        publishService as unknown as {
          backgroundRuntimeGovernorService: typeof governor;
        }
      ).backgroundRuntimeGovernorService = governor;
      prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
      prisma.vkParsingPost.findFirst.mockResolvedValue(post);
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        id: 'settings-1',
        chatId: 'channel-1',
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
        autoPublishKillSwitchEnabled: false,
        stripLinksEnabled: false,
        skipAdsEnabled: false,
        schedulerTimezone: 'Europe/Moscow',
        quietHoursStart: null,
        quietHoursEnd: null,
        workHoursStart: '09:00',
        workHoursEnd: '22:00',
        distributeEvenlyEnabled: true,
        roundRobinEnabled: true,
        circuitBreakerEnabled: true,
        circuitBreakerWindowMinutes: 10,
        circuitBreakerPostLimit: 10,
        createdAt: new Date('2026-05-25T10:00:00.000Z'),
        updatedAt: new Date('2026-05-25T10:00:00.000Z'),
      });
      prisma.vkParsingPost.update.mockResolvedValue({
        ...post,
        status: 'PUBLISHED',
        publishedMessageId: 'mid-1',
        publishedUrl: 'https://max.ru/channels/channel-1/message/mid-1',
        publishedAtMax: new Date('2026-05-25T10:00:00.000Z'),
        autoPublishedAt: new Date('2026-05-25T10:00:00.000Z'),
      });
      maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
        messageId: 'mid-1',
        url: 'https://max.ru/channels/channel-1/message/mid-1',
      });

      await service.processPublishPostJob({
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'autopublish',
        idempotencyKey: 'publish-key-1',
      });

      expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
        'channel-1',
        'Продам авто',
        expect.any(Object),
        {
          botId: 'publisher-bot',
          trafficClass: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
        },
      );
      expect(publishQueue.add).not.toHaveBeenCalled();
      expect(prisma.vkParsingPost.updateMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          data: expect.not.objectContaining({
            publishAttemptCount: expect.anything(),
          }),
        }),
      );
      expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            id: 'post-1',
            publishIdempotencyKey: 'publish-key-1',
            publishReason: 'autopublish',
            publishLockedAt: new Date('2026-05-25T10:00:00.000Z'),
          },
          data: { publishAttemptCount: { increment: 1 } },
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('serializes publication policy checks and sends for the same VK source', async () => {
    const { publishService } = createFixture();
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const first = (publishService as any).runWithSourcePublishFence('source-1', async () => {
      events.push('first:start');
      await firstGate;
      events.push('first:end');
    });
    await Promise.resolve();
    const second = (publishService as any).runWithSourcePublishFence('source-1', async () => {
      events.push('second:start');
      events.push('second:end');
    });
    await Promise.resolve();

    expect(events).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('defers a concurrent same-source publish after the first source timestamp is persisted', async () => {
    const { service, prisma, maxClient, publishQueue } = createFixture();
    const now = new Date();
    const baseline = new Date(now.getTime() - 60 * 60_000);
    const source = createSource({
      autoPublishEnabledAt: baseline,
      minPublishIntervalMinutes: 30,
      lastAutoPublishedAt: null,
    });
    let sourceLastAutoPublishedAt: Date | null = null;
    const settings = {
      autoPublishEnabled: true,
      autoPublishEnabledAt: baseline,
      autoPublishKillSwitchEnabled: false,
      schedulerTimezone: 'UTC',
      quietHoursStart: null,
      quietHoursEnd: null,
      workHoursStart: '00:00',
      workHoursEnd: '00:00',
      distributeEvenlyEnabled: true,
      roundRobinEnabled: false,
      circuitBreakerEnabled: false,
    };
    const fingerprint = buildVkAutoPublishScheduleFingerprint(settings, source);
    const posts = new Map(
      ['post-1', 'post-2'].map((id, index) => [
        id,
        createPostRow({
          id,
          source,
          vkPostId: 101 + index,
          createdAt: new Date(now.getTime() - (5 - index) * 60_000),
          vkPublishedAt: new Date(now.getTime() - (5 - index) * 60_000),
          publishQueuedAt: new Date(now.getTime() - 60_000),
          publishScheduledAt: now,
          publishIdempotencyKey: `publish-key-${index + 1}`,
          publishReason: 'autopublish',
          publishScheduleFingerprint: fingerprint,
        }),
      ]),
    );
    let resolveFirstSendStarted!: () => void;
    const firstSendStarted = new Promise<void>((resolve) => {
      resolveFirstSendStarted = resolve;
    });
    let releaseFirstSend!: () => void;
    const firstSendGate = new Promise<void>((resolve) => {
      releaseFirstSend = resolve;
    });
    let resolveSecondPreRead!: () => void;
    const secondPreRead = new Promise<void>((resolve) => {
      resolveSecondPreRead = resolve;
    });
    prisma.vkParsingPost.findFirst.mockImplementation(async (query: any) => {
      if (query.where.id === 'post-2' && query.select?.sourceId) {
        resolveSecondPreRead();
      }
      const post = posts.get(query.where.id);
      return post
        ? {
            ...post,
            source: { ...source, lastAutoPublishedAt: sourceLastAutoPublishedAt },
          }
        : null;
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingSettings.findUnique.mockResolvedValue(settings);
    prisma.vkParsingSource.updateMany.mockImplementation(async (query: any) => {
      if (query.data.lastAutoPublishedAt instanceof Date) {
        sourceLastAutoPublishedAt = query.data.lastAutoPublishedAt;
      }
      return { count: 1 };
    });
    maxClient.sendMessageImmediateWithResolvedLink.mockImplementation(async () => {
      resolveFirstSendStarted();
      await firstSendGate;
      return {
        messageId: 'max-message-1',
        url: 'https://max.ru/channel-1/max-message-1',
      };
    });

    const first = service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'autopublish',
      idempotencyKey: 'publish-key-1',
    });
    await firstSendStarted;
    const second = service.processPublishPostJob({
      postId: 'post-2',
      chatId: 'channel-1',
      reason: 'autopublish',
      idempotencyKey: 'publish-key-2',
    });
    await secondPreRead;

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    expect(prisma.vkParsingPost.count).toHaveBeenCalledTimes(1);
    releaseFirstSend();
    await Promise.all([first, second]);

    expect(sourceLastAutoPublishedAt).toBeInstanceOf(Date);
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    expect(prisma.vkParsingPost.count).toHaveBeenCalledTimes(2);
    const sourceRollupIndex = prisma.vkParsingSource.updateMany.mock.calls.findIndex(
      ([query]) => query.data.lastAutoPublishedAt instanceof Date,
    );
    expect(sourceRollupIndex).toBeGreaterThanOrEqual(0);
    expect(
      prisma.vkParsingSource.updateMany.mock.invocationCallOrder[sourceRollupIndex],
    ).toBeLessThan(prisma.vkParsingPost.count.mock.invocationCallOrder[1]!);
    const expectedDeferredAt = new Date(sourceLastAutoPublishedAt!.getTime() + 30 * 60_000);
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'post-2', publishIdempotencyKey: 'publish-key-2' }),
        data: expect.objectContaining({
          publishScheduledAt: expectedDeferredAt,
          publishLockedAt: null,
          publishReason: 'autopublish',
        }),
      }),
    );
    expect(publishQueue.add).toHaveBeenCalledWith(
      'publish-vk-post',
      expect.objectContaining({ postId: 'post-2', reason: 'autopublish' }),
      expect.objectContaining({ delay: expect.any(Number) }),
    );
  });

  it('allows different VK sources to reach MAX concurrently', async () => {
    const { service, prisma, maxClient } = createFixture();
    const now = new Date();
    const baseline = new Date(now.getTime() - 60 * 60_000);
    const settings = {
      autoPublishEnabled: true,
      autoPublishEnabledAt: baseline,
      autoPublishKillSwitchEnabled: false,
      schedulerTimezone: 'UTC',
      quietHoursStart: null,
      quietHoursEnd: null,
      workHoursStart: '00:00',
      workHoursEnd: '00:00',
      distributeEvenlyEnabled: true,
      roundRobinEnabled: false,
      circuitBreakerEnabled: false,
    };
    const sources = new Map(
      ['source-1', 'source-2'].map((id) => [
        id,
        createSource({ id, autoPublishEnabledAt: baseline, lastAutoPublishedAt: null }),
      ]),
    );
    const posts = new Map(
      [...sources.values()].map((source, index) => {
        const id = `parallel-post-${index + 1}`;
        return [
          id,
          createPostRow({
            id,
            source,
            sourceId: source.id,
            vkPostId: 201 + index,
            createdAt: new Date(now.getTime() - 5 * 60_000),
            vkPublishedAt: new Date(now.getTime() - 5 * 60_000),
            publishQueuedAt: new Date(now.getTime() - 60_000),
            publishScheduledAt: now,
            publishIdempotencyKey: `parallel-key-${index + 1}`,
            publishReason: 'autopublish',
            publishScheduleFingerprint: buildVkAutoPublishScheduleFingerprint(settings, source),
          }),
        ];
      }),
    );
    prisma.vkParsingPost.findFirst.mockImplementation(async (query: any) => {
      const post = posts.get(query.where.id);
      return post ? { ...post, source: sources.get(post.sourceId) } : null;
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingSettings.findUnique.mockResolvedValue(settings);
    let startedSends = 0;
    let resolveBothSendsStarted!: () => void;
    const bothSendsStarted = new Promise<void>((resolve) => {
      resolveBothSendsStarted = resolve;
    });
    let releaseSends!: () => void;
    const sendGate = new Promise<void>((resolve) => {
      releaseSends = resolve;
    });
    maxClient.sendMessageImmediateWithResolvedLink.mockImplementation(async () => {
      startedSends += 1;
      const ordinal = startedSends;
      if (startedSends === 2) {
        resolveBothSendsStarted();
      }
      await sendGate;
      return {
        messageId: `parallel-message-${ordinal}`,
        url: `https://max.ru/channel-1/parallel-message-${ordinal}`,
      };
    });
    const jobs = [...posts.values()].map((post, index) =>
      service.processPublishPostJob({
        postId: post.id,
        chatId: post.chatId,
        reason: 'autopublish',
        idempotencyKey: `parallel-key-${index + 1}`,
      }),
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        bothSendsStarted,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error('Different VK sources did not reach MAX concurrently.')),
            1_000,
          );
        }),
      ]);
      expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(2);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      releaseSends();
    }
    await Promise.all(jobs);
  });

  it('drops queued autopublish jobs when a source is switched to review mode', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource({ publishMode: 'REVIEW' });
    const post = createPostRow({
      source,
      ...createFreshQueuedPublishTimes(),
      publishIdempotencyKey: 'publish-key-1',
      publishReason: 'autopublish',
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      autoPublishKillSwitchEnabled: false,
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      schedulerTimezone: 'Europe/Moscow',
      quietHoursStart: null,
      quietHoursEnd: null,
      workHoursStart: '09:00',
      workHoursEnd: '22:00',
      distributeEvenlyEnabled: true,
      roundRobinEnabled: true,
      circuitBreakerEnabled: true,
      circuitBreakerWindowMinutes: 10,
      circuitBreakerPostLimit: 10,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });

    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'autopublish',
      idempotencyKey: 'publish-key-1',
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          id: 'post-1',
          publishIdempotencyKey: 'publish-key-1',
          publishReason: 'autopublish',
          publishLockedAt: post.publishLockedAt,
          publishAttemptCount: post.publishAttemptCount,
          publishScheduledAt: post.publishScheduledAt,
          lastError: post.lastError,
          status: post.status,
        },
        data: expect.objectContaining({
          publishQueuedAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
        }),
      }),
    );
  });

  it('does not send a queued VK publish job after its idempotency key was cleared', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      publishQueuedAt: new Date('2026-05-25T10:00:00.000Z'),
      publishIdempotencyKey: 'publish-key-1',
      publishReason: 'autopublish',
    });
    prisma.vkParsingPost.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      autoPublishKillSwitchEnabled: false,
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      schedulerTimezone: 'Europe/Moscow',
      quietHoursStart: null,
      quietHoursEnd: null,
      workHoursStart: '09:00',
      workHoursEnd: '22:00',
      distributeEvenlyEnabled: true,
      roundRobinEnabled: true,
      circuitBreakerEnabled: true,
      circuitBreakerWindowMinutes: 10,
      circuitBreakerPostLimit: 10,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });

    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'autopublish',
      idempotencyKey: 'publish-key-1',
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.update).not.toHaveBeenCalled();
  });

  it('does not let a stale autopublish job lock a manual schedule with the same key', async () => {
    const { service, prisma, maxClient } = createFixture();
    const post = createPostRow({
      publishQueuedAt: new Date('2026-05-25T10:00:00.000Z'),
      publishScheduledAt: new Date('2026-05-25T11:00:00.000Z'),
      publishIdempotencyKey: 'shared-publish-key',
      publishReason: 'manual-schedule',
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 0 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);

    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'autopublish',
      idempotencyKey: 'shared-publish-key',
    });

    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'post-1',
          chatId: 'channel-1',
          publishIdempotencyKey: 'shared-publish-key',
          publishReason: 'autopublish',
        }),
      }),
    );
    expect(prisma.vkParsingPost.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.vkParsingPost.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'post-1',
        chatId: 'channel-1',
        ownerProfile: VkParsingOwnerProfile.PUBLISHER,
        ownerBotId: 'publisher-bot',
        requiredBotId: 'publisher-bot',
      },
      select: { sourceId: true },
    });
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('publishes manual retry jobs immediately without scheduler deferral', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-25T10:00:00.000Z'));
    try {
      const { service, prisma, maxClient, publishQueue } = createFixture();
      const source = createSource();
      const post = createPostRow({
        source,
        publishQueuedAt: new Date('2026-05-25T09:59:00.000Z'),
        publishScheduledAt: new Date('2026-05-25T10:00:00.000Z'),
        publishIdempotencyKey: 'publish-key-1',
        publishReason: 'manual-retry',
      });
      prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
      prisma.vkParsingPost.findFirst.mockResolvedValue(post);
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        id: 'settings-1',
        chatId: 'channel-1',
        autoPublishEnabled: false,
        autoPublishEnabledAt: null,
        autoPublishKillSwitchEnabled: false,
        stripLinksEnabled: false,
        skipAdsEnabled: false,
        schedulerTimezone: 'Europe/Moscow',
        quietHoursStart: null,
        quietHoursEnd: null,
        workHoursStart: '23:00',
        workHoursEnd: '23:30',
        distributeEvenlyEnabled: true,
        roundRobinEnabled: true,
        circuitBreakerEnabled: true,
        circuitBreakerWindowMinutes: 10,
        circuitBreakerPostLimit: 10,
        createdAt: new Date('2026-05-25T10:00:00.000Z'),
        updatedAt: new Date('2026-05-25T10:00:00.000Z'),
      });
      prisma.vkParsingPost.update.mockResolvedValue({
        ...post,
        status: 'PUBLISHED',
        publishedMessageId: 'mid-1',
        publishedUrl: 'https://max.ru/channels/channel-1/message/mid-1',
        publishedAtMax: new Date('2026-05-25T10:00:00.000Z'),
      });
      maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
        messageId: 'mid-1',
        url: 'https://max.ru/channels/channel-1/message/mid-1',
      });

      await service.processPublishPostJob({
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'manual-retry',
        idempotencyKey: 'publish-key-1',
      });

      expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
        'channel-1',
        'Продам авто',
        expect.any(Object),
        {
          botId: 'publisher-bot',
          trafficClass: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
        },
      );
      expect(publishQueue.add).not.toHaveBeenCalled();
      expect(prisma.vkParsingSource.updateMany).not.toHaveBeenCalled();
      expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'PUBLISHED',
            autoPublishedAt: null,
          }),
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('publishes a due manual schedule without autopublish policy or counters', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-25T10:00:00.000Z'));
    try {
      const publish = jest.fn().mockImplementation(async (request: any) => {
        const prepared = await request.prepareAttempt({ botId: 'publisher-bot', job: {} });
        request.onDispatchAttempt({
          botId: 'publisher-bot',
          job: { options: prepared.options },
        });
        return {
          messageId: 'mid-manual-schedule',
          url: 'https://max.ru/channels/channel-1/message/mid-manual-schedule',
          botId: 'publisher-bot',
          candidateBotIds: ['publisher-bot'],
          routingVersion: 1,
        };
      });
      const { service, prisma, publishService } = createFixture(
        {},
        { maxRoutedPublicationService: { publish } },
      );
      const source = createSource({
        autoPublishEnabled: false,
        autoPublishEnabledAt: null,
        autoPublishPausedAt: new Date('2026-05-25T09:00:00.000Z'),
      });
      const post = createPostRow({
        source,
        publishQueuedAt: new Date('2026-05-25T09:59:00.000Z'),
        publishScheduledAt: new Date('2026-05-25T10:00:00.000Z'),
        publishIdempotencyKey: 'manual-schedule-key',
        publishReason: 'manual-schedule',
      });
      const governor = {
        decide: jest.fn().mockResolvedValue({
          action: 'pause',
          retryAfterMs: 60_000,
          reason: 'runtime pressure',
        }),
      };
      (
        publishService as unknown as {
          backgroundRuntimeGovernorService: typeof governor;
        }
      ).backgroundRuntimeGovernorService = governor;
      prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
      prisma.vkParsingPost.findFirst.mockResolvedValue(post);

      await service.processPublishPostJob({
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'manual-schedule',
        idempotencyKey: 'manual-schedule-key',
      });

      expect(governor.decide).not.toHaveBeenCalled();
      expect(prisma.vkParsingPost.count).not.toHaveBeenCalled();
      expect(prisma.vkParsingSource.updateMany).not.toHaveBeenCalled();
      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({
          logicalIdempotencyKey: 'vk-parsing:publish:post-1:manual-schedule-key',
          trafficClass: 'background',
        }),
      );
      expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'PUBLISHED',
            autoPublishedAt: null,
          }),
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('drops queued autopublish jobs for posts before the enable baseline', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-25T12:00:00.000Z'));
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      publishQueuedAt: new Date('2026-05-25T10:01:00.000Z'),
      publishIdempotencyKey: 'publish-key-1',
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T10:05:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:05:00.000Z'),
    });

    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'autopublish',
      idempotencyKey: 'publish-key-1',
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'post-1',
          publishIdempotencyKey: 'publish-key-1',
          publishReason: 'autopublish',
          publishLockedAt: post.publishLockedAt,
          publishAttemptCount: post.publishAttemptCount,
          publishScheduledAt: post.publishScheduledAt,
          lastError: post.lastError,
          status: post.status,
        },
        data: {
          publishQueuedAt: null,
          publishLockedAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
          publishScheduledAt: null,
          publishScheduleFingerprint: null,
        },
      }),
    );
  });

  it('does not autopublish the initial source-added backfill', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([createPostRow()]);
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [
            {
              owner_id: -36819802,
              id: 101,
              date: 1_779_708_000,
              text: 'Первичный импорт',
            },
          ],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    const imported = await service.processSyncSourceJob('source-1', 'source-added');

    expect(imported).toBe(1);
    expect(readExecuteRawValues(prisma)).not.toContain(VK_AUTOPUBLISH_PENDING_SCHEDULE_FINGERPRINT);
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.vkParsingSettings.findUnique).not.toHaveBeenCalled();
  });

  it('does not autopublish a first successful sync retried as scheduled', async () => {
    const { service, prisma, maxClient, publishQueue } = createFixture();
    const source = createSource({
      syncStatus: 'BACKOFF',
      lastSuccessAt: null,
      consecutiveFailures: 1,
      lastErrorCode: 'timeout',
    });
    const post = createPostRow({
      source,
      text: 'Первый успешный retry',
      createdAt: new Date('2026-05-25T10:10:00.000Z'),
      vkPublishedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([post]);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T09:00:00.000Z'),
      updatedAt: new Date('2026-05-25T09:00:00.000Z'),
    });
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [
            {
              owner_id: -36819802,
              id: 101,
              date: 1_779_708_000,
              text: 'Первый успешный retry',
            },
          ],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    const imported = await service.processSyncSourceJob('source-1', 'scheduled');

    expect(imported).toBe(1);
    expect(readExecuteRawValues(prisma)).not.toContain(VK_AUTOPUBLISH_PENDING_SCHEDULE_FINGERPRINT);
    expect(prisma.vkParsingSettings.findUnique).not.toHaveBeenCalled();
    expect(publishQueue.add).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('does not requeue failed VK autopublish posts on the next scheduled sync', async () => {
    const { service, prisma, maxClient, publishQueue } = createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      text: 'Повторная публикация',
      status: 'FAILED',
      lastError: 'Фото 1: VK вернул статус 404 для фото.',
      autoPublishError: 'Фото 1: VK вернул статус 404 для фото.',
    });
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany
      .mockResolvedValueOnce([
        {
          id: post.id,
          vkOwnerId: post.vkOwnerId,
          vkPostId: post.vkPostId,
          status: 'FAILED',
          contentHash: post.contentHash,
          publishedContentHash: null,
          lastError: 'Фото 1: VK вернул статус 404 для фото.',
          autoPublishError: 'Фото 1: VK вернул статус 404 для фото.',
        },
      ])
      .mockResolvedValueOnce([]);
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [
            {
              owner_id: -36819802,
              id: 101,
              date: 1_779_708_000,
              text: 'Повторная публикация',
            },
          ],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(readExecuteRawValues(prisma)).toContain('FAILED');
    expect(prisma.vkParsingSettings.findUnique).not.toHaveBeenCalled();
    expect(publishQueue.add).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('autopublishes text when VK photos are temporarily unavailable', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      text: 'Текст останется',
      photoUrls: ['https://sun1.example/missing.jpg'],
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    prisma.vkParsingMediaCache.findUnique.mockResolvedValue({
      id: 'media-1',
      url: 'https://sun1.example/missing.jpg',
      mediaIdentity: null,
      status: 'FAILED',
      mimeType: null,
      contentLength: null,
      maxUploadPayload: null,
      maxUploadToken: null,
      maxUploadedAt: null,
      uploadAttemptCount: 0,
      lastCheckedAt: new Date(),
      lastError: 'VK вернул статус 404 для фото.',
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    prisma.vkParsingPost.update.mockResolvedValue({
      ...post,
      status: 'PUBLISHED',
      publishedMessageId: 'mid-1',
      publishedUrl: 'https://max.ru/channels/channel-1/message/mid-1',
      publishedAtMax: new Date('2026-05-25T10:05:00.000Z'),
      autoPublishedAt: new Date('2026-05-25T10:05:00.000Z'),
    });
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'mid-1',
      url: 'https://max.ru/channels/channel-1/message/mid-1',
    });

    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'autopublish',
      idempotencyKey: 'publish-key-1',
    });

    expect(mediaFetch).not.toHaveBeenCalled();
    expect(maxClient.uploadImage).not.toHaveBeenCalled();
    const sendOptions = maxClient.sendMessageImmediateWithResolvedLink.mock.calls[0]?.[2];
    expect(sendOptions).not.toHaveProperty('imagePayload');
    expect(sendOptions).not.toHaveProperty('attachments');
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'channel-1',
      'Текст останется',
      expect.any(Object),
      {
        botId: 'publisher-bot',
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
      },
    );
  });

  it('falls back to another VK photo size when the selected CDN URL is stale', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const largeUrl = 'https://sun1.example/large.jpg';
    const smallUrl = 'https://sun1.example/small.jpg';
    const post = createPostRow({
      source,
      text: 'Текст с фото',
      photoUrls: [largeUrl],
      attachments: [
        {
          type: 'photo',
          photo: {
            id: 11,
            owner_id: -36819802,
            access_key: 'photo-key',
            sizes: [
              { width: 1280, height: 960, url: largeUrl },
              { width: 320, height: 240, url: smallUrl },
            ],
          },
        },
      ],
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    prisma.vkParsingMediaCache.findMany.mockResolvedValue([
      {
        id: 'media-old',
        url: largeUrl,
        mediaIdentity: 'vk-photo:-36819802:11:photo-key',
        status: 'FAILED',
        mimeType: null,
        contentLength: null,
        maxUploadPayload: null,
        maxUploadToken: null,
        maxUploadedAt: null,
        uploadAttemptCount: 0,
        lastCheckedAt: new Date(),
        lastError: 'VK вернул статус 404 для фото.',
        createdAt: new Date('2026-05-25T10:00:00.000Z'),
        updatedAt: new Date('2026-05-25T10:00:00.000Z'),
      },
    ]);
    prisma.vkParsingPost.update.mockResolvedValue({
      ...post,
      status: 'PUBLISHED',
      publishedMessageId: 'mid-1',
      publishedUrl: 'https://max.ru/channels/channel-1/message/mid-1',
      publishedAtMax: new Date('2026-05-25T10:05:00.000Z'),
      autoPublishedAt: new Date('2026-05-25T10:05:00.000Z'),
    });
    maxClient.uploadImage.mockResolvedValue({ token: 'image-token' });
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'mid-1',
      url: 'https://max.ru/channels/channel-1/message/mid-1',
    });
    mediaFetch
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { 'content-type': 'image/jpeg', 'content-length': '3' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'image/jpeg', 'content-length': '3' },
        }),
      );

    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'autopublish',
      idempotencyKey: 'publish-key-1',
    });

    expect(mediaFetch).toHaveBeenCalledWith(new URL(smallUrl), expect.any(Object));
    expect(maxClient.uploadImage).toHaveBeenCalledWith(
      Buffer.from([1, 2, 3]),
      'small.jpg',
      'image/jpeg',
      {
        botId: 'publisher-bot',
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
      },
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalled();
  });

  describe('public HTTPS media transport failures', () => {
    function createMediaPublishFixture(kind: 'photo' | 'video', withAlternate = true) {
      const fixture = createFixture();
      const extension = kind === 'photo' ? 'jpg' : 'mp4';
      const primaryUrl = `https://vk-media.example/primary.${extension}`;
      const alternateUrl = `https://vk-media.example/alternate.${extension}`;
      const mediaIdentity = `vk-${kind}:-36819802:11:media-key`;
      const attachment =
        kind === 'photo'
          ? {
              type: 'photo',
              photo: {
                id: 11,
                owner_id: -36819802,
                access_key: 'media-key',
                sizes: [
                  { width: 1280, height: 960, url: primaryUrl },
                  ...(withAlternate ? [{ width: 320, height: 240, url: alternateUrl }] : []),
                ],
              },
            }
          : {
              type: 'video',
              video: {
                id: 11,
                owner_id: -36819802,
                access_key: 'media-key',
                files: {
                  mp4_720: primaryUrl,
                  ...(withAlternate ? { mp4_360: alternateUrl } : {}),
                },
              },
            };
      const post = createPostRow({
        photoUrls: kind === 'photo' ? [primaryUrl] : [],
        videoUrls: kind === 'video' ? [primaryUrl] : [],
        attachmentTypes: [kind],
        attachments: [attachment],
        ...createFreshQueuedPublishTimes(),
        publishIdempotencyKey: 'media-transport-key',
        publishReason: 'manual-retry',
      });
      fixture.prisma.vkParsingPost.findFirst.mockResolvedValue(post);
      fixture.prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
      fixture.prisma.vkParsingPost.update.mockResolvedValue({
        ...post,
        status: 'PUBLISHED',
        publishedMessageId: 'mid-1',
        publishedUrl: 'https://max.ru/channels/channel-1/message/mid-1',
        publishedAtMax: new Date(),
      });
      fixture.maxClient.uploadImage.mockResolvedValue({ token: 'image-token' });
      fixture.maxClient.uploadVideo.mockResolvedValue({ token: 'video-token' });
      fixture.maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
        messageId: 'mid-1',
        url: 'https://max.ru/channels/channel-1/message/mid-1',
      });
      let cached: VkParsingMediaCacheRow | null = null;
      const persist = fixture.mediaCache.writeMediaCache.bind(fixture.mediaCache);
      const write = jest
        .spyOn(fixture.mediaCache, 'writeMediaCache')
        .mockImplementation(async (...args) => {
          cached = await persist(...args);
          return cached;
        });
      jest.spyOn(fixture.mediaCache, 'findMediaCache').mockImplementation(async (url, identity) => {
        if (cached?.url === url || (identity && cached?.mediaIdentity === identity)) {
          return cached;
        }
        return null;
      });
      const publish = () =>
        fixture.service.processPublishPostJob({
          postId: 'post-1',
          chatId: 'channel-1',
          reason: 'manual-retry',
          idempotencyKey: 'media-transport-key',
        });
      return { ...fixture, primaryUrl, alternateUrl, mediaIdentity, write, publish };
    }

    function mediaResponse(kind: 'photo' | 'video', body = false): Response {
      return new Response(body ? new Uint8Array([1, 2, 3]) : null, {
        headers: {
          'content-type': kind === 'photo' ? 'image/jpeg' : 'video/mp4',
          'content-length': '3',
        },
      });
    }

    it.each(['HEAD', 'GET'] as const)(
      'tries an independent photo candidate after a typed %s destination rejection',
      async (rejectedMethod) => {
        const { primaryUrl, alternateUrl, mediaIdentity, write, publish, maxClient } =
          createMediaPublishFixture('photo');
        if (rejectedMethod === 'GET') {
          mediaFetch.mockResolvedValueOnce(mediaResponse('photo'));
        }
        mediaFetch
          .mockRejectedValueOnce(new publicHttpsMedia.PublicHttpsMediaError('destination_denied'))
          .mockResolvedValueOnce(mediaResponse('photo'))
          .mockResolvedValueOnce(mediaResponse('photo', true));

        await publish();

        expect(
          mediaFetch.mock.calls.map(([url, options]) => [String(url), options.method]),
        ).toEqual([
          [primaryUrl, 'HEAD'],
          ...(rejectedMethod === 'GET' ? [[primaryUrl, 'GET']] : []),
          [alternateUrl, 'HEAD'],
          [alternateUrl, 'GET'],
        ]);
        expect(write).toHaveBeenCalledWith(
          primaryUrl,
          expect.objectContaining({
            status: 'FAILED',
            lastError: 'Не удалось скачать фото из VK.',
          }),
          mediaIdentity,
        );
        expect(maxClient.uploadImage).toHaveBeenCalledTimes(1);
        expect(maxClient.uploadImage).toHaveBeenCalledWith(
          Buffer.from([1, 2, 3]),
          'alternate.jpg',
          'image/jpeg',
          expect.objectContaining({ botId: 'publisher-bot' }),
        );
        expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
      },
    );

    it('retains photo candidate fallback after the typed error becomes a cached string', async () => {
      const { primaryUrl, alternateUrl, mediaIdentity, mediaCache, publish, maxClient } =
        createMediaPublishFixture('photo');
      mediaFetch.mockRejectedValueOnce(
        new publicHttpsMedia.PublicHttpsMediaError('destination_denied'),
      );
      const failed = await mediaCache.preflightMediaUrl(primaryUrl, mediaIdentity, 'publisher-bot');
      expect(failed).toMatchObject({
        status: 'FAILED',
        lastError: 'Не удалось скачать фото из VK.',
      });
      mediaFetch.mockClear();
      mediaFetch
        .mockResolvedValueOnce(mediaResponse('photo'))
        .mockResolvedValueOnce(mediaResponse('photo', true));

      await publish();

      expect(mediaFetch.mock.calls.map(([url, options]) => [String(url), options.method])).toEqual([
        [alternateUrl, 'HEAD'],
        [alternateUrl, 'GET'],
      ]);
      expect(maxClient.uploadImage).toHaveBeenCalledTimes(1);
      expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    });

    it('caches a denied video HEAD as failed and tries the independent video candidate', async () => {
      const { primaryUrl, alternateUrl, mediaIdentity, write, publish, maxClient } =
        createMediaPublishFixture('video');
      mediaFetch
        .mockRejectedValueOnce(new publicHttpsMedia.PublicHttpsMediaError('destination_denied'))
        .mockResolvedValueOnce(mediaResponse('video'))
        .mockResolvedValueOnce(mediaResponse('video', true));

      await publish();

      expect(mediaFetch.mock.calls.map(([url, options]) => [String(url), options.method])).toEqual([
        [primaryUrl, 'HEAD'],
        [alternateUrl, 'HEAD'],
        [alternateUrl, 'GET'],
      ]);
      expect(write).toHaveBeenCalledWith(
        primaryUrl,
        expect.objectContaining({
          status: 'FAILED',
          lastError: 'Не удалось скачать видео из VK.',
        }),
        mediaIdentity,
      );
      expect(
        write.mock.calls.filter(([url, data]) => url === primaryUrl && data.status === 'READY'),
      ).toHaveLength(0);
      expect(maxClient.uploadVideo).toHaveBeenCalledTimes(1);
      expect(maxClient.uploadVideo).toHaveBeenCalledWith(
        Buffer.from([1, 2, 3]),
        'alternate.mp4',
        'video/mp4',
        expect.objectContaining({ botId: 'publisher-bot', timeoutMs: 120_000 }),
      );
      expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    });

    it('reuses a same-bot video upload from a failed cache at another signed URL', async () => {
      const { mediaCache, mediaIdentity, write, publish, maxClient } = createMediaPublishFixture(
        'video',
        false,
      );
      await mediaCache.writeMediaCache(
        'https://vk-media.example/old-signed.mp4',
        {
          status: 'FAILED',
          lastError: 'Не удалось скачать видео из VK.',
          maxUploadPayload: {
            token: 'cached-video-token',
            [VK_MEDIA_CACHE_UPLOAD_BOT_ID_FIELD]: 'publisher-bot',
          },
          maxUploadToken: 'cached-video-token',
          maxUploadedAt: new Date(),
        },
        mediaIdentity,
      );
      write.mockClear();

      await publish();

      expect(mediaFetch).not.toHaveBeenCalled();
      expect(write).not.toHaveBeenCalled();
      expect(maxClient.uploadVideo).not.toHaveBeenCalled();
      expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
        'channel-1',
        expect.any(String),
        expect.objectContaining({
          attachments: [{ type: 'video', payload: { token: 'cached-video-token' } }],
        }),
        expect.objectContaining({ botId: 'publisher-bot' }),
      );
    });

    it('downloads the current video URL when a failed identity cache upload belongs to another bot', async () => {
      const { primaryUrl, mediaCache, mediaIdentity, publish, maxClient } =
        createMediaPublishFixture('video', false);
      await mediaCache.writeMediaCache(
        'https://vk-media.example/old-signed.mp4',
        {
          status: 'FAILED',
          lastError: 'Не удалось скачать видео из VK.',
          maxUploadPayload: {
            token: 'other-bot-token',
            [VK_MEDIA_CACHE_UPLOAD_BOT_ID_FIELD]: 'other-bot',
          },
          maxUploadToken: 'other-bot-token',
          maxUploadedAt: new Date(),
        },
        mediaIdentity,
      );
      mediaFetch
        .mockResolvedValueOnce(mediaResponse('video'))
        .mockResolvedValueOnce(mediaResponse('video', true));

      await publish();

      expect(mediaFetch.mock.calls.map(([url, options]) => [String(url), options.method])).toEqual([
        [primaryUrl, 'HEAD'],
        [primaryUrl, 'GET'],
      ]);
      expect(maxClient.uploadVideo).toHaveBeenCalledTimes(1);
      expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
        'channel-1',
        expect.any(String),
        expect.objectContaining({
          attachments: [{ type: 'video', payload: { token: 'video-token' } }],
        }),
        expect.objectContaining({ botId: 'publisher-bot' }),
      );
    });

    it('never downloads or sends a video after a denied HEAD without an alternate', async () => {
      const { primaryUrl, write, publish, maxClient } = createMediaPublishFixture('video', false);
      mediaFetch.mockRejectedValueOnce(
        new publicHttpsMedia.PublicHttpsMediaError('destination_denied'),
      );

      await expect(publish()).rejects.toThrow('Не удалось скачать видео из VK.');

      expect(mediaFetch.mock.calls.map(([url, options]) => [String(url), options.method])).toEqual([
        [primaryUrl, 'HEAD'],
      ]);
      expect(
        write.mock.calls.filter(([url, data]) => url === primaryUrl && data.status === 'READY'),
      ).toHaveLength(0);
      expect(maxClient.uploadVideo).not.toHaveBeenCalled();
      expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    });
  });

  it('reuses cached MAX media payloads even when the VK CDN preflight is failed', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const photoUrl = 'https://sun1.example/large.jpg';
    const post = createPostRow({
      source,
      text: 'Текст с фото',
      photoUrls: [photoUrl],
      attachments: [
        {
          type: 'photo',
          photo: {
            id: 11,
            owner_id: -36819802,
            access_key: 'photo-key',
            sizes: [{ width: 1280, height: 960, url: photoUrl }],
          },
        },
      ],
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    prisma.vkParsingMediaCache.findMany.mockResolvedValue([
      {
        id: 'media-1',
        url: photoUrl,
        mediaIdentity: 'vk-photo:-36819802:11:photo-key',
        status: 'FAILED',
        mimeType: null,
        contentLength: null,
        maxUploadPayload: {
          token: 'cached-token',
          [VK_MEDIA_CACHE_UPLOAD_BOT_ID_FIELD]: 'publisher-bot',
        },
        maxUploadToken: 'cached-token',
        maxUploadedAt: new Date('2026-05-25T10:00:00.000Z'),
        uploadAttemptCount: 1,
        lastCheckedAt: new Date(),
        lastError: 'VK вернул статус 404 для фото.',
        createdAt: new Date('2026-05-25T10:00:00.000Z'),
        updatedAt: new Date('2026-05-25T10:00:00.000Z'),
      },
    ]);
    prisma.vkParsingPost.update.mockResolvedValue({
      ...post,
      status: 'PUBLISHED',
      publishedMessageId: 'mid-1',
      publishedUrl: 'https://max.ru/channels/channel-1/message/mid-1',
      publishedAtMax: new Date('2026-05-25T10:05:00.000Z'),
      autoPublishedAt: new Date('2026-05-25T10:05:00.000Z'),
    });
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'mid-1',
      url: 'https://max.ru/channels/channel-1/message/mid-1',
    });

    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'autopublish',
      idempotencyKey: 'publish-key-1',
    });

    expect(global.fetch).toBe(originalFetch);
    expect(mediaFetch).not.toHaveBeenCalled();
    expect(maxClient.uploadImage).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'channel-1',
      'Текст с фото',
      expect.objectContaining({ imagePayload: { token: 'cached-token' } }),
      {
        botId: 'publisher-bot',
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
      },
    );
  });

  it('uploads a direct VK video and publishes it as a MAX video attachment', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const videoUrl = 'https://vkvd.example/video-720.mp4';
    const post = createPostRow({
      source,
      text: 'Видео из VK',
      videoUrls: [videoUrl],
      attachmentTypes: ['video'],
      attachments: [
        {
          type: 'video',
          video: {
            id: 42,
            owner_id: -36819802,
            access_key: 'video-key',
            title: 'Видеообзор',
            duration: 12,
            files: {
              mp4_360: 'https://vkvd.example/video-360.mp4',
              mp4_720: videoUrl,
            },
          },
        },
      ],
      raw: {
        attachments: [
          {
            type: 'video',
            video: {
              id: 42,
              owner_id: -36819802,
              access_key: 'video-key',
              files: {
                mp4_360: 'https://vkvd.example/video-360.mp4',
                mp4_720: videoUrl,
              },
            },
          },
        ],
      },
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    prisma.vkParsingPost.update.mockResolvedValue({
      ...post,
      status: 'PUBLISHED',
      publishedMessageId: 'mid-1',
      publishedUrl: 'https://max.ru/channels/channel-1/message/mid-1',
      publishedAtMax: new Date('2026-05-25T10:05:00.000Z'),
      autoPublishedAt: new Date('2026-05-25T10:05:00.000Z'),
    });
    maxClient.uploadVideo.mockResolvedValue({ token: 'video-token' });
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'mid-1',
      url: 'https://max.ru/channels/channel-1/message/mid-1',
    });
    mediaFetch
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { 'content-type': 'video/mp4', 'content-length': '4' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { 'content-type': 'video/mp4', 'content-length': '4' },
        }),
      );

    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'autopublish',
      idempotencyKey: 'publish-key-1',
    });

    expect(maxClient.uploadVideo).toHaveBeenCalledWith(
      Buffer.from([1, 2, 3, 4]),
      'video-720.mp4',
      'video/mp4',
      {
        botId: 'publisher-bot',
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
        timeoutMs: 120_000,
      },
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'channel-1',
      'Видео из VK',
      expect.objectContaining({
        attachments: [{ type: 'video', payload: { token: 'video-token' } }],
      }),
      {
        botId: 'publisher-bot',
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
      },
    );
  });

  it('publishes a VK video when HEAD is blocked and GET omits content-length', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const videoUrl = 'https://vkvd.example/video-720.mp4';
    const post = createPostRow({
      source,
      text: 'Видео из VK',
      videoUrls: [videoUrl],
      attachmentTypes: ['video'],
      attachments: [
        {
          type: 'video',
          video: {
            id: 42,
            owner_id: -36819802,
            access_key: 'video-key',
            files: { mp4_720: videoUrl },
          },
        },
      ],
      raw: {
        attachments: [
          {
            type: 'video',
            video: {
              id: 42,
              owner_id: -36819802,
              access_key: 'video-key',
              files: { mp4_720: videoUrl },
            },
          },
        ],
      },
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    prisma.vkParsingPost.update.mockResolvedValue({
      ...post,
      status: 'PUBLISHED',
      publishedMessageId: 'mid-1',
      publishedUrl: 'https://max.ru/channels/channel-1/message/mid-1',
      publishedAtMax: new Date('2026-05-25T10:05:00.000Z'),
      autoPublishedAt: new Date('2026-05-25T10:05:00.000Z'),
    });
    maxClient.uploadVideo.mockResolvedValue({ token: 'video-token' });
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'mid-1',
      url: 'https://max.ru/channels/channel-1/message/mid-1',
    });
    mediaFetch.mockResolvedValueOnce(new Response(null, { status: 405 })).mockResolvedValueOnce(
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'content-type': 'video/mp4' },
      }),
    );

    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'autopublish',
      idempotencyKey: 'publish-key-1',
    });

    expect(mediaFetch.mock.calls.map(([url, options]) => [String(url), options.method])).toEqual([
      [videoUrl, 'HEAD'],
      [videoUrl, 'GET'],
    ]);
    expect(mediaFetch.mock.calls.every(([, options]) => options.range === undefined)).toBe(true);
    expect(maxClient.uploadVideo).toHaveBeenCalledWith(
      Buffer.from([1, 2, 3, 4]),
      'video-720.mp4',
      'video/mp4',
      expect.objectContaining({
        botId: 'publisher-bot',
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
      }),
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'channel-1',
      'Видео из VK',
      expect.objectContaining({
        attachments: [{ type: 'video', payload: { token: 'video-token' } }],
      }),
      expect.objectContaining({
        botId: 'publisher-bot',
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
      }),
    );
  });

  it('rejects a VK video download with an explicit non-video content type', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const videoUrl = 'https://vkvd.example/video-720.mp4';
    const post = createPostRow({
      source,
      text: 'Видео из VK',
      videoUrls: [videoUrl],
      attachmentTypes: ['video'],
      attachments: [
        {
          type: 'video',
          video: {
            id: 42,
            owner_id: -36819802,
            access_key: 'video-key',
            files: { mp4_720: videoUrl },
          },
        },
      ],
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    mediaFetch
      .mockResolvedValueOnce(new Response(null, { status: 405 }))
      .mockResolvedValueOnce(
        new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      );

    await expect(
      service.processPublishPostJob({
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'autopublish',
        idempotencyKey: 'publish-key-1',
      }),
    ).rejects.toThrow('VK вернул не видео.');

    expect(maxClient.uploadVideo).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'post-1' }),
        data: expect.objectContaining({
          status: 'FAILED',
          lastError: expect.stringContaining('VK вернул не видео.'),
          autoPublishError: expect.stringContaining('VK вернул не видео.'),
        }),
      }),
    );
  });

  it('keeps MAX media upload rate limits as autopublish retry failures', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      text: 'Текст с фото',
      photoUrls: ['https://sun1.example/large.jpg'],
      attachments: [
        {
          type: 'photo',
          photo: {
            id: 11,
            owner_id: -36819802,
            sizes: [{ width: 1280, height: 960, url: 'https://sun1.example/large.jpg' }],
          },
        },
      ],
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    maxClient.uploadImage.mockRejectedValue(
      new Error('MAX API background rate limit exceeded for bot publisher-bot'),
    );
    mediaFetch
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { 'content-type': 'image/jpeg', 'content-length': '3' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'image/jpeg', 'content-length': '3' },
        }),
      );

    await expect(
      service.processPublishPostJob({
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'autopublish',
        idempotencyKey: 'publish-key-1',
      }),
    ).rejects.toThrow('MAX API background rate limit exceeded');

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'post-1' }),
        data: expect.objectContaining({
          status: 'FAILED',
          lastError: expect.stringContaining('[max.rate_limit]'),
          autoPublishError: expect.stringContaining('[max.rate_limit]'),
        }),
      }),
    );
    const lastUpdate = prisma.vkParsingPost.updateMany.mock.calls.at(-1)?.[0] as
      | { data?: Record<string, unknown> }
      | undefined;
    expect(lastUpdate?.data).toEqual(
      expect.objectContaining({
        status: 'FAILED',
        publishLockedAt: null,
      }),
    );
    expect(lastUpdate?.data).not.toHaveProperty('publishQueuedAt');
    expect(lastUpdate?.data).not.toHaveProperty('publishIdempotencyKey');
    expect(lastUpdate?.data).not.toHaveProperty('publishReason');
  });

  it('keeps queued autopublish metadata when channel link lookup fails transiently', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      text: 'Текст со ссылкой на канал',
      ...createFreshQueuedPublishTimes(),
      publishIdempotencyKey: 'publish-key-1',
      publishReason: 'autopublish',
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      appendChannelLinkEnabled: true,
      channelLinkText: 'Наш канал',
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    prisma.managedBotChatCatalog.findFirst.mockResolvedValue(null);
    maxClient.getChatSnapshot.mockRejectedValue(new Error('request timed out during MAX lookup'));

    await expect(
      service.processPublishPostJob({
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'autopublish',
        idempotencyKey: 'publish-key-1',
      }),
    ).rejects.toThrow('Не удалось получить ссылку канала');

    const lastUpdate = prisma.vkParsingPost.updateMany.mock.calls.at(-1)?.[0] as
      | { data?: Record<string, unknown> }
      | undefined;
    expect(lastUpdate?.data).toEqual(
      expect.objectContaining({
        status: 'FAILED',
        publishLockedAt: null,
        lastError: expect.stringContaining('[publish.unknown]'),
      }),
    );
    expect(lastUpdate?.data).not.toHaveProperty('publishQueuedAt');
    expect(lastUpdate?.data).not.toHaveProperty('publishScheduledAt');
    expect(lastUpdate?.data).not.toHaveProperty('publishIdempotencyKey');
    expect(lastUpdate?.data).not.toHaveProperty('publishReason');
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('clears terminal retry state when media preparation fails before the attempt CAS', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-25T10:00:00.000Z'));
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      text: 'Текст с фото',
      publishQueuedAt: new Date('2026-05-25T09:59:00.000Z'),
      publishScheduledAt: new Date('2026-05-25T10:00:00.000Z'),
      publishIdempotencyKey: 'publish-key-1',
      publishReason: 'autopublish',
      photoUrls: ['https://sun1.example/large.jpg'],
      attachments: [
        {
          type: 'photo',
          photo: {
            id: 11,
            owner_id: -36819802,
            sizes: [{ width: 1280, height: 960, url: 'https://sun1.example/large.jpg' }],
          },
        },
      ],
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    maxClient.uploadImage.mockRejectedValue(
      new Error('MAX API background rate limit exceeded for bot publisher-bot'),
    );
    mediaFetch
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { 'content-type': 'image/jpeg', 'content-length': '3' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'image/jpeg', 'content-length': '3' },
        }),
      );

    await expect(
      service.processPublishPostJob({
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'autopublish',
        idempotencyKey: 'publish-key-1',
        attemptsMade: 4,
        maxAttempts: 5,
      }),
    ).rejects.toThrow('MAX API background rate limit exceeded');

    const lastUpdate = prisma.vkParsingPost.updateMany.mock.calls.at(-1)?.[0] as
      | { where?: Record<string, unknown>; data?: Record<string, unknown> }
      | undefined;
    expect(lastUpdate?.where).toEqual(
      expect.objectContaining({
        id: 'post-1',
        publishIdempotencyKey: 'publish-key-1',
        publishReason: 'autopublish',
        publishLockedAt: new Date('2026-05-25T10:00:00.000Z'),
        publishAttemptCount: 0,
        lastError: null,
      }),
    );
    expect(lastUpdate?.data).toEqual(
      expect.objectContaining({
        status: 'FAILED',
        lastError: expect.stringContaining('[max.rate_limit]'),
        autoPublishError: expect.stringContaining('[max.rate_limit]'),
        publishLockedAt: null,
        publishQueuedAt: null,
        publishIdempotencyKey: null,
        publishReason: null,
      }),
    );
    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { publishAttemptCount: { increment: 1 } } }),
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('increments the exact claimed attempt before dispatching to MAX', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-04T12:00:00.000Z'));
    const { service, prisma, maxClient } = createFixture();
    const post = createPostRow({
      publishQueuedAt: new Date('2026-09-04T11:59:00.000Z'),
      publishScheduledAt: new Date('2026-09-04T12:00:00.000Z'),
      publishIdempotencyKey: 'exact-attempt-key',
      publishReason: 'manual-retry',
    });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'max-message-exact-attempt',
      url: 'https://max.ru/channel-1/max-message-exact-attempt',
    });

    await service.processPublishPostJob({
      postId: post.id,
      chatId: post.chatId,
      reason: 'manual-retry',
      idempotencyKey: 'exact-attempt-key',
    });

    const attemptCallIndex = prisma.vkParsingPost.updateMany.mock.calls.findIndex(
      ([query]) => query.data.publishAttemptCount?.increment === 1,
    );
    expect(attemptCallIndex).toBeGreaterThanOrEqual(0);
    expect(prisma.vkParsingPost.updateMany).toHaveBeenNthCalledWith(attemptCallIndex + 1, {
      where: {
        id: 'post-1',
        publishIdempotencyKey: 'exact-attempt-key',
        publishReason: 'manual-retry',
        publishLockedAt: new Date('2026-09-04T12:00:00.000Z'),
      },
      data: { publishAttemptCount: { increment: 1 } },
    });
    expect(prisma.vkParsingPost.updateMany.mock.invocationCallOrder[attemptCallIndex]).toBeLessThan(
      maxClient.sendMessageImmediateWithResolvedLink.mock.invocationCallOrder[0]!,
    );
  });

  it('aborts before MAX when the exact attempt CAS loses its claimed lock', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-04T12:00:00.000Z'));
    const { service, prisma, maxClient } = createFixture();
    const post = createPostRow({
      publishQueuedAt: new Date('2026-09-04T11:59:00.000Z'),
      publishScheduledAt: new Date('2026-09-04T12:00:00.000Z'),
      publishIdempotencyKey: 'lost-attempt-key',
      publishReason: 'manual-retry',
    });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockImplementation(async (query: any) => ({
      count: query.data.publishAttemptCount?.increment === 1 ? 0 : 1,
    }));

    await expect(
      service.processPublishPostJob({
        postId: post.id,
        chatId: post.chatId,
        reason: 'manual-retry',
        idempotencyKey: 'lost-attempt-key',
      }),
    ).resolves.toBeUndefined();

    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'post-1',
        publishIdempotencyKey: 'lost-attempt-key',
        publishReason: 'manual-retry',
        publishLockedAt: new Date('2026-09-04T12:00:00.000Z'),
      },
      data: { publishAttemptCount: { increment: 1 } },
    });
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ publishIdempotencyKey: null }),
      }),
    );
  });

  it('defers a final retryable failure for one hour after a durable MAX attempt', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-04T12:00:00.000Z'));
    const { service, prisma, maxClient, publishQueue } = createFixture();
    const source = createSource();
    const settings = {
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-09-04T08:00:00.000Z'),
      autoPublishKillSwitchEnabled: false,
      schedulerTimezone: 'UTC',
      quietHoursStart: null,
      quietHoursEnd: null,
      workHoursStart: '00:00',
      workHoursEnd: '00:00',
      distributeEvenlyEnabled: true,
      roundRobinEnabled: false,
      skipAdsEnabled: false,
    };
    const fingerprint = buildVkAutoPublishScheduleFingerprint(settings, source);
    const post = createPostRow({
      source,
      createdAt: new Date('2026-09-04T09:00:00.000Z'),
      vkPublishedAt: new Date('2026-09-04T09:00:00.000Z'),
      publishQueuedAt: new Date('2026-09-04T11:59:00.000Z'),
      publishScheduledAt: new Date('2026-09-04T12:00:00.000Z'),
      publishIdempotencyKey: 'durable-final-key',
      publishReason: 'autopublish',
      publishScheduleFingerprint: fingerprint,
    });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingSettings.findUnique.mockResolvedValue(settings);
    maxClient.sendMessageImmediateWithResolvedLink.mockRejectedValue(
      new Error('MAX API background rate limit exceeded for bot publisher-bot'),
    );

    await expect(
      service.processPublishPostJob({
        postId: post.id,
        chatId: post.chatId,
        reason: 'autopublish',
        idempotencyKey: 'durable-final-key',
        attemptsMade: 4,
        maxAttempts: 5,
      }),
    ).resolves.toEqual({ deferUntil: new Date('2026-09-04T13:00:00.000Z') });

    const failed = prisma.vkParsingPost.updateMany.mock.calls.find(
      ([query]) => query.data.status === 'FAILED',
    )?.[0];
    expect(failed).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'post-1',
          publishIdempotencyKey: 'durable-final-key',
          publishReason: 'autopublish',
          publishLockedAt: new Date('2026-09-04T12:00:00.000Z'),
          publishAttemptCount: 1,
          lastError: null,
        }),
        data: expect.objectContaining({
          status: 'FAILED',
          publishLockedAt: null,
          publishScheduledAt: new Date('2026-09-04T13:00:00.000Z'),
        }),
      }),
    );
    expect(failed?.data).not.toHaveProperty('publishQueuedAt');
    expect(failed?.data).not.toHaveProperty('publishIdempotencyKey');
    expect(failed?.data).not.toHaveProperty('publishReason');
    expect(failed?.data).not.toHaveProperty('publishScheduleFingerprint');
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    expect(publishQueue.add).not.toHaveBeenCalled();
  });

  it('defers a final attempt when its exact publish-attempt persistence is uncertain', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-04T12:00:00.000Z'));
    const { service, prisma, maxClient, maxRoutedPublicationService, publishQueue } =
      createFixture();
    const persistenceError = new Error('database connection lost while recording publish attempt');
    const post = createPostRow({
      publishQueuedAt: new Date('2026-09-04T11:59:00.000Z'),
      publishScheduledAt: new Date('2026-09-04T12:00:00.000Z'),
      publishIdempotencyKey: 'uncertain-final-attempt-key',
      publishReason: 'manual-retry',
      publishAttemptCount: 0,
    });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockImplementation(async (query: any) => {
      if (query.data.publishAttemptCount?.increment === 1) {
        throw persistenceError;
      }
      return { count: 1 };
    });

    await expect(
      service.processPublishPostJob({
        postId: post.id,
        chatId: post.chatId,
        reason: 'manual-retry',
        idempotencyKey: 'uncertain-final-attempt-key',
        attemptsMade: 4,
        maxAttempts: 5,
      }),
    ).resolves.toEqual({ deferUntil: new Date('2026-09-04T13:00:00.000Z') });

    const attemptWrite = prisma.vkParsingPost.updateMany.mock.calls.find(
      ([query]) => query.data.publishAttemptCount?.increment === 1,
    )?.[0];
    expect(attemptWrite).toEqual({
      where: {
        id: post.id,
        publishIdempotencyKey: 'uncertain-final-attempt-key',
        publishReason: 'manual-retry',
        publishLockedAt: new Date('2026-09-04T12:00:00.000Z'),
      },
      data: { publishAttemptCount: { increment: 1 } },
    });
    const failed = prisma.vkParsingPost.updateMany.mock.calls.find(
      ([query]) => query.data.status === 'FAILED',
    )?.[0];
    expect(failed).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({
          id: post.id,
          publishIdempotencyKey: 'uncertain-final-attempt-key',
          publishReason: 'manual-retry',
          publishLockedAt: new Date('2026-09-04T12:00:00.000Z'),
          lastError: null,
        }),
        data: expect.objectContaining({
          status: 'FAILED',
          publishLockedAt: null,
          publishScheduledAt: new Date('2026-09-04T13:00:00.000Z'),
          lastError: expect.stringContaining('[publish.unknown]'),
        }),
      }),
    );
    expect(failed?.where).not.toHaveProperty('publishAttemptCount');
    expect(failed?.data).not.toHaveProperty('publishQueuedAt');
    expect(failed?.data).not.toHaveProperty('publishIdempotencyKey');
    expect(failed?.data).not.toHaveProperty('publishReason');
    expect(maxRoutedPublicationService.publish).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(publishQueue.add).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'keeps the original key before a retryable manual retry',
      error: new Error('MAX API background rate limit exceeded before dispatch'),
      attemptsMade: 0,
      durableAttemptCount: 0,
      expectedClear: false,
      expectedDefer: false,
    },
    {
      label: 'clears the original key after the final retryable manual attempt',
      error: new Error('MAX API background rate limit exceeded before dispatch'),
      attemptsMade: 4,
      durableAttemptCount: 0,
      expectedClear: true,
      expectedDefer: false,
    },
    {
      label: 'keeps the same key before a fifth actual durable attempt',
      error: new Error('MAX API background rate limit exceeded before dispatch'),
      attemptsMade: 0,
      durableAttemptCount: 4,
      expectedClear: false,
      expectedDefer: false,
    },
    {
      label: 'clears the original key after a non-retryable manual failure',
      error: createMaxApiError(400, 'MAX rejected the publication'),
      attemptsMade: 0,
      durableAttemptCount: 0,
      expectedClear: true,
      expectedDefer: false,
    },
  ])(
    '$label',
    async ({ error, attemptsMade, durableAttemptCount, expectedClear, expectedDefer }) => {
      const publish = jest.fn().mockRejectedValue(error);
      const { service, prisma } = createFixture({}, { maxRoutedPublicationService: { publish } });
      const post = createPostRow({
        source: createSource(),
        publishQueuedAt: new Date('2026-05-25T09:59:00.000Z'),
        publishScheduledAt: new Date('2026-05-25T10:00:00.000Z'),
        publishIdempotencyKey: 'manual-retry-key',
        publishReason: 'manual-retry',
        publishAttemptCount: durableAttemptCount,
      });
      prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
      prisma.vkParsingPost.findFirst.mockResolvedValue(post);

      const execution = service.processPublishPostJob({
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'manual-retry',
        idempotencyKey: 'manual-retry-key',
        attemptsMade,
        maxAttempts: 5,
      });
      if (expectedDefer) {
        await expect(execution).resolves.toEqual({ deferUntil: expect.any(Date) });
      } else {
        await expect(execution).rejects.toBe(error);
      }

      const lastUpdate = prisma.vkParsingPost.updateMany.mock.calls.at(-1)?.[0] as
        | { where?: Record<string, unknown>; data?: Record<string, unknown> }
        | undefined;
      expect(lastUpdate?.where).toEqual(
        expect.objectContaining({
          id: 'post-1',
          publishIdempotencyKey: 'manual-retry-key',
        }),
      );
      expect(lastUpdate?.data).toEqual(
        expect.objectContaining({
          status: 'FAILED',
          publishLockedAt: null,
        }),
      );
      if (expectedClear) {
        expect(lastUpdate?.data).toEqual(
          expect.objectContaining({
            publishQueuedAt: null,
            publishScheduledAt: null,
            publishIdempotencyKey: null,
            publishReason: null,
          }),
        );
      } else {
        expect(lastUpdate?.data).not.toHaveProperty('publishQueuedAt');
        expect(lastUpdate?.data).not.toHaveProperty('publishIdempotencyKey');
        expect(lastUpdate?.data).not.toHaveProperty('publishReason');
        if (expectedDefer) {
          expect(lastUpdate?.data).toEqual(
            expect.objectContaining({ publishScheduledAt: expect.any(Date) }),
          );
        } else {
          expect(lastUpdate?.data).not.toHaveProperty('publishScheduledAt');
        }
      }
      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({
          logicalIdempotencyKey: 'vk-parsing:publish:post-1:manual-retry-key',
        }),
      );
    },
  );

  it('skips advertising VK posts during autopublish without sending them to MAX', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      isAdvertising: true,
      advertisingMarkers: ['VK marked_as_ads'],
      raw: { marked_as_ads: true },
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: true,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });

    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'autopublish',
      idempotencyKey: 'publish-key-1',
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'post-1' }),
        data: expect.objectContaining({
          status: 'SKIPPED',
          skipReason: 'AD',
          publishQueuedAt: null,
          publishLockedAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
        }),
      }),
    );
  });

  it('does not let a manual skip overwrite a post with an armed rollback', async () => {
    const { service, prisma, maxClient } = createFixture();
    const post = createPostRow({
      isAdvertising: true,
      advertisingMarkers: ['VK marked_as_ads'],
      raw: { marked_as_ads: true },
      publishIdempotencyKey: 'owned-publish-key',
      publishReason: 'manual-retry',
      rollbackQueuedAt: new Date('2026-09-04T11:59:00.000Z'),
      rollbackIdempotencyKey: 'armed-rollback-key',
    });
    const persisted = {
      status: post.status,
      publishIdempotencyKey: post.publishIdempotencyKey,
      rollbackIdempotencyKey: post.rollbackIdempotencyKey,
    };
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 0 });
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      stripLinksEnabled: false,
      skipAdsEnabled: true,
    });

    await expect(
      service.publishPost('channel-1', 'post-1', { userId: '98315271' } as never, {
        text: post.text,
        photoUrls: [],
        linkUrls: [],
      }),
    ).rejects.toThrow('реклам');

    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'post-1',
          publishIdempotencyKey: 'owned-publish-key',
          publishReason: 'manual-retry',
          rollbackQueuedAt: null,
          rollbackLockedAt: null,
          rollbackIdempotencyKey: null,
        }),
        data: expect.objectContaining({
          status: 'SKIPPED',
          publishIdempotencyKey: null,
        }),
      }),
    );
    expect(persisted).toEqual({
      status: 'NEW',
      publishIdempotencyKey: 'owned-publish-key',
      rollbackIdempotencyKey: 'armed-rollback-key',
    });
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('skips unsupported-only VK posts during autopublish instead of failing them', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      text: '',
      photoUrls: [],
      linkUrls: [],
      attachmentTypes: ['video'],
      unsupportedAttachments: [{ type: 'video', label: 'Видео', title: 'Обзор', count: 1 }],
      hasUnsupportedAttachments: true,
      attachments: [{ type: 'video', video: { title: 'Обзор' } }],
      raw: { attachments: [{ type: 'video', video: { title: 'Обзор' } }] },
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: false,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });

    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'autopublish',
      idempotencyKey: 'publish-key-1',
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'post-1' }),
        data: expect.objectContaining({
          status: 'SKIPPED',
          skipReason: 'NO_SUPPORTED_CONTENT',
          publishQueuedAt: null,
          publishLockedAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
        }),
      }),
    );
  });

  it('autopublishes unsupported VK short videos as original post links when links are stripped', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const postUrl = 'https://vk.ru/wall-36819802_104';
    const post = createPostRow({
      source,
      text: '',
      photoUrls: [],
      videoUrls: [],
      linkUrls: [postUrl],
      attachmentTypes: ['video'],
      unsupportedAttachments: [
        {
          type: 'video',
          label: 'Видео',
          title: 'Clip from СПОРТ ИНСАЙДЕР',
          count: 1,
          reason: 'Нет прямого HTTPS-файла видео',
        },
      ],
      hasUnsupportedAttachments: true,
      url: postUrl,
      attachments: [
        {
          type: 'video',
          video: { title: 'Clip from СПОРТ ИНСАЙДЕР', type: 'short_video' },
        },
      ],
      raw: {
        attachments: [
          {
            type: 'video',
            video: { title: 'Clip from СПОРТ ИНСАЙДЕР', type: 'short_video' },
          },
        ],
      },
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      id: 'settings-1',
      chatId: 'channel-1',
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-05-25T09:00:00.000Z'),
      stripLinksEnabled: true,
      skipAdsEnabled: false,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    prisma.vkParsingPost.update.mockResolvedValue({
      ...post,
      status: 'PUBLISHED',
      publishedMessageId: 'mid-1',
      publishedUrl: 'https://max.ru/channels/channel-1/message/mid-1',
      publishedAtMax: new Date('2026-05-25T10:05:00.000Z'),
      autoPublishedAt: new Date('2026-05-25T10:05:00.000Z'),
    });
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'mid-1',
      url: 'https://max.ru/channels/channel-1/message/mid-1',
    });

    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'autopublish',
      idempotencyKey: 'publish-key-1',
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'channel-1',
      postUrl,
      expect.any(Object),
      expect.objectContaining({
        botId: 'publisher-bot',
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
      }),
    );
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'post-1' }),
        data: expect.objectContaining({
          status: 'PUBLISHED',
          autoPublishError: null,
          lastError: null,
        }),
      }),
    );
  });

  it('retries VK rate limit errors and records VK API metrics', async () => {
    const { service, prisma, vkRateLimitService } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValue([]);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        createJsonFetchResponse({
          error: { error_code: 6, error_msg: 'Too many requests per second.' },
        }),
      )
      .mockResolvedValueOnce(
        createJsonFetchResponse({ response: { items: [], groups: [] } }),
      ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(vkRateLimitService.reserveVkApiSlot).toHaveBeenCalledTimes(2);
    expect(vkRateLimitService.recordVkApiOutcome).toHaveBeenCalledWith({
      method: 'wall.get',
      outcome: 'error',
      code: 'vk_6',
    });
    expect(vkRateLimitService.recordVkApiOutcome).toHaveBeenCalledWith({
      method: 'wall.get',
      outcome: 'success',
    });
  });

  it.each([120, 7_200])(
    'persists the full %is HTTP Retry-After without an early retry',
    async (retryAfterSeconds) => {
      const now = new Date('2026-11-04T10:00:00.000Z');
      jest.useFakeTimers().setSystemTime(now);
      const { service, prisma, publishQueue } = createFixture();
      prisma.vkParsingSource.findUnique.mockResolvedValue(createSource());
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Headers({ 'Retry-After': String(retryAfterSeconds) }),
        body: { cancel: jest.fn().mockResolvedValue(undefined) },
      }) as unknown as typeof fetch;

      await expect(service.processSyncSourceJob('source-1', 'scheduled')).resolves.toBe(0);

      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'source-1',
            ownerProfile: VkParsingOwnerProfile.PUBLISHER,
            ownerBotId: 'publisher-bot',
            syncStatus: 'SYNCING',
            syncLockedBy: expect.any(String),
          }),
          data: expect.objectContaining({
            syncStatus: 'BACKOFF',
            nextSyncAt: new Date(now.getTime() + retryAfterSeconds * 1_000),
            consecutiveFailures: 1,
            terminalFailureCount: 0,
            circuitOpenedAt: null,
            circuitRetryAt: null,
            syncLockedBy: null,
            syncLockDeadlineAt: null,
            lastErrorCode: 'vk_api.http_429',
          }),
        }),
      );
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
      expect(publishQueue.add).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['missing', undefined],
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1_793_779_320_000.5],
    ['nonfinite', Number.POSITIVE_INFINITY],
    ['NaN', Number.NaN],
    ['year 10000', 253_402_300_800_000],
    ['maximum JS Date', 8_640_000_000_000_000],
    ['outside Date range', 8_640_000_000_000_001],
    ['string', '1793779320000'],
    ['past', 1],
    ['earlier than backoff', new Date('2026-11-04T10:00:30.000Z').getTime()],
  ])('preserves ordinary source backoff for a %s retry deadline', async (_label, retryAtMs) => {
    const now = new Date('2026-11-04T10:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const { service, prisma, vkRateLimitService } = createFixture({ VK_API_MAX_ATTEMPTS: 1 });
    prisma.vkParsingSource.findUnique.mockResolvedValue(createSource());
    vkRateLimitService.reserveVkApiSlot.mockRejectedValueOnce(
      Object.assign(new VkApiRequestError('Synthetic VK throttle', 'http_429', true), {
        retryAtMs,
      }),
    );
    global.fetch = jest.fn() as unknown as typeof fetch;

    await expect(service.processSyncSourceJob('source-1', 'scheduled')).resolves.toBe(0);

    expect(global.fetch).not.toHaveBeenCalled();
    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          syncStatus: 'BACKOFF',
          nextSyncAt: new Date(now.getTime() + 60_000),
          terminalFailureCount: 0,
          circuitOpenedAt: null,
          lastErrorCode: 'vk_api.http_429',
        }),
      }),
    );
  });

  it.each([401, 403, 404])('keeps HTTP %i terminal despite Retry-After', async (status) => {
    const { service, prisma, vkRateLimitService } = createFixture();
    prisma.vkParsingSource.findUnique.mockResolvedValue(createSource());
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status,
      headers: new Headers({ 'Retry-After': '7200' }),
      body: { cancel: jest.fn().mockResolvedValue(undefined) },
    }) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(vkRateLimitService.publishVkApiCooldown).not.toHaveBeenCalled();
    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          syncStatus: 'ERROR',
          nextSyncAt: null,
          terminalFailureCount: 1,
          circuitOpenedAt: expect.any(Date),
          circuitRetryAt: null,
          lastErrorCode: `vk_api.http_${status}`,
        }),
      }),
    );
  });

  it('ignores a provider deadline during the configured terminal verification retry', async () => {
    const now = new Date('2026-11-04T10:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const { service, prisma, vkRateLimitService } = createFixture({
      VK_PARSING_SOURCE_CIRCUIT_TERMINAL_FAILURE_THRESHOLD: 2,
    });
    prisma.vkParsingSource.findUnique.mockResolvedValue(createSource());
    vkRateLimitService.reserveVkApiSlot.mockRejectedValueOnce(
      new VkApiRequestError(
        'Synthetic terminal VK refusal',
        'http_403',
        false,
        now.getTime() + 7_200_000,
      ),
    );

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          syncStatus: 'BACKOFF',
          nextSyncAt: new Date(now.getTime() + 60_000),
          terminalFailureCount: 1,
          circuitOpenedAt: null,
          circuitRetryAt: new Date(now.getTime() + 60_000),
          lastErrorCode: 'vk_api.http_403',
        }),
      }),
    );
  });

  it('does not persist an old throttle after losing the source lease during fetch', async () => {
    const { service, prisma, publishQueue } = createFixture();
    prisma.vkParsingSource.findUnique.mockResolvedValue(createSource());
    let enteredFetch!: () => void;
    const fetching = new Promise<void>((resolve) => {
      enteredFetch = resolve;
    });
    let completeFetch!: (response: MockFetchResponse) => void;
    global.fetch = jest.fn().mockImplementation(
      () =>
        new Promise<MockFetchResponse>((resolve) => {
          completeFetch = resolve;
          enteredFetch();
        }),
    ) as unknown as typeof fetch;
    const processing = service.processSyncSourceJob('source-1', 'scheduled');
    await fetching;
    prisma.$queryRaw.mockResolvedValue([]);
    completeFetch({
      ok: false,
      status: 429,
      headers: new Headers({ 'Retry-After': '7200' }),
      body: { cancel: async () => undefined },
    });

    await expect(processing).resolves.toBe(0);

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.vkParsingSource.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ syncStatus: 'BACKOFF' }) }),
    );
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(publishQueue.add).not.toHaveBeenCalled();
  });

  it.each([6, 9, 10, 29])('retries retryable VK error code %i', async (code) => {
    const { service, prisma, vkRateLimitService } = createFixture({ VK_API_MAX_ATTEMPTS: 2 });
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValue([]);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        createJsonFetchResponse({
          error: { error_code: code, error_msg: `Retryable ${code}` },
        }),
      )
      .mockResolvedValueOnce(
        createJsonFetchResponse({ response: { items: [], groups: [] } }),
      ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(vkRateLimitService.reserveVkApiSlot).toHaveBeenCalledTimes(2);
    expect(vkRateLimitService.recordVkApiOutcome).toHaveBeenCalledWith({
      method: 'wall.get',
      outcome: 'error',
      code: `vk_${code}`,
    });
    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          syncStatus: 'IDLE',
          lastErrorCode: null,
        }),
      }),
    );
  });

  it.each([30, 203, 210])('treats VK source error code %i as terminal', async (code) => {
    const { service, prisma, vkRateLimitService } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        error: { error_code: code, error_msg: `Terminal ${code}` },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(vkRateLimitService.reserveVkApiSlot).toHaveBeenCalledTimes(1);
    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'source-1', syncLockedBy: expect.any(String) }),
        data: expect.objectContaining({
          syncStatus: 'ERROR',
          nextSyncAt: null,
          lastErrorCode: `vk_api.vk_${code}`,
          lastError: expect.stringContaining(`(${code})`),
        }),
      }),
    );
  });

  it('treats VK captcha code 14 as terminal with an actionable token message', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        error: { error_code: 14, error_msg: 'Captcha needed' },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          syncStatus: 'ERROR',
          nextSyncAt: null,
          lastErrorCode: 'vk_api.vk_14',
          lastError: expect.stringContaining('капчу или токен не подходит'),
        }),
      }),
    );
  });

  it('handles an empty VK wall without importing posts', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValue([]);
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        createJsonFetchResponse({ response: { items: [], groups: [] } }),
      ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 5_000,
      timeout: 15_000,
    });
    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'source-1', syncLockedBy: expect.any(String) }),
        data: expect.objectContaining({
          syncStatus: 'IDLE',
          syncLockDeadlineAt: null,
          syncHeartbeatAt: null,
          lastFetchedCount: 0,
          lastImportedCount: 0,
        }),
      }),
    );
  });

  it('records sync lease deadline and heartbeats while processing a source', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValue([]);
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        createJsonFetchResponse({ response: { items: [], groups: [] } }),
      ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'source-1' }),
        data: expect.objectContaining({
          syncLockedBy: expect.any(String),
          syncLockDeadlineAt: expect.any(Date),
          syncHeartbeatAt: expect.any(Date),
          syncAttemptCount: { increment: 1 },
        }),
      }),
    );
    expect(prisma.vkParsingSource.updateMany.mock.calls).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            where: expect.objectContaining({
              id: 'source-1',
              syncStatus: 'SYNCING',
              syncLockedBy: expect.any(String),
            }),
            data: expect.objectContaining({
              syncHeartbeatAt: expect.any(Date),
              syncLockDeadlineAt: expect.any(Date),
            }),
          }),
        ],
      ]),
    );
  });

  it('opens a source circuit breaker for terminal private or content-blocked VK sources', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        error: { error_code: 19, error_msg: 'Content blocked' },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'source-1', syncLockedBy: expect.any(String) }),
        data: expect.objectContaining({
          syncStatus: 'ERROR',
          nextSyncAt: null,
          consecutiveFailures: 1,
          terminalFailureCount: 1,
          circuitOpenedAt: expect.any(Date),
          circuitReasonCode: 'vk_api.vk_19',
          circuitReason: expect.stringContaining('Content blocked'),
          circuitRetryAt: null,
          lastErrorCode: 'vk_api.vk_19',
        }),
      }),
    );
  });

  it('can verify a terminal VK source before opening the source circuit breaker', async () => {
    const { service, prisma } = createFixture({
      VK_PARSING_SOURCE_CIRCUIT_TERMINAL_FAILURE_THRESHOLD: 2,
    });
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        error: { error_code: 15, error_msg: 'Access denied' },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'source-1', syncLockedBy: expect.any(String) }),
        data: expect.objectContaining({
          syncStatus: 'BACKOFF',
          nextSyncAt: expect.any(Date),
          terminalFailureCount: 1,
          circuitOpenedAt: null,
          circuitReasonCode: null,
          circuitReason: null,
          circuitRetryAt: expect.any(Date),
          lastErrorCode: 'vk_api.vk_15',
        }),
      }),
    );
  });

  it('preserves terminal failure counters when scheduled sync retries a source', async () => {
    const { service, prisma, syncQueue } = createFixture();
    prisma.vkParsingSource.findMany.mockResolvedValue([
      createSource({
        syncStatus: 'BACKOFF',
        terminalFailureCount: 1,
        circuitRetryAt: new Date('2026-05-25T10:05:00.000Z'),
      }),
    ]);

    await service.syncDueSources('scheduled');

    expect(prisma.vkParsingSource.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ownerProfile: VkParsingOwnerProfile.PUBLISHER,
          ownerBotId: 'publisher-bot',
        }),
      }),
    );
    const update = prisma.vkParsingSource.updateMany.mock.calls.at(-1)?.[0] as
      | { data?: Record<string, unknown>; where?: Record<string, unknown> }
      | undefined;
    expect(update?.where).toEqual(
      expect.objectContaining({
        ownerProfile: VkParsingOwnerProfile.PUBLISHER,
        ownerBotId: 'publisher-bot',
      }),
    );
    expect(update?.data).toEqual(
      expect.objectContaining({
        syncStatus: 'QUEUED',
        nextSyncAt: expect.any(Date),
      }),
    );
    expect(update?.data).not.toHaveProperty('terminalFailureCount');
    expect(update?.data).not.toHaveProperty('circuitOpenedAt');
    expect(update?.data).not.toHaveProperty('circuitReasonCode');
    expect(syncQueue.add).toHaveBeenCalled();
  });

  it('opens the source circuit after the configured terminal retry threshold', async () => {
    const { service, prisma } = createFixture({
      VK_PARSING_SOURCE_CIRCUIT_TERMINAL_FAILURE_THRESHOLD: 2,
    });
    const source = createSource({
      syncStatus: 'BACKOFF',
      consecutiveFailures: 1,
      terminalFailureCount: 1,
    });
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        error: { error_code: 15, error_msg: 'Access denied again' },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'source-1', syncLockedBy: expect.any(String) }),
        data: expect.objectContaining({
          syncStatus: 'ERROR',
          terminalFailureCount: 2,
          circuitOpenedAt: expect.any(Date),
          circuitReasonCode: 'vk_api.vk_15',
          circuitRetryAt: null,
        }),
      }),
    );
  });

  it('stops syncing without importing when the source lease is lost after fetch', async () => {
    const { service, prisma, publishQueue } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingSource.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValue({ count: 0 });
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [{ owner_id: -36819802, id: 101, date: 1_779_708_000, text: 'Пост' }],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    const imported = await service.processSyncSourceJob('source-1', 'scheduled');

    expect(imported).toBe(0);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.vkParsingSource.update).not.toHaveBeenCalled();
    expect(publishQueue.add).not.toHaveBeenCalled();
  });

  it('imports up to 100 posts through chunked bulk inserts', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    const posts = Array.from({ length: 100 }, (_, index) => ({
      owner_id: -36819802,
      id: index + 1,
      date: 1_779_708_000 - index,
      text: `Пост ${index + 1}`,
    }));
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValue([]);
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        createJsonFetchResponse({ response: { items: posts, groups: [] } }),
      ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    const firstUrl = String((global.fetch as jest.Mock).mock.calls[0]?.[0] ?? '');
    expect(firstUrl).toContain('count=100');
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 5_000,
      timeout: 15_000,
    });
  });

  it('classifies bulk import transaction timeouts as retryable DB sync errors', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValue([]);
    prisma.$executeRaw.mockRejectedValueOnce(
      Object.assign(new Error('Transaction API error: timeout'), { code: 'P2028' }),
    );
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [{ owner_id: -36819802, id: 101, date: 1_779_708_000, text: 'Пост' }],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    const imported = await service.processSyncSourceJob('source-1', 'scheduled');

    expect(imported).toBe(0);
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 5_000,
      timeout: 15_000,
    });
    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'source-1', syncLockedBy: expect.any(String) }),
        data: expect.objectContaining({
          syncStatus: 'BACKOFF',
          lastErrorCode: 'db.transaction_timeout',
          nextSyncAt: expect.any(Date),
        }),
      }),
    );
  });

  it('marks a published VK post as changed after VK edits its source content', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValue([
      {
        id: 'post-1',
        vkOwnerId: -36819802,
        vkPostId: 101,
        status: 'PUBLISHED',
        contentHash: 'old-hash',
        publishedContentHash: 'old-hash',
      },
    ]);
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [
            {
              owner_id: -36819802,
              id: 101,
              date: 1_779_708_000,
              text: 'VK изменил текст',
            },
          ],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(readExecuteRawValues(prisma)).toContain('CHANGED_AFTER_PUBLISH');
    expect(readExecuteRawSql(prisma)).toContain('"text_format" = CASE');
    expect(readExecuteRawSql(prisma)).toContain('ELSE EXCLUDED."text_format"');
    expect(readExecuteRawSql(prisma)).toContain('"manual_content_edited_at" IS NOT NULL');
    expect(readExecuteRawSql(prisma)).toContain(
      '"vk_parsing_posts"."content_hash" = EXCLUDED."content_hash"',
    );
    expect(readExecuteRawSql(prisma)).toContain('"manual_content_edited_at" = CASE');
  });

  it('only marks fetched-window missing VK posts unavailable after threshold and spot-check', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: 'missing-post-1',
        vkOwnerId: -36819802,
        vkPostId: 100,
        missingSeenCount: 2,
      },
    ]);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        createJsonFetchResponse({
          response: {
            items: [
              {
                owner_id: -36819802,
                id: 101,
                date: 1_779_708_000,
                text: 'Оставшийся пост',
              },
            ],
            groups: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        createJsonFetchResponse({
          response: { items: [] },
        }),
      ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(String((global.fetch as jest.Mock).mock.calls[1]?.[0] ?? '')).toContain('wall.getById');
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ['missing-post-1'] },
          ownerProfile: VkParsingOwnerProfile.PUBLISHER,
          ownerBotId: 'publisher-bot',
          status: { in: ['NEW', 'FAILED', 'CHANGED_AFTER_PUBLISH'] },
          publishLockedAt: null,
          AND: expect.any(Array),
        }),
        data: expect.objectContaining({
          status: 'UNAVAILABLE',
          missingSinceAt: expect.any(Date),
          unavailableAt: expect.any(Date),
          publishQueuedAt: null,
          publishLockedAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
        }),
      }),
    );
    expect(prisma.vkParsingPost.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 5_000,
      timeout: 15_000,
    });
  });

  it('bulk-resets found VK missing-post candidates and marks only confirmed missing posts unavailable', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: 'found-post-1',
        vkOwnerId: -36819802,
        vkPostId: 100,
        missingSeenCount: 2,
      },
      {
        id: 'missing-post-1',
        vkOwnerId: -36819802,
        vkPostId: 99,
        missingSeenCount: 2,
      },
    ]);
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(
        createJsonFetchResponse({
          response: {
            items: [
              {
                owner_id: -36819802,
                id: 101,
                date: 1_779_708_000,
                text: 'Оставшийся пост',
              },
            ],
            groups: [],
          },
        }),
      )
      .mockResolvedValueOnce(
        createJsonFetchResponse({
          response: {
            items: [
              {
                owner_id: -36819802,
                id: 100,
                date: 1_779_707_000,
                text: 'VK still has this post',
              },
            ],
          },
        }),
      ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: ['found-post-1'] },
          ownerProfile: VkParsingOwnerProfile.PUBLISHER,
          ownerBotId: 'publisher-bot',
          status: { in: ['NEW', 'FAILED', 'CHANGED_AFTER_PUBLISH'] },
        },
        data: expect.objectContaining({
          missingSeenCount: 0,
          missingSinceAt: null,
          lastAvailabilityCheckedAt: expect.any(Date),
        }),
      }),
    );
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ['missing-post-1'] },
          ownerProfile: VkParsingOwnerProfile.PUBLISHER,
          ownerBotId: 'publisher-bot',
          status: { in: ['NEW', 'FAILED', 'CHANGED_AFTER_PUBLISH'] },
          publishLockedAt: null,
          AND: expect.any(Array),
        }),
        data: expect.objectContaining({
          status: 'UNAVAILABLE',
          missingSeenCount: { increment: 1 },
          unavailableAt: expect.any(Date),
          publishQueuedAt: null,
          publishLockedAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
        }),
      }),
    );
    expect(prisma.vkParsingPost.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 5_000,
      timeout: 15_000,
    });
  });

  it('does not mark fetched-window missing VK posts unavailable before confirmation threshold', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    prisma.vkParsingSource.findUnique.mockResolvedValue(source);
    prisma.vkParsingPost.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {
        id: 'missing-post-1',
        vkOwnerId: -36819802,
        vkPostId: 100,
        missingSeenCount: 0,
      },
    ]);
    global.fetch = jest.fn().mockResolvedValue(
      createJsonFetchResponse({
        response: {
          items: [
            {
              owner_id: -36819802,
              id: 101,
              date: 1_779_708_000,
              text: 'Оставшийся пост',
            },
          ],
          groups: [],
        },
      }),
    ) as unknown as typeof fetch;

    await service.processSyncSourceJob('source-1', 'scheduled');

    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: ['missing-post-1'] },
          ownerProfile: VkParsingOwnerProfile.PUBLISHER,
          ownerBotId: 'publisher-bot',
          status: { in: ['NEW', 'FAILED', 'CHANGED_AFTER_PUBLISH'] },
        },
        data: expect.objectContaining({
          missingSeenCount: { increment: 1 },
          missingSinceAt: expect.any(Date),
          lastAvailabilityCheckedAt: expect.any(Date),
        }),
      }),
    );
    expect(prisma.vkParsingPost.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'UNAVAILABLE',
        }),
      }),
    );
  });

  it('queues an edited VK post with selected photos and links for Publisher', async () => {
    const { service, prisma, maxClient, publishQueue } = createFixture();
    const post = {
      id: 'post-1',
      sourceId: 'source-1',
      chatId: 'channel-1',
      ownerProfile: VkParsingOwnerProfile.PUBLISHER,
      ownerBotId: 'publisher-bot',
      vkOwnerId: -36819802,
      vkPostId: 101,
      vkPublishedAt: new Date('2026-05-25T10:00:00.000Z'),
      text: 'Продам авто',
      url: 'https://vk.ru/wall-36819802_101',
      photoUrls: ['https://sun1.example/large.jpg'],
      linkUrls: ['https://example.com/car'],
      attachments: [],
      raw: {},
      status: 'NEW',
      publishedMessageId: null,
      publishedUrl: null,
      publishedAtMax: null,
      lastError: null,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
      source: {
        id: 'source-1',
        chatId: 'channel-1',
        ownerProfile: VkParsingOwnerProfile.PUBLISHER,
        ownerBotId: 'publisher-bot',
        ownerId: 36819802,
        wallOwnerId: -36819802,
        screenName: 'avto_prodaja_rb',
        title: 'Авторынок Уфа',
        url: 'https://vk.ru/avto_prodaja_rb',
        status: 'ACTIVE',
        lastSyncAt: null,
        lastError: null,
        createdByUserId: '183470701',
        createdAt: new Date('2026-05-25T10:00:00.000Z'),
        updatedAt: new Date('2026-05-25T10:00:00.000Z'),
      },
    };
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.update.mockResolvedValue({
      ...post,
      status: 'PUBLISHED',
      publishedMessageId: 'mid-1',
      publishedUrl: 'https://max.ru/channels/channel-1/message/mid-1',
      publishedAtMax: new Date('2026-05-25T10:05:00.000Z'),
    });
    maxClient.uploadImage.mockResolvedValue({ token: 'image-token' });
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'mid-1',
      url: 'https://max.ru/channels/channel-1/message/mid-1',
    });

    const result = await service.publishPost(
      'channel-1',
      'post-1',
      { userId: '98315271' } as never,
      {
        text: 'Мой текст',
        photoUrls: ['https://sun1.example/large.jpg'],
        linkUrls: ['https://example.com/car'],
      },
    );

    expect(mediaFetch).not.toHaveBeenCalled();
    expect(maxClient.uploadImage).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(publishQueue.add).toHaveBeenCalledWith(
      'publish-vk-post',
      expect.objectContaining({
        kind: 'publish',
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: 'publisher-bot',
        postId: 'post-1',
      }),
      expect.any(Object),
    );
    expect(result).toMatchObject({ queued: 1 });
  });

  it('stores manually formatted VK text in the Publisher queue intent', async () => {
    const { service, prisma, maxClient, publishQueue } = createFixture();
    const post = createPostRow({ text: 'Текст из VK' });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'mid-rich',
      url: 'https://max.ru/channels/channel-1/message/mid-rich',
    });

    await service.publishPost('channel-1', 'post-1', { userId: '98315271' } as never, {
      text: '**Важное** и [подробности](https://example.com/news)',
      textFormat: 'markdown',
      photoUrls: [],
      videoUrls: [],
      linkUrls: [],
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          text: '**Важное** и [подробности](https://example.com/news)',
          textFormat: 'markdown',
          photoUrls: [],
          videoUrls: [],
          linkUrls: [],
          manualContentEditedAt: expect.any(Date),
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
          requiredBotId: 'publisher-bot',
        }),
      }),
    );
    expect(publishQueue.add).toHaveBeenCalledWith(
      'publish-vk-post',
      expect.objectContaining({
        kind: 'publish',
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: 'publisher-bot',
      }),
      expect.any(Object),
    );
  });

  it('replaces an old manual schedule with a new Publisher queue intent', async () => {
    const publish = jest.fn().mockResolvedValue({
      messageId: 'mid-manual-recovery',
      url: 'https://max.ru/channels/channel-1/message/mid-manual-recovery',
      botId: 'bot-1',
      candidateBotIds: ['bot-1'],
      routingVersion: 1,
    });
    const { service, prisma, maxRoutedPublicationService, publishQueue } = createFixture(
      {},
      { maxRoutedPublicationService: { publish } },
    );
    const post = createPostRow({
      text: 'Scheduled draft',
      publishQueuedAt: new Date('2026-05-25T09:00:00.000Z'),
      publishScheduledAt: new Date('2026-05-25T12:00:00.000Z'),
      publishIdempotencyKey: 'old-schedule-key',
      publishReason: 'manual-schedule',
    });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    await service.publishPost('channel-1', 'post-1', { userId: '98315271' } as never, {
      text: 'Publish now',
      textFormat: 'plain',
      photoUrls: [],
      videoUrls: [],
      linkUrls: [],
    });

    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          publishIdempotencyKey: expect.any(String),
          publishReason: 'manual-retry',
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
          requiredBotId: 'publisher-bot',
        }),
      }),
    );
    expect(publishQueue.add).toHaveBeenCalled();
    expect(maxRoutedPublicationService?.publish).not.toHaveBeenCalled();
  });

  it('atomically releases an unlocked autopublish intent before assigning a manual actor', async () => {
    const { service, prisma, publishQueue } = createFixture();
    const post = createPostRow({
      publishQueuedAt: new Date('2026-09-04T09:00:00.000Z'),
      publishScheduledAt: new Date('2026-09-04T12:00:00.000Z'),
      publishIdempotencyKey: 'old-autopublish-key',
      publishReason: 'autopublish',
      publishActorUserId: 'vk-parsing-autopost',
    });
    const oldJob = createQueueJob('delayed', {
      postId: post.id,
      chatId: post.chatId,
      reason: 'autopublish',
      idempotencyKey: 'old-autopublish-key',
    });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    publishQueue.getJob.mockResolvedValueOnce(null).mockResolvedValueOnce(oldJob);
    let activeKey: string | null = post.publishIdempotencyKey;
    let actorUserId: string | null = post.publishActorUserId;
    prisma.vkParsingPost.updateMany.mockImplementation(
      async ({ data }: { data: Record<string, unknown> }) => {
        if (
          activeKey !== null &&
          Object.hasOwn(data, 'publishActorUserId') &&
          data.publishActorUserId !== actorUserId
        ) {
          throw Object.assign(new Error('active VK publish intent route is immutable'), {
            code: 'P2039',
          });
        }
        if (data.publishIdempotencyKey === null) {
          activeKey = null;
        } else if (typeof data.publishIdempotencyKey === 'string') {
          activeKey = data.publishIdempotencyKey;
        }
        if (Object.hasOwn(data, 'publishActorUserId')) {
          actorUserId = (data.publishActorUserId as string | null) ?? null;
        }
        return { count: 1 };
      },
    );

    await expect(
      service.publishPost('channel-1', 'post-1', { userId: '98315271' } as never, {
        text: 'Publish now',
        textFormat: 'plain',
        photoUrls: [],
        videoUrls: [],
        linkUrls: [],
      }),
    ).resolves.toMatchObject({ queued: 1 });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.vkParsingPost.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          publishIdempotencyKey: 'old-autopublish-key',
          publishReason: 'autopublish',
          publishActorUserId: 'vk-parsing-autopost',
          publishLockedAt: null,
          publishedMessageId: null,
        }),
        data: expect.objectContaining({
          publishQueuedAt: null,
          publishScheduledAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
        }),
      }),
    );
    expect(prisma.vkParsingPost.updateMany.mock.calls[0]?.[0]?.data).not.toHaveProperty(
      'publishActorUserId',
    );
    expect(prisma.vkParsingPost.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          publishIdempotencyKey: expect.stringMatching(/^[a-f0-9]{32}$/u),
          publishReason: 'manual-retry',
          publishActorUserId: '98315271',
        }),
      }),
    );
    expect(publishQueue.add).toHaveBeenCalledWith(
      'publish-vk-post',
      expect.objectContaining({
        postId: 'post-1',
        reason: 'manual-retry',
        idempotencyKey: activeKey,
      }),
      expect.objectContaining({ jobId: `vk-parsing-publish__post-1__${activeKey}` }),
    );
    expect(oldJob.remove).toHaveBeenCalledTimes(1);
  });

  it('keeps a committed manual publish intent accepted when BullMQ add fails', async () => {
    const { service, prisma, publishQueue } = createFixture();
    prisma.vkParsingPost.findFirst.mockResolvedValue(createPostRow());
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    publishQueue.add.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(
      service.publishPost('channel-1', 'post-1', { userId: '98315271' } as never, {
        text: 'Publish once',
        textFormat: 'plain',
        photoUrls: [],
        videoUrls: [],
        linkUrls: [],
      }),
    ).resolves.toMatchObject({ queued: 1 });

    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          publishQueuedAt: expect.any(Date),
          publishIdempotencyKey: expect.stringMatching(/^[a-f0-9]{32}$/u),
          publishReason: 'manual-retry',
          publishActorUserId: '98315271',
        }),
      }),
    );
    expect(publishQueue.add).toHaveBeenCalledTimes(1);
  });

  it('does not enqueue a manual Publisher intent when its persistence CAS loses', async () => {
    const { service, prisma, maxClient, publishQueue } = createFixture();
    const post = createPostRow();
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.publishPost('channel-1', 'post-1', { userId: '98315271' } as never, {
        text: 'Publish once',
        textFormat: 'plain',
        photoUrls: [],
        videoUrls: [],
        linkUrls: [],
      }),
    ).resolves.toMatchObject({ queued: 0 });

    expect(publishQueue.add).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('queues user-added markdown when the original link-only text is stripped', async () => {
    const { service, prisma, maxClient, publishQueue } = createFixture();
    const sourceUrl = 'https://example.com/original';
    const post = createPostRow({
      text: sourceUrl,
      linkUrls: [sourceUrl],
    });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      chatId: 'channel-1',
      stripLinksEnabled: true,
    });
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'mid-edited-link-only',
      url: 'https://max.ru/channels/channel-1/message/mid-edited-link-only',
    });

    await service.publishPost('channel-1', 'post-1', { userId: '98315271' } as never, {
      text: '**Новый текст**',
      textFormat: 'markdown',
      photoUrls: [],
      videoUrls: [],
      linkUrls: [],
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(publishQueue.add).toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ text: '**Новый текст**', textFormat: 'markdown' }),
      }),
    );
    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SKIPPED' }),
      }),
    );
  });

  it('stores a formatted manual draft before Publisher queue handoff', async () => {
    const { service, prisma, maxClient, publishQueue } = createFixture();
    const post = createPostRow({
      text: 'Исходный текст',
      linkUrls: ['https://example.com/catalog'],
    });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    maxClient.sendMessageImmediateWithResolvedLink.mockRejectedValue(
      new Error('MAX API temporary network failure'),
    );

    await expect(
      service.publishPost('channel-1', 'post-1', { userId: '98315271' } as never, {
        text: '**Новый текст**',
        textFormat: 'markdown',
        photoUrls: [],
        videoUrls: [],
        linkUrls: ['https://example.com/catalog'],
      }),
    ).resolves.toMatchObject({ queued: 1 });

    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          text: '**Новый текст**',
          textFormat: 'markdown',
          linkUrls: ['https://example.com/catalog'],
          manualContentEditedAt: expect.any(Date),
          requiredBotId: 'publisher-bot',
        }),
      }),
    );
    expect(publishQueue.add).toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('queues a formatted manual draft without a Major channel-link lookup', async () => {
    const { service, prisma, maxClient, publishQueue } = createFixture();
    const post = createPostRow({
      text: 'Исходный текст',
      publishQueuedAt: new Date('2026-05-25T10:00:00.000Z'),
      publishScheduledAt: new Date('2026-05-25T11:00:00.000Z'),
      publishIdempotencyKey: 'scheduled-key',
      publishReason: 'manual-schedule',
    });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      chatId: 'channel-1',
      appendChannelLinkEnabled: true,
      channelLinkText: 'Наш канал',
    });
    prisma.managedBotChatCatalog.findFirst.mockResolvedValue(null);
    maxClient.getChatSnapshot.mockRejectedValue(new Error('MAX lookup timeout'));

    await expect(
      service.publishPost('channel-1', 'post-1', { userId: '98315271' } as never, {
        text: '**Сохранённый текст**',
        textFormat: 'markdown',
        photoUrls: [],
        videoUrls: [],
        linkUrls: [],
      }),
    ).resolves.toMatchObject({ queued: 1 });

    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          text: '**Сохранённый текст**',
          textFormat: 'markdown',
          manualContentEditedAt: expect.any(Date),
          requiredBotId: 'publisher-bot',
        }),
      }),
    );
    expect(publishQueue.add).toHaveBeenCalled();
    expect(maxClient.getChatSnapshot).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('defers custom channel-link rendering to the Publisher worker', async () => {
    const { service, prisma, maxClient, publishQueue } = createFixture();
    const post = createPostRow({ text: 'Текст из VK' });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      chatId: 'channel-1',
      appendChannelLinkEnabled: true,
      channelLinkText: 'Читать наш канал',
    });
    prisma.managedBotChatCatalog.findFirst.mockResolvedValue({
      link: 'http://www.max.ru/our-channel#latest',
    });
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'mid-channel-link',
      url: 'https://max.ru/channels/channel-1/message/mid-channel-link',
    });

    await service.publishPost('channel-1', 'post-1', { userId: '98315271' } as never, {
      text: '<b>Не HTML</b> & текст',
      textFormat: 'plain',
      photoUrls: [],
      videoUrls: [],
      linkUrls: [],
    });

    expect(publishQueue.add).toHaveBeenCalled();
    expect(prisma.managedBotChatCatalog.findFirst).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('does not consult Major audience snapshots during Publisher queue handoff', async () => {
    const { service, prisma, maxClient, publishQueue } = createFixture();
    const post = createPostRow({ text: 'Текст из VK' });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      chatId: 'channel-1',
      appendChannelLinkEnabled: true,
      channelLinkText: 'Вступить в канал',
    });
    prisma.channelAudienceSnapshot.findFirst.mockResolvedValue({
      link: 'http://www.max.ru/join/channel-invite#latest',
    });
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'mid-cached-channel-link',
      url: 'https://max.ru/channel-name/post-id',
    });

    await service.publishPost('channel-1', 'post-1', { userId: '98315271' } as never, {
      text: 'Текст из VK',
      textFormat: 'plain',
      photoUrls: [],
      videoUrls: [],
      linkUrls: [],
    });

    expect(prisma.channelAudienceSnapshot.findFirst).not.toHaveBeenCalled();
    expect(prisma.managedBotChatCatalog.findFirst).not.toHaveBeenCalled();
    expect(maxClient.getChatSnapshot).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(publishQueue.add).toHaveBeenCalled();
  });

  it('adds the original source after filtering and counts its final HTML', async () => {
    const { publishService } = createFixture();
    const prepare = (
      publishService as unknown as {
        prepareMaxMessageText: (
          chatId: string,
          payload: { text: string; textFormat: 'plain'; linkUrls: string[] },
          settings: {
            appendChannelLinkEnabled: boolean;
            channelLinkText: string;
            sourceLinkEnabled: boolean;
            sourceLinkUrl: string;
          },
          trafficClass: 'background',
          botId: string,
          postUrl: string,
        ) => Promise<{ text: string; textFormat: string; engagementText: string }>;
      }
    ).prepareMaxMessageText.bind(publishService);
    const settings = {
      appendChannelLinkEnabled: false,
      channelLinkText: '',
      sourceLinkEnabled: true,
      sourceLinkUrl: '',
    };
    const message = await prepare(
      'channel-1',
      { text: 'Текст & <пример>', textFormat: 'plain', linkUrls: [] },
      settings,
      'background',
      'publisher-bot',
      'https://vk.com/wall-1_2',
    );
    expect(message).toEqual({
      text: 'Текст &amp; &lt;пример&gt;\n\n<a href="https://vk.com/wall-1_2">Источник</a>',
      textFormat: 'html',
      engagementText: 'Текст & <пример>\n\n[Источник](https://vk.com/wall-1_2)',
    });
    await expect(
      prepare(
        'channel-1',
        { text: 'x'.repeat(4000), textFormat: 'plain', linkUrls: [] },
        settings,
        'background',
        'publisher-bot',
        'https://vk.com/wall-1_2',
      ),
    ).rejects.toThrow('Текст вместе со ссылкой слишком длинный');
  });

  it('enforces the final MAX HTML limit after adding the channel link', async () => {
    const { publishService, prisma } = createFixture();
    const signature = '<a href="https://max.ru/our-channel">Наш канал</a>';
    const exactText = 'x'.repeat(
      VK_PARSING_MAX_PUBLISH_TEXT_LENGTH - '\n\n'.length - signature.length,
    );
    prisma.managedBotChatCatalog.findFirst.mockResolvedValue({
      link: 'https://max.ru/our-channel',
    });

    const prepared = await (publishService as any).prepareMaxMessageText(
      'channel-1',
      { text: exactText, textFormat: 'plain', photoUrls: [], videoUrls: [], linkUrls: [] },
      { appendChannelLinkEnabled: true, channelLinkText: 'Наш канал' },
      'background',
      'publisher-bot',
    );

    expect(prepared.text).toHaveLength(VK_PARSING_MAX_PUBLISH_TEXT_LENGTH);

    await expect(
      (publishService as any).prepareMaxMessageText(
        'channel-1',
        { text: `${exactText}x`, textFormat: 'plain', photoUrls: [], videoUrls: [], linkUrls: [] },
        { appendChannelLinkEnabled: true, channelLinkText: 'Наш канал' },
        'background',
        'publisher-bot',
      ),
    ).rejects.toThrow('Текст вместе со ссылкой слишком длинный');
  });

  it('combines formatted VK text with the channel link in safe MAX HTML', async () => {
    const { publishService, prisma } = createFixture();
    prisma.managedBotChatCatalog.findFirst.mockResolvedValue({
      link: 'https://max.ru/our-channel',
    });
    await expect(
      (publishService as any).prepareMaxMessageText(
        'channel-1',
        { text: '**Важное**', textFormat: 'markdown', photoUrls: [], videoUrls: [], linkUrls: [] },
        { appendChannelLinkEnabled: true, channelLinkText: 'Наш канал' },
        'background',
        'publisher-bot',
      ),
    ).resolves.toMatchObject({
      text: '<strong>Важное</strong>\n\n<a href="https://max.ru/our-channel">Наш канал</a>',
      textFormat: 'html',
    });
  });

  it('renders selected URLs after markdown without interpreting URL punctuation', async () => {
    const { publishService } = createFixture();
    const selectedUrl = 'https://example.com/a_b_c';

    await expect(
      (publishService as any).prepareMaxMessageText(
        'channel-1',
        {
          text: '**Смотрите**',
          textFormat: 'markdown',
          photoUrls: [],
          videoUrls: [],
          linkUrls: [selectedUrl],
        },
        { appendChannelLinkEnabled: false, channelLinkText: '' },
        'background',
        'publisher-bot',
      ),
    ).resolves.toMatchObject({
      text: `<strong>Смотрите</strong>\n<a href="${selectedUrl}">${selectedUrl}</a>`,
      textFormat: 'html',
    });
  });

  it('does not append a selected URL already present as Markdown-escaped text', async () => {
    const { publishService } = createFixture();
    const selectedUrl = 'https://example.com/a_b';

    await expect(
      (publishService as any).prepareMaxMessageText(
        'channel-1',
        {
          text: 'Смотрите https://example.com/a\\_b',
          textFormat: 'markdown',
          photoUrls: [],
          videoUrls: [],
          linkUrls: [selectedUrl],
        },
        { appendChannelLinkEnabled: false, channelLinkText: '' },
        'background',
        'publisher-bot',
      ),
    ).resolves.toMatchObject({ text: 'Смотрите https://example.com/a_b', textFormat: 'html' });
  });

  it('queues chat VK posts through Publisher without Major engagement buttons', async () => {
    const { service, prisma, adminService, maxClient, publishQueue } = createFixture();
    const source = createSource({ chatId: 'chat-1' });
    const post = createPostRow({
      chatId: 'chat-1',
      source,
      text: 'Пост для чата',
    });
    prisma.chat.findUnique.mockResolvedValue({ entityType: ChatEntityType.CHAT });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.update.mockResolvedValue({
      ...post,
      status: 'PUBLISHED',
      publishedMessageId: 'mid-chat-1',
      publishedUrl: 'https://max.ru/chats/chat-1/message/mid-chat-1',
      publishedAtMax: new Date('2026-05-25T10:05:00.000Z'),
    });
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'mid-chat-1',
      url: 'https://max.ru/chats/chat-1/message/mid-chat-1',
    });

    const result = await service.publishPost(
      'chat-1',
      'post-1',
      { userId: 'chat-admin' } as never,
      {
        text: 'Публикуем в чат',
        photoUrls: [],
        linkUrls: [],
      },
    );

    expect(adminService.assertChatAdmin).toHaveBeenCalledWith('chat-1', 'chat-admin', 'chat');
    expect(adminService.buildChannelPublicationEngagementContext).not.toHaveBeenCalled();
    expect(adminService.recordChannelPublicationEngagement).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(publishQueue.add).toHaveBeenCalledWith(
      'publish-vk-post',
      expect.objectContaining({
        kind: 'publish',
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: 'publisher-bot',
      }),
      expect.any(Object),
    );
    expect(result).toMatchObject({ queued: 1 });
  });

  it('returns a queued result before the Publisher worker observes later row races', async () => {
    const { service, prisma, maxClient, publishQueue } = createFixture();
    const source = createSource();
    const post = createPostRow({ source, text: 'Пост после stale-row гонки' });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'mid-stale',
      url: 'https://max.ru/channels/channel-1/message/mid-stale',
    });

    const result = await service.publishPost(
      'channel-1',
      'post-1',
      { userId: '98315271' } as never,
      {
        text: 'Пост после stale-row гонки',
        photoUrls: [],
        linkUrls: [],
      },
    );

    expect(result).toMatchObject({ queued: 1 });
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(publishQueue.add).toHaveBeenCalled();
  });

  it('does not publish the same VK post twice', async () => {
    const { service, prisma, maxClient } = createFixture();
    const post = {
      id: 'post-1',
      sourceId: 'source-1',
      chatId: 'channel-1',
      vkOwnerId: -36819802,
      vkPostId: 101,
      vkPublishedAt: new Date('2026-05-25T10:00:00.000Z'),
      text: 'Продам авто',
      url: 'https://vk.ru/wall-36819802_101',
      photoUrls: [],
      linkUrls: [],
      attachments: [],
      raw: {},
      contentHash: 'published-hash',
      publishedContentHash: 'published-hash',
      status: 'PUBLISHED',
      publishedMessageId: 'mid-1',
      publishedUrl: 'https://max.ru/channels/channel-1/message/mid-1',
      publishedAtMax: new Date('2026-05-25T10:05:00.000Z'),
      lastSeenAt: new Date('2026-05-25T10:00:00.000Z'),
      missingSinceAt: null,
      unavailableAt: null,
      lastError: null,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
      source: createSource(),
    };
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);

    await expect(
      service.publishPost('channel-1', 'post-1', { userId: '98315271' } as never, {
        text: 'Повтор',
        photoUrls: [],
        linkUrls: [],
      }),
    ).rejects.toThrow('уже опубликован');
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('does not enqueue a manual VK post when the Publisher intent CAS loses', async () => {
    const { service, prisma, maxClient, publishQueue } = createFixture();
    const source = createSource();
    const post = createPostRow({ source, text: 'Уже публикуется' });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.publishPost('channel-1', 'post-1', { userId: '98315271' } as never, {
        text: 'Уже публикуется',
        photoUrls: [],
        linkUrls: [],
      }),
    ).resolves.toMatchObject({ queued: 0 });

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(publishQueue.add).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.update).not.toHaveBeenCalled();
  });

  it('blocks every manual VK resend path after an ambiguous MAX send timeout', async () => {
    const { publishService, prisma, maxClient, publishQueue } = createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      status: 'FAILED',
      lastError: '[max.send_ambiguous] request timed out. Delivery may have been accepted by MAX.',
    });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);

    const actions = [
      () =>
        publishService.publishPost('channel-1', 'post-1', '98315271', {
          text: 'Повтор',
          photoUrls: [],
          linkUrls: [],
        }),
      () => publishService.retryPost('channel-1', 'post-1'),
      () =>
        publishService.schedulePost('channel-1', 'post-1', '2026-05-25T11:00:00.000Z', '98315271'),
      () => publishService.publishPostNow('channel-1', 'post-1', '98315271'),
    ];

    for (const action of actions) {
      await expect(action()).rejects.toThrow('MAX мог уже принять эту публикацию');
    }

    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
    expect(publishQueue.add).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('keeps review-mode VK sources out of ordinary manual publish actions', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource({ publishMode: 'REVIEW' });
    const post = createPostRow({ source, text: 'Только через Safety Desk' });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);

    await expect(
      service.publishPost('channel-1', 'post-1', { userId: '98315271' } as never, {
        text: 'Только через Safety Desk',
        photoUrls: [],
        linkUrls: [],
      }),
    ).rejects.toThrow('Safety Desk');

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
  });

  it('saves review-mode VK post edits without publishing to MAX', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource({ publishMode: 'REVIEW' });
    const post = createPostRow({
      source,
      text: 'Черновик до правки',
      videoUrls: ['https://vkvd.example/video-720.mp4'],
      linkUrls: ['https://example.com/source'],
      status: 'FAILED',
      lastError: 'Предыдущая попытка остановлена.',
    });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });

    await service.updateReviewPostDraft('channel-1', 'post-1', { userId: '98315271' } as never, {
      text: '**Черновик после правки**',
      textFormat: 'markdown',
      photoUrls: [],
      linkUrls: ['https://example.com/source'],
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'post-1',
        chatId: 'channel-1',
        updatedAt: new Date('2026-05-25T10:00:00.000Z'),
        publishCancelledAt: null,
        publishLockedAt: null,
        source: {
          ownerProfile: VkParsingOwnerProfile.PUBLISHER,
          ownerBotId: 'publisher-bot',
          publishMode: 'REVIEW',
        },
      }),
      data: expect.objectContaining({
        status: 'NEW',
        text: '**Черновик после правки**',
        textFormat: 'markdown',
        manualContentEditedAt: expect.any(Date),
        photoUrls: [],
        videoUrls: [],
        linkUrls: ['https://example.com/source'],
        publishQueuedAt: null,
        publishLockedAt: null,
        lastError: null,
      }),
    });
  });

  it('does not clear an ambiguous Safety Desk send marker when saving a review draft', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource({ publishMode: 'REVIEW' });
    const post = createPostRow({
      source,
      text: 'Черновик до правки',
      status: 'FAILED',
      lastError: '[max.send_ambiguous] request timed out. Delivery may have been accepted by MAX.',
    });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);

    await expect(
      service.updateReviewPostDraft('channel-1', 'post-1', { userId: '98315271' } as never, {
        text: 'Черновик после правки',
        photoUrls: [],
        linkUrls: [],
      }),
    ).rejects.toThrow('MAX мог уже принять эту публикацию');

    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('blocks review draft edits while a Publisher rollback is active', async () => {
    const { service, prisma, maxClient } = createFixture();
    const post = createPostRow({
      source: createSource({ publishMode: 'REVIEW' }),
      rollbackLockedAt: new Date('2026-09-04T12:00:00.000Z'),
      rollbackIdempotencyKey: 'active-rollback-key',
    });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);

    await expect(
      service.updateReviewPostDraft('channel-1', 'post-1', { userId: '98315271' } as never, {
        text: 'Черновик во время удаления',
        photoUrls: [],
        linkUrls: [],
      }),
    ).rejects.toThrow('Удаление предыдущей публикации ещё выполняется');

    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('does not clear review-mode VK publish metadata when the draft changed concurrently', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource({ publishMode: 'REVIEW' });
    const post = createPostRow({
      source,
      text: 'Черновик до правки',
      publishLockedAt: null,
      publishIdempotencyKey: 'review-job',
      publishQueuedAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.updateReviewPostDraft('channel-1', 'post-1', { userId: '98315271' } as never, {
        text: 'Черновик после правки',
        photoUrls: [],
        linkUrls: [],
      }),
    ).rejects.toThrow('уже обработан или недоступен');

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'post-1',
        chatId: 'channel-1',
        updatedAt: new Date('2026-05-25T10:00:00.000Z'),
        publishLockedAt: null,
        publishCancelledAt: null,
      }),
      data: expect.objectContaining({
        publishIdempotencyKey: null,
      }),
    });
  });

  it('does not cancel a VK schedule after the queued publish state changed', async () => {
    const { service, prisma } = createFixture();
    const source = createSource();
    const scheduledAt = new Date('2026-05-25T10:30:00.000Z');
    const post = createPostRow({
      source,
      publishScheduledAt: scheduledAt,
      publishIdempotencyKey: 'schedule-key-1',
      publishReason: 'manual-schedule',
    });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.cancelScheduledPost('channel-1', 'post-1', { userId: '98315271' } as never),
    ).rejects.toThrow('уже нельзя отменить');

    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'post-1',
        chatId: 'channel-1',
        publishScheduledAt: scheduledAt,
        publishIdempotencyKey: 'schedule-key-1',
        publishCancelledAt: null,
        publishLockedAt: null,
      }),
      data: expect.any(Object),
    });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('replaces an autopublish intent with a manual-schedule intent when rescheduled', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-25T10:00:00.000Z'));
    try {
      const { publishService, prisma, publishQueue } = createFixture();
      const scheduledAt = new Date('2026-05-25T11:00:00.000Z');
      const post = createPostRow({
        publishQueuedAt: new Date('2026-05-25T09:55:00.000Z'),
        publishScheduledAt: new Date('2026-05-25T10:30:00.000Z'),
        publishIdempotencyKey: 'old-autopublish-key',
        publishReason: 'autopublish',
      });
      prisma.vkParsingPost.findFirst.mockResolvedValue(post);
      prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });

      await expect(
        publishService.schedulePost('channel-1', 'post-1', scheduledAt.toISOString(), '98315271'),
      ).resolves.toMatchObject({ queued: 1 });

      expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'post-1',
            publishLockedAt: null,
          }),
          data: expect.objectContaining({
            publishScheduledAt: scheduledAt,
            publishReason: 'manual-schedule',
          }),
        }),
      );
      const queuedKey = prisma.vkParsingPost.updateMany.mock.calls.at(-1)?.[0]?.data
        .publishIdempotencyKey as string;
      expect(queuedKey).toMatch(/^[a-f0-9]{32}$/u);
      expect(queuedKey).not.toBe('old-autopublish-key');
      expect(publishQueue.add).toHaveBeenCalledWith(
        'publish-vk-post',
        expect.objectContaining({
          postId: 'post-1',
          reason: 'manual-schedule',
          idempotencyKey: queuedKey,
        }),
        expect.objectContaining({
          jobId: `vk-parsing-publish__post-1__${queuedKey}`,
          delay: 60 * 60_000,
        }),
      );
      expect(prisma.vkParsingPost.count).not.toHaveBeenCalled();
      expect(prisma.vkParsingSource.updateMany).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('recovers an armed review-mode manual send through its original ledger key', async () => {
    const publish = jest.fn().mockImplementation(async (request: any) => {
      const prepared = await request.prepareAttempt({ botId: 'publisher-bot', job: {} });
      request.onDispatchAttempt({
        botId: 'publisher-bot',
        job: { options: prepared.options },
      });
      return {
        messageId: 'mid-review-recovery',
        url: 'https://max.ru/channels/channel-1/message/mid-review-recovery',
        botId: 'publisher-bot',
        candidateBotIds: ['publisher-bot'],
        routingVersion: 1,
      };
    });
    const { service, prisma, adminService } = createFixture(
      {},
      { maxRoutedPublicationService: { publish } },
    );
    const source = createSource({ publishMode: 'REVIEW' });
    const post = createPostRow({
      source,
      publishIdempotencyKey: 'review-manual-key',
      publishQueuedAt: new Date('2026-05-25T10:00:00.000Z'),
      publishReason: 'manual-retry',
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);

    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'manual-retry',
      idempotencyKey: 'review-manual-key',
    });

    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({
        logicalIdempotencyKey: 'vk-parsing:publish:post-1:review-manual-key',
        trafficClass: 'background',
      }),
    );
    expect(prisma.vkParsingSource.updateMany).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'PUBLISHED',
          autoPublishedAt: null,
        }),
      }),
    );
    expect(adminService.recordChannelPublicationEngagement).not.toHaveBeenCalled();
  });

  it('clears stale autopublish jobs for review-mode VK sources without publishing', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource({ publishMode: 'REVIEW' });
    const post = createPostRow({
      source,
      publishIdempotencyKey: 'review-job',
      ...createFreshQueuedPublishTimes(),
      publishReason: 'autopublish',
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);

    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'autopublish',
      idempotencyKey: 'review-job',
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'post-1',
        publishIdempotencyKey: 'review-job',
        publishReason: 'autopublish',
        publishLockedAt: post.publishLockedAt,
        publishAttemptCount: post.publishAttemptCount,
        publishScheduledAt: post.publishScheduledAt,
        lastError: post.lastError,
        status: post.status,
      },
      data: {
        publishQueuedAt: null,
        publishScheduledAt: null,
        publishLockedAt: null,
        publishIdempotencyKey: null,
        publishReason: null,
        publishScheduleFingerprint: null,
      },
    });
  });

  it('uses cached media preflight failures with a photo-specific publish error', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      text: 'Продам авто',
      photoUrls: ['https://sun1.example/missing.jpg'],
      linkUrls: [],
      ...createFreshQueuedPublishTimes(),
      publishIdempotencyKey: 'manual-media-key',
      publishReason: 'manual-retry',
    });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingMediaCache.findUnique.mockResolvedValue({
      id: 'media-1',
      url: 'https://sun1.example/missing.jpg',
      status: 'FAILED',
      mimeType: null,
      contentLength: null,
      lastCheckedAt: new Date(),
      lastError: 'Фото недоступно в VK.',
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });

    await expect(
      service.processPublishPostJob({
        postId: 'post-1',
        chatId: 'channel-1',
        reason: 'manual-retry',
        idempotencyKey: 'manual-media-key',
      }),
    ).rejects.toThrow('Фото 1');
    expect(mediaFetch).not.toHaveBeenCalled();
    expect(maxClient.uploadImage).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'post-1' }),
        data: expect.objectContaining({
          status: 'FAILED',
          lastError: expect.stringContaining('Фото 1'),
        }),
      }),
    );
  });

  it('rechecks expired failed media preflight cache before publishing', async () => {
    const { service, prisma, maxClient } = createFixture({
      VK_PARSING_MEDIA_FAILED_PREFLIGHT_TTL_MS: 1_000,
    });
    const source = createSource();
    const post = createPostRow({
      source,
      photoUrls: ['https://sun1.example/large.jpg'],
      ...createFreshQueuedPublishTimes(),
      publishIdempotencyKey: 'expired-media-key',
      publishReason: 'manual-retry',
    });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.update.mockResolvedValue({
      ...post,
      status: 'PUBLISHED',
      publishedMessageId: 'mid-1',
      publishedUrl: 'https://max.ru/channels/channel-1/message/mid-1',
      publishedAtMax: new Date('2026-05-25T10:05:00.000Z'),
    });
    prisma.vkParsingMediaCache.findUnique.mockResolvedValue({
      id: 'media-1',
      url: 'https://sun1.example/large.jpg',
      status: 'FAILED',
      mimeType: null,
      contentLength: null,
      lastCheckedAt: new Date(Date.now() - 60_000),
      lastError: 'VK вернул статус 404 для фото.',
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    maxClient.uploadImage.mockResolvedValue({ token: 'image-token' });
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'mid-1',
      url: 'https://max.ru/channels/channel-1/message/mid-1',
    });
    mediaFetch
      .mockResolvedValueOnce(
        new Response(null, {
          status: 200,
          headers: { 'content-type': 'image/jpeg', 'content-length': '3' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'image/jpeg', 'content-length': '3' },
        }),
      );

    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'manual-retry',
      idempotencyKey: 'expired-media-key',
    });

    expect(maxClient.uploadImage).toHaveBeenCalledWith(
      Buffer.from([1, 2, 3]),
      'large.jpg',
      'image/jpeg',
      {
        botId: 'publisher-bot',
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
      },
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalled();
  });

  it('merges media cache rows by URL and VK media identity under advisory lock', async () => {
    const { mediaCache, prisma } = createFixture();
    const urlRow = {
      id: 'media-url',
      url: 'https://sun1.example/large.jpg',
      mediaIdentity: null,
      status: 'READY',
      mimeType: 'image/jpeg',
      contentLength: 3,
      maxUploadPayload: { token: 'cached-token' },
      maxUploadToken: 'cached-token',
      maxUploadedAt: new Date('2026-05-25T10:00:00.000Z'),
      uploadAttemptCount: 1,
      lastCheckedAt: new Date('2026-05-25T10:00:00.000Z'),
      lastError: null,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    };
    const identityRow = {
      ...urlRow,
      id: 'media-identity',
      url: 'https://sun1.example/old.jpg',
      mediaIdentity: 'photo:-36819802_11',
      maxUploadPayload: null,
      maxUploadToken: null,
      maxUploadedAt: null,
    };
    prisma.vkParsingMediaCache.findMany.mockResolvedValue([identityRow, urlRow]);

    await mediaCache.writeMediaCache(
      'https://sun1.example/large.jpg',
      { status: 'READY', mimeType: 'image/jpeg', contentLength: 3 },
      'photo:-36819802_11',
    );

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(2);
    expect(prisma.vkParsingMediaCache.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['media-identity'] } },
    });
    expect(prisma.vkParsingMediaCache.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'media-url' },
        data: expect.objectContaining({
          url: 'https://sun1.example/large.jpg',
          mediaIdentity: 'photo:-36819802_11',
          status: 'READY',
        }),
      }),
    );
  });

  it('retries media cache writes after unique conflicts', async () => {
    const { mediaCache, prisma } = createFixture();
    prisma.vkParsingMediaCache.upsert
      .mockRejectedValueOnce(
        Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
      )
      .mockResolvedValueOnce({
        id: 'media-1',
        url: 'https://sun1.example/large.jpg',
        mediaIdentity: null,
        status: 'READY',
        mimeType: 'image/jpeg',
        contentLength: 3,
        maxUploadPayload: null,
        maxUploadToken: null,
        maxUploadedAt: null,
        uploadAttemptCount: 0,
        lastCheckedAt: new Date(),
        lastError: null,
        createdAt: new Date('2026-05-25T10:00:00.000Z'),
        updatedAt: new Date('2026-05-25T10:00:00.000Z'),
      });

    await mediaCache.writeMediaCache('https://sun1.example/large.jpg', {
      status: 'READY',
      mimeType: 'image/jpeg',
      contentLength: 3,
    });

    expect(prisma.vkParsingMediaCache.upsert).toHaveBeenCalledTimes(2);
  });

  it('retries media identity cache merges after concurrent unique conflicts', async () => {
    const { mediaCache, prisma } = createFixture();
    const urlRow = {
      id: 'media-url',
      url: 'https://sun1.example/large.jpg',
      mediaIdentity: null,
      status: 'READY',
      mimeType: 'image/jpeg',
      contentLength: 3,
      maxUploadPayload: { token: 'cached-token' },
      maxUploadToken: 'cached-token',
      maxUploadedAt: new Date('2026-05-25T10:00:00.000Z'),
      uploadAttemptCount: 1,
      lastCheckedAt: new Date('2026-05-25T10:00:00.000Z'),
      lastError: null,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    };
    const identityRow = {
      ...urlRow,
      id: 'media-identity',
      url: 'https://sun1.example/old.jpg',
      mediaIdentity: 'photo:-36819802_11',
      maxUploadPayload: null,
      maxUploadToken: null,
      maxUploadedAt: null,
    };
    prisma.vkParsingMediaCache.findMany
      .mockResolvedValueOnce([urlRow])
      .mockResolvedValueOnce([identityRow, urlRow]);
    prisma.vkParsingMediaCache.update
      .mockRejectedValueOnce(
        Object.assign(new Error('Unique constraint failed on media_identity'), {
          code: 'P2002',
        }),
      )
      .mockResolvedValueOnce({
        ...urlRow,
        mediaIdentity: 'photo:-36819802_11',
      });

    await mediaCache.writeMediaCache(
      'https://sun1.example/large.jpg',
      { status: 'READY', mimeType: 'image/jpeg', contentLength: 3 },
      'photo:-36819802_11',
    );

    expect(prisma.vkParsingMediaCache.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.vkParsingMediaCache.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ['media-identity'] } },
    });
    expect(prisma.vkParsingMediaCache.update).toHaveBeenCalledTimes(2);
  });

  it('falls back to a ranged GET when media preflight HEAD is blocked', async () => {
    const { service, prisma, maxClient } = createFixture();
    const source = createSource();
    const post = createPostRow({
      source,
      text: 'Продам авто',
      photoUrls: ['https://sun1.example/large.jpg'],
      linkUrls: [],
      ...createFreshQueuedPublishTimes(),
      publishIdempotencyKey: 'ranged-media-key',
      publishReason: 'manual-retry',
    });
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.update.mockResolvedValue({
      ...post,
      status: 'PUBLISHED',
      publishedMessageId: 'mid-1',
      publishedUrl: 'https://max.ru/channels/channel-1/message/mid-1',
      publishedAtMax: new Date('2026-05-25T10:05:00.000Z'),
    });
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    maxClient.uploadImage.mockResolvedValue({ token: 'image-token' });
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'mid-1',
      url: 'https://max.ru/channels/channel-1/message/mid-1',
    });
    mediaFetch
      .mockResolvedValueOnce(new Response(null, { status: 405 }))
      .mockResolvedValueOnce(
        new Response(null, {
          status: 206,
          headers: { 'content-type': 'image/jpeg', 'content-range': 'bytes 0-0/3' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'image/jpeg', 'content-length': '3' },
        }),
      );

    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'manual-retry',
      idempotencyKey: 'ranged-media-key',
    });

    expect(mediaFetch).toHaveBeenNthCalledWith(
      2,
      new URL('https://sun1.example/large.jpg'),
      expect.objectContaining({
        method: 'GET',
        range: 'bytes=0-0',
      }),
    );
    expect(prisma.vkParsingMediaCache.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          url: 'https://sun1.example/large.jpg',
          status: 'READY',
          contentLength: 3,
        }),
      }),
    );
    expect(maxClient.uploadImage).toHaveBeenCalled();
  });

  it('does not add Major channel engagement buttons to Publisher VK posts', async () => {
    const { service, prisma, adminService, maxClient } = createFixture();
    const engagementContext = {
      buttons: [
        [{ type: 'link', text: '💬 Комментарии · 0', url: 'https://max.ru/bot?startapp=comments' }],
        [{ type: 'link', text: 'Предложить пост', url: 'https://max.ru/bot?start=suggest' }],
      ],
      threadId: 'thread-1',
      includeCommentsButton: true,
      includeSuggestButton: true,
      suggestButtonText: 'Предложить пост',
      suggestionEntryMode: 'BOT',
    };
    const source = {
      id: 'source-1',
      chatId: 'channel-1',
      ownerProfile: VkParsingOwnerProfile.PUBLISHER,
      ownerBotId: 'publisher-bot',
      ownerId: 36819802,
      wallOwnerId: -36819802,
      screenName: 'avto_prodaja_rb',
      title: 'Авторынок Уфа',
      url: 'https://vk.ru/avto_prodaja_rb',
      status: 'ACTIVE',
      lastSyncAt: null,
      lastError: null,
      createdByUserId: '183470701',
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
    };
    const post = {
      id: 'post-1',
      sourceId: source.id,
      chatId: 'channel-1',
      ownerProfile: VkParsingOwnerProfile.PUBLISHER,
      ownerBotId: 'publisher-bot',
      vkOwnerId: -36819802,
      vkPostId: 101,
      vkPublishedAt: new Date('2026-05-25T10:00:00.000Z'),
      text: 'Продам авто',
      url: 'https://vk.ru/wall-36819802_101',
      photoUrls: [],
      linkUrls: [],
      attachments: [],
      raw: {},
      status: 'NEW',
      publishQueuedAt: new Date('2026-05-25T10:00:00.000Z'),
      publishScheduledAt: new Date('2026-05-25T10:00:00.000Z'),
      publishLockedAt: null,
      publishIdempotencyKey: 'publisher-engagement-key',
      publishReason: 'manual-retry',
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      requiredBotId: 'publisher-bot',
      dialogBotId: 'publisher-bot',
      publishDialogContext: {
        version: 1,
        dialogBotId: 'publisher-bot',
        buttons: [],
        reference: null,
      },
      publicationPolicyRevision: 1,
      publishActorUserId: '183470701',
      publishedMessageId: null,
      publishedUrl: null,
      publishedAtMax: null,
      lastError: null,
      createdAt: new Date('2026-05-25T10:00:00.000Z'),
      updatedAt: new Date('2026-05-25T10:00:00.000Z'),
      source,
    };
    prisma.vkParsingPost.findFirst.mockResolvedValue(post);
    prisma.vkParsingPost.updateMany.mockResolvedValue({ count: 1 });
    prisma.vkParsingPost.update.mockResolvedValue({
      ...post,
      status: 'PUBLISHED',
      publishedMessageId: 'mid-1',
      publishedUrl: 'https://max.ru/channels/channel-1/message/mid-1',
      publishedAtMax: new Date('2026-05-25T10:05:00.000Z'),
    });
    adminService.buildChannelPublicationEngagementContext.mockResolvedValue(engagementContext);
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'mid-1',
      url: 'https://max.ru/channels/channel-1/message/mid-1',
    });

    await service.processPublishPostJob({
      postId: 'post-1',
      chatId: 'channel-1',
      reason: 'manual-retry',
      idempotencyKey: 'publisher-engagement-key',
    });

    expect(adminService.buildChannelPublicationEngagementContext).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'channel-1',
      'Продам авто',
      expect.not.objectContaining({ buttons: expect.anything() }),
      {
        botId: 'publisher-bot',
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.VK_PARSING,
      },
    );
    expect(adminService.recordChannelPublicationEngagement).not.toHaveBeenCalled();
  });

  it('quarantines a confirmed MAX receipt after final-attempt persistence failure and blocks mutations', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-04T10:00:00.000Z'));
    try {
      const { service, publishService, prisma, maxClient, publishQueue } = createFixture();
      const source = createSource();
      const settings = {
        deleteAfterMinutes: 60,
        autoPublishEnabled: true,
        autoPublishEnabledAt: new Date('2026-09-04T08:00:00.000Z'),
        autoPublishKillSwitchEnabled: false,
        schedulerTimezone: 'UTC',
        quietHoursStart: null,
        quietHoursEnd: null,
        workHoursStart: '00:00',
        workHoursEnd: '00:00',
        distributeEvenlyEnabled: true,
        roundRobinEnabled: false,
        skipAdsEnabled: false,
      };
      let storedPost: any = createPostRow({
        source,
        createdAt: new Date('2026-09-04T09:00:00.000Z'),
        vkPublishedAt: new Date('2026-09-04T09:00:00.000Z'),
        publishQueuedAt: new Date('2026-09-04T09:59:00.000Z'),
        publishScheduledAt: new Date('2026-09-04T10:00:00.000Z'),
        publishIdempotencyKey: 'confirmed-final-key',
        publishReason: 'autopublish',
        publishScheduleFingerprint: buildVkAutoPublishScheduleFingerprint(settings, source),
      });
      const rollupError = new Error('source rollup failed after MAX accepted the post');
      const transactionalPostUpdate = jest.fn().mockResolvedValue({ count: 1 });
      const transactionalSourceUpdate = jest.fn().mockRejectedValue(rollupError);
      prisma.vkParsingPost.findFirst.mockImplementation(async () => storedPost);
      prisma.vkParsingPost.updateMany.mockImplementation(async (query: any) => {
        if (query.data.publishAttemptCount?.increment) {
          storedPost.publishAttemptCount += query.data.publishAttemptCount.increment;
        } else {
          storedPost = { ...storedPost, ...query.data };
        }
        return { count: 1 };
      });
      prisma.vkParsingSettings.findUnique.mockResolvedValue(settings);
      prisma.$transaction.mockImplementationOnce(async (operation: any) =>
        operation({
          ...prisma,
          vkParsingPost: { ...prisma.vkParsingPost, updateMany: transactionalPostUpdate },
          vkParsingSource: { ...prisma.vkParsingSource, updateMany: transactionalSourceUpdate },
        }),
      );
      maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
        messageId: 'max-confirmed-message',
        url: 'https://max.ru/channel-1/max-confirmed-message',
      });

      await expect(
        service.processPublishPostJob({
          postId: storedPost.id,
          chatId: storedPost.chatId,
          reason: 'autopublish',
          idempotencyKey: 'confirmed-final-key',
          attemptsMade: 4,
          maxAttempts: 5,
        }),
      ).rejects.toMatchObject({
        name: 'VkConfirmedPublishPersistenceError',
        persistenceCause: rollupError,
        receipt: expect.objectContaining({
          messageId: 'max-confirmed-message',
          botId: 'publisher-bot',
          url: 'https://max.ru/channel-1/max-confirmed-message',
          publishedAtMax: new Date('2026-09-04T10:00:00.000Z'),
          autoDeleteAt: new Date('2026-09-04T11:00:00.000Z'),
          autoPublishedAt: new Date('2026-09-04T10:00:00.000Z'),
          publishedContentHash: 'content-hash',
        }),
      });

      expect(storedPost).toEqual(
        expect.objectContaining({
          status: 'FAILED',
          publishedMessageId: 'max-confirmed-message',
          publishedBotId: 'publisher-bot',
          publishedUrl: 'https://max.ru/channel-1/max-confirmed-message',
          publishedAtMax: new Date('2026-09-04T10:00:00.000Z'),
          autoDeleteAt: new Date('2026-09-04T11:00:00.000Z'),
          autoPublishedAt: new Date('2026-09-04T10:00:00.000Z'),
          publishedContentHash: 'content-hash',
          publishLockedAt: null,
          publishIdempotencyKey: 'confirmed-final-key',
          publishReason: 'autopublish',
          lastError: expect.stringContaining('[max.send_confirmed_persistence_pending]'),
          autoPublishError: expect.stringContaining('[max.send_confirmed_persistence_pending]'),
        }),
      );
      expect(transactionalPostUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'PUBLISHED' }),
        }),
      );
      expect(transactionalSourceUpdate).toHaveBeenCalled();

      storedPost = {
        ...storedPost,
        source: { ...storedPost.source, publishMode: 'REVIEW' },
      };
      const mutationCount = prisma.vkParsingPost.updateMany.mock.calls.length;
      await expect(publishService.retryPost('channel-1', 'post-1')).rejects.toThrow(
        'MAX уже подтвердил эту публикацию',
      );
      await expect(
        publishService.cancelScheduledPost('channel-1', 'post-1', '98315271'),
      ).rejects.toThrow('MAX уже подтвердил эту публикацию');
      await expect(
        service.updateReviewPostDraft('channel-1', 'post-1', { userId: '98315271' } as never, {
          text: 'Нельзя изменить подтверждённую публикацию',
          photoUrls: [],
          linkUrls: [],
        }),
      ).rejects.toThrow('MAX уже подтвердил эту публикацию');

      expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledTimes(mutationCount);
      expect(publishQueue.add).not.toHaveBeenCalled();
      expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('recovers an expired confirmed receipt and finalizes it without current policy or MAX calls', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-04T12:00:00.000Z'));
    try {
      const {
        service,
        prisma,
        maxClient,
        publishQueue,
        maxRoutedPublicationService,
        publisherReadiness,
      } = createFixture();
      const publishedAtMax = new Date('2026-09-02T09:00:00.000Z');
      const source = createSource({
        autoPublishEnabled: false,
        autoPublishEnabledAt: null,
        autoPublishPausedAt: new Date('2026-09-02T10:00:00.000Z'),
        autoPublishPausedReason: 'manual',
      });
      let storedPost: any = createPostRow({
        source,
        status: 'FAILED',
        isAdvertising: true,
        advertisingMarkers: ['реклама'],
        publishQueuedAt: new Date('2026-09-02T08:55:00.000Z'),
        publishScheduledAt: new Date('2026-09-02T09:00:00.000Z'),
        publishIdempotencyKey: 'confirmed-recovery-key',
        publishReason: 'autopublish',
        publishAttemptCount: 5,
        publishedMessageId: 'max-confirmed-message',
        publishedBotId: 'publisher-bot',
        publishedUrl: 'https://max.ru/channel-1/max-confirmed-message',
        publishedAtMax,
        autoPublishedAt: publishedAtMax,
        publishedContentHash: 'content-hash',
        lastError: '[max.send_confirmed_persistence_pending] database write failed',
      });
      prisma.vkParsingPost.findMany.mockResolvedValueOnce([storedPost]).mockResolvedValueOnce([]);
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        autoPublishEnabled: false,
        autoPublishEnabledAt: null,
        autoPublishKillSwitchEnabled: false,
        skipAdsEnabled: true,
      });

      await expect(service.recoverStalePublishJobs()).resolves.toBe(1);

      expect(publishQueue.add).toHaveBeenCalledWith(
        'publish-vk-post',
        expect.objectContaining({
          postId: 'post-1',
          reason: 'autopublish',
          idempotencyKey: 'confirmed-recovery-key',
        }),
        expect.objectContaining({
          delay: 0,
          jobId: 'vk-parsing-publish__post-1__confirmed-recovery-key',
        }),
      );

      prisma.vkParsingSettings.findUnique.mockClear();
      prisma.vkParsingSettings.findUnique.mockRejectedValue(
        new Error('current skipAds policy must not be evaluated'),
      );
      prisma.vkParsingPost.findFirst.mockImplementation(async () => storedPost);
      prisma.vkParsingPost.updateMany.mockImplementation(async (query: any) => {
        if (query.data.publishAttemptCount?.increment) {
          storedPost.publishAttemptCount += query.data.publishAttemptCount.increment;
        } else {
          storedPost = { ...storedPost, ...query.data };
        }
        return { count: 1 };
      });

      await expect(
        service.processPublishPostJob({
          postId: storedPost.id,
          chatId: storedPost.chatId,
          reason: 'autopublish',
          idempotencyKey: 'confirmed-recovery-key',
          attemptsMade: 0,
          maxAttempts: 5,
        }),
      ).resolves.toBeUndefined();

      expect(storedPost).toEqual(
        expect.objectContaining({
          status: 'PUBLISHED',
          publishedMessageId: 'max-confirmed-message',
          publishedBotId: 'publisher-bot',
          publishedAtMax,
          publishedContentHash: 'content-hash',
          publishQueuedAt: null,
          publishScheduledAt: null,
          publishLockedAt: null,
          publishIdempotencyKey: null,
          publishReason: null,
          lastError: null,
        }),
      );
      expect(prisma.vkParsingSettings.findUnique).not.toHaveBeenCalled();
      expect(publisherReadiness.assertEntityReady).not.toHaveBeenCalled();
      expect(maxRoutedPublicationService.publish).not.toHaveBeenCalled();
      expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not overwrite a confirmed receipt prefix when dispatch health changes after claim', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-04T12:00:00.000Z'));
    try {
      const { publishService, prisma, maxClient, publisherDispatchHealth } = createFixture();
      const confirmedError =
        '[max.send_confirmed_persistence_pending] receipt committed by a concurrent worker';
      const post = createPostRow({
        publishQueuedAt: new Date('2026-09-04T11:59:00.000Z'),
        publishScheduledAt: new Date('2026-09-04T12:00:00.000Z'),
        publishLockedAt: new Date('2026-09-04T12:00:00.000Z'),
        publishIdempotencyKey: 'health-race-key',
        publishReason: 'manual-retry',
        lastError: null,
      });
      const persisted = {
        lastError: null as string | null,
        dispatchBlockerCode: null as string | null,
      };
      prisma.vkParsingPost.findFirst
        .mockResolvedValueOnce({ sourceId: post.sourceId })
        .mockResolvedValueOnce(post);
      prisma.vkParsingPost.updateMany.mockImplementation(async (query: any) => {
        if (query.data.dispatchBlockerCode) {
          if (query.where.lastError !== persisted.lastError) {
            return { count: 0 };
          }
          persisted.lastError = query.data.lastError;
          persisted.dispatchBlockerCode = query.data.dispatchBlockerCode;
        }
        return { count: 1 };
      });
      publisherDispatchHealth.assertDispatchAllowed.mockImplementation(async () => {
        persisted.lastError = confirmedError;
        throw Object.assign(new Error('Publisher health paused concurrently'), {
          code: 'PUBLISHER_DISPATCH_PAUSED',
        });
      });

      await expect(
        publishService.processPublishPostJob({
          postId: post.id,
          chatId: post.chatId,
          reason: 'manual-retry',
          idempotencyKey: 'health-race-key',
          dispatchProfile: 'PUBLIK_V1',
          requiredBotId: 'publisher-bot',
        }),
      ).resolves.toBeUndefined();

      expect(persisted).toEqual({
        lastError: confirmedError,
        dispatchBlockerCode: null,
      });
      expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            id: 'post-1',
            publishIdempotencyKey: 'health-race-key',
            publishReason: 'manual-retry',
            publishLockedAt: new Date('2026-09-04T12:00:00.000Z'),
            publishAttemptCount: 0,
            lastError: null,
            AND: expect.any(Array),
          }),
          data: expect.objectContaining({
            dispatchBlockerCode: 'publisher_auth_paused',
            lastError: '[publisher.blocked] publisher_auth_paused',
          }),
        }),
      );
      expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ data: { publishAttemptCount: { increment: 1 } } }),
      );
      expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('allows circuit candidate 10 and opens on candidate 11 using transaction-current policy', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-04T12:00:00.000Z'));
    try {
      const { publishService, prisma } = createFixture();
      const staleSource = createSource({
        importEnabled: false,
        autoPublishEnabled: false,
        autoPublishPausedAt: new Date('2026-09-04T11:00:00.000Z'),
        publishMode: 'REVIEW',
      });
      const currentSource = createSource({
        importEnabled: true,
        autoPublishEnabled: true,
        autoPublishPausedAt: null,
        publishMode: 'QUEUE',
      });
      prisma.vkParsingSource.findFirst.mockResolvedValue(currentSource);
      prisma.vkParsingSettings.findUnique.mockResolvedValue({
        autoPublishEnabled: true,
        autoPublishKillSwitchEnabled: false,
        circuitBreakerEnabled: true,
        circuitBreakerWindowMinutes: 15,
        circuitBreakerPostLimit: 10,
      });
      prisma.vkParsingPost.count.mockResolvedValueOnce(9).mockResolvedValueOnce(10);
      prisma.vkParsingSource.updateMany.mockResolvedValue({ count: 1 });

      const pauseForCircuit = (publishService as any).pauseSourceAutoPublishForCircuit.bind(
        publishService,
      );
      await expect(pauseForCircuit(staleSource)).resolves.toBe(false);
      expect(prisma.vkParsingSource.updateMany).not.toHaveBeenCalled();

      await expect(pauseForCircuit(staleSource)).resolves.toBe(true);

      expect(prisma.vkParsingSource.findFirst).toHaveBeenCalledTimes(2);
      expect(prisma.vkParsingSource.findFirst).toHaveBeenCalledWith({
        where: {
          id: 'source-1',
          chatId: 'channel-1',
          ownerProfile: VkParsingOwnerProfile.PUBLISHER,
          ownerBotId: 'publisher-bot',
        },
      });
      expect(prisma.vkParsingSettings.findUnique).toHaveBeenCalledTimes(2);
      expect(prisma.vkParsingSettings.findUnique).toHaveBeenCalledWith({
        where: {
          chatId_ownerProfile_ownerBotId: {
            chatId: 'channel-1',
            ownerProfile: VkParsingOwnerProfile.PUBLISHER,
            ownerBotId: 'publisher-bot',
          },
        },
      });
      expect(prisma.vkParsingPost.count).toHaveBeenNthCalledWith(1, {
        where: expect.objectContaining({
          chatId: 'channel-1',
          sourceId: 'source-1',
          OR: [
            {
              publishQueuedAt: { gte: new Date('2026-09-04T11:45:00.000Z') },
              publishReason: 'autopublish',
            },
            { autoPublishedAt: { gte: new Date('2026-09-04T11:45:00.000Z') } },
          ],
        }),
      });
      expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          id: 'source-1',
          autoPublishEnabled: true,
          autoPublishPausedAt: null,
        }),
        data: {
          autoPublishEnabled: false,
          autoPublishEnabledAt: null,
          autoPublishPausedAt: new Date('2026-09-04T12:00:00.000Z'),
          autoPublishPausedReason: 'circuit_breaker',
        },
      });
      expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            sourceId: { in: ['source-1'] },
            publishLockedAt: null,
            publishAttemptCount: 0,
          }),
        }),
      );
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          chatId: 'channel-1',
          actorUserId: 'vk-parsing-autopost',
          action: 'VK_PARSING_CIRCUIT_OPEN',
          payload: expect.objectContaining({ sourceId: 'source-1', limit: 10, windowMinutes: 15 }),
        }),
      });
    } finally {
      jest.useRealTimers();
    }
  });
});
