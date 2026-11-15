import {
  persistChannelAutoPostPreDispatchFailureEvidence,
  ReplacementAttachMarkerStore,
} from './replacement-attach-marker.store';
import { PrismaClient } from '../prisma/prisma-client';

type TestMarkerRow = {
  id: string;
  chatId: string;
  messageId: string;
  status: 'IN_PROGRESS' | 'SUCCEEDED' | 'SKIPPED';
  lockToken: string | null;
  lockedAt: Date | null;
  source: 'webhook' | 'poll';
  botId: string | null;
  linkType: string | null;
  deliveryMode: string | null;
  replacementMessageId: string | null;
  replyMessageId: string | null;
  replacementSendStartedAt: Date | null;
  publishedUrl: string | null;
  originalDeleted: boolean;
  cleanupIntentId: string | null;
  lastError: string | null;
  lastStatusCode?: number | null;
};

function createMarkerDelegate(initial: TestMarkerRow | null = null) {
  let row = initial;

  const delegate = {
    findUnique: jest.fn(async () => row),
    createMany: jest.fn(async ({ data }: any) => {
      if (row) {
        return { count: 0 };
      }
      row = {
        deliveryMode: null,
        replacementMessageId: null,
        replyMessageId: null,
        replacementSendStartedAt: null,
        lastError: null,
        ...data[0],
      } as TestMarkerRow;
      return { count: 1 };
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      if (!row || row.chatId !== where.chatId || row.messageId !== where.messageId) {
        return { count: 0 };
      }
      for (const field of [
        'id',
        'status',
        'lockToken',
        'lockedAt',
        'deliveryMode',
        'replacementMessageId',
        'replyMessageId',
        'replacementSendStartedAt',
        'publishedUrl',
        'originalDeleted',
        'cleanupIntentId',
        'lastError',
      ] as const) {
        if (Object.prototype.hasOwnProperty.call(where, field) && row[field] !== where[field]) {
          return { count: 0 };
        }
      }
      if (
        Array.isArray(where.OR) &&
        !where.OR.some((condition: any) => {
          if (condition.lockedAt === null) {
            return row?.lockedAt === null;
          }
          const before = condition.lockedAt?.lt;
          return before instanceof Date && row?.lockedAt instanceof Date && row.lockedAt < before;
        })
      ) {
        return { count: 0 };
      }
      row = { ...row, ...data };
      return { count: 1 };
    }),
  };

  return {
    delegate,
    get row() {
      return row;
    },
  };
}

function legacySkippedEdit(messageId: string): TestMarkerRow {
  return {
    id: `marker-${messageId}`,
    chatId: 'channel-1',
    messageId,
    status: 'SKIPPED',
    lockToken: null,
    lockedAt: null,
    source: 'poll',
    botId: 'bot-edit',
    linkType: null,
    deliveryMode: 'edit_message',
    replacementMessageId: null,
    replyMessageId: null,
    replacementSendStartedAt: null,
    publishedUrl: null,
    originalDeleted: false,
    cleanupIntentId: null,
    lastError: 'Error on message edit',
    lastStatusCode: 400,
  };
}

const channelClaim = {
  chatId: 'channel-1',
  source: 'poll' as const,
  botId: 'bot-edit',
  linkType: null,
  hasEngagementButtons: true,
};

describe('ReplacementAttachMarkerStore generated Prisma query validation', () => {
  it.each(['chat_auto_comment', 'channel_auto_post'] as const)(
    'uses only fields belonging to the %s model',
    async (kind) => {
      const queryRaw = jest.fn(async () => ({ columnNames: [], columnTypes: [], rows: [] }));
      const client = new PrismaClient({
        adapter: {
          provider: 'postgres',
          adapterName: 'query-validation-fixture',
          connect: async () => ({
            provider: 'postgres',
            adapterName: 'query-validation-fixture',
            queryRaw,
            executeRaw: async () => 0,
            dispose: async () => undefined,
          }),
        } as never,
      });
      const marker = createMarkerDelegate();
      const findUnique = jest.fn(async (args: never) =>
        kind === 'chat_auto_comment'
          ? client.chatAutoCommentAttachMarker.findUnique(args)
          : client.channelAutoPostAttachMarker.findUnique(args),
      );
      const store = new ReplacementAttachMarkerStore({
        auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
        [kind === 'chat_auto_comment'
          ? 'chatAutoCommentAttachMarker'
          : 'channelAutoPostAttachMarker']: {
          ...marker.delegate,
          findUnique,
        },
      } as never);
      try {
        const result =
          kind === 'chat_auto_comment'
            ? await store.claimChatAutoComment({
                chatId: 'fixture-chat',
                messageId: 'fixture-message',
                source: 'webhook',
                botId: 'fixture-bot',
              })
            : await store.claimChannelAutoPost({ ...channelClaim, messageId: 'fixture-message' });
        expect(result.status).toBe('claimed');
        expect(queryRaw).toHaveBeenCalled();
        const query = findUnique.mock.calls.at(-1)?.[0] as unknown as {
          select: Record<string, unknown>;
        };
        expect(query.select.linkType).toBe(kind === 'channel_auto_post' ? true : undefined);
      } finally {
        await client.$disconnect();
      }
    },
  );
});

function publisherAdmissionMarker(overrides: Partial<TestMarkerRow> = {}): TestMarkerRow {
  return {
    id: 'ccr1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    chatId: 'chat-1',
    messageId: 'message-1',
    status: 'IN_PROGRESS',
    lockToken: 'claim-lock-1',
    lockedAt: new Date('2026-08-26T09:00:00.000Z'),
    source: 'webhook',
    botId: 'main-bot',
    linkType: null,
    deliveryMode: null,
    replacementMessageId: null,
    replyMessageId: null,
    replacementSendStartedAt: null,
    publishedUrl: null,
    originalDeleted: false,
    cleanupIntentId: null,
    lastError: null,
    lastStatusCode: null,
    ...overrides,
  };
}

describe('ReplacementAttachMarkerStore publisher admission terminalization', () => {
  const terminalize = (store: ReplacementAttachMarkerStore) =>
    store.skipChatAutoCommentAfterPublisherAdmissionFailure({
      markerId: 'ccr1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      chatId: 'chat-1',
      messageId: 'message-1',
      lockToken: 'claim-lock-1',
      botId: 'main-bot',
      reason: 'dispatch_disabled',
    });

  it('terminalizes only the exact unfenced claim with stable admission evidence', async () => {
    const marker = createMarkerDelegate(publisherAdmissionMarker());
    const store = new ReplacementAttachMarkerStore({
      chatAutoCommentAttachMarker: marker.delegate,
    } as never);

    await expect(terminalize(store)).resolves.toBeUndefined();

    expect(marker.delegate.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'ccr1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        chatId: 'chat-1',
        messageId: 'message-1',
        lockToken: 'claim-lock-1',
        status: 'IN_PROGRESS',
        deliveryMode: null,
        replacementMessageId: null,
        replyMessageId: null,
        replacementSendStartedAt: null,
        publishedUrl: null,
        originalDeleted: false,
        cleanupIntentId: null,
      },
      data: {
        status: 'SKIPPED',
        lockToken: null,
        lockedAt: null,
        source: 'webhook',
        botId: 'main-bot',
        deliveryMode: null,
        replacementMessageId: null,
        replyMessageId: null,
        replacementSendStartedAt: null,
        publishedUrl: null,
        originalDeleted: false,
        cleanupIntentId: null,
        lastError: 'Publisher chat-comment admission failed: dispatch_disabled',
        lastStatusCode: null,
      },
    });
    expect(marker.row).toEqual(
      expect.objectContaining({
        status: 'SKIPPED',
        lockToken: null,
        lockedAt: null,
        lastError: 'Publisher chat-comment admission failed: dispatch_disabled',
        lastStatusCode: null,
      }),
    );
  });

  it('keeps a fresh crash claim pending and reclaims it only after its lease is stale', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-26T09:00:00.000Z'));
    try {
      const marker = createMarkerDelegate(
        publisherAdmissionMarker({
          lockedAt: new Date('2026-08-26T09:00:00.000Z'),
          lockToken: 'publisher-chat-comment:v1:7:3:claim-lock-1',
        }),
      );
      const store = new ReplacementAttachMarkerStore({
        auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
        chatAutoCommentAttachMarker: marker.delegate,
      } as never);
      const claim = () =>
        store.claimChatAutoComment({
          chatId: 'chat-1',
          messageId: 'message-1',
          source: 'webhook',
          botId: 'main-bot',
          publisherSettingsRevision: 7,
          publicationPolicyRevision: 3,
        });

      await expect(claim()).resolves.toEqual({ status: 'in_progress' });
      await expect(
        store.readChatAutoCommentPendingJobIdentity({
          chatId: 'chat-1',
          messageId: 'message-1',
        }),
      ).resolves.toEqual({
        markerId: 'ccr1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        lockToken: 'publisher-chat-comment:v1:7:3:claim-lock-1',
        publisherSettingsRevision: 7,
        publicationPolicyRevision: 3,
      });

      jest.setSystemTime(new Date('2026-08-26T09:02:01.000Z'));
      const reclaimed = await claim();

      expect(reclaimed).toEqual({
        status: 'claimed',
        markerId: 'ccr1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        lockToken: expect.any(String),
      });
      expect(reclaimed.status === 'claimed' && reclaimed.lockToken).toMatch(
        /^publisher-chat-comment:v1:7:3:/u,
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not reclaim a crashed predispatch claim after settings revision changes', async () => {
    const marker = createMarkerDelegate(
      publisherAdmissionMarker({
        lockedAt: new Date(Date.now() - 3 * 60_000),
        lockToken: 'publisher-chat-comment:v1:7:3:claim-lock-1',
      }),
    );
    const store = new ReplacementAttachMarkerStore({
      auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
      chatAutoCommentAttachMarker: marker.delegate,
    } as never);

    await expect(
      store.claimChatAutoComment({
        chatId: 'chat-1',
        messageId: 'message-1',
        source: 'webhook',
        botId: 'main-bot',
        publisherSettingsRevision: 8,
        publicationPolicyRevision: 3,
      }),
    ).resolves.toEqual({ status: 'settings_changed' });
    expect(marker.row).toEqual(
      expect.objectContaining({
        status: 'SKIPPED',
        lockToken: null,
        lastError: 'Publisher chat-comment settings changed before stale claim recovery',
      }),
    );
  });

  it('atomically fences a reply against exact enabled Publisher settings revision', async () => {
    const lockToken = 'publisher-chat-comment:v1:7:3:claim-lock-1';
    const marker = createMarkerDelegate(publisherAdmissionMarker({ lockToken }));
    const store = new ReplacementAttachMarkerStore({
      chatAutoCommentAttachMarker: marker.delegate,
      publisherEntitySettings: { findUnique: jest.fn() },
    } as never);

    await expect(
      store.recordChatReplySendStarted({
        markerId: 'ccr1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        chatId: 'chat-1',
        messageId: 'message-1',
        lockToken,
        senderBotId: 'main-bot',
        publisherSettingsRevision: 7,
        publicationPolicyRevision: 3,
      }),
    ).resolves.toEqual({ status: 'started', sendStartedAt: expect.any(Date) });
    expect(marker.delegate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chat: {
            publisherSettings: {
              is: {
                chatCommentsEnabled: true,
                chatCommentsAdminsEnabled: true,
                revision: 7,
              },
            },
            publicationPolicy: {
              is: {
                publikEnabled: true,
                revision: 3,
              },
            },
          },
        }),
      }),
    );
  });

  it.each([
    ['token ownership', { lockToken: 'new-owner-lock' }],
    ['send fence', { replacementSendStartedAt: new Date('2026-08-26T09:00:01.000Z') }],
    ['persisted result', { replyMessageId: 'publisher-reply-1' }],
    ['terminal status', { status: 'SUCCEEDED' as const }],
  ] as const)('rejects a stale admission outcome after %s changes', async (_label, override) => {
    const initial = publisherAdmissionMarker(override);
    const marker = createMarkerDelegate(initial);
    const store = new ReplacementAttachMarkerStore({
      chatAutoCommentAttachMarker: marker.delegate,
    } as never);

    await expect(terminalize(store)).rejects.toThrow(
      'Failed to terminalize the publisher chat-comment admission marker',
    );
    expect(marker.row).toEqual(initial);
  });
});

describe('ReplacementAttachMarkerStore legacy channel edit recovery', () => {
  it('persists only explicit MAX circuit and internal-limiter predispatch proofs', () => {
    expect(
      persistChannelAutoPostPreDispatchFailureEvidence(
        {
          code: 'MAX_API_CIRCUIT_OPEN',
          preDispatch: true,
        },
        'MAX API circuit breaker is open',
      ),
    ).toBe(
      '[channel-auto-post:pre-dispatch:v1][MAX_API_CIRCUIT_OPEN] MAX API circuit breaker is open',
    );
    expect(
      persistChannelAutoPostPreDispatchFailureEvidence(
        {
          code: 'MAX_API_INTERNAL_RATE_LIMIT',
          preDispatch: true,
        },
        'MAX API background rate limit exceeded',
      ),
    ).toBe(
      '[channel-auto-post:pre-dispatch:v1][MAX_API_INTERNAL_RATE_LIMIT] MAX API background rate limit exceeded',
    );
    expect(
      persistChannelAutoPostPreDispatchFailureEvidence(
        { code: 'ECONNRESET', preDispatch: true },
        'socket hang up',
      ),
    ).toBe('socket hang up');
    expect(
      persistChannelAutoPostPreDispatchFailureEvidence(
        { code: 'MAX_API_CIRCUIT_OPEN', preDispatch: false },
        'untrusted phase',
      ),
    ).toBe('untrusted phase');
    expect(
      persistChannelAutoPostPreDispatchFailureEvidence(
        new Error('MAX API circuit breaker is open'),
        'MAX API circuit breaker is open',
      ),
    ).toBe('[channel-auto-post:unverified-failure:v1] MAX API circuit breaker is open');
    expect(
      persistChannelAutoPostPreDispatchFailureEvidence(
        new Error('spoofed proof'),
        '[channel-auto-post:pre-dispatch:v1][MAX_API_INTERNAL_RATE_LIMIT] spoofed proof',
      ),
    ).toBe(
      '[channel-auto-post:unverified-failure:v1] [channel-auto-post:pre-dispatch:v1][MAX_API_INTERNAL_RATE_LIMIT] spoofed proof',
    );
  });

  it('does not reclaim a channel row from a stale snapshot after a create conflict', async () => {
    const createMany = jest.fn().mockResolvedValue({ count: 0 });
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const store = new ReplacementAttachMarkerStore({
      auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
      channelAutoPostAttachMarker: {
        findUnique: jest.fn().mockResolvedValue(null),
        createMany,
        updateMany,
      },
    } as never);

    await expect(
      store.claimChannelAutoPost({
        ...channelClaim,
        messageId: 'message-create-conflict',
      }),
    ).resolves.toEqual({ status: 'in_progress' });
    expect(createMany).toHaveBeenCalledWith(expect.objectContaining({ skipDuplicates: true }));
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('reclaims a marker-backed skipped edit once and versions a repeated terminal edit failure', async () => {
    const marker = createMarkerDelegate(legacySkippedEdit('message-marker'));
    const auditFindFirst = jest.fn();
    const store = new ReplacementAttachMarkerStore({
      auditLog: { findFirst: auditFindFirst },
      channelAutoPostAttachMarker: marker.delegate,
    } as never);

    const first = await store.claimChannelAutoPost({
      ...channelClaim,
      messageId: 'message-marker',
    });
    expect(first).toEqual({
      status: 'claimed',
      lockToken: expect.stringContaining('channel-engagement-edit-recovery:v1:'),
    });
    expect(marker.row).toEqual(
      expect.objectContaining({
        status: 'IN_PROGRESS',
        lastError: expect.stringContaining('[channel-engagement-edit-recovery:v1]'),
      }),
    );

    if (first.status !== 'claimed') {
      throw new Error('Expected the legacy marker to be claimed');
    }
    await store.completeChannelAutoPost({
      chatId: 'channel-1',
      messageId: 'message-marker',
      lockToken: first.lockToken,
      status: 'SKIPPED',
      source: 'poll',
      botId: 'bot-edit',
      linkType: null,
      deliveryMode: 'edit_message',
      lastError: 'Error on message edit',
      lastStatusCode: 400,
    });

    await expect(
      store.claimChannelAutoPost({ ...channelClaim, messageId: 'message-marker' }),
    ).resolves.toEqual({ status: 'done' });
    expect(marker.row).toEqual(
      expect.objectContaining({
        status: 'SKIPPED',
        deliveryMode: 'edit_message',
        lastError: '[channel-engagement-edit-recovery:v1] Error on message edit',
      }),
    );
    expect(marker.delegate.updateMany).toHaveBeenCalledTimes(2);
    expect(auditFindFirst).toHaveBeenCalledTimes(1);
  });

  it('clears a stale replacement send fence on terminal completion', async () => {
    const marker = createMarkerDelegate({
      ...legacySkippedEdit('message-stale-fence'),
      status: 'IN_PROGRESS',
      lockToken: 'owned-lock',
      lockedAt: new Date('2026-08-09T10:00:00.000Z'),
      replacementSendStartedAt: new Date('2026-08-09T10:01:00.000Z'),
    });
    const store = new ReplacementAttachMarkerStore({
      auditLog: { findFirst: jest.fn() },
      channelAutoPostAttachMarker: marker.delegate,
    } as never);

    await store.completeChannelAutoPost({
      chatId: 'channel-1',
      messageId: 'message-stale-fence',
      lockToken: 'owned-lock',
      status: 'SUCCEEDED',
      source: 'poll',
      botId: 'bot-edit',
      linkType: null,
      deliveryMode: 'reply_message',
      replyMessageId: 'reply-message',
      lastError: null,
      lastStatusCode: null,
    });

    expect(marker.row).toEqual(
      expect.objectContaining({
        status: 'SUCCEEDED',
        replyMessageId: 'reply-message',
        replacementSendStartedAt: null,
      }),
    );
  });

  it('clears a reply send fence after a confirmed terminal rejection without a remote id', async () => {
    const marker = createMarkerDelegate({
      ...legacySkippedEdit('message-confirmed-rejection'),
      status: 'IN_PROGRESS',
      lockToken: 'owned-lock',
      lockedAt: new Date('2026-08-09T10:00:00.000Z'),
      deliveryMode: 'reply_message',
      replacementSendStartedAt: new Date('2026-08-09T10:01:00.000Z'),
    });
    const store = new ReplacementAttachMarkerStore({
      auditLog: { findFirst: jest.fn() },
      channelAutoPostAttachMarker: marker.delegate,
    } as never);

    await store.completeChannelAutoPost({
      chatId: 'channel-1',
      messageId: 'message-confirmed-rejection',
      lockToken: 'owned-lock',
      status: 'SKIPPED',
      source: 'poll',
      botId: 'bot-edit',
      linkType: null,
      deliveryMode: 'reply_message',
      lastError: 'MAX rejected the fallback reply.',
      lastStatusCode: 403,
    });

    expect(marker.row).toEqual(
      expect.objectContaining({
        status: 'SKIPPED',
        replyMessageId: null,
        replacementSendStartedAt: null,
        lastStatusCode: 403,
      }),
    );
  });

  it('creates a durable marker for an audit-only skipped edit and does not reclaim it again', async () => {
    const marker = createMarkerDelegate();
    const auditFindFirst = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'legacy-skip-audit',
        payload: {
          messageId: 'message-audit-only',
          deliveryMode: 'edit_message',
          linkType: null,
          error: 'errors.process.attachment.movie.access.denied',
        },
      });
    const store = new ReplacementAttachMarkerStore({
      auditLog: { findFirst: auditFindFirst },
      channelAutoPostAttachMarker: marker.delegate,
    } as never);

    const first = await store.claimChannelAutoPost({
      ...channelClaim,
      messageId: 'message-audit-only',
    });
    expect(first).toEqual({
      status: 'claimed',
      lockToken: expect.stringContaining('channel-engagement-edit-recovery:v1:'),
    });
    expect(marker.delegate.createMany).toHaveBeenCalledTimes(1);

    if (first.status !== 'claimed') {
      throw new Error('Expected the audit-only legacy skip to be claimed');
    }
    await store.completeChannelAutoPost({
      chatId: 'channel-1',
      messageId: 'message-audit-only',
      lockToken: first.lockToken,
      status: 'SKIPPED',
      source: 'poll',
      botId: null,
      linkType: null,
      deliveryMode: 'reply_message',
      lastError: 'No eligible MAX send route is available for the channel reply fallback.',
      lastStatusCode: 403,
    });

    await expect(
      store.claimChannelAutoPost({ ...channelClaim, messageId: 'message-audit-only' }),
    ).resolves.toEqual({ status: 'done' });
    expect(marker.row).toEqual(
      expect.objectContaining({
        status: 'SKIPPED',
        deliveryMode: 'reply_message',
      }),
    );
    expect(marker.delegate.createMany).toHaveBeenCalledTimes(1);
    expect(auditFindFirst).toHaveBeenCalledTimes(2);
  });

  it('does not recover an audit-only edit after both current edit strategies were exhausted', async () => {
    const marker = createMarkerDelegate();
    const auditFindFirst = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'terminal-skip-audit',
        payload: {
          messageId: 'message-terminal-audit-only',
          deliveryMode: 'edit_message',
          linkType: null,
          terminalEditAttemptExhausted: true,
          error: 'Error on message edit',
        },
      });
    const store = new ReplacementAttachMarkerStore({
      auditLog: { findFirst: auditFindFirst },
      channelAutoPostAttachMarker: marker.delegate,
    } as never);

    await expect(
      store.claimChannelAutoPost({
        ...channelClaim,
        messageId: 'message-terminal-audit-only',
      }),
    ).resolves.toEqual({ status: 'done' });
    expect(marker.delegate.createMany).not.toHaveBeenCalled();
    expect(auditFindFirst).toHaveBeenCalledTimes(2);
  });

  it('keeps a transient fallback reply failure eligible for a later exact-state retry', async () => {
    const marker = createMarkerDelegate(legacySkippedEdit('message-transient'));
    const store = new ReplacementAttachMarkerStore({
      auditLog: { findFirst: jest.fn() },
      channelAutoPostAttachMarker: marker.delegate,
    } as never);

    const first = await store.claimChannelAutoPost({
      ...channelClaim,
      messageId: 'message-transient',
    });
    if (first.status !== 'claimed') {
      throw new Error('Expected the legacy marker to be claimed');
    }
    await store.recordChannelReplySendStarted({
      chatId: 'channel-1',
      messageId: 'message-transient',
      lockToken: first.lockToken,
    });
    expect(marker.row).toEqual(
      expect.objectContaining({
        deliveryMode: 'reply_message',
        replacementSendStartedAt: expect.any(Date),
      }),
    );
    await store.releaseChannelAutoPost({
      chatId: 'channel-1',
      messageId: 'message-transient',
      lockToken: first.lockToken,
      source: 'poll',
      botId: 'bot-edit',
      linkType: null,
      lastError: 'MAX throttle',
      lastStatusCode: 429,
    });
    expect(marker.row).toEqual(
      expect.objectContaining({
        status: 'SKIPPED',
        lockToken: null,
        lockedAt: null,
        deliveryMode: 'edit_message',
        replacementSendStartedAt: null,
        lastError: 'MAX throttle',
      }),
    );

    await expect(
      store.claimChannelAutoPost({ ...channelClaim, messageId: 'message-transient' }),
    ).resolves.toEqual({
      status: 'claimed',
      lockToken: expect.stringContaining('channel-engagement-edit-recovery:v1:'),
    });
    expect(marker.row).toEqual(
      expect.objectContaining({
        status: 'IN_PROGRESS',
        lastError: '[channel-engagement-edit-recovery:v1] MAX throttle',
      }),
    );
  });

  it.each([
    {
      label: 'only a post signature is enabled',
      claim: { hasEngagementButtons: false, linkType: null },
      marker: legacySkippedEdit('message-signature-only'),
    },
    {
      label: 'the current post is forwarded',
      claim: { hasEngagementButtons: true, linkType: 'forward' },
      marker: legacySkippedEdit('message-forward'),
    },
    {
      label: 'the old delivery used delete-message replacement',
      claim: { hasEngagementButtons: true, linkType: null },
      marker: {
        ...legacySkippedEdit('message-replacement'),
        deliveryMode: 'replace_with_bot_message',
      },
    },
    {
      label: 'the prior edit result is ambiguous',
      claim: { hasEngagementButtons: true, linkType: null },
      marker: {
        ...legacySkippedEdit('message-ambiguous'),
        lastError: '[max.send_ambiguous] Edit may have reached MAX',
      },
    },
  ])('does not reclaim when $label', async ({ claim, marker: initialMarker }) => {
    const marker = createMarkerDelegate(initialMarker);
    const store = new ReplacementAttachMarkerStore({
      auditLog: { findFirst: jest.fn() },
      channelAutoPostAttachMarker: marker.delegate,
    } as never);

    await expect(
      store.claimChannelAutoPost({
        chatId: 'channel-1',
        messageId: initialMarker.messageId,
        source: 'poll',
        botId: 'bot-edit',
        ...claim,
      }),
    ).resolves.toEqual({ status: 'done' });
    expect(marker.delegate.updateMany).not.toHaveBeenCalled();
  });

  it('does not reclaim a stale channel edit claim without durable predispatch evidence', async () => {
    const marker = createMarkerDelegate({
      ...legacySkippedEdit('message-stale-unknown'),
      status: 'IN_PROGRESS',
      lockedAt: new Date('2026-08-09T10:00:00.000Z'),
      deliveryMode: null,
      lastError: 'socket hang up',
    });
    const store = new ReplacementAttachMarkerStore({
      auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
      channelAutoPostAttachMarker: marker.delegate,
    } as never);

    await expect(
      store.claimChannelAutoPost({
        ...channelClaim,
        messageId: 'message-stale-unknown',
      }),
    ).resolves.toEqual({ status: 'in_progress' });
    expect(marker.delegate.updateMany).not.toHaveBeenCalled();
  });

  it('persists replay-safe edit intent and retries a released timeout without discussion buttons', async () => {
    const marker = createMarkerDelegate();
    const store = new ReplacementAttachMarkerStore({
      auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
      channelAutoPostAttachMarker: marker.delegate,
    } as never);
    const params = {
      ...channelClaim,
      messageId: 'signature-timeout',
      hasEngagementButtons: false,
      replaySafeEdit: true,
    };
    const first = await store.claimChannelAutoPost(params);
    expect(first.status).toBe('claimed');
    if (first.status !== 'claimed') throw new Error('Expected edit claim');
    expect(marker.row?.deliveryMode).toBe('edit_message');
    await expect(store.claimChannelAutoPost(params)).resolves.toEqual({ status: 'in_progress' });
    await store.releaseChannelAutoPost({
      ...params,
      lockToken: first.lockToken,
      lastError: 'MAX response timed out',
      lastStatusCode: 504,
    });
    const second = await store.claimChannelAutoPost(params);
    expect(second.status).toBe('claimed');
    if (second.status !== 'claimed') throw new Error('Expected retry claim');
    expect(second.lockToken).not.toBe(first.lockToken);
    await expect(
      store.assertChannelEditClaimCurrent({
        chatId: params.chatId,
        messageId: params.messageId,
        lockToken: first.lockToken,
      }),
    ).rejects.toThrow('no longer current');
    await expect(
      store.assertChannelEditClaimCurrent({
        chatId: params.chatId,
        messageId: params.messageId,
        lockToken: second.lockToken,
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    { label: 'stale pure edit', overrides: {}, replaySafeEdit: true, expected: 'claimed' },
    {
      label: 'unproven edit',
      overrides: { deliveryMode: null },
      replaySafeEdit: true,
      expected: 'in_progress',
    },
    {
      label: 'caller without fresh edit semantics',
      overrides: {},
      replaySafeEdit: false,
      expected: 'in_progress',
    },
    {
      label: 'send fence',
      overrides: { replacementSendStartedAt: new Date() },
      replaySafeEdit: true,
      expected: 'in_progress',
    },
    {
      label: 'delivered replacement',
      overrides: { replacementMessageId: 'copy' },
      replaySafeEdit: true,
      expected: 'in_progress',
    },
    {
      label: 'delivered reply',
      overrides: { replyMessageId: 'reply' },
      replaySafeEdit: true,
      expected: 'in_progress',
    },
  ])(
    'recovers only proven in-place edits: $label',
    async ({ overrides, replaySafeEdit, expected }) => {
      const marker = createMarkerDelegate({
        ...legacySkippedEdit('crashed-edit'),
        status: 'IN_PROGRESS',
        lockedAt: new Date(Date.now() - 5 * 60_000),
        lockToken: 'old',
        ...overrides,
      });
      const store = new ReplacementAttachMarkerStore({
        auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
        channelAutoPostAttachMarker: marker.delegate,
      } as never);
      expect(
        await store.claimChannelAutoPost({
          ...channelClaim,
          messageId: 'crashed-edit',
          replaySafeEdit,
        }),
      ).toMatchObject({ status: expected });
    },
  );

  it.each([
    'MAX API circuit breaker is open',
    '[channel-auto-post:pre-dispatch:v1][MAX_API_INTERNAL_RATE_LIMIT] MAX API background rate limit exceeded',
  ])('reclaims a stale channel claim with proven predispatch evidence: %s', async (lastError) => {
    const marker = createMarkerDelegate({
      ...legacySkippedEdit('message-stale-predispatch'),
      status: 'IN_PROGRESS',
      lockedAt: null,
      deliveryMode: null,
      lastError,
    });
    const store = new ReplacementAttachMarkerStore({
      auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
      channelAutoPostAttachMarker: marker.delegate,
    } as never);

    await expect(
      store.claimChannelAutoPost({
        ...channelClaim,
        messageId: 'message-stale-predispatch',
      }),
    ).resolves.toEqual({
      status: 'claimed',
      lockToken: expect.any(String),
    });
    expect(marker.delegate.updateMany).toHaveBeenCalledTimes(1);
    expect(marker.delegate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ lastError, lockedAt: null }),
      }),
    );
    expect(marker.row).toEqual(
      expect.objectContaining({
        lastError:
          '[channel-auto-post:pre-dispatch-proof-consumed:v1] Recovery claim acquired; a stale outcome requires verification.',
      }),
    );
    if (!marker.row) {
      throw new Error('Expected the reclaimed marker to remain persisted');
    }
    marker.row.lockedAt = new Date(0);
    await expect(
      store.claimChannelAutoPost({
        ...channelClaim,
        messageId: 'message-stale-predispatch',
      }),
    ).resolves.toEqual({ status: 'in_progress' });
    expect(marker.delegate.updateMany).toHaveBeenCalledTimes(1);
  });

  it('does not steal a proven predispatch claim that still has a lock owner', async () => {
    const lastError = 'MAX API circuit breaker is open';
    const marker = createMarkerDelegate({
      ...legacySkippedEdit('message-locked-predispatch'),
      status: 'IN_PROGRESS',
      lockedAt: new Date('2026-08-09T10:00:00.000Z'),
      deliveryMode: null,
      lastError,
    });
    const store = new ReplacementAttachMarkerStore({
      auditLog: { findFirst: jest.fn().mockResolvedValue(null) },
      channelAutoPostAttachMarker: marker.delegate,
    } as never);

    await expect(
      store.claimChannelAutoPost({
        ...channelClaim,
        messageId: 'message-locked-predispatch',
      }),
    ).resolves.toEqual({ status: 'in_progress' });
    expect(marker.row).toEqual(expect.objectContaining({ lastError }));
  });

  it('lets successful auto-attach evidence win over an older skipped edit audit', async () => {
    const marker = createMarkerDelegate();
    const auditFindFirst = jest.fn().mockResolvedValueOnce({ id: 'successful-auto-attach' });
    const store = new ReplacementAttachMarkerStore({
      auditLog: { findFirst: auditFindFirst },
      channelAutoPostAttachMarker: marker.delegate,
    } as never);

    await expect(
      store.claimChannelAutoPost({ ...channelClaim, messageId: 'message-already-fixed' }),
    ).resolves.toEqual({ status: 'done' });
    expect(auditFindFirst).toHaveBeenCalledTimes(1);
    expect(marker.delegate.createMany).not.toHaveBeenCalled();
  });

  it('lets successful audit evidence win over a recoverable skipped marker', async () => {
    const marker = createMarkerDelegate(legacySkippedEdit('message-marker-already-fixed'));
    const auditFindFirst = jest.fn().mockResolvedValueOnce({ id: 'successful-publish' });
    const store = new ReplacementAttachMarkerStore({
      auditLog: { findFirst: auditFindFirst },
      channelAutoPostAttachMarker: marker.delegate,
    } as never);

    await expect(
      store.claimChannelAutoPost({
        ...channelClaim,
        messageId: 'message-marker-already-fixed',
      }),
    ).resolves.toEqual({ status: 'done' });
    expect(auditFindFirst).toHaveBeenCalledTimes(1);
    expect(marker.delegate.updateMany).not.toHaveBeenCalled();
  });

  it('does not reclaim an audit-only edit with ambiguous delivery evidence', async () => {
    const marker = createMarkerDelegate();
    const auditFindFirst = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'ambiguous-skip-audit',
        payload: {
          messageId: 'message-ambiguous-audit',
          deliveryMode: 'edit_message',
          linkType: null,
          error: '[max.send_ambiguous] Edit may have reached MAX',
        },
      });
    const store = new ReplacementAttachMarkerStore({
      auditLog: { findFirst: auditFindFirst },
      channelAutoPostAttachMarker: marker.delegate,
    } as never);

    await expect(
      store.claimChannelAutoPost({
        ...channelClaim,
        messageId: 'message-ambiguous-audit',
      }),
    ).resolves.toEqual({ status: 'done' });
    expect(marker.delegate.createMany).not.toHaveBeenCalled();
  });

  it('treats a managed channel engagement publish audit as completed', async () => {
    const marker = createMarkerDelegate();
    const auditFindFirst = jest.fn().mockImplementation(async ({ where }: any) => {
      return where.action?.in?.includes('PUBLISH_CHANNEL_ENGAGEMENT')
        ? { id: 'managed-publish-audit' }
        : null;
    });
    const store = new ReplacementAttachMarkerStore({
      auditLog: { findFirst: auditFindFirst },
      channelAutoPostAttachMarker: marker.delegate,
    } as never);

    await expect(
      store.claimChannelAutoPost({ ...channelClaim, messageId: 'message-managed-publish' }),
    ).resolves.toEqual({ status: 'done' });
    expect(auditFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          action: {
            in: ['AUTO_ATTACH_CHANNEL_ENGAGEMENT', 'PUBLISH_CHANNEL_ENGAGEMENT'],
          },
        }),
      }),
    );
    expect(marker.delegate.createMany).not.toHaveBeenCalled();
  });

  it('lists marker-backed recovery candidates in a bounded eligible-channel window', async () => {
    const markerFindMany = jest.fn().mockResolvedValue([
      {
        id: 'marker-oldest',
        chatId: 'channel-1',
        messageId: 'message-oldest',
        createdAt: new Date('2026-08-03T10:00:00.000Z'),
      },
    ]);
    const auditFindMany = jest.fn().mockResolvedValue([]);
    const store = new ReplacementAttachMarkerStore({
      auditLog: { findMany: auditFindMany },
      channelAutoPostAttachMarker: {
        findMany: markerFindMany,
        createMany: jest.fn(),
        updateMany: jest.fn(),
      },
    } as never);

    await expect(
      store.listLegacyChannelEditRecoveryCandidates({
        now: new Date('2026-08-09T12:00:00.000Z'),
        lookbackMs: 7 * 24 * 60 * 60_000,
        minimumAgeMs: 10 * 60_000,
        limit: 1,
      }),
    ).resolves.toEqual({
      candidates: [
        {
          chatId: 'channel-1',
          messageId: 'message-oldest',
          evidence: 'marker',
          evidenceId: 'marker-oldest',
          evidenceAt: new Date('2026-08-03T10:00:00.000Z'),
        },
      ],
      nextMarkerCursor: {
        createdAt: new Date('2026-08-03T10:00:00.000Z'),
        id: 'marker-oldest',
      },
      markerScanExhausted: false,
      nextAuditCursor: null,
      auditScanExhausted: false,
    });
    expect(markerFindMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        replacementMessageId: null,
        replyMessageId: null,
        replacementSendStartedAt: null,
        createdAt: { gte: new Date('2026-08-02T12:00:00.000Z') },
        chat: {
          channelSettings: {
            is: {
              OR: [
                { commentsEnabled: true },
                { postSuggestionsEnabled: true },
                { postSignatureEnabled: true },
                { customPostButtonsEnabled: true },
              ],
            },
          },
        },
        AND: expect.arrayContaining([
          expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({
                status: 'SKIPPED',
                deliveryMode: 'edit_message',
                createdAt: { lte: new Date('2026-08-09T11:50:00.000Z') },
              }),
            ]),
          }),
        ]),
      }),
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 1,
      select: {
        id: true,
        chatId: true,
        messageId: true,
        createdAt: true,
        updatedAt: true,
        status: true,
        deliveryMode: true,
        lastError: true,
      },
    });
    expect(auditFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          action: {
            in: ['AUTO_ATTACH_CHANNEL_ENGAGEMENT', 'PUBLISH_CHANNEL_ENGAGEMENT'],
          },
          OR: [
            {
              chatId: 'channel-1',
              payload: { path: ['messageId'], equals: 'message-oldest' },
            },
          ],
        }),
      }),
    );
  });

  it('excludes marker candidates that already have successful audit evidence', async () => {
    const markerFindMany = jest.fn().mockResolvedValue([
      {
        id: 'marker-already-fixed',
        chatId: 'channel-1',
        messageId: 'message-already-fixed',
        createdAt: new Date('2026-08-09T10:00:00.000Z'),
      },
    ]);
    const auditFindMany = jest
      .fn()
      .mockResolvedValueOnce([
        {
          chatId: 'channel-1',
          payload: { messageId: 'message-already-fixed' },
        },
      ])
      .mockResolvedValueOnce([]);
    const store = new ReplacementAttachMarkerStore({
      auditLog: { findMany: auditFindMany },
      channelAutoPostAttachMarker: {
        findMany: markerFindMany,
        createMany: jest.fn(),
        updateMany: jest.fn(),
      },
    } as never);

    await expect(
      store.listLegacyChannelEditRecoveryCandidates({
        now: new Date('2026-08-09T12:00:00.000Z'),
        limit: 1,
      }),
    ).resolves.toEqual({
      candidates: [],
      nextMarkerCursor: {
        createdAt: new Date('2026-08-09T10:00:00.000Z'),
        id: 'marker-already-fixed',
      },
      markerScanExhausted: false,
      nextAuditCursor: null,
      auditScanExhausted: true,
    });
    expect(auditFindMany).toHaveBeenCalledTimes(2);
  });

  it('includes only proven predispatch in-progress markers for bounded recovery', async () => {
    const markerFindMany = jest.fn().mockResolvedValue([
      {
        id: 'marker-stale-recovery',
        chatId: 'channel-1',
        messageId: 'message-stale-recovery',
        createdAt: new Date('2026-08-09T10:00:00.000Z'),
        updatedAt: new Date('2026-08-09T10:30:00.000Z'),
        status: 'IN_PROGRESS',
        deliveryMode: null,
        lastError: 'MAX API circuit breaker is open',
      },
    ]);
    const store = new ReplacementAttachMarkerStore({
      auditLog: { findMany: jest.fn().mockResolvedValue([]) },
      channelAutoPostAttachMarker: {
        findMany: markerFindMany,
        createMany: jest.fn(),
        updateMany: jest.fn(),
      },
    } as never);

    await expect(
      store.listLegacyChannelEditRecoveryCandidates({
        now: new Date('2026-08-09T12:00:00.000Z'),
        limit: 1,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        candidates: [
          expect.objectContaining({
            messageId: 'message-stale-recovery',
            evidence: 'predispatch_marker',
          }),
        ],
      }),
    );
    expect(markerFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            expect.objectContaining({
              OR: expect.arrayContaining([
                expect.objectContaining({
                  status: 'IN_PROGRESS',
                  deliveryMode: null,
                  lockedAt: null,
                  updatedAt: { lte: new Date('2026-08-09T11:55:00.000Z') },
                  OR: expect.arrayContaining([{ lastError: 'MAX API circuit breaker is open' }]),
                }),
              ]),
            }),
          ]),
        }),
      }),
    );
  });

  it('ages a proven predispatch marker from its latest release instead of its creation', async () => {
    const markerRow = {
      id: 'marker-proof-age',
      chatId: 'channel-1',
      messageId: 'message-proof-age',
      createdAt: new Date('2026-08-09T10:00:00.000Z'),
      updatedAt: new Date('2026-08-09T11:58:00.000Z'),
      status: 'IN_PROGRESS',
      deliveryMode: null,
      lastError:
        '[channel-auto-post:pre-dispatch:v1][MAX_API_INTERNAL_RATE_LIMIT] MAX API background rate limit exceeded',
    };
    const markerFindMany = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([markerRow]);
    const store = new ReplacementAttachMarkerStore({
      auditLog: { findMany: jest.fn().mockResolvedValue([]) },
      channelAutoPostAttachMarker: {
        findMany: markerFindMany,
        createMany: jest.fn(),
        updateMany: jest.fn(),
      },
    } as never);

    await expect(
      store.listLegacyChannelEditRecoveryCandidates({
        now: new Date('2026-08-09T12:00:00.000Z'),
        limit: 1,
      }),
    ).resolves.toEqual(expect.objectContaining({ candidates: [] }));
    await expect(
      store.listLegacyChannelEditRecoveryCandidates({
        now: new Date('2026-08-09T12:05:00.000Z'),
        limit: 1,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        candidates: [
          expect.objectContaining({
            evidence: 'predispatch_marker',
            evidenceAt: markerRow.updatedAt,
          }),
        ],
      }),
    );
    expect(markerFindMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            expect.objectContaining({
              OR: expect.arrayContaining([
                expect.objectContaining({
                  status: 'IN_PROGRESS',
                  updatedAt: { lte: new Date('2026-08-09T11:55:00.000Z') },
                }),
              ]),
            }),
          ]),
        }),
      }),
    );
    expect(markerFindMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          AND: expect.arrayContaining([
            expect.objectContaining({
              OR: expect.arrayContaining([
                expect.objectContaining({
                  status: 'IN_PROGRESS',
                  updatedAt: { lte: new Date('2026-08-09T12:00:00.000Z') },
                }),
              ]),
            }),
          ]),
        }),
      }),
    );
  });

  it('advances a bounded marker cursor past a full page with successful audit evidence', async () => {
    const createdAt = new Date('2026-08-09T10:00:00.000Z');
    const successfulMarkers = Array.from({ length: 100 }, (_, index) => ({
      id: `marker-${String(index).padStart(3, '0')}`,
      chatId: `channel-${index}`,
      messageId: `message-${index}`,
      createdAt,
      updatedAt: createdAt,
    }));
    const targetMarker = {
      id: 'marker-target',
      chatId: 'channel-target',
      messageId: 'message-target',
      createdAt: new Date('2026-08-09T10:30:00.000Z'),
      updatedAt: new Date('2026-08-09T10:30:00.000Z'),
    };
    const markerFindMany = jest
      .fn()
      .mockResolvedValueOnce(successfulMarkers)
      .mockResolvedValueOnce([targetMarker]);
    const auditFindMany = jest
      .fn()
      .mockResolvedValueOnce(
        successfulMarkers.map((marker) => ({
          chatId: marker.chatId,
          payload: { messageId: marker.messageId },
        })),
      )
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const store = new ReplacementAttachMarkerStore({
      auditLog: { findMany: auditFindMany },
      channelAutoPostAttachMarker: {
        findMany: markerFindMany,
        createMany: jest.fn(),
        updateMany: jest.fn(),
      },
    } as never);

    const firstPage = await store.listLegacyChannelEditRecoveryCandidates({
      now: new Date('2026-08-09T12:00:00.000Z'),
      limit: 100,
    });
    expect(firstPage).toEqual(
      expect.objectContaining({
        candidates: [],
        nextMarkerCursor: { createdAt, id: 'marker-099' },
        markerScanExhausted: false,
      }),
    );

    await expect(
      store.listLegacyChannelEditRecoveryCandidates({
        now: new Date('2026-08-09T12:05:00.000Z'),
        limit: 100,
        markerCursor: firstPage.nextMarkerCursor,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        candidates: [expect.objectContaining({ messageId: 'message-target' })],
        markerScanExhausted: true,
      }),
    );
    expect(markerFindMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ createdAt: { gt: createdAt } }, { createdAt, id: { gt: 'marker-099' } }],
        }),
        take: 100,
      }),
    );
  });

  it('uses only remaining page capacity for audit candidates', async () => {
    const markerFindMany = jest
      .fn()
      .mockResolvedValueOnce([
        {
          id: 'marker-1',
          chatId: 'channel-1',
          messageId: 'message-marker',
          createdAt: new Date('2026-08-09T10:00:00.000Z'),
        },
      ])
      .mockResolvedValueOnce([]);
    const auditFindMany = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: 'audit-1',
          chatId: 'channel-2',
          payload: {
            messageId: 'message-audit',
            deliveryMode: 'edit_message',
            linkType: null,
          },
          createdAt: new Date('2026-08-09T10:30:00.000Z'),
        },
      ]);
    const store = new ReplacementAttachMarkerStore({
      auditLog: { findMany: auditFindMany },
      channelAutoPostAttachMarker: {
        findMany: markerFindMany,
        createMany: jest.fn(),
        updateMany: jest.fn(),
      },
    } as never);

    await expect(
      store.listLegacyChannelEditRecoveryCandidates({
        now: new Date('2026-08-09T12:00:00.000Z'),
        limit: 2,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        candidates: [
          expect.objectContaining({ messageId: 'message-marker' }),
          expect.objectContaining({ messageId: 'message-audit' }),
        ],
        nextAuditCursor: {
          createdAt: new Date('2026-08-09T10:30:00.000Z'),
          id: 'audit-1',
        },
      }),
    );
    expect(auditFindMany).toHaveBeenNthCalledWith(2, expect.objectContaining({ take: 1 }));
  });

  it('pages audit-only candidates deterministically and excludes rows with durable markers', async () => {
    const markerFindMany = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          chatId: 'channel-1',
          messageId: 'message-with-marker',
        },
      ]);
    const auditFindMany = jest.fn().mockResolvedValue([
      {
        id: 'audit-1',
        chatId: 'channel-1',
        payload: {
          messageId: 'message-with-marker',
          deliveryMode: 'edit_message',
          linkType: null,
        },
        createdAt: new Date('2026-08-07T10:00:00.000Z'),
      },
      {
        id: 'audit-2',
        chatId: 'channel-2',
        payload: {
          messageId: 'message-audit-only',
          deliveryMode: 'edit_message',
          linkType: null,
        },
        createdAt: new Date('2026-08-07T11:00:00.000Z'),
      },
    ]);
    const store = new ReplacementAttachMarkerStore({
      auditLog: { findMany: auditFindMany },
      channelAutoPostAttachMarker: {
        findMany: markerFindMany,
        createMany: jest.fn(),
        updateMany: jest.fn(),
      },
    } as never);

    await expect(
      store.listLegacyChannelEditRecoveryCandidates({
        now: new Date('2026-08-09T12:00:00.000Z'),
        limit: 2,
        auditCursor: {
          createdAt: new Date('2026-08-07T08:00:00.000Z'),
          id: 'audit-cursor',
        },
      }),
    ).resolves.toEqual({
      candidates: [
        {
          chatId: 'channel-2',
          messageId: 'message-audit-only',
          evidence: 'audit',
          evidenceId: 'audit-2',
          evidenceAt: new Date('2026-08-07T11:00:00.000Z'),
        },
      ],
      nextMarkerCursor: null,
      markerScanExhausted: true,
      nextAuditCursor: {
        createdAt: new Date('2026-08-07T11:00:00.000Z'),
        id: 'audit-2',
      },
      auditScanExhausted: false,
    });
    expect(auditFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          action: 'AUTO_ATTACH_CHANNEL_ENGAGEMENT_SKIPPED',
          createdAt: {
            gte: new Date('2026-08-06T12:00:00.000Z'),
            lte: new Date('2026-08-09T11:55:00.000Z'),
          },
          payload: { path: ['deliveryMode'], equals: 'edit_message' },
          OR: [
            { createdAt: { gt: new Date('2026-08-07T08:00:00.000Z') } },
            {
              createdAt: new Date('2026-08-07T08:00:00.000Z'),
              id: { gt: 'audit-cursor' },
            },
          ],
          chat: {
            channelSettings: {
              is: {
                OR: [
                  { commentsEnabled: true },
                  { postSuggestionsEnabled: true },
                  { postSignatureEnabled: true },
                  { customPostButtonsEnabled: true },
                ],
              },
            },
          },
        }),
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 2,
      }),
    );
    expect(markerFindMany).toHaveBeenNthCalledWith(2, {
      where: {
        OR: [
          { chatId: 'channel-1', messageId: 'message-with-marker' },
          { chatId: 'channel-2', messageId: 'message-audit-only' },
        ],
      },
      select: { chatId: true, messageId: true },
    });
  });

  it('caps candidate count and lookback before querying', async () => {
    const markerFindMany = jest.fn().mockResolvedValue([]);
    const auditFindMany = jest.fn().mockResolvedValue([]);
    const store = new ReplacementAttachMarkerStore({
      auditLog: { findMany: auditFindMany },
      channelAutoPostAttachMarker: {
        findMany: markerFindMany,
        createMany: jest.fn(),
        updateMany: jest.fn(),
      },
    } as never);

    await store.listLegacyChannelEditRecoveryCandidates({
      now: new Date('2026-08-09T12:00:00.000Z'),
      limit: 10_000,
      lookbackMs: 10 * 365 * 24 * 60 * 60_000,
      minimumAgeMs: 0,
    });

    expect(markerFindMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: { gte: new Date('2026-08-02T12:00:00.000Z') },
        }),
        take: 100,
      }),
    );
    expect(auditFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: 100,
      }),
    );
  });
});
