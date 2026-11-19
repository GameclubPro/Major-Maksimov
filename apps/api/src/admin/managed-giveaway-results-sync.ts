import { randomUUID } from 'node:crypto';
import type { Prisma } from '../prisma/prisma-client';

type ResultsStore = Pick<Prisma.TransactionClient, 'managedGiveawayResultsSync'>;
// FLAG: Deploy the compatible reader before enabling creation of new durable intents.
export const MANAGED_GIVEAWAY_RESULTS_SYNC_ACTIVATED = false;
const LEASE_MS = 120_000;
const RETRY_BASE_MS = 30_000;
const MAX_RETRY_MS = 30 * 60_000;

export async function enqueueGiveawayResultsSync(
  tx: ResultsStore,
  giveawayId: string,
  { allowCreate = true }: { allowCreate?: boolean } = {},
): Promise<void> {
  const dueAt = new Date();
  // FLAG: Revision and winner changes commit together. A writer must never clear a worker's lease.
  const update = { revision: { increment: 1 }, attempts: 0, nextAttemptAt: dueAt };
  if (!allowCreate) {
    // A rollback reader still maintains obligations created by the activated release.
    await tx.managedGiveawayResultsSync.updateMany({ where: { giveawayId }, data: update });
    return;
  }
  await tx.managedGiveawayResultsSync.upsert({
    where: { giveawayId },
    create: { giveawayId, revision: 1, nextAttemptAt: dueAt },
    update,
  });
}

class ResultsLeaseLost extends Error {}

export async function processGiveawayResultsSync(
  db: ResultsStore,
  giveawayId: string,
  publish: (assertCurrent: () => Promise<void>) => Promise<boolean>,
  { publishWithoutIntent }: { publishWithoutIntent?: () => Promise<boolean> } = {},
): Promise<boolean> {
  const store = db.managedGiveawayResultsSync;
  const eligible = { giveawayId, giveaway: { status: 'COMPLETED', archivedAt: null } } as const;
  const intent = await store.findFirst({
    where: eligible,
    select: { revision: true, nextAttemptAt: true, attempts: true },
  });
  if (!intent) return (await publishWithoutIntent?.()) ?? false;
  if (!intent.nextAttemptAt) return true;

  const now = new Date();
  if (intent.nextAttemptAt > now) return false;
  const revision = intent.revision;
  const leaseToken = randomUUID();
  const leaseUntil = new Date(now.getTime() + LEASE_MS);
  const claimed = await store.updateMany({
    where: {
      ...eligible,
      revision,
      nextAttemptAt: { lte: now },
      OR: [{ leaseToken: null }, { leaseUntil: { lte: now } }],
    },
    data: { leaseToken, leaseUntil, nextAttemptAt: leaseUntil, attempts: { increment: 1 } },
  });
  if (!claimed.count) return false;

  const owned = { ...eligible, revision, leaseToken };
  const assertCurrent = async () => {
    const checkedAt = new Date();
    const renewedUntil = new Date(checkedAt.getTime() + LEASE_MS);
    const checked = await store.updateMany({
      where: { ...owned, leaseUntil: { gt: checkedAt } },
      data: { leaseUntil: renewedUntil, nextAttemptAt: renewedUntil },
    });
    if (!checked.count) throw new ResultsLeaseLost('Giveaway results revision or lease changed');
  };

  let complete = false;
  try {
    await assertCurrent();
    if (!(await publish(assertCurrent))) return false;
    // FLAG: Only the owner of the exact published revision may certify synchronization.
    const confirmed = await store.updateMany({
      where: { ...owned, leaseUntil: { gt: new Date() } },
      data: { nextAttemptAt: null, leaseToken: null, leaseUntil: null, attempts: 0 },
    });
    complete = confirmed.count === 1;
    return complete;
  } catch (error: unknown) {
    if (error instanceof ResultsLeaseLost) return false;
    throw error;
  } finally {
    if (!complete) {
      const delay = Math.min(MAX_RETRY_MS, RETRY_BASE_MS * 2 ** Math.min(intent.attempts, 6));
      const deferred = await store.updateMany({
        where: owned,
        data: { nextAttemptAt: new Date(Date.now() + delay), leaseUntil: null, leaseToken: null },
      });
      if (!deferred.count) {
        // A newer revision keeps the due time its writer chose.
        await store.updateMany({
          where: { giveawayId, leaseToken },
          data: { leaseUntil: null, leaseToken: null },
        });
      }
    }
  }
}
