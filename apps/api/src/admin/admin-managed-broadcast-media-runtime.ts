import {
  MAX_BROADCAST_IMAGES,
  type BroadcastImage,
  type ManagedEntityType,
  type SendBroadcastRequest,
} from '@maxim/contracts';
import { BadRequestException } from '@nestjs/common';
import {
  MaxMediaUploadValidationError,
  validateMaxMediaUploadPayload,
} from '../max/max-media-upload-validation';
import { type ManagedBroadcast as PersistedManagedBroadcast } from '../prisma/prisma-client';
import { MAX_API_SOURCE_TAGS, type MaxAttachmentPayload } from '../max/max-client.service';
import { extractMaxApiErrorMessage as extractMaxApiErrorMessageValue } from './admin-chat-rules';
import {
  decodeBroadcastImageBase64 as decodeBroadcastImageBase64Value,
  resolveBroadcastImageFileName as resolveBroadcastImageFileNameValue,
  resolveManagedBroadcastUploadRetryDelayMs,
} from './admin-managed-broadcast-media';
import type { AdminManagedBroadcastRuntimeContext } from './admin-managed-broadcast-runtime-context';
import {
  PUBLICATION_MAX_VIDEO_BYTES,
  PUBLICATION_VIDEO_ASSET_ID_FIELD,
  PUBLICATION_VIDEO_SOURCE_PUBLICATION_ID_FIELD,
  PUBLICATION_VIDEO_INLINE_BASE64_FIELD,
  PUBLICATION_UPLOADED_VIDEO_FIELD,
  readPublicationUploadedVideo,
} from './publication-video-media';
import { publicationAssetReferenceWhere } from './publication-asset-access';
import {
  PUBLICATION_ASSET_METADATA_SELECT,
  PUBLICATION_MAX_IMAGE_BYTES,
  PUBLICATION_MAX_TOTAL_IMAGE_BYTES,
} from './publication-media-limits';
import {
  BROADCAST_IMAGE_MAX_BYTES,
  BROADCAST_IMAGES_TOTAL_MAX_BYTES,
  BROADCAST_THROTTLE_RETRY_DELAYS_MS,
  BROADCAST_TIMEOUT_RETRY_DELAYS_MS,
  readManagedBroadcastMediaType,
  sleep,
  type AdminActionSource,
  type ManagedBroadcastMaxApiOptions,
  type ManagedBroadcastResolvedMedia,
} from './admin.service.support';
import { canonicalizeAdminMaxMediaFileName } from './admin-max-media-file-name';

export type ManagedBroadcastProgressCallback = () => Promise<void>;

export type ManagedBroadcastMediaResolutionOptions = {
  trustedPublicationVideoMarkers?: boolean;
  trustedPublicationTestPayload?: boolean;
};

export type ManagedBroadcastTestOptions = ManagedBroadcastMediaResolutionOptions;

export type ManagedBroadcastRequestMedia = Pick<
  SendBroadcastRequest,
  | 'imageEnabled'
  | 'imageBase64'
  | 'imageMimeType'
  | 'imageFileName'
  | 'images'
  | 'mediaType'
  | 'mediaPayload'
  | 'mediaMimeType'
  | 'mediaFileName'
>;

type PublicationExecutionAsset = {
  id: string;
  actorUserId: string;
  sha256: string;
  sizeBytes: number;
  mimeType: string;
  fileName: string;
  durablePayload: unknown;
};

export type ManagedBroadcastExecutionMedia = {
  requestMedia: ManagedBroadcastRequestMedia;
  publicationSource?: {
    contentRevisionId: string;
    actorUserId: string;
    assets: readonly PublicationExecutionAsset[];
  };
};

export class ManagedBroadcastTransientUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManagedBroadcastTransientUploadError';
  }
}

export class AdminManagedBroadcastMediaRuntime {
  constructor(private readonly context: AdminManagedBroadcastRuntimeContext) {}

  private get prisma() {
    return this.context.prisma;
  }

  private get maxClient() {
    return this.context.maxClient;
  }

  private get logger() {
    return this.context.logger;
  }

  private extractMaxApiErrorMessage(error: unknown): string {
    return extractMaxApiErrorMessageValue(error);
  }

  private readObjectPayloadOrNull(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }

  private readTrimmedString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }

  private resolveManagedBroadcastUploadRetryDelayMs(
    error: unknown,
    attempt: number,
  ): number | null {
    return resolveManagedBroadcastUploadRetryDelayMs(error, attempt);
  }

  private sleep(ms: number): Promise<void> {
    return sleep(ms);
  }

  private decodeBroadcastImageBase64(value: string): Buffer {
    return decodeBroadcastImageBase64Value(value);
  }

  private resolveBroadcastImageFileName(fileName: string, mimeType: string): string {
    return resolveBroadcastImageFileNameValue(fileName, mimeType);
  }

  async resolveManagedBroadcastMedia(
    payload: SendBroadcastRequest,
    entityType: ManagedEntityType,
    sourceChatId: string,
    actorUserId: string,
    botId?: string,
    maxApiOptions?: ManagedBroadcastMaxApiOptions,
    onProgress?: ManagedBroadcastProgressCallback,
    options: ManagedBroadcastMediaResolutionOptions = {},
  ): Promise<ManagedBroadcastResolvedMedia> {
    const images = this.resolveManagedBroadcastRequestImages(payload);
    if (images.length === 1) {
      const imagePayload = await this.uploadManagedBroadcastImage(
        images[0],
        entityType,
        sourceChatId,
        actorUserId,
        botId,
        maxApiOptions,
        onProgress,
        options,
      );
      return imagePayload ? { imagePayload } : {};
    }

    if (images.length > 1) {
      const attachments: MaxAttachmentPayload[] = [];
      for (const image of images) {
        const imagePayload = await this.uploadManagedBroadcastImage(
          image,
          entityType,
          sourceChatId,
          actorUserId,
          botId,
          maxApiOptions,
          onProgress,
          options,
        );
        if (imagePayload) {
          attachments.push({
            type: 'image',
            payload: imagePayload,
          });
        }
      }

      return attachments.length > 0 ? { attachments } : {};
    }

    if (payload.mediaType === 'video' && payload.mediaPayload) {
      const publicationAssetId = this.readTrimmedString(
        payload.mediaPayload[PUBLICATION_VIDEO_ASSET_ID_FIELD],
      );
      const publicationInlineBase64 = this.readTrimmedString(
        payload.mediaPayload[PUBLICATION_VIDEO_INLINE_BASE64_FIELD],
      );
      const sourcePublicationId = this.readTrimmedString(
        payload.mediaPayload[PUBLICATION_VIDEO_SOURCE_PUBLICATION_ID_FIELD],
      );
      const hasSourcePublication =
        PUBLICATION_VIDEO_SOURCE_PUBLICATION_ID_FIELD in payload.mediaPayload;
      if (publicationAssetId || publicationInlineBase64 || hasSourcePublication) {
        if (!options.trustedPublicationVideoMarkers) {
          throw new BadRequestException('Внутренняя ссылка на видео недоступна.');
        }
        if (
          (publicationAssetId && publicationInlineBase64) ||
          (hasSourcePublication &&
            (!publicationAssetId || !sourcePublicationId || sourcePublicationId.length > 256))
        ) {
          throw new BadRequestException('Видео публикации повреждено.');
        }
      }
      const videoPayload = publicationAssetId
        ? await this.uploadManagedBroadcastPublicationVideo(
            publicationAssetId,
            entityType,
            sourceChatId,
            actorUserId,
            botId,
            maxApiOptions,
            onProgress,
            sourcePublicationId ?? undefined,
          )
        : publicationInlineBase64
          ? await this.uploadManagedBroadcastInlinePublicationVideo(
              publicationInlineBase64,
              payload.mediaMimeType,
              payload.mediaFileName,
              entityType,
              sourceChatId,
              actorUserId,
              botId,
              maxApiOptions,
              onProgress,
            )
          : payload.mediaPayload;
      return {
        attachments: [
          {
            type: 'video',
            payload: videoPayload,
          },
        ],
      };
    }

    return {};
  }

  private resolveManagedBroadcastRequestImages(payload: SendBroadcastRequest): BroadcastImage[] {
    const explicitImages = Array.isArray(payload.images)
      ? payload.images.filter((image) => image.base64.trim().length > 0)
      : [];
    if (explicitImages.length > 0) {
      return explicitImages.slice(0, MAX_BROADCAST_IMAGES);
    }

    const imageBase64 = payload.imageBase64.trim();
    if (!payload.imageEnabled || !imageBase64) {
      return [];
    }

    return [
      {
        base64: imageBase64,
        mimeType: payload.imageMimeType.trim(),
        fileName: payload.imageFileName.trim(),
      },
    ];
  }

  private readManagedBroadcastMediaPayloadImages(value: unknown): BroadcastImage[] {
    const payload = this.readObjectPayloadOrNull(value);
    if (!payload || !Array.isArray(payload.images)) {
      return [];
    }

    return payload.images
      .map((item: any) => this.readManagedBroadcastMediaPayloadImage(item))
      .filter((image: any): image is BroadcastImage => image !== null)
      .slice(0, MAX_BROADCAST_IMAGES);
  }

  private readManagedBroadcastMediaPayloadImage(value: unknown): BroadcastImage | null {
    const payload = this.readObjectPayloadOrNull(value);
    if (!payload) {
      return null;
    }

    const base64 = this.readTrimmedString(payload.base64);
    if (!base64) {
      return null;
    }

    return {
      base64,
      mimeType: this.readTrimmedString(payload.mimeType) ?? '',
      fileName: this.readTrimmedString(payload.fileName) ?? '',
    };
  }

  readManagedBroadcastImagesFromRow(row: PersistedManagedBroadcast): BroadcastImage[] {
    if (readManagedBroadcastMediaType(row.mediaType) === 'image') {
      const payloadImages = this.readManagedBroadcastMediaPayloadImages(row.mediaPayload);
      if (payloadImages.length > 0) {
        return payloadImages;
      }
    }

    const imageBase64 = row.imageBase64.trim();
    if (!row.imageEnabled || !imageBase64) {
      return [];
    }

    return [
      {
        base64: imageBase64,
        mimeType: row.imageMimeType.trim(),
        fileName: row.imageFileName.trim(),
      },
    ];
  }

  async loadManagedBroadcastExecutionMedia(
    row: PersistedManagedBroadcast,
  ): Promise<ManagedBroadcastExecutionMedia> {
    if (!row.publicationContentRevisionId) {
      return { requestMedia: await this.loadManagedBroadcastRequestMedia(row) };
    }

    // FLAG: Canonical execution reads the exact publication actor/revision link. A copied
    // asset keeps its original owner; the accepted immutable link authorizes its bytes.
    const revision = await this.prisma.publicationContentRevision.findFirst({
      where: {
        id: row.publicationContentRevisionId,
        publication: { actorUserId: row.actorUserId },
      },
      select: {
        assets: {
          orderBy: [{ position: 'asc' }],
          select: {
            asset: { select: { ...PUBLICATION_ASSET_METADATA_SELECT, actorUserId: true } },
          },
        },
      },
    });
    if (!revision) {
      throw new BadRequestException('Медиа публикации больше недоступно.');
    }
    return {
      requestMedia: {
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        images: [],
        mediaType: null,
        mediaPayload: null,
        mediaMimeType: '',
        mediaFileName: '',
      },
      publicationSource: {
        contentRevisionId: row.publicationContentRevisionId,
        actorUserId: row.actorUserId,
        assets: revision.assets.map(({ asset }) => asset),
      },
    };
  }

  async resolveManagedBroadcastExecutionMedia(
    execution: ManagedBroadcastExecutionMedia,
    payload: SendBroadcastRequest,
    entityType: ManagedEntityType,
    sourceChatId: string,
    actorUserId: string,
    botId?: string,
    maxApiOptions?: ManagedBroadcastMaxApiOptions,
    onProgress?: ManagedBroadcastProgressCallback,
    options: ManagedBroadcastMediaResolutionOptions = {},
  ): Promise<ManagedBroadcastResolvedMedia> {
    const source = execution.publicationSource;
    if (!source) {
      return this.resolveManagedBroadcastMedia(
        payload,
        entityType,
        sourceChatId,
        actorUserId,
        botId,
        maxApiOptions,
        onProgress,
        options,
      );
    }
    if (source.actorUserId !== actorUserId) {
      throw new BadRequestException('Медиа публикации больше недоступно.');
    }
    const videos = source.assets.filter(
      (asset) =>
        this.readObjectPayloadOrNull(asset.durablePayload) !== null ||
        asset.mimeType.toLowerCase().startsWith('video/'),
    );
    if (videos.length > 0) {
      if (videos.length !== 1 || source.assets.length !== 1) {
        throw new BadRequestException(
          'В одной публикации можно добавить либо фотографии, либо одно видео.',
        );
      }
      const asset = videos[0];
      const payload = this.readObjectPayloadOrNull(asset.durablePayload);
      let videoPayload: Record<string, unknown>;
      if (payload && !(PUBLICATION_UPLOADED_VIDEO_FIELD in payload)) {
        // FLAG: Historical untagged durable payloads retain their existing contract.
        videoPayload = payload;
      } else {
        const mimeType = asset.mimeType.trim().toLowerCase();
        const uploaded = readPublicationUploadedVideo(payload, botId ?? '');
        if (!mimeType.startsWith('video/')) {
          throw new BadRequestException('Видео публикации больше недоступно.');
        }
        if (uploaded) {
          // FLAG: An exact-bot remote video never selects local bytes, even above 24 MB.
          videoPayload = uploaded;
        } else {
          if (asset.sizeBytes > PUBLICATION_MAX_VIDEO_BYTES) {
            throw new BadRequestException('Видео слишком большое. Максимум 24 МБ.');
          }
          const bytes = await this.loadPublicationExecutionAssetBytes(source, asset);
          videoPayload = await this.uploadManagedBroadcastPublicationVideoBytes(
            bytes,
            mimeType,
            asset.fileName,
            entityType,
            sourceChatId,
            actorUserId,
            botId,
            maxApiOptions,
            onProgress,
            asset.id,
          );
        }
      }
      return { attachments: [{ type: 'video', payload: videoPayload }] };
    }

    const images = source.assets.slice(0, MAX_BROADCAST_IMAGES);
    const attachments: MaxAttachmentPayload[] = [];
    for (const asset of images) {
      // FLAG: Preserve the scheduled execution's existing image cap; authoring/test
      // limits are separate. Fetch and validate one binary image at a time.
      if (asset.sizeBytes > BROADCAST_IMAGE_MAX_BYTES) {
        throw new BadRequestException('Фото слишком большое. Попробуйте другое изображение.');
      }
      const bytes = await this.loadPublicationExecutionAssetBytes(source, asset);
      const validated = await this.validateManagedBroadcastImageBytes(bytes);
      const imagePayload = await this.uploadManagedBroadcastImageBytes(
        validated,
        asset.fileName,
        entityType,
        sourceChatId,
        actorUserId,
        botId,
        maxApiOptions,
        onProgress,
      );
      if (imagePayload) attachments.push({ type: 'image', payload: imagePayload });
    }
    return images.length === 1
      ? attachments[0]
        ? { imagePayload: attachments[0].payload }
        : {}
      : attachments.length > 0
        ? { attachments }
        : {};
  }

  private async loadPublicationExecutionAssetBytes(
    source: NonNullable<ManagedBroadcastExecutionMedia['publicationSource']>,
    asset: PublicationExecutionAsset,
  ): Promise<Buffer> {
    if (!Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes <= 0) {
      throw new BadRequestException('Медиа публикации больше недоступно.');
    }
    const persisted = await this.prisma.publicationAsset.findFirst({
      where: {
        id: asset.id,
        actorUserId: asset.actorUserId,
        sha256: asset.sha256,
        sizeBytes: asset.sizeBytes,
        contentLinks: {
          some: {
            contentRevisionId: source.contentRevisionId,
            contentRevision: { publication: { actorUserId: source.actorUserId } },
          },
        },
      },
      select: { bytes: true },
    });
    const bytes = persisted?.bytes;
    if (!bytes || bytes.byteLength !== asset.sizeBytes) {
      throw new BadRequestException('Медиа публикации больше недоступно.');
    }
    // FLAG: Publication assets are immutable and MAX validators/transport only read
    // buffers. A view preserves the owned bytes without base64 or a second copy.
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  async loadManagedBroadcastRequestMedia(
    row: PersistedManagedBroadcast,
  ): Promise<ManagedBroadcastRequestMedia> {
    if (!row.publicationContentRevisionId) {
      return {
        imageEnabled: row.imageEnabled,
        imageBase64: row.imageBase64,
        imageMimeType: row.imageMimeType,
        imageFileName: row.imageFileName,
        images: this.readManagedBroadcastImagesFromRow(row),
        mediaType: readManagedBroadcastMediaType(row.mediaType),
        mediaPayload: this.readObjectPayloadOrNull(row.mediaPayload),
        mediaMimeType: row.mediaMimeType,
        mediaFileName: row.mediaFileName,
      };
    }

    const contentRevision = await this.prisma.publicationContentRevision.findUnique({
      where: { id: row.publicationContentRevisionId },
      select: {
        assets: {
          orderBy: [{ position: 'asc' }],
          select: {
            asset: {
              select: {
                id: true,
                bytes: true,
                durablePayload: true,
                mimeType: true,
                fileName: true,
              },
            },
          },
        },
      },
    });
    if (!contentRevision) {
      throw new BadRequestException('Медиа публикации больше недоступно.');
    }

    const videoAssets = contentRevision.assets
      .map(({ asset }) => ({
        asset,
        payload: this.readObjectPayloadOrNull(asset.durablePayload),
      }))
      .filter(
        (item) => item.payload !== null || item.asset.mimeType.toLowerCase().startsWith('video/'),
      );
    if (videoAssets.length > 0) {
      if (videoAssets.length !== 1 || contentRevision.assets.length !== 1) {
        throw new BadRequestException(
          'В одной публикации можно добавить либо фотографии, либо одно видео.',
        );
      }

      const [{ asset, payload }] = videoAssets;
      if (!payload && !asset.bytes) {
        throw new BadRequestException('Видео публикации больше недоступно.');
      }
      return {
        imageEnabled: false,
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        images: [],
        mediaType: 'video',
        mediaPayload:
          payload && !(PUBLICATION_UPLOADED_VIDEO_FIELD in payload)
            ? payload
            : { [PUBLICATION_VIDEO_ASSET_ID_FIELD]: asset.id },
        mediaMimeType: asset.mimeType.trim(),
        mediaFileName: asset.fileName.trim(),
      };
    }

    const images = contentRevision.assets.map(({ asset }) => {
      if (!asset.bytes) {
        throw new BadRequestException('Медиа публикации больше недоступно.');
      }

      return {
        base64: Buffer.from(asset.bytes).toString('base64'),
        mimeType: asset.mimeType.trim(),
        fileName: asset.fileName.trim(),
      };
    });
    const firstImage = images[0];

    return {
      imageEnabled: Boolean(firstImage),
      imageBase64: firstImage?.base64 ?? '',
      imageMimeType: firstImage?.mimeType ?? '',
      imageFileName: firstImage?.fileName ?? '',
      images,
      mediaType: images.length > 1 ? 'image' : null,
      mediaPayload: images.length > 1 ? { images } : null,
      mediaMimeType: '',
      mediaFileName: '',
    };
  }

  async validateManagedBroadcastMediaPayload(
    payload: SendBroadcastRequest,
    options: Pick<ManagedBroadcastTestOptions, 'trustedPublicationTestPayload'> = {},
  ): Promise<void> {
    const images = this.resolveManagedBroadcastRequestImages(payload);
    if (images.length === 0) {
      return;
    }

    if (images.length > MAX_BROADCAST_IMAGES) {
      throw new BadRequestException(
        `В одном автопостинге можно добавить до ${MAX_BROADCAST_IMAGES} фото.`,
      );
    }

    let totalBytes = 0;
    const canonicalImages: BroadcastImage[] = [];
    try {
      for (const image of images) {
        const validated = await this.validateManagedBroadcastImagePayload(image, options);
        totalBytes += validated.buffer.length;
        canonicalImages.push({
          base64: image.base64,
          mimeType: validated.mimeType,
          fileName: canonicalizeAdminMaxMediaFileName(
            image.fileName,
            validated.extension,
            'broadcast-image',
          ),
        });
      }
    } catch (error: unknown) {
      if (error instanceof MaxMediaUploadValidationError) {
        throw new BadRequestException(error.publicMessage);
      }
      throw error;
    }

    const maxTotalBytes = options.trustedPublicationTestPayload
      ? PUBLICATION_MAX_TOTAL_IMAGE_BYTES
      : BROADCAST_IMAGES_TOTAL_MAX_BYTES;
    if (totalBytes > maxTotalBytes) {
      throw new BadRequestException('Суммарный размер фото слишком большой.');
    }

    const firstImage = canonicalImages[0];
    payload.images = canonicalImages;
    payload.imageEnabled = true;
    payload.imageBase64 = firstImage.base64;
    payload.imageMimeType = firstImage.mimeType;
    payload.imageFileName = firstImage.fileName;
    if (payload.mediaType === 'image') {
      payload.mediaPayload = { images: canonicalImages };
    }
  }

  private async validateManagedBroadcastImagePayload(
    image: BroadcastImage,
    options: Pick<ManagedBroadcastTestOptions, 'trustedPublicationTestPayload'> = {},
  ): Promise<{ buffer: Buffer; mimeType: string; extension: string }> {
    const imageBuffer = this.decodeBroadcastImageBase64(image.base64);
    return this.validateManagedBroadcastImageBytes(imageBuffer, options);
  }

  private async validateManagedBroadcastImageBytes(
    imageBuffer: Buffer,
    options: Pick<ManagedBroadcastTestOptions, 'trustedPublicationTestPayload'> = {},
  ): Promise<{ buffer: Buffer; mimeType: string; extension: string }> {
    const maxBytes = options.trustedPublicationTestPayload
      ? PUBLICATION_MAX_IMAGE_BYTES
      : BROADCAST_IMAGE_MAX_BYTES;
    if (imageBuffer.length > maxBytes) {
      throw new BadRequestException('Фото слишком большое. Попробуйте другое изображение.');
    }

    const validated =
      typeof this.maxClient.validateMediaUploadPayload === 'function'
        ? await this.maxClient.validateMediaUploadPayload('image', imageBuffer)
        : await validateMaxMediaUploadPayload('image', imageBuffer);
    return {
      buffer: imageBuffer,
      mimeType: validated.mimeType,
      extension: validated.extension,
    };
  }

  private async uploadManagedBroadcastImage(
    image: BroadcastImage,
    entityType: ManagedEntityType,
    sourceChatId: string,
    actorUserId: string,
    botId?: string,
    maxApiOptions?: ManagedBroadcastMaxApiOptions,
    onProgress?: ManagedBroadcastProgressCallback,
    options: Pick<ManagedBroadcastTestOptions, 'trustedPublicationTestPayload'> = {},
  ): Promise<Record<string, unknown> | undefined> {
    const validated = await this.validateManagedBroadcastImagePayload(image, options);
    return this.uploadManagedBroadcastImageBytes(
      validated,
      image.fileName,
      entityType,
      sourceChatId,
      actorUserId,
      botId,
      maxApiOptions,
      onProgress,
    );
  }

  private async uploadManagedBroadcastImageBytes(
    validated: { buffer: Buffer; mimeType: string; extension: string },
    fileName: string,
    entityType: ManagedEntityType,
    sourceChatId: string,
    actorUserId: string,
    botId?: string,
    maxApiOptions?: ManagedBroadcastMaxApiOptions,
    onProgress?: ManagedBroadcastProgressCallback,
  ): Promise<Record<string, unknown> | undefined> {
    const imageBuffer = validated.buffer;
    const imageMimeType = validated.mimeType;
    const imageFileName = canonicalizeAdminMaxMediaFileName(
      fileName,
      validated.extension,
      'broadcast-image',
    );

    let lastError: unknown = null;
    const attempts =
      Math.max(
        BROADCAST_THROTTLE_RETRY_DELAYS_MS.length,
        BROADCAST_TIMEOUT_RETRY_DELAYS_MS.length,
      ) + 1;

    try {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          const uploaded = botId
            ? await this.maxClient.uploadImage(
                imageBuffer,
                this.resolveBroadcastImageFileName(imageFileName, imageMimeType),
                imageMimeType,
                {
                  ...this.buildManagedBroadcastMaxApiRequestOptions(maxApiOptions),
                  botId,
                },
              )
            : await this.maxClient.uploadImage(
                imageBuffer,
                this.resolveBroadcastImageFileName(imageFileName, imageMimeType),
                imageMimeType,
                this.buildManagedBroadcastMaxApiRequestOptions(maxApiOptions),
              );
          await onProgress?.();
          return uploaded;
        } catch (error: unknown) {
          lastError = error;
          const retryDelayMs = this.resolveManagedBroadcastUploadRetryDelayMs(error, attempt);
          if (retryDelayMs === null) {
            throw error;
          }
          await onProgress?.();
          await this.sleep(retryDelayMs);
        }
      }

      if (lastError) {
        throw lastError;
      }

      throw new Error('Managed broadcast image upload did not return a result.');
    } catch (error: unknown) {
      if (error instanceof MaxMediaUploadValidationError) {
        throw error;
      }
      this.logger.warn(
        {
          entityType,
          sourceChatId,
          actorUserId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Broadcast image upload failed',
      );
      const reason =
        this.extractMaxApiErrorMessage(error) ||
        (error instanceof Error && error.message.trim() ? error.message.trim() : null);
      throw new ManagedBroadcastTransientUploadError(
        reason ? `Не удалось загрузить фото: ${reason}` : 'Не удалось загрузить фото.',
      );
    }
  }

  private async uploadManagedBroadcastPublicationVideo(
    assetId: string,
    entityType: ManagedEntityType,
    sourceChatId: string,
    actorUserId: string,
    botId?: string,
    maxApiOptions?: ManagedBroadcastMaxApiOptions,
    onProgress?: ManagedBroadcastProgressCallback,
    sourcePublicationId?: string,
  ): Promise<Record<string, unknown>> {
    const asset = await this.prisma.publicationAsset.findFirst({
      // FLAG: Private tests have no accepted execution revision. Recheck the exact source
      // and current Publisher access even after the authoring layer validated the marker.
      where: publicationAssetReferenceWhere(actorUserId, {
        assetId,
        expectedType: 'video',
        sourcePublicationId,
      }),
      select: { bytes: true, mimeType: true, fileName: true, durablePayload: true },
    });
    const mimeType = asset?.mimeType.trim().toLowerCase() ?? '';
    const uploaded = readPublicationUploadedVideo(asset?.durablePayload, botId ?? '');
    if (uploaded && mimeType.startsWith('video/')) return uploaded;
    if (!asset?.bytes || !mimeType.startsWith('video/')) {
      throw new BadRequestException('Видео публикации больше недоступно.');
    }

    return this.uploadManagedBroadcastPublicationVideoBytes(
      Buffer.from(asset.bytes),
      mimeType,
      asset.fileName,
      entityType,
      sourceChatId,
      actorUserId,
      botId,
      maxApiOptions,
      onProgress,
      assetId,
    );
  }

  private async uploadManagedBroadcastInlinePublicationVideo(
    base64: string,
    mimeTypeValue: string,
    fileName: string,
    entityType: ManagedEntityType,
    sourceChatId: string,
    actorUserId: string,
    botId?: string,
    maxApiOptions?: ManagedBroadcastMaxApiOptions,
    onProgress?: ManagedBroadcastProgressCallback,
  ): Promise<Record<string, unknown>> {
    const mimeType = mimeTypeValue.trim().toLowerCase();
    if (!mimeType.startsWith('video/')) {
      throw new BadRequestException('Неверный формат видео.');
    }
    const video = this.decodeManagedBroadcastPublicationVideoBase64(base64);
    return this.uploadManagedBroadcastPublicationVideoBytes(
      video,
      mimeType,
      fileName,
      entityType,
      sourceChatId,
      actorUserId,
      botId,
      maxApiOptions,
      onProgress,
    );
  }

  private decodeManagedBroadcastPublicationVideoBase64(value: string): Buffer {
    const normalized = value.trim().replace(/^data:[^;]+;base64,/u, '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(normalized) || normalized.length % 4 !== 0) {
      throw new BadRequestException('Видео повреждено. Добавьте файл заново.');
    }
    const video = Buffer.from(normalized, 'base64');
    if (video.length === 0) {
      throw new BadRequestException('Видео пустое.');
    }
    if (video.length > PUBLICATION_MAX_VIDEO_BYTES) {
      throw new BadRequestException('Видео слишком большое. Максимум 24 МБ.');
    }
    return video;
  }

  private async uploadManagedBroadcastPublicationVideoBytes(
    video: Buffer,
    mimeType: string,
    fileName: string,
    entityType: ManagedEntityType,
    sourceChatId: string,
    actorUserId: string,
    botId?: string,
    maxApiOptions?: ManagedBroadcastMaxApiOptions,
    onProgress?: ManagedBroadcastProgressCallback,
    assetId?: string,
  ): Promise<Record<string, unknown>> {
    let lastError: unknown = null;
    const attempts =
      Math.max(
        BROADCAST_THROTTLE_RETRY_DELAYS_MS.length,
        BROADCAST_TIMEOUT_RETRY_DELAYS_MS.length,
      ) + 1;

    try {
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
          const uploaded = await this.maxClient.uploadVideo(
            video,
            fileName.trim() || 'publication-video.mp4',
            mimeType,
            {
              ...this.buildManagedBroadcastMaxApiRequestOptions(maxApiOptions),
              ...(botId ? { botId } : {}),
            },
          );
          await onProgress?.();
          return uploaded;
        } catch (error: unknown) {
          lastError = error;
          const retryDelayMs = this.resolveManagedBroadcastUploadRetryDelayMs(error, attempt);
          if (retryDelayMs === null) {
            throw error;
          }
          await onProgress?.();
          await this.sleep(retryDelayMs);
        }
      }

      throw lastError ?? new Error('Managed broadcast video upload did not return a result.');
    } catch (error: unknown) {
      if (error instanceof MaxMediaUploadValidationError) {
        throw error;
      }
      this.logger.warn(
        {
          entityType,
          sourceChatId,
          actorUserId,
          ...(assetId ? { assetId } : {}),
          err: error instanceof Error ? error.message : String(error),
        },
        'Broadcast video upload failed',
      );
      const reason =
        this.extractMaxApiErrorMessage(error) ||
        (error instanceof Error && error.message.trim() ? error.message.trim() : null);
      throw new ManagedBroadcastTransientUploadError(
        reason ? `Не удалось загрузить видео: ${reason}` : 'Не удалось загрузить видео.',
      );
    }
  }

  buildManagedBroadcastMaxApiOptions(
    trafficClass: NonNullable<ManagedBroadcastMaxApiOptions['trafficClass']>,
  ): ManagedBroadcastMaxApiOptions {
    return {
      trafficClass,
      actionHealthLane: trafficClass,
      sourceTag: MAX_API_SOURCE_TAGS.MANAGED_BROADCAST,
    };
  }

  buildManagedBroadcastMaxApiRequestOptions(
    options?: ManagedBroadcastMaxApiOptions,
  ): ManagedBroadcastMaxApiOptions {
    return options ?? this.buildManagedBroadcastMaxApiOptions('interactive');
  }

  resolveManagedBroadcastSourceMaxApiOptions(
    source: AdminActionSource,
  ): ManagedBroadcastMaxApiOptions {
    return this.buildManagedBroadcastMaxApiOptions(
      source === 'autopost_rule' ? 'background' : 'interactive',
    );
  }

  resolveManagedBroadcastProcessingMaxApiOptions(
    reason: 'startup' | 'scheduled' | 'manual_retry' | 'immediate' | 'deadline',
  ): ManagedBroadcastMaxApiOptions {
    return this.buildManagedBroadcastMaxApiOptions(
      reason === 'startup' || reason === 'scheduled' || reason === 'deadline'
        ? 'background'
        : 'interactive',
    );
  }
}
