import { purgeModerationMessageSnapshots } from './moderation-message-snapshot';
import type { PrismaService } from '../prisma/prisma.service';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';
import type { EnsureModerationDeleteIntentInput } from './moderation-delete-intent.types';
import { ModerationDeleteIntentService } from './moderation-delete-intent.service';
import { withCanonicalWebhookOrigin } from './webhook-effect-origin-context';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const unused = <T>(): T =>
  new Proxy(
    {},
    {
      get: () => {
        throw new Error('Unexpected effect dependency');
      },
    },
  ) as T;
type OriginRow = {
  reasonId: string;
  sourceWebhookEventId: string;
  sourceReceivingBotId: string;
  sourceExecutionBotId: string;
  sourceEventAt: Date;
  sourceObservedAt: Date;
};

(databaseUrl ? describe : describe.skip)('native first-insert DELETE origins', () => {
  let prisma: PrismaClient, service: ModerationDeleteIntentService;
  const chats: string[] = [];
  const receipts: string[] = [];
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Disposable local race_test database required');
    prisma = createPrismaClient(databaseUrl);
    await prisma.$connect();
    service = new ModerationDeleteIntentService(
      prisma as never,
      unused(),
      unused(),
      unused(),
      new ConfigService({ MODERATION_DELETE_INTENT_MODE: 'on' }),
      unused(),
      unused(),
      unused(),
      unused(),
    );
  });
  afterAll(async () => {
    if (!prisma) return;
    await prisma.chat.deleteMany({ where: { id: { in: chats } } });
    await prisma.webhookEvent.deleteMany({ where: { id: { in: receipts } } });
    await prisma.$disconnect();
  });
  async function fixture() {
    const chatId = `origin-${randomUUID()}`,
      sourceEventAt = new Date(Date.now() - 5_000);
    chats.push(chatId);
    await prisma.chat.create({ data: { id: chatId, title: 'Origin test' } });
    const input: EnsureModerationDeleteIntentInput = {
      chatId,
      messageId: 'message',
      reasonKey: 'origin-test',
      ruleCode: 'ORIGIN_TEST',
      sourceMessageAt: sourceEventAt,
      originBotId: 'execution',
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      executeAt: new Date(Date.now() + 10_000),
      retryUntilAt: new Date(Date.now() + 60_000),
    };
    const scope = (receipt: string) => ({
      webhookEvent: { id: receipt, botId: 'receiving' },
      activeBotId: 'execution',
      update: {
        updateId: receipt,
        botId: 'receiving',
        type: 'message_edited',
        eventTimestampSource: 'payload' as const,
        message: {
          chatId,
          messageId: 'message',
          senderId: 'user',
          text: '',
          createdAt: '2020-01-01T00:00:00.000Z',
        },
        raw: { timestamp: sourceEventAt.toISOString() },
      },
    });
    const ensure = (receipt: string, value = input) =>
      withCanonicalWebhookOrigin(scope(receipt), () =>
        service.ensureIntent(value, { enqueue: false }),
      );
    const origins = () => prisma.$queryRaw<OriginRow[]>`SELECT origin.reason_id AS "reasonId",
      origin.source_webhook_event_id AS "sourceWebhookEventId", origin.source_receiving_bot_id AS "sourceReceivingBotId",
      origin.source_execution_bot_id AS "sourceExecutionBotId", origin.source_event_at AS "sourceEventAt",
      origin.source_observed_at AS "sourceObservedAt" FROM moderation_delete_reason_origins origin
      JOIN moderation_delete_intent_reasons reason ON reason.id = origin.reason_id
      JOIN moderation_delete_intents intent ON intent.id = reason.intent_id WHERE intent.chat_id = ${chatId}`;
    return { chatId, input, scope, ensure, origins, sourceEventAt };
  }

  it('captures exact text atomically, keeps its original revision and purges only content', async () => {
    const s = await fixture();
    const receipt = `snapshot-${randomUUID()}`;
    receipts.push(receipt);
    const scope = s.scope(receipt);
    scope.update.message.text = 'Original paragraph.\nSecond paragraph.';
    await prisma.webhookEvent.create({
      data: {
        id: receipt,
        dedupKey: receipt,
        botId: 'receiving',
        rawPayload: {},
        normalizedPayload: scope.update,
      },
    });
    const input = { ...s.input, subjectUserId: 'user' };
    const result = await withCanonicalWebhookOrigin(scope, () =>
      service.ensureIntent(input, { enqueue: false }),
    );
    const reason = await prisma.moderationDeleteIntentReason.findFirstOrThrow({
      where: { intentId: result.intentId! },
    });
    const before = await prisma.moderationMessageSnapshot.findUniqueOrThrow({
      where: { reasonId: reason.id },
    });
    expect(before.content).toEqual({
      text: scope.update.message.text,
      truncated: false,
      attachments: [],
    });
    expect(before.expiresAt.getTime() - before.sourceAt.getTime()).toBe(14 * 86400_000);
    scope.update.message.text = 'Later edited text';
    await prisma.webhookEvent.update({
      where: { id: receipt },
      data: { normalizedPayload: scope.update },
    });
    await withCanonicalWebhookOrigin(scope, () => service.ensureIntent(input, { enqueue: false }));
    expect(
      await prisma.moderationMessageSnapshot.findUnique({ where: { reasonId: reason.id } }),
    ).toEqual(before);
    await prisma.webhookEvent.delete({ where: { id: receipt } });
    expect(
      (await prisma.moderationMessageSnapshot.findUniqueOrThrow({ where: { reasonId: reason.id } }))
        .content,
    ).toEqual(before.content);
    await prisma.moderationMessageSnapshot.update({
      where: { reasonId: reason.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(
      await purgeModerationMessageSnapshots(prisma as unknown as PrismaService),
    ).toBeGreaterThanOrEqual(1);
    const after = await prisma.moderationMessageSnapshot.findUniqueOrThrow({
      where: { reasonId: reason.id },
    });
    expect(after.content).toBeNull();
    expect(after.purgedAt).not.toBeNull();
    expect(
      (await prisma.moderationDeleteIntent.findUniqueOrThrow({ where: { id: result.intentId! } }))
        .status,
    ).toBe('PENDING');
  });

  it('does not copy content from a receipt with another message or author', async () => {
    const s = await fixture();
    const receipt = `mismatch-${randomUUID()}`;
    receipts.push(receipt);
    const scope = s.scope(receipt);
    await prisma.webhookEvent.create({
      data: {
        id: receipt,
        dedupKey: receipt,
        botId: 'receiving',
        rawPayload: {},
        normalizedPayload: {
          ...scope.update,
          message: { ...scope.update.message, messageId: 'other', text: 'private' },
        },
      },
    });
    const result = await withCanonicalWebhookOrigin(scope, () =>
      service.ensureIntent({ ...s.input, subjectUserId: 'user' }, { enqueue: false }),
    );
    const reason = await prisma.moderationDeleteIntentReason.findFirstOrThrow({
      where: { intentId: result.intentId! },
    });
    expect(
      await prisma.moderationMessageSnapshot.findUnique({ where: { reasonId: reason.id } }),
    ).toBeNull();
  });

  it('bounds Unicode text and records only attachment kinds', async () => {
    const s = await fixture();
    const receipt = `media-${randomUUID()}`;
    receipts.push(receipt);
    const scope = s.scope(receipt);
    const text = '🙂'.repeat(16001);
    const update = {
      ...scope.update,
      message: { ...scope.update.message, text },
      raw: {
        ...scope.update.raw,
        message: {
          body: {
            attachments: Array.from({ length: 35 }, (_, index) => ({
              type: index === 0 ? 'image' : 'file',
              payload: { token: 'private-token', url: 'https://private.invalid' },
            })),
          },
        },
      },
    };
    await prisma.webhookEvent.create({
      data: {
        id: receipt,
        dedupKey: receipt,
        botId: 'receiving',
        rawPayload: {},
        normalizedPayload: update,
      },
    });
    const result = await withCanonicalWebhookOrigin(scope, () =>
      service.ensureIntent({ ...s.input, subjectUserId: 'user' }, { enqueue: false }),
    );
    const reason = await prisma.moderationDeleteIntentReason.findFirstOrThrow({
      where: { intentId: result.intentId! },
    });
    const saved = await prisma.moderationMessageSnapshot.findUniqueOrThrow({
      where: { reasonId: reason.id },
    });
    expect(saved.content).toEqual({
      text: '🙂'.repeat(16000),
      truncated: true,
      attachments: ['image', ...Array(31).fill('file')],
    });
    expect(JSON.stringify(saved.content)).not.toMatch(/private-token|private.invalid/);
  });

  it('keeps the first concurrent receipt and records a separate later reason', async () => {
    const s = await fixture();
    const results = await Promise.all([s.ensure('receipt-a'), s.ensure('receipt-b')]);
    expect(results[0].intentId).toBe(results[1].intentId);
    const first = await s.origins();
    expect(first).toHaveLength(1);
    expect(['receipt-a', 'receipt-b']).toContain(first[0]!.sourceWebhookEventId);
    expect(first[0]).toMatchObject({
      sourceReceivingBotId: 'receiving',
      sourceExecutionBotId: 'execution',
      sourceEventAt: s.sourceEventAt,
    });
    await s.ensure('later-duplicate');
    expect(await s.origins()).toEqual(first);
    await s.ensure('later-reason', { ...s.input, reasonKey: 'different' });
    expect(await s.origins()).toHaveLength(2);
  });

  it.each(['EXPIRED', 'FAILED_TERMINAL', 'AMBIGUOUS'] as const)(
    'does not backfill historical %s reasons or change their schedule/fence',
    async (status) => {
      const s = await fixture();
      const original = await service.ensureIntent(s.input, { enqueue: false });
      const saved = await prisma.moderationDeleteIntent.update({
        where: { id: original.intentId! },
        data: {
          status,
          ...(status === 'AMBIGUOUS'
            ? { deleteDispatchStartedAt: new Date(), deleteDispatchStartedBotId: 'execution' }
            : {}),
        },
      });
      await s.ensure('new-source', {
        ...s.input,
        executeAt: new Date(),
        retryUntilAt: new Date(Date.now() + 600_000),
      });
      const after = await prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { id: original.intentId! },
      });
      for (const key of [
        'status',
        'executeAt',
        'nextAttemptAt',
        'retryUntilAt',
        'deleteDispatchStartedAt',
        'deleteDispatchStartedBotId',
        'attemptCount',
      ] as const)
        expect(after[key]).toEqual(saved[key]);
      expect(await s.origins()).toEqual([]);
    },
  );

  it('rolls back intent, reason and origin together', async () => {
    const s = await fixture();
    const receipt = `rollback-${randomUUID()}`;
    receipts.push(receipt);
    const scope = s.scope(receipt);
    await prisma.webhookEvent.create({
      data: {
        id: receipt,
        dedupKey: receipt,
        botId: 'receiving',
        rawPayload: {},
        normalizedPayload: scope.update,
      },
    });
    const internal = service as unknown as {
      persistIntent(
        input: EnsureModerationDeleteIntentInput,
        enqueue: boolean,
        tx: Prisma.TransactionClient,
      ): Promise<unknown>;
    };
    await expect(
      prisma.$transaction(async (tx) => {
        await withCanonicalWebhookOrigin(scope, () =>
          internal.persistIntent({ ...s.input, subjectUserId: 'user' }, false, tx),
        );
        expect(
          await tx.moderationMessageSnapshot.count({
            where: { reason: { intent: { chatId: s.chatId } } },
          }),
        ).toBe(1);
        throw new Error('abort transaction');
      }),
    ).rejects.toThrow('abort transaction');
    expect(
      await prisma.moderationDeleteIntent.findUnique({
        where: { chatId_messageId: { chatId: s.chatId, messageId: 'message' } },
      }),
    ).toBeNull();
    expect(await s.origins()).toEqual([]);
  });

  it('does not attribute another target or caller-supplied metadata to the current receipt', async () => {
    const s = await fixture();
    await s.ensure('current', {
      ...s.input,
      messageId: 'another-message',
      event: { metadata: { sourceWebhookEventId: 'forged' } },
    });
    expect(await s.origins()).toEqual([]);
  });
});
