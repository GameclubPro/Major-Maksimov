import { Prisma } from '../prisma/prisma-client';

export const MANAGED_GIVEAWAY_DUE_FAMILIES = [
  'scheduledStart',
  'scheduledEnd',
  'activeEnd',
  'drawingEnd',
] as const;

export type ManagedGiveawayDueFamily = (typeof MANAGED_GIVEAWAY_DUE_FAMILIES)[number];
export type ManagedGiveawayDueCursor = { dueAt: Date; id: string };
export type ManagedGiveawayDueRow = {
  id: string;
  sourceChatId: string;
  lockedAt: Date | null;
  dueAt: Date;
};

const DUE_FAMILY_QUERIES = {
  scheduledStart: { status: 'SCHEDULED', dueAt: Prisma.sql`source."starts_at"` },
  scheduledEnd: { status: 'SCHEDULED', dueAt: Prisma.sql`source."ends_at"` },
  activeEnd: { status: 'ACTIVE', dueAt: Prisma.sql`source."ends_at"` },
  drawingEnd: { status: 'DRAWING', dueAt: Prisma.sql`source."ends_at"` },
} as const satisfies Record<ManagedGiveawayDueFamily, { status: string; dueAt: Prisma.Sql }>;

export function buildManagedGiveawayDuePageQuery(options: {
  family: ManagedGiveawayDueFamily;
  cutoff: Date;
  after: ManagedGiveawayDueCursor | null;
  take: number;
}): Prisma.Sql {
  if (!Number.isSafeInteger(options.take) || options.take < 1 || options.take > 20) {
    throw new Error('Managed giveaway due pages require an integer take between 1 and 20');
  }
  if (!Object.hasOwn(DUE_FAMILY_QUERIES, options.family)) {
    throw new Error('Unknown managed giveaway due family');
  }
  const family = DUE_FAMILY_QUERIES[options.family];

  // FLAG: Materialize an indexed raw prefix before lock/access/Redis filtering.
  // Tuple seeks retain progress through tied timestamps and deleted anchors;
  // final reloads and claims still own every transition and outbound effect.
  return Prisma.sql`
    SELECT source."id", source."source_chat_id" AS "sourceChatId",
      source."locked_at" AS "lockedAt", ${family.dueAt} AS "dueAt"
    FROM "managed_giveaways" source
    WHERE source."status" = CAST(${family.status} AS "ManagedGiveawayStatus")
      AND ${family.dueAt} <= ${options.cutoff}
      ${
        options.after
          ? Prisma.sql`AND (${family.dueAt}, source."id") >
              (${options.after.dueAt}, ${options.after.id})`
          : Prisma.empty
      }
    ORDER BY ${family.dueAt}, source."id"
    LIMIT ${options.take}
  `;
}
