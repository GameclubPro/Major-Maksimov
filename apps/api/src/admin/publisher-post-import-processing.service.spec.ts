import { BadRequestException } from '@nestjs/common';
import sharp from 'sharp';
import {
  MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES,
  MaxMediaUploadValidationError,
  validateMaxMediaUploadPayload,
} from '../max/max-media-upload-validation';
import { PublisherPostImportStatus } from '../prisma/prisma-client';
import { PublisherPostImportProcessingService } from './publisher-post-import-processing.service';

const NOW = new Date('2026-08-28T12:00:00.000Z');

function processingSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    publisherBotId: 'publik_bot',
    actorUserId: '42',
    requestId: 'request_123456',
    startToken: 'start-token-1',
    status: PublisherPostImportStatus.PROCESSING,
    privateChatId: '42',
    incomingMessageId: 'incoming-mid-1',
    sourceWebhookEventId: null,
    publicationId: null,
    failureCode: null,
    omissions: [],
    capturedAt: NOW,
    captureGuardUntil: new Date(NOW.getTime() + 60_000),
    lockedAt: null,
    lockToken: null,
    expiresAt: new Date(NOW.getTime() + 15 * 60_000),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function exactForwardedMessage(linkedMessage: Record<string, unknown>) {
  return {
    mid: 'incoming-mid-1',
    sender: { user_id: 42 },
    recipient: { chat_id: 42, chat_type: 'dialog' },
    body: { text: '' },
    link: {
      type: 'forward',
      message: linkedMessage,
    },
  };
}

function persistedForwardReceipt(params: {
  incomingMessageId: string;
  linkedMessage: Record<string, unknown>;
  rawMessageId?: string | null;
}) {
  const body =
    params.rawMessageId === null
      ? null
      : { mid: params.rawMessageId ?? params.incomingMessageId, text: '' };
  return {
    botId: 'publik_bot',
    normalizedPayload: {
      updateId: 'update-forward-1',
      botId: 'publik_bot',
      type: 'message_created',
      message: {
        messageId: params.incomingMessageId,
        chatId: '42',
        senderId: '42',
        text: '',
        createdAt: NOW.toISOString(),
      },
      raw: {
        update_type: 'message_created',
        message: {
          sender: { user_id: 42 },
          recipient: { chat_id: 42, chat_type: 'dialog' },
          body,
          link: { type: 'forward', message: params.linkedMessage },
        },
      },
    },
  };
}

function createFixture(
  exactMessage?: Record<string, unknown>,
  sessionOverrides: Record<string, unknown> = {},
) {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    publicationSchedule: { create: jest.fn().mockResolvedValue({}) },
    publication: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'publication-1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    publicationMutationRecord: { create: jest.fn().mockResolvedValue({}) },
    publisherPostImportSession: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const prisma = {
    publisherPostImportSession: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn().mockResolvedValue(processingSession(sessionOverrides)),
    },
    webhookEvent: { findUnique: jest.fn() },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
  };
  const maxClient = {
    getExactMessageRow: jest.fn().mockResolvedValue(
      exactMessage ?? {
        mid: 'incoming-mid-1',
        sender: { user_id: 42 },
        recipient: { chat_id: 42, chat_type: 'dialog' },
        body: { text: 'outer **text**' },
        link: {
          type: 'forward',
          message: {
            mid: 'source-mid-1',
            body: {
              text: 'Привет мир',
              markup: [{ type: 'strong', from: 0, length: 6 }],
            },
            attachments: [],
          },
        },
      },
    ),
    getVideoDownloadUrl: jest.fn(),
    validateMediaUploadPayload: jest.fn().mockResolvedValue({
      extension: 'jpg',
      mimeType: 'image/jpeg',
    }),
  };
  const contentService = {
    prepareBinaryContentRevision: jest.fn(async (content: Record<string, unknown>) => ({
      ...content,
      assets: [],
    })),
    assertPublisherCompatibleContent: jest.fn().mockResolvedValue(undefined),
    persistPreparedContentRevision: jest.fn().mockResolvedValue({ id: 'content-1' }),
  };
  return {
    service: new PublisherPostImportProcessingService(
      prisma as never,
      maxClient as never,
      contentService as never,
    ),
    prisma,
    tx,
    maxClient,
    contentService,
  };
}

describe('PublisherPostImportProcessingService', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('combines direct and forwarded items only in the collection owner dialog, storing review with the draft', async () => {
    const { service, prisma, tx, maxClient, contentService } = createFixture(undefined, {
      inputMode: 'collection',
      inputMessages: [
        { messageId: 'incoming-mid-1', webhookEventId: 'r1' },
        { messageId: 'second', webhookEventId: 'r2' },
      ],
    });
    const first = persistedForwardReceipt({
      incomingMessageId: 'incoming-mid-1',
      linkedMessage: {},
    });
    const firstMessage = first.normalizedPayload.raw.message;
    const direct = {
      ...first,
      normalizedPayload: {
        ...first.normalizedPayload,
        raw: {
          ...first.normalizedPayload.raw,
          message: {
            ...firstMessage,
            link: null,
            body: { mid: 'incoming-mid-1', text: 'Личный текст' },
          },
        },
      },
    };
    const second = persistedForwardReceipt({
      incomingMessageId: 'second',
      linkedMessage: {
        text: 'Исходный пост',
        attachments: [{ type: 'share', payload: { url: 'https://example.com/ref' } }],
      },
    });
    Object.assign(second.normalizedPayload.raw.message.body!, { text: 'Комментарий автора' });
    prisma.webhookEvent.findUnique.mockResolvedValueOnce(direct).mockResolvedValueOnce(second);
    const log = jest
      .spyOn(
        (service as unknown as { logger: { log: (data: unknown, message: string) => void } })
          .logger,
        'log',
      )
      .mockImplementation(() => undefined);
    jest.setSystemTime(new Date(NOW.getTime() + 1250));
    await expect(service.process('session-1')).resolves.toBe('ready');
    expect(log).toHaveBeenCalledWith(
      {
        sessionId: 'session-1',
        publicationId: 'publication-1',
        snapshotSource: 'webhook_receipt',
        inputMode: 'collection',
        inputKind: 'collection',
        elapsedMs: 1250,
        mediaKind: 'text',
        mediaCount: 0,
        warningCount: 2,
        suggestionCount: 2,
        lossWarningCount: 0,
        omissionKindCount: 0,
        importCompleteness: 'complete',
      },
      'Publisher forwarded post import completed',
    );
    expect(maxClient.getExactMessageRow).not.toHaveBeenCalled();
    expect(contentService.prepareBinaryContentRevision).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Личный текст\n\nИсходный пост' }),
    );
    expect(tx.publicationSchedule.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rule: expect.objectContaining({
            importReview: {
              resolved: [],
              omissions: [],
              warnings: [
                {
                  messageIndex: 2,
                  kind: 'text',
                  reason: 'outer_comment',
                  value: 'Комментарий автора',
                },
                {
                  messageIndex: 2,
                  itemIndex: 1,
                  kind: 'link',
                  reason: 'optional_link',
                  value: 'https://example.com/ref',
                },
              ],
            },
          }),
        }),
      }),
    );
  });

  it.each([
    [
      'direct',
      { body: { text: 'Полезный текст', attachments: [{ type: 'inline_keyboard' }] } },
      0,
      1,
    ],
    [
      'forward',
      {
        link: {
          type: 'forward',
          message: { text: 'Полезный текст', attachments: [{ type: 'file' }] },
        },
      },
      1,
      1,
    ],
  ] as const)(
    'reports a partial import for real %s content in message mode',
    async (inputKind, source, lossWarningCount, omissionKindCount) => {
      const { service } = createFixture(
        {
          mid: 'incoming-mid-1',
          sender: { user_id: 42 },
          recipient: { chat_id: 42, chat_type: 'dialog' },
          ...source,
        },
        { inputMode: 'message' },
      );
      const logger = (
        service as unknown as { logger: { log: (data: unknown, message: string) => void } }
      ).logger;
      const log = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
      await expect(service.process('session-1')).resolves.toBe('ready');
      expect(log).toHaveBeenCalledWith(
        expect.objectContaining({
          inputKind,
          inputMode: 'message',
          importCompleteness: 'partial',
          lossWarningCount,
          omissionKindCount,
          suggestionCount: 0,
        }),
        'Publisher forwarded post import completed',
      );
    },
  );

  it('applies the manual draft quota before creating an imported revision', async () => {
    const { service, tx, prisma } = createFixture();
    tx.publication.findMany.mockResolvedValue(
      Array.from({ length: 50 }, () => ({ canonicalContentRevision: null })),
    );
    await expect(service.process('session-1')).resolves.toBe('failed');
    expect(tx.$executeRaw).toHaveBeenCalled();
    expect(tx.publication.create).not.toHaveBeenCalled();
    expect(prisma.publisherPostImportSession.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ failureCode: 'draft_quota' }) }),
    );
  });

  it('falls back to remote exact lookup and preserves structured UTF-16 markup', async () => {
    const { service, maxClient, contentService, tx } = createFixture();

    await expect(service.process('session-1')).resolves.toBe('ready');

    expect(maxClient.getExactMessageRow).toHaveBeenCalledWith(
      '42',
      'incoming-mid-1',
      expect.objectContaining({ botId: 'publik_bot' }),
    );
    expect(contentService.prepareBinaryContentRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '**Привет** мир',
        textFormat: 'markdown',
        buttons: [],
      }),
    );
    expect(contentService.prepareBinaryContentRevision).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('outer') }),
    );
    expect(tx.publicationMutationRecord.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        actorUserId: '42',
        publicationId: 'publication-1',
        resultingVersion: 1,
      }),
    });
  });

  it('prefers an authenticated receipt for an ordinary forwarded message id', async () => {
    const linkedMessage = { text: 'Пост из сохраненного webhook', attachments: [] };
    const { service, prisma, maxClient, contentService } = createFixture(undefined, {
      sourceWebhookEventId: 'webhook-event-real-mid-1',
    });
    prisma.webhookEvent.findUnique.mockResolvedValue(
      persistedForwardReceipt({ incomingMessageId: 'incoming-mid-1', linkedMessage }),
    );

    await expect(service.process('session-1')).resolves.toBe('ready');

    expect(maxClient.getExactMessageRow).not.toHaveBeenCalled();
    expect(contentService.prepareBinaryContentRevision).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Пост из сохраненного webhook' }),
    );
  });

  it('falls back to remote exact lookup when the referenced receipt is missing', async () => {
    const { service, prisma, maxClient } = createFixture(undefined, {
      sourceWebhookEventId: 'webhook-event-missing-1',
    });
    prisma.webhookEvent.findUnique.mockResolvedValue(null);

    await expect(service.process('session-1')).resolves.toBe('ready');

    expect(maxClient.getExactMessageRow).toHaveBeenCalledWith(
      '42',
      'incoming-mid-1',
      expect.objectContaining({ botId: 'publik_bot' }),
    );
  });

  it('rejects a receipt whose raw message id differs from the normalized captured id', async () => {
    const { service, prisma, maxClient, contentService } = createFixture(undefined, {
      sourceWebhookEventId: 'webhook-event-mismatched-mid-1',
    });
    prisma.webhookEvent.findUnique.mockResolvedValue(
      persistedForwardReceipt({
        incomingMessageId: 'incoming-mid-1',
        rawMessageId: 'another-mid',
        linkedMessage: { text: 'Не должен импортироваться', attachments: [] },
      }),
    );

    await expect(service.process('session-1')).resolves.toBe('failed');

    expect(maxClient.getExactMessageRow).not.toHaveBeenCalled();
    expect(contentService.prepareBinaryContentRevision).not.toHaveBeenCalled();
    expect(prisma.publisherPostImportSession.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          failureCode: 'message_unavailable',
          status: PublisherPostImportStatus.FAILED,
        }),
      }),
    );
  });

  it('treats a share attachment as supplemental when the forwarded post has text', async () => {
    const previewUrl = 'https://preview.example/hidden-card';
    const { service, contentService } = createFixture(
      exactForwardedMessage({
        text: 'Текст публикации',
        attachments: [
          {
            type: 'share',
            title: 'Карточка предпросмотра',
            payload: { url: previewUrl },
          },
        ],
      }),
    );

    await expect(service.process('session-1')).resolves.toBe('ready');

    expect(contentService.prepareBinaryContentRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Текст публикации',
        textFormat: 'plain',
        media: [],
        omissions: [],
      }),
    );
    expect(contentService.prepareBinaryContentRevision).not.toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining(previewUrl) }),
    );
  });

  it('imports a share-only post as its safe HTTP URL', async () => {
    const shareUrl = 'http://example.com/shared-post?source=max';
    const { service, contentService } = createFixture(
      exactForwardedMessage({
        text: '',
        attachments: [{ type: 'share', payload: { url: shareUrl } }],
      }),
    );

    await expect(service.process('session-1')).resolves.toBe('ready');

    expect(contentService.prepareBinaryContentRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        text: shareUrl,
        textFormat: 'plain',
        media: [],
        omissions: [],
      }),
    );
  });

  it.each([
    ['credential-bearing URL', { payload: { url: 'https://user:secret@example.com/post' } }],
    ['non-HTTP URL', { payload: { url: 'javascript:alert(1)' } }],
    ['malformed URL', { payload: { url: 'not a url' } }],
    ['root-level URL', { url: 'https://example.com/not-in-payload' }],
    [
      'URL that exceeds the text limit after normalization',
      { payload: { url: `https://example.com/?q=${'a b'.repeat(1_300)}` } },
    ],
  ])('rejects a share-only post with %s', async (_case, shareFields) => {
    const { service } = createFixture();
    const internal = service as unknown as {
      buildContent: (message: Record<string, unknown>, botId: string) => Promise<unknown>;
    };

    await expect(
      internal.buildContent({ attachments: [{ type: 'share', ...shareFields }] }, 'publik_bot'),
    ).rejects.toMatchObject({ code: 'empty_content' });
  });

  it('keeps transferable text and reports omitted unsupported attachments', async () => {
    const { service, contentService, tx } = createFixture(
      exactForwardedMessage({
        text: 'Сохраните этот текст',
        attachments: [
          { type: 'audio', payload: { token: 'audio-token' } },
          { type: 'file', payload: { token: 'file-token' }, filename: 'details.pdf' },
        ],
      }),
    );

    await expect(service.process('session-1')).resolves.toBe('ready');

    expect(contentService.prepareBinaryContentRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Сохраните этот текст',
        media: [],
        omissions: ['attachments_not_imported'],
      }),
    );
    expect(tx.publisherPostImportSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ omissions: ['attachments_not_imported'] }),
      }),
    );
  });

  it('rejects an unsupported-only post and logs no content or user metadata', async () => {
    const { service, contentService, prisma } = createFixture(
      exactForwardedMessage({
        attachments: [
          {
            type: 'file',
            payload: { url: 'https://private.example/sensitive-document' },
            filename: 'private-document.pdf',
          },
        ],
      }),
    );
    const logger = (service as unknown as { logger: { log: (...args: unknown[]) => void } }).logger;
    const terminalLog = jest.spyOn(logger, 'log').mockImplementation(() => undefined);

    await expect(service.process('session-1')).resolves.toBe('failed');

    expect(contentService.prepareBinaryContentRevision).not.toHaveBeenCalled();
    expect(prisma.publisherPostImportSession.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PublisherPostImportStatus.FAILED,
          failureCode: 'empty_content',
        }),
      }),
    );
    expect(terminalLog).toHaveBeenCalledWith(
      {
        sessionId: 'session-1',
        failureCode: 'empty_content',
        rejectionKind: 'empty_content',
        snapshotSource: 'remote_exact',
        inputMode: 'forward',
        inputKind: 'forward',
        elapsedMs: 0,
      },
      'Publisher forwarded post import rejected',
    );
    expect(JSON.stringify(terminalLog.mock.calls)).not.toContain('private-document');
    expect(JSON.stringify(terminalLog.mock.calls)).not.toContain('private.example');
    expect(JSON.stringify(terminalLog.mock.calls)).not.toContain('actorUserId');
  });

  it('imports photo and token-backed video in source order without reading the thumbnail', async () => {
    const { service, maxClient } = createFixture();
    maxClient.getVideoDownloadUrl.mockResolvedValue('https://v.max.ru/asset.mp4');
    const internals = service as unknown as {
      buildContent: (
        message: Record<string, unknown>,
        botId: string,
      ) => Promise<{ media: Array<{ type: string }>; text: string; warnings: unknown[] }>;
      downloadMedia: (
        url: string,
        max: number,
        type: string,
      ) => Promise<{ bytes: Buffer; mimeType: string }>;
    };
    const fetch = jest
      .spyOn(internals, 'downloadMedia')
      .mockImplementation(async (_url, _max, type) => ({
        bytes: Buffer.from(type),
        mimeType: type === 'image' ? 'image/jpeg' : 'video/mp4',
      }));
    const draft = await internals.buildContent(
      {
        text: 'Автор https://example.com',
        attachments: [
          {
            type: 'video',
            payload: { token: 'video-token', thumbnail: { url: 'https://v.max.ru/poster.jpg' } },
          },
          { type: 'file' },
          { type: 'image', payload: { url: 'https://i.max.ru/photo' } },
        ],
      },
      'publik_bot',
    );
    expect(draft.media.map((item) => item.type)).toEqual(['video', 'image']);
    expect(draft.text).toBe('Автор https://example.com');
    expect(draft.warnings).toEqual([
      { messageIndex: 1, itemIndex: 2, kind: 'attachment', reason: 'unsupported' },
    ]);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://v.max.ru/asset.mp4',
      'https://i.max.ru/photo',
    ]);
  });

  it('recovers an official body=null pure forward from its exact authenticated receipt', async () => {
    const incomingMessageId = 'message_created:update-pure-1';
    const { service, prisma, maxClient, contentService } = createFixture(undefined, {
      incomingMessageId,
      sourceWebhookEventId: 'webhook-event-pure-1',
    });
    prisma.webhookEvent.findUnique.mockResolvedValue({
      botId: 'publik_bot',
      normalizedPayload: {
        updateId: 'update-pure-1',
        botId: 'publik_bot',
        type: 'message_created',
        message: {
          messageId: incomingMessageId,
          chatId: '42',
          senderId: '42',
          text: 'Пересланный пост',
          createdAt: NOW.toISOString(),
        },
        raw: {
          update_type: 'message_created',
          message: {
            sender: { user_id: 42 },
            recipient: { chat_id: 42, chat_type: 'dialog' },
            body: null,
            link: {
              type: 'forward',
              chat_id: -100500,
              message: {
                mid: 'source-mid-pure-1',
                text: 'Пересланный пост',
                attachments: [],
              },
            },
          },
        },
      },
    });

    await expect(service.process('session-1')).resolves.toBe('ready');

    expect(prisma.webhookEvent.findUnique).toHaveBeenCalledWith({
      where: { id: 'webhook-event-pure-1' },
      select: { botId: true, normalizedPayload: true },
    });
    expect(maxClient.getExactMessageRow).not.toHaveBeenCalled();
    expect(contentService.prepareBinaryContentRevision).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Пересланный пост', textFormat: 'plain' }),
    );
  });

  it('falls back to plain source text when markup cannot be serialized', async () => {
    const exactMessage = {
      mid: 'incoming-mid-1',
      sender: { user_id: 42 },
      recipient: { chat_id: 42, chat_type: 'dialog' },
      link: {
        type: 'forward',
        message: {
          body: {
            text: 'a`b',
            markup: [{ type: 'monospaced', from: 0, length: 3 }],
          },
          attachments: [],
        },
      },
    };
    const { service, contentService, tx } = createFixture(exactMessage);

    await expect(service.process('session-1')).resolves.toBe('ready');

    expect(contentService.prepareBinaryContentRevision).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'a`b', textFormat: 'plain' }),
    );
    expect(tx.publisherPostImportSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ omissions: ['formatting_not_preserved'] }),
      }),
    );
  });

  it('falls back to bounded plain text when Markdown escaping expands past 4 000', async () => {
    const sourceText = '*'.repeat(3_998);
    const exactMessage = {
      mid: 'incoming-mid-1',
      sender: { user_id: 42 },
      recipient: { chat_id: 42, chat_type: 'dialog' },
      link: {
        type: 'forward',
        message: {
          body: {
            text: sourceText,
            markup: [{ type: 'strong', from: 0, length: 1 }],
          },
          attachments: [],
        },
      },
    };
    const { service, contentService, tx } = createFixture(exactMessage);

    await expect(service.process('session-1')).resolves.toBe('ready');

    expect(contentService.prepareBinaryContentRevision).toHaveBeenCalledWith(
      expect.objectContaining({ text: sourceText, textFormat: 'plain' }),
    );
    expect(tx.publisherPostImportSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ omissions: ['formatting_not_preserved'] }),
      }),
    );
  });

  it('normalizes an opaque forwarded WebP while preserving its text', async () => {
    const webp = await sharp({
      create: {
        width: 8,
        height: 6,
        channels: 3,
        background: { r: 20, g: 80, b: 160 },
      },
    })
      .webp()
      .toBuffer();
    const { service, maxClient } = createFixture();
    maxClient.validateMediaUploadPayload.mockImplementation(validateMaxMediaUploadPayload);
    const internal = service as unknown as {
      buildContent: (
        message: Record<string, unknown>,
        botId: string,
      ) => Promise<{
        text: string;
        media: Array<{ bytes: Buffer; mimeType: string; fileName: string }>;
      }>;
      downloadMedia: () => Promise<{ bytes: Buffer; mimeType: string }>;
    };
    internal.downloadMedia = jest.fn().mockResolvedValue({ bytes: webp, mimeType: 'image/webp' });

    const content = await internal.buildContent(
      {
        text: 'Подпись к фото',
        attachments: [{ type: 'image', payload: { url: 'https://i.oneme.ru/webp' } }],
      },
      'publik_bot',
    );

    expect(content.text).toBe('Подпись к фото');
    expect(content.media).toEqual([
      expect.objectContaining({ mimeType: 'image/jpeg', fileName: 'forwarded-image-1.jpg' }),
    ]);
    await expect(
      validateMaxMediaUploadPayload('image', content.media[0]!.bytes),
    ).resolves.toMatchObject({ format: 'jpeg' });
  });

  it('normalizes an image-only AVIF with alpha into PNG', async () => {
    const avif = await sharp({
      create: {
        width: 7,
        height: 5,
        channels: 4,
        background: { r: 40, g: 120, b: 200, alpha: 0.5 },
      },
    })
      .avif()
      .toBuffer();
    const { service, maxClient } = createFixture();
    maxClient.validateMediaUploadPayload.mockImplementation(validateMaxMediaUploadPayload);
    const internal = service as unknown as {
      buildContent: (
        message: Record<string, unknown>,
        botId: string,
      ) => Promise<{
        text: string;
        media: Array<{ bytes: Buffer; mimeType: string; fileName: string }>;
      }>;
      downloadMedia: () => Promise<{ bytes: Buffer; mimeType: string }>;
    };
    internal.downloadMedia = jest.fn().mockResolvedValue({ bytes: avif, mimeType: 'image/avif' });

    const content = await internal.buildContent(
      { attachments: [{ type: 'image', payload: { url: 'https://i.oneme.ru/avif' } }] },
      'publik_bot',
    );

    expect(content.text).toBe('');
    expect(content.media).toEqual([
      expect.objectContaining({ mimeType: 'image/png', fileName: 'forwarded-image-1.png' }),
    ]);
  });

  it.each([
    [MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD, 'media_download_failed'],
    [MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.IMAGE_DIMENSIONS_EXCEEDED, 'image_dimensions'],
    [MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.IMAGE_DECODE_BUDGET_EXCEEDED, 'image_dimensions'],
  ] as const)('maps image validation code %s to %s', async (validationCode, failureCode) => {
    const { service, maxClient } = createFixture();
    maxClient.validateMediaUploadPayload.mockRejectedValue(
      new MaxMediaUploadValidationError(validationCode, 'image'),
    );
    const internal = service as unknown as {
      buildContent: (message: Record<string, unknown>, botId: string) => Promise<unknown>;
      downloadMedia: () => Promise<{ bytes: Buffer; mimeType: string }>;
    };
    internal.downloadMedia = jest.fn().mockResolvedValue({
      bytes: Buffer.from('invalid-image'),
      mimeType: 'image/jpeg',
    });

    await expect(
      internal.buildContent(
        { attachments: [{ type: 'image', payload: { url: 'https://i.oneme.ru/invalid' } }] },
        'publik_bot',
      ),
    ).rejects.toMatchObject({ code: failureCode });
  });

  it('terminalizes downloaded MIME spoof validation instead of retrying until timeout', async () => {
    const { service, contentService, prisma } = createFixture();
    const logger = (service as unknown as { logger: { log: (...args: unknown[]) => void } }).logger;
    const terminalLog = jest.spyOn(logger, 'log').mockImplementation(() => undefined);
    contentService.prepareBinaryContentRevision.mockRejectedValue(
      new BadRequestException('Видео повреждено.'),
    );

    await expect(service.process('session-1')).resolves.toBe('failed');

    expect(prisma.publisherPostImportSession.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: PublisherPostImportStatus.FAILED,
          failureCode: 'media_invalid',
        }),
      }),
    );
    expect(terminalLog).toHaveBeenCalledWith(
      {
        sessionId: 'session-1',
        failureCode: 'media_invalid',
        rejectionKind: 'content_validation',
        snapshotSource: 'remote_exact',
        inputMode: 'forward',
        inputKind: 'forward',
        elapsedMs: 0,
      },
      'Publisher forwarded post import rejected',
    );
  });

  it('downloads image batches concurrently while preserving source order', async () => {
    const { service } = createFixture();
    const internal = service as unknown as {
      buildContent: (
        message: Record<string, unknown>,
        botId: string,
      ) => Promise<{ media: Array<{ bytes: Buffer; fileName: string }> }>;
      downloadMedia: (
        url: string,
        maxBytes: number,
        type: 'image' | 'video',
      ) => Promise<{ bytes: Buffer; mimeType: string }>;
    };
    let active = 0;
    let maxActive = 0;
    internal.downloadMedia = jest.fn(async (url: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, url.endsWith('/1') ? 30 : 10));
      active -= 1;
      return { bytes: Buffer.from(url.at(-1)!), mimeType: 'image/jpeg' };
    });
    const contentPromise = internal.buildContent(
      {
        text: '',
        attachments: [1, 2, 3, 4].map((id) => ({
          type: 'image',
          payload: { url: `https://i.max.ru/${id}` },
        })),
      },
      'publik_bot',
    );
    await jest.advanceTimersByTimeAsync(50);
    const content = await contentPromise;

    expect(maxActive).toBe(3);
    expect(content.media.map((item) => item.bytes.toString())).toEqual(['1', '2', '3', '4']);
    expect(content.media.map((item) => item.fileName)).toEqual([
      'forwarded-image-1.jpg',
      'forwarded-image-2.jpg',
      'forwarded-image-3.jpg',
      'forwarded-image-4.jpg',
    ]);
  });

  it('checks the cumulative normalized image limit while downloading', async () => {
    const { service } = createFixture();
    const internal = service as unknown as {
      buildContent: (message: Record<string, unknown>, botId: string) => Promise<unknown>;
      downloadMedia: () => Promise<{ bytes: Buffer; mimeType: string }>;
    };
    internal.downloadMedia = jest.fn(async () => ({
      bytes: Buffer.alloc(5_000_000),
      mimeType: 'image/jpeg',
    }));

    await expect(
      internal.buildContent(
        {
          attachments: [1, 2, 3, 4, 5].map((id) => ({
            type: 'image',
            payload: { url: `https://i.max.ru/${id}` },
          })),
        },
        'publik_bot',
      ),
    ).resolves.toMatchObject({
      warnings: expect.arrayContaining([
        expect.objectContaining({ kind: 'image', reason: 'too_large' }),
      ]),
    });
  });

  it('stops new album work, aborts siblings and settles them before reporting a size failure', async () => {
    const { service } = createFixture();
    const internal = service as unknown as {
      buildContent: (message: Record<string, unknown>, botId: string) => Promise<unknown>;
      downloadMedia: (
        url: string,
        maxBytes: number,
        type: 'image' | 'video',
        signal?: AbortSignal,
      ) => Promise<{ bytes: Buffer; mimeType: string }>;
    };
    const started: number[] = [];
    const settled: number[] = [];
    const bytes = Buffer.alloc(6_000_000);
    internal.downloadMedia = jest.fn(async (url, _limit, _type, signal) => {
      const index = Number(url.split('/').at(-1));
      started.push(index);
      if (index <= 4) return { bytes, mimeType: 'image/jpeg' };
      if (index === 5) return { bytes: Buffer.from([1]), mimeType: 'image/jpeg' };
      return new Promise<{ bytes: Buffer; mimeType: string }>((_resolve, reject) => {
        signal!.addEventListener(
          'abort',
          () => {
            settled.push(index);
            reject(signal!.reason);
          },
          { once: true },
        );
      });
    });
    await expect(
      internal.buildContent(
        {
          attachments: [1, 2, 3, 4, 5, 6, 7, 8].map((index) => ({
            type: 'image',
            payload: { url: `https://i.oneme.ru/${index}` },
          })),
        },
        'publik_bot',
      ),
    ).resolves.toMatchObject({
      warnings: expect.arrayContaining([
        expect.objectContaining({ kind: 'image', reason: 'too_large' }),
      ]),
    });
    expect(started).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(settled).toEqual([6, 7]);
  });

  it('keeps owned binary results without creating base64 representations', async () => {
    const { service } = createFixture();
    const internal = service as unknown as {
      buildContent: (
        message: Record<string, unknown>,
        botId: string,
      ) => Promise<{ media: Array<{ bytes: Buffer }> }>;
      downloadMedia: () => Promise<{ bytes: Buffer; mimeType: string }>;
    };
    const bytes = Buffer.from('owned image');
    internal.downloadMedia = jest.fn().mockResolvedValue({ bytes, mimeType: 'image/jpeg' });
    const content = await internal.buildContent(
      { attachments: [{ type: 'image', payload: { url: 'https://i.oneme.ru/image' } }] },
      'publik_bot',
    );
    expect(content.media[0]!.bytes).toBe(bytes);
    expect(content.media[0]).not.toHaveProperty('base64');
  });

  it('applies the album budget after normalization while retaining the per-image source limit', async () => {
    const { service } = createFixture();
    const internal = service as unknown as {
      buildContent: (
        message: Record<string, unknown>,
        botId: string,
      ) => Promise<{ media: unknown[] }>;
      downloadMedia: () => Promise<{ bytes: Buffer; mimeType: string }>;
      prepareImportedImage: () => Promise<{ bytes: Buffer; mimeType: string; extension: string }>;
    };
    internal.downloadMedia = jest
      .fn()
      .mockResolvedValue({ bytes: Buffer.alloc(8_000_000), mimeType: 'image/webp' });
    internal.prepareImportedImage = jest.fn().mockResolvedValue({
      bytes: Buffer.alloc(1_000_000),
      mimeType: 'image/jpeg',
      extension: 'jpg',
    });
    const content = await internal.buildContent(
      {
        attachments: [1, 2, 3, 4].map((index) => ({
          type: 'image',
          payload: { url: `https://i.oneme.ru/${index}` },
        })),
      },
      'publik_bot',
    );
    expect(content.media).toHaveLength(1);
    expect(content).toMatchObject({
      warnings: expect.arrayContaining([expect.objectContaining({ reason: 'duplicate' })]),
    });
    expect(internal.downloadMedia).toHaveBeenCalledTimes(4);
  });

  it('resolves token-only forwarded video through the Publisher bot', async () => {
    const { service, maxClient } = createFixture();
    maxClient.getVideoDownloadUrl.mockResolvedValue('https://video.max.ru/download.mp4');
    const internal = service as unknown as {
      buildContent: (
        message: Record<string, unknown>,
        botId: string,
      ) => Promise<{ media: Array<{ type: string }> }>;
      downloadMedia: () => Promise<{ bytes: Buffer; mimeType: string }>;
    };
    internal.downloadMedia = jest.fn(async () => ({
      bytes: Buffer.from('video'),
      mimeType: 'video/mp4',
    }));

    const content = await internal.buildContent(
      { attachments: [{ type: 'video', payload: { token: 'video-token-1' } }] },
      'publik_bot',
    );

    expect(maxClient.getVideoDownloadUrl).toHaveBeenCalledWith(
      'video-token-1',
      expect.objectContaining({ botId: 'publik_bot' }),
    );
    expect(content.media).toEqual([expect.objectContaining({ type: 'video' })]);
  });

  it('rejects unsafe media origins, credentials, ports and redirects', async () => {
    const { service } = createFixture();
    const internal = service as unknown as {
      parseAllowedMediaUrl: (url: string) => URL;
      downloadMedia: (url: string, maxBytes: number, type: 'image' | 'video') => Promise<unknown>;
    };
    for (const url of [
      'http://i.oneme.ru/photo.jpg',
      'https://user:secret@i.oneme.ru/photo.jpg',
      'https://i.oneme.ru:8443/photo.jpg',
      'https://example.com/photo.jpg',
    ]) {
      expect(() => internal.parseAllowedMediaUrl(url)).toThrow('Unsafe MAX media URL');
    }

    const originalFetch = global.fetch;
    global.fetch = jest.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: 'https://example.com/private' },
      }),
    ) as typeof fetch;
    try {
      await expect(
        internal.downloadMedia('https://i.oneme.ru/photo.jpg', 1024, 'image'),
      ).rejects.toThrow('Unsafe MAX media URL');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('retries transient media transport while keeping 404 terminal', async () => {
    const { service } = createFixture();
    const internal = service as unknown as {
      downloadMedia: (
        url: string,
        maxBytes: number,
        type: 'image' | 'video',
      ) => Promise<{ bytes: Buffer }>;
    };
    const originalFetch = global.fetch;
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(Buffer.from('image'), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        }),
      ) as typeof fetch;
    try {
      await expect(
        internal.downloadMedia('https://i.oneme.ru/photo.jpg', 1024, 'image'),
      ).rejects.toMatchObject({ name: 'PublisherPostImportTransientError' });
      await expect(
        internal.downloadMedia('https://i.oneme.ru/photo.jpg', 1024, 'image'),
      ).resolves.toMatchObject({ bytes: Buffer.from('image') });

      global.fetch = jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('request aborted'), { name: 'AbortError' }),
        ) as typeof fetch;
      await expect(
        internal.downloadMedia('https://i.oneme.ru/photo.jpg', 1024, 'image'),
      ).rejects.toMatchObject({ name: 'PublisherPostImportTransientError' });

      global.fetch = jest
        .fn()
        .mockResolvedValue(new Response(null, { status: 404 })) as typeof fetch;
      await expect(
        internal.downloadMedia('https://i.oneme.ru/photo.jpg', 1024, 'image'),
      ).rejects.toMatchObject({ code: 'media_download_failed' });
    } finally {
      global.fetch = originalFetch;
    }
  });
});
