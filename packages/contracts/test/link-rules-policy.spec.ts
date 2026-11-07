import { describe, expect, it } from 'vitest';
import { chatSettingsSchema } from '../src/core.js';
import {
  LINK_RULES_MAX,
  evaluateLinkRulesPolicy,
  linkRuleSchema,
  linkRulesPolicySchema,
  linkRulesLegacySnapshotSchema,
  linkRulesPreviewRequestSchema,
  linkRulesPreviewResponseSchema,
  normalizeLinkRuleInput,
  normalizeLinkRuleTarget,
  type LinkRule,
  type LinkRulesMode,
  type LinkRulesTarget,
} from '../src/settings.js';

const nowMs = Date.parse('2026-11-07T10:00:00.000Z');
const rule = (changes: Partial<LinkRule> = {}): LinkRule =>
  linkRuleSchema.parse({
    id: 'rule-one',
    effect: 'DENY',
    kind: 'WEB_EXACT',
    target: 'https://example.com/offer',
    ...changes,
  });
const policy = (mode: LinkRulesMode, rules: LinkRule[] = []) =>
  linkRulesPolicySchema.parse({ version: 1, mode, rules });
const target = (value: string, changes: Partial<LinkRulesTarget> = {}): LinkRulesTarget => ({
  kind: 'external_url',
  target: value,
  ...changes,
});

describe('link rule contracts', () => {
  it('keeps absent legacy settings absent and accepts an explicit null or new policy', () => {
    expect(chatSettingsSchema.parse({}).linkRulesPolicy).toBeUndefined();
    expect(chatSettingsSchema.parse({ linkRulesPolicy: null }).linkRulesPolicy).toBeNull();
    const configured = policy('DENY_SELECTED', [rule()]);
    expect(chatSettingsSchema.parse({ linkRulesPolicy: configured }).linkRulesPolicy).toEqual(
      configured,
    );
    expect(chatSettingsSchema.safeParse({ linkRulesPolicy: {} }).success).toBe(false);
    expect(chatSettingsSchema.parse({ linkPolicy: 'BLOCKLIST_ONLY' }).linkPolicy).toBe(
      'BLOCKLIST_ONLY',
    );
  });

  it('normalizes typed targets and defaults enabled rules to no expiration', () => {
    expect(rule({ target: '  HTTPS://Example.COM:443/offer?x=1#section  ' })).toEqual({
      id: 'rule-one',
      effect: 'DENY',
      kind: 'WEB_EXACT',
      target: 'https://example.com/offer?x=1#section',
      enabled: true,
      expiresAt: null,
    });
    expect(rule({ kind: 'WEB_DOMAIN', target: 'https://пример.рф/path' }).target).toBe(
      'xn--e1afmkfd.xn--p1ai',
    );
    expect(rule({ kind: 'MAX_ENTITY', target: 'chat-id:-00123' }).target).toBe('chat-id:-123');
    expect(rule({ kind: 'MAX_PROFILE', target: 'MAX://user/123' }).target).toBe('user-id:123');
    expect(rule({ kind: 'MINI_APP', target: 'contact_id:101' }).target).toBe('contact-id:101');
  });

  it('requires the explicit policy version and mode and rejects unsupported fields', () => {
    const configured = policy('DENY_SELECTED');
    for (const candidate of [
      {},
      { ...configured, version: 2 },
      { ...configured, mode: 'BLOCKLIST_ONLY' },
      { ...configured, rules: undefined },
      { ...configured, followRedirects: true },
      { ...configured, rules: [{ ...rule(), action: 'BAN' }] },
    ]) {
      expect(linkRulesPolicySchema.safeParse(candidate).success).toBe(false);
    }
  });

  it('keeps the adoption snapshot optional and validates a bounded canonical revision', () => {
    expect(chatSettingsSchema.parse({}).linkRulesLegacySnapshot).toBeUndefined();
    expect(
      chatSettingsSchema.parse({ linkRulesLegacySnapshot: null }).linkRulesLegacySnapshot,
    ).toBeNull();
    const snapshot = {
      revision: '42',
      policy: policy('ALLOW_SELECTED', [rule({ effect: 'ALLOW' })]),
    };
    expect(
      chatSettingsSchema.parse({ linkRulesLegacySnapshot: snapshot }).linkRulesLegacySnapshot,
    ).toEqual(snapshot);
    for (const revision of ['', '-1', '1.0', '01', 'x', '1'.repeat(21)]) {
      expect(linkRulesLegacySnapshotSchema.safeParse({ ...snapshot, revision }).success).toBe(
        false,
      );
    }
  });

  it('validates preview input limits and the public result shape', () => {
    const input = { policy: policy('DENY_SELECTED', [rule()]), text: 'https://example.com/offer' };
    expect(linkRulesPreviewRequestSchema.parse(input)).toEqual(input);
    expect(linkRulesPreviewRequestSchema.safeParse({ ...input, text: '' }).success).toBe(false);
    expect(
      linkRulesPreviewRequestSchema.safeParse({ ...input, text: 'x'.repeat(10_001) }).success,
    ).toBe(false);
    expect(
      linkRulesPreviewResponseSchema.parse({
        allowed: false,
        reason: 'DENY_RULE',
        target: input.text,
        ruleId: 'rule-one',
        targetsCount: 1,
      }),
    ).toMatchObject({ allowed: false, ruleId: 'rule-one' });
    expect(
      linkRulesPreviewResponseSchema.safeParse({
        allowed: true,
        reason: 'ALLOW_ALL',
        targetsCount: -1,
      }).success,
    ).toBe(false);
  });

  it('bounds the rule count and validates stable ids, targets and expiration dates', () => {
    expect(
      linkRulesPolicySchema.safeParse({
        version: 1,
        mode: 'DENY_SELECTED',
        rules: Array.from({ length: LINK_RULES_MAX }, (_, index) =>
          rule({ id: `rule-${index}`, target: `https://example.com/${index}` }),
        ),
      }).success,
    ).toBe(true);
    expect(
      linkRulesPolicySchema.safeParse({
        version: 1,
        mode: 'DENY_SELECTED',
        rules: Array.from({ length: LINK_RULES_MAX + 1 }, (_, index) =>
          rule({ id: `rule-${index}`, target: `https://example.com/${index}` }),
        ),
      }).success,
    ).toBe(false);
    for (const candidate of [
      { ...rule(), id: '' },
      { ...rule(), id: 'unstable id' },
      { ...rule(), id: 'x'.repeat(129) },
      { ...rule(), enabled: 'false' },
      { ...rule(), target: 'https://user:password@example.com' },
      { ...rule(), target: 'javascript:alert(1)' },
      { ...rule(), target: 'https://example.com/with\u200bcontrol' },
      { ...rule(), target: 'x'.repeat(2049) },
      { ...rule(), kind: 'UNKNOWN' },
      { ...rule(), expiresAt: 'tomorrow' },
      { ...rule(), expiresAt: '2026-02-31T10:00:00Z' },
    ]) {
      expect(linkRuleSchema.safeParse(candidate).success).toBe(false);
    }
    expect(rule({ expiresAt: '2026-11-08T13:00:00+03:00' }).expiresAt).toBe(
      '2026-11-08T13:00:00+03:00',
    );
  });

  it('rejects duplicate ids and normalized typed targets independently of effect or activity', () => {
    for (const rules of [
      [rule(), rule({ target: 'https://elsewhere.example' })],
      [rule(), rule({ id: 'rule-two', effect: 'ALLOW', target: 'HTTPS://EXAMPLE.com:443/offer' })],
      [rule(), rule({ id: 'rule-two', enabled: false, expiresAt: '2026-01-01T00:00:00Z' })],
      [
        rule({ kind: 'WEB_DOMAIN', target: 'пример.рф' }),
        rule({ id: 'rule-two', kind: 'WEB_DOMAIN', target: 'xn--e1afmkfd.xn--p1ai' }),
      ],
    ]) {
      expect(
        linkRulesPolicySchema.safeParse({ version: 1, mode: 'DENY_SELECTED', rules }).success,
      ).toBe(false);
    }
    expect(
      policy('DENY_SELECTED', [
        rule({ target: 'https://example.com/offer?x=1#one' }),
        rule({ id: 'rule-two', target: 'https://example.com/offer?x=1#two' }),
        rule({ id: 'rule-three', target: 'https://example.com/offer?x=2#one' }),
      ]).rules,
    ).toHaveLength(3);
  });
});

describe('link rule input normalization', () => {
  it('suggests a domain for a bare host and exact URLs for full links, paths, queries, fragments or ports', () => {
    expect(normalizeLinkRuleInput(' Example.COM ')).toEqual({
      kind: 'WEB_DOMAIN',
      target: 'example.com',
    });
    for (const value of [
      'https://example.com',
      'https://example.com/page?key=one&key=two#section',
      'https://example.com?key=value',
      'https://example.com#section',
      'https://example.com:8443',
    ]) {
      expect(normalizeLinkRuleInput(value)).toEqual({ kind: 'WEB_EXACT', target: value });
    }
    expect(normalizeLinkRuleInput('https://example.com/page?x=1#part', 'WEB_DOMAIN')).toEqual({
      kind: 'WEB_DOMAIN',
      target: 'example.com',
    });
    expect(normalizeLinkRuleInput('https://example.com', 'WEB_EXACT')).toEqual({
      kind: 'WEB_EXACT',
      target: 'https://example.com',
    });
  });

  it('reuses established MAX entities and mini app identities', () => {
    expect(normalizeLinkRuleInput('http://www.max.ru/join/SomeInvite/?from=share')).toEqual({
      kind: 'MAX_ENTITY',
      target: 'url:https://max.ru/join/SomeInvite',
    });
    expect(normalizeLinkRuleInput('https://max.ru/ShopBot?startapp=catalog')).toEqual({
      kind: 'MINI_APP',
      target: 'bot:shopbot',
    });
    expect(normalizeLinkRuleInput('contact_id:101')).toEqual({
      kind: 'MINI_APP',
      target: 'contact-id:101',
    });
    expect(normalizeLinkRuleInput('user-id:123')).toEqual({
      kind: 'MAX_PROFILE',
      target: 'user-id:123',
    });
    expect(normalizeLinkRuleInput('https://max.ru/ShopBot?startapp=catalog', 'WEB_EXACT')).toEqual({
      kind: 'WEB_EXACT',
      target: 'https://max.ru/ShopBot?startapp=catalog',
    });
  });

  it.each([
    '',
    'ссылка в тексте example.com',
    'https://user:password@example.com',
    'ftp://example.com/file',
    'javascript:alert(1)',
    'https://example.com\\fake/path',
    'bot:',
  ])('rejects unsafe or incomplete input %s', (value) => {
    expect(normalizeLinkRuleInput(value)).toBeNull();
  });

  it('retains scheme differences when normalizing exact links', () => {
    expect(normalizeLinkRuleTarget('http://example.com:80/page?q=1#part', 'WEB_EXACT')).toBe(
      'http://example.com/page?q=1#part',
    );
    expect(normalizeLinkRuleTarget('https://example.com:443/page?q=1#part', 'WEB_EXACT')).toBe(
      'https://example.com/page?q=1#part',
    );
  });
});

describe('link rules evaluation', () => {
  it('blocks only a selected exact link while preserving neighboring pages and schemes', () => {
    const configured = policy('DENY_SELECTED', [rule()]);
    expect(
      evaluateLinkRulesPolicy(configured, [target('https://example.com/offer')], nowMs),
    ).toMatchObject({
      allowed: false,
      reason: 'DENY_RULE',
      matchedRule: { id: 'rule-one' },
    });
    for (const value of [
      'https://example.com/another',
      'https://example.com/offer?campaign=2',
      'https://example.com/offer#part',
      'https://example.com/offer/child',
      'http://example.com/offer',
    ]) {
      expect(evaluateLinkRulesPolicy(configured, [target(value)], nowMs).allowed).toBe(true);
    }
  });

  it('matches DNS label boundaries and preserves the scope of a configured www host', () => {
    const configured = policy('DENY_SELECTED', [
      rule({ kind: 'WEB_DOMAIN', target: 'example.com' }),
    ]);
    for (const value of [
      'https://example.com',
      'http://www.example.com/path',
      'https://a.b.example.com',
    ]) {
      expect(evaluateLinkRulesPolicy(configured, [target(value)], nowMs).allowed).toBe(false);
    }
    for (const value of [
      'https://notexample.com',
      'https://example.com.evil.test',
      'https://example.company',
    ]) {
      expect(evaluateLinkRulesPolicy(configured, [target(value)], nowMs).allowed).toBe(true);
    }
    const wwwOnly = policy('DENY_SELECTED', [
      rule({ kind: 'WEB_DOMAIN', target: 'www.example.com' }),
    ]);
    expect(evaluateLinkRulesPolicy(wwwOnly, [target('https://example.com')], nowMs).allowed).toBe(
      true,
    );
    expect(
      evaluateLinkRulesPolicy(wwwOnly, [target('https://www.example.com')], nowMs).allowed,
    ).toBe(false);
  });

  it('allows an exact exception inside a denied domain regardless of rule order', () => {
    const rules = [
      rule({ kind: 'WEB_DOMAIN', target: 'example.com' }),
      rule({ id: 'exception', effect: 'ALLOW', target: 'https://example.com/offer' }),
    ];
    for (const ordered of [rules, [...rules].reverse()]) {
      const configured = policy('DENY_SELECTED', ordered);
      expect(
        evaluateLinkRulesPolicy(configured, [target('https://example.com/offer')], nowMs).allowed,
      ).toBe(true);
      expect(
        evaluateLinkRulesPolicy(configured, [target('https://example.com/other')], nowMs).allowed,
      ).toBe(false);
    }
  });

  it('denies an exact link inside an allowed domain', () => {
    const configured = policy('ALLOW_SELECTED', [
      rule({ kind: 'WEB_DOMAIN', effect: 'ALLOW', target: 'example.com' }),
      rule({ id: 'denied-page' }),
    ]);
    expect(
      evaluateLinkRulesPolicy(configured, [target('https://example.com/offer')], nowMs),
    ).toMatchObject({
      allowed: false,
      reason: 'DENY_RULE',
      matchedRule: { id: 'denied-page' },
    });
    expect(
      evaluateLinkRulesPolicy(configured, [target('https://example.com/other')], nowMs).allowed,
    ).toBe(true);
    expect(
      evaluateLinkRulesPolicy(configured, [target('https://other.example')], nowMs),
    ).toMatchObject({
      allowed: false,
      reason: 'NOT_ALLOWED',
      matchedRule: null,
    });
  });

  it('applies the longest matching DNS domain before a parent domain', () => {
    const configured = policy('DENY_SELECTED', [
      rule({ kind: 'WEB_DOMAIN', target: 'example.com' }),
      rule({ id: 'subdomain', effect: 'ALLOW', kind: 'WEB_DOMAIN', target: 'docs.example.com' }),
      rule({ id: 'private', kind: 'WEB_DOMAIN', target: 'private.docs.example.com' }),
    ]);
    expect(
      evaluateLinkRulesPolicy(configured, [target('https://docs.example.com/page')], nowMs).allowed,
    ).toBe(true);
    expect(
      evaluateLinkRulesPolicy(configured, [target('https://api.docs.example.com')], nowMs).allowed,
    ).toBe(true);
    expect(
      evaluateLinkRulesPolicy(configured, [target('https://private.docs.example.com')], nowMs),
    ).toMatchObject({
      allowed: false,
      matchedRule: { id: 'private' },
    });
  });

  it('ignores disabled and expired rules, including the exact expiration instant', () => {
    const base = rule();
    for (const inactive of [
      { ...base, enabled: false },
      { ...base, expiresAt: '2026-11-07T09:59:59.999Z' },
      { ...base, expiresAt: '2026-11-07T10:00:00.000Z' },
      { ...base, expiresAt: '2026-11-07T13:00:00+03:00' },
    ]) {
      expect(
        evaluateLinkRulesPolicy(policy('DENY_SELECTED', [inactive]), [target(base.target)], nowMs)
          .allowed,
      ).toBe(true);
      expect(
        evaluateLinkRulesPolicy(
          policy('ALLOW_SELECTED', [{ ...inactive, effect: 'ALLOW' }]),
          [target(base.target)],
          nowMs,
        ).allowed,
      ).toBe(false);
    }
    expect(
      evaluateLinkRulesPolicy(
        policy('DENY_SELECTED', [rule({ expiresAt: '2026-11-07T10:00:00.001Z' })]),
        [target(base.target)],
        nowMs,
      ).allowed,
    ).toBe(false);
  });

  it('requires every enforceable action to pass and returns the first blocked original target', () => {
    const configured = policy('ALLOW_SELECTED', [rule({ effect: 'ALLOW' })]);
    const first = target('https://unlisted.example/first');
    const second = target('https://unlisted.example/second');
    const result = evaluateLinkRulesPolicy(
      configured,
      [target('https://example.com/offer'), first, second],
      nowMs,
    );
    expect(result).toMatchObject({ allowed: false, reason: 'NOT_ALLOWED' });
    if (result.allowed) throw new Error('An unlisted action must be blocked');
    expect(result.target).toBe(first);
  });

  it('ignores profile mentions and explicitly ineligible navigation', () => {
    const configured = policy('DENY_ALL');
    expect(
      evaluateLinkRulesPolicy(
        configured,
        [
          target('user-id:123', { kind: 'profile_mention' }),
          target('https://example.com/offer', { enforceable: false }),
        ],
        nowMs,
      ),
    ).toEqual({ allowed: true, reason: 'NO_ENFORCEABLE_TARGETS' });
    expect(evaluateLinkRulesPolicy(configured, [], nowMs)).toEqual({
      allowed: true,
      reason: 'NO_ENFORCEABLE_TARGETS',
    });
  });

  it('makes allow-all ignore denials and deny-all ignore exceptions', () => {
    const link = target('https://example.com/offer');
    expect(evaluateLinkRulesPolicy(policy('ALLOW_ALL', [rule()]), [link], nowMs)).toEqual({
      allowed: true,
      reason: 'ALLOW_ALL',
    });
    expect(
      evaluateLinkRulesPolicy(policy('DENY_ALL', [rule({ effect: 'ALLOW' })]), [link], nowMs),
    ).toEqual({
      allowed: false,
      reason: 'DENY_ALL',
      target: link,
      matchedRule: null,
    });
  });

  it('matches typed MAX identities and aliases using the same existing canonical keys', () => {
    const configured = policy('ALLOW_SELECTED', [
      rule({ kind: 'MAX_ENTITY', effect: 'ALLOW', target: 'https://max.ru/join/Invite' }),
      rule({ id: 'app', kind: 'MINI_APP', effect: 'ALLOW', target: 'bot:shopbot' }),
      rule({ id: 'contact', kind: 'MINI_APP', effect: 'ALLOW', target: 'contact-id:101' }),
    ]);
    for (const action of [
      target('http://www.max.ru/join/Invite/?from=share'),
      target('https://max.ru/join/Invite', { kind: 'max_entity' }),
      target('https://max.ru/ShopBot?startapp=catalog'),
      target('bot:ShopBot', { kind: 'mini_app' }),
      target('contact_id:101', { kind: 'mini_app' }),
    ]) {
      expect(evaluateLinkRulesPolicy(configured, [action], nowMs).allowed).toBe(true);
    }
  });

  it('keeps alias permission scoped to its own action', () => {
    const configured = policy('ALLOW_SELECTED', [
      rule({ kind: 'MINI_APP', effect: 'ALLOW', target: 'bot:shopbot' }),
    ]);
    const aliased = target('https://example.com/widget', {
      allowlistAliases: [{ kind: 'mini_app', target: 'bot:shopbot' }],
    });
    const independent = target('https://example.com/widget');
    expect(evaluateLinkRulesPolicy(configured, [aliased], nowMs).allowed).toBe(true);
    const result = evaluateLinkRulesPolicy(configured, [aliased, independent], nowMs);
    expect(result).toMatchObject({ allowed: false, reason: 'NOT_ALLOWED' });
    if (result.allowed) throw new Error('The independent action must remain unlisted');
    expect(result.target).toBe(independent);
  });

  it('prefers a denial when equally specific exact aliases conflict', () => {
    const rules = [
      rule(),
      rule({ id: 'app', kind: 'MINI_APP', effect: 'ALLOW', target: 'bot:shopbot' }),
    ];
    const action = target('https://example.com/offer', {
      allowlistAliases: [{ kind: 'mini_app', target: 'bot:shopbot' }],
    });
    for (const ordered of [rules, [...rules].reverse()]) {
      expect(
        evaluateLinkRulesPolicy(policy('ALLOW_SELECTED', ordered), [action], nowMs),
      ).toMatchObject({
        allowed: false,
        reason: 'DENY_RULE',
        matchedRule: { id: 'rule-one' },
      });
    }
  });

  it('does not grant access through a profile-mention alias', () => {
    const configured = policy('ALLOW_SELECTED', [
      rule({ kind: 'MAX_PROFILE', effect: 'ALLOW', target: 'user-id:123' }),
    ]);
    const action = target('https://example.com/offer', {
      allowlistAliases: [{ kind: 'profile_mention', target: 'user-id:123' }],
    });
    expect(evaluateLinkRulesPolicy(configured, [action], nowMs).allowed).toBe(false);
  });
});
