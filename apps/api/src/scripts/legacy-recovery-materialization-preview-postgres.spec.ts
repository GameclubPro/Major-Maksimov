import { randomUUID } from 'node:crypto';
import {
  createPrismaClient,
  type PrismaClient,
  type Prisma,
  type WebhookEvent,
} from '../prisma/prisma-client';
import { WebhookParser } from '../webhook/webhook.parser';
import { buildWebhookSemanticEventKey } from '../webhook/webhook-semantic-event-key';
import {
  inspectLegacyRecoveryCandidate,
  createLegacyColdCertificate,
  installAndSealLegacyRecoveryBatch,
  materializeLegacyHeldReceiptPage,
  readLegacyRecoveryInstallation,
  buildLegacyRecoveryPreviewDigest,
  legacySnapshotDigest,
  type LegacyRecoveryCandidate,
} from '../webhook/webhook-legacy-cold-install';
import { RUNTIME_SERVICE_NAMES } from '../runtime/runtime-topology';
import { previewLegacyRecoveryMaterialization } from './legacy-recovery-materialization-preview';
const url = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const native = url ? describe : describe.skip;
const allowance = () => ({
  pages: 512,
  rows: 50_000,
  probes: 512,
  bytes: 8 * 1024 * 1024,
  deadlineAtMs: Date.now() + 25_000,
});
native('read-only materialization preview on representative PostgreSQL history', () => {
  jest.setTimeout(40_000);
  let db: PrismaClient, reader: PrismaClient, candidate: LegacyRecoveryCandidate, chatId: string;
  const noise = `materialization-noise-${randomUUID()}`,
    receipts: string[] = [],
    certificates: string[] = [];
  const oldOffline = process.env.MAXIM_LEGACY_RECOVERY_OFFLINE;
  beforeAll(async () => {
    const parsed = new URL(url);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
      !parsed.pathname.includes('race_test')
    )
      throw new Error('Disposable local database required');
    db = createPrismaClient(url, { max: 1, statement_timeout: 5000, options: '-c timezone=UTC' });
    reader = createPrismaClient(url, {
      max: 1,
      statement_timeout: 5000,
      options: '-c timezone=UTC -c default_transaction_read_only=on',
    });
    process.env.MAXIM_LEGACY_RECOVERY_OFFLINE = '1';
    for (let page = 0; page < 10; page++) {
      await db.webhookEvent.createMany({
        data: Array.from({ length: 500 }, (_, index) => ({
          id: `${noise}-${page}-${index}`,
          dedupKey: `${noise}-${page}-${index}`,
          status: 'PROCESSED' as const,
          rawPayload: {},
          normalizedPayload: {},
          createdAt: new Date('2020-01-01T00:00:00Z'),
        })),
      });
      await db.webhookExecutionClaim.createMany({
        data: Array.from({ length: 500 }, (_, index) => ({
          id: `${noise}-${page}-${index}`,
          kind: index % 2 ? 'COMMAND' : 'EXECUTION',
          semanticKey: `${noise}-${page}-${index}`,
          status: 'COMPLETED' as const,
        })),
      });
    }
    await db.chat.createMany({
      data: Array.from({ length: 500 }, (_, index) => ({
        id: `${noise}-chat-${index}`,
        title: 'Noise',
      })),
    });
    await db.chatSettings.createMany({
      data: Array.from({ length: 500 }, (_, index) => ({ chatId: `${noise}-chat-${index}` })),
    });
    await db.$executeRawUnsafe('ANALYZE webhook_events');
    await db.$executeRawUnsafe('ANALYZE webhook_execution_claims');
    await db.$executeRawUnsafe('ANALYZE chat_settings');
  });
  beforeEach(async () => {
    chatId = `-preview-${randomUUID()}`;
    await db.chat.create({ data: { id: chatId, title: 'Preview', settings: { create: {} } } });
    const cutoff = (
      await db.$queryRaw<
        Array<{ at: Date }>
      >`SELECT finished_at AS at FROM _prisma_migrations WHERE migration_name = '20261005020000_add_multibot_order_fences' AND finished_at IS NOT NULL AND rolled_back_at IS NULL`
    )[0]!.at;
    const event = await receipt('Old ordinary source', 'held-user', cutoff.getTime() - 5000, {
      status: 'FAILED',
      errorMessage:
        'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required',
    });
    await db.webhookExecutionClaim.create({
      data: {
        kind: 'EXECUTION',
        semanticKey: event.semanticKey!,
        webhookEventId: event.id,
        enforced: false,
        createdAt: event.createdAt,
      },
    });
    candidate = (await inspectLegacyRecoveryCandidate(db, event.id, ['major']))!;
    expect(candidate).toBeTruthy();
  });
  afterEach(async () => {
    await db.webhookExecutionClaim.deleteMany({ where: { webhookEventId: { in: receipts } } });
    await db.webhookEvent.deleteMany({ where: { id: { in: receipts.splice(0) } } });
    for (const certificateId of certificates.splice(0)) {
      const authority = await db.webhookLegacySealedAuthority.findUnique({
        where: { certificateId },
      });
      if (authority) {
        // FLAG: Fixture cleanup triggers a retained-webhook FK check for each disposition.
        // Bound each local deletion without relaxing the production-query timeout under test.
        for (let page = 0; page < 32; page++) {
          const batch = await db.webhookLegacyReceiptDisposition.findMany({
            where: { authorityId: authority.id },
            select: { id: true },
            take: 100,
          });
          if (!batch.length) break;
          await db.webhookLegacyReceiptDisposition.deleteMany({
            where: { id: { in: batch.map((row) => row.id) } },
          });
          if (page === 31) throw new Error('Fixture disposition cleanup exceeded its page bound');
        }
      }
      await db.webhookLegacyMaterializationCursor.deleteMany({ where: { certificateId } });
      await db.webhookLegacyRecovery.deleteMany({ where: { certificateId } });
      await db.webhookLegacySealedAuthority.deleteMany({ where: { certificateId } });
      await db.webhookLegacyQuiescenceCertificate.delete({ where: { id: certificateId } });
    }
    await db.chatSettings.deleteMany({ where: { chatId } });
    await db.chat.deleteMany({ where: { id: chatId } });
    await db.nightModeTransitionReconcileRequest.deleteMany({ where: { chatId } });
  });
  afterAll(async () => {
    await db.webhookExecutionClaim.deleteMany({ where: { id: { startsWith: noise } } });
    await db.webhookEvent.deleteMany({ where: { id: { startsWith: noise } } });
    await db.chatSettings.deleteMany({ where: { chatId: { startsWith: noise } } });
    await db.chat.deleteMany({ where: { id: { startsWith: noise } } });
    await db.nightModeTransitionReconcileRequest.deleteMany({
      where: { chatId: { startsWith: noise } },
    });
    await reader.$disconnect();
    await db.$disconnect();
    if (oldOffline === undefined) delete process.env.MAXIM_LEGACY_RECOVERY_OFFLINE;
    else process.env.MAXIM_LEGACY_RECOVERY_OFFLINE = oldOffline;
  });
  async function receipt(
    text = 'Ordinary',
    userId = 'held-user',
    at = Date.now() - 1000,
    change: Partial<WebhookEvent> = {},
    forward = false,
  ) {
    const id = randomUUID();
    const raw = {
      update_type: 'message_created',
      update_id: id,
      timestamp: at,
      message: {
        sender: { user_id: userId, is_bot: false },
        recipient: { chat_id: chatId, chat_type: 'chat' },
        timestamp: at,
        body: { mid: id, text: forward ? '' : text },
        ...(forward
          ? {
              link: {
                type: 'forward',
                chat_id: '-foreign-chat',
                sender: { user_id: 'foreign-author', is_bot: false },
                message: {
                  mid: 'foreign-image',
                  text,
                  attachments: [
                    { type: 'image', payload: { photo_id: 42, url: 'https://i.oneme.ru/fixture' } },
                  ],
                },
              },
            }
          : {}),
      },
    };
    const normalized = new WebhookParser().parse(raw, { botId: 'major' });
    receipts.push(id);
    return db.webhookEvent.create({
      data: {
        id,
        botId: 'major',
        dedupKey: `major:${id}`,
        semanticKey: buildWebhookSemanticEventKey(normalized),
        rawPayload: raw,
        normalizedPayload: JSON.parse(JSON.stringify(normalized)),
        createdAt: new Date(at + 1),
        ...change,
      } as never,
    });
  }
  async function preview(overrides: Partial<ReturnType<typeof allowance>> = {}) {
    // FLAG: Each case owns its data distribution. The 800-row case and prior
    // suites delete their fixtures; inherited or autoanalyze statistics are not proof.
    await db.$executeRawUnsafe('ANALYZE webhook_events');
    await db.$executeRawUnsafe('ANALYZE webhook_execution_claims');
    await db.$executeRawUnsafe('ANALYZE chat_settings');
    const result = await reader.$transaction(
      (tx) =>
        previewLegacyRecoveryMaterialization(tx, [candidate], { ...allowance(), ...overrides }),
      { isolationLevel: 'RepeatableRead', timeout: 30_000 },
    );
    expect(result.planFailure).toBeUndefined();
    return result;
  }
  async function actualPage() {
    const sourceSha = 'a'.repeat(40),
      imageId = `sha256:${'b'.repeat(64)}`;
    const cert = await createLegacyColdCertificate(db, {
      version: 1,
      sourceSha,
      imageId,
      transitionJournalSha256: 'c'.repeat(64),
      previewSha256: buildLegacyRecoveryPreviewDigest([candidate], []),
      queueFenceNonce: 'disposable-preview-test',
      roleSnapshots: RUNTIME_SERVICE_NAMES.filter((name) => name !== 'api-all').map(
        (serviceName) => ({
          serviceName,
          containerId: legacySnapshotDigest(serviceName),
          sourceSha,
          imageId,
          stopped: true,
        }),
      ),
    });
    certificates.push(cert.id);
    await installAndSealLegacyRecoveryBatch(db, cert.id, [candidate], []);
    return materializeLegacyHeldReceiptPage(db, cert.id, chatId);
  }
  it.each([false, true])(
    'matches preview and actual installation for an ordinary held prefix (forward=%s)',
    async (forward) => {
      const event = await receipt(
        'Ordinary\n forwarded caption',
        'held-user',
        Date.now() - 1000,
        {},
        forward,
      );
      const result = await preview();
      expect(result.issues).toEqual([]);
      expect(result.decision).toBe('READY');
      expect(result.activationAuthorized).toBe(false);
      expect(
        (await db.webhookEvent.findUniqueOrThrow({ where: { id: event.id } })).legacyDispositionId,
      ).toBeNull();
      expect(
        await db.webhookLegacyReceiptDisposition.count({ where: { receiptId: { in: receipts } } }),
      ).toBe(0);
      expect(await actualPage()).toMatchObject({ blocked: false, complete: true, applied: 1 });
    },
  );
  it.each(
    ['тишина 12', '/ban', 'Старт'].flatMap((text) =>
      [false, true].map((forward) => ({ text, forward })),
    ),
  )(
    'refuses pre-seal command $text before any writer (forward=$forward)',
    async ({ text, forward }) => {
      await receipt(text, 'held-user', Date.now() - 1000, {}, forward);
      const certificatesBefore = await db.webhookLegacyQuiescenceCertificate.count();
      const result = await preview();
      expect(result.decision).toBe('DENY');
      expect(result.issues).toEqual([
        { code: 'materialization_preview_blocked', descriptor: 'sql:materialization-preview' },
        {
          code: `materialization_preview_blocked_source_${forward ? 'forward_' : ''}command`,
          descriptor: 'sql:materialization-preview',
        },
      ]);
      expect(await db.webhookLegacyQuiescenceCertificate.count()).toBe(certificatesBefore);
      await expect(actualPage()).resolves.toMatchObject({ blocked: true });
    },
  );
  it('checks the current custom command name', async () => {
    await db.chatSettings.update({ where: { chatId }, data: { adminSilenceCommandName: 'пауза' } });
    await receipt('пауза 12');
    const result = await preview();
    expect(result.decision).toBe('DENY');
    expect(result.issues).toContainEqual({
      code: 'materialization_preview_blocked_source_command',
      descriptor: 'sql:materialization-preview',
    });
  });
  it.each(['EXECUTION', 'UNKNOWN_OLD_KIND'])(
    'includes %s claims when predicting a blocker',
    async (kind) => {
      const event = await receipt();
      await db.webhookExecutionClaim.create({
        data: {
          id: `${noise}-case-${randomUUID()}`,
          kind,
          semanticKey: event.semanticKey!,
          webhookEventId: kind === 'UNKNOWN_OLD_KIND' ? null : event.id,
          businessStartedAt: new Date(),
        },
      });
      expect((await preview()).issues).toEqual([
        { code: 'materialization_preview_blocked', descriptor: 'sql:materialization-preview' },
        {
          code: 'materialization_preview_blocked_receipt_claim_effects_unproved',
          descriptor: 'sql:materialization-preview',
        },
      ]);
    },
  );
  it('keeps digest stable across read-only snapshots while including changed source evidence', async () => {
    const event = await receipt();
    expect(candidate.owner).toMatchObject({
      sourceDispositionId: null,
      sourceDispositionReceiptId: null,
    });
    const first = await preview();
    const second = await preview();
    expect(first.decision).toBe('READY');
    expect(second.proofSha256).toBe(first.proofSha256);
    const currentOwner = candidate.owner;
    candidate = {
      ...candidate,
      owner: Object.fromEntries(
        Object.entries(currentOwner).filter(
          ([key]) => !['sourceDispositionId', 'sourceDispositionReceiptId'].includes(key),
        ),
      ) as typeof currentOwner,
    };
    try {
      expect((await preview()).proofSha256).toBe(first.proofSha256);
    } finally {
      candidate = { ...candidate, owner: currentOwner };
    }
    await db.webhookEvent.update({
      where: { id: event.id },
      data: { errorMessage: 'changed evidence' },
    });
    expect((await preview()).proofSha256).not.toBe(first.proofSha256);
  });
  it('binds a refused source in the digest while exposing only its fixed guard code', async () => {
    const event = await receipt('Private rejected source text');
    const raw = JSON.parse(JSON.stringify(event.rawPayload));
    const normalized = JSON.parse(JSON.stringify(event.normalizedPayload));
    raw.message.body.privateUnsupportedField = 'private-proof-value-a';
    normalized.raw = raw;
    const firstSource = await db.webhookEvent.update({
      where: { id: event.id },
      data: { rawPayload: raw, normalizedPayload: normalized },
    });
    const first = await preview();
    expect(first.decision).toBe('DENY');
    expect(first.issues).toEqual([
      { code: 'materialization_preview_blocked', descriptor: 'sql:materialization-preview' },
      {
        code: 'materialization_preview_blocked_source_body_keys',
        descriptor: 'sql:materialization-preview',
      },
    ]);
    expect((await preview()).proofSha256).toBe(first.proofSha256);
    expect(await db.webhookEvent.findUniqueOrThrow({ where: { id: event.id } })).toEqual(
      firstSource,
    );
    // FLAG: The rejected source changes without changing its size or refusal kind.
    // Metadata and a generic DENY alone cannot bind this immutable content evidence.
    raw.message.body.privateUnsupportedField = 'private-proof-value-b';
    const secondSource = await db.webhookEvent.update({
      where: { id: event.id },
      data: { rawPayload: raw, normalizedPayload: normalized },
    });
    const second = await preview();
    expect(second.decision).toBe('DENY');
    expect(second.issues).toEqual(first.issues);
    expect(second.proofSha256).not.toBe(first.proofSha256);
    expect((await preview()).proofSha256).toBe(second.proofSha256);
    for (const result of [first, second]) {
      const diagnostic = JSON.stringify(result);
      for (const value of [
        event.id,
        chatId,
        'held-user',
        'Private rejected source text',
        'privateUnsupportedField',
        'private-proof-value-a',
        'private-proof-value-b',
      ])
        expect(diagnostic).not.toContain(value);
    }
    expect(await actualPage()).toMatchObject({ complete: false, blocked: true });
    expect(await db.webhookEvent.findUniqueOrThrow({ where: { id: event.id } })).toEqual(
      secondSource,
    );
  });
  it('walks more than one same-timestamp page and stays out of unrelated retained history', async () => {
    const at = Date.now() - 1000;
    const template = await receipt('Other author', 'unrelated-user', at);
    const rows = Array.from({ length: 205 }, () => ({
      ...template,
      id: randomUUID(),
      dedupKey: randomUUID(),
    }));
    receipts.push(...rows.map(({ id }) => id));
    await db.webhookEvent.createMany({ data: rows as never });
    const result = await preview();
    expect(result.issues).toEqual([]);
    expect(result.scannedReceipts).toBe(207);
    expect(result.prefixPages).toBe(2);
    expect(
      result.plans.filter((plan) => plan.indexes.includes('webhook_events_ordered_chat_head_idx')),
    ).toHaveLength(2);
    expect(result.cost.probes).toBeLessThan(40);
  });
  it('keeps the ordered-head index for tied pages with mixed queue assignments', async () => {
    const template = await receipt('Other author', 'unrelated-user', Date.now() - 1000);
    const queues = [null, 'unknown', 'default', 'other'];
    const rows = Array.from({ length: 400 }, (_, index) => ({
      ...template,
      id: randomUUID(),
      dedupKey: randomUUID(),
      queueName: queues[index % queues.length],
    }));
    receipts.push(...rows.map(({ id }) => id));
    await db.webhookEvent.createMany({ data: rows as never });
    const result = await preview();
    expect(result.decision).toBe('READY');
    expect(result.scannedReceipts).toBe(402);
    expect(result.prefixPages).toBe(3);
    expect(
      result.plans.filter((plan) => plan.indexes.includes('webhook_events_ordered_chat_head_idx')),
    ).toHaveLength(3);
  });
  it('previews and materializes 800 held receipts within the production query budget', async () => {
    for (let index = 0; index < 800; index++)
      await receipt(`Ordinary retained photo caption ${index}`);
    const result = await preview({ pages: 512, rows: 10_000, probes: 50_000 });
    expect(result.issues).toEqual([]);
    expect(result.decision).toBe('READY');
    expect(result.scannedReceipts).toBe(801);
    expect(result.prefixPages).toBe(5);
    expect(result.cost.pages).toBeLessThan(60);
    expect(result.cost.probes).toBeLessThan(10_000);
    expect(
      await db.webhookLegacyReceiptDisposition.count({ where: { receiptId: { in: receipts } } }),
    ).toBe(0);
    let page = await actualPage();
    let pages = 1;
    while (!page.complete && !page.blocked && pages++ < 6)
      page = await materializeLegacyHeldReceiptPage(db, certificates.at(-1)!, chatId, 200);
    expect(page).toMatchObject({ blocked: false, complete: true });
    expect(
      await db.webhookLegacyReceiptDisposition.count({ where: { receiptId: { in: receipts } } }),
    ).toBe(801);
  });

  it('keeps exact bounded plans for 801 receipts across planner costs', async () => {
    for (let index = 0; index < 800; index++) await receipt(`Planner fixture ${index}`);
    await db.$executeRawUnsafe('ANALYZE webhook_events');
    await db.$executeRawUnsafe('ANALYZE webhook_execution_claims');
    const observations: unknown[] = [];
    for (const [randomPageCost, cacheSize] of [
      ['1.1', '4GB'],
      ['4', '1MB'],
      ['50', '1MB'],
    ] as const) {
      const result = await reader.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT set_config('random_page_cost', ${randomPageCost}, true), set_config('effective_cache_size', ${cacheSize}, true)`;
          return previewLegacyRecoveryMaterialization(tx, [candidate], {
            ...allowance(),
            probes: 50_000,
          });
        },
        { isolationLevel: 'RepeatableRead', timeout: 30_000 },
      );
      observations.push({
        randomPageCost,
        cacheSize,
        decision: result.decision,
        failure: result.planFailure,
        indexes: [...new Set(result.plans.flatMap((plan) => plan.indexes))],
      });
      expect(result.planFailure).toBeUndefined();
      expect(result.decision).toBe('READY');
      expect(result.scannedReceipts).toBe(801);
    }
    console.log('MATERIALIZATION_PLANNER_COSTS', JSON.stringify(observations));
  });

  it('refuses a real sequential fallback even when all planner scan hints are disabled', async () => {
    await receipt();
    const result = await reader.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('random_page_cost', '1000000', true), set_config('enable_indexscan', 'off', true), set_config('enable_indexonlyscan', 'off', true)`;
        return previewLegacyRecoveryMaterialization(tx, [candidate], allowance());
      },
      { isolationLevel: 'RepeatableRead', timeout: 30_000 },
    );
    expect(result.decision).toBe('DENY');
    expect(result.issues).toEqual([
      { code: 'materialization_preview_plan', descriptor: 'sql:materialization-preview' },
    ]);
    expect(result.planFailure?.nodeTypes).toContain('Seq Scan');
    expect(JSON.stringify(result.planFailure)).not.toContain(chatId);
    expect(JSON.stringify(result.planFailure)).not.toContain(candidate.owner.id);
  });

  it('rejects a changed required index and keeps planner settings inside the transaction', async () => {
    await receipt();
    const [definition] = await db.$queryRaw<
      Array<{ ddl: string }>
    >`SELECT pg_get_indexdef('public.webhook_events_ordered_chat_head_idx'::regclass) AS ddl`;
    await db.$executeRawUnsafe('DROP INDEX public.webhook_events_ordered_chat_head_idx');
    try {
      const result = await reader.$transaction(
        (tx) => previewLegacyRecoveryMaterialization(tx, [candidate], allowance()),
        { isolationLevel: 'RepeatableRead', timeout: 30_000 },
      );
      expect(result.decision).toBe('DENY');
      expect(result.planFailure?.expectedIndex).toBe('webhook_events_ordered_chat_head_idx');
      expect(result.planFailure?.indexes).not.toContain('webhook_events_ordered_chat_head_idx');
    } finally {
      await db.$executeRawUnsafe(definition!.ddl);
    }
    const [session] = await reader.$queryRaw<
      Array<{ seq: string; bitmap: string }>
    >`SELECT current_setting('enable_seqscan') AS seq, current_setting('enable_bitmapscan') AS bitmap`;
    expect(session).toEqual({ seq: 'on', bitmap: 'on' });
  });

  it('rejects a new pre-seal command at the required cold recheck', async () => {
    await receipt();
    expect((await preview()).decision).toBe('READY');
    await receipt('тишина 12');
    expect((await preview()).decision).toBe('DENY');
  });
  it('refuses a writable or non-repeatable snapshot', async () => {
    expect(
      (
        await db.$transaction(
          (tx) => previewLegacyRecoveryMaterialization(tx, [candidate], allowance()),
          { isolationLevel: 'RepeatableRead' },
        )
      ).decision,
    ).toBe('DENY');
    expect(
      (
        await reader.$transaction(
          (tx) => previewLegacyRecoveryMaterialization(tx, [candidate], allowance()),
          { isolationLevel: 'ReadCommitted' },
        )
      ).decision,
    ).toBe('DENY');
  });
  async function nextCandidate() {
    const event = await receipt(
      'Next old source',
      'next-held-user',
      candidate.owner.createdAt.getTime() + 100,
      {
        status: 'FAILED',
        errorMessage: candidate.owner.errorMessage,
      },
    );
    await db.webhookExecutionClaim.create({
      data: {
        kind: 'EXECUTION',
        semanticKey: event.semanticKey!,
        webhookEventId: event.id,
        enforced: false,
        createdAt: event.createdAt,
      },
    });
    candidate = (await inspectLegacyRecoveryCandidate(db, event.id, ['major']))!;
    expect(candidate).toBeTruthy();
  }
  async function installation(certificateId: string) {
    const certificate = await db.webhookLegacyQuiescenceCertificate.findUniqueOrThrow({
      where: { id: certificateId },
    });
    return readLegacyRecoveryInstallation(db, certificateId, {
      sourceSha: certificate.sourceSha,
      imageId: certificate.imageId,
      previewSha256: certificate.previewSha256,
      recoveries: 1,
      children: 0,
    });
  }
  it('passes an independently proved prior certificate without changing its receipt or proof', async () => {
    const firstOwner = candidate.owner.id;
    expect(await actualPage()).toMatchObject({ complete: true, blocked: false });
    const firstCertificate = certificates.at(-1)!;
    const before = await db.webhookEvent.findUniqueOrThrow({ where: { id: firstOwner } });
    const proof = await db.webhookLegacyReceiptDisposition.findUniqueOrThrow({
      where: { receiptId: firstOwner },
    });
    await nextCandidate();
    const result = await preview();
    expect(result.issues).toEqual([]);
    expect(result.decision).toBe('READY');
    expect(result.scannedReceipts).toBe(2);
    expect((await preview()).proofSha256).toBe(result.proofSha256);
    const proofPlans = result.plans.filter(
      (plan) =>
        plan.descriptor === 'sql:materialization-preview:webhook_legacy_receipt_dispositions',
    );
    expect(proofPlans.length).toBeGreaterThan(0);
    for (const plan of proofPlans)
      expect([
        'webhook_legacy_receipt_dispositions_receipt_id_key',
        'webhook_legacy_receipt_dispositions_receipt_id_id_key',
      ]).toEqual(expect.arrayContaining(plan.indexes));
    expect(result.plans.flatMap((plan) => plan.indexes)).toContain(
      'webhook_legacy_sealed_authorities_pkey',
    );
    expect(await actualPage()).toMatchObject({ complete: true, blocked: false });
    expect(await installation(firstCertificate)).toMatchObject({ state: 'MATERIALIZED' });
    expect(await installation(certificates.at(-1)!)).toMatchObject({ state: 'MATERIALIZED' });
    expect(await db.webhookEvent.findUniqueOrThrow({ where: { id: firstOwner } })).toEqual(before);
    expect(
      await db.webhookLegacyReceiptDisposition.findUniqueOrThrow({
        where: { receiptId: firstOwner },
      }),
    ).toEqual(proof);
  });
  it('refuses a pointer whose source proof is invalid even outside the selected scope', async () => {
    await actualPage();
    const authority = await db.webhookLegacySealedAuthority.findUniqueOrThrow({
      where: { certificateId: certificates.at(-1)! },
    });
    await nextCandidate();
    const unknown = await receipt('Unproved source', 'unrelated-user', Date.now() - 1000, {
      status: 'FAILED',
      nextEnqueueAt: new Date(),
    });
    // FLAG: The disposable fixture obeys all database immutability/FK constraints.
    // A non-null pointer and valid authority cannot replace the source-digest check.
    const proof = await db.webhookLegacyReceiptDisposition.create({
      data: {
        id: randomUUID(),
        receiptId: unknown.id,
        authorityId: authority.id,
        sourceDigest: '0'.repeat(64),
        originalStatus: 'FAILED',
        originalSnapshot: {},
        scopeKind: 'EXACT_OWNER',
      },
    });
    const before = await db.webhookEvent.update({
      where: { id: unknown.id },
      data: {
        legacyDispositionId: proof.id,
        legacyDispositionReceiptId: unknown.id,
      },
    });
    expect((await preview()).issues).toEqual([
      { code: 'materialization_preview_blocked', descriptor: 'sql:materialization-preview' },
      {
        code: 'materialization_preview_blocked_receipt_proof_unproved',
        descriptor: 'sql:materialization-preview',
      },
    ]);
    expect(await actualPage()).toMatchObject({ complete: false, blocked: true });
    expect(await installation(certificates.at(-1)!)).toMatchObject({ state: 'SEALED' });
    expect(await db.webhookEvent.findUniqueOrThrow({ where: { id: unknown.id } })).toEqual(before);
  });
  it.each([false, true])(
    'proves the physical leading receipt lookup and rejects id-only plan evidence (wrongBound=%s)',
    async (wrongBound) => {
      await actualPage();
      await nextCandidate();
      const indexes = await db.$queryRaw<Array<{ name: string; unique: boolean; leading: string }>>`
        SELECT c.relname AS name, i.indisunique AS unique,
          pg_get_indexdef(i.indexrelid, 1, true) AS leading
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname IN ('webhook_legacy_receipt_dispositions_receipt_id_key',
          'webhook_legacy_receipt_dispositions_receipt_id_id_key') ORDER BY c.relname`;
      expect(indexes).toHaveLength(2);
      for (const index of indexes)
        expect(index).toMatchObject({ unique: true, leading: 'receipt_id' });
      let inspected = 0;
      const result = await reader.$transaction(
        async (tx) => {
          const observed = {
            $queryRaw: async (statement: Prisma.Sql) => {
              const rows =
                await tx.$queryRaw<
                  Array<{ 'QUERY PLAN': Array<{ Plan: Record<string, unknown> }> }>
                >(statement);
              if (
                statement.sql.includes('EXPLAIN') &&
                statement.sql.includes('FROM webhook_legacy_receipt_dispositions t')
              ) {
                const visit = (node: Record<string, unknown>) => {
                  if (node['Relation Name'] === 'webhook_legacy_receipt_dispositions') {
                    inspected++;
                    expect(indexes.map((index) => index.name)).toContain(node['Index Name']);
                    expect(node['Node Type']).toMatch(/^Index (?:Only )?Scan$/u);
                    expect(node['Index Cond']).toMatch(/\bt\.receipt_id =/u);
                    expect(node.Filter).toBeUndefined();
                    // FLAG: Inject only a bad plan predicate after observing the actual native
                    // leading-key proof. An allowed index name cannot authorize a nonleading id.
                    if (wrongBound)
                      node['Index Cond'] = String(node['Index Cond']).replace(
                        't.receipt_id =',
                        't.id =',
                      );
                  }
                  for (const child of (node.Plans ?? []) as Array<Record<string, unknown>>)
                    visit(child);
                };
                visit(rows[0]!['QUERY PLAN'][0]!.Plan);
              }
              return rows;
            },
          };
          return previewLegacyRecoveryMaterialization(observed as never, [candidate], allowance());
        },
        { isolationLevel: 'RepeatableRead', timeout: 30_000 },
      );
      expect(inspected).toBeGreaterThan(0);
      expect(result.decision).toBe(wrongBound ? 'DENY' : 'READY');
      if (wrongBound)
        expect(result.planFailure).toMatchObject({
          reason: 'bound',
          table: 'webhook_legacy_receipt_dispositions',
        });
      else expect(result.planFailure).toBeUndefined();
    },
  );
  it('passes an oversized unrelated receipt without fetching its body or changing it', async () => {
    const event = await receipt('x'.repeat(150_000), 'unrelated-user');
    const result = await preview({ bytes: 100_000 });
    expect(result.decision).toBe('READY');
    expect(result.cost.bytes).toBeLessThan(100_000);
    expect(await actualPage()).toMatchObject({ complete: true, blocked: false, applied: 0 });
    expect(await installation(certificates.at(-1)!)).toMatchObject({ state: 'MATERIALIZED' });
    expect(await db.webhookEvent.findUniqueOrThrow({ where: { id: event.id } })).toEqual(event);
  });
  it('keeps an oversized held receipt blocked in preview and actual materialization', async () => {
    const event = await receipt('x'.repeat(150_000));
    expect((await preview()).decision).toBe('DENY');
    expect(await actualPage()).toMatchObject({ complete: false, blocked: true });
    expect(await db.webhookEvent.findUniqueOrThrow({ where: { id: event.id } })).toEqual(event);
  });
  it.each(['future', 'budget'] as const)(
    'refuses %s prefixes before installation',
    async (fault) => {
      await receipt(
        'Ordinary',
        'unrelated-user',
        fault === 'future' ? Date.now() + 10_000 : Date.now() - 1000,
      );
      const result = await preview(fault === 'budget' ? { pages: 1 } : {});
      expect(result.decision).toBe('DENY');
      expect(result.activationAuthorized).toBe(false);
    },
  );
});
