import type { ChatSettings } from '@maxim/contracts/settings';

import { isEnforceableLinkPolicyTarget } from './navigation/link-policy-target.util';
import type { NavigationTargetEvidence } from './navigation/navigation-evidence.types';
import type { RuleViolation } from './rule-engine.contract';
import type { MessageLimitsBlockedDomainDetector } from './rule-engine-blocked-domains.detector';
import { prepareLinkAllowlist, detectBlockedLink } from './rule-engine-link-detector';
import { detectStopWordsViolations } from './stop-words/stop-words.detection';
import { isRuntimeLinkPolicyActive } from './link-rules-policy.runtime';
import type { PrismaService } from '../prisma/prisma.service';

export async function loadFreshDomainAllowlistForLinkRecheck(
  prisma: Pick<PrismaService, 'domainAllowlist'>,
  chatId: string,
): Promise<string[] | null> {
  const delegate = prisma.domainAllowlist;
  if (typeof delegate?.findMany !== 'function') return null;
  const rows = await delegate.findMany({
    where: {
      chatId,
      OR: [{ removeAfterAt: null }, { removeAfterAt: { gt: new Date() } }],
    },
    select: { domain: true },
  });
  return rows.map((row) => row.domain);
}

export function serializeLinkPolicyEffectiveAt(value: unknown): string | null {
  const parsed =
    value instanceof Date
      ? value
      : typeof value === 'string' || typeof value === 'number'
        ? new Date(value)
        : null;
  return parsed && Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

export function needsFreshLinkAllowlistRecheck(
  linkPolicy: ChatSettings['linkPolicy'],
  violations: readonly RuleViolation[],
  navigationTargets?: readonly NavigationTargetEvidence[],
  linkRulesPolicy?: unknown,
): boolean {
  if (violations.some((violation) => violation.ruleCode === 'MESSAGE_BLOCKED_DOMAIN')) {
    return true;
  }
  return (
    (linkRulesPolicy != null
      ? isRuntimeLinkPolicyActive(linkPolicy, linkRulesPolicy)
      : linkPolicy === 'ALLOWLIST_ONLY') &&
    (violations.some((violation) => violation.ruleCode === 'LINK_BLOCKED') ||
      Boolean(navigationTargets?.some(isEnforceableLinkPolicyTarget)))
  );
}

export function suppressUnverifiedAllowlistDependentViolations(
  linkPolicy: ChatSettings['linkPolicy'],
  violations: readonly RuleViolation[],
  linkRulesPolicy?: unknown,
): RuleViolation[] {
  return violations.filter(
    (violation) =>
      violation.ruleCode !== 'MESSAGE_BLOCKED_DOMAIN' &&
      (violation.ruleCode !== 'LINK_BLOCKED' ||
        (linkRulesPolicy == null && linkPolicy !== 'ALLOWLIST_ONLY')),
  );
}

export function recalculateFreshLinkAllowlistViolations(params: {
  text: string;
  settings: Pick<ChatSettings, 'linkPolicy' | 'messageLimitsBlockedDomains'> & {
    stopWordsPolicy?: unknown;
    stopWordsRevision?: number;
    linkRulesPolicy?: unknown;
  };
  freshDomainAllowlist: string[];
  navigationTargets?: readonly NavigationTargetEvidence[];
  violations: readonly RuleViolation[];
  blockedDomainDetector: MessageLimitsBlockedDomainDetector;
}): RuleViolation[] {
  const freshAllowlist = prepareLinkAllowlist(params.freshDomainAllowlist);
  const freshAllowlistMatcher = freshAllowlist.link;
  const linkViolation = detectBlockedLink(
    params.text,
    params.settings.linkPolicy,
    params.freshDomainAllowlist,
    freshAllowlist,
    params.navigationTargets,
    params.settings.linkRulesPolicy,
  );
  const newDomainViolation =
    params.settings.stopWordsPolicy == null
      ? null
      : detectStopWordsViolations({
          text: params.text,
          settings: params.settings,
          navigationTargets: params.navigationTargets,
          isLinkAllowlisted: freshAllowlistMatcher,
        }).find((violation) => violation.ruleCode === 'MESSAGE_BLOCKED_DOMAIN');
  const blockedDomain =
    params.settings.stopWordsPolicy == null
      ? params.blockedDomainDetector.detect(
          params.text,
          params.settings.messageLimitsBlockedDomains,
          { isLinkAllowlisted: freshAllowlistMatcher },
        )
      : null;
  const hadLinkViolation = params.violations.some(
    (violation) => violation.ruleCode === 'LINK_BLOCKED',
  );
  const recalculatedViolations = params.violations.flatMap((violation) => {
    if (violation.ruleCode === 'LINK_BLOCKED') {
      return linkViolation ? [{ ...violation, reason: linkViolation }] : [];
    }
    if (violation.ruleCode !== 'MESSAGE_BLOCKED_DOMAIN') {
      return [violation];
    }
    if (params.settings.stopWordsPolicy != null)
      return newDomainViolation
        ? [
            {
              ...newDomainViolation,
              metadata: {
                ...newDomainViolation.metadata,
                stopWordsSourceSha256:
                  violation.metadata?.stopWordsSourceSha256 ??
                  newDomainViolation.metadata?.stopWordsSourceSha256,
              },
            },
          ]
        : [];
    return blockedDomain
      ? [
          {
            ...violation,
            reason: `Blocked domain detected: ${blockedDomain.blockedDomain}`,
            metadata: {
              ...(violation.metadata ?? {}),
              blockedDomain: blockedDomain.blockedDomain,
              matchedDomain: blockedDomain.matchedDomain,
              matchedLink: blockedDomain.matchedLink,
            },
          },
        ]
      : [];
  });
  if (linkViolation && !hadLinkViolation) {
    recalculatedViolations.push({
      ruleCode: 'LINK_BLOCKED',
      score: 0.9,
      reason: linkViolation,
    });
  }
  return recalculatedViolations;
}
