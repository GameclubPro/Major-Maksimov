import { buildMaxActionIdempotencyKey } from '../max/max-action-idempotency';
import { MANAGED_HANDSHAKE_CONFIRMATION_AUTO_DELETE_DELAY_MS } from '../max/managed-handshake-confirmation';
import type { MessageDuplicateNoticeProof } from '../moderation/message-duplicate/message-duplicate-notice-proof';
import { MESSAGE_DUPLICATE_MEDIA_VERSION } from '../moderation/message-duplicate/message-duplicate-state';
import { LEGACY_RECOVERY_LIVE_BUDGET } from './legacy-recovery-live-budget';
import { LEGACY_RECOVERY_LIVE_QUEUE_NAMES } from './legacy-recovery-live-registry';
import {
  classifySourceAbandonmentAction,
  inventorySourceAbandonmentRedis,
  type SourceAbandonmentRedisResolver,
} from './source-abandonment-live-redis';
import { sourceAbandonmentDigest } from './source-abandonment-live-protocol';
import { SOURCE_ABANDONMENT_COMMANDSTATS_PROJECTION_SCRIPT } from './source-abandonment-redis-catalog';

const source = { chatId: '-100', messageId: 'source-message', userId: 'source-user' };
const otherChat = '-200';
const createdAt = '2026-10-01T00:00:00.000Z';
const completedAt = '2026-10-01T00:00:01.000Z';
const selection = {
  protocol: 'source-abandonment-v1' as const,
  abandonBefore: '2026-10-07T00:00:00.000Z',
  ownerWebhookEventIds: ['owner-1'],
  majorBotIds: ['major-1'],
};
function fixture(chatId = otherChat, context: Record<string, unknown> = {}) {
  const ledgerContext = { moderationNoticeEnvelope: { version: 1 }, ...context };
  const marker: Record<string, unknown> = {
    version: 2,
    sourceSendJobId: 'parent-send',
    sourceChatId: chatId,
    sourceMessageId: null,
    sourceUserId: null,
    sourceCreatedAt: createdAt,
    sourceSendCompletedAt: completedAt,
    requestedDelayMs: 10_000,
    originBotId: 'major-1',
  };
  const data: Record<string, unknown> = {
    actionType: 'DELETE_MESSAGE',
    chatId,
    messageId: 'sent-notice',
    botId: 'major-1',
    sourceTag: 'moderation_notice',
    idempotencyKey: 'cleanup-delete',
    sendAutoDelete: marker,
    ledgerContext,
  };
  const metadata: Record<string, unknown> = {
    createdAt,
    autoDeleteDelayMs: 10_000,
    sendAutoDelete: null,
    hasOptions: true,
    optionKeys: ['textFormat'],
    ledgerContext: structuredClone(ledgerContext),
  };
  const ledger: Record<string, unknown> = {
    jobId: 'parent-send',
    actionType: 'SEND_MESSAGE',
    chatId,
    messageId: null,
    userId: null,
    sourceTag: 'moderation_notice',
    status: 'SUCCEEDED',
    terminal: true,
    ambiguous: false,
    remoteMessageId: 'sent-notice',
    dispatchBotId: 'major-1',
    completedAt: new Date(completedAt),
    // Database insertion time is not the original action's immutable source time.
    createdAt: new Date('2026-10-01T00:00:00.100Z'),
    metadata,
  };
  const parent = { ledger, majorBotIds: selection.majorBotIds };
  const job = () => ({
    id: 'redis-cleanup',
    state: 'delayed',
    hash: { data: JSON.stringify(data) },
    data,
    position: 0,
    score: '1',
  });
  const classify = () => classifySourceAbandonmentAction(job(), [source], parent);
  return { data, marker, metadata, ledger, parent, job, classify };
}
function duplicateProof(chatId = source.chatId): MessageDuplicateNoticeProof {
  const eventTimestampMs = Date.parse(createdAt) - 10_000;
  return {
    version: 3,
    chatId,
    intentId: 'intent',
    reasonKey: `MESSAGE_DUPLICATE:v1:${eventTimestampMs}`,
    deadlineAtMs: eventTimestampMs + 600_000,
    noticePolicySha256: '1'.repeat(64),
    stage: { kind: 'hit', repeatCount: 1, threshold: null },
    binding: {
      version: 3,
      enforcementScope: 'full',
      lifecycleRevision: 'a'.repeat(64),
      policyRevision: 1,
      authorization: { eventTimestampMs, deadlineAtMs: eventTimestampMs + 600_000 },
      original: {
        member: 'b'.repeat(64),
        author: 'c'.repeat(64),
        messageId: 'baseline-message',
        senderId: 'baseline-user',
        publishedAtMs: eventTimestampMs - 1_000,
        observedAtMs: eventTimestampMs - 1_000,
        expiresAtMs: eventTimestampMs + 3_600_000,
        sourceDigest: 'd'.repeat(64),
        contentDigest: 'e'.repeat(64),
        mediaHashes: [],
        epoch: 0,
        revision: 'f'.repeat(64),
        originalId: '0'.repeat(64),
      },
      senderId: source.userId,
      messageId: source.messageId,
      eventTimestampMs,
      controlRevision: 1,
      settingsDigest: '1'.repeat(64),
      sourceDigest: 'd'.repeat(64),
      contentDigest: 'e'.repeat(64),
      fingerprint: '2'.repeat(64),
      compareMode: 'TEXT',
      mediaHashes: [],
      mediaVersion: MESSAGE_DUPLICATE_MEDIA_VERSION,
      hasPhotos: false,
      photoControlRevision: null,
      windowSeconds: 3_600,
      requiredCount: 2,
    },
  };
}

describe('nullable cleanup source requires exact retained SEND provenance', () => {
  it('excludes another group only with the completed parent and fully retained same-chat producer', () => {
    const s = fixture();
    expect(() => classifySourceAbandonmentAction(s.job(), [source])).toThrow(
      'CLEANUP_ORIGINAL_SOURCE_UNPROVED',
    );
    expect(s.classify()).toBeNull();
  });
  it('does not invent an original message in the same group from explicit null fields', () => {
    expect(fixture(source.chatId).classify).toThrow('CLEANUP_ORIGINAL_SOURCE_UNPROVED');
  });
  it('keeps the exact duplicate source despite a different cleanup target and null SEND fields', () => {
    const s = fixture(source.chatId, { duplicateNotice: duplicateProof() });
    expect(s.classify()).toMatchObject({ ...source, jobKey: 'cleanup-delete' });
    const unrelated = { ...source, messageId: 'different-source' };
    expect(classifySourceAbandonmentAction(s.job(), [unrelated], s.parent)).toBeNull();
  });
  it('rejects a copied cross-chat source even if the cleanup target group differs', () => {
    const s = fixture(otherChat, { duplicateNotice: duplicateProof(source.chatId) });
    expect(s.classify).toThrow('CLEANUP_ORIGINAL_SOURCE_UNPROVED');
  });
  it('retains shared-parser subject conflicts on the exact duplicate source', () => {
    const proof = duplicateProof();
    proof.binding.senderId = 'conflicting-user';
    const s = fixture(source.chatId, { duplicateNotice: proof });
    expect(s.classify).toThrow('ACTION_SUBJECT_CONFLICT');
  });
  it.each([
    [
      'missing parent',
      (s: ReturnType<typeof fixture>) => {
        s.parent.ledger = null as never;
      },
    ],
    [
      'different parent key',
      (s: ReturnType<typeof fixture>) => {
        s.ledger.jobId = 'other-parent';
      },
    ],
    [
      'different parent type',
      (s: ReturnType<typeof fixture>) => {
        s.ledger.actionType = 'DELETE_MESSAGE';
      },
    ],
    [
      'different parent chat',
      (s: ReturnType<typeof fixture>) => {
        s.ledger.chatId = source.chatId;
      },
    ],
    [
      'lost original message',
      (s: ReturnType<typeof fixture>) => {
        s.ledger.messageId = source.messageId;
      },
    ],
    [
      'missing nullable message',
      (s: ReturnType<typeof fixture>) => {
        delete s.ledger.messageId;
      },
    ],
    [
      'lost original user',
      (s: ReturnType<typeof fixture>) => {
        s.ledger.userId = source.userId;
      },
    ],
    [
      'missing nullable user',
      (s: ReturnType<typeof fixture>) => {
        delete s.marker.sourceUserId;
      },
    ],
    [
      'missing original message',
      (s: ReturnType<typeof fixture>) => {
        delete s.marker.sourceMessageId;
      },
    ],
    [
      'wrong marker version',
      (s: ReturnType<typeof fixture>) => {
        s.marker.version = 3;
      },
    ],
    [
      'invalid marker delay',
      (s: ReturnType<typeof fixture>) => {
        s.marker.requestedDelayMs = -1;
      },
    ],
    [
      'ambiguous receipt',
      (s: ReturnType<typeof fixture>) => {
        s.ledger.ambiguous = true;
      },
    ],
    [
      'unfinished receipt',
      (s: ReturnType<typeof fixture>) => {
        s.ledger.status = 'IN_PROGRESS';
      },
    ],
    [
      'nonterminal receipt',
      (s: ReturnType<typeof fixture>) => {
        s.ledger.terminal = false;
      },
    ],
    [
      'another remote target',
      (s: ReturnType<typeof fixture>) => {
        s.ledger.remoteMessageId = 'other-target';
      },
    ],
    [
      'another dispatch bot',
      (s: ReturnType<typeof fixture>) => {
        s.ledger.dispatchBotId = 'major-2';
      },
    ],
    [
      'unknown original bot',
      (s: ReturnType<typeof fixture>) => {
        s.parent.majorBotIds = [];
      },
    ],
    [
      'missing completion time',
      (s: ReturnType<typeof fixture>) => {
        s.ledger.completedAt = null;
      },
    ],
    [
      'different completion time',
      (s: ReturnType<typeof fixture>) => {
        s.ledger.completedAt = new Date(createdAt);
      },
    ],
    [
      'metadata source clock mismatch',
      (s: ReturnType<typeof fixture>) => {
        s.metadata.createdAt = completedAt;
      },
    ],
    [
      'missing metadata source clock',
      (s: ReturnType<typeof fixture>) => {
        delete s.metadata.createdAt;
      },
    ],
    [
      'parent cleanup ancestry',
      (s: ReturnType<typeof fixture>) => {
        s.metadata.sendAutoDelete = s.marker;
      },
    ],
    [
      'different delay',
      (s: ReturnType<typeof fixture>) => {
        s.metadata.autoDeleteDelayMs = 20_000;
      },
    ],
    [
      'lost parent context',
      (s: ReturnType<typeof fixture>) => {
        s.metadata.ledgerContext = null;
      },
    ],
    [
      'rewritten child context',
      (s: ReturnType<typeof fixture>) => {
        s.data.ledgerContext = {};
      },
    ],
    [
      'lost parent options',
      (s: ReturnType<typeof fixture>) => {
        delete s.metadata.optionKeys;
      },
    ],
    [
      'parent reply',
      (s: ReturnType<typeof fixture>) => {
        s.metadata.optionKeys = ['messageLink'];
      },
    ],
    [
      'truncated option keys',
      (s: ReturnType<typeof fixture>) => {
        s.metadata.optionKeys = Array.from({ length: 20 }, (_, i) => `field-${i}`);
      },
    ],
    [
      'child-supplied reply',
      (s: ReturnType<typeof fixture>) => {
        s.data.options = { messageLink: { type: 'reply', mid: source.messageId } };
      },
    ],
    [
      'inconsistent option metadata',
      (s: ReturnType<typeof fixture>) => {
        s.metadata.hasOptions = false;
      },
    ],
    [
      'unknown parent producer',
      (s: ReturnType<typeof fixture>) => {
        s.ledger.sourceTag = 'publisher';
      },
    ],
  ])('refuses %s without inferring unrelatedness', (_label, mutate) => {
    const s = fixture();
    (mutate as (value: ReturnType<typeof fixture>) => void)(s);
    expect(s.classify).toThrow('CLEANUP_ORIGINAL_SOURCE_UNPROVED');
  });
  it.each(['user:123', '123', 'unknown-chat'])('excludes unsupported target %s', (chatId) => {
    expect(fixture(chatId).classify).toThrow('CLEANUP_ORIGINAL_SOURCE_UNPROVED');
  });
  it.each([
    { moderationNoticeEnvelope: { version: 1, messageId: source.messageId } },
    { moderationNoticeEnvelope: { version: 2 } },
    { duplicateNotice: { version: 3 } },
    { moderationSource: { ...source, version: 1 } },
  ])('refuses missing or unsupported copied producer scope %#', (context) => {
    expect(fixture(otherChat, context).classify).toThrow('CLEANUP_ORIGINAL_SOURCE_UNPROVED');
  });
});

function requiredSubscriptionFixture(chatId = otherChat) {
  const proof: Record<string, unknown> = {
    version: 1,
    chatId,
    messageId: 'original-subscription-message',
    userId: 'original-subscription-user',
    reasonKey: 'REQUIRED_SUBSCRIPTION:message-delete',
    policySha256: 'a'.repeat(64),
    sourceAtMs: Date.parse(createdAt) - 1_000,
    deadlineAtMs: Date.parse(createdAt) - 1_000 + 5 * 60_000,
  };
  const s = fixture(chatId, { requiredSubscriptionNotice: proof });
  return { ...s, proof };
}

const noticeShapes = ['E', 'E+S', 'E+R', 'E+R+F', 'E+S+R', 'E+S+R+F', 'E+Q', 'E+D'] as const;
type NoticeShape = (typeof noticeShapes)[number];
const newNoticeShapes: readonly NoticeShape[] = ['E+S', 'E+R', 'E+R+F', 'E+S+R', 'E+S+R+F'];

function finiteNoticeFixture(shape: NoticeShape, chatId = otherChat) {
  const sourceProof: Record<string, unknown> = {
    version: 1,
    chatId,
    messageId: 'original-rule-message',
    userId: 'original-rule-user',
  };
  const rule: Record<string, unknown> = {
    ...sourceProof,
    reasonKey: 'LINK_BLOCKED:message-delete',
    ruleCode: 'LINK_BLOCKED_DELETE',
    policySha256: 'a'.repeat(64),
    deadlineAtMs: Date.parse(createdAt) - 1_000 + 300_000,
  };
  const followup: Record<string, unknown> = {
    version: 1,
    id: 'followup-1',
    issuedAtMs: Date.parse(createdAt),
  };
  const context: Record<string, unknown> = {};
  const features = shape.split('+');
  if (features.includes('S')) context.moderationSource = sourceProof;
  if (features.includes('R')) context.moderationRuleNotice = rule;
  if (features.includes('F')) context.moderationRuleFollowup = followup;
  if (features.includes('Q'))
    context.requiredSubscriptionNotice = requiredSubscriptionFixture(chatId).proof;
  if (features.includes('D')) context.duplicateNotice = duplicateProof(chatId);
  const s = fixture(chatId, context);
  const setParentKey = (key: string) => {
    s.marker.sourceSendJobId = key;
    s.ledger.jobId = key;
  };
  if (features.includes('F'))
    setParentKey(
      buildMaxActionIdempotencyKey('explicit', ['SEND_MESSAGE', 'followup-1:explanation']),
    );
  const syncParentContext = () => {
    s.metadata.ledgerContext = structuredClone(s.data.ledgerContext);
  };
  return { ...s, sourceProof, rule, followup, setParentKey, syncParentContext };
}

describe('finite moderation notice cleanup contexts retain exact unrelated SEND provenance', () => {
  it.each(noticeShapes)(
    'accepts producer shape %s in an unrelated group without changing evidence',
    (shape) => {
      const s = finiteNoticeFixture(shape);
      const before = structuredClone({ data: s.data, ledger: s.ledger });
      expect(s.rule.deadlineAtMs).toBeLessThan(Date.now());
      expect(s.classify()).toBeNull();
      expect({ data: s.data, ledger: s.ledger }).toEqual(before);
    },
  );

  it.each(newNoticeShapes)(
    'refuses %s in any selected group, including numeric chat aliases',
    (shape) => {
      const s = finiteNoticeFixture(shape);
      for (const chatId of [otherChat, '-0200']) {
        const selected = [source, { ...source, chatId, messageId: 'another-message' }];
        expect(() => classifySourceAbandonmentAction(s.job(), selected, s.parent)).toThrow(
          'CLEANUP_ORIGINAL_SOURCE_UNPROVED',
        );
      }
      const aliased = finiteNoticeFixture(shape, '-0200');
      expect(() =>
        classifySourceAbandonmentAction(
          aliased.job(),
          [source, { ...source, chatId: otherChat }],
          aliased.parent,
        ),
      ).toThrow('CLEANUP_ORIGINAL_SOURCE_UNPROVED');
    },
  );

  it.each(newNoticeShapes)('retains every parent receipt boundary for %s', (shape) => {
    const changes: Array<(s: ReturnType<typeof finiteNoticeFixture>) => void> = [
      (s) => {
        s.parent.ledger = null as never;
      },
      (s) => {
        s.ledger.jobId = 'another-parent';
      },
      (s) => {
        s.ledger.chatId = '-300';
      },
      (s) => {
        s.ledger.messageId = 'hidden-original';
      },
      (s) => {
        s.ledger.remoteMessageId = 'another-target';
      },
      (s) => {
        s.ledger.status = 'IN_PROGRESS';
      },
      (s) => {
        s.ledger.terminal = false;
      },
      (s) => {
        s.ledger.ambiguous = true;
      },
      (s) => {
        s.ledger.dispatchBotId = 'another-bot';
      },
      (s) => {
        s.ledger.completedAt = new Date(createdAt);
      },
      (s) => {
        s.metadata.createdAt = completedAt;
      },
      (s) => {
        s.metadata.ledgerContext = { moderationNoticeEnvelope: { version: 1 } };
      },
      (s) => {
        s.metadata.optionKeys = ['textFormat', 'messageLink'];
      },
      (s) => {
        s.data.options = { messageLink: { type: 'reply', mid: source.messageId } };
      },
    ];
    for (const change of changes) {
      const s = finiteNoticeFixture(shape);
      change(s);
      const before = structuredClone({ data: s.data, ledger: s.ledger });
      expect(s.classify).toThrow('CLEANUP_ORIGINAL_SOURCE_UNPROVED');
      expect({ data: s.data, ledger: s.ledger }).toEqual(before);
    }
  });

  it.each(newNoticeShapes)('requires a retained original user to agree with %s', (shape) => {
    const s = finiteNoticeFixture(shape);
    s.marker.sourceUserId = s.sourceProof.userId;
    s.ledger.userId = s.sourceProof.userId;
    expect(s.classify()).toBeNull();
    s.marker.sourceUserId = 'different-original-user';
    s.ledger.userId = 'different-original-user';
    expect(s.classify).toThrow('CLEANUP_ORIGINAL_SOURCE_UNPROVED');
  });

  it.each([
    ['missing user', { userId: null }],
    ['missing message', { messageId: null }],
    ['noncanonical chat', { chatId: ' -200' }],
    ['noncanonical user', { userId: ' original-rule-user' }],
    ['noncanonical message', { messageId: 'original-rule-message ' }],
    ['oversized user', { userId: 'u'.repeat(513) }],
    ['oversized message', { messageId: 'm'.repeat(513) }],
    ['different chat', { chatId: '-300' }],
    ['numeric-only chat match', { chatId: '-0200' }],
    ['unknown version', { version: 2 }],
    ['extra field', { anotherSource: source }],
  ])('refuses %s in both strict source and rule proofs', (_label, changes) => {
    for (const shape of ['E+S', 'E+R'] as const) {
      const s = finiteNoticeFixture(shape);
      Object.assign(shape === 'E+S' ? s.sourceProof : s.rule, changes);
      s.syncParentContext();
      expect(s.classify).toThrow('CLEANUP_ORIGINAL_SOURCE_UNPROVED');
    }
  });

  it.each([
    ['missing reason', { reasonKey: null }],
    ['noncanonical reason', { reasonKey: ' LINK_BLOCKED:message-delete' }],
    ['oversized reason', { reasonKey: 'r'.repeat(1_025) }],
    ['missing rule', { ruleCode: null }],
    ['noncanonical rule', { ruleCode: 'LINK_BLOCKED_DELETE ' }],
    ['oversized rule', { ruleCode: 'r'.repeat(1_025) }],
    ['invalid policy', { policySha256: 'bad' }],
    ['noninteger deadline', { deadlineAtMs: 1.5 }],
    ['unsafe deadline', { deadlineAtMs: Number.MAX_SAFE_INTEGER + 1 }],
    ['nonpositive original source time', { deadlineAtMs: 300_000 }],
    ['source after parent completion', { deadlineAtMs: Date.parse(completedAt) + 300_001 }],
  ])('refuses a retained rule with %s', (_label, changes) => {
    const s = finiteNoticeFixture('E+R');
    Object.assign(s.rule, changes);
    s.syncParentContext();
    expect(s.classify).toThrow('CLEANUP_ORIGINAL_SOURCE_UNPROVED');
  });

  it.each(['chatId', 'messageId', 'userId'])(
    'refuses a contradictory sanction source %s',
    (key) => {
      for (const shape of ['E+S+R', 'E+S+R+F'] as const) {
        const s = finiteNoticeFixture(shape);
        s.sourceProof[key] = key === 'chatId' ? '-300' : `different-${key}`;
        s.syncParentContext();
        expect(s.classify).toThrow('CLEANUP_ORIGINAL_SOURCE_UNPROVED');
      }
    },
  );

  it.each(['F-only', 'S+F', 'S+Q', 'S+D', 'R+Q', 'R+D', 'Q+D', 'F+D', 'unknown'])(
    'refuses the unsupported composition %s even with matching parent context',
    (shape) => {
      const s = finiteNoticeFixture('E');
      const context = s.data.ledgerContext as Record<string, unknown>;
      const keys: Record<string, string> = {
        S: 'moderationSource',
        R: 'moderationRuleNotice',
        F: 'moderationRuleFollowup',
        Q: 'requiredSubscriptionNotice',
        D: 'duplicateNotice',
      };
      const values: Record<string, unknown> = {
        S: s.sourceProof,
        R: s.rule,
        F: s.followup,
        Q: requiredSubscriptionFixture().proof,
        D: duplicateProof(otherChat),
      };
      if (shape === 'unknown') context.unknownProof = { ...source, chatId: otherChat };
      else
        for (const key of (shape === 'F-only' ? 'F' : shape).split('+'))
          context[keys[key]] = values[key];
      s.syncParentContext();
      expect(s.classify).toThrow(
        shape === 'unknown' ? 'ACTION_PRODUCER_UNPROVED' : 'CLEANUP_ORIGINAL_SOURCE_UNPROVED',
      );
    },
  );

  it.each(['explanation', 'sanction-notice'])(
    'retains exact historical followup %s producer keys',
    (kind) => {
      const logical = `followup-1:${kind}`;
      const keys = [
        logical,
        buildMaxActionIdempotencyKey('explicit', ['SEND_MESSAGE', logical]),
        buildMaxActionIdempotencyKey('explicit', ['major-1', 'SEND_MESSAGE', logical]),
      ];
      for (const key of keys) {
        const s = finiteNoticeFixture(kind === 'explanation' ? 'E+R+F' : 'E+S+R+F');
        s.setParentKey(key);
        expect(s.classify()).toBeNull();
      }
    },
  );

  it('matches the complete producer key for a followup id beyond the readable prefix limit', () => {
    const s = finiteNoticeFixture('E+R+F');
    s.followup.id = 'f'.repeat(200);
    s.syncParentContext();
    s.setParentKey(
      buildMaxActionIdempotencyKey('explicit', ['SEND_MESSAGE', `${s.followup.id}:explanation`]),
    );
    expect(s.classify()).toBeNull();
    s.setParentKey(
      buildMaxActionIdempotencyKey('explicit', ['SEND_MESSAGE', `${'f'.repeat(199)}g:explanation`]),
    );
    expect(s.classify).toThrow('CLEANUP_ORIGINAL_SOURCE_UNPROVED');
  });

  it.each(['fresh SEND', 'missing cleanup marker', 'non-null cleanup source'])(
    'does not expand the followup exception to %s',
    (change) => {
      const s = finiteNoticeFixture('E+R+F');
      if (change === 'fresh SEND') s.data.actionType = 'SEND_MESSAGE';
      if (change === 'missing cleanup marker') delete s.data.sendAutoDelete;
      if (change === 'non-null cleanup source') s.marker.sourceMessageId = 'original-rule-message';
      expect(s.classify).toThrow('ACTION_PRODUCER_UNPROVED');
    },
  );

  it.each([
    ['unrelated parent', 'other-parent'],
    ['different followup', 'followup-2:explanation'],
    ['unknown effect', 'followup-1:another-effect'],
    [
      'different action',
      buildMaxActionIdempotencyKey('explicit', ['DELETE_MESSAGE', 'followup-1:explanation']),
    ],
    [
      'different bot',
      buildMaxActionIdempotencyKey('explicit', [
        'major-2',
        'SEND_MESSAGE',
        'followup-1:explanation',
      ]),
    ],
    [
      'different namespace',
      buildMaxActionIdempotencyKey('routed', ['SEND_MESSAGE', 'followup-1:explanation']),
    ],
  ])(
    'refuses the followup with %s key despite an exact successful parent receipt',
    (_label, key) => {
      const s = finiteNoticeFixture('E+R+F');
      s.setParentKey(key);
      expect(s.classify).toThrow('CLEANUP_ORIGINAL_SOURCE_UNPROVED');
    },
  );

  it.each([
    ['unknown version', { version: 2 }],
    ['missing id', { id: null }],
    ['noncanonical id', { id: ' followup-1' }],
    ['oversized id', { id: 'f'.repeat(257) }],
    ['extra field', { anotherSource: source }],
    ['zero issued time', { issuedAtMs: 0 }],
    ['fractional issued time', { issuedAtMs: 1.5 }],
    ['unsafe issued time', { issuedAtMs: Number.MAX_SAFE_INTEGER + 1 }],
    ['before source time', { issuedAtMs: Date.parse(createdAt) - 1_001 }],
    ['at original deadline', { issuedAtMs: Date.parse(createdAt) - 1_000 + 300_000 }],
    ['after parent completion', { issuedAtMs: Date.parse(completedAt) + 1 }],
  ])('refuses %s in a retained durable followup', (_label, changes) => {
    const s = finiteNoticeFixture('E+R+F');
    Object.assign(s.followup, changes);
    s.syncParentContext();
    expect(s.classify).toThrow('CLEANUP_ORIGINAL_SOURCE_UNPROVED');
  });

  it.each([Date.parse(createdAt) - 1_000, Date.parse(completedAt)])(
    'accepts historical issued time %s on the allowed inclusive source/completion boundary',
    (issuedAtMs) => {
      const s = finiteNoticeFixture('E+R+F');
      s.followup.issuedAtMs = issuedAtMs;
      s.syncParentContext();
      expect(s.classify()).toBeNull();
    },
  );
});

describe('required subscription cleanup proves unrelated completed notice lineage only', () => {
  it('excludes the exact retained same-chat notice despite an expired source deadline', () => {
    const s = requiredSubscriptionFixture();
    expect(s.proof.deadlineAtMs as number).toBeLessThan(Date.now());
    expect(s.classify()).toBeNull();
  });

  it.each([source.chatId, '-0100'])(
    'does not admit a typed source in selected chat %s',
    (selectedChatId) => {
      const s = requiredSubscriptionFixture(source.chatId);
      expect(() =>
        classifySourceAbandonmentAction(s.job(), [{ ...source, chatId: selectedChatId }], s.parent),
      ).toThrow('CLEANUP_ORIGINAL_SOURCE_UNPROVED');
    },
  );

  it.each([
    ['unknown version', { version: 2 }],
    ['unknown reason', { reasonKey: 'UNKNOWN' }],
    ['invalid policy', { policySha256: 'unknown' }],
    ['missing message', { messageId: null }],
    ['noncanonical user', { userId: ' original-user' }],
    ['noncanonical chat', { chatId: ' -200' }],
    ['wrong source chat', { chatId: '-300' }],
    ['numeric-only chat equivalence', { chatId: '-0200' }],
    ['invalid source clock', { sourceAtMs: 0 }],
    ['renewed deadline', { deadlineAtMs: Date.parse(createdAt) + 600_000 }],
    ['extra source field', { anotherSource: source }],
  ])('refuses %s even when parent and child repeat it', (_label, changes) => {
    const s = requiredSubscriptionFixture();
    Object.assign(s.proof, changes);
    s.metadata.ledgerContext = structuredClone(s.data.ledgerContext);
    expect(s.classify).toThrow('CLEANUP_ORIGINAL_SOURCE_UNPROVED');
  });

  it.each([
    ['mixed duplicate', { duplicateNotice: duplicateProof(otherChat) }],
    ['other known context', { moderationRuleNotice: { version: 1 } }],
    ['unknown context', { unknownProof: { chatId: otherChat } }],
  ])('refuses %s beside the typed subscription source', (label, extra) => {
    const s = requiredSubscriptionFixture();
    Object.assign(s.data.ledgerContext as Record<string, unknown>, extra);
    s.metadata.ledgerContext = structuredClone(s.data.ledgerContext);
    expect(s.classify).toThrow(
      label === 'unknown context' ? 'ACTION_PRODUCER_UNPROVED' : 'CLEANUP_ORIGINAL_SOURCE_UNPROVED',
    );
  });

  it('refuses a modified child proof against the retained parent context', () => {
    const s = requiredSubscriptionFixture();
    s.proof.messageId = 'changed-source';
    expect(s.classify).toThrow('CLEANUP_ORIGINAL_SOURCE_UNPROVED');
  });

  it('retains the mandatory parent receipt and lost reply-link refusals', () => {
    const s = requiredSubscriptionFixture();
    expect(() => classifySourceAbandonmentAction(s.job(), [source])).toThrow(
      'CLEANUP_ORIGINAL_SOURCE_UNPROVED',
    );
    s.metadata.optionKeys = ['textFormat', 'messageLink'];
    expect(s.classify).toThrow('CLEANUP_ORIGINAL_SOURCE_UNPROVED');
  });
});

function redisFixture(
  s: ReturnType<typeof fixture>,
  jobs: readonly Record<string, unknown>[] = [s.data],
) {
  const reader = {
    eval_ro: jest.fn(async (script: string, _keyCount = 0, ...args: string[]) => {
      if (script.startsWith('-- source-abandonment:headers'))
        return [
          1,
          1,
          [...LEGACY_RECOVERY_LIVE_QUEUE_NAMES]
            .sort()
            .map((name) => [
              name,
              '',
              '1',
              '',
              0,
              0,
              0,
              name === 'max-actions-background' ? jobs.length : 0,
              0,
              0,
              0,
              0,
              0,
            ]),
        ];
      if (script.startsWith('-- source-abandonment:namespace-catalog'))
        return [1, 0, '0', 0, 0, 0, [], ['0']];
      if (script.startsWith('-- source-abandonment:owners')) return [1, 1, 1, []];
      if (script.startsWith('-- source-abandonment:jobs')) {
        const offset = Number(args[2]);
        const page = jobs.slice(offset, offset + Number(args[3]));
        return [
          1,
          1,
          page.length,
          page.map((data, index) => [
            `redis-cleanup-${offset + index}`,
            'delayed',
            ['data', JSON.stringify(data)],
            offset + index,
            '1',
          ]),
        ];
      }
      throw new Error('Unexpected Redis read');
    }),
    multi() {
      const commands: string[] = [];
      const tx = {
        eval_ro(script: string) {
          commands.push(script);
          return tx;
        },
        async exec() {
          expect(commands[0]).toBe(SOURCE_ABANDONMENT_COMMANDSTATS_PROJECTION_SCRIPT);
          expect(commands[2]).toBe(SOURCE_ABANDONMENT_COMMANDSTATS_PROJECTION_SCRIPT);
          const stats = (calls: number, usec: number) =>
            `# Commandstats\r\ncmdstat_eval_ro:calls=${calls},usec=${usec},usec_per_call=10.00,rejected_calls=0,failed_calls=0\r\n`;
          return [
            [null, stats(10, 100)],
            [null, await reader.eval_ro(commands[1])],
            [null, stats(12, 200)],
          ];
        },
      };
      return tx;
    },
  };
  return reader;
}

describe('cleanup parent evidence participates in bounded repeated inventory', () => {
  it('refuses an existing child whose exact parent is missing without resolving another key', async () => {
    const s = fixture();
    const resolve = jest.fn<
      ReturnType<SourceAbandonmentRedisResolver>,
      Parameters<SourceAbandonmentRedisResolver>
    >(async (_kind, keys) => ({
      rows: keys.map((key) => ({ key, row: null, digest: 'f'.repeat(64) })),
      cost: { pages: 2, rows: 0, probes: 2, bytes: 256 },
      plans: [],
      issue: null,
    }));
    const result = await inventorySourceAbandonmentRedis(
      redisFixture(s),
      selection,
      [source],
      { ...LEGACY_RECOVERY_LIVE_BUDGET, deadlineAtMs: Date.now() + 30_000 },
      resolve,
    );
    expect(result.issues).toContainEqual({
      code: 'CLEANUP_ORIGINAL_SOURCE_UNPROVED',
      descriptor: 'redis:max-actions-background',
    });
    expect(result.children).toEqual([]);
    expect(resolve.mock.calls.map(([kind, key]) => [kind, key])).toEqual([
      ['action', ['cleanup-delete']],
      ['action', ['parent-send']],
    ]);
  });
  it('resolves only the child and exact parent, charges parent costs and retains its digest', async () => {
    const s = fixture();
    const resolve = jest.fn<
      ReturnType<SourceAbandonmentRedisResolver>,
      Parameters<SourceAbandonmentRedisResolver>
    >(async (_kind, keys) => ({
      rows: keys.map((key) => ({
        key,
        row: key === 'parent-send' ? s.ledger : null,
        digest: sourceAbandonmentDigest(key === 'parent-send' ? s.ledger : null),
      })),
      cost: { pages: 2, rows: 1, probes: 2, bytes: 256 },
      plans: [],
      issue: null,
    }));
    const run = () =>
      inventorySourceAbandonmentRedis(
        redisFixture(s),
        selection,
        [source],
        { ...LEGACY_RECOVERY_LIVE_BUDGET, deadlineAtMs: Date.now() + 30_000 },
        resolve,
      );
    const first = await run();
    expect(first.issues).toEqual([]);
    expect(first.children).toEqual([]);
    expect(resolve.mock.calls.map(([kind, key]) => [kind, key])).toEqual([
      ['action', ['cleanup-delete']],
      ['action', ['parent-send']],
    ]);
    expect(first.cost.rows).toBe(3);
    expect(first.cost.pages).toBeGreaterThanOrEqual(4);
    s.ledger.updatedAt = new Date('2026-10-01T00:00:02.000Z');
    const changed = await run();
    expect(changed.issues).toEqual([]);
    expect(changed.stableDigest).not.toBe(first.stableDigest);
  });
  it('deduplicates a shared parent within each page and refetches it on the next page and pass', async () => {
    const s = fixture();
    const jobs = Array.from({ length: 17 }, (_, index) => ({
      ...s.data,
      idempotencyKey: `cleanup-delete-${index}`,
    }));
    let revision = 0;
    const resolve = jest.fn<
      ReturnType<SourceAbandonmentRedisResolver>,
      Parameters<SourceAbandonmentRedisResolver>
    >(async (_kind, keys) => {
      if (keys.includes('parent-send')) revision++;
      return {
        rows: keys.map((key) => {
          const row =
            key === 'parent-send'
              ? {
                  ...s.ledger,
                  updatedAt: new Date(Date.parse(completedAt) + revision),
                }
              : null;
          return { key, row, digest: sourceAbandonmentDigest(row === null ? [] : [row]) };
        }),
        cost: { pages: 2, rows: keys.length, probes: 2, bytes: 256 },
        plans: [],
        issue: null,
      };
    });
    const run = () =>
      inventorySourceAbandonmentRedis(
        redisFixture(s, jobs),
        selection,
        [source],
        { ...LEGACY_RECOVERY_LIVE_BUDGET, deadlineAtMs: Date.now() + 30_000 },
        resolve,
      );
    const first = await run();
    const second = await run();
    expect(first.issues).toEqual([]);
    expect(second.issues).toEqual([]);
    expect(first.children).toEqual([]);
    expect(first.cost.rows).toBe(36);
    expect(second.cost.rows).toBe(36);
    expect(second.stableDigest).not.toBe(first.stableDigest);
    const pageOne = Array.from({ length: 16 }, (_, index) => `cleanup-delete-${index}`);
    expect(resolve.mock.calls.map(([, keys]) => keys)).toEqual([
      pageOne,
      ['parent-send'],
      ['cleanup-delete-16'],
      ['parent-send'],
      pageOne,
      ['parent-send'],
      ['cleanup-delete-16'],
      ['parent-send'],
    ]);
  });
  it('keeps unresolved parent denial and propagates the unchanged shared budget', async () => {
    const s = fixture();
    const resolve: SourceAbandonmentRedisResolver = async (_kind, keys, allowance) => ({
      rows: keys.map((key) => ({
        key,
        row: key === 'parent-send' ? s.ledger : null,
        digest: 'f'.repeat(64),
      })),
      cost: {
        pages: keys.includes('parent-send') ? allowance.pages + 1 : 0,
        rows: 0,
        probes: 0,
        bytes: 0,
      },
      plans: [],
      issue: null,
    });
    const result = await inventorySourceAbandonmentRedis(
      redisFixture(s),
      selection,
      [source],
      { ...LEGACY_RECOVERY_LIVE_BUDGET, deadlineAtMs: Date.now() + 30_000 },
      resolve,
    );
    expect(result.issues).toContainEqual({
      code: 'REDIS_BUDGET_EXCEEDED',
      descriptor: 'redis:max-actions-background',
    });
    expect(result.children).toEqual([]);
  });
});

function handshakeFixture(publisher = false) {
  const s = fixture();
  const botId = publisher ? 'publisher-1' : 'major-1';
  const key = buildMaxActionIdempotencyKey('explicit', [
    ...(publisher ? [botId] : []),
    'SEND_MESSAGE',
    publisher
      ? `publisher-handshake-start:${otherChat}:update-1`
      : 'managed-handshake-start:groupcmd:v1:command-1',
  ]);
  Object.assign(s.data, { sourceTag: 'managed_handshake', botId });
  delete s.data.ledgerContext;
  Object.assign(s.marker, {
    sourceSendJobId: key,
    originBotId: botId,
    requestedDelayMs: MANAGED_HANDSHAKE_CONFIRMATION_AUTO_DELETE_DELAY_MS,
  });
  Object.assign(s.metadata, {
    autoDeleteDelayMs: MANAGED_HANDSHAKE_CONFIRMATION_AUTO_DELETE_DELAY_MS,
    ledgerContext: null,
    optionKeys: ['buttons'],
    hasText: true,
    textLength: 42,
  });
  Object.assign(s.ledger, { jobId: key, sourceTag: 'managed_handshake', dispatchBotId: botId });
  const parent = {
    ...s.parent,
    publisherBotId: publisher ? botId : (undefined as string | undefined),
  };
  return {
    ...s,
    parent,
    classify: (sources = [source]) => classifySourceAbandonmentAction(s.job(), sources, parent),
  };
}

describe('completed Start confirmation cleanup has a separate finite producer proof', () => {
  it.each([false, true])(
    'excludes an exact %s Publisher handshake in another group',
    (publisher) => {
      const s = handshakeFixture(publisher);
      expect(s.classify()).toBeNull();
      s.metadata.hasOptions = false;
      s.metadata.optionKeys = [];
      expect(s.classify()).toBeNull();
    },
  );
  it.each([false, true])('refuses any selected-chat overlap for Publisher=%s', (publisher) => {
    const s = handshakeFixture(publisher);
    expect(() => s.classify([source, { ...source, chatId: otherChat }])).toThrow(
      'CLEANUP_ORIGINAL_SOURCE_UNPROVED',
    );
    expect(() => s.classify([source, { ...source, chatId: '-0200' }])).toThrow(
      'CLEANUP_ORIGINAL_SOURCE_UNPROVED',
    );
  });
  it.each([
    [
      'missing Publisher catalog',
      (s: ReturnType<typeof handshakeFixture>) => {
        s.parent.publisherBotId = undefined;
      },
    ],
    [
      'wrong Publisher catalog',
      (s: ReturnType<typeof handshakeFixture>) => {
        s.parent.publisherBotId = 'other-publisher';
      },
    ],
    [
      'Publisher copied into Major catalog',
      (s: ReturnType<typeof handshakeFixture>) => {
        s.parent.majorBotIds = ['publisher-1'];
      },
    ],
    [
      'unknown origin',
      (s: ReturnType<typeof handshakeFixture>) => {
        s.marker.originBotId = 'unknown';
        s.data.botId = 'unknown';
        s.ledger.dispatchBotId = 'unknown';
      },
    ],
    [
      'missing parent context evidence',
      (s: ReturnType<typeof handshakeFixture>) => {
        delete s.metadata.ledgerContext;
      },
    ],
    [
      'empty parent context object',
      (s: ReturnType<typeof handshakeFixture>) => {
        s.metadata.ledgerContext = {};
      },
    ],
    [
      'copied child context',
      (s: ReturnType<typeof handshakeFixture>) => {
        s.data.ledgerContext = {};
      },
    ],
    [
      'parent reply option',
      (s: ReturnType<typeof handshakeFixture>) => {
        s.metadata.optionKeys = ['messageLink'];
      },
    ],
    [
      'unrelated parent option',
      (s: ReturnType<typeof handshakeFixture>) => {
        s.metadata.optionKeys = ['textFormat'];
      },
    ],
    [
      'truncated parent options',
      (s: ReturnType<typeof handshakeFixture>) => {
        s.metadata.optionKeys = Array(20).fill('buttons');
      },
    ],
    [
      'child reply option',
      (s: ReturnType<typeof handshakeFixture>) => {
        s.data.options = { messageLink: { type: 'reply', mid: 'elsewhere' } };
      },
    ],
    [
      'parent user source',
      (s: ReturnType<typeof handshakeFixture>) => {
        s.marker.sourceUserId = 'user';
        s.ledger.userId = 'user';
      },
    ],
    [
      'child user source',
      (s: ReturnType<typeof handshakeFixture>) => {
        s.data.userId = 'user';
      },
    ],
    [
      'unknown parent tag',
      (s: ReturnType<typeof handshakeFixture>) => {
        s.ledger.sourceTag = 'other';
      },
    ],
    [
      'parent not succeeded',
      (s: ReturnType<typeof handshakeFixture>) => {
        s.ledger.status = 'IN_PROGRESS';
      },
    ],
    [
      'parent not terminal',
      (s: ReturnType<typeof handshakeFixture>) => {
        s.ledger.terminal = false;
      },
    ],
    [
      'ambiguous parent',
      (s: ReturnType<typeof handshakeFixture>) => {
        s.ledger.ambiguous = true;
      },
    ],
    [
      'wrong remote receipt',
      (s: ReturnType<typeof handshakeFixture>) => {
        s.ledger.remoteMessageId = 'wrong';
      },
    ],
    [
      'wrong dispatcher',
      (s: ReturnType<typeof handshakeFixture>) => {
        s.ledger.dispatchBotId = 'major-1';
      },
    ],
    [
      'wrong completion',
      (s: ReturnType<typeof handshakeFixture>) => {
        s.ledger.completedAt = new Date(createdAt);
      },
    ],
    [
      'wrong source clock',
      (s: ReturnType<typeof handshakeFixture>) => {
        s.metadata.createdAt = completedAt;
      },
    ],
    [
      'parent cleanup ancestry',
      (s: ReturnType<typeof handshakeFixture>) => {
        s.metadata.sendAutoDelete = s.marker;
      },
    ],
    [
      'nonconfirmation delay',
      (s: ReturnType<typeof handshakeFixture>) => {
        s.metadata.autoDeleteDelayMs = 10000;
        s.marker.requestedDelayMs = 10000;
      },
    ],
    [
      'missing retained text flag',
      (s: ReturnType<typeof handshakeFixture>) => {
        delete s.metadata.hasText;
      },
    ],
    [
      'unknown producer key',
      (s: ReturnType<typeof handshakeFixture>) => {
        s.ledger.jobId = s.marker.sourceSendJobId =
          'max-action__explicit__publisher-1__send_message__other__' + 'a'.repeat(24);
      },
    ],
    [
      'wrong key chat',
      (s: ReturnType<typeof handshakeFixture>) => {
        s.ledger.jobId = s.marker.sourceSendJobId = buildMaxActionIdempotencyKey('explicit', [
          'publisher-1',
          'SEND_MESSAGE',
          'publisher-handshake-start:-999:update-1',
        ]);
      },
    ],
    [
      'wrong key bot',
      (s: ReturnType<typeof handshakeFixture>) => {
        s.ledger.jobId = s.marker.sourceSendJobId = buildMaxActionIdempotencyKey('explicit', [
          'major-1',
          'SEND_MESSAGE',
          'publisher-handshake-start:-200:update-1',
        ]);
      },
    ],
    [
      'missing key digest',
      (s: ReturnType<typeof handshakeFixture>) => {
        s.ledger.jobId = s.marker.sourceSendJobId = String(s.ledger.jobId).slice(0, -26);
      },
    ],
    [
      'unknown key part',
      (s: ReturnType<typeof handshakeFixture>) => {
        const key = String(s.ledger.jobId);
        s.ledger.jobId = s.marker.sourceSendJobId = key.slice(0, -26) + '__other' + key.slice(-26);
      },
    ],
  ] as const)('refuses %s without widening source or bot scope', (_name, mutate) => {
    const s = handshakeFixture(true);
    mutate(s);
    expect(s.classify).toThrow('CLEANUP_ORIGINAL_SOURCE_UNPROVED');
  });
  it('retains the earlier BullMQ ancestry refusal', () => {
    const s = handshakeFixture(true);
    expect(() =>
      classifySourceAbandonmentAction(
        { ...s.job(), hash: { ...s.job().hash, parentKey: 'unproved' } },
        [source],
        s.parent,
      ),
    ).toThrow('JOB_PARENT_UNPROVED');
  });
});
