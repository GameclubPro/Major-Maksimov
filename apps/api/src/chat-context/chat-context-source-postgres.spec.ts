import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { createPrismaAdapter, Prisma, PrismaClient } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
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

    // FLAG: Measure serialized logical results, not PostgreSQL wire traffic. Cold statement
    // counts are evidence for optimization; their current multi-query shape is not a contract.
    expect(samples[0].coldSelects).toBeGreaterThanOrEqual(1);
    expect(samples[1].coldSelects).toBeGreaterThanOrEqual(1);
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

  it('keeps settings and proof from one repeatable snapshot across a concurrent committed write', async () => {
    const original = await read();
    let snapshot!: { settingsId: string; revision: string };
    const concurrent = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== '$transaction') return Reflect.get(target, property, receiver);
        return <T>(
          callback: (tx: Prisma.TransactionClient) => Promise<T>,
          options: { isolationLevel?: Prisma.TransactionIsolationLevel },
        ) =>
          db.$transaction(async (tx) => {
            const [observed] = await tx.$queryRaw<{ settingsId: string; revision: string }[]>(
              Prisma.sql`SELECT s.id AS "settingsId", v.revision::text
              FROM chat_settings s JOIN chat_settings_cache_revisions v USING (chat_id)
              WHERE s.chat_id = ${chatId}`,
            );
            snapshot = observed;
            await raw.query(
              'UPDATE chat_settings SET anti_spam_enabled = true WHERE chat_id = $1',
              [chatId],
            );
            return callback(tx);
          }, options);
      },
    });
    const loaded = await readChatContextSource(concurrent as PrismaService, chatId, now, null);
    expect(loaded.proof).toEqual(snapshot);
    expect(loaded.proof).toEqual(original.proof);
    expect(loaded.row!.settings!.antiSpamEnabled).toBe(false);
    const after = await read(template(loaded));
    expect(after.mode).toBe('full');
    expect(after.row!.settings!.antiSpamEnabled).toBe(true);
    expect(after.proof).not.toEqual(loaded.proof);
  });

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

  it('bounds shell work on 10,000 chats with large settings and skewed shell relations', async () => {
    let step = 0;
    const started = performance.now();
    const fixtureQuery = async (text: string, values?: unknown[]) => {
      const queryStarted = performance.now();
      const queryStep = ++step;
      try {
        return await raw.query(text, values);
      } finally {
        process.stdout.write(
          `Chat context history fixture phase ${JSON.stringify({
            step: queryStep,
            operation: text.trim().split(/\s/u)[0],
            durationMs: Math.round(performance.now() - queryStarted),
            elapsedMs: Math.round(performance.now() - started),
          })}\n`,
        );
      }
    };
    const prefix = `settings-plan-${randomUUID()}-`;
    const target = `${prefix}1`;
    const large = Buffer.from('native-heavy-template'.repeat(16_000)).toString('base64');
    try {
      await fixtureQuery(
        `INSERT INTO chats (id, title, updated_at)
        SELECT $1 || n, 'History', now() FROM generate_series(1,10000) n`,
        [prefix],
      );
      // Refresh parent statistics before FK and statement-trigger lookups on the new history.
      await fixtureQuery('ANALYZE chats');
      await fixtureQuery(
        `INSERT INTO chat_admin_allowlist (chat_id, user_id)
        SELECT $1 || n, 'history-admin-' || u
        FROM generate_series(1,10000) n CROSS JOIN generate_series(1,3) u`,
        [prefix],
      );
      await fixtureQuery(
        `INSERT INTO domain_allowlist (chat_id, domain)
        SELECT $1 || n, 'history-domain-' || d || '.test'
        FROM generate_series(1,10000) n CROSS JOIN generate_series(1,3) d`,
        [prefix],
      );
      await fixtureQuery(
        `INSERT INTO chat_rules (id, chat_id, updated_at)
        SELECT $1 || n, $1 || n, now() FROM generate_series(1,10000) n`,
        [prefix],
      );
      await fixtureQuery(
        `INSERT INTO chat_admin_allowlist (chat_id, user_id)
        SELECT $1, 'skew-admin-' || n FROM generate_series(1,200) n`,
        [target],
      );
      await fixtureQuery(
        `INSERT INTO domain_allowlist (chat_id, domain)
        SELECT $1, 'skew-domain-' || n || '.test' FROM generate_series(1,200) n`,
        [target],
      );
      // Default settings are created last so domain policy triggers do not reread
      // 30,200 wide rows for a policy that makes no changes to this fixture.
      await fixtureQuery(
        `INSERT INTO chat_settings (id, chat_id, updated_at)
        SELECT $1 || n, $1 || n, now() FROM generate_series(1,10000) n`,
        [prefix],
      );
      for (const table of [
        'chats',
        // The shell joins settings by chat_id and projects id; other settings columns
        // cannot influence its plan. Keep the full rows, analyze its actual inputs.
        'chat_settings (id, chat_id)',
        'chat_settings_cache_revisions',
        'chat_admin_allowlist',
        'domain_allowlist',
        'chat_rules',
      ])
        await fixtureQuery(`ANALYZE ${table}`);

      for (const media of [{}, { greeting: { base64: large, mimeType: 'image/png' } }]) {
        await db.chatSettings.update({
          where: { chatId: target },
          data: { botSpeechMedia: media },
        });
        const full = await readChatContextSource(db as PrismaService, target, now, null);
        queries.length = 0;
        const reused = await readChatContextSource(
          db as PrismaService,
          target,
          now,
          template(full),
        );
        expect(reused.mode).toBe('shell');
        expect(reused.row!.settings!.botSpeechMedia).toEqual(media);
        expect(reused.row!.admins).toHaveLength(203);
        expect(reused.row!.domains).toHaveLength(203);
        expect(selectQueries()).toHaveLength(1);
        expect(selectQueries()[0]).not.toContain('bot_speech_media');
      }
      const statement = chatContextShellQuery(target, now);
      const result = await fixtureQuery(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.text}`,
        statement.values,
      );
      const plans: Plan[] = [];
      const visit = (node: Plan) => {
        plans.push(node);
        node.Plans?.forEach(visit);
      };
      visit(result.rows[0]['QUERY PLAN'][0].Plan as Plan);
      const relevant = plans.filter((plan) => plan['Relation Name']);
      expect(new Set(relevant.map((plan) => plan['Relation Name']))).toEqual(
        new Set([
          'chats',
          'chat_settings',
          'chat_settings_cache_revisions',
          'chat_admin_allowlist',
          'chat_admin_roster_states',
          'domain_allowlist',
          'chat_rules',
        ]),
      );
      for (const scan of relevant) {
        expect(scan['Node Type']).not.toBe('Seq Scan');
        expect(
          (scan['Actual Rows'] + (scan['Rows Removed by Filter'] ?? 0)) * scan['Actual Loops'],
        ).toBeLessThan(500);
      }
    } finally {
      // FLAG: Exact random fixture prefix only; cascades remove metadata/relations.
      // Settings deletion recreates non-FK reconcile requests, so remove them last.
      await fixtureQuery('DELETE FROM chats WHERE left(id, length($1)) = $1', [prefix]);
      await fixtureQuery(
        'DELETE FROM night_mode_transition_reconcile_requests WHERE left(chat_id, length($1)) = $1',
        [prefix],
      );
    }
    expect(
      (
        await raw.query(
          'SELECT count(*)::int AS remaining FROM night_mode_transition_reconcile_requests WHERE left(chat_id, length($1)) = $1',
          [prefix],
        )
      ).rows[0].remaining,
    ).toBe(0);
    expect(
      await db.nightModeTransitionReconcileRequest.findUnique({ where: { chatId } }),
    ).not.toBeNull();
  }, 30_000);
});
