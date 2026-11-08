import type { AutomaticDeleteAuthorAccessService } from '../../max/automatic-delete-author-access.service';
import { ConfigService } from '@nestjs/config';

import { MAX_API_SOURCE_TAGS } from '../../max/max-client.service';
import { RuleEngineService } from '../rule-engine.service';
import {
  PROFANITY_DELETE_RULE_CODE,
  ProfanityDeleteGuardRejectedError,
  ProfanityDeleteGuardService,
} from './profanity-delete-guard.service';

const baseInput = {
  intentId: 'intent-1',
  chatId: 'chat-1',
  messageId: 'message-1',
  subjectUserId: 'user-1',
  botId: 'delete-bot',
};

function buildMessage(text = 'блять') {
  return {
    body: { mid: 'message-1', text },
    sender: { user_id: 'user-1' },
    recipient: { chat_id: 'chat-1', chat_type: 'chat' },
    timestamp: Date.now(),
  };
}

function buildHarness(authorAccess?: Pick<AutomaticDeleteAuthorAccessService, 'resolve'>) {
  const settings = {
    russianProfanityFilterEnabled: true,
    profanitySensitivity: 'BALANCED' as 'CORE_ONLY' | 'BALANCED' | 'STRICT',
    nightModeTimezone: 'Europe/Moscow',
    chat: { entityType: 'CHAT', admins: [] as Array<{ userId: string }> },
  };
  const prisma = {
    chatSettings: { findUnique: jest.fn().mockImplementation(async () => settings) },
    moderationDeleteIntentReason: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ ruleCode: PROFANITY_DELETE_RULE_CODE, score: 0.95 }]),
    },
  };
  const maxClient = {
    getExactMessageRow: jest.fn().mockResolvedValue(buildMessage()),
    getChatMemberAccess: jest.fn().mockResolvedValue({
      userId: 'user-1',
      isAdmin: false,
      isOwner: false,
    }),
  };
  const maxBotLink = { isKnownBotUserId: jest.fn().mockReturnValue(false) };
  const immunity = { consumeForMessage: jest.fn().mockResolvedValue('not_granted') };
  const ruleEngine = new RuleEngineService({} as never);
  const detect = jest.spyOn(ruleEngine, 'detect');
  const service = new ProfanityDeleteGuardService(
    prisma as never,
    maxClient as never,
    maxBotLink as never,
    immunity as never,
    ruleEngine,
    new ConfigService({ MODERATION_DELETE_INTENT_TIMEOUT_MS: 5_000 }),
    authorAccess as AutomaticDeleteAuthorAccessService | undefined,
  );
  return { service, prisma, settings, maxClient, maxBotLink, immunity, detect };
}

describe('ProfanityDeleteGuardService', () => {
  const previousRollout = process.env.PROFANITY_V2_ROLLOUT_MODE;

  beforeEach(() => {
    delete process.env.PROFANITY_V2_ROLLOUT_MODE;
  });

  afterAll(() => {
    if (previousRollout === undefined) {
      delete process.env.PROFANITY_V2_ROLLOUT_MODE;
    } else {
      process.env.PROFANITY_V2_ROLLOUT_MODE = previousRollout;
    }
  });

  it('uses saved role immunity while retaining the actual membership requirement', async () => {
    const resolve = jest
      .fn<
        ReturnType<AutomaticDeleteAuthorAccessService['resolve']>,
        Parameters<AutomaticDeleteAuthorAccessService['resolve']>
      >()
      .mockResolvedValue({
        initialized: true,
        revision: '1',
        isAdmin: false,
        member: { userId: 'user-1', isAdmin: true, isOwner: false, permissions: [] },
      });
    const h = buildHarness({ resolve });
    await expect(h.service.assertIntentStillActionable(baseInput)).resolves.toBe('allowed');
    expect(h.maxClient.getChatMemberAccess).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith(
      'chat-1',
      'user-1',
      expect.objectContaining({ botId: 'delete-bot' }),
      { requireMembership: true },
    );
  });

  it('does not turn a saved nonadmin decision into proof that an absent author remains a member', async () => {
    const resolve = jest
      .fn<
        ReturnType<AutomaticDeleteAuthorAccessService['resolve']>,
        Parameters<AutomaticDeleteAuthorAccessService['resolve']>
      >()
      .mockResolvedValue({ initialized: true, revision: '1', isAdmin: false, member: null });
    const h = buildHarness({ resolve });
    await expect(h.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'profanity_author_not_member',
    });
    expect(h.maxClient.getExactMessageRow).not.toHaveBeenCalled();
    expect(h.immunity.consumeForMessage).not.toHaveBeenCalled();
  });

  it('checks current text once through the executable bot without running stateful rules', async () => {
    const harness = buildHarness();

    await expect(harness.service.assertIntentStillActionable(baseInput)).resolves.toBe('allowed');

    expect(harness.maxClient.getExactMessageRow).toHaveBeenCalledTimes(1);
    expect(harness.maxClient.getExactMessageRow).toHaveBeenCalledWith('chat-1', 'message-1', {
      botId: 'delete-bot',
      bypassCache: true,
      trafficClass: 'critical',
      actionHealthLane: 'critical',
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      ignoreFailureMetricStatuses: [403, 404],
      timeoutMs: 5_000,
    });
    expect(harness.maxClient.getChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(harness.prisma.chatSettings.findUnique).toHaveBeenCalledTimes(2);
    expect(harness.detect).not.toHaveBeenCalled();
  });

  it.each([
    'Спасибо, всё исправил',
    'blyaha na remne',
    'В зоопарке живет п.е.т.у.х.',
    'В детском центре а у т и с т пишет рассказ.',
    'Лечение педикулеза: как удалить гнид',
    'Открыт набор в арт-студию. ЧЕТВЕРГ: 16:00 - группа 3-6 л. для детей',
    'Занятия для детей 3-6лет',
    'ЧЕТВЕРГ: 16:00 - гр. 3-6 л.',
  ])('rejects a legacy decision when the latest text is clean: %s', async (text) => {
    const harness = buildHarness();
    harness.maxClient.getExactMessageRow.mockResolvedValue(buildMessage(text));

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'profanity_violation_no_longer_present',
    });
    expect(harness.immunity.consumeForMessage).not.toHaveBeenCalled();
  });

  it.each(['отъебись', 'спиздил', 'Питомник продаёт щенков. Ты сука!'])(
    'keeps corrected detection actionable at dispatch: %s',
    async (text) => {
      const harness = buildHarness();
      harness.maxClient.getExactMessageRow.mockResolvedValue(buildMessage(text));
      await expect(harness.service.assertIntentStillActionable(baseInput)).resolves.toBe('allowed');
    },
  );

  it('accepts edited text that still violates current policy', async () => {
    const harness = buildHarness();
    harness.maxClient.getExactMessageRow.mockResolvedValue(buildMessage('ты ебаный ублюдок'));

    await expect(harness.service.assertIntentStillActionable(baseInput)).resolves.toBe('allowed');
  });

  it('does not reuse an old severe score for a current mild insult', async () => {
    const harness = buildHarness();
    harness.settings.profanitySensitivity = 'STRICT';
    harness.maxClient.getExactMessageRow.mockResolvedValue(buildMessage('ты скотина'));

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'profanity_violation_no_longer_present',
    });
  });

  it.each(['BALANCED', 'CORE_ONLY'] as const)(
    'rejects an old strict mild decision at current %s sensitivity',
    async (sensitivity) => {
      const harness = buildHarness();
      harness.settings.profanitySensitivity = sensitivity;
      harness.prisma.moderationDeleteIntentReason.findMany.mockResolvedValue([
        { ruleCode: PROFANITY_DELETE_RULE_CODE, score: 0.75 },
      ]);
      harness.maxClient.getExactMessageRow.mockResolvedValue(buildMessage('ты скотина'));

      await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
        code: 'profanity_violation_no_longer_present',
      });
    },
  );

  it('applies the execution-time legacy rollout to the current text', async () => {
    process.env.PROFANITY_V2_ROLLOUT_MODE = 'legacy';
    const harness = buildHarness();
    harness.settings.profanitySensitivity = 'STRICT';
    harness.maxClient.getExactMessageRow.mockResolvedValue(buildMessage('ты валенок'));

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'profanity_violation_no_longer_present',
    });
  });

  it('rejects disabled settings before making MAX calls', async () => {
    const harness = buildHarness();
    harness.settings.russianProfanityFilterEnabled = false;

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'profanity_settings_disabled',
    });
    expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
    expect(harness.maxClient.getChatMemberAccess).not.toHaveBeenCalled();
  });

  it('rechecks settings when they change during the exact MAX lookup', async () => {
    const harness = buildHarness();
    harness.maxClient.getExactMessageRow.mockImplementation(async () => {
      harness.prisma.chatSettings.findUnique.mockResolvedValue({
        ...harness.settings,
        russianProfanityFilterEnabled: false,
      });
      return buildMessage();
    });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'profanity_settings_disabled',
    });
    expect(harness.maxClient.getExactMessageRow).toHaveBeenCalledTimes(1);
  });

  it.each(['runtime-bot', 'local-admin', 'remote-admin', 'remote-owner', 'participant'] as const)(
    'preserves current %s immunity',
    async (kind) => {
      const harness = buildHarness();
      if (kind === 'runtime-bot') harness.maxBotLink.isKnownBotUserId.mockReturnValue(true);
      if (kind === 'local-admin') harness.settings.chat.admins.push({ userId: 'user-1' });
      if (kind === 'remote-admin' || kind === 'remote-owner') {
        harness.maxClient.getChatMemberAccess.mockResolvedValue({
          userId: 'user-1',
          isAdmin: kind === 'remote-admin',
          isOwner: kind === 'remote-owner',
        });
      }
      if (kind === 'participant') harness.immunity.consumeForMessage.mockResolvedValue('granted');

      await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
        code: 'profanity_author_immune',
      });
    },
  );

  it.each(['message', 'chat', 'author', 'entity-type'] as const)(
    'rejects changed %s identity',
    async (kind) => {
      const harness = buildHarness();
      const row = buildMessage();
      if (kind === 'message') row.body.mid = 'another-message';
      if (kind === 'chat') row.recipient.chat_id = 'another-chat';
      if (kind === 'author') row.sender.user_id = 'another-user';
      if (kind === 'entity-type') row.recipient.chat_type = 'channel';
      harness.maxClient.getExactMessageRow.mockResolvedValue(row);

      await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
        code: 'profanity_message_identity_changed',
      });
    },
  );

  it('accepts absence only from the exact message-specific lookup', async () => {
    const harness = buildHarness();
    harness.maxClient.getExactMessageRow.mockResolvedValue(null);

    await expect(harness.service.assertIntentStillActionable(baseInput)).resolves.toBe('absent');
  });

  it.each(['getExactMessageRow', 'getChatMemberAccess'] as const)(
    'keeps an unavailable %s retryable instead of authorizing deletion',
    async (method) => {
      const harness = buildHarness();
      const error = Object.assign(new Error('MAX unavailable'), { statusCode: 404 });
      harness.maxClient[method].mockRejectedValue(error);

      await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toBe(error);
      expect(error).not.toBeInstanceOf(ProfanityDeleteGuardRejectedError);
    },
  );

  it('cancels deletion when a valid fresh lookup no longer contains the author', async () => {
    const harness = buildHarness();
    harness.maxClient.getChatMemberAccess.mockResolvedValue(null);

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      name: 'ProfanityDeleteGuardRejectedError',
      code: 'profanity_author_not_member',
    });
    expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
    expect(harness.immunity.consumeForMessage).not.toHaveBeenCalled();
  });

  it.each(['MAX unavailable', 'Invalid MAX chat members response'])(
    'does not mistake a failed lookup for confirmed absence: %s',
    async (message) => {
      const harness = buildHarness();
      const error = new Error(message);
      harness.maxClient.getChatMemberAccess.mockRejectedValue(error);

      await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toBe(error);
      expect(error).not.toBeInstanceOf(ProfanityDeleteGuardRejectedError);
      expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
      expect(harness.immunity.consumeForMessage).not.toHaveBeenCalled();
    },
  );

  it('keeps a mismatched author lookup retryable without sanctions', async () => {
    const harness = buildHarness();
    harness.maxClient.getChatMemberAccess.mockResolvedValue({
      userId: 'another-user',
      isAdmin: false,
      isOwner: false,
    });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toThrow(
      'author access is unavailable',
    );
    expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
    expect(harness.immunity.consumeForMessage).not.toHaveBeenCalled();
  });

  it.each([
    { ruleCodes: ['LINK_BLOCKED_DELETE'] },
    { ruleCodes: [PROFANITY_DELETE_RULE_CODE, 'MESSAGE_BLOCKED_WORD_DELETE'] },
  ])(
    'leaves independent reasons unchanged without any settings or MAX lookups: $ruleCodes',
    async ({ ruleCodes }) => {
      const harness = buildHarness();
      harness.prisma.moderationDeleteIntentReason.findMany.mockResolvedValue(
        ruleCodes.map((ruleCode) => ({ ruleCode, score: 0.95 })),
      );

      await expect(harness.service.assertIntentStillActionable(baseInput)).resolves.toBe(
        'not_applicable',
      );
      expect(harness.prisma.chatSettings.findUnique).not.toHaveBeenCalled();
      expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
      expect(harness.maxClient.getChatMemberAccess).not.toHaveBeenCalled();
    },
  );

  it('reports a lost durable reason so the final dispatch fence can stop deletion', async () => {
    const harness = buildHarness();
    harness.prisma.moderationDeleteIntentReason.findMany.mockResolvedValue([]);

    await expect(harness.service.assertIntentStillActionable(baseInput)).resolves.toBe(
      'missing_reason',
    );
    expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
  });

  it('uses the same visible-forward text as initial moderation, but excludes reply text', async () => {
    const harness = buildHarness();
    const row = buildMessage('Спасибо');
    harness.maxClient.getExactMessageRow.mockResolvedValue({
      ...row,
      link: { type: 'forward', message: { body: { text: 'блять' } } },
    });
    await expect(harness.service.assertIntentStillActionable(baseInput)).resolves.toBe('allowed');

    harness.maxClient.getExactMessageRow.mockResolvedValue({
      ...row,
      link: { type: 'reply', message: { body: { text: 'блять' } } },
    });
    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'profanity_violation_no_longer_present',
    });
  });
});
