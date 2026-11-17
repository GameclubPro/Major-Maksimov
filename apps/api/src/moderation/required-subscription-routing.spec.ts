import { ConfigService } from '@nestjs/config';
import { MaxMembershipLookupService } from '../max/max-membership-lookup.service';
import type { MaxBotLinkService } from '../max/max-bot-link.service';
import { fingerprintModerationSettings } from './moderation-settings-fingerprint';
import { RequiredSubscriptionExecutionGuardService } from './required-subscription-execution-guard.service';
import type { RequiredSubscriptionNoticeAuthority } from './required-subscription-notice-authority';

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn(() => {
    const redis = {
      mget: jest.fn(async (...keys: string[]) => keys.map(() => null)),
      eval: jest.fn(async (_script: string, count: number) => Array<number>(count).fill(1)),
      quit: jest.fn(async () => 'OK'),
      duplicate: jest.fn(),
    };
    redis.duplicate.mockReturnValue(redis);
    return redis;
  }),
}));

function fixture(botScopedCacheEnabled = true) {
  const settings = {
    requiredSubscriptionEnabled: true,
    requiredSubscriptionChannelIds: ['target-1', 'target-2'],
    requiredSubscriptionWarnEnabled: true,
    requiredSubscriptionMuteEnabled: true,
    requiredSubscriptionBanEnabled: true,
    requiredSubscriptionMuteDurationHours: 1,
    nightModeTimezone: 'UTC',
    chat: { entityType: 'CHAT', admins: [] },
  };
  const at = Date.now();
  const targetBots = new Map([
    ['target-1', 'target-peer-1'],
    ['target-2', 'target-peer-2'],
  ]);
  const bots = {
    isKnownBotUserId: jest.fn(() => false),
    resolveBotRoute: jest.fn<
      ReturnType<MaxBotLinkService['resolveBotRoute']>,
      Parameters<MaxBotLinkService['resolveBotRoute']>
    >(async ({ chatId }) => ({
      purpose: 'read',
      chatId: chatId ?? null,
      primaryBotId: null,
      botId: targetBots.get(chatId ?? '') ?? null,
      candidateBotIds: targetBots.has(chatId ?? '') ? [targetBots.get(chatId!)!] : [],
      reason: 'default',
    })),
    resolveBotId: jest.fn<
      ReturnType<MaxBotLinkService['resolveBotId']>,
      Parameters<MaxBotLinkService['resolveBotId']>
    >(async () => 'default-bot'),
  };
  const max = {
    getChatMemberAccess: jest.fn(async () => ({
      userId: 'user-1',
      isAdmin: false,
      isOwner: false,
    })),
    getExactMessageRow: jest.fn(async () => ({
      sender: { user_id: 'user-1' },
      recipient: { chat_id: '-123', chat_type: 'chat' },
      timestamp: at,
      body: { mid: 'source-message', text: 'Fixture message' },
    })),
    getChatMembersAccess: jest.fn(
      async (chatId: string, _users: string[], options: { botId?: string }) => {
        if (options.botId !== targetBots.get(chatId))
          throw Object.assign(new Error('Fixture target denies source-chat bot'), {
            response: { status: 403 },
          });
        return new Map<string, unknown>();
      },
    ),
  };
  const config = new ConfigService({
    REDIS_URL: 'redis://127.0.0.1:1',
    MAX_MEMBERSHIP_LOOKUP_BATCH_WINDOW_MS: 0,
    MAX_MEMBERSHIP_LOOKUP_BOT_SCOPED_CACHE_ENABLED: botScopedCacheEnabled,
  });
  const membership = new MaxMembershipLookupService(max as never, config, bots as never);
  const prisma = { chatSettings: { findUnique: jest.fn(async () => settings) } };
  const immunity = { consumeForMessage: jest.fn(async () => 'not_granted') };
  const guard = new RequiredSubscriptionExecutionGuardService(
    prisma as never,
    max as never,
    bots as never,
    membership,
    immunity as never,
    config,
  );
  const policySha256 = fingerprintModerationSettings(settings, 'REQUIRED_SUBSCRIPTION');
  const proof: RequiredSubscriptionNoticeAuthority = {
    version: 1,
    chatId: '-123',
    userId: 'user-1',
    messageId: 'source-message',
    reasonKey: 'REQUIRED_SUBSCRIPTION:message-delete',
    sourceAtMs: at,
    deadlineAtMs: at + 300_000,
    policySha256,
  };
  const authorize = (kind: 'delete' | 'notice', beforeFinalAuthority?: () => Promise<void>) =>
    kind === 'notice'
      ? guard.assertNoticeAllowed(proof, 'source-peer', beforeFinalAuthority)
      : guard.authorize({
          chatId: proof.chatId,
          messageId: proof.messageId,
          subjectUserId: proof.userId,
          botId: 'source-peer',
          beforeFinalAuthority,
          reasons: [
            {
              ruleCode: 'REQUIRED_SUBSCRIPTION_DELETE',
              reasonKey: proof.reasonKey,
              metadata: {
                requiredSubscriptionGuardVersion: 1,
                requiredSubscriptionPolicySha256: policySha256,
                requiredSubscriptionSourceAtMs: at,
                requiredSubscriptionDeadlineAtMs: proof.deadlineAtMs,
              },
            },
          ],
        });
  return { authorize, membership, settings, max, bots, proof, immunity, targetBots };
}

describe('required subscription target routing at final authority', () => {
  it.each([true, false])(
    'keeps a refused read route unknown before cache/MAX (bot-scoped cache: %s)',
    async (botScopedCacheEnabled) => {
      const s = fixture(botScopedCacheEnabled);
      try {
        await expect(
          s.membership.getMembershipResolution(
            'target-1',
            'user-1',
            'moderation_required_subscription',
          ),
        ).resolves.toEqual({ membership: false, fresh: true });
        s.targetBots.delete('target-1');
        s.max.getChatMembersAccess.mockClear();
        s.max.getChatMembersAccess.mockResolvedValue(new Map());

        for (const forceRefresh of [false, true]) {
          await expect(
            s.membership.getMembershipResolution(
              'target-1',
              'user-1',
              'moderation_required_subscription',
              { forceRefresh },
            ),
          ).resolves.toEqual({ membership: null, fresh: false });
        }
        expect(s.bots.resolveBotId).not.toHaveBeenCalled();
        expect(s.max.getChatMembersAccess).not.toHaveBeenCalled();

        const finalRoute = jest.fn(async () => undefined);
        for (const kind of ['delete', 'notice'] as const)
          await expect(s.authorize(kind, finalRoute)).rejects.toThrow(
            'fresh membership unavailable',
          );
        expect(finalRoute).not.toHaveBeenCalled();
        expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
      } finally {
        await s.membership.onModuleDestroy();
      }
    },
  );

  it.each(['delete', 'notice'] as const)(
    'checks each target with its own route while keeping %s source authority on the selected peer',
    async (kind) => {
      const s = fixture();
      try {
        // The ordinary initial lookup already selects the target's route. Final checks must
        // retain that target binding when the source chat uses another moderation bot.
        await expect(
          s.membership.getMembershipResolution(
            'target-1',
            'user-1',
            'moderation_required_subscription',
            {
              forceRefresh: true,
              allowStaleOnError: false,
            },
          ),
        ).resolves.toEqual({ membership: false, fresh: true });
        s.max.getChatMembersAccess.mockClear();
        s.bots.resolveBotRoute.mockClear();
        const finalRoute = jest.fn(async () => undefined);

        if (kind === 'delete')
          await expect(s.authorize(kind, finalRoute)).resolves.toMatchObject({
            reasonKeys: ['REQUIRED_SUBSCRIPTION:message-delete'],
            deadlineAtMs: s.proof.deadlineAtMs,
          });
        else await expect(s.authorize(kind, finalRoute)).resolves.toBeUndefined();

        expect(s.max.getChatMemberAccess).toHaveBeenCalledWith(
          '-123',
          'user-1',
          expect.objectContaining({ botId: 'source-peer', bypassCache: true }),
        );
        expect(s.max.getExactMessageRow).toHaveBeenCalledWith(
          '-123',
          'source-message',
          expect.objectContaining({ botId: 'source-peer', bypassCache: true }),
        );
        for (const number of [1, 2]) {
          expect(s.bots.resolveBotRoute).toHaveBeenCalledWith({
            purpose: 'read',
            chatId: `target-${number}`,
          });
          expect(s.max.getChatMembersAccess).toHaveBeenCalledWith(
            `target-${number}`,
            ['user-1'],
            expect.objectContaining({
              botId: `target-peer-${number}`,
              bypassCache: true,
              sourceTag: 'required_subscription_membership',
            }),
          );
        }
        expect(s.max.getChatMembersAccess).toHaveBeenCalledTimes(2);
        expect(finalRoute).toHaveBeenCalledTimes(1);
      } finally {
        await s.membership.onModuleDestroy();
      }
    },
  );

  it.each(['delete', 'notice'] as const)(
    'keeps unknown target membership denied for %s even when another target is missing',
    async (kind) => {
      const s = fixture();
      s.max.getChatMembersAccess.mockImplementation(async (chatId) => {
        if (chatId === 'target-2') throw new Error('Fixture membership transport unavailable');
        return new Map();
      });
      const finalRoute = jest.fn(async () => undefined);
      try {
        await expect(s.authorize(kind, finalRoute)).rejects.toThrow('fresh membership unavailable');
        expect(finalRoute).not.toHaveBeenCalled();
        expect(s.immunity.consumeForMessage).not.toHaveBeenCalled();
      } finally {
        await s.membership.onModuleDestroy();
      }
    },
  );
});
