import { Prisma, type ChatSettings } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { ChatAdminRosterSnapshot } from '../max/chat-admin-roster-state';
import {
  CHAT_SETTINGS_SQL_PROJECTION,
  readProjectedChatSettings,
  type ChatSettingsProjection,
} from './chat-settings-projection';

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
  adminRosterState?: ChatAdminRosterSnapshot | null;
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
  adminRosterRevision: string | null;
  adminRosterCompleteProbeStartedAt: Date | null;
  adminRosterCompletedAt: Date | null;
};

export function chatContextShellQuery(chatId: string, sourceAt: Date): Prisma.Sql {
  return chatContextQuery(chatId, sourceAt, Prisma.empty);
}

export type ChatContextFullSource = ChatContextShell &
  ChatSettingsProjection & { rulesChatId: string | null };

export function chatContextFullQuery(chatId: string, sourceAt: Date): Prisma.Sql {
  return chatContextQuery(
    chatId,
    sourceAt,
    Prisma.sql`, r.chat_id AS "rulesChatId", ${CHAT_SETTINGS_SQL_PROJECTION}`,
  );
}

function chatContextQuery(
  chatId: string,
  sourceAt: Date,
  additionalProjection: Prisma.Sql,
): Prisma.Sql {
  return Prisma.sql`
    SELECT c.id, c.title, c.bot_id AS "botId", c.primary_bot_id AS "primaryBotId",
      s.id AS "settingsId", v.revision::text AS "settingsRevision",
      ar.revision::text AS "adminRosterRevision",
      ar.complete_probe_started_at AS "adminRosterCompleteProbeStartedAt",
      ar.completed_at AS "adminRosterCompletedAt",
      r.published_url AS "rulesPublishedUrl",
      r.published_message_id AS "rulesPublishedMessageId",
      COALESCE((SELECT jsonb_agg(a.user_id) FROM chat_admin_allowlist a
        WHERE a.chat_id = c.id), '[]'::jsonb) AS "adminUserIds",
      COALESCE((SELECT jsonb_agg(d.domain) FROM domain_allowlist d
        WHERE d.chat_id = c.id
          AND (d.remove_after_at IS NULL
            OR d.remove_after_at > ${sourceAt.toISOString()}::timestamp(3))),
        '[]'::jsonb) AS "domainAllowlist" ${additionalProjection}
    FROM "chats" c
    LEFT JOIN "chat_settings" s ON s.chat_id = c.id
    LEFT JOIN "chat_settings_cache_revisions" v ON v.chat_id = s.chat_id
    LEFT JOIN "chat_rules" r ON r.chat_id = c.id
    LEFT JOIN "chat_admin_roster_states" ar ON ar.chat_id = c.id
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
          adminRosterState: shell.adminRosterRevision
            ? {
                revision: shell.adminRosterRevision,
                completeProbeStartedAt:
                  shell.adminRosterCompleteProbeStartedAt?.toISOString() ?? null,
                completedAt: shell.adminRosterCompletedAt?.toISOString() ?? null,
              }
            : null,
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

  // FLAG: One SELECT binds every setting, its UUID proof and all mutable shell
  // relations to one MVCC snapshot. Never split the full projection into separate reads.
  const [full] = await prisma.$queryRaw<ChatContextFullSource[]>(
    chatContextFullQuery(chatId, sourceAt),
  );
  if (!full) return { row: null, proof: null, mode: 'full' };
  const settings = readProjectedChatSettings(full);
  return {
    row: {
      id: full.id,
      title: full.title,
      botId: full.botId,
      primaryBotId: full.primaryBotId,
      settings,
      domains: full.domainAllowlist.map((domain) => ({ domain })),
      admins: full.adminUserIds.map((userId) => ({ userId })),
      adminRosterState: full.adminRosterRevision
        ? {
            revision: full.adminRosterRevision,
            completeProbeStartedAt: full.adminRosterCompleteProbeStartedAt?.toISOString() ?? null,
            completedAt: full.adminRosterCompletedAt?.toISOString() ?? null,
          }
        : null,
      rules:
        full.rulesChatId === null
          ? null
          : {
              publishedUrl: full.rulesPublishedUrl,
              publishedMessageId: full.rulesPublishedMessageId,
            },
    },
    proof: settings ? { settingsId: settings.id, revision: full.settingsRevision } : null,
    mode: 'full',
  };
}
