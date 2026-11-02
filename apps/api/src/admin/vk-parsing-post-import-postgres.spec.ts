import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import type { MaxRoutedPublicationService } from '../max/max-routed-publication.service';
import {
  createPrismaClient,
  PublicationDispatchProfile,
  type Prisma,
  type PrismaClient,
} from '../prisma/prisma-client';
import type { PublisherDispatchHealthService } from '../publisher/publisher-dispatch-health.service';
import type { PublisherReadinessService } from '../publisher/publisher-readiness.service';
import type { PublisherRuntimeBoundaryService } from '../publisher/publisher-runtime-boundary.service';
import {
  readPublisherPreparedDialogContext,
  type PublisherDialogContextService,
} from './publisher-dialog-context.service';
import { VkParsingFeedService } from './vk-parsing-feed.service';
import { VkParsingOwnershipService } from './vk-parsing-ownership.service';
import {
  VkParsingPostImportRepository,
  type PreparedVkPostImport,
  type VkParsingPostImportDatabase,
} from './vk-parsing-post-import.repository';
import { lockVkSyncLease, VkSyncLeaseLostError, type VkSyncLease } from './vk-sync-lease';
import { VkSyncService } from './vk-sync.service';
import { VkPublishService } from './vk-publish.service';
import {
  VK_MAX_SEND_AMBIGUOUS_ERROR_PREFIX,
  VK_MAX_SEND_CONFIRMED_PERSISTENCE_ERROR_PREFIX,
} from './vk-publish-quarantine';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('PostgreSQL VK import storage', () => {
  let client: Client;
  let repository: VkParsingPostImportRepository;
  let database: VkParsingPostImportDatabase;
  let toastTable: string;
  let leaseSchema: string;
  let contender: Client;
  let lastLeaseQuery: Prisma.Sql;
  const leaseDatabase = {
    $queryRaw: async (query: Prisma.Sql) => {
      lastLeaseQuery = query;
      return (await client.query(query.text, query.values)).rows;
    },
  };
  const source = {
    id: 'storage-source',
    chatId: 'storage-chat',
    wallOwnerId: -123,
    ownerProfile: 'PUBLISHER' as const,
    ownerBotId: 'storage-bot',
  };
  const lease: VkSyncLease = { ...source, syncLockedBy: 'attempt-a', syncAttemptCount: 1 };
  let imported: PreparedVkPostImport;

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    ) {
      throw new Error('Storage tests require a local disposable race_test database');
    }
    client = new Client({ connectionString: databaseUrl });
    await client.connect();
    leaseSchema = `vk_sync_lease_${randomBytes(6).toString('hex')}`;
    await client.query(`CREATE SCHEMA "${leaseSchema}"`);
    await client.query(
      `CREATE TABLE "${leaseSchema}".vk_parsing_sources (LIKE public.vk_parsing_sources INCLUDING ALL)`,
    );
    await client.query(`SET search_path TO "${leaseSchema}", pg_temp, public`);
    contender = new Client({ connectionString: databaseUrl });
    await contender.connect();
    await contender.query(`SET search_path TO "${leaseSchema}", public`);
    await contender.query("SET lock_timeout TO '100ms'");
    expect(
      Number((await client.query('SHOW server_version_num')).rows[0].server_version_num),
    ).toBeGreaterThanOrEqual(160000);
    // Actual production columns/indexes, isolated temp table: no production rows or FK mutations.
    await client.query(
      'CREATE TEMP TABLE vk_parsing_posts (LIKE public.vk_parsing_posts INCLUDING ALL)',
    );
    await client.query(
      'ALTER TABLE pg_temp.vk_parsing_posts ALTER COLUMN raw SET STORAGE EXTERNAL',
    );
    const toast = await client.query(
      "SELECT reltoastrelid::regclass::text AS name FROM pg_class WHERE oid = 'pg_temp.vk_parsing_posts'::regclass",
    );
    toastTable = toast.rows[0].name;
    database = {
      $executeRaw: async (query: Prisma.Sql) =>
        (await client.query(query.text, query.values)).rowCount,
    } as unknown as VkParsingPostImportDatabase;
  });

  beforeEach(async () => {
    await client.query(`TRUNCATE "${leaseSchema}".vk_parsing_sources`);
    await client.query(
      `INSERT INTO "${leaseSchema}".vk_parsing_sources (
      id, chat_id, owner_profile, owner_bot_id, owner_id, wall_owner_id,
      screen_name, title, url, created_by_user_id, updated_at,
      sync_status, sync_locked_by, sync_attempt_count, sync_lock_deadline_at
    ) VALUES ($1, $2, 'PUBLISHER', $3, 123, -123, 'storage', 'Storage',
      'https://vk.com/storage', 'test-user', now(), 'SYNCING', $4, 1,
      (clock_timestamp() AT TIME ZONE 'UTC') + interval '2 minutes')`,
      [source.id, source.chatId, source.ownerBotId, lease.syncLockedBy],
    );
    await client.query('TRUNCATE pg_temp.vk_parsing_posts');
    repository = new VkParsingPostImportRepository(database as never);
    imported = {
      status: 'NEW',
      publishScheduleFingerprint: null,
      post: {
        vkOwnerId: -123,
        vkPostId: 1,
        vkPublishedAt: new Date('2026-09-01T00:00:00Z'),
        text: 'original',
        textFormat: 'plain',
        url: 'https://vk.com/wall-123_1',
        photoUrls: ['https://example.test/photo'],
        videoUrls: [],
        linkUrls: [],
        attachments: [],
        attachmentTypes: [],
        unsupportedAttachments: [],
        hasUnsupportedAttachments: false,
        isAdvertising: false,
        advertisingMarkers: [],
        raw: { content: randomBytes(128 * 1024).toString('base64'), views: 1 },
        contentHash: 'revision-1',
      },
    };
  });

  afterAll(async () => {
    await contender?.end();
    if (leaseSchema) await client.query(`DROP SCHEMA IF EXISTS "${leaseSchema}" CASCADE`);
    await client?.end();
  });

  it('blocks a reclaim while an import holds the generation lock, then fences its old worker', async () => {
    await client.query('BEGIN');
    try {
      await lockVkSyncLease(leaseDatabase as never, lease);
      await expect(
        contender.query(
          `UPDATE "${leaseSchema}".vk_parsing_sources
        SET sync_locked_by = 'attempt-b', sync_attempt_count = 2 WHERE id = $1`,
          [source.id],
        ),
      ).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await client.query('ROLLBACK');
    }
    await contender.query(
      `UPDATE "${leaseSchema}".vk_parsing_sources
      SET sync_locked_by = 'attempt-b', sync_attempt_count = 2 WHERE id = $1`,
      [source.id],
    );
    imported.post.text = 'new generation';
    imported.post.contentHash = 'new-generation';
    await repository.persistImportedPosts(source, [imported], new Date());
    const before = await heapIdentity();

    await client.query('BEGIN');
    try {
      await expect(lockVkSyncLease(leaseDatabase as never, lease)).rejects.toBeInstanceOf(
        VkSyncLeaseLostError,
      );
    } finally {
      await client.query('ROLLBACK');
    }
    expect(await heapIdentity()).toEqual(before);
    expect((await client.query('SELECT text FROM pg_temp.vk_parsing_posts')).rows[0].text).toBe(
      'new generation',
    );
    await expect(
      lockVkSyncLease(leaseDatabase as never, {
        ...lease,
        syncLockedBy: 'attempt-b',
        syncAttemptCount: 2,
      }),
    ).resolves.toBeUndefined();
  });

  it.each(['expired', 'import-disabled', 'inactive', 'generation-changed'] as const)(
    'rejects a %s lease before any import or missing-state effects',
    async (kind) => {
      const change = {
        expired:
          "sync_lock_deadline_at = (clock_timestamp() AT TIME ZONE 'UTC') - interval '1 second'",
        'import-disabled': 'import_enabled = FALSE',
        inactive: "status = 'PAUSED'",
        'generation-changed': 'sync_attempt_count = 2',
      }[kind];
      await client.query(`UPDATE "${leaseSchema}".vk_parsing_sources SET ${change} WHERE id = $1`, [
        source.id,
      ]);

      await expect(lockVkSyncLease(leaseDatabase as never, lease)).rejects.toBeInstanceOf(
        VkSyncLeaseLostError,
      );
    },
  );

  it('checks expiry after acquiring a contended row lock rather than at statement start', async () => {
    await client.query(
      `UPDATE "${leaseSchema}".vk_parsing_sources
      SET sync_lock_deadline_at = (clock_timestamp() AT TIME ZONE 'UTC') + interval '200 milliseconds'
      WHERE id = $1`,
      [source.id],
    );
    await contender.query('BEGIN');
    await contender.query(
      `SELECT id FROM "${leaseSchema}".vk_parsing_sources WHERE id = $1 FOR UPDATE`,
      [source.id],
    );
    const outcome = lockVkSyncLease(leaseDatabase as never, lease).then(
      () => null,
      (error: unknown) => error,
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      await contender.query('ROLLBACK');
    }
    expect(await outcome).toBeInstanceOf(VkSyncLeaseLostError);
  });

  it('uses an indexed source lookup with ten thousand other sources', async () => {
    await client.query(`INSERT INTO "${leaseSchema}".vk_parsing_sources (
      id, chat_id, owner_profile, owner_bot_id, owner_id, wall_owner_id,
      screen_name, title, url, created_by_user_id, updated_at
    ) SELECT 'history-' || n, 'chat-' || n, 'PUBLISHER', 'bot-' || n,
      n, -n, 'history', 'History', 'https://vk.com/history', 'test-user', now()
      FROM generate_series(1000, 10999) AS n`);
    await client.query(`ANALYZE "${leaseSchema}".vk_parsing_sources`);
    await lockVkSyncLease(leaseDatabase as never, lease);
    const plan = (
      await client.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${lastLeaseQuery.text}`,
        lastLeaseQuery.values,
      )
    ).rows[0]['QUERY PLAN'][0].Plan;
    const nodes: Array<Record<string, unknown>> = [];
    const walk = (node: Record<string, unknown>) => {
      nodes.push(node);
      for (const child of (node.Plans ?? []) as Array<Record<string, unknown>>) walk(child);
    };
    walk(plan);
    expect(nodes.some((node) => node['Node Type'] === 'Index Scan')).toBe(true);
    expect(nodes.some((node) => node['Node Type'] === 'Seq Scan')).toBe(false);
    expect(plan['Actual Rows']).toBe(1);
    expect(
      Number(plan['Shared Hit Blocks'] ?? 0) + Number(plan['Shared Read Blocks'] ?? 0),
    ).toBeLessThan(20);
  });

  async function toastChunks() {
    // Name comes only from this connection's temp relation in pg_class.
    return (
      await client.query(
        `SELECT chunk_id, chunk_seq FROM ${toastTable} ORDER BY chunk_id, chunk_seq`,
      )
    ).rows;
  }

  async function heapIdentity() {
    return (
      await client.query('SELECT xmin::text, ctid::text, updated_at FROM pg_temp.vk_parsing_posts')
    ).rows[0];
  }

  it('skips exact observation replays without rewriting the heap or its TOAST payload', async () => {
    const observed = new Date('2026-09-01T00:00:00Z');
    await repository.persistImportedPosts(source, [imported], observed);
    const before = await heapIdentity();
    const beforeToast = await toastChunks();

    for (let index = 0; index < 100; index++) {
      await repository.persistImportedPosts(source, [imported], observed);
    }

    expect(await heapIdentity()).toEqual(before);
    expect(await toastChunks()).toEqual(beforeToast);
    expect(repository.getPersistenceSnapshot()).toEqual(
      expect.objectContaining({
        batches: 101,
        postsAttempted: 101,
        rowsWritten: 1,
        rowsSkippedOrFenced: 100,
        failedBatches: 0,
      }),
    );
  });

  it('reuses existing TOAST chunks while advancing observation timestamps', async () => {
    await repository.persistImportedPosts(source, [imported], new Date('2026-09-01T00:00:00Z'));
    const beforeHeap = await heapIdentity();
    const before = await toastChunks();
    expect(before.length).toBeGreaterThan(20);
    const observed = new Date('2026-09-01T00:05:00Z');
    for (let i = 0; i < 5; i++) await repository.persistImportedPosts(source, [imported], observed);
    expect(await heapIdentity()).not.toEqual(beforeHeap);
    expect(await toastChunks()).toEqual(before);
    const row = (
      await client.query(
        'SELECT raw, last_seen_at, last_availability_checked_at FROM pg_temp.vk_parsing_posts',
      )
    ).rows[0];
    expect(row.raw).toEqual(imported.post.raw);
    expect(row.last_seen_at).toEqual(observed);
    expect(row.last_availability_checked_at).toEqual(observed);
    expect(repository.getPersistenceSnapshot().rowsWritten).toBe(2);
    expect(repository.getPersistenceSnapshot().rowsSkippedOrFenced).toBe(4);
  });

  it('persists changed raw counters and URLs even when the content hash is unchanged', async () => {
    const observed = new Date('2026-09-01T00:00:00Z');
    await repository.persistImportedPosts(source, [imported], observed);
    const before = await toastChunks();
    imported.post.raw = { ...imported.post.raw, views: 2 };
    imported.post.photoUrls = ['https://example.test/refreshed'];
    await repository.persistImportedPosts(source, [imported], observed);
    expect(await toastChunks()).not.toEqual(before);
    const row = (await client.query('SELECT raw, photo_urls FROM pg_temp.vk_parsing_posts'))
      .rows[0];
    expect(row.raw.views).toBe(2);
    expect(row.photo_urls).toEqual(imported.post.photoUrls);
    expect(repository.getPersistenceSnapshot().rowsWritten).toBe(2);
  });

  it('preserves manual content and active publication revision fences', async () => {
    const observed = new Date('2026-09-01T00:00:00Z');
    await repository.persistImportedPosts(source, [imported], observed);
    await client.query(
      "UPDATE pg_temp.vk_parsing_posts SET text = 'manual', photo_urls = '[\"manual-photo\"]', manual_content_edited_at = now()",
    );
    const manuallyEditedHeap = await heapIdentity();
    await repository.persistImportedPosts(source, [imported], observed);
    expect(await heapIdentity()).toEqual(manuallyEditedHeap);
    expect(
      (await client.query('SELECT text, photo_urls FROM pg_temp.vk_parsing_posts')).rows[0],
    ).toEqual({ text: 'manual', photo_urls: ['manual-photo'] });
    await client.query(
      "UPDATE pg_temp.vk_parsing_posts SET publish_idempotency_key = 'active-attempt'",
    );
    const publicationHeap = await heapIdentity();
    imported.post.contentHash = 'revision-2';
    imported.post.raw = { views: 999 };
    await repository.persistImportedPosts(source, [imported], new Date('2026-09-01T00:05:00Z'));
    expect(await heapIdentity()).toEqual(publicationHeap);
    const row = (await client.query('SELECT content_hash, raw, text FROM pg_temp.vk_parsing_posts'))
      .rows[0];
    expect(row.content_hash).toBe('revision-1');
    expect(row.raw.views).toBe(1);
    expect(row.text).toBe('manual');
    expect(repository.getPersistenceSnapshot().rowsWritten).toBe(1);
    expect(repository.getPersistenceSnapshot().rowsSkippedOrFenced).toBe(2);
  });

  it('replaces manually edited fields when VK content changes at the same observation time', async () => {
    const observed = new Date('2026-09-01T00:00:00Z');
    await repository.persistImportedPosts(source, [imported], observed);
    await client.query(
      "UPDATE pg_temp.vk_parsing_posts SET text = 'manual', photo_urls = '[\"manual-photo\"]', manual_content_edited_at = now()",
    );
    imported.post.contentHash = 'revision-2';
    imported.post.text = 'changed in VK';
    imported.post.photoUrls = ['https://example.test/revision-2'];

    await repository.persistImportedPosts(source, [imported], observed);

    expect(
      (
        await client.query(
          'SELECT text, photo_urls, manual_content_edited_at, content_hash FROM pg_temp.vk_parsing_posts',
        )
      ).rows[0],
    ).toEqual({
      text: 'changed in VK',
      photo_urls: imported.post.photoUrls,
      manual_content_edited_at: null,
      content_hash: 'revision-2',
    });
  });

  it('clears missing and unavailable observations even when the incoming snapshot is identical', async () => {
    const observed = new Date('2026-09-01T00:00:00Z');
    await repository.persistImportedPosts(source, [imported], observed);
    await client.query(
      'UPDATE pg_temp.vk_parsing_posts SET missing_since_at = now(), missing_seen_count = 2, unavailable_at = now()',
    );
    const before = await heapIdentity();

    await repository.persistImportedPosts(source, [imported], observed);

    expect(await heapIdentity()).not.toEqual(before);
    expect(
      (
        await client.query(
          'SELECT missing_since_at, missing_seen_count, unavailable_at FROM pg_temp.vk_parsing_posts',
        )
      ).rows[0],
    ).toEqual({ missing_since_at: null, missing_seen_count: 0, unavailable_at: null });
  });

  it('clears stale skip and publication errors on NEW posts without changing the observation time', async () => {
    const observed = new Date('2026-09-01T00:00:00Z');
    await repository.persistImportedPosts(source, [imported], observed);
    await client.query(
      "UPDATE pg_temp.vk_parsing_posts SET skipped_at = now(), skip_reason = 'previous', auto_publish_error = 'previous', last_error = 'previous'",
    );

    await repository.persistImportedPosts(source, [imported], observed);

    expect(
      (
        await client.query(
          'SELECT skipped_at, skip_reason, auto_publish_error, last_error FROM pg_temp.vk_parsing_posts',
        )
      ).rows[0],
    ).toEqual({ skipped_at: null, skip_reason: null, auto_publish_error: null, last_error: null });
  });

  it('preserves skip and publication errors on a replay of a non-NEW post', async () => {
    const observed = new Date('2026-09-01T00:00:00Z');
    imported.status = 'FAILED';
    await repository.persistImportedPosts(source, [imported], observed);
    await client.query(
      "UPDATE pg_temp.vk_parsing_posts SET skipped_at = now(), skip_reason = 'previous', auto_publish_error = 'previous', last_error = 'previous'",
    );
    const before = await heapIdentity();

    await repository.persistImportedPosts(source, [imported], observed);

    expect(await heapIdentity()).toEqual(before);
    expect(
      (
        await client.query(
          'SELECT skip_reason, auto_publish_error, last_error FROM pg_temp.vk_parsing_posts',
        )
      ).rows[0],
    ).toEqual({ skip_reason: 'previous', auto_publish_error: 'previous', last_error: 'previous' });
  });

  it.each(
    (['last_error', 'auto_publish_error'] as const).flatMap((field) =>
      [VK_MAX_SEND_AMBIGUOUS_ERROR_PREFIX, VK_MAX_SEND_CONFIRMED_PERSISTENCE_ERROR_PREFIX].map(
        (prefix) => ({ field, prefix }),
      ),
    ),
  )('preserves $field quarantine $prefix through stale NEW imports', async ({ field, prefix }) => {
    const observed = new Date('2026-09-01T00:00:00Z');
    await repository.persistImportedPosts(source, [imported], observed);
    const ecmaWhitespace =
      '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
    for (const whitespace of ['', '\t', '\r\n', '\u00a0', '\ufeff', ecmaWhitespace]) {
      const marker = `${whitespace}${prefix} requires verification${whitespace}`;
      const errors = {
        last_error: field === 'last_error' ? marker : 'retained last error',
        auto_publish_error: field === 'auto_publish_error' ? marker : 'retained auto error',
      };
      await client.query(
        'UPDATE pg_temp.vk_parsing_posts SET status = $1, last_error = $2, auto_publish_error = $3',
        ['FAILED', errors.last_error, errors.auto_publish_error],
      );
      const refreshedAt = new Date('2026-09-01T00:05:00Z');
      await repository.persistImportedPosts(source, [imported], refreshedAt);
      expect(
        (
          await client.query(
            'SELECT status, last_error, auto_publish_error, last_seen_at FROM pg_temp.vk_parsing_posts',
          )
        ).rows[0],
      ).toEqual({ status: 'FAILED', ...errors, last_seen_at: refreshedAt });

      // FLAG: Even a stored NEW quarantine keeps both errors, and an identical observation
      // must not create a heap/TOAST rewrite solely because ordinary NEW errors can clear.
      await client.query("UPDATE pg_temp.vk_parsing_posts SET status = 'NEW'");
      const before = await heapIdentity();
      const beforeToast = await toastChunks();
      await repository.persistImportedPosts(source, [imported], refreshedAt);
      expect(await heapIdentity()).toEqual(before);
      expect(await toastChunks()).toEqual(beforeToast);
      expect(
        (await client.query('SELECT last_error, auto_publish_error FROM pg_temp.vk_parsing_posts'))
          .rows[0],
      ).toEqual(errors);
    }
  });

  it('does not trim a zero-width space into a quarantine prefix', async () => {
    const observed = new Date('2026-09-01T00:00:00Z');
    await repository.persistImportedPosts(source, [imported], observed);
    await client.query(
      'UPDATE pg_temp.vk_parsing_posts SET last_error = $1, auto_publish_error = $2',
      [
        `\u200b${VK_MAX_SEND_AMBIGUOUS_ERROR_PREFIX} ordinary`,
        `\u200b${VK_MAX_SEND_CONFIRMED_PERSISTENCE_ERROR_PREFIX} ordinary`,
      ],
    );
    await repository.persistImportedPosts(source, [imported], observed);
    expect(
      (await client.query('SELECT last_error, auto_publish_error FROM pg_temp.vk_parsing_posts'))
        .rows[0],
    ).toEqual({ last_error: null, auto_publish_error: null });
  });

  it.each([
    { status: 'FAILED', oldHash: 'revision-1', publishedHash: null, expected: 'FAILED' },
    { status: 'UNAVAILABLE', oldHash: 'revision-1', publishedHash: null, expected: 'NEW' },
    { status: 'SKIPPED', oldHash: 'revision-1', publishedHash: null, expected: 'SKIPPED' },
    { status: 'SKIPPED', oldHash: 'older', publishedHash: null, expected: 'NEW' },
    { status: 'PUBLISHED', oldHash: 'revision-1', publishedHash: null, expected: 'PUBLISHED' },
    { status: 'PUBLISHED', oldHash: 'older', publishedHash: '', expected: 'CHANGED_AFTER_PUBLISH' },
    {
      status: 'PUBLISHED',
      oldHash: 'revision-1',
      publishedHash: 'older',
      expected: 'CHANGED_AFTER_PUBLISH',
    },
    {
      status: 'CHANGED_AFTER_PUBLISH',
      oldHash: 'older',
      publishedHash: null,
      expected: 'CHANGED_AFTER_PUBLISH',
    },
    {
      status: 'CHANGED_AFTER_PUBLISH',
      oldHash: 'older',
      publishedHash: 'revision-1',
      expected: 'CHANGED_AFTER_PUBLISH',
    },
  ])('classifies current $status / $oldHash / $publishedHash at the write', async (scenario) => {
    const observed = new Date('2026-09-01T00:00:00Z');
    await repository.persistImportedPosts(source, [imported], observed);
    await client.query(
      `UPDATE pg_temp.vk_parsing_posts SET status = $1, content_hash = $2,
       published_content_hash = $3, last_error = 'ordinary failure', auto_publish_error = 'ordinary auto',
       skipped_at = $4, skip_reason = 'previous'`,
      [scenario.status, scenario.oldHash, scenario.publishedHash, observed],
    );
    await repository.persistImportedPosts(source, [imported], observed);
    expect(
      (
        await client.query(
          'SELECT status, last_error, auto_publish_error, skip_reason FROM pg_temp.vk_parsing_posts',
        )
      ).rows[0],
    ).toEqual({
      status: scenario.expected,
      last_error: scenario.expected === 'NEW' ? null : 'ordinary failure',
      auto_publish_error: scenario.expected === 'NEW' ? null : 'ordinary auto',
      skip_reason: scenario.expected === 'NEW' ? null : 'previous',
    });
    const before = await heapIdentity();
    await repository.persistImportedPosts(source, [imported], observed);
    expect(await heapIdentity()).toEqual(before);
  });
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function withinImportDeadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('VK race barrier exceeded 5 seconds')), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describePostgres('PostgreSQL VK import concurrent publication result', () => {
  let importer: PrismaClient;
  let writer: PrismaClient;
  let service: VkPublishService;
  let sync: VkSyncService;
  let repository: VkParsingPostImportRepository;
  let chatId: string;
  let source: Prisma.VkParsingSourceGetPayload<Record<string, never>>;
  let postId: string;
  const botId = `vk-import-result-${randomUUID()}`;
  const intentKey = () => `vk-import-result-${postId}`;
  const context = { version: 1 as const, dialogBotId: botId, buttons: [], reference: null };
  const publisherQueue = { add: jest.fn().mockResolvedValue(undefined), getJob: jest.fn() };
  const runtime = { assertDispatchEnabled: jest.fn() } satisfies Pick<
    PublisherRuntimeBoundaryService,
    'assertDispatchEnabled'
  >;
  type RoutedPublish = MaxRoutedPublicationService['publish'];
  const remote = jest.fn<ReturnType<RoutedPublish>, Parameters<RoutedPublish>>();
  const importedPost = (changed = false) => ({
    vkOwnerId: -123,
    vkPostId: 1,
    vkPublishedAt: new Date('2026-09-01T00:00:00Z'),
    text: changed ? 'changed in VK' : 'original',
    textFormat: 'plain' as const,
    url: 'https://vk.com/wall-123_1',
    photoUrls: [],
    videoUrls: [],
    linkUrls: [],
    attachments: [],
    attachmentTypes: [],
    unsupportedAttachments: [],
    hasUnsupportedAttachments: false,
    isAdvertising: false,
    advertisingMarkers: [],
    photoMedia: [],
    videoMedia: [],
    copyHistoryText: [],
    raw: {},
    contentHash: changed ? 'revision-2' : 'revision-1',
  });
  const row = () => writer.vkParsingPost.findUniqueOrThrow({ where: { id: postId } });
  const execution = () => ({
    dispatchProfile: 'PUBLIK_V1' as const,
    requiredBotId: botId,
    postId,
    chatId,
    idempotencyKey: intentKey(),
    reason: 'manual-retry' as const,
  });
  const importPosts = (changed = false) =>
    (
      sync as unknown as {
        importPostsWithPolicyFence: (
          capturedSource: typeof source,
          posts: ReturnType<typeof importedPost>[],
          seenAt: Date,
          reason: 'scheduled',
        ) => Promise<unknown>;
      }
    ).importPostsWithPolicyFence(
      source,
      [importedPost(changed)],
      new Date('2026-09-01T00:05:00Z'),
      'scheduled',
    );

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('VK publication races require a local disposable race_test database');
    importer = createPrismaClient(databaseUrl, { max: 2, statement_timeout: 7_000 });
    writer = createPrismaClient(databaseUrl, { max: 2, statement_timeout: 7_000 });
    await importer.$connect();
    await writer.$connect();
    expect(await importer.$queryRawUnsafe('SHOW TimeZone')).toEqual([{ TimeZone: 'UTC' }]);
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    remote.mockReset();
    runtime.assertDispatchEnabled.mockReset();
    chatId = `vk-import-result-chat-${randomUUID()}`;
    await writer.chat.create({ data: { id: chatId, title: 'Synthetic VK result race' } });
    source = await writer.vkParsingSource.create({
      data: {
        chatId,
        ownerProfile: 'PUBLISHER',
        ownerBotId: botId,
        ownerId: 123,
        wallOwnerId: -123,
        screenName: 'synthetic',
        title: 'Synthetic source',
        url: 'https://vk.com/synthetic',
        createdByUserId: 'synthetic-user',
        publishMode: 'QUEUE',
        syncStatus: 'SYNCING',
        syncLockedBy: 'synthetic-import-attempt',
        syncAttemptCount: 1,
        syncLockDeadlineAt: new Date(Date.now() + 120_000),
      },
    });
    postId = `vk-import-result-post-${randomUUID()}`;
    const post = importedPost();
    await writer.vkParsingPost.create({
      data: {
        vkOwnerId: post.vkOwnerId,
        vkPostId: post.vkPostId,
        vkPublishedAt: post.vkPublishedAt,
        text: post.text,
        textFormat: post.textFormat,
        url: post.url,
        photoUrls: post.photoUrls,
        videoUrls: post.videoUrls,
        linkUrls: post.linkUrls,
        attachments: post.attachments,
        attachmentTypes: post.attachmentTypes,
        unsupportedAttachments: post.unsupportedAttachments,
        hasUnsupportedAttachments: post.hasUnsupportedAttachments,
        isAdvertising: post.isAdvertising,
        advertisingMarkers: post.advertisingMarkers,
        raw: post.raw,
        contentHash: post.contentHash,
        id: postId,
        sourceId: source.id,
        chatId,
        ownerProfile: 'PUBLISHER',
        ownerBotId: botId,
        publishIdempotencyKey: intentKey(),
        publishReason: 'manual-retry',
        publishActorUserId: 'synthetic-user',
        publishQueuedAt: new Date(Date.now() - 60_000),
        publishScheduledAt: new Date(Date.now() - 1_000),
        dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        requiredBotId: botId,
        dialogBotId: botId,
        publishDialogContext: context,
        publicationPolicyRevision: 1,
      },
    });
    const config = new ConfigService({
      MAX_PUBLISHER_BOT_ID: botId,
      MAX_PUBLISHER_DISPATCH_ENABLED: true,
    });
    const ownership = new VkParsingOwnershipService(config);
    const feed = new VkParsingFeedService(writer as never, {} as never, config);
    const readiness = {
      assertEntityReady: async () => ({
        chatId,
        entityType: 'chat' as const,
        requiredBotId: botId,
        policyRevision: 1,
      }),
    } satisfies Pick<PublisherReadinessService, 'assertEntityReady'>;
    const health = {
      assertDispatchAllowed: async () => undefined,
      recordSendFailure: async () => 'transient' as const,
      recordSendSuccess: async () => undefined,
    } satisfies Pick<
      PublisherDispatchHealthService,
      'assertDispatchAllowed' | 'recordSendFailure' | 'recordSendSuccess'
    >;
    const dialogContext = {
      read: readPublisherPreparedDialogContext,
      prepare: async () => context,
    } satisfies Pick<PublisherDialogContextService, 'read' | 'prepare'>;
    service = new VkPublishService(
      writer as never,
      {} as never,
      {} as never,
      {} as never,
      feed,
      config,
      ownership,
      undefined,
      { publish: remote } as never,
      publisherQueue as never,
      readiness as never,
      runtime as never,
      health as never,
      dialogContext as never,
    );
    repository = new VkParsingPostImportRepository(importer as never);
    sync = new VkSyncService(
      importer as never,
      {} as never,
      service,
      {} as never,
      repository,
      config,
      ownership,
    );
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    service?.onModuleDestroy();
    await writer.chat.deleteMany({ where: { id: chatId } });
  });

  afterAll(async () => {
    await writer?.$disconnect();
    await importer?.$disconnect();
  });

  it.each(['ambiguous', 'published', 'published-changed'] as const)(
    'preserves the committed manual %s result after a captured NEW import',
    async (scenario) => {
      const enteredSend = gate();
      const completeSend = gate();
      const timeout = new Error('Synthetic MAX send timed out after dispatch');
      remote.mockImplementation(async (request) => {
        const attempt = {
          botId,
          job: {
            actionType: 'SEND_MESSAGE' as const,
            chatId,
            attempt: 1,
            idempotencyKey: request.logicalIdempotencyKey,
            createdAt: new Date().toISOString(),
          },
        };
        await request.prepareAttempt?.(attempt);
        await request.beforeSendMutation?.(attempt);
        await request.onDispatchAttempt?.(attempt);
        enteredSend.resolve();
        await completeSend.promise;
        if (scenario === 'ambiguous') throw timeout;
        return {
          messageId: 'synthetic-confirmed-message',
          url: null,
          botId,
          candidateBotIds: [botId],
          routingVersion: null,
        };
      });
      // FLAG: Handle the expected rejection immediately; the import then waits for the real
      // failure/result writer while retaining Chat/source locks, before its stale UPSERT.
      const publication = service.processPublishPostJob(execution()).then(
        () => ({ error: null }),
        (error: unknown) => ({ error }),
      );
      const findExisting = repository.findExistingPosts.bind(repository);
      let adopted: Awaited<ReturnType<typeof row>> | undefined;
      let importOperation: Promise<unknown> | undefined;
      try {
        await withinImportDeadline(enteredSend.promise);
        jest.spyOn(repository, 'findExistingPosts').mockImplementation(async (...args) => {
          const captured = await findExisting(...args);
          expect(captured).toEqual([
            expect.objectContaining({ status: 'NEW', publishIdempotencyKey: intentKey() }),
          ]);
          expect(await row()).toEqual(
            expect.objectContaining({ status: 'NEW', publishAttemptCount: 1 }),
          );
          completeSend.resolve();
          const outcome = await withinImportDeadline(publication);
          expect(outcome.error).toBe(scenario === 'ambiguous' ? timeout : null);
          adopted = await row();
          expect(adopted.status).toBe(scenario === 'ambiguous' ? 'FAILED' : 'PUBLISHED');
          expect(adopted.publishIdempotencyKey).toBeNull();
          return captured;
        });
        importOperation = importPosts(scenario === 'published-changed');
        await withinImportDeadline(importOperation);
        const result = await row();
        expect(result.status).toBe(
          scenario === 'ambiguous'
            ? 'FAILED'
            : scenario === 'published-changed'
              ? 'CHANGED_AFTER_PUBLISH'
              : 'PUBLISHED',
        );
        expect(result.lastSeenAt).toEqual(new Date('2026-09-01T00:05:00Z'));
        expect(result.publishAttemptCount).toBe(1);
        expect(result.lastError).toBe(adopted?.lastError);
        expect(result.autoPublishError).toBe(adopted?.autoPublishError);
        expect(result.publishedMessageId).toBe(adopted?.publishedMessageId);
        expect(result.publishedContentHash).toBe(adopted?.publishedContentHash);
        expect(result.publishedAtMax).toEqual(adopted?.publishedAtMax);
        if (scenario === 'ambiguous') {
          expect(result.lastError).toContain(VK_MAX_SEND_AMBIGUOUS_ERROR_PREFIX);
          await expect(service.retryPost(chatId, postId, 'synthetic-user')).rejects.toThrow(
            'MAX мог уже принять эту публикацию',
          );
        } else if (scenario === 'published') {
          await expect(service.retryPost(chatId, postId, 'synthetic-user')).rejects.toThrow(
            'уже опубликован',
          );
        } else {
          await expect(service.retryPost(chatId, postId, 'synthetic-user')).resolves.toMatchObject({
            queued: 0,
          });
        }
        expect(remote).toHaveBeenCalledTimes(1);
        expect(publisherQueue.add).not.toHaveBeenCalled();
      } finally {
        completeSend.resolve();
        await publication;
        await importOperation?.catch(() => undefined);
      }
    },
    14_000,
  );

  it('retains a pending confirmed receipt and finalizes it before dispatch guards', async () => {
    const receipt = {
      publishedMessageId: 'synthetic-confirmed-pending-message',
      publishedBotId: botId,
      publishedContentHash: 'revision-1',
      publishedAtMax: new Date('2026-09-01T00:01:00Z'),
    };
    await writer.vkParsingPost.update({
      where: { id: postId },
      data: {
        ...receipt,
        status: 'FAILED',
        publishAttemptCount: 1,
        lastError: `${VK_MAX_SEND_CONFIRMED_PERSISTENCE_ERROR_PREFIX} synthetic pending commit`,
      },
    });
    const before = await row();
    await importPosts(true);
    expect(await row()).toEqual(before);
    runtime.assertDispatchEnabled.mockImplementation(() => {
      throw new Error('Dispatch must stay disabled for receipt recovery');
    });
    await service.processPublishPostJob(execution(), async () => {
      throw new Error('External dispatch guard must not precede a confirmed receipt');
    });
    expect(await row()).toEqual(
      expect.objectContaining({
        ...receipt,
        status: 'PUBLISHED',
        publishIdempotencyKey: null,
        lastError: null,
      }),
    );
    expect(remote).not.toHaveBeenCalled();
    expect(runtime.assertDispatchEnabled).not.toHaveBeenCalled();
    expect(publisherQueue.add).not.toHaveBeenCalled();
  });
});
