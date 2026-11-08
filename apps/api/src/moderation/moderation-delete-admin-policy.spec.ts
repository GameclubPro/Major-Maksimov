import type { MaxChatAdminRosterSyncService } from '../max/max-chat-admin-roster-sync.service';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { ChatSettings } from '../prisma/prisma-client';
import { ModerationAccessService } from './moderation-access.service';
import { ModerationService } from './moderation.service';

const roster = {
  revision: 'saved-roster',
  completedAt: '2026-11-08T00:00:00Z',
  completeProbeStartedAt: '2026-11-07T23:59:59Z',
};

describe('saved administrator policy at automatic DELETE admission', () => {
  function fixture() {
    const observeActivity = jest
      .fn<
        ReturnType<MaxChatAdminRosterSyncService['observeActivity']>,
        Parameters<MaxChatAdminRosterSyncService['observeActivity']>
      >()
      .mockResolvedValue(undefined);
    const service = new ModerationAccessService(
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      { observeActivity } as unknown as MaxChatAdminRosterSyncService,
    );
    const lookup = jest.spyOn(service, 'getRemoteChatAdminAccess').mockResolvedValue('user_denied');
    return { service, lookup, observeActivity };
  }

  it.each([roster, null])(
    'carries roster completeness through the real moderation context loader: %j',
    async (snapshot) => {
      const s = fixture();
      const cache = {
        getChatContext: jest
          .fn<
            ReturnType<ChatContextCacheService['getChatContext']>,
            Parameters<ChatContextCacheService['getChatContext']>
          >()
          .mockResolvedValue({
            chatId: 'chat',
            title: 'Chat',
            settings: {} as ChatSettings,
            domainAllowlist: [],
            adminUserIds: [],
            adminRoster: snapshot,
            rulesPublishedUrl: null,
            rulesPublishedMessageId: null,
          }),
      } satisfies Pick<ChatContextCacheService, 'getChatContext'>;
      const runtime = new ModerationService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        cache as unknown as ChatContextCacheService,
      ) as unknown as { loadChatContext: ModerationService['loadChatContext'] };
      const context = await runtime.loadChatContext('chat');
      const check = await s.service.resolveSenderChatAdminCheck(
        'chat',
        context.adminUserIds,
        '123',
        {
          automaticDelete: { roster: context.adminRoster },
        },
      );
      expect(check).toEqual({ isAdmin: false, source: snapshot ? 'persisted_roster' : 'remote' });
      expect(s.lookup).toHaveBeenCalledTimes(snapshot ? 0 : 1);
    },
  );

  it('protects the saved admin despite an old shared member denial', async () => {
    const s = fixture();
    await expect(
      s.service.resolveSenderChatAdminCheck('chat', ['id123'], '123', {
        automaticDelete: { roster, botId: 'major' },
        prefetchRemoteLookupWhenLocalAdminsKnown: true,
      }),
    ).resolves.toEqual({ isAdmin: true, source: 'persisted_roster' });
    expect(s.lookup).not.toHaveBeenCalled();
    expect(s.observeActivity).toHaveBeenCalledWith('chat', 'major', roster.completedAt);
  });

  it('makes complete-roster eligibility final for the admission recheck without MAX', async () => {
    const s = fixture();
    const result = await s.service.resolveSenderChatAdminCheck('chat', ['admin'], '123', {
      automaticDelete: { roster },
    });
    expect(result).toEqual({ isAdmin: false, source: 'persisted_roster' });
    expect(
      await s.service.recheckSenderChatAdminBeforeModeration('chat', ['admin'], '123', result),
    ).toEqual(result);
    expect(s.lookup).not.toHaveBeenCalled();
  });

  it('retains the original authority for strict consumers without the DELETE purpose', async () => {
    const s = fixture();
    await expect(s.service.resolveSenderChatAdminCheck('chat', ['123'], '123')).resolves.toEqual({
      isAdmin: false,
      source: 'remote',
    });
    expect(s.lookup).toHaveBeenCalled();
    expect(s.observeActivity).not.toHaveBeenCalled();
  });

  it('refreshes an active chat while retaining strict admission for shared penalty modules', async () => {
    const s = fixture();
    await expect(
      s.service.resolveSenderChatAdminCheck('chat', [], '123', {
        automaticDelete: { roster, useSavedProtection: false },
      }),
    ).resolves.toEqual({ isAdmin: false, source: 'remote' });
    expect(s.lookup).toHaveBeenCalled();
    expect(s.observeActivity).toHaveBeenCalledTimes(1);
  });

  it('keeps legacy fallback while a targeted-only or missing roster bootstraps', async () => {
    const s = fixture();
    await expect(
      s.service.resolveSenderChatAdminCheck('chat', [], '123', {
        automaticDelete: { roster: { ...roster, completedAt: null } },
      }),
    ).resolves.toEqual({ isAdmin: false, source: 'remote' });
    expect(s.lookup).toHaveBeenCalled();
    expect(s.observeActivity).toHaveBeenCalledTimes(1);
  });
});
