import { ConfigService } from '@nestjs/config';
import { performance } from 'node:perf_hooks';
import type { DeleteIntentLeaseCheck } from './moderation-delete-intent-lease';
import { MaxApiInternalRateLimitError, type MaxClientService } from '../max/max-client.service';
import { MaxModerationApiBudgetError } from '../max/max-moderation-api-budget';
import {
  markMaxPreDispatchGuardRejected,
  MAX_DELETE_PRE_DISPATCH_GUARD_REJECTED_CODE,
  usesMaxFinalAuthorityCheckpoint,
} from '../max/max-action-pre-dispatch-guard';

import { MAX_SEND_FENCE_STALE_MS } from '../max/max-send-ambiguity.util';
import { Prisma } from '../prisma/prisma-client';
import {
  BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_EVIDENCE_SOURCE,
  BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_EVIDENCE_VERSION,
  BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_REASON,
} from './bot-message-explicit-operator-cleanup.constants';
import { buildMessageScopedModerationActionClaimKey } from './moderation-message-action-claim';
import {
  buildCommercialOcrDeleteBinding,
  COMMERCIAL_OCR_DELETE_RULE_CODE,
  COMMERCIAL_OCR_MESSAGE_ACTION_RULE_CODE,
  CommercialOcrDeleteGuardRejectedError,
} from './commercial-ocr/commercial-ocr-delete-guard.service';
import {
  buildImageTextStopListBinding,
  fingerprintImageTextStopListPolicy,
  IMAGE_TEXT_STOP_LIST_ACTION_DEDUPE_PREFIX,
  IMAGE_TEXT_STOP_LIST_MESSAGE_ACTION_RULE_CODE,
} from './commercial-ocr/image-text-stop-list-binding';
import { resolveExpectedCommercialOcrProductionBehaviorIdentity } from './commercial-ocr/commercial-ocr-behavior-identity';
import { fingerprintCommercialOcrSettingsProfile } from './commercial-ocr/commercial-ocr-settings-profile';
import {
  BOT_MESSAGE_AUTO_DELETE_ACCESS_AMBIGUOUS_LEDGER_EVIDENCE_SOURCE,
  BOT_MESSAGE_AUTO_DELETE_ACCESS_AMBIGUOUS_LEDGER_EVIDENCE_VERSION,
  BOT_MESSAGE_AUTO_DELETE_REPAIR_INTENT_AUDIT_ACTION,
  BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_INTENT_AUDIT_ACTION,
  BotMessageAutoDeleteExplicitCleanupPolicyConflictError,
  ImageTextStopListDeleteIntentGuardRejectedError,
  ModerationDeleteIntentService,
} from './moderation-delete-intent.service';
import type { EnsureModerationDeleteIntentInput } from './moderation-delete-intent.types';
import {
  buildNightModeTransitionScheduleFingerprint,
  buildNightModeTransitionSideEffectFingerprint,
} from './night-mode-transition-generation.util';
import type { NightModeCloseNoticeCleanupBinding } from './night-mode-close-notice-cleanup-binding';
import { ProfanityDeleteGuardRejectedError } from './profanity/profanity-delete-guard.service';
import {
  StopWordsDeleteGuardRejectedError,
  type StopWordsDeleteGuardService,
} from './stop-words/stop-words-delete-guard.service';
import { CommercialDeleteGuardRejectedError } from './commercial/commercial-delete-guard.service';
import { fingerprintCommercialDeleteReasons } from './commercial/commercial-delete-binding';
import { MESSAGE_DUPLICATE_MEDIA_VERSION } from './message-duplicate/message-duplicate-state';
import {
  MessageDuplicateGuardRejectedError,
  type MessageDuplicateDeleteGuardService,
} from './message-duplicate/message-duplicate-delete-guard.service';
import { MessageDuplicateInitialSourceUnavailableError } from './message-duplicate/message-duplicate-guard.contract';
import type { ModerationDeletePreDispatchPhase } from './moderation-delete-intent.types';
import { MessageLimitsDeleteGuardService } from './message-limits-delete-guard.service';
import type { ModerationStateDeleteGuardService } from './moderation-state-delete-guard.service';
import {
  finalizeDeleteAuthority,
  prepareDeleteAuthority,
  prepareDeleteAuthorityRecheck,
} from './moderation-delete-authority-preparation';

function preparedGuardFixture<Args extends unknown[], Result>(
  run: (...args: Args) => Promise<Result>,
) {
  return async (...args: Args) => {
    const result = await run(...args);
    return prepareDeleteAuthority(async () => result);
  };
}

function messageLimitsGuardFixture(authorize: MessageLimitsDeleteGuardService['authorize']) {
  const run = jest.fn<
    ReturnType<MessageLimitsDeleteGuardService['authorize']>,
    Parameters<MessageLimitsDeleteGuardService['authorize']>
  >(authorize);
  return {
    authorize: run,
    prepareForDispatch: preparedGuardFixture(run),
  } satisfies Pick<MessageLimitsDeleteGuardService, 'authorize' | 'prepareForDispatch'>;
}

function stateGuardFixture(authorize: ModerationStateDeleteGuardService['authorize']) {
  const run = jest.fn<
    ReturnType<ModerationStateDeleteGuardService['authorize']>,
    Parameters<ModerationStateDeleteGuardService['authorize']>
  >(authorize);
  return {
    authorize: run,
    prepareForDispatch: preparedGuardFixture(run),
  } satisfies Pick<ModerationStateDeleteGuardService, 'authorize' | 'prepareForDispatch'>;
}

function stopWordsGuardFixture(authorize: StopWordsDeleteGuardService['authorizeIntent']) {
  const run = jest.fn<
    ReturnType<StopWordsDeleteGuardService['authorizeIntent']>,
    Parameters<StopWordsDeleteGuardService['authorizeIntent']>
  >(authorize);
  return {
    authorizeIntent: run,
    prepareForDispatch: preparedGuardFixture(run),
  } satisfies Pick<StopWordsDeleteGuardService, 'authorizeIntent' | 'prepareForDispatch'>;
}

const VERIFIED_RECEIPT_RULE_CODES = [
  'MESSAGE_TOO_LONG_DELETE',
  'PHONE_NUMBER_BLOCKED_DELETE',
  'PHOTO_BLOCKED_DELETE',
  'VIDEO_BLOCKED_DELETE',
  'FILE_BLOCKED_DELETE',
  'VOICE_BLOCKED_DELETE',
  'FORWARDED_MESSAGE_BLOCKED_DELETE',
  'MESSAGE_RATE_LIMIT_DELETE',
  'MESSAGE_COUNT_LIMIT_DELETE',
  'PHOTO_RATE_LIMIT_DELETE',
  'STICKER_RATE_LIMIT_DELETE',
  'MESSAGE_BLOCKED_WORD_DELETE',
  'MESSAGE_BLOCKED_DOMAIN_DELETE',
  'MUTE_ACTIVE_DELETE',
  'GLOBAL_SPAMMER_MESSAGE_DELETE',
  'LOCAL_ADMIN_BLOCK_MESSAGE_DELETE',
  'BOT_ACCOUNT_MESSAGE_DELETE',
  'INVITATION_ACCESS_DELETE',
  'NIGHT_MODE_DELETE',
  'MANUAL_GROUP_CLOSE_DELETE',
  'REQUIRED_SUBSCRIPTION_DELETE',
  'COMMERCIAL_LLM_DELETE',
];

type ServiceInternals = {
  describeError(
    error: unknown,
    fallback: string,
  ): {
    status: string;
    statusCode: number | null;
    errorCode: string;
    message: string;
    retryDelayMs: number | null;
  };
  finishTerminalPreDispatchGuardRejection(
    intent: Record<string, unknown>,
    leaseToken: string,
    details: unknown,
    guardError: unknown,
  ): Promise<{ status: string }>;
  authorizeGuardedUserDeleteReasons(
    intent: Record<string, unknown>,
    botId: string,
    leaseToken?: string,
  ): Promise<{
    profanityVerified: boolean;
    commercialVerifiedReasonKeys: string[];
    verifiedReasonKeys: string[];
    verifiedReasonDeadlines: { reasonKey: string; deadlineAtMs: number }[];
    messageDuplicateVerified: boolean;
    independentAuthorityDeadlineAtMs: number | null;
    guardedReasonFingerprint: string;
  }>;
  renewLease(
    intentId: string,
    leaseToken: string,
    minimumRemainingMs?: number,
  ): Promise<DeleteIntentLeaseCheck>;
  assertAccessAmbiguousLedgerEvidenceUnchanged(
    tx: { $queryRaw: (query: unknown) => Promise<unknown> },
    expected: ReturnType<typeof accessAmbiguousLedgerEvidence>,
  ): Promise<void>;
  classifyDeleteError(
    error: unknown,
    attemptCount: number,
    dispatchMarkerPersisted?: boolean,
  ): {
    status: string;
    errorCode: string;
    retryDelayMs: number | null;
  };
  normalizeInput(input: Record<string, unknown>): {
    executeAt: Date;
    retryUntilAt: Date;
    routingPolicy: string;
    event: { eventType: string | null };
  };
  selectDueIntentIds(): Promise<unknown[]>;
  expireDueIntents(): Promise<number>;
  claimOne(intentId: string): Promise<unknown>;
  enqueueWakeup(intent: Record<string, unknown>): Promise<void>;
  enqueueCurrentWakeup(intentId: string, priority?: number): Promise<void>;
  orderCandidateBotIds(intent: Record<string, unknown>, values: readonly string[]): string[];
  resolveDeleteRouteWithRefresh(
    intent: Record<string, unknown>,
    heartbeat: { renew: () => Promise<boolean>; stop: () => void },
    canRead?: () => Promise<boolean>,
  ): Promise<unknown>;
  finishRetryableAttempt(
    intent: Record<string, unknown>,
    leaseToken: string,
    details: {
      status: string;
      statusCode: number | null;
      errorCode: string;
      message: string;
      retryDelayMs: number | null;
      certifiedCapabilityLoss?: true;
    },
  ): Promise<{ status: string }>;
  recordCandidateFailure(
    intentId: string,
    leaseToken: string,
    botId: string,
    attemptCount: number,
    details: {
      status: string;
      statusCode: number | null;
      errorCode: string;
      message: string;
      retryDelayMs: number | null;
    },
  ): Promise<void>;
  isExecutionEnabledForIntent(intent: Record<string, unknown>): boolean;
  assertImageTextStopListDeleteIntentStillActionable(
    intent: Record<string, unknown>,
    botId: string,
  ): Promise<
    'not_applicable' | 'absent' | { reasonDeadlines: { reasonKey: string; deadlineAtMs: number }[] }
  >;
  isTerminalDeleteGuardRejection(error: unknown): boolean;
  hasRemoteSuccessMarker(intent: Record<string, unknown>): boolean;
  hasDeleteDispatchMarker(intent: Record<string, unknown>): boolean;
  hasDeleteMutationEvidence(intent: Record<string, unknown>): boolean;
  isBotMessageAutoDeleteRetryLimitApplicable(intent: Record<string, unknown>): boolean;
  findManagedBotMessageOwner(intent: {
    chatId: string;
    messageId: string;
    sourceMessageAt: Date | null;
    entityType: 'CHAT' | 'CHANNEL' | null;
    originBotId: string | null;
  }): Promise<{ id: string; kind: string } | null>;
};

const ownedHeartbeat = {
  renew: jest.fn().mockResolvedValue(true),
  stop: jest.fn(),
};

function guardedFixtureReasons(ruleCode: string) {
  return {
    moderationDeleteIntentReason: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { ruleCode, reasonKey: `${ruleCode}:fixture`, score: 1, metadata: {} },
        ]),
    },
  };
}

function createService(
  overrides: Record<string, unknown> = {},
  prismaOverrides: Record<string, unknown> = {},
  maxClientOverrides: Record<string, unknown> = {},
  maxBotLinkOverrides: Record<string, unknown> = {},
  linkHistoryDeleteGuardOverrides?: Record<string, unknown>,
  photoDuplicateRuntimePolicyOverrides?: Record<string, unknown>,
  commercialOcrDeleteGuardOverrides?: Record<string, unknown>,
  participantImmunityOverrides?: Record<string, unknown>,
  profanityDeleteGuardOverrides?: Record<string, unknown>,
  commercialDeleteGuardOverrides?: Record<string, unknown>,
) {
  const config = {
    MODERATION_DELETE_INTENT_MODE: 'on',
    MODERATION_DELETE_INTENT_REQUIRED_SUBSCRIPTION_ENABLED: false,
    COMMERCIAL_OCR_ROLLOUT_MODE: 'on',
    ...overrides,
  };
  const reasonOverrides =
    (prismaOverrides.moderationDeleteIntentReason as Record<string, unknown> | undefined) ?? {};
  const commercialOcrFixtureMetadata = commercialOcrClaimedIntentInput().intent.event!.metadata;
  let loadedFixtureIntent: Record<string, unknown> | undefined;
  const durableFixtureReasons = () => {
    if (loadedFixtureIntent?.messageDuplicateOwned === true)
      return [
        {
          ruleCode: 'DUPLICATE_DELETE',
          reasonKey: 'MESSAGE_DUPLICATE:v1:fixture',
          score: 1,
          metadata: { duplicateSource: 'message_v1' },
        },
      ];
    if (loadedFixtureIntent?.linkFamilyDeleteOnly === true)
      return [{ ruleCode: 'LINK_BLOCKED_DELETE', reasonKey: 'link', score: 1, metadata: {} }];
    if (loadedFixtureIntent?.commercialOcrGuardRequired === true)
      return [
        {
          ruleCode: COMMERCIAL_OCR_DELETE_RULE_CODE,
          reasonKey: 'commercial-ocr',
          score: 1,
          metadata: commercialOcrFixtureMetadata,
        },
      ];
    return [{ ruleCode: 'ANTI_SPAM', reasonKey: 'anti-spam', score: 1, metadata: {} }];
  };
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(0),
    $transaction: jest.fn<
      Promise<unknown>,
      [callback: (tx: unknown) => Promise<unknown>, options?: unknown]
    >(async (callback) => callback({ $executeRaw: jest.fn().mockResolvedValue(1) })),
    managedBroadcastDelivery: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    maxActionLedgerEntry: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    managedGiveaway: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    vkParsingPost: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    chatRules: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    chatAutoCommentAttachMarker: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    moderationEvent: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    chatSettings: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    ...prismaOverrides,
    moderationDeleteIntentReason: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest
        .fn()
        .mockImplementation(async (args: { where?: { ruleCode?: string } }) =>
          args.where?.ruleCode === COMMERCIAL_OCR_DELETE_RULE_CODE ? null : { id: 'reason-1' },
        ),
      ...reasonOverrides,
      findMany: jest.fn(async (args: unknown) => {
        const rows =
          typeof reasonOverrides.findMany === 'function'
            ? await reasonOverrides.findMany(args)
            : durableFixtureReasons();
        return rows.map((row: Record<string, unknown>) => ({
          ruleCode: row.ruleCode,
          reasonKey: row.reasonKey ?? `${row.ruleCode}:fixture`,
          score: row.score ?? 1,
          metadata: row.metadata ?? {},
        }));
      }),
    },
  };
  const transactionFixture = prisma.$transaction;
  prisma.$transaction = jest.fn<
    Promise<unknown>,
    [callback: (tx: unknown) => Promise<unknown>, options?: unknown]
  >(async (callback, ...args) =>
    transactionFixture(
      async (value: unknown) => {
        const tx = value as Record<string, unknown>;
        return callback({
          ...tx,
          moderationDeleteIntentReason: {
            ...prisma.moderationDeleteIntentReason,
            ...(tx.moderationDeleteIntentReason as Record<string, unknown> | undefined),
          },
        });
      },
      ...args,
    ),
  );
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  // Unit fixtures keep intent-load/finalization responses separate from the
  // new lease SELECT. Real no-op/update/expiry semantics run against PostgreSQL.
  const leaseDatabase = {
    ...prisma,
    $queryRaw: async (query: { strings?: readonly string[] }) => {
      if (query.strings?.join('?').includes('storage:delete_lease_check')) {
        const changed = await prisma.$executeRaw(query);
        return changed > 0 ? [{ renewed: true, remainingMs: 120_000 }] : [];
      }
      const rows = await prisma.$queryRaw(query);
      if (rows[0]?.chatId && rows[0]?.messageId) loadedFixtureIntent = rows[0];
      return rows;
    },
  };
  const deleteMessageOverride = maxClientOverrides.deleteMessage;
  const muteApiBudget = {
    runWithMuteApiBudget: (_scope, callback) => callback(),
  } satisfies Pick<MaxClientService, 'runWithMuteApiBudget'>;
  const runWithMuteApiBudget = jest.spyOn(muteApiBudget, 'runWithMuteApiBudget');
  const maxClient = {
    ...muteApiBudget,
    getCurrentChatMemberAccess: jest.fn(),
    getMessageSnapshot: jest.fn(),
    getExactMessagePresence: jest.fn(),
    ...maxClientOverrides,
    deleteMessage: jest.fn(
      async (
        chatId: string,
        messageId: string,
        options?: Parameters<MaxClientService['deleteMessage']>[2],
      ) => {
        await options?.beforeImmediateDeleteMutation?.();
        if (typeof deleteMessageOverride === 'function') {
          return deleteMessageOverride(chatId, messageId, options);
        }
      },
    ),
  };
  const maxBotLink = {
    resolveDeleteMessageBotRoute: jest.fn(),
    recordBotAccessProbe: jest.fn().mockResolvedValue(true),
    getExecutableBotById: jest.fn().mockReturnValue({ id: 'configured-bot' }),
    ...maxBotLinkOverrides,
  };
  const linkHistoryDeleteGuard = {
    assertIntentStillActionable: jest.fn().mockResolvedValue('allowed'),
    ...linkHistoryDeleteGuardOverrides,
  };
  const photoDuplicateRuntimePolicy = {
    resolveEffectivePolicy: jest.fn().mockResolvedValue({
      mode: 'delete_only',
      enforce: true,
      advancedCanary: false,
      allowedMatchKinds: ['canonical_sha256'],
      maxAction: 'DELETE_MESSAGE',
      controlRevision: 1,
      controlExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
    ...photoDuplicateRuntimePolicyOverrides,
  };
  const commercialOcrDeleteGuard = {
    assertIntentStillActionable: jest.fn().mockResolvedValue('allowed'),
    ...commercialOcrDeleteGuardOverrides,
  };
  const participantImmunity = {
    consumeForMessage: jest.fn().mockResolvedValue('not_granted'),
    ...participantImmunityOverrides,
  };
  const profanityDeleteGuard = {
    assertIntentStillActionable: jest.fn().mockResolvedValue('not_applicable'),
    ...profanityDeleteGuardOverrides,
  };
  const commercialDeleteGuard = {
    assertIntentStillActionable: jest.fn().mockResolvedValue('not_applicable'),
    ...commercialDeleteGuardOverrides,
  };
  for (const guard of [
    linkHistoryDeleteGuard,
    commercialOcrDeleteGuard,
    profanityDeleteGuard,
    commercialDeleteGuard,
  ]) {
    Object.assign(guard, {
      prepareForDispatch: preparedGuardFixture(guard.assertIntentStillActionable),
    });
  }
  const service = new ModerationDeleteIntentService(
    leaseDatabase as never,
    maxClient as never,
    maxBotLink as never,
    queue as never,
    new ConfigService(config),
    linkHistoryDeleteGuard as never,
    photoDuplicateRuntimePolicy as never,
    commercialOcrDeleteGuard as never,
    profanityDeleteGuard as never,
    participantImmunity as never,
    undefined,
    undefined,
    undefined,
    commercialDeleteGuard as never,
  );
  return {
    service,
    prisma,
    queue,
    maxClient,
    runWithMuteApiBudget,
    maxBotLink,
    linkHistoryDeleteGuard,
    photoDuplicateRuntimePolicy,
    commercialOcrDeleteGuard,
    participantImmunity,
    profanityDeleteGuard,
    commercialDeleteGuard,
  };
}

const baseIntent = {
  id: 'intent-1',
  chatId: 'chat-1',
  messageId: 'message-1',
  subjectUserId: 'user-1',
  sourceMessageAt: new Date(),
  entityType: 'CHAT',
  messageAuthorKind: 'user',
  originBotId: 'bot-1',
  routingPolicy: 'delete_capable',
  activeMuteDeleteReason: false,
  commercialOcrGuardRequired: false,
  status: 'IN_PROGRESS',
  executeAt: new Date(Date.now() - 1_000),
  nextAttemptAt: new Date(Date.now() - 1_000),
  retryUntilAt: new Date(Date.now() + 60_000),
  attemptCount: 1,
  lastBotId: null,
  succeededBotId: null,
  deleteDispatchStartedAt: null,
  deleteDispatchStartedBotId: null,
  remoteDeleteSucceededAt: null,
  remoteDeleteSucceededBotId: null,
  candidateFailures: {},
  lastStatusCode: null,
  lastErrorCode: null,
  lastError: null,
  leaseToken: 'lease-1',
  leaseExpiresAt: new Date(Date.now() + 60_000),
  leasedFromStatus: 'PENDING',
} as const;

const confirmedRoute = {
  purpose: 'moderation_action',
  action: 'delete_message',
  chatId: 'chat-1',
  entityType: 'CHAT',
  routingState: 'READY',
  routingVersion: 1,
  primaryBotId: 'bot-1',
  botId: 'bot-1',
  candidateBotIds: ['bot-1', 'bot-2'],
  reason: 'primary_confirmed',
  capabilityState: 'confirmed_capable',
  capabilityReason: 'confirmed',
  checkedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  candidateCapabilities: ['bot-1', 'bot-2'].map((botId) => ({
    botId,
    state: 'confirmed_capable',
    reason: 'confirmed',
    checkedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    routeEligible: true,
  })),
} as const;

function unconfirmedDeleteRoute(botIds: readonly string[]) {
  return {
    ...confirmedRoute,
    botId: null as string | null,
    candidateBotIds: [] as string[],
    capabilityState: 'stale_or_unknown',
    capabilityReason: 'snapshot_stale',
    candidateCapabilities: botIds.map((botId) => ({
      ...confirmedRoute.candidateCapabilities[0],
      botId,
      state: 'stale_or_unknown',
      reason: 'snapshot_stale',
      checkedAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() - 1).toISOString(),
      routeEligible: false,
    })),
  };
}

function nightModeCleanupSettings(overrides: Record<string, unknown> = {}) {
  return {
    chatId: 'chat-1',
    nightModeEnabled: true,
    nightModeStartTimeMinutes: 23 * 60,
    nightModeEndTimeMinutes: 8 * 60,
    nightModeTimezone: 'Europe/Moscow',
    nightModeBotMessageEnabled: true,
    nightModeBotMessageText: '',
    nightModeCommentsEnabled: false,
    nightModeOpenMessageEnabled: true,
    nightModeOpenMessageText: '',
    nightModeForceCloseEnabled: false,
    nightModeForceCloseForever: false,
    nightModeForceCloseUntil: '',
    nightModeBotButtons: null,
    nightModeBotButtonEnabled: false,
    nightModeBotButtonUrl: '',
    nightModeBotButtonText: '',
    nightModeRulesButtonEnabled: false,
    commentsEnabled: false,
    botSpeechStyle: 'ROBOT',
    botSpeechMedia: null,
    updatedAt: new Date('2026-05-30T19:00:00.000Z'),
    chat: { entityType: 'CHAT', rules: null },
    ...overrides,
  };
}

function nightModeCleanupBinding(
  settings = nightModeCleanupSettings(),
): NightModeCloseNoticeCleanupBinding {
  return {
    version: 1,
    sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
    scheduleFingerprint: buildNightModeTransitionScheduleFingerprint(settings as never),
    sideEffectFingerprint: buildNightModeTransitionSideEffectFingerprint(settings as never),
    event: {
      id: 'night-close-event-1',
      ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
      messageId: 'message-1',
    },
  };
}

function commercialOcrClaimedIntentInput(authorityKind: 'CERTIFIED' | 'BASELINE' = 'CERTIFIED') {
  const chatId = 'chat-1';
  const messageId = 'message-1';
  const userId = 'user-1';
  const sourceMessageAt = new Date(Date.now() - 60_000);
  const deadlineAt = new Date(Date.now() + 60_000);
  const settings = {
    commercialAdsFilterEnabled: true,
    commercialAdsSensitivity: 'BALANCED' as const,
    commercialAdsWarnThreshold: 45,
    commercialAdsDeleteThreshold: 65,
  };
  const binding = buildCommercialOcrDeleteBinding({
    ocrVersion: authorityKind === 'BASELINE' ? 'tesseract-rus-eng-v2' : 'tesseract-rus-eng-v1',
    settings,
    senderId: userId,
    orderedPhotoIds: ['photo-1'],
    caption: 'Ремонт квартир',
    sourceCreatedAt: sourceMessageAt,
    expectedImageCount: 1,
    authority:
      authorityKind === 'BASELINE'
        ? {
            kind: 'BASELINE',
            behaviorIdentitySha256: 'b'.repeat(64),
            nativeBehaviorIdentitySha256: 'c'.repeat(64),
            settingsFingerprint: fingerprintCommercialOcrSettingsProfile(settings),
          }
        : {
            kind: 'CERTIFIED',
            controlRevision: 1,
            controlExpiresAt: new Date(Date.now() + 120_000).toISOString(),
          },
    ocrDeadlineAt: deadlineAt,
  });
  return {
    claim: {
      dedupeKey: `commercial-ocr-action:v1:${'a'.repeat(64)}`,
      messageActionKey: buildMessageScopedModerationActionClaimKey(chatId, messageId),
      chatId,
      userId,
      messageId,
      ruleCode: COMMERCIAL_OCR_MESSAGE_ACTION_RULE_CODE,
      updateType: 'message_action' as const,
    },
    intent: {
      chatId,
      messageId,
      reasonKey: 'commercial-ocr-delete:job-1',
      ruleCode: COMMERCIAL_OCR_DELETE_RULE_CODE,
      subjectUserId: userId,
      sourceMessageAt,
      entityType: 'CHAT' as const,
      messageAuthorKind: 'user' as const,
      originBotId: 'bot-1',
      routingPolicy: 'delete_capable' as const,
      retryUntilAt: deadlineAt,
      commercialOcrDeadlineAt: deadlineAt,
      event: {
        userId,
        eventType: 'MESSAGE' as const,
        metadata: { commercialOcrBinding: binding },
      },
    },
  };
}

function imageTextStopListClaimedIntentInput() {
  const chatId = 'chat-1';
  const messageId = 'message-image-1';
  const userId = 'user-1';
  const sourceMessageAt = new Date(Date.now() - 60_000);
  const deadlineAt = new Date(Date.now() + 60_000);
  const binding = buildImageTextStopListBinding({
    ocrVersion: 'tesseract-rus-eng-v2',
    nativeBehaviorFingerprintSha256: resolveExpectedCommercialOcrProductionBehaviorIdentity(
      new ConfigService(),
    ).identity.fingerprintSha256,
    policyFingerprint: fingerprintImageTextStopListPolicy({
      settings: {
        messageLimitsImageTextScanEnabled: true,
        messageLimitsBlockedWords: ['казино'],
        messageLimitsBlockedDomains: [],
        nightModeTimezone: 'Europe/Moscow',
      },
      domainAllowlist: [],
    }),
    ruleCode: 'MESSAGE_BLOCKED_WORD',
    value: 'казино',
    imageIndex: 0,
    primaryConfidencePermille: 960,
    confirmationConfidencePermille: 950,
    senderId: userId,
    sourceCreatedAt: sourceMessageAt.toISOString(),
    deleteDeadlineAt: deadlineAt.toISOString(),
    orderedPhotoIds: ['photo-1'],
    caption: '',
  });
  return {
    claim: {
      dedupeKey: `${IMAGE_TEXT_STOP_LIST_ACTION_DEDUPE_PREFIX}${'a'.repeat(64)}`,
      messageActionKey: buildMessageScopedModerationActionClaimKey(chatId, messageId),
      chatId,
      userId,
      messageId,
      ruleCode: IMAGE_TEXT_STOP_LIST_MESSAGE_ACTION_RULE_CODE,
      updateType: 'message_action' as const,
    },
    intent: {
      chatId,
      messageId,
      reasonKey: `image-text-stop-list-delete:${'a'.repeat(64)}`,
      ruleCode: COMMERCIAL_OCR_DELETE_RULE_CODE,
      subjectUserId: userId,
      sourceMessageAt,
      entityType: 'CHAT' as const,
      messageAuthorKind: 'user' as const,
      originBotId: 'bot-1',
      routingPolicy: 'delete_capable' as const,
      retryUntilAt: deadlineAt,
      commercialOcrDeadlineAt: deadlineAt,
      event: {
        userId,
        eventType: 'MESSAGE' as const,
        score: 0.95,
        metadata: {
          source: 'image_text_ocr',
          enforcementScope: 'delete_only',
          matchedRuleCode: 'MESSAGE_BLOCKED_WORD',
          blockedWord: 'казино',
          imageTextStopListBinding: binding,
        },
      },
    },
  };
}

function requiredSubscriptionDeleteIntentInput() {
  return {
    chatId: 'chat-1',
    messageId: 'message-1',
    reasonKey: 'REQUIRED_SUBSCRIPTION:message-delete',
    ruleCode: 'REQUIRED_SUBSCRIPTION_DELETE',
    subjectUserId: 'user-1',
    sourceMessageAt: new Date(Date.now() - 1_000),
    entityType: 'CHAT' as const,
    messageAuthorKind: 'user' as const,
    originBotId: 'bot-1',
    routingPolicy: 'delete_capable' as const,
  };
}

function botMessageAutoDeleteRepairIntentInput(
  overrides: Partial<EnsureModerationDeleteIntentInput> = {},
): EnsureModerationDeleteIntentInput {
  const sourceMessageAt = new Date('2026-08-31T12:00:00.000Z');
  return {
    chatId: 'chat-1',
    messageId: 'message-1',
    reasonKey: 'BOT_MESSAGE_AUTO_DELETE',
    ruleCode: 'BOT_MESSAGE_AUTO_DELETE',
    subjectUserId: 'bot-user-1',
    sourceMessageAt,
    entityType: 'CHAT',
    messageAuthorKind: 'bot',
    originBotId: 'bot-1',
    routingPolicy: 'origin_only',
    executeAt: new Date('2026-08-31T12:01:00.000Z'),
    retryUntilAt: new Date('2026-09-01T12:01:00.000Z'),
    event: {
      userId: 'bot-user-1',
      eventType: 'MESSAGE',
      metadata: { repairClaimId: 'claim-1' },
    },
    ...overrides,
  };
}

function explicitOperatorCleanupIntentInput(): EnsureModerationDeleteIntentInput {
  return botMessageAutoDeleteRepairIntentInput({
    event: {
      userId: 'bot-user-1',
      eventType: 'MESSAGE',
      metadata: {
        reason: BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_REASON,
        repairSource: BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_EVIDENCE_SOURCE,
        evidenceSource: BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_EVIDENCE_SOURCE,
        evidenceVersion: BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_EVIDENCE_VERSION,
        sourceSendAutoDeleteDelayMs: null,
      },
    },
  });
}

function explicitOperatorCleanupExpectedSend() {
  return {
    ledgerId: 'send-ledger-1',
    jobId: 'send-job-1',
    chatId: 'chat-1',
    messageId: 'message-1',
    dispatchBotId: 'bot-1',
    trafficClass: 'background',
    actionHealthLane: 'background',
    enqueuedAt: new Date('2026-08-31T11:59:59.200Z'),
    completedAt: new Date('2026-08-31T12:00:00.000Z'),
    createdAt: new Date('2026-08-31T11:59:59.100Z'),
    updatedAt: new Date('2026-08-31T12:00:01.000Z'),
    jobCreatedAt: new Date('2026-08-31T11:59:59.000Z'),
  };
}

function explicitOperatorCleanupSendRow() {
  const send = explicitOperatorCleanupExpectedSend();
  return {
    ...send,
    actionType: 'SEND_MESSAGE',
    remoteMessageId: send.messageId,
    sourceTag: 'moderation_notice',
    status: 'SUCCEEDED',
    ambiguous: false,
    terminal: true,
    hasAutoDeleteDelayMs: true,
    autoDeleteDelayType: 'null',
    jobCreatedAt: send.jobCreatedAt.toISOString(),
  };
}

function accessAmbiguousLedgerEvidence() {
  return {
    deleteLedgerId: 'delete-ledger-1',
    deleteJobId: 'delete-job-1',
    chatId: 'chat-1',
    messageId: 'message-1',
    originBotId: 'bot-1',
    sourceTag: 'moderation_notice',
    trafficClass: 'background',
    actionHealthLane: 'background',
    attemptCount: 1,
    enqueuedAt: new Date('2026-08-31T12:01:59.200Z'),
    firstAttemptAt: new Date('2026-08-31T12:02:00.000Z'),
    lastAttemptAt: new Date('2026-08-31T12:02:00.000Z'),
    completedAt: new Date('2026-08-31T12:02:01.000Z'),
    createdAt: new Date('2026-08-31T12:01:59.100Z'),
    updatedAt: new Date('2026-08-31T12:02:01.000Z'),
    sourceSendLedgerId: 'send-ledger-1',
    sourceSendJobId: 'send-job-1',
    sourceSendEnqueuedAt: new Date('2026-08-31T11:59:59.200Z'),
    sourceSendCompletedAt: new Date('2026-08-31T12:00:00.000Z'),
    sourceSendCreatedAt: new Date('2026-08-31T11:59:59.100Z'),
    sourceSendUpdatedAt: new Date('2026-08-31T12:00:01.000Z'),
    requestedDelayMs: 120_000,
  };
}

function accessAmbiguousDeleteRow() {
  const expected = accessAmbiguousLedgerEvidence();
  return {
    id: expected.deleteLedgerId,
    jobId: expected.deleteJobId,
    actionType: 'DELETE_MESSAGE',
    chatId: expected.chatId,
    botId: expected.originBotId,
    messageId: expected.messageId,
    sourceTag: expected.sourceTag,
    trafficClass: expected.trafficClass,
    actionHealthLane: expected.actionHealthLane,
    status: 'FAILED_RETRYABLE',
    ambiguous: false,
    terminal: true,
    attemptCount: expected.attemptCount,
    lastStatusCode: null,
    lastErrorCode: 'send_auto_delete_exact_verification_access_ambiguous',
    metadata: {
      sendAutoDelete: {
        version: 2,
        sourceSendJobId: expected.sourceSendJobId,
        sourceSendCompletedAt: expected.sourceSendCompletedAt.toISOString(),
        requestedDelayMs: expected.requestedDelayMs,
        originBotId: expected.originBotId,
      },
    },
    enqueuedAt: expected.enqueuedAt,
    firstAttemptAt: expected.firstAttemptAt,
    lastAttemptAt: expected.lastAttemptAt,
    completedAt: expected.completedAt,
    createdAt: expected.createdAt,
    updatedAt: expected.updatedAt,
  };
}

function accessAmbiguousSourceSendRow() {
  const expected = accessAmbiguousLedgerEvidence();
  return {
    id: expected.sourceSendLedgerId,
    jobId: expected.sourceSendJobId,
    actionType: 'SEND_MESSAGE',
    chatId: expected.chatId,
    remoteMessageId: expected.messageId,
    sourceTag: 'moderation_notice',
    status: 'SUCCEEDED',
    ambiguous: false,
    terminal: true,
    dispatchBotId: expected.originBotId,
    metadata: { autoDeleteDelayMs: expected.requestedDelayMs },
    enqueuedAt: expected.sourceSendEnqueuedAt,
    completedAt: expected.sourceSendCompletedAt,
    createdAt: expected.sourceSendCreatedAt,
    updatedAt: expected.sourceSendUpdatedAt,
  };
}

describe('ModerationDeleteIntentService', () => {
  it('keeps nested authority capsules single-use with only one local continuation', async () => {
    const localAuthority = jest.fn(async () => 'allowed' as const);
    const child = prepareDeleteAuthority(localAuthority);
    const outer = prepareDeleteAuthority(async (finalizeNested) => finalizeNested(child));

    expect(() => prepareDeleteAuthorityRecheck(outer)).toThrow('has not finished finalizing');
    await expect(finalizeDeleteAuthority(outer)).resolves.toBe('allowed');
    await expect(finalizeDeleteAuthority(outer)).rejects.toThrow('was already finalized');
    const continuation = prepareDeleteAuthorityRecheck(outer);
    await expect(finalizeDeleteAuthority(continuation)).resolves.toBe('allowed');
    await expect(finalizeDeleteAuthority(continuation)).rejects.toThrow('was already finalized');
    expect(() => prepareDeleteAuthorityRecheck(outer)).toThrow('recheck was already prepared');
    expect(() => prepareDeleteAuthorityRecheck(continuation)).toThrow(
      'recheck was already prepared',
    );
    expect(() => prepareDeleteAuthorityRecheck(child)).toThrow('recheck was already prepared');
    expect(localAuthority).toHaveBeenCalledTimes(2);
  });

  it('preserves rejected nested evidence while rechecking its independent survivor', async () => {
    const rejected = new Error('Original local reason revoked');
    const rejectedAuthority = jest.fn(async () => {
      throw rejected;
    });
    const denied = prepareDeleteAuthority(rejectedAuthority);
    const localAuthority = jest.fn(async () => 'allowed' as const);
    const survivor = prepareDeleteAuthority(localAuthority);
    const outer = prepareDeleteAuthority(async (finalizeNested) => {
      try {
        return await finalizeNested(denied);
      } catch (error) {
        if (error !== rejected) throw error;
      }
      return finalizeNested(survivor);
    });

    await expect(finalizeDeleteAuthority(outer)).resolves.toBe('allowed');
    await expect(finalizeDeleteAuthority(prepareDeleteAuthorityRecheck(outer))).resolves.toBe(
      'allowed',
    );
    expect(rejectedAuthority).toHaveBeenCalledTimes(1);
    expect(localAuthority).toHaveBeenCalledTimes(2);
  });

  function initialDuplicateSourceFixture(attemptCount = 1) {
    const fixture = createService({}, { $executeRaw: jest.fn().mockResolvedValue(1) });
    const leased = {
      ...baseIntent,
      attemptCount,
      messageDuplicateOwned: true,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    };
    const deferred = { ...leased, status: 'RETRYABLE', leaseToken: null, leaseExpiresAt: null };
    const remoteDelete = jest.fn();
    fixture.maxClient.deleteMessage.mockImplementation(async (_chatId, _messageId, options) => {
      await options?.beforeImmediateDeleteMutation?.();
      remoteDelete();
    });
    const mark = jest.fn().mockResolvedValue(true);
    const clear = jest.fn().mockResolvedValue(true);
    Object.assign(fixture.service, {
      loadIntent: jest.fn().mockResolvedValue(leased),
      loadRequiredIntent: jest.fn().mockResolvedValue(deferred),
      startLeaseHeartbeat: () => ({ ...ownedHeartbeat, hasRemainingBudget: () => true }),
      assertLeaseForExternalCall: jest.fn(),
      isLegacyIntentHeld: jest.fn().mockResolvedValue(false),
      finishProtectedManagedBotMessageAutoDelete: jest.fn().mockResolvedValue(null),
      resolveDeleteRouteWithRefresh: jest.fn().mockResolvedValue(confirmedRoute),
      filterAndOrderRouteCandidates: () => ['bot-1'],
      recordAttemptBot: jest.fn().mockResolvedValue(true),
      markDeleteDispatchStarted: mark,
      clearDeleteDispatchStarted: clear,
      assertChannelAutoPostCleanupStillAuthorized: jest.fn(),
      assertNightModeCloseNoticeCleanupStillAuthorized: jest.fn(),
      resolveDeleteIntentCommercialOcrGuard: jest.fn().mockResolvedValue(false),
      assertPhotoDuplicateDeleteIntentStillActionable: jest.fn(),
      assertImageTextStopListDeleteIntentStillActionable: jest
        .fn<
          ReturnType<ServiceInternals['assertImageTextStopListDeleteIntentStillActionable']>,
          Parameters<ServiceInternals['assertImageTextStopListDeleteIntentStillActionable']>
        >()
        .mockResolvedValue('not_applicable'),
      enqueueWakeup: jest.fn(),
    });
    return { ...fixture, leased, deferred, remoteDelete, mark, clear };
  }

  it.each([false, true])(
    'defers a muted-user attempt before MAX work and preserves prior uncertainty: %s',
    async (unknownOutcome) => {
      const now = Date.now();
      const leased = {
        ...baseIntent,
        activeMuteDeleteReason: true,
        retryUntilAt: new Date(now + (unknownOutcome ? -1_000 : 600_000)),
        deleteDispatchStartedAt: unknownOutcome ? new Date(now - 2_000) : null,
        deleteDispatchStartedBotId: unknownOutcome ? 'bot-2' : null,
      };
      const deferred = {
        ...leased,
        status: unknownOutcome ? 'AMBIGUOUS' : 'RETRYABLE',
        nextAttemptAt: new Date(now + 300_000),
        lastErrorCode: 'mute_api_budget_actor_cooldown',
        leaseToken: null,
        leaseExpiresAt: null,
      };
      const queryRaw = jest.fn().mockResolvedValueOnce([leased]).mockResolvedValueOnce([deferred]);
      const executeRaw = jest.fn().mockResolvedValue(1);
      const fixture = createService({}, { $queryRaw: queryRaw, $executeRaw: executeRaw });
      fixture.runWithMuteApiBudget.mockRejectedValue(
        new MaxModerationApiBudgetError('actor_cooldown', 300_000),
      );

      await expect(
        fixture.service.executeLeasedIntent(leased.id, 'lease-1'),
      ).resolves.toMatchObject({
        kind: unknownOutcome ? 'ambiguous' : 'pending',
        intentId: leased.id,
        status: deferred.status,
      });

      expect(fixture.runWithMuteApiBudget).toHaveBeenCalledTimes(1);
      expect(fixture.runWithMuteApiBudget).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: leased.chatId,
          subjectUserId: leased.subjectUserId,
          intentId: leased.id,
          attemptCount: leased.attemptCount,
          ...(!unknownOutcome ? { deadlineAtMs: leased.retryUntilAt.getTime() } : {}),
        }),
        expect.any(Function),
      );
      expect(fixture.maxBotLink.resolveDeleteMessageBotRoute).not.toHaveBeenCalled();
      expect(fixture.maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
      expect(fixture.maxClient.getMessageSnapshot).not.toHaveBeenCalled();
      expect(fixture.maxClient.getExactMessagePresence).not.toHaveBeenCalled();
      expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(fixture.queue.add).not.toHaveBeenCalled();
      expect(leased.retryUntilAt).toEqual(deferred.retryUntilAt);
      expect(leased.deleteDispatchStartedAt).toEqual(deferred.deleteDispatchStartedAt);
      expect(leased.deleteDispatchStartedBotId).toBe(deferred.deleteDispatchStartedBotId);
      expect(executeRaw).toHaveBeenCalledTimes(1);
      const retrySql = (executeRaw.mock.calls[0]![0] as Prisma.Sql).strings.join('?');
      expect(retrySql).toContain('"lease_token" = NULL');
      expect(retrySql).not.toContain('"retry_until_at" =');
      expect(retrySql).not.toContain('"delete_dispatch_started_at" =');
      expect(retrySql).not.toContain('"delete_dispatch_started_bot_id" =');
      expect((executeRaw.mock.calls[0]![0] as Prisma.Sql).values).toEqual(
        expect.arrayContaining([deferred.status, 'mute_api_budget_actor_cooldown']),
      );
    },
  );

  it('clears only the new dispatch marker after a direct marked mute-budget rejection', async () => {
    const fixture = initialDuplicateSourceFixture();
    const leased = {
      ...fixture.leased,
      activeMuteDeleteReason: true,
      messageDuplicateOwned: false,
    };
    const deferred = {
      ...leased,
      status: 'RETRYABLE',
      lastErrorCode: 'mute_api_budget_expired',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    Object.assign(fixture.service, {
      loadIntent: jest.fn().mockResolvedValue(leased),
      loadRequiredIntent: jest.fn().mockResolvedValue(deferred),
      filterAndOrderRouteCandidates: () => ['bot-1', 'bot-2'],
      runDeletePreDispatchGuards: jest.fn().mockResolvedValue({
        profanityVerified: false,
        commercialVerifiedReasonKeys: [],
        messageDuplicateVerified: false,
        verifiedReasonKeys: [],
        verifiedReasonDeadlines: [],
        independentAuthorityDeadlineAtMs: null,
        guardedReasonFingerprint: 'a'.repeat(64),
      }),
      assertVerifiedReasonDeadlineFence: jest.fn().mockResolvedValue(null),
    });
    fixture.maxClient.deleteMessage.mockImplementation(async (_chatId, _messageId, options) => {
      await options?.beforeImmediateDeleteMutation?.();
      expect(fixture.mark).toHaveBeenCalledWith(leased.id, 'lease-1', 'bot-1');
      expect(leased.deleteDispatchStartedAt).not.toBeNull();
      expect(leased.deleteDispatchStartedBotId).toBe('bot-1');
      throw markMaxPreDispatchGuardRejected(
        new MaxModerationApiBudgetError('expired', 1_000),
        MAX_DELETE_PRE_DISPATCH_GUARD_REJECTED_CODE,
      );
    });

    await expect(fixture.service.executeLeasedIntent(leased.id, 'lease-1')).resolves.toMatchObject({
      kind: 'pending',
      status: 'RETRYABLE',
    });

    expect(fixture.runWithMuteApiBudget).toHaveBeenCalledTimes(1);
    expect(fixture.clear).toHaveBeenCalledTimes(1);
    expect(fixture.clear).toHaveBeenCalledWith(leased.id, 'lease-1', 'bot-1');
    expect(leased).toMatchObject({
      deleteDispatchStartedAt: null,
      deleteDispatchStartedBotId: null,
      retryUntilAt: deferred.retryUntilAt,
    });
    expect(fixture.maxClient.deleteMessage).toHaveBeenCalledTimes(1);
    expect(fixture.remoteDelete).not.toHaveBeenCalled();
    expect(fixture.maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(fixture.maxClient.getExactMessagePresence).not.toHaveBeenCalled();
    expect(fixture.maxBotLink.recordBotAccessProbe).not.toHaveBeenCalled();
    expect(fixture.prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect((fixture.prisma.$executeRaw.mock.calls[0]![0] as Prisma.Sql).values).toEqual(
      expect.arrayContaining(['RETRYABLE', 'mute_api_budget_expired']),
    );
  });

  it('settles recorded muted-user remote success without reserving MAX API capacity', async () => {
    const now = Date.now();
    const leased = {
      ...baseIntent,
      activeMuteDeleteReason: true,
      retryUntilAt: new Date(now - 1_000),
      remoteDeleteSucceededAt: new Date(now - 2_000),
      remoteDeleteSucceededBotId: 'bot-1',
    };
    const succeeded = {
      ...leased,
      status: 'SUCCEEDED',
      succeededBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const fixture = createService(
      {},
      {
        $queryRaw: jest.fn().mockResolvedValueOnce([leased]).mockResolvedValueOnce([succeeded]),
      },
    );
    fixture.runWithMuteApiBudget.mockRejectedValue(
      new MaxModerationApiBudgetError('actor_cooldown', 300_000),
    );

    await expect(fixture.service.executeLeasedIntent(leased.id, 'lease-1')).resolves.toMatchObject({
      kind: 'confirmed',
      status: 'SUCCEEDED',
      botId: 'bot-1',
    });

    expect(fixture.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(fixture.runWithMuteApiBudget).not.toHaveBeenCalled();
    expect(fixture.maxBotLink.resolveDeleteMessageBotRoute).not.toHaveBeenCalled();
    expect(fixture.maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(fixture.maxClient.getMessageSnapshot).not.toHaveBeenCalled();
    expect(fixture.maxClient.getExactMessagePresence).not.toHaveBeenCalled();
    expect(fixture.maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(succeeded.retryUntilAt).toEqual(leased.retryUntilAt);
  });

  it.each(['off', 'shadow', 'canary', 'on'] as const)(
    'keeps current user-delete guards executable in %s without enabling historical work',
    (mode) => {
      const { service } = createService({
        MODERATION_DELETE_INTENT_MODE: mode,
        COMMERCIAL_OCR_ROLLOUT_MODE: 'off',
        MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: 'other-chat',
        MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_ENABLED: false,
      });
      for (const rule of [
        ...VERIFIED_RECEIPT_RULE_CODES.filter((rule) => rule !== 'REQUIRED_SUBSCRIPTION_DELETE'),
        'LINK_BLOCKED_DELETE',
        'PROFANITY_DELETE',
        'COMMERCIAL_AD_DELETE',
        'SLOW_MODE_DELETE',
        'MEDIA_RATE_LIMIT_DELETE',
        'STICKER_BLOCKED_DELETE',
      ]) {
        expect(service.getRolloutForRule('chat-1', rule)).toBe('execute');
      }
      if (mode !== 'on')
        for (const rule of [
          'DUPLICATE_DELETE',
          'UNKNOWN_DELETE',
          'CHAT_RULES_REPUBLISH_PREVIOUS_MESSAGE_CLEANUP',
        ]) {
          expect(service.getRolloutForRule('chat-1', rule)).toBe(
            mode === 'off' ? 'off' : 'observed',
          );
        }
      expect(service.getRolloutForRule('chat-1', 'COMMERCIAL_OCR_DELETE')).toBe('off');
      expect(
        (service as unknown as ServiceInternals).isExecutionEnabledForIntent({
          ...baseIntent,
          durableUserDeleteReason: true,
        }),
      ).toBe(true);
    },
  );

  it.each(['initial', 'final'] as const)(
    'commits a built-in %s guard retry independently of the inline caller',
    async (phase) => {
      const s = initialDuplicateSourceFixture();
      Object.assign(s.leased, { messageDuplicateOwned: false, durableUserDeleteReason: true });
      const failure = Object.assign(new Error('Source read unavailable'), {
        response: { status: 503 },
      });
      Object.assign(
        s.service,
        phase === 'initial'
          ? {
              assertNightModeCloseNoticeCleanupStillAuthorized: jest
                .fn()
                .mockRejectedValue(failure),
            }
          : { authorizeGuardedUserDeleteReasons: jest.fn().mockRejectedValue(failure) },
      );
      await expect(
        s.service.executeLeasedIntent(s.leased.id, 'lease-1', { deferGuardFailure: true }),
      ).resolves.toMatchObject({ kind: 'pending', status: 'RETRYABLE', confirmed: false });
      expect(s.remoteDelete).not.toHaveBeenCalled();
      expect(s.clear).toHaveBeenCalledTimes(phase === 'final' ? 1 : 0);
      const retry = s.prisma.$executeRaw.mock.calls.at(-1)![0];
      expect(retry.strings.join('?')).toContain('"lease_expires_at" > (clock_timestamp()');
      expect(retry.strings.join('?')).toContain('"remote_delete_succeeded_at" IS NULL');
      expect(retry.strings.join('?')).not.toMatch(/SET\s+"retry_until_at"/u);
    },
  );

  it.each(
    [false, true].flatMap((deferGuardFailure) =>
      (['initial', 'final'] as const).map((phase) => ({ deferGuardFailure, phase })),
    ),
  )(
    'honors guard HTTP 429 Retry-After at $phase with transfer=$deferGuardFailure',
    async ({ deferGuardFailure, phase }) => {
      const s = initialDuplicateSourceFixture();
      Object.assign(s.leased, {
        messageDuplicateOwned: false,
        durableUserDeleteReason: true,
        retryUntilAt: new Date(Date.now() + 120_000),
      });
      const failure = Object.assign(new Error('Author GET rate limited'), {
        response: { status: 429, headers: { 'retry-after': '45' } },
        config: { method: 'get' },
      });
      Object.assign(
        s.service,
        phase === 'initial'
          ? {
              assertNightModeCloseNoticeCleanupStillAuthorized: jest
                .fn()
                .mockRejectedValue(failure),
            }
          : { authorizeGuardedUserDeleteReasons: jest.fn().mockRejectedValue(failure) },
      );
      const startedAt = Date.now();
      const execution = s.service.executeLeasedIntent(s.leased.id, 'lease-1', {
        deferGuardFailure,
      });
      if (deferGuardFailure)
        await expect(execution).resolves.toMatchObject({ status: 'RETRYABLE', confirmed: false });
      else await expect(execution).rejects.toBe(failure);
      expect(s.remoteDelete).not.toHaveBeenCalled();
      expect(s.clear).toHaveBeenCalledTimes(phase === 'final' ? 1 : 0);
      const retry = s.prisma.$executeRaw.mock.calls.at(-1)![0];
      expect(retry.values).toContain('RETRYABLE');
      expect(
        retry.values.some(
          (value: unknown) =>
            value instanceof Date &&
            value.getTime() >= startedAt + 45_000 &&
            value.getTime() <= Date.now() + 45_000,
        ),
      ).toBe(true);
      expect(retry.strings.join('?')).not.toMatch(/SET\s+"retry_until_at"/u);
    },
  );

  it.each([
    [429, 'Infinity'],
    [429, '999999999999999999999999'],
    [503, '45'],
  ])('keeps guard backoff bounded for status %i and hint %s', async (status, hint) => {
    const s = initialDuplicateSourceFixture();
    Object.assign(s.leased, { messageDuplicateOwned: false, durableUserDeleteReason: true });
    Object.assign(s.service, {
      assertNightModeCloseNoticeCleanupStillAuthorized: jest.fn().mockRejectedValue(
        Object.assign(new Error('Author GET unavailable'), {
          response: { status, headers: { 'retry-after': hint } },
          config: { method: 'get' },
        }),
      ),
    });
    const startedAt = Date.now();
    await expect(
      s.service.executeLeasedIntent(s.leased.id, 'lease-1', { deferGuardFailure: true }),
    ).resolves.toMatchObject({ status: 'RETRYABLE', confirmed: false });
    const retry = s.prisma.$executeRaw.mock.calls.at(-1)![0];
    expect(
      retry.values.some(
        (value: unknown) =>
          value instanceof Date &&
          value.getTime() >= startedAt + 4_000 &&
          value.getTime() <= Date.now() + 6_000,
      ),
    ).toBe(true);
    expect(s.remoteDelete).not.toHaveBeenCalled();
  });

  it.each(['lease-cas', 'storage-error', 'caller', 'clear-failed'] as const)(
    'does not detach an inline guard failure after %s',
    async (failure) => {
      const s = initialDuplicateSourceFixture();
      Object.assign(s.leased, { messageDuplicateOwned: false, durableUserDeleteReason: true });
      const error = new Error('Caller ownership lost');
      if (failure === 'clear-failed') {
        Object.assign(s.service, {
          authorizeGuardedUserDeleteReasons: jest.fn().mockRejectedValue(error),
        });
        s.clear.mockResolvedValue(false);
        await expect(
          s.service.executeLeasedIntent(s.leased.id, 'lease-1', { deferGuardFailure: true }),
        ).rejects.toThrow('lease ownership was lost');
      } else if (failure === 'caller') {
        await expect(
          s.service.executeLeasedIntent(s.leased.id, 'lease-1', {
            deferGuardFailure: true,
            beforeDeleteMutation: async () => {
              throw error;
            },
          }),
        ).rejects.toBe(error);
      } else {
        Object.assign(s.service, {
          assertNightModeCloseNoticeCleanupStillAuthorized: jest.fn().mockRejectedValue(error),
        });
        if (failure === 'lease-cas') s.prisma.$executeRaw.mockResolvedValue(0);
        else s.prisma.$executeRaw.mockRejectedValue(new Error('retry storage unavailable'));
        await expect(
          s.service.executeLeasedIntent(s.leased.id, 'lease-1', { deferGuardFailure: true }),
        ).rejects.toThrow(failure === 'lease-cas' ? 'lease ownership was lost' : 'retry storage');
      }
      expect(s.remoteDelete).not.toHaveBeenCalled();
    },
  );

  it('commits a first duplicate source retry before declining inline effects', async () => {
    const s = initialDuplicateSourceFixture();
    const sourceError = { response: { status: 404 } };
    const guard = jest.fn(async (phase?: ModerationDeletePreDispatchPhase) => {
      expect(phase).toBe('initial_unattempted');
      throw new MessageDuplicateInitialSourceUnavailableError('current', sourceError);
    });
    await expect(
      s.service.executeLeasedIntent(s.leased.id, 'lease-1', { beforeDeleteMutation: guard }),
    ).resolves.toEqual({
      kind: 'inline_declined',
      confirmed: false,
      intentId: s.leased.id,
      status: 'RETRYABLE',
    });
    expect(s.remoteDelete).not.toHaveBeenCalled();
    expect(s.mark).not.toHaveBeenCalled();
    expect(s.clear).not.toHaveBeenCalled();
    const retry = s.prisma.$executeRaw.mock.calls.at(-1)![0];
    expect(retry.strings.join('?')).toContain('"attempt_count" = 1');
    expect(retry.strings.join('?')).toContain('"remote_delete_succeeded_at" IS NULL');
    expect(retry.strings.join('?')).not.toMatch(/SET\s+"retry_until_at"/u);
    expect(s.leased.retryUntilAt).toBe(baseIntent.retryUntilAt);
  });

  it.each([false, true])(
    'honors a first duplicate source cooldown without renewing its deadline (expires=%s)',
    async (expires) => {
      const s = initialDuplicateSourceFixture();
      const deadline = new Date(Date.now() + (expires ? 20_000 : 120_000));
      s.leased.retryUntilAt = deadline;
      s.deferred.status = expires ? 'EXPIRED' : 'RETRYABLE';
      const sourceError = new MaxApiInternalRateLimitError(
        'Source read cooling down',
        45_000,
        'external_cooldown',
      );
      const startedAt = Date.now();

      await expect(
        s.service.executeLeasedIntent(s.leased.id, 'lease-1', {
          beforeDeleteMutation: async () => {
            throw new MessageDuplicateInitialSourceUnavailableError('current', sourceError);
          },
        }),
      ).resolves.toMatchObject({
        kind: 'inline_declined',
        confirmed: false,
        status: expires ? 'EXPIRED' : 'RETRYABLE',
      });

      const retry = s.prisma.$executeRaw.mock.calls.at(-1)![0];
      expect(retry.values).toContain(expires ? 'EXPIRED' : 'RETRYABLE');
      expect(
        retry.values.some(
          (value: unknown) =>
            value instanceof Date &&
            (expires
              ? value.getTime() === deadline.getTime()
              : value.getTime() >= startedAt + 45_000 && value.getTime() <= Date.now() + 45_000),
        ),
      ).toBe(true);
      expect(retry.strings.join('?')).not.toMatch(/SET\s+"retry_until_at"/u);
      expect(s.remoteDelete).not.toHaveBeenCalled();
      expect(s.mark).not.toHaveBeenCalled();
      expect(s.clear).not.toHaveBeenCalled();
    },
  );

  it.each(['lease-cas', 'storage-error'] as const)(
    'does not decline a duplicate when retry persistence fails: %s',
    async (failure) => {
      const s = initialDuplicateSourceFixture();
      if (failure === 'lease-cas') s.prisma.$executeRaw.mockResolvedValue(0);
      else s.prisma.$executeRaw.mockRejectedValue(new Error('retry storage unavailable'));
      await expect(
        s.service.executeLeasedIntent(s.leased.id, 'lease-1', {
          beforeDeleteMutation: async () => {
            throw new MessageDuplicateInitialSourceUnavailableError('current', {
              response: { status: 404 },
            });
          },
        }),
      ).rejects.toThrow(failure === 'lease-cas' ? 'lost unattempted ownership' : 'retry storage');
      expect(s.remoteDelete).not.toHaveBeenCalled();
      expect(s.mark).not.toHaveBeenCalled();
    },
  );

  it.each(['second-check', 'previous-attempt'] as const)(
    'keeps a duplicate source failure fenced during %s',
    async (stage) => {
      const s = initialDuplicateSourceFixture(stage === 'previous-attempt' ? 2 : 1);
      const sourceError = { response: { status: 404 } };
      const phases: Array<ModerationDeletePreDispatchPhase | undefined> = [];
      await expect(
        s.service.executeLeasedIntent(s.leased.id, 'lease-1', {
          beforeDeleteMutation: async (phase) => {
            phases.push(phase);
            if (phase === 'recheck') throw sourceError;
          },
        }),
      ).rejects.toBe(sourceError);
      expect(phases).toEqual(
        stage === 'second-check' ? ['initial_unattempted', 'recheck'] : ['recheck'],
      );
      expect(s.remoteDelete).not.toHaveBeenCalled();
      expect(s.clear).toHaveBeenCalledTimes(stage === 'second-check' ? 1 : 0);
    },
  );

  it.each([
    ['expired active lease', { status: 'IN_PROGRESS', leaseExpiresAt: new Date(0) }, 'pending'],
    ['unknown effect', { status: 'AMBIGUOUS' }, 'ambiguous'],
    ['already absent source', { status: 'ALREADY_ABSENT' }, 'already_absent'],
    ['another source identity', { status: 'SUCCEEDED', sourceMessageAt: new Date(0) }, 'pending'],
  ] as const)(
    'does not recover strike authority from %s while observing a worker',
    async (_name, patch, kind) => {
      const input = {
        chatId: 'chat-1',
        messageId: 'message-1',
        subjectUserId: 'user-1',
        sourceMessageAt: baseIntent.sourceMessageAt,
        ruleCode: 'MESSAGE_TOO_LONG_DELETE',
        reasonKey: 'length:own',
      };
      const findUnique = jest.fn().mockResolvedValue({
        id: 'intent-1',
        chatId: input.chatId,
        messageId: input.messageId,
        subjectUserId: input.subjectUserId,
        sourceMessageAt: input.sourceMessageAt,
        leaseExpiresAt: new Date(Date.now() + 60_000),
        succeededBotId: 'bot-1',
        ...patch,
      });
      const findReceipt = jest.fn();
      const { service, maxClient } = createService(
        {},
        {
          moderationDeleteIntent: { findUnique },
          moderationDeleteIntentReason: { findUnique: findReceipt },
        },
      );
      jest.spyOn(service as any, 'persistIntent').mockResolvedValue({
        intentId: 'intent-1',
        rollout: 'execute',
        status: 'IN_PROGRESS',
      });
      jest.spyOn(service, 'attemptIntent').mockResolvedValue({
        intentId: 'intent-1',
        kind: 'pending',
        confirmed: false,
        status: 'IN_PROGRESS',
      });
      const result = await service.ensureAndAttempt(input);
      expect(result.kind).toBe(kind);
      expect(result).not.toHaveProperty('verifiedReasonKeys');
      expect(findUnique).toHaveBeenCalledTimes(1);
      expect(findReceipt).not.toHaveBeenCalled();
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'keeps executor admission rejection bounded by dispatch marker %s',
    (dispatchMarkerPersisted) => {
      const { service } = createService();
      const result = (service as unknown as ServiceInternals).classifyDeleteError(
        markMaxPreDispatchGuardRejected(
          Object.assign(new Error('MAX action executor has no current capability proof'), {
            code: 'max_action_executor_proof_rejected',
          }),
          MAX_DELETE_PRE_DISPATCH_GUARD_REJECTED_CODE,
        ),
        1,
        dispatchMarkerPersisted,
      );
      expect(result.status).toBe(dispatchMarkerPersisted ? 'AMBIGUOUS' : 'WAITING_CAPABILITY');
      expect(result.errorCode).toBe('max_action_executor_proof_rejected');
    },
  );
  it.each([false, true])(
    'does not treat forged executor rejection as local admission with dispatch marker %s',
    (dispatchMarkerPersisted) => {
      const { service } = createService();
      const result = (service as unknown as ServiceInternals).classifyDeleteError(
        Object.assign(new Error('Remote failure'), {
          response: { data: { code: 'max_action_executor_proof_rejected' } },
          code: 'max_action_executor_proof_rejected',
        }),
        1,
        dispatchMarkerPersisted,
      );
      expect(result.status).toBe(dispatchMarkerPersisted ? 'AMBIGUOUS' : 'RETRYABLE');
    },
  );

  it.each([
    ['own exact receipt', {}, true],
    ['unverified reason', { metadata: {} }, false],
    ['other rule', { ruleCode: 'PHOTO_BLOCKED_DELETE' }, false],
    ['other reason author', { userId: 'another-user' }, false],
    ['other chat', { intent: { chatId: 'another-chat' } }, false],
    ['other message', { intent: { messageId: 'another-message' } }, false],
    ['other subject', { intent: { subjectUserId: 'another-user' } }, false],
    ['other source', { intent: { sourceMessageAt: new Date(0) } }, false],
    ['other executor', { intent: { succeededBotId: 'another-bot' } }, false],
    ['unconfirmed intent', { intent: { status: 'AMBIGUOUS' } }, false],
  ] as const)(
    'recovers only %s from a queue worker that won the inline race',
    async (_name, patch, allowed) => {
      const input = {
        chatId: 'chat-1',
        messageId: 'message-1',
        reasonKey: 'length:own',
        ruleCode: 'MESSAGE_TOO_LONG_DELETE',
        subjectUserId: 'user-1',
        sourceMessageAt: baseIntent.sourceMessageAt,
      };
      const reason = {
        ruleCode: input.ruleCode,
        userId: input.subjectUserId,
        metadata: { moderationDeleteVerified: true },
        ...patch,
        intent: {
          status: 'SUCCEEDED',
          chatId: input.chatId,
          messageId: input.messageId,
          subjectUserId: input.subjectUserId,
          sourceMessageAt: input.sourceMessageAt,
          succeededBotId: 'bot-1',
          ...('intent' in patch ? patch.intent : {}),
        },
      };
      const findUnique = jest.fn().mockResolvedValue(reason);
      const { service, maxClient } = createService(
        {},
        {
          moderationDeleteIntentReason: { findUnique },
        },
      );
      jest.spyOn(service as any, 'persistIntent').mockResolvedValue({
        intentId: 'intent-1',
        rollout: 'execute',
        status: 'SUCCEEDED',
      });
      jest.spyOn(service, 'attemptIntent').mockResolvedValue({
        intentId: 'intent-1',
        kind: 'confirmed',
        confirmed: true,
        status: 'SUCCEEDED',
        botId: 'bot-1',
      });
      const result = await service.ensureAndAttempt(input);
      expect('verifiedReasonKeys' in result ? (result.verifiedReasonKeys ?? []) : []).toEqual(
        allowed ? [input.reasonKey] : [],
      );
      expect(findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { intentId_reasonKey: { intentId: 'intent-1', reasonKey: input.reasonKey } },
        }),
      );
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(result).not.toHaveProperty('profanityVerified');
      expect(result).not.toHaveProperty('commercialVerified');
    },
  );

  it.each(['disabled policy', 'protected author', 'participant immunity'])(
    'revokes an ordinary DELETE when quota admission observes %s',
    async (revocation) => {
      const f = initialDuplicateSourceFixture();
      const leased = { ...f.leased, messageDuplicateOwned: false };
      const reason = { ruleCode: 'MESSAGE_TOO_LONG_DELETE', reasonKey: 'length', metadata: {} };
      const settings = {
        maxMessageLengthEnabled: true,
        maxMessageLength: 10,
        chat: { entityType: 'CHAT', admins: [] as { userId: string }[] },
      };
      let immune = false;
      const max = {
        getChatMemberAccess: jest.fn(async () => ({
          userId: leased.subjectUserId,
          isAdmin: false,
          isOwner: false,
          permissions: [],
        })),
        getExactMessageRow: jest.fn(async () => ({
          sender: { user_id: leased.subjectUserId },
          recipient: { chat_id: leased.chatId, chat_type: 'chat' },
          timestamp: Date.now(),
          body: { mid: leased.messageId, text: '12345678901' },
        })),
      } satisfies Pick<MaxClientService, 'getChatMemberAccess' | 'getExactMessageRow'>;
      const guard = new MessageLimitsDeleteGuardService(
        { chatSettings: { findUnique: async () => settings } } as never,
        max as never,
        { isKnownBotUserId: () => false } as never,
        { consumeForMessage: async () => (immune ? 'granted' : 'not_granted') } as never,
        new ConfigService(),
      );
      f.prisma.moderationDeleteIntentReason.findMany.mockResolvedValue([reason]);
      const rejected = { kind: 'terminal', status: 'FAILED_TERMINAL', confirmed: false };
      const completed = { kind: 'confirmed', status: 'SUCCEEDED', confirmed: true };
      Object.assign(f.service, {
        loadIntent: jest.fn().mockResolvedValue(leased),
        messageLimitsDeleteGuard: guard,
        participantImmunity: {
          consumeForMessage: async () => (immune ? 'granted' : 'not_granted'),
        },
        finishTerminalPreDispatchGuardRejection: jest.fn().mockResolvedValue(rejected),
        recordRemoteSuccessAndFinalize: jest.fn().mockResolvedValue(completed),
      });
      f.maxClient.deleteMessage.mockImplementation(async (_chat, _message, options) => {
        await options?.beforeImmediateDeleteMutation?.(async () => {
          if (revocation === 'disabled policy') settings.maxMessageLengthEnabled = false;
          if (revocation === 'protected author')
            settings.chat.admins.push({ userId: leased.subjectUserId! });
          if (revocation === 'participant immunity') immune = true;
        });
        f.remoteDelete();
      });

      await expect(f.service.executeLeasedIntent(leased.id, 'lease-1')).resolves.toEqual(rejected);
      expect(f.remoteDelete).not.toHaveBeenCalled();
      // All exact MAX evidence belongs to preparation, before admission changes local authority.
      expect(max.getExactMessageRow).toHaveBeenCalledTimes(1);
      expect(max.getChatMemberAccess).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['disabled policy', 'protected author', 'participant immunity', 'valid length'] as const)(
    'rechecks independent authority when final duplicate refusal observes %s',
    async (revocation) => {
      const f = initialDuplicateSourceFixture();
      const allowed = revocation === 'valid length';
      let immune = false;
      const settings = {
        maxMessageLengthEnabled: true,
        maxMessageLength: 10,
        chat: { entityType: 'CHAT', admins: [] as { userId: string }[] },
      };
      const max = {
        getChatMemberAccess: jest.fn(async () => ({
          userId: f.leased.subjectUserId,
          isAdmin: false,
          isOwner: false,
          permissions: [],
        })),
        getExactMessageRow: jest.fn(async () => ({
          sender: { user_id: f.leased.subjectUserId },
          recipient: { chat_id: f.leased.chatId, chat_type: 'chat' },
          timestamp: Date.now(),
          body: { mid: f.leased.messageId, text: '12345678901' },
        })),
      } satisfies Pick<MaxClientService, 'getChatMemberAccess' | 'getExactMessageRow'>;
      const guard = new MessageLimitsDeleteGuardService(
        { chatSettings: { findUnique: async () => settings } } as never,
        max as never,
        { isKnownBotUserId: () => false } as never,
        { consumeForMessage: async () => (immune ? 'granted' : 'not_granted') } as never,
        new ConfigService(),
      );
      const duplicateGuard = {
        assertIntentStillActionable: jest.fn<
          ReturnType<MessageDuplicateDeleteGuardService['assertIntentStillActionable']>,
          Parameters<MessageDuplicateDeleteGuardService['assertIntentStillActionable']>
        >(async (params) => {
          if (params.authorityOnly) {
            await Promise.resolve();
            if (revocation === 'disabled policy') settings.maxMessageLengthEnabled = false;
            if (revocation === 'protected author')
              settings.chat.admins.push({ userId: f.leased.subjectUserId! });
            if (revocation === 'participant immunity') immune = true;
            throw new MessageDuplicateGuardRejectedError(
              'message_duplicate_action_authority_revoked',
            );
          }
          return 'allowed';
        }),
      } satisfies Pick<MessageDuplicateDeleteGuardService, 'assertIntentStillActionable'>;
      f.prisma.moderationDeleteIntentReason.findMany.mockResolvedValue([
        { ruleCode: 'MESSAGE_TOO_LONG_DELETE', reasonKey: 'length', metadata: {} },
        {
          ruleCode: 'DUPLICATE_DELETE',
          reasonKey: 'MESSAGE_DUPLICATE:v1:current',
          metadata: { duplicateSource: 'message_v1' },
        },
      ]);
      const completed = { kind: 'confirmed', status: 'SUCCEEDED', confirmed: true };
      const receipt = jest.fn().mockResolvedValue(completed);
      Object.assign(f.service, {
        messageLimitsDeleteGuard: guard,
        messageDuplicateDeleteGuard: duplicateGuard,
        participantImmunity: {
          consumeForMessage: async () => (immune ? 'granted' : 'not_granted'),
        },
        finishTerminalPreDispatchGuardRejection: jest.fn().mockResolvedValue({
          kind: 'terminal',
          status: 'FAILED_TERMINAL',
          confirmed: false,
        }),
        recordRemoteSuccessAndFinalize: receipt,
      });
      const admission = jest.fn(async () => undefined);
      f.maxClient.deleteMessage.mockImplementation(async (_chat, _message, options) => {
        await options?.beforeImmediateDeleteMutation?.(admission);
        f.remoteDelete();
      });

      await f.service.executeLeasedIntent(f.leased.id, 'lease-1');

      expect(duplicateGuard.assertIntentStillActionable).toHaveBeenCalledWith(
        expect.objectContaining({ authorityOnly: true }),
      );
      expect(duplicateGuard.assertIntentStillActionable).toHaveBeenCalledTimes(2);
      expect(admission).toHaveBeenCalledTimes(1);
      expect(f.remoteDelete).toHaveBeenCalledTimes(allowed ? 1 : 0);
      expect(receipt).toHaveBeenCalledTimes(allowed ? 1 : 0);
      if (allowed)
        expect(receipt).toHaveBeenCalledWith(
          expect.anything(),
          'lease-1',
          'bot-1',
          false,
          [],
          ['length'],
        );
      expect(f.clear).toHaveBeenCalledTimes(allowed ? 0 : 1);
      expect(max.getExactMessageRow).toHaveBeenCalledTimes(1);
      expect(max.getChatMemberAccess).toHaveBeenCalledTimes(1);
    },
  );

  it('does not renew an independent deadline during local duplicate fallback', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const f = initialDuplicateSourceFixture();
      let checks = 0;
      const authorize = jest.fn<
        ReturnType<MessageLimitsDeleteGuardService['authorize']>,
        Parameters<MessageLimitsDeleteGuardService['authorize']>
      >(async () => ({
        reasonKeys: ['length'],
        deadlineAtMs: now + (++checks === 1 ? 100 : 10_000),
      }));
      f.prisma.moderationDeleteIntentReason.findMany.mockResolvedValue([
        { ruleCode: 'MESSAGE_TOO_LONG_DELETE', reasonKey: 'length', metadata: {} },
        {
          ruleCode: 'DUPLICATE_DELETE',
          reasonKey: 'MESSAGE_DUPLICATE:v1:current',
          metadata: { duplicateSource: 'message_v1' },
        },
      ]);
      Object.assign(f.service, {
        messageLimitsDeleteGuard: {
          authorize,
          prepareForDispatch: async (params) => prepareDeleteAuthority(() => authorize(params)),
        } satisfies Pick<MessageLimitsDeleteGuardService, 'authorize' | 'prepareForDispatch'>,
        messageDuplicateDeleteGuard: {
          assertIntentStillActionable: async (
            params: Parameters<
              MessageDuplicateDeleteGuardService['assertIntentStillActionable']
            >[0],
          ) => {
            if (params.authorityOnly) {
              clock.mockReturnValue(now + 100);
              throw new MessageDuplicateGuardRejectedError(
                'message_duplicate_action_authority_revoked',
              );
            }
            return 'allowed';
          },
        } satisfies Pick<MessageDuplicateDeleteGuardService, 'assertIntentStillActionable'>,
        assertVerifiedReasonDeadlineFence: jest.fn().mockResolvedValue(now),
        finishTerminalPreDispatchGuardRejection: jest.fn().mockResolvedValue({
          kind: 'terminal',
          status: 'FAILED_TERMINAL',
          confirmed: false,
        }),
        recordRemoteSuccessAndFinalize: jest.fn(),
      });

      await f.service.executeLeasedIntent(f.leased.id, 'lease-1');

      expect(authorize).toHaveBeenCalledTimes(2);
      expect(f.remoteDelete).not.toHaveBeenCalled();
      expect(f.clear).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  it('reserves DELETE admission after remote guards and before the final deadline and duplicate permits', async () => {
    const f = initialDuplicateSourceFixture();
    const events: string[] = [];
    const leased = { ...f.leased, suggestionSubscriptionId: 'suggestion' };
    const completed = {
      kind: 'confirmed',
      status: 'SUCCEEDED',
      confirmed: true,
      intentId: leased.id,
    };
    f.mark.mockImplementation(async () => {
      events.push('dispatch-marker');
      return true;
    });
    f.maxClient.deleteMessage.mockImplementation(async (_chatId, _messageId, options) => {
      const guard = options?.beforeImmediateDeleteMutation;
      expect(usesMaxFinalAuthorityCheckpoint(guard)).toBe(true);
      await guard?.(async () => {
        events.push('admission');
      });
      events.push('delete');
    });
    const guards = jest.fn(async (...args: unknown[]) => {
      events.push(args[3] ? 'final-remote-guards' : 'initial-remote-guards');
      await (args[5] as (() => Promise<void>) | undefined)?.();
      return {
        profanityVerified: false,
        commercialVerifiedReasonKeys: [],
        messageDuplicateVerified: true,
      };
    });
    const finalDuplicate = jest.fn(async () => {
      events.push('duplicate-authority');
    });
    Object.assign(f.service, {
      loadIntent: jest.fn().mockResolvedValue(leased),
      runDeletePreDispatchGuards: guards,
      suggestionSubscriptions: {
        prepareDeletion: async () => ({ chatId: leased.chatId, messageId: leased.messageId }),
        assertDeletionAllowed: async () => {
          events.push('suggestion-authority');
        },
      },
      assertVerifiedReasonDeadlineFence: jest.fn(async () => {
        events.push('deadline-fence');
        return 0;
      }),
      messageDuplicateDeleteGuard: { assertIntentStillActionable: finalDuplicate },
      recordRemoteSuccessAndFinalize: jest.fn().mockResolvedValue(completed),
    });

    await expect(f.service.executeLeasedIntent(leased.id, 'lease-1')).resolves.toEqual(completed);
    expect(events).toEqual([
      'suggestion-authority',
      'initial-remote-guards',
      'dispatch-marker',
      'final-remote-guards',
      'admission',
      'suggestion-authority',
      'deadline-fence',
      'duplicate-authority',
      'delete',
    ]);
    expect(guards).toHaveBeenCalledTimes(2);
    expect(finalDuplicate).toHaveBeenCalledTimes(1);
    expect(finalDuplicate).toHaveBeenCalledWith(expect.objectContaining({ authorityOnly: true }));
  });

  it('clears its new dispatch marker and retains the original deadline when late DELETE admission is refused', async () => {
    const f = initialDuplicateSourceFixture();
    const originalDeadline = f.leased.retryUntilAt;
    const quota = new MaxApiInternalRateLimitError('Late DELETE admission unavailable', 250);
    const remoteDelete = jest.fn();
    const finalAuthority = jest.fn();
    const retry = jest.fn().mockResolvedValue({
      kind: 'pending',
      status: 'RETRYABLE',
      confirmed: false,
      intentId: f.leased.id,
    });
    Object.assign(f.service, {
      runDeletePreDispatchGuards: jest.fn(async (...args: unknown[]) => {
        await (args[5] as (() => Promise<void>) | undefined)?.();
        return {
          profanityVerified: false,
          commercialVerifiedReasonKeys: [],
          messageDuplicateVerified: true,
        };
      }),
      assertVerifiedReasonDeadlineFence: finalAuthority,
      finishRetryableAttempt: retry,
    });
    f.maxClient.deleteMessage.mockImplementation(async (_chatId, _messageId, options) => {
      expect(usesMaxFinalAuthorityCheckpoint(options?.beforeImmediateDeleteMutation)).toBe(true);
      await options?.beforeImmediateDeleteMutation?.(async () => {
        expect(f.mark).toHaveBeenCalledTimes(1);
        throw quota;
      });
      remoteDelete();
    });

    await expect(f.service.executeLeasedIntent(f.leased.id, 'lease-1')).resolves.toMatchObject({
      confirmed: false,
      status: 'RETRYABLE',
    });
    expect(f.clear).toHaveBeenCalledTimes(1);
    expect(f.clear).toHaveBeenCalledWith(f.leased.id, 'lease-1', 'bot-1');
    expect(f.leased.deleteDispatchStartedAt).toBeNull();
    expect(f.leased.deleteDispatchStartedBotId).toBeNull();
    expect(f.leased.retryUntilAt).toBe(originalDeadline);
    expect(finalAuthority).not.toHaveBeenCalled();
    expect(remoteDelete).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    'keeps DELETE and receipt order when metrics fail (duplicate owner: %s)',
    async (messageDuplicateOwned) => {
      const events: string[] = [];
      const leased = {
        ...baseIntent,
        messageDuplicateOwned,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      };
      const { service, maxClient } = createService();
      const expected = {
        kind: 'confirmed',
        status: 'SUCCEEDED',
        confirmed: true,
        intentId: leased.id,
      };
      const recordPhase = jest.fn(() => {
        throw new Error('observer unavailable');
      });
      maxClient.deleteMessage.mockImplementation(async (_chatId, _messageId, options) => {
        events.push('admission');
        await options?.beforeImmediateDeleteMutation?.();
        events.push('delete');
      });
      Object.assign(service, {
        duplicateMetrics: { recordPhase },
        loadIntent: jest.fn().mockResolvedValue(leased),
        startLeaseHeartbeat: () => ({ ...ownedHeartbeat, hasRemainingBudget: () => true }),
        assertLeaseForExternalCall: jest.fn(),
        finishProtectedManagedBotMessageAutoDelete: jest.fn().mockResolvedValue(null),
        resolveDeleteRouteWithRefresh: jest.fn().mockResolvedValue(confirmedRoute),
        filterAndOrderRouteCandidates: () => ['bot-1'],
        recordAttemptBot: jest.fn().mockResolvedValue(true),
        markDeleteDispatchStarted: async () => {
          events.push('marker');
          return true;
        },
        runDeletePreDispatchGuards: async () => {
          events.push('guard');
          return {
            profanityVerified: false,
            commercialVerifiedReasonKeys: [],
            messageDuplicateVerified: messageDuplicateOwned,
          };
        },
        messageDuplicateDeleteGuard: {
          assertIntentStillActionable: async () => {
            events.push('authority');
          },
        },
        recordRemoteSuccessAndFinalize: async () => {
          events.push('receipt');
          return expected;
        },
      });
      await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toEqual(expected);
      expect(events).toEqual([
        'admission',
        'guard',
        'marker',
        'guard',
        ...(messageDuplicateOwned ? ['authority'] : []),
        'delete',
        'receipt',
      ]);
      if (messageDuplicateOwned) {
        expect(recordPhase).toHaveBeenNthCalledWith(1, 'delete_dispatch', expect.any(Number));
        expect(recordPhase).toHaveBeenNthCalledWith(2, 'delete_receipt', expect.any(Number));
      } else expect(recordPhase).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'checks short independent authority after the last awaited guard (expired: %s)',
    async (expired) => {
      const now = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
      try {
        const leased = {
          ...baseIntent,
          suggestionSubscriptionId: 'suggestion',
          leaseExpiresAt: new Date(now + 60_000),
        };
        const { service, maxClient } = createService(
          {},
          { $executeRaw: jest.fn().mockResolvedValue(expired ? 0 : 1) },
        );
        const remoteDelete = jest.fn();
        maxClient.deleteMessage.mockImplementation(async (_chatId, _messageId, options) => {
          await options?.beforeImmediateDeleteMutation?.();
          remoteDelete();
        });
        const cleared = jest.fn().mockResolvedValue(true);
        const terminal = jest.fn().mockResolvedValue({
          kind: 'terminal',
          status: 'FAILED_TERMINAL',
          confirmed: false,
          intentId: leased.id,
        });
        let checkedAfterProof = false;
        Object.assign(service, {
          loadIntent: jest.fn().mockResolvedValue(leased),
          startLeaseHeartbeat: () => ({ ...ownedHeartbeat, hasRemainingBudget: () => true }),
          assertLeaseForExternalCall: jest.fn(),
          finishProtectedManagedBotMessageAutoDelete: jest.fn().mockResolvedValue(null),
          resolveDeleteRouteWithRefresh: jest.fn().mockResolvedValue(confirmedRoute),
          filterAndOrderRouteCandidates: () => ['bot-1'],
          recordAttemptBot: jest.fn().mockResolvedValue(true),
          markDeleteDispatchStarted: jest.fn().mockResolvedValue(true),
          clearDeleteDispatchStarted: cleared,
          finishTerminalPreDispatchGuardRejection: terminal,
          runDeletePreDispatchGuards: async (
            _intent: unknown,
            _bot: string,
            _options: unknown,
            leaseToken?: string,
          ) => {
            if (leaseToken) checkedAfterProof = true;
            return {
              profanityVerified: false,
              commercialVerifiedReasonKeys: [],
              messageDuplicateVerified: false,
              independentAuthorityDeadlineAtMs: now + 100,
              guardedReasonFingerprint: 'a'.repeat(64),
            };
          },
          suggestionSubscriptions: {
            prepareDeletion: async () => ({
              chatId: leased.chatId,
              messageId: leased.messageId,
            }),
            assertDeletionAllowed: async () => {
              if (checkedAfterProof) clock.mockReturnValue(now + (expired ? 100 : 99));
            },
          },
          recordRemoteSuccessAndFinalize: jest.fn().mockResolvedValue({
            kind: 'confirmed',
            status: 'SUCCEEDED',
            confirmed: true,
            intentId: leased.id,
          }),
        });
        await service.executeLeasedIntent(leased.id, 'lease-1');
        expect(checkedAfterProof).toBe(true);
        expect(remoteDelete).toHaveBeenCalledTimes(expired ? 0 : 1);
        expect(cleared).toHaveBeenCalledTimes(expired ? 1 : 0);
        expect(terminal).toHaveBeenCalledTimes(expired ? 1 : 0);
        if (expired)
          expect(terminal).toHaveBeenCalledWith(
            expect.anything(),
            'lease-1',
            expect.objectContaining({
              errorCode: 'moderation_delete_reasons_no_longer_authorized',
            }),
            expect.objectContaining({ reasonFingerprint: 'a'.repeat(64) }),
          );
      } finally {
        clock.mockRestore();
      }
    },
  );

  it.each(['longer-state', 'unbounded-content', 'duplicate-final'] as const)(
    'keeps an expired rule out of the receipt with %s authority at the last boundary',
    async (authority) => {
      const now = Date.now();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
      try {
        const leased = {
          ...baseIntent,
          activeMuteDeleteReason: authority !== 'unbounded-content',
          leaseExpiresAt: new Date(now + 60_000),
        };
        const events: string[] = [];
        const staleKey = authority === 'unbounded-content' ? 'burst' : 'mute';
        const validKey = authority === 'unbounded-content' ? 'length' : 'global';
        const reasons = [
          {
            ruleCode:
              authority === 'unbounded-content'
                ? 'MESSAGE_RATE_LIMIT_DELETE'
                : 'MUTE_ACTIVE_DELETE',
            reasonKey: staleKey,
          },
          ...(authority === 'duplicate-final'
            ? [{ ruleCode: 'DUPLICATE_DELETE', reasonKey: 'MESSAGE_DUPLICATE:v1:current' }]
            : [
                {
                  ruleCode:
                    authority === 'unbounded-content'
                      ? 'MESSAGE_TOO_LONG_DELETE'
                      : 'GLOBAL_SPAMMER_MESSAGE_DELETE',
                  reasonKey: validKey,
                },
              ]),
        ];
        const queryRaw = jest.fn(async (query: { strings?: readonly string[] }) => {
          const sql = query.strings?.join('?') ?? '';
          expect(sql).toContain('"lease_expires_at" > (clock_timestamp() AT TIME ZONE \'UTC\')');
          expect(sql).toContain('"delete_dispatch_started_bot_id" =');
          expect(sql).toContain(
            'RETURNING (clock_timestamp() AT TIME ZONE \'UTC\') AS "verifiedReasonAuthorityAt"',
          );
          events.push('database-clock');
          // The database may run ahead of the local clock. Only the duplicate-final case
          // expires during the last MAX authority check after this SQL fence.
          return [
            {
              verifiedReasonAuthorityAt: new Date(
                now + (authority === 'duplicate-final' ? 0 : 100),
              ),
              verifiedReasonLeaseExpiresAt: leased.leaseExpiresAt,
            },
          ];
        });
        const { service, maxClient } = createService(
          {},
          {
            $queryRaw: queryRaw,
            moderationDeleteIntentReason: { findMany: jest.fn().mockResolvedValue(reasons) },
          },
        );
        const composed = (
          service as unknown as ServiceInternals
        ).authorizeGuardedUserDeleteReasons.bind(service);
        const remoteDelete = jest.fn(() => events.push('delete'));
        maxClient.deleteMessage.mockImplementation(async (_chatId, _messageId, options) => {
          await options?.beforeImmediateDeleteMutation?.();
          remoteDelete();
        });
        const receipt = jest.fn().mockResolvedValue({
          kind: 'confirmed',
          status: 'SUCCEEDED',
          confirmed: true,
          intentId: leased.id,
        });
        const finitePermit = {
          reasonKeys: authority === 'duplicate-final' ? [staleKey] : [staleKey, validKey],
          ...(authority === 'unbounded-content'
            ? {}
            : { deadlineAtMs: now + (authority === 'duplicate-final' ? 100 : 10_000) }),
          reasonDeadlines: [
            { reasonKey: staleKey, deadlineAtMs: now + 100 },
            ...(authority === 'longer-state'
              ? [{ reasonKey: validKey, deadlineAtMs: now + 10_000 }]
              : []),
          ],
        };
        Object.assign(service, {
          loadIntent: jest.fn().mockResolvedValue(leased),
          startLeaseHeartbeat: () => ({ ...ownedHeartbeat, hasRemainingBudget: () => true }),
          assertLeaseForExternalCall: jest.fn(),
          finishProtectedManagedBotMessageAutoDelete: jest.fn().mockResolvedValue(null),
          resolveDeleteRouteWithRefresh: jest.fn().mockResolvedValue(confirmedRoute),
          filterAndOrderRouteCandidates: () => ['bot-1'],
          recordAttemptBot: jest.fn().mockResolvedValue(true),
          markDeleteDispatchStarted: jest.fn().mockResolvedValue(true),
          runDeletePreDispatchGuards: async (
            _intent: unknown,
            _bot: string,
            _options: unknown,
            leaseToken?: string,
          ) =>
            leaseToken
              ? composed(leased, 'bot-1', leaseToken)
              : { profanityVerified: false, commercialVerifiedReasonKeys: [] },
          messageLimitsDeleteGuard: messageLimitsGuardFixture(async () => finitePermit),
          moderationStateDeleteGuard: stateGuardFixture(async () => ({
            ...finitePermit,
            deadlineAtMs: finitePermit.deadlineAtMs ?? now + 10_000,
          })),
          messageDuplicateDeleteGuard: {
            assertIntentStillActionable: jest.fn(async (params: { authorityOnly?: boolean }) => {
              if (params.authorityOnly) {
                events.push('duplicate-final');
                clock.mockReturnValue(now + 100);
              }
              return 'allowed';
            }),
          },
          recordRemoteSuccessAndFinalize: receipt,
        });
        const result = await service.executeLeasedIntent(leased.id, 'lease-1');
        const expectedKeys = authority === 'duplicate-final' ? [] : [validKey];
        expect(receipt).toHaveBeenCalledWith(
          expect.anything(),
          'lease-1',
          'bot-1',
          false,
          [],
          expectedKeys,
        );
        expect(remoteDelete).toHaveBeenCalledTimes(1);
        expect(events).toEqual([
          'database-clock',
          ...(authority === 'duplicate-final' ? ['duplicate-final'] : []),
          'delete',
        ]);
        if (expectedKeys.length) expect(result).toHaveProperty('verifiedReasonKeys', expectedKeys);
        else expect(result).not.toHaveProperty('verifiedReasonKeys');
      } finally {
        clock.mockRestore();
      }
    },
  );

  it('binds suggestion cleanup to fresh subscription proof before and after the DELETE budget', async () => {
    const events: string[] = [];
    const leased = {
      ...baseIntent,
      suggestionSubscriptionId: 'suggestion',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    };
    const { service, maxClient } = createService({ MODERATION_DELETE_INTENT_MODE: 'off' });
    maxClient.deleteMessage.mockImplementation(async (_chatId, _messageId, options) => {
      events.push('delete-budget');
      await options?.beforeImmediateDeleteMutation?.();
    });
    Object.assign(service, {
      loadIntent: jest.fn().mockResolvedValue(leased),
      startLeaseHeartbeat: () => ownedHeartbeat,
      assertLeaseForExternalCall: jest.fn(),
      finishProtectedManagedBotMessageAutoDelete: jest.fn().mockResolvedValue(null),
      resolveDeleteRouteWithRefresh: jest.fn().mockResolvedValue(confirmedRoute),
      filterAndOrderRouteCandidates: () => ['bot-1'],
      recordAttemptBot: jest.fn().mockResolvedValue(true),
      markDeleteDispatchStarted: jest.fn().mockResolvedValue(true),
      runDeletePreDispatchGuards: jest
        .fn()
        .mockResolvedValue({ profanityVerified: false, commercialVerifiedReasonKeys: [] }),
      suggestionSubscriptions: {
        prepareDeletion: async () => {
          events.push('prepare');
          return { chatId: leased.chatId, messageId: leased.messageId };
        },
        assertDeletionAllowed: async () => {
          events.push('final');
        },
      },
      recordRemoteSuccessAndFinalize: jest.fn().mockResolvedValue({
        kind: 'confirmed',
        status: 'SUCCEEDED',
        confirmed: true,
        intentId: leased.id,
      }),
    });
    await service.executeLeasedIntent('intent-1', 'lease-1');
    expect(events).toEqual(['prepare', 'delete-budget', 'final', 'final']);
  });
  it('prepares retention remote evidence before the DELETE budget and keeps final checks local', async () => {
    const events: string[] = [];
    const leased = {
      ...baseIntent,
      retentionOwned: true,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    };
    const { service, maxClient } = createService({ MESSAGE_RETENTION_MODE: 'on' });
    maxClient.deleteMessage.mockImplementation(async (_chatId, _messageId, options) => {
      events.push('delete-budget');
      await options?.beforeImmediateDeleteMutation?.();
    });
    Object.assign(service, {
      loadIntent: jest.fn().mockResolvedValue(leased),
      startLeaseHeartbeat: () => ownedHeartbeat,
      assertLeaseForExternalCall: jest.fn(),
      finishProtectedManagedBotMessageAutoDelete: jest.fn().mockResolvedValue(null),
      resolveDeleteRouteWithRefresh: jest.fn().mockResolvedValue(confirmedRoute),
      filterAndOrderRouteCandidates: () => ['bot-1'],
      recordAttemptBot: jest.fn().mockResolvedValue(true),
      markDeleteDispatchStarted: jest.fn().mockResolvedValue(true),
      messageRetentionGuard: {
        assertAllowed: async (_id: string, _bot: string, phase: string) => {
          events.push(phase);
        },
      },
      recordRemoteSuccessAndFinalize: jest.fn().mockResolvedValue({
        kind: 'confirmed',
        status: 'SUCCEEDED',
        confirmed: true,
        intentId: 'intent-1',
      }),
    });
    await service.executeLeasedIntent('intent-1', 'lease-1');
    expect(events).toEqual(['prepare', 'delete-budget', 'dispatch', 'dispatch']);
  });
  it('never lets a retention worker execute ordinary moderation after ownership changes', () => {
    const previous = process.env.APP_ROLE;
    try {
      process.env.APP_ROLE = 'message-retention';
      const { service } = createService({ MESSAGE_RETENTION_MODE: 'on' });
      const internal = service as unknown as {
        isExecutionEnabledForIntent(intent: unknown): boolean;
      };
      expect(internal.isExecutionEnabledForIntent({ ...baseIntent, retentionOwned: true })).toBe(
        true,
      );
      expect(internal.isExecutionEnabledForIntent({ ...baseIntent, retentionOwned: false })).toBe(
        false,
      );
      process.env.APP_ROLE = 'action';
      expect(internal.isExecutionEnabledForIntent({ ...baseIntent, retentionOwned: true })).toBe(
        false,
      );
      expect(internal.isExecutionEnabledForIntent({ ...baseIntent, retentionOwned: false })).toBe(
        true,
      );
    } finally {
      if (previous === undefined) delete process.env.APP_ROLE;
      else process.env.APP_ROLE = previous;
    }
  });

  it('keeps retention out of the critical sweeper and critical wakeup queue', async () => {
    const { service, prisma, queue } = createService();
    const internal = service as unknown as ServiceInternals;
    await internal.selectDueIntentIds();
    expect(prisma.$queryRaw.mock.calls[0]?.[0]?.strings?.join('?')).toContain(
      'intent."retention_owned" = FALSE',
    );
    await internal.enqueueWakeup({ ...baseIntent, retentionOwned: true });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it.each(['SLOW_MODE_DELETE', 'MEDIA_RATE_LIMIT_DELETE', 'STICKER_BLOCKED_DELETE'])(
    'keeps %s on guarded durable execution when the legacy rollout is off',
    (ruleCode) => {
      const { service } = createService({ MODERATION_DELETE_INTENT_MODE: 'off' });
      expect(service.getRolloutForRule('chat-1', ruleCode)).toBe('execute');
      expect(service.getRolloutForRule('chat-1', 'MESSAGE_COUNT_LIMIT_DELETE')).toBe('execute');
    },
  );
  function boundMessageInput(): EnsureModerationDeleteIntentInput {
    const timestamp = Date.now() - 1000;
    return {
      chatId: 'chat-1',
      messageId: 'message-1',
      subjectUserId: 'user-1',
      originBotId: 'bot-1',
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      ruleCode: 'DUPLICATE_DELETE',
      reasonKey: `MESSAGE_DUPLICATE:v1:${timestamp}`,
      retryUntilAt: new Date(Date.now() + 60000),
      event: {
        metadata: {
          duplicateSource: 'message_v1',
          enforcementScope: 'full',
          messageDuplicate: {
            version: 2,
            senderId: 'user-1',
            messageId: 'message-1',
            eventTimestampMs: timestamp,
            controlRevision: 2,
            settingsDigest: 'a'.repeat(64),
            sourceDigest: 'b'.repeat(64),
            contentDigest: 'c'.repeat(64),
            fingerprint: 'd'.repeat(64),
            compareMode: 'MESSAGE',
            mediaHashes: [],
            mediaVersion: MESSAGE_DUPLICATE_MEDIA_VERSION,
            hasPhotos: false,
            photoControlRevision: null,
            windowSeconds: 3600,
            requiredCount: 2,
          },
        },
      },
    };
  }

  it('routes strictly bound message duplicates independently of the base canary without promoting legacy deletes', () => {
    const { service } = createService({
      MODERATION_DELETE_INTENT_MODE: 'canary',
      MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: 'other-chat',
    });
    const input = boundMessageInput();
    expect(service.getRolloutForInput(input)).toBe('execute');
    expect(service.getRolloutForInput({ ...input, reasonKey: 'DUPLICATE:legacy' })).toBe(
      'observed',
    );
    expect(
      service.getRolloutForInput({
        ...input,
        event: { metadata: { duplicateSource: 'message_v1' } },
      }),
    ).toBe('observed');
    expect(service.getRolloutForRule('chat-1', 'DUPLICATE_DELETE')).toBe('observed');
    expect(service.getRolloutForRule('chat-1', 'LINK_BLOCKED_DELETE')).toBe('execute');
    expect(
      (service as unknown as ServiceInternals).isExecutionEnabledForIntent({
        chatId: 'chat-1',
        messageDuplicateOwned: true,
      }),
    ).toBe(true);
    const filter = (
      service as unknown as { buildSweepRolloutFilter(): Prisma.Sql }
    ).buildSweepRolloutFilter();
    expect(filter.sql).toContain('message_duplicate_reason."intent_id" = intent."id"');
    expect(filter.sql).toContain("'MESSAGE_DUPLICATE:%'");
  });

  it('preserves metadata-bound independent scopes when report authority is revoked', () => {
    const { service } = createService({
      MODERATION_DELETE_INTENT_MODE: 'off',
      COMMERCIAL_OCR_ROLLOUT_MODE: 'off',
      IMAGE_TEXT_STOP_LIST_OCR_ROLLOUT_MODE: 'on',
    });
    const classify = service as unknown as {
      hasExecutableIndependentReportReason(
        chatId: string,
        reasons: Array<{ ruleCode: string; reasonKey: string; metadata: unknown }>,
      ): boolean;
    };
    for (const input of [boundMessageInput(), imageTextStopListClaimedIntentInput().intent]) {
      expect(
        classify.hasExecutableIndependentReportReason(input.chatId, [
          {
            ruleCode: input.ruleCode!,
            reasonKey: input.reasonKey,
            metadata: input.event?.metadata,
          },
        ]),
      ).toBe(true);
    }
    expect(
      classify.hasExecutableIndependentReportReason('chat-1', [
        { ruleCode: 'DUPLICATE_DELETE', reasonKey: 'DUPLICATE:legacy', metadata: {} },
      ]),
    ).toBe(false);
    expect(
      classify.hasExecutableIndependentReportReason('chat-1', [
        { ruleCode: 'ANTI_SPAM', reasonKey: 'ANTI_SPAM', metadata: {} },
      ]),
    ).toBe(false);
  });
  it('persists and schedules a bound duplicate outside the base canary as executable', async () => {
    const persisted = {
      ...baseIntent,
      status: 'PENDING',
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const transaction = jest.fn(async (callback: (tx: unknown) => unknown) =>
      callback({
        $queryRaw: jest.fn().mockResolvedValue([persisted]),
        $executeRaw: jest.fn().mockResolvedValue(1),
      }),
    );
    const { service, queue } = createService(
      {
        MODERATION_DELETE_INTENT_MODE: 'canary',
        MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: 'other-chat',
      },
      { $transaction: transaction },
    );
    await expect(service.ensureIntent(boundMessageInput())).resolves.toEqual({
      intentId: 'intent-1',
      rollout: 'execute',
      status: 'PENDING',
    });
    expect(queue.add).toHaveBeenCalledWith(
      'execute-moderation-delete-intent',
      { intentId: 'intent-1' },
      expect.anything(),
    );
  });
  it.each([false, true])(
    'requires the new message guard at the final dispatch boundary (available=%s)',
    async (available) => {
      const intent = { ...baseIntent, messageDuplicateOwned: true };
      const events: string[] = [];
      const remoteDelete = jest.fn(async () => {
        events.push('delete');
      });
      const { service } = createService(
        {
          MODERATION_DELETE_INTENT_MODE: 'canary',
          MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: 'other-chat',
        },
        {
          $queryRaw: jest
            .fn()
            .mockResolvedValueOnce([intent])
            .mockResolvedValueOnce([{ ...intent, status: 'SUCCEEDED' }]),
          $executeRaw: jest.fn().mockResolvedValue(1),
        },
        { deleteMessage: remoteDelete },
        { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
      );
      if (available)
        Object.defineProperty(service, 'messageDuplicateDeleteGuard', {
          value: {
            assertIntentStillActionable: jest.fn(async () => {
              events.push('guard');
              return 'allowed';
            }),
          },
        });
      if (available) await service.executeLeasedIntent('intent-1', 'lease-1');
      else
        await expect(service.executeLeasedIntent('intent-1', 'lease-1')).rejects.toThrow(
          'Message duplicate delete guard unavailable',
        );
      expect(events).toEqual(available ? ['guard', 'guard', 'delete'] : []);
      expect(remoteDelete).toHaveBeenCalledTimes(available ? 1 : 0);
    },
  );

  it.each(
    [
      'message_duplicate_history_changed',
      'message_duplicate_author_not_member',
      'message_duplicate_policy_changed',
    ].flatMap((code) => [false, true].map((mixed) => ({ code, mixed }))),
  )(
    'ends a rejected message duplicate ($code, mixed=$mixed) without resurrecting its own reason',
    async ({ code, mixed }) => {
      const intent = {
        ...baseIntent,
        messageDuplicateOwned: true,
        nonCommercialOcrDeleteReason: mixed,
      };
      const executeRaw = jest.fn().mockResolvedValue(1);
      const txQueryRaw = jest
        .fn()
        .mockResolvedValueOnce([{ id: intent.id }])
        .mockResolvedValueOnce([intent]);
      const remoteDelete = jest.fn();
      const { service, queue } = createService(
        {},
        {
          $queryRaw: jest.fn().mockResolvedValueOnce([intent]),
          $executeRaw: executeRaw,
          $transaction: jest.fn(async (callback: (tx: unknown) => unknown) =>
            callback({
              $queryRaw: txQueryRaw,
              $executeRaw: executeRaw,
            }),
          ),
        },
        { deleteMessage: remoteDelete },
        { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
      );
      Object.defineProperty(service, 'messageDuplicateDeleteGuard', {
        value: {
          assertIntentStillActionable: jest
            .fn()
            .mockRejectedValue(new MessageDuplicateGuardRejectedError(code)),
        },
      });
      await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
        kind: 'terminal',
        status: 'FAILED_TERMINAL',
      });
      expect(remoteDelete).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
      expect(txQueryRaw.mock.calls[0]?.[0].strings.join('?')).toContain('FOR UPDATE');
      expect(
        executeRaw.mock.calls.some(([query]) =>
          query.strings?.join('?').includes('"delete_dispatch_started_at" = NULL'),
        ),
      ).toBe(true);
    },
  );

  afterEach(() => {
    jest.useRealTimers();
  });

  it('rechecks exact access-ambiguous DELETE and source SEND ledger rows under locks', async () => {
    const expected = accessAmbiguousLedgerEvidence();
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([accessAmbiguousDeleteRow()])
      .mockResolvedValueOnce([accessAmbiguousSourceSendRow()]);
    const { service } = createService();

    await expect(
      (service as unknown as ServiceInternals).assertAccessAmbiguousLedgerEvidenceUnchanged(
        { $queryRaw: queryRaw },
        expected,
      ),
    ).resolves.toBeUndefined();

    expect(queryRaw).toHaveBeenCalledTimes(2);
    for (const [query] of queryRaw.mock.calls) {
      expect((query as { strings?: readonly string[] }).strings?.join('?')).toContain('FOR UPDATE');
    }

    const changedSource = jest
      .fn()
      .mockResolvedValueOnce([accessAmbiguousDeleteRow()])
      .mockResolvedValueOnce([{ ...accessAmbiguousSourceSendRow(), status: 'FAILED_RETRYABLE' }]);
    await expect(
      (service as unknown as ServiceInternals).assertAccessAmbiguousLedgerEvidenceUnchanged(
        { $queryRaw: changedSource },
        expected,
      ),
    ).rejects.toMatchObject({ code: 'access_ambiguous_ledger_conflict' });
  });

  it('atomically acknowledges a successful access-ambiguous operator handoff with audit', async () => {
    const expected = accessAmbiguousLedgerEvidence();
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([accessAmbiguousDeleteRow()])
      .mockResolvedValueOnce([accessAmbiguousSourceSendRow()])
      .mockResolvedValueOnce([{ id: expected.deleteLedgerId }]);
    const auditCreate = jest.fn().mockResolvedValue({ id: 'audit-1' });
    const transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ $queryRaw: queryRaw, auditLog: { create: auditCreate } }),
    );
    const { service } = createService({}, { $transaction: transaction });

    await expect(
      service.acknowledgeBotMessageAutoDeleteAccessAmbiguousHandoff(expected, {
        actorUserId: ' operator-1 ',
        result: 'already_absent',
        intentId: null,
      }),
    ).resolves.toBeUndefined();

    expect(queryRaw).toHaveBeenCalledTimes(3);
    const update = queryRaw.mock.calls[2]?.[0] as { values?: readonly unknown[] };
    expect(update.values).toContain('send_auto_delete_access_ambiguous_operator_handoff');
    expect(auditCreate).toHaveBeenCalledWith({
      data: {
        chatId: 'chat-1',
        actorUserId: 'operator-1',
        action: 'OPERATOR_ACK_AUTO_DELETE_ACCESS_AMBIGUOUS_HANDOFF',
        payload: expect.objectContaining({
          evidenceSource: BOT_MESSAGE_AUTO_DELETE_ACCESS_AMBIGUOUS_LEDGER_EVIDENCE_SOURCE,
          evidenceVersion: BOT_MESSAGE_AUTO_DELETE_ACCESS_AMBIGUOUS_LEDGER_EVIDENCE_VERSION,
          deleteLedgerId: 'delete-ledger-1',
          sourceSendLedgerId: 'send-ledger-1',
          result: 'already_absent',
          intentId: null,
        }),
      },
    });
  });

  it('atomically creates and audits a missing BOT_MESSAGE_AUTO_DELETE repair intent', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-31T12:01:00.000Z'));
    const input = botMessageAutoDeleteRepairIntentInput();
    const persisted = {
      ...baseIntent,
      id: 'repair-intent-1',
      chatId: input.chatId,
      messageId: input.messageId,
      subjectUserId: input.subjectUserId,
      sourceMessageAt: input.sourceMessageAt,
      entityType: 'CHAT',
      messageAuthorKind: 'bot',
      originBotId: 'bot-1',
      routingPolicy: 'origin_only',
      status: 'PENDING' as const,
      executeAt: input.executeAt as Date,
      nextAttemptAt: input.executeAt as Date,
      retryUntilAt: input.retryUntilAt as Date,
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const verified = {
      ...persisted,
      botMessageAutoDeleteReason: true,
      botMessageAutoDeleteOnly: true,
      requiredSubscriptionDeleteReason: false,
      replacementCleanup: false,
      commercialOcrDeleteReason: false,
      nonCommercialOcrDeleteReason: true,
    };
    const txQueryRaw = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([persisted])
      .mockResolvedValueOnce([verified]);
    const txExecuteRaw = jest.fn().mockResolvedValue(1);
    const auditCreate = jest.fn().mockResolvedValue({ id: 'audit-1' });
    const transaction = jest.fn(
      async (
        callback: (tx: unknown) => Promise<unknown>,
        _options: { isolationLevel: Prisma.TransactionIsolationLevel },
      ) =>
        callback({
          $queryRaw: txQueryRaw,
          $executeRaw: txExecuteRaw,
          auditLog: { create: auditCreate },
        }),
    );
    const { service, queue } = createService({}, { $transaction: transaction });

    await expect(
      service.ensureBotMessageAutoDeleteRepairIntentWithAudit(input, {
        actorUserId: ' operator-1 ',
        auditPayload: {
          claimId: 'claim-1',
          exactPresence: 'present',
          repairVersion: 99,
          evidenceVersion: 2,
          intentId: 'caller-cannot-override',
        },
      }),
    ).resolves.toEqual({
      created: true,
      intentId: 'repair-intent-1',
      rollout: 'execute',
      status: 'PENDING',
    });

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(txQueryRaw).toHaveBeenCalledTimes(3);
    expect(txExecuteRaw).toHaveBeenCalledTimes(1);
    expect(auditCreate).toHaveBeenCalledWith({
      data: {
        chatId: 'chat-1',
        actorUserId: 'operator-1',
        action: BOT_MESSAGE_AUTO_DELETE_REPAIR_INTENT_AUDIT_ACTION,
        payload: expect.objectContaining({
          claimId: 'claim-1',
          exactPresence: 'present',
          repairVersion: 1,
          evidenceVersion: 2,
          repairKind: 'legacy_missing_intent',
          intentId: 'repair-intent-1',
          messageId: 'message-1',
          ruleCode: 'BOT_MESSAGE_AUTO_DELETE',
          originBotId: 'bot-1',
        }),
      },
    });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('atomically fences current policy and audits an explicit operator cleanup', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-31T12:01:00.000Z'));
    const input = explicitOperatorCleanupIntentInput();
    const persisted = {
      ...baseIntent,
      id: 'explicit-cleanup-intent-1',
      chatId: input.chatId,
      messageId: input.messageId,
      subjectUserId: input.subjectUserId,
      sourceMessageAt: input.sourceMessageAt,
      entityType: 'CHAT',
      messageAuthorKind: 'bot',
      originBotId: 'bot-1',
      routingPolicy: 'origin_only',
      status: 'PENDING' as const,
      executeAt: input.executeAt as Date,
      nextAttemptAt: input.executeAt as Date,
      retryUntilAt: input.retryUntilAt as Date,
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const verified = {
      ...persisted,
      botMessageAutoDeleteReason: true,
      botMessageAutoDeleteOnly: true,
      requiredSubscriptionDeleteReason: false,
      replacementCleanup: false,
      commercialOcrDeleteReason: false,
      nonCommercialOcrDeleteReason: true,
    };
    const policy = {
      settingsId: 'settings-1',
      chatId: 'chat-1',
      deleteBotMessagesEnabled: true,
      deleteBotMessagesDelayMinutes: 2,
      createdAt: new Date('2026-08-31T11:00:00.000Z'),
      updatedAt: new Date('2026-08-31T12:00:30.000Z'),
    };
    const expectedPolicy = {
      ...policy,
      deleteBotMessagesEnabled: true as const,
      sendJobCreatedAt: new Date('2026-08-31T11:59:59.000Z'),
    };
    const txQueryRaw = jest
      .fn()
      .mockResolvedValueOnce([policy])
      .mockResolvedValueOnce([explicitOperatorCleanupSendRow()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([persisted])
      .mockResolvedValueOnce([verified]);
    const txExecuteRaw = jest.fn().mockResolvedValue(1);
    const auditCreate = jest.fn().mockResolvedValue({ id: 'audit-1' });
    const transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $queryRaw: txQueryRaw,
        $executeRaw: txExecuteRaw,
        auditLog: { create: auditCreate },
      }),
    );
    const { service, queue } = createService({}, { $transaction: transaction });

    await expect(
      service.ensureBotMessageAutoDeleteRepairIntentWithAudit(input, {
        kind: 'explicit_operator_cleanup',
        actorUserId: ' operator-1 ',
        operatorReason: ' user-complaint-retroactive-cleanup ',
        expectedPolicy,
        expectedSend: explicitOperatorCleanupExpectedSend(),
        auditPayload: {
          evidenceSource: 'caller-cannot-override',
          evidenceVersion: 99,
          sendLedgerAutoDeleteDelayMs: 120_000,
          sendLedgerId: 'send-ledger-1',
        },
      }),
    ).resolves.toEqual({
      created: true,
      intentId: 'explicit-cleanup-intent-1',
      rollout: 'execute',
      status: 'PENDING',
    });

    const policyQuery = txQueryRaw.mock.calls[0]?.[0] as { strings?: readonly string[] };
    expect(policyQuery.strings?.join('?')).toContain('FROM "chat_settings"');
    expect(policyQuery.strings?.join('?')).toContain('FOR UPDATE');
    expect(txQueryRaw).toHaveBeenCalledTimes(6);
    expect(txQueryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      txExecuteRaw.mock.invocationCallOrder[0],
    );
    expect(auditCreate).toHaveBeenCalledWith({
      data: {
        chatId: 'chat-1',
        actorUserId: 'operator-1',
        action: BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_INTENT_AUDIT_ACTION,
        payload: expect.objectContaining({
          repairVersion: 1,
          repairKind: 'explicit_operator_cleanup',
          evidenceSource: 'explicit_operator_cleanup',
          evidenceVersion: 5,
          operatorReason: 'user-complaint-retroactive-cleanup',
          policySettingsId: 'settings-1',
          policyEnabled: true,
          policyDelayMinutes: 2,
          policyCreatedAt: '2026-08-31T11:00:00.000Z',
          policyUpdatedAt: '2026-08-31T12:00:30.000Z',
          sendJobCreatedAt: '2026-08-31T11:59:59.000Z',
          sendLedgerId: 'send-ledger-1',
          sendLedgerJobId: 'send-job-1',
          sendLedgerStatus: 'SUCCEEDED',
          sendLedgerSourceTag: 'moderation_notice',
          sendLedgerDispatchBotId: 'bot-1',
          sendLedgerAutoDeleteDelayMs: null,
          intentId: 'explicit-cleanup-intent-1',
        }),
      },
    });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rejects an explicit cleanup policy CAS mismatch before intent persistence or audit', async () => {
    const input = explicitOperatorCleanupIntentInput();
    const expectedPolicy = {
      settingsId: 'settings-1',
      chatId: 'chat-1',
      deleteBotMessagesEnabled: true as const,
      deleteBotMessagesDelayMinutes: 2,
      createdAt: new Date('2026-08-31T11:00:00.000Z'),
      updatedAt: new Date('2026-08-31T12:00:30.000Z'),
      sendJobCreatedAt: new Date('2026-08-31T11:59:59.000Z'),
    };
    const txQueryRaw = jest.fn().mockResolvedValueOnce([
      {
        ...expectedPolicy,
        deleteBotMessagesEnabled: false,
      },
    ]);
    const txExecuteRaw = jest.fn();
    const auditCreate = jest.fn();
    const transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $queryRaw: txQueryRaw,
        $executeRaw: txExecuteRaw,
        auditLog: { create: auditCreate },
      }),
    );
    const { service, queue } = createService({}, { $transaction: transaction });

    await expect(
      service.ensureBotMessageAutoDeleteRepairIntentWithAudit(input, {
        kind: 'explicit_operator_cleanup',
        actorUserId: 'operator-1',
        operatorReason: 'user-complaint-retroactive-cleanup',
        expectedPolicy,
        expectedSend: explicitOperatorCleanupExpectedSend(),
        auditPayload: { sendLedgerId: 'send-ledger-1' },
      }),
    ).rejects.toBeInstanceOf(BotMessageAutoDeleteExplicitCleanupPolicyConflictError);

    expect(txQueryRaw).toHaveBeenCalledTimes(1);
    expect(txExecuteRaw).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rejects a DELETE ledger owner that appears after explicit-cleanup preflight', async () => {
    const input = explicitOperatorCleanupIntentInput();
    const expectedPolicy = {
      settingsId: 'settings-1',
      chatId: 'chat-1',
      deleteBotMessagesEnabled: true as const,
      deleteBotMessagesDelayMinutes: 2,
      createdAt: new Date('2026-08-31T11:00:00.000Z'),
      updatedAt: new Date('2026-08-31T12:00:30.000Z'),
      sendJobCreatedAt: new Date('2026-08-31T11:59:59.000Z'),
    };
    const txQueryRaw = jest
      .fn()
      .mockResolvedValueOnce([expectedPolicy])
      .mockResolvedValueOnce([explicitOperatorCleanupSendRow()])
      .mockResolvedValueOnce([{ id: 'concurrent-delete-ledger-1' }]);
    const txExecuteRaw = jest.fn();
    const auditCreate = jest.fn();
    const transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $queryRaw: txQueryRaw,
        $executeRaw: txExecuteRaw,
        auditLog: { create: auditCreate },
      }),
    );
    const { service, queue } = createService({}, { $transaction: transaction });

    await expect(
      service.ensureBotMessageAutoDeleteRepairIntentWithAudit(input, {
        kind: 'explicit_operator_cleanup',
        actorUserId: 'operator-1',
        operatorReason: 'user-complaint-retroactive-cleanup',
        expectedPolicy,
        expectedSend: explicitOperatorCleanupExpectedSend(),
        auditPayload: { sendLedgerId: 'send-ledger-1' },
      }),
    ).rejects.toMatchObject({ code: 'explicit_operator_cleanup_conflict' });

    expect(txQueryRaw).toHaveBeenCalledTimes(3);
    expect(txExecuteRaw).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rejects misleading explicit-cleanup reason metadata before starting a transaction', async () => {
    const transaction = jest.fn();
    const { service, queue } = createService({}, { $transaction: transaction });

    await expect(
      service.ensureBotMessageAutoDeleteRepairIntentWithAudit(
        botMessageAutoDeleteRepairIntentInput(),
        {
          kind: 'explicit_operator_cleanup',
          actorUserId: 'operator-1',
          operatorReason: 'user-complaint-retroactive-cleanup',
          expectedPolicy: {
            settingsId: 'settings-1',
            chatId: 'chat-1',
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 2,
            createdAt: new Date('2026-08-31T11:00:00.000Z'),
            updatedAt: new Date('2026-08-31T12:00:30.000Z'),
            sendJobCreatedAt: new Date('2026-08-31T11:59:59.000Z'),
          },
          expectedSend: explicitOperatorCleanupExpectedSend(),
          auditPayload: { sendLedgerId: 'send-ledger-1' },
        },
      ),
    ).rejects.toThrow('exact durable explicit-cleanup reason metadata');

    expect(transaction).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rejects an intent that appears after explicit-cleanup preflight without reconciling it', async () => {
    const input = explicitOperatorCleanupIntentInput();
    const expectedPolicy = {
      settingsId: 'settings-1',
      chatId: 'chat-1',
      deleteBotMessagesEnabled: true as const,
      deleteBotMessagesDelayMinutes: 2,
      createdAt: new Date('2026-08-31T11:00:00.000Z'),
      updatedAt: new Date('2026-08-31T12:00:30.000Z'),
      sendJobCreatedAt: new Date('2026-08-31T11:59:59.000Z'),
    };
    const txQueryRaw = jest
      .fn()
      .mockResolvedValueOnce([
        {
          ...expectedPolicy,
          deleteBotMessagesEnabled: true,
        },
      ])
      .mockResolvedValueOnce([explicitOperatorCleanupSendRow()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'concurrent-intent-1' }]);
    const txExecuteRaw = jest.fn();
    const auditCreate = jest.fn();
    const transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $queryRaw: txQueryRaw,
        $executeRaw: txExecuteRaw,
        auditLog: { create: auditCreate },
      }),
    );
    const { service, queue } = createService({}, { $transaction: transaction });

    await expect(
      service.ensureBotMessageAutoDeleteRepairIntentWithAudit(input, {
        kind: 'explicit_operator_cleanup',
        actorUserId: 'operator-1',
        operatorReason: 'user-complaint-retroactive-cleanup',
        expectedPolicy,
        expectedSend: explicitOperatorCleanupExpectedSend(),
        auditPayload: { sendLedgerId: 'send-ledger-1' },
      }),
    ).rejects.toMatchObject({ code: 'explicit_operator_cleanup_conflict' });

    expect(txQueryRaw).toHaveBeenCalledTimes(4);
    expect(txExecuteRaw).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('returns an existing matching repair intent without duplicating its creation audit', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-31T12:01:00.000Z'));
    const input = botMessageAutoDeleteRepairIntentInput();
    const persisted = {
      ...baseIntent,
      id: 'repair-intent-existing',
      subjectUserId: input.subjectUserId,
      sourceMessageAt: input.sourceMessageAt,
      entityType: 'CHAT',
      messageAuthorKind: 'bot',
      originBotId: 'bot-1',
      routingPolicy: 'origin_only',
      status: 'PENDING' as const,
      executeAt: input.executeAt as Date,
      nextAttemptAt: input.executeAt as Date,
      retryUntilAt: input.retryUntilAt as Date,
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const verified = {
      ...persisted,
      botMessageAutoDeleteReason: true,
      botMessageAutoDeleteOnly: true,
      requiredSubscriptionDeleteReason: false,
      replacementCleanup: false,
      commercialOcrDeleteReason: false,
      nonCommercialOcrDeleteReason: true,
    };
    const txQueryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ id: persisted.id }])
      .mockResolvedValueOnce([persisted])
      .mockResolvedValueOnce([verified]);
    const auditCreate = jest.fn();
    const transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $queryRaw: txQueryRaw,
        $executeRaw: jest.fn().mockResolvedValue(0),
        auditLog: { create: auditCreate },
      }),
    );
    const { service, queue } = createService({}, { $transaction: transaction });

    await expect(
      service.ensureBotMessageAutoDeleteRepairIntentWithAudit(input, {
        actorUserId: 'operator-1',
        auditPayload: { claimId: 'claim-1' },
      }),
    ).resolves.toEqual({
      created: false,
      intentId: 'repair-intent-existing',
      rollout: 'execute',
      status: 'PENDING',
    });

    expect(auditCreate).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rejects a persisted mixed-reason repair intent before writing its audit', async () => {
    const input = botMessageAutoDeleteRepairIntentInput();
    const persisted = {
      ...baseIntent,
      id: 'repair-intent-mixed',
      subjectUserId: input.subjectUserId,
      sourceMessageAt: input.sourceMessageAt,
      entityType: 'CHAT',
      messageAuthorKind: 'bot',
      originBotId: 'bot-1',
      routingPolicy: 'origin_only',
      status: 'PENDING' as const,
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const mixed = {
      ...persisted,
      botMessageAutoDeleteReason: true,
      botMessageAutoDeleteOnly: false,
      requiredSubscriptionDeleteReason: true,
      replacementCleanup: false,
      commercialOcrDeleteReason: false,
    };
    const auditCreate = jest.fn();
    const txQueryRaw = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([persisted])
      .mockResolvedValueOnce([mixed]);
    const transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        $queryRaw: txQueryRaw,
        $executeRaw: jest.fn().mockResolvedValue(1),
        auditLog: { create: auditCreate },
      }),
    );
    const { service, queue } = createService({}, { $transaction: transaction });

    await expect(
      service.ensureBotMessageAutoDeleteRepairIntentWithAudit(input, {
        actorUserId: 'operator-1',
        auditPayload: { claimId: 'claim-1' },
      }),
    ).rejects.toThrow('is not an active matching BOT_MESSAGE_AUTO_DELETE-only repair intent');

    expect(auditCreate).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it.each([
    ['channel', { entityType: 'CHANNEL' as const }],
    ['user-authored', { messageAuthorKind: 'user' as const }],
    ['cross-bot routing', { routingPolicy: 'origin_first' as const }],
    ['another rule', { reasonKey: 'OTHER', ruleCode: 'OTHER' }],
    ['mismatched reason key', { reasonKey: 'OTHER' }],
    ['missing origin', { originBotId: null }],
    ['missing subject', { subjectUserId: null }],
    ['missing source timestamp', { sourceMessageAt: null }],
    ['mismatched event user', { event: { userId: 'other-bot', eventType: 'MESSAGE' as const } }],
    ['non-message event', { event: { userId: 'bot-user-1', eventType: 'SYSTEM' as const } }],
  ])('rejects %s input before starting missing-intent repair', async (_label, override) => {
    const transaction = jest.fn();
    const { service, queue } = createService({}, { $transaction: transaction });

    await expect(
      service.ensureBotMessageAutoDeleteRepairIntentWithAudit(
        botMessageAutoDeleteRepairIntentInput(override),
        {
          actorUserId: 'operator-1',
          auditPayload: { claimId: 'claim-1' },
        },
      ),
    ).rejects.toThrow();

    expect(transaction).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it.each(['on', 'baseline'] as const)(
    'atomically admits %s OCR and enqueues only after ownership commits with generic deletion off',
    async (mode) => {
      const order: string[] = [];
      const persisted = {
        ...baseIntent,
        commercialOcrGuardRequired: true,
        standardCommercialOcrDeleteReason: true,
        nonCommercialOcrDeleteReason: false,
        status: 'PENDING' as const,
        leaseToken: null,
        leaseExpiresAt: null,
        leasedFromStatus: null,
      };
      const claimCreateMany = jest.fn(async () => {
        order.push('claim');
        return { count: 1 };
      });
      let txQueryCount = 0;
      const txQueryRaw = jest.fn(async () => {
        order.push(txQueryCount === 0 ? 'intent' : 'reason-state');
        txQueryCount += 1;
        return [persisted];
      });
      const txExecuteRaw = jest.fn(async () => {
        order.push('reason');
        return 1;
      });
      const transaction = jest.fn(
        async (
          callback: (tx: unknown) => Promise<unknown>,
          _options: { isolationLevel: Prisma.TransactionIsolationLevel },
        ) => {
          order.push('transaction-start');
          const result = await callback({
            moderationViolationMessageClaim: { createMany: claimCreateMany },
            $queryRaw: txQueryRaw,
            $executeRaw: txExecuteRaw,
          });
          order.push('commit');
          return result;
        },
      );
      const rootQueryRaw = jest.fn(async () => {
        order.push('post-commit-load');
        return [persisted];
      });
      const { service, prisma, queue } = createService(
        { MODERATION_DELETE_INTENT_MODE: 'off', COMMERCIAL_OCR_ROLLOUT_MODE: mode },
        { $transaction: transaction, $queryRaw: rootQueryRaw },
      );
      queue.add.mockImplementation(async () => {
        order.push('enqueue');
        return undefined;
      });

      await expect(
        service.ensureIntentWithMessageActionClaim(
          commercialOcrClaimedIntentInput(mode === 'baseline' ? 'BASELINE' : 'CERTIFIED'),
        ),
      ).resolves.toEqual({
        claim: 'claimed',
        intent: { intentId: 'intent-1', rollout: 'execute', status: 'PENDING' },
      });

      expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
      expect(claimCreateMany).toHaveBeenCalledTimes(1);
      expect(txQueryRaw).toHaveBeenCalledTimes(2);
      expect(txExecuteRaw).toHaveBeenCalledTimes(1);
      expect(prisma.$executeRaw).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledWith(
        'execute-moderation-delete-intent',
        { intentId: 'intent-1' },
        expect.objectContaining({ priority: 1 }),
      );
      expect(order).toEqual([
        'transaction-start',
        'claim',
        'intent',
        'reason',
        'reason-state',
        'commit',
        'post-commit-load',
        'enqueue',
      ]);
    },
  );

  it.each(['on', 'baseline'] as const)(
    'repairs a missing %s OCR intent and reason when its exact durable claim owner replays with generic deletion off',
    async (mode) => {
      const input = commercialOcrClaimedIntentInput(mode === 'baseline' ? 'BASELINE' : 'CERTIFIED');
      const persisted = {
        ...baseIntent,
        commercialOcrGuardRequired: true,
        standardCommercialOcrDeleteReason: true,
        nonCommercialOcrDeleteReason: false,
        status: 'PENDING' as const,
        leaseToken: null,
        leaseExpiresAt: null,
        leasedFromStatus: null,
      };
      const claimCreateMany = jest.fn().mockResolvedValue({ count: 0 });
      const claimFindUnique = jest.fn().mockResolvedValue(input.claim);
      const txQueryRaw = jest.fn().mockResolvedValue([persisted]);
      const txExecuteRaw = jest.fn().mockResolvedValue(1);
      const transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          moderationViolationMessageClaim: {
            createMany: claimCreateMany,
            findUnique: claimFindUnique,
          },
          $queryRaw: txQueryRaw,
          $executeRaw: txExecuteRaw,
        }),
      );
      const { service, queue } = createService(
        { MODERATION_DELETE_INTENT_MODE: 'off', COMMERCIAL_OCR_ROLLOUT_MODE: mode },
        { $transaction: transaction, $queryRaw: jest.fn().mockResolvedValue([persisted]) },
      );

      await expect(service.ensureIntentWithMessageActionClaim(input)).resolves.toMatchObject({
        claim: 'resumed',
        intent: { intentId: 'intent-1', rollout: 'execute', status: 'PENDING' },
      });

      expect(claimFindUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { messageActionKey: input.claim.messageActionKey } }),
      );
      expect(txQueryRaw).toHaveBeenCalledTimes(2);
      expect(txExecuteRaw).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledTimes(1);
    },
  );

  it('atomically persists and enqueues a guarded image stop-list intent in image-only rollout', async () => {
    const input = imageTextStopListClaimedIntentInput();
    const persisted = {
      ...baseIntent,
      messageId: input.intent.messageId,
      sourceMessageAt: input.intent.sourceMessageAt,
      retryUntilAt: input.intent.retryUntilAt,
      commercialOcrDeadlineAt: input.intent.commercialOcrDeadlineAt,
      commercialOcrGuardRequired: true,
      imageTextStopListDeleteReason: true,
      imageTextStopListDeleteOnly: true,
      status: 'PENDING' as const,
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const claimCreateMany = jest.fn().mockResolvedValue({ count: 1 });
    const txQueryRaw = jest.fn().mockResolvedValue([persisted]);
    const txExecuteRaw = jest.fn().mockResolvedValue(1);
    const transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        moderationViolationMessageClaim: { createMany: claimCreateMany },
        $queryRaw: txQueryRaw,
        $executeRaw: txExecuteRaw,
      }),
    );
    const { service, queue } = createService(
      {
        MODERATION_DELETE_INTENT_MODE: 'shadow',
        COMMERCIAL_OCR_ROLLOUT_MODE: 'shadow',
        IMAGE_TEXT_STOP_LIST_OCR_ROLLOUT_MODE: 'on',
      },
      { $transaction: transaction, $queryRaw: jest.fn().mockResolvedValue([persisted]) },
    );

    await expect(service.ensureIntentWithMessageActionClaim(input)).resolves.toMatchObject({
      claim: 'claimed',
      intent: { rollout: 'execute', status: 'PENDING' },
    });

    expect(claimCreateMany).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      'execute-moderation-delete-intent',
      { intentId: persisted.id },
      expect.objectContaining({ priority: 1 }),
    );
  });

  it('reauthorizes an image stop-list intent against current policy, author and exact photos', async () => {
    const input = imageTextStopListClaimedIntentInput();
    const metadata = input.intent.event.metadata;
    const binding = metadata.imageTextStopListBinding;
    const context = {
      entityType: 'CHAT',
      settings: {
        messageLimitsImageTextScanEnabled: true,
        messageLimitsBlockedWords: ['казино'],
        messageLimitsBlockedDomains: [],
        nightModeTimezone: 'Europe/Moscow',
      },
      admins: [],
      domains: [],
    };
    const reason = {
      ruleCode: COMMERCIAL_OCR_DELETE_RULE_CODE,
      reasonKey: input.intent.reasonKey,
      metadata,
    };
    const { service, participantImmunity, prisma } = createService(
      {
        COMMERCIAL_OCR_ROLLOUT_MODE: 'shadow',
        IMAGE_TEXT_STOP_LIST_OCR_ROLLOUT_MODE: 'on',
      },
      {
        chat: { findUnique: jest.fn().mockResolvedValue(context) },
        moderationDeleteIntentReason: {
          findMany: jest.fn().mockResolvedValue([reason]),
        },
      },
      {
        getChatMemberAccess: jest.fn().mockResolvedValue({
          userId: input.intent.subjectUserId,
          isAdmin: false,
          isOwner: false,
        }),
        getExactMessageRow: jest.fn().mockResolvedValue({
          id: input.intent.messageId,
          timestamp: input.intent.sourceMessageAt.toISOString(),
          recipient: { chat_id: input.intent.chatId },
          sender: { user_id: input.intent.subjectUserId, is_bot: false },
          body: {
            mid: input.intent.messageId,
            text: '',
            attachments: [
              {
                type: 'image',
                payload: { photo_id: 'photo-1', url: 'https://i.oneme.ru/photo-1' },
              },
            ],
          },
        }),
      },
      { isKnownBotUserId: jest.fn().mockReturnValue(false) },
    );
    const intent = {
      ...baseIntent,
      messageId: input.intent.messageId,
      subjectUserId: input.intent.subjectUserId,
      sourceMessageAt: input.intent.sourceMessageAt,
      retryUntilAt: input.intent.retryUntilAt,
      commercialOcrDeadlineAt: input.intent.commercialOcrDeadlineAt,
      commercialOcrGuardRequired: true,
      commercialOcrDeleteReason: true,
      nonCommercialOcrDeleteReason: false,
      imageTextStopListDeleteReason: true,
      imageTextStopListDeleteOnly: true,
    };
    (service as any).expectedImageOcrNativeBehavior = {
      complete: true,
      fingerprintSha256: binding.nativeBehaviorFingerprintSha256,
    };

    await expect(
      (service as unknown as ServiceInternals).assertImageTextStopListDeleteIntentStillActionable(
        intent,
        'bot-1',
      ),
    ).resolves.toEqual({
      reasonDeadlines: [
        {
          reasonKey: input.intent.reasonKey,
          deadlineAtMs: Date.parse(binding.deleteDeadlineAt),
        },
      ],
    });

    expect(binding).toMatchObject({ value: 'казино', expectedImageCount: 1 });
    expect(participantImmunity.consumeForMessage).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'image_text_stop_list_delete' }),
    );
    expect((prisma as any).chat.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          domains: expect.objectContaining({
            where: { OR: [{ removeAfterAt: null }, { removeAfterAt: { gt: expect.any(Date) } }] },
          }),
        }),
      }),
    );
  });

  it('rejects an image stop-list intent after its toggle is disabled', async () => {
    const input = imageTextStopListClaimedIntentInput();
    const { service } = createService(
      { IMAGE_TEXT_STOP_LIST_OCR_ROLLOUT_MODE: 'on' },
      {
        chat: {
          findUnique: jest.fn().mockResolvedValue({
            entityType: 'CHAT',
            settings: {
              messageLimitsImageTextScanEnabled: false,
              messageLimitsBlockedWords: ['казино'],
              messageLimitsBlockedDomains: [],
              nightModeTimezone: 'Europe/Moscow',
            },
            admins: [],
            domains: [],
          }),
        },
        moderationDeleteIntentReason: {
          findMany: jest
            .fn()
            .mockResolvedValue([
              { ruleCode: COMMERCIAL_OCR_DELETE_RULE_CODE, metadata: input.intent.event.metadata },
            ]),
        },
      },
    );
    const intent = {
      ...baseIntent,
      messageId: input.intent.messageId,
      subjectUserId: input.intent.subjectUserId,
      sourceMessageAt: input.intent.sourceMessageAt,
      retryUntilAt: input.intent.retryUntilAt,
      commercialOcrDeadlineAt: input.intent.commercialOcrDeadlineAt,
      commercialOcrGuardRequired: true,
      commercialOcrDeleteReason: true,
      nonCommercialOcrDeleteReason: false,
      imageTextStopListDeleteReason: true,
      imageTextStopListDeleteOnly: true,
    };
    (service as any).expectedImageOcrNativeBehavior = {
      complete: true,
      fingerprintSha256:
        input.intent.event.metadata.imageTextStopListBinding.nativeBehaviorFingerprintSha256,
    };

    const error = await (service as unknown as ServiceInternals)
      .assertImageTextStopListDeleteIntentStillActionable(intent, 'bot-1')
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ImageTextStopListDeleteIntentGuardRejectedError);
    expect(error.code).toBe('image_text_stop_list_settings_disabled');
    expect((service as unknown as ServiceInternals).isTerminalDeleteGuardRejection(error)).toBe(
      true,
    );
  });

  it('preserves independently executable ordinary reasons beside an image sentinel', () => {
    const imageOnly = createService({
      MODERATION_DELETE_INTENT_MODE: 'shadow',
      COMMERCIAL_OCR_ROLLOUT_MODE: 'shadow',
      IMAGE_TEXT_STOP_LIST_OCR_ROLLOUT_MODE: 'on',
    }).service as unknown as ServiceInternals;
    expect(
      imageOnly.isExecutionEnabledForIntent({
        chatId: 'chat-1',
        imageTextStopListDeleteReason: true,
        imageTextStopListDeleteOnly: true,
        nonCommercialOcrDeleteReason: false,
        commercialOcrDeleteReason: true,
        commercialOcrGuardRequired: true,
      }),
    ).toBe(true);

    const ordinary = createService({
      MODERATION_DELETE_INTENT_MODE: 'on',
      COMMERCIAL_OCR_ROLLOUT_MODE: 'shadow',
      IMAGE_TEXT_STOP_LIST_OCR_ROLLOUT_MODE: 'off',
    }).service as unknown as ServiceInternals;
    expect(
      ordinary.isExecutionEnabledForIntent({
        chatId: 'chat-1',
        imageTextStopListDeleteReason: true,
        imageTextStopListDeleteOnly: false,
        nonCommercialOcrDeleteReason: true,
        commercialOcrDeleteReason: true,
        commercialOcrGuardRequired: true,
      }),
    ).toBe(true);
  });

  it('keeps image-only intents selectable by the DB sweeper under image rollout', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const { service } = createService(
      {
        MODERATION_DELETE_INTENT_MODE: 'shadow',
        COMMERCIAL_OCR_ROLLOUT_MODE: 'shadow',
        IMAGE_TEXT_STOP_LIST_OCR_ROLLOUT_MODE: 'on',
      },
      { $queryRaw: queryRaw },
    );

    await (service as unknown as ServiceInternals).selectDueIntentIds();

    const sql = queryRaw.mock.calls[0]![0].strings?.join('?') ?? '';
    expect(sql).toContain('image_text_reason."metadata"->>\'source\'');
    expect(sql).toContain('image_text_ocr');
    expect(sql).toContain('delete_only');
  });

  it('does not manually reopen a terminal image-only OCR intent', async () => {
    const terminal = {
      ...baseIntent,
      status: 'FAILED_TERMINAL' as const,
      updatedAt: new Date(),
      imageTextStopListDeleteReason: true,
      imageTextStopListDeleteOnly: true,
      commercialOcrDeleteReason: true,
      standardCommercialOcrDeleteReason: false,
      commercialOcrGuardRequired: true,
      nonCommercialOcrDeleteReason: false,
    };
    const transaction = jest.fn();
    const { service } = createService(
      { IMAGE_TEXT_STOP_LIST_OCR_ROLLOUT_MODE: 'on' },
      { $queryRaw: jest.fn().mockResolvedValue([terminal]), $transaction: transaction },
    );

    await expect(
      service.retryTerminalIntent(terminal.id, 'FAILED_TERMINAL', {
        updatedAt: terminal.updatedAt,
        attemptCount: terminal.attemptCount,
      }),
    ).resolves.toMatchObject({ reopened: false });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('blocks a conflicting OCR action owner without creating an intent, reason or queue job', async () => {
    const input = commercialOcrClaimedIntentInput();
    const txQueryRaw = jest.fn();
    const txExecuteRaw = jest.fn();
    const transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({
        moderationViolationMessageClaim: {
          createMany: jest.fn().mockResolvedValue({ count: 0 }),
          findUnique: jest.fn().mockResolvedValue({
            ...input.claim,
            dedupeKey: `commercial-ocr-action:v1:${'b'.repeat(64)}`,
          }),
        },
        $queryRaw: txQueryRaw,
        $executeRaw: txExecuteRaw,
      }),
    );
    const { service, queue } = createService({}, { $transaction: transaction });

    await expect(service.ensureIntentWithMessageActionClaim(input)).resolves.toEqual({
      claim: 'blocked',
      intent: null,
    });

    expect(txQueryRaw).not.toHaveBeenCalled();
    expect(txExecuteRaw).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it.each([
    [
      'Prisma serialization',
      Object.assign(new Error('Transaction write conflict'), { code: 'P2034' }),
    ],
    [
      'driver COMMIT',
      Object.assign(new Error('TransactionWriteConflict'), {
        name: 'DriverAdapterError',
        cause: { kind: 'TransactionWriteConflict' },
      }),
    ],
  ])(
    'retries the entire OCR ownership transaction after a %s conflict',
    async (_kind, serializationFailure) => {
      const persisted = {
        ...baseIntent,
        status: 'PENDING' as const,
        leaseToken: null,
        leaseExpiresAt: null,
        leasedFromStatus: null,
      };
      const claimCreateMany = jest.fn().mockResolvedValue({ count: 1 });
      const txQueryRaw = jest.fn().mockResolvedValue([persisted]);
      const txExecuteRaw = jest.fn().mockResolvedValue(1);
      const transaction = jest
        .fn()
        .mockImplementationOnce(async (callback: (tx: unknown) => Promise<unknown>) => {
          await callback({
            moderationViolationMessageClaim: { createMany: claimCreateMany },
            $queryRaw: txQueryRaw,
            $executeRaw: txExecuteRaw,
          });
          throw serializationFailure;
        })
        .mockImplementationOnce(async (callback: (tx: unknown) => Promise<unknown>) =>
          callback({
            moderationViolationMessageClaim: { createMany: claimCreateMany },
            $queryRaw: txQueryRaw,
            $executeRaw: txExecuteRaw,
          }),
        );
      const { service, queue } = createService(
        {},
        { $transaction: transaction, $queryRaw: jest.fn().mockResolvedValue([persisted]) },
      );

      await expect(
        service.ensureIntentWithMessageActionClaim(commercialOcrClaimedIntentInput()),
      ).resolves.toMatchObject({ claim: 'claimed', intent: { intentId: 'intent-1' } });

      expect(transaction).toHaveBeenCalledTimes(2);
      expect(transaction).toHaveBeenNthCalledWith(1, expect.any(Function), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
      expect(transaction).toHaveBeenNthCalledWith(2, expect.any(Function), {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
      expect(claimCreateMany).toHaveBeenCalledTimes(2);
      expect(txQueryRaw).toHaveBeenCalledTimes(4);
      expect(txExecuteRaw).toHaveBeenCalledTimes(2);
      expect(queue.add).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [
      'typed write conflict',
      Object.assign(new Error('TransactionWriteConflict'), {
        name: 'DriverAdapterError',
        cause: { kind: 'TransactionWriteConflict' },
      }),
      3,
    ],
    [
      'constraint failure',
      Object.assign(new Error('UniqueConstraintViolation'), {
        name: 'DriverAdapterError',
        cause: { kind: 'UniqueConstraintViolation' },
      }),
      1,
    ],
    [
      'permission failure',
      Object.assign(new Error('DatabaseAccessDenied'), {
        name: 'DriverAdapterError',
        cause: { kind: 'DatabaseAccessDenied' },
      }),
      1,
    ],
    [
      'ambiguous connection loss',
      Object.assign(new Error('ConnectionClosed'), {
        name: 'DriverAdapterError',
        cause: { kind: 'ConnectionClosed' },
      }),
      1,
    ],
    ['message without typed cause', new Error('TransactionWriteConflict'), 1],
  ])(
    'bounds retries and preserves %s without queue side effects',
    async (_kind, failure, attempts) => {
      const transaction = jest.fn().mockRejectedValue(failure);
      const { service, queue } = createService({}, { $transaction: transaction });
      await expect(
        service.ensureIntentWithMessageActionClaim(commercialOcrClaimedIntentInput()),
      ).rejects.toBe(failure);
      expect(transaction).toHaveBeenCalledTimes(attempts);
      expect(queue.add).not.toHaveBeenCalled();
    },
  );

  it('classifies a bare 404 as waiting for verification, never as already absent', () => {
    const { service } = createService();
    const result = (service as unknown as ServiceInternals).classifyDeleteError(
      { response: { status: 404, data: { code: 'message.not.found' } } },
      1,
    );

    expect(result.status).toBe('WAITING_CAPABILITY');
    expect(result.errorCode).toBe('unverified_message_not_found');
  });

  it('classifies HTTP 200 success=false message.not.found for exact absence verification', () => {
    const { service } = createService();
    const result = (service as unknown as ServiceInternals).classifyDeleteError(
      {
        response: {
          status: 200,
          data: { success: false, code: 'message.not.found', message: 'Message not found' },
        },
      },
      1,
    );

    expect(result.status).toBe('WAITING_CAPABILITY');
    expect(result.errorCode).toBe('unverified_message_not_found');
  });

  it('classifies HTTP 200 success=false access.denied for candidate failover', () => {
    const { service } = createService();
    const result = (service as unknown as ServiceInternals).classifyDeleteError(
      {
        response: {
          status: 200,
          data: { success: false, code: 'access.denied', message: 'Access denied' },
        },
      },
      1,
    );

    expect(result.status).toBe('WAITING_CAPABILITY');
    expect(result.errorCode).toBe('access.denied');
  });

  it('casts dynamic candidate failure JSON values for PostgreSQL polymorphic functions', async () => {
    const { service, prisma } = createService();

    await (service as unknown as ServiceInternals).recordCandidateFailure(
      'intent-1',
      'lease-1',
      'bot-1',
      6,
      {
        status: 'WAITING_CAPABILITY',
        statusCode: null,
        errorCode: 'missing_chat_delete_permission',
        message: 'No delete permission',
        retryDelayMs: 30_000,
      },
    );

    const query = prisma.$executeRaw.mock.calls[0]?.[0] as
      | { strings?: readonly string[]; values?: readonly unknown[] }
      | undefined;
    const sql = query?.strings?.join('?') ?? '';
    expect(sql.match(/CAST\(\? AS text\)/g)).toHaveLength(4);
    expect(sql).toContain('CAST(? AS integer)');
    expect(query?.values?.[0]).toBe('bot-1');
    expect(query?.values?.[3]).toBe('missing_chat_delete_permission');
    expect(query?.values?.[4]).toBeNull();
    expect(
      Date.parse(String(query?.values?.[2])) - Date.parse(String(query?.values?.[1])),
    ).toBeGreaterThan(30_000);
  });

  it('backs capability retries off adaptively up to the shared retry cap', () => {
    const random = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    const { service } = createService();

    const result = (service as unknown as ServiceInternals).classifyDeleteError(
      { response: { status: 404, data: { code: 'message.not.found' } } },
      7,
    );

    expect(result.status).toBe('WAITING_CAPABILITY');
    expect(result.retryDelayMs).toBe(300_000);
    random.mockRestore();
  });

  it('keeps a capability wait wakeable until its absolute retry deadline', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-20T12:00:00.000Z'));
    const retryUntilAt = new Date('2026-08-20T12:01:00.000Z');
    const intent = {
      ...baseIntent,
      nextAttemptAt: new Date('2026-08-20T11:59:59.000Z'),
      retryUntilAt,
      attemptCount: 7,
    };
    const persisted = {
      ...intent,
      status: 'WAITING_CAPABILITY',
      nextAttemptAt: retryUntilAt,
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const executeRaw = jest.fn().mockResolvedValue(1);
    const queryRaw = jest.fn().mockResolvedValue([persisted]);
    const { service, queue } = createService({}, { $executeRaw: executeRaw, $queryRaw: queryRaw });

    await expect(
      (service as unknown as ServiceInternals).finishRetryableAttempt(intent, 'lease-1', {
        status: 'WAITING_CAPABILITY',
        statusCode: null,
        errorCode: 'no_delete_capable_bot',
        message: 'No fresh delete-capable bot',
        retryDelayMs: 300_000,
      }),
    ).resolves.toMatchObject({ status: 'WAITING_CAPABILITY' });

    const query = executeRaw.mock.calls[0]?.[0] as
      | { strings?: readonly string[]; values?: readonly unknown[] }
      | undefined;
    const sql = query?.strings?.join('?') ?? '';
    expect(sql).toContain('"next_attempt_at" = CASE');
    expect(sql).toContain('WHEN "next_attempt_at" > "last_attempt_at"');
    expect(sql).toContain('ELSE LEAST(?, "retry_until_at")');
    expect(query?.values).toContain('WAITING_CAPABILITY');
    expect(query?.values).not.toContain('EXPIRED');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('classifies an outbound timeout as ambiguous', () => {
    const { service } = createService();
    const result = (service as unknown as ServiceInternals).classifyDeleteError(
      Object.assign(new Error('request timeout'), { code: 'ETIMEDOUT' }),
      1,
    );

    expect(result.status).toBe('AMBIGUOUS');
  });

  it('uses a fresh DELETE idempotency key after an ambiguous transport attempt', async () => {
    const ambiguous = {
      ...baseIntent,
      status: 'AMBIGUOUS',
      nextAttemptAt: new Date(Date.now() - 1_000),
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: 'delete_transport_ambiguous',
    };
    const retried = {
      ...ambiguous,
      status: 'IN_PROGRESS',
      attemptCount: 2,
      leaseToken: 'lease-2',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    };
    const succeeded = {
      ...retried,
      status: 'SUCCEEDED',
      succeededBotId: 'bot-1',
      remoteDeleteSucceededAt: new Date(),
      remoteDeleteSucceededBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ ...baseIntent }])
      .mockResolvedValueOnce([ambiguous])
      .mockResolvedValueOnce([retried])
      .mockResolvedValueOnce([succeeded]);
    const deleteMessage = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('request timeout'), { code: 'ETIMEDOUT' }))
      .mockResolvedValueOnce(undefined);
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      {
        deleteMessage,
        getExactMessagePresence: jest.fn().mockResolvedValue('present'),
      },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'ambiguous',
    });
    await expect(service.executeLeasedIntent('intent-1', 'lease-2')).resolves.toMatchObject({
      kind: 'confirmed',
      status: 'SUCCEEDED',
    });

    expect(deleteMessage).toHaveBeenNthCalledWith(
      1,
      'chat-1',
      'message-1',
      expect.objectContaining({
        idempotencyKey: 'moderation-delete-intent-intent-1-attempt-1',
      }),
    );
    expect(deleteMessage).toHaveBeenNthCalledWith(
      2,
      'chat-1',
      'message-1',
      expect.objectContaining({
        idempotencyKey: 'moderation-delete-intent-intent-1-attempt-2',
      }),
    );
  });

  it('honors a longer MAX Retry-After on 429 responses', () => {
    const { service } = createService();
    const result = (service as unknown as ServiceInternals).classifyDeleteError(
      { response: { status: 429, headers: { 'retry-after': '45' } } },
      1,
    );

    expect(result.status).toBe('RETRYABLE');
    expect(result.retryDelayMs).toBeGreaterThanOrEqual(45_000);
  });

  it.each([
    [
      'conflicting body and header',
      { response: { data: { retry_after_ms: 1_000 }, headers: { 'retry-after': '45' } } },
      45_000,
    ],
    [
      'all header values',
      { retryAfterMs: 1_000, response: { headers: { 'retry-after': ['2', '45'] } } },
      45_000,
    ],
    [
      'cause hint',
      { response: { data: { retry_after_ms: 1_000 } }, cause: { retryAfterMs: 60_000 } },
      60_000,
    ],
    [
      'malformed body',
      { response: { data: { retry_after_ms: true }, headers: { 'retry-after': '45' } } },
      45_000,
    ],
    [
      'overflow body',
      {
        response: { data: { retry_after_ms: Number.MAX_VALUE }, headers: { 'retry-after': '45' } },
      },
      45_000,
    ],
    [
      'only invalid hints',
      {
        retryAfterMs: Number.POSITIVE_INFINITY,
        response: {
          data: { retry_after_ms: [] },
          headers: { 'retry-after': '999999999999999999999999' },
        },
      },
      5_000,
    ],
  ] as const)('uses the maximum valid MAX retry hint for %s', (_label, hints, expected) => {
    const { service } = createService();
    const random = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const response = 'response' in hints ? hints.response : {};
      const result = (service as unknown as ServiceInternals).classifyDeleteError(
        { ...hints, response: { ...response, status: 429 } },
        1,
      );
      expect(result).toMatchObject({ status: 'RETRYABLE', retryDelayMs: expected });
    } finally {
      random.mockRestore();
    }
  });

  describe('direct local DELETE cooldown', () => {
    const markedQuota = (retryAfterMs: number) =>
      markMaxPreDispatchGuardRejected(
        new MaxApiInternalRateLimitError('Local quota refused', retryAfterMs, 'external_cooldown'),
        MAX_DELETE_PRE_DISPATCH_GUARD_REJECTED_CODE,
      );
    const classify = (error: unknown, attemptCount = 1, dispatchMarkerPersisted = false) => {
      const jitter = jest.spyOn(Math, 'random').mockReturnValue(0.5);
      try {
        const { service } = createService();
        return (service as unknown as ServiceInternals).classifyDeleteError(
          error,
          attemptCount,
          dispatchMarkerPersisted,
        );
      } finally {
        jitter.mockRestore();
      }
    };

    it.each([
      [30_000, 1, 30_000],
      [1_000, 1, 5_000],
      [30_000, 4, 40_000],
    ])('honors hint %i and attempt %i without shortening backoff', (hint, attempt, expected) => {
      expect(classify(markedQuota(hint), attempt)).toMatchObject({
        status: 'RETRYABLE',
        errorCode: 'MAX_API_INTERNAL_RATE_LIMIT',
        retryDelayMs: expected,
      });
    });

    it('keeps retained mutation evidence ambiguous despite a genuine local rejection', () => {
      expect(classify(markedQuota(30_000), 1, true)).toMatchObject({
        status: 'AMBIGUOUS',
        retryDelayMs: 30_000,
      });
    });

    it.each([
      ['unmarked concrete error', () => new MaxApiInternalRateLimitError('Local quota', 30_000)],
      [
        'copied local error fields',
        () =>
          markMaxPreDispatchGuardRejected(
            Object.assign(new Error('Local quota'), {
              code: 'MAX_API_INTERNAL_RATE_LIMIT',
              preDispatch: true,
              retryAfterMs: 30_000,
            }),
            MAX_DELETE_PRE_DISPATCH_GUARD_REJECTED_CODE,
          ),
      ],
      [
        'general error with a hint',
        () => Object.assign(new Error('Failure'), { retryAfterMs: 30_000 }),
      ],
      [
        'conflicting HTTP response',
        () =>
          Object.assign(markedQuota(30_000) as Error, {
            response: { status: 200 },
          }),
      ],
      [
        'unclassified HTTP response',
        () => Object.assign(markedQuota(30_000) as Error, { response: {} }),
      ],
      [
        'conflicting HTTP method',
        () =>
          Object.assign(markedQuota(30_000) as Error, {
            config: { method: 'get' },
          }),
      ],
      ['HTTP request evidence', () => Object.assign(markedQuota(30_000) as Error, { request: {} })],
      [
        'false pre-dispatch flag',
        () => Object.assign(markedQuota(30_000) as Error, { preDispatch: false }),
      ],
      ['zero hint', () => markedQuota(0)],
      ['negative hint', () => markedQuota(-1)],
      ['non-finite hint', () => markedQuota(Number.POSITIVE_INFINITY)],
      ['NaN hint', () => markedQuota(Number.NaN)],
      ['fractional hint', () => markedQuota(30_000.5)],
      ['unsafe hint', () => markedQuota(Number.MAX_SAFE_INTEGER + 1)],
      ['unrepresentable retry date', () => markedQuota(Number.MAX_SAFE_INTEGER)],
    ] as const)('preserves ordinary retry classification for %s', (_name, error) => {
      expect(classify(error())).toMatchObject({ status: 'RETRYABLE', retryDelayMs: 5_000 });
    });

    it('preserves transport uncertainty on a conflicting concrete error', () => {
      const error = Object.assign(markedQuota(30_000) as Error, { code: 'ECONNRESET' });
      expect(classify(error)).toMatchObject({ status: 'AMBIGUOUS', retryDelayMs: 5_000 });
    });
  });

  it('retains an elapsed explicit deadline when immediate execution was omitted', () => {
    const { service } = createService();
    const deadline = new Date(Date.now() - 60_000);
    const input = {
      chatId: 'chat-1',
      messageId: 'expired-message',
      reasonKey: 'MESSAGE_TOO_LONG_DELETE',
      retryUntilAt: deadline,
      sourceMessageAt: new Date(deadline.getTime() - 300_000),
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      originBotId: 'bot-1',
    };
    const normalized = (service as unknown as ServiceInternals).normalizeInput(input);
    expect(normalized.retryUntilAt).toEqual(deadline);
    expect(normalized.executeAt).toEqual(deadline);
    for (const executeAt of [new Date(), new Date(Date.now() + 60_000), 'invalid-date'])
      expect(() =>
        (service as unknown as ServiceInternals).normalizeInput({ ...input, executeAt }),
      ).toThrow();
  });

  it('keeps the retry window after delayed executeAt', () => {
    const { service } = createService({ MODERATION_DELETE_INTENT_RETRY_HORIZON_MS: 60_000 });
    const executeAt = new Date(Date.now() + 3_600_000);
    const normalized = (service as unknown as ServiceInternals).normalizeInput({
      chatId: 'chat-1',
      messageId: 'message-1',
      reasonKey: 'BOT_NOTICE_DELETE',
      executeAt,
      entityType: 'CHAT',
      messageAuthorKind: 'bot',
      originBotId: 'bot-1',
    });

    expect(normalized.retryUntilAt.getTime()).toBe(executeAt.getTime() + 60_000);
    expect(normalized.retryUntilAt.getTime()).toBeGreaterThanOrEqual(
      normalized.executeAt.getTime(),
    );
  });

  it('keeps the full schedule unchanged when the same reason key is replayed', async () => {
    const originalExecuteAt = new Date(Date.now() + 120_000);
    const originalNextAttemptAt = new Date(Date.now() + 180_000);
    const originalRetryUntilAt = new Date(Date.now() + 600_000);
    const persisted = {
      ...baseIntent,
      id: 'existing-intent',
      status: 'WAITING_CAPABILITY' as const,
      executeAt: originalExecuteAt,
      nextAttemptAt: originalNextAttemptAt,
      retryUntilAt: originalRetryUntilAt,
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const txQueryRaw = jest.fn().mockResolvedValue([persisted]);
    const txExecuteRaw = jest.fn().mockResolvedValue(0);
    const transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ $queryRaw: txQueryRaw, $executeRaw: txExecuteRaw }),
    );
    const { service, queue } = createService({}, { $transaction: transaction });

    await service.ensureIntent({
      chatId: persisted.chatId,
      messageId: persisted.messageId,
      reasonKey: 'STOP_WORD:same-reason',
      ruleCode: 'STOP_WORD_DELETE',
      executeAt: new Date(Date.now() - 1_000),
      retryUntilAt: new Date(Date.now() + 3_600_000),
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      originBotId: 'bot-1',
      routingPolicy: 'origin_only',
    });

    expect(persisted.executeAt).toBe(originalExecuteAt);
    expect(persisted.nextAttemptAt).toBe(originalNextAttemptAt);
    expect(persisted.retryUntilAt).toBe(originalRetryUntilAt);
    expect(queue.add).not.toHaveBeenCalled();
    const upsertSql = txQueryRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    expect(upsertSql).toMatch(
      /"execute_at" = CASE[\s\S]*?ELSE "moderation_delete_intents"\."execute_at"/u,
    );
    expect(upsertSql).toMatch(
      /"next_attempt_at" = CASE[\s\S]*?ELSE "moderation_delete_intents"\."next_attempt_at"/u,
    );
    const reasonSql = txExecuteRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    expect(reasonSql).toContain('WITH changed_reason AS');
    expect(reasonSql).toContain('AND EXISTS (SELECT 1 FROM changed_reason)');
  });

  it('wakes and extends an existing intent only when a new reason is committed', async () => {
    const incomingExecuteAt = new Date(Date.now() - 1_000);
    const incomingRetryUntilAt = new Date(Date.now() + 3_600_000);
    const persisted = {
      ...baseIntent,
      id: 'existing-intent',
      status: 'WAITING_CAPABILITY' as const,
      executeAt: new Date(Date.now() + 120_000),
      nextAttemptAt: new Date(Date.now() + 180_000),
      retryUntilAt: new Date(Date.now() + 600_000),
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const txQueryRaw = jest.fn().mockResolvedValue([persisted]);
    const txExecuteRaw = jest.fn().mockResolvedValue(1);
    const transaction = jest.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ $queryRaw: txQueryRaw, $executeRaw: txExecuteRaw }),
    );
    const { service, queue } = createService({}, { $transaction: transaction });

    await service.ensureIntent({
      chatId: persisted.chatId,
      messageId: persisted.messageId,
      reasonKey: 'STOP_WORD:new-reason',
      ruleCode: 'STOP_WORD_DELETE',
      executeAt: incomingExecuteAt,
      retryUntilAt: incomingRetryUntilAt,
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      originBotId: 'bot-1',
      routingPolicy: 'origin_only',
    });

    expect(persisted.executeAt).toEqual(incomingExecuteAt);
    expect(persisted.nextAttemptAt).toEqual(incomingExecuteAt);
    expect(persisted.retryUntilAt).toEqual(incomingRetryUntilAt);
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('requires a separate canary before user-authored chat deletes can use another bot', () => {
    const input = {
      chatId: 'chat-1',
      messageId: 'message-1',
      reasonKey: 'DUPLICATE',
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      originBotId: 'bot-1',
      routingPolicy: 'delete_capable',
    };
    const withoutCanary = createService().service;
    const withCanary = createService({
      MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS: 'chat-1',
    }).service;

    expect((withoutCanary as unknown as ServiceInternals).normalizeInput(input).routingPolicy).toBe(
      'origin_only',
    );
    expect((withCanary as unknown as ServiceInternals).normalizeInput(input).routingPolicy).toBe(
      'delete_capable',
    );
  });

  it('retains exact replacement routing while the kill switch controls its effective use', () => {
    const input = {
      chatId: 'chat-1',
      messageId: 'message-1',
      reasonKey: 'chat_auto_comment_admin_message_replacement_cleanup',
      ruleCode: 'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP',
      entityType: 'CHAT' as const,
      messageAuthorKind: 'user' as const,
      originBotId: 'bot-1',
      routingPolicy: 'origin_first' as const,
    };
    const disabled = createService({
      MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_ENABLED: false,
    }).service;

    expect((disabled as unknown as ServiceInternals).normalizeInput(input).routingPolicy).toBe(
      'origin_first',
    );
    expect(
      disabled.resolveEffectiveRoutingPolicy({
        ...input,
        replacementCleanup: true,
      }),
    ).toBe('origin_only');
  });

  it('executes safety-critical cleanup rules outside the global canary', () => {
    const enabled = createService({
      MODERATION_DELETE_INTENT_MODE: 'canary',
      MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: 'other-chat',
    }).service;
    const disabled = createService({
      MODERATION_DELETE_INTENT_MODE: 'canary',
      MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: 'other-chat',
      MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_ENABLED: false,
    }).service;

    expect(
      enabled.getRolloutForRule('chat-1', 'CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP'),
    ).toBe('execute');
    expect(
      enabled.getRolloutForRule('chat-1', 'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP'),
    ).toBe('execute');
    expect(
      enabled.getRolloutForRule('chat-1', 'CHAT_RULES_REPUBLISH_PREVIOUS_MESSAGE_CLEANUP'),
    ).toBe('execute');
    expect(
      enabled.getRolloutForRule('chat-1', 'CHAT_RULES_REPUBLISH_PREVIOUS_MESSAGE_CLEANUP_EXTRA'),
    ).toBe('observed');
    expect(
      disabled.getRolloutForRule('chat-1', 'CHAT_RULES_REPUBLISH_PREVIOUS_MESSAGE_CLEANUP'),
    ).toBe('observed');
    expect(enabled.getRolloutForRule('chat-1', 'BOT_MESSAGE_AUTO_DELETE')).toBe('execute');
    expect(enabled.getRolloutForRule('chat-1', 'BOT_MESSAGE_AUTO_DELETE_EXTRA')).toBe('observed');
  });

  it('gates exact required-subscription deletion independently of the global rollout', () => {
    const shadowDefault = createService({
      MODERATION_DELETE_INTENT_MODE: 'shadow',
      MODERATION_DELETE_INTENT_REQUIRED_SUBSCRIPTION_ENABLED: undefined,
    }).service;
    const shadowDisabled = createService({
      MODERATION_DELETE_INTENT_MODE: 'shadow',
      MODERATION_DELETE_INTENT_REQUIRED_SUBSCRIPTION_ENABLED: false,
    }).service;
    const shadowEnabled = createService({
      MODERATION_DELETE_INTENT_MODE: 'shadow',
      MODERATION_DELETE_INTENT_REQUIRED_SUBSCRIPTION_ENABLED: true,
    }).service;
    const canaryEnabled = createService({
      MODERATION_DELETE_INTENT_MODE: 'canary',
      MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: 'other-chat',
      MODERATION_DELETE_INTENT_REQUIRED_SUBSCRIPTION_ENABLED: true,
    }).service;

    expect(shadowDefault.getRolloutForRule('chat-1', 'REQUIRED_SUBSCRIPTION_DELETE')).toBe(
      'execute',
    );
    expect(shadowDisabled.getRolloutForRule('chat-1', 'REQUIRED_SUBSCRIPTION_DELETE')).toBe(
      'observed',
    );
    expect(shadowDisabled.getRolloutForInput(requiredSubscriptionDeleteIntentInput())).toBe(
      'observed',
    );
    expect(shadowEnabled.getRolloutForRule('chat-1', 'REQUIRED_SUBSCRIPTION_DELETE')).toBe(
      'execute',
    );
    expect(canaryEnabled.getRolloutForRule('chat-1', 'REQUIRED_SUBSCRIPTION_DELETE')).toBe(
      'execute',
    );
    expect(shadowEnabled.getRolloutForRule('chat-1', 'REQUIRED_SUBSCRIPTION_DELETE_EXTRA')).toBe(
      'observed',
    );
    expect(shadowEnabled.getRolloutForRule('chat-1', 'PREFIX_REQUIRED_SUBSCRIPTION_DELETE')).toBe(
      'observed',
    );
    expect(shadowEnabled.getRolloutForRule('chat-1', 'STOP_WORD_DELETE')).toBe('observed');
    expect(
      (shadowDisabled as unknown as ServiceInternals).isExecutionEnabledForIntent({
        chatId: 'chat-1',
        requiredSubscriptionDeleteReason: true,
      }),
    ).toBe(false);
    expect(
      (shadowEnabled as unknown as ServiceInternals).isExecutionEnabledForIntent({
        chatId: 'chat-1',
        requiredSubscriptionDeleteReason: true,
      }),
    ).toBe(true);
  });

  it.each([
    ['shadow', { MODERATION_DELETE_INTENT_MODE: 'shadow' }],
    [
      'outside the canary cohort',
      {
        MODERATION_DELETE_INTENT_MODE: 'canary',
        MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: 'other-chat',
      },
    ],
  ])('persists required-subscription deletion as executable in %s', async (_label, rollout) => {
    const persisted = {
      ...baseIntent,
      status: 'PENDING' as const,
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({
          $queryRaw: jest.fn().mockResolvedValue([persisted]),
          $executeRaw: jest.fn().mockResolvedValue(1),
        }),
    );
    const { service, queue } = createService(
      {
        ...rollout,
        MODERATION_DELETE_INTENT_REQUIRED_SUBSCRIPTION_ENABLED: true,
      },
      { $transaction: transaction },
    );

    await expect(service.ensureIntent(requiredSubscriptionDeleteIntentInput())).resolves.toEqual({
      intentId: 'intent-1',
      rollout: 'execute',
      status: 'PENDING',
    });
    expect(queue.add).toHaveBeenCalledWith(
      'execute-moderation-delete-intent',
      { intentId: 'intent-1' },
      expect.objectContaining({ priority: 1 }),
    );
  });

  it('keeps exact required-subscription deletion observed while its switch is off', async () => {
    const persisted = {
      ...baseIntent,
      status: 'OBSERVED' as const,
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({
          $queryRaw: jest.fn().mockResolvedValue([persisted]),
          $executeRaw: jest.fn().mockResolvedValue(1),
        }),
    );
    const { service, queue } = createService(
      { MODERATION_DELETE_INTENT_MODE: 'shadow' },
      { $transaction: transaction },
    );

    await expect(service.ensureIntent(requiredSubscriptionDeleteIntentInput())).resolves.toEqual({
      intentId: 'intent-1',
      rollout: 'observed',
      status: 'OBSERVED',
    });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('promotes a replayed required-subscription observation when its switch is enabled', async () => {
    const promoted = {
      ...baseIntent,
      status: 'PENDING' as const,
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const txQueryRaw = jest.fn().mockResolvedValue([promoted]);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({
          $queryRaw: txQueryRaw,
          $executeRaw: jest.fn().mockResolvedValue(1),
        }),
    );
    const { service, queue } = createService(
      {
        MODERATION_DELETE_INTENT_MODE: 'shadow',
        MODERATION_DELETE_INTENT_REQUIRED_SUBSCRIPTION_ENABLED: true,
      },
      { $transaction: transaction },
    );

    await expect(service.ensureIntent(requiredSubscriptionDeleteIntentInput())).resolves.toEqual({
      intentId: 'intent-1',
      rollout: 'execute',
      status: 'PENDING',
    });

    const upsertSql = txQueryRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    expect(upsertSql).toContain('ON CONFLICT');
    expect(upsertSql).toContain('"moderation_delete_intents"."status" = CAST');
    expect(upsertSql).toContain('\'OBSERVED\' AS "ModerationDeleteIntentStatus"');
    expect(upsertSql).toContain('EXCLUDED."status" <> CAST');
    expect(upsertSql).not.toContain('WHEN FALSE');
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('attempts a freshly persisted required-subscription intent in shadow mode', async () => {
    const persisted = {
      ...baseIntent,
      status: 'PENDING' as const,
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({
          $queryRaw: jest.fn().mockResolvedValue([persisted]),
          $executeRaw: jest.fn().mockResolvedValue(1),
        }),
    );
    const { service } = createService(
      {
        MODERATION_DELETE_INTENT_MODE: 'shadow',
        MODERATION_DELETE_INTENT_REQUIRED_SUBSCRIPTION_ENABLED: true,
      },
      { $transaction: transaction },
    );
    const attempt = jest.spyOn(service, 'attemptIntent').mockResolvedValue({
      kind: 'confirmed',
      confirmed: true,
      intentId: 'intent-1',
      status: 'SUCCEEDED',
      botId: 'bot-1',
    });

    await expect(
      service.ensureAndAttempt(requiredSubscriptionDeleteIntentInput()),
    ).resolves.toMatchObject({ kind: 'confirmed', confirmed: true });
    expect(attempt).toHaveBeenCalledWith('intent-1', undefined);
  });

  it('preserves required-subscription execution when a non-required reason coalesces', async () => {
    const persisted = {
      ...baseIntent,
      status: 'PENDING' as const,
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const txQueryRaw = jest
      .fn()
      .mockResolvedValueOnce([persisted])
      .mockResolvedValueOnce([{ requiredSubscriptionDeleteReason: true }]);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({
          $queryRaw: txQueryRaw,
          $executeRaw: jest.fn().mockResolvedValue(1),
        }),
    );
    const { service, queue } = createService(
      {
        MODERATION_DELETE_INTENT_MODE: 'shadow',
        MODERATION_DELETE_INTENT_REQUIRED_SUBSCRIPTION_ENABLED: true,
      },
      { $transaction: transaction },
    );

    await expect(
      service.ensureIntent({
        ...requiredSubscriptionDeleteIntentInput(),
        reasonKey: 'STOP_WORD:message-delete',
        ruleCode: 'STOP_WORD_DELETE',
      }),
    ).resolves.toEqual({
      intentId: 'intent-1',
      rollout: 'execute',
      status: 'PENDING',
    });

    expect(txQueryRaw).toHaveBeenCalledTimes(2);
    expect(txQueryRaw.mock.calls[1]?.[0]?.values).toContain('REQUIRED_SUBSCRIPTION_DELETE');
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('keeps required-subscription execution durable across reload and DB sweep', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const { service } = createService(
      {
        MODERATION_DELETE_INTENT_MODE: 'shadow',
        MODERATION_DELETE_INTENT_REQUIRED_SUBSCRIPTION_ENABLED: true,
      },
      { $queryRaw: queryRaw },
    );
    const internals = service as unknown as ServiceInternals;

    await internals.selectDueIntentIds();

    const sweepQuery = queryRaw.mock.calls[0]?.[0];
    expect(sweepQuery?.strings?.join('?') ?? '').toContain('required_subscription_reason');
    expect(sweepQuery?.values).toContain('REQUIRED_SUBSCRIPTION_DELETE');

    const selectQuery = (
      service as unknown as {
        intentSelectSql(alias: string): {
          strings?: readonly string[];
          values?: readonly unknown[];
        };
      }
    ).intentSelectSql('intent');
    expect(selectQuery.strings?.join('?') ?? '').toContain('AS "requiredSubscriptionDeleteReason"');
    expect(selectQuery.values).toContain('REQUIRED_SUBSCRIPTION_DELETE');
    expect(
      internals.isExecutionEnabledForIntent({
        chatId: 'chat-1',
        requiredSubscriptionDeleteReason: true,
      }),
    ).toBe(true);

    const loaded = {
      ...baseIntent,
      status: 'PENDING' as const,
      requiredSubscriptionDeleteReason: true,
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    jest.spyOn(service as any, 'loadIntent').mockResolvedValue(loaded);
    jest.spyOn(service as any, 'claimOne').mockResolvedValue({
      ...loaded,
      status: 'IN_PROGRESS',
      leaseToken: 'reloaded-lease',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      leasedFromStatus: 'PENDING',
    });
    const execute = jest.spyOn(service, 'executeLeasedIntent').mockResolvedValue({
      kind: 'confirmed',
      confirmed: true,
      intentId: 'intent-1',
      status: 'SUCCEEDED',
      botId: 'bot-1',
    });

    await expect(service.attemptIntent('intent-1')).resolves.toMatchObject({
      kind: 'confirmed',
    });
    expect(execute).toHaveBeenCalledWith('intent-1', 'reloaded-lease', undefined);
  });

  it('excludes required-subscription retry from the shadow sweep while its switch is off', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const { service } = createService(
      { MODERATION_DELETE_INTENT_MODE: 'shadow' },
      { $queryRaw: queryRaw },
    );

    await (service as unknown as ServiceInternals).selectDueIntentIds();

    const sweepQuery = queryRaw.mock.calls[0]?.[0];
    expect(sweepQuery?.values).not.toContain('REQUIRED_SUBSCRIPTION_DELETE');
  });

  it('releases a claimed required-subscription intent without a MAX mutation after switch-off', async () => {
    const leased = {
      ...baseIntent,
      requiredSubscriptionDeleteReason: true,
    };
    const paused = {
      ...leased,
      status: 'PENDING' as const,
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const queryRaw = jest.fn().mockResolvedValueOnce([leased]).mockResolvedValueOnce([paused]);
    const executeRaw = jest.fn().mockResolvedValue(1);
    const deleteMessage = jest.fn();
    const resolveDeleteMessageBotRoute = jest.fn();
    const { service } = createService(
      { MODERATION_DELETE_INTENT_MODE: 'shadow' },
      { $queryRaw: queryRaw, $executeRaw: executeRaw },
      { deleteMessage },
      { resolveDeleteMessageBotRoute },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      status: 'PENDING',
    });

    const releaseSql = executeRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    expect(releaseSql).toContain('"status" = COALESCE');
    expect(releaseSql).toContain('"lease_token" = NULL');
    expect(resolveDeleteMessageBotRoute).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it('scopes commercial OCR execution to its exact OCR canary without widening other rules', () => {
    const service = createService({
      MODERATION_DELETE_INTENT_MODE: 'shadow',
      MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: '',
      COMMERCIAL_OCR_ROLLOUT_MODE: 'canary',
      COMMERCIAL_OCR_CANARY_CHAT_IDS: 'chat-1,*',
    }).service;

    expect(service.getRolloutForRule('chat-1', COMMERCIAL_OCR_DELETE_RULE_CODE)).toBe('execute');
    expect(service.getRolloutForRule('chat-2', COMMERCIAL_OCR_DELETE_RULE_CODE)).toBe('observed');
    expect(service.getRolloutForRule('chat-1', 'STOP_WORD_DELETE')).toBe('observed');
    expect(service.getRolloutForRule('chat-1', 'LINK_BLOCKED_DELETE')).toBe('execute');
    expect(service.getRolloutForRule('*', COMMERCIAL_OCR_DELETE_RULE_CODE)).toBe('observed');
  });

  it.each(['off', 'baseline', 'invalid-mode'])(
    'keeps commercial baseline and guarded user deletes independent of base mode %s and image stop-list off',
    (genericMode) => {
      const service = createService({
        MODERATION_DELETE_INTENT_MODE: genericMode,
        COMMERCIAL_OCR_ROLLOUT_MODE: 'baseline',
        COMMERCIAL_OCR_CANARY_CHAT_IDS: '',
        IMAGE_TEXT_STOP_LIST_OCR_ROLLOUT_MODE: 'off',
      }).service;
      const internals = service as unknown as ServiceInternals;

      expect(service.getRolloutForInput(commercialOcrClaimedIntentInput('BASELINE').intent)).toBe(
        'execute',
      );
      expect(service.getRolloutForChat('chat-1')).toBe('off');
      expect(service.getRolloutForRule('chat-1', 'STOP_WORD_DELETE')).toBe('off');
      expect(service.getRolloutForRule('chat-1', 'LINK_BLOCKED_DELETE')).toBe('execute');
      expect(service.getRolloutForInput(imageTextStopListClaimedIntentInput().intent)).toBe('off');
      expect(
        internals.isExecutionEnabledForIntent({
          chatId: 'chat-1',
          standardCommercialOcrDeleteReason: true,
          commercialOcrGuardRequired: true,
          nonCommercialOcrDeleteReason: false,
        }),
      ).toBe(true);
      expect(
        internals.isExecutionEnabledForIntent({
          chatId: 'chat-1',
          commercialOcrGuardRequired: false,
          nonCommercialOcrDeleteReason: true,
        }),
      ).toBe(false);
      expect(
        internals.isExecutionEnabledForIntent({
          chatId: 'chat-1',
          standardCommercialOcrDeleteReason: false,
          imageTextStopListDeleteReason: true,
          imageTextStopListDeleteOnly: true,
          commercialOcrDeleteReason: true,
          commercialOcrGuardRequired: true,
          nonCommercialOcrDeleteReason: false,
        }),
      ).toBe(false);
    },
  );

  it.each(['off', 'invalid-mode'])(
    'does not claim commercial OCR ownership when its mode is %s',
    async (mode) => {
      const transaction = jest.fn();
      const { service, queue } = createService(
        {
          MODERATION_DELETE_INTENT_MODE: 'off',
          COMMERCIAL_OCR_ROLLOUT_MODE: mode,
        },
        { $transaction: transaction },
      );

      await expect(
        service.ensureIntentWithMessageActionClaim(commercialOcrClaimedIntentInput('BASELINE')),
      ).resolves.toEqual({
        claim: 'blocked',
        intent: null,
      });
      expect(transaction).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    },
  );

  it('rechecks the reason-scoped commercial OCR rollout for durable intents', () => {
    const service = createService({
      MODERATION_DELETE_INTENT_MODE: 'shadow',
      COMMERCIAL_OCR_ROLLOUT_MODE: 'canary',
      COMMERCIAL_OCR_CANARY_CHAT_IDS: 'chat-1',
    }).service as unknown as ServiceInternals;

    expect(
      service.isExecutionEnabledForIntent({
        chatId: 'chat-1',
        commercialOcrGuardRequired: true,
        commercialOcrDeleteReason: true,
        nonCommercialOcrDeleteReason: false,
      }),
    ).toBe(true);
    expect(
      service.isExecutionEnabledForIntent({
        chatId: 'chat-2',
        commercialOcrGuardRequired: true,
        commercialOcrDeleteReason: true,
        nonCommercialOcrDeleteReason: false,
      }),
    ).toBe(false);
    expect(
      service.isExecutionEnabledForIntent({
        chatId: 'chat-1',
        commercialOcrGuardRequired: false,
        commercialOcrDeleteReason: false,
        nonCommercialOcrDeleteReason: true,
      }),
    ).toBe(false);
  });

  it('rechecks the replacement cleanup switch at execution time', () => {
    const enabled = createService({
      MODERATION_DELETE_INTENT_MODE: 'canary',
      MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: 'other-chat',
    }).service as unknown as ServiceInternals;
    const disabled = createService({
      MODERATION_DELETE_INTENT_MODE: 'canary',
      MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: 'other-chat',
      MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_ENABLED: false,
    }).service as unknown as ServiceInternals;

    expect(
      enabled.isExecutionEnabledForIntent({ chatId: 'chat-1', replacementCleanup: true }),
    ).toBe(true);
    expect(
      enabled.isExecutionEnabledForIntent({ chatId: 'chat-1', replacementCleanup: false }),
    ).toBe(false);
    expect(
      disabled.isExecutionEnabledForIntent({ chatId: 'chat-1', replacementCleanup: true }),
    ).toBe(false);
  });

  it('keeps BOT_MESSAGE_AUTO_DELETE durable outside the global canary', () => {
    const service = createService({
      MODERATION_DELETE_INTENT_MODE: 'canary',
      MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: 'other-chat',
    }).service as unknown as ServiceInternals;

    expect(
      service.isExecutionEnabledForIntent({
        chatId: 'chat-1',
        replacementCleanup: false,
        botMessageAutoDeleteOnly: true,
      }),
    ).toBe(true);
  });

  it('applies the bot-message auto-delete retry cap only before mutation and without a required reason', () => {
    const { service } = createService();
    const internals = service as unknown as ServiceInternals;
    const autoDeleteOnly = {
      ...baseIntent,
      botMessageAutoDeleteOnly: true,
      requiredSubscriptionDeleteReason: false,
    };

    expect(internals.isBotMessageAutoDeleteRetryLimitApplicable(autoDeleteOnly)).toBe(true);
    for (const bypass of [
      { requiredSubscriptionDeleteReason: true },
      { replacementCleanup: true },
      { commercialOcrGuardRequired: true },
      { commercialOcrDeleteReason: true },
      { deleteDispatchStartedAt: new Date() },
      { deleteDispatchStartedBotId: 'bot-1' },
      { remoteDeleteSucceededAt: new Date() },
      { remoteDeleteSucceededBotId: 'bot-1' },
    ]) {
      expect(
        internals.isBotMessageAutoDeleteRetryLimitApplicable({
          ...autoDeleteOnly,
          ...bypass,
        }),
      ).toBe(false);
    }
  });

  it('allows the initial bot-message auto-delete route attempt', async () => {
    const autoDeleteIntent = {
      ...baseIntent,
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      botMessageAutoDeleteOnly: true,
      requiredSubscriptionDeleteReason: false,
    };
    const waitingIntent = {
      ...autoDeleteIntent,
      status: 'WAITING_CAPABILITY' as const,
      nextAttemptAt: new Date(Date.now() + 30_000),
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
      lastErrorCode: 'no_active_membership',
    };
    const unavailableRoute = {
      ...confirmedRoute,
      primaryBotId: null,
      botId: null,
      candidateBotIds: [],
      candidateCapabilities: [],
      capabilityState: 'stale_or_unknown',
      capabilityReason: 'no_active_membership',
    } as const;
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([autoDeleteIntent])
      .mockResolvedValueOnce([waitingIntent]);
    const resolveDeleteMessageBotRoute = jest.fn().mockResolvedValue(unavailableRoute);
    const getCurrentChatMemberAccess = jest.fn();
    const deleteMessage = jest.fn();
    const { service, queue } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      { getCurrentChatMemberAccess, deleteMessage },
      {
        resolveDeleteMessageBotRoute,
        getExecutableBotById: jest.fn().mockReturnValue(null),
      },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'waiting_capability',
      status: 'WAITING_CAPABILITY',
    });

    expect(resolveDeleteMessageBotRoute).toHaveBeenCalledTimes(1);
    expect(getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('terminalizes the fifth bot-message auto-delete failure after its route attempt', async () => {
    const autoDeleteIntent = {
      ...baseIntent,
      attemptCount: 5,
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      botMessageAutoDeleteOnly: true,
      requiredSubscriptionDeleteReason: false,
    };
    const terminalIntent = {
      ...autoDeleteIntent,
      status: 'FAILED_TERMINAL' as const,
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
      lastErrorCode: 'bot_message_auto_delete_retry_limit_reached',
    };
    const unavailableRoute = {
      ...confirmedRoute,
      primaryBotId: null,
      botId: null,
      candidateBotIds: [],
      candidateCapabilities: [],
      capabilityState: 'stale_or_unknown',
      capabilityReason: 'no_active_membership',
    } as const;
    const rootQueryRaw = jest.fn().mockResolvedValueOnce([autoDeleteIntent]);
    const txQueryRaw = jest.fn().mockImplementation(async (query: { strings?: string[] }) => {
      const sql = query.strings?.join('?') ?? '';
      if (sql.includes('FOR UPDATE')) {
        return [{ id: 'intent-1' }];
      }
      return sql.includes('UPDATE "moderation_delete_intents"')
        ? [terminalIntent]
        : [autoDeleteIntent];
    });
    const transaction = jest.fn(async (callback: (tx: { $queryRaw: jest.Mock }) => unknown) =>
      callback({ $queryRaw: txQueryRaw }),
    );
    const resolveDeleteMessageBotRoute = jest.fn().mockResolvedValue(unavailableRoute);
    const getCurrentChatMemberAccess = jest.fn();
    const deleteMessage = jest.fn();
    const { service, queue } = createService(
      {},
      {
        $queryRaw: rootQueryRaw,
        $executeRaw: jest.fn().mockResolvedValue(1),
        $transaction: transaction,
      },
      { getCurrentChatMemberAccess, deleteMessage },
      {
        resolveDeleteMessageBotRoute,
        getExecutableBotById: jest.fn().mockReturnValue(null),
      },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');
    expect(result).toMatchObject({
      kind: 'terminal',
      status: 'FAILED_TERMINAL',
    });

    expect(resolveDeleteMessageBotRoute).toHaveBeenCalledTimes(1);
    expect(getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    const terminalQuery = txQueryRaw.mock.calls
      .map((call) => call[0])
      .find((query) => (query?.strings?.join('?') ?? '').includes('SET\n'));
    expect(terminalQuery?.values).toContain('bot_message_auto_delete_retry_limit_reached');
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
  });

  it('terminalizes an already-capped queued auto-delete before any external lookup', async () => {
    const autoDeleteIntent = {
      ...baseIntent,
      attemptCount: 6,
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      botMessageAutoDeleteOnly: true,
      requiredSubscriptionDeleteReason: false,
    };
    const terminalIntent = {
      ...autoDeleteIntent,
      status: 'FAILED_TERMINAL' as const,
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
      lastErrorCode: 'bot_message_auto_delete_retry_limit_reached',
    };
    const rootQueryRaw = jest.fn().mockResolvedValueOnce([autoDeleteIntent]);
    const txQueryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'intent-1' }])
      .mockResolvedValueOnce([autoDeleteIntent])
      .mockResolvedValueOnce([terminalIntent]);
    const transaction = jest.fn(async (callback: (tx: { $queryRaw: jest.Mock }) => unknown) =>
      callback({ $queryRaw: txQueryRaw }),
    );
    const resolveDeleteMessageBotRoute = jest.fn();
    const getCurrentChatMemberAccess = jest.fn();
    const deleteMessage = jest.fn();
    const { service, prisma, queue } = createService(
      {},
      { $queryRaw: rootQueryRaw, $transaction: transaction },
      { getCurrentChatMemberAccess, deleteMessage },
      { resolveDeleteMessageBotRoute },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'terminal',
      status: 'FAILED_TERMINAL',
    });

    expect(resolveDeleteMessageBotRoute).not.toHaveBeenCalled();
    expect(getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
    expect(prisma.managedBroadcastDelivery.findFirst).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rechecks coalesced required-subscription ownership before applying the cap', async () => {
    const autoDeleteIntent = {
      ...baseIntent,
      attemptCount: 5,
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      botMessageAutoDeleteOnly: true,
      requiredSubscriptionDeleteReason: false,
    };
    const mixedIntent = {
      ...autoDeleteIntent,
      botMessageAutoDeleteOnly: false,
      requiredSubscriptionDeleteReason: true,
    };
    const waitingIntent = {
      ...mixedIntent,
      status: 'WAITING_CAPABILITY' as const,
      nextAttemptAt: new Date(Date.now() + 30_000),
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
      lastErrorCode: 'no_active_membership',
    };
    const unavailableRoute = {
      ...confirmedRoute,
      primaryBotId: null,
      botId: null,
      candidateBotIds: [],
      candidateCapabilities: [],
      capabilityState: 'stale_or_unknown',
      capabilityReason: 'no_active_membership',
    } as const;
    const rootQueryRaw = jest
      .fn()
      .mockResolvedValueOnce([autoDeleteIntent])
      .mockResolvedValueOnce([waitingIntent]);
    const txQueryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'intent-1' }])
      .mockResolvedValueOnce([mixedIntent]);
    const transaction = jest.fn(async (callback: (tx: { $queryRaw: jest.Mock }) => unknown) =>
      callback({ $queryRaw: txQueryRaw }),
    );
    const executeRaw = jest.fn().mockResolvedValue(1);
    const { service, queue } = createService(
      { MODERATION_DELETE_INTENT_REQUIRED_SUBSCRIPTION_ENABLED: true },
      { $queryRaw: rootQueryRaw, $executeRaw: executeRaw, $transaction: transaction },
      {},
      {
        resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(unavailableRoute),
        getExecutableBotById: jest.fn().mockReturnValue(null),
      },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'waiting_capability',
      status: 'WAITING_CAPABILITY',
    });

    expect(txQueryRaw).toHaveBeenCalledTimes(2);
    const finishQuery = executeRaw.mock.calls
      .map((call) => call[0])
      .find((query) => (query?.strings?.join('?') ?? '').includes('"last_error_code" ='));
    expect(finishQuery?.values).toContain('no_active_membership');
    expect(finishQuery?.values).not.toContain('bot_message_auto_delete_retry_limit_reached');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('rejects executable origin-only intents without an origin bot', () => {
    const { service } = createService();

    expect(() =>
      (service as unknown as ServiceInternals).normalizeInput({
        chatId: 'chat-1',
        messageId: 'message-1',
        reasonKey: 'BOT_NOTICE_DELETE',
        entityType: 'CHAT',
        messageAuthorKind: 'bot',
        routingPolicy: 'origin_only',
      }),
    ).toThrow('originBotId is required');
  });

  it('uses the current cross-bot gate instead of a permissive stored policy', () => {
    const disabled = createService().service as unknown as ServiceInternals;
    const enabled = createService({
      MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS: 'chat-1',
    }).service as unknown as ServiceInternals;

    expect(
      disabled.orderCandidateBotIds({ ...baseIntent, routingPolicy: 'delete_capable' }, [
        'bot-2',
        'bot-1',
      ]),
    ).toEqual(['bot-1']);
    expect(
      enabled.orderCandidateBotIds({ ...baseIntent, routingPolicy: 'origin_only' }, [
        'bot-2',
        'bot-1',
      ]),
    ).toEqual(['bot-1', 'bot-2']);
    expect(
      enabled.orderCandidateBotIds(
        { ...baseIntent, entityType: 'CHANNEL', routingPolicy: 'delete_capable' },
        ['bot-2', 'bot-1'],
      ),
    ).toEqual(['bot-1']);
  });

  it('re-probes an active denied candidate after its per-intent backoff expires', async () => {
    const accessProbeStartedAt = new Date('2026-08-20T10:20:00.000Z');
    jest.useFakeTimers().setSystemTime(accessProbeStartedAt);
    const deniedRoute = {
      ...confirmedRoute,
      botId: null,
      candidateBotIds: [],
      reason: null,
      capabilityState: 'explicitly_incapable',
      capabilityReason: 'access_denied',
      candidateCapabilities: [
        {
          botId: 'bot-1',
          state: 'explicitly_incapable',
          reason: 'access_denied',
          checkedAt: new Date(Date.now() - 60_000).toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          routeEligible: false,
        },
      ],
    } as const;
    const restoredRoute = {
      ...confirmedRoute,
      candidateBotIds: ['bot-1'],
      candidateCapabilities: [confirmedRoute.candidateCapabilities[0]],
    } as const;
    const resolveDeleteMessageBotRoute = jest
      .fn()
      .mockResolvedValueOnce(deniedRoute)
      .mockResolvedValueOnce(restoredRoute);
    const getCurrentChatMemberAccess = jest.fn().mockImplementation(async () => {
      jest.setSystemTime(new Date('2026-08-20T10:20:05.000Z'));
      return {
        userId: 'bot-user-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['read_all_messages', 'write'],
      };
    });
    const { service, maxBotLink } = createService(
      {},
      {},
      { getCurrentChatMemberAccess },
      { resolveDeleteMessageBotRoute },
    );
    const intent = {
      ...baseIntent,
      routingPolicy: 'origin_only',
      candidateFailures: {
        'bot-1': {
          failedAt: new Date(Date.now() - 60_000).toISOString(),
          retryAt: new Date(Date.now() - 1_000).toISOString(),
          errorCode: 'access.denied',
          statusCode: 403,
        },
      },
    };

    const route = await (service as unknown as ServiceInternals).resolveDeleteRouteWithRefresh(
      intent,
      ownedHeartbeat,
    );

    expect(route).toEqual(restoredRoute);
    expect(getCurrentChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        botId: 'bot-1',
        bypassCache: true,
        ignoreFailureMetricStatuses: [403, 404],
      }),
    );
    expect(maxBotLink.recordBotAccessProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'bot-1',
        source: 'moderation_delete_intent_probe',
        checkedAt: accessProbeStartedAt,
      }),
    );
  });

  it.each([1, 3, 4, 6, 9, 12])(
    'reaches the last of %i standby bots across process restarts despite unknown earlier probes',
    async (count) => {
      const botIds = Array.from(
        { length: count },
        (_, index) => `bot-${String(index).padStart(2, '0')}`,
      );
      const survivor = botIds.at(-1)!;
      const route = unconfirmedDeleteRoute(botIds);
      const getCurrentChatMemberAccess = jest
        .fn()
        .mockImplementation(async (_chatId: string, options: { botId: string }) => {
          if (options.botId !== survivor)
            throw { response: { status: 503, data: { code: 'service.unavailable' } } };
          return { isAdmin: true, isOwner: false, permissionsKnown: true, permissions: ['write'] };
        });
      const recordBotAccessProbe = jest
        .fn()
        .mockImplementation(async ({ botId }: { botId: string }) => {
          route.botId = botId;
          route.candidateBotIds = [botId];
          const candidate = route.candidateCapabilities.find((value) => value.botId === botId)!;
          Object.assign(candidate, {
            state: 'confirmed_capable',
            reason: 'confirmed',
            routeEligible: true,
          });
          return true;
        });
      const deadline = new Date(Date.now() + 60_000);
      for (let attemptCount = 1; attemptCount <= Math.ceil(count / 4); attemptCount += 1) {
        // A new service has no process-local cursor. The persisted attempt is the only
        // position shared across workers, and the original work deadline stays fixed.
        const { service, prisma, maxClient } = createService(
          { MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS: 'chat-1' },
          {},
          { getCurrentChatMemberAccess },
          {
            resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(route),
            recordBotAccessProbe,
            getExecutableBotById: jest.fn((botId: string) =>
              botIds.includes(botId) ? { id: botId } : null,
            ),
          },
        );
        const before = getCurrentChatMemberAccess.mock.calls.length;
        const intent = {
          ...baseIntent,
          originBotId: botIds[0],
          retryUntilAt: deadline,
          attemptCount,
        };
        await (service as unknown as ServiceInternals).resolveDeleteRouteWithRefresh(
          intent,
          ownedHeartbeat,
        );
        expect(getCurrentChatMemberAccess.mock.calls.length - before).toBeLessThanOrEqual(4);
        expect(prisma.$executeRaw).not.toHaveBeenCalled();
        expect(maxClient.deleteMessage).not.toHaveBeenCalled();
        expect(intent.retryUntilAt).toBe(deadline);
      }
      expect(route.candidateBotIds).toEqual([survivor]);
      expect(recordBotAccessProbe).toHaveBeenCalledWith(
        expect.objectContaining({ botId: survivor }),
      );
      expect(new Set(getCurrentChatMemberAccess.mock.calls.map((call) => call[1].botId))).toEqual(
        new Set(botIds),
      );
    },
  );

  it('passes fresh negative first-four proofs to reach a later stale standby without extra MAX probes', async () => {
    const botIds = Array.from({ length: 9 }, (_, index) => `bot-${index + 1}`);
    const route = unconfirmedDeleteRoute(botIds);
    for (const candidate of route.candidateCapabilities.slice(0, 8))
      Object.assign(candidate, {
        state: 'explicitly_incapable',
        reason: 'access_denied',
        checkedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    const getCurrentChatMemberAccess = jest
      .fn()
      .mockResolvedValue({ isAdmin: true, permissionsKnown: true, permissions: ['write'] });
    const { service } = createService(
      { MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS: 'chat-1' },
      {},
      { getCurrentChatMemberAccess },
      {
        resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(route),
        getExecutableBotById: jest.fn((botId: string) =>
          botIds.includes(botId) ? { id: botId } : null,
        ),
      },
    );
    await (service as unknown as ServiceInternals).resolveDeleteRouteWithRefresh(
      baseIntent,
      ownedHeartbeat,
    );
    expect(getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(getCurrentChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ botId: 'bot-9' }),
    );
  });

  it.each([
    { status: 401, code: 'access.denied' },
    { status: 403, code: undefined },
    { status: 404, code: undefined },
    { status: 404, code: 'user.not.found' },
    { status: 503, code: 'chat.denied' },
  ])(
    'preserves grants and leaves a delete route unresolved after an ambiguous probe: %j',
    async ({ status, code }) => {
      const route = unconfirmedDeleteRoute(['bot-1']);
      const getCurrentChatMemberAccess = jest
        .fn<
          ReturnType<MaxClientService['getCurrentChatMemberAccess']>,
          Parameters<MaxClientService['getCurrentChatMemberAccess']>
        >()
        .mockRejectedValue({ response: { status, data: { code } }, message: 'chat not found' });
      const { service, maxBotLink, maxClient } = createService(
        {},
        {},
        { getCurrentChatMemberAccess },
        { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(route) },
      );

      await expect(
        (service as unknown as ServiceInternals).resolveDeleteRouteWithRefresh(
          baseIntent,
          ownedHeartbeat,
        ),
      ).resolves.toEqual(route);

      expect(getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
      expect(maxBotLink.recordBotAccessProbe).not.toHaveBeenCalled();
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    },
  );

  it.each([
    { status: 403, code: 'access.denied' },
    { status: 404, code: 'chat.not.found' },
  ])('retains confirmed exact-bot denial from a membership probe: %j', async ({ status, code }) => {
    const route = unconfirmedDeleteRoute(['bot-1']);
    const { service, maxBotLink } = createService(
      {},
      {},
      {
        getCurrentChatMemberAccess: jest
          .fn()
          .mockRejectedValue({ response: { status, data: { code } } }),
      },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(route) },
    );
    await (service as unknown as ServiceInternals).resolveDeleteRouteWithRefresh(
      baseIntent,
      ownedHeartbeat,
    );
    expect(maxBotLink.recordBotAccessProbe).toHaveBeenCalledWith({
      chatId: 'chat-1',
      botId: 'bot-1',
      access: null,
      source: 'moderation_delete_intent_probe_denied',
      checkedAt: expect.any(Date),
    });
  });

  it('respects the negative-proof cooldown boundary and never trusts a future timestamp', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-05T12:00:00Z'));
    const route = unconfirmedDeleteRoute(['bot-1']);
    Object.assign(route.candidateCapabilities[0]!, {
      state: 'explicitly_incapable',
      reason: 'access_denied',
      checkedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const getCurrentChatMemberAccess = jest.fn().mockRejectedValue({ response: { status: 403 } });
    const { service } = createService(
      { MODERATION_DELETE_INTENT_CAPABILITY_RETRY_MS: 30_000 },
      {},
      { getCurrentChatMemberAccess },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(route) },
    );
    const internals = service as unknown as ServiceInternals;
    await internals.resolveDeleteRouteWithRefresh(baseIntent, ownedHeartbeat);
    expect(getCurrentChatMemberAccess).not.toHaveBeenCalled();
    jest.setSystemTime(new Date(Date.now() + 30_000));
    await internals.resolveDeleteRouteWithRefresh(
      { ...baseIntent, attemptCount: 2 },
      ownedHeartbeat,
    );
    expect(getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
    route.candidateCapabilities[0]!.checkedAt = new Date(Date.now() + 60_000).toISOString();
    await internals.resolveDeleteRouteWithRefresh(
      { ...baseIntent, attemptCount: 3 },
      ownedHeartbeat,
    );
    expect(getCurrentChatMemberAccess).toHaveBeenCalledTimes(2);
  });

  it('keeps durable candidate backoff, origin-only routing and lifecycle exclusion while rotating probes', async () => {
    const route = unconfirmedDeleteRoute(['bot-1', 'bot-2', 'bot-3', 'bot-4', 'bot-5', 'bot-6']);
    route.candidateCapabilities[3]!.reason = 'bot_not_actionable';
    const getCurrentChatMemberAccess = jest.fn().mockRejectedValue({ response: { status: 503 } });
    const getExecutableBotById = jest.fn((botId: string) =>
      botId === 'bot-5' ? null : { id: botId },
    );
    const { service, prisma } = createService(
      { MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS: 'chat-1' },
      {},
      { getCurrentChatMemberAccess },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(route), getExecutableBotById },
    );
    const failedAt = new Date().toISOString();
    const candidateFailures = {
      'bot-2': {
        failedAt,
        retryAt: new Date(Date.now() + 60_000).toISOString(),
        errorCode: 'access.denied',
        statusCode: 403,
      },
    };
    const internals = service as unknown as ServiceInternals;
    await internals.resolveDeleteRouteWithRefresh(
      { ...baseIntent, attemptCount: 2, candidateFailures },
      ownedHeartbeat,
    );
    expect(getCurrentChatMemberAccess.mock.calls.map((call) => call[1].botId)).toEqual([
      'bot-1',
      'bot-3',
      'bot-6',
    ]);
    getCurrentChatMemberAccess.mockClear();
    const { service: originOnlyService } = createService(
      { MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS: '' },
      {},
      { getCurrentChatMemberAccess },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(route), getExecutableBotById },
    );
    await (originOnlyService as unknown as ServiceInternals).resolveDeleteRouteWithRefresh(
      { ...baseIntent, attemptCount: 3, routingPolicy: 'origin_only' },
      ownedHeartbeat,
    );
    expect(getCurrentChatMemberAccess.mock.calls.map((call) => call[1].botId)).toEqual(['bot-1']);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('fences rotated probes on a lost lease and preserves read-only reconciliation permission', async () => {
    const route = unconfirmedDeleteRoute(
      Array.from({ length: 9 }, (_, index) => `bot-${index + 1}`),
    );
    const { service, prisma, maxClient, maxBotLink } = createService(
      { MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS: 'chat-1' },
      {},
      {},
      {
        resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(route),
        getExecutableBotById: jest.fn((botId: string) =>
          route.candidateCapabilities.some((candidate) => candidate.botId === botId)
            ? { id: botId }
            : null,
        ),
      },
    );
    const internals = service as unknown as ServiceInternals;
    await expect(
      internals.resolveDeleteRouteWithRefresh(
        { ...baseIntent, attemptCount: 2 },
        { renew: jest.fn().mockResolvedValue(false), stop: jest.fn() },
      ),
    ).rejects.toMatchObject({ name: 'ModerationDeleteIntentLeaseLostError' });
    const canRead = jest.fn().mockResolvedValue(false);
    await internals.resolveDeleteRouteWithRefresh(
      { ...baseIntent, attemptCount: 3, leaseToken: null },
      ownedHeartbeat,
      canRead,
    );
    expect(canRead).toHaveBeenCalledTimes(4);
    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxBotLink.recordBotAccessProbe).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('preserves an explicit null event type so callers can suppress delete events', () => {
    const { service } = createService();
    const normalized = (service as unknown as ServiceInternals).normalizeInput({
      chatId: 'chat-1',
      messageId: 'message-1',
      reasonKey: 'ADMIN_CLEANUP',
      subjectUserId: 'user-1',
      originBotId: 'bot-1',
      event: { eventType: null },
    });

    expect(normalized.event.eventType).toBeNull();
  });

  it.each([
    {
      label: 'Major Start confirmation',
      ownerKind: 'managed_handshake',
      prismaOwner: {
        maxActionLedgerEntry: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 'major-start', remoteMessageId: 'message-1' }),
        },
      },
    },
    {
      label: 'Publik Start confirmation',
      ownerKind: 'managed_handshake',
      prismaOwner: {
        maxActionLedgerEntry: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ id: 'publisher-start', remoteMessageId: 'message-1' }),
        },
      },
    },
    {
      label: 'managed publication',
      ownerKind: 'managed_publication',
      prismaOwner: {
        managedBroadcastDelivery: {
          findFirst: jest.fn().mockResolvedValue({ id: 'delivery-1' }),
        },
      },
    },
    {
      label: 'giveaway publication',
      ownerKind: 'managed_giveaway_publication',
      prismaOwner: {
        managedGiveaway: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'giveaway-1',
            publicationMessageId: 'message-1',
            resultsMessageId: null,
          }),
        },
      },
    },
    {
      label: 'giveaway results',
      ownerKind: 'managed_giveaway_results',
      prismaOwner: {
        managedGiveaway: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'giveaway-1',
            publicationMessageId: 'publication-message',
            resultsMessageId: 'message-1',
          }),
        },
      },
    },
    {
      label: 'VK parsing post',
      ownerKind: 'vk_parsing_post',
      prismaOwner: {
        vkParsingPost: {
          findFirst: jest.fn().mockResolvedValue({ id: 'vk-post-1' }),
        },
      },
    },
    {
      label: 'published chat rules',
      ownerKind: 'published_chat_rules',
      prismaOwner: {
        chatRules: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'chat-rules-1',
            publishedMessageId: 'message-1',
          }),
        },
      },
    },
    {
      label: 'chat auto-comment replacement',
      ownerKind: 'chat_auto_comment_replacement',
      prismaOwner: {
        chatAutoCommentAttachMarker: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'chat-comment-marker-1',
            replacementMessageId: 'message-1',
            replyMessageId: null,
          }),
        },
      },
    },
    {
      label: 'chat auto-comment fallback reply',
      ownerKind: 'chat_auto_comment_reply',
      prismaOwner: {
        chatAutoCommentAttachMarker: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'chat-comment-marker-2',
            replacementMessageId: null,
            replyMessageId: 'message-1',
          }),
        },
      },
    },
    {
      label: 'persisted night-mode transition notice',
      ownerKind: 'night_mode_transition_notice',
      prismaOwner: {
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue({ id: 'night-close-event-1' }),
        },
      },
    },
  ])(
    'blocks BOT_MESSAGE_AUTO_DELETE at dispatch time for a late $label owner',
    async ({ ownerKind, prismaOwner }) => {
      const autoDeleteIntent = {
        ...baseIntent,
        messageAuthorKind: 'bot',
        routingPolicy: 'origin_only',
        botMessageAutoDeleteOnly: true,
      };
      const blockedIntent = {
        ...autoDeleteIntent,
        status: 'FAILED_TERMINAL',
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: 'managed_output_auto_delete_blocked',
        lastError: 'Managed bot output is protected',
      };
      const queryRaw = jest
        .fn()
        .mockResolvedValueOnce([autoDeleteIntent])
        .mockResolvedValueOnce([blockedIntent]);
      const executeRaw = jest.fn().mockResolvedValue(1);
      const deleteMessage = jest.fn();
      const { service, prisma, maxBotLink } = createService(
        {},
        {
          $queryRaw: queryRaw,
          $executeRaw: executeRaw,
          ...prismaOwner,
        },
        { deleteMessage },
        { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
      );

      const result = await service.executeLeasedIntent('intent-1', 'lease-1');

      expect(result).toMatchObject({
        kind: 'terminal',
        confirmed: false,
        status: 'FAILED_TERMINAL',
      });
      expect(deleteMessage).not.toHaveBeenCalled();
      expect(maxBotLink.resolveDeleteMessageBotRoute).not.toHaveBeenCalled();
      const loadQuery = queryRaw.mock.calls[0]?.[0] as { strings?: readonly string[] } | undefined;
      expect(loadQuery?.strings?.join('?')).toContain('AS "botMessageAutoDeleteOnly"');
      const guardQuery = executeRaw.mock.calls
        .map(([query]) => query as { strings?: readonly string[]; values?: readonly unknown[] })
        .find((query) =>
          (query.strings?.join('?') ?? '').includes('managed_output_auto_delete_blocked'),
        );
      expect(guardQuery).toBeDefined();
      expect(guardQuery?.strings?.join('?')).toContain('other_reason."rule_code" NOT IN');
      expect(guardQuery?.values).toEqual(
        expect.arrayContaining(['BOT_MESSAGE_AUTO_DELETE', COMMERCIAL_OCR_DELETE_RULE_CODE]),
      );
      expect(
        executeRaw.mock.calls.some(([query]) =>
          ((query as { values?: readonly unknown[] }).values ?? []).some(
            (value) => typeof value === 'string' && value.includes(ownerKind),
          ),
        ),
      ).toBe(true);
      if (ownerKind === 'night_mode_transition_notice') {
        expect(prisma.moderationEvent.findFirst).toHaveBeenCalledWith({
          where: {
            chatId: 'chat-1',
            messageId: 'message-1',
            ruleCode: {
              in: ['NIGHT_MODE_CLOSE_NOTICE', 'NIGHT_MODE_OPEN_NOTICE'],
            },
          },
          select: { id: true },
        });
      }
    },
  );

  it('blocks BOT_MESSAGE_AUTO_DELETE for a fresh matching publication send fence', async () => {
    const autoDeleteIntent = {
      ...baseIntent,
      entityType: 'CHAT' as const,
      originBotId: 'publisher-bot-1',
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      botMessageAutoDeleteOnly: true,
    };
    const blockedIntent = {
      ...autoDeleteIntent,
      status: 'FAILED_TERMINAL' as const,
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: 'managed_output_auto_delete_blocked',
      lastError: 'Managed publication send is still in flight',
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([autoDeleteIntent])
      .mockResolvedValueOnce([blockedIntent]);
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'delivery-in-flight-1', remoteMessageId: null });
    const deleteMessage = jest.fn();
    const resolveDeleteMessageBotRoute = jest.fn();
    const { service } = createService(
      {},
      {
        $queryRaw: queryRaw,
        $executeRaw: jest.fn().mockResolvedValue(1),
        managedBroadcastDelivery: { findFirst },
      },
      { deleteMessage },
      { resolveDeleteMessageBotRoute },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'terminal',
      confirmed: false,
      status: 'FAILED_TERMINAL',
    });

    expect(findFirst).toHaveBeenNthCalledWith(1, {
      where: { targetChatId: 'chat-1', remoteMessageId: 'message-1' },
      select: { id: true },
    });
    expect(findFirst).toHaveBeenNthCalledWith(2, {
      where: {
        targetChatId: 'chat-1',
        OR: [
          { remoteMessageId: 'message-1' },
          {
            botId: 'publisher-bot-1',
            remoteMessageId: null,
            broadcast: { is: { entityType: 'CHAT' } },
            OR: [
              {
                status: 'SENDING',
                lockedAt: { gt: expect.any(Date) },
              },
              {
                status: 'AMBIGUOUS',
                updatedAt: {
                  gte: expect.any(Date),
                  lte: expect.any(Date),
                },
              },
            ],
          },
        ],
      },
      select: { id: true, remoteMessageId: true },
    });
    expect(resolveDeleteMessageBotRoute).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it('uses a strict freshness window for the durable publication send fence', async () => {
    const nowMs = Date.parse('2026-09-01T09:00:00.000Z');
    const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(nowMs);
    const findFirst = jest.fn().mockResolvedValue(null);
    const { service } = createService({}, { managedBroadcastDelivery: { findFirst } });

    let owner: { id: string; kind: string } | null;
    try {
      owner = await (service as unknown as ServiceInternals).findManagedBotMessageOwner({
        chatId: 'chat-1',
        messageId: 'ordinary-bot-message-1',
        sourceMessageAt: new Date(nowMs),
        entityType: 'CHAT',
        originBotId: 'publisher-bot-1',
      });
    } finally {
      dateNowSpy.mockRestore();
    }

    expect(owner).toBeNull();
    expect(findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              OR: expect.arrayContaining([
                expect.objectContaining({
                  lockedAt: { gt: new Date(nowMs - MAX_SEND_FENCE_STALE_MS) },
                }),
                expect.objectContaining({
                  status: 'AMBIGUOUS',
                  updatedAt: {
                    gte: new Date(nowMs - MAX_SEND_FENCE_STALE_MS),
                    lte: new Date(nowMs + MAX_SEND_FENCE_STALE_MS),
                  },
                }),
              ]),
            }),
          ]),
        }),
      }),
    );
  });

  it.each(['transition notice', 'Start confirmation'])(
    'blocks a %s that becomes protected inside the final MAX delete guard',
    async (messageKind) => {
      const autoDeleteIntent = {
        ...baseIntent,
        messageAuthorKind: 'bot',
        routingPolicy: 'origin_only',
        botMessageAutoDeleteOnly: true,
      };
      const blockedIntent = {
        ...autoDeleteIntent,
        status: 'FAILED_TERMINAL',
        leaseToken: null,
        leaseExpiresAt: null,
        lastErrorCode: 'managed_output_auto_delete_blocked',
        lastError: 'Night mode transition notice is protected',
      };
      const queryRaw = jest
        .fn()
        .mockResolvedValueOnce([autoDeleteIntent])
        .mockResolvedValueOnce([blockedIntent]);
      const transitionEventLookup = jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'night-close-event-1' });
      const deleteMessageOverride = jest.fn();
      const { service, prisma, maxBotLink } = createService(
        {},
        {
          $queryRaw: queryRaw,
          $executeRaw: jest.fn().mockResolvedValue(1),
          ...(messageKind === 'transition notice'
            ? { moderationEvent: { findFirst: transitionEventLookup } }
            : {
                maxActionLedgerEntry: {
                  findFirst: jest
                    .fn()
                    .mockResolvedValueOnce(null)
                    .mockResolvedValueOnce(null)
                    .mockResolvedValue({ id: 'start-receipt', remoteMessageId: 'message-1' }),
                },
              }),
        },
        { deleteMessage: deleteMessageOverride },
        { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
      );

      await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
        kind: 'terminal',
        confirmed: false,
        status: 'FAILED_TERMINAL',
      });

      if (messageKind === 'transition notice')
        expect(transitionEventLookup).toHaveBeenCalledTimes(2);
      else expect(prisma.maxActionLedgerEntry.findFirst).toHaveBeenCalledTimes(3);
      expect(maxBotLink.resolveDeleteMessageBotRoute).toHaveBeenCalledTimes(1);
      expect(deleteMessageOverride).not.toHaveBeenCalled();
      const executedSql = prisma.$executeRaw.mock.calls
        .map((call: unknown[]) => {
          const query = call[0] as { strings?: readonly string[] };
          return query.strings?.join('?') ?? '';
        })
        .join('\n');
      expect(executedSql).not.toContain('"delete_dispatch_started_at" = CURRENT_TIMESTAMP');
    },
  );

  it('keeps BOT_MESSAGE_AUTO_DELETE ambiguous until MAX confirms exact absence', async () => {
    const autoDeleteIntent = {
      ...baseIntent,
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      botMessageAutoDeleteOnly: true,
    };
    const pendingVerificationIntent = {
      ...autoDeleteIntent,
      status: 'AMBIGUOUS',
      lastBotId: 'bot-1',
      remoteDeleteSucceededAt: new Date(),
      remoteDeleteSucceededBotId: 'bot-1',
      nextAttemptAt: new Date(Date.now() + 5_000),
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
      lastErrorCode: 'bot_message_auto_delete_success_verification_pending',
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([autoDeleteIntent])
      .mockResolvedValueOnce([pendingVerificationIntent]);
    const deleteMessage = jest.fn().mockResolvedValue(undefined);
    const { service, prisma } = createService(
      {},
      {
        $queryRaw: queryRaw,
        $executeRaw: jest.fn().mockResolvedValue(1),
      },
      { deleteMessage },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'ambiguous', confirmed: false, status: 'AMBIGUOUS' });
    expect(prisma.managedBroadcastDelivery.findFirst).toHaveBeenCalledTimes(4);
    expect(prisma.managedGiveaway.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.vkParsingPost.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.chatRules.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.chatAutoCommentAttachMarker.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.findFirst).toHaveBeenCalledTimes(2);
    expect(deleteMessage).toHaveBeenCalledWith(
      'chat-1',
      'message-1',
      expect.objectContaining({ botId: 'bot-1', immediate: true }),
    );
    const pendingVerificationQuery = prisma.$executeRaw.mock.calls
      .map(
        (call: unknown[]) =>
          call[0] as { strings?: readonly string[]; values?: readonly unknown[] },
      )
      .find((query) =>
        query.values?.includes('bot_message_auto_delete_success_verification_pending'),
      );
    expect(pendingVerificationQuery?.strings?.join('?') ?? '').toContain(
      'CAST(\'AMBIGUOUS\' AS "ModerationDeleteIntentStatus")',
    );
    expect(pendingVerificationQuery?.strings?.join('?') ?? '').toContain(
      '"remote_delete_succeeded_at" = COALESCE',
    );
  });

  it.each([false, true])(
    'completes acknowledged BOT_MESSAGE_AUTO_DELETE only after exact absence (expired horizon: %s)',
    async (expiredHorizon) => {
      const pendingVerificationIntent = {
        ...baseIntent,
        attemptCount: 2,
        retryUntilAt: new Date(Date.now() + (expiredHorizon ? -1_000 : 60_000)),
        messageAuthorKind: 'bot',
        routingPolicy: 'origin_only',
        botMessageAutoDeleteOnly: true,
        remoteDeleteSucceededAt: new Date(Date.now() - 5_000),
        remoteDeleteSucceededBotId: 'bot-1',
        leasedFromStatus: 'AMBIGUOUS',
      };
      const completedIntent = {
        ...pendingVerificationIntent,
        status: 'SUCCEEDED',
        lastBotId: 'bot-1',
        succeededBotId: 'bot-1',
        absenceVerifiedAt: new Date(),
        absenceVerifiedBotId: 'bot-1',
        absenceVerificationCode: 'post_success_exact_absence',
        leaseToken: null,
        leaseExpiresAt: null,
        leasedFromStatus: null,
      };
      const queryRaw = jest
        .fn()
        .mockResolvedValueOnce([pendingVerificationIntent])
        .mockResolvedValueOnce([completedIntent]);
      const txExecuteRaw = jest.fn().mockResolvedValue(1);
      const transaction = jest.fn(
        async (callback: (tx: { $executeRaw: jest.Mock }) => Promise<unknown>) =>
          callback({ $executeRaw: txExecuteRaw }),
      );
      const deleteMessage = jest.fn();
      const getExactMessagePresence = jest.fn().mockResolvedValue('absent');
      const { service } = createService(
        {},
        {
          $queryRaw: queryRaw,
          $executeRaw: jest.fn().mockResolvedValue(1),
          $transaction: transaction,
        },
        { deleteMessage, getExactMessagePresence },
        { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
      );

      await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
        kind: 'confirmed',
        confirmed: true,
        status: 'SUCCEEDED',
        botId: 'bot-1',
      });

      expect(getExactMessagePresence).toHaveBeenCalledWith(
        'chat-1',
        'message-1',
        expect.objectContaining({
          botId: 'bot-1',
          bypassCache: true,
          ignoreFailureMetricStatuses: [403, 404],
        }),
      );
      expect(deleteMessage).not.toHaveBeenCalled();
      const completionQuery = txExecuteRaw.mock.calls[0]?.[0] as
        | { strings?: readonly string[]; values?: readonly unknown[] }
        | undefined;
      expect(completionQuery?.strings?.join('?') ?? '').toContain(
        '"absence_verified_at" = COALESCE',
      );
      expect(completionQuery?.values).toContain('post_success_exact_absence');
    },
  );

  it('clears an acknowledged auto-delete marker and retries when the exact message is present', async () => {
    const pendingVerificationIntent = {
      ...baseIntent,
      attemptCount: 2,
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      botMessageAutoDeleteOnly: true,
      remoteDeleteSucceededAt: new Date(Date.now() - 5_000),
      remoteDeleteSucceededBotId: 'bot-1',
      leasedFromStatus: 'AMBIGUOUS',
    };
    const retriedVerificationIntent = {
      ...pendingVerificationIntent,
      status: 'AMBIGUOUS',
      lastBotId: 'bot-1',
      nextAttemptAt: new Date(Date.now() + 10_000),
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
      lastErrorCode: 'bot_message_auto_delete_success_verification_pending',
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([pendingVerificationIntent])
      .mockResolvedValueOnce([retriedVerificationIntent]);
    const executeRaw = jest.fn().mockResolvedValue(1);
    const deleteMessage = jest.fn().mockResolvedValue(undefined);
    const getExactMessagePresence = jest.fn().mockResolvedValue('present');
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: executeRaw },
      { deleteMessage, getExactMessagePresence },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'ambiguous',
      confirmed: false,
      status: 'AMBIGUOUS',
    });

    expect(getExactMessagePresence).toHaveBeenCalledWith(
      'chat-1',
      'message-1',
      expect.objectContaining({ botId: 'bot-1' }),
    );
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(deleteMessage).toHaveBeenCalledWith(
      'chat-1',
      'message-1',
      expect.objectContaining({
        botId: 'bot-1',
        idempotencyKey: 'moderation-delete-intent-intent-1-attempt-2',
      }),
    );
    const executedQueries = executeRaw.mock.calls.map(
      (call: unknown[]) => call[0] as { strings?: readonly string[]; values?: readonly unknown[] },
    );
    const executedSql = executedQueries.map((query) => query.strings?.join('?') ?? '').join('\n');
    expect(executedSql).toContain('"remote_delete_succeeded_at" = NULL');
    expect(
      executedQueries.some((query) =>
        query.values?.includes('bot_message_auto_delete_success_still_present'),
      ),
    ).toBe(true);
    expect(
      executedQueries.some((query) =>
        query.values?.includes('bot_message_auto_delete_success_verification_pending'),
      ),
    ).toBe(true);
  });

  it('preserves acknowledged auto-delete evidence when exact presence is unknown', async () => {
    const pendingVerificationIntent = {
      ...baseIntent,
      attemptCount: 2,
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      botMessageAutoDeleteOnly: true,
      remoteDeleteSucceededAt: new Date(Date.now() - 5_000),
      remoteDeleteSucceededBotId: 'bot-1',
      leasedFromStatus: 'AMBIGUOUS',
    };
    const stillAmbiguousIntent = {
      ...pendingVerificationIntent,
      status: 'AMBIGUOUS',
      nextAttemptAt: new Date(Date.now() + 10_000),
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
      lastErrorCode: 'predelete_presence_unknown',
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([pendingVerificationIntent])
      .mockResolvedValueOnce([stillAmbiguousIntent]);
    const executeRaw = jest.fn().mockResolvedValue(1);
    const deleteMessage = jest.fn();
    const getExactMessagePresence = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('lookup timeout'), { code: 'ETIMEDOUT' }));
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: executeRaw },
      { deleteMessage, getExactMessagePresence },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'ambiguous',
      confirmed: false,
      status: 'AMBIGUOUS',
    });

    expect(deleteMessage).not.toHaveBeenCalled();
    const executedSql = executeRaw.mock.calls
      .map((call: unknown[]) => {
        const query = call[0] as { strings?: readonly string[] };
        return query.strings?.join('?') ?? '';
      })
      .join('\n');
    expect(executedSql).not.toContain('"remote_delete_succeeded_at" = NULL');
  });

  it.each([
    ['expired complete acknowledgement', {}, 3_600_000],
    ['active horizon', { activeHorizon: true }, 300_000],
    ['horizon expires after lock decision', { horizonCrossesWhilePersisting: true }, 300_000],
    ['acknowledgement timestamp only', { remoteDeleteSucceededBotId: null }, 300_000],
    ['acknowledgement bot only', { remoteDeleteSucceededAt: null }, 300_000],
    ['blank acknowledgement bot', { remoteDeleteSucceededBotId: ' ' }, 300_000],
    ['invalid acknowledgement timestamp', { invalidAcknowledgement: true }, 300_000],
    ['future acknowledgement timestamp', { futureAcknowledgement: true }, 300_000],
    ['invalid horizon', { invalidHorizon: true }, 300_000],
    ['independent reason', { botMessageAutoDeleteOnly: false }, 300_000],
    ['subscription reason', { requiredSubscriptionDeleteReason: true }, 300_000],
    ['replacement cleanup', { replacementCleanup: true }, 300_000],
    ['OCR reason', { commercialOcrDeleteReason: true }, 300_000],
    ['longer remote retry hint', { requestedDelayMs: 7_200_000 }, 7_200_000],
  ] as const)(
    'preserves verification evidence and retry scope for %s',
    async (_label, overrides, expectedDelayMs) => {
      const now = new Date('2026-10-20T12:00:00.000Z');
      jest.useFakeTimers().setSystemTime(now);
      const options: {
        activeHorizon?: boolean;
        horizonCrossesWhilePersisting?: boolean;
        requestedDelayMs?: number;
        invalidAcknowledgement?: boolean;
        futureAcknowledgement?: boolean;
        invalidHorizon?: boolean;
        remoteDeleteSucceededAt?: null;
        remoteDeleteSucceededBotId?: string | null;
        botMessageAutoDeleteOnly?: false;
        requiredSubscriptionDeleteReason?: true;
        replacementCleanup?: true;
        commercialOcrDeleteReason?: true;
      } = overrides;
      const {
        activeHorizon,
        horizonCrossesWhilePersisting,
        requestedDelayMs,
        invalidAcknowledgement,
        futureAcknowledgement,
        invalidHorizon,
        ...intentOverrides
      } = options;
      const intent = {
        ...baseIntent,
        attemptCount: 44,
        messageAuthorKind: 'bot',
        routingPolicy: 'origin_only',
        botMessageAutoDeleteOnly: true,
        remoteDeleteSucceededAt: new Date(
          invalidAcknowledgement
            ? Number.NaN
            : now.getTime() + (futureAcknowledgement ? 1_000 : -60_000),
        ),
        remoteDeleteSucceededBotId: 'bot-1',
        retryUntilAt: new Date(
          invalidHorizon
            ? Number.NaN
            : now.getTime() + (horizonCrossesWhilePersisting ? 0 : activeHorizon ? 60_000 : -1_000),
        ),
        ...intentOverrides,
      };
      const nextAttemptAt = new Date(now.getTime() + expectedDelayMs);
      const persisted = {
        ...intent,
        status: 'AMBIGUOUS',
        nextAttemptAt,
        leaseToken: null,
        leaseExpiresAt: null,
      };
      const executeRaw = jest.fn().mockResolvedValue(1);
      const transaction = jest.fn(
        async (
          callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => Promise<unknown>,
        ) =>
          callback({
            $queryRaw: jest
              .fn()
              .mockResolvedValueOnce([{ id: intent.id }])
              .mockResolvedValueOnce([intent]),
            $executeRaw: executeRaw,
          }),
      );
      const { service } = createService(
        {},
        {
          $executeRaw: executeRaw,
          $queryRaw: jest.fn().mockResolvedValue([persisted]),
          $transaction: transaction,
        },
      );

      const clock = horizonCrossesWhilePersisting
        ? jest
            .spyOn(Date, 'now')
            .mockReturnValueOnce(now.getTime() - 1)
            .mockReturnValue(now.getTime())
        : undefined;
      try {
        await expect(
          (service as unknown as ServiceInternals).finishRetryableAttempt(intent, 'lease-1', {
            status: 'WAITING_CAPABILITY',
            statusCode: 404,
            errorCode: 'predelete_presence_unknown',
            message: 'Exact presence is unavailable',
            retryDelayMs: requestedDelayMs ?? 300_000,
          }),
        ).resolves.toMatchObject({ status: 'AMBIGUOUS' });
      } finally {
        clock?.mockRestore();
      }

      const query = executeRaw.mock.calls[0]?.[0] as {
        strings: readonly string[];
        values: readonly unknown[];
      };
      expect(query.values).toContainEqual(nextAttemptAt);
      expect(query.values).toContain('AMBIGUOUS');
      const sql = query.strings.join('?');
      expect(sql).not.toContain('"retry_until_at" =');
      expect(sql).not.toContain('"remote_delete_succeeded_at" =');
      expect(sql).not.toContain('"remote_delete_succeeded_bot_id" =');
      expect(sql).not.toContain('"delete_dispatch_started_at" =');
      expect(sql).not.toContain('"delete_dispatch_started_bot_id" =');
      expect(transaction).toHaveBeenCalledTimes(
        ['expired complete acknowledgement', 'longer remote retry hint'].includes(_label) ? 1 : 0,
      );
    },
  );

  it('backs off an expired acknowledged auto-delete after a generic 404 without confirming it', async () => {
    const now = new Date('2026-10-20T12:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    const intent = {
      ...baseIntent,
      attemptCount: 44,
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      botMessageAutoDeleteOnly: true,
      remoteDeleteSucceededAt: new Date(now.getTime() - 86_400_000),
      remoteDeleteSucceededBotId: 'bot-1',
      retryUntilAt: new Date(now.getTime() - 1_000),
      leaseExpiresAt: new Date(now.getTime() + 60_000),
      leasedFromStatus: 'AMBIGUOUS',
    };
    const nextAttemptAt = new Date(now.getTime() + 3_600_000);
    const persisted = {
      ...intent,
      status: 'AMBIGUOUS',
      nextAttemptAt,
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const executeRaw = jest.fn().mockResolvedValue(1);
    const deleteMessage = jest.fn();
    const getExactMessagePresence = jest
      .fn()
      .mockRejectedValue({ response: { status: 404, data: { message: 'Not found' } } });
    const transaction = jest.fn(
      async (
        callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => Promise<unknown>,
      ) =>
        callback({
          $queryRaw: jest
            .fn()
            .mockResolvedValueOnce([{ id: intent.id }])
            .mockResolvedValueOnce([intent]),
          $executeRaw: executeRaw,
        }),
    );
    const { service } = createService(
      {},
      {
        $executeRaw: executeRaw,
        $queryRaw: jest.fn().mockResolvedValueOnce([intent]).mockResolvedValue([persisted]),
        $transaction: transaction,
      },
      { deleteMessage, getExactMessagePresence },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'ambiguous',
      confirmed: false,
      status: 'AMBIGUOUS',
    });

    expect(getExactMessagePresence).toHaveBeenCalledTimes(1);
    expect(deleteMessage).not.toHaveBeenCalled();
    const retryQuery = executeRaw.mock.calls
      .map(
        (call: unknown[]) => call[0] as { strings: readonly string[]; values: readonly unknown[] },
      )
      .find((query) => query.strings.join('?').includes('"next_attempt_at" = CASE'));
    expect(retryQuery?.values).toContainEqual(nextAttemptAt);
    expect(retryQuery?.values).toContain('AMBIGUOUS');
  });

  it('does not verify or retry auto-delete after losing its lease', async () => {
    const pendingVerificationIntent = {
      ...baseIntent,
      attemptCount: 2,
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      botMessageAutoDeleteOnly: true,
      remoteDeleteSucceededAt: new Date(Date.now() - 5_000),
      remoteDeleteSucceededBotId: 'bot-1',
      leasedFromStatus: 'AMBIGUOUS',
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([pendingVerificationIntent])
      .mockResolvedValueOnce([pendingVerificationIntent]);
    const executeRaw = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const deleteMessage = jest.fn();
    const getExactMessagePresence = jest.fn();
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: executeRaw },
      { deleteMessage, getExactMessagePresence },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'pending',
      confirmed: false,
      status: 'IN_PROGRESS',
    });

    expect(getExactMessagePresence).not.toHaveBeenCalled();
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'uses a sixth auto-delete claim only to verify and never dispatches a sixth DELETE (expired horizon: %s)',
    async (expiredHorizon) => {
      const pendingVerificationIntent = {
        ...baseIntent,
        attemptCount: 6,
        retryUntilAt: new Date(Date.now() + (expiredHorizon ? -1_000 : 60_000)),
        messageAuthorKind: 'bot',
        routingPolicy: 'origin_only',
        botMessageAutoDeleteOnly: true,
        remoteDeleteSucceededAt: new Date(Date.now() - 5_000),
        remoteDeleteSucceededBotId: 'bot-1',
        leasedFromStatus: 'AMBIGUOUS',
      };
      const clearedIntent = {
        ...pendingVerificationIntent,
        remoteDeleteSucceededAt: null,
        remoteDeleteSucceededBotId: null,
      };
      const terminalIntent = {
        ...clearedIntent,
        status: 'FAILED_TERMINAL',
        lastErrorCode: 'bot_message_auto_delete_retry_limit_reached',
        leaseToken: null,
        leaseExpiresAt: null,
        leasedFromStatus: null,
      };
      const rootQueryRaw = jest.fn().mockResolvedValueOnce([pendingVerificationIntent]);
      const txQueryRaw = jest
        .fn()
        .mockResolvedValueOnce([{ id: 'intent-1' }])
        .mockResolvedValueOnce([clearedIntent])
        .mockResolvedValueOnce([terminalIntent]);
      const transaction = jest.fn(async (callback: (tx: { $queryRaw: jest.Mock }) => unknown) =>
        callback({ $queryRaw: txQueryRaw }),
      );
      const deleteMessage = jest.fn();
      const getExactMessagePresence = jest.fn().mockResolvedValue('present');
      const { service } = createService(
        {},
        {
          $queryRaw: rootQueryRaw,
          $executeRaw: jest.fn().mockResolvedValue(1),
          $transaction: transaction,
        },
        { deleteMessage, getExactMessagePresence },
        { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
      );

      await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
        kind: 'terminal',
        confirmed: false,
        status: 'FAILED_TERMINAL',
      });

      expect(getExactMessagePresence).toHaveBeenCalledTimes(1);
      expect(deleteMessage).not.toHaveBeenCalled();
      expect(txQueryRaw.mock.calls[2]?.[0]?.values).toContain(
        'bot_message_auto_delete_retry_limit_reached',
      );
    },
  );

  it('does not dispatch auto-delete when the managed delivery guard cannot be read', async () => {
    const autoDeleteIntent = {
      ...baseIntent,
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      botMessageAutoDeleteOnly: true,
    };
    const retryableIntent = {
      ...autoDeleteIntent,
      status: 'RETRYABLE',
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: 'delete_failed',
      lastError: 'publication delivery lookup failed',
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([autoDeleteIntent])
      .mockResolvedValueOnce([retryableIntent]);
    const findFirst = jest.fn().mockRejectedValue(new Error('publication delivery lookup failed'));
    const deleteMessage = jest.fn();
    const { service } = createService(
      {},
      {
        $queryRaw: queryRaw,
        $executeRaw: jest.fn().mockResolvedValue(1),
        managedBroadcastDelivery: { findFirst },
      },
      { deleteMessage },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'pending', confirmed: false, status: 'RETRYABLE' });
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it('allows a managed bot message delete when another executable reason shares the intent', async () => {
    const mixedReasonIntent = {
      ...baseIntent,
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      botMessageAutoDeleteOnly: false,
    };
    const completedIntent = {
      ...mixedReasonIntent,
      status: 'SUCCEEDED',
      lastBotId: 'bot-1',
      succeededBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([mixedReasonIntent])
      .mockResolvedValueOnce([completedIntent]);
    const deleteMessage = jest.fn().mockResolvedValue(undefined);
    const { service, prisma } = createService(
      {},
      {
        $queryRaw: queryRaw,
        $executeRaw: jest.fn().mockResolvedValue(1),
        managedBroadcastDelivery: {
          findFirst: jest.fn().mockResolvedValue({ id: 'delivery-1' }),
        },
      },
      { deleteMessage },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'confirmed',
      confirmed: true,
      status: 'SUCCEEDED',
    });
    expect(prisma.managedBroadcastDelivery.findFirst).not.toHaveBeenCalled();
    expect(deleteMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps immediate success finalization for an auto-delete intent mixed with OCR', async () => {
    const mixedReasonIntent = {
      ...baseIntent,
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      botMessageAutoDeleteOnly: true,
      commercialOcrGuardRequired: true,
      commercialOcrDeleteReason: true,
    };
    const completedIntent = {
      ...mixedReasonIntent,
      status: 'SUCCEEDED',
      lastBotId: 'bot-1',
      succeededBotId: 'bot-1',
      remoteDeleteSucceededAt: new Date(),
      remoteDeleteSucceededBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([mixedReasonIntent])
      .mockResolvedValueOnce([completedIntent]);
    const deleteMessage = jest.fn().mockResolvedValue(undefined);
    const { service, prisma } = createService(
      {},
      {
        $queryRaw: queryRaw,
        $executeRaw: jest.fn().mockResolvedValue(1),
      },
      { deleteMessage },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'confirmed',
      confirmed: true,
      status: 'SUCCEEDED',
    });

    expect(deleteMessage).toHaveBeenCalledTimes(1);
    const executedSql = prisma.$executeRaw.mock.calls
      .map((call: unknown[]) => {
        const query = call[0] as { strings?: readonly string[] };
        return query.strings?.join('?') ?? '';
      })
      .join('\n');
    expect(executedSql).not.toContain('bot_message_auto_delete_success_verification_pending');
  });

  it('allows NIGHT_MODE_CLOSE_NOTICE_CLEANUP for a persisted close notice', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T06:12:00.000Z'));
    const settings = nightModeCleanupSettings();
    const binding = nightModeCleanupBinding(settings);
    const cleanupIntent = {
      ...baseIntent,
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      botMessageAutoDeleteOnly: false,
      nightModeCloseNoticeCleanupReason: true,
      nightModeCloseNoticeCleanupOnly: true,
      nightModeCloseNoticeCleanupBinding: binding,
    };
    const completedIntent = {
      ...cleanupIntent,
      status: 'SUCCEEDED',
      lastBotId: 'bot-1',
      succeededBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([cleanupIntent])
      .mockResolvedValueOnce([completedIntent]);
    const deleteMessage = jest.fn().mockResolvedValue(undefined);
    const transitionEventLookup = jest.fn().mockResolvedValue({ id: 'night-close-event-1' });
    const { service } = createService(
      {},
      {
        $queryRaw: queryRaw,
        $executeRaw: jest.fn().mockResolvedValue(1),
        moderationEvent: { findFirst: transitionEventLookup },
        chatSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
      },
      { deleteMessage },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'confirmed',
      confirmed: true,
      status: 'SUCCEEDED',
    });
    expect(transitionEventLookup).toHaveBeenCalledTimes(3);
    expect(deleteMessage).toHaveBeenCalledTimes(1);
  });

  it('reconstructs and CAS-persists an exact legacy unbound night cleanup binding once', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T06:12:00.000Z'));
    const settings = nightModeCleanupSettings();
    const legacyIntent = {
      ...baseIntent,
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      nightModeCloseNoticeCleanupReason: true,
      nightModeCloseNoticeCleanupOnly: true,
      nightModeCloseNoticeCleanupBinding: null,
    };
    const exactEvent = {
      id: 'night-close-event-legacy-1',
      messageId: legacyIntent.messageId,
      botId: legacyIntent.originBotId,
      metadata: {
        sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
      },
    };
    const executeRaw = jest.fn().mockResolvedValue(1);
    const findMany = jest.fn().mockResolvedValue([exactEvent]);
    const findFirst = jest.fn().mockResolvedValue({ id: exactEvent.id });
    const { service } = createService(
      {},
      {
        $executeRaw: executeRaw,
        moderationEvent: { findMany, findFirst },
        chatSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
      },
    );

    await expect(
      (service as any).assertNightModeCloseNoticeCleanupStillAuthorized(legacyIntent),
    ).resolves.toBeUndefined();
    await expect(
      (service as any).assertNightModeCloseNoticeCleanupStillAuthorized(legacyIntent),
    ).resolves.toBeUndefined();

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        messageId: 'message-1',
        botId: 'bot-1',
        ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
        metadata: {
          path: ['sessionKey'],
          equals: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
        },
      },
      select: { id: true, messageId: true, botId: true, metadata: true },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 2,
    });
    expect(executeRaw).toHaveBeenCalledTimes(1);
    const backfillQuery = executeRaw.mock.calls[0]?.[0];
    expect(backfillQuery?.strings?.join('?') ?? '').toContain('jsonb_set');
    expect(backfillQuery?.strings?.join('?') ?? '').toContain('parent."lease_token" =');
    expect(backfillQuery?.strings?.join('?') ?? '').toContain(
      'reason."metadata"->\'nightModeCloseNoticeCleanup\' IS NULL',
    );
    expect(backfillQuery?.strings?.join('?') ?? '').toContain('"updated_at" = CURRENT_TIMESTAMP');
    expect(backfillQuery?.values).toEqual(
      expect.arrayContaining([
        'intent-1',
        'lease-1',
        'NIGHT_MODE_CLOSE_NOTICE_CLEANUP',
        expect.stringContaining('night-close-event-legacy-1'),
      ]),
    );
    expect(legacyIntent.nightModeCloseNoticeCleanupBinding).toEqual(
      expect.objectContaining({
        version: 1,
        event: expect.objectContaining({ id: 'night-close-event-legacy-1' }),
      }),
    );
    expect(findFirst).toHaveBeenCalledTimes(2);
  });

  it('accepts a concurrent identical legacy binding backfill after losing the CAS', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T06:12:00.000Z'));
    const settings = nightModeCleanupSettings();
    const binding = nightModeCleanupBinding(settings);
    const legacyIntent = {
      ...baseIntent,
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      nightModeCloseNoticeCleanupReason: true,
      nightModeCloseNoticeCleanupOnly: true,
      nightModeCloseNoticeCleanupBinding: null,
    };
    const executeRaw = jest.fn().mockResolvedValue(0);
    const { service } = createService(
      {},
      {
        $executeRaw: executeRaw,
        moderationEvent: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: binding.event.id,
              messageId: binding.event.messageId,
              botId: 'bot-1',
              metadata: { sessionKey: binding.sessionKey },
            },
          ]),
          findFirst: jest.fn().mockResolvedValue({ id: binding.event.id }),
        },
        moderationDeleteIntentReason: {
          findFirst: jest.fn().mockResolvedValue({
            metadata: {
              retainedLegacyKey: 'keep-me',
              nightModeCloseNoticeCleanup: binding,
            },
          }),
        },
        chatSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
      },
    );

    await expect(
      (service as any).assertNightModeCloseNoticeCleanupStillAuthorized(legacyIntent),
    ).resolves.toBeUndefined();

    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(legacyIntent.nightModeCloseNoticeCleanupBinding).toEqual(binding);
  });

  it.each([
    ['missing', []],
    [
      'ambiguous',
      [
        {
          id: 'night-close-event-legacy-1',
          messageId: 'message-1',
          botId: 'bot-1',
          metadata: { sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30' },
        },
        {
          id: 'night-close-event-legacy-2',
          messageId: 'message-1',
          botId: 'bot-1',
          metadata: { sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30' },
        },
      ],
    ],
  ])('rejects an unproven legacy night cleanup with %s event evidence', async (_label, events) => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T06:12:00.000Z'));
    const executeRaw = jest.fn();
    const { service, maxClient } = createService(
      {},
      {
        $executeRaw: executeRaw,
        moderationEvent: {
          findMany: jest.fn().mockResolvedValue(events),
          findFirst: jest.fn(),
        },
        chatSettings: { findUnique: jest.fn().mockResolvedValue(nightModeCleanupSettings()) },
      },
    );
    const legacyIntent = {
      ...baseIntent,
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      nightModeCloseNoticeCleanupReason: true,
      nightModeCloseNoticeCleanupOnly: true,
      nightModeCloseNoticeCleanupBinding: null,
    };

    await expect(
      (service as any).assertNightModeCloseNoticeCleanupStillAuthorized(legacyIntent),
    ).rejects.toThrow('event proof is missing or ambiguous');

    expect(executeRaw).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('keeps bound night cleanup valid after an unrelated setting update', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T06:12:00.000Z'));
    const originalSettings = nightModeCleanupSettings();
    const currentSettings = {
      ...originalSettings,
      antiSpamEnabled: true,
      updatedAt: new Date('2026-05-31T06:00:00.000Z'),
    };
    const cleanupIntent = {
      ...baseIntent,
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      botMessageAutoDeleteOnly: false,
      nightModeCloseNoticeCleanupReason: true,
      nightModeCloseNoticeCleanupOnly: true,
      nightModeCloseNoticeCleanupBinding: nightModeCleanupBinding(originalSettings),
    };
    const completedIntent = {
      ...cleanupIntent,
      status: 'SUCCEEDED',
      lastBotId: 'bot-1',
      succeededBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const deleteMessage = jest.fn().mockResolvedValue(undefined);
    const { service } = createService(
      {},
      {
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([cleanupIntent])
          .mockResolvedValueOnce([completedIntent]),
        $executeRaw: jest.fn().mockResolvedValue(1),
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue({ id: 'night-close-event-1' }),
        },
        chatSettings: { findUnique: jest.fn().mockResolvedValue(currentSettings) },
      },
      { deleteMessage },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'confirmed',
      confirmed: true,
      status: 'SUCCEEDED',
    });
    expect(deleteMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['night mode is disabled', { nightModeEnabled: false }],
    [
      'the schedule changes',
      { nightModeStartTimeMinutes: 22 * 60, nightModeEndTimeMinutes: 7 * 60 },
    ],
    ['the close notice content changes', { nightModeBotMessageText: 'Updated close notice' }],
    [
      'manual closure is enabled indefinitely',
      { nightModeForceCloseEnabled: true, nightModeForceCloseForever: true },
    ],
    [
      'a timed manual closure is still active',
      {
        nightModeForceCloseEnabled: true,
        nightModeForceCloseUntil: '2026-05-31T07:00:00.000Z',
      },
    ],
  ])('terminalizes a delayed night cleanup when %s', async (_label, relevantChange) => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T06:12:00.000Z'));
    const originalSettings = nightModeCleanupSettings();
    const changedSettings = nightModeCleanupSettings({
      ...relevantChange,
      updatedAt: new Date('2026-05-31T06:00:00.000Z'),
    });
    const intent = {
      ...baseIntent,
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      botMessageAutoDeleteOnly: false,
      nightModeCloseNoticeCleanupReason: true,
      nightModeCloseNoticeCleanupOnly: true,
      nightModeCloseNoticeCleanupBinding: nightModeCleanupBinding(originalSettings),
    };
    const executeRaw = jest.fn().mockResolvedValue(1);
    const txQueryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ id: intent.id }])
      .mockResolvedValueOnce([intent]);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({ $queryRaw: txQueryRaw, $executeRaw: executeRaw }),
    );
    const maxHttpDelete = jest.fn();
    const transitionEventLookup = jest.fn();
    const { service, queue } = createService(
      {},
      {
        $queryRaw: jest.fn().mockResolvedValueOnce([intent]),
        $executeRaw: executeRaw,
        $transaction: transaction,
        chatSettings: { findUnique: jest.fn().mockResolvedValue(changedSettings) },
        moderationEvent: { findFirst: transitionEventLookup },
      },
      { deleteMessage: maxHttpDelete },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'terminal',
      confirmed: false,
      status: 'FAILED_TERMINAL',
    });

    expect(maxHttpDelete).not.toHaveBeenCalled();
    expect(transitionEventLookup).not.toHaveBeenCalled();
    expect(
      executeRaw.mock.calls.some((call) =>
        ((call[0] as { values?: readonly unknown[] }).values ?? []).includes(
          'night_mode_close_notice_cleanup_stale',
        ),
      ),
    ).toBe(true);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('refreshes a denied candidate and tries the next freshly capable bot', async () => {
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ ...baseIntent }])
      .mockResolvedValueOnce([
        {
          ...baseIntent,
          status: 'SUCCEEDED',
          lastBotId: 'bot-2',
          succeededBotId: 'bot-2',
          leaseToken: null,
          leaseExpiresAt: null,
        },
      ]);
    const deleteMessage = jest
      .fn()
      .mockRejectedValueOnce({
        response: {
          status: 200,
          data: { success: false, code: 'access.denied', message: 'Access denied' },
        },
      })
      .mockResolvedValueOnce(undefined);
    const getCurrentChatMemberAccess = jest.fn().mockResolvedValue({
      userId: 'bot-user-1',
      isAdmin: true,
      isOwner: false,
      permissions: ['read_all_messages', 'write'],
    });
    const resolveDeleteMessageBotRoute = jest.fn().mockResolvedValue(confirmedRoute);
    const { service, maxBotLink } = createService(
      { MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS: 'chat-1' },
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      { deleteMessage, getCurrentChatMemberAccess },
      { resolveDeleteMessageBotRoute },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'confirmed', confirmed: true, botId: 'bot-2' });
    expect(deleteMessage).toHaveBeenNthCalledWith(
      1,
      'chat-1',
      'message-1',
      expect.objectContaining({ botId: 'bot-1', immediate: true }),
    );
    expect(deleteMessage).toHaveBeenNthCalledWith(
      2,
      'chat-1',
      'message-1',
      expect.objectContaining({ botId: 'bot-2', immediate: true }),
    );
    expect(maxBotLink.recordBotAccessProbe).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat-1', botId: 'bot-1' }),
    );
  });

  it('uses a survivor after exact replacement cleanup gets HTTP 403 outside cross-bot canary', async () => {
    const replacementIntent = {
      ...baseIntent,
      routingPolicy: 'origin_first',
      replacementCleanup: true,
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([replacementIntent])
      .mockResolvedValueOnce([
        {
          ...replacementIntent,
          status: 'SUCCEEDED',
          lastBotId: 'bot-2',
          succeededBotId: 'bot-2',
          leaseToken: null,
          leaseExpiresAt: null,
        },
      ]);
    const deleteMessage = jest
      .fn()
      .mockRejectedValueOnce({
        response: { status: 403, data: { code: 'access.denied', message: 'Access denied' } },
      })
      .mockResolvedValueOnce(undefined);
    const { service } = createService(
      { MODERATION_DELETE_INTENT_MODE: 'off' },
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      {
        deleteMessage,
        getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
          userId: 'bot-user-1',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        }),
      },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'confirmed', confirmed: true, botId: 'bot-2' });
    expect(deleteMessage).toHaveBeenNthCalledWith(
      1,
      'chat-1',
      'message-1',
      expect.objectContaining({
        botId: 'bot-1',
        ignoreFailureMetricStatuses: [403, 404],
      }),
    );
    expect(deleteMessage).toHaveBeenNthCalledWith(
      2,
      'chat-1',
      'message-1',
      expect.objectContaining({ botId: 'bot-2' }),
    );
  });

  it('keeps survivor routing behind the replacement cleanup kill switch', async () => {
    const replacementIntent = {
      ...baseIntent,
      routingPolicy: 'origin_first',
      replacementCleanup: true,
    };
    const waitingIntent = {
      ...replacementIntent,
      status: 'WAITING_CAPABILITY',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([replacementIntent])
      .mockResolvedValueOnce([waitingIntent]);
    const deleteMessage = jest.fn().mockRejectedValue({
      response: { status: 403, data: { code: 'access.denied', message: 'Access denied' } },
    });
    const { service } = createService(
      {
        MODERATION_DELETE_INTENT_MODE: 'on',
        MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_ENABLED: false,
      },
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      {
        deleteMessage,
        getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
          userId: 'bot-user-1',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        }),
      },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'waiting_capability', confirmed: false });
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(deleteMessage).toHaveBeenCalledWith(
      'chat-1',
      'message-1',
      expect.objectContaining({ botId: 'bot-1' }),
    );
  });

  it('bounds the replacement survivor bypass to user-authored chats and cross-bot policies', () => {
    const { service } = createService({ MODERATION_DELETE_INTENT_MODE: 'off' });
    const exactInput = {
      chatId: 'chat-outside-canary',
      messageId: 'message-1',
      reasonKey: 'chat_auto_comment_admin_message_replacement_cleanup',
      ruleCode: 'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP',
      entityType: 'CHAT' as const,
      messageAuthorKind: 'user' as const,
      originBotId: 'bot-1',
      routingPolicy: 'origin_first' as const,
    };

    expect((service as unknown as ServiceInternals).normalizeInput(exactInput).routingPolicy).toBe(
      'origin_first',
    );
    expect(
      (service as unknown as ServiceInternals).normalizeInput({
        ...exactInput,
        routingPolicy: 'delete_capable',
      }).routingPolicy,
    ).toBe('delete_capable');
    expect(
      service.resolveEffectiveRoutingPolicy({
        ...exactInput,
        routingPolicy: 'delete_capable',
        replacementCleanup: true,
      }),
    ).toBe('delete_capable');
    expect(
      service.resolveEffectiveRoutingPolicy({
        ...exactInput,
        entityType: 'CHANNEL',
        replacementCleanup: true,
      }),
    ).toBe('origin_only');
    expect(
      service.resolveEffectiveRoutingPolicy({
        ...exactInput,
        messageAuthorKind: 'bot',
        replacementCleanup: true,
      }),
    ).toBe('origin_only');
    expect(
      service.resolveEffectiveRoutingPolicy({
        ...exactInput,
        routingPolicy: 'origin_only',
        replacementCleanup: true,
      }),
    ).toBe('origin_only');
    expect(
      service.resolveEffectiveRoutingPolicy({
        ...exactInput,
        replacementCleanup: false,
      }),
    ).toBe('origin_only');
  });

  it('marks absence only after an exact lookup with fresh delete capability', async () => {
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ ...baseIntent }])
      .mockResolvedValueOnce([
        {
          ...baseIntent,
          status: 'ALREADY_ABSENT',
          lastBotId: 'bot-1',
          leaseToken: null,
          leaseExpiresAt: null,
        },
      ]);
    const deleteMessage = jest.fn().mockRejectedValue({
      response: {
        status: 200,
        data: { success: false, code: 'message.not.found', message: 'Message not found' },
      },
    });
    const getExactMessagePresence = jest.fn().mockResolvedValue('absent');
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      {
        deleteMessage,
        getExactMessagePresence,
        getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
          userId: 'bot-user-1',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        }),
      },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'already_absent', confirmed: true });
    expect(getExactMessagePresence).toHaveBeenCalledWith(
      'chat-1',
      'message-1',
      expect.objectContaining({
        botId: 'bot-1',
        bypassCache: true,
        ignoreFailureMetricStatuses: [403, 404],
      }),
    );
  });

  it('rejects a stale worker lease without making an outbound delete', async () => {
    const queryRaw = jest.fn().mockResolvedValueOnce([
      {
        ...baseIntent,
        leaseToken: 'newer-lease',
      },
    ]);
    const deleteMessage = jest.fn();
    const { service } = createService({}, { $queryRaw: queryRaw }, { deleteMessage });

    const result = await service.executeLeasedIntent('intent-1', 'stale-lease');

    expect(result).toMatchObject({ kind: 'pending', confirmed: false });
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it('does not dispatch after its matching lease has expired', async () => {
    const queryRaw = jest.fn().mockResolvedValueOnce([
      {
        ...baseIntent,
        leaseExpiresAt: new Date(Date.now() - 1),
      },
    ]);
    const deleteMessage = jest.fn();
    const { service } = createService({}, { $queryRaw: queryRaw }, { deleteMessage });

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'pending', confirmed: false });
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it('does not accept a bare verification 404 as proof that the message is absent', async () => {
    const waiting = {
      ...baseIntent,
      status: 'WAITING_CAPABILITY',
      leaseToken: null,
      leaseExpiresAt: null,
      lastStatusCode: 404,
      lastErrorCode: 'unverified_message_not_found',
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ ...baseIntent }])
      .mockResolvedValueOnce([waiting]);
    const deleteMessage = jest.fn().mockRejectedValue({ response: { status: 404, data: {} } });
    const getExactMessagePresence = jest
      .fn()
      .mockRejectedValue({ response: { status: 404, data: {} } });
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      {
        deleteMessage,
        getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
          userId: 'bot-user-1',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        }),
        getExactMessagePresence,
      },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'waiting_capability', confirmed: false });
    expect(deleteMessage).toHaveBeenCalledWith(
      'chat-1',
      'message-1',
      expect.objectContaining({ ignoreFailureMetricStatuses: [403, 404] }),
    );
    expect(getExactMessagePresence).toHaveBeenCalledWith(
      'chat-1',
      'message-1',
      expect.objectContaining({
        botId: 'bot-1',
        bypassCache: true,
        ignoreFailureMetricStatuses: [403, 404],
      }),
    );
  });

  it.each([
    ['HTTP 5xx', () => ({ response: { status: 502, headers: { 'retry-after': '45' } } }), 502],
    [
      'HTTP 429',
      () => ({
        response: {
          status: 429,
          data: { retry_after_ms: 1_000 },
          headers: { 'retry-after': '45' },
        },
      }),
      429,
    ],
    [
      'local cooldown',
      () =>
        new MaxApiInternalRateLimitError('Presence read cooling down', 45_000, 'external_cooldown'),
      null,
    ],
  ] as const)(
    'does not fan out an ambiguous exact-presence %s across bot candidates',
    async (_label, error, statusCode) => {
      const retriedIntent = {
        ...baseIntent,
        attemptCount: 2,
        leasedFromStatus: 'AMBIGUOUS',
        deleteDispatchStartedAt: new Date(),
        deleteDispatchStartedBotId: 'bot-1',
      };
      const stillAmbiguous = {
        ...retriedIntent,
        status: 'AMBIGUOUS',
        nextAttemptAt: new Date(Date.now() + 10_000),
        lastBotId: 'bot-1',
        lastStatusCode: statusCode,
        lastErrorCode: 'predelete_presence_unknown',
        leaseToken: null,
        leaseExpiresAt: null,
      };
      const queryRaw = jest
        .fn()
        .mockResolvedValueOnce([retriedIntent])
        .mockResolvedValueOnce([stillAmbiguous]);
      const executeRaw = jest.fn().mockResolvedValue(1);
      const deleteMessage = jest.fn();
      const getExactMessagePresence = jest
        .fn<
          ReturnType<MaxClientService['getExactMessagePresence']>,
          Parameters<MaxClientService['getExactMessagePresence']>
        >()
        .mockRejectedValue(error());
      const getCurrentChatMemberAccess = jest.fn<
        ReturnType<MaxClientService['getCurrentChatMemberAccess']>,
        Parameters<MaxClientService['getCurrentChatMemberAccess']>
      >();
      const resolveDeleteMessageBotRoute = jest.fn().mockResolvedValue(confirmedRoute);
      const { service, maxBotLink } = createService(
        { MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS: 'chat-1' },
        { $queryRaw: queryRaw, $executeRaw: executeRaw },
        { deleteMessage, getExactMessagePresence, getCurrentChatMemberAccess },
        { resolveDeleteMessageBotRoute },
      );

      const startedAt = Date.now();
      const result = await service.executeLeasedIntent('intent-1', 'lease-1');

      expect(result).toMatchObject({ kind: 'ambiguous', confirmed: false, status: 'AMBIGUOUS' });
      expect(getExactMessagePresence).toHaveBeenCalledTimes(1);
      expect(getExactMessagePresence).toHaveBeenCalledWith(
        'chat-1',
        'message-1',
        expect.objectContaining({ botId: 'bot-1' }),
      );
      expect(getCurrentChatMemberAccess).not.toHaveBeenCalled();
      expect(maxBotLink.recordBotAccessProbe).not.toHaveBeenCalled();
      expect(resolveDeleteMessageBotRoute).toHaveBeenCalledTimes(1);
      expect(deleteMessage).not.toHaveBeenCalled();

      const retryQuery = executeRaw.mock.calls
        .map((call) => call[0] as { strings?: readonly string[]; values?: readonly unknown[] })
        .find((query) => query.values?.includes('predelete_presence_unknown'));
      expect(retryQuery?.values).toEqual(
        expect.arrayContaining(['AMBIGUOUS', statusCode, 'predelete_presence_unknown']),
      );
      const retryDates =
        retryQuery?.values?.filter((value): value is Date => value instanceof Date) ?? [];
      expect(retryDates.length).toBeGreaterThan(0);
      expect(retryDates.every((value) => value.getTime() >= startedAt + 45_000)).toBe(true);

      const executedSql = executeRaw.mock.calls
        .map((call) => call[0]?.strings?.join('?') ?? '')
        .join('\n');
      expect(executedSql).not.toContain('"candidate_failures" =');
      expect(executedSql).not.toContain('"delete_dispatch_started_at" = NULL');
      expect(executedSql).not.toMatch(/SET\s+"retry_until_at"/u);
    },
  );

  it('tries another confirmed bot when retry presence is unknown for the first candidate', async () => {
    const retriedIntent = {
      ...baseIntent,
      attemptCount: 2,
      leasedFromStatus: 'AMBIGUOUS',
      deleteDispatchStartedAt: new Date(),
      deleteDispatchStartedBotId: 'bot-1',
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([retriedIntent])
      .mockResolvedValueOnce([
        {
          ...retriedIntent,
          status: 'SUCCEEDED',
          lastBotId: 'bot-2',
          succeededBotId: 'bot-2',
          leaseToken: null,
          leaseExpiresAt: null,
        },
      ]);
    const getExactMessagePresence = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('presence timeout'), { code: 'ETIMEDOUT' }))
      .mockResolvedValueOnce('present');
    const deleteMessage = jest.fn().mockResolvedValue(undefined);
    const { service } = createService(
      { MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS: 'chat-1' },
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      {
        deleteMessage,
        getExactMessagePresence,
        getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
          userId: 'bot-user-1',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        }),
      },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'confirmed', confirmed: true, botId: 'bot-2' });
    expect(getExactMessagePresence).toHaveBeenNthCalledWith(
      1,
      'chat-1',
      'message-1',
      expect.objectContaining({ botId: 'bot-1' }),
    );
    expect(getExactMessagePresence).toHaveBeenNthCalledWith(
      2,
      'chat-1',
      'message-1',
      expect.objectContaining({ botId: 'bot-2' }),
    );
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(deleteMessage).toHaveBeenCalledWith(
      'chat-1',
      'message-1',
      expect.objectContaining({ botId: 'bot-2' }),
    );
  });

  it('does not delete on retry when exact presence is unknown for the only candidate', async () => {
    const retriedIntent = {
      ...baseIntent,
      attemptCount: 2,
      leasedFromStatus: 'AMBIGUOUS',
      deleteDispatchStartedAt: new Date(),
      deleteDispatchStartedBotId: 'bot-1',
    };
    const ambiguous = {
      ...retriedIntent,
      status: 'AMBIGUOUS',
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: 'predelete_presence_unknown',
    };
    const originOnlyRoute = {
      ...confirmedRoute,
      candidateBotIds: ['bot-1'],
      candidateCapabilities: [confirmedRoute.candidateCapabilities[0]],
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([retriedIntent])
      .mockResolvedValueOnce([ambiguous]);
    const deleteMessage = jest.fn();
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      {
        deleteMessage,
        getExactMessagePresence: jest
          .fn()
          .mockRejectedValue(Object.assign(new Error('presence timeout'), { code: 'ETIMEDOUT' })),
        getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
          userId: 'bot-user-1',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        }),
      },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(originOnlyRoute) },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'ambiguous', confirmed: false });
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it('finishes a retry as already absent before issuing another DELETE', async () => {
    const retriedIntent = {
      ...baseIntent,
      attemptCount: 2,
      leasedFromStatus: 'AMBIGUOUS',
      deleteDispatchStartedAt: new Date(),
      deleteDispatchStartedBotId: 'bot-1',
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([retriedIntent])
      .mockResolvedValueOnce([
        {
          ...retriedIntent,
          status: 'ALREADY_ABSENT',
          leaseToken: null,
          leaseExpiresAt: null,
        },
      ]);
    const deleteMessage = jest.fn();
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      { deleteMessage, getExactMessagePresence: jest.fn().mockResolvedValue('absent') },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'already_absent', confirmed: true });
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it('preflights a stale reclaimed PENDING lease when a durable dispatch fence exists', async () => {
    const dispatchedBeforeCrash = {
      ...baseIntent,
      attemptCount: 2,
      leasedFromStatus: 'PENDING',
      deleteDispatchStartedAt: new Date(Date.now() - 120_000),
      deleteDispatchStartedBotId: 'bot-1',
    };
    const completed = {
      ...dispatchedBeforeCrash,
      status: 'ALREADY_ABSENT',
      leaseToken: null,
      leaseExpiresAt: null,
      deleteDispatchStartedAt: null,
      deleteDispatchStartedBotId: null,
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([dispatchedBeforeCrash])
      .mockResolvedValueOnce([completed]);
    const deleteMessage = jest.fn();
    const getExactMessagePresence = jest.fn().mockResolvedValue('absent');
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      { deleteMessage, getExactMessagePresence },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'already_absent', confirmed: true });
    expect(getExactMessagePresence).toHaveBeenCalledTimes(1);
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['remote timestamp only', { remoteDeleteSucceededAt: new Date() }],
    ['remote bot only', { remoteDeleteSucceededBotId: 'bot-1' }],
    ['dispatch timestamp only', { deleteDispatchStartedAt: new Date() }],
    ['dispatch bot only', { deleteDispatchStartedBotId: 'bot-1' }],
  ])('reconciles partial %s mutation evidence before another DELETE', async (_label, marker) => {
    const partialIntent = {
      ...baseIntent,
      ...marker,
      attemptCount: 2,
      leasedFromStatus: 'AMBIGUOUS',
    };
    const completed = {
      ...partialIntent,
      status: 'ALREADY_ABSENT',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([partialIntent])
      .mockResolvedValueOnce([completed]);
    const deleteMessage = jest.fn();
    const getExactMessagePresence = jest.fn().mockResolvedValue('absent');
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      { deleteMessage, getExactMessagePresence },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'already_absent',
      confirmed: true,
    });
    expect(getExactMessagePresence).toHaveBeenCalledTimes(1);
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it('keeps the dispatch preflight after an ambiguous attempt transitions through RETRYABLE', async () => {
    const transitionedIntent = {
      ...baseIntent,
      attemptCount: 3,
      leasedFromStatus: 'RETRYABLE',
      lastErrorCode: 'route_lookup_failed',
      deleteDispatchStartedAt: new Date(Date.now() - 60_000),
      deleteDispatchStartedBotId: 'bot-1',
    };
    const completed = {
      ...transitionedIntent,
      status: 'ALREADY_ABSENT',
      leaseToken: null,
      leaseExpiresAt: null,
      deleteDispatchStartedAt: null,
      deleteDispatchStartedBotId: null,
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([transitionedIntent])
      .mockResolvedValueOnce([completed]);
    const deleteMessage = jest.fn();
    const getExactMessagePresence = jest.fn().mockResolvedValue('absent');
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      { deleteMessage, getExactMessagePresence },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'already_absent',
    });
    expect(getExactMessagePresence).toHaveBeenCalledTimes(1);
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it('persists the durable dispatch fence before calling MAX DELETE', async () => {
    const completed = {
      ...baseIntent,
      status: 'SUCCEEDED',
      succeededBotId: 'bot-1',
      remoteDeleteSucceededAt: new Date(),
      remoteDeleteSucceededBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const events: string[] = [];
    const executeRaw = jest.fn().mockImplementation(async (query: { strings?: string[] }) => {
      const sql = query.strings?.join('?') ?? '';
      if (sql.includes('"delete_dispatch_started_at" = CURRENT_TIMESTAMP')) {
        events.push('dispatch-fence');
      }
      return 1;
    });
    const deleteMessage = jest.fn().mockImplementation(async () => {
      events.push('max-delete');
    });
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ ...baseIntent }])
      .mockResolvedValueOnce([completed]);
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: executeRaw },
      { deleteMessage },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(events).toEqual(expect.arrayContaining(['dispatch-fence', 'max-delete']));
    expect(events.indexOf('dispatch-fence')).toBeLessThan(events.indexOf('max-delete'));
  });

  it.each([
    ['an initial attempt', 'PENDING', 1],
    ['a retry', 'RETRYABLE', 2],
  ] as const)(
    'runs the link-family guard on both sides of the dispatch fence for %s',
    async (_label, leasedFromStatus, attemptCount) => {
      const intent = {
        ...baseIntent,
        leasedFromStatus,
        attemptCount,
        linkFamilyDeleteOnly: true,
      };
      const completed = {
        ...intent,
        status: 'SUCCEEDED',
        succeededBotId: 'bot-1',
        remoteDeleteSucceededAt: new Date(),
        remoteDeleteSucceededBotId: 'bot-1',
        leaseToken: null,
        leaseExpiresAt: null,
      };
      const events: string[] = [];
      const executeRaw = jest.fn().mockImplementation(async (query: { strings?: string[] }) => {
        const sql = query.strings?.join('?') ?? '';
        if (sql.includes('"delete_dispatch_started_at" = CURRENT_TIMESTAMP')) {
          events.push('dispatch-fence');
        }
        return 1;
      });
      const deleteMessage = jest.fn().mockImplementation(async () => {
        events.push('max-delete');
      });
      const assertIntentStillActionable = jest.fn().mockImplementation(async () => {
        events.push('history-guard');
        return 'allowed';
      });
      const queryRaw = jest.fn().mockResolvedValueOnce([intent]).mockResolvedValueOnce([completed]);
      const { service } = createService(
        {},
        { $queryRaw: queryRaw, $executeRaw: executeRaw },
        { deleteMessage },
        { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
        { assertIntentStillActionable },
      );

      await service.executeLeasedIntent('intent-1', 'lease-1');

      expect(assertIntentStillActionable).toHaveBeenCalledTimes(2);
      expect(assertIntentStillActionable).toHaveBeenNthCalledWith(1, {
        intentId: 'intent-1',
        chatId: 'chat-1',
        messageId: 'message-1',
        subjectUserId: 'user-1',
        botId: 'bot-1',
      });
      expect(events).toEqual(['history-guard', 'dispatch-fence', 'history-guard', 'max-delete']);
    },
  );

  it.each(['PENDING', 'RETRYABLE'] as const)(
    'runs the profanity guard exactly once after the dispatch fence for %s',
    async (leasedFromStatus) => {
      const intent = { ...baseIntent, leasedFromStatus };
      const completed = {
        ...intent,
        status: 'SUCCEEDED',
        succeededBotId: 'bot-1',
        remoteDeleteSucceededAt: new Date(),
        remoteDeleteSucceededBotId: 'bot-1',
        leaseToken: null,
        leaseExpiresAt: null,
      };
      const events: string[] = [];
      const executeRaw = jest.fn(async (query: { strings?: string[] }) => {
        if (query.strings?.join('?').includes('"delete_dispatch_started_at" = CURRENT_TIMESTAMP')) {
          events.push('dispatch-fence');
        }
        return 1;
      });
      const { service, profanityDeleteGuard } = createService(
        {},
        {
          ...guardedFixtureReasons('PROFANITY_DELETE'),
          $queryRaw: jest.fn().mockResolvedValueOnce([intent]).mockResolvedValueOnce([completed]),
          $executeRaw: executeRaw,
        },
        {
          deleteMessage: jest.fn(async () => {
            events.push('max-delete');
          }),
        },
        { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
        undefined,
        undefined,
        undefined,
        undefined,
        {
          assertIntentStillActionable: jest.fn(async () => {
            events.push('profanity-guard');
            return 'allowed';
          }),
        },
      );

      await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
        kind: 'confirmed',
        profanityVerified: true,
      });

      expect(events).toEqual(['dispatch-fence', 'profanity-guard', 'max-delete']);
      expect(profanityDeleteGuard.assertIntentStillActionable).toHaveBeenCalledWith({
        intentId: 'intent-1',
        chatId: 'chat-1',
        messageId: 'message-1',
        subjectUserId: 'user-1',
        sourceMessageAt: intent.sourceMessageAt,
        botId: 'bot-1',
        ownedReasonsOnly: true,
      });
    },
  );

  it.each([
    {
      recovered: false,
      guardResult: { kind: 'allowed', reasonKeys: ['commercial-revision'] },
      keys: ['commercial-revision'],
    },
    { recovered: false, guardResult: 'not_applicable', keys: [] },
    {
      recovered: true,
      guardResult: { kind: 'allowed', reasonKeys: ['commercial-revision'] },
      keys: [],
    },
  ])(
    'limits commercial proof and event attribution to this dispatch: %j',
    async ({ recovered, guardResult, keys }) => {
      const intent = {
        ...baseIntent,
        ...(recovered
          ? { remoteDeleteSucceededAt: new Date(), remoteDeleteSucceededBotId: 'bot-1' }
          : {}),
      };
      const completed = {
        ...intent,
        status: 'SUCCEEDED',
        succeededBotId: 'bot-1',
        remoteDeleteSucceededAt: new Date(),
        remoteDeleteSucceededBotId: 'bot-1',
        leaseToken: null,
        leaseExpiresAt: null,
      };
      const events: string[] = [];
      const txExecuteRaw = jest.fn().mockResolvedValue(1);
      const executeRaw = jest.fn(async (query: Prisma.Sql) => {
        if (query.strings.join('?').includes('"delete_dispatch_started_at" = CURRENT_TIMESTAMP'))
          events.push('dispatch-fence');
        return 1;
      });
      const { service, commercialDeleteGuard } = createService(
        {},
        {
          ...(guardResult === 'not_applicable'
            ? {}
            : guardedFixtureReasons('COMMERCIAL_AD_DELETE')),
          $queryRaw: jest.fn().mockResolvedValueOnce([intent]).mockResolvedValueOnce([completed]),
          $executeRaw: executeRaw,
          $transaction: jest.fn(async (callback) => callback({ $executeRaw: txExecuteRaw })),
        },
        {
          deleteMessage: jest.fn(async () => {
            events.push('max-delete');
          }),
        },
        { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          assertIntentStillActionable: jest.fn(async () => {
            events.push('commercial-guard');
            return guardResult;
          }),
        },
      );
      const result = await service.executeLeasedIntent('intent-1', 'lease-1');
      expect(result).toMatchObject({ kind: 'confirmed' });
      if (keys.length)
        expect(result).toMatchObject({
          commercialVerified: true,
          commercialVerifiedReasonKeys: keys,
        });
      else expect(result).not.toHaveProperty('commercialVerified');
      const commercialChecks = guardResult === 'not_applicable' ? [] : ['commercial-guard'];
      expect(events).toEqual(
        recovered ? [] : ['dispatch-fence', ...commercialChecks, 'max-delete'],
      );
      expect(commercialDeleteGuard.assertIntentStillActionable).toHaveBeenCalledTimes(
        recovered || guardResult === 'not_applicable' ? 0 : 1,
      );
      const queries = txExecuteRaw.mock.calls
        .map(([query]) => query as Prisma.Sql)
        .filter((query) =>
          query.strings.join('?').includes('reason."moderation_event_id" IS NULL'),
        );
      expect(queries).toHaveLength(2);
      for (const query of queries) {
        expect(query.values).toEqual([
          'intent-1',
          ...VERIFIED_RECEIPT_RULE_CODES,
          false,
          'PROFANITY_DELETE',
          'COMMERCIAL_AD_DELETE',
          ...keys,
        ]);
        expect(query.strings.join('?')).toContain(
          keys.length ? 'reason."reason_key" IN (?)' : 'OR FALSE)',
        );
      }
    },
  );

  it.each([
    { independent: false, changed: false },
    { independent: true, changed: false },
    { independent: false, changed: true },
  ])(
    'fences cancellation against concurrent commercial reasons: %j',
    async ({ independent, changed }) => {
      const reasons = [
        { ruleCode: 'COMMERCIAL_AD_DELETE', reasonKey: 'old-revision', score: 0.5, metadata: {} },
      ];
      const error = new CommercialDeleteGuardRejectedError('commercial_text_message_changed');
      error.reasonFingerprint = fingerprintCommercialDeleteReasons(reasons);
      const txQueryRaw = jest
        .fn()
        .mockResolvedValueOnce([{ id: baseIntent.id }])
        .mockResolvedValueOnce([baseIntent]);
      const executeRaw = jest.fn().mockResolvedValue(1);
      const findFirst = jest.fn().mockResolvedValue(independent ? { id: 'independent' } : null);
      const findMany = jest.fn().mockResolvedValue(
        independent
          ? [
              ...reasons,
              {
                ruleCode: 'MESSAGE_TOO_LONG_DELETE',
                reasonKey: 'new-length',
                score: 1,
                metadata: {},
              },
            ]
          : changed
            ? [...reasons, { ...reasons[0], reasonKey: 'new-revision' }]
            : reasons,
      );
      const remoteDelete = jest.fn();
      const { service, queue } = createService(
        {},
        {
          moderationDeleteIntentReason: { findMany: jest.fn().mockResolvedValue(reasons) },
          $queryRaw: jest.fn().mockResolvedValueOnce([baseIntent]),
          $executeRaw: executeRaw,
          $transaction: jest.fn(async (callback) =>
            callback({
              $queryRaw: txQueryRaw,
              $executeRaw: executeRaw,
              moderationDeleteIntentReason: { findFirst, findMany },
            }),
          ),
        },
        { deleteMessage: remoteDelete },
        { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { assertIntentStillActionable: jest.fn().mockRejectedValue(error) },
      );
      await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
        kind: independent || changed ? 'pending' : 'terminal',
        status: independent || changed ? 'RETRYABLE' : 'FAILED_TERMINAL',
      });
      expect(remoteDelete).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledTimes(independent || changed ? 1 : 0);
      expect(txQueryRaw.mock.calls[0][0].strings.join('?')).toContain('FOR UPDATE');
      expect(
        executeRaw.mock.calls.some(([query]) =>
          query.strings.join('?').includes('"delete_dispatch_started_at" = NULL'),
        ),
      ).toBe(true);
    },
  );

  it('blocks DELETE when a later awaited check revokes duplicate authority after the full guard', async () => {
    const intent = {
      ...baseIntent,
      messageDuplicateOwned: true,
      nonCommercialOcrDeleteReason: false,
      suggestionSubscriptionId: 'suggestion',
    };
    const events: string[] = [];
    let revoked = false;
    const executeRaw = jest.fn().mockResolvedValue(1);
    const txQueryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ id: intent.id }])
      .mockResolvedValueOnce([intent]);
    const remoteDelete = jest.fn();
    const { service } = createService(
      {},
      {
        $queryRaw: jest.fn().mockResolvedValueOnce([intent]),
        $executeRaw: executeRaw,
        $transaction: jest.fn(async (callback: (tx: unknown) => unknown) =>
          callback({ $queryRaw: txQueryRaw, $executeRaw: executeRaw }),
        ),
      },
      { deleteMessage: remoteDelete },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );
    let checks = 0;
    Object.assign(service, {
      suggestionSubscriptions: {
        prepareDeletion: async () => ({ chatId: intent.chatId, messageId: intent.messageId }),
        assertDeletionAllowed: async () => {
          checks++;
          if (checks === 2) {
            events.push('later-check');
            revoked = true;
          }
        },
      },
    });
    const duplicateGuard = {
      assertIntentStillActionable: jest.fn(async (input: { authorityOnly?: boolean }) => {
        events.push(input.authorityOnly ? 'duplicate_authority' : 'duplicate_full');
        if (revoked)
          throw new MessageDuplicateGuardRejectedError(
            'message_duplicate_action_authority_revoked',
          );
        return 'allowed';
      }),
    };
    Object.defineProperty(service, 'messageDuplicateDeleteGuard', { value: duplicateGuard });
    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'terminal',
      status: 'FAILED_TERMINAL',
    });
    expect(events).toEqual(['duplicate_full', 'later-check', 'duplicate_authority']);
    expect(remoteDelete).not.toHaveBeenCalled();
    expect(duplicateGuard.assertIntentStillActionable).toHaveBeenCalledWith(
      expect.objectContaining({ authorityOnly: true }),
    );
    expect(
      executeRaw.mock.calls.some(([query]) =>
        query.strings?.join('?').includes('"delete_dispatch_started_at" = NULL'),
      ),
    ).toBe(true);
  });

  it('revalidates duplicate authority after the dispatch-budget SQL check', async () => {
    const intent = {
      ...baseIntent,
      messageDuplicateOwned: true,
      nonCommercialOcrDeleteReason: false,
    };
    let markerWritten = false;
    let revoked = false;
    const remoteDelete = jest.fn();
    const executeRaw = jest.fn(async (query: Prisma.Sql) => {
      const sql = query.strings.join('?');
      if (sql.includes('"delete_dispatch_started_at" = CURRENT_TIMESTAMP')) markerWritten = true;
      if (markerWritten && sql.includes('storage:delete_lease_check')) revoked = true;
      return 1;
    });
    const { service } = createService(
      {},
      {
        $queryRaw: jest.fn().mockResolvedValue([intent]),
        $executeRaw: executeRaw,
        $transaction: jest.fn(async (callback) =>
          callback({
            $queryRaw: jest.fn().mockResolvedValue([intent]),
            $executeRaw: executeRaw,
          }),
        ),
      },
      { deleteMessage: remoteDelete },
      {
        resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute),
      },
    );
    const guard = {
      assertIntentStillActionable: jest.fn(async () => {
        if (revoked)
          throw new MessageDuplicateGuardRejectedError(
            'message_duplicate_action_authority_revoked',
          );
        return 'allowed';
      }),
    };
    Object.defineProperty(service, 'messageDuplicateDeleteGuard', { value: guard });
    await service.executeLeasedIntent('intent-1', 'lease-1');
    expect(revoked).toBe(true);
    expect(guard.assertIntentStillActionable).toHaveBeenCalled();
    expect(remoteDelete).not.toHaveBeenCalled();
  });

  it('fences a slow final authority guard synchronously without another awaited check', async () => {
    const intent = {
      ...baseIntent,
      messageDuplicateOwned: true,
      nonCommercialOcrDeleteReason: false,
    };
    const remoteDelete = jest.fn();
    const { service } = createService(
      { MODERATION_DELETE_INTENT_TIMEOUT_MS: 1 },
      {
        $queryRaw: jest.fn().mockResolvedValue([intent]),
        $executeRaw: jest.fn().mockResolvedValue(1),
      },
      { deleteMessage: remoteDelete },
      {
        resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute),
      },
    );
    const renew = jest
      .spyOn(service as unknown as ServiceInternals, 'renewLease')
      .mockImplementation(async () => ({
        owned: true,
        renewed: false,
        remainingBudgetMs: 1_051,
        proofUntilMonotonicMs: performance.now() + 1_051,
      }));
    let checkCountAtFinalPermit = 0;
    Object.defineProperty(service, 'messageDuplicateDeleteGuard', {
      value: {
        assertIntentStillActionable: jest.fn(async (input: { authorityOnly?: boolean }) => {
          if (input.authorityOnly) {
            checkCountAtFinalPermit = renew.mock.calls.length;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          return 'allowed';
        }),
      },
    });
    await service.executeLeasedIntent('intent-1', 'lease-1');
    expect(checkCountAtFinalPermit).toBeGreaterThan(0);
    expect(renew).toHaveBeenCalledTimes(checkCountAtFinalPermit);
    expect(remoteDelete).not.toHaveBeenCalled();
  });

  it.each(
    [false, true].flatMap((hasIndependentReason) =>
      (['profanity_violation_no_longer_present', 'profanity_author_not_member'] as const).map(
        (code) => ({ hasIndependentReason, code }),
      ),
    ),
  )(
    'clears a rejected profanity dispatch ($code) and preserves independent reason=$hasIndependentReason',
    async ({ hasIndependentReason, code }) => {
      const intent = { ...baseIntent };
      const freshIntent = { ...baseIntent };
      const executeRaw = jest.fn().mockResolvedValue(1);
      const txQueryRaw = jest
        .fn()
        .mockResolvedValueOnce([{ id: intent.id }])
        .mockResolvedValueOnce([freshIntent]);
      const reasons = [
        {
          ruleCode: 'PROFANITY_DELETE',
          reasonKey: 'PROFANITY_DELETE:fixture',
          score: 1,
          metadata: {},
        },
      ];
      const findCurrentReasons = jest.fn().mockResolvedValue(
        hasIndependentReason
          ? [
              ...reasons,
              {
                ruleCode: 'MESSAGE_TOO_LONG_DELETE',
                reasonKey: 'new-length',
                score: 1,
                metadata: {},
              },
            ]
          : reasons,
      );
      const remoteDelete = jest.fn();
      const { service, queue } = createService(
        {},
        {
          ...guardedFixtureReasons('PROFANITY_DELETE'),
          $queryRaw: jest.fn().mockResolvedValueOnce([intent]),
          $executeRaw: executeRaw,
          $transaction: jest.fn(async (callback: (tx: unknown) => unknown) =>
            callback({
              $queryRaw: txQueryRaw,
              $executeRaw: executeRaw,
              moderationDeleteIntentReason: { findMany: findCurrentReasons },
            }),
          ),
        },
        { deleteMessage: remoteDelete },
        { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
        undefined,
        undefined,
        undefined,
        undefined,
        {
          assertIntentStillActionable: jest
            .fn()
            .mockRejectedValue(
              new ProfanityDeleteGuardRejectedError(code, 'Current guard rejects deletion'),
            ),
        },
      );

      await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
        kind: hasIndependentReason ? 'pending' : 'terminal',
        status: hasIndependentReason ? 'RETRYABLE' : 'FAILED_TERMINAL',
      });

      expect(remoteDelete).not.toHaveBeenCalled();
      expect(queue.add).toHaveBeenCalledTimes(hasIndependentReason ? 1 : 0);
      expect(findCurrentReasons).toHaveBeenCalledWith({
        where: { intentId: 'intent-1' },
        select: { ruleCode: true, reasonKey: true, score: true, metadata: true },
        orderBy: { reasonKey: 'asc' },
        take: 65,
      });
      expect(txQueryRaw.mock.calls[0]?.[0].strings.join('?')).toContain('FOR UPDATE');
      expect(
        executeRaw.mock.calls.some(([query]) =>
          query.strings?.join('?').includes('"delete_dispatch_started_at" = NULL'),
        ),
      ).toBe(true);
    },
  );

  it('keeps an unavailable profanity guard retryable without attempting MAX deletion', async () => {
    const intent = { ...baseIntent };
    const pending = { ...baseIntent, status: 'RETRYABLE', leaseToken: null, leaseExpiresAt: null };
    const executeRaw = jest.fn().mockResolvedValue(1);
    const remoteDelete = jest.fn();
    const { service, queue } = createService(
      {},
      {
        ...guardedFixtureReasons('PROFANITY_DELETE'),
        $queryRaw: jest.fn().mockResolvedValueOnce([intent]).mockResolvedValueOnce([pending]),
        $executeRaw: executeRaw,
      },
      { deleteMessage: remoteDelete },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
      undefined,
      undefined,
      undefined,
      undefined,
      {
        assertIntentStillActionable: jest
          .fn()
          .mockRejectedValue(new Error('MAX lookup unavailable')),
      },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).rejects.toThrow(
      'MAX lookup unavailable',
    );
    expect(remoteDelete).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(executeRaw.mock.calls.some(([query]) => query.values?.includes('RETRYABLE'))).toBe(true);
  });

  it('records exact profanity absence without performing DELETE', async () => {
    const intent = { ...baseIntent };
    const absent = {
      ...baseIntent,
      status: 'ALREADY_ABSENT',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const remoteDelete = jest.fn();
    const { service } = createService(
      {},
      {
        ...guardedFixtureReasons('PROFANITY_DELETE'),
        $queryRaw: jest.fn().mockResolvedValueOnce([intent]).mockResolvedValueOnce([absent]),
        $executeRaw: jest.fn().mockResolvedValue(1),
      },
      { deleteMessage: remoteDelete },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
      undefined,
      undefined,
      undefined,
      undefined,
      { assertIntentStillActionable: jest.fn().mockResolvedValue('absent') },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');
    expect(result).toMatchObject({ kind: 'already_absent' });
    expect(result).not.toHaveProperty('profanityVerified');
    expect(remoteDelete).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'verified profanity', guardResult: 'allowed', recovered: false, proof: true },
    {
      label: 'mixed independent reason',
      guardResult: 'not_applicable',
      recovered: false,
      proof: false,
    },
    { label: 'old success recovery', guardResult: 'allowed', recovered: true, proof: false },
  ])(
    'fences profanity event materialization for $label',
    async ({ guardResult, recovered, proof }) => {
      const intent = {
        ...baseIntent,
        ...(recovered
          ? {
              remoteDeleteSucceededAt: new Date(),
              remoteDeleteSucceededBotId: 'bot-1',
            }
          : {}),
      };
      const completed = {
        ...intent,
        status: 'SUCCEEDED',
        succeededBotId: 'bot-1',
        remoteDeleteSucceededAt: new Date(),
        remoteDeleteSucceededBotId: 'bot-1',
        leaseToken: null,
        leaseExpiresAt: null,
      };
      const txExecuteRaw = jest.fn().mockResolvedValue(1);
      const remoteDelete = jest.fn();
      const { service, profanityDeleteGuard } = createService(
        {},
        {
          ...(guardResult === 'not_applicable' ? {} : guardedFixtureReasons('PROFANITY_DELETE')),
          $queryRaw: jest.fn().mockResolvedValueOnce([intent]).mockResolvedValueOnce([completed]),
          $executeRaw: jest.fn().mockResolvedValue(1),
          $transaction: jest.fn(async (callback: (tx: unknown) => unknown) =>
            callback({
              $executeRaw: txExecuteRaw,
            }),
          ),
        },
        { deleteMessage: remoteDelete },
        { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
        undefined,
        undefined,
        undefined,
        undefined,
        { assertIntentStillActionable: jest.fn().mockResolvedValue(guardResult) },
      );

      await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
        kind: 'confirmed',
      });

      const queries = txExecuteRaw.mock.calls.map(([query]) => query as Prisma.Sql);
      const eventInsert = queries.find((query) =>
        query.strings.join('?').includes('INSERT INTO "moderation_events"'),
      );
      const reasonMarker = queries.find((query) =>
        query.strings.join('?').includes('UPDATE "moderation_delete_intent_reasons" reason'),
      );
      expect(eventInsert).toBeDefined();
      expect(reasonMarker).toBeDefined();
      for (const query of [eventInsert!, reasonMarker!]) {
        expect(query.strings.join('?')).toContain('AND (? OR reason."rule_code" <> ?)');
        expect(query.strings.join('?')).toContain('reason."moderation_event_id" IS NULL');
        expect(query.values).toEqual([
          'intent-1',
          ...VERIFIED_RECEIPT_RULE_CODES,
          proof,
          'PROFANITY_DELETE',
          'COMMERCIAL_AD_DELETE',
        ]);
        expect(query.strings.join('?')).toContain('OR FALSE)');
      }
      expect(eventInsert!.strings.join('?')).toContain('ON CONFLICT ("id") DO NOTHING');
      expect(remoteDelete).toHaveBeenCalledTimes(recovered ? 0 : 1);
      expect(profanityDeleteGuard.assertIntentStillActionable).toHaveBeenCalledTimes(
        recovered || guardResult === 'not_applicable' ? 0 : 1,
      );
    },
  );

  it('does not attribute an independent deletion to an unverified profanity reason', async () => {
    const intent = { ...baseIntent };
    const completed = {
      ...intent,
      status: 'SUCCEEDED',
      succeededBotId: 'bot-1',
      remoteDeleteSucceededAt: new Date(),
      remoteDeleteSucceededBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const remoteDelete = jest.fn();
    const { service, profanityDeleteGuard } = createService(
      {},
      {
        $queryRaw: jest.fn().mockResolvedValueOnce([intent]).mockResolvedValueOnce([completed]),
        $executeRaw: jest.fn().mockResolvedValue(1),
      },
      { deleteMessage: remoteDelete },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(profanityDeleteGuard.assertIntentStillActionable).not.toHaveBeenCalled();
    expect(remoteDelete).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ kind: 'confirmed' });
    expect(result).not.toHaveProperty('profanityVerified');
  });

  it('does not run the link-family guard for an ordinary delete intent', async () => {
    const completed = {
      ...baseIntent,
      status: 'SUCCEEDED',
      succeededBotId: 'bot-1',
      remoteDeleteSucceededAt: new Date(),
      remoteDeleteSucceededBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const assertIntentStillActionable = jest.fn().mockResolvedValue('allowed');
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ ...baseIntent, linkFamilyDeleteOnly: false }])
      .mockResolvedValueOnce([completed]);
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      { deleteMessage: jest.fn() },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
      { assertIntentStillActionable },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).not.toHaveProperty('profanityVerified');
    expect(assertIntentStillActionable).not.toHaveBeenCalled();
  });

  it('does not let a link reason gate an independent delete reason on the same intent', async () => {
    const completed = {
      ...baseIntent,
      status: 'SUCCEEDED',
      succeededBotId: 'bot-1',
      remoteDeleteSucceededAt: new Date(),
      remoteDeleteSucceededBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
      linkFamilyDeleteOnly: false,
    };
    const assertIntentStillActionable = jest.fn().mockRejectedValue(new Error('history disabled'));
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ ...baseIntent, linkFamilyDeleteOnly: false }])
      .mockResolvedValueOnce([completed]);
    const deleteMessage = jest.fn();
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      { deleteMessage },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
      { assertIntentStillActionable },
    );

    await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(assertIntentStillActionable).not.toHaveBeenCalled();
    expect(deleteMessage).toHaveBeenCalledTimes(1);
  });

  it.each(['on', 'baseline'] as const)(
    'runs the %s commercial OCR guard on both sides of dispatch with generic deletion off',
    async (mode) => {
      const intent = {
        ...baseIntent,
        commercialOcrGuardRequired: true,
        standardCommercialOcrDeleteReason: true,
        nonCommercialOcrDeleteReason: false,
      };
      const completed = {
        ...intent,
        status: 'SUCCEEDED',
        succeededBotId: 'bot-1',
        remoteDeleteSucceededAt: new Date(),
        remoteDeleteSucceededBotId: 'bot-1',
        leaseToken: null,
        leaseExpiresAt: null,
      };
      const events: string[] = [];
      const executeRaw = jest.fn().mockImplementation(async (query: { strings?: string[] }) => {
        const sql = query.strings?.join('?') ?? '';
        if (sql.includes('"delete_dispatch_started_at" = CURRENT_TIMESTAMP')) {
          events.push('dispatch-fence');
        }
        if (sql.includes('COALESCE(intent."commercial_ocr_deadline_at"')) {
          events.push('commercial-ocr-deadline-fence');
        }
        return 1;
      });
      const assertIntentStillActionable = jest.fn().mockImplementation(async () => {
        events.push('commercial-ocr-guard');
        return 'allowed';
      });
      const queryRaw = jest.fn().mockResolvedValueOnce([intent]).mockResolvedValueOnce([completed]);
      const { service } = createService(
        { MODERATION_DELETE_INTENT_MODE: 'off', COMMERCIAL_OCR_ROLLOUT_MODE: mode },
        { $queryRaw: queryRaw, $executeRaw: executeRaw },
        {
          deleteMessage: jest.fn(async () => {
            events.push('max-delete');
          }),
        },
        { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
        undefined,
        undefined,
        { assertIntentStillActionable },
      );

      await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
        status: 'SUCCEEDED',
        confirmed: true,
      });

      expect(assertIntentStillActionable).toHaveBeenCalledTimes(2);
      expect(assertIntentStillActionable).toHaveBeenNthCalledWith(1, {
        intentId: 'intent-1',
        chatId: 'chat-1',
        messageId: 'message-1',
        subjectUserId: 'user-1',
        sourceMessageAt: baseIntent.sourceMessageAt,
        botId: 'bot-1',
      });
      expect(events).toEqual([
        'commercial-ocr-guard',
        'dispatch-fence',
        'commercial-ocr-guard',
        'commercial-ocr-deadline-fence',
        'max-delete',
      ]);
    },
  );

  it('blocks MAX delete when the OCR deadline expires during the final asynchronous guard', async () => {
    const intent = {
      ...baseIntent,
      commercialOcrGuardRequired: true,
      commercialOcrDeadlineAt: new Date(Date.now() + 60_000),
    };
    const terminal = {
      ...intent,
      status: 'FAILED_TERMINAL' as const,
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
      deleteDispatchStartedAt: null,
      deleteDispatchStartedBotId: null,
      lastErrorCode: 'commercial_ocr_deadline_expired',
      completedAt: new Date(),
    };
    let guardCalls = 0;
    let deadlineExpired = false;
    const assertIntentStillActionable = jest.fn().mockImplementation(async () => {
      guardCalls += 1;
      if (guardCalls === 2) {
        deadlineExpired = true;
      }
      return 'allowed';
    });
    const executeRaw = jest.fn().mockImplementation(async (query: { strings?: string[] }) => {
      const sql = query.strings?.join('?') ?? '';
      if (sql.includes('COALESCE(intent."commercial_ocr_deadline_at"')) {
        return deadlineExpired ? 0 : 1;
      }
      return 1;
    });
    const queryRaw = jest.fn().mockResolvedValueOnce([intent]).mockResolvedValueOnce([terminal]);
    const txQueryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ id: intent.id }])
      .mockResolvedValueOnce([intent]);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({ $queryRaw: txQueryRaw, $executeRaw: executeRaw }),
    );
    const remoteDelete = jest.fn();
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: executeRaw, $transaction: transaction },
      { deleteMessage: remoteDelete },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
      undefined,
      undefined,
      { assertIntentStillActionable },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'terminal',
      status: 'FAILED_TERMINAL',
    });

    expect(assertIntentStillActionable).toHaveBeenCalledTimes(2);
    expect(remoteDelete).not.toHaveBeenCalled();
    const deadlineFence = executeRaw.mock.calls
      .map((call) => call[0] as { strings?: readonly string[] })
      .find((query) =>
        (query.strings?.join('?') ?? '').includes(
          'COALESCE(intent."commercial_ocr_deadline_at", intent."retry_until_at")',
        ),
      );
    const deadlineFenceSql = deadlineFence?.strings?.join('?') ?? '';
    expect(deadlineFenceSql).toContain('intent."lease_expires_at" > CURRENT_TIMESTAMP');
    expect(deadlineFenceSql).toContain('intent."delete_dispatch_started_at" IS NOT NULL');
    expect(deadlineFenceSql).toContain('ocr_reason."rule_code" =');
    expect(deadlineFenceSql).toContain('> CURRENT_TIMESTAMP');
  });

  it.each(
    [
      ['commercial_ocr_runtime_revoked', true],
      ['commercial_ocr_version_changed', true],
      ['commercial_ocr_binding_invalid', true],
      ['commercial_ocr_binding_ambiguous', true],
      ['commercial_ocr_reason_missing', true],
      ['commercial_ocr_author_immune', true],
      ['commercial_ocr_source_timestamp_changed', true],
      ['commercial_ocr_filter_disabled', true],
      ['commercial_ocr_policy_changed', true],
      ['commercial_ocr_admin_immune', true],
      ['commercial_ocr_message_changed', true],
      ['commercial_ocr_participant_immune', true],
      ['commercial_ocr_runtime_control_unavailable', false],
      ['commercial_ocr_author_access_unknown', false],
      ['commercial_ocr_message_ambiguous', false],
      ['commercial_ocr_participant_immunity_unknown', false],
    ].flatMap(([code, terminal]) =>
      (['before_fence', 'after_fence'] as const).map((stage) => ({
        code: code as string,
        terminal: terminal as boolean,
        stage,
      })),
    ),
  )(
    'classifies $code as terminal=$terminal when rejected $stage',
    async ({ code, terminal, stage }) => {
      const intent = { ...baseIntent, commercialOcrGuardRequired: true };
      const guarded = {
        ...intent,
        status: terminal ? ('FAILED_TERMINAL' as const) : ('RETRYABLE' as const),
        leaseToken: null,
        leaseExpiresAt: null,
        leasedFromStatus: null,
        deleteDispatchStartedAt: null,
        deleteDispatchStartedBotId: null,
        lastErrorCode: code,
        lastError: code,
        completedAt: terminal ? new Date() : null,
      };
      const guardError = new CommercialOcrDeleteGuardRejectedError(code, code);
      const assertIntentStillActionable =
        stage === 'before_fence'
          ? jest.fn().mockRejectedValue(guardError)
          : jest.fn().mockResolvedValueOnce('allowed').mockRejectedValueOnce(guardError);
      const queryRaw = jest.fn().mockResolvedValueOnce([intent]).mockResolvedValueOnce([guarded]);
      const executeRaw = jest.fn().mockResolvedValue(1);
      const txQueryRaw = jest
        .fn()
        .mockResolvedValueOnce([{ id: intent.id }])
        .mockResolvedValueOnce([intent]);
      const transaction = jest.fn(
        async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
          callback({ $queryRaw: txQueryRaw, $executeRaw: executeRaw }),
      );
      const remoteDispatch = jest.fn();
      const { service } = createService(
        {},
        { $queryRaw: queryRaw, $executeRaw: executeRaw, $transaction: transaction },
        { deleteMessage: remoteDispatch },
        { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
        undefined,
        undefined,
        { assertIntentStillActionable },
      );

      const execution = service.executeLeasedIntent('intent-1', 'lease-1');
      if (terminal) {
        await expect(execution).resolves.toMatchObject({
          kind: 'terminal',
          status: 'FAILED_TERMINAL',
        });
      } else {
        await expect(execution).rejects.toBe(guardError);
      }

      expect(remoteDispatch).not.toHaveBeenCalled();
      expect(assertIntentStillActionable).toHaveBeenCalledTimes(stage === 'before_fence' ? 1 : 2);
      const sqlCalls = executeRaw.mock.calls.map(
        (call: unknown[]) =>
          call[0] as { strings?: readonly string[]; values?: readonly unknown[] },
      );
      const statusUpdate = sqlCalls.find((query) =>
        (query.strings?.join('?') ?? '').includes(
          '"status" = CAST(? AS "ModerationDeleteIntentStatus")',
        ),
      );
      expect(statusUpdate?.values).toEqual(
        expect.arrayContaining([
          terminal ? 'FAILED_TERMINAL' : 'RETRYABLE',
          terminal && stage === 'after_fence'
            ? 'moderation_delete_reasons_no_longer_authorized'
            : code,
        ]),
      );
      expect(statusUpdate?.values).not.toContain('delete_pre_dispatch_guard_rejected');
      const clearedFence = sqlCalls.some((query) =>
        (query.strings?.join('?') ?? '').includes('AND "delete_dispatch_started_at" IS NOT NULL'),
      );
      expect(clearedFence).toBe(stage === 'after_fence');
      expect(guarded.completedAt === null).toBe(!terminal);
    },
  );

  it('terminalizes a reasonless intent at the final dispatch boundary without a MAX delete', async () => {
    const terminal = {
      ...baseIntent,
      status: 'FAILED_TERMINAL' as const,
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
      lastErrorCode: 'moderation_delete_reason_missing',
      lastError: 'Moderation delete intent has no durable reason',
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ ...baseIntent }])
      .mockResolvedValueOnce([terminal]);
    const executeRaw = jest.fn().mockResolvedValue(1);
    const txQueryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ id: baseIntent.id }])
      .mockResolvedValueOnce([{ ...baseIntent }]);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({ $queryRaw: txQueryRaw, $executeRaw: executeRaw }),
    );
    const reasonFindFirst = jest.fn().mockResolvedValue(null);
    const remoteDelete = jest.fn();
    const { service, prisma } = createService(
      {},
      {
        $queryRaw: queryRaw,
        $executeRaw: executeRaw,
        $transaction: transaction,
        moderationDeleteIntentReason: { findFirst: reasonFindFirst },
      },
      { deleteMessage: remoteDelete },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'terminal',
      confirmed: false,
      status: 'FAILED_TERMINAL',
    });

    expect(reasonFindFirst).toHaveBeenCalledWith({
      where: { intentId: 'intent-1' },
      select: { id: true },
    });
    expect(remoteDelete).not.toHaveBeenCalled();
    expect(
      executeRaw.mock.calls.some((call) =>
        ((call[0] as { values?: readonly unknown[] }).values ?? []).includes(
          'moderation_delete_reason_missing',
        ),
      ),
    ).toBe(true);
    expect(
      executeRaw.mock.calls.some((call) =>
        ((call[0] as { strings?: readonly string[] }).strings ?? [])
          .join('?')
          .includes('"delete_dispatch_started_at" = CURRENT_TIMESTAMP'),
      ),
    ).toBe(false);
    expect(prisma.moderationDeleteIntentReason.findMany).not.toHaveBeenCalled();
  });

  it('terminalizes channel auto-post cleanup when the current entity is CHAT without a MAX delete', async () => {
    const intent = {
      ...baseIntent,
      entityType: 'CHANNEL' as const,
      routingPolicy: 'origin_only',
      replacementCleanup: true,
      channelAutoPostCleanupReason: true,
      channelAutoPostCleanupOnly: true,
    };
    const executeRaw = jest.fn().mockResolvedValue(1);
    const txQueryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ id: intent.id }])
      .mockResolvedValueOnce([intent]);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({ $queryRaw: txQueryRaw, $executeRaw: executeRaw }),
    );
    const findUnique = jest.fn().mockResolvedValue({ entityType: 'CHAT' });
    const maxHttpDelete = jest.fn();
    const { service, queue } = createService(
      {},
      {
        $queryRaw: jest.fn().mockResolvedValueOnce([intent]),
        $executeRaw: executeRaw,
        $transaction: transaction,
        chat: { findUnique },
      },
      { deleteMessage: maxHttpDelete },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'terminal',
      confirmed: false,
      status: 'FAILED_TERMINAL',
    });

    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'chat-1' },
      select: { entityType: true },
    });
    expect(maxHttpDelete).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
    expect(txQueryRaw.mock.calls[1]?.[0]?.strings?.join('?') ?? '').toContain(
      'AS "channelAutoPostCleanupOnly"',
    );
    const sqlCalls = executeRaw.mock.calls.map(
      (call: unknown[]) => call[0] as { strings?: readonly string[]; values?: readonly unknown[] },
    );
    expect(
      sqlCalls.some((query) =>
        (query.strings?.join('?') ?? '').includes(
          '"delete_dispatch_started_at" = CURRENT_TIMESTAMP',
        ),
      ),
    ).toBe(false);
    expect(
      sqlCalls.find((query) => query.values?.includes('channel_auto_post_cleanup_entity_mismatch'))
        ?.values,
    ).toEqual(
      expect.arrayContaining(['FAILED_TERMINAL', 'channel_auto_post_cleanup_entity_mismatch']),
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'MAX identifies the target as a chat',
      snapshotEntityType: 'chat',
      senderAccess: {
        userId: 'user-1',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      },
      expectedErrorCode: 'channel_auto_post_cleanup_entity_mismatch',
      expectSenderLookup: false,
    },
    {
      label: 'MAX says the sender is no longer an admin',
      snapshotEntityType: 'channel',
      senderAccess: {
        userId: 'user-1',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      },
      expectedErrorCode: 'channel_auto_post_cleanup_sender_not_admin',
      expectSenderLookup: true,
    },
  ])('terminalizes channel cleanup when $label', async (scenario) => {
    const intent = {
      ...baseIntent,
      entityType: 'CHANNEL' as const,
      routingPolicy: 'origin_only',
      replacementCleanup: true,
      channelAutoPostCleanupReason: true,
      channelAutoPostCleanupOnly: true,
    };
    const executeRaw = jest.fn().mockResolvedValue(1);
    const txQueryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ id: intent.id }])
      .mockResolvedValueOnce([intent]);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({ $queryRaw: txQueryRaw, $executeRaw: executeRaw }),
    );
    const getChatSnapshot = jest.fn().mockResolvedValue({
      entityType: scenario.snapshotEntityType,
    });
    const getChatMemberAccess = jest.fn().mockResolvedValue(scenario.senderAccess);
    const maxHttpDelete = jest.fn();
    const { service, queue } = createService(
      {},
      {
        $queryRaw: jest.fn().mockResolvedValueOnce([intent]),
        $executeRaw: executeRaw,
        $transaction: transaction,
        chat: { findUnique: jest.fn().mockResolvedValue({ entityType: 'CHANNEL' }) },
      },
      { deleteMessage: maxHttpDelete, getChatSnapshot, getChatMemberAccess },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'terminal',
      confirmed: false,
      status: 'FAILED_TERMINAL',
    });

    expect(getChatSnapshot).toHaveBeenCalledWith('chat-1', {
      botId: 'bot-1',
      bypassCache: true,
      trafficClass: 'critical',
      actionHealthLane: 'critical',
      sourceTag: 'moderation_delete',
      ignoreFailureMetricStatuses: [403, 404],
      timeoutMs: 5_000,
    });
    expect(getChatMemberAccess).toHaveBeenCalledTimes(scenario.expectSenderLookup ? 1 : 0);
    expect(maxHttpDelete).not.toHaveBeenCalled();
    const terminalUpdate = executeRaw.mock.calls
      .map((call: unknown[]) => call[0] as { values?: readonly unknown[] })
      .find((query) => query.values?.includes(scenario.expectedErrorCode));
    expect(terminalUpdate?.values).toEqual(
      expect.arrayContaining(['FAILED_TERMINAL', scenario.expectedErrorCode]),
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('permits channel auto-post cleanup only while the entity remains CHANNEL', async () => {
    const intent = {
      ...baseIntent,
      entityType: 'CHANNEL' as const,
      routingPolicy: 'origin_only',
      replacementCleanup: true,
      channelAutoPostCleanupReason: true,
      channelAutoPostCleanupOnly: true,
    };
    const completed = {
      ...intent,
      status: 'SUCCEEDED' as const,
      succeededBotId: 'bot-1',
      remoteDeleteSucceededAt: new Date(),
      remoteDeleteSucceededBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const events: string[] = [];
    const executeRaw = jest.fn().mockImplementation(async (query: { strings?: string[] }) => {
      if (
        (query.strings?.join('?') ?? '').includes(
          '"delete_dispatch_started_at" = CURRENT_TIMESTAMP',
        )
      ) {
        events.push('dispatch-fence');
      }
      return 1;
    });
    const findUnique = jest.fn().mockImplementation(async () => {
      events.push('entity-guard');
      return { entityType: 'CHANNEL' };
    });
    const maxHttpDelete = jest.fn().mockImplementation(async () => {
      events.push('max-delete');
    });
    const queryRaw = jest.fn().mockResolvedValueOnce([intent]).mockResolvedValueOnce([completed]);
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: executeRaw, chat: { findUnique } },
      {
        deleteMessage: maxHttpDelete,
        getChatSnapshot: jest.fn().mockResolvedValue({ entityType: 'channel' }),
        getChatMemberAccess: jest.fn().mockResolvedValue({
          userId: 'user-1',
          isAdmin: true,
          isOwner: false,
          permissions: [],
        }),
      },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'confirmed',
      confirmed: true,
      status: 'SUCCEEDED',
    });

    expect(findUnique).toHaveBeenCalledTimes(3);
    expect(maxHttpDelete).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      'entity-guard',
      'dispatch-fence',
      'entity-guard',
      'entity-guard',
      'max-delete',
    ]);
  });

  it('clears the dispatch fence when a channel becomes a CHAT between the two delete guards', async () => {
    const intent = {
      ...baseIntent,
      entityType: 'CHANNEL' as const,
      routingPolicy: 'origin_only',
      replacementCleanup: true,
      channelAutoPostCleanupReason: true,
      channelAutoPostCleanupOnly: true,
    };
    const events: string[] = [];
    const executeRaw = jest.fn().mockImplementation(async (query: { strings?: string[] }) => {
      const sql = query.strings?.join('?') ?? '';
      if (sql.includes('"delete_dispatch_started_at" = CURRENT_TIMESTAMP')) {
        events.push('dispatch-fence');
      } else if (
        sql.includes('"delete_dispatch_started_at" = NULL') &&
        sql.includes('AND "delete_dispatch_started_at" IS NOT NULL')
      ) {
        events.push('clear-fence');
      } else if (sql.includes('"status" = CAST(? AS "ModerationDeleteIntentStatus")')) {
        events.push('terminal-status');
      }
      return 1;
    });
    const txQueryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ id: intent.id }])
      .mockResolvedValueOnce([intent]);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({ $queryRaw: txQueryRaw, $executeRaw: executeRaw }),
    );
    const findUnique = jest
      .fn()
      .mockImplementationOnce(async () => {
        events.push('entity-guard:CHANNEL');
        return { entityType: 'CHANNEL' };
      })
      .mockImplementationOnce(async () => {
        events.push('entity-guard:CHAT');
        return { entityType: 'CHAT' };
      });
    const maxHttpDelete = jest.fn(async () => {
      events.push('max-http');
    });
    const { service, queue } = createService(
      {},
      {
        $queryRaw: jest.fn().mockResolvedValueOnce([intent]),
        $executeRaw: executeRaw,
        $transaction: transaction,
        chat: { findUnique },
      },
      {
        deleteMessage: maxHttpDelete,
        getChatSnapshot: jest.fn().mockResolvedValue({ entityType: 'channel' }),
        getChatMemberAccess: jest.fn().mockResolvedValue({
          userId: 'user-1',
          isAdmin: true,
          isOwner: false,
          permissions: [],
        }),
      },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'terminal',
      confirmed: false,
      status: 'FAILED_TERMINAL',
    });

    expect(findUnique).toHaveBeenCalledTimes(2);
    expect(maxHttpDelete).not.toHaveBeenCalled();
    expect(events).toEqual([
      'entity-guard:CHANNEL',
      'dispatch-fence',
      'entity-guard:CHAT',
      'clear-fence',
      'terminal-status',
    ]);
    const terminalUpdate = executeRaw.mock.calls
      .map(
        (call: unknown[]) =>
          call[0] as { strings?: readonly string[]; values?: readonly unknown[] },
      )
      .find((query) =>
        (query.strings?.join('?') ?? '').includes(
          '"status" = CAST(? AS "ModerationDeleteIntentStatus")',
        ),
      );
    expect(terminalUpdate?.values).toEqual(
      expect.arrayContaining(['FAILED_TERMINAL', 'channel_auto_post_cleanup_entity_mismatch']),
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('retries a channel entity rejection when a concurrent independent reason is executable', async () => {
    const intent = {
      ...baseIntent,
      entityType: 'CHANNEL' as const,
      routingPolicy: 'origin_only',
      replacementCleanup: true,
      channelAutoPostCleanupReason: true,
      channelAutoPostCleanupOnly: true,
    };
    const mixedIntent = {
      ...intent,
      channelAutoPostCleanupOnly: false,
      nonCommercialOcrDeleteReason: true,
    };
    const executeRaw = jest.fn().mockResolvedValue(1);
    const txQueryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ id: intent.id }])
      .mockResolvedValueOnce([mixedIntent]);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({ $queryRaw: txQueryRaw, $executeRaw: executeRaw }),
    );
    const maxHttpDelete = jest.fn();
    const { service, queue } = createService(
      {},
      {
        $queryRaw: jest.fn().mockResolvedValueOnce([intent]),
        $executeRaw: executeRaw,
        $transaction: transaction,
        chat: { findUnique: jest.fn().mockResolvedValue({ entityType: 'CHAT' }) },
      },
      { deleteMessage: maxHttpDelete },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'pending',
      confirmed: false,
      status: 'RETRYABLE',
    });

    expect(maxHttpDelete).not.toHaveBeenCalled();
    const retryableUpdate = executeRaw.mock.calls
      .map(
        (call: unknown[]) =>
          call[0] as { strings?: readonly string[]; values?: readonly unknown[] },
      )
      .find((query) =>
        (query.strings?.join('?') ?? '').includes(
          '"status" = CAST(? AS "ModerationDeleteIntentStatus")',
        ),
      );
    expect(retryableUpdate?.values).toEqual(
      expect.arrayContaining(['RETRYABLE', 'channel_auto_post_cleanup_entity_mismatch', null]),
    );
    expect(retryableUpdate?.values).not.toContain('FAILED_TERMINAL');
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('does not let a shadow OCR reason authorize stale channel cleanup in a CHAT', async () => {
    const intent = {
      ...baseIntent,
      entityType: 'CHANNEL' as const,
      routingPolicy: 'origin_only',
      replacementCleanup: true,
      channelAutoPostCleanupReason: true,
      channelAutoPostCleanupOnly: true,
    };
    const mixedIntent = {
      ...intent,
      channelAutoPostCleanupOnly: false,
      commercialOcrGuardRequired: true,
      commercialOcrDeleteReason: true,
      nonCommercialOcrDeleteReason: false,
    };
    const executeRaw = jest.fn().mockResolvedValue(1);
    const txQueryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ id: intent.id }])
      .mockResolvedValueOnce([mixedIntent]);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({ $queryRaw: txQueryRaw, $executeRaw: executeRaw }),
    );
    const maxHttpDelete = jest.fn();
    const { service, queue } = createService(
      { COMMERCIAL_OCR_ROLLOUT_MODE: 'shadow' },
      {
        $queryRaw: jest.fn().mockResolvedValueOnce([intent]),
        $executeRaw: executeRaw,
        $transaction: transaction,
        chat: { findUnique: jest.fn().mockResolvedValue({ entityType: 'CHAT' }) },
      },
      { deleteMessage: maxHttpDelete },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'terminal',
      confirmed: false,
      status: 'FAILED_TERMINAL',
    });

    expect(maxHttpDelete).not.toHaveBeenCalled();
    const terminalUpdate = executeRaw.mock.calls
      .map(
        (call: unknown[]) =>
          call[0] as { strings?: readonly string[]; values?: readonly unknown[] },
      )
      .find((query) =>
        (query.strings?.join('?') ?? '').includes(
          '"status" = CAST(? AS "ModerationDeleteIntentStatus")',
        ),
      );
    expect(terminalUpdate?.values).toEqual(
      expect.arrayContaining(['FAILED_TERMINAL', 'channel_auto_post_cleanup_entity_mismatch']),
    );
    expect(terminalUpdate?.values).not.toContain('RETRYABLE');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('keeps an OCR-only intent fail-closed when its guard is unavailable', async () => {
    const intent = {
      ...baseIntent,
      commercialOcrGuardRequired: true,
      commercialOcrDeleteReason: true,
      nonCommercialOcrDeleteReason: false,
    };
    const retryable = {
      ...intent,
      status: 'RETRYABLE',
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
      lastErrorCode: 'delete_pre_dispatch_guard_rejected',
    };
    const assertIntentStillActionable = jest.fn().mockRejectedValue(new Error('OCR disabled'));
    const queryRaw = jest.fn().mockResolvedValueOnce([intent]).mockResolvedValueOnce([retryable]);
    const deleteMessage = jest.fn();
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      { deleteMessage },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
      undefined,
      undefined,
      { assertIntentStillActionable },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).rejects.toThrow(
      'OCR disabled',
    );
    expect(assertIntentStillActionable).toHaveBeenCalledTimes(1);
    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'its OCR deadline expired',
      commercialOcrDeadlineAt: new Date(Date.now() - 1_000),
      guardError: new CommercialOcrDeleteGuardRejectedError(
        'commercial_ocr_deadline_expired',
        'OCR deadline expired',
      ),
    },
    {
      label: 'OCR runtime authority was revoked',
      commercialOcrDeadlineAt: new Date(Date.now() + 60_000),
      guardError: new CommercialOcrDeleteGuardRejectedError(
        'commercial_ocr_runtime_revoked',
        'OCR runtime revoked',
      ),
    },
  ])(
    'dispatches through an independently executable reason after $label',
    async ({ commercialOcrDeadlineAt, guardError }) => {
      const intent = {
        ...baseIntent,
        commercialOcrGuardRequired: true,
        commercialOcrDeadlineAt,
        commercialOcrDeleteReason: true,
        nonCommercialOcrDeleteReason: true,
      };
      const completed = {
        ...intent,
        status: 'SUCCEEDED' as const,
        succeededBotId: 'bot-1',
        remoteDeleteSucceededAt: new Date(),
        remoteDeleteSucceededBotId: 'bot-1',
        leaseToken: null,
        leaseExpiresAt: null,
      };
      const queryRaw = jest.fn().mockResolvedValueOnce([intent]).mockResolvedValueOnce([completed]);
      const executeRaw = jest.fn().mockResolvedValue(1);
      const deleteMessage = jest.fn().mockResolvedValue(undefined);
      const assertIntentStillActionable = jest.fn().mockRejectedValue(guardError);
      const { service } = createService(
        {},
        {
          $queryRaw: queryRaw,
          $executeRaw: executeRaw,
          moderationDeleteIntentReason: {
            findMany: jest.fn().mockResolvedValue([
              {
                ruleCode: COMMERCIAL_OCR_DELETE_RULE_CODE,
                reasonKey: 'ocr',
                score: 1,
                metadata: commercialOcrClaimedIntentInput().intent.event!.metadata,
              },
              {
                ruleCode: 'MESSAGE_TOO_LONG_DELETE',
                reasonKey: 'length',
                score: 1,
                metadata: {},
              },
            ]),
          },
        },
        { deleteMessage },
        { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
        undefined,
        undefined,
        { assertIntentStillActionable },
      );
      Object.assign(service, {
        messageLimitsDeleteGuard: messageLimitsGuardFixture(async () => ({
          reasonKeys: ['length'],
        })),
      });

      await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
        kind: 'confirmed',
        confirmed: true,
        status: 'SUCCEEDED',
      });

      expect(assertIntentStillActionable).toHaveBeenCalledTimes(1);
      expect(deleteMessage).toHaveBeenCalledTimes(1);
      expect(
        executeRaw.mock.calls.some((call) =>
          ((call[0] as { strings?: readonly string[] }).strings ?? [])
            .join('?')
            .includes('COALESCE(intent."commercial_ocr_deadline_at"'),
        ),
      ).toBe(false);
    },
  );

  it.each(['on', 'baseline'] as const)(
    'keeps a fresh %s OCR guard when the attached non-OCR reason is outside its rollout',
    async (mode) => {
      const intent = {
        ...baseIntent,
        commercialOcrGuardRequired: true,
        commercialOcrDeleteReason: true,
        nonCommercialOcrDeleteReason: true,
      };
      const terminal = {
        ...intent,
        status: 'FAILED_TERMINAL' as const,
        leaseToken: null,
        leaseExpiresAt: null,
        leasedFromStatus: null,
        lastErrorCode: 'commercial_ocr_runtime_revoked',
      };
      const guardError = new CommercialOcrDeleteGuardRejectedError(
        'commercial_ocr_runtime_revoked',
        'OCR runtime revoked',
      );
      const assertIntentStillActionable = jest.fn().mockRejectedValue(guardError);
      const queryRaw = jest.fn().mockResolvedValueOnce([intent]).mockResolvedValueOnce([terminal]);
      const executeRaw = jest.fn().mockResolvedValue(1);
      const txQueryRaw = jest
        .fn()
        .mockResolvedValueOnce([{ id: intent.id }])
        .mockResolvedValueOnce([intent]);
      const transaction = jest.fn(
        async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
          callback({ $queryRaw: txQueryRaw, $executeRaw: executeRaw }),
      );
      const deleteMessage = jest.fn();
      const { service } = createService(
        { MODERATION_DELETE_INTENT_MODE: 'shadow', COMMERCIAL_OCR_ROLLOUT_MODE: mode },
        { $queryRaw: queryRaw, $executeRaw: executeRaw, $transaction: transaction },
        { deleteMessage },
        { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
        undefined,
        undefined,
        { assertIntentStillActionable },
      );

      await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
        kind: 'terminal',
        status: 'FAILED_TERMINAL',
      });

      expect(assertIntentStillActionable).toHaveBeenCalledTimes(1);
      expect(deleteMessage).not.toHaveBeenCalled();
    },
  );

  it('keeps a concurrent executable reason retryable when an OCR guard rejects terminally', async () => {
    const staleOcrOnlyIntent = {
      ...baseIntent,
      commercialOcrGuardRequired: true,
      commercialOcrDeleteReason: true,
      nonCommercialOcrDeleteReason: false,
    };
    const mixedIntentAtLockBoundary = {
      ...staleOcrOnlyIntent,
      nonCommercialOcrDeleteReason: true,
      retryUntilAt: new Date(Date.now() + 120_000),
    };
    const guardError = new CommercialOcrDeleteGuardRejectedError(
      'commercial_ocr_runtime_revoked',
      'OCR runtime revoked',
    );
    const executeRaw = jest.fn().mockResolvedValue(1);
    const txQueryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ id: staleOcrOnlyIntent.id }])
      .mockResolvedValueOnce([mixedIntentAtLockBoundary]);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({ $queryRaw: txQueryRaw, $executeRaw: executeRaw }),
    );
    const remoteDelete = jest.fn();
    const { service, queue } = createService(
      {},
      {
        $queryRaw: jest.fn().mockResolvedValueOnce([staleOcrOnlyIntent]),
        $executeRaw: executeRaw,
        $transaction: transaction,
      },
      { deleteMessage: remoteDelete },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
      undefined,
      undefined,
      { assertIntentStillActionable: jest.fn().mockRejectedValue(guardError) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'pending',
      status: 'RETRYABLE',
      confirmed: false,
    });

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    });
    expect(remoteDelete).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(txQueryRaw.mock.calls[0]?.[0]?.strings?.join('?')).toContain('FOR UPDATE');
    const freshClassifierSql = txQueryRaw.mock.calls[1]?.[0]?.strings?.join('?') ?? '';
    expect(freshClassifierSql).toContain('AS "nonCommercialOcrDeleteReason"');
    expect(freshClassifierSql).toContain('AS "replacementCleanup"');
    expect(freshClassifierSql).toContain('AS "botMessageAutoDeleteReason"');
    const terminalBoundary = executeRaw.mock.calls
      .map((call) => call[0] as { values?: readonly unknown[] })
      .find((query) => query.values?.includes('commercial_ocr_runtime_revoked'));
    expect(terminalBoundary?.values).toEqual(
      expect.arrayContaining(['RETRYABLE', 'commercial_ocr_runtime_revoked']),
    );
  });

  it('discovers a commercial OCR reason when an old writer left the ownership flag false', async () => {
    const intent = { ...baseIntent, commercialOcrGuardRequired: false };
    const completed = {
      ...intent,
      status: 'SUCCEEDED',
      succeededBotId: 'bot-1',
      remoteDeleteSucceededAt: new Date(),
      remoteDeleteSucceededBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const reasonFindFirst = jest
      .fn()
      .mockResolvedValueOnce({ id: 'reason-1' })
      .mockResolvedValueOnce({ id: 'ocr-reason-1' })
      .mockResolvedValueOnce({ id: 'reason-1' })
      .mockResolvedValueOnce({ id: 'ocr-reason-1' });
    const assertIntentStillActionable = jest.fn().mockResolvedValue('allowed');
    const queryRaw = jest.fn().mockResolvedValueOnce([intent]).mockResolvedValueOnce([completed]);
    const { service } = createService(
      {},
      {
        $queryRaw: queryRaw,
        $executeRaw: jest.fn().mockResolvedValue(1),
        moderationDeleteIntentReason: {
          findFirst: reasonFindFirst,
          findMany: jest.fn().mockResolvedValue([
            {
              ruleCode: COMMERCIAL_OCR_DELETE_RULE_CODE,
              reasonKey: 'ocr',
              score: 1,
              metadata: commercialOcrClaimedIntentInput().intent.event!.metadata,
            },
          ]),
        },
      },
      {},
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
      undefined,
      undefined,
      { assertIntentStillActionable },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'confirmed',
    });

    expect(assertIntentStillActionable).toHaveBeenCalledTimes(2);
    expect(reasonFindFirst).toHaveBeenCalledWith({
      where: { intentId: 'intent-1', ruleCode: COMMERCIAL_OCR_DELETE_RULE_CODE },
      select: { id: true },
    });
  });

  it('repairs OCR ownership without capping the shared horizon when a reason is merged', async () => {
    const ocrDeadline = new Date(Date.now() + 60_000);
    const independentDeadline = new Date(ocrDeadline.getTime() + 60_000);
    const persisted = {
      ...baseIntent,
      status: 'PENDING' as const,
      commercialOcrGuardRequired: true,
      commercialOcrDeadlineAt: ocrDeadline,
      retryUntilAt: independentDeadline,
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const txQueryRaw = jest.fn().mockResolvedValue([persisted]);
    const txExecuteRaw = jest.fn().mockResolvedValue(1);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({
          $queryRaw: txQueryRaw,
          $executeRaw: txExecuteRaw,
        }),
    );
    const { service } = createService({}, { $transaction: transaction });

    await expect(
      service.ensureIntent({
        chatId: 'chat-1',
        messageId: 'message-1',
        reasonKey: 'independent-delete',
        ruleCode: 'INDEPENDENT_DELETE',
        subjectUserId: 'user-1',
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        originBotId: 'bot-1',
        retryUntilAt: independentDeadline,
      }),
    ).resolves.toMatchObject({ intentId: 'intent-1', status: 'PENDING' });

    const query = txQueryRaw.mock.calls[0]?.[0];
    const sql = query?.strings?.join('?') ?? '';
    expect(sql).toContain('FROM "moderation_delete_intent_reasons" existing_ocr_reason');
    expect(sql).toContain('existing_ocr_reason."rule_code" =');
    expect(sql).toContain('"commercial_ocr_guard_required" = (');
    expect(sql).toContain('"commercial_ocr_deadline_at" = CASE');
    const retryUntilSql = sql.match(/"retry_until_at" = CASE[\s\S]*?END,\s*"completed_at"/u)?.[0];
    expect(retryUntilSql).toContain('THEN GREATEST(');
    expect(retryUntilSql).not.toContain('THEN LEAST(');
    expect(retryUntilSql).toContain('ELSE "moderation_delete_intents"."retry_until_at"');
    const reasonSql = txExecuteRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    expect(reasonSql).toContain('WITH changed_reason AS');
    expect(reasonSql).toContain('"execute_at" = LEAST(');
    expect(reasonSql).toContain('"next_attempt_at" = LEAST(');
    expect(reasonSql).toContain('"retry_until_at" = GREATEST(');
    expect(query?.values).toContain(COMMERCIAL_OCR_DELETE_RULE_CODE);
  });

  it('reopens a terminal OCR-only intent after a new executable reason commits', async () => {
    const independentDeadline = new Date(Date.now() + 120_000);
    const terminalOcrIntent = {
      ...baseIntent,
      status: 'FAILED_TERMINAL' as const,
      commercialOcrGuardRequired: true,
      commercialOcrDeleteReason: true,
      nonCommercialOcrDeleteReason: false,
      lastErrorCode: 'commercial_ocr_runtime_revoked',
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const reopened = {
      ...terminalOcrIntent,
      status: 'PENDING' as const,
      retryUntilAt: independentDeadline,
      lastErrorCode: null,
      nonCommercialOcrDeleteReason: true,
    };
    const txQueryRaw = jest
      .fn()
      .mockResolvedValueOnce([terminalOcrIntent])
      .mockResolvedValueOnce([reopened]);
    const txExecuteRaw = jest.fn().mockResolvedValue(1);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({ $queryRaw: txQueryRaw, $executeRaw: txExecuteRaw }),
    );
    const { service, queue } = createService({}, { $transaction: transaction });

    await expect(
      service.ensureIntent({
        chatId: 'chat-1',
        messageId: 'message-1',
        reasonKey: 'independent-delete-after-ocr',
        ruleCode: 'INDEPENDENT_DELETE',
        subjectUserId: 'user-1',
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        originBotId: 'bot-1',
        retryUntilAt: independentDeadline,
      }),
    ).resolves.toEqual({ intentId: 'intent-1', rollout: 'execute', status: 'PENDING' });

    const reopenQuery = txQueryRaw.mock.calls[1]?.[0];
    const reopenSql = reopenQuery?.strings?.join('?') ?? '';
    expect(reopenSql).toContain('"commercial_ocr_guard_required" = TRUE');
    expect(reopenSql).toContain('"remote_delete_succeeded_at" IS NULL');
    expect(reopenSql).toContain('"remote_delete_succeeded_bot_id" IS NULL');
    expect(reopenSql).toContain('"delete_dispatch_started_at" IS NULL');
    expect(reopenSql).toContain('"delete_dispatch_started_bot_id" IS NULL');
    expect(reopenSql).toContain('"last_error_code" LIKE \'commercial_ocr_%\'');
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('does not reopen a terminal OCR intent with an unresolved dispatch marker', async () => {
    const independentDeadline = new Date(Date.now() + 120_000);
    const terminalWithDispatch = {
      ...baseIntent,
      status: 'FAILED_TERMINAL' as const,
      commercialOcrGuardRequired: true,
      lastErrorCode: 'commercial_ocr_runtime_revoked',
      deleteDispatchStartedAt: new Date(),
      deleteDispatchStartedBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const txQueryRaw = jest
      .fn()
      .mockResolvedValueOnce([terminalWithDispatch])
      .mockResolvedValueOnce([]);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({
          $queryRaw: txQueryRaw,
          $executeRaw: jest.fn().mockResolvedValue(1),
        }),
    );
    const { service, queue } = createService({}, { $transaction: transaction });

    await expect(
      service.ensureIntent({
        chatId: 'chat-1',
        messageId: 'message-1',
        reasonKey: 'independent-delete-after-ambiguous-ocr',
        ruleCode: 'INDEPENDENT_DELETE',
        subjectUserId: 'user-1',
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        originBotId: 'bot-1',
        retryUntilAt: independentDeadline,
      }),
    ).resolves.toEqual({
      intentId: 'intent-1',
      rollout: 'execute',
      status: 'FAILED_TERMINAL',
    });

    expect(queue.add).not.toHaveBeenCalled();
  });

  it.each(['MESSAGE_BLOCKED_WORD_DELETE', 'PROFANITY_DELETE'])(
    'reopens an obsolete profanity intent only for a new independent reason: %s',
    async (ruleCode) => {
      const terminal = {
        ...baseIntent,
        status: 'FAILED_TERMINAL',
        lastErrorCode: 'profanity_violation_no_longer_present',
        leaseToken: null,
        leaseExpiresAt: null,
        leasedFromStatus: null,
      };
      const reopened = { ...terminal, status: 'PENDING', lastErrorCode: null };
      const txQueryRaw = jest
        .fn()
        .mockResolvedValueOnce([terminal])
        .mockResolvedValueOnce([reopened]);
      const txExecuteRaw = jest.fn().mockResolvedValue(1);
      const { service, queue } = createService(
        {},
        {
          $transaction: jest.fn(async (callback: (tx: unknown) => unknown) =>
            callback({ $queryRaw: txQueryRaw, $executeRaw: txExecuteRaw }),
          ),
        },
      );

      await expect(
        service.ensureIntent({
          chatId: 'chat-1',
          messageId: 'message-1',
          reasonKey: 'new-reason',
          ruleCode,
          subjectUserId: 'user-1',
          entityType: 'CHAT',
          messageAuthorKind: 'user',
          originBotId: 'bot-1',
        }),
      ).resolves.toMatchObject({
        status: ruleCode === 'PROFANITY_DELETE' ? 'FAILED_TERMINAL' : 'PENDING',
      });

      expect(txQueryRaw).toHaveBeenCalledTimes(ruleCode === 'PROFANITY_DELETE' ? 1 : 2);
      expect(queue.add).toHaveBeenCalledTimes(ruleCode === 'PROFANITY_DELETE' ? 0 : 1);
      if (ruleCode !== 'PROFANITY_DELETE') {
        const query = txQueryRaw.mock.calls[1]?.[0];
        const sql = query.strings.join('?');
        expect(sql).toContain('"last_error_code" LIKE \'profanity_%\'');
        expect(sql).toContain('"delete_dispatch_started_at" IS NULL');
        expect(sql).toContain('"remote_delete_succeeded_at" IS NULL');
        expect(sql).toContain('"retry_until_at" = GREATEST');
        expect(sql).toContain('current_entity."entity_type" =');
        expect(query.values).toContain(true);
      }
    },
  );

  it('reopens a channel cleanup entity rejection when a later independent reason commits', async () => {
    const independentDeadline = new Date(Date.now() + 120_000);
    const terminalChannelCleanup = {
      ...baseIntent,
      entityType: 'CHANNEL' as const,
      routingPolicy: 'origin_only',
      replacementCleanup: true,
      channelAutoPostCleanupReason: true,
      channelAutoPostCleanupOnly: true,
      status: 'FAILED_TERMINAL' as const,
      completedAt: new Date(),
      lastErrorCode: 'channel_auto_post_cleanup_entity_mismatch',
      lastError: 'Entity is no longer a channel',
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const reopened = {
      ...terminalChannelCleanup,
      entityType: 'CHAT' as const,
      status: 'PENDING' as const,
      retryUntilAt: independentDeadline,
      completedAt: null,
      lastErrorCode: null,
      lastError: null,
      channelAutoPostCleanupOnly: false,
      nonCommercialOcrDeleteReason: true,
    };
    const txQueryRaw = jest
      .fn()
      .mockResolvedValueOnce([terminalChannelCleanup])
      .mockResolvedValueOnce([reopened]);
    const txExecuteRaw = jest.fn().mockResolvedValue(1);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({ $queryRaw: txQueryRaw, $executeRaw: txExecuteRaw }),
    );
    const { service, queue } = createService({}, { $transaction: transaction });

    await expect(
      service.ensureIntent({
        chatId: 'chat-1',
        messageId: 'message-1',
        reasonKey: 'independent-delete-after-channel-cleanup-rejection',
        ruleCode: 'INDEPENDENT_DELETE',
        subjectUserId: 'user-1',
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        originBotId: 'bot-1',
        retryUntilAt: independentDeadline,
      }),
    ).resolves.toEqual({ intentId: 'intent-1', rollout: 'execute', status: 'PENDING' });

    expect(txQueryRaw).toHaveBeenCalledTimes(2);
    const upsertSql = txQueryRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    expect(upsertSql).toContain(
      'FROM "moderation_delete_intent_reasons" stored_channel_cleanup_reason',
    );
    expect(upsertSql).toContain('current_entity."entity_type" = EXCLUDED."entity_type"');
    const reopenQuery = txQueryRaw.mock.calls[1]?.[0];
    const reopenSql = reopenQuery?.strings?.join('?') ?? '';
    expect(reopenSql).toContain('"last_error_code" IN');
    expect(reopenSql).toContain('"remote_delete_succeeded_at" IS NULL');
    expect(reopenSql).toContain('"remote_delete_succeeded_bot_id" IS NULL');
    expect(reopenSql).toContain('"delete_dispatch_started_at" IS NULL');
    expect(reopenSql).toContain('"delete_dispatch_started_bot_id" IS NULL');
    expect(reopenSql).toContain('"last_status_code" = NULL');
    expect(reopenSql).toContain('"last_error_code" = NULL');
    expect(reopenSql).toContain('"completed_at" = NULL');
    expect(reopenSql).toContain('"lease_token" = NULL');
    expect(reopenSql).toContain('"retry_until_at" = GREATEST');
    expect(reopenSql).toContain('"entity_type" = CAST(? AS "ChatEntityType")');
    expect(reopenSql).toContain('current_entity."entity_type" =');
    expect(reopenQuery?.values).toEqual(
      expect.arrayContaining([
        'CHAT',
        'origin_only',
        'channel_auto_post_cleanup_entity_mismatch',
        'channel_auto_post_cleanup_sender_not_admin',
      ]),
    );
    expect(queue.add).toHaveBeenCalledWith(
      'execute-moderation-delete-intent',
      { intentId: 'intent-1' },
      expect.objectContaining({ priority: 1 }),
    );
  });

  it.each([
    ['night_mode_close_notice_cleanup_stale', 'INDEPENDENT_DELETE'],
    ['stop_words_delete_no_longer_authorized', 'INDEPENDENT_DELETE'],
    ['stop_words_delete_no_longer_authorized', 'MESSAGE_BLOCKED_WORD_DELETE'],
    ['commercial_text_message_changed', 'INDEPENDENT_DELETE'],
    ['commercial_text_message_changed', 'COMMERCIAL_AD_DELETE'],
  ])('reopens %s when a fresh %s reason commits', async (priorError, ruleCode) => {
    const independentDeadline = new Date(Date.now() + 120_000);
    const terminalNightCleanup = {
      ...baseIntent,
      entityType: 'CHAT' as const,
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      nightModeCloseNoticeCleanupReason: true,
      nightModeCloseNoticeCleanupOnly: true,
      status: 'FAILED_TERMINAL' as const,
      completedAt: new Date(),
      lastErrorCode: priorError,
      lastError: 'Night mode cleanup generation changed',
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const reopened = {
      ...terminalNightCleanup,
      status: 'PENDING' as const,
      retryUntilAt: independentDeadline,
      completedAt: null,
      lastErrorCode: null,
      lastError: null,
      nightModeCloseNoticeCleanupOnly: false,
      nonCommercialOcrDeleteReason: true,
    };
    const txQueryRaw = jest
      .fn()
      .mockResolvedValueOnce([terminalNightCleanup])
      .mockResolvedValueOnce([reopened]);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({
          $queryRaw: txQueryRaw,
          $executeRaw: jest.fn().mockResolvedValue(1),
        }),
    );
    const { service, queue } = createService({}, { $transaction: transaction });

    await expect(
      service.ensureIntent({
        chatId: 'chat-1',
        messageId: 'message-1',
        reasonKey: 'independent-delete-after-night-cleanup-stale',
        ruleCode,
        subjectUserId: 'user-1',
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        originBotId: 'bot-1',
        retryUntilAt: independentDeadline,
      }),
    ).resolves.toEqual({ intentId: 'intent-1', rollout: 'execute', status: 'PENDING' });

    const reopenQuery = txQueryRaw.mock.calls[1]?.[0];
    const reopenSql = reopenQuery?.strings?.join('?') ?? '';
    expect(reopenSql).toContain('"last_error_code" IN');
    expect(reopenSql).toContain('"remote_delete_succeeded_at" IS NULL');
    expect(reopenSql).toContain('"delete_dispatch_started_at" IS NULL');
    expect(reopenQuery?.values).toEqual(
      expect.arrayContaining(['night_mode_close_notice_cleanup_stale', 'CHAT', 'origin_only']),
    );
    expect(queue.add).toHaveBeenCalledWith(
      'execute-moderation-delete-intent',
      { intentId: 'intent-1' },
      expect.objectContaining({ priority: 1 }),
    );
  });

  it('reopens an expired intent only after a fresh bound commercial revision is inserted', async () => {
    const expired = {
      ...baseIntent,
      status: 'EXPIRED',
      entityType: 'CHAT',
      leaseToken: null,
      leaseExpiresAt: null,
      completedAt: new Date(),
      lastErrorCode: 'retry_horizon_exceeded',
    };
    const pending = { ...expired, status: 'PENDING', completedAt: null, lastErrorCode: null };
    const txQueryRaw = jest.fn().mockResolvedValueOnce([expired]).mockResolvedValueOnce([pending]);
    const { service } = createService(
      {},
      {
        $transaction: jest.fn(async (callback) =>
          callback({ $queryRaw: txQueryRaw, $executeRaw: jest.fn().mockResolvedValue(1) }),
        ),
      },
    );
    const eventTimestampMs = Date.now();
    await expect(
      service.ensureIntent({
        chatId: 'chat-1',
        messageId: 'message-1',
        subjectUserId: 'user-1',
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        originBotId: 'bot-1',
        reasonKey: 'fresh-commercial-revision',
        ruleCode: 'COMMERCIAL_AD_DELETE',
        retryUntilAt: new Date(eventTimestampMs + 300_000),
        event: {
          metadata: {
            commercialTextBinding: {
              version: 2,
              decisionVersion: 'commercial-deterministic-v3',
              detectorSourceSha256: 'a'.repeat(64),
              sourceSha256: 'b'.repeat(64),
              settingsSha256: 'c'.repeat(64),
              eventTimestampMs,
              deadlineAtMs: eventTimestampMs + 300_000,
              campaignContext: null,
            },
          },
        },
      }),
    ).resolves.toMatchObject({ status: 'PENDING' });
    const query = txQueryRaw.mock.calls[1][0] as Prisma.Sql;
    expect(query.strings.join('?')).toContain(
      '"status" = CAST(\'EXPIRED\' AS "ModerationDeleteIntentStatus")',
    );
    expect(query.strings.join('?')).toContain('"delete_dispatch_started_at" IS NULL');
    expect(query.strings.join('?')).toContain('"remote_delete_succeeded_at" IS NULL');
  });

  it('does not reopen a channel cleanup entity rejection with an unresolved dispatch marker', async () => {
    const independentDeadline = new Date(Date.now() + 120_000);
    const terminalWithDispatch = {
      ...baseIntent,
      entityType: 'CHANNEL' as const,
      routingPolicy: 'origin_only',
      replacementCleanup: true,
      channelAutoPostCleanupReason: true,
      channelAutoPostCleanupOnly: true,
      status: 'FAILED_TERMINAL' as const,
      completedAt: new Date(),
      lastErrorCode: 'channel_auto_post_cleanup_entity_mismatch',
      deleteDispatchStartedAt: new Date(),
      deleteDispatchStartedBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const txQueryRaw = jest
      .fn()
      .mockResolvedValueOnce([terminalWithDispatch])
      .mockResolvedValueOnce([]);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({
          $queryRaw: txQueryRaw,
          $executeRaw: jest.fn().mockResolvedValue(1),
        }),
    );
    const { service, queue } = createService({}, { $transaction: transaction });

    await expect(
      service.ensureIntent({
        chatId: 'chat-1',
        messageId: 'message-1',
        reasonKey: 'independent-delete-after-ambiguous-channel-cleanup',
        ruleCode: 'INDEPENDENT_DELETE',
        subjectUserId: 'user-1',
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        originBotId: 'bot-1',
        retryUntilAt: independentDeadline,
      }),
    ).resolves.toEqual({
      intentId: 'intent-1',
      rollout: 'execute',
      status: 'FAILED_TERMINAL',
    });

    const reopenSql = txQueryRaw.mock.calls[1]?.[0]?.strings?.join('?') ?? '';
    expect(reopenSql).toContain('"delete_dispatch_started_at" IS NULL');
    expect(reopenSql).toContain('"delete_dispatch_started_bot_id" IS NULL');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('immediately wakes a mixed intent through the independent rollout outside the OCR cohort', async () => {
    const persisted = {
      ...baseIntent,
      status: 'PENDING' as const,
      commercialOcrGuardRequired: true,
      commercialOcrDeleteReason: true,
      nonCommercialOcrDeleteReason: true,
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const txQueryRaw = jest.fn().mockResolvedValue([persisted]);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({
          $queryRaw: txQueryRaw,
          $executeRaw: jest.fn().mockResolvedValue(1),
        }),
    );
    const { service, queue } = createService(
      {
        MODERATION_DELETE_INTENT_MODE: 'on',
        COMMERCIAL_OCR_ROLLOUT_MODE: 'shadow',
      },
      { $transaction: transaction },
    );

    await expect(service.ensureIntent(commercialOcrClaimedIntentInput().intent)).resolves.toEqual({
      intentId: 'intent-1',
      rollout: 'execute',
      status: 'PENDING',
    });

    const upsert = txQueryRaw.mock.calls[0]?.[0];
    const sql = upsert?.strings?.join('?') ?? '';
    expect(sql).toMatch(/"retry_until_at" = CASE[\s\S]*?THEN GREATEST\(/u);
    const reasonState = txQueryRaw.mock.calls[1]?.[0];
    const reasonStateSql = reasonState?.strings?.join('?') ?? '';
    expect(reasonStateSql).toContain('existing_non_ocr_reason."intent_id"');
    expect(reasonStateSql).toContain('existing_non_ocr_reason."rule_code" <>');
    expect(reasonState?.values).toEqual(
      expect.arrayContaining(['intent-1', COMMERCIAL_OCR_DELETE_RULE_CODE]),
    );
    expect(queue.add).toHaveBeenCalledWith(
      'execute-moderation-delete-intent',
      { intentId: 'intent-1' },
      expect.objectContaining({ priority: 1 }),
    );
  });

  it('preserves immediate replacement cleanup execution when an OCR reason is merged', async () => {
    const persisted = {
      ...baseIntent,
      status: 'PENDING' as const,
      commercialOcrGuardRequired: true,
      commercialOcrDeleteReason: true,
      nonCommercialOcrDeleteReason: true,
      replacementCleanup: true,
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const txQueryRaw = jest.fn().mockResolvedValue([persisted]);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({
          $queryRaw: txQueryRaw,
          $executeRaw: jest.fn().mockResolvedValue(1),
        }),
    );
    const { service, queue } = createService(
      {
        MODERATION_DELETE_INTENT_MODE: 'shadow',
        COMMERCIAL_OCR_ROLLOUT_MODE: 'shadow',
      },
      { $transaction: transaction },
    );

    await expect(service.ensureIntent(commercialOcrClaimedIntentInput().intent)).resolves.toEqual({
      intentId: 'intent-1',
      rollout: 'execute',
      status: 'PENDING',
    });

    const reasonState = txQueryRaw.mock.calls[1]?.[0];
    const sql = reasonState?.strings?.join('?') ?? '';
    expect(sql).toContain('existing_replacement_reason."intent_id"');
    expect(sql).toContain('existing_replacement_reason."rule_code" IN');
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: 'explicit off', mode: 'off' },
    { label: 'missing-control shadow', mode: 'shadow' },
  ])('keeps a retryable photo-only intent inert after $label', async ({ mode }) => {
    const photoIntent = {
      ...baseIntent,
      attemptCount: 2,
      leasedFromStatus: 'RETRYABLE',
      photoDuplicateDeleteOnly: true,
    };
    const retryableIntent = {
      ...photoIntent,
      status: 'RETRYABLE',
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
      lastErrorCode: 'delete_pre_dispatch_guard_rejected',
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([photoIntent])
      .mockResolvedValueOnce([retryableIntent]);
    const remoteDelete = jest.fn();
    const resolveEffectivePolicy = jest.fn().mockResolvedValue({
      mode,
      enforce: false,
      advancedCanary: false,
      allowedMatchKinds: ['canonical_sha256'],
      maxAction: 'DELETE_MESSAGE',
      controlRevision: mode === 'off' ? 9 : null,
      controlExpiresAt: null,
    });
    const { service, prisma } = createService(
      {},
      {
        $queryRaw: queryRaw,
        $executeRaw: jest.fn().mockResolvedValue(1),
        moderationDeleteIntentReason: {
          findMany: jest.fn().mockResolvedValue([
            {
              ruleCode: 'DUPLICATE_DELETE',
              metadata: {
                duplicateSource: 'photo',
                matchKind: 'canonical_sha256',
                preset: 'SAME_IMAGE',
                scope: 'SAME_AUTHOR',
              },
            },
          ]),
        },
        chatSettings: {
          findUnique: jest.fn().mockResolvedValue({
            antiDuplicateEnabled: true,
            duplicatePhotoEnabled: true,
            duplicatePhotoMatchPreset: 'SAME_IMAGE',
            duplicatePhotoScope: 'SAME_AUTHOR',
          }),
        },
      },
      { deleteMessage: remoteDelete },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
      undefined,
      { resolveEffectivePolicy },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).rejects.toMatchObject({
      code: 'photo_duplicate_runtime_downgraded',
    });

    expect(remoteDelete).not.toHaveBeenCalled();
    expect(resolveEffectivePolicy).toHaveBeenCalledWith({
      chatId: 'chat-1',
      preset: 'SAME_IMAGE',
      scope: 'SAME_AUTHOR',
    });
    expect(prisma.chatSettings.findUnique).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: 'the anti-duplicate toggle is disabled',
      settings: {
        antiDuplicateEnabled: false,
        duplicatePhotoEnabled: true,
        duplicatePhotoMatchPreset: 'SAME_IMAGE',
        duplicatePhotoScope: 'SAME_AUTHOR',
      },
      allowedMatchKinds: ['canonical_sha256'],
      expectedCode: 'photo_duplicate_settings_disabled',
      policyExpected: false,
    },
    {
      label: 'the photo toggle is disabled',
      settings: {
        antiDuplicateEnabled: true,
        duplicatePhotoEnabled: false,
        duplicatePhotoMatchPreset: 'SAME_IMAGE',
        duplicatePhotoScope: 'SAME_AUTHOR',
      },
      allowedMatchKinds: ['canonical_sha256'],
      expectedCode: 'photo_duplicate_settings_disabled',
      policyExpected: false,
    },
    {
      label: 'the matching preset changed',
      settings: {
        antiDuplicateEnabled: true,
        duplicatePhotoEnabled: true,
        duplicatePhotoMatchPreset: 'MINOR_EDITS',
        duplicatePhotoScope: 'SAME_AUTHOR',
      },
      allowedMatchKinds: ['canonical_sha256'],
      expectedCode: 'photo_duplicate_settings_changed',
      policyExpected: false,
    },
    {
      label: 'the matching scope changed',
      settings: {
        antiDuplicateEnabled: true,
        duplicatePhotoEnabled: true,
        duplicatePhotoMatchPreset: 'SAME_IMAGE',
        duplicatePhotoScope: 'CHAT',
      },
      allowedMatchKinds: ['canonical_sha256'],
      expectedCode: 'photo_duplicate_settings_changed',
      policyExpected: false,
    },
    {
      label: 'the recorded match kind is no longer allowed',
      settings: {
        antiDuplicateEnabled: true,
        duplicatePhotoEnabled: true,
        duplicatePhotoMatchPreset: 'SAME_IMAGE',
        duplicatePhotoScope: 'SAME_AUTHOR',
      },
      allowedMatchKinds: ['pdq'],
      expectedCode: 'photo_duplicate_match_kind_disabled',
      policyExpected: true,
    },
  ])(
    'rechecks retry authorization when $label',
    async ({ settings, allowedMatchKinds, expectedCode, policyExpected }) => {
      const photoIntent = {
        ...baseIntent,
        attemptCount: 2,
        leasedFromStatus: 'RETRYABLE',
        photoDuplicateDeleteOnly: true,
      };
      const retryableIntent = {
        ...photoIntent,
        status: 'RETRYABLE',
        leaseToken: null,
        leaseExpiresAt: null,
        leasedFromStatus: null,
        lastErrorCode: 'delete_pre_dispatch_guard_rejected',
      };
      const queryRaw = jest
        .fn()
        .mockResolvedValueOnce([photoIntent])
        .mockResolvedValueOnce([retryableIntent]);
      const remoteDelete = jest.fn();
      const resolveEffectivePolicy = jest.fn().mockResolvedValue({
        mode: 'delete_only',
        enforce: true,
        advancedCanary: false,
        allowedMatchKinds,
        maxAction: 'DELETE_MESSAGE',
        controlRevision: 12,
        controlExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      const { service } = createService(
        {},
        {
          $queryRaw: queryRaw,
          $executeRaw: jest.fn().mockResolvedValue(1),
          moderationDeleteIntentReason: {
            findMany: jest.fn().mockResolvedValue([
              {
                ruleCode: 'DUPLICATE_DELETE',
                metadata: {
                  duplicateSource: 'photo',
                  matchKind: 'canonical_sha256',
                  preset: 'SAME_IMAGE',
                  scope: 'SAME_AUTHOR',
                },
              },
            ]),
          },
          chatSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
        },
        { deleteMessage: remoteDelete },
        { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
        undefined,
        { resolveEffectivePolicy },
      );

      await expect(service.executeLeasedIntent('intent-1', 'lease-1')).rejects.toMatchObject({
        code: expectedCode,
      });

      expect(remoteDelete).not.toHaveBeenCalled();
      expect(resolveEffectivePolicy).toHaveBeenCalledTimes(policyExpected ? 1 : 0);
    },
  );

  it('terminalizes a retired photo-only retry even when current settings and rollout allow it', async () => {
    const photoIntent = {
      ...baseIntent,
      attemptCount: 2,
      leasedFromStatus: 'RETRYABLE',
      photoDuplicateDeleteOnly: true,
    };
    const terminalIntent = {
      ...photoIntent,
      status: 'FAILED_TERMINAL',
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
      deleteDispatchStartedAt: null,
      deleteDispatchStartedBotId: null,
      lastErrorCode: 'photo_duplicate_legacy_evidence_retired',
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([photoIntent])
      .mockResolvedValueOnce([terminalIntent]);
    const terminalWrite = jest.fn().mockResolvedValue(1);
    const remoteDelete = jest.fn();
    const resolveEffectivePolicy = jest
      .fn()
      .mockResolvedValueOnce({
        mode: 'delete_only',
        enforce: true,
        advancedCanary: false,
        allowedMatchKinds: ['canonical_sha256'],
        maxAction: 'DELETE_MESSAGE',
        controlRevision: 10,
        controlExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      .mockResolvedValueOnce({
        mode: 'off',
        enforce: false,
        advancedCanary: false,
        allowedMatchKinds: ['canonical_sha256'],
        maxAction: 'DELETE_MESSAGE',
        controlRevision: 11,
        controlExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
    const { service } = createService(
      {},
      {
        $queryRaw: queryRaw,
        $executeRaw: jest.fn().mockResolvedValue(1),
        $transaction: jest.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
          callback({
            $queryRaw: jest
              .fn()
              .mockResolvedValueOnce([{ id: photoIntent.id }])
              .mockResolvedValueOnce([photoIntent]),
            $executeRaw: terminalWrite,
          }),
        ),
        moderationDeleteIntentReason: {
          findMany: jest.fn().mockResolvedValue([
            {
              ruleCode: 'DUPLICATE_DELETE',
              metadata: {
                duplicateSource: 'photo',
                matchKind: 'canonical_sha256',
                preset: 'SAME_IMAGE',
                scope: 'SAME_AUTHOR',
              },
            },
          ]),
        },
        chatSettings: {
          findUnique: jest.fn().mockResolvedValue({
            antiDuplicateEnabled: true,
            duplicatePhotoEnabled: true,
            duplicatePhotoMatchPreset: 'SAME_IMAGE',
            duplicatePhotoScope: 'SAME_AUTHOR',
          }),
        },
      },
      { deleteMessage: remoteDelete },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
      undefined,
      { resolveEffectivePolicy },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'terminal',
      confirmed: false,
      status: 'FAILED_TERMINAL',
    });

    expect(resolveEffectivePolicy).toHaveBeenCalledTimes(1);
    expect(remoteDelete).not.toHaveBeenCalled();
    expect(
      terminalWrite.mock.calls.some((call: unknown[]) =>
        (call[0] as { values?: unknown[] }).values?.includes(
          'photo_duplicate_legacy_evidence_retired',
        ),
      ),
    ).toBe(true);
  });

  it('does not let photo controls suppress an independent reason on the same intent', async () => {
    const mixedIntent = { ...baseIntent, photoDuplicateDeleteOnly: true };
    const completedIntent = {
      ...mixedIntent,
      status: 'SUCCEEDED',
      succeededBotId: 'bot-1',
      remoteDeleteSucceededAt: new Date(),
      remoteDeleteSucceededBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([mixedIntent])
      .mockResolvedValueOnce([completedIntent]);
    const remoteDelete = jest.fn().mockResolvedValue(undefined);
    const resolveEffectivePolicy = jest.fn().mockRejectedValue(new Error('control is off'));
    const findMany = jest.fn().mockResolvedValue([
      {
        ruleCode: 'DUPLICATE_DELETE',
        metadata: {
          duplicateSource: 'photo',
          matchKind: 'canonical_sha256',
          preset: 'SAME_IMAGE',
          scope: 'SAME_AUTHOR',
        },
      },
      { ruleCode: 'BLOCKED_WORD_DELETE', metadata: { source: 'text' } },
    ]);
    const { service } = createService(
      {},
      {
        $queryRaw: queryRaw,
        $executeRaw: jest.fn().mockResolvedValue(1),
        moderationDeleteIntentReason: { findMany },
      },
      { deleteMessage: remoteDelete },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
      undefined,
      { resolveEffectivePolicy },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'confirmed',
      confirmed: true,
    });

    expect(findMany).toHaveBeenCalledTimes(4);
    expect(resolveEffectivePolicy).not.toHaveBeenCalled();
    expect(remoteDelete).toHaveBeenCalledTimes(1);
  });

  it('keeps non-OCR guard classifiers active when OCR is the only additional reason', () => {
    const { service } = createService();
    const query = (
      service as unknown as {
        intentSelectSql(alias: string): {
          strings?: readonly string[];
          values?: readonly unknown[];
        };
      }
    ).intentSelectSql('intent');
    const sql = query.strings?.join('?') ?? '';

    expect(sql).toContain('AS "botMessageAutoDeleteReason"');
    expect(sql).toContain('other_reason."rule_code" NOT IN');
    expect(sql).toContain(`photo_reason."rule_code" = 'DUPLICATE_DELETE'`);
    expect(sql).toContain(`photo_reason."metadata"->>'duplicateSource'`);
    expect(sql).toContain('independent_reason."rule_code" <>');
    expect(sql).toContain('AS "photoDuplicateDeleteOnly"');
    expect(sql).toContain('non_link_reason."rule_code" NOT IN');
    expect(sql).toContain('AS "linkFamilyDeleteOnly"');
    expect(query.values).toEqual(
      expect.arrayContaining(['BOT_MESSAGE_AUTO_DELETE', COMMERCIAL_OCR_DELETE_RULE_CODE]),
    );
  });

  it('classifies channel auto-post cleanup as guarded only without an independent reason', () => {
    const { service } = createService();
    const query = (
      service as unknown as {
        intentSelectSql(alias: string): {
          strings?: readonly string[];
          values?: readonly unknown[];
        };
      }
    ).intentSelectSql('intent');
    const sql = query.strings?.join('?') ?? '';
    const classifierStart = sql.indexOf(
      'FROM "moderation_delete_intent_reasons" channel_cleanup_reason',
    );
    const classifierEnd = sql.indexOf('AS "channelAutoPostCleanupOnly"');
    const classifierSql = sql.slice(classifierStart, classifierEnd);

    expect(classifierStart).toBeGreaterThanOrEqual(0);
    expect(classifierEnd).toBeGreaterThan(classifierStart);
    expect(classifierSql).toContain('channel_cleanup_reason."rule_code" =');
    expect(classifierSql).toContain('AND NOT EXISTS');
    expect(classifierSql).toContain('FROM "moderation_delete_intent_reasons" independent_reason');
    expect(classifierSql).toContain('independent_reason."rule_code" <>');
    expect(query.values?.slice(0, 8)).toEqual([
      'CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP',
      'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP',
      'CHAT_RULES_REPUBLISH_PREVIOUS_MESSAGE_CLEANUP',
      'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP',
      'CHAT_RULES_REPUBLISH_PREVIOUS_MESSAGE_CLEANUP',
      'CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP',
      'CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP',
      'CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP',
    ]);
  });

  it('loads the durable commercial OCR ownership fence directly from the intent', () => {
    const { service } = createService();
    const query = (
      service as unknown as {
        intentSelectSql(alias: string): {
          strings?: readonly string[];
          values?: readonly unknown[];
        };
      }
    ).intentSelectSql('intent');
    const sql = query.strings?.join('?') ?? '';

    expect(sql).toContain(
      '"intent"."commercial_ocr_guard_required" AS "commercialOcrGuardRequired"',
    );
    expect(sql).not.toContain('AS "commercialOcrDeleteOnly"');
  });

  it('fails closed when a link-only intent loses its required reason before dispatch', async () => {
    const retryable = {
      ...baseIntent,
      status: 'RETRYABLE',
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
      linkFamilyDeleteOnly: true,
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ ...baseIntent, linkFamilyDeleteOnly: true }])
      .mockResolvedValueOnce([retryable]);
    const deleteMessage = jest.fn();
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      { deleteMessage },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
      { assertIntentStillActionable: jest.fn().mockResolvedValue('not_applicable') },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).rejects.toThrow(
      'Guarded link delete intent lost its required reason metadata',
    );

    expect(deleteMessage).not.toHaveBeenCalled();
  });

  it('classifies live and history link rules by rule code rather than reason metadata', () => {
    const { service } = createService();
    const query = (
      service as unknown as {
        intentSelectSql(alias: string): { strings?: readonly string[] };
      }
    ).intentSelectSql('intent');
    const sql = query.strings?.join('?') ?? '';

    expect(sql).toContain('link_reason."rule_code" IN (');
    expect(sql).toContain('non_link_reason."rule_code" NOT IN (');
    expect(sql).not.toContain('link_reason."reason_key"');
  });

  it('rechecks its database lease inside MaxClient before persisting the dispatch fence', async () => {
    let leaseRenewals = 0;
    const executeRaw = jest.fn().mockImplementation(async (query: { strings?: string[] }) => {
      const sql = query.strings?.join('?') ?? '';
      if (sql.includes('SET "lease_expires_at" =')) {
        leaseRenewals += 1;
        return leaseRenewals < 3 ? 1 : 0;
      }
      return 1;
    });
    const events: string[] = [];
    const deleteMessage = jest.fn(async () => {
      events.push('max-http');
    });
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ ...baseIntent }])
      .mockResolvedValueOnce([{ ...baseIntent }]);
    const { service, prisma } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: executeRaw },
      { deleteMessage },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      confirmed: false,
    });

    expect(leaseRenewals).toBe(3);
    expect(events).toEqual([]);
    const executedSql = prisma.$executeRaw.mock.calls
      .map((call: unknown[]) => {
        const query = call[0] as { strings?: readonly string[] };
        return query.strings?.join('?') ?? '';
      })
      .join('\n');
    expect(executedSql).not.toContain('"delete_dispatch_started_at" = CURRENT_TIMESTAMP');
  });

  it.each([
    { kind: 'typed quota', retentionOwned: false, defer: true },
    { kind: 'lookalike code', retentionOwned: false, defer: false },
    { kind: 'retention typed quota', retentionOwned: true, defer: false },
  ])(
    'defers only an ordinary durable DELETE after $kind',
    async ({ kind, retentionOwned, defer }) => {
      const typedQuota = new MaxApiInternalRateLimitError('internal quota rejected', 12_000);
      const guardError =
        kind === 'lookalike code'
          ? Object.assign(new Error('internal quota rejected'), {
              code: typedQuota.code,
              preDispatch: true,
              retryAfterMs: 12_000,
            })
          : typedQuota;
      const leased = { ...baseIntent, retentionOwned };
      const retryable = {
        ...leased,
        status: 'RETRYABLE',
        leaseToken: null,
        leaseExpiresAt: null,
        leasedFromStatus: null,
        deleteDispatchStartedAt: null,
        deleteDispatchStartedBotId: null,
      };
      const queryRaw = jest.fn().mockResolvedValueOnce([leased]).mockResolvedValueOnce([retryable]);
      const remoteDelete = jest.fn();
      const { service, prisma } = createService(
        { MESSAGE_RETENTION_MODE: 'on' },
        { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
        { deleteMessage: remoteDelete },
        { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
      );
      if (retentionOwned)
        Object.assign(service, {
          messageRetentionGuard: { assertAllowed: jest.fn().mockRejectedValue(guardError) },
        });
      const beforeDeleteMutation = jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(guardError);
      const startedAt = Date.now();
      const execution = service.executeLeasedIntent('intent-1', 'lease-1', {
        beforeDeleteMutation,
      });
      if (defer)
        await expect(execution).resolves.toMatchObject({ confirmed: false, status: 'RETRYABLE' });
      else await expect(execution).rejects.toBe(guardError);
      expect(remoteDelete).not.toHaveBeenCalled();
      const update = prisma.$executeRaw.mock.calls
        .map(
          (call: unknown[]) =>
            call[0] as { strings?: readonly string[]; values?: readonly unknown[] },
        )
        .find((query) =>
          (query.strings?.join('?') ?? '').includes(
            '"status" = CAST(? AS "ModerationDeleteIntentStatus")',
          ),
        );
      expect(update?.values).toContain('RETRYABLE');
      if (defer)
        expect(
          update?.values?.some(
            (value) => value instanceof Date && value.getTime() >= startedAt + 12_000,
          ),
        ).toBe(true);
    },
  );

  it('clears the dispatch fence and stays retryable when the final delete guard rejects', async () => {
    const orderingLeaseLost = new Error('photo ordering lease lost');
    const retryable = {
      ...baseIntent,
      status: 'RETRYABLE',
      nextAttemptAt: new Date(Date.now() + 1_000),
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
      deleteDispatchStartedAt: null,
      deleteDispatchStartedBotId: null,
      lastErrorCode: 'delete_pre_dispatch_guard_rejected',
      lastError: orderingLeaseLost.message,
    };
    const events: string[] = [];
    const executeRaw = jest.fn().mockImplementation(async (query: { strings?: string[] }) => {
      const sql = query.strings?.join('?') ?? '';
      if (sql.includes('"delete_dispatch_started_at" = CURRENT_TIMESTAMP')) {
        events.push('dispatch-fence');
      } else if (
        sql.includes('"delete_dispatch_started_at" = NULL') &&
        sql.includes('AND "delete_dispatch_started_at" IS NOT NULL')
      ) {
        events.push('clear-fence');
      } else if (sql.includes('"status" = CAST(? AS "ModerationDeleteIntentStatus")')) {
        events.push('retryable-status');
      }
      return 1;
    });
    const beforeDeleteMutation = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(orderingLeaseLost);
    const deleteMessage = jest.fn(async () => {
      events.push('max-http');
    });
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ ...baseIntent }])
      .mockResolvedValueOnce([retryable]);
    const { service, prisma } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: executeRaw },
      { deleteMessage },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(
      service.executeLeasedIntent('intent-1', 'lease-1', { beforeDeleteMutation }),
    ).rejects.toBe(orderingLeaseLost);

    expect(beforeDeleteMutation).toHaveBeenCalledTimes(2);
    expect(events).toEqual(['dispatch-fence', 'clear-fence', 'retryable-status']);
    const statusUpdate = prisma.$executeRaw.mock.calls
      .map(
        (call: unknown[]) =>
          call[0] as { strings?: readonly string[]; values?: readonly unknown[] },
      )
      .find((query) =>
        (query.strings?.join('?') ?? '').includes(
          '"status" = CAST(? AS "ModerationDeleteIntentStatus")',
        ),
      );
    expect(statusUpdate?.values).toContain('RETRYABLE');
    expect(statusUpdate?.values).not.toContain('AMBIGUOUS');
  });

  it('clears a definitively rejected dispatch before trying another bot', async () => {
    const completed = {
      ...baseIntent,
      status: 'SUCCEEDED',
      lastBotId: 'bot-2',
      succeededBotId: 'bot-2',
      remoteDeleteSucceededAt: new Date(),
      remoteDeleteSucceededBotId: 'bot-2',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const events: string[] = [];
    const executeRaw = jest
      .fn()
      .mockImplementation(async (query: { strings?: string[]; values?: unknown[] }) => {
        const sql = query.strings?.join('?') ?? '';
        const botId = query.values?.find((value) => value === 'bot-1' || value === 'bot-2');
        if (sql.includes('"delete_dispatch_started_at" = CURRENT_TIMESTAMP')) {
          events.push(`fence:${botId}`);
        } else if (
          sql.includes('"delete_dispatch_started_at" = NULL') &&
          sql.includes('AND "delete_dispatch_started_at" IS NOT NULL')
        ) {
          events.push(`clear:${botId}`);
        }
        return 1;
      });
    const deleteMessage = jest
      .fn()
      .mockImplementationOnce(async () => {
        events.push('delete:bot-1');
        throw { response: { status: 403, data: { code: 'access.denied' } } };
      })
      .mockImplementationOnce(async () => {
        events.push('delete:bot-2');
      });
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ ...baseIntent }])
      .mockResolvedValueOnce([completed]);
    const { service } = createService(
      { MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS: 'chat-1' },
      { $queryRaw: queryRaw, $executeRaw: executeRaw },
      {
        deleteMessage,
        getExactMessagePresence: jest.fn(),
        getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
          userId: 'bot-user-1',
          isAdmin: true,
          isOwner: false,
          permissions: ['write'],
        }),
      },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'confirmed',
      botId: 'bot-2',
    });
    expect(events).toEqual([
      'fence:bot-1',
      'delete:bot-1',
      'clear:bot-1',
      'fence:bot-2',
      'delete:bot-2',
    ]);
  });

  it.each([
    [
      'a socket reset whose text resembles access denial',
      Object.assign(new Error('network socket closed: access denied'), { code: 'ECONNRESET' }),
    ],
    ['an unknown failure whose text resembles access denial', new Error('permission denied')],
    [
      'an unknown failure whose code resembles message absence',
      { code: 'message.not.found', message: 'Message not found' },
    ],
    [
      'HTTP 408 whose text resembles message absence',
      {
        response: {
          status: 408,
          data: { code: 'message.not.found', message: 'Message not found' },
        },
      },
    ],
    [
      'HTTP 503 whose code resembles access denial',
      {
        response: {
          status: 503,
          data: { code: 'chat.denied', message: 'permission denied' },
        },
      },
    ],
    [
      'HTTP 500 whose code resembles message absence',
      {
        response: {
          status: 500,
          data: { code: 'message.not.found', message: 'Message not found' },
        },
      },
    ],
  ])('retains the dispatch fence and never tries a peer after %s', async (_kind, error) => {
    const markedAt = new Date();
    const ambiguous = {
      ...baseIntent,
      status: 'AMBIGUOUS',
      lastBotId: 'bot-1',
      deleteDispatchStartedAt: markedAt,
      deleteDispatchStartedBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const events: string[] = [];
    const executeRaw = jest
      .fn()
      .mockImplementation(async (query: { strings?: string[]; values?: unknown[] }) => {
        const sql = query.strings?.join('?') ?? '';
        const botId = query.values?.find((value) => value === 'bot-1' || value === 'bot-2');
        if (sql.includes('"delete_dispatch_started_at" = CURRENT_TIMESTAMP')) {
          events.push(`fence:${botId}`);
        } else if (
          sql.includes('"delete_dispatch_started_at" = NULL') &&
          sql.includes('AND "delete_dispatch_started_at" IS NOT NULL')
        ) {
          events.push(`clear:${botId}`);
        }
        return 1;
      });
    const deleteMessage = jest.fn(async () => {
      events.push('delete:bot-1');
      throw error;
    });
    const getExactMessagePresence = jest.fn();
    const getCurrentChatMemberAccess = jest.fn();
    const resolveDeleteMessageBotRoute = jest.fn().mockResolvedValue(confirmedRoute);
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ ...baseIntent }])
      .mockResolvedValueOnce([ambiguous]);
    const { service, prisma } = createService(
      { MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS: 'chat-1' },
      { $queryRaw: queryRaw, $executeRaw: executeRaw },
      { deleteMessage, getExactMessagePresence, getCurrentChatMemberAccess },
      { resolveDeleteMessageBotRoute },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'ambiguous',
      confirmed: false,
      status: 'AMBIGUOUS',
    });
    expect(events).toEqual(['fence:bot-1', 'delete:bot-1']);
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    expect(getExactMessagePresence).not.toHaveBeenCalled();
    expect(getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(resolveDeleteMessageBotRoute).toHaveBeenCalledTimes(1);
    const statusUpdate = prisma.$executeRaw.mock.calls
      .map(
        (call: unknown[]) =>
          call[0] as { strings?: readonly string[]; values?: readonly unknown[] },
      )
      .find((query) =>
        (query.strings?.join('?') ?? '').includes(
          '"status" = CAST(? AS "ModerationDeleteIntentStatus")',
        ),
      );
    expect(statusUpdate?.values).toContain('AMBIGUOUS');
    expect(statusUpdate?.strings?.join('?')).not.toContain('"delete_dispatch_started_at" = NULL');
  });

  it('does not run an exact presence preflight when the previous attempt never dispatched DELETE', async () => {
    const retriedIntent = {
      ...baseIntent,
      attemptCount: 2,
      leasedFromStatus: 'RETRYABLE',
      lastErrorCode: 'route_lookup_failed',
    };
    const succeeded = {
      ...retriedIntent,
      status: 'SUCCEEDED',
      lastBotId: 'bot-1',
      succeededBotId: 'bot-1',
      remoteDeleteSucceededAt: new Date(),
      remoteDeleteSucceededBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([retriedIntent])
      .mockResolvedValueOnce([succeeded]);
    const deleteMessage = jest.fn().mockResolvedValue(undefined);
    const getExactMessagePresence = jest.fn();
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      { deleteMessage, getExactMessagePresence },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'confirmed', confirmed: true, botId: 'bot-1' });
    expect(getExactMessagePresence).not.toHaveBeenCalled();
    expect(deleteMessage).toHaveBeenCalledTimes(1);
  });

  it('recovers a missing origin membership from a live probe before origin-only deletion', async () => {
    const emptyRoute = {
      ...confirmedRoute,
      primaryBotId: null,
      botId: null,
      candidateBotIds: [],
      candidateCapabilities: [],
      capabilityState: 'stale_or_unknown',
      capabilityReason: 'no_active_membership',
    };
    const originRoute = {
      ...confirmedRoute,
      candidateBotIds: ['bot-1'],
      candidateCapabilities: [confirmedRoute.candidateCapabilities[0]],
    };
    const succeeded = {
      ...baseIntent,
      status: 'SUCCEEDED',
      lastBotId: 'bot-1',
      succeededBotId: 'bot-1',
      remoteDeleteSucceededAt: new Date(),
      remoteDeleteSucceededBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ ...baseIntent }])
      .mockResolvedValueOnce([succeeded]);
    const resolveDeleteMessageBotRoute = jest
      .fn()
      .mockResolvedValueOnce(emptyRoute)
      .mockResolvedValue(originRoute);
    const recordBotAccessProbe = jest.fn().mockResolvedValue(true);
    const getCurrentChatMemberAccess = jest.fn().mockResolvedValue({
      userId: 'bot-user-1',
      isAdmin: true,
      isOwner: false,
      permissions: ['read_all_messages', 'write'],
    });
    const deleteMessage = jest.fn().mockResolvedValue(undefined);
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      { deleteMessage, getCurrentChatMemberAccess },
      { resolveDeleteMessageBotRoute, recordBotAccessProbe },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'confirmed', confirmed: true, botId: 'bot-1' });
    expect(getCurrentChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ botId: 'bot-1', bypassCache: true }),
    );
    expect(recordBotAccessProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        botId: 'bot-1',
        allowMembershipRecovery: true,
      }),
    );
    expect(deleteMessage).toHaveBeenCalledWith(
      'chat-1',
      'message-1',
      expect.objectContaining({ botId: 'bot-1' }),
    );
  });

  it('keeps a remote success marker retryable past the horizon and never deletes twice', async () => {
    const expiredHorizonIntent = {
      ...baseIntent,
      retryUntilAt: new Date(Date.now() - 1_000),
    };
    const markedAt = new Date();
    const ambiguousWithMarker = {
      ...expiredHorizonIntent,
      status: 'AMBIGUOUS',
      nextAttemptAt: new Date(Date.now() + 60_000),
      remoteDeleteSucceededAt: markedAt,
      remoteDeleteSucceededBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: 'remote_success_finalize_failed',
    };
    const leasedMarker = {
      ...ambiguousWithMarker,
      status: 'IN_PROGRESS',
      attemptCount: 2,
      leaseToken: 'lease-2',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    };
    const succeeded = {
      ...leasedMarker,
      status: 'SUCCEEDED',
      succeededBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: null,
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([expiredHorizonIntent])
      .mockResolvedValueOnce([ambiguousWithMarker])
      .mockResolvedValueOnce([leasedMarker])
      .mockResolvedValueOnce([succeeded]);
    const transaction = jest
      .fn()
      .mockRejectedValueOnce(new Error('finalization transaction failed'))
      .mockImplementationOnce(
        async (callback: (tx: { $executeRaw: jest.Mock }) => Promise<unknown>) =>
          callback({ $executeRaw: jest.fn().mockResolvedValue(1) }),
      );
    const deleteMessage = jest.fn().mockResolvedValue(undefined);
    const { service } = createService(
      {},
      {
        $queryRaw: queryRaw,
        $executeRaw: jest.fn().mockResolvedValue(1),
        $transaction: transaction,
      },
      { deleteMessage },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    const first = await service.executeLeasedIntent('intent-1', 'lease-1');
    const second = await service.executeLeasedIntent('intent-1', 'lease-2');

    expect(first).toMatchObject({ kind: 'ambiguous', status: 'AMBIGUOUS' });
    expect(second).toMatchObject({ kind: 'confirmed', status: 'SUCCEEDED', botId: 'bot-1' });
    expect(second).not.toHaveProperty('profanityVerified');
    expect(deleteMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps a timed-out delete dispatch reclaimable past the retry horizon', async () => {
    const horizonIntent = {
      ...baseIntent,
      retryUntilAt: new Date(Date.now() + 100),
    };
    const ambiguous = {
      ...horizonIntent,
      status: 'AMBIGUOUS',
      deleteDispatchStartedAt: new Date(),
      deleteDispatchStartedBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([horizonIntent])
      .mockResolvedValueOnce([ambiguous]);
    const deleteMessage = jest
      .fn()
      .mockRejectedValue(Object.assign(new Error('delete timeout'), { code: 'ETIMEDOUT' }));
    const { service } = createService(
      { MODERATION_DELETE_INTENT_RETRY_BASE_MS: 1_000 },
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) },
      { deleteMessage },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'ambiguous',
      status: 'AMBIGUOUS',
    });
  });

  it('clears the dispatch fence and terminates an explicitly rejected DELETE', async () => {
    const terminal = {
      ...baseIntent,
      status: 'FAILED_TERMINAL',
      deleteDispatchStartedAt: null,
      deleteDispatchStartedBotId: null,
      leaseToken: null,
      leaseExpiresAt: null,
      lastStatusCode: 422,
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ ...baseIntent }])
      .mockResolvedValueOnce([terminal]);
    const executeRaw = jest.fn().mockResolvedValue(1);
    const deleteMessage = jest.fn().mockRejectedValue({
      response: { status: 422, data: { code: 'invalid.request' } },
    });
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: executeRaw },
      { deleteMessage },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    await expect(service.executeLeasedIntent('intent-1', 'lease-1')).resolves.toMatchObject({
      kind: 'terminal',
      status: 'FAILED_TERMINAL',
    });
    const sqlCalls = executeRaw.mock.calls.map((call) => call[0]?.strings?.join('?') ?? '');
    const clearIndex = sqlCalls.findIndex(
      (sql) =>
        sql.includes('"delete_dispatch_started_at" = NULL') &&
        sql.includes('AND "delete_dispatch_started_at" IS NOT NULL'),
    );
    const terminalIndex = sqlCalls.findIndex((sql) => sql.includes('CAST(? AS'));
    expect(clearIndex).toBeGreaterThanOrEqual(0);
    expect(terminalIndex).toBeGreaterThan(clearIndex);
  });

  it('atomically records remote success as ambiguous when the first marker write fails', async () => {
    const markedAt = new Date();
    const fallbackState = {
      ...baseIntent,
      status: 'AMBIGUOUS',
      remoteDeleteSucceededAt: markedAt,
      remoteDeleteSucceededBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: 'remote_success_marker_persist_failed',
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ ...baseIntent }])
      .mockResolvedValueOnce([fallbackState]);
    const executeRaw = jest.fn().mockImplementation(async (query: { strings?: string[] }) => {
      const sql = query.strings?.join('?') ?? '';
      if (
        sql.includes('"remote_delete_succeeded_at" = COALESCE') &&
        !sql.includes("CAST('AMBIGUOUS' AS")
      ) {
        throw new Error('marker write failed');
      }
      return 1;
    });
    const deleteMessage = jest.fn().mockResolvedValue(undefined);
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: executeRaw },
      { deleteMessage },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'ambiguous', status: 'AMBIGUOUS' });
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    const fallbackSql = executeRaw.mock.calls
      .map((call) => call[0]?.strings?.join('?') ?? '')
      .find(
        (sql) => sql.includes("CAST('AMBIGUOUS' AS") && sql.includes('remote_delete_succeeded_at'),
      );
    expect(fallbackSql).toBeDefined();
  });

  it('renews a short lease during a slow capability probe and dispatches once', async () => {
    const deniedRoute = {
      ...confirmedRoute,
      botId: null,
      candidateBotIds: [],
      capabilityState: 'stale_or_unknown',
      capabilityReason: 'snapshot_missing',
      candidateCapabilities: [
        {
          ...confirmedRoute.candidateCapabilities[0],
          state: 'stale_or_unknown',
          reason: 'snapshot_missing',
          routeEligible: false,
        },
      ],
    } as const;
    const restoredRoute = {
      ...confirmedRoute,
      candidateBotIds: ['bot-1'],
      candidateCapabilities: [confirmedRoute.candidateCapabilities[0]],
    } as const;
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ ...baseIntent }])
      .mockResolvedValueOnce([
        {
          ...baseIntent,
          status: 'SUCCEEDED',
          succeededBotId: 'bot-1',
          leaseToken: null,
          leaseExpiresAt: null,
        },
      ]);
    const executeRaw = jest.fn().mockResolvedValue(1);
    const deleteMessage = jest.fn().mockResolvedValue(undefined);
    const getCurrentChatMemberAccess = jest.fn().mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                userId: 'bot-user-1',
                isAdmin: true,
                isOwner: false,
                permissions: ['read_all_messages', 'write'],
              }),
            85,
          ),
        ),
    );
    const { service } = createService(
      { MODERATION_DELETE_INTENT_LEASE_MS: 90 },
      { $queryRaw: queryRaw, $executeRaw: executeRaw },
      { deleteMessage, getCurrentChatMemberAccess },
      {
        resolveDeleteMessageBotRoute: jest
          .fn()
          .mockResolvedValueOnce(deniedRoute)
          .mockResolvedValueOnce(restoredRoute),
      },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'confirmed', status: 'SUCCEEDED' });
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    const renewals = executeRaw.mock.calls.filter((call) =>
      (call[0]?.strings?.join('?') ?? '').includes('SET "lease_expires_at" ='),
    );
    expect(renewals.length).toBeGreaterThanOrEqual(3);
  });

  it('releases the lease when candidate failure persistence throws unexpectedly', async () => {
    const ambiguous = {
      ...baseIntent,
      status: 'AMBIGUOUS',
      leaseToken: null,
      leaseExpiresAt: null,
      lastErrorCode: 'delete_intent_execution_failed',
    };
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ ...baseIntent }])
      .mockResolvedValueOnce([ambiguous]);
    const executeRaw = jest.fn().mockImplementation(async (query: { strings?: string[] }) => {
      const sql = query.strings?.join('?') ?? '';
      if (sql.includes('"candidate_failures" =')) {
        throw new Error('candidate failure write failed');
      }
      return 1;
    });
    const deleteMessage = jest.fn().mockRejectedValue({
      response: { status: 403, data: { code: 'access.denied' } },
    });
    const { service } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: executeRaw },
      {
        deleteMessage,
        getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
          userId: 'bot-user-1',
          isAdmin: true,
          isOwner: false,
          permissions: ['read_all_messages', 'write'],
        }),
      },
      { resolveDeleteMessageBotRoute: jest.fn().mockResolvedValue(confirmedRoute) },
    );

    const result = await service.executeLeasedIntent('intent-1', 'lease-1');

    expect(result).toMatchObject({ kind: 'ambiguous', status: 'AMBIGUOUS' });
    expect(deleteMessage).toHaveBeenCalledTimes(1);
    const recoveryQuery = executeRaw.mock.calls.at(-1)?.[0];
    const recoverySql = recoveryQuery?.strings?.join('?') ?? '';
    expect(recoverySql).toContain('"lease_token" = NULL');
    expect(recoveryQuery?.values).toContain('delete_intent_execution_failed');
  });

  it('uses one stable BullMQ job id per intent', async () => {
    const { service, queue } = createService();

    await (service as unknown as ServiceInternals).enqueueWakeup({
      ...baseIntent,
      status: 'PENDING',
    });
    await (service as unknown as ServiceInternals).enqueueWakeup({
      ...baseIntent,
      status: 'PENDING',
    });

    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add.mock.calls[0]?.[2]?.jobId).toBe('mdi-intent-1');
    expect(queue.add.mock.calls[1]?.[2]?.jobId).toBe('mdi-intent-1');
  });

  it('strictly enqueues the current due persisted intent for operator repair', async () => {
    const pendingIntent = {
      ...baseIntent,
      status: 'PENDING',
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const { service, queue } = createService(
      {},
      { $queryRaw: jest.fn().mockResolvedValueOnce([pendingIntent]) },
    );

    await expect(service.enqueueCurrentIntentWakeupStrict('intent-1')).resolves.toBeUndefined();

    expect(queue.add).toHaveBeenCalledWith(
      'execute-moderation-delete-intent',
      { intentId: 'intent-1' },
      expect.objectContaining({
        jobId: 'mdi-intent-1',
        priority: 1,
        attempts: 1,
      }),
    );
  });

  it('propagates a strict operator-repair queue handoff failure', async () => {
    const pendingIntent = {
      ...baseIntent,
      status: 'PENDING',
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const queueError = new Error('redis unavailable');
    const { service, queue } = createService(
      {},
      { $queryRaw: jest.fn().mockResolvedValueOnce([pendingIntent]) },
    );
    queue.add.mockRejectedValueOnce(queueError);

    await expect(service.enqueueCurrentIntentWakeupStrict('intent-1')).rejects.toBe(queueError);
  });

  it.each(['SUCCEEDED', 'IN_PROGRESS'] as const)(
    'treats a strict operator-repair handoff race to %s as a harmless no-op',
    async (status) => {
      const currentIntent = {
        ...baseIntent,
        status,
        ...(status === 'SUCCEEDED'
          ? { leaseToken: null, leaseExpiresAt: null, leasedFromStatus: null }
          : {}),
      };
      const { service, queue } = createService(
        {},
        { $queryRaw: jest.fn().mockResolvedValueOnce([currentIntent]) },
      );

      await expect(service.enqueueCurrentIntentWakeupStrict('intent-1')).resolves.toBeUndefined();
      expect(queue.add).not.toHaveBeenCalled();
    },
  );

  it('applies normal due, retry-window, and execution checks to strict handoff', async () => {
    const now = Date.now();
    const futureIntent = {
      ...baseIntent,
      status: 'PENDING',
      nextAttemptAt: new Date(now + 60_000),
      retryUntilAt: new Date(now + 120_000),
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const exhaustedIntent = {
      ...futureIntent,
      executeAt: new Date(now - 2_000),
      nextAttemptAt: new Date(now - 1_000),
      retryUntilAt: new Date(now - 2_000),
    };
    const shadowIntent = {
      ...futureIntent,
      nextAttemptAt: new Date(now - 1_000),
      retryUntilAt: new Date(now + 60_000),
    };
    const dueQueryRaw = jest
      .fn()
      .mockResolvedValueOnce([futureIntent])
      .mockResolvedValueOnce([exhaustedIntent]);
    const { service, queue } = createService({}, { $queryRaw: dueQueryRaw });
    const shadow = createService(
      { MODERATION_DELETE_INTENT_MODE: 'shadow' },
      { $queryRaw: jest.fn().mockResolvedValueOnce([shadowIntent]) },
    );

    await expect(service.enqueueCurrentIntentWakeupStrict('intent-future')).rejects.toThrow(
      'intent-1 is not due for enqueue',
    );
    await expect(service.enqueueCurrentIntentWakeupStrict('intent-exhausted')).rejects.toThrow(
      'intent-1 has no mutation evidence and its retry window is exhausted',
    );
    await expect(shadow.service.enqueueCurrentIntentWakeupStrict('intent-shadow')).rejects.toThrow(
      'intent-1 is not executable in the current rollout',
    );

    expect(queue.add).not.toHaveBeenCalled();
    expect(shadow.queue.add).not.toHaveBeenCalled();
  });

  it('leaves DB state unleased when the DB-to-Redis handoff fails', async () => {
    const queryRaw = jest.fn().mockResolvedValueOnce([{ id: 'intent-1' }]);
    const executeRaw = jest.fn().mockResolvedValue(1);
    const { service, queue } = createService({}, { $queryRaw: queryRaw, $executeRaw: executeRaw });
    queue.add.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(service.sweepDueIntents()).resolves.toBe(1);

    const selectionSql = queryRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    expect(selectionSql).toContain('SELECT ranked."id"');
    expect(selectionSql).not.toContain('UPDATE "moderation_delete_intents" intent');
    expect(selectionSql).toContain('intent."remote_delete_succeeded_at" IS NOT NULL');

    const expirySql = executeRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    expect(expirySql).toContain('intent."remote_delete_succeeded_at" IS NULL');
    expect(expirySql).toContain('intent."remote_delete_succeeded_bot_id" IS NULL');
    expect(expirySql).toContain('intent."delete_dispatch_started_at" IS NULL');
    expect(expirySql).toContain('intent."delete_dispatch_started_bot_id" IS NULL');
  });

  it('distinguishes selected rows from acknowledged and failed due-sweep handoffs', async () => {
    const queryRaw = jest
      .fn()
      .mockResolvedValue([
        { id: 'private-intent-a' },
        { id: 'private-intent-b' },
        { id: 'private-intent-c' },
      ]);
    const executeRaw = jest.fn().mockResolvedValue(2);
    const { service, queue } = createService({}, { $queryRaw: queryRaw, $executeRaw: executeRaw });
    queue.add.mockRejectedValueOnce(new Error('private-redis-failure'));

    await expect(service.sweepDueIntents()).resolves.toBe(3);

    expect(queue.add).toHaveBeenCalledTimes(3);
    expect(service.getDueSweepRuntimeSnapshot()).toMatchObject({
      calls: 1,
      completed: 1,
      errors: 0,
      selectedCount: 3,
      handoffAttemptedCount: 3,
      handoffAcknowledgedCount: 2,
      handoffErrorCount: 1,
      handoffInsertionUnknownCount: 2,
      stages: {
        expire: { calls: 1, succeeded: 1, errors: 0, returnedCount: 2 },
        select: { calls: 1, succeeded: 1, errors: 0, returnedCount: 3 },
        handoff: { calls: 1, succeeded: 1, errors: 0, returnedCount: 2 },
      },
    });
    expect(JSON.stringify(service.getDueSweepRuntimeSnapshot())).not.toContain('private-');
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });

  it('does not infer insertion from the deterministic Job returned by BullMQ', async () => {
    const { service, queue } = createService(
      {},
      { $queryRaw: jest.fn().mockResolvedValue([{ id: 'private-existing-intent' }]) },
    );
    queue.add.mockResolvedValueOnce({
      id: 'mdi-private-existing-intent',
      opts: { priority: 10 },
    } as never);

    await service.sweepDueIntents();

    expect(service.getDueSweepRuntimeSnapshot()).toMatchObject({
      selectedCount: 1,
      handoffAcknowledgedCount: 1,
      handoffInsertionUnknownCount: 1,
      handoffErrorCount: 0,
    });
    expect(JSON.stringify(service.getDueSweepRuntimeSnapshot())).not.toMatch(
      /private-|newJobs|existingJobs/,
    );
  });

  it('records expiry failure and propagates it before selection or Redis handoff', async () => {
    const error = new Error('private-expiry-failure');
    const queryRaw = jest.fn();
    const { service, queue } = createService(
      {},
      { $queryRaw: queryRaw, $executeRaw: jest.fn().mockRejectedValue(error) },
    );

    await expect(service.sweepDueIntents()).rejects.toBe(error);

    expect(queryRaw).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(service.getDueSweepRuntimeSnapshot()).toMatchObject({
      calls: 1,
      completed: 0,
      errors: 1,
      selectedCount: 0,
      stages: {
        expire: { calls: 1, succeeded: 0, errors: 1 },
        select: { calls: 0 },
        handoff: { calls: 0 },
      },
    });
    expect(JSON.stringify(service.getDueSweepRuntimeSnapshot())).not.toContain('private-');
  });

  it('records selection failure without starting a handoff or swallowing the error', async () => {
    const error = new Error('private-selection-failure');
    const { service, queue } = createService({}, { $queryRaw: jest.fn().mockRejectedValue(error) });

    await expect(service.sweepDueIntents()).rejects.toBe(error);

    expect(queue.add).not.toHaveBeenCalled();
    expect(service.getDueSweepRuntimeSnapshot()).toMatchObject({
      calls: 1,
      completed: 0,
      errors: 1,
      selectedCount: 0,
      stages: {
        expire: { calls: 1, succeeded: 1, errors: 0 },
        select: { calls: 1, succeeded: 0, errors: 1 },
        handoff: { calls: 0 },
      },
    });
  });

  it('keeps an empty due sweep distinct from acknowledged handoffs', async () => {
    const { service, queue, prisma } = createService();

    await expect(service.sweepDueIntents()).resolves.toBe(0);

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(queue.add).not.toHaveBeenCalled();
    expect(service.getDueSweepRuntimeSnapshot()).toMatchObject({
      calls: 1,
      completed: 1,
      errors: 0,
      executionDisabled: 0,
      selectedCount: 0,
      handoffAttemptedCount: 0,
      handoffAcknowledgedCount: 0,
      stages: {
        expire: { calls: 1 },
        select: { calls: 1, returnedCount: 0 },
        handoff: { calls: 1, returnedCount: 0 },
      },
    });
  });

  it('measures inner stages on the monotonic clock and returns detached fixed snapshots', async () => {
    const { service } = createService(
      {},
      { $queryRaw: jest.fn().mockResolvedValue([{ id: 'private-intent' }]) },
    );
    const readings = [0, 99.1, 100, 600, 601, 2601];
    const monotonic = jest.spyOn(performance, 'now').mockImplementation(() => readings.shift()!);
    try {
      await service.sweepDueIntents();
    } finally {
      monotonic.mockRestore();
    }

    expect(service.getDueSweepRuntimeSnapshot()).toMatchObject({
      stages: {
        expire: {
          totalDurationMs: 100,
          maxDurationMs: 100,
          durationBuckets: { under100Ms: 1 },
        },
        select: {
          totalDurationMs: 500,
          maxDurationMs: 500,
          durationBuckets: { under2000Ms: 1 },
        },
        handoff: {
          totalDurationMs: 2_000,
          maxDurationMs: 2_000,
          durationBuckets: { atLeast2000Ms: 1 },
        },
      },
    });
    const snapshot = service.getDueSweepRuntimeSnapshot();
    snapshot.calls = 900;
    snapshot.stages.expire!.calls = 900;
    snapshot.stages.expire!.durationBuckets.under100Ms = 900;
    expect(service.getDueSweepRuntimeSnapshot()).toMatchObject({
      calls: 1,
      stages: { expire: { calls: 1, durationBuckets: { under100Ms: 1 } } },
    });
  });

  it('bounds expiry of a 474-row capability backlog and fails closed around mutation evidence', async () => {
    const executeRaw = jest.fn().mockResolvedValue(100);
    const { service } = createService(
      {
        MODERATION_DELETE_INTENT_MODE: 'canary',
        MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: 'canary-chat',
        MODERATION_DELETE_INTENT_SWEEP_BATCH_SIZE: 100,
      },
      { $executeRaw: executeRaw },
    );

    await expect((service as unknown as ServiceInternals).expireDueIntents()).resolves.toBe(100);

    const query = executeRaw.mock.calls[0]?.[0];
    const sql = query?.strings?.join('?') ?? '';
    expect(sql).toContain('WITH candidates AS');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('LIMIT');
    expect(sql).toContain("CAST('WAITING_CAPABILITY' AS");
    expect(sql).toContain("CAST('IN_PROGRESS' AS");
    expect(sql).toContain('intent."lease_expires_at" IS NULL');
    expect(sql).toContain('intent."lease_expires_at" <= CURRENT_TIMESTAMP');
    expect(sql).toMatch(
      /intent\."status" <> CAST\('IN_PROGRESS'[\s\S]*?OR intent\."lease_expires_at" IS NULL[\s\S]*?OR intent\."lease_expires_at" <= CURRENT_TIMESTAMP/u,
    );
    expect(sql).toContain('intent."remote_delete_succeeded_at" IS NULL');
    expect(sql).toContain('intent."remote_delete_succeeded_bot_id" IS NULL');
    expect(sql).toContain('intent."delete_dispatch_started_at" IS NULL');
    expect(sql).toContain('intent."delete_dispatch_started_bot_id" IS NULL');
    expect(sql).toContain('SET\n        "status" = CAST(\'EXPIRED\'');
    expect(sql).not.toContain('base_reason');
    expect(sql).not.toContain('ocr_reason');
    expect(sql).not.toContain('execution_reason');
    expect(query?.values).toEqual([100]);
  });

  it('treats complete and partial dispatch or success markers as mutation evidence', () => {
    const { service } = createService();
    const internals = service as unknown as ServiceInternals;

    expect(
      internals.hasRemoteSuccessMarker({
        remoteDeleteSucceededAt: new Date(),
        remoteDeleteSucceededBotId: 'bot-1',
      }),
    ).toBe(true);
    expect(
      internals.hasRemoteSuccessMarker({
        remoteDeleteSucceededAt: new Date(),
        remoteDeleteSucceededBotId: null,
      }),
    ).toBe(true);
    expect(
      internals.hasRemoteSuccessMarker({
        remoteDeleteSucceededAt: null,
        remoteDeleteSucceededBotId: 'bot-1',
      }),
    ).toBe(true);
    expect(
      internals.hasDeleteDispatchMarker({
        deleteDispatchStartedAt: new Date(),
        deleteDispatchStartedBotId: 'bot-1',
      }),
    ).toBe(true);
    expect(
      internals.hasDeleteDispatchMarker({
        deleteDispatchStartedAt: new Date(),
        deleteDispatchStartedBotId: null,
      }),
    ).toBe(true);
    expect(
      internals.hasDeleteDispatchMarker({
        deleteDispatchStartedAt: null,
        deleteDispatchStartedBotId: 'bot-1',
      }),
    ).toBe(true);
    expect(
      internals.hasDeleteMutationEvidence({
        remoteDeleteSucceededAt: null,
        remoteDeleteSucceededBotId: 'bot-1',
        deleteDispatchStartedAt: null,
        deleteDispatchStartedBotId: null,
      }),
    ).toBe(true);
  });

  it('runs expiry housekeeping even when no intent is eligible for execution', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const executeRaw = jest.fn().mockResolvedValue(0);
    const { service } = createService({}, { $queryRaw: queryRaw, $executeRaw: executeRaw });
    (service as unknown as { hasAnyExecutionScope: () => boolean }).hasAnyExecutionScope = () =>
      false;

    await expect(service.sweepDueIntents()).resolves.toBe(0);

    expect(executeRaw).toHaveBeenCalledTimes(1);
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('uses SKIP LOCKED to select a bounded unleased DB recovery batch', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const { service } = createService({}, { $queryRaw: queryRaw });

    await (service as unknown as ServiceInternals).selectDueIntentIds();

    const query = queryRaw.mock.calls[0]?.[0];
    const sql = query?.strings?.join('?') ?? String(query);
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('LIMIT');
    expect(sql).not.toContain('UPDATE "moderation_delete_intents" intent');
    expect(sql).toContain('intent."remote_delete_succeeded_at" IS NOT NULL');
    expect(sql).toContain('intent."remote_delete_succeeded_bot_id" IS NOT NULL');
    expect(sql).toContain('intent."delete_dispatch_started_at" IS NOT NULL');
    expect(sql).toContain('intent."delete_dispatch_started_bot_id" IS NOT NULL');
    expect(sql).toContain('intent."attempt_count" <');
    expect(sql).toContain('intent."commercial_ocr_guard_required" = FALSE');
    expect(sql).toContain('retry_cap_other_reason."rule_code" <>');
    expect(sql).not.toContain('retry_cap_other_reason."rule_code" NOT IN');
    expect(sql.match(/intent\."remote_delete_succeeded_at" IS NOT NULL/gu)).toHaveLength(15);
    expect(sql.match(/intent\."remote_delete_succeeded_bot_id" IS NOT NULL/gu)).toHaveLength(15);
    expect(sql.match(/intent\."delete_dispatch_started_at" IS NOT NULL/gu)).toHaveLength(10);
    expect(sql.match(/intent\."delete_dispatch_started_bot_id" IS NOT NULL/gu)).toHaveLength(10);
    expect(query?.values).toEqual(
      expect.arrayContaining([
        5,
        'BOT_MESSAGE_AUTO_DELETE',
        COMMERCIAL_OCR_DELETE_RULE_CODE,
        'CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP',
        'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP',
        'CHAT_RULES_REPUBLISH_PREVIOUS_MESSAGE_CLEANUP',
      ]),
    );
  });

  it('selects OCR retries through the OCR cohort without admitting unrelated chat rules', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const { service } = createService(
      {
        MODERATION_DELETE_INTENT_MODE: 'shadow',
        COMMERCIAL_OCR_ROLLOUT_MODE: 'canary',
        COMMERCIAL_OCR_CANARY_CHAT_IDS: 'chat-1',
      },
      { $queryRaw: queryRaw },
    );

    await (service as unknown as ServiceInternals).selectDueIntentIds();

    const query = queryRaw.mock.calls[0]?.[0];
    const sql = query?.strings?.join('?') ?? '';
    expect(sql).toContain('base_reason."rule_code" <>');
    expect(sql).toContain('ocr_reason."rule_code" =');
    expect(query?.values).toEqual(
      expect.arrayContaining(['chat-1', COMMERCIAL_OCR_DELETE_RULE_CODE]),
    );
  });

  it('recovers due commercial baseline intents through a bounded OCR-only sweep when other policies are off', async () => {
    const queryRaw = jest.fn().mockResolvedValue([{ id: 'baseline-intent-1' }]);
    const { service, queue } = createService(
      {
        MODERATION_DELETE_INTENT_MODE: 'off',
        MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_ENABLED: false,
        COMMERCIAL_OCR_ROLLOUT_MODE: 'baseline',
        COMMERCIAL_OCR_CANARY_CHAT_IDS: '',
        IMAGE_TEXT_STOP_LIST_OCR_ROLLOUT_MODE: 'off',
      },
      { $queryRaw: queryRaw },
    );

    await expect(service.sweepDueIntents()).resolves.toBe(1);

    const query = queryRaw.mock.calls[0]![0];
    const sql = query.strings?.join('?') ?? '';
    expect(sql).toMatch(
      /FALSE\s+AND EXISTS\s*\(\s*SELECT 1\s+FROM "moderation_delete_intent_reasons" base_reason/u,
    );
    expect(sql).toMatch(
      /TRUE\s+AND EXISTS\s*\(\s*SELECT 1\s+FROM "moderation_delete_intent_reasons" ocr_reason/u,
    );
    expect(sql).toContain("COALESCE(ocr_reason.\"metadata\"->>'source', '') <> 'image_text_ocr'");
    expect(sql).not.toContain('image_text_reason');
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain('LIMIT');
    expect(query.values).toContain(100);
    expect(queue.add).toHaveBeenCalledWith(
      'execute-moderation-delete-intent',
      { intentId: 'baseline-intent-1' },
      expect.objectContaining({ priority: 10 }),
    );
  });

  it('allows a recorded remote success to be claimed after the retry horizon', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const { service } = createService({}, { $queryRaw: queryRaw });

    await (service as unknown as ServiceInternals).claimOne('intent-1');

    const sql = queryRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    expect(sql).toMatch(
      /"retry_until_at" >[\s\S]*?OR "remote_delete_succeeded_at" IS NOT NULL[\s\S]*?OR "remote_delete_succeeded_bot_id" IS NOT NULL[\s\S]*?OR "delete_dispatch_started_at" IS NOT NULL[\s\S]*?OR "delete_dispatch_started_bot_id" IS NOT NULL/u,
    );
  });

  it('links a replacement marker in the intent transaction before enqueueing execution', async () => {
    const persisted = {
      ...baseIntent,
      status: 'PENDING',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const txExecuteRaw = jest.fn().mockResolvedValue(1);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({
          $queryRaw: jest.fn().mockResolvedValue([persisted]),
          $executeRaw: txExecuteRaw,
        }),
    );
    const { service, queue } = createService(
      {
        MODERATION_DELETE_INTENT_MODE: 'canary',
        MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: 'other-chat',
      },
      { $transaction: transaction },
    );

    await expect(
      service.ensureIntent({
        chatId: 'chat-1',
        messageId: 'message-1',
        reasonKey: 'chat_auto_comment_admin_message_replacement_cleanup',
        ruleCode: 'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP',
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        originBotId: 'bot-1',
        routingPolicy: 'origin_first',
      }),
    ).resolves.toMatchObject({ rollout: 'execute', status: 'PENDING' });

    const linkCall = txExecuteRaw.mock.calls.find((call) =>
      (call[0]?.strings?.join('?') ?? '').includes('UPDATE "chat_auto_comment_attach_markers"'),
    );
    expect(linkCall).toBeDefined();
    expect(linkCall?.[0]?.strings?.join('?') ?? '').toContain('"cleanup_intent_id" =');
    expect(linkCall?.[0]?.values).toEqual(
      expect.arrayContaining(['intent-1', 'chat-1', 'message-1']),
    );
    expect(txExecuteRaw.mock.invocationCallOrder.at(-1)).toBeLessThan(
      queue.add.mock.invocationCallOrder[0]!,
    );
  });

  it('upgrades legacy replacement reason and routing before linking and waking', async () => {
    const persisted = {
      ...baseIntent,
      routingPolicy: 'origin_first',
      status: 'PENDING',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const txExecuteRaw = jest.fn().mockResolvedValue(1);
    const txQueryRaw = jest.fn().mockResolvedValue([persisted]);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({
          $queryRaw: txQueryRaw,
          $executeRaw: txExecuteRaw,
        }),
    );
    const { service, queue } = createService(
      {
        MODERATION_DELETE_INTENT_MODE: 'shadow',
      },
      { $transaction: transaction },
    );

    await expect(
      service.ensureIntent({
        chatId: 'chat-1',
        messageId: 'message-1',
        reasonKey: 'chat_auto_comment_admin_message_replacement_cleanup',
        ruleCode: 'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP',
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        originBotId: 'bot-1',
        routingPolicy: 'origin_first',
      }),
    ).resolves.toMatchObject({ rollout: 'execute', status: 'PENDING' });

    const reasonCall = txExecuteRaw.mock.calls.find((call) =>
      (call[0]?.strings?.join('?') ?? '').includes(
        'INSERT INTO "moderation_delete_intent_reasons"',
      ),
    );
    const linkCall = txExecuteRaw.mock.calls.find((call) =>
      (call[0]?.strings?.join('?') ?? '').includes('UPDATE "chat_auto_comment_attach_markers"'),
    );
    expect(reasonCall).toBeDefined();
    expect(reasonCall?.[0]?.strings?.join('?') ?? '').toContain(
      'ON CONFLICT ("intent_id", "reason_key") DO UPDATE SET',
    );
    expect(reasonCall?.[0]?.strings?.join('?') ?? '').toContain(
      '"rule_code" = EXCLUDED."rule_code"',
    );
    expect(reasonCall?.[0]?.values).toEqual(
      expect.arrayContaining([
        'CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP',
        'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP',
        'CHAT_RULES_REPUBLISH_PREVIOUS_MESSAGE_CLEANUP',
      ]),
    );
    const upsertSql = txQueryRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    expect(upsertSql).toContain('EXCLUDED."routing_policy" = \'delete_capable\'');
    expect(upsertSql).toContain('"moderation_delete_intents"."routing_policy" = \'origin_only\'');
    expect(txQueryRaw.mock.calls[0]?.[0]?.values).toContain(true);
    expect(txExecuteRaw.mock.calls.indexOf(reasonCall!)).toBeLessThan(
      txExecuteRaw.mock.calls.indexOf(linkCall!),
    );
    expect(txExecuteRaw.mock.invocationCallOrder.at(-1)).toBeLessThan(
      queue.add.mock.invocationCallOrder[0]!,
    );
  });

  it('promotes OBSERVED only when a new ensure arrives in execute rollout', async () => {
    const queryRaw = jest.fn().mockResolvedValue([
      {
        ...baseIntent,
        status: 'PENDING',
        routingPolicy: 'delete_capable',
        originBotId: 'bot-2',
        leaseToken: null,
        leaseExpiresAt: null,
      },
    ]);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: typeof queryRaw; $executeRaw: jest.Mock }) => unknown) =>
        callback({ $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) }),
    );
    const { service } = createService(
      { MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS: 'chat-1' },
      { $transaction: transaction },
    );

    await expect(
      service.ensureIntent({
        chatId: 'chat-1',
        messageId: 'message-1',
        reasonKey: 'DUPLICATE',
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        originBotId: 'bot-2',
        routingPolicy: 'delete_capable',
      }),
    ).resolves.toMatchObject({ rollout: 'execute', status: 'PENDING' });

    const sql = queryRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain("CAST('OBSERVED' AS");
    expect(sql).toContain('EXCLUDED."status"');
    expect(sql).toContain('"routing_policy" = CASE');
    expect(sql).toContain('EXCLUDED."routing_policy"');
    expect(sql).toContain('EXCLUDED."origin_bot_id"');
    expect(sql).toContain('EXCLUDED."entity_type"');
  });

  it('does not promote a historical OBSERVED bot-message auto-delete on replay', async () => {
    const observed = {
      ...baseIntent,
      status: 'OBSERVED',
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const queryRaw = jest.fn().mockResolvedValue([observed]);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: typeof queryRaw; $executeRaw: jest.Mock }) => unknown) =>
        callback({ $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) }),
    );
    const { service, queue } = createService(
      {
        MODERATION_DELETE_INTENT_MODE: 'canary',
        MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: 'other-chat',
      },
      { $transaction: transaction },
    );

    await expect(
      service.ensureIntent({
        chatId: 'chat-1',
        messageId: 'message-1',
        reasonKey: 'bot-message-auto-delete:message-1',
        ruleCode: 'BOT_MESSAGE_AUTO_DELETE',
        entityType: 'CHAT',
        messageAuthorKind: 'bot',
        originBotId: 'bot-1',
        routingPolicy: 'origin_only',
      }),
    ).resolves.toEqual({ intentId: 'intent-1', rollout: 'observed', status: 'OBSERVED' });

    const upsertSql = queryRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    expect(upsertSql).toContain('WHEN FALSE');
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does not reopen an expired intent for a generic repeated ensure', async () => {
    const expired = {
      ...baseIntent,
      status: 'EXPIRED',
      completedAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const queryRaw = jest.fn().mockResolvedValue([expired]);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({ $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) }),
    );
    const { service, queue } = createService({}, { $transaction: transaction });

    await expect(
      service.ensureIntent({
        chatId: 'chat-1',
        messageId: 'message-1',
        reasonKey: 'DUPLICATE',
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        originBotId: 'bot-1',
      }),
    ).resolves.toMatchObject({ status: 'EXPIRED' });

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it.each(['EXPIRED', 'FAILED_TERMINAL'] as const)(
    'reopens a %s live link intent only for a newer message event',
    async (status) => {
      const previousEventAt = new Date('2026-08-11T02:56:00.000Z');
      const editedEventAt = new Date('2026-08-11T02:57:00.000Z');
      const terminal = {
        ...baseIntent,
        status,
        sourceMessageAt: previousEventAt,
        attemptCount: 3,
        firstAttemptAt: new Date('2026-08-11T02:56:10.000Z'),
        lastAttemptAt: new Date('2026-08-11T02:56:30.000Z'),
        completedAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
      };
      const reopened = {
        ...terminal,
        status: 'PENDING',
        sourceMessageAt: editedEventAt,
        completedAt: null,
        nextAttemptAt: new Date(Date.now() - 1_000),
        retryUntilAt: new Date(Date.now() + 60_000),
      };
      const queryRaw = jest
        .fn()
        .mockResolvedValueOnce([terminal])
        .mockResolvedValueOnce([reopened]);
      const transaction = jest.fn(
        async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
          callback({ $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(0) }),
      );
      const { service, queue } = createService({}, { $transaction: transaction });

      await expect(
        service.ensureIntent({
          chatId: 'chat-1',
          messageId: 'message-1',
          reasonKey: 'LINK_BLOCKED:violation-delete:r1',
          ruleCode: 'LINK_BLOCKED_DELETE',
          subjectUserId: 'user-1',
          sourceMessageAt: editedEventAt,
          entityType: 'CHAT',
          messageAuthorKind: 'user',
          originBotId: 'bot-1',
          event: {
            userId: 'user-1',
            eventType: 'MESSAGE',
            metadata: { linkPolicyRevision: 1 },
          },
        }),
      ).resolves.toMatchObject({ status: 'PENDING' });

      expect(queryRaw).toHaveBeenCalledTimes(2);
      const upsertSql = queryRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
      const reopenSql = queryRaw.mock.calls[1]?.[0]?.strings?.join('?') ?? '';
      expect(upsertSql).toContain(
        '"moderation_delete_intents"."source_message_at" < EXCLUDED."source_message_at"',
      );
      expect(reopenSql).toContain('"source_message_at" < ?');
      expect(reopenSql).toContain("CAST('FAILED_TERMINAL' AS");
      expect(reopenSql).toContain('"attempt_count" = 0');
      expect(reopenSql).toContain('"first_attempt_at" = NULL');
      expect(reopenSql).toContain('"last_attempt_at" = NULL');
      expect(queue.add).toHaveBeenCalledWith(
        'execute-moderation-delete-intent',
        { intentId: 'intent-1' },
        expect.objectContaining({ priority: 1 }),
      );
    },
  );

  it.each(['EXPIRED', 'FAILED_TERMINAL'] as const)(
    'does not reopen a %s live link intent for a replay of the same event',
    async (status) => {
      const sourceMessageAt = new Date('2026-08-11T02:56:00.000Z');
      const terminal = {
        ...baseIntent,
        status,
        sourceMessageAt,
        completedAt: new Date(),
        leaseToken: null,
        leaseExpiresAt: null,
      };
      const queryRaw = jest.fn().mockResolvedValue([terminal]);
      const transaction = jest.fn(
        async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
          callback({ $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(0) }),
      );
      const { service, queue } = createService({}, { $transaction: transaction });

      await expect(
        service.ensureIntent({
          chatId: 'chat-1',
          messageId: 'message-1',
          reasonKey: 'LINK_BLOCKED:violation-delete:r1',
          ruleCode: 'LINK_BLOCKED_DELETE',
          subjectUserId: 'user-1',
          sourceMessageAt,
          entityType: 'CHAT',
          messageAuthorKind: 'user',
          originBotId: 'bot-1',
          event: { userId: 'user-1', eventType: 'MESSAGE' },
        }),
      ).resolves.toMatchObject({ status });

      expect(queryRaw).toHaveBeenCalledTimes(1);
      expect(queue.add).not.toHaveBeenCalled();
    },
  );

  it('reopens an expired replacement cleanup exactly when its recovery reason is first inserted', async () => {
    const expired = {
      ...baseIntent,
      status: 'EXPIRED',
      completedAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const reopened = {
      ...expired,
      status: 'PENDING',
      completedAt: null,
      nextAttemptAt: new Date(Date.now() - 1_000),
      retryUntilAt: new Date(Date.now() + 60_000),
    };
    const queryRaw = jest.fn().mockResolvedValueOnce([expired]).mockResolvedValueOnce([reopened]);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({ $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(1) }),
    );
    const { service, queue } = createService({}, { $transaction: transaction });

    await expect(
      service.ensureIntent({
        chatId: 'chat-1',
        messageId: 'message-1',
        reasonKey: 'replacement-cleanup-recovery:channel_auto_post:marker-1',
        ruleCode: 'CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP',
        entityType: 'CHANNEL',
        messageAuthorKind: 'user',
        originBotId: 'bot-1',
      }),
    ).resolves.toMatchObject({ status: 'PENDING' });

    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(queue.add).toHaveBeenCalledWith(
      'execute-moderation-delete-intent',
      { intentId: 'intent-1' },
      expect.objectContaining({ priority: 1 }),
    );
  });

  it('does not repeatedly reopen replacement cleanup when the recovery reason already exists', async () => {
    const expired = {
      ...baseIntent,
      status: 'EXPIRED',
      completedAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const queryRaw = jest.fn().mockResolvedValue([expired]);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({ $queryRaw: queryRaw, $executeRaw: jest.fn().mockResolvedValue(0) }),
    );
    const { service, queue } = createService({}, { $transaction: transaction });

    await expect(
      service.ensureIntent({
        chatId: 'chat-1',
        messageId: 'message-1',
        reasonKey: 'replacement-cleanup-recovery:channel_auto_post:marker-1',
        ruleCode: 'CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP',
        entityType: 'CHANNEL',
        messageAuthorKind: 'user',
        originBotId: 'bot-1',
      }),
    ).resolves.toMatchObject({ status: 'EXPIRED' });

    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('reopens a managed-output auto-delete block when a later lawful cleanup reason arrives', async () => {
    const blocked = {
      ...baseIntent,
      status: 'FAILED_TERMINAL',
      lastErrorCode: 'managed_output_auto_delete_blocked',
      lastError: 'Managed bot output is protected',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const reopened = {
      ...blocked,
      status: 'PENDING',
      lastErrorCode: null,
      lastError: null,
      nextAttemptAt: new Date(Date.now() - 1_000),
      retryUntilAt: new Date(Date.now() + 60_000),
    };
    const queryRaw = jest.fn().mockResolvedValueOnce([blocked]).mockResolvedValueOnce([reopened]);
    const executeRaw = jest.fn().mockResolvedValue(1);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({ $queryRaw: queryRaw, $executeRaw: executeRaw }),
    );
    const { service, queue } = createService({}, { $transaction: transaction });

    await expect(
      service.ensureIntent({
        chatId: 'chat-1',
        messageId: 'message-1',
        reasonKey: 'chat-rules-republish:message-1',
        ruleCode: 'CHAT_RULES_REPUBLISH_PREVIOUS_MESSAGE_CLEANUP',
        entityType: 'CHAT',
        messageAuthorKind: 'bot',
        originBotId: 'bot-1',
      }),
    ).resolves.toMatchObject({ status: 'PENDING' });

    expect(queryRaw).toHaveBeenCalledTimes(2);
    const reopenSql = queryRaw.mock.calls[1]?.[0]?.strings?.join('?') ?? '';
    expect(reopenSql).toContain("last_error_code\" = 'managed_output_auto_delete_blocked'");
    expect(reopenSql).toContain('CAST(\'PENDING\' AS "ModerationDeleteIntentStatus")');
    expect(queue.add).toHaveBeenCalledWith(
      'execute-moderation-delete-intent',
      { intentId: 'intent-1' },
      expect.objectContaining({ priority: 1 }),
    );
  });

  it.each<{
    label: string;
    config: Record<string, unknown>;
    input: () => EnsureModerationDeleteIntentInput;
  }>([
    {
      label: 'required-subscription',
      config: { MODERATION_DELETE_INTENT_REQUIRED_SUBSCRIPTION_ENABLED: true },
      input: () => ({
        ...requiredSubscriptionDeleteIntentInput(),
        messageAuthorKind: 'bot',
        routingPolicy: 'origin_only',
      }),
    },
    {
      label: 'commercial OCR',
      config: {},
      input: () => commercialOcrClaimedIntentInput().intent,
    },
    {
      label: 'channel replacement cleanup',
      config: {},
      input: () => ({
        chatId: 'chat-1',
        messageId: 'message-1',
        reasonKey: 'channel-auto-post-cleanup:message-1',
        ruleCode: 'CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP',
        entityType: 'CHANNEL',
        messageAuthorKind: 'user',
        originBotId: 'bot-1',
        routingPolicy: 'origin_only',
      }),
    },
  ])(
    'reopens a capped auto-delete when a later $label reason arrives',
    async ({ config, input }) => {
      const capped = {
        ...baseIntent,
        status: 'FAILED_TERMINAL' as const,
        attemptCount: 5,
        lastErrorCode: 'bot_message_auto_delete_retry_limit_reached',
        lastError: 'BOT_MESSAGE_AUTO_DELETE reached its external-attempt limit',
        leaseToken: null,
        leaseExpiresAt: null,
      };
      const reopened = {
        ...capped,
        status: 'PENDING' as const,
        lastErrorCode: null,
        lastError: null,
        nextAttemptAt: new Date(Date.now() - 1_000),
        retryUntilAt: new Date(Date.now() + 60_000),
      };
      const queryRaw = jest.fn().mockImplementation(async (query: { strings?: string[] }) => {
        const sql = query.strings?.join('?') ?? '';
        if (sql.includes('UPDATE "moderation_delete_intents"')) {
          return [reopened];
        }
        if (sql.includes('AS "nonCommercialOcrDeleteReason"')) {
          return [
            {
              nonCommercialOcrDeleteReason: true,
              replacementCleanup: false,
              nonChannelReplacementCleanup: false,
              channelAutoPostCleanupReason: false,
              botMessageAutoDeleteReason: true,
              requiredSubscriptionDeleteReason: false,
            },
          ];
        }
        return [capped];
      });
      const executeRaw = jest.fn().mockResolvedValue(1);
      const transaction = jest.fn(
        async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
          callback({ $queryRaw: queryRaw, $executeRaw: executeRaw }),
      );
      const { service, queue } = createService(config, { $transaction: transaction });

      await expect(service.ensureIntent(input())).resolves.toMatchObject({ status: 'PENDING' });

      const reopenQuery = queryRaw.mock.calls
        .map((call) => call[0])
        .find((query) =>
          (query?.strings?.join('?') ?? '').includes('UPDATE "moderation_delete_intents"'),
        );
      expect(reopenQuery?.strings?.join('?') ?? '').toContain(
        'CAST(\'PENDING\' AS "ModerationDeleteIntentStatus")',
      );
      expect(reopenQuery?.values).toContain('bot_message_auto_delete_retry_limit_reached');
      expect(queue.add).toHaveBeenCalledWith(
        'execute-moderation-delete-intent',
        { intentId: 'intent-1' },
        expect.objectContaining({ priority: 1 }),
      );
    },
  );

  it('resets the bounded auto-delete attempt counter on an explicit manual retry', async () => {
    const updatedAt = new Date('2026-08-17T12:00:00.000Z');
    const capped = {
      ...baseIntent,
      status: 'FAILED_TERMINAL' as const,
      attemptCount: 5,
      updatedAt,
      completedAt: new Date(),
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      botMessageAutoDeleteOnly: true,
      requiredSubscriptionDeleteReason: false,
      lastErrorCode: 'bot_message_auto_delete_retry_limit_reached',
      lastError: 'BOT_MESSAGE_AUTO_DELETE reached its external-attempt limit',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const reopened = {
      ...capped,
      status: 'PENDING' as const,
      attemptCount: 0,
      completedAt: null,
      lastErrorCode: null,
      lastError: null,
      nextAttemptAt: new Date(Date.now() - 1_000),
      retryUntilAt: new Date(Date.now() + 60_000),
    };
    const rootQueryRaw = jest.fn().mockResolvedValueOnce([capped]);
    const txQueryRaw = jest.fn().mockResolvedValueOnce([reopened]);
    const transaction = jest.fn(async (callback: (tx: { $queryRaw: jest.Mock }) => unknown) =>
      callback({ $queryRaw: txQueryRaw }),
    );
    const { service, queue } = createService(
      {},
      { $queryRaw: rootQueryRaw, $transaction: transaction },
    );

    await expect(
      service.retryTerminalIntent('intent-1', 'FAILED_TERMINAL', {
        updatedAt,
        attemptCount: 5,
      }),
    ).resolves.toMatchObject({
      reopened: true,
      intent: { status: 'PENDING', attemptCount: 0 },
    });

    const retryQuery = txQueryRaw.mock.calls[0]?.[0];
    expect(retryQuery?.strings?.join('?') ?? '').toContain('"attempt_count" = CASE');
    expect(retryQuery?.values).toContain(true);
    expect(queue.add).toHaveBeenCalledWith(
      'execute-moderation-delete-intent',
      { intentId: 'intent-1' },
      expect.objectContaining({ priority: 1 }),
    );
  });

  it('reopens a terminal night-mode cleanup for exact pre-dispatch reconstruction', async () => {
    const terminal = {
      ...baseIntent,
      status: 'FAILED_TERMINAL' as const,
      completedAt: new Date(),
      updatedAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
      nightModeCloseNoticeCleanupReason: true,
      nightModeCloseNoticeCleanupOnly: true,
      lastErrorCode: 'night_mode_close_notice_cleanup_stale',
    };
    const reopened = {
      ...terminal,
      status: 'PENDING' as const,
      completedAt: null,
      lastErrorCode: null,
      nextAttemptAt: new Date(),
      retryUntilAt: new Date(Date.now() + 60_000),
    };
    const txQueryRaw = jest.fn().mockResolvedValueOnce([reopened]);
    const transaction = jest.fn(async (callback: (tx: { $queryRaw: jest.Mock }) => unknown) =>
      callback({ $queryRaw: txQueryRaw }),
    );
    const { service, queue } = createService(
      {},
      {
        $queryRaw: jest.fn().mockResolvedValue([terminal]),
        $transaction: transaction,
      },
    );

    await expect(
      service.retryTerminalIntent('intent-1', 'FAILED_TERMINAL', {
        updatedAt: terminal.updatedAt,
        attemptCount: terminal.attemptCount,
      }),
    ).resolves.toMatchObject({
      reopened: true,
      intent: { status: 'PENDING' },
    });

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      'execute-moderation-delete-intent',
      { intentId: 'intent-1' },
      expect.objectContaining({ priority: 1 }),
    );
  });

  it('manually reopens a terminal intent with its dispatch fence and audit preserved', async () => {
    const dispatchStartedAt = new Date(Date.now() - 30_000);
    const expired = {
      ...baseIntent,
      status: 'EXPIRED',
      completedAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
      deleteDispatchStartedAt: dispatchStartedAt,
      deleteDispatchStartedBotId: 'bot-1',
    };
    const reopened = {
      ...expired,
      status: 'AMBIGUOUS',
      completedAt: null,
      nextAttemptAt: new Date(Date.now() - 1_000),
      retryUntilAt: new Date(Date.now() + 60_000),
    };
    const rootQueryRaw = jest.fn().mockResolvedValueOnce([expired]);
    const txQueryRaw = jest.fn().mockResolvedValueOnce([reopened]);
    const auditCreate = jest.fn().mockResolvedValue({ id: 'audit-1' });
    const transaction = jest.fn(
      async (
        callback: (tx: { $queryRaw: jest.Mock; auditLog: { create: jest.Mock } }) => unknown,
      ) => callback({ $queryRaw: txQueryRaw, auditLog: { create: auditCreate } }),
    );
    const { service, queue } = createService(
      {},
      { $queryRaw: rootQueryRaw, $transaction: transaction },
    );
    const changePriority = jest.fn().mockResolvedValue(undefined);
    queue.add.mockResolvedValueOnce({ opts: { priority: 10 }, changePriority });

    const expectedUpdatedAt = new Date('2026-07-16T12:00:00.000Z');
    const result = await service.retryTerminalIntent(
      'intent-1',
      'EXPIRED',
      { updatedAt: expectedUpdatedAt, attemptCount: 1 },
      { actorUserId: 'owner' },
    );

    expect(result).toMatchObject({
      reopened: true,
      intent: {
        status: 'AMBIGUOUS',
        deleteDispatchStartedAt: dispatchStartedAt,
        deleteDispatchStartedBotId: 'bot-1',
        attemptCount: 1,
      },
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'SAFETY_DESK_REOPEN_DELETE_INTENT',
        actorUserId: 'owner',
      }),
    });
    expect(txQueryRaw.mock.calls[0]?.[0]?.values).toEqual(
      expect.arrayContaining([expectedUpdatedAt, 1]),
    );
    const reopenSql = txQueryRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    expect(reopenSql).toMatch(
      /WHEN "remote_delete_succeeded_at" IS NOT NULL\s+OR "remote_delete_succeeded_bot_id" IS NOT NULL\s+OR "delete_dispatch_started_at" IS NOT NULL\s+OR "delete_dispatch_started_bot_id" IS NOT NULL/u,
    );
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(queue.add).toHaveBeenCalledWith(
      'execute-moderation-delete-intent',
      { intentId: 'intent-1' },
      expect.objectContaining({ priority: 1 }),
    );
    expect(changePriority).toHaveBeenCalledWith({ priority: 1 });
  });

  it('does not manually reopen a commercial OCR intent after its absolute deadline', async () => {
    const deadline = new Date(Date.now() - 1_000);
    const expired = {
      ...baseIntent,
      status: 'EXPIRED' as const,
      commercialOcrGuardRequired: true,
      commercialOcrDeadlineAt: deadline,
      retryUntilAt: deadline,
      completedAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const rootQueryRaw = jest
      .fn()
      .mockResolvedValueOnce([expired])
      .mockResolvedValueOnce([expired]);
    const txQueryRaw = jest.fn().mockResolvedValueOnce([]);
    const auditCreate = jest.fn();
    const transaction = jest.fn(
      async (
        callback: (tx: { $queryRaw: jest.Mock; auditLog: { create: jest.Mock } }) => unknown,
      ) => callback({ $queryRaw: txQueryRaw, auditLog: { create: auditCreate } }),
    );
    const { service, queue } = createService(
      {},
      { $queryRaw: rootQueryRaw, $transaction: transaction },
    );

    await expect(
      service.retryTerminalIntent(
        'intent-1',
        'EXPIRED',
        { updatedAt: new Date('2026-07-16T12:00:00.000Z'), attemptCount: 1 },
        { actorUserId: 'owner' },
      ),
    ).resolves.toEqual({ reopened: false, intent: expect.objectContaining({ status: 'EXPIRED' }) });

    const sql = txQueryRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    expect(sql).toContain('COALESCE("commercial_ocr_deadline_at", "retry_until_at") >');
    expect(auditCreate).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('does not reopen a late old-writer OCR intent after its durable fallback deadline', async () => {
    const deadline = new Date(Date.now() - 1_000);
    const expired = {
      ...baseIntent,
      status: 'EXPIRED' as const,
      commercialOcrGuardRequired: false,
      commercialOcrDeadlineAt: null,
      retryUntilAt: deadline,
      completedAt: new Date(),
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const rootQueryRaw = jest
      .fn()
      .mockResolvedValueOnce([expired])
      .mockResolvedValueOnce([expired]);
    const txQueryRaw = jest.fn().mockResolvedValueOnce([]);
    const auditCreate = jest.fn();
    const transaction = jest.fn(
      async (
        callback: (tx: { $queryRaw: jest.Mock; auditLog: { create: jest.Mock } }) => unknown,
      ) => callback({ $queryRaw: txQueryRaw, auditLog: { create: auditCreate } }),
    );
    const { service, queue } = createService(
      {},
      { $queryRaw: rootQueryRaw, $transaction: transaction },
    );

    await expect(
      service.retryTerminalIntent(
        'intent-1',
        'EXPIRED',
        { updatedAt: new Date('2026-07-16T12:00:00.000Z'), attemptCount: 1 },
        { actorUserId: 'owner' },
      ),
    ).resolves.toEqual({ reopened: false, intent: expect.objectContaining({ status: 'EXPIRED' }) });

    const query = txQueryRaw.mock.calls[0]?.[0];
    const sql = query?.strings?.join('?') ?? '';
    expect(sql).toContain('FROM "moderation_delete_intent_reasons" existing_ocr_reason');
    expect(sql).toContain('COALESCE("commercial_ocr_deadline_at", "retry_until_at") >');
    expect(query?.values).toContain(COMMERCIAL_OCR_DELETE_RULE_CODE);
    expect(auditCreate).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('materializes a late reason attached to an already succeeded intent', async () => {
    const persisted = {
      ...baseIntent,
      status: 'SUCCEEDED',
      succeededBotId: 'bot-1',
      remoteDeleteSucceededAt: new Date(),
      remoteDeleteSucceededBotId: 'bot-1',
      leaseToken: null,
      leaseExpiresAt: null,
      leasedFromStatus: null,
    };
    const executeRaw = jest.fn().mockResolvedValue(1);
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({
          $queryRaw: jest.fn().mockResolvedValue([persisted]),
          $executeRaw: executeRaw,
        }),
    );
    const { service, queue } = createService({}, { $transaction: transaction });

    await expect(
      service.ensureIntent({
        chatId: 'chat-1',
        messageId: 'message-1',
        reasonKey: 'LATE_REASON',
        ruleCode: 'LATE_REASON_DELETE',
        subjectUserId: 'user-1',
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        originBotId: 'bot-1',
        event: { userId: 'user-1', eventType: 'MESSAGE' },
      }),
    ).resolves.toMatchObject({ status: 'SUCCEEDED' });

    const executedSql = executeRaw.mock.calls
      .map((call) => call[0]?.strings?.join('?') ?? '')
      .join('\n');
    expect(executedSql).toContain('INSERT INTO "moderation_events"');
    expect(executedSql).toContain('UPDATE "moderation_delete_intent_reasons"');
    const eventInsert = executeRaw.mock.calls.find(([query]) =>
      query.strings?.join('?').includes('INSERT INTO "moderation_events"'),
    )?.[0] as Prisma.Sql;
    expect(eventInsert.values).toEqual([
      'intent-1',
      ...VERIFIED_RECEIPT_RULE_CODES,
      false,
      'PROFANITY_DELETE',
      'COMMERCIAL_AD_DELETE',
    ]);
    expect(eventInsert.strings.join('?')).toContain(
      "reason.\"metadata\"->'moderationDeleteVerified' = 'true'::jsonb",
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('keeps a persisted intent durable when BullMQ enqueue is temporarily unavailable', async () => {
    const persisted = {
      ...baseIntent,
      status: 'PENDING',
      leaseToken: null,
      leaseExpiresAt: null,
    };
    const transaction = jest.fn(
      async (callback: (tx: { $queryRaw: jest.Mock; $executeRaw: jest.Mock }) => unknown) =>
        callback({
          $queryRaw: jest.fn().mockResolvedValue([persisted]),
          $executeRaw: jest.fn().mockResolvedValue(1),
        }),
    );
    const { service, queue } = createService({}, { $transaction: transaction });
    queue.add.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(
      service.ensureIntent({
        chatId: 'chat-1',
        messageId: 'message-1',
        reasonKey: 'DUPLICATE',
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        originBotId: 'bot-1',
      }),
    ).resolves.toMatchObject({ intentId: 'intent-1', rollout: 'execute', status: 'PENDING' });
  });

  it('quarantines stale replacement send fences in shadow mode without creating delete intents', async () => {
    const channelUpdateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 2 });
    const chatUpdateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const { service } = createService(
      { MODERATION_DELETE_INTENT_MODE: 'shadow' },
      {
        channelAutoPostAttachMarker: { updateMany: channelUpdateMany },
        chatAutoCommentAttachMarker: { updateMany: chatUpdateMany },
      },
    );
    const ensureIntent = jest.spyOn(service, 'ensureIntent');

    await expect(service.quarantineStaleReplacementSendFences()).resolves.toBe(5);

    expect(ensureIntent).not.toHaveBeenCalled();
    expect(channelUpdateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'IN_PROGRESS',
          deliveryMode: 'reply_message',
          replyMessageId: { not: null },
          replacementSendStartedAt: null,
        }),
        data: expect.objectContaining({ status: 'SUCCEEDED' }),
      }),
    );
    expect(channelUpdateMany).toHaveBeenNthCalledWith(2, {
      where: {
        status: 'IN_PROGRESS',
        replacementSendStartedAt: { lte: expect.any(Date) },
        replacementMessageId: null,
      },
      data: expect.objectContaining({
        status: 'SKIPPED',
        lockToken: null,
        lockedAt: null,
        lastError: expect.stringContaining('[max.send_ambiguous]'),
      }),
    });
    expect(chatUpdateMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'IN_PROGRESS',
          deliveryMode: 'reply_message',
          replyMessageId: { not: null },
        }),
        data: expect.objectContaining({ status: 'SUCCEEDED' }),
      }),
    );
    expect(chatUpdateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          status: 'IN_PROGRESS',
          replacementMessageId: null,
        }),
      }),
    );
  });

  it('promotes, links, and wakes observed replacement cleanup outside the global canary', async () => {
    const candidate = {
      sourceId: 'marker-1',
      source: 'chat_auto_comment',
      chatId: 'chat-1',
      messageId: 'message-1',
      originBotId: 'bot-1',
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      routingPolicy: 'origin_first',
      existingIntentId: 'intent-observed-1',
      existingIntentStatus: 'OBSERVED',
      createdAt: new Date(),
    } as const;
    const { service, prisma } = createService(
      {
        MODERATION_DELETE_INTENT_MODE: 'canary',
        MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: 'other-chat',
      },
      { $queryRaw: jest.fn().mockResolvedValue([candidate]) },
    );
    const persistIntent = jest.fn().mockResolvedValue({
      intentId: 'intent-recovered-1',
      rollout: 'execute',
      status: 'PENDING',
    });
    (service as unknown as { persistIntent: typeof persistIntent }).persistIntent = persistIntent;
    const enqueueCurrentWakeup = jest.fn().mockResolvedValue(undefined);
    (service as unknown as ServiceInternals).enqueueCurrentWakeup = enqueueCurrentWakeup;

    await expect(service.recoverReplacementCleanupSources()).resolves.toBe(1);

    expect(persistIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        messageId: 'message-1',
        originBotId: 'bot-1',
        routingPolicy: 'origin_first',
        ruleCode: 'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP',
      }),
      false,
    );
    const sql = prisma.$queryRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    expect(sql).toContain('channel_auto_post_attach_markers');
    expect(sql).toContain('chat_auto_comment_attach_markers');
    expect(sql).toContain('rules."pending_cleanup_message_id"');
    expect(sql).toContain('PUBLISH_CHAT_RULES');
    expect(sql).toContain('marker."bot_id" IS NOT NULL');
    expect(sql).toContain('previousPublishedBotId');
    expect(sql).not.toContain('marker."chat_id" IN');
    expect(sql).toContain('CAST(\'OBSERVED\' AS "ModerationDeleteIntentStatus")');
    expect(enqueueCurrentWakeup).toHaveBeenCalledWith('intent-recovered-1');
  });

  it('returns replacement recovery to the base rollout when the kill switch is disabled', async () => {
    const candidate = {
      sourceId: 'marker-1',
      source: 'chat_auto_comment',
      chatId: 'chat-1',
      messageId: 'message-1',
      originBotId: 'bot-1',
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      routingPolicy: 'origin_first',
      existingIntentId: 'intent-observed-1',
      existingIntentStatus: 'OBSERVED',
      createdAt: new Date(),
    } as const;
    const queryRaw = jest.fn().mockResolvedValue([candidate]);
    const { service } = createService(
      {
        MODERATION_DELETE_INTENT_MODE: 'canary',
        MODERATION_DELETE_INTENT_CANARY_CHAT_IDS: 'other-chat',
        MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_ENABLED: false,
      },
      { $queryRaw: queryRaw },
    );
    const persistIntent = jest.fn();
    (service as unknown as { persistIntent: typeof persistIntent }).persistIntent = persistIntent;

    await expect(service.recoverReplacementCleanupSources()).resolves.toBe(0);

    expect(persistIntent).not.toHaveBeenCalled();
    expect(queryRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '').toContain('marker."chat_id" IN');
  });

  it('adopts persisted chat rules cleanup state after a publish crash', async () => {
    const candidate = {
      sourceId: 'rules-state-1',
      source: 'chat_rules_state',
      chatId: 'chat-1',
      messageId: 'previous-rules-message-1',
      originBotId: 'bot-1',
      entityType: 'CHAT',
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      existingIntentId: null,
      existingIntentStatus: null,
      createdAt: new Date(),
    } as const;
    const executeRaw = jest.fn().mockResolvedValue(1);
    const { service } = createService(
      {},
      { $queryRaw: jest.fn().mockResolvedValue([candidate]), $executeRaw: executeRaw },
    );
    const persistIntent = jest.fn().mockResolvedValue({
      intentId: 'intent-rules-cleanup-1',
      rollout: 'execute',
      status: 'PENDING',
    });
    (service as unknown as { persistIntent: typeof persistIntent }).persistIntent = persistIntent;
    const enqueueCurrentWakeup = jest.fn().mockResolvedValue(undefined);
    (service as unknown as ServiceInternals).enqueueCurrentWakeup = enqueueCurrentWakeup;

    await expect(service.recoverReplacementCleanupSources()).resolves.toBe(1);

    const stateSql = executeRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    expect(stateSql).toContain('UPDATE "chat_rules"');
    expect(stateSql).toContain('"pending_cleanup_intent_id" =');
    expect(executeRaw.mock.calls[0]?.[0]?.values).toEqual(
      expect.arrayContaining(['intent-rules-cleanup-1', 'rules-state-1']),
    );
    expect(enqueueCurrentWakeup).toHaveBeenCalledWith('intent-rules-cleanup-1');
  });

  it('finalizes an in-progress marker when its existing intent already succeeded', async () => {
    const candidate = {
      sourceId: 'marker-success-1',
      source: 'channel_auto_post',
      chatId: 'channel-1',
      messageId: 'message-1',
      originBotId: null,
      entityType: 'CHANNEL',
      messageAuthorKind: 'user',
      routingPolicy: 'origin_only',
      existingIntentId: 'intent-success-1',
      existingIntentStatus: 'SUCCEEDED',
      createdAt: new Date(),
    } as const;
    const executeRaw = jest.fn().mockResolvedValue(1);
    const { service } = createService(
      {},
      { $queryRaw: jest.fn().mockResolvedValue([candidate]), $executeRaw: executeRaw },
    );
    const ensureIntent = jest.spyOn(service, 'ensureIntent');

    await expect(service.recoverReplacementCleanupSources()).resolves.toBe(1);

    expect(ensureIntent).not.toHaveBeenCalled();
    const syncSql = executeRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    expect(syncSql).toContain('"status" = CAST(\'SUCCEEDED\' AS "ChannelAutoPostAttachStatus")');
    expect(syncSql).toContain('"lock_token" = NULL');
    expect(syncSql).toContain('"cleanup_intent_id" =');
    expect(syncSql).toContain('"replacement_message_id" IS NOT NULL');
  });

  it('finalizes a rules audit when its already-absent intent has no origin bot', async () => {
    const candidate = {
      sourceId: 'audit-absent-1',
      source: 'chat_rules_republish',
      chatId: 'chat-1',
      messageId: 'previous-rules-message-1',
      originBotId: null,
      entityType: 'CHAT',
      messageAuthorKind: 'bot',
      routingPolicy: 'origin_only',
      existingIntentId: 'intent-absent-1',
      existingIntentStatus: 'ALREADY_ABSENT',
      createdAt: new Date(),
    } as const;
    const executeRaw = jest.fn().mockResolvedValue(1);
    const { service } = createService(
      {},
      { $queryRaw: jest.fn().mockResolvedValue([candidate]), $executeRaw: executeRaw },
    );
    const ensureIntent = jest.spyOn(service, 'ensureIntent');

    await expect(service.recoverReplacementCleanupSources()).resolves.toBe(1);

    expect(ensureIntent).not.toHaveBeenCalled();
    const syncQuery = executeRaw.mock.calls[0]?.[0];
    const syncSql = syncQuery?.strings?.join('?') ?? '';
    expect(syncSql).toContain('UPDATE "audit_logs"');
    expect(syncSql).toContain("'{previousCleanupOutcome}'");
    expect(syncSql).toContain('\'"confirmed"\'::jsonb');
    expect(syncQuery?.values).toEqual(
      expect.arrayContaining(['intent-absent-1', 'chat-1', 'previous-rules-message-1']),
    );
  });

  it('filters null-origin candidates without an intent before LIMIT and never creates one', async () => {
    const candidate = {
      sourceId: 'marker-without-origin-1',
      source: 'chat_auto_comment',
      chatId: 'chat-1',
      messageId: 'message-1',
      originBotId: null,
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      routingPolicy: 'origin_first',
      existingIntentId: null,
      existingIntentStatus: null,
      createdAt: new Date(),
    } as const;
    const queryRaw = jest.fn().mockResolvedValue([candidate]);
    const { service } = createService({}, { $queryRaw: queryRaw });
    const ensureIntent = jest.spyOn(service, 'ensureIntent');

    await expect(service.recoverReplacementCleanupSources()).resolves.toBe(0);

    expect(ensureIntent).not.toHaveBeenCalled();
    const sql = queryRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    const markerEligibility = sql.lastIndexOf('marker."bot_id" IS NOT NULL');
    const auditEligibility = sql.indexOf(
      ') IS NOT NULL\n              OR intent."status" IN',
      sql.indexOf('FROM "audit_logs"'),
    );
    const limit = sql.lastIndexOf('LIMIT');
    expect(sql.match(/marker\."bot_id" IS NOT NULL/g)).toHaveLength(2);
    expect(markerEligibility).toBeGreaterThanOrEqual(0);
    expect(auditEligibility).toBeGreaterThanOrEqual(0);
    expect(markerEligibility).toBeLessThan(limit);
    expect(auditEligibility).toBeLessThan(limit);
    expect(sql).toContain('CAST(\'SUCCEEDED\' AS "ModerationDeleteIntentStatus")');
    expect(sql).toContain('CAST(\'ALREADY_ABSENT\' AS "ModerationDeleteIntentStatus")');
  });

  it('adds the exact cleanup reason before adopting and waking an existing pending intent', async () => {
    const candidate = {
      sourceId: 'marker-pending-1',
      source: 'chat_auto_comment',
      chatId: 'chat-1',
      messageId: 'message-1',
      originBotId: 'bot-1',
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      routingPolicy: 'origin_first',
      existingIntentId: 'intent-pending-1',
      existingIntentStatus: 'PENDING',
      createdAt: new Date(),
    } as const;
    const executeRaw = jest.fn().mockResolvedValue(1);
    const { service } = createService(
      {},
      { $queryRaw: jest.fn().mockResolvedValue([candidate]), $executeRaw: executeRaw },
    );
    const persistIntent = jest.fn().mockResolvedValue({
      intentId: 'intent-pending-1',
      rollout: 'execute',
      status: 'PENDING',
    });
    (service as unknown as { persistIntent: typeof persistIntent }).persistIntent = persistIntent;
    const enqueueCurrentWakeup = jest.fn().mockResolvedValue(undefined);
    (service as unknown as ServiceInternals).enqueueCurrentWakeup = enqueueCurrentWakeup;

    await expect(service.recoverReplacementCleanupSources()).resolves.toBe(1);

    expect(persistIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        reasonKey: 'replacement-cleanup-recovery:chat_auto_comment:marker-pending-1',
        ruleCode: 'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP',
      }),
      false,
    );
    const adoptSql = executeRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    expect(adoptSql).toContain('"status" = CAST(\'SUCCEEDED\' AS "ChatAutoCommentAttachStatus")');
    expect(adoptSql).toContain('"lock_token" = NULL');
    expect(executeRaw.mock.calls[0]?.[0]?.values).toContain('intent-pending-1');
    expect(enqueueCurrentWakeup).toHaveBeenCalledWith('intent-pending-1');
  });

  it('bounds replacement recovery independently and gates expired retries by stable reasons', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const { service } = createService({}, { $queryRaw: queryRaw });

    await expect(service.recoverReplacementCleanupSources()).resolves.toBe(0);

    const query = queryRaw.mock.calls[0]?.[0];
    const sql = query?.strings?.join('?') ?? '';
    expect(query?.values).toContain(10);
    expect(sql).toContain('replacement-cleanup-recovery:channel_auto_post:');
    expect(sql).toContain('replacement-cleanup-recovery:chat_auto_comment:');
    expect(sql).toContain('replacement-cleanup-recovery:chat_rules_state:');
    expect(sql).toContain('replacement-cleanup-recovery:chat_rules_republish:');
    expect(sql).toContain('NOT EXISTS');
  });

  it('requires a typed current CHANNEL row for channel auto-post cleanup recovery', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const { service } = createService({}, { $queryRaw: queryRaw });

    await expect(service.recoverReplacementCleanupSources()).resolves.toBe(0);

    const sql = queryRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    const channelBranchEnd = sql.indexOf('UNION ALL');
    const channelBranchSql = sql.slice(0, channelBranchEnd);
    expect(channelBranchSql).toContain('FROM "channel_auto_post_attach_markers" marker');
    expect(channelBranchSql).toContain('INNER JOIN "chats" channel_chat');
    expect(channelBranchSql).toContain('ON channel_chat."id" = marker."chat_id"');
    expect(channelBranchSql).toContain(
      'channel_chat."entity_type" = CAST(\'CHANNEL\' AS "ChatEntityType")',
    );
  });

  it('does not purge intents still owned by unresolved replacement cleanup sources', async () => {
    const executeRaw = jest.fn().mockResolvedValue(0);
    const { service } = createService({}, { $executeRaw: executeRaw });

    await expect(service.purgeRetainedIntents()).resolves.toBe(0);

    const sql = executeRaw.mock.calls[0]?.[0]?.strings?.join('?') ?? '';
    expect(sql).toContain('FROM "channel_auto_post_attach_markers" marker');
    expect(sql).toContain('FROM "chat_auto_comment_attach_markers" marker');
    expect(sql).toContain('FROM "chat_rules" rules');
    expect(sql).toContain('marker."original_deleted" = false');
    expect(sql).toContain('rules."pending_cleanup_message_id" = intent."message_id"');
  });

  it('keeps the default hourly retention budget bounded above observed daily intake', async () => {
    const executeRaw = jest.fn().mockResolvedValue(100);
    const { service } = createService({}, { $executeRaw: executeRaw });

    const hourlyPurged = await service.purgeRetainedIntents();

    expect(hourlyPurged).toBe(4_000);
    expect(hourlyPurged * 24).toBeGreaterThan(58_000);
    expect(executeRaw).toHaveBeenCalledTimes(40);
    for (const [query] of executeRaw.mock.calls) {
      expect(query?.values).toContain(100);
    }
  });
});

describe('durable stop-word guard rejection diagnostics', () => {
  it.each(['certified', 'uncertified', 'uncertain_effect', 'lease_lost'] as const)(
    'records a capability deferral only after a certified owned wait (%s)',
    async (variant) => {
      const intent = {
        ...baseIntent,
        ...(variant === 'uncertain_effect'
          ? { deleteDispatchStartedAt: new Date(), deleteDispatchStartedBotId: 'bot-1' }
          : {}),
      };
      const tx = { $executeRaw: jest.fn().mockResolvedValue(variant === 'lease_lost' ? 0 : 1) };
      const { service } = createService(
        {},
        {
          $executeRaw: jest.fn().mockResolvedValue(1),
          $transaction: jest.fn(async (fn) => fn(tx)),
        },
      );
      Object.assign(service, {
        loadRequiredIntent: jest.fn().mockResolvedValue({
          ...intent,
          status: variant === 'uncertain_effect' ? 'AMBIGUOUS' : 'WAITING_CAPABILITY',
        }),
        enqueueWakeup: jest.fn(),
      });
      await (service as unknown as ServiceInternals).finishRetryableAttempt(intent, 'lease-1', {
        status: 'WAITING_CAPABILITY',
        statusCode: 403,
        errorCode: 'chat.denied',
        message: 'Access denied',
        retryDelayMs: 30_000,
        ...(variant === 'uncertified' ? {} : { certifiedCapabilityLoss: true as const }),
      });
      const event = tx.$executeRaw.mock.calls.find(([query]) =>
        query.strings.join('').includes('INSERT INTO "moderation_events"'),
      );
      expect(Boolean(event)).toBe(variant === 'certified');
      if (event)
        expect(event[0].values).toEqual(
          expect.arrayContaining([
            'permission_changed',
            'CAPABILITY_DEFERRED',
            'WAITING_CAPABILITY',
          ]),
        );
    },
  );

  it.each(['terminal', 'concurrent_reason', 'uncertain_effect', 'lease_lost'] as const)(
    'preserves the typed reason through aggregation and emits only for owned terminal rejection (%s)',
    async (variant) => {
      const reasons = [
        { ruleCode: 'MESSAGE_BLOCKED_WORD_DELETE', reasonKey: 'stop', score: 1, metadata: {} },
      ];
      const latest = {
        ...baseIntent,
        lastBotId: 'bot-1',
        ...(variant === 'uncertain_effect'
          ? { remoteDeleteSucceededAt: new Date(), remoteDeleteSucceededBotId: 'bot-1' }
          : {}),
      };
      const tx = {
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([{ id: latest.id }])
          .mockResolvedValueOnce([latest]),
        $executeRaw: jest.fn().mockResolvedValue(variant === 'lease_lost' ? 0 : 1),
        moderationDeleteIntentReason: {
          findMany: jest
            .fn()
            .mockResolvedValue(
              variant === 'concurrent_reason'
                ? [
                    ...reasons,
                    { ruleCode: 'INDEPENDENT_DELETE', reasonKey: 'fresh', score: 1, metadata: {} },
                  ]
                : reasons,
            ),
        },
      };
      const { service } = createService(
        {},
        {
          moderationDeleteIntentReason: { findMany: jest.fn().mockResolvedValue(reasons) },
          $transaction: jest.fn(async (fn) => fn(tx)),
        },
      );
      Object.assign(service, {
        stopWordsDeleteGuard: stopWordsGuardFixture(async () => {
          throw new StopWordsDeleteGuardRejectedError('policy_disabled');
        }),
        enqueueWakeup: jest.fn(),
        loadRequiredIntent: jest.fn().mockResolvedValue({ ...latest, status: 'FAILED_TERMINAL' }),
      });
      const internals = service as unknown as ServiceInternals;
      const rejection: unknown = await internals
        .authorizeGuardedUserDeleteReasons(latest, 'bot-1')
        .catch((error: unknown) => error);
      expect(rejection).toMatchObject({
        code: 'moderation_delete_reasons_no_longer_authorized',
        stopWordsRejectionReason: 'policy_disabled',
        reasonFingerprint: expect.any(String),
      });
      const details = internals.describeError(rejection, 'fallback');
      expect(details.errorCode).toBe('moderation_delete_reasons_no_longer_authorized');
      expect(JSON.parse(details.message)).toEqual({
        type: 'stop_words_guard_rejection',
        rejectionReason: 'policy_disabled',
      });
      const result = await internals.finishTerminalPreDispatchGuardRejection(
        latest,
        'lease-1',
        details,
        rejection,
      );
      expect(result.status).toBe(
        variant === 'concurrent_reason'
          ? 'RETRYABLE'
          : variant === 'uncertain_effect'
            ? 'AMBIGUOUS'
            : 'FAILED_TERMINAL',
      );
      const diagnostic = tx.$executeRaw.mock.calls.find(([query]) =>
        query.strings.join('').includes('INSERT INTO "moderation_events"'),
      );
      expect(Boolean(diagnostic)).toBe(variant === 'terminal');
      if (diagnostic) {
        expect(diagnostic[0].values).toContain('policy_disabled');
        expect(diagnostic[0].strings.join('')).toContain('LIMIT 65');
        expect(diagnostic[0].strings.join('')).toContain('ON CONFLICT ("id") DO NOTHING');
      }
    },
  );

  it.each([
    ['image_text_stop_list_policy_changed', 'policy_changed'],
    ['image_text_stop_list_message_changed', 'source_changed'],
    ['image_text_stop_list_runtime_disabled', 'runtime_disabled'],
    ['image_text_stop_list_deadline_expired', 'deadline_expired'],
  ])('serializes only a fixed OCR rejection reason for %s', (code, rejectionReason) => {
    const { service } = createService();
    const internals = service as unknown as ServiceInternals;
    const error = new ImageTextStopListDeleteIntentGuardRejectedError(
      code!,
      'Potential sensitive diagnostic',
    );
    expect(internals.describeError(error, 'fallback')).toMatchObject({
      errorCode: code,
      message: JSON.stringify({ type: 'stop_words_guard_rejection', rejectionReason }),
    });
    expect(
      internals.describeError(Object.assign(new Error('Remote failure'), { code }), 'fallback')
        .message,
    ).toBe('Remote failure');
  });
});

describe('persisted participant report execution boundaries', () => {
  it.each(['off', 'shadow', 'canary', 'on'])(
    'keeps reports independent of generic mode %s through reload and recovery',
    (mode) => {
      const { service } = createService({
        MODERATION_DELETE_INTENT_MODE: mode,
        PARTICIPANT_REPORTS_MODE: 'on',
      });
      expect(service.getRolloutForRule('chat-1', 'PARTICIPANT_REPORT_DELETE')).toBe('execute');
      expect(
        (service as unknown as ServiceInternals).isExecutionEnabledForIntent({
          ...baseIntent,
          reportDeleteReason: true,
          nonCommercialOcrDeleteReason: false,
        }),
      ).toBe(true);
      expect(
        (service as unknown as ServiceInternals).isExecutionEnabledForIntent({
          ...baseIntent,
          reportCounterCleanupReason: true,
          nonCommercialOcrDeleteReason: false,
        }),
      ).toBe(true);
      const internals = service as unknown as {
        buildSweepRolloutFilter(): { values: unknown[] };
        intentSelectSql(alias: string): { values: unknown[] };
      };
      expect(internals.buildSweepRolloutFilter().values).toContain('PARTICIPANT_REPORT_DELETE');
      expect(internals.intentSelectSql('intent').values).toContain('PARTICIPANT_REPORT_DELETE');
    },
  );
  it('rejects new sanctions outside the exact report canary but settles already persisted revoked work', () => {
    const { service } = createService({
      MODERATION_DELETE_INTENT_MODE: 'on',
      PARTICIPANT_REPORTS_MODE: 'canary',
      PARTICIPANT_REPORTS_CANARY_CHAT_IDS: 'other',
    });
    expect(service.getRolloutForRule('chat-1', 'PARTICIPANT_REPORT_DELETE')).toBe('off');
    expect(service.getRolloutForRule('chat-1', 'PARTICIPANT_REPORT_COUNTER_CLEANUP')).toBe(
      'execute',
    );
    expect(
      (service as unknown as ServiceInternals).isExecutionEnabledForIntent({
        ...baseIntent,
        reportDeleteReason: true,
      }),
    ).toBe(true);
  });
  it.each([false, true])(
    'does not use the revoked report itself as independent authority (independent=%s)',
    async (independent) => {
      const latest = {
        ...baseIntent,
        reportDeleteReason: true,
        nonCommercialOcrDeleteReason: false,
      };
      const tx = {
        $queryRaw: jest
          .fn()
          .mockResolvedValueOnce([{ id: latest.id }])
          .mockResolvedValueOnce([latest]),
        $executeRaw: jest.fn().mockResolvedValue(1),
        moderationDeleteIntentReason: {
          findMany: jest.fn().mockResolvedValue(independent ? [{ ruleCode: 'SPAM' }] : []),
        },
      };
      const { service, queue } = createService({}, { $transaction: jest.fn(async (fn) => fn(tx)) });
      const { ReportRejectedError } = await import('./reports/report.util');
      const error = new ReportRejectedError('revoked');
      const internals = service as unknown as {
        finishTerminalPreDispatchGuardRejection(
          intent: unknown,
          token: string,
          details: unknown,
          error: unknown,
        ): Promise<{ status: string }>;
      };
      const result = await internals.finishTerminalPreDispatchGuardRejection(
        latest,
        'lease-1',
        { errorCode: error.code, message: error.message, statusCode: null },
        error,
      );
      expect(result.status).toBe(independent ? 'RETRYABLE' : 'FAILED_TERMINAL');
      if (!independent) expect(queue.add).not.toHaveBeenCalled();
    },
  );
  it('does not promote recovered report-only history to urgent queue priority', async () => {
    const { service, queue } = createService();
    await (
      service as unknown as { enqueueWakeup(intent: unknown, priority: number): Promise<void> }
    ).enqueueWakeup(
      { ...baseIntent, status: 'PENDING', reportDeleteReason: true, reportHistoryOnly: true },
      1,
    );
    expect(queue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ priority: 10 }),
    );
  });
  it('retains background priority when report-only history is explicitly recovered', async () => {
    const { service, queue } = createService();
    jest
      .spyOn(
        service as unknown as { loadRequiredIntent(id: string): Promise<unknown> },
        'loadRequiredIntent',
      )
      .mockResolvedValue({
        ...baseIntent,
        status: 'PENDING',
        reportDeleteReason: true,
        reportHistoryOnly: true,
      });
    await service.enqueueCurrentIntentWakeupStrict(baseIntent.id);
    expect(queue.add).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ priority: 10 }),
    );
  });
  it('accepts lower-priority admission only for an exact historical report binding', async () => {
    const { service } = createService();
    await expect(
      service.ensureReportHistoryIntent({
        chatId: 'chat-1',
        messageId: 'target',
        ruleCode: 'PARTICIPANT_REPORT_DELETE',
        reasonKey: 'report',
        event: { metadata: { reportCaseId: 'case', reportTargetMessageId: 'target' } },
      }),
    ).rejects.toThrow('history binding');
  });
});
