import { ConfigService } from '@nestjs/config';

import {
  LinkHistoryRecoveryService,
  createMessageContentFingerprint,
  parseLinkHistoryListedMessage,
  resolveLinkHistoryScanWindow,
} from './link-history-recovery.service';
import { adaptMaxMessageNavigationView } from './navigation/max-navigation-view.adapter';

const ORIGINAL_SERVICE_NAME = process.env.APP_SERVICE_NAME;

describe('LinkHistoryRecoveryService', () => {
  it('uses adopted selective rules and ignores frozen legacy exceptions', async () => {
    const now = Date.now();
    const row = buildLinkedMessage(now - 60_000);
    const harness = buildHarness({
      now,
      listRows: [row],
      exactRow: row,
      deleteEnabled: true,
      linkPolicy: 'ALLOWLIST_ONLY',
      allowlist: ['domain:blocked.example'],
      expiredAllowlistAt: new Date(now - 30_000),
      linkRulesPolicy: {
        version: 1,
        mode: 'DENY_SELECTED',
        rules: [{ id: 'deny', effect: 'DENY', kind: 'WEB_DOMAIN', target: 'blocked.example' }],
      },
    });
    await harness.service.runOnce();
    expect(harness.deleteIntents.ensureIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          metadata: expect.objectContaining({
            linkRulesPolicySha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
          }),
        }),
      }),
    );
  });

  it('never turns an unsupported new policy into legacy history authority', async () => {
    const now = Date.now();
    const row = buildLinkedMessage(now - 60_000);
    const harness = buildHarness({
      now,
      listRows: [row],
      exactRow: row,
      deleteEnabled: true,
      linkRulesPolicy: { version: 999 },
    });
    await harness.service.runOnce();
    expect(harness.maxClient.listMessages).not.toHaveBeenCalled();
    expect(harness.deleteIntents.ensureIntent).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    process.env.APP_SERVICE_NAME = 'api-moderation-background';
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (ORIGINAL_SERVICE_NAME === undefined) {
      delete process.env.APP_SERVICE_NAME;
    } else {
      process.env.APP_SERVICE_NAME = ORIGINAL_SERVICE_NAME;
    }
  });

  it('reloads a structured candidate exactly before creating a delete-only intent', async () => {
    const now = Date.now();
    const row = buildLinkedMessage(now - 60_000);
    const harness = buildHarness({ now, listRows: [row], exactRow: row, deleteEnabled: true });

    await expect(harness.service.runOnce()).resolves.toBe(true);

    expect(harness.maxClient.listMessages).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        from: expect.any(Date),
        to: expect.any(Date),
        trafficClass: 'background',
        sourceTag: 'link_history_recovery',
        botId: 'scan-bot',
      }),
    );
    expect(harness.maxClient.getExactMessageRow).toHaveBeenCalledWith(
      'chat-1',
      'message-1',
      expect.objectContaining({ botId: 'scan-bot', bypassCache: true }),
    );
    expect(harness.deleteIntents.ensureIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        messageId: 'message-1',
        subjectUserId: 'user-1',
        ruleCode: 'LINK_HISTORY_RECOVERY',
        messageAuthorKind: 'user',
      }),
    );
    expect(harness.maxClient.getExactMessageRow.mock.invocationCallOrder[0]).toBeLessThan(
      harness.deleteIntents.ensureIntent.mock.invocationCallOrder[0]!,
    );
  });

  it('keeps scan-only rollout from creating deletion intents', async () => {
    const now = Date.now();
    const row = buildLinkedMessage(now - 60_000);
    const harness = buildHarness({ now, listRows: [row], exactRow: row, deleteEnabled: false });

    await harness.service.runOnce();

    expect(harness.maxClient.getExactMessageRow).toHaveBeenCalledTimes(1);
    expect(harness.maxClient.getChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(harness.deleteIntents.ensureIntent).not.toHaveBeenCalled();
  });

  it('does not create a history deletion intent for a platform user mention', async () => {
    const now = Date.now();
    const row = buildProfileMentionMessage(now - 60_000);
    const harness = buildHarness({ now, listRows: [row], exactRow: row, deleteEnabled: true });

    await harness.service.runOnce();

    expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
    expect(harness.maxClient.getChatMemberAccess).not.toHaveBeenCalled();
    expect(harness.deleteIntents.ensureIntent).not.toHaveBeenCalled();
  });

  it('recovers a custom-scheme link markup target', async () => {
    const now = Date.now();
    const row = buildLinkedMessage(now - 60_000, 'tg://resolve?domain=outside');
    const harness = buildHarness({ now, listRows: [row], exactRow: row, deleteEnabled: true });

    await harness.service.runOnce();

    expect(harness.maxClient.getExactMessageRow).toHaveBeenCalledTimes(1);
    expect(harness.deleteIntents.ensureIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'message-1',
        ruleCode: 'LINK_HISTORY_RECOVERY',
      }),
    );
  });

  it.each(['http://example.com/blocked', 'https://example.com/blocked'])(
    'recovers an explicit plain-text URL by default: %s',
    async (target) => {
      const now = Date.now();
      const row = buildPlainTextLinkedMessage(now - 60_000, `Visit ${target}`);
      const harness = buildHarness({ now, listRows: [row], exactRow: row, deleteEnabled: true });

      await harness.service.runOnce();

      expect(harness.maxClient.getExactMessageRow).toHaveBeenCalledTimes(1);
      expect(harness.deleteIntents.ensureIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'message-1',
          ruleCode: 'LINK_HISTORY_RECOVERY',
        }),
      );
    },
  );

  it('keeps a bare-domain plain-text history target shadow-only by default', async () => {
    const now = Date.now();
    const row = buildPlainTextLinkedMessage(now - 60_000, 'Visit example.com/blocked');
    const harness = buildHarness({ now, listRows: [row], exactRow: row, deleteEnabled: true });

    await harness.service.runOnce();

    expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
    expect(harness.deleteIntents.ensureIntent).not.toHaveBeenCalled();
  });

  it('recovers a bare-domain plain-text target with explicit clickability opt-in', async () => {
    const now = Date.now();
    const row = buildPlainTextLinkedMessage(now - 60_000, 'Visit example.com/blocked');
    const harness = buildHarness({
      now,
      listRows: [row],
      exactRow: row,
      deleteEnabled: true,
      plainTextClickabilityEnabled: true,
    });

    await harness.service.runOnce();

    expect(harness.maxClient.getExactMessageRow).toHaveBeenCalledTimes(1);
    expect(harness.deleteIntents.ensureIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'message-1',
        ruleCode: 'LINK_HISTORY_RECOVERY',
      }),
    );
  });

  it('fails closed when MAX does not confirm the current author access', async () => {
    const now = Date.now();
    const row = buildLinkedMessage(now - 60_000);
    const harness = buildHarness({
      now,
      listRows: [row],
      exactRow: row,
      deleteEnabled: true,
      remoteAccess: null,
    });

    await harness.service.runOnce();

    expect(harness.maxClient.getChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(harness.deleteIntents.ensureIntent).not.toHaveBeenCalled();
  });

  it('advances past an ambiguous exact-message 404 without creating a delete intent', async () => {
    const now = Date.now();
    const row = buildLinkedMessage(now - 60_000);
    const exactLookupError = {
      response: {
        status: 404,
        data: { code: 'message.not.found', message: 'Message not found' },
      },
    };
    const harness = buildHarness({
      now,
      listRows: [row],
      exactLookupError,
      deleteEnabled: true,
    });

    await expect(harness.service.runOnce()).resolves.toBe(true);

    expect(harness.maxClient.getExactMessageRow).toHaveBeenCalledTimes(1);
    expect(harness.maxClient.getChatMemberAccess).not.toHaveBeenCalled();
    expect(harness.deleteIntents.ensureIntent).not.toHaveBeenCalled();
    expect(
      harness.prisma.$executeRaw.mock.calls.some(([query]) =>
        ((query as { strings?: readonly string[] }).strings?.join('?') ?? '').includes(
          '"last_successful_scan_at" = CURRENT_TIMESTAMP',
        ),
      ),
    ).toBe(true);
  });

  it('does not retroactively delete a message sent before a scheduled allowlist expiry', async () => {
    const now = Date.now();
    const scheduledAt = new Date(now - 10 * 60_000);
    const expiredAt = new Date(now - 2 * 60_000);
    const row = buildLinkedMessage(expiredAt.getTime() - 60_000);
    const harness = buildHarness({
      now,
      policyEffectiveAt: scheduledAt,
      expiredAllowlistAt: expiredAt,
      leasePolicyEffectiveAt: expiredAt,
      linkPolicy: 'ALLOWLIST_ONLY',
      listRows: [row],
      exactRow: row,
      deleteEnabled: true,
    });

    await harness.service.runOnce();

    expect(harness.deleteIntents.ensureIntent).not.toHaveBeenCalled();
  });

  it.each(['domain:example.com', 'https://apps.example.com/start'])(
    'does not recover an open_app allowed by the live %s matcher',
    async (allowlistEntry) => {
      const now = Date.now();
      const row = buildMiniAppMessage(now - 60_000);
      const harness = buildHarness({
        now,
        linkPolicy: 'ALLOWLIST_ONLY',
        allowlist: [allowlistEntry],
        listRows: [row],
        exactRow: row,
        deleteEnabled: true,
      });

      await harness.service.runOnce();

      expect(harness.maxClient.getExactMessageRow).toHaveBeenCalledTimes(1);
      expect(harness.deleteIntents.ensureIntent).not.toHaveBeenCalled();
    },
  );

  it('fails closed when one timestamp group saturates the page plus lookahead', async () => {
    const now = Date.now();
    const tiedAt = now - 60_000;
    const tied = ['message-1', 'message-2', 'message-3', 'message-4'].map((messageId) => {
      const row = buildLinkedMessage(tiedAt);
      return {
        ...row,
        id: messageId,
        body: { ...(row.body as Record<string, unknown>), mid: messageId },
      };
    });
    const harness = buildHarness({
      now,
      pageSize: 3,
      listRows: tied,
      deleteEnabled: true,
    });

    await harness.service.runOnce();

    expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
    expect(harness.deleteIntents.ensureIntent).not.toHaveBeenCalled();
  });

  it('backs up before a timestamp group split by the lookahead boundary', async () => {
    const now = Date.now();
    const tiedAt = now - 60_000;
    const rows = [
      buildLinkedMessage(now - 20_000),
      withMessageIdentity(buildLinkedMessage(now - 40_000), 'message-2'),
      withMessageIdentity(buildLinkedMessage(tiedAt), 'message-3'),
      withMessageIdentity(buildLinkedMessage(tiedAt), 'message-4'),
    ];
    const harness = buildHarness({
      now,
      pageSize: 3,
      listRows: rows,
      deleteEnabled: false,
    });

    await harness.service.runOnce();

    const continuationQuery = harness.prisma.$executeRaw.mock.calls
      .map(([query]) => query as { strings?: readonly string[]; values?: readonly unknown[] })
      .find((query) => (query.strings?.join('?') ?? '').includes('"continuation_from_at" = ?'));
    expect(continuationQuery?.values?.[3]).toEqual(new Date(tiedAt));
    expect(harness.maxClient.getExactMessageRow).toHaveBeenCalledTimes(2);
  });

  it('persists a full-page continuation one millisecond before the oldest row', async () => {
    const now = Date.now();
    const oldestTimestampMs = now - 60_000;
    const newest = buildLinkedMessage(now - 30_000);
    const oldest = {
      ...buildLinkedMessage(oldestTimestampMs),
      id: 'message-2',
      body: {
        ...(buildLinkedMessage(oldestTimestampMs).body as Record<string, unknown>),
        mid: 'message-2',
      },
    };
    const lookahead = withMessageIdentity(
      buildLinkedMessage(oldestTimestampMs - 10_000),
      'message-3',
    );
    const harness = buildHarness({
      now,
      pageSize: 2,
      listRows: [newest, oldest, lookahead],
      deleteEnabled: false,
    });

    await harness.service.runOnce();

    const continuationQuery = harness.prisma.$executeRaw.mock.calls
      .map(([query]) => query as { strings?: readonly string[]; values?: readonly unknown[] })
      .find((query) => (query.strings?.join('?') ?? '').includes('"continuation_from_at" = ?'));
    expect(continuationQuery?.values?.[3]).toEqual(new Date(oldestTimestampMs - 1));
    expect((continuationQuery?.values?.[3] as Date).getTime()).toBeGreaterThan(
      (continuationQuery?.values?.[1] as Date).getTime(),
    );
  });

  it.each([
    ['local administrator', { adminUserIds: ['user-1'] }],
    ['runtime bot', { knownBot: true }],
  ])('preserves %s immunity', async (_label, overrides) => {
    const now = Date.now();
    const row = buildLinkedMessage(now - 60_000);
    const harness = buildHarness({
      now,
      listRows: [row],
      exactRow: row,
      deleteEnabled: true,
      ...overrides,
    });

    await harness.service.runOnce();

    expect(harness.deleteIntents.ensureIntent).not.toHaveBeenCalled();
  });

  it('requests a full replay when delete mode starts after shadow scanning', async () => {
    const harness = buildHarness({ now: Date.now(), deleteEnabled: true });

    await harness.service.runOnce();

    const seedQuery = harness.prisma.$executeRaw.mock.calls
      .map(([query]) => query as { strings?: readonly string[]; values?: readonly unknown[] })
      .find((query) => (query.strings?.join('?') ?? '').includes('ON CONFLICT ("chat_id")'));
    expect(seedQuery?.values).toContain(true);
    const sql = seedQuery?.strings?.join('?') ?? '';
    expect(sql).toContain('"delete_mode_prepared" = EXCLUDED."delete_mode_prepared"');
    expect(sql).toContain('AND NOT "moderation_link_history_scan_states"."delete_mode_prepared"');
    expect(sql).not.toContain('WHERE ? OR');
  });

  it('does not run outside api-moderation-background even when the scan flag is on', async () => {
    process.env.APP_SERVICE_NAME = 'api-moderation-realtime-b';
    const harness = buildHarness({ now: Date.now(), scanEnabled: true });

    await expect(harness.service.runOnce()).resolves.toBe(false);

    expect(harness.governor.decide).not.toHaveBeenCalled();
    expect(harness.prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

describe('link history recovery boundaries', () => {
  it('accepts Unix milliseconds and rejects Unix seconds', () => {
    const now = Date.now();
    expect(parseLinkHistoryListedMessage(buildLinkedMessage(now))).toEqual(
      expect.objectContaining({ messageId: 'message-1', senderId: 'user-1', timestampMs: now }),
    );
    expect(parseLinkHistoryListedMessage(buildLinkedMessage(Math.floor(now / 1_000)))).toBeNull();
  });

  it('uses the persisted continuation without advancing across an unverified gap', () => {
    const effectiveAt = new Date('2026-08-11T08:00:00.000Z');
    const window = resolveLinkHistoryScanWindow(
      {
        policyEffectiveAt: effectiveAt,
        discoveryCursorAt: new Date('2026-08-11T09:00:00.000Z'),
        repairCursorAt: effectiveAt,
        nextPhase: 'REPAIR',
        continuationPhase: 'DISCOVERY',
        windowLowerAt: new Date('2026-08-11T08:55:00.000Z'),
        windowUpperAt: new Date('2026-08-11T09:05:00.000Z'),
        continuationFromAt: new Date('2026-08-11T09:01:00.000Z'),
      },
      new Date('2026-08-11T09:10:00.000Z'),
      {
        discoveryOverlapMs: 300_000,
        repairWindowMs: 86_400_000,
        repairSliceMs: 3_600_000,
      },
    );

    expect(window).toEqual({
      phase: 'DISCOVERY',
      lowerAt: new Date('2026-08-11T08:55:00.000Z'),
      upperAt: new Date('2026-08-11T09:05:00.000Z'),
      fromAt: new Date('2026-08-11T09:01:00.000Z'),
      continuation: true,
    });
  });

  it('rejects a persisted continuation that is not strictly above the lower boundary', () => {
    const lowerAt = new Date('2026-08-11T08:55:00.000Z');

    expect(() =>
      resolveLinkHistoryScanWindow(
        {
          policyEffectiveAt: new Date('2026-08-11T08:00:00.000Z'),
          discoveryCursorAt: new Date('2026-08-11T09:00:00.000Z'),
          repairCursorAt: new Date('2026-08-11T08:00:00.000Z'),
          nextPhase: 'REPAIR',
          continuationPhase: 'DISCOVERY',
          windowLowerAt: lowerAt,
          windowUpperAt: new Date('2026-08-11T09:05:00.000Z'),
          continuationFromAt: lowerAt,
        },
        new Date('2026-08-11T09:10:00.000Z'),
        {
          discoveryOverlapMs: 300_000,
          repairWindowMs: 86_400_000,
          repairSliceMs: 3_600_000,
        },
      ),
    ).toThrow('unsafe boundaries');
  });

  it('fingerprints direct and visible forwarded content together', () => {
    const directOnly = adaptMaxMessageNavigationView(buildLinkedMessage(Date.now()));
    const withForward = adaptMaxMessageNavigationView({
      ...buildLinkedMessage(Date.now()),
      link: {
        type: 'forward',
        message: {
          body: {
            text: 'forward',
            markup: [{ type: 'link', from: 0, length: 7, url: 'https://forward.example' }],
          },
        },
      },
    });

    expect(createMessageContentFingerprint(directOnly)).not.toBe(
      createMessageContentFingerprint(withForward),
    );
  });
});

function buildHarness(options: {
  now: number;
  scanEnabled?: boolean;
  deleteEnabled?: boolean;
  listRows?: Record<string, unknown>[];
  exactRow?: Record<string, unknown> | null;
  exactLookupError?: unknown;
  adminUserIds?: string[];
  knownBot?: boolean;
  remoteAccess?: Record<string, unknown> | null;
  policyEffectiveAt?: Date;
  leasePolicyEffectiveAt?: Date;
  expiredAllowlistAt?: Date | null;
  linkPolicy?: 'ALLOWLIST_ONLY' | 'BLOCKLIST_ONLY';
  allowlist?: string[];
  pageSize?: number;
  plainTextClickabilityEnabled?: boolean;
  linkRulesPolicy?: unknown;
}) {
  const effectiveAt = options.policyEffectiveAt ?? new Date(options.now - 10 * 60_000);
  const leaseEffectiveAt = options.leasePolicyEffectiveAt ?? effectiveAt;
  const lease = {
    chatId: 'chat-1',
    policyRevision: 1,
    policyEffectiveAt: leaseEffectiveAt,
    discoveryCursorAt: new Date(Math.max(options.now - 2 * 60_000, leaseEffectiveAt.getTime())),
    repairCursorAt: leaseEffectiveAt,
    nextPhase: 'DISCOVERY',
    continuationPhase: null,
    windowLowerAt: null,
    windowUpperAt: null,
    continuationFromAt: null,
    lastPageSignature: null,
    leaseToken: 'lease-1',
    leaseExpiresAt: new Date(options.now + 60_000),
  };
  const prisma = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockResolvedValue([lease]),
    $transaction: jest.fn(async (operations: Array<Promise<unknown>>) => Promise.all(operations)),
    chatSettings: {
      findUnique: jest.fn().mockResolvedValue({
        linkPolicy: options.linkPolicy ?? 'BLOCKLIST_ONLY',
        linkRulesPolicy: options.linkRulesPolicy ?? null,
        linkPolicyRevision: 1,
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
  const getExactMessageRow = options.exactLookupError
    ? jest.fn().mockRejectedValue(options.exactLookupError)
    : jest.fn().mockResolvedValue(options.exactRow ?? null);
  const maxClient = {
    listMessages: jest.fn().mockResolvedValue(options.listRows ?? []),
    getExactMessageRow,
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
    resolveBotRoute: jest.fn().mockResolvedValue({ botId: 'scan-bot' }),
    isKnownBotUserId: jest.fn().mockReturnValue(options.knownBot ?? false),
  };
  const deleteIntents = {
    ensureIntent: jest.fn().mockResolvedValue({
      intentId: 'intent-1',
      rollout: 'execute',
      status: 'PENDING',
    }),
  };
  const governor = {
    decide: jest.fn().mockResolvedValue({ action: 'run', retryAfterMs: 0, reason: 'ok' }),
  };
  const config = new ConfigService({
    MODERATION_LINK_HISTORY_SCAN_ENABLED: options.scanEnabled ?? true,
    MODERATION_LINK_HISTORY_DELETE_ENABLED: options.deleteEnabled ?? false,
    MODERATION_LINK_HISTORY_SCAN_PAGE_SIZE: options.pageSize ?? 50,
    MODERATION_LINK_TEXT_CLICKABILITY_ENABLED: options.plainTextClickabilityEnabled ?? false,
  });
  const service = new LinkHistoryRecoveryService(
    prisma as never,
    maxClient as never,
    maxBotLinkService as never,
    deleteIntents as never,
    governor as never,
    config,
  );
  return { service, prisma, maxClient, maxBotLinkService, deleteIntents, governor };
}

function buildLinkedMessage(
  timestamp: number,
  url = 'https://blocked.example/path',
): Record<string, unknown> {
  return {
    id: 'message-1',
    timestamp,
    recipient: { chat_id: 'chat-1' },
    sender: { user_id: 'user-1', is_bot: false },
    body: {
      mid: 'message-1',
      text: 'site',
      markup: [{ type: 'link', from: 0, length: 4, url }],
    },
  };
}

function buildProfileMentionMessage(timestamp: number): Record<string, unknown> {
  const text = '@participant';
  return {
    id: 'message-1',
    timestamp,
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
          user_link: text,
        },
      ],
    },
  };
}

function withMessageIdentity(
  row: Record<string, unknown>,
  messageId: string,
): Record<string, unknown> {
  return {
    ...row,
    id: messageId,
    body: { ...(row.body as Record<string, unknown>), mid: messageId },
  };
}

function buildPlainTextLinkedMessage(
  timestamp: number,
  text = 'Visit https://example.com/blocked',
): Record<string, unknown> {
  return {
    id: 'message-1',
    timestamp,
    recipient: { chat_id: 'chat-1' },
    sender: { user_id: 'user-1', is_bot: false },
    body: {
      mid: 'message-1',
      text,
    },
  };
}

function buildMiniAppMessage(timestamp: number): Record<string, unknown> {
  return {
    id: 'message-1',
    timestamp,
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
