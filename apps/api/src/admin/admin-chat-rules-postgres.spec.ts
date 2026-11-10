import { randomUUID } from 'node:crypto';
import { createPrismaAdapter, PrismaClient } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { publishChatRules, resetPublishedChatRules } from './admin-chat-rules';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const integration = databaseUrl ? describe : describe.skip;
type PublishParams = Parameters<typeof publishChatRules>[0];
type DeleteRulesMessage = NonNullable<PublishParams['deletePreviousPublishedMessage']>;
type SendRulesMessage = PublishParams['maxClient']['sendMessageImmediateWithResolvedLink'];

integration('chat rules publication after reset with PostgreSQL', () => {
  let db: PrismaClient;
  let chatId: string;
  const ids: string[] = [];
  const publishedAt = new Date('2026-11-01T10:00:00.000Z');
  const originalBotId = 'rules-original-bot';
  const nextBotId = 'rules-next-bot';
  const oldMessageId = 'rules-old';
  const newMessageId = 'rules-new';

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.includes('race_test')) {
      throw new Error('Disposable PostgreSQL required');
    }
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 4, statement_timeout: 15_000 }),
    });
  });

  beforeEach(async () => {
    chatId = `-${BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 13)}`)}`;
    ids.push(chatId);
    await db.chat.create({
      data: {
        id: chatId,
        title: 'Rules reset regression',
        entityType: 'CHAT',
        rules: {
          create: {
            text: 'Новые правила чата',
            publishedMessageId: oldMessageId,
            publishedBotId: originalBotId,
            publishedUrl: `https://max.ru/chats/${chatId}/message/${oldMessageId}`,
            publishedAt,
          },
        },
      },
    });
  });

  afterAll(async () => {
    if (!db) return;
    try {
      await db.chat.deleteMany({ where: { id: { in: ids } } });
    } finally {
      await db.$disconnect();
    }
  });

  function fixture() {
    const send = jest.fn<ReturnType<SendRulesMessage>, Parameters<SendRulesMessage>>();
    send.mockResolvedValue({
      messageId: newMessageId,
      url: `https://max.ru/chats/${chatId}/message/${newMessageId}`,
    });
    const deleteMessage = jest.fn<ReturnType<DeleteRulesMessage>, Parameters<DeleteRulesMessage>>();
    deleteMessage.mockResolvedValue('confirmed');
    const maxClient = {
      sendMessageImmediateWithResolvedLink: send,
      deleteMessage: jest.fn<
        ReturnType<PublishParams['maxClient']['deleteMessage']>,
        Parameters<PublishParams['maxClient']['deleteMessage']>
      >(),
      resolveMessageLink: jest.fn<
        ReturnType<PublishParams['maxClient']['resolveMessageLink']>,
        Parameters<PublishParams['maxClient']['resolveMessageLink']>
      >(),
      uploadImage: jest.fn<
        ReturnType<PublishParams['maxClient']['uploadImage']>,
        Parameters<PublishParams['maxClient']['uploadImage']>
      >(),
    } satisfies PublishParams['maxClient'];
    const common = {
      prisma: db as PrismaService,
      chatContextCache: { invalidate: jest.fn(async () => undefined) },
      logger: { warn: jest.fn() },
      maxClient,
      chatId,
      actorUserId: 'rules-test-admin',
      source: 'miniapp' as const,
      resolveBotId: () => nextBotId,
    };
    const publish = () =>
      publishChatRules({
        ...common,
        mode: 'new_message',
        buildAutofilledText: async () => 'Автоматические правила',
        buildFormattedText: async (text) => ({ text, textFormat: 'markdown' }),
        sendPrivateConfirmation: async () => undefined,
        deletePreviousPublishedMessage: deleteMessage,
      });
    const reset = () =>
      resetPublishedChatRules({ ...common, deletePublishedMessage: deleteMessage });
    return { send, deleteMessage, publish, reset };
  }

  async function markPendingReset() {
    return db.chatRules.update({
      where: { chatId },
      data: {
        pendingCleanupMessageId: oldMessageId,
        pendingCleanupBotId: originalBotId,
        pendingCleanupKind: 'reset_current',
      },
    });
  }

  it('confirms the original reset before sending and persisting one new post', async () => {
    await markPendingReset();
    const { send, deleteMessage, publish } = fixture();

    await expect(publish()).resolves.toMatchObject({
      operation: 'created',
      messageId: newMessageId,
    });

    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(deleteMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId,
        messageId: oldMessageId,
        botId: originalBotId,
        cleanupKind: 'reset_current',
      }),
    );
    expect(send).toHaveBeenCalledTimes(1);
    expect(deleteMessage.mock.invocationCallOrder[0]).toBeLessThan(
      send.mock.invocationCallOrder[0]!,
    );
    expect(await db.chatRules.findUniqueOrThrow({ where: { chatId } })).toMatchObject({
      text: 'Новые правила чата',
      publishedMessageId: newMessageId,
      publishedBotId: nextBotId,
      pendingCleanupMessageId: null,
      pendingCleanupKind: null,
      publishOperationId: null,
      publishSendStartedAt: null,
    });
    expect(await db.auditLog.count({ where: { chatId, action: 'PUBLISH_CHAT_RULES' } })).toBe(1);
  });

  it.each(['publication', 'send fence'] as const)(
    'preserves a newer %s committed while reset confirmation is outstanding',
    async (change) => {
      await markPendingReset();
      const { send, deleteMessage, publish } = fixture();
      const newerState =
        change === 'publication'
          ? {
              publishedMessageId: 'rules-newer',
              publishedBotId: 'rules-newer-bot',
              pendingCleanupMessageId: null,
              pendingCleanupBotId: null,
              pendingCleanupKind: null,
            }
          : {
              publishOperationId: 'newer-uncertain-send',
              publishOperationBotId: nextBotId,
              publishSendStartedAt: new Date(),
            };
      deleteMessage.mockImplementationOnce(async () => {
        await db.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM chats WHERE id = ${chatId} FOR UPDATE`;
          await tx.chatRules.update({ where: { chatId }, data: newerState });
        });
        return 'confirmed';
      });

      await expect(publish()).rejects.toThrow('Правила изменились');

      expect(send).not.toHaveBeenCalled();
      expect(await db.chatRules.findUniqueOrThrow({ where: { chatId } })).toMatchObject(newerState);
      expect(await db.auditLog.count({ where: { chatId, action: 'PUBLISH_CHAT_RULES' } })).toBe(0);
    },
  );

  it('retains an ambiguous send without even attempting reset confirmation', async () => {
    await markPendingReset();
    const before = await db.chatRules.update({
      where: { chatId },
      data: {
        publishOperationId: 'uncertain-send',
        publishOperationBotId: originalBotId,
        publishSendStartedAt: new Date(),
      },
    });
    const { send, deleteMessage, publish } = fixture();

    await expect(publish()).rejects.toThrow();

    expect(send).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(await db.chatRules.findUniqueOrThrow({ where: { chatId } })).toEqual(before);
  });

  it('keeps the published receipt when reset deletion is only accepted', async () => {
    const { send, deleteMessage, reset } = fixture();
    deleteMessage.mockResolvedValue('accepted');

    const result = await reset();
    const stored = await db.chatRules.findUniqueOrThrow({ where: { chatId } });
    expect(result).toMatchObject({
      publishedMessageId: oldMessageId,
      publishedAt: publishedAt.toISOString(),
      revision: stored.updatedAt.toISOString(),
    });

    expect(send).not.toHaveBeenCalled();
    expect(stored).toMatchObject({
      publishedMessageId: oldMessageId,
      pendingCleanupMessageId: oldMessageId,
      pendingCleanupBotId: originalBotId,
      pendingCleanupKind: 'reset_current',
    });
  });

  it('returns the settled reset when the durable worker finalizes before the request CAS', async () => {
    const { send, deleteMessage, reset } = fixture();
    deleteMessage.mockImplementationOnce(async () => {
      await db.chatRules.update({
        where: { chatId },
        data: {
          text: 'Черновик сохранён во время удаления',
          publishedMessageId: null,
          publishedBotId: null,
          publishedUrl: null,
          publishedAt: null,
          pendingCleanupMessageId: null,
          pendingCleanupBotId: null,
          pendingCleanupIntentId: null,
          pendingCleanupKind: null,
        },
      });
      return 'confirmed';
    });

    const result = await reset();
    const stored = await db.chatRules.findUniqueOrThrow({ where: { chatId } });
    expect(result).toMatchObject({
      text: 'Черновик сохранён во время удаления',
      publishedMessageId: null,
      publishedUrl: null,
      publishedAt: null,
      revision: stored.updatedAt.toISOString(),
    });

    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
    expect(stored).toMatchObject({
      text: 'Черновик сохранён во время удаления',
      publishedMessageId: null,
      pendingCleanupMessageId: null,
    });
  });

  it('returns the current draft and revision after this request finalizes the confirmed reset', async () => {
    const { send, deleteMessage, reset } = fixture();
    deleteMessage.mockImplementationOnce(async () => {
      await db.chatRules.update({
        where: { chatId },
        data: { text: 'Новый черновик, сохранённый во время удаления' },
      });
      return 'confirmed';
    });

    const result = await reset();
    const stored = await db.chatRules.findUniqueOrThrow({ where: { chatId } });

    expect(result).toMatchObject({
      text: 'Новый черновик, сохранённый во время удаления',
      publishedMessageId: null,
      publishedUrl: null,
      publishedAt: null,
      revision: stored.updatedAt.toISOString(),
    });
    expect(stored).toMatchObject({
      text: result.text,
      pendingCleanupMessageId: null,
      pendingCleanupKind: null,
      publishedMessageId: null,
    });
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });
});
