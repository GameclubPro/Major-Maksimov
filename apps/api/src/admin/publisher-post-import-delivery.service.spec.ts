import { PublisherPostImportStatus } from '../prisma/prisma-client';
import { PublisherPostImportDeliveryService } from './publisher-post-import-delivery.service';

describe('PublisherPostImportDeliveryService', () => {
  it('keeps the latest count pending when a message arrives during the first confirmed collection send', async () => {
    const inputs = [{ messageId: 'first', webhookEventId: 'r1' }];
    const row = {
      id: 'session',
      publisherBotId: 'publik',
      privateChatId: '42',
      startToken: 'token',
      status: PublisherPostImportStatus.WAITING,
      inputMode: 'collection',
      inputMessages: inputs,
      notificationPending: true,
      notificationKind: 'collected',
      botStatusMessageId: null,
    };
    const update = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    const send = jest.fn(
      async (_chat: string, _text: string, options: { beforeSend: () => Promise<void> }) => {
        await options.beforeSend();
        return { messageId: 'confirmed-message' };
      },
    );
    const service = new PublisherPostImportDeliveryService(
      {
        publisherPostImportSession: {
          findUnique: jest.fn().mockResolvedValue(row),
          updateMany: update,
        },
      } as never,
      { sendMessageImmediateWithId: send } as never,
    );
    await service.deliver({
      version: 1,
      kind: 'notify',
      sessionId: 'session',
      notification: 'collected',
      requestedAt: new Date().toISOString(),
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[2][0]).toMatchObject({
      where: { notificationKind: 'collected', inputMessages: { equals: inputs } },
      data: { notificationPending: false },
    });
    const carry = update.mock.calls[3][0];
    expect(carry.where.notificationLockToken).toBe(
      update.mock.calls[2][0].where.notificationLockToken,
    );
    expect(carry.data.botStatusMessageId).toBe('confirmed-message');
    expect(carry.data).not.toHaveProperty('notificationPending');
  });
  it('builds the ready mini app link against the exact Publisher bot and exact draft', async () => {
    const publisherPostImportSession = {
      findUnique: jest.fn().mockResolvedValue({
        id: 'session-1',
        publisherBotId: 'se14088825_bot',
        startToken: 'start-token-1',
        status: PublisherPostImportStatus.READY,
        privateChatId: '42',
        publicationId: 'publication-1',
        failureCode: null,
        botStatusMessageId: null,
        notificationPending: true,
        notificationKind: 'ready',
        notificationLockedAt: null,
        notificationLockToken: null,
        notificationDispatchStartedAt: null,
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const maxClient = {
      sendMessageImmediateWithId: jest.fn().mockResolvedValue({ messageId: 'status-message-1' }),
    };
    const service = new PublisherPostImportDeliveryService(
      { publisherPostImportSession } as never,
      maxClient as never,
    );

    await service.deliver({
      version: 1,
      kind: 'notify',
      sessionId: 'session-1',
      notification: 'ready',
      requestedAt: '2026-08-28T12:00:00.000Z',
    });

    const sendOptions = maxClient.sendMessageImmediateWithId.mock.calls[0]?.[2];
    const url = sendOptions.buttons[0][0].url as string;
    expect(url).toMatch(/^https:\/\/max\.ru\/se14088825_bot\?startapp=/u);
    const startParam = new URL(url).searchParams.get('startapp');
    expect(startParam).toBe('pi_start-token-1');
  });

  it('sends ready as a new message when an earlier status message exists', async () => {
    const publisherPostImportSession = {
      findUnique: jest.fn().mockResolvedValue({
        id: 'session-1',
        publisherBotId: 'se14088825_bot',
        startToken: 'start-token-1',
        status: PublisherPostImportStatus.READY,
        privateChatId: '42',
        publicationId: 'publication-1',
        failureCode: null,
        botStatusMessageId: 'status-message-1',
        notificationPending: true,
        notificationKind: 'ready',
        notificationLockedAt: null,
        notificationLockToken: null,
        notificationDispatchStartedAt: null,
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const maxClient = {
      editMessageInlineKeyboard: jest.fn(),
      sendMessageImmediateWithId: jest
        .fn()
        .mockImplementation(
          async (_chatId: string, _text: string, options: { beforeSend?: () => Promise<void> }) => {
            await options.beforeSend?.();
            return { messageId: 'ready-message-1' };
          },
        ),
    };
    const service = new PublisherPostImportDeliveryService(
      { publisherPostImportSession } as never,
      maxClient as never,
    );

    await service.deliver({
      version: 1,
      kind: 'notify',
      sessionId: 'session-1',
      notification: 'ready',
      requestedAt: '2026-08-28T12:00:00.000Z',
    });

    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      '42',
      'Черновик готов',
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: 'Открыть черновик' })]],
        beforeSend: expect.any(Function),
      }),
      expect.objectContaining({ botId: 'se14088825_bot' }),
    );
  });

  it('sends a failed result as a new message when an earlier status message exists', async () => {
    const publisherPostImportSession = {
      findUnique: jest.fn().mockResolvedValue({
        id: 'session-1',
        publisherBotId: 'se14088825_bot',
        startToken: 'start-token-1',
        status: PublisherPostImportStatus.FAILED,
        privateChatId: '42',
        publicationId: null,
        failureCode: 'unsupported_content',
        botStatusMessageId: 'status-message-1',
        notificationPending: true,
        notificationKind: 'failed',
        notificationLockedAt: null,
        notificationLockToken: null,
        notificationDispatchStartedAt: null,
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const maxClient = {
      editMessageInlineKeyboard: jest.fn(),
      sendMessageImmediateWithId: jest
        .fn()
        .mockImplementation(
          async (_chatId: string, _text: string, options: { beforeSend?: () => Promise<void> }) => {
            await options.beforeSend?.();
            return { messageId: 'failed-message-1' };
          },
        ),
    };
    const service = new PublisherPostImportDeliveryService(
      { publisherPostImportSession } as never,
      maxClient as never,
    );

    await service.deliver({
      version: 1,
      kind: 'notify',
      sessionId: 'session-1',
      notification: 'failed',
      requestedAt: '2026-08-28T12:00:00.000Z',
    });

    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithId).toHaveBeenCalledWith(
      '42',
      expect.stringContaining('добавьте файлы'),
      expect.objectContaining({
        buttons: [
          [
            expect.objectContaining({
              text: 'Открыть редактор',
              url: expect.stringContaining('startapp=pi_'),
            }),
          ],
        ],
        beforeSend: expect.any(Function),
      }),
      expect.objectContaining({ botId: 'se14088825_bot' }),
    );
  });

  it('keeps processing as an edit with a stable accepted status', async () => {
    const publisherPostImportSession = {
      findUnique: jest.fn().mockResolvedValue({
        id: 'session-1',
        publisherBotId: 'se14088825_bot',
        startToken: 'start-token-1',
        status: PublisherPostImportStatus.PROCESSING,
        privateChatId: '42',
        publicationId: null,
        failureCode: null,
        botStatusMessageId: 'status-message-1',
        notificationPending: true,
        notificationKind: 'processing',
        notificationLockedAt: null,
        notificationLockToken: null,
        notificationDispatchStartedAt: null,
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const maxClient = {
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
      sendMessageImmediateWithId: jest.fn(),
    };
    const service = new PublisherPostImportDeliveryService(
      { publisherPostImportSession } as never,
      maxClient as never,
    );

    await service.deliver({
      version: 1,
      kind: 'notify',
      sessionId: 'session-1',
      notification: 'processing',
      requestedAt: '2026-08-28T12:00:00.000Z',
    });

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      '42',
      'status-message-1',
      'Пост принят',
      expect.objectContaining({ buttons: [] }),
      expect.objectContaining({ botId: 'se14088825_bot' }),
    );
    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
  });

  it('does not reclaim a fresh notification lease', async () => {
    const publisherPostImportSession = {
      findUnique: jest.fn().mockResolvedValue({
        id: 'session-1',
        publisherBotId: 'se14088825_bot',
        startToken: 'start-token-1',
        status: PublisherPostImportStatus.READY,
        privateChatId: '42',
        publicationId: 'publication-1',
        failureCode: null,
        botStatusMessageId: null,
        notificationPending: true,
        notificationKind: 'ready',
        notificationLockedAt: new Date(),
        notificationLockToken: 'other-worker',
        notificationDispatchStartedAt: null,
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    };
    const maxClient = { sendMessageImmediateWithId: jest.fn() };
    const service = new PublisherPostImportDeliveryService(
      { publisherPostImportSession } as never,
      maxClient as never,
    );

    await service.deliver({
      version: 1,
      kind: 'notify',
      sessionId: 'session-1',
      notification: 'ready',
      requestedAt: '2026-08-28T12:00:00.000Z',
    });

    expect(maxClient.sendMessageImmediateWithId).not.toHaveBeenCalled();
    expect(publisherPostImportSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          notificationPending: true,
          notificationKind: 'ready',
          notificationDispatchStartedAt: null,
          OR: expect.any(Array),
        }),
      }),
    );
  });

  it('does not retry an ambiguous terminal send after dispatch starts', async () => {
    const publisherPostImportSession = {
      findUnique: jest.fn().mockResolvedValue({
        id: 'session-1',
        publisherBotId: 'se14088825_bot',
        startToken: 'start-token-1',
        status: PublisherPostImportStatus.READY,
        privateChatId: '42',
        publicationId: 'publication-1',
        failureCode: null,
        botStatusMessageId: 'status-message-1',
        notificationPending: true,
        notificationKind: 'ready',
        notificationLockedAt: null,
        notificationLockToken: null,
        notificationDispatchStartedAt: null,
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const maxClient = {
      editMessageInlineKeyboard: jest.fn(),
      sendMessageImmediateWithId: jest.fn(
        async (_chatId: string, _text: string, options: { beforeSend?: () => Promise<void> }) => {
          await options.beforeSend?.();
          throw new Error('timeout after dispatch');
        },
      ),
    };
    const service = new PublisherPostImportDeliveryService(
      { publisherPostImportSession } as never,
      maxClient as never,
    );

    await expect(
      service.deliver({
        version: 1,
        kind: 'notify',
        sessionId: 'session-1',
        notification: 'ready',
        requestedAt: '2026-08-28T12:00:00.000Z',
      }),
    ).resolves.toBeUndefined();

    expect(publisherPostImportSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          notificationPending: false,
          lastNotifiedStatus: `AMBIGUOUS:${PublisherPostImportStatus.READY}`,
        }),
      }),
    );
    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
  });

  it('releases a terminal notification claim when sending fails before dispatch', async () => {
    const publisherPostImportSession = {
      findUnique: jest.fn().mockResolvedValue({
        id: 'session-1',
        publisherBotId: 'se14088825_bot',
        startToken: 'start-token-1',
        status: PublisherPostImportStatus.FAILED,
        privateChatId: '42',
        publicationId: null,
        failureCode: 'internal_error',
        botStatusMessageId: 'status-message-1',
        notificationPending: true,
        notificationKind: 'failed',
        notificationLockedAt: null,
        notificationLockToken: null,
        notificationDispatchStartedAt: null,
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    };
    const maxClient = {
      editMessageInlineKeyboard: jest.fn(),
      sendMessageImmediateWithId: jest.fn().mockRejectedValue(new Error('before dispatch')),
    };
    const service = new PublisherPostImportDeliveryService(
      { publisherPostImportSession } as never,
      maxClient as never,
    );

    await expect(
      service.deliver({
        version: 1,
        kind: 'notify',
        sessionId: 'session-1',
        notification: 'failed',
        requestedAt: '2026-08-28T12:00:00.000Z',
      }),
    ).rejects.toThrow('before dispatch');

    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(publisherPostImportSession.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'session-1',
          notificationDispatchStartedAt: null,
          notificationLockToken: expect.any(String),
        }),
        data: { notificationLockedAt: null, notificationLockToken: null },
      }),
    );
  });
});
