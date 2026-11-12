import {
  MaxApiInternalRateLimitError,
  type MaxApiRateLimitScope,
} from './max-api-internal-rate-limit.error';
export { MaxApiInternalRateLimitError } from './max-api-internal-rate-limit.error';
import {
  MaxModerationApiBudget,
  MaxModerationApiBudgetError,
  type MaxMuteApiBudgetScope,
} from './max-moderation-api-budget';
import {
  HIGHER_PRIORITY_ACTIVITY_KEY,
  HIGHER_PRIORITY_ACTIVITY_UNAVAILABLE_KEY,
  HIGHER_PRIORITY_ACTIVITY_LEASE_MS,
  HIGHER_PRIORITY_ACTIVITY_RENEW_MS,
  HIGHER_PRIORITY_ACTIVITY_LIMIT,
  HIGHER_PRIORITY_ACTIVITY_RENEW_SCRIPT,
  RETENTION_PRIORITY_ADMISSION_LUA,
  RETENTION_PRIORITY_PERMIT_KEY,
  RETENTION_PRIORITY_RESERVATION_MARKER,
  RETENTION_PRIORITY_TRAFFIC_TTL_SEC,
  RETENTION_PRIORITY_VERSION,
  retentionPriorityQueueKeys,
  retentionPriorityTrafficKey,
  type RetentionPriorityReservationOptions,
} from './retention-priority-admission';
import { performMaxHttpRequest } from './max-http-request';
import { StorageRuntimeMetricsService } from '../system/storage-runtime-metrics.service';
import { optimizationElapsed, optimizationNow } from '../system/optimization-runtime-metrics';
import {
  beginMaxHttpFailureRequest,
  classifyMaxHttpFailureEndpoint,
  closeMaxHttpFailureOwner,
  consumeMaxHttpOutcome,
  createMaxHttpFailureOwner,
  mapMaxHttpOutcome,
  readMaxHttpFailureAssociation,
  type MaxHttpFailureAssociation,
  type MaxHttpFailureOwner,
  type MaxHttpOutcome,
} from './max-http-failure-association';
import {
  projectMaxActionFailureDiagnostic,
  type MaxActionFailureFacts,
} from './max-action-failure-diagnostic';
import { MaxActionFailureLog } from './max-action-failure-log';
import {
  observeMaxSendAdmission,
  observeMaxSendAcknowledgement,
  runWithMaxSendHttpObservation,
} from './max-send-observation';
import {
  certifyMaxSendCapacityDeferral,
  markMaxApiCapacityRefusal,
  runWithMaxSendCapacityAttempt,
} from './max-send-capacity-deferral';
import { readMaxChatAvatar } from './max-chat-avatar';
import { readMaxRetryAfterMs } from './max-retry-after';
import {
  isMaxMutationOutcomeAmbiguous,
  markMaxMessageSendAttempted,
  wasMaxMessageSendAttempted,
} from './max-mutation-outcome.util';
import { HttpService } from '@nestjs/axios';
import { buildMaxActionIdempotencyKey } from './max-action-idempotency';
import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UnrecoverableError, type Job, type Queue } from 'bullmq';
import FormData from 'form-data';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { MaxExecutionPurpose, MaxExecutionRouteProof } from './max-execution-route-proof';
import { isDeepStrictEqual } from 'node:util';
import { readMaxMemberActivity } from './max-member-activity.util';
import {
  hasExplicitManagedEntityPrivilege,
  hasExplicitManagedEntityNonPrivilege,
  type ManagedEntityExplicitActivation,
} from './managed-entity-activation.util';
import { hasIncompleteManagedEntityPermissionEvidence } from './managed-entity-passive-access.util';
import { MarketplaceStateService } from '../integrations/marketplace/marketplace-state.service';
import {
  appendMarketplacePublicationButton,
  appendMarketplaceEditableAttachments,
  isMarketplacePublicationTarget,
  type MarketplacePublicationIntent,
} from './marketplace-publication-button';
import { assertMaxMemberRestoreAvailable } from './max-member-restore-capability';
import {
  refreshExistingInlineKeyboardText,
  type MaxInlineKeyboardTextRefresh,
} from './max-inline-keyboard-text-refresh';
import { firstValueFrom } from 'rxjs';
import Redis from 'ioredis';
import {
  channelDialogButtonPresentationKey,
  readInternalChannelDialogButtonIdentity,
  readInternalChannelDialogButtonIdentitiesFromMessage,
  type InternalChannelDialogButtonIdentity,
} from '../common/channel-dialog-button-identity.util';
import { isPrivateDirectChatId } from '../common/chat-id.util';
import {
  isMaxTextMarkupType,
  normalizeMaxUserMentionLink,
  renderMaxTextMarkupAsHtml,
  renderMaxTextMarkupAsMarkdown,
  type MaxTextMarkup,
} from '../common/max-text-markup.util';
import { resolveMaxUserDisplayName } from '../common/max-user-display-name.util';
import type { QueueJobEnvelope, QueueRetryPolicyName } from '../common/queue-job-envelope';
import {
  extractPublisherRemoteIdentity,
  type PublisherRemoteIdentity,
} from '../publisher/publisher-identity-attestation.util';
import { ActionHealthService, type ActionHealthLane } from '../system/action-health.service';
import { RuntimeDiagnosticsService } from '../system/runtime-diagnostics.service';
import { MaxBotContextService } from './max-bot-context.service';
import { MaxExactMessageLookupMissingIdError } from './max-exact-message-lookup.error';
import {
  assertLegacyActionAllowed,
  WebhookLegacyHoldService,
  WebhookLegacyHoldRejectedError,
} from '../webhook/webhook-legacy-hold.service';
import {
  MaxBotLinkService,
  type MaxBotRoute,
  type MaxBotRouteRequest,
} from './max-bot-link.service';
import { MaxBotRegistryService, type MaxBotDefinition } from './max-bot-registry.service';
import {
  hasMaxModerationRuleNoticeProof,
  MaxModerationRuleNoticeGuardService,
} from './max-moderation-rule-notice.guard';
import {
  isMaxRequiredSubscriptionNoticeAction,
  MaxRequiredSubscriptionNoticeGuardService,
} from './max-required-subscription-notice.guard';
import {
  isMaxDuplicateNoticeAction,
  MaxDuplicateNoticeGuardService,
} from './max-duplicate-notice.guard';
import {
  assertMaxModerationNoticeEnvelope,
  requiresMaxModerationNoticeEnvelope,
} from './max-moderation-notice-envelope';
import type { MaxBotLifecycleState } from './max-bot-config.util';
import { canExecuteActionsForBotState } from './max-bot-state.util';
import { normalizeMaxInlineKeyboardButtons } from './max-inline-keyboard-layout';
import { normalizeEditableContactPayload } from './max-editable-contact';
import {
  assertEditableAttachmentsPreserved,
  readStrictEditableAttachments,
} from './max-editable-message-preservation';
import {
  markMaxMemberMutationAttempted,
  markMaxMemberMutationConfirmed,
  wasMaxMemberMutationAttempted,
  wasMaxMemberMutationConfirmed,
} from './max-member-error.util';
import {
  normalizeMaxRoutedMutationCanaryPercent,
  normalizeMaxRoutedMutationMode,
  parseMaxRoutedMutationCanaryEntityIds,
  shouldEnforceMaxRoutedMutation,
  type MaxRoutedMutationMode,
} from './max-routed-mutation-rollout.util';
import { isAmbiguousMaxMutationError, isAmbiguousMaxSendError } from './max-send-ambiguity.util';
import type { MaxFutureNightStickyRouteProbe } from './max-send-route-sticky-probe';
import {
  MAX_AUDIO_UPLOAD_MAX_BYTES,
  MAX_FILE_UPLOAD_MAX_BYTES,
  MAX_IMAGE_UPLOAD_MAX_BYTES,
  MAX_VIDEO_UPLOAD_MAX_BYTES,
} from './max-video-upload.constants';
import { extractMaxVideoDownloadUrl } from './max-video-download-url.util';
import { MaxMediaUploadValidationCache } from './max-media-upload-validation-cache';
import type {
  MaxValidatedImageUpload,
  MaxValidatedMediaUpload,
  MaxValidatedVideoUpload,
} from './max-media-upload-validation';
import {
  appendMaxApiCounterIncrement,
  type MaxApiMetricsStorageLayout,
} from './max-api-counter-storage';
import {
  buildMaxApiServiceBotClassMetricKey,
  buildMaxApiServiceStackClassMetricKey,
  buildMaxApiSourceMetricKey,
  MAX_API_SOURCE_DIMENSION_CATALOG_KEY,
  normalizeMaxApiRateLimitServiceScope,
  serializeMaxApiSourceMetricDimension,
} from './max-api-metrics-key.util';
import {
  markMaxSendDispatchLedgerFinalized,
  MaxActionLedgerService,
  type MaxCompletedSendDispatch,
} from './max-action-ledger.service';
import {
  markMaxPreDispatchGuardRejected,
  MAX_DELETE_PRE_DISPATCH_GUARD_REJECTED_CODE,
  MAX_EDIT_PRE_DISPATCH_GUARD_REJECTED_CODE,
  MAX_MEMBER_PRE_DISPATCH_GUARD_REJECTED_CODE,
  MAX_SEND_PRE_DISPATCH_GUARD_REJECTED_CODE,
  wasMaxPreDispatchGuardRejected,
  usesMaxFinalAuthorityCheckpoint,
  withMaxFinalAuthorityCheckpoint,
} from './max-action-pre-dispatch-guard';
import {
  MAX_ACTION_BACKGROUND_QUEUE,
  MAX_ACTION_CRITICAL_QUEUE,
  MAX_ACTION_INTERACTIVE_QUEUE,
  MAX_ACTION_LEGACY_QUEUE,
  resolveMaxActionQueueName,
} from './max-action.queue';
import {
  isMaxSendAutoDeleteMarker,
  MAX_SEND_AUTO_DELETE_CONFIRMATION_KINDS,
  MAX_SEND_AUTO_DELETE_MARKER_VERSION,
  type MaxSendAutoDeleteConfirmationKind,
  type MaxSendAutoDeleteMarker,
} from './max-send-auto-delete-marker';
import { createMaxSendAutoDeleteVerificationError } from './max-send-auto-delete-verification-error';

export {
  MAX_SEND_AUTO_DELETE_CONFIRMATION_KINDS,
  MAX_SEND_AUTO_DELETE_MARKER_VERSION,
  type MaxSendAutoDeleteConfirmationKind,
  type MaxSendAutoDeleteMarker,
} from './max-send-auto-delete-marker';
export { MAX_SEND_AUTO_DELETE_VERIFICATION_UNKNOWN_ERROR_CODE } from './max-send-auto-delete-verification-error';

export type MaxBotChat = {
  chatId: string;
  title: string | null;
  lastEventTime: number | null;
  entityType: 'chat' | 'channel';
  link: string | null;
  avatarUrl: string | null;
  botId?: string | null;
  botIds?: string[];
};

export type MaxChatSnapshot = {
  avatarState?: 'unknown' | 'present' | 'absent';
  chatId: string;
  title: string | null;
  description?: string | null;
  participantsCount: number | null;
  status: string | null;
  isPublic: boolean | null;
  link: string | null;
  lastEventAt: string | null;
  entityType: 'chat' | 'channel';
  avatarUrl: string | null;
};

export type MaxChannelMessageSnapshot = {
  chatId: string;
  messageId: string;
  publishedAt: string;
  publishedAtMs: number;
  url: string | null;
  previewUrl: string | null;
  views: number | null;
  reactionsTotal: number | null;
  reactions: MaxChannelMessageReaction[];
};

// `absent` is reserved for an independently proven absence. MAX's direct-message 404 is
// ambiguous with access loss and must surface as an error instead.
export type MaxExactMessagePresence = 'present' | 'absent';

export type MaxExactMessagePresenceRequest = {
  chatId: string;
  messageId: string;
};

export type MaxExactMessagePresenceResult =
  | (MaxExactMessagePresenceRequest & { presence: MaxExactMessagePresence })
  | (MaxExactMessagePresenceRequest & { error: unknown });

type MaxExactMessagePresenceOutcome = { presence: MaxExactMessagePresence } | { error: unknown };

export type MaxChannelMessageReaction = {
  emoji: string;
  count: number;
};

export type MaxWebhookSubscription = {
  url: string;
  updateTypes: string[];
};

export type MaxChatMemberProfile = {
  userId: string;
  displayName: string | null;
  username: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
};

export type MaxChatMemberAccess = {
  userId: string | null;
  /** Absent in old cache rows; report eligibility requires a fresh join_time. */
  joinedAtMs?: number | null;
  /** Optional only for cache compatibility with rows written before bot-type propagation. */
  isBot?: boolean | null;
  isAdmin: boolean;
  isOwner: boolean;
  permissions: string[];
  permissionsKnown?: boolean;
  explicitPrivilegeEvidence?: boolean;
  explicitNonPrivilegeEvidence?: boolean;
  activationCapabilityCeiling?: readonly string[];
};

/** The narrow admin roster shape used by recipient selection paths. */
export type MaxChatAdminMember = {
  userId: string;
  isBot: boolean;
};

export type MaxChatMemberRole = 'owner' | 'admin' | 'member';
export type MaxChatRosterUnavailableReason = 'deleted' | 'blocked' | 'deactivated' | 'suspended';

export type MaxChatRosterMember = {
  userId: string;
  displayName: string | null;
  username: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  role: MaxChatMemberRole;
  isBot: boolean;
  unavailableReason: MaxChatRosterUnavailableReason | null;
  lastMaxActivityAt?: string | null;
  activityCheckedAt?: string | null;
};

export type MaxChatMembersPage = {
  items: MaxChatRosterMember[];
  nextMarker: string | null;
};

export type MaxApiTrafficClass = 'critical' | 'interactive' | 'background';

// FLAG: Descriptors contain no active owner. Each controlling wrapper owns one
// invocation, including early admission failure; values and errors stay separate.
const MAX_HTTP_ASSOCIATED_OPERATION = Symbol('max-http-associated-operation');
type MaxHttpOperation<T> =
  | (() => Promise<T>)
  | Readonly<{
      [MAX_HTTP_ASSOCIATED_OPERATION]: (owner: MaxHttpFailureOwner) => Promise<MaxHttpOutcome<T>>;
    }>;

function associatedMaxHttpOperation<T>(
  operation: (owner: MaxHttpFailureOwner) => Promise<MaxHttpOutcome<T>>,
): MaxHttpOperation<T> {
  return { [MAX_HTTP_ASSOCIATED_OPERATION]: operation };
}

function scopeMaxHttpOperation<T>(
  operation: MaxHttpOperation<T>,
  scope: <R>(run: () => Promise<R>) => Promise<R>,
): MaxHttpOperation<T> {
  return typeof operation === 'function'
    ? () => scope(operation)
    : associatedMaxHttpOperation((owner) =>
        scope(() => operation[MAX_HTTP_ASSOCIATED_OPERATION](owner)),
      );
}

type MaxObservedReadHttp429Binding =
  | { kind: 'exact_message'; chatId: string; messageId: string; botId: string }
  | { kind: 'chat_member'; chatId: string; userId: string; botId: string };
type MaxReadFailureObserver = (
  error: unknown,
  association: MaxHttpFailureAssociation | null,
  botId: string,
) => void;
const observedReadHttp429Errors = new WeakMap<
  object,
  { binding: MaxObservedReadHttp429Binding; observer: MaxReadFailureObserver }
>();

function isUnattemptedHttp429ReadFailure(error: unknown): error is object {
  try {
    const failure = error as {
      response?: { status?: unknown; config?: { method?: unknown } };
      config?: { method?: unknown };
    } | null;
    const methods = [failure?.config?.method, failure?.response?.config?.method];
    return Boolean(
      error &&
      typeof error === 'object' &&
      failure?.response?.status === 429 &&
      methods.every(
        (method) =>
          method === undefined ||
          (typeof method === 'string' && method.trim().toLowerCase() === 'get'),
      ) &&
      !wasMaxMessageSendAttempted(error) &&
      !wasMaxMemberMutationAttempted(error) &&
      !isMaxMutationOutcomeAmbiguous(error),
    );
  } catch {
    return false;
  }
}

function observeBoundReadHttp429(binding: MaxObservedReadHttp429Binding): MaxReadFailureObserver {
  const observer: MaxReadFailureObserver = (error, association, botId) => {
    const facts = readMaxHttpFailureAssociation(association);
    if (
      botId === binding.botId &&
      isUnattemptedHttp429ReadFailure(error) &&
      facts?.method === 'get' &&
      facts.phase === 'adapter_rejection' &&
      (binding.kind === 'exact_message'
        ? facts.endpointKind === 'messages' || facts.endpointKind === 'message'
        : facts.endpointKind === 'chat_members')
    )
      observedReadHttp429Errors.set(error, { binding, observer });
  };
  return observer;
}

function discardForeignReadHttp429(error: unknown, observer: MaxReadFailureObserver): void {
  if (
    error &&
    typeof error === 'object' &&
    observedReadHttp429Errors.get(error)?.observer !== observer
  )
    observedReadHttp429Errors.delete(error);
}

function consumeBoundReadHttp429(error: unknown, expected: MaxObservedReadHttp429Binding): boolean {
  if (!error || typeof error !== 'object') return false;
  const evidence = observedReadHttp429Errors.get(error)?.binding;
  // FLAG: Only this exact invocation's observed HTTP rejection can nominate an initial
  // no-effect continuation. Consume even a mismatched attempt; copied errors carry no proof.
  observedReadHttp429Errors.delete(error);
  return Boolean(
    evidence &&
    isUnattemptedHttp429ReadFailure(error) &&
    evidence.kind === expected.kind &&
    evidence.chatId === expected.chatId.trim() &&
    evidence.botId === expected.botId.trim() &&
    (evidence.kind === 'exact_message' && expected.kind === 'exact_message'
      ? evidence.messageId === expected.messageId.trim()
      : evidence.kind === 'chat_member' &&
        expected.kind === 'chat_member' &&
        evidence.userId === expected.userId.trim()),
  );
}

export function consumeMaxExactMessageLookupHttp429(
  error: unknown,
  binding: { chatId: string; messageId: string; botId: string },
): boolean {
  return consumeBoundReadHttp429(error, { ...binding, kind: 'exact_message' });
}

export function consumeMaxChatMemberAccessHttp429(
  error: unknown,
  binding: { chatId: string; userId: string; botId: string },
): boolean {
  return consumeBoundReadHttp429(error, { ...binding, kind: 'chat_member' });
}

type MaxMessageMutationOperation = 'send' | 'edit' | 'delete' | 'answer';

type MaxMessageMutationRateLimitScope = {
  operation: MaxMessageMutationOperation;
  entityId: string | null;
};

export type MaxPublishedMessage = {
  messageId: string;
  url: string | null;
  chatId?: string | null;
  recoveredSendDispatch?: {
    dispatchBotId: string | null;
  };
};

const MAX_RECOVERED_SEND_DISPATCH_RESPONSE = Symbol('max-recovered-send-dispatch-response');
const MAX_SEND_DISPATCH_COMPLETION_RESPONSE = Symbol('max-send-dispatch-completion-response');
type MaxQueuedSendResponse = Record<string, unknown> & {
  [MAX_RECOVERED_SEND_DISPATCH_RESPONSE]?: {
    dispatchBotId: string | null;
    completedAt: Date | null;
  };
  [MAX_SEND_DISPATCH_COMPLETION_RESPONSE]?: MaxCompletedSendDispatch;
};

type MaxMessageMarkup = MaxTextMarkup;

const MAX_CHAT_POST_LINK_BASE_URL = 'https://max.ru';
const DEFAULT_SUCCESS_FALSE_STATUS = 200;
const MAX_UPLOAD_BINARY_TIMEOUT_MS = 30_000;
const MAX_PRIORITY_ACTIVITY_RELEASE_DRAIN_MS = 1_000;
const MAX_UPLOAD_FILENAME_MAX_LENGTH = 180;
const MAX_RESUMABLE_VIDEO_UPLOAD_CHUNK_BYTES = 4 * 1_024 * 1_024;
const MAX_RESUMABLE_VIDEO_UPLOAD_SESSION_ATTEMPTS = 2;
const MAX_LIST_BOT_CHATS_UNSUPPORTED_IN_PRODUCTION =
  'MAX API GET /chats is not supported in production; use webhook/subscription managed chat catalog instead. See https://dev.max.ru/docs-api/methods/GET/chats';
export { wasMaxMessageSendAttempted } from './max-mutation-outcome.util';

export {
  markMaxMemberMutationAttempted,
  markMaxMemberMutationConfirmed,
  wasMaxMemberMutationAttempted,
  wasMaxMemberMutationConfirmed,
} from './max-member-error.util';

export class MaxApiRequestRejectedError extends Error {
  readonly response: {
    status: number;
    data: unknown;
  };

  constructor(status: number, payload: unknown, message: string) {
    super(message);
    this.name = 'MaxApiRequestRejectedError';
    this.response = {
      status,
      data: payload,
    };
  }
}

export class MaxApiCircuitOpenError extends Error {
  readonly code = 'MAX_API_CIRCUIT_OPEN';
  readonly preDispatch = true;

  constructor(
    readonly botId: string,
    readonly retryAfterMs: number,
  ) {
    super('MAX API circuit breaker is open');
    this.name = 'MaxApiCircuitOpenError';
  }
}

export function isMaxApiCircuitOpenError(error: unknown): error is MaxApiCircuitOpenError {
  return (
    error instanceof MaxApiCircuitOpenError ||
    (Boolean(error) &&
      typeof error === 'object' &&
      (error as { code?: unknown }).code === 'MAX_API_CIRCUIT_OPEN' &&
      (error as { preDispatch?: unknown }).preDispatch === true)
  );
}

export type MaxButtonIntent = 'default' | 'positive' | 'negative';

export type MaxLinkButton = {
  type?: 'link';
  text: string;
  url: string;
};

export type MaxCallbackButton = {
  type: 'callback';
  text: string;
  payload: string;
  intent?: MaxButtonIntent;
};

export type MaxOpenAppButton = {
  type: 'open_app';
  text: string;
  webApp?: string | null;
  contactId?: string | number | null;
};

export type MaxRequestContactButton = {
  type: 'request_contact';
  text: string;
};

export type MaxRequestGeoLocationButton = {
  type: 'request_geo_location';
  text: string;
  quick?: boolean;
};

export type MaxClipboardButton = {
  type: 'clipboard';
  text: string;
  payload: string;
};

export type MaxChatButton = {
  type: 'chat';
  text: string;
  chatTitle: string;
  chatDescription?: string | null;
  startPayload?: string | null;
  uuid?: string | null;
};

export type MaxReplyMessageLink = {
  type: 'reply';
  mid: string;
};

export type MaxTextFormat = 'markdown' | 'html';
export type MaxMediaAttachmentType = 'image' | 'video' | 'audio' | 'file';
export type MaxAttachmentPayload = {
  type: MaxMediaAttachmentType;
  payload: Record<string, unknown>;
};

export type MaxMessageButton =
  | MaxLinkButton
  | MaxCallbackButton
  | MaxOpenAppButton
  | MaxRequestContactButton
  | MaxRequestGeoLocationButton
  | MaxClipboardButton
  | MaxChatButton;

export type MaxSendMessageOptions = {
  /** Trusted message purpose; never accepted from HTTP input or applied to edits/DMs. */
  marketplacePublication?: MarketplacePublicationIntent;
  button?: MaxLinkButton;
  buttons?: MaxMessageButton[][];
  imagePayload?: Record<string, unknown>;
  attachments?: MaxAttachmentPayload[];
  messageLink?: MaxReplyMessageLink | null;
  textFormat?: MaxTextFormat;
  debugContext?: {
    screen?: string;
    action?: string;
  };
};

type MaxEditableMessageOptions = Pick<
  MaxSendMessageOptions,
  'button' | 'buttons' | 'debugContext' | 'textFormat'
> & {
  /** Trusted channel decoration only. This is not an HTTP request field. */
  marketplaceChannelPost?: { entityId: string; sourceAt: string; only: boolean };
  appendNewInlineKeyboardRows?: boolean;
  mergeExistingInlineKeyboard?: boolean;
  preserveExistingChannelDialogButtons?: boolean;
  preserveExistingInlineKeyboard?: boolean;
  replaceCallbackPayloadPrefixes?: readonly string[];
  beforeEditMutation?: (beforeFinalAuthority?: () => Promise<void>) => Promise<void>;
  refreshButtonText?: MaxInlineKeyboardTextRefresh;
  prepareInlineKeyboard?: (
    message: Record<string, unknown> | null,
  ) => Promise<MaxMessageButton[][] | null>;
  prepareMessageText?: (
    message: Record<string, unknown> | null,
  ) => Promise<{ text: string | null; textFormat?: MaxTextFormat } | null>;
  expectedSourceText?: string;
  expectedSourceMarkup?: readonly MaxTextMarkup[];
  expectedSourceAttachmentTypes?: readonly string[];
  requireAllAttachmentsPreserved?: boolean;
};

type MaxImmediateSendMessageOptions = MaxSendMessageOptions & {
  beforeSend?: (beforeFinalAuthority?: () => Promise<void>) => Promise<void>;
};

export type MaxCustomMessagePayload = {
  text?: string;
  attachments?: Record<string, unknown>[];
  messageLink?: MaxReplyMessageLink | null;
  textFormat?: MaxTextFormat;
};

export type MaxCallbackMessageEdit = {
  messageId?: string;
  text: string;
  options?: MaxSendMessageOptions & MaxEditableMessageOptions;
};

export type MaxActionType =
  | 'DELETE_MESSAGE'
  | 'SEND_MESSAGE'
  | 'KICK_MEMBER'
  | 'BAN_MEMBER'
  | 'UNBAN_MEMBER'
  | 'TRY_UNBAN_MEMBER'
  | 'NOTIFY_MODERATORS';

export type MaxActionRoutingMetadata = {
  purpose:
    | Extract<MaxBotRouteRequest['purpose'], 'send_message' | 'moderation_action'>
    | 'channel_poll'
    | 'publisher_exact_send';
  primaryBotId?: string | null;
  reason?: string | null;
  action?: 'delete_message' | 'moderate_member';
  routingVersion?: number | null;
  sendRouteHalfOpenProbe?: 'publication_exact_verification';
  sendRouteStickyProbe?: MaxFutureNightStickyRouteProbe;
  requiredBotId?: string;
};

export type MaxActionLedgerContextValue =
  | string
  | number
  | boolean
  | null
  | MaxActionLedgerContextValue[]
  | { [key: string]: MaxActionLedgerContextValue };

export type MaxActionLedgerContext = {
  [key: string]: MaxActionLedgerContextValue;
};

export type MaxActionJob = QueueJobEnvelope<
  {
    actionType: MaxActionType;
    chatId: string;
    botId?: string;
    candidateBotIds?: string[];
    routing?: MaxActionRoutingMetadata;
    attemptedBotIds?: string[];
    trafficClass?: MaxApiTrafficClass;
    actionHealthLane?: ActionHealthLane;
    sourceTag?: string;
    timeoutMs?: number;
    messageId?: string;
    userId?: string;
    text?: string;
    options?: MaxSendMessageOptions;
    ledgerContext?: MaxActionLedgerContext;
    autoDeleteDelayMs?: number;
    sendAutoDelete?: MaxSendAutoDeleteMarker;
    ignoreFailureMetricStatuses?: number[];
    attempt: number;
    idempotencyKey: string;
    createdAt: string;
    scheduledFor?: string;
  },
  {
    retryPolicyName?: Extract<QueueRetryPolicyName, 'max-action'>;
  }
>;

export type MaxActionDispatchOptions = {
  delayMs?: number;
  immediate?: boolean;
  /** FLAG: Set only when this immediate attempt has no caller or durable retry owner. */
  immediateFailurePolicy?: 'terminal';
  /** Ephemeral guard evaluated after routing and ledger work, immediately before send HTTP. */
  beforeImmediateSendMutation?: (revalidateRoute?: () => Promise<void>) => Promise<void>;
  /** Ephemeral guard evaluated after routing and ledger work, immediately before delete HTTP. */
  beforeImmediateDeleteMutation?:
    | (() => Promise<void>)
    | ((beforeFinalAuthority?: () => Promise<void>) => Promise<void>);
  /** Ephemeral guard evaluated after routing and ledger work, immediately before member HTTP. */
  beforeImmediateMemberMutation?: (revalidateRoute?: () => Promise<void>) => Promise<void>;
  autoDeleteDelayMs?: number;
  /**
   * Caller-provided logical dedupe key. Routed actions are scoped by action only;
   * explicitly bot-bound actions retain the legacy bot/action scope.
   */
  idempotencyKey?: string | null;
  trafficClass?: MaxApiTrafficClass;
  actionHealthLane?: ActionHealthLane;
  sourceTag?: string;
  timeoutMs?: number;
  ignoreFailureMetricStatuses?: readonly number[];
  botId?: string;
  candidateBotIds?: readonly string[];
  routing?: MaxActionRoutingMetadata;
  ledgerContext?: MaxActionLedgerContext;
};

type MaxActionExecutionOptions = {
  beforeDeleteMutation?: MaxActionDispatchOptions['beforeImmediateDeleteMutation'];
  beforeMemberMutation?: (revalidateRoute?: () => Promise<void>) => Promise<void>;
  beforeSendMutation?: (revalidateRoute?: () => Promise<void>) => Promise<void>;
};

type MaxApiRequestOptions = {
  boundObject?: import('./max-bound-message').MaxBoundObjectReference;
  explicitActivation?: ManagedEntityExplicitActivation;
  trafficClass?: MaxApiTrafficClass;
  actionHealthLane?: ActionHealthLane;
  sourceTag?: string;
  bypassCache?: boolean;
  ignoreFailureMetricStatuses?: readonly number[];
  timeoutMs?: number;
  botId?: string;
  forceUpsert?: boolean;
  replaceUpdateTypes?: boolean;
  rateLimitEntityId?: string;
};

type MaxCallbackAnswerRequestOptions = MaxApiRequestOptions & {
  /** Runs after preparation, before final request admission; a local guard may still refuse dispatch. */
  onDispatchAttempt?: () => void | Promise<void>;
};

export const MAX_API_SOURCE_TAGS = {
  MESSAGE_RETENTION: 'message_retention',
  MANAGED_REFRESH: 'managed_refresh',
  MODERATION_DELETE: 'moderation_delete',
  MODERATION_SANCTION: 'moderation_sanction',
  MODERATION_NOTICE: 'moderation_notice',
  NIGHT_MODE_TRANSITION: 'night_mode_transition',
  PARTICIPANT_SEARCH: 'participant_search',
  PARTICIPANT_CLEANUP: 'participant_cleanup',
  SETTINGS_BOT_PROFILE: 'settings_bot_profile',
  MANAGED_HANDSHAKE: 'managed_handshake',
  CHAT_RULES: 'chat_rules',
  MANAGED_POLL: 'managed_poll',
  MANAGED_GIVEAWAY: 'managed_giveaway',
  GIVEAWAY_DRAW_BACKGROUND: 'giveaway_draw_background',
  MANAGED_BROADCAST: 'managed_broadcast',
  CHANNEL_AUTO_POST: 'channel_auto_post',
  COMMENT_NOTIFICATION: 'comment_notification',
  SUGGESTION_DELIVERY: 'suggestion_delivery',
  CALLBACK_ANSWER: 'callback_answer',
  KARAVAN_STOREFRONT_RELAY: 'karavan_storefront_relay',
  VK_PARSING: 'vk_parsing',
  PUBLISHER_POST_IMPORT: 'publisher_post_import',
  PUBLISHER_START: 'publisher_start',
  PUBLISHER_AUTO_REPLY: 'publisher_auto_reply',
  CHANNEL_STATS_SYNC: 'channel_stats_sync',
  WEBHOOK_SUBSCRIPTION_RECONCILE: 'webhook_subscription_reconcile',
  REQUIRED_SUBSCRIPTION_MEMBERSHIP: 'required_subscription_membership',
  REQUIRED_SUBSCRIPTION_METADATA: 'required_subscription_metadata',
  PHOTO_DUPLICATE_ADMIN_CHECK: 'photo_duplicate_admin_check',
} as const;

const MAX_ACTION_DELAY_MS = 14 * 24 * 60 * 60 * 1000;
export { normalizeMaxActionIdempotencyKeyPart } from './max-action-idempotency';

const LIVE_MAX_ACTION_JOB_STATES = new Set([
  'active',
  'delayed',
  'prioritized',
  'waiting',
  'waiting-children',
]);
type MaxActionQueueJobObservation = {
  state: 'missing' | 'live' | 'final' | 'unknown';
  enqueuedAt?: Date;
};
const DEFAULT_MAX_API_GLOBAL_RPS = 30;
const DEFAULT_MAX_API_LIST_BOT_CHATS_CACHE_SEC = 15;
const DEFAULT_MAX_API_CHAT_SNAPSHOT_CACHE_SEC = 10;
const DEFAULT_MAX_API_CHAT_MEMBER_ACCESS_ADMIN_CACHE_SEC = 300;
const DEFAULT_MAX_API_CHAT_MEMBER_ACCESS_MEMBER_CACHE_SEC = 45;
const DEFAULT_MAX_API_CHAT_ADMIN_IDS_CACHE_SEC = 60;
const DEFAULT_MAX_API_CRITICAL_RATE_LIMIT_WAIT_MS = 1_000;
const DEFAULT_MAX_API_MODERATION_DELETE_RATE_LIMIT_WAIT_MS = 2_500;
const DEFAULT_MAX_API_INTERACTIVE_RATE_LIMIT_WAIT_MS = 1_500;
const DEFAULT_MAX_API_BACKGROUND_RATE_LIMIT_WAIT_MS = 5_000;
const DEFAULT_MAX_API_RATE_LIMIT_RETRY_FLOOR_MS = 25;
const DEFAULT_MAX_API_MANAGED_REFRESH_RPS = 2;
const MAX_MESSAGE_MUTATION_RPS = 2;
const MAX_API_MESSAGE_IDS_BATCH_SIZE = 50;
const MAX_API_DIRECT_MESSAGE_LOOKUP_CONCURRENCY = 4;
const MAX_API_LIST_BOT_CHATS_PAGE_SAFETY_CAP = 10_000;
const MAX_API_CHAT_ADMIN_MEMBERS_PAGE_SAFETY_CAP = 10_000;
const MAX_API_RATE_LIMIT_SLOT_TTL_MS = 2_000;
const MAX_API_SOURCE_METRICS_TTL_SEC = 6 * 60 * 60;
const MAX_API_SERVICE_CAPACITY_METRICS_TTL_SEC = 2 * 60;
const MAX_API_RATE_LIMIT_OUTCOME_KEY_PREFIX = 'maxapi:rate-limit:v1';
const MAX_API_RATE_LIMIT_LOG_COALESCE_MS = 60_000;
const MAX_API_USAGE_METRICS_IN_FLIGHT_LIMIT = 128;
const MAX_API_CIRCUIT_KEY_PREFIX = 'maxapi:circuit:v1';
const DEFAULT_MAX_API_CIRCUIT_HALF_OPEN_PROBE_SEC = 60;
const MAX_API_CRITICAL_NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPROTO',
  'ERR_NETWORK',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);
const DEFAULT_MAX_ACTION_FAILED_RETENTION_AGE_SEC = 7 * 24 * 60 * 60;
const DEFAULT_MAX_ACTION_FAILED_RETENTION_COUNT = 1_000;
export const MAX_API_RATE_LIMIT_RESERVATION_SCRIPT = `
-- MAX_API_GCRA_RESERVE_V1
${RETENTION_PRIORITY_ADMISSION_LUA}
-- FLAG: The per-token external cooldown shares this atomic admission boundary;
-- rejected calls never consume GCRA slots or shorten a concurrent longer cooldown.
local cooldown = redis.call('PTTL', KEYS[1] .. ':cooldown')
if cooldown == -1 then return {0, 0, 30000} end
if cooldown > 0 then return {0, 0, cooldown} end
local time = redis.call('TIME')
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local priority = nil
local metadata = ARGV[#ARGV - 1]
local marker = '${RETENTION_PRIORITY_RESERVATION_MARKER}'
if metadata and string.sub(metadata, 1, string.len(marker)) == marker then
  local decoded, value = pcall(cjson.decode, string.sub(metadata, string.len(marker) + 1))
  if not decoded or type(value) ~= 'table' or value.version ~= '${RETENTION_PRIORITY_VERSION}' or
      type(value.retention) ~= 'boolean' or type(value.dimensions) ~= 'number' or value.dimensions < 1 or
      value.dimensions ~= math.floor(value.dimensions) or value.dimensions > #KEYS - 3 then
    return {0, -1, 1000, 'metrics_unavailable'}
  end
  priority = value
end
local keyCount = priority and priority.dimensions or #KEYS
if priority and priority.retention then
  local expected = keyCount + 3 + ${retentionPriorityQueueKeys().length}
  if #KEYS ~= expected then return {0, -1, 1000, 'metrics_unavailable'} end
  local denied = retentionPriorityAdmission(KEYS, keyCount, nowMs)
  if denied then return {0, -1, 1000, denied} end
end
-- FLAG: GCRA permits an initial burst plus replenished slots inside one second.
-- Bound the actual per-token rolling window too; all roles share KEYS[1].
-- A local refusal must consume neither this window nor another dimension's slots.
local windowKey = KEYS[1] .. ':window:v1'
local windowStart = '(' .. tostring(nowMs - 1000)
local tokenLimit = tonumber(ARGV[1])
if redis.call('ZCOUNT', windowKey, windowStart, '+inf') >= tokenLimit then
  local oldest = redis.call('ZRANGEBYSCORE', windowKey, windowStart, '+inf', 'WITHSCORES', 'LIMIT', 0, 1)
  return {0, 1, math.max(1, math.ceil(tonumber(oldest[2]) + 1000 - nowMs))}
end
local ttlFloorMs = tonumber(ARGV[#ARGV])
local nextTats = {}
local nextTtls = {}

for index = 1, keyCount do
  local limit = tonumber(ARGV[index])
  local intervalMs = 1000 / limit
  local burstToleranceSlots = tonumber(ARGV[keyCount + index])
  local burstToleranceMs = burstToleranceSlots * intervalMs
  local storedTat = tonumber(redis.call('GET', KEYS[index]) or tostring(nowMs))
  local tat = math.max(storedTat, nowMs)
  local allowAtMs = tat - burstToleranceMs
  if nowMs < allowAtMs then
    return {0, index, math.max(1, math.ceil(allowAtMs - nowMs))}
  end
  local nextTat = tat + intervalMs
  nextTats[index] = nextTat
  nextTtls[index] = math.max(
    ttlFloorMs,
    math.ceil(nextTat - nowMs + burstToleranceMs + intervalMs)
  )
end

for index = 1, keyCount do
  redis.call('SET', KEYS[index], tostring(nextTats[index]), 'PX', nextTtls[index])
end
-- FLAG: One atomic reservation commits all dimensions. The monotonically advancing
-- token TAT distinguishes concurrent admissions with the same Redis millisecond.
redis.call('ZREMRANGEBYSCORE', windowKey, '-inf', tostring(nowMs - 1000))
redis.call('ZADD', windowKey, nowMs, tostring(nextTats[1]))
redis.call('PEXPIRE', windowKey, 1000)
-- FLAG: Higher-priority transport proceeds even if its observational registry is
-- corrupt/full. A sticky unavailable marker denies retention until reviewed.
if priority and not priority.retention then
  local activity = KEYS[keyCount + 2]
  local unavailable = KEYS[keyCount + 3]
  local count = redis.pcall('ZCARD', activity)
  if type(count) == 'table' or type(priority.operationId) ~= 'string' or
      string.len(priority.operationId) == 0 or count >= ${HIGHER_PRIORITY_ACTIVITY_LIMIT} then
    redis.call('SET', unavailable, 'activity_coverage_unavailable')
  else
    local registered = redis.pcall('ZADD', activity,
      nowMs + ${HIGHER_PRIORITY_ACTIVITY_LEASE_MS}, priority.operationId)
    if type(registered) == 'table' then redis.call('SET', unavailable, 'activity_coverage_unavailable') end
  end
end

return {1, 0, 0}
`;

export const MAX_API_EXTERNAL_COOLDOWN_SCRIPT = `
-- MAX_API_EXTERNAL_COOLDOWN_V1
local requested = tonumber(ARGV[1])
local existing = redis.call('PTTL', KEYS[1])
if existing == -1 then return existing end
if requested > existing then
  redis.call('SET', KEYS[1], '1', 'PX', requested)
  return requested
end
return existing
`;

const MAX_API_CIRCUIT_ACQUIRE_SCRIPT = `
-- MAX_API_CIRCUIT_ACQUIRE_V1
local time = redis.call('TIME')
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local threshold = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local openMs = tonumber(ARGV[3])
local probeTtlMs = tonumber(ARGV[4])
local stateTtlMs = tonumber(ARGV[5])
local probeToken = ARGV[6]
local openUntilMs = tonumber(redis.call('GET', KEYS[2]) or '0')

if openUntilMs > nowMs then
  return {0, 0, math.max(1, math.ceil(openUntilMs - nowMs))}
end

local retained = {}
local failuresRaw = redis.call('GET', KEYS[1]) or ''
for value in string.gmatch(failuresRaw, '[^,]+') do
  local observedAtMs = tonumber(value)
  if observedAtMs ~= nil and observedAtMs >= nowMs - windowMs then
    table.insert(retained, observedAtMs)
  end
end

if #retained > 0 then
  redis.call('SET', KEYS[1], table.concat(retained, ','), 'PX', stateTtlMs)
else
  redis.call('DEL', KEYS[1])
end

if openUntilMs > 0 then
  local acquired = redis.call('SET', KEYS[3], probeToken, 'NX', 'PX', probeTtlMs)
  if acquired then
    return {1, 1, 0}
  end
  local probeTtl = redis.call('PTTL', KEYS[3])
  return {0, 0, math.max(1, probeTtl)}
end

if #retained >= threshold then
  local nextOpenUntilMs = nowMs + openMs
  redis.call('SET', KEYS[2], tostring(nextOpenUntilMs), 'PX', stateTtlMs)
  redis.call('DEL', KEYS[3])
  return {0, 0, openMs}
end

return {1, 0, 0}
`;

const MAX_API_CIRCUIT_FAILURE_SCRIPT = `
-- MAX_API_CIRCUIT_FAILURE_V1
local time = redis.call('TIME')
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local threshold = tonumber(ARGV[1])
local windowMs = tonumber(ARGV[2])
local openMs = tonumber(ARGV[3])
local stateTtlMs = tonumber(ARGV[4])
local forceOpen = tonumber(ARGV[5]) == 1
local retained = {}
local failuresRaw = redis.call('GET', KEYS[1]) or ''

for value in string.gmatch(failuresRaw, '[^,]+') do
  local observedAtMs = tonumber(value)
  if observedAtMs ~= nil and observedAtMs >= nowMs - windowMs then
    table.insert(retained, observedAtMs)
  end
end
table.insert(retained, nowMs)
redis.call('SET', KEYS[1], table.concat(retained, ','), 'PX', stateTtlMs)

local openUntilMs = tonumber(redis.call('GET', KEYS[2]) or '0')
if forceOpen or #retained >= threshold then
  openUntilMs = nowMs + openMs
  redis.call('SET', KEYS[2], tostring(openUntilMs), 'PX', stateTtlMs)
  redis.call('DEL', KEYS[3])
end

return {#retained, openUntilMs}
`;

const MAX_API_CIRCUIT_CLOSE_SCRIPT = `
-- MAX_API_CIRCUIT_CLOSE_V1
if redis.call('GET', KEYS[3]) == ARGV[1] then
  redis.call('DEL', KEYS[1], KEYS[2], KEYS[3])
  return 1
end
return 0
`;

const MAX_API_CIRCUIT_RELEASE_PROBE_SCRIPT = `
-- MAX_API_CIRCUIT_RELEASE_PROBE_V1
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

const MAX_MESSAGE_EDIT_LOCK_TTL_MS = 60_000;
const MAX_MESSAGE_EDIT_LOCK_WAIT_MS = 30_000;
const MAX_MESSAGE_EDIT_LOCK_RETRY_MS = 25;
const MAX_MESSAGE_EDIT_LOCK_RENEW_MS = 20_000;
const MAX_MESSAGE_EDIT_LOCK_ACQUIRE_SCRIPT = `
-- MAX_MESSAGE_EDIT_LOCK_ACQUIRE_V1
local acquired = redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2])
if acquired then
  return {1, tonumber(ARGV[2])}
end
return {0, math.max(1, redis.call('PTTL', KEYS[1]))}
`;
const MAX_MESSAGE_EDIT_LOCK_RENEW_SCRIPT = `
-- MAX_MESSAGE_EDIT_LOCK_RENEW_V1
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;
const MAX_MESSAGE_EDIT_LOCK_RELEASE_SCRIPT = `
-- MAX_MESSAGE_EDIT_LOCK_RELEASE_V1
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

type MaxApiCircuitPermit = {
  halfOpenProbeToken: string | null;
};

@Injectable()
export class MaxClientService implements OnModuleDestroy {
  private readonly logger = new Logger(MaxClientService.name);
  private readonly baseUrl: string;
  private readonly dispatchEnabled: boolean;
  private readonly routedMutationsMode: MaxRoutedMutationMode;
  private readonly routedMutationsCanaryPercent: number;
  private readonly routedMutationsCanaryEntityIds: ReadonlySet<string>;
  private readonly globalRpsLimit: number;
  private readonly globalBurstToleranceSlots: number;
  private readonly criticalGlobalRpsLimit: number;
  private readonly interactiveGlobalRpsLimit: number;
  private readonly backgroundGlobalRpsLimit: number;
  private readonly managedRefreshRpsLimit: number;
  private readonly rateLimitServiceScope: string;
  private readonly metricsStorageLayout: MaxApiMetricsStorageLayout;
  private readonly chatRpsLimit: number;
  private readonly chatMemberAccessAdminCacheTtlSec: number;
  private readonly chatMemberAccessMemberCacheTtlSec: number;
  private readonly chatAdminIdsCacheTtlSec: number;
  private readonly criticalRateLimitWaitMs: number;
  private readonly moderationDeleteRateLimitWaitMs: number;
  private readonly interactiveRateLimitWaitMs: number;
  private readonly backgroundRateLimitWaitMs: number;
  private readonly rateLimitRetryFloorMs: number;
  private readonly listBotChatsCacheTtlSec: number;
  private readonly chatSnapshotCacheTtlSec: number;
  private readonly actionFailedJobRetention: { age: number; count: number };
  private readonly isProduction: boolean;
  private readonly circuitFailureThreshold: number;
  private readonly circuitWindowSec: number;
  private readonly circuitOpenSec: number;
  private readonly circuitHalfOpenProbeSec: number;
  private readonly resumableVideoUploadEnabled: boolean;
  private readonly limiterRedis: Redis;
  private readonly muteApiBudget: MaxModerationApiBudget;
  private readonly muteApiProtectionEnabled: boolean;
  private readonly pendingTimeouts = new Set<NodeJS.Timeout>();
  private readonly pendingSleeps = new Map<NodeJS.Timeout, () => void>();
  private stopping = false;
  private readonly higherPriorityActivityTimers = new Map<string, NodeJS.Timeout>();
  private readonly pendingHigherPriorityActivityReleases = new Set<Promise<void>>();
  private readonly priorityHttpSource = new AsyncLocalStorage<string | null>();
  private readonly keyedActionTimeouts = new Map<string, NodeJS.Timeout>();
  private readonly rateLimitLogAtMsByKey = new Map<string, number>();
  private readonly actionFailureLog = new MaxActionFailureLog((summary) =>
    this.logger.warn(summary, 'MAX action failure window summary'),
  );
  private readonly registeredSourceMetricDimensions = new Set<string>();
  private usageMetricWritesInFlight = 0;
  private droppedUsageMetricWrites = 0;
  private usageMetricDropWarnedAtMs = 0;
  private readonly listBotChatsInFlight = new Map<string, Promise<MaxBotChat[]>>();
  private readonly currentChatMemberAccessInFlight = new Map<
    string,
    Promise<MaxChatMemberAccess>
  >();
  private readonly chatMembersAccessInFlight = new Map<
    string,
    Promise<Map<string, MaxChatMemberAccess>>
  >();
  private readonly chatAdminIdsInFlight = new Map<string, Promise<string[]>>();
  private readonly chatAdminMembersInFlight = new Map<string, Promise<MaxChatAdminMember[]>>();
  private readonly mediaUploadValidationCache = new MaxMediaUploadValidationCache();
  private readonly mutationExecutionScope = new AsyncLocalStorage<{
    chatId: string;
    purpose: MaxExecutionPurpose;
    guardCode: string;
    method: 'post' | 'put' | 'delete';
    path: string;
    requestOptions: MaxApiRequestOptions;
    explicitExistingMessage?: {
      messageId: string;
      object: import('./max-bound-message').MaxBoundObjectReference;
    };
    quotaState: { error?: unknown };
    messageMutation?: MaxMessageMutationRateLimitScope;
    finalGuard?: (revalidateRoute?: () => Promise<void>) => Promise<void>;
    preparePayload?: (config: Record<string, unknown>) => Promise<void>;
    onDispatchAttempt?: () => void;
  }>();

  constructor(
    private readonly httpService: HttpService,
    configService: ConfigService,
    private readonly actionHealthService: ActionHealthService,
    private readonly botRegistry: MaxBotRegistryService,
    private readonly botContext: MaxBotContextService,
    @Optional()
    @InjectQueue(MAX_ACTION_LEGACY_QUEUE)
    private readonly actionQueue?: Queue<MaxActionJob>,
    @Optional()
    private readonly runtimeDiagnosticsService?: RuntimeDiagnosticsService,
    @Optional()
    private readonly actionLedgerService?: MaxActionLedgerService,
    @Optional()
    private readonly maxBotLinkService?: MaxBotLinkService,
    @Optional()
    @InjectQueue(MAX_ACTION_CRITICAL_QUEUE)
    private readonly criticalActionQueue?: Queue<MaxActionJob>,
    @Optional()
    @InjectQueue(MAX_ACTION_INTERACTIVE_QUEUE)
    private readonly interactiveActionQueue?: Queue<MaxActionJob>,
    @Optional()
    @InjectQueue(MAX_ACTION_BACKGROUND_QUEUE)
    private readonly backgroundActionQueue?: Queue<MaxActionJob>,
    @Optional()
    private readonly marketplaceState?: MarketplaceStateService,
    @Optional()
    private readonly moderationRuleNoticeGuard?: MaxModerationRuleNoticeGuardService,
    @Optional()
    private readonly requiredSubscriptionNoticeGuard?: MaxRequiredSubscriptionNoticeGuardService,
    @Optional()
    private readonly duplicateNoticeGuard?: MaxDuplicateNoticeGuardService,
    @Optional() private readonly legacyHolds?: WebhookLegacyHoldService,
    @Optional() private readonly storageMetrics?: StorageRuntimeMetricsService,
  ) {
    this.baseUrl = configService.getOrThrow<string>('MAX_API_BASE_URL');
    this.isProduction =
      String(configService.get<string>('NODE_ENV', process.env.NODE_ENV ?? 'development') ?? '')
        .trim()
        .toLowerCase() === 'production';
    this.dispatchEnabled = configService.get<boolean>('MAX_ACTION_DISPATCH_ENABLED', true);
    this.routedMutationsMode = normalizeMaxRoutedMutationMode(
      configService.get('MAX_ROUTED_MUTATIONS_MODE'),
    );
    this.routedMutationsCanaryPercent = normalizeMaxRoutedMutationCanaryPercent(
      configService.get('MAX_ROUTED_MUTATIONS_CANARY_PERCENT'),
    );
    this.routedMutationsCanaryEntityIds = parseMaxRoutedMutationCanaryEntityIds(
      configService.get('MAX_ROUTED_MUTATIONS_CANARY_ENTITY_IDS'),
    );
    this.metricsStorageLayout =
      configService.get<MaxApiMetricsStorageLayout>('MAX_API_METRICS_STORAGE_LAYOUT') ?? 'legacy';
    this.resumableVideoUploadEnabled = configService.get<boolean>(
      'MAX_RESUMABLE_VIDEO_UPLOAD_ENABLED',
      true,
    );
    this.globalRpsLimit = Math.min(
      this.readConfigInt(configService.get('MAX_API_GLOBAL_RPS'), DEFAULT_MAX_API_GLOBAL_RPS),
      DEFAULT_MAX_API_GLOBAL_RPS,
    );
    this.globalBurstToleranceSlots = Math.min(
      this.globalRpsLimit - 1,
      this.readConfigInt(configService.get('MAX_API_GLOBAL_BURST'), this.globalRpsLimit - 1, 0),
    );
    this.criticalGlobalRpsLimit = this.readConfigInt(
      configService.get('MAX_API_GLOBAL_RPS_CRITICAL'),
      Math.max(1, Math.floor(this.globalRpsLimit * 0.45)),
    );
    this.interactiveGlobalRpsLimit = this.readConfigInt(
      configService.get('MAX_API_GLOBAL_RPS_INTERACTIVE'),
      Math.max(1, Math.floor(this.globalRpsLimit * 0.35)),
    );
    this.backgroundGlobalRpsLimit = this.readConfigInt(
      configService.get('MAX_API_GLOBAL_RPS_BACKGROUND'),
      Math.max(
        1,
        this.globalRpsLimit - this.criticalGlobalRpsLimit - this.interactiveGlobalRpsLimit,
      ),
    );
    this.managedRefreshRpsLimit = this.readConfigInt(
      configService.get('MAX_API_MANAGED_REFRESH_RPS'),
      DEFAULT_MAX_API_MANAGED_REFRESH_RPS,
      0,
    );
    this.rateLimitServiceScope = normalizeMaxApiRateLimitServiceScope(
      configService.get('APP_SERVICE_NAME', process.env.APP_SERVICE_NAME ?? 'api'),
    );
    this.chatRpsLimit = this.readConfigInt(configService.get('MAX_API_CHAT_RPS'), 10);
    this.chatMemberAccessAdminCacheTtlSec = this.readConfigInt(
      configService.get('MAX_API_CHAT_MEMBER_ACCESS_ADMIN_CACHE_SEC'),
      DEFAULT_MAX_API_CHAT_MEMBER_ACCESS_ADMIN_CACHE_SEC,
      0,
    );
    this.chatMemberAccessMemberCacheTtlSec = this.readConfigInt(
      configService.get('MAX_API_CHAT_MEMBER_ACCESS_MEMBER_CACHE_SEC'),
      DEFAULT_MAX_API_CHAT_MEMBER_ACCESS_MEMBER_CACHE_SEC,
      0,
    );
    this.chatAdminIdsCacheTtlSec = this.readConfigInt(
      configService.get('MAX_API_CHAT_ADMIN_IDS_CACHE_SEC'),
      DEFAULT_MAX_API_CHAT_ADMIN_IDS_CACHE_SEC,
      0,
    );
    this.criticalRateLimitWaitMs = this.readConfigInt(
      configService.get('MAX_API_RATE_LIMIT_WAIT_MS_CRITICAL'),
      DEFAULT_MAX_API_CRITICAL_RATE_LIMIT_WAIT_MS,
      0,
    );
    this.moderationDeleteRateLimitWaitMs = this.readConfigInt(
      configService.get('MAX_API_RATE_LIMIT_WAIT_MS_MODERATION_DELETE'),
      DEFAULT_MAX_API_MODERATION_DELETE_RATE_LIMIT_WAIT_MS,
      0,
    );
    this.interactiveRateLimitWaitMs = this.readConfigInt(
      configService.get('MAX_API_RATE_LIMIT_WAIT_MS_INTERACTIVE'),
      DEFAULT_MAX_API_INTERACTIVE_RATE_LIMIT_WAIT_MS,
      0,
    );
    this.backgroundRateLimitWaitMs = this.readConfigInt(
      configService.get('MAX_API_RATE_LIMIT_WAIT_MS_BACKGROUND'),
      DEFAULT_MAX_API_BACKGROUND_RATE_LIMIT_WAIT_MS,
      0,
    );
    this.rateLimitRetryFloorMs = this.readConfigInt(
      configService.get('MAX_API_RATE_LIMIT_RETRY_FLOOR_MS'),
      DEFAULT_MAX_API_RATE_LIMIT_RETRY_FLOOR_MS,
      1,
    );
    this.listBotChatsCacheTtlSec = this.readConfigInt(
      configService.get('MAX_API_LIST_BOT_CHATS_CACHE_SEC'),
      DEFAULT_MAX_API_LIST_BOT_CHATS_CACHE_SEC,
      0,
    );
    this.chatSnapshotCacheTtlSec = this.readConfigInt(
      configService.get('MAX_API_CHAT_SNAPSHOT_CACHE_SEC'),
      DEFAULT_MAX_API_CHAT_SNAPSHOT_CACHE_SEC,
      0,
    );
    this.actionFailedJobRetention = {
      age: this.readConfigInt(
        configService.get('MAX_ACTION_FAILED_RETENTION_AGE_SEC'),
        DEFAULT_MAX_ACTION_FAILED_RETENTION_AGE_SEC,
      ),
      count: this.readConfigInt(
        configService.get('MAX_ACTION_FAILED_RETENTION_COUNT'),
        DEFAULT_MAX_ACTION_FAILED_RETENTION_COUNT,
      ),
    };
    this.circuitFailureThreshold = this.readConfigInt(
      configService.get('MAX_API_CIRCUIT_FAILURE_THRESHOLD'),
      30,
    );
    this.circuitWindowSec = this.readConfigInt(configService.get('MAX_API_CIRCUIT_WINDOW_SEC'), 30);
    this.circuitOpenSec = this.readConfigInt(configService.get('MAX_API_CIRCUIT_OPEN_SEC'), 20);
    this.circuitHalfOpenProbeSec = this.readConfigInt(
      configService.get('MAX_API_CIRCUIT_HALF_OPEN_PROBE_SEC'),
      DEFAULT_MAX_API_CIRCUIT_HALF_OPEN_PROBE_SEC,
    );
    this.limiterRedis = new Redis(configService.getOrThrow<string>('REDIS_URL'));
    this.muteApiBudget = new MaxModerationApiBudget(configService.getOrThrow<string>('REDIS_URL'));
    this.muteApiProtectionEnabled =
      configService.get('MAX_MUTED_USER_API_PROTECTION_ENABLED') !== false &&
      configService.get('MAX_MUTED_USER_API_PROTECTION_ENABLED') !== 'false';
  }

  async onModuleDestroy() {
    this.stopping = true;
    // FLAG: Clearing a wait timer alone strands its caller forever. Reject only
    // local waits; started HTTP effects and their durable fences keep their ownership.
    for (const [timer, reject] of this.pendingSleeps) {
      clearTimeout(timer);
      reject();
    }
    this.pendingSleeps.clear();
    this.muteApiBudget.close();
    this.actionFailureLog.close();
    this.mediaUploadValidationCache.clear();
    for (const timer of this.higherPriorityActivityTimers.values()) clearInterval(timer);
    this.higherPriorityActivityTimers.clear();
    for (const timeout of new Set([
      ...this.pendingTimeouts,
      ...this.keyedActionTimeouts.values(),
    ])) {
      clearTimeout(timeout);
    }
    this.pendingTimeouts.clear();
    this.keyedActionTimeouts.clear();
    // FLAG: Drain only releases whose HTTP operation already settled. Live or unknown
    // activity keeps its marker; teardown never fabricates completion to admit cleanup.
    if (this.pendingHigherPriorityActivityReleases.size) {
      let deadline: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...this.pendingHigherPriorityActivityReleases]),
          new Promise<void>((resolve) => {
            deadline = setTimeout(resolve, MAX_PRIORITY_ACTIVITY_RELEASE_DRAIN_MS);
          }),
        ]);
      } finally {
        if (deadline) clearTimeout(deadline);
      }
    }
    await this.limiterRedis.quit();
  }

  runWithMuteApiBudget<T>(scope: MaxMuteApiBudgetScope, callback: () => Promise<T>): Promise<T> {
    return this.muteApiProtectionEnabled ? this.muteApiBudget.run(scope, callback) : callback();
  }

  async deleteMessage(chatId: string, messageId: string, options?: MaxActionDispatchOptions) {
    await this.dispatchAction(
      {
        actionType: 'DELETE_MESSAGE',
        chatId,
        messageId,
      },
      options,
    );
  }

  async pinMessage(
    chatId: string,
    messageId: string,
    notify = false,
    options: MaxApiRequestOptions & { beforeMutation?: () => Promise<void> } = {},
  ): Promise<void> {
    await this.executeMutation(
      chatId,
      async () => {
        await options.beforeMutation?.();
        const response = await this.request<{ success?: boolean }>('put', `/chats/${chatId}/pin`, {
          ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
          data: {
            message_id: messageId,
            notify,
          },
        });
        if (response?.success !== true) {
          throw new Error('MAX pin response did not confirm success');
        }
      },
      options,
    );
  }

  async getPinnedMessageId(chatId: string, options: MaxApiRequestOptions): Promise<string | null> {
    const response = await this.executeGlobalRequest(
      () =>
        this.request<Record<string, unknown>>('get', `/chats/${encodeURIComponent(chatId)}/pin`, {
          ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
        }),
      options,
    );
    const envelope = this.asRecord(response);
    if (envelope && (Object.keys(envelope).length === 0 || envelope.message === null)) return null;
    const message = this.asRecord(envelope?.message);
    const body = this.asRecord(message?.body);
    const recipient = this.asRecord(message?.recipient);
    if (typeof body?.mid !== 'string' || !body.mid || String(recipient?.chat_id) !== chatId)
      throw new Error('MAX pinned-message response is not verifiable');
    return body.mid;
  }

  async sendMessage(
    chatId: string,
    text: string,
    options?: MaxSendMessageOptions,
    dispatchOptions?: MaxActionDispatchOptions,
  ): Promise<MaxPublishedMessage | void> {
    const normalizedText = text.trim().length > 0 ? text : '';
    const attachments = this.buildMessageAttachments(options);
    const messageLink = this.buildMessageLinkData(options?.messageLink);
    if (normalizedText.length === 0 && attachments.length === 0 && !messageLink) {
      throw new UnrecoverableError('MAX SEND_MESSAGE payload has no text, attachments, or link');
    }
    return this.dispatchAction(
      {
        actionType: 'SEND_MESSAGE',
        chatId,
        text: normalizedText,
        options,
      },
      dispatchOptions,
    );
  }

  async sendMessageImmediateWithId(
    chatId: string,
    text: string,
    options?: MaxImmediateSendMessageOptions,
    requestOptions: MaxApiRequestOptions = {},
  ): Promise<MaxPublishedMessage> {
    const attachments = this.buildMessageAttachments(options);
    const messageLink = this.buildMessageLinkData(options?.messageLink);
    const normalizedText = text.trim().length > 0 ? text : '';
    const hasText = normalizedText.length > 0;
    if (!hasText && attachments.length === 0 && !messageLink) {
      throw new UnrecoverableError('MAX SEND_MESSAGE payload has no text, attachments, or link');
    }
    const timeoutMs = this.normalizeTimeoutMs(requestOptions.timeoutMs);
    const sendResponse = await this.executeMessageMutation(
      'send',
      chatId,
      () =>
        this.request<Record<string, unknown>>('post', '/messages', {
          params: {
            chat_id: chatId,
          },
          data: {
            text: hasText ? normalizedText : null,
            ...(hasText && options?.textFormat ? { format: options.textFormat } : {}),
            ...(messageLink ? { link: messageLink } : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
          },
          ...(timeoutMs ? { timeout: timeoutMs } : {}),
        }),
      requestOptions,
      withMaxFinalAuthorityCheckpoint(async (revalidateRoute) => {
        await this.assertLegacyMessageLinkAllowed(chatId, options?.messageLink);
        await options?.beforeSend?.(revalidateRoute);
        if (options?.marketplacePublication && !usesMaxFinalAuthorityCheckpoint(options.beforeSend))
          await revalidateRoute?.();
      }, usesMaxFinalAuthorityCheckpoint(options?.beforeSend)),
      options?.marketplacePublication
        ? async (config) => {
            const publicationOptions = await this.prepareMarketplacePublicationOptions(
              chatId,
              options,
              this.getCurrentBot().id,
            );
            const currentAttachments =
              publicationOptions === options
                ? attachments
                : this.buildMessageAttachments(publicationOptions);
            const data = config.data as Record<string, unknown>;
            if (currentAttachments.length) data.attachments = currentAttachments;
            else delete data.attachments;
          }
        : undefined,
    );

    const messageId = this.extractMessageIdFromSendResponse(sendResponse);
    if (!messageId) {
      throw markMaxMessageSendAttempted(
        new Error('Ambiguous MAX send response is missing message id'),
      );
    }

    const resolvedChatId = this.extractChatIdFromSendResponse(sendResponse);
    return {
      messageId,
      url: this.parseChatLink(sendResponse),
      ...(resolvedChatId ? { chatId: resolvedChatId } : {}),
    };
  }

  async sendMessageImmediateToUser(
    userId: string,
    text: string,
    options?: MaxImmediateSendMessageOptions,
    requestOptions: MaxApiRequestOptions = {},
  ): Promise<MaxPublishedMessage> {
    const attachments = this.buildMessageAttachments(options);
    const messageLink = this.buildMessageLinkData(options?.messageLink);
    const normalizedText = text.trim().length > 0 ? text : '';
    const hasText = normalizedText.length > 0;
    if (!hasText && attachments.length === 0 && !messageLink) {
      throw new UnrecoverableError('MAX SEND_MESSAGE payload has no text, attachments, or link');
    }
    const timeoutMs = this.normalizeTimeoutMs(requestOptions.timeoutMs);
    const sendResponse = await this.executeMessageMutation(
      'send',
      `user:${userId}`,
      async () => {
        return this.request<Record<string, unknown>>('post', '/messages', {
          params: {
            user_id: userId,
          },
          data: {
            text: hasText ? normalizedText : null,
            ...(hasText && options?.textFormat ? { format: options.textFormat } : {}),
            ...(messageLink ? { link: messageLink } : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
          },
          ...(timeoutMs ? { timeout: timeoutMs } : {}),
        });
      },
      requestOptions,
      options?.beforeSend,
    );

    const messageId = this.extractMessageIdFromSendResponse(sendResponse);
    if (!messageId) {
      throw markMaxMessageSendAttempted(
        new Error('Ambiguous MAX send response is missing message id'),
      );
    }

    const resolvedChatId = this.extractChatIdFromSendResponse(sendResponse);
    return {
      messageId,
      url: this.parseChatLink(sendResponse),
      ...(resolvedChatId ? { chatId: resolvedChatId } : {}),
    };
  }

  async sendMessageImmediateWithResolvedLink(
    chatId: string,
    text: string,
    options?: MaxImmediateSendMessageOptions,
    requestOptions: MaxApiRequestOptions = {},
  ): Promise<MaxPublishedMessage> {
    const {
      messageId,
      url: directUrl,
      chatId: resolvedChatId,
    } = await this.sendMessageImmediateWithId(chatId, text, options, requestOptions);
    if (directUrl) {
      return {
        messageId,
        url: directUrl,
        ...(resolvedChatId ? { chatId: resolvedChatId } : {}),
      };
    }

    const resolvedUrl = await this.resolveMessageLinkSafely(messageId, requestOptions);
    return {
      messageId,
      url: resolvedUrl ?? null,
      ...(resolvedChatId ? { chatId: resolvedChatId } : {}),
    };
  }

  async sendCustomMessageImmediate(
    chatId: string,
    payload: MaxCustomMessagePayload,
    requestOptions: MaxApiRequestOptions | MaxApiTrafficClass = {},
    beforeSend?: () => Promise<void>,
  ): Promise<Record<string, unknown>> {
    const normalizedRequestOptions = this.normalizeReadRequestOptions(requestOptions);
    const attachments = Array.isArray(payload.attachments)
      ? payload.attachments
          .map((attachment) => this.normalizeCustomMessageAttachment(attachment))
          .filter((attachment): attachment is Record<string, unknown> => attachment !== null)
      : [];
    const messageLink = this.buildMessageLinkData(payload.messageLink);
    const normalizedText =
      typeof payload.text === 'string' && payload.text.trim().length > 0 ? payload.text : null;
    const hasText = normalizedText !== null;
    const timeoutMs = this.normalizeTimeoutMs(normalizedRequestOptions.timeoutMs);

    if (!hasText && attachments.length === 0 && !messageLink) {
      throw new Error('MAX custom message payload is empty');
    }

    return this.executeMessageMutation(
      'send',
      chatId,
      async () => {
        return this.request<Record<string, unknown>>('post', '/messages', {
          params: {
            chat_id: chatId,
          },
          data: {
            text: normalizedText,
            ...(hasText && payload.textFormat ? { format: payload.textFormat } : {}),
            ...(messageLink ? { link: messageLink } : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
          },
          ...(timeoutMs ? { timeout: timeoutMs } : {}),
        });
      },
      normalizedRequestOptions,
      async () => {
        await this.assertLegacyMessageLinkAllowed(chatId, payload.messageLink);
        await beforeSend?.();
      },
    );
  }

  private normalizeCustomMessageAttachment(attachment: unknown): Record<string, unknown> | null {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
      return null;
    }

    const row = attachment as Record<string, unknown>;
    if (this.readLowerString(row.type) !== 'inline_keyboard') {
      return row;
    }

    const payload = this.asRecord(row.payload);
    const buttons = Array.isArray(payload?.buttons)
      ? normalizeMaxInlineKeyboardButtons(payload.buttons)
      : null;
    if (!payload || !buttons) {
      return null;
    }

    return {
      ...row,
      type: 'inline_keyboard',
      payload: {
        ...payload,
        buttons,
      },
    };
  }

  async sendCustomMessageImmediateWithResolvedLink(
    chatId: string,
    payload: MaxCustomMessagePayload,
    requestOptions: MaxApiRequestOptions | MaxApiTrafficClass = {},
  ): Promise<MaxPublishedMessage> {
    const sendResponse = await this.sendCustomMessageImmediate(chatId, payload, requestOptions);
    const messageId = this.extractMessageIdFromSendResponse(sendResponse);
    if (!messageId) {
      throw markMaxMessageSendAttempted(
        new Error('Ambiguous MAX send response is missing message id'),
      );
    }

    const directUrl = this.parseChatLink(sendResponse);
    const resolvedChatId = this.extractChatIdFromSendResponse(sendResponse);
    if (directUrl) {
      return {
        messageId,
        url: directUrl,
        ...(resolvedChatId ? { chatId: resolvedChatId } : {}),
      };
    }

    const resolvedUrl = await this.resolveMessageLinkSafely(messageId, requestOptions);
    return {
      messageId,
      url: resolvedUrl ?? null,
      ...(resolvedChatId ? { chatId: resolvedChatId } : {}),
    };
  }

  async sendMessageCopyWithInlineKeyboard(
    chatId: string,
    sourceMessageId: string,
    fallbackText: string | null,
    options?: MaxEditableMessageOptions & {
      beforeSend?: () => Promise<void>;
      inspectSource?: (message: Record<string, unknown> | null) => void;
    },
    requestOptions: MaxApiRequestOptions | MaxApiTrafficClass = {},
  ): Promise<MaxPublishedMessage> {
    const sourceMessage = await this.getMessageById(sourceMessageId, requestOptions);
    options?.inspectSource?.(sourceMessage);
    this.assertExpectedEditableMessageText(sourceMessage, options);
    const attachments = this.buildEditableMessageAttachments(sourceMessage, options);
    const replyLink = this.extractReplyMessageLink(sourceMessage);
    const messageTextPayload = options?.prepareMessageText
      ? ((await options.prepareMessageText(sourceMessage)) ??
        this.buildOutgoingMessageTextPayload(sourceMessage, null))
      : this.buildOutgoingMessageTextPayload(
          sourceMessage,
          fallbackText,
          options?.textFormat ?? null,
        );
    let sendResponse: Record<string, unknown>;
    let sendAttempted = false;
    try {
      sendResponse = await this.sendCustomMessageImmediate(
        chatId,
        {
          ...(typeof messageTextPayload.text === 'string' && messageTextPayload.text.length > 0
            ? { text: messageTextPayload.text }
            : {}),
          ...(messageTextPayload.textFormat ? { textFormat: messageTextPayload.textFormat } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
          ...(replyLink ? { messageLink: replyLink } : {}),
        },
        requestOptions,
        async () => {
          await this.assertLegacyMessageMutationAllowed(chatId, sourceMessageId);
          const sourceChatId = this.extractChatIdFromSendResponse(sourceMessage);
          if (sourceChatId && sourceChatId !== chatId) {
            await this.assertLegacyMessageMutationAllowed(sourceChatId, sourceMessageId);
            await this.assertLegacyMessageLinkAllowed(sourceChatId, replyLink);
          }
          await options?.beforeSend?.();
          sendAttempted = true;
        },
      );
    } catch (error: unknown) {
      throw sendAttempted ? markMaxMessageSendAttempted(error) : error;
    }

    const messageId = this.extractMessageIdFromSendResponse(sendResponse);
    if (!messageId) {
      throw markMaxMessageSendAttempted(
        new Error('Ambiguous MAX send response is missing message id'),
      );
    }

    const resolvedChatId = this.extractChatIdFromSendResponse(sendResponse);
    return {
      messageId,
      url: this.parseChatLink(sendResponse),
      ...(resolvedChatId ? { chatId: resolvedChatId } : {}),
    };
  }

  async getMessageTextAsMarkdown(
    messageId: string,
    requestOptions: MaxApiRequestOptions | MaxApiTrafficClass = 'critical',
  ): Promise<string | null> {
    const message = await this.getMessageById(messageId, requestOptions);
    const body = this.asRecord(message?.body);
    const sourceText =
      typeof body?.text === 'string'
        ? body.text
        : typeof message?.text === 'string'
          ? message.text
          : null;
    if (!sourceText) {
      return null;
    }

    const markdown = renderMaxTextMarkupAsMarkdown(sourceText, this.extractMessageMarkup(message));
    return markdown || sourceText;
  }

  async resolveMessageLink(
    messageId: string,
    requestOptions: MaxApiRequestOptions | MaxApiTrafficClass = 'critical',
  ): Promise<string | null> {
    const sentMessage = await this.getMessageById(messageId, requestOptions);
    const batchLink = sentMessage ? this.parseChatLink(sentMessage) : null;
    if (batchLink) {
      return batchLink;
    }

    const detailedMessage = await this.getMessageByPath(messageId, requestOptions);
    return detailedMessage ? this.parseChatLink(detailedMessage) : null;
  }

  private async resolveMessageLinkSafely(
    messageId: string,
    requestOptions: MaxApiRequestOptions | MaxApiTrafficClass = 'critical',
  ): Promise<string | null> {
    try {
      return await this.resolveMessageLink(messageId, requestOptions);
    } catch (error: unknown) {
      this.logger.warn(
        {
          messageId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve MAX message link after successful send',
      );
      return null;
    }
  }

  async replaceOwnMessage(
    chatId: string,
    messageId: string,
    text: string,
    options: MaxSendMessageOptions | undefined,
    requestOptions: MaxApiRequestOptions & { botId: string },
    beforeMutation: () => Promise<void>,
  ): Promise<void> {
    const bot = this.resolveExecutableBot(requestOptions.botId, { explicit: true });
    const exactOptions = { ...requestOptions, botId: bot.id, bypassCache: true };
    await this.runWithMessageKeyboardEditLock(
      messageId,
      async (assertOwnership, assertCurrentOwnership) => {
        const access = await this.getCurrentChatMemberAccess(chatId, exactOptions);
        if (!access.isAdmin && !access.isOwner) {
          throw new BadRequestException('Бот больше не является администратором группы.');
        }
        const message = await this.getExactMessageRow(chatId, messageId, exactOptions);
        const sender = this.asRecord(message?.sender);
        const senderId = this.readMemberUserId(sender);
        // FLAG: A stored bot ID is not authorship proof; never replace another author's post.
        if (!access.userId || senderId !== access.userId || sender?.is_bot !== true) {
          throw new BadRequestException('Не удалось подтвердить автора опубликованных правил.');
        }
        const attachments = this.buildMessageAttachments(options);
        await this.executeMessageMutation(
          'edit',
          chatId,
          async () => {
            const response = await this.request<{ success?: boolean }>('put', '/messages', {
              params: { message_id: messageId },
              data: {
                text,
                ...(options?.textFormat ? { format: options.textFormat } : {}),
                attachments,
                notify: false,
              },
              ...(requestOptions.timeoutMs ? { timeout: requestOptions.timeoutMs } : {}),
            });
            if (response?.success !== true) {
              throw new BadRequestException('MAX не подтвердил обновление правил.');
            }
          },
          exactOptions,
          async () => {
            await assertOwnership();
            await this.assertLegacyMessageMutationAllowed(chatId, messageId);
            await beforeMutation();
            assertCurrentOwnership();
          },
        );
      },
    );
  }

  async editMessageInlineKeyboard(
    chatId: string,
    messageId: string,
    text: string | null,
    options?: MaxEditableMessageOptions,
    requestOptions: MaxApiRequestOptions | MaxApiTrafficClass = {},
  ) {
    return this.runWithMessageKeyboardEditLock(
      messageId,
      async (assertOwnership, assertCurrentOwnership) => {
        let message = await this.getMessageById(messageId, requestOptions);
        if (options?.refreshButtonText) {
          message = await refreshExistingInlineKeyboardText(message, options.refreshButtonText);
          if (!message) return;
          options = {
            ...options,
            button: undefined,
            buttons: undefined,
            mergeExistingInlineKeyboard: false,
            preserveExistingInlineKeyboard: true,
            requireAllAttachmentsPreserved: true,
          };
        }
        if (options?.prepareInlineKeyboard) {
          const buttons = await options.prepareInlineKeyboard(message);
          if (buttons === null) return;
          options = { ...options, buttons };
        }
        this.assertExpectedEditableMessageText(message, options);
        // FLAG: PUT keeps the forward link. Its nested media and keyboard belong to the
        // linked message, not to this post; only a copy may flatten those attachments.
        const attachments = this.buildEditableMessageAttachments(message, options, false);
        const sourceBody = this.asRecord(message?.body);
        const sourceText = typeof sourceBody?.text === 'string' ? sourceBody.text : null;
        const shouldForceReplacementText =
          typeof text === 'string' &&
          text !== sourceText &&
          !this.shouldSkipTextUpdateForInlineKeyboardEdit(message);
        // FLAG: Derived text must use this locked snapshot, never an older webhook payload.
        const preparedText = options?.prepareMessageText
          ? await options.prepareMessageText(message)
          : undefined;
        const messageTextPayload = options?.prepareMessageText
          ? this.shouldSkipTextUpdateForInlineKeyboardEdit(message)
            ? null
            : preparedText
          : typeof text === 'string' && !this.shouldSkipTextUpdateForInlineKeyboardEdit(message)
            ? shouldForceReplacementText
              ? {
                  text,
                  textFormat: options?.textFormat ?? null,
                }
              : this.buildOutgoingMessageTextPayload(message, text, options?.textFormat ?? null)
            : null;

        await assertOwnership();
        const marketplaceSkip = new Error('Optional marketplace edit is no longer needed');

        return this.executeMessageMutation(
          'edit',
          chatId,
          async () => {
            const response = await this.request<{ success?: boolean }>('put', '/messages', {
              params: {
                message_id: messageId,
              },
              data: {
                ...(messageTextPayload && typeof messageTextPayload.text === 'string'
                  ? {
                      text: messageTextPayload.text,
                      ...(messageTextPayload.textFormat
                        ? { format: messageTextPayload.textFormat }
                        : {}),
                    }
                  : {}),
                attachments,
              },
            });
            if (options?.requireAllAttachmentsPreserved && response.success !== true) {
              throw new BadRequestException('MAX did not confirm the post update.');
            }
            return true;
          },
          requestOptions,
          withMaxFinalAuthorityCheckpoint(async (revalidateRoute) => {
            await assertOwnership();
            await this.assertLegacyMessageMutationAllowed(chatId, messageId);
            await options?.beforeEditMutation?.(revalidateRoute);
            if (
              options?.marketplaceChannelPost &&
              !usesMaxFinalAuthorityCheckpoint(options.beforeEditMutation)
            )
              await revalidateRoute?.();
            assertCurrentOwnership();
          }, usesMaxFinalAuthorityCheckpoint(options?.beforeEditMutation)),
          options?.marketplaceChannelPost
            ? async (config) => {
                const marketplace = options?.marketplaceChannelPost;
                let currentAttachments: readonly Record<string, unknown>[] = attachments;
                if (marketplace) {
                  let added = false;
                  if (
                    marketplace.entityId === chatId &&
                    Number.isFinite(Date.parse(marketplace.sourceAt))
                  ) {
                    try {
                      const botId = this.getCurrentBot().id;
                      const binding = await this.marketplaceState?.resolvePublicationButton({
                        chatId,
                        botId,
                        purpose: 'CHANNEL_POST',
                        sourceAt: new Date(marketplace.sourceAt),
                      });
                      if (binding) {
                        const prepared = appendMarketplaceEditableAttachments(
                          attachments,
                          binding.url,
                          binding.caption,
                        );
                        currentAttachments = prepared.attachments;
                        added = prepared.outcome === 'ADDED';
                        if (prepared.outcome === 'KEYBOARD_FULL')
                          await this.marketplaceState?.recordButtonDiagnostic({
                            chatId,
                            botId,
                            revision: binding.revision,
                            purpose: 'CHANNEL_POST',
                            code: 'KEYBOARD_FULL',
                          });
                      }
                    } catch {
                      this.logger.warn('Optional marketplace channel button is unavailable');
                    }
                  }
                  if (marketplace.only && !added) throw marketplaceSkip;
                }
                (config.data as Record<string, unknown>).attachments = currentAttachments;
              }
            : undefined,
        ).catch((error: unknown) => {
          if (error === marketplaceSkip) return false;
          throw error;
        });
      },
    );
  }

  async sendMessageReplyWithInlineKeyboard(
    chatId: string,
    messageId: string,
    text: string,
    options?: Pick<MaxSendMessageOptions, 'button' | 'buttons' | 'debugContext'>,
    requestOptions: MaxApiRequestOptions | MaxApiTrafficClass = {},
  ): Promise<MaxPublishedMessage | null> {
    const normalizedRequestOptions = this.normalizeReadRequestOptions(requestOptions);
    const attachments = this.buildMessageAttachments(options);
    const messageLink = this.buildMessageLinkData({
      type: 'reply',
      mid: messageId,
    });
    if (attachments.length === 0 || !messageLink) {
      return null;
    }

    const timeoutMs = this.normalizeTimeoutMs(normalizedRequestOptions.timeoutMs);
    const sendResponse = await this.executeMessageMutation(
      'send',
      chatId,
      async () => {
        return this.request<Record<string, unknown>>('post', '/messages', {
          params: {
            chat_id: chatId,
          },
          data: {
            text,
            link: messageLink,
            attachments,
          },
          ...(timeoutMs ? { timeout: timeoutMs } : {}),
        });
      },
      normalizedRequestOptions,
      async () => {
        await this.assertLegacyMessageMutationAllowed(chatId, messageId);
      },
    );

    const replyMessageId = this.extractMessageIdFromSendResponse(sendResponse);
    if (!replyMessageId) {
      throw markMaxMessageSendAttempted(
        new Error('Ambiguous MAX send response is missing message id'),
      );
    }

    const resolvedChatId = this.extractChatIdFromSendResponse(sendResponse);
    return {
      messageId: replyMessageId,
      url: this.parseChatLink(sendResponse),
      ...(resolvedChatId ? { chatId: resolvedChatId } : {}),
    };
  }

  async listMessages(
    chatId: string,
    countOrOptions:
      | number
      | {
          count?: number;
          from?: number | string | Date | null;
          to?: number | string | Date | null;
          trafficClass?: MaxApiTrafficClass;
          sourceTag?: string;
          ignoreFailureMetricStatuses?: readonly number[];
          botId?: string;
        } = 10,
  ): Promise<Record<string, unknown>[]> {
    const options =
      typeof countOrOptions === 'number'
        ? { count: countOrOptions, trafficClass: undefined }
        : {
            count: countOrOptions.count ?? 10,
            from: countOrOptions.from ?? null,
            to: countOrOptions.to ?? null,
            trafficClass: countOrOptions.trafficClass,
            sourceTag: countOrOptions.sourceTag,
            ignoreFailureMetricStatuses: countOrOptions.ignoreFailureMetricStatuses,
            botId: countOrOptions.botId,
          };
    const data = await this.executeChatRequest(
      chatId,
      async () =>
        this.request<Record<string, unknown>>('get', '/messages', {
          params: {
            chat_id: chatId,
            count: options.count,
            ...(options.from !== null && options.from !== undefined
              ? { from: this.normalizeMessageQueryBoundary(options.from) }
              : {}),
            ...(options.to !== null && options.to !== undefined
              ? { to: this.normalizeMessageQueryBoundary(options.to) }
              : {}),
          },
        }),
      {
        trafficClass: options.trafficClass,
        sourceTag: options.sourceTag,
        ignoreFailureMetricStatuses: options.ignoreFailureMetricStatuses,
        botId: options.botId,
      },
    );
    return this.normalizeMessageRows(data);
  }

  parseChannelMessageSnapshot(chatId: string, raw: unknown): MaxChannelMessageSnapshot | null {
    const row = this.asRecord(raw);
    return row ? this.parseMessageSnapshot(chatId, row) : null;
  }

  async listMessageSnapshots(
    chatId: string,
    options: {
      from?: Date | number | string | null;
      to?: Date | number | string | null;
      count?: number;
      maxPages?: number;
      trafficClass?: MaxApiTrafficClass;
      sourceTag?: string;
      ignoreFailureMetricStatuses?: readonly number[];
      botId?: string;
    } = {},
  ): Promise<MaxChannelMessageSnapshot[]> {
    const fromMs = this.normalizeMessageTimestamp(options.from ?? null);
    const toMs = this.normalizeMessageTimestamp(options.to ?? null) ?? Date.now();
    const count = Math.min(Math.max(options.count ?? 100, 1), 100);
    const maxPages = Math.min(Math.max(options.maxPages ?? 60, 1), 200);
    const snapshots = new Map<string, MaxChannelMessageSnapshot>();
    let cursorFrom = toMs;
    let previousSignature = '';

    for (let page = 0; page < maxPages; page += 1) {
      const rows = await this.listMessages(chatId, {
        count,
        from: cursorFrom,
        ...(fromMs !== null ? { to: fromMs } : {}),
        trafficClass: options.trafficClass,
        sourceTag: options.sourceTag,
        ignoreFailureMetricStatuses: options.ignoreFailureMetricStatuses,
        botId: options.botId,
      });
      if (rows.length === 0) {
        break;
      }

      const pageItems = rows
        .map((row) => this.parseMessageSnapshot(chatId, row))
        .filter((item): item is MaxChannelMessageSnapshot => item !== null)
        .sort((left, right) => right.publishedAtMs - left.publishedAtMs);

      if (pageItems.length === 0) {
        break;
      }

      for (const item of pageItems) {
        if (fromMs !== null && item.publishedAtMs < fromMs) {
          continue;
        }
        if (item.publishedAtMs > toMs) {
          continue;
        }
        snapshots.set(
          item.messageId,
          this.mergeMessageSnapshots(snapshots.get(item.messageId) ?? null, item),
        );
      }

      const signature = `${pageItems[0]?.messageId ?? ''}:${pageItems.at(-1)?.messageId ?? ''}`;
      if (signature && signature === previousSignature) {
        break;
      }
      previousSignature = signature;

      const oldest = pageItems.at(-1);
      if (!oldest) {
        break;
      }

      if (fromMs !== null && oldest.publishedAtMs <= fromMs) {
        break;
      }

      const nextCursor = oldest.publishedAtMs - 1;
      if (nextCursor >= cursorFrom) {
        break;
      }

      cursorFrom = nextCursor;

      if (rows.length < count) {
        break;
      }
    }

    return Array.from(snapshots.values()).sort(
      (left, right) => right.publishedAtMs - left.publishedAtMs,
    );
  }

  async getMessageSnapshot(
    chatId: string,
    messageId: string,
    options: MaxApiRequestOptions | MaxApiTrafficClass = {},
  ): Promise<MaxChannelMessageSnapshot | null> {
    const normalizedChatId = chatId.trim();
    const normalizedMessageId = messageId.trim();
    if (!normalizedChatId || !normalizedMessageId) {
      return null;
    }

    const message = await this.getMessageById(normalizedMessageId, options);
    if (!message) {
      return null;
    }

    return this.parseMessageSnapshot(normalizedChatId, message);
  }

  async getExactMessageRow(
    chatId: string,
    messageId: string,
    options: MaxApiRequestOptions | MaxApiTrafficClass = {},
  ): Promise<Record<string, unknown> | null> {
    const normalizedChatId = chatId.trim();
    const normalizedMessageId = messageId.trim();
    if (!normalizedChatId || !normalizedMessageId) {
      throw new Error('chatId and messageId are required for exact MAX message lookup');
    }

    const selectedBotId = this.resolveBot(this.normalizeReadRequestOptions(options).botId).id;
    const failureObserver = observeBoundReadHttp429({
      kind: 'exact_message',
      chatId: normalizedChatId,
      messageId: normalizedMessageId,
      botId: selectedBotId,
    });
    let message: Record<string, unknown> | null;
    try {
      message = await this.getMessageById(normalizedMessageId, options, failureObserver);
    } catch (error) {
      discardForeignReadHttp429(error, failureObserver);
      throw error;
    }
    if (!message) {
      return null;
    }

    const responseChatId = this.extractChatIdFromSendResponse(message);
    if (!responseChatId) {
      throw new Error(`MAX exact message lookup returned ${normalizedMessageId} without a chat id`);
    }
    if (responseChatId !== normalizedChatId) {
      throw this.createExactMessageTargetMismatchError(
        normalizedChatId,
        responseChatId,
        normalizedMessageId,
      );
    }
    return message;
  }

  async getVideoDownloadUrl(
    videoToken: string,
    options: MaxApiRequestOptions | MaxApiTrafficClass = {},
  ): Promise<string | null> {
    const normalizedToken = videoToken.trim();
    if (!normalizedToken || normalizedToken.length > 512) {
      return null;
    }
    const response = await this.executeGlobalRequest(
      () =>
        this.request<Record<string, unknown>>(
          'get',
          `/videos/${encodeURIComponent(normalizedToken)}`,
        ),
      options,
    );
    return extractMaxVideoDownloadUrl(response);
  }

  async getExactChannelDialogButtonIdentities(
    chatId: string,
    messageId: string,
    options: MaxApiRequestOptions | MaxApiTrafficClass = 'background',
  ): Promise<InternalChannelDialogButtonIdentity[] | null> {
    const normalizedChatId = chatId.trim();
    const normalizedMessageId = messageId.trim();
    if (!normalizedChatId || !normalizedMessageId) {
      throw new Error('chatId and messageId are required for channel dialog button lookup');
    }

    const message = await this.getMessageById(normalizedMessageId, options);
    const nestedMessage = this.asRecord(message?.message);
    const exactMessage = [message, nestedMessage].find(
      (candidate) =>
        candidate && this.extractMessageIdFromSendResponse(candidate) === normalizedMessageId,
    );
    if (!exactMessage) {
      throw new Error(
        'MAX exact channel dialog lookup returned a response without the requested id',
      );
    }
    const responseChatId = this.extractChatIdFromSendResponse(exactMessage);
    if (responseChatId && responseChatId !== normalizedChatId) {
      throw this.createExactMessageTargetMismatchError(
        normalizedChatId,
        responseChatId,
        normalizedMessageId,
      );
    }
    return readInternalChannelDialogButtonIdentitiesFromMessage(exactMessage, normalizedChatId);
  }

  async getExactMessagePresence(
    chatId: string,
    messageId: string,
    options: MaxApiRequestOptions | MaxApiTrafficClass = {},
  ): Promise<MaxExactMessagePresence> {
    const normalizedChatId = chatId.trim();
    const normalizedMessageId = messageId.trim();
    if (!normalizedChatId || !normalizedMessageId) {
      throw new Error('chatId and messageId are required for exact MAX message presence');
    }

    const [result] = await this.getExactMessagePresences(
      [{ chatId: normalizedChatId, messageId: normalizedMessageId }],
      options,
    );
    if (result && 'presence' in result) {
      return result.presence;
    }
    throw result?.error ?? new Error('MAX exact message lookup returned no result');
  }

  async getExactMessagePresences(
    requests: readonly MaxExactMessagePresenceRequest[],
    options: MaxApiRequestOptions | MaxApiTrafficClass = {},
  ): Promise<MaxExactMessagePresenceResult[]> {
    if (requests.length === 0) {
      return [];
    }

    const normalizedRequests = requests.map((request) => ({
      chatId: request.chatId.trim(),
      messageId: request.messageId.trim(),
    }));
    if (normalizedRequests.some((request) => !request.chatId || !request.messageId)) {
      throw new Error('chatId and messageId are required for exact MAX message presence');
    }

    const requestsByMessageId = new Map<string, MaxExactMessagePresenceRequest[]>();
    for (const request of normalizedRequests) {
      const groupedRequests = requestsByMessageId.get(request.messageId) ?? [];
      groupedRequests.push(request);
      requestsByMessageId.set(request.messageId, groupedRequests);
    }
    const uniqueMessageIds = Array.from(requestsByMessageId.keys());
    const resultsByRequest = new Map<string, MaxExactMessagePresenceOutcome>();
    const timeoutMs = this.normalizeReadRequestOptions(options).timeoutMs;

    // MAX documents 50 as the default message-list response size. Keeping the same bound also
    // prevents comma-separated message IDs from producing oversized request URLs.
    for (let index = 0; index < uniqueMessageIds.length; index += MAX_API_MESSAGE_IDS_BATCH_SIZE) {
      const batchMessageIds = uniqueMessageIds.slice(index, index + MAX_API_MESSAGE_IDS_BATCH_SIZE);
      const requestedIds = new Set(batchMessageIds);
      const batch = batchMessageIds.flatMap(
        (messageId) => requestsByMessageId.get(messageId) ?? [],
      );
      const listedChatIdsByMessageId = new Map<string, Set<string>>();
      const unscopedListedMessageIds = new Set<string>();
      let listError: unknown = null;

      try {
        const data = await this.executeGlobalRequest(
          associatedMaxHttpOperation((owner) =>
            this.request<Record<string, unknown>>(
              'get',
              '/messages',
              {
                params: { message_ids: batchMessageIds.join(',') },
                ...(timeoutMs ? { timeout: timeoutMs } : {}),
              },
              owner,
            ),
          ),
          options,
        );
        const messages = Array.isArray(data.messages) ? data.messages : [];
        for (const message of messages) {
          if (message === null || typeof message !== 'object' || Array.isArray(message)) {
            continue;
          }
          const listedId = this.extractMessageIdFromSendResponse(message);
          if (listedId && requestedIds.has(listedId)) {
            const responseChatId = this.extractChatIdFromSendResponse(message);
            if (responseChatId) {
              const listedChatIds = listedChatIdsByMessageId.get(listedId) ?? new Set<string>();
              listedChatIds.add(responseChatId);
              listedChatIdsByMessageId.set(listedId, listedChatIds);
            } else {
              unscopedListedMessageIds.add(listedId);
            }
          }
        }

        for (const messageId of batchMessageIds) {
          const groupedRequests = requestsByMessageId.get(messageId) ?? [];
          const requestedChatIds = new Set(groupedRequests.map((request) => request.chatId));
          const listedChatIds = listedChatIdsByMessageId.get(messageId) ?? new Set<string>();
          for (const request of groupedRequests) {
            const requestKey = this.buildExactMessagePresenceRequestKey(request);
            if (listedChatIds.has(request.chatId)) {
              resultsByRequest.set(requestKey, { presence: 'present' });
            } else if (listedChatIds.size > 0) {
              resultsByRequest.set(requestKey, {
                error: this.createExactMessageTargetMismatchError(
                  request.chatId,
                  listedChatIds.values().next().value ?? 'unknown',
                  request.messageId,
                ),
              });
            } else if (unscopedListedMessageIds.has(messageId)) {
              resultsByRequest.set(
                requestKey,
                requestedChatIds.size === 1
                  ? { presence: 'present' }
                  : { error: this.createUnscopedExactMessageTargetError(request.messageId) },
              );
            }
          }
        }
      } catch (error: unknown) {
        if (this.extractStatusCode(error) === 404) {
          // A list-route 404 is not proof that any specific message is absent.
          listError = null;
        } else {
          listError = error;
        }
      }

      if (listError) {
        for (const request of batch) {
          resultsByRequest.set(this.buildExactMessagePresenceRequestKey(request), {
            error: listError,
          });
        }
        continue;
      }

      const directRequests = batch.filter(
        (request) => !resultsByRequest.has(this.buildExactMessagePresenceRequestKey(request)),
      );
      let directIndex = 0;
      const workers = Array.from(
        {
          length: Math.min(MAX_API_DIRECT_MESSAGE_LOOKUP_CONCURRENCY, directRequests.length),
        },
        async () => {
          while (directIndex < directRequests.length) {
            const request = directRequests[directIndex];
            directIndex += 1;
            if (!request) {
              continue;
            }

            try {
              const data = await this.executeChatRequest(
                request.chatId,
                associatedMaxHttpOperation((owner) =>
                  this.request<Record<string, unknown>>(
                    'get',
                    `/messages/${encodeURIComponent(request.messageId)}`,
                    { ...(timeoutMs ? { timeout: timeoutMs } : {}) },
                    owner,
                  ),
                ),
                options,
              );
              const nestedMessage =
                data.message && typeof data.message === 'object' && !Array.isArray(data.message)
                  ? data.message
                  : null;
              const exactDirectMatch = [data, nestedMessage].find(
                (message) =>
                  message !== null &&
                  this.extractMessageIdFromSendResponse(message) === request.messageId,
              );
              if (!exactDirectMatch) {
                throw new Error(
                  'MAX exact message lookup returned a response without the requested id',
                );
              }
              const responseChatId = this.extractChatIdFromSendResponse(exactDirectMatch);
              if (responseChatId && responseChatId !== request.chatId) {
                throw this.createExactMessageTargetMismatchError(
                  request.chatId,
                  responseChatId,
                  request.messageId,
                );
              }
              if (
                !responseChatId &&
                new Set(
                  (requestsByMessageId.get(request.messageId) ?? []).map(
                    (groupedRequest) => groupedRequest.chatId,
                  ),
                ).size > 1
              ) {
                throw this.createUnscopedExactMessageTargetError(request.messageId);
              }
              resultsByRequest.set(this.buildExactMessagePresenceRequestKey(request), {
                presence: 'present',
              });
            } catch (error: unknown) {
              // MAX documents this endpoint's 404 as either missing or inaccessible.
              // Preserve the original error so callers cannot infer absence from access loss.
              resultsByRequest.set(this.buildExactMessagePresenceRequestKey(request), { error });
            }
          }
        },
      );
      await Promise.all(workers);
    }

    return normalizedRequests.map((request) => ({
      ...request,
      ...(resultsByRequest.get(this.buildExactMessagePresenceRequestKey(request)) ?? {
        error: new Error('MAX exact message lookup returned no result'),
      }),
    })) as MaxExactMessagePresenceResult[];
  }

  async listWebhookSubscriptions(
    options: MaxApiRequestOptions = {},
  ): Promise<MaxWebhookSubscription[]> {
    const data = await this.executeGlobalRequest(
      () => this.request<Record<string, unknown> | unknown[]>('get', '/subscriptions'),
      options,
    );
    const rows = Array.isArray(data)
      ? data
      : Array.isArray((data as { subscriptions?: unknown }).subscriptions)
        ? ((data as { subscriptions?: unknown[] }).subscriptions ?? [])
        : [];

    return rows
      .map((row) => this.parseWebhookSubscription(row))
      .filter((item): item is MaxWebhookSubscription => item !== null);
  }

  getConfiguredWebhookSubscriptionTarget(botId?: string | null): {
    url: string | null;
    maskedUrl: string | null;
  } {
    return this.botRegistry.getConfiguredWebhookSubscriptionTarget(this.resolveBot(botId).id);
  }

  matchesConfiguredWebhookUrl(url: string, botId?: string | null): boolean {
    const target = this.getConfiguredWebhookSubscriptionTarget(botId);
    if (!target.url) {
      return false;
    }

    return url.trim() === target.url;
  }

  maskWebhookUrl(url: string | null, botId?: string | null): string | null {
    if (!url) {
      return null;
    }

    const normalizedSecretPath = this.resolveBot(botId).webhookSecretPath;
    if (!normalizedSecretPath) {
      return url;
    }

    try {
      const parsed = new URL(url);
      const pathSegments = parsed.pathname.split('/');
      const lastSegment = pathSegments[pathSegments.length - 1] ?? '';
      if (lastSegment === normalizedSecretPath) {
        pathSegments[pathSegments.length - 1] = '***';
        parsed.pathname = pathSegments.join('/');
        return parsed.toString();
      }
    } catch {
      // Fall through to the string replacement fallback.
    }

    const suffix = `/${normalizedSecretPath}`;
    return url.endsWith(suffix) ? `${url.slice(0, -suffix.length)}/***` : url;
  }

  async ensureWebhookSubscription(
    requiredUpdateTypes: string[],
    options: MaxApiRequestOptions = {},
  ): Promise<MaxWebhookSubscription | null> {
    const normalizedRequired = Array.from(
      new Set(
        requiredUpdateTypes
          .map((value) => this.readLowerString(value))
          .filter((value): value is string => Boolean(value)),
      ),
    );
    const bot = this.resolveBot(options.botId);
    if (normalizedRequired.length === 0 || !bot.webhookUrl || !bot.webhookHeaderSecret) {
      return null;
    }

    const trafficClass = options.trafficClass ?? 'background';
    const sourceTag = this.normalizeMetricSourceTag(options.sourceTag) ?? undefined;
    const existing = await this.listWebhookSubscriptions({
      trafficClass,
      botId: bot.id,
      ...(sourceTag ? { sourceTag } : {}),
    });
    const current = existing.find((item) => item.url === bot.webhookUrl);
    const targetUpdateTypes = (
      options.replaceUpdateTypes === true
        ? [...normalizedRequired]
        : Array.from(new Set([...(current?.updateTypes ?? []), ...normalizedRequired]))
    ).sort();

    if (
      current &&
      options.forceUpsert !== true &&
      current.updateTypes.length === targetUpdateTypes.length &&
      current.updateTypes.every((value, index) => value === targetUpdateTypes[index])
    ) {
      return current;
    }

    await this.executeMutation(
      null,
      () =>
        this.request('post', '/subscriptions', {
          data: {
            url: bot.webhookUrl,
            update_types: targetUpdateTypes,
            secret: bot.webhookHeaderSecret,
          },
        }),
      {
        trafficClass,
        botId: bot.id,
        ...(sourceTag ? { sourceTag } : {}),
      },
      { requireExecutableBot: false },
    );

    return {
      url: bot.webhookUrl,
      updateTypes: targetUpdateTypes,
    };
  }

  async deleteWebhookSubscription(url: string, options: MaxApiRequestOptions = {}): Promise<void> {
    const normalizedUrl = this.readTrimmedString(url);
    if (!normalizedUrl) {
      return;
    }

    await this.executeMutation(
      null,
      () =>
        this.request('delete', '/subscriptions', {
          params: {
            url: normalizedUrl,
          },
        }),
      {
        trafficClass: options.trafficClass ?? 'background',
        botId: options.botId,
        ...(options.sourceTag ? { sourceTag: options.sourceTag } : {}),
      },
      { requireExecutableBot: false },
    );
  }

  async uploadImage(
    data: Buffer,
    fileName = 'broadcast-image.jpg',
    mimeType = 'image/jpeg',
    requestOptions: MaxApiRequestOptions = {},
  ): Promise<Record<string, unknown>> {
    return this.uploadBinary('image', data, fileName, mimeType, requestOptions);
  }

  validateMediaUploadPayload(uploadType: 'image', data: Buffer): Promise<MaxValidatedImageUpload>;
  validateMediaUploadPayload(uploadType: 'video', data: Buffer): Promise<MaxValidatedVideoUpload>;
  validateMediaUploadPayload(
    uploadType: 'image' | 'video',
    data: Buffer,
  ): Promise<MaxValidatedMediaUpload> {
    return uploadType === 'image'
      ? this.mediaUploadValidationCache.validate('image', data)
      : this.mediaUploadValidationCache.validate('video', data);
  }

  async uploadVideo(
    data: Buffer,
    fileName = 'video.mp4',
    mimeType = 'video/mp4',
    requestOptions: MaxApiRequestOptions = {},
  ): Promise<Record<string, unknown>> {
    return this.uploadBinary('video', data, fileName, mimeType, requestOptions);
  }

  async uploadFile(
    data: Buffer,
    fileName = 'asset.bin',
    mimeType = 'application/octet-stream',
    requestOptions: MaxApiRequestOptions = {},
  ): Promise<Record<string, unknown>> {
    return this.uploadBinary('file', data, fileName, mimeType, requestOptions);
  }

  private async uploadBinary(
    uploadType: MaxMediaAttachmentType,
    data: Buffer,
    fileName: string,
    mimeType: string,
    requestOptions: MaxApiRequestOptions = {},
  ): Promise<Record<string, unknown>> {
    this.assertUploadPayloadSize(uploadType, data);
    const validatedMedia =
      uploadType === 'image'
        ? await this.validateMediaUploadPayload('image', data)
        : uploadType === 'video'
          ? await this.validateMediaUploadPayload('video', data)
          : null;
    const safeFileName = validatedMedia
      ? this.normalizeValidatedMediaUploadFileName(
          fileName,
          validatedMedia.uploadType,
          validatedMedia.extension,
        )
      : this.normalizeUploadFileName(fileName, uploadType);
    const effectiveMimeType = validatedMedia?.mimeType ?? mimeType;
    const bot = this.resolveExecutableBot(requestOptions.botId, {
      explicit: Boolean(requestOptions.botId?.trim()),
    });
    return this.botContext.runWithBot(bot.id, async () => {
      if (uploadType === 'video' && this.resumableVideoUploadEnabled && data.length > 0) {
        return this.uploadVideoWithContentRange(
          data,
          safeFileName,
          effectiveMimeType,
          requestOptions,
          bot.id,
        );
      }

      const uploadMeta = await this.createUploadSession(uploadType, requestOptions, bot.id);
      return this.uploadMultipartToSession(
        uploadType,
        uploadMeta,
        data,
        safeFileName,
        effectiveMimeType,
        requestOptions,
      );
    });
  }

  private assertUploadPayloadSize(uploadType: MaxMediaAttachmentType, data: Buffer): void {
    if (data.length === 0) {
      throw new Error(`MAX ${uploadType} upload payload is empty`);
    }

    const limits: Record<MaxMediaAttachmentType, { maxBytes: number; label: string }> = {
      image: { maxBytes: MAX_IMAGE_UPLOAD_MAX_BYTES, label: '50 MB' },
      video: { maxBytes: MAX_VIDEO_UPLOAD_MAX_BYTES, label: '250 MB' },
      audio: { maxBytes: MAX_AUDIO_UPLOAD_MAX_BYTES, label: '256 MB' },
      file: { maxBytes: MAX_FILE_UPLOAD_MAX_BYTES, label: '4 GB' },
    };
    const limit = limits[uploadType];
    if (data.length > limit.maxBytes) {
      throw new Error(`MAX ${uploadType} upload exceeds the documented ${limit.label} limit`);
    }
  }

  async createVideoUploadSession(
    options: MaxApiRequestOptions,
  ): Promise<{ token: string; url: string }> {
    const bot = this.resolveExecutableBot(options.botId, {
      explicit: Boolean(options.botId?.trim()),
    });
    return this.botContext.runWithBot(bot.id, async () => {
      const session = await this.createUploadSession('video', options, bot.id);
      const url = new URL(session.url);
      if (
        !session.token ||
        session.token.length > 512 ||
        session.url.length > 8192 ||
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        (url.port && url.port !== '443') ||
        !url.hostname.endsWith('.okcdn.ru')
      ) {
        throw new Error('MAX video upload session is invalid');
      }
      return session;
    });
  }

  private async createUploadSession(
    uploadType: MaxMediaAttachmentType,
    requestOptions: MaxApiRequestOptions,
    botId: string,
    deadlineAtMs?: number,
  ): Promise<{ token: string; url: string }> {
    const timeoutMs =
      deadlineAtMs === undefined
        ? this.normalizeTimeoutMs(requestOptions.timeoutMs)
        : this.resolveRemainingUploadTimeoutMs(deadlineAtMs);
    const uploadMeta = await this.executeMutation(
      null,
      () => {
        const requestTimeoutMs =
          deadlineAtMs === undefined
            ? timeoutMs
            : this.resolveRemainingUploadTimeoutMs(deadlineAtMs);
        return this.request<Record<string, unknown>>('post', '/uploads', {
          params: {
            type: uploadType,
          },
          ...(requestTimeoutMs ? { timeout: requestTimeoutMs } : {}),
        });
      },
      {
        trafficClass: requestOptions.trafficClass ?? 'critical',
        actionHealthLane: requestOptions.actionHealthLane,
        sourceTag: requestOptions.sourceTag,
        timeoutMs: requestOptions.timeoutMs,
        botId,
      },
    );
    const url = typeof uploadMeta.url === 'string' ? uploadMeta.url.trim() : '';
    const token = typeof uploadMeta.token === 'string' ? uploadMeta.token.trim() : '';
    if (!url) {
      throw new Error('MAX upload URL is missing');
    }

    return { token, url };
  }

  private async uploadVideoWithContentRange(
    data: Buffer,
    fileName: string,
    mimeType: string,
    requestOptions: MaxApiRequestOptions,
    botId: string,
  ): Promise<Record<string, unknown>> {
    const deadlineAtMs =
      Date.now() +
      (this.normalizeTimeoutMs(requestOptions.timeoutMs) ?? MAX_UPLOAD_BINARY_TIMEOUT_MS);
    let lastError: unknown = null;
    for (
      let sessionAttempt = 1;
      sessionAttempt <= MAX_RESUMABLE_VIDEO_UPLOAD_SESSION_ATTEMPTS;
      sessionAttempt += 1
    ) {
      try {
        const uploadMeta = await this.createUploadSession(
          'video',
          this.withUploadDeadline(requestOptions, deadlineAtMs),
          botId,
          deadlineAtMs,
        );
        if (!uploadMeta.token) {
          return await this.uploadMultipartToSession(
            'video',
            uploadMeta,
            data,
            fileName,
            mimeType,
            this.withUploadDeadline(requestOptions, deadlineAtMs),
          );
        }

        await this.uploadVideoContentRangeChunks(uploadMeta.url, data, fileName, deadlineAtMs);
        return { token: uploadMeta.token };
      } catch (error: unknown) {
        const sanitizedError = this.sanitizeUploadError(error, 'video');
        lastError = sanitizedError;
        // FLAG: This client does not assume remote offsets; ambiguous chunks restart in a fresh session.
        if (
          sessionAttempt >= MAX_RESUMABLE_VIDEO_UPLOAD_SESSION_ATTEMPTS ||
          Date.now() >= deadlineAtMs ||
          !this.isAmbiguousUploadTransportError(error)
        ) {
          throw sanitizedError;
        }
      }
    }

    throw lastError ?? new Error('MAX video upload failed');
  }

  private async uploadVideoContentRangeChunks(
    uploadUrl: string,
    data: Buffer,
    fileName: string,
    deadlineAtMs: number,
  ): Promise<void> {
    const headerFileName = this.normalizeUploadHeaderFileName(fileName);
    for (
      let startByte = 0;
      startByte < data.length;
      startByte += MAX_RESUMABLE_VIDEO_UPLOAD_CHUNK_BYTES
    ) {
      const endExclusive = Math.min(
        data.length,
        startByte + MAX_RESUMABLE_VIDEO_UPLOAD_CHUNK_BYTES,
      );
      const endByte = endExclusive - 1;
      const chunk = data.subarray(startByte, endExclusive);
      await this.requestAbsolute<unknown>('post', uploadUrl, {
        data: chunk,
        headers: {
          'Content-Disposition': `attachment; filename="${headerFileName}"`,
          'Content-Length': String(chunk.length),
          'Content-Range': `bytes ${startByte}-${endByte}/${data.length}`,
          'Content-Type': 'application/x-binary; charset=x-user-defined',
          'X-File-Name': headerFileName,
          'X-Uploading-Mode': 'parallel',
          Connection: 'keep-alive',
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: this.resolveRemainingUploadTimeoutMs(deadlineAtMs),
        skipAuthorization: true,
      });
    }
  }

  private async uploadMultipartToSession(
    uploadType: MaxMediaAttachmentType,
    uploadMeta: { token: string; url: string },
    data: Buffer,
    fileName: string,
    mimeType: string,
    requestOptions: MaxApiRequestOptions,
  ): Promise<Record<string, unknown>> {
    const form = new FormData();
    form.append('data', data, {
      filename: fileName,
      contentType: mimeType,
    });
    let uploadResult: unknown;
    try {
      uploadResult = await this.requestAbsolute<unknown>('post', uploadMeta.url, {
        data: form,
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: requestOptions.timeoutMs ?? MAX_UPLOAD_BINARY_TIMEOUT_MS,
        skipAuthorization: true,
      });
    } catch (error: unknown) {
      throw this.sanitizeUploadError(error, uploadType);
    }

    // MAX returns a plain retval (or no payload) after successful video/audio upload.
    // Their attachment token belongs to the upload session response, not this response.
    if ((uploadType === 'video' || uploadType === 'audio') && uploadMeta.token) {
      return { token: uploadMeta.token };
    }

    if (!uploadResult || typeof uploadResult !== 'object') {
      throw new Error('MAX upload payload is missing');
    }

    const uploadPayload = uploadResult as Record<string, unknown>;
    if (Object.keys(uploadPayload).length > 0) {
      return uploadPayload;
    }

    if (uploadMeta.token) {
      return { token: uploadMeta.token };
    }

    throw new Error('MAX upload payload is missing');
  }

  private isAmbiguousUploadTransportError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    return (
      (status !== null && status >= 500 && status <= 599) || isAmbiguousMaxMutationError(error)
    );
  }

  private sanitizeUploadError(error: unknown, uploadType: MaxMediaAttachmentType): Error {
    const status = this.extractStatusCode(error);
    const rawCode = (error as { code?: unknown })?.code;
    const code =
      typeof rawCode === 'string' && rawCode.trim() ? rawCode.trim().toUpperCase() : null;
    const ambiguous = this.isAmbiguousUploadTransportError(error);
    const message = status
      ? `MAX ${uploadType} upload failed with HTTP ${status}${ambiguous ? ' after an ambiguous transport failure' : ''}`
      : `MAX ${uploadType} upload failed${
          ambiguous ? ' after an ambiguous transport timeout or connection failure' : ''
        }${code ? ` (${code})` : ''}`;
    const sanitized = new Error(message) as Error & {
      code?: string;
      response?: { status: number };
    };
    sanitized.name = 'MaxMediaUploadError';
    if (code) {
      sanitized.code = code;
    }
    if (status !== null) {
      sanitized.response = { status };
    }
    return sanitized;
  }

  private withUploadDeadline(
    requestOptions: MaxApiRequestOptions,
    deadlineAtMs: number,
  ): MaxApiRequestOptions {
    return {
      ...requestOptions,
      timeoutMs: this.resolveRemainingUploadTimeoutMs(deadlineAtMs),
    };
  }

  private resolveRemainingUploadTimeoutMs(deadlineAtMs: number): number {
    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      throw Object.assign(new Error('MAX video upload deadline exceeded'), {
        code: 'ETIMEDOUT',
      });
    }
    return Math.max(1, Math.trunc(remainingMs));
  }

  private normalizeUploadHeaderFileName(fileName: string): string {
    const extensionMatch = fileName.match(/\.[A-Za-z0-9]{1,10}$/u);
    const extension = extensionMatch?.[0] ?? '';
    const stem = extension ? fileName.slice(0, -extension.length) : fileName;
    const asciiStem = stem
      .replace(/[^\x20-\x7E]+/gu, '_')
      .replace(/[^A-Za-z0-9._ -]+/gu, '_')
      .replace(/_+/gu, '_')
      .replace(/\s+/gu, ' ')
      .replace(/[. ]+$/u, '')
      .trim();
    const safeStem = /[A-Za-z0-9]/u.test(asciiStem) ? asciiStem : 'upload';
    return `${safeStem.slice(0, MAX_UPLOAD_FILENAME_MAX_LENGTH - extension.length)}${extension}`;
  }

  private normalizeUploadFileName(
    fileName: string | null | undefined,
    uploadType: MaxMediaAttachmentType,
  ): string {
    const fallback =
      uploadType === 'image' ? 'upload.jpg' : uploadType === 'video' ? 'upload.mp4' : 'upload.bin';
    const raw = typeof fileName === 'string' ? fileName.normalize('NFC').trim() : '';
    if (!raw) {
      return fallback;
    }

    const withoutPath =
      raw
        .split(/[\\/]+/u)
        .pop()
        ?.trim() ?? '';
    const sanitized = withoutPath
      .replace(/[^\p{L}\p{N}._ -]+/gu, '_')
      .replace(/_+/gu, '_')
      .replace(/\s+/gu, ' ')
      .replace(/[. ]+$/u, '')
      .slice(0, MAX_UPLOAD_FILENAME_MAX_LENGTH)
      .trim();

    if (!sanitized || sanitized === '.' || sanitized === '..') {
      return fallback;
    }

    return sanitized;
  }

  private normalizeValidatedMediaUploadFileName(
    fileName: string | null | undefined,
    uploadType: 'image' | 'video',
    extension: string,
  ): string {
    const normalized = this.normalizeUploadFileName(fileName, uploadType);
    const rawStem = normalized.replace(/\.[^./\\]+$/u, '');
    const maxStemLength = Math.max(1, MAX_UPLOAD_FILENAME_MAX_LENGTH - extension.length - 1);
    const stem =
      rawStem
        .slice(0, maxStemLength)
        .replace(/[. ]+$/u, '')
        .trim() || 'upload';
    return `${stem}.${extension}`;
  }

  async kickMember(chatId: string, userId: string, options?: MaxActionDispatchOptions) {
    this.assertMemberActionTargetIsNotRuntimeBot('KICK_MEMBER', chatId, userId);
    await this.dispatchAction(
      {
        actionType: 'KICK_MEMBER',
        chatId,
        userId,
      },
      options,
    );
  }

  async banMember(chatId: string, userId: string, options?: MaxActionDispatchOptions) {
    this.assertMemberActionTargetIsNotRuntimeBot('BAN_MEMBER', chatId, userId);
    await this.dispatchAction(
      {
        actionType: 'BAN_MEMBER',
        chatId,
        userId,
      },
      options,
    );
  }

  async unbanMember(chatId: string, userId: string, options?: MaxActionDispatchOptions) {
    assertMaxMemberRestoreAvailable(Date.now() + Math.max(0, options?.delayMs ?? 0));
    await this.dispatchAction(
      {
        actionType: 'UNBAN_MEMBER',
        chatId,
        userId,
      },
      options,
    );
  }

  async attemptUnbanMember(chatId: string, userId: string, options: MaxActionDispatchOptions) {
    await this.dispatchAction({ actionType: 'TRY_UNBAN_MEMBER', chatId, userId }, options);
  }

  async clearTerminalBanStateAfterConfirmedUnban(
    chatId: string,
    userId: string,
    completedBefore?: Date,
  ): Promise<void> {
    if (completedBefore) {
      await this.actionLedgerService?.clearTerminalBanStateAfterUnban(
        chatId,
        userId,
        completedBefore,
      );
    } else {
      await this.actionLedgerService?.clearTerminalBanStateAfterUnban(chatId, userId);
    }
  }

  async leaveCurrentChat(chatId: string, options: MaxApiRequestOptions = {}): Promise<void> {
    try {
      await this.executeMutation(
        chatId,
        async () => {
          await this.request('delete', `/chats/${chatId}/members/me`);
        },
        options,
      );
    } catch (error: unknown) {
      if (this.isAlreadyOutsideChatError(error)) {
        return;
      }
      throw error;
    }
  }

  async cancelScheduledUnban(chatId: string, userId: string, options?: { botId?: string }) {
    const botId = this.resolveBot(options?.botId).id;
    const jobIds = [
      this.buildScheduledMemberActionJobId('UNBAN_MEMBER', chatId, userId, botId),
      this.buildScheduledMemberActionJobId('UNBAN_MEMBER', chatId, userId, botId, true),
    ].filter((jobId): jobId is string => Boolean(jobId));
    if (jobIds.length === 0) {
      return;
    }

    for (const jobId of jobIds) {
      const timeout = this.keyedActionTimeouts.get(jobId);
      if (timeout) {
        clearTimeout(timeout);
        this.pendingTimeouts.delete(timeout);
        this.keyedActionTimeouts.delete(jobId);
      }

      if (this.dispatchEnabled && this.getActionQueues().length > 0) {
        await this.removeQueuedActionJob(jobId);
      }
    }
  }

  async notifyModerators(chatId: string, text: string) {
    await this.dispatchAction({
      actionType: 'NOTIFY_MODERATORS',
      chatId,
      text,
    });
  }

  async ensureSendAutoDeleteScheduled(
    action: MaxActionJob,
    completedSend: MaxCompletedSendDispatch,
  ): Promise<void> {
    const autoDeleteDelayMs = this.normalizeDelayMs(action.autoDeleteDelayMs);
    if (autoDeleteDelayMs <= 0) {
      return;
    }
    if (action.actionType !== 'SEND_MESSAGE') {
      throw new Error('Auto-delete scheduling requires a completed SEND_MESSAGE action');
    }

    // FLAG: A confirmed SEND receipt settles its parent only. A held source must not
    // create another effect; hold-store outages leave the child uncreated for safe recovery.
    try {
      if (this.legacyHolds) await assertLegacyActionAllowed(this.legacyHolds, action);
      await this.assertLegacyMessageLinkAllowed(action.chatId, action.options?.messageLink);
    } catch (error: unknown) {
      if (error instanceof WebhookLegacyHoldRejectedError) return;
      throw error;
    }

    const persistedDispatchBotId = this.assertRecoveredSendDispatchBot(
      action,
      completedSend.dispatchBotId,
    );
    const explicitUnroutedBotId =
      !action.routing && !action.candidateBotIds?.length
        ? this.readTrimmedString(action.botId)
        : null;
    const dispatchBotId = persistedDispatchBotId ?? explicitUnroutedBotId;
    if (!dispatchBotId) {
      throw new UnrecoverableError(
        `Completed MAX SEND_MESSAGE ${action.idempotencyKey} has no persisted dispatch bot for auto-delete`,
      );
    }

    const completedAtMs = completedSend.completedAt?.getTime();
    const remainingDelayMs =
      typeof completedAtMs === 'number' && Number.isFinite(completedAtMs)
        ? Math.max(0, Math.min(autoDeleteDelayMs, completedAtMs + autoDeleteDelayMs - Date.now()))
        : autoDeleteDelayMs;

    try {
      await this.dispatchAction(
        {
          actionType: 'DELETE_MESSAGE',
          chatId: action.chatId,
          messageId: completedSend.remoteMessageId,
          ...(action.options?.messageLink
            ? { options: { messageLink: action.options.messageLink } }
            : {}),
          sendAutoDelete: {
            version: MAX_SEND_AUTO_DELETE_MARKER_VERSION,
            sourceSendJobId: action.idempotencyKey,
            sourceChatId: action.chatId,
            sourceUserId: action.userId ?? null,
            sourceMessageId: action.messageId ?? null,
            sourceCreatedAt: action.createdAt,
            sourceSendCompletedAt: completedSend.completedAt?.toISOString() ?? null,
            requestedDelayMs: autoDeleteDelayMs,
            originBotId: dispatchBotId,
          },
        },
        this.buildAutoDeleteDispatchOptions(action, dispatchBotId, remainingDelayMs),
      );
    } catch (error: unknown) {
      if (error instanceof WebhookLegacyHoldRejectedError) return;
      this.logger.warn(
        {
          chatId: action.chatId,
          messageId: completedSend.remoteMessageId,
          autoDeleteDelayMs,
          remainingDelayMs,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to enqueue auto-delete for sent bot message',
      );
      throw error;
    }
  }

  async executeActionJob(
    job: MaxActionJob,
    executionOptions: MaxActionExecutionOptions = {},
  ): Promise<MaxPublishedMessage | void> {
    const action = {
      ...job,
      attempt: Number.isInteger(job.attempt) && job.attempt > 0 ? job.attempt : 1,
    };
    const completedSendDispatch =
      typeof this.actionLedgerService?.getCompletedSendDispatchResult === 'function'
        ? await this.actionLedgerService.getCompletedSendDispatchResult(action)
        : null;
    const completedSendMessageId =
      completedSendDispatch?.remoteMessageId ??
      (typeof this.actionLedgerService?.getCompletedSendDispatchResult !== 'function'
        ? await this.actionLedgerService?.getCompletedSendDispatch?.(action)
        : null);
    if (completedSendMessageId) {
      const dispatchBotId = this.assertRecoveredSendDispatchBot(
        action,
        completedSendDispatch?.dispatchBotId ?? null,
      );
      await this.ensureSendAutoDeleteScheduled(action, {
        remoteMessageId: completedSendMessageId,
        dispatchBotId,
        completedAt: completedSendDispatch?.completedAt ?? null,
      });
      return {
        messageId: completedSendMessageId,
        url: null,
        recoveredSendDispatch: {
          dispatchBotId,
        },
      };
    }
    const bot = this.resolveExecutableBot(action.botId, {
      explicit: Boolean(action.botId?.trim()),
    });
    const requiredBotId = action.routing?.requiredBotId?.trim();
    if (requiredBotId && bot.id !== requiredBotId) {
      throw new Error('MAX action executor does not match its required bot');
    }
    const mutationOptions = this.buildQueuedActionMutationOptions(action, bot.id);
    // FLAG: Permanent legacy holds are checked at the actual transport boundary.
    // Existing feature permits remain last; recovered SEND paths never call this guard.
    const assertLegacyAction = async () => {
      if (this.legacyHolds) await assertLegacyActionAllowed(this.legacyHolds, action);
    };
    const beforeDelete = async (beforeFinalAuthority?: () => Promise<void>) => {
      await assertLegacyAction();
      if (usesMaxFinalAuthorityCheckpoint(executionOptions.beforeDeleteMutation))
        await executionOptions.beforeDeleteMutation?.(beforeFinalAuthority);
      else await executionOptions.beforeDeleteMutation?.();
    };
    const beforeMember = async (revalidateRoute?: () => Promise<void>) => {
      await assertLegacyAction();
      await executionOptions.beforeMemberMutation?.(revalidateRoute);
    };
    const beforeSend = async (revalidateRoute?: () => Promise<void>) => {
      await assertLegacyAction();
      await this.assertLegacyMessageLinkAllowed(action.chatId, action.options?.messageLink);
      await executionOptions.beforeSendMutation?.(revalidateRoute);
    };
    if (usesMaxFinalAuthorityCheckpoint(executionOptions.beforeDeleteMutation))
      withMaxFinalAuthorityCheckpoint(beforeDelete);
    if (usesMaxFinalAuthorityCheckpoint(executionOptions.beforeMemberMutation))
      withMaxFinalAuthorityCheckpoint(beforeMember);
    if (usesMaxFinalAuthorityCheckpoint(executionOptions.beforeSendMutation))
      withMaxFinalAuthorityCheckpoint(beforeSend);

    return this.botContext.runWithBot(bot.id, async () => {
      switch (action.actionType) {
        case 'DELETE_MESSAGE': {
          if (!action.messageId) {
            throw new Error('messageId is required for DELETE_MESSAGE');
          }
          const deleteMessageId = action.messageId;
          const sendAutoDeleteMarker = this.readSendAutoDeleteMarker(action, bot.id);
          if (sendAutoDeleteMarker) {
            mutationOptions.boundObject = {
              kind: 'send',
              id: sendAutoDeleteMarker.sourceSendJobId,
            };
          }
          if (
            sendAutoDeleteMarker &&
            (await this.readSendAutoDeleteExactPresence(
              action,
              deleteMessageId,
              bot.id,
              mutationOptions,
            )) === 'absent'
          ) {
            this.markSendAutoDeleteConfirmed(
              sendAutoDeleteMarker,
              MAX_SEND_AUTO_DELETE_CONFIRMATION_KINDS.EXACT_ABSENCE_PREFLIGHT,
            );
            return;
          }
          await this.executeMessageMutation(
            'delete',
            action.chatId,
            associatedMaxHttpOperation(async (owner) => {
              const response = await this.request<Record<string, unknown>>(
                'delete',
                '/messages',
                {
                  params: {
                    message_id: deleteMessageId,
                  },
                  ...(mutationOptions.timeoutMs ? { timeout: mutationOptions.timeoutMs } : {}),
                },
                owner,
              );
              return mapMaxHttpOutcome(response, (value) => {
                this.assertSuccessfulDeleteMessageResponse(value);
              });
            }),
            mutationOptions,
            beforeDelete,
          );
          if (sendAutoDeleteMarker) {
            this.markSendAutoDeleteConfirmed(
              sendAutoDeleteMarker,
              MAX_SEND_AUTO_DELETE_CONFIRMATION_KINDS.DOCUMENTED_DELETE_SUCCESS,
            );
          }
          return;
        }

        case 'SEND_MESSAGE': {
          if (typeof action.text !== 'string') {
            throw new Error('text is required for SEND_MESSAGE');
          }
          const attachments = this.buildMessageAttachments(action.options);
          const sendResponse = await this.executeQueuedSendMessage(
            action,
            attachments,
            mutationOptions,
            beforeSend,
          );
          const sentMessageId = this.extractMessageIdFromSendResponse(sendResponse);
          if (!sentMessageId) {
            throw new Error('MAX SEND_MESSAGE response has no remote message id');
          }
          const recoveredSendDispatch = sendResponse[MAX_RECOVERED_SEND_DISPATCH_RESPONSE];
          const completedSendDispatch = sendResponse[MAX_SEND_DISPATCH_COMPLETION_RESPONSE] ?? {
            remoteMessageId: sentMessageId,
            dispatchBotId: recoveredSendDispatch?.dispatchBotId ?? bot.id,
            completedAt: recoveredSendDispatch?.completedAt ?? null,
          };
          await this.ensureSendAutoDeleteScheduled(action, completedSendDispatch);
          const resolvedChatId = this.extractChatIdFromSendResponse(sendResponse);
          return {
            messageId: sentMessageId,
            url: this.parseChatLink(sendResponse),
            ...(resolvedChatId ? { chatId: resolvedChatId } : {}),
            ...(recoveredSendDispatch
              ? {
                  recoveredSendDispatch: {
                    dispatchBotId: recoveredSendDispatch.dispatchBotId,
                  },
                }
              : {}),
          };
        }

        case 'KICK_MEMBER':
          if (!action.userId) {
            throw new Error('userId is required for KICK_MEMBER');
          }
          if (
            this.skipQueuedMemberActionForRuntimeBot(
              action.actionType,
              action.chatId,
              action.userId,
            )
          ) {
            return;
          }
          await this.executeQueuedMemberModerationAction(action, mutationOptions, {
            block: false,
            beforeMutation: beforeMember,
          });
          return;

        case 'BAN_MEMBER':
          if (!action.userId) {
            throw new Error('userId is required for BAN_MEMBER');
          }
          if (
            this.skipQueuedMemberActionForRuntimeBot(
              action.actionType,
              action.chatId,
              action.userId,
            )
          ) {
            return;
          }
          await this.executeQueuedMemberModerationAction(action, mutationOptions, {
            block: true,
            beforeMutation: beforeMember,
          });
          return;

        case 'TRY_UNBAN_MEMBER': {
          // FLAG: The experimental DELETE can remove a present member. Never execute
          // a queued/recovered attempt without the caller's fresh absence/sanction guard.
          if (!action.userId || !executionOptions.beforeMemberMutation) {
            throw new UnrecoverableError('Unban attempt requires an exact user and live guard');
          }
          this.assertMemberActionTargetIsNotRuntimeBot(
            action.actionType,
            action.chatId,
            action.userId,
          );
          await this.executeQueuedMemberModerationAction(action, mutationOptions, {
            block: false,
            explicitBlock: true,
            beforeMutation: beforeMember,
          });
          return;
        }

        case 'UNBAN_MEMBER': {
          if (!action.userId) {
            throw new Error('userId is required for UNBAN_MEMBER');
          }
          assertMaxMemberRestoreAvailable();
          let memberMutationAttempted = false;
          try {
            await this.executeMemberMutation(
              action.chatId,
              'post',
              async () => {
                const response = await this.request('post', `/chats/${action.chatId}/members`, {
                  data: {
                    user_ids: [action.userId],
                  },
                  ...(mutationOptions.timeoutMs ? { timeout: mutationOptions.timeoutMs } : {}),
                });
                this.assertSuccessfulMemberMutationResponse(response);
              },
              mutationOptions,
              async (revalidateRoute) => {
                await beforeMember?.(revalidateRoute);
                assertMaxMemberRestoreAvailable();
              },
              () => {
                memberMutationAttempted = true;
              },
            );
          } catch (error: unknown) {
            if (!this.isAlreadyPresentChatMemberError(error)) {
              throw memberMutationAttempted ? markMaxMemberMutationAttempted(error) : error;
            }
          }
          try {
            await this.clearTerminalBanStateAfterConfirmedUnban(action.chatId, action.userId);
          } catch (error: unknown) {
            throw memberMutationAttempted ? markMaxMemberMutationConfirmed(error) : error;
          }
          return;
        }

        case 'NOTIFY_MODERATORS':
          this.logger.warn({ chatId: action.chatId, text: action.text ?? '' }, 'Moderator alert');
          this.actionHealthService.recordSuccess(bot.id);
          return;
      }
    });
  }

  async getChatTitle(chatId: string, options: MaxApiRequestOptions = {}): Promise<string | null> {
    const timeoutMs = this.normalizeTimeoutMs(options.timeoutMs);
    const data = await this.executeChatRequest(
      chatId,
      async () =>
        this.request<Record<string, unknown>>('get', `/chats/${chatId}`, {
          ...(timeoutMs ? { timeout: timeoutMs } : {}),
        }),
      options,
    );
    return this.readTrimmedString(data.title ?? data.name);
  }

  async getChatSnapshot(
    chatId: string,
    options: MaxApiRequestOptions = {},
  ): Promise<MaxChatSnapshot> {
    const normalizedChatId = chatId.trim();
    const botId = this.resolveBot(options.botId).id;
    const timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.trunc(options.timeoutMs))
        : undefined;
    if (!options.bypassCache) {
      const cachedSnapshot = await this.readJsonCache(
        this.buildChatSnapshotCacheKey(botId, normalizedChatId),
        this.isMaxChatSnapshot.bind(this),
      );
      if (cachedSnapshot) {
        return { ...cachedSnapshot };
      }
    }

    const data = await this.executeChatRequest(
      normalizedChatId,
      associatedMaxHttpOperation((owner) =>
        this.request<Record<string, unknown>>(
          'get',
          `/chats/${normalizedChatId}`,
          {
            ...(timeoutMs ? { timeout: timeoutMs } : {}),
          },
          owner,
        ),
      ),
      options,
    );
    const link = this.parseChatLink(data);
    const isPublic = this.readBoolean(data.is_public ?? data.isPublic ?? data.public);

    const snapshot: MaxChatSnapshot = {
      chatId: normalizedChatId,
      title: this.readTrimmedString(data.title ?? data.name),
      ...(typeof data.description === 'string'
        ? { description: this.readTrimmedString(data.description) }
        : {}),
      participantsCount: this.readNullableInteger(
        data.participants_count ??
          data.participantsCount ??
          data.members_count ??
          data.membersCount,
      ),
      status: this.readLowerString(data.status),
      isPublic: isPublic ?? (link ? true : null),
      link,
      lastEventAt: this.readIsoDateTime(
        data.last_event_time ?? data.lastEventTime ?? data.updated_at ?? data.updatedAt,
      ),
      entityType: this.parseChatEntityType(data),
      ...readMaxChatAvatar(data),
    };

    if (!options.bypassCache) {
      await this.writeJsonCache(
        this.buildChatSnapshotCacheKey(botId, normalizedChatId),
        snapshot,
        this.chatSnapshotCacheTtlSec,
      );
    }

    return snapshot;
  }

  async getChannelSnapshotByLink(
    chatLink: string,
    options: MaxApiRequestOptions = {},
  ): Promise<MaxChatSnapshot> {
    const normalizedChatLink = chatLink.trim().replace(/^\/+/u, '');
    const botId = this.resolveBot(options.botId).id;
    const timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.trunc(options.timeoutMs))
        : undefined;
    if (!normalizedChatLink) {
      throw new Error('MAX chat link is required');
    }

    const data = await this.executeGlobalRequest(
      () =>
        this.request<Record<string, unknown>>(
          'get',
          `/chats/${encodeURIComponent(normalizedChatLink)}`,
          {
            ...(timeoutMs ? { timeout: timeoutMs } : {}),
          },
        ),
      options,
    );
    const chatId = data.chat_id ?? data.chatId ?? data.id;
    const normalizedChatId =
      typeof chatId === 'string' || typeof chatId === 'number'
        ? String(chatId).trim()
        : normalizedChatLink;
    const link = this.parseChatLink(data);
    const isPublic = this.readBoolean(data.is_public ?? data.isPublic ?? data.public);
    const snapshot: MaxChatSnapshot = {
      chatId: normalizedChatId,
      title: this.readTrimmedString(data.title ?? data.name),
      ...(typeof data.description === 'string'
        ? { description: this.readTrimmedString(data.description) }
        : {}),
      participantsCount: this.readNullableInteger(
        data.participants_count ??
          data.participantsCount ??
          data.members_count ??
          data.membersCount,
      ),
      status: this.readLowerString(data.status),
      isPublic: isPublic ?? (link ? true : null),
      link,
      lastEventAt: this.readIsoDateTime(
        data.last_event_time ?? data.lastEventTime ?? data.updated_at ?? data.updatedAt,
      ),
      entityType: this.parseChatEntityType(data),
      ...readMaxChatAvatar(data),
    };

    if (!options.bypassCache && normalizedChatId) {
      await this.writeJsonCache(
        this.buildChatSnapshotCacheKey(botId, normalizedChatId),
        snapshot,
        this.chatSnapshotCacheTtlSec,
      );
    }

    return snapshot;
  }

  async getChatAdminAccesses(
    chatId: string,
    options: MaxApiRequestOptions = {},
  ): Promise<MaxChatMemberAccess[]> {
    const members = await this.listChatAdminMembers(chatId.trim(), options);
    return members.map((member) => this.parseChatMemberAccess(member));
  }

  async getChatAdminIds(chatId: string, options: MaxApiRequestOptions = {}): Promise<string[]> {
    const normalizedChatId = chatId.trim();
    const botId = this.resolveBot(options.botId).id;
    const cacheKey = this.buildChatAdminIdsCacheKey(botId, normalizedChatId);
    if (!options.bypassCache) {
      const cachedAdminIds = await this.readJsonCache(cacheKey, (value): value is string[] =>
        this.isStringArray(value),
      );
      if (cachedAdminIds) {
        return [...cachedAdminIds];
      }

      const existingInFlight = this.chatAdminIdsInFlight.get(cacheKey);
      if (existingInFlight) {
        return [...(await existingInFlight)];
      }
    }

    const pending = this.fetchChatAdminIdsUncached(normalizedChatId, botId, options).finally(() => {
      if (this.chatAdminIdsInFlight.get(cacheKey) === pending) {
        this.chatAdminIdsInFlight.delete(cacheKey);
      }
    });
    if (!options.bypassCache) {
      this.chatAdminIdsInFlight.set(cacheKey, pending);
    }

    return [...(await pending)];
  }

  /**
   * Returns the admin roster with MAX's bot marker preserved. Keep this separate
   * from getChatAdminIds: ownership and access callers intentionally include bot
   * administrators, while private human-recipient flows must be able to exclude
   * bot-to-bot deliveries.
   */
  // FLAG: Official admins GET documents only chatId input. A response marker means incomplete;
  // never invent a continuation/count request or cache this page as a complete authorization roster.
  async getChatAdminMembersPage(
    chatId: string,
    options: MaxApiRequestOptions = {},
  ): Promise<{
    members: Array<MaxChatMemberProfile & { isBot: boolean | null }>;
    complete: boolean;
  }> {
    chatId = chatId.trim();
    if (!chatId) throw new Error('MAX chat ID is required');
    const data = await this.executeChatRequest(
      chatId,
      () =>
        this.request<Record<string, unknown>>(
          'get',
          `/chats/${encodeURIComponent(chatId)}/members/admins`,
          { ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}) },
        ),
      options,
    );
    if (!Array.isArray(data?.members) || data.members.some((row) => !this.readMemberUserId(row)))
      throw new Error('Invalid MAX chat admin members response');
    const marker = data.marker;
    if (
      marker !== null &&
      marker !== undefined &&
      ((typeof marker !== 'string' && typeof marker !== 'number') ||
        (typeof marker === 'number' && (!Number.isFinite(marker) || !Number.isInteger(marker))) ||
        String(marker).trim().length === 0)
    )
      throw new Error('Invalid MAX chat admin pagination marker');
    return {
      members: data.members.flatMap((row) => {
        if (!this.isChatAdminMemberRow(row as Record<string, unknown>)) return [];
        const profile = this.parseChatMemberProfile(row);
        return profile ? [{ ...profile, isBot: this.readExplicitChatMemberBotState(row) }] : [];
      }),
      complete: marker === null || marker === undefined,
    };
  }

  async getChatAdminMembers(
    chatId: string,
    options: MaxApiRequestOptions = {},
  ): Promise<MaxChatAdminMember[]> {
    const normalizedChatId = chatId.trim();
    const botId = this.resolveBot(options.botId).id;
    const cacheKey = this.buildChatAdminMembersCacheKey(botId, normalizedChatId);
    if (!options.bypassCache) {
      const cached = await this.readJsonCache(cacheKey, (value): value is MaxChatAdminMember[] =>
        this.isChatAdminMemberArray(value),
      );
      if (cached) {
        return cached.map((member) => ({ ...member }));
      }

      const existingInFlight = this.chatAdminMembersInFlight.get(cacheKey);
      if (existingInFlight) {
        return (await existingInFlight).map((member) => ({ ...member }));
      }
    }

    const pending = this.fetchChatAdminMembersUncached(normalizedChatId, options).finally(() => {
      if (this.chatAdminMembersInFlight.get(cacheKey) === pending) {
        this.chatAdminMembersInFlight.delete(cacheKey);
      }
    });
    if (!options.bypassCache) {
      this.chatAdminMembersInFlight.set(cacheKey, pending);
    }

    return (await pending).map((member) => ({ ...member }));
  }

  private async fetchChatAdminMembersUncached(
    chatId: string,
    options: MaxApiRequestOptions,
  ): Promise<MaxChatAdminMember[]> {
    const members = await this.listChatAdminMembers(chatId, options);
    const adminMembers = members
      .map((member): MaxChatAdminMember | null => {
        if (!member || typeof member !== 'object') {
          return null;
        }

        const row = member as Record<string, unknown>;
        if (!this.isChatAdminMemberRow(row)) {
          return null;
        }

        const userId = this.readMemberUserId(row);
        if (!userId) {
          return null;
        }

        return {
          userId,
          // MAX documents is_bot as an explicit ChatMember field. Do not infer
          // from usernames here: a human may legitimately have a *_bot handle.
          isBot: this.readExplicitChatMemberBot(row),
        };
      })
      .filter((member): member is MaxChatAdminMember => member !== null);

    if (!options.bypassCache) {
      await this.writeJsonCache(
        this.buildChatAdminMembersCacheKey(this.resolveBot(options.botId).id, chatId),
        adminMembers,
        this.chatAdminIdsCacheTtlSec,
      );
    }

    return adminMembers;
  }

  private async fetchChatAdminIdsUncached(
    chatId: string,
    botId: string,
    options: MaxApiRequestOptions,
  ): Promise<string[]> {
    const members = await this.listChatAdminMembers(chatId, options);

    const adminIds = members
      .map((member) => {
        if (!member || typeof member !== 'object') {
          return null;
        }

        const row = member as Record<string, unknown>;
        if (!this.isChatAdminMemberRow(row)) {
          return null;
        }

        return this.readMemberUserId(row);
      })
      .filter((value): value is string => value !== null);

    if (!options.bypassCache) {
      await this.writeJsonCache(
        this.buildChatAdminIdsCacheKey(botId, chatId),
        adminIds,
        this.chatAdminIdsCacheTtlSec,
      );
    }

    return adminIds;
  }

  async getCurrentChatMemberAccess(
    chatId: string,
    options: MaxApiRequestOptions = {},
  ): Promise<MaxChatMemberAccess> {
    const normalizedChatId = chatId.trim();
    const botId = this.resolveBot(options.botId).id;
    const bypassCache = options.bypassCache || options.explicitActivation !== undefined;
    const activationState = this.maxBotLinkService?.assertChatBotAccessProbeAllowed
      ? await this.maxBotLinkService.assertChatBotAccessProbeAllowed(
          normalizedChatId,
          botId,
          options.explicitActivation,
        )
      : null;
    const isCompleteSelfAccess = (access: MaxChatMemberAccess) =>
      (access.isAdmin || access.isOwner
        ? access.explicitPrivilegeEvidence === true
        : access.explicitNonPrivilegeEvidence === true) &&
      !hasIncompleteManagedEntityPermissionEvidence(access, activationState?.permissionsSnapshot);
    const effectiveAccess = (access: MaxChatMemberAccess) => {
      // FLAG: Partial role/capability evidence cannot revoke a retained grant or become
      // a successful fresh authorization. A later complete probe may proceed normally.
      if (!isCompleteSelfAccess(access)) throw new Error('MAX bot access evidence is incomplete');
      return options.explicitActivation || !this.maxBotLinkService?.restrictPassiveBotAccess
        ? access
        : this.maxBotLinkService.restrictPassiveBotAccess(botId, access, activationState);
    };
    // FLAG: A cached/live positive probe cannot wake a bot with confirmed lost rights.
    // Only the exact persisted administrator activation receipt permits this fresh read.
    const cacheKey = this.buildCurrentChatMemberAccessCacheKey(botId, normalizedChatId);
    if (!bypassCache) {
      const cachedAccess = await this.readJsonCache(
        cacheKey,
        (value): value is MaxChatMemberAccess => this.isMaxChatMemberAccess(value),
      );
      if (cachedAccess && isCompleteSelfAccess(cachedAccess)) {
        return effectiveAccess({ ...cachedAccess, permissions: [...cachedAccess.permissions] });
      }

      const existingInFlight = this.currentChatMemberAccessInFlight.get(cacheKey);
      if (existingInFlight) {
        const access = await existingInFlight;
        return effectiveAccess({ ...access, permissions: [...access.permissions] });
      }
    }

    const pending = this.fetchCurrentChatMemberAccessUncached(normalizedChatId, botId, options)
      .then(async (access) => {
        const effective = effectiveAccess(access);
        if (!bypassCache) {
          await this.writeJsonCache(
            cacheKey,
            effective,
            this.resolveChatMemberAccessCacheTtlSec(effective),
          );
        }
        return effective;
      })
      .finally(() => {
        if (this.currentChatMemberAccessInFlight.get(cacheKey) === pending) {
          this.currentChatMemberAccessInFlight.delete(cacheKey);
        }
      });
    if (!bypassCache) {
      this.currentChatMemberAccessInFlight.set(cacheKey, pending);
    }

    const access = await pending;
    return { ...access, permissions: [...access.permissions] };
  }

  private async fetchCurrentChatMemberAccessUncached(
    chatId: string,
    _botId: string,
    options: MaxApiRequestOptions,
  ): Promise<MaxChatMemberAccess> {
    const timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.trunc(options.timeoutMs))
        : undefined;
    const data = await this.executeChatRequest(
      chatId,
      associatedMaxHttpOperation((owner) =>
        this.request<Record<string, unknown>>(
          'get',
          `/chats/${chatId}/members/me`,
          {
            ...(timeoutMs ? { timeout: timeoutMs } : {}),
          },
          owner,
        ),
      ),
      options,
    );
    return this.parseChatMemberAccess(data);
  }

  async getChatMemberAccess(
    chatId: string,
    userId: string,
    options: MaxApiRequestOptions = {},
  ): Promise<MaxChatMemberAccess | null> {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      return null;
    }
    const failureObserver =
      options.bypassCache === true
        ? observeBoundReadHttp429({
            kind: 'chat_member',
            chatId: chatId.trim(),
            userId: normalizedUserId,
            botId: this.resolveBot(options.botId).id,
          })
        : undefined;
    let accessByUserId: Map<string, MaxChatMemberAccess>;
    try {
      accessByUserId = failureObserver
        ? await this.getChatMembersAccessObserved(
            chatId,
            [normalizedUserId],
            options,
            failureObserver,
          )
        : await this.getChatMembersAccess(chatId, [normalizedUserId], options);
    } catch (error) {
      if (failureObserver) discardForeignReadHttp429(error, failureObserver);
      else if (error && typeof error === 'object') observedReadHttp429Errors.delete(error);
      throw error;
    }
    return accessByUserId.get(normalizedUserId) ?? null;
  }

  async getChatMembersAccess(
    chatId: string,
    userIds: readonly string[],
    options: MaxApiRequestOptions = {},
  ): Promise<Map<string, MaxChatMemberAccess>> {
    return this.getChatMembersAccessObserved(chatId, userIds, options);
  }

  private async getChatMembersAccessObserved(
    chatId: string,
    userIds: readonly string[],
    options: MaxApiRequestOptions,
    failureObserver?: MaxReadFailureObserver,
  ): Promise<Map<string, MaxChatMemberAccess>> {
    const normalizedChatId = chatId.trim();
    const botId = this.resolveBot(options.botId).id;
    const timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.trunc(options.timeoutMs))
        : undefined;
    const normalizedUserIds = Array.from(
      new Set(
        userIds.map((value) => value.trim()).filter((value): value is string => value.length > 0),
      ),
    );
    if (normalizedUserIds.length === 0) {
      return new Map();
    }

    const accessByUserId = new Map<string, MaxChatMemberAccess>();
    const missingUserIds: string[] = [];

    if (!options.bypassCache) {
      const cachedRows = await Promise.all(
        normalizedUserIds.map(async (userId) => ({
          userId,
          access: await this.readJsonCache(
            this.buildChatMemberAccessCacheKey(botId, normalizedChatId, userId),
            (value): value is MaxChatMemberAccess => this.isMaxChatMemberAccess(value),
          ),
        })),
      );
      for (const row of cachedRows) {
        if (row.access) {
          accessByUserId.set(row.userId, {
            ...row.access,
            permissions: [...row.access.permissions],
          });
        } else {
          missingUserIds.push(row.userId);
        }
      }
    } else {
      missingUserIds.push(...normalizedUserIds);
    }

    for (let index = 0; index < missingUserIds.length; index += 100) {
      const chunk = missingUserIds.slice(index, index + 100);
      const loads = new Set<Promise<Map<string, MaxChatMemberAccess>>>();
      const uncovered = chunk.filter((userId) => {
        const existing = !options.bypassCache
          ? this.chatMembersAccessInFlight.get(
              this.buildChatMemberAccessCacheKey(botId, normalizedChatId, userId),
            )
          : undefined;
        if (existing) loads.add(existing);
        return !existing;
      });
      if (uncovered.length > 0) {
        const pending = this.fetchChatMembersAccessChunkUncached(
          normalizedChatId,
          uncovered,
          options,
          timeoutMs,
          failureObserver,
        )
          .then(async (fetched) => {
            // FLAG: Keep exact bot/chat/member aliases until cache fill really settles.
            // Partial batch fills and overlapping callers must share the same GET and SETs;
            // explicit fresh authorization bypasses both sharing and cache population.
            if (!options.bypassCache)
              for (const [userId, access] of fetched) {
                await this.writeJsonCache(
                  this.buildChatMemberAccessCacheKey(botId, normalizedChatId, userId),
                  access,
                  this.resolveChatMemberAccessCacheTtlSec(access),
                );
              }
            return fetched;
          })
          .finally(() => {
            for (const userId of uncovered) {
              const key = this.buildChatMemberAccessCacheKey(botId, normalizedChatId, userId);
              if (this.chatMembersAccessInFlight.get(key) === pending)
                this.chatMembersAccessInFlight.delete(key);
            }
          });
        if (!options.bypassCache) {
          for (const userId of uncovered)
            this.chatMembersAccessInFlight.set(
              this.buildChatMemberAccessCacheKey(botId, normalizedChatId, userId),
              pending,
            );
        }
        loads.add(pending);
      }

      for (const fetched of await Promise.all(loads)) {
        for (const userId of chunk) {
          const access = fetched.get(userId);
          if (access)
            accessByUserId.set(userId, { ...access, permissions: [...access.permissions] });
        }
      }
    }

    return accessByUserId;
  }

  private async fetchChatMembersAccessChunkUncached(
    chatId: string,
    userIds: readonly string[],
    options: MaxApiRequestOptions,
    timeoutMs?: number,
    failureObserver?: MaxReadFailureObserver,
  ): Promise<Map<string, MaxChatMemberAccess>> {
    const accessByUserId = new Map<string, MaxChatMemberAccess>();
    if (userIds.length === 0) {
      return accessByUserId;
    }

    for (let index = 0; index < userIds.length; index += 100) {
      const chunk = userIds.slice(index, index + 100);
      const query = new URLSearchParams({ user_ids: chunk.join(',') });

      const data = await this.executeChatRequest(
        chatId,
        associatedMaxHttpOperation(async (owner) =>
          this.request<Record<string, unknown>>(
            'get',
            `/chats/${chatId}/members?${query.toString()}`,
            {
              ...(timeoutMs ? { timeout: timeoutMs } : {}),
            },
            owner,
          ),
        ),
        options,
        failureObserver,
      );
      const members = Array.isArray(data?.members)
        ? data.members
        : Array.isArray(data?.users)
          ? data.users
          : null;
      // FLAG: A malformed lookup is unknown, never proof that a user lost membership.
      if (!members || members.some((member) => !this.readMemberUserId(member))) {
        throw new Error('Invalid MAX chat members response');
      }

      for (const member of members) {
        const access = this.parseChatMemberAccess(member);
        if (!access.userId) {
          continue;
        }

        accessByUserId.set(access.userId, access);
      }
    }

    return accessByUserId;
  }

  async hasChatMember(
    chatId: string,
    userId: string,
    options: MaxApiRequestOptions = {},
  ): Promise<boolean> {
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      return false;
    }
    const timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.trunc(options.timeoutMs))
        : undefined;

    const data = await this.executeChatRequest(
      chatId,
      async () =>
        this.request<Record<string, unknown>>('get', `/chats/${chatId}/members`, {
          ...(timeoutMs ? { timeout: timeoutMs } : {}),
          params: {
            user_ids: normalizedUserId,
          },
        }),
      options,
    );
    const members = Array.isArray(data?.members)
      ? data.members
      : Array.isArray(data?.users)
        ? data.users
        : null;
    // FLAG: An invalid successful lookup is unknown, never proof of missing membership.
    if (!members || members.some((member) => !this.readMemberUserId(member))) {
      throw new Error('Invalid MAX chat members response');
    }

    return members.some((member) => this.readMemberUserId(member) === normalizedUserId);
  }

  async getChatMemberProfiles(
    chatId: string,
    userIds: readonly string[],
    options: MaxApiRequestOptions = {},
  ): Promise<Map<string, MaxChatMemberProfile>> {
    const timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.trunc(options.timeoutMs))
        : undefined;
    const normalizedUserIds = Array.from(
      new Set(
        userIds.map((value) => value.trim()).filter((value): value is string => value.length > 0),
      ),
    );
    if (normalizedUserIds.length === 0) {
      return new Map();
    }

    const profiles = new Map<string, MaxChatMemberProfile>();

    for (let index = 0; index < normalizedUserIds.length; index += 100) {
      const chunk = normalizedUserIds.slice(index, index + 100);
      const query = new URLSearchParams({ user_ids: chunk.join(',') });

      const data = await this.executeChatRequest(
        chatId,
        async () =>
          this.request<Record<string, unknown>>(
            'get',
            `/chats/${chatId}/members?${query.toString()}`,
            {
              ...(timeoutMs ? { timeout: timeoutMs } : {}),
            },
          ),
        options,
      );
      const members = Array.isArray(data.members)
        ? data.members
        : Array.isArray(data.users)
          ? data.users
          : [];

      for (const member of members) {
        const profile = this.parseChatMemberProfile(member);
        if (!profile) {
          continue;
        }

        profiles.set(profile.userId, profile);
      }
    }

    return profiles;
  }

  async getChatMembersPage(
    chatId: string,
    query: {
      limit?: number;
      marker?: string | null;
    } = {},
    options: MaxApiRequestOptions = {},
  ): Promise<MaxChatMembersPage> {
    const timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.trunc(options.timeoutMs))
        : undefined;
    const limit =
      typeof query.limit === 'number' && Number.isFinite(query.limit)
        ? Math.max(1, Math.min(100, Math.trunc(query.limit)))
        : 100;
    const marker = query.marker?.trim() ?? '';
    const params: Record<string, string | number> = {
      count: limit,
    };
    if (marker) {
      params.marker = marker;
    }

    const data = await this.executeChatRequest(
      chatId,
      async () =>
        this.request<Record<string, unknown>>('get', `/chats/${chatId}/members`, {
          params,
          ...(timeoutMs ? { timeout: timeoutMs } : {}),
        }),
      options,
    );
    const members = Array.isArray(data.members)
      ? data.members
      : Array.isArray(data.users)
        ? data.users
        : [];

    return {
      items: members
        .map((member): MaxChatRosterMember | null => {
          const profile = this.parseChatMemberProfile(member);
          if (!profile?.userId) {
            return null;
          }

          return {
            userId: profile.userId,
            displayName: profile.displayName,
            username: profile.username,
            avatarUrl: profile.avatarUrl,
            profileUrl: profile.profileUrl,
            role: this.parseChatMemberRole(member),
            isBot: this.parseChatMemberBot(member, profile),
            unavailableReason: this.parseChatMemberUnavailableReason(member),
            lastMaxActivityAt: readMaxMemberActivity(member),
            activityCheckedAt: new Date().toISOString(),
          };
        })
        .filter((member): member is MaxChatRosterMember => member !== null),
      nextMarker:
        typeof data.marker === 'string' || typeof data.marker === 'number'
          ? String(data.marker).trim() || null
          : null,
    };
  }

  async getOwnProfile(options: MaxApiRequestOptions = {}): Promise<MaxChatMemberProfile> {
    const bot = this.resolveBot(options.botId);
    const timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.trunc(options.timeoutMs))
        : undefined;
    const data = await this.executeGlobalRequest(
      async () =>
        this.request<Record<string, unknown>>('get', '/me', {
          ...(timeoutMs ? { timeout: timeoutMs } : {}),
        }),
      options,
    );

    return {
      userId:
        this.readTrimmedString(data.user_id ?? data.userId ?? data.id) ?? bot.contactId ?? bot.id,
      displayName: resolveMaxUserDisplayName(data),
      username: this.readTrimmedString(data.username),
      avatarUrl: this.readTrimmedString(
        data.full_avatar_url ?? data.fullAvatarUrl ?? data.avatar_url ?? data.avatarUrl,
      ),
      profileUrl: this.readProfileUrl(
        data.profile_url,
        data.profileUrl,
        data.url,
        data.link,
        data.username ? `https://max.ru/${String(data.username).trim()}` : null,
      ),
    };
  }

  async getOwnProfileIdentity(
    options: MaxApiRequestOptions = {},
  ): Promise<PublisherRemoteIdentity> {
    const requestedBotId = this.readTrimmedString(options.botId);
    const bot = this.resolveBot(requestedBotId);
    if (requestedBotId && bot.id !== requestedBotId) {
      throw new UnrecoverableError(
        'The requested MAX bot is not configured for exact identity lookup',
      );
    }
    const timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.trunc(options.timeoutMs))
        : undefined;
    const data = await this.executeGlobalRequest(
      async () =>
        this.request<Record<string, unknown>>('get', '/me', {
          ...(timeoutMs ? { timeout: timeoutMs } : {}),
        }),
      { ...options, botId: bot.id },
    );
    return extractPublisherRemoteIdentity(data);
  }

  async listBotChats(options: MaxApiRequestOptions = {}): Promise<MaxBotChat[]> {
    if (this.isProduction) {
      throw new Error(MAX_LIST_BOT_CHATS_UNSUPPORTED_IN_PRODUCTION);
    }

    const botId = this.resolveBot(options.botId).id;
    if (!options.bypassCache) {
      const cachedChats = await this.readJsonCache(
        this.buildListBotChatsCacheKey(botId),
        this.isMaxBotChatList.bind(this),
      );
      if (cachedChats) {
        return cachedChats.map((chat) => ({ ...chat }));
      }
    }

    const inFlightKey = `${botId}:${options.bypassCache === true ? 'bypass' : 'cache'}`;
    const existingInFlight = this.listBotChatsInFlight.get(inFlightKey);
    if (existingInFlight) {
      const chats = await existingInFlight;
      return chats.map((chat) => ({ ...chat }));
    }

    const pending = this.fetchBotChatsUncached(botId, options).finally(() => {
      if (this.listBotChatsInFlight.get(inFlightKey) === pending) {
        this.listBotChatsInFlight.delete(inFlightKey);
      }
    });
    this.listBotChatsInFlight.set(inFlightKey, pending);

    const chats = await pending;
    return chats.map((chat) => ({ ...chat }));
  }

  private async fetchBotChatsUncached(
    botId: string,
    options: MaxApiRequestOptions,
  ): Promise<MaxBotChat[]> {
    const results: MaxBotChat[] = [];
    const seenMarkers = new Set<string>();
    let marker: string | number | null = null;

    let pagesFetched = 0;
    while (pagesFetched < MAX_API_LIST_BOT_CHATS_PAGE_SAFETY_CAP) {
      pagesFetched += 1;
      const pageData: Record<string, unknown> = await this.executeGlobalRequest(
        () =>
          this.request('get', '/chats', {
            params: {
              count: 100,
              ...(marker !== null ? { marker } : {}),
            },
          }),
        options,
      );

      const pageChats = Array.isArray(pageData.chats) ? pageData.chats : [];
      for (const item of pageChats) {
        if (!item || typeof item !== 'object') {
          continue;
        }

        const row = item as Record<string, unknown>;
        const chatId = row.chat_id ?? row.chatId ?? row.id;
        if (typeof chatId !== 'string' && typeof chatId !== 'number') {
          continue;
        }

        const title = row.title ?? row.name;
        const lastEventTime = row.last_event_time ?? row.lastEventTime;
        const entityType = this.parseChatEntityType(row);
        const link = this.parseChatLink(row);
        results.push({
          chatId: String(chatId),
          title: typeof title === 'string' ? title : null,
          lastEventTime:
            typeof lastEventTime === 'number'
              ? lastEventTime
              : typeof lastEventTime === 'string' && lastEventTime.trim() !== ''
                ? Number(lastEventTime)
                : null,
          entityType,
          link,
          avatarUrl: this.parseChatAvatarUrl(row),
          botId,
          botIds: [botId],
        });
      }

      const nextMarker: unknown = pageData.marker;
      if (
        nextMarker === null ||
        nextMarker === undefined ||
        (typeof nextMarker !== 'string' && typeof nextMarker !== 'number')
      ) {
        break;
      }

      const markerKey = String(nextMarker);
      if (seenMarkers.has(markerKey)) {
        break;
      }
      seenMarkers.add(markerKey);
      marker = nextMarker;
    }

    if (pagesFetched >= MAX_API_LIST_BOT_CHATS_PAGE_SAFETY_CAP && marker !== null) {
      this.logger.warn(
        {
          botId,
          pagesFetched,
          marker,
        },
        'Stopped MAX bot chat discovery after reaching pagination safety cap',
      );
    }

    if (!options.bypassCache) {
      await this.writeJsonCache(
        this.buildListBotChatsCacheKey(botId),
        results,
        this.listBotChatsCacheTtlSec,
      );
    }

    return results;
  }

  private buildListBotChatsCacheKey(botId: string): string {
    return `maxapi:cache:v1:list-bot-chats:${botId}`;
  }

  private buildChatSnapshotCacheKey(botId: string, chatId: string): string {
    return `maxapi:cache:v1:chat-snapshot:${botId}:${chatId}`;
  }

  private buildCurrentChatMemberAccessCacheKey(botId: string, chatId: string): string {
    return `maxapi:cache:v1:chat-member-access:${botId}:${chatId}:__self`;
  }

  private buildChatMemberAccessCacheKey(botId: string, chatId: string, userId: string): string {
    return `maxapi:cache:v1:chat-member-access:${botId}:${chatId}:${userId}`;
  }

  private buildChatAdminIdsCacheKey(botId: string, chatId: string): string {
    return `maxapi:cache:v1:chat-admin-ids:${botId}:${chatId}`;
  }

  private buildChatAdminMembersCacheKey(botId: string, chatId: string): string {
    return `maxapi:cache:v1:chat-admin-members:${botId}:${chatId}`;
  }

  private async readJsonCache<T>(
    key: string,
    guard: (value: unknown) => value is T,
  ): Promise<T | null> {
    const rawValue = await this.limiterRedis.get(key);
    if (!rawValue) {
      return null;
    }

    try {
      const parsed = JSON.parse(rawValue) as unknown;
      if (guard(parsed)) {
        return parsed;
      }
    } catch {
      // Ignore malformed cache entries and refresh them from MAX.
    }

    await this.limiterRedis.del(key);
    return null;
  }

  private async writeJsonCache(key: string, value: unknown, ttlSec: number): Promise<void> {
    if (!Number.isFinite(ttlSec) || ttlSec <= 0) {
      return;
    }

    await this.limiterRedis.set(key, JSON.stringify(value), 'EX', Math.trunc(ttlSec));
  }

  private isMaxBotChatList(value: unknown): value is MaxBotChat[] {
    return Array.isArray(value) && value.every((item) => this.isMaxBotChat(item));
  }

  private isMaxBotChat(value: unknown): value is MaxBotChat {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }

    const row = value as Record<string, unknown>;
    return (
      typeof row.chatId === 'string' &&
      (typeof row.title === 'string' || row.title === null) &&
      (typeof row.lastEventTime === 'number' || row.lastEventTime === null) &&
      (row.entityType === 'chat' || row.entityType === 'channel') &&
      (typeof row.link === 'string' || row.link === null) &&
      (typeof row.avatarUrl === 'string' || row.avatarUrl === null)
    );
  }

  private isMaxChatSnapshot(value: unknown): value is MaxChatSnapshot {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }

    const row = value as Record<string, unknown>;
    return (
      typeof row.chatId === 'string' &&
      (typeof row.title === 'string' || row.title === null) &&
      (row.description === undefined ||
        row.description === null ||
        typeof row.description === 'string') &&
      (typeof row.participantsCount === 'number' || row.participantsCount === null) &&
      (typeof row.status === 'string' || row.status === null) &&
      (typeof row.isPublic === 'boolean' || row.isPublic === null) &&
      (typeof row.link === 'string' || row.link === null) &&
      (typeof row.lastEventAt === 'string' || row.lastEventAt === null) &&
      (row.entityType === 'chat' || row.entityType === 'channel') &&
      (typeof row.avatarUrl === 'string' || row.avatarUrl === null)
    );
  }

  private isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
  }

  private isMaxChatMemberAccess(value: unknown): value is MaxChatMemberAccess {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }

    const row = value as Record<string, unknown>;
    return (
      (typeof row.userId === 'string' || row.userId === null) &&
      typeof row.isAdmin === 'boolean' &&
      typeof row.isOwner === 'boolean' &&
      (row.isBot === undefined || row.isBot === null || typeof row.isBot === 'boolean') &&
      Array.isArray(row.permissions) &&
      row.permissions.every((permission) => typeof permission === 'string') &&
      (row.permissionsKnown === undefined || typeof row.permissionsKnown === 'boolean')
    );
  }

  private resolveChatMemberAccessCacheTtlSec(access: MaxChatMemberAccess): number {
    return access.isAdmin || access.isOwner
      ? this.chatMemberAccessAdminCacheTtlSec
      : this.chatMemberAccessMemberCacheTtlSec;
  }

  private async getMessageById(
    messageId: string,
    requestOptions: MaxApiRequestOptions | MaxApiTrafficClass = 'critical',
    failureObserver?: MaxReadFailureObserver,
  ): Promise<Record<string, unknown> | null> {
    const normalizedMessageId = messageId.trim();
    if (!normalizedMessageId) {
      return null;
    }
    const timeoutMs = this.normalizeReadRequestOptions(requestOptions).timeoutMs;

    let data: Record<string, unknown>;
    try {
      data = await this.executeGlobalRequest(
        associatedMaxHttpOperation((owner) =>
          this.request<Record<string, unknown>>(
            'get',
            '/messages',
            {
              params: {
                message_ids: normalizedMessageId,
              },
              ...(timeoutMs ? { timeout: timeoutMs } : {}),
            },
            owner,
          ),
        ),
        requestOptions,
        failureObserver,
      );
    } catch (error: unknown) {
      if (this.extractStatusCode(error) !== 404) throw error;
      // FLAG: A list-route 404 proves neither absence nor a successful deletion.
      // Verify the exact message, as presence lookups do; preserve direct-path failures.
      return this.getMessageByPath(normalizedMessageId, requestOptions, failureObserver);
    }
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const matchedMessage = messages.find((message) => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        return false;
      }

      return this.extractMessageIdFromSendResponse(message) === normalizedMessageId;
    });
    if (matchedMessage && typeof matchedMessage === 'object' && !Array.isArray(matchedMessage)) {
      return matchedMessage as Record<string, unknown>;
    }

    // Some MAX installations ignore `message_ids` filtering and return recent messages instead.
    // Fall back to the direct message path so edits target the intended post.
    return this.getMessageByPath(normalizedMessageId, requestOptions, failureObserver);
  }

  private async getMessageByPath(
    messageId: string,
    requestOptions: MaxApiRequestOptions | MaxApiTrafficClass = 'critical',
    failureObserver?: MaxReadFailureObserver,
  ): Promise<Record<string, unknown> | null> {
    const normalizedMessageId = messageId.trim();
    if (!normalizedMessageId) {
      return null;
    }
    const timeoutMs = this.normalizeReadRequestOptions(requestOptions).timeoutMs;

    const data = await this.executeGlobalRequest(
      associatedMaxHttpOperation((owner) =>
        this.request<Record<string, unknown>>(
          'get',
          `/messages/${encodeURIComponent(normalizedMessageId)}`,
          { ...(timeoutMs ? { timeout: timeoutMs } : {}) },
          owner,
        ),
      ),
      requestOptions,
      failureObserver,
    );
    const nestedMessage = this.asRecord(data?.message);
    const exactMessage = [nestedMessage, data].find(
      (candidate) =>
        candidate && this.extractMessageIdFromSendResponse(candidate) === normalizedMessageId,
    );
    if (!exactMessage) {
      throw new MaxExactMessageLookupMissingIdError();
    }
    return exactMessage;
  }

  private parseChatEntityType(row: Record<string, unknown>): 'chat' | 'channel' {
    const rawType = row.type ?? row.chat_type ?? row.chatType;
    const isChannel = this.readBoolean(row.is_channel ?? row.isChannel);
    if (typeof rawType === 'string') {
      const normalized = rawType.trim().toLowerCase();
      if (normalized === 'channel') {
        return 'channel';
      }
      if (
        normalized === 'chat' ||
        normalized === 'group' ||
        normalized === 'supergroup' ||
        normalized === 'dialog'
      ) {
        if (isChannel === true) {
          return 'channel';
        }
        return 'chat';
      }
    }

    if (isChannel === true) {
      return 'channel';
    }
    if (isChannel === false) {
      return 'chat';
    }

    const link = this.parseChatLink(row);
    if (link && /\/channels?\//iu.test(link)) {
      return 'channel';
    }

    return 'chat';
  }

  private readMemberUserId(value: unknown): string | null {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const row = value as Record<string, unknown>;
    const nestedUser =
      row.user && typeof row.user === 'object' && !Array.isArray(row.user)
        ? (row.user as Record<string, unknown>)
        : null;
    const candidate =
      row.user_id ??
      row.userId ??
      row.id ??
      nestedUser?.user_id ??
      nestedUser?.userId ??
      nestedUser?.id;

    if (typeof candidate !== 'string' && typeof candidate !== 'number') {
      return null;
    }

    const normalized = String(candidate).trim();
    return normalized.length > 0 ? normalized : null;
  }

  private parseChatMemberAccess(value: unknown): MaxChatMemberAccess {
    const row = this.asRecord(value);
    const isAdmin = row ? this.isChatAdminMemberRow(row) : false;
    const roleValue = this.readLowerString(
      row?.role ??
        row?.member_role ??
        row?.memberRole ??
        row?.chat_role ??
        row?.chatRole ??
        row?.status ??
        row?.member_status ??
        row?.memberStatus,
    );
    const isOwner =
      roleValue?.includes('owner') === true ||
      roleValue?.includes('creator') === true ||
      row?.is_owner === true ||
      row?.isOwner === true ||
      row?.owner === true ||
      row?.is_creator === true ||
      row?.isCreator === true ||
      row?.creator === true;

    return {
      userId: this.readMemberUserId(value),
      ...(typeof row?.join_time === 'number' &&
      Number.isSafeInteger(row.join_time) &&
      row.join_time > 0
        ? { joinedAtMs: row.join_time }
        : {}),
      isBot: this.readExplicitChatMemberBotState(value),
      isAdmin: isOwner || isAdmin,
      isOwner,
      permissions: row ? this.readChatAdminPermissions(row) : [],
      permissionsKnown: row ? this.hasExplicitChatAdminPermissions(row) : false,
      explicitPrivilegeEvidence: row ? hasExplicitManagedEntityPrivilege(row) : false,
      explicitNonPrivilegeEvidence: row ? hasExplicitManagedEntityNonPrivilege(row) : false,
    };
  }

  private parseChatMemberRole(value: unknown): MaxChatMemberRole {
    const access = this.parseChatMemberAccess(value);
    if (access.isOwner) {
      return 'owner';
    }

    if (access.isAdmin) {
      return 'admin';
    }

    return 'member';
  }

  private async listChatAdminMembers(
    chatId: string,
    options: MaxApiRequestOptions = {},
  ): Promise<unknown[]> {
    const timeoutMs =
      typeof options.timeoutMs === 'number' && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.trunc(options.timeoutMs))
        : undefined;
    const members: unknown[] = [];
    const seenMarkers = new Set<string>();
    let marker: string | number | null = null;

    let pagesFetched = 0;
    while (pagesFetched < MAX_API_CHAT_ADMIN_MEMBERS_PAGE_SAFETY_CAP) {
      pagesFetched += 1;
      const data = await this.executeChatRequest(
        chatId,
        async () =>
          this.request<Record<string, unknown>>('get', `/chats/${chatId}/members/admins`, {
            params: {
              ...(marker !== null ? { marker } : {}),
            },
            ...(timeoutMs ? { timeout: timeoutMs } : {}),
          }),
        options,
      );
      // FLAG: Roster consumers revoke absent admins; only a complete valid roster is authoritative.
      if (
        !Array.isArray(data?.members) ||
        data.members.some((member) => !this.readMemberUserId(member))
      ) {
        throw new Error('Invalid MAX chat admin members response');
      }
      const pageMembers = data.members;
      members.push(...pageMembers);

      const nextMarker = data.marker;
      if (nextMarker === null || nextMarker === undefined) {
        return members;
      }
      if (
        (typeof nextMarker !== 'string' && typeof nextMarker !== 'number') ||
        (typeof nextMarker === 'number' && !Number.isFinite(nextMarker)) ||
        String(nextMarker).trim().length === 0
      ) {
        throw new Error('Invalid MAX chat admin pagination marker');
      }

      const markerKey = String(nextMarker);
      if (seenMarkers.has(markerKey)) {
        throw new Error('Incomplete MAX chat admin roster: repeated pagination marker');
      }

      seenMarkers.add(markerKey);
      marker = nextMarker;
    }

    throw new Error('Incomplete MAX chat admin roster: pagination safety cap exceeded');
  }

  private parseChatMemberProfile(value: unknown): MaxChatMemberProfile | null {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const userId = this.readMemberUserId(value);
    if (!userId) {
      return null;
    }

    const row = value as Record<string, unknown>;
    const nestedUser =
      row.user && typeof row.user === 'object' && !Array.isArray(row.user)
        ? (row.user as Record<string, unknown>)
        : null;
    return {
      userId,
      displayName: resolveMaxUserDisplayName(row, nestedUser),
      username: this.readTrimmedString(row.username ?? nestedUser?.username),
      avatarUrl: this.readTrimmedString(
        row.full_avatar_url ??
          row.fullAvatarUrl ??
          row.avatar_url ??
          row.avatarUrl ??
          nestedUser?.full_avatar_url ??
          nestedUser?.fullAvatarUrl ??
          nestedUser?.avatar_url ??
          nestedUser?.avatarUrl,
      ),
      profileUrl: this.readProfileUrl(
        row.profile_url,
        row.profileUrl,
        row.url,
        row.link,
        nestedUser?.profile_url,
        nestedUser?.profileUrl,
        nestedUser?.url,
        nestedUser?.link,
      ),
    };
  }

  private parseChatMemberBot(
    value: unknown,
    profile: Pick<MaxChatMemberProfile, 'userId' | 'username'>,
  ): boolean {
    if (!value || typeof value !== 'object') {
      return false;
    }

    const row = value as Record<string, unknown>;
    const nestedUser =
      row.user && typeof row.user === 'object' && !Array.isArray(row.user)
        ? (row.user as Record<string, unknown>)
        : null;
    if (
      row.is_bot === true ||
      row.isBot === true ||
      row.bot === true ||
      row.is_service === true ||
      row.isService === true ||
      nestedUser?.is_bot === true ||
      nestedUser?.isBot === true ||
      nestedUser?.bot === true ||
      nestedUser?.is_service === true ||
      nestedUser?.isService === true
    ) {
      return true;
    }

    const username = this.readTrimmedString(profile.username);
    if (username?.toLowerCase().endsWith('_bot')) {
      return true;
    }

    return profile.userId.toLowerCase().endsWith('_bot');
  }

  private readExplicitChatMemberBot(value: unknown): boolean {
    return this.readExplicitChatMemberBotState(value) === true;
  }

  private readExplicitChatMemberBotState(value: unknown): boolean | null {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const row = value as Record<string, unknown>;
    const nestedUser =
      row.user && typeof row.user === 'object' && !Array.isArray(row.user)
        ? (row.user as Record<string, unknown>)
        : null;
    const candidates = [row, nestedUser].filter(
      (candidate): candidate is Record<string, unknown> => candidate !== null,
    );
    if (
      candidates.some(
        (candidate) =>
          candidate.is_bot === true ||
          candidate.isBot === true ||
          candidate.bot === true ||
          candidate.is_service === true ||
          candidate.isService === true,
      )
    ) {
      return true;
    }
    if (
      candidates.some(
        (candidate) =>
          candidate.is_bot === false || candidate.isBot === false || candidate.bot === false,
      )
    ) {
      return false;
    }
    return null;
  }

  private isChatAdminMemberArray(value: unknown): value is MaxChatAdminMember[] {
    return (
      Array.isArray(value) &&
      value.every(
        (member) =>
          member !== null &&
          typeof member === 'object' &&
          typeof (member as MaxChatAdminMember).userId === 'string' &&
          typeof (member as MaxChatAdminMember).isBot === 'boolean',
      )
    );
  }

  private parseChatMemberUnavailableReason(value: unknown): MaxChatRosterUnavailableReason | null {
    if (!value || typeof value !== 'object') {
      return null;
    }

    const row = value as Record<string, unknown>;
    const nestedUser =
      row.user && typeof row.user === 'object' && !Array.isArray(row.user)
        ? (row.user as Record<string, unknown>)
        : null;

    for (const candidate of [row, nestedUser].filter(
      (item): item is Record<string, unknown> => item !== null,
    )) {
      if (
        candidate.is_deleted === true ||
        candidate.isDeleted === true ||
        candidate.deleted === true ||
        candidate.deleted_account === true ||
        candidate.deletedAccount === true
      ) {
        return 'deleted';
      }

      if (
        candidate.is_blocked === true ||
        candidate.isBlocked === true ||
        candidate.blocked === true ||
        candidate.blocked_by_platform === true ||
        candidate.blockedByPlatform === true
      ) {
        return 'blocked';
      }

      if (
        candidate.is_deactivated === true ||
        candidate.isDeactivated === true ||
        candidate.deactivated === true
      ) {
        return 'deactivated';
      }

      if (candidate.is_suspended === true || candidate.isSuspended === true) {
        return 'suspended';
      }

      const explicitStatus = this.readLowerString(
        candidate.account_status ??
          candidate.accountStatus ??
          candidate.user_status ??
          candidate.userStatus ??
          candidate.profile_status ??
          candidate.profileStatus,
      );
      if (explicitStatus === 'deleted' || explicitStatus === 'removed') {
        return 'deleted';
      }
      if (explicitStatus === 'blocked' || explicitStatus === 'banned') {
        return 'blocked';
      }
      if (explicitStatus === 'deactivated' || explicitStatus === 'disabled') {
        return 'deactivated';
      }
      if (explicitStatus === 'suspended') {
        return 'suspended';
      }

      if (this.isMaxDeletedUserPlaceholder(candidate)) {
        return 'deleted';
      }
    }

    return null;
  }

  private isMaxDeletedUserPlaceholder(candidate: Record<string, unknown>): boolean {
    const name = this.readLowerString(candidate.name);
    const firstName = this.readLowerString(candidate.first_name ?? candidate.firstName);
    const lastName = this.readLowerString(candidate.last_name ?? candidate.lastName);
    if (name !== 'deleted user' || firstName !== 'deleted' || lastName !== 'user') {
      return false;
    }

    if (
      candidate.is_bot === true ||
      candidate.isBot === true ||
      candidate.bot === true ||
      candidate.is_service === true ||
      candidate.isService === true
    ) {
      return false;
    }

    const publicProfileFields = [
      candidate.username,
      candidate.avatar_url,
      candidate.avatarUrl,
      candidate.full_avatar_url,
      candidate.fullAvatarUrl,
      candidate.description,
      candidate.profile_url,
      candidate.profileUrl,
      candidate.url,
      candidate.link,
    ];
    return publicProfileFields.every((value) => this.readTrimmedString(value) === null);
  }

  private readProfileUrl(...candidates: unknown[]): string | null {
    for (const candidate of candidates) {
      const value = this.readTrimmedString(candidate);
      if (!value) {
        continue;
      }

      const normalized = this.normalizeMaxProfileUrl(value);
      if (normalized) {
        return normalized;
      }
    }

    return null;
  }

  private normalizeMaxProfileUrl(value: string): string | null {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
      }

      const hostname = parsed.hostname.toLowerCase();
      if (hostname !== 'max.ru' && hostname !== 'www.max.ru') {
        return null;
      }

      parsed.hash = '';
      return parsed.toString();
    } catch {
      return null;
    }
  }

  private parseChatLink(row: Record<string, unknown>): string | null {
    const rawLink = row.link ?? row.url ?? row.message_url ?? row.messageUrl;
    if (typeof rawLink === 'string') {
      const normalizedLink = rawLink.trim();
      if (!normalizedLink) {
        return null;
      }

      if (normalizedLink.startsWith('http://') || normalizedLink.startsWith('https://')) {
        return normalizedLink;
      }
    }

    const inferredChatPostLink = this.inferChatPostLink(row);
    if (!inferredChatPostLink) {
      return null;
    }

    return inferredChatPostLink;
  }

  private parseChatAvatarUrl(row: Record<string, unknown>): string | null {
    const icon =
      row.icon && typeof row.icon === 'object' && !Array.isArray(row.icon)
        ? (row.icon as Record<string, unknown>)
        : null;

    for (const candidate of [
      row.full_icon_url,
      row.fullIconUrl,
      row.icon_url,
      row.iconUrl,
      row.avatar_url,
      row.avatarUrl,
      icon?.url,
      icon?.icon_url,
      icon?.iconUrl,
      icon?.full_url,
      icon?.fullUrl,
      icon?.full_icon_url,
      icon?.fullIconUrl,
    ]) {
      const value = this.readTrimmedString(candidate);
      if (value) {
        return value;
      }
    }

    return null;
  }

  private normalizeMessageRows(payload: Record<string, unknown>): Record<string, unknown>[] {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    return messages.filter(
      (message): message is Record<string, unknown> =>
        Boolean(message) && typeof message === 'object' && !Array.isArray(message),
    );
  }

  private normalizeMessageTimestamp(value: unknown): number | null {
    if (value === null) {
      return null;
    }
    if (value instanceof Date) {
      const millis = value.getTime();
      return Number.isFinite(millis) ? millis : null;
    }
    if (typeof value === 'number') {
      return Number.isFinite(value) ? Math.trunc(value) : null;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        return null;
      }
      if (/^\d+$/u.test(trimmed)) {
        return Number(trimmed);
      }
      const parsed = Date.parse(trimmed);
      return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
  }

  private normalizeMessageQueryBoundary(value: unknown): number | null {
    const timestampMs = this.normalizeMessageTimestamp(value);
    if (timestampMs === null) {
      return null;
    }

    return Math.trunc(timestampMs);
  }

  private parseMessageSnapshot(
    chatId: string,
    row: Record<string, unknown>,
  ): MaxChannelMessageSnapshot | null {
    const body = this.asRecord(row.body);
    const messageId = this.readTrimmedString(
      body?.mid ?? row.message_id ?? row.messageId ?? row.id,
    );
    const timestampMs = this.normalizeMessageTimestamp(
      row.timestamp ?? row.created_at ?? row.createdAt ?? body?.timestamp,
    );
    if (!messageId || timestampMs === null) {
      return null;
    }

    const publishedAt = new Date(timestampMs);
    if (!Number.isFinite(publishedAt.getTime())) {
      return null;
    }

    const stat = this.asRecord(row.stat);
    return {
      chatId,
      messageId,
      publishedAt: publishedAt.toISOString(),
      publishedAtMs: timestampMs,
      url: this.parseChatLink(row),
      previewUrl: this.extractMessageImagePreviewUrl(row),
      views: this.readNullableInteger(stat?.views),
      reactionsTotal: this.parseMessageReactionsTotal(row),
      reactions: this.parseMessageReactions(row),
    };
  }

  private parseMessageReactionsTotal(row: Record<string, unknown>): number | null {
    const body = this.asRecord(row.body);
    const stat = this.asRecord(row.stat);
    const candidates = [
      stat?.reactions_total,
      stat?.reactionsTotal,
      stat?.reaction_count,
      stat?.reactionCount,
      stat?.reactions_count,
      stat?.reactionsCount,
      stat?.reactions,
      stat?.reaction_counts,
      stat?.emoji_reactions,
      row.reactions_total,
      row.reactionsTotal,
      row.reaction_count,
      row.reactionCount,
      row.reactions_count,
      row.reactionsCount,
      row.reactions,
      body?.reactions,
    ];

    for (const candidate of candidates) {
      const total = this.readMessageReactionTotal(candidate);
      if (total !== null) {
        return total;
      }
    }

    return null;
  }

  private parseMessageReactions(row: Record<string, unknown>): MaxChannelMessageReaction[] {
    const body = this.asRecord(row.body);
    const stat = this.asRecord(row.stat);
    const candidates = [
      stat?.reactions,
      stat?.reaction_counts,
      stat?.emoji_reactions,
      row.reactions,
      body?.reactions,
    ];

    for (const candidate of candidates) {
      const normalized = this.normalizeMessageReactionSource(candidate);
      if (normalized.length > 0) {
        return normalized;
      }
    }

    return [];
  }

  private readMessageReactionTotal(value: unknown): number | null {
    const count = this.readNullableInteger(value);
    if (count !== null) {
      return count;
    }

    const row = this.asRecord(value);
    const directCount = row
      ? this.readNullableInteger(
          row.count ??
            row.total ??
            row.value_count ??
            row.votes ??
            row.times ??
            row.reactions_total ??
            row.reactionsTotal,
        )
      : null;
    if (directCount !== null) {
      return directCount;
    }

    const normalized = this.normalizeMessageReactionSource(value);
    if (normalized.length === 0) {
      return null;
    }

    return normalized.reduce((total, item) => total + item.count, 0);
  }

  private normalizeMessageReactionSource(value: unknown): MaxChannelMessageReaction[] {
    if (Array.isArray(value)) {
      const normalized = value
        .map((item) => this.parseMessageReaction(item))
        .filter((item): item is MaxChannelMessageReaction => item !== null);

      return this.mergeMessageReactions(normalized);
    }

    const row = this.asRecord(value);
    if (!row) {
      return [];
    }

    const singleReaction = this.parseMessageReaction(row);
    if (singleReaction) {
      return [singleReaction];
    }

    return this.mergeMessageReactions(
      Object.entries(row)
        .filter(([emoji]) => this.isMessageReactionEmojiKey(emoji))
        .map(([emoji, count]) => this.parseMessageReaction(count, emoji))
        .filter((item): item is MaxChannelMessageReaction => item !== null),
    );
  }

  private isMessageReactionEmojiKey(value: string): boolean {
    const normalized = value.trim();
    if (!normalized) {
      return false;
    }

    return ![
      'count',
      'total',
      'value_count',
      'votes',
      'times',
      'value',
      'reactions',
      'reactions_total',
      'reactions_count',
      'reaction_count',
    ].includes(normalized.toLowerCase());
  }

  private parseMessageReaction(
    value: unknown,
    fallbackEmoji?: string,
  ): MaxChannelMessageReaction | null {
    if (typeof value === 'number' || typeof value === 'string' || typeof value === 'bigint') {
      const count = this.readNullableInteger(value);
      const emoji = this.readTrimmedString(fallbackEmoji);
      if (!emoji || count === null || count <= 0) {
        return null;
      }

      return {
        emoji,
        count,
      };
    }

    const row = this.asRecord(value);
    if (!row) {
      return null;
    }

    const emoji = this.readTrimmedString(
      row.emoji ??
        row.reaction ??
        row.code ??
        row.value ??
        row.text ??
        row.label ??
        row.name ??
        fallbackEmoji,
    );
    const count = this.readNullableInteger(
      row.count ?? row.total ?? row.value_count ?? row.votes ?? row.times ?? row.value,
    );
    if (!emoji || count === null || count <= 0) {
      return null;
    }

    return {
      emoji,
      count,
    };
  }

  private extractMessageImagePreviewUrl(row: Record<string, unknown>): string | null {
    const body = this.asRecord(row.body);
    const attachments = Array.isArray(body?.attachments) ? body.attachments : [];

    for (const attachment of attachments) {
      const previewUrl = this.extractAttachmentImageUrl(attachment);
      if (previewUrl) {
        return previewUrl;
      }
    }

    return null;
  }

  private extractAttachmentImageUrl(value: unknown): string | null {
    const attachment = this.asRecord(value);
    if (!attachment) {
      return null;
    }

    const type = this.readLowerString(attachment.type);
    if (type && type !== 'image' && type !== 'photo') {
      return null;
    }

    const payload =
      this.asRecord(attachment.payload) ??
      this.asRecord(attachment.photo) ??
      this.asRecord(attachment.image) ??
      attachment;
    const directUrl = this.readHttpUrl(
      payload.url ??
        payload.preview_url ??
        payload.previewUrl ??
        payload.thumbnail_url ??
        payload.thumbnailUrl ??
        payload.src ??
        payload.href,
    );
    if (directUrl) {
      return directUrl;
    }

    const photos = this.asRecord(payload.photos);
    if (photos) {
      const photoUrl = this.pickLargestPhotoUrl(photos);
      if (photoUrl) {
        return photoUrl;
      }
    }

    const sizes = Array.isArray(payload.sizes) ? payload.sizes : [];
    return this.pickLargestImageSizeUrl(sizes);
  }

  private pickLargestPhotoUrl(photos: Record<string, unknown>): string | null {
    const candidates = Object.entries(photos)
      .map(([key, value]) => {
        const row = this.asRecord(value);
        const width =
          this.readNullableInteger(row?.width ?? row?.w) ?? this.readNullableInteger(key) ?? 0;
        const height = this.readNullableInteger(row?.height ?? row?.h) ?? 0;
        const url = row
          ? this.readHttpUrl(row.url ?? row.preview_url ?? row.previewUrl ?? row.src)
          : this.readHttpUrl(value);
        return url ? { url, score: width * Math.max(1, height) || width } : null;
      })
      .filter((item): item is { url: string; score: number } => item !== null);

    candidates.sort((left, right) => right.score - left.score);
    return candidates[0]?.url ?? null;
  }

  private pickLargestImageSizeUrl(values: unknown[]): string | null {
    const candidates = values
      .map((value) => {
        const row = this.asRecord(value);
        if (!row) {
          return null;
        }
        const width = this.readNullableInteger(row.width ?? row.w) ?? 0;
        const height = this.readNullableInteger(row.height ?? row.h) ?? 0;
        const url = this.readHttpUrl(row.url ?? row.src ?? row.href);
        return url ? { url, area: width * height } : null;
      })
      .filter((item): item is { url: string; area: number } => item !== null);

    candidates.sort((left, right) => right.area - left.area);
    return candidates[0]?.url ?? null;
  }

  private mergeMessageReactions(
    reactions: MaxChannelMessageReaction[],
  ): MaxChannelMessageReaction[] {
    const grouped = new Map<string, number>();

    for (const reaction of reactions) {
      grouped.set(reaction.emoji, (grouped.get(reaction.emoji) ?? 0) + reaction.count);
    }

    return Array.from(grouped.entries())
      .map(([emoji, count]) => ({ emoji, count }))
      .sort((left, right) => right.count - left.count || left.emoji.localeCompare(right.emoji));
  }

  private mergeMessageSnapshots(
    current: MaxChannelMessageSnapshot | null,
    incoming: MaxChannelMessageSnapshot,
  ): MaxChannelMessageSnapshot {
    if (!current) {
      return incoming;
    }

    return {
      ...incoming,
      url: incoming.url ?? current.url,
      previewUrl: incoming.previewUrl ?? current.previewUrl,
      views:
        current.views === null
          ? incoming.views
          : incoming.views === null
            ? current.views
            : Math.max(current.views, incoming.views),
      reactionsTotal: Math.max(current.reactionsTotal ?? 0, incoming.reactionsTotal ?? 0),
      reactions: this.mergeMessageReactions([...current.reactions, ...incoming.reactions]),
    };
  }

  private parseWebhookSubscription(value: unknown): MaxWebhookSubscription | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const row = value as Record<string, unknown>;
    const url = this.readTrimmedString(row.url);
    if (!url) {
      return null;
    }

    const updateTypesSource = Array.isArray(row.update_types)
      ? row.update_types
      : Array.isArray(row.updateTypes)
        ? row.updateTypes
        : [];
    const updateTypes = Array.from(
      new Set(
        updateTypesSource
          .map((item) => this.readLowerString(item))
          .filter((item): item is string => Boolean(item)),
      ),
    ).sort();

    return {
      url,
      updateTypes,
    };
  }

  async answerCallback(
    callbackId: string,
    notification?: string,
    messageEdit?: MaxCallbackMessageEdit,
    requestOptions: MaxCallbackAnswerRequestOptions = {},
  ): Promise<void> {
    const normalizedCallbackId = callbackId.trim();
    if (!normalizedCallbackId) {
      throw new Error('callbackId is required');
    }

    const normalizedNotification = typeof notification === 'string' ? notification.trim() : '';
    const hasMessageEdit =
      Boolean(messageEdit) &&
      typeof messageEdit?.text === 'string' &&
      messageEdit.text.trim().length > 0;
    const messageId = hasMessageEdit ? this.readTrimmedString(messageEdit?.messageId) : null;
    const rateLimitEntityId = this.readTrimmedString(requestOptions.rateLimitEntityId);
    const pollTarget = requestOptions.boundObject?.kind === 'poll';
    if (
      pollTarget &&
      (!hasMessageEdit ||
        !messageId ||
        messageEdit?.messageId !== messageId ||
        !rateLimitEntityId ||
        requestOptions.rateLimitEntityId !== rateLimitEntityId ||
        isPrivateDirectChatId(rateLimitEntityId) ||
        rateLimitEntityId.startsWith('user:') ||
        !this.readTrimmedString(requestOptions.boundObject?.id) ||
        requestOptions.boundObject?.id !== requestOptions.boundObject?.id.trim())
    ) {
      throw markMaxPreDispatchGuardRejected(
        new Error('A poll callback edit requires an exact poll, chat and message target'),
        MAX_EDIT_PRE_DISPATCH_GUARD_REJECTED_CODE,
      );
    }
    const executeAnswer = async (
      assertOwnership?: () => Promise<void>,
      assertCurrentOwnership?: () => void,
    ) => {
      const callbackData: Record<string, unknown> = {};
      if (normalizedNotification) {
        callbackData.notification = normalizedNotification;
      }
      if (hasMessageEdit) {
        const attachments = messageId
          ? this.buildEditableMessageAttachments(
              await this.getMessageById(messageId, requestOptions),
              messageEdit?.options,
            )
          : this.buildMessageAttachments(messageEdit?.options);
        callbackData.message = {
          text: messageEdit!.text.trim(),
          ...(messageEdit?.options?.textFormat ? { format: messageEdit.options.textFormat } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        };
        if (!pollTarget) await assertOwnership?.();
      }

      const answerOptions: MaxApiRequestOptions = {
        trafficClass: 'critical',
        actionHealthLane: requestOptions.actionHealthLane,
        sourceTag:
          this.normalizeMetricSourceTag(requestOptions.sourceTag) ??
          MAX_API_SOURCE_TAGS.CALLBACK_ANSWER,
        ignoreFailureMetricStatuses: requestOptions.ignoreFailureMetricStatuses,
        timeoutMs: requestOptions.timeoutMs,
        botId: requestOptions.botId,
        ...(pollTarget ? { boundObject: requestOptions.boundObject } : {}),
      };
      const quotaState: { error?: unknown } = {};
      const messageMutation: MaxMessageMutationRateLimitScope = {
        operation: 'answer',
        entityId: rateLimitEntityId,
      };
      const dispatch = async () => {
        if (!pollTarget) await assertOwnership?.();
        await requestOptions.onDispatchAttempt?.();
        await this.request('post', '/answers', {
          params: { callback_id: normalizedCallbackId },
          data: callbackData,
        });
      };
      const operation = pollTarget
        ? scopeMaxHttpOperation(dispatch, (run) =>
            this.mutationExecutionScope.run(
              {
                chatId: rateLimitEntityId!,
                purpose: 'edit_message',
                guardCode: MAX_EDIT_PRE_DISPATCH_GUARD_REJECTED_CODE,
                method: 'post',
                path: '/answers',
                requestOptions: answerOptions,
                explicitExistingMessage: {
                  messageId: messageId!,
                  object: requestOptions.boundObject!,
                },
                quotaState,
                messageMutation,
                // FLAG: All asynchronous preparation precedes the quota/SQL checkpoint.
                // Only the synchronous keyboard lease check may follow final authority.
                finalGuard: withMaxFinalAuthorityCheckpoint(async (checkpoint) => {
                  await assertOwnership?.();
                  await this.assertLegacyMessageMutationAllowed(rateLimitEntityId!, messageId!);
                  await checkpoint?.();
                  assertCurrentOwnership?.();
                }),
              },
              run,
            ),
          )
        : dispatch;
      await this.executeMutation(rateLimitEntityId, operation, answerOptions, {
        messageMutation,
        deferRateLimitReservation: pollTarget,
        deferredQuotaState: quotaState,
      });
    };

    if (messageId) {
      await this.runWithMessageKeyboardEditLock(messageId, executeAnswer);
      return;
    }
    await executeAnswer();
  }

  private async dispatchAction(
    payload: Omit<MaxActionJob, 'attempt' | 'idempotencyKey' | 'createdAt' | 'scheduledFor'>,
    options?: MaxActionDispatchOptions,
  ): Promise<MaxPublishedMessage | void> {
    const beforeImmediateSendMutation = options?.beforeImmediateSendMutation;
    const beforeImmediateDeleteMutation = options?.beforeImmediateDeleteMutation;
    const beforeImmediateMemberMutation = options?.beforeImmediateMemberMutation;
    if (options?.immediateFailurePolicy === 'terminal' && options.immediate !== true) {
      throw new Error('Terminal failure settlement requires immediate dispatch');
    }
    if (beforeImmediateSendMutation && options?.immediate !== true) {
      throw new Error('Send mutation guard requires immediate dispatch');
    }
    if (beforeImmediateSendMutation && payload.actionType !== 'SEND_MESSAGE') {
      throw new Error('Send mutation guard requires a message send action');
    }
    if (beforeImmediateDeleteMutation && options?.immediate !== true) {
      throw new Error('Delete mutation guard requires immediate dispatch');
    }
    if (beforeImmediateDeleteMutation && payload.actionType !== 'DELETE_MESSAGE') {
      throw new Error('Delete mutation guard requires a message delete action');
    }
    if (beforeImmediateMemberMutation && options?.immediate !== true) {
      throw new Error('Member mutation guard requires immediate dispatch');
    }
    if (
      beforeImmediateMemberMutation &&
      payload.actionType !== 'KICK_MEMBER' &&
      payload.actionType !== 'BAN_MEMBER' &&
      payload.actionType !== 'TRY_UNBAN_MEMBER' &&
      payload.actionType !== 'UNBAN_MEMBER'
    ) {
      throw new Error('Member mutation guard requires a member moderation action');
    }

    if (
      payload.actionType === 'TRY_UNBAN_MEMBER' &&
      (options?.immediate !== true ||
        !beforeImmediateMemberMutation ||
        !options.idempotencyKey?.trim() ||
        (options.delayMs ?? 0) !== 0 ||
        !this.actionLedgerService)
    ) {
      throw new Error('Unban attempt requires immediate guarded dispatch and a durable exact key');
    }

    if (
      (payload.actionType === 'KICK_MEMBER' ||
        payload.actionType === 'BAN_MEMBER' ||
        payload.actionType === 'TRY_UNBAN_MEMBER') &&
      payload.userId
    ) {
      this.assertMemberActionTargetIsNotRuntimeBot(
        payload.actionType,
        payload.chatId,
        payload.userId,
      );
    }

    const explicitBotId = options?.botId ?? payload.botId;
    const resolvedRoute =
      !explicitBotId && !options?.candidateBotIds?.length
        ? await this.resolveQueuedActionRoute(payload)
        : null;
    if (resolvedRoute && resolvedRoute.candidateBotIds.length === 0) {
      throw new UnrecoverableError(
        `MAX ${payload.actionType} has no eligible routed bot candidate for chat ${payload.chatId}`,
      );
    }
    const explicitCandidateBotIds = this.normalizeActionCandidateBotIds(
      options?.candidateBotIds ?? [],
    );
    const requestedCandidateBotIds = this.normalizeActionCandidateBotIds([
      ...explicitCandidateBotIds,
      ...(resolvedRoute?.candidateBotIds ?? []),
    ]);
    const selectedBotId =
      this.readTrimmedString(explicitBotId) ??
      this.readTrimmedString(resolvedRoute?.botId) ??
      explicitCandidateBotIds.find((botId) => {
        const candidate = this.botRegistry.getBotById(botId);
        return Boolean(candidate && this.canExecuteActionsForBot(candidate));
      });
    const bot = this.resolveExecutableBot(selectedBotId, {
      explicit: Boolean(selectedBotId?.trim()),
    });
    const candidateBotIds = this.normalizeActionCandidateBotIds([
      bot.id,
      ...requestedCandidateBotIds,
    ]);
    const isRoutedAction =
      Boolean(options?.routing) ||
      Boolean(resolvedRoute) ||
      Boolean(options?.candidateBotIds?.length);
    const routing =
      options?.routing ??
      (resolvedRoute ? this.buildActionRoutingMetadata(resolvedRoute) : undefined);
    const autoDeleteDelayMs = this.normalizeDelayMs(options?.autoDeleteDelayMs);
    const delayMs = this.normalizeDelayMs(options?.delayMs);
    const immediate = options?.immediate === true;
    const ignoreFailureMetricStatuses = this.normalizeFailureMetricStatuses(
      options?.ignoreFailureMetricStatuses,
    );
    const sourceTag = this.normalizeMetricSourceTag(options?.sourceTag ?? payload.sourceTag);
    const timeoutMs = this.normalizeTimeoutMs(options?.timeoutMs);
    const scheduledJobId =
      delayMs > 0
        ? this.buildScheduledMemberActionJobId(
            payload.actionType,
            payload.chatId,
            payload.userId,
            bot.id,
            isRoutedAction,
          )
        : null;
    const explicitIdempotencyKey = this.buildExplicitActionIdempotencyKey(
      options?.idempotencyKey,
      payload.actionType,
      isRoutedAction ||
        ((payload.actionType === 'BAN_MEMBER' ||
          payload.actionType === 'KICK_MEMBER' ||
          payload.actionType === 'TRY_UNBAN_MEMBER') &&
          !isPrivateDirectChatId(payload.chatId))
        ? null
        : bot.id,
    );
    const logicalIdempotencyKey =
      scheduledJobId ??
      explicitIdempotencyKey ??
      this.buildDefaultActionIdempotencyKey(
        payload,
        isRoutedAction ||
          ((payload.actionType === 'BAN_MEMBER' ||
            payload.actionType === 'KICK_MEMBER' ||
            payload.actionType === 'TRY_UNBAN_MEMBER') &&
            !isPrivateDirectChatId(payload.chatId))
          ? null
          : bot.id,
      );
    const createdAt = new Date();
    const job: MaxActionJob = {
      ...payload,
      botId: bot.id,
      ...(isRoutedAction ? { candidateBotIds } : {}),
      ...(routing ? { routing } : {}),
      ...(options?.trafficClass ? { trafficClass: options.trafficClass } : {}),
      ...(options?.actionHealthLane ? { actionHealthLane: options.actionHealthLane } : {}),
      ...(sourceTag ? { sourceTag } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(payload.actionType === 'SEND_MESSAGE' && autoDeleteDelayMs > 0
        ? { autoDeleteDelayMs }
        : {}),
      ...(ignoreFailureMetricStatuses ? { ignoreFailureMetricStatuses } : {}),
      ...(options?.ledgerContext ? { ledgerContext: options.ledgerContext } : {}),
      attempt: 1,
      idempotencyKey: logicalIdempotencyKey ?? randomUUID(),
      createdAt: createdAt.toISOString(),
      ...(delayMs > 0
        ? { scheduledFor: new Date(createdAt.getTime() + delayMs).toISOString() }
        : {}),
    };

    if (immediate && delayMs > 0) {
      throw new Error('Immediate dispatch cannot be combined with delay');
    }

    const assertAutoDeleteSchedulingAllowed = async () => {
      if (!job.sendAutoDelete) return;
      if (this.legacyHolds) await assertLegacyActionAllowed(this.legacyHolds, job);
    };
    await assertAutoDeleteSchedulingAllowed();

    if (immediate) {
      return this.executeImmediateActionJob(
        job,
        beforeImmediateDeleteMutation,
        beforeImmediateMemberMutation,
        beforeImmediateSendMutation,
        options?.immediateFailurePolicy,
      );
    }

    let actionQueue = this.resolveActionQueue(job);
    if (this.dispatchEnabled && actionQueue) {
      await this.actionLedgerService?.assertCanEnqueue(job);

      if (scheduledJobId) {
        await this.removeQueuedActionJob(scheduledJobId);
      } else if (logicalIdempotencyKey) {
        const retainedQueue = await this.removeRetainedFailedActionJob(
          logicalIdempotencyKey,
          payload.actionType,
        );
        if (retainedQueue) {
          actionQueue = retainedQueue;
        }
      }

      const queueJobOptions = {
        jobId: job.idempotencyKey,
        attempts: 5,
        removeOnComplete: true,
        removeOnFail: this.actionFailedJobRetention,
        ...(delayMs > 0 ? { delay: delayMs } : {}),
        backoff: {
          type: 'exponential' as const,
          delay: 1_000,
        },
      };
      const targetActionQueue = actionQueue;
      let queueSubmissionStarted = false;
      const addActionJob = async () => {
        queueSubmissionStarted = false;
        await assertAutoDeleteSchedulingAllowed();
        queueSubmissionStarted = true;
        return targetActionQueue.add('execute-max-action', job, queueJobOptions);
      };
      const enqueueAttemptStartedAt = new Date();
      let bullMqEnqueuedAt: Date | undefined;
      try {
        const addedJob = await addActionJob();
        bullMqEnqueuedAt = this.readBullMqJobEnqueuedAt(addedJob);
      } catch (error: unknown) {
        // FLAG: A refused child was never submitted to BullMQ. Do not manufacture
        // queue ambiguity or a new action-ledger entry from a pre-admission denial.
        if (!queueSubmissionStarted) throw error;
        const queueObservation = await this.observeActionQueueJob(
          targetActionQueue,
          job.idempotencyKey,
        );
        let executionObserved =
          queueObservation.state === 'live'
            ? false
            : (await this.actionLedgerService
                ?.hasExecutionEvidenceSince(job.idempotencyKey, enqueueAttemptStartedAt)
                .catch(() => false)) === true;
        let queueAccepted = queueObservation.state === 'live' || executionObserved;
        let recoveryEvidence =
          queueObservation.state === 'live' ? 'bullmq_job' : 'ledger_execution';
        if (queueObservation.state === 'live') {
          bullMqEnqueuedAt = queueObservation.enqueuedAt;
        }

        if (!queueAccepted && queueObservation.state === 'unknown') {
          try {
            const addedJob = await addActionJob();
            bullMqEnqueuedAt = this.readBullMqJobEnqueuedAt(addedJob);
            queueAccepted = true;
            recoveryEvidence = 'bullmq_retry';
          } catch (retryError: unknown) {
            if (!queueSubmissionStarted) throw retryError;
            executionObserved =
              (await this.actionLedgerService
                ?.hasExecutionEvidenceSince(job.idempotencyKey, enqueueAttemptStartedAt)
                .catch(() => false)) === true;
            if (!executionObserved && job.actionType === 'SEND_MESSAGE') {
              const ambiguousError = new UnrecoverableError(
                `Ambiguous BullMQ ownership for MAX SEND_MESSAGE ${job.idempotencyKey}; manual review is required before retry`,
              );
              await this.actionLedgerService
                ?.recordEnqueueAmbiguousIfAbsent(job, ambiguousError)
                .catch((ledgerError: unknown) => {
                  this.logger.warn(
                    {
                      actionType: job.actionType,
                      chatId: job.chatId,
                      botId: job.botId,
                      error: this.extractErrorMessage(ledgerError),
                    },
                    'Failed to quarantine ambiguous MAX SEND_MESSAGE queue ownership',
                  );
                });
              throw ambiguousError;
            }
            if (!executionObserved) {
              await this.actionLedgerService
                ?.recordEnqueueFailedIfAbsent(job, retryError)
                .catch((ledgerError: unknown) => {
                  this.logger.warn(
                    {
                      actionType: job.actionType,
                      chatId: job.chatId,
                      botId: job.botId,
                      error: this.extractErrorMessage(ledgerError),
                    },
                    'Failed to record MAX action enqueue failure',
                  );
                });
              throw retryError;
            }
            queueAccepted = true;
          }
        }

        if (!queueAccepted) {
          await this.actionLedgerService
            ?.recordEnqueueFailedIfAbsent(job, error)
            .catch((ledgerError: unknown) => {
              this.logger.warn(
                {
                  actionType: job.actionType,
                  chatId: job.chatId,
                  botId: job.botId,
                  error: this.extractErrorMessage(ledgerError),
                },
                'Failed to record MAX action enqueue failure',
              );
            });
          throw error;
        }

        this.logger.warn(
          {
            actionType: job.actionType,
            chatId: job.chatId,
            botId: job.botId,
            evidence: recoveryEvidence,
            error: this.extractErrorMessage(error),
          },
          'Recovered MAX action after an ambiguous BullMQ add failure',
        );
      }

      // FLAG: BullMQ must own the action before best-effort ledger bookkeeping.
      await this.actionLedgerService
        ?.recordEnqueuedIfAbsent(job, bullMqEnqueuedAt)
        .catch((ledgerError: unknown) => {
          this.logger.warn(
            {
              actionType: job.actionType,
              chatId: job.chatId,
              botId: job.botId,
              error: this.extractErrorMessage(ledgerError),
            },
            'Failed to record queued MAX action after BullMQ accepted it',
          );
        });
      return;
    }

    if (delayMs > 0) {
      await assertAutoDeleteSchedulingAllowed();
      if (scheduledJobId) {
        const existingTimeout = this.keyedActionTimeouts.get(scheduledJobId);
        if (existingTimeout) {
          clearTimeout(existingTimeout);
          this.pendingTimeouts.delete(existingTimeout);
        }
      }

      const timeout = setTimeout(() => {
        this.pendingTimeouts.delete(timeout);
        if (scheduledJobId) {
          this.keyedActionTimeouts.delete(scheduledJobId);
        }
        void this.executeImmediateActionJob(job).catch((error: unknown) => {
          this.logger.warn(
            {
              actionType: job.actionType,
              chatId: job.chatId,
              messageId: job.messageId,
              userId: job.userId,
              error: error instanceof Error ? error.message : 'Unknown error',
            },
            'Failed delayed max action',
          );
        });
      }, delayMs);
      this.pendingTimeouts.add(timeout);
      if (scheduledJobId) {
        this.keyedActionTimeouts.set(scheduledJobId, timeout);
      }
      return;
    }

    // FLAG: The queue-less compatibility path still owns the same durable dispatch journal.
    // A direct executeActionJob call would attempt to claim a SEND whose SQL row is missing.
    await this.executeImmediateActionJob(job);
  }

  private async resolveQueuedActionRoute(
    payload: Omit<MaxActionJob, 'attempt' | 'idempotencyKey' | 'createdAt' | 'scheduledFor'>,
  ): Promise<MaxBotRoute | null> {
    if (
      !this.maxBotLinkService ||
      !this.readTrimmedString(payload.chatId) ||
      isPrivateDirectChatId(payload.chatId)
    ) {
      return null;
    }

    const request: MaxBotRouteRequest =
      payload.actionType === 'SEND_MESSAGE' || payload.actionType === 'NOTIFY_MODERATORS'
        ? {
            purpose: 'send_message',
            chatId: payload.chatId,
            fallbackToPrimary: true,
          }
        : {
            purpose: 'moderation_action',
            chatId: payload.chatId,
            action: payload.actionType === 'DELETE_MESSAGE' ? 'delete_message' : 'moderate_member',
            fallbackToPrimary: true,
          };

    try {
      return await this.maxBotLinkService.resolveBotRoute(request);
    } catch (error: unknown) {
      this.logger.warn(
        {
          actionType: payload.actionType,
          chatId: payload.chatId,
          error: this.extractErrorMessage(error),
        },
        'Failed to resolve routed MAX action candidates before enqueue',
      );
      throw error;
    }
  }

  private buildActionRoutingMetadata(route: MaxBotRoute): MaxActionRoutingMetadata | undefined {
    if (route.purpose !== 'send_message' && route.purpose !== 'moderation_action') {
      return undefined;
    }

    return {
      purpose: route.purpose,
      primaryBotId: route.primaryBotId,
      reason: route.reason,
      routingVersion: route.routingVersion ?? null,
      ...(route.purpose === 'moderation_action'
        ? {
            action:
              route.action === 'delete_message' || route.action === 'edit_message'
                ? 'delete_message'
                : 'moderate_member',
          }
        : {}),
    };
  }

  private normalizeActionCandidateBotIds(values: readonly unknown[]): string[] {
    return Array.from(
      new Set(
        values
          .map((value) => (typeof value === 'string' ? value.trim() : ''))
          .filter((value) => value.length > 0),
      ),
    );
  }

  private async executeImmediateActionJob(
    job: MaxActionJob,
    beforeDeleteMutation?: MaxActionDispatchOptions['beforeImmediateDeleteMutation'],
    beforeMemberMutation?: (revalidateRoute?: () => Promise<void>) => Promise<void>,
    beforeSendMutation?: (revalidateRoute?: () => Promise<void>) => Promise<void>,
    immediateFailurePolicy?: MaxActionDispatchOptions['immediateFailurePolicy'],
  ): Promise<MaxPublishedMessage | void> {
    const executionOptions: MaxActionExecutionOptions = {
      beforeDeleteMutation,
      beforeMemberMutation,
      beforeSendMutation,
    };
    if (!this.actionLedgerService?.isIrreversibleAction(job.actionType)) {
      return this.executeActionJob(job, executionOptions);
    }

    await this.actionLedgerService.assertCanEnqueue(job);
    await this.actionLedgerService.recordStarted(job, new Date(job.createdAt));
    let executionJob = job;
    const attemptedBotIds = new Set<string>(job.botId ? [job.botId] : []);
    const configuredBotIds = new Set(
      this.botRegistry.getAllBots?.().map((bot) => bot.id) ?? job.candidateBotIds ?? [],
    );
    let result: MaxPublishedMessage | void;
    try {
      while (true) {
        try {
          result = await this.executeActionJob(executionJob, executionOptions);
          break;
        } catch (error: unknown) {
          if (!this.canRetryImmediateRouteRejection(executionJob, error)) throw error;
          // FLAG: Only a genuine local executor rejection before HTTP may hand this exact
          // durable identity and original feature closure to a current surviving candidate.
          // Never renew a feature deadline or replay an unknown SEND/BAN/KICK outcome.
          const route = await this.resolveQueuedActionRoute(executionJob);
          const nextBotId = route?.candidateBotIds.find((botId) => {
            if (!configuredBotIds.has(botId) || attemptedBotIds.has(botId)) return false;
            const bot = this.botRegistry.getBotById(botId);
            return !!bot && this.canExecuteActionsForBot(bot);
          });
          if (!nextBotId) throw error;
          attemptedBotIds.add(nextBotId);
          executionJob = {
            ...executionJob,
            botId: nextBotId,
            candidateBotIds: route!.candidateBotIds,
            routing: this.buildActionRoutingMetadata(route!) ?? executionJob.routing,
          };
        }
      }
    } catch (error: unknown) {
      const recordFailure =
        immediateFailurePolicy === 'terminal'
          ? this.actionLedgerService.recordFailed(executionJob, error, { exhausted: true })
          : this.actionLedgerService.recordFailed(executionJob, error);
      await recordFailure.catch((ledgerError: unknown) => {
        this.logger.warn(
          {
            actionType: job.actionType,
            chatId: job.chatId,
            botId: executionJob.botId,
            error: this.extractErrorMessage(ledgerError),
            originalError: this.extractErrorMessage(error),
          },
          'Failed to record immediate MAX action failure in durable ledger',
        );
      });
      throw error;
    }

    if (!result?.recoveredSendDispatch) {
      await this.actionLedgerService.recordSucceeded(executionJob).catch((ledgerError: unknown) => {
        this.logger.warn(
          {
            actionType: job.actionType,
            chatId: job.chatId,
            botId: executionJob.botId,
            error: this.extractErrorMessage(ledgerError),
          },
          'Failed to record immediate MAX action success in durable ledger',
        );
      });
    }
    return result;
  }

  private canRetryImmediateRouteRejection(job: MaxActionJob, error: unknown): boolean {
    if (
      !wasMaxPreDispatchGuardRejected(error) ||
      (error as { code?: unknown })?.code !== 'max_action_executor_proof_rejected' ||
      wasMaxMessageSendAttempted(error) ||
      wasMaxMemberMutationAttempted(error) ||
      wasMaxMemberMutationConfirmed(error) ||
      !['SEND_MESSAGE', 'BAN_MEMBER', 'KICK_MEMBER'].includes(job.actionType) ||
      (!job.routing && !job.candidateBotIds?.length) ||
      job.routing?.requiredBotId ||
      job.routing?.purpose === 'publisher_exact_send' ||
      job.routing?.purpose === 'channel_poll' ||
      job.routing?.sendRouteHalfOpenProbe ||
      job.routing?.sendRouteStickyProbe ||
      job.chatId.startsWith('user:') ||
      isPrivateDirectChatId(job.chatId) ||
      this.botRegistry.getPublisherBotDescriptor?.().id === job.botId ||
      typeof this.maxBotLinkService?.resolveBotRoute !== 'function'
    )
      return false;
    return shouldEnforceMaxRoutedMutation({
      mode: this.routedMutationsMode,
      canaryPercent: this.routedMutationsCanaryPercent,
      canaryEntityIds: this.routedMutationsCanaryEntityIds,
      entityId: job.chatId,
      rolloutKey: `${job.idempotencyKey}:${job.chatId}`,
    });
  }

  private buildScheduledMemberActionJobId(
    actionType: MaxActionType,
    chatId: string,
    userId: string | undefined,
    botId: string | null = null,
    logical = false,
  ): string | null {
    if (actionType !== 'UNBAN_MEMBER' || !userId) {
      return null;
    }

    return `member-action__${logical ? 'logical' : (botId ?? this.botRegistry.getDefaultBot().id)}__${actionType}__${chatId}__${userId}`;
  }

  getExplicitActionJobId(
    actionType: Extract<MaxActionType, 'BAN_MEMBER' | 'KICK_MEMBER'>,
    idempotencyKey: string,
  ): string {
    // FLAG: Group member actions share the same logical key across all bot identities.
    // Receipt recovery must use the dispatcher's exact key, never another action's result.
    const jobId = this.buildExplicitActionIdempotencyKey(idempotencyKey, actionType, null);
    if (!jobId) throw new Error('Explicit member action receipt requires a nonempty logical key');
    return jobId;
  }

  private buildExplicitActionIdempotencyKey(
    value: string | null | undefined,
    actionType: MaxActionType,
    botId: string | null,
  ): string | null {
    const normalized = this.readTrimmedString(value);
    if (!normalized) {
      return null;
    }

    return this.buildActionIdempotencyKey(
      'explicit',
      [botId, actionType, normalized].filter(Boolean) as string[],
    );
  }

  private buildDefaultActionIdempotencyKey(
    payload: Omit<MaxActionJob, 'attempt' | 'idempotencyKey' | 'createdAt' | 'scheduledFor'>,
    botId: string | null,
  ): string | null {
    const chatId = this.readTrimmedString(payload.chatId);
    if (!chatId) {
      return null;
    }

    if (payload.actionType === 'DELETE_MESSAGE') {
      const messageId = this.readTrimmedString(payload.messageId);
      return messageId
        ? this.buildActionIdempotencyKey(
            'logical',
            [botId, payload.actionType, chatId, messageId].filter(Boolean) as string[],
          )
        : null;
    }

    if (payload.actionType === 'BAN_MEMBER') {
      const userId = this.readTrimmedString(payload.userId);
      return userId
        ? this.buildActionIdempotencyKey(
            'logical',
            [botId, payload.actionType, chatId, userId].filter(Boolean) as string[],
          )
        : null;
    }

    return null;
  }

  private buildActionIdempotencyKey(namespace: string, parts: readonly string[]): string {
    return buildMaxActionIdempotencyKey(namespace, parts);
  }

  private async removeQueuedActionJob(jobId: string) {
    const existingJobs = await this.findActionJobs(jobId);
    await Promise.all(existingJobs.map((job) => job.remove()));
  }

  private async observeActionQueueJob(
    queue: Queue<MaxActionJob>,
    jobId: string,
  ): Promise<MaxActionQueueJobObservation> {
    try {
      const retainedJob = await queue.getJob(jobId);
      if (!retainedJob) {
        return { state: 'missing' };
      }
      const state = await retainedJob.getState();
      return {
        state: LIVE_MAX_ACTION_JOB_STATES.has(state) ? 'live' : 'final',
        enqueuedAt: this.readBullMqJobEnqueuedAt(retainedJob),
      };
    } catch {
      return { state: 'unknown' };
    }
  }

  private readBullMqJobEnqueuedAt(
    job: Pick<Job<MaxActionJob>, 'timestamp'> | null | undefined,
  ): Date | undefined {
    const timestamp = job?.timestamp;
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) {
      return undefined;
    }
    const enqueuedAt = new Date(timestamp);
    return Number.isFinite(enqueuedAt.getTime()) ? enqueuedAt : undefined;
  }

  private async removeRetainedFailedActionJob(
    jobId: string,
    replacementActionType: MaxActionType,
  ): Promise<Queue<MaxActionJob> | undefined> {
    const existingEntries = await this.findActionJobEntries(jobId);
    const failedJobs: Array<Job<MaxActionJob>> = [];
    const retainedQueues: Array<Queue<MaxActionJob>> = [];
    for (const entry of existingEntries) {
      if ((await entry.job.getState()) === 'failed') {
        failedJobs.push(entry.job);
      } else {
        retainedQueues.push(entry.queue);
      }
    }

    if (
      failedJobs.some((job) => this.isRetainedAmbiguousActionFailure(job, replacementActionType))
    ) {
      throw new UnrecoverableError(
        `Retained ambiguous MAX ${replacementActionType} job ${jobId} requires manual review before retry`,
      );
    }

    await Promise.all(failedJobs.map((job) => job.remove()));
    return retainedQueues[0];
  }

  private resolveActionQueue(job: Pick<MaxActionJob, 'actionType' | 'trafficClass'>) {
    const queueName = resolveMaxActionQueueName(job);
    const laneQueue = (() => {
      switch (queueName) {
        case MAX_ACTION_CRITICAL_QUEUE:
          return this.criticalActionQueue;
        case MAX_ACTION_BACKGROUND_QUEUE:
          return this.backgroundActionQueue;
        case MAX_ACTION_INTERACTIVE_QUEUE:
        default:
          return this.interactiveActionQueue;
      }
    })();

    return laneQueue ?? this.actionQueue;
  }

  private getActionQueues(): Array<Queue<MaxActionJob>> {
    return Array.from(
      new Set(
        [
          this.criticalActionQueue,
          this.interactiveActionQueue,
          this.backgroundActionQueue,
          this.actionQueue,
        ].filter((queue): queue is Queue<MaxActionJob> => Boolean(queue)),
      ),
    );
  }

  private async findActionJobs(jobId: string): Promise<Array<Job<MaxActionJob>>> {
    return (await this.findActionJobEntries(jobId)).map((entry) => entry.job);
  }

  private async findActionJobEntries(
    jobId: string,
  ): Promise<Array<{ queue: Queue<MaxActionJob>; job: Job<MaxActionJob> }>> {
    const entries = await Promise.all(
      this.getActionQueues().map(async (queue) => ({
        queue,
        job: await queue.getJob(jobId),
      })),
    );
    return entries.filter(
      (entry): entry is { queue: Queue<MaxActionJob>; job: Job<MaxActionJob> } =>
        Boolean(entry.job),
    );
  }

  private isRetainedAmbiguousActionFailure(
    job: unknown,
    replacementActionType: MaxActionType,
  ): boolean {
    const actionType = this.readRetainedJobActionType(job) ?? replacementActionType;
    if (!this.isIrreversibleQueuedActionType(actionType)) {
      return false;
    }

    const failureText = this.readRetainedJobFailureText(job);
    return failureText.includes('ambiguous max');
  }

  private isIrreversibleQueuedActionType(actionType: MaxActionType): boolean {
    return (
      actionType === 'SEND_MESSAGE' ||
      actionType === 'KICK_MEMBER' ||
      actionType === 'BAN_MEMBER' ||
      actionType === 'TRY_UNBAN_MEMBER'
    );
  }

  private readRetainedJobActionType(job: unknown): MaxActionType | null {
    const value = (job as { data?: { actionType?: unknown } })?.data?.actionType;
    if (
      value === 'DELETE_MESSAGE' ||
      value === 'SEND_MESSAGE' ||
      value === 'KICK_MEMBER' ||
      value === 'BAN_MEMBER' ||
      value === 'UNBAN_MEMBER' ||
      value === 'TRY_UNBAN_MEMBER' ||
      value === 'NOTIFY_MODERATORS'
    ) {
      return value;
    }

    return null;
  }

  private readRetainedJobFailureText(job: unknown): string {
    const values: string[] = [];
    const failedReason = (job as { failedReason?: unknown })?.failedReason;
    if (typeof failedReason === 'string') {
      values.push(failedReason);
    }

    const stacktrace = (job as { stacktrace?: unknown })?.stacktrace;
    if (Array.isArray(stacktrace)) {
      for (const entry of stacktrace) {
        if (typeof entry === 'string') {
          values.push(entry);
        }
      }
    }

    return values.join('\n').toLowerCase();
  }

  private normalizeDelayMs(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return 0;
    }

    const normalized = Math.trunc(value);
    if (normalized <= 0) {
      return 0;
    }

    return Math.min(normalized, MAX_ACTION_DELAY_MS);
  }

  async getMarketplaceChannelPostActivation(chatId: string): Promise<Date | null> {
    try {
      return (await this.marketplaceState?.channelPostActivation(chatId)) ?? null;
    } catch {
      return null;
    }
  }

  async listMarketplaceChannelPostTargets(
    limit: number,
    after?: string,
  ): Promise<{ chatId: string }[]> {
    try {
      return (await this.marketplaceState?.listChannelPostTargets(limit, after)) ?? [];
    } catch {
      return [];
    }
  }

  private async prepareMarketplacePublicationOptions(
    chatId: string,
    options: MaxSendMessageOptions | undefined,
    botId: string,
  ): Promise<MaxSendMessageOptions | undefined> {
    if (
      !options ||
      !this.marketplaceState ||
      !isMarketplacePublicationTarget(chatId, options.marketplacePublication)
    )
      return options;
    try {
      const binding = await this.marketplaceState.resolvePublicationButton({
        chatId,
        botId,
        purpose: options.marketplacePublication!.purpose,
        module: options.marketplacePublication!.module,
      });
      if (!binding) return options;
      const result = appendMarketplacePublicationButton(options, binding.url, binding.caption);
      if (result.outcome === 'KEYBOARD_FULL') {
        await this.marketplaceState.recordButtonDiagnostic({
          chatId,
          botId,
          revision: binding.revision,
          purpose: options.marketplacePublication!.purpose,
          code: 'KEYBOARD_FULL',
        });
      }
      return result.options;
    } catch {
      // FLAG: Optional profile integration failure cannot cancel an authorized publication.
      this.logger.warn('Optional marketplace publication button is unavailable');
      return options;
    }
  }

  private buildMessageAttachments(options?: MaxSendMessageOptions): Record<string, unknown>[] {
    const attachments: Record<string, unknown>[] = [];
    const imageAttachment = this.buildImageAttachment(options?.imagePayload);
    if (imageAttachment) {
      attachments.push(imageAttachment);
    }
    if (Array.isArray(options?.attachments) && options.attachments.length > 0) {
      attachments.push(...this.buildMediaAttachments(options.attachments));
    }
    const keyboardAttachment = this.buildInlineKeyboardAttachment(options);
    if (keyboardAttachment) {
      attachments.push(keyboardAttachment);
    }
    return attachments;
  }

  private buildEditableMessageAttachments(
    message: Record<string, unknown> | null,
    options?: MaxEditableMessageOptions,
    includeForwarded = true,
  ): Record<string, unknown>[] {
    if (options?.requireAllAttachmentsPreserved) {
      const sourceAttachments = readStrictEditableAttachments(message, includeForwarded);
      const sourceAttachmentTypes = sourceAttachments.map(
        (attachment) => this.readLowerString(this.asRecord(attachment)?.type) ?? '',
      );
      // FLAG: Allow keyboards installed after admission, never an omitted known keyboard or media.
      if (
        options.expectedSourceAttachmentTypes !== undefined &&
        (!isDeepStrictEqual(
          sourceAttachmentTypes.filter((type) => type !== 'inline_keyboard'),
          options.expectedSourceAttachmentTypes.filter((type) => type !== 'inline_keyboard'),
        ) ||
          sourceAttachmentTypes.filter((type) => type === 'inline_keyboard').length <
            options.expectedSourceAttachmentTypes.filter((type) => type === 'inline_keyboard')
              .length)
      ) {
        throw new BadRequestException('Source attachments changed; preserving the current post.');
      }
      const result = this.buildEditableMessageAttachments(
        { body: { attachments: sourceAttachments } },
        { ...options, requireAllAttachmentsPreserved: false },
      );
      assertEditableAttachmentsPreserved(sourceAttachments, result, options.buttons ?? []);
      return result;
    }
    const editableAttachments = this.extractEditableAttachments(message, includeForwarded);
    const existingAttachmentsWithoutKeyboard = editableAttachments.filter(
      (attachment) => this.readLowerString(attachment.type) !== 'inline_keyboard',
    );
    const keyboardAttachment = this.buildInlineKeyboardAttachment(options);
    const replaceCallbackPayloadPrefixes = this.normalizeCallbackPayloadPrefixes(
      options?.replaceCallbackPayloadPrefixes,
    );
    if (replaceCallbackPayloadPrefixes.length > 0) {
      const replacedKeyboard = this.replaceEditableInlineKeyboardCallbacks(
        keyboardAttachment,
        editableAttachments,
        replaceCallbackPayloadPrefixes,
        options?.appendNewInlineKeyboardRows === true,
      );
      return replacedKeyboard
        ? [...existingAttachmentsWithoutKeyboard, replacedKeyboard]
        : existingAttachmentsWithoutKeyboard;
    }
    if (keyboardAttachment) {
      if (options?.mergeExistingInlineKeyboard) {
        return [
          ...existingAttachmentsWithoutKeyboard,
          this.mergeEditableInlineKeyboardAttachment(
            keyboardAttachment,
            editableAttachments,
            options.appendNewInlineKeyboardRows === true,
            options.preserveExistingChannelDialogButtons === true,
          ),
        ];
      }
      return [...existingAttachmentsWithoutKeyboard, keyboardAttachment];
    }
    return options?.preserveExistingInlineKeyboard
      ? editableAttachments
      : existingAttachmentsWithoutKeyboard;
  }

  private replaceEditableInlineKeyboardCallbacks(
    primaryKeyboard: Record<string, unknown> | null,
    editableAttachments: readonly Record<string, unknown>[],
    callbackPayloadPrefixes: readonly string[],
    appendNewRows: boolean,
  ): Record<string, unknown> | null {
    const existingKeyboard = editableAttachments.find(
      (attachment) => this.readLowerString(attachment.type) === 'inline_keyboard',
    );
    const existingPayload = this.asRecord(existingKeyboard?.payload);
    const primaryPayload = this.asRecord(primaryKeyboard?.payload);
    const existingRows = Array.isArray(existingPayload?.buttons) ? existingPayload.buttons : [];
    const primaryRows = Array.isArray(primaryPayload?.buttons)
      ? primaryPayload.buttons.filter((row): row is unknown[] => Array.isArray(row))
      : [];
    const preservedRows: unknown[][] = [];
    let insertionIndex: number | null = null;

    for (const row of existingRows) {
      if (!Array.isArray(row)) {
        continue;
      }
      const preservedButtons = row.filter(
        (button) => !this.hasCallbackPayloadPrefix(button, callbackPayloadPrefixes),
      );
      if (preservedButtons.length !== row.length && insertionIndex === null) {
        insertionIndex = preservedRows.length;
      }
      if (preservedButtons.length > 0) {
        preservedRows.push(preservedButtons);
      }
    }

    const existingDialogButtonKeys = new Set(
      preservedRows.flatMap((row) =>
        row.flatMap((button) => {
          const identity = this.readChannelDialogButtonIdentity(button);
          return identity ? [channelDialogButtonPresentationKey(identity)] : [];
        }),
      ),
    );
    const insertedDialogButtonKeys = new Set<string>();
    const resolvedPrimaryRows = primaryRows
      .map((row) =>
        row.filter((button) => {
          const identity = this.readChannelDialogButtonIdentity(button);
          if (!identity) {
            return true;
          }
          const key = channelDialogButtonPresentationKey(identity);
          if (existingDialogButtonKeys.has(key) || insertedDialogButtonKeys.has(key)) {
            return false;
          }
          insertedDialogButtonKeys.add(key);
          return true;
        }),
      )
      .filter((row) => row.length > 0);
    const resolvedInsertionIndex = insertionIndex ?? (appendNewRows ? preservedRows.length : 0);
    const buttons = normalizeMaxInlineKeyboardButtons([
      ...preservedRows.slice(0, resolvedInsertionIndex),
      ...resolvedPrimaryRows,
      ...preservedRows.slice(resolvedInsertionIndex),
    ]);
    if (!buttons) {
      return null;
    }

    return {
      type: 'inline_keyboard',
      payload: {
        ...existingPayload,
        ...primaryPayload,
        buttons,
      },
    };
  }

  private normalizeCallbackPayloadPrefixes(value: readonly string[] | undefined): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return Array.from(
      new Set(
        value
          .map((prefix) => (typeof prefix === 'string' ? prefix.trim() : ''))
          .filter((prefix) => prefix.length > 0),
      ),
    );
  }

  private hasCallbackPayloadPrefix(value: unknown, prefixes: readonly string[]): boolean {
    const button = this.asRecord(value);
    if (this.readLowerString(button?.type) !== 'callback') {
      return false;
    }
    const payload = this.readTrimmedString(button?.payload);
    return Boolean(payload && prefixes.some((prefix) => payload.startsWith(prefix)));
  }

  private mergeEditableInlineKeyboardAttachment(
    primaryKeyboard: Record<string, unknown>,
    editableAttachments: readonly Record<string, unknown>[],
    appendNewRows: boolean,
    preserveExistingDialogButtons: boolean,
  ): Record<string, unknown> {
    const existingKeyboard = editableAttachments.find(
      (attachment) => this.readLowerString(attachment.type) === 'inline_keyboard',
    );
    const primaryPayload = this.asRecord(primaryKeyboard.payload);
    const existingPayload = this.asRecord(existingKeyboard?.payload);
    const primaryRows = Array.isArray(primaryPayload?.buttons) ? primaryPayload.buttons : [];
    const existingRows = Array.isArray(existingPayload?.buttons) ? existingPayload.buttons : [];
    const existingDialogButtons = new Map<
      string,
      { button: unknown; identity: InternalChannelDialogButtonIdentity }
    >();
    for (const row of existingRows) {
      if (!Array.isArray(row)) {
        continue;
      }
      for (const button of row) {
        const identity = this.readChannelDialogButtonIdentity(button);
        if (identity) {
          const key = channelDialogButtonPresentationKey(identity);
          if (!existingDialogButtons.has(key)) {
            existingDialogButtons.set(key, { button, identity });
          }
        }
      }
    }
    const representedDialogButtons = new Set<string>();
    const resolvedPrimaryRows = primaryRows
      .filter((row): row is unknown[] => Array.isArray(row))
      .map((row) =>
        row.flatMap((button) => {
          const identity = this.readChannelDialogButtonIdentity(button);
          if (!identity) {
            return [button];
          }
          const key = channelDialogButtonPresentationKey(identity);
          if (representedDialogButtons.has(key)) {
            return [];
          }
          representedDialogButtons.add(key);
          const existing = existingDialogButtons.get(key);
          if (!existing) {
            return [button];
          }
          // FLAG: Post decoration must not reset a live counter or relabel an existing
          // discussion. Count refresh callers keep the default same-target update path.
          if (preserveExistingDialogButtons) {
            return [existing.button];
          }
          const primaryTarget = this.readInlineKeyboardButtonIdentity(button);
          const existingTarget = this.readInlineKeyboardButtonIdentity(existing.button);
          const sameTarget =
            (primaryTarget !== null && primaryTarget === existingTarget) ||
            (identity.profile === existing.identity.profile &&
              identity.threadId !== null &&
              identity.threadId === existing.identity.threadId);
          return [sameTarget ? button : existing.button];
        }),
      )
      .filter((row) => row.length > 0);
    const primaryButtonIdentities = new Set(
      resolvedPrimaryRows.flatMap((row) =>
        Array.isArray(row)
          ? row
              .map((button) => this.readInlineKeyboardButtonIdentity(button))
              .filter((identity): identity is string => identity !== null)
          : [],
      ),
    );
    const preservedExistingRows = existingRows
      .filter((row): row is unknown[] => Array.isArray(row))
      .map((row) =>
        row.filter((button) => {
          const dialogIdentity = this.readChannelDialogButtonIdentity(button);
          if (
            dialogIdentity &&
            representedDialogButtons.has(channelDialogButtonPresentationKey(dialogIdentity))
          ) {
            return false;
          }
          if (dialogIdentity) {
            representedDialogButtons.add(channelDialogButtonPresentationKey(dialogIdentity));
          }
          const identity = this.readInlineKeyboardButtonIdentity(button);
          return identity === null || !primaryButtonIdentities.has(identity);
        }),
      )
      .filter((row) => row.length > 0);
    const mergedButtons = normalizeMaxInlineKeyboardButtons(
      appendNewRows
        ? [...preservedExistingRows, ...resolvedPrimaryRows]
        : [...resolvedPrimaryRows, ...preservedExistingRows],
    );

    return {
      type: 'inline_keyboard',
      payload: {
        ...existingPayload,
        ...primaryPayload,
        buttons: mergedButtons ?? resolvedPrimaryRows,
      },
    };
  }

  private readChannelDialogButtonIdentity(value: unknown) {
    return readInternalChannelDialogButtonIdentity(
      value,
      this.botRegistry.getPublisherBotDescriptor?.().id,
    );
  }

  private readInlineKeyboardButtonIdentity(value: unknown): string | null {
    const button = this.asRecord(value);
    const type = this.readLowerString(button?.type);
    if (type !== 'link') {
      return null;
    }

    const url = this.readTrimmedString(button?.url);
    return url ? `${type}:${url}` : null;
  }

  private extractReplyMessageLink(
    message: Record<string, unknown> | null,
  ): MaxReplyMessageLink | null {
    const link = this.asRecord(message?.link);
    if (this.readLowerString(link?.type) !== 'reply') {
      return null;
    }

    const linkedMessage = this.asRecord(link?.message);
    const mid = this.readTrimmedString(linkedMessage?.mid ?? link?.mid);
    return mid
      ? {
          type: 'reply',
          mid,
        }
      : null;
  }

  private shouldSkipTextUpdateForInlineKeyboardEdit(
    message: Record<string, unknown> | null,
  ): boolean {
    const body = this.asRecord(message?.body);
    const link = this.asRecord(message?.link);
    const bodyText = typeof body?.text === 'string' ? body.text : null;

    return !bodyText && this.readLowerString(link?.type) === 'forward';
  }

  private extractMessageTextFormat(message: Record<string, unknown> | null): MaxTextFormat | null {
    const body = this.asRecord(message?.body);
    const format = this.readLowerString(body?.format ?? message?.format);

    return format === 'markdown' || format === 'html' ? format : null;
  }

  private buildOutgoingMessageTextPayload(
    message: Record<string, unknown> | null,
    fallbackText: string | null,
    fallbackTextFormat: MaxTextFormat | null = null,
  ): { text: string | null; textFormat: MaxTextFormat | null } {
    const source = this.resolveOutgoingMessageTextSource(message, fallbackText);
    const sourceText = source.text;
    const preferFallbackText = source.fromFallback;
    const text = preferFallbackText ? fallbackText : (sourceText ?? fallbackText);

    if (fallbackTextFormat && typeof fallbackText === 'string') {
      return {
        text: fallbackText,
        textFormat: fallbackTextFormat,
      };
    }

    if (typeof sourceText === 'string' && typeof text === 'string' && text === sourceText) {
      const html = renderMaxTextMarkupAsHtml(sourceText, source.markup);
      if (html && html !== sourceText) {
        return {
          text: html,
          textFormat: 'html',
        };
      }

      const textFormat = source.textFormat;
      if (textFormat) {
        return {
          text,
          textFormat,
        };
      }
    }

    return {
      text,
      textFormat: null,
    };
  }

  private assertExpectedEditableMessageText(
    message: Record<string, unknown> | null,
    options?: MaxEditableMessageOptions,
  ): void {
    if (
      options?.expectedSourceText !== undefined &&
      this.resolveOutgoingMessageTextSource(message, null).text !== options.expectedSourceText
    ) {
      throw new BadRequestException('Source text changed; preserving the current post.');
    }
    if (
      options?.expectedSourceMarkup !== undefined &&
      !isDeepStrictEqual(
        this.resolveOutgoingMessageTextSource(message, null).markup,
        options.expectedSourceMarkup,
      )
    ) {
      throw new BadRequestException('Source formatting changed; preserving the current post.');
    }
  }

  private resolveOutgoingMessageTextSource(
    message: Record<string, unknown> | null,
    fallbackText: string | null,
  ): {
    text: string | null;
    markup: MaxMessageMarkup[];
    textFormat: MaxTextFormat | null;
    fromFallback: boolean;
  } {
    const direct = this.extractMessageTextSource(message);
    if (typeof direct.text === 'string' && direct.text.length > 0) {
      return {
        ...direct,
        fromFallback: false,
      };
    }

    const linked = this.extractForwardedMessageTextSource(message);
    if (typeof linked.text === 'string' && linked.text.length > 0) {
      return {
        ...linked,
        fromFallback: false,
      };
    }

    return {
      text: direct.text,
      markup: direct.markup,
      textFormat: direct.textFormat,
      fromFallback:
        direct.text === '' &&
        typeof fallbackText === 'string' &&
        fallbackText.length > 0 &&
        this.isForwardedMessage(message),
    };
  }

  private extractForwardedMessageTextSource(message: Record<string, unknown> | null): {
    text: string | null;
    markup: MaxMessageMarkup[];
    textFormat: MaxTextFormat | null;
  } {
    if (!this.isForwardedMessage(message)) {
      return {
        text: null,
        markup: [],
        textFormat: null,
      };
    }

    const link = this.asRecord(message?.link);
    const linkedMessage = this.asRecord(link?.message);
    return this.extractMessageTextSource(linkedMessage ?? null);
  }

  private extractMessageTextSource(message: Record<string, unknown> | null): {
    text: string | null;
    markup: MaxMessageMarkup[];
    textFormat: MaxTextFormat | null;
  } {
    const body = this.asRecord(message?.body);
    const text =
      typeof body?.text === 'string'
        ? body.text
        : typeof message?.text === 'string'
          ? message.text
          : null;

    return {
      text,
      markup: this.extractMessageMarkup(message),
      textFormat: this.extractMessageTextFormat(message),
    };
  }

  private isForwardedMessage(message: Record<string, unknown> | null): boolean {
    const link = this.asRecord(message?.link);
    return this.readLowerString(link?.type) === 'forward';
  }

  private extractMessageMarkup(message: Record<string, unknown> | null): MaxMessageMarkup[] {
    const body = this.asRecord(message?.body);
    const rawMarkupCandidate =
      [
        body?.markup,
        body?.text_markup,
        body?.textMarkup,
        body?.caption_markup,
        body?.captionMarkup,
        message?.markup,
        message?.text_markup,
        message?.textMarkup,
        message?.caption_markup,
        message?.captionMarkup,
      ].find((candidate) => Array.isArray(candidate) && candidate.length > 0) ?? [];
    const rawMarkup: unknown[] = Array.isArray(rawMarkupCandidate) ? rawMarkupCandidate : [];

    return rawMarkup
      .map((item: unknown) => this.normalizeMessageMarkup(item))
      .filter((item: MaxMessageMarkup | null): item is MaxMessageMarkup => item !== null);
  }

  private normalizeMessageMarkup(value: unknown): MaxMessageMarkup | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const row = value as Record<string, unknown>;
    const type = this.readLowerString(row.type);
    const from = this.readNullableInteger(row.from);
    const length = this.readNullableInteger(row.length);

    if (
      !type ||
      from === null ||
      length === null ||
      from < 0 ||
      length <= 0 ||
      !isMaxTextMarkupType(type)
    ) {
      return null;
    }

    return {
      from,
      length,
      type,
      url: this.readTrimmedString(row.url),
      userLink: normalizeMaxUserMentionLink(
        row.user_link ?? row.userLink,
        row.user_id ?? row.userId,
      ),
    };
  }

  private extractEditableAttachments(
    message: Record<string, unknown> | null,
    includeForwarded = true,
  ): Record<string, unknown>[] {
    const body = this.asRecord(message?.body);
    const link = this.asRecord(message?.link);
    const linkedMessage = this.asRecord(link?.message);
    const bodyAttachments = Array.isArray(body?.attachments) ? body.attachments : [];
    const linkedAttachments = Array.isArray(linkedMessage?.attachments)
      ? linkedMessage.attachments
      : [];
    const attachments =
      bodyAttachments.length > 0 ||
      !includeForwarded ||
      this.readLowerString(link?.type) !== 'forward' ||
      linkedAttachments.length === 0
        ? bodyAttachments
        : linkedAttachments;
    return attachments
      .map((attachment) => this.normalizeEditableAttachment(attachment))
      .filter((attachment): attachment is Record<string, unknown> => attachment !== null);
  }

  private normalizeEditableAttachment(attachment: unknown): Record<string, unknown> | null {
    if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
      return null;
    }

    const row = attachment as Record<string, unknown>;
    const type = this.readLowerString(row.type);
    const payload = row.payload;
    if (type === 'contact') return { type, payload: normalizeEditableContactPayload(payload) };
    if (!type || !payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return null;
    }

    return {
      type,
      payload,
    };
  }

  private buildImageAttachment(
    imagePayload?: Record<string, unknown>,
  ): Record<string, unknown> | null {
    if (
      !imagePayload ||
      typeof imagePayload !== 'object' ||
      Object.keys(imagePayload).length === 0
    ) {
      return null;
    }

    return {
      type: 'image',
      payload: imagePayload,
    };
  }

  private buildMediaAttachments(attachments: MaxAttachmentPayload[]): Record<string, unknown>[] {
    const normalizedAttachments: Record<string, unknown>[] = [];

    for (const attachment of attachments) {
      if (!attachment || typeof attachment !== 'object') {
        continue;
      }

      const type = this.readLowerString(attachment.type);
      if (type !== 'image' && type !== 'video' && type !== 'audio' && type !== 'file') {
        continue;
      }

      const payload =
        attachment.payload &&
        typeof attachment.payload === 'object' &&
        !Array.isArray(attachment.payload)
          ? attachment.payload
          : null;
      if (!payload || Object.keys(payload).length === 0) {
        continue;
      }

      normalizedAttachments.push({
        type,
        payload,
      });
    }

    return normalizedAttachments;
  }

  private buildMessageLinkData(link?: MaxReplyMessageLink | null): Record<string, unknown> | null {
    if (!link || link.type !== 'reply') {
      return null;
    }

    const mid = typeof link.mid === 'string' ? link.mid.trim() : '';
    if (!mid) {
      return null;
    }

    return {
      type: 'reply',
      mid,
    };
  }

  private buildInlineKeyboardAttachment(
    options?: MaxSendMessageOptions,
  ): Record<string, unknown> | null {
    const buttons = this.normalizeInlineKeyboardButtons(options);
    if (!buttons) {
      return null;
    }

    return {
      type: 'inline_keyboard',
      payload: {
        buttons,
      },
    };
  }

  private normalizeInlineKeyboardButtons(
    options?: MaxSendMessageOptions,
  ): Array<Array<Record<string, unknown>>> | null {
    if (!options) {
      return null;
    }

    const sourceButtons: MaxMessageButton[][] =
      Array.isArray(options.buttons) && options.buttons.length > 0
        ? options.buttons
        : options.button
          ? [[options.button]]
          : [];

    if (sourceButtons.length === 0) {
      return null;
    }

    return normalizeMaxInlineKeyboardButtons(sourceButtons, {
      onTrimmed: (details) => {
        this.logger.warn(
          {
            requestedButtons: details.requestedButtons,
            deliveredButtons: details.deliveredButtons,
            limit: details.buttonLimit,
            requestedRows: details.requestedRows,
            deliveredRows: details.deliveredRows,
            rowLimit: details.rowLimit,
            screen: options.debugContext?.screen ?? null,
            action: options.debugContext?.action ?? null,
          },
          'Inline keyboard exceeds MAX limit; tail buttons were trimmed',
        );
      },
    });
  }

  private async executeReadRequest<T>(
    operation: MaxHttpOperation<T>,
    options: {
      chatId?: string | null;
      trafficClass?: MaxApiTrafficClass;
      actionHealthLane?: ActionHealthLane;
      sourceTag?: string;
      ignoreFailureMetricStatuses?: readonly number[];
      timeoutMs?: number;
      botId?: string;
      messageMutation?: MaxMessageMutationRateLimitScope;
      deferRateLimitReservation?: boolean;
      deferredQuotaState?: { error?: unknown };
    } = {},
    failureObserver?: MaxReadFailureObserver,
  ): Promise<T> {
    const bot = this.resolveBot(options.botId);
    const trafficClass = options.trafficClass ?? 'interactive';
    const actionHealthLane = options.actionHealthLane ?? trafficClass;
    const sourceTag = this.normalizeMetricSourceTag(options.sourceTag);
    const associationOwner = typeof operation === 'function' ? null : createMaxHttpFailureOwner();
    let priorityActivityId: string | undefined;
    try {
      let failureAssociation: MaxHttpFailureAssociation | null = null;
      const circuitPermit = await this.acquireCircuitPermit(bot.id);
      try {
        if (!options.deferRateLimitReservation)
          priorityActivityId = await this.reserveRateLimitSlot(
            bot.id,
            options.chatId ?? null,
            trafficClass,
            sourceTag,
            options.timeoutMs,
            options.messageMutation,
          );
      } catch (error: unknown) {
        await this.releaseUnusedHalfOpenProbe(bot.id, circuitPermit);
        if (trafficClass === 'critical' && error instanceof MaxApiInternalRateLimitError) {
          this.actionHealthService.recordFailureForLane(actionHealthLane, true, bot.id);
          this.logUserFacingActionFailure(error, {
            botId: bot.id,
            trafficClass,
            lane: actionHealthLane,
            sourceTag,
            facts: { failureOrigin: 'local_quota', isCritical: true },
          });
        }
        throw error;
      }

      try {
        const terminal = await this.priorityHttpSource.run(sourceTag, () =>
          this.botContext.runWithBot<T | MaxHttpOutcome<T>>(bot.id, () =>
            typeof operation === 'function'
              ? operation()
              : operation[MAX_HTTP_ASSOCIATED_OPERATION](associationOwner!),
          ),
        );
        let result: T;
        if (associationOwner) {
          const outcome = consumeMaxHttpOutcome(associationOwner, terminal as MaxHttpOutcome<T>);
          if (outcome.kind === 'failure') {
            failureAssociation = outcome.association;
            // FLAG: The observer sees only this owner's consumed, exact HTTP outcome.
            // It cannot replace the thrown error or bypass normal cooldown bookkeeping.
            try {
              failureObserver?.(outcome.error, outcome.association, bot.id);
            } catch {
              // FLAG: Observation failure never changes the original transport result.
            }
            throw outcome.error;
          }
          result = outcome.value;
        } else {
          result = terminal as T;
        }
        await this.closeCircuitAfterSuccessfulProbe(bot.id, circuitPermit);
        this.actionHealthService.recordSuccessForLane(actionHealthLane, bot.id);
        return result;
      } catch (error: unknown) {
        if (error instanceof MaxModerationApiBudgetError) {
          await this.releaseUnusedHalfOpenProbe(bot.id, circuitPermit);
          throw error;
        }
        if (
          options.deferredQuotaState?.error === error &&
          error instanceof MaxApiInternalRateLimitError
        ) {
          await this.releaseUnusedHalfOpenProbe(bot.id, circuitPermit);
          if (trafficClass === 'critical') {
            this.actionHealthService.recordFailureForLane(actionHealthLane, true, bot.id);
            this.logUserFacingActionFailure(error, {
              botId: bot.id,
              trafficClass,
              lane: actionHealthLane,
              sourceTag,
              facts: { failureOrigin: 'local_quota', isCritical: true },
            });
          }
          throw error;
        }
        if (this.shouldIgnoreActionHealthFailure(error, options)) {
          await this.closeCircuitAfterSuccessfulProbe(bot.id, circuitPermit);
          throw error;
        }

        const status = this.extractStatusCode(error);
        const ignoreFailureMetrics =
          typeof status === 'number' &&
          Boolean(options.ignoreFailureMetricStatuses?.includes(status));
        if (ignoreFailureMetrics) {
          await this.closeCircuitAfterSuccessfulProbe(bot.id, circuitPermit);
          throw error;
        }
        const isCritical =
          status === 429 ||
          (typeof status === 'number' && status >= 500) ||
          this.isCriticalNetworkFailure(error);
        this.actionHealthService.recordFailureForLane(actionHealthLane, isCritical, bot.id);
        this.logUserFacingActionFailure(error, {
          botId: bot.id,
          trafficClass,
          lane: actionHealthLane,
          sourceTag,
          facts: { failureOrigin: 'unlinked', isCritical },
          association: failureAssociation,
        });
        if (status === 429) {
          // FLAG: Publish the shared admission stop before unrelated circuit bookkeeping.
          // A slow circuit write must not leave other roles admitting this token's requests.
          try {
            await this.limiterRedis.eval(
              MAX_API_EXTERNAL_COOLDOWN_SCRIPT,
              1,
              `maxapi:gcra:v1:bot:${bot.id}:all:cooldown`,
              String(Math.max(1, readMaxRetryAfterMs(error, Date.now()) || 30_000)),
            );
          } catch {
            // FLAG: Preserve the actual HTTP 429 for durable retry even if Redis is unavailable.
            // The next reservation still fails closed when the authoritative limiter is down.
            this.logger.warn(
              { botId: bot.id },
              'Failed to retain MAX external rate-limit cooldown',
            );
          }
        }
        if (isCritical) {
          await this.registerCriticalFailure(bot.id, circuitPermit);
        } else {
          await this.closeCircuitAfterSuccessfulProbe(bot.id, circuitPermit);
        }
        if (status === 429) {
          await this.recordRateLimitOutcome({
            origin: 'external_429',
            botId: bot.id,
            chatId: options.chatId ?? null,
            trafficClass,
            sourceTag,
            statusCode: status,
            reason: this.extractErrorMessage(error) || 'MAX API 429 rate limit',
          });
        }
        throw error;
      }
    } finally {
      this.releaseHigherPriorityActivity(priorityActivityId);
      if (associationOwner) closeMaxHttpFailureOwner(associationOwner);
    }
  }

  private async executeChatRequest<T>(
    chatId: string,
    operation: MaxHttpOperation<T>,
    options: MaxApiRequestOptions | MaxApiTrafficClass = {},
    failureObserver?: MaxReadFailureObserver,
  ): Promise<T> {
    const normalizedOptions = this.normalizeReadRequestOptions(options);
    return this.executeReadRequest(operation, { chatId, ...normalizedOptions }, failureObserver);
  }

  private async executeGlobalRequest<T>(
    operation: MaxHttpOperation<T>,
    options: MaxApiRequestOptions | MaxApiTrafficClass = {},
    failureObserver?: MaxReadFailureObserver,
  ): Promise<T> {
    const normalizedOptions = this.normalizeReadRequestOptions(options);
    return this.executeReadRequest(operation, normalizedOptions, failureObserver);
  }

  private async executeMutation<T>(
    chatId: string | null,
    operation: MaxHttpOperation<T>,
    options: MaxApiRequestOptions | MaxApiTrafficClass = 'critical',
    executionOptions: {
      requireExecutableBot?: boolean;
      messageMutation?: MaxMessageMutationRateLimitScope;
      deferRateLimitReservation?: boolean;
      deferredQuotaState?: { error?: unknown };
    } = {},
  ): Promise<T> {
    const normalizedOptions = this.normalizeReadRequestOptions(options);
    const executableBot =
      executionOptions.requireExecutableBot === false
        ? null
        : this.resolveExecutableBot(normalizedOptions.botId, {
            explicit: Boolean(normalizedOptions.botId),
          });
    return this.executeReadRequest(operation, {
      chatId,
      trafficClass: normalizedOptions.trafficClass ?? 'critical',
      actionHealthLane: normalizedOptions.actionHealthLane,
      sourceTag: normalizedOptions.sourceTag,
      ignoreFailureMetricStatuses: normalizedOptions.ignoreFailureMetricStatuses,
      timeoutMs: normalizedOptions.timeoutMs,
      botId: executableBot?.id ?? normalizedOptions.botId,
      messageMutation: executionOptions.messageMutation,
      deferRateLimitReservation: executionOptions.deferRateLimitReservation,
      deferredQuotaState: executionOptions.deferredQuotaState,
    });
  }

  private async assertLegacyMessageMutationAllowed(
    chatId: string,
    messageId: string,
  ): Promise<void> {
    if (!this.legacyHolds) return;
    if (
      !chatId.trim() ||
      chatId !== chatId.trim() ||
      !messageId.trim() ||
      messageId !== messageId.trim()
    )
      throw new WebhookLegacyHoldRejectedError();
    if (await this.legacyHolds.isMessageHeld(chatId, messageId))
      throw new WebhookLegacyHoldRejectedError();
  }

  private async assertLegacyMessageLinkAllowed(
    chatId: string,
    link?: MaxReplyMessageLink | null,
  ): Promise<void> {
    // FLAG: A nested reply is still an effect of its exact source. Group send helpers
    // checks the shared permanent hold at transport; its original feature guard stays last.
    if (!this.legacyHolds || link == null) return;
    if (link.type !== 'reply' || typeof link.mid !== 'string')
      throw new WebhookLegacyHoldRejectedError();
    await this.assertLegacyMessageMutationAllowed(chatId, link.mid);
  }

  private async executeMessageMutation<T>(
    operationType: MaxMessageMutationOperation,
    entityId: string | null,
    operation: MaxHttpOperation<T>,
    options: MaxApiRequestOptions | MaxApiTrafficClass = 'critical',
    finalGuard?: (revalidateRoute?: () => Promise<void>) => Promise<void>,
    preparePayload?: (config: Record<string, unknown>) => Promise<void>,
  ): Promise<T> {
    const quotaState: { error?: unknown } = {};
    const scopedOperation =
      entityId && operationType !== 'answer'
        ? scopeMaxHttpOperation(operation, (run) =>
            this.mutationExecutionScope.run(
              {
                chatId: entityId,
                purpose:
                  operationType === 'send'
                    ? 'send_message'
                    : operationType === 'edit'
                      ? 'edit_message'
                      : 'delete_message',
                guardCode:
                  operationType === 'send'
                    ? MAX_SEND_PRE_DISPATCH_GUARD_REJECTED_CODE
                    : operationType === 'edit'
                      ? MAX_EDIT_PRE_DISPATCH_GUARD_REJECTED_CODE
                      : MAX_DELETE_PRE_DISPATCH_GUARD_REJECTED_CODE,
                method:
                  operationType === 'send' ? 'post' : operationType === 'edit' ? 'put' : 'delete',
                path: '/messages',
                requestOptions: this.normalizeReadRequestOptions(options),
                quotaState,
                messageMutation: { operation: operationType, entityId },
                finalGuard,
                preparePayload,
              },
              run,
            ),
          )
        : operation;
    return this.executeMutation(entityId, scopedOperation, options, {
      deferRateLimitReservation: Boolean(entityId && operationType !== 'answer'),
      deferredQuotaState: quotaState,
      messageMutation: {
        operation: operationType,
        entityId,
      },
    });
  }

  private async executeMemberMutation<T>(
    chatId: string,
    method: 'post' | 'delete',
    operation: MaxHttpOperation<T>,
    options: MaxApiRequestOptions,
    finalGuard: ((revalidateRoute?: () => Promise<void>) => Promise<void>) | undefined,
    onDispatchAttempt: () => void,
  ): Promise<T> {
    const quotaState: { error?: unknown } = {};
    return this.executeMutation(
      chatId,
      scopeMaxHttpOperation(operation, (run) =>
        this.mutationExecutionScope.run(
          {
            chatId,
            purpose: 'moderate_member',
            guardCode: MAX_MEMBER_PRE_DISPATCH_GUARD_REJECTED_CODE,
            method,
            path: `/chats/${chatId}/members`,
            requestOptions: this.normalizeReadRequestOptions(options),
            quotaState,
            finalGuard,
            onDispatchAttempt,
          },
          run,
        ),
      ),
      options,
      { deferRateLimitReservation: true, deferredQuotaState: quotaState },
    );
  }

  private normalizeReadRequestOptions(options: MaxApiRequestOptions | MaxApiTrafficClass): {
    boundObject?: import('./max-bound-message').MaxBoundObjectReference;
    trafficClass?: MaxApiTrafficClass;
    actionHealthLane?: ActionHealthLane;
    sourceTag?: string;
    ignoreFailureMetricStatuses?: readonly number[];
    timeoutMs?: number;
    botId?: string;
  } {
    if (typeof options === 'string') {
      return { trafficClass: options };
    }

    return {
      ...(options.boundObject ? { boundObject: options.boundObject } : {}),
      trafficClass: options.trafficClass,
      actionHealthLane: options.actionHealthLane,
      sourceTag: this.normalizeMetricSourceTag(options.sourceTag) ?? undefined,
      ignoreFailureMetricStatuses: this.normalizeFailureMetricStatuses(
        options.ignoreFailureMetricStatuses,
      ),
      timeoutMs: this.normalizeTimeoutMs(options.timeoutMs),
      botId: this.readTrimmedString(options.botId) ?? undefined,
    };
  }

  private normalizeTimeoutMs(value: number | null | undefined): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.max(1, Math.trunc(value))
      : undefined;
  }

  private shouldIgnoreActionHealthFailure(
    error: unknown,
    options: {
      trafficClass?: MaxApiTrafficClass;
      actionHealthLane?: ActionHealthLane;
      ignoreFailureMetricStatuses?: readonly number[];
    },
  ): boolean {
    if (wasMaxPreDispatchGuardRejected(error)) {
      return true;
    }
    const status = this.extractStatusCode(error);
    if (
      typeof status === 'number' &&
      Boolean(options.ignoreFailureMetricStatuses?.includes(status))
    ) {
      return true;
    }

    if (options.trafficClass === 'critical') {
      return false;
    }

    if (typeof status === 'number') {
      return false;
    }

    const message = this.extractErrorMessage(error);
    return message.includes('rate limit exceeded') || message.includes('circuit breaker');
  }

  private logUserFacingActionFailure(
    error: unknown,
    params: {
      botId: string;
      trafficClass: MaxApiTrafficClass;
      lane: ActionHealthLane;
      sourceTag: string | null;
      facts: MaxActionFailureFacts;
      association?: MaxHttpFailureAssociation | null;
    },
  ): void {
    if (params.trafficClass === 'background' || params.lane === 'background') {
      return;
    }

    const entry = {
      statusCode: this.extractStatusCode(error) ?? null,
      errorCode: this.extractActionFailureErrorCode(error),
      limitScope: error instanceof MaxApiInternalRateLimitError ? error.limitScope : null,
      trafficClass: params.trafficClass,
      lane: params.lane,
      sourceTag: params.sourceTag,
      botId: params.botId,
      ...projectMaxActionFailureDiagnostic(params.facts, params.association),
    };
    if (this.actionFailureLog.record(entry))
      this.logger.warn(entry, 'Recorded unignored user-facing MAX API action failure');
  }

  private buildQueuedActionMutationOptions(
    action: MaxActionJob,
    botId: string,
  ): MaxApiRequestOptions {
    return {
      botId,
      trafficClass: action.trafficClass,
      actionHealthLane: action.actionHealthLane,
      sourceTag: this.normalizeMetricSourceTag(action.sourceTag) ?? undefined,
      timeoutMs: this.normalizeTimeoutMs(action.timeoutMs),
      ignoreFailureMetricStatuses: this.normalizeFailureMetricStatuses(
        action.ignoreFailureMetricStatuses,
      ),
    };
  }

  private async assertChatMutationExecutionProof(
    chatId: string,
    botId: string,
    purpose: MaxExecutionPurpose,
    requestOptions: MaxApiRequestOptions = {},
    existingMessage?: {
      messageId: string;
      object?: import('./max-bound-message').MaxBoundObjectReference;
    },
  ): Promise<MaxExecutionRouteProof | null> {
    const link = this.maxBotLinkService;
    if (
      chatId.startsWith('user:') ||
      isPrivateDirectChatId(chatId) ||
      this.botRegistry.getPublisherBotDescriptor?.().id === botId
    )
      return null;
    if (!link || typeof link.getFreshChatBotExecutionProof !== 'function') return null;
    const maxAgeMs = purpose === 'send_message' ? 15 * 60_000 : 5 * 60_000;
    let proof = await link.getFreshChatBotExecutionProof({
      chatId,
      botId,
      purpose,
      maxAgeMs,
      ...(existingMessage ? { existingMessage } : {}),
    });
    if (!proof) {
      const state = await link.loadChatExecutionOwnerState?.(chatId);
      if (state?.fixedModeratorBotId && state.fixedModeratorBotId !== botId)
        throw Object.assign(new Error('MAX action does not belong to the assigned moderator'), {
          code: 'max_action_executor_proof_rejected',
        });
      // FLAG: Missing known action rights wait for administrator activation; a final
      // mutation preflight must not repeatedly re-probe a denied optional capability.
      if (await link.isChatBotExecutionActivationRequired?.(chatId, botId, purpose))
        throw Object.assign(new Error('MAX action capability requires explicit activation'), {
          code: 'max_action_executor_proof_rejected',
        });
      const checkedAt = new Date();
      let access: MaxChatMemberAccess;
      try {
        access = await this.getCurrentChatMemberAccess(chatId, {
          botId,
          bypassCache: true,
          trafficClass: requestOptions.trafficClass ?? 'critical',
          sourceTag: 'action_executor_preflight',
          timeoutMs: requestOptions.timeoutMs,
        });
      } catch (error: unknown) {
        const status = this.extractStatusCode(error);
        if (status !== 403 && status !== 404) throw error;
        // FLAG: A rejected own-member lookup precedes the mutation. Its definite access
        // denial can refresh survivor routing; timeout/500 must not enter this branch.
        throw Object.assign(
          new Error('MAX action executor access proof rejected', { cause: error }),
          {
            code: 'max_action_executor_proof_rejected',
            response: (error as { response?: unknown }).response,
          },
        );
      }
      await link.recordBotAccessProbe({
        chatId,
        botId,
        access,
        checkedAt,
        source: 'action_executor_preflight',
      });
      proof = await link.getFreshChatBotExecutionProof({
        chatId,
        botId,
        purpose,
        maxAgeMs,
        ...(existingMessage ? { existingMessage } : {}),
      });
    }
    if (!proof) {
      throw Object.assign(new Error('MAX action executor has no current capability proof'), {
        code: 'max_action_executor_proof_rejected',
      });
    }
    return proof;
  }

  private buildAutoDeleteDispatchOptions(
    action: MaxActionJob,
    botId: string,
    delayMs: number,
  ): MaxActionDispatchOptions {
    const sourceTag = this.normalizeMetricSourceTag(action.sourceTag);
    const timeoutMs = this.normalizeTimeoutMs(action.timeoutMs);
    const ignoreFailureMetricStatuses = this.normalizeFailureMetricStatuses(
      action.ignoreFailureMetricStatuses,
    )?.filter((status) => status !== 403 && status !== 404);

    return {
      delayMs,
      botId,
      ...(action.trafficClass ? { trafficClass: action.trafficClass } : {}),
      actionHealthLane: 'background',
      ...(sourceTag ? { sourceTag } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      ...(ignoreFailureMetricStatuses?.length ? { ignoreFailureMetricStatuses } : {}),
      ...(action.ledgerContext ? { ledgerContext: action.ledgerContext } : {}),
    };
  }

  private readSendAutoDeleteMarker(
    action: MaxActionJob,
    boundBotId: string,
  ): MaxSendAutoDeleteMarker | null {
    const marker = action.sendAutoDelete;
    if (marker === undefined) {
      return null;
    }
    if (
      action.actionType !== 'DELETE_MESSAGE' ||
      !action.messageId?.trim() ||
      !isMaxSendAutoDeleteMarker(marker) ||
      marker.originBotId !== boundBotId
    ) {
      throw new UnrecoverableError(
        `Invalid send-side auto-delete verification marker for ${action.idempotencyKey}`,
      );
    }
    const markerRecord = marker as unknown as Record<string, unknown>;
    delete markerRecord.confirmedAt;
    delete markerRecord.confirmationKind;
    delete markerRecord.exactAbsenceVerifiedAt;
    delete markerRecord.exactAbsenceVerificationPhase;
    return marker;
  }

  private async readSendAutoDeleteExactPresence(
    action: MaxActionJob,
    messageId: string,
    boundBotId: string,
    requestOptions: MaxApiRequestOptions,
  ): Promise<MaxExactMessagePresence> {
    const verificationIgnoreFailureMetricStatuses = this.normalizeFailureMetricStatuses([
      ...(requestOptions.ignoreFailureMetricStatuses ?? []),
      403,
      404,
    ]);
    try {
      return await this.getExactMessagePresence(action.chatId, messageId, {
        ...requestOptions,
        botId: boundBotId,
        bypassCache: true,
        ignoreFailureMetricStatuses: verificationIgnoreFailureMetricStatuses,
      });
    } catch (cause: unknown) {
      const error = createMaxSendAutoDeleteVerificationError(cause);
      const diagnostic = error.maxSendAutoDeleteVerificationDiagnostic;
      this.logger.warn(
        {
          botId: boundBotId,
          trafficClass: action.trafficClass ?? null,
          actionHealthLane: action.actionHealthLane ?? null,
          sourceTag: this.normalizeMetricSourceTag(action.sourceTag),
          attempt: Number.isInteger(action.attempt) ? action.attempt : null,
          verificationCauseKind: diagnostic.kind,
          verificationStatusCode: diagnostic.statusCode,
          verificationErrorCode: diagnostic.errorCode,
        },
        'Failed exact MAX presence verification for send-side auto-delete',
      );
      throw error;
    }
  }

  private markSendAutoDeleteConfirmed(
    marker: MaxSendAutoDeleteMarker,
    confirmationKind: MaxSendAutoDeleteConfirmationKind,
  ): void {
    const markerRecord = marker as unknown as Record<string, unknown>;
    markerRecord.version = MAX_SEND_AUTO_DELETE_MARKER_VERSION;
    markerRecord.confirmedAt = new Date().toISOString();
    markerRecord.confirmationKind = confirmationKind;
    delete markerRecord.exactAbsenceVerifiedAt;
    delete markerRecord.exactAbsenceVerificationPhase;
  }

  private async executeQueuedSendMessage(
    action: MaxActionJob,
    attachments: Record<string, unknown>[],
    mutationOptions: MaxApiRequestOptions,
    beforeMutation?: (revalidateRoute?: () => Promise<void>) => Promise<void>,
  ): Promise<MaxQueuedSendResponse> {
    const ruleNotice = hasMaxModerationRuleNoticeProof(action);
    const subscriptionNotice = isMaxRequiredSubscriptionNoticeAction(action);
    const duplicateNotice = isMaxDuplicateNoticeAction(action);
    const hasFinalNoticeAuthority = ruleNotice || subscriptionNotice || duplicateNotice;
    const finalNoticeGuard =
      hasFinalNoticeAuthority || requiresMaxModerationNoticeEnvelope(action)
        ? async (revalidateRoute?: () => Promise<void>) => {
            assertMaxModerationNoticeEnvelope(action);
            // FLAG: Only the last composed authority may reserve transport. Earlier
            // guards can still perform remote reads; none can consume its future slot.
            await beforeMutation?.(hasFinalNoticeAuthority ? undefined : revalidateRoute);
            const selectedBotId =
              this.readTrimmedString(mutationOptions.botId) ?? this.getCurrentBot().id;
            const readOptions = (botId: string, timeoutMs: number): MaxApiRequestOptions => ({
              botId,
              timeoutMs,
              bypassCache: true,
              trafficClass: 'critical',
              actionHealthLane: 'critical',
              sourceTag: MAX_API_SOURCE_TAGS.MODERATION_SANCTION,
            });
            const getMemberAccess = ({
              chatId,
              userId,
              botId,
              timeoutMs,
            }: {
              chatId: string;
              userId: string;
              botId: string;
              timeoutMs: number;
            }) => this.getChatMemberAccess(chatId, userId, readOptions(botId, timeoutMs));
            if (ruleNotice) {
              if (!this.moderationRuleNoticeGuard)
                throw new UnrecoverableError('Moderation rule notice guard unavailable');
              await this.moderationRuleNoticeGuard.assertAllowed(
                action,
                selectedBotId,
                getMemberAccess,
                subscriptionNotice || duplicateNotice ? undefined : revalidateRoute,
              );
            }
            if (subscriptionNotice) {
              if (!this.requiredSubscriptionNoticeGuard)
                throw new UnrecoverableError('Required subscription notice guard unavailable');
              await this.requiredSubscriptionNoticeGuard.assertAllowed(action, selectedBotId, {
                getMemberAccess,
                getSource: ({ chatId, messageId, botId, timeoutMs }) =>
                  this.getExactMessageRow(chatId, messageId, {
                    ...readOptions(botId, timeoutMs),
                    // FLAG: Source denial/absence still rejects the notice before SEND;
                    // it does not establish deletion or global MAX transport pressure.
                    ignoreFailureMetricStatuses: [403, 404],
                  }),
                getMembership: async ({ targetId, userId, timeoutMs }) => {
                  const targetBotId = await this.maxBotLinkService?.resolveBotIdForRead({
                    chatId: targetId,
                  });
                  if (!targetBotId)
                    throw new Error('Required subscription notice target read route unavailable');
                  const members = await this.getChatMembersAccess(
                    targetId,
                    [userId],
                    readOptions(targetBotId, timeoutMs),
                  );
                  return members.has(userId);
                },
                beforeFinalAuthority: duplicateNotice ? undefined : revalidateRoute,
              });
            }
            if (duplicateNotice) {
              if (!this.duplicateNoticeGuard)
                throw new UnrecoverableError('Duplicate notice guard unavailable');
              await this.duplicateNoticeGuard.assertAllowed(action, selectedBotId, revalidateRoute);
            }
          }
        : beforeMutation;
    if (
      finalNoticeGuard &&
      (hasFinalNoticeAuthority || usesMaxFinalAuthorityCheckpoint(beforeMutation))
    )
      withMaxFinalAuthorityCheckpoint(finalNoticeGuard);
    const preparePublication = action.options?.marketplacePublication
      ? async (config: Record<string, unknown>) => {
          const options = await this.prepareMarketplacePublicationOptions(
            action.chatId,
            action.options,
            this.getCurrentBot().id,
          );
          const currentAttachments =
            options === action.options ? attachments : this.buildMessageAttachments(options);
          const data = config.data as Record<string, unknown>;
          if (currentAttachments.length) data.attachments = currentAttachments;
          else delete data.attachments;
        }
      : undefined;
    const messageLink = this.buildMessageLinkData(action.options?.messageLink);
    const hasText = typeof action.text === 'string' && action.text.trim().length > 0;
    if (!hasText && attachments.length === 0 && !messageLink) {
      throw new UnrecoverableError('MAX SEND_MESSAGE payload has no text, attachments, or link');
    }
    const sendBotId = this.readTrimmedString(mutationOptions.botId) ?? this.getCurrentBot().id;
    const sendRequest = () =>
      runWithMaxSendCapacityAttempt(action, sendBotId, () =>
        runWithMaxSendHttpObservation(action.idempotencyKey, () =>
          this.request<Record<string, unknown>>('post', '/messages', {
            params: {
              chat_id: action.chatId,
            },
            data: {
              text: hasText ? action.text : null,
              ...(hasText && action.options?.textFormat
                ? { format: action.options.textFormat }
                : {}),
              ...(messageLink ? { link: messageLink } : {}),
              ...(attachments.length > 0 ? { attachments } : {}),
            },
            ...(mutationOptions.timeoutMs ? { timeout: mutationOptions.timeoutMs } : {}),
          }),
        ),
      );

    if (!this.actionLedgerService) {
      try {
        return await this.executeMessageMutation(
          'send',
          action.chatId,
          sendRequest,
          mutationOptions,
          finalNoticeGuard,
          preparePublication,
        );
      } catch (error: unknown) {
        if (isAmbiguousMaxSendError(error)) {
          throw this.createAmbiguousQueuedMutationError(
            `Ambiguous MAX SEND_MESSAGE transport failure for chat ${action.chatId}: ${this.extractErrorMessage(error) || 'no HTTP status'}`,
            error,
          );
        }
        throw error;
      }
    }

    let dispatchToken: string | null = null;
    try {
      return await this.executeMessageMutation(
        'send',
        action.chatId,
        async () => {
          const botId = this.readTrimmedString(mutationOptions.botId) ?? this.getCurrentBot().id;
          // FLAG: This fence stores dispatch identity, not message payload. Resolve optional
          // presentation after the later quota wait; a recovered fence never enters HTTP preparation.
          const claim = await this.actionLedgerService!.claimSendDispatch(action, botId);
          if (claim.kind === 'recovered') {
            const dispatchBotId = this.assertRecoveredSendDispatchBot(action, claim.dispatchBotId);
            const completedSendDispatch: MaxCompletedSendDispatch = {
              remoteMessageId: claim.remoteMessageId,
              dispatchBotId,
              completedAt: claim.completedAt ?? null,
            };
            return {
              message_id: claim.remoteMessageId,
              [MAX_RECOVERED_SEND_DISPATCH_RESPONSE]: {
                dispatchBotId,
                completedAt: claim.completedAt ?? null,
              },
              [MAX_SEND_DISPATCH_COMPLETION_RESPONSE]: completedSendDispatch,
            };
          }

          dispatchToken = claim.dispatchToken;
          const response = await sendRequest();
          const remoteMessageId = this.extractMessageIdFromSendResponse(response);
          observeMaxSendAcknowledgement(action.idempotencyKey, Boolean(remoteMessageId));
          if (!remoteMessageId) {
            throw new Error('MAX SEND_MESSAGE response has no remote message id');
          }
          const persistenceStarted = optimizationNow();
          let persistenceFailed = true;
          let completedAt: Date | null;
          try {
            completedAt = await this.actionLedgerService!.completeSendDispatch(
              action,
              claim.dispatchToken,
              remoteMessageId,
            );
            persistenceFailed = false;
          } finally {
            this.storageMetrics?.optimization.timing(
              'sendReceipt',
              optimizationElapsed(persistenceStarted),
              persistenceFailed,
            );
          }
          return {
            ...response,
            [MAX_SEND_DISPATCH_COMPLETION_RESPONSE]: {
              remoteMessageId,
              dispatchBotId: botId,
              completedAt,
            },
          };
        },
        mutationOptions,
        finalNoticeGuard,
        preparePublication,
      );
    } catch (error: unknown) {
      // FLAG: An exact SEND receipt can arrive after the initial read. Recover only
      // that positive identity before a hold denial; never start another HTTP request.
      if (error instanceof WebhookLegacyHoldRejectedError) {
        // FLAG: This optional positive-receipt read cannot erase a proven pre-HTTP
        // rejection or bypass the mandatory release of this attempt's dispatch token.
        const receipt = await this.actionLedgerService
          .getCompletedSendDispatchResult?.(action)
          .catch(() => null);
        if (receipt?.remoteMessageId) {
          const dispatchBotId = this.assertRecoveredSendDispatchBot(action, receipt.dispatchBotId);
          return {
            message_id: receipt.remoteMessageId,
            [MAX_RECOVERED_SEND_DISPATCH_RESPONSE]: {
              dispatchBotId,
              completedAt: receipt.completedAt,
            },
          };
        }
      }
      if (!dispatchToken) {
        certifyMaxSendCapacityDeferral(error, action, sendBotId);
        throw error;
      }

      if (wasMaxPreDispatchGuardRejected(error)) {
        try {
          await this.actionLedgerService.releaseSendDispatch(action, dispatchToken);
        } catch (releaseError: unknown) {
          return this.throwAmbiguousQueuedSend(
            action,
            dispatchToken,
            releaseError,
            `Ambiguous MAX SEND_MESSAGE fence release after pre-dispatch guard rejection for chat ${action.chatId}`,
          );
        }
        certifyMaxSendCapacityDeferral(error, action, sendBotId);
        throw error;
      }

      if (this.isDefinitiveQueuedSendRejection(error)) {
        try {
          await this.actionLedgerService.releaseSendDispatch(action, dispatchToken);
        } catch (releaseError: unknown) {
          return this.throwAmbiguousQueuedSend(
            action,
            dispatchToken,
            releaseError,
            `Ambiguous MAX SEND_MESSAGE fence release after definitive rejection for chat ${action.chatId}`,
          );
        }
        if (
          this.extractStatusCode(error) !== 429 &&
          !this.isRetryableDefinitiveQueuedSendRejection(error)
        ) {
          throw this.createUnrecoverableQueuedMutationError(
            `MAX SEND_MESSAGE received definitive HTTP ${this.extractStatusCode(error) ?? '4xx'} for chat ${action.chatId}`,
            error,
          );
        }
        throw error;
      }

      return this.throwAmbiguousQueuedSend(
        action,
        dispatchToken,
        error,
        `Ambiguous MAX SEND_MESSAGE transport failure for chat ${action.chatId}: ${this.extractErrorMessage(error) || 'no HTTP status'}`,
      );
    }
  }

  private isDefinitiveQueuedSendRejection(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    return typeof status === 'number' && status >= 400 && status < 500 && status !== 408;
  }

  private isRetryableDefinitiveQueuedSendRejection(error: unknown): boolean {
    if (this.extractStatusCode(error) !== 400) {
      return false;
    }

    const payload = (error as { response?: { data?: unknown } })?.response?.data;
    const normalized = JSON.stringify(payload ?? '').toLowerCase();
    return normalized.includes('attachment.not.ready') || normalized.includes('not ready');
  }

  private async throwAmbiguousQueuedSend(
    action: MaxActionJob,
    dispatchToken: string,
    cause: unknown,
    message: string,
  ): Promise<MaxQueuedSendResponse> {
    const error = this.createAmbiguousQueuedMutationError(message, cause);
    let finalized = false;
    try {
      const quarantined = await this.actionLedgerService?.recordAmbiguousSendDispatch(
        action,
        dispatchToken,
        error,
      );
      if (quarantined) {
        markMaxSendDispatchLedgerFinalized(error);
        finalized = true;
      }
    } catch (ledgerError: unknown) {
      this.logger.warn(
        {
          actionType: action.actionType,
          chatId: action.chatId,
          botId: action.botId ?? null,
          error: this.extractErrorMessage(ledgerError),
        },
        'Failed to quarantine ambiguous MAX SEND_MESSAGE dispatch fence',
      );
    }

    if (!finalized) {
      const recovered =
        typeof this.actionLedgerService?.getCompletedSendDispatchResult === 'function'
          ? await this.actionLedgerService.getCompletedSendDispatchResult(action)
          : null;
      const recoveredRemoteMessageId =
        recovered?.remoteMessageId ??
        (typeof this.actionLedgerService?.getCompletedSendDispatchResult !== 'function'
          ? await this.actionLedgerService?.getCompletedSendDispatch?.(action)?.catch(() => null)
          : null);
      if (recoveredRemoteMessageId) {
        const dispatchBotId = this.assertRecoveredSendDispatchBot(
          action,
          recovered?.dispatchBotId ?? null,
        );
        const completedSendDispatch: MaxCompletedSendDispatch = {
          remoteMessageId: recoveredRemoteMessageId,
          dispatchBotId,
          completedAt: recovered?.completedAt ?? null,
        };
        return {
          message_id: recoveredRemoteMessageId,
          [MAX_RECOVERED_SEND_DISPATCH_RESPONSE]: {
            dispatchBotId,
            completedAt: recovered?.completedAt ?? null,
          },
          [MAX_SEND_DISPATCH_COMPLETION_RESPONSE]: completedSendDispatch,
        };
      }
    }
    throw error;
  }

  private assertRecoveredSendDispatchBot(
    action: MaxActionJob,
    persistedDispatchBotId: string | null | undefined,
  ): string | null {
    const dispatchBotId = this.readTrimmedString(persistedDispatchBotId);
    const requiredBotId = this.readTrimmedString(action.routing?.requiredBotId);
    if (requiredBotId && dispatchBotId !== requiredBotId) {
      throw new UnrecoverableError(
        `Completed MAX SEND_MESSAGE ${action.idempotencyKey} is not bound to required bot ${requiredBotId}`,
      );
    }
    return dispatchBotId;
  }

  private async executeQueuedMemberModerationAction(
    action: MaxActionJob,
    mutationOptions: MaxApiRequestOptions,
    options: {
      block: boolean;
      explicitBlock?: boolean;
      beforeMutation?: (revalidateRoute?: () => Promise<void>) => Promise<void>;
    },
  ): Promise<void> {
    let memberMutationAttempted = false;
    try {
      await this.executeMemberMutation(
        action.chatId,
        'delete',
        associatedMaxHttpOperation(async (owner) => {
          const response = await this.request(
            'delete',
            `/chats/${action.chatId}/members`,
            {
              params: {
                user_id: action.userId,
                ...(options.block || options.explicitBlock ? { block: options.block } : {}),
              },
              ...(mutationOptions.timeoutMs ? { timeout: mutationOptions.timeoutMs } : {}),
            },
            owner,
          );
          return mapMaxHttpOutcome(response, (value) => {
            this.assertSuccessfulMemberMutationResponse(value);
          });
        }),
        mutationOptions,
        options.beforeMutation,
        () => {
          memberMutationAttempted = true;
        },
      );
    } catch (error: unknown) {
      const dispatchedError = memberMutationAttempted
        ? markMaxMemberMutationAttempted(error)
        : error;
      if (
        memberMutationAttempted &&
        this.isAmbiguousQueuedMutationTransportError(dispatchedError)
      ) {
        throw this.createAmbiguousQueuedMutationError(
          `Ambiguous MAX ${action.actionType} transport failure for chat ${action.chatId} user ${action.userId}: ${this.extractErrorMessage(dispatchedError) || 'no HTTP status'}`,
          dispatchedError,
        );
      }
      throw dispatchedError;
    }
  }

  private async runPreDispatchMutationGuard(
    guard: (() => Promise<void>) | undefined,
    fallbackCode: string,
  ): Promise<void> {
    if (!guard) {
      return;
    }
    try {
      await guard();
    } catch (error: unknown) {
      throw markMaxPreDispatchGuardRejected(error, fallbackCode);
    }
  }

  private normalizeFailureMetricStatuses(
    statuses: readonly number[] | undefined,
  ): number[] | undefined {
    if (!Array.isArray(statuses)) {
      return undefined;
    }

    const normalized = Array.from(
      new Set(
        statuses.filter((status): status is number => Number.isInteger(status) && status > 0),
      ),
    );
    return normalized.length > 0 ? normalized : undefined;
  }

  private extractMessageIdFromSendResponse(payload: unknown): string | null {
    const queue: Array<{ node: unknown; depth: number }> = [{ node: payload, depth: 0 }];
    const visited = new Set<unknown>();

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || current.depth > 4) {
        continue;
      }

      const { node, depth } = current;
      if (!node || typeof node !== 'object') {
        continue;
      }

      if (visited.has(node)) {
        continue;
      }
      visited.add(node);

      if (Array.isArray(node)) {
        for (const item of node) {
          queue.push({ node: item, depth: depth + 1 });
        }
        continue;
      }

      const row = node as Record<string, unknown>;
      const directCandidates = [row.message_id, row.messageId, row.mid];
      for (const value of directCandidates) {
        if (typeof value === 'string' || typeof value === 'number') {
          return String(value);
        }
      }

      if (typeof row.id === 'string' || typeof row.id === 'number') {
        return String(row.id);
      }

      for (const value of Object.values(row)) {
        if (value && (typeof value === 'object' || Array.isArray(value))) {
          queue.push({ node: value, depth: depth + 1 });
        }
      }
    }

    return null;
  }

  private buildExactMessagePresenceRequestKey(request: MaxExactMessagePresenceRequest): string {
    return JSON.stringify([request.chatId, request.messageId]);
  }

  private createExactMessageTargetMismatchError(
    expectedChatId: string,
    responseChatId: string,
    messageId: string,
  ): Error {
    return new Error(
      `MAX exact message lookup returned ${messageId} for chat ${responseChatId} instead of ${expectedChatId}`,
    );
  }

  private createUnscopedExactMessageTargetError(messageId: string): Error {
    return new Error(
      `MAX exact message lookup returned ${messageId} without a chat id for multiple targets`,
    );
  }

  private extractChatIdFromSendResponse(payload: unknown): string | null {
    const queue: Array<{ node: unknown; depth: number }> = [{ node: payload, depth: 0 }];
    const visited = new Set<unknown>();

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || current.depth > 4) {
        continue;
      }

      const { node, depth } = current;
      if (!node || typeof node !== 'object') {
        continue;
      }

      if (visited.has(node)) {
        continue;
      }
      visited.add(node);

      if (Array.isArray(node)) {
        for (const item of node) {
          queue.push({ node: item, depth: depth + 1 });
        }
        continue;
      }

      const row = node as Record<string, unknown>;
      const recipient = this.asRecord(row.recipient);
      const chatIdValue = recipient?.chat_id ?? recipient?.chatId ?? row.chat_id ?? row.chatId;
      if (typeof chatIdValue === 'number' || typeof chatIdValue === 'string') {
        const normalized = String(chatIdValue).trim();
        if (normalized) {
          return normalized;
        }
      }

      for (const value of Object.values(row)) {
        queue.push({ node: value, depth: depth + 1 });
      }
    }

    return null;
  }

  private readConfigInt(value: unknown, fallback: number, min = 1): number {
    const numericValue =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim().length > 0
          ? Number(value)
          : Number.NaN;
    if (Number.isFinite(numericValue) && numericValue >= min) {
      return Math.trunc(numericValue);
    }

    return fallback;
  }

  private async reserveRateLimitSlot(
    botId: string,
    chatId: string | null,
    trafficClass: MaxApiTrafficClass,
    sourceTag?: string | null,
    maxWaitMsOverride?: number,
    messageMutation?: MaxMessageMutationRateLimitScope,
  ) {
    // FLAG: Publication SEND owns a durable recipient retry. Yield capacity immediately
    // instead of occupying its serialized worker during a shared token cooldown.
    const durablePublisherSend =
      messageMutation?.operation === 'send' &&
      this.normalizeMetricSourceTag(sourceTag) === MAX_API_SOURCE_TAGS.MANAGED_BROADCAST &&
      this.botRegistry.getPublisherBotDescriptor?.().id === botId;
    const configuredMaxWaitMs = durablePublisherSend
      ? 0
      : this.resolveTrafficClassRateLimitWaitMs(trafficClass, sourceTag, messageMutation);
    const maxWaitMs =
      typeof maxWaitMsOverride === 'number' && Number.isFinite(maxWaitMsOverride)
        ? Math.max(0, Math.min(configuredMaxWaitMs, Math.trunc(maxWaitMsOverride)))
        : configuredMaxWaitMs;
    const startedAtMs = Date.now();
    const activityId =
      this.normalizeMetricSourceTag(sourceTag) === MAX_API_SOURCE_TAGS.MESSAGE_RETENTION
        ? undefined
        : randomUUID();

    const reserve = () => {
      if (this.stopping) throw new Error('MAX client is stopping');
      return this.tryReserveRateLimitSlot(
        botId,
        chatId,
        trafficClass,
        sourceTag,
        messageMutation,
        activityId,
      );
    };
    let reservation = await reserve();
    while (!reservation.ok) {
      const elapsedMs = Date.now() - startedAtMs;
      const remainingWaitMs = maxWaitMs - elapsedMs;
      if (remainingWaitMs <= 0 || reservation.limitScope === 'retention_priority') {
        await this.recordRateLimitOutcome({
          origin: 'internal_limiter',
          botId,
          chatId,
          trafficClass,
          sourceTag,
          reason: reservation.reason,
          retryAfterMs: reservation.retryAfterMs,
          limitScope: reservation.limitScope,
        });
        throw markMaxApiCapacityRefusal(
          new MaxApiInternalRateLimitError(
            reservation.reason,
            reservation.retryAfterMs,
            reservation.limitScope,
          ),
          { botId, chatId, operation: messageMutation?.operation },
        );
      }

      await this.sleep(
        Math.min(remainingWaitMs, Math.max(this.rateLimitRetryFloorMs, reservation.retryAfterMs)),
      );
      // FLAG: An expired local wait cannot acquire fresh quota or dispatch HTTP,
      // even if a delayed timer wakes after the remote cooldown has ended.
      if (Date.now() - startedAtMs < maxWaitMs) reservation = await reserve();
    }
    if (activityId) this.renewHigherPriorityActivity(activityId);
    this.recordRateLimitUsageWithoutWaiting(botId, trafficClass, sourceTag);
    return activityId;
  }

  private shouldApplyManagedRefreshSourceLimit(
    trafficClass: MaxApiTrafficClass,
    sourceTag?: string | null,
  ): boolean {
    return (
      trafficClass !== 'critical' &&
      this.normalizeMetricSourceTag(sourceTag) === MAX_API_SOURCE_TAGS.MANAGED_REFRESH &&
      this.managedRefreshRpsLimit > 0
    );
  }

  private async tryReserveRateLimitSlot(
    botId: string,
    chatId: string | null,
    trafficClass: MaxApiTrafficClass,
    sourceTag?: string | null,
    messageMutation?: MaxMessageMutationRateLimitScope,
    activityId?: string,
  ): Promise<
    | { ok: true }
    | {
        ok: false;
        retryAfterMs: number;
        reason: string;
        limitScope: MaxApiRateLimitScope;
      }
  > {
    const messageMutationScope = messageMutation
      ? messageMutation.entityId
        ? `target:${encodeURIComponent(messageMutation.entityId)}`
        : `unknown-target:bot:${encodeURIComponent(botId)}`
      : null;
    const dimensions: Array<{
      key: string;
      limit: number;
      reason: string;
      limitScope: MaxApiRateLimitScope;
      burstToleranceSlots?: number;
    }> = [
      {
        key: `maxapi:gcra:v1:bot:${botId}:all`,
        limit: this.globalRpsLimit,
        // FLAG: Pace the shared token across roles when burst is zero. Keep its
        // existing TAT, rolling-window and cooldown keys so rollout retains debt.
        burstToleranceSlots: this.globalBurstToleranceSlots,
        reason: `MAX API per-bot rate limit exceeded for bot ${botId}`,
        limitScope: 'bot',
      },
      {
        key: `maxapi:gcra:v1:service:${this.rateLimitServiceScope}:bot:${botId}:class:${trafficClass}`,
        limit: this.resolveTrafficClassEffectiveRpsLimit(trafficClass),
        reason: `MAX API ${trafficClass} rate limit exceeded for bot ${botId}`,
        limitScope: 'role_class',
      },
      ...(chatId
        ? [
            {
              key: `maxapi:gcra:v1:chat:${botId}:${chatId}`,
              limit: this.chatRpsLimit,
              reason: `MAX API per-chat rate limit exceeded for bot ${botId} chat ${chatId}`,
              limitScope: 'chat' as const,
            },
          ]
        : []),
      ...(messageMutation
        ? [
            {
              key: `maxapi:gcra:v1:message-mutation:operation:${messageMutation.operation}:scope:${messageMutationScope}`,
              limit: MAX_MESSAGE_MUTATION_RPS,
              burstToleranceSlots: 0,
              limitScope: 'message_target' as const,
              reason: messageMutation.entityId
                ? `MAX API ${messageMutation.operation} message rate limit exceeded for target ${messageMutation.entityId}`
                : `MAX API ${messageMutation.operation} message rate limit exceeded for unknown target on bot ${botId}`,
            },
          ]
        : []),
    ];
    if (this.normalizeMetricSourceTag(sourceTag) === MAX_API_SOURCE_TAGS.MESSAGE_RETENTION) {
      const slow = await this.limiterRedis.get('maxapi:message-retention:slow:v1');
      dimensions.push({
        key: 'maxapi:gcra:v1:source:message-retention:all',
        limit: slow === '1' ? 1 : 2,
        reason: 'MAX message retention fleet budget exceeded',
        limitScope: 'retention_fleet',
        burstToleranceSlots: 0,
      });
      if (messageMutation?.operation === 'delete')
        dimensions.push({
          key: `maxapi:gcra:v1:source:message-retention:chat:${messageMutationScope}`,
          limit: 1,
          reason: 'MAX message retention chat budget exceeded',
          limitScope: 'retention_chat',
          burstToleranceSlots: 0,
        });
    }
    if (this.shouldApplyManagedRefreshSourceLimit(trafficClass, sourceTag)) {
      if (this.managedRefreshRpsLimit > 0) {
        dimensions.push({
          key: `maxapi:gcra:v1:service:${this.rateLimitServiceScope}:source:${botId}:${MAX_API_SOURCE_TAGS.MANAGED_REFRESH}`,
          limit: this.managedRefreshRpsLimit,
          reason: `MAX API managed_refresh source limit exceeded for bot ${botId}`,
          limitScope: 'managed_refresh',
        });
      }
    }

    const retention =
      this.normalizeMetricSourceTag(sourceTag) === MAX_API_SOURCE_TAGS.MESSAGE_RETENTION;
    const priority: RetentionPriorityReservationOptions = {
      version: RETENTION_PRIORITY_VERSION,
      dimensions: dimensions.length,
      retention,
      ...(!retention ? { operationId: activityId ?? randomUUID() } : {}),
    };
    const priorityKeys = [
      RETENTION_PRIORITY_PERMIT_KEY,
      HIGHER_PRIORITY_ACTIVITY_KEY,
      HIGHER_PRIORITY_ACTIVITY_UNAVAILABLE_KEY,
      ...(retention ? retentionPriorityQueueKeys() : []),
    ];
    const raw = await this.limiterRedis.eval(
      MAX_API_RATE_LIMIT_RESERVATION_SCRIPT,
      dimensions.length + priorityKeys.length,
      ...dimensions.map((dimension) => dimension.key),
      ...priorityKeys,
      ...dimensions.map((dimension) => String(dimension.limit)),
      ...dimensions.map((dimension) =>
        String(
          'burstToleranceSlots' in dimension
            ? dimension.burstToleranceSlots
            : Math.max(0, dimension.limit - 1),
        ),
      ),
      RETENTION_PRIORITY_RESERVATION_MARKER + JSON.stringify(priority),
      String(MAX_API_RATE_LIMIT_SLOT_TTL_MS),
    );
    const result = Array.isArray(raw) ? raw : null;
    const ok = typeof result?.[0] === 'number' ? result[0] : Number.NaN;
    const rejectedKeyIndex = typeof result?.[1] === 'number' ? result[1] : Number.NaN;
    const retryAfterMs = typeof result?.[2] === 'number' ? result[2] : Number.NaN;

    if (ok === 1) {
      return { ok: true };
    }

    if (ok !== 0 || !Number.isFinite(rejectedKeyIndex)) {
      throw new Error('Failed to execute MAX API rate limit reservation script');
    }

    const normalizedRetryAfterMs = Number.isFinite(retryAfterMs)
      ? Math.max(1, Math.trunc(retryAfterMs))
      : MAX_API_RATE_LIMIT_SLOT_TTL_MS;
    return {
      ok: false,
      retryAfterMs: normalizedRetryAfterMs,
      limitScope:
        rejectedKeyIndex === -1
          ? 'retention_priority'
          : rejectedKeyIndex === 0
            ? 'external_cooldown'
            : (dimensions[Math.trunc(rejectedKeyIndex) - 1]?.limitScope ?? 'unknown'),
      reason:
        (rejectedKeyIndex === -1
          ? `MAX message retention waiting for lowest priority admission: ${String(result?.[3] ?? 'metrics_unavailable')}`
          : rejectedKeyIndex === 0
            ? `MAX API external cooldown for bot ${botId}`
            : dimensions[Math.trunc(rejectedKeyIndex) - 1]?.reason) ??
        `MAX API ${trafficClass} rate limit exceeded for bot ${botId}`,
    };
  }

  private renewHigherPriorityActivity(id: string): void {
    const timer = setInterval(() => {
      void this.limiterRedis
        .eval(
          HIGHER_PRIORITY_ACTIVITY_RENEW_SCRIPT,
          2,
          HIGHER_PRIORITY_ACTIVITY_KEY,
          HIGHER_PRIORITY_ACTIVITY_UNAVAILABLE_KEY,
          id,
          String(HIGHER_PRIORITY_ACTIVITY_LEASE_MS),
        )
        .catch(() => this.markPriorityActivityUnavailable('activity_renew_failed'));
    }, HIGHER_PRIORITY_ACTIVITY_RENEW_MS);
    timer.unref();
    this.higherPriorityActivityTimers.set(id, timer);
  }

  private releaseHigherPriorityActivity(id: string | undefined): void {
    if (!id) return;
    const timer = this.higherPriorityActivityTimers.get(id);
    if (timer) clearInterval(timer);
    this.higherPriorityActivityTimers.delete(id);
    // FLAG: Cleanup observation cannot delay a completed higher-priority HTTP result.
    // Until this exact release settles, its marker continues to deny retention.
    const release = this.limiterRedis
      .zrem(HIGHER_PRIORITY_ACTIVITY_KEY, id)
      .then(async (removed) => {
        if (removed !== 1) await this.markPriorityActivityUnavailable('activity_release_unknown');
      })
      .catch(() => this.markPriorityActivityUnavailable('activity_release_failed'))
      .finally(() => {
        this.pendingHigherPriorityActivityReleases.delete(release);
      });
    this.pendingHigherPriorityActivityReleases.add(release);
  }

  private async markPriorityActivityUnavailable(reason: string): Promise<void> {
    try {
      await this.limiterRedis.set(HIGHER_PRIORITY_ACTIVITY_UNAVAILABLE_KEY, reason);
    } catch {
      // FLAG: Redis failure cannot authorize retention; its permit/reservation fails closed.
    }
  }

  private recordPriorityHttpAttempt(): void {
    try {
      if (this.priorityHttpSource.getStore() === MAX_API_SOURCE_TAGS.MESSAGE_RETENTION) return;
      // FLAG: Enqueue observation synchronously, without an authority await between the
      // final feature guard and HTTP. Failure closes cleanup, never this higher-priority call.
      const trafficKey = retentionPriorityTrafficKey(Date.now());
      void this.limiterRedis
        .multi()
        .hincrby(trafficKey, 'http', 1)
        .expire(trafficKey, RETENTION_PRIORITY_TRAFFIC_TTL_SEC)
        .exec()
        .then(async (results) => {
          if (!results || results.some(([error]) => error !== null))
            await this.markPriorityActivityUnavailable('http_traffic_unavailable');
        })
        .catch(() => this.markPriorityActivityUnavailable('http_traffic_unavailable'));
    } catch {
      void this.markPriorityActivityUnavailable('http_traffic_unavailable');
    }
  }

  private async recordRateLimitOutcome(params: {
    origin: 'internal_limiter' | 'external_429';
    botId: string;
    chatId: string | null;
    trafficClass: MaxApiTrafficClass;
    sourceTag?: string | null;
    reason: string;
    statusCode?: number | null;
    retryAfterMs?: number | null;
    limitScope?: MaxApiRateLimitScope;
  }): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1_000);
    const metricKeys = [
      `${MAX_API_RATE_LIMIT_OUTCOME_KEY_PREFIX}:${params.origin}:${params.botId}:${params.trafficClass}:${nowSec}`,
      `${MAX_API_RATE_LIMIT_OUTCOME_KEY_PREFIX}:${params.origin}:stack:${params.trafficClass}:${nowSec}`,
    ];
    try {
      const pipeline = this.limiterRedis.multi();
      for (const key of metricKeys) {
        appendMaxApiCounterIncrement(
          pipeline,
          { key, ttlSec: MAX_API_SOURCE_METRICS_TTL_SEC },
          this.metricsStorageLayout,
        );
      }
      await pipeline.exec();
    } catch (error: unknown) {
      this.logger.debug(
        {
          botId: params.botId,
          trafficClass: params.trafficClass,
          origin: params.origin,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to record MAX API rate-limit outcome metric',
      );
    }

    const logKey = `${params.origin}:${params.botId}:${params.trafficClass}`;
    const nowMs = Date.now();
    const lastLoggedAtMs = this.rateLimitLogAtMsByKey.get(logKey) ?? 0;
    if (nowMs - lastLoggedAtMs >= MAX_API_RATE_LIMIT_LOG_COALESCE_MS) {
      this.rateLimitLogAtMsByKey.set(logKey, nowMs);
      this.logger.warn(
        {
          botId: params.botId,
          chatId: params.chatId,
          trafficClass: params.trafficClass,
          sourceTag: this.normalizeMetricSourceTag(params.sourceTag),
          origin: params.origin,
          statusCode: params.statusCode ?? null,
          retryAfterMs: params.retryAfterMs ?? null,
          limitScope: params.limitScope ?? null,
        },
        params.origin === 'external_429'
          ? 'MAX API returned external HTTP 429'
          : 'MAX API internal limiter rejected request before dispatch',
      );
    }

    const chatId = this.readTrimmedString(params.chatId);
    if (!chatId) {
      return;
    }

    try {
      await this.runtimeDiagnosticsService?.recordProblemChat({
        chatId,
        botId: params.botId,
        category:
          params.origin === 'external_429' ? 'max_api_external_429' : 'max_api_internal_limiter',
        severity: params.trafficClass === 'critical' ? 'critical' : 'warning',
        action: this.normalizeMetricSourceTag(params.sourceTag) ?? params.trafficClass,
        statusCode: params.statusCode ?? null,
        reason: params.reason,
      });
    } catch (error: unknown) {
      this.logger.debug(
        {
          botId: params.botId,
          chatId,
          origin: params.origin,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to record MAX API rate-limit problem chat',
      );
    }
  }

  private recordRateLimitUsageWithoutWaiting(
    botId: string,
    trafficClass: MaxApiTrafficClass,
    sourceTag?: string | null,
  ): void {
    // FLAG: Usage observation cannot hold an admitted request past its quota window.
    // Bound actual unsettled writes; never retry an unknown metric EXEC or count a drop as zero.
    if (this.usageMetricWritesInFlight >= MAX_API_USAGE_METRICS_IN_FLIGHT_LIMIT) {
      this.droppedUsageMetricWrites++;
      const nowMs = Date.now();
      if (nowMs - this.usageMetricDropWarnedAtMs >= MAX_API_RATE_LIMIT_LOG_COALESCE_MS) {
        this.usageMetricDropWarnedAtMs = nowMs;
        this.logger.warn(
          {
            pendingWrites: this.usageMetricWritesInFlight,
            droppedObservations: this.droppedUsageMetricWrites,
          },
          'MAX API usage metrics incomplete under write pressure',
        );
      }
      return;
    }
    this.usageMetricWritesInFlight++;
    try {
      // Invoke now so the admission bucket is captured before yielding to HTTP.
      void this.recordRateLimitUsage(botId, trafficClass, sourceTag).then(
        () => this.usageMetricWritesInFlight--,
        () => this.usageMetricWritesInFlight--,
      );
    } catch {
      this.usageMetricWritesInFlight--;
    }
  }

  private async recordRateLimitUsage(
    botId: string,
    trafficClass: MaxApiTrafficClass,
    sourceTag?: string | null,
  ): Promise<void> {
    const normalizedSourceTag = this.normalizeMetricSourceTag(sourceTag);
    const nowSec = Math.floor(Date.now() / 1_000);
    const sourceDimension = normalizedSourceTag
      ? serializeMaxApiSourceMetricDimension({
          botId,
          trafficClass,
          sourceTag: normalizedSourceTag,
        })
      : null;
    const registerSourceDimension =
      sourceDimension !== null && !this.registeredSourceMetricDimensions.has(sourceDimension);
    const metrics = [
      { key: `maxapi:rps:global:${botId}:${nowSec}`, ttlSec: MAX_API_SOURCE_METRICS_TTL_SEC },
      {
        key: `maxapi:rps:global:${botId}:${trafficClass}:${nowSec}`,
        ttlSec: MAX_API_SOURCE_METRICS_TTL_SEC,
      },
      { key: `maxapi:rps:stack:${nowSec}`, ttlSec: MAX_API_SOURCE_METRICS_TTL_SEC },
      {
        key: `maxapi:rps:stack:${trafficClass}:${nowSec}`,
        ttlSec: MAX_API_SOURCE_METRICS_TTL_SEC,
      },
      {
        key: buildMaxApiServiceBotClassMetricKey({
          serviceScope: this.rateLimitServiceScope,
          botId,
          trafficClass,
          sec: nowSec,
        }),
        ttlSec: MAX_API_SERVICE_CAPACITY_METRICS_TTL_SEC,
      },
      {
        key: buildMaxApiServiceStackClassMetricKey({
          serviceScope: this.rateLimitServiceScope,
          trafficClass,
          sec: nowSec,
        }),
        ttlSec: MAX_API_SERVICE_CAPACITY_METRICS_TTL_SEC,
      },
      ...(normalizedSourceTag
        ? [
            {
              key: buildMaxApiSourceMetricKey({
                botId,
                trafficClass,
                sourceTag: normalizedSourceTag,
                sec: nowSec,
              }),
              ttlSec: MAX_API_SOURCE_METRICS_TTL_SEC,
            },
          ]
        : []),
    ];

    try {
      const pipeline = this.limiterRedis.multi();
      // FLAG: A dimension's first metric and catalog registration must share one MULTI.
      if (registerSourceDimension && sourceDimension) {
        pipeline.sadd(MAX_API_SOURCE_DIMENSION_CATALOG_KEY, sourceDimension);
      }
      for (const metric of metrics) {
        appendMaxApiCounterIncrement(pipeline, metric, this.metricsStorageLayout);
      }
      const results = await pipeline.exec();
      const commandError = results?.find(([error]) => error !== null)?.[0];
      if (commandError) {
        throw commandError;
      }
      if (registerSourceDimension && sourceDimension) {
        this.registeredSourceMetricDimensions.add(sourceDimension);
      }
    } catch (error: unknown) {
      this.logger.debug(
        {
          botId,
          trafficClass,
          sourceTag: normalizedSourceTag,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to record MAX API usage metric',
      );
    }
  }

  private resolveTrafficClassGlobalRpsLimit(trafficClass: MaxApiTrafficClass): number {
    switch (trafficClass) {
      case 'critical':
        return this.criticalGlobalRpsLimit;
      case 'background':
        return this.backgroundGlobalRpsLimit;
      case 'interactive':
      default:
        return this.interactiveGlobalRpsLimit;
    }
  }

  private resolveTrafficClassEffectiveRpsLimit(trafficClass: MaxApiTrafficClass): number {
    const configuredLimit = this.resolveTrafficClassGlobalRpsLimit(trafficClass);
    if (trafficClass === 'background') {
      return configuredLimit;
    }

    const reservedForOtherClasses = (() => {
      switch (trafficClass) {
        case 'critical':
          return this.interactiveGlobalRpsLimit + this.backgroundGlobalRpsLimit;
        case 'interactive':
        default:
          return this.criticalGlobalRpsLimit + this.backgroundGlobalRpsLimit;
      }
    })();

    return Math.max(configuredLimit, Math.max(1, this.globalRpsLimit - reservedForOtherClasses));
  }

  private resolveTrafficClassRateLimitWaitMs(
    trafficClass: MaxApiTrafficClass,
    sourceTag?: string | null,
    messageMutation?: MaxMessageMutationRateLimitScope,
  ): number {
    switch (trafficClass) {
      case 'critical':
        return messageMutation?.operation === 'delete' &&
          this.normalizeMetricSourceTag(sourceTag) === MAX_API_SOURCE_TAGS.MODERATION_DELETE
          ? this.moderationDeleteRateLimitWaitMs
          : this.criticalRateLimitWaitMs;
      case 'background':
        return this.backgroundRateLimitWaitMs;
      case 'interactive':
      default:
        return this.interactiveRateLimitWaitMs;
    }
  }

  private async runWithMessageKeyboardEditLock<T>(
    messageId: string,
    operation: (
      assertOwnership: () => Promise<void>,
      assertCurrentOwnership: () => void,
    ) => Promise<T>,
  ): Promise<T> {
    const normalizedMessageId = messageId.trim();
    if (!normalizedMessageId) {
      throw new Error('messageId is required for a keyboard edit lock');
    }
    const lockKey = `max:message-keyboard-edit:v1:${createHash('sha256')
      .update(normalizedMessageId)
      .digest('hex')}`;
    const lockToken = randomUUID();
    const deadlineMs = Date.now() + MAX_MESSAGE_EDIT_LOCK_WAIT_MS;
    let acquired = false;
    let ownershipDeadlineAtMs = 0;

    while (!acquired) {
      if (this.stopping) throw new Error('MAX client is stopping');
      const checkedAtMs = Date.now();
      const result = await this.limiterRedis.eval(
        MAX_MESSAGE_EDIT_LOCK_ACQUIRE_SCRIPT,
        1,
        lockKey,
        lockToken,
        String(MAX_MESSAGE_EDIT_LOCK_TTL_MS),
      );
      acquired = Array.isArray(result) && Number(result[0]) === 1;
      if (acquired) {
        ownershipDeadlineAtMs = checkedAtMs + MAX_MESSAGE_EDIT_LOCK_TTL_MS;
        break;
      }
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        throw new Error('Timed out waiting for the MAX message keyboard edit lock');
      }
      await this.sleep(Math.min(MAX_MESSAGE_EDIT_LOCK_RETRY_MS, remainingMs));
    }

    let lockActive = true;
    let ownershipLost = false;
    let renewalChain = Promise.resolve();
    const lostOwnershipError = () =>
      new Error('Lost ownership of the MAX message keyboard edit lock');
    const assertCurrentOwnership = () => {
      // FLAG: The feature permit is the last awaited guard. Local renewal loss or
      // the conservative Redis lease deadline must still veto PUT synchronously.
      if (!lockActive || ownershipLost || Date.now() >= ownershipDeadlineAtMs) {
        ownershipLost = true;
        throw lostOwnershipError();
      }
    };
    const renewOwnership = (): Promise<void> => {
      const attempt = renewalChain.then(async () => {
        if (!lockActive || ownershipLost) {
          throw lostOwnershipError();
        }
        try {
          const checkedAtMs = Date.now();
          const result = await this.limiterRedis.eval(
            MAX_MESSAGE_EDIT_LOCK_RENEW_SCRIPT,
            1,
            lockKey,
            lockToken,
            String(MAX_MESSAGE_EDIT_LOCK_TTL_MS),
          );
          if (Number(result) !== 1) {
            ownershipLost = true;
            throw lostOwnershipError();
          }
          ownershipDeadlineAtMs = checkedAtMs + MAX_MESSAGE_EDIT_LOCK_TTL_MS;
        } catch (error: unknown) {
          ownershipLost = true;
          throw error;
        }
      });
      renewalChain = attempt.catch(() => undefined);
      return attempt;
    };
    const assertOwnership = async () => {
      if (!lockActive || ownershipLost) {
        throw lostOwnershipError();
      }
      try {
        await renewOwnership();
      } catch (error: unknown) {
        if (error instanceof Error && error.message === lostOwnershipError().message) {
          throw error;
        }
        throw new Error('Failed to confirm the MAX message keyboard edit lock', {
          cause: error,
        });
      }
    };
    const renewal = setInterval(() => {
      if (!lockActive || ownershipLost) {
        return;
      }
      void renewOwnership().catch((error: unknown) => {
        if (lockActive) {
          this.logger.warn(
            {
              messageId: normalizedMessageId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Lost the MAX message keyboard edit lock during renewal',
          );
        }
      });
    }, MAX_MESSAGE_EDIT_LOCK_RENEW_MS);
    renewal.unref?.();
    this.pendingTimeouts.add(renewal);

    try {
      return await operation(assertOwnership, assertCurrentOwnership);
    } finally {
      lockActive = false;
      clearInterval(renewal);
      this.pendingTimeouts.delete(renewal);
      await renewalChain.catch(() => undefined);
      try {
        await this.limiterRedis.eval(MAX_MESSAGE_EDIT_LOCK_RELEASE_SCRIPT, 1, lockKey, lockToken);
      } catch (error: unknown) {
        this.logger.warn(
          {
            messageId: normalizedMessageId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to release the MAX message keyboard edit lock',
        );
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    if (this.stopping) return Promise.reject(new Error('MAX client is stopping'));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingSleeps.delete(timeout);
        resolve();
      }, ms);
      timeout.unref?.();
      this.pendingSleeps.set(timeout, () => reject(new Error('MAX client is stopping')));
    });
  }

  private async acquireCircuitPermit(botId: string): Promise<MaxApiCircuitPermit> {
    const keys = this.buildCircuitKeys(botId);
    const probeToken = randomUUID();
    const raw = await this.limiterRedis.eval(
      MAX_API_CIRCUIT_ACQUIRE_SCRIPT,
      keys.length,
      ...keys,
      String(this.circuitFailureThreshold),
      String(this.circuitWindowSec * 1_000),
      String(this.circuitOpenSec * 1_000),
      String(this.circuitHalfOpenProbeSec * 1_000),
      String(this.resolveCircuitStateTtlMs()),
      probeToken,
    );
    const result = Array.isArray(raw) ? raw : null;
    const allowed = Number(result?.[0]);
    const halfOpen = Number(result?.[1]);
    const retryAfterMs = Number(result?.[2]);

    if (allowed === 1) {
      return {
        halfOpenProbeToken: halfOpen === 1 ? probeToken : null,
      };
    }
    if (allowed === 0) {
      throw new MaxApiCircuitOpenError(
        botId,
        Number.isFinite(retryAfterMs) ? Math.max(1, Math.trunc(retryAfterMs)) : 1_000,
      );
    }

    throw new Error('Failed to execute MAX API circuit acquire script');
  }

  private async registerCriticalFailure(botId: string, permit: MaxApiCircuitPermit): Promise<void> {
    const keys = this.buildCircuitKeys(botId);
    try {
      await this.limiterRedis.eval(
        MAX_API_CIRCUIT_FAILURE_SCRIPT,
        keys.length,
        ...keys,
        String(this.circuitFailureThreshold),
        String(this.circuitWindowSec * 1_000),
        String(this.circuitOpenSec * 1_000),
        String(this.resolveCircuitStateTtlMs()),
        permit.halfOpenProbeToken ? '1' : '0',
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to update shared MAX API circuit after critical failure',
      );
    }
  }

  private async closeCircuitAfterSuccessfulProbe(
    botId: string,
    permit: MaxApiCircuitPermit,
  ): Promise<void> {
    if (!permit.halfOpenProbeToken) {
      return;
    }

    const keys = this.buildCircuitKeys(botId);
    try {
      await this.limiterRedis.eval(
        MAX_API_CIRCUIT_CLOSE_SCRIPT,
        keys.length,
        ...keys,
        permit.halfOpenProbeToken,
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to close shared MAX API circuit after successful half-open probe',
      );
    }
  }

  private async releaseUnusedHalfOpenProbe(
    botId: string,
    permit: MaxApiCircuitPermit,
  ): Promise<void> {
    if (!permit.halfOpenProbeToken) {
      return;
    }

    const [, , probeKey] = this.buildCircuitKeys(botId);
    try {
      await this.limiterRedis.eval(
        MAX_API_CIRCUIT_RELEASE_PROBE_SCRIPT,
        1,
        probeKey,
        permit.halfOpenProbeToken,
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to release unused shared MAX API half-open probe',
      );
    }
  }

  private buildCircuitKeys(botId: string): [string, string, string] {
    const prefix = `${MAX_API_CIRCUIT_KEY_PREFIX}:${botId}`;
    return [`${prefix}:failures`, `${prefix}:open-until`, `${prefix}:half-open-probe`];
  }

  private resolveCircuitStateTtlMs(): number {
    return (
      (this.circuitOpenSec + Math.max(this.circuitWindowSec, this.circuitHalfOpenProbeSec) + 5) *
      1_000
    );
  }

  private resolveBot(botId?: string | null): MaxBotDefinition {
    const explicitBotId = this.readTrimmedString(botId);
    if (explicitBotId) {
      const explicitBot = this.botRegistry.getBotById(explicitBotId);
      // FLAG: Exact access evidence and bot-scoped caches must use the requested token.
      if (!explicitBot) {
        throw new UnrecoverableError(`MAX bot ${explicitBotId} is not configured`);
      }
      return explicitBot;
    }
    return (
      this.botRegistry.getBotById(this.botContext.getActiveBotId()) ??
      this.botRegistry.getDefaultBot()
    );
  }

  private resolveExecutableBot(
    botId?: string | null,
    options: { explicit?: boolean } = {},
  ): MaxBotDefinition {
    const explicitBotId = this.readTrimmedString(botId);
    if (options.explicit === true && explicitBotId && !this.botRegistry.getBotById(explicitBotId)) {
      throw new UnrecoverableError(`MAX bot ${explicitBotId} is not configured for execution`);
    }

    const bot = this.resolveBot(botId);
    if (this.canExecuteActionsForBot(bot)) {
      return bot;
    }

    throw new UnrecoverableError(`MAX bot ${bot.id} is not executable in state ${bot.state}`);
  }

  private canExecuteActionsForBot(bot: MaxBotDefinition): boolean {
    const state = (bot as MaxBotDefinition & { state?: MaxBotLifecycleState }).state ?? 'active';
    return canExecuteActionsForBotState(state);
  }

  private isAmbiguousQueuedMutationTransportError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    return (
      (status !== null && status >= 500 && status <= 599) || isAmbiguousMaxMutationError(error)
    );
  }

  private isCriticalNetworkFailure(error: unknown): boolean {
    if (isAmbiguousMaxMutationError(error)) {
      return true;
    }

    const code = (error as { code?: unknown })?.code;
    return (
      typeof code === 'string' &&
      MAX_API_CRITICAL_NETWORK_ERROR_CODES.has(code.trim().toUpperCase())
    );
  }

  private createAmbiguousQueuedMutationError(message: string, cause: unknown): UnrecoverableError {
    const error = this.createUnrecoverableQueuedMutationError(message, cause);
    return wasMaxMemberMutationAttempted(cause)
      ? (markMaxMemberMutationAttempted(error) as UnrecoverableError)
      : error;
  }

  private createUnrecoverableQueuedMutationError(
    message: string,
    cause: unknown,
  ): UnrecoverableError {
    const error = new UnrecoverableError(message);
    const response = (cause as { response?: unknown })?.response;
    if (response !== undefined) {
      (error as UnrecoverableError & { response?: unknown }).response = response;
    }
    const code = (cause as { code?: unknown })?.code;
    if (code !== undefined) {
      (error as UnrecoverableError & { code?: unknown }).code = code;
    }
    return error;
  }

  private getCurrentBot(): MaxBotDefinition {
    return this.resolveBot(this.botContext.getActiveBotId());
  }

  private assertMemberActionTargetIsNotRuntimeBot(
    actionType: Extract<MaxActionType, 'KICK_MEMBER' | 'BAN_MEMBER' | 'TRY_UNBAN_MEMBER'>,
    chatId: string,
    userId: string,
  ): void {
    if (!this.isKnownRuntimeBotUserId(userId)) {
      return;
    }

    throw new Error(
      `Refusing to ${actionType === 'BAN_MEMBER' ? 'ban' : 'kick'} configured MAX bot user ${userId} in chat ${chatId}`,
    );
  }

  private skipQueuedMemberActionForRuntimeBot(
    actionType: Extract<MaxActionType, 'KICK_MEMBER' | 'BAN_MEMBER'>,
    chatId: string,
    userId: string,
  ): boolean {
    if (!this.isKnownRuntimeBotUserId(userId)) {
      return false;
    }

    this.logger.warn(
      {
        chatId,
        userId,
        actionType,
      },
      'Skipped queued member moderation action for configured MAX bot user',
    );
    return true;
  }

  private isKnownRuntimeBotUserId(userId: string | null | undefined): boolean {
    const botRegistry = this.botRegistry as MaxBotRegistryService & {
      isKnownBotUserId?: (value: string | null | undefined) => boolean;
    };
    return botRegistry.isKnownBotUserId?.(userId) === true;
  }

  private extractStatusCode(error: unknown): number | null {
    const maybeStatus = (error as { response?: { status?: number } })?.response?.status;
    return typeof maybeStatus === 'number' ? maybeStatus : null;
  }

  private request<T = unknown>(
    method: 'get' | 'delete',
    path: string,
    config: Record<string, unknown>,
    owner: MaxHttpFailureOwner,
  ): Promise<MaxHttpOutcome<T>>;
  private request<T = unknown>(
    method: 'delete' | 'post' | 'get' | 'put',
    path: string,
    config?: Record<string, unknown>,
  ): Promise<T>;
  private async request<T = unknown>(
    method: 'delete' | 'post' | 'get' | 'put',
    path: string,
    config: Record<string, unknown> = {},
    owner?: MaxHttpFailureOwner,
  ): Promise<T | MaxHttpOutcome<T>> {
    const bot = this.getCurrentBot();
    const scope = this.mutationExecutionScope.getStore();
    // FLAG: Prepare only finite association facts before any final authority wait.
    // Overrides preserve Axios behavior and disable proof, never business execution.
    const endpointKind = owner ? classifyMaxHttpFailureEndpoint(method, path) : null;
    const association = owner
      ? beginMaxHttpFailureRequest(
          owner,
          method === 'get' ? 'get' : 'delete',
          endpointKind ?? 'messages',
          endpointKind !== null && !('method' in config) && !('url' in config),
        )
      : undefined;
    observeMaxSendAdmission(method, path);
    const sendMetrics =
      method === 'post' && path === '/messages' ? this.storageMetrics?.optimization : undefined;
    const preparationStarted = sendMetrics ? optimizationNow() : null;
    let quotaDuration: number | null = 0;
    let httpStarted: number | null = null;
    let dispatched = false;
    let httpFailed = true;
    let priorityActivityId: string | undefined;
    try {
      if (scope && method === scope.method && path === scope.path) {
        const messageId = this.readTrimmedString(this.asRecord(config.params)?.message_id);
        const existingMessage =
          scope.explicitExistingMessage ??
          (messageId && (scope.purpose === 'edit_message' || scope.purpose === 'delete_message')
            ? {
                messageId,
                ...(scope.requestOptions.boundObject
                  ? { object: scope.requestOptions.boundObject }
                  : {}),
              }
            : undefined);
        // FLAG: Reserve the unchanged quota once at this exact HTTP mutation, after remote
        // preparation. Recheck the SQL route epoch after waits, then grant the feature permit last.
        await this.runPreDispatchMutationGuard(async () => {
          this.muteApiBudget.consumeRequest();
          const proof = await this.assertChatMutationExecutionProof(
            scope.chatId,
            bot.id,
            scope.purpose,
            scope.requestOptions,
            existingMessage,
          );
          const reserve = async () => {
            const quotaStarted = sendMetrics ? optimizationNow() : null;
            let quotaFailed = true;
            try {
              priorityActivityId = await this.reserveRateLimitSlot(
                bot.id,
                scope.chatId,
                scope.requestOptions.trafficClass ?? 'critical',
                scope.requestOptions.sourceTag,
                scope.requestOptions.timeoutMs,
                scope.messageMutation,
              );
              quotaFailed = false;
            } catch (error: unknown) {
              scope.quotaState.error = error;
              throw error;
            } finally {
              const elapsed = optimizationElapsed(quotaStarted);
              quotaDuration =
                quotaDuration !== null && elapsed !== null ? quotaDuration + elapsed : null;
              sendMetrics?.timing('sendQuota', elapsed, quotaFailed);
            }
          };
          const verifyExecutionProof = async (stage: string) => {
            if (
              proof &&
              !(await this.maxBotLinkService!.verifyChatExecutionProof({
                chatId: scope.chatId,
                ...proof,
                purpose: scope.purpose,
                maxAgeMs: scope.purpose === 'send_message' ? 15 * 60_000 : 5 * 60_000,
                ...(existingMessage ? { existingMessage } : {}),
              }))
            ) {
              throw Object.assign(new Error(`MAX action executor proof changed during ${stage}`), {
                code: 'max_action_executor_proof_rejected',
              });
            }
          };
          if (usesMaxFinalAuthorityCheckpoint(scope.finalGuard)) {
            await scope.preparePayload?.(config);
            let checkpoints = 0;
            let checkpointCompleted = false;
            let checkpointError: unknown;
            let guardActive = true;
            // FLAG: Remote guard reads precede this sole reservation. Route and payload
            // checks finish here, before the guard's final permit; never await after it.
            try {
              await scope.finalGuard?.(async () => {
                if (!guardActive || ++checkpoints !== 1)
                  throw new Error('Invalid MAX final authority checkpoint');
                try {
                  await reserve();
                  await verifyExecutionProof('quota wait');
                  await scope.preparePayload?.(config);
                  checkpointCompleted = true;
                } catch (error) {
                  checkpointError = error;
                  throw error;
                }
              });
            } finally {
              guardActive = false;
            }
            if (checkpointError !== undefined) throw checkpointError;
            if (checkpoints !== 1 || !checkpointCompleted)
              throw new Error('Missing MAX final authority checkpoint');
          } else {
            await reserve();
            await verifyExecutionProof('quota wait');
            await scope.preparePayload?.(config);
            await scope.finalGuard?.(async () => {
              await verifyExecutionProof('feature qualification');
              await scope.preparePayload?.(config);
            });
          }
          this.muteApiBudget.assertRequestAllowed();
        }, scope.guardCode);
        scope.onDispatchAttempt?.();
      } else {
        this.muteApiBudget.consumeRequest();
      }
      this.recordPriorityHttpAttempt();
      // FLAG: Synchronous observations add no wait after the final authority permit.
      // Guard time excludes the separately observed quota reservation, including refusal.
      if (sendMetrics) {
        const elapsed = optimizationElapsed(preparationStarted);
        sendMetrics.timing(
          'sendGuard',
          elapsed !== null && quotaDuration !== null ? Math.max(0, elapsed - quotaDuration) : null,
        );
        httpStarted = optimizationNow();
      }
      dispatched = true;
      const response = await performMaxHttpRequest({
        method,
        path,
        association,
        sendAttempted: Boolean(
          scope?.purpose === 'send_message' && method === scope.method && path === scope.path,
        ),
        request: () =>
          firstValueFrom(
            this.httpService.request<T>({
              method,
              url: `${this.baseUrl}${path}`,
              ...config,
              headers: {
                Authorization: bot.token,
                ...(config.headers as Record<string, string> | undefined),
              },
            }),
          ),
        assertResponse: (status, data) =>
          this.assertSuccessfulMutationResponse(method, status, data),
      });
      httpFailed = false;
      return response;
    } finally {
      if (sendMetrics) {
        if (dispatched)
          sendMetrics.timing('sendHttp', optimizationElapsed(httpStarted), httpFailed);
        else {
          const elapsed = optimizationElapsed(preparationStarted);
          sendMetrics.timing(
            'sendGuard',
            elapsed !== null && quotaDuration !== null
              ? Math.max(0, elapsed - quotaDuration)
              : null,
            true,
          );
        }
      }
      this.releaseHigherPriorityActivity(priorityActivityId);
    }
  }

  private async requestAbsolute<T = unknown>(
    method: 'delete' | 'post' | 'get' | 'put',
    url: string,
    config: Record<string, unknown> & { skipAuthorization?: boolean } = {},
  ): Promise<T> {
    const bot = this.getCurrentBot();
    const { skipAuthorization, ...requestConfig } = config;
    const headers = requestConfig.headers as Record<string, string> | undefined;
    this.muteApiBudget.consumeRequest();
    this.recordPriorityHttpAttempt();
    const response = await firstValueFrom(
      this.httpService.request<T>({
        method,
        url,
        ...requestConfig,
        headers: {
          ...(skipAuthorization ? {} : { Authorization: bot.token }),
          ...(headers ?? {}),
        },
      }),
    );

    return response.data;
  }

  private assertSuccessfulMutationResponse(
    method: 'delete' | 'post' | 'get' | 'put',
    status: number | undefined,
    payload: unknown,
  ) {
    if (method === 'get') {
      return;
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return;
    }

    const row = payload as Record<string, unknown>;
    if (row.success !== false) {
      return;
    }

    const message =
      typeof row.message === 'string' && row.message.trim().length > 0
        ? row.message.trim()
        : `MAX API ${method.toUpperCase()} request returned success=false`;

    throw new MaxApiRequestRejectedError(
      typeof status === 'number' ? status : DEFAULT_SUCCESS_FALSE_STATUS,
      payload,
      message,
    );
  }

  private assertSuccessfulDeleteMessageResponse(payload: unknown): void {
    if (
      payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      (payload as Record<string, unknown>).success === true
    ) {
      return;
    }

    throw new MaxApiRequestRejectedError(
      DEFAULT_SUCCESS_FALSE_STATUS,
      payload,
      'MAX API DELETE /messages response must contain success=true',
    );
  }

  private assertSuccessfulMemberMutationResponse(payload: unknown): void {
    const response = this.asRecord(payload);
    const failures = [response?.failed_user_ids, response?.failed_user_details];
    if (
      response?.success === true &&
      failures.every((value) => value == null || (Array.isArray(value) && value.length === 0))
    ) {
      return;
    }

    // FLAG: The mutation was attempted. An unknown result must not replay or clear BAN state.
    throw new UnrecoverableError('Ambiguous MAX member mutation response: expected success=true');
  }

  private isAlreadyOutsideChatError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    const message = this.extractErrorMessage(error);
    const code = this.extractErrorCode(error);

    if (
      error instanceof MaxApiRequestRejectedError &&
      status === DEFAULT_SUCCESS_FALSE_STATUS &&
      message.includes('not active chat member')
    ) {
      return true;
    }

    if (code === 'chat.denied' || code === 'chat.not.found') {
      return true;
    }

    if (status !== 403 && status !== 404) {
      return false;
    }

    return (
      message.includes('not a chat member') ||
      message.includes('not active chat member') ||
      message.includes('not found')
    );
  }

  private isAlreadyPresentChatMemberError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    const isDocumentedMutationRejection =
      error instanceof MaxApiRequestRejectedError && status === DEFAULT_SUCCESS_FALSE_STATUS;
    if (!isDocumentedMutationRejection && status !== 400 && status !== 409) {
      return false;
    }

    const message = this.extractErrorMessage(error).trim().toLowerCase();
    return (
      message.includes('already a member') ||
      message.includes('already a chat member') ||
      message.includes('already member') ||
      message.includes('already participant') ||
      message.includes('member already exists') ||
      message.includes('participant already exists') ||
      message.includes('already in the chat') ||
      message.includes('уже состоит')
    );
  }

  private extractErrorCode(error: unknown): string | null {
    const value = (error as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
    return typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : null;
  }

  private extractActionFailureErrorCode(error: unknown): string | null {
    const responseCode = this.extractErrorCode(error);
    const directCode = (error as { code?: unknown })?.code;
    const normalized =
      responseCode ??
      (typeof directCode === 'string' && directCode.trim().length > 0
        ? directCode.trim().toLowerCase()
        : null);
    if (!normalized) {
      return null;
    }

    const sanitized = normalized
      .replace(/[^a-z0-9._-]+/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 96);
    return sanitized.length > 0 ? sanitized : null;
  }

  private extractErrorMessage(error: unknown): string {
    const responseMessage = (error as { response?: { data?: { message?: unknown } } })?.response
      ?.data?.message;
    if (typeof responseMessage === 'string' && responseMessage.trim().length > 0) {
      return responseMessage.trim().toLowerCase();
    }

    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message.trim().toLowerCase();
    }

    return String(error).trim().toLowerCase();
  }

  private isChatAdminMemberRow(row: Record<string, unknown>): boolean {
    // FLAG: Fresh destructive author checks must not turn malformed or conflicting
    // privilege flags into a regular member. Positive canonical flags outrank legacy role labels.
    const flagGroups = [
      [row.is_admin, row.isAdmin, row.admin],
      [row.is_owner, row.isOwner, row.owner],
      [row.is_creator, row.isCreator, row.creator],
      [row.is_moderator, row.isModerator, row.moderator],
      [row.can_manage_chat, row.canManageChat],
      [row.can_delete_messages, row.canDeleteMessages],
    ];
    for (const flags of flagGroups) {
      if (
        flags.some((value) => value !== undefined && typeof value !== 'boolean') ||
        (flags.includes(true) && flags.includes(false))
      )
        throw new Error('Invalid MAX chat member privilege flags');
    }
    const roleFields = [
      row.role,
      row.member_role,
      row.memberRole,
      row.chat_role,
      row.chatRole,
      row.status,
      row.member_status,
      row.memberStatus,
    ];
    if (
      roleFields.some((value) => value !== undefined && value !== null && typeof value !== 'string')
    )
      throw new Error('Invalid MAX chat member role');
    const roles = roleFields
      .map((value) => this.readLowerString(value))
      .filter((value): value is string => value !== null);
    const privilegedRole = (role: string) => /admin|owner|creator|moderator/u.test(role);
    const memberRole = (role: string) => /member|user|participant|guest/u.test(role);
    if (
      roles.some((role) => privilegedRole(role)) &&
      roles.some((role) => memberRole(role) && !privilegedRole(role))
    )
      throw new Error('Conflicting MAX chat member roles');
    for (const [role, flags] of [
      ['owner', flagGroups[1]!],
      ['creator', flagGroups[2]!],
      ['moderator', flagGroups[3]!],
    ] as const) {
      if (roles.some((value) => value.includes(role)) && flags.includes(false))
        throw new Error('Conflicting MAX chat member privilege flags and role');
    }
    if (flagGroups.some((flags) => flags.includes(true))) return true;
    if (
      roles.some((role) => privilegedRole(role)) &&
      [row.is_admin, row.isAdmin, row.admin].includes(false)
    )
      throw new Error('Conflicting MAX chat member privilege flags and role');

    const roleValue = this.readLowerString(
      row.role ??
        row.member_role ??
        row.memberRole ??
        row.chat_role ??
        row.chatRole ??
        row.status ??
        row.member_status ??
        row.memberStatus,
    );

    if (roleValue) {
      if (
        roleValue.includes('admin') ||
        roleValue.includes('owner') ||
        roleValue.includes('creator') ||
        roleValue.includes('moderator')
      ) {
        return true;
      }

      if (
        roleValue.includes('member') ||
        roleValue.includes('user') ||
        roleValue.includes('participant') ||
        roleValue.includes('guest')
      ) {
        return false;
      }
    }

    const explicitNegativeFlags = [
      row.is_admin,
      row.isAdmin,
      row.admin,
      row.is_owner,
      row.isOwner,
      row.owner,
      row.is_creator,
      row.isCreator,
      row.creator,
      row.is_moderator,
      row.isModerator,
      row.moderator,
    ];
    if (explicitNegativeFlags.some((value) => value === false)) {
      return false;
    }

    // Backward compatibility: keep old behavior when API does not expose roles/flags.
    return true;
  }

  private readChatAdminPermissions(row: Record<string, unknown>): string[] {
    const sources = [
      row.permissions,
      row.rights,
      row.admin_permissions,
      row.adminPermissions,
      row.chat_permissions,
      row.chatPermissions,
    ];

    const normalized = new Set<string>();
    for (const source of sources) {
      const list = this.readPermissionList(source);
      for (const item of list) {
        normalized.add(item);
      }
    }

    return [...normalized];
  }

  private hasExplicitChatAdminPermissions(row: Record<string, unknown>): boolean {
    return [
      row.permissions,
      row.rights,
      row.admin_permissions,
      row.adminPermissions,
      row.chat_permissions,
      row.chatPermissions,
    ].some(
      (source) =>
        Array.isArray(source) ||
        Boolean(source && typeof source === 'object' && !Array.isArray(source)),
    );
  }

  private readPermissionList(source: unknown): string[] {
    if (Array.isArray(source)) {
      return source
        .map((item) => this.readLowerString(item))
        .filter((item): item is string => item !== null)
        .map((item) => item.replace(/[-\s]+/gu, '_'));
    }

    if (!source || typeof source !== 'object') {
      return [];
    }

    const row = source as Record<string, unknown>;
    return Object.entries(row)
      .map(([key, value]) => ({ key, value: this.readBoolean(value) }))
      .filter((item) => item.value === true)
      .map((item) => item.key.toLowerCase().replace(/[-\s]+/gu, '_'));
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private readTrimmedString(value: unknown): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private readHttpUrl(value: unknown): string | null {
    const normalized = this.readTrimmedString(value);
    if (!normalized) {
      return null;
    }

    return /^https?:\/\//iu.test(normalized) ? normalized : null;
  }

  private readBoolean(value: unknown): boolean | null {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'number') {
      if (value === 1) {
        return true;
      }
      if (value === 0) {
        return false;
      }
      return null;
    }

    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no') {
      return false;
    }

    return null;
  }

  private readNullableInteger(value: unknown): number | null {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : null;
    }

    if (typeof value === 'bigint') {
      return value >= 0n ? Number(value) : null;
    }

    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    if (!normalized) {
      return null;
    }

    const parsed = Number.parseInt(normalized, 10);
    return Number.isNaN(parsed) ? null : Math.max(0, parsed);
  }

  private readBigInt(value: unknown): bigint | null {
    if (typeof value === 'bigint') {
      return value >= 0n ? value : null;
    }

    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value) || value < 0) {
        return null;
      }
      return BigInt(value);
    }

    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    if (!/^\d+$/u.test(normalized)) {
      return null;
    }

    try {
      return BigInt(normalized);
    } catch {
      return null;
    }
  }

  private inferChatPostLink(row: Record<string, unknown>): string | null {
    const recipient = this.asRecord(row.recipient);
    const chatType = this.readLowerString(
      recipient?.chat_type ?? recipient?.chatType ?? row.chat_type ?? row.chatType,
    );
    if (chatType === 'channel') {
      return null;
    }

    const chatIdValue = recipient?.chat_id ?? recipient?.chatId ?? row.chat_id ?? row.chatId;
    const chatId =
      typeof chatIdValue === 'number' || typeof chatIdValue === 'string'
        ? String(chatIdValue).trim()
        : '';
    if (!chatId) {
      return null;
    }

    const body = this.asRecord(row.body);
    const messageId = this.readTrimmedString(
      body?.mid ?? row.message_id ?? row.messageId ?? row.mid ?? row.id,
    );
    const tokenFromMessageId = this.buildChatPostLinkTokenFromMessageId(messageId);
    if (tokenFromMessageId) {
      return `${MAX_CHAT_POST_LINK_BASE_URL}/c/${chatId}/${tokenFromMessageId}`;
    }

    const tokenFromSequence = this.buildChatPostLinkTokenFromSequence(
      this.readBigInt(body?.seq ?? row.seq ?? row.sequence),
    );
    return tokenFromSequence
      ? `${MAX_CHAT_POST_LINK_BASE_URL}/c/${chatId}/${tokenFromSequence}`
      : null;
  }

  private buildChatPostLinkTokenFromMessageId(messageId: string | null): string | null {
    if (!messageId) {
      return null;
    }

    const hexTail = messageId.split('.').pop()?.trim().toLowerCase() ?? '';
    if (!/^[0-9a-f]{16,}$/u.test(hexTail)) {
      return null;
    }

    return Buffer.from(hexTail.slice(-16), 'hex').toString('base64url');
  }

  private buildChatPostLinkTokenFromSequence(sequence: bigint | null): string | null {
    if (sequence === null || sequence < 0n || sequence > 0xffff_ffff_ffff_ffffn) {
      return null;
    }

    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64BE(sequence);
    return buffer.toString('base64url');
  }

  private readIsoDateTime(value: unknown): string | null {
    if (value instanceof Date) {
      return Number.isFinite(value.getTime()) ? value.toISOString() : null;
    }

    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        return null;
      }

      const timestampMs = value >= 100_000_000_000 ? value : value * 1_000;
      const parsed = new Date(timestampMs);
      return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
    }

    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    if (!normalized) {
      return null;
    }

    if (/^\d+$/u.test(normalized)) {
      return this.readIsoDateTime(Number.parseInt(normalized, 10));
    }

    const parsed = new Date(normalized);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
  }

  private readLowerString(value: unknown): string | null {
    const normalized = this.readTrimmedString(value);
    return normalized ? normalized.toLowerCase() : null;
  }

  private normalizeMetricSourceTag(value: string | null | undefined): string | null {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!normalized) {
      return null;
    }

    const sanitized = normalized
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/_+/g, '_')
      .slice(0, 64);
    return sanitized.length > 0 ? sanitized : null;
  }
}
