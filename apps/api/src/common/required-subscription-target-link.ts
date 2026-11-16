import type { ChatEntityType } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';

type CatalogStore = Pick<PrismaService, 'managedBotChatCatalog'>;

export function normalizeRequiredSubscriptionTargetLink(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2_048) return null;
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== 'https:' ||
      !['max.ru', 'www.max.ru'].includes(url.hostname) ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname === '/'
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

export async function readRequiredSubscriptionTargetLink(
  prisma: CatalogStore,
  chatId: string,
  observedLink?: unknown,
): Promise<string | null> {
  const link = normalizeRequiredSubscriptionTargetLink(observedLink);
  if (link) return link;
  // FLAG: Presentation metadata supplies a button only, never membership or effect authority.
  // Bound the exact target lookup; a catalog/cache outage must not disable the subscription rule.
  try {
    const rows = await prisma.managedBotChatCatalog.findMany({
      where: { chatId, status: { in: ['ACTIVE', 'PRESENTATION'] } },
      orderBy: [{ metadataObservedAt: { sort: 'desc', nulls: 'last' } }, { updatedAt: 'desc' }],
      take: 8,
      select: { link: true },
    });
    for (const row of rows) {
      const saved = normalizeRequiredSubscriptionTargetLink(row.link);
      if (saved) return saved;
    }
  } catch {
    return null;
  }
  return null;
}

export async function rememberRequiredSubscriptionTargetLink(
  prisma: CatalogStore,
  params: {
    chatId: string;
    botId: string;
    entityType: ChatEntityType;
    link: string;
    observedAt: Date;
  },
): Promise<void> {
  const link = normalizeRequiredSubscriptionTargetLink(params.link);
  if (!link) return;
  // FLAG: A verified link survives Redis eviction without activating or reviving a connection.
  // A stale response cannot overwrite a newer observation or an intervening access transition.
  const written = await prisma.managedBotChatCatalog.updateMany({
    where: {
      chatId: params.chatId,
      botId: params.botId,
      status: { in: ['ACTIVE', 'PRESENTATION'] },
      updatedAt: { lte: params.observedAt },
      OR: [{ metadataObservedAt: null }, { metadataObservedAt: { lte: params.observedAt } }],
    },
    data: { link, metadataObservedAt: params.observedAt },
  });
  if (written.count > 0) return;
  try {
    await prisma.managedBotChatCatalog.create({
      data: {
        chatId: params.chatId,
        botId: params.botId,
        entityType: params.entityType,
        link,
        status: 'PRESENTATION',
        source: 'required_subscription',
        metadataObservedAt: params.observedAt,
      },
    });
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002')
      return;
    throw error;
  }
}
