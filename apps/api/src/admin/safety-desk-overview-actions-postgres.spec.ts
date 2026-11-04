import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import {
  buildOverviewActionIndexQuery,
  buildOverviewActionQuery,
  projectOverviewActions,
  type OverviewActionRow,
} from './safety-desk-overview-actions.service';
import type { Prisma } from '../prisma/prisma-client';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const native = databaseUrl ? describe : describe.skip;
const at = new Date('2035-01-01T12:00:00.000Z');
function nodes(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return [];
  return [
    ...('Node Type' in value ? [value as Record<string, unknown>] : []),
    ...Object.values(value).flatMap(nodes),
  ];
}

native('Safety Desk terminal completion head on native PostgreSQL', () => {
  let pool: Pool, client: PoolClient;
  jest.setTimeout(30000);
  beforeAll(() => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test database required');
    pool = new Pool({ connectionString: databaseUrl, max: 1, statement_timeout: 5000 });
  });
  beforeEach(async () => {
    client = await pool.connect();
    const schema = `overview_actions_${randomUUID().replaceAll('-', '')}`;
    await client.query(`BEGIN; CREATE SCHEMA ${schema}; SET LOCAL search_path TO ${schema}, public;
      SET LOCAL TIME ZONE 'UTC';
      CREATE TABLE max_action_ledger(id text PRIMARY KEY, bot_id text, status text NOT NULL,
        terminal boolean NOT NULL, completed_at timestamp(3), enqueued_at timestamp(3), metadata jsonb);
      CREATE INDEX max_action_ledger_terminal_completed_id_idx ON max_action_ledger(terminal,completed_at DESC,id DESC);`);
  });
  afterEach(async () => {
    await client?.query('ROLLBACK');
    client?.release();
  });
  afterAll(async () => {
    await pool?.end();
  });
  const execute = (query: Prisma.Sql) => client.query(query.text, query.values);

  it('attests exact index layout and refuses index drift', async () => {
    expect((await execute(buildOverviewActionIndexQuery())).rows).toEqual([{ ready: true }]);
    await client.query(`DROP INDEX max_action_ledger_terminal_completed_id_idx;
      CREATE INDEX max_action_ledger_terminal_completed_id_idx ON max_action_ledger(terminal,completed_at,id);`);
    expect((await execute(buildOverviewActionIndexQuery())).rows).toEqual([{ ready: false }]);
  });
  it('bounds indexed work across retained history, recent skew and completion ties, without projecting JSON bodies', async () => {
    await client.query(`INSERT INTO max_action_ledger
      SELECT 'old'||n,'major','SUCCEEDED',true,'2030-01-01','2030-01-01','{"secret":"private"}'
      FROM generate_series(1,30000) n;
      INSERT INTO max_action_ledger
      SELECT 'live'||lpad(n::text,6,'0'),'major','FAILED_TERMINAL',true,
        '2035-01-01 12:00:00','2035-01-01 11:59:58','{"secret":"private","scheduledFor":"2035-01-01T11:59:59.000Z"}'
      FROM generate_series(1,6000) n;
      ANALYZE max_action_ledger;`);
    const query = buildOverviewActionQuery(new Date(at.getTime() - 900000), at);
    const result = await execute(query);
    expect(result.rows).toHaveLength(5001);
    expect(JSON.stringify(result.rows)).not.toContain('private');
    const snapshot = projectOverviewActions(
      result.rows as OverviewActionRow[],
      at,
      ['major', 'quiet'],
      'major',
    );
    expect(snapshot.actions).toMatchObject({
      sampleCount: 5000,
      sampleComplete: false,
      latency: { p50Ms: 1000, p95Ms: 1000, p99Ms: 1000 },
    });
    // FLAG: Runtime plans are measured only against this disposable native fixture.
    const plan = await client.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.text}`,
      query.values,
    );
    const scans = nodes(plan.rows).filter((node) => node['Relation Name'] === 'max_action_ledger');
    expect(scans).toHaveLength(2);
    for (const scan of scans) {
      expect(scan['Node Type']).toMatch(/Index/);
      expect(scan['Rows Removed by Filter'] ?? 0).toBeLessThanOrEqual(1);
      expect(scan['Actual Rows']).toBeLessThanOrEqual(5001);
      expect(scan['Actual Loops']).toBeLessThanOrEqual(5001);
    }
  });
  it('rejects compressed and oversized timing metadata before JSON inspection while preserving terminal outcomes', async () => {
    const insert = async (id: string, metadata: object | null) =>
      client.query(
        `INSERT INTO max_action_ledger VALUES ($1,'major','SUCCEEDED',true,$2,$3,$4::jsonb)`,
        [
          id,
          at,
          new Date(at.getTime() - 5000),
          metadata === null ? null : JSON.stringify(metadata),
        ],
      );
    const scheduledFor = new Date(at.getTime() - 1000).toISOString();
    await insert('compressed-1mb', { padding: 'a'.repeat(1048576), scheduledFor });
    await insert('compressed-small', { padding: 'a'.repeat(8000), scheduledFor });
    await client.query('ALTER TABLE max_action_ledger ALTER COLUMN metadata SET STORAGE EXTERNAL');
    await insert('oversized-uncompressed', { padding: 'b'.repeat(20000), scheduledFor });
    await insert('invalid-type', { scheduledFor: 12 });
    await insert('invalid-date', { scheduledFor: 'not-a-date' });
    await insert('valid', { scheduledFor });
    await insert('null-metadata', null);
    const storage = await client.query(`SELECT id, pg_column_compression(metadata) AS compression,
      pg_column_size(metadata) AS bytes FROM max_action_ledger ORDER BY id`);
    expect(storage.rows.find((row) => row.id === 'compressed-1mb').compression).not.toBeNull();
    expect(storage.rows.find((row) => row.id === 'compressed-small').bytes).toBeLessThan(8192);
    expect(storage.rows.find((row) => row.id === 'compressed-small').compression).not.toBeNull();
    expect(storage.rows.find((row) => row.id === 'oversized-uncompressed')).toMatchObject({
      compression: null,
    });
    expect(storage.rows.find((row) => row.id === 'oversized-uncompressed').bytes).toBeGreaterThan(
      8192,
    );
    const result = await execute(buildOverviewActionQuery(new Date(at.getTime() - 900000), at));
    const rows = result.rows as OverviewActionRow[];
    expect(rows.filter((row) => row.timingMetadataInspected)).toHaveLength(3);
    expect(
      rows.filter((row) => !row.timingMetadataInspected).every((row) => row.scheduledFor === null),
    ).toBe(true);
    const snapshot = projectOverviewActions(rows, at, ['major'], 'major');
    expect(snapshot.actions.sampleCount).toBe(7);
    expect(snapshot.actions.outcomes).toEqual([{ outcome: 'SUCCEEDED', count: 7 }]);
    expect(snapshot.actions.latency).toEqual({
      sampleCount: 2,
      p50Ms: 1000,
      p95Ms: 5000,
      p99Ms: 5000,
    });
  });
});
