import { LinkPolicy } from '../prisma/prisma-client';
import type { NavigationTargetEvidence } from './navigation/navigation-evidence.types';
import {
  createAllowlistLinkMatcher,
  detectBlockedLink as detectWithMatcher,
  prepareLinkAllowlist,
} from './rule-engine-link-detector';

function target(
  kind: NavigationTargetEvidence['kind'],
  value: string,
  enforceable = true,
  allowlistAliases?: NavigationTargetEvidence['allowlistAliases'],
): NavigationTargetEvidence {
  return {
    kind,
    target: value,
    normalizedTarget: value,
    enforceable,
    origins: [],
    ...(allowlistAliases ? { allowlistAliases } : {}),
  };
}

describe.each(['standalone', 'prepared'] as const)('typed link moderation (%s)', (mode) => {
  const detectBlockedLink: typeof detectWithMatcher = (
    text,
    policy,
    allowlist,
    matcher,
    targets,
    rules,
  ) =>
    detectWithMatcher(
      text,
      policy,
      allowlist,
      matcher ?? (mode === 'prepared' ? prepareLinkAllowlist(allowlist) : undefined),
      targets,
      rules,
    );

  it('prepares independent snapshots of current allowlist entries', () => {
    const entries = ['domain:first.example'];
    const first = prepareLinkAllowlist(entries);
    entries[0] = 'domain:second.example';
    const second = prepareLinkAllowlist(entries);
    for (const [prepared, allowed, denied] of [
      [first, 'first.example', 'second.example'],
      [second, 'second.example', 'first.example'],
    ] as const) {
      expect(prepared.link(`https://${allowed}/path`)).toBe(true);
      expect(prepared.link(`https://${denied}/path`)).toBe(false);
      expect(prepared.navigation(target('external_url', `https://${allowed}/path`))).toBe(true);
      expect(prepared.navigation(target('external_url', `https://${denied}/path`))).toBe(false);
    }
  });
  it('blocks a selected exact URL while allowing the rest of its domain and supports an exact exception', () => {
    const policy = {
      version: 1,
      mode: 'DENY_SELECTED',
      rules: [
        { id: 'deny', effect: 'DENY', kind: 'WEB_DOMAIN', target: 'blocked.example' },
        { id: 'allow', effect: 'ALLOW', kind: 'WEB_EXACT', target: 'https://blocked.example/safe' },
      ],
    };
    const detect = (url: string) =>
      detectBlockedLink(
        '',
        LinkPolicy.ALLOWLIST_ONLY,
        [],
        undefined,
        [target('external_url', url)],
        policy,
      );
    expect(detect('https://other.example/page')).toBeNull();
    expect(detect('https://blocked.example/safe')).toBeNull();
    expect(detect('https://blocked.example/unsafe')).toContain('blocked by a link rule');
  });

  it('keeps malformed present policy inert and preserves null-policy legacy enforcement', () => {
    const targets = [target('external_url', 'https://blocked.example/path')];
    expect(
      detectBlockedLink('', LinkPolicy.BLOCKLIST_ONLY, [], undefined, targets, { version: 999 }),
    ).toBeNull();
    expect(
      detectBlockedLink('', LinkPolicy.BLOCKLIST_ONLY, [], undefined, targets, null),
    ).not.toBeNull();
    expect(
      detectBlockedLink(
        '',
        LinkPolicy.BLOCKLIST_ONLY,
        [],
        undefined,
        [target('external_url', 'https://blocked.example', false)],
        { version: 1, mode: 'DENY_ALL', rules: [] },
      ),
    ).toBeNull();
  });

  it.each(['https://vk.me/123456789', 'vk.me/123456789'])(
    'detects the reported VK contact link form: %s',
    (url) => {
      const text = `Требуются тестировщики. Пиши в личку\n${url}`;
      expect(detectBlockedLink(text, LinkPolicy.BLOCKLIST_ONLY, [])).not.toBeNull();
      expect(detectBlockedLink(text, LinkPolicy.ALLOWLIST_ONLY, [])).not.toBeNull();
      expect(detectBlockedLink(text, LinkPolicy.ALLOWLIST_ONLY, ['domain:vk.me'])).toBeNull();
      expect(detectBlockedLink(text, LinkPolicy.ALERT_ONLY, [])).toBeNull();
    },
  );

  it('preserves the entire exact URL in the shared stop-word and legacy matcher', () => {
    const isAllowed = createAllowlistLinkMatcher(['https://example.com/path']);
    expect(isAllowed('https://example.com/path')).toBe(true);
    expect(isAllowed('https://example.com/path%20other')).toBe(false);
    expect(isAllowed('https://example.com/path(evil)')).toBe(false);
    expect(isAllowed('https://example.com/path?x=1')).toBe(false);
    expect(
      createAllowlistLinkMatcher(['https://example.com/a%20b'])('https://example.com/a%20b'),
    ).toBe(true);
  });

  it('does not silently drop an extracted URL rejected by strict normalization', () => {
    const url = 'https://example.com@evil.test/path';
    expect(detectBlockedLink(url, LinkPolicy.ALLOWLIST_ONLY, ['domain:example.com'])).toBe(
      `Link ${url} is not in allowlist`,
    );
  });

  it.each(['https://example.com/path', 'https://a.b.example.com/path'])(
    'matches domain labels: %s',
    (url) => {
      expect(createAllowlistLinkMatcher(['domain:example.com'])(url)).toBe(true);
      expect(
        detectBlockedLink('', LinkPolicy.ALLOWLIST_ONLY, ['domain:example.com'], undefined, [
          target('external_url', url),
        ]),
      ).toBeNull();
    },
  );

  it.each(['https://example.com./path', `https://example.com/${'a'.repeat(3000)}`])(
    'keeps valid domain permissions for absolute DNS names and long paths',
    (url) => {
      expect(createAllowlistLinkMatcher(['domain:example.com'])(url)).toBe(true);
      expect(
        detectBlockedLink('', LinkPolicy.ALLOWLIST_ONLY, ['domain:example.com'], undefined, [
          target('external_url', url),
        ]),
      ).toBeNull();
    },
  );

  it.each([
    'https://notexample.com',
    'https://example.com.evil.test',
    'tg://resolve?domain=example.com',
    'https://example.com@evil.test',
  ])('does not widen domain rules: %s', (url) => {
    expect(createAllowlistLinkMatcher(['domain:example.com'])(url)).toBe(false);
    expect(
      detectBlockedLink('', LinkPolicy.ALLOWLIST_ONLY, ['domain:example.com'], undefined, [
        target('external_url', url),
      ]),
    ).not.toBeNull();
  });

  it('blocks a hidden structured URL even when visible text has no URL', () => {
    expect(
      detectBlockedLink('обычный текст', LinkPolicy.BLOCKLIST_ONLY, [], undefined, [
        target('external_url', 'https://blocked.example/path'),
      ]),
    ).toBe('Links are not allowed by policy');
  });

  it('never treats a MAX profile mention as a link-policy target', () => {
    const profile = [target('profile_mention', 'max://user/67123224')];

    expect(detectBlockedLink('', LinkPolicy.BLOCKLIST_ONLY, [], undefined, profile)).toBeNull();
    expect(detectBlockedLink('', LinkPolicy.ALLOWLIST_ONLY, [], undefined, profile)).toBeNull();
    expect(detectBlockedLink('', LinkPolicy.ALERT_ONLY, [], undefined, profile)).toBeNull();
  });

  it('supports typed MAX entity allowlist entries', () => {
    expect(
      detectBlockedLink(
        '',
        LinkPolicy.ALLOWLIST_ONLY,
        ['max-entity:url%3Ahttps%3A%2F%2Fmax.ru%2Fjoin%2Fallowed'],
        undefined,
        [target('external_url', 'https://max.ru/join/allowed')],
      ),
    ).toBeNull();
  });

  it('requires every target in allowlist-only mode to be allowed', () => {
    const result = detectBlockedLink(
      '',
      LinkPolicy.ALLOWLIST_ONLY,
      ['domain:allowed.example'],
      undefined,
      [
        target('external_url', 'https://allowed.example/a'),
        target('external_url', 'https://blocked.example/b'),
      ],
    );

    expect(result).toBe('Link https://blocked.example/b is not in allowlist');
  });

  it('fails closed for a custom-scheme target in allowlist-only mode', () => {
    expect(
      detectBlockedLink('', LinkPolicy.ALLOWLIST_ONLY, ['domain:allowed.example'], undefined, [
        target('external_url', 'tg://resolve?domain=outside'),
      ]),
    ).toBe('Link tg://resolve?domain=outside is not in allowlist');
  });

  it('allows one open-app action by either its URL or contact alias', () => {
    const openApp = target('mini_app', 'https://apps.example/start', true, [
      {
        kind: 'mini_app',
        target: 'contact_id:101',
        normalizedTarget: 'contact_id:101',
      },
    ]);

    expect(
      detectBlockedLink('', LinkPolicy.ALLOWLIST_ONLY, ['mini-app:contact-id%3A101'], undefined, [
        openApp,
      ]),
    ).toBeNull();
    expect(
      detectBlockedLink('', LinkPolicy.ALLOWLIST_ONLY, ['https://apps.example/start'], undefined, [
        openApp,
      ]),
    ).toBeNull();
  });

  it('allows an official open-app bot URL by its username identity', () => {
    const openApp = target('mini_app', 'https://max.ru/Some_Public_Bot', true, [
      {
        kind: 'mini_app',
        target: 'bot:some_public_bot',
        normalizedTarget: 'bot:some_public_bot',
      },
    ]);

    expect(
      detectBlockedLink(
        '',
        LinkPolicy.ALLOWLIST_ONLY,
        ['mini-app:bot%3Asome_public_bot'],
        undefined,
        [openApp],
      ),
    ).toBeNull();
  });

  it('does not let one contact alias allow a different button with the same URL', () => {
    const actions = ['101', '202'].map((contactId) =>
      target('mini_app', 'https://apps.example/start', true, [
        {
          kind: 'mini_app',
          target: `contact_id:${contactId}`,
          normalizedTarget: `contact_id:${contactId}`,
        },
      ]),
    );

    expect(
      detectBlockedLink(
        '',
        LinkPolicy.ALLOWLIST_ONLY,
        ['mini-app:contact-id%3A101'],
        undefined,
        actions,
      ),
    ).toBe('Link https://apps.example/start is not in allowlist');
  });

  it('keeps WEB_EXACT exact when a clickable target has a parenthesized suffix', () => {
    expect(
      detectBlockedLink(
        '',
        LinkPolicy.ALLOWLIST_ONLY,
        ['https://allowed.example/path'],
        undefined,
        [target('external_url', 'https://allowed.example/path(evil)')],
      ),
    ).toBe('Link https://allowed.example/path(evil) is not in allowlist');
  });

  it('does not enforce ambiguous shadow-only navigation', () => {
    expect(
      detectBlockedLink('', LinkPolicy.BLOCKLIST_ONLY, [], undefined, [
        target('external_url', 'https://shadow.example', false),
      ]),
    ).toBeNull();
  });

  it('does not suppress a client-verified uppercase bare link as a brand label', () => {
    expect(
      detectBlockedLink(
        'https://ura.news/news/1 Читайте на URA.RU',
        LinkPolicy.ALLOWLIST_ONLY,
        ['https://ura.news/news/1'],
        undefined,
        [
          target('external_url', 'https://ura.news/news/1'),
          target('external_url', 'https://ura.ru'),
        ],
      ),
    ).toBe('Link https://ura.ru is not in allowlist');
  });
});
