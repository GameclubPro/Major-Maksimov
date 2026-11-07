import { Prisma, type ChatSettings } from '../../prisma/prisma-client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { ChatContextShell, ChatContextSourceRow } from '../chat-context-source';

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
  const transaction = jest.fn(
    async (
      run: (tx: Prisma.TransactionClient) => Promise<unknown>,
      options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
    ): Promise<unknown> => {
      if (options?.isolationLevel !== Prisma.TransactionIsolationLevel.RepeatableRead)
        throw new Error('Chat context full source must request RepeatableRead');
      const tx = { ...fixture, chat: { ...chat, findUnique: read } };
      return run(tx as unknown as Prisma.TransactionClient);
    },
  );
  const query = jest.fn(async (sql: Prisma.Sql): Promise<ChatContextShell[]> => {
    if (!sql.text.includes('chat_settings_cache_revisions'))
      throw new Error('Chat context fixture received an unexpected SQL query');
    const chatId = sql.values.at(-1);
    if (typeof chatId !== 'string') throw new Error('Chat context shell chat id is missing');
    const row = await read({ where: { id: chatId } });
    if (!row) return [];
    return [
      {
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
      } satisfies ChatContextShell,
    ];
  });
  return { ...fixture, $transaction: transaction, $queryRaw: query } as unknown as PrismaService;
}
