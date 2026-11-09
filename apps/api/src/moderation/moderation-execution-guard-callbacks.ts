import { normalizeDeleteBotMessagesDelayMinutes } from '@maxim/contracts';
import { UnrecoverableError } from 'bullmq';
import type { MaxActionDispatchOptions, MaxActionLedgerContext } from '../max/max-client.service';
import {
  usesMaxFinalAuthorityCheckpoint,
  withMaxFinalAuthorityCheckpoint,
} from '../max/max-action-pre-dispatch-guard';
import { wasMaxMemberMutationAttempted } from '../max/max-member-error.util';
import {
  isMaxMutationOutcomeAmbiguous,
  wasMaxMessageSendAttempted,
} from '../max/max-mutation-outcome.util';
import { SanctionAction, type ChatSettings } from '../prisma/prisma-client';
import { maskText } from './text-mask.util';
import type { EnsureModerationDeleteIntentInput } from './moderation-delete-intent.types';
import type { RequiredSubscriptionMediaNoticeScope } from './required-subscription-media-notice';
import {
  INVITATION_ACCESS_RULE_CODE,
  MESSAGE_LIMITS_RULE_CODES,
  REQUIRED_SUBSCRIPTION_RULE_CODE,
  TEXT_FILTER_RULE_CODES,
} from './moderation.service.support';
import type { ModerationRuleSanctionGuardService } from './moderation-rule-sanction-guard.service';
import type { ModerationStateDeleteGuardService } from './moderation-state-delete-guard.service';
import type { RequiredSubscriptionExecutionGuardService } from './required-subscription-execution-guard.service';
import {
  bindMessageLimitEvidence,
  MESSAGE_LIMITS_STATEFUL_RULES,
} from './message-limits-delete-guard.service';
import { fingerprintModerationSettings } from './moderation-settings-fingerprint';
import { ModerationRuleSanctionRejectedError } from './moderation-rule-sanction-authority';
import type { ModerationNoticeImmediateOptions } from './moderation-sanction-notice-delivery';
import { MessageDuplicateGuardRejectedError } from './message-duplicate/message-duplicate-guard.contract';
import type { RequiredSubscriptionNoticePlan } from './required-subscription-notice-plan';
import {
  recordModerationGuardFailure,
  type ModerationGuardFailureBoundary,
} from './moderation-guard-failure-diagnostic';
import {
  buildRequiredSubscriptionNoticeAuthority,
  readRequiredSubscriptionNoticeAuthority,
  RequiredSubscriptionNoticeRejectedError,
  RequiredSubscriptionNoticeSourceUnavailableError,
  RequiredSubscriptionNoticeReadDeferredError,
  RequiredSubscriptionNoticeNotDispatchedError,
} from './required-subscription-notice-authority';

type FinalRouteGuard = () => Promise<void>;
type Guard = (beforeFinalAuthority?: FinalRouteGuard) => Promise<void>;
type ReadBotId = () => string | undefined;
type AuthorizeCommercialFinal = (beforeFinalAuthority?: Guard) => Promise<boolean>;
type StateGuard = Pick<
  ModerationStateDeleteGuardService,
  'authorize' | 'assertSpammerMemberAllowed'
>;
type Identity = { chatId: string; userId: string; messageId: string };

export function bindModerationExecutionPolicy(
  settings: Parameters<typeof bindMessageLimitEvidence>[0],
  violation: { ruleCode: string; metadata?: Record<string, unknown> },
  eventTimestampMs: number,
  profanityRolloutMode: 'legacy' | 'on' = 'on',
): string {
  const policySha256 = fingerprintModerationSettings(
    settings,
    violation.ruleCode,
    profanityRolloutMode,
  );
  if (MESSAGE_LIMITS_STATEFUL_RULES.has(`${violation.ruleCode}_DELETE`)) {
    violation.metadata = {
      ...violation.metadata,
      ...bindMessageLimitEvidence(
        settings,
        eventTimestampMs,
        violation.ruleCode,
        violation.metadata?.quotaAnchorTimestampMs,
      ),
    };
  }
  return policySha256;
}

export function createRuleSanctionGuards(
  assertAllowed: ModerationRuleSanctionGuardService['assertAllowed'] | undefined,
  intent: EnsureModerationDeleteIntentInput | null,
  policySha256: string,
  readProvenBotId: ReadBotId,
  readSelectedBotId: ReadBotId,
) {
  if (!assertAllowed || !intent) return undefined;
  if (!intent.ruleCode || !intent.subjectUserId || !intent.sourceMessageAt)
    throw new Error('Moderation rule follow-up requires exact source identity');
  const sourceAtMs =
    typeof intent.sourceMessageAt === 'string'
      ? Date.parse(intent.sourceMessageAt)
      : intent.sourceMessageAt.getTime();
  const proof = {
    chatId: intent.chatId,
    messageId: intent.messageId,
    userId: intent.subjectUserId,
    reasonKey: intent.reasonKey,
    ruleCode: intent.ruleCode,
    policySha256,
    deadlineAtMs: sourceAtMs + 5 * 60_000,
  };
  // FLAG: Preparation uses the proven DELETE executor. Only final mutation/send callbacks
  // read the newly selected executor, lazily; ambient ingress ownership is not preparation proof.
  const assertBeforeFollowUp = () => assertAllowed({ ...proof, botId: readProvenBotId() });
  const assertBeforeMutation: Guard = withMaxFinalAuthorityCheckpoint((beforeFinalAuthority) =>
    assertAllowed(
      { ...proof, botId: readSelectedBotId() },
      beforeFinalAuthority ? { beforeFinalAuthority } : undefined,
    ),
  );
  const noticeLedgerContext: MaxActionLedgerContext = {
    moderationRuleNotice: { version: 1, ...proof },
  };
  let rejected = false;
  return {
    assertBeforeFollowUp,
    assertBeforeMutation,
    noticeLedgerContext,
    wasRejected: () => rejected,
    authorizeSanction: async () => {
      try {
        await assertBeforeFollowUp();
        return true;
      } catch (error) {
        if (!(error instanceof ModerationRuleSanctionRejectedError)) throw error;
        rejected = true;
        return false;
      }
    },
  };
}

export async function runRuleFollowUpWhileAuthorized(task: Guard): Promise<void> {
  try {
    await task();
  } catch (error) {
    // FLAG: Revocation is a clean stop, including the final WARN/MUTE/BAN guard.
    // SQL, unknown author access and transport failures retain their retry/error path.
    if (
      !(error instanceof ModerationRuleSanctionRejectedError) &&
      !(error instanceof CommercialModerationFollowUpRejectedError)
    )
      throw error;
  }
}

export class CommercialModerationFollowUpRejectedError extends Error {
  constructor() {
    super('Commercial sanction is no longer authorized');
  }
}

export function createCommercialNoticeDispatchOptions(
  authorizeFinal: AuthorizeCommercialFinal | undefined,
): ModerationNoticeImmediateOptions | undefined {
  if (!authorizeFinal) return undefined;
  return {
    immediate: true,
    beforeImmediateSendMutation: withMaxFinalAuthorityCheckpoint(async (beforeFinalAuthority) => {
      if (!(await authorizeFinal(beforeFinalAuthority)))
        throw new CommercialModerationFollowUpRejectedError();
    }),
  };
}

export function createDuplicateSanctionNoticeDispatchOptions(
  assertOriginalAuthority: Guard | undefined,
): ModerationNoticeImmediateOptions {
  return {
    immediate: true,
    // FLAG: This caller consumes notice failure and retains no SEND continuation.
    immediateFailurePolicy: 'terminal',
    beforeImmediateSendMutation: withMaxFinalAuthorityCheckpoint(async (beforeFinalAuthority) => {
      // FLAG: A durable SEND cannot serialize this duplicate stage's source/lease closure.
      // Keep the genuine binding in immediate dispatch, and deny unbound legacy notices.
      if (!assertOriginalAuthority)
        throw new MessageDuplicateGuardRejectedError('message_duplicate_sanction_notice_unbound');
      await assertOriginalAuthority(beforeFinalAuthority);
    }),
  };
}

export function sequenceModerationGuards(...guards: (Guard | undefined)[]): Guard {
  const active = guards.filter((guard): guard is Guard => guard !== undefined);
  const sequence: Guard = async (beforeFinalAuthority) => {
    for (let index = 0; index < active.length; index += 1)
      await active[index]!(index === active.length - 1 ? beforeFinalAuthority : undefined);
  };
  return usesMaxFinalAuthorityCheckpoint(active.at(-1))
    ? withMaxFinalAuthorityCheckpoint(sequence)
    : sequence;
}

export function createModerationNoticeGuard(
  authorizeCommercial: AuthorizeCommercialFinal | undefined,
  assertRuleFollowUp: Guard | undefined,
): Guard | undefined {
  if (!authorizeCommercial) return assertRuleFollowUp;
  return async (beforeFinalAuthority) => {
    if (!(await authorizeCommercial(beforeFinalAuthority)))
      throw new CommercialModerationFollowUpRejectedError();
  };
}

export function createModerationSanctionCallbacks(
  authorizeCommercial: (() => Promise<boolean>) | undefined,
  rule: ReturnType<typeof createRuleSanctionGuards>,
  assertStopWords: Guard | undefined,
  action: SanctionAction,
  authorizeCommercialFinal?: AuthorizeCommercialFinal,
) {
  const commercialMutation = createModerationNoticeGuard(
    authorizeCommercialFinal ?? authorizeCommercial,
    undefined,
  );
  if (commercialMutation && authorizeCommercialFinal)
    withMaxFinalAuthorityCheckpoint(commercialMutation);
  const ruleMutation =
    action === SanctionAction.BAN ? rule?.assertBeforeMutation : rule?.assertBeforeFollowUp;
  return {
    authorizeSanction: authorizeCommercial ?? rule?.authorizeSanction,
    deferGlobalSpammerTrackingUntilConfirmedBan:
      authorizeCommercial !== undefined || rule !== undefined,
    // FLAG: Notice callbacks run before routing; the confirmed DELETE peer proves this
    // preparation. Member mutation callbacks run inside the selected executor context.
    noticeBeforeSend: createModerationNoticeGuard(authorizeCommercial, rule?.assertBeforeFollowUp),
    noticeLedgerContext: rule?.noticeLedgerContext,
    noticeDispatchOptions: createCommercialNoticeDispatchOptions(authorizeCommercialFinal),
    beforeSanctionMutation: commercialMutation
      ? sequenceModerationGuards(assertStopWords, commercialMutation)
      : ruleMutation
        ? sequenceModerationGuards(assertStopWords, ruleMutation)
        : assertStopWords,
  };
}

export function createBotAccountKickOptions(
  guard: StateGuard | undefined,
  readSelectedBotId: ReadBotId,
  params: Identity & { createdAt: string },
): Omit<MaxActionDispatchOptions, 'immediate'> | undefined {
  if (!guard) return undefined;
  return {
    beforeImmediateMemberMutation: withMaxFinalAuthorityCheckpoint(async (beforeFinalAuthority) => {
      const result = await guard.authorize({
        chatId: params.chatId,
        messageId: params.messageId,
        subjectUserId: params.userId,
        botId: readSelectedBotId(),
        allowAbsentWithOwnedReceipt: true,
        sourceMessageAt: new Date(params.createdAt),
        beforeFinalAuthority,
        reasons: [
          {
            ruleCode: 'BOT_ACCOUNT_MESSAGE_DELETE',
            reasonKey: 'BOT_ACCOUNT_MESSAGE_DELETE',
            metadata: { botAccountAuthorVerified: true },
          },
        ],
      });
      if (result === 'absent' || result === 'not_applicable')
        throw new Error('Bot-account kick requires current exact source');
    }),
  };
}

export function createSpammerKickOptions(
  guard: StateGuard | undefined,
  readSelectedBotId: ReadBotId,
  params: Identity & { localBlock: boolean },
): Omit<MaxActionDispatchOptions, 'immediate'> | undefined {
  if (!guard) return undefined;
  return {
    beforeImmediateMemberMutation: withMaxFinalAuthorityCheckpoint((beforeFinalAuthority) =>
      guard.assertSpammerMemberAllowed({
        ...params,
        botId: readSelectedBotId(),
        beforeFinalAuthority,
      }),
    ),
  };
}

export function bindRequiredSubscriptionEvidence(settings: object, createdAt: string) {
  const requiredSubscriptionSourceAtMs = Date.parse(createdAt);
  return {
    requiredSubscriptionGuardVersion: 1,
    requiredSubscriptionPolicySha256: fingerprintModerationSettings(
      settings,
      'REQUIRED_SUBSCRIPTION',
    ),
    requiredSubscriptionSourceAtMs,
    requiredSubscriptionDeadlineAtMs: requiredSubscriptionSourceAtMs + 5 * 60_000,
  };
}

export function createRequiredSubscriptionEvidence(
  params: Identity & { settings: object; createdAt: string; text: string },
  requiredChannelIds: string[],
  membership: {
    missingChannelIds: string[];
    unresolvedChannelIds: string[];
    terminalChannelIds: string[];
  },
  mediaNoticeScope: RequiredSubscriptionMediaNoticeScope | null,
  missingChannelTitles: string[],
) {
  const binding = bindRequiredSubscriptionEvidence(params.settings, params.createdAt);
  const metadata = {
    ...binding,
    channelIds: requiredChannelIds,
    requiredChannelIds,
    missingChannelIds: membership.missingChannelIds,
    unresolvedChannelIds: membership.unresolvedChannelIds,
    terminalChannelIds: membership.terminalChannelIds,
    ...(mediaNoticeScope
      ? { mediaNoticeScope: { kind: mediaNoticeScope.kind, digest: mediaNoticeScope.scopeDigest } }
      : {}),
  };
  const deleteIntent: EnsureModerationDeleteIntentInput = {
    chatId: params.chatId,
    messageId: params.messageId,
    reasonKey: `${REQUIRED_SUBSCRIPTION_RULE_CODE}:message-delete`,
    ruleCode: `${REQUIRED_SUBSCRIPTION_RULE_CODE}_DELETE`,
    subjectUserId: params.userId,
    sourceMessageAt: params.createdAt,
    retryUntilAt: new Date(binding.requiredSubscriptionDeadlineAtMs),
    entityType: 'CHAT',
    messageAuthorKind: 'user',
    event: {
      userId: params.userId,
      eventType: 'MESSAGE',
      maskedExcerpt: maskText(params.text),
      score: 1,
      metadata: { action: SanctionAction.DELETE_MESSAGE, ...metadata, missingChannelTitles },
    },
  };
  const executionProof = buildRequiredSubscriptionNoticeAuthority({
    ...params,
    reasonKey: deleteIntent.reasonKey,
    metadata,
  });
  return { metadata, deleteIntent, executionProof };
}

export function createRequiredSubscriptionNoticeHandoff(
  guard: Pick<RequiredSubscriptionExecutionGuardService, 'assertNoticeAllowed'> | undefined,
  readSelectedBotId: ReadBotId,
  identity: Pick<Identity, 'chatId' | 'userId'>,
  send: (
    params: Pick<
      RequiredSubscriptionNoticePlan,
      | 'messageOptions'
      | 'mediaFieldKey'
      | 'deleteBotMessagesEnabled'
      | 'deleteBotMessagesDelayMinutes'
    > & {
      chatId: string;
      text: string;
      userFacing: true;
      bypassNoticeBucket: true;
      idempotencyKey: string;
      ledgerContext: MaxActionLedgerContext;
      beforeSend: Guard;
    },
  ) => Promise<boolean>,
) {
  return async (plan: RequiredSubscriptionNoticePlan, idempotencyKey: string, lease: Guard) => {
    // FLAG: An album recovery retains its original plan source and absolute deadline.
    // Missing legacy proof cannot grant delete coverage through an unsendable queued notice.
    const proof = readRequiredSubscriptionNoticeAuthority(plan.executionProof);
    if (!proof || proof.chatId !== identity.chatId || proof.userId !== identity.userId)
      throw new UnrecoverableError('Required subscription notice source proof unavailable');
    if (!guard) throw new Error('Required subscription notice execution guard unavailable');
    let refusedBeforeSend: unknown;
    let sent: boolean;
    try {
      sent = await send({
        chatId: proof.chatId,
        text: plan.renderedText,
        messageOptions: plan.messageOptions,
        mediaFieldKey: plan.mediaFieldKey,
        deleteBotMessagesEnabled: plan.deleteBotMessagesEnabled,
        deleteBotMessagesDelayMinutes: plan.deleteBotMessagesDelayMinutes,
        userFacing: true,
        bypassNoticeBucket: true,
        idempotencyKey,
        ledgerContext: { requiredSubscriptionNotice: proof },
        beforeSend: sequenceModerationGuards(lease, async (beforeFinalAuthority) => {
          try {
            await guard.assertNoticeAllowed(proof, readSelectedBotId(), beforeFinalAuthority);
          } catch (error) {
            // FLAG: This callback precedes the durable SEND handoff. A typed read-only
            // outage may defer to its serialized proof's worker guard, never to an
            // unguarded POST. Handoff failure still throws; no success is fabricated.
            if (error instanceof RequiredSubscriptionNoticeReadDeferredError) {
              await lease();
              return;
            }
            if (
              error instanceof RequiredSubscriptionNoticeRejectedError ||
              error instanceof RequiredSubscriptionNoticeSourceUnavailableError
            )
              refusedBeforeSend = error;
            throw error;
          }
        }),
      });
    } catch (error) {
      // FLAG: Preserve later send failures and lost-lease errors. Only this exact
      // callback rejection ends the current no-dispatch path without a chat-wide stall.
      if (
        refusedBeforeSend !== undefined &&
        error === refusedBeforeSend &&
        !wasMaxMessageSendAttempted(error) &&
        !wasMaxMemberMutationAttempted(error) &&
        !isMaxMutationOutcomeAmbiguous(error)
      )
        throw new RequiredSubscriptionNoticeNotDispatchedError(
          'Required subscription notice denied before handoff',
          { cause: error },
        );
      throw error;
    }
    if (!sent) throw new Error('Required subscription notice was not handed off');
  };
}

export function createRequiredSubscriptionAssertion(
  guard: RequiredSubscriptionExecutionGuardService | undefined,
  readSelectedBotId: ReadBotId,
  params: Identity & { reasonKey: string; metadata: unknown },
  options: { initialQualification?: true; deleteHandoffQualification?: true } = {},
): Guard {
  return withMaxFinalAuthorityCheckpoint(async (beforeFinalAuthority) => {
    if (!guard) throw new Error('Required subscription execution guard unavailable');
    const permit = await guard.authorize({
      chatId: params.chatId,
      messageId: params.messageId,
      subjectUserId: params.userId,
      botId: readSelectedBotId(),
      beforeFinalAuthority,
      ...(options.initialQualification ? { initialQualification: true } : {}),
      ...(options.deleteHandoffQualification ? { deleteHandoffQualification: true } : {}),
      reasons: [
        {
          ruleCode: 'REQUIRED_SUBSCRIPTION_DELETE',
          reasonKey: params.reasonKey,
          metadata: params.metadata,
        },
      ],
    });
    if (typeof permit !== 'object')
      throw new Error('Required subscription source no longer actionable');
  });
}

export function createRequiredSubscriptionSanctionCallbacks(lease: Guard, source: Guard) {
  const assertCurrent = sequenceModerationGuards(lease, source);
  const observe = (boundary: ModerationGuardFailureBoundary): Guard =>
    withMaxFinalAuthorityCheckpoint(async (beforeFinalAuthority) => {
      try {
        await assertCurrent(beforeFinalAuthority);
      } catch (error) {
        recordModerationGuardFailure(error, boundary);
        throw error;
      }
    });
  const authorize = observe('required_subscription_sanction_authorize');
  return {
    noticeBeforeSend: observe('required_subscription_sanction_notice'),
    beforeSanctionMutation: observe('required_subscription_sanction_mutation'),
    authorizeSanction: async () => {
      await authorize();
      return true;
    },
  };
}

export function buildModerationNoticeDispatchOptions(
  params: {
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
    immediate?: boolean;
    immediateFailurePolicy?: ModerationNoticeImmediateOptions['immediateFailurePolicy'];
    userFacing?: boolean;
    botId?: string;
    idempotencyKey?: string;
    ledgerContext?: MaxActionLedgerContext;
    beforeImmediateSendMutation?: ModerationNoticeImmediateOptions['beforeImmediateSendMutation'];
  },
  sourceTag: string,
  ignoreFailureMetricStatuses: readonly number[],
): MaxActionDispatchOptions | undefined {
  const interactive = params.immediate === true || params.userFacing === true;
  const dispatchOptions: MaxActionDispatchOptions = {
    trafficClass: interactive ? 'interactive' : 'background',
    actionHealthLane: interactive ? 'interactive' : 'background',
    sourceTag,
    ignoreFailureMetricStatuses,
  };
  if (params.botId) dispatchOptions.botId = params.botId;
  if (params.immediate === true) dispatchOptions.immediate = true;
  if (params.immediateFailurePolicy)
    dispatchOptions.immediateFailurePolicy = params.immediateFailurePolicy;
  if (params.idempotencyKey) dispatchOptions.idempotencyKey = params.idempotencyKey;
  if (params.beforeImmediateSendMutation)
    dispatchOptions.beforeImmediateSendMutation = params.beforeImmediateSendMutation;
  // FLAG: New helper envelopes carry a compatibility marker; rule authority remains
  // in the separate exact feature proof and is always rechecked at dispatch.
  dispatchOptions.ledgerContext = {
    ...params.ledgerContext,
    moderationNoticeEnvelope: { version: 1 },
  };
  if (params.deleteBotMessagesEnabled)
    dispatchOptions.autoDeleteDelayMs =
      normalizeDeleteBotMessagesDelayMinutes(params.deleteBotMessagesDelayMinutes) * 60 * 1000;
  return Object.keys(dispatchOptions).length > 0 ? dispatchOptions : undefined;
}

export function resolveModerationMuteDurationHours(
  ruleCode: string,
  settings: Pick<
    ChatSettings,
    | 'linkMuteDurationHours'
    | 'phoneNumbersMuteDurationHours'
    | 'requiredSubscriptionMuteDurationHours'
    | 'invitationAccessMuteDurationHours'
    | 'profanityMuteDurationHours'
    | 'textFiltersMuteDurationHours'
    | 'messageLimitsMuteDurationHours'
    | 'duplicateMuteDurationHours'
  >,
): number {
  if (ruleCode === 'LINK_BLOCKED') return settings.linkMuteDurationHours;
  if (ruleCode === REQUIRED_SUBSCRIPTION_RULE_CODE)
    return settings.requiredSubscriptionMuteDurationHours;
  if (ruleCode === INVITATION_ACCESS_RULE_CODE) return settings.invitationAccessMuteDurationHours;
  if (ruleCode === 'PROFANITY') return settings.profanityMuteDurationHours;
  if (TEXT_FILTER_RULE_CODES.has(ruleCode)) return settings.textFiltersMuteDurationHours;
  if (MESSAGE_LIMITS_RULE_CODES.has(ruleCode)) return settings.messageLimitsMuteDurationHours;
  return settings.duplicateMuteDurationHours;
}
