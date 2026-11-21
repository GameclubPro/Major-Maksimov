import { createHash } from 'node:crypto';

export const isSpammerKickRule = (rule: string) =>
  rule === 'GLOBAL_SPAMMER_MESSAGE_DELETE' || rule === 'LOCAL_ADMIN_BLOCK_MESSAGE_DELETE';

export function spammerKickPolicySha256(ruleCode: string) {
  return createHash('sha256')
    .update(JSON.stringify(['spammer-message-kick-policy:v1', ruleCode, 'deleteSpammersEnabled']))
    .digest('hex');
}

export function matchesSpammerKickReason(ruleCode: string, reasonKey: string, reason: unknown) {
  if (ruleCode === 'LOCAL_ADMIN_BLOCK_MESSAGE_DELETE')
    return (
      reasonKey === 'LOCAL_ADMIN_BLOCK:message-delete' &&
      reason === 'Local admin block for this admin scope'
    );
  return (
    ruleCode === 'GLOBAL_SPAMMER_MESSAGE_DELETE' &&
    ((reasonKey === 'GLOBAL_SPAMMER:known-message-delete' &&
      reason === 'Sender exists in global spammer registry') ||
      (reasonKey === 'GLOBAL_SPAMMER:detected-message-delete' &&
        reason === 'Detected in 6 unique chats within 2 minutes'))
  );
}
