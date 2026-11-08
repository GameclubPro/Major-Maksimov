import { MaxClientService, type MaxChatMemberAccess } from '../max/max-client.service';
import { ModerationAccessService } from './moderation-access.service';
import { RedisCounterService } from './redis-counter.service';
import {
  GLOBAL_SPAMMER_CONFIRMED_FANOUT_EPISODE_THRESHOLD,
  GLOBAL_SPAMMER_HIGH_FANOUT_MIN_CHATS,
  ModerationService,
} from './moderation.service.spec-support';

const tracking = {
  chatId: 'chat-fanout-authority',
  userId: 'user-fanout-authority',
  messageId: 'message-fanout-authority',
  text: 'fanout observation',
  createdAt: '2026-11-08T00:00:00.000Z',
  deleteSpammersEnabled: true,
  exemptFromEnforcement: false,
};

const regularMember: MaxChatMemberAccess = {
  userId: tracking.userId,
  isAdmin: false,
  isOwner: false,
  isBot: false,
  explicitNonPrivilegeEvidence: true,
  permissions: [],
};

function createHarness(uniqueChatCount = GLOBAL_SPAMMER_HIGH_FANOUT_MIN_CHATS) {
  const memberRead = jest
    .fn<
      ReturnType<MaxClientService['getChatMemberAccess']>,
      Parameters<MaxClientService['getChatMemberAccess']>
    >()
    .mockResolvedValue(regularMember);
  const maxClient = { getChatMemberAccess: memberRead } satisfies Pick<
    MaxClientService,
    'getChatMemberAccess'
  >;
  const redis = {
    addToSetWithTtl: jest
      .fn<
        ReturnType<RedisCounterService['addToSetWithTtl']>,
        Parameters<RedisCounterService['addToSetWithTtl']>
      >()
      .mockResolvedValueOnce({ added: true, size: uniqueChatCount })
      .mockResolvedValueOnce({ added: true, size: 1 }),
    incrementWithTtl: jest
      .fn<
        ReturnType<RedisCounterService['incrementWithTtl']>,
        Parameters<RedisCounterService['incrementWithTtl']>
      >()
      .mockResolvedValue(GLOBAL_SPAMMER_CONFIRMED_FANOUT_EPISODE_THRESHOLD),
  } satisfies Pick<RedisCounterService, 'addToSetWithTtl' | 'incrementWithTtl'>;
  const prisma = { globalSpammer: { upsert: jest.fn().mockResolvedValue({}) } };
  const access = new ModerationAccessService(prisma as never, maxClient as never);
  const service = new ModerationService(
    prisma as never,
    {} as never,
    {} as never,
    maxClient as never,
    undefined,
    undefined,
    undefined,
    redis as never,
  );
  const internal = service as any;
  jest.spyOn(internal.logger, 'warn').mockImplementation(() => undefined);
  jest.spyOn(internal, 'isUserKnownGlobalSpammer').mockResolvedValue(true);
  const enforcement = jest
    .spyOn(internal, 'deleteAndKickDetectedGlobalSpammer')
    .mockResolvedValue(false);
  const notice = jest
    .spyOn(internal, 'sendBotMessageWithOptionalAutoDelete')
    .mockResolvedValue(undefined);
  const authorizePenalty = () =>
    access.confirmRegularMemberBeforePenalty(tracking.chatId, tracking.userId, {
      botId: 'selected-execution-bot',
    });
  return { internal, access, memberRead, redis, prisma, enforcement, notice, authorizePenalty };
}

describe('saved-roster fanout penalty qualification', () => {
  it.each<[string, MaxChatMemberAccess | null]>([
    ['newly promoted administrator', { ...regularMember, isAdmin: true }],
    ['owner', { ...regularMember, isOwner: true }],
    ['bot', { ...regularMember, isBot: true }],
    ['unknown human status', { ...regularMember, isBot: undefined }],
    [
      'missing explicit role evidence',
      { ...regularMember, explicitNonPrivilegeEvidence: undefined },
    ],
    ['unproven regular role', { ...regularMember, explicitNonPrivilegeEvidence: false }],
    ['different actor', { ...regularMember, userId: 'another-user' }],
    ['missing actor identity', { ...regularMember, userId: null }],
    ['absent membership', null],
  ])('does not create an episode or reputation for %s', async (_label, member) => {
    const h = createHarness();
    h.memberRead.mockResolvedValue(member);

    await expect(
      h.internal.trackAndRegisterGlobalSpammerWithHotPathBudget({
        ...tracking,
        authorizePenalty: h.authorizePenalty,
      }),
    ).resolves.toEqual({ handled: false, skipKnownSpammerCheck: false });

    expect(h.memberRead).toHaveBeenCalledWith(
      tracking.chatId,
      tracking.userId,
      expect.objectContaining({
        botId: 'selected-execution-bot',
        bypassCache: true,
        sourceTag: 'moderation.fanout.penalty.author',
      }),
    );
    expect(h.redis.addToSetWithTtl).toHaveBeenCalledTimes(1);
    expect(h.redis.incrementWithTtl).not.toHaveBeenCalled();
    expect(h.prisma.globalSpammer.upsert).not.toHaveBeenCalled();
    expect(h.enforcement).not.toHaveBeenCalled();
    expect(h.notice).not.toHaveBeenCalled();
  });

  it('keeps uncertain access out of episode and reputation writes', async () => {
    const h = createHarness();
    h.memberRead.mockRejectedValue(new Error('MAX access unavailable'));

    await expect(
      h.internal.trackAndRegisterGlobalSpammerWithHotPathBudget({
        ...tracking,
        authorizePenalty: h.authorizePenalty,
      }),
    ).resolves.toEqual({ handled: false, skipKnownSpammerCheck: false });

    expect(h.redis.addToSetWithTtl).toHaveBeenCalledTimes(1);
    expect(h.redis.incrementWithTtl).not.toHaveBeenCalled();
    expect(h.prisma.globalSpammer.upsert).not.toHaveBeenCalled();
    expect(h.enforcement).not.toHaveBeenCalled();
    expect(h.notice).not.toHaveBeenCalled();
  });

  it('performs no member lookup while the raw observation is below threshold', async () => {
    const h = createHarness(GLOBAL_SPAMMER_HIGH_FANOUT_MIN_CHATS - 1);

    await expect(
      h.internal.trackAndRegisterGlobalSpammerWithHotPathBudget({
        ...tracking,
        authorizePenalty: h.authorizePenalty,
      }),
    ).resolves.toEqual({ handled: false, skipKnownSpammerCheck: false });

    expect(h.memberRead).not.toHaveBeenCalled();
    expect(h.redis.addToSetWithTtl).toHaveBeenCalledTimes(1);
    expect(h.redis.incrementWithTtl).not.toHaveBeenCalled();
    expect(h.prisma.globalSpammer.upsert).not.toHaveBeenCalled();
    expect(h.enforcement).not.toHaveBeenCalled();
  });

  it('qualifies a regular human before episode, reputation and enforcement handoff', async () => {
    const h = createHarness();

    await expect(
      h.internal.trackAndRegisterGlobalSpammerWithHotPathBudget({
        ...tracking,
        authorizePenalty: h.authorizePenalty,
      }),
    ).resolves.toEqual({ handled: false, skipKnownSpammerCheck: true });

    expect(h.memberRead).toHaveBeenCalledTimes(1);
    expect(h.redis.addToSetWithTtl).toHaveBeenCalledTimes(2);
    expect(h.redis.incrementWithTtl).toHaveBeenCalledTimes(1);
    expect(h.prisma.globalSpammer.upsert).toHaveBeenCalledTimes(1);
    expect(h.enforcement).toHaveBeenCalledTimes(1);
    expect(h.memberRead.mock.invocationCallOrder[0]).toBeLessThan(
      h.redis.addToSetWithTtl.mock.invocationCallOrder[1],
    );
    expect(h.redis.incrementWithTtl.mock.invocationCallOrder[0]).toBeLessThan(
      h.prisma.globalSpammer.upsert.mock.invocationCallOrder[0],
    );
    expect(h.prisma.globalSpammer.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      h.enforcement.mock.invocationCallOrder[0],
    );
  });

  it('preserves the existing already-qualified path without another member lookup', async () => {
    const h = createHarness();

    await expect(
      h.internal.trackAndRegisterGlobalSpammerWithHotPathBudget(tracking),
    ).resolves.toEqual({ handled: false, skipKnownSpammerCheck: true });

    expect(h.memberRead).not.toHaveBeenCalled();
    expect(h.redis.incrementWithTtl).toHaveBeenCalledTimes(1);
    expect(h.prisma.globalSpammer.upsert).toHaveBeenCalledTimes(1);
    expect(h.enforcement).toHaveBeenCalledTimes(1);
  });

  it('denies a penalty without a verified bot route', async () => {
    const h = createHarness();

    await expect(
      h.access.confirmRegularMemberBeforePenalty(tracking.chatId, tracking.userId),
    ).resolves.toBe(false);

    expect(h.memberRead).not.toHaveBeenCalled();
  });
});
