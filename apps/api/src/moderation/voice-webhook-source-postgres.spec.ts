import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';
import { WebhookParser } from '../webhook/webhook.parser';
import { WebhookService } from '../webhook/webhook.service';
import { bindStateVoiceSource, readStateVoiceReasonKeys } from './state-voice-delete-source';
import {
  persistVoiceSource,
  purgeExpiredVoiceSources,
  type VoiceSourceInput,
} from './voice-webhook-source';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;
jest.setTimeout(30_000);

describePostgres('durable native voice creation and revocation', () => {
  let db: PrismaClient;
  const chatId = `-${Date.now()}`;
  const receiptIds: string[] = [];
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('A disposable local race_test database is required');
    db = createPrismaClient(databaseUrl, { max: 4 });
    await db.$connect();
  });
  afterEach(async () => {
    await db.moderationVoiceSource.deleteMany({ where: { chatId } });
    await db.webhookEvent.deleteMany({ where: { id: { in: receiptIds.splice(0) } } });
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  function source(): VoiceSourceInput & { kind: 'created' } {
    const at = Date.now();
    return {
      kind: 'created',
      chatId,
      messageId: randomUUID(),
      userId: '42',
      sourceAtMs: at,
      deadlineAtMs: at + 300_000,
    };
  }
  const read = (input: VoiceSourceInput) =>
    db.moderationVoiceSource.findUniqueOrThrow({
      where: { chatId_messageId: { chatId, messageId: input.messageId } },
    });
  it('survives a new client without extending source authority or rewriting identical mirrors', async () => {
    const input = source();
    await persistVoiceSource(db, input, 'first');
    const first = await read(input);
    const restarted = createPrismaClient(databaseUrl, { max: 1 });
    try {
      await persistVoiceSource(restarted, input, 'mirror');
      expect(await read(input)).toEqual(first);
    } finally {
      await restarted.$disconnect();
    }
    expect(first).toMatchObject({
      receiptId: 'first',
      sourceAt: new Date(input.sourceAtMs),
      deadlineAt: new Date(input.deadlineAtMs),
      invalidatedAt: null,
    });
  });
  it.each(['before', 'after', 'concurrent'] as const)(
    'keeps an edit/removal revocation %s creation',
    async (order) => {
      const input = source();
      const revoke = () =>
        persistVoiceSource(db, { kind: 'invalidate', chatId, messageId: input.messageId }, 'edit');
      const create = () => persistVoiceSource(db, input, 'created');
      if (order === 'before') {
        await revoke();
        await create();
      }
      if (order === 'after') {
        await create();
        await revoke();
      }
      if (order === 'concurrent') await Promise.all([create(), revoke()]);
      expect((await read(input)).invalidatedAt).toBeInstanceOf(Date);
      await create();
      expect((await read(input)).invalidatedAt).toBeInstanceOf(Date);
    },
  );
  it.each(['author', 'timestamp'] as const)(
    'invalidates conflicting mirrored %s instead of changing identity',
    async (field) => {
      const input = source();
      await persistVoiceSource(db, input, 'first');
      const conflict = {
        ...input,
        ...(field === 'author'
          ? { userId: 'other' }
          : {
              sourceAtMs: input.sourceAtMs + 1,
              deadlineAtMs: input.deadlineAtMs + 1,
            }),
      };
      await persistVoiceSource(db, conflict, 'conflict');
      expect(await read(input)).toMatchObject({
        userId: '42',
        sourceAt: new Date(input.sourceAtMs),
        receiptId: 'first',
        invalidatedAt: expect.any(Date),
      });
    },
  );
  it('never creates authority from expired or excessive-future events under the database clock', async () => {
    for (const offset of [-301_000, 10_000]) {
      const input = source();
      input.sourceAtMs += offset;
      input.deadlineAtMs += offset;
      await persistVoiceSource(db, input, 'late');
    }
    expect(await db.moderationVoiceSource.count({ where: { chatId } })).toBe(0);
  });
  it('rolls voice evidence back when its receipt transaction fails', async () => {
    const input = source();
    await expect(
      db.$transaction(async (tx) => {
        await persistVoiceSource(tx, input, 'uncommitted');
        throw new Error('receipt write failed');
      }),
    ).rejects.toThrow('receipt write failed');
    expect(await db.moderationVoiceSource.count({ where: { chatId } })).toBe(0);
  });
  it('captures the real webhook receipt atomically and observes an unprocessed unknown-time edit', async () => {
    const input = source();
    const original = new Date(input.sourceAtMs - 30_000);
    const service = new WebhookService(
      db as never,
      new ConfigService({ RAW_PAYLOAD_SAMPLE_RATE: 0 }),
      {} as never,
    );
    const raw = {
      update_type: 'message_created',
      timestamp: input.sourceAtMs,
      message: {
        sender: { user_id: '42', is_bot: false },
        recipient: { chat_id: chatId, chat_type: 'chat' },
        timestamp: original.getTime(),
        body: {
          mid: input.messageId,
          text: '',
          attachments: [{ type: 'audio', payload: { token: 'private' } }],
        },
      },
    };
    try {
      const created = await service.storeReceipt(
        new WebhookParser().parse(raw, { botId: 'bot' }),
        null,
      );
      receiptIds.push(created.webhookEventId!);
      expect((await read(input)).receiptId).toBe(created.webhookEventId);
      const identity = {
        chatId,
        messageId: input.messageId,
        subjectUserId: input.userId,
        sourceMessageAt: original,
      };
      const bound = bindStateVoiceSource(
        { ...identity, ruleCode: 'NIGHT_MODE_DELETE', reasonKey: 'night' },
        input,
      );
      const reasons = [
        { ruleCode: 'NIGHT_MODE_DELETE', reasonKey: 'night', metadata: bound.event!.metadata },
      ];
      expect(await readStateVoiceReasonKeys(db, identity, reasons)).toEqual(['night']);
      const legacyIdentity = { ...identity, sourceMessageAt: new Date(input.sourceAtMs) };
      const legacy = bindStateVoiceSource(
        { ...legacyIdentity, ruleCode: 'NIGHT_MODE_DELETE', reasonKey: 'night' },
        input,
      );
      expect(
        await readStateVoiceReasonKeys(db, legacyIdentity, [
          { ...reasons[0]!, metadata: legacy.event!.metadata },
        ]),
      ).toEqual([]);
      const duplicate = await service.storeReceipt(
        new WebhookParser().parse(raw, { botId: 'bot' }),
        null,
      );
      expect(duplicate.duplicate).toBe(true);
      raw.update_type = 'message_edited';
      Reflect.deleteProperty(raw, 'timestamp');
      Reflect.deleteProperty(raw.message, 'timestamp');
      const edited = await service.storeReceipt(
        new WebhookParser().parse(raw, { botId: 'bot' }),
        null,
      );
      receiptIds.push(edited.webhookEventId!);
      expect((await read(input)).invalidatedAt).toBeInstanceOf(Date);
      expect(await readStateVoiceReasonKeys(db, identity, reasons)).toEqual([]);
      expect(
        (await db.webhookEvent.findUniqueOrThrow({ where: { id: edited.webhookEventId! } })).status,
      ).toBe('RECEIVED');
    } finally {
      await service.onModuleDestroy();
    }
  });
  it('bounds indexed cleanup to 500 expired rows and retains live authority', async () => {
    const live = source();
    await persistVoiceSource(db, live, 'live');
    await db.moderationVoiceSource.createMany({
      data: Array.from({ length: 700 }, (_, i) => ({
        chatId,
        messageId: `expired-${i}`,
        invalidatedAt: new Date(0),
        expiresAt: new Date(1),
      })),
    });
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "moderation_voice_sources" ("chat_id", "message_id", "invalidated_at", "expires_at")
      SELECT ${chatId}, 'retained-' || n::text, clock_timestamp() AT TIME ZONE 'UTC',
        (clock_timestamp() AT TIME ZONE 'UTC') + INTERVAL '2 days'
      FROM generate_series(1, 10000) AS n
    `);
    await db.$executeRaw(Prisma.sql`ANALYZE "moderation_voice_sources"`);
    const plan = await db.$queryRaw(Prisma.sql`EXPLAIN (FORMAT JSON)
      SELECT "chat_id", "message_id" FROM "moderation_voice_sources"
      WHERE "expires_at" <= (SELECT clock_timestamp() AT TIME ZONE 'UTC')
      ORDER BY "expires_at", "chat_id", "message_id" LIMIT 500 FOR UPDATE SKIP LOCKED`);
    expect(JSON.stringify(plan)).toContain('moderation_voice_sources_expiry_idx');
    expect(JSON.stringify(plan)).toContain('Index Cond');
    expect(await purgeExpiredVoiceSources(db)).toBe(500);
    expect(await db.moderationVoiceSource.count({ where: { chatId } })).toBe(10201);
    expect((await read(live)).invalidatedAt).toBeNull();
  });
});
