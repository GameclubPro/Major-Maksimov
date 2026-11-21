import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';
import {
  families,
  parseScope,
  provisionSql,
  privilegeCondition,
  reportSql,
  buildQuery,
} from './spammer-retirement-audit.mjs';

const token = (data) => Buffer.from(JSON.stringify(data)).toString('base64url');
test('rejects invalid pagination and both entrypoints use the same validator', () => {
  for (const argv of [
    ['--limit', '0'],
    ['--limit', '41'],
    ['--limit', '2', '--limit', '1'],
    ['--family', 'other'],
    ['--after', token(['chats', 'a', 'b'])],
    ['--after', 'bad'],
    ['--explain', '--explain'],
    ['--apply'],
  ])
    assert.throws(() => parseScope(argv));
  assert.deepEqual(parseScope(['--family', 'chats', '--after', token(['chats', 'x', 'y'])]).after, [
    'x',
    'y',
  ]);
  for (const f of ['vps-postgres-audit.sh', 'vps-connect.sh'])
    assert.match(
      readFileSync(new URL(f, import.meta.url), 'utf8'),
      /spammer-retirement-audit\.mjs" --validate-scope/u,
    );
  const provision = readFileSync(
    new URL('vps-provision-postgres-audit-role.sh', import.meta.url),
    'utf8',
  );
  assert.ok(provision.includes(provisionSql()));
  for (const key of Object.keys(families)) {
    const sql = reportSql(['--family', key, '--explain']);
    assert.match(sql, /EXPLAIN \(FORMAT JSON\)/u);
    assert.match(sql, /LIMIT 26/u);
    assert.doesNotMatch(sql, /EXPLAIN ANALYZE/u);
  }
});

const dbUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL;
test(
  'native history pages use primary-key bounds, suppress oversized data and enforce exact view privileges',
  { skip: !dbUrl },
  async () => {
    const url = new URL(dbUrl);
    assert.ok(
      ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
        url.pathname.includes('race_test'),
    );
    const db = new Client({ connectionString: dbUrl });
    await db.connect();
    async function report(args) {
      const options = parseScope(args);
      const params = options.after ?? [];
      const sql = buildQuery(options);
      return (
        await db.query({
          text: sql,
          values: options.family === 'chats' ? params : params.slice(0, 1),
        })
      ).rows[0].report;
    }
    try {
      await db.query('BEGIN');
      for (const role of ['maxim', 'maxim_audit'])
        if (!(await db.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role])).rowCount)
          await db.query('CREATE ROLE ' + role);
      const dbName = (await db.query('SELECT current_database() AS name')).rows[0].name;
      assert.match(dbName, /^[a-zA-Z0-9_]+$/u);
      await db.query('GRANT CREATE ON DATABASE ' + dbName + ' TO maxim');
      for (const [table] of Object.values(families))
        await db.query('GRANT SELECT ON public.' + table + ' TO maxim');
      await db.query(
        "INSERT INTO global_spammers(user_id,last_reason,last_detected_at,expires_at,source_breakdown,last_evidence) VALUES ('a','a',now(),now()+interval '1 day','{\"DEVELOPER_FORCED\":{}}','{\"excerpt\":\"secret-marker\"}'),('b','b',now(),now(),'{\"DEVELOPER_FORCED\":{},\"FANOUT_HIGH\":{}}',null),('c','c',now(),now(),'{\"FANOUT_HIGH\":{}}',null)",
      );
      await db.query(
        "INSERT INTO global_spammers(user_id,last_reason,last_detected_at,last_evidence) SELECT 'z'||lpad(i::text,6,'0'),'synthetic',now(),jsonb_build_object('excerpt',repeat('wide',9000)) FROM generate_series(1,1024)i",
      );
      await db.query('ANALYZE public.global_spammers');
      await db.query('SET LOCAL ROLE maxim');
      await db.query(provisionSql());
      await db.query(provisionSql());
      await db.query('RESET ROLE');
      await db.query('SET LOCAL ROLE maxim_audit');
      assert.equal(
        (await db.query('SELECT ' + privilegeCondition(true) + ' AS ready')).rows[0].ready,
        true,
      );
      await db.query(
        'SET LOCAL enable_seqscan=off; SET LOCAL enable_bitmapscan=off; SET LOCAL plan_cache_mode=force_generic_plan',
      );
      const first = await report(['--limit', '2']);
      assert.equal(first.retiredOnly, 1);
      assert.equal(first.mixed, 1);
      assert.equal(first.activeRetiredOrMixed, 1);
      assert.equal(first.rawCopyIndicators, 1);
      assert.equal(first.scanned, 2);
      assert.equal(first.mutationAuthorized, false);
      assert.ok(first.nextCursor);
      const second = await report(['--limit', '2', '--after', first.nextCursor]);
      assert.equal(second.scanned, 2);
      assert.equal(second.rawCopyUnmeasured, 1);
      assert.doesNotMatch(JSON.stringify([first, second]), /secret-marker|wide/u);
      for (const [family, [table]] of Object.entries(families)) {
        const args = [
          '--family',
          family,
          '--after',
          token([family, 'z000900', family === 'chats' ? 'subkey' : '']),
        ];
        const scope = parseScope(args);
        const plan = (
          await db.query({
            text: 'EXPLAIN (FORMAT JSON) ' + buildQuery(scope),
            values: family === 'chats' ? scope.after : scope.after.slice(0, 1),
          })
        ).rows;
        const nodes = [];
        const walk = (node) => {
          nodes.push(node);
          for (const child of node.Plans ?? []) walk(child);
        };
        walk(plan[0]['QUERY PLAN'][0].Plan);
        const scan = nodes.find(
          (n) => n['Relation Name'] === table && n['Index Cond']?.includes('>'),
        );
        assert.ok(scan && scan['Index Cond']?.includes('>'), JSON.stringify(plan));
        const probe = nodes.find((n) => n['Subplan Name'] === 'CTE probe');
        assert.equal(probe?.['Node Type'], 'Limit');
        assert.doesNotMatch(
          JSON.stringify(probe),
          /"Node Type":"(?:Sort|Incremental Sort|Seq Scan|Bitmap Heap Scan)"/u,
        );
        assert.ok(
          nodes.some((n) => n['Relation Name'] === table && n['Index Cond']?.includes('=')),
        );
        assert.ok(nodes.some((n) => n['Node Type'] === 'Limit'));
        assert.ok(!nodes.some((n) => ['Seq Scan', 'Bitmap Heap Scan'].includes(n['Node Type'])));
        assert.equal((await report(['--family', family, '--limit', '1'])).family, family);
      }
      await db.query('SAVEPOINT denial');
      await assert.rejects(
        db.query('SELECT last_evidence FROM public.global_spammers LIMIT 1'),
        /permission denied/u,
      );
      await db.query('ROLLBACK TO SAVEPOINT denial');
      await db.query('RESET ROLE');
      await db.query('GRANT SELECT ON maxim_spammer_audit.registry TO maxim_audit');
      assert.equal(
        (await db.query('SELECT ' + privilegeCondition(true) + ' AS ready')).rows[0].ready,
        false,
      );
    } finally {
      await db.query('ROLLBACK').catch(() => {});
      await db.end();
    }
  },
);
