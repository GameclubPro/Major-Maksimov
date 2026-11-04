import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  karavanMarketplaceAuthorityScopeSchema,
  type KaravanMarketplaceModule,
} from '@maxim/contracts/karavan-marketplace';
import type { KaravanConnectionBindingInput } from '@maxim/contracts/karavan-marketplace-connection';
import { PrismaClient, createPrismaAdapter } from '../../prisma/prisma-client';
import type { PrismaService } from '../../prisma/prisma.service';
import {
  karavanHash,
  type KaravanMarketplaceAuthorityService,
  type KaravanPrincipal,
} from './karavan-marketplace-authority.service';
import {
  KaravanBindingNotDispatched,
  KaravanCommandUnavailable,
  type KaravanMarketplaceProxyService,
} from './karavan-marketplace-proxy.service';
import { KaravanMarketplaceConnectionsService } from './karavan-marketplace-connections.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const postgres = databaseUrl ? describe : describe.skip;
jest.setTimeout(30_000);

type AuthorityPort = Pick<
  KaravanMarketplaceAuthorityService,
  'assertEnabled' | 'assertPrincipal' | 'collect'
>;
type ProxyPort = Pick<
  KaravanMarketplaceProxyService,
  'binding' | 'module' | 'status' | 'activeSetup' | 'settleSetup'
>;
type BindingResult = Awaited<ReturnType<ProxyPort['binding']>>;

postgres('Karavan durable binding recovery', () => {
  let db: PrismaClient;
  let service: KaravanMarketplaceConnectionsService;
  let actor: string;
  let chatId: string;
  let input: KaravanConnectionBindingInput;
  let result: BindingResult;
  let fetchSpy: jest.SpyInstance<ReturnType<typeof fetch>, Parameters<typeof fetch>>;
  const actors = new Set<string>();
  const chats = new Set<string>();
  const principal: KaravanPrincipal = {
    source: 'session',
    principalKey: 'a'.repeat(64),
    launchBotId: 'synthetic-major-bot',
  };
  const authority: jest.Mocked<AuthorityPort> = {
    assertEnabled: jest.fn(),
    assertPrincipal: jest.fn(),
    collect: jest.fn(),
  };
  const proxy: jest.Mocked<ProxyPort> = {
    binding: jest.fn(),
    module: jest.fn(),
    status: jest.fn(),
    activeSetup: jest.fn(),
    settleSetup: jest.fn(),
  };
  const config = new ConfigService({
    KARAVAN_MARKETPLACE_API_BASE_URL: 'https://synthetic-karavan.invalid',
    KARAVAN_MARKETPLACE_COMMAND_TOKEN: 'synthetic-command-token',
  });

  function newService() {
    return new KaravanMarketplaceConnectionsService(
      db as PrismaService,
      proxy as unknown as KaravanMarketplaceProxyService,
      authority as unknown as KaravanMarketplaceAuthorityService,
      config,
    );
  }

  function moduleView(generation?: number): KaravanMarketplaceModule {
    return {
      marketplace: generation ? result.marketplace : null,
      binding: generation
        ? {
            id: result.bindingId,
            chatId,
            chatTitle: 'Synthetic chat',
            state: 'verified',
            generation,
            revision: 1,
            verifiedAt: new Date().toISOString(),
          }
        : null,
      canManage: true,
      permissions: ['bind_chat'],
      counts: { listings: 0, pendingApplications: 0, chats: generation ? 1 : 0 },
    };
  }

  function requestScope() {
    const payload = {
      commandId: input.commandId,
      chatId,
      expectedBindingGeneration: input.expectedBindingGeneration,
      ...(input.action === 'bind_chat' ? {} : { action: input.action }),
    };
    return karavanMarketplaceAuthorityScopeSchema.parse({
      actorMaxUserId: actor,
      chatId,
      commandId: input.commandId,
      action: input.action,
      marketplaceId: input.marketplaceId,
      expectedBindingGeneration: input.expectedBindingGeneration,
      payloadHash: karavanHash(payload),
    });
  }

  function receipt(requestHash?: string) {
    return {
      status: 'found',
      commandId: input.commandId,
      requestHash: requestHash ?? karavanHash(requestScope()),
      response: result,
    };
  }

  function persisted() {
    return db.karavanMarketplaceConnectionOperation.findUniqueOrThrow({
      where: { id: input.commandId },
    });
  }
  function scope() {
    return db.karavanMarketplaceConnectionScope.findUniqueOrThrow({ where: { chatId } });
  }
  async function importUnknown() {
    await originalGrant();
    return service.bind(chatId, actor, input, principal, true);
  }

  async function originalGrant(scopeHash = karavanHash(requestScope())) {
    const checkedAt = new Date(Date.now() - 120_000);
    return db.karavanMarketplaceAuthorityGrant.create({
      data: {
        actorMaxUserId: actor,
        commandId: input.commandId,
        chatId,
        botId: 'synthetic-major-bot',
        proofHash: karavanHash({ id: randomUUID() }),
        scopeHash,
        scope: requestScope(),
        authorityEpoch: 'synthetic-epoch',
        principal,
        checkedAt,
        expiresAt: new Date(checkedAt.getTime() + 60_000),
      },
    });
  }

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test database required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 6, statement_timeout: 10_000 }),
    });
    await db.$connect();
  });
  beforeEach(() => {
    jest.resetAllMocks();
    actor = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
    chatId = `-${actor}`;
    actors.add(actor);
    chats.add(chatId);
    input = {
      marketplaceId: randomUUID(),
      commandId: randomUUID(),
      action: 'bind_chat',
      expectedBindingGeneration: null,
      expectedConnectionRevision: 0,
    };
    result = {
      marketplace: {
        id: input.marketplaceId,
        networkId: randomUUID(),
        publicSlug: 'synthetic-shop',
        name: 'Synthetic shop',
        description: null,
        kind: 'chat',
        status: 'active',
        admissionPolicy: 'applications',
        logoImageUrl: null,
        coverImageUrl: null,
        editRevision: 1,
        policyRevision: 1,
        orderRevision: 1,
        visibilityRevision: 1,
      },
      bindingId: randomUUID(),
      generation: 1,
    };
    authority.assertPrincipal.mockResolvedValue(undefined);
    authority.collect.mockImplementation(async (target, owner) => ({
      chatId: target,
      actorMaxUserId: owner,
      botId: 'synthetic-major-bot',
      checkedAt: new Date(),
      authorityEpoch: 'synthetic-epoch',
      chatTitle: 'Synthetic chat',
    }));
    proxy.activeSetup.mockResolvedValue(null);
    proxy.settleSetup.mockResolvedValue(undefined);
    proxy.module.mockImplementation(async () => moduleView());
    proxy.binding.mockImplementation(
      async (_marketplaceId, _actor, _raw, _principal, _action, beforeDispatch) => {
        await beforeDispatch?.();
        return result;
      },
    );
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(
      async () =>
        new Response(JSON.stringify({ status: 'not_found', commandId: input.commandId }), {
          status: 200,
        }),
    );
    service = newService();
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await db.karavanMarketplaceConnectionScope.deleteMany({
      where: {
        OR: [
          { chatId: { in: [...chats] } },
          { activeOperation: { actorMaxUserId: { in: [...actors] } } },
          { lastOperation: { actorMaxUserId: { in: [...actors] } } },
        ],
      },
    });
    await db.karavanMarketplaceConnectionOperation.deleteMany({
      where: { actorMaxUserId: { in: [...actors] } },
    });
    await db.karavanMarketplaceAuthorityGrant.deleteMany({
      where: { actorMaxUserId: { in: [...actors] } },
    });
    actors.clear();
    chats.clear();
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  it('commits identity, request and uncertainty before dispatch and replays the same ID across devices', async () => {
    proxy.binding.mockImplementation(
      async (_marketplaceId, _actor, raw, _principal, _action, beforeDispatch) => {
        expect(raw).toMatchObject({ commandId: input.commandId, chatId });
        expect(await persisted()).toMatchObject({
          id: input.commandId,
          state: 'unknown',
          request: input,
          requestHash: karavanHash(input),
        });
        expect((await scope()).activeOperationId).toBe(input.commandId);
        await beforeDispatch?.();
        return result;
      },
    );
    const first = await service.bind(chatId, actor, input, principal);
    expect(first).toMatchObject({ operationId: input.commandId, state: 'complete' });
    expect(await newService().bind(chatId, actor, input, principal)).toEqual(first);
    expect(proxy.binding).toHaveBeenCalledTimes(1);
    expect(await newService().snapshot(chatId, actor, principal)).toMatchObject({
      revision: 1,
      blocked: false,
      operation: { kind: 'binding', operation: first },
    });
    expect((await scope()).activeOperationId).toBeNull();
  });

  it('admits simultaneous copies of one command once', async () => {
    const outputs = await Promise.all([
      service.bind(chatId, actor, input, principal),
      newService().bind(chatId, actor, input, principal),
    ]);
    expect(outputs.map(({ operationId }) => operationId)).toEqual([
      input.commandId,
      input.commandId,
    ]);
    expect(proxy.binding).toHaveBeenCalledTimes(1);
    expect(
      await db.karavanMarketplaceConnectionOperation.count({ where: { actorMaxUserId: actor } }),
    ).toBe(1);
    expect((await scope()).revision).toBe(1);
  });

  it('retains a lost result after lease timeout and rights loss on another device', async () => {
    proxy.binding.mockRejectedValueOnce(new KaravanCommandUnavailable('unknown'));
    expect(await service.bind(chatId, actor, input, principal)).toMatchObject({ state: 'unknown' });
    await db.karavanMarketplaceConnectionOperation.update({
      where: { id: input.commandId },
      data: { leaseId: randomUUID(), leaseUntil: new Date(0) },
    });
    authority.collect.mockRejectedValue(new ForbiddenException('Rights lost'));
    proxy.module.mockRejectedValue(new ForbiddenException('Rights lost'));
    expect(await newService().status(chatId, actor, input.commandId, principal)).toMatchObject({
      state: 'unknown',
    });
    await expect(
      newService().resume(chatId, actor, input.commandId, principal),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(await persisted()).toMatchObject({ state: 'unknown', leaseId: null, leaseUntil: null });
    expect((await scope()).activeOperationId).toBe(input.commandId);
    expect(proxy.binding).toHaveBeenCalledTimes(1);
    const otherActor = `${actor}1`;
    actors.add(otherActor);
    authority.collect.mockResolvedValueOnce({
      chatId,
      actorMaxUserId: otherActor,
      botId: 'synthetic-major-bot',
      checkedAt: new Date(),
      authorityEpoch: 'another-epoch',
      chatTitle: 'Synthetic chat',
    });
    await expect(
      service.bind(chatId, otherActor, { ...input, commandId: randomUUID() }, principal),
    ).rejects.toThrow();
    expect((await scope()).activeOperationId).toBe(input.commandId);
  });

  it('adopts an original grant as uncertainty and completes from its exact receipt after rights loss', async () => {
    await originalGrant();
    authority.collect.mockRejectedValue(new ForbiddenException('Rights lost'));
    proxy.module.mockRejectedValue(new ForbiddenException('Rights lost'));
    fetchSpy.mockImplementation(async () => {
      expect(await persisted()).toMatchObject({ state: 'unknown', request: input });
      return new Response(JSON.stringify(receipt()), { status: 200 });
    });
    expect(await service.bind(chatId, actor, input, principal)).toMatchObject({
      operationId: input.commandId,
      state: 'complete',
      result: { bindingId: result.bindingId, generation: result.generation },
    });
    expect(authority.collect).not.toHaveBeenCalled();
    expect(proxy.binding).not.toHaveBeenCalled();
    expect(proxy.module).not.toHaveBeenCalled();
    expect((await scope()).activeOperationId).toBeNull();
  });

  it('retains an adopted original grant after an absent receipt and a fresh preparation rejection', async () => {
    await originalGrant();
    authority.collect.mockRejectedValue(new ForbiddenException('Rights lost'));
    proxy.binding.mockRejectedValue(
      new KaravanBindingNotDispatched(new ForbiddenException('Rights lost')),
    );
    expect(await service.bind(chatId, actor, input, principal)).toMatchObject({
      state: 'unknown',
      result: null,
    });
    expect(authority.collect).not.toHaveBeenCalled();
    expect(proxy.binding).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await persisted()).toMatchObject({ state: 'unknown', request: input, errorCode: null });
    expect((await scope()).activeOperationId).toBe(input.commandId);
  });

  it('refuses a mismatched original grant without adopting or dispatching it', async () => {
    await originalGrant('b'.repeat(64));
    await expect(service.bind(chatId, actor, input, principal)).rejects.toThrow('другому действию');
    expect(
      await db.karavanMarketplaceConnectionOperation.findUnique({ where: { id: input.commandId } }),
    ).toBeNull();
    expect(await db.karavanMarketplaceConnectionScope.findUnique({ where: { chatId } })).toBeNull();
    expect(proxy.binding).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(authority.collect).not.toHaveBeenCalled();
  });

  it('refuses an arbitrary marketplace import without an original grant or exact receipt', async () => {
    await expect(service.bind(chatId, actor, input, principal, true)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(
      await db.karavanMarketplaceConnectionOperation.findUnique({ where: { id: input.commandId } }),
    ).toBeNull();
    expect(
      await db.karavanMarketplaceConnectionScope.findMany({
        where: { chatId: { in: [chatId, `marketplace:${input.marketplaceId}`] } },
      }),
    ).toEqual([]);
    expect(authority.collect).not.toHaveBeenCalled();
    expect(proxy.binding).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not adopt a receipt-only import with a different semantic hash', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(receipt('b'.repeat(64))), { status: 200 }),
    );
    await expect(service.bind(chatId, actor, input, principal, true)).rejects.toThrow();
    expect(
      await db.karavanMarketplaceConnectionOperation.findUnique({ where: { id: input.commandId } }),
    ).toBeNull();
    expect(
      await db.karavanMarketplaceConnectionScope.findMany({
        where: { chatId: { in: [chatId, `marketplace:${input.marketplaceId}`] } },
      }),
    ).toEqual([]);
    expect(authority.collect).not.toHaveBeenCalled();
    expect(proxy.binding).not.toHaveBeenCalled();
  });

  it('adopts an exact receipt-only import as terminal without fresh authorization or dispatch', async () => {
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(receipt()), { status: 200 }));
    expect(await service.bind(chatId, actor, input, principal, true)).toMatchObject({
      operationId: input.commandId,
      state: 'complete',
      result: { bindingId: result.bindingId, generation: result.generation },
    });
    expect(await persisted()).toMatchObject({ state: 'complete', request: input, result });
    expect(
      (await db.karavanMarketplaceConnectionScope.findUnique({ where: { chatId } }))
        ?.activeOperationId ?? null,
    ).toBeNull();
    expect(
      (
        await db.karavanMarketplaceConnectionScope.findUnique({
          where: { chatId: `marketplace:${input.marketplaceId}` },
        })
      )?.activeOperationId ?? null,
    ).toBeNull();
    expect(authority.collect).not.toHaveBeenCalled();
    expect(proxy.binding).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('classifies a prior dispatch from the leased row when the initial read still saw pending', async () => {
    await importUnknown();
    await db.karavanMarketplaceConnectionOperation.update({
      where: { id: input.commandId },
      data: { state: 'pending' },
    });
    proxy.binding.mockRejectedValue(
      new KaravanBindingNotDispatched(new ForbiddenException('Rights lost')),
    );
    let resumed: ReturnType<KaravanMarketplaceConnectionsService['resume']> | undefined;
    let output: Awaited<ReturnType<KaravanMarketplaceConnectionsService['resume']>> | undefined;
    try {
      await db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM karavan_marketplace_connection_operations WHERE id = ${input.commandId}::uuid FOR UPDATE`;
          resumed = service.resume(chatId, actor, input.commandId, principal);
          let waiting = false;
          const deadline = Date.now() + 3_000;
          while (Date.now() < deadline) {
            await tx.$executeRaw`SELECT pg_stat_clear_snapshot()`;
            const blocked = await tx.$queryRaw<Array<{ pid: number }>>`
            SELECT pid FROM pg_stat_activity
            WHERE datname = current_database() AND pid <> pg_backend_pid()
              AND wait_event_type = 'Lock'
              AND query LIKE '%UPDATE%karavan_marketplace_connection_operations%'
            LIMIT 1`;
            if (blocked.length) {
              waiting = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(waiting).toBe(true);
          await tx.karavanMarketplaceConnectionOperation.update({
            where: { id: input.commandId },
            data: { state: 'unknown' },
          });
        },
        { timeout: 10_000 },
      );
    } finally {
      output = await resumed;
    }
    expect(output).toMatchObject({ state: 'unknown', result: null });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((await persisted()).state).toBe('unknown');
    expect((await scope()).activeOperationId).toBe(input.commandId);
  });

  it('reads an exact provider receipt without writes, execution or releasing the reservation', async () => {
    await importUnknown();
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(receipt()), { status: 200 }));
    const before = { operation: await persisted(), scope: await scope() };
    const output = await service.status(chatId, actor, input.commandId, principal);
    expect(output).toMatchObject({
      operationId: input.commandId,
      state: 'complete',
      result: { bindingId: result.bindingId, generation: result.generation },
    });
    expect({ operation: await persisted(), scope: await scope() }).toEqual(before);
    expect(proxy.binding).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const request = fetchSpy.mock.calls[0]![1];
    expect(JSON.parse(request!.body as string)).toMatchObject({
      commandId: input.commandId,
      actorMaxUserId: actor,
      chatId,
      marketplaceId: input.marketplaceId,
    });
  });

  it('preserves an unknown operation when a provider receipt has another semantic hash', async () => {
    await importUnknown();
    fetchSpy.mockImplementation(
      async () => new Response(JSON.stringify(receipt('b'.repeat(64))), { status: 200 }),
    );
    const before = { operation: await persisted(), scope: await scope() };
    await expect(service.status(chatId, actor, input.commandId, principal)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect({ operation: await persisted(), scope: await scope() }).toEqual(before);
    await expect(service.resume(chatId, actor, input.commandId, principal)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect((await persisted()).state).toBe('unknown');
    expect((await scope()).activeOperationId).toBe(input.commandId);
    expect(proxy.binding).not.toHaveBeenCalled();
  });

  it('shows another administrator only a private conflict and denies changed actor or anchor', async () => {
    await importUnknown();
    const otherActor = `${actor}1`;
    const snapshot = await service.snapshot(chatId, otherActor, principal);
    expect(snapshot).toEqual({ version: 2, revision: 1, blocked: true, operation: null });
    for (const privateValue of [input.commandId, input.marketplaceId, actor])
      expect(JSON.stringify(snapshot)).not.toContain(privateValue);
    await expect(
      service.status(`${chatId}1`, actor, input.commandId, principal),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.status(chatId, otherActor, input.commandId, principal),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(proxy.binding).not.toHaveBeenCalled();
  });

  it('explicitly resumes the original imported command with its original request', async () => {
    await importUnknown();
    const originalRequest = (await persisted()).request;
    expect(await newService().resume(chatId, actor, input.commandId, principal)).toMatchObject({
      operationId: input.commandId,
      state: 'complete',
    });
    expect(proxy.binding).toHaveBeenCalledTimes(1);
    expect(proxy.binding.mock.calls[0]![2]).toEqual({
      commandId: input.commandId,
      chatId,
      expectedBindingGeneration: input.expectedBindingGeneration,
    });
    expect((await persisted()).request).toEqual(originalRequest);
    expect((await scope()).activeOperationId).toBeNull();
  });

  it('shows a private conflict for a legacy multi-chat reservation without creating scope rows', async () => {
    const otherActor = `${actor}1`;
    const anchor = `${chatId}1`;
    const operationId = randomUUID();
    actors.add(otherActor);
    chats.add(anchor);
    await db.karavanMarketplaceConnectionOperation.create({
      data: {
        id: operationId,
        actorMaxUserId: otherActor,
        anchorChatId: anchor,
        activeScopeKey: `${otherActor}:${anchor}`,
        state: 'partial',
        requestHash: 'a'.repeat(64),
        request: {
          operationId,
          chatIds: [anchor, chatId],
          existingMarketplaceId: input.marketplaceId,
          expectedPolicyRevision: 1,
        },
        checkpoints: { marketplaceId: input.marketplaceId, bindings: [] },
      },
    });
    const before = await db.karavanMarketplaceConnectionOperation.findUniqueOrThrow({
      where: { id: operationId },
    });
    expect(await service.snapshot(chatId, actor, principal)).toEqual({
      version: 2,
      revision: 0,
      blocked: true,
      operation: null,
    });
    expect(
      await db.karavanMarketplaceConnectionScope.count({
        where: { chatId: { in: [anchor, chatId] } },
      }),
    ).toBe(0);
    expect(
      await db.karavanMarketplaceConnectionOperation.findUniqueOrThrow({
        where: { id: operationId },
      }),
    ).toEqual(before);
    expect(proxy.binding).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('records supersession by a strictly newer generation separately from completion', async () => {
    input.expectedBindingGeneration = 3;
    await importUnknown();
    proxy.module.mockResolvedValueOnce(moduleView(3));
    proxy.binding.mockRejectedValueOnce(new KaravanCommandUnavailable('unknown'));
    expect(await service.resume(chatId, actor, input.commandId, principal)).toMatchObject({
      state: 'unknown',
    });
    expect((await persisted()).state).toBe('unknown');
    proxy.module.mockResolvedValueOnce(moduleView(4));
    expect(await service.resume(chatId, actor, input.commandId, principal)).toMatchObject({
      state: 'superseded',
      result: null,
    });
    expect(await persisted()).toMatchObject({
      state: 'superseded',
      result: null,
      errorCode: 'KARAVAN_CONNECTION_SUPERSEDED',
    });
    expect(await scope()).toMatchObject({
      activeOperationId: null,
      lastOperationId: input.commandId,
      revision: 1,
    });
    expect(await service.status(chatId, actor, input.commandId, principal)).toMatchObject({
      state: 'superseded',
      result: null,
    });
    expect(proxy.binding).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('refuses the final dispatch after the worker execution lease was replaced', async () => {
    let effects = 0;
    const replacementLease = randomUUID();
    proxy.binding.mockImplementation(
      async (_marketplaceId, _actor, _raw, _principal, _action, beforeDispatch) => {
        await db.karavanMarketplaceConnectionOperation.update({
          where: { id: input.commandId },
          data: { leaseId: replacementLease, leaseUntil: new Date(Date.now() + 90_000) },
        });
        expect(beforeDispatch).toBeDefined();
        try {
          await beforeDispatch!();
        } catch (error) {
          throw new KaravanBindingNotDispatched(error);
        }
        effects += 1;
        return result;
      },
    );
    expect(await service.bind(chatId, actor, input, principal)).toMatchObject({ state: 'unknown' });
    expect(effects).toBe(0);
    expect(await persisted()).toMatchObject({ state: 'unknown', leaseId: replacementLease });
    expect((await scope()).activeOperationId).toBe(input.commandId);
  });
});
