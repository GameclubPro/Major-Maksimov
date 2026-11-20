import {
  addVkParsingSourceRequestSchema,
  bulkUpdateVkParsingSourcesRequestSchema,
  updateVkParsingSourceRequestSchema,
  type VkParsingFeed,
  type VkParsingCapability,
  type VkParsingRefreshResult,
} from '@maxim/contracts';
import { InjectQueue } from '@nestjs/bullmq';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { VkApiClientService } from './vk-api-client.service';
import { VkApiRequestError } from './vk-parsing-errors';
import { isVkManualReviewMode, VK_BOT_REVIEW_MODE } from './vk-bot-review-protocol';
import { resolveNextAllowedVkAutoPublishAt } from './vk-autopublish-timing';
import { VkParsingFeedService } from './vk-parsing-feed.service';
import {
  type VkParsingOwnerScope,
  VkParsingOwnershipService,
} from './vk-parsing-ownership.service';
import {
  VK_PARSING_SYNC_QUEUE,
  VK_PARSING_SYNC_RETRY_POLICY,
  type VkParsingSyncJob,
  type VkParsingSyncReason,
} from './vk-parsing.queue';

type VkParsingSourceRow = Prisma.VkParsingSourceGetPayload<Record<string, never>>;

type VkWallGetResponse = {
  count?: number;
  items?: unknown[];
  groups?: unknown[];
};

type VkSyncJobRecoveryOutcome = 'missing' | 'healthy' | 'recovered' | 'conflict' | 'unavailable';

type NormalizedVkSourceInput = {
  domain: string;
  url: string;
};

type NormalizedVkSourceInfo = {
  ownerId: number;
  wallOwnerId: number;
  screenName: string;
  title: string;
  url: string;
};

const VK_SOURCE_STATUS_ACTIVE = 'ACTIVE';
const VK_SOURCE_STATUS_DISABLED = 'DISABLED';
const VK_SOURCE_SYNC_STATUS_IDLE = 'IDLE';
const VK_SOURCE_SYNC_STATUS_QUEUED = 'QUEUED';
const VK_SOURCE_SYNC_STATUS_SYNCING = 'SYNCING';
const VK_SOURCE_SYNC_STATUS_ERROR = 'ERROR';
const VK_SOURCE_PUBLISH_MODE_QUEUE = 'QUEUE';
const VK_SOURCE_PRIORITY_NORMAL = 'NORMAL';
const VK_SYNC_JOB_NAME = 'sync-vk-source';
const VK_PARSING_AVAILABLE_CAPABILITY: VkParsingCapability = {
  enabled: true,
  canUse: true,
  reasonCode: null,
  reason: null,
};

@Injectable()
export class VkSourceService {
  private readonly logger = new Logger(VkSourceService.name);
  private readonly queueBatchSize: number;
  private readonly syncLeaseTtlMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly feedService: VkParsingFeedService,
    private readonly vkApiClient: VkApiClientService,
    @InjectQueue(VK_PARSING_SYNC_QUEUE)
    private readonly syncQueue: Queue<VkParsingSyncJob>,
    private readonly configService: ConfigService,
    private readonly ownership: VkParsingOwnershipService,
  ) {
    this.queueBatchSize = configService.get<number>('VK_PARSING_QUEUE_BATCH_SIZE') ?? 100;
    this.syncLeaseTtlMs = configService.get<number>('VK_PARSING_LEASE_TTL_MS') ?? 120_000;
  }

  async addSource(
    chatId: string,
    user: Pick<AuthUser, 'userId'>,
    body: unknown,
  ): Promise<VkParsingRefreshResult> {
    const parsed = addVkParsingSourceRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const normalized = this.normalizeSourceInput(parsed.data.url);
    const wall = await this.fetchWall({ domain: normalized.domain, count: 1 });
    const sourceInfo = this.resolveSourceInfo(normalized, wall);
    const ownerScope = this.ownership.getPublisherScope();
    const uniqueSourceWhere = {
      chatId_ownerProfile_ownerBotId_wallOwnerId: {
        chatId,
        ...ownerScope,
        wallOwnerId: sourceInfo.wallOwnerId,
      },
    } as const;
    const result = await this.prisma.$transaction(async (tx) => {
      const lockedChats = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT chat."id"
        FROM "chats" AS chat
        WHERE chat."id" = ${chatId}
        FOR UPDATE OF chat
      `;
      if (lockedChats.length !== 1) {
        throw new NotFoundException('Чат или канал не найден.');
      }

      const existingSource = await tx.vkParsingSource.findUnique({ where: uniqueSourceWhere });
      if (existingSource?.status === VK_SOURCE_STATUS_ACTIVE) {
        return { source: existingSource, shouldQueue: false };
      }

      const settings = await tx.vkParsingSettings.findUnique({
        where: {
          chatId_ownerProfile_ownerBotId: {
            chatId,
            ...ownerScope,
          },
        },
        select: {
          autoPublishEnabled: true,
        },
      });
      const now = new Date();
      const autoPublishEnabled = settings?.autoPublishEnabled === true;
      const sourceAutomation = autoPublishEnabled
        ? {
            autoPublishEnabled: true,
            autoPublishEnabledAt: now,
            autoPublishPausedAt: null,
            autoPublishPausedReason: null,
          }
        : {
            autoPublishEnabled: false,
            autoPublishEnabledAt: null,
            autoPublishPausedAt: now,
            autoPublishPausedReason: 'manual',
          };
      const source = await tx.vkParsingSource.upsert({
        where: uniqueSourceWhere,
        create: {
          chatId,
          ...ownerScope,
          ownerId: sourceInfo.ownerId,
          wallOwnerId: sourceInfo.wallOwnerId,
          screenName: sourceInfo.screenName,
          title: sourceInfo.title,
          url: sourceInfo.url,
          status: VK_SOURCE_STATUS_ACTIVE,
          importEnabled: true,
          ...sourceAutomation,
          syncStatus: VK_SOURCE_SYNC_STATUS_QUEUED,
          nextSyncAt: now,
          createdByUserId: user.userId,
        },
        update: {
          ownerId: sourceInfo.ownerId,
          screenName: sourceInfo.screenName,
          title: sourceInfo.title,
          url: sourceInfo.url,
          status: VK_SOURCE_STATUS_ACTIVE,
          importEnabled: true,
          ...sourceAutomation,
          syncStatus: VK_SOURCE_SYNC_STATUS_QUEUED,
          nextSyncAt: now,
          syncLockedAt: null,
          syncLockedBy: null,
          syncLockDeadlineAt: null,
          syncHeartbeatAt: null,
          terminalFailureCount: 0,
          circuitOpenedAt: null,
          circuitReasonCode: null,
          circuitReason: null,
          circuitRetryAt: null,
          lastError: null,
          lastErrorCode: null,
        },
      });
      return { source, shouldQueue: true };
    });

    const queued = result.shouldQueue
      ? await this.enqueueSourceSync(result.source.id, 'source-added')
      : 0;
    const feed = await this.feedService.buildFeed(
      chatId,
      VK_PARSING_AVAILABLE_CAPABILITY,
      {},
      ownerScope,
    );
    return { ...feed, imported: 0, queued };
  }

  async updateSource(
    chatId: string,
    sourceId: string,
    user: Pick<AuthUser, 'userId'>,
    body: unknown,
  ): Promise<VkParsingFeed> {
    const parsed = updateVkParsingSourceRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const ownerScope = this.ownership.getPublisherScope();
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockChat(tx, chatId);
      const source = await tx.vkParsingSource.findFirst({
        where: { id: sourceId, chatId, status: VK_SOURCE_STATUS_ACTIVE, ...ownerScope },
      });
      if (!source) {
        throw new NotFoundException('VK-источник не найден.');
      }

      const { ifAutomatic, ...patch } = parsed.data;
      if (
        ifAutomatic &&
        (!source.importEnabled ||
          !source.autoPublishEnabled ||
          source.autoPublishPausedAt !== null ||
          source.autoPublishPausedReason === 'circuit_breaker' ||
          isVkManualReviewMode(source.publishMode))
      ) {
        throw new ConflictException('Группа больше не публикует автоматически.');
      }

      const now = new Date();
      const nextAutoPublishEnabled = parsed.data.autoPublishEnabled ?? source.autoPublishEnabled;
      const nextPublishMode = parsed.data.publishMode ?? source.publishMode;
      // FLAG: Leaving manual review starts a new auto baseline even with a legacy true flag.
      const activatesAutomaticDelivery =
        nextAutoPublishEnabled &&
        !isVkManualReviewMode(nextPublishMode) &&
        (!source.autoPublishEnabled || isVkManualReviewMode(source.publishMode));
      const autoPublishEnabledAt = activatesAutomaticDelivery
        ? now
        : typeof parsed.data.autoPublishEnabled === 'boolean'
          ? parsed.data.autoPublishEnabled
            ? source.autoPublishEnabled
              ? (source.autoPublishEnabledAt ?? now)
              : now
            : null
          : undefined;
      const importEnabled = parsed.data.importEnabled ?? source.importEnabled;
      const shouldQueueSync = parsed.data.importEnabled === true && !source.importEnabled;
      if (nextPublishMode === VK_BOT_REVIEW_MODE) {
        if (this.configService.get<boolean>('VK_BOT_REVIEW_ENABLED') === false) {
          throw new BadRequestException('Согласование в боте временно отключено.');
        }
        const settings = await tx.vkParsingSettings.findUnique({
          where: { chatId_ownerProfile_ownerBotId: { chatId, ...ownerScope } },
        });
        if (!settings?.botReviewRecipientUserId) {
          throw new BadRequestException('Сначала подключите личку для согласования.');
        }
        const channel = await tx.chat.findUnique({
          where: { id: chatId },
          select: { entityType: true },
        });
        if (channel?.entityType !== 'CHANNEL')
          throw new BadRequestException('Согласование доступно только для каналов.');
        if (parsed.data.autoPublishEnabled === true) {
          throw new BadRequestException('Согласование в боте несовместимо с автопубликацией.');
        }
      }
      const changesReviewMode =
        nextPublishMode !== source.publishMode &&
        (nextPublishMode === VK_BOT_REVIEW_MODE || source.publishMode === VK_BOT_REVIEW_MODE);
      if (changesReviewMode) {
        const inFlight = await tx.vkParsingPost.count({
          where: {
            sourceId: source.id,
            ...ownerScope,
            OR: [
              { publishLockedAt: { not: null } },
              { publishIdempotencyKey: { not: null }, publishAttemptCount: { gt: 0 } },
            ],
          },
        });
        if (inFlight) throw new BadRequestException('Дождитесь завершения текущей публикации.');
        await tx.vkParsingPost.updateMany({
          where: {
            sourceId: source.id,
            ...ownerScope,
            publishAttemptCount: 0,
            publishLockedAt: null,
          },
          data: {
            publishQueuedAt: null,
            publishScheduledAt: null,
            publishIdempotencyKey: null,
            publishReason: null,
            publishScheduleFingerprint: null,
          },
        });
        await tx.vkBotReview.updateMany({
          where: {
            post: { sourceId: source.id, ...ownerScope },
            status: { in: ['PENDING', 'APPROVED'] },
          },
          data: { status: 'CANCELLED', lastError: 'Режим источника изменён.', nextAttemptAt: now },
        });
      }
      const nextAutoPublishPausedAt =
        parsed.data.autoPublishEnabled === true || activatesAutomaticDelivery
          ? null
          : source.autoPublishPausedAt;
      if (
        importEnabled &&
        nextAutoPublishEnabled &&
        nextAutoPublishPausedAt === null &&
        !isVkManualReviewMode(nextPublishMode)
      ) {
        const settings = await tx.vkParsingSettings.findUnique({
          where: {
            chatId_ownerProfile_ownerBotId: {
              chatId,
              ...ownerScope,
            },
          },
        });
        if (settings?.autoPublishEnabled) {
          this.assertAutoPublishScheduleAvailable(now, settings, {
            quietHoursStart:
              parsed.data.quietHoursStart !== undefined
                ? parsed.data.quietHoursStart
                : source.quietHoursStart,
            quietHoursEnd:
              parsed.data.quietHoursEnd !== undefined
                ? parsed.data.quietHoursEnd
                : source.quietHoursEnd,
          });
        }
      }
      await tx.vkParsingSource.update({
        where: { id: source.id },
        data: {
          ...patch,
          ...(nextPublishMode === VK_BOT_REVIEW_MODE
            ? {
                autoPublishEnabled: false,
                autoPublishEnabledAt: null,
                botReviewEnabledAt:
                  source.publishMode === VK_BOT_REVIEW_MODE ? source.botReviewEnabledAt : now,
              }
            : changesReviewMode
              ? { botReviewEnabledAt: null }
              : {}),
          status: VK_SOURCE_STATUS_ACTIVE,
          importEnabled,
          ...(autoPublishEnabledAt !== undefined ? { autoPublishEnabledAt } : {}),
          ...(parsed.data.autoPublishEnabled === true || activatesAutomaticDelivery
            ? { autoPublishPausedAt: null, autoPublishPausedReason: null }
            : {}),
          ...(parsed.data.autoPublishEnabled === false
            ? { autoPublishPausedAt: now, autoPublishPausedReason: 'manual' }
            : {}),
          ...(importEnabled
            ? shouldQueueSync
              ? {
                  syncStatus: VK_SOURCE_SYNC_STATUS_QUEUED,
                  nextSyncAt: now,
                  syncLockedAt: null,
                  syncLockedBy: null,
                  syncLockDeadlineAt: null,
                  syncHeartbeatAt: null,
                }
              : {}
            : {
                syncStatus: VK_SOURCE_SYNC_STATUS_IDLE,
                nextSyncAt: null,
                syncLockedAt: null,
                syncLockedBy: null,
                syncLockDeadlineAt: null,
                syncHeartbeatAt: null,
              }),
        },
      });
      if (
        parsed.data.autoPublishEnabled === false ||
        parsed.data.importEnabled === false ||
        isVkManualReviewMode(parsed.data.publishMode ?? '')
      ) {
        await this.clearQueuedAutoPublishForSources(tx, chatId, [source.id], ownerScope);
      }
      await tx.auditLog.create({
        data: {
          chatId,
          actorUserId: user.userId,
          action: 'VK_PARSING_UPDATE_SOURCE',
          payload: this.toJsonInput({
            ...ownerScope,
            sourceId: source.id,
            before: this.pickAuditedSourceSettings(source),
            after: patch,
          }),
        },
      });
      return { sourceId: source.id, shouldQueueSync };
    });

    if (result.shouldQueueSync) {
      await this.enqueueSourceSync(result.sourceId, 'manual');
    }

    return this.feedService.buildFeed(chatId, VK_PARSING_AVAILABLE_CAPABILITY, {}, ownerScope);
  }

  async applyBulkPreset(
    chatId: string,
    user: Pick<AuthUser, 'userId'>,
    body: unknown,
  ): Promise<VkParsingFeed> {
    const parsed = bulkUpdateVkParsingSourcesRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const ownerScope = this.ownership.getPublisherScope();

    const sourceIds = [...new Set(parsed.data.sourceIds)];
    const preset = this.resolvePresetSettings(parsed.data.preset);
    const sources = await this.prisma.$transaction(async (tx) => {
      await this.lockChat(tx, chatId);
      const now = new Date();
      // FLAG: CLEAN filters and source activation must commit together before sync/dispatch.
      if (parsed.data.preset === 'CLEAN') {
        await tx.vkParsingSettings.upsert({
          where: { chatId_ownerProfile_ownerBotId: { chatId, ...ownerScope } },
          create: { chatId, ...ownerScope, stripLinksEnabled: true, skipAdsEnabled: true },
          update: { stripLinksEnabled: true, skipAdsEnabled: true },
        });
      }
      const sourceWhere = {
        chatId,
        ...ownerScope,
        id: { in: sourceIds },
        status: VK_SOURCE_STATUS_ACTIVE,
      } as const;
      if (
        await tx.vkParsingSource.count({
          where: { ...sourceWhere, publishMode: VK_BOT_REVIEW_MODE },
        })
      ) {
        throw new BadRequestException(
          'Сначала отключите согласование в боте у выбранных источников.',
        );
      }
      const syncUpdate = preset.importEnabled
        ? {
            status: VK_SOURCE_STATUS_ACTIVE,
            syncStatus: VK_SOURCE_SYNC_STATUS_QUEUED,
            nextSyncAt: now,
            syncLockedAt: null,
            syncLockedBy: null,
            syncLockDeadlineAt: null,
            syncHeartbeatAt: null,
          }
        : {
            syncStatus: VK_SOURCE_SYNC_STATUS_IDLE,
            nextSyncAt: null,
            syncLockedAt: null,
            syncLockedBy: null,
            syncLockDeadlineAt: null,
            syncHeartbeatAt: null,
          };
      if (preset.autoPublishEnabled) {
        await tx.vkParsingSource.updateMany({
          where: {
            ...sourceWhere,
            autoPublishEnabled: true,
            publishMode: { notIn: ['REVIEW', VK_BOT_REVIEW_MODE] },
          },
          data: { ...preset, ...syncUpdate },
        });
        await tx.vkParsingSource.updateMany({
          where: { ...sourceWhere, autoPublishEnabled: false },
          data: {
            ...preset,
            ...syncUpdate,
            autoPublishEnabledAt: now,
            autoPublishPausedAt: null,
            autoPublishPausedReason: null,
          },
        });
        await tx.vkParsingSource.updateMany({
          where: { ...sourceWhere, autoPublishEnabled: true, publishMode: 'REVIEW' },
          data: {
            ...preset,
            ...syncUpdate,
            autoPublishEnabledAt: now,
            autoPublishPausedAt: null,
            autoPublishPausedReason: null,
          },
        });
      } else {
        await tx.vkParsingSource.updateMany({
          where: sourceWhere,
          data: {
            ...preset,
            ...syncUpdate,
            autoPublishEnabledAt: null,
            autoPublishPausedAt: now,
            autoPublishPausedReason: 'preset',
          },
        });
      }
      const updatedSources = preset.importEnabled
        ? await tx.vkParsingSource.findMany({
            where: {
              chatId,
              id: { in: sourceIds },
              status: VK_SOURCE_STATUS_ACTIVE,
              ...ownerScope,
            },
          })
        : [];
      if (preset.autoPublishEnabled && updatedSources.length > 0) {
        const settings = await tx.vkParsingSettings.findUnique({
          where: {
            chatId_ownerProfile_ownerBotId: {
              chatId,
              ...ownerScope,
            },
          },
        });
        if (settings?.autoPublishEnabled) {
          for (const source of updatedSources) {
            this.assertAutoPublishScheduleAvailable(now, settings, source);
          }
        }
      }
      if (parsed.data.preset === 'REVIEW') {
        await this.clearQueuedAutoPublishForSources(tx, chatId, sourceIds, ownerScope);
      }
      await tx.auditLog.create({
        data: {
          chatId,
          actorUserId: user.userId,
          action: 'VK_PARSING_APPLY_PRESET',
          payload: this.toJsonInput({
            ...ownerScope,
            preset: parsed.data.preset,
            sourceIds,
            settings: preset,
          }),
        },
      });
      return updatedSources;
    });
    await this.enqueueSources(sources, 'manual');
    return this.feedService.buildFeed(chatId, VK_PARSING_AVAILABLE_CAPABILITY, {}, ownerScope);
  }

  async removeSource(chatId: string, sourceId: string): Promise<VkParsingFeed> {
    const ownerScope = this.ownership.getPublisherScope();
    await this.prisma.$transaction(async (tx) => {
      await this.lockChat(tx, chatId);
      const source = await tx.vkParsingSource.findFirst({
        where: { id: sourceId, chatId, ...ownerScope },
      });
      if (!source) {
        throw new NotFoundException('VK-источник не найден.');
      }

      await tx.vkParsingSource.update({
        where: { id: source.id },
        data: {
          status: VK_SOURCE_STATUS_DISABLED,
          importEnabled: false,
          autoPublishEnabled: false,
          autoPublishEnabledAt: null,
          autoPublishPausedAt: new Date(),
          autoPublishPausedReason: 'removed',
          syncStatus: VK_SOURCE_SYNC_STATUS_IDLE,
          nextSyncAt: null,
          syncLockedAt: null,
          syncLockedBy: null,
          syncLockDeadlineAt: null,
          syncHeartbeatAt: null,
          circuitRetryAt: null,
        },
      });
      await this.clearQueuedAutoPublishForSources(tx, chatId, [source.id], ownerScope);
    });
    return this.feedService.buildFeed(chatId, VK_PARSING_AVAILABLE_CAPABILITY, {}, ownerScope);
  }

  async refresh(chatId: string): Promise<VkParsingRefreshResult> {
    const ownerScope = this.ownership.getPublisherScope();
    const sources = await this.prisma.vkParsingSource.findMany({
      where: { chatId, status: VK_SOURCE_STATUS_ACTIVE, importEnabled: true, ...ownerScope },
      orderBy: [{ createdAt: 'asc' }],
    });

    const queued = await this.enqueueSources(sources, 'manual');

    const feed = await this.feedService.buildFeed(
      chatId,
      VK_PARSING_AVAILABLE_CAPABILITY,
      {},
      ownerScope,
    );
    return { ...feed, imported: 0, queued };
  }

  async refreshSource(chatId: string, sourceId: string): Promise<VkParsingRefreshResult> {
    const ownerScope = this.ownership.getPublisherScope();
    const source = await this.prisma.vkParsingSource.findFirst({
      where: { chatId, id: sourceId, status: VK_SOURCE_STATUS_ACTIVE, ...ownerScope },
    });
    if (!source) {
      throw new NotFoundException('VK-источник не найден.');
    }
    if (!source.importEnabled) {
      throw new BadRequestException('Источник поставлен на паузу.');
    }

    const queued = await this.enqueueSourceSync(source.id, 'manual');
    const feed = await this.feedService.buildFeed(
      chatId,
      VK_PARSING_AVAILABLE_CAPABILITY,
      {},
      ownerScope,
    );
    return { ...feed, imported: 0, queued };
  }

  async syncDueSources(reason: VkParsingSyncReason = 'scheduled'): Promise<number> {
    const now = new Date();
    const staleLockBefore = new Date(now.getTime() - this.syncLeaseTtlMs);
    const ownerScope = this.ownership.getPublisherScope();
    const sources = await this.prisma.vkParsingSource.findMany({
      where: {
        ...ownerScope,
        status: VK_SOURCE_STATUS_ACTIVE,
        importEnabled: true,
        syncStatus: { not: VK_SOURCE_SYNC_STATUS_ERROR },
        circuitOpenedAt: null,
        OR: [
          {
            syncStatus: { notIn: [VK_SOURCE_SYNC_STATUS_QUEUED, VK_SOURCE_SYNC_STATUS_SYNCING] },
            OR: [{ nextSyncAt: null }, { nextSyncAt: { lte: now } }],
          },
          {
            syncStatus: VK_SOURCE_SYNC_STATUS_QUEUED,
            updatedAt: { lt: staleLockBefore },
          },
          {
            syncStatus: VK_SOURCE_SYNC_STATUS_SYNCING,
            OR: [
              { syncLockDeadlineAt: { lt: now } },
              {
                syncLockDeadlineAt: null,
                syncLockedAt: { lt: staleLockBefore },
              },
            ],
          },
        ],
      },
      orderBy: [{ nextSyncAt: 'asc' }, { lastSyncAt: 'asc' }, { createdAt: 'asc' }],
      take: this.queueBatchSize,
    });

    return this.enqueueSources(sources, reason);
  }

  private async enqueueSources(
    sources: VkParsingSourceRow[],
    reason: VkParsingSyncReason,
  ): Promise<number> {
    let queued = 0;
    for (const source of sources) {
      queued += await this.enqueueSourceSync(source.id, reason);
    }

    return queued;
  }

  private async enqueueSourceSync(sourceId: string, reason: VkParsingSyncReason): Promise<number> {
    const now = new Date();
    const staleLockBefore = new Date(now.getTime() - this.syncLeaseTtlMs);
    const resetCircuitState = reason === 'manual' || reason === 'source-added';
    const ownerScope = this.ownership.getPublisherScope();
    const updated = await this.prisma.vkParsingSource.updateMany({
      where: {
        id: sourceId,
        ...ownerScope,
        status: VK_SOURCE_STATUS_ACTIVE,
        importEnabled: true,
        OR: [
          { syncStatus: { not: VK_SOURCE_SYNC_STATUS_SYNCING } },
          {
            syncStatus: VK_SOURCE_SYNC_STATUS_SYNCING,
            OR: [
              { syncLockDeadlineAt: { lt: now } },
              {
                syncLockDeadlineAt: null,
                syncLockedAt: { lt: staleLockBefore },
              },
            ],
          },
        ],
      },
      data: {
        syncStatus: VK_SOURCE_SYNC_STATUS_QUEUED,
        nextSyncAt: now,
        syncLockedAt: null,
        syncLockedBy: null,
        syncLockDeadlineAt: null,
        syncHeartbeatAt: null,
        ...(resetCircuitState
          ? {
              terminalFailureCount: 0,
              circuitOpenedAt: null,
              circuitReasonCode: null,
              circuitReason: null,
              circuitRetryAt: null,
            }
          : {}),
      },
    });
    if (updated.count === 0) {
      return 0;
    }

    const job = this.buildSyncJob(sourceId, reason, now, ownerScope.ownerBotId);
    const jobId = this.buildSyncJobId(sourceId);
    const recovered = await this.recoverExistingSyncJob(jobId, job);
    if (recovered !== 'missing') {
      return recovered === 'conflict' ? 0 : 1;
    }

    try {
      await this.syncQueue.add(VK_SYNC_JOB_NAME, job, {
        jobId,
        ...VK_PARSING_SYNC_RETRY_POLICY,
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          jobId,
          sourceId,
          reason,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to enqueue VK parsing sync job after marking its source queued',
      );
    }

    return 1;
  }

  private buildSyncJob(
    sourceId: string,
    reason: VkParsingSyncReason,
    createdAt: Date,
    ownerBotId: string,
  ): VkParsingSyncJob {
    return {
      sourceId,
      reason,
      ownerProfile: 'PUBLISHER',
      ownerBotId,
      retryPolicyName: 'vk-parsing-sync',
      createdAt: createdAt.toISOString(),
    };
  }

  private async recoverExistingSyncJob(
    jobId: string,
    job: VkParsingSyncJob,
  ): Promise<VkSyncJobRecoveryOutcome> {
    try {
      const existingJob = await this.syncQueue.getJob(jobId);
      if (!existingJob) {
        return 'missing';
      }

      const state = await existingJob.getState();
      if (state === 'unknown') {
        await existingJob.remove();
        this.logger.warn(
          { jobId, sourceId: job.sourceId },
          'Removed orphaned VK parsing sync job before recovery',
        );
        return 'missing';
      }
      const existingData =
        typeof existingJob.data === 'object' && existingJob.data !== null
          ? (existingJob.data as Partial<VkParsingSyncJob>)
          : null;
      const ownershipMatches =
        existingData?.sourceId === job.sourceId &&
        existingData.reason === job.reason &&
        existingData.ownerProfile === job.ownerProfile &&
        existingData.ownerBotId === job.ownerBotId;
      if (!ownershipMatches) {
        if (state === 'active') {
          this.logger.error(
            { jobId, sourceId: job.sourceId, state },
            'Quarantined active VK parsing sync job with mismatched ownership payload',
          );
          return 'conflict';
        }
        await existingJob.remove();
        this.logger.warn(
          { jobId, sourceId: job.sourceId, state },
          'Removed inactive VK parsing sync job with mismatched ownership payload',
        );
        return 'missing';
      }
      if (state === 'failed' || state === 'completed') {
        await existingJob.updateData(job);
        await existingJob.retry(state, {
          resetAttemptsMade: true,
          resetAttemptsStarted: true,
        });
        return 'recovered';
      }

      return 'healthy';
    } catch (error: unknown) {
      this.logger.warn(
        {
          jobId,
          sourceId: job.sourceId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to recover VK parsing sync job',
      );
      return 'unavailable';
    }
  }

  private buildSyncJobId(sourceId: string): string {
    return `vk-parsing-sync__${sourceId}`;
  }

  private assertAutoPublishScheduleAvailable(
    now: Date,
    settings: {
      schedulerTimezone: string;
      workHoursStart: string;
      workHoursEnd: string;
      quietHoursStart: string | null;
      quietHoursEnd: string | null;
    },
    source: { quietHoursStart: string | null; quietHoursEnd: string | null },
  ): void {
    if (!resolveNextAllowedVkAutoPublishAt(now, settings, source)) {
      throw new BadRequestException('Рабочее время полностью перекрыто паузами публикации.');
    }
  }

  private resolvePresetSettings(preset: string) {
    if (preset === 'NEWS') {
      return {
        importEnabled: true,
        autoPublishEnabled: true,
        publishIntervalMinutes: 20,
        dailyLimit: 12,
        minPublishIntervalMinutes: 15,
        publishMode: 'QUEUE',
        priority: 'HIGH',
      };
    }
    if (preset === 'SLOW') {
      return {
        importEnabled: true,
        autoPublishEnabled: true,
        publishIntervalMinutes: 180,
        dailyLimit: 3,
        minPublishIntervalMinutes: 60,
        publishMode: 'QUEUE',
        priority: VK_SOURCE_PRIORITY_NORMAL,
      };
    }
    if (preset === 'REVIEW') {
      return {
        importEnabled: true,
        autoPublishEnabled: false,
        publishIntervalMinutes: 60,
        dailyLimit: 5,
        minPublishIntervalMinutes: 30,
        publishMode: 'REVIEW',
        priority: VK_SOURCE_PRIORITY_NORMAL,
      };
    }

    return {
      importEnabled: true,
      autoPublishEnabled: true,
      publishIntervalMinutes: 90,
      dailyLimit: 4,
      minPublishIntervalMinutes: 45,
      publishMode: VK_SOURCE_PUBLISH_MODE_QUEUE,
      priority: VK_SOURCE_PRIORITY_NORMAL,
    };
  }

  private pickAuditedSourceSettings(source: VkParsingSourceRow): Record<string, unknown> {
    return {
      importEnabled: source.importEnabled,
      autoPublishEnabled: source.autoPublishEnabled,
      publishIntervalMinutes: source.publishIntervalMinutes,
      dailyLimit: source.dailyLimit,
      minPublishIntervalMinutes: source.minPublishIntervalMinutes,
      publishMode: source.publishMode,
      priority: source.priority,
      quietHoursStart: source.quietHoursStart,
      quietHoursEnd: source.quietHoursEnd,
    };
  }

  private async lockChat(tx: Prisma.TransactionClient, chatId: string): Promise<void> {
    const lockedChats = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT chat."id"
      FROM "chats" AS chat
      WHERE chat."id" = ${chatId}
      FOR UPDATE OF chat
    `;
    if (lockedChats.length !== 1) {
      throw new NotFoundException('Чат или канал не найден.');
    }
  }

  private async clearQueuedAutoPublishForSources(
    tx: Prisma.TransactionClient,
    chatId: string,
    sourceIds: string[],
    ownerScope: VkParsingOwnerScope,
  ): Promise<void> {
    const uniqueSourceIds = [...new Set(sourceIds.filter(Boolean))];
    if (uniqueSourceIds.length === 0) {
      return;
    }
    await tx.vkParsingPost.updateMany({
      where: {
        chatId,
        ...ownerScope,
        sourceId: { in: uniqueSourceIds },
        status: { in: ['NEW', 'FAILED'] },
        publishLockedAt: null,
        publishAttemptCount: 0,
        OR: [
          {
            publishReason: 'autopublish',
            OR: [
              { publishQueuedAt: { not: null } },
              { publishIdempotencyKey: { not: null } },
              { publishScheduledAt: { not: null } },
            ],
          },
          {
            publishScheduleFingerprint: { not: null },
            publishQueuedAt: null,
            publishLockedAt: null,
            publishIdempotencyKey: null,
            publishReason: null,
            publishScheduledAt: null,
            publishCancelledAt: null,
            publishCancelledByUserId: null,
            publishActorUserId: null,
            dispatchBlockerCode: null,
            dispatchBlockedAt: null,
          },
        ],
      },
      data: {
        publishQueuedAt: null,
        publishLockedAt: null,
        publishIdempotencyKey: null,
        publishReason: null,
        publishScheduledAt: null,
        publishScheduleFingerprint: null,
      },
    });
  }

  private normalizeSourceInput(input: string): NormalizedVkSourceInput {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new BadRequestException('Укажите ссылку на VK-сообщество.');
    }

    let sourcePath = trimmed;
    if (/^https?:\/\//iu.test(trimmed) || /^(?:www\.|m\.)?(?:vk\.com|vk\.ru)\//iu.test(trimmed)) {
      const url = this.parseVkSourceUrl(
        /^https?:\/\//iu.test(trimmed) ? trimmed : `https://${trimmed}`,
      );
      const host = url.hostname
        .replace(/^www\./iu, '')
        .replace(/^m\./iu, '')
        .toLowerCase();
      if (host !== 'vk.com' && host !== 'vk.ru') {
        throw new BadRequestException('Поддерживаются только ссылки vk.ru и vk.com.');
      }
      if (url.username || url.password || url.port) {
        throw new BadRequestException('Некорректная ссылка на VK-сообщество.');
      }

      const segment = url.pathname
        .split('/')
        .map((part) => part.trim())
        .filter(Boolean)[0];
      if (!segment) {
        throw new BadRequestException('Укажите ссылку на VK-сообщество.');
      }
      sourcePath = segment;
    }

    const domain = sourcePath.replace(/^@/u, '').trim();
    if (/^(?:wall|photo|video|album|topic)-?\d+/iu.test(domain)) {
      throw new BadRequestException('Нужна ссылка на сообщество, не на отдельный материал.');
    }
    if (!/^[A-Za-z0-9_.-]{2,80}$/u.test(domain)) {
      throw new BadRequestException('Некорректная ссылка на VK-сообщество.');
    }

    return {
      domain,
      url: `https://vk.ru/${domain}`,
    };
  }

  private resolveSourceInfo(
    input: NormalizedVkSourceInput,
    wall: VkWallGetResponse,
  ): NormalizedVkSourceInfo {
    const groups = (wall.groups ?? [])
      .map((item) => this.asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== null);
    const firstPost = (wall.items ?? [])
      .map((item) => this.asRecord(item))
      .find((item): item is Record<string, unknown> => item !== null);
    const groupIdFromPost = this.resolveGroupIdFromPost(firstPost ?? null);
    if (firstPost && groupIdFromPost === null) {
      throw new BadRequestException('Нужна ссылка на VK-сообщество, не на личную страницу.');
    }
    const group =
      typeof groupIdFromPost === 'number'
        ? (groups.find((item) => this.readNumber(item.id) === groupIdFromPost) ?? null)
        : this.findGroupByInputDomain(groups, input.domain);
    const groupId = groupIdFromPost ?? this.readNumber(group?.id);
    if (!groupId || !Number.isSafeInteger(groupId) || groupId < 0) {
      throw new BadRequestException('VK-сообщество не найдено или недоступно.');
    }

    const screenName = this.readString(group?.screen_name) || input.domain;
    const title = this.readString(group?.name) || screenName;
    return {
      ownerId: groupId,
      wallOwnerId: -Math.abs(groupId),
      screenName,
      title,
      url: `https://vk.ru/${screenName}`,
    };
  }

  private resolveGroupIdFromPost(post: Record<string, unknown> | null): number | null {
    const ownerId = this.readNumber(post?.owner_id);
    if (typeof ownerId !== 'number' || !Number.isSafeInteger(ownerId) || ownerId >= 0) {
      return null;
    }

    return Math.abs(ownerId);
  }

  private findGroupByInputDomain(
    groups: Record<string, unknown>[],
    domain: string,
  ): Record<string, unknown> | null {
    const normalizedDomain = domain.toLowerCase();
    for (const group of groups) {
      const id = this.readNumber(group.id);
      const screenName = this.readString(group.screen_name).toLowerCase();
      if (screenName && screenName === normalizedDomain) {
        return group;
      }
      if (
        typeof id === 'number' &&
        (normalizedDomain === `club${id}` ||
          normalizedDomain === `public${id}` ||
          normalizedDomain === `event${id}`)
      ) {
        return group;
      }
    }

    return null;
  }

  private parseVkSourceUrl(value: string): URL {
    try {
      return new URL(value);
    } catch {
      throw new BadRequestException('Некорректная ссылка на VK-сообщество.');
    }
  }

  private async fetchWall(options: {
    domain?: string;
    ownerId?: number;
    count: number;
    offset?: number;
  }): Promise<VkWallGetResponse> {
    const params: Record<string, string> = {
      count: String(Math.max(1, Math.min(options.count, 100))),
      filter: 'owner',
      extended: '1',
    };
    if (options.domain) {
      params.domain = options.domain;
    }
    if (typeof options.ownerId === 'number') {
      params.owner_id = String(options.ownerId);
    }
    if (typeof options.offset === 'number' && options.offset > 0) {
      params.offset = String(Math.max(0, Math.trunc(options.offset)));
    }

    const response = await this.vkApiClient.request('wall.get', params);
    if (!this.asRecord(response) || !Array.isArray(this.asRecord(response)?.items)) {
      throw new VkApiRequestError('VK вернул неполную стену.', 'invalid_response', true);
    }

    return response as VkWallGetResponse;
  }

  private toJsonInput(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private readNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
  }
}
