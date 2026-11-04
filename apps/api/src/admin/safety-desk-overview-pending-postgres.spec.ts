import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { Prisma } from '../prisma/prisma-client';
import {
  buildSafetyDeskOverviewPendingIndexQuery,
  buildSafetyDeskOverviewPendingQuery,
} from './safety-desk-overview-pending.query';
import type { SafetyDeskOverviewPendingSnapshot } from './safety-desk-overview-pending.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;

function nodes(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return [];
  return [
    ...('Node Type' in value ? [value as Record<string, unknown>] : []),
    ...Object.values(value).flatMap(nodes),
  ];
}

describePostgres('Safety Desk bounded unfinished work on native PostgreSQL', () => {
  let pool: Pool;
  let client: PoolClient;
  jest.setTimeout(30_000);

  beforeAll(() => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test database required');
    pool = new Pool({ connectionString: databaseUrl, max: 1, statement_timeout: 5_000 });
  });
  beforeEach(async () => {
    client = await pool.connect();
    const schema = `pending_${randomUUID().replaceAll('-', '')}`;
    await client.query(`BEGIN; CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema}, public;
      SET LOCAL TIME ZONE 'UTC';
      CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED','QUEUED','PROCESSED','DUPLICATE','FAILED','NO_REPLAY_HELD','CANCELLED','QUARANTINED');
      CREATE TYPE "MaxActionLedgerStatus" AS ENUM ('ENQUEUED','IN_PROGRESS','SUCCEEDED','SKIPPED','AMBIGUOUS','FAILED_RETRYABLE','FAILED_TERMINAL');
      CREATE TABLE webhook_events(id text PRIMARY KEY, bot_id text, status "WebhookStatus" NOT NULL,
        created_at timestamp(3) NOT NULL, raw_payload jsonb);
      CREATE INDEX webhook_events_bot_id_status_created_at_idx ON webhook_events(bot_id,status,created_at);
      CREATE TABLE max_action_ledger(id text PRIMARY KEY, bot_id text, status "MaxActionLedgerStatus" NOT NULL,
        terminal boolean NOT NULL, updated_at timestamp(3) NOT NULL, metadata jsonb);
      CREATE INDEX max_action_ledger_status_terminal_updated_idx ON max_action_ledger(status,terminal,updated_at);`);
  });
  afterEach(async () => {
    await client?.query('ROLLBACK');
    client?.release();
  });
  afterAll(async () => {
    await pool?.end();
  });

  function execute(query: Prisma.Sql) {
    return client.query(query.text, query.values);
  }
  async function snapshot(defaultId: string | null = 'major') {
    const result = await execute(
      buildSafetyDeskOverviewPendingQuery(['major', 'second'], defaultId),
    );
    return result.rows[0].snapshot as SafetyDeskOverviewPendingSnapshot & {
      invalidClocks: boolean;
    };
  }

  it('keeps legacy receipts in the exact default bot, counts only unfinished actions, and exposes no payload', async () => {
    await client.query(`INSERT INTO webhook_events VALUES
      ('r1','major','RECEIVED',now()-interval '5 minutes','{"secret":"private"}'),
      ('r2',NULL,'RECEIVED',now()-interval '10 minutes','{"secret":"private"}'),
      ('q1','second','QUEUED',now()-interval '1 minute','{}'),
      ('ignored','major','PROCESSED',now()-interval '1 day','{}');
      INSERT INTO max_action_ledger VALUES
      ('a1',NULL,'ENQUEUED',false,now()-interval '4 minutes','{"secret":"private"}'),
      ('a2','second','AMBIGUOUS',false,now()-interval '2 minutes','{}'),
      ('done','second','SUCCEEDED',true,now()-interval '1 day','{}');`);
    const before = await client.query<{ oldestAt: string; observedAt: string }>(
      `SELECT to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "oldestAt",
        to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "observedAt"
      FROM webhook_events WHERE id='r2'`,
    );
    const result = await snapshot();
    const after = await client.query<{ observedAt: string }>(
      `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "observedAt"`,
    );
    expect(result.invalidClocks).toBe(false);
    expect(result.unfinishedActions).toMatchObject({ countLowerBound: 2, truncated: false });
    expect(result.bots[0]).toMatchObject({
      botId: 'major',
      received: { countLowerBound: 2, truncated: false },
      queued: { countLowerBound: 0 },
      unfinishedActions: { countLowerBound: 1 },
    });
    expect(result.bots[1]).toMatchObject({
      botId: 'second',
      queued: { countLowerBound: 1 },
      unfinishedActions: { countLowerBound: 1 },
    });
    expect(result.bots[0]!.received.oldestAt).toBe(before.rows[0]!.oldestAt);
    expect(Date.parse(result.observedAt)).toBeGreaterThanOrEqual(
      Date.parse(before.rows[0]!.observedAt),
    );
    expect(Date.parse(result.observedAt)).toBeLessThanOrEqual(
      Date.parse(after.rows[0]!.observedAt),
    );
    const withoutDefault = await snapshot(null);
    expect(withoutDefault.bots[0]?.received.countLowerBound).toBe(1);
    expect(withoutDefault.bots[0]?.unfinishedActions.countLowerBound).toBe(0);
    expect(JSON.stringify(result)).not.toMatch(/secret|private|metadata|payload|a1|r1/);
  });

  it('preserves lower bounds and global action coverage when another bot saturates a source head', async () => {
    await client.query(`INSERT INTO webhook_events
      SELECT 'r'||n,'major','RECEIVED',now()-interval '1 minute', '{}' FROM generate_series(1,200) n;
      INSERT INTO max_action_ledger
      SELECT 'a'||n,'major','ENQUEUED',false,now()-interval '2 hours','{}' FROM generate_series(1,200) n;
      INSERT INTO max_action_ledger VALUES ('newer-second','second','ENQUEUED',false,now(),'{}');`);
    const result = await snapshot();
    expect(result.bots[0]?.received).toMatchObject({ countLowerBound: 64, truncated: true });
    expect(result.unfinishedActions).toMatchObject({ countLowerBound: 64, truncated: true });
    expect(result.bots[1]?.unfinishedActions).toEqual({
      countLowerBound: 0,
      truncated: true,
      oldestStateAt: null,
    });
  });

  it('flags future source clocks and refuses missing or misleading index definitions', async () => {
    expect((await execute(buildSafetyDeskOverviewPendingIndexQuery())).rows).toEqual([
      { ready: true },
    ]);
    await client.query(
      `INSERT INTO webhook_events VALUES ('future','major','RECEIVED',now()+interval '1 hour','{}')`,
    );
    expect((await snapshot()).invalidClocks).toBe(true);
    await client.query(`DROP INDEX max_action_ledger_status_terminal_updated_idx;
      CREATE INDEX max_action_ledger_status_terminal_updated_idx ON max_action_ledger(status,updated_at,terminal)`);
    expect((await execute(buildSafetyDeskOverviewPendingIndexQuery())).rows).toEqual([
      { ready: false },
    ]);
  });

  it('bounds real index work despite retained terminal history, skew, ties and empty bot queues', async () => {
    await client.query(`INSERT INTO webhook_events
      SELECT 'old'||n,'major','PROCESSED',now()-interval '1 day','{}' FROM generate_series(1,60_000) n;
      INSERT INTO webhook_events
      SELECT 'pending'||n,'major','RECEIVED',now()-interval '1 hour','{}' FROM generate_series(1,1_200) n;
      INSERT INTO max_action_ledger
      SELECT 'done'||n,'major','FAILED_RETRYABLE',true,now()-interval '2 days','{}' FROM generate_series(1,60_000) n;
      INSERT INTO max_action_ledger
      SELECT 'pending'||n,'major','FAILED_RETRYABLE',false,now()-interval '1 hour','{}' FROM generate_series(1,1_200) n;
      ANALYZE webhook_events; ANALYZE max_action_ledger;`);
    const query = buildSafetyDeskOverviewPendingQuery(['major', 'second'], 'major');
    // FLAG: Execution plans run only against this disposable native fixture.
    const result = await client.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.text}`,
      query.values,
    );
    const scans = nodes(result.rows).filter((node) =>
      ['webhook_events', 'max_action_ledger'].includes(String(node['Relation Name'])),
    );
    expect(scans.length).toBeGreaterThanOrEqual(4);
    for (const scan of scans) {
      expect(scan['Node Type']).toMatch(/Index/);
      expect(scan['Rows Removed by Filter'] ?? 0).toBeLessThanOrEqual(1);
      if (scan['Index Name'] === 'max_action_ledger_pkey') {
        expect(scan['Actual Loops']).toBeLessThanOrEqual(448);
        expect(scan['Actual Rows']).toBeLessThanOrEqual(1);
      } else {
        expect(scan['Actual Rows']).toBeLessThanOrEqual(65);
        expect(scan['Actual Loops']).toBeLessThanOrEqual(7);
      }
    }
    const head = scans.find(
      (node) => node['Index Name'] === 'max_action_ledger_status_terminal_updated_idx',
    );
    expect(head?.['Index Cond']).toMatch(/status.*terminal/);
    expect((await snapshot()).bots[1]).toMatchObject({
      botId: 'second',
      received: { countLowerBound: 0, truncated: false },
    });
  });
});
