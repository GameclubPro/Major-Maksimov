import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { karavanMarketplaceAuthorityScopeSchema } from '@maxim/contracts/karavan-marketplace';
import {
  marketplaceManagementRequestSchema,
  marketplaceManagementResponseSchema,
  type MarketplaceManagementRequest,
  type MarketplaceManagementResponse,
} from '@maxim/contracts/karavan-marketplace-management';
import type { Prisma } from '../../prisma/prisma-client';
import type { PrismaService } from '../../prisma/prisma.service';
import { karavanHash } from './karavan-marketplace-authority.service';
import { ConnectionJournal } from './karavan-connection-journal';
import { readKaravanCommandReceipt } from './karavan-command-receipts';
import { settleConnectionReceipts } from './karavan-connection-settlement';

type OperationRow = Prisma.KaravanMarketplaceConnectionOperationGetPayload<object>;
type Dispatch = (beforeDispatch: () => Promise<void>) => Promise<MarketplaceManagementResponse>;
type ConfirmedReceipt = { operation: 'administration_store_change'; confirmed: true };
type ManagementReceipt = MarketplaceManagementResponse | ConfirmedReceipt;

const unavailable = () =>
  new ServiceUnavailableException({
    code: 'KARAVAN_COMMAND_UNKNOWN',
    message: 'Результат пока не подтверждён. Повторите проверку сохранённого действия.',
  });
const rejected = () =>
  new ConflictException({
    code: 'KARAVAN_MANAGEMENT_REJECTED',
    message: 'Действие не выполнено. Обновите состояние магазина.',
  });
const confirmed = () =>
  new ConflictException({
    code: 'KARAVAN_COMMAND_RESULT_CONFIRMED',
    message: 'Действие сохранено. Обновите состояние магазина.',
  });

export function isDurableManagementWrite(request: MarketplaceManagementRequest): boolean {
  switch (request.command.operation) {
    case 'appearance':
    case 'administration_store':
    case 'administration_stores':
    case 'seller_grant_target':
    case 'seller_grants':
    case 'pins':
    case 'catalog':
    case 'invitations':
    case 'detail':
    case 'listings':
    case 'applications':
    case 'content':
    case 'rules_preview':
    case 'format_preview':
    case 'image':
      // An uploaded, unattached asset cannot change the marketplace or its binding.
      return false;
    default:
      return true;
  }
}

export function managementOperationId(actorMaxUserId: string, commandId: string): string {
  if (/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(commandId))
    return commandId;
  // FLAG: Existing clients may use non-UUID command IDs. This namespaced UUIDv8
  // identifies the server row only; the immutable provider command ID is unchanged.
  const hash = karavanHash({ kind: 'management', actorMaxUserId, commandId });
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

export function managementReceiptHash(request: MarketplaceManagementRequest): string {
  const command = request.command;
  if (command.operation === 'invitation_revoke')
    return karavanHash({ invitationId: command.input.invitationId });
  if (command.operation === 'decide' || command.operation === 'moderate_listing')
    return karavanHash({ ...command.input, marketplaceId: request.marketplaceId });
  if (!('input' in command) || !isDurableManagementWrite(request)) throw unavailable();
  return karavanHash(command.input);
}

/** Daily writes reserve the same durable scopes as connection commands. */
export class ManagementJournal {
  private readonly journal: ConnectionJournal;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.journal = new ConnectionJournal(prisma);
  }

  private present(
    value: unknown,
    request: MarketplaceManagementRequest,
  ): MarketplaceManagementResponse {
    if (
      value &&
      typeof value === 'object' &&
      'confirmed' in value &&
      value.confirmed === true &&
      'operation' in value &&
      value.operation === 'administration_store_change' &&
      request.command.operation === 'administration_store_change'
    )
      throw confirmed();
    const response = marketplaceManagementResponseSchema.parse(value);
    if (response.operation !== request.command.operation) throw unavailable();
    return response;
  }

  private async receipt(row: OperationRow): Promise<ManagementReceipt | null> {
    const request = marketplaceManagementRequestSchema.parse(row.request);
    const result = await readKaravanCommandReceipt(
      this.config,
      {
        actorMaxUserId: row.actorMaxUserId,
        chatId: row.anchorChatId,
        commandId: request.commandId,
        action: 'manage_shop',
        marketplaceId: request.marketplaceId,
        managementRequest: request,
      },
      managementReceiptHash(request),
    );
    if (!result) return null;
    if (
      'confirmed' in result &&
      result.confirmed === true &&
      result.operation === 'administration_store_change' &&
      request.command.operation === 'administration_store_change'
    )
      return result;
    const response = marketplaceManagementResponseSchema.parse(result);
    if (response.operation !== request.command.operation) throw unavailable();
    return response;
  }

  private async finish(
    row: OperationRow,
    state: 'complete' | 'rejected',
    result?: ManagementReceipt,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.karavanMarketplaceConnectionOperation.updateMany({
        where: {
          id: row.id,
          kind: 'management',
          state: { in: ['pending', 'unknown'] },
          leaseId: row.leaseId,
        },
        data: {
          state,
          activeScopeKey: null,
          leaseId: null,
          leaseUntil: null,
          errorCode: state === 'rejected' ? 'KARAVAN_MANAGEMENT_REJECTED' : null,
          ...(result ? { result: result as Prisma.InputJsonValue } : {}),
        },
      });
      if (updated.count === 1) await this.journal.release(tx, row.id);
      return updated.count === 1;
    });
  }

  // FLAG: Only an explicit admission/retry settles a committed receipt. Status GETs
  // never release an unknown command, and an expired execution lease is not its outcome.
  async settle(chatId: string, marketplaceIds: string[] = []): Promise<void> {
    const ids = new Set<string>();
    for (const key of [chatId, ...marketplaceIds.map((id) => `marketplace:${id.toLowerCase()}`)]) {
      const scope = await this.journal.read(key);
      if (scope.activeOperationId) ids.add(scope.activeOperationId);
    }
    for (const id of ids) {
      const row = await this.prisma.karavanMarketplaceConnectionOperation.findUnique({
        where: { id },
      });
      if (!row || row.kind !== 'management' || (row.leaseUntil && row.leaseUntil > new Date()))
        continue;
      const receipt = await this.receipt(row);
      if (receipt) await this.finish(row, 'complete', receipt);
    }
  }

  async run(
    actorMaxUserId: string,
    request: MarketplaceManagementRequest,
    dispatch: Dispatch,
    isDefiniteRejection: (error: unknown) => boolean,
  ): Promise<MarketplaceManagementResponse> {
    const id = managementOperationId(actorMaxUserId, request.commandId);
    const requestHash = karavanHash(request);
    const activeScopeKey = `${actorMaxUserId}:${request.chatId}`;
    const existing = await this.prisma.karavanMarketplaceConnectionOperation.findUnique({
      where: { id },
    });
    if (!existing) {
      await settleConnectionReceipts(this.prisma, this.config, request.chatId, [
        request.marketplaceId,
      ]);
      await this.settle(request.chatId, [request.marketplaceId]);
    }
    const admitted = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`karavan-management:${id}`}))`;
      const previous = await tx.karavanMarketplaceConnectionOperation.findUnique({ where: { id } });
      if (previous) {
        if (
          previous.kind !== 'management' ||
          previous.actorMaxUserId !== actorMaxUserId ||
          previous.anchorChatId !== request.chatId ||
          previous.requestHash !== requestHash
        )
          throw new ConflictException('Идентификатор уже использован для другого действия.');
        return previous;
      }
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`karavan-setup:${activeScopeKey}`}))`;
      const active = await tx.karavanMarketplaceConnectionOperation.findUnique({
        where: { activeScopeKey },
      });
      if (active)
        throw new ConflictException({
          code: 'KARAVAN_CONNECTION_IN_PROGRESS',
          message: 'В этом чате уже выполняется изменение. Проверьте его результат.',
        });
      const grant = await tx.karavanMarketplaceAuthorityGrant.findUnique({
        where: { actorMaxUserId_commandId: { actorMaxUserId, commandId: request.commandId } },
      });
      const scope = karavanMarketplaceAuthorityScopeSchema.parse({
        actorMaxUserId,
        chatId: request.chatId,
        commandId: request.commandId,
        action: 'manage_shop',
        marketplaceId: request.marketplaceId,
        expectedBindingGeneration: request.expectedBindingGeneration,
        payloadHash: requestHash,
      });
      if (grant && grant.scopeHash !== karavanHash(scope))
        throw new ConflictException('Сохранённая команда относится к другому действию.');
      const created = await tx.karavanMarketplaceConnectionOperation.create({
        data: {
          id,
          kind: 'management',
          actorMaxUserId,
          anchorChatId: request.chatId,
          activeScopeKey,
          requestHash,
          request: request as Prisma.InputJsonValue,
          // FLAG: An old grant can precede this durable journal. Its expiry or a
          // refreshed proof cannot disprove an earlier dispatch of this command.
          state: grant ? 'unknown' : 'pending',
          checkpoints: { marketplaceId: request.marketplaceId, bindings: [] },
        },
      });
      await this.journal.claim(tx, {
        operationId: id,
        anchorChatId: request.chatId,
        chatIds: [request.chatId],
        marketplaceIds: [request.marketplaceId],
      });
      return created;
    });
    if (admitted.state === 'complete') return this.present(admitted.result, request);
    if (admitted.state === 'rejected') throw rejected();
    const leaseId = randomUUID();
    const original = await this.prisma.$transaction(async (tx) => {
      const lease = await tx.karavanMarketplaceConnectionOperation.updateMany({
        where: {
          id,
          kind: 'management',
          state: { in: ['pending', 'unknown'] },
          OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
        },
        data: { leaseId, leaseUntil: new Date(Date.now() + 90_000) },
      });
      if (lease.count !== 1) throw unavailable();
      return tx.karavanMarketplaceConnectionOperation.findUniqueOrThrow({ where: { id } });
    });
    const row = { ...original, leaseId };
    let dispatched = false;
    try {
      if (original.state === 'unknown') {
        const receipt = await this.receipt(row);
        if (receipt) {
          if (!(await this.finish(row, 'complete', receipt))) throw unavailable();
          return this.present(receipt, request);
        }
      }
      try {
        const result = await dispatch(async () => {
          // FLAG: Persist uncertainty before HTTP, while the exact execution lease
          // and both chat/market reservations still belong to this original command.
          await this.prisma.$transaction(async (tx) => {
            await this.journal.claim(tx, {
              operationId: id,
              anchorChatId: request.chatId,
              chatIds: [request.chatId],
              marketplaceIds: [request.marketplaceId],
            });
            const held = await tx.karavanMarketplaceConnectionOperation.updateMany({
              where: {
                id,
                kind: 'management',
                leaseId,
                leaseUntil: { gt: new Date() },
                state: { in: ['pending', 'unknown'] },
              },
              data: { state: 'unknown', leaseUntil: new Date(Date.now() + 90_000) },
            });
            if (held.count !== 1) throw unavailable();
          });
          dispatched = true;
        });
        const response = this.present(result, request);
        if (!(await this.finish(row, 'complete', response))) throw unavailable();
        return response;
      } catch (error) {
        // FLAG: A later definite refusal does not disprove a previous unknown
        // dispatch. Only the initial pending attempt may release on rejection.
        if (original.state === 'pending' && (!dispatched || isDefiniteRejection(error)))
          await this.finish(row, 'rejected');
        throw error;
      }
    } finally {
      await this.prisma.karavanMarketplaceConnectionOperation.updateMany({
        where: { id, kind: 'management', leaseId },
        data: { leaseId: null, leaseUntil: null },
      });
    }
  }
}
