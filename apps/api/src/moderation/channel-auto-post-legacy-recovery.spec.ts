import { MaxApiInternalRateLimitError } from '../max/max-client.service';
import { MaxExactMessageLookupMissingIdError } from '../max/max-exact-message-lookup.error';
import { ChannelAutoPostLegacyRecovery } from './channel-auto-post-legacy-recovery';
import type { LegacyChannelEditRecoveryCandidate } from './replacement-attach-marker.store';

function candidate(
  chatId: string,
  messageId = `message-${chatId}`,
  evidence: LegacyChannelEditRecoveryCandidate['evidence'] = 'marker',
): LegacyChannelEditRecoveryCandidate {
  return {
    chatId,
    messageId,
    evidence,
    evidenceId: `marker-${chatId}-${messageId}`,
    evidenceAt: new Date('2026-08-09T10:00:00.000Z'),
  };
}

function contextRow(
  chatId: string,
  overrides: { commentsEnabled?: boolean; postSuggestionsEnabled?: boolean } = {},
) {
  return {
    chatId,
    commentsEnabled: overrides.commentsEnabled ?? true,
    postSuggestionsEnabled: overrides.postSuggestionsEnabled ?? false,
    postSignatureEnabled: true,
    chat: { admins: [{ userId: `admin-${chatId}` }] },
  };
}

function createHarness(options: {
  candidates?: ReturnType<typeof candidate>[];
  contextRows?: ReturnType<typeof contextRow>[];
  lookup?: jest.Mock;
  sourceAt?: jest.Mock;
}) {
  let nowMs = Date.parse('2026-08-09T12:00:00.000Z');
  const listCandidates = jest.fn().mockResolvedValue({
    candidates: options.candidates ?? [],
    nextMarkerCursor: {
      createdAt: new Date('2026-08-09T10:00:00.000Z'),
      id: 'marker-next',
    },
    markerScanExhausted: false,
    nextAuditCursor: {
      createdAt: new Date('2026-08-09T10:30:00.000Z'),
      id: 'audit-next',
    },
    auditScanExhausted: true,
  });
  const claimChannelAutoPost = jest
    .fn()
    .mockImplementation(async ({ messageId }: { messageId: string }) => ({
      status: 'claimed',
      lockToken: `lock-${messageId}`,
    }));
  const completeChannelAutoPost = jest.fn().mockResolvedValue(undefined);
  const findMany = jest.fn().mockResolvedValue(options.contextRows ?? []);
  const lookup = options.lookup ?? jest.fn().mockResolvedValue([]);
  const attach = jest.fn().mockResolvedValue('attached');
  const resolveUnifiedLookupBotId = jest.fn().mockResolvedValue('scan-bot');
  const logger = { warn: jest.fn() };
  const isMessageHeld = jest.fn().mockResolvedValue(false);
  const runner = new ChannelAutoPostLegacyRecovery({
    prisma: { channelSettings: { findMany } } as never,
    markerStore: {
      listLegacyChannelEditRecoveryCandidates: listCandidates,
      claimChannelAutoPost,
      completeChannelAutoPost,
    },
    isMessageHeld,
    lookupExactButtonIdentities: lookup,
    lookupExactSourceAt: options.sourceAt,
    resolveUnifiedLookupBotId,
    attach,
    logger,
    now: () => nowMs,
  });

  return {
    runner,
    isMessageHeld,
    listCandidates,
    claimChannelAutoPost,
    completeChannelAutoPost,
    findMany,
    lookup,
    attach,
    resolveUnifiedLookupBotId,
    logger,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

describe('ChannelAutoPostLegacyRecovery', () => {
  it.each(['2026-11-16T00:00:00Z', '2026-11-14T00:00:00Z', null])(
    'checks original time before recovering custom-only edits: %s',
    async (sourceAt) => {
      const row = {
        ...contextRow('channel-1', { commentsEnabled: false }),
        postSignatureEnabled: false,
        customPostButtonsEnabled: true,
        customPostButtonsSince: new Date('2026-11-15'),
      };
      const lookup = jest.fn().mockResolvedValue(sourceAt);
      const harness = createHarness({
        candidates: [candidate('channel-1', 'custom-post', 'retryable_edit_marker')],
        contextRows: [row],
        sourceAt: lookup,
      });
      await harness.runner.runIfDue();
      expect(lookup).toHaveBeenCalledWith(
        'channel-1',
        'custom-post',
        expect.objectContaining({ botId: 'scan-bot' }),
      );
      if (sourceAt === '2026-11-16T00:00:00Z')
        expect(harness.attach).toHaveBeenCalledWith(
          expect.objectContaining({ sourceMessageAt: sourceAt }),
        );
      else expect(harness.attach).not.toHaveBeenCalled();
    },
  );

  it('recovers a durable signature-only edit using the locked snapshot, even without a sender', async () => {
    const harness = createHarness({
      candidates: [candidate('channel-1', 'missed-signature', 'retryable_edit_marker')],
      contextRows: [contextRow('channel-1', { commentsEnabled: false })],
    });
    await expect(harness.runner.runIfDue()).resolves.toMatchObject({
      status: 'completed',
      mutationAttempts: 1,
      remoteLookups: 0,
    });
    expect(harness.lookup).not.toHaveBeenCalled();
    expect(harness.attach).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'missed-signature',
        text: null,
        senderId: null,
        allowSenderlessEngagement: true,
        managedChannel: expect.objectContaining({
          channelSettings: expect.objectContaining({ postSignatureEnabled: true }),
        }),
      }),
    );
  });

  it('uses a seven-day bounded page, persists recovery cursors, and sweeps at most every five minutes', async () => {
    const harness = createHarness({});

    await expect(harness.runner.runIfDue()).resolves.toEqual({
      status: 'completed',
      deferReason: null,
      stopCurrentTick: false,
      scannedCandidates: 0,
      remoteLookups: 0,
      mutationAttempts: 0,
      terminalizedCandidates: 0,
    });
    expect(harness.listCandidates).toHaveBeenNthCalledWith(1, {
      now: new Date('2026-08-09T12:00:00.000Z'),
      limit: 100,
      lookbackMs: 7 * 24 * 60 * 60_000,
      minimumAgeMs: 5 * 60_000,
      markerCursor: null,
      auditCursor: null,
    });

    harness.advance(5 * 60_000 - 1);
    await expect(harness.runner.runIfDue()).resolves.toEqual({
      status: 'not_due',
      deferReason: null,
      stopCurrentTick: false,
      scannedCandidates: 0,
      remoteLookups: 0,
      mutationAttempts: 0,
      terminalizedCandidates: 0,
    });
    expect(harness.listCandidates).toHaveBeenCalledTimes(1);

    harness.advance(1);
    await harness.runner.runIfDue();
    expect(harness.listCandidates).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        markerCursor: {
          createdAt: new Date('2026-08-09T10:00:00.000Z'),
          id: 'marker-next',
        },
        auditCursor: {
          createdAt: new Date('2026-08-09T10:30:00.000Z'),
          id: 'audit-next',
        },
      }),
    );
  });

  it('terminalizes missing contexts, disabled features, absent posts, and already-complete posts without mutation', async () => {
    const candidates = [
      candidate('missing-context'),
      candidate('disabled'),
      candidate('absent'),
      candidate('complete'),
    ];
    const lookup = jest.fn().mockImplementation(async (chatId: string) => {
      if (chatId === 'absent') {
        return null;
      }
      if (chatId === 'complete') {
        return [
          { chatId, kind: 'comments', threadId: 'thread-existing' },
          { chatId, kind: 'suggest', threadId: 'thread-existing' },
        ];
      }
      throw new Error(`Unexpected lookup for ${chatId}`);
    });
    const harness = createHarness({
      candidates,
      contextRows: [
        contextRow('disabled', { commentsEnabled: false, postSuggestionsEnabled: false }),
        contextRow('absent', { commentsEnabled: true }),
        contextRow('complete', { commentsEnabled: true, postSuggestionsEnabled: true }),
      ],
      lookup,
    });

    await expect(harness.runner.runIfDue()).resolves.toEqual({
      status: 'completed',
      deferReason: null,
      stopCurrentTick: false,
      scannedCandidates: 4,
      remoteLookups: 2,
      mutationAttempts: 0,
      terminalizedCandidates: 4,
    });
    expect(harness.attach).not.toHaveBeenCalled();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(harness.claimChannelAutoPost).toHaveBeenCalledTimes(4);
    expect(harness.claimChannelAutoPost).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'poll',
        linkType: null,
        hasEngagementButtons: true,
      }),
    );
    expect(harness.completeChannelAutoPost).toHaveBeenCalledTimes(4);
    expect(harness.completeChannelAutoPost).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'message-absent',
        status: 'SKIPPED',
        lastError: expect.stringContaining('[absent_or_inaccessible]'),
        lastStatusCode: 404,
      }),
    );
    expect(harness.completeChannelAutoPost).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'message-complete',
        status: 'SUCCEEDED',
        lastError: null,
      }),
    );
  });

  it('passes existing kinds and thread to attach while disabling signature decoration', async () => {
    const lookup = jest.fn().mockResolvedValue([
      { chatId: 'channel-1', kind: 'comments', threadId: 'existing-thread' },
      { chatId: 'other-channel', kind: 'suggest', threadId: 'wrong-thread' },
    ]);
    const harness = createHarness({
      candidates: [candidate('channel-1')],
      contextRows: [
        contextRow('channel-1', { commentsEnabled: true, postSuggestionsEnabled: true }),
      ],
      lookup,
    });

    await expect(harness.runner.runIfDue()).resolves.toEqual({
      status: 'completed',
      deferReason: null,
      stopCurrentTick: false,
      scannedCandidates: 1,
      remoteLookups: 1,
      mutationAttempts: 1,
      terminalizedCandidates: 0,
    });
    expect(harness.lookup).toHaveBeenCalledWith('channel-1', 'message-channel-1', {
      trafficClass: 'background',
      actionHealthLane: 'background',
      sourceTag: 'channel_auto_post',
      botId: 'scan-bot',
    });
    expect(harness.findMany).toHaveBeenCalledWith({
      where: {
        chatId: { in: ['channel-1'] },
        chat: { entityType: 'CHANNEL' },
      },
      include: {
        chat: {
          select: {
            admins: { select: { userId: true } },
          },
        },
      },
    });
    expect(harness.attach).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'channel-1',
        messageId: 'message-channel-1',
        text: null,
        textFormat: null,
        linkType: null,
        existingDialogButtonKinds: ['comments'],
        existingDialogThreadId: 'existing-thread',
        source: 'poll',
        senderId: null,
        senderAdminVerified: false,
        allowSenderlessEngagement: false,
        managedChannel: expect.objectContaining({
          channelSettings: expect.objectContaining({
            commentsEnabled: true,
            postSuggestionsEnabled: true,
            postSignatureEnabled: false,
          }),
        }),
      }),
    );
    expect(harness.claimChannelAutoPost).not.toHaveBeenCalled();
  });

  it('recovers a proven predispatch failure with the current signature and a fresh edit snapshot', async () => {
    const harness = createHarness({
      candidates: [candidate('channel-1', undefined, 'predispatch_marker')],
      contextRows: [contextRow('channel-1')],
      lookup: jest.fn().mockResolvedValue([]),
    });

    await expect(harness.runner.runIfDue()).resolves.toEqual(
      expect.objectContaining({
        status: 'completed',
        remoteLookups: 0,
        mutationAttempts: 1,
        terminalizedCandidates: 0,
      }),
    );
    expect(harness.attach).toHaveBeenCalledWith(
      expect.objectContaining({
        allowSenderlessEngagement: true,
        text: null,
        linkType: null,
      }),
    );
    expect(harness.completeChannelAutoPost).not.toHaveBeenCalled();
  });

  it('limits mutations to three per sweep and one candidate per channel', async () => {
    const candidates = [
      candidate('channel-1', 'message-channel-1-a'),
      candidate('channel-1', 'message-channel-1-b'),
      candidate('channel-2'),
      candidate('channel-3'),
      candidate('channel-4'),
      candidate('channel-5'),
    ];
    const harness = createHarness({
      candidates,
      contextRows: [1, 2, 3, 4, 5].map((index) => contextRow(`channel-${index}`)),
    });

    await expect(harness.runner.runIfDue()).resolves.toEqual({
      status: 'deferred',
      deferReason: 'same_channel_limit',
      stopCurrentTick: false,
      scannedCandidates: 6,
      remoteLookups: 5,
      mutationAttempts: 3,
      terminalizedCandidates: 0,
    });
    expect(harness.attach).toHaveBeenCalledTimes(3);
    expect(harness.attach.mock.calls.map(([input]) => input.chatId)).toEqual([
      'channel-1',
      'channel-2',
      'channel-3',
    ]);
    expect(harness.lookup).toHaveBeenCalledTimes(5);

    harness.advance(5 * 60_000);
    await harness.runner.runIfDue();
    expect(harness.listCandidates).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ markerCursor: null, auditCursor: null }),
    );
  });

  it('defers a transient exact lookup without claiming or advancing recovery cursors', async () => {
    const transientError = Object.assign(new Error('MAX throttle'), {
      response: { status: 429 },
    });
    const harness = createHarness({
      candidates: [candidate('channel-1')],
      contextRows: [contextRow('channel-1')],
      lookup: jest.fn().mockRejectedValue(transientError),
    });

    await expect(harness.runner.runIfDue()).resolves.toEqual({
      status: 'deferred',
      deferReason: 'lookup_error',
      stopCurrentTick: true,
      scannedCandidates: 1,
      remoteLookups: 1,
      mutationAttempts: 0,
      terminalizedCandidates: 0,
    });
    expect(harness.claimChannelAutoPost).not.toHaveBeenCalled();
    expect(harness.completeChannelAutoPost).not.toHaveBeenCalled();
    expect(harness.attach).not.toHaveBeenCalled();
    expect(harness.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'channel-1',
        messageId: 'message-channel-1',
        error: 'MAX throttle',
      }),
      'Deferred legacy channel button recovery after lookup error',
    );

    harness.advance(5 * 60_000);
    await harness.runner.runIfDue();
    expect(harness.listCandidates).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ markerCursor: null, auditCursor: null }),
    );
  });

  it.each([
    new MaxExactMessageLookupMissingIdError(),
    new MaxApiInternalRateLimitError('cooldown', 60_000, 'external_cooldown'),
  ])('keeps independent recovery moving after a scoped lookup failure: %s', async (error) => {
    const candidates = Array.from({ length: 10 }, (_, i) => candidate(`channel-${i}`));
    const lookup = jest.fn().mockImplementation(async (chatId: string) => {
      if (!['channel-8', 'channel-9'].includes(chatId)) throw error;
      return [];
    });
    const harness = createHarness({
      candidates,
      contextRows: candidates.map((c) => contextRow(c.chatId)),
      lookup,
    });
    await expect(harness.runner.runIfDue()).resolves.toMatchObject({
      status: 'deferred',
      stopCurrentTick: false,
      remoteLookups: 8,
      mutationAttempts: 0,
    });
    expect(harness.claimChannelAutoPost).not.toHaveBeenCalled();
    expect(harness.completeChannelAutoPost).not.toHaveBeenCalled();
    harness.advance(5 * 60_000);
    await expect(harness.runner.runIfDue()).resolves.toMatchObject({
      status: 'deferred',
      stopCurrentTick: false,
      remoteLookups: 8,
      mutationAttempts: 2,
    });
    expect(lookup.mock.calls.slice(8, 10).map(([chatId]) => chatId)).toEqual([
      'channel-8',
      'channel-9',
    ]);
    expect(harness.attach.mock.calls.map(([input]) => input.chatId)).toEqual([
      'channel-8',
      'channel-9',
    ]);
    expect(harness.completeChannelAutoPost).not.toHaveBeenCalled();
    expect(harness.listCandidates).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ markerCursor: null, auditCursor: null }),
    );
  });

  it('preserves the failed edit marker and continues independent durable edit candidates', async () => {
    const candidates = ['blocked', 'healthy', 'healthy-next', 'budget-bound'].map((chatId) =>
      candidate(chatId, `post-${chatId}`, 'retryable_edit_marker'),
    );
    const harness = createHarness({
      candidates,
      contextRows: candidates.map((c) => contextRow(c.chatId)),
    });
    harness.attach.mockRejectedValueOnce(new MaxExactMessageLookupMissingIdError());
    await expect(harness.runner.runIfDue()).resolves.toMatchObject({
      status: 'deferred',
      stopCurrentTick: false,
      mutationAttempts: 3,
    });
    expect(harness.attach.mock.calls.map(([input]) => input.chatId)).toEqual([
      'blocked',
      'healthy',
      'healthy-next',
    ]);
    expect(harness.claimChannelAutoPost).not.toHaveBeenCalled();
    expect(harness.completeChannelAutoPost).not.toHaveBeenCalled();
    expect(harness.lookup).not.toHaveBeenCalled();
  });

  it('does not infer scoped failure from copied error text', async () => {
    const harness = createHarness({
      candidates: [candidate('blocked'), candidate('healthy')],
      contextRows: [contextRow('blocked'), contextRow('healthy')],
      lookup: jest.fn().mockRejectedValue(
        Object.assign(new Error(new MaxExactMessageLookupMissingIdError().message), {
          name: 'MaxExactMessageLookupMissingIdError',
        }),
      ),
    });
    await expect(harness.runner.runIfDue()).resolves.toMatchObject({
      status: 'deferred',
      stopCurrentTick: true,
      remoteLookups: 1,
    });
    expect(harness.attach).not.toHaveBeenCalled();
  });

  it('holds the cursor so a second message from the same channel is recovered next sweep', async () => {
    const harness = createHarness({
      contextRows: [contextRow('channel-1')],
    });
    harness.listCandidates
      .mockReset()
      .mockResolvedValueOnce({
        candidates: [
          candidate('channel-1', 'message-channel-1-a'),
          candidate('channel-1', 'message-channel-1-b'),
        ],
        nextMarkerCursor: {
          createdAt: new Date('2026-08-09T10:00:00.000Z'),
          id: 'marker-second',
        },
        markerScanExhausted: false,
        nextAuditCursor: {
          createdAt: new Date('2026-08-09T10:30:00.000Z'),
          id: 'audit-second',
        },
        auditScanExhausted: true,
      })
      .mockResolvedValueOnce({
        candidates: [candidate('channel-1', 'message-channel-1-b')],
        nextMarkerCursor: {
          createdAt: new Date('2026-08-09T10:00:00.000Z'),
          id: 'marker-second',
        },
        markerScanExhausted: true,
        nextAuditCursor: {
          createdAt: new Date('2026-08-09T10:30:00.000Z'),
          id: 'audit-second',
        },
        auditScanExhausted: true,
      });

    await expect(harness.runner.runIfDue()).resolves.toEqual(
      expect.objectContaining({
        status: 'deferred',
        deferReason: 'same_channel_limit',
        mutationAttempts: 1,
      }),
    );
    harness.advance(5 * 60_000);
    await expect(harness.runner.runIfDue()).resolves.toEqual(
      expect.objectContaining({ status: 'completed', mutationAttempts: 1 }),
    );
    expect(harness.attach.mock.calls.map(([input]) => input.messageId)).toEqual([
      'message-channel-1-a',
      'message-channel-1-b',
    ]);
    expect(harness.listCandidates).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ markerCursor: null, auditCursor: null }),
    );
  });

  it('caps exact remote lookups at eight and holds the cursor', async () => {
    const candidates = Array.from({ length: 9 }, (_, index) => candidate(`channel-${index + 1}`));
    const lookup = jest
      .fn()
      .mockImplementation(async (chatId: string) => [
        { chatId, kind: 'comments', threadId: `thread-${chatId}` },
      ]);
    const harness = createHarness({
      candidates,
      contextRows: candidates.map((item) => contextRow(item.chatId)),
      lookup,
    });

    await expect(harness.runner.runIfDue()).resolves.toEqual({
      status: 'deferred',
      deferReason: 'lookup_limit',
      stopCurrentTick: false,
      scannedCandidates: 9,
      remoteLookups: 8,
      mutationAttempts: 0,
      terminalizedCandidates: 8,
    });
    expect(lookup).toHaveBeenCalledTimes(8);
    expect(harness.attach).not.toHaveBeenCalled();
  });

  it('holds the cursor when a terminal no-op claim is still in progress', async () => {
    const harness = createHarness({
      candidates: [candidate('channel-1')],
      contextRows: [contextRow('channel-1')],
      lookup: jest.fn().mockResolvedValue(null),
    });
    harness.claimChannelAutoPost.mockResolvedValue({ status: 'in_progress' });

    await expect(harness.runner.runIfDue()).resolves.toEqual({
      status: 'deferred',
      deferReason: 'marker_in_progress',
      stopCurrentTick: false,
      scannedCandidates: 1,
      remoteLookups: 1,
      mutationAttempts: 0,
      terminalizedCandidates: 0,
    });
    expect(harness.completeChannelAutoPost).not.toHaveBeenCalled();
  });

  it('contains terminal marker persistence errors inside the recovery sweep', async () => {
    const harness = createHarness({
      candidates: [candidate('channel-1')],
      contextRows: [contextRow('channel-1')],
      lookup: jest.fn().mockResolvedValue(null),
    });
    harness.claimChannelAutoPost.mockRejectedValue(new Error('database unavailable'));

    await expect(harness.runner.runIfDue()).resolves.toEqual(
      expect.objectContaining({
        status: 'deferred',
        deferReason: 'marker_in_progress',
        stopCurrentTick: false,
      }),
    );
    expect(harness.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'database unavailable' }),
      'Deferred legacy channel button recovery after marker error',
    );
  });

  it('holds the cursor when attach reports an in-progress marker', async () => {
    const harness = createHarness({
      candidates: [candidate('channel-1')],
      contextRows: [contextRow('channel-1')],
    });
    harness.attach.mockResolvedValue('in_progress');

    await expect(harness.runner.runIfDue()).resolves.toEqual(
      expect.objectContaining({
        status: 'deferred',
        deferReason: 'marker_in_progress',
        mutationAttempts: 1,
      }),
    );
  });

  it('terminalizes a legacy edit when the current guard cannot prove bot authorship', async () => {
    const harness = createHarness({
      candidates: [candidate('channel-1')],
      contextRows: [contextRow('channel-1')],
    });
    harness.attach.mockResolvedValue('skipped');

    await expect(harness.runner.runIfDue()).resolves.toEqual(
      expect.objectContaining({
        status: 'completed',
        mutationAttempts: 1,
        terminalizedCandidates: 1,
      }),
    );
    expect(harness.completeChannelAutoPost).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'SKIPPED',
        deliveryMode: 'edit_message',
        lastError: expect.stringContaining('no verifiable bot author'),
      }),
    );
  });
});

// FLAG: Held candidates preserve ambiguous evidence even when no current channel context exists.
it.each(['marker', 'retryable_edit_marker', 'predispatch_marker'] as const)(
  'does not claim or terminalize a held %s source',
  async (evidence) => {
    const h = createHarness({ candidates: [candidate('-held', 'original-mid', evidence)] });
    h.isMessageHeld.mockResolvedValue(true);
    expect(await h.runner.runIfDue()).toMatchObject({
      status: 'completed',
      mutationAttempts: 0,
      terminalizedCandidates: 0,
    });
    expect(h.isMessageHeld).toHaveBeenCalledWith('-held', 'original-mid');
    expect(h.claimChannelAutoPost).not.toHaveBeenCalled();
    expect(h.completeChannelAutoPost).not.toHaveBeenCalled();
    expect(h.lookup).not.toHaveBeenCalled();
    expect(h.attach).not.toHaveBeenCalled();
  },
);
