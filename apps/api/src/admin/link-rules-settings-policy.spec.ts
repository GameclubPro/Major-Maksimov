import { ConflictException } from '@nestjs/common';
import {
  chatSettingsSchema,
  normalizeStoredNavigationAllowlistEntry,
} from '@maxim/contracts/settings';
import {
  buildLegacyLinkRulesPolicy,
  inactiveLinkRulesPolicy,
  linkRulesStorageStatus,
  resolveLinkRulesSettingsWrite,
} from './link-rules-settings-policy';
import { sanitizeStoredChatSettings } from './admin-chat-settings';
import { buildSettingsSectionPatch } from './admin-settings-section-patch';
import { networkSettingsPaths } from './network-settings-patch';

const selected = { version: 1 as const, mode: 'DENY_SELECTED' as const, rules: [] };
const revision = '2026-11-07T10:00:00.000Z';

describe('link rules settings ownership', () => {
  it('preserves the meaning of every legacy mode, including block-all', () => {
    expect(buildLegacyLinkRulesPolicy('BLOCKLIST_ONLY', [])?.mode).toBe('DENY_ALL');
    expect(buildLegacyLinkRulesPolicy('ALLOWLIST_ONLY', [])?.mode).toBe('ALLOW_SELECTED');
    expect(buildLegacyLinkRulesPolicy('ALERT_ONLY', [])?.mode).toBe('ALLOW_ALL');
  });

  it('merges canonical legacy aliases with their widest active expiry and stable typed identity', () => {
    const now = Date.parse(revision);
    const early = new Date(now + 60_000);
    const late = new Date(now + 120_000);
    const app = normalizeStoredNavigationAllowlistEntry('bot:ShopBot', 'MINI_APP')!;
    const policy = buildLegacyLinkRulesPolicy(
      'ALLOWLIST_ONLY',
      [
        { domain: 'example.com/page', removeAfterAt: early },
        { domain: 'https://example.com/page', removeAfterAt: late },
        { domain: app, removeAfterAt: null },
        { domain: 'https://expired.example', removeAfterAt: new Date(now) },
      ],
      now,
    )!;
    expect(policy.rules).toHaveLength(2);
    expect(policy.rules[0]).toMatchObject({
      effect: 'ALLOW',
      kind: 'WEB_EXACT',
      target: 'https://example.com/page',
      expiresAt: late.toISOString(),
    });
    expect(policy.rules[1]).toMatchObject({
      kind: 'MINI_APP',
      target: 'bot:shopbot',
      expiresAt: null,
    });
    expect(
      buildLegacyLinkRulesPolicy('ALLOWLIST_ONLY', [{ domain: app, removeAfterAt: null }], now)
        ?.rules[0]?.id,
    ).toBe(policy.rules[1]?.id);
    expect(
      buildLegacyLinkRulesPolicy(
        'ALLOWLIST_ONLY',
        [
          { domain: 'https://example.com/page', removeAfterAt: null },
          { domain: 'example.com/page', removeAfterAt: late },
        ],
        now,
      )?.rules[0]?.expiresAt,
    ).toBeNull();
  });

  it('refuses unrepresentable or oversized legacy lists instead of truncating them', () => {
    expect(
      buildLegacyLinkRulesPolicy('ALLOWLIST_ONLY', [
        { domain: 'invalid value', removeAfterAt: null },
      ]),
    ).toBeNull();
    expect(
      buildLegacyLinkRulesPolicy(
        'ALLOWLIST_ONLY',
        Array.from({ length: 301 }, (_, index) => ({
          domain: `https://example.com/${index}`,
          removeAfterAt: null,
        })),
      ),
    ).toBeNull();
  });

  it('returns an inert honest copy of malformed storage without mutating it', () => {
    const raw = {
      linkPolicy: 'BLOCKLIST_ONLY',
      linkRulesPolicy: { version: 999 },
      slowModeEnabled: true,
    };
    const original = structuredClone(raw);
    const settings = chatSettingsSchema.parse(sanitizeStoredChatSettings(raw));
    expect(settings.linkRulesPolicy).toEqual(inactiveLinkRulesPolicy());
    expect(settings.linkRulesStorageStatus).toBe('invalid');
    expect(settings.linkPolicy).toBe('ALERT_ONLY');
    expect(settings.slowModeEnabled).toBe(true);
    expect(raw).toEqual(original);
    expect(linkRulesStorageStatus(null)).toBe('legacy');
    expect(linkRulesStorageStatus(selected)).toBe('valid');
  });

  it('requires a witnessed first adoption but allows an explicitly authored network replacement', () => {
    const requested = chatSettingsSchema.parse({ linkRulesPolicy: selected });
    expect(() =>
      resolveLinkRulesSettingsWrite({
        current: null,
        requested,
        authored: true,
        networkReplacement: false,
      }),
    ).toThrow(ConflictException);
    const resolved = resolveLinkRulesSettingsWrite({
      current: null,
      requested: {
        ...requested,
        linkRulesLegacySnapshot: { revision: '0', policy: inactiveLinkRulesPolicy() },
      },
      authored: true,
      networkReplacement: false,
    });
    expect(resolved).toMatchObject({
      initialAdoption: true,
      writePolicy: true,
      linkPolicy: 'ALLOWLIST_ONLY',
    });
    expect(
      resolveLinkRulesSettingsWrite({
        current: null,
        requested,
        authored: true,
        networkReplacement: true,
      }).initialAdoption,
    ).toBe(false);
  });

  it('preserves an adopted policy and its mode through old clients, omission and rejected null clears', () => {
    const current = { linkPolicy: 'ALLOWLIST_ONLY' as const, linkRulesPolicy: selected };
    expect(
      resolveLinkRulesSettingsWrite({
        current,
        requested: chatSettingsSchema.parse({ linkPolicy: 'BLOCKLIST_ONLY' }),
        authored: false,
        networkReplacement: false,
      }),
    ).toMatchObject({ policy: selected, writePolicy: false, linkPolicy: 'ALLOWLIST_ONLY' });
    expect(() =>
      resolveLinkRulesSettingsWrite({
        current,
        requested: chatSettingsSchema.parse({ linkRulesPolicy: null }),
        authored: true,
        networkReplacement: false,
      }),
    ).toThrow(ConflictException);
  });

  it('never treats an echoed invalid-storage copy as explicit replacement', () => {
    const current = { linkPolicy: 'BLOCKLIST_ONLY' as const, linkRulesPolicy: { version: 999 } };
    const requested = chatSettingsSchema.parse({ linkRulesPolicy: inactiveLinkRulesPolicy() });
    expect(
      resolveLinkRulesSettingsWrite({
        current,
        requested,
        authored: true,
        networkReplacement: false,
      }),
    ).toMatchObject({ writePolicy: false, status: 'invalid', preserveLegacyShadow: true });
    expect(() =>
      resolveLinkRulesSettingsWrite({
        current,
        requested: { ...requested, linkRulesPolicy: selected },
        authored: true,
        networkReplacement: false,
      }),
    ).toThrow(ConflictException);
    expect(
      resolveLinkRulesSettingsWrite({
        current,
        requested: {
          ...requested,
          linkRulesPolicy: selected,
          linkRulesReplaceInvalidStorage: true,
        },
        authored: true,
        networkReplacement: false,
      }),
    ).toMatchObject({ writePolicy: true, status: 'valid', initialAdoption: false });
  });

  it('keeps section ownership and ephemeral metadata outside network field paths', () => {
    const current = chatSettingsSchema.parse({
      settingsRevision: revision,
      linkRulesPolicy: selected,
    });
    const patched = buildSettingsSectionPatch(current, {
      section: 'links',
      expectedRevision: revision,
      changes: { linkWarnEnabled: true },
    });
    expect(patched.linkRulesPolicy).toBeUndefined();
    const adopted = buildSettingsSectionPatch(current, {
      section: 'links',
      expectedRevision: revision,
      changes: {
        linkRulesPolicy: selected,
        linkRulesLegacySnapshot: { revision: '0', policy: selected },
      },
    });
    expect(adopted.linkRulesPolicy).toEqual(selected);
    const paths = networkSettingsPaths('chat', 'links');
    expect(paths).toContain('linkRulesPolicy');
    expect(paths).not.toContain('linkRulesLegacySnapshot');
    expect(paths).not.toContain('linkRulesReplaceInvalidStorage');
    expect(paths).not.toContain('linkRulesStorageStatus');
  });
});
