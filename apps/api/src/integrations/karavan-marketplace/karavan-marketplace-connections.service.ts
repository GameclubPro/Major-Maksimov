import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  karavanMarketplaceBindingResultSchema,
  karavanMarketplaceAuthorityScopeSchema,
} from '@maxim/contracts/karavan-marketplace';
import {
  karavanConnectionBindingInputSchema,
  karavanConnectionBindingOperationSchema,
  karavanConnectionSnapshotSchema,
  type KaravanConnectionBindingInput,
  type KaravanConnectionBindingOperation,
} from '@maxim/contracts/karavan-marketplace-connection';
import { Prisma } from '../../prisma/prisma-client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  KaravanMarketplaceAuthorityService,
  karavanHash,
  type KaravanPrincipal,
} from './karavan-marketplace-authority.service';
import {
  KaravanMarketplaceProxyService,
  KaravanCommandUnavailable,
  KaravanBindingNotDispatched,
} from './karavan-marketplace-proxy.service';
import { KaravanManagementRejected } from './karavan-marketplace-management-errors';
import { ConnectionJournal } from './karavan-connection-journal';
import { ManagementJournal } from './karavan-management-journal';
import { readKaravanCommandReceipt } from './karavan-command-receipts';
import { settleConnectionReceipts } from './karavan-connection-settlement';

type OperationRow = Prisma.KaravanMarketplaceConnectionOperationGetPayload<object>;
const terminal = new Set(['complete', 'rejected', 'cancelled', 'superseded']);

function bindingPayload(chatId: string, input: KaravanConnectionBindingInput) {
  return {
    commandId: input.commandId,
    chatId,
    expectedBindingGeneration: input.expectedBindingGeneration,
    ...(input.action === 'bind_chat' ? {} : { action: input.action }),
  };
}
function bindingScope(
  actorMaxUserId: string,
  chatId: string,
  input: KaravanConnectionBindingInput,
) {
  return karavanMarketplaceAuthorityScopeSchema.parse({
    actorMaxUserId,
    chatId,
    commandId: input.commandId,
    action: input.action,
    marketplaceId: input.marketplaceId,
    expectedBindingGeneration: input.expectedBindingGeneration,
    payloadHash: karavanHash(bindingPayload(chatId, input)),
  });
}

@Injectable()
export class KaravanMarketplaceConnectionsService {
  private readonly journal: ConnectionJournal;

  constructor(
    private readonly prisma: PrismaService,
    private readonly proxy: KaravanMarketplaceProxyService,
    private readonly authority: KaravanMarketplaceAuthorityService,
    private readonly config: ConfigService,
  ) {
    this.journal = new ConnectionJournal(prisma);
  }

  private view(row: OperationRow): KaravanConnectionBindingOperation {
    if (row.kind !== 'binding') throw new ForbiddenException('Действие недоступно.');
    const result = row.result ? karavanMarketplaceBindingResultSchema.parse(row.result) : null;
    return karavanConnectionBindingOperationSchema.parse({
      operationId: row.id,
      state: row.state,
      request: row.request,
      result: result ? { bindingId: result.bindingId, generation: result.generation } : null,
      errorCode: row.errorCode,
    });
  }

  private async owned(chatId: string, actorMaxUserId: string, id: string) {
    const row = await this.prisma.karavanMarketplaceConnectionOperation.findUnique({
      where: { id },
    });
    if (!row || row.actorMaxUserId !== actorMaxUserId || row.anchorChatId !== chatId)
      throw new ForbiddenException('Действие недоступно.');
    return row;
  }

  async snapshot(chatId: string, actorMaxUserId: string, principal: KaravanPrincipal) {
    await this.authority.assertPrincipal(principal, actorMaxUserId);
    const scope = await this.journal.readWithLegacy(chatId);
    const id = scope.activeOperationId ?? scope.lastOperationId;
    const row = id
      ? await this.prisma.karavanMarketplaceConnectionOperation.findUnique({ where: { id } })
      : null;
    // FLAG: A second administrator may see a conflict, never another actor's
    // request, receipt, marketplace details or identifiers from the private journal.
    const own =
      row?.kind !== 'management' &&
      row?.actorMaxUserId === actorMaxUserId &&
      row.anchorChatId === chatId;
    const operation = own
      ? row.kind === 'binding'
        ? { kind: 'binding' as const, operation: this.view(row) }
        : {
            kind: 'setup' as const,
            operation: await this.proxy.status(row.id, actorMaxUserId, chatId),
          }
      : null;
    const legacy = !id ? await this.proxy.activeSetup(actorMaxUserId, chatId) : null;
    return karavanConnectionSnapshotSchema.parse({
      version: 2,
      revision: scope.revision,
      blocked: !!scope.activeOperationId && !own,
      operation: operation ?? (legacy ? { kind: 'setup', operation: legacy } : null),
    });
  }

  async status(chatId: string, actorMaxUserId: string, id: string, principal: KaravanPrincipal) {
    await this.authority.assertPrincipal(principal, actorMaxUserId);
    const row = await this.owned(chatId, actorMaxUserId, id);
    const view = this.view(row);
    if (terminal.has(row.state)) return view;
    const receipt = await this.receipt(row);
    // FLAG: Status reads do not register, execute, cancel, release or rewrite a
    // command. A receipt can be presented without claiming a new external effect.
    return receipt
      ? {
          ...view,
          state: 'complete' as const,
          result: { bindingId: receipt.bindingId, generation: receipt.generation },
          errorCode: null,
        }
      : view;
  }

  private async receipt(row: OperationRow) {
    const input = karavanConnectionBindingInputSchema.parse(row.request);
    const response = await readKaravanCommandReceipt(
      this.config,
      {
        actorMaxUserId: row.actorMaxUserId,
        chatId: row.anchorChatId,
        commandId: input.commandId,
        action: input.action,
        marketplaceId: input.marketplaceId,
      },
      karavanHash(bindingScope(row.actorMaxUserId, row.anchorChatId, input)),
    );
    return response ? karavanMarketplaceBindingResultSchema.parse(response) : null;
  }

  private async finish(
    row: OperationRow,
    state: 'complete' | 'rejected' | 'superseded',
    result?: Prisma.InputJsonValue,
    errorCode?: string,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.karavanMarketplaceConnectionOperation.updateMany({
        where: { id: row.id, state: { in: ['pending', 'unknown'] }, leaseId: row.leaseId },
        data: {
          state,
          activeScopeKey: null,
          leaseId: null,
          leaseUntil: null,
          ...(result ? { result } : {}),
          errorCode: errorCode ?? null,
        },
      });
      if (updated.count === 1) await this.journal.release(tx, row.id);
    });
  }

  // Called only by an explicit write/admission. Observing an exact committed
  // receipt may release its reservation before admitting a subsequent command.
  async settleBinding(chatId: string, marketplaceIds: string[] = []): Promise<void> {
    await new ManagementJournal(this.prisma, this.config).settle(chatId, marketplaceIds);
    await settleConnectionReceipts(this.prisma, this.config, chatId, marketplaceIds);
  }

  async bind(
    chatId: string,
    actorMaxUserId: string,
    raw: unknown,
    principal: KaravanPrincipal,
    importOnly = false,
  ) {
    this.authority.assertEnabled();
    await this.authority.assertPrincipal(principal, actorMaxUserId);
    const input = karavanConnectionBindingInputSchema.parse(raw);
    const requestHash = karavanHash(input);
    const existing = await this.prisma.karavanMarketplaceConnectionOperation.findUnique({
      where: { id: input.commandId },
    });
    let importedReceipt: ReturnType<typeof karavanMarketplaceBindingResultSchema.parse> | null =
      null;
    if (!existing) {
      const grant = await this.prisma.karavanMarketplaceAuthorityGrant.findUnique({
        where: { actorMaxUserId_commandId: { actorMaxUserId, commandId: input.commandId } },
      });
      if (grant && grant.scopeHash !== karavanHash(bindingScope(actorMaxUserId, chatId, input)))
        throw new ConflictException('Сохранённая команда относится к другому действию.');
      // FLAG: A retained original grant may precede this journal reader. Treat it
      // as possible prior dispatch, including after rights loss; receipt reads use
      // session ownership, while any later dispatch obtains fresh authority.
      if (importOnly && !grant) {
        const receipt = await readKaravanCommandReceipt(
          this.config,
          {
            actorMaxUserId,
            chatId,
            commandId: input.commandId,
            action: input.action,
            marketplaceId: input.marketplaceId,
          },
          karavanHash(bindingScope(actorMaxUserId, chatId, input)),
        );
        if (!receipt)
          throw new ForbiddenException(
            'Не удалось подтвердить прежнее действие. Сохранённая запись оставлена для проверки.',
          );
        importedReceipt = karavanMarketplaceBindingResultSchema.parse(receipt);
      }
      if (!grant && !importOnly) await this.authority.collect(chatId, actorMaxUserId);
      await this.settleBinding(chatId, [input.marketplaceId]);
    }
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`karavan-binding:${input.commandId}`}))`;
      const previous = await tx.karavanMarketplaceConnectionOperation.findUnique({
        where: { id: input.commandId },
      });
      if (previous) {
        if (
          previous.kind !== 'binding' ||
          previous.actorMaxUserId !== actorMaxUserId ||
          previous.anchorChatId !== chatId ||
          previous.requestHash !== requestHash
        )
          throw new ConflictException('Идентификатор уже использован для другого действия.');
        return previous;
      }
      const activeScopeKey = `${actorMaxUserId}:${chatId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`karavan-setup:${activeScopeKey}`}))`;
      const active = await tx.karavanMarketplaceConnectionOperation.findUnique({
        where: { activeScopeKey },
      });
      if (active)
        throw new ConflictException({
          code: 'KARAVAN_CONNECTION_IN_PROGRESS',
          message: 'В этом чате уже выполняется изменение подключения. Проверьте его результат.',
        });
      const grant = await tx.karavanMarketplaceAuthorityGrant.findUnique({
        where: { actorMaxUserId_commandId: { actorMaxUserId, commandId: input.commandId } },
      });
      if (grant && grant.scopeHash !== karavanHash(bindingScope(actorMaxUserId, chatId, input)))
        throw new ConflictException('Сохранённая команда относится к другому действию.');
      // FLAG: A chat administrator cannot reserve an arbitrary marketplace by
      // importing an invented unknown command. Admission requires original proof
      // or an exact committed receipt owned by this actor and anchor.
      if (importOnly && !grant && !importedReceipt)
        throw new ForbiddenException('Не удалось подтвердить прежнее действие.');
      const legacy = grant !== null;
      const scope = await tx.karavanMarketplaceConnectionScope.findUnique({ where: { chatId } });
      if (
        !importOnly &&
        !legacy &&
        input.expectedConnectionRevision === undefined &&
        scope &&
        scope.revision > 0
      )
        throw new ConflictException('Подключение изменилось. Обновите состояние магазина.');
      const created = await tx.karavanMarketplaceConnectionOperation.create({
        data: {
          id: input.commandId,
          kind: 'binding',
          actorMaxUserId,
          anchorChatId: chatId,
          activeScopeKey: `${actorMaxUserId}:${chatId}`,
          requestHash,
          request: input,
          state: importOnly || legacy ? 'unknown' : 'pending',
          checkpoints: { marketplaceId: input.marketplaceId, bindings: [] },
        },
      });
      if (importedReceipt) {
        return tx.karavanMarketplaceConnectionOperation.update({
          where: { id: created.id },
          data: {
            state: 'complete',
            activeScopeKey: null,
            result: importedReceipt,
          },
        });
      }
      await this.journal.claim(tx, {
        operationId: created.id,
        chatIds: [chatId],
        anchorChatId: chatId,
        marketplaceIds: [input.marketplaceId],
        expectedRevision:
          importOnly || legacy
            ? input.expectedConnectionRevision
            : (input.expectedConnectionRevision ?? 0),
      });
      return created;
    });
    if (importOnly) return this.view(row);
    return this.resume(chatId, actorMaxUserId, row.id, principal);
  }

  async resume(chatId: string, actorMaxUserId: string, id: string, principal: KaravanPrincipal) {
    this.authority.assertEnabled();
    await this.authority.assertPrincipal(principal, actorMaxUserId);
    let original = await this.owned(chatId, actorMaxUserId, id);
    if (terminal.has(original.state)) return this.view(original);
    if (original.kind !== 'binding') throw new ForbiddenException('Действие недоступно.');
    const leaseId = randomUUID();
    const lease = await this.prisma.karavanMarketplaceConnectionOperation.updateMany({
      where: {
        id,
        state: { in: ['pending', 'unknown'] },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
      },
      data: { leaseId, leaseUntil: new Date(Date.now() + 90_000) },
    });
    if (lease.count !== 1) return this.view(original);
    // FLAG: Another executor may have dispatched between the first read and this
    // lease. Classify uncertainty from the leased row, never the older snapshot.
    original = await this.owned(chatId, actorMaxUserId, id);
    const row = { ...original, leaseId };
    try {
      if (original.state === 'unknown') {
        const receipt = await this.receipt(row);
        if (receipt) {
          await this.finish(row, 'complete', receipt);
          return this.view(await this.owned(chatId, actorMaxUserId, id));
        }
        const module = await this.proxy.module(chatId, actorMaxUserId, principal);
        const request = karavanConnectionBindingInputSchema.parse(original.request);
        if (
          module.binding?.chatId === chatId &&
          module.binding.generation > (request.expectedBindingGeneration ?? 0)
        ) {
          await this.finish(row, 'superseded', undefined, 'KARAVAN_CONNECTION_SUPERSEDED');
          return this.view(await this.owned(chatId, actorMaxUserId, id));
        }
      }
      const input = karavanConnectionBindingInputSchema.parse(original.request);
      const held = await this.prisma.karavanMarketplaceConnectionOperation.updateMany({
        where: { id, leaseId },
        data: { state: 'unknown' },
      });
      if (held.count !== 1) throw new ConflictException('Действие продолжено в другой вкладке.');
      try {
        const result = await this.proxy.binding(
          input.marketplaceId,
          actorMaxUserId,
          bindingPayload(chatId, input),
          principal,
          input.action !== 'bind_chat',
          async () => {
            const current = await this.prisma.karavanMarketplaceConnectionOperation.updateMany({
              where: { id, leaseId, leaseUntil: { gt: new Date() } },
              data: { leaseUntil: new Date(Date.now() + 90_000) },
            });
            if (current.count !== 1)
              throw new ConflictException('Действие продолжено в другой вкладке.');
          },
        );
        await this.finish(row, 'complete', result);
      } catch (error) {
        // FLAG: A later rejection never disproves an earlier uncertain dispatch.
        const definitive =
          error instanceof KaravanBindingNotDispatched ||
          error instanceof KaravanManagementRejected ||
          (error instanceof KaravanCommandUnavailable && error.outcome === 'rejected');
        if (original.state === 'pending' && definitive)
          await this.finish(row, 'rejected', undefined, 'KARAVAN_CONNECTION_REJECTED');
      }
      return this.view(await this.owned(chatId, actorMaxUserId, id));
    } finally {
      await this.prisma.karavanMarketplaceConnectionOperation.updateMany({
        where: { id, leaseId },
        data: { leaseId: null, leaseUntil: null },
      });
    }
  }

  async legacyBind(
    chatId: string,
    actorMaxUserId: string,
    input: KaravanConnectionBindingInput,
    principal: KaravanPrincipal,
  ) {
    const operation = await this.bind(chatId, actorMaxUserId, input, principal);
    if (operation.state !== 'complete')
      throw new KaravanCommandUnavailable(operation.state === 'rejected' ? 'rejected' : 'unknown');
    const row = await this.owned(chatId, actorMaxUserId, operation.operationId);
    return karavanMarketplaceBindingResultSchema.parse(row.result);
  }
}
