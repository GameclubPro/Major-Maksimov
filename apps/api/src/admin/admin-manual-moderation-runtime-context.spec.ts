import { ConflictException } from '@nestjs/common';
import { AdminManualModerationRuntime } from './admin-manual-moderation-runtime';
import { isRetryableManualFanoutPreparationError } from './admin-manual-moderation-values';
import {
  BotCapabilityCheckUnavailableException,
  BotCapabilityRequiredException,
} from './bot-capability-required.error';
import { buildModerationReleaseCallbackPayload } from '../moderation/moderation-release-callback.util';
import { ManualGroupCommandNoticeAuthorityRejectedError } from './admin-manual-group-command-notice-authority';
import {
  createAdminManualModerationRuntimeContext,
  type AdminManualModerationRuntimeContext,
} from './admin-manual-moderation-runtime-context';

function baseContext(): AdminManualModerationRuntimeContext {
  return {
    logger: {} as never,
    adminSuperBanQueue: {} as never,
    adminManualFanoutQueue: {} as never,
    enqueueManualModerationFanout: jest.fn(),
    isKnownRuntimeBotUserId: jest.fn(),
    isSuperBanDeveloperUserId: jest.fn(),
    processDeveloperSuperBanJob: jest.fn(),
    processManualSystemBan: jest.fn(),
    processManualModerationAction: jest.fn(),
    resolveManualCommandFanoutChats: jest.fn(),
    runManualSourceCleanupWithLedger: jest.fn(),
    applyManualMuteFanout: jest.fn(),
    applyManualSystemBanFanout: jest.fn(),
    resolveManualGroupCommandCleanupBotId: jest.fn(),
    resolveManualModerationTargetDisplayName: jest.fn(),
    deleteManualGroupCommandTargetMessage: jest.fn(),
    deleteManualGroupCommandMessage: jest.fn(),
    readManualModerationFanoutIntentRow: jest.fn(),
    resolveManualModerationActionBotAssignment: jest.fn(),
    assertBotCanDeleteMessages: jest.fn(),
    deleteRecentTrackedMessagesForManualAction: jest.fn(),
    runManualBanSourceCleanup: jest.fn(),
    runManualBanFanoutInlineSummary: jest.fn(),
    normalizeManualModerationBotId: jest.fn(),
    canResolveCurrentChatMemberAccess: jest.fn(),
    resolveDeliveryBotAssignment: jest.fn(),
    claimManualModerationFanoutLedgerEntry: jest.fn(),
    completeManualModerationFanoutLedgerEntry: jest.fn(),
    markManualModerationFanoutLedgerFailed: jest.fn(),
    findSettledManualGroupCommandOutcomeRows: jest.fn(),
    assertManualGroupCommandSuccessNoticeAuthority: jest.fn(),
    sendMessage: jest.fn(),
  };
}

describe('AdminManualModerationRuntimeContext', () => {
  it('exposes queue and logger through typed accessors', () => {
    const target = {
      ...baseContext(),
      logger: { warn: jest.fn() } as unknown as AdminManualModerationRuntimeContext['logger'],
      adminSuperBanQueue: { add: jest.fn() } as never,
      enqueueManualModerationFanout: jest.fn(),
      isKnownRuntimeBotUserId: jest.fn(),
      isSuperBanDeveloperUserId: jest.fn(),
      processDeveloperSuperBanJob: jest.fn(),
      readTrimmedString: jest.fn(),
    };
    const context = createAdminManualModerationRuntimeContext(target);

    expect(context.logger).toBe(target.logger);
    expect(context.adminSuperBanQueue).toBe(target.adminSuperBanQueue);
  });

  it('delegates manual moderation helpers without losing the legacy target context', async () => {
    const target = {
      ...baseContext(),
      prefix: 'legacy',
      logger: { warn: jest.fn() } as unknown as AdminManualModerationRuntimeContext['logger'],
      async enqueueManualModerationFanout(job: { kind: string }): Promise<boolean> {
        this.logger.warn(`${this.prefix}:fanout:${job.kind}`);
        return true;
      },
      isKnownRuntimeBotUserId(userId: string | null | undefined): boolean {
        return userId === `${this.prefix}-bot`;
      },
      isSuperBanDeveloperUserId(userId: string | null | undefined): boolean {
        return userId === `${this.prefix}-dev`;
      },
      async processDeveloperSuperBanJob(job: { jobId: string }): Promise<void> {
        this.logger.warn(`${this.prefix}:super-ban:${job.jobId}`);
      },
      readTrimmedString(value: unknown): string | null {
        return typeof value === 'string' ? `${this.prefix}:${value.trim()}` : null;
      },
    };
    const context = createAdminManualModerationRuntimeContext(target);

    await expect(
      context.enqueueManualModerationFanout({ kind: 'manual_group_moderation_command' } as never),
    ).resolves.toBe(true);
    expect(context.isKnownRuntimeBotUserId('legacy-bot')).toBe(true);
    expect(context.isSuperBanDeveloperUserId('legacy-dev')).toBe(true);
    await context.processDeveloperSuperBanJob({ jobId: 'job-1' } as never);
    expect(target.logger.warn).toHaveBeenCalledWith(
      'legacy:fanout:manual_group_moderation_command',
    );
    expect(target.logger.warn).toHaveBeenCalledWith('legacy:super-ban:job-1');
  });
});

describe('manual moderation capability error callers', () => {
  const required = new BotCapabilityRequiredException({
    operation: 'member_moderation',
    missingPermissions: ['add_remove_members'],
    featureKeys: ['manualMemberModeration'],
    canRecheck: false,
  });
  const unavailable = new BotCapabilityCheckUnavailableException({
    operation: 'member_moderation',
    featureKeys: ['manualMemberModeration'],
    canRecheck: false,
  });

  it('recognizes the specific missing bot capability as an expected command error', () => {
    const runtime = new AdminManualModerationRuntime(baseContext());
    expect(runtime.extractExpectedManualGroupCommandErrorMessage(required)).toBe(
      'Боту не хватает подтверждённых прав для модерации участников.',
    );
    expect(runtime.extractExpectedManualGroupCommandErrorMessage(unavailable)).toBeNull();
    expect(
      runtime.extractExpectedManualGroupCommandErrorMessage(new ConflictException('Lock conflict')),
    ).toBeNull();
  });

  it('stops fanout preparation only for a proven missing capability', () => {
    expect(isRetryableManualFanoutPreparationError(required)).toBe(false);
    expect(isRetryableManualFanoutPreparationError(unavailable)).toBe(true);
    expect(isRetryableManualFanoutPreparationError(new ConflictException('Lock conflict'))).toBe(
      true,
    );
  });
});

const notice = {
  chatId: 'chat-1',
  botId: 'major-1',
  text: 'Result',
  deleteBotMessagesEnabled: false,
  deleteBotMessagesDelayMinutes: 1,
  ledger: {
    jobId: 'job-1',
    outcome: 'SUCCESS' as const,
    actorUserId: 'admin-1',
    targetUserId: 'user-1',
    commandMessageId: 'command-1',
    action: 'MUTE' as const,
  },
};

function noticeFixture() {
  const order: string[] = [];
  const findSettledManualGroupCommandOutcomeRows = jest.fn().mockResolvedValue([]);
  const claimManualModerationFanoutLedgerEntry = jest.fn(
    async (
      _params: Parameters<
        AdminManualModerationRuntimeContext['claimManualModerationFanoutLedgerEntry']
      >[0],
    ) => {
      order.push('claim');
      return { claimed: true, lockToken: 'lease-1' };
    },
  );
  const markManualModerationFanoutLedgerFailed = jest.fn(async () => {
    order.push('record-attempt');
    return true;
  });
  const completeManualModerationFanoutLedgerEntry = jest.fn(async () => {
    order.push('complete');
  });
  const assertManualGroupCommandSuccessNoticeAuthority = jest.fn(async () => {
    order.push('authority');
  });
  const sendMessage: jest.MockedFunction<AdminManualModerationRuntimeContext['sendMessage']> =
    jest.fn(async (_chatId, _text, _options, dispatch) => {
      await dispatch.beforeImmediateSendMutation?.();
      order.push('send');
      return { messageId: 'sent-1' } as never;
    });
  const context: AdminManualModerationRuntimeContext = {
    ...baseContext(),
    logger: { debug: jest.fn(), warn: jest.fn() } as never,
    findSettledManualGroupCommandOutcomeRows,
    claimManualModerationFanoutLedgerEntry,
    markManualModerationFanoutLedgerFailed,
    completeManualModerationFanoutLedgerEntry,
    assertManualGroupCommandSuccessNoticeAuthority,
    sendMessage,
  };
  return {
    runtime: new AdminManualModerationRuntime(context),
    order,
    findSettledManualGroupCommandOutcomeRows,
    claimManualModerationFanoutLedgerEntry,
    markManualModerationFanoutLedgerFailed,
    completeManualModerationFanoutLedgerEntry,
    assertManualGroupCommandSuccessNoticeAuthority,
    sendMessage,
  };
}

describe('manual moderation notice boundary', () => {
  it.each(['UNMUTE', 'UNBAN', null] as const)(
    'adds explicit profile intent without changing the %s release action or auto-delete',
    async (action) => {
      const f = noticeFixture();
      await f.runtime.sendManualGroupCommandNotice({
        ...notice,
        deleteBotMessagesEnabled: true,
        deleteBotMessagesDelayMinutes: 3,
        ...(action ? { release: { action, sanctionEventId: 'sanction-1' } } : {}),
      });
      expect(f.sendMessage).toHaveBeenCalledTimes(1);
      expect(f.sendMessage).toHaveBeenCalledWith(
        notice.chatId,
        notice.text,
        {
          textFormat: 'markdown',
          marketplacePublication: { entityId: notice.chatId, purpose: 'MODERATION_NOTICE' },
          ...(action
            ? {
                buttons: [
                  [
                    {
                      type: 'callback',
                      text: action === 'UNMUTE' ? 'Снять мут' : 'Разбанить',
                      payload: buildModerationReleaseCallbackPayload(action, 'sanction-1'),
                      intent: 'positive',
                    },
                  ],
                ],
              }
            : {}),
        },
        expect.objectContaining({
          botId: notice.botId,
          immediate: true,
          autoDeleteDelayMs: 3 * 60_000,
          ledgerContext: { moderationNoticeEnvelope: { version: 1 } },
          beforeImmediateSendMutation: expect.any(Function),
          idempotencyKey: expect.stringContaining('COMMAND_NOTICE_OUTCOME'),
        }),
      );
      expect(f.order).toEqual(['claim', 'record-attempt', 'authority', 'send', 'complete']);
    },
  );

  it.each(['FAILURE', 'UNCERTAIN'] as const)(
    'records %s privately without a group send',
    async (outcome) => {
      const f = noticeFixture();
      await f.runtime.sendManualGroupCommandNotice({
        ...notice,
        ledger: { ...notice.ledger, outcome },
      });
      expect(f.order).toEqual(['claim', 'complete']);
      expect(f.sendMessage).not.toHaveBeenCalled();
      expect(f.claimManualModerationFanoutLedgerEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({ outcome, suppressed: true, resultText: notice.text }),
        }),
      );
    },
  );

  it('keeps an unbound legacy notice silent', async () => {
    const f = noticeFixture();
    const unbound = { ...notice, ledger: undefined };
    await f.runtime.sendManualGroupCommandNotice(unbound);
    expect(f.claimManualModerationFanoutLedgerEntry).not.toHaveBeenCalled();
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it('checks fresh authority after route validation and before sending', async () => {
    const f = noticeFixture();
    f.sendMessage.mockImplementation(async (_chatId, _text, _options, dispatch) => {
      await dispatch.beforeImmediateSendMutation?.(async () => {
        f.order.push('route');
      });
      f.order.push('send');
      return { messageId: 'sent-1' } as never;
    });
    await f.runtime.sendManualGroupCommandNotice(notice);
    expect(f.order).toEqual(['claim', 'route', 'record-attempt', 'authority', 'send', 'complete']);
    expect(f.assertManualGroupCommandSuccessNoticeAuthority).toHaveBeenCalledWith(
      expect.objectContaining({ ...notice.ledger, chatId: notice.chatId, lockToken: 'lease-1' }),
    );
  });

  it('settles revoked success authority without sending or retrying the command', async () => {
    const f = noticeFixture();
    f.assertManualGroupCommandSuccessNoticeAuthority.mockRejectedValueOnce(
      new ManualGroupCommandNoticeAuthorityRejectedError(),
    );
    await expect(f.runtime.sendManualGroupCommandNotice(notice)).resolves.toBeUndefined();
    expect(f.order).toEqual(['claim', 'record-attempt', 'record-attempt']);
    expect(f.markManualModerationFanoutLedgerFailed).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'SKIPPED', terminal: true }),
    );
  });

  it('records the dispatch attempt before sending and commits the exact receipt afterwards', async () => {
    const f = noticeFixture();
    await f.runtime.sendManualGroupCommandNotice(notice);
    expect(f.order).toEqual(['claim', 'record-attempt', 'authority', 'send', 'complete']);
    expect(f.markManualModerationFanoutLedgerFailed).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'AMBIGUOUS', retainClaim: true, requireClaim: true }),
    );
    const claim = f.claimManualModerationFanoutLedgerEntry.mock.calls[0][0];
    expect(f.sendMessage.mock.calls[0][3].idempotencyKey).toBe(claim.operationKey);
    expect(f.completeManualModerationFanoutLedgerEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        operationKey: claim.operationKey,
        lockToken: 'lease-1',
        remoteMessageId: 'sent-1',
      }),
    );
  });

  it('does not repeat an already settled notice', async () => {
    const f = noticeFixture();
    f.findSettledManualGroupCommandOutcomeRows.mockResolvedValue([
      { operation: 'COMMAND_NOTICE_OUTCOME' },
    ]);
    await f.runtime.sendManualGroupCommandNotice(notice);
    expect(f.claimManualModerationFanoutLedgerEntry).not.toHaveBeenCalled();
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it('does not send if another worker already claimed the notice', async () => {
    const f = noticeFixture();
    f.claimManualModerationFanoutLedgerEntry.mockResolvedValue({ claimed: false, lockToken: '' });
    await f.runtime.sendManualGroupCommandNotice(notice);
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it('quarantines a lost MAX response after dispatch instead of requesting a retry', async () => {
    const f = noticeFixture();
    f.sendMessage.mockImplementation(async (_chatId, _text, _options, dispatch) => {
      await dispatch.beforeImmediateSendMutation?.();
      throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    });
    await expect(f.runtime.sendManualGroupCommandNotice(notice)).resolves.toBeUndefined();
    expect(f.markManualModerationFanoutLedgerFailed).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'AMBIGUOUS' }),
    );
    expect(f.completeManualModerationFanoutLedgerEntry).not.toHaveBeenCalled();
  });

  it('preserves ambiguity when receipt persistence fails after confirmed delivery', async () => {
    const f = noticeFixture();
    f.completeManualModerationFanoutLedgerEntry.mockRejectedValueOnce(new Error('commit failed'));
    await expect(f.runtime.sendManualGroupCommandNotice(notice)).resolves.toBeUndefined();
    expect(f.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.markManualModerationFanoutLedgerFailed).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'AMBIGUOUS' }),
    );
  });
});
