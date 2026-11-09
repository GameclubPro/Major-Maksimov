import { Prisma } from '../prisma/prisma-client';

type CleanupScope = { now: Date } & (
  | { limit: number; publicationId?: never }
  | { publicationId: string; limit?: never }
);

function staleOccurrenceScope(scope: CleanupScope): Prisma.Sql {
  if (scope.publicationId !== undefined) {
    return Prisma.sql`po."publication_id" = ${scope.publicationId}
      AND po."scheduled_at" < ${scope.now}`;
  }
  return Prisma.sql`(
    po."schedule_revision" <> ps."revision"
    OR ps."status" IN (
      'DRAFT'::"PublicationScheduleStatus",
      'COMPLETED'::"PublicationScheduleStatus",
      'CANCELED'::"PublicationScheduleStatus"
    )
    OR p."lifecycle" IN (
      'DRAFT'::"PublicationLifecycle",
      'COMPLETED'::"PublicationLifecycle",
      'CANCELED'::"PublicationLifecycle"
    )
    OR (ps."status" = 'PAUSED'::"PublicationScheduleStatus"
      AND po."scheduled_at" < ${scope.now})
  )`;
}

function untouchedOccurrenceExecution(): Prisma.Sql {
  return Prisma.sql`
    NOT EXISTS (
      SELECT 1 FROM "managed_broadcast_deliveries" AS d
      WHERE d."publication_occurrence_id" = po."id"
        AND (
          d."attempt_count" > 0 OR d."locked_at" IS NOT NULL
          OR d."lock_token" IS NOT NULL OR d."remote_message_id" IS NOT NULL
          OR d."sent_at" IS NOT NULL OR d."legacy_sent_without_remote_id" = TRUE
          OR d."post_actions_token" IS NOT NULL
          OR d."status" IN (
            'SENDING'::"ManagedBroadcastDeliveryStatus",
            'SENT'::"ManagedBroadcastDeliveryStatus",
            'AMBIGUOUS'::"ManagedBroadcastDeliveryStatus"
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1 FROM "managed_broadcasts" AS envelope
      WHERE envelope."publication_occurrence_id" = po."id"
        AND (envelope."locked_at" IS NOT NULL OR envelope."lock_token" IS NOT NULL
          OR envelope."sent_count" > 0)
    )
  `;
}

export async function cancelUntouchedScheduledPublicationOccurrences(
  tx: Prisma.TransactionClient,
  scope: CleanupScope,
): Promise<void> {
  // FLAG: The caller owns the calendar fence. Apply both stale and untouched predicates
  // before LIMIT, then lock envelopes before occurrence writes, matching worker claims.
  // Manual pause/resume retains its full single-publication scope instead of truncating it.
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT po."id"
    FROM "publication_occurrences" AS po
    INNER JOIN "publication_schedules" AS ps ON ps."id" = po."schedule_id"
    INNER JOIN "publications" AS p ON p."id" = po."publication_id"
    WHERE po."status" = 'SCHEDULED'::"PublicationOccurrenceStatus"
      AND ${staleOccurrenceScope(scope)}
      AND ${untouchedOccurrenceExecution()}
    ORDER BY po."scheduled_at" ASC, po."id" ASC
    ${scope.limit === undefined ? Prisma.empty : Prisma.sql`LIMIT ${scope.limit}`}
  `);
  if (rows.length === 0) return;
  const ids = Prisma.join(rows.map((row) => row.id));
  // FLAG: This lock must not write updatedAt or a synthetic lease. A worker that wins
  // first retains its claim; the following statement takes a fresh snapshot after waiting.
  await tx.$queryRaw(Prisma.sql`
    SELECT envelope."id"
    FROM "managed_broadcasts" AS envelope
    WHERE envelope."publication_occurrence_id" IN (${ids})
    ORDER BY envelope."id" ASC
    FOR NO KEY UPDATE
  `);
  await tx.$executeRaw(Prisma.sql`
    UPDATE "publication_occurrences" AS po
    SET "status" = 'CANCELED'::"PublicationOccurrenceStatus", "updated_at" = CURRENT_TIMESTAMP
    FROM "publication_schedules" AS ps, "publications" AS p
    WHERE po."id" IN (${ids})
      AND ps."id" = po."schedule_id" AND p."id" = po."publication_id"
      AND po."status" = 'SCHEDULED'::"PublicationOccurrenceStatus"
      AND ${staleOccurrenceScope(scope)}
      AND ${untouchedOccurrenceExecution()}
  `);
}
