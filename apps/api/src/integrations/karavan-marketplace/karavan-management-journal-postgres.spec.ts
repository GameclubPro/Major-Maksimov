import { ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  karavanMarketplaceAuthorityScopeSchema,
  karavanMarketplaceBindingResultSchema,
} from '@maxim/contracts/karavan-marketplace';
import { karavanConnectionBindingInputSchema } from '@maxim/contracts/karavan-marketplace-connection';
import {
  marketplaceManagementRequestSchema,
  marketplaceManagementResponseSchema,
  type MarketplaceManagementRequest,
  type MarketplaceManagementResponse,
} from '@maxim/contracts/karavan-marketplace-management';
import { PrismaClient, createPrismaAdapter } from '../../prisma/prisma-client';
import type { PrismaService } from '../../prisma/prisma.service';
import { ConnectionJournal } from './karavan-connection-journal';
import { karavanHash } from './karavan-marketplace-authority.service';
import {
  ManagementJournal,
  managementOperationId,
  managementReceiptHash,
} from './karavan-management-journal';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const postgres = databaseUrl ? describe : describe.skip;
jest.setTimeout(30_000);

postgres('Karavan daily and connection durable admission', () => {
  let db: PrismaClient;
  let journal: ConnectionJournal;
  let service: ManagementJournal;
  let actor: string;
  let chatId: string;
  let marketplaceId: string;
  let payload: MarketplaceManagementRequest;
  const ids = new Set<string>();
  const grantIds = new Set<string>();
  const config = new ConfigService({
    KARAVAN_MARKETPLACE_API_BASE_URL: 'https://synthetic-karavan.invalid',
    KARAVAN_MARKETPLACE_COMMAND_TOKEN: 'synthetic-command',
  });
  const response = marketplaceManagementResponseSchema.parse({
    operation: 'pins_save',
    data: { revision: 2, offers: [] },
  });
  const definite = (error: unknown) => error instanceof ForbiddenException;
  let fetchSpy: jest.SpyInstance<ReturnType<typeof fetch>, Parameters<typeof fetch>>;

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
    journal = new ConnectionJournal(db as PrismaService);
    service = new ManagementJournal(db as PrismaService, config);
  });
  beforeEach(() => {
    actor = `${Date.now()}${Math.floor(Math.random() * 100000)}`;
    chatId = `-${actor}`;
    marketplaceId = randomUUID();
    payload = request();
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('Unexpected external request');
    });
  });
  afterEach(async () => {
    fetchSpy.mockRestore();
    await db.karavanMarketplaceConnectionScope.deleteMany({
      where: {
        OR: [{ activeOperationId: { in: [...ids] } }, { lastOperationId: { in: [...ids] } }],
      },
    });
    await db.karavanMarketplaceConnectionOperation.deleteMany({ where: { id: { in: [...ids] } } });
    await db.karavanMarketplaceAuthorityGrant.deleteMany({ where: { id: { in: [...grantIds] } } });
    ids.clear();
    grantIds.clear();
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  function request(commandId: string = randomUUID(), targetChat = chatId, market = marketplaceId) {
    ids.add(managementOperationId(actor, commandId));
    return marketplaceManagementRequestSchema.parse({
      commandId,
      chatId: targetChat,
      marketplaceId: market,
      expectedBindingGeneration: 1,
      command: { operation: 'pins_save', input: { commandId, expectedRevision: 1, offers: [] } },
    });
  }
  function run(
    input = payload,
    dispatch: Parameters<ManagementJournal['run']>[2] = async (before) => {
      await before();
      return response;
    },
  ) {
    return service.run(actor, input, dispatch, definite);
  }
  async function row(input = payload) {
    return db.karavanMarketplaceConnectionOperation.findUniqueOrThrow({
      where: { id: managementOperationId(actor, input.commandId) },
    });
  }
  async function legacyGrant(input = payload, expired = false) {
    const id = randomUUID();
    grantIds.add(id);
    const checkedAt = new Date(Date.now() - (expired ? 120_000 : 0));
    const scope = karavanMarketplaceAuthorityScopeSchema.parse({
      actorMaxUserId: actor,
      chatId: input.chatId,
      commandId: input.commandId,
      action: 'manage_shop',
      marketplaceId: input.marketplaceId,
      expectedBindingGeneration: input.expectedBindingGeneration,
      payloadHash: karavanHash(input),
    });
    return db.karavanMarketplaceAuthorityGrant.create({
      data: {
        id,
        actorMaxUserId: actor,
        commandId: input.commandId,
        chatId: input.chatId,
        botId: 'synthetic-major-bot',
        proofHash: karavanHash({ id }),
        scopeHash: karavanHash(scope),
        scope,
        authorityEpoch: 'a'.repeat(64),
        principal: {
          source: 'session',
          principalKey: 'a'.repeat(64),
          launchBotId: 'synthetic-major-bot',
        },
        checkedAt,
        expiresAt: new Date(checkedAt.getTime() + 60_000),
      },
    });
  }
  async function connection(targetChat = chatId, market = marketplaceId) {
    const id = randomUUID();
    ids.add(id);
    return db.$transaction(async (tx) => {
      await tx.karavanMarketplaceConnectionOperation.create({
        data: {
          id,
          kind: 'binding',
          actorMaxUserId: `${actor}1`,
          anchorChatId: targetChat,
          activeScopeKey: `${actor}1:${targetChat}`,
          requestHash: 'a'.repeat(64),
          request: { marketplaceId: market },
          checkpoints: { marketplaceId: market, bindings: [] },
          state: 'pending',
        },
      });
      await journal.claim(tx, {
        operationId: id,
        anchorChatId: targetChat,
        chatIds: [targetChat],
        marketplaceIds: [market],
      });
      return id;
    });
  }
  async function unknownBinding() {
    const id = randomUUID();
    ids.add(id);
    const input = karavanConnectionBindingInputSchema.parse({
      commandId: id,
      marketplaceId,
      action: 'recover_chat',
      expectedBindingGeneration: 1,
      expectedConnectionRevision: 0,
    });
    const scope = karavanMarketplaceAuthorityScopeSchema.parse({
      actorMaxUserId: actor,
      chatId,
      commandId: id,
      action: input.action,
      marketplaceId,
      expectedBindingGeneration: 1,
      payloadHash: karavanHash({
        commandId: id,
        chatId,
        expectedBindingGeneration: 1,
        action: input.action,
      }),
    });
    await db.$transaction(async (tx) => {
      await tx.karavanMarketplaceConnectionOperation.create({
        data: {
          id,
          actorMaxUserId: actor,
          anchorChatId: chatId,
          activeScopeKey: `${actor}:${chatId}`,
          kind: 'binding',
          state: 'unknown',
          request: input,
          requestHash: karavanHash(input),
          checkpoints: { marketplaceId, bindings: [] },
        },
      });
      await journal.claim(tx, {
        operationId: id,
        anchorChatId: chatId,
        chatIds: [chatId],
        marketplaceIds: [marketplaceId],
      });
    });
    return { id, scope };
  }
  function receipt(
    input = payload,
    value: unknown = response,
    override: Record<string, unknown> = {},
  ) {
    fetchSpy.mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'found',
          commandId: input.commandId,
          requestHash: managementReceiptHash(input),
          managementRequestHash: karavanHash(input),
          response: value,
          ...override,
        }),
        { status: 200 },
      ),
    );
  }
  async function unknown(input = payload) {
    await expect(
      run(input, async (before) => {
        await before();
        throw new Error('Lost response');
      }),
    ).rejects.toThrow('Lost response');
    expect(await row(input)).toMatchObject({ state: 'unknown', leaseId: null });
  }

  it('reserves chat and marketplace durably before dispatch and blocks another administrator on either scope', async () => {
    await expect(
      run(payload, async (before) => {
        await before();
        const saved = await row();
        expect(saved).toMatchObject({ kind: 'management', state: 'unknown', request: payload });
        expect((await journal.read(chatId)).activeOperationId).toBe(saved.id);
        expect((await journal.read(`marketplace:${marketplaceId}`)).activeOperationId).toBe(
          saved.id,
        );
        await expect(connection()).rejects.toBeInstanceOf(ConflictException);
        await expect(connection(`${chatId}2`)).rejects.toBeInstanceOf(ConflictException);
        return response;
      }),
    ).resolves.toEqual(response);
    expect(await row()).toMatchObject({ state: 'complete', result: response, leaseId: null });
    expect((await journal.read(chatId)).activeOperationId).toBeNull();
    expect((await journal.read(`marketplace:${marketplaceId}`)).activeOperationId).toBeNull();
  });

  it('rejects a daily admission behind a connection before dispatch and leaves an independent marketplace available', async () => {
    await connection();
    const dispatch = jest.fn<
      Promise<MarketplaceManagementResponse>,
      Parameters<Parameters<ManagementJournal['run']>[2]>
    >();
    await expect(run(payload, dispatch)).rejects.toBeInstanceOf(ConflictException);
    expect(dispatch).not.toHaveBeenCalled();
    expect(
      await db.karavanMarketplaceConnectionOperation.findUnique({
        where: { id: payload.commandId },
      }),
    ).toBeNull();
    await expect(run(request(randomUUID(), `${chatId}2`, randomUUID()))).resolves.toEqual(response);
  });

  it('retains an unknown daily outcome across devices and restores its exact receipt without another dispatch', async () => {
    await unknown();
    await expect(connection(`${chatId}2`)).rejects.toBeInstanceOf(ConflictException);
    receipt();
    const dispatch = jest.fn<
      Promise<MarketplaceManagementResponse>,
      Parameters<Parameters<ManagementJournal['run']>[2]>
    >();
    const otherDevice = new ManagementJournal(db as PrismaService, config);
    await expect(otherDevice.run(actor, payload, dispatch, definite)).resolves.toEqual(response);
    expect(dispatch).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({ state: 'complete', result: response });
    expect(JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string).managementRequest).toEqual(
      payload,
    );
  });

  it('returns a typed conflict for a different command by the same administrator before the unique-key insert', async () => {
    await unknown();
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ status: 'not_found', commandId: payload.commandId }), {
        status: 200,
      }),
    );
    const different = request();
    const dispatch = jest.fn<
      Promise<MarketplaceManagementResponse>,
      Parameters<Parameters<ManagementJournal['run']>[2]>
    >();
    await expect(run(different, dispatch)).rejects.toMatchObject({
      response: { code: 'KARAVAN_CONNECTION_IN_PROGRESS' },
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(
      await db.karavanMarketplaceConnectionOperation.findUnique({
        where: { id: different.commandId },
      }),
    ).toBeNull();
    expect(await row()).toMatchObject({ state: 'unknown' });
    expect((await journal.read(chatId)).activeOperationId).toBe(payload.commandId);
  });

  it.each([true, false])(
    'admits a new daily write only after the exact binding receipt settles, found=%s',
    async (found) => {
      const original = await unknownBinding();
      payload = marketplaceManagementRequestSchema.parse({
        ...payload,
        expectedBindingGeneration: 2,
      });
      const bindingResult = karavanMarketplaceBindingResultSchema.parse({
        bindingId: randomUUID(),
        generation: 2,
        marketplace: {
          id: marketplaceId,
          networkId: randomUUID(),
          publicSlug: 'synthetic-admission',
          name: 'Synthetic marketplace',
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
      });
      fetchSpy.mockResolvedValue(
        new Response(
          JSON.stringify(
            found
              ? {
                  status: 'found',
                  commandId: original.id,
                  requestHash: karavanHash(original.scope),
                  response: bindingResult,
                }
              : { status: 'not_found', commandId: original.id },
          ),
          { status: 200 },
        ),
      );
      const dispatch = jest.fn<
        Promise<MarketplaceManagementResponse>,
        Parameters<Parameters<ManagementJournal['run']>[2]>
      >(async (before) => {
        expect(
          await db.karavanMarketplaceConnectionOperation.findUnique({ where: { id: original.id } }),
        ).toMatchObject({ state: 'complete', result: bindingResult });
        await before();
        return response;
      });
      if (found) {
        await expect(run(payload, dispatch)).resolves.toEqual(response);
        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(await row()).toMatchObject({ state: 'complete' });
        expect((await journal.read(chatId)).activeOperationId).toBeNull();
      } else {
        await expect(run(payload, dispatch)).rejects.toBeInstanceOf(ConflictException);
        expect(dispatch).not.toHaveBeenCalled();
        expect(
          await db.karavanMarketplaceConnectionOperation.findUnique({ where: { id: original.id } }),
        ).toMatchObject({ state: 'unknown' });
        expect((await journal.read(chatId)).activeOperationId).toBe(original.id);
        expect((await journal.read(`marketplace:${marketplaceId}`)).activeOperationId).toBe(
          original.id,
        );
      }
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fetchSpy.mock.calls[0]![1]!.body as string)).toMatchObject({
        commandId: original.id,
        action: 'recover_chat',
      });
    },
  );

  it('keeps a prior unknown reservation after an absent receipt and a later definite rejection', async () => {
    await unknown();
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ status: 'not_found', commandId: payload.commandId }), {
        status: 200,
      }),
    );
    await expect(
      run(payload, async (before) => {
        await before();
        throw new ForbiddenException('Rights lost');
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(await row()).toMatchObject({ state: 'unknown', leaseId: null });
    expect((await journal.read(chatId)).activeOperationId).toBe(payload.commandId);
    await expect(connection()).rejects.toBeInstanceOf(ConflictException);
  });

  it.each([false, true])(
    'adopts a legacy grant as unknown and retains both scopes after a later rejection, expired=%s',
    async (expired) => {
      const grant = await legacyGrant(payload, expired);
      fetchSpy.mockResolvedValue(
        new Response(JSON.stringify({ status: 'not_found', commandId: payload.commandId }), {
          status: 200,
        }),
      );
      await expect(
        run(payload, async (before) => {
          expect(await row()).toMatchObject({ state: 'unknown', request: payload });
          expect(fetchSpy).toHaveBeenCalledTimes(1);
          await before();
          throw new ForbiddenException('Rights lost after the original attempt');
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(await row()).toMatchObject({ state: 'unknown', leaseId: null });
      expect((await journal.read(chatId)).activeOperationId).toBe(payload.commandId);
      expect((await journal.read(`marketplace:${marketplaceId}`)).activeOperationId).toBe(
        payload.commandId,
      );
      expect(
        await db.karavanMarketplaceAuthorityGrant.findUnique({ where: { id: grant.id } }),
      ).toEqual(grant);
      await expect(connection(`${chatId}2`)).rejects.toBeInstanceOf(ConflictException);
    },
  );

  it('restores an exact legacy management receipt without dispatching or renewing its original grant', async () => {
    const grant = await legacyGrant(payload, true);
    receipt();
    const dispatch = jest.fn<
      Promise<MarketplaceManagementResponse>,
      Parameters<Parameters<ManagementJournal['run']>[2]>
    >();
    await expect(run(payload, dispatch)).resolves.toEqual(response);
    expect(dispatch).not.toHaveBeenCalled();
    expect(await row()).toMatchObject({ state: 'complete', result: response });
    expect((await journal.read(chatId)).activeOperationId).toBeNull();
    expect((await journal.read(`marketplace:${marketplaceId}`)).activeOperationId).toBeNull();
    expect(
      await db.karavanMarketplaceAuthorityGrant.findUnique({ where: { id: grant.id } }),
    ).toEqual(grant);
  });

  it('refuses a legacy grant for changed semantics before reserving scopes or dispatching', async () => {
    await legacyGrant(
      marketplaceManagementRequestSchema.parse({ ...payload, expectedBindingGeneration: 2 }),
    );
    const dispatch = jest.fn<
      Promise<MarketplaceManagementResponse>,
      Parameters<Parameters<ManagementJournal['run']>[2]>
    >();
    await expect(run(payload, dispatch)).rejects.toBeInstanceOf(ConflictException);
    expect(dispatch).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(
      await db.karavanMarketplaceConnectionOperation.findUnique({
        where: { id: payload.commandId },
      }),
    ).toBeNull();
    expect((await journal.read(chatId)).activeOperationId).toBeNull();
    expect((await journal.read(`marketplace:${marketplaceId}`)).activeOperationId).toBeNull();
  });

  it.each([false, true])(
    'releases only a first proven rejection, dispatched=%s',
    async (dispatchStarted) => {
      await expect(
        run(payload, async (before) => {
          if (dispatchStarted) await before();
          throw new ForbiddenException('Rejected before effect');
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(await row()).toMatchObject({ state: 'rejected' });
      expect((await journal.read(chatId)).activeOperationId).toBeNull();
      const retry = jest.fn<
        Promise<MarketplaceManagementResponse>,
        Parameters<Parameters<ManagementJournal['run']>[2]>
      >();
      await expect(run(payload, retry)).rejects.toMatchObject({
        response: { code: 'KARAVAN_MANAGEMENT_REJECTED' },
      });
      expect(retry).not.toHaveBeenCalled();
    },
  );

  it('does not replace an original command with edited data and supports retained non-UUID identities', async () => {
    payload = request('legacy-management-command');
    await unknown();
    const original = await row();
    const changed = marketplaceManagementRequestSchema.parse({
      ...payload,
      expectedBindingGeneration: 2,
    });
    await expect(run(changed)).rejects.toBeInstanceOf(ConflictException);
    expect(await row()).toMatchObject({
      request: payload,
      requestHash: original.requestHash,
      state: 'unknown',
    });
    expect(managementOperationId(actor, payload.commandId)).toBe(original.id);
    expect(fetchSpy).not.toHaveBeenCalled();
    receipt();
    await expect(run()).resolves.toEqual(response);
  });

  it('allows one execution lease across concurrent retries', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = run(payload, async (before) => {
      await before();
      entered();
      await wait;
      return response;
    });
    await started;
    try {
      const second = jest.fn<
        Promise<MarketplaceManagementResponse>,
        Parameters<Parameters<ManagementJournal['run']>[2]>
      >();
      await expect(run(payload, second)).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(second).not.toHaveBeenCalled();
    } finally {
      release();
    }
    await expect(first).resolves.toEqual(response);
  });

  it('rejects the final dispatch boundary after exact lease ownership is lost', async () => {
    const competingLease = randomUUID();
    await expect(
      run(payload, async (before) => {
        await db.karavanMarketplaceConnectionOperation.update({
          where: { id: payload.commandId },
          data: { leaseId: competingLease, leaseUntil: new Date(Date.now() + 90_000) },
        });
        await before();
        throw new Error('Must not reach HTTP');
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(await row()).toMatchObject({ state: 'pending', leaseId: competingLease });
    expect((await journal.read(chatId)).activeOperationId).toBe(payload.commandId);
  });

  it.each(['domain', 'original', 'operation'])(
    'keeps an unknown command fenced for a mismatched %s receipt',
    async (mismatch) => {
      await unknown();
      receipt(
        payload,
        mismatch === 'operation'
          ? { operation: 'pins', data: { revision: 2, offers: [] } }
          : response,
        mismatch === 'domain'
          ? { requestHash: 'b'.repeat(64) }
          : mismatch === 'original'
            ? { managementRequestHash: 'b'.repeat(64) }
            : {},
      );
      await expect(run()).rejects.toBeDefined();
      expect(await row()).toMatchObject({ state: 'unknown', leaseId: null });
      expect((await journal.read(chatId)).activeOperationId).toBe(payload.commandId);
    },
  );

  it('settles only the exact observed management receipt during an explicit connection admission', async () => {
    await unknown();
    const before = await row();
    await journal.read(chatId);
    expect(await row()).toEqual(before);
    receipt();
    await service.settle(chatId);
    expect(await row()).toMatchObject({ state: 'complete', result: response });
    await expect(connection()).resolves.toBeDefined();
  });

  it('stores a confirmed administration receipt terminally without fabricating its current-state response', async () => {
    const commandId = randomUUID();
    ids.add(commandId);
    payload = marketplaceManagementRequestSchema.parse({
      ...payload,
      commandId,
      command: {
        operation: 'administration_store_change',
        input: {
          commandId,
          expectedRevision: 1,
          action: 'attach',
          storeId: randomUUID(),
          expectedChatBinding: {
            id: randomUUID(),
            chatId,
            botId: 'synthetic',
            generation: 1,
          },
        },
      },
    });
    await unknown();
    receipt(payload, { operation: 'administration_store_change', confirmed: true });
    await expect(run()).rejects.toMatchObject({
      response: { code: 'KARAVAN_COMMAND_RESULT_CONFIRMED' },
    });
    expect(await row()).toMatchObject({
      state: 'complete',
      result: { operation: 'administration_store_change', confirmed: true },
    });
    expect((await journal.read(chatId)).activeOperationId).toBeNull();
    fetchSpy.mockClear();
    await expect(run()).rejects.toMatchObject({
      response: { code: 'KARAVAN_COMMAND_RESULT_CONFIRMED' },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
