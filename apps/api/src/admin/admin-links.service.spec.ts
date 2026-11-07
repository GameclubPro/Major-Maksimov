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
  return {
    service: new AdminLinksService(admin as ManagedEntitiesService, new ConfigService(config)),
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
