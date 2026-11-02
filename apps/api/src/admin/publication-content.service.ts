import {
  publicationPostPublishSchema,
  type PublicationContentInput,
  type PublicationMediaInput,
  type TestPublicationRequest,
} from '@maxim/contracts/publication';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { MaxClientService } from '../max/max-client.service';
import { MaxMediaUploadValidationError } from '../max/max-media-upload-validation';
import { Prisma, PublicationContentFormat } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { buildPublisherBotDescriptor } from '../publisher/publisher-bot-descriptor';
import {
  hasPublicationVideoInternalMarker,
  PUBLICATION_MAX_VIDEO_BYTES,
  PUBLICATION_VIDEO_ASSET_ID_FIELD,
  PUBLICATION_VIDEO_SOURCE_PUBLICATION_ID_FIELD,
  PUBLICATION_VIDEO_INLINE_BASE64_FIELD,
  PUBLICATION_UPLOADED_VIDEO_FIELD,
  readPublicationUploadedVideo,
} from './publication-video-media';
import {
  PUBLICATION_MAX_IMAGE_BYTES,
  PUBLICATION_MAX_TOTAL_IMAGE_BYTES,
  PUBLICATION_ASSET_METADATA_SELECT,
} from './publication-media-limits';
import {
  publicationAssetReferenceWhere,
  publicationAssetSourceWhere,
  publicationUploadedVideoWhere,
} from './publication-asset-access';
import { canonicalizeAdminMaxMediaFileName } from './admin-max-media-file-name';

const PUBLICATION_VIDEO_MIME_TYPE_FALLBACK = 'application/octet-stream';
const PUBLICATION_PREVIEW_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
]);

export function normalizePublicationContent(
  content: PublicationContentInput,
): PublicationContentInput {
  return {
    ...content,
    text: content.text,
    buttons: content.buttons.map((button) => ({
      text: button.text.trim(),
      url: button.url.trim(),
      row: button.row,
    })),
  };
}

type PersistedAssetInput = {
  sha256: string;
  mimeType: string;
  fileName: string;
  sizeBytes: number;
  bytes: Buffer | null;
  durablePayload: Prisma.InputJsonValue | null;
  expectedType: 'image' | 'video';
  existingAssetId?: string;
};

type PreparedAssetInput =
  | {
      kind: 'reference';
      assetId: string;
      expectedType: 'image' | 'video';
      sourcePublicationId?: string;
    }
  | ({ kind: 'prepared' } & Omit<PersistedAssetInput, 'existingAssetId'>);

export type PreparedPublicationContentRevision = {
  postPublish?: PublicationContentInput['postPublish'];
  text: string;
  textFormat: PublicationContentInput['textFormat'];
  buttons: PublicationContentInput['buttons'];
  assets: PreparedAssetInput[];
};

// FLAG: Internal bytes are accepted only from server-owned preparation, never public JSON.
export type PublicationBinaryMediaInput = {
  type: 'image' | 'video';
  bytes: Buffer;
  fileName: string;
  mimeType?: string;
};

export type PublicationBinaryContentInput = Omit<PublicationContentInput, 'media'> & {
  media: PublicationBinaryMediaInput[];
};

@Injectable()
export class PublicationContentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
  ) {}

  async getOwnedAsset(publicationId: string, assetId: string, actorUserId: string) {
    if (!publicationId || publicationId.length > 256 || !assetId || assetId.length > 256)
      throw new NotFoundException('Медиа недоступно.');
    const asset = await this.prisma.publicationAsset.findFirst({
      where: {
        id: assetId,
        ...publicationAssetSourceWhere(actorUserId, publicationId, 'read'),
      },
      select: { bytes: true, mimeType: true },
    });
    if (
      !asset?.bytes?.byteLength ||
      !PUBLICATION_PREVIEW_MIME_TYPES.has(asset.mimeType.toLowerCase()) ||
      asset.bytes.byteLength > PUBLICATION_MAX_TOTAL_IMAGE_BYTES
    )
      throw new NotFoundException('Медиа недоступно.');
    return {
      bytes: Buffer.from(asset.bytes.buffer, asset.bytes.byteOffset, asset.bytes.byteLength),
      mimeType: asset.mimeType.toLowerCase(),
    };
  }

  async prepareContentRevision(
    content: PublicationContentInput,
  ): Promise<PreparedPublicationContentRevision> {
    return {
      postPublish: publicationPostPublishSchema.parse(content.postPublish ?? {}),
      text: content.text,
      textFormat: content.textFormat,
      buttons: content.buttons,
      assets: await this.prepareAssetInputs(content.media),
    };
  }

  async prepareBinaryContentRevision(
    content: PublicationBinaryContentInput,
  ): Promise<PreparedPublicationContentRevision> {
    const postPublish = publicationPostPublishSchema.parse(content.postPublish ?? {});
    const assets: PreparedAssetInput[] = [];
    let totalImageBytes = 0;
    for (const item of content.media) {
      if (item.type === 'image') {
        totalImageBytes += item.bytes.length;
        if (totalImageBytes > PUBLICATION_MAX_TOTAL_IMAGE_BYTES) {
          throw new BadRequestException('Суммарный размер фото превышает 24 МБ.');
        }
      }
      assets.push(await this.prepareBinaryAssetInput(item));
    }
    return {
      postPublish,
      text: content.text,
      textFormat: content.textFormat,
      buttons: content.buttons,
      assets,
    };
  }

  async assertPublisherCompatibleContent(
    content: PreparedPublicationContentRevision,
    actorUserId: string,
    publicationId?: string,
  ): Promise<void> {
    for (const asset of content.assets) {
      if (asset.expectedType !== 'video') {
        continue;
      }
      if (asset.kind === 'prepared') {
        if (!asset.bytes) {
          throw new BadRequestException(
            'Сохранённое видео загружено другим ботом. Выберите видеофайл снова.',
          );
        }
        continue;
      }

      const persisted = await this.prisma.publicationAsset.findFirst({
        where: {
          AND: [
            publicationAssetReferenceWhere(actorUserId, asset, publicationId),
            {
              mimeType: { startsWith: 'video/' },
              OR: [{ bytes: { not: null } }, publicationUploadedVideoWhere(this.publisherBotId())],
            },
          ],
        },
        select: PUBLICATION_ASSET_METADATA_SELECT,
      });
      if (
        !persisted ||
        (this.hasUploadedVideoMarker(persisted.durablePayload) &&
          !readPublicationUploadedVideo(persisted.durablePayload, this.publisherBotId()))
      ) {
        throw new BadRequestException('Сохранённое видео недоступно. Выберите видеофайл снова.');
      }
    }
  }

  async persistPreparedContentRevision(
    tx: any,
    publicationId: string,
    revision: number,
    content: PreparedPublicationContentRevision,
    actorUserId: string,
  ): Promise<{ id: string }> {
    const assets = await this.resolvePersistedAssetInputs(
      tx,
      content.assets,
      actorUserId,
      publicationId,
    );
    const contentRevision = await tx.publicationContentRevision.create({
      data: {
        publicationId,
        revision,
        text: content.text,
        textFormat:
          content.textFormat === 'markdown'
            ? PublicationContentFormat.MARKDOWN
            : PublicationContentFormat.PLAIN,
        buttons: content.buttons as Prisma.InputJsonValue,
        postPublish: publicationPostPublishSchema.parse(content.postPublish ?? {}),
      },
      select: { id: true },
    });
    const linkedAssetIds = new Set<string>();
    for (const [position, assetInput] of assets.entries()) {
      const asset = assetInput.existingAssetId
        ? { id: assetInput.existingAssetId }
        : await tx.publicationAsset.upsert({
            where: {
              actorUserId_sha256: {
                actorUserId,
                sha256: assetInput.sha256,
              },
            },
            create: {
              actorUserId,
              sha256: assetInput.sha256,
              mimeType: assetInput.mimeType,
              fileName: assetInput.fileName,
              sizeBytes: assetInput.sizeBytes,
              bytes: assetInput.bytes,
              durablePayload: assetInput.durablePayload ?? Prisma.DbNull,
            },
            update: {},
            select: { id: true },
          });
      if (linkedAssetIds.has(asset.id)) {
        throw new BadRequestException('Один и тот же медиафайл добавлен несколько раз.');
      }
      linkedAssetIds.add(asset.id);
      await tx.publicationContentAsset.create({
        data: {
          contentRevisionId: contentRevision.id,
          assetId: asset.id,
          position,
        },
      });
    }
    return contentRevision;
  }

  async buildLegacyTestPayload(request: TestPublicationRequest, actorUserId: string) {
    const images: Array<{ base64: string; mimeType: string; fileName: string }> = [];
    let video: { payload: Record<string, unknown>; mimeType: string; fileName: string } | null =
      null;
    for (const media of request.content.media) {
      if (media.type === 'image') {
        images.push({ base64: media.base64, mimeType: media.mimeType, fileName: media.fileName });
      } else if (media.type === 'video') {
        if (media.base64) {
          const bytes = this.decodeAndValidateVideo(media.base64);
          const validated = await this.mapMaxMediaValidation(
            this.maxClient.validateMediaUploadPayload('video', bytes),
          );
          video = {
            payload: { [PUBLICATION_VIDEO_INLINE_BASE64_FIELD]: bytes.toString('base64') },
            mimeType: validated.mimeType,
            fileName: canonicalizeAdminMaxMediaFileName(
              media.fileName,
              validated.extension,
              'publication-video',
            ),
          };
        }
        if (media.payload) {
          this.assertPublicVideoPayload(media.payload);
          video = { payload: media.payload, mimeType: media.mimeType, fileName: media.fileName };
        }
      } else {
        const asset = await this.prisma.publicationAsset.findFirst({
          where: publicationAssetReferenceWhere(actorUserId, {
            assetId: media.assetId,
            expectedType: media.type === 'video-ref' ? 'video' : 'image',
            sourcePublicationId: media.sourcePublicationId,
          }),
        });
        if (!asset) {
          throw new BadRequestException('Медиа публикации больше недоступно.');
        }
        if (media.type === 'image-ref') {
          if (!asset.bytes) {
            throw new BadRequestException('Фото публикации повреждено.');
          }
          images.push({
            base64: Buffer.from(asset.bytes).toString('base64'),
            mimeType: asset.mimeType,
            fileName: asset.fileName,
          });
        } else {
          const payload = this.readJsonObject(asset.durablePayload);
          if (
            this.hasUploadedVideoMarker(payload) &&
            !readPublicationUploadedVideo(payload, this.publisherBotId())
          ) {
            throw new BadRequestException('Медиа публикации больше недоступно.');
          }
          if (!payload || readPublicationUploadedVideo(payload, this.publisherBotId())) {
            if ((asset.bytes || payload) && asset.mimeType.toLowerCase().startsWith('video/')) {
              video = {
                payload: {
                  [PUBLICATION_VIDEO_ASSET_ID_FIELD]: asset.id,
                  ...(media.sourcePublicationId
                    ? { [PUBLICATION_VIDEO_SOURCE_PUBLICATION_ID_FIELD]: media.sourcePublicationId }
                    : {}),
                },
                mimeType: asset.mimeType,
                fileName: asset.fileName,
              };
              continue;
            }
            throw new BadRequestException('Видео публикации повреждено.');
          }
          video = { payload, mimeType: asset.mimeType, fileName: asset.fileName };
        }
      }
    }
    return {
      requestId: request.requestId,
      text: request.content.text,
      textFormat: request.content.textFormat,
      targetMode: 'current',
      targetChatIds: [],
      applyToAllChats: false,
      buttons: request.content.buttons.map(({ text, url }) => ({ text, url })),
      imageEnabled: images.length > 0,
      imageBase64: images[0]?.base64 ?? '',
      imageMimeType: images[0]?.mimeType ?? '',
      imageFileName: images[0]?.fileName ?? '',
      images,
      mediaType: video ? 'video' : images.length > 1 ? 'image' : null,
      mediaPayload: video ? video.payload : images.length > 1 ? { images } : null,
      mediaMimeType: video?.mimeType ?? '',
      mediaFileName: video?.fileName ?? '',
      scheduleTimezone: 'Europe/Moscow',
      scheduledSlots: [],
      sendAt: null,
      cycleEnabled: false,
      cycleCount: 1,
    };
  }

  private async prepareAssetInputs(media: PublicationMediaInput[]): Promise<PreparedAssetInput[]> {
    const prepared: PreparedAssetInput[] = [];
    let totalImageBytes = 0;
    for (const item of media) {
      if (item.type === 'image-ref' || item.type === 'video-ref') {
        prepared.push({
          kind: 'reference',
          assetId: item.assetId,
          expectedType: item.type === 'video-ref' ? 'video' : 'image',
          ...(item.sourcePublicationId ? { sourcePublicationId: item.sourcePublicationId } : {}),
        });
        continue;
      }
      if (item.type === 'image') {
        const bytes = this.decodeImageBase64(item.base64);
        totalImageBytes += bytes.length;
        prepared.push(
          await this.prepareBinaryAssetInput({ type: 'image', bytes, fileName: item.fileName }),
        );
        continue;
      }
      if (item.base64) {
        const bytes = this.decodeAndValidateVideo(item.base64);
        prepared.push(
          await this.prepareBinaryAssetInput({ type: 'video', bytes, fileName: item.fileName }),
        );
        continue;
      }
      if (!item.payload) {
        throw new BadRequestException('Добавьте видеофайл или сохранённое видео.');
      }
      this.assertPublicVideoPayload(item.payload);
      const stablePayload = this.stableStringify(item.payload);
      prepared.push({
        kind: 'prepared',
        sha256: createHash('sha256').update(`video:${stablePayload}`).digest('hex'),
        mimeType: item.mimeType || PUBLICATION_VIDEO_MIME_TYPE_FALLBACK,
        fileName: item.fileName,
        sizeBytes: Buffer.byteLength(stablePayload),
        bytes: null,
        durablePayload: item.payload as Prisma.InputJsonValue,
        expectedType: 'video',
      });
    }
    if (totalImageBytes > PUBLICATION_MAX_TOTAL_IMAGE_BYTES) {
      throw new BadRequestException('Суммарный размер фото превышает 24 МБ.');
    }
    return prepared;
  }

  private async prepareBinaryAssetInput(
    item: PublicationBinaryMediaInput,
  ): Promise<PreparedAssetInput> {
    const { bytes, type } = item;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw new BadRequestException(type === 'image' ? 'Фото пустое.' : 'Видео пустое.');
    }
    if (
      bytes.length > (type === 'image' ? PUBLICATION_MAX_IMAGE_BYTES : PUBLICATION_MAX_VIDEO_BYTES)
    ) {
      throw new BadRequestException(
        type === 'image'
          ? 'Фото слишком большое. Максимум 8 МБ.'
          : 'Видео слишком большое. Максимум 24 МБ.',
      );
    }
    const validated =
      type === 'image'
        ? await this.mapMaxMediaValidation(
            this.maxClient.validateMediaUploadPayload('image', bytes),
          )
        : await this.mapMaxMediaValidation(
            this.maxClient.validateMediaUploadPayload('video', bytes),
          );
    const digest = createHash('sha256');
    if (type === 'video') digest.update('video-bytes:');
    return {
      kind: 'prepared',
      sha256: digest.update(bytes).digest('hex'),
      mimeType: validated.mimeType,
      fileName: canonicalizeAdminMaxMediaFileName(
        item.fileName,
        validated.extension,
        `publication-${type}`,
      ),
      sizeBytes: bytes.length,
      bytes,
      durablePayload: null,
      expectedType: type,
    };
  }

  private async resolvePersistedAssetInputs(
    tx: any,
    prepared: PreparedAssetInput[],
    actorUserId: string,
    publicationId?: string,
  ): Promise<PersistedAssetInput[]> {
    const resolved: PersistedAssetInput[] = [];
    let totalImageBytes = 0;
    for (const item of prepared) {
      if (item.kind === 'reference') {
        const asset = await tx.publicationAsset.findFirst({
          where: publicationAssetReferenceWhere(actorUserId, item, publicationId),
          select: PUBLICATION_ASSET_METADATA_SELECT,
        });
        if (!asset) {
          throw new BadRequestException('Медиа публикации больше недоступно.');
        }
        const actualType =
          asset.durablePayload || asset.mimeType.toLowerCase().startsWith('video/')
            ? 'video'
            : 'image';
        if (
          actualType === 'video' &&
          this.hasUploadedVideoMarker(asset.durablePayload) &&
          !readPublicationUploadedVideo(asset.durablePayload, this.publisherBotId())
        ) {
          throw new BadRequestException('Медиа публикации больше недоступно.');
        }
        if (actualType !== item.expectedType) {
          throw new BadRequestException('Тип сохранённого медиа не совпадает.');
        }
        if (actualType === 'image') {
          totalImageBytes += asset.sizeBytes;
        }
        resolved.push({
          sha256: asset.sha256,
          mimeType: asset.mimeType,
          fileName: asset.fileName,
          sizeBytes: asset.sizeBytes,
          bytes: null,
          durablePayload: null,
          expectedType: item.expectedType,
          existingAssetId: asset.id,
        });
        continue;
      }

      if (item.expectedType === 'image') {
        totalImageBytes += item.sizeBytes;
      }
      resolved.push({
        sha256: item.sha256,
        mimeType: item.mimeType,
        fileName: item.fileName,
        sizeBytes: item.sizeBytes,
        bytes: item.bytes,
        durablePayload: item.durablePayload,
        expectedType: item.expectedType,
      });
    }
    if (totalImageBytes > PUBLICATION_MAX_TOTAL_IMAGE_BYTES) {
      throw new BadRequestException('Суммарный размер фото превышает 24 МБ.');
    }
    return resolved;
  }

  private publisherBotId(): string {
    return buildPublisherBotDescriptor({ id: process.env.MAX_PUBLISHER_BOT_ID }).id;
  }

  private hasUploadedVideoMarker(value: unknown): boolean {
    return Boolean(
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      PUBLICATION_UPLOADED_VIDEO_FIELD in value,
    );
  }

  private decodeImageBase64(value: string): Buffer {
    const normalized = value.trim().replace(/^data:[^;]+;base64,/u, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized) || normalized.length % 4 !== 0) {
      throw new BadRequestException('Фото повреждено. Добавьте файл заново.');
    }
    const bytes = Buffer.from(normalized, 'base64');
    if (bytes.length === 0) {
      throw new BadRequestException('Фото пустое.');
    }
    return bytes;
  }

  private async mapMaxMediaValidation<T>(validation: Promise<T>): Promise<T> {
    try {
      return await validation;
    } catch (error: unknown) {
      if (error instanceof MaxMediaUploadValidationError) {
        throw new BadRequestException(error.publicMessage);
      }
      throw error;
    }
  }

  private decodeVideoBase64(value: string): Buffer {
    const normalized = value.trim().replace(/^data:[^;]+;base64,/u, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized) || normalized.length % 4 !== 0) {
      throw new BadRequestException('Видео повреждено. Добавьте файл заново.');
    }
    const bytes = Buffer.from(normalized, 'base64');
    if (bytes.length === 0) {
      throw new BadRequestException('Видео пустое.');
    }
    return bytes;
  }

  private decodeAndValidateVideo(value: string): Buffer {
    const bytes = this.decodeVideoBase64(value);
    if (bytes.length > PUBLICATION_MAX_VIDEO_BYTES) {
      throw new BadRequestException('Видео слишком большое. Максимум 24 МБ.');
    }
    return bytes;
  }

  private assertPublicVideoPayload(value: Record<string, unknown>): void {
    if (hasPublicationVideoInternalMarker(value)) {
      throw new BadRequestException('Сохранённое видео больше недоступно.');
    }
  }

  private stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }
    if (value && typeof value === 'object') {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${this.stableStringify(item)}`)
        .join(',')}}`;
    }
    return JSON.stringify(value);
  }

  private readJsonObject(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }
}
