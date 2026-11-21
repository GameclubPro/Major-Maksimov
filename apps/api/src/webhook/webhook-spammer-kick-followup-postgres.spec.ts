import { createHash, randomUUID } from 'node:crypto';
import {
  spammerKickPolicySha256,
  spammerMessageKickKey,
} from '../moderation/spammer-kick-followup';
import {
  createMultibotHarness,
  type MultibotHarness,
} from './webhook-multibot-fullpath.spec-support';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const describeStores = databaseUrl && redisUrl ? describe : describe.skip;
const globalRule = 'GLOBAL_SPAMMER_MESSAGE_DELETE';
const localRule = 'LOCAL_ADMIN_BLOCK_MESSAGE_DELETE';
jest.setTimeout(60_000);

describeStores('native post-delete spammer KICK reader', () => {
  let h: MultibotHarness;
  let chatId: string;
  let userId: string;
  let adminId: string;
  beforeEach(async () => {
    h = await createMultibotHarness({ databaseUrl, redisUrl, bots: 2, mode: 'on' });
    [chatId] = await h.seedCatalog(1, { deleteSpammersEnabled: true });
    userId = 'kick-user-' + randomUUID();
    adminId = 'kick-admin-' + randomUUID();
  });
  afterEach(async () => {
    if (!h) return;
    jest.restoreAllMocks();
    await h.prisma.adminGlobalSpammerExemption.deleteMany({ where: { adminUserId: adminId } });
    await h.prisma.globalSpammer.deleteMany({ where: { userId } });
    await h.dispose();
  });

  async function authorize(ruleCode: string) {
    if (ruleCode === localRule) {
      await h.prisma.chatAdminAllowlist.create({ data: { chatId, userId: adminId } });
      await h.prisma.adminGlobalSpammerExemption.create({
        data: {
          adminUserId: adminId,
          userId,
          sourceChatId: chatId,
          decision: 'BLOCK',
        },
      });
    } else {
      await h.prisma.globalSpammer.create({
        data: {
          userId,
          lastReason: 'FANOUT_EPISODE_CONFIRMED',
          lastChatId: chatId,
          expiresAt: new Date(Date.now() + 3600_000),
          sourceBreakdown: {
            FANOUT_HIGH: { score: 1, count: 1, reasons: ['FANOUT_EPISODE_CONFIRMED'] },
          },
        },
      });
    }
  }

  async function ready(ruleCode = globalRule, ageMs = 1000) {
    await authorize(ruleCode);
    const reasonKey =
      ruleCode === localRule
        ? 'LOCAL_ADMIN_BLOCK:message-delete'
        : 'GLOBAL_SPAMMER:known-message-delete';
    const reason =
      ruleCode === localRule
        ? 'Local admin block for this admin scope'
        : 'Sender exists in global spammer registry';
    const messageId = randomUUID();
    const intentId = randomUUID();
    const id =
      'mrf-v1-' +
      createHash('sha256')
        .update(JSON.stringify([intentId, reasonKey]))
        .digest('hex');
    const sourceAt = new Date(Date.now() - ageMs);
    const deadlineAt = new Date(sourceAt.getTime() + 300_000);
    const botId = h.bots[0]!.id;
    // Stage A reads a previously verified DELETE. Seed its stored rows without running a writer.
    await h.prisma.moderationDeleteIntent.create({
      data: {
        id: intentId,
        chatId,
        messageId,
        subjectUserId: userId,
        sourceMessageAt: sourceAt,
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        originBotId: botId,
        routingPolicy: 'delete_capable',
        status: 'SUCCEEDED',
        remoteDeleteSucceededAt: new Date(sourceAt.getTime() + 100),
        remoteDeleteSucceededBotId: botId,
        createdAt: sourceAt,
        executeAt: sourceAt,
        nextAttemptAt: sourceAt,
        retryUntilAt: deadlineAt,
        reasons: {
          create: {
            id: randomUUID(),
            reasonKey,
            userId,
            ruleCode,
            eventType: 'MESSAGE',
            createdAt: sourceAt,
            metadata: { reason, moderationDeleteVerified: true },
          },
        },
      },
    });
    return h.prisma.moderationRuleFollowup.create({
      data: {
        id,
        intentId,
        reasonKey,
        chatId,
        userId,
        messageId,
        sourceAt,
        deadlineAt,
        ruleCode,
        policySha256: spammerKickPolicySha256(ruleCode),
        createdAt: new Date(sourceAt.getTime() + 1),
        status: 'READY',
        nextAttemptAt: sourceAt,
        envelope: {
          version: 1,
          updateType: 'message_created',
          originBotId: botId,
          userLabel: 'Fixture user',
          effectiveMessageLength: 1,
          rulesPublishedUrl: null,
          rulesPublishedMessageId: null,
        },
      },
    });
  }
  const getRow = (id: string) =>
    h.prisma.moderationRuleFollowup.findUniqueOrThrow({ where: { id } });
  const kickEvents = () =>
    h.prisma.moderationEvent.count({ where: { chatId, userId, action: 'KICK' } });
  const memberEffects = () =>
    h.effects.filter((e) => e.method === 'delete' && e.path.endsWith('/members'));
  async function checkReceipt(id: string) {
    await h.prisma.moderationRuleFollowup.update({
      where: { id },
      data: { nextAttemptAt: new Date(Date.now() - 1000) },
    });
    await h.ruleFollowups.attempt(id, true);
  }

  async function mirrorMessage(messageId: string) {
    const at = Date.now();
    await Promise.all(
      h.bots.map((bot) =>
        h.ingest({
          chatId,
          messageId,
          senderId: userId,
          botId: bot.id,
          at,
          text: 'A normal message from a previously confirmed spammer.',
        }),
      ),
    );
  }
  async function ownedRow(messageId: string, ruleCode: string) {
    return h.prisma.moderationRuleFollowup.findFirstOrThrow({
      where: { chatId, userId, messageId, ruleCode },
    });
  }
  async function assertCompletedOnce(messageId: string, ruleCode: string) {
    expect(await ownedRow(messageId, ruleCode)).toMatchObject({
      status: 'COMPLETED',
      effects: { phase: 'SETTLED' },
    });
    expect(h.effects.filter((e) => e.method === 'delete' && e.path === '/messages')).toHaveLength(
      1,
    );
    expect(memberEffects()).toHaveLength(1);
    expect(await kickEvents()).toBe(1);
    expect(
      await h.prisma.moderationViolationMessageClaim.count({
        where: {
          chatId,
          userId,
          messageId,
          updateType: 'message_action',
          messageActionKey: { not: null },
        },
      }),
    ).toBe(1);
  }

  it('persists a known-spammer continuation before DELETE and lets the webhook settle it inline', async () => {
    await authorize(globalRule);
    const messageId = randomUUID();
    const background = jest.spyOn(h.ruleFollowups, 'sweep').mockResolvedValue(0);
    const remove = h.max.deleteMessage.bind(h.max);
    let pendingBeforeDelete = false;
    jest.spyOn(h.max, 'deleteMessage').mockImplementation(async (...args) => {
      const row = await ownedRow(messageId, globalRule);
      expect(row).toMatchObject({ status: 'WAITING_DELETE', actionPlan: null });
      pendingBeforeDelete = true;
      return remove(...args);
    });
    await mirrorMessage(messageId);
    await h.drain();
    expect(pendingBeforeDelete).toBe(true);
    await assertCompletedOnce(messageId, globalRule);
    background.mockRestore();
    await h.ruleFollowups.sweep();
    await assertCompletedOnce(messageId, globalRule);
  });

  it('resumes a local block after webhook completion only when the delete worker confirms the exact message', async () => {
    await authorize(localRule);
    const messageId = randomUUID();
    let unblock!: () => void;
    const barrier = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let deleting = false;
    const remove = h.max.deleteMessage.bind(h.max);
    jest.spyOn(h.max, 'deleteMessage').mockImplementation(async (...args) => {
      deleting = true;
      await barrier;
      return remove(...args);
    });
    const enroll = h.intents.ensureIntentWithRuleFollowup.bind(h.intents);
    jest.spyOn(h.intents, 'ensureIntentWithRuleFollowup').mockImplementation(async (...args) => {
      const registration = await enroll(...args);
      // Let a separate worker take the real DELETE lease before the inline observer reads it.
      await h.intents.sweepDueIntents();
      const stop = Date.now() + 5000;
      while (!deleting && Date.now() < stop)
        await new Promise((resolve) => setTimeout(resolve, 10));
      return registration;
    });
    try {
      await mirrorMessage(messageId);
      const stop = Date.now() + 10000;
      while (!h.processedIds.length && Date.now() < stop) {
        await h.pumpOnce();
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      expect(deleting).toBe(true);
      expect(h.processedIds).toHaveLength(1);
      expect(await ownedRow(messageId, localRule)).toMatchObject({
        status: 'WAITING_DELETE',
        actionPlan: null,
      });
      await h.ruleFollowups.sweep();
      expect(memberEffects()).toHaveLength(0);
      expect(await kickEvents()).toBe(0);
    } finally {
      unblock();
    }
    await h.drain();
    await h.ruleFollowups.sweep();
    await assertCompletedOnce(messageId, localRule);
  });

  it.each([globalRule, localRule])(
    'sends one KICK and records it once across competing workers for %s',
    async (rule) => {
      const row = await ready(rule);
      const owners = await Promise.all([
        h.ruleFollowups.attempt(row.id),
        h.ruleFollowups.attempt(row.id),
      ]);
      expect(owners.filter(Boolean)).toHaveLength(1);
      expect(await getRow(row.id)).toMatchObject({ status: 'COMPLETED' });
      await h.ruleFollowups.sweep();
      expect(memberEffects()).toHaveLength(1);
      expect(await kickEvents()).toBe(1);
      expect(h.effects.filter((e) => e.path === '/messages')).toHaveLength(0);
      expect(
        await h.prisma.moderationViolationMessageClaim.count({
          where: { chatId, userId, messageId: row.messageId },
        }),
      ).toBe(1);
    },
  );

  it('refuses a verified sibling reason when its own DELETE reason is unverified', async () => {
    const row = await ready();
    await h.prisma.moderationDeleteIntentReason.update({
      where: { intentId_reasonKey: { intentId: row.intentId, reasonKey: row.reasonKey } },
      data: {
        metadata: {
          reason: 'Sender exists in global spammer registry',
          moderationDeleteVerified: false,
        },
      },
    });
    await h.prisma.moderationDeleteIntentReason.create({
      data: {
        id: randomUUID(),
        intentId: row.intentId,
        ruleCode: globalRule,
        reasonKey: 'unrelated-reason',
        userId,
        metadata: {
          reason: 'Sender exists in global spammer registry',
          moderationDeleteVerified: true,
        },
      },
    });
    await h.ruleFollowups.attempt(row.id);
    expect(await getRow(row.id)).toMatchObject({ status: 'CANCELLED', actionPlan: null });
    expect(memberEffects()).toHaveLength(0);
    expect(await kickEvents()).toBe(0);
  });
  it('declines new followup authority created after the source DELETE already succeeded', async () => {
    const row = await ready();
    await h.prisma.moderationRuleFollowup.update({
      where: { id: row.id },
      data: { createdAt: new Date() },
    });
    await h.ruleFollowups.attempt(row.id);
    expect(await getRow(row.id)).toMatchObject({ status: 'CANCELLED', actionPlan: null });
    expect(memberEffects()).toHaveLength(0);
    expect(await kickEvents()).toBe(0);
  });

  it.each(['expired', 'revoked'])(
    'never sends for an expired or revoked source (%s)',
    async (scenario) => {
      const row = await ready(globalRule, scenario === 'expired' ? 310_000 : 1000);
      if (scenario === 'revoked')
        await h.prisma.chatSettings.update({
          where: { chatId },
          data: { deleteSpammersEnabled: false },
        });
      await h.ruleFollowups.attempt(row.id);
      expect(await getRow(row.id)).toMatchObject({
        status: scenario === 'expired' ? 'EXPIRED' : 'CANCELLED',
      });
      expect(memberEffects()).toHaveLength(0);
      expect(await kickEvents()).toBe(0);
    },
  );

  it('quarantines ambiguous removal, ignores another target receipt, then settles the exact positive receipt once', async () => {
    const row = await ready();
    const key = spammerMessageKickKey(chatId, userId, row.messageId);
    const jobId = h.max.getExplicitActionJobId('KICK_MEMBER', key);
    h.ambiguousNextMemberMutation();
    await h.ruleFollowups.attempt(row.id);
    expect(await getRow(row.id)).toMatchObject({
      status: 'AMBIGUOUS',
      effects: { phase: 'UNKNOWN', actionKey: key },
    });
    expect(memberEffects()).toHaveLength(1);
    await checkReceipt(row.id);
    expect(await kickEvents()).toBe(0);
    await h.prisma.maxActionLedgerEntry.update({
      where: { jobId },
      data: {
        userId: 'different-fixture-user',
        status: 'SUCCEEDED',
        ambiguous: false,
        completedAt: new Date(),
      },
    });
    await checkReceipt(row.id);
    expect(await getRow(row.id)).toMatchObject({ status: 'AMBIGUOUS' });
    expect(await kickEvents()).toBe(0);
    await h.prisma.maxActionLedgerEntry.update({ where: { jobId }, data: { userId } });
    await checkReceipt(row.id);
    expect(await getRow(row.id)).toMatchObject({
      status: 'COMPLETED',
      effects: { phase: 'SETTLED', actionKey: key },
    });
    expect(memberEffects()).toHaveLength(1);
    expect(await kickEvents()).toBe(1);
  });
});
