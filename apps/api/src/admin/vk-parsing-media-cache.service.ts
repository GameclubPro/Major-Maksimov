import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { fetchPublicHttpsMedia, PublicHttpsMediaError } from '../common/public-https-media';
import { isPrismaUniqueConflict, formatVkParsingError } from './vk-parsing-errors';

export type VkParsingMediaCacheRow = Prisma.VkParsingMediaCacheGetPayload<Record<string, never>>;

export type VkParsingMediaCacheWriteData = {
  status: string;
  mimeType?: string | null;
  contentLength?: number | null;
  lastError?: string | null;
  maxUploadPayload?: Record<string, unknown> | null;
  maxUploadToken?: string | null;
  maxUploadedAt?: Date | null;
};

export const VK_MEDIA_STATUS_READY = 'READY';
export const VK_MEDIA_STATUS_FAILED = 'FAILED';
export const VK_MEDIA_STATUS_UNKNOWN = 'UNKNOWN';
export const VK_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const VK_IMAGE_FETCH_TIMEOUT_MS = 15_000;
export const VK_MEDIA_CACHE_UPLOAD_BOT_ID_FIELD = '__maximUploadBotId';

const VK_MEDIA_CACHE_WRITE_MAX_ATTEMPTS = 3;

@Injectable()
export class VkParsingMediaCacheService {
  private readonly mediaPreflightTtlMs: number;
  private readonly mediaFailedPreflightTtlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.mediaPreflightTtlMs =
      configService.get<number>('VK_PARSING_MEDIA_PREFLIGHT_TTL_MS') ?? 86_400_000;
    this.mediaFailedPreflightTtlMs = Math.min(
      this.mediaPreflightTtlMs,
      configService.get<number>('VK_PARSING_MEDIA_FAILED_PREFLIGHT_TTL_MS') ?? 120_000,
    );
  }

  async preflightMediaUrl(
    imageUrl: string,
    mediaIdentity: string | null = null,
    uploadBotId: string | null = null,
  ): Promise<VkParsingMediaCacheRow> {
    const cached = await this.findMediaCache(imageUrl, mediaIdentity);
    if (cached?.lastCheckedAt) {
      const ageMs = Date.now() - cached.lastCheckedAt.getTime();
      const cacheTtlMs =
        cached.status === VK_MEDIA_STATUS_FAILED
          ? this.mediaFailedPreflightTtlMs
          : this.mediaPreflightTtlMs;
      if (
        ageMs >= 0 &&
        ageMs < cacheTtlMs &&
        cached.status !== VK_MEDIA_STATUS_UNKNOWN &&
        this.canReusePreflightCacheForUrl(cached, imageUrl, uploadBotId)
      ) {
        return cached;
      }
    }

    let parsed: URL;
    try {
      parsed = new URL(imageUrl);
      if (parsed.protocol !== 'https:') {
        return this.writeMediaCache(
          imageUrl,
          {
            status: VK_MEDIA_STATUS_FAILED,
            lastError: 'Фото VK должно быть доступно по HTTPS.',
          },
          mediaIdentity,
        );
      }
    } catch {
      return this.writeMediaCache(
        imageUrl,
        {
          status: VK_MEDIA_STATUS_FAILED,
          lastError: 'Некорректная ссылка на фото VK.',
        },
        mediaIdentity,
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), VK_IMAGE_FETCH_TIMEOUT_MS);
    try {
      const response = await this.fetchMediaPreflightResponse(parsed, controller.signal);
      if (!response.ok) {
        return this.writeMediaCache(
          imageUrl,
          {
            status: VK_MEDIA_STATUS_FAILED,
            lastError: `VK вернул статус ${response.status} для фото.`,
          },
          mediaIdentity,
        );
      }

      const headers = response.headers ?? new Headers();
      const contentLength = this.readMediaContentLength(headers, response.status);
      if ((contentLength ?? 0) > VK_IMAGE_MAX_BYTES) {
        return this.writeMediaCache(
          imageUrl,
          {
            status: VK_MEDIA_STATUS_FAILED,
            contentLength,
            lastError: 'Фото из VK слишком большое.',
          },
          mediaIdentity,
        );
      }

      const mimeType = (headers.get('content-type') ?? '').split(';')[0]!.trim();
      if (mimeType && !mimeType.toLowerCase().startsWith('image/')) {
        return this.writeMediaCache(
          imageUrl,
          {
            status: VK_MEDIA_STATUS_FAILED,
            mimeType,
            contentLength: contentLength || null,
            lastError: 'VK вернул не изображение.',
          },
          mediaIdentity,
        );
      }

      return this.writeMediaCache(
        imageUrl,
        {
          status: VK_MEDIA_STATUS_READY,
          mimeType: mimeType || null,
          contentLength,
          lastError: null,
        },
        mediaIdentity,
      );
    } catch (error) {
      return this.writeMediaCache(
        imageUrl,
        {
          status: VK_MEDIA_STATUS_FAILED,
          lastError:
            error instanceof Error && error.name === 'AbortError'
              ? 'VK не ответил на проверку фото вовремя.'
              : error instanceof PublicHttpsMediaError
                ? 'Не удалось скачать фото из VK.'
                : formatVkParsingError(error),
        },
        mediaIdentity,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async findMediaCache(
    url: string,
    mediaIdentity: string | null,
  ): Promise<VkParsingMediaCacheRow | null> {
    if (mediaIdentity) {
      const rows = await this.prisma.vkParsingMediaCache.findMany({
        where: { OR: [{ mediaIdentity }, { url }] },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const cached = this.pickCanonicalCacheRow(rows, url, mediaIdentity);
      if (cached) {
        return cached;
      }
    }

    return this.prisma.vkParsingMediaCache.findUnique({ where: { url } });
  }

  private canReusePreflightCacheForUrl(
    row: VkParsingMediaCacheRow,
    url: string,
    uploadBotId: string | null,
  ): boolean {
    if (row.url === url) {
      return true;
    }

    return this.hasReusableUpload(row, uploadBotId);
  }

  private hasReusableUpload(row: VkParsingMediaCacheRow, uploadBotId: string | null): boolean {
    const payload =
      typeof row.maxUploadPayload === 'object' && row.maxUploadPayload !== null
        ? (row.maxUploadPayload as Record<string, unknown>)
        : null;
    const cachedBotId = this.readUploadBotId(payload);
    return Boolean(
      uploadBotId &&
      cachedBotId === uploadBotId.trim() &&
      ((payload && Object.keys(payload).length > 1) ||
        (typeof row.maxUploadToken === 'string' && row.maxUploadToken.trim())),
    );
  }

  async writeMediaCache(
    url: string,
    data: VkParsingMediaCacheWriteData,
    mediaIdentity: string | null = null,
  ): Promise<VkParsingMediaCacheRow> {
    for (let attempt = 1; attempt <= VK_MEDIA_CACHE_WRITE_MAX_ATTEMPTS; attempt += 1) {
      try {
        return mediaIdentity
          ? await this.writeMediaCacheWithIdentityLock(url, data, mediaIdentity)
          : await this.writeMediaCacheByUrl(url, data);
      } catch (error) {
        if (!isPrismaUniqueConflict(error) || attempt >= VK_MEDIA_CACHE_WRITE_MAX_ATTEMPTS) {
          throw error;
        }
        await this.sleep(25 * attempt);
      }
    }

    return this.writeMediaCacheByUrl(url, data);
  }

  private async fetchMediaPreflightResponse(url: URL, signal: AbortSignal): Promise<Response> {
    const headResponse = await fetchPublicHttpsMedia(url, { method: 'HEAD', signal });
    if (headResponse.ok || !this.shouldFallbackMediaPreflight(headResponse.status)) {
      return headResponse;
    }

    await headResponse.body?.cancel().catch(() => undefined);
    const rangeResponse = await fetchPublicHttpsMedia(url, {
      method: 'GET',
      range: 'bytes=0-0',
      signal,
    });
    await rangeResponse.body?.cancel().catch(() => undefined);
    return rangeResponse;
  }

  private shouldFallbackMediaPreflight(status: number): boolean {
    return status === 403 || status === 405 || status === 501;
  }

  private readMediaContentLength(headers: Headers, status: number): number | null {
    const contentRangeTotal = this.readContentRangeTotal(headers.get('content-range'));
    if (contentRangeTotal !== null) {
      return contentRangeTotal;
    }

    if (status === 206) {
      return null;
    }

    const contentLength = Number(headers.get('content-length') ?? 0);
    return Number.isFinite(contentLength) && contentLength > 0 ? contentLength : null;
  }

  private readContentRangeTotal(value: string | null): number | null {
    const match = value?.match(/\/(\d+)$/u);
    if (!match) {
      return null;
    }

    const total = Number(match[1]);
    return Number.isFinite(total) && total >= 0 ? total : null;
  }

  private buildMediaCacheMutation(
    url: string,
    data: VkParsingMediaCacheWriteData,
    mediaIdentity: string | null,
  ): {
    createData: Prisma.VkParsingMediaCacheCreateInput;
    updateData: Prisma.VkParsingMediaCacheUpdateInput;
  } {
    const lastCheckedAt = new Date();
    const updateData: Prisma.VkParsingMediaCacheUpdateInput = {
      status: data.status,
      mimeType: data.mimeType ?? null,
      contentLength: data.contentLength ?? null,
      lastCheckedAt,
      lastError: data.lastError ?? null,
      ...(mediaIdentity ? { mediaIdentity } : {}),
      ...(data.maxUploadPayload
        ? { maxUploadPayload: this.toJsonInput(data.maxUploadPayload) }
        : {}),
      ...(typeof data.maxUploadToken === 'string' ? { maxUploadToken: data.maxUploadToken } : {}),
      ...(data.maxUploadedAt ? { maxUploadedAt: data.maxUploadedAt } : {}),
      ...(data.maxUploadPayload ? { uploadAttemptCount: { increment: 1 } } : {}),
    };
    const createData: Prisma.VkParsingMediaCacheCreateInput = {
      url,
      mediaIdentity,
      status: data.status,
      mimeType: data.mimeType ?? null,
      contentLength: data.contentLength ?? null,
      lastCheckedAt,
      lastError: data.lastError ?? null,
      ...(data.maxUploadPayload
        ? { maxUploadPayload: this.toJsonInput(data.maxUploadPayload) }
        : {}),
      ...(typeof data.maxUploadToken === 'string' ? { maxUploadToken: data.maxUploadToken } : {}),
      ...(data.maxUploadedAt ? { maxUploadedAt: data.maxUploadedAt } : {}),
      uploadAttemptCount: data.maxUploadPayload ? 1 : 0,
    };

    return { createData, updateData };
  }

  private async writeMediaCacheByUrl(
    url: string,
    data: VkParsingMediaCacheWriteData,
  ): Promise<VkParsingMediaCacheRow> {
    return this.prisma.$transaction(
      async (tx) => {
        await this.lockMediaCacheKeys(tx, [`url:${url}`]);
        const { createData, updateData } = this.buildMediaCacheMutation(url, data, null);

        return tx.vkParsingMediaCache.upsert({
          where: { url },
          create: createData,
          update: updateData,
        });
      },
      { timeout: 5_000, maxWait: 5_000 },
    );
  }

  private async writeMediaCacheWithIdentityLock(
    url: string,
    data: VkParsingMediaCacheWriteData,
    mediaIdentity: string,
  ): Promise<VkParsingMediaCacheRow> {
    return this.prisma.$transaction(
      async (tx) => {
        await this.lockMediaCacheKeys(tx, [`identity:${mediaIdentity}`, `url:${url}`]);
        const { createData, updateData } = this.buildMediaCacheMutation(url, data, mediaIdentity);
        const existingRows = await tx.vkParsingMediaCache.findMany({
          where: { OR: [{ mediaIdentity }, { url }] },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        const canonical = this.pickCanonicalCacheRow(existingRows, url, mediaIdentity);

        if (!canonical) {
          return tx.vkParsingMediaCache.create({ data: createData });
        }

        const duplicateIds = existingRows
          .filter((row) => row.id !== canonical.id)
          .map((row) => row.id);
        if (duplicateIds.length > 0) {
          await tx.vkParsingMediaCache.deleteMany({ where: { id: { in: duplicateIds } } });
        }

        return tx.vkParsingMediaCache.update({
          where: { id: canonical.id },
          data: {
            url,
            mediaIdentity,
            ...updateData,
          },
        });
      },
      { timeout: 5_000, maxWait: 5_000 },
    );
  }

  private pickCanonicalCacheRow(
    rows: VkParsingMediaCacheRow[],
    url: string,
    mediaIdentity: string,
  ): VkParsingMediaCacheRow | null {
    let canonical = rows[0] ?? null;
    let canonicalScore = canonical ? this.scoreMediaCacheRow(canonical, url, mediaIdentity) : -1;

    for (const row of rows.slice(1)) {
      const score = this.scoreMediaCacheRow(row, url, mediaIdentity);
      if (score > canonicalScore) {
        canonical = row;
        canonicalScore = score;
      }
    }

    return canonical;
  }

  private scoreMediaCacheRow(
    row: VkParsingMediaCacheRow,
    url: string,
    mediaIdentity: string,
  ): number {
    const payload =
      typeof row.maxUploadPayload === 'object' && row.maxUploadPayload !== null
        ? (row.maxUploadPayload as Record<string, unknown>)
        : null;
    const hasCachedUploadData = Boolean(
      (payload && Object.keys(payload).length > 0) ||
      (typeof row.maxUploadToken === 'string' && row.maxUploadToken.trim()),
    );
    return (
      (hasCachedUploadData ? 8 : 0) +
      (row.mediaIdentity === mediaIdentity ? 4 : 0) +
      (row.url === url ? 2 : 0) +
      (row.status === VK_MEDIA_STATUS_READY ? 1 : 0)
    );
  }

  private readUploadBotId(payload: Record<string, unknown> | null): string {
    const value = payload?.[VK_MEDIA_CACHE_UPLOAD_BOT_ID_FIELD];
    return typeof value === 'string' ? value.trim() : '';
  }

  private async lockMediaCacheKeys(
    tx: Prisma.TransactionClient,
    keys: readonly string[],
  ): Promise<void> {
    const lockKeys = [...new Set(keys)].sort();
    for (const key of lockKeys) {
      await tx.$executeRaw(Prisma.sql`
        SELECT pg_advisory_xact_lock(hashtext(${`vk-parsing-media:${key}`}))
      `);
    }
  }

  private toJsonInput(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
