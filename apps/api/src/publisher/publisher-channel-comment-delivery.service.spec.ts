import type { ChannelPostSignatureService } from '../admin/channel-post-signature.service';
import { PublisherSetupRequiredException } from './publisher-errors';
import { PublisherCommentSetupBlockedError } from './publisher-comment-readiness';
import type { MaxUpdate } from '@maxim/contracts';
import { PublisherChannelCommentDeliveryService } from './publisher-channel-comment-delivery.service';
import { PublisherChatCommentProducerService } from './publisher-chat-comment-producer.service';
import {
  PublisherChatCommentQueueService,
  type PublisherChannelCommentAttachJob,
} from './publisher-chat-comment.queue';
import { PublisherDialogLinkService } from './publisher-dialog-link.service';
import { AdminDialogLinkHelper } from '../admin/admin-dialog-link-helper';
import { prepareStoredChannelCommentsKeyboard } from '../admin/admin-channel-comment-keyboard';
import { refreshExistingInlineKeyboardText } from '../max/max-inline-keyboard-text-refresh';
import { usesMaxFinalAuthorityCheckpoint } from '../max/max-action-pre-dispatch-guard';

const chatId = '-100';
const config = { get: () => 'publik-bot' };
const links = new PublisherDialogLinkService(
  config as never,
  { getSigningKeys: () => ['publisher-test-key'] } as never,
);

function fixture(dialogLinks = links) {
  const entity = {
    entityType: 'CHANNEL',
    publicationPolicy: {
      publikEnabled: true,
      revision: 3,
      updatedAt: new Date(Date.now() - 60_000),
    },
    publisherSettings: {
      channelCommentsEnabled: true,
      channelSuggestionsEnabled: true,
      revision: 7,
      updatedAt: new Date(Date.now() - 60_000),
    },
    channelSettings: {
      postSignatureEnabled: false,
      postSignaturePresentation: 'BUTTON',
      updatedAt: new Date(Date.now() - 60_000),
    },
  };
  const prisma = {
    chat: {
      findFirst: jest.fn().mockResolvedValue(entity),
      findUnique: jest.fn().mockResolvedValue(entity),
    },
    auditLog: { upsert: jest.fn().mockResolvedValue({}) },
    $queryRaw: jest.fn().mockResolvedValue([{ count: 4n }]),
  };
  const job: PublisherChannelCommentAttachJob = {
    version: 1,
    kind: 'attach_channel_keyboard',
    chatId,
    messageId: 'post-1',
    threadId: '11111111-1111-1111-1111-111111111111',
    requiredBotId: 'publik-bot',
    dialogBotId: 'publik-bot',
    publisherSettingsRevision: 7,
    publicationPolicyRevision: 3,
    idempotencyKey: 'publisher-channel-test',
    sourceTag: 'channel_auto_post',
    retryPolicyName: 'publisher-chat-comment',
    createdAt: new Date().toISOString(),
  };
  const message = {
    recipient: { chat_id: chatId, chat_type: 'channel' },
    body: { attachments: [] as unknown[] },
  };
  const mutate = jest.fn();
  const maxClient = {
    editMessageInlineKeyboard: jest.fn(async (_chat, _id, _text, options) => {
      const buttons = await options.prepareInlineKeyboard(message);
      if (buttons === null) return;
      await options.beforeEditMutation();
      mutate(buttons);
    }),
    getChatSnapshot: jest.fn().mockResolvedValue({ entityType: 'channel' }),
    getCurrentChatMemberAccess: jest
      .fn()
      .mockResolvedValue({ isAdmin: true, isOwner: false, permissions: ['edit_message'] }),
  };
  const readiness = {
    assertEntityReady: jest
      .fn()
      .mockResolvedValue({ entityType: 'channel', requiredBotId: 'publik-bot' }),
  };
  const runtime = { assertDispatchEnabled: jest.fn() };
  const health = {
    assertDispatchAllowed: jest.fn(),
    recordSendFailure: jest.fn().mockResolvedValue(undefined),
  };
  const postSignature = {
    buildPostButton: jest
      .fn<
        ReturnType<ChannelPostSignatureService['buildPostButton']>,
        Parameters<ChannelPostSignatureService['buildPostButton']>
      >()
      .mockResolvedValue(null),
    buildCustomPostButtons: jest
      .fn<
        ReturnType<ChannelPostSignatureService['buildCustomPostButtons']>,
        Parameters<ChannelPostSignatureService['buildCustomPostButtons']>
      >()
      .mockResolvedValue([]),
  } satisfies Pick<ChannelPostSignatureService, 'buildPostButton' | 'buildCustomPostButtons'>;
  const service = new PublisherChannelCommentDeliveryService(
    prisma as never,
    maxClient as never,
    readiness as never,
    runtime as never,
    { getBotId: () => 'publik-bot' } as never,
    dialogLinks,
    health as never,
    postSignature as never,
  );
  const queue = { enqueueChannelAttach: jest.fn() };
  const producer = new PublisherChatCommentProducerService(
    prisma as never,
    queue as never,
    config as never,
    {
      isMessageHeld: jest.fn().mockResolvedValue(false),
      isMemberHeld: jest.fn().mockResolvedValue(false),
      isGlobalUserHeld: jest.fn().mockResolvedValue(false),
    } as never,
  );
  const update: MaxUpdate = {
    updateId: 'update-1',
    type: 'message_created',
    botId: 'publik-bot',
    message: {
      chatId,
      messageId: 'post-1',
      entityType: 'channel',
      senderId: '',
      text: 'Post',
      createdAt: job.createdAt,
    },
  };
  return {
    entity,
    prisma,
    job,
    message,
    mutate,
    maxClient,
    readiness,
    runtime,
    health,
    postSignature,
    service,
    queue,
    producer,
    update,
  };
}

describe('Publisher channel keyboard webhook and delivery', () => {
  it.each([false, true])(
    'retains the installed signed comments link for later counts when adding another action: %s',
    async (addAction) => {
      const oldLinks = new PublisherDialogLinkService(
        config as never,
        { getSigningKeys: () => ['previous-publisher-key'] } as never,
      );
      const currentLinks = new PublisherDialogLinkService(
        config as never,
        { getSigningKeys: () => ['publisher-test-key', 'previous-publisher-key'] } as never,
      );
      const h = fixture(currentLinks);
      const comments = oldLinks.buildChannelDialogButton(
        chatId,
        'comments',
        h.job.threadId,
        '💬 Комментарии · 1',
        'MINIAPP',
      );
      const suggest = oldLinks.buildChannelDialogButton(
        chatId,
        'suggest',
        h.job.threadId,
        'Предложить',
        'MINIAPP',
      );
      if (comments.type !== 'link') throw new Error('Expected the signed launch link');
      const start = new URL(comments.url).searchParams.get('startapp')!;
      const token = JSON.parse(Buffer.from(start.slice(3), 'base64url').toString('utf8')).t;
      expect(currentLinks.resolveChannelDialogThreadId(chatId, 'comments', token)).toBe(
        h.job.threadId,
      );
      const shop = { type: 'link' as const, text: 'Магазин', url: 'https://example.test/shop' };
      h.message.body.attachments = [
        { type: 'image', payload: { token: 'retained-photo' } },
        { type: 'inline_keyboard', payload: { buttons: [[shop], [comments], [suggest]] } },
      ];
      if (addAction)
        h.postSignature.buildPostButton.mockResolvedValue({
          type: 'link' as const,
          text: 'Отзывы',
          url: 'https://example.test/reviews',
        });

      await h.service.process(h.job);

      expect(h.mutate).toHaveBeenCalledTimes(addAction ? 1 : 0);
      const saved = h.prisma.auditLog.upsert.mock.calls[0]![0].create.payload;
      const keyboard = prepareStoredChannelCommentsKeyboard(saved, 7)!;
      const button =
        keyboard.buttons[keyboard.commentsButton.rowIndex]![keyboard.commentsButton.columnIndex]!;
      const readText = jest.fn().mockResolvedValue('💬 Комментарии · 7');
      const refreshed = await refreshExistingInlineKeyboardText(h.message, { button, readText });
      expect(refreshed).not.toBeNull();
      expect(readText).toHaveBeenCalledTimes(1);
      expect((refreshed!.body as typeof h.message.body).attachments).toEqual([
        h.message.body.attachments[0],
        {
          type: 'inline_keyboard',
          payload: {
            buttons: [[shop], [{ ...comments, text: '💬 Комментарии · 7' }], [suggest]],
          },
        },
      ]);
    },
  );

  it('stops an unchanged admin denial before source reads or EDIT and keeps later activation possible', async () => {
    const h = fixture();
    h.readiness.assertEntityReady.mockRejectedValueOnce(
      new PublisherSetupRequiredException([chatId], 'bot_not_admin'),
    );
    await expect(h.service.process(h.job)).rejects.toBeInstanceOf(
      PublisherCommentSetupBlockedError,
    );
    expect(h.maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(h.mutate).not.toHaveBeenCalled();
    await h.service.process(h.job);
    expect(h.maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(1);
  });

  it('adds wrapper buttons without adopting a forwarded source keyboard or media', async () => {
    const h = fixture();
    Object.assign(h.message, {
      link: {
        type: 'forward',
        message: {
          attachments: [
            { type: 'video', payload: { token: 'source-video' } },
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [
                    links.buildChannelDialogButton(
                      chatId,
                      'comments',
                      'source-thread',
                      'Source',
                      'MINIAPP',
                    ),
                  ],
                ],
              },
            },
          ],
        },
      },
    });
    h.message.body.attachments = [
      {
        type: 'inline_keyboard',
        payload: {
          buttons: [[{ type: 'link' as const, text: 'Keep', url: 'https://example.com' }]],
        },
      },
    ];
    await h.service.process(h.job);
    expect(h.mutate).toHaveBeenCalledTimes(1);
    expect(h.mutate.mock.calls[0]![0]).toHaveLength(2);
    expect(h.prisma.auditLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          payload: expect.objectContaining({ threadId: h.job.threadId }),
        }),
      }),
    );
  });
  it.each([
    [true, true, 2],
    [true, false, 1],
    [false, true, 1],
  ])(
    'attaches enabled buttons (%s, %s) without Major settings or access',
    async (comments, suggestions, count) => {
      const h = fixture();
      h.entity.publisherSettings.channelCommentsEnabled = Boolean(comments);
      h.entity.publisherSettings.channelSuggestionsEnabled = Boolean(suggestions);
      await h.producer.observeWebhook(h.update);
      expect(h.queue.enqueueChannelAttach).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId,
          messageId: 'post-1',
          publisherSettingsRevision: 7,
          publicationPolicyRevision: 3,
        }),
      );
      await h.service.process(h.job);
      expect(h.mutate.mock.calls[0]![0]).toHaveLength(count as number);
      for (const [button] of h.mutate.mock.calls[0]![0]) {
        expect(new URL(button.url).pathname).toBe('/publik-bot');
      }
      expect(h.maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
        chatId,
        'post-1',
        null,
        expect.objectContaining({
          requireAllAttachmentsPreserved: true,
          mergeExistingInlineKeyboard: true,
        }),
        expect.objectContaining({ botId: 'publik-bot' }),
      );
      expect(h.prisma.auditLog.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            payload: expect.objectContaining({
              publisherProfile: true,
              botId: 'publik-bot',
              dialogBotId: 'publik-bot',
            }),
          }),
        }),
      );
    },
  );

  it('keeps Major comments without donating their thread or count reference to Publisher', async () => {
    const h = fixture();
    const majorLinks = new AdminDialogLinkHelper({
      appBaseUrl: null,
      explicitBotContactId: null,
      ownBotUserId: 'major-bot',
      maxBotToken: 'major-key',
      maxBotTokenValidationSecrets: ['major-key'],
    });
    h.message.body.attachments = [
      {
        type: 'inline_keyboard',
        payload: {
          buttons: [
            [
              majorLinks.buildChannelDialogButton(
                chatId,
                'comments',
                'major-thread',
                'Major',
                'major-bot',
                'MINIAPP',
              ),
            ],
          ],
        },
      },
    ];
    await h.service.process(h.job);
    expect(h.mutate.mock.calls[0]![0]).toHaveLength(2);
    expect(h.mutate.mock.calls[0]![0][0][0].text).toBe('Major');
    expect(h.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(h.prisma.auditLog.upsert.mock.calls[0]![0].create.payload).toMatchObject({
      includeCommentsButton: false,
      commentsButton: null,
    });
    expect(h.prisma.auditLog.upsert.mock.calls[0]![0].create.payload.threadId).toBe(h.job.threadId);
  });

  it.each(['BOT', 'MINIAPP'] as const)(
    'keeps an existing Major %s suggestion without donating its thread to Publisher',
    async (mode) => {
      const h = fixture();
      const majorLinks = new AdminDialogLinkHelper({
        appBaseUrl: null,
        explicitBotContactId: null,
        ownBotUserId: 'major-bot',
        maxBotToken: 'major-key',
        maxBotTokenValidationSecrets: ['major-key'],
      });
      h.message.body.attachments = [
        {
          type: 'inline_keyboard',
          payload: {
            buttons: [
              [
                majorLinks.buildChannelDialogButton(
                  chatId,
                  'suggest',
                  '22222222-2222-4222-8222-222222222222',
                  'Suggest',
                  'major-bot',
                  mode,
                ),
              ],
            ],
          },
        },
      ];
      await h.service.process(h.job);
      expect(h.mutate.mock.calls[0]![0]).toHaveLength(2);
      expect(h.mutate.mock.calls[0]![0][0][0].text).toContain('Комментарии');
      expect(h.prisma.auditLog.upsert.mock.calls[0]![0].create.payload).toMatchObject({
        threadId: h.job.threadId,
        publisherProfile: true,
        includeCommentsButton: true,
        includeSuggestButton: false,
      });
      h.entity.publisherSettings.channelCommentsEnabled = false;
      h.mutate.mockClear();
      await h.service.process(h.job);
      expect(h.mutate).not.toHaveBeenCalled();
    },
  );

  it('adds the configured third button to a direct post with existing comments and contact', async () => {
    const h = fixture();
    const helper = new AdminDialogLinkHelper({
      appBaseUrl: null,
      explicitBotContactId: null,
      ownBotUserId: 'major-bot',
      maxBotToken: 'major-key',
      maxBotTokenValidationSecrets: ['major-key'],
    });
    const comments = helper.buildChannelDialogButton(
      chatId,
      'comments',
      'major-thread',
      'Комментарии',
      'major-bot',
      'MINIAPP',
    );
    const contact = helper.buildChannelDialogButton(
      chatId,
      'suggest',
      'major-thread',
      'Задать вопрос или приобрести',
      'major-bot',
      'MINIAPP',
    );
    const reviews = { type: 'link' as const, text: 'Отзывы', url: 'https://example.test/reviews' };
    h.postSignature.buildPostButton.mockResolvedValue(reviews);
    h.message.body.attachments = [
      { type: 'inline_keyboard', payload: { buttons: [[comments], [contact]] } },
    ];
    await h.service.process(h.job);
    expect(h.mutate).toHaveBeenCalledWith([[comments], [contact], [reviews]]);
    expect(h.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(h.postSignature.buildPostButton).toHaveBeenCalledWith(
      chatId,
      expect.objectContaining({
        botId: 'publik-bot',
        entityType: 'channel',
        sourceTag: 'channel_auto_post',
      }),
    );
    h.message.body.attachments = [
      { type: 'inline_keyboard', payload: { buttons: [[comments], [contact], [reviews]] } },
    ];
    h.mutate.mockClear();
    await h.service.process(h.job);
    expect(h.mutate).not.toHaveBeenCalled();
  });

  it('includes the configured CTA in the Publisher comment-count reference', async () => {
    const h = fixture();
    const cta = { type: 'link' as const, text: 'Отзывы', url: 'https://example.test/reviews' };
    h.postSignature.buildPostButton.mockResolvedValue(cta);
    await h.service.process(h.job);
    const rows = h.mutate.mock.calls[0]![0];
    expect(rows).toHaveLength(3);
    expect(rows[2]).toEqual([cta]);
    expect(h.prisma.auditLog.upsert.mock.calls[0]![0].create.payload.buttonRows).toEqual(rows);
  });

  it.each(['major_first', 'publisher_first', 'same_button'] as const)(
    'reconciles duplicate comments on a fresh post even when no action is missing: %s',
    async (order) => {
      const h = fixture();
      const majorLinks = new AdminDialogLinkHelper({
        appBaseUrl: null,
        explicitBotContactId: null,
        ownBotUserId: 'major-bot',
        maxBotToken: 'major-key',
        maxBotTokenValidationSecrets: ['major-key'],
      });
      const major = majorLinks.buildChannelDialogButton(
        chatId,
        'comments',
        'major-thread',
        'Comments',
        'major-bot',
        'MINIAPP',
      );
      const publisher = links.buildChannelDialogButton(
        chatId,
        'comments',
        'publisher-thread',
        'Comments',
        'MINIAPP',
      );
      const winner = order === 'major_first' ? major : publisher;
      const duplicate = order === 'publisher_first' ? major : publisher;
      const contact = links.buildChannelDialogButton(
        chatId,
        'suggest',
        'publisher-thread',
        'Contact',
        'MINIAPP',
      );
      const reviews = {
        type: 'link' as const,
        text: 'Reviews',
        url: 'https://example.test/reviews',
      };
      h.postSignature.buildPostButton.mockResolvedValue(reviews);
      h.message.body.attachments = [
        {
          type: 'inline_keyboard',
          payload: { buttons: [[winner], [duplicate], [contact], [reviews]] },
        },
      ];

      await h.service.process(h.job);

      expect(h.mutate).toHaveBeenCalledWith([[winner], [contact]]);
      expect(h.prisma.auditLog.upsert.mock.calls[0]![0].create.payload).toMatchObject({
        includeCommentsButton: order !== 'major_first',
        threadId: 'publisher-thread',
      });
      h.message.body.attachments = [
        { type: 'inline_keyboard', payload: { buttons: [[winner], [contact], [reviews]] } },
      ];
      h.mutate.mockClear();
      await h.service.process(h.job);
      expect(h.mutate).not.toHaveBeenCalled();
    },
  );

  it('does not add a disabled CTA or infer a reviews URL from the message', async () => {
    const h = fixture();
    await h.service.process(h.job);
    expect(h.mutate.mock.calls[0]![0]).toHaveLength(2);
  });

  it('adds saved Reviews even when Publisher dialogs are off and Major owns the first two buttons', async () => {
    const h = fixture();
    h.entity.publisherSettings.channelCommentsEnabled = false;
    h.entity.publisherSettings.channelSuggestionsEnabled = false;
    h.entity.channelSettings.postSignatureEnabled = true;
    const helper = new AdminDialogLinkHelper({
      appBaseUrl: 'https://major-maksimov.ru',
      maxBotToken: 'major-token',
      maxBotTokenValidationSecrets: ['major-token'],
      ownBotUserId: 'major-bot',
      explicitBotContactId: null,
    });
    const comments = helper.buildChannelDialogButton(
      chatId,
      'comments',
      'major-thread',
      'Комментарии',
      'major-bot',
      'MINIAPP',
    );
    const contact = helper.buildChannelDialogButton(
      chatId,
      'suggest',
      'major-thread',
      'Задать вопрос или приобрести',
      'major-bot',
      'MINIAPP',
    );
    const reviews = { type: 'link' as const, text: 'Отзывы', url: 'https://example.test/reviews' };
    h.message.body.attachments = [
      { type: 'inline_keyboard', payload: { buttons: [[comments], [contact]] } },
    ];
    h.postSignature.buildPostButton.mockResolvedValue(reviews);

    await h.producer.observeWebhook(h.update);
    expect(h.queue.enqueueChannelAttach).toHaveBeenCalledTimes(1);
    await h.service.process(h.job);
    expect(h.mutate).toHaveBeenCalledWith([[comments], [contact], [reviews]]);
    expect(h.prisma.$queryRaw).not.toHaveBeenCalled();
    expect(h.prisma.auditLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          payload: expect.objectContaining({
            includeCommentsButton: false,
            includeSuggestButton: false,
            commentsButton: null,
          }),
        }),
      }),
    );

    h.message.body.attachments = [
      { type: 'inline_keyboard', payload: { buttons: [[comments], [contact], [reviews]] } },
    ];
    h.mutate.mockClear();
    await h.service.process(h.job);
    expect(h.mutate).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'signature', 'newer', 'publik_off'])(
    'does not admit a CTA-only edit when its setting is %s',
    async (state) => {
      const h = fixture();
      h.entity.publisherSettings.channelCommentsEnabled = false;
      h.entity.publisherSettings.channelSuggestionsEnabled = false;
      h.entity.channelSettings.postSignatureEnabled = state !== 'disabled';
      if (state === 'signature') h.entity.channelSettings.postSignaturePresentation = 'SIGNATURE';
      if (state === 'newer') h.entity.channelSettings.updatedAt = new Date(Date.now() + 1_000);
      if (state === 'publik_off') h.entity.publicationPolicy.publikEnabled = false;
      await h.producer.observeWebhook(h.update);
      await h.service.process(h.job);
      expect(h.queue.enqueueChannelAttach).not.toHaveBeenCalled();
      expect(h.mutate).not.toHaveBeenCalled();
    },
  );

  it('admits a saved CTA without a Publisher settings row and fences later revision changes', async () => {
    const h = fixture();
    h.prisma.chat.findFirst.mockResolvedValue({ ...h.entity, publisherSettings: null });
    h.prisma.chat.findUnique.mockResolvedValue({ ...h.entity, publisherSettings: null });
    h.entity.channelSettings.postSignatureEnabled = true;
    h.job = { ...h.job, publisherSettingsRevision: 0 };
    const reviews = { type: 'link' as const, text: 'Отзывы', url: 'https://example.test/reviews' };
    h.postSignature.buildPostButton.mockResolvedValue(reviews);
    await h.producer.observeWebhook(h.update);
    expect(h.queue.enqueueChannelAttach).toHaveBeenCalledWith(
      expect.objectContaining({ publisherSettingsRevision: 0 }),
    );
    await h.service.process(h.job);
    expect(h.mutate).toHaveBeenCalledWith([[reviews]]);

    h.mutate.mockClear();
    h.prisma.chat.findUnique.mockResolvedValue(h.entity);
    await h.service.process(h.job);
    expect(h.mutate).not.toHaveBeenCalled();
  });

  it('reconciles duplicate suggestions without relying on enabled comments', async () => {
    const h = fixture();
    h.entity.publisherSettings.channelCommentsEnabled = false;
    const suggestion = links.buildChannelDialogButton(
      chatId,
      'suggest',
      'publisher-thread',
      'Contact',
      'MINIAPP',
    );
    h.message.body.attachments = [
      { type: 'inline_keyboard', payload: { buttons: [[suggestion], [suggestion]] } },
    ];
    await h.service.process(h.job);
    expect(h.mutate).toHaveBeenCalledWith([[suggestion]]);
    expect(h.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('does not treat same-label external links or another channel as duplicate actions', async () => {
    const h = fixture();
    const comments = links.buildChannelDialogButton(
      chatId,
      'comments',
      'publisher-thread',
      'Comments',
      'MINIAPP',
    );
    const otherComments = links.buildChannelDialogButton(
      '-200',
      'comments',
      'other-thread',
      'Comments',
      'MINIAPP',
    );
    h.entity.publisherSettings.channelSuggestionsEnabled = false;
    h.message.body.attachments = [
      {
        type: 'inline_keyboard',
        payload: {
          buttons: [
            [comments],
            [otherComments],
            [{ type: 'link' as const, text: 'Comments', url: 'https://example.test/comments' }],
          ],
        },
      },
    ];
    await h.service.process(h.job);
    expect(h.mutate).not.toHaveBeenCalled();
  });

  it('does not use an expired attach job to repair historical duplicates', async () => {
    const h = fixture();
    h.job = { ...h.job, createdAt: new Date(Date.now() - 25 * 60 * 60_000).toISOString() };
    await expect(h.service.process(h.job)).rejects.toThrow('expired');
    expect(h.maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    expect(h.prisma.auditLog.upsert).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'fences the prepared signature across transport admission (changed: %s)',
    async (changed) => {
      const h = fixture();
      const cta = { type: 'link' as const, text: 'Reviews', url: 'https://example.com/reviews' };
      h.postSignature.buildPostButton.mockResolvedValue(cta);
      const checkpoint = jest.fn(async () => {
        expect(h.maxClient.getChatSnapshot).toHaveBeenCalledTimes(1);
        expect(h.maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
        expect(h.postSignature.buildPostButton).toHaveBeenCalledTimes(2);
        if (changed)
          h.entity.channelSettings.updatedAt = new Date(
            h.entity.channelSettings.updatedAt.getTime() + 1,
          );
      });
      h.maxClient.editMessageInlineKeyboard.mockImplementation(
        async (_chat, _id, _text, options) => {
          const buttons = await options.prepareInlineKeyboard(h.message);
          const guard = options.beforeEditMutation;
          expect(usesMaxFinalAuthorityCheckpoint(guard)).toBe(true);
          await guard(checkpoint);
          h.mutate(buttons);
        },
      );

      const result = h.service.process(h.job);
      if (changed)
        await expect(result).rejects.toThrow('Channel post button changed before keyboard edit');
      else await expect(result).resolves.toBeUndefined();
      expect(checkpoint).toHaveBeenCalledTimes(1);
      expect(h.prisma.chat.findUnique).toHaveBeenCalledTimes(2);
      expect(h.mutate).toHaveBeenCalledTimes(changed ? 0 : 1);
    },
  );

  it('does not edit when the CTA changes after preparing the keyboard', async () => {
    const h = fixture();
    h.postSignature.buildPostButton
      .mockResolvedValueOnce({
        type: 'link' as const,
        text: 'Отзывы',
        url: 'https://example.test/reviews',
      })
      .mockResolvedValueOnce(null);
    await expect(h.service.process(h.job)).rejects.toThrow('button changed');
    expect(h.mutate).not.toHaveBeenCalled();
    expect(h.prisma.auditLog.upsert).not.toHaveBeenCalled();
  });

  it('recovers its audit after a successful edit without editing again or resetting the thread', async () => {
    const h = fixture();
    h.message.body.attachments = [
      {
        type: 'inline_keyboard',
        payload: {
          buttons: [
            [
              links.buildChannelDialogButton(
                chatId,
                'comments',
                'existing-publisher-thread',
                'Comments',
                'MINIAPP',
              ),
            ],
            [
              links.buildChannelDialogButton(
                chatId,
                'suggest',
                'existing-publisher-thread',
                'Suggest',
                'MINIAPP',
              ),
            ],
          ],
        },
      },
    ];
    await h.service.process(h.job);
    expect(h.mutate).not.toHaveBeenCalled();
    expect(h.prisma.auditLog.upsert.mock.calls[0]![0].create.payload.threadId).toBe(
      'existing-publisher-thread',
    );
  });

  it.each(['major', 'edited', 'native', 'old', 'future', 'disabled', 'before_settings'] as const)(
    'does not enqueue %s events',
    async (kind) => {
      const h = fixture();
      if (kind === 'major') h.update.botId = 'major-bot';
      if (kind === 'edited') h.update.type = 'message_edited';
      if (kind === 'native') h.update.message!.postId = 'parent-post';
      if (kind === 'old')
        h.update.message!.createdAt = new Date(Date.now() - 25 * 60 * 60_000).toISOString();
      if (kind === 'future')
        h.update.message!.createdAt = new Date(Date.now() + 120_000).toISOString();
      if (kind === 'disabled') h.entity.publicationPolicy.publikEnabled = false;
      if (kind === 'before_settings')
        h.entity.publisherSettings.updatedAt = new Date(Date.now() + 1_000);
      await h.producer.observeWebhook(h.update);
      expect(h.queue.enqueueChannelAttach).not.toHaveBeenCalled();
    },
  );

  it('defers the webhook if Redis did not confirm durable admission', async () => {
    const h = fixture();
    h.queue.enqueueChannelAttach.mockRejectedValue(new Error('Redis unavailable') as never);
    await expect(h.producer.observeWebhook(h.update)).rejects.toThrow('durable enqueue');
  });

  it.each(['settings_epoch', 'policy_epoch', 'disabled', 'wrong_entity'] as const)(
    'skips stale %s before any MAX request',
    async (kind) => {
      const h = fixture();
      if (kind === 'settings_epoch') h.entity.publisherSettings.revision++;
      if (kind === 'policy_epoch') h.entity.publicationPolicy.revision++;
      if (kind === 'disabled') h.entity.publicationPolicy.publikEnabled = false;
      if (kind === 'wrong_entity') h.entity.entityType = 'CHAT';
      await h.service.process(h.job);
      expect(h.maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
    },
  );

  it('rechecks settings immediately before the mutation', async () => {
    const h = fixture();
    h.maxClient.getChatSnapshot.mockImplementation(async () => ({ entityType: 'channel' }));
    h.prisma.chat.findUnique.mockResolvedValueOnce(h.entity).mockResolvedValueOnce(null);
    await expect(h.service.process(h.job)).rejects.toThrow('settings changed');
    expect(h.mutate).not.toHaveBeenCalled();
    expect(h.prisma.auditLog.upsert).not.toHaveBeenCalled();
  });

  it.each(['write_only', 'remote_chat', 'wrong_bot', 'wrong_dialog', 'runtime_disabled'] as const)(
    'fails closed for %s',
    async (kind) => {
      const h = fixture();
      if (kind === 'write_only')
        h.maxClient.getCurrentChatMemberAccess.mockResolvedValue({
          isAdmin: true,
          isOwner: false,
          permissions: ['write'],
        });
      if (kind === 'remote_chat')
        h.maxClient.getChatSnapshot.mockResolvedValue({ entityType: 'chat' });
      if (kind === 'wrong_bot')
        h.readiness.assertEntityReady.mockResolvedValue({
          entityType: 'channel',
          requiredBotId: 'major-bot',
        });
      if (kind === 'wrong_dialog') h.job = { ...h.job, dialogBotId: 'major-bot' };
      if (kind === 'runtime_disabled')
        h.runtime.assertDispatchEnabled.mockImplementation(() => {
          throw new Error('disabled');
        });
      await expect(h.service.process(h.job)).rejects.toThrow();
      expect(h.mutate).not.toHaveBeenCalled();
    },
  );

  it('keeps duplicate queue identity and thread scoped to the exact Publisher and post', async () => {
    const queue = { add: jest.fn() };
    const service = new PublisherChatCommentQueueService(
      queue as never,
      config as never,
      { read: async () => ({ dispatchEnabled: true }) } as never,
    );
    const input = {
      chatId,
      messageId: 'post-1',
      publisherSettingsRevision: 7,
      publicationPolicyRevision: 3,
      createdAt: new Date(),
    };
    await service.enqueueChannelAttach(input);
    await service.enqueueChannelAttach(input);
    await service.enqueueChannelAttach({ ...input, messageId: 'post-2' });
    expect(queue.add.mock.calls[0]).toEqual(queue.add.mock.calls[1]);
    expect(queue.add.mock.calls[0]![1].threadId).not.toBe(queue.add.mock.calls[2]![1].threadId);
    expect(queue.add.mock.calls[0]![1]).toEqual(
      expect.objectContaining({ requiredBotId: 'publik-bot', dialogBotId: 'publik-bot' }),
    );
  });
});

describe('persistent Publisher channel buttons', () => {
  it('decorates custom-only posts without enabling comments or suggestions', async () => {
    const state = fixture();
    const rows = [
      [{ type: 'link' as const, text: 'Каталог', url: 'https://example.com/catalog#new' }],
    ];
    state.postSignature.buildCustomPostButtons.mockResolvedValue(rows);
    Object.assign(state.entity.channelSettings, {
      customPostButtonsEnabled: true,
      customPostButtonsSince: new Date(Date.now() - 60_000),
    });
    state.entity.publisherSettings.channelCommentsEnabled = false;
    state.entity.publisherSettings.channelSuggestionsEnabled = false;
    await state.service.process(state.job);
    expect(state.mutate).toHaveBeenCalledWith(rows);
  });
  it('keeps the published custom links when refreshing the comment count after a settings change', async () => {
    const state = fixture();
    const custom = [
      { type: 'link' as const, text: 'Каталог', url: 'https://example.com/original' },
    ];
    state.postSignature.buildCustomPostButtons.mockResolvedValue([custom]);
    await state.service.process(state.job);
    const frozen = state.prisma.auditLog.upsert.mock.calls[0]![0].create.payload;
    state.postSignature.buildCustomPostButtons.mockResolvedValue([
      [{ ...custom[0]!, url: 'https://example.com/new' }],
    ]);
    const refreshed = prepareStoredChannelCommentsKeyboard(frozen, 8)!;
    expect(refreshed.buttons.at(-1)).toEqual(custom);
    expect(refreshed.buttons[0]![0]!.text).toContain('8');
  });
});
