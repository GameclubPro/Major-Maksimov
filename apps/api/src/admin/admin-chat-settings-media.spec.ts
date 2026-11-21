import { chatSettingsSchema } from '@maxim/contracts';
import {
  getStoredChatSettingsSanitizationChanges,
  normalizeChatSettings,
  readChatSettings,
  saveChatSettings,
} from './admin-chat-settings';

const image = {
  base64: 'aW1hZ2U=',
  mimeType: 'image/jpeg',
  fileName: 'notice.jpg',
};
const canonicalMedia = { greetingBotMessageText: image };
const reorderedMedia = {
  greetingBotMessageText: {
    base64: image.base64,
    fileName: image.fileName,
    mimeType: image.mimeType,
  },
};

function createFixture(options: { media?: unknown; exists?: boolean; updatedCount?: number } = {}) {
  const stored = {
    ...normalizeChatSettings(chatSettingsSchema.parse({}), undefined, 'chat-1'),
    id: 'settings-1',
    chatId: 'chat-1',
    botSpeechMedia: options.media ?? reorderedMedia,
    createdAt: new Date('2026-10-01T01:00:00.000Z'),
    updatedAt: new Date('2026-10-01T01:00:00.000Z'),
  };
  const prisma = {
    chat: { upsert: jest.fn().mockResolvedValue({ id: 'chat-1', settings: stored }) },
    chatSettings: {
      findUnique: jest.fn(async (args: { select?: Record<string, unknown> }) => {
        if (options.exists === false) return null;
        if (!args.select) return stored;
        return Object.fromEntries(
          Object.entries(args.select)
            .filter(([, selected]) => selected === true)
            .map(([key]) => [key, (stored as Record<string, unknown>)[key]]),
        );
      }),
      updateMany: jest.fn().mockResolvedValue({ count: options.updatedCount ?? 1 }),
      create: jest.fn().mockResolvedValue(stored),
    },
    auditLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) =>
    callback(prisma),
  );
  const chatContextCache = { invalidate: jest.fn().mockResolvedValue(undefined) };
  const logger = { warn: jest.fn() };
  const refreshExecutionReadiness = jest.fn().mockResolvedValue(undefined);
  return {
    stored,
    prisma,
    chatContextCache,
    logger,
    refreshExecutionReadiness,
    read: () =>
      readChatSettings({
        prisma: prisma as never,
        chatContextCache,
        logger,
        chatId: 'chat-1',
      }),
    save: (body: unknown) =>
      saveChatSettings({
        prisma: prisma as never,
        chatContextCache,
        chatId: 'chat-1',
        actorUserId: 'admin-1',
        body,
        source: 'miniapp',
        resolveBotAssignmentData: () => ({}),
        assertRequiredSubscriptionSettings: jest.fn().mockResolvedValue(undefined),
        assertBotCapabilities: jest.fn().mockResolvedValue(undefined),
        refreshExecutionReadiness,
      }),
  };
}

describe('Chat settings media write boundaries', () => {
  it('does not repair or invalidate a media value whose JSONB property order differs', async () => {
    const fixture = createFixture();

    const result = await fixture.read();

    expect(result.botSpeechMedia).toEqual(canonicalMedia);
    expect(fixture.prisma.chatSettings.updateMany).not.toHaveBeenCalled();
    expect(fixture.chatContextCache.invalidate).not.toHaveBeenCalled();
    expect(fixture.logger.warn).not.toHaveBeenCalled();
  });

  it('compares large stored media without creating additional serialized JSON strings', () => {
    const media = {
      greetingBotMessageText: { ...image, base64: 'A'.repeat(1_000_000) },
    };
    const fixture = createFixture({ media });
    const sanitized = chatSettingsSchema.parse(fixture.stored);
    const stringify = jest.spyOn(JSON, 'stringify');
    try {
      expect(getStoredChatSettingsSanitizationChanges(fixture.stored, sanitized)).toEqual({});
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
  });

  it.each([
    {
      name: 'legacy extra field',
      storedMedia: { greetingBotMessageText: { ...image, legacy: true } },
      expectedMedia: canonicalMedia,
    },
    {
      name: 'trimmed fields',
      storedMedia: {
        greetingBotMessageText: {
          base64: ` ${image.base64} `,
          mimeType: ' image/jpeg ',
          fileName: ' notice.jpg ',
        },
      },
      expectedMedia: canonicalMedia,
    },
    {
      name: 'invalid media alongside a valid night image',
      storedMedia: {
        nightModeBotMessageText: image,
        greetingBotMessageText: { ...image, mimeType: 'text/plain' },
      },
      expectedMedia: { nightModeBotMessageText: image },
    },
    {
      name: 'invalid media',
      storedMedia: { greetingBotMessageText: { ...image, mimeType: 'text/plain' } },
      expectedMedia: {},
    },
  ])('still repairs $name against its original settings revision', async (testCase) => {
    const fixture = createFixture({ media: testCase.storedMedia });

    const result = await fixture.read();

    expect(result.botSpeechMedia).toEqual(testCase.expectedMedia);
    expect(fixture.prisma.chatSettings.updateMany).toHaveBeenCalledWith({
      where: { chatId: 'chat-1', updatedAt: fixture.stored.updatedAt },
      data: expect.objectContaining({ botSpeechMedia: testCase.expectedMedia }),
    });
    expect(fixture.chatContextCache.invalidate).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: 'same media', media: canonicalMedia, writesMedia: false },
    { name: 'same media in a different property order', media: reorderedMedia, writesMedia: false },
    {
      name: 'changed image bytes',
      media: { greetingBotMessageText: { ...image, base64: 'bmV3LWltYWdl' } },
      writesMedia: true,
    },
    { name: 'cleared media', media: {}, writesMedia: true },
    {
      name: 'changed file name',
      media: { greetingBotMessageText: { ...image, fileName: 'replacement.jpg' } },
      writesMedia: true,
    },
  ])('saves $name with the same CAS, audit and returned media', async (testCase) => {
    const fixture = createFixture();

    const result = await fixture.save({ antiSpamEnabled: false, botSpeechMedia: testCase.media });

    expect(fixture.prisma.chatSettings.findUnique.mock.calls[0]?.[0]).toMatchObject({
      select: { botSpeechMedia: true, updatedAt: true },
    });
    const write = fixture.prisma.chatSettings.updateMany.mock.calls[0]?.[0];
    expect(write.where).toEqual({ chatId: 'chat-1', updatedAt: fixture.stored.updatedAt });
    expect(write.data.antiSpamEnabled).toBe(false);
    expect(write.data).not.toHaveProperty('commentsEnabled');
    if (testCase.writesMedia) expect(write.data.botSpeechMedia).toEqual(testCase.media);
    else expect(write.data).not.toHaveProperty('botSpeechMedia');
    expect(result.botSpeechMedia).toEqual(testCase.media);
    expect(fixture.prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(fixture.prisma.auditLog.create.mock.calls[0]?.[0]).toMatchObject({
      data: {
        action: 'UPDATE_SETTINGS',
        payload: { settingKeys: ['antiSpamEnabled', 'botSpeechMedia'] },
      },
    });
    expect(fixture.chatContextCache.invalidate).toHaveBeenCalledTimes(1);
    expect(fixture.refreshExecutionReadiness).toHaveBeenCalledTimes(1);
  });

  it('normalizes raw stored media on save instead of preserving a legacy extra field', async () => {
    const fixture = createFixture({
      media: { greetingBotMessageText: { ...image, legacy: true } },
    });

    const result = await fixture.save({ botSpeechMedia: canonicalMedia });

    expect(fixture.prisma.chatSettings.updateMany.mock.calls[0]?.[0].data.botSpeechMedia).toEqual(
      canonicalMedia,
    );
    expect(result.botSpeechMedia).toEqual(canonicalMedia);
  });

  it('keeps image media in settings created without a prior row', async () => {
    const fixture = createFixture({ exists: false });

    const result = await fixture.save({ botSpeechMedia: canonicalMedia });

    expect(fixture.prisma.chatSettings.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ chatId: 'chat-1', botSpeechMedia: canonicalMedia }),
    });
    expect(fixture.prisma.chatSettings.updateMany).not.toHaveBeenCalled();
    expect(result.botSpeechMedia).toEqual(canonicalMedia);
  });

  it.each([canonicalMedia, {}, { greetingBotMessageText: { ...image, base64: 'bmV3LWltYWdl' } }])(
    'rejects a concurrent settings revision before audit or invalidation for any media change',
    async (media) => {
      const fixture = createFixture({ updatedCount: 0 });

      await expect(fixture.save({ botSpeechMedia: media })).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'CHAT_SETTINGS_CONCURRENT_UPDATE' }),
      });

      expect(fixture.prisma.chatSettings.updateMany).toHaveBeenCalledWith({
        where: { chatId: 'chat-1', updatedAt: fixture.stored.updatedAt },
        data: expect.any(Object),
      });
      expect(fixture.prisma.auditLog.create).not.toHaveBeenCalled();
      expect(fixture.chatContextCache.invalidate).not.toHaveBeenCalled();
      expect(fixture.refreshExecutionReadiness).not.toHaveBeenCalled();
    },
  );
});
