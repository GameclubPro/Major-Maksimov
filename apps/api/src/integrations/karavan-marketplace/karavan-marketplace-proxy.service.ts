import {
  KaravanManagementRejected,
  throwKnownKaravanManagementError,
} from './karavan-marketplace-management-errors';
import {
  marketplaceManagementRequestSchema,
  marketplaceManagementResponseSchema,
} from '@maxim/contracts/karavan-marketplace-management';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  karavanMarketplaceAvailableSchema,
  karavanMarketplaceModuleSchema,
  karavanMarketplaceCreateSchema,
  karavanMarketplaceBindingCommandSchema,
  karavanMarketplaceBindingActionSchema,
  karavanMarketplaceBindingResultSchema,
  karavanMarketplaceSummarySchema,
  karavanMarketplaceSetupSchema,
  karavanMarketplaceCheckpointSchema,
  karavanMarketplaceOperationSchema,
  karavanMarketplaceSetupOptionsSchema,
  karavanMarketplaceReviewSchema,
  karavanMarketplacePreviewInputSchema,
  karavanMarketplacePreviewSchema,
  type KaravanMarketplaceAuthorityRequest,
  type KaravanMarketplaceAuthorityScope,
  type KaravanMarketplaceModule,
  type KaravanMarketplaceOperation,
} from '@maxim/contracts/karavan-marketplace';
import { PrismaService } from '../../prisma/prisma.service';
import {
  KaravanMarketplaceAuthorityService,
  karavanHash,
  type KaravanPrincipal,
} from './karavan-marketplace-authority.service';

const moduleInput = z
  .object({ commandId: z.string().min(8).max(120), chatId: z.string().regex(/^-?\d{1,24}$/u) })
  .strict();
const createResult = z.object({ marketplace: karavanMarketplaceSummarySchema });
export class KaravanCommandUnavailable extends ServiceUnavailableException {
  constructor(readonly outcome: 'unknown' | 'rejected') {
    super({
      code: outcome === 'unknown' ? 'KARAVAN_COMMAND_UNKNOWN' : 'KARAVAN_COMMAND_REJECTED',
      message:
        outcome === 'unknown'
          ? 'Результат пока не подтверждён. Повторите проверку этого подключения.'
          : 'Не удалось выполнить действие. Обновите состояние магазина.',
    });
  }
}
class KaravanCreateNotDispatched extends Error {
  constructor(cause: unknown) {
    super('Marketplace creation was not dispatched.', { cause });
  }
}

@Injectable()
export class KaravanMarketplaceProxyService {
  private readonly logger = new Logger(KaravanMarketplaceProxyService.name);
  private readonly accessLogTimes = new Map<string, number>();

  private logAccessIssue(chatId: string, reason: string, detail: Record<string, unknown> = {}) {
    const chatRef = karavanHash({ chatId }).slice(0, 16);
    const key = `${chatRef}:${reason}`;
    const now = Date.now();
    if (now - (this.accessLogTimes.get(key) ?? 0) < 60_000) return;
    if (this.accessLogTimes.size >= 256) {
      const oldest = this.accessLogTimes.keys().next().value;
      if (oldest) this.accessLogTimes.delete(oldest);
    }
    this.accessLogTimes.set(key, now);
    this.logger.warn({ event: 'karavan_marketplace_access', chatRef, reason, ...detail });
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly authority: KaravanMarketplaceAuthorityService,
    private readonly config: ConfigService,
  ) {}

  async command<T>(
    path: string,
    scope: Omit<KaravanMarketplaceAuthorityScope, 'payloadHash'>,
    payload: unknown,
    principal: KaravanPrincipal,
    response: z.ZodType<T>,
  ): Promise<T> {
    let authority: KaravanMarketplaceAuthorityRequest;
    try {
      authority = await this.authority.issue(
        { ...scope, payloadHash: karavanHash(payload) },
        principal,
      );
    } catch (error) {
      // FLAG: This call cannot have created a marketplace before authority succeeds.
      // Setup still preserves any unknown outcome from an earlier dispatch.
      if (scope.action === 'create_marketplace') throw new KaravanCreateNotDispatched(error);
      throw error;
    }
    let result: Response;
    try {
      result = await fetch(
        `${this.config.getOrThrow<string>('KARAVAN_MARKETPLACE_API_BASE_URL').replace(/\/$/u, '')}/api/v1/integrations/maxim/marketplaces${path}`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.config.getOrThrow<string>('KARAVAN_MARKETPLACE_COMMAND_TOKEN')}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ authority, payload }),
          redirect: 'error',
          signal: AbortSignal.timeout(path === '/manage' ? 35_000 : 8_000),
        },
      );
    } catch {
      if (path === '/module') this.logAccessIssue(scope.chatId, 'unavailable');
      throw new KaravanCommandUnavailable('unknown');
    }
    if (
      !result.ok &&
      (path === '/create' ||
        path === '/manage' ||
        /^\/[a-f0-9-]+\/bindings(?:\/action)?$/u.test(path))
    )
      await throwKnownKaravanManagementError(result);
    if (!result.ok) {
      if (path === '/module')
        this.logAccessIssue(scope.chatId, 'upstream_error', { status: result.status });
      throw new KaravanCommandUnavailable(
        result.status >= 500 || result.status === 408 ? 'unknown' : 'rejected',
      );
    }
    try {
      return response.parse(await result.json());
    } catch {
      throw new KaravanCommandUnavailable('unknown');
    }
  }

  async manage(chatId: string, actorMaxUserId: string, raw: unknown, principal: KaravanPrincipal) {
    const payload = marketplaceManagementRequestSchema.parse({ ...(raw as object), chatId });
    return this.command(
      '/manage',
      {
        commandId: payload.commandId,
        chatId,
        actorMaxUserId,
        action: 'manage_shop',
        marketplaceId: payload.marketplaceId,
        expectedBindingGeneration: payload.expectedBindingGeneration,
      },
      payload,
      principal,
      marketplaceManagementResponseSchema,
    );
  }

  async module(
    chatId: string,
    actorMaxUserId: string,
    principal: KaravanPrincipal,
    commandId: string = randomUUID(),
  ): Promise<KaravanMarketplaceModule> {
    const payload = moduleInput.parse({ chatId, commandId });
    const result = await this.command(
      '/module',
      {
        ...payload,
        actorMaxUserId,
        action: 'read_chat_module',
        marketplaceId: null,
        expectedBindingGeneration: null,
      },
      payload,
      principal,
      karavanMarketplaceModuleSchema,
    );
    if (result.binding && result.binding.chatId !== chatId)
      throw new KaravanCommandUnavailable('unknown');
    if (result.access && !['allowed', 'unbound'].includes(result.access.reason)) {
      this.logAccessIssue(chatId, result.access.reason, {
        bindingState: result.binding?.state ?? null,
        generation: result.binding?.generation ?? null,
        canRecover: result.access.canRecover,
      });
    }
    if (result.binding?.state === 'verified' && result.marketplace)
      await this.prisma.karavanMarketplaceChatEnrollment.updateMany({
        where: { chatId, phase: 'pending' },
        data: { phase: 'connected', confirmedAt: new Date(), marketplaceId: result.marketplace.id },
      });
    return result;
  }

  async available(
    chatId: string,
    actorMaxUserId: string,
    principal: KaravanPrincipal,
    cursor: string | null,
  ) {
    const payload = { commandId: randomUUID(), chatId, cursor, limit: 24 };
    return this.command(
      '/available',
      {
        commandId: payload.commandId,
        chatId,
        actorMaxUserId,
        action: 'read_chat_module',
        marketplaceId: null,
        expectedBindingGeneration: null,
      },
      payload,
      principal,
      karavanMarketplaceAvailableSchema,
    );
  }

  async setupOptions(chatId: string, actorMaxUserId: string, principal: KaravanPrincipal) {
    const payload = moduleInput.parse({ commandId: randomUUID(), chatId });
    return this.command(
      '/setup-options',
      {
        ...payload,
        actorMaxUserId,
        action: 'read_chat_module',
        marketplaceId: null,
        expectedBindingGeneration: null,
      },
      payload,
      principal,
      karavanMarketplaceSetupOptionsSchema,
    );
  }

  async preview(actorMaxUserId: string, raw: unknown, principal: KaravanPrincipal) {
    const input = karavanMarketplacePreviewInputSchema.parse(raw);
    let target: z.infer<typeof karavanMarketplaceReviewSchema> | null = null;
    if (input.marketplaceId) {
      const payload = {
        commandId: randomUUID(),
        chatId: input.chatIds[0]!,
        marketplaceId: input.marketplaceId,
      };
      target = await this.command(
        '/review',
        { ...payload, actorMaxUserId, action: 'read_chat_module', expectedBindingGeneration: null },
        payload,
        principal,
        karavanMarketplaceReviewSchema,
      );
      if (!target.permissions.includes('bind_chat') || target.marketplace.status === 'archived')
        throw new ForbiddenException('Этот магазин нельзя подключить.');
    }
    const chats = [];
    for (const chatId of input.chatIds) {
      const module = await this.module(chatId, actorMaxUserId, principal);
      chats.push({
        chatId,
        title: module.currentChatTitle ?? module.binding?.chatTitle ?? 'Чат MAX',
        binding: module.binding,
        marketplace: module.marketplace,
      });
    }
    return karavanMarketplacePreviewSchema.parse({ target, chats });
  }

  async binding(
    marketplaceId: string,
    actorMaxUserId: string,
    raw: unknown,
    principal: KaravanPrincipal,
    action = false,
  ) {
    const actionPayload = action ? karavanMarketplaceBindingActionSchema.parse(raw) : null;
    const payload = actionPayload ?? karavanMarketplaceBindingCommandSchema.parse(raw);
    const result = await this.command(
      `/${marketplaceId}/bindings${action ? '/action' : ''}`,
      {
        commandId: payload.commandId,
        chatId: payload.chatId,
        actorMaxUserId,
        marketplaceId,
        expectedBindingGeneration: payload.expectedBindingGeneration,
        action: actionPayload?.action ?? 'bind_chat',
      },
      payload,
      principal,
      karavanMarketplaceBindingResultSchema,
    );
    if (result.marketplace.id !== marketplaceId) throw new KaravanCommandUnavailable('unknown');
    if (!actionPayload || actionPayload.action !== 'unbind_chat')
      await this.prisma.karavanMarketplaceChatEnrollment.updateMany({
        where: { chatId: payload.chatId },
        data: { phase: 'connected', confirmedAt: new Date(), marketplaceId },
      });
    return result;
  }

  async status(operationId: string, actorMaxUserId: string): Promise<KaravanMarketplaceOperation> {
    const row = await this.prisma.karavanMarketplaceConnectionOperation.findUnique({
      where: { id: operationId },
    });
    if (!row || row.actorMaxUserId !== actorMaxUserId)
      throw new ForbiddenException('Подключение недоступно.');
    return karavanMarketplaceOperationSchema.parse({
      operationId: row.id,
      state: row.state,
      checkpoints: row.checkpoints,
      request: row.request,
    });
  }

  async cancelSetup(operationId: string, actorMaxUserId: string, anchorChatId: string) {
    this.authority.assertEnabled();
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM karavan_marketplace_connection_operations WHERE id=${operationId}::uuid AND actor_max_user_id=${actorMaxUserId} AND anchor_chat_id=${anchorChatId} FOR UPDATE`;
      if (!rows.length) throw new ForbiddenException('Подключение недоступно.');
      const row = await tx.karavanMarketplaceConnectionOperation.findUniqueOrThrow({
        where: { id: operationId },
      });
      if (['cancelled', 'complete', 'rejected'].includes(row.state)) return;
      const checkpoints = karavanMarketplaceCheckpointSchema.parse(row.checkpoints);
      // Never release an intent while a remote effect may still be running or unknown.
      if (
        row.leaseId ||
        row.state === 'unknown' ||
        checkpoints.bindings.some((item) => item.state === 'unknown')
      )
        throw new ConflictException('Сначала проверьте результат незавершённого подключения.');
      await tx.karavanMarketplaceConnectionOperation.update({
        where: { id: operationId },
        data: { state: 'cancelled', activeScopeKey: null },
      });
    });
    return this.status(operationId, actorMaxUserId);
  }

  async activeSetup(actorMaxUserId: string, anchorChatId: string) {
    const row = await this.prisma.karavanMarketplaceConnectionOperation.findUnique({
      where: { activeScopeKey: `${actorMaxUserId}:${anchorChatId}` },
      select: { id: true },
    });
    return row ? this.status(row.id, actorMaxUserId) : null;
  }

  async setup(
    actorMaxUserId: string,
    raw: unknown,
    principal: KaravanPrincipal,
  ): Promise<KaravanMarketplaceOperation> {
    this.authority.assertEnabled();
    let input = karavanMarketplaceSetupSchema.parse(raw);
    const requestHash = karavanHash(input);
    const leaseId = randomUUID();
    await this.authority.assertPrincipal(principal, actorMaxUserId);
    // FLAG: One active setup per actor and entry chat survives tabs, lost local storage and devices.
    const activeScopeKey = `${actorMaxUserId}:${input.chatIds[0]}`;
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`karavan-setup:${activeScopeKey}`}))`;
      const existing = await tx.karavanMarketplaceConnectionOperation.findUnique({
        where: { id: input.operationId },
      });
      if (existing) {
        if (existing.actorMaxUserId !== actorMaxUserId || existing.requestHash !== requestHash)
          throw new ConflictException('Подключение уже создано с другими параметрами.');
        return existing;
      }
      const active = await tx.karavanMarketplaceConnectionOperation.findUnique({
        where: { activeScopeKey },
      });
      if (active) {
        if (active.requestHash !== karavanHash({ ...input, operationId: active.id }))
          throw new ConflictException({
            code: 'KARAVAN_SETUP_IN_PROGRESS',
            message:
              'В этом чате уже начато подключение с другими настройками. Продолжите сохранённое подключение.',
          });
        return active;
      }
      return tx.karavanMarketplaceConnectionOperation.create({
        data: {
          id: input.operationId,
          actorMaxUserId,
          anchorChatId: input.chatIds[0]!,
          activeScopeKey,
          requestHash,
          request: input,
          state: 'pending',
          checkpoints: {
            marketplaceId: input.existingMarketplaceId ?? null,
            bindings: input.chatIds.map((chatId) => ({
              chatId,
              state: 'pending',
              bindingId: null,
              generation: null,
            })),
          },
        },
      });
    });
    input = karavanMarketplaceSetupSchema.parse(row.request);
    if (row.state === 'complete' || row.state === 'rejected' || row.state === 'cancelled')
      return this.status(input.operationId, actorMaxUserId);
    const lease = await this.prisma.karavanMarketplaceConnectionOperation.updateMany({
      where: {
        id: input.operationId,
        actorMaxUserId,
        activeScopeKey,
        state: { in: ['pending', 'partial', 'unknown'] },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
      },
      data: { leaseId, leaseUntil: new Date(Date.now() + 90_000) },
    });
    if (lease.count !== 1) return this.status(input.operationId, actorMaxUserId);
    const leased = await this.prisma.karavanMarketplaceConnectionOperation.findUniqueOrThrow({
      where: { id: input.operationId },
    });
    const checkpoints = karavanMarketplaceCheckpointSchema.parse(leased.checkpoints);
    const checkpoint = async (state: KaravanMarketplaceOperation['state']) => {
      const saved = await this.prisma.karavanMarketplaceConnectionOperation.updateMany({
        where: { id: input.operationId, leaseId },
        data: {
          state,
          checkpoints,
          activeScopeKey: state === 'complete' || state === 'rejected' ? null : activeScopeKey,
          leaseUntil: new Date(Date.now() + 90_000),
        },
      });
      if (saved.count !== 1)
        throw new ConflictException('Подключение уже продолжено в другой вкладке.');
    };
    try {
      if (!checkpoints.marketplaceId) {
        if (!input.create) throw new ConflictException('Выберите магазин повторно.');
        // FLAG: Persist uncertainty before the remote call so a process crash cannot release its intent.
        await checkpoint('unknown');
        const payload = karavanMarketplaceCreateSchema.parse({
          ...input.create,
          commandId: `${input.operationId}:create`,
        });
        try {
          const result = await this.command(
            '/create',
            {
              commandId: payload.commandId,
              actorMaxUserId,
              chatId: input.chatIds[0]!,
              action: 'create_marketplace',
              marketplaceId: null,
              expectedBindingGeneration: null,
            },
            payload,
            principal,
            createResult,
          );
          checkpoints.marketplaceId = result.marketplace.id;
          await checkpoint('pending');
          return this.status(input.operationId, actorMaxUserId);
        } catch (error) {
          await checkpoint(
            leased.state !== 'unknown' &&
              (error instanceof KaravanCreateNotDispatched ||
                error instanceof KaravanManagementRejected ||
                (error instanceof KaravanCommandUnavailable && error.outcome === 'rejected'))
              ? 'rejected'
              : 'unknown',
          );
          return this.status(input.operationId, actorMaxUserId);
        }
      }
      // FLAG: Independent chats progress before retrying an earlier rejected or uncertain binding.
      const nextPending = checkpoints.bindings.findIndex((item) => item.state === 'pending');
      const nextIndex =
        nextPending >= 0
          ? nextPending
          : checkpoints.bindings.findIndex((item) => item.state !== 'connected');
      if (nextIndex >= 0) {
        const index = nextIndex;
        const binding = checkpoints.bindings[index]!;
        const bindingWasUnknown = binding.state === 'unknown';
        // Persist uncertainty before crossing the service boundary so process loss cannot make a committed binding cancellable.
        binding.state = 'unknown';
        await checkpoint('pending');
        try {
          const expected = input.bindingExpectations?.find(
            (item) => item.chatId === binding.chatId,
          );
          const bindingAction = expected?.action ?? 'bind_chat';
          const result = await this.binding(
            checkpoints.marketplaceId,
            actorMaxUserId,
            {
              commandId: `${input.operationId}:bind:${index}`,
              chatId: binding.chatId,
              expectedBindingGeneration: expected?.generation ?? null,
              ...(input.expectedPolicyRevision === undefined
                ? {}
                : { expectedPolicyRevision: input.expectedPolicyRevision }),
              ...(bindingAction === 'bind_chat' ? {} : { action: bindingAction }),
            },
            principal,
            bindingAction !== 'bind_chat',
          );
          binding.state = 'connected';
          binding.bindingId = result.bindingId;
          binding.generation = result.generation;
        } catch (error) {
          binding.state =
            bindingWasUnknown ||
            (error instanceof KaravanCommandUnavailable && error.outcome === 'unknown')
              ? 'unknown'
              : 'failed';
        }
        await checkpoint(
          checkpoints.bindings.every((item) => item.state === 'connected')
            ? 'complete'
            : checkpoints.bindings.some((item) => item.state === 'pending')
              ? 'pending'
              : 'partial',
        );
        return this.status(input.operationId, actorMaxUserId);
      }
      return this.status(input.operationId, actorMaxUserId);
    } finally {
      await this.prisma.karavanMarketplaceConnectionOperation.updateMany({
        where: { id: input.operationId, leaseId },
        data: { leaseId: null, leaseUntil: null },
      });
    }
  }
}
