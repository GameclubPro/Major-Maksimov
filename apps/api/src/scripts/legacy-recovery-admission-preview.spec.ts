import { type Prisma } from '../prisma/prisma-client';
import { inventoryLegacyRecoverySelectedSql } from './legacy-recovery-live-sql';
import { LEGACY_RECOVERY_LIVE_BUDGET } from './legacy-recovery-live-budget';
import {
  LEGACY_RECOVERY_LIVE_QUEUE_NAMES,
  LEGACY_RECOVERY_LIVE_QUEUE_STATES,
} from './legacy-recovery-live-registry';
import {
  LEGACY_RECOVERY_LIVE_REQUEST_MAX_BYTES,
  legacyRecoveryLiveDigest,
} from './legacy-recovery-live-protocol';
import {
  collectLegacyRecoveryAdmission,
  parseLegacyRecoveryAdmissionRequest,
} from './legacy-recovery-admission-preview';

jest.mock('./legacy-recovery-live-sql', () => ({ inventoryLegacyRecoverySelectedSql: jest.fn() }));

const sourceCoverageIssue = {
  code: 'selected_owner_proof_incomplete',
  descriptor: 'sql:webhook_events',
};
const storeRefusedIssue = {
  code: 'online_admission_store_or_budget_refused',
  descriptor: 'inventory',
};
const noCost = { pages: 0, rows: 0, probes: 0, bytes: 0 };
const mockSql = jest.mocked(inventoryLegacyRecoverySelectedSql);
function requestFixture() {
  return {
    version: 1,
    operation: 'admission_preview',
    sourceSha: 'a'.repeat(40),
    imageId: `sha256:${'b'.repeat(64)}`,
    selection: {
      ownerWebhookEventIds: ['owner-z', 'owner-a'],
      majorBotIds: ['major-z', 'major-a'],
    },
  };
}
function request() {
  return parseLegacyRecoveryAdmissionRequest(JSON.stringify(requestFixture()));
}
function headerRows(): (string | number)[][] {
  return LEGACY_RECOVERY_LIVE_QUEUE_NAMES.map((name) => [
    name,
    ...LEGACY_RECOVERY_LIVE_QUEUE_STATES.map(() => 0),
  ]);
}
function headerReply(rows = headerRows(), probes = LEGACY_RECOVERY_LIVE_QUEUE_NAMES.length * 8) {
  return [1, probes, JSON.stringify(rows)];
}
function sqlFixture(): Awaited<ReturnType<typeof inventoryLegacyRecoverySelectedSql>> {
  return {
    selectedOwners: ['owner-a', 'owner-z'].map((ownerWebhookEventId) => ({
      ownerWebhookEventId,
      semanticKey: `semantic-${ownerWebhookEventId}`,
      claimId: `claim-${ownerWebhookEventId}`,
      chatId: '-100',
      messageId: ownerWebhookEventId,
      userId: 'fixture-user',
      sourceAt: '2026-10-06T00:00:00.000Z',
      rawPayloadSha256: 'd'.repeat(64),
      normalizedPayloadSha256: 'e'.repeat(64),
      ownerSnapshotSha256: 'f'.repeat(64),
      claimSnapshotSha256: '0'.repeat(64),
    })),
    candidates: ['owner-a', 'owner-z'].map((id) => ({
      owner: { id, semanticKey: `semantic-${id}` },
      claim: { id: `claim-${id}` },
      source: {
        chatId: '-100',
        messageId: id,
        userId: 'fixture-user',
        sourceAt: new Date('2026-10-06T00:00:00Z'),
      },
      rawPayloadDigest: 'd'.repeat(64),
      normalizedPayloadDigest: 'e'.repeat(64),
    })) as unknown as Awaited<ReturnType<typeof inventoryLegacyRecoverySelectedSql>>['candidates'],
    proofs: [],
    stableDigest: 'c'.repeat(64),
    cost: { ...noCost },
    issues: [],
  };
}

describe('online legacy recovery admission request', () => {
  it('binds the separate Publisher identity without inserting it into the Major catalog', async () => {
    const parsed = parseLegacyRecoveryAdmissionRequest(
      JSON.stringify({ ...requestFixture(), publisherBotId: 'publisher' }),
    );
    expect(parsed.publisherBotId).toBe('publisher');
    expect(parsed.selection.majorBotIds).not.toContain('publisher');
    for (const publisherBotId of ['', null, ' major-a', 'major-a', true, 'bad:receiver'])
      expect(() =>
        parseLegacyRecoveryAdmissionRequest(
          JSON.stringify({ ...requestFixture(), publisherBotId }),
        ),
      ).toThrow('Invalid separate Publisher catalog');
  });
  it('accepts a separate live discriminator without a fabricated stopped generation', () => {
    const parsed = request();
    expect(parsed).toEqual({
      ...requestFixture(),
      selection: {
        ownerWebhookEventIds: ['owner-a', 'owner-z'],
        majorBotIds: ['major-a', 'major-z'],
      },
    });
    expect(parsed).not.toHaveProperty('binding');
    for (const value of [
      parsed,
      parsed.selection,
      parsed.selection.ownerWebhookEventIds,
      parsed.selection.majorBotIds,
    ]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it.each([
    { version: 2 },
    { version: '1' },
    { operation: 'inventory_preview' },
    { operation: 'install' },
    { operation: 'stop' },
    { sourceSha: 'A'.repeat(40) },
    { sourceSha: 'a'.repeat(39) },
    { imageId: 'b'.repeat(64) },
    { imageId: `sha256:${'B'.repeat(64)}` },
  ])('rejects an invalid discriminator or immutable identity %j', (change) => {
    expect(() =>
      parseLegacyRecoveryAdmissionRequest(JSON.stringify({ ...requestFixture(), ...change })),
    ).toThrow();
  });

  it.each([
    'binding',
    'stoppedGenerations',
    'activate',
    'stoppingAuthorized',
    'expectedInventorySha256',
  ])('rejects an offline/authority field %s instead of accepting asserted stop proof', (field) => {
    expect(() =>
      parseLegacyRecoveryAdmissionRequest(JSON.stringify({ ...requestFixture(), [field]: [] })),
    ).toThrow('Unknown admission field');
  });

  it('rejects unknown nested selection fields', () => {
    const fixture = requestFixture();
    expect(() =>
      parseLegacyRecoveryAdmissionRequest(
        JSON.stringify({
          ...fixture,
          selection: { ...fixture.selection, all: true },
        }),
      ),
    ).toThrow('Unknown admission field');
  });

  it.each(['ownerWebhookEventIds', 'majorBotIds'])(
    'rejects empty, duplicate, malformed and absent %s',
    (field) => {
      const fixture = requestFixture();
      for (const value of [[], ['same', 'same'], null, ['wrong:id'], ['x'.repeat(129)], [1]]) {
        expect(() =>
          parseLegacyRecoveryAdmissionRequest(
            JSON.stringify({
              ...fixture,
              selection: { ...fixture.selection, [field]: value },
            }),
          ),
        ).toThrow('Invalid admission selection');
      }
      const selection = Object.fromEntries(
        Object.entries(fixture.selection).filter(([key]) => key !== field),
      );
      expect(() =>
        parseLegacyRecoveryAdmissionRequest(JSON.stringify({ ...fixture, selection })),
      ).toThrow();
    },
  );

  it.each([
    ['ownerWebhookEventIds', 200],
    ['majorBotIds', 100],
  ] as const)('enforces a bounded %s selection of %i', (field, maximum) => {
    const fixture = requestFixture();
    const values = Array.from({ length: maximum }, (_, index) => `id-${index}`);
    const parse = (ids: string[]) =>
      parseLegacyRecoveryAdmissionRequest(
        JSON.stringify({
          ...fixture,
          selection: { ...fixture.selection, [field]: ids },
        }),
      );
    expect(() => parse(values)).not.toThrow();
    expect(() => parse([...values, 'extra'])).toThrow('Invalid admission selection');
  });

  it('checks the 64 KiB byte bound before parsing', () => {
    const json = JSON.stringify(requestFixture());
    const padded =
      json + ' '.repeat(LEGACY_RECOVERY_LIVE_REQUEST_MAX_BYTES - Buffer.byteLength(json));
    expect(() => parseLegacyRecoveryAdmissionRequest(padded)).not.toThrow();
    expect(() => parseLegacyRecoveryAdmissionRequest(padded + ' ')).toThrow(
      'Admission request budget exceeded',
    );
    const utf8 = JSON.stringify({ ...requestFixture(), sourceSha: 'я'.repeat(32_768) });
    expect(utf8.length).toBeLessThan(LEGACY_RECOVERY_LIVE_REQUEST_MAX_BYTES);
    expect(() => parseLegacyRecoveryAdmissionRequest(utf8)).toThrow(
      'Admission request budget exceeded',
    );
  });
});

describe('live read-only admission preview', () => {
  const tx = {} as Prisma.TransactionClient;
  beforeEach(() => {
    mockSql.mockReset();
    mockSql.mockResolvedValue(sqlFixture());
  });
  afterEach(() => jest.restoreAllMocks());

  it('passes the independently bound Publisher to SQL and returns only its catalog digest', async () => {
    const parsed = parseLegacyRecoveryAdmissionRequest(
      JSON.stringify({ ...requestFixture(), publisherBotId: 'publisher' }),
    );
    const result = await collectLegacyRecoveryAdmission(
      tx,
      { eval_ro: jest.fn().mockResolvedValue(headerReply()) },
      parsed,
    );
    expect(mockSql.mock.calls[0][1]).toEqual({
      selection: parsed.selection,
      publisherBotId: 'publisher',
    });
    expect(result.publisherCatalogSha256).toBe(
      legacyRecoveryLiveDigest({ publisherBotId: 'publisher' }),
    );
    expect(result).not.toHaveProperty('publisherBotId');
  });

  it('permits cold host review of proved sources without authorizing stopping or activation', async () => {
    const redis = { eval_ro: jest.fn().mockResolvedValue(headerReply()) };
    const parsed = request();
    const result = await collectLegacyRecoveryAdmission(tx, redis, parsed);
    expect(result).toMatchObject({
      operation: 'admission_preview',
      applied: false,
      activationAuthorized: false,
      stoppingAuthorized: false,
      decision: 'READY_FOR_COLD_REVIEW',
      sourceCoverageComplete: true,
      minimumEffectRowsForTwoReads: 0,
      selectedOwners: sqlFixture().selectedOwners,
      sqlPlans: [],
      selectionSha256: legacyRecoveryLiveDigest(parsed.selection),
      issues: [],
    });
    expect(result.queueCounts).toHaveLength(LEGACY_RECOVERY_LIVE_QUEUE_NAMES.length);
    expect(redis.eval_ro).toHaveBeenCalledTimes(1);
    expect(mockSql).toHaveBeenCalledTimes(1);
    expect(mockSql.mock.calls[0][0]).toBe(tx);
    expect(mockSql.mock.calls[0][1]).toEqual({ selection: parsed.selection });
    expect(mockSql.mock.calls[0][1]).not.toHaveProperty('binding');
    expect(mockSql.mock.calls[0][2]).toMatchObject({
      pages: LEGACY_RECOVERY_LIVE_BUDGET.pages - 1,
      probes: LEGACY_RECOVERY_LIVE_BUDGET.probes - LEGACY_RECOVERY_LIVE_QUEUE_NAMES.length * 8,
    });
    const [script, keyCount, names] = redis.eval_ro.mock.calls[0];
    expect(keyCount).toBe(0);
    expect(JSON.parse(names)).toEqual(LEGACY_RECOVERY_LIVE_QUEUE_NAMES);
    expect([...script.matchAll(/redis\.call\('([A-Z_]+)'/gu)].map((match) => match[1])).toEqual([
      'TYPE',
    ]);
    expect(script).toContain("index <= 3 and 'LLEN' or 'ZCARD'");
    expect(script).not.toMatch(
      /(?:pause-owner|QUEUE_FENCE|redis\.call\('(?:SET|DEL|LPUSH|ZADD|PAUSE|GET|HGET))/u,
    );
  });

  it('accepts protected descendants without walking 15408 unrelated effect rows', async () => {
    const rows = headerRows();
    rows.find((row) => row[0] === 'max-actions-background')![8] = 6819;
    rows.find((row) => row[0] === 'max-actions-interactive')![7] = 885;
    const redis = { eval_ro: jest.fn().mockResolvedValue(headerReply(rows)) };
    const result = await collectLegacyRecoveryAdmission(tx, redis, request());
    expect(result).toMatchObject({
      decision: 'READY_FOR_COLD_REVIEW',
      minimumEffectRowsForTwoReads: 15408,
    });
    expect(result.issues).toEqual([]);
    expect(mockSql).toHaveBeenCalledTimes(1);
  });

  it('rejects excessive webhook list membership work before SQL', async () => {
    const rows = headerRows();
    rows.find((row) => row[0] === 'moderation-default-15')![1] = 100_000;
    rows.find((row) => row[0] === 'max-actions-background')![1] = 5000;
    const result = await collectLegacyRecoveryAdmission(
      tx,
      { eval_ro: jest.fn().mockResolvedValue(headerReply(rows)) },
      request(),
    );
    expect(result.minimumEffectRowsForTwoReads).toBe(10_000);
    expect(mockSql).not.toHaveBeenCalled();
    expect(result.decision).toBe('DENY');
    expect(result.issues).toContainEqual({
      code: 'selected_owner_probes_exceed_two_read_budget',
      descriptor: 'redis:webhooks',
    });
  });

  it.each([
    'wrong_type',
    'unknown_queue',
    'unknown_state',
    'negative_count',
    'fractional_count',
    'missing_queue',
    'oversize',
  ])('refuses %s with a fixed code before SQL', async (kind) => {
    const rows = headerRows();
    let reply: unknown = headerReply(rows);
    if (kind === 'wrong_type') reply = [0];
    if (kind === 'unknown_queue') rows[0][0] = 'foreign-queue';
    if (kind === 'unknown_state') rows[0].push(0);
    if (kind === 'negative_count') rows[0][1] = -1;
    if (kind === 'fractional_count') rows[0][1] = 0.5;
    if (kind === 'missing_queue') rows.pop();
    if (kind !== 'wrong_type') reply = headerReply(rows);
    if (kind === 'oversize') reply = [1, 0, 'x'.repeat(64 * 1024 + 1)];
    const result = await collectLegacyRecoveryAdmission(
      tx,
      { eval_ro: jest.fn().mockResolvedValue(reply) },
      request(),
    );
    expect(result.issues).toContainEqual(storeRefusedIssue);
    expect(result.decision).toBe('DENY');
    expect(mockSql).not.toHaveBeenCalled();
  });

  it('rejects over-budget Redis probe accounting before beginning SQL', async () => {
    const result = await collectLegacyRecoveryAdmission(
      tx,
      {
        eval_ro: jest
          .fn()
          .mockResolvedValue(headerReply(headerRows(), LEGACY_RECOVERY_LIVE_BUDGET.probes + 1)),
      },
      request(),
    );
    expect(result.issues).toContainEqual(storeRefusedIssue);
    expect(result.issues).toContainEqual({
      code: 'online_admission_budget_exceeded',
      descriptor: 'redis:accounting',
    });
    expect(result.cost.probes).toBe(LEGACY_RECOVERY_LIVE_BUDGET.probes + 1);
    expect(mockSql).not.toHaveBeenCalled();
  });

  it.each([-1, NaN, Infinity, 0.5, LEGACY_RECOVERY_LIVE_BUDGET.rows + 1])(
    'refuses invalid or over-budget SQL row accounting %s',
    async (rows) => {
      mockSql.mockResolvedValue({ ...sqlFixture(), cost: { ...noCost, rows } });
      const result = await collectLegacyRecoveryAdmission(
        tx,
        { eval_ro: jest.fn().mockResolvedValue(headerReply()) },
        request(),
      );
      expect(result.issues).toContainEqual(storeRefusedIssue);
      expect(result.decision).toBe('DENY');
    },
  );

  it('refuses missing or duplicated source proofs', async () => {
    mockSql.mockResolvedValue({ ...sqlFixture(), candidates: [] });
    const result = await collectLegacyRecoveryAdmission(
      tx,
      { eval_ro: jest.fn().mockResolvedValue(headerReply()) },
      request(),
    );
    expect(result.issues).toContainEqual(sourceCoverageIssue);
    expect(result).toMatchObject({ decision: 'DENY', sourceCoverageComplete: false });
  });

  it('retains completed SQL evidence, refusal and cost when its return crosses the admission deadline', async () => {
    const now = Date.UTC(2026, 9, 6);
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    const sql: ReturnType<typeof sqlFixture> = {
      ...sqlFixture(),
      cost: { pages: 12, rows: 30, probes: 50, bytes: 2048 },
      issues: [{ code: 'sql_deadline_exceeded', descriptor: 'sql:semantic-mirror-source' }],
      proofs: [
        {
          descriptor: 'sql:semantic-mirror-source:returned',
          querySha256: 'a'.repeat(64),
          planSha256: 'b'.repeat(64),
          indexes: ['webhook_events_pkey'],
          returnedRows: 1,
          examinedRows: 0,
          probes: 1,
        },
      ],
    };
    mockSql.mockImplementation(async () => {
      clock.mockReturnValue(now + LEGACY_RECOVERY_LIVE_BUDGET.durationMs);
      return sql;
    });
    const result = await collectLegacyRecoveryAdmission(
      tx,
      { eval_ro: jest.fn().mockResolvedValue(headerReply()) },
      request(),
    );
    expect(result).toMatchObject({
      decision: 'DENY',
      sourceCoverageComplete: false,
      stoppingAuthorized: false,
      activationAuthorized: false,
      selectedOwners: sql.selectedOwners,
      sqlPlans: sql.proofs,
      cost: {
        pages: 13,
        rows: 30,
        probes: 50 + LEGACY_RECOVERY_LIVE_QUEUE_NAMES.length * 8,
        bytes: 2048 + Buffer.byteLength(String(headerReply()[2])),
      },
    });
    expect(result.issues).toEqual([
      ...sql.issues,
      storeRefusedIssue,
      { code: 'online_admission_deadline_exceeded', descriptor: 'sql:accounting' },
    ]);
  });

  it.each(['redis', 'sql'] as const)('never emits secret-bearing %s errors', async (store) => {
    const error = new Error('redis://fixture:DO_NOT_EXPOSE@offline.invalid/0 source_text_secret');
    const redis = { eval_ro: jest.fn().mockResolvedValue(headerReply()) };
    if (store === 'redis') redis.eval_ro.mockRejectedValue(error);
    else mockSql.mockRejectedValue(error);
    const result = await collectLegacyRecoveryAdmission(tx, redis, request());
    expect(result.issues).toContainEqual(storeRefusedIssue);
    expect(result.issues).toContainEqual({
      code: 'online_admission_store_query_failed',
      descriptor: store === 'redis' ? 'redis:counts' : 'sql:inventory',
    });
    expect(JSON.stringify(result)).not.toContain('DO_NOT_EXPOSE');
    expect(JSON.stringify(result)).not.toContain('source_text_secret');
    expect(result).toMatchObject({
      applied: false,
      stoppingAuthorized: false,
      activationAuthorized: false,
    });
  });

  it('rejects malformed direct requests before probing live stores', async () => {
    const redis = { eval_ro: jest.fn() };
    await expect(
      collectLegacyRecoveryAdmission(tx, redis, {
        ...request(),
        binding: { stoppedGenerations: [] },
      } as ReturnType<typeof request>),
    ).rejects.toThrow('Unknown admission field');
    expect(redis.eval_ro).not.toHaveBeenCalled();
    expect(mockSql).not.toHaveBeenCalled();
  });
});
