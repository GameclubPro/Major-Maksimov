import { randomUUID } from 'node:crypto';
import { Prisma } from '../prisma/prisma-client';
import { ModerationRuleFollowupSourceExpiredError } from '../moderation/moderation-rule-followup-persistence';
import { MESSAGE_COUNT_QUOTA_POLICY_VERSION } from '../moderation/message-count-quota-policy';
import {
  bindMessageLimitEvidence,
  fingerprintModerationSettings,
} from '../moderation/message-limits-delete-guard.service';
import {
  createMultibotHarness,
  type MultibotHarness,
} from './webhook-multibot-fullpath.spec-support';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const describeStores = databaseUrl && redisUrl ? describe : describe.skip;
jest.setTimeout(60_000);

describeStores('native durable moderation rule continuation across bot/process changes', () => {
  let h: MultibotHarness | undefined;
  afterEach(async () => {
    jest.restoreAllMocks();
    await h?.dispose();
    h = undefined;
  });
  async function fixture(settings: Record<string, unknown> = {}, prior = 1) {
    const s = (h = await createMultibotHarness({ databaseUrl, redisUrl, bots: 9, mode: 'on' }));
    const [chatId] = await s.seedCatalog(1, { messageLimitsWarnEnabled: true, ...settings });
    if (prior)
      await s.prisma.violation.createMany({
        data: Array.from({ length: prior }, () => ({
          chatId: chatId!,
          userId: 'fixture-user',
          ruleCode: 'MESSAGE_TOO_LONG',
          score: 1,
          createdAt: new Date(Date.now() - 1000),
        })),
      });
    return { s, chatId: chatId! };
  }
  async function ready(
    s: MultibotHarness,
    chatId: string,
    suffix = 'continuation',
    sourceAgeMs = 0,
    quota?: {
      publicationId: string;
      anchorTimestampMs: number;
      decisionReplayed?: boolean;
      confirmDelete?: boolean;
    },
  ) {
    const messageId = `${suffix}-${randomUUID()}`;
    const sourceAt = new Date(Date.now() - sourceAgeMs);
    const text = 'Long harmless message with current durable source identity';
    s.messages.set(messageId, {
      sender: { user_id: 'fixture-user', is_bot: false },
      recipient: { chat_id: chatId, chat_type: 'chat' },
      timestamp: sourceAt.getTime(),
      body: {
        mid: messageId,
        text,
        ...(quota
          ? {
              media_group_id: quota.publicationId,
              attachments: [{ type: 'image', payload: { photo_id: messageId } }],
            }
          : {}),
      },
    });
    const settings = await s.prisma.chatSettings.findUniqueOrThrow({ where: { chatId } });
    const ruleCode = quota ? 'MESSAGE_COUNT_LIMIT_DELETE' : 'MESSAGE_TOO_LONG_DELETE';
    const result = await s.intents.ensureIntentWithRuleFollowup(
      {
        chatId,
        messageId,
        subjectUserId: 'fixture-user',
        sourceMessageAt: sourceAt,
        originBotId: s.bots[0]!.id,
        routingPolicy: 'delete_capable',
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        reasonKey: `${ruleCode.replace(/_DELETE$/u, '')}:violation-delete`,
        ruleCode,
        event: {
          userId: 'fixture-user',
          eventType: 'MESSAGE',
          score: 1,
          metadata: {
            ...bindMessageLimitEvidence(
              settings,
              sourceAt.getTime(),
              ruleCode,
              quota?.anchorTimestampMs,
            ),
            ...(quota
              ? {
                  quotaPolicyVersion: MESSAGE_COUNT_QUOTA_POLICY_VERSION,
                  quotaPublicationId: quota.publicationId,
                  quotaAnchorTimestampMs: quota.anchorTimestampMs,
                  quotaDecisionReplayed: quota.decisionReplayed ?? false,
                }
              : {}),
          },
        },
      },
      fingerprintModerationSettings(settings, ruleCode),
      {
        version: 1,
        updateType: 'message_created',
        originBotId: s.bots[0]!.id,
        userLabel: 'Fixture user',
        effectiveMessageLength: text.length,
        rulesPublishedUrl: null,
        rulesPublishedMessageId: null,
      },
    );
    expect(result.followupId).not.toBeNull();
    const row = await s.prisma.moderationRuleFollowup.findUniqueOrThrow({
      where: { id: result.followupId! },
    });
    if (quota?.confirmDelete === false) return row;
    expect((await s.intents.attemptIntent(row.intentId)).confirmed).toBe(true);
    expect(
      (await s.prisma.moderationRuleFollowup.findUniqueOrThrow({ where: { id: row.id } })).status,
    ).toBe('READY');
    return row;
  }

  async function quotaFixture() {
    const result = await fixture(
      {
        maxMessageLengthEnabled: false,
        messageCountLimitEnabled: true,
        messageCountLimitMessages: 2,
        messageCountLimitWindowHours: 1,
        messageLimitsBotMessageEnabled: true,
        messageLimitsWarnEnabled: true,
        messageLimitsMuteEnabled: false,
        messageLimitsBanEnabled: false,
      },
      0,
    );
    await result.s.prisma.violation.create({
      data: {
        chatId: result.chatId,
        userId: 'fixture-user',
        ruleCode: 'MESSAGE_COUNT_LIMIT',
        score: 1,
        createdAt: new Date(Date.now() - 1000),
      },
    });
    return result;
  }
  async function due(s: MultibotHarness, id: string) {
    await s.prisma.moderationRuleFollowup.update({
      where: { id },
      data: { nextAttemptAt: new Date(Date.now() - 1000), leaseExpiresAt: null, leaseToken: null },
    });
  }
  async function expectWarnOnce(s: MultibotHarness, chatId: string, messageId: string) {
    expect(await s.prisma.violation.count({ where: { chatId } })).toBe(2);
    expect(
      await s.prisma.moderationViolationMessageClaim.count({ where: { chatId, messageId } }),
    ).toBe(1);
    expect(
      await s.prisma.moderationEvent.count({ where: { chatId, messageId, action: 'WARN' } }),
    ).toBe(1);
    expect(s.effects.filter((e) => e.method === 'delete')).toHaveLength(1);
    expect(s.effects.filter((e) => e.method === 'post' && e.path === '/messages')).toHaveLength(1);
  }

  async function registration(s: MultibotHarness, chatId: string, sourceAt: Date) {
    const settings = await s.prisma.chatSettings.findUniqueOrThrow({ where: { chatId } });
    const ruleCode = 'MESSAGE_RATE_LIMIT_DELETE';
    return {
      input: {
        chatId,
        messageId: `stale-${randomUUID()}`,
        subjectUserId: 'fixture-user',
        sourceMessageAt: sourceAt,
        originBotId: s.bots[0]!.id,
        routingPolicy: 'delete_capable' as const,
        entityType: 'CHAT' as const,
        messageAuthorKind: 'user' as const,
        reasonKey: 'MESSAGE_RATE_LIMIT:violation-delete',
        ruleCode,
        retryUntilAt: new Date(sourceAt.getTime() + 300_000),
        event: {
          userId: 'fixture-user',
          eventType: 'MESSAGE' as const,
          metadata: bindMessageLimitEvidence(settings, sourceAt.getTime(), ruleCode),
        },
      },
      policy: fingerprintModerationSettings(settings, ruleCode),
      envelope: {
        version: 1 as const,
        updateType: 'message_created',
        originBotId: s.bots[0]!.id,
        userLabel: 'Fixture user',
        effectiveMessageLength: 30,
        rulesPublishedUrl: null,
        rulesPublishedMessageId: null,
      },
    };
  }

  it('claims one quota strike for concurrent album parts and a new strike when the same album ID has a new anchor', async () => {
    const { s, chatId } = await quotaFixture();
    const publicationId = `album-${randomUUID()}`;
    const anchorTimestampMs = Date.now() - 100;
    const parts = await Promise.all(
      [false, true].map((decisionReplayed, index) =>
        ready(s, chatId, `quota-part-${index}`, 0, {
          publicationId,
          anchorTimestampMs,
          decisionReplayed,
        }),
      ),
    );
    const executor = jest.spyOn(s.moderation, 'executeRuleFollowup');
    await Promise.all(parts.map((part) => s.ruleFollowups.attempt(part.id)));
    const settled = await s.prisma.moderationRuleFollowup.findMany({
      where: { id: { in: parts.map((part) => part.id) } },
    });
    expect(settled.map((part) => part.status).sort()).toEqual(['CANCELLED', 'COMPLETED']);
    const owner = settled.find((part) => part.status === 'COMPLETED')!;
    expect(owner.actionPlan).toMatchObject({ action: 'WARN', violationCount: 2 });
    expect(settled.find((part) => part.status === 'CANCELLED')!.actionPlan).toBeNull();
    expect(settled.every((part) => part.leaseToken === null && part.leaseExpiresAt === null)).toBe(
      true,
    );
    const claims = await s.prisma.moderationViolationMessageClaim.findMany({ where: { chatId } });
    expect(claims).toEqual([
      expect.objectContaining({
        dedupeKey: expect.stringMatching(/^quota-publication:v3:/u),
        messageId: owner.messageId,
        userId: 'fixture-user',
        ruleCode: 'MESSAGE_COUNT_LIMIT',
      }),
    ]);
    expect(await s.prisma.violation.count({ where: { chatId } })).toBe(2);
    expect(
      await s.prisma.moderationEvent.count({
        where: { chatId, ruleCode: 'MESSAGE_COUNT_LIMIT', action: 'WARN' },
      }),
    ).toBe(1);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(s.effects.filter((effect) => effect.method === 'delete')).toHaveLength(2);
    expect(s.effects.filter((effect) => effect.method === 'post')).toHaveLength(1);

    const nextAnchorTimestampMs = Date.now();
    expect(nextAnchorTimestampMs).toBeGreaterThan(anchorTimestampMs);
    const independent = await ready(s, chatId, 'quota-reused-album-id', 0, {
      publicationId,
      anchorTimestampMs: nextAnchorTimestampMs,
    });
    await s.ruleFollowups.attempt(independent.id);
    await s.ruleFollowups.sweep();
    expect(await s.prisma.violation.count({ where: { chatId } })).toBe(3);
    const generations = await s.prisma.moderationViolationMessageClaim.findMany({
      where: { chatId },
    });
    expect(generations).toHaveLength(2);
    expect(new Set(generations.map((claim) => claim.dedupeKey)).size).toBe(2);
    expect(executor).toHaveBeenCalledTimes(2);
    expect(s.failures).toEqual([]);
  });

  it('lets a replayed album part own the quota followup when the first exact DELETE remains unavailable', async () => {
    const { s, chatId } = await quotaFixture();
    const publicationId = `album-${randomUUID()}`;
    const anchorTimestampMs = Date.now() - 100;
    const first = await ready(s, chatId, 'quota-unavailable', 0, {
      publicationId,
      anchorTimestampMs,
      confirmDelete: false,
    });
    const source = s.max.getExactMessageRow.bind(s.max);
    const failure = Object.assign(new Error('Exact album part temporarily unavailable'), {
      response: { status: 503 },
    });
    const unavailable = jest
      .spyOn(s.max, 'getExactMessageRow')
      .mockImplementation((chat, mid, options) =>
        mid === first.messageId ? Promise.reject(failure) : source(chat, mid, options),
      );
    await expect(
      s.intents.attemptIntent(first.intentId, { deferGuardFailure: true }),
    ).resolves.toMatchObject({ confirmed: false, status: 'RETRYABLE' });
    expect(await s.prisma.moderationViolationMessageClaim.count({ where: { chatId } })).toBe(0);
    expect(await s.prisma.violation.count({ where: { chatId } })).toBe(1);
    unavailable.mockRestore();
    const second = await ready(s, chatId, 'quota-replayed', 0, {
      publicationId,
      anchorTimestampMs,
      decisionReplayed: true,
    });
    await s.ruleFollowups.attempt(second.id);
    expect(
      await s.prisma.moderationRuleFollowup.findUniqueOrThrow({ where: { id: second.id } }),
    ).toMatchObject({
      status: 'COMPLETED',
      actionPlan: expect.objectContaining({ action: 'WARN' }),
    });
    expect(
      await s.prisma.moderationRuleFollowup.findUniqueOrThrow({ where: { id: first.id } }),
    ).toMatchObject({ status: 'WAITING_DELETE', actionPlan: null });
    expect(await s.prisma.violation.count({ where: { chatId } })).toBe(2);
    expect(
      await s.prisma.moderationViolationMessageClaim.findFirstOrThrow({ where: { chatId } }),
    ).toMatchObject({ messageId: second.messageId });
    expect(s.messages.has(first.messageId)).toBe(true);
    expect(s.messages.has(second.messageId)).toBe(false);
    expect(s.effects.filter((effect) => effect.method === 'post')).toHaveLength(1);
    expect(s.failures).toEqual([]);
  });

  it('denies old or malformed stored quota authority before creating an album strike or plan', async () => {
    const { s, chatId } = await quotaFixture();
    const patches = [
      { quotaPolicyVersion: 2 },
      { quotaPublicationId: ' ' },
      { quotaAnchorTimestampMs: Date.now() + 60_000 },
      { quotaAnchorTimestampMs: Date.now() - 360_000 },
      { messageLimitPolicySha256: '0'.repeat(64) },
    ];
    const deletedMessageIds: string[] = [];
    for (const [index, patch] of patches.entries()) {
      const row = await ready(s, chatId, `quota-invalid-${index}`, 0, {
        publicationId: `album-${randomUUID()}`,
        anchorTimestampMs: Date.now() - 100,
      });
      deletedMessageIds.push(row.messageId);
      const reason = await s.prisma.moderationDeleteIntentReason.findUniqueOrThrow({
        where: { intentId_reasonKey: { intentId: row.intentId, reasonKey: row.reasonKey } },
      });
      await s.prisma.moderationDeleteIntentReason.update({
        where: { id: reason.id },
        data: { metadata: { ...(reason.metadata as Prisma.JsonObject), ...patch } },
      });
      await s.ruleFollowups.attempt(row.id);
      expect(
        await s.prisma.moderationRuleFollowup.findUniqueOrThrow({ where: { id: row.id } }),
      ).toMatchObject({ status: 'CANCELLED', actionPlan: null });
    }
    expect(await s.prisma.violation.count({ where: { chatId } })).toBe(1);
    expect(await s.prisma.moderationViolationMessageClaim.count({ where: { chatId } })).toBe(0);
    const events = await s.prisma.moderationEvent.findMany({
      where: { chatId },
      select: { messageId: true, eventType: true, ruleCode: true, action: true, operator: true },
    });
    expect(events).toHaveLength(patches.length);
    expect(events).toEqual(
      expect.arrayContaining(
        deletedMessageIds.map((messageId) => ({
          messageId,
          eventType: 'MESSAGE',
          ruleCode: 'MESSAGE_COUNT_LIMIT_DELETE',
          action: 'DELETE_MESSAGE',
          operator: 'BOT',
        })),
      ),
    );
    expect(s.effects.filter((effect) => effect.method === 'post')).toEqual([]);
    expect(s.failures).toEqual([]);
  });

  it('declines an expired valid stateful source before creating its intent, reason or followup', async () => {
    const { s, chatId } = await fixture({}, 0);
    const r = await registration(s, chatId, new Date(Date.now() - 360_000));
    const deadline = r.input.retryUntilAt.getTime();
    await expect(
      s.intents.ensureIntentWithRuleFollowup(r.input, r.policy, r.envelope),
    ).rejects.toBeInstanceOf(ModerationRuleFollowupSourceExpiredError);
    expect(r.input.retryUntilAt.getTime()).toBe(deadline);
    expect(await s.prisma.moderationDeleteIntent.count({ where: { chatId } })).toBe(0);
    expect(
      await s.prisma.moderationDeleteIntentReason.count({ where: { intent: { chatId } } }),
    ).toBe(0);
    expect(await s.prisma.moderationRuleFollowup.count({ where: { chatId } })).toBe(0);
    expect(await s.prisma.violation.count({ where: { chatId } })).toBe(0);
    expect(s.effects).toEqual([]);
  });

  it.each(['policy', 'future-source', 'explicit-window'] as const)(
    'keeps malformed %s registration as an error',
    async (kind) => {
      const { s, chatId } = await fixture({}, 0);
      const r = await registration(s, chatId, new Date(Date.now() - 360_000));
      const input =
        kind === 'future-source'
          ? { ...r.input, sourceMessageAt: new Date(Date.now() + 60_000) }
          : kind === 'explicit-window'
            ? { ...r.input, executeAt: new Date() }
            : r.input;
      const result = s.intents.ensureIntentWithRuleFollowup(
        input,
        kind === 'policy' ? 'invalid' : r.policy,
        r.envelope,
      );
      await expect(result).rejects.toBeInstanceOf(Error);
      await expect(result).rejects.not.toBeInstanceOf(ModerationRuleFollowupSourceExpiredError);
      expect(await s.prisma.moderationDeleteIntent.count({ where: { chatId } })).toBe(0);
      expect(s.effects).toEqual([]);
    },
  );

  it('rolls back a new intent when the database deadline wins the followup insert race', async () => {
    const { s, chatId } = await fixture({}, 0);
    const r = await registration(s, chatId, new Date(Date.now() - 299_400));
    const original = (s.intents as any).persistIntent.bind(s.intents);
    let persistedInsideTransaction = false;
    jest.spyOn(s.intents as any, 'persistIntent').mockImplementation(async (...args: any[]) => {
      const result = await original(...args);
      persistedInsideTransaction = Boolean(result.intentId);
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.max(1, r.input.retryUntilAt.getTime() - new Date().getTime() + 20),
        ),
      );
      return result;
    });
    // Keep the local observation fresh while the real SQL clock crosses the immutable deadline.
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      await expect(
        s.intents.ensureIntentWithRuleFollowup(r.input, r.policy, r.envelope),
      ).rejects.toBeInstanceOf(ModerationRuleFollowupSourceExpiredError);
    } finally {
      clock.mockRestore();
    }
    expect(persistedInsideTransaction).toBe(true);
    expect(await s.prisma.moderationDeleteIntent.count({ where: { chatId } })).toBe(0);
    expect(
      await s.prisma.moderationDeleteIntentReason.count({ where: { intent: { chatId } } }),
    ).toBe(0);
    expect(await s.prisma.moderationRuleFollowup.count({ where: { chatId } })).toBe(0);
    expect(s.effects).toEqual([]);
  });

  it('completes mirrored old photo receipts without renewing the stricter rule deadline', async () => {
    const { s, chatId } = await fixture(
      { maxMessageLengthEnabled: false, photoMessagesEnabled: false },
      0,
    );
    const messageId = `old-photo-${randomUUID()}`;
    const at = Date.now() - 360_000;
    const [migration] = await s.prisma.$queryRaw<Array<{ id: string; finishedAt: Date }>>`
      SELECT id, finished_at AS "finishedAt" FROM _prisma_migrations
      WHERE migration_name = '20261005020000_add_multibot_order_fences'
        AND rolled_back_at IS NULL AND finished_at IS NOT NULL
      ORDER BY finished_at DESC LIMIT 1
    `;
    if (!migration) throw new Error('Expected native fixture authority migration');
    // FLAG: This disposable database was just migrated. Model a post-migration old source
    // with an earlier fixture cutoff, then restore it; never bypass the runtime legacy reader.
    await s.prisma.$executeRaw`
      UPDATE _prisma_migrations SET finished_at = ${new Date(at - 60_000)} WHERE id = ${migration.id}
    `;
    try {
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      const ids = await Promise.all(
        s.bots.map((bot) =>
          s.ingest({
            chatId,
            messageId,
            botId: bot.id,
            at,
            text: '',
            attachments: [
              { type: 'image', payload: { url: 'https://fixture.invalid/stale-photo.jpg' } },
            ],
          }),
        ),
      );
      await s.drain();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(s.failures).toEqual([]);
      expect(s.effects).toEqual([]);
      expect(await s.prisma.moderationDeleteIntent.count({ where: { chatId } })).toBe(0);
      expect(await s.prisma.moderationRuleFollowup.count({ where: { chatId } })).toBe(0);
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(0);
      expect(await s.prisma.moderationEvent.count({ where: { chatId } })).toBe(0);
      const receipts = await s.prisma.webhookEvent.findMany({ where: { id: { in: ids } } });
      expect(receipts.filter((row) => row.status === 'PROCESSED')).toHaveLength(1);
      expect(receipts.filter((row) => row.status === 'DUPLICATE')).toHaveLength(8);
      expect(receipts.every((row) => row.executionDeadlineAt!.getTime() === at + 600_000)).toBe(
        true,
      );
      expect(
        await s.prisma.webhookExecutionClaim.findFirst({
          where: { kind: 'EXECUTION', webhookEventId: { in: ids } },
        }),
      ).toMatchObject({
        status: 'COMPLETED',
        commandResult: expect.objectContaining({ kind: 'EXECUTION_FINISHED' }),
      });
    } finally {
      await s.prisma.$executeRaw`
        UPDATE _prisma_migrations SET finished_at = ${migration.finishedAt} WHERE id = ${migration.id}
      `;
    }
  });

  it('continues only its own followup when DELETE finishes after the inline observer has exited across nine bots', async () => {
    const { s, chatId } = await fixture();
    (s.intents as any).deleteTimeoutMs = 50;
    const messageId = `late-${randomUUID()}`;
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = false;
    const originalDelete = s.max.deleteMessage.bind(s.max);
    jest.spyOn(s.max, 'deleteMessage').mockImplementation(async (...args) => {
      started = true;
      await hold;
      return originalDelete(...args);
    });
    const originalEnsure = s.intents.ensureIntentWithRuleFollowup.bind(s.intents);
    jest.spyOn(s.intents, 'ensureIntentWithRuleFollowup').mockImplementation(async (...args) => {
      const result = await originalEnsure(...args);
      await s.intents.sweepDueIntents();
      const until = Date.now() + 5000;
      while (!started && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 10));
      return result;
    });
    const executor = jest.spyOn(s.moderation, 'executeRuleFollowup');
    const at = Date.now();
    await Promise.all(
      s.bots.map((bot) =>
        s.ingest({
          chatId,
          messageId,
          botId: bot.id,
          at,
          text: 'Long current content waits for the exact own DELETE receipt',
        }),
      ),
    );
    try {
      const until = Date.now() + 10_000;
      while (s.processedIds.length < 1 && Date.now() < until) {
        await s.pumpOnce();
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(started).toBe(true);
      expect(s.processedIds).toHaveLength(1);
      expect(s.effects.filter((e) => e.method === 'delete')).toHaveLength(0);
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(1);
    } finally {
      release();
    }
    await s.drain();
    await expectWarnOnce(s, chatId, messageId);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it.each([
    [0, 'NONE'],
    [1, 'WARN'],
    [2, 'MUTE'],
    [3, 'BAN'],
  ] as const)(
    'applies common limits actions to phone violation %i as %s across mirrored bots',
    async (prior, action) => {
      const { s, chatId } = await fixture(
        {
          maxMessageLengthEnabled: false,
          phoneNumbersEnabled: false,
          messageLimitsBotMessageEnabled: true,
          messageLimitsWarnEnabled: true,
          messageLimitsMuteEnabled: true,
          messageLimitsBanEnabled: true,
          messageLimitsMuteDurationHours: 6,
          phoneNumbersBotMessageEnabled: false,
          phoneNumbersWarnEnabled: false,
          phoneNumbersMuteEnabled: false,
          phoneNumbersBanEnabled: false,
          phoneNumbersMuteDurationHours: 1,
        },
        0,
      );
      if (prior)
        await s.prisma.violation.createMany({
          data: Array.from({ length: prior }, () => ({
            chatId,
            userId: 'fixture-user',
            ruleCode: 'PHONE_NUMBER_BLOCKED',
            score: 1,
            createdAt: new Date(Date.now() - 1000),
          })),
        });
      const messageId = `phone-${randomUUID()}`;
      const at = Date.now();
      await Promise.all(
        s.bots.map((bot) =>
          s.ingest({
            chatId,
            messageId,
            botId: bot.id,
            at,
            text: 'Позвоните +7 900 123 45 67',
          }),
        ),
      );
      await s.drain();
      await s.ruleFollowups.sweep();
      const row = await s.prisma.moderationRuleFollowup.findFirstOrThrow({
        where: { chatId, messageId },
      });
      expect(row.status).toBe('COMPLETED');
      expect(row.actionPlan).toMatchObject({
        action,
        violationCount: prior + 1,
        muteDurationHours: 6,
      });
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(prior + 1);
      expect(s.effects.filter((e) => e.method === 'delete' && e.path === '/messages')).toHaveLength(
        1,
      );
      expect(s.effects.filter((e) => e.method === 'post' && e.path === '/messages')).toHaveLength(
        action === 'MUTE' ? 2 : 1,
      );
      if (action === 'MUTE') {
        const notices = s.effects.filter((e) => e.method === 'post' && e.path === '/messages');
        expect(notices).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              body: expect.objectContaining({ text: expect.stringContaining('6ч') }),
            }),
          ]),
        );
        expect(JSON.stringify(notices)).toContain('Снять мут');
      }
      expect(
        await s.prisma.moderationEvent.count({
          where: { chatId, messageId, ruleCode: 'PHONE_NUMBER_BLOCKED', action },
        }),
      ).toBe(1);
    },
  );

  it('resumes after confirmed DELETE without replaying DELETE or the moderation engine', async () => {
    const { s, chatId } = await fixture();
    const row = await ready(s, chatId, 'restart');
    expect(await s.prisma.violation.count({ where: { chatId } })).toBe(1);
    await s.ruleFollowups.sweep();
    await s.ruleFollowups.sweep();
    await expectWarnOnce(s, chatId, row.messageId);
    expect(s.processedIds).toHaveLength(0);
  });

  it('rolls back the semantic claim and plan when the strike insert fails, then retries once', async () => {
    const { s, chatId } = await fixture();
    const row = await ready(s, chatId, 'atomic');
    const fn = `fixture_followup_${randomUUID().replace(/-/gu, '')}`;
    await s.prisma.$executeRawUnsafe(`CREATE SEQUENCE "${fn}_hits"`);
    await s.prisma.$executeRawUnsafe(
      `CREATE FUNCTION "${fn}"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.chat_id = '${chatId.replace(/'/gu, "''")}' THEN PERFORM nextval('"${fn}_hits"'); RAISE EXCEPTION 'fixture network timeout before strike insert failed'; END IF; RETURN NEW; END $$`,
    );
    await s.prisma.$executeRawUnsafe(
      `CREATE TRIGGER "${fn}" BEFORE INSERT ON violations FOR EACH ROW EXECUTE FUNCTION "${fn}"()`,
    );
    try {
      expect(await s.ruleFollowups.attempt(row.id)).toBe(true);
      expect(
        await s.prisma.moderationRuleFollowup.findUniqueOrThrow({ where: { id: row.id } }),
      ).toMatchObject({ status: 'RETRYABLE', attemptCount: 1, actionPlan: null });
      expect(
        await s.prisma.$queryRawUnsafe(
          `SELECT last_value::text AS hits, is_called FROM "${fn}_hits"`,
        ),
      ).toEqual([{ hits: '1', is_called: true }]);
      expect(s.effects.filter((effect) => effect.method === 'post')).toHaveLength(0);
      expect(
        await s.prisma.moderationViolationMessageClaim.count({
          where: { chatId, messageId: row.messageId },
        }),
      ).toBe(0);
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(1);
      expect(
        (await s.prisma.moderationRuleFollowup.findUniqueOrThrow({ where: { id: row.id } }))
          .actionPlan,
      ).toBeNull();
    } finally {
      await s.prisma.$executeRawUnsafe(`DROP TRIGGER "${fn}" ON violations`);
      await s.prisma.$executeRawUnsafe(`DROP FUNCTION "${fn}"()`);
      await s.prisma.$executeRawUnsafe(`DROP SEQUENCE "${fn}_hits"`);
    }
    await due(s, row.id);
    expect(await s.ruleFollowups.attempt(row.id)).toBe(true);
    await expectWarnOnce(s, chatId, row.messageId);
    expect(
      await s.prisma.moderationRuleFollowup.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({ status: 'COMPLETED', attemptCount: 2 });
  });

  it('keeps its frozen warning/count after a crash before execution and newer violations', async () => {
    const { s, chatId } = await fixture({ messageLimitsBanEnabled: true });
    const row = await ready(s, chatId, 'frozen');
    const original = s.moderation.executeRuleFollowup.bind(s.moderation);
    const crash = jest
      .spyOn(s.moderation, 'executeRuleFollowup')
      .mockRejectedValueOnce(new Error('fixture crash after plan'));
    await s.ruleFollowups.attempt(row.id);
    const frozen = (
      await s.prisma.moderationRuleFollowup.findUniqueOrThrow({ where: { id: row.id } })
    ).actionPlan;
    expect(frozen).toMatchObject({ action: 'WARN', violationCount: 2 });
    await s.prisma.violation.createMany({
      data: Array.from({ length: 5 }, () => ({
        chatId,
        userId: 'fixture-user',
        ruleCode: 'MESSAGE_TOO_LONG',
        score: 1,
      })),
    });
    crash.mockImplementation(original);
    await due(s, row.id);
    await s.ruleFollowups.attempt(row.id);
    expect(
      (await s.prisma.moderationRuleFollowup.findUniqueOrThrow({ where: { id: row.id } }))
        .actionPlan,
    ).toEqual(frozen);
    expect(s.effects.filter((e) => e.path.endsWith('/members') && e.method !== 'get')).toHaveLength(
      0,
    );
    expect(
      await s.prisma.moderationEvent.count({
        where: { chatId, messageId: row.messageId, action: 'WARN' },
      }),
    ).toBe(1);
  });

  it('never retransmits an unknown SEND on another bot', async () => {
    const { s, chatId } = await fixture();
    const row = await ready(s, chatId, 'unknown-send');
    s.ambiguousNextSend();
    await s.ruleFollowups.attempt(row.id);
    expect(
      (await s.prisma.moderationRuleFollowup.findUniqueOrThrow({ where: { id: row.id } })).status,
    ).toBe('AMBIGUOUS');
    await due(s, row.id);
    await s.ruleFollowups.sweep();
    await s.ruleFollowups.attempt(row.id);
    expect(s.effects.filter((e) => e.method === 'post' && e.path === '/messages')).toHaveLength(1);
    expect(await s.prisma.violation.count({ where: { chatId } })).toBe(2);
  });

  it('fences an old owner after SQL lease takeover without finishing or starting effects', async () => {
    const { s, chatId } = await fixture();
    const row = await ready(s, chatId, 'takeover');
    jest.spyOn(s.moderation, 'executeRuleFollowup').mockImplementation(async () => {
      await s.prisma.moderationRuleFollowup.update({
        where: { id: row.id },
        data: { leaseToken: 'fixture-new-owner', leaseExpiresAt: new Date(Date.now() + 30000) },
      });
      throw new Error('fixture old owner lost lease');
    });
    await s.ruleFollowups.attempt(row.id);
    const retained = await s.prisma.moderationRuleFollowup.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(retained).toMatchObject({
      status: 'IN_PROGRESS',
      leaseToken: 'fixture-new-owner',
      lastError: null,
    });
    expect(s.effects.filter((e) => e.method === 'post')).toHaveLength(0);
  });

  it('rejects a BAN by an old owner when takeover occurs during the last awaited policy read', async () => {
    const { s, chatId } = await fixture(
      { messageLimitsWarnEnabled: false, messageLimitsBanEnabled: true },
      3,
    );
    const row = await ready(s, chatId, 'final-read-takeover');
    const assertAllowed = s.sanctionGuard.assertAllowed.bind(s.sanctionGuard);
    const readSettings = s.prisma.chatSettings.findUnique.bind(s.prisma.chatSettings);
    let transferred = false;
    jest.spyOn(s.sanctionGuard, 'assertAllowed').mockImplementation(async (proof, options) => {
      if (!options?.assertFinalOwnership || !options.beforeFinalAuthority)
        return assertAllowed(proof, options);
      return assertAllowed(proof, {
        ...options,
        beforeFinalAuthority: async () => {
          await options.beforeFinalAuthority!();
          jest
            .spyOn(
              s.prisma.chatSettings as unknown as {
                findUnique(args: Parameters<typeof readSettings>[0]): Promise<unknown>;
              },
              'findUnique',
            )
            .mockImplementationOnce(async (...args) => {
              await s.prisma.moderationRuleFollowup.update({
                where: { id: row.id },
                data: {
                  leaseToken: 'fixture-last-read-owner',
                  leaseExpiresAt: new Date(Date.now() + 30000),
                },
              });
              transferred = true;
              return readSettings(...args);
            });
        },
      });
    });
    await s.ruleFollowups.attempt(row.id);
    expect(transferred).toBe(true);
    expect(s.effects.filter((e) => e.method !== 'get' && e.path.endsWith('/members'))).toHaveLength(
      0,
    );
    expect(
      await s.prisma.moderationEvent.count({
        where: { chatId, messageId: row.messageId, action: 'BAN' },
      }),
    ).toBe(0);
    expect(
      (await s.prisma.moderationRuleFollowup.findUniqueOrThrow({ where: { id: row.id } }))
        .leaseToken,
    ).toBe('fixture-last-read-owner');
  });

  it('settles a confirmed BAN after a crash and original deadline without repeating BAN or SEND', async () => {
    const { s, chatId } = await fixture(
      { messageLimitsWarnEnabled: false, messageLimitsBanEnabled: true },
      3,
    );
    const row = await ready(s, chatId, 'ban-crash', 298000);
    const reputation = jest.spyOn(s.moderation as any, 'upsertGlobalSpammerEntry');
    const original = (s.moderation as any).persistRuleFollowupEvent.bind(s.moderation);
    const crash = jest
      .spyOn(s.moderation as any, 'persistRuleFollowupEvent')
      .mockRejectedValueOnce(new Error('fixture crash after confirmed BAN'));
    await s.ruleFollowups.attempt(row.id);
    expect(
      (await s.prisma.moderationRuleFollowup.findUniqueOrThrow({ where: { id: row.id } })).effects,
    ).toMatchObject({ phase: 'BAN_CONFIRMED' });
    expect(
      s.effects.filter((e) => e.method === 'delete' && e.path.endsWith('/members')),
    ).toHaveLength(1);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(1, row.deadlineAt.getTime() - Date.now() + 20)),
    );
    crash.mockImplementation(original);
    const readsBeforeExpiredSettlement = s.requests.filter(
      (request) => request.method === 'get',
    ).length;
    jest
      .spyOn(s.moderation as any, 'resolveSanctionUserLabel')
      .mockRejectedValue(
        new Error('Expired BAN receipt settlement must not enrich names through MAX'),
      );
    await due(s, row.id);
    await s.ruleFollowups.attempt(row.id);
    expect(
      await s.prisma.moderationEvent.count({
        where: { chatId, messageId: row.messageId, action: 'BAN' },
      }),
    ).toBe(1);
    expect(
      s.effects.filter((e) => e.method === 'delete' && e.path.endsWith('/members')),
    ).toHaveLength(1);
    expect(s.effects.filter((e) => e.method === 'post' && e.path === '/messages')).toHaveLength(0);
    expect(reputation).not.toHaveBeenCalled();
    expect(s.requests.filter((request) => request.method === 'get')).toHaveLength(
      readsBeforeExpiredSettlement,
    );
    expect(
      (await s.prisma.moderationRuleFollowup.findUniqueOrThrow({ where: { id: row.id } })).status,
    ).toBe('COMPLETED');
  });

  it('quarantines an unknown BAN and later accepts only its exact positive receipt for SQL settlement', async () => {
    const { s, chatId } = await fixture(
      { messageLimitsWarnEnabled: false, messageLimitsBanEnabled: true },
      3,
    );
    const row = await ready(s, chatId, 'ban-unknown');
    const reputation = jest.spyOn(s.moderation as any, 'upsertGlobalSpammerEntry');
    s.ambiguousNextMemberMutation();
    await s.ruleFollowups.attempt(row.id);
    expect(
      await s.prisma.moderationRuleFollowup.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({ status: 'AMBIGUOUS', effects: { phase: 'UNKNOWN' } });
    const jobId = s.max.getExplicitActionJobId('BAN_MEMBER', `${row.id}:sanction-ban`);
    const readsBeforeSettlement = s.requests.filter((request) => request.method === 'get').length;
    jest
      .spyOn(s.moderation as any, 'resolveSanctionUserLabel')
      .mockRejectedValue(new Error('Receipt settlement must not enrich names through MAX'));
    await due(s, row.id);
    await s.ruleFollowups.attempt(row.id, true);
    expect(
      await s.prisma.moderationEvent.count({
        where: { chatId, messageId: row.messageId, action: 'BAN' },
      }),
    ).toBe(0);
    await s.prisma.maxActionLedgerEntry.update({
      where: { jobId },
      data: { status: 'SUCCEEDED', ambiguous: false, completedAt: new Date() },
    });
    await due(s, row.id);
    await s.ruleFollowups.attempt(row.id, true);
    expect(
      await s.prisma.moderationEvent.count({
        where: { chatId, messageId: row.messageId, action: 'BAN' },
      }),
    ).toBe(1);
    expect(
      (await s.prisma.moderationRuleFollowup.findUniqueOrThrow({ where: { id: row.id } })).status,
    ).toBe('COMPLETED');
    expect(
      s.effects.filter((e) => e.method === 'delete' && e.path.endsWith('/members')),
    ).toHaveLength(1);
    expect(s.effects.filter((e) => e.method === 'post' && e.path === '/messages')).toHaveLength(0);
    expect(s.requests.filter((request) => request.method === 'get')).toHaveLength(
      readsBeforeSettlement,
    );
    expect(reputation).not.toHaveBeenCalled();
  });

  it('pins pending and unknown followups while allowing a settled terminal DELETE receipt to be purged', async () => {
    const { s, chatId } = await fixture();
    const rows = await Promise.all(
      ['pending', 'unknown', 'settled'].map((name) => ready(s, chatId, name)),
    );
    await s.prisma.moderationRuleFollowup.update({
      where: { id: rows[1]!.id },
      data: { status: 'AMBIGUOUS', effects: { phase: 'UNKNOWN' } },
    });
    await s.prisma.moderationRuleFollowup.update({
      where: { id: rows[2]!.id },
      data: { status: 'COMPLETED', effects: { phase: 'SETTLED' } },
    });
    await s.prisma.moderationDeleteIntent.updateMany({
      where: { id: { in: rows.map((row) => row.intentId) } },
      data: { updatedAt: new Date(Date.now() - 365 * 86400000) },
    });
    await s.intents.purgeRetainedIntents();
    expect(
      await s.prisma.moderationDeleteIntent.count({
        where: { id: { in: rows.slice(0, 2).map((row) => row.intentId) } },
      }),
    ).toBe(2);
    expect(
      await s.prisma.moderationDeleteIntent.findUnique({ where: { id: rows[2]!.intentId } }),
    ).toBeNull();
  });

  it('keeps due/expiry/lease and exact receipt probes bounded with over sixteen thousand retained/future rows', async () => {
    const { s, chatId } = await fixture();
    const row = await ready(s, chatId, 'scale');
    await s.prisma.$executeRaw(Prisma.sql`
      INSERT INTO moderation_rule_followups (id,intent_id,reason_key,chat_id,user_id,message_id,rule_code,source_at,deadline_at,policy_sha256,envelope,status,next_attempt_at,lease_token,lease_expires_at,effects,updated_at)
      SELECT ${row.id} || ':history:' || n, ${row.intentId}, 'history:' || n, ${chatId}, ${row.userId}, ${row.messageId}, ${row.ruleCode},
        ${row.sourceAt}, ${row.deadlineAt}, ${row.policySha256}, ${JSON.stringify(row.envelope)}::jsonb,
        CASE n % 4 WHEN 0 THEN 'COMPLETED' WHEN 1 THEN 'READY' WHEN 2 THEN 'RETRYABLE' ELSE 'IN_PROGRESS' END,
        ${new Date(Date.now() + 86400000)}, CASE WHEN n % 4 = 3 THEN 'history-lease' ELSE NULL END,
        CASE WHEN n % 4 = 3 THEN ${new Date(Date.now() + 86400000)}::timestamp ELSE NULL END, '{}'::jsonb, ${new Date()}
      FROM generate_series(1,16001) n
    `);
    await s.prisma.$executeRawUnsafe('ANALYZE moderation_rule_followups');
    const at = new Date();
    const queries = [
      Prisma.sql`SELECT id FROM moderation_rule_followups WHERE status='READY' AND next_attempt_at <= ${at} ORDER BY next_attempt_at,id LIMIT 32`,
      Prisma.sql`SELECT id FROM moderation_rule_followups WHERE status='RETRYABLE' AND next_attempt_at <= ${at} ORDER BY next_attempt_at,id LIMIT 32`,
      Prisma.sql`SELECT id FROM moderation_rule_followups WHERE status='IN_PROGRESS' AND lease_expires_at <= ${at} ORDER BY lease_expires_at,id LIMIT 32`,
      Prisma.sql`SELECT id FROM moderation_rule_followups WHERE status='READY' AND deadline_at <= ${at} AND COALESCE(effects->>'phase','UNSTARTED')='UNSTARTED' ORDER BY deadline_at,id LIMIT 32 FOR UPDATE SKIP LOCKED`,
      Prisma.sql`SELECT id FROM moderation_rule_followups WHERE intent_id=${row.intentId} AND reason_key=${row.reasonKey}`,
    ];
    const collect = (node: Record<string, unknown>): Record<string, unknown>[] => [
      node,
      ...((node.Plans as Array<Record<string, unknown>> | undefined) ?? []).flatMap(collect),
    ];
    for (const query of queries) {
      const plan = await s.prisma.$queryRaw<
        Array<{ 'QUERY PLAN': Array<{ Plan: Record<string, unknown> }> }>
      >(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`);
      const nodes = collect(plan[0]!['QUERY PLAN'][0]!.Plan);
      expect(nodes.some((node) => String(node['Node Type']).includes('Index'))).toBe(true);
      for (const node of nodes) {
        const examined =
          Number(node['Actual Rows'] ?? 0) + Number(node['Rows Removed by Filter'] ?? 0);
        expect(examined * Number(node['Actual Loops'] ?? 1)).toBeLessThanOrEqual(64);
        expect(
          Number(node['Shared Hit Blocks'] ?? 0) + Number(node['Shared Read Blocks'] ?? 0),
        ).toBeLessThanOrEqual(64);
      }
    }
  });

  it('rejects a shortened reason deadline while retaining the original five-minute source binding', async () => {
    const { s, chatId } = await fixture();
    const row = await ready(s, chatId, 'short-deadline');
    const reason = await s.prisma.moderationDeleteIntentReason.findUniqueOrThrow({
      where: { intentId_reasonKey: { intentId: row.intentId, reasonKey: row.reasonKey } },
    });
    await s.prisma.moderationDeleteIntentReason.update({
      where: { id: reason.id },
      data: {
        metadata: {
          ...(reason.metadata as Prisma.JsonObject),
          messageLimitDeadlineAtMs: Date.now() - 1,
        },
      },
    });
    await s.ruleFollowups.attempt(row.id);
    expect(
      (await s.prisma.moderationRuleFollowup.findUniqueOrThrow({ where: { id: row.id } })).status,
    ).toBe('CANCELLED');
    expect(await s.prisma.violation.count({ where: { chatId } })).toBe(1);
    expect(s.effects.filter((e) => e.method === 'post')).toHaveLength(0);
  });

  it('anchors a fresh edit to its edit event even when the original MAX message was created an hour ago', async () => {
    const { s, chatId } = await fixture({}, 0);
    const messageId = `old-edit-${randomUUID()}`;
    const oldAt = Date.now() - 3600000;
    s.messages.set(messageId, {
      sender: { user_id: 'fixture-user', is_bot: false },
      recipient: { chat_id: chatId, chat_type: 'chat' },
      timestamp: oldAt,
      body: { mid: messageId, text: 'small' },
    });
    const editAt = Date.now();
    await Promise.all(
      s.bots.map((bot) =>
        s.ingest({
          chatId,
          messageId,
          text: 'Fresh edited content is now longer than the configured limit',
          type: 'message_edited',
          at: editAt,
          botId: bot.id,
        }),
      ),
    );
    s.messages.get(messageId)!.timestamp = oldAt;
    await s.drain();
    const row = await s.prisma.moderationRuleFollowup.findFirstOrThrow({
      where: { chatId, messageId },
    });
    expect(row.sourceAt.getTime()).toBe(editAt);
    expect(row.deadlineAt.getTime()).toBe(editAt + 300000);
    expect(await s.prisma.violation.count({ where: { chatId } })).toBe(1);
    expect(s.effects.filter((e) => e.method === 'delete' && e.path === '/messages')).toHaveLength(
      1,
    );
  });

  it('cannot mint a new followup from another generation or reason of an already confirmed DELETE', async () => {
    const { s, chatId } = await fixture();
    const row = await ready(s, chatId, 'old-receipt');
    const settings = await s.prisma.chatSettings.findUniqueOrThrow({ where: { chatId } });
    const input = {
      chatId,
      messageId: row.messageId,
      subjectUserId: row.userId,
      sourceMessageAt: new Date(),
      originBotId: s.bots[0]!.id,
      routingPolicy: 'delete_capable' as const,
      entityType: 'CHAT' as const,
      messageAuthorKind: 'user' as const,
      reasonKey: row.reasonKey,
      ruleCode: row.ruleCode,
      event: {
        userId: row.userId,
        eventType: 'MESSAGE' as const,
        score: 1,
        metadata: bindMessageLimitEvidence(settings, Date.now(), row.ruleCode),
      },
    };
    const envelope = {
      version: 1 as const,
      updateType: 'message_edited',
      originBotId: s.bots[0]!.id,
      userLabel: 'Fixture user',
      effectiveMessageLength: 45,
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
    };
    const wrongGeneration = await s.intents.ensureIntentWithRuleFollowup(
      input,
      row.policySha256,
      envelope,
    );
    expect(wrongGeneration.followupId).toBeNull();
    const wrongReason = await s.intents.ensureIntentWithRuleFollowup(
      { ...input, sourceMessageAt: row.sourceAt, reasonKey: 'another-rule' },
      row.policySha256,
      envelope,
    );
    expect(wrongReason.followupId).toBeNull();
    expect(await s.prisma.moderationRuleFollowup.count({ where: { intentId: row.intentId } })).toBe(
      1,
    );
    expect(await s.prisma.violation.count({ where: { chatId } })).toBe(1);
  });

  it('keeps an immutable MUTE expiry and honors a manual release after a crash at the SQL checkpoint', async () => {
    const { s, chatId } = await fixture(
      { messageLimitsWarnEnabled: false, messageLimitsMuteEnabled: true },
      2,
    );
    const row = await ready(s, chatId, 'mute-crash');
    const original = (s.moderation as any).getActiveMute.bind(s.moderation);
    const crash = jest
      .spyOn(s.moderation as any, 'getActiveMute')
      .mockRejectedValueOnce(new Error('fixture crash before mute cache settlement'));
    await s.ruleFollowups.attempt(row.id);
    const checkpoint = await s.prisma.moderationRuleFollowup.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(checkpoint.effects).toMatchObject({ phase: 'SQL_COMMITTED' });
    const plan = checkpoint.actionPlan as Prisma.JsonObject;
    const mute = await s.prisma.moderationEvent.findUniqueOrThrow({
      where: { id: String(plan.eventId) },
    });
    expect(mute.action).toBe('MUTE');
    expect((mute.metadata as Prisma.JsonObject).muteExpiresAt).toBe(
      new Date(Number(plan.muteExpiresAtMs)).toISOString(),
    );
    await s.prisma.moderationEvent.create({
      data: {
        chatId,
        userId: row.userId,
        ruleCode: 'MANUAL_UNMUTE',
        action: 'NONE',
        operator: 'ADMIN',
        eventType: 'SYSTEM',
        score: 0,
        createdAt: new Date(Math.max(Date.now(), Number(plan.issuedAtMs))),
      },
    });
    crash.mockImplementation(original);
    await due(s, row.id);
    await s.ruleFollowups.attempt(row.id);
    expect(
      await (s.moderation as any).getActiveMute(chatId, row.userId, 1, { bypassCache: true }),
    ).toBeNull();
    expect(
      await s.prisma.moderationEvent.count({
        where: { chatId, messageId: row.messageId, action: 'MUTE' },
      }),
    ).toBe(1);
    expect(
      (await s.prisma.moderationRuleFollowup.findUniqueOrThrow({ where: { id: row.id } }))
        .actionPlan,
    ).toEqual(plan);
    expect(s.effects.filter((e) => e.method === 'post' && e.path === '/messages')).toHaveLength(0);
  });

  it('stops new SQL admission on runtime drain while preserving already registered work', async () => {
    const { s, chatId } = await fixture();
    const row = await ready(s, chatId, 'shutdown');
    const workers = s.ruleFollowups.stopWorkerAdmission();
    await Promise.all(workers.map((worker) => worker.pause()));
    expect(await s.ruleFollowups.sweep()).toBe(0);
    expect(await s.ruleFollowups.attempt(row.id)).toBe(false);
    expect(
      (await s.prisma.moderationRuleFollowup.findUniqueOrThrow({ where: { id: row.id } })).status,
    ).toBe('READY');
  });
});
