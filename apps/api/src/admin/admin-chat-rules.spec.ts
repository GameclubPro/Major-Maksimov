import {
  describeChatRulesPublishError,
  isMaxMessageMissingError,
  publishChatRules,
  readChatRules,
  resetPublishedChatRules,
} from './admin-chat-rules';
import { extractSqlText } from './admin-service-test-support';

function withRulesTransactions<T extends object>(models: T) {
  const transactionClient = {
    ...models,
    $queryRaw: jest.fn().mockImplementation(async (...args: unknown[]) => {
      const sql = extractSqlText(args);
      if (/SELECT id FROM chats WHERE id =/u.test(sql)) return [{ id: 'chat-1' }];
      if (/clock_timestamp\(\) AT TIME ZONE 'UTC'/u.test(sql)) return [{ at: new Date() }];
      throw new Error('Unexpected rules transaction fixture query');
    }),
    $executeRaw: jest.fn().mockResolvedValue(1),
  };
  return {
    ...transactionClient,
    $transaction: jest.fn(async (callback: (tx: typeof transactionClient) => unknown) =>
      callback(transactionClient),
    ),
  };
}

function createRules() {
  return {
    id: 'rules-1',
    chatId: 'chat-1',
    text: 'Правила чата',
    textFormat: 'markdown',
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    autoTextEnabled: false,
    buttons: [],
    buttonEnabled: false,
    buttonUrl: '',
    buttonText: 'Открыть',
    adminContactButtonEnabled: false,
    adminContactButtonUrl: '',
    publishedMessageId: 'rules-old',
    publishedBotId: 'bot-old',
    publishedUrl: 'https://max.ru/chats/chat-1/message/rules-old',
    publishedAt: new Date('2026-07-15T10:00:00.000Z'),
    publishOperationId: null,
    publishOperationBotId: null,
    publishSendStartedAt: null,
    pendingCleanupMessageId: null,
    pendingCleanupBotId: null,
    pendingCleanupIntentId: null,
    pendingCleanupKind: null,
    createdAt: new Date('2026-07-01T10:00:00.000Z'),
    updatedAt: new Date('2026-07-15T10:00:00.000Z'),
  };
}

function createPublishFixture(editor?: jest.Mock) {
  const order: string[] = [];
  const prisma = withRulesTransactions({
    chatRules: {
      upsert: jest.fn().mockResolvedValue(createRules()),
      findUnique: jest.fn(),
      updateMany: jest.fn().mockImplementation(async (args: { where: Record<string, unknown> }) => {
        if (args.where.publishOperationId) {
          order.push('state');
        }
        return { count: 1 };
      }),
    },
    auditLog: {
      create: jest.fn().mockImplementation(async () => {
        order.push('audit');
        return { id: 'audit-1' };
      }),
    },
  });
  const maxClient = {
    ...(editor ? { replaceOwnMessage: editor } : {}),
    sendMessageImmediateWithResolvedLink: jest.fn().mockImplementation(async () => {
      order.push('send');
      return {
        messageId: 'rules-new',
        url: 'https://max.ru/chats/chat-1/message/rules-new',
      };
    }),
    uploadImage: jest.fn(),
    resolveMessageLink: jest.fn(),
    deleteMessage: jest.fn(),
  };
  const deletePreviousPublishedMessage = jest.fn().mockImplementation(async () => {
    order.push('cleanup');
    return 'accepted' as const;
  });
  const sendPrivateConfirmation = jest.fn().mockResolvedValue(undefined);
  const buildAutofilledText = jest.fn().mockResolvedValue('Autofilled');
  const publish = (mode?: 'new_message' | 'update') =>
    publishChatRules({
      prisma: prisma as never,
      chatContextCache: { invalidate: jest.fn().mockResolvedValue(undefined) },
      maxClient: maxClient as never,
      logger: { warn: jest.fn() },
      chatId: 'chat-1',
      actorUserId: 'owner-1',
      source: 'miniapp',
      mode,
      resolveBotId: () => 'bot-new',
      buildAutofilledText,
      buildFormattedText: async (text) => ({ text, textFormat: 'markdown' }),
      sendPrivateConfirmation,
      deletePreviousPublishedMessage,
    });
  return {
    buildAutofilledText,
    deletePreviousPublishedMessage,
    maxClient,
    order,
    prisma,
    publish,
    sendPrivateConfirmation,
  };
}

describe('admin chat rules MAX errors', () => {
  it.each([false, true])(
    'preserves saved text when publishing, autoTextEnabled=%s',
    async (autoTextEnabled) => {
      const { prisma, publish, maxClient, buildAutofilledText } = createPublishFixture();
      const text = 'Авторские правила. Антидубль настроен отдельно.';
      prisma.chatRules.upsert.mockResolvedValue({ ...createRules(), text, autoTextEnabled });
      await publish('new_message');
      expect(buildAutofilledText).not.toHaveBeenCalled();
      expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
        'chat-1',
        text,
        expect.any(Object),
        expect.any(Object),
      );
    },
  );

  it('autofills only an empty automatic draft', async () => {
    const { prisma, publish, maxClient, buildAutofilledText } = createPublishFixture();
    prisma.chatRules.upsert.mockResolvedValue({
      ...createRules(),
      text: '  ',
      autoTextEnabled: true,
    });
    await publish('new_message');
    expect(buildAutofilledText).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'chat-1',
      'Autofilled',
      expect.any(Object),
      expect.any(Object),
    );
  });

  it.each([false, true])(
    'explicitly publishes a new message without deleting prior posts, pending cleanup=%s',
    async (pending) => {
      const editor = jest.fn();
      const {
        prisma,
        publish,
        maxClient,
        deletePreviousPublishedMessage,
        sendPrivateConfirmation,
      } = createPublishFixture(editor);
      prisma.chatRules.upsert.mockResolvedValue({
        ...createRules(),
        ...(pending
          ? {
              pendingCleanupMessageId: 'rules-older',
              pendingCleanupBotId: 'removed-bot',
              pendingCleanupKind: 'republish_previous',
              pendingCleanupIntentId: 'old-intent',
            }
          : {}),
      });
      await expect(publish('new_message')).resolves.toMatchObject({
        operation: 'created',
        messageId: 'rules-new',
      });
      expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
      expect(editor).not.toHaveBeenCalled();
      expect(deletePreviousPublishedMessage).not.toHaveBeenCalled();
      expect(prisma.chatRules.updateMany.mock.calls[1][0].data).not.toHaveProperty(
        'pendingCleanupMessageId',
      );
      expect(prisma.chatRules.updateMany.mock.calls[1][0].data).not.toHaveProperty(
        'pendingCleanupIntentId',
      );
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            publicationMode: 'new_message',
            replacedPreviousPost: false,
            previousPublishedMessageId: null,
            previousCleanupOutcome: 'not_needed',
          }),
        }),
      });
      expect(sendPrivateConfirmation).toHaveBeenCalledWith(expect.any(String), 'created');
    },
  );

  it('explicitly updates the current post even without historical cleanup', async () => {
    const editor = jest.fn();
    const { publish, maxClient, sendPrivateConfirmation } = createPublishFixture(editor);
    await expect(publish('update')).resolves.toMatchObject({
      operation: 'updated',
      messageId: 'rules-old',
    });
    expect(editor).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(sendPrivateConfirmation).toHaveBeenCalledWith(expect.any(String), 'updated');
  });

  it.each([
    { publishOperationId: 'ambiguous-send' },
    { publishSendStartedAt: new Date() },
    { pendingCleanupKind: 'reset_current' },
    {
      pendingCleanupMessageId: 'different-message',
      pendingCleanupKind: 'reset_current',
    },
    {
      pendingCleanupMessageId: 'rules-old',
      pendingCleanupKind: 'reset_current',
      publishOperationId: 'ambiguous-send',
    },
  ])(
    'does not bypass an invalid reset or ambiguous publication for a new post: %o',
    async (override) => {
      const { prisma, publish, maxClient } = createPublishFixture();
      prisma.chatRules.upsert.mockResolvedValue({ ...createRules(), ...override });
      await expect(publish('new_message')).rejects.toThrow();
      expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    },
  );

  it.each([
    { messageId: 'rules-old', url: null },
    { messageId: 'rules-new', chatId: 'another-chat', url: null },
  ])('does not confirm a new publication for an unexpected MAX target: %o', async (receipt) => {
    const { prisma, publish, maxClient, sendPrivateConfirmation } = createPublishFixture();
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue(receipt);
    await expect(publish('new_message')).rejects.toThrow();
    expect(prisma.chatRules.updateMany).toHaveBeenCalledTimes(1);
    expect(sendPrivateConfirmation).not.toHaveBeenCalled();
  });

  it('updates the exact current post while an inaccessible older cleanup stays owned', async () => {
    const editor = jest.fn();
    const { prisma, maxClient, deletePreviousPublishedMessage, publish } =
      createPublishFixture(editor);
    const rules = {
      ...createRules(),
      text: 'Updated rules',
      imageBase64: 'aW1hZ2U=',
      imageMimeType: 'image/png',
      pendingCleanupMessageId: 'rules-older',
      pendingCleanupBotId: 'removed-bot',
      pendingCleanupIntentId: 'old-intent',
      pendingCleanupKind: 'republish_previous',
    };
    prisma.chatRules.upsert.mockResolvedValue(rules);
    maxClient.uploadImage.mockResolvedValue({ token: 'new-image' });
    editor.mockImplementation(
      async (_chatId, _messageId, _text, _options, _request, beforeMutation) => {
        prisma.chatRules.findUnique.mockResolvedValue({
          ...rules,
          publishOperationId: prisma.chatRules.updateMany.mock.calls[0][0].data.publishOperationId,
          pendingCleanupMessageId: null,
          pendingCleanupKind: null,
        });
        await beforeMutation();
      },
    );

    await expect(publish()).resolves.toMatchObject({ messageId: 'rules-old' });

    expect(editor).toHaveBeenCalledWith(
      'chat-1',
      'rules-old',
      'Updated rules',
      expect.objectContaining({ imagePayload: { token: 'new-image' } }),
      expect.objectContaining({ botId: 'bot-old' }),
      expect.any(Function),
    );
    expect(maxClient.uploadImage).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.any(String),
      'image/png',
      expect.objectContaining({ botId: 'bot-old' }),
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(deletePreviousPublishedMessage).not.toHaveBeenCalled();
    expect(prisma.chatRules.updateMany.mock.calls[1][0].data).not.toHaveProperty(
      'pendingCleanupMessageId',
    );
    expect(prisma.chatRules.updateMany.mock.calls[1][0].data).not.toHaveProperty(
      'pendingCleanupIntentId',
    );
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        payload: expect.objectContaining({
          updatedExistingPost: true,
          previousPublishedMessageId: null,
          previousCleanupOutcome: 'not_needed',
          preservedCleanupMessageId: 'rules-older',
        }),
      }),
    });
  });

  it.each([false, true])(
    'fences an edit timeout only after mutation authorization=%s',
    async (authorized) => {
      const editor = jest.fn();
      const { prisma, publish, maxClient } = createPublishFixture(editor);
      const rules = {
        ...createRules(),
        pendingCleanupMessageId: 'rules-older',
        pendingCleanupKind: 'republish_previous',
      };
      prisma.chatRules.upsert.mockResolvedValue(rules);
      editor.mockImplementation(
        async (_chatId, _messageId, _text, _options, _request, beforeMutation) => {
          if (authorized) {
            prisma.chatRules.findUnique.mockResolvedValue({
              ...rules,
              publishOperationId:
                prisma.chatRules.updateMany.mock.calls[0][0].data.publishOperationId,
            });
            await beforeMutation();
          }
          throw Object.assign(new Error('MAX timeout'), { code: 'ETIMEDOUT' });
        },
      );
      await expect(publish()).rejects.toThrow();
      expect(prisma.chatRules.updateMany).toHaveBeenCalledTimes(authorized ? 1 : 2);
      if (!authorized)
        expect(prisma.chatRules.updateMany.mock.calls[1][0].data).toMatchObject({
          publishOperationId: null,
          publishSendStartedAt: null,
        });
      expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    },
  );

  it('does not update after the current publication changes during preparation', async () => {
    const editor = jest.fn();
    const { prisma, publish, maxClient } = createPublishFixture(editor);
    const rules = {
      ...createRules(),
      pendingCleanupMessageId: 'rules-older',
      pendingCleanupKind: 'republish_previous',
    };
    prisma.chatRules.upsert.mockResolvedValue(rules);
    editor.mockImplementation(
      async (_chatId, _messageId, _text, _options, _request, beforeMutation) => {
        prisma.chatRules.findUnique.mockResolvedValue({
          ...rules,
          publishOperationId: 'different-operation',
        });
        await beforeMutation();
      },
    );
    await expect(publish()).rejects.toThrow();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it.each([
    { publishOperationId: 'unresolved-send' },
    { publishSendStartedAt: new Date() },
    { pendingCleanupKind: 'reset_current' },
    { pendingCleanupMessageId: 'rules-old' },
  ])('does not use in-place update to bypass a different rules fence: %o', async (override) => {
    const editor = jest.fn();
    const { prisma, publish, maxClient } = createPublishFixture(editor);
    prisma.chatRules.upsert.mockResolvedValue({
      ...createRules(),
      pendingCleanupMessageId: 'rules-older',
      pendingCleanupKind: 'republish_previous',
      ...override,
    });
    await expect(publish()).rejects.toThrow();
    expect(editor).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('repairs malformed stored rule URLs without dropping the rules', async () => {
    const rules = {
      ...createRules(),
      buttons: [
        {
          text: 'Broken',
          url: 'https://max.ru/chat/example/https://nested.example.test',
        },
      ],
      buttonEnabled: true,
      buttonUrl: 'https://max.ru/chat/example/https://nested.example.test',
      adminContactButtonEnabled: true,
      adminContactButtonUrl: 'https://max.ru/chat/example/https://nested.example.test',
      publishedMessageId: null,
      publishedBotId: null,
      publishedUrl: 'https://max.ru/chat/example/https://nested.example.test',
      publishedAt: null,
    };
    const prisma = {
      chatRules: {
        upsert: jest.fn().mockResolvedValue(rules),
        findUnique: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const invalidate = jest.fn().mockResolvedValue(undefined);
    const resolveMessageLink = jest.fn();

    const result = await readChatRules({
      prisma: prisma as never,
      chatContextCache: { invalidate },
      maxClient: { resolveMessageLink } as never,
      logger: { warn: jest.fn() },
      chatId: 'chat-1',
    });

    expect(result.text).toBe('Правила чата');
    expect(result.buttons).toEqual([]);
    expect(result.buttonEnabled).toBe(false);
    expect(result.buttonUrl).toBe('');
    expect(result.adminContactButtonEnabled).toBe(false);
    expect(result.adminContactButtonUrl).toBe('');
    expect(result.publishedUrl).toBeNull();
    expect(prisma.chatRules.updateMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        adminContactButtonEnabled: true,
        adminContactButtonUrl: rules.adminContactButtonUrl,
      },
      data: {
        adminContactButtonEnabled: false,
        adminContactButtonUrl: '',
      },
    });
    expect(resolveMessageLink).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith('chat-1');
  });

  it.each([
    { response: { status: 404, data: { code: 'message.not.found' } } },
    { response: { status: 404, data: { error: { code: 'message_not_found' } } } },
    { response: { status: 404, data: { message: 'Message not found' } } },
    { response: { status: 200, data: { success: false, code: 'message.not.found' } } },
  ])('accepts only a message-specific absence response', (error) => {
    expect(isMaxMessageMissingError(error)).toBe(true);
  });

  it.each([
    { response: { status: 404, data: {} } },
    { response: { status: 404, data: { code: 'chat.not.found' } } },
    { response: { status: 404, data: { message: 'Chat not found' } } },
    { response: { status: 500, data: { message: 'Message not found' } } },
    { response: { status: 500, data: { code: 'message.not.found' } } },
  ])('does not hide a non-message-specific failure', (error) => {
    expect(isMaxMessageMissingError(error)).toBe(false);
  });

  it('persists the new rules publication and pending cleanup before deleting the old post', async () => {
    const { order, prisma, publish } = createPublishFixture();

    await publish();

    expect(order).toEqual(['send', 'state', 'cleanup', 'audit']);
    expect(prisma.chatRules.updateMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        publishOperationId: expect.any(String),
      },
      data: expect.objectContaining({
        publishedMessageId: 'rules-new',
        publishedBotId: 'bot-new',
        pendingCleanupMessageId: 'rules-old',
        pendingCleanupBotId: 'bot-old',
        pendingCleanupIntentId: null,
        pendingCleanupKind: 'republish_previous',
        publishOperationId: null,
        publishSendStartedAt: null,
      }),
    });
  });

  it('claims the publish fence only for the revision it formatted', async () => {
    const { prisma, publish } = createPublishFixture();

    await publish();

    expect(prisma.chatRules.updateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'chat-1',
          updatedAt: createRules().updatedAt,
          publishOperationId: null,
          publishSendStartedAt: null,
          pendingCleanupMessageId: null,
        }),
      }),
    );
  });

  it('retains the chat-rules send fence after an ambiguous MAX failure', async () => {
    const { maxClient, prisma, publish } = createPublishFixture();
    maxClient.sendMessageImmediateWithResolvedLink.mockRejectedValue(
      Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' }),
    );

    await expect(publish()).rejects.toThrow('MAX не подтвердил отправку');

    expect(prisma.chatRules.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.chatRules.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          publishOperationId: expect.any(String),
          publishOperationBotId: 'bot-new',
          publishSendStartedAt: expect.any(Date),
        }),
      }),
    );
  });

  it.each([
    [
      { response: { status: 403, data: { code: 'chat.denied' } } },
      'Бот не может писать в этот чат.',
    ],
    [
      { response: { status: 404, data: { error: { code: 'chat.not.found' } } } },
      'Бот больше не видит этот чат.',
    ],
    [
      { response: { status: 429, data: { message: 'rate limit exceeded' } } },
      'MAX временно ограничил отправку.',
    ],
    [
      { response: { status: 400, data: { code: 'attachment.not.ready' } } },
      'MAX не подготовил фото.',
    ],
    [
      { response: { status: 400, data: { message: 'invalid markdown format' } } },
      'MAX не принял форматирование текста.',
    ],
  ])('returns an actionable rules publication error for %#', (error, expected) => {
    expect(describeChatRulesPublishError(error)).toContain(expected);
  });

  it('does not delete the old rules post when final publication state persistence fails', async () => {
    const { deletePreviousPublishedMessage, prisma, publish } = createPublishFixture();
    prisma.chatRules.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('database unavailable'));

    await expect(publish()).rejects.toThrow('MAX принял публикацию');

    expect(deletePreviousPublishedMessage).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(prisma.chatRules.updateMany).toHaveBeenCalledTimes(2);
  });

  it('does not finalize or clean up after losing publish fence ownership', async () => {
    const { deletePreviousPublishedMessage, prisma, publish } = createPublishFixture();
    prisma.chatRules.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await expect(publish()).rejects.toThrow('MAX принял публикацию');

    expect(deletePreviousPublishedMessage).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    expect(prisma.chatRules.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          chatId: 'chat-1',
          publishOperationId: expect.any(String),
        },
      }),
    );
  });

  it('blocks a second publish while previous-post cleanup is still owned', async () => {
    const { maxClient, prisma, publish } = createPublishFixture();
    prisma.chatRules.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.chatRules.findUnique.mockResolvedValueOnce({
      ...createRules(),
      pendingCleanupMessageId: 'rules-old',
    });

    await expect(publish()).rejects.toThrow('Предыдущий пост правил ещё удаляется');

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('does not send after the formatted rules revision loses its claim', async () => {
    const { maxClient, prisma, publish } = createPublishFixture();
    prisma.chatRules.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.chatRules.findUnique.mockResolvedValueOnce({
      ...createRules(),
      updatedAt: new Date('2026-07-15T10:01:00.000Z'),
    });

    await expect(publish()).rejects.toThrow('Черновик правил изменился');

    expect(prisma.chatRules.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ updatedAt: createRules().updatedAt }),
      }),
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it.each([
    ['republish_previous', undefined],
    ['reset_current', undefined],
    ['reset_current', 'new_message'],
  ] as const)(
    'reconciles confirmed %s cleanup before the next publish in %s mode',
    async (cleanupKind, mode) => {
      const { deletePreviousPublishedMessage, maxClient, order, prisma, publish } =
        createPublishFixture();
      const rules = {
        ...createRules(),
        pendingCleanupMessageId: cleanupKind === 'reset_current' ? 'rules-old' : 'rules-older',
        pendingCleanupBotId: 'bot-original',
        pendingCleanupKind: cleanupKind,
      };
      prisma.chatRules.upsert.mockResolvedValue(rules);
      prisma.chatRules.findUnique.mockResolvedValue({
        ...createRules(),
        ...(cleanupKind === 'reset_current'
          ? { publishedMessageId: null, publishedBotId: null }
          : {}),
        updatedAt: new Date('2026-07-15T10:02:00Z'),
      });
      deletePreviousPublishedMessage.mockResolvedValueOnce('confirmed');

      await expect(publish(mode)).resolves.toMatchObject({ messageId: 'rules-new' });

      expect(deletePreviousPublishedMessage).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          messageId: rules.pendingCleanupMessageId,
          botId: 'bot-original',
          cleanupKind,
        }),
      );
      expect(prisma.chatRules.updateMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: expect.objectContaining({
            publishedMessageId: rules.publishedMessageId,
            publishedBotId: rules.publishedBotId,
            pendingCleanupMessageId: rules.pendingCleanupMessageId,
            pendingCleanupKind: cleanupKind,
            publishOperationId: null,
          }),
        }),
      );
      expect(order.indexOf('send')).toBeGreaterThanOrEqual(0);
      expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['republish_previous', undefined, 'accepted'],
    ['republish_previous', undefined, 'waiting_capability'],
    ['republish_previous', undefined, 'failed'],
    ['reset_current', 'new_message', 'accepted'],
    ['reset_current', 'new_message', 'waiting_capability'],
    ['reset_current', 'new_message', 'failed'],
  ] as const)(
    'does not send while %s cleanup in %s mode is %s',
    async (cleanupKind, mode, outcome) => {
      const { deletePreviousPublishedMessage, maxClient, prisma, publish } = createPublishFixture();
      prisma.chatRules.upsert.mockResolvedValue({
        ...createRules(),
        imageBase64: 'aW1hZ2U=',
        pendingCleanupMessageId: cleanupKind === 'reset_current' ? 'rules-old' : 'rules-older',
        pendingCleanupBotId: 'bot-original',
        pendingCleanupKind: cleanupKind,
      });
      deletePreviousPublishedMessage.mockResolvedValue(outcome);
      await expect(publish(mode)).rejects.toThrow(
        outcome === 'accepted'
          ? 'ещё удаляется'
          : outcome === 'waiting_capability'
            ? 'Исходный бот пока не может удалить'
            : 'остановлено',
      );
      expect(prisma.chatRules.updateMany).not.toHaveBeenCalled();
      expect(maxClient.uploadImage).not.toHaveBeenCalled();
      expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['republish_previous', undefined],
    ['reset_current', undefined],
    ['reset_current', 'new_message'],
  ] as const)(
    'continues when the durable executor already finalized %s cleanup in %s mode',
    async (cleanupKind, mode) => {
      const { deletePreviousPublishedMessage, maxClient, prisma, publish } = createPublishFixture();
      const rules = {
        ...createRules(),
        pendingCleanupMessageId: cleanupKind === 'reset_current' ? 'rules-old' : 'rules-older',
        pendingCleanupBotId: 'bot-original',
        pendingCleanupKind: cleanupKind,
      };
      prisma.chatRules.upsert.mockResolvedValue(rules);
      deletePreviousPublishedMessage.mockResolvedValue('confirmed');
      prisma.chatRules.updateMany.mockResolvedValueOnce({ count: 0 });
      prisma.chatRules.findUnique.mockResolvedValue({
        ...createRules(),
        text: 'Latest saved draft',
        updatedAt: new Date('2026-07-15T10:02:00Z'),
        ...(cleanupKind === 'reset_current'
          ? { publishedMessageId: null, publishedBotId: null }
          : {}),
      });

      await expect(publish(mode)).resolves.toMatchObject({ messageId: 'rules-new' });

      expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
      expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
        'chat-1',
        'Latest saved draft',
        expect.any(Object),
        expect.any(Object),
      );
      expect(prisma.chatRules.updateMany.mock.calls[0]?.[0].where).not.toHaveProperty('updatedAt');
      expect(prisma.chatRules.updateMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: expect.objectContaining({ updatedAt: new Date('2026-07-15T10:02:00Z') }),
        }),
      );
    },
  );

  it.each([
    { publishedMessageId: 'rules-newer' },
    { publishedBotId: 'bot-newer' },
    { publishOperationId: 'new-operation' },
    { publishSendStartedAt: new Date('2026-07-15T10:02:00Z') },
    { pendingCleanupMessageId: 'rules-newer', pendingCleanupKind: 'republish_previous' },
  ])('does not overwrite a newer publication or cleanup after confirmation: %o', async (change) => {
    const { deletePreviousPublishedMessage, maxClient, prisma, publish } = createPublishFixture();
    prisma.chatRules.upsert.mockResolvedValue({
      ...createRules(),
      pendingCleanupMessageId: 'rules-older',
      pendingCleanupBotId: 'bot-original',
      pendingCleanupKind: 'republish_previous',
    });
    deletePreviousPublishedMessage.mockResolvedValue('confirmed');
    prisma.chatRules.updateMany.mockResolvedValueOnce({ count: 0 });
    prisma.chatRules.findUnique.mockResolvedValue({ ...createRules(), ...change });
    await expect(publish()).rejects.toThrow('Правила изменились');
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('does not mistake a cleanup intent attachment for a changed draft revision', async () => {
    const { deletePreviousPublishedMessage, prisma, publish } = createPublishFixture();
    const rules = {
      ...createRules(),
      pendingCleanupMessageId: 'rules-older',
      pendingCleanupBotId: 'bot-original',
      pendingCleanupKind: 'republish_previous',
    };
    prisma.chatRules.upsert.mockResolvedValue(rules);
    deletePreviousPublishedMessage.mockResolvedValue('confirmed');
    prisma.chatRules.findUnique.mockResolvedValue({
      ...createRules(),
      updatedAt: new Date('2026-07-15T10:02:00Z'),
    });
    prisma.chatRules.updateMany.mockImplementation(async ({ where }) => ({
      count: where.updatedAt?.getTime() === rules.updatedAt.getTime() ? 0 : 1,
    }));

    await expect(publish()).resolves.toMatchObject({ messageId: 'rules-new' });
    expect(prisma.chatRules.updateMany.mock.calls[0]?.[0].where).not.toHaveProperty('updatedAt');
  });

  it.each([
    [undefined, { response: { status: 404, data: {} } }],
    [undefined, { response: { status: 403, data: { code: 'chat.denied' } } }],
    ['new_message', { response: { status: 404, data: {} } }],
    ['new_message', { response: { status: 403, data: { code: 'chat.denied' } } }],
  ] as const)(
    'does not clear pending cleanup in %s mode on unconfirmed MAX errors: %o',
    async (mode, error) => {
      const { deletePreviousPublishedMessage, maxClient, prisma, publish } = createPublishFixture();
      prisma.chatRules.upsert.mockResolvedValue({
        ...createRules(),
        pendingCleanupMessageId: mode === 'new_message' ? 'rules-old' : 'rules-older',
        pendingCleanupKind: mode === 'new_message' ? 'reset_current' : 'republish_previous',
      });
      deletePreviousPublishedMessage.mockRejectedValue(error);
      await expect(publish(mode)).rejects.toThrow('Не удалось завершить удаление');
      expect(prisma.chatRules.updateMany).not.toHaveBeenCalled();
      expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    },
  );

  it('publishes a new post after MAX proves the exact reset message is already absent', async () => {
    const { deletePreviousPublishedMessage, maxClient, prisma, publish } = createPublishFixture();
    prisma.chatRules.upsert.mockResolvedValue({
      ...createRules(),
      pendingCleanupMessageId: 'rules-old',
      pendingCleanupBotId: 'bot-old',
      pendingCleanupKind: 'reset_current',
    });
    deletePreviousPublishedMessage.mockRejectedValue({
      response: { status: 404, data: { code: 'message.not.found' } },
    });
    prisma.chatRules.findUnique.mockResolvedValue({
      ...createRules(),
      publishedMessageId: null,
      publishedBotId: null,
      publishedUrl: null,
      publishedAt: null,
    });

    await expect(publish('new_message')).resolves.toMatchObject({
      operation: 'created',
      messageId: 'rules-new',
    });

    expect(deletePreviousPublishedMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
  });

  it('does not turn a post-commit audit failure into a repeated MAX send', async () => {
    const { maxClient, prisma, publish } = createPublishFixture();
    prisma.auditLog.create.mockRejectedValue(new Error('audit unavailable'));

    await expect(publish()).resolves.toMatchObject({ messageId: 'rules-new' });

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
  });

  it('keeps blocked previous-post cleanup recoverable in the publication audit', async () => {
    const { deletePreviousPublishedMessage, prisma, publish } = createPublishFixture();
    deletePreviousPublishedMessage.mockResolvedValue('waiting_capability');

    await expect(publish()).resolves.toMatchObject({ messageId: 'rules-new' });

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'PUBLISH_CHAT_RULES',
        payload: expect.objectContaining({
          previousCleanupOutcome: 'accepted',
          previousCleanupError: 'Durable cleanup is waiting for the original bot capability',
        }),
      }),
    });
  });

  it.each(['accepted', 'confirmed'] as const)(
    'returns the current draft, revision and receipt after %s reset deletion',
    async (cleanupOutcome) => {
      const rules = createRules();
      const latest = {
        ...rules,
        text: 'Rules draft saved during deletion',
        updatedAt: new Date('2026-07-16T10:01:00.000Z'),
        ...(cleanupOutcome === 'confirmed'
          ? {
              publishedMessageId: null,
              publishedBotId: null,
              publishedUrl: null,
              publishedAt: null,
            }
          : {
              pendingCleanupMessageId: 'rules-old',
              pendingCleanupBotId: 'bot-old',
              pendingCleanupKind: 'reset_current',
            }),
      };
      const prisma = withRulesTransactions({
        chatRules: {
          upsert: jest.fn().mockResolvedValue(rules),
          findUnique: jest.fn().mockResolvedValue(latest),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-reset-1' }) },
      });
      const deletePublishedMessage = jest.fn().mockResolvedValue(cleanupOutcome);

      const result = await resetPublishedChatRules({
        prisma: prisma as never,
        chatContextCache: { invalidate: jest.fn().mockResolvedValue(undefined) },
        maxClient: { deleteMessage: jest.fn() } as never,
        logger: { warn: jest.fn() },
        chatId: 'chat-1',
        actorUserId: 'owner-1',
        source: 'miniapp',
        resolveBotId: () => 'bot-new',
        deletePublishedMessage,
      });

      expect(result).toMatchObject({
        text: latest.text,
        revision: latest.updatedAt.toISOString(),
        publishedMessageId: latest.publishedMessageId,
      });
      expect(prisma.chatRules.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.chatRules.updateMany).toHaveBeenCalledTimes(
        cleanupOutcome === 'confirmed' ? 2 : 1,
      );
      expect(prisma.chatRules.updateMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          data: expect.objectContaining({
            pendingCleanupMessageId: 'rules-old',
            pendingCleanupKind: 'reset_current',
          }),
        }),
      );
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          payload: expect.objectContaining({
            cleanupOutcome,
            deletedPost: cleanupOutcome === 'confirmed',
          }),
        }),
      });
    },
  );

  it('finishes a reset whose deletion completed asynchronously without deleting twice', async () => {
    const rules = {
      ...createRules(),
      pendingCleanupMessageId: 'rules-old',
      pendingCleanupBotId: 'bot-old',
      pendingCleanupKind: 'reset_current',
    };
    const cleared = {
      ...createRules(),
      publishedMessageId: null,
      publishedBotId: null,
      publishedUrl: null,
      publishedAt: null,
    };
    const prisma = {
      chatRules: {
        upsert: jest.fn().mockResolvedValue(rules),
        findUnique: jest.fn().mockResolvedValue(cleared),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: { create: jest.fn() },
    };
    const deletePublishedMessage = jest.fn().mockResolvedValue('confirmed');
    const result = await resetPublishedChatRules({
      prisma: prisma as never,
      chatContextCache: { invalidate: jest.fn().mockResolvedValue(undefined) },
      maxClient: { deleteMessage: jest.fn() } as never,
      logger: { warn: jest.fn() },
      chatId: 'chat-1',
      actorUserId: 'admin-1',
      source: 'miniapp',
      resolveBotId: () => 'bot-new',
      deletePublishedMessage,
    });
    expect(result.publishedMessageId).toBeNull();
    expect(deletePublishedMessage).toHaveBeenCalledTimes(1);
    expect(deletePublishedMessage).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'bot-old', cleanupKind: 'reset_current' }),
    );
  });

  it.each([
    {
      publishedMessageId: null,
      publishedBotId: null,
      publishedUrl: null,
      publishedAt: null,
    },
    {
      publishedMessageId: 'rules-newer',
      publishedBotId: 'bot-newer',
      publishedUrl: 'https://max.ru/chats/chat-1/message/rules-newer',
    },
    {
      publishOperationId: 'new-publish-fence',
      publishSendStartedAt: new Date('2026-07-16T10:01:00.000Z'),
    },
  ])(
    'returns fresh rules when the durable executor wins reset finalization: %o',
    async (change) => {
      const rules = createRules();
      const latest = {
        ...rules,
        ...change,
        text: 'Latest saved rules draft',
        updatedAt: new Date('2026-07-16T10:01:00.000Z'),
      };
      const prisma = withRulesTransactions({
        chatRules: {
          upsert: jest.fn().mockResolvedValue(rules),
          findUnique: jest.fn().mockResolvedValue(latest),
          updateMany: jest.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValue({ count: 0 }),
        },
        auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-reset-1' }) },
      });
      const deletePublishedMessage = jest.fn().mockResolvedValue('confirmed');

      const result = await resetPublishedChatRules({
        prisma: prisma as never,
        chatContextCache: { invalidate: jest.fn().mockResolvedValue(undefined) },
        maxClient: { deleteMessage: jest.fn() } as never,
        logger: { warn: jest.fn() },
        chatId: 'chat-1',
        actorUserId: 'owner-1',
        source: 'miniapp',
        resolveBotId: () => 'bot-new',
        deletePublishedMessage,
      });

      expect(result).toMatchObject({
        text: latest.text,
        revision: latest.updatedAt.toISOString(),
        publishedMessageId: latest.publishedMessageId,
      });
      expect(prisma.chatRules.updateMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          where: {
            chatId: 'chat-1',
            publishedMessageId: 'rules-old',
            publishedBotId: 'bot-old',
            publishOperationId: null,
            publishSendStartedAt: null,
            pendingCleanupMessageId: 'rules-old',
            pendingCleanupBotId: 'bot-old',
            pendingCleanupKind: 'reset_current',
          },
        }),
      );
      expect(prisma.chatRules.findUnique).toHaveBeenCalledWith({ where: { chatId: 'chat-1' } });
      expect(deletePublishedMessage).toHaveBeenCalledTimes(1);
    },
  );

  it.each([null, new Date('2026-07-16T10:00:00.000Z')])(
    'blocks reset while a publication operation is active, send started at %s',
    async (publishSendStartedAt) => {
      const rules = {
        ...createRules(),
        publishOperationId: 'publish-in-flight',
        publishOperationBotId: 'bot-new',
        publishSendStartedAt,
      };
      const prisma = withRulesTransactions({
        chatRules: {
          upsert: jest.fn().mockResolvedValue(rules),
          findUnique: jest.fn(),
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        auditLog: { create: jest.fn() },
      });
      const deletePublishedMessage = jest.fn();

      await expect(
        resetPublishedChatRules({
          prisma: prisma as never,
          chatContextCache: { invalidate: jest.fn() },
          maxClient: { deleteMessage: jest.fn() } as never,
          logger: { warn: jest.fn() },
          chatId: 'chat-1',
          actorUserId: 'owner-1',
          source: 'miniapp',
          resolveBotId: () => 'bot-new',
          deletePublishedMessage,
        }),
      ).rejects.toThrow('Публикация или очистка правил уже выполняется');

      expect(deletePublishedMessage).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    },
  );
});
