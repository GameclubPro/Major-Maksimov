import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createPrismaAdapter, Prisma, PrismaClient } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  chatContextFullQuery,
  chatContextShellQuery,
  readChatContextSource,
  type ChatContextShell,
  type ChatContextSourceResult,
  type ChatSettingsTemplate,
} from './chat-context-source';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const native = databaseUrl ? describe : describe.skip;
type Plan = {
  'Node Type': string;
  'Relation Name'?: string;
  'Actual Rows': number;
  'Actual Loops': number;
  'Rows Removed by Filter'?: number;
  Plans?: Plan[];
};

native('coherent settings templates on native PostgreSQL', () => {
  let db: PrismaClient;
  let raw: Client;
  let chatId: string;
  const ownedChats = new Set<string>();
  const queries: string[] = [];
  const now = new Date('2026-11-07T12:00:00Z');

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local PostgreSQL race_test database required');
    const logged = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 4, statement_timeout: 15_000 }),
      log: [{ emit: 'event', level: 'query' }],
    });
    logged.$on('query', ({ query }) => queries.push(query));
    db = logged;
    raw = new Client({ connectionString: databaseUrl, statement_timeout: 15_000 });
    await raw.connect();
    expect((await raw.query('SHOW TimeZone')).rows[0].TimeZone).toBe('UTC');
  });

  beforeEach(async () => {
    chatId = `settings-source-${randomUUID()}`;
    ownedChats.add(chatId);
    await db.chat.create({
      data: {
        id: chatId,
        title: 'Initial title',
        botId: 'initial-bot',
        primaryBotId: 'initial-primary',
        settings: { create: { antiSpamEnabled: false, updatedAt: now } },
      },
    });
    queries.length = 0;
  });

  afterEach(async () => {
    const ids = [...ownedChats];
    ownedChats.clear();
    await db.chat.deleteMany({ where: { id: { in: ids } } });
    await db.nightModeTransitionReconcileRequest.deleteMany({
      where: { chatId: { in: ids } },
    });
    expect(
      await db.nightModeTransitionReconcileRequest.count({ where: { chatId: { in: ids } } }),
    ).toBe(0);
  });

  afterAll(async () => {
    await raw?.end();
    await db?.$disconnect();
  });

  const read = (candidate: ChatSettingsTemplate | null = null, at = now) =>
    readChatContextSource(db as PrismaService, chatId, at, candidate);

  function template(result: ChatContextSourceResult): ChatSettingsTemplate {
    if (!result.proof || !result.row?.settings) throw new Error('Expected verified settings');
    return { proof: result.proof, settings: structuredClone(result.row.settings) };
  }

  function selectQueries(): string[] {
    return queries.filter((query) => query.trimStart().startsWith('SELECT'));
  }

  it('preserves the metadata-free baseline until the first actual settings write', async () => {
    // FLAG: Only this disposable fixture removes its own metadata to represent a row
    // installed before the additive migration. Runtime maintenance must not erase proofs.
    await db.chatSettingsCacheRevision.delete({ where: { chatId } });
    const baseline = await read();
    expect(baseline.proof).toEqual({ settingsId: baseline.row!.settings!.id, revision: null });
    expect(baseline.row!.settings).not.toHaveProperty('cacheRevision');
    queries.length = 0;
    expect((await read(template(baseline))).mode).toBe('shell');
    expect(selectQueries()).toHaveLength(1);
    expect(await db.chatSettingsCacheRevision.findUnique({ where: { chatId } })).toBeNull();

    await raw.query('UPDATE chat_settings SET anti_spam_enabled = true WHERE chat_id = $1', [
      chatId,
    ]);
    const changed = await read(template(baseline));
    expect(changed.mode).toBe('full');
    expect(changed.row!.settings!.antiSpamEnabled).toBe(true);
    expect(changed.proof!.revision).toMatch(/^[a-f0-9-]{36}$/);
    expect(changed.row!.settings!.updatedAt).toEqual(now);
  });

  it('reuses settings through one compact query while refreshing every shell relation', async () => {
    const original = await read();
    await db.chat.update({
      where: { id: chatId },
      data: { title: 'Fresh title', botId: 'fresh-bot', primaryBotId: 'fresh-primary' },
    });
    await db.chatAdminAllowlist.create({ data: { chatId, userId: 'fresh-admin' } });
    await db.chatRules.create({
      data: { chatId, publishedUrl: 'https://example.test/rules', publishedMessageId: 'rules-1' },
    });
    await db.domainAllowlist.createMany({
      data: [
        { chatId, domain: 'permanent.test' },
        { chatId, domain: 'current.test', removeAfterAt: new Date(now.getTime() + 1_000) },
        { chatId, domain: 'expired.test', removeAfterAt: now },
      ],
    });
    queries.length = 0;
    const fresh = await read(template(original));
    expect(fresh.mode).toBe('shell');
    expect(fresh.row).toMatchObject({
      title: 'Fresh title',
      botId: 'fresh-bot',
      primaryBotId: 'fresh-primary',
      admins: [{ userId: 'fresh-admin' }],
      rules: { publishedUrl: 'https://example.test/rules', publishedMessageId: 'rules-1' },
    });
    expect(fresh.row!.domains.map(({ domain }) => domain).sort()).toEqual([
      'current.test',
      'permanent.test',
    ]);
    expect(fresh.proof).toEqual(original.proof);
    expect(selectQueries()).toHaveLength(1);
    expect(selectQueries()[0]).not.toContain('bot_speech_media');
    expect(selectQueries()[0]).not.toContain('anti_spam_enabled');
    expect((await read(template(fresh), new Date(now.getTime() + 1_000))).row!.domains).toEqual([
      { domain: 'permanent.test' },
    ]);
  });

  it('measures cold reads and keeps verified SQL projections independent of configured media size', async () => {
    const media = Buffer.from('source-baseline-media'.repeat(8192)).toString('base64');
    await db.chatAdminAllowlist.create({ data: { chatId, userId: 'baseline-admin' } });
    await db.domainAllowlist.create({ data: { chatId, domain: 'baseline.test' } });
    await db.chatRules.create({
      data: { chatId, publishedUrl: 'https://example.test/baseline', publishedMessageId: 'rules' },
    });
    const samples: {
      variant: string;
      coldStatements: number;
      coldSelects: number;
      verifiedStatements: number;
      verifiedSelects: number;
      serializedSettingsBytes: number;
      serializedShellProjectionBytes: number;
    }[] = [];

    for (const variant of ['small', 'media']) {
      await db.chatSettings.update({
        where: { chatId },
        data: {
          botSpeechMedia:
            variant === 'media' ? { greeting: { base64: media, mimeType: 'image/png' } } : {},
          stopWordsMedia:
            variant === 'media'
              ? { notice: { base64: media, mimeType: 'image/png' } }
              : Prisma.DbNull,
          messageLimitsBlockedWords: ['baseline-word'],
          stopWordsPolicy: { version: 1, entries: [{ text: 'baseline-word', enabled: true }] },
          greetingBotButtons: [{ text: 'Native button', url: 'https://example.test/button' }],
          greetingDeleteBotMessageDelayMinutes: 1.5,
          duplicatePhotoMatchPreset: 'MINOR_EDITS',
          duplicatePhotoScope: 'CHAT',
          botSpeechStyle: variant === 'media' ? 'POLICE' : null,
          requiredSubscriptionExpiresAt: '2026-12-07T12:00:00.000Z',
          linkPolicyEffectiveAt: now,
          trafficPolicyEffectiveAt: now,
        },
      });
      // FLAG: Policy triggers own effective clocks. Read the actual typed row before the
      // measurement window; configured timestamps alone do not describe persisted settings.
      const storedSettings = await db.chatSettings.findUniqueOrThrow({ where: { chatId } });
      queries.length = 0;
      const full = await read();
      const coldStatements = queries.length;
      const coldSelects = selectQueries().length;
      expect(coldStatements).toBe(1);
      expect(coldSelects).toBe(1);
      expect(full.mode).toBe('full');
      expect(full.row?.settings).toEqual(storedSettings);
      expect(full.row?.settings).toMatchObject({
        messageLimitsBlockedWords: ['baseline-word'],
        stopWordsPolicy: { version: 1, entries: [{ text: 'baseline-word', enabled: true }] },
      });
      expect(full.row?.settings?.botSpeechMedia).toEqual(
        variant === 'media' ? { greeting: { base64: media, mimeType: 'image/png' } } : {},
      );
      expect(full.row?.settings?.stopWordsMedia).toEqual(
        variant === 'media' ? { notice: { base64: media, mimeType: 'image/png' } } : null,
      );

      queries.length = 0;
      const verified = await read(template(full));
      const verifiedStatements = queries.length;
      const verifiedSelects = selectQueries();
      expect(verified.mode).toBe('shell');
      expect(verified.proof).toEqual(full.proof);
      expect(verified.row).toEqual(full.row);
      expect(verifiedStatements).toBe(1);
      expect(verifiedSelects).toHaveLength(1);
      for (const column of ['bot_speech_media', 'stop_words_media', 'anti_spam_enabled'])
        expect(verifiedSelects[0]).not.toContain(column);

      const [shell] = await db.$queryRaw<ChatContextShell[]>(chatContextShellQuery(chatId, now));
      expect(shell).toMatchObject({
        settingsId: full.proof!.settingsId,
        settingsRevision: full.proof!.revision,
        adminUserIds: ['baseline-admin'],
        domainAllowlist: ['baseline.test'],
        rulesPublishedMessageId: 'rules',
      });
      expect(shell).not.toHaveProperty('botSpeechMedia');
      expect(shell).not.toHaveProperty('stopWordsMedia');
      samples.push({
        variant,
        coldStatements,
        coldSelects,
        verifiedStatements,
        verifiedSelects: verifiedSelects.length,
        serializedSettingsBytes: Buffer.byteLength(JSON.stringify(full.row!.settings)),
        serializedShellProjectionBytes: Buffer.byteLength(JSON.stringify(shell)),
      });
    }

    // FLAG: These bytes describe serialized logical results, not PostgreSQL wire traffic.
    // Both complete cold reads and verified compact reads require one coherent SELECT.
    expect(samples[1].serializedShellProjectionBytes).toBe(
      samples[0].serializedShellProjectionBytes,
    );
    expect(
      samples[1].serializedSettingsBytes - samples[0].serializedSettingsBytes,
    ).toBeGreaterThanOrEqual(2 * Buffer.byteLength(media));
    expect(samples[1].serializedShellProjectionBytes).toBeLessThan(
      samples[1].serializedSettingsBytes,
    );
    console.info('Chat context source native baseline', JSON.stringify({ samples }));
  });

  it('falls back from a mismatched compact proof to one complete coherent SELECT', async () => {
    const original = await read();
    await db.chatSettings.update({ where: { chatId }, data: { antiSpamEnabled: true } });
    const storedSettings = await db.chatSettings.findUniqueOrThrow({ where: { chatId } });
    queries.length = 0;
    const changed = await read(template(original));
    expect(changed.mode).toBe('full');
    expect(changed.row?.settings).toEqual(storedSettings);
    expect(changed.proof).not.toEqual(original.proof);
    expect(queries).toHaveLength(2);
    expect(selectQueries()).toHaveLength(2);
    expect(selectQueries()[0]).not.toContain('bot_speech_media');
    expect(selectQueries()[1]).toContain('bot_speech_media');
  });

  it('loads roster completeness with the current compact shell rather than a saved settings template', async () => {
    const initial = await read();
    expect(initial.row?.adminRosterState).toBeNull();
    await db.chatAdminAllowlist.create({ data: { chatId, userId: 'fresh-admin' } });
    const targeted = await read(template(initial));
    expect(targeted.row?.adminRosterState).toMatchObject({
      completedAt: null,
      completeProbeStartedAt: null,
    });
    const accepted = await db.chatAdminRosterState.update({
      where: { chatId },
      data: { completeProbeStartedAt: now, completedAt: now },
    });
    queries.length = 0;
    const complete = await read(template(targeted));
    expect(complete.mode).toBe('shell');
    expect(complete.row?.adminRosterState).toEqual({
      revision: accepted.revision,
      completeProbeStartedAt: now.toISOString(),
      completedAt: now.toISOString(),
    });
    expect(selectQueries()).toHaveLength(1);
    expect(selectQueries()[0]).not.toContain('bot_speech_media');
  });

  it('detects raw updates with the same updatedAt and rotates proof for same-value writes', async () => {
    const original = await read();
    const value = template(original);
    await raw.query('UPDATE chat_settings SET anti_spam_enabled = true WHERE chat_id = $1', [
      chatId,
    ]);
    const changed = await read(value);
    expect(changed.mode).toBe('full');
    expect(changed.row!.settings!.updatedAt).toEqual(original.row!.settings!.updatedAt);
    expect(changed.row!.settings!.antiSpamEnabled).toBe(true);
    expect(changed.proof).not.toEqual(original.proof);
    await raw.query('UPDATE chat_settings SET anti_spam_enabled = true WHERE chat_id = $1', [
      chatId,
    ]);
    expect((await read(template(changed))).proof).not.toEqual(changed.proof);
  });

  it('rejects an old proof after deleting and recreating even the exact same settings id', async () => {
    const original = await read();
    const settingsId = original.proof!.settingsId;
    await db.chatSettings.delete({ where: { chatId } });
    expect(await db.chatSettingsCacheRevision.findUnique({ where: { chatId } })).toBeNull();
    await db.chatSettings.create({ data: { id: settingsId, chatId, antiSpamEnabled: true } });
    const recreated = await read(template(original));
    expect(recreated.mode).toBe('full');
    expect(recreated.proof!.settingsId).toBe(settingsId);
    expect(recreated.proof!.revision).not.toBe(original.proof!.revision);
    expect(recreated.row!.settings!.antiSpamEnabled).toBe(true);
  });

  it.each([false, true])(
    'moves metadata before a later FK cascade even with baseline=%s and rolls back exactly',
    async (baseline) => {
      const target = `settings-target-${randomUUID()}`;
      ownedChats.add(target);
      await db.chat.create({ data: { id: target, title: 'Target' } });
      if (baseline) await db.chatSettingsCacheRevision.delete({ where: { chatId } });
      const original = await read();
      await raw.query('BEGIN');
      try {
        await raw.query(
          'ALTER TRIGGER chat_settings_cache_revision_trigger ON chat_settings RENAME TO "A_cache_revision"',
        );
        const { rows: triggers } = await raw.query<{ tgname: string }>(`
          SELECT tgname FROM pg_trigger
          WHERE tgrelid = 'chat_settings'::regclass AND (tgtype & 16) <> 0
          ORDER BY tgname COLLATE "C"
        `);
        expect(triggers[0].tgname).toBe('A_cache_revision');
        expect(triggers.some(({ tgname }) => tgname.startsWith('RI_ConstraintTrigger'))).toBe(true);
        await raw.query('UPDATE chat_settings SET chat_id = $1 WHERE chat_id = $2', [
          target,
          chatId,
        ]);
        const { rows } = await raw.query<{
          chat_id: string;
          revision: string;
          settings_id: string;
        }>(
          `SELECT v.chat_id, v.revision::text, s.id AS settings_id
          FROM chat_settings_cache_revisions v JOIN chat_settings s USING (chat_id)
          WHERE v.chat_id = ANY($1::text[])`,
          [[chatId, target]],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ chat_id: target, settings_id: original.proof!.settingsId });
        expect(rows[0].revision).not.toBe(original.proof!.revision);
      } finally {
        await raw.query('ROLLBACK');
      }
      expect((await read()).proof).toEqual(original.proof);
      expect(await db.chatSettings.findUnique({ where: { chatId: target } })).toBeNull();
    },
  );

  it('cascades a parent chat rename through both keys and rotates the UUID', async () => {
    const original = await read();
    const renamed = `settings-renamed-${randomUUID()}`;
    ownedChats.add(renamed);
    await db.chat.update({ where: { id: chatId }, data: { id: renamed } });
    expect(await db.chatSettingsCacheRevision.findUnique({ where: { chatId } })).toBeNull();
    const next = await readChatContextSource(db as PrismaService, renamed, now, template(original));
    expect(next.mode).toBe('full');
    expect(next.row!.settings!.id).toBe(original.proof!.settingsId);
    expect(next.proof!.revision).not.toBe(original.proof!.revision);
    expect(next.row!.settings!.chatId).toBe(renamed);
  });

  it('keeps the complete source coherent across a real concurrent committed write', async () => {
    await db.chatAdminAllowlist.create({ data: { chatId, userId: 'old-admin' } });
    await db.domainAllowlist.create({ data: { chatId, domain: 'old.test' } });
    await db.chatRules.create({
      data: { chatId, publishedUrl: 'https://example.test/stable', publishedMessageId: 'stable' },
    });
    const original = await read();
    const readerQueries: string[] = [];
    const applicationName = `settings-source-race-${randomUUID()}`;
    const reader = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, {
        max: 1,
        application_name: applicationName,
        statement_timeout: 10_000,
      }),
      log: [{ emit: 'event', level: 'query' }],
    });
    reader.$on('query', ({ query }) => readerQueries.push(query));
    const blocker = new Client({ connectionString: databaseUrl, statement_timeout: 10_000 });
    let blockerTransaction = false;
    let writerTransaction = false;
    let pending: Promise<{ value: ChatContextSourceResult } | { error: unknown }> | undefined;
    try {
      await reader.$connect();
      await blocker.connect();
      const blockerPid = (await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0].pid;
      await blocker.query('BEGIN');
      blockerTransaction = true;
      await blocker.query('LOCK TABLE public.chat_rules IN ACCESS EXCLUSIVE MODE');
      readerQueries.length = 0;
      pending = readChatContextSource(reader as PrismaService, chatId, now, null).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );

      let observedWait: { pid: number; query_start: Date } | undefined;
      const waitDeadline = Date.now() + 3_000;
      while (Date.now() < waitDeadline) {
        const { rows } = await raw.query<{
          pid: number;
          query_start: Date;
          waiting_on_rules: boolean;
          blocked_by_owner: boolean;
        }>(
          `SELECT a.pid, a.query_start,
            EXISTS (SELECT 1 FROM pg_locks l WHERE l.pid = a.pid
              AND l.relation = 'public.chat_rules'::regclass
              AND l.mode = 'AccessShareLock' AND NOT l.granted) AS waiting_on_rules,
            $2::integer = ANY(pg_blocking_pids(a.pid)) AS blocked_by_owner
          FROM pg_stat_activity a WHERE a.application_name = $1
            AND a.state = 'active' AND a.wait_event_type = 'Lock'`,
          [applicationName, blockerPid],
        );
        observedWait = rows.find((row) => row.waiting_on_rules && row.blocked_by_owner);
        if (observedWait) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(observedWait).toBeDefined();
      expect(observedWait?.query_start).toBeInstanceOf(Date);

      await raw.query('BEGIN');
      writerTransaction = true;
      await raw.query(
        `UPDATE chat_settings SET anti_spam_enabled = true,
          bot_speech_media = '{"greeting":{"base64":"bmF0aXZlLXJhY2U=","mimeType":"image/png"}}'::jsonb,
          message_limits_blocked_words = ARRAY['new-word']::text[] WHERE chat_id = $1`,
        [chatId],
      );
      await raw.query(
        `UPDATE chats SET title = 'New title', bot_id = 'new-bot',
          primary_bot_id = 'new-primary' WHERE id = $1`,
        [chatId],
      );
      await raw.query('DELETE FROM chat_admin_allowlist WHERE chat_id = $1', [chatId]);
      await raw.query(
        `INSERT INTO chat_admin_allowlist (chat_id, user_id) VALUES ($1, 'new-admin')`,
        [chatId],
      );
      await raw.query('DELETE FROM domain_allowlist WHERE chat_id = $1', [chatId]);
      await raw.query(`INSERT INTO domain_allowlist (chat_id, domain) VALUES ($1, 'new.test')`, [
        chatId,
      ]);
      await raw.query('COMMIT');
      writerTransaction = false;
      await blocker.query('ROLLBACK');
      blockerTransaction = false;
      const outcome = await pending;
      if ('error' in outcome) throw outcome.error;
      const after = await read();
      expect(after.proof).not.toEqual(original.proof);
      expect(after.row).toMatchObject({
        title: 'New title',
        botId: 'new-bot',
        primaryBotId: 'new-primary',
        admins: [{ userId: 'new-admin' }],
        domains: [{ domain: 'new.test' }],
        settings: { antiSpamEnabled: true, messageLimitsBlockedWords: ['new-word'] },
      });
      expect(after.row?.adminRosterState).not.toEqual(original.row?.adminRosterState);
      // FLAG: A relation-lock wait proves overlap, not when PostgreSQL fixes the execution
      // snapshot. The one SELECT must return the complete old or complete new source.
      expect([original, after]).toContainEqual(outcome.value);
      expect(readerQueries).toHaveLength(1);
      expect(readerQueries[0].trimStart().startsWith('SELECT')).toBe(true);
    } finally {
      if (writerTransaction) await raw.query('ROLLBACK');
      if (blockerTransaction) await blocker.query('ROLLBACK');
      await pending;
      await reader.$disconnect();
      await blocker.end();
    }
  }, 20_000);

  it('does not turn a failed SQL proof into the metadata-free baseline', async () => {
    const original = await read();
    const failing = db.$extends({
      query: {
        async $queryRaw() {
          throw new Error('Proof query unavailable');
        },
      },
    });
    await expect(
      readChatContextSource(failing as unknown as PrismaService, chatId, now, template(original)),
    ).rejects.toThrow('Proof query unavailable');
  });

  it('returns no reusable proof for a missing chat or settings', async () => {
    await db.chatSettings.delete({ where: { chatId } });
    const withoutSettings = await read();
    expect(withoutSettings.row!.settings).toBeNull();
    expect(withoutSettings.proof).toBeNull();
    await db.chat.delete({ where: { id: chatId } });
    expect(await read()).toEqual({ row: null, proof: null, mode: 'full' });
  });

  it('preserves absent full rules separately from an existing unpublished rules row', async () => {
    const absent = await read();
    expect(absent.row?.rules).toBeNull();
    // FLAG: Verified shells retain their existing null-field rules object semantics.
    expect((await read(template(absent))).row?.rules).toEqual({
      publishedUrl: null,
      publishedMessageId: null,
    });
    await db.chatRules.create({ data: { chatId } });
    expect((await read()).row?.rules).toEqual({
      publishedUrl: null,
      publishedMessageId: null,
    });
  });

  it('bounds full and compact source work on 10,000 chats with large settings and skewed relations', async () => {
    const prefix = `settings-plan-${randomUUID()}-`;
    const target = `${prefix}1`;
    const large = Buffer.from('native-heavy-template'.repeat(16_000)).toString('base64');
    const fixtureRollback = new Error('Discard local chat context source plan fixture');
    const tables = [
      'chats',
      'chat_settings',
      'chat_settings_cache_revisions',
      'chat_admin_allowlist',
      'chat_admin_roster_states',
      'domain_allowlist',
      'chat_rules',
    ] as const;
    const startedAt = performance.now();
    let setupCompletedAt = startedAt;
    let checksCompletedAt = startedAt;
    let rollbackCompletedAt = startedAt;
    let statisticsRestoredAt = startedAt;
    try {
      // FLAG: Keep the full plan population in one real transaction. Rolling it back
      // avoids 10,000 parent DELETE cascades without weakening the measured query bounds.
      await db.$transaction(
        async (tx) => {
          await tx.$executeRaw`INSERT INTO chats (id, title, updated_at)
            SELECT ${prefix} || n, 'History', now() FROM generate_series(1,10000) n`;
          await tx.$executeRaw`INSERT INTO chat_settings (id, chat_id, updated_at)
            SELECT ${prefix} || n, ${prefix} || n, now() FROM generate_series(1,10000) n`;
          // FLAG: Relation triggers query these new parents/settings. Refresh empty-table
          // statistics before bulk child inserts so setup retains the real indexed paths.
          await tx.$executeRaw`ANALYZE chats`;
          await tx.$executeRaw`ANALYZE chat_settings`;
          await tx.$executeRaw`INSERT INTO chat_admin_allowlist (chat_id, user_id)
            SELECT ${prefix} || n, 'history-admin-' || u
            FROM generate_series(1,10000) n CROSS JOIN generate_series(1,3) u`;
          await tx.$executeRaw`INSERT INTO domain_allowlist (chat_id, domain)
            SELECT ${prefix} || n, 'history-domain-' || d || '.test'
            FROM generate_series(1,10000) n CROSS JOIN generate_series(1,3) d`;
          await tx.$executeRaw`INSERT INTO chat_rules (id, chat_id, updated_at)
            SELECT ${prefix} || n, ${prefix} || n, now() FROM generate_series(1,10000) n`;
          await tx.$executeRaw`INSERT INTO chat_admin_allowlist (chat_id, user_id)
            SELECT ${target}, 'skew-admin-' || n FROM generate_series(1,200) n`;
          await tx.$executeRaw`INSERT INTO domain_allowlist (chat_id, domain)
            SELECT ${target}, 'skew-domain-' || n || '.test' FROM generate_series(1,200) n`;
          for (const table of tables)
            await tx.$executeRaw(Prisma.sql`ANALYZE ${Prisma.raw(table)}`);
          setupCompletedAt = performance.now();

          const source = tx as unknown as PrismaService;
          for (const media of [{}, { greeting: { base64: large, mimeType: 'image/png' } }]) {
            await tx.chatSettings.update({
              where: { chatId: target },
              data: { botSpeechMedia: media },
            });
            queries.length = 0;
            const full = await readChatContextSource(source, target, now, null);
            expect(full.mode).toBe('full');
            expect(full.row!.settings!.botSpeechMedia).toEqual(media);
            expect(full.row!.admins).toHaveLength(203);
            expect(full.row!.domains).toHaveLength(203);
            expect(queries).toHaveLength(1);
            expect(selectQueries()).toHaveLength(1);
            queries.length = 0;
            const reused = await readChatContextSource(source, target, now, template(full));
            expect(reused.mode).toBe('shell');
            expect(reused.row!.settings!.botSpeechMedia).toEqual(media);
            expect(reused.row!.admins).toHaveLength(203);
            expect(reused.row!.domains).toHaveLength(203);
            expect(selectQueries()).toHaveLength(1);
            expect(selectQueries()[0]).not.toContain('bot_speech_media');
          }
          for (const [mode, statement] of [
            ['shell', chatContextShellQuery(target, now)],
            ['full', chatContextFullQuery(target, now)],
          ] as const) {
            const result = await tx.$queryRaw<{ 'QUERY PLAN': { Plan: Plan }[] }[]>(
              Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`,
            );
            const plans: Plan[] = [];
            const visit = (node: Plan) => {
              plans.push(node);
              node.Plans?.forEach(visit);
            };
            visit(result[0]!['QUERY PLAN'][0]!.Plan);
            const relevant = plans.filter((plan) => plan['Relation Name']);
            expect(new Set(relevant.map((plan) => plan['Relation Name']))).toEqual(new Set(tables));
            for (const scan of relevant) {
              expect(scan['Node Type']).not.toBe('Seq Scan');
              expect(
                (scan['Actual Rows'] + (scan['Rows Removed by Filter'] ?? 0)) *
                  scan['Actual Loops'],
              ).toBeLessThan(500);
            }
            console.info(
              'Chat context source native indexed plan',
              JSON.stringify({
                mode,
                relationScans: relevant.map((scan) => ({
                  relation: scan['Relation Name'],
                  nodeType: scan['Node Type'],
                  examinedRows:
                    (scan['Actual Rows'] + (scan['Rows Removed by Filter'] ?? 0)) *
                    scan['Actual Loops'],
                })),
              }),
            );
          }
          checksCompletedAt = performance.now();
          // FLAG: Fixture writes/ANALYZE must not consume the source-check budget.
          // Keep the measured phase bounded separately from the larger setup envelope.
          expect(checksCompletedAt - setupCompletedAt).toBeLessThan(20_000);
          throw fixtureRollback;
        },
        { maxWait: 5_000, timeout: 60_000 },
      );
    } catch (error) {
      if (error !== fixtureRollback) throw error;
    } finally {
      rollbackCompletedAt = performance.now();
      // FLAG: ANALYZE statistics can outlive rollback. Restore them for following native cases.
      for (const table of tables) await raw.query(`ANALYZE ${table}`);
      statisticsRestoredAt = performance.now();
    }
    expect(await db.chat.findUnique({ where: { id: target }, select: { id: true } })).toBeNull();
    expect(
      await db.nightModeTransitionReconcileRequest.count({
        where: { chatId: { startsWith: prefix } },
      }),
    ).toBe(0);
    expect(
      await db.nightModeTransitionReconcileRequest.findUnique({ where: { chatId } }),
    ).not.toBeNull();
    console.info(
      'Chat context source native fixture phases',
      JSON.stringify({
        chats: 10_000,
        setupMs: Math.round(setupCompletedAt - startedAt),
        sourceChecksMs: Math.round(checksCompletedAt - setupCompletedAt),
        rollbackMs: Math.round(rollbackCompletedAt - checksCompletedAt),
        restoreStatisticsMs: Math.round(statisticsRestoredAt - rollbackCompletedAt),
      }),
    );
  }, 90_000);
});
