import { createHmac } from 'node:crypto';
import type { ChannelDialogLegacyPort } from './channel-dialog-legacy.port';
import { ChannelDialogService } from './channel-dialog.service';

function createConfigMock() {
  return {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'MAX_BOT_TOKEN') {
        return 'test-max-bot-token';
      }
      throw new Error(`Missing key: ${key}`);
    }),
    get: jest.fn((key: string) => {
      if (key === 'APP_BASE_URL') {
        return 'https://major-maksimov.ru';
      }
      if (key === 'MAX_BOT_ID') {
        return '777000_bot';
      }
      if (key === 'MAX_BOT_CONTACT_ID') {
        return '777000';
      }
      if (key === 'MAX_BOT_TOKEN_PREVIOUS') {
        return null;
      }
      return null;
    }),
  };
}

function createSuggestionToken(chatId: string, threadId?: string): string {
  const signature = createHmac('sha256', 'test-max-bot-token')
    .update(threadId ? `dialog:${chatId}:suggest:${threadId}` : `dialog:${chatId}:suggest`)
    .digest('hex');
  if (!threadId) {
    return signature;
  }

  return `cdt-${Buffer.from(
    JSON.stringify({
      v: 1,
      d: threadId,
      s: signature,
    }),
    'utf8',
  ).toString('base64url')}`;
}

function createService(
  options: { postSuggestionsEnabled?: boolean; routeBotId?: string | null } = {},
) {
  const legacyAdminService = {
    getChannelSuggestionRedirect: jest.fn(),
    toggleChannelDialogReaction: jest.fn(),
    toggleChatDialogReaction: jest.fn(),
    getPublicChannelSettingsForDialog: jest.fn().mockResolvedValue({
      postSuggestionsEnabled: options.postSuggestionsEnabled ?? true,
      commentsEnabled: true,
    }),
    getPublicChatCommentSettingsForDialog: jest
      .fn<
        ReturnType<ChannelDialogLegacyPort['getPublicChatCommentSettingsForDialog']>,
        Parameters<ChannelDialogLegacyPort['getPublicChatCommentSettingsForDialog']>
      >()
      .mockResolvedValue({ commentsEnabled: true }),
    toggleEntityDialogReactionForDialog: jest.fn().mockResolvedValue({
      ok: true,
      message: {
        id: 'message-1',
        actorUserId: 'admin-1',
        authorName: null,
        authorProfileUrl: null,
        isAdmin: false,
        text: 'Комментарий',
        textHtml: 'Комментарий',
        attachments: [],
        reactions: [
          {
            emoji: '👍',
            count: 1,
            selected: true,
          },
        ],
        createdAt: '2026-05-27T10:00:00.000Z',
        updatedAt: null,
        canEdit: true,
        reviewStatus: null,
        delivered: false,
        publishedUrl: null,
      },
    }),
  };
  const maxBotLinkService = {
    getStoredChatPrimaryBotId: jest.fn().mockResolvedValue(options.routeBotId ?? null),
    getBotTokenSync: jest.fn((botId?: string | null) =>
      botId?.trim() === 'channel-bot-2' ? 'token-bot-2' : 'test-max-bot-token',
    ),
    getValidationTokens: jest.fn().mockReturnValue(['test-max-bot-token', 'token-bot-2']),
    buildBotStartUrlSync: jest.fn((startPayload: string, botId?: string | null) => {
      const targetBotId = botId?.trim() || '777000_bot';
      return `https://max.ru/${encodeURIComponent(targetBotId)}?start=${encodeURIComponent(
        startPayload,
      )}`;
    }),
  };
  const service = new ChannelDialogService(
    legacyAdminService as never,
    createConfigMock() as never,
    maxBotLinkService as never,
  );

  return {
    legacyAdminService,
    maxBotLinkService,
    service,
  };
}

const user = {
  userId: 'admin-1',
  username: null,
  displayName: null,
  chatTitle: null,
};

describe('ChannelDialogService suggestion redirect', () => {
  it('builds the redirect inside the dialog service instead of using the legacy wrapper', async () => {
    const { legacyAdminService, service } = createService();

    await expect(
      service.getChannelSuggestionRedirect(
        'channel-1',
        createSuggestionToken('channel-1', '12345678-1234-1234-9234-1234567890ab'),
      ),
    ).resolves.toEqual({
      url: expect.stringMatching(/^https:\/\/max\.ru\/777000_bot\?start=/u),
      title: null,
    });

    expect(legacyAdminService.getChannelSuggestionRedirect).not.toHaveBeenCalled();
    expect(legacyAdminService.getPublicChannelSettingsForDialog).toHaveBeenCalledWith('channel-1');
  });

  it('keeps channel suggestion redirects on the stored channel bot route', async () => {
    const { maxBotLinkService, service } = createService({ routeBotId: 'channel-bot-2' });
    const threadId = '12345678-1234-1234-9234-1234567890ab';

    const result = await service.getChannelSuggestionRedirect(
      'channel-1',
      createSuggestionToken('channel-1', threadId),
    );

    expect(result.url).toMatch(/^https:\/\/max\.ru\/channel-bot-2\?start=/u);
    const startPayload = new URL(result.url).searchParams.get('start') ?? '';
    const expectedSignature = createHmac('sha256', 'token-bot-2')
      .update(`suggest-start:channel-1:${threadId}`)
      .digest('hex')
      .slice(0, 24);
    expect(startPayload).toContain(expectedSignature);
    expect(maxBotLinkService.getStoredChatPrimaryBotId).toHaveBeenCalledWith('channel-1');
    expect(maxBotLinkService.getBotTokenSync).toHaveBeenCalledWith('channel-bot-2');
    expect(maxBotLinkService.buildBotStartUrlSync).toHaveBeenCalledWith(
      expect.any(String),
      'channel-bot-2',
    );
  });

  it('keeps the closed suggestions guard in the dialog service', async () => {
    const { legacyAdminService, service } = createService({ postSuggestionsEnabled: false });

    await expect(
      service.getChannelSuggestionRedirect('channel-1', createSuggestionToken('channel-1')),
    ).rejects.toThrow('Предложить пост для этого канала сейчас нельзя.');

    expect(legacyAdminService.getChannelSuggestionRedirect).not.toHaveBeenCalled();
  });
});

describe('ChannelDialogService reactions', () => {
  it('toggles channel dialog reactions through dialog ports instead of the legacy wrapper', async () => {
    const { legacyAdminService, service } = createService();

    await expect(
      service.toggleChannelDialogReaction('channel-1', user as never, 'comments', 'message-1', {
        token: 'reaction-token-1',
        emoji: '👍',
      }),
    ).resolves.toEqual(expect.objectContaining({ ok: true }));

    expect(legacyAdminService.toggleChannelDialogReaction).not.toHaveBeenCalled();
    expect(legacyAdminService.getPublicChannelSettingsForDialog).toHaveBeenCalledWith('channel-1');
    expect(legacyAdminService.toggleEntityDialogReactionForDialog).toHaveBeenCalledWith({
      chatId: 'channel-1',
      entityType: 'channel',
      dialogProfile: 'moderation',
      userId: 'admin-1',
      dialogType: 'comments',
      messageId: 'message-1',
      token: 'reaction-token-1',
      emoji: '👍',
    });
  });

  it('toggles chat dialog reactions through dialog ports instead of the legacy wrapper', async () => {
    const { legacyAdminService, service } = createService();

    await expect(
      service.toggleChatDialogReaction('chat-1', user as never, 'comments', 'message-1', {
        token: 'reaction-token-1',
        emoji: '👍',
      }),
    ).resolves.toEqual(expect.objectContaining({ ok: true }));

    expect(legacyAdminService.toggleChatDialogReaction).not.toHaveBeenCalled();
    expect(legacyAdminService.getPublicChatCommentSettingsForDialog).toHaveBeenCalledWith(
      'chat-1',
      'reaction-token-1',
    );
    expect(legacyAdminService.toggleEntityDialogReactionForDialog).toHaveBeenCalledWith({
      chatId: 'chat-1',
      entityType: 'chat',
      userId: 'admin-1',
      dialogType: 'comments',
      messageId: 'message-1',
      token: 'reaction-token-1',
      emoji: '👍',
      dialogProfile: 'moderation',
    });
  });
});
