import { NetworkNavigationAllowlist } from './network-navigation-allowlist';
import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { channelSettingsSchema, chatSettingsSchema, type ChannelSettings } from '@maxim/contracts';
import type {
  NetworkSettingsRecipient,
  NetworkSettingsTarget,
} from '@maxim/contracts/network-settings';
import { networkSettingsPreviewRequestSchema } from '@maxim/contracts/network-settings';
import { createPrismaAdapter, PrismaClient, type Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { buildResolvedMaxBotConfigs } from '../max/max-bot-config.util';
import type { ManagedEntitiesService } from './managed-entities.service';
import type { AdminSettingsService } from './admin-settings.service';
import type { AdminStopWordsService } from './admin-stop-words.service';
import type { ChannelPostSignatureService } from './channel-post-signature.service';
import { ManagedEntityNetworksService } from './managed-entity-networks.service';
import {
  NETWORK_SETTINGS_OPERATION_READER_VERSION,
  NetworkSettingsService,
} from './network-settings.service';
import { readChannelSettings, saveChannelSettings } from './admin-channel-settings';
import { saveChatSettings, sanitizeStoredChatSettings } from './admin-chat-settings';
import { buildNetworkSettingsPatch, networkSettingsAuthoredKeys } from './network-settings-patch';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const integration = databaseUrl ? describe : describe.skip;

integration('network settings durable writes with PostgreSQL', () => {
  let db: PrismaClient;
  let service: NetworkSettingsService;
  let networks: ManagedEntityNetworksService;
  const suffix = randomUUID();
  const actor = `network-settings-${suffix}`;
  const bot = `network-settings-bot-${suffix}`;
  const ids = Array.from({ length: 6 }, (_, index) => `network-settings-${suffix}-${index}`);
  const largeIds = Array.from(
    { length: 104 },
    (_, index) => `network-settings-large-${suffix}-${String(index).padStart(3, '0')}`,
  );
  const chatId = `network-settings-chat-${suffix}`;
  const user = { userId: actor, username: null, displayName: null };
  const ownedOperations: string[] = [];
  const access = jest.fn<
    Promise<void>,
    Parameters<ManagedEntitiesService['assertManagedEntityAdminAccess']>
  >();
  const followup = jest.fn<
    Promise<void>,
    Parameters<AdminSettingsService['finishNetworkSettingsFollowup']>
  >();
  const writes = jest.fn<
    ReturnType<AdminSettingsService['updateNetworkChannelSettings']>,
    Parameters<AdminSettingsService['updateNetworkChannelSettings']>
  >();

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.includes('race_test'))
      throw new Error('Disposable PostgreSQL required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 6, statement_timeout: 15_000 }),
    });
    const definition = buildResolvedMaxBotConfigs({
      defaultBot: {
        id: bot,
        token: 'test-token',
        webhookSecretPath: 'test-path',
        webhookHeaderSecret: 'test-header',
      },
    })[0]!;
    const registry = {
      getAllBots: () => [{ ...definition, webhookUrl: null, maskedWebhookUrl: null }],
    } satisfies Pick<MaxBotRegistryService, 'getAllBots'>;
    networks = new ManagedEntityNetworksService(
      db as PrismaService,
      registry as unknown as MaxBotRegistryService,
    );
    for (const id of ids) {
      await db.chat.create({
        data: {
          id,
          title: id,
          entityType: 'CHANNEL' as const,
          channelSettings: {
            create: {
              commentsEnabled: false,
              commentsMessageText: `Own ${id}`,
              postSuggestionsButtonText: `Private ${id.slice(-1)}`,
            },
          },
        },
      });
      await db.managedEntityAccessEdge.create({
        data: {
          chatId: id,
          userId: actor,
          botId: bot,
          entityType: 'CHANNEL' as const,
          state: 'GRANTED' as const,
          userRole: 'ADMIN' as const,
          expiresAt: new Date(0),
        },
      });
    }
    await db.chat.create({
      data: {
        id: chatId,
        title: chatId,
        entityType: 'CHAT',
        settings: {
          create: {
            linkBotButtons: [{ text: 'Own link', url: 'https://own.example' }],
            linkBotButtonUrl: 'https://own.example',
            greetingBotButtons: [{ text: 'Greeting', url: 'https://greeting.example' }],
            greetingBotButtonUrl: 'https://greeting.example',
          },
        },
      },
    });
    const settings = {
      commercialAiModerationMode: () => 'DELETE_ONLY' as const,
      getChannelSettings: async (id: string) =>
        channelSettingsSchema.parse(
          await db.channelSettings.findUniqueOrThrow({ where: { chatId: id } }),
        ),
      updateNetworkChannelSettings: writes,
      finishNetworkSettingsFollowup: followup,
    } satisfies Pick<
      AdminSettingsService,
      | 'commercialAiModerationMode'
      | 'getChannelSettings'
      | 'updateNetworkChannelSettings'
      | 'finishNetworkSettingsFollowup'
    >;
    const managed = { assertManagedEntityAdminAccess: access } satisfies Pick<
      ManagedEntitiesService,
      'assertManagedEntityAdminAccess'
    >;
    service = new NetworkSettingsService(
      db as PrismaService,
      networks,
      managed as unknown as ManagedEntitiesService,
      settings as unknown as AdminSettingsService,
      {} as AdminStopWordsService,
      {} as ChannelPostSignatureService,
      new NetworkNavigationAllowlist(db as PrismaService),
    );
  });

  beforeEach(async () => {
    access.mockReset().mockResolvedValue(undefined);
    followup.mockReset().mockResolvedValue(undefined);
    writes.mockReset().mockImplementation(async (id, requestUser, body, changedPaths, options) =>
      saveChannelSettings({
        prisma: db as PrismaService,
        chatContextCache: { invalidate: async () => undefined },
        chatId: id,
        actorUserId: requestUser.userId,
        body,
        source: 'miniapp',
        resolveBotAssignmentData: () => ({}),
        refreshExecutionReadiness: async () => undefined,
        networkWrite: {
          ...options,
          authoredChannelKeys: changedPaths as Array<keyof ChannelSettings>,
        },
      }),
    );
    await db.managedEntityFavorite.deleteMany({ where: { userId: actor } });
  });

  afterAll(async () => {
    await db?.networkSettingsOperation.deleteMany({ where: { id: { in: ownedOperations } } });
    await db?.auditLog.deleteMany({ where: { chatId: { in: [...ids, ...largeIds, chatId] } } });
    await db?.chat.deleteMany({ where: { id: { in: [...ids, ...largeIds, chatId] } } });
    await db?.managedEntityFavoritePreference.deleteMany({ where: { userId: actor } });
    await db?.$disconnect();
  });

  async function prepare(
    target: NetworkSettingsTarget = { mode: 'selected', entityIds: ids.slice(0, 2) },
  ) {
    const read = await service.read(user, { entityType: 'channel', target, section: 'comments' });
    const operationId = randomUUID();
    ownedOperations.push(operationId);
    const preview = await service.preview(user, {
      entityType: 'channel',
      target,
      section: 'comments',
      operationId,
      compositionVersion: read.compositionVersion,
      recipients: read.recipients,
      changes: [{ path: 'commentsMessageText', op: 'set', value: 'Network text' }],
    });
    expect(preview.status).toBe('PREVIEWING');
    await expect(service.tick()).resolves.toBe(true);
    expect((await service.status(user, operationId)).status).toBe('PREPARED');
    return preview;
  }

  it('replays an accepted preview with a retired selector but rejects a new operation containing it', async () => {
    const operationId = randomUUID();
    ownedOperations.push(operationId);
    const request = networkSettingsPreviewRequestSchema.parse({
      operationId,
      entityType: 'chat',
      section: 'duplicates',
      target: { mode: 'selected', entityIds: [chatId] },
      compositionVersion: 'retained-composition',
      recipients: [{ entityId: chatId, title: chatId, revision: 1 }],
      changes: [
        { path: 'duplicateCompareMode', op: 'set', value: 'TEXT' },
        { path: 'duplicatePhotoScope', op: 'set', value: 'CHAT' },
      ],
    });
    const ordered = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(ordered)
        : value && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([key, child]) => [key, ordered(child)]),
            )
          : value;
    const requestHash = createHash('sha256')
      .update(JSON.stringify(ordered(request)))
      .digest('hex');
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const stored = await db.networkSettingsOperation.create({
      data: {
        id: operationId,
        actorUserId: user.userId,
        entityType: 'CHAT',
        section: 'duplicates',
        status: 'PREPARED',
        requestHash,
        payload: { readerVersion: 1, request, expiresAt } as unknown as Prisma.InputJsonValue,
      },
    });
    await expect(service.preview(user, request)).resolves.toEqual(
      expect.objectContaining({
        operationId,
        previewHash: requestHash,
        status: 'PREPARED',
        changes: request.changes,
      }),
    );
    await expect(
      service.preview({ ...user, userId: `${actor}-other` }, request),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      service.preview(user, { ...request, changes: request.changes.slice(0, 1) }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await db.networkSettingsOperation.findUnique({ where: { id: operationId } })).toEqual(
      stored,
    );
    const newId = randomUUID();
    await expect(service.preview(user, { ...request, operationId: newId })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(await db.networkSettingsOperation.findUnique({ where: { id: newId } })).toBeNull();
  });

  it('pages a full category and rejects stale composition before confirmation', async () => {
    await db.managedEntityFavorite.createMany({
      data: ids.map((chatId) => ({
        userId: actor,
        chatId,
        entityType: 'CHANNEL' as const,
        favoriteType: 'WATCH' as const,
      })),
    });
    const target = { mode: 'category', favoriteType: 'watch' };
    const first = await service.read(user, { entityType: 'channel', target, section: 'comments' });
    expect(first.recipientCount).toBe(6);
    expect(first.recipients).toHaveLength(4);
    expect(first.complete).toBe(false);
    const last = await service.read(user, {
      entityType: 'channel',
      target,
      section: 'comments',
      cursor: first.nextCursor,
    });
    expect(last.complete).toBe(true);
    expect([...first.recipients, ...last.recipients].map((row) => row.entityId)).toEqual(ids);
    await networks.updateComposition(user, 'channel', {
      changes: [{ entityId: ids[0], expectedFavoriteType: 'watch', favoriteType: null }],
    });
    await expect(
      service.read(user, {
        entityType: 'channel',
        target,
        section: 'comments',
        cursor: first.nextCursor,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('reads and previews a large category while each worker tick validates only its bounded chunk', async () => {
    await db.$transaction([
      db.chat.createMany({
        data: largeIds.map((id, index) => ({
          id,
          title: `Канал ${index} ${'проверка '.repeat(10)}`,
          entityType: 'CHANNEL' as const,
        })),
      }),
      db.channelSettings.createMany({
        data: largeIds.map((chatId) => ({ chatId, commentsMessageText: 'Own channel text' })),
      }),
      db.managedEntityAccessEdge.createMany({
        data: largeIds.map((chatId) => ({
          chatId,
          userId: actor,
          botId: bot,
          entityType: 'CHANNEL' as const,
          state: 'GRANTED' as const,
          userRole: 'ADMIN' as const,
          expiresAt: new Date(0),
        })),
      }),
      db.managedEntityFavorite.createMany({
        data: largeIds.map((chatId) => ({
          userId: actor,
          chatId,
          entityType: 'CHANNEL' as const,
          favoriteType: 'WATCH' as const,
        })),
      }),
    ]);
    // Fresh disposable stores need statistics for the category cardinality seeded above.
    await db.$executeRaw`ANALYZE "chats", "managed_entity_access_edges", "managed_entity_favorites"`;
    const request = {
      entityType: 'channel',
      target: { mode: 'category', favoriteType: 'watch' },
      section: 'comments',
    } as const;
    const recipients: NetworkSettingsRecipient[] = [];
    let cursor: string | undefined;
    let compositionVersion: string | undefined;
    let pageCount = 0;
    do {
      const page = await service.read(user, { ...request, ...(cursor ? { cursor } : {}) });
      expect(page.recipientCount).toBe(largeIds.length);
      expect(page.recipients.length).toBeLessThanOrEqual(4);
      if (compositionVersion) expect(page.compositionVersion).toBe(compositionVersion);
      compositionVersion = page.compositionVersion;
      recipients.push(...page.recipients);
      cursor = page.nextCursor ?? undefined;
      expect(page.complete).toBe(!cursor);
      pageCount += 1;
    } while (cursor);
    expect(pageCount).toBe(26);
    expect(recipients.map((recipient) => recipient.entityId)).toEqual(largeIds);
    const operationId = randomUUID();
    ownedOperations.push(operationId);
    const body = {
      ...request,
      operationId,
      compositionVersion,
      recipients,
      changes: [{ path: 'commentsMessageText', op: 'set', value: 'Large network text' }],
    };
    expect(Buffer.byteLength(JSON.stringify(body), 'utf8')).toBeLessThan(128 * 1024);
    try {
      const preview = await service.preview(user, body);
      expect(preview.status).toBe('PREVIEWING');
      expect(preview.recipients).toEqual(recipients);
      expect(await db.networkSettingsOperationTarget.count({ where: { operationId } })).toBe(
        largeIds.length,
      );
      expect(writes).not.toHaveBeenCalled();
      access.mockClear();
      await service.tick(1);
      const status = await service.status(user, operationId);
      expect(status.status).toBe('PREVIEWING');
      expect(status.outcomes.filter((target) => target.status === 'VALIDATED')).toHaveLength(2);
      expect(status.outcomes.filter((target) => target.status === 'PENDING')).toHaveLength(102);
      expect(access).toHaveBeenCalledTimes(2);
      expect(writes).toHaveBeenCalledTimes(2);
      expect(writes.mock.calls.every(([, , , , options]) => options.validateOnly)).toBe(true);
      expect(followup).not.toHaveBeenCalled();
      expect(
        await db.channelSettings.count({
          where: { chatId: { in: largeIds }, commentsMessageText: 'Own channel text' },
        }),
      ).toBe(largeIds.length);
    } finally {
      await db.networkSettingsOperation.deleteMany({ where: { id: operationId } });
    }
  });

  it('preflights every target before writing and records a permission failure with zero writes', async () => {
    const preview = await prepare();
    await service.apply(user, {
      operationId: preview.operationId,
      previewHash: preview.previewHash,
    });
    access.mockImplementation(async (id) => {
      if (id === ids[1]) throw new ForbiddenException();
    });
    const before = await db.channelSettings.findMany({
      where: { chatId: { in: ids.slice(0, 2) } },
      orderBy: { chatId: 'asc' },
    });
    await service.tick();
    const operation = await service.status(user, preview.operationId);
    expect(operation.status).toBe('FAILED');
    expect(operation.outcomes.every((target) => target.status === 'FAILED')).toBe(true);
    expect(operation.outcomes.find((target) => target.entityId === ids[1])?.failureCode).toBe(
      'DENIED',
    );
    expect(
      await db.channelSettings.findMany({
        where: { chatId: { in: ids.slice(0, 2) } },
        orderBy: { chatId: 'asc' },
      }),
    ).toEqual(before);
    expect(followup).not.toHaveBeenCalled();
  });

  it.each([
    { phase: 'PREVIEWING', failure: new ConflictException(), code: 'CONFLICT' },
    { phase: 'AUTHORIZING', failure: new ForbiddenException(), code: 'DENIED' },
  ])(
    'atomically settles every unwritten target after a later $phase chunk fails',
    async ({ phase, failure, code }) => {
      const selected = ids.slice(0, 5);
      const target = { mode: 'selected', entityIds: selected } as const;
      const request = { entityType: 'channel', target, section: 'comments' } as const;
      const first = await service.read(user, request);
      const recipients = [...first.recipients];
      let cursor = first.nextCursor;
      while (cursor) {
        const page = await service.read(user, { ...request, cursor });
        recipients.push(...page.recipients);
        cursor = page.nextCursor;
      }
      const operationId = randomUUID();
      ownedOperations.push(operationId);
      const preview = await service.preview(user, {
        ...request,
        operationId,
        compositionVersion: first.compositionVersion,
        recipients,
        changes: [{ path: 'commentsMessageText', op: 'set', value: 'Must remain unwritten' }],
      });
      if (phase === 'AUTHORIZING') {
        for (let chunk = 0; chunk < 3; chunk++) await service.tick(1);
        expect((await service.status(user, operationId)).status).toBe('PREPARED');
        await service.apply(user, { operationId, previewHash: preview.previewHash });
      }
      await service.tick(1);
      const partial = await service.status(user, operationId);
      expect(partial.status).toBe(phase);
      expect(
        partial.outcomes.filter(
          (row) => row.status === (phase === 'PREVIEWING' ? 'VALIDATED' : 'AUTHORIZED'),
        ),
      ).toHaveLength(2);
      const before = await db.channelSettings.findMany({
        where: { chatId: { in: selected } },
        orderBy: { chatId: 'asc' },
      });
      const auditBefore = await db.auditLog.count({ where: { chatId: { in: selected } } });
      access.mockImplementation(async (id) => {
        if (id === selected[3]) throw failure;
      });
      writes.mockClear();
      await service.tick(1);
      const failed = await service.status(user, operationId);
      expect(failed.status).toBe('FAILED');
      expect(failed.outcomes).toHaveLength(selected.length);
      expect(failed.outcomes.every((row) => row.status === 'FAILED')).toBe(true);
      expect(failed.outcomes.find((row) => row.entityId === selected[3])?.failureCode).toBe(code);
      expect(
        failed.outcomes.filter((row) => row.entityId !== selected[3]).map((row) => row.failureCode),
      ).toEqual(Array(4).fill('PREFLIGHT_ABORTED'));
      expect(
        await db.channelSettings.findMany({
          where: { chatId: { in: selected } },
          orderBy: { chatId: 'asc' },
        }),
      ).toEqual(before);
      expect(await db.auditLog.count({ where: { chatId: { in: selected } } })).toBe(auditBefore);
      expect(writes.mock.calls.every(([, , , , options]) => options.validateOnly)).toBe(true);
      expect(followup).not.toHaveBeenCalled();
      writes.mockClear();
      access.mockClear();
      for (let repeat = 0; repeat < 3; repeat++) await service.tick(1);
      expect(writes).not.toHaveBeenCalled();
      expect(access).not.toHaveBeenCalled();
      expect(
        (await service.apply(user, { operationId, previewHash: preview.previewHash })).status,
      ).toBe('FAILED');
    },
  );

  it.each(['COMMITTED', 'COMPLETE', 'UNKNOWN'])(
    'preserves $0 preflight evidence instead of fabricating unwritten failure',
    async (protectedStatus) => {
      const preview = await prepare();
      await service.apply(user, {
        operationId: preview.operationId,
        previewHash: preview.previewHash,
      });
      const data = {
        status: protectedStatus,
        ...(protectedStatus === 'UNKNOWN' ? {} : { committedRevision: 'observed-commit' }),
      };
      await db.networkSettingsOperationTarget.update({
        where: { operationId_entityId: { operationId: preview.operationId, entityId: ids[0] } },
        data,
      });
      access.mockImplementation(async (id) => {
        if (id === ids[1]) throw new ForbiddenException();
      });
      const before = await db.networkSettingsOperationTarget.findMany({
        where: { operationId: preview.operationId },
        orderBy: { entityId: 'asc' },
      });
      try {
        await service.tick(1);
        expect(
          (
            await db.networkSettingsOperation.findUniqueOrThrow({
              where: { id: preview.operationId },
            })
          ).status,
        ).toBe('AUTHORIZING');
        expect(
          await db.networkSettingsOperationTarget.findMany({
            where: { operationId: preview.operationId },
            orderBy: { entityId: 'asc' },
          }),
        ).toEqual(before);
        expect(followup).not.toHaveBeenCalled();
        expect(writes.mock.calls.every(([, , , , options]) => options.validateOnly)).toBe(true);
      } finally {
        await db.networkSettingsOperation.delete({ where: { id: preview.operationId } });
      }
    },
  );

  it('fences a category mutation between preview and launch under the favorites writer lock', async () => {
    await networks.updateComposition(user, 'channel', {
      changes: ids.slice(0, 2).map((entityId) => ({
        entityId,
        expectedFavoriteType: null,
        favoriteType: 'watch',
      })),
    });
    const preview = await prepare({ mode: 'category', favoriteType: 'watch' });
    await networks.updateComposition(user, 'channel', {
      changes: [{ entityId: ids[2], expectedFavoriteType: null, favoriteType: 'watch' }],
    });
    await expect(
      service.apply(user, { operationId: preview.operationId, previewHash: preview.previewHash }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect((await service.status(user, preview.operationId)).status).toBe('PREPARED');
    expect(followup).not.toHaveBeenCalled();
  });

  it('co-commits receipt and settings, then resumes followups after restart without replay', async () => {
    const preview = await prepare();
    await service.apply(user, {
      operationId: preview.operationId,
      previewHash: preview.previewHash,
    });
    await expect(service.tick()).resolves.toBe(true);
    followup.mockRejectedValueOnce(new Error('cache unavailable'));
    await expect(service.tick()).resolves.toBe(true);
    const target = await db.networkSettingsOperationTarget.findUniqueOrThrow({
      where: { operationId_entityId: { operationId: preview.operationId, entityId: ids[0] } },
    });
    expect(target.status).toBe('COMMITTED');
    const written = await db.channelSettings.findUniqueOrThrow({ where: { chatId: ids[0] } });
    expect(written.commentsMessageText).toBe('Network text');
    expect(written.postSuggestionsButtonText).toBe(`Private ${ids[0].slice(-1)}`);
    expect(target.committedRevision).toBe(String(written.revision));
    const committedWrites = writes.mock.calls.filter(
      ([, , , , options]) => !options.validateOnly,
    ).length;
    expect(
      (await db.channelSettings.findUniqueOrThrow({ where: { chatId: ids[1] } }))
        .commentsMessageText,
    ).toBe('Network text');
    followup.mockRejectedValueOnce(new Error('cache still unavailable'));
    await expect(service.tick()).resolves.toBe(false);
    expect((await service.status(user, preview.operationId)).status).toBe('RUNNING');
    expect(writes.mock.calls.filter(([, , , , options]) => !options.validateOnly).length).toBe(
      committedWrites,
    );
    await expect(service.tick()).resolves.toBe(true);
    expect(
      (await db.channelSettings.findUniqueOrThrow({ where: { chatId: ids[0] } })).revision,
    ).toBe(written.revision);
    expect(writes.mock.calls.filter(([, , , , options]) => !options.validateOnly).length).toBe(
      committedWrites,
    );
    expect((await service.status(user, preview.operationId)).status).toBe('COMPLETE');
    await service.apply(user, {
      operationId: preview.operationId,
      previewHash: preview.previewHash,
    });
    await expect(service.tick()).resolves.toBe(false);
    expect(
      (await db.channelSettings.findUniqueOrThrow({ where: { chatId: ids[0] } })).revision,
    ).toBe(written.revision);
  });

  it('preserves the journal and target when a future operation reader is installed', async () => {
    const preview = await prepare({ mode: 'selected', entityIds: [ids[3]] });
    const row = await db.networkSettingsOperation.findUniqueOrThrow({
      where: { id: preview.operationId },
    });
    await db.networkSettingsOperation.update({
      where: { id: row.id },
      data: {
        payload: {
          ...(row.payload as object),
          readerVersion: NETWORK_SETTINGS_OPERATION_READER_VERSION + 1,
        },
      },
    });
    await expect(
      service.apply(user, { operationId: row.id, previewHash: preview.previewHash }),
    ).rejects.toMatchObject({ response: { code: 'NETWORK_SETTINGS_READER_UNSUPPORTED' } });
    expect((await service.status(user, row.id)).status).toBe('PREPARED');
    await db.networkSettingsOperation.update({
      where: { id: row.id },
      data: { status: 'RUNNING' },
    });
    writes.mockClear();
    await expect(service.tick()).resolves.toBe(false);
    expect(writes).not.toHaveBeenCalled();
    expect((await service.status(user, row.id)).outcomes[0].status).toBe('VALIDATED');
  });

  it('rolls back a settings update when its receipt callback fails', async () => {
    const current = await db.channelSettings.findUniqueOrThrow({ where: { chatId: ids[2] } });
    await expect(
      saveChannelSettings({
        prisma: db as PrismaService,
        chatContextCache: { invalidate: async () => undefined },
        chatId: ids[2],
        actorUserId: actor,
        body: { ...channelSettingsSchema.parse(current), commentsMessageText: 'Must rollback' },
        source: 'miniapp',
        resolveBotAssignmentData: () => ({}),
        refreshExecutionReadiness: async () => undefined,
        networkWrite: {
          authoredChannelKeys: ['commentsMessageText'],
          onCommitted: async () => {
            throw new Error('lost lease');
          },
        },
      }),
    ).rejects.toThrow('lost lease');
    expect(await db.channelSettings.findUniqueOrThrow({ where: { chatId: ids[2] } })).toEqual(
      current,
    );
  });

  it('prevents a superseded worker from committing a target after losing its operation lease', async () => {
    const preview = await prepare({ mode: 'selected', entityIds: [ids[4]] });
    await service.apply(user, {
      operationId: preview.operationId,
      previewHash: preview.previewHash,
    });
    await service.tick();
    const before = await db.channelSettings.findUniqueOrThrow({ where: { chatId: ids[4] } });
    const normalWrite = writes.getMockImplementation()!;
    writes.mockImplementationOnce(async (...args) => {
      await db.networkSettingsOperation.update({
        where: { id: preview.operationId },
        data: {
          leaseToken: 'superseding-worker',
          leaseUntil: new Date(Date.now() + 60_000),
        },
      });
      return normalWrite(...args);
    });
    await service.tick();
    expect(await db.channelSettings.findUniqueOrThrow({ where: { chatId: ids[4] } })).toEqual(
      before,
    );
    expect((await service.status(user, preview.operationId)).outcomes[0].status).toBe('AUTHORIZED');
    await db.networkSettingsOperation.update({
      where: { id: preview.operationId },
      data: { leaseUntil: new Date(0) },
    });
    await service.tick();
    expect((await service.status(user, preview.operationId)).status).toBe('COMPLETE');
  });

  it('rejects a stale channel revision and the database trigger versions older writers', async () => {
    const current = await db.channelSettings.findUniqueOrThrow({ where: { chatId: ids[3] } });
    await db.channelSettings.update({
      where: { chatId: ids[3] },
      data: { commentsMessageText: 'Concurrent' },
    });
    const changed = await db.channelSettings.findUniqueOrThrow({ where: { chatId: ids[3] } });
    expect(changed.revision).toBe(current.revision + 1);
    await expect(
      saveChannelSettings({
        prisma: db as PrismaService,
        chatContextCache: { invalidate: async () => undefined },
        chatId: ids[3],
        actorUserId: actor,
        body: { ...channelSettingsSchema.parse(current), commentsEnabled: true },
        source: 'miniapp',
        resolveBotAssignmentData: () => ({}),
        refreshExecutionReadiness: async () => undefined,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(
      (await db.channelSettings.findUniqueOrThrow({ where: { chatId: ids[3] } }))
        .commentsMessageText,
    ).toBe('Concurrent');
  });

  it('fences read-time normalization when a concurrent writer keeps the same timestamp', async () => {
    const entityId = ids[5];
    const stale = await db.channelSettings.update({
      where: { chatId: entityId },
      data: {
        commentsEnabled: true,
        postSuggestionsButtonEnabled: true,
        postSuggestionsButtonUrl: 'https://max.ru/chat/example/https://nested.example.test',
      },
    });
    const concurrentUrl = 'https://example.test/concurrent';
    const raced = db.$extends({
      query: {
        chat: {
          async upsert({ args, query }) {
            const result = await query(args);
            await db.channelSettings.update({
              where: { chatId: entityId },
              data: {
                postSuggestionsButtonEnabled: true,
                postSuggestionsButtonUrl: concurrentUrl,
                updatedAt: stale.updatedAt,
              },
            });
            return result;
          },
        },
      },
    });
    await expect(
      readChannelSettings({
        prisma: raced as unknown as PrismaService,
        logger: { warn: jest.fn() },
        chatId: entityId,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    const saved = await db.channelSettings.findUniqueOrThrow({ where: { chatId: entityId } });
    expect(saved.updatedAt).toEqual(stale.updatedAt);
    expect(saved.revision).toBe(stale.revision + 1);
    expect(saved.postSuggestionsButtonUrl).toBe(concurrentUrl);
    expect(saved.postSuggestionsButtonEnabled).toBe(true);
  });

  it('persists an explicit empty chat button list without resurrecting legacy aliases or altering sibling buttons', async () => {
    const current = await db.chatSettings.findUniqueOrThrow({ where: { chatId } });
    const parsed = {
      ...chatSettingsSchema.parse(sanitizeStoredChatSettings(current)),
      settingsRevision: current.updatedAt.toISOString(),
    };
    const changes = [{ path: 'linkBotButtons', op: 'replace' as const, value: [] }];
    const body = buildNetworkSettingsPatch(parsed, 'chat', 'links', changes);
    await saveChatSettings({
      prisma: db as PrismaService,
      chatContextCache: { invalidate: async () => undefined },
      chatId,
      actorUserId: actor,
      body,
      source: 'miniapp',
      resolveBotAssignmentData: () => ({}),
      assertRequiredSubscriptionSettings: async () => undefined,
      reportsAvailable: () => false,
      assertBotCapabilities: async () => undefined,
      refreshExecutionReadiness: async () => undefined,
      networkWrite: { authoredKeys: networkSettingsAuthoredKeys(changes) },
    });
    const written = await db.chatSettings.findUniqueOrThrow({ where: { chatId } });
    expect(written.linkBotButtons).toEqual([]);
    expect(written.linkBotButtonUrl).toBe('');
    expect(written.linkBotButtonText).toBe('Открыть');
    expect(written.greetingBotButtons).toEqual(current.greetingBotButtons);
    expect(written.greetingBotButtonUrl).toBe(current.greetingBotButtonUrl);
    expect(chatSettingsSchema.parse(sanitizeStoredChatSettings(written)).linkBotButtons).toEqual(
      [],
    );
  });
});
