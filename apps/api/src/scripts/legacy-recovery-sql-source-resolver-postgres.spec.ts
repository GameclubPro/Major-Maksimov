import { randomUUID } from 'node:crypto';
import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';
import { buildCommercialOcrJobId } from '../moderation/commercial-ocr/commercial-ocr.queue';
import { buildPhotoDuplicateJobId } from '../moderation/photo-duplicate/photo-duplicate.queue';
import {
  buildMessageDuplicateJobId,
  MESSAGE_DUPLICATE_JOB_VERSION,
  type MessageDuplicateJob,
} from '../moderation/message-duplicate/message-duplicate.queue';
import { legacySnapshotDigest } from '../webhook/webhook-legacy-source';
import { buildWebhookSemanticEventKey } from '../webhook/webhook-semantic-event-key';
import { WebhookParser } from '../webhook/webhook.parser';
import {
  resolveLegacyRecoverySqlSource,
  type LegacyRecoverySqlSourceInput,
  type LegacyRecoverySqlSourceScope,
} from './legacy-recovery-sql-source-resolver';
const url = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const native = url ? describe : describe.skip;
const allowance = () => ({
  pages: 8,
  rows: 8,
  probes: 8,
  bytes: 32 * 1024 * 1024,
  deadlineAtMs: Date.now() + 30_000,
});
const selected: LegacyRecoverySqlSourceScope[] = [
  {
    chatId: '-selected',
    messageId: 'selected-message',
    userId: 'selected-user',
    sourceAt: new Date('2026-01-01T00:00:00.000Z'),
  },
];
native('exact queue source resolver on PostgreSQL', () => {
  jest.setTimeout(40_000);
  let db: PrismaClient, reader: PrismaClient, setup: PrismaClient;
  const schema = `source_resolver_${randomUUID().replaceAll('-', '')}`;
  const historyPrefix = `resolver-history-${randomUUID()}`;
  const owned: string[] = [];
  beforeAll(async () => {
    const parsed = new URL(url);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
      !parsed.pathname.includes('race_test')
    )
      throw new Error('Disposable local database required');
    setup = createPrismaClient(url, {
      max: 1,
      statement_timeout: 5000,
      options: '-c timezone=UTC',
    });
    // FLAG: This planner fixture owns its physical table and statistics. Earlier
    // suites must not donate heap/index churn to the exact PK admission assertion.
    await setup.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
    // Prisma qualifies enum parameter casts with its configured schema. A domain
    // preserves the migrated enum while the cloned column keeps its original type.
    await setup.$executeRawUnsafe(
      `CREATE DOMAIN "${schema}"."WebhookStatus" AS public."WebhookStatus"`,
    );
    await setup.$executeRawUnsafe(
      `CREATE TABLE "${schema}".webhook_events (LIKE public.webhook_events INCLUDING ALL)`,
    );
    parsed.searchParams.set('schema', schema);
    const scopedUrl = parsed.toString();
    const options = `-c timezone=UTC -c search_path=${schema},public`;
    db = createPrismaClient(scopedUrl, { max: 1, statement_timeout: 5000, options });
    reader = createPrismaClient(scopedUrl, {
      max: 1,
      statement_timeout: 5000,
      options: `${options} -c default_transaction_read_only=on`,
    });
    for (let page = 0; page < 10; page++)
      await db.webhookEvent.createMany({
        data: Array.from({ length: 1000 }, (_, i) => {
          const id = `${historyPrefix}-${page}-${i}`;
          return {
            id,
            dedupKey: id,
            botId: 'other-bot',
            status: 'PROCESSED',
            rawPayload: {},
            normalizedPayload: {},
            createdAt: new Date('2025-01-01T00:00:00Z'),
          };
        }),
      });
    await db.$executeRawUnsafe('ANALYZE webhook_events');
  });
  afterEach(async () => {
    await db.webhookEvent.deleteMany({ where: { id: { in: owned.splice(0) } } });
  });
  afterAll(async () => {
    await reader?.$disconnect();
    await db?.$disconnect();
    if (setup) {
      await setup.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await setup.$disconnect();
    }
  });
  async function fixture(
    queueName: LegacyRecoverySqlSourceInput['queueName'] = 'message-duplicates',
    userId = 'independent-user',
    media = queueName !== 'message-duplicates',
    comparison?: MessageDuplicateJob['comparison'],
  ) {
    const at = Date.now() - 10_000,
      chatId = '-ordinary-chat',
      messageId = randomUUID(),
      id = randomUUID();
    const raw = {
      update_type: 'message_created',
      timestamp: at + 100,
      message: {
        sender: { user_id: userId, name: 'Fixture', is_bot: false },
        recipient: { chat_id: chatId, chat_type: 'chat' },
        timestamp: at,
        body: {
          mid: messageId,
          text: 'Ordinary source',
          ...(media
            ? {
                attachments: [
                  {
                    type: 'image',
                    payload: { photo_id: 'photo-fixture', url: 'https://i.oneme.ru/fixture' },
                  },
                ],
              }
            : {}),
        },
      },
    };
    const normalized = new WebhookParser().parse(raw, { botId: 'major-fixture' });
    owned.push(id);
    await db.webhookEvent.create({
      data: {
        id,
        botId: 'major-fixture',
        dedupKey: id,
        rawPayload: raw,
        normalizedPayload: JSON.parse(JSON.stringify(normalized)),
        semanticKey: buildWebhookSemanticEventKey(normalized),
        createdAt: new Date(at + 1000),
      },
    });
    const common = {
      webhookEventId: id,
      chatId,
      messageId,
      sourceCreatedAt: new Date(at + 100).toISOString(),
      actionEligible: true,
      createdAt: new Date(at + 500).toISOString(),
    };
    let data: Record<string, unknown>, jobId: string;
    if (queueName === 'commercial-image-ocr') {
      const values = {
        ...common,
        sourceCreatedAt: new Date(at).toISOString(),
        eventTimestamp: new Date(at + 100).toISOString(),
        schemaVersion: 3,
        ocrVersion: 'tesseract-rus-eng-v2',
        imageCount: 1,
        sourceTag: 'commercial-image-ocr',
        commercialScanRequested: true,
        imageTextScanRequested: false,
      };
      jobId = buildCommercialOcrJobId(values);
      data = { ...values, idempotencyKey: jobId };
    } else if (queueName === 'photo-duplicates') {
      jobId = buildPhotoDuplicateJobId({ chatId, messageId });
      data = {
        ...common,
        algorithmVersion: 2,
        sourceTag: 'photo-duplicate',
        retryPolicyName: 'photo-duplicate',
        idempotencyKey: jobId,
      };
    } else {
      jobId = buildMessageDuplicateJobId(chatId, messageId, at + 100, comparison);
      data = {
        ...common,
        version: MESSAGE_DUPLICATE_JOB_VERSION,
        eventTimestampMs: at + 100,
        controlRevision: 1,
        policyRevision: 1,
        settingsDigest: 'a'.repeat(64),
        deadlineAtMs: at + 60_000,
        ...(comparison ? { comparison } : {}),
        idempotencyKey: jobId,
      };
    }
    return {
      input: { queueName, jobId, data, jobPayloadDigest: legacySnapshotDigest(data) },
      id,
      raw,
      normalized,
    };
  }
  const resolve = (input: LegacyRecoverySqlSourceInput, scopes = selected, budget = allowance()) =>
    reader.$transaction((tx) => resolveLegacyRecoverySqlSource(tx, input, scopes, budget), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  it.each([
    ['message-duplicates', undefined, false],
    ['message-duplicates', 'TEXT', false],
    ['message-duplicates', 'TEXT', true],
    ['message-duplicates', 'IMAGE', true],
    ['photo-duplicates', undefined, true],
    ['commercial-image-ocr', undefined, true],
  ] as const)(
    'proves the independent %s/%s source with media=%s using one PK despite 10k unrelated receipts',
    async (family, comparison, media) => {
      const f = await fixture(family, 'independent-user', media, comparison);
      const result = await resolve(f.input);
      expect(result.issues).toEqual([]);
      expect(result.decision).toBe('INDEPENDENT');
      expect(result.plans).toHaveLength(1);
      expect(result.plans[0]).toMatchObject({
        indexes: ['webhook_events_pkey'],
        returnedRows: 1,
        examinedRows: 1,
        probes: 1,
      });
      expect(result.cost.rows).toBe(3);
      expect(result.cost.probes).toBe(3);
      expect(result.cost.pages).toBe(4);
      expect(JSON.stringify(result)).not.toMatch(/Ordinary source|i\.oneme\.ru|photo-fixture/);
      const again = await resolve(f.input);
      expect(again.proofSha256).toBe(result.proofSha256);
    },
  );
  it('treats a selected participant in another chat as related, checking later selection entries too', async () => {
    const f = await fixture('photo-duplicates', 'selected-user');
    const result = await resolve(f.input, [
      { ...selected[0]!, userId: 'another', messageId: 'another' },
      ...selected,
    ]);
    expect(result.decision).toBe('RELATED_UNSUPPORTED');
    expect(result.source?.chatId).toBe('-ordinary-chat');
  });
  it('treats the same selected source as related even if the selected sender differs', async () => {
    const f = await fixture();
    expect(
      (
        await resolve(f.input, [
          {
            ...selected[0]!,
            chatId: String(f.input.data.chatId),
            messageId: String(f.input.data.messageId),
          },
        ])
      ).decision,
    ).toBe('RELATED_UNSUPPORTED');
  });
  it('does not use terminal status as independence evidence or bind mutable status into the proof', async () => {
    const f = await fixture('message-duplicates', 'selected-user');
    const before = await resolve(f.input);
    await db.webhookEvent.update({ where: { id: f.id }, data: { status: 'PROCESSED' } });
    const after = await resolve(f.input);
    expect(after.decision).toBe('RELATED_UNSUPPORTED');
    expect(after.proofSha256).toBe(before.proofSha256);
  });
  it.each(['null', 'sender', 'clock', 'secondary', 'bot', 'raw', 'semantic', 'oversize'] as const)(
    'denies %s source corruption without leaking bodies',
    async (fault) => {
      const f = await fixture('photo-duplicates');
      const normalized = JSON.parse(JSON.stringify(f.normalized));
      if (fault === 'null')
        await db.webhookEvent.update({
          where: { id: f.id },
          data: { normalizedPayload: Prisma.JsonNull },
        });
      if (fault === 'sender') {
        normalized.message.senderId = 'wrong';
        await db.webhookEvent.update({
          where: { id: f.id },
          data: { normalizedPayload: normalized },
        });
      }
      if (fault === 'clock') {
        normalized.message.createdAt = new Date().toISOString();
        await db.webhookEvent.update({
          where: { id: f.id },
          data: { normalizedPayload: normalized },
        });
      }
      if (fault === 'secondary') {
        const raw = { ...f.raw, secondary_webhook_event_id: 'opaque-origin' };
        normalized.raw = raw;
        await db.webhookEvent.update({
          where: { id: f.id },
          data: { rawPayload: raw, normalizedPayload: normalized },
        });
      }
      if (fault === 'bot')
        await db.webhookEvent.update({ where: { id: f.id }, data: { botId: 'wrong-bot' } });
      if (fault === 'raw')
        await db.webhookEvent.update({ where: { id: f.id }, data: { rawPayload: {} } });
      if (fault === 'semantic')
        await db.webhookEvent.update({ where: { id: f.id }, data: { semanticKey: 'wrong-key' } });
      if (fault === 'oversize') {
        const raw = JSON.parse(JSON.stringify(f.raw));
        raw.message.body.attachments[0].payload.token = 'PRIVATE'.repeat(60000);
        normalized.raw = raw;
        await db.webhookEvent.update({
          where: { id: f.id },
          data: { rawPayload: raw, normalizedPayload: normalized },
        });
      }
      const result = await resolve(f.input);
      expect(result.decision).toBe('DENY');
      expect(result.source).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
    },
  );
  it('denies missing receipts and a changed exact pointer even if the caller updates the input digest', async () => {
    const f = await fixture(),
      other = await fixture();
    const changed = { ...f.input.data, webhookEventId: other.id };
    expect(
      (
        await resolve({
          ...f.input,
          data: changed,
          jobPayloadDigest: legacySnapshotDigest(changed),
        })
      ).decision,
    ).toBe('DENY');
    await db.webhookEvent.delete({ where: { id: f.id } });
    expect((await resolve(f.input)).decision).toBe('DENY');
  });
  it('refuses insufficient budgets and a writable or non-repeatable transaction', async () => {
    const f = await fixture();
    for (const override of [
      { rows: 2 },
      { pages: 3 },
      { probes: 2 },
      { bytes: 10 },
      { deadlineAtMs: Date.now() - 1 },
    ])
      expect((await resolve(f.input, selected, { ...allowance(), ...override })).decision).toBe(
        'DENY',
      );
    expect(
      (
        await db.$transaction(
          (tx) => resolveLegacyRecoverySqlSource(tx, f.input, selected, allowance()),
          { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
        )
      ).decision,
    ).toBe('DENY');
    expect(
      (
        await reader.$transaction((tx) =>
          resolveLegacyRecoverySqlSource(tx, f.input, selected, allowance()),
        )
      ).decision,
    ).toBe('DENY');
  });
  it('keeps the same SQL snapshot when the mutable source changes during inventory', async () => {
    const f = await fixture();
    await reader.$transaction(
      async (tx) => {
        const first = await resolveLegacyRecoverySqlSource(tx, f.input, selected, allowance());
        expect(first.decision).toBe('INDEPENDENT');
        await db.webhookEvent.update({ where: { id: f.id }, data: { rawPayload: {} } });
        const second = await resolveLegacyRecoverySqlSource(tx, f.input, selected, allowance());
        expect(second.proofSha256).toBe(first.proofSha256);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 15000 },
    );
    expect((await resolve(f.input)).decision).toBe('DENY');
  });
});
