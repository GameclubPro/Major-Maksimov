import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import {
  buildSourceEnvelopeAuditSql,
  emitSourceEnvelopeAuditSql,
  sourceEnvelopeIndexSql,
  SOURCE_ENVELOPE_MAX_BYTES,
} from './webhook-source-envelope-audit.mjs';

const ownerId = 'f2c3bcde-9248-4527-8eee-8b44ece4083c';
const privateValue = 'PRIVATE_SOURCE_TEXT_URL_TOKEN_ID';
const fixtureSql = `CREATE TABLE webhook_events(id text PRIMARY KEY, normalized_payload jsonb);
ALTER TABLE webhook_events ALTER COLUMN normalized_payload SET STORAGE EXTERNAL;`;
function payload() {
  return {
    botId: privateValue,
    message: { text: privateValue },
    raw: {
      message: {
        sender: { user_id: privateValue, is_bot: false },
        recipient: { chat_id: privateValue, chat_type: 'chat' },
        timestamp: 123,
        body: { mid: privateValue, seq: 12, text: '', attachments: [] },
        link: {
          type: 'forward',
          chat_id: privateValue,
          sender: { user_id: privateValue, is_bot: false },
          message: {
            mid: privateValue,
            text: privateValue,
            attachments: [
              {
                type: 'image',
                payload: { photo_id: privateValue, url: `https://example.com/${privateValue}` },
              },
            ],
            markup: [
              { type: 'link', from: 0, length: 3, url: `https://example.com/${privateValue}` },
            ],
          },
        },
      },
    },
  };
}
async function fixture(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(fixtureSql);
  return db;
}
async function seed(db, value = payload()) {
  await db.query(
    'INSERT INTO webhook_events VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET normalized_payload=excluded.normalized_payload',
    [ownerId, JSON.stringify(value)],
  );
}
async function report(db, id = ownerId) {
  await db.exec('BEGIN READ ONLY');
  try {
    const value = (await db.query(buildSourceEnvelopeAuditSql(id))).rows[0].jsonb_build_object;
    assert.equal(value.read_only, true);
    assert.equal(value.authority, 'DIAGNOSTICS_ONLY');
    for (const key of ['replay_authorized', 'settlement_authorized', 'remote_effects_proven'])
      assert.equal(value[key], false);
    assert.equal(value.source_validation, 'not_evaluated');
    assert.equal(value.effect_completeness, 'unknown');
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE_|f2c3bcde|https?:\/\//u);
    return value;
  } finally {
    await db.exec('ROLLBACK');
  }
}
const walk = (node) => [node, ...(node.Plans ?? []).flatMap(walk)];

test('exact owner arguments are bounded; index and resolution guards precede SELECT/plain EXPLAIN', () => {
  for (const bad of [
    '',
    null,
    [],
    '/tmp/query.sql',
    "owner'; SELECT 1",
    'x'.repeat(129),
    'owner name',
    '--apply',
  ]) {
    assert.throws(() => buildSourceEnvelopeAuditSql(bad));
  }
  for (const explain of [false, true]) {
    const sql = emitSourceEnvelopeAuditSql(ownerId, explain);
    assert.ok(
      sql.indexOf('search_path TO pg_catalog, public, pg_temp') <
        sql.indexOf('source_envelope_index_ready'),
    );
    assert.ok(
      sql.indexOf('source_envelope_index_ready') <
        sql.indexOf(explain ? 'EXPLAIN (FORMAT JSON)' : 'WITH candidate'),
    );
    assert.match(sql, /FROM public\.webhook_events WHERE id = '[a-z0-9-]+' LIMIT 1/u);
    assert.doesNotMatch(sql, /EXPLAIN ANALYZE|UPDATE |DELETE |INSERT |jsonb_object_keys/u);
  }
  const cli = spawnSync(process.execPath, [
    'infra/scripts/webhook-source-envelope-audit.mjs',
    ownerId,
    '--explain',
    'extra',
  ]);
  assert.notEqual(cli.status, 0);
});

test('one exact source reports finite forwarded envelope shape while withholding content/identities', async (t) => {
  const db = await fixture(t);
  await seed(db);
  const value = await report(db);
  assert.equal(value.found, true);
  assert.equal(value.payload_admission, 'bounded');
  const shape = value.shape;
  assert.equal(shape.message_keys_supported, true);
  assert.equal(shape.link_type, 'forward');
  assert.equal(shape.link_keys_supported, true);
  assert.equal(shape.linked_chat_id_valid, true);
  assert.equal(shape.linked_sender.kind, 'object');
  assert.equal(shape.linked_sender.user_id_valid, true);
  assert.equal(shape.outer_body.mid_valid, true);
  assert.equal(shape.outer_body.sequence_valid, true);
  assert.equal(shape.outer_body.text_kind, 'string');
  assert.equal(shape.linked_body.attachments.items[0].type, 'image');
  assert.equal(shape.linked_body.markup.items[0].type, 'link');
  assert.equal((await report(db, 'missing-owner')).found, false);
});

test('share diagnostics distinguish the modern key set from the legacy generic shape without admitting content', async (t) => {
  const db = await fixture(t);
  const p = payload();
  const share = {
    type: 'share',
    payload: { url: `https://example.com/${privateValue}`, token: privateValue },
    title: privateValue,
    description: privateValue,
    image_url: `https://example.com/${privateValue}`,
  };
  p.raw.message.link.message.attachments = [share];
  await seed(db, p);
  let item = (await report(db)).shape.linked_body.attachments.items[0];
  assert.equal(item.keys_supported, false);
  assert.equal(item.modern_share_keys_supported, true);
  assert.equal(item.modern_share_payload_keys_supported, true);
  assert.equal(item.title_kind, 'string');
  assert.equal(item.description_kind, 'string');
  assert.equal(item.image_url_kind, 'string');
  share[privateValue] = privateValue;
  await seed(db, p);
  item = (await report(db)).shape.linked_body.attachments.items[0];
  assert.equal(item.modern_share_keys_supported, false);
  delete share[privateValue];
  share.payload[privateValue] = privateValue;
  await seed(db, p);
  assert.equal(
    (await report(db)).shape.linked_body.attachments.items[0].modern_share_payload_keys_supported,
    false,
  );
  assert.equal((await report(db)).shape.media_and_markup_runtime_validation, 'not_evaluated');
});

const faults = [
  [
    'raw',
    (p) => {
      p.raw = [];
    },
    (s) => s.raw_kind === 'array',
  ],
  [
    'outer message',
    (p) => {
      p.raw.message = 3;
    },
    (s) => s.message_kind === 'number',
  ],
  [
    'normalized message',
    (p) => {
      p.message = null;
    },
    (s) => s.normalized_message_kind === 'null',
  ],
  [
    'direct body',
    (p) => {
      p.raw.message.body = [];
    },
    (s) => s.outer_body.kind === 'array',
  ],
  [
    'direct keys',
    (p) => {
      p.raw.message.body[privateValue] = privateValue;
    },
    (s) => !s.outer_body.keys_supported,
  ],
  [
    'direct mid',
    (p) => {
      p.raw.message.body.mid = 9007199254740992;
    },
    (s) => !s.outer_body.mid_valid,
  ],
  [
    'direct seq',
    (p) => {
      p.raw.message.body.seq = null;
    },
    (s) => !s.outer_body.sequence_valid,
  ],
  [
    'direct text',
    (p) => {
      p.raw.message.body.text = null;
    },
    (s) => s.outer_body.text_kind === 'null',
  ],
  [
    'direct attachments',
    (p) => {
      p.raw.message.body.attachments = {};
    },
    (s) => s.outer_body.attachments.kind === 'object',
  ],
  [
    'link',
    (p) => {
      p.raw.message.link = [];
    },
    (s) => s.link_kind === 'array',
  ],
  [
    'link keys',
    (p) => {
      p.raw.message.link[privateValue] = privateValue;
    },
    (s) => !s.link_keys_supported,
  ],
  [
    'type',
    (p) => {
      p.raw.message.link.type = privateValue;
    },
    (s) => s.link_type === 'other',
  ],
  [
    'chat missing',
    (p) => {
      delete p.raw.message.link.chat_id;
    },
    (s) => s.linked_chat_id_kind === 'absent' && !s.linked_chat_id_valid,
  ],
  [
    'sender omitted',
    (p) => {
      delete p.raw.message.link.sender;
    },
    (s) => s.linked_sender_omitted && s.linked_sender.kind === 'absent',
  ],
  [
    'sender null',
    (p) => {
      p.raw.message.link.sender = null;
    },
    (s) => !s.linked_sender_omitted && s.linked_sender.kind === 'null',
  ],
  [
    'sender identity',
    (p) => {
      p.raw.message.link.sender.user_id = '\tquoted';
    },
    (s) => !s.linked_sender.user_id_valid,
  ],
  [
    'sender keys',
    (p) => {
      p.raw.message.link.sender[privateValue] = privateValue;
    },
    (s) => !s.linked_sender.keys_supported,
  ],
  [
    'sender bot',
    (p) => {
      p.raw.message.link.sender.is_bot = 'false';
    },
    (s) => s.linked_sender.bot_flag_kind === 'string',
  ],
  [
    'sender metadata',
    (p) => {
      p.raw.message.link.sender.name = {};
    },
    (s) => !s.linked_sender.optional_strings_valid,
  ],
  [
    'sender activity',
    (p) => {
      p.raw.message.link.sender.last_activity_time = 0.5;
    },
    (s) => !s.linked_sender.last_activity_valid,
  ],
  [
    'linked body',
    (p) => {
      p.raw.message.link.message = null;
    },
    (s) => s.linked_body.kind === 'null',
  ],
  [
    'linked body keys',
    (p) => {
      p.raw.message.link.message.link = {};
    },
    (s) => !s.linked_body.keys_supported,
  ],
  [
    'linked text',
    (p) => {
      p.raw.message.link.message.text = null;
    },
    (s) => s.linked_body.text_kind === 'null',
  ],
  [
    'normalized text',
    (p) => {
      p.message.text = null;
    },
    (s) => s.normalized_text_kind === 'null',
  ],
  [
    'bot',
    (p) => {
      p.botId = {};
    },
    (s) => s.receiver_kind === 'object',
  ],
];
test('every forward-shape deciding family has separate bounded observations, including nullable/absent metadata', async (t) => {
  const db = await fixture(t);
  for (const [name, mutate, check] of faults) {
    const value = payload();
    mutate(value);
    await seed(db, value);
    assert.ok(check((await report(db)).shape), name);
  }
});

test('malformed JSON and over-cap nested collections remain explicit without unsafe expansion or data output', async (t) => {
  const db = await fixture(t);
  for (const value of [
    null,
    [],
    'string',
    1,
    false,
    { raw: { message: { link: { sender: 1, message: true, body: [] } } } },
  ]) {
    await seed(db, value);
    await report(db);
  }
  for (const key of ['attachments', 'markup']) {
    const value = payload();
    const cap = key === 'attachments' ? 10 : 32;
    value.raw.message.link.message[key] = Array.from({ length: cap + 1 }, () => ({
      type: privateValue,
    }));
    await seed(db, value);
    const nested = (await report(db)).shape.linked_body[key];
    assert.equal(nested.within_cap, false);
    assert.equal(nested.items, null);
  }
  await seed(db, { message: { text: privateValue.repeat(SOURCE_ENVELOPE_MAX_BYTES) } });
  const oversized = await report(db);
  assert.equal(oversized.payload_admission, 'oversized_not_inspected');
  assert.equal(oversized.shape, null);
});

test('PK attestation rejects drift instead of trusting an index name', async (t) => {
  const db = await fixture(t);
  assert.equal((await db.query(sourceEnvelopeIndexSql)).rows[0].source_envelope_index_ready, true);
  for (const ddl of [
    'ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY',
    'ALTER INDEX webhook_events_pkey SET (fillfactor=80)',
    'ALTER TABLE webhook_events DROP CONSTRAINT webhook_events_pkey; CREATE INDEX webhook_events_pkey ON webhook_events(id)',
  ]) {
    await db.exec(`BEGIN; ${ddl}`);
    assert.equal(
      (await db.query(sourceEnvelopeIndexSql)).rows[0].source_envelope_index_ready,
      false,
    );
    await db.exec('ROLLBACK');
  }
});

async function nativeFixture(run) {
  const url = new URL(process.env.MAXIM_TEST_POSTGRES_URL);
  assert.ok(
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) &&
      url.pathname.includes('race_test'),
  );
  const { default: pg } = await import('pg');
  const name = `race_test_envelope_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: url.href });
  const childUrl = new URL(url);
  childUrl.pathname = `/${name}`;
  const db = new pg.Client({
    connectionString: childUrl.href,
    options: '-c timezone=UTC -c statement_timeout=10000 -c lock_timeout=250',
  });
  db.exec = (sql) => db.query(sql);
  let created = false;
  // FLAG: Only a new disposable local database owns DDL/fixtures/timed plans.
  // The migrated wrapper database and production are never modified by this test.
  try {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    created = true;
    await db.connect();
    assert.match((await db.query('SHOW server_version')).rows[0].server_version, /^16\./u);
    await db.exec(fixtureSql);
    await run(db, childUrl);
  } finally {
    await db.end();
    if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  }
}

test(
  'native PG16 exact PK work stays bounded with retained history, malformed/oversized/compressed payloads and locked rows',
  { skip: !process.env.MAXIM_TEST_POSTGRES_URL, timeout: 90000 },
  async () => {
    await nativeFixture(async (db, childUrl) => {
      await seed(db);
      await db.exec(`INSERT INTO webhook_events(id,normalized_payload)
        SELECT 'retained-'||n, jsonb_build_object('private', '${privateValue}') FROM generate_series(1,50000) n;
        ANALYZE webhook_events; SET enable_seqscan=off; SET enable_bitmapscan=off;
        SET max_parallel_workers_per_gather=0; SET jit=off; SET work_mem='1MB'; SET temp_file_limit='8MB'; SET statement_timeout=2500;`);
      for (const [, mutate, check] of faults) {
        const value = payload();
        mutate(value);
        await seed(db, value);
        assert.ok(check((await report(db)).shape));
      }
      await seed(db);
      const { default: pg } = await import('pg');
      const locker = new pg.Client({ connectionString: childUrl.href });
      await locker.connect();
      try {
        await locker.query('BEGIN');
        await locker.query('SELECT id FROM webhook_events WHERE id=$1 FOR UPDATE', [ownerId]);
        await report(db);
      } finally {
        await locker.query('ROLLBACK');
        await locker.end();
      }
      const plan = (
        await db.query(
          `EXPLAIN (ANALYZE, FORMAT JSON, BUFFERS) ${buildSourceEnvelopeAuditSql(ownerId)}`,
        )
      ).rows[0]['QUERY PLAN'][0].Plan;
      const scans = walk(plan).filter((n) => n['Relation Name'] === 'webhook_events');
      assert.equal(scans.length, 1);
      assert.equal(scans[0]['Index Name'], 'webhook_events_pkey');
      assert.match(scans[0]['Index Cond'], /id =/u);
      assert.equal(scans[0]['Actual Rows'] * scans[0]['Actual Loops'], 1);
      assert.equal(scans[0]['Rows Removed by Filter'] ?? 0, 0);
      await db.exec(
        'ALTER TABLE webhook_events ALTER COLUMN normalized_payload SET STORAGE EXTENDED',
      );
      await seed(db, { private: privateValue.repeat(20000) });
      assert.equal((await report(db)).payload_admission, 'compressed_not_inspected');
      assert.equal((await report(db)).shape, null);
      await db.exec(
        'ALTER TABLE webhook_events ALTER COLUMN normalized_payload SET STORAGE EXTERNAL',
      );
      await seed(db, { private: privateValue.repeat(20000) });
      assert.equal((await report(db)).payload_admission, 'oversized_not_inspected');
      const role = `envelope_audit_${randomUUID().replaceAll('-', '')}`;
      await db.exec(`CREATE ROLE ${role}; GRANT USAGE ON SCHEMA public TO ${role};
        GRANT SELECT(id, normalized_payload) ON webhook_events TO ${role}; SET ROLE ${role}`);
      try {
        await report(db);
      } finally {
        await db.exec(`RESET ROLE; DROP OWNED BY ${role}; DROP ROLE ${role}`);
      }
    });
  },
);
