import { Prisma } from '../prisma/prisma-client';

export type DeleteWakeupDisposition =
  | 'missing'
  | 'settled'
  | 'retentionOwned'
  | 'scheduled'
  | 'leased'
  | 'expiryChecked'
  | 'attempted';

export function createDeleteWakeupCounters() {
  return {
    calls: 0,
    missing: 0,
    settled: 0,
    retentionOwned: 0,
    scheduled: 0,
    leased: 0,
    expiryChecked: 0,
    attempted: 0,
    errors: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
  };
}

export function buildDeleteWakeupQuery(intentId: string): Prisma.Sql {
  // FLAG: This exact-key observation grants no execution authority. Skipped wakeups
  // remain recoverable from SQL; the ordinary attempt reloads every guard and claims
  // the current lease. Do not load reason inventories for retained terminal jobs.
  return Prisma.sql`
    SELECT CASE
      WHEN "status" IN ('OBSERVED', 'SUCCEEDED', 'ALREADY_ABSENT', 'EXPIRED', 'FAILED_TERMINAL')
        THEN 'settled'
      WHEN "retention_owned" THEN 'retentionOwned'
      WHEN "execute_at" > CURRENT_TIMESTAMP OR "next_attempt_at" > CURRENT_TIMESTAMP
        THEN 'scheduled'
      WHEN "status" = 'IN_PROGRESS'
        AND ("lease_expires_at" IS NULL OR "lease_expires_at" >= CURRENT_TIMESTAMP)
        THEN 'leased'
      WHEN "status" IN ('PENDING', 'RETRYABLE', 'WAITING_CAPABILITY', 'AMBIGUOUS')
        AND "retry_until_at" <= CURRENT_TIMESTAMP
        AND "remote_delete_succeeded_at" IS NULL
        AND "remote_delete_succeeded_bot_id" IS NULL
        AND "delete_dispatch_started_at" IS NULL
        AND "delete_dispatch_started_bot_id" IS NULL
        THEN 'expiryChecked'
      ELSE 'attempted'
    END AS disposition
    FROM "moderation_delete_intents" WHERE "id" = ${intentId}
  `;
}

export async function processQueuedDeleteWakeup(
  prisma: { $queryRaw<T>(query: Prisma.Sql): Promise<T> },
  intentId: string,
  attempt: () => Promise<unknown>,
  expire: () => Promise<void>,
): Promise<DeleteWakeupDisposition> {
  const [row] = await prisma.$queryRaw<Array<{ disposition: DeleteWakeupDisposition }>>(
    buildDeleteWakeupQuery(intentId),
  );
  if (!row) return 'missing';
  if (row.disposition === 'expiryChecked') {
    // FLAG: The original conditional expiry writer rechecks markers, status,
    // retention ownership and source holds. Its no-op is not successful expiry.
    await expire();
  } else if (row.disposition === 'attempted') {
    await attempt();
  }
  return row.disposition;
}

export function expiredAutoDeleteVerificationDelay(retryUntilAt: Date, nowMs: number): number {
  const hour = 3_600_000;
  const expiredForMs = Math.max(0, nowMs - retryUntilAt.getTime());
  // FLAG: Only the caller's locked, expired, auto-delete-only positive receipt
  // may use this floor. Keep evidence/deadlines and any longer existing retry hint.
  return Math.min(24 * hour, hour * 2 ** Math.min(5, Math.floor(expiredForMs / (6 * hour))));
}
