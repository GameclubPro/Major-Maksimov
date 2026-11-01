import { Client } from 'pg';
import { commercialAiQualityAttemptSchema } from '@maxim/contracts/commercial-ai-quality';
import { type Prisma } from '../prisma/prisma-client';
import { COMMERCIAL_LLM_POOL_PROFILES } from '../moderation/commercial/commercial-llm-pool.protocol';
import { COMMERCIAL_LLM_POLICY_VERSION } from '../moderation/commercial/commercial-llm.protocol';
import {
  commercialLlmPoolEnforcementIdentity,
  commercialLlmSourceKey,
  commercialLlmSourceSchema,
} from '../moderation/commercial/commercial-llm-enforcement.protocol';
import { commercialAiQualityDigest as digest } from './commercial-ai-quality-report';
import {
  aiDiagnosticInputSha256,
  buildAiDiagnosticExplainSql,
  buildAiDiagnosticPageSql,
  buildAiOwnReceiptSql,
  commercialAiDiagnosticOptionsSchema,
  verifyAiOwnReceipt,
  type AiDiagnosticRow,
  type AiOwnReceiptRow,
} from './commercial-ai-diagnostic-export';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;
const since = '2026-11-01T10:00:00.000Z',
  until = '2026-11-01T11:00:00.000Z';
const options = commercialAiDiagnosticOptionsSchema.parse({ since, until, pageSize: 100 });
function ownFixture() {
  const eventAtMs = Date.parse(since) + 1000;
  const source = commercialLlmSourceSchema.parse({
    version: 2,
    poolPolicy: 'confirm-positive',
    classifierSha256: commercialLlmPoolEnforcementIdentity('confirm-positive'),
    origin: {
      sourceWebhookEventId: 'native-webhook',
      sourceReceivingBotId: 'native-bot',
      sourceExecutionBotId: 'native-bot',
      sourceEventAtMs: eventAtMs,
      sourceEvidenceVersion: 1,
    },
    nonce: '00000000-0000-4000-8000-000000000001',
    chatId: 'native-chat',
    messageId: 'native-message',
    userId: 'native-user',
    originBotId: 'native-bot',
    eventAtMs,
    deadlineAtMs: eventAtMs + 60_000,
    sourceSha256: digest('raw'),
    settingsSha256: digest('settings'),
  });
  const { protocolVersion: _protocolVersion, ...identity } =
    COMMERCIAL_LLM_POOL_PROFILES['pc-b-9b'].identity;
  void _protocolVersion;
  const decision = {
    hasDetection: false,
    actionable: false,
    deleteEligible: false,
    score: 0,
    actionBand: 'ALLOW',
    messageDisposition: 'KEEP',
    detectorVersion: 'synthetic',
    decisionFingerprint: digest('decision'),
    reasons: [],
    requiredPolicyCohorts: [],
  };
  const attempt = commercialAiQualityAttemptSchema.parse({
    sourceKey: commercialLlmSourceKey(source),
    inputSha256: aiDiagnosticInputSha256('native safe source'),
    nonce: source.nonce,
    sourceVersion: source.version,
    sourceSha256: source.sourceSha256,
    settingsSha256: source.settingsSha256,
    settingsProfileDigest: digest('profile'),
    classifierIdentitySha256: source.classifierSha256,
    submittedAtMs: eventAtMs,
    eventAtMs,
    deadlineAtMs: source.deadlineAtMs,
    activeAuthority: 'AI_DELETE_ONLY',
    actualSynchronousDecision: { semantics: 'actual_post_routing_v1', decision },
    detectorBaseline: {
      semantics: 'counterfactual_pre_routing_v1',
      detectorSourceSha256: digest('detector'),
      decision,
    },
    admission: { state: 'ACCEPTED', reason: null },
    analysis: {
      state: 'COMPLETE',
      classificationOrigin: 'MODEL',
      result: {
        ...identity,
        classification: 'COMMERCIAL',
        reasonCodes: ['COMMERCIAL_OFFER'],
        policyVersion: COMMERCIAL_LLM_POLICY_VERSION,
        durationMs: 20,
        pool: {
          version: 'commercial-pool-v2',
          nodeId: 'pc-b-9b',
          route: 'direct',
          policy: 'confirm-positive',
          attempts: 1,
        },
      },
      policyDeleteEligible: true,
      observedAt: new Date(eventAtMs + 20).toISOString(),
      reason: null,
    },
    registration: {
      state: 'REGISTERED',
      intentIdSha256: aiDiagnosticInputSha256('native-intent'),
      reason: null,
    },
    execution: {
      state: 'PENDING',
      receiptSha256: null,
      observedAt: new Date(eventAtMs + 21).toISOString(),
    },
  });
  return {
    source,
    request: {
      captureKey: digest('native-capture'),
      chatId: source.chatId,
      messageId: source.messageId,
      evidenceHash: digest('native-evidence'),
      attempt,
    },
  };
}
function nodes(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  return [
    ...(typeof object['Node Type'] === 'string' ? [object] : []),
    ...Object.values(object).flatMap(nodes),
  ];
}

jest.setTimeout(30_000);
describePostgres('bounded private AI diagnostic PostgreSQL reads', () => {
  let client: Client;
  let indexDefinitions: { relation: string; name: string; definition: string }[];
  async function query<Row>(sql: Prisma.Sql) {
    return (await client.query(sql.text, sql.values)).rows as Row[];
  }
  async function assertExactReceiptPlan(sql: Prisma.Sql) {
    const explain = nodes(
      (await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql.text}`, sql.values)).rows,
    );
    for (const [relation, pattern] of [
      ['moderation_delete_intents', /UNIQUE.*\(chat_id, message_id\)/u],
      ['moderation_delete_intent_reasons', /UNIQUE.*\(intent_id, reason_key\)/u],
    ] as const) {
      const expected = indexDefinitions.find(
        (item) => item.relation === relation && pattern.test(item.definition),
      );
      expect(expected).toBeDefined();
      const scan = explain.find(
        (node) => node['Relation Name'] === relation && Number(node['Actual Loops']) > 0,
      );
      const actual = {
        indexName: scan?.['Index Name'],
        rows: Number(scan?.['Actual Rows']),
        filtered: Number(scan?.['Rows Removed by Filter'] ?? 0),
        loops: Number(scan?.['Actual Loops']),
      };
      if (
        actual.indexName !== expected!.name ||
        actual.rows + actual.filtered > 1 ||
        actual.filtered !== 0 ||
        actual.loops !== 1
      )
        throw new Error(
          `Unbounded exact receipt plan: ${JSON.stringify({ relation, expectedIndex: expected!.name, ...actual })}`,
        );
      expect(actual).toEqual({
        indexName: expected!.name,
        rows: expect.any(Number),
        filtered: 0,
        loops: 1,
      });
      expect(actual.rows + actual.filtered).toBeLessThanOrEqual(1);
    }
  }
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Diagnostic tests require a disposable local race_test database');
    client = new Client({
      connectionString: databaseUrl,
      statement_timeout: 10_000,
      query_timeout: 15_000,
    });
    await client.connect();
    await client.query("SET TIME ZONE 'UTC'");
    for (const table of [
      'commercial_review_samples',
      'moderation_delete_intents',
      'moderation_delete_intent_reasons',
    ])
      await client.query(
        `CREATE TEMP TABLE ${table} (LIKE public.${table} INCLUDING DEFAULTS INCLUDING INDEXES)`,
      );
    indexDefinitions = (
      await client.query(
        `SELECT t.relname AS relation, i.relname AS name, pg_get_indexdef(i.oid) AS definition FROM pg_index x JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_class t ON t.oid=x.indrelid WHERE x.indrelid IN ('pg_temp.commercial_review_samples'::regclass,'pg_temp.moderation_delete_intents'::regclass,'pg_temp.moderation_delete_intent_reasons'::regclass)`,
      )
    ).rows;
    await client.query(
      `INSERT INTO commercial_review_samples (id,chat_id,user_id,message_id,source,evidence_hash,score,evidence,observed_at,expires_at,updated_at) SELECT 'history-'||n,'history-chat','history-user','history-'||n,'OCR','history-hash-'||n,0,'{}'::jsonb,'2026-10-01'::timestamp,'2026-10-15'::timestamp,'2026-10-01'::timestamp FROM generate_series(1,20000)n`,
    );
    await client.query(
      `INSERT INTO commercial_review_samples (id,chat_id,user_id,message_id,source,evidence_hash,score,evidence,observed_at,expires_at,updated_at) SELECT 'current-'||lpad(n::text,4,'0'),'current-chat','current-user','current-'||n,'OCR','current-hash-'||n,0,'{"excerpt":"safe native text"}'::jsonb,'2026-11-01T10:01:00Z'::timestamp,'2026-11-15'::timestamp,'2026-11-01T10:01:00Z'::timestamp FROM generate_series(1,1000)n`,
    );
    await client.query(
      `INSERT INTO moderation_delete_intents (id,chat_id,message_id,retry_until_at,updated_at) SELECT 'history-intent-'||n,'native-chat','history-message-'||n,'2026-10-02'::timestamp,'2026-10-01'::timestamp FROM generate_series(1,20000)n`,
    );
    await client.query(
      `INSERT INTO moderation_delete_intent_reasons(id,intent_id,reason_key,rule_code,updated_at) SELECT 'history-reason-'||n,'history-intent-'||n,'MESSAGE_LENGTH','MESSAGE_LENGTH','2026-10-01'::timestamp FROM generate_series(1,20000)n`,
    );
    const { source, request } = ownFixture();
    await client.query(
      `INSERT INTO moderation_delete_intents(id,chat_id,message_id,retry_until_at,remote_delete_succeeded_at,remote_delete_succeeded_bot_id,updated_at) VALUES ('native-intent',$1,$2,$3,$4,'native-delete-bot',$4)`,
      [
        source.chatId,
        source.messageId,
        new Date(source.deadlineAtMs),
        new Date(source.eventAtMs + 30),
      ],
    );
    await client.query(
      `INSERT INTO moderation_delete_intent_reasons(id,intent_id,reason_key,rule_code,updated_at) SELECT 'same-intent-reason-'||n,'native-intent','unrelated-reason-'||n,'MESSAGE_LENGTH','2026-10-01'::timestamp FROM generate_series(1,5000)n`,
    );
    await client.query(
      `INSERT INTO moderation_delete_intent_reasons(id,intent_id,reason_key,rule_code,metadata,updated_at) VALUES ('native-ai','native-intent',$1,'COMMERCIAL_LLM_DELETE',$2::jsonb,$3),('native-length','native-intent','MESSAGE_LENGTH','MESSAGE_LENGTH','{"moderationDeleteVerified":true}'::jsonb,$3)`,
      [
        `COMMERCIAL_LLM_DELETE:${request.attempt.sourceKey}`,
        JSON.stringify({
          commercialLlmSource: source,
          commercialAiObservation: {
            evidenceHash: request.evidenceHash,
            inputSha256: request.attempt.inputSha256,
          },
          moderationDeleteVerified: true,
        }),
        new Date(source.eventAtMs + 30),
      ],
    );
    for (const table of [
      'commercial_review_samples',
      'moderation_delete_intents',
      'moderation_delete_intent_reasons',
    ])
      await client.query(`ANALYZE ${table}`);
  });
  afterAll(async () => {
    await client?.end();
  });

  it('plans both real collection templates without executing them or returning actual rows', async () => {
    for (const template of buildAiDiagnosticExplainSql(options)) {
      expect(template.sql.text).toMatch(/^EXPLAIN \(FORMAT JSON\) /u);
      expect(template.sql.text).not.toMatch(/\bANALYZE\b/u);
      const result = await query<Record<string, unknown>>(template.sql);
      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('QUERY PLAN');
      const planNodes = nodes(result);
      expect(planNodes.length).toBeGreaterThan(0);
      expect(planNodes.every((node) => !('Actual Rows' in node) && !('Actual Loops' in node))).toBe(
        true,
      );
    }
  });

  it('uses the migrated neutral index and advances raw rows even when all sources are unsupported', async () => {
    const sql = buildAiDiagnosticPageSql({ ...options, cursor: null });
    const first = await query<AiDiagnosticRow>(sql);
    expect(first).toHaveLength(100);
    expect(first.every((row) => row.source === 'OCR')).toBe(true);
    const second = await query<AiDiagnosticRow>(
      buildAiDiagnosticPageSql({
        ...options,
        cursor: { observedAt: first.at(-1)!.observedAt.toISOString(), id: first.at(-1)!.id },
      }),
    );
    expect(second[0]!.id).toBe('current-0101');
    const explain = nodes(
      (await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql.text}`, sql.values)).rows,
    );
    const scans = explain.filter(
      (node) =>
        node['Relation Name'] === 'commercial_review_samples' && Number(node['Actual Loops']) > 0,
    );
    expect(scans).toHaveLength(1);
    const index = indexDefinitions.find(
      (item) =>
        item.relation === 'commercial_review_samples' &&
        /\(observed_at DESC, id DESC\)/u.test(item.definition),
    );
    expect(index).toBeDefined();
    expect(scans[0]!['Index Name']).toBe(index!.name);
    expect(explain.some((node) => node['Node Type'] === 'CTE Scan')).toBe(true);
    expect(
      Number(scans[0]!['Actual Rows']) + Number(scans[0]!['Rows Removed by Filter'] ?? 0),
    ).toBeLessThanOrEqual(100);
  });

  it('uses exact indexes for a late or absent own reason amid skew and never borrows another rule', async () => {
    const { request } = ownFixture();
    const sql = buildAiOwnReceiptSql([request]);
    const own = await query<AiOwnReceiptRow>(sql);
    expect(own).toHaveLength(1);
    expect(verifyAiOwnReceipt(request, own[0]!)?.state).toBe('CONFIRMED_DELETE');
    await assertExactReceiptPlan(sql);
    await client.query(
      `UPDATE moderation_delete_intent_reasons SET metadata=jsonb_set(metadata,'{moderationDeleteVerified}','false') WHERE id='native-ai'`,
    );
    const rejected = await query<AiOwnReceiptRow>(sql);
    expect(rejected).toHaveLength(1);
    expect(verifyAiOwnReceipt(request, rejected[0]!)).toBeNull();
    await client.query(`DELETE FROM moderation_delete_intent_reasons WHERE id='native-ai'`);
    expect(await query<AiOwnReceiptRow>(sql)).toEqual([]);
    await assertExactReceiptPlan(sql);
  });

  it.each([
    { chatId: 'native-chat', messageId: 'native-a-before-message', candidates: 1 },
    { chatId: 'a-before-native-chat', messageId: 'native-message', candidates: 1 },
    { chatId: 'z-after-native-chat', messageId: 'native-message', candidates: 0 },
  ])(
    'rejects a missing exact intent at $chatId/$messageId without borrowing the next key',
    async ({ chatId, messageId, candidates }) => {
      const { request } = ownFixture();
      const sql = buildAiOwnReceiptSql([{ ...request, chatId, messageId }]);
      expect(await query<AiOwnReceiptRow>(sql)).toEqual([]);
      const explain = nodes(
        (await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql.text}`, sql.values))
          .rows,
      );
      const scan = explain.find(
        (node) =>
          node['Relation Name'] === 'moderation_delete_intents' && Number(node['Actual Loops']) > 0,
      );
      const expected = indexDefinitions.find(
        (item) =>
          item.relation === 'moderation_delete_intents' &&
          /UNIQUE.*\(chat_id, message_id\)/u.test(item.definition),
      );
      if (candidates > 0) expect(scan?.['Index Name']).toBe(expected!.name);
      else expect(scan?.['Node Type']).toMatch(/^Index (?:Only )?Scan$/u);
      expect({
        rows: Number(scan?.['Actual Rows']),
        filtered: Number(scan?.['Rows Removed by Filter'] ?? 0),
        loops: Number(scan?.['Actual Loops']),
      }).toEqual({ rows: candidates, filtered: 0, loops: 1 });
      expect(
        explain.some(
          (node) =>
            node['Relation Name'] === 'moderation_delete_intent_reasons' &&
            Number(node['Actual Loops']) > 0,
        ),
      ).toBe(false);
    },
  );

  it('rejects stored wrong input/source observations despite the same successful intent', async () => {
    const { source, request } = ownFixture();
    for (const metadata of [
      {
        commercialLlmSource: source,
        commercialAiObservation: {
          evidenceHash: request.evidenceHash,
          inputSha256: digest('wrong-input'),
        },
        moderationDeleteVerified: true,
      },
      {
        commercialLlmSource: { ...source, sourceSha256: digest('wrong-source') },
        commercialAiObservation: {
          evidenceHash: request.evidenceHash,
          inputSha256: request.attempt.inputSha256,
        },
        moderationDeleteVerified: true,
      },
    ]) {
      await client.query(
        `INSERT INTO moderation_delete_intent_reasons(id,intent_id,reason_key,rule_code,metadata,updated_at) VALUES ('mismatch-ai','native-intent',$1,'COMMERCIAL_LLM_DELETE',$2::jsonb,now()) ON CONFLICT(intent_id,reason_key) DO UPDATE SET metadata=EXCLUDED.metadata`,
        [`COMMERCIAL_LLM_DELETE:${request.attempt.sourceKey}`, JSON.stringify(metadata)],
      );
      const rows = await query<AiOwnReceiptRow>(buildAiOwnReceiptSql([request]));
      expect(rows).toHaveLength(1);
      expect(verifyAiOwnReceipt(request, rows[0]!)).toBeNull();
    }
  });
});
