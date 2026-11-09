import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';
import type { MaxClientService } from '../max/max-client.service';
import type { PublisherRuntimeBoundaryService } from '../publisher/publisher-runtime-boundary.service';
import type { PublisherDispatchHealthService } from '../publisher/publisher-dispatch-health.service';
import { VkParsingOwnershipService } from './vk-parsing-ownership.service';
import { VkPublishService } from './vk-publish.service';
import { vkAutoDeleteCandidatesQuery, type VkAutoDeleteCursor } from './vk-auto-delete';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('VK timed deletion with PostgreSQL', () => {
  let db: PrismaClient;
  let chatId: string;
  let sourceId: string;
  let services: VkPublishService[];
  let postSequence = 100000;
  const botId = `vk-delete-${randomUUID()}`;
  const context = { version: 1, dialogBotId: botId, buttons: [], reference: null };
  const queue = {
    add: jest.fn().mockResolvedValue(undefined),
    getJob: jest.fn().mockResolvedValue(null),
  };
  const runtime = { assertDispatchEnabled: jest.fn() } satisfies Pick<
    PublisherRuntimeBoundaryService,
    'assertDispatchEnabled'
  >;
  const health = {
    assertDispatchAllowed: async () => undefined,
    isGloballyPaused: async () => false,
    recordSendFailure: async () => 'transient' as const,
    recordSendSuccess: async () => undefined,
  } satisfies Pick<
    PublisherDispatchHealthService,
    'assertDispatchAllowed' | 'isGloballyPaused' | 'recordSendFailure' | 'recordSendSuccess'
  >;
  type DeleteMessage = MaxClientService['deleteMessage'];
  const max = { deleteMessage: jest.fn<ReturnType<DeleteMessage>, Parameters<DeleteMessage>>() };
  const createService = () => {
    const config = new ConfigService({
      MAX_PUBLISHER_BOT_ID: botId,
      MAX_PUBLISHER_DISPATCH_ENABLED: true,
    });
    const service = new VkPublishService(
      db as never,
      {} as never,
      max as never,
      {} as never,
      {} as never,
      config,
      new VkParsingOwnershipService(config),
      undefined,
      undefined,
      queue as never,
      undefined,
      runtime as never,
      health as never,
    );
    services.push(service);
    return service;
  };
  const postData = (
    overrides: Partial<Prisma.VkParsingPostCreateManyInput> = {},
  ): Prisma.VkParsingPostCreateManyInput => ({
    id: randomUUID(),
    chatId,
    sourceId,
    ownerProfile: 'PUBLISHER',
    ownerBotId: botId,
    vkOwnerId: -123,
    vkPostId: ++postSequence,
    url: 'https://vk.com/wall-123_1',
    status: 'PUBLISHED',
    dispatchProfile: 'PUBLIK_V1',
    requiredBotId: botId,
    publishedBotId: botId,
    publishedMessageId: randomUUID(),
    publishedAtMax: new Date(Date.now() - 120_000),
    dialogBotId: botId,
    publishDialogContext: context,
    publicationPolicyRevision: 1,
    autoDeleteAt: new Date(Date.now() - 60_000),
    ...overrides,
  });

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('VK deletion tests require a local disposable race_test database');
    db = createPrismaClient(databaseUrl, { max: 4, statement_timeout: 10_000 });
    await db.$connect();
    expect(await db.$queryRawUnsafe('SHOW TimeZone')).toEqual([{ TimeZone: 'UTC' }]);
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    runtime.assertDispatchEnabled.mockReset();
    queue.add.mockReset().mockResolvedValue(undefined);
    max.deleteMessage.mockReset().mockResolvedValue(undefined);
    services = [];
    chatId = `vk-delete-chat-${randomUUID()}`;
    await db.chat.create({ data: { id: chatId, title: 'Synthetic timer test' } });
    sourceId = (
      await db.vkParsingSource.create({
        data: {
          chatId,
          ownerProfile: 'PUBLISHER',
          ownerBotId: botId,
          ownerId: 123,
          wallOwnerId: -123,
          screenName: 'synthetic',
          title: 'Synthetic source',
          url: 'https://vk.com/synthetic',
          createdByUserId: 'synthetic',
        },
      })
    ).id;
  });
  afterEach(async () => {
    for (const service of services) service.onModuleDestroy();
    await db.chat.deleteMany({ where: { id: chatId } });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  it('claims a due exact message once across concurrent pollers and confirms its deletion', async () => {
    const due = await db.vkParsingPost.create({ data: postData() });
    await db.vkParsingPost.createMany({
      data: [
        postData({ autoDeleteAt: null }),
        postData({ autoDeleteAt: new Date(Date.now() + 3600_000) }),
        postData({ status: 'FAILED', lastError: '[max.send_ambiguous] unknown' }),
        postData({ rollbackDeletedAt: new Date() }),
      ],
    });
    const first = createService(),
      second = createService();
    await Promise.all([first.enqueueDueAutoDeletes(), second.enqueueDueAutoDeletes()]);
    expect(queue.add).toHaveBeenCalledTimes(1);
    const job = queue.add.mock.calls[0]![1];
    expect(job).toMatchObject({
      kind: 'rollback-delete',
      postId: due.id,
      messageId: due.publishedMessageId,
      requiredBotId: botId,
    });
    expect(max.deleteMessage).not.toHaveBeenCalled();
    await first.processPublisherRollbackJob(job);
    expect(max.deleteMessage).toHaveBeenCalledTimes(1);
    expect(max.deleteMessage).toHaveBeenCalledWith(
      chatId,
      due.publishedMessageId,
      expect.objectContaining({ botId, immediate: true }),
    );
    expect(
      (await db.vkParsingPost.findUniqueOrThrow({ where: { id: due.id } })).rollbackDeletedAt,
    ).not.toBeNull();
    await second.enqueueDueAutoDeletes();
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('recovers a committed timer intent after queue failure without changing its message or deadline', async () => {
    const due = await db.vkParsingPost.create({ data: postData() });
    queue.add.mockRejectedValueOnce(new Error('queue unavailable'));
    await createService().enqueueDueAutoDeletes();
    const armed = await db.vkParsingPost.findUniqueOrThrow({ where: { id: due.id } });
    expect(armed.rollbackIdempotencyKey).not.toBeNull();
    expect(armed.autoDeleteAt).toEqual(due.autoDeleteAt);
    queue.add.mockClear();
    await createService().recoverStalePublisherRollbackJobs();
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0]![1]).toMatchObject({
      postId: due.id,
      messageId: due.publishedMessageId,
      idempotencyKey: armed.rollbackIdempotencyKey,
    });
  });

  it('retains a failed deletion for recovery and does not invent a success', async () => {
    const due = await db.vkParsingPost.create({ data: postData() });
    const service = createService();
    await service.enqueueDueAutoDeletes();
    max.deleteMessage.mockRejectedValueOnce(new Error('MAX timeout'));
    await expect(service.processPublisherRollbackJob(queue.add.mock.calls[0]![1])).rejects.toThrow(
      'MAX timeout',
    );
    expect(await db.vkParsingPost.findUniqueOrThrow({ where: { id: due.id } })).toMatchObject({
      publishedMessageId: due.publishedMessageId,
      rollbackDeletedAt: null,
      rollbackIdempotencyKey: expect.any(String),
    });
  });

  it('keeps due selection bounded with retained history and advances past ineligible candidates', async () => {
    const at = new Date(Date.now() - 60_000);
    await db.vkParsingPost.createMany({
      data: Array.from({ length: 5000 }, (_, i) =>
        postData({
          vkPostId: i + 100,
          autoDeleteAt: null,
          raw: { text: 'x'.repeat(1000) },
        }),
      ),
    });
    await db.vkParsingPost.createMany({
      data: Array.from({ length: 75 }, (_, i) =>
        postData({
          id: `timer-${String(i).padStart(3, '0')}`,
          vkPostId: i + 10000,
          autoDeleteAt: at,
          status: i < 50 ? 'FAILED' : 'PUBLISHED',
        }),
      ),
    });
    await db.$executeRawUnsafe('ANALYZE vk_parsing_posts');
    const query = vkAutoDeleteCandidatesQuery(botId, new Date(), null);
    const candidates = await db.$queryRaw<VkAutoDeleteCursor[]>(query);
    expect(candidates).toHaveLength(50);
    type Plan = {
      'Node Type': string;
      'Actual Rows': number;
      'Rows Removed by Filter'?: number;
      'Shared Hit Blocks': number;
      'Shared Read Blocks': number;
      Plans?: Plan[];
    };
    for (const selected of [
      query,
      vkAutoDeleteCandidatesQuery(botId, new Date(), candidates.at(-1)!),
    ]) {
      const plans = await db.$queryRaw<Array<{ 'QUERY PLAN': Array<{ Plan: Plan }> }>>(
        Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${selected}`,
      );
      expect(JSON.stringify(plans)).toContain('vk_parsing_posts_auto_delete_due_idx');
      const plan = plans[0]!['QUERY PLAN'][0]!.Plan;
      const check = (node: Plan): void => {
        expect(node['Actual Rows']).toBeLessThanOrEqual(50);
        expect(node['Rows Removed by Filter'] ?? 0).toBe(0);
        expect(node['Node Type']).not.toMatch(/Seq Scan|Sort/u);
        for (const child of node.Plans ?? []) check(child);
      };
      check(plan);
      expect(plan['Shared Hit Blocks'] + plan['Shared Read Blocks']).toBeLessThanOrEqual(120);
    }
    const service = createService();
    expect(await service.enqueueDueAutoDeletes()).toBe(0);
    expect(await service.enqueueDueAutoDeletes()).toBe(25);
    expect(queue.add).toHaveBeenCalledTimes(25);
  });
});
