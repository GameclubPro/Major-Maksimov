import { Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';

export const ADMIN_ROSTER_ACTIVE_REFRESH_MS = 24 * 60 * 60 * 1_000;
export const ADMIN_ROSTER_REFRESH_RETRY_MS = 5 * 60 * 1_000;

export type ChatAdminRosterSnapshot = {
  revision: string;
  completeProbeStartedAt: string | null;
  completedAt: string | null;
};

type QueryClient = Pick<PrismaService, '$queryRaw'>;

export async function hasNewerCompleteAdminRoster(
  client: QueryClient,
  chatId: string,
  probeStartedAt: Date,
): Promise<boolean> {
  const [row] = await client.$queryRaw<{ completeProbeStartedAt: Date | null }[]>(Prisma.sql`
    SELECT complete_probe_started_at AS "completeProbeStartedAt"
    FROM chat_admin_roster_states WHERE chat_id = ${chatId}
  `);
  return (row?.completeProbeStartedAt?.getTime() ?? 0) > probeStartedAt.getTime();
}

// FLAG: Call only under the parent Chat lock after reconciling a complete accepted roster.
export async function completeAdminRoster(
  client: QueryClient,
  chatId: string,
  probeStartedAt: Date,
): Promise<void> {
  await client.$queryRaw(Prisma.sql`
    INSERT INTO chat_admin_roster_states
      (chat_id, revision, complete_probe_started_at, completed_at, refresh_requested_at)
    VALUES (${chatId}, gen_random_uuid(), ${probeStartedAt},
      (clock_timestamp() AT TIME ZONE 'UTC'), NULL)
    ON CONFLICT (chat_id) DO UPDATE SET revision = gen_random_uuid(),
      complete_probe_started_at = EXCLUDED.complete_probe_started_at,
      completed_at = EXCLUDED.completed_at, refresh_requested_at = NULL
    WHERE chat_admin_roster_states.complete_probe_started_at IS NULL
      OR chat_admin_roster_states.complete_probe_started_at <= EXCLUDED.complete_probe_started_at
    RETURNING chat_id
  `);
}

// FLAG: Bot denial is not a complete empty human roster. Reconnection must bootstrap again.
export async function invalidateAdminRosterCompleteness(
  client: QueryClient,
  chatId: string,
): Promise<void> {
  await client.$queryRaw(Prisma.sql`
    UPDATE chat_admin_roster_states SET revision = gen_random_uuid(),
      complete_probe_started_at = NULL, completed_at = NULL, refresh_requested_at = NULL
    WHERE chat_id = ${chatId}
    RETURNING chat_id
  `);
}

// FLAG: Whole-list removal must invalidate completeness atomically under the same parent
// lock as settings grants and roster sync. A later reconnection requires a new full snapshot.
export async function clearChatAdminRoster(prisma: PrismaService, chatId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM chats WHERE id = ${chatId} FOR UPDATE
    `);
    if (locked.length !== 1) return;
    await tx.chatAdminAllowlist.deleteMany({ where: { chatId } });
    await invalidateAdminRosterCompleteness(tx, chatId);
  });
}

export async function claimActiveAdminRosterRefresh(
  client: QueryClient,
  chatId: string,
  requestedAt: Date,
): Promise<boolean> {
  const claimed = await client.$queryRaw<{ chatId: string }[]>(Prisma.sql`
    INSERT INTO chat_admin_roster_states (chat_id, revision, refresh_requested_at)
    SELECT id, gen_random_uuid(), ${requestedAt} FROM chats WHERE id = ${chatId}
    ON CONFLICT (chat_id) DO UPDATE SET refresh_requested_at = EXCLUDED.refresh_requested_at
    WHERE (chat_admin_roster_states.completed_at IS NULL
      OR chat_admin_roster_states.completed_at <= ${new Date(requestedAt.getTime() - ADMIN_ROSTER_ACTIVE_REFRESH_MS)})
      AND (chat_admin_roster_states.refresh_requested_at IS NULL
        OR chat_admin_roster_states.refresh_requested_at <= ${new Date(requestedAt.getTime() - ADMIN_ROSTER_REFRESH_RETRY_MS)})
    RETURNING chat_id AS "chatId"
  `);
  return claimed.some((row) => row.chatId === chatId);
}
