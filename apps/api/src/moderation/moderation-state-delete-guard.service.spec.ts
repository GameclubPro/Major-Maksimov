import type { AutomaticDeleteAuthorAccessService } from '../max/automatic-delete-author-access.service';
import { bindStateVoiceSource } from './state-voice-delete-source';
import { ConfigService } from '@nestjs/config';
import { ModerationStateDeleteGuardService } from './moderation-state-delete-guard.service';

function fixture({
  ruleCode = 'MUTE_ACTIVE_DELETE',
  authorAccess,
}: {
  ruleCode?: string;
  authorAccess?: Pick<AutomaticDeleteAuthorAccessService, 'resolve'>;
} = {}) {
  const at = new Date();
  const settings = {
    nightModeTimezone: 'UTC',
    muteDurationHours: 1,
    deleteSpammersEnabled: true,
    removeBotsFromGroupEnabled: true,
    chat: { entityType: 'CHAT', admins: [] as { userId: string }[] },
  };
  const event = {
    id: 'mute-1',
    action: 'MUTE',
    createdAt: at,
    metadata: { muteExpiresAt: new Date(at.getTime() + 60_000).toISOString() },
  };
  const input = {
    chatId: '-123',
    messageId: 'm1',
    subjectUserId: 'user-1',
    botId: 'peer-2',
    reasons: [{ ruleCode, reasonKey: 'state', metadata: { muteEventId: 'mute-1' } }],
  };
  const prisma = {
    chatSettings: { findUnique: jest.fn(async () => settings) },
    moderationEvent: { findFirst: jest.fn(async () => event) },
    adminGlobalSpammerExemption: { findMany: jest.fn(async () => [] as { decision: string }[]) },
    moderationDeleteIntent: { findUnique: jest.fn(async () => null as unknown) },
    moderationDeleteIntentReason: { findUnique: jest.fn(async () => null as unknown) },
  };
  const max = {
    getChatMemberAccess: jest.fn(async () => ({
      userId: 'user-1',
      isAdmin: false,
      isOwner: false,
    })),
    getExactMessageRow: jest.fn(
      async () =>
        ({
          sender: { user_id: 'user-1', is_bot: true },
          recipient: { chat_id: '-123', chat_type: 'chat' },
          timestamp: at.getTime(),
          body: { mid: 'm1', text: 'hello' },
        }) as unknown,
    ),
  };
  const immunity = { consumeForMessage: jest.fn(async () => 'not_granted') };
  const bots = { isKnownBotUserId: jest.fn(() => false) };
  const fence = { isSanctionEventInvalidated: jest.fn(async () => false) };
  const policy = {
    evaluatePolicy: jest.fn(async () => ({
      action: 'DELETE_AND_KICK',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    })),
  };
  const service = new ModerationStateDeleteGuardService(
    prisma as never,
    max as never,
    bots as never,
    immunity as never,
    fence as never,
    policy as never,
    new ConfigService(),
    undefined,
    authorAccess as AutomaticDeleteAuthorAccessService | undefined,
  );
  return { service, input, settings, prisma, max, immunity, bots, fence, event, policy, at };
}

describe('current moderation state delete authorization', () => {
  it.each([false, true])(
    'uses saved roles without fabricating state-delete membership, absent=%s',
    async (absent) => {
      const resolve = jest
        .fn<
          ReturnType<AutomaticDeleteAuthorAccessService['resolve']>,
          Parameters<AutomaticDeleteAuthorAccessService['resolve']>
        >()
        .mockResolvedValue({
          initialized: true,
          revision: '1',
          isAdmin: false,
          member: absent
            ? null
            : { userId: 'user-1', isAdmin: true, isOwner: false, permissions: [] },
        });
      const h = fixture({ authorAccess: { resolve } });
      if (absent) {
        await expect(h.service.authorize(h.input)).rejects.toMatchObject({
          code: 'moderation_state_delete_no_longer_authorized',
        });
        expect(h.max.getExactMessageRow).not.toHaveBeenCalled();
        expect(h.immunity.consumeForMessage).not.toHaveBeenCalled();
      } else {
        await expect(h.service.authorize(h.input)).resolves.toMatchObject({
          reasonKeys: ['state'],
        });
      }
      expect(h.max.getChatMemberAccess).not.toHaveBeenCalled();
    },
  );

  it('keeps fresh member-mutation authority independent of the saved DELETE role', async () => {
    const resolve = jest
      .fn<
        ReturnType<AutomaticDeleteAuthorAccessService['resolve']>,
        Parameters<AutomaticDeleteAuthorAccessService['resolve']>
      >()
      .mockResolvedValue({ initialized: true, revision: '1', isAdmin: false, member: undefined });
    const h = fixture({ authorAccess: { resolve } });
    h.max.getChatMemberAccess.mockResolvedValue({
      userId: 'user-1',
      isAdmin: true,
      isOwner: false,
    });
    await expect(
      h.service.assertSpammerMemberAllowed({
        chatId: '-123',
        userId: 'user-1',
        messageId: 'm1',
        botId: 'peer-2',
        localBlock: true,
      }),
    ).rejects.toMatchObject({ code: 'moderation_state_delete_no_longer_authorized' });
    expect(h.max.getChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each([
    'MUTE_ACTIVE_DELETE',
    'GLOBAL_SPAMMER_MESSAGE_DELETE',
    'LOCAL_ADMIN_BLOCK_MESSAGE_DELETE',
    'BOT_ACCOUNT_MESSAGE_DELETE',
    'INVITATION_ACCESS_DELETE',
  ])(
    'rejects expired %s before unavailable remote reads or immunity consumption',
    async (ruleCode) => {
      const s = fixture({ ruleCode });
      s.max.getChatMemberAccess.mockRejectedValue(new Error('MAX unavailable'));
      s.max.getExactMessageRow.mockRejectedValue(new Error('Source unavailable'));
      await expect(
        s.service.authorize({
          ...s.input,
          sourceMessageAt: new Date(Date.now() - 300_001),
        }),
      ).rejects.toMatchObject({ code: 'moderation_state_delete_no_longer_authorized' });
      expect(s.max.getChatMemberAccess).not.toHaveBeenCalled();
      expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
    },
  );

  it.each(['released', 'expired', 'replaced', 'fenced', 'disabled', 'retired'])(
    'preserves the participant quota for a no-longer-actionable %s reason',
    async (variant) => {
      const s = fixture({
        ruleCode:
          variant === 'disabled'
            ? 'BOT_ACCOUNT_MESSAGE_DELETE'
            : variant === 'retired'
              ? 'INVITATION_ACCESS_DELETE'
              : 'MUTE_ACTIVE_DELETE',
      });
      if (variant === 'released') Object.assign(s.event, { action: 'NONE', id: 'release' });
      if (variant === 'expired') s.event.metadata.muteExpiresAt = new Date(0).toISOString();
      if (variant === 'replaced') s.event.id = 'new-mute';
      if (variant === 'fenced') s.fence.isSanctionEventInvalidated.mockResolvedValue(true);
      if (variant === 'disabled') s.settings.removeBotsFromGroupEnabled = false;
      // FLAG: A positive grant must not hide an obsolete reason by spending its quota.
      s.immunity.consumeForMessage.mockResolvedValue('granted');

      await expect(s.service.authorize(s.input)).rejects.toMatchObject({
        code: 'moderation_state_delete_no_longer_authorized',
      });
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
    },
  );

  function voiceFixture() {
    const s = fixture();
    const source = {
      kind: 'created' as const,
      chatId: s.input.chatId,
      messageId: s.input.messageId,
      userId: s.input.subjectUserId,
      sourceAtMs: s.at.getTime(),
      deadlineAtMs: s.at.getTime() + 300_000,
    };
    const stored = {
      ...source,
      sourceAt: s.at,
      deadlineAt: new Date(source.deadlineAtMs),
      receiptId: 'authenticated-receipt',
      invalidatedAt: null as Date | null,
    };
    const read = jest.fn(async () => stored as typeof stored | null);
    Object.assign(s.prisma, { moderationVoiceSource: { findUnique: read } });
    const bound = bindStateVoiceSource(
      {
        ...s.input,
        reasonKey: 'state',
        ruleCode: 'MUTE_ACTIVE_DELETE',
        sourceMessageAt: s.at,
        event: { metadata: s.input.reasons[0]!.metadata },
      },
      source,
    );
    const input = {
      ...s.input,
      sourceMessageAt: s.at,
      reasons: [{ ...s.input.reasons[0]!, metadata: bound.event!.metadata }],
    };
    s.max.getExactMessageRow.mockRejectedValue(new Error('Voice unavailable through GET'));
    return { ...s, input, stored, read };
  }
  it('uses exact authenticated voice identity while retaining the mute expiry and current rights', async () => {
    const s = voiceFixture();
    await expect(s.service.authorize(s.input)).resolves.toMatchObject({
      reasonKeys: ['state'],
      deadlineAtMs: Date.parse(s.event.metadata.muteExpiresAt),
    });
    expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
    expect(s.max.getChatMemberAccess).toHaveBeenCalled();
    expect(s.read).toHaveBeenCalledTimes(2);
  });
  it.each([
    'missing',
    'edited',
    'author',
    'time',
    'receipt',
    'extended',
    'expired',
    'history',
    'rule',
    'admin',
    'immunity',
    'released',
  ])('refuses voice source with %s evidence', async (variant) => {
    const s = voiceFixture();
    if (variant === 'missing') s.read.mockResolvedValue(null);
    if (variant === 'edited') s.stored.invalidatedAt = new Date();
    if (variant === 'author') s.stored.userId = 'other';
    if (variant === 'time') s.stored.sourceAt = new Date(s.at.getTime() - 1);
    if (variant === 'receipt') s.stored.receiptId = '';
    if (variant === 'extended') s.stored.deadlineAt = new Date(s.at.getTime() + 400_000);
    if (variant === 'expired') s.stored.deadlineAt = new Date(0);
    if (variant === 'history')
      Object.assign(s.input.reasons[0]!.metadata as object, { automaticMuteCleanupId: 'mute-1' });
    if (variant === 'rule')
      Object.assign(s.input.reasons[0]!.metadata as object, {
        stateVoiceSourceRuleCode: 'NIGHT_MODE_DELETE',
      });
    if (variant === 'admin')
      s.max.getChatMemberAccess.mockResolvedValue({
        userId: 'user-1',
        isAdmin: true,
        isOwner: false,
      });
    if (variant === 'immunity') s.immunity.consumeForMessage.mockResolvedValue('granted');
    if (variant === 'released') s.event.id = 'manual-release';
    await expect(s.service.authorize(s.input)).rejects.toMatchObject({
      code: 'moderation_state_delete_no_longer_authorized',
    });
    expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
  });
  it.each(['edit', 'release', 'release-fence'])(
    'rechecks voice authority after final awaited work: %s',
    async (change) => {
      const s = voiceFixture();
      await expect(
        s.service.authorize({
          ...s.input,
          beforeFinalAuthority: async () => {
            if (change === 'edit') s.stored.invalidatedAt = new Date();
            if (change === 'release') s.event.id = 'manual-release';
            if (change === 'release-fence')
              s.fence.isSanctionEventInvalidated.mockResolvedValue(true);
          },
        }),
      ).rejects.toMatchObject({ code: 'moderation_state_delete_no_longer_authorized' });
    },
  );
  it('does not lend voice identity to an unrelated bot-account reason', async () => {
    const s = voiceFixture();
    await expect(
      s.service.authorize({
        ...s.input,
        reasons: [
          ...s.input.reasons,
          { ruleCode: 'BOT_ACCOUNT_MESSAGE_DELETE', reasonKey: 'bot', metadata: {} },
        ],
      }),
    ).resolves.toMatchObject({ reasonKeys: ['state'] });
  });
  it('rechecks ordinary mute release after the final asynchronous callback', async () => {
    const s = fixture();
    await expect(
      s.service.authorize({
        ...s.input,
        beforeFinalAuthority: async () => {
          s.event.id = 'manual-release';
        },
      }),
    ).rejects.toMatchObject({ code: 'moderation_state_delete_no_longer_authorized' });
  });

  it('verifies the exact durable mute identity and current fence', async () => {
    const s = fixture();
    await expect(s.service.authorize(s.input)).resolves.toMatchObject({ reasonKeys: ['state'] });
    expect(s.fence.isSanctionEventInvalidated).toHaveBeenCalledWith(
      expect.objectContaining({ sanctionEventId: 'mute-1' }),
    );
  });
  it.each(['expired', 'unmuted', 'replaced', 'prepared-release', 'immunity', 'admin'])(
    'cancels a queued mute delete after %s',
    async (change) => {
      const s = fixture();
      if (change === 'expired')
        s.event.metadata.muteExpiresAt = new Date(Date.now() - 1).toISOString();
      if (change === 'unmuted') s.event.action = 'NONE';
      if (change === 'replaced') s.event.id = 'mute-new';
      if (change === 'prepared-release') s.fence.isSanctionEventInvalidated.mockResolvedValue(true);
      if (change === 'immunity') s.immunity.consumeForMessage.mockResolvedValue('granted');
      if (change === 'admin')
        s.max.getChatMemberAccess.mockResolvedValue({
          userId: 'user-1',
          isAdmin: true,
          isOwner: false,
        });
      await expect(s.service.authorize(s.input)).rejects.toMatchObject({
        code: 'moderation_state_delete_no_longer_authorized',
      });
    },
  );
  it('revokes a mute that expires during the final awaited fence read', async () => {
    const s = fixture();
    s.fence.isSanctionEventInvalidated.mockImplementation(async () => {
      s.event.metadata.muteExpiresAt = new Date(Date.now() - 1).toISOString();
      jest.spyOn(Date, 'now').mockReturnValue(Date.parse(s.event.metadata.muteExpiresAt) + 60_001);
      return false;
    });
    try {
      await expect(s.service.authorize(s.input)).rejects.toMatchObject({
        code: 'moderation_state_delete_no_longer_authorized',
      });
    } finally {
      jest.restoreAllMocks();
    }
  });
  it('returns the original absolute mute expiry and yields expired mute to a valid bot policy', async () => {
    const s = fixture();
    const deadlineAtMs = Date.parse(s.event.metadata.muteExpiresAt);
    await expect(s.service.authorize(s.input)).resolves.toMatchObject({ deadlineAtMs });
    s.event.metadata.muteExpiresAt = new Date(Date.now() - 1).toISOString();
    await expect(
      s.service.authorize({
        ...s.input,
        reasons: [
          ...s.input.reasons,
          { ruleCode: 'BOT_ACCOUNT_MESSAGE_DELETE', reasonKey: 'bot', metadata: {} as never },
        ],
      }),
    ).resolves.toMatchObject({ reasonKeys: ['bot'] });
  });
  it('checks active global policy with cache bypass and honors current local ALLOW', async () => {
    const s = fixture({ ruleCode: 'GLOBAL_SPAMMER_MESSAGE_DELETE' });
    await expect(s.service.authorize(s.input)).resolves.toMatchObject({ reasonKeys: ['state'] });
    expect(s.policy.evaluatePolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        recordDecision: false,
        skipRuntimeProfileWrite: true,
        lookupContext: expect.any(Object),
      }),
    );
    s.prisma.adminGlobalSpammerExemption.findMany.mockResolvedValue([{ decision: 'ALLOW' }]);
    await expect(s.service.authorize(s.input)).rejects.toMatchObject({
      code: 'moderation_state_delete_no_longer_authorized',
    });
  });
  function heldGlobalReader() {
    return {
      isMessageHeld: jest.fn().mockResolvedValue(false),
      isMemberHeld: jest.fn().mockResolvedValue(false),
      isGlobalUserHeld: jest.fn().mockResolvedValue(true),
    };
  }
  it('rejects held global-only deletion before reading MAX or spending immunity', async () => {
    const s = fixture({ ruleCode: 'GLOBAL_SPAMMER_MESSAGE_DELETE' });
    Object.assign(s.service, { legacyHolds: heldGlobalReader() });
    await expect(s.service.authorize(s.input)).rejects.toMatchObject({
      code: 'moderation_state_delete_no_longer_authorized',
    });
    expect(s.max.getChatMemberAccess).not.toHaveBeenCalled();
    expect(s.max.getExactMessageRow).not.toHaveBeenCalled();
    expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
    expect(s.policy.evaluatePolicy).not.toHaveBeenCalled();
  });
  it('keeps an independent local mute reason after dropping held global authority', async () => {
    const s = fixture();
    Object.assign(s.service, { legacyHolds: heldGlobalReader() });
    await expect(
      s.service.authorize({
        ...s.input,
        reasons: [
          ...s.input.reasons,
          { ruleCode: 'GLOBAL_SPAMMER_MESSAGE_DELETE', reasonKey: 'global', metadata: {} as never },
        ],
      }),
    ).resolves.toMatchObject({ reasonKeys: ['state'] });
    expect(s.policy.evaluatePolicy).not.toHaveBeenCalled();
  });
  it('fails closed on global hold lookup loss without spending immunity', async () => {
    const s = fixture({ ruleCode: 'GLOBAL_SPAMMER_MESSAGE_DELETE' });
    const reader = heldGlobalReader();
    reader.isGlobalUserHeld.mockRejectedValue(new Error('Hold store unavailable'));
    Object.assign(s.service, { legacyHolds: reader });
    await expect(s.service.authorize(s.input)).rejects.toThrow('Hold store unavailable');
    expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
    expect(s.max.getChatMemberAccess).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'denies held spammer member authority before immunity (localBlock=%s)',
    async (localBlock) => {
      const s = fixture();
      Object.assign(s.service, { legacyHolds: heldGlobalReader() });
      await expect(
        s.service.assertSpammerMemberAllowed({
          chatId: s.input.chatId,
          userId: s.input.subjectUserId,
          messageId: s.input.messageId,
          localBlock,
        }),
      ).rejects.toMatchObject({ code: 'moderation_state_delete_no_longer_authorized' });
      expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
      expect(s.max.getChatMemberAccess).not.toHaveBeenCalled();
    },
  );
  it('expires a spammer member permit during selected executor revalidation', async () => {
    const s = fixture({ ruleCode: 'GLOBAL_SPAMMER_MESSAGE_DELETE' });
    const expiresAtMs = Date.now() + 1_000;
    s.policy.evaluatePolicy.mockResolvedValue({
      action: 'DELETE_AND_KICK',
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
    const beforeFinalAuthority = jest.fn(async () => {
      jest.spyOn(Date, 'now').mockReturnValue(expiresAtMs);
    });
    try {
      await expect(
        s.service.assertSpammerMemberAllowed({
          chatId: s.input.chatId,
          userId: s.input.subjectUserId,
          messageId: s.input.messageId,
          botId: s.input.botId,
          localBlock: false,
          beforeFinalAuthority,
        }),
      ).rejects.toMatchObject({ code: 'moderation_state_delete_no_longer_authorized' });
      expect(beforeFinalAuthority).toHaveBeenCalledTimes(1);
    } finally {
      jest.restoreAllMocks();
    }
  });
  it('propagates selected executor demotion before the final bot-account permit', async () => {
    const s = fixture({ ruleCode: 'BOT_ACCOUNT_MESSAGE_DELETE' });
    const demoted = new Error('Selected executor is no longer capable');
    const beforeFinalAuthority = jest.fn(async () => {
      throw demoted;
    });
    await expect(s.service.authorize({ ...s.input, beforeFinalAuthority })).rejects.toBe(demoted);
    expect(beforeFinalAuthority).toHaveBeenCalledTimes(1);
  });
  it('rejects a bot-account setting changed while revalidating the selected executor', async () => {
    const s = fixture({ ruleCode: 'BOT_ACCOUNT_MESSAGE_DELETE' });
    s.prisma.chatSettings.findUnique.mockImplementation(async () => structuredClone(s.settings));
    await expect(
      s.service.authorize({
        ...s.input,
        beforeFinalAuthority: async () => {
          s.settings.removeBotsFromGroupEnabled = false;
        },
      }),
    ).rejects.toMatchObject({ code: 'moderation_state_delete_no_longer_authorized' });
  });
  it('revokes a local BLOCK when it changes to ALLOW', async () => {
    const s = fixture({ ruleCode: 'LOCAL_ADMIN_BLOCK_MESSAGE_DELETE' });
    s.prisma.adminGlobalSpammerExemption.findMany.mockResolvedValue([{ decision: 'BLOCK' }]);
    await expect(s.service.authorize(s.input)).resolves.toMatchObject({ reasonKeys: ['state'] });
    s.prisma.adminGlobalSpammerExemption.findMany.mockResolvedValue([{ decision: 'ALLOW' }]);
    await expect(s.service.authorize(s.input)).rejects.toMatchObject({
      code: 'moderation_state_delete_no_longer_authorized',
    });
  });
  it('protects newly configured runtime bot accounts and rejects retired invitation work', async () => {
    const s = fixture({ ruleCode: 'BOT_ACCOUNT_MESSAGE_DELETE' });
    await expect(s.service.authorize(s.input)).resolves.toMatchObject({ reasonKeys: ['state'] });
    s.bots.isKnownBotUserId.mockReturnValue(true);
    await expect(s.service.authorize(s.input)).rejects.toMatchObject({
      code: 'moderation_state_delete_no_longer_authorized',
    });
    s.bots.isKnownBotUserId.mockReturnValue(false);
    await expect(
      s.service.authorize({
        ...s.input,
        reasons: [{ ...s.input.reasons[0]!, ruleCode: 'INVITATION_ACCESS_DELETE' }],
      }),
    ).rejects.toMatchObject({ code: 'moderation_state_delete_no_longer_authorized' });
  });
  it('permits absent-source bot KICK only after its own verified durable bot-author receipt', async () => {
    const s = fixture({ ruleCode: 'BOT_ACCOUNT_MESSAGE_DELETE' });
    s.max.getExactMessageRow.mockResolvedValue(null);
    await expect(
      s.service.authorize({
        ...s.input,
        allowAbsentWithOwnedReceipt: true,
        sourceMessageAt: s.at,
      }),
    ).rejects.toMatchObject({ code: 'moderation_state_delete_no_longer_authorized' });
    s.prisma.moderationDeleteIntent.findUnique.mockResolvedValue({
      id: 'intent-1',
      status: 'SUCCEEDED',
      subjectUserId: s.input.subjectUserId,
      sourceMessageAt: s.at,
    });
    s.prisma.moderationDeleteIntentReason.findUnique.mockResolvedValue({
      ruleCode: 'BOT_ACCOUNT_MESSAGE_DELETE',
      userId: s.input.subjectUserId,
      metadata: { moderationDeleteVerified: true, botAccountAuthorVerified: true },
    });
    await expect(
      s.service.authorize({
        ...s.input,
        allowAbsentWithOwnedReceipt: true,
        sourceMessageAt: s.at,
      }),
    ).resolves.toMatchObject({ reasonKeys: ['state'] });
    expect(s.prisma.moderationDeleteIntentReason.findUnique).toHaveBeenCalledWith({
      where: { intentId_reasonKey: { intentId: 'intent-1', reasonKey: 'state' } },
      select: { ruleCode: true, userId: true, metadata: true },
    });
    s.settings.removeBotsFromGroupEnabled = false;
    await expect(
      s.service.authorize({
        ...s.input,
        allowAbsentWithOwnedReceipt: true,
        sourceMessageAt: s.at,
      }),
    ).rejects.toMatchObject({ code: 'moderation_state_delete_no_longer_authorized' });
  });
  it.each(['pending', 'foreign-author', 'different-source', 'unverified-reason', 'foreign-reason'])(
    'rejects an absent-source follow-up with %s evidence',
    async (change) => {
      const s = fixture({ ruleCode: 'BOT_ACCOUNT_MESSAGE_DELETE' });
      s.max.getExactMessageRow.mockResolvedValue(null);
      s.prisma.moderationDeleteIntent.findUnique.mockResolvedValue({
        id: 'intent-1',
        status: change === 'pending' ? 'PENDING' : 'SUCCEEDED',
        subjectUserId: change === 'foreign-author' ? 'other-user' : s.input.subjectUserId,
        sourceMessageAt: change === 'different-source' ? new Date(s.at.getTime() - 1) : s.at,
      });
      s.prisma.moderationDeleteIntentReason.findUnique.mockResolvedValue({
        ruleCode: 'BOT_ACCOUNT_MESSAGE_DELETE',
        userId: change === 'foreign-reason' ? 'other-user' : s.input.subjectUserId,
        metadata: {
          moderationDeleteVerified: change !== 'unverified-reason',
          botAccountAuthorVerified: true,
        },
      });
      await expect(
        s.service.authorize({
          ...s.input,
          allowAbsentWithOwnedReceipt: true,
          sourceMessageAt: s.at,
        }),
      ).rejects.toMatchObject({ code: 'moderation_state_delete_no_longer_authorized' });
    },
  );
});
