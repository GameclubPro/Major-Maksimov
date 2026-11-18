import type { ManagedEntityType } from '@maxim/contracts';
import { Prisma } from '../prisma/prisma-client';

type CommunityRow = { id: string; title: string; avatarUrl: string | null };
type View =
  | { authorizedIds: string[] }
  | { userId: string; memberIds: string[] | null; search: string; after?: string; limit: number };

const titleWhitespace =
  ' \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';

const fold = (text: Prisma.Sql) => Prisma.sql`lower(translate(${text},
  'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ', 'абвгдеёжзийклмнопрстуфхцчшщъыьэюя'))`;

export async function readNetworkCommunityRows(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  entityType: ManagedEntityType,
  botIds: string[],
  view: View,
): Promise<CommunityRow[]> {
  const ids = 'authorizedIds' in view ? view.authorizedIds : view.memberIds;
  if (ids?.length === 0 || (!botIds.length && 'userId' in view)) return [];
  const type = entityType === 'chat' ? 'CHAT' : 'CHANNEL';
  const fallback = entityType === 'chat' ? 'Чат без названия' : 'Канал без названия';
  const bots = botIds.length ? Prisma.join(botIds) : Prisma.sql`NULL`;
  // FLAG: Registry-scoped metadata supplies presentation only. Catalogue reads require an
  // existing moderation grant; statistics/settings supply their own strictly authorized IDs.
  const candidates =
    'userId' in view
      ? Prisma.sql`
      SELECT c.id, c.title, c.entity_type
      FROM (
        SELECT DISTINCT edge.chat_id
        FROM managed_entity_access_edges edge
        WHERE edge.user_id=${view.userId} AND edge.entity_type=${type}::"ChatEntityType"
          AND edge.state='GRANTED' AND edge.user_role IN ('ADMIN','OWNER')
          AND edge.bot_id IN (${bots})
          ${ids ? Prisma.sql`AND edge.chat_id IN (${Prisma.join(ids)})` : Prisma.empty}
          ${view.after ? Prisma.sql`AND edge.chat_id > ${view.after}` : Prisma.empty}
      ) visible
      CROSS JOIN LATERAL (
        SELECT id, title, entity_type FROM chats
        WHERE id=visible.chat_id AND entity_type=${type}::"ChatEntityType" LIMIT 1
      ) c`
      : Prisma.sql`
      SELECT c.id, c.title, c.entity_type FROM chats c
      WHERE c.entity_type=${type}::"ChatEntityType" AND c.id IN (${Prisma.join(view.authorizedIds)})`;
  const search =
    'search' in view && view.search
      ? Prisma.sql`WHERE (
    strpos(${fold(Prisma.sql`display.title`)}, ${fold(Prisma.sql`${view.search}::text`)}) > 0
    OR strpos(c.id, ${view.search}) > 0
  )`
      : Prisma.empty;
  const limit = 'limit' in view ? Prisma.sql`LIMIT ${view.limit}` : Prisma.empty;
  const searching = 'search' in view && Boolean(view.search);
  return db.$queryRaw<CommunityRow[]>`
    SELECT c.id, display.title, catalog.avatar AS "avatarUrl"
    FROM (
      ${candidates}
      ORDER BY c.id ASC
      ${searching ? Prisma.empty : limit}
    ) c
    LEFT JOIN LATERAL (
      SELECT b.title, CASE WHEN b.avatar_state='absent' THEN NULL ELSE b.avatar_url END AS avatar
      FROM managed_bot_chat_catalog b
      WHERE b.chat_id=c.id AND b.entity_type=c.entity_type AND b.bot_id IN (${bots})
        AND b.status IN ('ACTIVE','PRESENTATION')
      ORDER BY b.metadata_observed_at DESC NULLS LAST, b.bot_id ASC LIMIT 1
    ) catalog ON true
    CROSS JOIN LATERAL (
      SELECT btrim(c.title, ${titleWhitespace}) AS stored,
             btrim(catalog.title, ${titleWhitespace}) AS cached
    ) names
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN names.stored NOT IN ('', c.id, 'Chat ' || c.id, 'Channel ' || c.id) THEN names.stored
        WHEN names.cached NOT IN ('', c.id, 'Chat ' || c.id, 'Channel ' || c.id) THEN names.cached
        ELSE ${fallback}
      END AS title
    ) display
    ${search}
    ORDER BY c.id ASC
    ${searching ? limit : Prisma.empty}
  `;
}
