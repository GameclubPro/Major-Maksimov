import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { createPrismaClient, type PrismaClient } from '../prisma/prisma-client';
import {
  PublisherCommentNotificationService,
  PUBLISHER_COMMENT_ACTION,
} from './publisher-comment-notification.service';
import { PublisherCommentNotificationDeliveryService } from './publisher-comment-notification-delivery.service';
import type { PublisherCommentNotificationJob } from './publisher-chat-comment.queue';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const postgres = databaseUrl ? describe : describe.skip;
jest.setTimeout(30_000);

postgres('Publisher comment notification outbox on PostgreSQL', () => {
  let db: PrismaClient;
  let botId: string;
  let chatId: string;
  let service: PublisherCommentNotificationService;
  let delivery: PublisherCommentNotificationDeliveryService;
  const queue = { enqueueNotification: jest.fn() };
  const sent = jest.fn();
  let beforeSendHook: (() => Promise<void>) | null = null;
  const env = { role: process.env.APP_ROLE, name: process.env.APP_SERVICE_NAME };
  const target = () => ({ entityType: 'chat' as const, chatId, threadId: 'thread-1' });
  const job = (eventId: string): PublisherCommentNotificationJob => ({
    version: 1,
    kind: 'deliver_notification',
    eventId,
    requiredBotId: botId,
    idempotencyKey: eventId,
    sourceTag: 'comment_notification',
    retryPolicyName: 'publisher-chat-comment',
    createdAt: new Date().toISOString(),
  });

  async function comment(authorUserId: string, replyToId: string | null = null) {
    return db.$transaction(async (tx) => {
      const row = await tx.auditLog.create({
        data: {
          chatId,
          actorUserId: authorUserId,
          action: PUBLISHER_COMMENT_ACTION,
          payload: {
            publisherProfile: true,
            threadId: 'thread-1',
            text: 'Тест уведомления',
            authorDisplayName: 'Автор',
          },
        },
      });
      await service.recordComment(tx, {
        ...target(),
        id: row.id,
        authorUserId,
        replyToId,
        createdAt: row.createdAt,
      });
      return row;
    });
  }

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test database required');
    db = createPrismaClient(databaseUrl, { max: 6, statement_timeout: 10_000 });
    await db.$connect();
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
  });

  beforeEach(async () => {
    botId = `publisher-notify-${randomUUID()}`;
    chatId = `notify-${randomUUID()}`;
    await db.chat.create({ data: { id: chatId, title: 'Notification test', entityType: 'CHAT' } });
    beforeSendHook = null;
    queue.enqueueNotification.mockReset().mockResolvedValue(undefined);
    sent.mockReset().mockResolvedValue({ messageId: 'remote-1' });
    service = new PublisherCommentNotificationService(
      db as never,
      new ConfigService({ MAX_PUBLISHER_BOT_ID: botId }),
      queue as never,
    );
    delivery = new PublisherCommentNotificationDeliveryService(
      db as never,
      service,
      queue as never,
      {
        sendMessageImmediateToUser: async (
          userId: string,
          text: string,
          options: { beforeSend: () => Promise<void> },
          request: unknown,
        ) => {
          await beforeSendHook?.();
          await options.beforeSend();
          return sent(userId, text, options, request);
        },
      } as never,
      {
        getBotId: () => botId,
        buildChatDialogButton: () => ({
          type: 'link',
          text: 'Открыть комментарии',
          url: `https://max.ru/${botId}?startapp=test`,
        }),
      } as never,
      { assertEntityReady: async () => ({ requiredBotId: botId, entityType: 'chat' }) } as never,
      { dispatchEnabled: true, assertDispatchEnabled: () => {} } as never,
      { assertAttested: async () => {} } as never,
      { assertDispatchAllowed: async () => {} } as never,
      {} as never,
    );
  });

  afterEach(async () => {
    await db.publisherCommentNotificationEvent.deleteMany({ where: { botId } });
    await db.publisherCommentNotificationPreference.deleteMany({ where: { botId } });
    await db.auditLog.deleteMany({ where: { chatId } });
    await db.chat.delete({ where: { id: chatId } });
  });

  afterAll(async () => {
    if (env.role === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = env.role;
    if (env.name === undefined) delete process.env.APP_SERVICE_NAME;
    else process.env.APP_SERVICE_NAME = env.name;
    await db?.$disconnect();
  });

  it('sends one reply even with overlapping ALL subscriptions; excludes the author and explicit OFF', async () => {
    const parent = await comment('recipient');
    await service.updateSettings(target(), 'recipient', 'all', 'channel');
    await service.updateSettings(target(), 'recipient', 'all', 'thread');
    await service.updateSettings(target(), 'muted', 'all', 'channel');
    await service.updateSettings(target(), 'muted', 'off', 'thread');
    await service.updateSettings(target(), 'author', 'all', 'thread');
    const row = await comment('author', parent.id);
    await Promise.all([delivery.process(job(row.id)), delivery.process(job(row.id))]);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(sent).toHaveBeenCalledWith(
      'recipient',
      expect.stringContaining('Ответ на ваш комментарий'),
      expect.anything(),
      expect.objectContaining({ botId }),
    );
    await delivery.process(job(row.id));
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('keeps old owner authority for global subscriptions until explicit revocation', async () => {
    await db.chat.update({ where: { id: chatId }, data: { catalogKind: 'MANAGED' } });
    await db.publisherEntityBinding.create({
      data: {
        chatId,
        publisherBotId: botId,
        status: 'ACTIVE',
        botAccessState: 'CONFIRMED_ADMIN',
      },
    });
    const edge = await db.managedEntityAccessEdge.create({
      data: {
        chatId,
        botId,
        userId: 'recipient',
        entityType: 'CHAT',
        state: 'GRANTED',
        userRole: 'OWNER',
        botRole: 'ADMIN',
        checkedAt: new Date(0),
        expiresAt: new Date(0),
        source: 'publisher_admin_roster',
      },
    });
    await service.updateSettings(target(), 'recipient', 'all', 'all_channels');
    expect(await service.canReceive(target(), 'recipient', false)).toBe(true);
    const where = { chatId_userId_botId: { chatId, userId: 'recipient', botId } };
    expect(await db.managedEntityAccessEdge.findUnique({ where })).toEqual(edge);
    await db.managedEntityAccessEdge.update({ where, data: { state: 'USER_DENIED' } });
    expect(await service.canReceive(target(), 'recipient', false)).toBe(false);
  });

  it('subscribes an older comment author to replies without re-enabling an explicit OFF', async () => {
    const old = await db.auditLog.create({
      data: {
        chatId,
        actorUserId: 'old-user',
        action: PUBLISHER_COMMENT_ACTION,
        payload: { publisherProfile: true, threadId: 'thread-1', text: 'Old comment' },
      },
    });
    const first = await comment('new-user', old.id);
    await delivery.process(job(first.id));
    expect(sent).toHaveBeenCalledTimes(1);
    await service.updateSettings(target(), 'old-user', 'off', 'thread');
    const second = await comment('new-user', old.id);
    await delivery.process(job(second.id));
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it('keeps comment, subscription and outbox atomic on rollback', async () => {
    await expect(
      db.$transaction(async (tx) => {
        const row = await tx.auditLog.create({
          data: { chatId, actorUserId: 'rollback', action: PUBLISHER_COMMENT_ACTION, payload: {} },
        });
        await service.recordComment(tx, {
          ...target(),
          id: row.id,
          authorUserId: 'rollback',
          replyToId: null,
          createdAt: row.createdAt,
        });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await db.auditLog.count({ where: { chatId } })).toBe(0);
    expect(await db.publisherCommentNotificationEvent.count({ where: { botId } })).toBe(0);
    expect(await db.publisherCommentNotificationPreference.count({ where: { botId } })).toBe(0);
  });

  it.each(['unsubscribe', 'delete'] as const)(
    'rechecks %s immediately before MAX dispatch',
    async (change) => {
      await service.updateSettings(target(), 'recipient', 'all', 'thread');
      const row = await comment('author');
      beforeSendHook = async () => {
        if (change === 'unsubscribe')
          await service.updateSettings(target(), 'recipient', 'off', 'thread');
        else await db.auditLog.delete({ where: { id: row.id } });
      };
      await delivery.process(job(row.id));
      expect(sent).not.toHaveBeenCalled();
      expect(
        await db.publisherCommentNotificationDelivery.findFirst({ where: { eventId: row.id } }),
      ).toMatchObject({ status: 'SKIPPED' });
    },
  );

  it.each([
    ['timeout', 'UNKNOWN'],
    ['403', 'FAILED'],
    ['429', 'PENDING'],
  ] as const)('handles %s without unsafe retries', async (error, status) => {
    await service.updateSettings(target(), 'recipient', 'all', 'thread');
    const row = await comment('author');
    sent.mockRejectedValue(
      error === 'timeout' ? new Error('timeout') : { response: { status: Number(error) } },
    );
    await delivery.process(job(row.id));
    expect(
      await db.publisherCommentNotificationDelivery.findFirst({ where: { eventId: row.id } }),
    ).toMatchObject({ status, attempts: 1 });
    sent.mockResolvedValue({ messageId: 'remote-2' });
    await db.publisherCommentNotificationDelivery.updateMany({
      where: { eventId: row.id },
      data: { availableAt: new Date(0) },
    });
    await delivery.process(job(row.id));
    expect(sent).toHaveBeenCalledTimes(status === 'PENDING' ? 2 : 1);
  });

  it.each([408, 500, 503, 504])(
    'never resends a notification after wrapped HTTP %s uncertainty',
    async (status) => {
      await service.updateSettings(target(), 'recipient', 'all', 'thread');
      const row = await comment('author');
      sent.mockRejectedValueOnce(
        new Error('MAX operation failed', { cause: { response: { status } } }),
      );
      await delivery.process(job(row.id));
      expect(
        await db.publisherCommentNotificationDelivery.findFirst({ where: { eventId: row.id } }),
      ).toMatchObject({ status: 'UNKNOWN', attempts: 1 });
      await db.publisherCommentNotificationDelivery.updateMany({
        where: { eventId: row.id },
        data: { availableAt: new Date(0) },
      });
      await delivery.process(job(row.id));
      expect(sent).toHaveBeenCalledTimes(1);
    },
  );

  it('recovers a lost queue job from the outbox and fences a stalled send', async () => {
    await service.updateSettings(target(), 'recipient', 'all', 'thread');
    const row = await comment('author');
    queue.enqueueNotification.mockRejectedValueOnce(new Error('Redis unavailable'));
    await service.enqueue(row.id);
    await delivery.recoverOnce();
    expect(queue.enqueueNotification).toHaveBeenLastCalledWith(row.id);
    await db.publisherCommentNotificationDelivery.create({
      data: { eventId: row.id, userId: 'recipient', status: 'SENDING', sendStartedAt: new Date() },
    });
    await delivery.process(job(row.id));
    expect(sent).not.toHaveBeenCalled();
    expect(
      await db.publisherCommentNotificationDelivery.findFirst({ where: { eventId: row.id } }),
    ).toMatchObject({ status: 'UNKNOWN' });
  });

  it('does not send again when the receipt cannot be persisted after MAX success', async () => {
    await service.updateSettings(target(), 'recipient', 'all', 'thread');
    const row = await comment('author');
    const original = db.publisherCommentNotificationDelivery.updateMany.bind(
      db.publisherCommentNotificationDelivery,
    );
    const spy = jest
      .spyOn(db.publisherCommentNotificationDelivery, 'updateMany')
      .mockImplementation((args) => {
        if (args?.data.status === 'SENT') throw new Error('receipt database outage');
        return original(args);
      });
    try {
      await expect(delivery.process(job(row.id))).rejects.toThrow('receipt database outage');
    } finally {
      spy.mockRestore();
    }
    expect(sent).toHaveBeenCalledTimes(1);
    await delivery.process(job(row.id));
    expect(sent).toHaveBeenCalledTimes(1);
    expect(
      await db.publisherCommentNotificationDelivery.findFirst({ where: { eventId: row.id } }),
    ).toMatchObject({ status: 'UNKNOWN' });
  });

  it('keeps recipients beyond the first bounded fanout page', async () => {
    await db.publisherCommentNotificationPreference.createMany({
      data: Array.from({ length: 105 }, (_, index) => ({
        botId,
        chatId,
        threadId: 'thread-1',
        entityType: 'CHAT',
        userId: `subscriber-${index}`,
        mode: 'ALL',
      })),
    });
    const row = await comment('author');
    for (let batch = 0; batch < 12; batch += 1) await delivery.process(job(row.id));
    expect(sent).toHaveBeenCalledTimes(105);
    expect(new Set(sent.mock.calls.map(([userId]) => userId)).size).toBe(105);
    expect(
      await db.publisherCommentNotificationEvent.findUnique({ where: { id: row.id } }),
    ).toMatchObject({ completed: true, expanded: true });
  });

  it('expires old notifications without dispatch', async () => {
    await service.updateSettings(target(), 'recipient', 'all', 'thread');
    const row = await comment('author');
    await db.publisherCommentNotificationEvent.update({
      where: { id: row.id },
      data: { expiresAt: new Date(0) },
    });
    await delivery.process(job(row.id));
    expect(sent).not.toHaveBeenCalled();
    expect(
      await db.publisherCommentNotificationEvent.findUnique({ where: { id: row.id } }),
    ).toMatchObject({ completed: true });
  });

  it('retains old uncertain receipts while cleaning terminal neighboring events', async () => {
    const uncertain = await comment('author');
    const terminal = await comment('author');
    await db.publisherCommentNotificationEvent.updateMany({
      where: { id: { in: [uncertain.id, terminal.id] } },
      data: { completed: true, expiresAt: new Date(0) },
    });
    await db.publisherCommentNotificationDelivery.createMany({
      data: [
        {
          eventId: uncertain.id,
          userId: 'recipient',
          status: 'UNKNOWN',
          sendStartedAt: new Date(0),
        },
        { eventId: terminal.id, userId: 'recipient', status: 'SENT', messageId: 'confirmed' },
      ],
    });
    await delivery.recoverOnce();
    expect(
      await db.publisherCommentNotificationEvent.findUnique({ where: { id: uncertain.id } }),
    ).not.toBeNull();
    expect(
      await db.publisherCommentNotificationEvent.findUnique({ where: { id: terminal.id } }),
    ).toBeNull();
    expect(
      await db.publisherCommentNotificationDelivery.findFirst({ where: { eventId: uncertain.id } }),
    ).toMatchObject({ status: 'UNKNOWN' });
    expect(sent).not.toHaveBeenCalled();
  });

  it('never reads Major preferences or another Publisher bot subscription', async () => {
    await db.dialogNotificationSubscription.create({
      data: { chatId, entityType: 'CHAT', threadId: 'thread-1', userId: 'major-user', mode: 'ALL' },
    });
    await db.publisherCommentNotificationPreference.create({
      data: {
        botId: 'other-bot',
        chatId,
        entityType: 'CHAT',
        threadId: 'thread-1',
        userId: 'other-user',
        mode: 'ALL',
      },
    });
    try {
      const row = await comment('author');
      await delivery.process(job(row.id));
      expect(sent).not.toHaveBeenCalled();
    } finally {
      await db.dialogNotificationSubscription.deleteMany({ where: { chatId } });
      await db.publisherCommentNotificationPreference.deleteMany({
        where: { chatId, botId: 'other-bot' },
      });
    }
  });
});
