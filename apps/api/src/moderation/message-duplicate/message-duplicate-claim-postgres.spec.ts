import { registerDuplicateClaimCleanup } from './message-duplicate-claim-cleanup';
import { createHash, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { MaxApiInternalRateLimitError } from '../../max/max-client.service';
import Redis from 'ioredis';
import { RedisCounterService } from '../redis-counter.service';
import { MessageDuplicateDeleteGuardService } from './message-duplicate-delete-guard.service';
import {
  duplicateEnforcementObservation,
  MessageDuplicateEnforcementService,
} from './message-duplicate-enforcement.service';
import {
  duplicateSourceDigest,
  MessageDuplicateHistoryService,
} from './message-duplicate-history.service';
import { MessageDuplicatePolicyService } from './message-duplicate-policy.service';
import { createPrismaClient, Prisma, type PrismaClient } from '../../prisma/prisma-client';
import { ModerationDeleteIntentService } from '../moderation-delete-intent.service';
import type { EnsureModerationDeleteIntentInput } from '../moderation-delete-intent.types';
import { MessageDuplicateAdmissionService } from './message-duplicate-admission.service';
import {
  buildMessageDuplicateIdentity,
  digestDuplicateContent,
  extractDuplicateMessageContent,
} from './message-duplicate-content';
import { resolveDuplicateFlowConfig } from '../duplicate-flow-policy';
import {
  buildMessageDuplicateJobId,
  MessageDuplicateOrderingStore,
} from './message-duplicate.queue';
import {
  buildMessageScopedModerationActionClaimKey,
  claimPersistedModerationMessageViolation,
  type ModerationViolationMessageClaimModel,
  type ModerationMessageActionClaimData,
} from '../moderation-message-action-claim';
import {
  MessageDuplicateAuthorizationService,
  duplicateRevocationKey,
} from './message-duplicate-authorization.service';
import {
  MESSAGE_DUPLICATE_CLAIM_PREFIX,
  MESSAGE_DUPLICATE_MEDIA_VERSION,
  MESSAGE_DUPLICATE_SOURCE,
  messageDuplicateSettingsDigest,
  parseMessageDuplicateBinding,
  type MessageDuplicateBinding,
} from './message-duplicate-state';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
(databaseUrl ? describe : describe.skip)(
  'duplicate authorization and message claim PostgreSQL races',
  () => {
    let prisma: PrismaClient;
    let intents: ModerationDeleteIntentService;
    const chatId = `duplicate-claim-${randomUUID()}`;
    const claim = (
      messageId: string,
      ruleCode = 'DUPLICATE_MESSAGE_ACTION',
    ): ModerationMessageActionClaimData => ({
      dedupeKey: `${chatId}:${messageId}:${ruleCode}`,
      messageActionKey: buildMessageScopedModerationActionClaimKey(chatId, messageId),
      chatId,
      userId: 'user',
      messageId,
      ruleCode,
      updateType: 'message_action',
    });
    const canonicalClaim = (messageId: string) => {
      const own = claim(messageId);
      own.dedupeKey = `${MESSAGE_DUPLICATE_CLAIM_PREFIX}${digestDuplicateContent([chatId, own.userId, messageId])}`;
      return own;
    };
    const jobFor = (own: ModerationMessageActionClaimData, eventTimestampMs = Date.now()) => ({
      chatId,
      messageId: own.messageId,
      eventTimestampMs,
      deadlineAtMs: eventTimestampMs + 600000,
      idempotencyKey: buildMessageDuplicateJobId(chatId, own.messageId, eventTimestampMs),
    });
    const bindingFor = (
      own: ModerationMessageActionClaimData,
      eventTimestampMs: number,
    ): MessageDuplicateBinding => {
      const hash = 'a'.repeat(64);
      return {
        version: 3,
        enforcementScope: 'delete_only',
        lifecycleRevision: hash,
        policyRevision: 0,
        authorization: { eventTimestampMs, deadlineAtMs: eventTimestampMs + 600000 },
        original: {
          member: hash,
          author: hash,
          messageId: 'original',
          senderId: own.userId,
          publishedAtMs: eventTimestampMs - 1000,
          observedAtMs: eventTimestampMs - 1000,
          expiresAtMs: eventTimestampMs + 600000,
          sourceDigest: hash,
          contentDigest: hash,
          mediaHashes: [],
          epoch: 0,
          revision: hash,
          originalId: hash,
        },
        senderId: own.userId,
        messageId: own.messageId,
        eventTimestampMs,
        controlRevision: 1,
        settingsDigest: hash,
        sourceDigest: hash,
        contentDigest: hash,
        fingerprint: hash,
        compareMode: 'TEXT',
        mediaHashes: [],
        mediaVersion: MESSAGE_DUPLICATE_MEDIA_VERSION,
        hasPhotos: false,
        photoControlRevision: null,
        windowSeconds: 600,
        requiredCount: 2,
      };
    };
    const cleanupBindings = new Map<string, MessageDuplicateBinding>();
    const preclaim = async (
      service: ModerationDeleteIntentService,
      own: ModerationMessageActionClaimData,
    ) => {
      if (own.ruleCode !== 'DUPLICATE_MESSAGE_ACTION') {
        // Ordinary rules use an atomic insert and fresh ownership reconciliation.
        const result = await claimPersistedModerationMessageViolation({
          model:
            prisma.moderationViolationMessageClaim as unknown as ModerationViolationMessageClaimModel,
          data: own,
          resumeKnownActionOwner: true,
        });
        return result === 'duplicate' ? 'blocked' : result;
      }
      const binding = cleanupBindings.get(own.dedupeKey) ?? bindingFor(own, Date.now());
      cleanupBindings.set(own.dedupeKey, binding);
      return service.claimMessageActionBeforeQualification(own, binding);
    };
    const handoffFor = (
      own: ModerationMessageActionClaimData,
      binding: MessageDuplicateBinding,
    ) => ({
      claim: own,
      intent: {
        chatId,
        messageId: own.messageId,
        subjectUserId: own.userId,
        entityType: 'CHAT' as const,
        messageAuthorKind: 'user' as const,
        ruleCode: 'DUPLICATE_DELETE',
        reasonKey: `MESSAGE_DUPLICATE:v1:${binding.eventTimestampMs}`,
        retryUntilAt: new Date(binding.authorization!.deadlineAtMs),
        event: {
          userId: own.userId,
          eventType: 'MESSAGE' as const,
          metadata: {
            duplicateSource: MESSAGE_DUPLICATE_SOURCE,
            messageDuplicate: binding,
            enforcementScope: binding.enforcementScope,
          },
        },
      },
    });
    const serviceFor = (database: unknown = prisma) => {
      const service = Object.create(
        ModerationDeleteIntentService.prototype,
      ) as ModerationDeleteIntentService;
      Object.assign(service, {
        prisma: database,
        getRolloutForRule: () => 'execute',
        getRolloutForInput: () => 'execute',
        enqueueCurrentWakeup: jest.fn(async () => undefined),
        // Keep the real handoff transaction; unrelated persistence routing is reduced to SQL.
        persistIntent: async (
          input: EnsureModerationDeleteIntentInput,
          _enqueue: boolean,
          tx: Prisma.TransactionClient,
        ) => {
          const intent = await tx.moderationDeleteIntent.create({
            data: {
              id: `${chatId}:${input.messageId}`,
              chatId,
              messageId: input.messageId,
              subjectUserId: input.subjectUserId,
              ...(input.executeAt ? { executeAt: new Date(input.executeAt) } : {}),
              retryUntilAt: new Date(input.retryUntilAt!),
            },
          });
          return { intentId: intent.id, status: intent.status, rollout: 'execute' };
        },
      });
      return service;
    };
    const pauseFirstTransactionRead = (
      model: 'moderationEvent' | 'moderationViolationMessageClaim',
    ) => {
      let observed!: () => void;
      let proceed!: () => void;
      const reached = new Promise<void>((resolve) => {
        observed = resolve;
      });
      const continued = new Promise<void>((resolve) => {
        proceed = resolve;
      });
      let paused = false;
      let attempts = 0;
      return {
        reached,
        proceed: () => proceed(),
        attempts: () => attempts,
        database: {
          moderationViolationMessageClaim: prisma.moderationViolationMessageClaim,
          $transaction: (
            operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
            options: { isolationLevel?: Prisma.TransactionIsolationLevel },
          ) => {
            attempts += 1;
            return prisma.$transaction(async (tx) => {
              const reader = new Proxy(tx[model], {
                get(target, key) {
                  if (key !== 'findFirst') return Reflect.get(target, key);
                  return async (input: unknown) => {
                    const result = await Reflect.apply(Reflect.get(target, key), target, [input]);
                    if (!paused) {
                      paused = true;
                      observed();
                      await continued;
                    }
                    return result;
                  };
                },
              });
              return operation(
                new Proxy(tx, {
                  get(target, key) {
                    return key === model ? reader : Reflect.get(target, key);
                  },
                }),
              );
            }, options);
          },
        },
      };
    };

    const unavailableSourceCase = async (
      messageId: string,
      source: 'current' | 'original',
      intentService = serviceFor(),
      failureKind: 'http404' | 'local_limit' = 'http404',
    ) => {
      const own = canonicalClaim(messageId);
      const binding = bindingFor(own, Date.now() - 1000);
      const settings = await prisma.chatSettings.upsert({
        where: { chatId },
        create: { chatId, antiDuplicateEnabled: true, duplicateCompareMode: 'TEXT' },
        update: { antiDuplicateEnabled: true, duplicateCompareMode: 'TEXT' },
      });
      const raw = {
        sender: { user_id: own.userId },
        recipient: { chat_id: chatId, chat_type: 'chat' },
        timestamp: binding.eventTimestampMs,
        body: { mid: messageId, text: 'same source content' },
      };
      const content = extractDuplicateMessageContent(raw, false);
      const flow = resolveDuplicateFlowConfig(settings);
      binding.settingsDigest = messageDuplicateSettingsDigest(settings);
      binding.policyRevision = settings.duplicatePolicyRevision;
      binding.requiredCount = flow.allowedCount + 2;
      binding.windowSeconds = flow.windowSec;
      binding.sourceDigest = duplicateSourceDigest(content, binding.compareMode);
      binding.contentDigest = buildMessageDuplicateIdentity(content, binding.compareMode)!;
      binding.original!.sourceDigest = binding.sourceDigest;
      binding.original!.contentDigest = binding.contentDigest;
      const sourceError =
        failureKind === 'local_limit'
          ? new MaxApiInternalRateLimitError('Native duplicate source quota', 7)
          : { response: { status: 404, data: {} } };
      const max = {
        getChatMemberAccess: jest
          .fn()
          .mockResolvedValue({ userId: own.userId, isAdmin: false, isOwner: false }),
        getExactMessageRow: jest.fn(async (_chatId: string, lookupId: string) => {
          if (lookupId === (source === 'current' ? messageId : binding.original!.messageId))
            throw sourceError;
          return raw;
        }),
      };
      const history = {
        qualified: jest.fn().mockResolvedValue(null),
        qualify: jest.fn().mockResolvedValue(1),
        stillMatches: jest.fn().mockResolvedValue(true),
        remove: jest.fn(),
        observeLifecycle: jest.fn(),
        invalidateLifecycle: jest.fn(),
      };
      const policy = {
        resolve: jest.fn().mockResolvedValue({
          mode: 'delete_only',
          revision: 1,
          effectiveAtMs: binding.eventTimestampMs - 10_000,
          expiresAtMs: binding.authorization!.deadlineAtMs,
        }),
      };
      const authorization = new MessageDuplicateAuthorizationService(prisma as never, {} as never);
      const immunity = { consumeForMessage: jest.fn().mockResolvedValue('not_granted') };
      const metrics = { record: jest.fn(), recordGuardRejection: jest.fn() };
      const guard = new MessageDuplicateDeleteGuardService(
        prisma as never,
        max as never,
        { isKnownBotUserId: () => false } as never,
        immunity as never,
        policy as never,
        history as never,
        new ConfigService(),
        authorization,
        metrics as never,
        { isAnyMessageSourceHeld: async () => false } as never,
      );
      const handoff = jest.spyOn(intentService, 'ensureIntentWithMessageActionClaim');
      const executeFullAction = jest.fn();
      const service = new MessageDuplicateEnforcementService(intentService, policy as never, guard);
      const enqueue = () =>
        service.enqueue({
          chatId,
          botId: 'bot',
          sourceCreatedAt: new Date(binding.eventTimestampMs).toISOString(),
          text: raw.body.text,
          settings,
          hit: {
            count: binding.requiredCount,
            windowSec: binding.windowSeconds,
            hash: binding.fingerprint,
            fingerprintType: 'exact',
          },
          binding,
          executeFullAction,
        });
      return {
        own,
        binding,
        sourceError,
        history,
        immunity,
        metrics,
        authorization,
        handoff,
        executeFullAction,
        enqueue,
      };
    };

    beforeAll(async () => {
      const url = new URL(databaseUrl);
      if (
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        !url.pathname.includes('race_test')
      )
        throw new Error('Duplicate claim races require a disposable local race_test database');
      prisma = createPrismaClient(databaseUrl, { max: 8 });
      await prisma.$connect();
      await prisma.chat.create({ data: { id: chatId, title: 'Duplicate race test' } });
      intents = Object.create(
        ModerationDeleteIntentService.prototype,
      ) as ModerationDeleteIntentService;
      Object.assign(intents, { prisma });
      jest.spyOn(intents, 'getRolloutForRule').mockReturnValue('execute');
    });
    afterAll(async () => {
      jest.restoreAllMocks();
      if (!prisma) return;
      await prisma.maxActionLedgerEntry.deleteMany({ where: { chatId } });
      await prisma.chat.deleteMany({ where: { id: chatId } });
      await prisma.$disconnect();
    });

    it('gives concurrent rules one durable owner before any stage can be reserved', async () => {
      const duplicate = claim('race');
      const other = claim('race', 'STOP_WORD');
      const results = await Promise.all([preclaim(intents, duplicate), preclaim(intents, other)]);
      expect(results.sort()).toEqual(['blocked', 'claimed']);
      const owner = await prisma.moderationViolationMessageClaim.findUniqueOrThrow({
        where: { messageActionKey: duplicate.messageActionKey },
      });
      const winning = owner.ruleCode === duplicate.ruleCode ? duplicate : other;
      const losing = owner.ruleCode === duplicate.ruleCode ? other : duplicate;
      expect(await preclaim(intents, winning)).toBe('resumed');
      expect(await preclaim(intents, losing)).toBe('blocked');
      expect(
        await prisma.moderationViolationMessageClaim.count({
          where: { chatId, messageId: 'race' },
        }),
      ).toBe(1);
    });

    it('retries a real PostgreSQL COMMIT serialization failure through public preclaim', async () => {
      const own = canonicalClaim('commit-conflict-owner');
      const competing = claim('commit-conflict-peer', 'STOP_WORD');
      const binding = bindingFor(own, Date.now());
      let firstRead!: () => void;
      let peerInserted!: () => void;
      let ownerInserted!: () => void;
      const readReached = new Promise<void>((resolve) => {
        firstRead = resolve;
      });
      const peerReached = new Promise<void>((resolve) => {
        peerInserted = resolve;
      });
      const ownerReached = new Promise<void>((resolve) => {
        ownerInserted = resolve;
      });
      const readRange = (tx: Prisma.TransactionClient) =>
        tx.moderationViolationMessageClaim.findMany({
          where: { chatId, messageId: { in: [own.messageId, competing.messageId] } },
          select: { id: true },
        });
      let attempts = 0;
      let completedCallbacks = 0;
      const failures: unknown[] = [];
      const database = {
        $transaction: async (
          operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
          options: { isolationLevel?: Prisma.TransactionIsolationLevel },
        ) => {
          const attempt = ++attempts;
          try {
            return await prisma.$transaction(async (tx) => {
              if (attempt === 1) {
                // Force a real write-skew cycle: both snapshots read the same absent rows.
                await readRange(tx);
                firstRead();
                await peerReached;
              }
              const result = await operation(tx);
              if (attempt === 1) {
                ownerInserted();
                // The peer commits first; this completed callback then fails at COMMIT.
                await peer;
              }
              completedCallbacks += 1;
              return result;
            }, options);
          } catch (error) {
            failures.push(error);
            throw error;
          }
        },
      };
      const pending = serviceFor(database).claimMessageActionBeforeQualification(own, binding);
      const outcome = pending.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await readReached;
      const peer = prisma.$transaction(
        async (tx) => {
          await readRange(tx);
          await tx.moderationViolationMessageClaim.create({ data: competing });
          peerInserted();
          await ownerReached;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      await peer;
      const result = await outcome;
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({
        name: 'DriverAdapterError',
        message: 'TransactionWriteConflict',
        cause: { kind: 'TransactionWriteConflict' },
      });
      expect(completedCallbacks).toBe(attempts);
      expect(result).toEqual({ value: 'claimed' });
      expect(attempts).toBe(2);
      const owner = await prisma.moderationViolationMessageClaim.findUniqueOrThrow({
        where: { dedupeKey: own.dedupeKey },
        include: { duplicateCleanup: true },
      });
      expect(owner.messageActionKey).toBe(own.messageActionKey);
      expect(owner.duplicateCleanup).toMatchObject({
        eventTimestampMs: BigInt(binding.eventTimestampMs),
        authorizationTimestampMs: BigInt(binding.authorization!.eventTimestampMs),
        deadlineAt: new Date(binding.authorization!.deadlineAtMs),
      });
      expect(
        await prisma.moderationViolationMessageClaim.count({ where: { dedupeKey: own.dedupeKey } }),
      ).toBe(1);
    });

    it('resumes an interrupted own claim without transferring it to another rule', async () => {
      const own = claim('crash');
      expect(await preclaim(intents, own)).toBe('claimed');
      // A fresh service process sees the same committed owner after an interrupted qualification.
      const recovered = Object.create(
        ModerationDeleteIntentService.prototype,
      ) as ModerationDeleteIntentService;
      Object.assign(recovered, { prisma, getRolloutForRule: () => 'execute' });
      expect(await preclaim(recovered, own)).toBe('resumed');
      expect(await preclaim(recovered, claim('crash', 'OTHER'))).toBe('blocked');
    });

    it('releases only an unused owner and fences its old authorization before a foreign claim', async () => {
      const own = claim('unused');
      const eventTimestampMs = Date.now();
      const binding = {
        version: 3,
        messageId: own.messageId,
        senderId: own.userId,
        eventTimestampMs,
        authorization: { eventTimestampMs, deadlineAtMs: eventTimestampMs + 600000 },
      };
      expect(await preclaim(intents, own)).toBe('claimed');
      expect(
        await intents.releaseUnmaterializedMessageAction({ claim: own, binding: binding as never }),
      ).toBe(true);
      const tombstone = await prisma.moderationViolationMessageClaim.findUniqueOrThrow({
        where: { dedupeKey: own.dedupeKey },
      });
      expect(tombstone.messageActionKey).toBeNull();
      expect(await preclaim(intents, own)).toBe('blocked');
      expect(await preclaim(intents, claim(own.messageId, 'OTHER'))).toBe('claimed');
      expect(await preclaim(intents, own)).toBe('blocked');
      const authorization = new MessageDuplicateAuthorizationService(prisma as never, {} as never);
      expect(await authorization.isAllowed(chatId, binding as never)).toBe(false);
      expect(
        await intents.releaseUnmaterializedMessageAction({ claim: own, binding: binding as never }),
      ).toBe(false);
    });

    it.each(
      (['current', 'original'] as const).flatMap((source) =>
        (['http404', 'local_limit'] as const).map((failureKind) => ({ source, failureKind })),
      ),
    )(
      'settles an initial $source refusal ($failureKind) only after durable unused-claim revocation',
      async ({ source, failureKind }) => {
        const s = await unavailableSourceCase(
          `unavailable-${source}-${failureKind}`,
          source,
          serviceFor(),
          failureKind,
        );
        const outcome = await s.enqueue();
        expect(outcome).toEqual({ kind: 'rejected', reason: 'qualification_source_unavailable' });
        expect(duplicateEnforcementObservation(outcome)).toBe('SOURCE_UNAVAILABLE');
        const owner = await prisma.moderationViolationMessageClaim.findUniqueOrThrow({
          where: { dedupeKey: s.own.dedupeKey },
        });
        expect(owner.messageActionKey).toBeNull();
        expect(await s.authorization.isAllowed(chatId, s.binding)).toBe(false);
        expect(await preclaim(intents, s.own)).toBe('blocked');
        expect(
          await prisma.messageDuplicateClaimCleanup.findUnique({ where: { claimId: owner.id } }),
        ).toBeNull();
        expect(
          await prisma.moderationDeleteIntent.count({
            where: { chatId, messageId: s.own.messageId },
          }),
        ).toBe(0);
        expect(
          await prisma.moderationEvent.count({ where: { chatId, messageId: s.own.messageId } }),
        ).toBe(0);
        expect(
          await prisma.maxActionLedgerEntry.count({
            where: { chatId, messageId: s.own.messageId },
          }),
        ).toBe(0);
        expect(s.handoff).not.toHaveBeenCalled();
        expect(s.executeFullAction).not.toHaveBeenCalled();
        expect(s.history.qualify).not.toHaveBeenCalled();
        expect(s.history.remove).not.toHaveBeenCalled();
        expect(s.history.invalidateLifecycle).not.toHaveBeenCalled();
        expect(s.history.observeLifecycle).not.toHaveBeenCalled();
        expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
        expect(s.metrics.record).not.toHaveBeenCalledWith('guard.absent');
        expect(s.metrics.record).not.toHaveBeenCalledWith('guard.allowed');
      },
    );

    it.each(
      (['intent', 'event', 'receipt'] as const).flatMap((effect) =>
        (['current', 'original'] as const).map((source) => ({ effect, source })),
      ),
    )(
      'preserves $source GET 404 and its action fence when an existing $effect blocks release',
      async ({ effect, source }) => {
        const s = await unavailableSourceCase(`unavailable-${source}-${effect}`, source);
        if (effect === 'intent')
          await prisma.moderationDeleteIntent.create({
            data: {
              id: s.own.dedupeKey,
              chatId,
              messageId: s.own.messageId,
              retryUntilAt: new Date(s.binding.authorization!.deadlineAtMs),
            },
          });
        if (effect === 'event')
          await prisma.moderationEvent.create({
            data: {
              chatId,
              userId: s.own.userId,
              messageId: s.own.messageId,
              eventType: 'MESSAGE',
              ruleCode: 'DUPLICATE_WARN',
              action: 'WARN',
            },
          });
        if (effect === 'receipt')
          await prisma.maxActionLedgerEntry.create({
            data: {
              jobId: s.own.dedupeKey,
              chatId,
              messageId: s.own.messageId,
              actionType: 'DELETE_MESSAGE',
              status: 'SUCCEEDED',
              terminal: true,
            },
          });
        await expect(s.enqueue()).rejects.toBe(s.sourceError);
        const owner = await prisma.moderationViolationMessageClaim.findUniqueOrThrow({
          where: { dedupeKey: s.own.dedupeKey },
        });
        expect(owner.messageActionKey).toBe(s.own.messageActionKey);
        expect(await s.authorization.isAllowed(chatId, s.binding)).toBe(true);
        expect(
          await prisma.moderationViolationMessageClaim.findUnique({
            where: {
              dedupeKey: duplicateRevocationKey(
                chatId,
                s.own.messageId,
                s.binding.eventTimestampMs,
              ),
            },
          }),
        ).toBeNull();
        expect(
          await prisma.moderationDeleteIntent.count({
            where: { chatId, messageId: s.own.messageId },
          }),
        ).toBe(effect === 'intent' ? 1 : 0);
        expect(
          await prisma.moderationEvent.count({ where: { chatId, messageId: s.own.messageId } }),
        ).toBe(effect === 'event' ? 1 : 0);
        expect(
          await prisma.maxActionLedgerEntry.count({
            where: { chatId, messageId: s.own.messageId },
          }),
        ).toBe(effect === 'receipt' ? 1 : 0);
        expect(s.handoff).not.toHaveBeenCalled();
        expect(s.executeFullAction).not.toHaveBeenCalled();
        expect(s.history.qualify).not.toHaveBeenCalled();
        expect(s.history.remove).not.toHaveBeenCalled();
        expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
      },
    );

    it('retries source-unavailable cleanup against a concurrent handoff and preserves the winning intent', async () => {
      const pause = pauseFirstTransactionRead('moderationEvent');
      const s = await unavailableSourceCase(
        'unavailable-concurrent-handoff',
        'original',
        serviceFor(pause.database),
      );
      const pending = s.enqueue().then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await pause.reached;
      try {
        expect(
          await serviceFor().ensureIntentWithMessageActionClaim(handoffFor(s.own, s.binding)),
        ).toMatchObject({ claim: 'resumed' });
      } finally {
        pause.proceed();
      }
      expect(await pending).toEqual({ error: s.sourceError });
      expect(pause.attempts()).toBeGreaterThanOrEqual(3);
      expect(
        (
          await prisma.moderationViolationMessageClaim.findUniqueOrThrow({
            where: { dedupeKey: s.own.dedupeKey },
          })
        ).messageActionKey,
      ).toBe(s.own.messageActionKey);
      expect(
        await prisma.moderationDeleteIntent.count({
          where: { chatId, messageId: s.own.messageId },
        }),
      ).toBe(1);
      expect(await s.authorization.isAllowed(chatId, s.binding)).toBe(true);
      expect(s.handoff).not.toHaveBeenCalled();
      expect(s.executeFullAction).not.toHaveBeenCalled();
      expect(s.history.qualify).not.toHaveBeenCalled();
    });

    it.each([undefined, 'TEXT', 'IMAGE'] as const)(
      'reconciles a terminated %s worker without releasing a newer reservation',
      async (comparison) => {
        const eventTimestampMs = Date.now();
        const own = claim(`terminated-${comparison ?? 'legacy'}`);
        own.dedupeKey = `message-duplicate-action:v1:${digestDuplicateContent([chatId, own.userId, own.messageId])}`;
        expect(await preclaim(intents, own)).toBe('claimed');
        const job = {
          chatId,
          messageId: own.messageId,
          eventTimestampMs,
          deadlineAtMs: eventTimestampMs + 600000,
          comparison,
          idempotencyKey: buildMessageDuplicateJobId(
            chatId,
            own.messageId,
            eventTimestampMs,
            comparison,
          ),
        };
        expect(await intents.releaseTerminatedMessageDuplicateAction(job)).toBe(true);
        expect(await preclaim(intents, claim(own.messageId, 'OTHER'))).toBe('claimed');
        const fresh = claim(`fresh-${comparison ?? 'legacy'}`);
        fresh.dedupeKey = `message-duplicate-action:v1:${digestDuplicateContent([chatId, fresh.userId, fresh.messageId])}`;
        expect(await preclaim(intents, fresh)).toBe('claimed');
        const oldTimestamp = eventTimestampMs - 720000;
        expect(
          await intents.releaseTerminatedMessageDuplicateAction({
            ...job,
            messageId: fresh.messageId,
            eventTimestampMs: oldTimestamp,
            deadlineAtMs: oldTimestamp + 600000,
            idempotencyKey: buildMessageDuplicateJobId(
              chatId,
              fresh.messageId,
              oldTimestamp,
              comparison,
            ),
          }),
        ).toBe(false);
        expect(await preclaim(intents, fresh)).toBe('resumed');
      },
    );

    it('retains a materialized or foreign owner during terminal cleanup', async () => {
      const own = canonicalClaim('materialized');
      const binding = {
        version: 3,
        messageId: own.messageId,
        senderId: own.userId,
        eventTimestampMs: Date.now(),
        authorization: { eventTimestampMs: Date.now(), deadlineAtMs: Date.now() + 600000 },
      };
      expect(await preclaim(intents, own)).toBe('claimed');
      await prisma.moderationDeleteIntent.create({
        data: {
          id: `${chatId}:materialized`,
          chatId,
          messageId: own.messageId,
          retryUntilAt: new Date(Date.now() + 600000),
        },
      });
      expect(
        await intents.releaseUnmaterializedMessageAction({ claim: own, binding: binding as never }),
      ).toBe(false);
      expect(await intents.releaseTerminatedMessageDuplicateAction(jobFor(own))).toBe(false);
      expect(await preclaim(intents, claim(own.messageId, 'OTHER'))).toBe('blocked');
      const foreign = claim('foreign', 'OTHER');
      expect(await preclaim(intents, foreign)).toBe('claimed');
      expect(
        await intents.releaseUnmaterializedMessageAction({
          claim: claim('foreign'),
          binding: { ...binding, messageId: foreign.messageId } as never,
        }),
      ).toBe(false);
      expect(await intents.releaseTerminatedMessageDuplicateAction(jobFor(foreign))).toBe(false);
      expect(await preclaim(intents, foreign)).toBe('resumed');
    });

    it.each(['handoff', 'cleanup'] as const)(
      'serializes concurrent cleanup and intent handoff when %s commits first',
      async (winner) => {
        const own = canonicalClaim(`concurrent-${winner}`);
        const binding = bindingFor(own, Date.now());
        const input = handoffFor(own, binding);
        expect(await preclaim(intents, own)).toBe('claimed');
        const pause = pauseFirstTransactionRead(
          winner === 'handoff' ? 'moderationEvent' : 'moderationViolationMessageClaim',
        );
        const paused = serviceFor(pause.database);
        const direct = serviceFor();
        const pending =
          winner === 'handoff'
            ? paused.releaseUnmaterializedMessageAction({ claim: own, binding })
            : paused.ensureIntentWithMessageActionClaim(input);
        await pause.reached;
        let first: unknown;
        try {
          first =
            winner === 'handoff'
              ? await direct.ensureIntentWithMessageActionClaim(input)
              : await direct.releaseUnmaterializedMessageAction({ claim: own, binding });
        } finally {
          pause.proceed();
        }
        const second = await pending;
        const owner = await prisma.moderationViolationMessageClaim.findUniqueOrThrow({
          where: { dedupeKey: own.dedupeKey },
        });
        const materialized = await prisma.moderationDeleteIntent.findUnique({
          where: { chatId_messageId: { chatId, messageId: own.messageId } },
        });
        const revoked = await prisma.moderationViolationMessageClaim.findUnique({
          where: {
            dedupeKey: duplicateRevocationKey(chatId, own.messageId, binding.eventTimestampMs),
          },
        });
        expect(pause.attempts()).toBeGreaterThanOrEqual(2);
        if (winner === 'handoff') {
          expect(first).toMatchObject({ claim: 'resumed', intent: { intentId: materialized?.id } });
          expect(second).toBe(false);
          expect(materialized).not.toBeNull();
          expect(owner.messageActionKey).toBe(own.messageActionKey);
          expect(revoked).toBeNull();
          expect(await preclaim(intents, own)).toBe('resumed');
        } else {
          expect(first).toBe(true);
          expect(second).toEqual({ claim: 'blocked', intent: null });
          expect(materialized).toBeNull();
          expect(owner.messageActionKey).toBeNull();
          expect(revoked).not.toBeNull();
          expect(await direct.ensureIntentWithMessageActionClaim(input)).toEqual({
            claim: 'blocked',
            intent: null,
          });
          expect(await preclaim(intents, claim(own.messageId, 'OTHER'))).toBe('claimed');
        }
      },
    );

    it('rolls back owner release when the durable denial writer is unavailable', async () => {
      const own = canonicalClaim('failed-cleanup');
      const binding = bindingFor(own, Date.now());
      expect(await preclaim(intents, own)).toBe('claimed');
      const unavailable = serviceFor({
        $transaction: (
          operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
          options: { isolationLevel?: Prisma.TransactionIsolationLevel },
        ) =>
          prisma.$transaction(async (tx) => {
            const writer = new Proxy(tx.moderationViolationMessageClaim, {
              get(target, key) {
                if (key !== 'createMany') return Reflect.get(target, key);
                return async () => {
                  throw new Error('Synthetic durable denial writer unavailable');
                };
              },
            });
            return operation(
              new Proxy(tx, {
                get(target, key) {
                  return key === 'moderationViolationMessageClaim'
                    ? writer
                    : Reflect.get(target, key);
                },
              }),
            );
          }, options),
      });
      await expect(
        unavailable.releaseUnmaterializedMessageAction({ claim: own, binding }),
      ).rejects.toThrow('durable denial writer unavailable');
      const retained = await prisma.moderationViolationMessageClaim.findUniqueOrThrow({
        where: { dedupeKey: own.dedupeKey },
      });
      expect(retained.messageActionKey).toBe(own.messageActionKey);
      expect(await preclaim(intents, own)).toBe('resumed');
      expect(
        await prisma.moderationViolationMessageClaim.findUnique({
          where: {
            dedupeKey: duplicateRevocationKey(chatId, own.messageId, binding.eventTimestampMs),
          },
        }),
      ).toBeNull();
    });

    it('retains an event-only materialized owner during terminal cleanup', async () => {
      const own = canonicalClaim('event-only');
      const job = jobFor(own);
      expect(await preclaim(intents, own)).toBe('claimed');
      await prisma.moderationEvent.create({
        data: {
          chatId,
          userId: own.userId,
          messageId: own.messageId,
          eventType: 'MESSAGE',
          ruleCode: 'DUPLICATE_WARN',
          action: 'WARN',
        },
      });
      expect(await intents.releaseTerminatedMessageDuplicateAction(job)).toBe(false);
      expect(await preclaim(intents, own)).toBe('resumed');
    });

    it('retains a newer exact owner replacing the initially observed terminated reservation', async () => {
      const own = canonicalClaim('replaced-terminal-owner');
      const job = jobFor(own, Date.now() - 720000);
      await prisma.moderationViolationMessageClaim.create({
        data: { ...own, createdAt: new Date(job.eventTimestampMs + 1000) },
      });
      let observed!: () => void;
      let proceed!: () => void;
      const reached = new Promise<void>((resolve) => {
        observed = resolve;
      });
      const continued = new Promise<void>((resolve) => {
        proceed = resolve;
      });
      const reader = new Proxy(prisma.moderationViolationMessageClaim, {
        get(target, key) {
          if (key !== 'findUnique') return Reflect.get(target, key);
          return async (input: unknown) => {
            const result = await Reflect.apply(Reflect.get(target, key), target, [input]);
            observed();
            await continued;
            return result;
          };
        },
      });
      const terminal = serviceFor({
        moderationViolationMessageClaim: reader,
        $transaction: prisma.$transaction.bind(prisma),
      });
      const pending = terminal.releaseTerminatedMessageDuplicateAction(job);
      await reached;
      const fresh = await prisma.$transaction(async (tx) => {
        await tx.moderationViolationMessageClaim.delete({ where: { dedupeKey: own.dedupeKey } });
        return tx.moderationViolationMessageClaim.create({ data: own });
      });
      proceed();
      expect(await pending).toBe(false);
      expect(fresh.createdAt.getTime()).toBeGreaterThan(job.deadlineAtMs);
      expect(await preclaim(intents, own)).toBe('resumed');
      expect(
        await prisma.moderationViolationMessageClaim.findUnique({
          where: { dedupeKey: duplicateRevocationKey(chatId, own.messageId, job.eventTimestampMs) },
        }),
      ).toBeNull();
    });

    it('commits the original recovery obligation with a real prequalification claim', async () => {
      const own = canonicalClaim('preclaim-obligation');
      const binding = bindingFor(own, Date.now());
      expect(await intents.claimMessageActionBeforeQualification(own, binding)).toBe('claimed');
      const owner = await prisma.moderationViolationMessageClaim.findUniqueOrThrow({
        where: { messageActionKey: own.messageActionKey },
        include: { duplicateCleanup: true },
      });
      expect(owner.duplicateCleanup).toMatchObject({
        claimId: owner.id,
        claimCreatedAt: owner.createdAt,
        eventTimestampMs: BigInt(binding.eventTimestampMs),
        authorizationTimestampMs: BigInt(binding.authorization!.eventTimestampMs),
        deadlineAt: new Date(binding.authorization!.deadlineAtMs),
      });
      expect(
        await intents.claimMessageActionBeforeQualification(own, {
          ...binding,
          authorization: {
            ...binding.authorization!,
            deadlineAtMs: binding.authorization!.deadlineAtMs - 1,
          },
        }),
      ).toBe('blocked');
      expect(await intents.claimMessageActionBeforeQualification(own, binding)).toBe('resumed');
    });

    it('cannot leave a claim behind when the obligation store fails', async () => {
      const own = canonicalClaim('obligation-write-failure');
      const failing = serviceFor({
        $transaction: (
          operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
          options: object,
        ) =>
          prisma.$transaction(
            (tx) =>
              operation(
                new Proxy(tx, {
                  get(target, key) {
                    if (key !== 'messageDuplicateClaimCleanup') return Reflect.get(target, key);
                    return new Proxy(tx.messageDuplicateClaimCleanup, {
                      get(model, method) {
                        if (method === 'createMany')
                          return async () => {
                            throw new Error('obligation unavailable');
                          };
                        return Reflect.get(model, method);
                      },
                    });
                  },
                }),
              ),
            options,
          ),
      });
      await expect(
        failing.claimMessageActionBeforeQualification(own, bindingFor(own, Date.now())),
      ).rejects.toThrow('obligation unavailable');
      expect(
        await prisma.moderationViolationMessageClaim.findUnique({
          where: { dedupeKey: own.dedupeKey },
        }),
      ).toBeNull();
    });

    const abandonedClaim = async (messageId: string, deadlineOffsetMs = -1000) => {
      const own = canonicalClaim(messageId);
      const eventTimestampMs = Date.now() - 600_000 + deadlineOffsetMs;
      const binding = bindingFor(own, eventTimestampMs);
      const owner = await prisma.$transaction(
        async (tx) => {
          const row = await tx.moderationViolationMessageClaim.create({
            data: { ...own, createdAt: new Date(eventTimestampMs + 1) },
          });
          expect(await registerDuplicateClaimCleanup(tx, own, binding)).toBe(true);
          return row;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      return { own, binding, owner };
    };

    it('recovers a lost queue job once from SQL and keeps an old worker revoked', async () => {
      const { own, binding, owner } = await abandonedClaim('lost-queue');
      const recovered = serviceFor();
      const report = jest.fn(() => {
        throw new Error('diagnostics unavailable');
      });
      expect(await recovered.reconcileExpiredMessageDuplicateActions(report)).toBe(1);
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({
          sampledDue: 1,
          sampleLimit: 25,
          sampleLimitReached: false,
          oldestDueAgeMs: expect.any(Number),
          released: 1,
        }),
      );
      expect(await recovered.reconcileExpiredMessageDuplicateActions()).toBe(0);
      expect(await preclaim(intents, own)).toBe('blocked');
      expect(
        await prisma.moderationViolationMessageClaim.findUnique({
          where: {
            dedupeKey: duplicateRevocationKey(chatId, own.messageId, binding.eventTimestampMs),
          },
        }),
      ).not.toBeNull();
      expect(
        await prisma.messageDuplicateClaimCleanup.count({ where: { claimId: owner.id } }),
      ).toBe(0);
    });

    it('does not release an unexpired owner or renew its persisted deadline', async () => {
      const { own, binding, owner } = await abandonedClaim('still-active', 600_000);
      expect(await serviceFor().reconcileExpiredMessageDuplicateActions()).toBe(0);
      const changed = {
        ...binding,
        authorization: {
          eventTimestampMs: binding.authorization!.eventTimestampMs + 1000,
          deadlineAtMs: binding.authorization!.deadlineAtMs + 1000,
        },
      };
      expect(
        await prisma.$transaction((tx) => registerDuplicateClaimCleanup(tx, own, changed)),
      ).toBe(false);
      const stored = await prisma.messageDuplicateClaimCleanup.findUniqueOrThrow({
        where: { claimId: owner.id },
      });
      expect(stored.deadlineAt.getTime()).toBe(binding.authorization!.deadlineAtMs);
    });

    it.each(['intent', 'event', 'receipt'] as const)(
      'retains a materialized %s while settling its expired obligation',
      async (kind) => {
        const { own, owner } = await abandonedClaim(`lost-queue-${kind}`);
        if (kind === 'intent')
          await prisma.moderationDeleteIntent.create({
            data: {
              id: randomUUID(),
              chatId,
              messageId: own.messageId,
              retryUntilAt: new Date(Date.now() + 600_000),
            },
          });
        if (kind === 'event')
          await prisma.moderationEvent.create({
            data: {
              chatId,
              userId: own.userId,
              messageId: own.messageId,
              eventType: 'MESSAGE',
              ruleCode: 'DUPLICATE_WARN',
              action: 'WARN',
            },
          });
        if (kind === 'receipt')
          await prisma.maxActionLedgerEntry.create({
            data: {
              jobId: `${chatId}:receipt`,
              chatId,
              messageId: own.messageId,
              actionType: 'DELETE_MESSAGE',
              status: 'SUCCEEDED',
              terminal: true,
            },
          });
        try {
          expect(await serviceFor().reconcileExpiredMessageDuplicateActions()).toBe(0);
          expect(
            (
              await prisma.moderationViolationMessageClaim.findUniqueOrThrow({
                where: { id: owner.id },
              })
            ).messageActionKey,
          ).toBe(own.messageActionKey);
          expect(
            await prisma.messageDuplicateClaimCleanup.findUnique({ where: { claimId: owner.id } }),
          ).toBeNull();
        } finally {
          if (kind === 'receipt')
            await prisma.maxActionLedgerEntry.deleteMany({ where: { chatId } });
        }
      },
    );

    it('rolls back an obligation with its claim and serializes two independent sweepers', async () => {
      const failed = canonicalClaim('atomic-rollback');
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.moderationViolationMessageClaim.create({ data: failed });
          await registerDuplicateClaimCleanup(tx, failed, bindingFor(failed, Date.now()));
          throw new Error('simulated process failure');
        }),
      ).rejects.toThrow('simulated process failure');
      expect(
        await prisma.moderationViolationMessageClaim.findUnique({
          where: { dedupeKey: failed.dedupeKey },
        }),
      ).toBeNull();
      await abandonedClaim('two-sweepers');
      const counts = await Promise.all([
        serviceFor().reconcileExpiredMessageDuplicateActions(),
        serviceFor().reconcileExpiredMessageDuplicateActions(),
      ]);
      expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1);
    });

    it('serializes a real locked cleanup duty against the atomic intent handoff', async () => {
      const { own, binding, owner } = await abandonedClaim('duty-lock-handoff');
      let locked!: () => void;
      let proceed!: () => void;
      let deleting!: () => void;
      const lockReached = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const continued = new Promise<void>((resolve) => {
        proceed = resolve;
      });
      const deleteReached = new Promise<void>((resolve) => {
        deleting = resolve;
      });
      let paused = false;
      let cleanupAttempts = 0;
      let handoffAttempts = 0;
      const database = (side: 'cleanup' | 'handoff') => ({
        messageDuplicateClaimCleanup: prisma.messageDuplicateClaimCleanup,
        $transaction: (
          operation: (tx: Prisma.TransactionClient) => Promise<unknown>,
          options: object,
        ) => {
          if (side === 'cleanup') cleanupAttempts += 1;
          else handoffAttempts += 1;
          return prisma.$transaction(
            (tx) =>
              operation(
                new Proxy(tx, {
                  get(target, key) {
                    if (side === 'cleanup' && key === '$queryRaw')
                      return async (...args: unknown[]) => {
                        const result = await Reflect.apply(Reflect.get(target, key), target, args);
                        if (!paused) {
                          paused = true;
                          locked();
                          await continued;
                        }
                        return result;
                      };
                    if (side === 'handoff' && key === 'messageDuplicateClaimCleanup')
                      return new Proxy(tx.messageDuplicateClaimCleanup, {
                        get(model, method) {
                          if (method !== 'deleteMany') return Reflect.get(model, method);
                          return async (...args: unknown[]) => {
                            deleting();
                            return Reflect.apply(Reflect.get(model, method), model, args);
                          };
                        },
                      });
                    return Reflect.get(target, key);
                  },
                }),
              ),
            options,
          );
        },
      });
      const cleanup = serviceFor(database('cleanup')).reconcileExpiredMessageDuplicateActions();
      await lockReached;
      const input = handoffFor(own, binding);
      const handoff = serviceFor(database('handoff')).ensureIntentWithMessageActionClaim({
        ...input,
        // Model a handoff scheduled before its deadline but completing after expiry.
        intent: { ...input.intent, executeAt: new Date(binding.eventTimestampMs) },
      });
      try {
        await Promise.race([
          deleteReached,
          handoff.then(() => {
            throw new Error('Handoff finished before the duty lock boundary');
          }),
        ]);
      } finally {
        proceed();
      }
      const [released, result] = await Promise.all([cleanup, handoff]);
      expect(cleanupAttempts + handoffAttempts).toBeGreaterThanOrEqual(3);
      const retained = await prisma.moderationViolationMessageClaim.findUniqueOrThrow({
        where: { id: owner.id },
      });
      const materialized = await prisma.moderationDeleteIntent.findUnique({
        where: { chatId_messageId: { chatId, messageId: own.messageId } },
      });
      const revoked = await prisma.moderationViolationMessageClaim.findUnique({
        where: {
          dedupeKey: duplicateRevocationKey(chatId, own.messageId, binding.eventTimestampMs),
        },
      });
      expect(
        await prisma.messageDuplicateClaimCleanup.findUnique({ where: { claimId: owner.id } }),
      ).toBeNull();
      if (released === 1) {
        expect(result).toEqual({ claim: 'blocked', intent: null });
        expect(retained.messageActionKey).toBeNull();
        expect(materialized).toBeNull();
        expect(revoked).not.toBeNull();
      } else {
        expect(released).toBe(0);
        expect(result).toMatchObject({ claim: 'resumed', intent: { intentId: materialized?.id } });
        expect(retained.messageActionKey).toBe(own.messageActionKey);
        expect(materialized).not.toBeNull();
        expect(revoked).toBeNull();
      }
    });

    it('selects only due obligations through the due index under skewed retained history', async () => {
      const future = new Date(Date.now() + 3_600_000);
      const claims = Array.from({ length: 2048 }, (_, i) => ({
        id: `${chatId}:skew:${i}`,
        ...canonicalClaim(`skew-${i}`),
      }));
      await prisma.moderationViolationMessageClaim.createMany({ data: claims });
      await prisma.messageDuplicateClaimCleanup.createMany({
        data: claims.map((own) => ({
          claimId: own.id,
          claimCreatedAt: new Date(),
          eventTimestampMs: BigInt(Date.now()),
          authorizationTimestampMs: BigInt(Date.now()),
          deadlineAt: future,
        })),
      });
      await abandonedClaim('due-index-one');
      await abandonedClaim('due-index-two');
      await prisma.$executeRawUnsafe('ANALYZE message_duplicate_claim_cleanup');
      const explain = await prisma.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(Prisma.sql`
        EXPLAIN (ANALYZE, FORMAT JSON)
        SELECT "claim_id", "deadline_at" FROM "message_duplicate_claim_cleanup"
        WHERE "deadline_at" <= ${new Date()}
        ORDER BY "deadline_at", "claim_id" LIMIT 25
      `);
      const json = JSON.stringify(explain);
      expect(json).toContain('message_duplicate_claim_cleanup_due_idx');
      const plan = (explain[0]!['QUERY PLAN'] as Array<{ Plan: { 'Actual Rows': number } }>)[0]!
        .Plan;
      expect(plan['Actual Rows']).toBe(2);
      expect(await serviceFor().reconcileExpiredMessageDuplicateActions()).toBe(2);
    });

    it('reports only the selected due lower bound and processes at most 25 per sweep', async () => {
      for (let index = 0; index < 27; index += 1) await abandonedClaim(`sample-${index}`);
      const report = jest.fn();
      expect(await serviceFor().reconcileExpiredMessageDuplicateActions(report)).toBe(25);
      expect(report).toHaveBeenLastCalledWith({
        sampledDue: 25,
        sampleLimit: 25,
        sampleLimitReached: true,
        oldestDueAgeMs: expect.any(Number),
        released: 25,
      });
      expect(report.mock.calls[0]![0].oldestDueAgeMs).toBeGreaterThanOrEqual(1000);
      expect(await serviceFor().reconcileExpiredMessageDuplicateActions(report)).toBe(2);
      expect(report).toHaveBeenLastCalledWith(
        expect.objectContaining({ sampledDue: 2, sampleLimitReached: false, released: 2 }),
      );
      expect(await serviceFor().reconcileExpiredMessageDuplicateActions(report)).toBe(0);
      expect(report).toHaveBeenLastCalledWith({
        sampledDue: 0,
        sampleLimit: 25,
        sampleLimitReached: false,
        oldestDueAgeMs: null,
        released: 0,
      });
    });

    it('records one initial admission across concurrent processes and total queue loss', async () => {
      const admission = new MessageDuplicateAdmissionService(prisma as never);
      const input = { chatId, messageId: 'admission', jobId: `${chatId}:admission` };
      const results = await Promise.all(Array.from({ length: 8 }, () => admission.register(input)));
      expect(results.filter((result) => result.registration === 'initial')).toHaveLength(1);
      expect(results.filter((result) => result.registration === 'retry')).toHaveLength(7);
      expect(new Set(results.map((result) => result.admittedAtMs)).size).toBe(1);
      const recovered = new MessageDuplicateAdmissionService(prisma as never);
      expect(await recovered.register(input)).toEqual({ ...results[0], registration: 'retry' });
      expect(await preclaim(intents, claim(input.messageId, 'OTHER'))).toBe('claimed');
    });

    it('concurrent revocations survive Redis failure and never occupy the action owner', async () => {
      const eventTimestampMs = Date.now();
      const ordering = {
        revokeActionEligibility: jest.fn(async () => {
          throw new Error('Redis unavailable');
        }),
      };
      const authorization = new MessageDuplicateAuthorizationService(
        prisma as never,
        ordering as never,
      );
      const input = { chatId, messageId: 'revoked', senderId: 'user', eventTimestampMs };
      await Promise.all(Array.from({ length: 8 }, () => authorization.revoke(input)));
      const denied = await prisma.moderationViolationMessageClaim.findUniqueOrThrow({
        where: { dedupeKey: duplicateRevocationKey(chatId, input.messageId, eventTimestampMs) },
      });
      expect(denied.messageActionKey).toBeNull();
      expect(
        await prisma.moderationViolationMessageClaim.count({
          where: { chatId, messageId: input.messageId },
        }),
      ).toBe(1);
      expect(await preclaim(intents, claim(input.messageId, 'OTHER'))).toBe('claimed');
      const oldBinding = {
        version: 3,
        messageId: input.messageId,
        eventTimestampMs,
        authorization: { eventTimestampMs, deadlineAtMs: eventTimestampMs + 600000 },
      };
      expect(await authorization.isAllowed(chatId, oldBinding as never)).toBe(false);
      const recovered = new MessageDuplicateAuthorizationService(prisma as never, {} as never);
      expect(await recovered.isAllowed(chatId, oldBinding as never)).toBe(false);
      expect(
        await recovered.isAllowed(chatId, {
          ...oldBinding,
          authorization: {
            eventTimestampMs: eventTimestampMs + 1000,
            deadlineAtMs: eventTimestampMs + 600000,
          },
        } as never),
      ).toBe(false);
    });

    (redisUrl ? describe : describe.skip)(
      'stale Redis permit restoration with durable SQL denial',
      () => {
        beforeAll(() => {
          if (!/^redis:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/u.test(redisUrl))
            throw new Error('Duplicate restore checks require disposable local Redis');
        });

        it.each(['pending intent', 'persisted DELETE receipt'] as const)(
          'rejects a restored positive permit before MAX for a %s',
          async (state) => {
            const own = canonicalClaim(`stale-restore-${state}`);
            const eventTimestampMs = Date.now() - 1000;
            const jobId = buildMessageDuplicateJobId(
              chatId,
              own.messageId,
              eventTimestampMs,
              'IMAGE',
            );
            const baseBinding = bindingFor(own, eventTimestampMs);
            const binding: MessageDuplicateBinding = {
              ...baseBinding,
              enforcementScope: 'full',
              compareMode: 'IMAGE',
              imageScope: 'SAME_AUTHOR',
              hasPhotos: true,
              mediaHashes: ['a'.repeat(64)],
              original: { ...baseBinding.original!, mediaHashes: ['a'.repeat(64)] },
              authorization: { jobId, eventTimestampMs, deadlineAtMs: eventTimestampMs + 600_000 },
            };
            const identity = {
              chatId,
              jobId,
              sourceCreatedAt: new Date(eventTimestampMs).toISOString(),
              deadlineAtMs: binding.authorization!.deadlineAtMs,
            };
            const digest = (value: string) => createHash('sha256').update(value).digest('hex');
            const prefix = `message-duplicate:ordering:v2:${digest(chatId).slice(0, 32)}`;
            const permitKey = `${prefix}:permit:${digest(jobId)}`;
            const otherPermitKey = `${prefix}:permit:${digest(buildMessageDuplicateJobId(chatId, own.messageId, eventTimestampMs))}`;
            const config = new ConfigService({ REDIS_URL: redisUrl });
            const inspector = new Redis(redisUrl);
            const initialOrdering = new MessageDuplicateOrderingStore(config);
            let recoveredOrdering: MessageDuplicateOrderingStore | undefined;
            let recoveredPrisma: PrismaClient | undefined;
            let counters: RedisCounterService | undefined;
            let initialClosed = false;
            try {
              const initial = new MessageDuplicateAuthorizationService(
                prisma as never,
                initialOrdering,
              );
              await expect(initialOrdering.announce(identity, true)).resolves.toMatchObject({
                kind: 'registered',
                actionEligible: true,
              });
              expect(await initial.isAllowed(chatId, binding)).toBe(true);
              expect(await intents.claimMessageActionBeforeQualification(own, binding)).toBe(
                'claimed',
              );
              const metadata = {
                duplicateSource: MESSAGE_DUPLICATE_SOURCE,
                enforcementScope: binding.enforcementScope,
                messageDuplicate: binding,
              };
              expect(parseMessageDuplicateBinding(metadata)).toEqual(binding);
              const intentId = `${chatId}:${own.messageId}`;
              const remoteDeleteSucceededAt =
                state === 'persisted DELETE receipt' ? new Date(eventTimestampMs + 1) : null;
              await prisma.moderationDeleteIntent.create({
                data: {
                  id: intentId,
                  chatId,
                  messageId: own.messageId,
                  subjectUserId: own.userId,
                  retryUntilAt: new Date(identity.deadlineAtMs),
                  remoteDeleteSucceededAt,
                  remoteDeleteSucceededBotId: remoteDeleteSucceededAt ? 'test-bot' : null,
                  reasons: {
                    create: {
                      id: `${intentId}:reason`,
                      reasonKey: `MESSAGE_DUPLICATE:v1:${eventTimestampMs}`,
                      ruleCode: 'DUPLICATE_DELETE',
                      userId: own.userId,
                      eventType: 'MESSAGE',
                      createdAt: new Date(eventTimestampMs),
                      metadata,
                    },
                  },
                },
              });
              const snapshot = await inspector.dumpBuffer(permitKey);
              const expiresAtMs = await inspector.pexpiretime(permitKey);
              expect(Buffer.isBuffer(snapshot)).toBe(true);
              expect(expiresAtMs).toBeGreaterThan(Date.now());
              await initial.revoke({
                chatId,
                messageId: own.messageId,
                senderId: own.userId,
                eventTimestampMs,
              });
              expect(await inspector.hget(permitKey, 'eligible')).toBe('0');
              expect(await initial.isAllowed(chatId, binding)).toBe(false);
              await initialOrdering.onModuleDestroy();
              initialClosed = true;

              // FLAG: Replay only this fixture's older serialized permit, preserving its original
              // absolute expiry. This tests cross-store restore, not an OS/RDB crash simulation.
              await inspector.restore(permitKey, expiresAtMs, snapshot, 'REPLACE', 'ABSTTL');
              expect(await inspector.pexpiretime(permitKey)).toBe(expiresAtMs);
              expect(await inspector.hget(permitKey, 'eligible')).toBe('1');
              recoveredPrisma = createPrismaClient(databaseUrl, { max: 2 });
              await recoveredPrisma.$connect();
              recoveredOrdering = new MessageDuplicateOrderingStore(config);
              const recovered = new MessageDuplicateAuthorizationService(
                recoveredPrisma as never,
                recoveredOrdering,
              );
              // FLAG: The stale Redis reader allows the live permit; only durable SQL denial
              // prevents the public guard from turning that restored state into action authority.
              expect(await recoveredOrdering.readActionEligibility(identity)).toBe(true);
              expect(await recovered.isAllowed(chatId, binding)).toBe(false);
              const denied =
                await recoveredPrisma.moderationViolationMessageClaim.findUniqueOrThrow({
                  where: {
                    dedupeKey: duplicateRevocationKey(chatId, own.messageId, eventTimestampMs),
                  },
                });
              expect(denied.messageActionKey).toBeNull();
              expect(
                await intents.releaseUnmaterializedMessageAction({ claim: own, binding }),
              ).toBe(false);
              const owner = await recoveredPrisma.moderationViolationMessageClaim.findUniqueOrThrow(
                {
                  where: { dedupeKey: own.dedupeKey },
                },
              );
              expect(owner.messageActionKey).toBe(own.messageActionKey);
              const stored = await recoveredPrisma.moderationDeleteIntent.findUniqueOrThrow({
                where: { id: intentId },
              });
              expect(stored.remoteDeleteSucceededAt).toEqual(remoteDeleteSucceededAt);
              const max = {
                getChatMemberAccess: jest.fn(async () => {
                  throw new Error('Unexpected MAX access');
                }),
                getExactMessageRow: jest.fn(async () => {
                  throw new Error('Unexpected MAX read');
                }),
              };
              counters = new RedisCounterService(config);
              const guard = new MessageDuplicateDeleteGuardService(
                recoveredPrisma as never,
                max as never,
                {} as never,
                {} as never,
                new MessageDuplicatePolicyService(counters, config),
                new MessageDuplicateHistoryService(counters),
                config,
                recovered,
              );
              const target = {
                chatId,
                messageId: own.messageId,
                subjectUserId: own.userId,
                botId: 'test-bot',
              };
              await expect(
                guard.assertIntentStillActionable({ ...target, intentId }),
              ).rejects.toMatchObject({
                code: 'message_duplicate_action_revoked',
              });
              await expect(
                guard.assertMessageStillActionable({
                  ...target,
                  binding,
                  sanctionIntentId: intentId,
                }),
              ).rejects.toMatchObject({
                code: 'message_duplicate_action_revoked',
              });
              expect(max.getChatMemberAccess).not.toHaveBeenCalled();
              expect(max.getExactMessageRow).not.toHaveBeenCalled();
              expect(await inspector.hget(permitKey, 'eligible')).toBe('1');
              expect(await inspector.pexpiretime(permitKey)).toBe(expiresAtMs);
            } finally {
              try {
                await inspector.del(
                  permitKey,
                  otherPermitKey,
                  ...[
                    'pending',
                    'expiry',
                    'members',
                    'sequence',
                    'completed',
                    'lock',
                    'next-eligible',
                  ].map((part) => `${prefix}:${part}`),
                );
              } finally {
                await Promise.all([
                  initialClosed ? Promise.resolve() : initialOrdering.onModuleDestroy(),
                  recoveredOrdering?.onModuleDestroy(),
                  recoveredPrisma?.$disconnect(),
                  counters?.onModuleDestroy(),
                  inspector.quit(),
                ]);
              }
            }
          },
        );
      },
    );
  },
);
