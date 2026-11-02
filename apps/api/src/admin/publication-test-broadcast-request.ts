import {
  type BroadcastImage,
  type SendBroadcastRequest,
  sendBroadcastRequestSchema,
} from '@maxim/contracts';
import {
  MAX_PUBLICATION_IMAGE_BASE64_LENGTH,
  MAX_PUBLICATION_IMAGES,
  MAX_PUBLICATION_IMAGES_TOTAL_BASE64_LENGTH,
  MAX_PUBLICATION_TEXT_LENGTH,
  MAX_PUBLICATION_VIDEO_BASE64_LENGTH,
} from '@maxim/contracts/publication';
import { z } from 'zod';
import {
  PUBLICATION_VIDEO_ASSET_ID_FIELD,
  PUBLICATION_VIDEO_SOURCE_PUBLICATION_ID_FIELD,
  PUBLICATION_VIDEO_INLINE_BASE64_FIELD,
} from './publication-video-media';

const trustedPublicationImageSchema = z.object({
  base64: z.string().trim().min(1).max(MAX_PUBLICATION_IMAGE_BASE64_LENGTH),
  mimeType: z.string().trim().toLowerCase().startsWith('image/').max(128),
  fileName: z.string().trim().max(128).default(''),
});

const trustedPublicationTestFieldsSchema = z
  .object({
    text: z.string().max(MAX_PUBLICATION_TEXT_LENGTH).default(''),
    imageEnabled: z.boolean().default(false),
    imageBase64: z.string().trim().max(MAX_PUBLICATION_IMAGE_BASE64_LENGTH).default(''),
    imageMimeType: z.string().trim().max(128).default(''),
    imageFileName: z.string().trim().max(128).default(''),
    images: z.array(trustedPublicationImageSchema).max(MAX_PUBLICATION_IMAGES).default([]),
    mediaType: z.enum(['image', 'video']).nullable().default(null),
    mediaPayload: z.record(z.string(), z.unknown()).nullable().default(null),
    mediaMimeType: z.string().trim().max(128).default(''),
    mediaFileName: z.string().trim().max(128).default(''),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    const images = resolveTrustedPublicationImages(value);
    const totalImageBase64Length = images.reduce((total, image) => total + image.base64.length, 0);
    if (totalImageBase64Length > MAX_PUBLICATION_IMAGES_TOTAL_BASE64_LENGTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['images'],
        message: 'Суммарный размер фото слишком большой.',
      });
    }

    const marker = readTrustedPublicationVideoMarker(value.mediaPayload);
    const hasVideoPayload = value.mediaType === 'video' && value.mediaPayload !== null;
    if (images.length > 0 && hasVideoPayload) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['images'],
        message: 'Добавьте либо до 10 фото, либо одно видео.',
      });
    }
    if (value.text.trim().length === 0 && images.length === 0 && !hasVideoPayload) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['text'],
        message: 'Введите текст, добавьте фото или видео.',
      });
    }
    if (!marker.present) {
      return;
    }
    if (value.mediaType !== 'video') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mediaType'],
        message: 'Внутренняя ссылка на видео повреждена.',
      });
    }
    if (marker.assetId !== null && marker.inlineBase64 !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mediaPayload'],
        message: 'Видео публикации повреждено.',
      });
    }
    if (marker.assetId === null && marker.inlineBase64 === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mediaPayload'],
        message: 'Видео публикации повреждено.',
      });
    }
    if (
      marker.inlineBase64 !== null &&
      marker.inlineBase64.length > MAX_PUBLICATION_VIDEO_BASE64_LENGTH
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        maximum: MAX_PUBLICATION_VIDEO_BASE64_LENGTH,
        origin: 'string',
        inclusive: true,
        path: ['mediaPayload', PUBLICATION_VIDEO_INLINE_BASE64_FIELD],
        message: 'Видео публикации слишком большое.',
      });
    }
    if (marker.hasUnexpectedFields) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mediaPayload'],
        message: 'Видео публикации повреждено.',
      });
    }
  });

type TrustedPublicationTestFields = z.infer<typeof trustedPublicationTestFieldsSchema>;

type TrustedPublicationVideoMarker = {
  present: boolean;
  assetId: string | null;
  inlineBase64: string | null;
  hasUnexpectedFields: boolean;
};

function resolveTrustedPublicationImages(value: {
  images: BroadcastImage[];
  imageBase64: string;
  imageMimeType: string;
  imageFileName: string;
}): BroadcastImage[] {
  if (value.images.length > 0) {
    return value.images;
  }
  if (!value.imageBase64) {
    return [];
  }
  return [
    {
      base64: value.imageBase64,
      mimeType: value.imageMimeType,
      fileName: value.imageFileName,
    },
  ];
}

function readTrustedPublicationVideoMarker(
  payload: Record<string, unknown> | null,
): TrustedPublicationVideoMarker {
  if (!payload) {
    return { present: false, assetId: null, inlineBase64: null, hasUnexpectedFields: false };
  }

  const hasAssetId = PUBLICATION_VIDEO_ASSET_ID_FIELD in payload;
  const hasInlineBase64 = PUBLICATION_VIDEO_INLINE_BASE64_FIELD in payload;
  const hasSourcePublicationId = PUBLICATION_VIDEO_SOURCE_PUBLICATION_ID_FIELD in payload;
  if (!hasAssetId && !hasInlineBase64 && !hasSourcePublicationId) {
    return { present: false, assetId: null, inlineBase64: null, hasUnexpectedFields: false };
  }

  const assetIdValue = payload[PUBLICATION_VIDEO_ASSET_ID_FIELD];
  const inlineBase64Value = payload[PUBLICATION_VIDEO_INLINE_BASE64_FIELD];
  const sourcePublicationIdValue = payload[PUBLICATION_VIDEO_SOURCE_PUBLICATION_ID_FIELD];
  const assetId = typeof assetIdValue === 'string' ? assetIdValue.trim() || null : null;
  const inlineBase64 =
    typeof inlineBase64Value === 'string' ? inlineBase64Value.trim() || null : null;
  const allowedField = hasAssetId
    ? PUBLICATION_VIDEO_ASSET_ID_FIELD
    : PUBLICATION_VIDEO_INLINE_BASE64_FIELD;

  return {
    present: true,
    assetId,
    inlineBase64,
    hasUnexpectedFields:
      Object.keys(payload).some(
        (key) =>
          key !== allowedField &&
          !(hasAssetId && key === PUBLICATION_VIDEO_SOURCE_PUBLICATION_ID_FIELD),
      ) ||
      (hasAssetId && typeof assetIdValue !== 'string') ||
      (hasInlineBase64 && typeof inlineBase64Value !== 'string') ||
      (hasSourcePublicationId &&
        (!hasAssetId ||
          typeof sourcePublicationIdValue !== 'string' ||
          !sourcePublicationIdValue.trim() ||
          sourcePublicationIdValue.trim().length > 256)),
  };
}

function maskTrustedPublicationImages(images: BroadcastImage[]): BroadcastImage[] {
  return images.map((image, index) => ({
    base64: `publication-test-image-${index + 1}`,
    mimeType: image.mimeType,
    fileName: image.fileName,
  }));
}

export function safeParseTrustedPublicationTestBroadcastRequest(
  body: unknown,
): { success: true; data: SendBroadcastRequest } | { success: false; error: z.ZodError } {
  const trustedFields = trustedPublicationTestFieldsSchema.safeParse(body);
  if (!trustedFields.success) {
    return trustedFields;
  }

  const value = trustedFields.data;
  const images = resolveTrustedPublicationImages(value);
  const maskedImages = maskTrustedPublicationImages(images);
  const marker = readTrustedPublicationVideoMarker(value.mediaPayload);
  const maskedBody = buildMaskedPublicBroadcastBody(value, maskedImages, marker.present);
  const publicRequest = sendBroadcastRequestSchema.safeParse(maskedBody);
  if (!publicRequest.success) {
    return publicRequest;
  }

  const restoredMedia = restoreTrustedPublicationMedia(value, images, marker.present);
  return {
    success: true,
    data: {
      ...publicRequest.data,
      text: value.text,
      ...restoredMedia,
    },
  };
}

function buildMaskedPublicBroadcastBody(
  value: TrustedPublicationTestFields,
  maskedImages: BroadcastImage[],
  hasVideoMarker: boolean,
): Record<string, unknown> {
  const firstImage = maskedImages[0];
  return {
    ...value,
    text: value.text.length > 2_000 ? 'Тест публикации' : value.text,
    imageEnabled: Boolean(firstImage),
    imageBase64: firstImage?.base64 ?? '',
    imageMimeType: firstImage?.mimeType ?? '',
    imageFileName: firstImage?.fileName ?? '',
    images: hasVideoMarker ? [] : maskedImages,
    mediaType: hasVideoMarker ? 'video' : maskedImages.length > 1 ? 'image' : value.mediaType,
    mediaPayload: hasVideoMarker
      ? { token: 'trusted-publication-test-video' }
      : maskedImages.length > 1
        ? { images: maskedImages }
        : value.mediaPayload,
  };
}

function restoreTrustedPublicationMedia(
  value: TrustedPublicationTestFields,
  images: BroadcastImage[],
  hasVideoMarker: boolean,
): Partial<
  Pick<
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
  >
> {
  if (hasVideoMarker) {
    return {
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      images: [],
      mediaType: 'video',
      mediaPayload: value.mediaPayload,
      mediaMimeType: value.mediaMimeType,
      mediaFileName: value.mediaFileName,
    };
  }

  if (images.length > 0) {
    const firstImage = images[0];
    return {
      imageEnabled: true,
      imageBase64: firstImage.base64,
      imageMimeType: firstImage.mimeType,
      imageFileName: firstImage.fileName,
      images,
      mediaType: images.length > 1 ? 'image' : null,
      mediaPayload: images.length > 1 ? { images } : null,
      mediaMimeType: '',
      mediaFileName: '',
    };
  }

  return {};
}
