import type { PublicationMediaInput } from '@maxim/contracts/publication';
import { ConflictException } from '@nestjs/common';
import { Prisma } from '../prisma/prisma-client';
import { publicationAdminAccessWhere, publicationAdminScope } from './publication-admin-access';

type StoredRevision = {
  assets?: ReadonlyArray<{ asset: { mimeType: string; durablePayload?: unknown } }>;
};

// FLAG: A still-open older editor keeps just its first video when rebuilding a draft.
export const publicationAlbumMediaSelect = {
  take: 10,
  orderBy: { position: 'asc' },
  select: { asset: { select: { mimeType: true, durablePayload: true } } },
} as const;

export function requirePublicationAlbumEditor(
  version: 2 | undefined,
  revision?: StoredRevision | null,
) {
  const assets = revision?.assets;
  if (version === 2 || !assets || assets.length < 2) return;
  if (
    assets.some(
      ({ asset }) =>
        asset.durablePayload != null || asset.mimeType.toLowerCase().startsWith('video/'),
    )
  ) {
    throw new ConflictException({
      code: 'PUBLICATION_ALBUM_CLIENT_UPDATE_REQUIRED',
      message: 'Обновите Публик и откройте публикацию ещё раз, чтобы сохранить все вложения.',
    });
  }
}

export async function requireCompatiblePublicationCopy(
  tx: Pick<Prisma.TransactionClient, 'publication'>,
  actorUserId: string,
  version: 2 | undefined,
  media: readonly PublicationMediaInput[],
  currentPublicationId?: string,
) {
  if (version === 2) return;
  const references = media.flatMap((item) =>
    (item.type === 'video-ref' || item.type === 'image-ref') &&
    item.sourcePublicationId &&
    item.sourcePublicationId !== currentPublicationId
      ? [
          {
            id: item.sourcePublicationId,
            canonicalContentRevision: { assets: { some: { assetId: item.assetId } } },
          },
        ]
      : [],
  );
  if (!references.length) return;
  const scope = publicationAdminScope(actorUserId);
  const sources = await tx.publication.findMany({
    where: {
      AND: [
        publicationAdminAccessWhere(scope, 'PUBLIK_V1', 'read'),
        { requiredBotId: scope.publisherBotId, OR: references },
      ],
    },
    take: references.length,
    select: { canonicalContentRevision: { select: { assets: publicationAlbumMediaSelect } } },
  });
  for (const source of sources)
    requirePublicationAlbumEditor(version, source.canonicalContentRevision);
}
