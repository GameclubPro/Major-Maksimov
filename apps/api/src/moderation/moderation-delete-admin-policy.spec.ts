import type { MaxChatAdminRosterSyncService } from '../max/max-chat-admin-roster-sync.service';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { ChatSettings } from '../prisma/prisma-client';
import { ModerationAccessService } from './moderation-access.service';
import { ModerationService } from './moderation.service';
import type { MessageDuplicateService } from './message-duplicate/message-duplicate.service';
import type { ModerationRuleSanctionGuardService } from './moderation-rule-sanction-guard.service';
import { createLiveNavigationHarness, createUpdate } from './moderation.service.spec-support';

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

describe('saved administrator admission through the main handler', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    { authoritative: true, sanctionGuard: true, expectsLookup: false },
    { authoritative: false, sanctionGuard: true, expectsLookup: true },
    { authoritative: true, sanctionGuard: false, expectsLookup: true },
  ])('preserves the independent authority boundary: %j', async (policy) => {
    const h = createLiveNavigationHarness();
    const runtime = h.service as unknown as {
      loadChatContext: ModerationService['loadChatContext'];
    };
    const context = await runtime.loadChatContext('chat-1');
    jest.spyOn(runtime, 'loadChatContext').mockResolvedValue({
      ...context,
      settings: {
        ...context.settings,
        antiSpamEnabled: false,
        antiDuplicateEnabled: true,
        invitationAccessEnabled: true,
        deleteSpammersEnabled: false,
        commercialAdsFilterEnabled: false,
        russianProfanityFilterEnabled: false,
      },
      adminUserIds: [],
      adminRoster: roster,
      domainAllowlist: [],
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
    });
    const duplicates = {
      isAuthoritative: jest
        .fn<
          ReturnType<MessageDuplicateService['isAuthoritative']>,
          Parameters<MessageDuplicateService['isAuthoritative']>
        >()
        .mockResolvedValue(policy.authoritative),
      observe: jest
        .fn<
          ReturnType<MessageDuplicateService['observe']>,
          Parameters<MessageDuplicateService['observe']>
        >()
        .mockResolvedValue(undefined),
    } satisfies Pick<MessageDuplicateService, 'isAuthoritative' | 'observe'>;
    const guard = {
      assertAllowed: jest
        .fn<
          ReturnType<ModerationRuleSanctionGuardService['assertAllowed']>,
          Parameters<ModerationRuleSanctionGuardService['assertAllowed']>
        >()
        .mockResolvedValue(undefined),
    } satisfies Pick<ModerationRuleSanctionGuardService, 'assertAllowed'>;
    Object.assign(h.service, {
      messageDuplicateService: duplicates,
      moderationRuleSanctionGuard: policy.sanctionGuard ? guard : undefined,
    });
    const access = (h.service as unknown as { moderationAccessService: ModerationAccessService })
      .moderationAccessService;
    const lookup = jest.spyOn(access, 'getRemoteChatAdminAccess').mockResolvedValue('user_denied');
    h.detectSpy.mockResolvedValue({ violations: [] });

    await h.service.handleUpdate({ ...createUpdate(), botId: 'selected-bot' });

    expect(lookup.mock.calls.length > 0).toBe(policy.expectsLookup);
    expect(duplicates.isAuthoritative).toHaveBeenCalledTimes(1);
    expect(h.detectSpy).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicateState: policy.authoritative }),
    );
    expect(guard.assertAllowed).not.toHaveBeenCalled();
    expect(h.prisma.violation.create).not.toHaveBeenCalled();
    expect(h.maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(h.maxClient.banMember).not.toHaveBeenCalled();
    expect(h.maxClient.sendMessage).not.toHaveBeenCalled();
  });
});
