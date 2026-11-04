import { ConflictException } from '@nestjs/common';
import { Prisma } from '../../prisma/prisma-client';
import type { PrismaService } from '../../prisma/prisma.service';

export type ConnectionScope = {
  revision: number;
  activeOperationId: string | null;
  lastOperationId: string | null;
};
type Claim = {
  operationId: string;
  anchorChatId: string;
  chatIds: string[];
  marketplaceIds?: string[];
  expectedRevision?: number;
};
const terminalStates = new Set(['complete', 'rejected', 'cancelled', 'superseded']);
const conflict = () =>
  new ConflictException({
    code: 'KARAVAN_CONNECTION_IN_PROGRESS',
    message: 'В этом чате уже выполняется изменение подключения. Проверьте его результат.',
  });

/** Transactional admission shared by setup and direct binding commands. */
export class ConnectionJournal {
  constructor(private readonly prisma: PrismaService) {}

  async read(chatId: string): Promise<ConnectionScope> {
    const scope = await this.prisma.karavanMarketplaceConnectionScope.findUnique({
      where: { chatId },
      select: { revision: true, activeOperationId: true, lastOperationId: true },
    });
    return scope ?? { revision: 0, activeOperationId: null, lastOperationId: null };
  }

  async readWithLegacy(chatId: string): Promise<ConnectionScope> {
    const scope = await this.read(chatId);
    if (scope.activeOperationId) return scope;
    // FLAG: Project a retained legacy reservation without adopting it or writing
    // new scope state during a status read, including non-anchor target chats.
    const legacy = await this.findLegacyOperation(this.prisma, [chatId], null);
    return legacy ? { ...scope, activeOperationId: legacy.id } : scope;
  }

  private async lock(tx: Prisma.TransactionClient, chatIds: string[]): Promise<void> {
    for (const chatId of chatIds)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`karavan-connection:${chatId}`}))`;
  }

  private async findLegacyOperation(
    tx: Prisma.TransactionClient,
    chatIds: string[],
    exceptOperationId: string | null,
    marketplaceIds: string[] = [],
  ): Promise<{ id: string } | null> {
    const chats = Prisma.sql`ARRAY[${Prisma.join(chatIds)}]::text[]`;
    // FLAG: Probe each partial index separately. A result limit alone does
    // not bound a combined OR scan of retained terminal operation history.
    const anchor = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM karavan_marketplace_connection_operations
      WHERE state IN ('pending','partial','unknown')
        AND anchor_chat_id = ANY(${chats})
        AND (${exceptOperationId}::uuid IS NULL OR id <> ${exceptOperationId}::uuid)
      LIMIT 1`);
    if (anchor.length) return anchor[0]!;
    const target = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM karavan_marketplace_connection_operations
      WHERE state IN ('pending','partial','unknown')
        AND (request -> 'chatIds') ?| ${chats}
        AND (${exceptOperationId}::uuid IS NULL OR id <> ${exceptOperationId}::uuid)
      LIMIT 1`);
    if (target.length) return target[0]!;
    if (!marketplaceIds.length) return null;
    const markets = Prisma.sql`ARRAY[${Prisma.join(marketplaceIds)}]::text[]`;
    for (const expression of [
      Prisma.sql`lower(request ->> 'marketplaceId')`,
      Prisma.sql`lower(checkpoints ->> 'marketplaceId')`,
      Prisma.sql`lower(request ->> 'existingMarketplaceId')`,
    ]) {
      const market = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM karavan_marketplace_connection_operations
        WHERE state IN ('pending','partial','unknown')
          AND ${expression} = ANY(${markets})
          AND (${exceptOperationId}::uuid IS NULL OR id <> ${exceptOperationId}::uuid)
        LIMIT 1`);
      if (market.length) return market[0]!;
    }
    return null;
  }

  async claim(tx: Prisma.TransactionClient, input: Claim): Promise<void> {
    const chatIds = [...new Set(input.chatIds)].sort();
    const marketplaceIds = [
      ...new Set((input.marketplaceIds ?? []).map((id) => id.toLowerCase())),
    ].sort();
    if (
      !chatIds.length ||
      chatIds.length > 20 ||
      !chatIds.includes(input.anchorChatId) ||
      chatIds.some((chatId) => !/^-?\d{1,24}$/u.test(chatId)) ||
      marketplaceIds.length > 20 ||
      marketplaceIds.some((id) => !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id)) ||
      (input.expectedRevision !== undefined &&
        (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0))
    )
      throw new ConflictException('Обновите данные подключения.');
    const scopeIds = [...chatIds, ...marketplaceIds.map((id) => `marketplace:${id}`)].sort();
    await this.lock(tx, scopeIds);
    const operation = await tx.karavanMarketplaceConnectionOperation.findUnique({
      where: { id: input.operationId },
      select: { anchorChatId: true, state: true },
    });
    if (!operation || operation.anchorChatId !== input.anchorChatId)
      throw new ConflictException('Подключение недоступно.');
    // FLAG: Read state after the chat locks: a finisher may have committed while
    // this admission was waiting. A terminal receipt must never reserve again.
    if (terminalStates.has(operation.state)) return;
    if (await this.findLegacyOperation(tx, chatIds, input.operationId, marketplaceIds))
      throw conflict();
    for (const chatId of scopeIds) {
      const scope = await tx.karavanMarketplaceConnectionScope.upsert({
        where: { chatId },
        create: { chatId },
        update: {},
      });
      if (scope.activeOperationId && scope.activeOperationId !== input.operationId)
        throw conflict();
      const admitted =
        scope.activeOperationId === input.operationId ||
        scope.lastOperationId === input.operationId;
      if (
        chatId === input.anchorChatId &&
        !admitted &&
        input.expectedRevision !== undefined &&
        scope.revision !== input.expectedRevision
      )
        throw new ConflictException({
          code: 'KARAVAN_CONNECTION_REVISION_CHANGED',
          message: 'Подключение изменилось. Обновите состояние магазина.',
        });
      await tx.karavanMarketplaceConnectionScope.update({
        where: { chatId },
        data: {
          activeOperationId: input.operationId,
          lastOperationId: input.operationId,
          ...(admitted ? {} : { revision: { increment: 1 } }),
        },
      });
    }
  }

  async release(tx: Prisma.TransactionClient, operationId: string): Promise<void> {
    const operation = await tx.karavanMarketplaceConnectionOperation.findUnique({
      where: { id: operationId },
      select: { state: true },
    });
    if (!operation || !terminalStates.has(operation.state)) throw conflict();
    const scopes = await tx.karavanMarketplaceConnectionScope.findMany({
      where: { activeOperationId: operationId },
      select: { chatId: true },
      orderBy: { chatId: 'asc' },
    });
    await this.lock(
      tx,
      scopes.map(({ chatId }) => chatId),
    );
    // FLAG: Release is exact-ID and terminal-only. Retain lastOperationId and the
    // admission revision so lost replies and delayed first POSTs can be resolved.
    await tx.karavanMarketplaceConnectionScope.updateMany({
      where: { activeOperationId: operationId },
      data: { activeOperationId: null },
    });
  }

  async assertWriteAvailable(chatId: string, exceptOperationId?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lock(tx, [chatId]);
      const scope = await tx.karavanMarketplaceConnectionScope.findUnique({
        where: { chatId },
        select: { activeOperationId: true },
      });
      if (
        (scope?.activeOperationId && scope.activeOperationId !== exceptOperationId) ||
        (await this.findLegacyOperation(tx, [chatId], exceptOperationId ?? null))
      )
        throw conflict();
    });
  }
}
