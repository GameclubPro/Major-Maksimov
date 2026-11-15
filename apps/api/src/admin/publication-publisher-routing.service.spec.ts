import { ChatEntityType, PublicationDispatchProfile } from '../prisma/prisma-client';
import { PublicationPublisherRoutingService } from './publication-publisher-routing.service';
import { PublisherDialogContextService } from './publisher-dialog-context.service';

describe('PublicationPublisherRoutingService', () => {
  it.each(['ALL_CHATS', 'ALL_CHANNELS', 'ALL_MANAGED'] as const)(
    'keeps the accepted DYNAMIC %s target set without expanding another administrator scope',
    async (audienceSelection) => {
      const resolvePublicationTargets = jest.fn().mockResolvedValue([{ chatId: 'foreign' }]);
      const requestActorAccessRefresh = jest.fn();
      const service = new PublicationPublisherRoutingService(
        {} as never,
        {} as never,
        { requestActorAccessRefresh } as never,
        {} as never,
        {} as never,
        { resolvePublicationTargets } as never,
      );
      await expect(
        service.resolveScheduledTargets({
          actorUserId: 'original-author',
          requiredBotId: 'publik',
          audienceMode: 'DYNAMIC',
          audienceSelection,
          targets: [
            { targetChatId: 'accepted', entityType: ChatEntityType.CHANNEL },
            { targetChatId: 'canceled', entityType: ChatEntityType.CHAT, canceledAt: new Date() },
          ],
        }),
      ).resolves.toEqual([
        {
          chatId: 'accepted',
          entityType: 'channel',
          title: 'accepted',
          avatarUrl: null,
          link: null,
        },
      ]);
      expect(resolvePublicationTargets).not.toHaveBeenCalled();
      expect(requestActorAccessRefresh).not.toHaveBeenCalled();
    },
  );

  it('stores deferred context inputs before any recipient preparation for PUBLIK_V1 chats', async () => {
    const assertTargetsReady = jest.fn().mockResolvedValue([
      {
        chatId: 'chat-publisher-only',
        entityType: 'chat',
        requiredBotId: 'publisher-bot',
        policyRevision: 7,
      },
    ]);
    const prepare = jest.fn().mockImplementation(async (params) => ({
      version: 1,
      dialogBotId: params.dialogBotId,
      buttons: [[{ type: 'link', text: 'Открыть', url: 'https://example.com' }]],
      reference: null,
    }));
    const service = new PublicationPublisherRoutingService(
      {} as never,
      {} as never,
      { assertTargetsReady } as never,
      { prepare } as never,
      {} as never,
      {} as never,
    );

    const result = await service.prepareOccurrenceRoute(
      PublicationDispatchProfile.PUBLIK_V1,
      'publisher-bot',
      [{ chatId: 'chat-publisher-only', entityType: 'chat' }],
      [{ text: 'Открыть', url: 'https://example.com' }],
    );

    expect(prepare).not.toHaveBeenCalled();
    expect(assertTargetsReady).not.toHaveBeenCalled();
    expect(result.deliveryDataByChatId.get('chat-publisher-only')).toMatchObject({
      dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
      requiredBotId: 'publisher-bot',
      dialogBotId: 'publisher-bot',
      publicationPolicyRevision: 0,
      publisherDialogContext: expect.objectContaining({
        version: 0,
        preparation: 'pending',
        dialogBotId: 'publisher-bot',
        customButtons: [{ text: 'Открыть', url: 'https://example.com' }],
      }),
    });
  });

  it('allows Publisher-owned channel suggestions in PUBLIK_V1 channel posts', async () => {
    const prepare = jest.fn().mockImplementation(async (params) => ({
      version: 1,
      dialogBotId: params.dialogBotId,
      buttons: [],
      reference: null,
    }));
    const service = new PublicationPublisherRoutingService(
      {} as never,
      {} as never,
      {
        assertTargetsReady: jest.fn().mockResolvedValue([
          {
            chatId: 'channel-1',
            entityType: 'channel',
            requiredBotId: 'publisher-bot',
            policyRevision: 3,
          },
        ]),
      } as never,
      { prepare } as never,
      {} as never,
      {} as never,
    );

    const result = await service.prepareOccurrenceRoute(
      PublicationDispatchProfile.PUBLIK_V1,
      'publisher-bot',
      [{ chatId: 'channel-1', entityType: 'channel' }],
      [],
    );

    expect(prepare).not.toHaveBeenCalled();
    expect(result.deliveryDataByChatId.get('channel-1')).toMatchObject({
      dialogBotId: 'publisher-bot',
    });
  });

  it('resolves PUBLIK_V1 audiences only through Publisher-owned scope', async () => {
    const resolvePublicationTargets = jest.fn().mockResolvedValue([
      {
        chatId: 'publisher-channel',
        entityType: 'channel',
        title: 'Publisher channel',
        avatarUrl: null,
        link: null,
      },
    ]);
    const listChats = jest.fn();
    const listChannels = jest.fn();
    const assertChatAdminAccess = jest.fn();
    const assertChannelAdminAccess = jest.fn();
    const service = new PublicationPublisherRoutingService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        listChats,
        listChannels,
        assertChatAdminAccess,
        assertChannelAdminAccess,
      } as never,
      { resolvePublicationTargets } as never,
    );
    const user = { userId: 'user-1', username: null, displayName: null };

    await expect(
      service.resolveAudienceTargets(
        user,
        {
          selection: 'SELECTED',
          mode: 'SNAPSHOT',
          targets: [{ chatId: 'publisher-channel', entityType: 'channel' }],
        },
        PublicationDispatchProfile.PUBLIK_V1,
      ),
    ).resolves.toEqual([
      expect.objectContaining({ chatId: 'publisher-channel', entityType: 'channel' }),
    ]);
    expect(resolvePublicationTargets).toHaveBeenCalledWith(user, [
      { chatId: 'publisher-channel', entityType: 'channel' },
    ]);
    expect(listChats).not.toHaveBeenCalled();
    expect(listChannels).not.toHaveBeenCalled();
    expect(assertChatAdminAccess).not.toHaveBeenCalled();
    expect(assertChannelAdminAccess).not.toHaveBeenCalled();
  });

  it('keeps legacy target authorization on Major with bounded access checks', async () => {
    const listChats = jest.fn().mockResolvedValue(
      Array.from({ length: 8 }, (_, index) => ({
        id: `chat-${index}`,
        entityType: 'chat',
        title: `Chat ${index}`,
        avatarUrl: null,
        link: null,
      })),
    );
    let activeChecks = 0;
    let maxActiveChecks = 0;
    const assertChatAdminAccess = jest.fn().mockImplementation(async () => {
      activeChecks += 1;
      maxActiveChecks = Math.max(maxActiveChecks, activeChecks);
      await new Promise<void>((resolve) => setImmediate(resolve));
      activeChecks -= 1;
    });
    const resolvePublicationTargets = jest.fn();
    const service = new PublicationPublisherRoutingService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        listChats,
        listChannels: jest.fn().mockResolvedValue([]),
        assertChatAdminAccess,
        assertChannelAdminAccess: jest.fn(),
      } as never,
      { resolvePublicationTargets } as never,
    );

    await expect(
      service.resolveAudienceTargets(
        { userId: 'user-1', username: null, displayName: null },
        { selection: 'ALL_CHATS', mode: 'DYNAMIC', targets: [] },
      ),
    ).resolves.toHaveLength(8);
    expect(assertChatAdminAccess).toHaveBeenCalledTimes(8);
    expect(maxActiveChecks).toBe(4);
    expect(resolvePublicationTargets).not.toHaveBeenCalled();
  });
});

describe('PublisherDialogContextService', () => {
  it('keeps the configured channel CTA before per-publication links', async () => {
    const cta = {
      type: 'link',
      text: 'Задать вопрос или приобрести',
      url: 'https://example.test/contact',
    };
    const postSignature = {
      buildCustomPostButtons: jest.fn().mockResolvedValue([]),
      buildPostButton: jest.fn().mockResolvedValue(cta),
    };
    const service = new PublisherDialogContextService(
      {
        publisherEntitySettings: {
          upsert: jest.fn().mockResolvedValue({
            channelCommentsEnabled: true,
            channelSuggestionsEnabled: false,
          }),
        },
      } as never,
      {
        buildChannelDialogButton: (
          _chat: string,
          _kind: string,
          _thread: string,
          text: string,
        ) => ({
          type: 'link',
          text,
          url: 'https://max.ru/publik?start=comments',
        }),
      } as never,
      postSignature as never,
    );
    const context = await service.prepare({
      chatId: 'channel-1',
      entityType: 'channel',
      dialogBotId: 'publisher-bot',
      customButtons: [{ text: 'Отзывы', url: 'https://example.test/reviews' }],
    });
    expect(context.buttons.map(([button]) => button!.text)).toEqual([
      '💬 Комментарии · 0',
      'Задать вопрос или приобрести',
      'Отзывы',
    ]);
    expect(postSignature.buildPostButton).toHaveBeenCalledWith('channel-1', {
      entityType: 'channel',
      botId: 'publisher-bot',
      trafficClass: 'background',
      sourceTag: 'managed_broadcast',
    });
  });

  it.each([
    [true, true, ['comments', 'suggest']],
    [true, false, ['comments']],
    [false, true, ['suggest']],
    [false, false, []],
  ] as const)(
    'applies independent Publisher channel comments (%s) and suggestions (%s)',
    async (channelCommentsEnabled, channelSuggestionsEnabled, expectedTypes) => {
      const buildChannelDialogButton = jest.fn(
        (_chatId: string, type: string, _threadId: string, text: string) => ({
          type: 'link',
          text,
          url: `https://max.ru/publik_bot?start=${type}`,
        }),
      );
      const service = new PublisherDialogContextService(
        {
          publisherEntitySettings: {
            upsert: jest.fn().mockResolvedValue({
              channelCommentsEnabled,
              channelSuggestionsEnabled,
            }),
          },
        } as never,
        { buildChannelDialogButton } as never,
      );

      const context = await service.prepare({
        chatId: 'channel-1',
        entityType: 'channel',
        dialogBotId: 'publisher-bot',
        customButtons: [],
        includeManagedDialogs: true,
      });

      expect(buildChannelDialogButton.mock.calls.map((call) => call[1])).toEqual(expectedTypes);
      expect(context.buttons).toHaveLength(expectedTypes.length);
      if (expectedTypes.length > 0) {
        expect(context.reference).toMatchObject({
          entityType: 'channel',
          includeCommentsButton: channelCommentsEnabled,
          includeSuggestButton: channelSuggestionsEnabled,
          dialogBotId: 'publisher-bot',
        });
      } else {
        expect(context.reference).toBeNull();
      }
      expect(buildChannelDialogButton).toHaveBeenCalledTimes(expectedTypes.length);
    },
  );

  it('builds custom-only buttons without reading Major chat or channel settings', async () => {
    const chatSettingsUpsert = jest.fn();
    const channelSettingsUpsert = jest.fn();
    const service = new PublisherDialogContextService(
      {
        chatSettings: { upsert: chatSettingsUpsert },
        channelSettings: { upsert: channelSettingsUpsert },
      } as never,
      {} as never,
    );

    const context = await service.prepare({
      chatId: 'chat-publisher-only',
      entityType: 'chat',
      dialogBotId: 'publisher-bot',
      customButtons: [{ text: 'Сайт', url: 'https://example.com/path' }],
      includeManagedDialogs: false,
    });

    expect(context).toEqual({
      version: 1,
      dialogBotId: 'publisher-bot',
      buttons: [[{ type: 'link', text: 'Сайт', url: 'https://example.com/path' }]],
      reference: null,
    });
    expect(chatSettingsUpsert).not.toHaveBeenCalled();
    expect(channelSettingsUpsert).not.toHaveBeenCalled();
  });
});
