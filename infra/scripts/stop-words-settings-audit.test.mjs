import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  buildStopWordsSettingsQuery,
  buildStopWordsSettingsProvisionSql,
  buildStopWordsSettingsVerificationSql,
  parseStopWordsSettingsArgs,
  stopWordsSettingsIndexCondition,
  stopWordsSettingsPrivilegesCondition,
} from './stop-words-settings-audit.mjs';

const hash = (value) => createHash('md5').update(value).digest('hex');
const nativeUrl = process.env.MAXIM_TEST_POSTGRES_URL?.trim();
const args = ['-123', '--word-hash', hash('желание'), '--sender-hash', hash('private-user')];

test('stop-word audit rejects broadened, repeated, and SQL-bearing scopes', () => {
  assert.equal(parseStopWordsSettingsArgs(args).chatId, '-123');
  for (const bad of [
    [],
    ['-0'],
    ['0'],
    ['-01'],
    ['-1,-2'],
    ['-1;SELECT 1'],
    ['-1', '--apply'],
    ['-1', '--word-hash', 'желание'],
    ['-1', '--sender-hash', 'F'.repeat(32)],
    ['-1', '--explain', '--explain'],
    ['-1', '--word-hash', hash('x'), '--word-hash', hash('y')],
  ])
    assert.throws(() => parseStopWordsSettingsArgs(bad));
});

test('checked-in provisioning is exactly the reviewed generator output', () => {
  const source = readFileSync(
    new URL('./vps-provision-postgres-audit-role.sh', import.meta.url),
    'utf8',
  );
  assert.ok(source.includes(buildStopWordsSettingsProvisionSql()));
  assert.ok(source.includes(buildStopWordsSettingsVerificationSql()));
});

test(
  'native stop-word audit bounds metadata reads, preserves privacy and rejects unsafe grants/indexes',
  { skip: !nativeUrl, timeout: 30_000 },
  async () => {
    const address = new URL(nativeUrl);
    assert.ok(
      ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname) &&
        address.pathname.includes('race_test'),
    );
    const { default: pg } = await import('pg');
    const client = new pg.Client({
      connectionString: nativeUrl,
      options: '-c statement_timeout=5000 -c lock_timeout=250 -c timezone=UTC',
    });
    const suffix = randomUUID().replaceAll('-', '');
    const ns = `stop_words_${suffix}`;
    const role = `stop_words_${suffix}`;
    const extra = `${role}_extra`;
    const local = (sql) =>
      sql
        .replaceAll('public.', `${ns}.`)
        .replaceAll("'public'", `'${ns}'`)
        .replaceAll('maxim_audit', role);
    const ready = async (all = false) =>
      (await client.query(`SELECT ${local(stopWordsSettingsPrivilegesCondition(all))} AS ready`))
        .rows[0].ready;
    const indexesReady = async () =>
      (await client.query(`SELECT ${local(stopWordsSettingsIndexCondition())} AS ready`)).rows[0]
        .ready;
    const query = async () =>
      (await client.query(local(buildStopWordsSettingsQuery(args)))).rows[0].report;
    try {
      await client.connect();
      await client.query(`CREATE SCHEMA ${ns}; CREATE ROLE ${role}; CREATE ROLE ${extra};
        CREATE TABLE ${ns}.chat_settings(id text, chat_id text, stop_words_policy jsonb,
          stop_words_revision int, updated_at timestamptz, private_extra text);
        CREATE UNIQUE INDEX chat_settings_chat_id_key ON ${ns}.chat_settings(chat_id);
        CREATE TABLE ${ns}.chat_admin_allowlist(chat_id text,user_id text,private_extra text, PRIMARY KEY(chat_id,user_id));
        CREATE TABLE ${ns}.managed_entity_admin_members(chat_id text,user_id text,checked_at timestamptz,expires_at timestamptz,role text,private_extra text);
        CREATE INDEX managed_entity_admin_members_chat_checked_idx ON ${ns}.managed_entity_admin_members(chat_id,checked_at DESC);
        CREATE TABLE ${ns}.chat_participant_moderation_immunities(chat_id text,user_id text,expires_at timestamptz,
          daily_violation_limit int,daily_violation_usage int,usage_date_key text,updated_at timestamptz,private_extra text);
        CREATE UNIQUE INDEX chat_participant_moderation_immunities_chat_id_user_id_key ON ${ns}.chat_participant_moderation_immunities(chat_id,user_id);`);
      assert.equal(await indexesReady(), true);
      assert.equal(await ready(), true);
      assert.equal(await ready(true), false);
      await client.query(local(buildStopWordsSettingsProvisionSql()));
      assert.equal(await ready(true), true);
      await client.query(local(buildStopWordsSettingsProvisionSql()));
      assert.equal(await ready(true), true, 'provisioning is idempotent');
      await client.query(`REVOKE SELECT(updated_at) ON ${ns}.chat_settings FROM ${role}`);
      assert.equal(await ready(), false, 'partial group refuses admission');
      await client.query(local(buildStopWordsSettingsProvisionSql()));
      for (const grant of [
        `GRANT SELECT(private_extra) ON ${ns}.chat_settings TO ${role}`,
        `GRANT SELECT(private_extra) ON ${ns}.chat_admin_allowlist TO PUBLIC`,
        `GRANT SELECT(private_extra) ON ${ns}.managed_entity_admin_members TO ${extra}; GRANT ${extra} TO ${role}`,
        `GRANT UPDATE(user_id) ON ${ns}.chat_participant_moderation_immunities TO ${role}`,
        `GRANT SELECT ON ${ns}.chat_admin_allowlist TO ${role}`,
      ]) {
        await client.query('BEGIN');
        await client.query(grant);
        assert.equal(await ready(), false, grant);
        await assert.rejects(client.query(local(buildStopWordsSettingsProvisionSql())));
        await client.query('ROLLBACK');
      }
      await client.query(
        `INSERT INTO ${ns}.chat_settings VALUES('private-settings','-123',$1,7,now(),NULL)`,
        [
          {
            enabled: false,
            rules: [{ value: 'желание', enabled: true, matchMode: 'EXACT' }],
            sanctions: { botMessageText: 'private-template' },
          },
        ],
      );
      let report = await query();
      assert.equal(report.policy.masterEnabled, false);
      assert.equal(report.policy.matchingEnabledRules, 1);
      assert.equal(report.policy.matchingExactRules, 1);
      assert.equal(report.runtimePolicyValidation, 'not_performed');
      assert.equal(report.historicalStateProven, false);
      assert.doesNotMatch(
        JSON.stringify(report),
        /private-user|private-settings|private-template|желание/u,
      );
      assert.equal(report.sender.allowlistMatchObserved, false);
      await client.query(`INSERT INTO ${ns}.chat_admin_allowlist VALUES('-123','private-user',NULL);
        INSERT INTO ${ns}.managed_entity_admin_members VALUES('-123','private-user',now(),now()+interval '1 hour','ADMIN',NULL);
        INSERT INTO ${ns}.chat_participant_moderation_immunities VALUES('-123','private-user',NULL,3,1,'2026-10-31',now(),NULL);`);
      report = await query();
      assert.equal(report.sender.allowlistMatchObserved, true);
      assert.equal(report.sender.unexpiredAdminMatchObserved, true);
      assert.equal(report.sender.immunity.dailyViolationLimit, 3);
      await client.query(`UPDATE ${ns}.chat_settings SET stop_words_policy=$1`, [
        { enabled: true, rules: [{ value: 'желание' }] },
      ]);
      report = await query();
      assert.equal(report.policy.masterEnabled, true);
      assert.equal(report.policy.matchingEnabledRules, 1, 'runtime rule defaults represented');
      assert.equal(report.policy.matchingExactRules, 1);
      await client.query(`UPDATE ${ns}.chat_settings SET stop_words_policy=$1`, [
        { enabled: 'bad', rules: new Array(1000).fill({ value: 'желание' }) },
      ]);
      report = await query();
      assert.equal(report.policy.masterEnabled, null);
      if (report.policy.inspection === 'metadata_only') {
        assert.equal(report.policy.rulesWithinBound, false);
        assert.equal(report.policy.rulesInspected, 0);
      }
      await client.query(
        `ALTER TABLE ${ns}.chat_settings ALTER COLUMN stop_words_policy SET STORAGE EXTERNAL`,
      );
      await client.query(`UPDATE ${ns}.chat_settings SET stop_words_policy=$1`, [
        { enabled: true, private: 'private-data'.repeat(40000) },
      ]);
      report = await query();
      assert.equal(report.policy.inspection, 'storage_bound_refused');
      assert.equal(report.policy.masterEnabled, null);
      assert.equal(report.policy.rulesInspected, 0);
      await client.query(`UPDATE ${ns}.chat_settings SET stop_words_policy=NULL`);
      report = await query();
      assert.equal(report.policy.inspection, 'legacy');
      assert.equal(report.policy.masterEnabled, null);
      await client.query(`INSERT INTO ${ns}.chat_admin_allowlist SELECT '-123','user-'||n,NULL FROM generate_series(1,140)n;
        INSERT INTO ${ns}.managed_entity_admin_members SELECT '-123','user-'||n,now(),NULL,'ADMIN',NULL FROM generate_series(1,140)n;
        INSERT INTO ${ns}.chat_participant_moderation_immunities SELECT '-123','user-'||n,NULL,NULL,0,NULL,now(),NULL FROM generate_series(1,140)n;`);
      report = await query();
      assert.equal(report.sender.allowlistCapped, true);
      assert.equal(report.sender.adminRosterCapped, true);
      assert.equal(report.sender.immunitiesCapped, true);
      await client.query('SET enable_seqscan=off; SET enable_bitmapscan=off');
      const plan = JSON.stringify(
        (await client.query(`EXPLAIN (FORMAT JSON) ${local(buildStopWordsSettingsQuery(args))}`))
          .rows,
      );
      assert.doesNotMatch(plan, /Seq Scan|Bitmap Heap Scan/u);
      assert.match(plan, /chat_settings_chat_id_key/u);
      assert.match(plan, /managed_entity_admin_members_chat_checked_idx/u);
      await client.query(`DROP INDEX ${ns}.managed_entity_admin_members_chat_checked_idx;
        CREATE INDEX managed_entity_admin_members_chat_checked_idx ON ${ns}.managed_entity_admin_members(checked_at DESC,chat_id);`);
      assert.equal(await indexesReady(), false, 'same name with wrong key ordering refuses');
      await client.query(`DROP INDEX ${ns}.managed_entity_admin_members_chat_checked_idx;
        CREATE INDEX managed_entity_admin_members_chat_checked_idx ON ${ns}.managed_entity_admin_members(chat_id,checked_at DESC) WHERE role='ADMIN';`);
      assert.equal(await indexesReady(), false, 'partial index refuses');
      await client.query(`DROP SCHEMA ${ns} CASCADE; CREATE SCHEMA ${ns};`);
      assert.equal(await ready(), true);
      assert.equal(await ready(true), false);
      await client.query(local(buildStopWordsSettingsProvisionSql()));
    } finally {
      await client.query(
        `DROP SCHEMA IF EXISTS ${ns} CASCADE; DROP ROLE IF EXISTS ${role},${extra}`,
      );
      await client.end();
    }
  },
);
