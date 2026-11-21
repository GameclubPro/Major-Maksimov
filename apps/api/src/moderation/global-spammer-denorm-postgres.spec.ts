import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { createPrismaClient, type PrismaClient } from '../prisma/prisma-client';
import type { GlobalSpammerDenormJob } from './global-spammer-denorm.queue';
import { GlobalSpammerIntelligenceService } from './global-spammer-intelligence.service';

const pg = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL;
const redis = process.env.MAXIM_TEST_REDIS_URL;
(pg && redis ? describe : describe.skip)('spammer observations with PostgreSQL and BullMQ', () => {
  const schema = 'spammer_projection_' + randomUUID().replaceAll('-', '');
  let setup: PrismaClient;
  let db: PrismaClient;
  let queue: Queue<GlobalSpammerDenormJob>;
  let service: GlobalSpammerIntelligenceService;
  beforeAll(async () => {
    const url = new URL(pg!);
    const redisUrl = new URL(redis!);
    if (
      url.hostname !== '127.0.0.1' ||
      redisUrl.hostname !== '127.0.0.1' ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Requires disposable loopback test stores');
    setup = createPrismaClient(pg!, { max: 1 });
    await setup.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    for (const table of [
      'global_spammers',
      'global_spammer_candidates',
      'global_spammer_candidate_chats',
      'spammer_observations',
      'spammer_campaign_clusters',
      'spammer_campaign_cluster_members',
      'spammer_graph_signals',
      'global_spammer_suppressions',
      'global_spammer_shadow_scores',
      'spammer_user_runtime_profiles',
    ]) {
      await setup.$executeRawUnsafe(
        `CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`,
      );
    }
    url.searchParams.set('schema', schema);
    db = createPrismaClient(url.toString(), { max: 3, options: `-c search_path=${schema},public` });
    queue = new Queue<GlobalSpammerDenormJob>(schema, {
      connection: { host: redisUrl.hostname, port: Number(redisUrl.port) },
    });
    service = new GlobalSpammerIntelligenceService(
      db as never,
      new ConfigService({
        SPAMMER_OBSERVATION_DENORM_QUEUE_ENABLED: true,
        SPAMMER_OBSERVATION_FAST_PATH_ENABLED: true,
        SPAMMER_OBSERVATION_FAST_PATH_SOURCES: 'FANOUT_REPEAT',
      }),
      undefined,
      undefined,
      queue,
    );
  });
  afterAll(async () => {
    service?.onModuleDestroy();
    if (queue) {
      await queue.obliterate({ force: true });
      await queue.close();
    }
    await db?.$disconnect();
    if (setup) {
      await setup.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await setup.$disconnect();
    }
  });

  it('recovers the missing handoff while retaining all distinct events and the original duplicate deadline', async () => {
    const at = new Date();
    const event = {
      source: 'FANOUT_REPEAT' as const,
      userId: 'sample',
      chatId: 'test',
      reason: 'FANOUT_EPISODE_MEDIUM',
      score: 0.68,
      observedAt: at,
    };
    await Promise.all(
      ['one', 'two', 'three'].map((messageId) =>
        service.recordObservation({ ...event, messageId }),
      ),
    );
    await Promise.all(
      [1, 2].map(() =>
        service.recordObservation({
          ...event,
          messageId: 'one',
          observedAt: new Date(at.getTime() + 3600000),
        }),
      ),
    );
    const stored = await db.spammerObservation.findMany({ where: { userId: 'sample' } });
    expect(stored).toHaveLength(3);
    expect(
      stored.every(
        (row) => row.observedAt.getTime() === at.getTime() && row.projectionDueAt !== null,
      ),
    ).toBe(true);
    const jobs = await queue.getWaiting();
    expect(jobs).toHaveLength(3);
    await jobs[0]!.remove();
    await service.recoverPendingObservationProjections(new Date(Date.now() + 65000));
    const recoveredJobs = await queue.getWaiting();
    expect(new Set(recoveredJobs.map((j) => j.data.observationId)).size).toBe(3);
    for (const job of recoveredJobs) await service.processObservationDenormJob(job.data);
    await service.processObservationDenormJob(recoveredJobs[0]!.data);
    expect(await db.spammerObservation.count({ where: { projectionDueAt: { not: null } } })).toBe(
      0,
    );
    expect(await db.globalSpammerShadowScore.count({ where: { userId: 'sample' } })).toBe(3);
    expect(
      (await db.globalSpammerCandidate.findUniqueOrThrow({ where: { userId: 'sample' } }))
        .detectionsCount,
    ).toBe(3);
  });
});
