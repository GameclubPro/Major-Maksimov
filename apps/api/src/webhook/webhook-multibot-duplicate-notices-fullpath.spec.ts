import { randomUUID } from 'node:crypto';
import { RedisCounterService } from '../moderation/redis-counter.service';
import { Queue, QueueEvents, Worker, type ConnectionOptions } from 'bullmq';
import Redis from 'ioredis';
import { MaxActionDispatchService } from '../max/max-action-dispatch.service';
import { MaxActionProcessor } from '../max/max-action.processor';
import type { MaxActionJob } from '../max/max-client.service';
import type { MaxActionDispatchOptions, MaxSendMessageOptions } from '../max/max-client.service';
import {
  buildMessageDuplicateNoticeContext,
  messageDuplicateNoticeSettingsDigest,
  readMessageDuplicateNoticeProof,
} from '../moderation/message-duplicate/message-duplicate-notice-proof';
import { extractDuplicateMessageContent } from '../moderation/message-duplicate/message-duplicate-content';
import { MESSAGE_DUPLICATE_CONTROL_KEY } from '../moderation/message-duplicate/message-duplicate-policy.service';
import { bindMessageLimitEvidence } from '../moderation/message-limits-delete-guard.service';
import { CommercialAdDetector } from '../moderation/commercial';
import type { EnsureModerationDeleteIntentInput } from '../moderation/moderation-delete-intent.types';
import {
  createMultibotHarness,
  type MultibotHarness,
} from './webhook-multibot-fullpath.spec-support';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const describeStores = databaseUrl && redisUrl ? describe : describe.skip;
jest.setTimeout(60_000);

describeStores(
  'native mirrored duplicate DELETE → durable Bull notice → actual final authority',
  () => {
    let h: MultibotHarness | undefined;
    let queue: Queue | undefined;
    let events: QueueEvents | undefined;
    let worker: Worker | undefined;
    let connection: Redis | undefined;
    let previousRole: string | undefined;
    beforeEach(() => {
      previousRole = process.env.APP_ROLE;
    });
    afterEach(async () => {
      await worker?.close();
      await events?.close();
      await queue?.obliterate({ force: true });
      await queue?.close();
      await connection?.quit();
      await h?.dispose();
      if (previousRole === undefined) delete process.env.APP_ROLE;
      else process.env.APP_ROLE = previousRole;
      h = undefined;
      queue = undefined;
      events = undefined;
      worker = undefined;
      connection = undefined;
      previousRole = undefined;
    });

    async function harness(
      bots = 9,
      settings: Parameters<MultibotHarness['seedCatalog']>[1] = {},
      beforeImmediateSend?: () => Promise<void>,
    ) {
      h = await createMultibotHarness({ databaseUrl, redisUrl, bots, mode: 'on' });
      const s = h;
      await s.redis.set(
        MESSAGE_DUPLICATE_CONTROL_KEY,
        JSON.stringify({
          version: 2,
          revision: 1,
          mode: 'full',
          scope: 'all_enabled_chats',
          chatIds: [],
          effectiveAt: new Date(Date.now() - 1_000).toISOString(),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      );
      const [chatId] = await s.seedCatalog(1, {
        maxMessageLengthEnabled: false,
        antiDuplicateEnabled: true,
        duplicateCompareMode: 'TEXT',
        duplicateBotMessageEnabled: true,
        duplicateWarnEnabled: false,
        duplicateMuteEnabled: false,
        duplicateBanEnabled: false,
        duplicateWarnMaxCount: 2,
        ...settings,
      });
      if (!chatId) throw new Error('Expected native chat fixture');
      connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
      const queueName = `duplicate-notice-native-${randomUUID()}`;
      queue = new Queue(queueName, { connection: connection as unknown as ConnectionOptions });
      events = new QueueEvents(queueName, {
        connection: connection as unknown as ConnectionOptions,
      });
      await events.waitUntilReady();
      const currentQueue = queue;
      const jobs: MaxActionJob[] = [];
      const immediateSends: {
        chat: string;
        text: string;
        options?: MaxSendMessageOptions;
        dispatch?: MaxActionDispatchOptions;
      }[] = [];
      const originalSend = s.max.sendMessage.bind(s.max);
      jest.spyOn(s.max, 'sendMessage').mockImplementation(async (chat, text, options, dispatch) => {
        if (dispatch?.immediate === true) {
          immediateSends.push({ chat, text, options, dispatch });
          await beforeImmediateSend?.();
          return originalSend(chat, text, options, dispatch);
        }
        const action: MaxActionJob = {
          actionType: 'SEND_MESSAGE',
          chatId: chat,
          botId: s.bots.at(-1)!.id,
          text,
          options,
          ledgerContext: dispatch?.ledgerContext,
          sourceTag: dispatch?.sourceTag,
          trafficClass: dispatch?.trafficClass,
          actionHealthLane: dispatch?.actionHealthLane,
          idempotencyKey: dispatch?.idempotencyKey ?? 'missing-notice-identity',
          createdAt: new Date().toISOString(),
          attempt: 1,
        };
        if (!readMessageDuplicateNoticeProof(action.ledgerContext?.duplicateNotice))
          throw new Error('Expected production duplicate producer original v3 proof');
        jobs.push(action);
        await s.ledger.recordEnqueuedIfAbsent(action);
        await currentQueue.add('guarded-notice', action, { jobId: randomUUID(), attempts: 1 });
      });
      const startWorker = () => {
        process.env.APP_ROLE = 'action';
        const dispatch = new MaxActionDispatchService(
          s.max,
          undefined,
          s.ledger,
          s.links,
          s.config,
        );
        const processor = new MaxActionProcessor(dispatch);
        worker = new Worker<MaxActionJob>(
          queueName,
          async (queuedJob) => processor.process(queuedJob),
          { connection: connection as unknown as ConnectionOptions, concurrency: 1 },
        );
        worker.on('error', () => undefined);
      };
      const deliver = async (jobIndex = 0) => {
        const queued = await currentQueue.getWaiting();
        const job = queued[jobIndex];
        if (!job) throw new Error('Expected durable Bull notice job');
        startWorker();
        return job.waitUntilFinished(events!, 20_000);
      };
      return { s, chatId, jobs, deliver, currentQueue, startWorker, immediateSends, originalSend };
    }

    async function realDuplicate(bots = 9) {
      const f = await harness(bots);
      const originalId = `original-${randomUUID()}`;
      const duplicateId = `duplicate-${randomUUID()}`;
      const text = 'One repeated participant message for native queued notice authority';
      for (const messageId of [originalId, duplicateId]) {
        const at = Date.now();
        await Promise.all(
          f.s.bots.map((bot) =>
            f.s.ingest({
              chatId: f.chatId,
              messageId,
              text,
              at,
              botId: bot.id,
            }),
          ),
        );
        await f.s.drain();
      }
      expect(f.jobs).toHaveLength(1);
      const proof = readMessageDuplicateNoticeProof(f.jobs[0]!.ledgerContext?.duplicateNotice)!;
      const intent = await f.s.prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { id: proof.intentId },
        include: { reasons: true },
      });
      expect(intent.status).toBe('SUCCEEDED');
      expect(intent.reasons[0]!.metadata).toMatchObject({ moderationDeleteVerified: true });
      expect(f.s.effects.filter((effect) => effect.method === 'delete')).toHaveLength(1);
      expect(f.s.effects.filter((effect) => effect.method === 'post')).toHaveLength(0);
      return { ...f, originalId, duplicateId, proof, intent };
    }

    it('enforces modern duplicates alongside review-only commercial telemetry across mirrored receipts', async () => {
      const f = await harness(4, { commercialAdsFilterEnabled: true });
      const text =
        'Водитель Абакан-Аскиз-ст. Аскиза 11.40-12.00 +7 900 000 00 00 с места до места завтра';
      const originalId = `review-original-${randomUUID()}`;
      const duplicateId = `review-duplicate-${randomUUID()}`;
      const receipts: string[] = [];
      for (const messageId of [originalId, duplicateId]) {
        const at = Date.now();
        receipts.push(
          ...(await Promise.all(
            f.s.bots.map((bot) =>
              f.s.ingest({ chatId: f.chatId, messageId, text, at, botId: bot.id }),
            ),
          )),
        );
        await f.s.drain();
      }
      expect(f.jobs).toHaveLength(1);
      const proof = readMessageDuplicateNoticeProof(f.jobs[0]!.ledgerContext?.duplicateNotice)!;
      const intent = await f.s.prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { id: proof.intentId },
        include: { reasons: true },
      });
      expect(intent.messageId).toBe(duplicateId);
      expect(intent.status).toBe('SUCCEEDED');
      expect(intent.reasons).toHaveLength(1);
      expect(intent.reasons[0]!.metadata).toMatchObject({ moderationDeleteVerified: true });
      expect(f.s.messages.has(originalId)).toBe(true);
      expect(f.s.messages.has(duplicateId)).toBe(false);
      expect(f.s.effects.filter((effect) => effect.method === 'delete')).toHaveLength(1);
      expect(f.s.effects.filter((effect) => effect.method === 'post')).toHaveLength(0);
      expect(
        await f.s.prisma.violation.count({
          where: { chatId: f.chatId, ruleCode: 'COMMERCIAL_AD' },
        }),
      ).toBe(0);
      const settledReceipts = await f.s.prisma.webhookEvent.findMany({
        where: { id: { in: receipts } },
        select: {
          id: true,
          botId: true,
          semanticKey: true,
          status: true,
          processedAt: true,
          errorMessage: true,
          nextEnqueueAt: true,
          timeoutQuarantineExpiresAt: true,
        },
      });
      expect(settledReceipts).toHaveLength(receipts.length);
      // FLAG: One semantic execution completes each source; its bot mirrors settle as
      // DUPLICATE. Both terminal states require cleared retries and positive settlement time.
      const semanticKeys = [...new Set(settledReceipts.map((receipt) => receipt.semanticKey))];
      expect(semanticKeys).toHaveLength(2);
      expect(semanticKeys).not.toContain(null);
      for (const semanticKey of semanticKeys) {
        const sourceReceipts = settledReceipts.filter(
          (receipt) => receipt.semanticKey === semanticKey,
        );
        expect(sourceReceipts).toHaveLength(f.s.bots.length);
        expect(new Set(sourceReceipts.map((receipt) => receipt.botId)).size).toBe(f.s.bots.length);
        expect(sourceReceipts.map((receipt) => receipt.status).sort()).toEqual([
          'DUPLICATE',
          'DUPLICATE',
          'DUPLICATE',
          'PROCESSED',
        ]);
        for (const receipt of sourceReceipts) {
          expect(receipt).toMatchObject({
            processedAt: expect.any(Date),
            errorMessage: null,
            nextEnqueueAt: null,
            timeoutQuarantineExpiresAt: null,
          });
        }
      }
      expect(
        await f.s.prisma.webhookExecutionClaim.count({
          where: {
            kind: 'EXECUTION',
            webhookEventId: { in: receipts },
            status: 'COMPLETED',
          },
        }),
      ).toBe(2);
      expect(f.s.failures).toHaveLength(0);
    });

    it('retains modern duplicate exclusion for a competing commercial WARN owner', async () => {
      const f = await harness(4, { commercialAdsFilterEnabled: true });
      const observe = jest.spyOn(f.s.duplicateService, 'observe');
      const detectCommercial = CommercialAdDetector.prototype.detect;
      const commercial = jest
        .spyOn(CommercialAdDetector.prototype, 'detect')
        .mockImplementation(function (this: CommercialAdDetector, input) {
          const result = detectCommercial.call(this, input);
          if (!result) throw new Error('Expected commercial classifier fixture');
          return { ...result, actionBand: 'WARN', actionable: true, recordable: true };
        });
      try {
        for (let index = 0; index < 2; index += 1) {
          const at = Date.now();
          const messageId = `commercial-owner-${index}-${randomUUID()}`;
          await Promise.all(
            f.s.bots.map((bot) =>
              f.s.ingest({
                chatId: f.chatId,
                messageId,
                text: 'Водитель Абакан-Аскиз-ст. Аскиза 11.40-12.00 +7 900 000 00 00 с места до места завтра',
                at,
                botId: bot.id,
              }),
            ),
          );
          await f.s.drain();
        }
        expect(observe).toHaveBeenCalledTimes(2);
        for (const [input] of observe.mock.calls) {
          expect(input).toMatchObject({ track: false, actionEligible: false });
        }
        expect(f.jobs).toHaveLength(0);
        expect(f.s.effects).toHaveLength(0);
        expect(f.s.failures).toHaveLength(0);
      } finally {
        commercial.mockRestore();
        observe.mockRestore();
      }
    });

    it.each(['shadow', 'full'] as const)(
      'settles a delayed native history reply and the following same-chat message in %s',
      async (mode) => {
        const f = await harness(1);
        const control = JSON.parse((await f.s.redis.get(MESSAGE_DUPLICATE_CONTROL_KEY))!);
        await f.s.redis.set(MESSAGE_DUPLICATE_CONTROL_KEY, JSON.stringify({ ...control, mode }));
        const original = RedisCounterService.prototype.duplicateWindow;
        let delayed = false;
        let observations = 0;
        const spy = jest
          .spyOn(RedisCounterService.prototype, 'duplicateWindow')
          .mockImplementation(async function (this: RedisCounterService, chatId, input) {
            const result = await original.call(this, chatId, input);
            if (chatId === f.chatId && input.op === 'observe') {
              observations += 1;
              if (!delayed) {
                delayed = true;
                await new Promise((resolve) => setTimeout(resolve, 450));
              }
            }
            return result;
          });
        try {
          const first = await f.s.ingest({
            chatId: f.chatId,
            messageId: `first-${randomUUID()}`,
            text: 'Original alpha',
          });
          await f.s.drain(4_000);
          const next = await f.s.ingest({
            chatId: f.chatId,
            messageId: `next-${randomUUID()}`,
            text: 'Independent beta',
          });
          await f.s.drain(4_000);
          const receipts = await f.s.prisma.webhookEvent.findMany({
            where: { id: { in: [first, next] } },
          });
          expect(receipts).toHaveLength(2);
          expect(receipts.every((receipt) => receipt.status === 'PROCESSED')).toBe(true);
          expect(observations).toBe(2);
          expect(f.s.effects).toHaveLength(0);
          expect(f.jobs).toHaveLength(0);
          expect(f.s.failures).toHaveLength(0);
        } finally {
          spy.mockRestore();
        }
      },
    );

    it.each([1, 4, 9])(
      'publishes one explanation through the selected surviving peer with %i mirrored bots',
      async (bots) => {
        const f = await realDuplicate(bots);
        const selectedBot = f.s.bots.at(-1)!.id;
        if (bots > 1) await f.s.demote(f.chatId, f.s.bots[0]!.id);
        await expect(f.deliver()).resolves.toBeNull();
        const notices = f.s.effects.filter((effect) => effect.method === 'post');
        expect(notices).toHaveLength(1);
        expect(notices[0]!.botId).toBe(selectedBot);
        const authorReads = f.s.requests.filter(
          (request) => request.method === 'get' && request.path.endsWith('/members'),
        );
        expect(authorReads.some((request) => request.botId === selectedBot)).toBe(true);
        expect(
          await f.s.prisma.maxActionLedgerEntry.count({
            where: {
              chatId: f.chatId,
              actionType: 'SEND_MESSAGE',
              status: 'SUCCEEDED',
            },
          }),
        ).toBe(1);
        expect(f.s.failures).toEqual([]);
      },
    );

    it.each([undefined, 'not.found'])(
      'delivers one durable explanation after confirmed DELETE despite generic current GET 404 %s',
      async (code) => {
        const f = await realDuplicate(4);
        f.s.messageLookupFailures.set(f.duplicateId, { status: 404, code });
        await f.s.demote(f.chatId, f.s.bots[0]!.id);
        await expect(f.deliver()).resolves.toBeNull();
        expect(f.s.effects.filter((effect) => effect.method === 'delete')).toHaveLength(1);
        expect(f.s.effects.filter((effect) => effect.method === 'post')).toHaveLength(1);
        expect(
          await f.s.prisma.maxActionLedgerEntry.count({
            where: { chatId: f.chatId, actionType: 'SEND_MESSAGE', status: 'SUCCEEDED' },
          }),
        ).toBe(1);
      },
    );

    it.each(['unverified-reason', 'unfinished-receipt', 'original-unavailable', 'history-reset'])(
      'refuses generic current GET 404 when notice evidence is %s',
      async (change) => {
        const f = await realDuplicate(4);
        f.s.messageLookupFailures.set(f.duplicateId, { status: 404, code: 'not.found' });
        if (change === 'unverified-reason') {
          const reason = f.intent.reasons[0]!;
          await f.s.prisma.moderationDeleteIntentReason.update({
            where: { id: reason.id },
            data: { metadata: { ...(reason.metadata as object), moderationDeleteVerified: false } },
          });
        }
        if (change === 'unfinished-receipt')
          await f.s.prisma.moderationDeleteIntent.update({
            where: { id: f.intent.id },
            data: { status: 'PENDING' },
          });
        if (change === 'original-unavailable') {
          f.s.messages.delete(f.originalId);
          f.s.messageLookupFailures.set(f.originalId, { status: 404, code: 'not.found' });
        }
        if (change === 'history-reset') {
          await f.s.prisma.chatSettings.update({
            where: { chatId: f.chatId },
            data: { antiDuplicateEnabled: false },
          });
          await f.s.prisma.chatSettings.update({
            where: { chatId: f.chatId },
            data: { antiDuplicateEnabled: true },
          });
        }
        await expect(f.deliver()).rejects.toThrow();
        expect(f.s.effects.filter((effect) => effect.method === 'post')).toHaveLength(0);
        expect(f.s.effects.filter((effect) => effect.method === 'delete')).toHaveLength(1);
      },
    );

    it.each(['disabled', 'history-reset', 'original-edit'])(
      'rejects a queued explanation after %s without another HTTP SEND',
      async (change) => {
        const f = await realDuplicate();
        if (change === 'disabled')
          await f.s.prisma.chatSettings.update({
            where: { chatId: f.chatId },
            data: { duplicateBotMessageEnabled: false },
          });
        if (change === 'history-reset') {
          await f.s.prisma.chatSettings.update({
            where: { chatId: f.chatId },
            data: { antiDuplicateEnabled: false },
          });
          await f.s.prisma.chatSettings.update({
            where: { chatId: f.chatId },
            data: { antiDuplicateEnabled: true },
          });
        }
        if (change === 'original-edit') {
          const original = f.s.messages.get(f.originalId)!;
          original.body = {
            ...(original.body as Record<string, unknown>),
            text: 'A changed original',
          };
        }
        await expect(f.deliver()).rejects.toThrow('message_duplicate_notice_no_longer_authorized');
        expect(f.s.effects.filter((effect) => effect.method === 'post')).toEqual([]);
      },
    );

    it('keeps an unknown SEND durable across retry and peer replacement without sending again', async () => {
      const f = await realDuplicate();
      f.s.ambiguousNextSend();
      await expect(f.deliver()).rejects.toThrow();
      expect(f.s.effects.filter((effect) => effect.method === 'post')).toHaveLength(1);
      const row = await f.s.prisma.maxActionLedgerEntry.findFirstOrThrow({
        where: { chatId: f.chatId, actionType: 'SEND_MESSAGE' },
      });
      expect(row.status).toBe('AMBIGUOUS');
      await worker!.close();
      worker = undefined;
      await f.s.demote(f.chatId, f.s.bots.at(-1)!.id);
      const retry = {
        ...f.jobs[0]!,
        botId: f.s.bots[0]!.id,
        idempotencyKey: row.jobId,
        attempt: 2,
      };
      const job = await f.currentQueue.add('guarded-notice-retry', retry, {
        jobId: randomUUID(),
        attempts: 1,
      });
      f.startWorker();
      await expect(job.waitUntilFinished(events!, 20_000)).rejects.toThrow(
        /ambiguous|no longer executable/iu,
      );
      expect(f.s.effects.filter((effect) => effect.method === 'post')).toHaveLength(1);
      expect(
        await f.s.prisma.maxActionLedgerEntry.findUnique({ where: { id: row.id } }),
      ).toMatchObject({
        status: 'AMBIGUOUS',
        ambiguous: true,
        attemptCount: 1,
      });
    });

    it('expires the original notice deadline after the real final Redis permit without SEND', async () => {
      const f = await realDuplicate();
      const actualAuthorization = f.s.authorization.isAllowed.bind(f.s.authorization);
      let authorityReads = 0;
      let deadlineClock: jest.SpyInstance | undefined;
      const permit = jest
        .spyOn(f.s.authorization, 'isAllowed')
        .mockImplementation(async (...args) => {
          const allowed = await actualAuthorization(...args);
          authorityReads += 1;
          if (authorityReads === 2) {
            expect(allowed).toBe(true);
            // FLAG: Preserve the genuine SQL/Redis grant, then expire only the synchronous
            // transport boundary. No authority, qualification or receipt is fabricated.
            deadlineClock = jest.spyOn(Date, 'now').mockReturnValueOnce(f.proof.deadlineAtMs);
          }
          return allowed;
        });
      try {
        await expect(f.deliver()).rejects.toThrow('message_duplicate_notice_no_longer_authorized');
        expect(authorityReads).toBe(2);
        expect(f.s.effects.filter((effect) => effect.method === 'post')).toEqual([]);
      } finally {
        deadlineClock?.mockRestore();
        permit.mockRestore();
      }
    });

    it('does not borrow a length DELETE receipt for a revoked duplicate reason on the same absent source', async () => {
      const f = await harness();
      const settings = await f.s.prisma.chatSettings.findUniqueOrThrow({
        where: { chatId: f.chatId },
      });
      const at = Date.now();
      const text = 'Native mixed-rule original and copy long enough for length deletion';
      const originalId = `mixed-original-${randomUUID()}`;
      const duplicateId = `mixed-copy-${randomUUID()}`;
      const source = (messageId: string, timestamp: number) => ({
        sender: { user_id: 'fixture-user', is_bot: false },
        recipient: { chat_id: f.chatId, chat_type: 'chat' },
        timestamp,
        body: { mid: messageId, text },
      });
      const original = source(originalId, at - 1);
      const current = source(duplicateId, at);
      f.s.messages.set(originalId, original);
      f.s.messages.set(duplicateId, current);
      await f.s.history.observe({
        chatId: f.chatId,
        userId: 'fixture-user',
        messageId: originalId,
        content: extractDuplicateMessageContent(original, false),
        eventTimestampMs: at - 1,
        publishedAtMs: at - 1,
        controlRevision: 1,
        settings,
      });
      const matched = await f.s.history.observe({
        chatId: f.chatId,
        userId: 'fixture-user',
        messageId: duplicateId,
        content: extractDuplicateMessageContent(current, false),
        eventTimestampMs: at,
        publishedAtMs: at,
        controlRevision: 1,
        settings,
      });
      if (!matched) throw new Error('Expected real native Redis duplicate history match');
      const binding = {
        ...matched.binding,
        enforcementScope: 'full' as const,
        authorization: { eventTimestampMs: at, deadlineAtMs: at + 600_000 },
      };
      const count = await f.s.history.qualify(f.chatId, binding);
      expect(count).toBe(1);
      const input: EnsureModerationDeleteIntentInput = {
        chatId: f.chatId,
        messageId: duplicateId,
        subjectUserId: 'fixture-user',
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        sourceMessageAt: new Date(at),
        originBotId: f.s.bots[0]!.id,
        ruleCode: 'DUPLICATE_DELETE',
        reasonKey: `MESSAGE_DUPLICATE:v1:${at}`,
        retryUntilAt: new Date(at + 600_000),
        executeAt: new Date(at + 60_000),
        event: {
          userId: 'fixture-user',
          metadata: {
            duplicateSource: 'message_v1',
            messageDuplicate: binding,
            count,
            enforcementScope: 'full',
          },
        },
      };
      const owned = await f.s.intents.ensureIntent(input, { enqueue: false });
      if (!owned.intentId) throw new Error('Expected durable original duplicate reason');
      expect(f.s.effects).toEqual([]);
      const ledgerContext = await buildMessageDuplicateNoticeContext(
        f.s.prisma as never,
        input,
        messageDuplicateNoticeSettingsDigest(settings),
        { count: 1 },
      );
      const changed = await f.s.prisma.chatSettings.update({
        where: { chatId: f.chatId },
        data: {
          maxMessageLengthEnabled: true,
          maxMessageLength: 20,
          duplicateWarnMaxCount: 3,
        },
      });
      expect(changed.duplicatePolicyRevision).not.toBe(binding.policyRevision);
      await expect(
        f.s.duplicateGuard.assertIntentStillActionable({
          intentId: owned.intentId,
          chatId: f.chatId,
          messageId: duplicateId,
          subjectUserId: 'fixture-user',
          botId: f.s.bots[0]!.id,
        }),
      ).rejects.toThrow('message_duplicate_settings_changed');
      await f.s.intents.ensureIntent(
        {
          ...input,
          executeAt: new Date(at),
          ruleCode: 'MESSAGE_TOO_LONG_DELETE',
          reasonKey: 'MESSAGE_TOO_LONG:violation-delete',
          retryUntilAt: new Date(at + 300_000),
          event: {
            userId: 'fixture-user',
            metadata: bindMessageLimitEvidence(changed, at, 'MESSAGE_TOO_LONG'),
          },
        },
        { enqueue: false },
      );
      await f.s.prisma.moderationDeleteIntent.update({
        where: { id: owned.intentId },
        data: {
          executeAt: new Date(at),
          nextAttemptAt: new Date(at),
        },
      });
      await expect(f.s.intents.attemptIntent(owned.intentId)).resolves.toMatchObject({
        kind: 'confirmed',
      });
      const reason = await f.s.prisma.moderationDeleteIntentReason.findUniqueOrThrow({
        where: {
          intentId_reasonKey: { intentId: owned.intentId, reasonKey: input.reasonKey },
        },
      });
      expect((reason.metadata as Record<string, unknown>).moderationDeleteVerified).not.toBe(true);
      expect(f.s.messages.has(duplicateId)).toBe(false);
      const action: MaxActionJob = {
        actionType: 'SEND_MESSAGE',
        chatId: f.chatId,
        botId: f.s.bots.at(-1)!.id,
        text: 'Queued duplicate explanation',
        ledgerContext,
        idempotencyKey: `message_v1-duplicate:${f.chatId}:${duplicateId}:explanation`,
        createdAt: new Date().toISOString(),
        attempt: 1,
      };
      await f.s.ledger.recordEnqueuedIfAbsent(action);
      await f.currentQueue.add('mixed-notice', action, { jobId: randomUUID(), attempts: 1 });
      await expect(f.deliver()).rejects.toThrow('message_duplicate_notice_no_longer_authorized');
      expect(f.s.effects.filter((effect) => effect.method === 'delete')).toHaveLength(1);
      expect(f.s.effects.filter((effect) => effect.method === 'post')).toEqual([]);
    });

    it.each(['peer-demoted', 'policy-revoked', 'unknown-send'])(
      'guards the actual immediate MUTE notice with original authority after %s across nine mirrors',
      async (change) => {
        let currentMessageId = '';
        const f: Awaited<ReturnType<typeof harness>> = await harness(
          9,
          { duplicateMuteEnabled: true, duplicateMuteMaxCount: 2 },
          async () => {
            if (!currentMessageId) throw new Error('Expected the MUTE source message');
            const receipt = await f.s.waitForConfirmedDelete(f.chatId, currentMessageId);
            expect(receipt.status).toBe('SUCCEEDED');
            expect(receipt.remoteDeleteSucceededAt).toBeInstanceOf(Date);
            const mute = await f.s.prisma.moderationEvent.findFirstOrThrow({
              where: {
                chatId: f.chatId,
                messageId: currentMessageId,
                ruleCode: 'DUPLICATE_MUTE',
                action: 'MUTE',
              },
              select: { metadata: true },
            });
            expect(mute.metadata).toMatchObject({ sanctionApplied: true });
            if (change === 'peer-demoted')
              for (const bot of f.s.bots.slice(0, -1)) await f.s.demote(f.chatId, bot.id);
            if (change === 'policy-revoked')
              await f.s.prisma.chatSettings.update({
                where: { chatId: f.chatId },
                data: { duplicateMuteEnabled: false },
              });
            if (change === 'unknown-send') f.s.ambiguousNextSend();
          },
        );
        const originalGuard = f.s.duplicateGuard.assertMessageStillActionable.bind(
          f.s.duplicateGuard,
        );
        jest
          .spyOn(f.s.duplicateGuard, 'assertMessageStillActionable')
          .mockImplementation(async (input) => {
            // FLAG: This scenario tests a notice after a successful sanction. Wait for
            // the real DELETE receipt before sanction admission so its final guard
            // cannot race an absent source whose receipt is still being committed.
            if (input.sanctionIntentId && input.sanctionPhase === 'initial_unattempted')
              await f.s.waitForConfirmedDelete(input.chatId, input.messageId);
            return originalGuard(input);
          });
        const text = 'Native duplicate mute and guarded successful sanction notification';
        for (let index = 0; index < 3; index += 1) {
          const messageId = `duplicate-mute-${index}-${randomUUID()}`;
          currentMessageId = messageId;
          const at = Date.now();
          await Promise.all(
            f.s.bots.map((bot) =>
              f.s.ingest({
                chatId: f.chatId,
                messageId,
                text,
                at,
                botId: bot.id,
              }),
            ),
          );
          await f.s.drain();
        }
        expect(f.s.failures).toEqual([]);
        expect(f.s.effects.filter((effect) => effect.method === 'delete')).toHaveLength(2);
        expect(f.immediateSends).toHaveLength(1);
        const send = f.immediateSends[0]!;
        expect(send.dispatch!.idempotencyKey).toMatch(/message_v1-duplicate:.*:sanction:mute$/u);
        expect(send.dispatch!.beforeImmediateSendMutation).toEqual(expect.any(Function));
        const posts = f.s.effects.filter((effect) => effect.method === 'post');
        expect(posts).toHaveLength(change === 'policy-revoked' ? 0 : 1);
        if (change === 'peer-demoted') expect(posts[0]!.botId).toBe(f.s.bots.at(-1)!.id);
        if (change === 'unknown-send') {
          await expect(
            f.originalSend(send.chat, send.text, send.options, send.dispatch),
          ).rejects.toThrow(/ambiguous|unresolved/iu);
          expect(f.s.effects.filter((effect) => effect.method === 'post')).toHaveLength(1);
          expect(
            await f.s.prisma.maxActionLedgerEntry.count({
              where: { chatId: f.chatId, actionType: 'SEND_MESSAGE', status: 'AMBIGUOUS' },
            }),
          ).toBe(1);
        }
      },
    );
  },
);
