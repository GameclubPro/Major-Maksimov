import {
  prepareDeleteAuthority,
  finalizeDeleteAuthority,
  type DeleteAuthorityPreparation,
} from './moderation-delete-authority-preparation';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { REQUIRED_SUBSCRIPTION_MAX_CHANNELS } from '@maxim/contracts';
import { extractHttpStatusCode } from '../common/http-error.util';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import {
  MAX_API_SOURCE_TAGS,
  MaxApiInternalRateLimitError,
  MaxClientService,
  consumeMaxChatMemberAccessHttp429,
  consumeMaxExactMessageLookupHttp429,
} from '../max/max-client.service';
import { isMaxExactMessageLookupMissingIdError } from '../max/max-exact-message-lookup.error';
import { wasMaxMemberMutationAttempted } from '../max/max-member-error.util';
import { MaxMembershipLookupService } from '../max/max-membership-lookup.service';
import { MaxModerationApiBudgetError } from '../max/max-moderation-api-budget';
import {
  isMaxMutationOutcomeAmbiguous,
  wasMaxMessageSendAttempted,
} from '../max/max-mutation-outcome.util';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookParser } from '../webhook/webhook.parser';
import { fingerprintModerationSettings } from './message-limits-delete-guard.service';
import { ParticipantModerationImmunityService } from './participant-moderation-immunity.service';
import { MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES } from './moderation.service.support';
import {
  assertRequiredSubscriptionNoticeAuthority,
  RequiredSubscriptionNoticeRejectedError,
  RequiredSubscriptionNoticeSourceUnavailableError,
  RequiredSubscriptionNoticeReadDeferredError,
  type RequiredSubscriptionNoticeAuthority,
} from './required-subscription-notice-authority';

export const REQUIRED_SUBSCRIPTION_DELETE_RULE_CODE = 'REQUIRED_SUBSCRIPTION_DELETE';
export class RequiredSubscriptionExecutionRejectedError extends Error {
  readonly code = 'required_subscription_no_longer_authorized';
}

// FLAG: This proves unavailable membership evidence, never membership or permission
// to delete. Only a committed guarded DELETE obligation may outlive its caller.
export class RequiredSubscriptionMembershipUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('Required subscription fresh membership unavailable', { cause });
    this.name = 'RequiredSubscriptionMembershipUnavailableError';
  }
}

export class RequiredSubscriptionAuthorAccessUnavailableError extends RequiredSubscriptionMembershipUnavailableError {
  constructor(cause: unknown) {
    super(cause);
    this.message = 'Required subscription author access unavailable';
    this.name = 'RequiredSubscriptionAuthorAccessUnavailableError';
  }
}

// FLAG: This is unavailable source evidence before durable DELETE handoff, never
// confirmed absence or permission to finish without persisting the obligation.
export class RequiredSubscriptionDeleteSourceUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Required subscription DELETE handoff source unavailable', { cause });
    this.name = 'RequiredSubscriptionDeleteSourceUnavailableError';
  }
}

// FLAG: Initial unavailable evidence is distinct from revoked execution authority or absence.
export class RequiredSubscriptionInitialSourceUnavailableError extends Error {
  readonly code = 'required_subscription_initial_source_unavailable';

  constructor(cause: unknown) {
    super('Required subscription initial source unavailable', { cause });
    this.name = 'RequiredSubscriptionInitialSourceUnavailableError';
  }
}

export type RequiredSubscriptionInitialSourceReadWaitBinding = {
  chatId: string;
  userId: string;
  messageId: string;
  sourceAtMs: number;
  deadlineAtMs: number;
  policySha256: string;
  botId: string;
};

type RequiredSubscriptionInitialSourceReadWait = Readonly<
  RequiredSubscriptionInitialSourceReadWaitBinding & { boundary: 'author' | 'source' }
>;

const initialSourceReadWaits = new WeakMap<
  object,
  {
    cause: unknown;
    kind: 'local_quota' | 'http_429';
    proofs: readonly RequiredSubscriptionInitialSourceReadWait[];
  }
>();

// FLAG: Only the exact initial GET invocation can mint this bounded read obligation.
// Public errors, copied fields and unavailable/absent evidence grant no continuation.
export function readRequiredSubscriptionInitialSourceReadWait(
  error: unknown,
  expected: RequiredSubscriptionInitialSourceReadWaitBinding,
): RequiredSubscriptionInitialSourceReadWait | null {
  if (!error || typeof error !== 'object') return null;
  const wait = initialSourceReadWaits.get(error);
  const evidence = error as { cause?: unknown; request?: unknown; response?: unknown };
  if (
    !wait ||
    evidence.cause !== wait.cause ||
    extractHttpStatusCode(error) !== null ||
    evidence.request != null ||
    evidence.response != null ||
    !(wait.kind === 'local_quota'
      ? isRequiredSubscriptionInitialLocalReadWait(wait.cause)
      : isRequiredSubscriptionInitialHttpReadWait(wait.cause)) ||
    wasMaxMessageSendAttempted(error) ||
    wasMaxMemberMutationAttempted(error) ||
    isMaxMutationOutcomeAmbiguous(error)
  )
    return null;
  return (
    wait.proofs.find(
      (proof) =>
        proof.chatId === expected.chatId &&
        proof.userId === expected.userId &&
        proof.messageId === expected.messageId &&
        proof.sourceAtMs === expected.sourceAtMs &&
        proof.deadlineAtMs === expected.deadlineAtMs &&
        proof.policySha256 === expected.policySha256 &&
        proof.botId === expected.botId &&
        proof.sourceAtMs <= Date.now() &&
        Date.now() < proof.deadlineAtMs,
    ) ?? null
  );
}

function withRequiredSubscriptionInitialSourceReadWait<T extends Error>(
  error: T,
  cause: unknown,
  boundary: 'author' | 'source',
  bindings: readonly RequiredSubscriptionInitialSourceReadWaitBinding[],
  kind: 'local_quota' | 'http_429' = 'local_quota',
): T {
  if (
    bindings.length &&
    (kind === 'local_quota'
      ? isRequiredSubscriptionInitialLocalReadWait(cause)
      : isRequiredSubscriptionInitialHttpReadWait(cause))
  )
    initialSourceReadWaits.set(error, {
      cause,
      kind,
      proofs: bindings.map((binding) => Object.freeze({ ...binding, boundary })),
    });
  return error;
}

@Injectable()
export class RequiredSubscriptionExecutionGuardService {
  private readonly parser = new WebhookParser();
  constructor(
    private readonly prisma: PrismaService,
    private readonly max: MaxClientService,
    private readonly bots: MaxBotLinkService,
    private readonly membership: MaxMembershipLookupService,
    private readonly immunity: ParticipantModerationImmunityService,
    private readonly config: ConfigService,
  ) {}

  async assertNoticeAllowed(
    proof: RequiredSubscriptionNoticeAuthority,
    botId?: string,
    beforeFinalAuthority?: () => Promise<void>,
  ): Promise<void> {
    const options = {
      botId,
      bypassCache: true,
      trafficClass: 'critical' as const,
      actionHealthLane: 'critical' as const,
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_NOTICE,
      ignoreFailureMetricStatuses: MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES,
      timeoutMs: this.config.get<number>('MODERATION_DELETE_INTENT_TIMEOUT_MS') ?? 5_000,
    };
    await assertRequiredSubscriptionNoticeAuthority(this.prisma, proof, {
      isKnownBotUserId: (userId) => this.bots.isKnownBotUserId(userId),
      getMemberAccess: async () => {
        try {
          return await this.max.getChatMemberAccess(proof.chatId, proof.userId, options);
        } catch (error) {
          if (isRequiredSubscriptionMemberReadRateLimited(error))
            throw new RequiredSubscriptionNoticeReadDeferredError(
              'Required subscription notice author access rate limited',
              { cause: error },
            );
          throw error;
        }
      },
      getSource: async () => {
        try {
          return await this.max.getExactMessageRow(proof.chatId, proof.messageId, options);
        } catch (error) {
          // FLAG: This GET supplies notice evidence only. Unavailability is not absence;
          // the common guard may consult only this original reason's verified receipt.
          // Without it the owned handoff still finishes without a SEND or deletion.
          if (
            (extractHttpStatusCode(error) === 404 ||
              isMaxExactMessageLookupMissingIdError(error)) &&
            !wasMaxMessageSendAttempted(error) &&
            !wasMaxMemberMutationAttempted(error) &&
            !isMaxMutationOutcomeAmbiguous(error)
          )
            throw new RequiredSubscriptionNoticeSourceUnavailableError(
              'Required subscription notice source unavailable',
              { cause: error },
            );
          if (isRequiredSubscriptionSourceReadDeferred(error))
            throw new RequiredSubscriptionNoticeReadDeferredError(
              'Required subscription notice source read deferred',
              { cause: error },
            );
          throw error;
        }
      },
      getMembership: async (targetId) => {
        // FLAG: The selected executor proves the source chat. Each subscription target
        // has its own read route; retain fresh evidence without forcing the source bot there.
        const result = await this.membership.getMembershipResolution(
          targetId,
          proof.userId,
          'moderation_required_subscription',
          { forceRefresh: true, allowStaleOnError: false },
        );
        if (!result.fresh || result.membership === null) {
          if (
            this.membership.getLookupIssue(targetId, 'moderation_required_subscription')?.kind ===
            'terminal'
          )
            throw new RequiredSubscriptionNoticeRejectedError();
          throw new RequiredSubscriptionNoticeReadDeferredError(
            'Required subscription notice fresh membership unavailable',
          );
        }
        return result.membership;
      },
      consumeImmunity: (input) => this.immunity.consumeForMessage(input),
      beforeFinalAuthority,
    });
  }

  async authorize(params: {
    chatId: string;
    messageId: string;
    subjectUserId: string | null;
    botId?: string;
    initialQualification?: boolean;
    deleteHandoffQualification?: true;
    beforeFinalAuthority?: () => Promise<void>;
    reasons: readonly { ruleCode: string; reasonKey: string; metadata: unknown }[];
  }): Promise<
    | 'not_applicable'
    | 'absent'
    | {
        reasonKeys: string[];
        deadlineAtMs: number;
        reasonDeadlines: { reasonKey: string; deadlineAtMs: number }[];
      }
  > {
    return finalizeDeleteAuthority(
      await this.prepareForDispatch(params),
      params.beforeFinalAuthority,
    );
  }

  async prepareForDispatch(
    params: Parameters<RequiredSubscriptionExecutionGuardService['authorize']>[0],
  ): Promise<
    DeleteAuthorityPreparation<
      Awaited<ReturnType<RequiredSubscriptionExecutionGuardService['authorize']>>
    >
  > {
    const reasons = params.reasons.filter(
      (r) => r.ruleCode === REQUIRED_SUBSCRIPTION_DELETE_RULE_CODE,
    );
    if (!reasons.length) return 'not_applicable';
    const userId = params.subjectUserId;
    if (!userId || this.bots.isKnownBotUserId(userId)) this.reject();
    const load = async () => {
      const settings = await this.prisma.chatSettings.findUnique({
        where: { chatId: params.chatId },
        include: {
          chat: {
            select: { entityType: true, admins: { where: { userId }, select: { userId: true } } },
          },
        },
      });
      if (
        !settings ||
        settings.chat.entityType !== 'CHAT' ||
        settings.chat.admins.length ||
        !settings.requiredSubscriptionEnabled
      )
        this.reject();
      return settings;
    };
    const settings = await load();
    const targets = Array.isArray(settings.requiredSubscriptionChannelIds)
      ? [
          ...new Set(
            settings.requiredSubscriptionChannelIds
              .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
              .map((v) => v.trim()),
          ),
        ]
      : [];
    if (!targets.length || targets.length > REQUIRED_SUBSCRIPTION_MAX_CHANNELS) this.reject();
    const policySha256 = fingerprintModerationSettings(settings, 'REQUIRED_SUBSCRIPTION');
    const eligible = reasons.filter((reason) => {
      const binding = this.metadata(reason.metadata);
      const sourceAt = Number(binding.requiredSubscriptionSourceAtMs);
      const deadline = Number(binding.requiredSubscriptionDeadlineAtMs);
      return (
        binding.requiredSubscriptionGuardVersion === 1 &&
        binding.requiredSubscriptionPolicySha256 === policySha256 &&
        Number.isSafeInteger(sourceAt) &&
        sourceAt > 0 &&
        sourceAt <= Date.now() &&
        deadline === sourceAt + 5 * 60_000 &&
        Date.now() < deadline
      );
    });
    if (!eligible.length) this.reject();
    const initialReadWaitBindings: RequiredSubscriptionInitialSourceReadWaitBinding[] =
      params.initialQualification === true &&
      [params.chatId, userId, params.messageId, params.botId].every(
        (value) => typeof value === 'string' && value.length > 0 && value === value.trim(),
      )
        ? eligible.map((reason) => ({
            chatId: params.chatId,
            userId,
            messageId: params.messageId,
            sourceAtMs: Number(this.metadata(reason.metadata).requiredSubscriptionSourceAtMs),
            deadlineAtMs: Number(this.metadata(reason.metadata).requiredSubscriptionDeadlineAtMs),
            policySha256,
            botId: params.botId!,
          }))
        : [];
    const options = {
      botId: params.botId,
      bypassCache: true,
      trafficClass: 'critical' as const,
      actionHealthLane: 'critical' as const,
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      // FLAG: Keep unavailable authority local to this action; no 403/404 grants
      // absence, membership or execution. Transport/429/5xx still signal pressure.
      ignoreFailureMetricStatuses: MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES,
      timeoutMs: this.config.get<number>('MODERATION_DELETE_INTENT_TIMEOUT_MS') ?? 5_000,
    };
    const access = await this.max
      .getChatMemberAccess(params.chatId, userId, options)
      .catch((error: unknown) => {
        // FLAG: A fresh exact-author GET may transfer only its one-use transport proof.
        // Generic status/config fields retain the existing no-effect classification.
        if (
          params.initialQualification === true &&
          initialReadWaitBindings.length &&
          consumeMaxChatMemberAccessHttp429(error, {
            chatId: params.chatId,
            userId,
            botId: params.botId!,
          })
        )
          throw withRequiredSubscriptionInitialSourceReadWait(
            new RequiredSubscriptionAuthorAccessUnavailableError(error),
            error,
            'author',
            initialReadWaitBindings,
            'http_429',
          );
        // FLAG: Only the initial no-effect qualification or committed DELETE handoff may
        // outlive this exact author GET limiter refusal. Final dispatch requires fresh access.
        if (
          (params.initialQualification === true || params.deleteHandoffQualification === true) &&
          isRequiredSubscriptionMemberReadRateLimited(error)
        )
          throw withRequiredSubscriptionInitialSourceReadWait(
            new RequiredSubscriptionAuthorAccessUnavailableError(error),
            error,
            'author',
            initialReadWaitBindings,
          );
        throw error;
      });
    if (!access || access.isAdmin === true || access.isOwner === true) this.reject();
    if (access.userId !== userId || access.isAdmin !== false || access.isOwner !== false)
      throw new Error('Required subscription author access unavailable');
    let row: Record<string, unknown> | null;
    try {
      row = await this.max.getExactMessageRow(params.chatId, params.messageId, options);
    } catch (error) {
      // FLAG: The transport consumes its exact invocation's nominal GET/429 proof.
      // Status fields alone cannot create this source-bound, no-effect continuation.
      if (
        params.initialQualification === true &&
        initialReadWaitBindings.length &&
        consumeMaxExactMessageLookupHttp429(error, {
          chatId: params.chatId,
          messageId: params.messageId,
          botId: params.botId!,
        })
      )
        throw withRequiredSubscriptionInitialSourceReadWait(
          new RequiredSubscriptionInitialSourceUnavailableError(error),
          error,
          'source',
          initialReadWaitBindings,
          'http_429',
        );
      // FLAG: Only explicitly scoped qualification GETs classify unavailable source
      // evidence. Final dispatch and attempted mutations retain their failure fences.
      if (
        (params.initialQualification === true || params.deleteHandoffQualification === true) &&
        (extractHttpStatusCode(error) === 404 || isMaxExactMessageLookupMissingIdError(error)) &&
        !wasMaxMessageSendAttempted(error) &&
        !wasMaxMemberMutationAttempted(error) &&
        !isMaxMutationOutcomeAmbiguous(error)
      ) {
        if (params.initialQualification === true)
          throw new RequiredSubscriptionInitialSourceUnavailableError(error);
        throw new RequiredSubscriptionDeleteSourceUnavailableError(error);
      }
      if (params.initialQualification === true && isRequiredSubscriptionSourceReadDeferred(error))
        throw withRequiredSubscriptionInitialSourceReadWait(
          new RequiredSubscriptionInitialSourceUnavailableError(error),
          error,
          'source',
          initialReadWaitBindings,
        );
      if (
        params.deleteHandoffQualification === true &&
        isRequiredSubscriptionSourceReadDeferred(error)
      )
        throw new RequiredSubscriptionDeleteSourceUnavailableError(error);
      throw error;
    }
    if (!row) return 'absent';
    const message = this.parser.parse({
      type: 'message_created',
      updateId: 'required-subscription-final-guard',
      message: row,
    }).message;
    if (
      !message ||
      message.chatId !== params.chatId ||
      message.messageId !== params.messageId ||
      message.senderId !== userId ||
      message.entityType === 'channel'
    )
      this.reject();
    // FLAG: Fresh negative membership is required at the mutation boundary. Never reuse
    // stale missing snapshots, retry counters, or a notice lease as subscription authority.
    // Resolve each target's own read route independently of the source executor's route.
    let missing = false;
    for (let offset = 0; offset < targets.length; offset += 2) {
      const results = await Promise.all(
        targets.slice(offset, offset + 2).map(async (target) => {
          const result = await this.membership.getMembershipResolution(
            target,
            userId,
            'moderation_required_subscription',
            { forceRefresh: true, allowStaleOnError: false },
          );
          if (!result.fresh || result.membership === null) {
            if (
              this.membership.getLookupIssue(target, 'moderation_required_subscription')?.kind ===
              'terminal'
            )
              this.reject();
            throw new RequiredSubscriptionMembershipUnavailableError();
          }
          return result.membership;
        }),
      );
      if (results.some((membership) => !membership)) missing = true;
    }
    if (!missing) this.reject();
    if (
      (await this.immunity.consumeForMessage({
        chatId: params.chatId,
        userId,
        messageId: params.messageId,
        scope: 'required-subscription-final:v1',
        nightModeTimezone: settings.nightModeTimezone,
      })) === 'granted'
    )
      this.reject();
    return prepareDeleteAuthority(async () => {
      if (
        fingerprintModerationSettings(await load(), 'REQUIRED_SUBSCRIPTION') !==
        fingerprintModerationSettings(settings, 'REQUIRED_SUBSCRIPTION')
      )
        this.reject();
      const reasonDeadlines = eligible
        .map((reason) => ({
          reasonKey: reason.reasonKey,
          deadlineAtMs: Number(this.metadata(reason.metadata).requiredSubscriptionDeadlineAtMs),
        }))
        .filter((reason) => Date.now() < reason.deadlineAtMs);
      if (!reasonDeadlines.length) this.reject();
      return {
        reasonKeys: reasonDeadlines.map((r) => r.reasonKey),
        deadlineAtMs: Math.max(...reasonDeadlines.map((r) => r.deadlineAtMs)),
        reasonDeadlines,
      };
    });
  }

  private metadata(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }
  private reject(): never {
    throw new RequiredSubscriptionExecutionRejectedError();
  }
}

// FLAG: Called only around the source author's member GET, never a mutation.
// A typed local limiter refuses before transport; HTTP 429 needs explicit GET provenance.
// Other HTTP statuses, non-GET provenance and attempted effects remain fenced.
function isRequiredSubscriptionMemberReadRateLimited(error: unknown): boolean {
  return (
    (isRequiredSubscriptionLocalReadRateLimited(error) ||
      (extractHttpStatusCode(error) === 429 &&
        (error as { config?: { method?: unknown } })?.config?.method === 'get')) &&
    !wasMaxMessageSendAttempted(error) &&
    !wasMaxMemberMutationAttempted(error) &&
    !isMaxMutationOutcomeAmbiguous(error)
  );
}

// FLAG: Only the concrete pre-dispatch limiter at an exact read boundary qualifies.
// Copied code/name fields, HTTP responses and conflicting method evidence do not.
function isRequiredSubscriptionLocalReadRateLimited(error: unknown): boolean {
  const method = (error as { config?: { method?: unknown } })?.config?.method;
  return (
    error instanceof MaxApiInternalRateLimitError &&
    error.preDispatch === true &&
    extractHttpStatusCode(error) === null &&
    (method === undefined || method === 'get')
  );
}

// FLAG: The muted-user attempt budget cannot escape into an independent candidate.
// Request/response evidence also contradicts this strictly pre-HTTP local refusal.
function isRequiredSubscriptionInitialLocalReadWait(error: unknown): boolean {
  const evidence = error as { request?: unknown; response?: unknown } | null;
  return (
    isRequiredSubscriptionLocalReadRateLimited(error) &&
    !(error instanceof MaxModerationApiBudgetError) &&
    evidence?.request == null &&
    evidence?.response == null &&
    !wasMaxMessageSendAttempted(error) &&
    !wasMaxMemberMutationAttempted(error) &&
    !isMaxMutationOutcomeAmbiguous(error)
  );
}

// FLAG: This only rechecks an already consumed nominal transport proof in the WeakMap.
// It is not an HTTP-status admission predicate and cannot mint a read obligation itself.
function isRequiredSubscriptionInitialHttpReadWait(error: unknown): boolean {
  const evidence = error as {
    response?: { status?: unknown };
    config?: { method?: unknown };
  } | null;
  return (
    evidence?.response?.status === 429 &&
    (evidence.config?.method === undefined || evidence.config.method === 'get') &&
    !wasMaxMessageSendAttempted(error) &&
    !wasMaxMemberMutationAttempted(error) &&
    !isMaxMutationOutcomeAmbiguous(error)
  );
}

// FLAG: Called only around the exact source GET, never around sanctions or sends.
// HTTP errors, mutation markers and arbitrary failures retain their existing fences.
function isRequiredSubscriptionSourceReadDeferred(error: unknown): boolean {
  if (
    !error ||
    typeof error !== 'object' ||
    extractHttpStatusCode(error) !== null ||
    wasMaxMessageSendAttempted(error) ||
    wasMaxMemberMutationAttempted(error) ||
    isMaxMutationOutcomeAmbiguous(error)
  )
    return false;
  if (isRequiredSubscriptionLocalReadRateLimited(error)) return true;
  const record = error as { code?: unknown; config?: { method?: unknown } };
  return (
    ['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED'].includes(
      String(record.code),
    ) &&
    (record.config?.method === undefined || record.config.method === 'get')
  );
}
