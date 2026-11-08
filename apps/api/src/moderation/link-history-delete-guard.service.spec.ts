import type { AutomaticDeleteAuthorAccessService } from '../max/automatic-delete-author-access.service';
import { ConfigService } from '@nestjs/config';

import { LinkHistoryDeleteGuardService } from './link-history-delete-guard.service';
import {
  LINK_BLOCKED_DELETE_RULE_CODE,
  LINK_HISTORY_RECOVERY_RULE_CODE,
  createMessageContentFingerprint,
} from './link-history-recovery.util';
import { adaptMaxMessageNavigationView } from './navigation/max-navigation-view.adapter';
import { fingerprintLinkRulesPolicy } from './link-rules-policy.runtime';
import { finalizeDeleteAuthority } from './moderation-delete-authority-preparation';

describe('LinkHistoryDeleteGuardService', () => {
  it.each(['live', 'history'] as const)(
    'uses saved admin immunity for %s without an author GET or absent-author roster request',
    async (reasonKind) => {
      const resolve = jest
        .fn<
          ReturnType<AutomaticDeleteAuthorAccessService['resolve']>,
          Parameters<AutomaticDeleteAuthorAccessService['resolve']>
        >()
        .mockResolvedValue({ initialized: true, revision: '1', isAdmin: false, member: undefined });
      const h = buildHarness({ reasonKind, remoteAccess: null, authorAccess: { resolve } });
      await expect(h.service.assertIntentStillActionable(baseInput)).resolves.toBe('allowed');
      expect(h.maxClient.getChatMemberAccess).not.toHaveBeenCalled();
      expect(h.maxClient.getChatAdminAccesses).not.toHaveBeenCalled();
      expect(h.maxClient.getExactMessageRow).toHaveBeenCalledTimes(1);
      expect(resolve).toHaveBeenCalledWith(
        'chat-1',
        'user-1',
        expect.objectContaining({ botId: 'delete-bot', bypassCache: true }),
        { requireMembership: false, module: 'links' },
      );
    },
  );

  it('keeps absent-author full-roster validation until saved authority is initialized', async () => {
    const resolve = jest
      .fn<
        ReturnType<AutomaticDeleteAuthorAccessService['resolve']>,
        Parameters<AutomaticDeleteAuthorAccessService['resolve']>
      >()
      .mockResolvedValue({ initialized: false, revision: null, isAdmin: false, member: null });
    const h = buildHarness({ authorAccess: { resolve } });
    await expect(h.service.assertIntentStillActionable(baseInput)).resolves.toBe('allowed');
    expect(h.maxClient.getChatAdminAccesses).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'rejects a saved administrator before source reads (initialized=%s)',
    async (initialized) => {
      const resolve = jest
        .fn<
          ReturnType<AutomaticDeleteAuthorAccessService['resolve']>,
          Parameters<AutomaticDeleteAuthorAccessService['resolve']>
        >()
        .mockResolvedValue({ initialized, revision: '1', isAdmin: true, member: undefined });
      const h = buildHarness({ reasonKind: 'live', authorAccess: { resolve } });
      await expect(h.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
        code: 'live_admin_immune',
      });
      expect(h.maxClient.getChatMemberAccess).not.toHaveBeenCalled();
      expect(h.maxClient.getChatAdminAccesses).not.toHaveBeenCalled();
      expect(h.maxClient.getExactMessageRow).not.toHaveBeenCalled();
    },
  );

  it.each(['live', 'history'] as const)(
    'enforces selected rules for %s and ignores the legacy allowlist after adoption',
    async (reasonKind) => {
      const linkRulesPolicy = {
        version: 1,
        mode: 'DENY_SELECTED',
        rules: [{ id: 'blocked', effect: 'DENY', kind: 'WEB_DOMAIN', target: 'blocked.example' }],
      };
      const harness = buildHarness({
        reasonKind,
        linkPolicy: 'ALLOWLIST_ONLY',
        allowlist: ['domain:blocked.example'],
        linkRulesPolicy,
      });
      await expect(harness.service.assertIntentStillActionable(baseInput)).resolves.toBe('allowed');
    },
  );

  it.each(['live', 'history'] as const)(
    'rejects malformed present policy for %s before remote authority',
    async (reasonKind) => {
      const harness = buildHarness({ reasonKind, linkRulesPolicy: { version: 999 } });
      await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
        code: `${reasonKind}_policy_inactive`,
      });
      expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
    },
  );

  it('revokes prepared deletion when the new rules change during transport admission even without a revised counter', async () => {
    const linkRulesPolicy = {
      version: 1,
      mode: 'DENY_SELECTED',
      rules: [{ id: 'blocked', effect: 'DENY', kind: 'WEB_DOMAIN', target: 'blocked.example' }],
    };
    const harness = buildHarness({ reasonKind: 'live', linkRulesPolicy });
    const prepared = await harness.service.prepareForDispatch(baseInput);
    const current = await harness.prisma.chatSettings.findUnique();
    harness.prisma.chatSettings.findUnique.mockResolvedValue({
      ...current,
      linkRulesPolicy: { ...linkRulesPolicy, rules: [] },
    });
    await expect(finalizeDeleteAuthority(prepared)).rejects.toMatchObject({
      code: 'live_policy_revision_changed',
    });
  });

  it('does not lend new-policy authority to a legacy reason without its policy fingerprint', async () => {
    const harness = buildHarness({
      reasonKind: 'live',
      linkRulesPolicy: { version: 1, mode: 'DENY_ALL', rules: [] },
      omitPolicyFingerprint: true,
    });
    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'live_policy_revision_changed',
    });
  });

  it.each([
    ['userinfo', 'https://allowed.example@blocked.example/path'],
    ['long path', `https://blocked.example/${'a'.repeat(3_000)}`],
    ['encoded Cyrillic path', `https://blocked.example/${'\u044f'.repeat(400)}`],
  ])('keeps a live %s violation actionable at dispatch', async (_name, text) => {
    const candidateRow = {
      ...buildPlainTextMessage(),
      body: { mid: 'message-1', text },
    };
    const harness = buildHarness({
      reasonKind: 'live',
      candidateRow,
      linkPolicy: 'ALLOWLIST_ONLY',
      allowlist: ['domain:allowed.example'],
    });

    await expect(harness.service.assertIntentStillActionable(baseInput)).resolves.toBe('allowed');
  });

  it('rechecks exact content, policy, allowlist and author access before deletion', async () => {
    const harness = buildHarness();

    await expect(harness.service.assertIntentStillActionable(baseInput)).resolves.toBe('allowed');

    expect(harness.maxClient.getExactMessageRow).toHaveBeenCalledWith(
      'chat-1',
      'message-1',
      expect.objectContaining({ botId: 'delete-bot', bypassCache: true }),
    );
    expect(harness.maxClient.getChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      'user-1',
      expect.objectContaining({ botId: 'delete-bot', bypassCache: true }),
    );
  });

  it('guards a live link intent even when history deletion is disabled', async () => {
    const harness = buildHarness({ reasonKind: 'live', deleteEnabled: false });

    await expect(harness.service.assertIntentStillActionable(baseInput)).resolves.toBe('allowed');
  });

  it('allows a live intent after an edit only when the exact message still violates', async () => {
    const harness = buildHarness({
      reasonKind: 'live',
      exactRow: buildMessage({ text: 'changed', url: 'https://changed.example/path' }),
    });

    await expect(harness.service.assertIntentStillActionable(baseInput)).resolves.toBe('allowed');
  });

  it('rejects a live intent after the clickable target was removed', async () => {
    const harness = buildHarness({ reasonKind: 'live', exactRow: buildMessageWithoutNavigation() });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'live_violation_no_longer_present',
    });
  });

  it.each(['live', 'history'] as const)(
    'rejects a pending %s link intent when the exact message is only a user mention',
    async (reasonKind) => {
      const row = buildProfileMentionMessage();
      const harness = buildHarness({ reasonKind, candidateRow: row });

      await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
        code:
          reasonKind === 'live'
            ? 'live_violation_no_longer_present'
            : 'history_violation_no_longer_present',
      });
    },
  );

  it('keeps an @-shaped MAX channel hyperlink actionable', async () => {
    const row = buildMessage({
      text: '@participant',
      url: 'https://max.ru/channels/blocked-channel',
    });
    const harness = buildHarness({ reasonKind: 'live', candidateRow: row });

    await expect(harness.service.assertIntentStillActionable(baseInput)).resolves.toBe('allowed');
  });

  it('keeps a custom-scheme hyperlink actionable at execution time', async () => {
    const row = buildMessage({
      text: '@participant',
      url: 'tg://resolve?domain=outside',
    });
    const harness = buildHarness({ reasonKind: 'live', candidateRow: row });

    await expect(harness.service.assertIntentStillActionable(baseInput)).resolves.toBe('allowed');
  });

  it('rejects a live intent recorded under an older policy revision', async () => {
    const harness = buildHarness({ reasonKind: 'live', settingsRevision: 2 });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'live_policy_revision_changed',
    });
  });

  it('keeps legacy live intents without a valid policy fence inert', async () => {
    const harness = buildHarness({ reasonKind: 'live', invalidLiveMetadata: true });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'live_reason_invalid',
    });
    expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
  });

  it('allows a live edit of a message that predates the current policy baseline', async () => {
    const effectiveAt = new Date();
    const harness = buildHarness({
      reasonKind: 'live',
      settingsEffectiveAt: effectiveAt,
      reasonEffectiveAt: effectiveAt,
      candidateRow: buildMessage({ timestamp: effectiveAt.getTime() - 60_000 }),
    });

    await expect(harness.service.assertIntentStillActionable(baseInput)).resolves.toBe('allowed');
  });

  it('rejects a live allowlist-only intent after the target becomes allowed', async () => {
    const harness = buildHarness({
      reasonKind: 'live',
      linkPolicy: 'ALLOWLIST_ONLY',
      allowlist: ['domain:blocked.example'],
    });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'live_violation_no_longer_present',
    });
  });

  it('rejects a live intent when the exact message author changes', async () => {
    const harness = buildHarness({
      reasonKind: 'live',
      exactRow: buildMessage({ senderId: 'user-2' }),
    });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'live_message_identity_changed',
    });
  });

  it('fails closed when exact content changed after the candidate was recorded', async () => {
    const harness = buildHarness({
      exactRow: buildMessage({ text: 'changed', url: 'https://changed.example' }),
    });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'history_content_changed',
    });
  });

  it('keeps persisted recovery intents inert while the delete flag is off', async () => {
    const harness = buildHarness({ deleteEnabled: false });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toEqual(
      expect.objectContaining({
        code: 'history_delete_disabled',
      }),
    );

    expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
  });

  it('preserves current administrator immunity at dispatch time', async () => {
    const harness = buildHarness({ adminUserIds: ['user-1'] });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'history_admin_immune',
    });
  });

  it('accepts exact absence only from the message-specific lookup', async () => {
    const harness = buildHarness({ exactRow: null });

    await expect(harness.service.assertIntentStillActionable(baseInput)).resolves.toBe('absent');
  });

  it('keeps an explicit plain-text HTTP URL actionable by default', async () => {
    const row = buildPlainTextMessage();
    const harness = buildHarness({ candidateRow: row });

    await expect(harness.service.assertIntentStillActionable(baseInput)).resolves.toBe('allowed');
  });

  it('keeps a fuzzy bare-domain candidate non-actionable by default', async () => {
    const row = buildBareDomainMessage();
    const harness = buildHarness({ candidateRow: row });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'history_violation_no_longer_present',
    });
  });

  it('allows a fuzzy bare-domain candidate after explicit opt-in', async () => {
    const row = buildBareDomainMessage();
    const harness = buildHarness({ candidateRow: row, textClickabilityEnabled: true });

    await expect(harness.service.assertIntentStillActionable(baseInput)).resolves.toBe('allowed');
  });

  it.each(['live', 'history'] as const)(
    'checks a fresh complete admin roster for an omitted %s author',
    async (reasonKind) => {
      const h = buildHarness({ remoteAccess: null, reasonKind });
      await expect(h.service.assertIntentStillActionable(baseInput)).resolves.toBe('allowed');
      expect(h.maxClient.getChatAdminAccesses).toHaveBeenCalledWith(
        'chat-1',
        expect.objectContaining({ botId: 'delete-bot', bypassCache: true }),
      );
      expect(h.maxClient.getExactMessageRow).toHaveBeenCalledTimes(1);
    },
  );

  it('protects every returned administrator even if its flags are omitted', async () => {
    const h = buildHarness({ remoteAccess: null });
    h.maxClient.getChatAdminAccesses.mockResolvedValue([{ userId: 'user-1' }]);
    await expect(h.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'history_admin_immune',
    });
    expect(h.maxClient.getExactMessageRow).not.toHaveBeenCalled();
  });

  it.each([403, 404, 429, 503, 'incomplete', 'malformed'])(
    'does not authorize through a failed admin roster (%s)',
    async (status) => {
      const h = buildHarness({ remoteAccess: null });
      const error = Object.assign(new Error(String(status)), { response: { status } });
      h.maxClient.getChatAdminAccesses.mockRejectedValue(error);
      await expect(h.service.assertIntentStillActionable(baseInput)).rejects.toBe(error);
      expect(h.maxClient.getExactMessageRow).not.toHaveBeenCalled();
    },
  );

  it('still requires the exact source author after roster fallback', async () => {
    const h = buildHarness({
      remoteAccess: null,
      exactRow: buildMessage({ senderId: 'another-user' }),
    });
    await expect(h.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'history_message_identity_changed',
    });
  });

  it('does not fall back after a member transport failure', async () => {
    const h = buildHarness();
    const error = Object.assign(new Error('member unavailable'), { response: { status: 404 } });
    h.maxClient.getChatMemberAccess.mockRejectedValue(error);
    await expect(h.service.assertIntentStillActionable(baseInput)).rejects.toBe(error);
    expect(h.maxClient.getChatAdminAccesses).not.toHaveBeenCalled();
  });

  it('invalidates an intent created before a scheduled allowlist expiry took effect', async () => {
    const now = Date.now();
    const scheduledAt = new Date(now - 10 * 60_000);
    const expiredAt = new Date(now - 2 * 60_000);
    const row = buildMessage({ timestamp: expiredAt.getTime() - 60_000 });
    const harness = buildHarness({
      candidateRow: row,
      settingsEffectiveAt: scheduledAt,
      reasonEffectiveAt: scheduledAt,
      expiredAllowlistAt: expiredAt,
      linkPolicy: 'ALLOWLIST_ONLY',
    });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'history_policy_revision_changed',
    });
  });

  it.each(['domain:example.com', 'https://apps.example.com/start'])(
    'keeps an open_app protected by the live %s matcher',
    async (allowlistEntry) => {
      const row = buildMiniAppMessage();
      const harness = buildHarness({
        candidateRow: row,
        linkPolicy: 'ALLOWLIST_ONLY',
        allowlist: [allowlistEntry],
      });

      await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
        code: 'history_violation_no_longer_present',
      });
    },
  );
});

const baseInput = {
  intentId: 'intent-1',
  chatId: 'chat-1',
  messageId: 'message-1',
  subjectUserId: 'user-1',
  botId: 'delete-bot',
};

function buildHarness(
  options: {
    exactRow?: Record<string, unknown> | null;
    candidateRow?: Record<string, unknown>;
    deleteEnabled?: boolean;
    adminUserIds?: string[];
    remoteAccess?: Record<string, unknown> | null;
    settingsEffectiveAt?: Date;
    reasonEffectiveAt?: Date;
    expiredAllowlistAt?: Date | null;
    linkPolicy?: 'ALLOWLIST_ONLY' | 'BLOCKLIST_ONLY';
    allowlist?: string[];
    reasonKind?: 'history' | 'live' | 'mixed';
    settingsRevision?: number;
    invalidLiveMetadata?: boolean;
    textClickabilityEnabled?: boolean;
    linkRulesPolicy?: unknown;
    omitPolicyFingerprint?: boolean;
    authorAccess?: Pick<AutomaticDeleteAuthorAccessService, 'resolve'>;
  } = {},
) {
  const effectiveAt = options.settingsEffectiveAt ?? new Date(Date.now() - 10 * 60_000);
  const reasonEffectiveAt = options.reasonEffectiveAt ?? effectiveAt;
  const defaultExactRow = options.candidateRow ?? buildMessage();
  const exactRow = Object.prototype.hasOwnProperty.call(options, 'exactRow')
    ? (options.exactRow ?? null)
    : defaultExactRow;
  const fingerprint = createMessageContentFingerprint(
    adaptMaxMessageNavigationView(defaultExactRow),
  );
  const policyFingerprint =
    !options.omitPolicyFingerprint && options.linkRulesPolicy != null
      ? { linkRulesPolicySha256: fingerprintLinkRulesPolicy(options.linkRulesPolicy) }
      : {};
  const historyReason = {
    reasonKey: 'history-reason',
    ruleCode: LINK_HISTORY_RECOVERY_RULE_CODE,
    metadata: {
      contentFingerprint: fingerprint,
      ...policyFingerprint,
      policyRevision: 1,
      policyEffectiveAt: reasonEffectiveAt.toISOString(),
    },
  };
  const liveReason = {
    reasonKey: 'live-reason',
    ruleCode: LINK_BLOCKED_DELETE_RULE_CODE,
    metadata: options.invalidLiveMetadata
      ? { reason: 'legacy reason without a policy fence' }
      : {
          linkPolicyRevision: 1,
          ...policyFingerprint,
          linkPolicyEffectiveAt: reasonEffectiveAt.toISOString(),
        },
  };
  const reasonKind = options.reasonKind ?? 'history';
  const prisma = {
    $transaction: jest.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
    moderationDeleteIntentReason: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          reasonKind === 'mixed'
            ? [liveReason, historyReason]
            : [reasonKind === 'live' ? liveReason : historyReason],
        ),
    },
    chatSettings: {
      findUnique: jest.fn().mockResolvedValue({
        linkPolicy: options.linkPolicy ?? 'BLOCKLIST_ONLY',
        linkRulesPolicy: options.linkRulesPolicy ?? null,
        linkPolicyRevision: options.settingsRevision ?? 1,
        linkPolicyEffectiveAt: effectiveAt,
        chat: {
          admins: (options.adminUserIds ?? []).map((userId) => ({ userId })),
        },
      }),
    },
    domainAllowlist: {
      findMany: jest
        .fn()
        .mockResolvedValue((options.allowlist ?? []).map((domain) => ({ domain }))),
      aggregate: jest.fn().mockResolvedValue({
        _max: { removeAfterAt: options.expiredAllowlistAt ?? null },
      }),
    },
  };
  const maxClient = {
    getChatAdminAccesses: jest
      .fn<Promise<Array<{ userId: string }>>, []>()
      .mockResolvedValue([{ userId: 'different-admin' }]),
    getExactMessageRow: jest.fn().mockResolvedValue(exactRow),
    getChatMemberAccess: jest.fn().mockResolvedValue(
      options.remoteAccess === undefined
        ? {
            userId: 'user-1',
            isAdmin: false,
            isOwner: false,
            permissions: [],
          }
        : options.remoteAccess,
    ),
  };
  const maxBotLinkService = {
    isKnownBotUserId: jest.fn().mockReturnValue(false),
  };
  const service = new LinkHistoryDeleteGuardService(
    prisma as never,
    maxClient as never,
    maxBotLinkService as never,
    new ConfigService({
      MODERATION_LINK_HISTORY_DELETE_ENABLED: options.deleteEnabled ?? true,
      MODERATION_LINK_TEXT_CLICKABILITY_ENABLED: options.textClickabilityEnabled ?? false,
    }),
    options.authorAccess as AutomaticDeleteAuthorAccessService | undefined,
  );
  return { service, prisma, maxClient, maxBotLinkService };
}

function buildMessage(
  options: { timestamp?: number; text?: string; url?: string; senderId?: string } = {},
): Record<string, unknown> {
  const text = options.text ?? 'site';
  return {
    id: 'message-1',
    timestamp: options.timestamp ?? Date.now() - 60_000,
    recipient: { chat_id: 'chat-1' },
    sender: { user_id: options.senderId ?? 'user-1', is_bot: false },
    body: {
      mid: 'message-1',
      text,
      markup: [
        {
          type: 'link',
          from: 0,
          length: text.length,
          url: options.url ?? 'https://blocked.example/path',
        },
      ],
    },
  };
}

function buildProfileMentionMessage(): Record<string, unknown> {
  const text = '@participant';
  return {
    id: 'message-1',
    timestamp: Date.now() - 60_000,
    recipient: { chat_id: 'chat-1' },
    sender: { user_id: 'user-1', is_bot: false },
    body: {
      mid: 'message-1',
      text,
      markup: [
        {
          type: 'user_mention',
          from: 0,
          length: text.length,
          user_id: 67123224,
        },
      ],
    },
  };
}

function buildPlainTextMessage(): Record<string, unknown> {
  return {
    id: 'message-1',
    timestamp: Date.now() - 60_000,
    recipient: { chat_id: 'chat-1' },
    sender: { user_id: 'user-1', is_bot: false },
    body: {
      mid: 'message-1',
      text: 'Visit https://example.com/blocked',
    },
  };
}

function buildBareDomainMessage(): Record<string, unknown> {
  return {
    id: 'message-1',
    timestamp: Date.now() - 60_000,
    recipient: { chat_id: 'chat-1' },
    sender: { user_id: 'user-1', is_bot: false },
    body: {
      mid: 'message-1',
      text: 'Visit example.com/blocked',
    },
  };
}

function buildMessageWithoutNavigation(): Record<string, unknown> {
  return {
    id: 'message-1',
    timestamp: Date.now() - 60_000,
    recipient: { chat_id: 'chat-1' },
    sender: { user_id: 'user-1', is_bot: false },
    body: {
      mid: 'message-1',
      text: 'ordinary text',
    },
  };
}

function buildMiniAppMessage(): Record<string, unknown> {
  return {
    id: 'message-1',
    timestamp: Date.now() - 60_000,
    recipient: { chat_id: 'chat-1' },
    sender: { user_id: 'user-1', is_bot: false },
    body: {
      mid: 'message-1',
      text: 'Open app',
      attachments: [
        {
          type: 'inline_keyboard',
          payload: {
            buttons: [
              [
                {
                  type: 'open_app',
                  text: 'Open',
                  web_app: 'https://apps.example.com/start',
                },
              ],
            ],
          },
        },
      ],
    },
  };
}
