import { linkRulesPolicySchema } from '@maxim/contracts/settings';
import { fingerprintModerationSettings } from './moderation-settings-fingerprint';
import {
  fingerprintLinkRulesPolicy,
  isRuntimeLinkPolicyActive,
  readRuntimeLinkRulesPolicy,
} from './link-rules-policy.runtime';
import { deriveLinkPolicySemanticEffectiveAt } from './link-history-recovery.util';

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
