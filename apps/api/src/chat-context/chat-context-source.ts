import { Prisma, type ChatSettings } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';

export type ChatSettingsProof = { settingsId: string; revision: string | null };
export type ChatSettingsTemplate = { proof: ChatSettingsProof; settings: ChatSettings };
export type ChatContextSourceRow = {
  id: string;
  title: string;
  botId: string | null;
  primaryBotId: string | null;
  settings: ChatSettings | null;
  domains: { domain: string }[];
  admins: { userId: string }[];
  rules: { publishedUrl: string | null; publishedMessageId: string | null } | null;
};
export type ChatContextSourceResult = {
  row: ChatContextSourceRow | null;
  proof: ChatSettingsProof | null;
  mode: 'shell' | 'full';
};

export type ChatContextShell = {
  id: string;
  title: string;
  botId: string | null;
  primaryBotId: string | null;
  settingsId: string | null;
  settingsRevision: string | null;
  rulesPublishedUrl: string | null;
  rulesPublishedMessageId: string | null;
  adminUserIds: string[];
  domainAllowlist: string[];
};

export function chatContextShellQuery(chatId: string, sourceAt: Date): Prisma.Sql {
  return Prisma.sql`
    SELECT c.id, c.title, c.bot_id AS "botId", c.primary_bot_id AS "primaryBotId",
      s.id AS "settingsId", v.revision::text AS "settingsRevision",
      r.published_url AS "rulesPublishedUrl",
      r.published_message_id AS "rulesPublishedMessageId",
      COALESCE((SELECT jsonb_agg(a.user_id) FROM chat_admin_allowlist a
        WHERE a.chat_id = c.id), '[]'::jsonb) AS "adminUserIds",
      COALESCE((SELECT jsonb_agg(d.domain) FROM domain_allowlist d
        WHERE d.chat_id = c.id
          AND (d.remove_after_at IS NULL
            OR d.remove_after_at > ${sourceAt.toISOString()}::timestamp(3))),
        '[]'::jsonb) AS "domainAllowlist"
    FROM chats c
    LEFT JOIN chat_settings s ON s.chat_id = c.id
    LEFT JOIN chat_settings_cache_revisions v ON v.chat_id = s.chat_id
    LEFT JOIN chat_rules r ON r.chat_id = c.id
    WHERE c.id = ${chatId}
  `;
}

export async function readChatContextSource(
  prisma: PrismaService,
  chatId: string,
  sourceAt: Date,
  candidate: ChatSettingsTemplate | null,
): Promise<ChatContextSourceResult> {
  if (candidate) {
    // FLAG: A template has no freshness authority. One SQL snapshot must prove its exact
    // settings identity/version and refresh every mutable shell relation before reuse.
    const [shell] = await prisma.$queryRaw<ChatContextShell[]>(
      chatContextShellQuery(chatId, sourceAt),
    );
    if (
      shell?.settingsId === candidate.proof.settingsId &&
      shell.settingsRevision === candidate.proof.revision
    ) {
      return {
        row: {
          id: shell.id,
          title: shell.title,
          botId: shell.botId,
          primaryBotId: shell.primaryBotId,
          settings: candidate.settings,
          domains: shell.domainAllowlist.map((domain) => ({ domain })),
          admins: shell.adminUserIds.map((userId) => ({ userId })),
          rules: {
            publishedUrl: shell.rulesPublishedUrl,
            publishedMessageId: shell.rulesPublishedMessageId,
          },
        },
        proof: { settingsId: shell.settingsId, revision: shell.settingsRevision },
        mode: 'shell',
      };
    }
  }

  // FLAG: Prisma may load relations in separate statements. Bind settings content,
  // its UUID proof and the complete shell to the same RepeatableRead snapshot.
  return prisma.$transaction(
    async (tx) => {
      const chat = await tx.chat.findUnique({
        where: { id: chatId },
        include: {
          settings: { include: { cacheRevision: true } },
          rules: { select: { publishedUrl: true, publishedMessageId: true } },
          domains: {
            where: { OR: [{ removeAfterAt: null }, { removeAfterAt: { gt: sourceAt } }] },
            select: { domain: true },
          },
          admins: { select: { userId: true } },
        },
      });
      if (!chat) return { row: null, proof: null, mode: 'full' };
      let settings: ChatSettings | null = null;
      let proof: ChatSettingsProof | null = null;
      if (chat.settings) {
        const { cacheRevision, ...scalars } = chat.settings;
        settings = scalars;
        proof = { settingsId: chat.settings.id, revision: cacheRevision?.revision ?? null };
      }
      return {
        row: {
          id: chat.id,
          title: chat.title,
          botId: chat.botId,
          primaryBotId: chat.primaryBotId,
          settings,
          domains: chat.domains,
          admins: chat.admins,
          rules: chat.rules,
        },
        proof,
        mode: 'full',
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
