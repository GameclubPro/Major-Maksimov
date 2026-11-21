import { BadRequestException } from '@nestjs/common';
import { ManualModerationService } from './manual-moderation.service';

const authUser = {
  userId: 'admin-1',
  username: null,
  displayName: null,
  chatTitle: null,
};

describe('ManualModerationService sanctions boundary', () => {
  it('checks chat authorization before reading a sanction list', async () => {
    const admin = { assertChatAdmin: jest.fn().mockRejectedValue(new Error('Denied')) };
    const sanctions = { getPage: jest.fn() };
    const service = new ManualModerationService(
      admin as never,
      {} as never,
      undefined,
      sanctions as never,
    );
    await expect(service.getChatSanctions('chat', authUser, {})).rejects.toThrow('Denied');
    expect(sanctions.getPage).not.toHaveBeenCalled();
  });
  it('passes a validated release identity into the existing locked execution path', async () => {
    const admin = { applyManualModerationAction: jest.fn().mockResolvedValue({ ok: true }) };
    const service = new ManualModerationService(admin as never, {} as never);
    const body = { action: 'UNBAN', expectedSanctionEventId: 'old-sanction' };
    await service.applyManualModerationAction('chat', 'user', authUser, body);
    expect(admin.applyManualModerationAction).toHaveBeenCalledWith(
      'chat',
      'user',
      authUser,
      body,
      undefined,
      { expectedSanctionEventId: 'old-sanction' },
    );
  });
});

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const profile = {
  displayName: 'Марина Орлова',
  avatarUrl: 'https://cdn.max.ru/u/user-1/avatar.jpg',
  profileUrl: 'https://max.ru/marina-orlova',
  profileHandoffUrl: 'https://max.ru/777000_bot?start=pm2_user_1',
};

function createLegacyAdminServiceMock(resolvedProfile: typeof profile = profile) {
  return {
    assertChatAdmin: jest.fn().mockResolvedValue(undefined),
    resolveUserProfilesForAdminSurface: jest
      .fn()
      .mockResolvedValue(new Map([['user-1', resolvedProfile]])),
  };
}

function createGlobalSpammerIntelligenceMock() {
  return {
    assertReviewSubjectInChat: jest.fn().mockResolvedValue(undefined),
    getEnforcementMode: jest.fn().mockReturnValue('shadow'),
    listReviewQueue: jest
      .fn()
      .mockImplementation(async (params: { includeLocalProfiles?: boolean }) => ({
        limit: 6,
        items: [
          {
            userId: 'user-1',
            displayName: params.includeLocalProfiles === false ? null : 'Старое имя',
            avatarUrl: null,
            profileUrl: null,
            profileHandoffUrl: null,
            status: 'PENDING',
            confidenceScore: 0.74,
            sourceBreakdown: {},
            lastReason: 'COMMERCIAL_AD_DETECTED',
            lastChatId: 'chat-1',
            lastEvidence: null,
            lastUserLabel: 'Старое имя',
            suppressedUntil: null,
            reviewedAt: null,
            reviewedByUserId: null,
            reviewReason: null,
            falsePositive: false,
            chats: [],
            observations: [],
          },
        ],
      })),
    getReviewMetrics: jest.fn().mockResolvedValue({
      pending: 1,
      approved: 2,
      suppressed: 0,
      reviewed: 2,
      activeRegistry: 0,
      expiredRegistry: 0,
      archivedExpired: 0,
      newCandidates24h: 1,
      autoApproved24h: 0,
      suppressed24h: 0,
      shadowWouldEnforceCount: 0,
      topCampaigns: [],
      enforcementMode: 'enforce',
      falsePositiveCount: 0,
      falsePositiveRate: 0,
      recentObservations: [],
      suppressedObservations: [],
      sourceAlerts: [],
      sourceReputation: [],
    }),
    reviewCandidate: jest.fn().mockResolvedValue({
      ok: true,
      userId: 'user-1',
      status: 'APPROVED',
    }),
    resolveLocalReviewProfiles: jest
      .fn()
      .mockResolvedValue(new Map([['user-1', { userId: 'user-1', displayName: 'Марина Орлова' }]])),
    getUserDiagnostics: jest.fn().mockResolvedValue({
      userId: 'user-1',
      chatId: 'chat-1',
      policy: {
        userId: 'user-1',
        chatId: 'chat-1',
        trigger: 'diagnostics',
        registryStatus: 'MEDIUM_REVIEW',
        action: 'NONE',
        enforcementMode: 'enforce',
        policyBand: 'MEDIUM',
        deleteSpammersEnabled: true,
        adminExempt: false,
        shadow: false,
        wouldEnforce: false,
        enforced: false,
        confidenceScore: 0.74,
        shadowScore: null,
        reason: 'COMMERCIAL_AD_DETECTED',
        expiresAt: null,
        sourceBreakdown: {},
        campaignBreakdown: null,
      },
      registry: {
        active: false,
        expired: false,
        confidenceScore: null,
        confirmedAt: null,
        confirmedByUserId: null,
        reason: null,
        expiresAt: null,
        sourceBreakdown: null,
      },
      candidate: {
        status: 'PENDING',
        confidenceScore: 0.74,
        lastReason: 'COMMERCIAL_AD_DETECTED',
        reviewedAt: null,
        reviewedByUserId: null,
        reviewReason: null,
        falsePositive: false,
      },
      activeSuppression: null,
      observations: [],
      graphSignals: [],
      sourceReputation: [],
      campaigns: [],
      latestShadowScore: null,
      localAdminDecision: null,
    }),
  };
}

describe('ManualModerationService spammer profiles', () => {
  it('uses chat-scoped admin checks for spammer review surfaces', async () => {
    const legacyAdminService = createLegacyAdminServiceMock();
    const globalSpammerIntelligence = createGlobalSpammerIntelligenceMock();
    const service = new ManualModerationService(
      legacyAdminService as never,
      globalSpammerIntelligence as never,
    );

    await service.getGlobalSpammerReviewQueue('chat-1', authUser, {});
    await service.getGlobalSpammerReviewMetrics('chat-1', authUser);
    await service.getGlobalSpammerUserDiagnostics('chat-1', 'user-1', authUser, {
      includeProfile: 'false',
    });
    await service.reviewGlobalSpammerCandidate('chat-1', 'user-1', authUser, {
      action: 'APPROVE',
    });

    expect(legacyAdminService.assertChatAdmin).toHaveBeenNthCalledWith(
      1,
      'chat-1',
      authUser.userId,
      'chat',
    );
    expect(legacyAdminService.assertChatAdmin).toHaveBeenNthCalledWith(
      2,
      'chat-1',
      authUser.userId,
      'chat',
    );
    expect(legacyAdminService.assertChatAdmin).toHaveBeenNthCalledWith(
      3,
      'chat-1',
      authUser.userId,
      'chat',
    );
    expect(legacyAdminService.assertChatAdmin).toHaveBeenNthCalledWith(
      4,
      'chat-1',
      authUser.userId,
      'chat',
      { trafficClass: 'critical' },
    );
  });

  it('defaults spammer review lists to pending candidates when status is omitted', async () => {
    const legacyAdminService = createLegacyAdminServiceMock();
    const globalSpammerIntelligence = createGlobalSpammerIntelligenceMock();
    const service = new ManualModerationService(
      legacyAdminService as never,
      globalSpammerIntelligence as never,
    );

    await service.getGlobalSpammerReviewQueue('chat-1', authUser, {
      limit: '6',
    });

    expect(globalSpammerIntelligence.listReviewQueue).toHaveBeenCalledWith({
      chatId: 'chat-1',
      reviewerUserId: authUser.userId,
      status: 'PENDING',
      limit: 6,
      includeObservations: false,
      includeLocalProfiles: true,
    });
  });

  it('rejects invalid spammer review status values instead of widening to all candidates', async () => {
    const legacyAdminService = createLegacyAdminServiceMock();
    const globalSpammerIntelligence = createGlobalSpammerIntelligenceMock();
    const service = new ManualModerationService(
      legacyAdminService as never,
      globalSpammerIntelligence as never,
    );

    await expect(
      service.getGlobalSpammerReviewQueue('chat-1', authUser, {
        status: 'everything',
      }),
    ).rejects.toThrow(BadRequestException);

    expect(globalSpammerIntelligence.listReviewQueue).not.toHaveBeenCalled();
  });

  it('uses lightweight local data by default for spammer review candidates', async () => {
    const legacyAdminService = createLegacyAdminServiceMock();
    const globalSpammerIntelligence = createGlobalSpammerIntelligenceMock();
    const service = new ManualModerationService(
      legacyAdminService as never,
      globalSpammerIntelligence as never,
    );

    const queue = await service.getGlobalSpammerReviewQueue('chat-1', authUser, {
      status: 'PENDING',
      limit: '6',
    });

    expect(globalSpammerIntelligence.listReviewQueue).toHaveBeenCalledWith({
      chatId: 'chat-1',
      reviewerUserId: authUser.userId,
      status: 'PENDING',
      limit: 6,
      includeObservations: false,
      includeLocalProfiles: true,
    });
    expect(legacyAdminService.resolveUserProfilesForAdminSurface).not.toHaveBeenCalled();
    expect(queue.items[0]).toEqual(
      expect.objectContaining({
        displayName: 'Старое имя',
        avatarUrl: null,
        profileUrl: null,
        profileHandoffUrl: null,
      }),
    );
  });

  it('records spammer surface timing diagnostics without blocking review responses', async () => {
    const legacyAdminService = createLegacyAdminServiceMock();
    const globalSpammerIntelligence = createGlobalSpammerIntelligenceMock();
    const runtimeDiagnostics = {
      recordSpammerSurfaceTiming: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ManualModerationService(
      legacyAdminService as never,
      globalSpammerIntelligence as never,
      runtimeDiagnostics as never,
    );

    await service.getGlobalSpammerReviewQueue('chat-1', authUser, {
      status: 'PENDING',
      limit: '6',
    });
    await flushPromises();

    expect(runtimeDiagnostics.recordSpammerSurfaceTiming).toHaveBeenCalledWith({
      surface: 'spammer-review',
      timings: expect.objectContaining({
        assertAdmin: expect.any(Number),
        queue: expect.any(Number),
        profile: expect.any(Number),
        zodParse: expect.any(Number),
        total: expect.any(Number),
      }),
    });
  });

  it('attaches resolved remote profile data when full spammer review profiles are requested', async () => {
    const legacyAdminService = createLegacyAdminServiceMock();
    const globalSpammerIntelligence = createGlobalSpammerIntelligenceMock();
    const service = new ManualModerationService(
      legacyAdminService as never,
      globalSpammerIntelligence as never,
    );

    const queue = await service.getGlobalSpammerReviewQueue('chat-1', authUser, {
      status: 'PENDING',
      limit: '6',
      profileMode: 'full',
      includeObservations: 'true',
    });

    expect(globalSpammerIntelligence.listReviewQueue).toHaveBeenCalledWith({
      chatId: 'chat-1',
      reviewerUserId: authUser.userId,
      status: 'PENDING',
      limit: 6,
      includeObservations: true,
      includeLocalProfiles: false,
    });
    expect(queue.items[0]).toEqual(
      expect.objectContaining({
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        profileUrl: profile.profileUrl,
        profileHandoffUrl: profile.profileHandoffUrl,
      }),
    );
    expect(legacyAdminService.resolveUserProfilesForAdminSurface).toHaveBeenCalledWith(
      'chat-1',
      'chat',
      ['user-1'],
      { allowRemoteLookup: true },
    );
  });

  it('uses lightweight local profile data by default for spammer dossier diagnostics', async () => {
    const legacyAdminService = createLegacyAdminServiceMock();
    const globalSpammerIntelligence = createGlobalSpammerIntelligenceMock();
    const service = new ManualModerationService(
      legacyAdminService as never,
      globalSpammerIntelligence as never,
    );

    const diagnostics = await service.getGlobalSpammerUserDiagnostics('chat-1', 'user-1', authUser);

    expect(globalSpammerIntelligence.getUserDiagnostics).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: 'user-1',
      options: {
        includeObservations: false,
        includeGraphSignals: false,
        includeReputation: false,
        includeCampaigns: false,
        includeShadow: false,
      },
    });
    expect(legacyAdminService.resolveUserProfilesForAdminSurface).not.toHaveBeenCalled();
    expect(globalSpammerIntelligence.resolveLocalReviewProfiles).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userIds: ['user-1'],
    });
    expect(diagnostics).toEqual(
      expect.objectContaining({
        displayName: profile.displayName,
        avatarUrl: null,
        profileUrl: null,
        profileHandoffUrl: null,
      }),
    );
  });

  it('attaches resolved profile data to full spammer dossier diagnostics when requested', async () => {
    const legacyAdminService = createLegacyAdminServiceMock();
    const globalSpammerIntelligence = createGlobalSpammerIntelligenceMock();
    const service = new ManualModerationService(
      legacyAdminService as never,
      globalSpammerIntelligence as never,
    );

    const diagnostics = await service.getGlobalSpammerUserDiagnostics(
      'chat-1',
      'user-1',
      authUser,
      { mode: 'full' },
    );

    expect(globalSpammerIntelligence.getUserDiagnostics).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: 'user-1',
      options: {
        includeObservations: true,
        includeGraphSignals: true,
        includeReputation: true,
        includeCampaigns: true,
        includeShadow: true,
      },
    });
    expect(diagnostics).toEqual(
      expect.objectContaining({
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        profileUrl: profile.profileUrl,
        profileHandoffUrl: profile.profileHandoffUrl,
      }),
    );
    expect(legacyAdminService.resolveUserProfilesForAdminSurface).toHaveBeenCalledWith(
      'chat-1',
      'chat',
      ['user-1'],
      { allowRemoteLookup: true },
    );
  });

  it('attaches local profile data without remote lookup for lightweight spammer review lists', async () => {
    const legacyAdminService = createLegacyAdminServiceMock();
    const globalSpammerIntelligence = createGlobalSpammerIntelligenceMock();
    const service = new ManualModerationService(
      legacyAdminService as never,
      globalSpammerIntelligence as never,
    );

    const queue = await service.getGlobalSpammerReviewQueue('chat-1', authUser, {
      status: 'PENDING',
      limit: '20',
      includeObservations: 'false',
      profileMode: 'local',
    });

    expect(globalSpammerIntelligence.listReviewQueue).toHaveBeenCalledWith({
      chatId: 'chat-1',
      reviewerUserId: authUser.userId,
      status: 'PENDING',
      limit: 20,
      includeObservations: false,
      includeLocalProfiles: true,
    });
    expect(legacyAdminService.resolveUserProfilesForAdminSurface).not.toHaveBeenCalled();
    expect(globalSpammerIntelligence.resolveLocalReviewProfiles).not.toHaveBeenCalled();
    expect(queue.items[0]).toEqual(
      expect.objectContaining({
        displayName: 'Старое имя',
        avatarUrl: null,
      }),
    );
  });

  it('skips profile enrichment and observations when lightweight spammer review lists opt out', async () => {
    const legacyAdminService = createLegacyAdminServiceMock();
    const globalSpammerIntelligence = createGlobalSpammerIntelligenceMock();
    const service = new ManualModerationService(
      legacyAdminService as never,
      globalSpammerIntelligence as never,
    );

    const queue = await service.getGlobalSpammerReviewQueue('chat-1', authUser, {
      status: 'PENDING',
      limit: '20',
      includeProfiles: 'false',
      includeObservations: 'false',
    });

    expect(globalSpammerIntelligence.listReviewQueue).toHaveBeenCalledWith({
      chatId: 'chat-1',
      reviewerUserId: authUser.userId,
      status: 'PENDING',
      limit: 20,
      includeObservations: false,
      includeLocalProfiles: false,
    });
    expect(legacyAdminService.resolveUserProfilesForAdminSurface).not.toHaveBeenCalled();
    expect(globalSpammerIntelligence.resolveLocalReviewProfiles).not.toHaveBeenCalled();
    expect(queue.items[0]).toEqual(
      expect.objectContaining({
        displayName: null,
        avatarUrl: null,
        lastUserLabel: 'Старое имя',
      }),
    );
  });

  it('uses lightweight summary mode for spammer review metrics by default', async () => {
    const legacyAdminService = createLegacyAdminServiceMock();
    const globalSpammerIntelligence = createGlobalSpammerIntelligenceMock();
    const service = new ManualModerationService(
      legacyAdminService as never,
      globalSpammerIntelligence as never,
    );

    const metrics = await service.getGlobalSpammerReviewMetrics('chat-1', authUser);

    expect(globalSpammerIntelligence.getReviewMetrics).toHaveBeenCalledWith({
      chatId: 'chat-1',
      reviewerUserId: authUser.userId,
      mode: 'summary',
    });
    expect(metrics.enforcementMode).toBe('enforce');
  });

  it('passes full mode through for spammer review metrics when requested', async () => {
    const legacyAdminService = createLegacyAdminServiceMock();
    const globalSpammerIntelligence = createGlobalSpammerIntelligenceMock();
    const service = new ManualModerationService(
      legacyAdminService as never,
      globalSpammerIntelligence as never,
    );

    await service.getGlobalSpammerReviewMetrics('chat-1', authUser, { mode: 'full' });

    expect(globalSpammerIntelligence.getReviewMetrics).toHaveBeenCalledWith({
      chatId: 'chat-1',
      reviewerUserId: authUser.userId,
      mode: 'full',
    });
  });

  it('skips profile enrichment for lightweight spammer dossier diagnostics', async () => {
    const legacyAdminService = createLegacyAdminServiceMock();
    const globalSpammerIntelligence = createGlobalSpammerIntelligenceMock();
    const service = new ManualModerationService(
      legacyAdminService as never,
      globalSpammerIntelligence as never,
    );

    const diagnostics = await service.getGlobalSpammerUserDiagnostics(
      'chat-1',
      'user-1',
      authUser,
      { includeProfile: 'false', mode: 'full' },
    );

    expect(globalSpammerIntelligence.getUserDiagnostics).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: 'user-1',
      options: {
        includeObservations: true,
        includeGraphSignals: true,
        includeReputation: true,
        includeCampaigns: true,
        includeShadow: true,
      },
    });
    expect(legacyAdminService.resolveUserProfilesForAdminSurface).not.toHaveBeenCalled();
    expect(diagnostics).toEqual(
      expect.objectContaining({
        userId: 'user-1',
        displayName: null,
        avatarUrl: null,
        profileUrl: null,
        profileHandoffUrl: null,
      }),
    );
  });

  it('attaches local profile data without remote lookup for lightweight spammer dossier diagnostics', async () => {
    const legacyAdminService = createLegacyAdminServiceMock();
    const globalSpammerIntelligence = createGlobalSpammerIntelligenceMock();
    const service = new ManualModerationService(
      legacyAdminService as never,
      globalSpammerIntelligence as never,
    );

    const diagnostics = await service.getGlobalSpammerUserDiagnostics(
      'chat-1',
      'user-1',
      authUser,
      {
        profileMode: 'local',
        includeObservations: 'false',
        includeGraphSignals: 'false',
        includeReputation: 'false',
        includeCampaigns: 'false',
        includeShadow: 'false',
      },
    );

    expect(globalSpammerIntelligence.getUserDiagnostics).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: 'user-1',
      options: {
        includeObservations: false,
        includeGraphSignals: false,
        includeReputation: false,
        includeCampaigns: false,
        includeShadow: false,
      },
    });
    expect(legacyAdminService.resolveUserProfilesForAdminSurface).not.toHaveBeenCalled();
    expect(globalSpammerIntelligence.resolveLocalReviewProfiles).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userIds: ['user-1'],
    });
    expect(diagnostics).toEqual(
      expect.objectContaining({
        userId: 'user-1',
        displayName: profile.displayName,
        avatarUrl: null,
        profileUrl: null,
        profileHandoffUrl: null,
      }),
    );
  });

  it('drops invalid profile urls instead of failing spammer dossier validation', async () => {
    const legacyAdminService = createLegacyAdminServiceMock({
      displayName: '  Марина Орлова  ',
      avatarUrl: 'not-a-url',
      profileUrl: 'max://user/user-1',
      profileHandoffUrl: 'javascript:alert(1)',
    });
    const globalSpammerIntelligence = createGlobalSpammerIntelligenceMock();
    const service = new ManualModerationService(
      legacyAdminService as never,
      globalSpammerIntelligence as never,
    );

    const queue = await service.getGlobalSpammerReviewQueue('chat-1', authUser, {
      status: 'PENDING',
      limit: '6',
      profileMode: 'full',
    });
    const diagnostics = await service.getGlobalSpammerUserDiagnostics(
      'chat-1',
      'user-1',
      authUser,
      { mode: 'full' },
    );

    expect(queue.items[0]).toEqual(
      expect.objectContaining({
        displayName: 'Марина Орлова',
        avatarUrl: null,
        profileUrl: null,
        profileHandoffUrl: null,
      }),
    );
    expect(diagnostics).toEqual(
      expect.objectContaining({
        displayName: 'Марина Орлова',
        avatarUrl: null,
        profileUrl: null,
        profileHandoffUrl: null,
      }),
    );
  });
});

describe('ManualModerationService command bridge', () => {
  it('authorizes the exact channel before a local ban', async () => {
    const legacy = {
      assertManagedEntityAdminAccess: jest.fn().mockResolvedValue(undefined),
      applyManualModerationAction: jest.fn().mockResolvedValue({ ok: true }),
    };
    const service = new ManualModerationService(legacy as never, {} as never);
    await service.banChannelMember('channel-1', 'user-1', authUser);
    expect(legacy.assertManagedEntityAdminAccess).toHaveBeenCalledWith(
      'channel-1',
      authUser.userId,
      'channel',
    );
    expect(legacy.applyManualModerationAction).toHaveBeenCalledWith(
      'channel-1',
      'user-1',
      authUser,
      { action: 'BAN', scope: 'current_chat' },
      'miniapp',
      { entityType: 'CHANNEL', actorAlreadyVerified: true },
    );
    expect(legacy.assertManagedEntityAdminAccess.mock.invocationCallOrder[0]).toBeLessThan(
      legacy.applyManualModerationAction.mock.invocationCallOrder[0]!,
    );
  });

  it('does not dispatch a channel ban when access or entity verification fails', async () => {
    const legacy = {
      assertManagedEntityAdminAccess: jest.fn().mockRejectedValue(new Error('Access denied')),
      applyManualModerationAction: jest.fn(),
    };
    const service = new ManualModerationService(legacy as never, {} as never);
    await expect(service.banChannelMember('channel-1', 'user-1', authUser)).rejects.toThrow(
      'Access denied',
    );
    expect(legacy.applyManualModerationAction).not.toHaveBeenCalled();
  });

  it('forwards system ban commands through the legacy admin boundary', async () => {
    const legacyAdminService = {
      ...createLegacyAdminServiceMock(),
      applyManualSystemBan: jest.fn().mockResolvedValue({ ok: true, message: 'Забанен' }),
    };
    const service = new ManualModerationService(
      legacyAdminService as never,
      createGlobalSpammerIntelligenceMock() as never,
    );

    await expect(
      service.applyManualSystemBan('chat-1', 'user-1', authUser, 'private_command'),
    ).resolves.toEqual({ ok: true, message: 'Забанен' });

    expect(legacyAdminService.applyManualSystemBan).toHaveBeenCalledWith(
      'chat-1',
      'user-1',
      authUser,
      'private_command',
    );
  });
});

describe('spammer surfaces with chat scoped evidence', () => {
  it('denies diagnostics and reviews before loading data for a subject outside the chat', async () => {
    const registry = createGlobalSpammerIntelligenceMock();
    registry.assertReviewSubjectInChat.mockRejectedValue(new Error('No participant evidence'));
    const service = new ManualModerationService(
      createLegacyAdminServiceMock() as never,
      registry as never,
    );
    await expect(
      service.getGlobalSpammerUserDiagnostics('chat-1', 'other', authUser),
    ).rejects.toThrow('No participant evidence');
    await expect(
      service.reviewGlobalSpammerCandidate('chat-1', 'other', authUser, { action: 'APPROVE' }),
    ).rejects.toThrow('No participant evidence');
    expect(registry.getUserDiagnostics).not.toHaveBeenCalled();
    expect(registry.reviewCandidate).not.toHaveBeenCalled();
  });

  it('reports the mode without querying counters', async () => {
    const registry = createGlobalSpammerIntelligenceMock();
    const service = new ManualModerationService(
      createLegacyAdminServiceMock() as never,
      registry as never,
    );
    await expect(
      service.getGlobalSpammerReviewMetrics('chat-1', authUser, { mode: 'mode' }),
    ).resolves.toMatchObject({ enforcementMode: 'shadow' });
    expect(registry.getReviewMetrics).not.toHaveBeenCalled();
  });
});
