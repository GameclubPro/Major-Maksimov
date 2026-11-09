import { Prisma, type ChatSettings } from '../../prisma/prisma-client';
import type { PrismaService } from '../../prisma/prisma.service';
import type {
  ChatContextFullSource,
  ChatContextShell,
  ChatContextSourceRow,
} from '../chat-context-source';
import {
  CHAT_SETTINGS_SQL_COLUMNS,
  type ChatSettingsProjection,
} from '../chat-settings-projection';

type SourceFixtureRow = Omit<ChatContextSourceRow, 'botId' | 'primaryBotId' | 'settings'> & {
  botId?: string | null;
  primaryBotId?: string | null;
  settings: (Partial<ChatSettings> & { cacheRevision?: { revision: string } | null }) | null;
};
type FindSourceFixture = (args: Prisma.ChatFindUniqueArgs) => PromiseLike<SourceFixtureRow | null>;

// FLAG: This adapter models only the source SQL boundary; the real source loader and
// service generation/access/Redis fences execute normally in the consuming tests.
export function withChatContextSourceFixture<T extends object>(fixture: T): PrismaService {
  const chat = Reflect.get(fixture, 'chat') as { findUnique?: FindSourceFixture } | undefined;
  const read = async (args: Prisma.ChatFindUniqueArgs): Promise<SourceFixtureRow | null> => {
    if (!chat?.findUnique) throw new Error('Chat context fixture has no source reader');
    const row = await chat.findUnique(args);
    if (row == null) return null;
    return {
      ...row,
      botId: row.botId ?? null,
      primaryBotId: row.primaryBotId ?? null,
      settings: row.settings
        ? {
            ...row.settings,
            id: row.settings.id ?? `fixture-settings:${row.id}`,
            chatId: row.settings.chatId ?? row.id,
            cacheRevision: row.settings.cacheRevision ?? null,
          }
        : null,
    };
  };
  const transaction = jest.fn(async (): Promise<never> => {
    throw new Error('Chat context source must use one native SELECT without a transaction');
  });
  const query = jest.fn(
    async (sql: Prisma.Sql): Promise<(ChatContextShell | ChatContextFullSource)[]> => {
      if (!sql.text.includes('chat_settings_cache_revisions'))
        throw new Error('Chat context fixture received an unexpected SQL query');
      const chatId = sql.values.at(-1);
      if (typeof chatId !== 'string') throw new Error('Chat context source chat id is missing');
      const row = await read({ where: { id: chatId } });
      if (!row) return [];
      const shell = {
        id: row.id,
        title: row.title,
        botId: row.botId ?? null,
        primaryBotId: row.primaryBotId ?? null,
        settingsId: row.settings?.id ?? null,
        settingsRevision: row.settings?.cacheRevision?.revision ?? null,
        rulesPublishedUrl: row.rules?.publishedUrl ?? null,
        rulesPublishedMessageId: row.rules?.publishedMessageId ?? null,
        adminUserIds: row.admins.map(({ userId }) => userId),
        domainAllowlist: row.domains.map(({ domain }) => domain),
        adminRosterRevision: row.adminRosterState?.revision ?? null,
        adminRosterCompleteProbeStartedAt: row.adminRosterState?.completeProbeStartedAt
          ? new Date(row.adminRosterState.completeProbeStartedAt)
          : null,
        adminRosterCompletedAt: row.adminRosterState?.completedAt
          ? new Date(row.adminRosterState.completedAt)
          : null,
      } satisfies ChatContextShell;
      if (!sql.text.includes('AS "settings_id"')) return [shell];
      // FLAG: Partial mock rows may omit settings; the real native projection is complete.
      // Keep this conversion at the fixture boundary so source/fence logic stays unchanged.
      const settings = Object.fromEntries(
        (Object.keys(CHAT_SETTINGS_SQL_COLUMNS) as (keyof ChatSettings)[]).map((key) => [
          `settings_${key}`,
          row.settings ? row.settings[key] : null,
        ]),
      ) as ChatSettingsProjection;
      return [{ ...shell, ...settings, rulesChatId: row.rules ? row.id : null }];
    },
  );
  return { ...fixture, $transaction: transaction, $queryRaw: query } as unknown as PrismaService;
}
