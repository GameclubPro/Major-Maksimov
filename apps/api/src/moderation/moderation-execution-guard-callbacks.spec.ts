import { SanctionAction } from '../prisma/prisma-client';
import {
  bindModerationExecutionPolicy,
  buildModerationNoticeDispatchOptions,
  createModerationNoticeGuard,
  createModerationSanctionCallbacks,
  createRequiredSubscriptionEvidence,
  createRequiredSubscriptionNoticeHandoff,
  createRequiredSubscriptionSanctionCallbacks,
  createRuleSanctionGuards,
  createCommercialNoticeDispatchOptions,
  createDuplicateSanctionNoticeDispatchOptions,
  createBotAccountKickOptions,
  createSpammerKickOptions,
  createRequiredSubscriptionAssertion,
  runRuleFollowUpWhileAuthorized,
} from './moderation-execution-guard-callbacks';
import { ModerationRuleSanctionRejectedError } from './moderation-rule-sanction-authority';
import { readModerationGuardFailure } from './moderation-guard-failure-diagnostic';

function fixture() {
  const assertAllowed = jest.fn(
    async (_proof: unknown, _options?: { beforeFinalAuthority?: () => Promise<void> }) => undefined,
  );
  let selectedBotId = 'origin-bot';
  const sourceAt = '2026-10-05T10:00:00.000Z';
  const rule = createRuleSanctionGuards(
    assertAllowed,
    {
      chatId: '-123',
      subjectUserId: 'user-1',
      messageId: 'message-1',
      reasonKey: 'length:violation-delete',
      ruleCode: 'MESSAGE_TOO_LONG_DELETE',
      sourceMessageAt: sourceAt,
    },
    'a'.repeat(64),
    () => 'delete-peer',
    () => selectedBotId,
  )!;
  return { assertAllowed, rule, sourceAt, selectBot: (botId: string) => (selectedBotId = botId) };
}

describe('moderation execution guard callbacks', () => {
  it('keeps an album quota decision anchored when a later photo receives its delete policy', () => {
    const anchor = Date.now() - 10_000;
    const violation = {
      ruleCode: 'MESSAGE_COUNT_LIMIT',
      metadata: {
        quotaPolicyVersion: 3,
        quotaPublicationId: 'album-1',
        quotaAnchorTimestampMs: anchor,
      },
    };
    bindModerationExecutionPolicy({} as never, violation, anchor + 9_000);
    expect(violation.metadata).toMatchObject({
      quotaPublicationId: 'album-1',
      messageLimitEventTimestampMs: anchor,
      messageLimitDeadlineAtMs: anchor + 300_000,
    });
    const other = { ruleCode: 'MESSAGE_RATE_LIMIT', metadata: { quotaAnchorTimestampMs: anchor } };
    bindModerationExecutionPolicy({} as never, other, anchor + 9_000);
    expect(other.metadata).toMatchObject({ messageLimitEventTimestampMs: anchor + 9_000 });
  });
  it('keeps the original duplicate sanction authority in immediate SEND and rejects unbound notices', async () => {
    const route = async () => undefined;
    const authority = jest.fn(async (_route?: () => Promise<void>) => undefined);
    const options = createDuplicateSanctionNoticeDispatchOptions(authority);
    expect(options.immediate).toBe(true);
    expect(options).toHaveProperty('immediateFailurePolicy', 'terminal');
    await options.beforeImmediateSendMutation!(route);
    expect(authority).toHaveBeenCalledWith(route);
    const failure = new Error('Source SQL unavailable');
    authority.mockRejectedValueOnce(failure);
    await expect(options.beforeImmediateSendMutation!(route)).rejects.toBe(failure);
    await expect(
      createDuplicateSanctionNoticeDispatchOptions(undefined).beforeImmediateSendMutation!(route),
    ).rejects.toMatchObject({ code: 'message_duplicate_sanction_notice_unbound' });
  });
  it('returns false for a proven revocation and keeps unknown failures retryable', async () => {
    const s = fixture();
    s.assertAllowed.mockRejectedValue(new ModerationRuleSanctionRejectedError());
    expect(await s.rule.authorizeSanction()).toBe(false);
    expect(s.rule.wasRejected()).toBe(true);
    const unknown = new Error('SQL connection lost');
    s.assertAllowed.mockRejectedValue(unknown);
    await expect(s.rule.authorizeSanction()).rejects.toBe(unknown);
  });

  it('ends a revoked follow-up before fallback event persistence and propagates unknown errors', async () => {
    const afterMutation = jest.fn();
    await expect(
      runRuleFollowUpWhileAuthorized(async () => {
        await Promise.reject(new ModerationRuleSanctionRejectedError());
        afterMutation();
      }),
    ).resolves.toBeUndefined();
    expect(afterMutation).not.toHaveBeenCalled();
    const forged = Object.assign(new Error('remote'), {
      code: 'moderation_rule_sanction_no_longer_authorized',
    });
    await expect(
      runRuleFollowUpWhileAuthorized(async () => {
        throw forged;
      }),
    ).rejects.toBe(forged);
  });
  it('uses the confirmed DELETE peer for preparation, notices and SQL WARN/MUTE', async () => {
    const s = fixture();
    await s.rule.assertBeforeFollowUp();
    expect(await s.rule.authorizeSanction()).toBe(true);
    s.selectBot('origin-demoted-after-delete');
    await createModerationNoticeGuard(undefined, s.rule.assertBeforeFollowUp)!();
    for (const action of [SanctionAction.WARN, SanctionAction.MUTE]) {
      const callbacks = createModerationSanctionCallbacks(undefined, s.rule, undefined, action);
      await callbacks.authorizeSanction!();
      await callbacks.noticeBeforeSend!();
      await callbacks.beforeSanctionMutation!();
    }
    expect(s.assertAllowed).toHaveBeenCalled();
    for (const [proof] of s.assertAllowed.mock.calls)
      expect(proof).toEqual(expect.objectContaining({ botId: 'delete-peer' }));
  });

  it('reads the final BAN executor lazily instead of retaining the ingress bot', async () => {
    const s = fixture();
    const callbacks = createModerationSanctionCallbacks(
      undefined,
      s.rule,
      undefined,
      SanctionAction.BAN,
    );
    await callbacks.authorizeSanction!();
    s.selectBot('new-ban-peer');
    await callbacks.beforeSanctionMutation!();
    expect(s.assertAllowed.mock.calls[0][0]).toEqual(
      expect.objectContaining({ botId: 'delete-peer' }),
    );
    expect(s.assertAllowed.mock.calls[1][0]).toEqual(
      expect.objectContaining({ botId: 'new-ban-peer' }),
    );
    expect(callbacks.deferGlobalSpammerTrackingUntilConfirmedBan).toBe(true);
  });

  it('carries exact source proof through queued dispatch while preserving the original deadline', () => {
    const s = fixture();
    s.selectBot('irrelevant-later-route');
    const options = buildModerationNoticeDispatchOptions(
      {
        userFacing: true,
        deleteBotMessagesEnabled: true,
        deleteBotMessagesDelayMinutes: 5,
        idempotencyKey: 'notice-identity',
        ledgerContext: s.rule.noticeLedgerContext,
      },
      'moderation.notice',
      [403, 404],
    )!;
    expect(options).toMatchObject({
      trafficClass: 'interactive',
      actionHealthLane: 'interactive',
      sourceTag: 'moderation.notice',
      ignoreFailureMetricStatuses: [403, 404],
      idempotencyKey: 'notice-identity',
      autoDeleteDelayMs: 300_000,
      ledgerContext: {
        moderationRuleNotice: {
          version: 1,
          chatId: '-123',
          messageId: 'message-1',
          userId: 'user-1',
          reasonKey: 'length:violation-delete',
          ruleCode: 'MESSAGE_TOO_LONG_DELETE',
          policySha256: 'a'.repeat(64),
          deadlineAtMs: Date.parse(s.sourceAt) + 300_000,
        },
      },
    });
    expect(options.immediate).toBeUndefined();
    expect(options.immediateFailurePolicy).toBeUndefined();
    expect(options.botId).toBeUndefined();
    expect(options.beforeImmediateSendMutation).toBeUndefined();
    expect(options.ledgerContext?.moderationNoticeEnvelope).toEqual({ version: 1 });
  });

  it('finishes the stop-words reads before the final ordinary rule authority', async () => {
    const s = fixture();
    const rejected = new Error('policy-changed');
    s.assertAllowed.mockRejectedValue(rejected);
    const stopWords = jest.fn(async () => undefined);
    const callbacks = createModerationSanctionCallbacks(
      undefined,
      s.rule,
      stopWords,
      SanctionAction.BAN,
    );
    await expect(callbacks.authorizeSanction!()).rejects.toBe(rejected);
    await expect(callbacks.beforeSanctionMutation!()).rejects.toBe(rejected);
    expect(stopWords).toHaveBeenCalledTimes(1);
    expect(stopWords.mock.invocationCallOrder[0]).toBeLessThan(
      s.assertAllowed.mock.invocationCallOrder[1]!,
    );
  });

  it('keeps commercial authorization after the stop-words mutation guard', async () => {
    const order: string[] = [];
    const commercial = async () => {
      order.push('commercial');
      return false;
    };
    const callbacks = createModerationSanctionCallbacks(
      commercial,
      undefined,
      async () => {
        order.push('stop-words');
      },
      SanctionAction.BAN,
    );
    await expect(callbacks.beforeSanctionMutation!()).rejects.toThrow(
      'Commercial sanction is no longer authorized',
    );
    expect(order).toEqual(['stop-words', 'commercial']);
  });

  it('carries the original commercial permit callback to immediate final SEND and selected member guards', async () => {
    const prepare = jest.fn(async () => true);
    const final = jest.fn(async (_route?: () => Promise<void>) => true);
    const route = jest.fn(async () => undefined);
    const options = createCommercialNoticeDispatchOptions(final)!;
    expect(options.immediate).toBe(true);
    await options.beforeImmediateSendMutation!(route);
    expect(final).toHaveBeenCalledWith(route);
    const callbacks = createModerationSanctionCallbacks(
      prepare,
      undefined,
      undefined,
      SanctionAction.BAN,
      final,
    );
    await callbacks.authorizeSanction!();
    await callbacks.beforeSanctionMutation!(route);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(final).toHaveBeenCalledTimes(2);
    expect(final).toHaveBeenLastCalledWith(route);
    expect(callbacks.noticeDispatchOptions?.immediate).toBe(true);
    const dispatch = buildModerationNoticeDispatchOptions(
      {
        ...options,
        deleteBotMessagesEnabled: false,
        deleteBotMessagesDelayMinutes: 5,
      },
      'moderation_notice',
      [],
    )!;
    expect(dispatch.beforeImmediateSendMutation).toBe(options.beforeImmediateSendMutation);
    expect(dispatch.immediateFailurePolicy).toBeUndefined();
  });

  it('passes the selected member route inside ordinary authority after preceding guards', async () => {
    const s = fixture();
    const order: string[] = [];
    const route = async () => {
      order.push('route');
    };
    s.assertAllowed.mockImplementation(async (_proof, options) => {
      order.push('external-author');
      await options?.beforeFinalAuthority?.();
      order.push('final-policy');
    });
    const callbacks = createModerationSanctionCallbacks(
      undefined,
      s.rule,
      async () => {
        order.push('stop-words');
      },
      SanctionAction.BAN,
    );
    s.selectBot('final-peer');
    await callbacks.beforeSanctionMutation!(route);
    expect(order).toEqual(['stop-words', 'external-author', 'route', 'final-policy']);
    expect(s.assertAllowed).toHaveBeenLastCalledWith(
      expect.objectContaining({ botId: 'final-peer' }),
      { beforeFinalAuthority: route },
    );
  });

  it('preserves the route callback for bot-account, spammer and subscription member guards', async () => {
    const route = async () => undefined;
    const authorize = jest.fn(async (_params: unknown) => ({ reasonKeys: ['owned'] }));
    const spammer = jest.fn(async (_params: unknown) => undefined);
    const guard = { authorize, assertSpammerMemberAllowed: spammer } as never;
    const identity = { chatId: '-123', userId: 'user-1', messageId: 'source-1' };
    await createBotAccountKickOptions(guard, () => 'selected', {
      ...identity,
      createdAt: '2026-10-05T10:00:00Z',
    })!.beforeImmediateMemberMutation!(route);
    expect(authorize).toHaveBeenLastCalledWith(
      expect.objectContaining({
        botId: 'selected',
        beforeFinalAuthority: route,
      }),
    );
    await createSpammerKickOptions(guard, () => 'selected', {
      ...identity,
      localBlock: false,
    })!.beforeImmediateMemberMutation!(route);
    expect(spammer).toHaveBeenLastCalledWith(
      expect.objectContaining({
        botId: 'selected',
        beforeFinalAuthority: route,
      }),
    );
    await createRequiredSubscriptionAssertion(guard, () => 'selected', {
      ...identity,
      reasonKey: 'REQUIRED_SUBSCRIPTION:message-delete',
      metadata: {},
    })(route);
    expect(authorize).toHaveBeenLastCalledWith(
      expect.objectContaining({
        botId: 'selected',
        beforeFinalAuthority: route,
      }),
    );
  });

  it('does not authorize required-subscription follow-up after its notice lease is lost', async () => {
    const source = jest.fn(async () => undefined);
    const leaseError = new Error('notice-lease-lost');
    const callbacks = createRequiredSubscriptionSanctionCallbacks(async () => {
      throw leaseError;
    }, source);
    await expect(callbacks.authorizeSanction()).rejects.toBe(leaseError);
    await expect(callbacks.noticeBeforeSend()).rejects.toBe(leaseError);
    await expect(callbacks.beforeSanctionMutation()).rejects.toBe(leaseError);
    expect(source).not.toHaveBeenCalled();
  });

  it.each([
    ['authorizeSanction', 'required_subscription_sanction_authorize'],
    ['beforeSanctionMutation', 'required_subscription_sanction_mutation'],
    ['noticeBeforeSend', 'required_subscription_sanction_notice'],
  ] as const)('retains the exact frozen source failure at %s', async (callback, boundary) => {
    const error = Object.freeze({ response: { status: 429 }, private: 'private-source' });
    const lease = jest.fn(async () => undefined);
    const source = jest.fn(async () => {
      throw error;
    });
    const callbacks = createRequiredSubscriptionSanctionCallbacks(lease, source);
    await expect(callbacks[callback]()).rejects.toBe(error);
    expect(lease).toHaveBeenCalledTimes(1);
    expect(source).toHaveBeenCalledTimes(1);
    expect(readModerationGuardFailure(error)).toEqual({ guardBoundary: boundary });
    expect(Object.keys(error)).toEqual(['response', 'private']);
  });

  it.each(['beforeSanctionMutation', 'noticeBeforeSend'] as const)(
    'forwards the final route check through %s in the original guard order',
    async (callback) => {
      const calls: string[] = [];
      const route = async () => {
        calls.push('route');
      };
      const callbacks = createRequiredSubscriptionSanctionCallbacks(
        async () => {
          calls.push('lease');
        },
        async (beforeFinalAuthority) => {
          calls.push('source');
          await beforeFinalAuthority?.();
        },
      );
      await callbacks[callback](route);
      expect(calls).toEqual(['lease', 'source', 'route']);
    },
  );

  it('binds subscription deletion and author evidence to the same immutable source window', () => {
    const createdAt = '2026-10-05T10:00:00.000Z';
    const text = 'sample long content '.repeat(30);
    const evidence = createRequiredSubscriptionEvidence(
      { chatId: '-123', messageId: 'source-1', userId: 'user-1', settings: {}, createdAt, text },
      ['channel-1', 'channel-2'],
      {
        missingChannelIds: ['channel-1'],
        unresolvedChannelIds: ['channel-2'],
        terminalChannelIds: [],
      },
      null,
      ['Required channel'],
    );
    expect(evidence.deleteIntent).toMatchObject({
      subjectUserId: 'user-1',
      sourceMessageAt: createdAt,
      retryUntilAt: new Date(Date.parse(createdAt) + 300_000),
      event: { metadata: expect.objectContaining({ missingChannelTitles: ['Required channel'] }) },
    });
    expect(evidence.metadata.requiredSubscriptionDeadlineAtMs).toBe(
      Date.parse(createdAt) + 300_000,
    );
    expect(evidence.executionProof).toEqual({
      version: 1,
      chatId: '-123',
      userId: 'user-1',
      messageId: 'source-1',
      reasonKey: evidence.deleteIntent.reasonKey,
      policySha256: evidence.metadata.requiredSubscriptionPolicySha256,
      sourceAtMs: Date.parse(createdAt),
      deadlineAtMs: Date.parse(createdAt) + 300_000,
    });
    expect(evidence.deleteIntent.event?.maskedExcerpt).not.toBe(text);
    expect(evidence.deleteIntent.event?.maskedExcerpt?.length).toBeLessThanOrEqual(220);
  });

  it('keeps the persisted album anchor proof when another source resumes its notice', async () => {
    const proof = {
      version: 1 as const,
      chatId: '-123',
      userId: 'user-1',
      messageId: 'original-anchor',
      reasonKey: 'REQUIRED_SUBSCRIPTION:message-delete',
      policySha256: 'a'.repeat(64),
      sourceAtMs: Date.parse('2026-10-05T10:00:00.000Z'),
      deadlineAtMs: Date.parse('2026-10-05T10:05:00.000Z'),
    };
    const assertNoticeAllowed = jest.fn(async (_proof: unknown, _bot?: string) => undefined);
    const lease = jest.fn(async () => undefined);
    const sent = jest.fn(async (notice) => {
      await notice.beforeSend();
      return true;
    });
    const handoff = createRequiredSubscriptionNoticeHandoff(
      { assertNoticeAllowed },
      () => 'current-notice-peer',
      { chatId: '-123', userId: 'user-1' },
      sent,
    );
    await handoff(
      {
        version: 1,
        action: SanctionAction.NONE,
        renderedText: 'Subscribe',
        messageOptions: { textFormat: 'html' },
        mediaFieldKey: null,
        deleteBotMessagesEnabled: false,
        deleteBotMessagesDelayMinutes: 5,
        executionProof: proof,
      },
      'original-notice-key',
      lease,
    );
    expect(assertNoticeAllowed).toHaveBeenCalledWith(proof, 'current-notice-peer', undefined);
    expect(sent).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'original-notice-key',
        ledgerContext: { requiredSubscriptionNotice: proof },
      }),
    );
    expect(lease).toHaveBeenCalledTimes(1);
  });

  it('does not hand off a proofless legacy notice or grant delete coverage', async () => {
    const assertNoticeAllowed = jest.fn(async () => undefined);
    const sent = jest.fn(async () => true);
    const handoff = createRequiredSubscriptionNoticeHandoff(
      { assertNoticeAllowed },
      () => 'current-notice-peer',
      { chatId: '-123', userId: 'user-1' },
      sent,
    );
    await expect(
      handoff(
        {
          version: 1,
          action: SanctionAction.NONE,
          renderedText: 'Subscribe',
          messageOptions: { textFormat: 'html' },
          mediaFieldKey: null,
          deleteBotMessagesEnabled: false,
          deleteBotMessagesDelayMinutes: 5,
        },
        'legacy-notice-key',
        async () => undefined,
      ),
    ).rejects.toThrow('Required subscription notice source proof unavailable');
    expect(sent).not.toHaveBeenCalled();
    expect(assertNoticeAllowed).not.toHaveBeenCalled();
  });
});
