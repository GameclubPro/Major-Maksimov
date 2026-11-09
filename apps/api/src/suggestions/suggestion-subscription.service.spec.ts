import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import {
  SuggestionDeletionCancelledError,
  SuggestionSubscriptionService,
} from './suggestion-subscription.service';

function fixture() {
  const settings = {
    postSuggestionsRequireSubscription: false,
    postSuggestionsDeleteOnUnsubscribe: true,
  };
  const publisherSettings = {
    channelSuggestionsRequireSubscription: true,
    channelSuggestionsDeleteOnUnsubscribe: true,
  };
  const watch = {
    id: 'watch',
    chatId: '-1',
    authorUserId: 'user',
    botId: 'major',
    profile: 'moderation',
    revision: 1,
    missingSince: new Date(Date.now() - 60_000),
    checkedAt: new Date(),
  };
  const post = { id: 'post', watchId: watch.id, messageId: 'mid', deletedAt: null, watch };
  const prisma = {
    channelSettings: { findUnique: jest.fn(async () => settings) },
    publisherEntitySettings: { findUnique: jest.fn(async () => publisherSettings) },
    suggestionSubscriptionPublication: { findUnique: jest.fn(async () => post), upsert: jest.fn() },
    suggestionSubscriptionWatch: {
      updateMany: jest.fn(async () => ({ count: 1 })),
      upsert: jest.fn(),
    },
  };
  const max = { getChatMembersAccess: jest.fn(async () => new Map([['user', {}]])) };
  const bots = {
    getPublisherBotDescriptor: () => ({ id: 'publik' }),
    getBotById: jest.fn(() => null),
  };
  const links = { resolveBotRoute: jest.fn(async () => ({ botId: 'major' })) };
  const queue = { checkSubscription: jest.fn(async () => true) };
  const service = new SuggestionSubscriptionService(
    prisma as never,
    max as never,
    bots as never,
    links as never,
    queue as never,
  );
  return { service, prisma, max, bots, links, queue, settings, publisherSettings, watch, post };
}

describe('suggestion subscription admission', () => {
  it('does no MAX work when the requirement is off', async () => {
    const f = fixture();
    await f.service.assertCanSubmit('-1', 'user', 'moderation');
    expect(f.links.resolveBotRoute).not.toHaveBeenCalled();
    expect(f.max.getChatMembersAccess).not.toHaveBeenCalled();
  });

  it('uses a targeted fresh check and the resolved Major bot', async () => {
    const f = fixture();
    f.settings.postSuggestionsRequireSubscription = true;
    await f.service.assertCanSubmit('-1', 'user', 'moderation');
    expect(f.max.getChatMembersAccess).toHaveBeenCalledWith(
      '-1',
      ['user'],
      expect.objectContaining({ botId: 'major', bypassCache: true, trafficClass: 'interactive' }),
    );
  });

  it('rejects a confirmed non-subscriber without consuming a submission', async () => {
    const f = fixture();
    f.settings.postSuggestionsRequireSubscription = true;
    f.max.getChatMembersAccess.mockResolvedValue(new Map());
    await expect(f.service.assertCanSubmit('-1', 'user', 'moderation')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(f.prisma.suggestionSubscriptionPublication.upsert).not.toHaveBeenCalled();
  });

  it.each([403, 404, 429, 500])('treats MAX %s as unknown, never as absence', async (status) => {
    const f = fixture();
    f.settings.postSuggestionsRequireSubscription = true;
    f.max.getChatMembersAccess.mockRejectedValue({ response: { status } });
    await expect(f.service.assertCanSubmit('-1', 'user', 'moderation')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('keeps Publisher verification on its exact-token worker', async () => {
    const f = fixture();
    await f.service.assertCanSubmit('-1', 'user', 'publisher');
    expect(f.queue.checkSubscription).toHaveBeenCalledWith('-1', 'user', 'publik');
    expect(f.max.getChatMembersAccess).not.toHaveBeenCalled();
    expect(f.links.resolveBotRoute).not.toHaveBeenCalled();
  });

  it('does not self-enqueue a membership check from the Publisher worker', async () => {
    const f = fixture();
    f.bots.getBotById.mockReturnValue({ id: 'publik' } as never);
    await f.service.assertCanSubmit('-1', 'user', 'publisher');
    expect(f.queue.checkSubscription).not.toHaveBeenCalled();
    expect(f.max.getChatMembersAccess).toHaveBeenCalledWith(
      '-1',
      ['user'],
      expect.objectContaining({ botId: 'publik' }),
    );
  });

  it.each(['queued', 'direct'] as const)(
    'returns the structured subscription refusal through the %s Publisher path',
    async (path) => {
      const f = fixture();
      if (path === 'direct') f.bots.getBotById.mockReturnValue({ id: 'publik' } as never);
      f.queue.checkSubscription.mockResolvedValue(false);
      f.max.getChatMembersAccess.mockResolvedValue(new Map());

      await expect(f.service.assertCanSubmit('-1', 'user', 'publisher')).rejects.toMatchObject({
        response: { code: 'SUGGESTION_SUBSCRIPTION_REQUIRED' },
      });

      expect(f.prisma.suggestionSubscriptionPublication.upsert).not.toHaveBeenCalled();
      expect(f.prisma.suggestionSubscriptionWatch.upsert).not.toHaveBeenCalled();
    },
  );

  it.each([403, 404, 429, 500])(
    'preserves an unknown Publisher MAX %s response as retryable verification failure',
    async (status) => {
      const f = fixture();
      f.bots.getBotById.mockReturnValue({ id: 'publik' } as never);
      f.max.getChatMembersAccess.mockRejectedValue({ response: { status } });

      await expect(f.service.assertCanSubmit('-1', 'user', 'publisher')).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(f.queue.checkSubscription).not.toHaveBeenCalled();
      expect(f.prisma.suggestionSubscriptionPublication.upsert).not.toHaveBeenCalled();
    },
  );
});

describe('suggestion subscription deletion authority', () => {
  it('requires two observations separated by the confirmation interval', async () => {
    const f = fixture();
    f.watch.missingSince = new Date();
    await expect(f.service.prepareDeletion('post', 'major')).rejects.toBeInstanceOf(
      SuggestionDeletionCancelledError,
    );
  });

  it('reuses a bounded fresh batch result without a per-post MAX call', async () => {
    const f = fixture();
    const proof = await f.service.prepareDeletion('post', 'major');
    await f.service.assertDeletionAllowed(proof);
    expect(f.max.getChatMembersAccess).not.toHaveBeenCalled();
  });

  it('stops already prepared deletes when the setting is turned off', async () => {
    const f = fixture();
    const proof = await f.service.prepareDeletion('post', 'major');
    f.settings.postSuggestionsDeleteOnUnsubscribe = false;
    await expect(f.service.assertDeletionAllowed(proof)).rejects.toBeInstanceOf(
      SuggestionDeletionCancelledError,
    );
  });

  it('fences an in-flight proof when a membership webhook changes the epoch', async () => {
    const f = fixture();
    const proof = await f.service.prepareDeletion('post', 'major');
    f.watch.revision++;
    await expect(f.service.assertDeletionAllowed(proof)).rejects.toBeInstanceOf(
      SuggestionDeletionCancelledError,
    );
  });

  it('refreshes stale evidence and stops deletion after resubscription', async () => {
    const f = fixture();
    f.watch.checkedAt = new Date(Date.now() - 60_000);
    await expect(f.service.prepareDeletion('post', 'major')).rejects.toBeInstanceOf(
      SuggestionDeletionCancelledError,
    );
    expect(f.prisma.suggestionSubscriptionWatch.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ missingSince: null, revision: { increment: 1 } }),
      }),
    );
  });

  it('cannot commit a negative probe over a newer membership event', async () => {
    const f = fixture();
    f.watch.checkedAt = new Date(Date.now() - 60_000);
    f.max.getChatMembersAccess.mockResolvedValue(new Map());
    f.prisma.suggestionSubscriptionWatch.updateMany.mockResolvedValue({ count: 0 });
    await expect(f.service.prepareDeletion('post', 'major')).rejects.toBeInstanceOf(
      SuggestionDeletionCancelledError,
    );
  });

  it('never adopts a post published by a different bot', async () => {
    const f = fixture();
    await expect(f.service.prepareDeletion('post', 'other')).rejects.toThrow('source unavailable');
  });

  it('invalidates only exact author watches and deduplicates mirrored users', async () => {
    const f = fixture();
    await f.service.wake('-1', ['user', 'user']);
    expect(f.prisma.suggestionSubscriptionWatch.updateMany).toHaveBeenCalledTimes(1);
    expect(f.prisma.suggestionSubscriptionWatch.updateMany).toHaveBeenCalledWith({
      where: { chatId: '-1', authorUserId: 'user' },
      data: expect.objectContaining({
        checkedAt: null,
        missingSince: null,
        revision: { increment: 1 },
      }),
    });
  });

  it('does not backfill posts when deletion was disabled at publication', async () => {
    const f = fixture();
    f.settings.postSuggestionsDeleteOnUnsubscribe = false;
    await f.service.track({
      id: 'post',
      chatId: '-1',
      authorUserId: 'user',
      profile: 'moderation',
      botId: 'major',
      messageId: 'mid',
    });
    expect(f.prisma.suggestionSubscriptionWatch.upsert).not.toHaveBeenCalled();
  });
});
