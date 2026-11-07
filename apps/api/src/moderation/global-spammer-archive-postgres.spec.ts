import { randomUUID } from 'node:crypto';
import { createPrismaAdapter, createPrismaClient, PrismaClient } from '../prisma/prisma-client';
import { GlobalSpammerIntelligenceService } from './global-spammer-intelligence.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
(databaseUrl ? describe : describe.skip)(
  'global spammer archive maintenance with PostgreSQL',
  () => {
    let setup: PrismaClient;
    let db: PrismaClient;
    let service: GlobalSpammerIntelligenceService;
    const schema = `spammer_archive_${randomUUID().replaceAll('-', '')}`;
    const now = new Date('2026-11-07T00:00:00.000Z');
    const expiredCount = 2001;
    const futureCount = 1000;
    let capture = false;
    const queries: string[] = [];

    beforeAll(async () => {
      const scopedUrl = new URL(databaseUrl);
      if (
        !['127.0.0.1', 'localhost', '[::1]'].includes(scopedUrl.hostname) ||
        !scopedUrl.pathname.includes('race_test')
      ) {
        throw new Error('Archive maintenance requires a disposable local race_test database');
      }
      setup = createPrismaClient(databaseUrl, { max: 1, statement_timeout: 10000 });
      // FLAG: Archival selects globally. Own both tables so no other suite's registry can be deleted.
      await setup.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
      for (const table of ['global_spammers', 'global_spammer_archives']) {
        await setup.$executeRawUnsafe(
          `CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`,
        );
      }
      scopedUrl.searchParams.set('schema', schema);
      const logged = new PrismaClient({
        adapter: createPrismaAdapter(scopedUrl.toString(), {
          max: 2,
          statement_timeout: 10000,
          options: `-c timezone=UTC -c search_path=${schema},public`,
        }),
        log: [{ emit: 'event', level: 'query' }],
      });
      logged.$on('query', ({ query }) => {
        if (capture) queries.push(query);
      });
      db = logged;
      await db.$connect();
      service = new GlobalSpammerIntelligenceService(db as never);
    });

    beforeEach(async () => {
      await db.globalSpammer.deleteMany({});
      await db.globalSpammerArchive.deleteMany({});
      await db.globalSpammer.createMany({
        data: Array.from({ length: expiredCount + futureCount }, (_, index) => ({
          userId: `synthetic-${index}`,
          lastReason: 'Synthetic maintenance regression',
          firstDetectedAt: new Date('2026-01-01T00:00:00.000Z'),
          lastDetectedAt: new Date('2026-02-01T00:00:00.000Z'),
          expiresAt:
            index === 0
              ? null
              : new Date(now.getTime() + (index < expiredCount ? -86400000 : 86400000)),
        })),
      });
    });

    afterAll(async () => {
      service?.onModuleDestroy();
      await db?.$disconnect();
      if (setup) {
        await setup.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        await setup.$disconnect();
      }
    });

    async function archive(
      params: NonNullable<
        Parameters<GlobalSpammerIntelligenceService['archiveExpiredRegistryEntries']>[0]
      > & { countRemainingExpired?: boolean },
    ) {
      queries.length = 0;
      capture = true;
      try {
        return await service.archiveExpiredRegistryEntries(params);
      } finally {
        capture = false;
      }
    }

    function expectNoBacklogCount() {
      expect(queries.some((query) => /\bCOUNT\s*\(/iu.test(query))).toBe(false);
      expect(
        queries.filter(
          (query) => query.trimStart().startsWith('SELECT') && query.includes('"global_spammers"'),
        ),
      ).toHaveLength(1);
    }

    it('archives only its selected batch without measuring the remaining population', async () => {
      const result = await archive({ now, limit: 2, countRemainingExpired: false });
      expect(result).toMatchObject({ scanned: 2, archived: 2, deleted: 2, remainingExpired: null });
      expectNoBacklogCount();
      const archived = await db.globalSpammerArchive.findMany({});
      expect(archived).toHaveLength(2);
      expect(archived.every((row) => row.expiredAt === null || row.expiredAt <= now)).toBe(true);
      expect(await db.globalSpammer.count({ where: { expiresAt: { gt: now } } })).toBe(futureCount);
      expect(await db.globalSpammer.count({})).toBe(expiredCount + futureCount - 2);
    });

    it('does not count or mutate the registry in an unmeasured dry run', async () => {
      const result = await archive({ now, limit: 1, dryRun: true, countRemainingExpired: false });
      expect(result).toMatchObject({
        dryRun: true,
        scanned: 1,
        archived: 0,
        deleted: 0,
        remainingExpired: null,
      });
      expectNoBacklogCount();
      expect(await db.globalSpammer.count({})).toBe(expiredCount + futureCount);
      expect(await db.globalSpammerArchive.count({})).toBe(0);
    });

    it('reports an unmeasured empty selection as null', async () => {
      await db.globalSpammer.deleteMany({
        where: { OR: [{ expiresAt: null }, { expiresAt: { lte: now } }] },
      });
      expect(await archive({ now, limit: 1, countRemainingExpired: false })).toMatchObject({
        scanned: 0,
        remainingExpired: null,
      });
      expectNoBacklogCount();
      expect(await db.globalSpammer.count({})).toBe(futureCount);
    });

    it('preserves the exact default count after archiving a selected batch', async () => {
      expect(await archive({ now, limit: 2 })).toMatchObject({
        scanned: 2,
        archived: 2,
        deleted: 2,
        remainingExpired: expiredCount - 2,
      });
      expect(queries.some((query) => /\bCOUNT\s*\(/iu.test(query))).toBe(true);
      expect(await db.globalSpammerArchive.count({})).toBe(2);
      expect(await db.globalSpammer.count({ where: { expiresAt: { gt: now } } })).toBe(futureCount);
    });

    it('preserves the exact default dry-run count, including legacy null expiry', async () => {
      expect(await archive({ now, limit: 1, dryRun: true })).toMatchObject({
        scanned: 1,
        remainingExpired: expiredCount,
        archived: 0,
        deleted: 0,
      });
      expect(queries.some((query) => /\bCOUNT\s*\(/iu.test(query))).toBe(true);
      expect(await db.globalSpammer.count({})).toBe(expiredCount + futureCount);
    });
  },
);
