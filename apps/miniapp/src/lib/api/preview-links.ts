import {
  evaluateLinkRulesPolicy,
  linkRulesPolicySchema,
  linkRulesPreviewRequestSchema,
  parseStoredAllowlistEntry,
  type ChatSettings,
  type LinkRule,
} from '@maxim/contracts/settings';
import { ApiRequestError } from '../api-request-error';
import { readPreviewClock } from './preview-transport-runtime';
import type { PreviewState } from './preview-transport-state';

export function readPreviewLinkSettings(state: PreviewState): ChatSettings {
  const settings = state.chatSettings;
  if (settings.linkRulesPolicy != null) {
    return { ...settings, linkRulesLegacySnapshot: null, linkRulesStorageStatus: 'valid' };
  }
  const now = +readPreviewClock(state.clock);
  const rules: LinkRule[] = state.chatDomains.flatMap((entry, index) => {
    if (entry.removeAfterAt && Date.parse(entry.removeAfterAt) <= now) return [];
    const target = parseStoredAllowlistEntry(entry.normalizedValue);
    return target
      ? [
          {
            id: `legacy-${index}`,
            effect: 'ALLOW',
            kind: target.kind,
            target: target.target,
            enabled: true,
            expiresAt: entry.removeAfterAt,
          },
        ]
      : [];
  });
  // The design transport owns an in-memory fixture. Production supplies the SQL revision.
  let revision = 2166136261;
  for (const char of JSON.stringify(state.chatDomains)) {
    revision = Math.imul(revision ^ char.charCodeAt(0), 16777619) >>> 0;
  }
  return {
    ...settings,
    linkRulesStorageStatus: 'legacy',
    linkRulesLegacySnapshot: {
      revision: String(revision),
      policy: linkRulesPolicySchema.parse({
        version: 1,
        mode:
          settings.linkPolicy === 'BLOCKLIST_ONLY'
            ? 'DENY_ALL'
            : settings.linkPolicy === 'ALLOWLIST_ONLY'
              ? 'ALLOW_SELECTED'
              : 'ALLOW_ALL',
        rules,
      }),
    },
  };
}

export function previewLinkWrite(
  state: PreviewState,
  input: Partial<ChatSettings>,
): Partial<ChatSettings> {
  if (!input.linkRulesPolicy) return {};
  if (!state.chatSettings.linkRulesPolicy) {
    const snapshot = readPreviewLinkSettings(state).linkRulesLegacySnapshot;
    if (input.linkRulesLegacySnapshot?.revision !== snapshot?.revision) {
      throw new ApiRequestError(
        409,
        JSON.stringify({ code: 'LINK_RULES_LEGACY_CHANGED' }),
        'Список ссылок изменился. Обновите настройки; черновик сохранён.',
      );
    }
  }
  return {
    linkRulesPolicy: input.linkRulesPolicy,
    linkPolicy:
      input.linkRulesPolicy.mode === 'ALLOW_ALL'
        ? 'ALERT_ONLY'
        : input.linkRulesPolicy.mode === 'DENY_ALL'
          ? 'BLOCKLIST_ONLY'
          : 'ALLOWLIST_ONLY',
    linkRulesLegacySnapshot: null,
    linkRulesStorageStatus: 'valid',
    linkRulesReplaceInvalidStorage: undefined,
  };
}

export function previewLinksText(state: PreviewState, body: unknown) {
  const input = linkRulesPreviewRequestSchema.parse(body);
  // Only the local design fixture tokenizes pasted text here. The authenticated API uses
  // the production navigation parser and its runtime switches (AdminLinksService).
  const targets = (
    input.text.match(
      /(?:https?:\/\/|max:\/\/)[^\s<>]+|(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}(?:\/[^\s<>]*)?/giu,
    ) ?? []
  ).map((target) => ({ kind: 'external_url' as const, target, enforceable: true }));
  const result = evaluateLinkRulesPolicy(input.policy, targets, +readPreviewClock(state.clock));
  return {
    allowed: result.allowed,
    reason: result.reason,
    targetsCount: targets.length,
    ...(!result.allowed
      ? {
          target: result.target.target,
          ...(result.matchedRule ? { ruleId: result.matchedRule.id } : {}),
        }
      : {}),
  };
}
