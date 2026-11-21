import { ChatBotMembershipStatus } from '../prisma/prisma-client';
import {
  buildNightModeRouteVerificationJobId,
  NIGHT_MODE_ROUTE_VERIFICATION_JOB_NAME,
  NIGHT_MODE_ROUTE_VERIFICATION_KIND,
  type NightModeRouteVerification,
} from './night-mode-transition.queue';
import { NightModeRouteVerificationService } from './night-mode-route-verification.service';
import { NightModeTransitionSchedulerService } from './night-mode-transition-scheduler.service';

const CHAT_ID = 'chat-1';
const SESSION_KEY = 'v1:Europe/Moscow:23:00:08:00:2026-05-30';
const MESSAGE_ID = 'close-message-1';
const BOT_ID = 'bot-1';
const SENT_AT = new Date('2026-05-30T20:00:01.000Z');
const CLAIMED_UNTIL = new Date('2026-05-31T02:00:00.000Z');
const STABLE_AT = new Date('2026-05-30T20:05:01.000Z');
const EXPECTED_LEDGER_JOB_ID = `night-mode:close:${CHAT_ID}:session:${SESSION_KEY}`;

function createVerification(
  overrides: Partial<NightModeRouteVerification> = {},
): NightModeRouteVerification {
  return {
    kind: NIGHT_MODE_ROUTE_VERIFICATION_KIND,
    version: 1,
    sessionKey: SESSION_KEY,
    messageId: MESSAGE_ID,
    botId: BOT_ID,
    sentAt: SENT_AT.toISOString(),
    attemptCount: 0,
    presentCount: 0,
    absentCount: 0,
    ...overrides,
  };
}

function createFixture(
  params: {
    presence?: 'present' | 'absent';
    lookupError?: unknown;
    ledgerProof?: unknown;
    routeUpdateCount?: number;
    halfOpenRoute?: boolean;
    stickyRoute?: boolean;
    cleanup?: { id: string };
    queue?: { add: jest.Mock; getJob?: jest.Mock };
  } = {},
) {
  const getExactMessagePresence = params.lookupError
    ? jest.fn().mockRejectedValue(params.lookupError)
    : jest.fn().mockResolvedValue(params.presence ?? 'present');
  const updateMany = jest.fn().mockResolvedValue({ count: params.routeUpdateCount ?? 1 });
  const findFirst = jest
    .fn()
    .mockResolvedValue(
      params.halfOpenRoute === false
        ? null
        : { botId: BOT_ID, sendRouteQuarantinedUntil: CLAIMED_UNTIL },
    );
  const executeRaw = jest.fn().mockResolvedValue(1);
  const updateBroadcasts = jest.fn().mockResolvedValue({ count: 1 });
  const updateDeliveries = jest.fn().mockResolvedValue({ count: 1 });
  const findCleanup = jest.fn().mockResolvedValue(params.cleanup ?? null);
  const transactionClient = {
    moderationDeleteIntent: { findFirst: findCleanup },
    $executeRaw: executeRaw,
    chatBotMembership: { updateMany },
    managedBroadcast: { updateMany: updateBroadcasts },
    managedBroadcastDelivery: { updateMany: updateDeliveries },
  };
  const transaction = jest.fn(
    async (operation: (tx: typeof transactionClient) => Promise<unknown>) =>
      operation(transactionClient),
  );
  const prisma = {
    chatBotMembership: { findFirst, updateMany },
    managedBroadcast: { updateMany: updateBroadcasts },
    managedBroadcastDelivery: { updateMany: updateDeliveries },
    $transaction: transaction,
  };
  const getExactCompletedNightModeCloseNoticeDispatch = jest.fn().mockResolvedValue(
    params.ledgerProof === undefined
      ? {
          jobId: EXPECTED_LEDGER_JOB_ID,
          remoteMessageId: MESSAGE_ID,
          dispatchBotId: BOT_ID,
          completedAt: SENT_AT,
          routeHalfOpenProbe: true,
          stickyRouteHalfOpenProbe: params.stickyRoute === true,
        }
      : params.ledgerProof,
  );
  const queue = params.queue
    ? {
        ...params.queue,
        getJob: params.queue.getJob ?? jest.fn().mockResolvedValue(null),
      }
    : undefined;
  const scheduler = new NightModeTransitionSchedulerService(prisma as never, queue as never);
  const service = new NightModeRouteVerificationService(
    { getExactMessagePresence } as never,
    prisma as never,
    { getExactCompletedNightModeCloseNoticeDispatch } as never,
    scheduler,
  );
  return {
    service,
    getExactMessagePresence,
    findCleanup,
    getExactCompletedNightModeCloseNoticeDispatch,
    findFirst,
    executeRaw,
    transaction,
    updateBroadcasts,
    updateDeliveries,
    updateMany,
  };
}

describe('NightModeRouteVerificationService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('schedules one deterministic delayed verification job with bounded retries', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:00:02.000Z'));
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const { service, findFirst } = createFixture({ queue });
    const expectedVerification = createVerification();

    await expect(
      service.schedule({
        chatId: ` ${CHAT_ID} `,
        sessionKey: ` ${SESSION_KEY} `,
        messageId: ` ${MESSAGE_ID} `,
        botId: ` ${BOT_ID} `,
        sentAt: SENT_AT,
      }),
    ).resolves.toBeUndefined();

    expect(service.isSchedulingAvailable()).toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        chatId: CHAT_ID,
        botId: BOT_ID,
        status: ChatBotMembershipStatus.ACTIVE,
        sendRouteFailureCount: { gte: 1 },
        sendRouteLastFailureCode: 'PUBLICATION_MESSAGE_DISAPPEARED',
        sendRouteLastFailureAt: { lt: SENT_AT },
        sendRouteQuarantinedUntil: {
          gte: SENT_AT,
          lte: new Date(SENT_AT.getTime() + 6 * 60 * 60_000),
        },
      },
      select: { botId: true },
    });
    expect(queue.add).toHaveBeenCalledWith(
      NIGHT_MODE_ROUTE_VERIFICATION_JOB_NAME,
      {
        chatId: CHAT_ID,
        transition: 'close',
        scheduledFor: SENT_AT.toISOString(),
        sessionKey: SESSION_KEY,
        routeVerification: expectedVerification,
        createdAt: '2026-05-30T20:00:02.000Z',
      },
      {
        jobId: buildNightModeRouteVerificationJobId(CHAT_ID, expectedVerification),
        delay: 15_000,
        attempts: 3,
        backoff: { type: 'fixed', delay: 15_000 },
        removeOnComplete: true,
        removeOnFail: 1_000,
      },
    );
  });

  it('schedules exact ledger recovery after the prior half-open claim has expired', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T03:00:02.000Z'));
    const queue = { add: jest.fn().mockResolvedValue(undefined) };
    const fixture = createFixture({ queue });

    await expect(
      fixture.service.schedule({
        chatId: CHAT_ID,
        sessionKey: SESSION_KEY,
        messageId: MESSAGE_ID,
        botId: BOT_ID,
        sentAt: SENT_AT,
      }),
    ).resolves.toBeUndefined();

    expect(fixture.findFirst).toHaveBeenCalledWith({
      where: {
        chatId: CHAT_ID,
        botId: BOT_ID,
        status: ChatBotMembershipStatus.ACTIVE,
        sendRouteFailureCount: { gte: 1 },
        sendRouteLastFailureCode: 'PUBLICATION_MESSAGE_DISAPPEARED',
        sendRouteLastFailureAt: { lt: SENT_AT },
        sendRouteQuarantinedUntil: {
          gte: SENT_AT,
          lte: new Date(SENT_AT.getTime() + 6 * 60 * 60_000),
        },
      },
      select: { botId: true },
    });
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('does not enqueue verification for a close sent on a normal route', async () => {
    const queue = { add: jest.fn() };
    const fixture = createFixture({ queue, halfOpenRoute: false });

    await expect(
      fixture.service.schedule({
        chatId: CHAT_ID,
        sessionKey: SESSION_KEY,
        messageId: MESSAGE_ID,
        botId: BOT_ID,
        sentAt: SENT_AT,
      }),
    ).resolves.toBeUndefined();

    expect(fixture.findFirst).toHaveBeenCalledTimes(1);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('keeps an existing deterministic verification job without adding a duplicate', async () => {
    const verification = createVerification({ attemptCount: 1, presentCount: 1 });
    const queue = {
      add: jest.fn(),
      getJob: jest.fn().mockResolvedValue({
        name: NIGHT_MODE_ROUTE_VERIFICATION_JOB_NAME,
        getState: jest.fn().mockResolvedValue('delayed'),
        data: {
          chatId: CHAT_ID,
          transition: 'close',
          scheduledFor: SENT_AT.toISOString(),
          sessionKey: SESSION_KEY,
          routeVerification: verification,
        },
      }),
    };
    const fixture = createFixture({ queue });

    await expect(
      fixture.service.schedule({
        chatId: CHAT_ID,
        sessionKey: SESSION_KEY,
        messageId: MESSAGE_ID,
        botId: BOT_ID,
        sentAt: SENT_AT,
      }),
    ).resolves.toBeUndefined();

    expect(queue.getJob).toHaveBeenCalledWith(
      buildNightModeRouteVerificationJobId(CHAT_ID, verification),
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('fails closed when the deterministic verification id contains another envelope', async () => {
    const queue = {
      add: jest.fn(),
      getJob: jest.fn().mockResolvedValue({
        name: NIGHT_MODE_ROUTE_VERIFICATION_JOB_NAME,
        getState: jest.fn(),
        data: {
          chatId: CHAT_ID,
          transition: 'close',
          scheduledFor: SENT_AT.toISOString(),
          sessionKey: SESSION_KEY,
          routeVerification: createVerification({ messageId: 'another-message' }),
        },
      }),
    };
    const fixture = createFixture({ queue });

    await expect(
      fixture.service.schedule({
        chatId: CHAT_ID,
        sessionKey: SESSION_KEY,
        messageId: MESSAGE_ID,
        botId: BOT_ID,
        sentAt: SENT_AT,
      }),
    ).rejects.toThrow('job identity is unsafe');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rematerializes an exact failed verification job while the claim remains pending', async () => {
    const verification = createVerification({ attemptCount: 6 });
    const remove = jest.fn().mockResolvedValue(undefined);
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue({
        name: NIGHT_MODE_ROUTE_VERIFICATION_JOB_NAME,
        getState: jest.fn().mockResolvedValue('failed'),
        remove,
        data: {
          chatId: CHAT_ID,
          transition: 'close',
          scheduledFor: SENT_AT.toISOString(),
          sessionKey: SESSION_KEY,
          routeVerification: verification,
        },
      }),
    };
    const fixture = createFixture({ queue });

    await expect(
      fixture.service.schedule({
        chatId: CHAT_ID,
        sessionKey: SESSION_KEY,
        messageId: MESSAGE_ID,
        botId: BOT_ID,
        sentAt: SENT_AT,
      }),
    ).resolves.toBeUndefined();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.invocationCallOrder[0]).toBeLessThan(queue.add.mock.invocationCallOrder[0]!);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('rejects scheduling without an exact proof or queue', async () => {
    const unavailable = createFixture().service;
    expect(unavailable.isSchedulingAvailable()).toBe(false);
    await expect(
      unavailable.schedule({
        chatId: CHAT_ID,
        sessionKey: SESSION_KEY,
        messageId: MESSAGE_ID,
        botId: BOT_ID,
        sentAt: SENT_AT,
      }),
    ).rejects.toThrow('queue is unavailable');

    const queue = { add: jest.fn() };
    await expect(
      createFixture({ queue }).service.schedule({
        chatId: CHAT_ID,
        sessionKey: SESSION_KEY,
        messageId: '',
        botId: BOT_ID,
        sentAt: SENT_AT,
      }),
    ).rejects.toThrow('Exact night mode route verification proof is required');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it.each([
    [
      'job id',
      {
        jobId: 'night-mode:close:chat-1:session:another-session',
        remoteMessageId: MESSAGE_ID,
        dispatchBotId: BOT_ID,
        completedAt: SENT_AT,
        routeHalfOpenProbe: true,
      },
    ],
    [
      'message id',
      {
        jobId: EXPECTED_LEDGER_JOB_ID,
        remoteMessageId: 'another-message',
        dispatchBotId: BOT_ID,
        completedAt: SENT_AT,
        routeHalfOpenProbe: true,
      },
    ],
    [
      'dispatch bot',
      {
        jobId: EXPECTED_LEDGER_JOB_ID,
        remoteMessageId: MESSAGE_ID,
        dispatchBotId: 'another-bot',
        completedAt: SENT_AT,
        routeHalfOpenProbe: true,
      },
    ],
    [
      'completion epoch',
      {
        jobId: EXPECTED_LEDGER_JOB_ID,
        remoteMessageId: MESSAGE_ID,
        dispatchBotId: BOT_ID,
        completedAt: new Date(SENT_AT.getTime() + 1),
        routeHalfOpenProbe: true,
      },
    ],
    [
      'half-open marker',
      {
        jobId: EXPECTED_LEDGER_JOB_ID,
        remoteMessageId: MESSAGE_ID,
        dispatchBotId: BOT_ID,
        completedAt: SENT_AT,
        routeHalfOpenProbe: false,
      },
    ],
  ])(
    'fails closed before MAX lookup when exact ledger %s does not match',
    async (_label, proof) => {
      const fixture = createFixture({ ledgerProof: proof });

      await expect(
        fixture.service.process(CHAT_ID, createVerification(), STABLE_AT),
      ).resolves.toEqual({
        kind: 'terminal',
        reason: 'invalid_proof',
      });

      expect(fixture.getExactCompletedNightModeCloseNoticeDispatch).toHaveBeenCalledWith({
        chatId: CHAT_ID,
        sessionKey: SESSION_KEY,
        messageId: MESSAGE_ID,
        dispatchBotId: BOT_ID,
      });
      expect(fixture.getExactMessagePresence).not.toHaveBeenCalled();
      expect(fixture.updateMany).not.toHaveBeenCalled();
    },
  );

  it('delays the first present observation until at least the five-minute stability boundary', async () => {
    const now = new Date('2026-05-30T20:00:16.000Z');
    const fixture = createFixture({ presence: 'present' });

    await expect(fixture.service.process(CHAT_ID, createVerification(), now)).resolves.toEqual({
      kind: 'retry',
      retryAtMs: STABLE_AT.getTime(),
      verification: createVerification({ attemptCount: 1, presentCount: 1 }),
    });

    expect(fixture.getExactMessagePresence).toHaveBeenCalledWith(CHAT_ID, MESSAGE_ID, {
      botId: BOT_ID,
      bypassCache: true,
      trafficClass: 'background',
      actionHealthLane: 'background',
      sourceTag: 'night_mode_transition',
      timeoutMs: 5_000,
      ignoreFailureMetricStatuses: [404],
    });
    expect(fixture.updateMany).not.toHaveBeenCalled();
  });

  it('clears route health only after a second stable present observation', async () => {
    const fixture = createFixture({ presence: 'present' });

    await expect(
      fixture.service.process(
        CHAT_ID,
        createVerification({ attemptCount: 1, presentCount: 1 }),
        STABLE_AT,
      ),
    ).resolves.toEqual({ kind: 'complete', routeHealthChanged: true });

    expect(fixture.updateMany).toHaveBeenCalledWith({
      where: {
        chatId: CHAT_ID,
        botId: BOT_ID,
        status: ChatBotMembershipStatus.ACTIVE,
        sendRouteFailureCount: 1,
        sendRouteLastFailureCode: 'PUBLICATION_MESSAGE_DISAPPEARED',
        sendRouteQuarantinedUntil: CLAIMED_UNTIL,
        sendRouteLastFailureAt: { lt: SENT_AT },
        OR: [{ sendRouteLastSuccessAt: null }, { sendRouteLastSuccessAt: { lt: SENT_AT } }],
      },
      data: {
        sendRouteFailureCount: 0,
        sendRouteQuarantinedUntil: null,
        sendRouteLastFailureCode: null,
        sendRouteLastSuccessAt: SENT_AT,
      },
    });
    expect(fixture.executeRaw).toHaveBeenCalledTimes(1);
    expect(fixture.transaction).toHaveBeenCalledTimes(1);
    expect(fixture.updateBroadcasts).toHaveBeenCalledTimes(1);
    expect(fixture.updateDeliveries).toHaveBeenCalledTimes(1);
    expect(fixture.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.updateMany.mock.invocationCallOrder[0]!,
    );
    expect(fixture.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.updateBroadcasts.mock.invocationCallOrder[0]!,
    );
    expect(fixture.updateBroadcasts.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.updateDeliveries.mock.invocationCallOrder[0]!,
    );
  });

  it('clears an exact sticky future-night claim after stable presence', async () => {
    const fixture = createFixture({ presence: 'present', stickyRoute: true });

    await expect(
      fixture.service.process(
        CHAT_ID,
        createVerification({ attemptCount: 1, presentCount: 1 }),
        STABLE_AT,
      ),
    ).resolves.toEqual({ kind: 'complete', routeHealthChanged: true });

    expect(fixture.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        chatId: CHAT_ID,
        botId: BOT_ID,
        sendRouteFailureCount: { gte: 1 },
        sendRouteQuarantinedUntil: {
          gte: SENT_AT,
          lte: new Date(SENT_AT.getTime() + 6 * 60 * 60_000),
        },
      }),
      select: { sendRouteQuarantinedUntil: true },
    });
    expect(fixture.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        chatId: CHAT_ID,
        botId: BOT_ID,
        sendRouteFailureCount: { gte: 1 },
        sendRouteQuarantinedUntil: CLAIMED_UNTIL,
        sendRouteLastFailureAt: { lt: SENT_AT },
      }),
      data: {
        sendRouteFailureCount: 0,
        sendRouteQuarantinedUntil: null,
        sendRouteLastFailureCode: null,
        sendRouteLastSuccessAt: SENT_AT,
      },
    });
  });

  it('retires a stale verifier without probing or clearing a route outside its exact claim', async () => {
    const fixture = createFixture({ presence: 'present', halfOpenRoute: false });

    await expect(
      fixture.service.process(
        CHAT_ID,
        createVerification({ attemptCount: 1, presentCount: 1 }),
        STABLE_AT,
      ),
    ).resolves.toEqual({ kind: 'complete', routeHealthChanged: false });

    expect(fixture.findFirst).toHaveBeenCalledWith({
      where: {
        chatId: CHAT_ID,
        botId: BOT_ID,
        status: ChatBotMembershipStatus.ACTIVE,
        sendRouteFailureCount: 1,
        sendRouteLastFailureCode: 'PUBLICATION_MESSAGE_DISAPPEARED',
        sendRouteLastFailureAt: { lt: SENT_AT },
        sendRouteQuarantinedUntil: {
          gte: SENT_AT,
          lte: new Date(SENT_AT.getTime() + 6 * 60 * 60_000),
        },
      },
      select: { sendRouteQuarantinedUntil: true },
    });
    expect(fixture.getExactMessagePresence).not.toHaveBeenCalled();
    expect(fixture.transaction).not.toHaveBeenCalled();
    expect(fixture.updateMany).not.toHaveBeenCalled();
  });

  it('reports a completed but unchanged route when a newer failure wins the health CAS', async () => {
    const fixture = createFixture({ presence: 'present', routeUpdateCount: 0 });

    await expect(
      fixture.service.process(
        CHAT_ID,
        createVerification({ attemptCount: 1, presentCount: 1 }),
        STABLE_AT,
      ),
    ).resolves.toEqual({ kind: 'complete', routeHealthChanged: false });

    expect(fixture.transaction).toHaveBeenCalledTimes(1);
    expect(fixture.executeRaw).toHaveBeenCalledTimes(1);
    expect(fixture.updateMany).toHaveBeenCalledTimes(1);
    expect(fixture.updateBroadcasts).not.toHaveBeenCalled();
    expect(fixture.updateDeliveries).not.toHaveBeenCalled();
  });

  it('ends after three stable explicit absences without clearing route health', async () => {
    const fixture = createFixture({ presence: 'absent' });

    await expect(
      fixture.service.process(
        CHAT_ID,
        createVerification({ attemptCount: 2, absentCount: 2 }),
        STABLE_AT,
      ),
    ).resolves.toEqual({ kind: 'terminal', reason: 'absent' });

    expect(fixture.getExactMessagePresence).toHaveBeenCalledTimes(1);
    expect(fixture.transaction).toHaveBeenCalledTimes(1);
    expect(fixture.executeRaw).toHaveBeenCalledTimes(1);
    expect(fixture.updateMany).toHaveBeenCalledWith({
      where: {
        chatId: CHAT_ID,
        botId: BOT_ID,
        status: ChatBotMembershipStatus.ACTIVE,
        sendRouteFailureCount: 1,
        sendRouteLastFailureCode: 'PUBLICATION_MESSAGE_DISAPPEARED',
        sendRouteQuarantinedUntil: CLAIMED_UNTIL,
        sendRouteLastFailureAt: { lt: SENT_AT },
        OR: [{ sendRouteLastSuccessAt: null }, { sendRouteLastSuccessAt: { lt: SENT_AT } }],
      },
      data: {
        sendRouteFailureCount: { increment: 1 },
        sendRouteQuarantinedUntil: new Date(STABLE_AT.getTime() + 6 * 60 * 60_000),
        sendRouteLastFailureAt: SENT_AT,
        sendRouteLastFailureCode: 'PUBLICATION_MESSAGE_DISAPPEARED',
      },
    });
  });

  it.each(['recorded cleanup', 'scheduled opening'] as const)(
    'leaves the route unchanged when probe absence follows %s',
    async (reason) => {
      const fixture = createFixture({
        presence: 'absent',
        ...(reason === 'recorded cleanup' ? { cleanup: { id: 'close-cleanup' } } : {}),
      });
      const now = reason === 'scheduled opening' ? new Date('2026-05-31T05:05:00Z') : STABLE_AT;
      await expect(
        fixture.service.process(
          CHAT_ID,
          createVerification({ attemptCount: 2, absentCount: 2 }),
          now,
        ),
      ).resolves.toEqual({ kind: 'complete', routeHealthChanged: false });
      expect(fixture.updateMany).not.toHaveBeenCalled();
      if (reason === 'recorded cleanup')
        expect(fixture.findCleanup).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              chatId: CHAT_ID,
              messageId: MESSAGE_ID,
              originBotId: BOT_ID,
            }),
          }),
        );
    },
  );

  it('keeps a future-night sticky route closed when the exact probe disappears', async () => {
    const fixture = createFixture({ presence: 'absent', stickyRoute: true });

    await expect(
      fixture.service.process(
        CHAT_ID,
        createVerification({ attemptCount: 2, absentCount: 2 }),
        STABLE_AT,
      ),
    ).resolves.toEqual({ kind: 'terminal', reason: 'absent' });

    expect(fixture.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        sendRouteFailureCount: { gte: 1 },
        sendRouteQuarantinedUntil: CLAIMED_UNTIL,
        sendRouteLastFailureAt: { lt: SENT_AT },
      }),
      data: {
        sendRouteFailureCount: { increment: 1 },
        sendRouteQuarantinedUntil: new Date(STABLE_AT.getTime() + 6 * 60 * 60_000),
        sendRouteLastFailureAt: SENT_AT,
        sendRouteLastFailureCode: 'PUBLICATION_MESSAGE_DISAPPEARED',
      },
    });
  });

  it('keeps an inconclusive final presence on a bounded two-hour cadence', async () => {
    const fixture = createFixture({ presence: 'present' });

    await expect(
      fixture.service.process(CHAT_ID, createVerification({ attemptCount: 5 }), STABLE_AT),
    ).resolves.toEqual({
      kind: 'retry',
      retryAtMs: STABLE_AT.getTime() + 2 * 60 * 60_000,
      verification: createVerification({ attemptCount: 6, presentCount: 1 }),
    });

    expect(fixture.getExactMessagePresence).toHaveBeenCalledTimes(1);
    expect(fixture.transaction).not.toHaveBeenCalled();
    expect(fixture.updateMany).not.toHaveBeenCalled();
  });

  it('keeps an exhausted lookup envelope saturated without mutating route health', async () => {
    const fixture = createFixture({ lookupError: new Error('MAX unavailable') });

    await expect(
      fixture.service.process(CHAT_ID, createVerification({ attemptCount: 6 }), STABLE_AT),
    ).resolves.toEqual({
      kind: 'retry',
      retryAtMs: STABLE_AT.getTime() + 2 * 60 * 60_000,
      verification: createVerification({ attemptCount: 6 }),
    });

    expect(fixture.getExactCompletedNightModeCloseNoticeDispatch).toHaveBeenCalledTimes(1);
    expect(fixture.getExactMessagePresence).toHaveBeenCalledTimes(1);
    expect(fixture.transaction).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a thrown 404',
      Object.assign(new Error('Message not found'), {
        response: { status: 404, data: { code: 'message.not.found' } },
      }),
    ],
    ['a transport error', new Error('MAX transport unavailable')],
  ])('retries and saturates %s without mutating route health', async (_label, lookupError) => {
    const fixture = createFixture({ lookupError });
    const firstNow = new Date('2026-05-30T20:00:16.000Z');

    await expect(fixture.service.process(CHAT_ID, createVerification(), firstNow)).resolves.toEqual(
      {
        kind: 'retry',
        retryAtMs: firstNow.getTime() + 30_000,
        verification: createVerification({ attemptCount: 1 }),
      },
    );
    await expect(
      fixture.service.process(CHAT_ID, createVerification({ attemptCount: 5 }), STABLE_AT),
    ).resolves.toEqual({
      kind: 'retry',
      retryAtMs: STABLE_AT.getTime() + 2 * 60 * 60_000,
      verification: createVerification({ attemptCount: 6 }),
    });

    expect(fixture.getExactMessagePresence).toHaveBeenCalledTimes(2);
    expect(fixture.transaction).not.toHaveBeenCalled();
    expect(fixture.updateMany).not.toHaveBeenCalled();
  });
});
