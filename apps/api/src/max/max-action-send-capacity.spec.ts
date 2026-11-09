import { DelayedError, type Job, UnrecoverableError } from 'bullmq';
import type { MaxActionLedgerService } from './max-action-ledger.service';
import { MaxActionDispatchService } from './max-action-dispatch.service';
import { markMaxPreDispatchGuardRejected } from './max-action-pre-dispatch-guard';
import { MaxApiInternalRateLimitError } from './max-api-internal-rate-limit.error';
import { MaxActionInteractiveProcessor } from './max-action.processor';
import type { MaxActionJob, MaxClientService } from './max-client.service';
import { MaxModerationApiBudgetError } from './max-moderation-api-budget';
import { markMaxMessageSendAttempted } from './max-mutation-outcome.util';
import { MESSAGE_DUPLICATE_MEDIA_VERSION } from '../moderation/message-duplicate/message-duplicate-state';
import type { MessageDuplicateNoticeProof } from '../moderation/message-duplicate/message-duplicate-notice-proof';
import {
  certifyMaxSendCapacityDeferral,
  consumeMaxSendCapacityDeferral,
  markMaxApiCapacityRefusal,
  MaxSendCapacityDeadlineError,
  MaxSendCapacityDeferralError,
  readMaxSendCapacityDeadline,
  readMaxSendCapacityDeferral,
  runWithMaxSendCapacityAttempt,
} from './max-send-capacity-deferral';

function action(now = Date.now()): MaxActionJob {
  return {
    actionType: 'SEND_MESSAGE',
    botId: 'bot-1',
    chatId: 'chat-1',
    text: 'Synthetic notice',
    sourceTag: 'moderation_notice',
    idempotencyKey: 'notice-1',
    createdAt: new Date(now - 1_000).toISOString(),
    attempt: 5,
    ledgerContext: {
      requiredSubscriptionNotice: {
        version: 1,
        chatId: 'chat-1',
        messageId: 'message-1',
        userId: 'user-1',
        reasonKey: 'REQUIRED_SUBSCRIPTION:message-delete',
        policySha256: 'a'.repeat(64),
        sourceAtMs: now - 1_000,
        deadlineAtMs: now - 1_000 + 300_000,
      },
    },
  };
}

async function certified(job: MaxActionJob, retryAfterMs = 60_000) {
  const error = new MaxApiInternalRateLimitError(
    'Synthetic local capacity refusal',
    retryAfterMs,
    'bot',
  );
  await runWithMaxSendCapacityAttempt(job, job.botId!, async () => {
    markMaxApiCapacityRefusal(error, { botId: job.botId!, chatId: job.chatId, operation: 'send' });
  });
  markMaxPreDispatchGuardRejected(error, 'max_send_pre_dispatch_guard_rejected');
  certifyMaxSendCapacityDeferral(error, job, job.botId!);
  return error;
}

async function issued(job: MaxActionJob, retryAfterMs = 60_000) {
  const error = readMaxSendCapacityDeferral(await certified(job, retryAfterMs), job);
  if (!(error instanceof MaxSendCapacityDeferralError))
    throw new Error('Synthetic notice deferral unavailable');
  return error;
}

describe('Bounded notice SEND capacity deferral', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-11-09T03:00:00Z')));
  afterEach(() => jest.useRealTimers());

  it('retains a genuine Retry-After lower bound and the original proof deadline', async () => {
    const job = action();
    expect(readMaxSendCapacityDeferral(await certified(job), job)).toMatchObject({
      jobId: job.idempotencyKey,
      retryAtMs: Date.now() + 60_000,
      deadlineAtMs: Date.now() + 299_000,
    });
  });

  it('refuses missing, malformed, differently bound and generic SEND proof', async () => {
    const job = action();
    for (const changed of [
      { ...job, ledgerContext: undefined },
      { ...job, ledgerContext: { requiredSubscriptionNotice: {} } },
      { ...job, chatId: 'another-chat' },
      { ...job, botId: 'another-bot' },
      { ...job, idempotencyKey: 'another-job' },
      { ...job, sourceTag: 'managed_handshake' },
    ])
      expect(readMaxSendCapacityDeferral(await certified(job), changed)).toBeNull();
  });

  it('consumes both origin and certification and refuses a borrowed genuine quota error', async () => {
    const job = action();
    const error = new MaxApiInternalRateLimitError('real old reservation', 1_000, 'bot');
    await runWithMaxSendCapacityAttempt(job, job.botId!, async () => {
      markMaxApiCapacityRefusal(error, {
        botId: job.botId!,
        chatId: job.chatId,
        operation: 'send',
      });
    });
    markMaxPreDispatchGuardRejected(error, 'max_send_pre_dispatch_guard_rejected');
    const nextInvocation = { ...job };
    certifyMaxSendCapacityDeferral(error, nextInvocation, job.botId!);
    certifyMaxSendCapacityDeferral(error, job, job.botId!);
    expect(readMaxSendCapacityDeferral(error, job)).toBeNull();
    const valid = await certified(job);
    expect(readMaxSendCapacityDeferral(valid, job)).toBeInstanceOf(MaxSendCapacityDeferralError);
    expect(readMaxSendCapacityDeferral(valid, job)).toBeNull();
    const unconsumed = await certified(job);
    certifyMaxSendCapacityDeferral(unconsumed, { ...job }, job.botId!);
    expect(readMaxSendCapacityDeferral(unconsumed, job)).toBeNull();
  });

  it('does not certify nested GET reservations within the SEND scope', async () => {
    const job = action();
    const error = new MaxApiInternalRateLimitError('nested GET capacity', 1_000, 'bot');
    await runWithMaxSendCapacityAttempt(job, job.botId!, async () => {
      markMaxApiCapacityRefusal(error, { botId: job.botId!, chatId: job.chatId });
    });
    markMaxPreDispatchGuardRejected(error, 'max_send_pre_dispatch_guard_rejected');
    certifyMaxSendCapacityDeferral(error, job, job.botId!);
    expect(readMaxSendCapacityDeferral(error, job)).toBeNull();
  });

  it('does not infer no-effect authority from copied diagnostics, budgets or attempted SEND', () => {
    const job = action();
    const candidates: unknown[] = [
      Object.assign(new Error('copied shape'), {
        code: 'MAX_API_INTERNAL_RATE_LIMIT',
        preDispatch: true,
      }),
      new MaxApiInternalRateLimitError('unmarked capacity', 1_000, 'bot'),
      new MaxModerationApiBudgetError('attempt_budget', 1_000),
      Object.assign(new MaxApiInternalRateLimitError('HTTP refusal', 1_000, 'bot'), {
        response: { status: 429 },
      }),
      markMaxMessageSendAttempted(new MaxApiInternalRateLimitError('attempted SEND', 1_000, 'bot')),
      new MaxApiInternalRateLimitError('Ambiguous MAX SEND', 1_000, 'bot'),
    ];
    for (const error of candidates) {
      markMaxPreDispatchGuardRejected(error, 'max_send_pre_dispatch_guard_rejected');
      certifyMaxSendCapacityDeferral(error, job, job.botId!);
      expect(readMaxSendCapacityDeferral(error, job)).toBeNull();
    }
  });

  it('expires rather than shortening Retry-After or extending an elapsed proof', async () => {
    const job = action();
    expect(readMaxSendCapacityDeferral(await certified(job, 300_000), job)).toBeInstanceOf(
      MaxSendCapacityDeadlineError,
    );
    const error = await certified(job);
    jest.advanceTimersByTime(300_000);
    expect(readMaxSendCapacityDeferral(error, job)).toBeInstanceOf(UnrecoverableError);
  });

  it('uses the earliest valid composed notice proof and refuses malformed neighbors', () => {
    const job = action();
    const ruleProof = {
      version: 1,
      chatId: job.chatId,
      messageId: 'message-1',
      userId: 'user-1',
      reasonKey: 'VOICE_BLOCKED_DELETE',
      ruleCode: 'VOICE',
      policySha256: 'b'.repeat(64),
      deadlineAtMs: Date.now() + 30_000,
    };
    expect(
      readMaxSendCapacityDeadline({
        ...job,
        ledgerContext: { ...job.ledgerContext, moderationRuleNotice: ruleProof },
      }),
    ).toBe(ruleProof.deadlineAtMs);
    expect(
      readMaxSendCapacityDeadline({
        ...job,
        ledgerContext: {
          ...job.ledgerContext,
          moderationRuleNotice: { ...ruleProof, extra: true },
        },
      }),
    ).toBeNull();
  });

  it('retains a valid duplicate notice deadline within its original ten-minute authority', () => {
    const job = action();
    const eventTimestampMs = Date.now() - 1_000;
    const digest = 'a'.repeat(64);
    const proof: MessageDuplicateNoticeProof = {
      version: 3,
      chatId: job.chatId,
      intentId: 'intent-1',
      reasonKey: `MESSAGE_DUPLICATE:v1:${eventTimestampMs}`,
      deadlineAtMs: eventTimestampMs + 600_000,
      noticePolicySha256: digest,
      stage: { kind: 'hit', repeatCount: 1, threshold: null },
      binding: {
        version: 3,
        enforcementScope: 'full',
        lifecycleRevision: digest,
        policyRevision: 1,
        authorization: { eventTimestampMs, deadlineAtMs: eventTimestampMs + 600_000 },
        original: {
          member: digest,
          author: digest,
          messageId: 'original-1',
          senderId: 'user-1',
          publishedAtMs: eventTimestampMs - 1_000,
          observedAtMs: eventTimestampMs - 1_000,
          expiresAtMs: eventTimestampMs + 3_600_000,
          sourceDigest: digest,
          contentDigest: digest,
          mediaHashes: [],
          epoch: 0,
          revision: digest,
          originalId: digest,
        },
        senderId: 'user-1',
        messageId: 'source-1',
        eventTimestampMs,
        controlRevision: 1,
        settingsDigest: digest,
        sourceDigest: digest,
        contentDigest: digest,
        fingerprint: digest,
        compareMode: 'TEXT',
        mediaHashes: [],
        mediaVersion: MESSAGE_DUPLICATE_MEDIA_VERSION,
        hasPhotos: false,
        photoControlRevision: null,
        windowSeconds: 3_600,
        requiredCount: 2,
      },
    };
    expect(readMaxSendCapacityDeadline({ ...job, ledgerContext: { duplicateNotice: proof } })).toBe(
      proof.deadlineAtMs,
    );
    proof.binding.authorization!.deadlineAtMs += 1;
    proof.deadlineAtMs += 1;
    expect(
      readMaxSendCapacityDeadline({ ...job, ledgerContext: { duplicateNotice: proof } }),
    ).toBeNull();
  });

  it('keeps a certified refusal nonterminal on the final ordinary attempt only for opted-in workers', async () => {
    const job = action();
    const error = await certified(job, 1_000);
    const max = { executeActionJob: jest.fn().mockRejectedValue(error) } satisfies Pick<
      MaxClientService,
      'executeActionJob'
    >;
    const ledger = {
      getCompletedSendDispatchResult: jest.fn().mockResolvedValue(null),
      assertCanExecute: jest.fn().mockResolvedValue(undefined),
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockResolvedValue(undefined),
    } satisfies Pick<
      MaxActionLedgerService,
      'getCompletedSendDispatchResult' | 'assertCanExecute' | 'recordStarted' | 'recordFailed'
    >;
    const dispatch = new MaxActionDispatchService(max as never, undefined, ledger as never);
    const options = { finalAttempt: true, deferSendCapacity: true };
    await expect(dispatch.execute(job, options)).rejects.toBeInstanceOf(
      MaxSendCapacityDeferralError,
    );
    expect(ledger.recordFailed).toHaveBeenLastCalledWith(job, error, { exhausted: false });
    await expect(dispatch.execute(job, { finalAttempt: true })).rejects.toBe(error);
    expect(ledger.recordFailed).toHaveBeenLastCalledWith(job, error, { exhausted: true });
  });

  it('moves the same locked job to delayed without changing payload, timestamp or attempts', async () => {
    const previousRole = process.env.APP_ROLE;
    process.env.APP_ROLE = 'action';
    try {
      const data = action();
      const error = await issued(data);
      const dispatch = { execute: jest.fn().mockRejectedValue(error) } satisfies Pick<
        MaxActionDispatchService,
        'execute'
      >;
      const processor = new MaxActionInteractiveProcessor(dispatch as never);
      const job = {
        data,
        timestamp: Date.now() - 1_000,
        attemptsMade: 4,
        opts: { attempts: 5 },
        moveToDelayed: jest.fn().mockResolvedValue(undefined),
      } as unknown as Job<MaxActionJob>;
      const snapshot = JSON.stringify({
        data: job.data,
        timestamp: job.timestamp,
        attemptsMade: job.attemptsMade,
      });
      const process = processor.process.bind(processor) as (
        job: Job<MaxActionJob>,
        token?: string,
      ) => Promise<unknown>;
      await expect(process(job, 'exact-lock-token')).rejects.toBeInstanceOf(DelayedError);
      expect(job.moveToDelayed).toHaveBeenCalledWith(error.retryAtMs, 'exact-lock-token');
      expect(
        JSON.stringify({
          data: job.data,
          timestamp: job.timestamp,
          attemptsMade: job.attemptsMade,
        }),
      ).toBe(snapshot);
      expect(dispatch.execute).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ deferSendCapacity: true }),
      );
    } finally {
      if (previousRole === undefined) delete process.env.APP_ROLE;
      else process.env.APP_ROLE = previousRole;
    }
  });

  it.each(['missing', 'wrong'] as const)(
    'does not acknowledge a %s lock token as a successful deferral',
    async (kind) => {
      const previousRole = process.env.APP_ROLE;
      process.env.APP_ROLE = 'action';
      try {
        const data = action();
        const deferral = await issued(data, 1_000);
        const dispatch = { execute: jest.fn().mockRejectedValue(deferral) } satisfies Pick<
          MaxActionDispatchService,
          'execute'
        >;
        const processor = new MaxActionInteractiveProcessor(dispatch as never);
        const lockError = new Error('Synthetic wrong lock token');
        const job = {
          data,
          attemptsMade: 0,
          opts: { attempts: 5 },
          moveToDelayed: jest.fn().mockRejectedValue(lockError),
        } as unknown as Job<MaxActionJob>;
        await expect(
          processor.process(job, kind === 'wrong' ? 'wrong-token' : undefined),
        ).rejects.toBe(kind === 'wrong' ? lockError : deferral);
        if (kind === 'missing') {
          expect(job.moveToDelayed).not.toHaveBeenCalled();
          expect(dispatch.execute.mock.calls[0]![1]).not.toHaveProperty('deferSendCapacity');
        } else {
          expect(job.moveToDelayed).toHaveBeenCalledWith(deferral.retryAtMs, 'wrong-token');
        }
      } finally {
        if (previousRole === undefined) delete process.env.APP_ROLE;
        else process.env.APP_ROLE = previousRole;
      }
    },
  );

  it('does not delay an unissued typed error from a feature callback', async () => {
    const previousRole = process.env.APP_ROLE;
    process.env.APP_ROLE = 'action';
    try {
      const data = action();
      const forged = new MaxSendCapacityDeferralError(
        data.idempotencyKey,
        Date.now() + 365 * 24 * 60 * 60_000,
        Date.now() + 366 * 24 * 60 * 60_000,
      );
      const dispatch = {
        execute: jest.fn().mockRejectedValue(forged),
      } satisfies Pick<MaxActionDispatchService, 'execute'>;
      const processor = new MaxActionInteractiveProcessor(dispatch as never);
      const job = {
        data,
        attemptsMade: 0,
        opts: { attempts: 5 },
        moveToDelayed: jest.fn().mockResolvedValue(undefined),
      } as unknown as Job<MaxActionJob>;
      await expect(processor.process(job, 'valid-lock-token')).rejects.toBe(forged);
      expect(job.moveToDelayed).not.toHaveBeenCalled();
    } finally {
      if (previousRole === undefined) delete process.env.APP_ROLE;
      else process.env.APP_ROLE = previousRole;
    }
  });

  it('consumes issued scheduling authority once and rejects changed bounds or notice proof', async () => {
    const data = action();
    const valid = await issued(data);
    expect(consumeMaxSendCapacityDeferral(valid, data)).toBe(true);
    expect(consumeMaxSendCapacityDeferral(valid, data)).toBe(false);
    const changed = await issued(data);
    Object.assign(changed, { retryAtMs: Date.now() + 365 * 24 * 60 * 60_000 });
    expect(consumeMaxSendCapacityDeferral(changed, data)).toBe(false);
    const stale = await issued(data);
    expect(consumeMaxSendCapacityDeferral(stale, { ...data, ledgerContext: undefined })).toBe(
      false,
    );
  });

  it('propagates failed retry-state persistence before acknowledging any deferral', async () => {
    const job = action();
    const error = await certified(job, 1_000);
    const persistenceError = new Error('Synthetic SQL retry-state failure');
    const max = { executeActionJob: jest.fn().mockRejectedValue(error) } satisfies Pick<
      MaxClientService,
      'executeActionJob'
    >;
    const ledger = {
      getCompletedSendDispatchResult: jest.fn().mockResolvedValue(null),
      assertCanExecute: jest.fn().mockResolvedValue(undefined),
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockRejectedValue(persistenceError),
    } satisfies Pick<
      MaxActionLedgerService,
      'getCompletedSendDispatchResult' | 'assertCanExecute' | 'recordStarted' | 'recordFailed'
    >;
    const dispatch = new MaxActionDispatchService(max as never, undefined, ledger as never);
    await expect(
      dispatch.execute(job, { finalAttempt: true, deferSendCapacity: true }),
    ).rejects.toBe(persistenceError);
  });

  it('retains the original due transfer when final-attempt SQL persistence crosses source expiry', async () => {
    const previousRole = process.env.APP_ROLE;
    process.env.APP_ROLE = 'action';
    try {
      const data = action();
      const capacity = await certified(data, 1_000);
      const originalDeadline = readMaxSendCapacityDeadline(data)!;
      const originalRetryAt = Date.now() + 1_000;
      const expired = new UnrecoverableError('Original notice deadline elapsed');
      const effect = jest.fn();
      const max = {
        executeActionJob: jest
          .fn()
          .mockRejectedValueOnce(capacity)
          .mockImplementation(async () => {
            if (Date.now() >= originalDeadline) throw expired;
            effect();
          }),
      } satisfies Pick<MaxClientService, 'executeActionJob'>;
      const ledger = {
        getCompletedSendDispatchResult: jest.fn().mockResolvedValue(null),
        assertCanExecute: jest.fn().mockResolvedValue(undefined),
        recordStarted: jest.fn().mockResolvedValue(undefined),
        recordFailed: jest.fn().mockImplementationOnce(async () => {
          jest.setSystemTime(originalDeadline + 1);
        }),
      } satisfies Pick<
        MaxActionLedgerService,
        'getCompletedSendDispatchResult' | 'assertCanExecute' | 'recordStarted' | 'recordFailed'
      >;
      const dispatch = new MaxActionDispatchService(max as never, undefined, ledger as never);
      const processor = new MaxActionInteractiveProcessor(dispatch);
      const job = {
        data,
        timestamp: Date.now() - 1_000,
        attemptsMade: 4,
        opts: { attempts: 5 },
        moveToDelayed: jest.fn().mockResolvedValue(undefined),
      } as unknown as Job<MaxActionJob>;
      await expect(processor.process(job, 'owned-lock')).rejects.toBeInstanceOf(DelayedError);
      expect(job.moveToDelayed).toHaveBeenCalledWith(originalRetryAt, 'owned-lock');
      expect(originalRetryAt).toBeLessThan(Date.now());
      expect(job.attemptsMade).toBe(4);
      expect(ledger.recordFailed).toHaveBeenNthCalledWith(1, expect.anything(), capacity, {
        exhausted: false,
      });
      await expect(processor.process(job, 'reentry-lock')).rejects.toBe(expired);
      expect(ledger.recordFailed).toHaveBeenLastCalledWith(expect.anything(), expired, {
        exhausted: true,
      });
      expect(effect).not.toHaveBeenCalled();
      expect(readMaxSendCapacityDeadline(job.data)).toBe(originalDeadline);
    } finally {
      if (previousRole === undefined) delete process.env.APP_ROLE;
      else process.env.APP_ROLE = previousRole;
    }
  });
});
