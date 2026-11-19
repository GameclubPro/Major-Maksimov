import { managedGiveawaySummarySchema, type ManagedGiveawaySummary } from '@maxim/contracts';
import { type ChatEntityType, Prisma } from '../prisma/prisma-client';

const visibleGiveawayFields = {
  id: true,
  sourceChatId: true,
  entityType: true,
  status: true,
  startsAt: true,
  endsAt: true,
  requiredChannelIds: true,
  publishedAt: true,
  publicationMessageId: true,
  publicationUrl: true,
  resultsMessageId: true,
  resultsUrl: true,
  prizes: { orderBy: { position: 'asc' } },
} as const satisfies Prisma.ManagedGiveawaySelect;

const activeWinners = {
  where: { status: { not: 'REROLLED' } },
  include: { prize: true, entry: true },
  orderBy: [{ rank: 'asc' }, { id: 'asc' }],
} as const satisfies Prisma.ManagedGiveawayWinnerFindManyArgs;

const publicSelect = {
  ...visibleGiveawayFields,
  title: true,
  description: true,
  claimHours: true,
  completedAt: true,
  winners: activeWinners,
  _count: { select: { entries: { where: { eligibilityState: { not: 'REJECTED' } } } } },
} as const satisfies Prisma.ManagedGiveawaySelect;

export type PublicGiveawayRead = Prisma.ManagedGiveawayGetPayload<{ select: typeof publicSelect }>;

export function readPublicGiveaway(
  db: Pick<Prisma.TransactionClient, 'managedGiveaway'>,
  id: string,
) {
  return db.managedGiveaway.findUnique({ where: { id }, select: publicSelect });
}

export function readGiveawayParticipant(
  db: Pick<Prisma.TransactionClient, 'managedGiveaway'>,
  id: string,
  userId: string,
) {
  return db.managedGiveaway.findUnique({
    where: { id },
    select: {
      ...visibleGiveawayFields,
      entries: { where: { userId }, take: 1 },
      winners: {
        where: { status: { not: 'REROLLED' }, entry: { userId } },
        include: { prize: true },
        take: 1,
      },
    },
  });
}
export type ParticipantGiveawayRead = NonNullable<
  Awaited<ReturnType<typeof readGiveawayParticipant>>
>;

export const GIVEAWAY_NOTIFICATION_INCLUDE = {
  winner: {
    include: {
      giveaway: {
        select: {
          id: true,
          sourceChatId: true,
          title: true,
          publicationUrl: true,
          resultsUrl: true,
          prizes: { orderBy: { position: 'asc' } },
        },
      },
      prize: true,
      entry: true,
    },
  },
} as const satisfies Prisma.ManagedGiveawayWinnerNotificationInclude;

type HistoryDates =
  | 'startsAt'
  | 'endsAt'
  | 'publishedAt'
  | 'completedAt'
  | 'createdAt'
  | 'updatedAt';
type HistoryRow = Omit<ManagedGiveawaySummary, HistoryDates> & {
  startsAt: Date | null;
  endsAt: Date;
  publishedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type GiveawayHistoryCursor = { createdAt: Date; id: string };

export async function readGiveawayHistoryPage(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  sourceChatId: string,
  entityType: ChatEntityType,
  options: { take?: number; before?: GiveawayHistoryCursor | null } = {},
): Promise<ManagedGiveawaySummary[]> {
  const take = options.take ?? 30;
  if (!Number.isSafeInteger(take) || take < 1 || take > 100) {
    throw new Error('Giveaway history page size must be between 1 and 100');
  }
  const before = options.before;
  const rows = await db.$queryRaw<HistoryRow[]>(Prisma.sql`
    WITH page AS MATERIALIZED (
      SELECT id, title, status, image_enabled, starts_at, ends_at, published_at,
        completed_at, publication_url, results_url, created_at, updated_at
      FROM managed_giveaways
      WHERE archived_at IS NULL AND source_chat_id = ${sourceChatId} AND entity_type = CAST(${entityType} AS "ChatEntityType")
        ${before ? Prisma.sql`AND (created_at, id) < (${before.createdAt}, ${before.id})` : Prisma.empty}
      ORDER BY created_at DESC, id DESC
      LIMIT ${take}
    )
    SELECT p.id, p.title, p.status, p.image_enabled AS "hasImage",
      p.starts_at AS "startsAt", p.ends_at AS "endsAt", p.published_at AS "publishedAt",
      p.completed_at AS "completedAt", p.publication_url AS "publicationUrl",
      p.results_url AS "resultsUrl", p.created_at AS "createdAt", p.updated_at AS "updatedAt",
      e."entriesCount", e."verifiedEntriesCount", e."pendingEntriesCount", w."winnersCount"
    FROM page p
    CROSS JOIN LATERAL (
      SELECT count(*)::double precision AS "entriesCount",
        (count(*) FILTER (WHERE e.eligibility_state = 'VERIFIED'))::double precision AS "verifiedEntriesCount",
        (count(*) FILTER (WHERE e.eligibility_state = 'PENDING'))::double precision AS "pendingEntriesCount"
      FROM managed_giveaway_entries e WHERE e.giveaway_id = p.id
    ) e
    CROSS JOIN LATERAL (
      SELECT count(*)::double precision AS "winnersCount" FROM managed_giveaway_winners w
      WHERE w.giveaway_id = p.id AND w.status <> 'REROLLED'
    ) w
    ORDER BY p.created_at DESC, p.id DESC
  `);
  return rows.map((row) =>
    managedGiveawaySummarySchema.parse({
      ...row,
      startsAt: row.startsAt?.toISOString() ?? null,
      endsAt: row.endsAt.toISOString(),
      publishedAt: row.publishedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }),
  );
}
