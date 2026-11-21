import type { ModerationDeleteIntentService } from './moderation-delete-intent.service';
import type { EnsureModerationDeleteIntentInput } from './moderation-delete-intent.types';
import { spammerKickPolicySha256 } from './spammer-kick-source';

export const SPAMMER_KICK_FOLLOWUP_WRITES = true;

export async function persistSpammerKickFollowup(
  service: Pick<ModerationDeleteIntentService, 'ensureIntentWithRuleFollowup'> | undefined,
  input: EnsureModerationDeleteIntentInput,
  updateType: string,
): Promise<{ followupId: string | null }> {
  if (!service || !SPAMMER_KICK_FOLLOWUP_WRITES)
    throw new Error('Spammer deletion requires durable registration');
  return service.ensureIntentWithRuleFollowup(
    input,
    spammerKickPolicySha256(input.ruleCode ?? ''),
    {
      version: 1,
      updateType,
      originBotId: input.originBotId ?? null,
      userLabel: '',
      effectiveMessageLength: 0,
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
    },
  );
}
