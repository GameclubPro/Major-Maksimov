import { channelSettingsSchema, chatSettingsSchema } from '@maxim/contracts';
import {
  createAdminServiceFixture,
  createChatContextCacheMock,
  createConfigMock,
  createPrismaMock,
} from './admin-service-test-support';

function expectChatSettingsWrite(
  prisma: ReturnType<typeof createPrismaMock>,
  expected: Record<string, unknown>,
  chatId = 'chat-1',
): void {
  const updated = prisma.chatSettings.updateMany.mock.calls
    .filter(([args]) => args?.where?.chatId === chatId)
    .at(-1)?.[0]?.data;
  const created = prisma.chatSettings.create.mock.calls
    .filter(([args]) => args?.data?.chatId === chatId)
    .at(-1)?.[0]?.data;
  expect(updated ?? created).toEqual(expect.objectContaining(expected));
}

describe('AdminService night mode settings normalization', () => {
  it('uses a resolved chat settings bot only for create without overwriting an existing route', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const maxBotLinkService = {
      resolveBotId: jest.fn().mockResolvedValue('id613002203036_bot'),
      resolveContactIdSync: jest.fn().mockReturnValue(null),
      bindDiscoveredChatBots: jest.fn().mockResolvedValue('id613002203036_bot'),
      getBotTokenSync: jest.fn().mockReturnValue(null),
      getValidationTokens: jest.fn().mockReturnValue([]),
      buildBotStartUrlSync: jest
        .fn()
        .mockReturnValue('https://max.ru/id613002203036_bot?start=payload'),
      buildEntryBotStartUrlSync: jest
        .fn()
        .mockReturnValue('https://max.ru/id613002203036_bot?start=payload'),
      buildMiniappStartUrlSync: jest
        .fn()
        .mockReturnValue('https://max.ru/id613002203036_bot?startapp=payload'),
      buildEntryMiniappStartUrlSync: jest
        .fn()
        .mockReturnValue('https://max.ru/id613002203036_bot?startapp=payload'),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
    );

    await service.updateSettings(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      chatSettingsSchema.parse({}),
    );

    const upsert = prisma.chat.upsert.mock.lastCall?.[0];
    expect(upsert?.create).toEqual(
      expect.objectContaining({
        botId: 'id613002203036_bot',
        primaryBotId: 'id613002203036_bot',
      }),
    );
    expect(upsert?.update).not.toHaveProperty('botId');
    expect(upsert?.update).not.toHaveProperty('primaryBotId');
  });

  it('forces invitation access off when chat settings are updated', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const service = createAdminServiceFixture(
      prisma as never,
      {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      } as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.updateSettings(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      chatSettingsSchema.parse({
        invitationAccessEnabled: true,
        invitationAccessRequiredCount: 4,
        invitationAccessWarnEnabled: true,
        invitationAccessMuteEnabled: true,
        invitationAccessBanEnabled: true,
      }),
    );

    expect(result).toEqual(
      expect.objectContaining({
        invitationAccessEnabled: false,
        invitationAccessRequiredCount: 4,
      }),
    );
    expectChatSettingsWrite(prisma, { invitationAccessEnabled: false });
  });

  it('uses a resolved channel settings bot only for create without overwriting an existing route', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    prisma.chat.findUnique.mockResolvedValue({
      id: 'channel-1',
      title: 'Канал MAX',
      entityType: 'CHANNEL',
    });
    const maxBotLinkService = {
      resolveBotId: jest.fn().mockResolvedValue('id613002203036_4_bot'),
      resolveContactIdSync: jest.fn().mockReturnValue(null),
      bindDiscoveredChatBots: jest.fn().mockResolvedValue('id613002203036_4_bot'),
      getBotTokenSync: jest.fn().mockReturnValue(null),
      getValidationTokens: jest.fn().mockReturnValue([]),
      buildBotStartUrlSync: jest
        .fn()
        .mockReturnValue('https://max.ru/id613002203036_bot?start=payload'),
      buildEntryBotStartUrlSync: jest
        .fn()
        .mockReturnValue('https://max.ru/id613002203036_bot?start=payload'),
      buildMiniappStartUrlSync: jest
        .fn()
        .mockReturnValue('https://max.ru/id613002203036_bot?startapp=payload'),
      buildEntryMiniappStartUrlSync: jest
        .fn()
        .mockReturnValue('https://max.ru/id613002203036_bot?startapp=payload'),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
    );

    await service.updateChannelSettings(
      'channel-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      channelSettingsSchema.parse({ revision: 0 }),
    );

    const upsert = prisma.chat.upsert.mock.lastCall?.[0];
    expect(upsert?.create).toEqual(
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
        primaryBotId: 'id613002203036_4_bot',
      }),
    );
    expect(upsert?.update).not.toHaveProperty('botId');
    expect(upsert?.update).not.toHaveProperty('primaryBotId');
  });

  it('forces night bot message toggles off when night mode is disabled on update', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    jest
      .spyOn(service as any, 'resolveManualActionBotAssignment')
      .mockResolvedValue('channel-bot-2');

    const result = await service.updateSettings(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        nightModeEnabled: false,
        nightModeBotMessageEnabled: true,
        nightModeCommentsEnabled: true,
        nightModeBotButtonEnabled: true,
        nightModeBotButtonUrl: 'https://max.ru/channel/rules',
        nightModeBotButtonText: 'Правила',
        nightModeRulesButtonEnabled: true,
      },
    );

    expect(result.nightModeEnabled).toBe(false);
    expect(result.nightModeBotMessageEnabled).toBe(false);
    expect(result.nightModeCommentsEnabled).toBe(false);
    expect(result.nightModeBotButtonEnabled).toBe(false);
    expect(result.nightModeRulesButtonEnabled).toBe(false);
    expectChatSettingsWrite(prisma, {
      nightModeEnabled: false,
      nightModeBotMessageEnabled: false,
      nightModeCommentsEnabled: false,
      nightModeBotButtonEnabled: false,
      nightModeRulesButtonEnabled: false,
    });
  });

  it('rejects legacy profile handoff button urls on update', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    await expect(
      service.updateSettings(
        'chat-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          greetingEnabled: true,
          greetingBotMessageEnabled: true,
          greetingBotButtonEnabled: true,
          greetingBotButtonUrl: 'https://max.ru/777000_bot?start=pmh-legacy',
          greetingBotButtonText: 'Профиль',
        },
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        greetingBotButtons: expect.objectContaining({
          0: expect.objectContaining({
            url: expect.objectContaining({
              _errors: expect.arrayContaining([
                'Укажите корректную ссылку для кнопки (http/https).',
              ]),
            }),
          }),
        }),
      }),
    });
    expect(prisma.chatSettings.findUnique).not.toHaveBeenCalled();
  });

  it('rejects max user deeplinks in new button urls on update', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      service.updateSettings(
        'chat-1',
        {
          userId: 'admin-1',
          username: null,
          displayName: null,
          chatTitle: null,
        },
        {
          greetingEnabled: true,
          greetingBotMessageEnabled: true,
          greetingBotButtonEnabled: true,
          greetingBotButtonUrl: 'max://user/user-42',
          greetingBotButtonText: 'Профиль',
        },
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        greetingBotButtons: expect.objectContaining({
          0: expect.objectContaining({
            url: expect.objectContaining({
              _errors: expect.arrayContaining([
                'Укажите корректную ссылку для кнопки (http/https).',
              ]),
            }),
          }),
        }),
      }),
    });
    expect(prisma.chatSettings.findUnique).not.toHaveBeenCalled();
  });

  it('drops legacy profile handoff button urls from stored settings', async () => {
    const prisma = createPrismaMock();
    prisma.chat.upsert.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      settings: {
        greetingEnabled: true,
        greetingBotMessageEnabled: true,
        greetingBotButtonEnabled: true,
        greetingBotButtonUrl: 'https://max.ru/777000_bot?start=pmh-legacy',
        greetingBotButtonText: 'Профиль',
      },
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.getSettings('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result.greetingBotButtonEnabled).toBe(false);
    expect(result.greetingBotButtonUrl).toBe('');
    expect(prisma.chatSettings.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ chatId: 'chat-1' }),
        data: expect.objectContaining({
          greetingBotButtonEnabled: false,
          greetingBotButtonUrl: '',
        }),
      }),
    );
  });

  it('drops compact profile handoff button urls from stored settings', async () => {
    const prisma = createPrismaMock();
    prisma.chat.upsert.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      settings: {
        greetingEnabled: true,
        greetingBotMessageEnabled: true,
        greetingBotButtonEnabled: true,
        greetingBotButtonUrl:
          'https://max.ru/777000_bot?start=pm2_chat-1_h_admin-1_abcdef0123456789',
        greetingBotButtonText: 'Профиль',
      },
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.getSettings('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result.greetingBotButtonEnabled).toBe(false);
    expect(result.greetingBotButtonUrl).toBe('');
    expect(prisma.chatSettings.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ chatId: 'chat-1' }),
        data: expect.objectContaining({
          greetingBotButtonEnabled: false,
          greetingBotButtonUrl: '',
        }),
      }),
    );
  });

  it('drops legacy max user button urls from stored settings', async () => {
    const prisma = createPrismaMock();
    prisma.chat.upsert.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      settings: {
        greetingEnabled: true,
        greetingBotMessageEnabled: true,
        greetingBotButtonEnabled: true,
        greetingBotButtonUrl: 'max://user/user-42',
        greetingBotButtonText: 'Профиль',
      },
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.getSettings('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result.greetingBotButtonEnabled).toBe(false);
    expect(result.greetingBotButtonUrl).toBe('');
    expect(prisma.chatSettings.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ chatId: 'chat-1' }),
        data: expect.objectContaining({
          greetingBotButtonEnabled: false,
          greetingBotButtonUrl: '',
        }),
      }),
    );
  });

  it('normalizes stale night bot message toggles from stored settings', async () => {
    const prisma = createPrismaMock();
    prisma.chat.upsert.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      settings: {
        nightModeEnabled: false,
        nightModeBotMessageEnabled: true,
        nightModeCommentsEnabled: true,
        nightModeBotButtonEnabled: true,
        nightModeBotButtonUrl: 'https://max.ru/channel/rules',
        nightModeBotButtonText: 'Правила',
        nightModeRulesButtonEnabled: true,
      },
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.getSettings('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result.nightModeEnabled).toBe(false);
    expect(result.nightModeBotMessageEnabled).toBe(false);
    expect(result.nightModeCommentsEnabled).toBe(false);
    expect(result.nightModeBotButtonEnabled).toBe(false);
    expect(result.nightModeRulesButtonEnabled).toBe(false);
    expect(prisma.chatSettings.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ chatId: 'chat-1' }),
        data: expect.objectContaining({
          nightModeBotMessageEnabled: false,
          nightModeCommentsEnabled: false,
          nightModeBotButtonEnabled: false,
          nightModeRulesButtonEnabled: false,
        }),
      }),
    );
  });

  it('starts manual close timer when timed close is enabled on update', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    jest.spyOn(service, 'assertChatSettingsBotCapabilities').mockResolvedValue(undefined);

    const before = Date.now();
    const result = await service.updateSettings(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        nightModeForceCloseEnabled: true,
        nightModeForceCloseForever: false,
        nightModeForceCloseDays: 1,
        nightModeForceCloseHours: 2,
      },
    );
    const after = Date.now();

    expect(result.nightModeForceCloseEnabled).toBe(true);
    expect(result.nightModeForceCloseForever).toBe(false);
    expect(result.nightModeForceCloseUntil).not.toBe('');

    const closeUntil = Date.parse(result.nightModeForceCloseUntil);
    expect(closeUntil).toBeGreaterThanOrEqual(before + 26 * 60 * 60 * 1_000);
    expect(closeUntil).toBeLessThanOrEqual(after + 26 * 60 * 60 * 1_000);
  });

  it('prewarms the destructive moderation admin roster when closing a chat', async () => {
    const prisma = createPrismaMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };
    const maxChatAdminRosterSyncService = {
      scheduleChatAdminRosterSync: jest.fn().mockResolvedValue(true),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxChatAdminRosterSyncService as never,
    );
    jest.spyOn(service, 'assertChatSettingsBotCapabilities').mockResolvedValue(undefined);

    await service.updateSettings(
      'chat-1',
      {
        userId: 'admin-1',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      {
        nightModeForceCloseEnabled: true,
        nightModeForceCloseForever: true,
      },
    );

    expect(maxChatAdminRosterSyncService.scheduleChatAdminRosterSync).toHaveBeenCalledWith({
      chatId: 'chat-1',
      entityType: 'chat',
      source: 'moderation_destructive_path',
      retryUntilMs: null,
    });
  });

  it('disables expired timed manual close while reading settings', async () => {
    const prisma = createPrismaMock();
    prisma.chat.upsert.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      settings: {
        ...chatSettingsSchema.parse({}),
        nightModeForceCloseEnabled: true,
        nightModeForceCloseForever: false,
        nightModeForceCloseHours: 4,
        nightModeForceCloseDays: 0,
        nightModeForceCloseUntil: new Date(Date.now() - 60_000).toISOString(),
      },
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const result = await service.getSettings('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(result.nightModeForceCloseEnabled).toBe(false);
    expect(result.nightModeForceCloseUntil).toBe('');
    expect(prisma.chatSettings.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ chatId: 'chat-1' }),
        data: expect.objectContaining({
          nightModeForceCloseEnabled: false,
          nightModeForceCloseUntil: '',
        }),
      }),
    );
  });

  it('does not probe manual-action bot access while reading chat settings', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'chat-1',
      entityType: 'CHAT',
      primaryBotId: 'id613002203036_bot',
      botId: null,
      botMemberships: [],
    });
    prisma.chat.upsert.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      settings: chatSettingsSchema.parse({}),
    });

    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn(),
    };

    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn().mockResolvedValue(undefined) } as never,
      createConfigMock() as never,
    );

    await service.getSettings('chat-1', {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatTitle: null,
    });

    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
  });
});
