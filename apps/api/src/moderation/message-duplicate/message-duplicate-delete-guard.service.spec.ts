import { ConfigService } from '@nestjs/config';
import { MaxApiInternalRateLimitError } from '../../max/max-client.service';
import { readModerationGuardFailure } from '../moderation-guard-failure-diagnostic';
import { readDuplicateLookupFailure } from './message-duplicate-lookup-diagnostic';
import {
  MessageDuplicateInitialSourceUnavailableError,
  MessageDuplicateQualificationSourceUnavailableError,
} from './message-duplicate-guard.contract';
import {
  markMaxMemberMutationAttempted,
  markMaxMemberMutationConfirmed,
} from '../../max/max-member-error.util';
import { markMaxMessageSendAttempted } from '../../max/max-mutation-outcome.util';
import {
  MessageDuplicateDeleteGuardService,
  MessageDuplicateGuardRejectedError,
} from './message-duplicate-delete-guard.service';
import {
  buildMessageDuplicateIdentity,
  digestDuplicateContent,
  extractDuplicateMessageContent,
  exactImageSourceDigest,
} from './message-duplicate-content';
import { duplicateSourceDigest } from './message-duplicate-history.service';
import {
  messageDuplicateNoticeSettingsDigest,
  type MessageDuplicateNoticeProof,
} from './message-duplicate-notice-proof';
import {
  MESSAGE_DUPLICATE_MEDIA_VERSION,
  messageDuplicateSettingsDigest,
  exactImageSettingsDigest,
  messageDuplicateSanctionSettingsDigest,
  type MessageDuplicateBinding,
} from './message-duplicate-state';
import {
  duplicateSettings,
  duplicateUpdate,
  preUnicodeNearSettingsDigests,
  preSafeTextSettingsDigests,
  preBoundedPhoneSettingsDigests,
  prePhoneBoundarySettingsDigests,
  preSourceBoundPhoneSettingsDigests,
  preV3HistorySettingsDigests,
  preSemanticUnitSettingsDigests,
  prePrefixUnitSettingsDigests,
  preElectricalUnitSettingsDigests,
} from './message-duplicate-test-fixtures';

function setup() {
  const update = duplicateUpdate();
  const settings = {
    ...duplicateSettings(),
    chat: { entityType: 'CHAT', admins: [] as { userId: string }[] },
  };
  const content = extractDuplicateMessageContent(update.raw);
  const binding: MessageDuplicateBinding = {
    version: 3,
    enforcementScope: 'delete_only',
    lifecycleRevision: 'd'.repeat(64),
    policyRevision: settings.duplicatePolicyRevision,
    authorization: {
      eventTimestampMs: Date.parse(update.message!.createdAt),
      deadlineAtMs: Date.parse(update.message!.createdAt) + 600_000,
    },
    senderId: '123',
    messageId: 'm2',
    eventTimestampMs: Date.parse(update.message!.createdAt),
    controlRevision: 1,
    settingsDigest: messageDuplicateSettingsDigest(settings),
    sourceDigest: content.sourceDigest,
    contentDigest: buildMessageDuplicateIdentity(content, 'MESSAGE')!,
    fingerprint: 'b'.repeat(64),
    compareMode: 'MESSAGE',
    mediaHashes: [],
    mediaVersion: MESSAGE_DUPLICATE_MEDIA_VERSION,
    hasPhotos: false,
    photoControlRevision: null,
    windowSeconds: 3600,
    requiredCount: 2,
  };
  binding.original = {
    member: digestDuplicateContent('m1'),
    author: digestDuplicateContent('123'),
    messageId: 'm1',
    senderId: '123',
    publishedAtMs: binding.eventTimestampMs - 1000,
    observedAtMs: binding.eventTimestampMs - 1000,
    expiresAtMs: binding.eventTimestampMs + 3599000,
    sourceDigest: binding.sourceDigest,
    contentDigest: binding.contentDigest,
    mediaHashes: [],
    epoch: 0,
    revision: 'e'.repeat(64),
    originalId: 'f'.repeat(64),
  };
  const policy = {
    resolve: jest.fn().mockResolvedValue({
      mode: 'delete_only',
      revision: 1,
      effectiveAtMs: Date.now() - 10000,
      expiresAtMs: Date.now() + 3600000,
    }),
  };
  const prisma = {
    chatSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
    moderationEvent: { findFirst: jest.fn().mockResolvedValue(null) },
    moderationDeleteIntent: { findUnique: jest.fn().mockResolvedValue(null) },
    moderationDeleteIntentReason: {
      findMany: jest.fn().mockResolvedValue([
        {
          reasonKey: 'MESSAGE_DUPLICATE:v1',
          ruleCode: 'DUPLICATE_DELETE',
          metadata: { duplicateSource: 'message_v1', messageDuplicate: binding },
        },
      ]),
    },
  };
  const max = {
    getChatMemberAccess: jest
      .fn()
      .mockResolvedValue({ userId: '123', isAdmin: false, isOwner: false }),
    getExactMessageRow: jest.fn().mockResolvedValue((update.raw as { message: unknown }).message),
  };
  const targetLookup = max.getExactMessageRow;
  const originalUpdate = duplicateUpdate('m1', binding.original.publishedAtMs);
  const originalRaw = (originalUpdate.raw as { message: unknown }).message;
  const originalLookup = jest.fn(async () => originalRaw);
  const guardedMax = {
    ...max,
    getExactMessageRow: async (chatId: string, messageId: string, options: unknown) =>
      messageId === 'm1'
        ? originalLookup()
        : (targetLookup as (...args: unknown[]) => Promise<unknown>)(chatId, messageId, options),
  };
  const bots = {
    isKnownBotUserId: jest.fn().mockReturnValue(false),
    isRegisteredModerationBotId: jest.fn((id: string) => ['bot', 'peer'].includes(id)),
  };
  const immunity = { consumeForMessage: jest.fn().mockResolvedValue('not_granted') };
  const photos = {
    resolveEffectivePolicy: jest.fn().mockResolvedValue({
      enforce: true,
      allowedMatchKinds: ['canonical_sha256'],
      controlRevision: 1,
    }),
  };
  const history = {
    stillMatches: jest.fn().mockResolvedValue(true),
    remove: jest.fn(),
    observeLifecycle: jest.fn(),
    invalidateLifecycle: jest.fn(),
    qualified: jest.fn().mockResolvedValue(null),
    qualify: jest.fn().mockResolvedValue(1),
  };
  const authorization = { isAllowed: jest.fn().mockResolvedValue(true) };
  const metrics = { record: jest.fn(), recordGuardRejection: jest.fn() };
  const legacyHolds = { isAnyMessageSourceHeld: jest.fn().mockResolvedValue(false) };
  const service = new MessageDuplicateDeleteGuardService(
    prisma as never,
    guardedMax as never,
    bots as never,
    immunity as never,
    policy as never,
    history as never,
    new ConfigService(),
    authorization as never,
    metrics as never,
    legacyHolds as never,
  );
  const params = {
    intentId: 'intent',
    chatId: '-123',
    messageId: 'm2',
    subjectUserId: '123',
    botId: 'bot',
  };
  return {
    service,
    legacyHolds,
    originalRaw,
    originalLookup,
    binding,
    params,
    settings,
    policy,
    prisma,
    max,
    bots,
    immunity,
    photos,
    history,
    authorization,
    metrics,
  };
}

describe('scheduled duplicate final action guard', () => {
  it('rechecks the end boundary after external calls', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-29T14:59Z'));
    try {
      const s = setup();
      s.settings.duplicateWindowMode = 'DAILY';
      s.binding.settingsDigest = messageDuplicateSettingsDigest(s.settings);
      s.binding.original!.expiresAtMs = Date.parse('2026-09-29T15:00Z');
      s.immunity.consumeForMessage.mockImplementation(async () => {
        clock.mockReturnValue(Date.parse('2026-09-29T15:00Z'));
        return 'not_granted';
      });
      await expect(
        s.service.assertMessageStillActionable({ ...s.params, binding: s.binding }),
      ).rejects.toMatchObject({ code: 'message_duplicate_schedule_closed' });
    } finally {
      clock.mockRestore();
    }
  });
  it('rejects queued decisions after changing the timezone', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-29T10:00Z'));
    try {
      const s = setup();
      s.settings.duplicateWindowMode = 'DAILY';
      s.binding.settingsDigest = messageDuplicateSettingsDigest(s.settings);
      s.binding.original!.expiresAtMs = Date.parse('2026-09-29T15:00Z');
      s.settings.duplicateTimezone = 'Asia/Tokyo';
      await expect(
        s.service.assertMessageStillActionable({ ...s.params, binding: s.binding }),
      ).rejects.toMatchObject({ code: 'message_duplicate_settings_changed' });
      expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
    } finally {
      clock.mockRestore();
    }
  });
});

describe('message duplicate final delete guard', () => {
  it.each(['missing', 'original', 'current', 'version', 'legacy_version'] as const)(
    'rejects %s recompression evidence before qualification or external reads',
    async (change) => {
      const s = setup();
      s.binding.compareMode = 'IMAGE';
      s.binding.imageScope = 'CHAT';
      s.binding.enforcementScope = 'full';
      s.binding.hasPhotos = true;
      s.binding.mediaHashes = ['b'.repeat(64)];
      s.binding.original!.mediaHashes = ['a'.repeat(64)];
      s.binding.imageRecompression = {
        version: 'native-recompression-v2',
        originalHash: 'a'.repeat(64),
        currentHash: 'b'.repeat(64),
      };
      if (change === 'missing') delete s.binding.imageRecompression;
      else if (change === 'original') s.binding.imageRecompression.originalHash = 'c'.repeat(64);
      else if (change === 'current') s.binding.imageRecompression.currentHash = 'c'.repeat(64);
      else if (change === 'legacy_version')
        (s.binding.imageRecompression as { version: string }).version = 'native-recompression-v1';
      else (s.binding.imageRecompression as { version: string }).version = 'old';
      await expect(
        s.service.assertQualificationAuthority(s.params.chatId, s.binding),
      ).rejects.toMatchObject({ code: 'message_duplicate_binding_invalid' });
      expect(s.authorization.isAllowed).not.toHaveBeenCalled();
      expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
    },
  );
  it.each(['qualification', 'initial_delete', 'delete_recheck', 'sanction'] as const)(
    'retains the original author lookup refusal at %s without changing its outcome',
    async (phase) => {
      const s = full();
      const error = new MaxApiInternalRateLimitError('Private author read failure', 7);
      s.max.getChatMemberAccess.mockRejectedValue(error);
      const request = { ...s.params, binding: s.binding };
      const action =
        phase === 'qualification'
          ? s.service.qualify(request)
          : s.service.assertMessageStillActionable({
              ...request,
              ...(phase === 'sanction'
                ? { sanctionIntentId: 'intent' }
                : {
                    deletePhase:
                      phase === 'initial_delete'
                        ? ('initial_unattempted' as const)
                        : ('recheck' as const),
                  }),
            });
      await expect(action).rejects.toBe(error);
      expect(readDuplicateLookupFailure(error)).toEqual({
        duplicateLookupPhase: phase,
        duplicateLookupSource: 'author',
      });
      expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
      expect(s.originalLookup).not.toHaveBeenCalled();
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
      expect(s.history.qualify).not.toHaveBeenCalled();
    },
  );

  it.each(['current', 'original'] as const)(
    'hands off a concrete local limiter at initial %s source boundaries only',
    async (stage) => {
      const s = setup();
      const error = new MaxApiInternalRateLimitError('Fixture local read quota', 7);
      if (stage === 'current') s.max.getExactMessageRow.mockRejectedValue(error);
      else s.originalLookup.mockRejectedValue(error);
      const request = { ...s.params, binding: s.binding };
      await expect(s.service.qualify(request)).rejects.toMatchObject({
        name: 'MessageDuplicateQualificationSourceUnavailableError',
        source: stage,
        cause: error,
      });
      await expect(
        s.service.assertMessageStillActionable({ ...request, deletePhase: 'initial_unattempted' }),
      ).rejects.toMatchObject({
        name: 'MessageDuplicateInitialSourceUnavailableError',
        source: stage,
        cause: error,
      });
      await expect(
        s.service.assertMessageStillActionable({ ...request, deletePhase: 'recheck' }),
      ).rejects.toBe(error);
      await expect(s.service.assertMessageStillActionable(request)).rejects.toBe(error);
      expect(s.history.remove).not.toHaveBeenCalled();
      expect(s.history.invalidateLifecycle).not.toHaveBeenCalled();
      expect(s.history.qualify).not.toHaveBeenCalled();
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
      const sanction = full();
      sanction.max.getExactMessageRow.mockRejectedValue(error);
      await expect(
        sanction.service.assertMessageStillActionable({
          ...sanction.request,
          deletePhase: 'initial_unattempted',
        }),
      ).rejects.toBe(error);
    },
  );

  it.each([
    Object.assign(new Error('Copied limiter'), {
      name: 'MaxApiInternalRateLimitError',
      code: 'max_api_internal_rate_limit',
      preDispatch: true,
    }),
    Object.assign(new MaxApiInternalRateLimitError('Conflicting HTTP response', 7), {
      response: { status: 429 },
    }),
    Object.assign(new MaxApiInternalRateLimitError('Response without status', 7), { response: {} }),
    Object.assign(new MaxApiInternalRateLimitError('Conflicting method', 7), {
      config: { method: 'post' },
    }),
    markMaxMessageSendAttempted(new MaxApiInternalRateLimitError('Send attempted', 7)),
    markMaxMemberMutationAttempted(
      new MaxApiInternalRateLimitError('Member mutation attempted', 7),
    ),
    new MaxApiInternalRateLimitError('ambiguous MAX mutation', 7),
  ])('preserves misleading or attempted limiter evidence: %s', async (error) => {
    const s = setup();
    s.originalLookup.mockRejectedValue(error);
    const request = { ...s.params, binding: s.binding };
    await expect(s.service.qualify(request)).rejects.toBe(error);
    await expect(
      s.service.assertMessageStillActionable({ ...request, deletePhase: 'initial_unattempted' }),
    ).rejects.toBe(error);
    expect(s.history.qualify).not.toHaveBeenCalled();
    expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
  });

  it.each(['current', 'original'] as const)(
    'distinguishes the explicit initial %s source deferral from final and sanction checks',
    async (stage) => {
      const s = setup();
      const error = { response: { status: 404, data: {} } };
      if (stage === 'current') s.max.getExactMessageRow.mockRejectedValue(error);
      else s.originalLookup.mockRejectedValue(error);
      const request = { ...s.params, binding: s.binding };
      await expect(
        s.service.assertMessageStillActionable({ ...request, deletePhase: 'initial_unattempted' }),
      ).rejects.toMatchObject({
        name: 'MessageDuplicateInitialSourceUnavailableError',
        source: stage,
        cause: error,
      });
      await expect(
        s.service.assertMessageStillActionable({ ...request, deletePhase: 'recheck' }),
      ).rejects.toBe(error);
      await expect(s.service.assertMessageStillActionable(request)).rejects.toBe(error);
      expect(s.history.remove).not.toHaveBeenCalled();
      expect(s.history.invalidateLifecycle).not.toHaveBeenCalled();
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
      expect(s.metrics.record).not.toHaveBeenCalledWith('guard.absent');
      const sanction = full();
      sanction.max.getExactMessageRow.mockRejectedValue(error);
      await expect(
        sanction.service.assertMessageStillActionable({
          ...sanction.request,
          deletePhase: 'initial_unattempted',
        }),
      ).rejects.toBe(error);
    },
  );
  it.each(['current', 'original'] as const)(
    'classifies an unstructured initial %s GET 404 without changing source evidence or counters',
    async (stage) => {
      const s = setup();
      const error = { response: { status: 404, data: {} } };
      if (stage === 'current') s.max.getExactMessageRow.mockRejectedValue(error);
      else s.originalLookup.mockRejectedValue(error);
      await expect(s.service.qualify({ ...s.params, binding: s.binding })).rejects.toMatchObject({
        name: 'MessageDuplicateQualificationSourceUnavailableError',
        source: stage,
        cause: error,
      });
      expect(s.history.qualify).not.toHaveBeenCalled();
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
      expect(s.history.remove).not.toHaveBeenCalled();
      expect(s.history.invalidateLifecycle).not.toHaveBeenCalled();
      expect(s.history.observeLifecycle).not.toHaveBeenCalled();
      expect(s.metrics.record).toHaveBeenCalledWith(`guard.${stage}_lookup_unavailable`);
      expect(s.metrics.record).toHaveBeenCalledWith('guard.unavailable');
      expect(s.metrics.record).not.toHaveBeenCalledWith('guard.absent');
      expect(s.metrics.record).not.toHaveBeenCalledWith('guard.allowed');
      expect(s.metrics.recordGuardRejection).not.toHaveBeenCalled();
      await expect(
        s.service.assertMessageStillActionable({ ...s.params, binding: s.binding }),
      ).rejects.toBe(error);
      await expect(s.service.assertIntentStillActionable(s.params)).rejects.toBe(error);
    },
  );

  it.each(
    [
      { response: { status: 403, data: {} } },
      { response: { status: 500, data: {} } },
      new Error('transport unavailable'),
      Object.assign(new Error('ambiguous MAX mutation'), { response: { status: 404, data: {} } }),
      markMaxMemberMutationConfirmed({ response: { status: 404, data: {} } }),
      markMaxMemberMutationAttempted({ response: { status: 404, data: {} } }),
      markMaxMessageSendAttempted({ response: { status: 404, data: {} } }),
    ].flatMap((error) => (['current', 'original'] as const).map((stage) => ({ error, stage }))),
  )(
    'preserves initial $stage non-source or ambiguous failures ($error)',
    async ({ error, stage }) => {
      const s = setup();
      if (stage === 'current') s.max.getExactMessageRow.mockRejectedValue(error);
      else s.originalLookup.mockRejectedValue(error);
      await expect(s.service.qualify({ ...s.params, binding: s.binding })).rejects.toBe(error);
      await expect(
        s.service.assertMessageStillActionable({
          ...s.params,
          binding: s.binding,
          deletePhase: 'initial_unattempted',
        }),
      ).rejects.toBe(error);
      expect(s.history.qualify).not.toHaveBeenCalled();
      expect(s.history.remove).not.toHaveBeenCalled();
      expect(error).not.toBeInstanceOf(MessageDuplicateQualificationSourceUnavailableError);
      expect(error).not.toBeInstanceOf(MessageDuplicateInitialSourceUnavailableError);
    },
  );

  it.each(['current', 'original'] as const)(
    'preserves structured confirmed absence semantics for initial %s lookup',
    async (stage) => {
      const s = setup();
      const error = { response: { status: 404, data: { code: 'message.not.found' } } };
      if (stage === 'current') {
        s.max.getExactMessageRow.mockRejectedValue(error);
        await expect(s.service.qualify({ ...s.params, binding: s.binding })).resolves.toBeNull();
        expect(s.history.remove).not.toHaveBeenCalled();
      } else {
        s.originalLookup.mockRejectedValue(error);
        await expect(s.service.qualify({ ...s.params, binding: s.binding })).rejects.toMatchObject({
          code: 'message_duplicate_original_missing',
        });
        expect(s.history.remove).toHaveBeenCalledWith('-123', 'm1');
      }
      expect(s.history.qualify).not.toHaveBeenCalled();
      expect(s.metrics.record).toHaveBeenCalledWith(`guard.${stage}_lookup_confirmed_absent`);
      expect(s.metrics.record).not.toHaveBeenCalledWith('guard.unavailable');
    },
  );

  it.each(['qualification', 'qualification-retry', 'queued-delete', 'final-mutation'] as const)(
    'rejects a held original belonging to another participant at %s',
    async (stage) => {
      const s = setup();
      s.binding.original!.senderId = 'held-original-author';
      s.legacyHolds.isAnyMessageSourceHeld.mockResolvedValue(true);
      const action =
        stage === 'qualification'
          ? s.service.assertQualificationAuthority(s.params.chatId, s.binding)
          : stage === 'qualification-retry'
            ? s.service.qualify({ ...s.params, binding: s.binding })
            : stage === 'queued-delete'
              ? s.service.assertIntentStillActionable(s.params)
              : s.service.assertMessageStillActionable({ ...s.params, binding: s.binding });
      await expect(action).rejects.toThrow('message_duplicate_source_held');
      expect(s.legacyHolds.isAnyMessageSourceHeld).toHaveBeenCalledWith(s.params.chatId, [
        { messageId: 'm2', userId: '123' },
        { messageId: 'm1', userId: 'held-original-author' },
      ]);
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
      expect(s.max.getChatMemberAccess).not.toHaveBeenCalled();
      expect(s.history.qualify).not.toHaveBeenCalled();
    },
  );

  it('rechecks after remote content reads before consuming participant immunity', async () => {
    const s = setup();
    s.legacyHolds.isAnyMessageSourceHeld.mockResolvedValueOnce(false).mockResolvedValue(true);
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toThrow(
      'message_duplicate_source_held',
    );
    expect(s.max.getExactMessageRow).toHaveBeenCalled();
    expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
  });

  it('rechecks the source after the final mutation lease boundary', async () => {
    const s = setup();
    await expect(
      s.service.assertMessageStillActionable({
        ...s.params,
        binding: s.binding,
        beforeFinalAuthority: async () => {
          s.legacyHolds.isAnyMessageSourceHeld.mockResolvedValue(true);
        },
      }),
    ).rejects.toThrow('message_duplicate_source_held');
    expect(s.legacyHolds.isAnyMessageSourceHeld).toHaveBeenCalledTimes(3);
  });

  it('does not treat unavailable source hold evidence as permission', async () => {
    const s = setup();
    s.legacyHolds.isAnyMessageSourceHeld.mockRejectedValue(new Error('hold read unavailable'));
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toThrow(
      'hold read unavailable',
    );
    expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
    expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
  });
  it.each([
    { userId: null, isAdmin: false, isOwner: false },
    { userId: 'other', isAdmin: false, isOwner: false },
    { userId: '123', isAdmin: null, isOwner: false },
    { userId: '123', isAdmin: false, isOwner: null },
  ])('keeps unknown or foreign author access unavailable: %j', async (access) => {
    const s = setup();
    s.max.getChatMemberAccess.mockResolvedValue(access as never);
    await expect(
      s.service.assertMessageStillActionable({ ...s.params, binding: s.binding }),
    ).rejects.toThrow('author access unavailable');
    expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
  });
  it.each([
    ['STANDARD', {}],
    ['STRICT', { duplicateDetectionPreset: 'STRICT' }],
    ['CUSTOM_NEAR', { duplicateDetectionPreset: 'CUSTOM', duplicateNearMatchEnabled: true }],
    ['CUSTOM_PHONE', { duplicateDetectionPreset: 'CUSTOM', duplicateIgnorePhonesEnabled: true }],
  ] as const)(
    'revokes pre-unit %s jobs before qualification and delete',
    async (key, overrides) => {
      const s = setup();
      Object.assign(s.settings, overrides);
      for (const legacyDigest of [
        preSemanticUnitSettingsDigests[key],
        prePrefixUnitSettingsDigests[key],
        preElectricalUnitSettingsDigests[key],
      ]) {
        s.binding.settingsDigest = legacyDigest;
        await expect(s.service.qualify({ ...s.params, binding: s.binding })).rejects.toMatchObject({
          code: 'message_duplicate_settings_changed',
        });
        for (const authorityOnly of [false, true]) {
          await expect(
            s.service.assertIntentStillActionable({ ...s.params, authorityOnly }),
          ).rejects.toMatchObject({
            code: 'message_duplicate_settings_changed',
          });
        }
      }
      expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
      expect(s.history.qualify).not.toHaveBeenCalled();
    },
  );

  it.each(
    (['current', 'original'] as const).flatMap((stage) =>
      (['TEXT', 'MESSAGE'] as const).flatMap((mode) =>
        [
          ['100 MB/s', '100 Mb/s'],
          ['10 MΩ', '10 mΩ'],
          ['10 MWh', '10 mWh'],
          ['MAh: 10', 'mAh: 10'],
          ['MVA²: 10', 'mVA²: 10'],
          ['10 Mvar/V', '10 mvar/V'],
          ['10 МВтч', '10 мВтч'],
          ['МАч: 10', 'мАч: 10'],
          ['MΩ: 10', 'mΩ: 10'],
          ['MΩ²: 10', 'mΩ²: 10'],
          ['MΩ⁺²: 10', 'mΩ⁺²: 10'],
          ['MΩ³/V: 10', 'mΩ³/V: 10'],
          ['(MB): 100', '(Mb): 100'],
          ['MB/s — 100', 'Mb/s — 100'],
        ].map(([first, second]) => ({ stage, mode, first, second })),
      ),
    ),
  )(
    'revokes $mode evidence after a $stage unit-case edit $first → $second',
    async ({ stage, mode, first, second }) => {
      const s = setup();
      s.settings.duplicateCompareMode = mode;
      s.binding.compareMode = mode;
      s.binding.settingsDigest = messageDuplicateSettingsDigest(s.settings);
      const update = (mid: string, unit: string) =>
        duplicateUpdate(mid, s.binding.eventTimestampMs, `Параметр устройства составляет ${unit}`);
      const recorded = update('m2', first!);
      const content = extractDuplicateMessageContent(recorded.raw);
      s.binding.sourceDigest = duplicateSourceDigest(content, mode);
      s.binding.contentDigest = buildMessageDuplicateIdentity(content, mode)!;
      Object.assign(s.binding.original!, {
        sourceDigest: s.binding.sourceDigest,
        contentDigest: s.binding.contentDigest,
      });
      s.max.getExactMessageRow.mockResolvedValue((recorded.raw as { message: unknown }).message);
      s.originalLookup.mockResolvedValue(
        (update('m1', first!).raw as { message: typeof s.originalRaw }).message,
      );
      await expect(s.service.assertIntentStillActionable(s.params)).resolves.toBe('allowed');
      const changed = (
        update(stage === 'current' ? 'm2' : 'm1', second!).raw as { message: typeof s.originalRaw }
      ).message;
      if (stage === 'current') s.max.getExactMessageRow.mockResolvedValue(changed);
      else s.originalLookup.mockResolvedValue(changed);
      await expect(s.service.qualify({ ...s.params, binding: s.binding })).rejects.toMatchObject({
        code:
          stage === 'current'
            ? 'message_duplicate_content_changed'
            : 'message_duplicate_original_changed',
      });
      await expect(s.service.assertIntentStillActionable(s.params)).rejects.toMatchObject({
        code:
          stage === 'current'
            ? 'message_duplicate_content_changed'
            : 'message_duplicate_original_changed',
      });
      expect(s.history.invalidateLifecycle).toHaveBeenCalledWith({
        chatId: s.params.chatId,
        messageId: stage === 'current' ? 'm2' : 'm1',
        content: expect.anything(),
      });
      expect(s.history.qualify).not.toHaveBeenCalled();
    },
  );
  it.each(['STANDARD', 'STRICT', 'CUSTOM_NEAR', 'CUSTOM_PHONE', 'IMAGE'] as const)(
    'revokes a pre-v3 %s grant at qualification and both delete boundaries',
    async (preset) => {
      const s = setup();
      Object.assign(s.settings, {
        duplicateDetectionPreset: preset.startsWith('CUSTOM')
          ? 'CUSTOM'
          : preset === 'IMAGE'
            ? 'STANDARD'
            : preset,
        duplicateNearMatchEnabled: preset === 'CUSTOM_NEAR',
        duplicateIgnorePhonesEnabled: preset === 'CUSTOM_PHONE',
      });
      if (preset === 'IMAGE') {
        Object.assign(s.binding, {
          compareMode: 'IMAGE',
          enforcementScope: 'full',
          imageScope: 'SAME_AUTHOR',
          hasPhotos: true,
          mediaHashes: ['a'.repeat(64)],
        });
        s.binding.original!.mediaHashes = [...s.binding.mediaHashes];
        s.policy.resolve.mockResolvedValue({
          mode: 'full',
          revision: 1,
          effectiveAtMs: Date.now() - 10000,
          expiresAtMs: Date.now() + 3600000,
        });
      }
      s.binding.settingsDigest = preV3HistorySettingsDigests[preset];
      await expect(
        s.service.assertQualificationAuthority(s.params.chatId, s.binding),
      ).rejects.toMatchObject({ code: 'message_duplicate_settings_changed' });
      for (const authorityOnly of [false, true]) {
        await expect(
          s.service.assertIntentStillActionable({ ...s.params, authorityOnly }),
        ).rejects.toMatchObject({ code: 'message_duplicate_settings_changed' });
      }
      expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
      expect(s.max.getChatMemberAccess).not.toHaveBeenCalled();
      expect(s.history.qualify).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['STRICT', { duplicateDetectionPreset: 'STRICT' }],
    ['CUSTOM_NEAR', { duplicateDetectionPreset: 'CUSTOM', duplicateNearMatchEnabled: true }],
    ['CUSTOM_PHONE', { duplicateDetectionPreset: 'CUSTOM', duplicateIgnorePhonesEnabled: true }],
  ] as const)(
    'rejects previous %s grants before qualification and MAX dispatch',
    async (key, overrides) => {
      const s = setup();
      Object.assign(s.settings, overrides);
      for (const digests of [
        preSafeTextSettingsDigests,
        preBoundedPhoneSettingsDigests,
        prePhoneBoundarySettingsDigests,
        preSourceBoundPhoneSettingsDigests,
        preV3HistorySettingsDigests,
      ]) {
        s.binding.settingsDigest = digests[key];
        await expect(
          s.service.assertQualificationAuthority(s.params.chatId, s.binding),
        ).rejects.toMatchObject({
          code: 'message_duplicate_settings_changed',
        });
        for (const authorityOnly of [false, true]) {
          await expect(
            s.service.assertIntentStillActionable({ ...s.params, authorityOnly }),
          ).rejects.toMatchObject({
            code: 'message_duplicate_settings_changed',
          });
        }
      }
      expect(s.max.getChatMemberAccess).not.toHaveBeenCalled();
      expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
      expect(s.history.qualify).not.toHaveBeenCalled();
    },
  );

  it.each(['STRICT', 'CUSTOM'] as const)(
    'rejects stored pre-Unicode %s grants at both dispatch boundaries',
    async (preset) => {
      const s = setup();
      s.settings.duplicateDetectionPreset = preset;
      s.settings.duplicateNearMatchEnabled = true;
      s.binding.settingsDigest = preUnicodeNearSettingsDigests[preset];
      for (const authorityOnly of [false, true]) {
        await expect(
          s.service.assertIntentStillActionable({ ...s.params, authorityOnly }),
        ).rejects.toMatchObject({
          code: 'message_duplicate_settings_changed',
        });
      }
      expect(s.max.getChatMemberAccess).not.toHaveBeenCalled();
      expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
      expect(s.history.qualify).not.toHaveBeenCalled();
    },
  );

  it.each([1, 2] as const)('rejects legacy binding v%i before any MAX lookup', async (version) => {
    const s = setup();
    s.binding.version = version;
    delete s.binding.enforcementScope;
    delete s.binding.lifecycleRevision;
    delete s.binding.policyRevision;
    delete s.binding.original!.revision;
    delete s.binding.original!.originalId;
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toThrow(
      'message_duplicate_binding_invalid',
    );
    expect(s.max.getChatMemberAccess).not.toHaveBeenCalled();
    expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
  });

  it('blocks a persisted decision after its authorization is revoked', async () => {
    const s = setup();
    s.authorization.isAllowed.mockResolvedValue(false);
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toThrow(
      /message_duplicate_/,
    );
    expect(s.max.getChatMemberAccess).not.toHaveBeenCalled();
    expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
  });

  it('rechecks authorization after external content and participant checks', async () => {
    const s = setup();
    s.max.getExactMessageRow.mockImplementation(async () => {
      s.authorization.isAllowed.mockResolvedValue(false);
      return (duplicateUpdate('m2', s.binding.eventTimestampMs).raw as { message: unknown })
        .message;
    });
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toThrow(
      /message_duplicate_/,
    );
    expect(s.authorization.isAllowed.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(s.history.stillMatches).toHaveBeenCalled();
  });

  it('rejects a returned settings value with a newer policy revision', async () => {
    const s = setup();
    s.settings.duplicatePolicyRevision += 2;
    expect(messageDuplicateSettingsDigest(s.settings)).toBe(s.binding.settingsDigest);
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toThrow(
      'message_duplicate_settings_changed',
    );
    expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
  });

  it('reuses a qualified stage only while its current authorization remains allowed', async () => {
    const s = setup();
    s.history.qualified.mockResolvedValue(1);
    const request = { ...s.params, binding: s.binding };
    await expect(s.service.qualify(request)).resolves.toBe(1);
    expect(s.history.qualify).not.toHaveBeenCalled();
    s.authorization.isAllowed.mockResolvedValue(false);
    await expect(s.service.qualify(request)).rejects.toThrow(/message_duplicate_/);
    expect(s.history.qualify).not.toHaveBeenCalled();
  });

  it('rejects revoked history before unavailable MAX reads during initial qualification', async () => {
    const s = setup();
    s.history.stillMatches.mockResolvedValue(false);
    s.max.getChatMemberAccess.mockRejectedValue(new Error('MAX unavailable'));
    await expect(s.service.qualify({ ...s.params, binding: s.binding })).rejects.toMatchObject({
      code: 'message_duplicate_history_changed',
    });
    expect(s.max.getChatMemberAccess).not.toHaveBeenCalled();
    expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
    expect(s.originalLookup).not.toHaveBeenCalled();
    expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
    expect(s.history.qualify).not.toHaveBeenCalled();
  });

  it('preserves unavailable history as retryable without consulting MAX', async () => {
    const s = setup();
    const failure = new Error('Redis unavailable');
    s.history.stillMatches.mockRejectedValue(failure);
    await expect(s.service.qualify({ ...s.params, binding: s.binding })).rejects.toBe(failure);
    expect(s.max.getChatMemberAccess).not.toHaveBeenCalled();
    expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
    expect(s.history.qualify).not.toHaveBeenCalled();
  });

  it('rechecks history revoked during external qualification reads before reserving a stage', async () => {
    const s = setup();
    s.max.getExactMessageRow.mockImplementation(async () => {
      s.history.stillMatches.mockResolvedValue(false);
      return (duplicateUpdate('m2', s.binding.eventTimestampMs).raw as { message: unknown })
        .message;
    });
    await expect(s.service.qualify({ ...s.params, binding: s.binding })).rejects.toMatchObject({
      code: 'message_duplicate_history_changed',
    });
    expect(s.max.getExactMessageRow).toHaveBeenCalled();
    expect(s.history.qualify).not.toHaveBeenCalled();
  });

  it('does not reserve a stage after revocation or policy changes during qualification', async () => {
    for (const change of ['authorization', 'settings', 'history']) {
      const s = setup();
      if (change === 'authorization') s.authorization.isAllowed.mockResolvedValue(false);
      if (change === 'settings') s.settings.duplicatePolicyRevision += 1;
      if (change === 'history') s.history.stillMatches.mockResolvedValue(false);
      await expect(s.service.qualify({ ...s.params, binding: s.binding })).rejects.toThrow(
        /message_duplicate_/,
      );
      expect(s.history.qualify).not.toHaveBeenCalled();
    }
  });

  it('invalidates a changed original without inventing its edit timestamp', async () => {
    const s = setup();
    const original = s.originalRaw as { body: { text: string } };
    original.body.text = 'Changed remotely';
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toThrow(
      'message_duplicate_original_changed',
    );
    expect(s.history.invalidateLifecycle).toHaveBeenCalledWith({
      chatId: s.params.chatId,
      messageId: s.binding.original!.messageId,
      content: expect.objectContaining({ text: 'changed remotely' }),
    });
    expect(s.history.observeLifecycle).not.toHaveBeenCalled();
  });

  it.each(
    (['current', 'original'] as const).flatMap((stage) =>
      (['TEXT', 'MESSAGE'] as const).map((mode) => ({ stage, mode })),
    ),
  )(
    'revokes $mode evidence when the $stage hidden links swap visible ranges',
    async ({ stage, mode }) => {
      const s = setup();
      s.settings.duplicateCompareMode = mode;
      s.binding.compareMode = mode;
      s.binding.settingsDigest = messageDuplicateSettingsDigest(s.settings);
      const linked = (messageId: string, swapped = false) => {
        const update = duplicateUpdate(messageId, s.binding.eventTimestampMs, 'Первый второй');
        const raw = (update.raw as { message: { body: Record<string, unknown> } }).message;
        raw.body.markup = [
          {
            type: 'link',
            from: 0,
            length: 6,
            url: `https://example.org/${swapped ? 'second' : 'first'}`,
          },
          {
            type: 'link',
            from: 7,
            length: 6,
            url: `https://example.org/${swapped ? 'first' : 'second'}`,
          },
        ];
        return update;
      };
      const recorded = linked('m2');
      const content = extractDuplicateMessageContent(recorded.raw);
      s.binding.sourceDigest = duplicateSourceDigest(content, mode);
      s.binding.contentDigest = buildMessageDuplicateIdentity(content, mode)!;
      Object.assign(s.binding.original!, {
        sourceDigest: s.binding.sourceDigest,
        contentDigest: s.binding.contentDigest,
      });
      s.max.getExactMessageRow.mockResolvedValue((recorded.raw as { message: unknown }).message);
      s.originalLookup.mockResolvedValue(
        (linked('m1').raw as { message: typeof s.originalRaw }).message,
      );
      await expect(s.service.assertIntentStillActionable(s.params)).resolves.toBe('allowed');

      const changedUpdate = linked(stage === 'current' ? 'm2' : 'm1', true);
      const changedContent = extractDuplicateMessageContent(changedUpdate.raw);
      expect(changedContent.text).toBe(content.text);
      const targetSet = (value: typeof content) =>
        value.navigationTargets.map((target) => target.normalizedTarget).sort();
      expect(targetSet(changedContent)).toEqual(targetSet(content));
      const changed = (changedUpdate.raw as { message: typeof s.originalRaw }).message;
      if (stage === 'current') s.max.getExactMessageRow.mockResolvedValue(changed);
      else s.originalLookup.mockResolvedValue(changed);
      await expect(s.service.assertIntentStillActionable(s.params)).rejects.toMatchObject({
        code:
          stage === 'current'
            ? 'message_duplicate_content_changed'
            : 'message_duplicate_original_changed',
      });
      expect(s.history.invalidateLifecycle).toHaveBeenCalledWith({
        chatId: s.params.chatId,
        messageId: stage === 'current' ? 'm2' : 'm1',
        content: expect.objectContaining({ text: content.text }),
      });
      expect(s.history.remove).not.toHaveBeenCalled();
      expect(s.history.observeLifecycle).not.toHaveBeenCalled();
    },
  );

  it('rejects queued thumbnail-era evidence before any MAX lookup', async () => {
    const s = setup();
    Object.assign(s.binding, { mediaVersion: 'sha256-v1:sharp-rgb512-pdq-v2' });
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toMatchObject({
      code: 'message_duplicate_binding_invalid',
    });
    expect(s.max.getChatMemberAccess).not.toHaveBeenCalled();
    expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
  });

  it('ends enforcement for a confirmed departed author without retrying or applying immunity', async () => {
    const s = setup();
    s.max.getChatMemberAccess.mockResolvedValue(null);
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toMatchObject({
      name: 'MessageDuplicateGuardRejectedError',
      code: 'message_duplicate_author_not_member',
    });
    expect(s.max.getChatMemberAccess).toHaveBeenCalledWith(
      '-123',
      '123',
      expect.objectContaining({ bypassCache: true }),
    );
    expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
    expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
    expect(s.metrics.recordGuardRejection).toHaveBeenCalledWith(
      'message_duplicate_author_not_member',
    );
  });

  it.each(['transport', 'malformed', 'mismatched'])(
    'keeps %s author access failures retryable',
    async (kind) => {
      const s = setup();
      if (kind === 'mismatched')
        s.max.getChatMemberAccess.mockResolvedValue({
          userId: '456',
          isAdmin: false,
          isOwner: false,
        });
      else s.max.getChatMemberAccess.mockRejectedValue(new Error(kind));
      const failure = await s.service
        .assertIntentStillActionable(s.params)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure).not.toBeInstanceOf(MessageDuplicateGuardRejectedError);
      expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
      expect(s.metrics.record).toHaveBeenCalledWith('guard.unavailable');
      expect(s.metrics.recordGuardRejection).not.toHaveBeenCalled();
    },
  );

  it('still expires a duplicate at its own absolute enforcement deadline', async () => {
    const s = setup();
    s.binding.eventTimestampMs = Date.now() - 3_600_001;
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toThrow(
      'message_duplicate_policy_changed',
    );
    expect(s.max.getChatMemberAccess).not.toHaveBeenCalled();
  });
  it('does not execute delayed deletion after the original window expires', async () => {
    const s = setup();
    s.binding.original!.expiresAtMs = Date.now() - 1;
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toThrow('policy_changed');
    expect(s.max.getChatMemberAccess).not.toHaveBeenCalled();
  });

  it('rejects historical rolling-window intents that lack original evidence', async () => {
    const s = setup();
    delete s.binding.original;
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toThrow(
      'binding_invalid',
    );
    expect(s.max.getChatMemberAccess).not.toHaveBeenCalled();
  });

  it('allows a renewed photo URL with verified content, but rejects a replacement photo', async () => {
    const s = setup();
    s.binding.enforcementScope = 'full';
    s.binding.hasPhotos = true;
    s.binding.compareMode = 'IMAGE';
    s.binding.imageScope = 'SAME_AUTHOR';
    s.binding.settingsDigest = exactImageSettingsDigest(s.settings);
    s.binding.mediaHashes = ['c'.repeat(64)];
    s.policy.resolve.mockResolvedValue({
      mode: 'full',
      revision: 1,
      effectiveAtMs: Date.now() - 10000,
    });
    const image = (id: string, url: string) =>
      duplicateUpdate('m2', s.binding.eventTimestampMs, '', [
        { type: 'image', payload: { photo_id: id, url } },
      ]);
    const original = image('photo', 'https://i.oneme.ru/old');
    const content = extractDuplicateMessageContent(original.raw);
    s.binding.sourceDigest = exactImageSourceDigest(content);
    s.binding.contentDigest = buildMessageDuplicateIdentity(
      content,
      'IMAGE',
      s.binding.mediaHashes,
    )!;
    const originalImage = (original.raw as { message: Record<string, unknown> }).message;
    Object.assign(s.binding.original!, {
      sourceDigest: s.binding.sourceDigest,
      contentDigest: s.binding.contentDigest,
      mediaHashes: s.binding.mediaHashes,
    });
    Object.assign(s.originalRaw as object, originalImage, {
      body: { ...(originalImage.body as object), mid: 'm1' },
    });
    const renewed = image('photo', 'https://i.oneme.ru/new');
    s.max.getExactMessageRow.mockResolvedValue((renewed.raw as { message: unknown }).message);
    await expect(s.service.assertIntentStillActionable(s.params)).resolves.toBe('allowed');
    expect(s.photos.resolveEffectivePolicy).not.toHaveBeenCalled();
    const replaced = image('different', 'https://i.oneme.ru/new');
    s.max.getExactMessageRow.mockResolvedValue((replaced.raw as { message: unknown }).message);
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toThrow(
      'content_changed',
    );
  });

  it.each(
    (['current', 'original'] as const).flatMap((stage) =>
      (['link', 'callback'] as const).map((type) => ({ stage, type })),
    ),
  )(
    'revokes IMAGE evidence after the $stage keyboard $type action changes',
    async ({ stage, type }) => {
      const s = setup();
      s.settings.duplicatePhotoScope = 'SAME_AUTHOR';
      Object.assign(s.binding, {
        enforcementScope: 'full',
        hasPhotos: true,
        compareMode: 'IMAGE',
        imageScope: 'SAME_AUTHOR',
        settingsDigest: exactImageSettingsDigest(s.settings),
        mediaHashes: ['c'.repeat(64)],
      });
      s.policy.resolve.mockResolvedValue({
        mode: 'full',
        revision: 1,
        effectiveAtMs: Date.now() - 10000,
        expiresAtMs: Number.MAX_SAFE_INTEGER,
      });
      const image = (messageId: string, action: string) =>
        duplicateUpdate(messageId, s.binding.eventTimestampMs, 'caption', [
          { type: 'image', payload: { photo_id: 'photo', url: 'https://i.oneme.ru/photo' } },
          {
            type: 'inline_keyboard',
            payload: {
              buttons: [
                [
                  {
                    type,
                    text: 'Open',
                    ...(type === 'link'
                      ? { url: `https://example.org/${action}` }
                      : { payload: action }),
                  },
                ],
              ],
            },
          },
        ]);
      const recorded = image('m2', 'recorded-action');
      const content = extractDuplicateMessageContent(recorded.raw);
      s.binding.sourceDigest = exactImageSourceDigest(content);
      s.binding.contentDigest = buildMessageDuplicateIdentity(
        content,
        'IMAGE',
        s.binding.mediaHashes,
      )!;
      Object.assign(s.binding.original!, {
        sourceDigest: s.binding.sourceDigest,
        contentDigest: s.binding.contentDigest,
        mediaHashes: s.binding.mediaHashes,
      });
      s.max.getExactMessageRow.mockResolvedValue((recorded.raw as { message: unknown }).message);
      s.originalLookup.mockResolvedValue(
        (image('m1', 'recorded-action').raw as { message: typeof s.originalRaw }).message,
      );
      await expect(s.service.assertIntentStillActionable(s.params)).resolves.toBe('allowed');

      const changed = (
        image(stage === 'current' ? 'm2' : 'm1', 'new-action').raw as {
          message: typeof s.originalRaw;
        }
      ).message;
      if (stage === 'current') s.max.getExactMessageRow.mockResolvedValue(changed);
      else s.originalLookup.mockResolvedValue(changed);
      await expect(s.service.assertIntentStillActionable(s.params)).rejects.toMatchObject({
        code:
          stage === 'current'
            ? 'message_duplicate_content_changed'
            : 'message_duplicate_original_changed',
      });
      expect(s.history.invalidateLifecycle).toHaveBeenCalledWith({
        chatId: s.params.chatId,
        messageId: stage === 'current' ? 'm2' : 'm1',
        content: expect.objectContaining({ complete: true, actions: expect.any(Array) }),
      });
      expect(s.history.remove).not.toHaveBeenCalled();
      expect(s.history.observeLifecycle).not.toHaveBeenCalled();
    },
  );

  function full() {
    const s = setup();
    s.policy.resolve.mockResolvedValue({
      mode: 'full',
      revision: 1,
      effectiveAtMs: Date.now() - 10000,
      expiresAtMs: Number.MAX_SAFE_INTEGER,
    });
    s.settings.duplicateBanEnabled = true;
    s.settings.duplicateBanMaxCount = 1;
    s.binding.enforcementScope = 'full';
    s.binding.sanction = {
      action: 'BAN',
      repeatCount: 1,
      threshold: 1,
      settingsDigest: messageDuplicateSanctionSettingsDigest(s.settings),
    };
    s.binding.settingsDigest = messageDuplicateSettingsDigest(s.settings);
    return { ...s, request: { ...s.params, binding: s.binding, sanctionIntentId: 'intent' } };
  }
  function ownDeleteReceipt(s: ReturnType<typeof full>) {
    return {
      id: 'intent',
      status: 'SUCCEEDED',
      chatId: s.params.chatId,
      messageId: s.params.messageId,
      subjectUserId: s.binding.senderId,
      succeededBotId: 'peer',
      remoteDeleteSucceededBotId: 'peer',
      remoteDeleteSucceededAt: new Date(),
      reasons: [
        {
          reasonKey: `MESSAGE_DUPLICATE:v1:${s.binding.eventTimestampMs}`,
          ruleCode: 'DUPLICATE_DELETE',
          userId: s.binding.senderId,
          createdAt: new Date(Date.now() - 500),
          metadata: {
            duplicateSource: 'message_v1',
            messageDuplicate: structuredClone(s.binding),
            moderationDeleteVerified: true,
          },
        },
      ],
    };
  }

  it.each(['missing', 'pending', 'unverified'])(
    'declines initial sanction with a visible source and %s DELETE proof',
    async (kind) => {
      const s = full();
      const receipt = ownDeleteReceipt(s);
      if (kind === 'pending') receipt.status = 'IN_PROGRESS';
      if (kind === 'unverified') receipt.reasons[0]!.metadata.moderationDeleteVerified = false;
      s.prisma.moderationDeleteIntent.findUnique.mockResolvedValue(
        kind === 'missing' ? null : receipt,
      );
      const before = structuredClone(receipt);
      const finalAuthority = jest.fn();
      await expect(
        s.service.assertMessageStillActionable({
          ...s.request,
          sanctionPhase: 'initial_unattempted',
          beforeFinalAuthority: finalAuthority,
        }),
      ).rejects.toBeInstanceOf(MessageDuplicateGuardRejectedError);
      expect(finalAuthority).not.toHaveBeenCalled();
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
      expect(receipt).toEqual(before);
      expect(s.history.remove).not.toHaveBeenCalled();
      expect(s.metrics.record).not.toHaveBeenCalledWith('guard.current_lookup_confirmed_absent');
    },
  );

  it('checks returned current content even after confirming the initial sanction DELETE receipt', async () => {
    const s = full();
    s.prisma.moderationDeleteIntent.findUnique.mockResolvedValue(ownDeleteReceipt(s));
    const request = { ...s.request, sanctionPhase: 'initial_unattempted' as const };
    await expect(s.service.assertMessageStillActionable(request)).resolves.toBe('allowed');
    s.max.getExactMessageRow.mockResolvedValue({
      ...(duplicateUpdate().raw as { message: Record<string, unknown> }).message,
      body: { mid: s.binding.messageId, text: 'Changed live source' },
    });
    await expect(s.service.assertMessageStillActionable(request)).rejects.toMatchObject({
      code: 'message_duplicate_content_changed',
    });
  });

  it.each([{}, { code: 'not.found' }, { error: { code: 'not.found' } }])(
    'uses an exact own DELETE receipt after an unavailable current GET 404 (%j) without claiming absence',
    async (body) => {
      const s = full();
      const error = { response: { status: 404, data: body } };
      s.max.getExactMessageRow.mockRejectedValue(error);
      s.prisma.moderationDeleteIntent.findUnique.mockResolvedValue(ownDeleteReceipt(s));
      const finalAuthority = jest.fn();
      await expect(
        s.service.assertMessageStillActionable({
          ...s.request,
          beforeFinalAuthority: finalAuthority,
        }),
      ).resolves.toBe('allowed');
      expect(s.originalLookup).toHaveBeenCalledTimes(1);
      expect(finalAuthority).toHaveBeenCalledTimes(1);
      expect(s.history.stillMatches).toHaveBeenCalledWith(s.params.chatId, s.binding, true);
      expect(s.metrics.record).not.toHaveBeenCalledWith('guard.current_lookup_confirmed_absent');
      expect(s.metrics.record).not.toHaveBeenCalledWith('guard.absent');
      expect(s.history.remove).not.toHaveBeenCalled();
      expect(s.history.invalidateLifecycle).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['receipt', 'receipt_missing'],
    ['confirmation', 'delete_unconfirmed'],
    ['reason', 'reason_missing'],
    ['verified', 'reason_unverified'],
    ['late_reason', 'reason_after_delete'],
    ['chat', 'chat_mismatch'],
    ['message', 'message_mismatch'],
    ['subject', 'subject_mismatch'],
    ['binding', 'binding_invalid'],
    ['content', 'content_mismatch'],
    ['time', 'event_time_mismatch'],
    ['control', 'control_revision_mismatch'],
    ['settings', 'settings_mismatch'],
    ['version', 'version_mismatch'],
    ['scope', 'scope_mismatch'],
    ['lifecycle', 'lifecycle_revision_mismatch'],
    ['policy', 'policy_revision_mismatch'],
    ['authorization', 'authorization_mismatch'],
    ['sanction', 'sanction_mismatch'],
    ['original', 'original_mismatch'],
  ])(
    'reports a fixed %s proof detail while retaining the exact failed sanction',
    async (change, detail) => {
      const s = full();
      const error = Object.freeze({ response: { status: 404, data: {} }, private: 'secret' });
      const receipt = ownDeleteReceipt(s);
      const reason = receipt.reasons[0]!;
      const recorded = reason.metadata.messageDuplicate;
      if (change === 'confirmation') Object.assign(receipt, { remoteDeleteSucceededAt: null });
      if (change === 'reason') receipt.reasons = [];
      if (change === 'verified') reason.metadata.moderationDeleteVerified = false;
      if (change === 'late_reason') reason.createdAt = new Date(Date.now() + 1000);
      if (change === 'chat') receipt.chatId = 'another';
      if (change === 'message') receipt.messageId = 'another';
      if (change === 'subject') receipt.subjectUserId = 'another';
      if (change === 'binding') Object.assign(reason.metadata, { messageDuplicate: {} });
      if (change === 'content') recorded.contentDigest = '1'.repeat(64);
      if (change === 'time') recorded.eventTimestampMs += 1;
      if (change === 'control') recorded.controlRevision += 1;
      if (change === 'settings') recorded.settingsDigest = '2'.repeat(64);
      if (change === 'version') recorded.version = 2;
      if (change === 'scope') {
        recorded.enforcementScope = 'delete_only';
        delete recorded.sanction;
      }
      if (change === 'lifecycle') recorded.lifecycleRevision = 'e'.repeat(64);
      if (change === 'policy') recorded.policyRevision = recorded.policyRevision! + 1;
      if (change === 'authorization') recorded.authorization!.deadlineAtMs -= 1;
      if (change === 'sanction') recorded.sanction!.repeatCount += 1;
      if (change === 'original') recorded.original!.sourceDigest = '3'.repeat(64);
      const before = structuredClone(receipt);
      s.max.getExactMessageRow.mockRejectedValue(error);
      s.prisma.moderationDeleteIntent.findUnique.mockResolvedValue(
        change === 'receipt' ? null : receipt,
      );
      await expect(s.service.assertMessageStillActionable(s.request)).rejects.toBe(error);
      expect(readModerationGuardFailure(error)).toEqual({
        guardBoundary: 'duplicate_sanction_final',
        guardProofFailure: 'own_delete_binding_unproven',
        guardProofDetail: detail,
      });
      expect(JSON.stringify(readModerationGuardFailure(error))).not.toContain('secret');
      expect(s.originalLookup).not.toHaveBeenCalled();
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
      expect(s.history.remove).not.toHaveBeenCalled();
      expect(s.history.invalidateLifecycle).not.toHaveBeenCalled();
      expect(receipt).toEqual(before);
    },
  );

  it.each(['missing', 'unfinished', 'unverified'] as const)(
    'declines only the initial sanction on unavailable current source and a %s receipt',
    async (kind) => {
      const s = full();
      const error = { response: { status: 404, data: {} } };
      const receipt = ownDeleteReceipt(s);
      if (kind === 'unfinished') receipt.status = 'AMBIGUOUS';
      if (kind === 'unverified') receipt.reasons[0]!.metadata.moderationDeleteVerified = false;
      const before = structuredClone(receipt);
      s.max.getExactMessageRow.mockRejectedValue(error);
      s.prisma.moderationDeleteIntent.findUnique.mockResolvedValue(
        kind === 'missing' ? null : receipt,
      );
      await expect(
        s.service.assertMessageStillActionable({
          ...s.request,
          sanctionPhase: 'initial_unattempted',
        }),
      ).rejects.toMatchObject({
        name: 'MessageDuplicateGuardRejectedError',
        code: 'message_duplicate_sanction_source_unavailable',
      });
      expect(s.originalLookup).not.toHaveBeenCalled();
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
      expect(s.metrics.record).not.toHaveBeenCalledWith('guard.current_lookup_confirmed_absent');
      expect(s.metrics.record).not.toHaveBeenCalledWith('guard.absent');
      expect(s.history.remove).not.toHaveBeenCalled();
      expect(s.history.invalidateLifecycle).not.toHaveBeenCalled();
      expect(receipt).toEqual(before);
      expect(readModerationGuardFailure(error)).toMatchObject({
        guardBoundary: 'duplicate_sanction_initial',
        guardProofFailure:
          kind === 'unfinished'
            ? 'own_delete_sanction_receipt_unproven'
            : 'own_delete_binding_unproven',
      });
      await expect(s.service.assertMessageStillActionable(s.request)).rejects.toBe(error);
    },
  );

  it('retains exact successful DELETE authority at the initial sanction boundary', async () => {
    const s = full();
    s.max.getExactMessageRow.mockRejectedValue({ response: { status: 404, data: {} } });
    s.prisma.moderationDeleteIntent.findUnique.mockResolvedValue(ownDeleteReceipt(s));
    await expect(
      s.service.assertMessageStillActionable({
        ...s.request,
        sanctionPhase: 'initial_unattempted',
      }),
    ).resolves.toBe('allowed');
    expect(s.originalLookup).toHaveBeenCalledTimes(1);
    expect(s.history.stillMatches).toHaveBeenCalled();
  });

  it.each(['original', 'access', 'server', 'send', 'member'] as const)(
    'preserves %s failures even at initial sanction authorization',
    async (kind) => {
      const s = full();
      const error = {
        response: {
          status: kind === 'server' ? 500 : 404,
          data: kind === 'access' ? { code: 'chat.denied' } : {},
        },
      };
      if (kind === 'send') markMaxMessageSendAttempted(error);
      if (kind === 'member') markMaxMemberMutationAttempted(error);
      s.max.getExactMessageRow.mockRejectedValue(
        kind === 'original' ? { response: { status: 404, data: {} } } : error,
      );
      if (kind === 'original') s.originalLookup.mockRejectedValue(error);
      s.prisma.moderationDeleteIntent.findUnique.mockResolvedValue(ownDeleteReceipt(s));
      await expect(
        s.service.assertMessageStillActionable({
          ...s.request,
          sanctionPhase: 'initial_unattempted',
        }),
      ).rejects.toBe(error);
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['id', 'intent_mismatch'],
    ['status', 'receipt_unfinished'],
    ['bot', 'executor_mismatch'],
    ['missing_bot', 'executor_missing'],
    ['unknown_bot', 'executor_unregistered'],
    ['publisher_bot', 'executor_unregistered'],
    ['reason_key', 'reason_key_mismatch'],
    ['rule', 'reason_rule_mismatch'],
    ['reason_user', 'reason_user_mismatch'],
    ['verified', 'reason_unverified'],
    ['late_reason', 'reason_after_delete'],
    ['invalid_receipt_clock', 'receipt_clock_invalid'],
    ['invalid_reason_clock', 'reason_clock_invalid'],
    ['future_receipt_clock', 'receipt_clock_future'],
    ['source_digest', 'binding_mismatch'],
    ['fingerprint', 'binding_mismatch'],
    ['compare_mode', 'binding_mismatch'],
    ['media_hashes', 'binding_mismatch'],
  ])(
    'preserves the bare current 404 when own DELETE receipt has changed %s',
    async (change, detail) => {
      const s = full();
      const error = { response: { status: 404, data: {} } };
      const receipt = ownDeleteReceipt(s);
      const reason = receipt.reasons[0]!;
      if (change === 'id') receipt.id = 'another';
      if (change === 'status') receipt.status = 'AMBIGUOUS';
      if (change === 'bot') receipt.succeededBotId = 'bot';
      if (change === 'missing_bot') Object.assign(receipt, { remoteDeleteSucceededBotId: null });
      if (change === 'unknown_bot')
        receipt.succeededBotId = receipt.remoteDeleteSucceededBotId = 'unknown';
      if (change === 'publisher_bot')
        receipt.succeededBotId = receipt.remoteDeleteSucceededBotId = 'id613002203036_2_bot';
      if (change === 'reason_key') reason.reasonKey = 'another';
      if (change === 'rule') reason.ruleCode = 'OTHER_DELETE';
      if (change === 'reason_user') reason.userId = 'other';
      if (change === 'invalid_receipt_clock') receipt.remoteDeleteSucceededAt = new Date(NaN);
      if (change === 'invalid_reason_clock') reason.createdAt = new Date(NaN);
      if (change === 'future_receipt_clock')
        receipt.remoteDeleteSucceededAt = new Date(Date.now() + 1000);
      if (change === 'verified') reason.metadata.moderationDeleteVerified = false;
      if (change === 'late_reason') reason.createdAt = new Date(Date.now() + 1000);
      if (change === 'source_digest')
        reason.metadata.messageDuplicate.sourceDigest = '1'.repeat(64);
      if (change === 'fingerprint') reason.metadata.messageDuplicate.fingerprint = '2'.repeat(64);
      if (change === 'compare_mode') reason.metadata.messageDuplicate.compareMode = 'TEXT';
      if (change === 'media_hashes')
        reason.metadata.messageDuplicate.mediaHashes = ['3'.repeat(64)];
      s.max.getExactMessageRow.mockRejectedValue(error);
      s.prisma.moderationDeleteIntent.findUnique.mockResolvedValue(receipt);
      await expect(s.service.assertMessageStillActionable(s.request)).rejects.toBe(error);
      expect(s.originalLookup).not.toHaveBeenCalled();
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
      expect(readModerationGuardFailure(error)).toMatchObject({
        guardBoundary: 'duplicate_sanction_final',
        guardProofFailure: expect.stringMatching(
          /^own_delete_(binding|sanction_receipt)_unproven$/u,
        ),
        guardProofDetail: detail,
      });
    },
  );

  it.each([
    { response: { status: 403, data: {} } },
    { response: { status: 404, data: { code: 'chat.denied' } } },
    { response: { status: 404, data: { error: { code: 'chat.not.found' } } } },
    { response: { status: 404, data: { code: 'not.found', error: { code: 'chat.denied' } } } },
    { response: { status: 404, data: { code: 'chat.denied', error: { code: 'not.found' } } } },
    { response: { status: 404, data: { code: 'unknown.failure' } } },
    { response: { status: 404, data: { code: 'not.found', error: 'chat.denied' } } },
    { response: { status: 404, data: [{ code: 'not.found' }] } },
    { response: { status: 500, data: {} } },
  ])(
    'does not use a DELETE receipt to mask an explicit access/transport failure (%j)',
    async (error) => {
      const s = full();
      s.max.getExactMessageRow.mockRejectedValue(error);
      s.prisma.moderationDeleteIntent.findUnique.mockResolvedValue(ownDeleteReceipt(s));
      await expect(s.service.assertMessageStillActionable(s.request)).rejects.toBe(error);
      expect(s.prisma.moderationDeleteIntent.findUnique).not.toHaveBeenCalled();
    },
  );

  it('does not use an own DELETE receipt to bypass a changed returned current message', async () => {
    const s = full();
    const changed = duplicateUpdate('m2');
    (changed.raw as { message: { body: { text: string } } }).message.body.text = 'changed';
    s.max.getExactMessageRow.mockResolvedValue((changed.raw as { message: unknown }).message);
    s.prisma.moderationDeleteIntent.findUnique.mockResolvedValue(ownDeleteReceipt(s));
    await expect(s.service.assertMessageStillActionable(s.request)).rejects.toMatchObject({
      code: 'message_duplicate_content_changed',
    });
    expect(s.prisma.moderationDeleteIntent.findUnique).not.toHaveBeenCalled();
  });

  it.each(['send', 'member'] as const)(
    'does not use a DELETE receipt for a %s mutation-marked generic not.found 404',
    async (kind) => {
      const s = full();
      const error = { response: { status: 404, data: { code: 'not.found' } } };
      if (kind === 'send') markMaxMessageSendAttempted(error);
      else markMaxMemberMutationAttempted(error);
      s.max.getExactMessageRow.mockRejectedValue(error);
      s.prisma.moderationDeleteIntent.findUnique.mockResolvedValue(ownDeleteReceipt(s));
      await expect(s.service.assertMessageStillActionable(s.request)).rejects.toBe(error);
      expect(s.prisma.moderationDeleteIntent.findUnique).not.toHaveBeenCalled();
    },
  );

  it.each([{}, { code: 'not.found' }])(
    'retains an unavailable original GET failure (%j) after proving the current DELETE receipt',
    async (body) => {
      const s = full();
      s.max.getExactMessageRow.mockRejectedValue({ response: { status: 404, data: body } });
      const originalError = { response: { status: 404, data: body } };
      s.originalLookup.mockRejectedValue(originalError);
      s.prisma.moderationDeleteIntent.findUnique.mockResolvedValue(ownDeleteReceipt(s));
      await expect(s.service.assertMessageStillActionable(s.request)).rejects.toBe(originalError);
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
      expect(s.history.remove).not.toHaveBeenCalled();
    },
  );
  it('allows configured full sanctions only after fresh source and policy checks', async () => {
    const s = full();
    await expect(s.service.assertMessageStillActionable(s.request)).resolves.toBe('allowed');
    s.settings.duplicateBanEnabled = false;
    await expect(s.service.assertMessageStillActionable(s.request)).rejects.toThrow(
      'settings_changed',
    );
  });
  it('rejects a sanction after a runtime downgrade, changed history, or participant immunity', async () => {
    for (const change of ['policy', 'history', 'immunity']) {
      const s = full();
      if (change === 'policy')
        s.policy.resolve.mockResolvedValue({
          mode: 'delete_only',
          revision: 1,
          effectiveAtMs: Date.now() - 10000,
        });
      if (change === 'history') s.history.stillMatches.mockResolvedValue(false);
      if (change === 'immunity') s.immunity.consumeForMessage.mockResolvedValue('granted');
      await expect(s.service.assertMessageStillActionable(s.request)).rejects.toThrow();
    }
  });
  it('requires our matching successful DELETE receipt when sanctioning an already removed duplicate', async () => {
    const s = full();
    s.max.getExactMessageRow.mockResolvedValue(null);
    await expect(s.service.assertMessageStillActionable(s.request)).rejects.toThrow(
      'unproven_absence',
    );
    const receipt = {
      chatId: s.params.chatId,
      messageId: s.params.messageId,
      subjectUserId: s.binding.senderId,
      remoteDeleteSucceededAt: new Date(),
      reasons: [
        {
          createdAt: new Date(Date.now() - 500),
          metadata: {
            duplicateSource: 'message_v1',
            messageDuplicate: { ...s.binding },
            moderationDeleteVerified: true,
          },
        },
      ],
    };
    s.prisma.moderationDeleteIntent.findUnique.mockResolvedValue(receipt);
    await expect(s.service.assertMessageStillActionable(s.request)).resolves.toBe('allowed');
    receipt.reasons[0]!.metadata.moderationDeleteVerified = false;
    await expect(s.service.assertMessageStillActionable(s.request)).rejects.toThrow(
      'unproven_absence',
    );
    receipt.reasons[0]!.metadata.moderationDeleteVerified = true;
    receipt.remoteDeleteSucceededAt = new Date(s.binding.eventTimestampMs - 1);
    await expect(s.service.assertMessageStillActionable(s.request)).rejects.toThrow(
      'unproven_absence',
    );
    receipt.remoteDeleteSucceededAt = new Date();
    receipt.reasons[0]!.metadata.messageDuplicate.contentDigest = 'a'.repeat(64);
    await expect(s.service.assertMessageStillActionable(s.request)).rejects.toThrow(
      'unproven_absence',
    );
  });

  it.each([
    { code: 'message.not.found' },
    { error: { code: 'message_not_found' } },
    { code: 'message.not_found' },
  ])(
    'recognizes structured current-message absence without authorizing a sanction (%j)',
    async (data) => {
      const s = full();
      const absent = { response: { status: 404, data } };
      s.max.getExactMessageRow.mockRejectedValue(absent);
      await expect(s.service.assertMessageStillActionable(s.request)).rejects.toMatchObject({
        code: 'message_duplicate_unproven_absence',
      });
      expect(s.metrics.record).toHaveBeenCalledWith('guard.current_lookup_confirmed_absent');
      expect(s.metrics.record).not.toHaveBeenCalledWith('guard.unavailable');
      expect(s.originalLookup).not.toHaveBeenCalled();
      expect(s.history.remove).not.toHaveBeenCalled();

      await expect(
        s.service.assertMessageStillActionable({ ...s.request, sanctionIntentId: undefined }),
      ).resolves.toBe('absent');
    },
  );

  it('allows a sanction after structured absence only with our unchanged exact successful DELETE receipt', async () => {
    const s = full();
    s.max.getExactMessageRow.mockRejectedValue({
      response: { status: 404, data: { code: 'message.not.found' } },
    });
    const receipt = {
      chatId: s.params.chatId,
      messageId: s.params.messageId,
      subjectUserId: s.binding.senderId,
      remoteDeleteSucceededAt: new Date(),
      reasons: [
        {
          createdAt: new Date(Date.now() - 500),
          metadata: {
            duplicateSource: 'message_v1',
            messageDuplicate: { ...s.binding },
            moderationDeleteVerified: true,
          },
        },
      ],
    };
    s.prisma.moderationDeleteIntent.findUnique.mockResolvedValue(receipt);
    await expect(s.service.assertMessageStillActionable(s.request)).resolves.toBe('allowed');
    expect(s.originalLookup).toHaveBeenCalledTimes(1);
    receipt.reasons[0]!.metadata.messageDuplicate.contentDigest = 'a'.repeat(64);
    await expect(s.service.assertMessageStillActionable(s.request)).rejects.toMatchObject({
      code: 'message_duplicate_unproven_absence',
    });
  });

  it.each([
    { code: 'message.not.found' },
    { error: { code: 'message_not_found' } },
    { code: 'message.not_found' },
  ])(
    'tombstones a confirmed absent original without inventing a new publication (%j)',
    async (data) => {
      const s = setup();
      s.originalLookup.mockRejectedValue({ response: { status: 404, data } });
      await expect(s.service.assertIntentStillActionable(s.params)).rejects.toMatchObject({
        code: 'message_duplicate_original_missing',
      });
      expect(s.history.remove).toHaveBeenCalledWith('-123', 'm1');
      expect(s.history.observeLifecycle).not.toHaveBeenCalled();
      expect(s.history.invalidateLifecycle).not.toHaveBeenCalled();
      expect(s.metrics.record).toHaveBeenCalledWith('guard.original_lookup_confirmed_absent');
      expect(s.metrics.record).not.toHaveBeenCalledWith('guard.unavailable');
    },
  );

  it.each(
    [
      ['bare 404', { response: { status: 404, data: {} } }],
      [
        'chat 404',
        {
          response: { status: 404, data: { code: 'chat.not.found', message: 'Message not found' } },
        },
      ],
      ['proxy text', { response: { status: 404, data: { message: 'Message not found' } } }],
      ['forbidden', { response: { status: 403, data: { code: 'message.not.found' } } }],
      ['server error', { response: { status: 500, data: { code: 'message.not.found' } } }],
      [
        'successful error payload',
        { response: { status: 200, data: { code: 'message.not.found' } } },
      ],
      ['malformed body', { response: { status: 404, data: [{ code: 'message.not.found' }] } }],
      [
        'conflicting access code',
        {
          response: {
            status: 404,
            data: { code: 'chat.denied', error: { code: 'message.not.found' } },
          },
        },
      ],
      [
        'conflicting nested generic code',
        {
          response: {
            status: 404,
            data: { code: 'message.not.found', error: { code: 'not.found' } },
          },
        },
      ],
      [
        'malformed nested error',
        { response: { status: 404, data: { code: 'message.not.found', error: 'chat.denied' } } },
      ],
      ['transport', new Error('Private source unavailable https://secret.example')],
    ].flatMap(([reason, error]) =>
      (['current', 'original'] as const).map((stage) => ({ reason, error, stage })),
    ),
  )('preserves $stage evidence and retry for $reason', async ({ stage, error }) => {
    const s = setup();
    if (stage === 'current') s.max.getExactMessageRow.mockRejectedValue(error);
    else s.originalLookup.mockRejectedValue(error);
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toBe(error);
    expect(s.history.remove).not.toHaveBeenCalled();
    expect(s.history.invalidateLifecycle).not.toHaveBeenCalled();
    expect(s.metrics.record).toHaveBeenCalledWith(`guard.${stage}_lookup_unavailable`);
    expect(s.metrics.record).toHaveBeenCalledWith('guard.unavailable');
    expect(s.metrics.record).not.toHaveBeenCalledWith(`guard.${stage}_lookup_confirmed_absent`);
    expect(JSON.stringify(s.metrics.record.mock.calls)).not.toMatch(/secret|https/);
  });

  it.each(['send', 'member'] as const)(
    'never treats mutation-marked %s 404 as absence',
    async (kind) => {
      const s = setup();
      const error = { response: { status: 404, data: { code: 'message.not.found' } } };
      if (kind === 'send') markMaxMessageSendAttempted(error);
      else markMaxMemberMutationAttempted(error);
      s.originalLookup.mockRejectedValue(error);
      await expect(s.service.assertIntentStillActionable(s.params)).rejects.toBe(error);
      expect(s.history.remove).not.toHaveBeenCalled();
      expect(s.metrics.record).not.toHaveBeenCalledWith('guard.original_lookup_confirmed_absent');
    },
  );

  it('uses server receipt ordering instead of comparing the MAX clock with the database clock', async () => {
    const s = full();
    s.binding.eventTimestampMs = Date.now() + 1000;
    s.max.getExactMessageRow.mockResolvedValue(null);
    s.prisma.moderationDeleteIntent.findUnique.mockResolvedValue({
      chatId: s.params.chatId,
      messageId: s.params.messageId,
      subjectUserId: s.binding.senderId,
      remoteDeleteSucceededAt: new Date(),
      reasons: [
        {
          createdAt: new Date(Date.now() - 500),
          metadata: {
            duplicateSource: 'message_v1',
            messageDuplicate: { ...s.binding },
            moderationDeleteVerified: true,
          },
        },
      ],
    });
    await expect(s.service.assertMessageStillActionable(s.request)).resolves.toBe('allowed');
  });
  it('checks the current source, fresh policy twice, and read-only history before permitting delete', async () => {
    const s = setup();
    await expect(s.service.assertIntentStillActionable(s.params)).resolves.toBe('allowed');
    expect(s.policy.resolve).toHaveBeenCalledTimes(2);
    expect(s.policy.resolve).toHaveBeenLastCalledWith('-123', true);
    expect(s.prisma.chatSettings.findUnique).toHaveBeenCalledTimes(2);
    expect(s.immunity.consumeForMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'm2', scope: 'duplicate:v1' }),
    );
  });
  it.each([
    'policy',
    'settings',
    'admin',
    'owner',
    'bot',
    'immunity',
    'manual_release',
    'history',
    'edit',
    'sender',
    'photo',
  ])('rejects changed %s', async (change) => {
    const s = setup();
    if (change === 'policy') s.policy.resolve.mockResolvedValue({ mode: 'off' });
    if (change === 'settings') s.settings.antiDuplicateEnabled = false;
    if (change === 'admin')
      s.max.getChatMemberAccess.mockResolvedValue({ userId: '123', isAdmin: true });
    if (change === 'owner')
      s.max.getChatMemberAccess.mockResolvedValue({ userId: '123', isOwner: true });
    if (change === 'bot') s.bots.isKnownBotUserId.mockReturnValue(true);
    if (change === 'immunity') s.immunity.consumeForMessage.mockResolvedValue('granted');
    if (change === 'manual_release')
      s.prisma.moderationEvent.findFirst.mockResolvedValue({ id: 'release' });
    if (change === 'history') s.history.stillMatches.mockResolvedValue(false);
    if (change === 'edit')
      s.max.getExactMessageRow.mockResolvedValue(
        (duplicateUpdate('m2', Date.now(), 'b').raw as { message: unknown }).message,
      );
    if (change === 'sender') s.params.subjectUserId = '456';
    if (change === 'photo') {
      s.binding.hasPhotos = true;
      s.binding.photoControlRevision = 2;
    }
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toThrow(
      /message_duplicate_/,
    );
  });
  it('does not confuse a missing exact row with a transport failure', async () => {
    const s = setup();
    s.max.getExactMessageRow.mockResolvedValue(null);
    await expect(s.service.assertIntentStillActionable(s.params)).resolves.toBe('absent');
    s.max.getExactMessageRow.mockRejectedValue(new Error('transport'));
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toThrow('transport');
  });
  it('catches a control change during the MAX request', async () => {
    const s = setup();
    s.max.getExactMessageRow.mockImplementation(async () => {
      s.policy.resolve.mockResolvedValue({ mode: 'off' });
      return (duplicateUpdate('m2').raw as { message: unknown }).message;
    });
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toThrow(
      'message_duplicate_policy_changed',
    );
  });
  it('does not bypass a malformed new binding because an independent guarded reason exists', async () => {
    const s = setup();
    s.prisma.moderationDeleteIntentReason.findMany.mockResolvedValue([
      {
        reasonKey: 'MESSAGE_DUPLICATE:v1',
        ruleCode: 'DUPLICATE_DELETE',
        metadata: { duplicateSource: 'message_v1' },
      },
      { reasonKey: 'LINK', ruleCode: 'LINK', metadata: {} },
    ]);
    await expect(s.service.assertIntentStillActionable(s.params)).rejects.toThrow(
      'message_duplicate_binding_invalid',
    );
  });
});

describe('queued duplicate explanation authority', () => {
  function noticeFixture() {
    const s = setup();
    s.settings.duplicateBotMessageEnabled = true;
    s.binding.enforcementScope = 'full';
    s.binding.settingsDigest = messageDuplicateSettingsDigest(s.settings);
    s.policy.resolve.mockResolvedValue({
      mode: 'full',
      revision: 1,
      effectiveAtMs: Date.now() - 10_000,
      expiresAtMs: Date.now() + 3_600_000,
    });
    const receipt = {
      id: 'intent',
      status: 'SUCCEEDED',
      remoteDeleteSucceededBotId: 'bot',
      succeededBotId: 'bot',
      chatId: s.params.chatId,
      messageId: s.params.messageId,
      subjectUserId: s.binding.senderId,
      remoteDeleteSucceededAt: new Date(),
      reasons: [
        {
          reasonKey: `MESSAGE_DUPLICATE:v1:${s.binding.eventTimestampMs}`,
          userId: s.binding.senderId,
          ruleCode: 'DUPLICATE_DELETE',
          createdAt: new Date(Date.now() - 1_000),
          metadata: {
            duplicateSource: 'message_v1',
            messageDuplicate: s.binding,
            moderationDeleteVerified: true,
            count: 1,
          },
        },
      ],
    };
    s.prisma.moderationDeleteIntent.findUnique.mockResolvedValue(receipt);
    const notice: MessageDuplicateNoticeProof = {
      version: 3,
      chatId: s.params.chatId,
      intentId: 'intent',
      reasonKey: `MESSAGE_DUPLICATE:v1:${s.binding.eventTimestampMs}`,
      deadlineAtMs: s.binding.authorization!.deadlineAtMs,
      noticePolicySha256: messageDuplicateNoticeSettingsDigest(s.settings),
      binding: s.binding,
      stage: { kind: 'hit', repeatCount: 1, threshold: null },
    };
    return { ...s, notice, receipt, request: { ...s.params, binding: s.binding, notice } };
  }

  it('authorizes a hit after its own confirmed delete without fabricating a sanction stage', async () => {
    const s = noticeFixture();
    s.max.getExactMessageRow.mockResolvedValue(null);
    await expect(s.service.assertMessageStillActionable(s.request)).resolves.toBe('allowed');
    expect(s.binding.sanction).toBeUndefined();
    expect(s.history.stillMatches).toHaveBeenCalledWith(s.params.chatId, s.binding, true);
    expect(s.prisma.moderationDeleteIntent.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'intent' } }),
    );
  });

  it.each([{}, { code: 'not.found' }])(
    'authorizes a queued explanation with a generic current GET 404 %j only from its own DELETE receipt',
    async (data) => {
      const s = noticeFixture();
      const error = { response: { status: 404, data } };
      s.max.getExactMessageRow.mockRejectedValue(error);
      await expect(s.service.assertMessageStillActionable(s.request)).resolves.toBe('allowed');
      expect(s.originalLookup).toHaveBeenCalledTimes(1);
      expect(s.history.stillMatches).toHaveBeenLastCalledWith(s.params.chatId, s.binding, true);
      expect(s.binding.sanction).toBeUndefined();
    },
  );

  it.each([
    'wrong-intent',
    'unfinished',
    'unverified',
    'missing-executor',
    'wrong-executor',
    'unregistered-executor',
    'wrong-reason-key',
    'wrong-reason-user',
    'future-clock',
  ])('retains generic current GET 404 when the notice receipt is %s', async (change) => {
    const s = noticeFixture();
    const error = { response: { status: 404, data: { code: 'not.found' } } };
    s.max.getExactMessageRow.mockRejectedValue(error);
    if (change === 'wrong-intent') s.receipt.id = 'other';
    if (change === 'unfinished') s.receipt.status = 'PENDING';
    if (change === 'unverified') s.receipt.reasons[0]!.metadata.moderationDeleteVerified = false;
    if (change === 'missing-executor') s.receipt.remoteDeleteSucceededBotId = '';
    if (change === 'wrong-executor') s.receipt.succeededBotId = 'peer';
    if (change === 'unregistered-executor')
      s.bots.isRegisteredModerationBotId.mockReturnValue(false);
    if (change === 'wrong-reason-key') s.receipt.reasons[0]!.reasonKey = 'other';
    if (change === 'wrong-reason-user') s.receipt.reasons[0]!.userId = 'other';
    if (change === 'future-clock')
      s.receipt.remoteDeleteSucceededAt = new Date(Date.now() + 60_000);
    await expect(s.service.assertMessageStillActionable(s.request)).rejects.toBe(error);
    expect(s.originalLookup).not.toHaveBeenCalled();
    expect(s.history.stillMatches).not.toHaveBeenCalled();
  });

  it.each([
    ['current', 403, 'access.denied'],
    ['current', 404, 'chat.not.found'],
    ['current', 503, 'unavailable'],
    ['original', 404, 'not.found'],
    ['author', 404, 'not.found'],
  ])('keeps notice %s GET %i %s strict despite its own DELETE', async (source, status, code) => {
    const s = noticeFixture();
    const error = { response: { status, data: { code } } };
    if (source === 'current') s.max.getExactMessageRow.mockRejectedValue(error);
    if (source === 'original') s.originalLookup.mockRejectedValue(error);
    if (source === 'author') s.max.getChatMemberAccess.mockRejectedValue(error);
    await expect(s.service.assertMessageStillActionable(s.request)).rejects.toBe(error);
    expect(s.history.stillMatches).not.toHaveBeenCalled();
  });

  it('rejects an absent hit when a length DELETE succeeded but the duplicate reason was revoked', async () => {
    const s = noticeFixture();
    s.max.getExactMessageRow.mockResolvedValue(null);
    s.receipt.reasons[0]!.metadata.moderationDeleteVerified = false;
    await expect(s.service.assertMessageStillActionable(s.request)).rejects.toMatchObject({
      code: 'message_duplicate_unproven_absence',
    });
    expect(s.originalLookup).not.toHaveBeenCalled();
  });

  it.each(['intent', 'reason', 'stage', 'history', 'policy', 'enabled', 'template', 'immunity'])(
    'rejects a queued explanation after %s authority changes',
    async (change) => {
      const s = noticeFixture();
      if (change === 'intent') s.receipt.subjectUserId = 'other';
      if (change === 'reason') s.receipt.reasons[0]!.ruleCode = 'LENGTH_DELETE';
      if (change === 'stage') s.receipt.reasons[0]!.metadata.count = 2;
      if (change === 'history') s.history.stillMatches.mockResolvedValue(false);
      if (change === 'policy') s.policy.resolve.mockResolvedValue({ mode: 'delete_only' } as never);
      if (change === 'enabled') s.settings.duplicateBotMessageEnabled = false;
      if (change === 'template') s.settings.duplicateBotMessageText = 'new text';
      if (change === 'immunity') s.immunity.consumeForMessage.mockResolvedValue('granted');
      await expect(s.service.assertMessageStillActionable(s.request)).rejects.toBeInstanceOf(
        MessageDuplicateGuardRejectedError,
      );
    },
  );

  it('runs current route authority before the final settings and Redis grant fence', async () => {
    const s = noticeFixture();
    const beforeFinalAuthority = jest.fn(async () => {
      s.settings.duplicateBotMessageEnabled = false;
    });
    await expect(
      s.service.assertMessageStillActionable({ ...s.request, beforeFinalAuthority }),
    ).rejects.toMatchObject({ code: 'message_duplicate_notice_settings_changed' });
    expect(beforeFinalAuthority).toHaveBeenCalledTimes(1);
    expect(s.authorization.isAllowed).toHaveBeenCalledTimes(1);
  });

  it('rejects a queued explanation whose history resets at the final checkpoint without more MAX reads', async () => {
    const s = noticeFixture();
    let remoteReadsAtCheckpoint = 0;
    const beforeFinalAuthority = jest.fn(async () => {
      remoteReadsAtCheckpoint = s.max.getExactMessageRow.mock.calls.length;
      s.history.stillMatches.mockResolvedValue(false);
    });
    await expect(
      s.service.assertMessageStillActionable({ ...s.request, beforeFinalAuthority }),
    ).rejects.toMatchObject({ code: 'message_duplicate_history_changed' });
    expect(beforeFinalAuthority).toHaveBeenCalledTimes(1);
    expect(s.history.stillMatches).toHaveBeenLastCalledWith(s.request.chatId, s.binding, true);
    expect(s.authorization.isAllowed).toHaveBeenCalledTimes(1);
    expect(s.max.getExactMessageRow).toHaveBeenCalledTimes(remoteReadsAtCheckpoint);
  });

  it('expires a queued explanation when its final Redis grant read crosses the original deadline', async () => {
    const s = noticeFixture();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(s.binding.eventTimestampMs);
    let reads = 0;
    s.authorization.isAllowed.mockImplementation(async () => {
      if (++reads === 2) clock.mockReturnValue(s.notice.deadlineAtMs);
      return true;
    });
    try {
      await expect(s.service.assertMessageStillActionable(s.request)).rejects.toMatchObject({
        code: 'message_duplicate_notice_expired',
      });
    } finally {
      clock.mockRestore();
    }
  });

  it('expires immediate member and sanction-notice authority after the final real permit boundary', async () => {
    const s = setup();
    s.policy.resolve.mockResolvedValue({
      mode: 'full',
      revision: 1,
      effectiveAtMs: s.binding.eventTimestampMs - 10_000,
      expiresAtMs: Number.MAX_SAFE_INTEGER,
    });
    s.settings.duplicateBanEnabled = true;
    s.settings.duplicateBanMaxCount = 1;
    s.binding.enforcementScope = 'full';
    s.binding.settingsDigest = messageDuplicateSettingsDigest(s.settings);
    s.binding.sanction = {
      action: 'BAN',
      repeatCount: 1,
      threshold: 1,
      settingsDigest: messageDuplicateSanctionSettingsDigest(s.settings),
    };
    const clock = jest.spyOn(Date, 'now').mockReturnValue(s.binding.eventTimestampMs);
    let reads = 0;
    s.authorization.isAllowed.mockImplementation(async () => {
      if (++reads === 2) clock.mockReturnValue(s.binding.authorization!.deadlineAtMs);
      return true;
    });
    try {
      await expect(
        s.service.assertMessageStillActionable({
          ...s.params,
          binding: s.binding,
          sanctionIntentId: 'intent',
        }),
      ).rejects.toMatchObject({
        code: 'message_duplicate_action_expired',
      });
    } finally {
      clock.mockRestore();
    }
  });
});
