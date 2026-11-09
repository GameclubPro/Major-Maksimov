import { createHash } from 'node:crypto';
import {
  evaluateLinkRulesPolicy,
  linkRulesPolicySchema,
  LINK_RULES_MAX,
  type LinkRulesPolicy,
  type LinkRulesPolicyEvaluation,
} from '@maxim/contracts/settings';
import type { NavigationTargetEvidence } from './navigation/navigation-evidence.types';
import { isEnforceableLinkPolicyTarget } from './navigation/link-policy-target.util';
import type { PrismaService } from '../prisma/prisma.service';
import type { RuleEvaluationObserver } from './rule-engine-observation';

export type RuntimeLinkRulesPolicy =
  | { status: 'legacy'; policy: null }
  | { status: 'invalid'; policy: null }
  | { status: 'valid'; policy: LinkRulesPolicy };

export function readRuntimeLinkRulesPolicy(value: unknown): RuntimeLinkRulesPolicy {
  if (value == null) return { status: 'legacy', policy: null };
  if (
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('rules' in value) ||
    !Array.isArray(value.rules) ||
    value.rules.length > LINK_RULES_MAX
  )
    return { status: 'invalid', policy: null };
  const parsed = linkRulesPolicySchema.safeParse(value);
  // FLAG: Present unsupported storage never falls back to the broader legacy shadow policy.
  return parsed.success
    ? { status: 'valid', policy: parsed.data }
    : { status: 'invalid', policy: null };
}

export function evaluateRuntimeLinkRulesPolicy(
  policy: LinkRulesPolicy,
  targets: readonly NavigationTargetEvidence[],
  nowMs = Date.now(),
  observer?: RuleEvaluationObserver,
): LinkRulesPolicyEvaluation<NavigationTargetEvidence> {
  const enforceableTargets = targets.filter(isEnforceableLinkPolicyTarget);
  const eligible = policy.mode !== 'ALLOW_ALL' && enforceableTargets.length > 0;
  if (eligible) observer?.eligible();
  const result = evaluateLinkRulesPolicy(policy, enforceableTargets, nowMs);
  observer?.finish(
    policy.mode === 'ALLOW_ALL'
      ? { kind: 'skip', reason: 'disabled' }
      : !eligible
        ? { kind: 'skip', reason: 'content' }
        : { kind: 'evaluated', matched: !result.allowed },
  );
  return result;
}

export function isRuntimeLinkPolicyActive(legacyPolicy: string, value: unknown): boolean {
  const current = readRuntimeLinkRulesPolicy(value);
  if (current.status === 'legacy') return legacyPolicy !== 'ALERT_ONLY';
  return current.status === 'valid' && current.policy.mode !== 'ALLOW_ALL';
}

export function fingerprintLinkRulesPolicy(value: unknown): string | null {
  const current = readRuntimeLinkRulesPolicy(value);
  return current.status === 'valid'
    ? createHash('sha256').update(JSON.stringify(current.policy)).digest('hex')
    : null;
}

export async function hasFreshLinkRulesPolicyAuthority(
  prisma: Pick<PrismaService, 'chatSettings'>,
  chatId: string,
  expected: {
    linkRulesPolicy?: unknown;
    linkPolicyRevision?: number;
    linkPolicyEffectiveAt?: unknown;
  },
): Promise<boolean> {
  if (expected.linkRulesPolicy == null) return true;
  const fingerprint = fingerprintLinkRulesPolicy(expected.linkRulesPolicy);
  if (!fingerprint) return false;
  const current = await prisma.chatSettings.findUnique({
    where: { chatId },
    select: { linkRulesPolicy: true, linkPolicyRevision: true, linkPolicyEffectiveAt: true },
  });
  const expectedAt = expected.linkPolicyEffectiveAt;
  const expectedTime =
    expectedAt instanceof Date
      ? expectedAt.getTime()
      : typeof expectedAt === 'string' || typeof expectedAt === 'number'
        ? new Date(expectedAt).getTime()
        : NaN;
  return Boolean(
    current &&
    fingerprintLinkRulesPolicy(current.linkRulesPolicy) === fingerprint &&
    current.linkPolicyRevision === expected.linkPolicyRevision &&
    current.linkPolicyEffectiveAt?.getTime() === expectedTime,
  );
}

export function latestExpiredLinkRuleAllowance(
  policy: LinkRulesPolicy,
  nowMs: number,
): Date | null {
  if (policy.mode === 'ALLOW_ALL' || policy.mode === 'DENY_ALL') return null;
  let latest = -Infinity;
  for (const rule of policy.rules) {
    if (!rule.enabled || rule.effect !== 'ALLOW' || rule.expiresAt === null) continue;
    const expiresAt = Date.parse(rule.expiresAt);
    if (expiresAt <= nowMs) latest = Math.max(latest, expiresAt);
  }
  return Number.isFinite(latest) ? new Date(latest) : null;
}
