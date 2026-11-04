import type { ConfigService } from '@nestjs/config';
import {
  karavanMarketplaceAuthorityScopeSchema,
  karavanMarketplaceBindingResultSchema,
  karavanMarketplaceOperationSchema,
} from '@maxim/contracts/karavan-marketplace';
import { karavanConnectionBindingInputSchema } from '@maxim/contracts/karavan-marketplace-connection';
import type { Prisma } from '../../prisma/prisma-client';
import type { PrismaService } from '../../prisma/prisma.service';
import { karavanHash } from './karavan-marketplace-authority.service';
import { ConnectionJournal } from './karavan-connection-journal';
import { readKaravanCommandReceipt } from './karavan-command-receipts';
import { observeKaravanSetup } from './karavan-setup-observation';

// FLAG: Explicit admission may persist an exact observed completion. GET never
// calls this helper; pending or unknown effects cannot expire out of a reservation.
export async function settleConnectionReceipts(
  prisma: PrismaService,
  config: ConfigService,
  chatId: string,
  marketplaceIds: string[] = [],
): Promise<void> {
  const journal = new ConnectionJournal(prisma);
  const ids = new Set<string>();
  for (const key of [chatId, ...marketplaceIds.map((id) => `marketplace:${id.toLowerCase()}`)]) {
    const scope = key === chatId ? await journal.readWithLegacy(key) : await journal.read(key);
    if (scope.activeOperationId) ids.add(scope.activeOperationId);
  }
  for (const id of ids) {
    const row = await prisma.karavanMarketplaceConnectionOperation.findUnique({ where: { id } });
    if (
      !row ||
      !['binding', 'setup'].includes(row.kind) ||
      (row.leaseUntil && row.leaseUntil > new Date())
    )
      continue;
    let result: Prisma.InputJsonValue | undefined;
    let checkpoints: Prisma.InputJsonValue | undefined;
    if (row.kind === 'binding') {
      if (row.state !== 'unknown') continue;
      const input = karavanConnectionBindingInputSchema.parse(row.request);
      const payload = {
        commandId: input.commandId,
        chatId: row.anchorChatId,
        expectedBindingGeneration: input.expectedBindingGeneration,
        ...(input.action === 'bind_chat' ? {} : { action: input.action }),
      };
      const scope = karavanMarketplaceAuthorityScopeSchema.parse({
        actorMaxUserId: row.actorMaxUserId,
        chatId: row.anchorChatId,
        commandId: input.commandId,
        action: input.action,
        marketplaceId: input.marketplaceId,
        expectedBindingGeneration: input.expectedBindingGeneration,
        payloadHash: karavanHash(payload),
      });
      const receipt = await readKaravanCommandReceipt(
        config,
        {
          actorMaxUserId: row.actorMaxUserId,
          chatId: row.anchorChatId,
          commandId: input.commandId,
          action: input.action,
          marketplaceId: input.marketplaceId,
        },
        karavanHash(scope),
      );
      if (!receipt) continue;
      result = karavanMarketplaceBindingResultSchema.parse(receipt);
    } else {
      const operation = karavanMarketplaceOperationSchema.parse({
        operationId: row.id,
        state: row.state,
        request: row.request,
        checkpoints: row.checkpoints,
      });
      const observed = await observeKaravanSetup(config, row.actorMaxUserId, operation);
      if (observed.state !== 'complete') continue;
      checkpoints = observed.checkpoints;
    }
    await prisma.$transaction(async (tx) => {
      const updated = await tx.karavanMarketplaceConnectionOperation.updateMany({
        where: {
          id: row.id,
          kind: row.kind,
          state: row.state,
          leaseId: row.leaseId,
          updatedAt: row.updatedAt,
        },
        data: {
          state: 'complete',
          activeScopeKey: null,
          leaseId: null,
          leaseUntil: null,
          errorCode: null,
          ...(result ? { result } : {}),
          ...(checkpoints ? { checkpoints } : {}),
        },
      });
      if (updated.count === 1) await journal.release(tx, row.id);
    });
  }
}
