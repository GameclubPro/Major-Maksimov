import { wasMaxPreDispatchGuardRejected } from '../max/max-action-pre-dispatch-guard';
import { wasMaxMemberMutationAttempted } from '../max/max-member-error.util';
import {
  isMaxMutationOutcomeAmbiguous,
  wasMaxMessageSendAttempted,
} from '../max/max-mutation-outcome.util';
import { ModerationRuleSanctionRejectedError } from './moderation-rule-sanction-authority';
import { ModerationStateDeleteRejectedError } from './moderation-state-delete-guard.service';

type ModerationEffectFailureCause =
  | {
      errorClass: 'ModerationStateDeleteRejectedError';
      errorCode: 'moderation_state_delete_no_longer_authorized';
    }
  | {
      errorClass: 'ModerationRuleSanctionRejectedError';
      errorCode: 'moderation_rule_sanction_no_longer_authorized';
    }
  | { errorClass: 'unknown'; errorCode: null };

export function warnModerationEffectFailure(
  logger: { warn(data: Record<string, unknown>, message: string): void },
  context: { chatId: string; userId: string; messageId: string },
  error: unknown,
  message: string,
): void {
  logger.warn(
    {
      ...context,
      error: error instanceof Error ? error.message : 'Unknown error',
      ...buildModerationEffectFailureDiagnostic(error),
    },
    message,
  );
}

export function buildModerationEffectFailureDiagnostic(
  error: unknown,
): ModerationEffectFailureCause & { preDispatchGuardRejected: boolean } {
  // FLAG: Fixed diagnostics never trust arbitrary error names/codes or grant retry authority.
  // A known class alone does not prove that MAX rejected dispatch before any effect attempt.
  const cause: ModerationEffectFailureCause =
    error instanceof ModerationStateDeleteRejectedError
      ? {
          errorClass: 'ModerationStateDeleteRejectedError',
          errorCode: 'moderation_state_delete_no_longer_authorized',
        }
      : error instanceof ModerationRuleSanctionRejectedError
        ? {
            errorClass: 'ModerationRuleSanctionRejectedError',
            errorCode: 'moderation_rule_sanction_no_longer_authorized',
          }
        : { errorClass: 'unknown', errorCode: null };

  return {
    ...cause,
    preDispatchGuardRejected:
      cause.errorCode !== null &&
      wasMaxPreDispatchGuardRejected(error) &&
      !wasMaxMemberMutationAttempted(error) &&
      !wasMaxMessageSendAttempted(error) &&
      !isMaxMutationOutcomeAmbiguous(error),
  };
}
