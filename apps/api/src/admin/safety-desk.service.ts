import {
  safetyDeskApproveAllRequestSchema,
  safetyDeskAllowAmbiguousSendRetryRequestSchema,
  safetyDeskDecisionRequestSchema,
  safetyDeskDecisionResponseSchema,
  safetyDeskDeleteRuntimeResponseSchema,
  safetyDeskGiveawayNotificationLookupSchema,
  safetyDeskRetryDeleteIntentRequestSchema,
  safetyDeskQueueResponseSchema,
  type SafetyDeskAuditEntry,
  type SafetyDeskDecisionResponse,
  type SafetyDeskDeleteCapabilityReason,
  type SafetyDeskDeleteCapabilityState,
  type SafetyDeskDeleteIntentItem,
  type SafetyDeskDeleteIntentStatus,
  type SafetyDeskDeleteIntentStatusCounts,
  type SafetyDeskDeleteMembershipCapability,
  type SafetyDeskDeleteRuntimeResponse,
  type SafetyDeskGiveawayWinnerNotificationDeadEndStatus,
  type SafetyDeskQueueItem,
  type SafetyDeskQueueResponse,
  type SafetyDeskRiskLevel,
} from '@maxim/contracts/safety-desk';
import {
  CHANNEL_POST_SIGNATURE_DEFAULT_TEXT,
  channelPostSignatureUrlSchema,
} from '@maxim/contracts';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ChannelPostSignaturePresentation,
  ChatEntityType,
  Prisma,
  VkParsingOwnerProfile,
} from '../prisma/prisma-client';
import {
  isConfirmedMembershipAccessSnapshot,
  normalizeMembershipAccessSnapshot,
} from '../max/max-bot-access-policy.util';
import { resolveDeleteMessageAccessFailure } from '../max/max-delete-message-access.util';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { canExecuteActionsForBotState } from '../max/max-bot-state.util';
import {
  MAX_SEND_AMBIGUOUS_ERROR_PREFIX,
  MAX_SEND_FENCE_STALE_MS,
} from '../max/max-send-ambiguity.util';
import {
  MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_RULE_CODES,
  ModerationDeleteIntentService,
} from '../moderation/moderation-delete-intent.service';
import { NIGHT_MODE_CLOSE_NOTICE_CLEANUP_RULE_CODE } from '../moderation/night-mode-close-notice-cleanup-binding';
import { PrismaService } from '../prisma/prisma.service';
import {
  containsSupportedMarkdownUrl,
  extractSupportedMarkdownLinks,
  renderSupportedMarkdownAsHtml,
  stripSupportedMarkdownToPlainText,
} from '../common/max-markdown.util';
import { extractUrlsFromText } from '../common/url-text.util';
import {
  prepareVkParsingPublishPayload,
  resolveEffectiveVkParsingTextFormat,
  resolveVkParsingPostSkipReason,
  type PreparedVkPublishPayload,
  type VkParsingTextFormat,
} from './vk-parsing-content';
import { VkPublishService } from './vk-publish.service';
import { VkParsingOwnershipService } from './vk-parsing-ownership.service';

type ReviewPostRow = Prisma.VkParsingPostGetPayload<{
  include: {
    chat: {
      select: {
        title: true;
        entityType: true;
        vkParsingSettings: {
          where: {
            ownerProfile: typeof VkParsingOwnerProfile.PUBLISHER;
            ownerBotId: string;
          };
          take: 1;
        };
        channelSettings: {
          select: {
            postSignatureEnabled: true;
            postSignaturePresentation: true;
            postSignatureText: true;
            postSignatureUrl: true;
          };
        };
      };
    };
    source: true;
  };
}>;
type SafetyAuditRow = Prisma.AuditLogGetPayload<Record<string, never>>;

type DeleteIntentDiagnosticRow = {
  id: string;
  chatId: string;
  messageId: string;
  subjectUserId: string | null;
  entityType: ChatEntityType | null;
  originBotId: string | null;
  routingPolicy: string;
  messageAuthorKind: string | null;
  retentionOwned: boolean;
  status: SafetyDeskDeleteIntentStatus;
  executeAt: Date;
  nextAttemptAt: Date;
  retryUntilAt: Date;
  attemptCount: number;
  lastBotId: string | null;
  succeededBotId: string | null;
  lastStatusCode: number | null;
  lastErrorCode: string | null;
  lastError: string | null;
  firstAttemptAt: Date | null;
  lastAttemptAt: Date | null;
  completedAt: Date | null;
  leaseExpiresAt: Date | null;
  deleteDispatchStartedAt: Date | null;
  deleteDispatchStartedBotId: string | null;
  remoteDeleteSucceededAt: Date | null;
  remoteDeleteSucceededBotId: string | null;
  createdAt: Date;
  updatedAt: Date;
  chat: {
    title: string;
    entityType: ChatEntityType;
    routingState: 'READY' | 'NO_ELIGIBLE_BOT';
    botMemberships: Array<{
      botId: string;
      role: 'PRIMARY' | 'STANDBY';
      permissionsSnapshot: unknown;
      botAccessState:
        | 'UNKNOWN'
        | 'CONFIRMED_OWNER'
        | 'CONFIRMED_ADMIN'
        | 'CONFIRMED_MEMBER'
        | 'DENIED'
        | 'LOST'
        | 'STALE';
      botAccessCheckedAt: Date | null;
      botAccessExpiresAt: Date | null;
    }>;
  };
  reasons: Array<{
    reasonKey: string;
    ruleCode: string;
    userId: string | null;
    score: number;
    createdAt: Date;
  }>;
};

const SAFETY_DESK_ACTOR_USER_ID = 'safety-desk-owner';
const VK_SOURCE_STATUS_ACTIVE = 'ACTIVE';
const VK_SOURCE_PUBLISH_MODE_REVIEW = 'REVIEW';
const VK_POST_STATUS_NEW = 'NEW';
const VK_POST_STATUS_FAILED = 'FAILED';
const VK_POST_STATUS_PUBLISHED = 'PUBLISHED';
const VK_POST_STATUS_UNAVAILABLE = 'UNAVAILABLE';
const VK_POST_STATUS_SKIPPED = 'SKIPPED';
const SAFETY_DESK_AUDIT_PREFIX = 'SAFETY_DESK_';
const SAFETY_DESK_TRUSTED_DOMAIN_ROOTS = ['max.ru', 'vk.ru', 'vk.com'];
const DELETE_INTENT_ATTENTION_LIMIT = 100;
const DELETE_INTENT_COMPLETED_LIMIT = 25;
const AMBIGUOUS_SEND_LIMIT = 100;
const GIVEAWAY_WINNER_NOTIFICATION_DEAD_END_LIMIT = 50;
const SAFETY_DESK_LAST_ERROR_LIMIT = 1_000;
const DELETE_INTENT_REASON_LIMIT = 10;
const DELETE_INTENT_MEMBERSHIP_LIMIT = 20;
const NIGHT_MODE_TRANSITION_RUNTIME_LIMIT = 50;
const NIGHT_MODE_TRANSITION_RUNTIME_MAX_OFFSET = 1_000;
const NIGHT_MODE_TRANSITION_MANUAL_CATEGORIES = [
  'unsafe_prior_dispatch',
  'unsafe_prior_provenance',
  'no_fresh_access',
  'failed_job_unclassified',
] as const;
type NightModeTransitionManualCategory = (typeof NIGHT_MODE_TRANSITION_MANUAL_CATEGORIES)[number];
type NightModeTransitionRuntimeState =
  | 'DUE'
  | 'DEFERRED'
  | 'LEASED'
  | 'STALE_LEASE'
  | 'MANUAL_BLOCKED'
  | 'ACKNOWLEDGED';
type NightModeTransitionRuntimeRow = {
  chatId: string;
  chatTitle: string | null;
  entityType: ChatEntityType | null;
  generation: bigint;
  firstRequestedAt: Date;
  requestedAt: Date;
  attemptCount: number;
  lastAttemptAt: Date | null;
  lastErrorCode: string | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  leaseExpiresAt: Date | null;
  manualBlockedAt: Date | null;
  manualBlockedReason: string | null;
  manualBlockedCategory: NightModeTransitionManualCategory | null;
  manualBlockedJobId: string | null;
  manualBlockedLedgerJobId: string | null;
  manualBlockedSessionKey: string | null;
  manualBlockedFingerprint: string | null;
  manualBlockedGeneration: bigint | null;
  manualAcknowledgedAt: Date | null;
  state: NightModeTransitionRuntimeState;
};
type NightModeTransitionSummaryRow = {
  total: number;
  due: number;
  deferred: number;
  leased: number;
  staleLeases: number;
  manualBlocked: number;
  acknowledged: number;
  oldestDueAt: Date | null;
  oldestStaleLeaseAt: Date | null;
  oldestManualBlockedAt: Date | null;
};
type NightModeTransitionManualActionInput = {
  generation: bigint;
  manualBlockedGeneration: bigint;
  manualBlockedAt: Date;
  category: NightModeTransitionManualCategory;
  fingerprint: string;
  reason: string;
};
const DELETE_INTENT_STATUSES = [
  'OBSERVED',
  'PENDING',
  'IN_PROGRESS',
  'RETRYABLE',
  'WAITING_CAPABILITY',
  'AMBIGUOUS',
  'SUCCEEDED',
  'ALREADY_ABSENT',
  'EXPIRED',
  'FAILED_TERMINAL',
] as const satisfies readonly SafetyDeskDeleteIntentStatus[];
const DELETE_INTENT_OPEN_STATUSES = [
  'PENDING',
  'IN_PROGRESS',
  'RETRYABLE',
  'WAITING_CAPABILITY',
  'AMBIGUOUS',
] as const satisfies readonly SafetyDeskDeleteIntentStatus[];
const DELETE_INTENT_DUE_STATUSES = [
  'PENDING',
  'RETRYABLE',
  'WAITING_CAPABILITY',
  'AMBIGUOUS',
] as const satisfies readonly SafetyDeskDeleteIntentStatus[];
const DELETE_INTENT_RECENT_STATUSES = [
  'OBSERVED',
  ...DELETE_INTENT_OPEN_STATUSES,
  'EXPIRED',
  'FAILED_TERMINAL',
] as const satisfies readonly SafetyDeskDeleteIntentStatus[];
const DELETE_INTENT_COMPLETED_STATUSES = [
  'SUCCEEDED',
  'ALREADY_ABSENT',
] as const satisfies readonly SafetyDeskDeleteIntentStatus[];
const GIVEAWAY_WINNER_NOTIFICATION_DEAD_END_STATUSES = [
  'AMBIGUOUS',
  'FAILED_TERMINAL',
] as const satisfies readonly SafetyDeskGiveawayWinnerNotificationDeadEndStatus[];
const DELETE_INTENT_DIAGNOSTIC_SELECT = {
  id: true,
  chatId: true,
  messageId: true,
  subjectUserId: true,
  entityType: true,
  originBotId: true,
  routingPolicy: true,
  messageAuthorKind: true,
  retentionOwned: true,
  status: true,
  executeAt: true,
  nextAttemptAt: true,
  retryUntilAt: true,
  attemptCount: true,
  lastBotId: true,
  succeededBotId: true,
  lastStatusCode: true,
  lastErrorCode: true,
  lastError: true,
  firstAttemptAt: true,
  lastAttemptAt: true,
  completedAt: true,
  leaseExpiresAt: true,
  deleteDispatchStartedAt: true,
  deleteDispatchStartedBotId: true,
  remoteDeleteSucceededAt: true,
  remoteDeleteSucceededBotId: true,
  createdAt: true,
  updatedAt: true,
  chat: {
    select: {
      title: true,
      entityType: true,
      routingState: true,
      botMemberships: {
        where: { status: 'ACTIVE' },
        orderBy: [{ role: 'asc' }, { updatedAt: 'desc' }],
        take: DELETE_INTENT_MEMBERSHIP_LIMIT,
        select: {
          botId: true,
          role: true,
          permissionsSnapshot: true,
          botAccessState: true,
          botAccessCheckedAt: true,
          botAccessExpiresAt: true,
        },
      },
    },
  },
  reasons: {
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: DELETE_INTENT_REASON_LIMIT,
    select: {
      reasonKey: true,
      ruleCode: true,
      userId: true,
      score: true,
      createdAt: true,
    },
  },
} satisfies Prisma.ModerationDeleteIntentSelect;
const GIVEAWAY_WINNER_NOTIFICATION_DIAGNOSTIC_SELECT = {
  id: true,
  winnerId: true,
  status: true,
  nextAttemptAt: true,
  attemptCount: true,
  lockedAt: true,
  dispatchedAt: true,
  botId: true,
  lastError: true,
  ambiguousAt: true,
  createdAt: true,
  updatedAt: true,
  winner: {
    select: {
      entry: { select: { userId: true } },
      giveaway: {
        select: {
          id: true,
          title: true,
          sourceChatId: true,
        },
      },
    },
  },
} satisfies Prisma.ManagedGiveawayWinnerNotificationSelect;
type GiveawayWinnerNotificationDiagnosticRow = Prisma.ManagedGiveawayWinnerNotificationGetPayload<{
  select: typeof GIVEAWAY_WINNER_NOTIFICATION_DIAGNOSTIC_SELECT;
}>;
const SAFETY_DESK_BLOCKED_APPROVE_MESSAGE =
  'Этот материал нельзя опубликовать автоматически: есть неподдерживаемые вложения или после фильтрации не осталось текста, фото или ссылок.';

@Injectable()
export class SafetyDeskService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vkPublishService: VkPublishService,
    private readonly maxBotRegistry: MaxBotRegistryService,
    private readonly moderationDeleteIntents: ModerationDeleteIntentService,
    private readonly vkParsingOwnership: VkParsingOwnershipService,
  ) {}

  async getQueue(): Promise<SafetyDeskQueueResponse> {
    const [posts, audit, approved, rejected] = await Promise.all([
      this.loadReviewPosts(),
      this.loadAuditEntries(),
      this.prisma.auditLog.count({ where: { action: 'SAFETY_DESK_APPROVE' } }),
      this.prisma.auditLog.count({ where: { action: 'SAFETY_DESK_REJECT' } }),
    ]);
    const items = posts.map((post) => this.mapReviewPost(post));
    const blocked = items.filter((item) => item.status === 'BLOCKED').length;

    return safetyDeskQueueResponseSchema.parse({
      generatedAt: new Date().toISOString(),
      items,
      summary: {
        review: items.filter((item) => item.status === 'REVIEW').length,
        approved,
        rejected,
        blocked,
        servicePosts: 0,
      },
      audit,
    });
  }

  async getGiveawayNotificationDeadEnd(id: string) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(id)) {
      throw new BadRequestException('Некорректный ID уведомления.');
    }
    const row = await this.prisma.managedGiveawayWinnerNotification.findUnique({
      where: { id, status: { in: [...GIVEAWAY_WINNER_NOTIFICATION_DEAD_END_STATUSES] } },
      select: GIVEAWAY_WINNER_NOTIFICATION_DIAGNOSTIC_SELECT,
    });
    return safetyDeskGiveawayNotificationLookupSchema.parse({
      item: row ? this.mapGiveawayWinnerNotificationDeadEnd(row) : null,
    });
  }

  private mapGiveawayWinnerNotificationDeadEnd(row: GiveawayWinnerNotificationDiagnosticRow) {
    return {
      notificationId: row.id,
      giveawayId: row.winner.giveaway.id,
      giveawayTitle: row.winner.giveaway.title,
      sourceChatId: row.winner.giveaway.sourceChatId,
      winnerId: row.winnerId,
      userId: row.winner.entry.userId,
      botId: row.botId,
      status: row.status,
      attemptCount: row.attemptCount,
      lastError: this.sanitizeSafetyDeskLastError(row.lastError),
      nextAttemptAt: row.nextAttemptAt.toISOString(),
      lockedAt: row.lockedAt?.toISOString() ?? null,
      dispatchedAt: row.dispatchedAt?.toISOString() ?? null,
      ambiguousAt: row.ambiguousAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async getDeleteRuntime(): Promise<SafetyDeskDeleteRuntimeResponse> {
    const now = new Date();
    const staleSendFenceBefore = new Date(now.getTime() - MAX_SEND_FENCE_STALE_MS);
    const staleChannelAutoPostClaimWhere = {
      status: 'IN_PROGRESS' as const,
      replacementMessageId: null,
      replyMessageId: null,
      OR: [
        { lockedAt: { lte: staleSendFenceBefore } },
        { lockedAt: null, updatedAt: { lte: staleSendFenceBefore } },
      ],
    };
    const openStatuses = [...DELETE_INTENT_OPEN_STATUSES];
    const dueStatuses = [...DELETE_INTENT_DUE_STATUSES];
    const recentStatuses = [...DELETE_INTENT_RECENT_STATUSES];
    const completedStatuses = [...DELETE_INTENT_COMPLETED_STATUSES];
    const [
      statusGroups,
      due,
      staleLeases,
      oldestOpen,
      recentRows,
      recentCompletedRows,
      channelAmbiguousReplacementSends,
      staleChannelAutoPostClaims,
      chatAmbiguousReplacementSends,
      rulesAmbiguousSends,
      recentChannelAmbiguousSends,
      recentStaleChannelAutoPostClaims,
      recentChatAmbiguousSends,
      recentRulesAmbiguousSends,
      giveawayWinnerNotificationDeadEndGroups,
      giveawayWinnerNotificationDeadEndRows,
      pendingGiveawayResults,
    ] = await Promise.all([
      this.prisma.moderationDeleteIntent.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
      this.prisma.moderationDeleteIntent.aggregate({
        where: {
          status: { in: dueStatuses },
          executeAt: { lte: now },
          nextAttemptAt: { lte: now },
          OR: [
            { retryUntilAt: { gt: now } },
            {
              remoteDeleteSucceededAt: { not: null },
              remoteDeleteSucceededBotId: { not: null },
            },
            {
              deleteDispatchStartedAt: { not: null },
              deleteDispatchStartedBotId: { not: null },
            },
          ],
        },
        _count: { _all: true },
        _min: { nextAttemptAt: true },
      }),
      this.prisma.moderationDeleteIntent.aggregate({
        where: {
          status: 'IN_PROGRESS',
          leaseExpiresAt: { lte: now },
        },
        _count: { _all: true },
        _min: { leaseExpiresAt: true },
      }),
      this.prisma.moderationDeleteIntent.aggregate({
        where: { status: { in: openStatuses } },
        _min: { createdAt: true },
      }),
      this.prisma.moderationDeleteIntent.findMany({
        where: { status: { in: recentStatuses } },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: DELETE_INTENT_ATTENTION_LIMIT,
        select: DELETE_INTENT_DIAGNOSTIC_SELECT,
      }),
      this.prisma.moderationDeleteIntent.findMany({
        where: { status: { in: completedStatuses } },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: DELETE_INTENT_COMPLETED_LIMIT,
        select: DELETE_INTENT_DIAGNOSTIC_SELECT,
      }),
      this.prisma.channelAutoPostAttachMarker.aggregate({
        where: {
          status: 'SKIPPED',
          replacementMessageId: null,
          replacementSendStartedAt: { not: null },
          lastError: { startsWith: MAX_SEND_AMBIGUOUS_ERROR_PREFIX },
        },
        _count: { _all: true },
        _min: { replacementSendStartedAt: true },
      }),
      this.prisma.channelAutoPostAttachMarker.aggregate({
        where: staleChannelAutoPostClaimWhere,
        _count: { _all: true },
        _min: { updatedAt: true },
      }),
      this.prisma.chatAutoCommentAttachMarker.aggregate({
        where: {
          status: 'SKIPPED',
          replacementMessageId: null,
          replacementSendStartedAt: { not: null },
          lastError: { startsWith: MAX_SEND_AMBIGUOUS_ERROR_PREFIX },
        },
        _count: { _all: true },
        _min: { replacementSendStartedAt: true },
      }),
      this.prisma.chatRules.aggregate({
        where: { publishSendStartedAt: { lte: staleSendFenceBefore } },
        _count: { _all: true },
        _min: { publishSendStartedAt: true },
      }),
      this.prisma.channelAutoPostAttachMarker.findMany({
        where: {
          status: 'SKIPPED',
          replacementMessageId: null,
          replacementSendStartedAt: { not: null },
          lastError: { startsWith: MAX_SEND_AMBIGUOUS_ERROR_PREFIX },
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: AMBIGUOUS_SEND_LIMIT,
        select: {
          id: true,
          chatId: true,
          messageId: true,
          botId: true,
          replacementSendStartedAt: true,
          lastError: true,
          updatedAt: true,
          chat: { select: { title: true } },
        },
      }),
      this.prisma.channelAutoPostAttachMarker.findMany({
        where: staleChannelAutoPostClaimWhere,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: AMBIGUOUS_SEND_LIMIT,
        select: {
          id: true,
          chatId: true,
          messageId: true,
          botId: true,
          lastError: true,
          updatedAt: true,
          chat: { select: { title: true } },
        },
      }),
      this.prisma.chatAutoCommentAttachMarker.findMany({
        where: {
          status: 'SKIPPED',
          replacementMessageId: null,
          replacementSendStartedAt: { not: null },
          lastError: { startsWith: MAX_SEND_AMBIGUOUS_ERROR_PREFIX },
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: AMBIGUOUS_SEND_LIMIT,
        select: {
          id: true,
          chatId: true,
          messageId: true,
          botId: true,
          replacementSendStartedAt: true,
          lastError: true,
          updatedAt: true,
          chat: { select: { title: true } },
        },
      }),
      this.prisma.chatRules.findMany({
        where: { publishSendStartedAt: { lte: staleSendFenceBefore } },
        orderBy: [{ publishSendStartedAt: 'desc' }, { id: 'desc' }],
        take: AMBIGUOUS_SEND_LIMIT,
        select: {
          id: true,
          chatId: true,
          publishOperationId: true,
          publishOperationBotId: true,
          publishSendStartedAt: true,
          updatedAt: true,
          chat: { select: { title: true } },
        },
      }),
      this.prisma.managedGiveawayWinnerNotification.groupBy({
        by: ['status'],
        where: {
          status: { in: [...GIVEAWAY_WINNER_NOTIFICATION_DEAD_END_STATUSES] },
        },
        _count: { _all: true },
        _min: { updatedAt: true },
      }),
      this.prisma.managedGiveawayWinnerNotification.findMany({
        where: {
          status: { in: [...GIVEAWAY_WINNER_NOTIFICATION_DEAD_END_STATUSES] },
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: GIVEAWAY_WINNER_NOTIFICATION_DEAD_END_LIMIT,
        select: GIVEAWAY_WINNER_NOTIFICATION_DIAGNOSTIC_SELECT,
      }),
      this.prisma.managedGiveawayResultsSync.findMany({
        where: {
          nextAttemptAt: { not: null },
          giveaway: { archivedAt: null, status: 'COMPLETED' },
        },
        orderBy: [{ nextAttemptAt: 'asc' }, { giveawayId: 'asc' }],
        take: 51,
        select: {
          giveawayId: true,
          attempts: true,
          nextAttemptAt: true,
          leaseUntil: true,
          giveaway: {
            select: {
              title: true,
              sourceChatId: true,
              winners: {
                where: { status: 'SELECTED', claimDeadlineAt: { not: null } },
                select: { claimDeadlineAt: true },
                orderBy: { claimDeadlineAt: 'asc' },
                take: 1,
              },
            },
          },
        },
      }),
    ]);

    const statusCounts = this.buildDeleteIntentStatusCounts(statusGroups);
    const oldestOpenAt = oldestOpen._min.createdAt;
    const diagnosticRows = [
      ...(recentRows as DeleteIntentDiagnosticRow[]),
      ...(recentCompletedRows as DeleteIntentDiagnosticRow[]),
    ].sort(
      (left, right) =>
        right.updatedAt.getTime() - left.updatedAt.getTime() || right.id.localeCompare(left.id),
    );
    const replacementCleanupReasons =
      diagnosticRows.length > 0
        ? await this.prisma.moderationDeleteIntentReason.findMany({
            where: {
              intentId: { in: Array.from(new Set(diagnosticRows.map((row) => row.id))) },
              ruleCode: {
                in: [...MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_RULE_CODES],
              },
            },
            select: { intentId: true, ruleCode: true },
            distinct: ['intentId', 'ruleCode'],
          })
        : [];
    const replacementRuleCodesByIntent = new Map<string, string[]>();
    for (const reason of replacementCleanupReasons) {
      const ruleCodes = replacementRuleCodesByIntent.get(reason.intentId) ?? [];
      ruleCodes.push(reason.ruleCode);
      replacementRuleCodesByIntent.set(reason.intentId, ruleCodes);
    }
    const items = diagnosticRows.map((row) =>
      this.mapDeleteIntent(row, now, replacementRuleCodesByIntent.get(row.id) ?? []),
    );
    const oldestAmbiguousSendAt = [
      channelAmbiguousReplacementSends._min.replacementSendStartedAt,
      staleChannelAutoPostClaims._min.updatedAt,
      chatAmbiguousReplacementSends._min.replacementSendStartedAt,
      rulesAmbiguousSends._min.publishSendStartedAt,
    ]
      .filter((value): value is Date => value instanceof Date)
      .sort((left, right) => left.getTime() - right.getTime())[0];
    const ambiguousSends = [
      ...recentChannelAmbiguousSends.map((row) => ({
        id: `channel_auto_post:${row.id}`,
        source: 'channel_auto_post' as const,
        chatId: row.chatId,
        chatTitle: row.chat.title,
        messageId: row.messageId,
        botId: row.botId,
        startedAt: (row.replacementSendStartedAt ?? row.updatedAt).toISOString(),
        detectedAt: row.updatedAt.toISOString(),
        lastError: row.lastError ?? `${MAX_SEND_AMBIGUOUS_ERROR_PREFIX} Unknown send result`,
      })),
      ...recentStaleChannelAutoPostClaims.map((row) => {
        const lastError = this.sanitizeSafetyDeskLastError(row.lastError);
        return {
          id: `channel_auto_post:${row.id}`,
          source: 'channel_auto_post' as const,
          chatId: row.chatId,
          chatTitle: row.chat.title,
          messageId: row.messageId,
          botId: row.botId,
          startedAt: row.updatedAt.toISOString(),
          detectedAt: row.updatedAt.toISOString(),
          lastError: lastError
            ? `Stale channel auto-post claim: ${lastError}`
            : 'Stale channel auto-post claim has no durable failure classification.',
        };
      }),
      ...recentChatAmbiguousSends.map((row) => ({
        id: `chat_auto_comment:${row.id}`,
        source: 'chat_auto_comment' as const,
        chatId: row.chatId,
        chatTitle: row.chat.title,
        messageId: row.messageId,
        botId: row.botId,
        startedAt: (row.replacementSendStartedAt ?? row.updatedAt).toISOString(),
        detectedAt: row.updatedAt.toISOString(),
        lastError: row.lastError ?? `${MAX_SEND_AMBIGUOUS_ERROR_PREFIX} Unknown send result`,
      })),
      ...recentRulesAmbiguousSends.map((row) => ({
        id: `chat_rules:${row.id}`,
        source: 'chat_rules' as const,
        chatId: row.chatId,
        chatTitle: row.chat.title,
        messageId: row.publishOperationId,
        botId: row.publishOperationBotId,
        startedAt: (row.publishSendStartedAt ?? row.updatedAt).toISOString(),
        detectedAt: row.updatedAt.toISOString(),
        lastError: `${MAX_SEND_AMBIGUOUS_ERROR_PREFIX} Chat rules publication has no persisted remote message id.`,
      })),
    ]
      .sort((left, right) => right.detectedAt.localeCompare(left.detectedAt))
      .slice(0, AMBIGUOUS_SEND_LIMIT);
    const giveawayWinnerNotificationDeadEndCounts: Record<
      SafetyDeskGiveawayWinnerNotificationDeadEndStatus,
      number
    > = {
      AMBIGUOUS: 0,
      FAILED_TERMINAL: 0,
    };
    let oldestGiveawayWinnerNotificationDeadEndAt: Date | null = null;
    for (const group of giveawayWinnerNotificationDeadEndGroups) {
      if (group.status in giveawayWinnerNotificationDeadEndCounts) {
        giveawayWinnerNotificationDeadEndCounts[
          group.status as SafetyDeskGiveawayWinnerNotificationDeadEndStatus
        ] = Math.max(0, group._count._all);
      }
      const updatedAt = group._min.updatedAt;
      if (
        updatedAt &&
        (!oldestGiveawayWinnerNotificationDeadEndAt ||
          updatedAt < oldestGiveawayWinnerNotificationDeadEndAt)
      ) {
        oldestGiveawayWinnerNotificationDeadEndAt = updatedAt;
      }
    }
    const giveawayWinnerNotificationDeadEnds = giveawayWinnerNotificationDeadEndRows.map((row) =>
      this.mapGiveawayWinnerNotificationDeadEnd(row),
    );

    return safetyDeskDeleteRuntimeResponseSchema.parse({
      generatedAt: now.toISOString(),
      rolloutMode: this.moderationDeleteIntents.rolloutMode,
      replacementCleanupEnabled: this.moderationDeleteIntents.replacementCleanupRolloutEnabled,
      summary: {
        total: DELETE_INTENT_STATUSES.reduce((sum, status) => sum + statusCounts[status], 0),
        open: DELETE_INTENT_OPEN_STATUSES.reduce((sum, status) => sum + statusCounts[status], 0),
        failed: statusCounts.EXPIRED + statusCounts.FAILED_TERMINAL,
        statusCounts,
        due: {
          count: due._count._all,
          oldestAt: due._min.nextAttemptAt?.toISOString() ?? null,
        },
        staleLeases: {
          count: staleLeases._count._all,
          oldestAt: staleLeases._min.leaseExpiresAt?.toISOString() ?? null,
        },
        ambiguousSends: {
          count:
            channelAmbiguousReplacementSends._count._all +
            staleChannelAutoPostClaims._count._all +
            chatAmbiguousReplacementSends._count._all +
            rulesAmbiguousSends._count._all,
          oldestAt: oldestAmbiguousSendAt?.toISOString() ?? null,
        },
        giveawayWinnerNotificationDeadEnds: {
          count:
            giveawayWinnerNotificationDeadEndCounts.AMBIGUOUS +
            giveawayWinnerNotificationDeadEndCounts.FAILED_TERMINAL,
          ambiguous: giveawayWinnerNotificationDeadEndCounts.AMBIGUOUS,
          failedTerminal: giveawayWinnerNotificationDeadEndCounts.FAILED_TERMINAL,
          oldestAt: oldestGiveawayWinnerNotificationDeadEndAt?.toISOString() ?? null,
        },
        oldestOpen: {
          createdAt: oldestOpenAt?.toISOString() ?? null,
          ageMs: oldestOpenAt ? Math.max(0, now.getTime() - oldestOpenAt.getTime()) : null,
        },
      },
      items,
      ambiguousSends,
      giveawayWinnerNotificationDeadEnds,
      giveawayPendingResults: {
        hasMore: pendingGiveawayResults.length > 50,
        items: pendingGiveawayResults.slice(0, 50).flatMap((row) => {
          const due = row.nextAttemptAt;
          if (!due) return [];
          const processing = row.leaseUntil !== null && row.leaseUntil > now;
          return [
            {
              giveawayId: row.giveawayId,
              title: row.giveaway.title,
              sourceChatId: row.giveaway.sourceChatId,
              status: processing ? 'PROCESSING' : due <= now ? 'DUE' : 'WAITING',
              nextAttemptAt: due.toISOString(),
              attempts: row.attempts,
              overdueMs: processing ? 0 : Math.max(0, now.getTime() - due.getTime()),
              claimDeadlineAt: row.giveaway.winners[0]?.claimDeadlineAt?.toISOString() ?? null,
            },
          ];
        }),
      },
    });
  }

  async getNightModeTransitionRuntime(offsetInput?: unknown) {
    const offset = this.parseNightModeTransitionRuntimeOffset(offsetInput);
    const now = new Date();
    const [summaryRows, categoryRows, rows] = await Promise.all([
      this.prisma.$queryRaw<NightModeTransitionSummaryRow[]>(Prisma.sql`
        SELECT
          COUNT(*)::int AS "total",
          COUNT(*) FILTER (
            WHERE (
                request."manual_blocked_at" IS NULL
                OR request."generation" > request."manual_blocked_generation"
              )
              AND request."requested_at" <= ${now}
              AND (
                request."lease_token" IS NULL
                OR request."lease_expires_at" < ${now}
              )
          )::int AS "due",
          COUNT(*) FILTER (
            WHERE (
                request."manual_blocked_at" IS NULL
                OR request."generation" > request."manual_blocked_generation"
              )
              AND request."requested_at" > ${now}
          )::int AS "deferred",
          COUNT(*) FILTER (
            WHERE (
                request."manual_blocked_at" IS NULL
                OR request."generation" > request."manual_blocked_generation"
              )
              AND request."lease_token" IS NOT NULL
              AND request."lease_expires_at" >= ${now}
          )::int AS "leased",
          COUNT(*) FILTER (
            WHERE (
                request."manual_blocked_at" IS NULL
                OR request."generation" > request."manual_blocked_generation"
              )
              AND request."lease_token" IS NOT NULL
              AND request."lease_expires_at" < ${now}
          )::int AS "staleLeases",
          COUNT(*) FILTER (
            WHERE request."manual_blocked_at" IS NOT NULL
              AND request."generation" = request."manual_blocked_generation"
              AND request."manual_acknowledged_at" IS NULL
          )::int
            AS "manualBlocked",
          COUNT(*) FILTER (
            WHERE request."manual_blocked_at" IS NOT NULL
              AND request."generation" = request."manual_blocked_generation"
              AND request."manual_acknowledged_at" IS NOT NULL
          )::int
            AS "acknowledged",
          MIN(request."first_requested_at") FILTER (
            WHERE (
                request."manual_blocked_at" IS NULL
                OR request."generation" > request."manual_blocked_generation"
              )
              AND request."requested_at" <= ${now}
              AND (
                request."lease_token" IS NULL
                OR request."lease_expires_at" < ${now}
              )
          ) AS "oldestDueAt",
          MIN(request."lease_expires_at") FILTER (
            WHERE (
                request."manual_blocked_at" IS NULL
                OR request."generation" > request."manual_blocked_generation"
              )
              AND request."lease_token" IS NOT NULL
              AND request."lease_expires_at" < ${now}
          ) AS "oldestStaleLeaseAt",
          MIN(request."manual_blocked_at") FILTER (
            WHERE request."manual_blocked_at" IS NOT NULL
              AND request."generation" = request."manual_blocked_generation"
              AND request."manual_acknowledged_at" IS NULL
          ) AS "oldestManualBlockedAt"
        FROM "night_mode_transition_reconcile_requests" request
      `),
      this.prisma.$queryRaw<Array<{ category: string; count: number }>>(Prisma.sql`
        SELECT
          request."manual_blocked_category" AS "category",
          COUNT(*)::int AS "count"
        FROM "night_mode_transition_reconcile_requests" request
        WHERE request."manual_blocked_at" IS NOT NULL
          AND request."generation" = request."manual_blocked_generation"
          AND request."manual_acknowledged_at" IS NULL
        GROUP BY request."manual_blocked_category"
        ORDER BY COUNT(*) DESC, request."manual_blocked_category" ASC
      `),
      this.prisma.$queryRaw<NightModeTransitionRuntimeRow[]>(Prisma.sql`
        SELECT
          request."chat_id" AS "chatId",
          chat."title" AS "chatTitle",
          chat."entity_type" AS "entityType",
          request."generation" AS "generation",
          request."first_requested_at" AS "firstRequestedAt",
          request."requested_at" AS "requestedAt",
          request."attempt_count" AS "attemptCount",
          request."last_attempt_at" AS "lastAttemptAt",
          request."last_error_code" AS "lastErrorCode",
          request."last_error_at" AS "lastErrorAt",
          request."last_error" AS "lastError",
          request."lease_expires_at" AS "leaseExpiresAt",
          request."manual_blocked_at" AS "manualBlockedAt",
          request."manual_blocked_reason" AS "manualBlockedReason",
          request."manual_blocked_category" AS "manualBlockedCategory",
          request."manual_blocked_job_id" AS "manualBlockedJobId",
          request."manual_blocked_ledger_job_id" AS "manualBlockedLedgerJobId",
          request."manual_blocked_session_key" AS "manualBlockedSessionKey",
          request."manual_blocked_fingerprint" AS "manualBlockedFingerprint",
          request."manual_blocked_generation" AS "manualBlockedGeneration",
          request."manual_acknowledged_at" AS "manualAcknowledgedAt",
          CASE
            WHEN request."manual_blocked_at" IS NOT NULL
              AND request."generation" = request."manual_blocked_generation"
              AND request."manual_acknowledged_at" IS NULL
              THEN 'MANUAL_BLOCKED'
            WHEN request."manual_blocked_at" IS NOT NULL
              AND request."generation" = request."manual_blocked_generation"
              AND request."manual_acknowledged_at" IS NOT NULL
              THEN 'ACKNOWLEDGED'
            WHEN request."lease_token" IS NOT NULL
              AND request."lease_expires_at" < ${now} THEN 'STALE_LEASE'
            WHEN request."lease_token" IS NOT NULL THEN 'LEASED'
            WHEN request."requested_at" <= ${now} THEN 'DUE'
            ELSE 'DEFERRED'
          END AS "state"
        FROM "night_mode_transition_reconcile_requests" request
        LEFT JOIN "chats" chat ON chat."id" = request."chat_id"
        ORDER BY
          CASE
            WHEN request."manual_blocked_at" IS NOT NULL
              AND request."generation" = request."manual_blocked_generation"
              AND request."manual_acknowledged_at" IS NULL THEN 0
            WHEN request."manual_blocked_at" IS NOT NULL
              AND request."generation" = request."manual_blocked_generation"
              AND request."manual_acknowledged_at" IS NOT NULL THEN 5
            WHEN request."lease_token" IS NOT NULL
              AND request."lease_expires_at" < ${now} THEN 1
            WHEN request."requested_at" <= ${now} THEN 2
            WHEN request."lease_token" IS NOT NULL THEN 3
            ELSE 4
          END ASC,
          COALESCE(
            request."manual_blocked_at",
            request."lease_expires_at",
            request."first_requested_at"
          ) ASC,
          request."chat_id" ASC
        LIMIT ${NIGHT_MODE_TRANSITION_RUNTIME_LIMIT + 1}
        OFFSET ${offset}
      `),
    ]);
    const summary = summaryRows[0];
    const categoryCounts = Object.fromEntries(
      NIGHT_MODE_TRANSITION_MANUAL_CATEGORIES.map((category) => [category, 0]),
    ) as Record<NightModeTransitionManualCategory, number>;
    for (const row of categoryRows) {
      if (this.isNightModeTransitionManualCategory(row.category)) {
        categoryCounts[row.category] = Math.max(0, Number(row.count) || 0);
      }
    }
    const items = rows.slice(0, NIGHT_MODE_TRANSITION_RUNTIME_LIMIT).map((row) => ({
      chatId: row.chatId,
      chatTitle: row.chatTitle,
      entityType: row.entityType,
      generation: row.generation.toString(),
      state: row.state,
      firstRequestedAt: row.firstRequestedAt.toISOString(),
      requestedAt: row.requestedAt.toISOString(),
      attemptCount: row.attemptCount,
      lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
      lastErrorCode: row.lastErrorCode?.trim().slice(0, 120) || null,
      lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
      lastError: this.sanitizeSafetyDeskLastError(row.lastError),
      leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
      manualBlockedAt: row.manualBlockedAt?.toISOString() ?? null,
      manualBlockedCategory: row.manualBlockedCategory,
      manualBlockedReason: this.sanitizeSafetyDeskLastError(row.manualBlockedReason),
      manualBlockedGeneration: row.manualBlockedGeneration?.toString() ?? null,
      manualAcknowledgedAt: row.manualAcknowledgedAt?.toISOString() ?? null,
      context: row.manualBlockedAt
        ? {
            jobId: row.manualBlockedJobId,
            ledgerJobId: row.manualBlockedLedgerJobId,
            sessionKey: row.manualBlockedSessionKey,
            fingerprint: row.manualBlockedFingerprint,
          }
        : null,
      allowedActions:
        row.manualBlockedAt &&
        row.manualBlockedGeneration === row.generation &&
        row.manualAcknowledgedAt === null
          ? ['ACKNOWLEDGE', ...(row.manualBlockedCategory === 'no_fresh_access' ? ['RETRY'] : [])]
          : [],
    }));

    const truncated = rows.length > NIGHT_MODE_TRANSITION_RUNTIME_LIMIT;
    const nextOffset = offset + NIGHT_MODE_TRANSITION_RUNTIME_LIMIT;

    return {
      generatedAt: now.toISOString(),
      offset,
      nextOffset:
        truncated && nextOffset <= NIGHT_MODE_TRANSITION_RUNTIME_MAX_OFFSET ? nextOffset : null,
      summary: {
        total: Math.max(0, Number(summary?.total) || 0),
        due: Math.max(0, Number(summary?.due) || 0),
        deferred: Math.max(0, Number(summary?.deferred) || 0),
        leased: Math.max(0, Number(summary?.leased) || 0),
        staleLeases: Math.max(0, Number(summary?.staleLeases) || 0),
        manualBlocked: Math.max(0, Number(summary?.manualBlocked) || 0),
        acknowledged: Math.max(0, Number(summary?.acknowledged) || 0),
        categoryCounts,
        oldestDueAt: summary?.oldestDueAt?.toISOString() ?? null,
        oldestStaleLeaseAt: summary?.oldestStaleLeaseAt?.toISOString() ?? null,
        oldestManualBlockedAt: summary?.oldestManualBlockedAt?.toISOString() ?? null,
      },
      items,
      truncated,
    };
  }

  async acknowledgeNightModeTransitionBlock(
    chatId: string,
    actorUserId: string | null,
    input: unknown,
  ) {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      throw new BadRequestException('Укажите chatId night mode запроса.');
    }
    const expected = this.parseNightModeTransitionManualActionInput(input);
    const acknowledgedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.nightModeTransitionReconcileRequest.findUnique({
        where: { chatId: normalizedChatId },
      });
      this.assertNightModeTransitionManualActionMatches(current, expected);
      const acknowledged = await tx.nightModeTransitionReconcileRequest.updateMany({
        where: this.buildNightModeTransitionManualActionWhere(normalizedChatId, expected),
        data: {
          manualAcknowledgedAt: acknowledgedAt,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      if (acknowledged.count !== 1) {
        throw new ConflictException('Состояние night mode изменилось. Обновите Safety Desk.');
      }
      await tx.auditLog.create({
        data: {
          chatId: normalizedChatId,
          actorUserId: this.resolveActor(actorUserId),
          action: 'SAFETY_DESK_ACK_NIGHT_MODE_RECONCILE',
          payload: this.toJsonInput({
            operatorReason: expected.reason,
            generation: expected.generation.toString(),
            manualBlockedGeneration: expected.manualBlockedGeneration.toString(),
            manualBlockedAt: expected.manualBlockedAt.toISOString(),
            acknowledgedAt: acknowledgedAt.toISOString(),
            category: expected.category,
            fingerprint: expected.fingerprint,
          }),
        },
      });
    });
    return this.getNightModeTransitionRuntime();
  }

  async retryNightModeTransitionBlock(chatId: string, actorUserId: string | null, input: unknown) {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      throw new BadRequestException('Укажите chatId night mode запроса.');
    }
    const expected = this.parseNightModeTransitionManualActionInput(input);
    if (expected.category !== 'no_fresh_access') {
      throw new BadRequestException(
        'Автоповтор разрешён только после восстановления свежего подтверждённого доступа.',
      );
    }
    const requestedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.nightModeTransitionReconcileRequest.findUnique({
        where: { chatId: normalizedChatId },
      });
      this.assertNightModeTransitionManualActionMatches(current, expected);
      const retried = await tx.nightModeTransitionReconcileRequest.updateMany({
        where: this.buildNightModeTransitionManualActionWhere(normalizedChatId, expected),
        data: {
          generation: { increment: 1n },
          firstRequestedAt: requestedAt,
          requestedAt,
          attemptCount: 0,
          lastAttemptAt: null,
          lastErrorCode: null,
          lastErrorAt: null,
          lastError: null,
          leaseToken: null,
          leaseExpiresAt: null,
          manualBlockedAt: null,
          manualBlockedReason: null,
          manualBlockedCategory: null,
          manualBlockedJobId: null,
          manualBlockedLedgerJobId: null,
          manualBlockedSessionKey: null,
          manualBlockedFingerprint: null,
          manualBlockedGeneration: null,
          manualAcknowledgedAt: null,
        },
      });
      if (retried.count !== 1) {
        throw new ConflictException('Состояние night mode изменилось. Обновите Safety Desk.');
      }
      await tx.auditLog.create({
        data: {
          chatId: normalizedChatId,
          actorUserId: this.resolveActor(actorUserId),
          action: 'SAFETY_DESK_RETRY_NIGHT_MODE_RECONCILE',
          payload: this.toJsonInput({
            operatorReason: expected.reason,
            previousGeneration: expected.generation.toString(),
            nextGeneration: (expected.generation + 1n).toString(),
            manualBlockedGeneration: expected.manualBlockedGeneration.toString(),
            manualBlockedAt: expected.manualBlockedAt.toISOString(),
            category: expected.category,
            fingerprint: expected.fingerprint,
          }),
        },
      });
    });
    return this.getNightModeTransitionRuntime();
  }

  async clearAmbiguousSendFence(
    itemId: string,
    actorUserId: string | null,
    input: unknown,
  ): Promise<SafetyDeskDeleteRuntimeResponse> {
    const parsed = safetyDeskAllowAmbiguousSendRetryRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException('Укажите операцию отправки, проверенную в MAX.');
    }
    const [source, sourceId] = itemId.split(':', 2);
    if (source !== 'chat_rules' || !sourceId?.trim()) {
      throw new BadRequestException(
        'Автоматический повтор доступен только для неопределённой публикации правил.',
      );
    }

    const expectedStartedAt = new Date(parsed.data.expectedStartedAt);
    const staleBefore = new Date(Date.now() - MAX_SEND_FENCE_STALE_MS);
    if (expectedStartedAt > staleBefore) {
      throw new BadRequestException('Операция ещё не считается зависшей.');
    }
    await this.prisma.$transaction(async (tx) => {
      const rules = await tx.chatRules.findUnique({
        where: { id: sourceId },
        select: {
          id: true,
          chatId: true,
          publishOperationId: true,
          publishOperationBotId: true,
          publishSendStartedAt: true,
        },
      });
      if (
        !rules?.publishSendStartedAt ||
        rules.publishOperationId !== parsed.data.expectedOperationId ||
        rules.publishSendStartedAt.getTime() !== expectedStartedAt.getTime()
      ) {
        throw new ConflictException('Состояние публикации изменилось. Обновите Safety Desk.');
      }
      const cleared = await tx.chatRules.updateMany({
        where: {
          id: rules.id,
          publishOperationId: parsed.data.expectedOperationId,
          publishSendStartedAt: expectedStartedAt,
        },
        data: {
          publishOperationId: null,
          publishOperationBotId: null,
          publishSendStartedAt: null,
        },
      });
      if (cleared.count !== 1) {
        throw new ConflictException('Состояние публикации изменилось. Обновите Safety Desk.');
      }
      await tx.auditLog.create({
        data: {
          chatId: rules.chatId,
          actorUserId: actorUserId?.trim() || SAFETY_DESK_ACTOR_USER_ID,
          action: 'SAFETY_DESK_CLEAR_AMBIGUOUS_SEND_FENCE',
          payload: {
            source: 'chat_rules',
            sourceId: rules.id,
            operationId: rules.publishOperationId,
            botId: rules.publishOperationBotId,
            sendStartedAt: rules.publishSendStartedAt.toISOString(),
          },
        },
      });
    });

    return this.getDeleteRuntime();
  }

  async retryDeleteIntent(
    intentId: string,
    actorUserId: string | null,
    input: unknown,
  ): Promise<SafetyDeskDeleteRuntimeResponse> {
    const parsed = safetyDeskRetryDeleteIntentRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException('Укажите актуальный terminal-статус удаления.');
    }

    const intent = await this.prisma.moderationDeleteIntent.findUnique({
      where: { id: intentId },
      select: {
        id: true,
        chatId: true,
        status: true,
        updatedAt: true,
        attemptCount: true,
        retentionOwned: true,
        reasons: {
          where: {
            ruleCode: {
              in: [
                ...MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_RULE_CODES,
                NIGHT_MODE_CLOSE_NOTICE_CLEANUP_RULE_CODE,
              ],
            },
          },
          select: { ruleCode: true },
        },
      },
    });
    if (!intent) {
      throw new NotFoundException('Удаление не найдено.');
    }
    if (intent.retentionOwned)
      throw new BadRequestException('Для очистки используйте отдельный раздел старых сообщений.');
    const rollout = this.moderationDeleteIntents.getRolloutForRuleCodes(
      intent.chatId,
      intent.reasons.map((reason) => reason.ruleCode),
    );
    if (rollout !== 'execute') {
      throw new BadRequestException('Повтор запрещён вне активного rollout для этого чата.');
    }
    if (
      intent.status !== parsed.data.expectedStatus ||
      intent.updatedAt.toISOString() !== parsed.data.expectedUpdatedAt ||
      intent.attemptCount !== parsed.data.expectedAttemptCount
    ) {
      throw new ConflictException('Состояние удаления изменилось. Обновите Safety Desk.');
    }

    const retried = await this.moderationDeleteIntents.retryTerminalIntent(
      intent.id,
      parsed.data.expectedStatus,
      {
        updatedAt: new Date(parsed.data.expectedUpdatedAt),
        attemptCount: parsed.data.expectedAttemptCount,
      },
      { actorUserId: this.resolveActor(actorUserId) },
    );
    if (!retried.reopened) {
      throw new ConflictException('Состояние удаления изменилось. Обновите Safety Desk.');
    }
    return this.getDeleteRuntime();
  }

  async approveItem(
    itemId: string,
    actorUserId: string | null,
    body: unknown,
  ): Promise<SafetyDeskDecisionResponse> {
    const parsed = safetyDeskDecisionRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const post = await this.findReviewPostOrThrow(itemId, { includeCancelled: false });
    const item = this.mapReviewPost(post);
    if (!this.isApprovableItem(item)) {
      throw new BadRequestException(this.buildNotApprovableMessage(item));
    }

    await this.approveReviewPost(post, actorUserId, parsed.data.reason ?? null);

    return safetyDeskDecisionResponseSchema.parse({
      item: null,
      queue: await this.getQueue(),
      message: 'Материал одобрен и принят в очередь публикации в MAX.',
    });
  }

  async approveAllReviewItems(
    actorUserId: string | null,
    body: unknown,
  ): Promise<SafetyDeskDecisionResponse> {
    const parsed = safetyDeskApproveAllRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const itemIds = [...new Set(parsed.data.itemIds)];
    const candidates = (await this.loadReviewPosts({ itemIds })).filter((post) =>
      this.isApprovableItem(this.mapReviewPost(post)),
    );
    let approved = 0;
    let failed = 0;

    for (const post of candidates) {
      try {
        await this.approveReviewPost(post, actorUserId, parsed.data.reason ?? null);
        approved += 1;
      } catch {
        failed += 1;
      }
    }

    return safetyDeskDecisionResponseSchema.parse({
      item: null,
      queue: await this.getQueue(),
      message: this.buildApproveAllMessage(approved, failed, candidates.length, itemIds.length),
    });
  }

  async rejectItem(
    itemId: string,
    actorUserId: string | null,
    body: unknown,
  ): Promise<SafetyDeskDecisionResponse> {
    const parsed = safetyDeskDecisionRequestSchema.safeParse(body ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const post = await this.findReviewPostOrThrow(itemId, { includeCancelled: false });
    const now = new Date();
    const updated = await this.prisma.vkParsingPost.updateMany({
      where: {
        ...this.buildReviewPostWhere(post.id, { includeCancelled: false }),
        publishLockedAt: null,
      },
      data: {
        publishQueuedAt: null,
        publishScheduledAt: null,
        publishCancelledAt: now,
        publishCancelledByUserId: this.resolveActor(actorUserId),
        publishLockedAt: null,
        publishIdempotencyKey: null,
        publishReason: null,
      },
    });
    if (updated.count === 0) {
      throw new NotFoundException('Материал проверки уже обработан или недоступен.');
    }
    await this.writeAuditLog(post.chatId, actorUserId, 'SAFETY_DESK_REJECT', {
      postId: post.id,
      sourceId: post.sourceId,
      itemTitle: this.buildTitle(post),
      reason: parsed.data.reason ?? null,
    });

    return safetyDeskDecisionResponseSchema.parse({
      item: null,
      queue: await this.getQueue(),
      message: 'Материал отклонен. В MAX ничего не отправлено.',
    });
  }

  async recheckItem(
    itemId: string,
    actorUserId: string | null,
  ): Promise<SafetyDeskDecisionResponse> {
    const post = await this.findReviewPostOrThrow(itemId, { includeCancelled: true });
    if (this.hasAmbiguousMaxSendError(post.lastError)) {
      throw new BadRequestException(
        'MAX мог уже принять эту публикацию. Сначала сверьте сообщение в MAX вручную; повторная отправка через Safety Desk заблокирована.',
      );
    }
    const updated = await this.prisma.vkParsingPost.updateMany({
      where: {
        ...this.buildReviewPostWhere(post.id, { includeCancelled: true }),
        publishCancelledAt: post.publishCancelledAt,
        publishLockedAt: null,
      },
      data: {
        status: post.status === VK_POST_STATUS_FAILED ? VK_POST_STATUS_NEW : post.status,
        publishCancelledAt: null,
        publishCancelledByUserId: null,
        publishLockedAt: null,
        publishIdempotencyKey: null,
        publishReason: null,
        lastError: null,
        autoPublishError: null,
      },
    });
    if (updated.count === 0) {
      throw new NotFoundException('Материал проверки уже обработан или недоступен.');
    }
    const refreshed = await this.findReviewPostOrThrow(itemId, { includeCancelled: true });
    const item = this.mapReviewPost(refreshed);
    await this.writeAuditLog(refreshed.chatId, actorUserId, 'SAFETY_DESK_RECHECK', {
      postId: refreshed.id,
      sourceId: refreshed.sourceId,
      itemTitle: item.title,
    });

    return safetyDeskDecisionResponseSchema.parse({
      item,
      queue: await this.getQueue(),
      message: 'Материал возвращен на проверку.',
    });
  }

  private async loadReviewPosts(options: { itemIds?: string[] } = {}): Promise<ReviewPostRow[]> {
    const ownerScope = this.vkParsingOwnership.getPublisherScope();
    const posts = await this.prisma.vkParsingPost.findMany({
      where: {
        ...ownerScope,
        ...(options.itemIds ? { id: { in: options.itemIds } } : {}),
        status: { in: [VK_POST_STATUS_NEW, VK_POST_STATUS_FAILED] },
        publishCancelledAt: null,
        publishQueuedAt: null,
        publishLockedAt: null,
        publishIdempotencyKey: null,
        skippedAt: null,
        unavailableAt: null,
        hasUnsupportedAttachments: false,
        OR: [
          { text: { not: '' } },
          { photoUrls: { not: [] } },
          { videoUrls: { not: [] } },
          { linkUrls: { not: [] } },
        ],
        source: {
          ...ownerScope,
          status: VK_SOURCE_STATUS_ACTIVE,
          publishMode: VK_SOURCE_PUBLISH_MODE_REVIEW,
        },
      },
      include: {
        chat: {
          select: {
            title: true,
            entityType: true,
            vkParsingSettings: {
              where: {
                ...ownerScope,
              },
              take: 1,
            },
            channelSettings: {
              select: {
                postSignatureEnabled: true,
                postSignaturePresentation: true,
                postSignatureText: true,
                postSignatureUrl: true,
              },
            },
          },
        },
        source: true,
      },
      orderBy: [{ vkPublishedAt: 'desc' }, { createdAt: 'desc' }],
      take: options.itemIds ? Math.max(1, options.itemIds.length) : 100,
    });

    return posts.filter((post) => this.hasPublishableContent(post));
  }

  private async findReviewPostOrThrow(
    itemId: string,
    options: { includeCancelled: boolean },
  ): Promise<ReviewPostRow> {
    const ownerScope = this.vkParsingOwnership.getPublisherScope();
    const post = await this.prisma.vkParsingPost.findFirst({
      where: this.buildReviewPostWhere(itemId, options),
      include: {
        chat: {
          select: {
            title: true,
            entityType: true,
            vkParsingSettings: {
              where: {
                ...ownerScope,
              },
              take: 1,
            },
            channelSettings: {
              select: {
                postSignatureEnabled: true,
                postSignaturePresentation: true,
                postSignatureText: true,
                postSignatureUrl: true,
              },
            },
          },
        },
        source: true,
      },
    });

    if (!post) {
      throw new NotFoundException('Материал проверки не найден.');
    }

    return post;
  }

  private buildReviewPostWhere(
    itemId: string,
    options: { includeCancelled: boolean },
  ): Prisma.VkParsingPostWhereInput {
    const ownerScope = this.vkParsingOwnership.getPublisherScope();
    return {
      id: itemId,
      ...ownerScope,
      status: {
        notIn: [VK_POST_STATUS_PUBLISHED, VK_POST_STATUS_UNAVAILABLE, VK_POST_STATUS_SKIPPED],
      },
      skippedAt: null,
      unavailableAt: null,
      ...(options.includeCancelled ? {} : { publishCancelledAt: null }),
      publishQueuedAt: null,
      publishLockedAt: null,
      publishIdempotencyKey: null,
      source: {
        ...ownerScope,
        status: VK_SOURCE_STATUS_ACTIVE,
        publishMode: VK_SOURCE_PUBLISH_MODE_REVIEW,
      },
    };
  }

  private async loadAuditEntries(): Promise<SafetyDeskAuditEntry[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: { action: { startsWith: SAFETY_DESK_AUDIT_PREFIX } },
      orderBy: [{ createdAt: 'desc' }],
      take: 30,
    });

    return rows.map((row) => this.mapAuditEntry(row));
  }

  private mapReviewPost(post: ReviewPostRow): SafetyDeskQueueItem {
    const photoUrls = this.readStringArray(post.photoUrls);
    const videoUrls = this.readStringArray(post.videoUrls);
    const linkUrls = this.readStringArray(post.linkUrls);
    const textFormat = this.resolveReviewPostTextFormat(post);
    const prepared = this.preparePublishPayload(post, photoUrls, videoUrls, linkUrls);
    const preparedLinkUrls = prepared?.linkUrls ?? linkUrls;
    const reviewText = prepared?.text ?? post.text;
    const reviewTextFormat = prepared?.textFormat ?? textFormat;
    const visibleText =
      reviewTextFormat === 'markdown' ? stripSupportedMarkdownToPlainText(reviewText) : reviewText;
    const inlineLinkUrls = [
      ...(reviewTextFormat === 'markdown' ? extractSupportedMarkdownLinks(reviewText) : []),
      ...extractUrlsFromText(visibleText).map((url) => this.normalizeReviewUrl(url)),
    ];
    const signatureUrl = this.resolveReviewPostSignatureUrl(post);
    const reviewLinkUrls = [
      ...new Set([...preparedLinkUrls, ...inlineLinkUrls, ...(signatureUrl ? [signatureUrl] : [])]),
    ];
    const domains = this.extractDomains([post.url, ...reviewLinkUrls]);
    const risk = this.resolveRisk(post, prepared, domains, photoUrls, videoUrls);
    const reasons = this.buildReasons(post, prepared, domains, photoUrls, videoUrls);
    const checks = this.buildChecks(post, prepared, domains, photoUrls, videoUrls);
    const status =
      risk === 'BLOCKED' || checks.some((check) => check.state === 'BLOCKED')
        ? 'BLOCKED'
        : 'REVIEW';

    return {
      id: post.id,
      source: 'VK_REVIEW',
      sourceId: post.sourceId,
      chatId: post.chatId,
      entityTitle: this.buildEntityTitle(post),
      sourceTitle: post.source.title,
      author: post.source.title || 'Внешний источник',
      status,
      risk,
      title: this.buildTitle(post),
      text: post.text,
      textFormat,
      previewHtml: this.buildReviewPreviewHtml(post, prepared),
      domains,
      photoUrls,
      videoUrls,
      linkUrls: reviewLinkUrls,
      originalUrl: post.url || null,
      scheduledAt: post.publishScheduledAt ? post.publishScheduledAt.toISOString() : null,
      createdAt: post.createdAt.toISOString(),
      updatedAt: post.updatedAt.toISOString(),
      reasons,
      checks,
    };
  }

  private buildReasons(
    post: ReviewPostRow,
    prepared: PreparedVkPublishPayload | null,
    domains: string[],
    photoUrls: string[],
    videoUrls: string[],
  ): string[] {
    const reasons = ['Источник настроен на ручную проверку перед публикацией'];

    if (post.status === VK_POST_STATUS_FAILED || post.lastError) {
      reasons.push(
        `Предыдущая попытка остановлена: ${post.lastError ?? 'требуется повторная проверка'}`,
      );
    }
    if (domains.length > 0) {
      reasons.push('Найдены внешние ссылки');
    }
    if (photoUrls.length > 0 || videoUrls.length > 0) {
      reasons.push(`Медиа вложения: ${photoUrls.length + videoUrls.length}`);
    }
    if (post.hasUnsupportedAttachments) {
      reasons.push('Есть вложения, которые нельзя безопасно перенести автоматически');
    }
    if (!prepared) {
      reasons.push('После правил публикации не осталось текста, фото, видео или ссылок');
    }
    if (post.isAdvertising || this.readStringArray(post.advertisingMarkers).length > 0) {
      reasons.push('Найдены коммерческие маркеры, нужна ручная оценка');
    }
    if (post.publishScheduledAt) {
      reasons.push('Материал был поставлен в отложенную публикацию');
    }

    return reasons;
  }

  private buildChecks(
    post: ReviewPostRow,
    prepared: PreparedVkPublishPayload | null,
    domains: string[],
    photoUrls: string[],
    videoUrls: string[],
  ): SafetyDeskQueueItem['checks'] {
    return [
      {
        label: 'Принудительное добавление пользователей не используется',
        state: 'PASSED',
      },
      {
        label:
          post.isAdvertising || this.readStringArray(post.advertisingMarkers).length > 0
            ? 'Коммерческие маркеры требуют ручной оценки'
            : 'Запрещенные категории не обнаружены автоматически',
        state:
          post.isAdvertising || this.readStringArray(post.advertisingMarkers).length > 0
            ? 'WARNING'
            : 'PASSED',
      },
      {
        label: domains.length > 0 ? 'Ссылки извлечены для проверки' : 'Внешних ссылок нет',
        state: domains.length > 0 ? 'WARNING' : 'PASSED',
      },
      {
        label: prepared
          ? 'Есть поддерживаемый текст, фото, видео или ссылка'
          : 'После правил публикации не осталось текста, фото, видео или ссылок',
        state: prepared ? 'PASSED' : 'BLOCKED',
      },
      {
        label:
          photoUrls.length > 0 && videoUrls.length > 0
            ? 'В одном VK-посте нельзя безопасно смешать фото и видео'
            : 'Формат медиа пригоден для публикации',
        state: photoUrls.length > 0 && videoUrls.length > 0 ? 'BLOCKED' : 'PASSED',
      },
      {
        label: post.hasUnsupportedAttachments
          ? 'Есть неподдерживаемые вложения'
          : 'Вложения пригодны для безопасной публикации',
        state: post.hasUnsupportedAttachments ? 'BLOCKED' : 'PASSED',
      },
      {
        label: 'До решения владельца в MAX ничего не отправляется',
        state: 'PASSED',
      },
    ];
  }

  private isApprovableItem(item: SafetyDeskQueueItem): boolean {
    return item.status === 'REVIEW' && item.checks.every((check) => check.state !== 'BLOCKED');
  }

  private buildNotApprovableMessage(item: SafetyDeskQueueItem): string {
    const blockedReasons = item.checks
      .filter((check) => check.state === 'BLOCKED')
      .map((check) => check.label);

    if (blockedReasons.length === 0) {
      const reason = item.reasons[0]?.trim();
      return reason
        ? `Этот материал нельзя опубликовать автоматически: ${reason}.`
        : SAFETY_DESK_BLOCKED_APPROVE_MESSAGE;
    }

    return `Этот материал нельзя опубликовать автоматически: ${blockedReasons.join('; ')}.`;
  }

  private hasAmbiguousMaxSendError(lastError: string | null): boolean {
    return lastError?.trim().startsWith(MAX_SEND_AMBIGUOUS_ERROR_PREFIX) === true;
  }

  private resolveRisk(
    post: ReviewPostRow,
    prepared: PreparedVkPublishPayload | null,
    domains: string[],
    photoUrls: string[],
    videoUrls: string[],
  ): SafetyDeskRiskLevel {
    if (!prepared || post.status === VK_POST_STATUS_FAILED || post.lastError) {
      return 'BLOCKED';
    }
    if (post.hasUnsupportedAttachments) {
      return 'HIGH';
    }
    if (post.isAdvertising || this.readStringArray(post.advertisingMarkers).length > 0) {
      return 'HIGH';
    }
    if (domains.length > 0 || photoUrls.length > 0 || videoUrls.length > 0) {
      return 'MEDIUM';
    }
    return 'LOW';
  }

  private mapAuditEntry(row: SafetyAuditRow): SafetyDeskAuditEntry {
    const payload = this.asRecord(row.payload) ?? {};
    return {
      id: row.id,
      itemId: this.readString(payload.postId) || null,
      action: row.action,
      title: this.readString(payload.itemTitle) || this.auditActionLabel(row.action),
      createdAt: row.createdAt.toISOString(),
    };
  }

  private buildTitle(post: ReviewPostRow): string {
    const firstLine = post.text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean);
    if (firstLine) {
      return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
    }
    if (post.source.title) {
      return `Публикация из ${post.source.title}`;
    }
    return `Материал ${post.vkOwnerId}_${post.vkPostId}`;
  }

  private buildReviewPreviewHtml(
    post: ReviewPostRow,
    prepared: PreparedVkPublishPayload | null,
  ): string {
    const text = prepared?.text ?? post.text;
    const textFormat = prepared?.textFormat ?? this.resolveReviewPostTextFormat(post);
    const baseHtml = text.trim()
      ? textFormat === 'markdown'
        ? renderSupportedMarkdownAsHtml(text, { linkMode: 'underline' })
        : `<p>${escapeSafetyDeskHtml(text).replace(/\r?\n/gu, '<br>')}</p>`
      : '';
    const selectedLinkHtml =
      textFormat === 'markdown'
        ? (prepared?.linkUrls ?? [])
            .filter((url) => !containsSupportedMarkdownUrl(text, url))
            .map((url) => `<p><u>${escapeSafetyDeskHtml(url)}</u></p>`)
            .join('')
        : '';
    const linkText = (
      post.chat.channelSettings?.postSignatureText ?? CHANNEL_POST_SIGNATURE_DEFAULT_TEXT
    ).trim();
    const signatureHtml =
      post.chat.entityType === ChatEntityType.CHANNEL &&
      post.chat.channelSettings?.postSignatureEnabled &&
      post.chat.channelSettings.postSignaturePresentation !==
        ChannelPostSignaturePresentation.BUTTON &&
      linkText
        ? `<p><u>${escapeSafetyDeskHtml(linkText)}</u></p>`
        : '';

    return `${baseHtml}${selectedLinkHtml}${signatureHtml}`;
  }

  private buildEntityTitle(post: ReviewPostRow): string {
    const prefix = post.chat.entityType === ChatEntityType.CHANNEL ? 'Канал' : 'Чат';
    return `${prefix}: ${post.chat.title || post.chatId}`;
  }

  private resolveReviewPostSignatureUrl(post: ReviewPostRow): string | null {
    const settings = post.chat.channelSettings;
    if (
      post.chat.entityType !== ChatEntityType.CHANNEL ||
      !settings?.postSignatureEnabled ||
      !settings.postSignatureUrl.trim()
    ) {
      return null;
    }

    const parsed = channelPostSignatureUrlSchema.safeParse(settings.postSignatureUrl);
    return parsed.success && parsed.data ? parsed.data : null;
  }

  private extractDomains(urls: string[]): string[] {
    const domains = new Set<string>();
    for (const url of urls) {
      try {
        const parsed = new URL(this.normalizeReviewUrl(url));
        if (parsed.protocol === 'max:') {
          continue;
        }
        const hostname = parsed.hostname.toLowerCase();
        if (hostname && !this.isTrustedDomain(hostname)) {
          domains.add(hostname);
        }
      } catch {
        continue;
      }
    }
    return [...domains].sort();
  }

  private normalizeReviewUrl(url: string): string {
    return /^(?:[a-z][a-z0-9+.-]*:)?\/\//iu.test(url) ? url : `https://${url}`;
  }

  private isTrustedDomain(hostname: string): boolean {
    const normalized = hostname.replace(/\.$/u, '');
    return SAFETY_DESK_TRUSTED_DOMAIN_ROOTS.some(
      (root) => normalized === root || normalized.endsWith(`.${root}`),
    );
  }

  private async approveReviewPost(
    post: ReviewPostRow,
    actorUserId: string | null,
    reason: string | null,
  ): Promise<void> {
    const photoUrls = this.readStringArray(post.photoUrls);
    const videoUrls = this.readStringArray(post.videoUrls);
    const linkUrls = this.readStringArray(post.linkUrls);
    const result = await this.vkPublishService.publishPost(
      post.chatId,
      post.id,
      SAFETY_DESK_ACTOR_USER_ID,
      {
        text: post.text,
        ...(this.resolveReviewPostTextFormat(post) === 'markdown'
          ? { textFormat: 'markdown' as const }
          : {}),
        photoUrls,
        videoUrls,
        linkUrls,
      },
    );
    if (result.queued < 1) {
      throw new NotFoundException('Материал проверки уже обработан или недоступен.');
    }
    await this.writeAuditLog(post.chatId, actorUserId, 'SAFETY_DESK_APPROVE', {
      postId: post.id,
      sourceId: post.sourceId,
      itemTitle: this.buildTitle(post),
      reason,
      queued: result.queued,
    });
  }

  private hasPublishableContent(post: ReviewPostRow): boolean {
    return Boolean(
      this.preparePublishPayload(
        post,
        this.readStringArray(post.photoUrls),
        this.readStringArray(post.videoUrls),
        this.readStringArray(post.linkUrls),
      ),
    );
  }

  private preparePublishPayload(
    post: ReviewPostRow,
    photoUrls: string[],
    videoUrls: string[],
    linkUrls: string[],
  ): PreparedVkPublishPayload | null {
    const settings = this.resolveVkParsingSettings(post);
    const preservedLinkUrls = this.resolveStripPreservedLinkUrls(post);
    const skipReason = resolveVkParsingPostSkipReason(
      {
        text: post.text,
        photoUrls,
        videoUrls,
        linkUrls,
        attachments: this.readRecords(post.attachments),
        raw: this.asRecord(post.raw) ?? {},
        isAdvertising: post.isAdvertising,
        advertisingMarkers: this.readStringArray(post.advertisingMarkers),
      },
      settings,
      { preserveLinkUrls: preservedLinkUrls },
    );
    if (skipReason) {
      return null;
    }

    const prepared = prepareVkParsingPublishPayload(
      {
        text: post.text,
        textFormat: this.resolveReviewPostTextFormat(post),
        photoUrls,
        videoUrls,
        linkUrls,
      },
      settings,
      { preserveLinkUrls: preservedLinkUrls },
    );
    if (
      prepared.text.trim().length === 0 &&
      prepared.photoUrls.length === 0 &&
      prepared.videoUrls.length === 0 &&
      prepared.linkUrls.length === 0
    ) {
      return null;
    }

    return prepared;
  }

  private resolveReviewPostTextFormat(
    post: Pick<ReviewPostRow, 'text' | 'textFormat' | 'manualContentEditedAt'>,
  ): VkParsingTextFormat {
    return resolveEffectiveVkParsingTextFormat({
      text: post.text,
      textFormat: post.textFormat,
      manualContentEditedAt: post.manualContentEditedAt,
    });
  }

  private resolveVkParsingSettings(post: ReviewPostRow) {
    const settings = post.chat.vkParsingSettings[0];
    return {
      stripLinksEnabled: settings?.stripLinksEnabled ?? false,
      skipAdsEnabled: settings?.skipAdsEnabled ?? false,
    };
  }

  private buildDeleteIntentStatusCounts(
    groups: ReadonlyArray<{ status: string; _count: { _all: number } }>,
  ): SafetyDeskDeleteIntentStatusCounts {
    const counts: SafetyDeskDeleteIntentStatusCounts = {
      OBSERVED: 0,
      PENDING: 0,
      IN_PROGRESS: 0,
      RETRYABLE: 0,
      WAITING_CAPABILITY: 0,
      AMBIGUOUS: 0,
      SUCCEEDED: 0,
      ALREADY_ABSENT: 0,
      EXPIRED: 0,
      FAILED_TERMINAL: 0,
    };
    const knownStatuses = new Set<string>(DELETE_INTENT_STATUSES);
    for (const group of groups) {
      if (knownStatuses.has(group.status)) {
        counts[group.status as SafetyDeskDeleteIntentStatus] = Math.max(0, group._count._all);
      }
    }
    return counts;
  }

  private parseNightModeTransitionRuntimeOffset(input: unknown): number {
    if (input === undefined) {
      return 0;
    }
    const encoded =
      typeof input === 'string' ? input : typeof input === 'number' ? String(input) : null;
    if (encoded === null || !/^\d+$/u.test(encoded)) {
      throw new BadRequestException('offset должен быть целым числом от 0 до 1000.');
    }
    const offset = Number(encoded);
    if (!Number.isSafeInteger(offset) || offset > NIGHT_MODE_TRANSITION_RUNTIME_MAX_OFFSET) {
      throw new BadRequestException('offset должен быть целым числом от 0 до 1000.');
    }
    return offset;
  }

  private isNightModeTransitionManualCategory(
    value: string,
  ): value is NightModeTransitionManualCategory {
    return (NIGHT_MODE_TRANSITION_MANUAL_CATEGORIES as readonly string[]).includes(value);
  }

  private parseNightModeTransitionManualActionInput(
    input: unknown,
  ): NightModeTransitionManualActionInput {
    const record =
      input !== null && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : null;
    const allowedKeys = new Set([
      'expectedGeneration',
      'expectedManualBlockedGeneration',
      'expectedManualBlockedAt',
      'expectedCategory',
      'expectedFingerprint',
      'reason',
    ]);
    if (!record || Object.keys(record).some((key) => !allowedKeys.has(key))) {
      throw new BadRequestException('Некорректный CAS-запрос night mode.');
    }
    const generation = this.parsePositiveBigInt(record.expectedGeneration);
    const manualBlockedGeneration = this.parsePositiveBigInt(
      record.expectedManualBlockedGeneration,
    );
    const manualBlockedAt = this.parseExactIsoDate(record.expectedManualBlockedAt);
    const category =
      typeof record.expectedCategory === 'string' &&
      this.isNightModeTransitionManualCategory(record.expectedCategory)
        ? record.expectedCategory
        : null;
    const fingerprint =
      typeof record.expectedFingerprint === 'string' &&
      /^sha256:[a-f0-9]{64}$/u.test(record.expectedFingerprint)
        ? record.expectedFingerprint
        : null;
    const reason =
      typeof record.reason === 'string'
        ? this.sanitizeSafetyDeskLastError(record.reason.slice(0, 500))
        : null;
    if (
      generation === null ||
      manualBlockedGeneration === null ||
      !manualBlockedAt ||
      !category ||
      !fingerprint ||
      !reason
    ) {
      throw new BadRequestException('Запрос night mode устарел или заполнен не полностью.');
    }
    return {
      generation,
      manualBlockedGeneration,
      manualBlockedAt,
      category,
      fingerprint,
      reason,
    };
  }

  private parsePositiveBigInt(value: unknown): bigint | null {
    if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/u.test(value)) {
      return null;
    }
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }

  private parseExactIsoDate(value: unknown): Date | null {
    if (typeof value !== 'string') {
      return null;
    }
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? parsed : null;
  }

  private assertNightModeTransitionManualActionMatches(
    current: {
      generation: bigint;
      manualBlockedAt: Date | null;
      manualBlockedCategory: string | null;
      manualBlockedFingerprint: string | null;
      manualBlockedGeneration: bigint | null;
      manualAcknowledgedAt: Date | null;
    } | null,
    expected: NightModeTransitionManualActionInput,
  ): void {
    if (!current) {
      throw new NotFoundException('Night mode reconcile request не найден.');
    }
    if (
      current.generation !== current.manualBlockedGeneration ||
      current.manualAcknowledgedAt !== null ||
      current.generation !== expected.generation ||
      current.manualBlockedGeneration !== expected.manualBlockedGeneration ||
      current.manualBlockedAt?.getTime() !== expected.manualBlockedAt.getTime() ||
      current.manualBlockedCategory !== expected.category ||
      current.manualBlockedFingerprint !== expected.fingerprint
    ) {
      throw new ConflictException('Состояние night mode изменилось. Обновите Safety Desk.');
    }
  }

  private buildNightModeTransitionManualActionWhere(
    chatId: string,
    expected: NightModeTransitionManualActionInput,
  ): Prisma.NightModeTransitionReconcileRequestWhereInput {
    return {
      chatId,
      generation: expected.generation,
      manualBlockedGeneration: expected.manualBlockedGeneration,
      manualBlockedAt: expected.manualBlockedAt,
      manualBlockedCategory: expected.category,
      manualBlockedFingerprint: expected.fingerprint,
      manualAcknowledgedAt: null,
    };
  }

  private sanitizeSafetyDeskLastError(value: string | null): string | null {
    const normalized = value?.trim().replace(/\s+/gu, ' ') ?? '';
    if (!normalized) {
      return null;
    }

    const redacted = normalized
      .replace(/\bhttps?:\/\/[^\s?]+\?[^\s]+/giu, (url) => `${url.split('?')[0]}?[redacted]`)
      .replace(/\b(authorization\s*[:=]\s*(?:bearer|initdata)\s+)[^\s,;]+/giu, '$1[redacted]')
      .replace(/\b(bearer|initdata)\s+[^\s,;]+/giu, '$1 [redacted]')
      .replace(
        /(\b(?:authorization|x-admin-access-code|access[_-]?token|refresh[_-]?token|init[_-]?data|secret|token)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
        '$1[redacted]',
      );

    return redacted.slice(0, SAFETY_DESK_LAST_ERROR_LIMIT);
  }

  private mapDeleteIntent(
    row: DeleteIntentDiagnosticRow,
    now: Date,
    replacementCleanupRuleCodes: readonly string[],
  ): SafetyDeskDeleteIntentItem {
    const entityType = row.entityType ?? row.chat.entityType;
    const routingPolicy = this.normalizeDeleteRoutingPolicy(row.routingPolicy);
    const replacementCleanup = replacementCleanupRuleCodes.length > 0;
    const effectiveRoutingPolicy = this.moderationDeleteIntents.resolveEffectiveRoutingPolicy({
      chatId: row.chatId,
      entityType,
      messageAuthorKind: row.messageAuthorKind,
      routingPolicy,
      replacementCleanup,
    });
    const crossBotEnabled = effectiveRoutingPolicy !== 'origin_only';
    const memberships = row.chat.botMemberships.map((membership) =>
      this.mapDeleteMembershipCapability(membership, entityType, now),
    );
    const confirmedBotIds = memberships
      .filter((membership) => membership.state === 'confirmed_capable')
      .map((membership) => membership.botId);
    const executableConfirmedBotIds =
      effectiveRoutingPolicy === 'origin_only'
        ? confirmedBotIds.filter((botId) => botId === row.originBotId)
        : confirmedBotIds;

    const rollout = this.moderationDeleteIntents.getRolloutForRuleCodes(
      row.chatId,
      replacementCleanupRuleCodes,
    );
    return {
      retentionOwned: row.retentionOwned === true,
      retryAllowed:
        row.retentionOwned !== true &&
        rollout === 'execute' &&
        ['FAILED_TERMINAL', 'EXPIRED'].includes(row.status),
      id: row.id,
      chatId: row.chatId,
      chatTitle: row.chat.title,
      messageId: row.messageId,
      subjectUserId: row.subjectUserId,
      entityType,
      originBotId: row.originBotId,
      routingPolicy,
      effectiveRoutingPolicy,
      crossBotEnabled,
      routingState: row.chat.routingState,
      rollout: this.moderationDeleteIntents.getRolloutForRuleCodes(
        row.chatId,
        replacementCleanupRuleCodes,
      ),
      status: row.status,
      ageMs: Math.max(0, now.getTime() - row.createdAt.getTime()),
      attemptCount: row.attemptCount,
      executeAt: row.executeAt.toISOString(),
      nextAttemptAt: row.nextAttemptAt.toISOString(),
      retryUntilAt: row.retryUntilAt.toISOString(),
      firstAttemptAt: row.firstAttemptAt?.toISOString() ?? null,
      lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      leaseExpiresAt: row.leaseExpiresAt?.toISOString() ?? null,
      deleteDispatchStartedAt: row.deleteDispatchStartedAt?.toISOString() ?? null,
      deleteDispatchStartedBotId: row.deleteDispatchStartedBotId,
      remoteDeleteSucceededAt: row.remoteDeleteSucceededAt?.toISOString() ?? null,
      remoteDeleteSucceededBotId: row.remoteDeleteSucceededBotId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      lastBotId: row.lastBotId,
      succeededBotId: row.succeededBotId,
      lastStatusCode: row.lastStatusCode,
      lastErrorCode: row.lastErrorCode,
      lastError: row.lastError,
      capability: {
        confirmed: executableConfirmedBotIds.length > 0,
        activeMembershipCount: memberships.length,
        confirmedBotIds: executableConfirmedBotIds,
        memberships,
      },
      reasons: row.reasons.map((reason) => ({
        reasonKey: reason.reasonKey,
        ruleCode: reason.ruleCode,
        userId: reason.userId,
        score: reason.score,
        createdAt: reason.createdAt.toISOString(),
      })),
    };
  }

  private mapDeleteMembershipCapability(
    membership: DeleteIntentDiagnosticRow['chat']['botMemberships'][number],
    entityType: ChatEntityType | null,
    now: Date,
  ): SafetyDeskDeleteMembershipCapability {
    const snapshot = normalizeMembershipAccessSnapshot(membership.permissionsSnapshot);
    const configuredBot = this.maxBotRegistry.getBotById(membership.botId);
    const botRuntimeState: SafetyDeskDeleteMembershipCapability['botRuntimeState'] =
      configuredBot?.state ?? 'unconfigured';
    const snapshotCheckedAt = this.toValidIsoString(snapshot?.checkedAt ?? null);
    const snapshotCheckedAtMs = snapshotCheckedAt ? Date.parse(snapshotCheckedAt) : Number.NaN;
    const membershipCheckedAtMs = membership.botAccessCheckedAt?.getTime() ?? Number.NaN;
    const checkedAtMs = Number.isFinite(membershipCheckedAtMs)
      ? membershipCheckedAtMs
      : snapshotCheckedAtMs;
    const expiresAtMs = membership.botAccessExpiresAt?.getTime() ?? Number.NaN;
    const base = {
      botId: membership.botId,
      role: membership.role,
      accessState: membership.botAccessState,
      botRuntimeState,
      checkedAt: Number.isFinite(checkedAtMs) ? new Date(checkedAtMs).toISOString() : null,
      expiresAt: Number.isFinite(expiresAtMs) ? new Date(expiresAtMs).toISOString() : null,
      snapshotCheckedAt,
      isAdmin: snapshot?.isAdmin ?? false,
      isOwner: snapshot?.isOwner ?? false,
      permissions: snapshot?.permissions ?? [],
    };
    const result = (
      state: SafetyDeskDeleteCapabilityState,
      reason: SafetyDeskDeleteCapabilityReason,
    ): SafetyDeskDeleteMembershipCapability => ({ ...base, state, reason });

    if (membership.botAccessState === 'DENIED' || membership.botAccessState === 'LOST') {
      return result('explicitly_incapable', 'access_denied');
    }
    if (!snapshot) {
      return result('stale_or_unknown', 'snapshot_missing');
    }

    const nowMs = now.getTime();
    const fresh =
      Number.isFinite(checkedAtMs) &&
      checkedAtMs <= nowMs &&
      isConfirmedMembershipAccessSnapshot(snapshot, { nowMs });
    if (!fresh || membership.botAccessState === 'STALE') {
      return result('stale_or_unknown', 'snapshot_stale');
    }

    const permissionFailure = resolveDeleteMessageAccessFailure(snapshot, entityType);
    if (permissionFailure) {
      if (permissionFailure === 'entity_type_unknown') {
        return result('stale_or_unknown', permissionFailure);
      }
      return result('explicitly_incapable', permissionFailure);
    }
    if (
      membership.botAccessState !== 'CONFIRMED_ADMIN' &&
      membership.botAccessState !== 'CONFIRMED_OWNER'
    ) {
      return result('stale_or_unknown', 'access_state_unconfirmed');
    }
    if (!configuredBot || !canExecuteActionsForBotState(configuredBot.state)) {
      return result('stale_or_unknown', 'bot_not_actionable');
    }

    return result('confirmed_capable', 'confirmed');
  }

  private normalizeDeleteRoutingPolicy(
    value: string,
  ): 'delete_capable' | 'origin_first' | 'origin_only' {
    if (value === 'delete_capable' || value === 'origin_first') {
      return value;
    }
    return 'origin_only';
  }

  private toValidIsoString(value: string | null): string | null {
    if (!value) {
      return null;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }

  private buildApproveAllMessage(
    approved: number,
    failed: number,
    eligible: number,
    requested: number,
  ): string {
    const unavailable = Math.max(0, requested - eligible);
    const unavailableSuffix =
      unavailable > 0 ? ` Уже недоступно или заблокировано: ${unavailable}.` : '';
    if (eligible === 0) {
      return unavailable > 0
        ? `Выбранные материалы уже недоступны для массового одобрения.${unavailableSuffix}`
        : 'Нет материалов, доступных для массового одобрения.';
    }
    if (failed > 0) {
      return `Принято в очередь публикации: ${approved} из ${eligible}. Не удалось поставить в очередь: ${failed}.${unavailableSuffix}`;
    }
    if (approved === 0) {
      return 'Нет материалов, доступных для массового одобрения.';
    }
    return `Принято в очередь публикации материалов: ${approved}.${unavailableSuffix}`;
  }

  private readStringArray(value: Prisma.JsonValue | unknown): string[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.filter(
      (item): item is string => typeof item === 'string' && item.trim().length > 0,
    );
  }

  private readRecords(value: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(value)) {
      return [];
    }

    return value
      .map((item) => this.asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null);
  }

  private resolveStripPreservedLinkUrls(post: ReviewPostRow): string[] {
    const postUrl = this.readString(post.url);
    if (!postUrl) {
      return [];
    }
    const linkUrls = this.readStringArray(post.linkUrls);
    if (!linkUrls.includes(postUrl)) {
      return [];
    }
    if (
      this.readStringArray(post.photoUrls).length > 0 ||
      this.readStringArray(post.videoUrls).length > 0
    ) {
      return [];
    }
    const hasUnsupportedVideo = this.readRecords(post.unsupportedAttachments).some((item) => {
      const type = this.readString(item.type).toLowerCase();
      return type === 'video' || type === 'clip';
    });

    return hasUnsupportedVideo ? [postUrl] : [];
  }

  private async writeAuditLog(
    chatId: string,
    actorUserId: string | null,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId: this.resolveActor(actorUserId),
        action,
        payload: this.toJsonInput(payload),
      },
    });
  }

  private resolveActor(actorUserId: string | null): string {
    const normalized = actorUserId?.trim();
    return normalized || SAFETY_DESK_ACTOR_USER_ID;
  }

  private auditActionLabel(action: string): string {
    if (action === 'SAFETY_DESK_APPROVE') {
      return 'Материал одобрен';
    }
    if (action === 'SAFETY_DESK_REJECT') {
      return 'Материал отклонен';
    }
    if (action === 'SAFETY_DESK_RECHECK') {
      return 'Повторная проверка';
    }
    return 'Решение Safety Desk';
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private toJsonInput(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }
}

function escapeSafetyDeskHtml(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}
