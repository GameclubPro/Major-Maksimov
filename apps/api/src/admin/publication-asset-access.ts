import { Prisma } from '../prisma/prisma-client';
import { publicationAdminAccessWhere, publicationAdminScope } from './publication-admin-access';
import { PUBLICATION_UPLOADED_VIDEO_FIELD } from './publication-video-media';

export type PublicationAssetReference = {
  assetId: string;
  expectedType: 'image' | 'video';
  sourcePublicationId?: string;
};

export function publicationUploadedVideoWhere(botId: string): Prisma.PublicationAssetWhereInput {
  return {
    bytes: null,
    mimeType: { startsWith: 'video/' },
    AND: [
      { durablePayload: { path: [PUBLICATION_UPLOADED_VIDEO_FIELD, 'version'], equals: 1 } },
      { durablePayload: { path: [PUBLICATION_UPLOADED_VIDEO_FIELD, 'botId'], equals: botId } },
    ],
  };
}

export function publicationAssetSourceWhere(
  actorUserId: string,
  publicationId: string,
  mode: 'read' | 'manage',
): Prisma.PublicationAssetWhereInput {
  const scope = publicationAdminScope(actorUserId);
  return {
    contentLinks: {
      some: {
        contentRevision: {
          publication: {
            id: publicationId,
            ...(mode === 'read' ? { requiredBotId: scope.publisherBotId } : {}),
            ...publicationAdminAccessWhere(scope, 'PUBLIK_V1', mode),
          },
        },
      },
    },
  };
}

// FLAG: A source ID is only a lookup hint. Reuse requires this exact asset link and
// current Publisher SQL authority; keep each asset/source pair together in batch reads.
export function publicationAssetReferenceWhere(
  actorUserId: string,
  reference: PublicationAssetReference,
  publicationId?: string,
): Prisma.PublicationAssetWhereInput {
  const owned = {
    actorUserId,
    contentLinks: { some: { contentRevision: { publication: { actorUserId } } } },
  } satisfies Prisma.PublicationAssetWhereInput;
  const alternatives: Prisma.PublicationAssetWhereInput[] = [owned];
  if (reference.expectedType === 'video') {
    alternatives.push({
      actorUserId,
      ...publicationUploadedVideoWhere(publicationAdminScope(actorUserId).publisherBotId),
    });
  }
  if (publicationId)
    alternatives.push(publicationAssetSourceWhere(actorUserId, publicationId, 'manage'));
  if (reference.sourcePublicationId && reference.sourcePublicationId !== publicationId)
    alternatives.push(
      publicationAssetSourceWhere(actorUserId, reference.sourcePublicationId, 'read'),
    );
  return alternatives.length === 1
    ? { id: reference.assetId, ...owned }
    : { id: reference.assetId, OR: alternatives };
}
