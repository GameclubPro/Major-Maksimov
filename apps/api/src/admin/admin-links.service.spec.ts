import type { MaxClientService } from '../max/max-client.service';
import {
  PUBLIC_HANDLE_CHANNEL,
  createHandleLookupMock,
} from '../moderation/navigation/max-handle-navigation.fixture';
import { ConfigService } from '@nestjs/config';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import type { ManagedEntitiesService } from './managed-entities.service';
import { AdminLinksService } from './admin-links.service';
import { linkRulesPolicySchema } from '@maxim/contracts/settings';

function harness(config: Record<string, unknown> = {}) {
  const assertChatAdminAccess = jest
    .fn<
      ReturnType<ManagedEntitiesService['assertChatAdminAccess']>,
      Parameters<ManagedEntitiesService['assertChatAdminAccess']>
    >()
    .mockResolvedValue(undefined);
  const admin = { assertChatAdminAccess } as Pick<ManagedEntitiesService, 'assertChatAdminAccess'>;
  const handleLookup = createHandleLookupMock();
  return {
    handleLookup,
    service: new AdminLinksService(admin as ManagedEntitiesService, new ConfigService(config), {
      resolvePublicChannelHandle: handleLookup,
    } as unknown as MaxClientService),
    assertChatAdminAccess,
    user: { userId: 'admin-1' } as AuthUser,
  };
}

const exactPolicy = () =>
  linkRulesPolicySchema.parse({
    version: 1,
    mode: 'DENY_SELECTED',
    rules: [
      {
        id: 'blocked-page',
        effect: 'DENY',
        kind: 'WEB_EXACT',
        target: 'https://example.com/ad?a=1#offer',
      },
    ],
  });

describe('AdminLinksService preview', () => {
  it('uses confirmed channel identity in preview and retains exact exceptions', async () => {
    const h = harness();
    h.handleLookup.mockResolvedValue(PUBLIC_HANDLE_CHANNEL);
    const policy = linkRulesPolicySchema.parse({ version: 1, mode: 'ALLOW_SELECTED', rules: [] });
    const body = { policy, text: '@azov_overhear' };
    await expect(h.service.preview('chat-1', h.user, body)).resolves.toMatchObject({
      allowed: false,
      targetsCount: 1,
    });
    const allowed = linkRulesPolicySchema.parse({
      ...policy,
      rules: [
        { id: 'channel', effect: 'ALLOW', kind: 'WEB_EXACT', target: PUBLIC_HANDLE_CHANNEL.url },
      ],
    });
    await expect(
      h.service.preview('chat-1', h.user, { ...body, policy: allowed }),
    ).resolves.toMatchObject({ allowed: true, targetsCount: 1 });
  });

  it('requires exact chat admin access before validating the submitted text', async () => {
    const h = harness();
    h.assertChatAdminAccess.mockRejectedValue(new Error('denied'));
    await expect(h.service.preview('chat-1', h.user, {})).rejects.toThrow('denied');
    expect(h.assertChatAdminAccess).toHaveBeenCalledWith('chat-1', h.user);
  });

  it('blocks only the complete selected URL and preserves query and fragment', async () => {
    const h = harness();
    const policy = exactPolicy();
    await expect(
      h.service.preview('chat-1', h.user, {
        policy,
        text: 'Объявление https://example.com/ad?a=1#offer',
      }),
    ).resolves.toMatchObject({
      allowed: false,
      reason: 'DENY_RULE',
      ruleId: 'blocked-page',
      targetsCount: 1,
    });
    await expect(
      h.service.preview('chat-1', h.user, {
        policy,
        text: 'Помощь https://example.com/help и https://example.com/ad?a=2#offer',
      }),
    ).resolves.toMatchObject({ allowed: true, targetsCount: 2 });
  });

  it.each([
    [
      'Google',
      (destination: string) =>
        `https://www.google.com/url?sa=t&source=web&rct=j&opi=89978449&url=${destination}&ved=2ahUKEwiZn-TrjJKYAxU9FBAIHdK0PRwQFnoECBIQAQ&sqi=2&usg=AOvVaw3UH6IVlWT3gwuvSBbKHOQ_`,
    ],
    [
      'DuckDuckGo',
      (destination: string) =>
        `https://duckduckgo.com/l/?uddg=${encodeURIComponent(destination)}&rut=${'f'.repeat(64)}`,
    ],
    [
      'Bing',
      (destination: string) =>
        `https://www.bing.com/ck/a?!&&p=${'e'.repeat(64)}&ptn=3&ver=2&hsh=4&fclid=351aab7f-37aa-6faa-1250-bad236596e68&psq=shop&u=a1${Buffer.from(destination).toString('base64url')}&ntb=1`,
    ],
    [
      'Yahoo',
      (destination: string) =>
        `https://r.search.yahoo.com/_ylt=example;_ylu=example/RV=2/RE=1234567890/RO=10/RU=${encodeURIComponent(destination)}/RK=2/RS=example`,
    ],
  ] as const)(
    'applies the chat allowlist to the destination of a %s search result',
    async (_engine, wrap) => {
      const h = harness();
      const allowed = wrap('https://www.wildberries.ru/');
      const unlisted = wrap('https://elsewhere.test/');
      const policy = linkRulesPolicySchema.parse({
        version: 1,
        mode: 'ALLOW_SELECTED',
        rules: [
          { id: 'shop', effect: 'ALLOW', kind: 'WEB_DOMAIN', target: 'www.wildberries.ru' },
          { id: 'search', effect: 'ALLOW', kind: 'WEB_DOMAIN', target: new URL(unlisted).hostname },
        ],
      });
      await expect(h.service.preview('chat-1', h.user, { policy, text: allowed })).resolves.toEqual(
        { allowed: true, reason: 'ALL_TARGETS_ALLOWED', targetsCount: 1 },
      );
      await expect(
        h.service.preview('chat-1', h.user, { policy, text: unlisted }),
      ).resolves.toEqual({
        allowed: false,
        reason: 'NOT_ALLOWED',
        target: unlisted,
        targetsCount: 1,
      });
      expect(h.handleLookup).not.toHaveBeenCalled();
    },
  );

  it('requires every link to pass even when one exact exception is allowed', async () => {
    const h = harness();
    const policy = linkRulesPolicySchema.parse({
      version: 1,
      mode: 'DENY_SELECTED',
      rules: [
        { id: 'site', effect: 'DENY', kind: 'WEB_DOMAIN', target: 'example.com' },
        { id: 'help', effect: 'ALLOW', kind: 'WEB_EXACT', target: 'https://example.com/help' },
      ],
    });
    await expect(
      h.service.preview('chat-1', h.user, { policy, text: 'https://example.com/help' }),
    ).resolves.toMatchObject({ allowed: true, targetsCount: 1 });
    await expect(
      h.service.preview('chat-1', h.user, {
        policy,
        text: 'https://example.com/help https://shop.example.com/ad',
      }),
    ).resolves.toMatchObject({ allowed: false, ruleId: 'site', targetsCount: 2 });
  });

  it('uses runtime clickability settings for bare addresses', async () => {
    const enabled = harness();
    const disabled = harness({ MODERATION_LINK_TEXT_CLICKABILITY_ENABLED: false });
    const body = {
      policy: linkRulesPolicySchema.parse({ version: 1, mode: 'DENY_ALL', rules: [] }),
      text: 'example.com',
    };
    await expect(enabled.service.preview('chat-1', enabled.user, body)).resolves.toMatchObject({
      allowed: false,
      targetsCount: 1,
    });
    await expect(disabled.service.preview('chat-1', disabled.user, body)).resolves.toMatchObject({
      allowed: true,
      reason: 'NO_ENFORCEABLE_TARGETS',
      targetsCount: 0,
    });
  });

  it('refuses oversized text and ambiguous duplicate rules without any moderation effect', async () => {
    const h = harness();
    await expect(
      h.service.preview('chat-1', h.user, { policy: exactPolicy(), text: 'x'.repeat(10_001) }),
    ).rejects.toMatchObject({ status: 400 });
    const policy = exactPolicy();
    await expect(
      h.service.preview('chat-1', h.user, {
        policy: {
          ...policy,
          rules: [...policy.rules, { ...policy.rules[0], id: 'other', effect: 'ALLOW' }],
        },
        text: 'https://example.com',
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
