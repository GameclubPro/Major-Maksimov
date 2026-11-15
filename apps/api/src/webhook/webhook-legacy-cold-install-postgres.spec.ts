import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';
import { Prisma, createPrismaClient, type PrismaClient } from '../prisma/prisma-client';
import { RUNTIME_SERVICE_NAMES } from '../runtime/runtime-topology';
import { GroupCommandAuthorityService } from '../common/group-command-authority.service';
import { WebhookCanonicalExecutionService } from '../moderation/webhook-canonical-execution.service';
import { WebhookOutboxService } from './webhook-outbox.service';
import { WebhookService } from './webhook.service';
import { WebhookParser } from './webhook.parser';
import {
  WebhookLegacyHoldService,
  WEBHOOK_LEGACY_HELD_MARKER,
  legacyOrderReleasedSql,
  legacyUpdateHeldSql,
} from './webhook-legacy-hold.service';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import { EraserSourceHoldBarrierError } from '../message-retention/eraser-source-hold-barrier';
import {
  buildLegacyRecoveryPreviewDigest,
  createLegacyColdCertificate,
  inspectLegacyRecoveryCandidate,
  installLegacyRecoveryBatch,
  installAndSealLegacyRecoveryBatch,
  legacySnapshotDigest,
  sealLegacyColdCertificate,
  type LegacyRecoveryCandidate,
  type LegacyStopAttestation,
} from './webhook-legacy-cold-install';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const native = databaseUrl ? describe : describe.skip;
jest.setTimeout(30_000);

native('native cold legacy installation and ordering', () => {
  let prisma: PrismaClient;
  let holds: WebhookLegacyHoldService;
  let cutoff: Date;
  const certificates: string[] = [];
  const chats: string[] = [];
  const receipts: string[] = [];
  const originalOffline = process.env.MAXIM_LEGACY_RECOVERY_OFFLINE;

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Cold recovery fixtures require disposable local stores');
    prisma = createPrismaClient(databaseUrl, { max: 8, statement_timeout: 10_000 });
    const [database] = await prisma.$queryRaw<
      Array<{ version: string; timezone: string }>
    >`SELECT version(), current_setting('TimeZone') AS timezone`;
    if (
      !database?.version.startsWith('PostgreSQL ') ||
      /pglite|wasm/iu.test(database.version) ||
      database.timezone !== 'UTC' ||
      process.env.TZ !== 'UTC'
    )
      throw new Error('Cold recovery requires native PostgreSQL and process/server UTC');
    holds = new WebhookLegacyHoldService(prisma as never);
    cutoff = (
      await prisma.$queryRaw<
        Array<{ at: Date }>
      >`SELECT finished_at AS at FROM _prisma_migrations WHERE migration_name = '20261005020000_add_multibot_order_fences' AND finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC LIMIT 1`
    )[0]!.at;
    process.env.MAXIM_LEGACY_RECOVERY_OFFLINE = '1';
  });
  afterEach(async () => {
    const ids = receipts.splice(0);
    await prisma.webhookEvent.deleteMany({ where: { id: { in: ids } } });
    await prisma.webhookLegacyReceiptDisposition.deleteMany({ where: { receiptId: { in: ids } } });
    for (const id of certificates.splice(0)) {
      await prisma.webhookLegacyMaterializationCursor.deleteMany({ where: { certificateId: id } });
      await prisma.webhookLegacySealedAuthority.deleteMany({ where: { certificateId: id } });
      await prisma.webhookLegacyChildHold.deleteMany({ where: { certificateId: id } });
      await prisma.webhookLegacyRecovery.deleteMany({ where: { certificateId: id } });
      await prisma.webhookLegacyQuiescenceCertificate.deleteMany({ where: { id } });
    }
    await prisma.chat.deleteMany({ where: { id: { in: chats.splice(0) } } });
  });
  afterAll(async () => {
    if (originalOffline === undefined) delete process.env.MAXIM_LEGACY_RECOVERY_OFFLINE;
    else process.env.MAXIM_LEGACY_RECOVERY_OFFLINE = originalOffline;
    await prisma?.$disconnect();
  });

  async function fixture() {
    const chatId = `-cold-${randomUUID()}`;
    chats.push(chatId);
    await prisma.chat.create({
      data: {
        id: chatId,
        entityType: 'CHAT',
        title: 'Disposable cold fixture',
        settings: {
          create: { nightModeForceCloseEnabled: true, nightModeForceCloseForever: true },
        },
        rules: { create: { text: 'Preserved local rules' } },
      },
    });
    const timestamp = cutoff.getTime() - 5000;
    const raw = {
      update_type: 'message_created',
      timestamp,
      message: {
        sender: { user_id: `human-${randomUUID()}`, name: 'Human', is_bot: false },
        recipient: { chat_id: chatId, chat_type: 'chat' },
        timestamp,
        body: { mid: `original-${randomUUID()}`, text: 'Ordinary original source' },
      },
    };
    const update = new WebhookParser().parse(raw, { botId: 'major-1' });
    const semanticKey = buildWebhookSemanticEventKey(update)!;
    const owner = await prisma.webhookEvent.create({
      data: {
        botId: 'major-1',
        dedupKey: randomUUID(),
        semanticKey,
        status: 'FAILED',
        normalizedPayload: update as unknown as Prisma.InputJsonValue,
        rawPayload: {},
        createdAt: new Date(timestamp + 1000),
        errorMessage:
          'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required',
      },
    });
    receipts.push(owner.id);
    await prisma.webhookExecutionClaim.create({
      data: {
        kind: 'EXECUTION',
        semanticKey,
        webhookEventId: owner.id,
        createdAt: new Date(timestamp + 1000),
        enforced: false,
      },
    });
    const candidate = await inspectLegacyRecoveryCandidate(prisma, owner.id, ['major-1']);
    expect(candidate).not.toBeNull();
    return { candidate: candidate!, update, chatId };
  }
  function attestation(previewSha256: string): LegacyStopAttestation {
    const imageId = `sha256:${'a'.repeat(64)}`;
    return {
      version: 1,
      sourceSha: 'b'.repeat(40),
      imageId,
      transitionJournalSha256: 'c'.repeat(64),
      previewSha256,
      queueFenceNonce: 'isolated-disposable-role-fence',
      roleSnapshots: RUNTIME_SERVICE_NAMES.filter((name) => name !== 'api-all').map(
        (serviceName) => ({
          serviceName,
          containerId: legacySnapshotDigest(serviceName),
          imageId,
          sourceSha: 'b'.repeat(40),
          stopped: true,
        }),
      ),
    };
  }
  async function certificate(
    candidate: LegacyRecoveryCandidate,
    children: Parameters<typeof installLegacyRecoveryBatch>[3] = [],
  ) {
    const previewSha256 = buildLegacyRecoveryPreviewDigest([candidate], children);
    const cert = await createLegacyColdCertificate(prisma, attestation(previewSha256));
    certificates.push(cert.id);
    return { cert, previewSha256 };
  }
  function outbox() {
    return Object.assign(Object.create(WebhookOutboxService.prototype), { prisma }) as {
      findOrderedWebhookHeadsForChats(ids: string[]): Promise<Map<string, { id: string }>>;
      deleteTerminalFailedWebhookBatch(at: Date): Promise<{ removed: number; scanned: number }>;
      webhookRetentionCursors: Map<string, unknown>;
    };
  }

  it.each(['webhook_legacy_recoveries', 'webhook_legacy_child_holds'] as const)(
    'refuses a certificate identity cascade in %s without changing the reviewed schema',
    async (table) => {
      const assertion = readFileSync(
        resolve(
          __dirname,
          '../../prisma/migrations/20261006002000_assert_legacy_certificate_identity/migration.sql',
        ),
        'utf8',
      );
      const assertionBody = assertion.match(/DO \$\$[\s\S]*END \$\$;/u)?.[0];
      expect(assertionBody).toBeDefined();
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL lock_timeout = '3s'");
        await client.query("SET LOCAL statement_timeout = '10s'");
        // FLAG: Only these two static table names can enter this disposable-store DDL.
        await client.query(`
          ALTER TABLE "${table}" DROP CONSTRAINT "${table}_certificate_id_fkey";
          ALTER TABLE "${table}" ADD CONSTRAINT "${table}_certificate_id_fkey"
            FOREIGN KEY (certificate_id)
            REFERENCES webhook_legacy_quiescence_certificates(id)
            ON DELETE RESTRICT ON UPDATE CASCADE;
        `);
        await expect(client.query(assertionBody!)).rejects.toThrow(
          'Legacy certificate identity constraint differs from reviewed definition',
        );
      } finally {
        await client.query('ROLLBACK');
        await client.end();
      }
      const restored = new Client({ connectionString: databaseUrl });
      await restored.connect();
      try {
        await expect(restored.query(assertion)).resolves.toBeDefined();
      } finally {
        await restored.end();
      }
    },
  );

  it('keeps linked evidence unchanged when a certificate identity update is attempted', async () => {
    const { candidate } = await fixture();
    const { cert } = await certificate(candidate);
    await installLegacyRecoveryBatch(prisma, cert.id, [candidate], []);
    await expect(
      prisma.webhookLegacyQuiescenceCertificate.update({
        where: { id: cert.id },
        data: { id: randomUUID() },
      }),
    ).rejects.toThrow(/Foreign key constraint/iu);
    expect(
      await prisma.webhookLegacyRecovery.findFirst({ where: { certificateId: cert.id } }),
    ).toMatchObject({ certificateId: cert.id });
    await expect(
      prisma.webhookLegacyQuiescenceCertificate.findUniqueOrThrow({ where: { id: cert.id } }),
    ).resolves.toMatchObject({ id: cert.id });
  });

  it('refuses a cold source write until the independent service confirms its permanent holds', async () => {
    const { candidate, chatId } = await fixture();
    const { cert } = await certificate(candidate, []);
    await prisma.$executeRaw`INSERT INTO eraser_chat_bindings(chat_id, legacy_hours) VALUES(${chatId}, 48)`;
    const oldUrl = process.env.ERASER_CONTROL_URL;
    const oldToken = process.env.ERASER_CONTROL_TOKEN;
    process.env.ERASER_CONTROL_URL = 'http://eraser:3000';
    process.env.ERASER_CONTROL_TOKEN = 'control-only';
    const fetch = jest.spyOn(global, 'fetch');
    try {
      fetch.mockResolvedValueOnce(new Response('{}', { status: 409 }));
      await expect(
        installAndSealLegacyRecoveryBatch(prisma, cert.id, [candidate], []),
      ).rejects.toBeInstanceOf(EraserSourceHoldBarrierError);
      expect(await prisma.webhookLegacyRecovery.count({ where: { certificateId: cert.id } })).toBe(
        0,
      );
      expect(
        await prisma.webhookLegacyQuiescenceCertificate.findUniqueOrThrow({
          where: { id: cert.id },
        }),
      ).toMatchObject({ sealedAt: null });
      fetch.mockResolvedValueOnce(new Response('{"success":true}'));
      await expect(
        installAndSealLegacyRecoveryBatch(prisma, cert.id, [candidate], []),
      ).resolves.toEqual({ recoveries: 1, children: 0 });
      expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
        holdMessages: [{ chatId, messageId: candidate.source.messageId }],
        holdAuthorIds: [candidate.source.userId],
      });
    } finally {
      fetch.mockRestore();
      await prisma.$executeRaw`DELETE FROM eraser_chat_bindings WHERE chat_id = ${chatId}`;
      if (oldUrl === undefined) delete process.env.ERASER_CONTROL_URL;
      else process.env.ERASER_CONTROL_URL = oldUrl;
      if (oldToken === undefined) delete process.env.ERASER_CONTROL_TOKEN;
      else process.env.ERASER_CONTROL_TOKEN = oldToken;
    }
  });

  it('preserves unknown evidence, denies partial installation, and releases only the sealed order position', async () => {
    const { candidate, update, chatId } = await fixture();
    const child = {
      jobKey: `child-${randomUUID()}`,
      queueName: 'max-actions-background',
      jobPayloadDigest: 'd'.repeat(64),
      chatId,
    };
    const { cert, previewSha256 } = await certificate(candidate, [child]);
    const counts = await installLegacyRecoveryBatch(prisma, cert.id, [candidate], [child]);
    expect(await holds.isUpdateHeld(update)).toBe(true);
    expect(await holds.settleHeldReceipt(candidate.owner.id, update)).toBe(false);
    const reader = outbox();
    expect((await reader.findOrderedWebhookHeadsForChats([chatId])).get(chatId)?.id).toBe(
      candidate.owner.id,
    );
    await expect(
      sealLegacyColdCertificate(prisma, cert.id, { recoveries: 2, children: 1, previewSha256 }),
    ).rejects.toThrow();
    await sealLegacyColdCertificate(prisma, cert.id, { ...counts, previewSha256 });
    const late = structuredClone(update);
    late.type = 'message_edited';
    late.botId = 'major-9';
    late.raw!.update_type = 'message_edited';
    late.updateId = randomUUID();
    const receipt = await prisma.webhookEvent.create({
      data: {
        dedupKey: `${late.botId}:${late.updateId}`,
        botId: 'major-9',
        semanticKey: buildWebhookSemanticEventKey(late),
        normalizedPayload: late as unknown as Prisma.InputJsonValue,
        rawPayload: {},
      },
    });
    receipts.push(receipt.id);
    expect(await holds.settleHeldReceipt(receipt.id, late)).toBe(true);
    const independent = structuredClone(update);
    independent.updateId = randomUUID();
    independent.message!.messageId = randomUUID();
    independent.message!.senderId = 'unaffected-human';
    const independentReceipt = await prisma.webhookEvent.create({
      data: {
        dedupKey: randomUUID(),
        botId: 'major-4',
        semanticKey: buildWebhookSemanticEventKey(independent),
        normalizedPayload: independent as unknown as Prisma.InputJsonValue,
        rawPayload: {},
      },
    });
    receipts.push(independentReceipt.id);
    expect((await reader.findOrderedWebhookHeadsForChats([chatId])).get(chatId)?.id).toBe(
      independentReceipt.id,
    );
    expect(await holds.isUpdateHeld(late)).toBe(true);
    expect(await holds.isUpdateHeld(independent)).toBe(false);
    expect(await holds.isGlobalUserHeld(candidate.source.userId)).toBe(true);
    expect(await holds.isOutboundJobHeld(child.jobKey)).toBe(true);
    const canonical = new WebhookCanonicalExecutionService(
      prisma as never,
      undefined,
      undefined,
      holds,
    );
    await expect(canonical.prepareExecution(receipt.id, 'major-9')).resolves.toBeNull();
    const ingress = new WebhookService(prisma as never, new ConfigService({}), {} as never);
    Object.assign(ingress, { legacyHolds: holds });
    await expect(ingress.preparePersistedWebhookEvent(candidate.owner.id)).resolves.toMatchObject({
      canonical: false,
      prepared: false,
    });
    expect(await prisma.webhookEvent.findUnique({ where: { id: candidate.owner.id } })).toEqual({
      ...candidate.owner,
      legacyDispositionId: expect.any(String),
      legacyDispositionReceiptId: candidate.owner.id,
    });
    expect(
      await prisma.webhookExecutionClaim.findUnique({ where: { id: candidate.claim.id } }),
    ).toEqual(candidate.claim);
    expect(
      (await prisma.chatSettings.findUnique({ where: { chatId } }))!.nightModeForceCloseEnabled,
    ).toBe(true);
    expect((await prisma.chatRules.findUnique({ where: { chatId } }))!.text).toBe(
      'Preserved local rules',
    );
    const chat = await prisma.chat.findUniqueOrThrow({ where: { id: chatId } });
    expect(chat.chatControlOrderAt).toEqual(cert.quiescedAt);
    expect(chat.rulesOrderAt).toEqual(cert.quiescedAt);
    const command = new GroupCommandAuthorityService(prisma as never, holds);
    await expect(command.claim(late, 'major-9')).resolves.toBeNull();
    const retention = outbox();
    retention.webhookRetentionCursors = new Map();
    await retention.deleteTerminalFailedWebhookBatch(new Date(Date.now() + 60_000));
    expect(await prisma.webhookEvent.findUnique({ where: { id: candidate.owner.id } })).toEqual({
      ...candidate.owner,
      legacyDispositionId: expect.any(String),
      legacyDispositionReceiptId: candidate.owner.id,
    });
    await prisma.chat.delete({ where: { id: chatId } });
    expect(
      await new WebhookLegacyHoldService(prisma as never).isMessageHeld(
        chatId,
        candidate.source.messageId,
      ),
    ).toBe(true);
    expect(await holds.isOutboundJobHeld(child.jobKey)).toBe(true);
  });

  it('rechecks original source scope and all eligibility after preview without installing partial work', async () => {
    const { candidate } = await fixture();
    const forged = { ...candidate, source: { ...candidate.source, userId: 'different-human' } };
    const { cert } = await certificate(forged);
    await expect(installLegacyRecoveryBatch(prisma, cert.id, [forged], [])).rejects.toThrow(
      'snapshot changed',
    );
    expect(await prisma.webhookLegacyRecovery.count({ where: { certificateId: cert.id } })).toBe(0);
    await prisma.webhookExecutionClaim.update({
      where: { id: candidate.claim.id },
      data: { leaseToken: 'modern-live-lease', leaseExpiresAt: new Date(Date.now() + 60_000) },
    });
    expect(
      await inspectLegacyRecoveryCandidate(prisma, candidate.owner.id, ['major-1']),
    ).toBeNull();
  });

  it.each(['publisher-bot', 'major-9'])(
    'rejects contradictory normalized receiver %s at preview and the locked installation',
    async (botId) => {
      const { candidate, update } = await fixture();
      const contradictory = { ...update, botId };
      // Both recognized Major receivers share the semantic message key. Provenance
      // rejection must come from the original receiver check, not a changed key.
      expect(buildWebhookSemanticEventKey(contradictory)).toBe(candidate.owner.semanticKey);
      const { cert } = await certificate(candidate);
      const changedOwner = await prisma.webhookEvent.update({
        where: { id: candidate.owner.id },
        data: { normalizedPayload: contradictory as unknown as Prisma.InputJsonValue },
      });
      expect(
        await inspectLegacyRecoveryCandidate(prisma, candidate.owner.id, ['major-1', 'major-9']),
      ).toBeNull();
      await expect(
        installAndSealLegacyRecoveryBatch(prisma, cert.id, [candidate], []),
      ).rejects.toThrow('snapshot changed');
      // FLAG: A caller-built, internally matching preview is still not authority.
      // This reaches the locked source recheck without relying on stale snapshot rejection.
      const forged = {
        ...candidate,
        owner: changedOwner,
        normalizedPayloadDigest: legacySnapshotDigest(changedOwner.normalizedPayload),
      };
      const forgedCertificate = await certificate(forged);
      await expect(
        installAndSealLegacyRecoveryBatch(prisma, forgedCertificate.cert.id, [forged], []),
      ).rejects.toThrow('snapshot changed');
      for (const rejected of [cert, forgedCertificate.cert]) {
        expect(
          await prisma.webhookLegacyRecovery.count({ where: { certificateId: rejected.id } }),
        ).toBe(0);
        expect(
          await prisma.webhookLegacyChildHold.count({ where: { certificateId: rejected.id } }),
        ).toBe(0);
        expect(
          await prisma.webhookLegacyQuiescenceCertificate.findUniqueOrThrow({
            where: { id: rejected.id },
            select: { sealedAt: true, recoveryCount: true, childCount: true },
          }),
        ).toEqual({ sealedAt: null, recoveryCount: 0, childCount: 0 });
      }
    },
  );

  it('rejects missing stop roles, ordinary online writers and a newly configured recognizable command', async () => {
    const { candidate, chatId } = await fixture();
    const proof = attestation(buildLegacyRecoveryPreviewDigest([candidate], []));
    await expect(
      createLegacyColdCertificate(prisma, {
        ...proof,
        roleSnapshots: proof.roleSnapshots.slice(1),
      }),
    ).rejects.toThrow('attestation');
    delete process.env.MAXIM_LEGACY_RECOVERY_OFFLINE;
    await expect(createLegacyColdCertificate(prisma, proof)).rejects.toThrow('offline');
    expect(
      await inspectLegacyRecoveryCandidate(prisma, candidate.owner.id, ['major-1']),
    ).not.toBeNull();
    process.env.MAXIM_LEGACY_RECOVERY_OFFLINE = '1';
    await prisma.chatSettings.update({
      where: { chatId },
      data: { adminOpenChatCommandName: 'Ordinary original source' },
    });
    expect(
      await inspectLegacyRecoveryCandidate(prisma, candidate.owner.id, ['major-1']),
    ).toBeNull();
  });

  it('installs and seals atomically, leaves failed empty certificates retryable, and accepts an exact repeated seal', async () => {
    const { candidate, chatId } = await fixture();
    const malformed = {
      jobKey: `invalid-${randomUUID()}`,
      queueName: '',
      jobPayloadDigest: 'd'.repeat(64),
      chatId,
    };
    const rejected = await certificate(candidate, [malformed]);
    await expect(
      installAndSealLegacyRecoveryBatch(prisma, rejected.cert.id, [candidate], [malformed]),
    ).rejects.toThrow('malformed');
    expect(await holds.isUpdateHeld(candidate.owner.normalizedPayload as never)).toBe(false);
    expect(
      (
        await prisma.webhookLegacyQuiescenceCertificate.findUniqueOrThrow({
          where: { id: rejected.cert.id },
        })
      ).recoveryCount,
    ).toBe(0);
    const fresh = await certificate(candidate);
    const installed = await installAndSealLegacyRecoveryBatch(
      prisma,
      fresh.cert.id,
      [candidate],
      [],
    );
    const sealed = await prisma.webhookLegacyQuiescenceCertificate.findUniqueOrThrow({
      where: { id: fresh.cert.id },
    });
    expect(sealed.sealedAt).not.toBeNull();
    await sealLegacyColdCertificate(prisma, fresh.cert.id, {
      ...installed,
      previewSha256: fresh.previewSha256,
    });
    expect(
      (
        await prisma.webhookLegacyQuiescenceCertificate.findUniqueOrThrow({
          where: { id: fresh.cert.id },
        })
      ).sealedAt,
    ).toEqual(sealed.sealedAt);
  });

  it('bounds exact hold and private CHAT status probes with 12000 unrelated permanent hold rows', async () => {
    const { candidate, update } = await fixture();
    const { cert } = await certificate(candidate);
    const prefix = `plan-${randomUUID()}`;
    // FLAG: Disposable unsealed hold history measures reader probes only. It does not
    // represent a reviewed production installation or authorize any order release.
    await prisma.$executeRaw(Prisma.sql`
      INSERT INTO webhook_legacy_recoveries
        (id, semantic_key, owner_webhook_event_id, claim_id, chat_id, message_id, user_id, source_at,
         raw_payload_digest, normalized_payload_digest, owner_snapshot, claim_snapshot, settings_snapshot, certificate_id)
      SELECT ${prefix} || g, ${prefix} || ':semantic:' || g, ${prefix} || ':owner:' || g,
        ${prefix} || ':claim:' || g, ${prefix} || ':chat:' || g, ${prefix} || ':message:' || g,
        ${prefix} || ':user:' || g, CURRENT_TIMESTAMP, ${'d'.repeat(64)}, ${'e'.repeat(64)}, '{}'::jsonb,
        '{}'::jsonb, '{}'::jsonb, ${cert.id} FROM generate_series(1, 12000) g
    `);
    await prisma.$executeRaw`ANALYZE webhook_legacy_recoveries`;
    const independent = structuredClone(update);
    independent.message!.messageId = randomUUID();
    independent.message!.senderId = randomUUID();
    const event = await prisma.webhookEvent.create({
      data: {
        dedupKey: randomUUID(),
        semanticKey: buildWebhookSemanticEventKey(independent),
        normalizedPayload: independent as unknown as Prisma.InputJsonValue,
        rawPayload: {},
      },
    });
    receipts.push(event.id);
    type Plan = {
      'Node Type': string;
      'Relation Name'?: string;
      'Actual Rows'?: number;
      'Actual Loops'?: number;
      Plans?: Plan[];
    };
    const rows = await prisma.$queryRaw<Array<{ 'QUERY PLAN': Array<{ Plan: Plan }> }>>(Prisma.sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT event.id FROM webhook_events event
      WHERE event.id = ${event.id} AND NOT ${legacyOrderReleasedSql('event')}
    `);
    const nodes: Plan[] = [];
    const visit = (node: Plan) => {
      nodes.push(node);
      for (const child of node.Plans ?? []) visit(child);
    };
    visit(rows[0]!['QUERY PLAN'][0]!.Plan);
    const probes = nodes.filter(
      (node) =>
        node['Relation Name'] === 'webhook_legacy_recoveries' && (node['Actual Loops'] ?? 0) > 0,
    );
    expect(probes).toHaveLength(0);
    for (const probe of probes) {
      expect(probe['Node Type']).toMatch(/Index/);
      expect(probe['Actual Rows']).toBeLessThanOrEqual(1);
      expect(probe['Actual Loops']).toBe(1);
    }

    let metadataQuery: Prisma.Sql | undefined;
    const metadataClient = {
      $queryRaw: (query: Prisma.Sql) => {
        metadataQuery = query;
        return prisma.$queryRaw(query);
      },
    };
    const summaryProbes: Plan[] = [];
    for (const [chatId, expected] of [
      [candidate.source.chatId, false],
      [`${prefix}:chat:1`, true],
    ] as const) {
      expect(await holds.hasChatHolds(chatId, metadataClient as never)).toBe(expected);
      const summaryPlan = await prisma.$queryRaw<Array<{ 'QUERY PLAN': Array<{ Plan: Plan }> }>>(
        Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${metadataQuery!}`,
      );
      const nodesBefore = nodes.length;
      visit(summaryPlan[0]!['QUERY PLAN'][0]!.Plan);
      const exactProbes = nodes
        .slice(nodesBefore)
        .filter(
          (node) =>
            node['Relation Name'] === 'webhook_legacy_recoveries' &&
            (node['Actual Loops'] ?? 0) > 0,
        );
      expect(exactProbes).toHaveLength(1);
      expect(exactProbes[0]!['Node Type']).toMatch(/Index/);
      expect(exactProbes[0]!['Actual Rows']).toBe(expected ? 1 : 0);
      expect(exactProbes[0]!['Actual Loops']).toBe(1);
      summaryProbes.push(...exactProbes);
    }
    process.stdout.write(
      `LEGACY_HOLD_NATIVE_EXPLAIN ${JSON.stringify({ history: 12000, probes: probes.length, rows: probes.map((node) => node['Actual Rows']), loops: probes.map((node) => node['Actual Loops']), privateChatStatusRows: summaryProbes.map((node) => node['Actual Rows']) })}\n`,
    );
  });

  it('refuses oversized original payloads before loading their bodies into the cold preview', async () => {
    const { candidate } = await fixture();
    await prisma.webhookEvent.update({
      where: { id: candidate.owner.id },
      data: { rawPayload: { oversized: 'x'.repeat(300_000) } },
    });
    expect(
      await inspectLegacyRecoveryCandidate(prisma, candidate.owner.id, ['major-1']),
    ).toBeNull();
  });

  it('restores the failed-retention planner setting on the same connection after commit and rollback', async () => {
    const single = createPrismaClient(databaseUrl, { max: 1, statement_timeout: 7_000 });
    const retention = Object.assign(Object.create(WebhookOutboxService.prototype), {
      prisma: single,
      webhookRetentionCursors: new Map(),
    }) as ReturnType<typeof outbox>;
    const inspectSession = () => single.$queryRaw<
      Array<{
        pid: number;
        incrementalSort: string;
        statementTimeout: string;
      }>
    >`SELECT pg_backend_pid() AS pid,
      current_setting('enable_incremental_sort') AS "incrementalSort",
      current_setting('statement_timeout') AS "statementTimeout"`;
    try {
      const before = await inspectSession();
      expect(before[0]!.incrementalSort).toBe('on');
      expect(before[0]!.statementTimeout).toBe('7s');
      expect(await retention.deleteTerminalFailedWebhookBatch(new Date(0))).toEqual({
        removed: 0,
        scanned: 0,
      });
      expect(await inspectSession()).toEqual(before);
      const originalQuery = single.$queryRaw.bind(single);
      const injectedFailure = jest
        .spyOn(single, '$queryRaw')
        .mockImplementation(() => originalQuery(Prisma.sql`SELECT 1 / 0`));
      try {
        await expect(retention.deleteTerminalFailedWebhookBatch(new Date(0))).rejects.toThrow(
          'division by zero',
        );
      } finally {
        injectedFailure.mockRestore();
      }
      expect(await inspectSession()).toEqual(before);
    } finally {
      await single.$disconnect();
    }
  });

  it.each(['first', 'cursor'] as const)(
    'retains marker-only bodies without positive receipt authority in bounded pages (%s)',
    async (page) => {
      const { candidate, update, chatId } = await fixture();
      const { cert } = await certificate(candidate);
      await installAndSealLegacyRecoveryBatch(prisma, cert.id, [candidate], []);
      const certificateRow = await prisma.webhookLegacyQuiescenceCertificate.findUniqueOrThrow({
        where: { id: cert.id },
      });
      const bornAfterSeal = new Date(certificateRow.sealedAt!.getTime() + 1);
      // FLAG: Varied older receipt times reproduce the competing incremental-sort plan;
      // the retained peer group below must remain bounded with and without a page cursor.
      const noisePrefix = `plan-noise-${randomUUID()}`;
      receipts.push(...Array.from({ length: 5000 }, (_, index) => `${noisePrefix}-${index + 1}`));
      await prisma.$executeRaw(Prisma.sql`
      INSERT INTO webhook_events (id, dedup_key, semantic_key, status, raw_payload, normalized_payload, error_message, created_at)
      SELECT ${noisePrefix} || '-' || g, ${noisePrefix} || ':dedup:' || g, ${noisePrefix} || ':semantic:' || g,
        'FAILED'::"WebhookStatus", '{}'::jsonb, '{}'::jsonb,
        'WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINED:UNKNOWN_PLAN_HISTORY',
        ${bornAfterSeal}::timestamp - g * INTERVAL '1 millisecond' - INTERVAL '2 seconds'
      FROM generate_series(1, 5000) g
    `);
      const prefix = `late-retain-${randomUUID()}`;
      const ids = Array.from({ length: 12000 }, (_, index) => `${prefix}-${index + 1}`);
      receipts.push(...ids);
      // FLAG: Isolated post-seal declined delivery history, never execution success.
      await prisma.$executeRaw(Prisma.sql`
      INSERT INTO webhook_events (id, dedup_key, semantic_key, status, raw_payload, normalized_payload, error_message, created_at)
      SELECT ${prefix} || '-' || g, ${prefix} || ':dedup:' || g, ${candidate.owner.semanticKey},
        'FAILED'::"WebhookStatus", '{}'::jsonb, ${JSON.stringify(update)}::jsonb, ${WEBHOOK_LEGACY_HELD_MARKER}, ${bornAfterSeal}
      FROM generate_series(1, 12000) g
    `);
      const protectedRows = [];
      for (const kind of [
        'pre-seal',
        'pre-seal-empty',
        'leased',
        'started',
        'unknown',
        'ambiguous',
        'quarantined',
      ]) {
        const event = await prisma.webhookEvent.create({
          data: {
            dedupKey: randomUUID(),
            semanticKey: candidate.owner.semanticKey,
            status: kind === 'pre-seal-empty' ? 'QUEUED' : 'FAILED',
            rawPayload: {},
            normalizedPayload: update as unknown as Prisma.InputJsonValue,
            errorMessage:
              kind === 'pre-seal-empty'
                ? null
                : kind === 'unknown'
                  ? 'WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINED:UNKNOWN_ACTION'
                  : kind === 'ambiguous'
                    ? 'Remote action outcome ambiguous'
                    : kind === 'pre-seal'
                      ? 'WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINED:PRE_SEAL_UNKNOWN'
                      : WEBHOOK_LEGACY_HELD_MARKER,
            ...(kind === 'quarantined'
              ? { timeoutQuarantineExpiresAt: new Date(Date.now() + 60_000) }
              : {}),
            ...(kind === 'pre-seal-empty'
              ? { nextEnqueueAt: new Date(Date.now() + 60_000), queueName: 'moderation' }
              : {}),
            createdAt: kind.startsWith('pre-seal') ? certificateRow.sealedAt! : bornAfterSeal,
          },
        });
        receipts.push(event.id);
        protectedRows.push(event);
        if (kind === 'leased' || kind === 'started')
          await prisma.webhookExecutionClaim.create({
            data: {
              kind: 'EXECUTION',
              semanticKey: randomUUID(),
              webhookEventId: event.id,
              enforced: true,
              ...(kind === 'leased'
                ? {
                    leaseToken: 'retained-live-lease',
                    leaseExpiresAt: new Date(Date.now() + 60_000),
                  }
                : { businessStartedAt: new Date() }),
            },
          });
        expect(await holds.settleHeldReceipt(event.id, update)).toBe(false);
        expect(await prisma.webhookEvent.findUnique({ where: { id: event.id } })).toEqual(event);
      }
      await prisma.$executeRaw`ANALYZE webhook_events`;
      const reader = outbox();
      const retentionStart = { createdAt: certificateRow.sealedAt!, id: '' };
      reader.webhookRetentionCursors = new Map(
        page === 'cursor' ? [['failed', retentionStart]] : [],
      );
      const capture = jest.spyOn(prisma, '$queryRaw');
      const first = await reader.deleteTerminalFailedWebhookBatch(new Date(Date.now() + 60_000));
      const query = capture.mock.calls[0]![0] as Prisma.Sql;
      capture.mockRestore();
      expect(first.scanned).toBe(500);
      expect(first.removed).toBe(0);
      type Plan = {
        'Node Type': string;
        'Relation Name'?: string;
        'Index Name'?: string;
        'Actual Rows'?: number;
        'Actual Loops'?: number;
        'Rows Removed by Filter'?: number;
        Plans?: Plan[];
      };
      let plan: Array<{ 'QUERY PLAN': Array<{ Plan: Plan }> }> = [];
      const rollback = new Error(`isolated-retention-explain-${randomUUID()}`);
      try {
        await prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SET LOCAL enable_incremental_sort = off`;
          plan = await tx.$queryRaw(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`);
          throw rollback;
        });
      } catch (error) {
        if (error !== rollback) throw error;
      }
      const nodes: Plan[] = [];
      const visit = (node: Plan) => {
        nodes.push(node);
        for (const child of node.Plans ?? []) visit(child);
      };
      visit(plan[0]!['QUERY PLAN'][0]!.Plan);
      const source = nodes.find(
        (node) =>
          node['Relation Name'] === 'webhook_events' &&
          node['Node Type'].includes('Index') &&
          node['Index Name'] === 'webhook_events_status_created_at_id_idx' &&
          (node['Actual Rows'] ?? 0) === 500,
      );
      expect(source).toBeDefined();
      const sourceRows =
        (source!['Actual Rows']! + (source!['Rows Removed by Filter'] ?? 0)) *
        source!['Actual Loops']!;
      expect(sourceRows).toBeLessThanOrEqual(500);
      expect(nodes.some((node) => node['Relation Name'] === 'max_action_ledger')).toBe(false);
      for (const node of nodes.filter(
        (entry) =>
          entry['Relation Name'] === 'webhook_legacy_recoveries' &&
          (entry['Actual Loops'] ?? 0) > 0,
      )) {
        expect(node['Node Type']).toMatch(/Index/);
        expect(node['Actual Rows']).toBeLessThanOrEqual(1);
        expect(node['Actual Loops']).toBeLessThanOrEqual(500);
      }
      // FLAG: Bound source reads before row locking. SKIP LOCKED must not bypass the
      // finite ID page and scan the rest of a busy retained-history catalog.
      reader.webhookRetentionCursors.clear();
      if (page === 'cursor') reader.webhookRetentionCursors.set('failed', retentionStart);
      let releaseLocks!: () => void;
      const locksReleased = new Promise<void>((resolve) => {
        releaseLocks = resolve;
      });
      let signalLocked!: () => void;
      let failLocked!: (error: unknown) => void;
      const rowsLocked = new Promise<void>((resolve, reject) => {
        signalLocked = resolve;
        failLocked = reject;
      });
      const lockedTask = prisma
        .$transaction(
          async (tx) => {
            await tx.$queryRaw(Prisma.sql`
            SELECT id FROM webhook_events WHERE status = 'FAILED'::"WebhookStatus"
              ${page === 'cursor' ? Prisma.sql`AND (created_at, id) > (${retentionStart.createdAt}, ${retentionStart.id})` : Prisma.empty}
              AND created_at < ${new Date(Date.now() + 60_000)}
            ORDER BY created_at, id LIMIT 600 FOR UPDATE`);
            signalLocked();
            await locksReleased;
          },
          { timeout: 15_000 },
        )
        .catch((error: unknown) => {
          failLocked(error);
          throw error;
        });
      let lockedSourceRows = 0;
      try {
        await rowsLocked;
        const lockedCapture = jest.spyOn(prisma, '$queryRaw');
        let lockedQuery: Prisma.Sql;
        try {
          expect(
            await reader.deleteTerminalFailedWebhookBatch(new Date(Date.now() + 60_000)),
          ).toEqual({ removed: 0, scanned: 500 });
          expect(reader.webhookRetentionCursors.get('failed')).toEqual({
            createdAt: expect.any(Date),
            id: expect.any(String),
          });
          lockedQuery = lockedCapture.mock.calls[0]![0] as Prisma.Sql;
        } finally {
          lockedCapture.mockRestore();
        }
        const [, lockedPlan] = await prisma.$transaction([
          prisma.$executeRaw`SET LOCAL enable_incremental_sort = off`,
          prisma.$queryRaw<Array<{ 'QUERY PLAN': Array<{ Plan: Plan }> }>>(
            Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${lockedQuery!}`,
          ),
        ]);
        const lockedNodes: Plan[] = [];
        const visitLocked = (node: Plan) => {
          lockedNodes.push(node);
          for (const child of node.Plans ?? []) visitLocked(child);
        };
        visitLocked(lockedPlan[0]!['QUERY PLAN'][0]!.Plan);
        const lockedSource = lockedNodes.find(
          (node) =>
            node['Relation Name'] === 'webhook_events' &&
            node['Node Type'].includes('Index') &&
            node['Index Name'] === 'webhook_events_status_created_at_id_idx' &&
            (node['Actual Rows'] ?? 0) === 500,
        );
        expect(lockedSource).toBeDefined();
        lockedSourceRows =
          (lockedSource!['Actual Rows']! + (lockedSource!['Rows Removed by Filter'] ?? 0)) *
          lockedSource!['Actual Loops']!;
        expect(lockedSourceRows).toBeLessThanOrEqual(500);
      } finally {
        releaseLocks();
        await lockedTask;
      }
      for (let batch = 0; batch < 35; batch++)
        await reader.deleteTerminalFailedWebhookBatch(new Date(Date.now() + 60_000));
      expect(await prisma.webhookEvent.count({ where: { id: { in: ids } } })).toBe(12000);
      for (const event of protectedRows)
        expect(await prisma.webhookEvent.findUnique({ where: { id: event.id } })).toEqual(event);
      expect(await prisma.webhookEvent.findUnique({ where: { id: candidate.owner.id } })).toEqual({
        ...candidate.owner,
        legacyDispositionId: expect.any(String),
        legacyDispositionReceiptId: candidate.owner.id,
      });
      expect(await holds.isMessageHeld(chatId, candidate.source.messageId)).toBe(true);
      expect(await holds.isGlobalUserHeld(candidate.source.userId)).toBe(true);
      process.stdout.write(
        `LEGACY_HELD_RETENTION_NATIVE_EXPLAIN ${JSON.stringify({ page, history: 12000, variedHistory: 5000, sourceRows, lockedSourceRows, batch: first.scanned, maxActionProbes: 0 })}\n`,
      );
    },
  );

  it('holds the final SQL business-start and validates indexed order-release predicates', async () => {
    const { candidate } = await fixture();
    const { cert, previewSha256 } = await certificate(candidate);
    const counts = await installLegacyRecoveryBatch(prisma, cert.id, [candidate], []);
    const marker = await prisma.$queryRaw<Array<{ held: boolean; released: boolean }>>(
      Prisma.sql`SELECT ${legacyUpdateHeldSql('event')} AS held, ${legacyOrderReleasedSql('event')} AS released FROM webhook_events event WHERE event.id = ${candidate.owner.id}`,
    );
    expect(marker[0]).toEqual({ held: true, released: false });
    await sealLegacyColdCertificate(prisma, cert.id, { ...counts, previewSha256 });
    const plan = await prisma.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(
      Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT event.id FROM webhook_events event WHERE event.id = ${candidate.owner.id} AND NOT ${legacyOrderReleasedSql('event')}`,
    );
    expect(plan).toHaveLength(1);
    const update = structuredClone(
      candidate.owner.normalizedPayload,
    ) as unknown as import('@maxim/contracts').MaxUpdate;
    update.message!.messageId = randomUUID();
    update.updateId = randomUUID();
    const event = await prisma.webhookEvent.create({
      data: {
        dedupKey: randomUUID(),
        semanticKey: buildWebhookSemanticEventKey(update),
        normalizedPayload: update as unknown as Prisma.InputJsonValue,
        rawPayload: {},
      },
    });
    receipts.push(event.id);
    const claim = await prisma.webhookExecutionClaim.create({
      data: {
        kind: 'EXECUTION',
        semanticKey: event.semanticKey!,
        webhookEventId: event.id,
        status: 'READY',
        preparedAt: new Date(),
        enforced: true,
        leaseToken: 'late',
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const result = await prisma.$transaction((tx) =>
      WebhookCanonicalExecutionService.transitionLiveUnstartedOwnerWithClient(tx, {
        claimId: claim.id,
        webhookEventId: event.id,
        semanticKey: claim.semanticKey,
        leaseToken: 'late',
        executionBotId: 'major-9',
        executionDeadlineAt: null,
        enforced: true,
        phase: 'start',
      }),
    );
    expect(result).toBe('deferred');
    expect(
      (await prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: claim.id } }))
        .businessStartedAt,
    ).toBeNull();
  });
});
