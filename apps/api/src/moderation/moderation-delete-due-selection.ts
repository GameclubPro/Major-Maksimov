import { Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';

export function buildDeleteDueEligibility(now: Date, rolloutFilter: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`
          ((intent."remote_delete_succeeded_at" IS NOT NULL AND intent."remote_delete_succeeded_bot_id" IS NOT NULL)
            OR (NOT EXISTS (SELECT 1 FROM "webhook_source_abandonments" held
              WHERE held."chat_id" = intent."chat_id" AND held."message_id" = intent."message_id") AND NOT EXISTS (SELECT 1 FROM "webhook_backlog_receipts" cancelled
              WHERE cancelled."chat_id" = intent."chat_id" AND cancelled."message_id" = intent."message_id")))
          AND intent."execute_at" <= ${now}
          AND intent."retention_owned" = FALSE
          AND intent."next_attempt_at" <= ${now}
          AND (
            intent."retry_until_at" > ${now}
            OR intent."remote_delete_succeeded_at" IS NOT NULL
            OR intent."remote_delete_succeeded_bot_id" IS NOT NULL
            OR intent."delete_dispatch_started_at" IS NOT NULL
            OR intent."delete_dispatch_started_bot_id" IS NOT NULL
          )
          AND ${rolloutFilter}
  `;
}

export function buildDeleteDueHeadQuery(
  now: Date,
  batchSize: number,
  rolloutFilter: Prisma.Sql,
): Prisma.Sql {
  const selectStatus = (status: Prisma.Sql, leaseFilter = Prisma.empty) => Prisma.sql`
        SELECT intent."id", intent."next_attempt_at", intent."created_at"
        FROM "moderation_delete_intents" intent
        WHERE intent."status" = ${status}
          AND ${buildDeleteDueEligibility(now, rolloutFilter)}
          ${leaseFilter}
        ORDER BY intent."next_attempt_at" ASC, intent."created_at" ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
    `;
  // FLAG: A fixed status lets the existing (status, next_attempt_at, execute_at)
  // index find each ordered prefix without sorting the whole mixed-status population.
  // Every lane keeps all eligibility/authority predicates. Locks are statement-local,
  // at most five batch prefixes; the head retains its original total batch cap.
  // FLAG: Interleave those bounded status prefixes so retained ambiguous effects
  // cannot occupy every slot ahead of new PENDING/RETRYABLE moderation deletes.
  // This schedules existing authority only; workers retain every claim and effect guard.
  return Prisma.sql`
      WITH pending AS MATERIALIZED (
        ${selectStatus(Prisma.sql`CAST('PENDING' AS "ModerationDeleteIntentStatus")`)}
      ), retryable AS MATERIALIZED (
        ${selectStatus(Prisma.sql`CAST('RETRYABLE' AS "ModerationDeleteIntentStatus")`)}
      ), waiting AS MATERIALIZED (
        ${selectStatus(Prisma.sql`CAST('WAITING_CAPABILITY' AS "ModerationDeleteIntentStatus")`)}
      ), ambiguous AS MATERIALIZED (
        ${selectStatus(Prisma.sql`CAST('AMBIGUOUS' AS "ModerationDeleteIntentStatus")`)}
      ), in_progress AS MATERIALIZED (
        ${selectStatus(
          Prisma.sql`CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")`,
          Prisma.sql`AND intent."lease_expires_at" < ${now}`,
        )}
      ), candidates AS (
        SELECT *, 0 AS lane FROM pending
        UNION ALL SELECT *, 1 AS lane FROM retryable
        UNION ALL SELECT *, 2 AS lane FROM waiting
        UNION ALL SELECT *, 3 AS lane FROM ambiguous
        UNION ALL SELECT *, 4 AS lane FROM in_progress
      ), ranked AS (
        SELECT *, row_number() OVER (
          PARTITION BY lane ORDER BY next_attempt_at, created_at, id
        ) AS lane_position
        FROM candidates
      )
      SELECT ranked."id"
      FROM ranked
      ORDER BY ranked.lane_position, ranked."next_attempt_at", ranked."created_at", ranked."id"
      LIMIT ${batchSize}
    `;
}

const CONTINUATION_STATUSES = [
  'PENDING',
  'RETRYABLE',
  'WAITING_CAPABILITY',
  'AMBIGUOUS',
  'IN_PROGRESS',
] as const;
type ContinuationStatus = (typeof CONTINUATION_STATUSES)[number];
type Cursor = { cutoff: Date; after?: { createdAt: Date; id: string } };
type RawCandidate = {
  id: string;
  createdAt: Date;
  lane: ContinuationStatus;
  eligible: boolean;
};

export class DeleteDueContinuation {
  private readonly cursors = new Map<ContinuationStatus, Cursor>();
  private firstLane = 0;

  async select(
    prisma: Pick<PrismaService, '$queryRaw'>,
    options: {
      now: Date;
      limit: number;
      rolloutFilter: Prisma.Sql;
      headIds: ReadonlySet<string>;
    },
  ): Promise<{ ids: Array<{ id: string }>; commit(): void }> {
    const { now, limit, rolloutFilter, headIds } = options;
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new Error('DELETE continuation requires a positive bounded budget');
    const lanes = CONTINUATION_STATUSES.map((status, index) => {
      const offset =
        (index - this.firstLane + CONTINUATION_STATUSES.length) % CONTINUATION_STATUSES.length;
      const quota =
        Math.floor(limit / CONTINUATION_STATUSES.length) +
        Number(offset < limit % CONTINUATION_STATUSES.length);
      return { status, quota, cursor: this.cursors.get(status) ?? { cutoff: now } };
    }).filter((lane) => lane.quota > 0);

    // FLAG: Raw status/creation prefixes are bounded BEFORE eligibility, reason
    // probes and SKIP LOCKED. The existing (status, created_at, id) index supplies
    // the seek even with tied clocks or a long ineligible/locked history.
    const pages = lanes.map(
      ({ status, quota, cursor }) => Prisma.sql`
      (SELECT source."id", source."created_at", ${status}::text AS lane
       FROM "moderation_delete_intents" source
       WHERE source."status" = CAST(${status} AS "ModerationDeleteIntentStatus")
         AND source."created_at" <= ${cursor.cutoff}
         ${
           cursor.after
             ? Prisma.sql`
           AND (source."created_at", source."id") >
             (${cursor.after.createdAt}, ${cursor.after.id})`
             : Prisma.empty
         }
       ORDER BY source."created_at", source."id"
       LIMIT ${quota})
    `,
    );
    const rows = await prisma.$queryRaw<RawCandidate[]>(Prisma.sql`
      WITH raw AS MATERIALIZED (${Prisma.join(pages, ' UNION ALL ')})
      SELECT raw."id", raw."created_at" AS "createdAt", raw.lane,
        COALESCE(candidate.eligible, FALSE) AS eligible
      FROM raw
      LEFT JOIN LATERAL (
        SELECT TRUE AS eligible
        FROM "moderation_delete_intents" intent
        WHERE intent."id" = raw."id"
          AND intent."status" = CAST(raw.lane AS "ModerationDeleteIntentStatus")
          AND ${buildDeleteDueEligibility(now, rolloutFilter)}
          AND (intent."status" <> CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
            OR intent."lease_expires_at" < ${now})
        FOR UPDATE OF intent SKIP LOCKED
      ) candidate ON TRUE
      ORDER BY raw.lane, raw."created_at", raw."id"
    `);
    const ids = rows
      .filter((row) => row.eligible && !headIds.has(row.id))
      .map(({ id }) => ({ id }));
    let committed = false;
    return {
      ids,
      commit: () => {
        if (committed) return;
        committed = true;
        // FLAG: Advance only after all handoff attempts settle. A rejected add
        // stays durable/due and is revisited after wrap; it must not block other
        // chats/lanes. Every eligible row fits the budget, with no final truncation.
        // Ineligible/head/locked rows also advance; a fixed horizon forces wrap.
        for (const { status, quota, cursor } of lanes) {
          const page = rows.filter((row) => row.lane === status);
          const last = page.at(-1);
          if (last && page.length === quota) {
            this.cursors.set(status, {
              cutoff: cursor.cutoff,
              after: { createdAt: last.createdAt, id: last.id },
            });
          } else {
            this.cursors.delete(status);
          }
        }
        this.firstLane = (this.firstLane + 1) % CONTINUATION_STATUSES.length;
      },
    };
  }
}
