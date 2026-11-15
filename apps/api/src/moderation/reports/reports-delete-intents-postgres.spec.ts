import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import {
  MODERATION_DELETE_INTENT_QUEUE,
  type ModerationDeleteIntentJob,
} from '../moderation-delete-intent.queue';
import { ConfigService } from '@nestjs/config';
import { createPrismaClient, type PrismaClient } from '../../prisma/prisma-client';
import { ModerationDeleteIntentService } from '../moderation-delete-intent.service';
import { ReportStateService } from './report-state.service';
import { ReportDeleteGuardService } from './report-delete-guard.service';
import { REPORT_DAY_MS, REPORT_DELETE_RULE, reportContentHash } from './report.util';
import { MessageLimitsDeleteGuardService } from '../message-limits-delete-guard.service';
import { TrafficProtectionDeleteGuardService } from '../traffic-protection-delete-guard.service';
import { TrafficProtectionDetector } from '../traffic-protection.detector';

const url = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = url ? describe : describe.skip;
describePostgres('PostgreSQL report to shared deletion boundary', () => {
  let prisma: PrismaClient;
  const chatId = `reports-delete-${randomUUID()}`;
  const authorId = 'author';
  const rows = new Map<string, Record<string, unknown>>();
  const bot = { isKnownBotUserId: () => false };
  let queue: Queue<ModerationDeleteIntentJob>;
  let add: jest.SpyInstance<
    ReturnType<Queue<ModerationDeleteIntentJob>['add']>,
    Parameters<Queue<ModerationDeleteIntentJob>['add']>
  >;
  const remoteMutation = jest.fn();
  const guardStub = {
    assertIntentStillActionable: async () => 'not_applicable' as const,
    prepareForDispatch: async () => 'not_applicable' as const,
  };
  const max = {
    getExactMessageRow: jest.fn(
      async (_chat: string, message: string) => rows.get(message) ?? null,
    ),
    getChatMemberAccess: jest.fn(async (_chat: string, userId: string) => ({
      userId,
      isBot: false,
      isAdmin: false,
      isOwner: false,
      joinedAtMs: Date.now() - 2 * REPORT_DAY_MS,
    })),
    getChatMembersAccess: jest.fn(
      async (_chat: string, users: string[]) =>
        new Map(
          users.map((userId) => [
            userId,
            { userId, isBot: false, joinedAtMs: Date.now() - 2 * REPORT_DAY_MS },
          ]),
        ),
    ),
    deleteMessage: jest.fn(
      async (
        _chat: string,
        message: string,
        options: { beforeImmediateDeleteMutation: () => Promise<void> },
      ) => {
        await options.beforeImmediateDeleteMutation();
        remoteMutation(message);
        rows.delete(message);
      },
    ),
  };
  function service(mode = 'shadow', reportsMode = 'on') {
    const config = new ConfigService({
      MODERATION_DELETE_INTENT_MODE: mode,
      PARTICIPANT_REPORTS_MODE: reportsMode,
      MODERATION_DELETE_INTENT_REQUIRED_SUBSCRIPTION_ENABLED: false,
      COMMERCIAL_OCR_ROLLOUT_MODE: 'off',
    });
    const state = new ReportStateService(prisma as never, max as never, bot as never, config);
    const guard = new ReportDeleteGuardService(state, prisma as never, max as never);
    const immunity = { consumeForMessage: async () => 'not_granted' };
    const trafficGuard = new TrafficProtectionDeleteGuardService(
      prisma as never,
      max as never,
      bot as never,
      immunity as never,
      config,
    );
    const lengthGuard = new MessageLimitsDeleteGuardService(
      prisma as never,
      max as never,
      bot as never,
      immunity as never,
      config,
    );
    const route = {
      entityType: 'CHAT',
      candidateBotIds: ['bot'],
      candidateCapabilities: [
        { botId: 'bot', state: 'confirmed_capable', checkedAt: new Date().toISOString() },
      ],
    };
    const deletes = new ModerationDeleteIntentService(
      prisma as never,
      max as never,
      { resolveDeleteMessageBotRoute: async () => route } as never,
      queue as never,
      config,
      guardStub as never,
      {} as never,
      guardStub as never,
      guardStub as never,
      immunity as never,
      undefined,
      undefined,
      trafficGuard,
      guardStub as never,
      guard,
    );
    Object.assign(deletes, { messageLimitsDeleteGuard: lengthGuard });
    return deletes;
  }
  async function target(suffix: string) {
    const messageId = `${suffix}-${randomUUID()}`;
    const row = {
      sender: { user_id: authorId, is_bot: false },
      recipient: { chat_id: chatId, chat_type: 'chat' },
      timestamp: Date.now() - 60_000,
      body: { mid: messageId, text: 'report fixture' },
    };
    rows.set(messageId, row);
    const settings = await prisma.chatSettings.findUniqueOrThrow({ where: { chatId } });
    const report = await prisma.chatReportCase.create({
      data: {
        chatId,
        messageId,
        authorId,
        originBotId: 'bot',
        contentHash: reportContentHash(row),
        policyRevision: settings.reportsRevision,
        messageCreatedAt: new Date(row.timestamp),
        expiresAt: new Date(Date.now() + REPORT_DAY_MS),
        threshold: 2,
        deleteMode: 'MESSAGE',
        status: 'RUNNING',
        decidedAt: new Date(),
        muteProcessed: true,
      },
    });
    await prisma.chatReportVote.createMany({
      data: [1, 2].map((n) => ({
        caseId: report.id,
        chatId,
        contentVersion: 1,
        reporterId: `voter-${n}`,
        commandMessageId: `${report.id}-${n}`,
      })),
    });
    return report;
  }
  async function prepare(
    deletes: ModerationDeleteIntentService,
    report: Awaited<ReturnType<typeof target>>,
    messageId = report.messageId,
    reasonKey = `report:${report.id}:${messageId}`,
  ) {
    const input = {
      chatId,
      messageId,
      subjectUserId: authorId,
      originBotId: 'bot',
      entityType: 'CHAT' as const,
      messageAuthorKind: 'user' as const,
      routingPolicy: 'delete_capable' as const,
      ruleCode: REPORT_DELETE_RULE,
      reasonKey,
      retryUntilAt: new Date(Date.now() + REPORT_DAY_MS),
      event: {
        userId: authorId,
        metadata: {
          reportCaseId: report.id,
          contentVersion: 1,
          reportTargetMessageId: report.messageId,
        },
      },
    };
    const action = await prisma.chatReportAction.create({ data: { caseId: report.id, messageId } });
    const intent =
      messageId === report.messageId
        ? await deletes.prepareReportTargetIntent(input)
        : await deletes.ensureReportHistoryIntent(input);
    await prisma.chatReportAction.update({
      where: { id: action.id },
      data: { intentId: intent.intentId },
    });
    return intent.intentId!;
  }
  beforeAll(async () => {
    const parsed = new URL(url);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
      !parsed.pathname.includes('race_test')
    )
      throw new Error('Report delete tests require a disposable local race_test database');
    const redisUrl = new URL(process.env.MAXIM_TEST_REDIS_URL ?? '');
    if (!['localhost', '127.0.0.1'].includes(redisUrl.hostname))
      throw new Error('Report delete tests require disposable local Redis');
    queue = new Queue(MODERATION_DELETE_INTENT_QUEUE, {
      connection: { host: redisUrl.hostname, port: Number(redisUrl.port || 6379) },
      prefix: `report-delete-${randomUUID()}`,
    });
    await queue.waitUntilReady();
    add = jest.spyOn(queue, 'add');
    prisma = createPrismaClient(url, { max: 8 });
    await prisma.$connect();
    await prisma.chat.create({
      data: {
        id: chatId,
        title: 'Disposable report deletion boundary',
        settings: { create: { reportsEnabled: true } },
      },
    });
  });
  beforeEach(() => {
    add.mockClear();
    max.deleteMessage.mockClear();
    remoteMutation.mockClear();
    max.getExactMessageRow.mockClear();
    max.getChatMemberAccess.mockClear();
  });
  afterAll(async () => {
    if (queue) {
      await queue.obliterate({ force: true });
      await queue.close();
    }
    if (!prisma) return;
    await prisma.chat.deleteMany({ where: { id: chatId } });
    await prisma.$disconnect();
  });
  it.each(['off', 'shadow', 'canary', 'on'])(
    'executes a reloaded report under generic mode %s with its final report guard',
    async (mode) => {
      const report = await target(mode);
      const writer = service(mode);
      const id = await prepare(writer, report);
      expect(add).not.toHaveBeenCalled();
      const recovered = service(mode);
      await recovered.enqueueCurrentIntentWakeupStrict(id);
      expect(add).toHaveBeenCalledWith(
        expect.any(String),
        { intentId: id },
        expect.objectContaining({ priority: 1 }),
      );
      const result = await recovered.attemptIntent(id);
      expect(result.status).toBe('SUCCEEDED');
      expect(max.deleteMessage).toHaveBeenCalledTimes(1);
      expect(max.getChatMemberAccess).toHaveBeenCalledWith(
        chatId,
        authorId,
        expect.objectContaining({ trafficClass: 'critical' }),
      );
      expect(await recovered.attemptIntent(id)).toMatchObject({ status: 'SUCCEEDED' });
      expect(max.deleteMessage).toHaveBeenCalledTimes(1);
    },
  );
  it('settles a revoked report-only intent instead of requeueing its own reason', async () => {
    const report = await target('revoked');
    const deletes = service('on');
    const id = await prepare(deletes, report);
    await prisma.chatReportCase.update({ where: { id: report.id }, data: { status: 'CANCELLED' } });
    expect(await deletes.attemptIntent(id)).toMatchObject({ status: 'FAILED_TERMINAL' });
    expect(await prisma.moderationDeleteIntent.findUniqueOrThrow({ where: { id } })).toMatchObject({
      lastErrorCode: 'moderation_delete_reasons_no_longer_authorized',
      status: 'FAILED_TERMINAL',
    });
    expect(add).not.toHaveBeenCalled();
    expect(rows.has(report.messageId)).toBe(true);
  });
  it('settles stored report intents after the report admission switch turns off', async () => {
    const report = await target('off-switch');
    const id = await prepare(service('off'), report);
    expect(await service('off', 'off').attemptIntent(id)).toMatchObject({
      status: 'FAILED_TERMINAL',
    });
    expect(remoteMutation).not.toHaveBeenCalled();
    expect(rows.has(report.messageId)).toBe(true);
  });
  it.each(
    ['off', 'shadow', 'canary'].flatMap((mode) =>
      ['generic-first', 'report-first'].flatMap((order) =>
        ['cancelled', 'disabled'].map((revocation) => ({ mode, order, revocation })),
      ),
    ),
  )(
    'does not inherit report authorization through a dormant generic reason: %p',
    async ({ mode, order, revocation }) => {
      const report = await target(`dormant-${mode}-${order}-${revocation}`);
      const generic = () =>
        service('shadow').ensureIntent({
          chatId,
          messageId: report.messageId,
          ruleCode: 'ANTI_SPAM',
          reasonKey: 'ANTI_SPAM',
          entityType: 'CHAT',
          originBotId: 'bot',
          subjectUserId: authorId,
          messageAuthorKind: 'user',
          routingPolicy: 'delete_capable',
        });
      if (order === 'generic-first') await generic();
      const id = await prepare(service(mode), report);
      if (order === 'report-first') await generic();
      expect(await prisma.moderationDeleteIntentReason.count({ where: { intentId: id } })).toBe(2);
      if (revocation === 'cancelled')
        await prisma.chatReportCase.update({
          where: { id: report.id },
          data: { status: 'CANCELLED' },
        });
      else await prisma.chatSettings.update({ where: { chatId }, data: { reportsEnabled: false } });
      try {
        expect(await service(mode).attemptIntent(id)).toMatchObject({ status: 'FAILED_TERMINAL' });
        expect(remoteMutation).not.toHaveBeenCalled();
        expect(rows.has(report.messageId)).toBe(true);
      } finally {
        if (revocation === 'disabled')
          await prisma.chatSettings.update({ where: { chatId }, data: { reportsEnabled: true } });
      }
    },
  );
  it.each([
    { mode: 'on', ruleCode: 'MESSAGE_TOO_LONG_DELETE' },
    { mode: 'off', ruleCode: 'SLOW_MODE_DELETE' },
  ])(
    'retains independently executable authority when a merged report is revoked: %p',
    async ({ mode, ruleCode }) => {
      const report = await target('executable-independent');
      const settings = await prisma.chatSettings.update({
        where: { chatId },
        data: {
          maxMessageLengthEnabled: true,
          maxMessageLength: 10,
          slowModeEnabled: true,
          slowModeIntervalSeconds: 30,
          trafficPolicyEffectiveAt: new Date(Date.now() - 1000),
        },
      });
      const hit = await new TrafficProtectionDetector({
        claimEventCooldown: async () => 'blocked',
      } as never).detect({
        chatId,
        userId: authorId,
        messageId: report.messageId,
        eventTimestampMs: Date.now(),
        eventType: 'message_created',
        text: 'report fixture',
        media: {},
        settings,
      });
      const deletes = service(mode);
      const id = await prepare(deletes, report);
      await deletes.ensureIntent({
        chatId,
        messageId: report.messageId,
        ruleCode,
        reasonKey: ruleCode,
        entityType: 'CHAT',
        originBotId: 'bot',
        subjectUserId: authorId,
        messageAuthorKind: 'user',
        routingPolicy: 'delete_capable',
        event: { metadata: ruleCode === 'SLOW_MODE_DELETE' ? hit!.metadata : {} },
      });
      await prisma.chatReportCase.update({
        where: { id: report.id },
        data: { status: 'CANCELLED' },
      });
      expect(await service(mode).attemptIntent(id)).toMatchObject({ status: 'SUCCEEDED' });
      expect(remoteMutation).toHaveBeenCalledWith(report.messageId);
    },
  );
  it.each([NaN, Infinity, Date.now() - 120_000 + 0.5])(
    'rejects history with an invalid MAX timestamp %s',
    async (timestamp) => {
      const report = await target('invalid-history-time');
      const deletes = service('off');
      await prisma.chatReportCase.update({
        where: { id: report.id },
        data: { deleteMode: 'HISTORY_24H' },
      });
      const targetId = await prepare(deletes, report);
      await prisma.moderationDeleteIntent.update({
        where: { id: targetId },
        data: {
          status: 'SUCCEEDED',
          remoteDeleteSucceededAt: new Date(),
          remoteDeleteSucceededBotId: 'bot',
        },
      });
      const messageId = `invalid-timestamp-${randomUUID()}`;
      rows.set(messageId, {
        sender: { user_id: authorId, is_bot: false },
        recipient: { chat_id: chatId, chat_type: 'chat' },
        timestamp,
        body: { mid: messageId, text: 'invalid timestamp fixture' },
      });
      const id = await prepare(deletes, report, messageId);
      expect(await deletes.attemptIntent(id)).toMatchObject({ status: 'FAILED_TERMINAL' });
      expect(remoteMutation).not.toHaveBeenCalled();
      expect(rows.has(messageId)).toBe(true);
    },
  );
  it.each([
    ['a-revoked', 'z-valid'],
    ['z-revoked', 'a-valid'],
  ])(
    'executes shared history using the remaining valid case with reason order %s / %s',
    async (revokedKey, validKey) => {
      const deletes = service('off');
      const revoked = await target('revoked-shared');
      const valid = await target('valid-shared');
      for (const report of [revoked, valid]) {
        await prisma.chatReportCase.update({
          where: { id: report.id },
          data: { deleteMode: 'HISTORY_24H' },
        });
        const id = await prepare(deletes, report);
        await prisma.moderationDeleteIntent.update({
          where: { id },
          data: {
            status: 'SUCCEEDED',
            remoteDeleteSucceededAt: new Date(),
            remoteDeleteSucceededBotId: 'bot',
          },
        });
      }
      const messageId = `shared-history-${randomUUID()}`;
      rows.set(messageId, {
        sender: { user_id: authorId, is_bot: false },
        recipient: { chat_id: chatId, chat_type: 'chat' },
        timestamp: Date.now() - 120_000,
        body: { mid: messageId, text: 'shared history fixture' },
      });
      const id = await prepare(deletes, revoked, messageId, revokedKey);
      expect(await prepare(deletes, valid, messageId, validKey)).toBe(id);
      await prisma.chatReportCase.update({
        where: { id: revoked.id },
        data: { status: 'CANCELLED' },
      });
      expect(await service('off').attemptIntent(id)).toMatchObject({ status: 'SUCCEEDED' });
      expect(max.deleteMessage).toHaveBeenCalledTimes(1);
      expect(max.deleteMessage).toHaveBeenCalledWith(
        chatId,
        messageId,
        expect.objectContaining({ trafficClass: 'background', actionHealthLane: 'background' }),
      );
      expect(max.getChatMemberAccess).toHaveBeenCalledWith(
        chatId,
        authorId,
        expect.objectContaining({ trafficClass: 'background' }),
      );
      expect(max.getExactMessageRow).toHaveBeenCalledWith(
        chatId,
        messageId,
        expect.objectContaining({ trafficClass: 'background' }),
      );
    },
  );
  it('protects an active counter from generic delayed cleanup after report settings are disabled', async () => {
    const report = await target('generic-counter');
    const counterId = `active-counter-${randomUUID()}`;
    await prisma.chatReportCase.update({
      where: { id: report.id },
      data: { status: 'COLLECTING', counterMessageId: counterId },
    });
    await prisma.chatSettings.update({
      where: { chatId },
      data: { reportsEnabled: false, deleteBotMessagesEnabled: true },
    });
    const deletes = service('on');
    const intent = await deletes.ensureIntent({
      chatId,
      messageId: counterId,
      ruleCode: 'BOT_MESSAGE_AUTO_DELETE',
      reasonKey: 'BOT_MESSAGE_AUTO_DELETE',
      originBotId: 'bot',
      subjectUserId: 'bot-user',
      messageAuthorKind: 'bot',
      entityType: 'CHAT',
      routingPolicy: 'origin_only',
    });
    try {
      await expect(deletes.attemptIntent(intent.intentId!)).rejects.toThrow('Активный счётчик');
      expect(
        await prisma.moderationDeleteIntent.findUniqueOrThrow({ where: { id: intent.intentId! } }),
      ).toMatchObject({
        status: 'RETRYABLE',
        deleteDispatchStartedAt: null,
        remoteDeleteSucceededAt: null,
      });
      expect(remoteMutation).not.toHaveBeenCalled();
    } finally {
      await prisma.chatSettings.update({ where: { chatId }, data: { reportsEnabled: true } });
    }
  });
  it('admits report history below the urgent priority after reload', async () => {
    const report = await target('history');
    const deletes = service('off');
    const id = await prepare(deletes, report, `historical-${randomUUID()}`);
    expect(add).toHaveBeenCalledWith(
      expect.any(String),
      { intentId: id },
      expect.objectContaining({ priority: 10 }),
    );
    add.mockClear();
    await service('off').enqueueCurrentIntentWakeupStrict(id);
    expect(add).toHaveBeenCalledWith(
      expect.any(String),
      { intentId: id },
      expect.objectContaining({ priority: 10 }),
    );
  });
  it('keeps independent urgent deletion ahead when report history merges into the same intent', async () => {
    const report = await target('mixed-priority');
    const messageId = `mixed-${randomUUID()}`;
    const deletes = service('on');
    const urgent = await deletes.ensureIntent({
      chatId,
      messageId,
      ruleCode: 'ANTI_SPAM',
      reasonKey: 'ANTI_SPAM',
      entityType: 'CHAT',
      originBotId: 'bot',
      subjectUserId: authorId,
      messageAuthorKind: 'user',
      routingPolicy: 'delete_capable',
    });
    add.mockClear();
    expect(await prepare(deletes, report, messageId)).toBe(urgent.intentId);
    expect(add).toHaveBeenCalledWith(
      expect.any(String),
      { intentId: urgent.intentId },
      expect.objectContaining({ priority: 1 }),
    );
  });
});
