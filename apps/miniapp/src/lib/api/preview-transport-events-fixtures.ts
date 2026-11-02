import {
  globalSpammerReviewMetricsSchema,
  globalSpammerReviewQueueSchema,
  globalSpammerReviewResultSchema,
  globalSpammerUserDiagnosticsSchema,
  manualModerationActionResultSchema,
  type GlobalSpammerReviewCandidate,
  type GlobalSpammerReviewRequest,
  type GlobalSpammerUserDiagnostics,
  type LogsDashboardResponse,
  type ManualModerationActionRequest,
  type ManualModerationActionResult,
} from '@maxim/contracts';
import { chatParticipantDetailsSchema } from '@maxim/contracts/participant-details';
import { PREVIEW_CHAT_ID } from '../design-preview';
import type { PreviewState } from './preview-transport-state';
import { readPreviewClock, type PreviewClock } from './preview-transport-runtime';
import {
  addDays,
  addHours,
  addMinutes,
  buildPreviewAvatarDataUrl,
  buildPreviewProfileHandoffUrl,
  buildPreviewProfileUrl,
} from './preview-transport-shared';

export function buildPreviewParticipantDetails(state: PreviewState, userId: string, url: URL) {
  const participant = state.chatParticipants.find((item) => item.userId === userId);
  const profile = resolvePreviewUser(state, userId);
  const range = url.searchParams.get('range') ?? '7d';
  const now = readPreviewClock(state.clock).getTime();
  const from = now - (range === '24h' ? 1 : range === '30d' ? 30 : 7) * 86_400_000;
  const violationCount = state.chatViolations.filter(
    (item) =>
      item.userId === userId &&
      Date.parse(item.createdAt) >= from &&
      Date.parse(item.createdAt) <= now &&
      ['WARN', 'DELETE_MESSAGE', 'MUTE', 'KICK', 'BAN'].includes(item.action),
  ).length;
  const hasHistory =
    state.chatActivity.some((item) => item.userId === userId) ||
    state.chatViolations.some((item) => item.userId === userId);
  const canSanction = participant
    ? participant.role === 'member' && !participant.isBot
    : hasHistory;
  return chatParticipantDetailsSchema.parse({
    ...(participant ?? {
      userId,
      userDisplayName: profile.displayName,
      avatarUrl: profile.avatarUrl,
      role: null,
    }),
    violationCount,
    membershipStatus: participant ? 'member' : 'left',
    canManage: participant?.role === 'member' && !participant.isBot,
    canMute: canSanction,
    canBan: canSanction,
  });
}

export function buildModerationMessage(payload: ManualModerationActionRequest): string {
  const scopeLabel = payload.scope === 'all_chats' ? 'во всех чатах' : 'в этом чате';
  if (payload.action === 'MUTE') {
    return `Мут включён на ${payload.muteDurationHours ?? 24} ч ${scopeLabel} (preview).`;
  }
  if (payload.action === 'UNMUTE') {
    return 'Мут снят (preview).';
  }
  if (payload.action === 'UNBAN') {
    return 'Блокировка снята (preview).';
  }
  return `Бан включён ${scopeLabel} (preview).`;
}

export function createModerationResult(
  userId: string,
  payload: ManualModerationActionRequest,
  clock: PreviewClock,
): ManualModerationActionResult {
  const now = readPreviewClock(clock);
  return manualModerationActionResultSchema.parse({
    ok: true,
    action: payload.action,
    userId,
    muteDurationHours: payload.action === 'MUTE' ? (payload.muteDurationHours ?? 24) : null,
    muteExpiresAt:
      payload.action === 'MUTE'
        ? addHours(now, payload.muteDurationHours ?? 24).toISOString()
        : null,
    message: buildModerationMessage(payload),
  });
}

export function applyPreviewManualModeration(
  state: PreviewState,
  userId: string,
  payload: ManualModerationActionRequest,
): ManualModerationActionResult {
  const user = resolvePreviewUser(state, userId);
  const violation = createManualViolation(userId, user, payload, state.clock);
  if (payload.action === 'BAN' && !state.chatParticipants.some((item) => item.userId === userId)) {
    violation.metadata = { ...violation.metadata, mode: 'LOCAL_REJOIN' };
  }
  state.chatViolations = [violation, ...state.chatViolations];
  return createModerationResult(userId, payload, state.clock);
}

export function createPreviewSpammerReviewCandidates(now: Date): GlobalSpammerReviewCandidate[] {
  return globalSpammerReviewQueueSchema.parse({
    limit: 6,
    items: [
      {
        userId: 'preview-spam-1',
        displayName: 'Promo Mix',
        avatarUrl: buildPreviewAvatarDataUrl('Promo Mix', '#f1a44b', '#ea7b4b'),
        profileUrl: buildPreviewProfileUrl('promo-mix-preview'),
        profileHandoffUrl: buildPreviewProfileHandoffUrl('promo-mix-preview'),
        status: 'PENDING',
        confidenceScore: 0.74,
        sourceBreakdown: {
          COMMERCIAL_CAMPAIGN: {
            score: 0.58,
            rawScore: 0.74,
            count: 2,
            latestAt: addHours(now, -1).toISOString(),
            reasons: ['COMMERCIAL_AD_DETECTED'],
          },
          REPEATED_LINK: {
            score: 0.62,
            rawScore: 0.58,
            count: 1,
            latestAt: addHours(now, -1.2).toISOString(),
            reasons: ['REPEATED_LINK_CROSS_CHAT'],
          },
          MANUAL_BAN: {
            score: 0.34,
            rawScore: 1,
            count: 2,
            latestAt: addHours(now, -2.4).toISOString(),
            reasons: ['MANUAL_BAN'],
            effect: 'risk',
            mitigating: false,
          },
        },
        lastReason: 'COMMERCIAL_AD_DETECTED',
        lastChatId: PREVIEW_CHAT_ID,
        lastEvidence: {
          excerpt: 'Прайс от 990, доставка сегодня, подробности в профиле',
        },
        lastUserLabel: 'Promo Mix',
        suppressedUntil: null,
        reviewedAt: null,
        reviewedByUserId: null,
        reviewReason: null,
        falsePositive: false,
        chats: [
          {
            chatId: PREVIEW_CHAT_ID,
            detectionsCount: 2,
            lastMessageId: 'preview-spam-message-1',
            lastExcerpt: 'Прайс от 990, доставка сегодня, подробности в профиле',
            lastUserLabel: 'Promo Mix',
            lastDetectedAt: addHours(now, -1).toISOString(),
          },
        ],
        observations: [
          {
            id: 'preview-observation-1',
            source: 'COMMERCIAL_CAMPAIGN',
            score: 0.74,
            confidenceLevel: 'MEDIUM',
            reason: 'COMMERCIAL_AD_DETECTED',
            chatId: PREVIEW_CHAT_ID,
            messageId: 'preview-spam-message-1',
            evidenceHash: 'preview-hash-1',
            evidence: {
              excerpt: 'Прайс от 990, доставка сегодня, подробности в профиле',
            },
            observedAt: addHours(now, -1).toISOString(),
            expiresAt: addDays(now, 14).toISOString(),
            suppressedAt: null,
            suppressionReason: null,
          },
          {
            id: 'preview-observation-2',
            source: 'REPEATED_LINK',
            score: 0.58,
            confidenceLevel: 'MEDIUM',
            reason: 'REPEATED_LINK_CROSS_CHAT',
            chatId: PREVIEW_CHAT_ID,
            messageId: 'preview-spam-message-1',
            evidenceHash: 'preview-hash-2',
            evidence: {
              repeatedLinkDistinctChatCount: 2,
            },
            observedAt: addHours(now, -1.2).toISOString(),
            expiresAt: addDays(now, 10).toISOString(),
            suppressedAt: null,
            suppressionReason: null,
          },
          {
            id: 'preview-observation-3',
            source: 'MANUAL_BAN',
            score: 0.34,
            confidenceLevel: 'LOW',
            reason: 'MANUAL_BAN',
            chatId: 'preview-other-chat-1',
            messageId: null,
            evidenceHash: 'preview-hash-3',
            evidence: {
              actorUserId: 'preview-other-admin',
              sourceCause: 'MANUAL_BAN',
            },
            observedAt: addHours(now, -2.4).toISOString(),
            expiresAt: addDays(now, 21).toISOString(),
            suppressedAt: null,
            suppressionReason: null,
          },
        ],
      },
    ],
  }).items;
}

export function buildPreviewSpammerReviewMetrics(
  candidates: readonly GlobalSpammerReviewCandidate[],
  clock: PreviewClock,
) {
  const now = readPreviewClock(clock);
  const pending = candidates.filter((item) => item.status === 'PENDING').length;
  const approved = candidates.filter(
    (item) => item.status === 'APPROVED' || item.status === 'AUTO_APPROVED',
  ).length;
  const suppressed = candidates.filter((item) => item.status === 'SUPPRESSED').length;
  const reviewed = candidates.filter(
    (item) => item.status === 'APPROVED' || item.status === 'SUPPRESSED',
  ).length;
  const falsePositiveCount = candidates.filter((item) => item.falsePositive).length;
  const sourceCounts = new Map<string, number>();
  const suppressedCounts = new Map<string, number>();
  for (const candidate of candidates) {
    for (const observation of candidate.observations) {
      sourceCounts.set(observation.source, (sourceCounts.get(observation.source) ?? 0) + 1);
      if (observation.suppressedAt) {
        suppressedCounts.set(
          observation.source,
          (suppressedCounts.get(observation.source) ?? 0) + 1,
        );
      }
    }
  }

  return globalSpammerReviewMetricsSchema.parse({
    pending,
    approved,
    suppressed,
    reviewed,
    activeRegistry: approved,
    expiredRegistry: 0,
    archivedExpired: 4,
    newCandidates24h: Math.max(pending, 2),
    autoApproved24h: Math.max(approved, 1),
    suppressed24h: suppressed,
    shadowWouldEnforceCount: 3,
    topCampaigns: createPreviewSpammerCampaigns(now).slice(0, 3),
    enforcementMode: 'enforce',
    falsePositiveCount,
    falsePositiveRate: reviewed > 0 ? falsePositiveCount / reviewed : 0,
    recentObservations: [...sourceCounts.entries()].map(([source, count]) => ({ source, count })),
    suppressedObservations: [...suppressedCounts.entries()].map(([source, count]) => ({
      source,
      count,
    })),
    sourceAlerts: [],
  });
}

export function createPreviewSpammerCampaigns(now: Date, options: { userScoped?: boolean } = {}) {
  return [
    {
      clusterId: 'preview-campaign-domain',
      signalType: 'DOMAIN',
      status: 'CONFIRMED',
      confidenceScore: 0.91,
      distinctUsersCount: 7,
      distinctChatsCount: 5,
      observationsCount: 18,
      userObservationsCount: options.userScoped ? 3 : null,
      lastSeenAt: addHours(now, -0.8).toISOString(),
      preview: 'promo-bad.example',
    },
    {
      clusterId: 'preview-campaign-text',
      signalType: 'TEXT_SIGNATURE',
      status: 'ACTIVE',
      confidenceScore: 0.78,
      distinctUsersCount: 4,
      distinctChatsCount: 3,
      observationsCount: 9,
      userObservationsCount: options.userScoped ? 2 : null,
      lastSeenAt: addHours(now, -2.4).toISOString(),
      preview: null,
    },
  ];
}

export function buildPreviewSpammerDiagnostics(
  candidates: readonly GlobalSpammerReviewCandidate[],
  chatId: string,
  userId: string,
  clock: PreviewClock,
  includeProfile = true,
): GlobalSpammerUserDiagnostics {
  const now = readPreviewClock(clock);
  if (userId === 'preview-spammer-1') {
    const expiresAt = addDays(now, 30).toISOString();
    const observedAt = addHours(now, -1).toISOString();
    const displayName = 'Олег Повтор';
    const duplicateSignals = [
      {
        id: 'preview-registry-observation-1',
        source: 'FANOUT_HIGH',
        score: 0.94,
        confidenceLevel: 'HIGH',
        reason: 'FANOUT_EPISODE_CONFIRMED',
        chatId,
        observedAt,
        expiresAt,
        suppressedAt: null,
      },
      {
        id: 'preview-registry-observation-2',
        source: 'FANOUT_HIGH',
        score: 0.91,
        confidenceLevel: 'HIGH',
        reason: 'FANOUT_EPISODE_CONFIRMED',
        chatId,
        observedAt: addHours(now, -1.4).toISOString(),
        expiresAt,
        suppressedAt: null,
      },
      {
        id: 'preview-registry-observation-3',
        source: 'GRAPH_FANOUT_PATTERN',
        score: 0.7,
        confidenceLevel: 'MEDIUM',
        reason: 'GRAPH_FANOUT_PATTERN',
        chatId,
        observedAt: addHours(now, -2).toISOString(),
        expiresAt,
        suppressedAt: null,
      },
    ];

    return globalSpammerUserDiagnosticsSchema.parse({
      userId,
      chatId,
      displayName: includeProfile ? displayName : null,
      avatarUrl: includeProfile
        ? buildPreviewAvatarDataUrl(displayName, '#7db8ff', '#4d89ff')
        : null,
      profileUrl: includeProfile ? buildPreviewProfileUrl('oleg-repeat') : null,
      profileHandoffUrl: includeProfile ? buildPreviewProfileHandoffUrl('oleg-repeat') : null,
      policy: {
        userId,
        chatId,
        trigger: 'diagnostics',
        registryStatus: 'ACTIVE_CONFIRMED',
        action: 'NONE',
        enforcementMode: 'enforce',
        deleteSpammersEnabled: false,
        adminExempt: false,
        shadow: false,
        wouldEnforce: true,
        enforced: false,
        confidenceScore: 0.94,
        policyBand: 'VERY_HIGH',
        shadowScore: 0.98,
        reason: 'FANOUT_EPISODE_CONFIRMED',
        expiresAt,
        sourceBreakdown: {
          FANOUT_HIGH: { score: 0.94, count: 2 },
          GRAPH_FANOUT_PATTERN: { score: 0.7, count: 2 },
          GRAPH_TEXT: { score: 0.56, count: 1 },
        },
        campaignBreakdown: {
          'preview-campaign-domain': {
            confidenceScore: 0.91,
            distinctUsersCount: 7,
            distinctChatsCount: 5,
          },
        },
      },
      registry: {
        active: true,
        expired: false,
        confidenceScore: 0.94,
        confirmedAt: addHours(now, -2).toISOString(),
        confirmedByUserId: null,
        reason: 'FANOUT_EPISODE_CONFIRMED',
        expiresAt,
        sourceBreakdown: {
          FANOUT_HIGH: { score: 0.94, count: 2 },
          GRAPH_FANOUT_PATTERN: { score: 0.7, count: 2 },
          GRAPH_TEXT: { score: 0.56, count: 1 },
        },
      },
      candidate: null,
      activeSuppression: null,
      observations: duplicateSignals,
      graphSignals: [
        {
          signalType: 'FANOUT_PATTERN',
          source: 'GRAPH_FANOUT_PATTERN',
          score: 0.68,
          chatId,
          observedAt: addHours(now, -1.7).toISOString(),
          expiresAt,
        },
        {
          signalType: 'TEXT',
          source: 'GRAPH_TEXT',
          score: 0.56,
          chatId,
          observedAt: addHours(now, -2.2).toISOString(),
          expiresAt,
        },
      ],
      sourceReputation: [
        {
          source: 'FANOUT_HIGH',
          weight: 0.94,
          falsePositiveRate: 0.03,
          observations: 58,
          suppressed: 2,
        },
        {
          source: 'GRAPH_FANOUT_PATTERN',
          weight: 0.7,
          falsePositiveRate: 0.08,
          observations: 23,
          suppressed: 2,
        },
      ],
      campaigns: createPreviewSpammerCampaigns(now, { userScoped: true }),
      localAdminDecision: null,
      reputationSummary: {
        naturalBanSignals: 0,
        localBlockSignals: 0,
        localAllowSignals: 0,
        onlyReputationSignals: false,
        note: 'Репутационные сигналы учитываются как фон, а не как приговор.',
      },
      latestShadowScore: {
        currentScore: 0.94,
        v2Score: 0.98,
        scoreDelta: 0.04,
        currentBand: 'VERY_HIGH',
        v2Band: 'CONFIRMED',
        wouldPromote: false,
        wouldSuppress: false,
        createdAt: addMinutes(now, -25).toISOString(),
      },
    });
  }

  const candidate = candidates.find((item) => item.userId === userId) ?? null;
  const displayName = candidate?.displayName ?? candidate?.lastUserLabel ?? null;
  const isApproved = candidate?.status === 'APPROVED' || candidate?.status === 'AUTO_APPROVED';
  const isSuppressed = candidate?.status === 'SUPPRESSED';
  const localAdminDecision = isApproved
    ? {
        decision: 'BLOCK',
        reason: candidate?.reviewReason ?? 'LOCAL_ADMIN_BLOCK',
        sourceChatId: chatId,
        decidedByUserIds: [candidate?.reviewedByUserId ?? 'preview-admin'],
        updatedAt: candidate?.reviewedAt ?? now.toISOString(),
      }
    : isSuppressed
      ? {
          decision: 'ALLOW',
          reason: candidate?.reviewReason ?? 'LOCAL_ADMIN_ALLOW',
          sourceChatId: chatId,
          decidedByUserIds: [candidate?.reviewedByUserId ?? 'preview-admin'],
          updatedAt: candidate?.reviewedAt ?? now.toISOString(),
        }
      : null;
  const observations = candidate?.observations ?? [];
  const naturalBanSignals = observations.filter(
    (observation) => observation.source === 'SANCTION_BAN' || observation.source === 'MANUAL_BAN',
  ).length;
  const localBlockSignals =
    observations.filter((observation) => observation.source === 'LOCAL_ADMIN_BLOCK').length +
    (isApproved ? 1 : 0);
  const localAllowSignals =
    observations.filter((observation) => observation.source === 'LOCAL_ADMIN_ALLOW').length +
    (isSuppressed ? 1 : 0);
  const onlyReputationSignals =
    observations.length > 0 &&
    observations.every((observation) =>
      ['SANCTION_BAN', 'MANUAL_BAN', 'LOCAL_ADMIN_BLOCK', 'LOCAL_ADMIN_ALLOW'].includes(
        observation.source,
      ),
    );
  const policyStatus = isApproved
    ? 'LOCAL_BLOCKED'
    : isSuppressed
      ? 'ADMIN_EXEMPT'
      : candidate?.status === 'PENDING'
        ? 'MEDIUM_REVIEW'
        : 'NONE';
  const confidenceScore = candidate?.confidenceScore ?? null;
  const expiresAt = null;

  return globalSpammerUserDiagnosticsSchema.parse({
    userId,
    chatId,
    displayName: includeProfile ? displayName : null,
    avatarUrl: includeProfile ? (candidate?.avatarUrl ?? null) : null,
    profileUrl: includeProfile ? (candidate?.profileUrl ?? null) : null,
    profileHandoffUrl: includeProfile ? (candidate?.profileHandoffUrl ?? null) : null,
    policy: {
      userId,
      chatId,
      trigger: 'diagnostics',
      registryStatus: policyStatus,
      action: isApproved ? 'DELETE_AND_KICK' : 'NONE',
      enforcementMode: 'enforce',
      deleteSpammersEnabled: true,
      adminExempt: isSuppressed,
      shadow: false,
      wouldEnforce: false,
      enforced: false,
      confidenceScore,
      policyBand: isApproved ? 'HIGH' : isSuppressed ? 'LOW' : 'MEDIUM',
      shadowScore: candidate ? Math.min(1, candidate.confidenceScore + 0.08) : null,
      reason: localAdminDecision?.reason ?? candidate?.lastReason ?? 'NO_ACTIVE_REGISTRY_ENTRY',
      expiresAt,
      sourceBreakdown: candidate?.sourceBreakdown ?? null,
      campaignBreakdown: candidate
        ? {
            'preview-campaign-domain': {
              confidenceScore: 0.78,
              distinctUsersCount: 3,
              distinctChatsCount: 2,
            },
          }
        : null,
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
    candidate: candidate
      ? {
          status: candidate.status,
          confidenceScore: candidate.confidenceScore,
          lastReason: candidate.lastReason,
          reviewedAt: candidate.reviewedAt,
          reviewedByUserId: candidate.reviewedByUserId,
          reviewReason: candidate.reviewReason,
          falsePositive: candidate.falsePositive,
        }
      : null,
    activeSuppression: null,
    observations: observations.map((observation) => ({
      id: observation.id,
      source: observation.source,
      score: observation.score,
      confidenceLevel: observation.confidenceLevel,
      reason: observation.reason,
      chatId: observation.chatId,
      observedAt: observation.observedAt,
      expiresAt: observation.expiresAt,
      suppressedAt: observation.suppressedAt,
    })),
    graphSignals: [
      {
        signalType: 'DOMAIN',
        source: 'GRAPH_DOMAIN',
        score: 0.62,
        chatId,
        observedAt: addHours(now, -1).toISOString(),
        expiresAt: addDays(now, 14).toISOString(),
      },
    ],
    sourceReputation: [
      {
        source: 'COMMERCIAL_CAMPAIGN',
        weight: 0.9,
        falsePositiveRate: 0.04,
        observations: 42,
        suppressed: 2,
      },
      {
        source: 'MANUAL_BAN',
        weight: 0.36,
        falsePositiveRate: 0.12,
        observations: 18,
        suppressed: 2,
      },
    ],
    campaigns: candidate
      ? createPreviewSpammerCampaigns(now, { userScoped: true }).slice(0, 1)
      : [],
    localAdminDecision,
    reputationSummary: {
      naturalBanSignals,
      localBlockSignals,
      localAllowSignals,
      onlyReputationSignals:
        onlyReputationSignals ||
        (naturalBanSignals + localBlockSignals + localAllowSignals > 0 &&
          !candidate?.observations.some((observation) =>
            ['FANOUT_HIGH', 'FANOUT_REPEAT', 'COMMERCIAL_AD', 'COMMERCIAL_CAMPAIGN'].includes(
              observation.source,
            ),
          )),
      note:
        naturalBanSignals + localBlockSignals + localAllowSignals > 0
          ? 'Есть репутационные сигналы, но сами по себе они не отправляют пользователя в глобальную базу.'
          : 'Репутационные сигналы учитываются как фон, а не как приговор.',
    },
    latestShadowScore: candidate
      ? {
          currentScore: candidate.confidenceScore,
          v2Score: Math.min(1, candidate.confidenceScore + 0.08),
          scoreDelta: 0.08,
          currentBand: isApproved ? 'CONFIRMED' : 'MEDIUM',
          v2Band: isApproved ? 'CONFIRMED' : 'HIGH',
          wouldPromote: !isApproved && !isSuppressed,
          wouldSuppress: isSuppressed,
          createdAt: addMinutes(now, -12).toISOString(),
        }
      : null,
  });
}

export function createPreviewSpammerReviewResult(
  candidates: GlobalSpammerReviewCandidate[],
  userId: string,
  payload: GlobalSpammerReviewRequest,
  clock: PreviewClock,
) {
  const now = readPreviewClock(clock).toISOString();
  const status = payload.action === 'SUPPRESS' ? 'SUPPRESSED' : 'APPROVED';
  const index = candidates.findIndex((candidate) => candidate.userId === userId);
  if (index >= 0) {
    candidates[index] = {
      ...candidates[index]!,
      status,
      reviewedAt: now,
      reviewedByUserId: 'preview-admin',
      reviewReason: payload.reason ?? null,
      falsePositive: payload.action === 'SUPPRESS',
      observations:
        payload.action === 'SUPPRESS'
          ? candidates[index]!.observations.map((observation) => ({
              ...observation,
              suppressedAt: now,
              suppressionReason: payload.reason ?? 'REVIEW_SUPPRESSION',
            }))
          : candidates[index]!.observations,
    };
  }

  return globalSpammerReviewResultSchema.parse({
    ok: true,
    userId,
    status,
  });
}

export function createManualViolation(
  userId: string,
  user: {
    displayName: string;
    avatarUrl: string | null;
    profileUrl: string | null;
    profileHandoffUrl: string | null;
  },
  payload: ManualModerationActionRequest,
  clock: PreviewClock,
): LogsDashboardResponse['violations'][number] {
  const now = readPreviewClock(clock);
  const nowMs = now.getTime();

  if (payload.action === 'UNMUTE') {
    return {
      id: `manual-unmute-${nowMs}`,
      action: 'NONE',
      ruleCode: 'MANUAL_UNMUTE',
      userId,
      userDisplayName: user.displayName,
      avatarUrl: user.avatarUrl,
      profileUrl: user.profileUrl,
      profileHandoffUrl: user.profileHandoffUrl,
      createdAt: now.toISOString(),
      maskedExcerpt: null,
      metadata: null,
    };
  }

  if (payload.action === 'UNBAN') {
    return {
      id: `manual-unban-${nowMs}`,
      action: 'NONE',
      ruleCode: 'MANUAL_UNBAN',
      userId,
      userDisplayName: user.displayName,
      avatarUrl: user.avatarUrl,
      profileUrl: user.profileUrl,
      profileHandoffUrl: user.profileHandoffUrl,
      createdAt: now.toISOString(),
      maskedExcerpt: null,
      metadata: null,
    };
  }

  if (payload.action === 'MUTE') {
    return {
      id: `manual-mute-${nowMs}`,
      action: 'MUTE',
      ruleCode: 'MANUAL_MUTE',
      userId,
      userDisplayName: user.displayName,
      avatarUrl: user.avatarUrl,
      profileUrl: user.profileUrl,
      profileHandoffUrl: user.profileHandoffUrl,
      createdAt: now.toISOString(),
      maskedExcerpt: null,
      metadata: {
        scope: payload.scope ?? 'current_chat',
        muteDurationHours: payload.muteDurationHours ?? 24,
        muteExpiresAt: addHours(now, payload.muteDurationHours ?? 24).toISOString(),
      },
    };
  }

  return {
    id: `manual-ban-${nowMs}`,
    action: 'BAN',
    ruleCode: 'MANUAL_BAN',
    userId,
    userDisplayName: user.displayName,
    avatarUrl: user.avatarUrl,
    profileUrl: user.profileUrl,
    profileHandoffUrl: user.profileHandoffUrl,
    createdAt: now.toISOString(),
    maskedExcerpt: null,
    metadata: {
      scope: payload.scope ?? 'current_chat',
    },
  };
}

export function resolvePreviewUser(
  state: PreviewState,
  userId: string,
): {
  displayName: string;
  avatarUrl: string | null;
  profileUrl: string | null;
  profileHandoffUrl: string | null;
} {
  const fromParticipants = state.chatParticipants.find((item) => item.userId === userId) ?? null;
  const fromActivity = state.chatActivity.find((item) => item.userId === userId) ?? null;
  const fromViolation = state.chatViolations.find((item) => item.userId === userId) ?? null;
  const snapshot = fromParticipants ?? fromActivity ?? fromViolation;

  return {
    displayName: snapshot?.userDisplayName?.trim() || 'Участник',
    avatarUrl: snapshot?.avatarUrl ?? null,
    profileUrl: snapshot?.profileUrl ?? null,
    profileHandoffUrl: snapshot?.profileHandoffUrl ?? null,
  };
}
