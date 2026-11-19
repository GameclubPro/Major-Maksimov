import {
  linkRuleSchema,
  linkRulesPolicySchema,
  type LinkRule,
  type LinkRulesMode,
} from '@maxim/contracts/settings';
import { fingerprintModerationSettings } from './moderation-settings-fingerprint';
import {
  evaluateRuntimeLinkRulesPolicy,
  fingerprintLinkRulesPolicy,
  isRuntimeLinkPolicyActive,
  readRuntimeLinkRulesPolicy,
} from './link-rules-policy.runtime';
import { deriveLinkPolicySemanticEffectiveAt } from './link-history-recovery.util';

import type { NavigationTargetEvidence } from './navigation/navigation-evidence.types';

describe('link policy runtime boundary', () => {
  it('distinguishes absent legacy storage from unsupported present policy', () => {
    expect(readRuntimeLinkRulesPolicy(null).status).toBe('legacy');
    expect(readRuntimeLinkRulesPolicy(undefined).status).toBe('legacy');
    for (const value of [
      { version: 999 },
      {},
      'bad',
      { version: 1, mode: 'DENY_ALL', rules: {} },
    ]) {
      expect(readRuntimeLinkRulesPolicy(value).status).toBe('invalid');
      expect(isRuntimeLinkPolicyActive('BLOCKLIST_ONLY', value)).toBe(false);
      expect(fingerprintLinkRulesPolicy(value)).toBeNull();
    }
    expect(isRuntimeLinkPolicyActive('BLOCKLIST_ONLY', null)).toBe(true);
  });

  it('binds a link decision to mode, rules and legacy policy while ignoring unrelated settings', () => {
    const policy = linkRulesPolicySchema.parse({ version: 1, mode: 'DENY_SELECTED', rules: [] });
    const settings = { linkPolicy: 'ALLOWLIST_ONLY', linkRulesPolicy: policy };
    const fingerprint = fingerprintModerationSettings(settings, 'LINK_BLOCKED');
    expect(
      fingerprintModerationSettings({ ...settings, linkPolicy: 'ALERT_ONLY' }, 'LINK_BLOCKED'),
    ).not.toBe(fingerprint);
    expect(
      fingerprintModerationSettings(
        { ...settings, linkRulesPolicy: { ...policy, mode: 'ALLOW_ALL' } },
        'LINK_BLOCKED',
      ),
    ).not.toBe(fingerprint);
    expect(
      fingerprintModerationSettings({ ...settings, antiSpamEnabled: true }, 'LINK_BLOCKED'),
    ).toBe(fingerprint);
  });

  it('uses only expired enabled JSON allowances after adoption, preserving the legacy expiry reader', () => {
    const baseline = new Date('2026-11-01T00:00:00Z');
    const expiry = new Date('2026-11-02T00:00:00Z');
    const now = Date.parse('2026-11-03T00:00:00Z');
    const policy = linkRulesPolicySchema.parse({
      version: 1,
      mode: 'ALLOW_SELECTED',
      rules: [
        {
          id: 'allow',
          effect: 'ALLOW',
          kind: 'WEB_DOMAIN',
          target: 'example.com',
          expiresAt: expiry.toISOString(),
        },
      ],
    });
    expect(
      deriveLinkPolicySemanticEffectiveAt('ALLOWLIST_ONLY', baseline, new Date(now), policy, now),
    ).toEqual(expiry);
    expect(
      deriveLinkPolicySemanticEffectiveAt('ALLOWLIST_ONLY', baseline, new Date(now), null, now),
    ).toEqual(new Date(now));
    expect(
      deriveLinkPolicySemanticEffectiveAt(
        'ALLOWLIST_ONLY',
        baseline,
        null,
        { ...policy, rules: [{ ...policy.rules[0], enabled: false }] },
        now,
      ),
    ).toEqual(baseline);
    expect(
      deriveLinkPolicySemanticEffectiveAt('BLOCKLIST_ONLY', baseline, null, { version: 999 }, now),
    ).toBeNull();
  });
});

describe('Google Search destinations', () => {
  const nowMs = Date.parse('2026-11-07T10:00:00.000Z');
  const rule = (changes: Partial<LinkRule>): LinkRule =>
    linkRuleSchema.parse({ id: 'rule-one', effect: 'DENY', kind: 'WEB_EXACT', ...changes });
  const policy = (mode: LinkRulesMode, rules: LinkRule[]) =>
    linkRulesPolicySchema.parse({ version: 1, mode, rules });
  const target = (value: string): NavigationTargetEvidence => ({
    kind: 'external_url',
    target: value,
    normalizedTarget: value,
    enforceable: true,
    origins: [],
  });

  const googleSearchLink = (destination: string) =>
    `https://www.google.com/url?sa=t&source=web&rct=j&url=${encodeURIComponent(destination)}&q=&ved=example`;

  it('applies existing exact and domain rules to a Google search destination in allowlist mode', () => {
    const allowedDomain = rule({ effect: 'ALLOW', kind: 'WEB_DOMAIN', target: 'wildberries.ru' });
    const deniedProduct = rule({
      id: 'denied-product',
      target: 'https://www.wildberries.ru/catalog/blocked?size=1&color=2',
    });
    const configured = policy('ALLOW_SELECTED', [allowedDomain, deniedProduct]);
    const permitted = target(googleSearchLink('https://www.wildberries.ru/catalog/allowed'));
    const blocked = target(googleSearchLink(deniedProduct.target));
    expect(evaluateRuntimeLinkRulesPolicy(configured, [permitted], nowMs).allowed).toBe(true);
    expect(evaluateRuntimeLinkRulesPolicy(configured, [permitted, blocked], nowMs)).toMatchObject({
      allowed: false,
      reason: 'DENY_RULE',
      target: blocked,
      matchedRule: { id: 'denied-product' },
    });
    expect(
      evaluateRuntimeLinkRulesPolicy(policy('DENY_SELECTED', [deniedProduct]), [blocked], nowMs)
        .allowed,
    ).toBe(true);
    const deniedWrapper = rule({ id: 'no-google', kind: 'WEB_DOMAIN', target: 'google.com' });
    expect(
      evaluateRuntimeLinkRulesPolicy(
        policy('ALLOW_SELECTED', [allowedDomain, deniedWrapper]),
        [permitted],
        nowMs,
      ),
    ).toMatchObject({ allowed: false, matchedRule: { id: 'no-google' } });
  });

  it('declines fallback for unrecognized destinations and ambiguous Google links', () => {
    const configured = policy('ALLOW_SELECTED', [
      rule({ effect: 'ALLOW', kind: 'WEB_DOMAIN', target: 'wildberries.ru' }),
    ]);
    const direct = 'https://www.wildberries.ru/catalog/product';
    const wrapper = googleSearchLink(direct);
    for (const value of [
      googleSearchLink('https://unlisted.example'),
      googleSearchLink('https://wildberries.ru.unlisted.example'),
      googleSearchLink('https://user@www.wildberries.ru'),
      googleSearchLink('//www.wildberries.ru'),
      googleSearchLink(wrapper),
      wrapper.replace('www.google.com', 'www.google.com.unlisted.example'),
      wrapper.replace('/url?', '/another?'),
      wrapper.replace('https:', 'http:'),
      wrapper.replace('&q=', '&q=https://unlisted.example'),
      wrapper + '&url=https://unlisted.example',
      wrapper + '&next=https://unlisted.example',
    ]) {
      expect(evaluateRuntimeLinkRulesPolicy(configured, [target(value)], nowMs)).toMatchObject({
        allowed: false,
        reason: 'NOT_ALLOWED',
      });
    }
  });
});
