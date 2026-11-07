import {
  needsFreshLinkAllowlistRecheck,
  recalculateFreshLinkAllowlistViolations,
  suppressUnverifiedAllowlistDependentViolations,
} from './link-allowlist-recheck.util';
import { MessageLimitsBlockedDomainDetector } from './rule-engine-blocked-domains.detector';

describe('link rule fresh recheck', () => {
  const policy = {
    version: 1,
    mode: 'DENY_SELECTED',
    rules: [{ id: 'deny', effect: 'DENY', kind: 'WEB_DOMAIN', target: 'blocked.example' }],
  };
  const target = {
    kind: 'external_url' as const,
    target: 'https://blocked.example/path',
    normalizedTarget: 'https://blocked.example/path',
    enforceable: true,
    origins: [],
  };
  const violations = [
    { ruleCode: 'LINK_BLOCKED', reason: 'cached link', score: 1 },
    { ruleCode: 'MESSAGE_BLOCKED_DOMAIN', reason: 'cached site', score: 1 },
    { ruleCode: 'PHONE_NUMBER_BLOCKED', reason: 'independent', score: 1 },
  ];
  it('rechecks active selective targets while leaving inactive and malformed policies inert', () => {
    expect(needsFreshLinkAllowlistRecheck('ALLOWLIST_ONLY', [], [target], policy)).toBe(true);
    expect(
      needsFreshLinkAllowlistRecheck('ALLOWLIST_ONLY', [], [target], {
        ...policy,
        mode: 'ALLOW_ALL',
      }),
    ).toBe(false);
    expect(needsFreshLinkAllowlistRecheck('BLOCKLIST_ONLY', [], [target], { version: 999 })).toBe(
      false,
    );
  });
  it('keeps new deny rules independent of the unchanged legacy domain exception', () => {
    const result = recalculateFreshLinkAllowlistViolations({
      text: target.target,
      settings: {
        linkPolicy: 'ALLOWLIST_ONLY',
        linkRulesPolicy: policy,
        messageLimitsBlockedDomains: ['blocked.example'],
      },
      freshDomainAllowlist: ['domain:blocked.example'],
      navigationTargets: [target],
      violations,
      blockedDomainDetector: new MessageLimitsBlockedDomainDetector(),
    });
    expect(result.map((hit) => hit.ruleCode)).toEqual(['LINK_BLOCKED', 'PHONE_NUMBER_BLOCKED']);
    expect(result[0]!.reason).toContain('blocked by a link rule');
  });
  it('suppresses unverified new link effects and preserves independent rules on a failed read', () => {
    expect(
      suppressUnverifiedAllowlistDependentViolations('BLOCKLIST_ONLY', violations, policy),
    ).toEqual([violations[2]]);
    expect(suppressUnverifiedAllowlistDependentViolations('BLOCKLIST_ONLY', violations)).toEqual([
      violations[0],
      violations[2],
    ]);
  });
});
