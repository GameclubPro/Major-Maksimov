import { sendBroadcastRequestSchema } from '@maxim/contracts';
import { validateMaxMediaUploadPayload } from '../max/max-media-upload-validation';
import { AdminManagedBroadcastRuntime } from './admin-managed-broadcast-runtime';
import {
  PUBLICATION_VIDEO_ASSET_ID_FIELD,
  PUBLICATION_VIDEO_SOURCE_PUBLICATION_ID_FIELD,
  PUBLICATION_VIDEO_INLINE_BASE64_FIELD,
} from './publication-video-media';

const user = { userId: 'user-1', username: null, displayName: null };
const TINY_JPEG_BASE64 =
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJXAIf/Z';

function createRuntime() {
  const runtime = new AdminManagedBroadcastRuntime({
    maxClient: { validateMediaUploadPayload: validateMaxMediaUploadPayload },
  } as never);
  const assertAdminAccess = jest
    .spyOn(runtime as any, 'assertManagedEntityAdminAccess')
    .mockResolvedValue(undefined);
  return { runtime, assertAdminAccess };
}

function createPayload(overrides: Record<string, unknown> = {}) {
  return {
    requestId: 'publication-test-1',
    text: 'Тест',
    textFormat: 'plain',
    targetMode: 'current',
    targetChatIds: [],
    applyToAllChats: false,
    buttons: [],
    imageEnabled: false,
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    images: [],
    mediaType: null,
    mediaPayload: null,
    mediaMimeType: '',
    mediaFileName: '',
    scheduleTimezone: 'Europe/Moscow',
    scheduledSlots: [],
    sendAt: null,
    cycleEnabled: false,
    cycleCount: 1,
    ...overrides,
  };
}

function createBase64(length: number, finalQuartet = 'AAAA'): string {
  if (length < 4 || length % 4 !== 0 || finalQuartet.length !== 4) {
    throw new Error('Test base64 length and suffix must align to quartets.');
  }
  return `${'A'.repeat(length - 4)}${finalQuartet}`;
}

async function preparePublicationTest(
  runtime: AdminManagedBroadcastRuntime,
  body: unknown,
  entityType: 'chat' | 'channel' = 'chat',
) {
  return (runtime as any).prepareManagedBroadcastRequest('chat-1', user, body, {
    entityType,
    trustedPublicationTestPayload: true,
  });
}

describe('AdminManagedBroadcastRuntime publication test request boundary', () => {
  it('accepts 4000 characters while preserving access, button normalization, and idempotency', async () => {
    const { runtime, assertAdminAccess } = createRuntime();
    const text = 'x'.repeat(4_000);
    const body = createPayload({
      text,
      buttons: [{ text: '  Открыть  ', url: '  https://example.com/publication  ' }],
    });

    const first = await preparePublicationTest(runtime, body);
    const replay = await preparePublicationTest(runtime, body);

    expect(first.payload.text).toBe(text);
    expect(first.payload.buttons).toEqual([
      { text: 'Открыть', url: 'https://example.com/publication' },
    ]);
    expect(first.payload).toEqual(
      expect.objectContaining({
        targetMode: 'current',
        targetChatIds: [],
        scheduleMode: 'legacy',
        images: [],
        mediaType: null,
      }),
    );
    expect(first.idempotencyKey).toBe('publication-test-1');
    expect(first.idempotencyHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(replay.idempotencyHash).toBe(first.idempotencyHash);
    expect(assertAdminAccess).toHaveBeenCalledTimes(2);
    expect(assertAdminAccess).toHaveBeenLastCalledWith('chat-1', 'user-1', 'chat');
  });

  it('canonicalizes managed broadcast image metadata from validated bytes', async () => {
    const { runtime } = createRuntime();
    const body = createPayload({
      text: '',
      imageEnabled: true,
      imageBase64: TINY_JPEG_BASE64,
      imageMimeType: 'image/png',
      imageFileName: '../cover\u0000.png',
      images: [
        {
          base64: TINY_JPEG_BASE64,
          mimeType: 'image/png',
          fileName: '../cover\u0000.png',
        },
      ],
    });

    const prepared = await preparePublicationTest(runtime, body);

    expect(prepared.payload).toEqual(
      expect.objectContaining({
        imageMimeType: 'image/jpeg',
        imageFileName: 'cover_.jpg',
        images: [expect.objectContaining({ mimeType: 'image/jpeg', fileName: 'cover_.jpg' })],
      }),
    );
  });

  it('accepts one publication image above the legacy 8,000,000-character limit', async () => {
    const { runtime } = createRuntime();
    jest
      .spyOn((runtime as any).mediaRuntime, 'validateManagedBroadcastMediaPayload')
      .mockResolvedValue(undefined);
    const base64 = createBase64(8_000_004);
    const body = createPayload({
      requestId: undefined,
      text: '',
      imageEnabled: true,
      imageBase64: base64,
      imageMimeType: 'image/png',
      imageFileName: 'large.png',
      images: [{ base64, mimeType: 'image/png', fileName: 'large.png' }],
    });

    expect(sendBroadcastRequestSchema.safeParse(body).success).toBe(false);
    const prepared = await preparePublicationTest(runtime, body);

    expect(prepared.payload.images).toHaveLength(1);
    expect(prepared.payload.images[0].base64.length).toBe(8_000_004);
    expect(prepared.payload.imageBase64.length).toBe(8_000_004);
    expect(prepared.payload.mediaType).toBeNull();
  });

  it('accepts a publication gallery above the legacy 24,000,000-character total limit', async () => {
    const { runtime } = createRuntime();
    jest
      .spyOn((runtime as any).mediaRuntime, 'validateManagedBroadcastMediaPayload')
      .mockResolvedValue(undefined);
    const images = ['AAAA', 'AAAB', 'AAAC'].map((suffix, index) => ({
      base64: createBase64(8_000_004, suffix),
      mimeType: 'image/jpeg',
      fileName: `gallery-${index + 1}.jpg`,
    }));
    const body = createPayload({
      requestId: undefined,
      text: '',
      imageEnabled: true,
      imageBase64: images[0].base64,
      imageMimeType: images[0].mimeType,
      imageFileName: images[0].fileName,
      images,
      mediaType: 'image',
      mediaPayload: { images },
    });

    expect(sendBroadcastRequestSchema.safeParse(body).success).toBe(false);
    const prepared = await preparePublicationTest(runtime, body);

    expect(prepared.payload.images).toHaveLength(3);
    expect(
      prepared.payload.images.reduce(
        (total: number, image: { base64: string }) => total + image.base64.length,
        0,
      ),
    ).toBe(24_000_012);
    expect(prepared.payload.mediaType).toBe('image');
    expect((prepared.payload.mediaPayload as { images: unknown[] }).images).toHaveLength(3);
  });

  it('rejects malformed image bytes before returning a request that can be persisted', async () => {
    const { runtime } = createRuntime();
    const base64 = Buffer.from('not-an-image').toString('base64');
    const body = createPayload({
      text: '',
      imageEnabled: true,
      imageBase64: base64,
      imageMimeType: 'image/png',
      imageFileName: 'broken.png',
      images: [{ base64, mimeType: 'image/png', fileName: 'broken.png' }],
    });

    await expect(preparePublicationTest(runtime, body)).rejects.toThrow(
      'Не удалось распознать файл. Выберите исправный файл поддерживаемого формата.',
    );
  });

  it.each([
    [
      'inline',
      { [PUBLICATION_VIDEO_INLINE_BASE64_FIELD]: Buffer.from('inline-video').toString('base64') },
    ],
    ['retained asset', { [PUBLICATION_VIDEO_ASSET_ID_FIELD]: 'asset-video-owned' }],
    [
      'shared asset',
      {
        [PUBLICATION_VIDEO_ASSET_ID_FIELD]: 'asset-video-shared',
        [PUBLICATION_VIDEO_SOURCE_PUBLICATION_ID_FIELD]: 'source-publication',
      },
    ],
  ])('accepts a trusted %s video marker', async (_label, mediaPayload) => {
    const { runtime } = createRuntime();
    const body = createPayload({
      text: '',
      mediaType: 'video',
      mediaPayload,
      mediaMimeType: 'video/mp4',
      mediaFileName: 'clip.mp4',
    });

    const prepared = await preparePublicationTest(runtime, body, 'channel');

    expect(prepared.payload).toEqual(
      expect.objectContaining({
        images: [],
        mediaType: 'video',
        mediaPayload,
        mediaMimeType: 'video/mp4',
        mediaFileName: 'clip.mp4',
      }),
    );
  });

  it('rejects a trusted video marker mixed with publication images', async () => {
    const { runtime } = createRuntime();
    const imageBase64 = Buffer.from('image').toString('base64');
    const body = createPayload({
      text: '',
      imageEnabled: true,
      imageBase64,
      imageMimeType: 'image/png',
      imageFileName: 'image.png',
      images: [{ base64: imageBase64, mimeType: 'image/png', fileName: 'image.png' }],
      mediaType: 'video',
      mediaPayload: { [PUBLICATION_VIDEO_ASSET_ID_FIELD]: 'asset-video-owned' },
      mediaMimeType: 'video/mp4',
      mediaFileName: 'clip.mp4',
    });

    await expect(preparePublicationTest(runtime, body)).rejects.toThrow();
  });

  it.each([
    { [PUBLICATION_VIDEO_SOURCE_PUBLICATION_ID_FIELD]: 'source-publication' },
    {
      [PUBLICATION_VIDEO_ASSET_ID_FIELD]: 'asset',
      [PUBLICATION_VIDEO_SOURCE_PUBLICATION_ID_FIELD]: '',
    },
    {
      [PUBLICATION_VIDEO_ASSET_ID_FIELD]: 'asset',
      [PUBLICATION_VIDEO_SOURCE_PUBLICATION_ID_FIELD]: 123,
    },
    {
      [PUBLICATION_VIDEO_ASSET_ID_FIELD]: 'asset',
      [PUBLICATION_VIDEO_SOURCE_PUBLICATION_ID_FIELD]: 'x'.repeat(257),
    },
    {
      [PUBLICATION_VIDEO_INLINE_BASE64_FIELD]: 'dmlkZW8=',
      [PUBLICATION_VIDEO_SOURCE_PUBLICATION_ID_FIELD]: 'source',
    },
    {
      [PUBLICATION_VIDEO_ASSET_ID_FIELD]: 'asset',
      [PUBLICATION_VIDEO_SOURCE_PUBLICATION_ID_FIELD]: 'source',
      token: 'forged-token',
    },
  ])('rejects malformed or mixed trusted video source markers: %j', async (mediaPayload) => {
    const { runtime, assertAdminAccess } = createRuntime();
    await expect(
      preparePublicationTest(
        runtime,
        createPayload({
          mediaType: 'video',
          mediaPayload,
        }),
      ),
    ).rejects.toThrow();
    expect(assertAdminAccess).toHaveBeenCalledWith('chat-1', 'user-1', 'chat');
  });

  it.each([
    ['inline', { [PUBLICATION_VIDEO_INLINE_BASE64_FIELD]: 'aW5saW5lLXZpZGVv' }],
    ['retained asset', { [PUBLICATION_VIDEO_ASSET_ID_FIELD]: 'asset-video-owned' }],
    [
      'shared asset',
      {
        [PUBLICATION_VIDEO_ASSET_ID_FIELD]: 'asset-video-shared',
        [PUBLICATION_VIDEO_SOURCE_PUBLICATION_ID_FIELD]: 'source-publication',
      },
    ],
  ])(
    'keeps the %s marker out of ordinary public broadcast requests',
    async (_label, mediaPayload) => {
      const { runtime } = createRuntime();
      const body = createPayload({
        text: '',
        mediaType: 'video',
        mediaPayload,
        mediaMimeType: 'video/mp4',
        mediaFileName: 'clip.mp4',
      });

      expect(sendBroadcastRequestSchema.safeParse(body).success).toBe(false);
      await expect(
        (runtime as any).prepareManagedBroadcastRequest('chat-1', user, body, {
          entityType: 'chat',
        }),
      ).rejects.toThrow();
    },
  );

  it('rejects a publication marker hidden beside a valid public video token', async () => {
    const { runtime } = createRuntime();
    const body = createPayload({
      requestId: undefined,
      text: '',
      mediaType: 'video',
      mediaPayload: {
        token: 'public-video-token',
        [PUBLICATION_VIDEO_ASSET_ID_FIELD]: 'asset-video-owned',
      },
      mediaMimeType: 'video/mp4',
      mediaFileName: 'clip.mp4',
    });
    const prepared = await (runtime as any).prepareManagedBroadcastRequest('chat-1', user, body, {
      entityType: 'chat',
    });

    await expect(
      (runtime as any).mediaRuntime.resolveManagedBroadcastMedia(
        prepared.payload,
        'chat',
        'chat-1',
        'user-1',
      ),
    ).rejects.toThrow('Внутренняя ссылка на видео недоступна.');
  });

  it.each([
    ['chat', 'sendPublicationBroadcastTest'],
    ['channel', 'sendPublicationChannelBroadcastTest'],
  ] as const)('uses the trusted test boundary for %s publications', async (entityType, method) => {
    const { runtime } = createRuntime();
    const sendManagedBroadcastTest = jest
      .spyOn(runtime as any, 'sendManagedBroadcastTest')
      .mockResolvedValue({ delivered: true, messageId: 'message-1', chatId: null, url: null });
    const body = createPayload();

    await runtime[method]('chat-1', user, body);

    expect(sendManagedBroadcastTest).toHaveBeenCalledWith('chat-1', user, body, entityType, {
      trustedPublicationTestPayload: true,
      trustedPublicationVideoMarkers: true,
    });
  });
});
