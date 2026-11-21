import { randomUUID } from 'node:crypto';
import { createPrismaClient, type PrismaClient } from '../prisma/prisma-client';
import { previewRetiredSpammerData } from './spammer-retirement-preview';

const pg = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL;
(pg ? describe : describe.skip)('spammer retirement inventory with PostgreSQL', () => {
  const schema = 'retirement_preview_' + randomUUID().replaceAll('-', '');
  let setup: PrismaClient;
  let db: PrismaClient;
  beforeAll(async () => {
    const url = new URL(pg!);
    if (url.hostname !== '127.0.0.1' || !url.pathname.includes('race_test'))
      throw new Error('Disposable loopback PostgreSQL required');
    setup = createPrismaClient(pg!, { max: 1 });
    await setup.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    for (const table of [
      'global_spammers',
      'global_spammer_candidates',
      'global_spammer_candidate_chats',
      'global_spammer_archives',
      'spammer_observations',
      'spammer_user_runtime_profiles',
    ])
      await setup.$executeRawUnsafe(
        `CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`,
      );
    url.searchParams.set('schema', schema);
    db = createPrismaClient(url.toString(), { max: 1, options: `-c search_path=${schema},public` });
  });
  afterAll(async () => {
    await db?.$disconnect();
    if (setup) {
      await setup.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await setup.$disconnect();
    }
  });
  it('returns counts across stable pages and excludes evidence content', async () => {
    const privateText = 'fictional phone +10005550101';
    await db.globalSpammer.createMany({
      data: [
        {
          userId: 'a',
          lastReason: 'old',
          sourceBreakdown: { DEVELOPER_FORCED: {} },
          lastEvidence: { evidence: { excerpt: privateText } },
        },
        {
          userId: 'b',
          lastReason: 'old',
          sourceBreakdown: { DEVELOPER_FORCED: {}, FANOUT_HIGH: {} },
        },
        { userId: 'c', lastReason: 'new', sourceBreakdown: { FANOUT_HIGH: {} } },
      ],
    });
    const first = await previewRetiredSpammerData(db, { source: 'registry', limit: 2 });
    expect(first).toMatchObject({
      scanned: 2,
      retiredOnly: 1,
      retiredMixed: 1,
      rowsWithRawCopyIndicators: 1,
      nextCursor: expect.any(String),
    });
    expect(JSON.stringify(first)).not.toContain(privateText);
    await expect(
      previewRetiredSpammerData(db, { source: 'registry', limit: 2, cursor: first.nextCursor! }),
    ).resolves.toMatchObject({ scanned: 1, retiredOnly: 0, retiredMixed: 0, nextCursor: null });
    await expect(
      previewRetiredSpammerData(db, { source: 'chats', limit: 2, cursor: first.nextCursor! }),
    ).rejects.toThrow('different source');
    for (const source of ['archives', 'candidates', 'chats', 'observations', 'profiles'])
      await expect(previewRetiredSpammerData(db, { source, limit: 100 })).resolves.toMatchObject({
        source,
        scanned: 0,
        nextCursor: null,
      });
    expect(await db.globalSpammer.count()).toBe(3);
  });
});
