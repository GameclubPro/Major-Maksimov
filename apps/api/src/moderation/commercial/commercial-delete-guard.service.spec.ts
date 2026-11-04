import { ConfigService } from '@nestjs/config';
import {
  createDefaultCommercialAdsPolicy,
  type CommercialAdsPolicy,
} from '@maxim/contracts/settings';
import { finalizeDeleteAuthority } from '../moderation-delete-authority-preparation';
import { CommercialAdDetector } from './commercial-ad.detector';
import {
  buildCommercialTextDeleteBinding,
  commercialTextDeleteReasonKey,
  COMMERCIAL_TEXT_DELETE_RULE_CODE,
  COMMERCIAL_TEXT_DELETE_MAX_AGE_MS,
} from './commercial-delete-binding';
import { CommercialDeleteGuardService } from './commercial-delete-guard.service';

const text = 'Такси +7 900 000 10 42';
const input = {
  intentId: 'intent',
  chatId: 'chat',
  messageId: 'message',
  subjectUserId: 'user',
  botId: 'bot',
};
const message = (value = text, userId = 'user') => ({
  body: { mid: 'message', text: value },
  sender: { user_id: userId },
  recipient: { chat_id: 'chat', chat_type: 'chat' },
  timestamp: Date.now(),
});

function harness(commercialPolicy: CommercialAdsPolicy | null = null, userId = 'user') {
  const settings = {
    commercialAdsFilterEnabled: true,
    commercialAdsPolicy: commercialPolicy,
    commercialAdsSensitivity: 'BALANCED' as const,
    commercialAdsWarnThreshold: 45,
    commercialAdsDeleteThreshold: 65,
    nightModeTimezone: 'Europe/Moscow',
    textFiltersWarnEnabled: true,
    textFiltersMuteEnabled: true,
    textFiltersBanEnabled: true,
    textFiltersMuteDurationHours: 1,
    textFiltersBotMessageEnabled: true,
    chat: { entityType: 'CHAT', admins: [] as { userId: string }[] },
  };
  const binding = buildCommercialTextDeleteBinding({
    text,
    settings,
    eventTimestampMs: Date.now(),
    campaignContext: null,
  });
  const reason = {
    ruleCode: COMMERCIAL_TEXT_DELETE_RULE_CODE,
    reasonKey: commercialTextDeleteReasonKey(binding),
    score: 0.45,
    metadata: { messageDisposition: 'DELETE', commercialTextBinding: binding },
  };
  const prisma = {
    chatSettings: { findUnique: jest.fn().mockImplementation(async () => settings) },
    moderationDeleteIntentReason: {
      findMany: jest.fn().mockResolvedValue([reason]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
  const max = {
    getExactMessageRow: jest.fn().mockResolvedValue(message(text, userId)),
    getChatMemberAccess: jest.fn().mockResolvedValue({ userId, isAdmin: false, isOwner: false }),
  };
  const botLink = { isKnownBotUserId: jest.fn().mockReturnValue(false) };
  const immunity = { consumeForMessage: jest.fn().mockResolvedValue('not_granted') };
  const authority = {
    revision: 0,
    baselineAllowed: true,
    promotedPolicyCohorts: [] as string[],
    mode: 'baseline',
  };
  const policy = { authority: jest.fn().mockImplementation(async () => authority) };
  const service = new CommercialDeleteGuardService(
    prisma as never,
    max as never,
    botLink as never,
    immunity as never,
    new ConfigService({ MODERATION_DELETE_INTENT_TIMEOUT_MS: 5000 }),
    policy as never,
  );
  return { service, settings, binding, reason, prisma, max, botLink, immunity, authority, policy };
}

describe('CommercialDeleteGuardService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('checks the exact current message and permissions once per dispatch, using the executable bot', async () => {
    const h = harness();
    await expect(h.service.assertIntentStillActionable(input)).resolves.toEqual({
      kind: 'allowed',
      reasonKeys: [h.reason.reasonKey],
    });
    expect(h.max.getExactMessageRow).toHaveBeenCalledTimes(1);
    expect(h.max.getExactMessageRow).toHaveBeenCalledWith(
      'chat',
      'message',
      expect.objectContaining({
        botId: 'bot',
        bypassCache: true,
        timeoutMs: 5000,
        trafficClass: 'critical',
      }),
    );
    expect(h.max.getChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(h.prisma.chatSettings.findUnique).toHaveBeenCalledTimes(2);
  });

  it('rejects a matching active category exception under an otherwise current bound intent', async () => {
    const userId = '10000007';
    const policy = createDefaultCommercialAdsPolicy();
    policy.exceptions.push({
      id: '11111111-1111-4111-8111-111111111111',
      userId,
      userName: 'Участник',
      categories: ['SERVICES'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const h = harness(policy, userId);
    await expect(
      h.service.assertIntentStillActionable({ ...input, subjectUserId: userId }),
    ).rejects.toMatchObject({ code: 'commercial_text_violation_no_longer_present' });
    expect(h.max.getExactMessageRow).toHaveBeenCalledTimes(1);
    expect(h.immunity.consumeForMessage).not.toHaveBeenCalled();
  });

  it('rechecks exact exception expiry without changing the bound settings fingerprint', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-04T09:00:00.000Z') });
    const userId = '10000007';
    const policy = createDefaultCommercialAdsPolicy();
    policy.exceptions.push({
      id: '11111111-1111-4111-8111-111111111111',
      userId,
      userName: 'Участник',
      categories: ['SERVICES'],
      expiresAt: new Date(Date.now() + 1_000).toISOString(),
    });
    const h = harness(policy, userId);
    await expect(
      h.service.assertIntentStillActionable({ ...input, subjectUserId: userId }),
    ).rejects.toMatchObject({ code: 'commercial_text_violation_no_longer_present' });
    jest.advanceTimersByTime(1_000);
    await expect(
      h.service.assertIntentStillActionable({ ...input, subjectUserId: userId }),
    ).resolves.toEqual({ kind: 'allowed', reasonKeys: [h.reason.reasonKey] });
    expect(h.reason.metadata.commercialTextBinding).toBe(h.binding);
  });

  it('revokes prepared dispatch when a matching exception is added before final authority', async () => {
    const userId = '10000007';
    const policy = createDefaultCommercialAdsPolicy();
    const h = harness(policy, userId);
    const prepared = await h.service.prepareForDispatch({ ...input, subjectUserId: userId });
    policy.exceptions.push({
      id: '11111111-1111-4111-8111-111111111111',
      userId,
      userName: 'Участник',
      categories: ['SERVICES'],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await expect(finalizeDeleteAuthority(prepared)).rejects.toMatchObject({
      code: 'commercial_text_binding_stale',
      reasonFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(h.max.getExactMessageRow).toHaveBeenCalledTimes(1);
    expect(h.prisma.chatSettings.findUnique).toHaveBeenCalledTimes(2);
  });

  it('revokes a pending delete when the global text control is off', async () => {
    const h = harness();
    h.authority.baselineAllowed = false;
    await expect(h.service.assertIntentStillActionable(input)).rejects.toMatchObject({
      code: 'commercial_text_authority_changed',
    });
    expect(h.max.getExactMessageRow).not.toHaveBeenCalled();
  });

  it('rechecks runtime revision after remote work', async () => {
    const h = harness();
    h.max.getExactMessageRow.mockImplementation(async () => {
      h.authority.revision = 1;
      return message();
    });
    await expect(h.service.assertIntentStillActionable(input)).rejects.toMatchObject({
      code: 'commercial_text_authority_changed',
    });
  });

  it('issues no sanction permit for absent or independently deleted messages', () => {
    const h = harness();
    for (const [deleted, commercialVerified] of [
      [false, true],
      [true, false],
    ]) {
      expect(
        h.service.createSanctionPermit({
          ...input,
          evidence: [h.reason],
          deleted,
          commercialVerified,
        }),
      ).toBeNull();
    }
  });

  it('authorizes only its own short-lived permit without rereading the deleted message', async () => {
    const h = harness();
    const permit = h.service.createSanctionPermit({
      ...input,
      evidence: [h.reason],
      deleted: true,
      commercialVerified: true,
    })!;
    await expect(h.service.authorizeSanction({ ...permit })).resolves.toBe(false);
    await expect(h.service.authorizeSanction(permit)).resolves.toBe(true);
    expect(h.max.getExactMessageRow).not.toHaveBeenCalled();
    jest.useFakeTimers();
    jest.setSystemTime(permit.expiresAtMs);
    await expect(h.service.authorizeSanction(permit)).resolves.toBe(false);
  });

  it.each([
    null,
    { userId: null, isAdmin: false, isOwner: false },
    { userId: 'foreign', isAdmin: false, isOwner: false },
    { userId: 'user', isAdmin: null, isOwner: false },
    { userId: 'user', isAdmin: false, isOwner: null },
  ])(
    'does not authorize a commercial follow-up with incomplete author access: %o',
    async (access) => {
      const h = harness();
      const permit = h.service.createSanctionPermit({
        ...input,
        evidence: [h.reason],
        deleted: true,
        commercialVerified: true,
      })!;
      h.max.getChatMemberAccess.mockResolvedValue(access);
      await expect(h.service.authorizeSanction(permit)).resolves.toBe(false);
      expect(h.immunity.consumeForMessage).not.toHaveBeenCalled();
    },
  );

  it('uses the selected executor for the same immutable permit and rechecks policy after route qualification', async () => {
    const h = harness();
    const permit = h.service.createSanctionPermit({
      ...input,
      evidence: [h.reason],
      deleted: true,
      commercialVerified: true,
    })!;
    await expect(h.service.authorizeSanction(permit, { botId: 'surviving-peer' })).resolves.toBe(
      true,
    );
    expect(h.max.getChatMemberAccess).toHaveBeenLastCalledWith(
      'chat',
      'user',
      expect.objectContaining({ botId: 'surviving-peer', bypassCache: true }),
    );
    const beforeFinalAuthority = jest.fn(async () => {
      h.settings.commercialAdsFilterEnabled = false;
    });
    await expect(
      h.service.authorizeSanction(permit, {
        botId: 'surviving-peer',
        beforeFinalAuthority,
      }),
    ).resolves.toBe(false);
    expect(beforeFinalAuthority).toHaveBeenCalledTimes(1);
    expect(h.max.getExactMessageRow).not.toHaveBeenCalled();
  });

  it.each(['route', 'author', 'immunity'] as const)(
    'preserves an uncertain %s authority failure instead of reporting commercial revocation',
    async (failure) => {
      const h = harness();
      const permit = h.service.createSanctionPermit({
        ...input,
        evidence: [h.reason],
        deleted: true,
        commercialVerified: true,
      })!;
      const error = Object.assign(new Error('Synthetic authority read failed'), {
        code: failure === 'route' ? 'max_action_executor_proof_rejected' : 'ECONNRESET',
      });
      if (failure === 'author') h.max.getChatMemberAccess.mockRejectedValue(error);
      if (failure === 'immunity') h.immunity.consumeForMessage.mockRejectedValue(error);
      await expect(
        h.service.authorizeSanction(permit, {
          beforeFinalAuthority: async () => {
            if (failure === 'route') throw error;
          },
        }),
      ).rejects.toBe(error);
      expect(h.max.getExactMessageRow).not.toHaveBeenCalled();
    },
  );

  it('cannot renew the original commercial permit during a final route wait', async () => {
    const h = harness();
    const permit = h.service.createSanctionPermit({
      ...input,
      evidence: [h.reason],
      deleted: true,
      commercialVerified: true,
    })!;
    const originalExpiry = permit.expiresAtMs;
    jest.useFakeTimers();
    await expect(
      h.service.authorizeSanction(permit, {
        beforeFinalAuthority: async () => {
          jest.setSystemTime(originalExpiry + 1);
        },
      }),
    ).resolves.toBe(false);
    expect(permit.expiresAtMs).toBe(originalExpiry);
  });

  it.each(['disabled', 'settings', 'admin', 'immune', 'runtime'])(
    'revokes post-delete authority after %s changes',
    async (change) => {
      const h = harness();
      const permit = h.service.createSanctionPermit({
        ...input,
        evidence: [h.reason],
        deleted: true,
        commercialVerified: true,
      })!;
      if (change === 'disabled') h.settings.commercialAdsFilterEnabled = false;
      if (change === 'settings') h.settings.textFiltersMuteEnabled = false;
      if (change === 'admin')
        h.max.getChatMemberAccess.mockResolvedValue({
          userId: 'user',
          isAdmin: true,
          isOwner: false,
        });
      if (change === 'immune') h.immunity.consumeForMessage.mockResolvedValue('granted');
      if (change === 'runtime') h.authority.baselineAllowed = false;
      await expect(h.service.authorizeSanction(permit)).resolves.toBe(false);
      expect(h.max.getExactMessageRow).not.toHaveBeenCalled();
    },
  );

  it('does not delete an edited source under its previous binding', async () => {
    const h = harness();
    h.max.getExactMessageRow.mockResolvedValue(message('Спасибо за помощь'));
    await expect(h.service.assertIntentStillActionable(input)).rejects.toMatchObject({
      code: 'commercial_text_message_changed',
      reasonFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(h.immunity.consumeForMessage).not.toHaveBeenCalled();
  });

  it('uses the latest event revision, not arrival order or an older expired decision', async () => {
    const h = harness();
    const old = buildCommercialTextDeleteBinding({
      text: 'Старое объявление',
      settings: h.settings,
      eventTimestampMs: Date.now() - COMMERCIAL_TEXT_DELETE_MAX_AGE_MS - 1,
      campaignContext: null,
    });
    h.prisma.moderationDeleteIntentReason.findMany.mockResolvedValue([
      h.reason,
      {
        ...h.reason,
        reasonKey: commercialTextDeleteReasonKey(old),
        score: 1,
        metadata: { commercialTextBinding: old },
      },
    ]);
    await expect(h.service.assertIntentStillActionable(input)).resolves.toEqual({
      kind: 'allowed',
      reasonKeys: [h.reason.reasonKey],
    });
  });

  it('fails closed for conflicting sources at the same event timestamp', async () => {
    const h = harness();
    const other = buildCommercialTextDeleteBinding({
      text: 'Другое объявление',
      settings: h.settings,
      eventTimestampMs: h.binding.eventTimestampMs,
      campaignContext: null,
    });
    h.prisma.moderationDeleteIntentReason.findMany.mockResolvedValue([
      h.reason,
      {
        ...h.reason,
        reasonKey: commercialTextDeleteReasonKey(other),
        metadata: { commercialTextBinding: other },
      },
    ]);
    await expect(h.service.assertIntentStillActionable(input)).rejects.toMatchObject({
      code: 'commercial_text_binding_invalid',
    });
    expect(h.max.getExactMessageRow).not.toHaveBeenCalled();
  });

  it.each(['runtime-revision', 'required-cohorts'] as const)(
    'rejects every selected reason with a conflicting %s, in either arrival order',
    async (change) => {
      for (const reverse of [false, true]) {
        const h = harness();
        h.authority.promotedPolicyCohorts = ['owned-service-contrast-v1'];
        const other = buildCommercialTextDeleteBinding({
          text,
          settings: h.settings,
          eventTimestampMs: h.binding.eventTimestampMs,
          campaignContext: null,
          textRuntimeRevision: change === 'runtime-revision' ? 1 : 0,
          requiredPolicyCohorts: change === 'required-cohorts' ? ['owned-service-contrast-v1'] : [],
        });
        const reasons = [
          h.reason,
          {
            ...h.reason,
            reasonKey: `${h.reason.reasonKey}:conflicting-policy`,
            metadata: { messageDisposition: 'DELETE', commercialTextBinding: other },
          },
        ];
        if (reverse) reasons.reverse();
        h.prisma.moderationDeleteIntentReason.findMany.mockResolvedValue(reasons);
        await expect(h.service.assertIntentStillActionable(input)).rejects.toMatchObject({
          code: 'commercial_text_binding_invalid',
        });
        expect(h.max.getChatMemberAccess).not.toHaveBeenCalled();
        expect(h.max.getExactMessageRow).not.toHaveBeenCalled();
        const permit = h.service.createSanctionPermit({
          ...input,
          evidence: reasons,
          deleted: true,
          commercialVerified: true,
        })!;
        await expect(h.service.authorizeSanction(permit)).resolves.toBe(false);
        expect(h.max.getChatMemberAccess).not.toHaveBeenCalled();
      }
    },
  );

  it('treats required cohorts as a set and validates the coherent snapshot against current authority', async () => {
    const h = harness();
    const binding = buildCommercialTextDeleteBinding({
      text,
      settings: h.settings,
      eventTimestampMs: h.binding.eventTimestampMs,
      campaignContext: null,
      requiredPolicyCohorts: ['owned-service-contrast-v1', 'sliding-campaign-v1'],
    });
    const other = {
      ...binding,
      requiredPolicyCohorts: [...binding.requiredPolicyCohorts].reverse(),
    };
    h.prisma.moderationDeleteIntentReason.findMany.mockResolvedValue([
      { ...h.reason, metadata: { commercialTextBinding: binding } },
      {
        ...h.reason,
        reasonKey: `${h.reason.reasonKey}:coherent-policy`,
        metadata: { commercialTextBinding: other },
      },
    ]);
    await expect(h.service.assertIntentStillActionable(input)).rejects.toMatchObject({
      code: 'commercial_text_authority_changed',
    });
    expect(h.max.getExactMessageRow).not.toHaveBeenCalled();
    h.authority.promotedPolicyCohorts = ['owned-service-contrast-v1', 'sliding-campaign-v1'];
    await expect(h.service.assertIntentStillActionable(input)).resolves.toEqual({
      kind: 'allowed',
      reasonKeys: [h.reason.reasonKey, `${h.reason.reasonKey}:coherent-policy`],
    });
  });

  it.each([
    { version: 1 },
    { sourceSha256: 'invalid' },
    { extra: true },
    { campaignContext: { rawText: 'private' } },
  ])('rejects malformed bindings before network calls: %j', async (change) => {
    const h = harness();
    h.prisma.moderationDeleteIntentReason.findMany.mockResolvedValue([
      { ...h.reason, metadata: { commercialTextBinding: { ...h.binding, ...change } } },
    ]);
    await expect(h.service.assertIntentStillActionable(input)).rejects.toMatchObject({
      code: 'commercial_text_binding_invalid',
    });
    expect(h.max.getExactMessageRow).not.toHaveBeenCalled();
  });

  it.each([
    { decisionVersion: 'old' },
    { detectorSourceSha256: '0'.repeat(64) },
    { deadlineAtMs: 1 },
    { eventTimestampMs: Date.now() + 120_000 },
  ])('rejects obsolete behavior or deadlines: %j', async (change) => {
    const h = harness();
    h.prisma.moderationDeleteIntentReason.findMany.mockResolvedValue([
      { ...h.reason, metadata: { commercialTextBinding: { ...h.binding, ...change } } },
    ]);
    await expect(h.service.assertIntentStillActionable(input)).rejects.toMatchObject({
      code: 'commercial_text_binding_stale',
    });
  });

  it.each(['KEEP', null, 'UNKNOWN'])(
    'rejects explicit non-deletion metadata: %j',
    async (disposition) => {
      const h = harness();
      h.prisma.moderationDeleteIntentReason.findMany.mockResolvedValue([
        { ...h.reason, metadata: { messageDisposition: disposition } },
      ]);
      await expect(h.service.assertIntentStillActionable(input)).rejects.toMatchObject({
        code: 'commercial_text_binding_invalid',
      });
    },
  );

  it('rechecks a legacy decision without trusting unbound campaign evidence', async () => {
    const h = harness();
    h.prisma.moderationDeleteIntentReason.findMany.mockResolvedValue([
      { ...h.reason, metadata: { campaignContext: { senderDistinctChatCount: 999 } } },
    ]);
    const detect = jest.spyOn(CommercialAdDetector.prototype, 'detect');
    await expect(h.service.assertIntentStillActionable(input)).resolves.toMatchObject({
      kind: 'allowed',
    });
    expect(detect).toHaveBeenLastCalledWith(
      expect.objectContaining({ commercialCampaignContext: null }),
    );
    h.max.getExactMessageRow.mockResolvedValue(message('Ищу такси, кто сможет отвезти?'));
    await expect(h.service.assertIntentStillActionable(input)).rejects.toMatchObject({
      code: 'commercial_text_violation_no_longer_present',
    });
  });

  it('does not delete under weaker current evidence than the selected stored decision', async () => {
    const h = harness();
    h.prisma.moderationDeleteIntentReason.findMany.mockResolvedValue([{ ...h.reason, score: 1 }]);
    await expect(h.service.assertIntentStillActionable(input)).rejects.toMatchObject({
      code: 'commercial_text_violation_no_longer_present',
    });
  });

  it('checks disabled settings before MAX calls', async () => {
    const h = harness();
    h.settings.commercialAdsFilterEnabled = false;
    await expect(h.service.assertIntentStillActionable(input)).rejects.toMatchObject({
      code: 'commercial_text_settings_disabled',
    });
    expect(h.max.getChatMemberAccess).not.toHaveBeenCalled();
  });

  it.each(['commercialAdsWarnThreshold', 'textFiltersMuteDurationHours'] as const)(
    'rejects changed current policy: %s',
    async (key) => {
      const h = harness();
      h.settings[key] += 1;
      await expect(h.service.assertIntentStillActionable(input)).rejects.toMatchObject({
        code: 'commercial_text_binding_stale',
      });
    },
  );

  it('rechecks policy after MAX work and immunity', async () => {
    const h = harness();
    h.immunity.consumeForMessage.mockImplementation(async () => {
      h.settings.textFiltersBanEnabled = false;
      return 'not_granted';
    });
    await expect(h.service.assertIntentStillActionable(input)).rejects.toMatchObject({
      code: 'commercial_text_binding_stale',
    });
  });

  it('rechecks the absolute deadline after remote work', async () => {
    jest.useFakeTimers();
    const h = harness();
    h.max.getExactMessageRow.mockImplementation(async () => {
      jest.setSystemTime(h.binding.deadlineAtMs);
      return message();
    });
    await expect(h.service.assertIntentStillActionable(input)).rejects.toMatchObject({
      code: 'commercial_text_binding_stale',
    });
  });

  it.each(['bot', 'local-admin', 'remote-admin', 'participant'])(
    'protects current author access: %s',
    async (kind) => {
      const h = harness();
      if (kind === 'bot') h.botLink.isKnownBotUserId.mockReturnValue(true);
      if (kind === 'local-admin') h.settings.chat.admins.push({ userId: 'user' });
      if (kind === 'remote-admin')
        h.max.getChatMemberAccess.mockResolvedValue({
          userId: 'user',
          isAdmin: true,
          isOwner: false,
        });
      if (kind === 'participant') h.immunity.consumeForMessage.mockResolvedValue('granted');
      await expect(h.service.assertIntentStillActionable(input)).rejects.toMatchObject({
        code: 'commercial_text_author_immune',
      });
    },
  );

  it('does not leave an extant bound ad in the chat merely because its author left', async () => {
    const h = harness();
    h.max.getChatMemberAccess.mockResolvedValue(null);
    await expect(h.service.assertIntentStillActionable(input)).resolves.toEqual({
      kind: 'allowed',
      reasonKeys: [h.reason.reasonKey],
    });
    expect(h.max.getExactMessageRow).toHaveBeenCalledTimes(1);
    expect(h.immunity.consumeForMessage).toHaveBeenCalledTimes(1);
  });

  it('does not treat an unavailable membership check as a verified departure', async () => {
    const h = harness();
    h.max.getChatMemberAccess.mockRejectedValue(new Error('Invalid MAX chat members response'));
    await expect(h.service.assertIntentStillActionable(input)).rejects.toThrow(
      'Invalid MAX chat members response',
    );
    expect(h.max.getExactMessageRow).not.toHaveBeenCalled();
  });

  it('treats exact absence as absence, not proof for a new strike', async () => {
    const h = harness();
    h.max.getExactMessageRow.mockResolvedValue(null);
    await expect(h.service.assertIntentStillActionable(input)).resolves.toBe('absent');
    expect(h.immunity.consumeForMessage).not.toHaveBeenCalled();
  });

  it('propagates uncertain network failures for bounded retry', async () => {
    const h = harness();
    h.max.getExactMessageRow.mockRejectedValue(new Error('network timeout'));
    await expect(h.service.assertIntentStillActionable(input)).rejects.toThrow('network timeout');
  });

  it('preserves independent reasons and distinguishes a missing reason', async () => {
    const h = harness();
    h.prisma.moderationDeleteIntentReason.findMany.mockResolvedValue([
      { ...h.reason, ruleCode: 'LINK_BLOCKED_DELETE' },
      h.reason,
    ]);
    await expect(h.service.assertIntentStillActionable(input)).resolves.toBe('not_applicable');
    h.prisma.moderationDeleteIntentReason.findMany.mockResolvedValue([]);
    await expect(h.service.assertIntentStillActionable(input)).resolves.toBe('missing_reason');
    expect(h.max.getExactMessageRow).not.toHaveBeenCalled();
  });

  it('bounds reason fanout while preserving independently authorized deletion', async () => {
    const h = harness();
    h.prisma.moderationDeleteIntentReason.findMany.mockResolvedValue(
      Array.from({ length: 65 }, (_, index) => ({ ...h.reason, reasonKey: `reason-${index}` })),
    );
    await expect(h.service.assertIntentStillActionable(input)).rejects.toMatchObject({
      code: 'commercial_text_binding_invalid',
    });
    h.prisma.moderationDeleteIntentReason.findFirst.mockResolvedValue({ id: 'independent' });
    await expect(h.service.assertIntentStillActionable(input)).resolves.toBe('not_applicable');
    expect(h.max.getExactMessageRow).not.toHaveBeenCalled();
  });
});
