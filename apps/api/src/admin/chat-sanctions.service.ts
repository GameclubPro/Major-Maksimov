import {
  chatSanctionsPageSchema,
  chatSanctionsQuerySchema,
  type ChatSanctionItem,
  type ChatSanctionsPage,
} from '@maxim/contracts/chat-sanctions';
import { BadRequestException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { ModerationSanctionStateFenceService } from '../moderation/moderation-sanction-state-fence.service';
import {
  readSanctionMetadata,
  readSanctionString,
  resolveSanctionState,
  type SanctionFeedRow,
} from './chat-sanction-state';

const SCAN_BATCH = 50;
const MAX_SCAN_BATCHES = 4;
const ARCHIVE_DAYS = 365;
const cursorSchema = z.object({
  v: z.literal(1),
  scope: z.string(),
  createdAt: z.string().datetime(),
  id: z.string().max(200),
});

@Injectable()
export class ChatSanctionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fence: ModerationSanctionStateFenceService,
  ) {}

  async getPage(chatId: string, userId: string, input: unknown): Promise<ChatSanctionsPage> {
    const parsed = chatSanctionsQuerySchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException(parsed.error.format());
    const query = parsed.data;
    const scope = JSON.stringify([
      chatId,
      userId,
      query.status,
      query.action,
      query.search ?? '',
      query.userId ?? '',
    ]);
    let cursor: z.infer<typeof cursorSchema> | null = null;
    if (query.cursor) {
      try {
        cursor = cursorSchema.parse(
          JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')),
        );
        if (cursor.scope !== scope) throw new Error('Mismatched cursor');
      } catch {
        throw new BadRequestException('Список ограничений изменился. Обновите его.');
      }
    }
    const now = new Date();
    const items: ChatSanctionItem[] = [];
    let hasMore = false;
    let last: SanctionFeedRow | null = null;
    for (let batch = 0; batch < MAX_SCAN_BATCHES; batch += 1) {
      const search = query.search?.trim();
      const rows = await this.prisma.$queryRaw<SanctionFeedRow[]>(Prisma.sql`
        WITH candidates AS MATERIALIZED (
          SELECT * FROM chat_moderation_feed_items feed
          WHERE feed.chat_id = ${chatId} AND feed.action IN ('MUTE', 'BAN')
            ${query.action === 'all' ? Prisma.empty : Prisma.sql`AND feed.action = ${query.action}::"SanctionAction"`}
            ${query.userId ? Prisma.sql`AND feed.user_id = ${query.userId}` : Prisma.empty}
            ${cursor ? Prisma.sql`AND (feed.created_at, feed.id) < (${new Date(cursor.createdAt)}, ${cursor.id})` : Prisma.empty}
          ORDER BY feed.created_at DESC, feed.id DESC
          LIMIT ${SCAN_BATCH + 1}
        )
        SELECT feed.id, feed.user_id AS "userId", feed.user_display_name AS "userDisplayName",
          feed.action, feed.rule_code AS "ruleCode", feed.operator, feed.metadata,
          feed.created_at AS "createdAt", successor.created_at AS "nextEventAt",
          successor.rule_code AS "nextRuleCode",
          EXISTS(SELECT 1 FROM moderation_events original WHERE original.id = feed.id) AS "sourceExists"
        FROM candidates feed
        LEFT JOIN LATERAL (
          SELECT later.created_at, later.rule_code
          FROM chat_moderation_feed_items later
          WHERE later.chat_id = feed.chat_id AND later.user_id = feed.user_id
            AND (later.action IN ('MUTE', 'BAN') OR later.rule_code IN ('MANUAL_UNMUTE', 'MANUAL_UNBAN'))
            AND (later.created_at, later.id) > (feed.created_at, feed.id)
          ORDER BY later.created_at ASC, later.id ASC LIMIT 1
        ) successor ON true
        ORDER BY feed.created_at DESC, feed.id DESC
      `);
      const pageRows = rows.slice(0, SCAN_BATCH);
      hasMore = rows.length > SCAN_BATCH;
      for (let index = 0; index < pageRows.length; index += 1) {
        const row = pageRows[index]!;
        last = row;
        if (
          search &&
          row.userId !== search &&
          !(row.userDisplayName ?? '')
            .toLocaleLowerCase('ru-RU')
            .includes(search.toLocaleLowerCase('ru-RU'))
        )
          continue;
        const state = resolveSanctionState(row, now.getTime());
        if (
          (state.status === 'active' || state.status === 'review') &&
          row.sourceExists &&
          (await this.fence.isSanctionEventInvalidated({
            chatId,
            userId: row.userId,
            sanctionEventId: row.id,
            eventCreatedAt: row.createdAt,
          }))
        ) {
          state.status = 'review';
          state.releaseAction = null;
        }
        const archived =
          state.status === 'expired' || state.status === 'released' || state.status === 'replaced';
        if (
          archived &&
          state.endedAt &&
          Date.parse(state.endedAt) < now.getTime() - ARCHIVE_DAYS * 86_400_000
        )
          continue;
        if (query.status === 'archive' && !archived) continue;
        if (query.status === 'active' && state.status !== 'active') continue;
        if (query.status === 'review' && state.status !== 'review') continue;
        const metadata = readSanctionMetadata(row.metadata);
        items.push({
          id: row.id,
          userId: row.userId,
          userDisplayName:
            row.userDisplayName || readSanctionString(metadata.userDisplayName) || 'Участник',
          avatarUrl: null,
          profileHandoffUrl: null,
          action: row.action,
          ruleCode: row.ruleCode,
          operator: row.operator,
          reason: readSanctionString(metadata.reason)?.slice(0, 500) ?? null,
          actorDisplayName: readSanctionString(metadata.initiatedByDisplayName),
          createdAt: row.createdAt.toISOString(),
          banOnRejoin: row.action === 'BAN' && metadata.mode === 'LOCAL_REJOIN',
          ...state,
        });
        if (items.length === query.limit) {
          hasMore = hasMore || index < pageRows.length - 1;
          break;
        }
      }
      if (items.length === query.limit || !hasMore) break;
      if (last) cursor = { v: 1, scope, createdAt: last.createdAt.toISOString(), id: last.id };
    }
    return chatSanctionsPageSchema.parse({
      items,
      serverTime: now.toISOString(),
      hasMore,
      nextCursor:
        hasMore && last
          ? Buffer.from(
              JSON.stringify({ v: 1, scope, createdAt: last.createdAt.toISOString(), id: last.id }),
            ).toString('base64url')
          : null,
    });
  }
}
