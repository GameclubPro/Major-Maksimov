import {
  LinkHistoryDeleteGuardService,
  LinkHistoryDeleteGuardRejectedError,
} from './link-history-delete-guard.service';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { MaxClientService } from '../max/max-client.service';
import type { MaxBotLinkService } from '../max/max-bot-link.service';
import { createPrismaClient, type Prisma, type PrismaClient } from '../prisma/prisma-client';
import { ModerationDeleteIntentService } from './moderation-delete-intent.service';
import { MessageLimitsDeleteGuardService } from './message-limits-delete-guard.service';
import {
  MessageDuplicateDeleteGuardService,
  MessageDuplicateGuardRejectedError,
} from './message-duplicate/message-duplicate-delete-guard.service';
import {
  finalizeDeleteAuthority,
  type PreparedDeleteAuthority,
} from './moderation-delete-authority-preparation';
import { ModerationStateDeleteGuardService } from './moderation-state-delete-guard.service';
import { ModerationSanctionStateFenceService } from './moderation-sanction-state-fence.service';
import { ModerationSanctionStateLockService } from './moderation-sanction-state-lock.service';
import { ParticipantModerationImmunityService } from './participant-moderation-immunity.service';
import { RedisCounterService } from './redis-counter.service';
import type { GlobalSpammerIntelligenceService } from './global-spammer-intelligence.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
type Proof = {
  messageDuplicateVerified: boolean;
  independentVerified: boolean;
  verifiedReasonKeys: string[];
  verifiedReasonDeadlines: { reasonKey: string; deadlineAtMs: number }[];
  independentRecheck?: PreparedDeleteAuthority<Proof>;
};
type Authorization = {
  authorizeGuardedUserDeleteReasons(
    intent: unknown,
    botId: string,
    finalDispatchLeaseToken?: string,
    beforeFinalAuthority?: () => Promise<void>,
  ): Promise<Proof>;
};

(databaseUrl ? describe : describe.skip)('mixed duplicate and independent current reasons', () => {
  let prisma: PrismaClient;
  const chats: string[] = [];
  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    )
      throw new Error('Mixed reason checks require disposable local PostgreSQL');
    prisma = createPrismaClient(databaseUrl);
    await prisma.$connect();
  });
  afterAll(async () => {
    if (!prisma) return;
    await prisma.chat.deleteMany({ where: { id: { in: chats } } });
    await prisma.$disconnect();
  });

  async function fixture() {
    const chatId = `-${BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 12)}`)}`;
    chats.push(chatId);
    await prisma.chat.create({ data: { id: chatId, title: 'Independent current reasons' } });
    await prisma.chatSettings.create({
      data: { chatId, maxMessageLengthEnabled: true, maxMessageLength: 10 },
    });
    const intent = await prisma.moderationDeleteIntent.create({
      data: {
        id: randomUUID(),
        chatId,
        messageId: 'one-message',
        subjectUserId: 'user',
        entityType: 'CHAT',
        originBotId: 'old-executor',
        messageAuthorKind: 'user',
        retryUntilAt: new Date(Date.now() + 60_000),
        reasons: {
          create: [
            {
              id: randomUUID(),
              reasonKey: 'MESSAGE_DUPLICATE:v1:1',
              ruleCode: 'DUPLICATE_DELETE',
              metadata: { duplicateSource: 'message_v1', messageDuplicate: { version: 1 } },
            },
            { id: randomUUID(), reasonKey: 'length', ruleCode: 'MESSAGE_TOO_LONG_DELETE' },
          ],
        },
      },
    });
    const message = {
      sender: { user_id: 'user', is_bot: false },
      recipient: { chat_id: chatId, chat_type: 'chat' },
      timestamp: Date.now(),
      body: { mid: 'one-message', text: '12345678901' },
    };
    const max = {
      getChatMemberAccess: jest.fn<
        ReturnType<MaxClientService['getChatMemberAccess']>,
        Parameters<MaxClientService['getChatMemberAccess']>
      >(async () => ({
        userId: 'user',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      })),
      getExactMessageRow: jest.fn<
        ReturnType<MaxClientService['getExactMessageRow']>,
        Parameters<MaxClientService['getExactMessageRow']>
      >(async () => message),
    } satisfies Pick<MaxClientService, 'getChatMemberAccess' | 'getExactMessageRow'>;
    const bots = {
      isKnownBotUserId: () => false,
    } satisfies Pick<MaxBotLinkService, 'isKnownBotUserId'>;
    const immunity = {
      consumeForMessage: async () => 'not_granted' as const,
    } satisfies Pick<ParticipantModerationImmunityService, 'consumeForMessage'>;
    const config = new ConfigService();
    const lengthGuard = new MessageLimitsDeleteGuardService(
      prisma as never,
      max as never,
      bots as never,
      immunity as never,
      config,
    );
    // FLAG: Actual SQL reasons, current-length guard and duplicate binding guard run together.
    // Invalid old binding must neither veto current length nor supply duplicate sanction authority.
    const duplicateGuard = new MessageDuplicateDeleteGuardService(
      prisma as never,
      max as never,
      bots as never,
      immunity as never,
      {} as never,
      {} as never,
      config,
      {} as never,
    );
    const service = Object.create(ModerationDeleteIntentService.prototype) as Authorization;
    Object.assign(service, {
      prisma,
      messageLimitsDeleteGuard: lengthGuard,
      messageDuplicateDeleteGuard: duplicateGuard,
    });
    return { service, intent, message, max, chatId, bots, config };
  }

  it.each([
    ['on', '', false, 'EXPIRED'],
    ['shadow', '', false, 'PENDING'],
    ['off', '', false, 'PENDING'],
    ['canary', 'other-chat', false, 'PENDING'],
    ['canary', '*', false, 'EXPIRED'],
    ['on', '', true, 'PENDING'],
  ] as const)(
    'queued expiry preserves rollout %s/%s and retention ownership %s',
    async (mode, canary, retentionOwned, expectedStatus) => {
      const s = await fixture();
      await prisma.moderationDeleteIntentReason.deleteMany({ where: { intentId: s.intent.id } });
      await prisma.moderationDeleteIntent.update({
        where: { id: s.intent.id },
        data: {
          executeAt: new Date(Date.now() - 120_000),
          nextAttemptAt: new Date(Date.now() - 120_000),
          retryUntilAt: new Date(Date.now() - 60_000),
          retentionOwned,
        },
      });
      const service = new ModerationDeleteIntentService(
        prisma as never,
        {} as never,
        {} as never,
        {} as never,
        new ConfigService({
          MODERATION_DELETE_INTENT_MODE: mode,
          MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: canary,
        }),
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
      const attempt = jest.spyOn(service, 'attemptIntent');
      await service.processQueuedIntent(s.intent.id);
      expect(attempt).not.toHaveBeenCalled();
      expect(
        await prisma.moderationDeleteIntent.findUniqueOrThrow({ where: { id: s.intent.id } }),
      ).toMatchObject({
        status: expectedStatus,
        attemptCount: 0,
        retentionOwned,
        remoteDeleteSucceededAt: null,
        deleteDispatchStartedAt: null,
      });
    },
  );

  it.each(['valid length', 'disabled policy', 'protected author', 'participant immunity'] as const)(
    'rechecks SQL independent authority after final duplicate refusal: %s',
    async (change) => {
      const s = await fixture();
      const immunity = new ParticipantModerationImmunityService(prisma as never);
      const duplicateGuard = {
        assertIntentStillActionable: jest.fn<
          ReturnType<MessageDuplicateDeleteGuardService['assertIntentStillActionable']>,
          Parameters<MessageDuplicateDeleteGuardService['assertIntentStillActionable']>
        >(async (params) => {
          if (!params.authorityOnly) return 'allowed';
          if (change === 'disabled policy')
            await prisma.chatSettings.update({
              where: { chatId: s.chatId },
              data: { maxMessageLengthEnabled: false },
            });
          if (change === 'protected author')
            await prisma.chatAdminAllowlist.create({
              data: { chatId: s.chatId, userId: 'user' },
            });
          if (change === 'participant immunity')
            await prisma.chatParticipantModerationImmunity.create({
              data: {
                chatId: s.chatId,
                userId: 'user',
                dailyViolationLimit: 1,
                expiresAt: new Date(Date.now() + 3_600_000),
              },
            });
          throw new MessageDuplicateGuardRejectedError(
            'message_duplicate_action_authority_revoked',
          );
        }),
      } satisfies Pick<MessageDuplicateDeleteGuardService, 'assertIntentStillActionable'>;
      Object.assign(s.service, {
        messageDuplicateDeleteGuard: duplicateGuard,
        participantImmunity: immunity,
      });
      const admission = jest.fn(async () => undefined);
      const proof = await s.service.authorizeGuardedUserDeleteReasons(
        s.intent,
        'healthy-executor',
        undefined,
        admission,
      );
      expect(proof).toMatchObject({
        messageDuplicateVerified: true,
        independentVerified: true,
        verifiedReasonKeys: ['length'],
      });
      await expect(
        duplicateGuard.assertIntentStillActionable({
          intentId: s.intent.id,
          chatId: s.chatId,
          messageId: s.intent.messageId,
          subjectUserId: 'user',
          botId: 'healthy-executor',
          authorityOnly: true,
        }),
      ).rejects.toMatchObject({ code: 'message_duplicate_action_authority_revoked' });
      expect(proof.independentRecheck).toBeDefined();
      const finalProof = finalizeDeleteAuthority(proof.independentRecheck!);
      if (change === 'valid length')
        await expect(finalProof).resolves.toMatchObject({
          messageDuplicateVerified: false,
          independentVerified: true,
          verifiedReasonKeys: ['length'],
          verifiedReasonDeadlines: [],
        });
      else
        await expect(finalProof).rejects.toMatchObject({
          code: 'moderation_delete_reasons_no_longer_authorized',
        });
      expect(admission).toHaveBeenCalledTimes(1);
      expect(duplicateGuard.assertIntentStillActionable).toHaveBeenCalledTimes(2);
      expect(s.max.getExactMessageRow).toHaveBeenCalledTimes(1);
      expect(s.max.getChatMemberAccess).toHaveBeenCalledTimes(1);
      const retained = await prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { id: s.intent.id },
      });
      expect(retained.remoteDeleteSucceededAt).toBeNull();
      expect(retained.retryUntilAt).toEqual(s.intent.retryUntilAt);
    },
  );

  (redisUrl ? describe : describe.skip)('current SQL authority after quota admission', () => {
    let counters: RedisCounterService;
    let locks: ModerationSanctionStateLockService;
    beforeAll(() => {
      if (!/^redis:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/u.test(redisUrl))
        throw new Error('Quota authority checks require disposable local Redis');
      counters = new RedisCounterService(new ConfigService({ REDIS_URL: redisUrl }));
      locks = new ModerationSanctionStateLockService(counters);
    });
    afterAll(async () => {
      await counters?.onModuleDestroy();
    });

    async function mutedFixture(withLength: boolean) {
      const s = await fixture();
      const sourceAt = new Date(s.message.timestamp);
      const mute = await prisma.moderationEvent.create({
        data: {
          chatId: s.chatId,
          userId: 'user',
          eventType: 'MEMBER_ACTION',
          action: 'MUTE',
          ruleCode: 'NATIVE_QUOTA_MUTE',
          createdAt: new Date(sourceAt.getTime() - 1_000),
          metadata: { muteExpiresAt: new Date(sourceAt.getTime() + 3_600_000).toISOString() },
        },
      });
      await prisma.moderationDeleteIntentReason.deleteMany({ where: { intentId: s.intent.id } });
      const intent = await prisma.moderationDeleteIntent.update({
        where: { id: s.intent.id },
        data: {
          sourceMessageAt: sourceAt,
          retryUntilAt: new Date(sourceAt.getTime() + 300_000),
          reasons: {
            create: [
              {
                id: randomUUID(),
                reasonKey: 'muted',
                ruleCode: 'MUTE_ACTIVE_DELETE',
                userId: 'user',
                metadata: { muteEventId: mute.id },
              },
              ...(withLength
                ? [
                    {
                      id: randomUUID(),
                      reasonKey: 'length',
                      ruleCode: 'MESSAGE_TOO_LONG_DELETE',
                      userId: 'user',
                    },
                  ]
                : []),
            ],
          },
        },
      });
      const immunity = new ParticipantModerationImmunityService(prisma as never);
      const fence = new ModerationSanctionStateFenceService(prisma as never);
      const globalPolicy = {
        evaluatePolicy: jest.fn<
          ReturnType<GlobalSpammerIntelligenceService['evaluatePolicy']>,
          Parameters<GlobalSpammerIntelligenceService['evaluatePolicy']>
        >(async () => {
          throw new Error('Mute authority must not query global policy');
        }),
      } satisfies Pick<GlobalSpammerIntelligenceService, 'evaluatePolicy'>;
      const stateGuard = new ModerationStateDeleteGuardService(
        prisma as never,
        s.max as never,
        s.bots as never,
        immunity,
        fence,
        globalPolicy as unknown as GlobalSpammerIntelligenceService,
        s.config,
      );
      Object.assign(s.service, {
        moderationStateDeleteGuard: stateGuard,
        participantImmunity: immunity,
      });
      const unmute = () =>
        locks.runExclusive({ chatId: s.chatId, userId: 'user' }, async (lease) => {
          await lease.assertOwned();
          const transition = await fence.prepare({
            chatId: s.chatId,
            userId: 'user',
            intendedAction: 'UNMUTE',
            operator: 'ADMIN',
            source: 'native-quota-regression',
          });
          const release = await prisma.moderationEvent.create({
            data: {
              chatId: s.chatId,
              userId: 'user',
              eventType: 'MEMBER_ACTION',
              action: 'NONE',
              ruleCode: 'MANUAL_UNMUTE',
              operator: 'ADMIN',
            },
          });
          await fence.commit(transition, release.id);
          await lease.assertOwned();
        });
      return { ...s, intent, unmute };
    }

    it('rejects a mute-only DELETE when manual unmute commits during quota admission', async () => {
      const s = await mutedFixture(false);
      const admission = jest.fn(async () => {
        expect(s.max.getChatMemberAccess).toHaveBeenCalledTimes(1);
        expect(s.max.getExactMessageRow).toHaveBeenCalledTimes(1);
        await s.unmute();
      });
      await expect(
        s.service.authorizeGuardedUserDeleteReasons(
          s.intent,
          'healthy-executor',
          undefined,
          admission,
        ),
      ).rejects.toMatchObject({ code: 'moderation_delete_reasons_no_longer_authorized' });
      expect(admission).toHaveBeenCalledTimes(1);
      expect(s.max.getChatMemberAccess).toHaveBeenCalledTimes(1);
      expect(s.max.getExactMessageRow).toHaveBeenCalledTimes(1);
      const retained = await prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { id: s.intent.id },
      });
      expect(retained.remoteDeleteSucceededAt).toBeNull();
      expect(retained.retryUntilAt).toEqual(s.intent.retryUntilAt);
    });

    it.each(['manual-unmute', 'disabled-length'] as const)(
      'retains only the independent survivor when %s commits during quota admission',
      async (change) => {
        const s = await mutedFixture(true);
        const admission = jest.fn(async () => {
          expect(s.max.getChatMemberAccess).toHaveBeenCalledTimes(2);
          expect(s.max.getExactMessageRow).toHaveBeenCalledTimes(2);
          if (change === 'manual-unmute') await s.unmute();
          else
            await prisma.chatSettings.update({
              where: { chatId: s.chatId },
              data: { maxMessageLengthEnabled: false },
            });
        });
        const proof = await s.service.authorizeGuardedUserDeleteReasons(
          s.intent,
          'healthy-executor',
          undefined,
          admission,
        );
        const survivor = change === 'manual-unmute' ? 'length' : 'muted';
        expect(proof).toMatchObject({
          independentVerified: true,
          messageDuplicateVerified: false,
          verifiedReasonKeys: [survivor],
        });
        expect(proof.verifiedReasonDeadlines.map((permit) => permit.reasonKey)).toEqual(
          survivor === 'muted' ? ['muted'] : [],
        );
        expect(admission).toHaveBeenCalledTimes(1);
        expect(s.max.getChatMemberAccess).toHaveBeenCalledTimes(2);
        expect(s.max.getExactMessageRow).toHaveBeenCalledTimes(2);
        const reasons = await prisma.moderationDeleteIntentReason.findMany({
          where: { intentId: s.intent.id },
        });
        expect(reasons).toHaveLength(2);
        expect(
          reasons.some((reason) =>
            Object.prototype.hasOwnProperty.call(reason.metadata ?? {}, 'moderationDeleteVerified'),
          ),
        ).toBe(false);
      },
    );

    it('protects a participant granted immunity while both independent reasons wait for quota', async () => {
      const s = await mutedFixture(true);
      const admission = jest.fn(async () => {
        expect(s.max.getChatMemberAccess).toHaveBeenCalledTimes(2);
        expect(s.max.getExactMessageRow).toHaveBeenCalledTimes(2);
        await prisma.chatParticipantModerationImmunity.create({
          data: {
            chatId: s.chatId,
            userId: 'user',
            dailyViolationLimit: 1,
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        });
      });
      await expect(
        s.service.authorizeGuardedUserDeleteReasons(
          s.intent,
          'healthy-executor',
          undefined,
          admission,
        ),
      ).rejects.toMatchObject({ code: 'moderation_delete_reasons_no_longer_authorized' });
      expect(admission).toHaveBeenCalledTimes(1);
      expect(s.max.getChatMemberAccess).toHaveBeenCalledTimes(2);
      expect(s.max.getExactMessageRow).toHaveBeenCalledTimes(2);
      const grant = await prisma.chatParticipantModerationImmunity.findUniqueOrThrow({
        where: { chatId_userId: { chatId: s.chatId, userId: 'user' } },
      });
      expect(grant.dailyViolationUsage).toBe(1);
      expect(
        await prisma.moderationViolationMessageClaim.count({ where: { chatId: s.chatId } }),
      ).toBe(1);
      const retained = await prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { id: s.intent.id },
      });
      expect(retained.remoteDeleteSucceededAt).toBeNull();
      expect(retained.retryUntilAt).toEqual(s.intent.retryUntilAt);
      const reasons = await prisma.moderationDeleteIntentReason.findMany({
        where: { intentId: s.intent.id },
      });
      expect(reasons).toHaveLength(2);
      expect(
        reasons.some((reason) =>
          Object.prototype.hasOwnProperty.call(reason.metadata ?? {}, 'moderationDeleteVerified'),
        ),
      ).toBe(false);
    });
  });

  it.each([false, true])(
    'terminalizes retired photo evidence while rechecking a concurrently added independent reason (%s)',
    async (addIndependent) => {
      const s = await fixture();
      await prisma.moderationDeleteIntentReason.deleteMany({ where: { intentId: s.intent.id } });
      await prisma.moderationDeleteIntentReason.create({
        data: {
          id: randomUUID(),
          intentId: s.intent.id,
          reasonKey: 'old-photo',
          ruleCode: 'DUPLICATE_DELETE',
          metadata: {
            duplicateSource: 'photo',
            matchKind: 'canonical_sha256',
            preset: 'SAME_IMAGE',
            scope: 'SAME_AUTHOR',
          },
        },
      });
      const leaseToken = randomUUID();
      await prisma.moderationDeleteIntent.update({
        where: { id: s.intent.id },
        data: {
          status: 'IN_PROGRESS',
          leaseToken,
          leaseExpiresAt: new Date(Date.now() + 60_000),
        },
      });
      const service = s.service as unknown as {
        loadRequiredIntent(id: string): Promise<unknown>;
        finishTerminalPreDispatchGuardRejection(
          intent: unknown,
          token: string,
          details: unknown,
        ): Promise<unknown>;
      };
      const enqueueWakeup = jest.fn().mockResolvedValue(undefined);
      Object.assign(service, { enqueueWakeup, mode: 'on', canaryChatIds: new Set() });
      const original = await service.loadRequiredIntent(s.intent.id);
      if (addIndependent)
        await prisma.moderationDeleteIntentReason.create({
          data: {
            id: randomUUID(),
            intentId: s.intent.id,
            reasonKey: 'new-length',
            ruleCode: 'MESSAGE_TOO_LONG_DELETE',
          },
        });
      await service.finishTerminalPreDispatchGuardRejection(original, leaseToken, {
        statusCode: null,
        errorCode: 'photo_duplicate_legacy_evidence_retired',
        message: 'Retired photo evidence cannot authorize a new deletion',
      });
      const actual = await prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { id: s.intent.id },
      });
      expect(actual.status).toBe(addIndependent ? 'RETRYABLE' : 'FAILED_TERMINAL');
      expect(actual.leaseToken).toBeNull();
      expect(actual.leaseExpiresAt).toBeNull();
      expect(actual.remoteDeleteSucceededAt).toBeNull();
      expect(enqueueWakeup).toHaveBeenCalledTimes(addIndependent ? 1 : 0);
      expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
    },
  );

  it.each([
    'unchanged',
    'expired independent reason',
    'active independent reason',
    'active horizon',
  ])('rechecks acknowledged cleanup after a concurrent parent writer: %s', async (change) => {
    const s = await fixture();
    await prisma.moderationDeleteIntentReason.deleteMany({ where: { intentId: s.intent.id } });
    const leaseToken = randomUUID();
    const acknowledgedAt = new Date(Date.now() - 86_400_000);
    const expiredHorizon = new Date(Date.now() - 1_000);
    const activeHorizon = new Date(Date.now() + 60_000);
    await prisma.moderationDeleteIntent.update({
      where: { id: s.intent.id },
      data: {
        status: 'IN_PROGRESS',
        messageAuthorKind: 'bot',
        routingPolicy: 'origin_only',
        leaseToken,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        remoteDeleteSucceededAt: acknowledgedAt,
        remoteDeleteSucceededBotId: 'old-executor',
        sourceMessageAt: new Date(acknowledgedAt.getTime() - 120_000),
        executeAt: new Date(acknowledgedAt.getTime() - 60_000),
        firstAttemptAt: acknowledgedAt,
        lastAttemptAt: new Date(),
        createdAt: new Date(acknowledgedAt.getTime() - 120_000),
        retryUntilAt: expiredHorizon,
        attemptCount: 44,
        reasons: {
          create: {
            id: randomUUID(),
            reasonKey: 'auto-delete',
            ruleCode: 'BOT_MESSAGE_AUTO_DELETE',
          },
        },
      },
    });
    const service = s.service as unknown as {
      loadRequiredIntent(id: string): Promise<unknown>;
      finishRetryableAttempt(intent: unknown, token: string, details: unknown): Promise<unknown>;
    };
    const enqueueWakeup = jest.fn().mockResolvedValue(undefined);
    Object.assign(service, { enqueueWakeup });
    const original = await service.loadRequiredIntent(s.intent.id);

    let writerReady!: () => void;
    let releaseWriter!: () => void;
    let retryLockAttempted!: () => void;
    const ready = new Promise<void>((resolve) => (writerReady = resolve));
    const release = new Promise<void>((resolve) => (releaseWriter = resolve));
    const lockAttempted = new Promise<void>((resolve) => (retryLockAttempted = resolve));
    const writer = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "moderation_delete_intents"
          WHERE "id" = ${s.intent.id} FOR UPDATE`;
      if (change.endsWith('independent reason')) {
        await tx.moderationDeleteIntentReason.create({
          data: {
            id: randomUUID(),
            intentId: s.intent.id,
            reasonKey: 'new-independent-reason',
            ruleCode: 'MESSAGE_TOO_LONG_DELETE',
          },
        });
      }
      if (change.startsWith('active')) {
        await tx.moderationDeleteIntent.update({
          where: { id: s.intent.id },
          data: { retryUntilAt: activeHorizon, nextAttemptAt: new Date() },
        });
      }
      writerReady();
      await release;
    });
    await ready;
    Object.assign(service, {
      prisma: {
        $queryRaw: prisma.$queryRaw.bind(prisma),
        $executeRaw: prisma.$executeRaw.bind(prisma),
        $transaction: (
          callback: (
            tx: Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>,
          ) => Promise<unknown>,
          options: { isolationLevel: Prisma.TransactionIsolationLevel },
        ) =>
          prisma.$transaction(
            (tx) =>
              callback({
                $executeRaw: tx.$executeRaw.bind(tx),
                $queryRaw: ((query: Prisma.Sql) => {
                  if (query.strings.join('?').includes('FOR UPDATE')) retryLockAttempted();
                  return tx.$queryRaw(query);
                }) as Prisma.TransactionClient['$queryRaw'],
              }),
            options,
          ),
      },
    });
    const startedAt = Date.now();
    const retry = service.finishRetryableAttempt(original, leaseToken, {
      status: 'WAITING_CAPABILITY',
      statusCode: 404,
      errorCode: 'predelete_presence_unknown',
      message: 'Exact presence is unavailable',
      retryDelayMs: 300_000,
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        lockAttempted,
        new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => reject(new Error('Retry did not lock its parent')), 2_000);
        }),
      ]);
    } finally {
      if (deadline) clearTimeout(deadline);
      releaseWriter();
    }
    await writer;
    await retry;

    const actual = await prisma.moderationDeleteIntent.findUniqueOrThrow({
      where: { id: s.intent.id },
    });
    const expectedDelayMs = change === 'unchanged' ? 3_600_000 : 300_000;
    expect(actual.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(startedAt + expectedDelayMs);
    expect(actual.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now() + expectedDelayMs);
    expect(actual.retryUntilAt).toEqual(
      change.startsWith('active') ? activeHorizon : expiredHorizon,
    );
    expect(actual.status).toBe('AMBIGUOUS');
    expect(actual.remoteDeleteSucceededAt).toEqual(acknowledgedAt);
    expect(actual.remoteDeleteSucceededBotId).toBe('old-executor');
    expect(actual.deleteDispatchStartedAt).toBeNull();
    expect(actual.leaseToken).toBeNull();
    expect(enqueueWakeup).toHaveBeenCalledTimes(1);
    expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
    expect(s.max.getChatMemberAccess).not.toHaveBeenCalled();
  });

  it.each([
    'unchanged',
    'metadata',
    'score',
    'new-link',
    'independent',
    'ambiguous',
    'remote-success',
  ] as const)(
    'settles a rejected link without self-retry while preserving %s evidence',
    async (change) => {
      const s = await fixture();
      await prisma.moderationDeleteIntentReason.deleteMany({ where: { intentId: s.intent.id } });
      const reason = await prisma.moderationDeleteIntentReason.create({
        data: {
          id: randomUUID(),
          intentId: s.intent.id,
          reasonKey: 'link-1',
          ruleCode: 'LINK_BLOCKED_DELETE',
          metadata: { linkPolicyRevision: 1, linkPolicyEffectiveAt: new Date().toISOString() },
        },
      });
      const guard = new LinkHistoryDeleteGuardService(
        prisma as never,
        s.max as never,
        { isKnownBotUserId: () => false } as never,
        new ConfigService(),
      );
      let rejection: unknown;
      try {
        await guard.assertIntentStillActionable({
          intentId: s.intent.id,
          chatId: s.chatId,
          messageId: s.intent.messageId,
          subjectUserId: 'user',
          botId: 'healthy-executor',
        });
      } catch (error) {
        rejection = error;
      }
      expect(rejection).toBeInstanceOf(LinkHistoryDeleteGuardRejectedError);
      expect(rejection).toMatchObject({
        code: 'live_policy_inactive',
        reasonFingerprint: expect.any(String),
      });
      const token = randomUUID();
      await prisma.moderationDeleteIntent.update({
        where: { id: s.intent.id },
        data: {
          status: 'IN_PROGRESS',
          leaseToken: token,
          leaseExpiresAt: new Date(Date.now() + 60_000),
          attemptCount: 4000,
          ...(change === 'ambiguous'
            ? { deleteDispatchStartedAt: new Date(), deleteDispatchStartedBotId: 'old-executor' }
            : {}),
          ...(change === 'remote-success'
            ? { remoteDeleteSucceededAt: new Date(), remoteDeleteSucceededBotId: 'old-executor' }
            : {}),
        },
      });
      const service = s.service as unknown as {
        loadRequiredIntent(id: string): Promise<unknown>;
        finishTerminalPreDispatchGuardRejection(
          intent: unknown,
          token: string,
          details: unknown,
          error: unknown,
        ): Promise<unknown>;
      };
      const enqueueWakeup = jest.fn().mockResolvedValue(undefined);
      Object.assign(service, { enqueueWakeup, mode: 'on', canaryChatIds: new Set() });
      const original = await service.loadRequiredIntent(s.intent.id);
      if (change === 'score')
        await prisma.moderationDeleteIntentReason.update({
          where: { id: reason.id },
          data: { score: 5 },
        });
      if (change === 'metadata')
        await prisma.moderationDeleteIntentReason.update({
          where: { id: reason.id },
          data: { metadata: { linkPolicyRevision: 2 } },
        });
      if (change === 'new-link' || change === 'independent')
        await prisma.moderationDeleteIntentReason.create({
          data: {
            id: randomUUID(),
            intentId: s.intent.id,
            reasonKey: 'new-reason',
            ruleCode: change === 'new-link' ? 'LINK_BLOCKED_DELETE' : 'MESSAGE_TOO_LONG_DELETE',
          },
        });
      await service.finishTerminalPreDispatchGuardRejection(
        original,
        token,
        {
          statusCode: null,
          errorCode: 'live_policy_inactive',
          message: 'Policy inactive',
        },
        rejection,
      );
      const actual = await prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { id: s.intent.id },
      });
      const expected = ['ambiguous', 'remote-success'].includes(change)
        ? 'AMBIGUOUS'
        : change === 'unchanged'
          ? 'FAILED_TERMINAL'
          : 'RETRYABLE';
      expect(actual.status).toBe(expected);
      expect(actual.leaseToken).toBeNull();
      expect(actual.retryUntilAt).toEqual(s.intent.retryUntilAt);
      expect(actual.attemptCount).toBe(4000);
      expect(enqueueWakeup).toHaveBeenCalledTimes(expected === 'FAILED_TERMINAL' ? 0 : 1);
      expect(Boolean(actual.deleteDispatchStartedAt)).toBe(change === 'ambiguous');
      expect(Boolean(actual.remoteDeleteSucceededAt)).toBe(change === 'remote-success');
      expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
    },
  );

  it.each([1, 4, 9, 13])(
    'authorizes length without borrowing duplicate authority for %s receipts',
    async (bots) => {
      const s = await fixture();
      for (let bot = 0; bot < bots; bot++) {
        expect(
          await s.service.authorizeGuardedUserDeleteReasons(s.intent, 'healthy-executor'),
        ).toMatchObject({
          messageDuplicateVerified: false,
          independentVerified: true,
        });
      }
      expect(await prisma.moderationDeleteIntent.count({ where: { chatId: s.chatId } })).toBe(1);
      expect(
        await prisma.moderationDeleteIntentReason.count({ where: { intentId: s.intent.id } }),
      ).toBe(2);
      expect(s.max.getExactMessageRow).toHaveBeenCalledWith(
        s.chatId,
        'one-message',
        expect.objectContaining({ botId: 'healthy-executor', bypassCache: true }),
      );
    },
  );

  it.each(['edited', 'disabled'] as const)(
    'rejects both obsolete reasons when length is %s',
    async (change) => {
      const s = await fixture();
      if (change === 'edited') s.message.body.text = 'short';
      else
        await prisma.chatSettings.update({
          where: { chatId: s.chatId },
          data: { maxMessageLengthEnabled: false },
        });
      await expect(
        s.service.authorizeGuardedUserDeleteReasons(s.intent, 'healthy-executor'),
      ).rejects.toMatchObject({ code: 'moderation_delete_reasons_no_longer_authorized' });
    },
  );

  it('stops on unknown access even when another old reason is independently stored', async () => {
    const s = await fixture();
    const error = Object.assign(new Error('MAX unavailable'), { response: { status: 503 } });
    s.max.getChatMemberAccess.mockRejectedValue(error);
    await expect(
      s.service.authorizeGuardedUserDeleteReasons(s.intent, 'healthy-executor'),
    ).rejects.toBe(error);
  });
});
