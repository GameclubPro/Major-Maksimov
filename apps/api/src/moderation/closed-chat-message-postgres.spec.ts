import { randomUUID } from 'node:crypto';
import { createMultibotHarness } from '../webhook/webhook-multibot-fullpath.spec-support';
import { WebhookParser } from '../webhook/webhook.parser';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import { createPrismaClient, type PrismaClient } from '../prisma/prisma-client';
import {
  ClosedChatMessageModerationService,
  type ClosedChatMessageDependencies,
} from './closed-chat-message-moderation.service';
import { ModerationDeleteIntentService } from './moderation-delete-intent.service';
import {
  MODERATION_DELETE_INTENT_QUEUE,
  type ModerationDeleteIntentJob,
} from './moderation-delete-intent.queue';
import {
  buildModerationMessageViolationProcessingClaimKey,
  claimPersistedModerationMessageViolation,
} from './moderation-message-action-claim';
const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() || process.env.REDIS_URL?.trim() || '';
(databaseUrl ? describe : describe.skip)(
  'closed-chat intent and claim recovery with PostgreSQL/Redis',
  () => {
    let prisma: PrismaClient;
    let queue: Queue<ModerationDeleteIntentJob>;
    let intents: ModerationDeleteIntentService;
    const chatId = `closed-chat-${randomUUID()}`;
    const maxClient = { deleteMessage: jest.fn() };
    function makeIntents(mode = 'on') {
      return new ModerationDeleteIntentService(
        prisma as never,
        maxClient as never,
        {} as never,
        queue,
        new ConfigService({ MODERATION_DELETE_INTENT_MODE: mode }),
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
    }
    beforeAll(async () => {
      const pg = new URL(databaseUrl),
        redis = new URL(redisUrl);
      if (
        !['127.0.0.1', 'localhost', '[::1]'].includes(pg.hostname) ||
        !pg.pathname.includes('race_test') ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(redis.hostname) ||
        redis.protocol !== 'redis:' ||
        redis.search ||
        redis.hash
      )
        throw Error('Disposable local PostgreSQL race_test and Redis required');
      prisma = createPrismaClient(databaseUrl, { max: 8 });
      await prisma.$connect();
      await prisma.chat.create({ data: { id: chatId, title: 'Closed-chat refactor fixture' } });
      queue = new Queue(MODERATION_DELETE_INTENT_QUEUE, {
        prefix: `closed-chat-test-${randomUUID()}`,
        connection: {
          host: redis.hostname,
          port: Number(redis.port || 6379),
          db: Number(redis.pathname.slice(1) || 0),
          maxRetriesPerRequest: 1,
        },
      });
      await queue.waitUntilReady();
      intents = makeIntents();
    });
    afterAll(async () => {
      // FLAG: This queue has a random local test namespace and no workers or production jobs.
      if (queue) {
        await queue.obliterate();
        await queue.close();
      }
      if (prisma) {
        await prisma.chat.deleteMany({ where: { id: chatId } });
        await prisma.$disconnect();
      }
    });
    function harness(overrides: Partial<ClosedChatMessageDependencies> = {}) {
      const executeDelete = jest.fn(async () => ({
        accepted: true,
        gone: true,
        deleted: true,
        eventPersistedByIntent: false,
        botId: null,
      }));
      const dependencies: ClosedChatMessageDependencies = {
        ensureBothReasons: async (manual, night) => {
          await intents.ensureClosedChatReasons(
            { ...manual, originBotId: 'fixture-bot', routingPolicy: 'origin_only' },
            { ...night, originBotId: 'fixture-bot', routingPolicy: 'origin_only' },
          );
        },
        ensureIntent: async (input) => {
          // FLAG: Production composition adds the active bot route before intent persistence.
          await intents.ensureIntent({
            ...input,
            originBotId: 'fixture-bot',
            routingPolicy: 'origin_only',
          });
        },
        claimAction: async (input) => {
          const persisted = await prisma.moderationDeleteIntent.findUnique({
            where: { chatId_messageId: { chatId: input.chatId, messageId: input.messageId } },
          });
          expect(persisted).not.toBeNull();
          const data = { ...input, updateType: 'message_action' };
          const key = buildModerationMessageViolationProcessingClaimKey(data);
          return (
            (await claimPersistedModerationMessageViolation({
              model: {
                createMany: (args) => prisma.moderationViolationMessageClaim.createMany(args),
              },
              data: { ...data, dedupeKey: key.dedupeKey },
            })) === 'claimed'
          );
        },
        executeDelete,
        createEvent: (input) => prisma.moderationEvent.create(input),
        warn: jest.fn(),
        ...overrides,
      };
      return { service: new ClosedChatMessageModerationService(dependencies), executeDelete };
    }
    const message = (messageId: string) => ({
      chatId,
      userId: 'fixture-user',
      messageId,
      text: 'fixture',
      createdAt: new Date().toISOString(),
      nightModeStartTimeMinutes: 1380,
      nightModeEndTimeMinutes: 480,
      nightModeTimezone: 'Europe/Moscow',
    });
    const row = (messageId: string) =>
      prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { chatId_messageId: { chatId, messageId } },
        include: { reasons: true },
      });
    it('gives concurrent night/manual handlers one action owner and one event', async () => {
      const a = harness(),
        b = harness(),
        input = message('race');
      await Promise.all([
        a.service.handleNightModeMessage(input),
        b.service.handleNightModeForceCloseMessage({
          ...input,
          nightModeForceCloseForever: true,
          nightModeForceCloseUntil: '',
        }),
      ]);
      expect(a.executeDelete.mock.calls.length + b.executeDelete.mock.calls.length).toBe(1);
      expect(await prisma.moderationEvent.count({ where: { chatId, messageId: 'race' } })).toBe(1);
      const intent = await row('race');
      expect(intent.reasons.map((x) => x.ruleCode).sort()).toEqual([
        'MANUAL_GROUP_CLOSE_DELETE',
        'NIGHT_MODE_DELETE',
      ]);
      expect(await queue.getJob(`mdi-${intent.id}`)).not.toBeNull();
      const restarted = harness();
      await restarted.service.handleNightModeMessage(input);
      expect(restarted.executeDelete).not.toHaveBeenCalled();
    });
    it('keeps a recoverable intent if execution stops before the claim', async () => {
      const input = message('before-claim');
      const stopped = harness({
        claimAction: async () => {
          throw Error('simulated stop');
        },
      });
      await expect(stopped.service.handleNightModeMessage(input)).rejects.toThrow('simulated stop');
      const persisted = await row('before-claim');
      expect(persisted.status).toBe('PENDING');
      expect(persisted.reasons).toHaveLength(1);
      expect(await queue.getJob(`mdi-${persisted.id}`)).not.toBeNull();
      const restarted = harness();
      await restarted.service.handleNightModeMessage(input);
      await restarted.service.handleNightModeMessage(input);
      expect(restarted.executeDelete).toHaveBeenCalledTimes(1);
      expect((await row('before-claim')).id).toBe(persisted.id);
    });
    it('leaves the durable wakeup after a claimed execution fails, without duplicate events', async () => {
      const input = message('after-claim');
      const stopped = harness({
        executeDelete: async () => {
          throw Error('simulated stop');
        },
      });
      await stopped.service.handleNightModeMessage(input);
      const persisted = await row('after-claim');
      expect(persisted.status).toBe('PENDING');
      expect(await queue.getJob(`mdi-${persisted.id}`)).not.toBeNull();
      const replay = harness();
      await replay.service.handleNightModeMessage(input);
      expect(replay.executeDelete).not.toHaveBeenCalled();
      expect(
        await prisma.moderationEvent.count({ where: { chatId, messageId: 'after-claim' } }),
      ).toBe(0);
      const outsideBaseRollout = makeIntents('off');
      const outcome = await outsideBaseRollout.attemptIntent(persisted.id);
      expect(outcome).toMatchObject({ kind: 'pending', status: 'RETRYABLE' });
      expect(outcome.confirmed).toBe(false);
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect((await row('after-claim')).attemptCount).toBe(1);
    });
  },
);

(databaseUrl && redisUrl ? it : it.skip)(
  'keeps the night reason from one real receipt when the manual timer expires before dispatch',
  async () => {
    const h = await createMultibotHarness({ databaseUrl, redisUrl, bots: 1, mode: 'on' });
    try {
      await h.pause();
      await h.deleteQueue.pause();
      const [chatId] = await h.seedCatalog(1, {
        nightModeEnabled: true,
        nightModeStartTimeMinutes: 0,
        nightModeEndTimeMinutes: 0,
        nightModeTimezone: 'UTC',
        nightModeForceCloseEnabled: true,
        nightModeForceCloseForever: false,
        nightModeForceCloseHours: 1,
      });
      const original = Date.now() - 1_000;
      const until = Date.now() + 5_000;
      await h.prisma.chatSettings.update({
        where: { chatId: chatId! },
        data: {
          nightModeForceCloseUntil: new Date(until).toISOString(),
        },
      });
      const messageId = randomUUID();
      const row = {
        sender: { user_id: 'fixture-user', is_bot: false },
        recipient: { chat_id: chatId!, chat_type: 'chat' },
        timestamp: original,
        body: { mid: messageId, text: 'hello' },
      };
      h.messages.set(messageId, row);
      const parsed = new WebhookParser().parse(
        {
          update_type: 'message_created',
          update_id: randomUUID(),
          timestamp: original + 500,
          message: row,
        },
        { botId: h.bots[0]!.id },
      );
      const receipt = (await h.ingress.storeReceipt(parsed, null)).webhookEventId!;
      h.receiptIds.push(receipt);
      await h.ingress.preparePersistedWebhookEvent(receipt);
      const where = { chatId_messageId: { chatId: chatId!, messageId } };
      // FLAG: Stop the inline waiter after both reasons commit. A restarted worker below
      // performs the real guarded dispatch against the harness's isolated MAX adapter.
      jest.spyOn(h.intents, 'ensureAndAttempt').mockImplementationOnce(async () => ({
        confirmed: false,
        kind: 'pending',
        status: 'PENDING',
        intentId: (await h.prisma.moderationDeleteIntent.findUniqueOrThrow({ where })).id,
      }));
      await h.moderation.processWebhookEvent(receipt);
      const intent = await h.prisma.moderationDeleteIntent.findUniqueOrThrow({
        where,
        include: { reasons: true },
      });
      expect(intent.sourceMessageAt?.getTime()).toBe(original);
      expect(intent.reasons.map((reason) => reason.ruleCode).sort()).toEqual([
        'MANUAL_GROUP_CLOSE_DELETE',
        'NIGHT_MODE_DELETE',
      ]);
      expect(h.effects.filter((effect) => effect.method === 'delete')).toHaveLength(0);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, until - Date.now() + 5)));
      expect(await h.intents.attemptIntent(intent.id)).toMatchObject({ kind: 'confirmed' });
      expect(await h.intents.attemptIntent(intent.id)).toMatchObject({ kind: 'confirmed' });
      expect(
        h.effects.filter((effect) => effect.method === 'delete' && effect.messageId === messageId),
      ).toHaveLength(1);
      const events = await h.prisma.moderationEvent.findMany({
        where: { chatId, messageId, action: 'DELETE_MESSAGE' },
        select: { ruleCode: true },
      });
      expect(events).toEqual([{ ruleCode: 'NIGHT_MODE_DELETE' }]);
    } finally {
      jest.restoreAllMocks();
      await h.dispose();
    }
  },
  40_000,
);
