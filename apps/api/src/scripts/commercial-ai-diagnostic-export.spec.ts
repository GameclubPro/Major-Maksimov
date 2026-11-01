import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commercialAiQualityAttemptSchema,
  commercialAiQualityEnvelopeSchema,
} from '@maxim/contracts/commercial-ai-quality';
import { commercialReviewEvidenceMetadataSchema } from '@maxim/contracts/safety-desk';
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
  collectAiDiagnosticEvidence,
  commercialAiDiagnosticOptionsSchema,
  mapAiDiagnosticRow,
  verifyAiOwnReceipt,
  type AiDiagnosticDependencies,
  type AiDiagnosticRow,
  type AiOwnReceiptRow,
} from './commercial-ai-diagnostic-export';
import {
  assertAiDiagnosticAdminRole,
  createAiDiagnosticDirectory,
  findAiDiagnosticWorkspace,
  readAiDiagnosticArguments,
  runAiDiagnosticCollector,
  writeAiDiagnosticCollection,
  writeAiDiagnosticPlans,
} from './collect-commercial-ai-diagnostics';

const since = '2026-11-01T10:00:00.000Z';
const until = '2026-11-01T11:00:00.000Z';
const now = Date.parse(until) + 1000;
const options = commercialAiDiagnosticOptionsSchema.parse({ since, until, pageSize: 2 });
const text = 'ASCII / Кириллица / 🚀 / Cafe\u0301';
function fixture(id = 'sample-one') {
  const eventAtMs = Date.parse(since) + 1000;
  const source = commercialLlmSourceSchema.parse({
    version: 2,
    poolPolicy: 'confirm-positive',
    classifierSha256: commercialLlmPoolEnforcementIdentity('confirm-positive'),
    origin: {
      sourceWebhookEventId: 'private-webhook',
      sourceReceivingBotId: 'private-bot',
      sourceExecutionBotId: 'private-bot',
      sourceEventAtMs: eventAtMs,
      sourceEvidenceVersion: 1,
    },
    nonce: '00000000-0000-4000-8000-000000000001',
    chatId: 'private-chat',
    messageId: 'private-message',
    userId: 'private-user',
    originBotId: 'private-bot',
    eventAtMs,
    deadlineAtMs: eventAtMs + 60_000,
    sourceSha256: digest('raw'),
    settingsSha256: digest('settings'),
  });
  const metadata = commercialReviewEvidenceMetadataSchema.parse({
    schemaVersion: 2,
    samplingProbability: 0.1,
    randomEvaluationIncluded: true,
    evaluationSamplingProbability: 0.1,
    samplingStratum: 'NO_HIT',
    logicalMessageKey: digest('logical'),
    authorGroupId: digest('author'),
    campaignGroupId: digest('campaign'),
    campaignGroupIds: [],
    campaignGroupingComplete: true,
    sourceSnapshotSha256: digest('snapshot'),
    pseudonymizationKeyId: digest('key'),
    imageReviewRequired: false,
    sourceExcerptComplete: true,
    messageCreatedAt: new Date(eventAtMs).toISOString(),
    settingsProfileDigest: digest('profile'),
    detectorSourceSha256: digest('detector'),
    hasDetection: false,
    decisionOutcome: null,
    deleteEligible: null,
    executionOutcome: 'UNKNOWN',
    analysisOutcome: 'NOT_APPLICABLE',
    candidateDecision: null,
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
    inputSha256: aiDiagnosticInputSha256(text),
    nonce: source.nonce,
    sourceVersion: source.version,
    sourceSha256: source.sourceSha256,
    settingsSha256: source.settingsSha256,
    settingsProfileDigest: metadata.settingsProfileDigest,
    classifierIdentitySha256: source.classifierSha256,
    submittedAtMs: eventAtMs,
    eventAtMs,
    deadlineAtMs: source.deadlineAtMs,
    activeAuthority: 'AI_DELETE_ONLY',
    actualSynchronousDecision: { semantics: 'actual_post_routing_v1', decision },
    detectorBaseline: {
      semantics: 'counterfactual_pre_routing_v1',
      detectorSourceSha256: metadata.detectorSourceSha256,
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
      intentIdSha256: aiDiagnosticInputSha256('private-intent'),
      reason: null,
    },
    execution: {
      state: 'PENDING',
      receiptSha256: null,
      observedAt: new Date(eventAtMs + 21).toISOString(),
    },
  });
  const envelope = commercialAiQualityEnvelopeSchema.parse({
    schemaVersion: 1,
    captureState: 'OBSERVED',
    source: {
      source: 'TEXT',
      evidenceHash: digest('evidence'),
      logicalMessageKey: metadata.logicalMessageKey,
      sourceSnapshotSha256: metadata.sourceSnapshotSha256,
      excerptSha256: attempt.inputSha256,
      messageCreatedAt: metadata.messageCreatedAt,
      sourceExcerptComplete: true,
    },
    attempts: [attempt],
    overflowWriteCount: 0,
    lastOverflowAt: null,
    coverageIncomplete: false,
  });
  const row: AiDiagnosticRow = {
    id,
    observedAt: new Date(eventAtMs),
    updatedAt: new Date(eventAtMs + 21),
    expiresAt: new Date(now + 86_400_000),
    chatId: source.chatId,
    messageId: source.messageId,
    source: 'TEXT',
    evidenceHash: envelope.source.evidenceHash,
    excerpt: text,
    qualityMetadata: metadata,
    llmEnforcement: envelope,
    observationPresent: true,
    payloadOversized: false,
  };
  const request = {
    captureKey: digest(id),
    chatId: row.chatId,
    messageId: row.messageId,
    evidenceHash: row.evidenceHash,
    attempt,
  };
  const receipt: AiOwnReceiptRow = {
    captureKey: request.captureKey,
    sourceKey: attempt.sourceKey,
    intentId: 'private-intent',
    reasonKey: `COMMERCIAL_LLM_DELETE:${attempt.sourceKey}`,
    ruleCode: 'COMMERCIAL_LLM_DELETE',
    remoteDeleteSucceededAt: new Date(eventAtMs + 30),
    remoteDeleteSucceededBotId: 'private-delete-bot',
    source,
    observation: { evidenceHash: row.evidenceHash, inputSha256: attempt.inputSha256 },
    moderationDeleteVerified: true,
  };
  return { row, source, metadata, envelope, attempt, request, receipt };
}
function harness(pages: AiDiagnosticRow[][]) {
  const emitted: Record<string, unknown[]> = { sources: [], linkage: [], receipts: [] };
  const dependencies: AiDiagnosticDependencies = {
    loadPage: jest.fn(async () => pages.shift() ?? []),
    loadOwnReceipts: jest.fn(async () => []),
    append: async (kind, value) => {
      emitted[kind]!.push(value);
    },
    progress: jest.fn(async () => undefined),
    assertHeld: jest.fn(),
    now: () => now,
    reviewId: () => '00000000-0000-4000-8000-000000000002',
  };
  return { dependencies, emitted };
}

describe('private commercial AI diagnostics', () => {
  it('exports exact UTF-8 source bytes separately from observations and human review', () => {
    const { row } = fixture();
    const mapped = mapAiDiagnosticRow(row, now);
    expect(mapped.text).toBe(text);
    expect(mapped.link.inputBinding).toBe('EXACT');
    expect(mapped.capture.diagnosticResult).toBeNull();
    expect(mapped.capture).not.toHaveProperty('ownReview');
    const changed = { ...row, excerpt: text.normalize('NFC') };
    expect(mapAiDiagnosticRow(changed, now).link.omission).toBe('INPUT_HASH_MISMATCH');
    expect(mapAiDiagnosticRow(changed, now).text).toBeNull();
  });

  it('keeps privacy, incomplete, expired, malformed and pre-offer gaps explicit', () => {
    const { row } = fixture();
    expect(mapAiDiagnosticRow({ ...row, excerpt: 'Телефон 89000001042' }, now).link.omission).toBe(
      'PRIVACY_WITHHELD',
    );
    expect(
      mapAiDiagnosticRow(
        { ...row, qualityMetadata: { ...fixture().metadata, sourceExcerptComplete: false } },
        now,
      ).link.omission,
    ).toBe('SOURCE_INCOMPLETE');
    const expired = mapAiDiagnosticRow({ ...row, expiresAt: new Date(now) }, now);
    expect(expired.link.omission).toBe('EXPIRED');
    expect(expired.text).toBeNull();
    expect(expired.capture.llmEnforcement).toBeNull();
    expect(expired.capture.metadata).toBeNull();
    expect(
      mapAiDiagnosticRow({ ...row, llmEnforcement: { privateError: 'private-raw' } }, now).capture
        .llmEnforcement?.captureState,
    ).toBe('INVALID');
    const preOffer = mapAiDiagnosticRow(
      { ...row, llmEnforcement: null, observationPresent: false },
      now,
    );
    expect(preOffer.capture.llmEnforcement).toBeNull();
    expect(preOffer.link.inputBinding).toBe('NO_OBSERVED_INPUT');
    const unsafeMetadata = mapAiDiagnosticRow(
      { ...row, qualityMetadata: { ...fixture().metadata, authorGroupId: 'private-author-name' } },
      now,
    );
    expect(unsafeMetadata.link.omission).toBe('METADATA_UNAVAILABLE');
    expect(unsafeMetadata.capture.metadata).toBeNull();
  });

  it('advances the last scanned cursor across a whole empty filtered page', async () => {
    const first = fixture('sample-a').row;
    const second = { ...fixture('sample-b').row, source: 'OCR' };
    const third = {
      ...fixture('sample-c').row,
      observedAt: new Date(first.observedAt.getTime() + 1),
    };
    const { dependencies, emitted } = harness([[{ ...first, source: 'OCR' }, second], [third]]);
    const result = await collectAiDiagnosticEvidence(options, dependencies);
    expect(result.manifest.scannedRows).toBe(3);
    expect(result.manifest.capturedRows).toBe(3);
    expect(result.manifest.omissions.UNSUPPORTED_SOURCE).toBe(2);
    expect(emitted.sources).toHaveLength(1);
    expect((dependencies.loadPage as jest.Mock).mock.calls[1]![0].cursor).toEqual({
      observedAt: second.observedAt.toISOString(),
      id: 'sample-b',
    });
    expect(result.evidence.mode).toBe('CAPTURE_DIAGNOSTIC');
    expect(result.evidence.manifest).toBeNull();
    expect(result.evidence.holdout).toEqual([]);
  });

  it('retains raw capture duplicates while sharing only an exact blind source revision', async () => {
    const first = fixture('sample-a').row,
      second = fixture('sample-b').row;
    const { dependencies, emitted } = harness([[first, second], []]);
    const result = await collectAiDiagnosticEvidence(options, dependencies);
    expect(result.manifest.capturedRows).toBe(2);
    expect(result.manifest.uniqueLogicalSources).toBe(1);
    expect(result.manifest.duplicateBindingRows).toBe(1);
    expect(emitted.sources).toHaveLength(1);
    expect(JSON.stringify(emitted.sources)).not.toMatch(
      /private-chat|private-message|COMMERCIAL|classification|observedAt|sourceSnapshot/u,
    );
  });

  it('records every scanned row when a byte cap stops output partway through a page', async () => {
    const { dependencies } = harness([[fixture('sample-a').row, fixture('sample-b').row]]);
    const result = await collectAiDiagnosticEvidence({ ...options, maxBytes: 1024 }, dependencies);
    expect(result.manifest.stop).toBe('BYTE_CAP');
    expect(result.manifest.scannedRows).toBe(2);
    expect(result.manifest.unexportedScannedRows).toBe(2);
    expect(result.manifest.nextCursor?.id).toBe('sample-b');
  });

  it('stops at its finite deadline and rejects cursors that do not advance', async () => {
    const { dependencies } = harness([[fixture().row], [fixture().row]]);
    let calls = 0;
    dependencies.now = () => (calls++ === 0 ? now : now + 120_000);
    expect((await collectAiDiagnosticEvidence(options, dependencies)).manifest.stop).toBe(
      'DEADLINE',
    );
    const invalid = harness([[fixture('sample-b').row, fixture('sample-a').row]]);
    await expect(collectAiDiagnosticEvidence(options, invalid.dependencies)).rejects.toThrow(
      'cursor',
    );
  });

  it('rejects a future window before querying and keeps an empty closed cohort empty', async () => {
    const future = harness([]);
    await expect(
      collectAiDiagnosticEvidence(
        { ...options, until: new Date(now + 1000).toISOString() },
        future.dependencies,
      ),
    ).rejects.toThrow('closed');
    expect(future.dependencies.loadPage).not.toHaveBeenCalled();
    expect(future.dependencies.progress).not.toHaveBeenCalled();
    const result = await collectAiDiagnosticEvidence(options, harness([]).dependencies);
    expect(result.manifest.capturedRows).toBe(0);
    expect(result.manifest.independentHumanEvidence).toBe(false);
    expect(result.evidence.captures).toEqual([]);
  });

  it('accepts only an exact own verified database receipt, never another rule or source', () => {
    const { request, receipt } = fixture();
    expect(verifyAiOwnReceipt(request, receipt)?.state).toBe('CONFIRMED_DELETE');
    for (const changed of [
      { ...receipt, moderationDeleteVerified: false },
      { ...receipt, ruleCode: 'MESSAGE_LENGTH' },
      {
        ...receipt,
        observation: { evidenceHash: request.evidenceHash, inputSha256: digest('wrong-input') },
      },
      {
        ...receipt,
        source: { ...fixture().source, nonce: '00000000-0000-4000-8000-000000000003' },
      },
      { ...receipt, remoteDeleteSucceededBotId: null },
      { ...receipt, intentId: 'another-intent' },
    ])
      expect(verifyAiOwnReceipt(request, changed)).toBeNull();
  });

  it('counts one physical deletion across distinct own reason proofs', async () => {
    const first = fixture('sample-a'),
      second = fixture('sample-b');
    const source = { ...second.source, nonce: '00000000-0000-4000-8000-000000000003' };
    const attempt = {
      ...second.attempt,
      nonce: source.nonce,
      sourceKey: commercialLlmSourceKey(source),
    };
    const secondRow = {
      ...second.row,
      llmEnforcement: { ...second.envelope, attempts: [attempt] },
    };
    const { dependencies } = harness([[first.row, secondRow], []]);
    dependencies.loadOwnReceipts = async (requests) =>
      requests.map((request) => ({
        ...first.receipt,
        captureKey: request.captureKey,
        sourceKey: request.attempt.sourceKey,
        reasonKey: `COMMERCIAL_LLM_DELETE:${request.attempt.sourceKey}`,
        source: request.attempt.nonce === source.nonce ? source : first.source,
      }));
    const result = await collectAiDiagnosticEvidence(options, dependencies);
    expect(result.manifest.ownReceiptReasonProofs).toBe(2);
    expect(result.manifest.ownReceiptsVerified).toBe(1);
  });

  it('accepts the actual Compose admin identity and refuses worker or mismatched identities', () => {
    expect(() =>
      assertAiDiagnosticAdminRole({ APP_ROLE: 'admin', APP_SERVICE_NAME: 'api-admin' }),
    ).not.toThrow();
    expect(() => assertAiDiagnosticAdminRole({})).not.toThrow();
    for (const env of [
      { APP_ROLE: 'moderation', APP_SERVICE_NAME: 'api-moderation' },
      { APP_ROLE: 'publisher', APP_SERVICE_NAME: 'api-publisher' },
      { APP_ROLE: 'admin', APP_SERVICE_NAME: 'api-moderation' },
      { APP_ROLE: 'api-admin', APP_SERVICE_NAME: 'api-admin' },
      { APP_ROLE: 'admin' },
    ])
      expect(() => assertAiDiagnosticAdminRole(env)).toThrow();
  });

  it('bounds windows, integers and raw query shape before JSON filtering', () => {
    expect(() =>
      readAiDiagnosticArguments([
        '--since',
        since,
        '--until',
        until,
        '--output-dir',
        '/private',
        '--page-size',
        '1e2',
      ]),
    ).toThrow();
    expect(() =>
      commercialAiDiagnosticOptionsSchema.parse({ since, until: '2026-12-01T00:00:00.000Z' }),
    ).toThrow();
    const sql = buildAiDiagnosticPageSql({ ...options, cursor: null }).text;
    expect(sql).toContain('WITH scan_page AS MATERIALIZED');
    expect(sql.indexOf('LIMIT')).toBeLessThan(sql.indexOf("evidence ->> 'excerpt'"));
    expect(sql).not.toMatch(/ratings|ORDER BY score|WHERE.*llm_enforcement/iu);
  });

  it('offers only plain plans for the exact helpers with synthetic receipt keys', () => {
    const args = readAiDiagnosticArguments([
      '--since',
      since,
      '--until',
      until,
      '--output-dir',
      '/private/new-plan',
      '--explain',
    ]);
    expect(args.explain).toBe(true);
    const plans = buildAiDiagnosticExplainSql(options);
    expect(plans).toHaveLength(2);
    expect(plans[0]!.sql.text).toBe(
      `EXPLAIN (FORMAT JSON) ${buildAiDiagnosticPageSql({ ...options, cursor: null }).text}`,
    );
    for (const { sql } of plans) {
      expect(sql.text).toMatch(/^EXPLAIN \(FORMAT JSON\) WITH /u);
      expect(sql.text).not.toMatch(/\bANALYZE\b/u);
      expect(sql.values).not.toContain('private-chat');
      expect(sql.values).not.toContain('private-message');
    }
    expect(plans[1]!.sql.values).toContain('DIAGNOSTIC_PLAN_CHAT');
    expect(plans[1]!.sql.values).toContain('DIAGNOSTIC_PLAN_MESSAGE');
  });
});

describe('private diagnostic files', () => {
  let folder: string, repositoryRoot: string;
  beforeEach(async () => {
    // FLAG: TMPDIR and /tmp can be inside Git; Linux private fixtures use /var/tmp.
    folder = await realpath(
      await mkdtemp(join(process.platform === 'linux' ? '/var/tmp' : tmpdir(), 'ai-diagnostic-')),
    );
    repositoryRoot = join(folder, 'repository');
    await mkdir(repositoryRoot);
  });
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  it('writes private plain plans without executing source readers or creating source packs', async () => {
    const { dependencies } = harness([[fixture().row]]);
    const explain = jest.fn(async (sql: ReturnType<typeof buildAiDiagnosticPageSql>) => {
      expect(sql.text).not.toMatch(/\bANALYZE\b/u);
      return [{ 'QUERY PLAN': [{ Plan: { 'Node Type': 'Index Scan' } }] }];
    });
    const outputDir = join(folder, 'plans');
    const result = await writeAiDiagnosticPlans({
      options,
      outputDir,
      repositoryRoot,
      ...dependencies,
      explain,
    });
    expect(result.sourceRowsRead).toBe(0);
    expect(result.actualSourceIdentifiersUsed).toBe(false);
    expect(dependencies.loadPage).not.toHaveBeenCalled();
    expect(dependencies.loadOwnReceipts).not.toHaveBeenCalled();
    expect(explain).toHaveBeenCalledTimes(2);
    for (const [sql] of explain.mock.calls) expect(sql.text).toMatch(/^EXPLAIN \(FORMAT JSON\) /u);
    expect((await readdir(outputDir)).sort()).toEqual([
      'query-plans.private.json',
      'run-state.json',
    ]);
    expect((await stat(outputDir)).mode & 0o777).toBe(0o700);
    for (const name of await readdir(outputDir))
      expect((await stat(join(outputDir, name))).mode & 0o777).toBe(0o600);
  });

  it('refuses future or oversized plan output without publishing a plan', async () => {
    const { dependencies } = harness([]);
    const explain = jest.fn(async () => 'x'.repeat(2048));
    const outputDir = join(folder, 'plans-future');
    await expect(
      writeAiDiagnosticPlans({
        options: { ...options, until: new Date(now + 1000).toISOString() },
        outputDir,
        repositoryRoot,
        ...dependencies,
        explain,
      }),
    ).rejects.toThrow('closed');
    expect(explain).not.toHaveBeenCalled();
    expect(await readdir(folder)).toEqual(['repository']);
    const capped = join(folder, 'plans-capped');
    await expect(
      writeAiDiagnosticPlans({
        options: { ...options, maxBytes: 1024 },
        outputDir: capped,
        repositoryRoot,
        ...dependencies,
        explain,
      }),
    ).rejects.toThrow('plan collection failed');
    expect(await readdir(capped)).toEqual(['run-state.json']);
  });

  it('publishes private files with hashes, no human labels and honest unbound reporter effects', async () => {
    const fixtureValue = fixture();
    const escapedText = `${'"\n\t'.repeat(250)}end`;
    const inputSha256 = aiDiagnosticInputSha256(escapedText);
    const row = {
      ...fixtureValue.row,
      excerpt: escapedText,
      llmEnforcement: {
        ...fixtureValue.envelope,
        source: { ...fixtureValue.envelope.source, excerptSha256: inputSha256 },
        attempts: [{ ...fixtureValue.attempt, inputSha256 }],
      },
    };
    const { dependencies } = harness([[row]]);
    const outputDir = join(folder, 'run');
    const manifest = await writeAiDiagnosticCollection({
      options,
      outputDir,
      repositoryRoot,
      ...dependencies,
    });
    expect((await stat(outputDir)).mode & 0o777).toBe(0o700);
    for (const name of await readdir(outputDir))
      expect((await stat(join(outputDir, name))).mode & 0o777).toBe(0o600);
    const report = JSON.parse(await readFile(join(outputDir, 'report.private.json'), 'utf8'));
    expect(report.evidenceSufficient).toBe(false);
    expect(report.promotionAuthorized).toBe(false);
    expect(report.effects.confirmedDelete).toBe(0);
    expect(report.coverage.independentlyReviewedHoldoutRows).toBe(0);
    const raw = await readFile(join(outputDir, 'blind-sources.jsonl'), 'utf8');
    expect(manifest.files['blind-sources.jsonl']?.bytes).toBe(Buffer.byteLength(raw));
    expect(Object.keys(JSON.parse(raw))).toEqual(['reviewId', 'text']);
    expect(JSON.parse(raw).text).toBe(escapedText);
    const totalBytes = (
      await Promise.all(
        (await readdir(outputDir)).map(async (name) => (await stat(join(outputDir, name))).size),
      )
    ).reduce((sum, value) => sum + value, 0);
    expect(manifest.bytes).toBe(totalBytes);
    expect(totalBytes).toBeLessThanOrEqual(options.maxBytes);
    await expect(createAiDiagnosticDirectory(outputDir, repositoryRoot)).rejects.toThrow();
  });

  it('publishes no source or prediction packs after a collector error', async () => {
    const { dependencies } = harness([[fixture('sample-b').row, fixture('sample-a').row]]);
    const outputDir = join(folder, 'failed');
    await expect(
      writeAiDiagnosticCollection({ options, outputDir, repositoryRoot, ...dependencies }),
    ).rejects.toThrow('not published');
    expect(await readdir(outputDir)).toEqual(['run-state.json']);
    expect(JSON.parse(await readFile(join(outputDir, 'run-state.json'), 'utf8')).status).toBe(
      'FAILED',
    );
  });

  it('fails closed when escaped output and final artifact overhead exceed the exact byte budget', async () => {
    const { dependencies } = harness([[fixture().row]]);
    const outputDir = join(folder, 'capped');
    await expect(
      writeAiDiagnosticCollection({
        options: { ...options, maxBytes: 1024 },
        outputDir,
        repositoryRoot,
        ...dependencies,
      }),
    ).rejects.toThrow('not published');
    expect(await readdir(outputDir)).toEqual(['run-state.json']);
  });

  it('creates no output for a future window', async () => {
    const { dependencies } = harness([]);
    const outputDir = join(folder, 'future');
    await expect(
      writeAiDiagnosticCollection({
        options: { ...options, until: new Date(now + 1000).toISOString() },
        outputDir,
        repositoryRoot,
        ...dependencies,
      }),
    ).rejects.toThrow('closed');
    expect(await readdir(folder)).toEqual(['repository']);
    expect(dependencies.loadPage).not.toHaveBeenCalled();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await expect(
        runAiDiagnosticCollector([
          '--since',
          since,
          '--until',
          new Date(now + 1000).toISOString(),
          '--output-dir',
          outputDir,
        ]),
      ).rejects.toThrow('closed');
      expect(await readdir(folder)).toEqual(['repository']);
    } finally {
      clock.mockRestore();
    }
  });

  it('resolves both source and actual Docker runtime layouts using real package markers', async () => {
    for (const layout of ['apps/api/src/scripts', 'apps/api/dist/apps/api/src/scripts']) {
      const moduleDirectory = join(repositoryRoot, layout);
      await mkdir(moduleDirectory, { recursive: true });
      await mkdir(join(repositoryRoot, 'packages/contracts'), { recursive: true });
      await writeFile(
        join(repositoryRoot, 'apps/api/package.json'),
        JSON.stringify({ name: '@maxim/api' }),
      );
      await writeFile(
        join(repositoryRoot, 'packages/contracts/package.json'),
        JSON.stringify({ name: '@maxim/contracts' }),
      );
      expect(await findAiDiagnosticWorkspace(moduleDirectory)).toBe(repositoryRoot);
    }
    await writeFile(
      join(repositoryRoot, 'packages/contracts/package.json'),
      JSON.stringify({ name: 'wrong' }),
    );
    await expect(
      findAiDiagnosticWorkspace(join(repositoryRoot, 'apps/api/src/scripts')),
    ).rejects.toThrow('identity');
  });

  it('refuses workspace, another Git tree and symlinked workspace destinations', async () => {
    await expect(
      createAiDiagnosticDirectory(join(repositoryRoot, 'run'), repositoryRoot),
    ).rejects.toThrow();
    const other = join(folder, 'another-git');
    await mkdir(other);
    await mkdir(join(other, '.git'));
    await expect(createAiDiagnosticDirectory(join(other, 'run'), repositoryRoot)).rejects.toThrow();
    const link = join(folder, 'linked');
    await symlink(repositoryRoot, link);
    await expect(createAiDiagnosticDirectory(join(link, 'run'), repositoryRoot)).rejects.toThrow();
  });
});
