import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UnrecoverableError } from 'bullmq';
import { extractHttpStatusCode } from '../common/http-error.util';
import { isMaxExactMessageLookupMissingIdError } from './max-exact-message-lookup.error';
import { wasMaxMemberMutationAttempted } from './max-member-error.util';
import {
  isMaxMutationOutcomeAmbiguous,
  wasMaxMessageSendAttempted,
} from './max-mutation-outcome.util';
import { PrismaService } from '../prisma/prisma.service';
import { ParticipantModerationImmunityService } from '../moderation/participant-moderation-immunity.service';
import {
  assertRequiredSubscriptionNoticeAuthority,
  readRequiredSubscriptionNoticeAuthority,
  RequiredSubscriptionNoticeRejectedError,
  RequiredSubscriptionNoticeSourceUnavailableError,
} from '../moderation/required-subscription-notice-authority';
import type { ModerationRuleMemberAccess } from '../moderation/moderation-rule-sanction-authority';
import { MaxBotRegistryService } from './max-bot-registry.service';
import type { MaxActionJob } from './max-client.service';

export class MaxRequiredSubscriptionNoticeRejectedError extends UnrecoverableError {
  readonly code = 'required_subscription_notice_no_longer_authorized';
}

export function hasMaxRequiredSubscriptionNoticeProof(
  action: Pick<MaxActionJob, 'ledgerContext'>,
): boolean {
  return (
    !!action.ledgerContext && Object.hasOwn(action.ledgerContext, 'requiredSubscriptionNotice')
  );
}

export function isMaxRequiredSubscriptionNoticeAction(
  action: Pick<MaxActionJob, 'actionType' | 'ledgerContext' | 'idempotencyKey'>,
): boolean {
  // FLAG: Old queued jobs retain the readable logical namespace even without a proof.
  // Receipt-first settlement stays in MaxClient; unattempted legacy notices fail closed.
  return (
    hasMaxRequiredSubscriptionNoticeProof(action) ||
    (action.actionType === 'SEND_MESSAGE' &&
      /(?:^|__)required-subscription(?::notice:v1:|-notice-v1(?:-|__|$))/u.test(
        action.idempotencyKey,
      ))
  );
}

@Injectable()
export class MaxRequiredSubscriptionNoticeGuardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bots: MaxBotRegistryService,
    private readonly immunity: ParticipantModerationImmunityService,
    private readonly config: ConfigService,
  ) {}

  async assertAllowed(
    action: MaxActionJob,
    selectedBotId: string,
    readers: {
      beforeFinalAuthority?: () => Promise<void>;
      getMemberAccess: (params: {
        chatId: string;
        userId: string;
        botId: string;
        timeoutMs: number;
      }) => Promise<ModerationRuleMemberAccess>;
      getSource: (params: {
        chatId: string;
        messageId: string;
        botId: string;
        timeoutMs: number;
      }) => Promise<Record<string, unknown> | null>;
      getMembership: (params: {
        targetId: string;
        userId: string;
        timeoutMs: number;
      }) => Promise<boolean>;
    },
  ): Promise<void> {
    if (!isMaxRequiredSubscriptionNoticeAction(action)) return;
    const proof = readRequiredSubscriptionNoticeAuthority(
      action.ledgerContext?.requiredSubscriptionNotice,
    );
    if (
      !proof ||
      !selectedBotId.trim() ||
      action.actionType !== 'SEND_MESSAGE' ||
      action.chatId !== proof.chatId
    )
      throw new MaxRequiredSubscriptionNoticeRejectedError();
    const timeoutMs = this.config.get<number>('MODERATION_DELETE_INTENT_TIMEOUT_MS') ?? 5_000;
    try {
      await assertRequiredSubscriptionNoticeAuthority(this.prisma, proof, {
        isKnownBotUserId: (userId) => this.bots.isKnownBotUserId(userId),
        getMemberAccess: () =>
          readers.getMemberAccess({
            chatId: proof.chatId,
            userId: proof.userId,
            botId: selectedBotId,
            timeoutMs,
          }),
        getSource: async () => {
          try {
            return await readers.getSource({
              chatId: proof.chatId,
              messageId: proof.messageId,
              botId: selectedBotId,
              timeoutMs,
            });
          } catch (error) {
            // FLAG: Only this exact source GET can nominate receipt fallback. Member
            // reads, access denial, transport failures and unknown mutations cannot.
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
            throw error;
          }
        },
        getMembership: (targetId) =>
          readers.getMembership({ targetId, userId: proof.userId, timeoutMs }),
        consumeImmunity: (input) => this.immunity.consumeForMessage(input),
        beforeFinalAuthority: readers.beforeFinalAuthority,
      });
    } catch (error) {
      if (error instanceof RequiredSubscriptionNoticeRejectedError)
        throw new MaxRequiredSubscriptionNoticeRejectedError();
      // FLAG: Without an exact receipt preserve the original queued failure/retry
      // contract. The initial handoff keeps its own typed no-dispatch recovery.
      if (error instanceof RequiredSubscriptionNoticeSourceUnavailableError && error.cause)
        throw error.cause;
      throw error;
    }
  }
}
