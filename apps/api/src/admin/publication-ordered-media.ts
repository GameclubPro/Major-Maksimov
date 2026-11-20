import type { BroadcastImage, SendBroadcastRequest } from '@maxim/contracts';
import {
  MAX_PUBLICATION_IMAGE_BASE64_LENGTH,
  MAX_PUBLICATION_MEDIA,
} from '@maxim/contracts/publication';
import { z } from 'zod';

export const publicationTestAlbumSchema = z
  .array(
    z.discriminatedUnion('type', [
      z
        .object({
          type: z.literal('image'),
          base64: z.string().min(1).max(MAX_PUBLICATION_IMAGE_BASE64_LENGTH),
          mimeType: z.string().max(128),
          fileName: z.string().max(128),
        })
        .strict(),
      z
        .object({
          type: z.literal('video'),
          payload: z.record(z.string(), z.unknown()),
          mimeType: z.string().max(128),
          fileName: z.string().max(128),
        })
        .strict(),
    ]),
  )
  .min(2)
  .max(MAX_PUBLICATION_MEDIA);

export type PublicationTestMedia = z.infer<typeof publicationTestAlbumSchema>[number];
export type PublicationTestPayload = SendBroadcastRequest & {
  publicationTestAlbum?: PublicationTestMedia[];
};

export function publicationTestMediaFields(item: PublicationTestMedia) {
  const image: BroadcastImage | undefined =
    item.type === 'image'
      ? { base64: item.base64, mimeType: item.mimeType, fileName: item.fileName }
      : undefined;
  return {
    imageEnabled: Boolean(image),
    imageBase64: image?.base64 ?? '',
    imageMimeType: image?.mimeType ?? '',
    imageFileName: image?.fileName ?? '',
    images: image ? [image] : [],
    mediaType: item.type === 'video' ? ('video' as const) : null,
    mediaPayload: item.type === 'video' ? item.payload : null,
    mediaMimeType: item.type === 'video' ? item.mimeType : '',
    mediaFileName: item.type === 'video' ? item.fileName : '',
  };
}
