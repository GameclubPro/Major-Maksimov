import { ConfigService } from '@nestjs/config';
import * as publicHttpsMedia from '../common/public-https-media';
import { PrismaService } from '../prisma/prisma.service';
import {
  VK_IMAGE_MAX_BYTES,
  VK_MEDIA_CACHE_UPLOAD_BOT_ID_FIELD,
  VK_MEDIA_STATUS_FAILED,
  VK_MEDIA_STATUS_READY,
  VkParsingMediaCacheService,
  type VkParsingMediaCacheRow,
} from './vk-parsing-media-cache.service';

jest.mock('../prisma/prisma.service');

const IMAGE_URL = 'https://vk.example/photo.jpg';
const MEDIA_IDENTITY = 'photo-123_456';
const NOW = new Date('2026-11-03T12:00:00.000Z');

function cacheRow(overrides: Partial<VkParsingMediaCacheRow> = {}): VkParsingMediaCacheRow {
  return {
    id: 'media-cache-1',
    url: IMAGE_URL,
    mediaIdentity: MEDIA_IDENTITY,
    status: VK_MEDIA_STATUS_READY,
    mimeType: 'image/jpeg',
    contentLength: 128,
    maxUploadPayload: null,
    maxUploadToken: null,
    maxUploadedAt: null,
    uploadAttemptCount: 0,
    lastCheckedAt: new Date(NOW),
    lastError: null,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
    ...overrides,
  };
}

function createHarness(config: Record<string, number> = {}) {
  const service = new VkParsingMediaCacheService(new PrismaService(), new ConfigService(config));
  let cached: VkParsingMediaCacheRow | null = null;
  const find = jest.spyOn(service, 'findMediaCache').mockImplementation(async () => cached);
  const write = jest
    .spyOn(service, 'writeMediaCache')
    .mockImplementation(async (url, data, mediaIdentity = null) => {
      cached = cacheRow({
        url,
        mediaIdentity,
        status: data.status,
        mimeType: data.mimeType ?? null,
        contentLength: data.contentLength ?? null,
        maxUploadToken: data.maxUploadToken ?? null,
        maxUploadedAt: data.maxUploadedAt ?? null,
        lastCheckedAt: new Date(),
        lastError: data.lastError ?? null,
      });
      return cached;
    });

  return {
    service,
    find,
    write,
    seed(row: VkParsingMediaCacheRow) {
      cached = row;
    },
  };
}

describe('VK media preflight cache', () => {
  let mediaFetch: jest.SpyInstance<
    ReturnType<typeof publicHttpsMedia.fetchPublicHttpsMedia>,
    Parameters<typeof publicHttpsMedia.fetchPublicHttpsMedia>
  >;

  beforeEach(() => {
    jest.useFakeTimers({ now: NOW });
    mediaFetch = jest
      .spyOn(publicHttpsMedia, 'fetchPublicHttpsMedia')
      .mockRejectedValue(new Error('Unexpected public media request'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('caches a typed destination rejection and reuses the fresh failure', async () => {
    const { service, find, write } = createHarness();
    mediaFetch.mockRejectedValue(new publicHttpsMedia.PublicHttpsMediaError('destination_denied'));

    const rejected = await service.preflightMediaUrl(IMAGE_URL, MEDIA_IDENTITY);
    const cached = await service.preflightMediaUrl(IMAGE_URL, MEDIA_IDENTITY);

    expect(rejected).toMatchObject({
      url: IMAGE_URL,
      mediaIdentity: MEDIA_IDENTITY,
      status: VK_MEDIA_STATUS_FAILED,
      lastError: 'Не удалось скачать фото из VK.',
    });
    expect(cached).toBe(rejected);
    expect(find).toHaveBeenNthCalledWith(1, IMAGE_URL, MEDIA_IDENTITY);
    expect(find).toHaveBeenNthCalledWith(2, IMAGE_URL, MEDIA_IDENTITY);
    expect(write).toHaveBeenCalledTimes(1);
    expect(mediaFetch).toHaveBeenCalledTimes(1);
    expect(mediaFetch).toHaveBeenCalledWith(new URL(IMAGE_URL), {
      method: 'HEAD',
      signal: expect.any(AbortSignal),
    });
  });

  it('cancels rejected HEAD and Range bodies and shares one signal for HTTP fallback', async () => {
    const { service } = createHarness();
    const headCancel = jest.fn<void, []>();
    const rangeCancel = jest.fn<void, []>();
    const head = new Response(new ReadableStream<Uint8Array>({ cancel: headCancel }), {
      status: 405,
    });
    const range = new Response(new ReadableStream<Uint8Array>({ cancel: rangeCancel }), {
      status: 206,
      headers: new Headers({
        'content-type': 'image/jpeg; charset=binary',
        'content-length': '1',
        'content-range': 'bytes 0-0/4096',
      }),
    });
    mediaFetch.mockResolvedValueOnce(head).mockImplementationOnce(async () => {
      expect(headCancel).toHaveBeenCalledTimes(1);
      return range;
    });

    const result = await service.preflightMediaUrl(IMAGE_URL, MEDIA_IDENTITY);

    expect(result).toMatchObject({
      status: VK_MEDIA_STATUS_READY,
      mimeType: 'image/jpeg',
      contentLength: 4096,
      lastError: null,
    });
    expect(mediaFetch).toHaveBeenCalledTimes(2);
    const signal = mediaFetch.mock.calls[0]![1].signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    expect(mediaFetch).toHaveBeenNthCalledWith(2, new URL(IMAGE_URL), {
      method: 'GET',
      range: 'bytes=0-0',
      signal,
    });
    expect(headCancel).toHaveBeenCalledTimes(1);
    expect(rangeCancel).toHaveBeenCalledTimes(1);
    expect(head.body!.locked).toBe(false);
    expect(range.body!.locked).toBe(false);
  });

  it('rejects an oversized Content-Range total despite a one-byte Content-Length', async () => {
    const { service } = createHarness();
    mediaFetch.mockResolvedValueOnce(new Response(null, { status: 405 })).mockResolvedValueOnce(
      new Response(null, {
        status: 206,
        headers: new Headers({
          'content-type': 'image/jpeg',
          'content-length': '1',
          'content-range': `bytes 0-0/${VK_IMAGE_MAX_BYTES + 1}`,
        }),
      }),
    );

    await expect(service.preflightMediaUrl(IMAGE_URL)).resolves.toMatchObject({
      status: VK_MEDIA_STATUS_FAILED,
      contentLength: VK_IMAGE_MAX_BYTES + 1,
      lastError: 'Фото из VK слишком большое.',
    });
  });

  it.each([null, 'bytes 0-0/*', 'invalid'])(
    'keeps incomplete Range metadata unknown for Content-Range %s',
    async (contentRange) => {
      const { service } = createHarness();
      const headers = new Headers({ 'content-type': 'image/jpeg', 'content-length': '1' });
      if (contentRange !== null) {
        headers.set('content-range', contentRange);
      }
      mediaFetch
        .mockResolvedValueOnce(new Response(null, { status: 405 }))
        .mockResolvedValueOnce(new Response(null, { status: 206, headers }));

      await expect(service.preflightMediaUrl(IMAGE_URL)).resolves.toMatchObject({
        status: VK_MEDIA_STATUS_READY,
        contentLength: null,
      });
    },
  );

  it('keeps size unknown after the transport removes encoded size headers', async () => {
    const { service } = createHarness();
    mediaFetch.mockResolvedValue(
      new Response(null, {
        headers: new Headers({ 'content-type': 'image/jpeg', 'content-encoding': 'gzip' }),
      }),
    );

    await expect(service.preflightMediaUrl(IMAGE_URL)).resolves.toMatchObject({
      status: VK_MEDIA_STATUS_READY,
      contentLength: null,
    });
    expect(mediaFetch).toHaveBeenCalledTimes(1);
  });

  it('preserves the existing timeout message for an aborted preflight', async () => {
    const { service } = createHarness();
    mediaFetch.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));

    await expect(service.preflightMediaUrl(IMAGE_URL)).resolves.toMatchObject({
      status: VK_MEDIA_STATUS_FAILED,
      lastError: 'VK не ответил на проверку фото вовремя.',
    });
    expect(mediaFetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { normalTtl: 60_000, failedTtl: 5_000, expiresAfter: 5_000 },
    { normalTtl: 1_500, failedTtl: 5_000, expiresAfter: 1_500 },
  ])('rechecks failed media at its effective TTL: %j', async (settings) => {
    const { service } = createHarness({
      VK_PARSING_MEDIA_PREFLIGHT_TTL_MS: settings.normalTtl,
      VK_PARSING_MEDIA_FAILED_PREFLIGHT_TTL_MS: settings.failedTtl,
    });
    mediaFetch
      .mockRejectedValueOnce(new publicHttpsMedia.PublicHttpsMediaError('destination_denied'))
      .mockResolvedValueOnce(new Response(null, { headers: { 'content-type': 'image/jpeg' } }));

    const failed = await service.preflightMediaUrl(IMAGE_URL);
    jest.setSystemTime(NOW.getTime() + settings.expiresAfter - 1);
    await expect(service.preflightMediaUrl(IMAGE_URL)).resolves.toBe(failed);
    expect(mediaFetch).toHaveBeenCalledTimes(1);

    jest.setSystemTime(NOW.getTime() + settings.expiresAfter);
    await expect(service.preflightMediaUrl(IMAGE_URL)).resolves.toMatchObject({
      status: VK_MEDIA_STATUS_READY,
      lastError: null,
    });
    expect(mediaFetch).toHaveBeenCalledTimes(2);
  });

  it('reuses an identity across signed URLs only with the cached exact-bot upload', async () => {
    const { service, seed, find, write } = createHarness();
    const cached = cacheRow({
      url: 'https://vk.example/old-signed-photo.jpg',
      maxUploadPayload: {
        [VK_MEDIA_CACHE_UPLOAD_BOT_ID_FIELD]: 'publisher-a',
        token: 'upload-token',
      },
      maxUploadToken: 'upload-token',
      maxUploadedAt: new Date(NOW),
    });
    seed(cached);

    await expect(service.preflightMediaUrl(IMAGE_URL, MEDIA_IDENTITY, 'publisher-a')).resolves.toBe(
      cached,
    );
    expect(find).toHaveBeenCalledWith(IMAGE_URL, MEDIA_IDENTITY);
    expect(mediaFetch).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('checks a new signed URL when the identity upload belongs to another bot', async () => {
    const { service, seed, write } = createHarness();
    seed(
      cacheRow({
        url: 'https://vk.example/old-signed-photo.jpg',
        maxUploadPayload: {
          [VK_MEDIA_CACHE_UPLOAD_BOT_ID_FIELD]: 'publisher-a',
          token: 'upload-token',
        },
        maxUploadToken: 'upload-token',
        maxUploadedAt: new Date(NOW),
      }),
    );
    mediaFetch.mockResolvedValue(new Response(null, { headers: { 'content-type': 'image/jpeg' } }));

    await expect(
      service.preflightMediaUrl(IMAGE_URL, MEDIA_IDENTITY, 'publisher-b'),
    ).resolves.toMatchObject({
      url: IMAGE_URL,
      mediaIdentity: MEDIA_IDENTITY,
      status: VK_MEDIA_STATUS_READY,
    });
    expect(mediaFetch).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(
      IMAGE_URL,
      expect.objectContaining({ status: VK_MEDIA_STATUS_READY }),
      MEDIA_IDENTITY,
    );
  });
});
