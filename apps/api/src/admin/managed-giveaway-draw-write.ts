import { type GiveawayEligibilityState, Prisma } from '../prisma/prisma-client';

export type GiveawayDrawEntryUpdate = {
  id: string;
  eligibilityState: GiveawayEligibilityState;
  eligibilityReason: string | null;
  missingChannelIds: readonly string[];
  drawRank: string | null;
};

const DRAW_WRITE_BATCH_SIZE = 1_000;

export async function writeGiveawayDrawEntries(
  tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
  giveawayId: string,
  entries: readonly GiveawayDrawEntryUpdate[],
  checkedAt: Date,
): Promise<void> {
  // FLAG: The caller holds the exact parent draw lease throughout this transaction.
  // An incomplete batch must roll back every update and the winner selection.
  for (let start = 0; start < entries.length; start += DRAW_WRITE_BATCH_SIZE) {
    const batch = entries.slice(start, start + DRAW_WRITE_BATCH_SIZE);
    const count = await tx.$executeRaw(Prisma.sql`
      UPDATE managed_giveaway_entries AS entry
      SET eligibility_state = CAST(next."eligibilityState" AS "GiveawayEligibilityState"),
        eligibility_reason = next."eligibilityReason", missing_channel_ids = next."missingChannelIds",
        draw_rank = next."drawRank", checked_at = ${checkedAt}, updated_at = ${checkedAt}
      FROM jsonb_to_recordset(CAST(${JSON.stringify(batch)} AS jsonb)) AS next(
        id text, "eligibilityState" text, "eligibilityReason" text, "missingChannelIds" jsonb, "drawRank" text
      )
      WHERE entry.giveaway_id = ${giveawayId} AND entry.id = next.id
    `);
    if (count !== batch.length) throw new Error('Giveaway entry set changed during draw');
  }
}
