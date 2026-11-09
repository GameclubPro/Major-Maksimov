import { createHash } from 'node:crypto';
import {
  LEGACY_STOP_WORD_PHRASES,
  normalizeStopWordsValue,
  normalizeMessageLimitsBlockedWordCandidate,
  normalizeMessageLimitsBlockedDomainCandidate,
  stopWordsPolicySchema,
  stopWordsMediaSchema,
  type StopWordsPolicy,
} from '@maxim/contracts/settings';
import type { ChatSettings } from '../../prisma/prisma-client';
import { normalizeLegacyStopWordIdentity } from '../rule-engine-blocked-words.detector';

export function readStopWordsPolicy(settings: {
  stopWordsPolicy?: unknown;
  stopWordsMedia?: unknown;
}): StopWordsPolicy | null {
  return readStopWordsPolicyState(settings).policy;
}

export function readStopWordsPolicyState(settings: {
  stopWordsPolicy?: unknown;
  stopWordsMedia?: unknown;
}): { status: 'absent' | 'invalid' | 'valid'; policy: StopWordsPolicy | null } {
  if (settings.stopWordsPolicy == null) return { status: 'absent', policy: null };
  const parsed = stopWordsPolicySchema.safeParse(settings.stopWordsPolicy);
  // FLAG: A malformed new policy must never fall back to an older, broader stop-list.
  if (!parsed.success) return { status: 'invalid', policy: stopWordsPolicySchema.parse({}) };
  if (settings.stopWordsMedia == null) return { status: 'valid', policy: parsed.data };
  const media = stopWordsMediaSchema.safeParse(settings.stopWordsMedia);
  return {
    status: 'valid',
    policy: {
      ...parsed.data,
      sanctions: { ...parsed.data.sanctions, media: media.success ? media.data : {} },
    },
  };
}

export function stopWordsPolicyStorage(policy: StopWordsPolicy) {
  const { media, ...sanctions } = policy.sanctions;
  return {
    stopWordsPolicy: { ...policy, sanctions: { ...sanctions, media: {} } },
    stopWordsMedia: media,
  };
}

export function isStopWordsImageScanEnabled(
  settings:
    | {
        stopWordsPolicy?: unknown;
        messageLimitsImageTextScanEnabled?: boolean;
        messageLimitsBlockedWords?: readonly string[];
        messageLimitsBlockedDomains?: readonly string[];
      }
    | null
    | undefined,
): boolean {
  if (!settings) return false;
  const policy = readStopWordsPolicy(settings);
  return policy
    ? policy.enabled &&
        policy.imageScanEnabled &&
        (policy.rules.some((rule) => rule.enabled) || policy.domains.length > 0)
    : Boolean(
        settings.messageLimitsImageTextScanEnabled &&
        (settings.messageLimitsBlockedWords?.length ||
          settings.messageLimitsBlockedDomains?.length),
      );
}

export function isStopWordsDecisionConfigured(
  settings: {
    stopWordsPolicy?: unknown;
    messageLimitsBlockedWords: readonly string[];
    messageLimitsBlockedDomains: readonly string[];
  },
  decision: { ruleCode: string; value: string; ruleId?: string },
): boolean {
  const policy = readStopWordsPolicy(settings);
  if (policy)
    return (
      policy.enabled &&
      (decision.ruleCode === 'MESSAGE_BLOCKED_DOMAIN'
        ? policy.domains.includes(decision.value)
        : policy.rules.some(
            (rule) => rule.enabled && rule.value === decision.value && rule.id === decision.ruleId,
          ))
    );
  if (decision.ruleCode === 'MESSAGE_BLOCKED_DOMAIN') {
    const identity = normalizeMessageLimitsBlockedDomainCandidate(decision.value);
    return (
      identity !== null &&
      settings.messageLimitsBlockedDomains.some(
        (value) => normalizeMessageLimitsBlockedDomainCandidate(value) === identity,
      )
    );
  }
  const identity = normalizeLegacyStopWordIdentity(decision.value);
  return (
    identity !== null &&
    settings.messageLimitsBlockedWords.some(
      (value) => normalizeLegacyStopWordIdentity(value) === identity,
    )
  );
}

export function migrateStopWordsPolicy(settings: Partial<ChatSettings>): StopWordsPolicy {
  const existing = readStopWordsPolicy(settings);
  if (existing) return existing;
  const values = [
    ...new Set(
      (settings.messageLimitsBlockedWords ?? []).map((value) => {
        const legacy = normalizeMessageLimitsBlockedWordCandidate(value);
        if (!legacy) throw new Error('Legacy stop-word entry requires review');
        const normalized = normalizeStopWordsValue(legacy);
        return Object.hasOwn(LEGACY_STOP_WORD_PHRASES, normalized)
          ? LEGACY_STOP_WORD_PHRASES[normalized]
          : normalized;
      }),
    ),
  ];
  const buttons = Array.isArray(settings.messageLimitsBotButtons)
    ? settings.messageLimitsBotButtons
    : [];
  const media = (settings.botSpeechMedia ?? {}) as Record<string, unknown>;
  const image = (key: string) => {
    const value = media[key];
    return value &&
      typeof value === 'object' &&
      'base64' in value &&
      typeof value.base64 === 'string' &&
      value.base64.trim()
      ? value
      : undefined;
  };
  return stopWordsPolicySchema.parse({
    enabled:
      values.length > 0 ||
      Boolean(settings.messageLimitsBlockedDomains?.length) ||
      Boolean(settings.messageLimitsImageTextScanEnabled),
    rules: values.map((value) => ({
      id: `legacy-${createHash('sha256').update(value).digest('hex').slice(0, 32)}`,
      kind: value.includes(' ') ? 'PHRASE' : 'WORD',
      value,
      enabled: true,
      matchMode: 'EXACT',
    })),
    domains: [
      ...new Set(
        (settings.messageLimitsBlockedDomains ?? []).map((value) => {
          const domain = normalizeMessageLimitsBlockedDomainCandidate(value);
          if (!domain) throw new Error('Legacy blocked domain requires review');
          return domain;
        }),
      ),
    ],
    imageScanEnabled: settings.messageLimitsImageTextScanEnabled ?? false,
    sanctions: {
      botMessageEnabled: settings.messageLimitsBotMessageEnabled,
      botMessageText: settings.messageLimitsBotMessageText,
      warnEnabled: settings.messageLimitsWarnEnabled,
      warnMessageText: settings.messageLimitsWarnMessageText,
      muteEnabled: settings.messageLimitsMuteEnabled,
      muteDurationHours: settings.messageLimitsMuteDurationHours,
      banEnabled: settings.messageLimitsBanEnabled,
      botButtonEnabled: settings.messageLimitsBotButtonEnabled,
      botButtons: buttons.length
        ? buttons
        : settings.messageLimitsBotButtonUrl
          ? [{ text: settings.messageLimitsBotButtonText, url: settings.messageLimitsBotButtonUrl }]
          : [],
      adminContactButtonEnabled: settings.messageLimitsAdminContactButtonEnabled,
      adminContactButtonUrl: settings.messageLimitsAdminContactButtonUrl,
      rulesButtonEnabled:
        settings.rulesAttachViolationsEnabled ?? settings.messageLimitsRulesButtonEnabled,
      media: {
        explanation: image('messageLimitsBotMessageText'),
        warning: image('messageLimitsWarnMessageText'),
      },
    },
  });
}

export function withStopWordsSanctions<T extends ChatSettings>(
  settings: T,
  policy: StopWordsPolicy,
): T {
  const sanctions = policy.sanctions;
  const firstButton = sanctions.botButtons[0];
  return {
    ...settings,
    messageLimitsBotMessageEnabled: sanctions.botMessageEnabled,
    messageLimitsBotMessageText: sanctions.botMessageText,
    messageLimitsWarnEnabled: sanctions.warnEnabled,
    messageLimitsWarnMessageText: sanctions.warnMessageText,
    messageLimitsMuteEnabled: sanctions.muteEnabled,
    messageLimitsMuteDurationHours: sanctions.muteDurationHours,
    messageLimitsBanEnabled: sanctions.banEnabled,
    messageLimitsBotButtonEnabled: sanctions.botButtonEnabled,
    messageLimitsBotButtons: sanctions.botButtons,
    messageLimitsBotButtonUrl: firstButton?.url ?? '',
    messageLimitsBotButtonText: firstButton?.text ?? '',
    messageLimitsAdminContactButtonEnabled: sanctions.adminContactButtonEnabled,
    messageLimitsAdminContactButtonUrl: sanctions.adminContactButtonUrl,
    messageLimitsRulesButtonEnabled: sanctions.rulesButtonEnabled,
    rulesAttachViolationsEnabled: sanctions.rulesButtonEnabled,
    botSpeechMedia: {
      ...((settings.botSpeechMedia as object) ?? {}),
      messageLimitsBotMessageText: sanctions.media.explanation ?? {
        base64: '',
        mimeType: '',
        fileName: '',
      },
      messageLimitsWarnMessageText: sanctions.media.warning ?? {
        base64: '',
        mimeType: '',
        fileName: '',
      },
    },
  };
}
