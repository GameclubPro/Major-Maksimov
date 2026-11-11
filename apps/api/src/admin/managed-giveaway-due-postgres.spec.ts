import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { Client } from 'pg';
import {
  createPrismaClient,
  type ManagedGiveawayStatus,
  type Prisma,
  type PrismaClient,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { MaxClientService } from '../max/max-client.service';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { BackgroundRuntimeGovernorService } from '../system/background-runtime-governor.service';
import type { AdminService } from './admin.service';
import {
  buildManagedGiveawayDuePageQuery,
  MANAGED_GIVEAWAY_DUE_FAMILIES,
  type ManagedGiveawayDueCursor,
  type ManagedGiveawayDueFamily,
  type ManagedGiveawayDueRow,
} from './managed-giveaway-due-selection';
import { ManagedGiveawayService } from './managed-giveaway.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const native = databaseUrl ? describe : describe.skip;

type DueInvocationBoundary = {
  processDueManagedGiveaway(
    giveawayId: string,
    reason: 'startup' | 'scheduled',
    staleLockBefore: Date,
  ): Promise<void>;
};
type Plan = { [key: string]: unknown; Plans?: Plan[] };
type ObservedPage = { query: Prisma.Sql; rows: ManagedGiveawayDueRow[] };
type GiveawayInput = {
  id: string;
  sourceChatId?: string;
  status?: ManagedGiveawayStatus;
  startsAt?: Date | null;
  endsAt?: Date;
  lockedAt?: Date | null;
};

native('managed giveaway due nomination on PostgreSQL and Redis', () => {
  jest.setTimeout(30_000);
  const schema = `giveaway_due_${randomUUID().replaceAll('-', '')}`;
  const tables = [
    'chats',
    'managed_giveaways',
    'managed_giveaway_prizes',
    'managed_giveaway_entries',
    'managed_giveaway_winners',
    'managed_giveaway_winner_notifications',
    'managed_entity_access_edges',
    'chat_bot_memberships',
  ] as const;
  let maintenance: Client;
  let client: Client;
  let db: PrismaClient;
  let redis: Redis;
  let cache: ChatContextCacheService;
  let databaseCreated = false;
  const pages: ObservedPage[] = [];
  const ownedRedisKeys = new Set<string>();
  const maxCalls = jest.fn(() => {
    throw new Error('Giveaway nomination must not call MAX');
  });

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    const redisAddress = new URL(redisUrl);
    const localHosts = ['localhost', '127.0.0.1', '[::1]', '::1'];
    if (
      !localHosts.includes(url.hostname) ||
      !url.pathname.includes('race_test') ||
      process.env.DATABASE_URL !== databaseUrl ||
      !localHosts.includes(redisAddress.hostname)
    )
      throw new Error('Giveaway nomination requires disposable local PostgreSQL and Redis');
    const sourceSchema = url.searchParams.get('schema')?.trim() || 'public';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(sourceSchema))
      throw new Error('Test schema must be a plain PostgreSQL identifier');

    const sourceDatabase = decodeURIComponent(url.pathname.slice(1));
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(sourceDatabase))
      throw new Error('Test database must be a plain PostgreSQL identifier');
    const maintenanceUrl = new URL(databaseUrl);
    maintenanceUrl.pathname = '/postgres';
    maintenanceUrl.searchParams.delete('schema');
    maintenance = new Client({ connectionString: maintenanceUrl.toString() });
    await maintenance.connect();
    const actual = await maintenance.query<{ version: string; timezone: string }>(
      "SELECT version() AS version, current_setting('TimeZone') AS timezone",
    );
    expect(actual.rows[0]?.version).toMatch(/^PostgreSQL 16\./u);
    expect(actual.rows[0]?.timezone).toBe('UTC');
    // FLAG: Copy the already migrated disposable database before opening source
    // connections. This preserves real enum identities, checks, indexes and receipts;
    // no public relation in the source database is changed. A busy template refuses.
    await maintenance.query(`CREATE DATABASE "${schema}" TEMPLATE "${sourceDatabase}"`);
    databaseCreated = true;
    url.pathname = `/${schema}`;
    client = new Client({ connectionString: url.toString() });
    await client.connect();
    await client.query(`SET search_path TO "${sourceSchema}", public`);
    await client.query('SET statement_timeout = 15000');
    await client.query('SET lock_timeout = 1000');
    await client.query('SET max_parallel_workers_per_gather = 0');
    expect(
      (await client.query<{ database: string }>('SELECT current_database() AS database')).rows,
    ).toEqual([{ database: schema }]);
    db = createPrismaClient(url.toString(), {
      max: 2,
      statement_timeout: 15_000,
      options: `-c search_path=${sourceSchema},public`,
    });
    await db.$connect();
    // FLAG: A template can contain unrelated earlier native fixtures. Clear only
    // this owned copy before nomination; retain the actual schema and migration receipts.
    await client.query(`TRUNCATE ${tables.map((table) => `"${table}"`).join(', ')} CASCADE`);
    redis = new Redis(redisUrl, {
      keyPrefix: `${schema}:`,
      maxRetriesPerRequest: 1,
      commandTimeout: 3_000,
    });
    expect(await redis.ping()).toBe('PONG');
    expect(await redis.info('server')).toMatch(/redis_version:7\./u);
    // FLAG: Exercise the real cache's defer/backoff methods with an isolated client;
    // no cache lifecycle, subscribers, MAX client or application worker is started.
    cache = Object.assign(Object.create(ChatContextCacheService.prototype), {
      redis,
    }) as ChatContextCacheService;
  });

  beforeEach(() => {
    pages.length = 0;
  });

  afterEach(async () => {
    try {
      expect(maxCalls).not.toHaveBeenCalled();
    } finally {
      maxCalls.mockClear();
      if (redis && ownedRedisKeys.size > 0) {
        await redis.del(...ownedRedisKeys);
        ownedRedisKeys.clear();
      }
      // FLAG: Cascading fixture cleanup is confined to the newly created owned DB;
      // the copied real foreign keys and enum/default definitions remain intact.
      if (client)
        await client.query(`TRUNCATE ${tables.map((table) => `"${table}"`).join(', ')} CASCADE`);
    }
  });

  afterAll(async () => {
    redis?.disconnect();
    await db?.$disconnect();
    await client?.end();
    if (maintenance) {
      if (databaseCreated) await maintenance.query(`DROP DATABASE "${schema}"`);
      await maintenance.end();
    }
  });

  function createService(action: 'run' | 'slow' | 'pause' = 'run') {
    const max = new Proxy({} as MaxClientService, { get: () => maxCalls });
    const observed = new Proxy(db, {
      get(target, key) {
        if (key === '$queryRaw')
          return async (query: Prisma.Sql) => {
            const rows = await target.$queryRaw<ManagedGiveawayDueRow[]>(query);
            if (query.text.includes('"managed_giveaways"')) pages.push({ query, rows });
            return rows;
          };
        return Reflect.get(target, key);
      },
    });
    const governor = {
      decide: jest
        .fn<
          ReturnType<BackgroundRuntimeGovernorService['decide']>,
          Parameters<BackgroundRuntimeGovernorService['decide']>
        >()
        .mockResolvedValue({ action, retryAfterMs: 0, reason: 'synthetic native decision' }),
    } satisfies Pick<BackgroundRuntimeGovernorService, 'decide'>;
    const service = new ManagedGiveawayService(
      observed as unknown as PrismaService,
      max,
      cache,
      {} as AdminService,
      new ConfigService({ MAX_BOT_TOKEN: 'synthetic-giveaway-token', MAX_BOT_ID: 'fixture-bot' }),
      undefined,
      undefined,
      undefined,
      governor as unknown as BackgroundRuntimeGovernorService,
    );
    // FLAG: Observe admission at the existing effect boundary. Nomination, access
    // reads and Redis TTL checks remain real; no draw, activation or SEND is attempted.
    const process = jest
      .spyOn(service as unknown as DueInvocationBoundary, 'processDueManagedGiveaway')
      .mockResolvedValue(undefined);
    return { service, process, governor };
  }

  type Runner = ReturnType<typeof createService>;

  async function runPass(runner: Runner, mode: 'run' | 'slow' | 'pause' = 'run') {
    const beforePages = pages.length;
    const beforeCalls = runner.process.mock.calls.length;
    await runner.service.processDueManagedGiveaways('scheduled');
    const rawPages = pages.slice(beforePages);
    const calls = runner.process.mock.calls.slice(beforeCalls);
    expect(rawPages.reduce((count, page) => count + page.rows.length, 0)).toBeLessThanOrEqual(
      mode === 'pause' ? 0 : mode === 'slow' ? 40 : 80,
    );
    expect(calls.length).toBeLessThanOrEqual(mode === 'pause' ? 0 : mode === 'slow' ? 10 : 20);
    expect(rawPages.length).toBeLessThanOrEqual(mode === 'pause' ? 0 : 7);
    for (const page of rawPages)
      expect(page.rows.length).toBeLessThanOrEqual(mode === 'slow' ? 10 : 20);
    expect(new Set(calls.map(([id]) => id)).size).toBe(calls.length);
    return { rawPages, ids: calls.map(([id]) => id) };
  }

  async function insertGiveaways(rows: readonly GiveawayInput[]) {
    const chatIds = [...new Set(rows.map((row) => row.sourceChatId ?? 'synthetic-source'))];
    await db.chat.createMany({
      data: chatIds.map((id) => ({ id, title: 'Synthetic due nomination' })),
      skipDuplicates: true,
    });
    await db.managedGiveaway.createMany({
      data: rows.map((row) => ({
        ...row,
        sourceChatId: row.sourceChatId ?? 'synthetic-source',
        actorUserId: 'synthetic-admin',
        title: 'Synthetic due nomination',
        status: row.status ?? 'ACTIVE',
        startsAt: row.startsAt ?? null,
        endsAt: row.endsAt ?? new Date(Date.now() - 60_000),
      })),
    });
  }

  async function defer(ids: readonly string[], backoff = false) {
    for (const id of ids) {
      ownedRedisKeys.add(
        backoff
          ? ChatContextCacheService.managedGiveawayRunnerBackoffKey(id)
          : ChatContextCacheService.managedGiveawayRunnerDeferKey(id),
      );
      if (backoff) await cache.activateManagedGiveawayRunnerBackoff(id, 30 * 60);
      else await cache.activateManagedGiveawayRunnerDefer(id, 30 * 60);
    }
  }

  it('reaches an eligible tail beyond 101 Redis-deferred due heads within unchanged per-pass invocation limits', async () => {
    const now = new Date();
    const sourceChatId = `giveaway-due-head-chat-${randomUUID()}`;
    const tailChatId = `giveaway-due-tail-chat-${randomUUID()}`;
    const headIds = Array.from({ length: 101 }, (_, index) => `deferred-${index}`);
    const tailId = 'eligible-tail';
    await insertGiveaways(
      [...headIds, tailId].map((id, index) => ({
        id,
        sourceChatId: id === tailId ? tailChatId : sourceChatId,
        endsAt: new Date(now.getTime() - (102 - index) * 1_000),
      })),
    );
    await defer(headIds);
    expect(await cache.getManagedGiveawayRunnerDeferRemainingMs(headIds[0]!)).toBeGreaterThan(0);
    expect(await cache.getManagedGiveawayRunnerDeferRemainingMs(tailId)).toBe(0);
    const runner = createService();
    const observed: string[] = [];
    for (let pass = 0; pass < 4; pass += 1) {
      const result = await runPass(runner);
      if (pass === 0)
        expect(result.rawPages.reduce((count, page) => count + page.rows.length, 0)).toBe(80);
      observed.push(...result.ids);
      if (observed.includes(tailId)) break;
    }
    expect(observed).toContain(tailId);
    expect(observed.filter((id) => headIds.includes(id))).toEqual([]);
    expect(await db.managedGiveaway.count({ where: { status: 'ACTIVE' } })).toBe(102);
    expect(await cache.getManagedGiveawayRunnerDeferRemainingMs(headIds[0]!)).toBeGreaterThan(0);
  });

  it('passes access-blocked heads without suppressing a tail served by another active admin bot', async () => {
    const now = Date.now();
    const heads = Array.from({ length: 101 }, (_, index) => `denied-${index}`);
    const tail = 'alternate-bot-tail';
    await insertGiveaways(
      [...heads, tail].map((id, index) => ({
        id,
        sourceChatId: id === tail ? 'alternate-source' : 'denied-source',
        endsAt: new Date(now - (102 - index) * 1_000),
      })),
    );
    await db.managedEntityAccessEdge.createMany({
      data: ['denied-source', 'alternate-source'].map((chatId) => ({
        chatId,
        userId: 'synthetic-admin',
        botId: 'lost-bot',
        state: 'BOT_DENIED',
      })),
    });
    await db.chatBotMembership.createMany({
      data: [
        { chatId: 'denied-source', botId: 'lost-bot', status: 'REMOVED' },
        { chatId: 'alternate-source', botId: 'lost-bot', status: 'REMOVED' },
        {
          chatId: 'alternate-source',
          botId: 'healthy-bot',
          status: 'ACTIVE',
          permissionsSnapshot: { isAdmin: true, isOwner: false, permissions: [] },
        },
      ],
    });
    const runner = createService();
    const observed: string[] = [];
    for (let pass = 0; pass < 4 && !observed.includes(tail); pass += 1)
      observed.push(...(await runPass(runner)).ids);
    expect(observed).toContain(tail);
    expect(observed.some((id) => heads.includes(id))).toBe(false);
    expect(await db.managedEntityAccessEdge.count({ where: { state: 'BOT_DENIED' } })).toBe(2);
    expect(await db.chatBotMembership.count({ where: { status: 'REMOVED' } })).toBe(2);
  });

  it('counts recent locked heads in the raw budget and still reaches independent work', async () => {
    const now = new Date();
    const heads = Array.from({ length: 101 }, (_, index) => `locked-${index}`);
    const tail = 'unlocked-tail';
    await insertGiveaways(
      [...heads, tail].map((id, index) => ({
        id,
        sourceChatId: id === tail ? 'unlocked-source' : 'locked-source',
        endsAt: new Date(now.getTime() - (102 - index) * 1_000),
        lockedAt: id === tail ? null : now,
      })),
    );
    const runner = createService();
    const first = await runPass(runner);
    expect(first.ids).toEqual([]);
    const raw = first.rawPages.flatMap((page) => page.rows);
    expect(raw).toHaveLength(80);
    expect(raw.every((row) => row.lockedAt?.getTime() === now.getTime())).toBe(true);
    const observed: string[] = [];
    for (let pass = 0; pass < 3 && !observed.includes(tail); pass += 1)
      observed.push(...(await runPass(runner)).ids);
    expect(observed).toContain(tail);
    expect(observed.some((id) => heads.includes(id))).toBe(false);
    expect(await db.managedGiveaway.count({ where: { lockedAt: { not: null } } })).toBe(101);
  });

  it('keeps real Redis backoff heads bounded under slow admission and does no work while paused', async () => {
    const now = Date.now();
    const heads = Array.from({ length: 101 }, (_, index) => `backoff-${index}`);
    const tail = 'slow-tail';
    await insertGiveaways(
      [...heads, tail].map((id, index) => ({
        id,
        endsAt: new Date(now - (102 - index) * 1_000),
      })),
    );
    await defer(heads, true);
    const runner = createService('pause');
    expect((await runPass(runner, 'pause')).ids).toEqual([]);
    runner.governor.decide.mockResolvedValue({
      action: 'slow',
      retryAfterMs: 0,
      reason: 'synthetic slow admission',
    });
    const observed: string[] = [];
    for (let pass = 0; pass < 4 && !observed.includes(tail); pass += 1) {
      const result = await runPass(runner, 'slow');
      if (pass === 0)
        expect(result.rawPages.reduce((count, page) => count + page.rows.length, 0)).toBe(40);
      observed.push(...result.ids);
    }
    expect(observed).toContain(tail);
    expect(observed.some((id) => heads.includes(id))).toBe(false);
    expect(await cache.getManagedGiveawayRunnerBackoffRemainingMs(heads[0]!)).toBeGreaterThan(0);
  });

  it('rotates first-family admission when every due family has more than a full invocation budget', async () => {
    const now = Date.now();
    const due = new Date(now - 60_000);
    const future = new Date(now + 60 * 60_000);
    const families: Record<ManagedGiveawayDueFamily, GiveawayInput[]> = {
      scheduledStart: [],
      scheduledEnd: [],
      activeEnd: [],
      drawingEnd: [],
    };
    for (let index = 0; index < 25; index += 1) {
      const suffix = String(index).padStart(2, '0');
      families.scheduledStart.push({
        id: `start-${suffix}`,
        status: 'SCHEDULED',
        startsAt: due,
        endsAt: future,
      });
      families.scheduledEnd.push({
        id: `scheduled-end-${suffix}`,
        status: 'SCHEDULED',
        startsAt: null,
        endsAt: due,
      });
      families.activeEnd.push({ id: `active-end-${suffix}`, status: 'ACTIVE', endsAt: due });
      families.drawingEnd.push({ id: `drawing-end-${suffix}`, status: 'DRAWING', endsAt: due });
    }
    await insertGiveaways(Object.values(families).flat());
    const runner = createService();
    const observed = new Set<string>();
    for (let pass = 0; pass < 4; pass += 1)
      for (const id of (await runPass(runner)).ids) observed.add(id);
    for (const family of MANAGED_GIVEAWAY_DUE_FAMILIES)
      expect(families[family].some((row) => observed.has(row.id))).toBe(true);
  });

  it.each([15, 20])(
    'retains the uninspected suffix when the invocation limit interrupts a %i-row later page',
    async (activeCount) => {
      const now = Date.now();
      const due = new Date(now - 60_000);
      await insertGiveaways([
        ...Array.from({ length: 10 }, (_, index) => ({
          id: `start-${String(index).padStart(2, '0')}`,
          status: 'SCHEDULED' as const,
          startsAt: due,
          endsAt: new Date(now + 60 * 60_000),
        })),
        ...Array.from({ length: activeCount }, (_, index) => ({
          id: `active-${String(index).padStart(2, '0')}`,
          endsAt: due,
        })),
      ]);
      const runner = createService();
      const first = await runPass(runner);
      expect(first.ids).toHaveLength(20);
      expect(first.rawPages.flatMap((page) => page.rows)).toHaveLength(10 + activeCount);
      const suffix = Array.from(
        { length: activeCount - 10 },
        (_, index) => `active-${String(index + 10).padStart(2, '0')}`,
      );
      expect(first.ids.some((id) => suffix.includes(id))).toBe(false);
      const second = await runPass(runner);
      expect(second.ids).toEqual(expect.arrayContaining(suffix));
    },
  );

  it('deduplicates overlapping scheduled families without losing either raw continuation', async () => {
    const due = new Date(Date.now() - 60_000);
    const ids = Array.from({ length: 12 }, (_, index) => `overlap-${index}`);
    await insertGiveaways(
      ids.map((id) => ({ id, status: 'SCHEDULED', startsAt: due, endsAt: due })),
    );
    const runner = createService();
    const result = await runPass(runner);
    expect(result.ids).toHaveLength(12);
    expect(new Set(result.ids)).toEqual(new Set(ids));
    expect(result.rawPages.flatMap((page) => page.rows)).toHaveLength(24);
  });

  it('keeps a sweep cutoff and revisits expired defers and backdated/newly due rows only after wrap', async () => {
    const now = Date.now();
    const heads = Array.from({ length: 101 }, (_, index) => `wrap-head-${index}`);
    await insertGiveaways(
      [...heads, 'wrap-tail'].map((id, index) => ({
        id,
        endsAt: new Date(now - (102 - index) * 1_000),
      })),
    );
    await defer(heads);
    const runner = createService();
    const first = await runPass(runner);
    expect(first.ids).toEqual([]);
    const firstPage = first.rawPages.find((page) => page.rows.length > 0)!;
    const cutoff = firstPage.query.values.find((value): value is Date => value instanceof Date)!;
    expect(cutoff).toBeInstanceOf(Date);
    await insertGiveaways([
      { id: 'backdated-after-cursor', endsAt: new Date(now - 200_000) },
      { id: 'due-after-cutoff', endsAt: new Date(cutoff.getTime() + 1) },
    ]);
    const released = heads[0]!;
    await redis.pexpire(ChatContextCacheService.managedGiveawayRunnerDeferKey(released), 1);
    const deadline = Date.now() + 1_000;
    while (
      (await cache.getManagedGiveawayRunnerDeferRemainingMs(released)) > 0 &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 2));
    expect(await cache.getManagedGiveawayRunnerDeferRemainingMs(released)).toBe(0);
    const second = await runPass(runner);
    expect(second.ids).toContain('wrap-tail');
    expect(second.ids).not.toContain(released);
    expect(second.ids).not.toContain('backdated-after-cursor');
    expect(second.ids).not.toContain('due-after-cutoff');
    const continued = new Set<string>();
    for (let pass = 0; pass < 4; pass += 1) {
      const result = await runPass(runner);
      const rawIds = result.rawPages.flatMap((page) => page.rows.map((row) => row.id));
      expect(new Set(rawIds).size).toBe(rawIds.length);
      for (const id of result.ids) continued.add(id);
    }
    for (const id of [released, 'backdated-after-cursor', 'due-after-cutoff'])
      expect(continued.has(id)).toBe(true);
  });

  async function readPage(
    family: ManagedGiveawayDueFamily,
    cutoff: Date,
    after: ManagedGiveawayDueCursor | null = null,
    take = 20,
  ) {
    const query = buildManagedGiveawayDuePageQuery({ family, cutoff, after, take });
    // FLAG: Execute the exported builder's actual Prisma.Sql, including its tuple
    // predicate and parameters; no test reimplementation of selector SQL is used.
    const result = await client.query<ManagedGiveawayDueRow>(query.text, query.values);
    return { query, rows: result.rows };
  }

  it('continues through timestamp ties after deleting the saved anchor and includes null-start scheduled ends', async () => {
    const cutoff = new Date();
    const due = new Date(cutoff.getTime() - 60_000);
    const tiedIds = Array.from(
      { length: 12 },
      (_, index) => `tie-${String(index).padStart(2, '0')}`,
    );
    await insertGiveaways([
      ...tiedIds.map((id) => ({ id, endsAt: due })),
      { id: 'null-start-scheduled', status: 'SCHEDULED', startsAt: null, endsAt: due },
    ]);
    const first = await readPage('activeEnd', cutoff, null, 5);
    expect(first.rows.map((row) => row.id)).toEqual(tiedIds.slice(0, 5));
    const anchor = first.rows[4]!;
    await db.managedGiveaway.delete({ where: { id: anchor.id } });
    const second = await readPage('activeEnd', cutoff, { id: anchor.id, dueAt: anchor.dueAt }, 5);
    expect(second.rows.map((row) => row.id)).toEqual(tiedIds.slice(5, 10));
    expect((await readPage('scheduledStart', cutoff)).rows).toEqual([]);
    expect((await readPage('scheduledEnd', cutoff)).rows.map((row) => row.id)).toEqual([
      'null-start-scheduled',
    ]);
  });

  function nodes(plan: Plan): Plan[] {
    return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
  }

  function visits(plan: Plan): number {
    return (
      (Number(plan['Actual Rows']) +
        Number(plan['Rows Removed by Filter'] ?? 0) +
        Number(plan['Rows Removed by Index Recheck'] ?? 0)) *
      Number(plan['Actual Loops'])
    );
  }

  it('uses actual migrated indexes for bounded initial and tied-cursor plans in all four families over 50000 rows', async () => {
    const cutoff = new Date();
    const due = new Date(cutoff.getTime() - 60_000);
    const future = new Date(cutoff.getTime() + 60 * 60_000);
    await db.chat.create({ data: { id: 'plan-source', title: 'Synthetic retained history' } });
    await client.query(
      `INSERT INTO managed_giveaways
        (id, source_chat_id, actor_user_id, title, status, starts_at, ends_at, locked_at, updated_at)
      SELECT 'plan-' || lpad(n::text, 6, '0'), 'plan-source', 'synthetic-admin', 'Synthetic plan',
        CASE WHEN n <= 40000 THEN
          (ARRAY['COMPLETED', 'CANCELED', 'DRAFT'])[1 + (n % 3)]
          WHEN n <= 45000 THEN 'ACTIVE'
          WHEN n <= 47000 THEN 'SCHEDULED'
          WHEN n <= 49000 THEN 'DRAWING'
          ELSE 'ACTIVE' END::"ManagedGiveawayStatus",
        CASE WHEN n > 45000 AND n <= 47000 AND n % 5 <> 0 THEN $1::timestamp
          ELSE NULL END,
        CASE WHEN n > 49000 THEN $2::timestamp ELSE $1::timestamp END,
        CASE WHEN n % 7 = 0 THEN $3::timestamp ELSE NULL END,
        $3::timestamp
      FROM generate_series(1, 50000) n`,
      [due, future, cutoff],
    );
    await client.query('ANALYZE managed_giveaways');
    expect(await db.managedGiveaway.count()).toBe(50_000);
    const indexes = await client.query<{
      indexname: string;
      indexdef: string;
      valid: boolean;
      ready: boolean;
      live: boolean;
    }>(
      `SELECT c.relname AS indexname, pg_get_indexdef(i.indexrelid) AS indexdef,
        i.indisvalid AS valid, i.indisready AS ready, i.indislive AS live
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = 'managed_giveaways'::regclass`,
    );
    const cursorIds: Record<ManagedGiveawayDueFamily, string> = {
      scheduledStart: 'plan-046001',
      scheduledEnd: 'plan-046000',
      activeEnd: 'plan-043000',
      drawingEnd: 'plan-048000',
    };
    for (const family of MANAGED_GIVEAWAY_DUE_FAMILIES) {
      const field = family === 'scheduledStart' ? 'starts_at' : 'ends_at';
      const matching = indexes.rows.filter((index) =>
        index.indexdef.endsWith(`(status, ${field}, id)`),
      );
      expect(matching.length).toBeGreaterThan(0);
      for (const index of matching)
        expect(index).toMatchObject({ valid: true, ready: true, live: true });
      const names = new Set(matching.map((index) => index.indexname));
      for (const seek of [false, true]) {
        const page = await readPage(
          family,
          cutoff,
          seek ? { dueAt: due, id: cursorIds[family] } : null,
        );
        expect(page.rows).toHaveLength(20);
        expect(Object.keys(page.rows[0]!).sort()).toEqual([
          'dueAt',
          'id',
          'lockedAt',
          'sourceChatId',
        ]);
        if (seek) expect(page.rows.every((row) => row.id > cursorIds[family])).toBe(true);
        const explained = await client.query(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${page.query.text}`,
          page.query.values,
        );
        const root = explained.rows[0]['QUERY PLAN'][0].Plan as Plan;
        const all = nodes(root);
        expect(root['Node Type']).toBe('Limit');
        expect(
          all.filter((node) => /Seq Scan|Bitmap|Sort/u.test(String(node['Node Type']))),
        ).toEqual([]);
        const scans = all.filter((node) => node['Relation Name'] === 'managed_giveaways');
        expect(scans).toHaveLength(1);
        const scan = scans[0]!;
        expect(names.has(String(scan['Index Name']))).toBe(true);
        expect(scan['Index Cond']).toContain('status');
        expect(scan['Index Cond']).toContain(field);
        if (seek) {
          expect(scan['Index Cond']).toContain('ROW(');
          expect(scan['Index Cond']).toContain('id');
        }
        expect(scans.reduce((total, node) => total + visits(node), 0)).toBeLessThanOrEqual(20);
        expect(
          Number(root['Shared Hit Blocks'] ?? 0) + Number(root['Shared Read Blocks'] ?? 0),
        ).toBeLessThanOrEqual(100);
        expect(all.some((node) => node['Parent Relationship'] === 'SubPlan')).toBe(false);
      }
    }
  });
});
