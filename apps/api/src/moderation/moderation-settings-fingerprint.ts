import { createHash } from 'node:crypto';
import { MESSAGE_LENGTH_POLICY_VERSION } from './moderation-message-length';
import { MESSAGE_COUNT_QUOTA_POLICY_VERSION } from './message-count-quota-policy';

const LIMIT_SANCTION_FIELDS = [
  'messageLimitsBotMessageEnabled',
  'messageLimitsWarnEnabled',
  'messageLimitsMuteEnabled',
  'messageLimitsBanEnabled',
  'messageLimitsMuteDurationHours',
];
const CONTENT_POLICY_FIELDS: Record<string, readonly string[]> = {
  MESSAGE_RATE_LIMIT: ['antiSpamEnabled'],
  MESSAGE_COUNT_LIMIT: [
    'messageCountLimitEnabled',
    'messageCountLimitMessages',
    'messageCountLimitWindowHours',
  ],
  PHOTO_RATE_LIMIT: ['photoMessageCooldownEnabled', 'photoMessageCooldownHours'],
  STICKER_RATE_LIMIT: ['stickerMessageCooldownEnabled', 'stickerMessageCooldownMinutes'],
  MESSAGE_TOO_LONG: ['maxMessageLengthEnabled', 'maxMessageLength'],
  PHOTO_BLOCKED: ['photoMessagesEnabled'],
  VIDEO_BLOCKED: ['videoMessagesEnabled'],
  FILE_BLOCKED: ['fileMessagesEnabled'],
  VOICE_BLOCKED: ['voiceMessagesEnabled'],
  FORWARDED_MESSAGE_BLOCKED: ['forwardedMessagesEnabled'],
  MESSAGE_BLOCKED_WORD: ['stopWordsPolicy', 'stopWordsRevision', 'messageLimitsBlockedWords'],
  MESSAGE_BLOCKED_DOMAIN: ['stopWordsPolicy', 'stopWordsRevision', 'messageLimitsBlockedDomains'],
  PHONE_NUMBER_BLOCKED: ['phoneNumbersEnabled'],
  LINK_BLOCKED: [
    'linkPolicy',
    'linkRulesPolicy',
    'linkBotMessageEnabled',
    'linkPolicyRevision',
    'linkPolicyEffectiveAt',
    'linkWarnEnabled',
    'linkMuteEnabled',
    'linkBanEnabled',
    'linkMuteDurationHours',
    'linkEscalationWindowHours',
    'linkWarnMaxCount',
    'linkMuteMaxCount',
    'linkBanMaxCount',
  ],
  PROFANITY: [
    'russianProfanityFilterEnabled',
    'profanityBotMessageEnabled',
    'profanitySensitivity',
    'profanityWarnEnabled',
    'profanityMuteEnabled',
    'profanityBanEnabled',
    'profanityMuteDurationHours',
  ],
  REQUIRED_SUBSCRIPTION: [
    'requiredSubscriptionEnabled',
    'requiredSubscriptionChannelIds',
    'requiredSubscriptionWarnEnabled',
    'requiredSubscriptionMuteEnabled',
    'requiredSubscriptionBanEnabled',
    'requiredSubscriptionMuteDurationHours',
  ],
  STATE: ['deleteSpammersEnabled', 'removeBotsFromGroupEnabled', 'muteDurationHours'],
};

export function fingerprintModerationSettings(
  settings: object,
  ruleCode = 'STATE',
  profanityRolloutMode: 'legacy' | 'on' = 'on',
): string {
  const rule = ruleCode.replace(/_DELETE$/, '');
  const fields = CONTENT_POLICY_FIELDS[rule] ?? ['warnThreshold', 'muteDurationHours'];
  const hasLimitSanctions =
    rule in CONTENT_POLICY_FIELDS &&
    ![
      'MESSAGE_RATE_LIMIT',
      'LINK_BLOCKED',
      'PROFANITY',
      'REQUIRED_SUBSCRIPTION',
      'STATE',
      'MESSAGE_BLOCKED_WORD',
      'MESSAGE_BLOCKED_DOMAIN',
    ].includes(rule);
  const row = settings as Record<string, unknown>;
  const legacyStopWordsSanctionFields =
    ['MESSAGE_BLOCKED_WORD', 'MESSAGE_BLOCKED_DOMAIN'].includes(rule) && row.stopWordsPolicy == null
      ? LIMIT_SANCTION_FIELDS
      : [];
  const entries = [
    ...new Set([
      ...fields,
      ...(hasLimitSanctions ? LIMIT_SANCTION_FIELDS : []),
      ...legacyStopWordsSanctionFields,
    ]),
  ]
    .sort()
    .map((key) => {
      const value = row[key] ?? null;
      return [
        key,
        key === 'requiredSubscriptionChannelIds' && Array.isArray(value)
          ? [...new Set(value)].sort()
          : value,
      ];
    });
  if (rule === 'PROFANITY') entries.push(['profanityRolloutMode', profanityRolloutMode]);
  // FLAG: Previously measured metadata/UTF-16 length cannot authorize a queued sanction.
  if (rule === 'MESSAGE_TOO_LONG')
    entries.push(['messageLengthPolicyVersion', MESSAGE_LENGTH_POLICY_VERSION]);
  // FLAG: Persisted attempt-quota decisions cannot acquire admitted-publication authority.
  if (rule === 'MESSAGE_COUNT_LIMIT')
    entries.push(['messageCountQuotaPolicyVersion', MESSAGE_COUNT_QUOTA_POLICY_VERSION]);
  return createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}
