import {
  buildNavigationAllowlistPolicyKeys,
  type NavigationAllowlistEvidenceKind,
  type NavigationAllowlistPolicyKey,
} from './settings-utils.js';
import type { LinkRule, LinkRulesPolicy } from './link-rules-policy-fields.js';

export * from './link-rules-policy-fields.js';
export * from './link-rules-policy-input.js';
export * from './link-rules-policy-preview.js';

export type LinkRulesTarget = {
  kind: NavigationAllowlistEvidenceKind;
  target: string;
  enforceable?: boolean;
  allowlistAliases?: readonly {
    kind: NavigationAllowlistEvidenceKind;
    target: string;
  }[];
};

export type LinkRulesPolicyEvaluation<T extends LinkRulesTarget = LinkRulesTarget> =
  | {
      allowed: true;
      reason: 'NO_ENFORCEABLE_TARGETS' | 'ALLOW_ALL' | 'ALL_TARGETS_ALLOWED';
    }
  | {
      allowed: false;
      reason: 'DENY_ALL' | 'DENY_RULE' | 'NOT_ALLOWED';
      target: T;
      matchedRule: LinkRule | null;
    };

function matchesPolicyKey(rule: LinkRule, key: NavigationAllowlistPolicyKey): boolean {
  if (rule.kind !== key.kind) return false;
  if (rule.kind !== 'WEB_DOMAIN') return rule.target === key.target;
  return key.target === rule.target || key.target.endsWith(`.${rule.target}`);
}

function findTargetRule(target: LinkRulesTarget, rules: readonly LinkRule[]): LinkRule | null {
  const keys = [target, ...(target.allowlistAliases ?? [])]
    .filter((candidate) => candidate.kind !== 'profile_mention')
    .flatMap((candidate) => buildNavigationAllowlistPolicyKeys(candidate.target, candidate.kind));
  let matched: LinkRule | null = null;
  for (const rule of rules) {
    if (!keys.some((key) => matchesPolicyKey(rule, key))) continue;
    const specificity = rule.kind === 'WEB_DOMAIN' ? rule.target.length : Infinity;
    const currentSpecificity = matched
      ? matched.kind === 'WEB_DOMAIN'
        ? matched.target.length
        : Infinity
      : -1;
    // FLAG: An exact exception overrides a domain; equally specific aliases cannot hide a deny.
    if (
      specificity > currentSpecificity ||
      (specificity === currentSpecificity && rule.effect === 'DENY')
    ) {
      matched = rule;
    }
  }
  return matched;
}

/** Evaluate every action independently; aliases belong only to their originating action. */
export function evaluateLinkRulesPolicy<T extends LinkRulesTarget>(
  policy: LinkRulesPolicy,
  targets: readonly T[],
  nowMs: number = Date.now(),
): LinkRulesPolicyEvaluation<T> {
  if (!Number.isFinite(nowMs)) throw new RangeError('Invalid link policy evaluation time.');
  const enforceableTargets = targets.filter(
    (target) => target.kind !== 'profile_mention' && target.enforceable !== false,
  );
  const firstTarget = enforceableTargets[0];
  if (!firstTarget) return { allowed: true, reason: 'NO_ENFORCEABLE_TARGETS' };
  if (policy.mode === 'ALLOW_ALL') return { allowed: true, reason: 'ALLOW_ALL' };
  if (policy.mode === 'DENY_ALL') {
    return { allowed: false, reason: 'DENY_ALL', target: firstTarget, matchedRule: null };
  }

  const activeRules = policy.rules.filter(
    (rule) => rule.enabled && (rule.expiresAt === null || Date.parse(rule.expiresAt) > nowMs),
  );
  for (const target of enforceableTargets) {
    const matchedRule = findTargetRule(target, activeRules);
    if (matchedRule?.effect === 'DENY') {
      return { allowed: false, reason: 'DENY_RULE', target, matchedRule };
    }
    if (!matchedRule && policy.mode === 'ALLOW_SELECTED') {
      return { allowed: false, reason: 'NOT_ALLOWED', target, matchedRule: null };
    }
  }
  return { allowed: true, reason: 'ALL_TARGETS_ALLOWED' };
}
