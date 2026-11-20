import {
  MAX_PUBLICATION_SERVER_DRAFTS,
  MAX_PUBLICATION_DRAFT_STORAGE_BYTES,
} from '@maxim/contracts/publication-draft';
import { BadRequestException } from '@nestjs/common';
import { Prisma } from '../prisma/prisma-client';
import { publicationAssetReferenceWhere } from './publication-asset-access';
import type { PreparedPublicationContentRevision } from './publication-content.service';

export class PublicationDraftQuotaError extends BadRequestException {}

export async function lockPublicationDraftQuota(tx: Prisma.TransactionClient, actorUserId: string) {
  await tx.$executeRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`publication-drafts:${actorUserId}`}))`,
  );
}

export async function assertPublicationDraftQuota(
  tx: Prisma.TransactionClient,
  actorUserId: string,
  excludeId: string | null,
  content: PreparedPublicationContentRevision,
  actingActorUserId = actorUserId,
) {
  const drafts = await tx.publication.findMany({
    where: {
      actorUserId,
      dispatchProfile: 'PUBLIK_V1',
      lifecycle: 'DRAFT',
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    take: MAX_PUBLICATION_SERVER_DRAFTS + 1,
    select: {
      canonicalContentRevision: {
        select: { assets: { select: { asset: { select: { sizeBytes: true } } } } },
      },
    },
  });
  if (drafts.length >= MAX_PUBLICATION_SERVER_DRAFTS)
    throw new PublicationDraftQuotaError(
      `Можно сохранить до ${MAX_PUBLICATION_SERVER_DRAFTS} черновиков.`,
    );
  const referencesToResolve = content.assets.filter((asset) => asset.kind === 'reference');
  // FLAG: One asset cannot appear with two source hints and let a valid pair authorize
  // its unrelated sibling. The final content writer also rejects duplicate links.
  if (
    new Set(referencesToResolve.map((asset) => asset.assetId)).size !== referencesToResolve.length
  )
    throw new BadRequestException('Один и тот же медиафайл добавлен несколько раз.');
  const references = referencesToResolve.length
    ? await tx.publicationAsset.findMany({
        where: {
          OR: referencesToResolve.map((asset) =>
            publicationAssetReferenceWhere(actingActorUserId, asset, excludeId ?? undefined),
          ),
        },
        select: { id: true, sizeBytes: true },
      })
    : [];
  if (references.length !== referencesToResolve.length)
    throw new BadRequestException('Медиа черновика недоступно.');
  const bytes =
    drafts.reduce(
      (total, draft) =>
        total +
        (draft.canonicalContentRevision?.assets.reduce(
          (sum, link) => sum + link.asset.sizeBytes,
          0,
        ) ?? 0),
      0,
    ) +
    content.assets.reduce(
      (total, asset) =>
        total +
        (asset.kind === 'prepared'
          ? asset.sizeBytes
          : references.find((ref) => ref.id === asset.assetId)!.sizeBytes),
      0,
    );
  if (bytes > MAX_PUBLICATION_DRAFT_STORAGE_BYTES)
    throw new PublicationDraftQuotaError(
      'Медиа черновиков превышают 128 МБ. Удалите ненужные черновики.',
    );
}
