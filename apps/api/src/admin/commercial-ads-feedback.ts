import { createHash } from 'node:crypto';

export const COMMERCIAL_AD_FEED_RULE_CODES: ReadonlySet<string> = new Set([
  'COMMERCIAL_AD',
  'COMMERCIAL_LLM_DELETE',
]);

export function commercialAdsFeedbackId(chatId: string, actorUserId: string, feedItemId: string) {
  return `commercial-feedback:${createHash('sha256')
    .update(JSON.stringify(['commercial-ad-feedback:v1', chatId, actorUserId, feedItemId]))
    .digest('hex')}`;
}
