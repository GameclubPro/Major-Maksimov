import {
  claimManagedGiveawayResponseSchema,
  giveawayEligibilityStateSchema,
  managedEntityTypeSchema,
  managedGiveawayDetailsSchema,
  managedGiveawayParticipantStateSchema,
  managedGiveawayPublicSchema,
  managedGiveawaySummarySchema,
  managedGiveawayWinnerSchema,
  markManagedGiveawayWinnerDeliveredRequestSchema,
  MAX_BROADCAST_IMAGE_BASE64_LENGTH,
  resolveRequiredSubscriptionChannelRequestSchema,
  resolveRequiredSubscriptionChannelResponseSchema,
  rerollManagedGiveawayWinnerRequestSchema,
  type ClaimManagedGiveawayResponse,
  type ManagedEntityType,
  type ManagedGiveawayDetails,
  type ManagedGiveawayParticipantState,
  type ManagedGiveawayPublic,
  type ManagedGiveawaySummary,
  type ManagedGiveawayWinner,
  type ResolveRequiredSubscriptionChannelResponse,
  type UpdateManagedGiveawayRequest,
  updateManagedGiveawayRequestSchema,
} from '@maxim/contracts';
import {
  ChatBotMembershipStatus,
  ChatEntityType,
  GiveawayEligibilityState,
  ManagedEntityAccessState,
  ManagedGiveawayStatus,
  ManagedGiveawayWinnerNotificationStatus,
  ManagedGiveawayWinnerStatus,
  Prisma,
} from '../prisma/prisma-client';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import { collectBotTokenSecrets } from '../common/bot-token.util';
import { buildChannelPostActionRows } from '../common/channel-post-actions';
import { type AuthUser } from '../common/decorators/current-user.decorator';
import {
  buildManagedGiveawayDrawRank,
  normalizeManagedGiveawayDraft,
} from '../common/managed-giveaway.util';
import {
  containsSupportedMarkdownSyntax,
  renderSupportedMarkdownAsHtml,
} from '../common/max-markdown.util';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  type MaxActionJob,
  type MaxMessageButton,
  type MaxSendMessageOptions,
  wasMaxMessageSendAttempted,
} from '../max/max-client.service';
import { MaxActionLedgerService } from '../max/max-action-ledger.service';
import {
  MaxMembershipLookupService,
  type MaxMembershipLookupIssueKind,
  type MaxMembershipLookupPolicy,
} from '../max/max-membership-lookup.service';
import {
  buildCompactGiveawayClaimStartPayload,
  isValidMaxBotStartPayload,
  isValidMaxMiniappStartPayload,
  parseCompactGiveawayClaimStartPayload,
} from '../max/max-deep-link.util';
import {
  MaxBotLinkService,
  type MaxBotRoute,
  type MaxBotRouteRequest,
} from '../max/max-bot-link.service';
import { normalizeMembershipAccessSnapshot } from '../max/max-bot-access-policy.util';
import { collectActiveManagedEntityBotMembershipIdsByChat } from '../max/managed-entity-bot-access.util';
import {
  classifyMaxTerminalChatActionError,
  ManagedEntityAccessLossService,
} from '../max/managed-entity-access-loss.service';
import { isAmbiguousMaxSendError } from '../max/max-send-ambiguity.util';
import { MaxRoutedPublicationService } from '../max/max-routed-publication.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  BackgroundRuntimeGovernorService,
  type BackgroundRuntimeGovernorDecision,
} from '../system/background-runtime-governor.service';
import { AdminService } from './admin.service';
import { shouldRecreateEditableMessage } from './admin-editable-message';
import { ChannelPostSignatureService } from './channel-post-signature.service';
import { isPrismaKnownError, mapWithConcurrencyLimit } from './admin-legacy-utils';
import { MANAGED_ENTITY_ACCESS_EDGE_LEGACY_GRACE_MS } from './admin.service.support';
import {
  buildManagedGiveawayDuePageQuery,
  MANAGED_GIVEAWAY_DUE_FAMILIES,
  type ManagedGiveawayDueCursor,
  type ManagedGiveawayDueFamily,
  type ManagedGiveawayDueRow,
} from './managed-giveaway-due-selection';

type GiveawayActionSource = 'miniapp' | 'private_bot' | 'runner' | 'private_claim';

const GIVEAWAY_IMAGE_MAX_BYTES = Math.floor((MAX_BROADCAST_IMAGE_BASE64_LENGTH * 3) / 4);
const GIVEAWAY_LOCK_STALE_MS = 60_000;
const GIVEAWAY_DUE_BATCH_SIZE = 20;
const GIVEAWAY_DUE_FETCH_BATCH_SIZE = GIVEAWAY_DUE_BATCH_SIZE * 4;
const GIVEAWAY_WINNER_NOTIFICATION_BATCH_SIZE = 20;
const GIVEAWAY_WINNER_NOTIFICATION_MAX_ATTEMPTS = 5;
const GIVEAWAY_WINNER_NOTIFICATION_RETRY_BASE_MS = 30_000;
const GIVEAWAY_WINNER_NOTIFICATION_RETRY_MAX_MS = 30 * 60_000;
const GIVEAWAY_START_PARAM_PREFIX = 'gg-';
const GIVEAWAY_CLAIM_START_PREFIX = 'ggc-';
const GIVEAWAY_RUNNER_LOOKUP_RETRY_MESSAGE =
  'Не удалось проверить участие в исходном чате. Повторите позже.';
const GIVEAWAY_RUNNER_LOOKUP_FAILURE_COUNT_TTL_SEC = 6 * 60 * 60;
const GIVEAWAY_RUNNER_LOOKUP_BACKOFF_BASE_MS = 60_000;
const GIVEAWAY_RUNNER_LOOKUP_BACKOFF_MAX_MS = 60 * 60_000;
const GIVEAWAY_RUNNER_LOOKUP_DEFER_AFTER_FAILURE_COUNT = 4;
const GIVEAWAY_RUNNER_LOOKUP_DEFER_MS = 30 * 60_000;
const GIVEAWAY_RUNNER_LOOKUP_TERMINAL_DEFER_MS = 2 * 60 * 60_000;
const GIVEAWAY_RUNNER_THROTTLE_LOG_INTERVAL_MS = 60_000;
const GIVEAWAY_RESULTS_REPLACEMENT_DIGEST_HEX_LENGTH = 24;
const GIVEAWAY_RESULTS_REPLACEMENT_DIGEST_PATTERN = /^[0-9a-f]{24}$/u;
const MANAGED_GIVEAWAY_METADATA_TIMEOUT_MS = 2_500;
const MANAGED_GIVEAWAY_METADATA_CONCURRENCY = 4;
const MANAGED_GIVEAWAY_SEND_TIMEOUT_MS = 12_000;
const MANAGED_GIVEAWAY_UPLOAD_TIMEOUT_MS = 30_000;
const MANAGED_GIVEAWAY_MEMBERSHIP_TIMEOUT_MS = 3_000;
const MANAGED_GIVEAWAY_BACKGROUND_MEMBERSHIP_TIMEOUT_MS = 5_000;
const MANAGED_GIVEAWAY_INCLUDE = {
  prizes: {
    orderBy: { position: 'asc' },
  },
  entries: {
    orderBy: [{ joinedAt: 'asc' }],
  },
  winners: {
    include: {
      prize: true,
      entry: true,
    },
    orderBy: [{ selectedAt: 'asc' }],
  },
} as const satisfies Prisma.ManagedGiveawayInclude;
const MANAGED_GIVEAWAY_WINNER_NOTIFICATION_INCLUDE = {
  winner: {
    include: {
      giveaway: {
        include: {
          prizes: {
            orderBy: { position: 'asc' },
          },
        },
      },
      prize: true,
      entry: true,
    },
  },
} as const satisfies Prisma.ManagedGiveawayWinnerNotificationInclude;

type PersistedGiveawayWithRelations = Prisma.ManagedGiveawayGetPayload<{
  include: typeof MANAGED_GIVEAWAY_INCLUDE;
}>;
type PersistedManagedGiveaway = Prisma.ManagedGiveawayGetPayload<Record<string, never>>;
type PersistedManagedGiveawayPrize = Prisma.ManagedGiveawayPrizeGetPayload<Record<string, never>>;
type PersistedManagedGiveawayEntry = Prisma.ManagedGiveawayEntryGetPayload<Record<string, never>>;
type PersistedManagedGiveawayWinner = Prisma.ManagedGiveawayWinnerGetPayload<Record<string, never>>;
type PersistedManagedGiveawayWinnerNotification =
  Prisma.ManagedGiveawayWinnerNotificationGetPayload<{
    include: typeof MANAGED_GIVEAWAY_WINNER_NOTIFICATION_INCLUDE;
  }>;
type WinnerNotificationOutboxOptions = {
  notificationIds?: readonly string[];
  winnerIds?: readonly string[];
  synchronizeResultsBeforeDispatch?: boolean;
};
type GiveawayResultsTextPayload = {
  text: string;
  textFormat?: MaxSendMessageOptions['textFormat'];
};
type GiveawayWinnerNotificationGiveaway = Pick<
  PersistedManagedGiveaway,
  'id' | 'sourceChatId' | 'title' | 'publicationUrl' | 'resultsUrl'
> & {
  prizes: PersistedManagedGiveawayPrize[];
};
type GiveawayRerollCandidate = {
  entry: PersistedManagedGiveawayEntry;
  drawRank: string;
};
type GiveawayDrawClaimResult =
  | { status: 'claimed'; giveaway: PersistedGiveawayWithRelations; drawSeed: string }
  | { status: 'completed'; giveaway: PersistedGiveawayWithRelations };
type GiveawayEligibilityResult = {
  state: GiveawayEligibilityState;
  reason: string | null;
  missingChannelIds: string[];
};
type GiveawayEntryAuditAction = 'ENTER_GIVEAWAY' | 'RECHECK_GIVEAWAY_ENTRY';
type GiveawayRoutedSendPhase = 'publication' | 'results';
type GiveawaySendLockReconciliation =
  | { kind: 'blocked' }
  | { kind: 'retryable' }
  | {
      kind: 'completed';
      messageId: string;
      botId: string;
      url: string | null;
    };
type GiveawayEligibilityCheckOptions = {
  strictChannelCheck?: boolean;
  forceFreshMembership?: boolean;
  lookupPolicy?: MaxMembershipLookupPolicy;
  allowStaleMembershipOnError?: boolean;
  failedChannelId?: string;
};
type GiveawayMaxApiOptionsKind = 'metadata' | 'send' | 'upload' | 'membership' | 'delete';

function buildManagedGiveawayMaxApiOptions(
  source: GiveawayActionSource,
  kind: GiveawayMaxApiOptionsKind,
  botId?: string | null,
) {
  const isRunner = source === 'runner';
  const timeoutMs =
    kind === 'metadata'
      ? MANAGED_GIVEAWAY_METADATA_TIMEOUT_MS
      : kind === 'upload'
        ? MANAGED_GIVEAWAY_UPLOAD_TIMEOUT_MS
        : kind === 'membership'
          ? isRunner
            ? MANAGED_GIVEAWAY_BACKGROUND_MEMBERSHIP_TIMEOUT_MS
            : MANAGED_GIVEAWAY_MEMBERSHIP_TIMEOUT_MS
          : MANAGED_GIVEAWAY_SEND_TIMEOUT_MS;

  return {
    ...(botId ? { botId } : {}),
    trafficClass: (isRunner ? 'background' : 'interactive') as 'background' | 'interactive',
    actionHealthLane:
      kind === 'metadata' || (kind === 'membership' && !isRunner)
        ? ('background' as const)
        : isRunner
          ? ('background' as const)
          : ('interactive' as const),
    sourceTag: isRunner
      ? MAX_API_SOURCE_TAGS.GIVEAWAY_DRAW_BACKGROUND
      : MAX_API_SOURCE_TAGS.MANAGED_GIVEAWAY,
    timeoutMs,
  };
}

export class ManagedGiveawayMembershipLookupUnavailableError extends Error {
  constructor(
    readonly kind: MaxMembershipLookupIssueKind,
    readonly chatId: string,
    readonly retryAfterMs: number | null,
  ) {
    super(GIVEAWAY_RUNNER_LOOKUP_RETRY_MESSAGE);
    this.name = 'ManagedGiveawayMembershipLookupUnavailableError';
  }
}

@Injectable()
export class ManagedGiveawayService {
  private readonly logger = new Logger(ManagedGiveawayService.name);
  private readonly appBaseUrl: string | null;
  private readonly explicitBotContactId: string | null;
  private readonly ownBotUserId: string | null;
  private readonly maxBotToken: string;
  private readonly maxBotTokenValidationSecrets: readonly string[];
  private readonly giveawayRunnerFailureCounts = new Map<
    string,
    { count: number; expiresAtMs: number }
  >();
  private readonly giveawayRunnerBackoffUntilMs = new Map<string, number>();
  private readonly giveawayRunnerDeferredUntilMs = new Map<string, number>();
  private giveawayRunnerThrottleLogAtMs = 0;
  private readonly giveawayDueScans = new Map<
    ManagedGiveawayDueFamily,
    { cutoff: Date; after: ManagedGiveawayDueCursor | null }
  >();
  private giveawayDueFirstFamily = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly chatContextCache: ChatContextCacheService,
    private readonly adminService: AdminService,
    configService: ConfigService,
    @Optional() private readonly membershipLookupService?: MaxMembershipLookupService,
    @Optional() private readonly maxBotLinkService?: MaxBotLinkService,
    @Optional() private readonly managedEntityAccessLossService?: ManagedEntityAccessLossService,
    @Optional()
    private readonly backgroundRuntimeGovernorService?: BackgroundRuntimeGovernorService,
    @Optional() private readonly maxRoutedPublicationService?: MaxRoutedPublicationService,
    @Optional() private readonly maxActionLedgerService?: MaxActionLedgerService,
    @Optional() private readonly channelPostSignatureService?: ChannelPostSignatureService,
  ) {
    this.appBaseUrl = this.normalizeAppBaseUrl(configService.get<string>('APP_BASE_URL'));
    this.explicitBotContactId = this.normalizeBotContactId(
      configService.get<string>('MAX_BOT_CONTACT_ID'),
    );
    this.ownBotUserId = this.normalizeOwnBotUserId(configService.get<string>('MAX_BOT_ID'));
    const configuredBotTokens = collectBotTokenSecrets(
      configService.getOrThrow<string>('MAX_BOT_TOKEN'),
      configService.get<string>('MAX_BOT_TOKEN_PREVIOUS'),
    );
    this.maxBotToken =
      this.maxBotLinkService?.getBotTokenSync() ??
      configuredBotTokens[0] ??
      configService.getOrThrow<string>('MAX_BOT_TOKEN');
    this.maxBotTokenValidationSecrets =
      this.maxBotLinkService?.getValidationTokens() ??
      (configuredBotTokens.length > 0 ? configuredBotTokens : [this.maxBotToken]);
  }

  async listManagedGiveaways(
    sourceChatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<ManagedGiveawaySummary[]> {
    await this.assertAdminEntityAccess(sourceChatId, user, entityType);

    const rows = await this.prisma.managedGiveaway.findMany({
      where: {
        sourceChatId,
        entityType: this.toPrismaEntityType(entityType),
      },
      orderBy: [{ createdAt: 'desc' }],
      include: {
        entries: {
          select: {
            eligibilityState: true,
          },
        },
        winners: {
          where: {
            status: {
              not: ManagedGiveawayWinnerStatus.REROLLED,
            },
          },
          select: {
            id: true,
          },
        },
      },
    });

    return rows.map((row) => managedGiveawaySummarySchema.parse(this.mapGiveawaySummary(row)));
  }

  async createManagedGiveaway(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    entityType: ManagedEntityType,
    source: GiveawayActionSource = 'miniapp',
  ): Promise<ManagedGiveawayDetails> {
    await this.assertAdminEntityAccess(sourceChatId, user, entityType);

    const payload = this.parseManagedGiveawayDraft(body);
    const row = await this.prisma
      .$transaction(
        async (tx) => {
          await this.ensureNoConcurrentManagedGiveaway(sourceChatId, entityType, null, tx);
          return tx.managedGiveaway.create({
            data: {
              sourceChatId,
              entityType: this.toPrismaEntityType(entityType),
              actorUserId: user.userId,
              title: payload.title,
              description: payload.description,
              imageEnabled: payload.imageEnabled,
              imageBase64: payload.imageBase64,
              imageMimeType: payload.imageMimeType,
              imageFileName: payload.imageFileName,
              startsAt: payload.startsAt ? new Date(payload.startsAt) : null,
              endsAt: new Date(payload.endsAt),
              claimHours: payload.claimHours,
              requiredChannelIds: payload.requiredChannelIds,
              prizes: {
                create: payload.prizes.map((prize) => ({
                  position: prize.position,
                  title: prize.title,
                  displayTitle: prize.displayTitle,
                })),
              },
            },
            include: MANAGED_GIVEAWAY_INCLUDE,
          });
        },
        { isolationLevel: 'Serializable' },
      )
      .catch((error: unknown) => {
        if (isPrismaKnownError(error, 'P2034')) {
          throw new ConflictException('Другой розыгрыш уже создаётся. Обновите список.');
        }
        throw error;
      });

    await this.writeAuditLog(sourceChatId, user.userId, 'CREATE_GIVEAWAY', {
      giveawayId: row.id,
      entityType,
      title: payload.title,
      prizes: payload.prizes.length,
      source,
    });

    return managedGiveawayDetailsSchema.parse(this.mapGiveawayDetails(row));
  }

  async getManagedGiveaway(
    sourceChatId: string,
    giveawayId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<ManagedGiveawayDetails> {
    await this.assertAdminEntityAccess(sourceChatId, user, entityType);

    const row = await this.findGiveawayForSource(sourceChatId, giveawayId, entityType);
    return managedGiveawayDetailsSchema.parse(this.mapGiveawayDetails(row));
  }

  async refreshManagedGiveawayPublication(
    sourceChatId: string,
    giveawayId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    source: GiveawayActionSource = 'miniapp',
  ): Promise<ManagedGiveawayDetails> {
    await this.assertAdminEntityAccess(sourceChatId, user, entityType);

    const giveaway = await this.findGiveawayForSource(sourceChatId, giveawayId, entityType);
    await this.editGiveawayPublicationIfNeeded(giveaway, giveaway.status, source);
    await this.writeAuditLog(sourceChatId, user.userId, 'REFRESH_GIVEAWAY_PUBLICATION', {
      giveawayId,
      entityType,
      status: giveaway.status,
      source,
    });

    return managedGiveawayDetailsSchema.parse(this.mapGiveawayDetails(giveaway));
  }

  async updateManagedGiveaway(
    sourceChatId: string,
    giveawayId: string,
    user: AuthUser,
    body: unknown,
    entityType: ManagedEntityType,
    source: GiveawayActionSource = 'miniapp',
  ): Promise<ManagedGiveawayDetails> {
    await this.assertAdminEntityAccess(sourceChatId, user, entityType);

    const existing = await this.findGiveawayForSource(sourceChatId, giveawayId, entityType);
    if (existing.status !== ManagedGiveawayStatus.DRAFT) {
      throw new BadRequestException('Изменять можно только черновик розыгрыша.');
    }

    const payload = this.parseManagedGiveawayDraft(body);
    const updated = await this.prisma.$transaction(async (tx) => {
      const editable = await tx.managedGiveaway.updateMany({
        where: { id: existing.id, status: ManagedGiveawayStatus.DRAFT, lockedAt: null },
        data: { actorUserId: user.userId },
      });
      if (editable.count !== 1) {
        throw new ConflictException('Черновик уже изменён или публикуется. Обновите экран.');
      }
      await tx.managedGiveawayPrize.deleteMany({
        where: { giveawayId: existing.id },
      });

      await tx.managedGiveaway.update({
        where: { id: existing.id },
        data: {
          actorUserId: user.userId,
          title: payload.title,
          description: payload.description,
          imageEnabled: payload.imageEnabled,
          imageBase64: payload.imageBase64,
          imageMimeType: payload.imageMimeType,
          imageFileName: payload.imageFileName,
          startsAt: payload.startsAt ? new Date(payload.startsAt) : null,
          endsAt: new Date(payload.endsAt),
          claimHours: payload.claimHours,
          requiredChannelIds: payload.requiredChannelIds,
        },
      });

      await tx.managedGiveawayPrize.createMany({
        data: payload.prizes.map((prize) => ({
          giveawayId: existing.id,
          position: prize.position,
          title: prize.title,
          displayTitle: prize.displayTitle,
        })),
      });

      return tx.managedGiveaway.findUniqueOrThrow({
        where: { id: existing.id },
        include: MANAGED_GIVEAWAY_INCLUDE,
      });
    });

    await this.writeAuditLog(sourceChatId, user.userId, 'UPDATE_GIVEAWAY', {
      giveawayId: existing.id,
      entityType,
      title: payload.title,
      prizes: payload.prizes.length,
      source,
    });

    return managedGiveawayDetailsSchema.parse(this.mapGiveawayDetails(updated));
  }

  async publishManagedGiveaway(
    sourceChatId: string,
    giveawayId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    source: GiveawayActionSource = 'miniapp',
  ): Promise<ManagedGiveawayDetails> {
    await this.assertAdminEntityAccess(sourceChatId, user, entityType);

    let giveaway = await this.findGiveawayForSource(sourceChatId, giveawayId, entityType);
    if (giveaway.status !== ManagedGiveawayStatus.DRAFT) {
      throw new BadRequestException('Публиковать можно только черновик розыгрыша.');
    }
    const now = new Date();
    if (!giveaway.lockedAt && giveaway.endsAt.getTime() <= now.getTime()) {
      throw new BadRequestException('Время завершения уже прошло. Измените сроки черновика.');
    }
    const startsAt =
      giveaway.startsAt && giveaway.startsAt.getTime() > now.getTime() ? giveaway.startsAt : null;
    let nextStatus = startsAt ? ManagedGiveawayStatus.SCHEDULED : ManagedGiveawayStatus.ACTIVE;
    const publicationSendLockKey = this.buildGiveawaySendLockKey(giveaway.id, 'publication');
    if (giveaway.lockedAt) {
      const reconciliation = await this.reconcileStaleGiveawaySendLock(
        giveaway,
        'publication',
        source,
      );
      if (reconciliation.kind === 'completed') {
        const publishedAt = new Date();
        const recovered = await this.prisma.managedGiveaway.updateMany({
          where: {
            id: giveaway.id,
            status: ManagedGiveawayStatus.DRAFT,
            publicationMessageId: null,
            lockedAt: giveaway.lockedAt,
            sendLockKey: publicationSendLockKey,
          },
          data: {
            actorUserId: user.userId,
            status: nextStatus,
            publicationMessageId: reconciliation.messageId,
            publicationBotId: reconciliation.botId,
            publicationUrl: reconciliation.url,
            publishedAt,
            lockedAt: null,
            sendLockKey: null,
          },
        });
        if (recovered.count === 0) {
          const current = await this.findGiveawayForSource(sourceChatId, giveawayId, entityType);
          if (current.publicationMessageId?.trim()) {
            return managedGiveawayDetailsSchema.parse(this.mapGiveawayDetails(current));
          }
          throw new BadRequestException(
            'Публикация розыгрыша уже восстанавливается. Проверьте чат перед повтором.',
          );
        }

        const recoveredGiveaway = {
          ...giveaway,
          actorUserId: user.userId,
          status: nextStatus,
          publicationMessageId: reconciliation.messageId,
          publicationBotId: reconciliation.botId,
          publicationUrl: reconciliation.url,
          publishedAt,
          lockedAt: null,
          sendLockKey: null,
          updatedAt: publishedAt,
        };
        await this.writeAuditLog(sourceChatId, user.userId, 'PUBLISH_GIVEAWAY', {
          giveawayId: giveaway.id,
          entityType,
          status: nextStatus,
          publicationMessageId: reconciliation.messageId,
          publicationBotId: reconciliation.botId,
          publicationUrl: reconciliation.url,
          recoveredFromLedger: true,
          source,
        });
        await this.chatContextCache.invalidate(sourceChatId);
        return managedGiveawayDetailsSchema.parse(this.mapGiveawayDetails(recoveredGiveaway));
      }
      if (reconciliation.kind !== 'retryable') {
        throw new BadRequestException(
          'Публикация розыгрыша уже отправлялась и требует ручной проверки перед повтором.',
        );
      }
      giveaway = await this.findGiveawayForSource(sourceChatId, giveawayId, entityType);
      nextStatus =
        giveaway.startsAt && giveaway.startsAt.getTime() > Date.now()
          ? ManagedGiveawayStatus.SCHEDULED
          : ManagedGiveawayStatus.ACTIVE;
    }
    await this.ensureNoConcurrentManagedGiveaway(sourceChatId, entityType, giveaway.id);

    if (!giveaway.description.trim()) {
      throw new BadRequestException('Добавьте текст розыгрыша в чат-боте перед публикацией.');
    }
    this.assertProductionRoutedPublicationAvailable();
    const publicationBotId = this.maxRoutedPublicationService
      ? undefined
      : await this.resolveGiveawayPublicationBotId(sourceChatId);
    const publicationLockAt = new Date();
    const lock = await this.prisma.managedGiveaway.updateMany({
      where: {
        id: giveaway.id,
        status: ManagedGiveawayStatus.DRAFT,
        lockedAt: null,
        updatedAt: giveaway.updatedAt,
        endsAt: { gt: publicationLockAt },
      },
      data: {
        lockedAt: publicationLockAt,
        sendLockKey: this.maxRoutedPublicationService ? publicationSendLockKey : null,
      },
    });
    if (lock.count === 0) {
      throw new BadRequestException(
        'Публикация розыгрыша уже выполняется или требует ручной проверки.',
      );
    }

    let maxSendAttempted = false;
    let maxSendAccepted = false;
    let dispatchedPublicationBotId = publicationBotId ?? null;
    try {
      const sendOptions = buildManagedGiveawayMaxApiOptions(source, 'send');
      const basePublicationTextPayload = this.buildFormattedGiveawayTextPayload(
        this.buildGiveawayPublicationText(giveaway),
      );
      const publicationTextPayload = this.channelPostSignatureService
        ? await this.channelPostSignatureService.preparePostText(
            sourceChatId,
            basePublicationTextPayload,
            {
              entityType,
              trafficClass: sendOptions.trafficClass,
              sourceTag: sendOptions.sourceTag,
            },
          )
        : basePublicationTextPayload;
      const publication = this.maxRoutedPublicationService
        ? await this.maxRoutedPublicationService.publish({
            entityId: sourceChatId,
            logicalIdempotencyKey: publicationSendLockKey,
            text: publicationTextPayload.text,
            trafficClass: sendOptions.trafficClass,
            actionHealthLane: sendOptions.actionHealthLane,
            sourceTag: sendOptions.sourceTag,
            timeoutMs: sendOptions.timeoutMs,
            prepareAttempt: async ({ botId }) => {
              const [buttonRows, imagePayload] = await Promise.all([
                this.buildGiveawayPostActionRows(
                  giveaway,
                  this.buildGiveawayEntryButton(giveaway, botId),
                  source,
                ),
                this.uploadGiveawayImage(giveaway, botId, source, false),
              ]);
              return {
                options: {
                  ...(publicationTextPayload.textFormat
                    ? { textFormat: publicationTextPayload.textFormat }
                    : {}),
                  ...(buttonRows ? { buttons: buttonRows } : {}),
                  ...(imagePayload ? { imagePayload } : {}),
                },
              };
            },
            onDispatchAttempt: ({ botId }) => {
              maxSendAttempted = true;
              dispatchedPublicationBotId = botId;
            },
          })
        : await (async () => {
            const [buttonRows, imagePayload] = await Promise.all([
              this.buildGiveawayPostActionRows(
                giveaway,
                this.buildGiveawayEntryButton(giveaway, publicationBotId),
                source,
              ),
              this.uploadGiveawayImage(giveaway, publicationBotId, source),
            ]);
            const publicationOptions = {
              ...(publicationTextPayload.textFormat
                ? { textFormat: publicationTextPayload.textFormat }
                : {}),
              ...(buttonRows ? { buttons: buttonRows } : {}),
              ...(imagePayload ? { imagePayload } : {}),
            } satisfies MaxSendMessageOptions;
            maxSendAttempted = true;
            return publicationBotId
              ? this.maxClient.sendMessageImmediateWithResolvedLink(
                  sourceChatId,
                  publicationTextPayload.text,
                  publicationOptions,
                  buildManagedGiveawayMaxApiOptions(source, 'send', publicationBotId),
                )
              : this.maxClient.sendMessageImmediateWithResolvedLink(
                  sourceChatId,
                  publicationTextPayload.text,
                  publicationOptions,
                  buildManagedGiveawayMaxApiOptions(source, 'send'),
                );
          })();
      if ('botId' in publication && typeof publication.botId === 'string') {
        dispatchedPublicationBotId = publication.botId;
      }
      maxSendAccepted = true;

      const publishedAt = new Date();
      const updated = await this.prisma.managedGiveaway.update({
        where: { id: giveaway.id },
        data: {
          actorUserId: user.userId,
          status: nextStatus,
          publicationMessageId: publication.messageId,
          publicationBotId: dispatchedPublicationBotId,
          publicationUrl: publication.url,
          publishedAt,
          lockedAt: null,
          sendLockKey: null,
        },
        include: MANAGED_GIVEAWAY_INCLUDE,
      });

      await this.writeAuditLog(sourceChatId, user.userId, 'PUBLISH_GIVEAWAY', {
        giveawayId: giveaway.id,
        entityType,
        status: nextStatus,
        publicationMessageId: publication.messageId,
        publicationBotId: dispatchedPublicationBotId,
        publicationUrl: publication.url,
        source,
      });
      await this.chatContextCache.invalidate(sourceChatId);

      return managedGiveawayDetailsSchema.parse(this.mapGiveawayDetails(updated));
    } catch (error: unknown) {
      const shouldQuarantine =
        maxSendAccepted || (maxSendAttempted && isAmbiguousMaxSendError(error));
      if (shouldQuarantine) {
        this.logger.warn(
          {
            giveawayId: giveaway.id,
            sourceChatId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Managed giveaway publication send is ambiguous; leaving publication lock for manual verification',
        );
      } else {
        await this.prisma.managedGiveaway.updateMany({
          where: {
            id: giveaway.id,
            status: ManagedGiveawayStatus.DRAFT,
            lockedAt: publicationLockAt,
            sendLockKey: this.maxRoutedPublicationService ? publicationSendLockKey : null,
          },
          data: { lockedAt: null, sendLockKey: null },
        });
      }
      throw error;
    }
  }

  async closeManagedGiveaway(
    sourceChatId: string,
    giveawayId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    source: GiveawayActionSource = 'miniapp',
  ): Promise<ManagedGiveawayDetails> {
    await this.assertAdminEntityAccess(sourceChatId, user, entityType);

    const giveaway = await this.findGiveawayForSource(sourceChatId, giveawayId, entityType);
    if (
      giveaway.status !== ManagedGiveawayStatus.ACTIVE &&
      giveaway.status !== ManagedGiveawayStatus.SCHEDULED
    ) {
      throw new BadRequestException(
        'Завершить можно только активный или запланированный розыгрыш.',
      );
    }

    const completed = await this.drawGiveaway(giveaway.id, source, user.userId);
    return managedGiveawayDetailsSchema.parse(this.mapGiveawayDetails(completed));
  }

  async rerollManagedGiveawayWinner(
    sourceChatId: string,
    giveawayId: string,
    user: AuthUser,
    body: unknown,
    entityType: ManagedEntityType,
    source: GiveawayActionSource = 'miniapp',
  ): Promise<ManagedGiveawayDetails> {
    await this.assertAdminEntityAccess(sourceChatId, user, entityType);
    const parsed = rerollManagedGiveawayWinnerRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const giveaway = await this.findGiveawayForSource(sourceChatId, giveawayId, entityType);
    if (giveaway.status !== ManagedGiveawayStatus.COMPLETED || !giveaway.drawSeed) {
      throw new BadRequestException('Реролл доступен только после завершения розыгрыша.');
    }

    const winner = giveaway.winners.find((row) => row.id === parsed.data.winnerId);
    if (!winner || winner.status === ManagedGiveawayWinnerStatus.REROLLED) {
      throw new BadRequestException('Победитель для реролла не найден.');
    }
    if (
      winner.status !== ManagedGiveawayWinnerStatus.SELECTED &&
      winner.status !== ManagedGiveawayWinnerStatus.CLAIMED &&
      winner.status !== ManagedGiveawayWinnerStatus.EXPIRED
    ) {
      throw new BadRequestException(
        'Реролл доступен только для актуального или просроченного места.',
      );
    }

    const nextEntry = this.pickNextRerollCandidate(giveaway, giveaway.drawSeed);

    if (!nextEntry) {
      throw new BadRequestException('Больше подходящих участников для реролла нет.');
    }

    const now = new Date();
    const claimDeadlineAt = this.buildGiveawayClaimDeadlineAt(giveaway, now);
    const nextWinnerId = randomUUID();
    const rerollTransaction = this.prisma.$transaction(async (tx) => {
      await tx.managedGiveawayEntry.update({
        where: { id: nextEntry.entry.id },
        data: { drawRank: nextEntry.drawRank, checkedAt: now },
      });

      await tx.managedGiveawayWinner.update({
        where: { id: winner.id, status: winner.status },
        data: {
          status: ManagedGiveawayWinnerStatus.REROLLED,
          rerolledAt: now,
        },
      });

      await tx.managedGiveawayWinnerNotification.updateMany({
        where: {
          winnerId: winner.id,
          status: {
            in: [
              ManagedGiveawayWinnerNotificationStatus.PENDING,
              ManagedGiveawayWinnerNotificationStatus.RETRYABLE,
            ],
          },
        },
        data: {
          status: ManagedGiveawayWinnerNotificationStatus.CANCELED,
          lockedAt: null,
          nextAttemptAt: now,
        },
      });

      await tx.managedGiveawayWinner.create({
        data: {
          id: nextWinnerId,
          giveawayId: giveaway.id,
          prizeId: winner.prizeId,
          entryId: nextEntry.entry.id,
          rank: winner.rank,
          status: ManagedGiveawayWinnerStatus.SELECTED,
          selectedAt: now,
          claimDeadlineAt,
          claimedAt: null,
          expiredAt: null,
          deliveredAt: null,
          rerolledAt: null,
        },
      });

      await tx.managedGiveawayWinnerNotification.create({
        data: {
          winnerId: nextWinnerId,
          nextAttemptAt: now,
        },
      });

      return tx.managedGiveaway.findUniqueOrThrow({
        where: { id: giveaway.id },
        include: MANAGED_GIVEAWAY_INCLUDE,
      });
    });
    const updated = await rerollTransaction.catch((error: unknown) => {
      if (isPrismaKnownError(error, 'P2002') || isPrismaKnownError(error, 'P2025')) {
        throw new ConflictException(
          'Состояние победителя изменилось. Обновите экран и повторите реролл.',
        );
      }
      throw error;
    });

    await this.editGiveawayPublicationIfNeeded(updated, ManagedGiveawayStatus.COMPLETED, source);
    const resultsConfirmed = await this.republishGiveawayResults(updated, source);
    const refreshed = await this.findGiveawayById(updated.id);
    if (resultsConfirmed) {
      await this.processWinnerNotificationOutbox(
        source,
        refreshed.id,
        GIVEAWAY_WINNER_NOTIFICATION_BATCH_SIZE,
        { winnerIds: [nextWinnerId] },
      );
    }
    await this.writeAuditLog(sourceChatId, user.userId, 'REROLL_GIVEAWAY_WINNER', {
      giveawayId,
      winnerId: winner.id,
      nextEntryId: nextEntry.entry.id,
      entityType,
      source,
    });

    return managedGiveawayDetailsSchema.parse(this.mapGiveawayDetails(refreshed));
  }

  async markManagedGiveawayWinnerDelivered(
    sourceChatId: string,
    giveawayId: string,
    user: AuthUser,
    body: unknown,
    entityType: ManagedEntityType,
    source: GiveawayActionSource = 'miniapp',
  ): Promise<ManagedGiveawayDetails> {
    await this.assertAdminEntityAccess(sourceChatId, user, entityType);
    const parsed = markManagedGiveawayWinnerDeliveredRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const giveaway = await this.findGiveawayForSource(sourceChatId, giveawayId, entityType);
    const winner = giveaway.winners.find((row) => row.id === parsed.data.winnerId);
    if (!winner || winner.status === ManagedGiveawayWinnerStatus.REROLLED) {
      throw new BadRequestException('Победитель не найден.');
    }
    const effectiveWinnerStatus = this.resolveEffectiveWinnerStatus(winner);
    if (
      effectiveWinnerStatus !== ManagedGiveawayWinnerStatus.CLAIMED &&
      effectiveWinnerStatus !== ManagedGiveawayWinnerStatus.SELECTED
    ) {
      throw new BadRequestException('Выдачу можно отметить только для актуального победителя.');
    }

    const updated = await this.prisma
      .$transaction(async (tx) => {
        const transitioned = await this.transitionCurrentGiveawayWinner(
          tx,
          winner,
          ManagedGiveawayWinnerStatus.DELIVERED,
        );
        if (!transitioned) {
          throw new ConflictException('Состояние победителя изменилось. Обновите экран.');
        }
        return { id: winner.id };
      })
      .catch((error: unknown) => {
        if (isPrismaKnownError(error, 'P2025')) {
          throw new ConflictException('Состояние победителя изменилось. Обновите экран.');
        }
        throw error;
      });

    await this.writeAuditLog(sourceChatId, user.userId, 'DELIVER_GIVEAWAY_WINNER', {
      giveawayId,
      winnerId: updated.id,
      entityType,
      source,
    });

    const refreshed = await this.prisma.managedGiveaway.findUniqueOrThrow({
      where: { id: giveaway.id },
      include: MANAGED_GIVEAWAY_INCLUDE,
    });

    await this.editGiveawayPublicationIfNeeded(refreshed, ManagedGiveawayStatus.COMPLETED, source);
    await this.republishGiveawayResults(refreshed, source);

    return managedGiveawayDetailsSchema.parse(this.mapGiveawayDetails(refreshed));
  }

  async cancelManagedGiveaway(
    sourceChatId: string,
    giveawayId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    source: GiveawayActionSource = 'miniapp',
  ): Promise<ManagedGiveawayDetails> {
    await this.assertAdminEntityAccess(sourceChatId, user, entityType);

    const giveaway = await this.findGiveawayForSource(sourceChatId, giveawayId, entityType);
    if (
      giveaway.status !== ManagedGiveawayStatus.DRAFT &&
      giveaway.status !== ManagedGiveawayStatus.SCHEDULED &&
      giveaway.status !== ManagedGiveawayStatus.ACTIVE
    ) {
      throw new BadRequestException(
        'Отменить можно только текущий черновик или активный розыгрыш.',
      );
    }

    const canceledAt = new Date();
    const updated = await this.prisma.managedGiveaway
      .update({
        where: { id: giveaway.id, status: giveaway.status, lockedAt: null },
        data: {
          status: ManagedGiveawayStatus.CANCELED,
          canceledAt,
          lockedAt: null,
          sendLockKey: null,
        },
        include: MANAGED_GIVEAWAY_INCLUDE,
      })
      .catch((error: unknown) => {
        if (isPrismaKnownError(error, 'P2025')) {
          throw new ConflictException('Розыгрыш уже изменён или публикуется. Обновите экран.');
        }
        throw error;
      });

    await this.editGiveawayPublicationIfNeeded(updated, ManagedGiveawayStatus.CANCELED, source);
    await this.writeAuditLog(sourceChatId, user.userId, 'CANCEL_GIVEAWAY', {
      giveawayId,
      entityType,
      source,
    });

    return managedGiveawayDetailsSchema.parse(this.mapGiveawayDetails(updated));
  }

  async deleteManagedGiveaway(
    sourceChatId: string,
    giveawayId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    source: GiveawayActionSource = 'miniapp',
  ): Promise<void> {
    await this.assertAdminEntityAccess(sourceChatId, user, entityType);

    const giveaway = await this.findGiveawayForSource(sourceChatId, giveawayId, entityType);
    if (
      giveaway.status !== ManagedGiveawayStatus.COMPLETED &&
      giveaway.status !== ManagedGiveawayStatus.CANCELED
    ) {
      throw new BadRequestException('Удалять можно только завершённый или отменённый розыгрыш.');
    }

    await this.deleteGiveawayPublishedMessages(giveaway, source);

    await this.prisma.managedGiveaway.delete({
      where: { id: giveaway.id },
    });

    await this.writeAuditLog(sourceChatId, user.userId, 'DELETE_GIVEAWAY', {
      giveawayId,
      entityType,
      source,
      status: giveaway.status,
    });
  }

  private async deleteGiveawayPublishedMessages(
    giveaway: PersistedGiveawayWithRelations,
    source: GiveawayActionSource,
  ): Promise<void> {
    const messages = this.collectGiveawayPublishedMessages(giveaway);
    for (const message of messages) {
      let deleteBotId = message.botId;
      const attemptedBotIds = new Set<string>();
      for (let attempt = 0; attempt < 2; attempt += 1) {
        let deleteAttemptStartedAt: Date | null = null;
        try {
          if (!deleteBotId) {
            deleteBotId = await this.resolveGiveawayDeleteBotId(giveaway.sourceChatId);
          }
          if (!deleteBotId || attemptedBotIds.has(deleteBotId)) {
            throw new Error('No MAX bot with delete_message capability is available');
          }
          attemptedBotIds.add(deleteBotId);
          deleteAttemptStartedAt = new Date();
          await this.maxClient.deleteMessage(giveaway.sourceChatId, message.messageId, {
            immediate: true,
            ...buildManagedGiveawayMaxApiOptions(source, 'delete', deleteBotId),
          });
          break;
        } catch (error: unknown) {
          const classification = deleteAttemptStartedAt
            ? classifyMaxTerminalChatActionError(error)
            : null;
          if (classification?.kind === 'message_not_found') {
            this.logger.debug(
              {
                giveawayId: giveaway.id,
                messageId: message.messageId,
                kind: message.kind,
                botId: deleteBotId,
              },
              'Managed giveaway published message was already missing during delete',
            );
            break;
          }

          if (deleteAttemptStartedAt) {
            await this.recordManagedGiveawayMaxAccessLoss({
              giveaway,
              botId: deleteBotId,
              source: `managed_giveaway:${message.kind}:delete`,
              operation: 'delete',
              lifecycleEventAt: deleteAttemptStartedAt,
              error,
            });
          }

          if (classification?.kind === 'managed_entity_access_lost' && attempt === 0) {
            try {
              const survivorBotId = await this.resolveGiveawayDeleteBotId(giveaway.sourceChatId);
              if (survivorBotId && !attemptedBotIds.has(survivorBotId)) {
                deleteBotId = survivorBotId;
                continue;
              }
            } catch (survivorError: unknown) {
              this.logger.warn(
                {
                  giveawayId: giveaway.id,
                  messageId: message.messageId,
                  kind: message.kind,
                  botId: deleteBotId,
                  err:
                    survivorError instanceof Error ? survivorError.message : String(survivorError),
                },
                'Failed to resolve a survivor bot for managed giveaway message delete',
              );
            }
          }

          this.logger.warn(
            {
              giveawayId: giveaway.id,
              messageId: message.messageId,
              kind: message.kind,
              botId: deleteBotId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Failed to delete managed giveaway published message',
          );
          throw new BadRequestException(
            'Не удалось удалить опубликованные сообщения розыгрыша в MAX. Повторите позже или проверьте права бота.',
          );
        }
      }
    }
  }

  private collectGiveawayPublishedMessages(
    giveaway: PersistedGiveawayWithRelations,
  ): Array<{ kind: 'publication' | 'results'; messageId: string; botId: string | null }> {
    const messages: Array<{
      kind: 'publication' | 'results';
      messageId: string;
      botId: string | null;
    }> = [];
    const seenMessageIds = new Set<string>();
    const publicationBotId = this.normalizeNonEmptyString(giveaway.publicationBotId);
    const resultsBotId = this.normalizeNonEmptyString(giveaway.resultsBotId);
    const push = (
      kind: 'publication' | 'results',
      messageId: string | null,
      botId: string | null,
    ) => {
      const normalizedMessageId = this.normalizeNonEmptyString(messageId);
      if (!normalizedMessageId || seenMessageIds.has(normalizedMessageId)) {
        return;
      }
      seenMessageIds.add(normalizedMessageId);
      messages.push({ kind, messageId: normalizedMessageId, botId });
    };

    push('publication', giveaway.publicationMessageId, publicationBotId ?? null);
    push('results', giveaway.resultsMessageId, resultsBotId ?? null);
    return messages;
  }

  async resolveManagedGiveawayRequiredChannel(
    sourceChatId: string,
    user: AuthUser,
    body: unknown,
    entityType: ManagedEntityType,
  ): Promise<ResolveRequiredSubscriptionChannelResponse> {
    await this.assertAdminEntityAccess(sourceChatId, user, entityType);

    const parsed = resolveRequiredSubscriptionChannelRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const channel = await this.adminService.resolveRequiredSubscriptionChannelReferenceValue(
      parsed.data.value,
    );
    return resolveRequiredSubscriptionChannelResponseSchema.parse({ channel });
  }

  async getPublicGiveaway(giveawayId: string, _user: AuthUser): Promise<ManagedGiveawayPublic> {
    const refreshed = await this.findPublicGiveawayById(giveawayId);
    await this.upsertParticipantChatAccess(refreshed);

    return managedGiveawayPublicSchema.parse(await this.mapPublicGiveaway(refreshed));
  }

  async getGiveawayParticipantState(
    giveawayId: string,
    user: AuthUser,
  ): Promise<ManagedGiveawayParticipantState> {
    const refreshed = await this.findPublicGiveawayById(giveawayId);
    await this.upsertParticipantChatAccess(refreshed);
    const claimBotId = await this.resolveGiveawayParticipantClaimBotId(refreshed.sourceChatId);

    return managedGiveawayParticipantStateSchema.parse(
      this.mapParticipantState(refreshed, user.userId, claimBotId),
    );
  }

  async enterGiveaway(
    giveawayId: string,
    user: AuthUser,
  ): Promise<ManagedGiveawayParticipantState> {
    const refreshed = await this.findPublicGiveawayById(giveawayId);
    this.assertGiveawayOpenForEntry(refreshed);
    await this.upsertParticipantChatAccess(refreshed);

    const eligibility = await this.evaluateGiveawayEligibility(refreshed, user.userId, {
      forceFreshMembership: true,
      lookupPolicy: 'giveaway_interactive',
      allowStaleMembershipOnError: false,
    });
    const displayName = this.resolveUserDisplayName(user);
    const existing = refreshed.entries.find((entry) => entry.userId === user.userId) ?? null;
    const checkedAt = new Date();
    const saved = await this.prisma.$transaction(async (tx) => {
      // FLAG: Serialize admission with draw/cancel after the remote membership check.
      const admission = await tx.managedGiveaway.updateMany({
        where: {
          id: refreshed.id,
          status: ManagedGiveawayStatus.ACTIVE,
          endsAt: { gt: checkedAt },
          OR: [{ startsAt: null }, { startsAt: { lte: checkedAt } }],
        },
        data: { status: ManagedGiveawayStatus.ACTIVE },
      });
      if (admission.count !== 1) {
        throw new ConflictException('Приём заявок уже закрыт. Обновите итоги.');
      }
      this.assertGiveawayOpenForEntry(refreshed);
      return tx.managedGiveawayEntry.upsert({
        where: {
          giveawayId_userId: {
            giveawayId: refreshed.id,
            userId: user.userId,
          },
        },
        create: {
          giveawayId: refreshed.id,
          userId: user.userId,
          displayName,
          eligibilityState: eligibility.state,
          eligibilityReason: eligibility.reason,
          missingChannelIds: eligibility.missingChannelIds,
          checkedAt,
        },
        update: {
          displayName,
          eligibilityState: eligibility.state,
          eligibilityReason: eligibility.reason,
          missingChannelIds: eligibility.missingChannelIds,
          checkedAt,
        },
      });
    });

    const auditAction = this.resolveGiveawayEntryAuditAction(existing, saved);
    if (auditAction) {
      await this.writeAuditLog(refreshed.sourceChatId, user.userId, auditAction, {
        giveawayId: refreshed.id,
        entityType: this.fromPrismaEntityType(refreshed.entityType),
        previousEntryId: existing?.id ?? null,
        entryId: saved.id,
        eligibilityState: saved.eligibilityState,
        eligibilityReason: saved.eligibilityReason,
        missingChannelIds: this.readMissingChannelIds(saved.missingChannelIds),
      });
    }

    const latest = await this.findGiveawayById(refreshed.id);
    await this.editGiveawayPublicationIfNeeded(latest, latest.status, 'miniapp').catch(
      (error: unknown) => {
        this.logger.warn(
          { giveawayId: latest.id, err: error instanceof Error ? error.message : String(error) },
          'Giveaway entry saved; publication refresh deferred',
        );
      },
    );
    const claimBotId = await this.resolveGiveawayParticipantClaimBotId(latest.sourceChatId);
    return managedGiveawayParticipantStateSchema.parse(
      this.mapParticipantState(latest, user.userId, claimBotId),
    );
  }

  async claimGiveaway(
    giveawayId: string,
    user: AuthUser,
    source: GiveawayActionSource = 'miniapp',
  ): Promise<ClaimManagedGiveawayResponse> {
    const giveaway = await this.findPublicGiveawayById(giveawayId);
    if (giveaway.status !== ManagedGiveawayStatus.COMPLETED) {
      throw new BadRequestException('Розыгрыш ещё не завершён.');
    }

    const winner = giveaway.winners.find(
      (row) =>
        row.entry.userId === user.userId && row.status !== ManagedGiveawayWinnerStatus.REROLLED,
    );
    if (!winner) {
      throw new NotFoundException('Для вас нет актуального приза.');
    }
    if (winner.status === ManagedGiveawayWinnerStatus.CLAIMED) {
      const prizeDisplayTitleById = this.buildPrizeDisplayTitleById(giveaway.prizes);
      return claimManagedGiveawayResponseSchema.parse({
        ok: true,
        winner: this.mapGiveawayWinner(winner, prizeDisplayTitleById),
      });
    }
    if (winner.status !== ManagedGiveawayWinnerStatus.SELECTED) {
      throw new BadRequestException('Приз уже обработан.');
    }
    if (winner.claimDeadlineAt && winner.claimDeadlineAt.getTime() <= Date.now()) {
      await this.prisma.managedGiveawayWinner.updateMany({
        where: {
          id: winner.id,
          status: ManagedGiveawayWinnerStatus.SELECTED,
          claimDeadlineAt: { lte: new Date() },
        },
        data: {
          status: ManagedGiveawayWinnerStatus.EXPIRED,
          expiredAt: new Date(),
        },
      });
      throw new BadRequestException('Срок подтверждения приза уже истёк.');
    }

    const eligibility = await this.evaluateGiveawayEligibility(giveaway, user.userId, {
      strictChannelCheck: true,
      forceFreshMembership: true,
      lookupPolicy: 'giveaway_strict',
      allowStaleMembershipOnError: false,
    });
    if (eligibility.state !== GiveawayEligibilityState.VERIFIED) {
      throw new BadRequestException(
        eligibility.reason || 'Не удалось повторно подтвердить выполнение условий розыгрыша.',
      );
    }

    const updated = await this.prisma
      .$transaction(async (tx) => {
        const transitioned = await this.transitionCurrentGiveawayWinner(
          tx,
          winner,
          ManagedGiveawayWinnerStatus.CLAIMED,
        );
        if (!transitioned) {
          throw new ConflictException(
            'Срок подтверждения истёк или победитель уже изменён. Обновите экран.',
          );
        }
        return tx.managedGiveawayWinner.findUniqueOrThrow({
          where: { id: winner.id },
          include: { prize: true, entry: true },
        });
      })
      .catch((error: unknown) => {
        if (isPrismaKnownError(error, 'P2025')) {
          throw new ConflictException(
            'Срок подтверждения истёк или победитель уже изменён. Обновите экран.',
          );
        }
        throw error;
      });

    await this.writeAuditLog(giveaway.sourceChatId, user.userId, 'CLAIM_GIVEAWAY_WINNER', {
      giveawayId,
      winnerId: updated.id,
      source,
    });

    const refreshed = await this.prisma.managedGiveaway.findUniqueOrThrow({
      where: { id: giveaway.id },
      include: MANAGED_GIVEAWAY_INCLUDE,
    });

    await this.editGiveawayPublicationIfNeeded(refreshed, ManagedGiveawayStatus.COMPLETED, source);
    await this.republishGiveawayResults(refreshed, source);
    const prizeDisplayTitleById = this.buildPrizeDisplayTitleById(refreshed.prizes);

    return claimManagedGiveawayResponseSchema.parse({
      ok: true,
      winner: this.mapGiveawayWinner(updated, prizeDisplayTitleById),
    });
  }

  async processDueManagedGiveaways(reason: 'startup' | 'scheduled'): Promise<void> {
    const decision = await this.resolveManagedGiveawayBackgroundDecision(reason);
    if (decision.action === 'pause') {
      return;
    }

    const now = new Date();
    const firstFamily = this.giveawayDueFirstFamily;
    this.giveawayDueFirstFamily = (firstFamily + 1) % MANAGED_GIVEAWAY_DUE_FAMILIES.length;
    await this.processWinnerNotificationOutbox(
      'runner',
      undefined,
      decision.action === 'slow'
        ? Math.max(1, Math.floor(GIVEAWAY_WINNER_NOTIFICATION_BATCH_SIZE / 2))
        : GIVEAWAY_WINNER_NOTIFICATION_BATCH_SIZE,
      { synchronizeResultsBeforeDispatch: true },
    );
    await this.expireDueGiveawayClaims(now);
    const staleLockBefore = new Date(now.getTime() - GIVEAWAY_LOCK_STALE_MS);
    const processingLimit =
      decision.action === 'slow'
        ? Math.max(1, Math.floor(GIVEAWAY_DUE_BATCH_SIZE / 2))
        : GIVEAWAY_DUE_BATCH_SIZE;
    let fetchRemaining =
      decision.action === 'slow'
        ? Math.max(1, Math.floor(GIVEAWAY_DUE_FETCH_BATCH_SIZE / 2))
        : GIVEAWAY_DUE_FETCH_BATCH_SIZE;
    const exhaustedFamilies = new Set<ManagedGiveawayDueFamily>();
    const inspectedIds = new Set<string>();
    let processed = 0;
    let familyIndex = firstFamily;
    while (
      processed < processingLimit &&
      fetchRemaining > 0 &&
      exhaustedFamilies.size < MANAGED_GIVEAWAY_DUE_FAMILIES.length
    ) {
      const family = MANAGED_GIVEAWAY_DUE_FAMILIES[familyIndex]!;
      familyIndex = (familyIndex + 1) % MANAGED_GIVEAWAY_DUE_FAMILIES.length;
      if (exhaustedFamilies.has(family)) {
        continue;
      }

      let scan = this.giveawayDueScans.get(family);
      if (!scan) {
        scan = { cutoff: now, after: null };
        this.giveawayDueScans.set(family, scan);
      }
      const take = Math.min(processingLimit, fetchRemaining);
      const rows = await this.prisma.$queryRaw<ManagedGiveawayDueRow[]>(
        buildManagedGiveawayDuePageQuery({ family, ...scan, take }),
      );
      fetchRemaining -= rows.length;
      const accessBlockedSourceChatIds = await this.findAccessBlockedGiveawaySourceChatIds(
        rows.map((row) => row.sourceChatId),
      );

      let inspected = 0;
      for (const row of rows) {
        if (processed >= processingLimit) {
          break;
        }
        // FLAG: Checkpoint only the inspected prefix before fallible per-row work.
        // This hint grants no effect authority; failures revisit after wrap. A
        // failed batch access read above leaves the entire page unadvanced.
        scan.after = { dueAt: row.dueAt, id: row.id };
        inspected += 1;
        if (inspectedIds.has(row.id)) {
          continue;
        }
        inspectedIds.add(row.id);
        if (row.lockedAt && row.lockedAt.getTime() >= staleLockBefore.getTime()) {
          continue;
        }
        const sourceChatId = this.normalizeNonEmptyString(row.sourceChatId);
        if (sourceChatId && accessBlockedSourceChatIds.has(sourceChatId)) {
          continue;
        }
        if ((await this.getManagedGiveawayRunnerDeferRemainingMs(row.id)) > 0) {
          continue;
        }
        if ((await this.getManagedGiveawayRunnerBackoffRemainingMs(row.id)) > 0) {
          continue;
        }
        processed += 1;
        await this.processDueManagedGiveaway(row.id, reason, staleLockBefore);
      }

      // FLAG: A short page proves exhaustion only after its whole suffix was
      // inspected. Never wrap a family again in this pass or skip fetched rows
      // when the separate invocation budget stopped inside a page.
      if (inspected === rows.length && rows.length < take) {
        this.giveawayDueScans.delete(family);
        exhaustedFamilies.add(family);
      }
    }
  }

  private async resolveManagedGiveawayBackgroundDecision(
    reason: 'startup' | 'scheduled',
  ): Promise<BackgroundRuntimeGovernorDecision> {
    if (!this.backgroundRuntimeGovernorService) {
      return {
        action: 'run',
        retryAfterMs: 0,
        reason: 'background headroom available',
      };
    }

    try {
      const decision = await this.backgroundRuntimeGovernorService.decide({
        component: 'managed-giveaway',
        sourceTag: MAX_API_SOURCE_TAGS.GIVEAWAY_DRAW_BACKGROUND,
      });
      if (decision.action !== 'run') {
        this.logManagedGiveawayBackgroundThrottleDecision(reason, decision);
      }
      return decision;
    } catch (error: unknown) {
      this.logger.warn(
        { reason, err: error instanceof Error ? error.message : String(error) },
        'Managed giveaway runner governor check failed',
      );
      return {
        action: 'pause',
        retryAfterMs: 180_000,
        reason: 'background governor unavailable',
      };
    }
  }

  private logManagedGiveawayBackgroundThrottleDecision(
    reason: 'startup' | 'scheduled',
    decision: BackgroundRuntimeGovernorDecision,
  ): void {
    const now = Date.now();
    if (now - this.giveawayRunnerThrottleLogAtMs < GIVEAWAY_RUNNER_THROTTLE_LOG_INTERVAL_MS) {
      return;
    }

    this.giveawayRunnerThrottleLogAtMs = now;
    this.logger.log(
      {
        reason,
        action: decision.action,
        details: decision.reason,
        retryAfterMs: decision.retryAfterMs,
      },
      'Throttled managed giveaway background runner because the runtime governor detected pressure',
    );
  }

  private async findAccessBlockedGiveawaySourceChatIds(
    sourceChatIds: readonly (string | null | undefined)[],
  ): Promise<Set<string>> {
    const normalizedSourceChatIds = Array.from(
      new Set(
        sourceChatIds
          .map((chatId) => this.normalizeNonEmptyString(chatId))
          .filter((chatId): chatId is string => Boolean(chatId)),
      ),
    );
    if (normalizedSourceChatIds.length === 0) {
      return new Set();
    }

    const [deniedRows, membershipRows, grantedRows] = await Promise.all([
      typeof this.prisma.managedEntityAccessEdge?.findMany === 'function'
        ? this.prisma.managedEntityAccessEdge.findMany({
            where: {
              chatId: { in: normalizedSourceChatIds },
              state: ManagedEntityAccessState.BOT_DENIED,
            },
            select: { chatId: true, botId: true },
          })
        : Promise.resolve([]),
      typeof this.prisma.chatBotMembership?.findMany === 'function'
        ? this.prisma.chatBotMembership.findMany({
            where: {
              chatId: { in: normalizedSourceChatIds },
              status: {
                in: [ChatBotMembershipStatus.ACTIVE, ChatBotMembershipStatus.REMOVED],
              },
            },
            select: {
              chatId: true,
              botId: true,
              status: true,
              permissionsSnapshot: true,
            },
          })
        : Promise.resolve([]),
      typeof this.prisma.managedEntityAccessEdge?.findMany === 'function'
        ? this.prisma.managedEntityAccessEdge.findMany({
            where: {
              chatId: { in: normalizedSourceChatIds },
              state: ManagedEntityAccessState.GRANTED,
              OR: [
                { expiresAt: { gt: new Date() } },
                {
                  expiresAt: null,
                  checkedAt: {
                    gt: new Date(Date.now() - MANAGED_ENTITY_ACCESS_EDGE_LEGACY_GRACE_MS),
                  },
                },
              ],
            },
            select: { chatId: true, botId: true },
          })
        : Promise.resolve([]),
    ]);
    const activeMembershipBotIdsByChat =
      collectActiveManagedEntityBotMembershipIdsByChat(membershipRows);
    const activeMembershipChatIds = new Set(
      membershipRows
        .filter((row) => {
          if (row.status !== ChatBotMembershipStatus.ACTIVE) {
            return false;
          }
          const snapshot = normalizeMembershipAccessSnapshot(row.permissionsSnapshot);
          return Boolean(snapshot && (snapshot.isAdmin || snapshot.isOwner));
        })
        .map((row) => this.normalizeNonEmptyString(row.chatId))
        .filter((chatId): chatId is string => Boolean(chatId)),
    );
    for (const row of grantedRows) {
      const chatId = this.normalizeNonEmptyString(row.chatId);
      const botId = this.normalizeNonEmptyString(row.botId);
      if (chatId && botId && activeMembershipBotIdsByChat.get(chatId)?.has(botId)) {
        activeMembershipChatIds.add(chatId);
      }
    }

    const removedOnlyMembershipRows = membershipRows.filter(
      (row) =>
        row.status === ChatBotMembershipStatus.REMOVED &&
        !activeMembershipChatIds.has(this.normalizeNonEmptyString(row.chatId) ?? ''),
    );
    return new Set(
      [
        ...deniedRows.filter(
          (row) => !activeMembershipChatIds.has(this.normalizeNonEmptyString(row.chatId) ?? ''),
        ),
        ...removedOnlyMembershipRows,
      ]
        .map((row) => this.normalizeNonEmptyString(row.chatId))
        .filter((chatId): chatId is string => Boolean(chatId)),
    );
  }

  getGiveawaySettingsMiniappUrl(chatId: string, entityType: ManagedEntityType): string | null {
    if (!this.appBaseUrl) {
      return null;
    }

    const encodedChatId = encodeURIComponent(chatId);
    return entityType === 'channel'
      ? `${this.appBaseUrl}/app/channel/${encodedChatId}/settings?focus=giveaway`
      : `${this.appBaseUrl}/app/chat/${encodedChatId}/settings?focus=giveaway`;
  }

  async getCurrentManagedGiveawayForEntity(
    sourceChatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<ManagedGiveawayDetails | null> {
    await this.assertAdminEntityAccess(sourceChatId, user, entityType);

    const row = await this.prisma.managedGiveaway.findFirst({
      where: {
        sourceChatId,
        entityType: this.toPrismaEntityType(entityType),
        status: {
          in: [
            ManagedGiveawayStatus.DRAFT,
            ManagedGiveawayStatus.SCHEDULED,
            ManagedGiveawayStatus.ACTIVE,
            ManagedGiveawayStatus.DRAWING,
            ManagedGiveawayStatus.COMPLETED,
          ],
        },
      },
      orderBy: [{ createdAt: 'desc' }],
      include: MANAGED_GIVEAWAY_INCLUDE,
    });

    return row ? managedGiveawayDetailsSchema.parse(this.mapGiveawayDetails(row)) : null;
  }

  parseClaimStartPayload(payload: string | null): { giveawayId: string; winnerId: string } | null {
    const compactPayload = parseCompactGiveawayClaimStartPayload(
      payload,
      this.maxBotTokenValidationSecrets,
    );
    if (compactPayload) {
      return compactPayload;
    }

    if (!payload || !payload.startsWith(GIVEAWAY_CLAIM_START_PREFIX)) {
      return null;
    }

    const encodedPayload = payload.slice(GIVEAWAY_CLAIM_START_PREFIX.length);
    if (!encodedPayload) {
      return null;
    }

    try {
      const parsed = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as {
        v?: number;
        k?: string;
        g?: string;
        w?: string;
        s?: string;
      };
      if (
        parsed.v !== 1 ||
        parsed.k !== 'giveaway-claim' ||
        typeof parsed.g !== 'string' ||
        typeof parsed.w !== 'string' ||
        typeof parsed.s !== 'string'
      ) {
        return null;
      }
      if (!this.isValidGiveawayClaimSignature(parsed.s, parsed.g, parsed.w)) {
        return null;
      }

      return {
        giveawayId: parsed.g.trim(),
        winnerId: parsed.w.trim(),
      };
    } catch {
      return null;
    }
  }

  async getGiveawayClaimContext(
    giveawayId: string,
    winnerId: string,
    userId: string,
  ): Promise<{
    giveaway: ManagedGiveawayDetails;
    winner: ManagedGiveawayWinner;
  } | null> {
    const giveaway = await this.findGiveawayById(giveawayId);
    const winner = giveaway.winners.find(
      (row) =>
        row.id === winnerId &&
        row.entry.userId === userId &&
        row.status !== ManagedGiveawayWinnerStatus.REROLLED,
    );
    if (!winner) {
      return null;
    }

    return {
      giveaway: managedGiveawayDetailsSchema.parse(this.mapGiveawayDetails(giveaway)),
      winner: managedGiveawayWinnerSchema.parse(
        this.mapGiveawayWinner(winner, this.buildPrizeDisplayTitleById(giveaway.prizes)),
      ),
    };
  }

  buildGiveawayClaimBotStartUrl(
    giveawayId: string,
    winnerId: string,
    botId?: string | null,
  ): string | null {
    const compactPayload = buildCompactGiveawayClaimStartPayload(
      { giveawayId, winnerId },
      this.getCurrentBotToken(botId),
    );
    const payload =
      compactPayload ??
      `${GIVEAWAY_CLAIM_START_PREFIX}${Buffer.from(
        JSON.stringify({
          v: 1,
          k: 'giveaway-claim',
          g: giveawayId,
          w: winnerId,
          s: this.buildGiveawayClaimSignature(giveawayId, winnerId, this.getCurrentBotToken(botId)),
        }),
        'utf8',
      ).toString('base64url')}`;
    if (!isValidMaxBotStartPayload(payload)) {
      return null;
    }

    const targetBotId = botId?.trim() || this.ownBotUserId;
    return (
      this.maxBotLinkService?.buildBotStartUrlSync(payload, botId) ??
      (targetBotId
        ? `https://max.ru/${encodeURIComponent(targetBotId)}?start=${encodeURIComponent(payload)}`
        : null)
    );
  }

  getGiveawayPublicMiniappUrl(giveawayId: string): string | null {
    return this.buildGiveawayDirectWebAppUrl(giveawayId);
  }

  private async assertAdminEntityAccess(
    sourceChatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
  ): Promise<void> {
    if (entityType === 'channel') {
      await this.adminService.getChannelSettings(sourceChatId, user);
      return;
    }

    await this.adminService.getSettings(sourceChatId, user);
  }

  private parseManagedGiveawayDraft(body: unknown): UpdateManagedGiveawayRequest {
    const parsed = updateManagedGiveawayRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const normalized = normalizeManagedGiveawayDraft(parsed.data);
    if (normalized.imageEnabled) {
      const imageBuffer = this.decodeImageBase64(normalized.imageBase64);
      if (imageBuffer.length > GIVEAWAY_IMAGE_MAX_BYTES) {
        throw new BadRequestException('Изображение розыгрыша слишком большое.');
      }
    }

    return normalized;
  }

  private async ensureNoConcurrentManagedGiveaway(
    sourceChatId: string,
    entityType: ManagedEntityType,
    excludeId?: string | null,
    client: Pick<Prisma.TransactionClient, 'managedGiveaway'> = this.prisma,
  ): Promise<void> {
    const existing = await client.managedGiveaway.findFirst({
      where: {
        sourceChatId,
        entityType: this.toPrismaEntityType(entityType),
        status: {
          in: [
            ManagedGiveawayStatus.DRAFT,
            ManagedGiveawayStatus.SCHEDULED,
            ManagedGiveawayStatus.ACTIVE,
            ManagedGiveawayStatus.DRAWING,
          ],
        },
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: {
        id: true,
      },
    });

    if (existing) {
      throw new BadRequestException(
        'У чата уже есть текущий розыгрыш. Завершите или отмените его.',
      );
    }
  }

  private async findGiveawayForSource(
    sourceChatId: string,
    giveawayId: string,
    entityType: ManagedEntityType,
  ): Promise<PersistedGiveawayWithRelations> {
    const row = await this.prisma.managedGiveaway.findFirst({
      where: {
        id: giveawayId,
        sourceChatId,
        entityType: this.toPrismaEntityType(entityType),
      },
      include: MANAGED_GIVEAWAY_INCLUDE,
    });

    if (!row) {
      throw new NotFoundException('Розыгрыш не найден.');
    }

    return row;
  }

  private async findGiveawayById(giveawayId: string): Promise<PersistedGiveawayWithRelations> {
    const row = await this.prisma.managedGiveaway.findUnique({
      where: { id: giveawayId },
      include: MANAGED_GIVEAWAY_INCLUDE,
    });

    if (!row) {
      throw new NotFoundException('Розыгрыш не найден.');
    }

    return row;
  }

  private async findPublicGiveawayById(
    giveawayId: string,
  ): Promise<PersistedGiveawayWithRelations> {
    const giveaway = await this.findGiveawayById(giveawayId);
    if (giveaway.status === ManagedGiveawayStatus.SCHEDULED) {
      await this.activateScheduledGiveawayIfDue(giveaway);
    }

    const refreshed = await this.findGiveawayById(giveawayId);
    this.assertGiveawayPubliclyAccessible(refreshed);
    return refreshed;
  }

  private assertGiveawayPubliclyAccessible(giveaway: PersistedGiveawayWithRelations): void {
    const hasPublicReference =
      Boolean(giveaway.publishedAt) ||
      Boolean(giveaway.publicationMessageId?.trim()) ||
      Boolean(giveaway.publicationUrl?.trim()) ||
      Boolean(giveaway.resultsMessageId?.trim()) ||
      Boolean(giveaway.resultsUrl?.trim());

    if (giveaway.status === ManagedGiveawayStatus.DRAFT) {
      throw new NotFoundException('Розыгрыш не найден.');
    }

    if (giveaway.status === ManagedGiveawayStatus.CANCELED && !hasPublicReference) {
      throw new NotFoundException('Розыгрыш не найден.');
    }
  }

  private mapGiveawaySummary(
    row: PersistedManagedGiveaway & {
      entries: Array<{ eligibilityState: GiveawayEligibilityState }>;
      winners: Array<{ id: string }>;
    },
  ): ManagedGiveawaySummary {
    const entriesCount = row.entries.length;
    const verifiedEntriesCount = row.entries.filter(
      (entry) => entry.eligibilityState === GiveawayEligibilityState.VERIFIED,
    ).length;
    const pendingEntriesCount = row.entries.filter(
      (entry) => entry.eligibilityState === GiveawayEligibilityState.PENDING,
    ).length;

    return {
      id: row.id,
      title: row.title,
      status: row.status,
      hasImage: row.imageEnabled,
      entriesCount,
      verifiedEntriesCount,
      pendingEntriesCount,
      winnersCount: row.winners.length,
      startsAt: row.startsAt?.toISOString() ?? null,
      endsAt: row.endsAt.toISOString(),
      publishedAt: row.publishedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      publicationUrl: row.publicationUrl ?? null,
      resultsUrl: row.resultsUrl ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private mapGiveawayDetails(row: PersistedGiveawayWithRelations): ManagedGiveawayDetails {
    const summary = this.mapGiveawaySummary({
      ...row,
      winners: row.winners.filter(
        (winner) => winner.status !== ManagedGiveawayWinnerStatus.REROLLED,
      ),
    });
    const prizeDisplayTitleById = this.buildPrizeDisplayTitleById(row.prizes);

    return {
      ...summary,
      sourceChatId: row.sourceChatId,
      entityType: this.fromPrismaEntityType(row.entityType),
      description: row.description,
      imageEnabled: row.imageEnabled,
      imageBase64: row.imageBase64,
      imageMimeType: row.imageMimeType,
      imageFileName: row.imageFileName,
      claimHours: row.claimHours,
      requiredChannelIds: this.readRequiredChannelIds(row.requiredChannelIds),
      publicationMessageId: row.publicationMessageId ?? null,
      resultsMessageId: row.resultsMessageId ?? null,
      prizes: row.prizes.map((prize) => ({
        id: prize.id,
        position: prize.position,
        title: prize.title,
        displayTitle: prizeDisplayTitleById.get(prize.id) ?? this.resolvePrizeDisplayTitle(prize),
      })),
      winners: row.winners
        .filter((winner) => winner.status !== ManagedGiveawayWinnerStatus.REROLLED)
        .sort((left, right) => left.prize.position - right.prize.position)
        .map((winner) => this.mapGiveawayWinner(winner, prizeDisplayTitleById)),
    };
  }

  private resolvePrizeDisplayTitle(prize: PersistedManagedGiveawayPrize): string {
    const displayTitle = typeof prize.displayTitle === 'string' ? prize.displayTitle.trim() : '';
    if (displayTitle) {
      return displayTitle;
    }

    const title = prize.title.trim();
    return title || `${prize.position} место`;
  }

  private parseLegacyNumberedPrizeTitle(value: string): { base: string; ordinal: number } | null {
    const normalized = value.trim().replace(/\s+/gu, ' ');
    const match = /^(.+?)\s+(\d{1,3})$/u.exec(normalized);
    if (!match) {
      return null;
    }

    const base = (match[1] ?? '').trim().replace(/\s+/gu, ' ');
    const ordinal = Number(match[2]);
    if (!base || !Number.isInteger(ordinal) || ordinal < 1) {
      return null;
    }

    return { base, ordinal };
  }

  private buildPrizeDisplayTitleById(prizes: PersistedManagedGiveawayPrize[]): Map<string, string> {
    const sortedPrizes = [...prizes].sort((left, right) => left.position - right.position);
    const titlesById = new Map<string, string>();
    const legacyGroups = new Map<string, { ids: string[]; ordinals: number[] }>();

    for (const prize of sortedPrizes) {
      const explicitTitle = typeof prize.displayTitle === 'string' ? prize.displayTitle.trim() : '';
      if (explicitTitle) {
        titlesById.set(prize.id, explicitTitle);
        continue;
      }

      const parsed = this.parseLegacyNumberedPrizeTitle(prize.title);
      if (!parsed) {
        titlesById.set(prize.id, this.resolvePrizeDisplayTitle(prize));
        continue;
      }

      const group = legacyGroups.get(parsed.base) ?? { ids: [], ordinals: [] };
      group.ids.push(prize.id);
      group.ordinals.push(parsed.ordinal);
      legacyGroups.set(parsed.base, group);
    }

    for (const [base, group] of legacyGroups.entries()) {
      const uniqueOrdinals = new Set(group.ordinals);
      const canTreatAsRepeatedPrize =
        group.ids.length > 1 &&
        uniqueOrdinals.size === group.ids.length &&
        group.ordinals.every((ordinal) => ordinal >= 1 && ordinal <= group.ids.length);

      for (const id of group.ids) {
        if (!titlesById.has(id)) {
          const prize = sortedPrizes.find((item) => item.id === id);
          titlesById.set(
            id,
            canTreatAsRepeatedPrize ? base : this.resolvePrizeDisplayTitle(prize!),
          );
        }
      }
    }

    return titlesById;
  }

  private async mapPublicGiveaway(
    row: PersistedGiveawayWithRelations,
  ): Promise<ManagedGiveawayPublic> {
    const requiredChannelIds = this.readRequiredChannelIds(row.requiredChannelIds).filter(
      (channelId) => channelId !== row.sourceChatId,
    );
    const [sourcePresentation, ...requiredPresentations] = await mapWithConcurrencyLimit(
      [row.sourceChatId, ...requiredChannelIds],
      MANAGED_GIVEAWAY_METADATA_CONCURRENCY,
      async (chatId) => {
        const presentation = await this.resolveChatPresentation(chatId);
        return {
          ...presentation,
          id: chatId,
          title: await this.resolveSourceTitle(chatId, presentation.title),
        };
      },
    );
    const prizeDisplayTitleById = this.buildPrizeDisplayTitleById(row.prizes);

    return {
      id: row.id,
      sourceChatId: row.sourceChatId,
      serverTime: new Date().toISOString(),
      sourceTitle: sourcePresentation.title,
      sourceLink: sourcePresentation.link,
      sourceAvatarUrl: sourcePresentation.avatarUrl,
      entityType: this.fromPrismaEntityType(row.entityType),
      title: row.title,
      description: row.description,
      status: row.status,
      imageEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      startsAt: row.startsAt?.toISOString() ?? null,
      endsAt: row.endsAt.toISOString(),
      claimHours: row.claimHours,
      requiredChannelIds,
      requiredChannels: requiredPresentations.map(({ id, title, link }) => ({ id, title, link })),
      entriesCount: this.countPublicGiveawayEntries(row.entries),
      winnersCount: row.winners.filter(
        (winner) => winner.status !== ManagedGiveawayWinnerStatus.REROLLED,
      ).length,
      publishedAt: row.publishedAt?.toISOString() ?? null,
      completedAt: row.completedAt?.toISOString() ?? null,
      publicationUrl: row.publicationUrl ?? null,
      resultsUrl: row.resultsUrl ?? null,
      prizes: row.prizes.map((prize) => ({
        id: prize.id,
        position: prize.position,
        title: prize.title,
        displayTitle: prizeDisplayTitleById.get(prize.id) ?? this.resolvePrizeDisplayTitle(prize),
      })),
      winners:
        row.status === ManagedGiveawayStatus.COMPLETED
          ? row.winners
              .filter((winner) => winner.status !== ManagedGiveawayWinnerStatus.REROLLED)
              .sort((left, right) => left.prize.position - right.prize.position)
              .map((winner) => ({
                prizePosition: winner.prize.position,
                prizeTitle: winner.prize.title,
                prizeDisplayTitle:
                  prizeDisplayTitleById.get(winner.prize.id) ??
                  this.resolvePrizeDisplayTitle(winner.prize),
                displayName: this.resolvePublicWinnerDisplayName(winner),
                status: this.resolveEffectiveWinnerStatus(winner),
              }))
          : [],
    };
  }

  private mapParticipantState(
    row: PersistedGiveawayWithRelations,
    userId: string,
    claimBotId?: string | null,
  ): ManagedGiveawayParticipantState {
    const prizeDisplayTitleById = this.buildPrizeDisplayTitleById(row.prizes);
    const entry = row.entries.find((item) => item.userId === userId) ?? null;
    const winner = entry
      ? (row.winners.find(
          (item) =>
            item.entryId === entry.id && item.status !== ManagedGiveawayWinnerStatus.REROLLED,
        ) ?? null)
      : null;
    const winnerStatus = winner ? this.resolveEffectiveWinnerStatus(winner) : null;
    const canClaim =
      winner?.id && winnerStatus === ManagedGiveawayWinnerStatus.SELECTED
        ? !this.isGiveawayClaimDeadlineExpired(winner, Date.now())
        : false;
    return {
      joined: Boolean(entry),
      checkedAt: entry?.checkedAt?.toISOString() ?? null,
      entryId: entry?.id ?? null,
      eligibilityState: entry ? giveawayEligibilityStateSchema.parse(entry.eligibilityState) : null,
      eligibilityReason: entry?.eligibilityReason ?? null,
      missingChannelIds:
        entry?.eligibilityState === GiveawayEligibilityState.REJECTED
          ? (() => {
              const storedMissingChannelIds = this.readMissingChannelIds(entry.missingChannelIds);
              return storedMissingChannelIds.length > 0
                ? storedMissingChannelIds
                : this.buildGiveawayMandatoryChannelIds(row);
            })()
          : [],
      joinedAt: entry?.joinedAt.toISOString() ?? null,
      isWinner: Boolean(winner),
      winnerId: winner?.id ?? null,
      winnerStatus,
      claimDeadlineAt: winner?.claimDeadlineAt?.toISOString() ?? null,
      prizePosition: winner?.prize.position ?? null,
      prizeTitle: winner?.prize.title ?? null,
      prizeDisplayTitle: winner
        ? (prizeDisplayTitleById.get(winner.prize.id) ??
          this.resolvePrizeDisplayTitle(winner.prize))
        : null,
      canClaim,
      claimBotUrl:
        canClaim && winner
          ? this.buildGiveawayClaimBotStartUrl(row.id, winner.id, claimBotId)
          : null,
    };
  }

  private mapGiveawayWinner(
    winner: PersistedManagedGiveawayWinner & {
      prize: PersistedManagedGiveawayPrize;
      entry: PersistedManagedGiveawayEntry;
    },
    prizeDisplayTitleById?: Map<string, string>,
  ): ManagedGiveawayWinner {
    return {
      id: winner.id,
      prizeId: winner.prizeId,
      prizePosition: winner.prize.position,
      prizeTitle: winner.prize.title,
      prizeDisplayTitle:
        prizeDisplayTitleById?.get(winner.prize.id) ?? this.resolvePrizeDisplayTitle(winner.prize),
      entryId: winner.entryId,
      userId: winner.entry.userId,
      displayName: winner.entry.displayName ?? null,
      status: this.resolveEffectiveWinnerStatus(winner),
      selectedAt: winner.selectedAt.toISOString(),
      claimDeadlineAt: winner.claimDeadlineAt?.toISOString() ?? null,
      claimedAt: winner.claimedAt?.toISOString() ?? null,
      deliveredAt: winner.deliveredAt?.toISOString() ?? null,
      expiredAt: winner.expiredAt?.toISOString() ?? null,
      rerolledAt: winner.rerolledAt?.toISOString() ?? null,
    };
  }

  private resolvePublicWinnerDisplayName(
    winner: PersistedManagedGiveawayWinner & {
      prize: PersistedManagedGiveawayPrize;
      entry: PersistedManagedGiveawayEntry;
    },
  ): string | null {
    const status = this.resolveEffectiveWinnerStatus(winner);
    return status === ManagedGiveawayWinnerStatus.SELECTED ||
      status === ManagedGiveawayWinnerStatus.CLAIMED ||
      status === ManagedGiveawayWinnerStatus.DELIVERED
      ? (winner.entry.displayName ?? null)
      : null;
  }

  private resolveEffectiveWinnerStatus(
    winner: PersistedManagedGiveawayWinner,
  ): ManagedGiveawayWinnerStatus {
    if (
      winner.status === ManagedGiveawayWinnerStatus.SELECTED &&
      this.isGiveawayClaimDeadlineExpired(winner, Date.now())
    ) {
      return ManagedGiveawayWinnerStatus.EXPIRED;
    }

    return winner.status;
  }

  private async transitionCurrentGiveawayWinner(
    tx: Prisma.TransactionClient,
    winner: Pick<PersistedManagedGiveawayWinner, 'id' | 'giveawayId' | 'entryId' | 'status'>,
    nextStatus: 'CLAIMED' | 'DELIVERED',
  ): Promise<boolean> {
    const [locked] = await tx.$queryRaw<Pick<PersistedManagedGiveawayWinner, 'id' | 'status'>[]>`
      SELECT id, status FROM managed_giveaway_winners
      WHERE id = ${winner.id} AND giveaway_id = ${winner.giveawayId}
        AND entry_id = ${winner.entryId}
      FOR UPDATE
    `;
    if (!locked || locked.status !== winner.status) {
      return false;
    }

    const timestampAssignment =
      nextStatus === ManagedGiveawayWinnerStatus.CLAIMED
        ? Prisma.sql`claimed_at = transition_time.checked_at,`
        : Prisma.sql`delivered_at = transition_time.checked_at,`;
    // FLAG: Sample DB time in a separate write after the exact winner lock is owned.
    // A clock read in the locking SELECT can run before its wait; CLAIMED delivery has no deadline.
    const changed = await tx.$queryRaw<Pick<PersistedManagedGiveawayWinner, 'id'>[]>(Prisma.sql`
      WITH transition_time AS MATERIALIZED (
        SELECT clock_timestamp() AT TIME ZONE 'UTC' AS checked_at
      )
      UPDATE managed_giveaway_winners AS current_winner
      SET status = ${nextStatus}::"ManagedGiveawayWinnerStatus",
        ${timestampAssignment}
        updated_at = transition_time.checked_at
      FROM transition_time
      WHERE current_winner.id = ${winner.id}
        AND current_winner.giveaway_id = ${winner.giveawayId}
        AND current_winner.entry_id = ${winner.entryId}
        AND current_winner.status = ${winner.status}::"ManagedGiveawayWinnerStatus"
        AND (current_winner.status <> 'SELECTED'
          OR current_winner.claim_deadline_at IS NULL
          OR current_winner.claim_deadline_at > transition_time.checked_at)
      RETURNING current_winner.id
    `);
    return changed.length === 1;
  }

  private isGiveawayClaimDeadlineExpired(
    winner: Pick<PersistedManagedGiveawayWinner, 'claimDeadlineAt'>,
    nowMs: number,
  ): boolean {
    return Boolean(winner.claimDeadlineAt && winner.claimDeadlineAt.getTime() <= nowMs);
  }

  private buildGiveawayClaimDeadlineAt(
    giveaway: Pick<PersistedManagedGiveaway, 'claimHours'>,
    base: Date,
  ): Date | null {
    const claimHours = Number.isInteger(giveaway.claimHours)
      ? Math.max(1, Math.min(336, giveaway.claimHours))
      : 24;
    return new Date(base.getTime() + claimHours * 60 * 60 * 1_000);
  }

  private formatPublicWinnerName(
    winner: PersistedManagedGiveawayWinner & {
      prize: PersistedManagedGiveawayPrize;
      entry: PersistedManagedGiveawayEntry;
    },
    useRichText = false,
  ): string {
    const displayName = this.resolvePublicWinnerDisplayName(winner);
    if (!displayName) {
      return 'победитель определён';
    }

    if (!useRichText) {
      return displayName;
    }

    return `[${this.escapeMarkdown(displayName)}](max://user/${encodeURIComponent(winner.entry.userId)})`;
  }

  private pickNextRerollCandidate(
    giveaway: PersistedGiveawayWithRelations,
    drawSeed: string,
  ): GiveawayRerollCandidate | null {
    const excludedEntryIds = new Set(giveaway.winners.map((row) => row.entryId));
    return (
      giveaway.entries
        .filter((entry) => entry.eligibilityState === GiveawayEligibilityState.VERIFIED)
        .map((entry) => ({
          entry,
          drawRank: entry.drawRank ?? buildManagedGiveawayDrawRank(drawSeed, entry.userId),
        }))
        .filter(({ entry }) => !excludedEntryIds.has(entry.id))
        .sort(
          (left, right) =>
            left.drawRank.localeCompare(right.drawRank) ||
            left.entry.userId.localeCompare(right.entry.userId),
        )[0] ?? null
    );
  }

  private async uploadGiveawayImage(
    giveaway: Pick<
      PersistedManagedGiveaway,
      'imageEnabled' | 'imageBase64' | 'imageMimeType' | 'imageFileName'
    >,
    botId?: string,
    source: GiveawayActionSource = 'miniapp',
    wrapUploadError = true,
  ): Promise<Record<string, unknown> | undefined> {
    if (!giveaway.imageEnabled) {
      return undefined;
    }

    try {
      const imageBuffer = this.decodeImageBase64(giveaway.imageBase64);
      return botId
        ? await this.maxClient.uploadImage(
            imageBuffer,
            this.resolveImageFileName(giveaway.imageFileName, giveaway.imageMimeType),
            giveaway.imageMimeType,
            buildManagedGiveawayMaxApiOptions(source, 'upload', botId),
          )
        : await this.maxClient.uploadImage(
            imageBuffer,
            this.resolveImageFileName(giveaway.imageFileName, giveaway.imageMimeType),
            giveaway.imageMimeType,
            buildManagedGiveawayMaxApiOptions(source, 'upload'),
          );
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to upload giveaway image',
      );
      if (!wrapUploadError) {
        throw error;
      }
      throw new BadRequestException('Не удалось загрузить изображение розыгрыша.');
    }
  }

  private async buildGiveawayEntryButton(
    giveaway: Pick<PersistedGiveawayWithRelations, 'id' | 'sourceChatId' | 'entries'>,
    botId?: string | null,
  ): Promise<MaxMessageButton | null> {
    return this.buildGiveawayMiniappButton(
      giveaway.sourceChatId,
      giveaway.id,
      `Участвовать · ${this.formatGiveawayEntriesCount(
        this.countPublicGiveawayEntries(giveaway.entries),
      )}`,
      botId,
    );
  }

  private async buildGiveawayOpenButton(
    giveaway: Pick<PersistedGiveawayWithRelations, 'id' | 'sourceChatId'>,
  ): Promise<MaxMessageButton | null> {
    return this.buildGiveawayMiniappButton(giveaway.sourceChatId, giveaway.id, 'Открыть розыгрыш');
  }

  private async buildGiveawayResultsButton(
    giveaway: Pick<PersistedGiveawayWithRelations, 'id' | 'sourceChatId'>,
    botId?: string | null,
  ): Promise<MaxMessageButton | null> {
    return this.buildGiveawayMiniappButton(
      giveaway.sourceChatId,
      giveaway.id,
      'Проверить результаты',
      botId,
    );
  }

  private async buildGiveawayMiniappButton(
    sourceChatId: string,
    giveawayId: string,
    text: string,
    botId?: string | null,
  ): Promise<MaxMessageButton | null> {
    const resolvedBotId = botId ?? (await this.resolveGiveawayButtonBotId(sourceChatId));
    const launchUrl = this.buildGiveawayLaunchUrl(giveawayId);

    if (launchUrl) {
      return {
        type: 'link',
        text,
        url: launchUrl,
      };
    }

    const webAppUrl = this.buildGiveawayDirectWebAppUrl(giveawayId);
    const botContactId = this.resolveBotContactId(resolvedBotId);

    if (webAppUrl && botContactId) {
      return {
        type: 'open_app',
        text,
        webApp: webAppUrl,
        contactId: botContactId,
      };
    }

    if (webAppUrl) {
      return {
        type: 'link',
        text,
        url: webAppUrl,
      };
    }

    return null;
  }

  private formatGiveawayEntriesCount(value: number): string {
    if (value >= 1_000_000) {
      const normalized =
        value >= 10_000_000 ? (value / 1_000_000).toFixed(0) : (value / 1_000_000).toFixed(1);
      return `${normalized.replace(/\.0$/u, '')}M`;
    }

    if (value >= 1_000) {
      const normalized = value >= 10_000 ? (value / 1_000).toFixed(0) : (value / 1_000).toFixed(1);
      return `${normalized.replace(/\.0$/u, '')}K`;
    }

    return String(Math.max(0, value));
  }

  private countPublicGiveawayEntries(
    entries: ReadonlyArray<{ eligibilityState: GiveawayEligibilityState }>,
  ): number {
    return entries.filter((entry) => entry.eligibilityState !== GiveawayEligibilityState.REJECTED)
      .length;
  }

  private buildGiveawayPublicationText(
    giveaway: Pick<PersistedGiveawayWithRelations, 'description' | 'title'>,
  ): string {
    const description = giveaway.description.trim();
    if (description) {
      return description;
    }

    const title = giveaway.title.trim();
    if (title) {
      return title;
    }

    return 'Розыгрыш';
  }

  private buildFormattedGiveawayTextPayload(sourceText: string): {
    text: string;
    textFormat?: MaxSendMessageOptions['textFormat'];
  } {
    const textFormat = containsSupportedMarkdownSyntax(sourceText) ? 'html' : undefined;
    return {
      text: textFormat === 'html' ? renderSupportedMarkdownAsHtml(sourceText) : sourceText,
      ...(textFormat ? { textFormat } : {}),
    };
  }

  private buildGiveawayResultsTextPayload(
    giveaway: PersistedGiveawayWithRelations,
  ): GiveawayResultsTextPayload {
    const text = this.buildGiveawayResultsText(giveaway);
    return containsSupportedMarkdownSyntax(text) ? { text, textFormat: 'markdown' } : { text };
  }

  private buildGiveawayResultsText(giveaway: PersistedGiveawayWithRelations): string {
    const lines: string[] = ['🎉 Результаты розыгрыша:'];
    const prizeDisplayTitleById = this.buildPrizeDisplayTitleById(giveaway.prizes);
    const currentWinners = giveaway.winners
      .filter((winner) => winner.status !== ManagedGiveawayWinnerStatus.REROLLED)
      .sort((left, right) => left.prize.position - right.prize.position);
    const hasPublicationReference = Boolean(giveaway.publicationMessageId?.trim());
    const useRichText = currentWinners.some((winner) =>
      Boolean(this.resolvePublicWinnerDisplayName(winner)),
    );
    const shouldShowPrizeTitle =
      currentWinners.length > 1 &&
      currentWinners.some((winner) => {
        const title = (
          prizeDisplayTitleById.get(winner.prize.id) ?? this.resolvePrizeDisplayTitle(winner.prize)
        ).trim();
        return title.length > 0 && title !== `${winner.prize.position} место`;
      });

    if (!hasPublicationReference && giveaway.title.trim()) {
      lines.push(
        '',
        useRichText ? this.escapeMarkdown(giveaway.title.trim()) : giveaway.title.trim(),
      );
    }

    if (currentWinners.length === 0) {
      lines.push('', 'Подходящих участников не нашлось.');
      return lines.join('\n');
    }

    lines.push('', currentWinners.length === 1 ? '🏆 Победитель:' : '🏆 Победители:', '');
    for (const winner of currentWinners) {
      const effectiveStatus = this.resolveEffectiveWinnerStatus(winner);
      const publicName = this.resolvePublicWinnerDisplayName(winner);
      if (!publicName) {
        lines.push(
          effectiveStatus === ManagedGiveawayWinnerStatus.EXPIRED
            ? `${winner.prize.position}. Место освобождено, можно запустить реролл`
            : `${winner.prize.position}. Победитель определён`,
        );
        continue;
      }

      const prizeTitle = (
        prizeDisplayTitleById.get(winner.prize.id) ?? this.resolvePrizeDisplayTitle(winner.prize)
      ).trim();
      const prizeSuffix = shouldShowPrizeTitle
        ? ` — ${useRichText ? this.escapeMarkdown(prizeTitle) : prizeTitle}`
        : '';
      const statusSuffix =
        effectiveStatus === ManagedGiveawayWinnerStatus.DELIVERED ? ' (приз выдан)' : '';
      lines.push(
        `${winner.prize.position}. ${this.formatPublicWinnerName(winner, useRichText)}${prizeSuffix}${statusSuffix}`,
      );
    }

    return lines.join('\n');
  }

  private async buildGiveawayResultsMessageOptions(
    giveaway: PersistedGiveawayWithRelations,
    botId?: string | null,
    source: GiveawayActionSource = 'miniapp',
  ): Promise<MaxSendMessageOptions | undefined> {
    const buttonRows = await this.buildGiveawayPostActionRows(
      giveaway,
      this.buildGiveawayResultsButton(giveaway, botId),
      source,
    );
    const publicationMessageId = giveaway.publicationMessageId?.trim() ?? '';

    if (!buttonRows && !publicationMessageId) {
      return undefined;
    }

    return {
      ...(buttonRows ? { buttons: buttonRows } : {}),
      ...(publicationMessageId
        ? {
            messageLink: {
              type: 'reply' as const,
              mid: publicationMessageId,
            },
          }
        : {}),
    };
  }

  private async buildGiveawayPostActionRows(
    giveaway: PersistedGiveawayWithRelations,
    actionButton: Promise<MaxMessageButton | null>,
    source: GiveawayActionSource,
  ): Promise<MaxMessageButton[][] | undefined> {
    const sendOptions = buildManagedGiveawayMaxApiOptions(source, 'send');
    const [resolvedActionButton, ctaButton] = await Promise.all([
      actionButton,
      this.channelPostSignatureService?.buildPostButton?.(giveaway.sourceChatId, {
        entityType: this.fromPrismaEntityType(giveaway.entityType),
        trafficClass: sendOptions.trafficClass,
        sourceTag: sendOptions.sourceTag,
      }) ?? Promise.resolve(null),
    ]);
    const rows = buildChannelPostActionRows({
      ctaButton,
      customButtonRows: resolvedActionButton ? [[resolvedActionButton]] : [],
    });
    return rows.length > 0 ? rows : undefined;
  }

  private mergeMessageOptionsWithTextFormat(
    options: MaxSendMessageOptions | undefined,
    textFormat: MaxSendMessageOptions['textFormat'] | undefined,
  ): MaxSendMessageOptions | undefined {
    if (!options && !textFormat) {
      return undefined;
    }

    return {
      ...(options ?? {}),
      ...(textFormat ? { textFormat } : {}),
    };
  }

  private buildGiveawayWinnerDirectMessageText(
    giveaway: GiveawayWinnerNotificationGiveaway,
    winner: PersistedManagedGiveawayWinner & {
      prize: PersistedManagedGiveawayPrize;
      entry: PersistedManagedGiveawayEntry;
    },
  ): string {
    const lines = ['🎉 Вы выиграли в розыгрыше!'];
    const title = giveaway.title.trim();
    const prizeDisplayTitleById = this.buildPrizeDisplayTitleById(giveaway.prizes);
    const prizeTitle = (
      prizeDisplayTitleById.get(winner.prize.id) ?? this.resolvePrizeDisplayTitle(winner.prize)
    ).trim();

    if (title) {
      lines.push('', title);
    }

    lines.push('', `Место: ${winner.prize.position}`);
    if (prizeTitle && prizeTitle !== `${winner.prize.position} место`) {
      lines.push(`Приз: ${prizeTitle}`);
    }

    if (winner.claimDeadlineAt) {
      lines.push(`До: ${winner.claimDeadlineAt.toLocaleString('ru-RU')}`);
    }

    lines.push('', 'Итоги уже опубликованы в группе.');
    return lines.join('\n');
  }

  private buildGiveawayWinnerDirectMessageOptions(
    giveaway: GiveawayWinnerNotificationGiveaway,
    winner: PersistedManagedGiveawayWinner,
    botId?: string | null,
  ): MaxSendMessageOptions | undefined {
    const claimRow: MaxMessageButton[] = [];
    const claimUrl =
      this.resolveEffectiveWinnerStatus(winner) === ManagedGiveawayWinnerStatus.SELECTED
        ? this.buildGiveawayClaimBotStartUrl(giveaway.id, winner.id, botId)
        : null;
    if (claimUrl) {
      claimRow.push({
        type: 'link',
        text: 'Забрать приз',
        url: claimUrl,
      });
    }

    const referenceRow: MaxMessageButton[] = [];

    if (giveaway.publicationUrl) {
      referenceRow.push({
        type: 'link',
        text: 'Открыть пост',
        url: giveaway.publicationUrl,
      });
    }

    if (giveaway.resultsUrl) {
      referenceRow.push({
        type: 'link',
        text: 'Итоги',
        url: giveaway.resultsUrl,
      });
    }

    const buttons = [claimRow, referenceRow].filter((row) => row.length > 0);
    return buttons.length > 0 ? { buttons } : undefined;
  }

  private async processWinnerNotificationOutbox(
    source: GiveawayActionSource,
    giveawayId?: string,
    batchSize = GIVEAWAY_WINNER_NOTIFICATION_BATCH_SIZE,
    options: WinnerNotificationOutboxOptions = {},
  ): Promise<void> {
    const now = new Date();
    const staleLockBefore = new Date(now.getTime() - GIVEAWAY_LOCK_STALE_MS);
    const notificationIds = this.normalizeWinnerNotificationIds(options.notificationIds);
    const winnerIds = this.normalizeWinnerNotificationIds(options.winnerIds);
    if (notificationIds?.length === 0 || winnerIds?.length === 0) {
      return;
    }

    let notifications: PersistedManagedGiveawayWinnerNotification[];

    try {
      await this.prisma.managedGiveawayWinnerNotification.updateMany({
        where: {
          ...(notificationIds ? { id: { in: notificationIds } } : {}),
          ...(winnerIds ? { winnerId: { in: winnerIds } } : {}),
          status: ManagedGiveawayWinnerNotificationStatus.DISPATCHING,
          lockedAt: { lt: staleLockBefore },
          ...(giveawayId ? { winner: { giveawayId } } : {}),
        },
        data: {
          status: ManagedGiveawayWinnerNotificationStatus.AMBIGUOUS,
          ambiguousAt: now,
          lockedAt: null,
          lastError:
            'Winner notification dispatch lease expired after outbound dispatch started; manual verification is required.',
        },
      });

      await this.prisma.managedGiveawayWinnerNotification.updateMany({
        where: {
          ...(notificationIds ? { id: { in: notificationIds } } : {}),
          ...(winnerIds ? { winnerId: { in: winnerIds } } : {}),
          status: {
            in: [
              ManagedGiveawayWinnerNotificationStatus.PENDING,
              ManagedGiveawayWinnerNotificationStatus.RETRYABLE,
            ],
          },
          attemptCount: { gte: GIVEAWAY_WINNER_NOTIFICATION_MAX_ATTEMPTS },
          OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
          ...(giveawayId ? { winner: { giveawayId } } : {}),
        },
        data: {
          status: ManagedGiveawayWinnerNotificationStatus.FAILED_TERMINAL,
          lockedAt: null,
        },
      });

      notifications = await this.findDueWinnerNotifications({
        now,
        staleLockBefore,
        giveawayId,
        batchSize,
        notificationIds,
        winnerIds,
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          giveawayId: giveawayId ?? null,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to load the managed giveaway winner notification outbox',
      );
      return;
    }

    if (options.synchronizeResultsBeforeDispatch) {
      await this.synchronizeResultsAndProcessWinnerNotifications(notifications, source);
      return;
    }

    await this.processWinnerNotifications(notifications, source);
  }

  private async findDueWinnerNotifications(params: {
    now: Date;
    staleLockBefore: Date;
    giveawayId?: string;
    batchSize: number;
    notificationIds: string[] | null;
    winnerIds: string[] | null;
  }): Promise<PersistedManagedGiveawayWinnerNotification[]> {
    return this.prisma.managedGiveawayWinnerNotification.findMany({
      where: {
        ...(params.notificationIds ? { id: { in: params.notificationIds } } : {}),
        ...(params.winnerIds ? { winnerId: { in: params.winnerIds } } : {}),
        status: {
          in: [
            ManagedGiveawayWinnerNotificationStatus.PENDING,
            ManagedGiveawayWinnerNotificationStatus.RETRYABLE,
          ],
        },
        nextAttemptAt: { lte: params.now },
        attemptCount: { lt: GIVEAWAY_WINNER_NOTIFICATION_MAX_ATTEMPTS },
        OR: [{ lockedAt: null }, { lockedAt: { lt: params.staleLockBefore } }],
        winner: {
          status: { not: ManagedGiveawayWinnerStatus.REROLLED },
          giveaway: {
            status: ManagedGiveawayStatus.COMPLETED,
            ...(params.giveawayId ? { id: params.giveawayId } : {}),
          },
        },
      },
      include: MANAGED_GIVEAWAY_WINNER_NOTIFICATION_INCLUDE,
      orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
      take: Math.max(1, Math.min(GIVEAWAY_WINNER_NOTIFICATION_BATCH_SIZE, params.batchSize)),
    });
  }

  private async synchronizeResultsAndProcessWinnerNotifications(
    notifications: PersistedManagedGiveawayWinnerNotification[],
    source: GiveawayActionSource,
  ): Promise<void> {
    const notificationIdsByGiveawayId = new Map<string, string[]>();
    for (const notification of notifications) {
      const giveawayId = notification.winner.giveaway.id;
      const ids = notificationIdsByGiveawayId.get(giveawayId) ?? [];
      ids.push(notification.id);
      notificationIdsByGiveawayId.set(giveawayId, ids);
    }

    for (const [giveawayId, notificationIds] of notificationIdsByGiveawayId) {
      let resultsConfirmed = false;
      try {
        const giveaway = await this.findGiveawayById(giveawayId);
        resultsConfirmed = await this.republishGiveawayResults(giveaway, source);
      } catch (error: unknown) {
        this.logger.warn(
          {
            giveawayId,
            notificationIds,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to synchronize giveaway results before winner notification dispatch',
        );
      }

      if (!resultsConfirmed) {
        await this.deferWinnerNotificationsAfterResultsSyncFailure(notificationIds);
        continue;
      }

      const dispatchNow = new Date();
      try {
        const refreshed = await this.findDueWinnerNotifications({
          now: dispatchNow,
          staleLockBefore: new Date(dispatchNow.getTime() - GIVEAWAY_LOCK_STALE_MS),
          giveawayId,
          batchSize: notificationIds.length,
          notificationIds,
          winnerIds: null,
        });
        await this.processWinnerNotifications(refreshed, source);
      } catch (error: unknown) {
        this.logger.warn(
          {
            giveawayId,
            notificationIds,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to reload winner notifications after giveaway results synchronization',
        );
      }
    }
  }

  private async deferWinnerNotificationsAfterResultsSyncFailure(
    notificationIds: readonly string[],
  ): Promise<void> {
    if (notificationIds.length === 0) {
      return;
    }

    const deferredAt = new Date();
    const staleLockBefore = new Date(deferredAt.getTime() - GIVEAWAY_LOCK_STALE_MS);
    try {
      await this.prisma.managedGiveawayWinnerNotification.updateMany({
        where: {
          id: { in: [...notificationIds] },
          status: {
            in: [
              ManagedGiveawayWinnerNotificationStatus.PENDING,
              ManagedGiveawayWinnerNotificationStatus.RETRYABLE,
            ],
          },
          nextAttemptAt: { lte: deferredAt },
          OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
        },
        data: {
          nextAttemptAt: new Date(
            deferredAt.getTime() + GIVEAWAY_WINNER_NOTIFICATION_RETRY_BASE_MS,
          ),
        },
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          notificationIds,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to defer winner notifications after giveaway results synchronization failure',
      );
    }
  }

  private normalizeWinnerNotificationIds(values: readonly string[] | undefined): string[] | null {
    if (values === undefined) {
      return null;
    }

    return Array.from(
      new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
    );
  }

  private async processWinnerNotifications(
    notifications: PersistedManagedGiveawayWinnerNotification[],
    source: GiveawayActionSource,
  ): Promise<void> {
    for (const notification of notifications) {
      try {
        await this.processWinnerNotification(notification, source);
      } catch (error: unknown) {
        this.logger.warn(
          {
            notificationId: notification.id,
            winnerId: notification.winnerId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to process managed giveaway winner notification outbox row',
        );
      }
    }
  }

  private async processWinnerNotification(
    notification: PersistedManagedGiveawayWinnerNotification,
    source: GiveawayActionSource,
  ): Promise<void> {
    const attemptStartedAt = new Date();
    const staleLockBefore = new Date(attemptStartedAt.getTime() - GIVEAWAY_LOCK_STALE_MS);
    const leaseAt = new Date();
    const claimed = await this.prisma.managedGiveawayWinnerNotification.updateMany({
      where: {
        id: notification.id,
        status: notification.status,
        nextAttemptAt: { lte: attemptStartedAt },
        attemptCount: { lt: GIVEAWAY_WINNER_NOTIFICATION_MAX_ATTEMPTS },
        OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
      },
      data: {
        lockedAt: leaseAt,
        attemptCount: { increment: 1 },
      },
    });
    if (claimed.count === 0) {
      return;
    }

    const attemptCount = notification.attemptCount + 1;
    const winner = notification.winner;
    const giveaway = winner.giveaway;
    let dispatchStarted = false;
    let notificationBotId: string | undefined;
    let acceptedRemoteMessageId: string | null = null;

    // FLAG: DISPATCHING is a one-way automatic-retry fence. Once beforeSend succeeds,
    // every unconfirmed outcome must remain SENT or AMBIGUOUS and must never return to RETRYABLE.
    try {
      notificationBotId = await this.resolveGiveawayPublicationBotId(giveaway.sourceChatId);
      const text = this.buildGiveawayWinnerDirectMessageText(giveaway, winner);
      const baseOptions = this.buildGiveawayWinnerDirectMessageOptions(
        giveaway,
        winner,
        notificationBotId,
      );
      const options = {
        ...(baseOptions ?? {}),
        beforeSend: async () => {
          const dispatchedAt = new Date();
          const transitioned = await this.prisma.managedGiveawayWinnerNotification.updateMany({
            where: {
              id: notification.id,
              status: notification.status,
              lockedAt: leaseAt,
            },
            data: {
              status: ManagedGiveawayWinnerNotificationStatus.DISPATCHING,
              dispatchedAt,
              botId: notificationBotId ?? null,
              lastError: null,
            },
          });
          if (transitioned.count === 0) {
            throw new Error('Managed giveaway winner notification dispatch lease was lost');
          }
          dispatchStarted = true;
        },
      };
      const sent = notificationBotId
        ? await this.maxClient.sendMessageImmediateToUser(
            winner.entry.userId,
            text,
            options,
            buildManagedGiveawayMaxApiOptions(source, 'send', notificationBotId),
          )
        : await this.maxClient.sendMessageImmediateToUser(
            winner.entry.userId,
            text,
            options,
            buildManagedGiveawayMaxApiOptions(source, 'send'),
          );
      acceptedRemoteMessageId = sent.messageId;
      const completedAt = new Date();
      const saved = await this.prisma.managedGiveawayWinnerNotification.updateMany({
        where: {
          id: notification.id,
          status: ManagedGiveawayWinnerNotificationStatus.DISPATCHING,
          lockedAt: leaseAt,
        },
        data: {
          status: ManagedGiveawayWinnerNotificationStatus.SENT,
          remoteMessageId: sent.messageId,
          sentAt: completedAt,
          lockedAt: null,
          nextAttemptAt: completedAt,
          lastError: null,
        },
      });
      if (saved.count === 0) {
        this.logger.warn(
          {
            notificationId: notification.id,
            giveawayId: giveaway.id,
            winnerId: winner.id,
            remoteMessageId: sent.messageId,
          },
          'Winner notification was accepted by MAX but its outbox completion fence was lost',
        );
      }
    } catch (error: unknown) {
      if (acceptedRemoteMessageId) {
        const completedAt = new Date();
        await this.prisma.managedGiveawayWinnerNotification.updateMany({
          where: {
            id: notification.id,
            status: ManagedGiveawayWinnerNotificationStatus.DISPATCHING,
            lockedAt: leaseAt,
          },
          data: {
            status: ManagedGiveawayWinnerNotificationStatus.SENT,
            remoteMessageId: acceptedRemoteMessageId,
            sentAt: completedAt,
            lockedAt: null,
            nextAttemptAt: completedAt,
            lastError: null,
          },
        });
        return;
      }

      const attempted = dispatchStarted || wasMaxMessageSendAttempted(error);
      const lastError = this.formatWinnerNotificationError(error);
      const failedAt = new Date();
      if (attempted) {
        await this.prisma.managedGiveawayWinnerNotification.updateMany({
          where: {
            id: notification.id,
            lockedAt: leaseAt,
            status: {
              in: [notification.status, ManagedGiveawayWinnerNotificationStatus.DISPATCHING],
            },
          },
          data: {
            status: ManagedGiveawayWinnerNotificationStatus.AMBIGUOUS,
            ambiguousAt: failedAt,
            botId: notificationBotId ?? null,
            lockedAt: null,
            lastError,
          },
        });
        this.logger.warn(
          {
            notificationId: notification.id,
            giveawayId: giveaway.id,
            winnerId: winner.id,
            userId: winner.entry.userId,
            err: lastError,
          },
          'Managed giveaway winner notification send is ambiguous; automatic retry is blocked',
        );
        return;
      }

      const terminal = attemptCount >= GIVEAWAY_WINNER_NOTIFICATION_MAX_ATTEMPTS;
      await this.prisma.managedGiveawayWinnerNotification.updateMany({
        where: {
          id: notification.id,
          status: notification.status,
          lockedAt: leaseAt,
        },
        data: {
          status: terminal
            ? ManagedGiveawayWinnerNotificationStatus.FAILED_TERMINAL
            : ManagedGiveawayWinnerNotificationStatus.RETRYABLE,
          nextAttemptAt: terminal
            ? failedAt
            : new Date(failedAt.getTime() + this.winnerNotificationRetryDelayMs(attemptCount)),
          lockedAt: null,
          lastError,
        },
      });
      this.logger.warn(
        {
          notificationId: notification.id,
          giveawayId: giveaway.id,
          winnerId: winner.id,
          userId: winner.entry.userId,
          attemptCount,
          terminal,
          err: lastError,
        },
        'Failed before dispatching managed giveaway winner notification',
      );
    }
  }

  private winnerNotificationRetryDelayMs(attemptCount: number): number {
    const exponent = Math.max(0, Math.min(10, attemptCount - 1));
    return Math.min(
      GIVEAWAY_WINNER_NOTIFICATION_RETRY_MAX_MS,
      GIVEAWAY_WINNER_NOTIFICATION_RETRY_BASE_MS * 2 ** exponent,
    );
  }

  private formatWinnerNotificationError(error: unknown): string {
    const message = error instanceof Error && error.message.trim() ? error.message : String(error);
    return message.slice(0, 2_000);
  }

  private async editGiveawayPublicationIfNeeded(
    giveaway: PersistedGiveawayWithRelations,
    status: ManagedGiveawayStatus,
    source: GiveawayActionSource = 'miniapp',
  ): Promise<void> {
    const messageId = giveaway.publicationMessageId?.trim() ?? '';
    if (!messageId) {
      return;
    }

    let publicationBotId: string | undefined;
    let editAttemptStartedAt: Date | null = null;
    try {
      publicationBotId =
        this.normalizeNonEmptyString(giveaway.publicationBotId) ??
        (await this.resolveGiveawayPublicationBotId(giveaway.sourceChatId));
      if (status === ManagedGiveawayStatus.CANCELED) {
        const buttons = await this.buildGiveawayPostActionRows(
          giveaway,
          this.buildGiveawayOpenButton(giveaway),
          source,
        );
        const options = buttons ? { buttons } : undefined;
        editAttemptStartedAt = new Date();
        if (publicationBotId) {
          await this.maxClient.editMessageInlineKeyboard(
            giveaway.sourceChatId,
            messageId,
            null,
            options,
            buildManagedGiveawayMaxApiOptions(source, 'send', publicationBotId),
          );
        } else {
          await this.maxClient.editMessageInlineKeyboard(
            giveaway.sourceChatId,
            messageId,
            null,
            options,
            buildManagedGiveawayMaxApiOptions(source, 'send'),
          );
        }
        return;
      }

      if (status === ManagedGiveawayStatus.ACTIVE) {
        const buttons = await this.buildGiveawayPostActionRows(
          giveaway,
          this.buildGiveawayEntryButton(giveaway),
          source,
        );
        const options = buttons ? { buttons } : undefined;
        editAttemptStartedAt = new Date();
        if (publicationBotId) {
          await this.maxClient.editMessageInlineKeyboard(
            giveaway.sourceChatId,
            messageId,
            null,
            options,
            buildManagedGiveawayMaxApiOptions(source, 'send', publicationBotId),
          );
        } else {
          await this.maxClient.editMessageInlineKeyboard(
            giveaway.sourceChatId,
            messageId,
            null,
            options,
            buildManagedGiveawayMaxApiOptions(source, 'send'),
          );
        }
        return;
      }

      const buttons = await this.buildGiveawayPostActionRows(
        giveaway,
        this.buildGiveawayOpenButton(giveaway),
        source,
      );
      const options = buttons ? { buttons } : undefined;
      editAttemptStartedAt = new Date();
      if (publicationBotId) {
        await this.maxClient.editMessageInlineKeyboard(
          giveaway.sourceChatId,
          messageId,
          null,
          options,
          buildManagedGiveawayMaxApiOptions(source, 'send', publicationBotId),
        );
      } else {
        await this.maxClient.editMessageInlineKeyboard(
          giveaway.sourceChatId,
          messageId,
          null,
          options,
          buildManagedGiveawayMaxApiOptions(source, 'send'),
        );
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          giveawayId: giveaway.id,
          sourceChatId: giveaway.sourceChatId,
          status,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to edit giveaway publication message',
      );
      if (editAttemptStartedAt) {
        await this.recordManagedGiveawayMaxAccessLoss({
          giveaway,
          botId: publicationBotId ?? null,
          source: 'managed_giveaway:publication',
          operation: 'edit',
          lifecycleEventAt: editAttemptStartedAt,
          error,
        });
      }
    }
  }

  private buildGiveawaySendLockKey(giveawayId: string, phase: GiveawayRoutedSendPhase): string {
    return `managed-giveaway:${phase}:${giveawayId}`;
  }

  private buildGiveawayResultsReplacementSendLockKey(
    giveawayId: string,
    replacedMessageId: string,
  ): string {
    const digest = createHash('sha256')
      .update(giveawayId)
      .update('\0')
      .update(replacedMessageId)
      .digest('hex')
      .slice(0, GIVEAWAY_RESULTS_REPLACEMENT_DIGEST_HEX_LENGTH);
    return `managed-giveaway:results-replacement:${giveawayId}:${digest}`;
  }

  private resolveGiveawaySendLockKey(
    giveaway: PersistedGiveawayWithRelations,
    phase: GiveawayRoutedSendPhase,
  ): string {
    const storedLockKey = this.normalizeNonEmptyString(giveaway.sendLockKey);
    if (
      phase === 'results' &&
      !giveaway.resultsMessageId &&
      storedLockKey &&
      this.isGiveawayResultsReplacementSendLockKey(giveaway.id, storedLockKey)
    ) {
      return storedLockKey;
    }
    return this.buildGiveawaySendLockKey(giveaway.id, phase);
  }

  private isGiveawayResultsReplacementSendLockKey(giveawayId: string, lockKey: string): boolean {
    const replacementPrefix = `managed-giveaway:results-replacement:${giveawayId}:`;
    return (
      lockKey.startsWith(replacementPrefix) &&
      GIVEAWAY_RESULTS_REPLACEMENT_DIGEST_PATTERN.test(lockKey.slice(replacementPrefix.length))
    );
  }

  private assertProductionRoutedPublicationAvailable(): void {
    if (!this.maxRoutedPublicationService && process.env.NODE_ENV === 'production') {
      throw new ServiceUnavailableException(
        'Routed MAX publication service is required for production managed giveaways',
      );
    }
  }

  private buildGiveawaySendLedgerJob(
    giveaway: PersistedGiveawayWithRelations,
    phase: GiveawayRoutedSendPhase,
    source: GiveawayActionSource,
  ): MaxActionJob {
    const sendOptions = buildManagedGiveawayMaxApiOptions(source, 'send');
    return {
      actionType: 'SEND_MESSAGE',
      chatId: giveaway.sourceChatId,
      trafficClass: sendOptions.trafficClass,
      actionHealthLane: sendOptions.actionHealthLane,
      sourceTag: sendOptions.sourceTag,
      timeoutMs: sendOptions.timeoutMs,
      text: ' ',
      attempt: 1,
      idempotencyKey: this.resolveGiveawaySendLockKey(giveaway, phase),
      createdAt: new Date().toISOString(),
    };
  }

  private async reconcileStaleGiveawaySendLock(
    giveaway: PersistedGiveawayWithRelations,
    phase: GiveawayRoutedSendPhase,
    source: GiveawayActionSource,
  ): Promise<GiveawaySendLockReconciliation> {
    const lockedAt = giveaway.lockedAt;
    const expectedLockKey = this.resolveGiveawaySendLockKey(giveaway, phase);
    if (
      !lockedAt ||
      lockedAt.getTime() > Date.now() - GIVEAWAY_LOCK_STALE_MS ||
      this.normalizeNonEmptyString(giveaway.sendLockKey) !== expectedLockKey ||
      !this.maxRoutedPublicationService ||
      !this.maxActionLedgerService
    ) {
      return { kind: 'blocked' };
    }

    const job = this.buildGiveawaySendLedgerJob(giveaway, phase, source);
    let completed: Awaited<ReturnType<MaxActionLedgerService['getCompletedSendDispatchResult']>> =
      null;
    try {
      completed = await this.maxActionLedgerService.getCompletedSendDispatchResult(job);
    } catch (error: unknown) {
      this.logger.warn(
        {
          giveawayId: giveaway.id,
          phase,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to inspect the routed giveaway send ledger during stale-lock recovery',
      );
      return { kind: 'blocked' };
    }

    if (completed) {
      const botId = this.normalizeNonEmptyString(completed.dispatchBotId);
      if (!botId) {
        this.logger.warn(
          {
            giveawayId: giveaway.id,
            phase,
            messageId: completed.remoteMessageId,
          },
          'Kept routed giveaway send quarantined because its completed ledger has no dispatch bot',
        );
        return { kind: 'blocked' };
      }

      let url: string | null = null;
      try {
        const sendOptions = buildManagedGiveawayMaxApiOptions(source, 'send', botId);
        url = await this.maxClient.resolveMessageLink(completed.remoteMessageId, sendOptions);
      } catch (error: unknown) {
        this.logger.warn(
          {
            giveawayId: giveaway.id,
            phase,
            messageId: completed.remoteMessageId,
            botId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Recovered routed giveaway message id but could not hydrate its MAX link',
        );
      }
      return {
        kind: 'completed',
        messageId: completed.remoteMessageId,
        botId,
        url,
      };
    }

    try {
      await this.maxActionLedgerService.assertCanEnqueue(job);
    } catch (error: unknown) {
      this.logger.warn(
        {
          giveawayId: giveaway.id,
          phase,
          err: error instanceof Error ? error.message : String(error),
        },
        'Kept unresolved routed giveaway send quarantined after stale-lock inspection',
      );
      return { kind: 'blocked' };
    }

    const released = await this.prisma.managedGiveaway.updateMany({
      where: {
        id: giveaway.id,
        lockedAt,
        sendLockKey: expectedLockKey,
        ...(phase === 'publication'
          ? {
              status: ManagedGiveawayStatus.DRAFT,
              publicationMessageId: null,
            }
          : { resultsMessageId: null }),
      },
      data: {
        lockedAt: null,
        sendLockKey:
          phase === 'results' &&
          this.isGiveawayResultsReplacementSendLockKey(giveaway.id, expectedLockKey)
            ? expectedLockKey
            : null,
      },
    });
    if (released.count === 0) {
      return { kind: 'blocked' };
    }

    this.logger.log(
      {
        giveawayId: giveaway.id,
        phase,
      },
      'Released stale routed giveaway lock before any durable send dispatch was claimed',
    );
    return { kind: 'retryable' };
  }

  private async republishGiveawayResults(
    giveaway: PersistedGiveawayWithRelations,
    source: GiveawayActionSource = 'miniapp',
  ): Promise<boolean> {
    const baseResultsTextPayload = this.buildGiveawayResultsTextPayload(giveaway);
    const sendOptions = buildManagedGiveawayMaxApiOptions(source, 'send');
    const resultsTextPayload = this.channelPostSignatureService
      ? await this.channelPostSignatureService.preparePostText(
          giveaway.sourceChatId,
          baseResultsTextPayload,
          {
            entityType: this.fromPrismaEntityType(giveaway.entityType),
            trafficClass: sendOptions.trafficClass,
            sourceTag: sendOptions.sourceTag,
          },
        )
      : baseResultsTextPayload;
    const resultsSendLockKey = this.resolveGiveawaySendLockKey(giveaway, 'results');
    if (!giveaway.resultsMessageId?.trim()) {
      this.assertProductionRoutedPublicationAvailable();
      if (giveaway.lockedAt) {
        const reconciliation = await this.reconcileStaleGiveawaySendLock(
          giveaway,
          'results',
          source,
        );
        if (reconciliation.kind === 'completed') {
          const recovered = await this.prisma.managedGiveaway.updateMany({
            where: {
              id: giveaway.id,
              resultsMessageId: null,
              lockedAt: giveaway.lockedAt,
              sendLockKey: resultsSendLockKey,
            },
            data: {
              resultsMessageId: reconciliation.messageId,
              resultsBotId: reconciliation.botId,
              resultsUrl: reconciliation.url,
              lockedAt: null,
              sendLockKey: null,
            },
          });
          if (recovered.count > 0) {
            this.logger.log(
              {
                giveawayId: giveaway.id,
                sourceChatId: giveaway.sourceChatId,
                messageId: reconciliation.messageId,
                botId: reconciliation.botId,
              },
              'Recovered managed giveaway results publication from the durable send ledger',
            );
            return this.editGiveawayResultsMessage(
              {
                ...giveaway,
                resultsMessageId: reconciliation.messageId,
                resultsBotId: reconciliation.botId,
                resultsUrl: reconciliation.url,
                lockedAt: null,
                sendLockKey: null,
              },
              resultsTextPayload,
              source,
            );
          }
          return false;
        }
        if (reconciliation.kind !== 'retryable') {
          this.logger.warn(
            { giveawayId: giveaway.id, sourceChatId: giveaway.sourceChatId },
            'Managed giveaway results send is locked for manual verification',
          );
          return false;
        }
      }

      const resultLockAt = new Date();
      const lock = await this.prisma.managedGiveaway.updateMany({
        where: {
          id: giveaway.id,
          resultsMessageId: null,
          lockedAt: null,
        },
        data: {
          lockedAt: resultLockAt,
          sendLockKey: this.maxRoutedPublicationService ? resultsSendLockKey : null,
        },
      });
      if (lock.count === 0) {
        return false;
      }

      let resultsBotId: string | null = null;
      let maxSendAttempted = false;
      let maxSendAttemptStartedAt: Date | null = null;
      let maxSendAccepted = false;
      let dispatchedResultsBotId: string | null = null;
      try {
        resultsBotId = this.maxRoutedPublicationService
          ? null
          : (this.normalizeNonEmptyString(giveaway.resultsBotId) ??
            this.normalizeNonEmptyString(giveaway.publicationBotId) ??
            (await this.resolveGiveawayPublicationBotId(giveaway.sourceChatId)) ??
            null);
        dispatchedResultsBotId = resultsBotId;
        const result = this.maxRoutedPublicationService
          ? await this.maxRoutedPublicationService.publish({
              entityId: giveaway.sourceChatId,
              logicalIdempotencyKey: resultsSendLockKey,
              text: resultsTextPayload.text,
              trafficClass: sendOptions.trafficClass,
              actionHealthLane: sendOptions.actionHealthLane,
              sourceTag: sendOptions.sourceTag,
              timeoutMs: sendOptions.timeoutMs,
              prepareAttempt: async ({ botId }) => {
                const options = this.mergeMessageOptionsWithTextFormat(
                  await this.buildGiveawayResultsMessageOptions(giveaway, botId, source),
                  resultsTextPayload.textFormat,
                );
                return options ? { options } : {};
              },
              onDispatchAttempt: ({ botId }) => {
                maxSendAttemptStartedAt = new Date();
                maxSendAttempted = true;
                dispatchedResultsBotId = botId;
              },
            })
          : await (async () => {
              const resultOptions = this.mergeMessageOptionsWithTextFormat(
                await this.buildGiveawayResultsMessageOptions(giveaway, resultsBotId, source),
                resultsTextPayload.textFormat,
              );
              maxSendAttemptStartedAt = new Date();
              maxSendAttempted = true;
              return resultsBotId
                ? this.maxClient.sendMessageImmediateWithResolvedLink(
                    giveaway.sourceChatId,
                    resultsTextPayload.text,
                    resultOptions,
                    buildManagedGiveawayMaxApiOptions(source, 'send', resultsBotId),
                  )
                : this.maxClient.sendMessageImmediateWithResolvedLink(
                    giveaway.sourceChatId,
                    resultsTextPayload.text,
                    resultOptions,
                    buildManagedGiveawayMaxApiOptions(source, 'send'),
                  );
            })();
        if ('botId' in result && typeof result.botId === 'string') {
          dispatchedResultsBotId = result.botId;
        }
        maxSendAccepted = true;
        await this.prisma.managedGiveaway.update({
          where: { id: giveaway.id },
          data: {
            resultsMessageId: result.messageId,
            resultsBotId: dispatchedResultsBotId,
            resultsUrl: result.url,
            lockedAt: null,
            sendLockKey: null,
          },
        });
        if (this.maxRoutedPublicationService && !maxSendAttempted) {
          return this.editGiveawayResultsMessage(
            {
              ...giveaway,
              resultsMessageId: result.messageId,
              resultsBotId: dispatchedResultsBotId,
              resultsUrl: result.url,
              lockedAt: null,
              sendLockKey: null,
            },
            resultsTextPayload,
            source,
          );
        }
        return true;
      } catch (error: unknown) {
        const shouldQuarantine =
          maxSendAccepted || (maxSendAttempted && isAmbiguousMaxSendError(error));
        this.logger.warn(
          {
            giveawayId: giveaway.id,
            botId: dispatchedResultsBotId,
            err: error instanceof Error ? error.message : String(error),
          },
          shouldQuarantine
            ? 'Managed giveaway results send is ambiguous; leaving results lock for manual verification'
            : 'Failed to publish giveaway results message',
        );
        if (!shouldQuarantine) {
          await this.prisma.managedGiveaway.updateMany({
            where: {
              id: giveaway.id,
              resultsMessageId: null,
              lockedAt: resultLockAt,
              sendLockKey: this.maxRoutedPublicationService ? resultsSendLockKey : null,
            },
            data: {
              lockedAt: null,
              sendLockKey: this.isGiveawayResultsReplacementSendLockKey(
                giveaway.id,
                resultsSendLockKey,
              )
                ? resultsSendLockKey
                : null,
            },
          });
          if (!this.maxRoutedPublicationService && maxSendAttemptStartedAt) {
            await this.recordManagedGiveawayMaxAccessLoss({
              giveaway,
              botId: resultsBotId,
              source: 'managed_giveaway:results',
              operation: 'send',
              lifecycleEventAt: maxSendAttemptStartedAt,
              error,
            });
          }
        }
        return false;
      }
    }

    return this.editGiveawayResultsMessage(giveaway, resultsTextPayload, source);
  }

  private async editGiveawayResultsMessage(
    giveaway: PersistedGiveawayWithRelations,
    resultsTextPayload: GiveawayResultsTextPayload,
    source: GiveawayActionSource,
  ): Promise<boolean> {
    const resultsMessageId = giveaway.resultsMessageId?.trim();
    if (!resultsMessageId) {
      return false;
    }

    let resultsBotId =
      this.normalizeNonEmptyString(giveaway.resultsBotId) ??
      this.normalizeNonEmptyString(giveaway.publicationBotId) ??
      undefined;
    let editAttemptStartedAt: Date | null = null;
    try {
      if (!resultsBotId) {
        resultsBotId = await this.resolveGiveawayPublicationBotId(giveaway.sourceChatId);
      }
      const resultOptions = this.mergeMessageOptionsWithTextFormat(
        await this.buildGiveawayResultsMessageOptions(giveaway, resultsBotId, source),
        resultsTextPayload.textFormat,
      );
      editAttemptStartedAt = new Date();
      if (resultsBotId) {
        await this.maxClient.editMessageInlineKeyboard(
          giveaway.sourceChatId,
          resultsMessageId,
          resultsTextPayload.text,
          resultOptions,
          buildManagedGiveawayMaxApiOptions(source, 'send', resultsBotId),
        );
      } else {
        await this.maxClient.editMessageInlineKeyboard(
          giveaway.sourceChatId,
          resultsMessageId,
          resultsTextPayload.text,
          resultOptions,
          buildManagedGiveawayMaxApiOptions(source, 'send'),
        );
      }
      return true;
    } catch (error: unknown) {
      if (
        await this.replaceDefinitivelyUneditableGiveawayResultsMessage({
          giveaway,
          resultsMessageId,
          resultsBotId: resultsBotId ?? null,
          source,
          error,
        })
      ) {
        return true;
      }
      this.logger.warn(
        {
          giveawayId: giveaway.id,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to refresh giveaway results message',
      );
      if (editAttemptStartedAt) {
        await this.recordManagedGiveawayMaxAccessLoss({
          giveaway,
          botId: resultsBotId ?? null,
          source: 'managed_giveaway:results',
          operation: 'edit',
          lifecycleEventAt: editAttemptStartedAt,
          error,
        });
      }
      return false;
    }
  }

  private async replaceDefinitivelyUneditableGiveawayResultsMessage(params: {
    giveaway: PersistedGiveawayWithRelations;
    resultsMessageId: string;
    resultsBotId: string | null;
    source: GiveawayActionSource;
    error: unknown;
  }): Promise<boolean> {
    if (!this.isDefinitiveGiveawayResultsEditFailure(params.error)) {
      return false;
    }

    let presence: 'present' | 'absent';
    const lookupAttemptStartedAt = new Date();
    try {
      presence = await this.maxClient.getExactMessagePresence(
        params.giveaway.sourceChatId,
        params.resultsMessageId,
        {
          ...buildManagedGiveawayMaxApiOptions(params.source, 'send', params.resultsBotId),
          bypassCache: true,
          ignoreFailureMetricStatuses: [404],
        },
      );
    } catch (lookupError: unknown) {
      await this.recordManagedGiveawayMaxAccessLoss({
        giveaway: params.giveaway,
        botId: params.resultsBotId,
        source: 'managed_giveaway:results:verification',
        operation: 'message_lookup',
        lifecycleEventAt: lookupAttemptStartedAt,
        error: lookupError,
      });
      this.logger.warn(
        {
          giveawayId: params.giveaway.id,
          messageId: params.resultsMessageId,
          botId: params.resultsBotId,
          err: lookupError instanceof Error ? lookupError.message : String(lookupError),
        },
        'Could not verify uneditable giveaway results message before replacement',
      );
      return false;
    }
    if (presence !== 'present' && presence !== 'absent') {
      return false;
    }

    const replacementSendLockKey = this.buildGiveawayResultsReplacementSendLockKey(
      params.giveaway.id,
      params.resultsMessageId,
    );
    const replaced = await this.prisma.managedGiveaway.updateMany({
      where: {
        id: params.giveaway.id,
        status: ManagedGiveawayStatus.COMPLETED,
        resultsMessageId: params.resultsMessageId,
        lockedAt: params.giveaway.lockedAt,
        sendLockKey: params.giveaway.sendLockKey,
      },
      data: {
        resultsMessageId: null,
        resultsBotId: null,
        resultsUrl: null,
        lockedAt: null,
        sendLockKey: replacementSendLockKey,
      },
    });
    if (replaced.count === 0) {
      return false;
    }

    this.logger.warn(
      {
        giveawayId: params.giveaway.id,
        replacedMessageId: params.resultsMessageId,
        verifiedPresence: presence,
      },
      'Fenced an uneditable giveaway results message for deterministic replacement',
    );
    return this.republishGiveawayResults(
      {
        ...params.giveaway,
        resultsMessageId: null,
        resultsBotId: null,
        resultsUrl: null,
        lockedAt: null,
        sendLockKey: replacementSendLockKey,
      },
      params.source,
    );
  }

  private isDefinitiveGiveawayResultsEditFailure(error: unknown): boolean {
    if (shouldRecreateEditableMessage(error)) {
      return true;
    }

    const response = (error as { response?: { status?: unknown; data?: unknown } } | null)
      ?.response;
    if (response?.status === 404) {
      return true;
    }
    if (
      response?.status !== 200 ||
      !response.data ||
      typeof response.data !== 'object' ||
      Array.isArray(response.data)
    ) {
      return false;
    }

    const payload = response.data as Record<string, unknown>;
    return payload.success === false && payload.message === 'Error on message edit';
  }

  private async recordManagedGiveawayMaxAccessLoss(params: {
    giveaway: PersistedGiveawayWithRelations;
    botId: string | null;
    source: string;
    operation: 'send' | 'edit' | 'delete' | 'message_lookup';
    lifecycleEventAt: Date;
    error: unknown;
  }): Promise<void> {
    try {
      const result = await this.managedEntityAccessLossService?.recordIfManagedEntityAccessLost?.({
        chatId: params.giveaway.sourceChatId,
        botId: params.botId,
        entityType: params.giveaway.entityType,
        source: params.source,
        operation: params.operation,
        error: params.error,
        lifecycleEventAt: params.lifecycleEventAt,
        lifecycleEventType: 'live_probe',
        lifecycleSource: 'live_probe',
      });
      if (result?.recorded) {
        this.logger.warn(
          {
            giveawayId: params.giveaway.id,
            sourceChatId: params.giveaway.sourceChatId,
            botId: params.botId,
            source: params.source,
            operation: params.operation,
            reason: result.reason,
          },
          'Managed giveaway source lost MAX access and runtime work was stopped',
        );
      }
    } catch (accessLossError: unknown) {
      this.logger.debug(
        {
          giveawayId: params.giveaway.id,
          sourceChatId: params.giveaway.sourceChatId,
          err: accessLossError instanceof Error ? accessLossError.message : String(accessLossError),
        },
        'Failed to record managed giveaway MAX access loss',
      );
    }
  }

  private escapeMarkdown(value: string): string {
    return value.replace(/([\\_*[\]()`~+])/g, '\\$1');
  }

  private assertGiveawayOpenForEntry(giveaway: PersistedGiveawayWithRelations): void {
    const now = Date.now();
    if (giveaway.status !== ManagedGiveawayStatus.ACTIVE) {
      throw new BadRequestException(
        giveaway.status === ManagedGiveawayStatus.SCHEDULED
          ? 'Розыгрыш ещё не стартовал.'
          : 'Участие в этом розыгрыше уже закрыто.',
      );
    }
    if (giveaway.startsAt && giveaway.startsAt.getTime() > now) {
      throw new BadRequestException('Розыгрыш ещё не стартовал.');
    }
    if (giveaway.endsAt.getTime() <= now) {
      throw new BadRequestException('Розыгрыш уже завершён.');
    }
  }

  private async evaluateGiveawayEligibility(
    giveaway: PersistedGiveawayWithRelations,
    userId: string,
    options: GiveawayEligibilityCheckOptions = {},
  ): Promise<GiveawayEligibilityResult> {
    const additionalRequiredChannels = this.readRequiredChannelIds(
      giveaway.requiredChannelIds,
    ).filter((channelId) => channelId !== giveaway.sourceChatId);
    const mandatoryChannelIds = [giveaway.sourceChatId, ...additionalRequiredChannels];
    const lookupBotIdByChannelId =
      await this.resolveGiveawayMembershipLookupBotIds(mandatoryChannelIds);
    const missingChannelIds: string[] = [];

    if (this.membershipLookupService) {
      const lookupPolicy = this.resolveGiveawayLookupPolicy(options);

      for (const channelId of mandatoryChannelIds) {
        const botId = lookupBotIdByChannelId.get(channelId) ?? null;
        const membership = await this.membershipLookupService.getMembership(
          channelId,
          userId,
          lookupPolicy,
          {
            forceRefresh: options.forceFreshMembership,
            allowStaleOnError: options.allowStaleMembershipOnError,
            ...(botId ? { botId } : {}),
          },
        );
        if (membership === null) {
          return this.resolveGiveawayEligibilityLookupFailure(giveaway, userId, {
            ...options,
            failedChannelId: channelId,
          });
        }
        if (!membership) {
          missingChannelIds.push(channelId);
        }
      }

      return this.buildGiveawayEligibilityResult(giveaway, missingChannelIds, options);
    }

    try {
      const fallbackLookupSource: GiveawayActionSource =
        options.lookupPolicy === 'giveaway_draw_background' ? 'runner' : 'miniapp';
      const sourceBotId = lookupBotIdByChannelId.get(giveaway.sourceChatId) ?? null;
      const isMember = await this.maxClient.hasChatMember(giveaway.sourceChatId, userId, {
        ...buildManagedGiveawayMaxApiOptions(fallbackLookupSource, 'membership', sourceBotId),
      });
      if (!isMember) {
        missingChannelIds.push(giveaway.sourceChatId);
      }

      for (const channelId of additionalRequiredChannels) {
        const botId = lookupBotIdByChannelId.get(channelId) ?? null;
        const hasAdditionalSubscription = await this.maxClient.hasChatMember(channelId, userId, {
          ...buildManagedGiveawayMaxApiOptions(fallbackLookupSource, 'membership', botId),
        });
        if (!hasAdditionalSubscription) {
          missingChannelIds.push(channelId);
        }
      }

      return this.buildGiveawayEligibilityResult(giveaway, missingChannelIds, options);
    } catch (error: unknown) {
      return this.resolveGiveawayEligibilityLookupFailure(giveaway, userId, options, error);
    }
  }

  private resolveGiveawayLookupPolicy(
    options: GiveawayEligibilityCheckOptions,
  ): MaxMembershipLookupPolicy {
    if (options.lookupPolicy) {
      return options.lookupPolicy;
    }

    if (options.strictChannelCheck) {
      return 'giveaway_strict';
    }

    if (options.forceFreshMembership) {
      return 'giveaway_draw_interactive';
    }

    return 'giveaway_interactive';
  }

  private buildGiveawayEligibilityResult(
    giveaway: PersistedGiveawayWithRelations,
    missingChannelIds: string[],
    options: GiveawayEligibilityCheckOptions = {},
  ): GiveawayEligibilityResult {
    const entityType = this.fromPrismaEntityType(giveaway.entityType);
    if (missingChannelIds.length === 0) {
      return {
        state: GiveawayEligibilityState.VERIFIED,
        reason: null,
        missingChannelIds: [],
      };
    }

    if (missingChannelIds.includes(giveaway.sourceChatId)) {
      if (entityType === 'chat' || options.strictChannelCheck) {
        return {
          state: GiveawayEligibilityState.REJECTED,
          reason: 'Участник не найден в исходном чате/канале.',
          missingChannelIds,
        };
      }

      return {
        state: GiveawayEligibilityState.REJECTED,
        reason:
          missingChannelIds.length > 1
            ? 'Подписка на источник и обязательные чаты/каналы не подтверждена.'
            : 'Подписка на источник не подтверждена.',
        missingChannelIds,
      };
    }

    return {
      state: GiveawayEligibilityState.REJECTED,
      reason:
        missingChannelIds.length > 1
          ? 'Подписка на обязательные чаты/каналы не подтверждена.'
          : 'Подписка на обязательный чат/канал не подтверждена.',
      missingChannelIds,
    };
  }

  private resolveGiveawayEligibilityLookupFailure(
    giveaway: PersistedGiveawayWithRelations,
    userId: string,
    options: GiveawayEligibilityCheckOptions = {},
    error?: unknown,
  ): GiveawayEligibilityResult {
    const entityType = this.fromPrismaEntityType(giveaway.entityType);
    if (entityType === 'chat' || options.strictChannelCheck) {
      this.logger.warn(
        {
          giveawayId: giveaway.id,
          sourceChatId: giveaway.sourceChatId,
          userId,
          failedChannelId: options.failedChannelId ?? giveaway.sourceChatId,
          lookupPolicy: options.lookupPolicy ?? null,
          lookupIssueKind:
            options.failedChannelId && options.lookupPolicy && this.membershipLookupService
              ? (this.membershipLookupService.getLookupIssue(
                  options.failedChannelId,
                  options.lookupPolicy,
                )?.kind ?? null)
              : null,
          err:
            error instanceof Error
              ? error.message
              : error
                ? String(error)
                : 'membership lookup unavailable',
        },
        'Failed to verify giveaway participant strictly',
      );
      const lookupIssue =
        options.failedChannelId && options.lookupPolicy && this.membershipLookupService
          ? this.membershipLookupService.getLookupIssue(
              options.failedChannelId,
              options.lookupPolicy,
            )
          : null;
      if (options.lookupPolicy !== 'giveaway_draw_background') {
        throw new BadRequestException(GIVEAWAY_RUNNER_LOOKUP_RETRY_MESSAGE);
      }
      throw new ManagedGiveawayMembershipLookupUnavailableError(
        lookupIssue?.kind ?? 'transient',
        options.failedChannelId ?? giveaway.sourceChatId,
        lookupIssue?.retryAfterMs ?? null,
      );
    }

    return {
      state: GiveawayEligibilityState.PENDING,
      reason: 'MAX пока не подтвердил участие. Проверим ещё раз при подведении итогов.',
      missingChannelIds: [],
    };
  }

  private readRequiredChannelIds(value: Prisma.JsonValue): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    const normalized = value
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0);

    return Array.from(new Set(normalized));
  }

  private readMissingChannelIds(value: Prisma.JsonValue | null | undefined): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return Array.from(
      new Set(
        value
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .filter((item) => item.length > 0),
      ),
    );
  }

  private areSameStringSets(left: string[], right: string[]): boolean {
    if (left.length !== right.length) {
      return false;
    }

    const sortedLeft = [...left].sort();
    const sortedRight = [...right].sort();
    return sortedLeft.every((value, index) => value === sortedRight[index]);
  }

  private resolveGiveawayEntryAuditAction(
    existing: PersistedManagedGiveawayEntry | null,
    saved: PersistedManagedGiveawayEntry,
  ): GiveawayEntryAuditAction | null {
    if (!existing) {
      return 'ENTER_GIVEAWAY';
    }

    const existingMissingChannelIds = this.readMissingChannelIds(existing.missingChannelIds);
    const savedMissingChannelIds = this.readMissingChannelIds(saved.missingChannelIds);

    if (
      existing.eligibilityState === saved.eligibilityState &&
      (existing.eligibilityReason ?? null) === (saved.eligibilityReason ?? null) &&
      this.areSameStringSets(existingMissingChannelIds, savedMissingChannelIds)
    ) {
      return null;
    }

    return 'RECHECK_GIVEAWAY_ENTRY';
  }

  private buildGiveawayMandatoryChannelIds(row: PersistedGiveawayWithRelations): string[] {
    return Array.from(
      new Set([row.sourceChatId, ...this.readRequiredChannelIds(row.requiredChannelIds)]),
    );
  }

  private async evaluateGiveawayEligibilityForDraw(
    giveaway: PersistedGiveawayWithRelations,
    entries: PersistedManagedGiveawayEntry[],
    source: GiveawayActionSource,
  ): Promise<Map<string, GiveawayEligibilityResult>> {
    if (!this.membershipLookupService) {
      const results: Array<[string, GiveawayEligibilityResult]> = [];
      for (const entry of entries) {
        results.push([
          entry.userId,
          await this.evaluateGiveawayEligibility(giveaway, entry.userId, {
            strictChannelCheck: true,
            forceFreshMembership: true,
            lookupPolicy:
              source === 'runner' ? 'giveaway_draw_background' : 'giveaway_draw_interactive',
            allowStaleMembershipOnError: false,
          }),
        ]);
      }
      return new Map<string, GiveawayEligibilityResult>(results);
    }

    const userIds = Array.from(new Set(entries.map((entry) => entry.userId)));
    const mandatoryChannelIds = this.buildGiveawayMandatoryChannelIds(giveaway);
    const lookupPolicy: MaxMembershipLookupPolicy =
      source === 'runner' ? 'giveaway_draw_background' : 'giveaway_draw_interactive';
    const membershipByChannelId = new Map<string, Map<string, boolean | null>>();
    const allowStaleOnError = false;
    const lookupBotIdByChannelId =
      await this.resolveGiveawayMembershipLookupBotIds(mandatoryChannelIds);

    for (const channelId of mandatoryChannelIds) {
      const botId = lookupBotIdByChannelId.get(channelId) ?? null;
      membershipByChannelId.set(
        channelId,
        await this.membershipLookupService.getMemberships(channelId, userIds, lookupPolicy, {
          forceRefresh: true,
          allowStaleOnError,
          ...(botId ? { botId } : {}),
        }),
      );
    }

    const results = new Map<string, GiveawayEligibilityResult>();
    for (const entry of entries) {
      const missingChannelIds: string[] = [];
      let lookupFailed = false;
      let failedChannelId: string | null = null;

      for (const channelId of mandatoryChannelIds) {
        const membership = membershipByChannelId.get(channelId)?.get(entry.userId) ?? null;
        if (membership === null) {
          lookupFailed = true;
          failedChannelId = channelId;
          break;
        }
        if (!membership) {
          missingChannelIds.push(channelId);
        }
      }

      if (lookupFailed) {
        results.set(
          entry.userId,
          this.resolveGiveawayEligibilityLookupFailure(giveaway, entry.userId, {
            strictChannelCheck: true,
            forceFreshMembership: true,
            lookupPolicy,
            allowStaleMembershipOnError: allowStaleOnError,
            failedChannelId: failedChannelId ?? giveaway.sourceChatId,
          }),
        );
        continue;
      }

      results.set(entry.userId, this.buildGiveawayEligibilityResult(giveaway, missingChannelIds));
    }

    return results;
  }

  private async activateScheduledGiveawayIfDue(
    giveaway: PersistedGiveawayWithRelations,
  ): Promise<void> {
    if (
      giveaway.status !== ManagedGiveawayStatus.SCHEDULED ||
      !giveaway.startsAt ||
      giveaway.startsAt.getTime() > Date.now()
    ) {
      return;
    }

    const activated = await this.prisma.managedGiveaway.updateMany({
      where: {
        id: giveaway.id,
        status: ManagedGiveawayStatus.SCHEDULED,
        lockedAt: null,
        endsAt: { gt: new Date() },
      },
      data: {
        status: ManagedGiveawayStatus.ACTIVE,
      },
    });
    if (activated.count !== 1) return;
    const updated = await this.findGiveawayById(giveaway.id);

    await this.editGiveawayPublicationIfNeeded(updated, ManagedGiveawayStatus.ACTIVE, 'runner');
  }

  private async processDueManagedGiveaway(
    giveawayId: string,
    reason: 'startup' | 'scheduled',
    staleLockBefore: Date,
  ): Promise<void> {
    try {
      const giveaway = await this.findGiveawayById(giveawayId);
      if (
        giveaway.status === ManagedGiveawayStatus.DRAWING ||
        giveaway.endsAt.getTime() <= Date.now()
      ) {
        await this.drawGiveaway(giveaway.id, 'runner');
        await this.clearManagedGiveawayRunnerRetryState(giveaway.id);
        return;
      }

      if (
        giveaway.status === ManagedGiveawayStatus.SCHEDULED &&
        giveaway.startsAt &&
        giveaway.startsAt.getTime() <= Date.now()
      ) {
        const claim = await this.prisma.managedGiveaway.updateMany({
          where: {
            id: giveaway.id,
            status: ManagedGiveawayStatus.SCHEDULED,
            OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
          },
          data: {
            status: ManagedGiveawayStatus.ACTIVE,
            lockedAt: null,
            sendLockKey: null,
          },
        });
        if (claim.count === 0) {
          return;
        }
        const updated = await this.findGiveawayById(giveaway.id);
        await this.editGiveawayPublicationIfNeeded(updated, ManagedGiveawayStatus.ACTIVE, 'runner');
        await this.clearManagedGiveawayRunnerRetryState(giveaway.id);
        return;
      }
    } catch (error: unknown) {
      if (error instanceof ManagedGiveawayMembershipLookupUnavailableError) {
        if (error.kind === 'terminal') {
          const deferMs = await this.activateManagedGiveawayRunnerTerminalDefer(
            giveawayId,
            error.retryAfterMs,
          );
          this.logger.warn(
            {
              giveawayId,
              reason,
              chatId: error.chatId,
              deferMs,
              err: error.message,
            },
            'Deferred managed giveaway runner after terminal membership lookup failure',
          );
        } else {
          const { backoffMs, deferMs, failureCount } =
            await this.activateManagedGiveawayRunnerRetryBackoff(giveawayId);
          if (deferMs > 0) {
            this.logger.warn(
              {
                giveawayId,
                reason,
                failureCount,
                deferMs,
                chatId: error.chatId,
                err: error.message,
              },
              'Deferred managed giveaway runner after repeated membership lookup failures',
            );
          } else {
            this.logger.warn(
              {
                giveawayId,
                reason,
                failureCount,
                backoffMs,
                chatId: error.chatId,
                err: error.message,
              },
              'Deferred managed giveaway retry after membership lookup failure',
            );
          }
        }
      } else if (this.isManagedGiveawayRunnerRetryableError(error)) {
        const { backoffMs, deferMs, failureCount } =
          await this.activateManagedGiveawayRunnerRetryBackoff(giveawayId);
        if (deferMs > 0) {
          this.logger.warn(
            {
              giveawayId,
              reason,
              failureCount,
              deferMs,
              err: error instanceof Error ? error.message : String(error),
            },
            'Deferred managed giveaway runner after repeated membership lookup failures',
          );
        } else {
          this.logger.warn(
            {
              giveawayId,
              reason,
              failureCount,
              backoffMs,
              err: error instanceof Error ? error.message : String(error),
            },
            'Deferred managed giveaway retry after membership lookup failure',
          );
        }
      } else {
        this.logger.warn(
          {
            giveawayId,
            reason,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to process managed giveaway',
        );
      }
    }
  }

  private isManagedGiveawayRunnerRetryableError(error: unknown): boolean {
    if (!(error instanceof BadRequestException)) {
      return false;
    }

    const response = error.getResponse();
    if (typeof response === 'string') {
      return response.includes(GIVEAWAY_RUNNER_LOOKUP_RETRY_MESSAGE);
    }
    if (!response || typeof response !== 'object') {
      return false;
    }

    const message = (response as { message?: unknown }).message;
    if (typeof message === 'string') {
      return message.includes(GIVEAWAY_RUNNER_LOOKUP_RETRY_MESSAGE);
    }
    if (Array.isArray(message)) {
      return message.some(
        (item) => typeof item === 'string' && item.includes(GIVEAWAY_RUNNER_LOOKUP_RETRY_MESSAGE),
      );
    }

    return false;
  }

  private async getManagedGiveawayRunnerDeferRemainingMs(giveawayId: string): Promise<number> {
    const memoryUntilMs = this.giveawayRunnerDeferredUntilMs.get(giveawayId) ?? 0;
    const memoryRemainingMs = Math.max(0, memoryUntilMs - Date.now());
    if (memoryRemainingMs === 0 && memoryUntilMs > 0) {
      this.giveawayRunnerDeferredUntilMs.delete(giveawayId);
    }

    try {
      const persistedRemainingMs =
        (await this.chatContextCache.getManagedGiveawayRunnerDeferRemainingMs?.(giveawayId)) ?? 0;
      return Math.max(memoryRemainingMs, persistedRemainingMs);
    } catch {
      return memoryRemainingMs;
    }
  }

  private async getManagedGiveawayRunnerBackoffRemainingMs(giveawayId: string): Promise<number> {
    const memoryUntilMs = this.giveawayRunnerBackoffUntilMs.get(giveawayId) ?? 0;
    const memoryRemainingMs = Math.max(0, memoryUntilMs - Date.now());
    if (memoryRemainingMs === 0 && memoryUntilMs > 0) {
      this.giveawayRunnerBackoffUntilMs.delete(giveawayId);
    }

    try {
      const persistedRemainingMs =
        (await this.chatContextCache.getManagedGiveawayRunnerBackoffRemainingMs?.(giveawayId)) ?? 0;
      return Math.max(memoryRemainingMs, persistedRemainingMs);
    } catch {
      return memoryRemainingMs;
    }
  }

  private async activateManagedGiveawayRunnerRetryBackoff(
    giveawayId: string,
  ): Promise<{ failureCount: number; backoffMs: number; deferMs: number }> {
    const failureCount = await this.incrementManagedGiveawayRunnerFailureCount(giveawayId);
    if (failureCount >= GIVEAWAY_RUNNER_LOOKUP_DEFER_AFTER_FAILURE_COUNT) {
      const deferMs = await this.activateManagedGiveawayRunnerRetryDefer(giveawayId);
      await this.clearManagedGiveawayRunnerShortRetryState(giveawayId);
      return { failureCount, backoffMs: 0, deferMs };
    }

    const backoffMs = Math.min(
      GIVEAWAY_RUNNER_LOOKUP_BACKOFF_MAX_MS,
      GIVEAWAY_RUNNER_LOOKUP_BACKOFF_BASE_MS * 2 ** Math.max(0, failureCount - 1),
    );
    this.giveawayRunnerBackoffUntilMs.set(giveawayId, Date.now() + backoffMs);

    try {
      await this.chatContextCache.activateManagedGiveawayRunnerBackoff?.(
        giveawayId,
        Math.max(1, Math.ceil(backoffMs / 1000)),
      );
    } catch {
      return { failureCount, backoffMs, deferMs: 0 };
    }

    return { failureCount, backoffMs, deferMs: 0 };
  }

  private async activateManagedGiveawayRunnerRetryDefer(giveawayId: string): Promise<number> {
    this.giveawayRunnerDeferredUntilMs.set(
      giveawayId,
      Date.now() + GIVEAWAY_RUNNER_LOOKUP_DEFER_MS,
    );

    try {
      await this.chatContextCache.activateManagedGiveawayRunnerDefer?.(
        giveawayId,
        Math.max(1, Math.ceil(GIVEAWAY_RUNNER_LOOKUP_DEFER_MS / 1000)),
      );
    } catch {
      return GIVEAWAY_RUNNER_LOOKUP_DEFER_MS;
    }

    return GIVEAWAY_RUNNER_LOOKUP_DEFER_MS;
  }

  private async activateManagedGiveawayRunnerTerminalDefer(
    giveawayId: string,
    retryAfterMs: number | null,
  ): Promise<number> {
    const deferMs = Math.max(
      GIVEAWAY_RUNNER_LOOKUP_TERMINAL_DEFER_MS,
      typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs > 0
        ? Math.ceil(retryAfterMs)
        : 0,
    );
    this.giveawayRunnerDeferredUntilMs.set(giveawayId, Date.now() + deferMs);

    try {
      await this.chatContextCache.activateManagedGiveawayRunnerDefer?.(
        giveawayId,
        Math.max(1, Math.ceil(deferMs / 1000)),
      );
    } catch {
      await this.clearManagedGiveawayRunnerShortRetryState(giveawayId);
      return deferMs;
    }

    await this.clearManagedGiveawayRunnerShortRetryState(giveawayId);
    return deferMs;
  }

  private async incrementManagedGiveawayRunnerFailureCount(giveawayId: string): Promise<number> {
    const now = Date.now();
    const memoryEntry = this.giveawayRunnerFailureCounts.get(giveawayId);
    const memoryCount = memoryEntry && memoryEntry.expiresAtMs > now ? memoryEntry.count + 1 : 1;
    this.giveawayRunnerFailureCounts.set(giveawayId, {
      count: memoryCount,
      expiresAtMs: now + GIVEAWAY_RUNNER_LOOKUP_FAILURE_COUNT_TTL_SEC * 1000,
    });

    try {
      const persistedCount =
        (await this.chatContextCache.incrementManagedGiveawayRunnerFailureCount?.(
          giveawayId,
          GIVEAWAY_RUNNER_LOOKUP_FAILURE_COUNT_TTL_SEC,
        )) ?? memoryCount;
      return Math.max(memoryCount, persistedCount);
    } catch {
      return memoryCount;
    }
  }

  private async clearManagedGiveawayRunnerRetryState(giveawayId: string): Promise<void> {
    this.giveawayRunnerFailureCounts.delete(giveawayId);
    this.giveawayRunnerBackoffUntilMs.delete(giveawayId);
    this.giveawayRunnerDeferredUntilMs.delete(giveawayId);

    try {
      await this.chatContextCache.clearManagedGiveawayRunnerFailureState?.(giveawayId);
    } catch {
      return;
    }
  }

  private async clearManagedGiveawayRunnerShortRetryState(giveawayId: string): Promise<void> {
    this.giveawayRunnerFailureCounts.delete(giveawayId);
    this.giveawayRunnerBackoffUntilMs.delete(giveawayId);

    try {
      await this.chatContextCache.clearManagedGiveawayRunnerRetryCounters?.(giveawayId);
    } catch {
      return;
    }
  }

  private async expireDueGiveawayClaims(now: Date): Promise<void> {
    const dueWinners = await this.prisma.managedGiveawayWinner.findMany({
      where: {
        status: ManagedGiveawayWinnerStatus.SELECTED,
        claimDeadlineAt: {
          lte: now,
        },
      },
      select: {
        id: true,
        giveawayId: true,
      },
      take: 100,
    });

    if (dueWinners.length === 0) {
      return;
    }

    const winnerIds = dueWinners.map((winner) => winner.id);
    await this.prisma.managedGiveawayWinner.updateMany({
      where: {
        id: { in: winnerIds },
        status: ManagedGiveawayWinnerStatus.SELECTED,
      },
      data: {
        status: ManagedGiveawayWinnerStatus.EXPIRED,
        expiredAt: now,
      },
    });

    const giveawayIds = Array.from(new Set(dueWinners.map((winner) => winner.giveawayId)));
    const giveawaySourceRows = await this.prisma.managedGiveaway.findMany({
      where: { id: { in: giveawayIds } },
      select: { id: true, sourceChatId: true },
    });
    const sourceChatIdByGiveawayId = new Map(
      giveawaySourceRows.map((row) => [row.id, this.normalizeNonEmptyString(row.sourceChatId)]),
    );
    const accessBlockedSourceChatIds = await this.findAccessBlockedGiveawaySourceChatIds(
      giveawaySourceRows.map((row) => row.sourceChatId),
    );

    for (const giveawayId of giveawayIds) {
      const sourceChatId = sourceChatIdByGiveawayId.get(giveawayId) ?? null;
      if (sourceChatId && accessBlockedSourceChatIds.has(sourceChatId)) {
        continue;
      }
      try {
        const giveaway = await this.findGiveawayById(giveawayId);
        await this.editGiveawayPublicationIfNeeded(
          giveaway,
          ManagedGiveawayStatus.COMPLETED,
          'runner',
        );
        await this.republishGiveawayResults(giveaway, 'runner');
      } catch (error: unknown) {
        this.logger.warn(
          {
            giveawayId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to refresh giveaway after winner claim expiry',
        );
      }
    }
  }

  private async claimGiveawayForDraw(
    giveaway: PersistedGiveawayWithRelations,
    drawSeed: string,
    now: Date,
  ): Promise<GiveawayDrawClaimResult> {
    if (giveaway.status === ManagedGiveawayStatus.COMPLETED) {
      return { status: 'completed', giveaway };
    }

    const staleLockBefore = new Date(now.getTime() - GIVEAWAY_LOCK_STALE_MS);
    const claim = await this.prisma.managedGiveaway.updateMany({
      where: {
        id: giveaway.id,
        status: {
          in: [ManagedGiveawayStatus.ACTIVE, ManagedGiveawayStatus.SCHEDULED],
        },
        OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
      },
      data: {
        status: ManagedGiveawayStatus.DRAWING,
        drawSeed,
        drawnAt: now,
        lockedAt: now,
        sendLockKey: null,
      },
    });

    if (claim.count > 0) {
      return {
        status: 'claimed',
        giveaway: await this.findGiveawayById(giveaway.id),
        drawSeed,
      };
    }

    const current = await this.findGiveawayById(giveaway.id);
    if (current.status === ManagedGiveawayStatus.COMPLETED) {
      return { status: 'completed', giveaway: current };
    }

    if (
      current.status === ManagedGiveawayStatus.DRAWING &&
      (!current.lockedAt || current.lockedAt.getTime() < staleLockBefore.getTime())
    ) {
      const resumedSeed = current.drawSeed?.trim() || drawSeed;
      const resumed = await this.prisma.managedGiveaway.updateMany({
        where: {
          id: current.id,
          status: ManagedGiveawayStatus.DRAWING,
          OR: [{ lockedAt: null }, { lockedAt: { lt: staleLockBefore } }],
        },
        data: {
          drawSeed: resumedSeed,
          drawnAt: current.drawnAt ?? now,
          lockedAt: now,
          sendLockKey: null,
        },
      });

      if (resumed.count > 0) {
        return {
          status: 'claimed',
          giveaway: await this.findGiveawayById(current.id),
          drawSeed: resumedSeed,
        };
      }
    }

    if (current.status === ManagedGiveawayStatus.DRAWING) {
      throw new BadRequestException('Итоги уже подводятся.');
    }

    throw new BadRequestException('Завершить можно только активный или запланированный розыгрыш.');
  }

  private async drawGiveaway(
    giveawayId: string,
    source: GiveawayActionSource,
    actorUserId?: string,
  ): Promise<PersistedGiveawayWithRelations> {
    const now = new Date();
    const initial = await this.findGiveawayById(giveawayId);
    const initialDrawSeed = initial.drawSeed?.trim() || randomBytes(32).toString('hex');
    const drawClaim = await this.claimGiveawayForDraw(initial, initialDrawSeed, now);
    if (drawClaim.status === 'completed') {
      return drawClaim.giveaway;
    }

    const giveaway = drawClaim.giveaway;
    const drawSeed = drawClaim.drawSeed;
    let winnersToCreate: Array<{
      winnerId: ReturnType<typeof randomUUID>;
      prize: PersistedManagedGiveawayPrize;
      rankedEntry: { entry: PersistedManagedGiveawayEntry; drawRank: string };
      rank: number;
    }> = [];
    let completed: PersistedGiveawayWithRelations;

    try {
      const entriesToRecheck = giveaway.entries;
      const eligibilityByUserId = await this.evaluateGiveawayEligibilityForDraw(
        giveaway,
        entriesToRecheck,
        source,
      );

      const refreshedEntries: PersistedManagedGiveawayEntry[] = giveaway.entries.map((entry) => {
        const result = eligibilityByUserId.get(entry.userId);
        if (!result || result.state === GiveawayEligibilityState.PENDING) {
          throw new ManagedGiveawayMembershipLookupUnavailableError(
            'transient',
            giveaway.sourceChatId,
            null,
          );
        }

        return {
          ...entry,
          eligibilityState: result.state,
          eligibilityReason: result.reason,
          missingChannelIds: result.missingChannelIds,
          checkedAt: now,
        };
      });

      const rankedEntries = refreshedEntries
        .filter((entry) => entry.eligibilityState === GiveawayEligibilityState.VERIFIED)
        .map((entry) => ({
          entry,
          drawRank: entry.drawRank ?? buildManagedGiveawayDrawRank(drawSeed, entry.userId),
        }))
        .sort(
          (left, right) =>
            left.drawRank.localeCompare(right.drawRank) ||
            left.entry.userId.localeCompare(right.entry.userId),
        );

      winnersToCreate = giveaway.prizes
        .slice()
        .sort((left, right) => left.position - right.position)
        .map((prize, index) => ({
          winnerId: randomUUID(),
          prize,
          rankedEntry: rankedEntries[index] ?? null,
          rank: index + 1,
        }))
        .filter(
          (
            item,
          ): item is {
            winnerId: ReturnType<typeof randomUUID>;
            prize: PersistedManagedGiveawayPrize;
            rankedEntry: { entry: PersistedManagedGiveawayEntry; drawRank: string };
            rank: number;
          } => item.rankedEntry !== null,
        );

      completed = await this.prisma.$transaction(async (tx) => {
        // FLAG: Only the exact draw lease may persist eligibility and winners.
        const owned = await tx.managedGiveaway.updateMany({
          where: {
            id: giveaway.id,
            status: ManagedGiveawayStatus.DRAWING,
            lockedAt: giveaway.lockedAt,
            drawSeed,
          },
          data: { status: ManagedGiveawayStatus.DRAWING },
        });
        if (owned.count !== 1)
          throw new ConflictException('Итоги уже обрабатывает другой исполнитель.');
        const completedAt = new Date();
        const claimDeadlineAt = this.buildGiveawayClaimDeadlineAt(giveaway, completedAt);
        const ranksById = new Map(rankedEntries.map((row) => [row.entry.id, row.drawRank]));
        for (const entry of refreshedEntries) {
          await tx.managedGiveawayEntry.update({
            where: { id: entry.id },
            data: {
              eligibilityState: entry.eligibilityState,
              eligibilityReason: entry.eligibilityReason,
              missingChannelIds: this.readMissingChannelIds(entry.missingChannelIds),
              drawRank: ranksById.get(entry.id) ?? null,
              checkedAt: completedAt,
            },
          });
        }

        await tx.managedGiveawayWinner.deleteMany({
          where: {
            giveawayId: giveaway.id,
            status: ManagedGiveawayWinnerStatus.SELECTED,
          },
        });

        if (winnersToCreate.length > 0) {
          await tx.managedGiveawayWinner.createMany({
            data: winnersToCreate.map((row) => ({
              id: row.winnerId,
              giveawayId: giveaway.id,
              prizeId: row.prize.id,
              entryId: row.rankedEntry.entry.id,
              rank: row.rank,
              status: ManagedGiveawayWinnerStatus.SELECTED,
              selectedAt: completedAt,
              claimDeadlineAt,
            })),
          });
          await tx.managedGiveawayWinnerNotification.createMany({
            data: winnersToCreate.map((row) => ({
              winnerId: row.winnerId,
              nextAttemptAt: completedAt,
            })),
          });
        }

        await tx.managedGiveaway.update({
          where: { id: giveaway.id },
          data: {
            status: ManagedGiveawayStatus.COMPLETED,
            completedAt,
            lockedAt: null,
            sendLockKey: null,
          },
        });

        return tx.managedGiveaway.findUniqueOrThrow({
          where: { id: giveaway.id },
          include: MANAGED_GIVEAWAY_INCLUDE,
        });
      });
    } catch (error: unknown) {
      await this.prisma.managedGiveaway.updateMany({
        where: {
          id: giveaway.id,
          status: ManagedGiveawayStatus.DRAWING,
          lockedAt: giveaway.lockedAt,
          drawSeed,
        },
        data: {
          status:
            source === 'runner' || initial.status === ManagedGiveawayStatus.DRAWING
              ? ManagedGiveawayStatus.DRAWING
              : initial.status,
          lockedAt: null,
          sendLockKey: null,
        },
      });
      throw error;
    }

    await this.editGiveawayPublicationIfNeeded(completed, ManagedGiveawayStatus.COMPLETED, source);
    const resultsConfirmed = await this.republishGiveawayResults(completed, source);
    const refreshed = await this.findGiveawayById(completed.id);
    if (resultsConfirmed && winnersToCreate.length > 0) {
      await this.processWinnerNotificationOutbox(
        source,
        refreshed.id,
        GIVEAWAY_WINNER_NOTIFICATION_BATCH_SIZE,
        { winnerIds: winnersToCreate.map((row) => row.winnerId) },
      );
    }
    await this.writeAuditLog(
      giveaway.sourceChatId,
      actorUserId ?? giveaway.actorUserId,
      'DRAW_GIVEAWAY',
      {
        giveawayId: giveaway.id,
        entityType: this.fromPrismaEntityType(giveaway.entityType),
        winners: winnersToCreate.length,
        source,
      },
    );

    return refreshed;
  }

  private async upsertParticipantChatAccess(
    giveaway: PersistedGiveawayWithRelations,
  ): Promise<void> {
    const resolvedBotId = await this.resolveReadBotAssignment(giveaway.sourceChatId);

    await this.prisma.chat.upsert({
      where: { id: giveaway.sourceChatId },
      create: {
        id: giveaway.sourceChatId,
        title: await this.resolveSourceTitle(giveaway.sourceChatId),
        entityType: giveaway.entityType,
        ...(resolvedBotId ? { botId: resolvedBotId, primaryBotId: resolvedBotId } : {}),
      },
      update: {},
    });
  }

  private async resolveSourceTitle(chatId: string, remoteTitle?: string | null): Promise<string> {
    const local = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { title: true },
    });
    if (local?.title?.trim()) {
      return local.title.trim();
    }

    const title =
      remoteTitle === undefined ? (await this.resolveChatPresentation(chatId)).title : remoteTitle;
    return title?.trim() || `Chat ${chatId}`;
  }

  private async resolveChatPresentation(
    chatId: string,
  ): Promise<{ title: string | null; link: string | null; avatarUrl: string | null }> {
    const unavailable = { title: null, link: null, avatarUrl: null };
    try {
      const route = await this.resolveReadBotAssignmentRouteAware(chatId);
      // FLAG: An explicitly unavailable route must not fall back to the launch/default bot.
      if (route.routeResolved && !route.botId) {
        return unavailable;
      }
      const snapshot = await this.maxClient.getChatSnapshot(
        chatId,
        buildManagedGiveawayMaxApiOptions('miniapp', 'metadata', route.botId),
      );
      return {
        title: snapshot.title?.trim() || null,
        link: snapshot.link?.trim() || null,
        avatarUrl: snapshot.avatarUrl ?? null,
      };
    } catch (error: unknown) {
      this.logger.warn(
        { chatId, err: error instanceof Error ? error.message : String(error) },
        'Failed to resolve giveaway source presentation',
      );
      return unavailable;
    }
  }

  private resolveUserDisplayName(user: AuthUser): string {
    return user.displayName?.trim() || user.username?.trim() || `user:${user.userId}`;
  }

  private buildGiveawayLaunchUrl(giveawayId: string): string | null {
    const payload = Buffer.from(
      JSON.stringify({
        v: 1,
        k: 'giveaway',
        g: giveawayId,
      }),
      'utf8',
    ).toString('base64url');

    const startParam = `${GIVEAWAY_START_PARAM_PREFIX}${payload}`;
    if (!isValidMaxMiniappStartPayload(startParam)) {
      return null;
    }

    return (
      this.maxBotLinkService?.buildEntryMiniappStartUrlSync?.(startParam) ??
      (this.ownBotUserId
        ? `https://max.ru/${encodeURIComponent(this.ownBotUserId)}?startapp=${encodeURIComponent(
            startParam,
          )}`
        : null)
    );
  }

  private buildGiveawayDirectWebAppUrl(giveawayId: string): string | null {
    if (!this.appBaseUrl) {
      return null;
    }

    return `${this.appBaseUrl}/app/giveaways/${encodeURIComponent(giveawayId)}`;
  }

  private buildGiveawayClaimSignature(
    giveawayId: string,
    winnerId: string,
    botToken = this.getCurrentBotToken(),
  ): string {
    return createHmac('sha256', botToken)
      .update(`giveaway-claim:${giveawayId}:${winnerId}`)
      .digest('hex');
  }

  private isValidGiveawayClaimSignature(
    providedHex: string,
    giveawayId: string,
    winnerId: string,
  ): boolean {
    return this.maxBotTokenValidationSecrets.some((botToken) =>
      this.isSafeEqualHex(
        providedHex,
        this.buildGiveawayClaimSignature(giveawayId, winnerId, botToken),
      ),
    );
  }

  private isSafeEqualHex(providedHex: string, expectedHex: string): boolean {
    if (providedHex.length !== expectedHex.length) {
      return false;
    }

    return timingSafeEqual(Buffer.from(providedHex, 'hex'), Buffer.from(expectedHex, 'hex'));
  }

  private decodeImageBase64(value: string): Buffer {
    try {
      return Buffer.from(value, 'base64');
    } catch {
      throw new BadRequestException('Некорректное изображение розыгрыша.');
    }
  }

  private resolveImageFileName(fileName: string, mimeType: string): string {
    const trimmed = fileName.trim();
    if (trimmed) {
      return trimmed;
    }

    const extension = mimeType.split('/')[1]?.trim() || 'jpg';
    return `giveaway-image.${extension}`;
  }

  private async writeAuditLog(
    chatId: string,
    actorUserId: string,
    action: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        chatId,
        actorUserId,
        action,
        payload: payload as Prisma.InputJsonValue,
      },
    });
  }

  private toPrismaEntityType(entityType: ManagedEntityType): ChatEntityType {
    return entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT;
  }

  private fromPrismaEntityType(entityType: ChatEntityType): ManagedEntityType {
    return managedEntityTypeSchema.parse(
      entityType === ChatEntityType.CHANNEL ? 'channel' : 'chat',
    );
  }

  private normalizeAppBaseUrl(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim().replace(/\/+$/u, '');
    return /^https?:\/\//iu.test(normalized) ? normalized : null;
  }

  private normalizeBotContactId(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return /^\d+$/u.test(normalized) ? normalized : null;
  }

  private normalizeOwnBotUserId(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private normalizeNonEmptyString(value: string | null | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private async resolveReadBotRoute(chatId: string): Promise<MaxBotRoute | null> {
    if (!this.maxBotLinkService) {
      return null;
    }

    const routeResolver = this.maxBotLinkService as unknown as {
      resolveBotRoute?: (request: MaxBotRouteRequest) => Promise<MaxBotRoute>;
    };
    if (typeof routeResolver.resolveBotRoute !== 'function') {
      return null;
    }

    return routeResolver.resolveBotRoute({
      purpose: 'read',
      chatId,
    });
  }

  private async resolveSendBotRoute(chatId: string): Promise<MaxBotRoute | null> {
    if (!this.maxBotLinkService) {
      return null;
    }

    const routeResolver = this.maxBotLinkService as unknown as {
      resolveBotRoute?: (request: MaxBotRouteRequest) => Promise<MaxBotRoute>;
    };
    if (typeof routeResolver.resolveBotRoute !== 'function') {
      return null;
    }

    return routeResolver.resolveBotRoute({
      purpose: 'send_message',
      chatId,
      fallbackToPrimary: true,
    });
  }

  private async resolveReadBotAssignmentRouteAware(chatId: string): Promise<{
    botId: string | undefined;
    routeResolved: boolean;
  }> {
    const route = await this.resolveReadBotRoute(chatId);
    if (route) {
      return { botId: route.botId ?? undefined, routeResolved: true };
    }

    const legacyBotId =
      (await this.maxBotLinkService?.resolveBotIdForRead?.({
        chatId,
      })) ??
      (await this.maxBotLinkService?.resolveBotId({ chatId })) ??
      undefined;
    return { botId: legacyBotId, routeResolved: false };
  }

  private async resolveReadBotAssignment(chatId: string): Promise<string | undefined> {
    return (await this.resolveReadBotAssignmentRouteAware(chatId)).botId;
  }

  private async resolveSendBotAssignmentRouteAware(chatId: string): Promise<{
    botId: string | undefined;
    routeResolved: boolean;
  }> {
    const route = await this.resolveSendBotRoute(chatId);
    if (route) {
      return { botId: route.botId ?? undefined, routeResolved: true };
    }

    const legacyBotId =
      (await this.maxBotLinkService?.resolveBotIdForSend?.({
        chatId,
        fallbackToPrimary: true,
      })) ??
      (await this.maxBotLinkService?.resolveBotId({ chatId })) ??
      undefined;
    return { botId: legacyBotId, routeResolved: false };
  }

  private async resolveSendBotAssignment(chatId: string): Promise<string | undefined> {
    return (await this.resolveSendBotAssignmentRouteAware(chatId)).botId;
  }

  private async resolveGiveawayMembershipLookupBotIds(
    chatIds: readonly string[],
  ): Promise<Map<string, string>> {
    const normalizedChatIds = Array.from(
      new Set(
        chatIds
          .map((chatId) => this.normalizeNonEmptyString(chatId))
          .filter((chatId): chatId is string => Boolean(chatId)),
      ),
    );
    const botIdByChatId = new Map<string, string>();

    await Promise.all(
      normalizedChatIds.map(async (chatId) => {
        const botId = await this.resolveGiveawayMembershipLookupBotId(chatId);
        if (botId) {
          botIdByChatId.set(chatId, botId);
        }
      }),
    );

    return botIdByChatId;
  }

  private async resolveGiveawayMembershipLookupBotId(chatId: string): Promise<string | null> {
    try {
      const assigned = await this.resolveReadBotAssignmentRouteAware(chatId);
      if (assigned.botId?.trim()) {
        return assigned.botId.trim();
      }
      if (assigned.routeResolved) {
        return null;
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve giveaway membership lookup bot route',
      );
    }

    let persisted: { primaryBotId?: string | null; botId?: string | null } | null = null;
    try {
      persisted = await this.prisma.chat.findUnique({
        where: { id: chatId },
        select: { primaryBotId: true, botId: true },
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve giveaway membership lookup bot from persisted chat',
      );
      return null;
    }
    const primaryBotId =
      typeof persisted?.primaryBotId === 'string' ? persisted.primaryBotId.trim() : '';
    if (primaryBotId) {
      return primaryBotId;
    }

    const botId = typeof persisted?.botId === 'string' ? persisted.botId.trim() : '';
    return botId || null;
  }

  private async resolveGiveawayButtonBotAssignment(sourceChatId: string): Promise<{
    botId: string | null;
    routeResolved: boolean;
  }> {
    const normalizedSourceChatId = sourceChatId.trim();
    if (!normalizedSourceChatId || !this.maxBotLinkService) {
      return { botId: null, routeResolved: false };
    }

    try {
      const resolved = await this.resolveSendBotAssignmentRouteAware(normalizedSourceChatId);
      return {
        botId: resolved.botId ?? null,
        routeResolved: resolved.routeResolved,
      };
    } catch (error: unknown) {
      this.logger.warn(
        {
          sourceChatId: normalizedSourceChatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve giveaway button bot id',
      );
      return { botId: null, routeResolved: false };
    }
  }

  private async resolveGiveawayButtonBotId(sourceChatId: string): Promise<string | null> {
    return (await this.resolveGiveawayButtonBotAssignment(sourceChatId)).botId;
  }

  private async resolveGiveawayPublicationBotId(sourceChatId: string): Promise<string | undefined> {
    const normalizedSourceChatId = sourceChatId.trim();
    const buttonAssignment = await this.resolveGiveawayButtonBotAssignment(normalizedSourceChatId);
    if (buttonAssignment.botId) {
      return buttonAssignment.botId;
    }
    if (buttonAssignment.routeResolved) {
      return undefined;
    }

    const persisted = await this.prisma.chat.findUnique({
      where: { id: sourceChatId },
      select: { primaryBotId: true, botId: true },
    });
    const normalizedBotId =
      typeof persisted?.primaryBotId === 'string' && persisted.primaryBotId.trim()
        ? persisted.primaryBotId.trim()
        : typeof persisted?.botId === 'string' && persisted.botId.trim()
          ? persisted.botId.trim()
          : null;
    return normalizedBotId ?? undefined;
  }

  private async resolveGiveawayDeleteBotId(sourceChatId: string): Promise<string | null> {
    const normalizedSourceChatId = sourceChatId.trim();
    if (!normalizedSourceChatId) {
      return null;
    }

    const botId = await this.maxBotLinkService?.resolveBotIdForModerationAction({
      chatId: normalizedSourceChatId,
      action: 'delete_message',
      fallbackToPrimary: true,
    });
    return this.normalizeNonEmptyString(botId);
  }

  private async resolveGiveawayParticipantClaimBotId(sourceChatId: string): Promise<string | null> {
    try {
      return (await this.resolveGiveawayPublicationBotId(sourceChatId)) ?? null;
    } catch (error: unknown) {
      this.logger.warn(
        {
          sourceChatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve giveaway participant claim bot id',
      );
      return null;
    }
  }

  private resolveBotContactId(botId?: string | null): string | null {
    const contextAwareContactId = this.maxBotLinkService?.resolveContactIdSync(botId);
    if (contextAwareContactId) {
      return contextAwareContactId;
    }

    if (!botId && this.explicitBotContactId) {
      return this.explicitBotContactId;
    }

    const fallbackBotUserId =
      typeof botId === 'string' && botId.trim().length > 0 ? botId.trim() : this.ownBotUserId;
    if (!fallbackBotUserId) {
      return null;
    }

    const [candidate] = fallbackBotUserId.split('_');
    return /^\d+$/u.test(candidate) ? candidate : null;
  }

  private getCurrentBotToken(botId?: string | null): string {
    return this.maxBotLinkService?.getBotTokenSync(botId) ?? this.maxBotToken;
  }
}
