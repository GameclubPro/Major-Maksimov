import { ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ConnectionJournal } from './karavan-connection-journal';
import { PrismaClient, createPrismaAdapter } from '../../prisma/prisma-client';
import type { PrismaService } from '../../prisma/prisma.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const postgres = databaseUrl ? describe : describe.skip;
jest.setTimeout(30_000);

postgres('Karavan server-owned connection journal', () => {
  let db: PrismaClient;
  let journal: ConnectionJournal;
  let actor: string;
  let chatId: string;
  const ids = new Set<string>();
  const chats = new Set<string>();

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
  });
  beforeEach(() => {
    actor = `journal-${randomUUID()}`;
    chatId = `-${Date.now()}${Math.floor(Math.random() * 100000)}`;
    chats.add(chatId);
  });
  afterEach(async () => {
    await db.karavanMarketplaceConnectionScope.deleteMany({
      where: { chatId: { in: [...chats] } },
    });
    await db.karavanMarketplaceConnectionOperation.deleteMany({ where: { id: { in: [...ids] } } });
    ids.clear();
    chats.clear();
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  function data(
    input: {
      id?: string;
      actor?: string;
      targets?: string[];
      state?: string;
      marketplaceId?: string;
    } = {},
  ) {
    const id = input.id ?? randomUUID();
    const targets = input.targets ?? [chatId];
    const owner = input.actor ?? actor;
    const state = input.state ?? 'pending';
    ids.add(id);
    targets.forEach((chat) => chats.add(chat));
    return {
      id,
      actorMaxUserId: owner,
      anchorChatId: targets[0]!,
      activeScopeKey: ['pending', 'partial', 'unknown'].includes(state)
        ? `${owner}:${targets[0]}`
        : null,
      requestHash: 'a'.repeat(64),
      request: {
        operationId: id,
        chatIds: targets,
        existingMarketplaceId: input.marketplaceId ?? randomUUID(),
      },
      checkpoints: { marketplaceId: null, bindings: [] },
      state,
    };
  }

  async function admit(input: Parameters<typeof data>[0] = {}, expectedRevision?: number) {
    const row = data(input);
    if (input.marketplaceId) chats.add(`marketplace:${input.marketplaceId.toLowerCase()}`);
    await db.$transaction(async (tx) => {
      await tx.karavanMarketplaceConnectionOperation.create({ data: row });
      await journal.claim(tx, {
        operationId: row.id,
        chatIds: row.request.chatIds,
        anchorChatId: row.anchorChatId,
        marketplaceIds: input.marketplaceId ? [input.marketplaceId] : [],
        expectedRevision,
      });
    });
    return row;
  }

  it('reads an empty scope without creating state and retains one admission across devices', async () => {
    expect(await journal.read(chatId)).toEqual({
      revision: 0,
      activeOperationId: null,
      lastOperationId: null,
    });
    expect(await db.karavanMarketplaceConnectionScope.findUnique({ where: { chatId } })).toBeNull();
    const operation = await admit({}, 0);
    const anotherDevice = new ConnectionJournal(db as PrismaService);
    expect(await anotherDevice.read(chatId)).toEqual({
      revision: 1,
      activeOperationId: operation.id,
      lastOperationId: operation.id,
    });
    await db.$transaction((tx) =>
      journal.claim(tx, {
        operationId: operation.id,
        chatIds: [chatId],
        anchorChatId: chatId,
        expectedRevision: 0,
      }),
    );
    expect((await journal.read(chatId)).revision).toBe(1);
  });

  it('serializes two different administrators on the same chat', async () => {
    const results = await Promise.allSettled([
      admit({ actor: `${actor}-first` }, 0),
      admit({ actor: `${actor}-second` }, 0),
    ]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' ? rejected.reason : null).toBeInstanceOf(
      ConflictException,
    );
    const scope = await journal.read(chatId);
    expect(scope.revision).toBe(1);
    expect(scope.activeOperationId).not.toBeNull();
    expect(
      await db.karavanMarketplaceConnectionOperation.count({ where: { id: { in: [...ids] } } }),
    ).toBe(1);
  });

  it('locks multi-chat targets in canonical order and rolls back the losing reservation', async () => {
    const other = `${chatId}1`;
    const results = await Promise.allSettled([
      admit({ actor: `${actor}-first`, targets: [chatId, other] }),
      admit({ actor: `${actor}-second`, targets: [other, chatId] }),
    ]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const first = await journal.read(chatId);
    expect(await journal.read(other)).toEqual(first);
    expect(first.revision).toBe(1);
  });

  it('keeps unknown effects reserved after execution lease expiration', async () => {
    const operation = await admit({ state: 'unknown' });
    await db.karavanMarketplaceConnectionOperation.update({
      where: { id: operation.id },
      data: { leaseId: randomUUID(), leaseUntil: new Date(0) },
    });
    await expect(admit({ actor: `${actor}-another` })).rejects.toBeInstanceOf(ConflictException);
    await expect(db.$transaction((tx) => journal.release(tx, operation.id))).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(journal.assertWriteAvailable(chatId)).rejects.toBeInstanceOf(ConflictException);
    await expect(journal.assertWriteAvailable(chatId, operation.id)).resolves.toBeUndefined();
    expect((await journal.read(chatId)).activeOperationId).toBe(operation.id);
  });

  it('does not reserve a completed operation when admission waited behind its finisher', async () => {
    const operation = await admit({}, 0);
    let claimant: Promise<void> | undefined;
    try {
      await db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`karavan-connection:${chatId}`}))`;
          let identifyClaimant!: (pid: number) => void;
          const claimantPid = new Promise<number>((resolve) => {
            identifyClaimant = resolve;
          });
          claimant = db.$transaction(
            async (claimTx) => {
              const [backend] = await claimTx.$queryRaw<
                Array<{ pid: number }>
              >`SELECT pg_backend_pid() AS pid`;
              identifyClaimant(backend!.pid);
              await journal.claim(claimTx, {
                operationId: operation.id,
                chatIds: [chatId],
                anchorChatId: chatId,
                expectedRevision: 0,
              });
            },
            { timeout: 10_000 },
          );
          const pid = await claimantPid;
          const deadline = Date.now() + 3_000;
          let waiting = false;
          while (Date.now() < deadline) {
            const locks = await tx.$queryRaw<Array<{ granted: boolean }>>`
          SELECT granted FROM pg_locks
          WHERE pid = ${pid} AND locktype = 'advisory' AND NOT granted LIMIT 1`;
            if (locks.length) {
              waiting = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          expect(waiting).toBe(true);
          await tx.karavanMarketplaceConnectionOperation.update({
            where: { id: operation.id },
            data: { state: 'complete', activeScopeKey: null },
          });
          await journal.release(tx, operation.id);
        },
        { timeout: 10_000 },
      );
    } finally {
      await claimant;
    }
    expect(await journal.read(chatId)).toEqual({
      revision: 1,
      activeOperationId: null,
      lastOperationId: operation.id,
    });
  });

  it.each(['complete', 'rejected', 'cancelled', 'superseded'])(
    'releases only the exact terminal %s operation and retains its receipt identity',
    async (state) => {
      const operation = await admit({}, 0);
      await db.$transaction(async (tx) => {
        await tx.karavanMarketplaceConnectionOperation.update({
          where: { id: operation.id },
          data: { state, activeScopeKey: null },
        });
        await journal.release(tx, operation.id);
      });
      expect(await journal.read(chatId)).toEqual({
        revision: 1,
        activeOperationId: null,
        lastOperationId: operation.id,
      });
      await expect(journal.assertWriteAvailable(chatId)).resolves.toBeUndefined();
      await db.$transaction((tx) =>
        journal.claim(tx, {
          operationId: operation.id,
          chatIds: [chatId],
          anchorChatId: chatId,
          expectedRevision: 0,
        }),
      );
      expect((await journal.read(chatId)).activeOperationId).toBeNull();
      await expect(admit({ actor: `${actor}-late` }, 0)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'KARAVAN_CONNECTION_REVISION_CHANGED' }),
      });
      const next = await admit({ actor: `${actor}-next` }, 1);
      expect(await journal.read(chatId)).toEqual({
        revision: 2,
        activeOperationId: next.id,
        lastOperationId: next.id,
      });
      await db.$transaction((tx) => journal.release(tx, operation.id));
      expect((await journal.read(chatId)).activeOperationId).toBe(next.id);
    },
  );

  it('respects historical active setup targets even without any new scope row', async () => {
    const anchor = `${chatId}1`;
    const legacy = data({ actor: `${actor}-legacy`, targets: [anchor, chatId], state: 'partial' });
    await db.karavanMarketplaceConnectionOperation.create({ data: legacy });
    expect(await journal.read(chatId)).toMatchObject({ activeOperationId: null });
    expect(await journal.readWithLegacy(chatId)).toEqual({
      revision: 0,
      activeOperationId: legacy.id,
      lastOperationId: null,
    });
    expect(await db.karavanMarketplaceConnectionScope.count({ where: { chatId } })).toBe(0);
    await expect(journal.assertWriteAvailable(chatId)).rejects.toBeInstanceOf(ConflictException);
    await expect(admit()).rejects.toBeInstanceOf(ConflictException);
    await db.$transaction((tx) =>
      journal.claim(tx, {
        operationId: legacy.id,
        chatIds: [anchor, chatId],
        anchorChatId: anchor,
      }),
    );
    expect((await journal.read(chatId)).activeOperationId).toBe(legacy.id);
  });

  it('keeps another chat independent of an unknown operation', async () => {
    const operation = await admit({ state: 'unknown' });
    const other = `${chatId}1`;
    const independent = await admit({ targets: [other] });
    expect((await journal.read(other)).activeOperationId).toBe(independent.id);
    expect((await journal.read(chatId)).activeOperationId).toBe(operation.id);
  });

  it('serializes different chats sharing a marketplace and normalizes marketplace identity', async () => {
    const marketplaceId = randomUUID();
    const results = await Promise.allSettled([
      admit({ actor: `${actor}-first`, marketplaceId }),
      admit({
        actor: `${actor}-second`,
        targets: [`${chatId}1`],
        marketplaceId: marketplaceId.toUpperCase(),
      }),
    ]);
    const winners = results.filter((entry) => entry.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    const winner = winners[0]!;
    expect(winner.status).toBe('fulfilled');
    const operationId = winner.status === 'fulfilled' ? winner.value.id : '';
    const marketScope = await journal.read(`marketplace:${marketplaceId}`);
    expect(marketScope).toMatchObject({ activeOperationId: operationId, revision: 1 });
    await db.$transaction(async (tx) => {
      await tx.karavanMarketplaceConnectionOperation.update({
        where: { id: operationId },
        data: { state: 'complete', activeScopeKey: null },
      });
      await journal.release(tx, operationId);
    });
    expect((await journal.read(`marketplace:${marketplaceId}`)).activeOperationId).toBeNull();
    await expect(
      admit({
        actor: `${actor}-independent`,
        targets: [`${chatId}2`],
        marketplaceId: randomUUID(),
      }),
    ).resolves.toBeDefined();
  });

  it.each(['request', 'checkpoints', 'existing'])(
    'blocks another chat through the legacy %s marketplace index without new scope rows',
    async (location) => {
      const marketplaceId = randomUUID();
      const legacy = data({ actor: `${actor}-legacy`, targets: [`${chatId}1`], state: 'unknown' });
      await db.karavanMarketplaceConnectionOperation.create({
        data: {
          ...legacy,
          request: {
            ...legacy.request,
            existingMarketplaceId:
              location === 'existing' ? marketplaceId.toUpperCase() : randomUUID(),
            ...(location === 'request' ? { marketplaceId: marketplaceId.toUpperCase() } : {}),
          },
          checkpoints: {
            marketplaceId: location === 'checkpoints' ? marketplaceId.toUpperCase() : null,
            bindings: [],
          },
        },
      });
      await expect(admit({ marketplaceId })).rejects.toBeInstanceOf(ConflictException);
      expect((await journal.read(`marketplace:${marketplaceId}`)).activeOperationId).toBeNull();
    },
  );

  it('uses the exact active-target indexes with retained terminal history', async () => {
    const retained = Array.from({ length: 1800 }, (_, index) => {
      const row = data({
        actor: `${actor}-history-${index}`,
        targets: [`${chatId}${index + 100}`],
        state: index < 1400 ? 'complete' : 'unknown',
      });
      return {
        ...row,
        request: { ...row.request, marketplaceId: randomUUID() },
        checkpoints: { marketplaceId: randomUUID(), bindings: [] },
      };
    });
    await db.karavanMarketplaceConnectionOperation.createMany({ data: retained });
    await db.$executeRaw`ANALYZE karavan_marketplace_connection_operations`;
    const collectIndexes = (node: Record<string, unknown>): string[] => [
      ...(typeof node['Index Name'] === 'string' ? [node['Index Name']] : []),
      ...((node.Plans as Array<Record<string, unknown>> | undefined) ?? []).flatMap(collectIndexes),
    ];
    for (const [condition, expected] of [
      ['anchor_chat_id = ANY(ARRAY[$1]::text[])', 'karavan_connection_operation_active_anchor_idx'],
      [
        "(request -> 'chatIds') ?| ARRAY[$1]::text[]",
        'karavan_connection_operation_active_chats_idx',
      ],
      [
        "lower(request ->> 'marketplaceId') = ANY(ARRAY[$1]::text[])",
        'karavan_connection_operation_active_market_request_idx',
      ],
      [
        "lower(checkpoints ->> 'marketplaceId') = ANY(ARRAY[$1]::text[])",
        'karavan_connection_operation_active_market_checkpoint_idx',
      ],
      [
        "lower(request ->> 'existingMarketplaceId') = ANY(ARRAY[$1]::text[])",
        'karavan_connection_operation_active_market_existing_idx',
      ],
    ]) {
      const explained = await db.$queryRawUnsafe<
        Array<{ 'QUERY PLAN': Array<{ Plan: Record<string, unknown> }> }>
      >(
        `EXPLAIN (FORMAT JSON, COSTS OFF) SELECT id FROM karavan_marketplace_connection_operations WHERE state IN ('pending','partial','unknown') AND ${condition} LIMIT 1`,
        condition!.includes('lower(') ? randomUUID() : chatId,
      );
      expect(collectIndexes(explained[0]!['QUERY PLAN'][0]!.Plan)).toContain(expected);
    }
    await expect(journal.assertWriteAvailable(chatId)).resolves.toBeUndefined();
  });
});
