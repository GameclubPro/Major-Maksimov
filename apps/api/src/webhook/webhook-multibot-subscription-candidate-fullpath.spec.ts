import { randomUUID } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import type { HttpService } from '@nestjs/axios';
import { map, throwError } from 'rxjs';
import { MAX_API_SOURCE_TAGS, MaxApiInternalRateLimitError } from '../max/max-client.service';
import { buildMaxActionIdempotencyKey } from '../max/max-action-idempotency';
import { maxMuteApiBudgetKeys } from '../max/max-moderation-api-budget';
import { MaxMembershipLookupService } from '../max/max-membership-lookup.service';
import { Prisma, type RequiredSubscriptionCandidate } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  MODERATION_EXECUTION_LEGACY,
  ModerationExecutionService,
  type ModerationExecutionLegacy,
} from '../moderation/moderation-execution.service';
import { RequiredSubscriptionCandidateService } from '../moderation/required-subscription-candidate.service';
import { RequiredSubscriptionCandidateStore } from '../moderation/required-subscription-candidate.store';
import { WebhookLegacyHoldService } from './webhook-legacy-hold.service';
import {
  createMultibotHarness,
  type MultibotHarness,
} from './webhook-multibot-fullpath.spec-support';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const describeStores = databaseUrl && redisUrl ? describe : describe.skip;
jest.setTimeout(60_000);
const initialReadBoundaries = [
  'membership',
  'author',
  'source',
  'author-http429',
  'source-http429',
  'source-fallback-http429',
] as const;
type InitialReadBoundary = (typeof initialReadBoundaries)[number];

describeStores(
  'native required-subscription local-quota continuation through production callers',
  () => {
    let h: MultibotHarness | undefined;
    let runtime: TestingModule | undefined;
    const replacementLookups: MaxMembershipLookupService[] = [];
    const fixtureCutoffs: Array<{ id: string; finishedAt: Date }> = [];

    afterEach(async () => {
      await runtime?.close();
      runtime = undefined;
      jest.restoreAllMocks();
      await Promise.all(replacementLookups.splice(0).map((lookup) => lookup.onModuleDestroy()));
      for (const cutoff of fixtureCutoffs.splice(0))
        await h!.prisma.$executeRaw`
        UPDATE _prisma_migrations SET finished_at = ${cutoff.finishedAt} WHERE id = ${cutoff.id}
      `;
      await h?.dispose();
      h = undefined;
    });

    async function startRuntime(s: MultibotHarness) {
      const legacy: ModerationExecutionLegacy = {
        executeRequiredSubscriptionCandidate: (attempt) =>
          s.moderation.executeRequiredSubscriptionCandidate(attempt),
        processWebhookEvent: (id) => s.moderation.processWebhookEvent(id),
        processNightModeTransitionJob: (job) => s.moderation.processNightModeTransitionJob(job),
      };
      runtime = await Test.createTestingModule({
        providers: [
          { provide: PrismaService, useValue: s.prisma },
          { provide: WebhookLegacyHoldService, useValue: s.legacyHolds },
          { provide: MODERATION_EXECUTION_LEGACY, useValue: legacy },
          ModerationExecutionService,
          RequiredSubscriptionCandidateStore,
          RequiredSubscriptionCandidateService,
        ],
      }).compile();
      // FLAG: Discovery is driven explicitly; the real worker still resolves the public facade
      // through Nest's ModuleRef, using the same SQL store and hold reader as production.
      const store = runtime.get(RequiredSubscriptionCandidateStore);
      const worker = runtime.get(RequiredSubscriptionCandidateService);
      Object.assign(s.moderation, { requiredSubscriptionCandidateStore: store });
      return { store, worker };
    }

    async function fixture(
      settings: Prisma.ChatSettingsUncheckedCreateWithoutChatInput = {},
      boundary: InitialReadBoundary = 'membership',
    ) {
      const s = (h = await createMultibotHarness({ databaseUrl, redisUrl, bots: 3, mode: 'on' }));
      const [chatId] = await s.seedCatalog(1, {
        maxMessageLengthEnabled: false,
        antiDuplicateEnabled: false,
        antiSpamEnabled: false,
        requiredSubscriptionEnabled: true,
        requiredSubscriptionWarnEnabled: true,
        ...settings,
      });
      const [targetId] = await s.seedCatalog(1, {}, 'CHANNEL');
      await s.prisma.chatSettings.update({
        where: { chatId: chatId! },
        data: { requiredSubscriptionChannelIds: [targetId!] },
      });
      let membership: 'quota' | 'missing' | 'present' =
        boundary === 'membership' ? 'quota' : 'missing';
      const original = s.max.getChatMembersAccess.bind(s.max);
      const targetReads = jest
        .spyOn(s.max, 'getChatMembersAccess')
        .mockImplementation(async (...args) => {
          if (args[0] !== targetId) return original(...args);
          if (membership === 'quota')
            throw new MaxApiInternalRateLimitError('Disposable membership GET quota refusal', 20);
          return membership === 'missing' ? new Map() : original(...args);
        });
      let readUnavailable = true;
      let activeHttpRead: 'author' | 'source' | null = null;
      const http = (s.max as unknown as { httpService: HttpService }).httpService;
      const originalHttpRequest = http.request.bind(http);
      const limitedHttpReads: string[] = [];
      jest.spyOn(http, 'request').mockImplementation((request) => {
        const url = new URL(String(request.url));
        if (readUnavailable && activeHttpRead && request.method === 'get') {
          if (
            activeHttpRead === 'source' &&
            boundary === 'source-fallback-http429' &&
            url.pathname === '/messages'
          )
            return originalHttpRequest(request).pipe(
              map((response) => ({ ...response, data: { messages: [] } })),
            );
          if (
            (activeHttpRead === 'source' && url.pathname.startsWith('/messages')) ||
            (activeHttpRead === 'author' && url.pathname === `/chats/${chatId}/members`)
          ) {
            limitedHttpReads.push(url.pathname);
            return throwError(() =>
              Object.assign(new Error('Disposable adapter GET 429'), {
                config: request,
                response: { status: 429, headers: { 'retry-after': '0.001' } },
              }),
            );
          }
        }
        return originalHttpRequest(request);
      });
      const originalAuthorRead = s.max.getChatMemberAccess.bind(s.max);
      const authorReads = jest
        .spyOn(s.max, 'getChatMemberAccess')
        .mockImplementation(async (...args) => {
          const options = args[2];
          const initialAuthor =
            args[0] === chatId &&
            args[1] === 'fixture-user' &&
            typeof options === 'object' &&
            options.sourceTag === MAX_API_SOURCE_TAGS.MODERATION_DELETE;
          if (initialAuthor && readUnavailable && boundary === 'author')
            throw new MaxApiInternalRateLimitError('Disposable author GET quota refusal', 20);
          if (initialAuthor && boundary === 'author-http429') activeHttpRead = 'author';
          try {
            return await originalAuthorRead(...args);
          } finally {
            activeHttpRead = null;
          }
        });
      const originalSourceRead = s.max.getExactMessageRow.bind(s.max);
      const sourceReads = jest
        .spyOn(s.max, 'getExactMessageRow')
        .mockImplementation(async (...args) => {
          if (args[0] === chatId && readUnavailable && boundary === 'source')
            throw new MaxApiInternalRateLimitError('Disposable exact source GET quota refusal', 20);
          if (
            args[0] === chatId &&
            (boundary === 'source-http429' || boundary === 'source-fallback-http429')
          )
            activeHttpRead = 'source';
          try {
            return await originalSourceRead(...args);
          } finally {
            activeHttpRead = null;
          }
        });
      let services = await startRuntime(s);
      const restart = async (next: 'missing' | 'present' = 'missing') => {
        await runtime!.close();
        membership = next;
        readUnavailable = false;
        // FLAG: A real new lookup models process restart. It has no inherited in-memory
        // GET backoff; SQL candidates, original deadlines and shared Redis remain intact.
        const lookup = new MaxMembershipLookupService(s.max, s.config, s.links);
        await lookup.onModuleInit();
        replacementLookups.push(lookup);
        Object.assign(s.moderation, { membershipLookupService: lookup });
        Object.assign(s.subscriptionGuard, { membership: lookup });
        services = await startRuntime(s);
        return services;
      };
      return {
        s,
        chatId: chatId!,
        targetId: targetId!,
        targetReads,
        sourceReads,
        authorReads,
        limitedHttpReads,
        restart,
        services: () => services,
      };
    }

    async function nominate(
      f: Awaited<ReturnType<typeof fixture>>,
      options: { at?: number; media?: boolean; mirrors?: boolean } = {},
    ) {
      const messageId = `subscription-candidate-${randomUUID()}`;
      const at = options.at ?? Date.now();
      if (Date.now() - at > 60_000 && !fixtureCutoffs.length) {
        const [cutoff] = await f.s.prisma.$queryRaw<Array<{ id: string; finishedAt: Date }>>`
        SELECT id, finished_at AS "finishedAt" FROM _prisma_migrations
        WHERE migration_name = '20261005020000_add_multibot_order_fences'
          AND rolled_back_at IS NULL AND finished_at IS NOT NULL
        ORDER BY finished_at DESC LIMIT 1
      `;
        if (!cutoff) throw new Error('Expected native fixture authority migration');
        fixtureCutoffs.push(cutoff);
        // FLAG: The disposable migration ran moments ago. Model a legitimate source
        // after its rollout cutoff, preserving the real runtime hold reader and SQL clock.
        await f.s.prisma.$executeRaw`
        UPDATE _prisma_migrations SET finished_at = ${new Date(at - 60_000)} WHERE id = ${cutoff.id}
      `;
      }
      const ids = await Promise.all(
        (options.mirrors ? f.s.bots : f.s.bots.slice(0, 1)).map((bot) =>
          f.s.ingest({
            chatId: f.chatId,
            messageId,
            botId: bot.id,
            at,
            text: options.media ? '' : 'Harmless source awaiting an exact subscription check',
            ...(options.media
              ? {
                  attachments: [
                    { type: 'image', payload: { url: 'https://fixture.invalid/candidate.jpg' } },
                  ],
                }
              : {}),
          }),
        ),
      );
      await f.s.drain();
      expect(f.s.failures).toEqual([]);
      const row = await f.s.prisma.requiredSubscriptionCandidate.findFirstOrThrow({
        where: { chatId: f.chatId, messageId },
      });
      expect(row).toMatchObject({ status: 'WAITING_CHECK', claimId: null, frozenPlan: null });
      expect(row.sourceAt.getTime()).toBe(at);
      expect(row.deadlineAt.getTime()).toBe(at + 300_000);
      return { row, ids, messageId, at };
    }

    async function expectNoEffect(s: MultibotHarness, chatId: string) {
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(0);
      const claims = await s.prisma.moderationViolationMessageClaim.findMany({ where: { chatId } });
      // FLAG: The handled source still revokes deferred duplicate actions. Its denial
      // tombstone has no message-action key and cannot become a subscription claim.
      for (const claim of claims)
        expect(claim).toMatchObject({
          messageActionKey: null,
          ruleCode: 'MESSAGE_DUPLICATE_AUTHORIZATION_REVOKED',
          updateType: 'message_duplicate_authorization',
        });
      expect(await s.prisma.moderationDeleteIntent.count({ where: { chatId } })).toBe(0);
      expect(s.effects).toEqual([]);
    }

    async function due(s: MultibotHarness, id: string) {
      await s.prisma.requiredSubscriptionCandidate.update({
        where: { id },
        data: { nextAttemptAt: new Date(Date.now() - 1000) },
      });
    }

    async function read(s: MultibotHarness, row: RequiredSubscriptionCandidate) {
      return s.prisma.requiredSubscriptionCandidate.findUniqueOrThrow({ where: { id: row.id } });
    }

    it('keeps a refused target route unknown after restart without a default-bot probe or sanction', async () => {
      const f = await fixture();
      const source = await nominate(f);
      await f.s.prisma.chat.update({
        where: { id: f.targetId },
        data: { primaryBotId: null, botId: null, routingState: 'NO_ELIGIBLE_BOT' },
      });
      expect(await f.s.links.resolveBotIdForRead({ chatId: f.targetId })).toBeNull();
      const { worker } = await f.restart();
      f.targetReads.mockClear();
      expect(await worker.sweep()).toBe(1);
      const pending = await read(f.s, source.row);
      expect(pending).toMatchObject({ status: 'WAITING_CHECK', frozenPlan: null, claimId: null });
      expect(pending.deadlineAt).toEqual(source.row.deadlineAt);
      expect(f.targetReads).not.toHaveBeenCalled();
      await expectNoEffect(f.s, f.chatId);

      const following = await f.s.ingest({
        chatId: f.chatId,
        messageId: `following-refused-route-${randomUUID()}`,
        text: 'Independent receipt after an unavailable target route',
        senderless: true,
      });
      await f.s.drain();
      expect(
        (await f.s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: following } })).status,
      ).toBe('PROCESSED');
      await expectNoEffect(f.s, f.chatId);
    });

    it.each(initialReadBoundaries)(
      'registers without effects on the initial %s GET refusal and discovers one frozen decision after restart across mirrors',
      async (boundary) => {
        const f = await fixture({}, boundary);
        const handler = jest.spyOn(f.s.moderation, 'handleUpdate');
        const source = await nominate(f, { mirrors: true });
        await expectNoEffect(f.s, f.chatId);
        expect(f.targetReads).toHaveBeenCalled();
        if (boundary === 'source') expect(f.sourceReads).toHaveBeenCalled();
        if (boundary.startsWith('author')) expect(f.authorReads).toHaveBeenCalled();
        if (boundary.endsWith('http429')) expect(f.limitedHttpReads).toHaveLength(1);
        expect(
          await f.s.prisma.requiredSubscriptionCandidate.count({ where: { chatId: f.chatId } }),
        ).toBe(1);
        const receipts = await f.s.prisma.webhookEvent.findMany({
          where: { id: { in: source.ids } },
        });
        expect(receipts.filter((receipt) => receipt.status === 'PROCESSED')).toHaveLength(1);
        expect(receipts.filter((receipt) => receipt.status === 'DUPLICATE')).toHaveLength(2);
        const following = await f.s.ingest({
          chatId: f.chatId,
          messageId: `following-candidate-${randomUUID()}`,
          text: 'Following receipt after a retained initial read',
          senderless: true,
        });
        await f.s.drain();
        expect(
          (await f.s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: following } })).status,
        ).toBe('PROCESSED');
        expect(handler).toHaveBeenCalledTimes(2);
        await expectNoEffect(f.s, f.chatId);
        const { worker } = await f.restart();
        await f.s.deleteQueue.pause();
        expect(await worker.sweep()).toBe(1);
        const completed = await read(f.s, source.row);
        expect(completed.status).toBe('DONE');
        expect(completed.deadlineAt).toEqual(source.row.deadlineAt);
        expect(completed.frozenPlan).toMatchObject({
          candidateId: source.row.id,
          violationCount24h: 1,
          sanction: { eventId: `${source.row.id}:decision` },
        });
        expect(await f.s.prisma.violation.count({ where: { chatId: f.chatId } })).toBe(1);
        expect(
          await f.s.prisma.moderationViolationMessageClaim.count({
            where: { chatId: f.chatId, messageActionKey: { not: null } },
          }),
        ).toBe(1);
        expect(
          f.s.effects.filter((effect) => effect.method === 'post' && effect.path === '/messages'),
        ).toHaveLength(1);
        expect(f.s.effects.filter((effect) => effect.method === 'delete')).toHaveLength(0);
        const intent = await f.s.prisma.moderationDeleteIntent.findUniqueOrThrow({
          where: { chatId_messageId: { chatId: f.chatId, messageId: source.messageId } },
          include: { reasons: true },
        });
        expect(intent.status).toBe('PENDING');
        expect(intent.reasons).toEqual([
          expect.objectContaining({ reasonKey: 'REQUIRED_SUBSCRIPTION:message-delete' }),
        ]);
        expect(await worker.attempt(source.row.id)).toBe(false);
        await f.s.deleteQueue.resume();
        await f.s.drain();
        expect(f.s.effects.map((effect) => `${effect.method}:${effect.path}`)).toEqual([
          'post:/messages',
          'delete:/messages',
        ]);
        expect(
          (await f.s.prisma.moderationDeleteIntent.findUniqueOrThrow({ where: { id: intent.id } }))
            .status,
        ).toBe('SUCCEEDED');
        expect(handler).toHaveBeenCalledTimes(2);
      },
    );

    it.each(
      (['membership', 'author', 'source'] as const).flatMap((boundary) =>
        (['policy', 'membership', 'source'] as const).map((revocation) => ({
          boundary,
          revocation,
        })),
      ),
    )(
      'rechecks current $revocation after initial $boundary refusal before any claim or external effect',
      async ({ revocation, boundary }) => {
        const f = await fixture({}, boundary);
        const source = await nominate(f);
        const { worker } = await f.restart(revocation === 'membership' ? 'present' : 'missing');
        if (revocation === 'policy')
          await f.s.prisma.chatSettings.update({
            where: { chatId: f.chatId },
            data: { requiredSubscriptionEnabled: false },
          });
        if (revocation === 'source') {
          const message = f.s.messages.get(source.messageId)!;
          f.s.messages.set(source.messageId, {
            ...message,
            sender: { user_id: 'another-fixture-user', is_bot: false },
          });
        }
        expect(await worker.attempt(source.row.id)).toBe(true);
        expect((await read(f.s, source.row)).status).toBe('NO_ACTION');
        expect((await read(f.s, source.row)).deadlineAt).toEqual(source.row.deadlineAt);
        await expectNoEffect(f.s, f.chatId);
      },
    );

    it.each(['membership', 'author', 'source'] as const)(
      'honors an actual SQL source hold after initial %s no-effect registration',
      async (boundary) => {
        const f = await fixture({}, boundary);
        const source = await nominate(f);
        const { worker } = await f.restart();
        const certificateId = randomUUID();
        const digest = 'a'.repeat(64);
        // FLAG: This disposable fixture installs the immutable SQL authority directly.
        // Collector/certificate validation is covered by its native source-abandonment suite.
        await f.s.prisma.webhookSourceAbandonmentCertificate.create({
          data: {
            id: certificateId,
            sourceSha: 'a'.repeat(40),
            imageId: `sha256:${digest}`,
            attestation: { fixture: 'required-subscription-candidate-hold' },
            attestationDigest: digest,
            previewSha256: digest,
            sourceClosureSha256: digest,
            descendantsSha256: digest,
            abandonBefore: new Date(Date.now() - 1000),
            expectedSourceCount: 1,
            expectedChildCount: 0,
          },
        });
        await f.s.prisma.webhookSourceAbandonment.create({
          data: {
            id: randomUUID(),
            certificateId,
            semanticKey: `candidate-hold:${randomUUID()}`,
            ownerWebhookEventId: randomUUID(),
            claimId: randomUUID(),
            chatId: f.chatId,
            messageId: source.messageId,
            subjectUserId: 'fixture-user',
            sourceAt: new Date(source.at),
            rawPayloadDigest: digest,
            normalizedPayloadDigest: digest,
            ownerSnapshot: {},
            claimSnapshot: {},
          },
        });
        expect(await f.s.legacyHolds.isMessageHeld(f.chatId, source.messageId)).toBe(true);
        expect(await worker.attempt(source.row.id)).toBe(true);
        expect((await read(f.s, source.row)).status).toBe('NO_ACTION');
        await expectNoEffect(f.s, f.chatId);
        // FLAG: Immutable proof rows survive until the disposable stores are removed.
      },
    );

    it.each(['membership', 'author', 'source'] as const)(
      'preserves the original deadline across restart after initial %s refusal and expires without effects',
      async (boundary) => {
        const f = await fixture({}, boundary);
        const source = await nominate(f, { at: Date.now() - 297_000 });
        const { worker, store } = await f.restart();
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(1, source.row.deadlineAt.getTime() - Date.now() + 20)),
        );
        expect(await store.register((await store.read(source.row.id))!.source)).toMatchObject({
          created: false,
        });
        expect(await worker.sweep()).toBe(1);
        expect((await read(f.s, source.row)).status).toBe('EXPIRED');
        expect((await read(f.s, source.row)).deadlineAt).toEqual(source.row.deadlineAt);
        await expectNoEffect(f.s, f.chatId);
      },
    );

    it.each(['store-missing', 'commit-failed', 'lease-lost'] as const)(
      'keeps initial registration failure visible when %s instead of completing the handler',
      async (failure) => {
        const f = await fixture({}, 'source');
        const messageId = `candidate-registration-${randomUUID()}`;
        const storageError = new Error('Disposable candidate registration failure');
        const store = f.services().store;
        if (failure === 'store-missing')
          Object.assign(f.s.moderation, { requiredSubscriptionCandidateStore: undefined });
        if (failure === 'commit-failed')
          jest.spyOn(store, 'register').mockRejectedValue(storageError);
        if (failure === 'lease-lost') {
          const register = store.register.bind(store);
          const locks = jest.spyOn(f.s.counters, 'acquireLock');
          jest.spyOn(store, 'register').mockImplementation(async (source) => {
            const result = await register(source);
            const key = locks.mock.calls.find(([key]) => key.includes(messageId))?.[0];
            if (!key) throw new Error('Disposable exact notice lease was not acquired');
            // FLAG: Remove only this disposable source's real Redis lease after SQL commit.
            // The candidate survives, but the old webhook owner cannot report completion.
            expect(await f.s.redis.del(key)).toBe(1);
            return result;
          });
        }
        const id = await f.s.ingest({
          chatId: f.chatId,
          messageId,
          text: 'No effect before registration',
        });
        const expectedFailure =
          failure === 'store-missing'
            ? 'candidate store unavailable'
            : failure === 'commit-failed'
              ? storageError.message
              : 'lease was lost';
        await expect(f.s.drain()).rejects.toThrow(expectedFailure);
        expect(f.s.failures).toHaveLength(1);
        expect(f.s.failures[0]!.message).toContain(expectedFailure);
        expect(
          (await f.s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).status,
        ).not.toBe('PROCESSED');
        expect(
          await f.s.prisma.requiredSubscriptionCandidate.count({ where: { chatId: f.chatId } }),
        ).toBe(failure === 'lease-lost' ? 1 : 0);
        await expectNoEffect(f.s, f.chatId);
      },
    );

    it('recovers an exact remote BAN receipt when its confirmation checkpoint was lost without a second BAN or strike', async () => {
      const f = await fixture({
        requiredSubscriptionWarnEnabled: false,
        requiredSubscriptionBanEnabled: true,
      });
      const source = await nominate(f);
      await f.s.prisma.violation.create({
        data: {
          chatId: f.chatId,
          userId: 'fixture-user',
          ruleCode: 'REQUIRED_SUBSCRIPTION',
          score: 1,
        },
      });
      const { worker, store } = await f.restart();
      await f.s.deleteQueue.pause();
      const originalJournal = store.journal.bind(store);
      const lostConfirmation = jest.fn(async () => {
        throw new Error('Disposable crash after remote BAN and before confirmation checkpoint');
      });
      jest.spyOn(store, 'journal').mockImplementation((...args) => ({
        ...originalJournal(...args),
        confirmBan: lostConfirmation,
      }));
      expect(await worker.attempt(source.row.id)).toBe(true);
      expect(lostConfirmation).toHaveBeenCalledTimes(1);
      const interrupted = await read(f.s, source.row);
      expect(interrupted.status).toBe('UNKNOWN');
      expect(interrupted.effects).toMatchObject({ phase: 'BAN_STARTED' });
      expect(
        await f.s.prisma.maxActionLedgerEntry.findUniqueOrThrow({
          where: {
            jobId: f.s.max.getExplicitActionJobId('BAN_MEMBER', `${source.row.id}:sanction-ban`),
          },
        }),
      ).toMatchObject({ status: 'SUCCEEDED', ambiguous: false });
      expect(
        f.s.effects.filter(
          (effect) => effect.method === 'delete' && effect.path.endsWith('/members'),
        ),
      ).toHaveLength(1);
      expect(f.s.effects.filter((effect) => effect.path === '/messages')).toHaveLength(0);
      const resumed = await f.restart();
      await due(f.s, source.row.id);
      expect(await resumed.worker.sweep()).toBe(1);
      const completed = await read(f.s, source.row);
      expect(completed.status).toBe('DONE');
      expect(completed.frozenPlan).toEqual(interrupted.frozenPlan);
      expect(await f.s.prisma.violation.count({ where: { chatId: f.chatId } })).toBe(2);
      expect(
        await f.s.prisma.moderationViolationMessageClaim.count({
          where: { chatId: f.chatId, messageActionKey: { not: null } },
        }),
      ).toBe(1);
      expect(
        await f.s.prisma.moderationEvent.count({
          where: { id: `${source.row.id}:decision`, action: 'BAN' },
        }),
      ).toBe(1);
      expect(
        f.s.effects.filter(
          (effect) => effect.method === 'delete' && effect.path.endsWith('/members'),
        ),
      ).toHaveLength(1);
      expect(
        f.s.effects.filter((effect) => effect.method === 'post' && effect.path === '/messages'),
      ).toHaveLength(1);
      await f.s.deleteQueue.resume();
      await f.s.drain();
      expect(
        f.s.effects.filter((effect) => effect.method === 'delete' && effect.path === '/messages'),
      ).toHaveLength(1);
    });

    it.each(['membership', 'source'] as const)(
      'transfers a second media source after initial %s refusal through exact notice coverage without another strike',
      async (boundary) => {
        const f = await fixture({}, boundary);
        const at = Date.now();
        const leader = await nominate(f, { at, media: true });
        const follower = await nominate(f, { at: at + 1, media: true });
        await expectNoEffect(f.s, f.chatId);
        const { worker } = await f.restart();
        await f.s.deleteQueue.pause();
        expect(await worker.attempt(leader.row.id)).toBe(true);
        expect(await worker.attempt(follower.row.id)).toBe(true);
        expect((await read(f.s, leader.row)).status).toBe('DONE');
        expect(await read(f.s, follower.row)).toMatchObject({
          status: 'DONE',
          frozenPlan: null,
          claimId: null,
        });
        expect(await f.s.prisma.violation.count({ where: { chatId: f.chatId } })).toBe(1);
        expect(
          await f.s.prisma.moderationViolationMessageClaim.count({
            where: { chatId: f.chatId, messageActionKey: { not: null } },
          }),
        ).toBe(1);
        expect(await f.s.prisma.moderationDeleteIntent.count({ where: { chatId: f.chatId } })).toBe(
          2,
        );
        expect(
          f.s.effects.filter((effect) => effect.method === 'post' && effect.path === '/messages'),
        ).toHaveLength(1);
        await f.s.deleteQueue.resume();
        await f.s.drain();
        expect(
          f.s.effects.filter((effect) => effect.method === 'delete' && effect.path === '/messages'),
        ).toHaveLength(2);
      },
    );

    it('settles a follower DELETE committed before a crash after its own deadline using only saved receipts', async () => {
      const f = await fixture();
      const at = Date.now() - 294_000;
      const leader = await nominate(f, { at, media: true });
      const follower = await nominate(f, { at: at + 1, media: true });
      const { worker, store } = await f.restart();
      await f.s.deleteQueue.pause();
      expect(await worker.attempt(leader.row.id)).toBe(true);
      const recordReceipt = store.recordReceipt.bind(store);
      const checkpoint = jest.spyOn(store, 'recordReceipt').mockImplementation(async (...args) => {
        if (args[2] === 'delete') throw new Error('Disposable crash after follower DELETE insert');
        return recordReceipt(...args);
      });
      expect(await worker.attempt(follower.row.id)).toBe(true);
      expect(await read(f.s, follower.row)).toMatchObject({
        status: 'WAITING_CHECK',
        frozenPlan: null,
        claimId: null,
        effects: { notice: { kind: 'media_coverage' } },
      });
      expect(await f.s.prisma.moderationDeleteIntent.count({ where: { chatId: f.chatId } })).toBe(
        2,
      );
      checkpoint.mockRestore();
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(1, follower.row.deadlineAt.getTime() - Date.now() + 20)),
      );
      const resumed = await f.restart();
      await due(f.s, follower.row.id);
      const requestsBefore = f.s.requests.length;
      const effectsBefore = [...f.s.effects];
      expect(await resumed.worker.attempt(follower.row.id)).toBe(true);
      expect((await read(f.s, follower.row)).status).toBe('DONE');
      expect((await read(f.s, follower.row)).deadlineAt).toEqual(follower.row.deadlineAt);
      expect(f.s.requests).toHaveLength(requestsBefore);
      expect(f.s.effects).toEqual(effectsBefore);
      expect(await f.s.prisma.violation.count({ where: { chatId: f.chatId } })).toBe(1);
    });

    it.each(['RETRYABLE', 'SUCCEEDED'] as const)(
      'settles the saved DELETE transfer after a crash before completion when downstream status advances to %s',
      async (downstreamStatus) => {
        const f = await fixture();
        const source = await nominate(
          f,
          downstreamStatus === 'SUCCEEDED' ? { at: Date.now() - 294_000 } : {},
        );
        const { worker, store } = await f.restart();
        await f.s.deleteQueue.pause();
        const finish = store.finish.bind(store);
        let crashed = false;
        const checkpoint = jest.spyOn(store, 'finish').mockImplementation(async (...args) => {
          if (args[2] === 'DONE' && !crashed) {
            crashed = true;
            throw new Error('Disposable crash after persisted DELETE receipt before completion');
          }
          return finish(...args);
        });
        expect(await worker.attempt(source.row.id)).toBe(true);
        expect(crashed).toBe(true);
        const interrupted = await read(f.s, source.row);
        expect(interrupted).toMatchObject({
          status: 'WAITING_CHECK',
          effects: { delete: { status: 'PENDING' } },
        });
        const savedReceipt = (interrupted.effects as Prisma.JsonObject).delete;
        const intent = await f.s.prisma.moderationDeleteIntent.findUniqueOrThrow({
          where: { chatId_messageId: { chatId: f.chatId, messageId: source.messageId } },
        });
        checkpoint.mockRestore();
        if (downstreamStatus === 'RETRYABLE') {
          const mute = await f.s.prisma.moderationEvent.create({
            data: {
              chatId: f.chatId,
              userId: 'fixture-user',
              eventType: 'MEMBER_ACTION',
              ruleCode: 'MANUAL_MUTE',
              action: 'MUTE',
              operator: 'ADMIN',
              score: 1,
              metadata: { mutePermanent: true },
            },
          });
          await f.s.intents.ensureIntent(
            {
              chatId: f.chatId,
              messageId: source.messageId,
              subjectUserId: 'fixture-user',
              sourceMessageAt: new Date(source.at),
              retryUntilAt: source.row.deadlineAt,
              originBotId: f.s.bots[0]!.id,
              routingPolicy: 'delete_capable',
              entityType: 'CHAT',
              messageAuthorKind: 'user',
              reasonKey: 'MUTE_ACTIVE_DELETE',
              ruleCode: 'MUTE_ACTIVE_DELETE',
              event: {
                userId: 'fixture-user',
                eventType: 'MESSAGE',
                metadata: { muteEventId: mute.id },
              },
            },
            { enqueue: false },
          );
          // FLAG: Only this disposable chat's shared admission is exhausted. The real
          // merged intent worker must persist RETRYABLE before any MAX HTTP request.
          const budget = maxMuteApiBudgetKeys(f.chatId, 'fixture-user');
          await f.s.redis.hset(budget.chat, {
            tokens: '0',
            lastRefillAtMs: String(Date.now()),
          });
          const requestsBeforeBudget = f.s.requests.length;
          expect(await f.s.intents.attemptIntent(intent.id)).toMatchObject({
            confirmed: false,
            status: 'RETRYABLE',
          });
          expect(f.s.requests).toHaveLength(requestsBeforeBudget);
        } else {
          expect(await f.s.intents.attemptIntent(intent.id)).toMatchObject({
            confirmed: true,
            status: 'SUCCEEDED',
          });
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(1, source.row.deadlineAt.getTime() - Date.now() + 20)),
          );
        }
        expect(
          await f.s.prisma.moderationDeleteIntent.findUniqueOrThrow({ where: { id: intent.id } }),
        ).toMatchObject({ status: downstreamStatus });
        const resumed = await f.restart();
        await due(f.s, source.row.id);
        const requestsBefore = f.s.requests.length;
        const effectsBefore = [...f.s.effects];
        const send = jest.spyOn(f.s.max, 'sendMessage');
        expect(await resumed.worker.attempt(source.row.id)).toBe(true);
        const completed = await read(f.s, source.row);
        expect(completed.status).toBe('DONE');
        expect((completed.effects as Prisma.JsonObject).delete).toEqual(savedReceipt);
        expect(completed.deadlineAt).toEqual(source.row.deadlineAt);
        expect(completed.frozenPlan).toEqual(interrupted.frozenPlan);
        expect(f.s.requests).toHaveLength(requestsBefore);
        expect(f.s.effects).toEqual(effectsBefore);
        expect(send).not.toHaveBeenCalled();
        expect(await f.s.prisma.violation.count({ where: { chatId: f.chatId } })).toBe(1);
        expect(
          await f.s.prisma.moderationViolationMessageClaim.count({
            where: { chatId: f.chatId, messageActionKey: { not: null } },
          }),
        ).toBe(1);
        expect(await f.s.prisma.moderationDeleteIntent.count({ where: { chatId: f.chatId } })).toBe(
          1,
        );
      },
    );

    it.each(['dispatched', 'enqueue'] as const)(
      'keeps an ambiguous exact %s SEND unknown across restart without repeating the handoff or creating DELETE',
      async (ambiguity) => {
        const f = await fixture();
        const source = await nominate(f);
        const { worker, store } = await f.restart();
        if (ambiguity === 'dispatched') {
          f.s.ambiguousNextSend();
          expect(await worker.attempt(source.row.id)).toBe(true);
          expect((await read(f.s, source.row)).status).toBe('UNKNOWN');
        } else {
          const originalJournal = store.journal.bind(store);
          jest.spyOn(store, 'journal').mockImplementation((...args) => {
            const journal = originalJournal(...args);
            return {
              ...journal,
              settle: async () => {
                await journal.settle();
                throw new Error('Disposable crash after SQL settlement before notice handoff');
              },
            };
          });
          expect(await worker.attempt(source.row.id)).toBe(true);
          expect(await read(f.s, source.row)).toMatchObject({
            status: 'WAITING_CHECK',
            effects: { phase: 'SETTLED' },
          });
          const plan = (await store.read(source.row.id))!.frozenPlan!;
          // FLAG: The real enqueue-uncertainty recorder creates a fenced exact SEND
          // with no enqueue timestamp or dispatch evidence. Recovery must not hand it off again.
          const jobId = buildMaxActionIdempotencyKey('explicit', [
            'SEND_MESSAGE',
            plan.sanction.noticeKey,
          ]);
          await f.s.ledger.recordEnqueueAmbiguousIfAbsent(
            {
              actionType: 'SEND_MESSAGE',
              chatId: f.chatId,
              userId: 'fixture-user',
              text: plan.notice.renderedText,
              options: plan.notice.messageOptions,
              attempt: 1,
              idempotencyKey: jobId,
              createdAt: new Date().toISOString(),
              ledgerContext: { requiredSubscriptionNotice: plan.notice.executionProof },
            },
            new Error('Disposable queue ownership unknown'),
          );
          expect(
            await f.s.prisma.maxActionLedgerEntry.findUniqueOrThrow({ where: { jobId } }),
          ).toMatchObject({
            status: 'AMBIGUOUS',
            ambiguous: true,
            enqueuedAt: null,
            dispatchStartedAt: null,
          });
        }
        const effectsBefore = [...f.s.effects];
        expect(
          effectsBefore.filter((effect) => effect.method === 'post' && effect.path === '/messages'),
        ).toHaveLength(ambiguity === 'dispatched' ? 1 : 0);
        expect(await f.s.prisma.moderationDeleteIntent.count({ where: { chatId: f.chatId } })).toBe(
          0,
        );
        const send = jest.spyOn(f.s.max, 'sendMessage');
        const resumed = await f.restart();
        await due(f.s, source.row.id);
        expect(await resumed.worker.sweep()).toBe(1);
        expect((await read(f.s, source.row)).status).toBe('UNKNOWN');
        expect(send).not.toHaveBeenCalled();
        expect(f.s.effects).toEqual(effectsBefore);
        expect(await f.s.prisma.violation.count({ where: { chatId: f.chatId } })).toBe(1);
        expect(await f.s.prisma.moderationDeleteIntent.count({ where: { chatId: f.chatId } })).toBe(
          0,
        );
      },
    );

    it('honors a manual release after the settled SQL sanction before admitting a new notice', async () => {
      const f = await fixture({
        requiredSubscriptionWarnEnabled: false,
        requiredSubscriptionMuteEnabled: true,
      });
      const source = await nominate(f);
      await f.s.prisma.violation.create({
        data: {
          chatId: f.chatId,
          userId: 'fixture-user',
          ruleCode: 'REQUIRED_SUBSCRIPTION',
          score: 1,
        },
      });
      const { worker, store } = await f.restart();
      const originalJournal = store.journal.bind(store);
      jest.spyOn(store, 'journal').mockImplementation((...args) => {
        const journal = originalJournal(...args);
        return {
          ...journal,
          settle: async () => {
            await journal.settle();
            throw new Error('Disposable crash after SQL sanction settlement');
          },
        };
      });
      expect(await worker.attempt(source.row.id)).toBe(true);
      const interrupted = await read(f.s, source.row);
      expect(interrupted).toMatchObject({ status: 'WAITING_CHECK', effects: { phase: 'SETTLED' } });
      expect(
        await f.s.prisma.moderationEvent.findUniqueOrThrow({
          where: { id: `${source.row.id}:decision` },
        }),
      ).toMatchObject({ action: 'MUTE' });
      expect(f.s.effects).toEqual([]);
      await f.s.prisma.moderationEvent.create({
        data: {
          chatId: f.chatId,
          userId: 'fixture-user',
          ruleCode: 'MANUAL_UNMUTE',
          action: 'NONE',
          operator: 'ADMIN',
          eventType: 'SYSTEM',
          score: 0,
          createdAt: new Date(),
        },
      });
      const resumed = await f.restart();
      await due(f.s, source.row.id);
      expect(await resumed.worker.sweep()).toBe(1);
      expect((await read(f.s, source.row)).status).toBe('NO_ACTION');
      expect((await read(f.s, source.row)).frozenPlan).toEqual(interrupted.frozenPlan);
      expect(await f.s.prisma.violation.count({ where: { chatId: f.chatId } })).toBe(2);
      expect(await f.s.prisma.moderationDeleteIntent.count({ where: { chatId: f.chatId } })).toBe(
        0,
      );
      expect(f.s.effects).toEqual([]);
    });
  },
);
