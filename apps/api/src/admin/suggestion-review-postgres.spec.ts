import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { ForbiddenException } from '@nestjs/common';
import { createPrismaClient, type PrismaClient } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { MaxClientService } from '../max/max-client.service';
import type { MaxBotLinkService } from '../max/max-bot-link.service';
import type { MaxBotRegistryService } from '../max/max-bot-registry.service';
import type { PublisherReadinessService } from '../publisher/publisher-readiness.service';
import type { PublisherDialogLinkService } from '../publisher/publisher-dialog-link.service';
import type { PublisherSuggestionAdminJob } from '../publisher/publisher-suggestion-admin.queue';
import type { AdminSuggestionDeliveryJob } from './admin-suggestion-delivery.queue';
import type { ManagedEntitiesService } from './managed-entities.service';
import type { PublisherPolicyService } from './publisher-policy.service';
import { PublisherSuggestionService } from './publisher-suggestion.service';
import type { ChannelDialogService } from './channel-dialog.service';
import type { ChannelPostSignatureService } from './channel-post-signature.service';
import { SuggestionReviewService } from './suggestion-review.service';
import { SuggestionReviewEffectsService } from './suggestion-review-effects.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL ?? '';
const native = databaseUrl && redisUrl ? describe : describe.skip;
const actor = { userId: '101', username: null, displayName: 'Редактор' };
const request = (text: string, expectedRevision = 0) => ({
  requestId: randomUUID(),
  text,
  expectedRevision,
});
jest.setTimeout(30_000);

native('suggestion review with PostgreSQL and Redis', () => {
  let db: PrismaClient;
  let major: Queue<AdminSuggestionDeliveryJob>;
  let publisher: Queue<PublisherSuggestionAdminJob>;
  let service: SuggestionReviewService;
  let effects: SuggestionReviewEffectsService;
  let send: jest.MockedFunction<MaxClientService['sendMessageImmediateToUser']>;
  let memberAccess: jest.MockedFunction<MaxClientService['getChatMemberAccess']>;
  let editedCards: string[];
  let authorize: jest.MockedFunction<ManagedEntitiesService['assertChannelAdminAccess']>;
  const chats: string[] = [];

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local race database required');
    const redis = new URL(redisUrl);
    if (!['localhost', '127.0.0.1', '::1'].includes(redis.hostname))
      throw new Error('Local Redis required');
    db = createPrismaClient(databaseUrl, { max: 6 });
    await db.$connect();
    const connection = {
      host: redis.hostname,
      port: Number(redis.port),
      db: Number(redis.pathname.slice(1) || 0),
    };
    major = new Queue(`suggestion-review-major-${randomUUID()}`, { connection });
    publisher = new Queue(`suggestion-review-publisher-${randomUUID()}`, { connection });
  });
  beforeEach(() => {
    editedCards = [];
    memberAccess = jest
      .fn<
        ReturnType<MaxClientService['getChatMemberAccess']>,
        Parameters<MaxClientService['getChatMemberAccess']>
      >()
      .mockImplementation(async (_chat, userId) => ({
        userId,
        isBot: false,
        isAdmin: true,
        isOwner: false,
        explicitPrivilegeEvidence: true,
        permissions: [],
      }));
    send = jest
      .fn<
        ReturnType<MaxClientService['sendMessageImmediateToUser']>,
        Parameters<MaxClientService['sendMessageImmediateToUser']>
      >()
      .mockImplementation(async (_id, _text, options) => {
        await options?.beforeSend?.();
        return { messageId: 'receipt-1', url: null };
      });
    authorize = jest
      .fn<
        ReturnType<ManagedEntitiesService['assertChannelAdminAccess']>,
        Parameters<ManagedEntitiesService['assertChannelAdminAccess']>
      >()
      .mockResolvedValue();
    const max = {
      sendMessageImmediateToUser: send,
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({ isAdmin: true }),
      getChatMemberAccess: memberAccess,
      editMessageInlineKeyboard: jest.fn(async (_chat, _message, _text, options) => {
        await options?.beforeEditMutation?.();
        editedCards.push(_message);
        return true;
      }),
    } satisfies Pick<
      MaxClientService,
      | 'sendMessageImmediateToUser'
      | 'getCurrentChatMemberAccess'
      | 'getChatMemberAccess'
      | 'editMessageInlineKeyboard'
    >;
    effects = new SuggestionReviewEffectsService(
      db as unknown as PrismaService,
      max as unknown as MaxClientService,
      {
        assertChatBotAccessProbeAllowed: jest.fn().mockResolvedValue({}),
        buildEntryMiniappStartUrlSync: () => 'https://max.ru/major?startapp=review',
        buildPublisherMiniappStartUrlSync: () => 'https://max.ru/publik?startapp=review',
      } as unknown as MaxBotLinkService,
      major,
      publisher,
      {
        getActionableBots: () => [{ id: 'major' }],
        isKnownBotUserId: () => false,
      } as unknown as MaxBotRegistryService,
      {
        assertEntityReady: jest.fn().mockResolvedValue({ requiredBotId: 'publisher' }),
      } as unknown as PublisherReadinessService,
    );
    service = new SuggestionReviewService(
      db as unknown as PrismaService,
      { assertChannelAdminAccess: authorize } as unknown as ManagedEntitiesService,
      { getEntity: jest.fn().mockResolvedValue({}) } as unknown as PublisherPolicyService,
      {} as PublisherSuggestionService,
      {} as ChannelDialogService,
      { getBotId: () => 'publisher' } as PublisherDialogLinkService,
      {
        preparePostText: jest.fn(async (_chat, content) => content),
      } as unknown as ChannelPostSignatureService,
      effects,
    );
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await db.chat.deleteMany({ where: { id: { in: chats.splice(0) } } });
    await major.drain(true);
    await publisher.drain(true);
  });
  afterAll(async () => {
    await major?.close();
    await publisher?.close();
    await db?.$disconnect();
  });

  async function seed(profile: 'moderation' | 'publisher' = 'moderation') {
    const chatId = `review-${randomUUID()}`;
    chats.push(chatId);
    await db.chat.create({ data: { id: chatId, title: 'Объявления' } });
    return db.auditLog.create({
      data: {
        chatId,
        actorUserId: '42',
        action:
          profile === 'publisher'
            ? 'PUBLISHER_CHANNEL_DIALOG_SUGGESTION'
            : 'CHANNEL_DIALOG_SUGGESTION',
        payload: {
          type: 'suggest',
          text: '  Цена 300 ₽\n\n',
          actorUserId: '42',
          authorDisplayName: 'Анна',
          authorProfileUrl: 'https://max.ru/anna',
          suggestionSourceBotId: 'major',
        },
      },
    });
  }
  const rejection = (extra = {}) => ({
    requestId: randomUUID(),
    expectedRevision: 0,
    notifyAuthor: true,
    reason: 'paid',
    contactUrl: 'https://max.ru/editor',
    ...extra,
  });

  it.each(['moderation', 'publisher'] as const)(
    'allows exactly one concurrent editor for %s and preserves author and original',
    async (profile) => {
      const row = await seed(profile);
      const results = await Promise.allSettled([
        service.save(row.id, profile, actor, request('  **Цена** 350 ₽\n\n')),
        service.save(
          row.id,
          profile,
          { userId: '102', username: null, displayName: null },
          request('Цена 400 ₽'),
        ),
      ]);
      expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
      const next = await service.get(row.id, profile, actor);
      expect(next.revision).toBe(1);
      expect(next.author.url).toBe('https://max.ru/anna');
      expect(next.originalText).toBe('  Цена 300 ₽\n\n');
      expect(next.previewText).toContain('[Анна](https://max.ru/anna)');
    },
  );
  it('atomically freezes a Publisher edit against a competing save', async () => {
    const row = await seed('publisher');
    const claimant = Object.assign(Object.create(PublisherSuggestionService.prototype), {
      prisma: db,
    }) as {
      claimPending: (
        id: string,
        chatId: string,
        user: typeof actor,
        action: 'publish',
        source: typeof row,
        editor: ReturnType<typeof request>,
      ) => Promise<unknown>;
    };
    const publish = request('  **Цена** 500 ₽\n\n');
    const [claim, save] = await Promise.allSettled([
      claimant.claimPending(row.id, row.chatId, actor, 'publish', row, publish),
      service.save(row.id, 'publisher', actor, request('Чужая правка')),
    ]);
    const current = await service.get(row.id, 'publisher', actor);
    if (claim.status === 'fulfilled' && claim.value) {
      expect(current.status).toBe('publishing');
      expect(current.text).toBe(publish.text);
      expect(save.status).toBe('rejected');
      const stored = await db.auditLog.findUniqueOrThrow({ where: { id: row.id } });
      expect((stored.payload as Record<string, unknown>).reviewPublicationText).toBe(
        'От подписчика [Анна](https://max.ru/anna)\n\n  **Цена** 500 ₽\n\n',
      );
    } else {
      expect(save.status).toBe('fulfilled');
      expect(current.status).toBe('pending');
      expect(current.text).toBe('Чужая правка');
    }
  });

  it('reopens completed sync for a late administrator card and preserves media on save', async () => {
    const row = await seed();
    const image = await db.channelSuggestionImageAsset.create({
      data: {
        auditLogId: row.id,
        position: 0,
        bytes: Buffer.from('image'),
        sizeBytes: 5,
        mimeType: 'image/png',
        fileName: 'original.png',
      },
    });
    await service.save(row.id, 'moderation', actor, request('Исправленная подпись'));
    expect(await db.channelSuggestionImageAsset.findUnique({ where: { id: image.id } })).toEqual(
      image,
    );
    await db.channelSuggestionAdminDelivery.create({
      data: {
        auditLogId: row.id,
        adminUserId: actor.userId,
        botKey: 'major',
        botId: 'major',
        privateChatId: 'private-admin',
        remoteMessageId: 'card-1',
        sentAt: new Date(),
        status: 'SENT',
      },
    });
    await effects.syncAfterDelivery(row.id, 'moderation');
    const sync = await db.suggestionReviewEffect.findFirstOrThrow({
      where: { suggestionId: row.id, kind: 'sync' },
    });
    await effects.process(sync.id, 'moderation');
    expect(
      (await db.suggestionReviewEffect.findUniqueOrThrow({ where: { id: sync.id } })).status,
    ).toBe('SENT');
    await db.channelSuggestionAdminDelivery.create({
      data: {
        auditLogId: row.id,
        adminUserId: '102',
        botKey: 'major',
        botId: 'major',
        privateChatId: 'private-late',
        remoteMessageId: 'card-2',
        sentAt: new Date(),
        status: 'SENT',
      },
    });
    await effects.syncAfterDelivery(row.id, 'moderation');
    expect(
      (await db.suggestionReviewEffect.findUniqueOrThrow({ where: { id: sync.id } })).status,
    ).toBe('PENDING');
    await effects.process(sync.id, 'moderation');
    expect(
      (await db.suggestionReviewEffect.findUniqueOrThrow({ where: { id: sync.id } })).status,
    ).toBe('SENT');
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['moderation', 'publisher'] as const)(
    'updates current %s administrators when another card recipient has lost access',
    async (profile) => {
      const row = await seed(profile);
      const botId = profile === 'publisher' ? 'publisher' : 'major';
      for (const adminUserId of ['removed', actor.userId]) {
        await db.channelSuggestionAdminDelivery.create({
          data: {
            auditLogId: row.id,
            adminUserId,
            botKey: botId,
            botId,
            privateChatId: `private-${adminUserId}`,
            remoteMessageId: `card-${adminUserId}`,
            sentAt: new Date(),
            status: 'SENT',
          },
        });
      }
      memberAccess.mockImplementation(async (_chat, userId) => ({
        userId,
        isBot: false,
        isAdmin: userId !== 'removed',
        isOwner: false,
        explicitPrivilegeEvidence: true,
        permissions: [],
      }));
      await service.save(row.id, profile, actor, request('Новая подпись'));
      const sync = await db.suggestionReviewEffect.findFirstOrThrow({
        where: { suggestionId: row.id, kind: 'sync' },
      });
      await effects.process(sync.id, profile, botId);
      expect(editedCards).toEqual([`card-${actor.userId}`]);
      expect(
        (await db.suggestionReviewEffect.findUniqueOrThrow({ where: { id: sync.id } })).status,
      ).toBe('SENT');
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('binds retries to actor/action/body, including after another successful save', async () => {
    const row = await seed();
    const first = request('Версия 1');
    await service.save(row.id, 'moderation', actor, first);
    await service.save(row.id, 'moderation', actor, request('Версия 2', 1));
    expect((await service.save(row.id, 'moderation', actor, first)).text).toBe('Версия 2');
    await expect(
      service.save(row.id, 'moderation', actor, { ...first, text: 'Подмена' }),
    ).rejects.toThrow('другого решения');
    await expect(
      service.save(
        row.id,
        'moderation',
        { userId: '102', username: null, displayName: null },
        first,
      ),
    ).rejects.toThrow('другого решения');
  });
  it('serializes saving against rejection and never creates a reply for a stale decision', async () => {
    const row = await seed();
    const results = await Promise.allSettled([
      service.save(row.id, 'moderation', actor, request('Исправленный текст')),
      service.reject(row.id, 'moderation', actor, rejection()),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const current = await service.get(row.id, 'moderation', actor);
    expect(
      await db.suggestionReviewEffect.count({ where: { suggestionId: row.id, kind: 'notify' } }),
    ).toBe(current.status === 'cancelled' ? 1 : 0);
  });
  it.each(['moderation', 'publisher'] as const)(
    'commits rejection before queuing, delivers once through the exact %s bot',
    async (profile) => {
      const row = await seed(profile);
      const body = rejection();
      await Promise.all([
        service.reject(row.id, profile, actor, body),
        service.reject(row.id, profile, actor, body),
      ]);
      const effect = await db.suggestionReviewEffect.findFirstOrThrow({
        where: { suggestionId: row.id, kind: 'notify' },
      });
      expect(
        await (profile === 'publisher' ? publisher : major).getJob(
          `suggestion-review-${effect.id}`,
        ),
      ).toBeTruthy();
      await effects.process(effect.id, profile === 'publisher' ? 'moderation' : 'publisher');
      expect(send).not.toHaveBeenCalled();
      await Promise.all([
        effects.process(effect.id, profile, effect.botId),
        effects.process(effect.id, profile, effect.botId),
      ]);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(
        '42',
        expect.stringContaining('Размещение такого объявления платное'),
        expect.objectContaining({
          buttons: [
            [{ type: 'link', text: 'Связаться с администратором', url: 'https://max.ru/editor' }],
          ],
        }),
        expect.objectContaining({ botId: profile === 'publisher' ? 'publisher' : 'major' }),
      );
      expect((await service.get(row.id, profile, actor)).notification).toBe('sent');
    },
  );
  it('retains the committed answer when Redis enqueue fails and recovers it later', async () => {
    const row = await seed();
    const enqueue = jest.spyOn(major, 'add').mockRejectedValueOnce(new Error('Redis unavailable'));
    const result = await service.reject(row.id, 'moderation', actor, rejection());
    expect(result.status).toBe('cancelled');
    enqueue.mockRestore();
    await effects.recover('moderation');
    const effect = await db.suggestionReviewEffect.findFirstOrThrow({
      where: { suggestionId: row.id },
    });
    expect(await major.getJob(`suggestion-review-${effect.id}`)).toBeTruthy();
  });
  it('never replays a send with an unknown outcome, including crash recovery', async () => {
    const row = await seed();
    await service.reject(row.id, 'moderation', actor, rejection());
    const effect = await db.suggestionReviewEffect.findFirstOrThrow({
      where: { suggestionId: row.id },
    });
    send.mockImplementationOnce(async (_id, _text, options) => {
      await options?.beforeSend?.();
      throw new Error('unknown transport outcome');
    });
    await effects.process(effect.id, 'moderation');
    expect((await service.get(row.id, 'moderation', actor)).notification).toBe('ambiguous');
    await effects.process(effect.id, 'moderation');
    expect(send).toHaveBeenCalledTimes(1);
    await db.suggestionReviewEffect.update({
      where: { id: effect.id },
      data: { status: 'SENDING', lockToken: 'crashed', lockedAt: new Date(Date.now() - 180_000) },
    });
    await effects.recover('moderation');
    expect((await service.get(row.id, 'moderation', actor)).notification).toBe('ambiguous');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('retries a failed positive receipt write without sending again', async () => {
    const row = await seed();
    await service.reject(row.id, 'moderation', actor, rejection());
    const effect = await db.suggestionReviewEffect.findFirstOrThrow({
      where: { suggestionId: row.id },
    });
    const update = db.suggestionReviewEffect.updateMany.bind(db.suggestionReviewEffect);
    let failed = false;
    jest.spyOn(db.suggestionReviewEffect, 'updateMany').mockImplementation((args) => {
      if (args?.data?.status === 'SENT' && !failed) {
        failed = true;
        throw new Error('DB disconnected after remote success');
      }
      return update(args);
    });
    await effects.process(effect.id, 'moderation');
    expect((await service.get(row.id, 'moderation', actor)).notification).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('bounds due recovery work with retained history using its migrated index', async () => {
    const row = await seed();
    await db.$executeRawUnsafe(
      `INSERT INTO suggestion_review_effects
      (id, suggestion_id, profile, bot_id, kind, revision, status, payload, updated_at)
      SELECT $1 || '-' || n, $1, 'moderation', 'major', 'sync', n, 'SENT', '{}', CURRENT_TIMESTAMP
      FROM generate_series(1, 12000) n`,
      row.id,
    );
    await db.suggestionReviewEffect.create({
      data: {
        suggestionId: row.id,
        profile: 'moderation',
        botId: 'major',
        kind: 'notify',
        revision: 0,
        payload: {},
      },
    });
    await db.$executeRawUnsafe('ANALYZE suggestion_review_effects');
    const plans = await db.$queryRawUnsafe<
      Array<{ 'QUERY PLAN': Array<{ Plan: Record<string, unknown> }> }>
    >(`EXPLAIN (ANALYZE, FORMAT JSON)
      SELECT id FROM suggestion_review_effects WHERE profile = 'moderation' AND status = 'PENDING'
      AND next_attempt_at <= CURRENT_TIMESTAMP ORDER BY next_attempt_at, id LIMIT 25`);
    const plan = JSON.stringify(plans);
    expect(plan).toContain('suggestion_review_effects_due_idx');
    expect(plan).not.toContain('Seq Scan');
  });

  it('rolls back the decision when its outbox insert fails', async () => {
    const row = await seed();
    jest.spyOn(effects, 'recordSync').mockRejectedValueOnce(new Error('transaction failure'));
    await expect(service.reject(row.id, 'moderation', actor, rejection())).rejects.toThrow();
    expect((await service.get(row.id, 'moderation', actor)).status).toBe('pending');
    expect(await db.suggestionReviewEffect.count({ where: { suggestionId: row.id } })).toBe(0);
  });
  it('denies a revoked administrator before mutation and rejects silently without a reply journal', async () => {
    const row = await seed();
    authorize.mockRejectedValueOnce(new ForbiddenException());
    await expect(service.save(row.id, 'moderation', actor, request('Подмена'))).rejects.toThrow();
    await service.reject(
      row.id,
      'moderation',
      actor,
      rejection({ notifyAuthor: false, reason: undefined, contactUrl: '' }),
    );
    expect(
      await db.suggestionReviewEffect.count({ where: { suggestionId: row.id, kind: 'notify' } }),
    ).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});
