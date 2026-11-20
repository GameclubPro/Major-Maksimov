import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import axios, { AxiosError, AxiosHeaders, type AxiosAdapter } from 'axios';
import { AsyncLocalStorage } from 'node:async_hooks';
import { MaxApiInternalRateLimitError, MaxClientService } from '../max/max-client.service';
import { MaxBotContextService } from '../max/max-bot-context.service';
import { MaxModerationApiBudgetError } from '../max/max-moderation-api-budget';
import type { ActionHealthService } from '../system/action-health.service';
import { isMaxExactMessageLookupMissingIdError } from '../max/max-exact-message-lookup.error';
import { fingerprintModerationSettings } from './message-limits-delete-guard.service';
import {
  RequiredSubscriptionExecutionGuardService,
  RequiredSubscriptionExecutionRejectedError,
  RequiredSubscriptionInitialSourceUnavailableError,
  RequiredSubscriptionDeleteSourceUnavailableError,
  RequiredSubscriptionAuthorAccessUnavailableError,
  readRequiredSubscriptionInitialSourceReadWait,
  type RequiredSubscriptionInitialSourceReadWaitBinding,
} from './required-subscription-execution-guard.service';
import {
  markMaxMemberMutationAttempted,
  markMaxMemberMutationConfirmed,
} from '../max/max-member-error.util';
import { markMaxMessageSendAttempted } from '../max/max-mutation-outcome.util';

async function exactLookupFailure(
  data: Record<string, unknown>,
  http429?: 'list' | 'direct' | 'author',
  botId = 'fixture-bot',
): Promise<unknown> {
  const responses = [{ messages: [] }, data];
  const request = jest.fn<ReturnType<AxiosAdapter>, Parameters<AxiosAdapter>>(async (config) => {
    const path = new URL(config.url!).pathname;
    const rateLimited =
      (http429 === 'list' && path === '/messages') ||
      (http429 === 'direct' && path === '/messages/m1') ||
      (http429 === 'author' && path === '/chats/-123/members');
    const response = {
      status: rateLimited ? 429 : 200,
      statusText: rateLimited ? 'Too Many Requests' : 'OK',
      headers: new AxiosHeaders(),
      config,
      data: rateLimited ? { code: 'rate.limit' } : responses.shift(),
    };
    if (rateLimited)
      throw new AxiosError(
        'actual adapter HTTP 429',
        AxiosError.ERR_BAD_REQUEST,
        config,
        {},
        response,
      );
    return response;
  });
  const bot: ReturnType<MaxClientService['resolveBot']> = {
    id: botId,
    label: 'Fixture',
    characterName: 'Fixture',
    speechPersona: 'neutral',
    token: 'synthetic-no-network-token',
    tokenValidationSecrets: [],
    webhookSecretPath: 'synthetic-fixture',
    webhookHeaderSecret: 'synthetic-fixture',
    webhookHeaderSecrets: [],
    webhookUrl: null,
    maskedWebhookUrl: null,
    contactId: null,
    state: 'active',
    ownershipWeight: 1,
    visibleInAdmin: false,
    isDefault: true,
  };
  const resolveBot: MaxClientService['resolveBot'] = () => bot;
  const acquireCircuitPermit: MaxClientService['acquireCircuitPermit'] = async () => ({
    halfOpenProbeToken: null,
  });
  const reserveRateLimitSlot: MaxClientService['reserveRateLimitSlot'] = async () => undefined;
  const mutationExecutionScope: MaxClientService['mutationExecutionScope'] =
    new AsyncLocalStorage();
  const priorityHttpSource: MaxClientService['priorityHttpSource'] = new AsyncLocalStorage();
  const recordPriorityHttpAttempt: MaxClientService['recordPriorityHttpAttempt'] = () => undefined;
  const actionHealthService: Pick<
    ActionHealthService,
    'recordSuccessForLane' | 'recordFailureForLane'
  > = {
    recordSuccessForLane: jest.fn(),
    recordFailureForLane: jest.fn(),
  };
  const logUserFacingActionFailure: MaxClientService['logUserFacingActionFailure'] = () =>
    undefined;
  const registerCriticalFailure: MaxClientService['registerCriticalFailure'] = async () =>
    undefined;
  const recordRateLimitOutcome: MaxClientService['recordRateLimitOutcome'] = async () => undefined;
  const rateLimitObservations = {
    usage: { pending: 0, dropped: 0, warnedAt: 0 },
    outcome: { pending: 0, dropped: 0, warnedAt: 0 },
  } satisfies MaxClientService['rateLimitObservations'];
  const chatMembersAccessInFlight: MaxClientService['chatMembersAccessInFlight'] = new Map();
  const limiterRedis: Pick<MaxClientService['limiterRedis'], 'eval'> = {
    eval: jest.fn(async () => 0),
  };
  const muteApiBudget: Pick<
    MaxClientService['muteApiBudget'],
    'consumeRequest' | 'assertRequestAllowed'
  > = {
    consumeRequest: () => undefined,
    assertRequestAllowed: () => undefined,
  };
  // FLAG: Keep descriptor ownership, HTTP outcomes and exact lookup validation real.
  // Only synthetic Axios responses and unrelated bot/quota/circuit dependencies vary.
  const client: MaxClientService = Object.assign(Object.create(MaxClientService.prototype), {
    baseUrl: 'https://exact-lookup-fixture.invalid',
    httpService: new HttpService(axios.create({ adapter: request })),
    botContext: new MaxBotContextService(),
    actionHealthService,
    mutationExecutionScope,
    priorityHttpSource,
    muteApiBudget,
    recordPriorityHttpAttempt,
    resolveBot,
    acquireCircuitPermit,
    reserveRateLimitSlot,
    logUserFacingActionFailure,
    registerCriticalFailure,
    recordRateLimitOutcome,
    rateLimitObservations,
    chatMembersAccessInFlight,
    limiterRedis,
  });
  try {
    if (http429 === 'author')
      await client.getChatMemberAccess('-123', 'user-1', { botId, bypassCache: true });
    else await client.getExactMessageRow('-123', 'm1', { botId });
  } catch (error) {
    expect(
      request.mock.calls.map(([config]) => [config.method, new URL(config.url!).pathname]),
    ).toEqual(
      http429 === 'author'
        ? [['get', '/chats/-123/members']]
        : http429 === 'list'
          ? [['get', '/messages']]
          : [
              ['get', '/messages'],
              ['get', '/messages/m1'],
            ],
    );
    if (http429) expect(error).toMatchObject({ isAxiosError: true, response: { status: 429 } });
    return error;
  }
  throw new Error('Expected the exact MAX lookup to reject the supplied response');
}

function fixture() {
  const settings = {
    requiredSubscriptionEnabled: true,
    requiredSubscriptionChannelIds: ['target-1', 'target-2'],
    requiredSubscriptionWarnEnabled: true,
    requiredSubscriptionMuteEnabled: true,
    requiredSubscriptionBanEnabled: true,
    requiredSubscriptionMuteDurationHours: 1,
    nightModeTimezone: 'UTC',
    chat: { entityType: 'CHAT', admins: [] as unknown[] },
  };
  const at = Date.now();
  const input = {
    chatId: '-123',
    messageId: 'm1',
    subjectUserId: 'user-1',
    botId: 'selected-peer',
    reasons: [
      {
        ruleCode: 'REQUIRED_SUBSCRIPTION_DELETE',
        reasonKey: 'subscription',
        metadata: {
          requiredSubscriptionGuardVersion: 1,
          requiredSubscriptionSourceAtMs: at,
          requiredSubscriptionDeadlineAtMs: at + 300_000,
          requiredSubscriptionPolicySha256: fingerprintModerationSettings(
            settings,
            'REQUIRED_SUBSCRIPTION',
          ),
        },
      },
    ],
  };
  const prisma = { chatSettings: { findUnique: jest.fn(async () => settings) } };
  const max = {
    getChatMemberAccess: jest.fn(async () => ({
      userId: 'user-1',
      isAdmin: false,
      isOwner: false,
    })),
    getExactMessageRow: jest.fn(async () => ({
      sender: { user_id: 'user-1' },
      recipient: { chat_id: '-123', chat_type: 'chat' },
      timestamp: at,
      body: { mid: 'm1', text: 'hello' },
    })),
  };
  const membership = {
    getMembershipResolution: jest.fn(async () => ({ membership: false, fresh: true })),
    getLookupIssue: jest.fn(() => null as unknown),
  };
  const immunity = { consumeForMessage: jest.fn(async () => 'not_granted') };
  const bots = { isKnownBotUserId: jest.fn(() => false) };
  const service = new RequiredSubscriptionExecutionGuardService(
    prisma as never,
    max as never,
    bots as never,
    membership as never,
    immunity as never,
    new ConfigService(),
  );
  return { service, input, settings, max, membership, immunity, prisma, bots };
}

function initialReadBinding(s: ReturnType<typeof fixture>) {
  const metadata = s.input.reasons[0]!.metadata;
  return {
    chatId: s.input.chatId,
    userId: s.input.subjectUserId,
    messageId: s.input.messageId,
    sourceAtMs: metadata.requiredSubscriptionSourceAtMs,
    deadlineAtMs: metadata.requiredSubscriptionDeadlineAtMs,
    policySha256: metadata.requiredSubscriptionPolicySha256,
    botId: s.input.botId,
  } satisfies RequiredSubscriptionInitialSourceReadWaitBinding;
}

describe('required subscription nominal initial read continuation', () => {
  it.each(['author', 'list', 'direct'] as const)(
    'binds one actual %s GET/429 transport outcome to the exact initial read',
    async (route) => {
      const s = fixture();
      const boundary = route === 'author' ? 'author' : 'source';
      const cause = await exactLookupFailure({}, route, s.input.botId);
      const read = boundary === 'author' ? s.max.getChatMemberAccess : s.max.getExactMessageRow;
      read.mockRejectedValue(cause);
      const error: unknown = await s.service
        .authorize({ ...s.input, initialQualification: true })
        .catch((caught: unknown) => caught);
      expect(readRequiredSubscriptionInitialSourceReadWait(error, initialReadBinding(s))).toEqual({
        ...initialReadBinding(s),
        boundary,
      });
      const reused: unknown = await s.service
        .authorize({ ...s.input, initialQualification: true })
        .catch((caught: unknown) => caught);
      expect(
        readRequiredSubscriptionInitialSourceReadWait(reused, initialReadBinding(s)),
      ).toBeNull();
      expect(s.membership.getMembershipResolution).not.toHaveBeenCalled();
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
    },
  );

  it.each(['author', 'list', 'direct'] as const)(
    'refuses an actual %s GET/429 issued by a different bot without reusing its proof',
    async (route) => {
      const s = fixture();
      const cause = await exactLookupFailure({}, route, 'another-bot');
      const read = route === 'author' ? s.max.getChatMemberAccess : s.max.getExactMessageRow;
      read.mockRejectedValue(cause);
      const error: unknown = await s.service
        .authorize({ ...s.input, initialQualification: true })
        .catch((caught: unknown) => caught);
      expect(
        readRequiredSubscriptionInitialSourceReadWait(error, initialReadBinding(s)),
      ).toBeNull();
      s.input.botId = 'another-bot';
      const reused: unknown = await s.service
        .authorize({ ...s.input, initialQualification: true })
        .catch((caught: unknown) => caught);
      expect(
        readRequiredSubscriptionInitialSourceReadWait(reused, initialReadBinding(s)),
      ).toBeNull();
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
    },
  );

  it.each(['author', 'source'] as const)(
    'binds a genuine local %s refusal to the exact live source before any effects',
    async (boundary) => {
      const s = fixture();
      const cause = new MaxApiInternalRateLimitError('token rate limit', 250);
      const read = boundary === 'author' ? s.max.getChatMemberAccess : s.max.getExactMessageRow;
      read.mockRejectedValue(cause);
      const beforeFinalAuthority = jest.fn();
      const error: unknown = await s.service
        .authorize({ ...s.input, initialQualification: true, beforeFinalAuthority })
        .catch((caught: unknown) => caught);
      const expected = initialReadBinding(s);
      const proof = readRequiredSubscriptionInitialSourceReadWait(error, expected);
      expect(proof).toEqual({ ...expected, boundary });
      expect(Object.isFrozen(proof)).toBe(true);
      expect(s.membership.getMembershipResolution).not.toHaveBeenCalled();
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
      expect(beforeFinalAuthority).not.toHaveBeenCalled();
      if (boundary === 'author') expect(s.max.getExactMessageRow).not.toHaveBeenCalled();

      const changed: RequiredSubscriptionInitialSourceReadWaitBinding[] = [
        { ...expected, chatId: '-456' },
        { ...expected, userId: 'user-2' },
        { ...expected, messageId: 'm2' },
        { ...expected, sourceAtMs: expected.sourceAtMs + 1 },
        { ...expected, deadlineAtMs: expected.deadlineAtMs + 1 },
        { ...expected, policySha256: 'another-policy' },
        { ...expected, botId: 'another-bot' },
      ];
      for (const binding of changed)
        expect(readRequiredSubscriptionInitialSourceReadWait(error, binding)).toBeNull();
      expect(readRequiredSubscriptionInitialSourceReadWait(error, expected)).toBe(proof);
    },
  );

  it('does not grant continuation to public wrappers, copies, JSON or causes', async () => {
    const s = fixture();
    const cause = new MaxApiInternalRateLimitError('token rate limit', 250);
    s.max.getExactMessageRow.mockRejectedValue(cause);
    const genuine: unknown = await s.service
      .authorize({ ...s.input, initialQualification: true })
      .catch((caught: unknown) => caught);
    const errors = [
      new RequiredSubscriptionInitialSourceUnavailableError(cause),
      new RequiredSubscriptionAuthorAccessUnavailableError(cause),
      Object.assign(new Error('copied'), genuine),
      Object.assign(Object.create(Object.getPrototypeOf(genuine)), genuine),
      JSON.parse(JSON.stringify(genuine)),
      new Error('wrapped', { cause: genuine }),
      cause,
    ];
    for (const error of errors)
      expect(
        readRequiredSubscriptionInitialSourceReadWait(error, initialReadBinding(s)),
      ).toBeNull();
    expect(
      readRequiredSubscriptionInitialSourceReadWait(genuine, initialReadBinding(s)),
    ).not.toBeNull();
  });

  it.each(['author', 'source'] as const)(
    'does not mint a %s continuation from HTTP, protected-budget or unsafe local failures',
    async (boundary) => {
      const errors: unknown[] = [
        Object.assign(new Error('HTTP quota'), {
          response: { status: 429 },
          config: { method: 'get' },
        }),
        Object.assign(new Error('HTTP missing'), { response: { status: 404 } }),
        Object.assign(new Error('read timeout'), { code: 'ETIMEDOUT' }),
        new MaxModerationApiBudgetError('attempt_budget', 1_000),
        Object.assign(new Error('copied quota'), new MaxApiInternalRateLimitError('quota', 250)),
        Object.assign(new MaxApiInternalRateLimitError('quota', 250), { request: {} }),
        Object.assign(new MaxApiInternalRateLimitError('quota', 250), { response: {} }),
        Object.assign(new MaxApiInternalRateLimitError('quota', 250), {
          config: { method: 'post' },
        }),
        Object.assign(new MaxApiInternalRateLimitError('quota', 250), { preDispatch: false }),
        markMaxMessageSendAttempted(new MaxApiInternalRateLimitError('quota', 250)),
        markMaxMemberMutationAttempted(new MaxApiInternalRateLimitError('quota', 250)),
        markMaxMemberMutationConfirmed(new MaxApiInternalRateLimitError('quota', 250)),
        new MaxApiInternalRateLimitError('ambiguous MAX mutation', 250),
      ];
      for (const cause of errors) {
        const s = fixture();
        const read = boundary === 'author' ? s.max.getChatMemberAccess : s.max.getExactMessageRow;
        read.mockRejectedValue(cause);
        const error: unknown = await s.service
          .authorize({ ...s.input, initialQualification: true })
          .catch((caught: unknown) => caught);
        expect(
          readRequiredSubscriptionInitialSourceReadWait(error, initialReadBinding(s)),
        ).toBeNull();
        expect(s.membership.getMembershipResolution).not.toHaveBeenCalled();
        expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
      }
    },
  );

  it.each(['author', 'source'] as const)(
    'does not mint a %s continuation at final dispatch or DELETE handoff',
    async (boundary) => {
      for (const scope of [
        {},
        { initialQualification: false },
        { deleteHandoffQualification: true as const },
      ]) {
        const s = fixture();
        const cause = new MaxApiInternalRateLimitError('token rate limit', 250);
        const read = boundary === 'author' ? s.max.getChatMemberAccess : s.max.getExactMessageRow;
        read.mockRejectedValue(cause);
        const error: unknown = await s.service
          .authorize({ ...s.input, ...scope })
          .catch((caught: unknown) => caught);
        expect(
          readRequiredSubscriptionInitialSourceReadWait(error, initialReadBinding(s)),
        ).toBeNull();
      }
    },
  );

  it.each([undefined, '', ' selected-peer', 'selected-peer '])(
    'requires the exact selected bot ID (%s)',
    async (botId) => {
      const s = fixture();
      s.max.getExactMessageRow.mockRejectedValue(new MaxApiInternalRateLimitError('quota', 250));
      const error: unknown = await s.service
        .authorize({ ...s.input, botId, initialQualification: true })
        .catch((caught: unknown) => caught);
      expect(
        readRequiredSubscriptionInitialSourceReadWait(error, initialReadBinding(s)),
      ).toBeNull();
    },
  );

  it.each(['expiry', 'cause-mutated', 'wrapper-mutated', 'effect-marked'] as const)(
    'revokes a previously minted proof on %s without renewing its deadline',
    async (change) => {
      const s = fixture();
      const cause = new MaxApiInternalRateLimitError('quota', 250);
      s.max.getExactMessageRow.mockRejectedValue(cause);
      const error: unknown = await s.service
        .authorize({ ...s.input, initialQualification: true })
        .catch((caught: unknown) => caught);
      const expected = initialReadBinding(s);
      expect(readRequiredSubscriptionInitialSourceReadWait(error, expected)).not.toBeNull();
      let clock: jest.SpyInstance | undefined;
      try {
        if (change === 'expiry')
          clock = jest.spyOn(Date, 'now').mockReturnValue(expected.deadlineAtMs);
        if (change === 'cause-mutated') Object.assign(cause, { request: {} });
        if (change === 'wrapper-mutated')
          Object.assign(error as object, { cause: new Error('replacement') });
        if (change === 'effect-marked') markMaxMessageSendAttempted(error);
        expect(readRequiredSubscriptionInitialSourceReadWait(error, expected)).toBeNull();
        expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
      } finally {
        clock?.mockRestore();
      }
    },
  );
});

describe('required subscription execution authorization', () => {
  it.each(['initialQualification', 'deleteHandoffQualification'] as const)(
    'classifies only the exact author GET 429 for %s while final dispatch remains denied',
    async (scope) => {
      const s = fixture();
      const error = Object.assign(new Error('member read rate limited'), {
        response: { status: 429 },
        config: { method: 'get' },
      });
      s.max.getChatMemberAccess.mockRejectedValue(error);
      await expect(s.service.authorize({ ...s.input, [scope]: true })).rejects.toMatchObject({
        constructor: RequiredSubscriptionAuthorAccessUnavailableError,
        cause: error,
      });
      await expect(s.service.authorize(s.input)).rejects.toBe(error);
      expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
    },
  );
  it.each(['member', 'source'] as const)(
    'defers only a concrete pre-dispatch %s limiter at allowed scopes',
    async (boundary) => {
      const s = fixture();
      const error = new MaxApiInternalRateLimitError('token rate limit', 250);
      const read = boundary === 'member' ? s.max.getChatMemberAccess : s.max.getExactMessageRow;
      read.mockRejectedValue(error);
      for (const scope of ['initialQualification', 'deleteHandoffQualification'] as const) {
        await expect(s.service.authorize({ ...s.input, [scope]: true })).rejects.toMatchObject({
          constructor:
            boundary === 'member'
              ? RequiredSubscriptionAuthorAccessUnavailableError
              : scope === 'initialQualification'
                ? RequiredSubscriptionInitialSourceUnavailableError
                : RequiredSubscriptionDeleteSourceUnavailableError,
          cause: error,
        });
      }
      await expect(s.service.authorize(s.input)).rejects.toBe(error);
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
    },
  );

  it.each(['copied', 'http', 'post', 'send', 'member', 'confirmed', 'ambiguous'] as const)(
    'retains unsafe local limiter evidence: %s',
    async (failure) => {
      let error: unknown = new MaxApiInternalRateLimitError('token rate limit', 250);
      if (failure === 'copied') error = Object.assign(new Error('token rate limit'), error);
      if (failure === 'http') Object.assign(error as object, { response: { status: 503 } });
      if (failure === 'post') Object.assign(error as object, { config: { method: 'post' } });
      if (failure === 'send') error = markMaxMessageSendAttempted(error);
      if (failure === 'member') error = markMaxMemberMutationAttempted(error);
      if (failure === 'confirmed') error = markMaxMemberMutationConfirmed(error);
      if (failure === 'ambiguous')
        Object.assign(error as object, { message: 'ambiguous MAX mutation' });
      for (const boundary of ['member', 'source']) {
        const s = fixture();
        const read = boundary === 'member' ? s.max.getChatMemberAccess : s.max.getExactMessageRow;
        read.mockRejectedValue(error);
        for (const scope of [
          { initialQualification: true },
          { deleteHandoffQualification: true as const },
          {},
        ])
          await expect(s.service.authorize({ ...s.input, ...scope })).rejects.toBe(error);
        expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    '404',
    '403',
    '503',
    'missing-method',
    'post',
    'send-attempted',
    'member-confirmed',
    'ambiguous',
  ])('preserves unsafe author-read evidence: %s', async (failure) => {
    const s = fixture();
    let error: unknown = Object.assign(
      new Error(failure === 'ambiguous' ? 'ambiguous MAX mutation' : 'read failed'),
      {
        response: { status: /^\d+$/.test(failure) ? Number(failure) : 429 },
        ...(failure === 'missing-method'
          ? {}
          : { config: { method: failure === 'post' ? 'post' : 'get' } }),
      },
    );
    if (failure === 'send-attempted') error = markMaxMessageSendAttempted(error);
    if (failure === 'member-confirmed') error = markMaxMemberMutationConfirmed(error);
    s.max.getChatMemberAccess.mockRejectedValue(error);
    for (const scope of [
      { initialQualification: true },
      { deleteHandoffQualification: true as const },
      {},
    ])
      await expect(s.service.authorize({ ...s.input, ...scope })).rejects.toBe(error);
    expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
  });
  it.each([
    '404',
    'missing-id',
    'ECONNABORTED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ECONNREFUSED',
  ])(
    'classifies exact source %s only for durable DELETE handoff, without granting deletion',
    async (failure) => {
      const s = fixture();
      const error =
        failure === '404'
          ? { response: { status: 404, data: {} } }
          : failure === 'missing-id'
            ? await exactLookupFailure({})
            : Object.assign(new Error('source read failed'), {
                code: failure,
                config: { method: 'get' },
              });
      s.max.getExactMessageRow.mockRejectedValue(error);
      const beforeFinalAuthority = jest.fn();
      await expect(
        s.service.authorize({
          ...s.input,
          deleteHandoffQualification: true,
          beforeFinalAuthority,
        }),
      ).rejects.toMatchObject({
        constructor: RequiredSubscriptionDeleteSourceUnavailableError,
        cause: error,
      });
      expect(s.membership.getMembershipResolution).not.toHaveBeenCalled();
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
      expect(beforeFinalAuthority).not.toHaveBeenCalled();
      await expect(s.service.authorize(s.input)).rejects.toBe(error);
    },
  );
  it.each([{}, { message: { body: { text: 'hello' } } }, { body: { mid: 'another-message' } }])(
    'distinguishes genuine initial source GET missing requested ID (%j)',
    async (data) => {
      const s = fixture();
      const error = await exactLookupFailure(data);
      expect(isMaxExactMessageLookupMissingIdError(error)).toBe(true);
      const beforeFinalAuthority = jest.fn();
      s.max.getExactMessageRow.mockRejectedValue(error);
      await expect(
        s.service.authorize({ ...s.input, initialQualification: true, beforeFinalAuthority }),
      ).rejects.toMatchObject({
        constructor: RequiredSubscriptionInitialSourceUnavailableError,
        cause: error,
      });
      expect(s.membership.getMembershipResolution).not.toHaveBeenCalled();
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
      expect(beforeFinalAuthority).not.toHaveBeenCalled();
      await expect(s.service.authorize(s.input)).rejects.toBe(error);
      await expect(s.service.authorize({ ...s.input, initialQualification: false })).rejects.toBe(
        error,
      );
    },
  );

  it.each([{ body: { mid: 'm1' }, recipient: { chat_id: '-456' } }, { body: { mid: 'm1' } }])(
    'preserves other initial source identity failures (%j)',
    async (message) => {
      const s = fixture();
      const error = await exactLookupFailure({ message });
      expect(isMaxExactMessageLookupMissingIdError(error)).toBe(false);
      s.max.getExactMessageRow.mockRejectedValue(error);
      await expect(s.service.authorize({ ...s.input, initialQualification: true })).rejects.toBe(
        error,
      );
      await expect(
        s.service.authorize({ ...s.input, deleteHandoffQualification: true }),
      ).rejects.toBe(error);
      expect(s.membership.getMembershipResolution).not.toHaveBeenCalled();
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
    },
  );

  it('does not accept copied missing-ID error text, name, properties or prototype as provenance', async () => {
    const genuine = (await exactLookupFailure({})) as Error;
    const errors = [
      new Error(genuine.message),
      Object.assign(new Error(genuine.message), genuine),
      Object.assign(Object.create(Object.getPrototypeOf(genuine)), genuine),
      new Error('wrapped lookup failure', { cause: genuine }),
    ];
    for (const error of errors) {
      const s = fixture();
      expect(isMaxExactMessageLookupMissingIdError(error)).toBe(false);
      s.max.getExactMessageRow.mockRejectedValue(error);
      await expect(s.service.authorize({ ...s.input, initialQualification: true })).rejects.toBe(
        error,
      );
      expect(s.membership.getMembershipResolution).not.toHaveBeenCalled();
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
    }
  });

  it.each(['member-access', 'target-membership'] as const)(
    'preserves a genuine missing-ID failure from %s during initial qualification',
    async (source) => {
      const s = fixture();
      const error = await exactLookupFailure({});
      if (source === 'member-access') s.max.getChatMemberAccess.mockRejectedValue(error);
      else s.membership.getMembershipResolution.mockRejectedValue(error);
      await expect(s.service.authorize({ ...s.input, initialQualification: true })).rejects.toBe(
        error,
      );
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
      if (source === 'member-access') expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['send attempted', markMaxMessageSendAttempted],
    ['member attempted', markMaxMemberMutationAttempted],
    ['member confirmed', markMaxMemberMutationConfirmed],
    [
      'ambiguous status',
      (error: unknown) => Object.assign(error as object, { response: { status: 503 } }),
    ],
    [
      'ambiguous mutation',
      (error: unknown) => Object.assign(error as object, { message: 'ambiguous MAX mutation' }),
    ],
  ] as const)('preserves genuine missing-ID error with %s', async (_label, mark) => {
    const s = fixture();
    const error = mark(await exactLookupFailure({}));
    expect(isMaxExactMessageLookupMissingIdError(error)).toBe(true);
    s.max.getExactMessageRow.mockRejectedValue(error);
    await expect(s.service.authorize({ ...s.input, initialQualification: true })).rejects.toBe(
      error,
    );
    await expect(
      s.service.authorize({ ...s.input, deleteHandoffQualification: true }),
    ).rejects.toBe(error);
    expect(s.membership.getMembershipResolution).not.toHaveBeenCalled();
    expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
  });

  it.each([{ response: { status: 404, data: {} } }, { status: 404 }, { getStatus: () => 404 }])(
    'distinguishes initial source GET 404 without granting authority or consuming immunity (%j)',
    async (error) => {
      const s = fixture();
      const beforeFinalAuthority = jest.fn();
      s.max.getExactMessageRow.mockRejectedValue(error);
      let failure: unknown;
      try {
        await s.service.authorize({ ...s.input, initialQualification: true, beforeFinalAuthority });
      } catch (caught) {
        failure = caught;
      }
      expect(failure).toBeInstanceOf(RequiredSubscriptionInitialSourceUnavailableError);
      expect(failure).not.toBeInstanceOf(RequiredSubscriptionExecutionRejectedError);
      expect((failure as Error).cause).toBe(error);
      expect(s.membership.getMembershipResolution).not.toHaveBeenCalled();
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
      expect(beforeFinalAuthority).not.toHaveBeenCalled();
      await expect(s.service.authorize(s.input)).rejects.toBe(error);
      await expect(s.service.authorize({ ...s.input, initialQualification: false })).rejects.toBe(
        error,
      );
    },
  );

  it.each(['member-access', 'target-membership'] as const)(
    'preserves a %s GET 404 during initial qualification',
    async (source) => {
      const s = fixture();
      const error = { response: { status: 404, data: {} } };
      if (source === 'member-access') s.max.getChatMemberAccess.mockRejectedValue(error);
      else s.membership.getMembershipResolution.mockRejectedValue(error);
      await expect(s.service.authorize({ ...s.input, initialQualification: true })).rejects.toBe(
        error,
      );
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
      if (source === 'member-access') expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
    },
  );

  it.each([
    { response: { status: 403, data: {} } },
    { response: { status: 500, data: {} } },
    new Error('source transport unavailable'),
    Object.assign(new Error('ambiguous MAX mutation'), { response: { status: 404, data: {} } }),
    markMaxMessageSendAttempted({ response: { status: 404, data: {} } }),
    markMaxMemberMutationAttempted({ response: { status: 404, data: {} } }),
    markMaxMemberMutationConfirmed({ response: { status: 404, data: {} } }),
  ])(
    'preserves initial non-404 and attempted or ambiguous mutation failures (%j)',
    async (error) => {
      const s = fixture();
      s.max.getExactMessageRow.mockRejectedValue(error);
      await expect(s.service.authorize({ ...s.input, initialQualification: true })).rejects.toBe(
        error,
      );
      await expect(
        s.service.authorize({ ...s.input, deleteHandoffQualification: true }),
      ).rejects.toBe(error);
      await expect(
        s.service.authorize({ ...s.input, deleteHandoffQualification: true }),
      ).rejects.toBe(error);
      expect(s.membership.getMembershipResolution).not.toHaveBeenCalled();
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, false, true])(
    'retains confirmed null-source absence with initialQualification=%s',
    async (initialQualification) => {
      const s = fixture();
      s.max.getExactMessageRow.mockResolvedValue(null as never);
      await expect(s.service.authorize({ ...s.input, initialQualification })).resolves.toBe(
        'absent',
      );
      expect(s.membership.getMembershipResolution).not.toHaveBeenCalled();
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
    },
  );

  it('checks the route after fresh membership before final settings and deadline', async () => {
    const s = fixture();
    const route = jest.fn(async () => {
      expect(s.membership.getMembershipResolution).toHaveBeenCalledTimes(2);
      s.settings.requiredSubscriptionEnabled = false;
    });
    await expect(
      s.service.authorize({ ...s.input, beforeFinalAuthority: route }),
    ).rejects.toMatchObject({
      code: 'required_subscription_no_longer_authorized',
    });
    expect(route).toHaveBeenCalledTimes(1);
    expect(s.prisma.chatSettings.findUnique).toHaveBeenCalledTimes(2);
  });

  it('does not extend the original deadline while the final route is checked', async () => {
    const s = fixture();
    let clock: jest.SpyInstance | undefined;
    try {
      await expect(
        s.service.authorize({
          ...s.input,
          beforeFinalAuthority: async () => {
            clock = jest
              .spyOn(Date, 'now')
              .mockReturnValue(s.input.reasons[0]!.metadata.requiredSubscriptionDeadlineAtMs);
          },
        }),
      ).rejects.toMatchObject({ code: 'required_subscription_no_longer_authorized' });
    } finally {
      clock?.mockRestore();
    }
  });
  it('checks all targets fresh through their own routes with at most two concurrent probes', async () => {
    const s = fixture();
    await expect(s.service.authorize(s.input)).resolves.toMatchObject({
      reasonKeys: ['subscription'],
      deadlineAtMs: s.input.reasons[0]!.metadata.requiredSubscriptionDeadlineAtMs,
      reasonDeadlines: [
        {
          reasonKey: 'subscription',
          deadlineAtMs: s.input.reasons[0]!.metadata.requiredSubscriptionDeadlineAtMs,
        },
      ],
    });
    expect(s.membership.getMembershipResolution).toHaveBeenCalledTimes(2);
    expect(s.membership.getMembershipResolution).toHaveBeenCalledWith(
      'target-1',
      'user-1',
      'moderation_required_subscription',
      { forceRefresh: true, allowStaleOnError: false },
    );
  });

  it('preserves each subscription source deadline instead of extending the older reason', async () => {
    const s = fixture();
    const recent = s.input.reasons[0]!;
    const earlier = {
      ...recent,
      reasonKey: 'earlier-subscription',
      metadata: {
        ...recent.metadata,
        requiredSubscriptionSourceAtMs: recent.metadata.requiredSubscriptionSourceAtMs - 60_000,
        requiredSubscriptionDeadlineAtMs: recent.metadata.requiredSubscriptionDeadlineAtMs - 60_000,
      },
    };
    await expect(s.service.authorize({ ...s.input, reasons: [earlier, recent] })).resolves.toEqual({
      reasonKeys: ['earlier-subscription', 'subscription'],
      deadlineAtMs: recent.metadata.requiredSubscriptionDeadlineAtMs,
      reasonDeadlines: [
        {
          reasonKey: 'earlier-subscription',
          deadlineAtMs: earlier.metadata.requiredSubscriptionDeadlineAtMs,
        },
        {
          reasonKey: 'subscription',
          deadlineAtMs: recent.metadata.requiredSubscriptionDeadlineAtMs,
        },
      ],
    });
    expect(s.membership.getMembershipResolution).toHaveBeenCalledTimes(2);
  });
  it.each([
    'joined',
    'disabled',
    'targets',
    'admin',
    'immunity',
    'deadline',
    'changed-during-probe',
  ])('revokes the delete and member sanction after %s', async (change) => {
    const s = fixture();
    if (change === 'joined')
      s.membership.getMembershipResolution.mockResolvedValue({ membership: true, fresh: true });
    if (change === 'disabled') s.settings.requiredSubscriptionEnabled = false;
    if (change === 'targets') s.settings.requiredSubscriptionChannelIds = ['another'];
    if (change === 'admin')
      s.max.getChatMemberAccess.mockResolvedValue({
        userId: 'user-1',
        isAdmin: true,
        isOwner: false,
      });
    if (change === 'immunity') s.immunity.consumeForMessage.mockResolvedValue('granted');
    if (change === 'deadline')
      s.input.reasons[0]!.metadata.requiredSubscriptionDeadlineAtMs = Date.now() - 1;
    if (change === 'changed-during-probe')
      s.membership.getMembershipResolution.mockImplementation(async () => {
        s.settings.requiredSubscriptionEnabled = false;
        return { membership: false, fresh: true };
      });
    await expect(s.service.authorize(s.input)).rejects.toMatchObject({
      code: 'required_subscription_no_longer_authorized',
    });
  });
  it('stops on unavailable evidence and terminal targets, without treating them as missing', async () => {
    const s = fixture();
    s.membership.getMembershipResolution.mockResolvedValue({
      membership: null,
      fresh: false,
    } as never);
    await expect(s.service.authorize(s.input)).rejects.toThrow('fresh membership unavailable');
    s.membership.getLookupIssue.mockReturnValue({ kind: 'terminal' });
    await expect(s.service.authorize(s.input)).rejects.toMatchObject({
      code: 'required_subscription_no_longer_authorized',
    });
  });
});
