import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { resolveChannelAutoPostMessageText } from '../moderation/channel-auto-post-runtime';
import { ChatEntityType } from '../prisma/prisma-client';
import {
  CHANNEL_POST_MAX_TEXT_LENGTH,
  ChannelPostSignatureService,
} from './channel-post-signature.service';

function createFixture() {
  const prisma = {
    channelSettings: {
      findUnique: jest.fn().mockResolvedValue({
        postSignatureEnabled: true,
        postSignaturePresentation: 'SIGNATURE',
        postSignatureText: 'Читать канал',
        postSignatureUrl: '',
      }),
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn(),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ revision: 1 }),
    },
    vkParsingSettings: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue({}),
    },
    chat: {
      findUnique: jest.fn().mockResolvedValue({ entityType: ChatEntityType.CHANNEL }),
    },
    channelAudienceSnapshot: {
      findFirst: jest.fn().mockResolvedValue({
        link: 'http://www.max.ru/channel/news?from=old#post',
      }),
    },
    managedBotChatCatalog: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    $transaction: jest.fn(),
    $queryRaw: jest.fn().mockResolvedValue([{ id: 'channel-1' }]),
  };
  prisma.$transaction.mockImplementation(async (operation: (tx: typeof prisma) => unknown) =>
    operation(prisma),
  );
  const maxClient = {
    getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
      isAdmin: true,
      isOwner: false,
      permissions: ['edit_message'],
    }),
    getChatSnapshot: jest.fn().mockResolvedValue({
      entityType: 'channel',
      link: 'https://max.ru/channel/live',
    }),
  };
  const maxBotLinkService = {
    resolveBotIdsForModerationAction: jest.fn().mockResolvedValue(['bot-1']),
    getExecutableBotById: jest.fn((id: string) => ({ id })),
    resolveBotIdForSend: jest.fn().mockResolvedValue('bot-1'),
  };
  const service = new ChannelPostSignatureService(
    prisma as never,
    maxClient as never,
    maxBotLinkService as never,
  );

  return { maxBotLinkService, maxClient, prisma, service };
}

describe('ChannelPostSignatureService', () => {
  it('refuses activation with write-only channel access before saving anything', async () => {
    const { service, prisma, maxClient } = createFixture();
    maxClient.getCurrentChatMemberAccess.mockResolvedValue({
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
    });
    await expect(
      service.updateSettings('channel-1', 'admin', { expectedRevision: 0, enabled: true }),
    ).rejects.toThrow('право редактировать');
    expect(prisma.$transaction).not.toHaveBeenCalled();
    await expect(
      service.updateSettings('channel-1', 'admin', { expectedRevision: 0, enabled: false }),
    ).resolves.toMatchObject({ enabled: false });
  });

  it('allows an eligible standby editor even when the primary access probe fails', async () => {
    const { service, maxClient, maxBotLinkService } = createFixture();
    maxBotLinkService.resolveBotIdsForModerationAction.mockResolvedValue(['bot-1', 'bot-2']);
    maxClient.getCurrentChatMemberAccess.mockRejectedValueOnce(new Error('timeout'));
    await expect(
      service.updateSettings('channel-1', 'admin', { expectedRevision: 0, enabled: true }),
    ).resolves.toMatchObject({ enabled: true });
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenLastCalledWith(
      'channel-1',
      expect.objectContaining({
        botId: 'bot-2',
        bypassCache: true,
        trafficClass: 'interactive',
      }),
    );
  });

  it('distinguishes temporary access lookup failure from missing permissions', async () => {
    const { service, prisma, maxClient } = createFixture();
    maxClient.getCurrentChatMemberAccess.mockRejectedValue(new Error('timeout'));
    await expect(
      service.updateSettings('channel-1', 'admin', { expectedRevision: 0, enabled: true }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.channelSettings.upsert).not.toHaveBeenCalled();
  });

  it('rejects an invalid merged button label with HTTP 400 before writing', async () => {
    const { prisma, service } = createFixture();
    prisma.channelSettings.findUnique.mockResolvedValue({
      postSignatureEnabled: true,
      postSignaturePresentation: 'SIGNATURE',
      postSignatureText: 'x'.repeat(33),
      postSignatureUrl: '',
    });
    await expect(
      service.updateSettings('channel-1', 'admin', { expectedRevision: 0, presentation: 'button' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.channelSettings.upsert).not.toHaveBeenCalled();
  });

  it('rejects a stale partial update when the locked revision changed', async () => {
    const { prisma, service } = createFixture();
    prisma.channelSettings.findUnique
      .mockResolvedValueOnce({
        postSignatureEnabled: true,
        postSignaturePresentation: 'SIGNATURE',
        postSignatureText: 'Old',
        postSignatureUrl: 'https://example.com/old',
        revision: 0,
      })
      .mockResolvedValue({
        postSignatureEnabled: true,
        postSignaturePresentation: 'BUTTON',
        postSignatureText: 'Concurrent',
        postSignatureUrl: 'https://example.com/new',
        revision: 1,
      });
    await expect(
      service.updateSettings('channel-1', 'admin', { expectedRevision: 0, enabled: false }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.channelSettings.updateMany).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('does not advance the post scan baseline or write an audit for an unchanged setting', async () => {
    const { prisma, service } = createFixture();
    await service.updateSettings('channel-1', 'admin', {
      expectedRevision: 0,
      text: 'Читать канал',
    });
    expect(prisma.channelSettings.upsert).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('rejects a concurrent change that needs a new remote preflight outside the lock', async () => {
    const { prisma, service, maxClient } = createFixture();
    prisma.channelSettings.findUnique
      .mockResolvedValueOnce({
        postSignatureEnabled: false,
        postSignaturePresentation: 'SIGNATURE',
        postSignatureText: 'Read',
        postSignatureUrl: 'https://example.com/',
      })
      .mockResolvedValue({
        postSignatureEnabled: false,
        postSignaturePresentation: 'SIGNATURE',
        postSignatureText: 'Read',
        postSignatureUrl: '',
      });
    await expect(
      service.updateSettings('channel-1', 'admin', { expectedRevision: 0, enabled: true }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.channelSettings.upsert).not.toHaveBeenCalled();
    expect(maxClient.getChatSnapshot).not.toHaveBeenCalled();
  });

  it.each(['Read "news"', "Today's news", 'Read  news', 'News & updates', 'Read\nnews'])(
    'does not duplicate a MAX markup round trip for %s',
    async (label) => {
      const { prisma, service } = createFixture();
      const url = "https://example.com/read?x=1&name=it's";
      prisma.channelSettings.findUnique.mockResolvedValue({
        postSignatureEnabled: true,
        postSignaturePresentation: 'SIGNATURE',
        postSignatureText: label,
        postSignatureUrl: url,
      });
      const original = 'Post\n\n';
      const fresh = resolveChannelAutoPostMessageText(
        {
          body: {
            text: original + label,
            markup: [{ type: 'link', from: original.length, length: label.length, url }],
          },
        },
        null,
      );
      await expect(
        service.preparePostText('channel-1', {
          text: fresh.text!,
          textFormat: fresh.textFormat ?? undefined,
        }),
      ).resolves.toMatchObject({ text: fresh.text, signatureApplied: false });
    },
  );

  it('leaves chat messages unchanged without reading channel settings', async () => {
    const { prisma, service } = createFixture();

    await expect(
      service.preparePostText(
        'chat-1',
        { text: 'Сообщение', textFormat: 'markdown' },
        { entityType: 'chat' },
      ),
    ).resolves.toEqual({
      text: 'Сообщение',
      textFormat: 'markdown',
      signatureApplied: false,
    });
    expect(prisma.channelSettings.findUnique).not.toHaveBeenCalled();
    expect(prisma.chat.findUnique).not.toHaveBeenCalled();
  });

  it('adds the current channel link to plain text and engagement text', async () => {
    const { maxClient, prisma, service } = createFixture();

    const result = await service.preparePostText(
      'channel-1',
      { text: 'Новость <дня>', engagementText: 'Новость дня' },
      { entityType: 'channel', trafficClass: 'interactive', sourceTag: 'test' },
    );

    expect(result).toEqual({
      text: 'Новость &lt;дня&gt;\n\n<a href="https://max.ru/channel/news">Читать канал</a>',
      textFormat: 'html',
      engagementText: 'Новость дня\n\n[Читать канал](https://max.ru/channel/news)',
      signatureApplied: true,
    });
    expect(prisma.chat.findUnique).toHaveBeenCalledWith({
      where: { id: 'channel-1' },
      select: { entityType: true },
    });
    expect(maxClient.getChatSnapshot).not.toHaveBeenCalled();
  });

  it('preserves markdown semantics by rendering the signed message as HTML', async () => {
    const { service } = createFixture();

    const result = await service.preparePostText(
      'channel-1',
      { text: '**Важно**', textFormat: 'markdown' },
      { entityType: 'channel' },
    );

    expect(result.text).toBe(
      '<strong>Важно</strong>\n\n<a href="https://max.ru/channel/news">Читать канал</a>',
    );
    expect(result.textFormat).toBe('html');
  });

  it('preserves leading whitespace in the authored post', async () => {
    const { service } = createFixture();
    const result = await service.preparePostText('channel-1', { text: '\n  Indented post' });
    expect(result.text).toBe(
      '\n  Indented post\n\n<a href="https://max.ru/channel/news">Читать канал</a>',
    );
  });

  it('retains authored trailing spaces and blank lines before the signature', async () => {
    const { service } = createFixture();
    const result = await service.preparePostText('channel-1', { text: '  Пост  \n\n\n' });
    expect(result.text).toBe(
      '  Пост  \n\n\n<a href="https://max.ru/channel/news">Читать канал</a>',
    );
  });

  it('uses an explicit signature URL without resolving the channel link', async () => {
    const { maxClient, prisma, service } = createFixture();
    prisma.channelSettings.findUnique.mockResolvedValue({
      postSignatureEnabled: true,
      postSignaturePresentation: 'SIGNATURE',
      postSignatureText: 'Заказать рекламу',
      postSignatureUrl: 'https://ads.example/contact?source=(channel)',
    });

    await expect(
      service.preparePostText(
        'channel-1',
        { text: 'Новость', engagementText: 'Новость' },
        { entityType: 'channel' },
      ),
    ).resolves.toEqual({
      text: 'Новость\n\n<a href="https://ads.example/contact?source=(channel)">Заказать рекламу</a>',
      textFormat: 'html',
      engagementText:
        'Новость\n\n[Заказать рекламу](https://ads.example/contact?source=%28channel%29)',
      signatureApplied: true,
    });
    expect(prisma.channelAudienceSnapshot.findFirst).not.toHaveBeenCalled();
    expect(prisma.managedBotChatCatalog.findFirst).not.toHaveBeenCalled();
    expect(maxClient.getChatSnapshot).not.toHaveBeenCalled();
  });

  it('returns a button without appending the action to the post text', async () => {
    const { maxClient, prisma, service } = createFixture();
    prisma.channelSettings.findUnique.mockResolvedValue({
      postSignatureEnabled: true,
      postSignaturePresentation: 'BUTTON',
      postSignatureText: '📞 Заказать рекламу',
      postSignatureUrl: 'https://ads.example/contact',
    });

    await expect(
      service.preparePostText(
        'channel-1',
        { text: 'Новость', textFormat: 'markdown' },
        { entityType: 'channel' },
      ),
    ).resolves.toEqual({
      text: 'Новость',
      textFormat: 'markdown',
      signatureApplied: false,
    });
    await expect(service.buildPostButton('channel-1', { entityType: 'channel' })).resolves.toEqual({
      type: 'link',
      text: '📞 Заказать рекламу',
      url: 'https://ads.example/contact',
    });
    expect(maxClient.getChatSnapshot).not.toHaveBeenCalled();
  });

  it('resolves a Publisher CTA fallback with the exact Publisher bot, without Major routing', async () => {
    const { maxClient, maxBotLinkService, prisma, service } = createFixture();
    prisma.channelSettings.findUnique.mockResolvedValue({
      postSignatureEnabled: true,
      postSignaturePresentation: 'BUTTON',
      postSignatureText: 'Читать канал',
      postSignatureUrl: '',
    });
    prisma.channelAudienceSnapshot.findFirst.mockResolvedValue(null as never);
    await expect(
      service.buildPostButton('channel-1', {
        entityType: 'channel',
        botId: 'publisher-bot',
        sourceTag: 'channel_auto_post',
      }),
    ).resolves.toMatchObject({ url: 'https://max.ru/channel/live' });
    expect(maxBotLinkService.resolveBotIdForSend).not.toHaveBeenCalled();
    expect(maxClient.getChatSnapshot).toHaveBeenCalledWith('channel-1', {
      botId: 'publisher-bot',
      trafficClass: 'background',
      sourceTag: 'channel_auto_post',
    });
  });

  it('does not append the same trailing channel signature twice', async () => {
    const { service } = createFixture();
    const signedText = 'Новость\n\n<a href="https://max.ru/channel/news">Читать канал</a>';

    await expect(
      service.preparePostText(
        'channel-1',
        { text: signedText, textFormat: 'html' },
        { entityType: 'channel' },
      ),
    ).resolves.toEqual({
      text: signedText,
      textFormat: 'html',
      signatureApplied: false,
    });
  });

  it('still enforces the text limit when the trailing signature is already present', async () => {
    const { service } = createFixture();
    const signedText = `Новость\n\n<a href="https://max.ru/channel/news">Читать канал</a>`;

    await expect(
      service.preparePostText(
        'channel-1',
        { text: signedText, textFormat: 'html' },
        { entityType: 'channel', maxLength: signedText.length - 1 },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a post when the rendered text and signature exceed the MAX limit', async () => {
    const { service } = createFixture();

    await expect(
      service.preparePostText(
        'channel-1',
        { text: 'a'.repeat(CHANNEL_POST_MAX_TEXT_LENGTH) },
        { entityType: 'channel' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('fails closed when an enabled signature has no resolvable public link', async () => {
    const { maxClient, prisma, service } = createFixture();
    prisma.channelAudienceSnapshot.findFirst.mockResolvedValue(null);
    prisma.managedBotChatCatalog.findFirst.mockResolvedValue(null);
    maxClient.getChatSnapshot.mockResolvedValue({ entityType: 'channel', link: null });

    await expect(
      service.preparePostText('channel-1', { text: 'Новость' }, { entityType: 'channel' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reports a temporary failure when live channel metadata cannot be loaded', async () => {
    const { maxClient, prisma, service } = createFixture();
    prisma.channelAudienceSnapshot.findFirst.mockResolvedValue(null);
    prisma.managedBotChatCatalog.findFirst.mockResolvedValue(null);
    maxClient.getChatSnapshot.mockRejectedValue(new Error('MAX unavailable'));

    await expect(
      service.preparePostText('channel-1', { text: 'Новость' }, { entityType: 'channel' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('updates only the Major channel signature and audit in one transaction', async () => {
    const { prisma, service } = createFixture();

    await expect(
      service.updateSettings('channel-1', 'admin-1', {
        expectedRevision: 0,
        enabled: true,
        presentation: 'button',
        text: '  Новый текст  ',
        url: ' https://max.ru/advertising ',
      }),
    ).resolves.toEqual({
      enabled: true,
      presentation: 'button',
      text: 'Новый текст',
      url: 'https://max.ru/advertising',
      revision: 1,
    });

    expect(prisma.channelSettings.updateMany).toHaveBeenCalledWith({
      where: { chatId: 'channel-1', revision: 0 },
      data: {
        revision: { increment: 1 },
        postSignatureEnabled: true,
        postSignaturePresentation: 'BUTTON',
        postSignatureText: 'Новый текст',
        postSignatureUrl: 'https://max.ru/advertising',
      },
    });
    expect(prisma.vkParsingSettings.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: {
        chatId: 'channel-1',
        actorUserId: 'admin-1',
        action: 'UPDATE_CHANNEL_POST_SIGNATURE',
        payload: { settingKeys: ['enabled', 'presentation', 'text', 'url'] },
      },
    });
    expect(prisma.channelAudienceSnapshot.findFirst).not.toHaveBeenCalled();
  });
});
