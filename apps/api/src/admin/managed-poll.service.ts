import { resolveExplicitMembershipAccessDenial } from '../max/max-membership-access-error';
import {
  createManagedPollRequestSchema,
  decodeManagedPollListCursor,
  encodeManagedPollListCursor,
  MANAGED_POLL_MESSAGE_MAX_LENGTH,
  managedPollDetailsSchema,
  managedPollImagesSchema,
  managedPollListQuerySchema,
  managedPollListResponseSchema,
  managedPollSummarySchema,
  managedPollVotersQuerySchema,
  managedPollVotersResponseSchema,
  updateManagedPollRequestSchema,
  type ManagedPollDetails,
  type ManagedPollImage,
  type ManagedPollListCursorPayload,
  type ManagedPollListResponse,
  type ManagedPollQuestionFormat,
  type ManagedPollVotersResponse,
} from '@maxim/contracts/poll';
import type { ManagedEntityType, MaxUpdate } from '@maxim/contracts';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { InternalChannelDialogButtonIdentity } from '../common/channel-dialog-button-identity.util';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { formatCommentsButtonText } from '../common/dialog-button-label.util';
import { stripSupportedMarkdownToPlainText } from '../common/max-markdown.util';
import {
  buildManagedPollButtons,
  buildManagedPollCallbackPayloadPrefixes,
  buildManagedPollMessageText,
  buildManagedPollOptionResults,
  parseManagedPollCallbackPayload,
} from '../common/managed-poll.util';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  type MaxApiTrafficClass,
  type MaxAttachmentPayload,
  type MaxSendMessageOptions,
} from '../max/max-client.service';
import { isAmbiguousMaxSendError } from '../max/max-send-ambiguity.util';
import { wasMaxPreDispatchGuardRejected } from '../max/max-action-pre-dispatch-guard';
import {
  MaxRoutedPublicationService,
  type MaxRoutedPublicationResult,
} from '../max/max-routed-publication.service';
import { ManagedEntityAccessLossService } from '../max/managed-entity-access-loss.service';
import { classifyMaxSendAutoDeleteVerificationCause } from '../max/max-send-auto-delete-verification-error';
import { RedisCounterService } from '../moderation/redis-counter.service';
import { BackgroundRuntimeGovernorService } from '../system/background-runtime-governor.service';
import {
  ChatEntityType,
  ManagedPollStatus,
  ManagedPollVisibility,
  Prisma,
  type ManagedPoll,
  type ManagedPollOption,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { extractMaxApiErrorMessage } from './admin-chat-rules';
import {
  decodeBroadcastImageBase64,
  resolveBroadcastImageFileName,
  resolveManagedBroadcastSendRetryDelayMs,
  resolveManagedBroadcastUploadRetryDelayMs,
} from './admin-managed-broadcast-media';
import {
  buildManagedPollLedgerContext,
  readManagedPollChannelEngagementReference,
  readManagedPollLedgerChannelEngagement,
  type ManagedPollChannelEngagementReference,
} from './admin-managed-poll-ledger';
import { AdminDialogLinkService } from './admin-dialog-link.service';
import { AdminService } from './admin.service';
import type { ChannelPublicationEngagementContext } from './admin.service.support';
import { ChannelPostSignatureService } from './channel-post-signature.service';
import {
  BROADCAST_IMAGE_MAX_BYTES,
  BROADCAST_IMAGES_TOTAL_MAX_BYTES,
  CHANNEL_DIALOG_ACTION_AUTO_ATTACH,
  CHANNEL_DIALOG_ACTION_COMMENT,
} from './admin.service.support';

const MANAGED_POLL_SEND_TIMEOUT_MS = 12_000;
const MANAGED_POLL_EDIT_TIMEOUT_MS = 8_000;
const MANAGED_POLL_UPLOAD_TIMEOUT_MS = 30_000;
const MANAGED_POLL_PUBLICATION_CLAIM_TTL_MS = 60_000;
const MANAGED_POLL_PUBLICATION_CLAIM_HEARTBEAT_MS = 15_000;
const MANAGED_POLL_RENDER_LOCK_TTL_MS = 120_000;
const MANAGED_POLL_RENDER_LOCK_HEARTBEAT_MS = 30_000;
const MANAGED_POLL_RENDER_LOCK_WAIT_MS = 4_000;
const MANAGED_POLL_RENDER_MAX_ATTEMPTS = 2;
const MANAGED_POLL_RENDER_REPAIR_ATTEMPTS = 3;
const MANAGED_POLL_RENDER_REPAIR_DELAY_MS = 250;
const MANAGED_POLL_BACKGROUND_REPAIR_BATCH_SIZE = 10;
const MANAGED_POLL_BACKGROUND_REPAIR_DISPATCH_MS = 5_000;
const MANAGED_POLL_BACKGROUND_RETRY_DELAY_MS = 5 * 60_000;
const MANAGED_POLL_RECENT_EVENT_HASH_LIMIT = 16;
const MANAGED_POLL_AMBIGUOUS_PUBLICATION_ERROR = 'Публикация требует ручной проверки.';
const MANAGED_POLL_RENDER_FORMAT_VERSION = 7;
// FLAG: A dispatched send key must remain stable across render-only format upgrades.
const MANAGED_POLL_SEND_IDEMPOTENCY_VERSION = 4;

const MANAGED_POLL_LIST_SELECT = {
  id: true,
  chatId: true,
  question: true,
  questionFormat: true,
  imageCount: true,
  status: true,
  visibility: true,
  renderRevision: true,
  renderedRevision: true,
  renderFormatVersion: true,
  publicationMessageId: true,
  publicationUrl: true,
  publishedAt: true,
  closedAt: true,
  lockedAt: true,
  lastError: true,
  lastRenderError: true,
  createdAt: true,
  updatedAt: true,
  options: { orderBy: { position: 'asc' } },
} satisfies Prisma.ManagedPollSelect;

const MANAGED_POLL_HOT_PATH_SELECT = {
  ...MANAGED_POLL_LIST_SELECT,
  actorUserId: true,
  identitySalt: true,
  publicationBotId: true,
  lockToken: true,
  chat: { select: { entityType: true } },
} satisfies Prisma.ManagedPollSelect;

type PollWithOptions = ManagedPoll & { options: ManagedPollOption[] };
type PollListItem = Prisma.ManagedPollGetPayload<{ select: typeof MANAGED_POLL_LIST_SELECT }>;
type PollHotPathItem = Prisma.ManagedPollGetPayload<{
  select: typeof MANAGED_POLL_HOT_PATH_SELECT;
}>;
type PollPublicationMedia = Pick<MaxSendMessageOptions, 'imagePayload' | 'attachments'>;
type PollPublicationAttemptOptions = {
  options: MaxSendMessageOptions;
  engagementContext: ChannelPublicationEngagementContext | null;
};
type PollChannelEngagementResolution =
  | {
      state: 'resolved';
      context: ChannelPublicationEngagementContext;
      shouldRecord: boolean;
    }
  | { state: 'none' | 'inconclusive' };
type PollChannelEngagementExactLookup =
  | { state: 'resolved'; identities: InternalChannelDialogButtonIdentity[] }
  | { state: 'absent' }
  | { state: 'inconclusive' };
type PollCallbackUser = {
  userId: string;
  displayName: string | null;
  username: string | null;
};
type PollCallbackOutcome =
  | {
      kind: 'recorded';
      changed: boolean;
      replayed?: boolean;
      pollId: string;
      needsRender: boolean;
    }
  | { kind: 'closed'; pollId: string; needsRender: boolean }
  | { kind: 'stale' };

@Injectable()
export class ManagedPollService {
  private readonly logger = new Logger(ManagedPollService.name);
  private readonly localRenderChains = new Map<string, Promise<void>>();
  private readonly scheduledRenderRepairs = new Map<string, Promise<void>>();
  private readonly renderRetryUntil = new Map<string, number>();
  private nextBackgroundRepairAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly adminService: AdminService,
    private readonly chatContextCache: ChatContextCacheService,
    @Optional() private readonly managedEntityAccessLossService?: ManagedEntityAccessLossService,
    @Optional() private readonly redisCounter?: RedisCounterService,
    @Optional() private readonly maxRoutedPublicationService?: MaxRoutedPublicationService,
    @Optional() _channelPostSignatureService?: ChannelPostSignatureService,
    @Optional() private readonly adminDialogLinkService?: AdminDialogLinkService,
    @Optional() private readonly backgroundGovernor?: BackgroundRuntimeGovernorService,
  ) {}

  async processPendingPollRenderRepairs(
    options: { shouldContinue?: () => boolean } = {},
  ): Promise<number> {
    if (options.shouldContinue?.() === false || Date.now() < this.nextBackgroundRepairAt) return 0;
    const decision = await this.pollRepairDecision();
    if (decision.action === 'pause') return 0;
    const dispatchUntil = performance.now() + MANAGED_POLL_BACKGROUND_REPAIR_DISPATCH_MS;
    const retryBefore = new Date(Date.now() - MANAGED_POLL_BACKGROUND_RETRY_DELAY_MS);
    const rows = await this.prisma.$queryRaw<Array<{ id: string; chatId: string }>>`
      SELECT "id", "chat_id" AS "chatId"
      FROM "managed_polls"
      WHERE "publication_message_id" IS NOT NULL
        AND (
          "rendered_revision" < "render_revision"
          OR "render_format_version" < ${MANAGED_POLL_RENDER_FORMAT_VERSION}
          OR "last_render_error" IS NOT NULL
        )
        AND ("last_render_error" IS NULL OR "updated_at" <= ${retryBefore})
      ORDER BY "updated_at" ASC, "id" ASC
      LIMIT ${MANAGED_POLL_BACKGROUND_REPAIR_BATCH_SIZE}
    `;
    let repaired = 0;
    let attempted = 0;
    for (const row of rows) {
      // FLAG: Repair is optional background work. Stop admission on pressure/shutdown,
      // retaining SQL revision/error evidence and any already-running edit until it settles.
      if (options.shouldContinue?.() === false || performance.now() >= dispatchUntil) break;
      const currentDecision = await this.pollRepairDecision();
      if (options.shouldContinue?.() === false || performance.now() >= dispatchUntil) break;
      if (
        currentDecision.action === 'pause' ||
        (currentDecision.action === 'slow' && attempted > 0)
      )
        break;
      attempted++;
      try {
        let renderSucceeded = false;
        const serialized = await this.runPollRenderSerialized(row.id, async () => {
          if (options.shouldContinue?.() === false || performance.now() >= dispatchUntil) return;
          renderSucceeded = await this.renderPollPublication(
            row.chatId,
            row.id,
            'background-repair',
          );
        });
        if (serialized && renderSucceeded) {
          repaired += 1;
        }
      } catch (error: unknown) {
        this.logger.warn(
          { pollId: row.id, chatId: row.chatId, err: this.formatError(error) },
          'Failed to repair managed poll publication in background',
        );
      }
      if (decision.action === 'slow' || currentDecision.action === 'slow') break;
    }
    return repaired;
  }

  private async pollRepairDecision() {
    const decision = this.backgroundGovernor
      ? await this.backgroundGovernor.decide({
          component: 'managed-poll-repair',
          sourceTag: MAX_API_SOURCE_TAGS.MANAGED_POLL,
        })
      : { action: 'run' as const, retryAfterMs: 0 };
    if (decision.action !== 'run')
      this.nextBackgroundRepairAt = Date.now() + Math.max(1_000, decision.retryAfterMs);
    return decision;
  }

  async listChannelPolls(
    chatId: string,
    user: AuthUser,
    query: unknown,
    entityType: ManagedEntityType = 'channel',
  ): Promise<ManagedPollListResponse> {
    await this.adminService.assertManagedEntityReadAccess(chatId, user.userId, entityType);
    const parsed = managedPollListQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const scope = parsed.data.scope ?? 'all';
    let cursor: ManagedPollListCursorPayload | null = null;
    if (parsed.data.cursor) {
      const decodedCursor = decodeManagedPollListCursor(parsed.data.cursor);
      if (decodedCursor) {
        if (decodedCursor.scope !== scope || decodedCursor.chatId !== chatId) {
          throw new BadRequestException('Курсор списка опросов недействителен.');
        }
        cursor = decodedCursor;
      } else {
        const legacyCursorPoll = await this.prisma.managedPoll.findFirst({
          where: { id: parsed.data.cursor, chatId },
          select: { id: true, createdAt: true },
        });
        if (!legacyCursorPoll) {
          throw new BadRequestException('Курсор списка опросов недействителен.');
        }
        cursor = {
          v: 1,
          createdAt: legacyCursorPoll.createdAt.toISOString(),
          id: legacyCursorPoll.id,
          chatId,
          scope,
        };
      }
    }

    const baseWhere: Prisma.ManagedPollWhereInput = {
      chatId,
      ...(parsed.data.scope === 'current'
        ? { status: { in: [ManagedPollStatus.DRAFT, ManagedPollStatus.ACTIVE] } }
        : parsed.data.scope === 'archive'
          ? { status: ManagedPollStatus.CLOSED }
          : {}),
    };
    const pageWhere: Prisma.ManagedPollWhereInput = cursor
      ? {
          AND: [
            baseWhere,
            {
              OR: [
                { createdAt: { lt: new Date(cursor.createdAt) } },
                { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } },
              ],
            },
          ],
        }
      : baseWhere;
    const [polls, total] = await Promise.all([
      this.prisma.managedPoll.findMany({
        where: pageWhere,
        select: MANAGED_POLL_LIST_SELECT,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: parsed.data.limit + 1,
      }),
      this.prisma.managedPoll.count({ where: baseWhere }),
    ]);
    const hasMore = polls.length > parsed.data.limit;
    const page = hasMore ? polls.slice(0, parsed.data.limit) : polls;
    const counts = await this.loadVoteCounts(page.map((poll) => poll.id));
    const response = managedPollListResponseSchema.parse({
      items: page.map((poll) => managedPollSummarySchema.parse(this.mapPoll(poll, counts))),
      nextCursor:
        hasMore && page.at(-1)
          ? encodeManagedPollListCursor({
              v: 1,
              createdAt: page.at(-1)!.createdAt.toISOString(),
              id: page.at(-1)!.id,
              chatId,
              scope,
            })
          : null,
      total,
    });
    for (const [index, poll] of page.entries()) {
      if (
        poll.publicationMessageId &&
        !poll.lastRenderError &&
        this.pollNeedsRenderRepair(poll) &&
        response.items[index]?.renderRepairNeeded
      ) {
        this.schedulePollRenderRepair(chatId, poll.id);
      }
    }
    return response;
  }

  async getChannelPoll(
    chatId: string,
    pollId: string,
    user: AuthUser,
    entityType: ManagedEntityType = 'channel',
  ): Promise<ManagedPollDetails> {
    await this.adminService.assertManagedEntityReadAccess(chatId, user.userId, entityType);
    return this.readPollDetails(chatId, pollId);
  }

  async createChannelPoll(
    chatId: string,
    user: AuthUser,
    body: unknown,
    entityType: ManagedEntityType = 'channel',
  ): Promise<ManagedPollDetails> {
    await this.adminService.assertManagedEntityAdminAccess(chatId, user.userId, entityType);
    const parsed = createManagedPollRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    this.assertManagedPollQuestionFitsMax(parsed.data.question, parsed.data.questionFormat);

    const created = await this.prisma.$transaction(async (tx) => {
      const poll = await tx.managedPoll.create({
        data: {
          chat: { connect: { id: chatId } },
          actorUserId: user.userId,
          question: parsed.data.question,
          questionFormat: parsed.data.questionFormat,
          visibility: parsed.data.visibility,
          imageCount: parsed.data.images.length,
          images: parsed.data.images as Prisma.InputJsonValue,
          identitySalt: randomUUID().replace(/-/gu, ''),
          options: {
            create: parsed.data.options.map((option, position) => ({
              position,
              text: option.text,
            })),
          },
        },
        include: { options: { orderBy: { position: 'asc' } } },
      });
      await tx.auditLog.create({
        data: {
          chatId,
          actorUserId: user.userId,
          action: `CREATE_${this.pollEntityAuditLabel(entityType)}_POLL`,
          payload: {
            pollId: poll.id,
            questionFormat: poll.questionFormat,
            visibility: poll.visibility,
            imageCount: parsed.data.images.length,
            optionsCount: poll.options.length,
          },
        },
      });
      return poll;
    });
    await this.chatContextCache.invalidate(chatId);
    return managedPollDetailsSchema.parse(this.mapPoll(created, new Map(), true));
  }

  async updateChannelPoll(
    chatId: string,
    pollId: string,
    user: AuthUser,
    body: unknown,
    entityType: ManagedEntityType = 'channel',
  ): Promise<ManagedPollDetails> {
    await this.adminService.assertManagedEntityAdminAccess(chatId, user.userId, entityType);
    const parsed = updateManagedPollRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      await this.lockPollRow(tx, pollId);
      const poll = await tx.managedPoll.findFirst({
        where: { id: pollId, chatId },
        include: { options: true },
      });
      if (!poll) {
        throw new NotFoundException('Опрос не найден.');
      }
      if (poll.updatedAt.getTime() !== new Date(parsed.data.expectedUpdatedAt).getTime()) {
        throw new ConflictException('Черновик опроса уже изменён. Обновите экран.');
      }
      if (poll.status !== ManagedPollStatus.DRAFT || poll.lockedAt) {
        throw new BadRequestException('Опубликованный опрос нельзя изменить.');
      }
      const questionFormat =
        parsed.data.questionFormat ?? this.normalizeQuestionFormat(poll.questionFormat);
      this.assertManagedPollQuestionFitsMax(parsed.data.question, questionFormat);
      const images = parsed.data.images ?? this.readPollImages(poll.images);
      const visibility = parsed.data.visibility ?? poll.visibility;

      const knownOptionIds = new Set(poll.options.map((option) => option.id));
      for (const option of parsed.data.options) {
        if (option.id && !knownOptionIds.has(option.id)) {
          throw new BadRequestException('Вариант ответа больше не существует.');
        }
      }

      await tx.managedPollOption.deleteMany({ where: { pollId } });
      await tx.managedPollOption.createMany({
        data: parsed.data.options.map((option, position) => ({
          ...(option.id ? { id: option.id } : {}),
          pollId,
          position,
          text: option.text,
        })),
      });
      await tx.managedPoll.update({
        where: { id: pollId },
        data: {
          actorUserId: user.userId,
          question: parsed.data.question,
          questionFormat,
          visibility,
          imageCount: images.length,
          // FLAG: Keep unchanged TOAST media pointers while the draft lock/revision advances.
          ...(!isDeepStrictEqual(poll.images, images)
            ? { images: images as Prisma.InputJsonValue }
            : {}),
          renderRevision: { increment: 1 },
          lastError: null,
          lastRenderError: null,
        },
      });
      await tx.auditLog.create({
        data: {
          chatId,
          actorUserId: user.userId,
          action: `UPDATE_${this.pollEntityAuditLabel(entityType)}_POLL`,
          payload: {
            pollId,
            questionFormat,
            visibility,
            imageCount: images.length,
            optionsCount: parsed.data.options.length,
          },
        },
      });
      return tx.managedPoll.findUniqueOrThrow({
        where: { id: pollId },
        include: { options: { orderBy: { position: 'asc' } } },
      });
    });
    await this.chatContextCache.invalidate(chatId);
    return managedPollDetailsSchema.parse(this.mapPoll(updated, new Map(), true));
  }

  async deleteChannelPoll(
    chatId: string,
    pollId: string,
    user: AuthUser,
    entityType: ManagedEntityType = 'channel',
  ): Promise<{ ok: true }> {
    await this.adminService.assertManagedEntityAdminAccess(chatId, user.userId, entityType);
    await this.prisma.$transaction(async (tx) => {
      await this.lockPollRow(tx, pollId);
      const poll = await tx.managedPoll.findFirst({ where: { id: pollId, chatId } });
      if (!poll) {
        throw new NotFoundException('Опрос не найден.');
      }
      if (poll.status !== ManagedPollStatus.DRAFT || poll.publicationMessageId || poll.lockedAt) {
        throw new BadRequestException('Удалить можно только неопубликованный черновик.');
      }
      await tx.managedPoll.delete({ where: { id: pollId } });
      await tx.auditLog.create({
        data: {
          chatId,
          actorUserId: user.userId,
          action: `DELETE_${this.pollEntityAuditLabel(entityType)}_POLL`,
          payload: { pollId },
        },
      });
    });
    await this.chatContextCache.invalidate(chatId);
    return { ok: true };
  }

  async publishChannelPoll(
    chatId: string,
    pollId: string,
    user: AuthUser,
    entityType: ManagedEntityType = 'channel',
  ): Promise<ManagedPollDetails> {
    await this.adminService.assertManagedEntityAdminAccess(chatId, user.userId, entityType);
    const poll = await this.findPoll(chatId, pollId);
    if (poll.status !== ManagedPollStatus.DRAFT) {
      throw new BadRequestException('Опубликовать можно только черновик.');
    }
    if (poll.lockedAt) {
      throw new ConflictException(
        this.publicationNeedsReview(poll)
          ? 'Публикация уже отправлялась и требует проверки.'
          : 'Публикация уже выполняется.',
      );
    }

    const publicationBotId = this.maxRoutedPublicationService
      ? null
      : await this.resolveFallbackPollBotId(chatId, entityType);
    const lockToken = randomUUID();
    const lockedAt = new Date();
    const lock = await this.prisma.managedPoll.updateMany({
      where: { id: poll.id, chatId, status: ManagedPollStatus.DRAFT, lockedAt: null },
      data: {
        lockedAt,
        lockToken,
        publicationBotId: publicationBotId ?? null,
        lastError: null,
      },
    });
    if (lock.count === 0) {
      throw new ConflictException('Публикация уже выполняется.');
    }

    const claimHeartbeat = this.startPublicationClaimHeartbeat(poll.id, lockToken);
    let attempted = false;
    let accepted = false;
    let attemptedPublicationBotId = publicationBotId;
    let publicationAttemptStartedAt: Date | null = null;
    try {
      const publicationPoll = await this.findPoll(chatId, poll.id);
      const result = buildManagedPollOptionResults(publicationPoll.options, new Map());
      const { text, textFormat } = this.buildAuthoredPollMessage(
        publicationPoll.question,
        publicationPoll.questionFormat,
      );
      const pollButtons = buildManagedPollButtons(publicationPoll.id, result.options, lockToken);
      const messageOptions: MaxSendMessageOptions = {
        ...(textFormat ? { textFormat } : {}),
        buttons: pollButtons,
        debugContext: { screen: 'managed-poll', action: 'publish' },
      };
      const engagementContextByBotId = new Map<string, ChannelPublicationEngagementContext>();
      const prepareAttemptOptions = async (
        botId: string,
      ): Promise<PollPublicationAttemptOptions> => {
        if (
          entityType !== 'channel' ||
          typeof this.adminService.buildChannelPublicationEngagementContext !== 'function'
        ) {
          return { options: messageOptions, engagementContext: null };
        }
        const context = await this.adminService.buildChannelPublicationEngagementContext(
          chatId,
          botId,
        );
        engagementContextByBotId.set(botId, context);
        return {
          options: {
            ...messageOptions,
            buttons: [...pollButtons, ...context.buttons],
          },
          engagementContext: context,
        };
      };
      if (!(await claimHeartbeat.renew())) {
        throw new ConflictException(
          `Публикация опроса была сброшена. Проверьте ${this.pollEntityName(entityType)}.`,
        );
      }
      const published = await this.sendPollPublicationWithRetry(
        chatId,
        publicationPoll.id,
        publicationPoll.renderRevision,
        lockToken,
        text,
        messageOptions,
        this.readPollImages(publicationPoll.images),
        publicationBotId,
        async (botId) => {
          const boundAttempt = await this.prisma.managedPoll.updateMany({
            where: {
              id: poll.id,
              lockToken,
              status: ManagedPollStatus.DRAFT,
            },
            data: {
              publicationBotId: botId,
              lockedAt: new Date(),
            },
          });
          if (boundAttempt.count === 0) {
            throw new ConflictException(
              `Публикация опроса была сброшена. Проверьте ${this.pollEntityName(entityType)}.`,
            );
          }
          attempted = true;
          attemptedPublicationBotId = botId;
          publicationAttemptStartedAt = new Date();
        },
        prepareAttemptOptions,
      );
      accepted = true;
      if (!(await claimHeartbeat.stop())) {
        throw new ConflictException(
          `Публикация опроса была сброшена. Проверьте ${this.pollEntityName(entityType)}.`,
        );
      }
      let engagementContextResolved = engagementContextByBotId.has(published.botId);
      let publicationFormatResolved = entityType !== 'channel' || engagementContextResolved;
      let engagementContext = engagementContextByBotId.get(published.botId) ?? null;
      if (!engagementContextResolved && entityType === 'channel') {
        try {
          const recovered = await this.loadManagedPollLedgerChannelEngagement(
            this.buildPollPublicationActionKey(
              publicationPoll.id,
              publicationPoll.renderRevision,
              lockToken,
            ),
            chatId,
            published.botId,
          );
          engagementContextResolved = recovered.found;
          engagementContext = recovered.found ? recovered.context : null;
          publicationFormatResolved =
            recovered.found && recovered.renderFormatVersion === MANAGED_POLL_RENDER_FORMAT_VERSION;
        } catch (error: unknown) {
          this.logger.warn(
            {
              pollId: poll.id,
              chatId,
              messageId: published.messageId,
              botId: published.botId,
              err: this.formatError(error),
            },
            'Failed to recover managed poll engagement from the completed publication ledger',
          );
        }
      }
      const publicationRenderFormatVersion =
        entityType === 'channel' && !publicationFormatResolved
          ? MANAGED_POLL_SEND_IDEMPOTENCY_VERSION
          : MANAGED_POLL_RENDER_FORMAT_VERSION;
      const publishedAt = new Date();
      await this.prisma.$transaction(async (tx) => {
        const promoted = await tx.managedPoll.updateMany({
          where: {
            id: poll.id,
            lockToken,
            status: ManagedPollStatus.DRAFT,
          },
          data: {
            actorUserId: user.userId,
            status: ManagedPollStatus.ACTIVE,
            publicationMessageId: published.messageId,
            publicationBotId: published.botId,
            publicationUrl: published.url,
            publishedAt,
            renderedRevision: publicationPoll.renderRevision,
            renderFormatVersion: publicationRenderFormatVersion,
            images: [],
            lockedAt: null,
            lastError: null,
            lastRenderError: null,
          },
        });
        if (promoted.count === 0) {
          throw new ConflictException(
            `Публикация опроса была сброшена. Проверьте ${this.pollEntityName(entityType)}.`,
          );
        }
        await tx.auditLog.create({
          data: {
            chatId,
            actorUserId: user.userId,
            action: `PUBLISH_${this.pollEntityAuditLabel(entityType)}_POLL`,
            payload: {
              pollId: poll.id,
              questionFormat: this.normalizeQuestionFormat(publicationPoll.questionFormat),
              visibility: publicationPoll.visibility,
              imageCount: this.readPollImages(publicationPoll.images).length,
              optionsCount: publicationPoll.options.length,
              publicationMessageId: published.messageId,
            },
          },
        });
      });
      if (engagementContext) {
        await this.recordPollChannelEngagementSafely({
          chatId,
          actorUserId: user.userId,
          messageId: published.messageId,
          text: publicationPoll.question,
          publishedUrl: published.url,
          context: engagementContext,
          botId: published.botId,
        });
      }
      if (entityType === 'channel' && (!engagementContextResolved || !publicationFormatResolved)) {
        this.logger.warn(
          {
            pollId: poll.id,
            chatId,
            messageId: published.messageId,
            botId: published.botId,
            engagementContextResolved,
            publicationFormatResolved,
          },
          'Scheduled managed poll format repair after publication recovery',
        );
        this.schedulePollRenderRepair(chatId, poll.id);
      }
      await this.chatContextCache.invalidate(chatId);
      return this.readPollDetails(chatId, poll.id);
    } catch (error: unknown) {
      await claimHeartbeat.stop();
      const ambiguous = accepted || (attempted && isAmbiguousMaxSendError(error));
      const message = extractMaxApiErrorMessage(error) || this.formatError(error);
      const released = await this.prisma.managedPoll.updateMany({
        where: { id: poll.id, lockToken, status: ManagedPollStatus.DRAFT },
        data: ambiguous
          ? { lastError: MANAGED_POLL_AMBIGUOUS_PUBLICATION_ERROR }
          : {
              lockedAt: null,
              lockToken: null,
              publicationBotId: null,
              lastError: message,
            },
      });
      if (released.count === 0) {
        try {
          const recovered = await this.findPoll(chatId, poll.id);
          if (recovered.status === ManagedPollStatus.ACTIVE && recovered.publicationMessageId) {
            await this.chatContextCache.invalidate(chatId);
            return this.readPollDetails(chatId, poll.id);
          }
        } catch (recoveryError: unknown) {
          this.logger.debug(
            { pollId: poll.id, err: this.formatError(recoveryError) },
            'Failed to read callback-recovered managed poll publication',
          );
        }
      }
      if (
        attempted &&
        publicationAttemptStartedAt &&
        !ambiguous &&
        !this.wasManagedEntityAccessLossRecorded(error)
      ) {
        await this.recordAccessLoss(
          poll,
          attemptedPublicationBotId ?? null,
          'send',
          error,
          entityType,
          publicationAttemptStartedAt,
        );
      }
      throw new BadRequestException(
        ambiguous
          ? `MAX мог принять публикацию. Проверьте ${this.pollEntityName(entityType)} перед повтором.`
          : message || 'Не удалось опубликовать опрос.',
      );
    } finally {
      await claimHeartbeat.stop();
    }
  }

  async closeChannelPoll(
    chatId: string,
    pollId: string,
    user: AuthUser,
    entityType: ManagedEntityType = 'channel',
  ): Promise<ManagedPollDetails> {
    await this.adminService.assertManagedEntityAdminAccess(chatId, user.userId, entityType);
    const serialized = await this.runPollRenderSerialized(pollId, async () => {
      const closeResult = await this.prisma.$transaction(async (tx) => {
        await this.lockPollRow(tx, pollId);
        const poll = await tx.managedPoll.findFirst({ where: { id: pollId, chatId } });
        if (!poll) {
          throw new NotFoundException('Опрос не найден.');
        }
        if (poll.status === ManagedPollStatus.DRAFT) {
          throw new BadRequestException('Черновик ещё не опубликован.');
        }
        if (poll.status === ManagedPollStatus.CLOSED) {
          return { changed: false };
        }

        await tx.managedPoll.update({
          where: { id: poll.id },
          data: {
            status: ManagedPollStatus.CLOSED,
            closedAt: new Date(),
            renderRevision: { increment: 1 },
          },
        });
        await tx.auditLog.create({
          data: {
            chatId,
            actorUserId: user.userId,
            action: `CLOSE_${this.pollEntityAuditLabel(entityType)}_POLL`,
            payload: { pollId: poll.id },
          },
        });
        return { changed: true };
      });

      await this.renderPollPublication(
        chatId,
        pollId,
        closeResult.changed ? 'close' : 'retry-close',
      );
    });
    if (!serialized) {
      throw new ConflictException('Опрос сейчас обновляется. Повторите закрытие.');
    }
    await this.chatContextCache.invalidate(chatId);
    return this.readPollDetails(chatId, pollId);
  }

  async refreshChannelPollPublication(
    chatId: string,
    pollId: string,
    user: AuthUser,
    entityType: ManagedEntityType = 'channel',
  ): Promise<ManagedPollDetails> {
    await this.adminService.assertManagedEntityAdminAccess(chatId, user.userId, entityType);
    const poll = await this.findPoll(chatId, pollId);
    if (poll.status === ManagedPollStatus.DRAFT) {
      throw new BadRequestException('Черновик ещё не опубликован.');
    }

    const serialized = await this.runPollRenderSerialized(pollId, () =>
      this.renderPollPublication(chatId, pollId, 'manual-refresh'),
    );
    if (!serialized) {
      throw new ConflictException('Опрос сейчас обновляется. Повторите попытку.');
    }
    return this.readPollDetails(chatId, pollId);
  }

  async resetChannelPollPublication(
    chatId: string,
    pollId: string,
    user: AuthUser,
    entityType: ManagedEntityType = 'channel',
  ): Promise<ManagedPollDetails> {
    await this.adminService.assertManagedEntityAdminAccess(chatId, user.userId, entityType);
    await this.prisma.$transaction(async (tx) => {
      await this.lockPollRow(tx, pollId);
      const poll = await tx.managedPoll.findFirst({ where: { id: pollId, chatId } });
      if (!poll) {
        throw new NotFoundException('Опрос не найден.');
      }
      if (
        poll.status !== ManagedPollStatus.DRAFT ||
        !poll.lockedAt ||
        !this.publicationNeedsReview(poll)
      ) {
        throw new BadRequestException('Публикация не требует сброса.');
      }

      await tx.managedPoll.update({
        where: { id: poll.id },
        data: {
          lockedAt: null,
          lockToken: null,
          publicationBotId: null,
          lastError: null,
        },
      });
      await tx.auditLog.create({
        data: {
          chatId,
          actorUserId: user.userId,
          action: `RESET_${this.pollEntityAuditLabel(entityType)}_POLL_PUBLICATION`,
          payload: { pollId: poll.id },
        },
      });
    });
    await this.chatContextCache.invalidate(chatId);
    return this.readPollDetails(chatId, pollId);
  }

  async getChannelPollVoters(
    chatId: string,
    pollId: string,
    user: AuthUser,
    query: unknown,
    entityType: ManagedEntityType = 'channel',
  ): Promise<ManagedPollVotersResponse> {
    await this.adminService.assertManagedEntityAdminAccess(chatId, user.userId, entityType);
    const parsed = managedPollVotersQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const poll = await this.prisma.managedPoll.findFirst({
      where: { id: pollId, chatId },
      select: { id: true, visibility: true },
    });
    if (!poll) {
      throw new NotFoundException('Опрос не найден.');
    }
    if (poll.visibility !== ManagedPollVisibility.OPEN) {
      throw new BadRequestException('В анонимном опросе список участников скрыт.');
    }

    const rows = await this.prisma.managedPollVoter.findMany({
      where: { pollId, vote: { isNot: null } },
      include: { vote: { select: { optionId: true, createdAt: true, updatedAt: true } } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(parsed.data.cursor ? { cursor: { id: parsed.data.cursor }, skip: 1 } : {}),
      take: parsed.data.limit + 1,
    });
    const hasMore = rows.length > parsed.data.limit;
    const page = hasMore ? rows.slice(0, parsed.data.limit) : rows;
    return managedPollVotersResponseSchema.parse({
      items: page.flatMap((row) =>
        row.vote
          ? [
              {
                id: row.id,
                pollId: row.pollId,
                optionId: row.vote.optionId,
                userId: row.userId,
                displayName: row.displayName,
                username: row.username,
                votedAt: row.vote.createdAt.toISOString(),
                updatedAt: row.vote.updatedAt.toISOString(),
              },
            ]
          : [],
      ),
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    });
  }

  async tryHandleCallback(update: MaxUpdate): Promise<boolean> {
    const callback = this.extractCallbackNode(update);
    const payload = this.readString(callback?.payload ?? callback?.data);
    const parsed = parseManagedPollCallbackPayload(payload);
    if (!parsed) {
      return false;
    }

    const callbackId = this.readString(
      callback?.callback_id ?? callback?.callbackId ?? callback?.id,
    );
    const callbackUser = this.extractCallbackUser(callback);
    const chatId = update.message?.chatId?.trim() ?? '';
    const messageId = update.message?.messageId?.trim() ?? '';
    if (!callbackUser || !chatId || !messageId) {
      await this.answerCallback(callbackId, 'Опрос уже недоступен', update.botId, chatId || null);
      return true;
    }

    const voteParams = {
      pollId: parsed.pollId,
      optionId: parsed.optionId,
      chatId,
      messageId,
      callbackBotId: update.botId?.trim() || null,
      publicationToken: parsed.publicationToken,
      eventId: this.buildCallbackEventId(update, callbackId),
      eventAt: this.extractCallbackOccurredAt(update, callback),
      voter: callbackUser,
    };
    const serialized = await this.runPollRenderSerialized(parsed.pollId, async () => {
      const outcome = await this.recordVote(voteParams);
      if (outcome.kind === 'stale') {
        await this.answerCallback(callbackId, 'Опрос уже неактуален', update.botId, chatId);
        return;
      }
      if (outcome.kind === 'closed') {
        await this.answerCallback(callbackId, 'Опрос закрыт', update.botId, chatId);
        if (outcome.needsRender) {
          await this.renderPollPublication(chatId, outcome.pollId, 'closed-callback');
        }
        return;
      }

      const notification =
        outcome.replayed || outcome.changed ? 'Голос учтён' : 'Вы уже выбрали этот вариант';
      const poll = await this.loadPollAggregate(chatId, outcome.pollId);
      if (!callbackId) {
        if (outcome.needsRender) {
          await this.renderPollPublication(chatId, poll.id, 'vote-without-callback');
        }
        return;
      }
      if (poll.imageCount > 0) {
        await this.answerCallback(
          callbackId,
          notification,
          poll.publicationBotId ?? update.botId,
          chatId,
        );
        if (outcome.needsRender) {
          await this.renderPollPublication(chatId, poll.id, 'vote-media');
        }
        return;
      }
      // Current MAX clients can ignore notification-only callback answers. Re-send the exact
      // authored publication so the documented message response acknowledges the button press.
      let callbackAttempted = false;
      try {
        const engagement = await this.resolvePollChannelEngagement(
          poll,
          poll.publicationBotId ?? update.botId?.trim() ?? null,
        );
        const messageEdit = await this.buildCallbackMessageEdit(
          poll,
          engagement.state === 'resolved' ? engagement.context.buttons : [],
        );
        await this.maxClient.answerCallback(callbackId, undefined, messageEdit, {
          ...this.buildMaxOptions(
            poll.publicationBotId ?? update.botId,
            MANAGED_POLL_EDIT_TIMEOUT_MS,
          ),
          trafficClass: 'critical',
          rateLimitEntityId: chatId,
          boundObject: { kind: 'poll', id: poll.id },
          onDispatchAttempt: () => {
            callbackAttempted = true;
          },
        });
        if (
          engagement.state === 'resolved' &&
          engagement.shouldRecord &&
          poll.publicationMessageId
        ) {
          await this.recordPollChannelEngagementSafely({
            chatId: poll.chatId,
            actorUserId: poll.actorUserId,
            messageId: poll.publicationMessageId,
            text: poll.question,
            publishedUrl: poll.publicationUrl,
            context: engagement.context,
            botId: poll.publicationBotId ?? update.botId?.trim() ?? null,
            verifyApplied: true,
          });
        }
        if (outcome.needsRender) {
          if (engagement.state === 'inconclusive') {
            this.schedulePollRenderRepair(chatId, poll.id);
          } else if (!(await this.markPollRendered(poll.id, poll.renderRevision))) {
            this.schedulePollRenderRepair(chatId, poll.id);
          }
        }
      } catch (error: unknown) {
        if (!callbackAttempted || wasMaxPreDispatchGuardRejected(error)) {
          await this.recordPollRenderError(
            poll.id,
            poll.renderRevision,
            chatId,
            'vote-callback-prepare',
            error,
          );
          await this.answerCallback(
            callbackId,
            notification,
            poll.publicationBotId ?? update.botId,
            chatId,
          );
          if (outcome.needsRender) {
            this.schedulePollRenderRepair(chatId, poll.id);
          }
          return;
        }
        if (!this.isTerminalCallbackError(error)) {
          this.logger.warn(
            {
              pollId: poll.id,
              callbackId,
              err: this.formatError(error),
            },
            'Managed poll callback answer failed ambiguously; direct edit was skipped',
          );
          this.schedulePollRenderRepair(chatId, poll.id);
          return;
        }
        this.logger.debug(
          {
            pollId: poll.id,
            callbackId,
            err: this.formatError(error),
          },
          'Managed poll callback answer failed; falling back to direct edit',
        );
        await this.renderPollPublication(chatId, poll.id, 'vote-fallback');
      }
    });
    if (!serialized) {
      const outcome = await this.recordVote(voteParams);
      const notification =
        outcome.kind === 'stale'
          ? 'Опрос уже неактуален'
          : outcome.kind === 'closed'
            ? 'Опрос закрыт'
            : outcome.replayed || outcome.changed
              ? 'Голос учтён'
              : 'Вы уже выбрали этот вариант';
      await this.answerCallback(callbackId, notification, update.botId, chatId);
      if (
        (outcome.kind === 'recorded' && outcome.needsRender) ||
        (outcome.kind === 'closed' && outcome.needsRender)
      ) {
        this.schedulePollRenderRepair(chatId, parsed.pollId);
      }
    }
    return true;
  }

  private async recordVote(params: {
    pollId: string;
    optionId: string;
    chatId: string;
    messageId: string;
    callbackBotId: string | null;
    publicationToken: string | null;
    eventId: string;
    eventAt: Date;
    voter: PollCallbackUser;
  }): Promise<PollCallbackOutcome> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockPollRow(tx, params.pollId);
      let poll = await tx.managedPoll.findUnique({
        where: { id: params.pollId },
        select: MANAGED_POLL_HOT_PATH_SELECT,
      });
      if (!poll || poll.chatId !== params.chatId) {
        return { kind: 'stale' };
      }
      if ((poll.lockToken?.trim() || null) !== (params.publicationToken?.trim() || null)) {
        return { kind: 'stale' };
      }
      if (
        poll.publicationBotId &&
        params.callbackBotId &&
        poll.publicationBotId !== params.callbackBotId
      ) {
        return { kind: 'stale' };
      }
      if (!poll.options.some((option) => option.id === params.optionId)) {
        return { kind: 'stale' };
      }

      // FLAG: A matching callback is proof that a claimed draft reached MAX, even if the sender
      // crashed before persisting the message id or before its timeout was classified.
      if (
        poll.status === ManagedPollStatus.DRAFT &&
        poll.lockedAt &&
        poll.lockToken &&
        poll.publicationBotId &&
        params.callbackBotId === poll.publicationBotId &&
        !poll.publicationMessageId
      ) {
        const publishedAt = new Date();
        await tx.managedPoll.update({
          where: { id: poll.id },
          data: {
            status: ManagedPollStatus.ACTIVE,
            publicationMessageId: params.messageId,
            publishedAt,
            images: [],
            lockedAt: null,
            lastError: null,
          },
        });
        await tx.auditLog.create({
          data: {
            chatId: poll.chatId,
            actorUserId: poll.actorUserId,
            action: `RECOVER_${this.pollEntityAuditLabel(
              this.managedEntityTypeFromPrisma(poll.chat.entityType),
            )}_POLL_PUBLICATION`,
            payload: {
              pollId: poll.id,
              publicationMessageId: params.messageId,
              source: 'message_callback',
            },
          },
        });
        poll = {
          ...poll,
          status: ManagedPollStatus.ACTIVE,
          publicationMessageId: params.messageId,
          publishedAt,
          lockedAt: null,
          lastError: null,
        };
      }

      if ((poll.publicationMessageId?.trim() ?? '') !== params.messageId) {
        return { kind: 'stale' };
      }
      if (poll.status !== ManagedPollStatus.ACTIVE) {
        return {
          kind: 'closed',
          pollId: poll.id,
          needsRender: this.pollNeedsRenderRepair(poll),
        };
      }
      const needsRender = this.pollNeedsRenderRepair(poll);
      const identityHash = this.buildIdentityHash(poll.identitySalt, params.voter.userId);
      const eventHash = this.buildVoteEventHash(poll.identitySalt, params.eventId);
      const existingVoter = await tx.managedPollVoter.findUnique({
        where: { pollId_identityHash: { pollId: poll.id, identityHash } },
        include: { vote: { select: { optionId: true } } },
      });
      if (existingVoter?.recentEventHashes.includes(eventHash)) {
        return {
          kind: 'recorded',
          changed: false,
          replayed: true,
          pollId: poll.id,
          needsRender,
        };
      }
      const recentEventHashes = this.appendRecentEventHash(
        existingVoter?.recentEventHashes ?? [],
        eventHash,
      );
      if (existingVoter?.lastEventAt && params.eventAt < existingVoter.lastEventAt) {
        await tx.managedPollVoter.update({
          where: { id: existingVoter.id },
          data: { recentEventHashes },
        });
        return {
          kind: 'recorded',
          changed: false,
          replayed: true,
          pollId: poll.id,
          needsRender,
        };
      }

      const changed = existingVoter?.vote?.optionId !== params.optionId;
      const exposeIdentity = poll.visibility === ManagedPollVisibility.OPEN;
      const voter = await tx.managedPollVoter.upsert({
        where: { pollId_identityHash: { pollId: poll.id, identityHash } },
        create: {
          pollId: poll.id,
          identityHash,
          userId: exposeIdentity ? params.voter.userId : null,
          displayName: exposeIdentity ? params.voter.displayName : null,
          username: exposeIdentity ? params.voter.username : null,
          lastEventAt: params.eventAt,
          recentEventHashes,
        },
        update: {
          userId: exposeIdentity ? params.voter.userId : null,
          displayName: exposeIdentity ? params.voter.displayName : null,
          username: exposeIdentity ? params.voter.username : null,
          lastEventAt: params.eventAt,
          recentEventHashes,
        },
      });
      if (changed) {
        await tx.managedPollVote.upsert({
          where: { pollId_voterId: { pollId: poll.id, voterId: voter.id } },
          create: {
            pollId: poll.id,
            voterId: voter.id,
            optionId: params.optionId,
          },
          update: { optionId: params.optionId },
        });
        await tx.managedPoll.update({
          where: { id: poll.id },
          data: { renderRevision: { increment: 1 } },
        });
      }
      return {
        kind: 'recorded',
        changed,
        pollId: poll.id,
        needsRender: changed || needsRender,
      };
    });
  }

  private async renderPollPublication(
    chatId: string,
    pollId: string,
    action: string,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= MANAGED_POLL_RENDER_MAX_ATTEMPTS; attempt += 1) {
      const poll = await this.loadPollAggregate(chatId, pollId);
      if (!poll.publicationMessageId) {
        return true;
      }
      const retryKey = `managed-poll:render-backoff:v1:${poll.id}:${poll.publicationMessageId}`;
      if (await this.isRenderBackoffActive(retryKey)) return false;
      const entityType = this.managedEntityTypeFromPrisma(poll.chat.entityType);
      let botId: string | null | undefined = poll.publicationBotId;
      let editAttemptStartedAt: Date | null = null;
      try {
        const { text, textFormat } = this.buildAuthoredPollMessage(
          poll.question,
          poll.questionFormat,
        );
        const callbackPayloadPrefixes = buildManagedPollCallbackPayloadPrefixes(poll.id);
        botId = poll.publicationBotId ?? (await this.resolveFallbackPollBotId(chatId, entityType));
        const engagement = await this.resolvePollChannelEngagement(poll, botId ?? null);
        const engagementButtons = engagement.state === 'resolved' ? engagement.context.buttons : [];
        const options =
          poll.status === ManagedPollStatus.ACTIVE
            ? {
                ...(textFormat ? { textFormat } : {}),
                buttons: [
                  ...buildManagedPollButtons(poll.id, poll.resultOptions, poll.lockToken),
                  ...engagementButtons,
                ],
                replaceCallbackPayloadPrefixes: callbackPayloadPrefixes,
                debugContext: { screen: 'managed-poll', action },
              }
            : {
                ...(textFormat ? { textFormat } : {}),
                ...(engagementButtons.length > 0 ? { buttons: engagementButtons } : {}),
                replaceCallbackPayloadPrefixes: callbackPayloadPrefixes,
              };
        editAttemptStartedAt = new Date();
        await this.maxClient.editMessageInlineKeyboard(
          chatId,
          poll.publicationMessageId,
          text,
          options,
          {
            ...this.buildMaxOptions(
              botId,
              MANAGED_POLL_EDIT_TIMEOUT_MS,
              action === 'background-repair' ? 'background' : 'interactive',
            ),
            boundObject: { kind: 'poll', id: poll.id },
          },
        );
        editAttemptStartedAt = null;
        if (engagement.state === 'resolved' && engagement.shouldRecord) {
          await this.recordPollChannelEngagementSafely({
            chatId: poll.chatId,
            actorUserId: poll.actorUserId,
            messageId: poll.publicationMessageId,
            text: poll.question,
            publishedUrl: poll.publicationUrl,
            context: engagement.context,
            botId: botId ?? null,
            verifyApplied: true,
          });
        }
        if (engagement.state === 'inconclusive') {
          await this.recordPollRenderError(
            poll.id,
            poll.renderRevision,
            chatId,
            action,
            new Error('Не удалось подтвердить дополнительные кнопки канала.'),
          );
          if (this.shouldSchedulePollRenderRepair(action)) {
            this.schedulePollRenderRepair(chatId, poll.id);
          }
          return false;
        }
        if (await this.markPollRendered(poll.id, poll.renderRevision)) {
          return true;
        }
      } catch (error: unknown) {
        await this.verifyPollPublicationAfterEditFailure(poll, botId, entityType, error);
        await this.deferPollRender(retryKey);
        await this.recordPollRenderError(poll.id, poll.renderRevision, chatId, action, error);
        const status = (error as { response?: { status?: number } })?.response?.status;
        if (
          editAttemptStartedAt &&
          (status !== 404 || resolveExplicitMembershipAccessDenial(error)) &&
          !this.wasManagedEntityAccessLossRecorded(error)
        ) {
          await this.recordAccessLoss(
            poll,
            botId ?? null,
            'edit',
            error,
            entityType,
            editAttemptStartedAt,
          );
        }
        if (this.shouldSchedulePollRenderRepair(action)) {
          this.schedulePollRenderRepair(chatId, poll.id);
        }
        return false;
      }
    }
    if (this.shouldSchedulePollRenderRepair(action)) {
      this.schedulePollRenderRepair(chatId, pollId);
    }
    return false;
  }

  private async verifyPollPublicationAfterEditFailure(
    poll: Awaited<ReturnType<ManagedPollService['loadPollAggregate']>>,
    botId: string | null | undefined,
    entityType: ManagedEntityType,
    error: unknown,
  ): Promise<void> {
    const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
    if (
      status !== 404 ||
      !poll.publicationMessageId ||
      typeof this.maxClient.getExactMessagePresence !== 'function'
    ) {
      return;
    }

    const lookupAttemptStartedAt = new Date();
    try {
      await this.maxClient.getExactMessagePresence(poll.chatId, poll.publicationMessageId, {
        ...this.buildMaxOptions(botId, MANAGED_POLL_EDIT_TIMEOUT_MS, 'background'),
        bypassCache: true,
        ignoreFailureMetricStatuses: [404],
      });
    } catch (lookupError: unknown) {
      if (resolveExplicitMembershipAccessDenial(lookupError))
        await this.recordAccessLoss(
          poll,
          botId ?? null,
          'lookup',
          lookupError,
          entityType,
          lookupAttemptStartedAt,
        );
      this.logger.warn(
        {
          pollId: poll.id,
          chatId: poll.chatId,
          messageId: poll.publicationMessageId,
          stage: 'exact_presence',
          outcome: 'unavailable',
          ...classifyMaxSendAutoDeleteVerificationCause(lookupError),
        },
        'Failed to verify missing managed poll publication',
      );
    }
  }

  private buildCallbackMessageEdit(
    poll: Awaited<ReturnType<ManagedPollService['loadPollAggregate']>>,
    engagementButtons: MaxSendMessageOptions['buttons'] = [],
  ) {
    const { text, textFormat } = this.buildAuthoredPollMessage(poll.question, poll.questionFormat);
    return {
      text,
      ...(poll.publicationMessageId ? { messageId: poll.publicationMessageId } : {}),
      ...(poll.status === ManagedPollStatus.ACTIVE || textFormat || engagementButtons?.length
        ? {
            options: {
              ...(textFormat ? { textFormat } : {}),
              replaceCallbackPayloadPrefixes: buildManagedPollCallbackPayloadPrefixes(poll.id),
              ...(poll.status === ManagedPollStatus.ACTIVE
                ? {
                    buttons: [
                      ...buildManagedPollButtons(poll.id, poll.resultOptions, poll.lockToken),
                      ...(engagementButtons ?? []),
                    ],
                    debugContext: { screen: 'managed-poll', action: 'vote' },
                  }
                : engagementButtons?.length
                  ? { buttons: engagementButtons }
                  : {}),
            },
          }
        : {}),
    };
  }

  private async loadPollAggregate(chatId: string, pollId: string) {
    const poll = await this.findPollForHotPath(chatId, pollId);
    const counts = await this.loadVoteCounts([poll.id]);
    const result = buildManagedPollOptionResults(
      poll.options,
      new Map(
        poll.options.map((option) => [option.id, counts.get(`${poll.id}:${option.id}`) ?? 0]),
      ),
    );
    return {
      ...poll,
      totalVotes: result.totalVotes,
      resultOptions: result.options,
    };
  }

  private async readPollDetails(chatId: string, pollId: string): Promise<ManagedPollDetails> {
    const poll = await this.findPoll(chatId, pollId);
    const counts = await this.loadVoteCounts([poll.id]);
    const details = managedPollDetailsSchema.parse(this.mapPoll(poll, counts, true));
    if (
      poll.publicationMessageId &&
      !poll.lastRenderError &&
      this.pollNeedsRenderRepair(poll) &&
      details.renderRepairNeeded
    ) {
      this.schedulePollRenderRepair(chatId, poll.id);
    }
    return details;
  }

  private async findPoll(chatId: string, pollId: string): Promise<PollWithOptions> {
    const poll = await this.prisma.managedPoll.findFirst({
      where: { id: pollId, chatId },
      include: { options: { orderBy: { position: 'asc' } } },
    });
    if (!poll) {
      throw new NotFoundException('Опрос не найден.');
    }
    return poll;
  }

  private async findPollForHotPath(chatId: string, pollId: string): Promise<PollHotPathItem> {
    const poll = await this.prisma.managedPoll.findFirst({
      where: { id: pollId, chatId },
      select: MANAGED_POLL_HOT_PATH_SELECT,
    });
    if (!poll) {
      throw new NotFoundException('Опрос не найден.');
    }
    return poll;
  }

  private async loadVoteCounts(pollIds: readonly string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (pollIds.length === 0) {
      return counts;
    }
    const rows = await this.prisma.managedPollVote.groupBy({
      by: ['pollId', 'optionId'],
      where: { pollId: { in: [...pollIds] } },
      _count: { _all: true },
    });
    for (const row of rows) {
      counts.set(`${row.pollId}:${row.optionId}`, row._count._all);
    }
    return counts;
  }

  private mapPoll(
    poll: PollWithOptions | PollListItem,
    counts: ReadonlyMap<string, number>,
    includeImages = false,
  ) {
    const optionCounts = new Map(
      poll.options.map((option) => [option.id, counts.get(`${poll.id}:${option.id}`) ?? 0]),
    );
    const result = buildManagedPollOptionResults(poll.options, optionCounts);
    const publicationNeedsReview = this.publicationNeedsReview(poll);
    const images = includeImages && 'images' in poll ? this.readPollImages(poll.images) : [];
    return {
      id: poll.id,
      channelId: poll.chatId,
      question: poll.question,
      questionFormat: this.normalizeQuestionFormat(poll.questionFormat),
      status: poll.status,
      visibility: poll.visibility,
      imageCount: poll.imageCount,
      totalVotes: result.totalVotes,
      options: result.options,
      ...(includeImages ? { images } : {}),
      publicationMessageId: poll.publicationMessageId,
      publicationUrl: poll.publicationUrl,
      publicationPending: Boolean(poll.lockedAt) && !publicationNeedsReview,
      publicationNeedsReview,
      renderRepairNeeded: this.pollNeedsRenderRepair(poll),
      publishedAt: poll.publishedAt?.toISOString() ?? null,
      closedAt: poll.closedAt?.toISOString() ?? null,
      createdAt: poll.createdAt.toISOString(),
      updatedAt: poll.updatedAt.toISOString(),
      lastError: poll.lastError,
      lastRenderError: poll.lastRenderError,
    };
  }

  private normalizeQuestionFormat(value: unknown): ManagedPollQuestionFormat {
    return value === 'markdown' ? 'markdown' : 'plain';
  }

  private resolveQuestionTextFormat(
    questionFormat: unknown,
  ): MaxSendMessageOptions['textFormat'] | undefined {
    return this.normalizeQuestionFormat(questionFormat) === 'markdown' ? 'html' : undefined;
  }

  private assertManagedPollQuestionFitsMax(
    question: string,
    questionFormat: ManagedPollQuestionFormat,
  ): void {
    this.buildAuthoredPollMessage(question, questionFormat);
  }

  private buildAuthoredPollMessage(
    question: string,
    questionFormat: unknown,
  ): Pick<MaxSendMessageOptions, 'textFormat'> & { text: string } {
    const normalizedQuestionFormat = this.normalizeQuestionFormat(questionFormat);
    if (
      normalizedQuestionFormat === 'markdown' &&
      !stripSupportedMarkdownToPlainText(question).trim()
    ) {
      throw new BadRequestException('Введите вопрос.');
    }
    const text = buildManagedPollMessageText({
      question,
      questionFormat: normalizedQuestionFormat,
    });
    this.assertManagedPollMessageFitsMax(text);
    const textFormat = this.resolveQuestionTextFormat(normalizedQuestionFormat);
    return { text, ...(textFormat ? { textFormat } : {}) };
  }

  private assertManagedPollMessageFitsMax(text: string): void {
    if (text.length > MANAGED_POLL_MESSAGE_MAX_LENGTH) {
      throw new BadRequestException(
        `Вопрос после форматирования слишком длинный. Максимум ${MANAGED_POLL_MESSAGE_MAX_LENGTH} символов сообщения.`,
      );
    }
  }

  private async isRenderBackoffActive(key: string): Promise<boolean> {
    if ((this.renderRetryUntil.get(key) ?? 0) > Date.now()) return true;
    this.renderRetryUntil.delete(key);
    try {
      return Number(await this.redisCounter?.getString(key)) > Date.now();
    } catch {
      return false;
    }
  }

  private async deferPollRender(key: string): Promise<void> {
    const until = Date.now() + MANAGED_POLL_BACKGROUND_RETRY_DELAY_MS;
    // FLAG: A read/edit failure is unknown, not proof of deletion or lost bot rights.
    // Cooldown survives another replica; SQL still owns repair and exact presence proof.
    this.renderRetryUntil.set(key, until);
    if (this.renderRetryUntil.size > 2048)
      this.renderRetryUntil.delete(this.renderRetryUntil.keys().next().value!);
    try {
      await this.redisCounter?.setStringWithTtl(
        key,
        String(until),
        MANAGED_POLL_BACKGROUND_RETRY_DELAY_MS / 1000,
      );
    } catch {
      /* Local bounded cooldown remains useful during Redis outages. */
    }
  }

  private async recordPollRenderError(
    pollId: string,
    renderRevision: number,
    chatId: string,
    action: string,
    error: unknown,
  ): Promise<void> {
    const message = extractMaxApiErrorMessage(error) || this.formatError(error);
    await this.prisma.managedPoll.updateMany({
      where: { id: pollId, renderRevision },
      data: { lastRenderError: message },
    });
    this.logger.warn(
      {
        pollId,
        chatId,
        action,
        stage: 'render',
        ...classifyMaxSendAutoDeleteVerificationCause(error),
      },
      'Failed to render managed poll publication',
    );
  }

  private readPollImages(value: unknown): ManagedPollImage[] {
    const parsed = managedPollImagesSchema.safeParse(value);
    return parsed.success ? parsed.data : [];
  }

  private async resolvePollPublicationMedia(
    images: readonly ManagedPollImage[],
    botId: string | null | undefined,
  ): Promise<PollPublicationMedia> {
    const preparedImages = images.map((image) => ({
      image,
      mimeType: image.mimeType.trim().toLowerCase(),
      buffer: this.validatePollImage(image),
    }));
    const totalBytes = preparedImages.reduce((total, image) => total + image.buffer.length, 0);
    if (totalBytes > BROADCAST_IMAGES_TOTAL_MAX_BYTES) {
      throw new BadRequestException('Суммарный размер фото слишком большой.');
    }

    const payloads: Record<string, unknown>[] = [];
    for (const prepared of preparedImages) {
      payloads.push(
        await this.uploadPollImage(prepared.image, prepared.buffer, prepared.mimeType, botId),
      );
    }

    if (payloads.length === 1) {
      return { imagePayload: payloads[0] };
    }
    if (payloads.length > 1) {
      return {
        attachments: payloads.map((payload): MaxAttachmentPayload => ({ type: 'image', payload })),
      };
    }
    return {};
  }

  private validatePollImage(image: ManagedPollImage): Buffer {
    const mimeType = image.mimeType.trim().toLowerCase();
    if (!mimeType.startsWith('image/')) {
      throw new BadRequestException('Поддерживаются только изображения.');
    }

    let buffer: Buffer;
    try {
      buffer = decodeBroadcastImageBase64(image.base64);
    } catch {
      throw new BadRequestException('Не удалось прочитать фото.');
    }
    if (buffer.length > BROADCAST_IMAGE_MAX_BYTES) {
      throw new BadRequestException('Фото слишком большое. Попробуйте другое изображение.');
    }
    return buffer;
  }

  private async uploadPollImage(
    image: ManagedPollImage,
    buffer: Buffer,
    mimeType: string,
    botId: string | null | undefined,
  ): Promise<Record<string, unknown>> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.maxClient.uploadImage(
          buffer,
          resolveBroadcastImageFileName(image.fileName, mimeType),
          mimeType,
          this.buildMaxOptions(botId, MANAGED_POLL_UPLOAD_TIMEOUT_MS),
        );
      } catch (error: unknown) {
        const retryDelayMs = resolveManagedBroadcastUploadRetryDelayMs(error, attempt);
        if (retryDelayMs === null) {
          throw error;
        }
        await this.delay(retryDelayMs);
      }
    }
  }

  private async sendPollPublicationWithRetry(
    chatId: string,
    pollId: string,
    renderRevision: number,
    publicationToken: string,
    text: string,
    options: MaxSendMessageOptions,
    images: readonly ManagedPollImage[],
    botId: string | null | undefined,
    onAttemptBotId?: (botId: string) => void | Promise<void>,
    prepareAttemptOptions?: (botId: string) => Promise<PollPublicationAttemptOptions>,
  ): Promise<MaxRoutedPublicationResult> {
    if (!this.maxRoutedPublicationService && process.env.NODE_ENV === 'production') {
      throw new ServiceUnavailableException(
        'Routed MAX publication service is required for production managed polls',
      );
    }
    const fallbackMedia = this.maxRoutedPublicationService
      ? null
      : await this.resolvePollPublicationMedia(images, botId);
    for (let attempt = 1; ; attempt += 1) {
      try {
        if (this.maxRoutedPublicationService) {
          return await this.maxRoutedPublicationService.publish({
            entityId: chatId,
            logicalIdempotencyKey: this.buildPollPublicationActionKey(
              pollId,
              renderRevision,
              publicationToken,
            ),
            routePurpose: 'channel_poll',
            text,
            options,
            trafficClass: 'interactive',
            sourceTag: MAX_API_SOURCE_TAGS.MANAGED_POLL,
            timeoutMs: MANAGED_POLL_SEND_TIMEOUT_MS,
            prepareAttempt: async ({ botId: routedBotId }) => {
              const prepared = prepareAttemptOptions
                ? await prepareAttemptOptions(routedBotId)
                : { options, engagementContext: null };
              return {
                options: {
                  ...prepared.options,
                  ...(await this.resolvePollPublicationMedia(images, routedBotId)),
                },
                ledgerContext: buildManagedPollLedgerContext(
                  prepared.engagementContext,
                  routedBotId,
                  MANAGED_POLL_RENDER_FORMAT_VERSION,
                ),
              };
            },
            onDispatchAttempt: async ({ botId: routedBotId }) => {
              await onAttemptBotId?.(routedBotId);
            },
          });
        }

        const resolvedBotId = botId?.trim() ?? '';
        if (!resolvedBotId) {
          throw new Error('No bot with send/edit access is available for managed poll publish');
        }
        const prepared = prepareAttemptOptions
          ? await prepareAttemptOptions(resolvedBotId)
          : { options, engagementContext: null };
        await onAttemptBotId?.(resolvedBotId);
        const published = await this.maxClient.sendMessageImmediateWithResolvedLink(
          chatId,
          text,
          {
            ...prepared.options,
            ...(fallbackMedia ?? {}),
          },
          this.buildMaxOptions(resolvedBotId, MANAGED_POLL_SEND_TIMEOUT_MS),
        );
        return {
          ...published,
          botId: resolvedBotId,
          candidateBotIds: [resolvedBotId],
          routingVersion: null,
        };
      } catch (error: unknown) {
        if (isAmbiguousMaxSendError(error)) {
          throw error;
        }
        const retryDelayMs = resolveManagedBroadcastSendRetryDelayMs(error, attempt, options);
        if (retryDelayMs === null) {
          throw error;
        }
        await this.delay(retryDelayMs);
      }
    }
  }

  private buildPollPublicationActionKey(
    pollId: string,
    renderRevision: number,
    publicationToken?: string | null,
  ): string {
    const normalizedPublicationToken = publicationToken?.trim();
    if (normalizedPublicationToken) {
      return `managed-poll:publish:${pollId}:attempt:${normalizedPublicationToken}:revision:${renderRevision}:format:${MANAGED_POLL_SEND_IDEMPOTENCY_VERSION}`;
    }
    return `managed-poll:publish:${pollId}:revision:${renderRevision}:format:${MANAGED_POLL_SEND_IDEMPOTENCY_VERSION}`;
  }

  private async loadManagedPollLedgerChannelEngagement(
    jobId: string,
    chatId: string,
    fallbackBotId: string | null,
  ): Promise<{
    found: boolean;
    context: ChannelPublicationEngagementContext | null;
    renderFormatVersion: number | null;
  }> {
    if (typeof this.prisma.maxActionLedgerEntry?.findUnique !== 'function') {
      return { found: false, context: null, renderFormatVersion: null };
    }
    const ledger = await this.prisma.maxActionLedgerEntry.findUnique({
      where: { jobId },
      select: { metadata: true },
    });
    const recovered = readManagedPollLedgerChannelEngagement(ledger?.metadata ?? null);
    if (!recovered.found || !recovered.reference) {
      return {
        found: recovered.found,
        context: null,
        renderFormatVersion: recovered.renderFormatVersion,
      };
    }
    return {
      found: true,
      context: await this.restorePollChannelEngagementContext(
        chatId,
        recovered.reference,
        recovered.reference.botId ?? fallbackBotId,
      ),
      renderFormatVersion: recovered.renderFormatVersion,
    };
  }

  private async resolvePollChannelEngagement(
    poll: Awaited<ReturnType<ManagedPollService['loadPollAggregate']>>,
    botId: string | null,
  ): Promise<PollChannelEngagementResolution> {
    if (
      this.managedEntityTypeFromPrisma(poll.chat.entityType) !== 'channel' ||
      !poll.publicationMessageId
    ) {
      return { state: 'none' };
    }

    if (typeof this.prisma.auditLog?.findFirst === 'function') {
      const binding = await this.prisma.auditLog.findFirst({
        where: {
          chatId: poll.chatId,
          action: CHANNEL_DIALOG_ACTION_AUTO_ATTACH,
          payload: {
            path: ['messageId'],
            equals: poll.publicationMessageId,
          },
        },
        orderBy: { createdAt: 'desc' },
        select: { payload: true },
      });
      if (binding) {
        const payload = this.asRecord(binding.payload);
        const reference = readManagedPollChannelEngagementReference(payload);
        if (reference && payload?.source === 'managed_poll') {
          return {
            state: 'resolved',
            context: await this.restorePollChannelEngagementContext(
              poll.chatId,
              reference,
              reference.botId ?? botId,
            ),
            shouldRecord: false,
          };
        }

        const exactLookup = await this.lookupExactPollChannelEngagement({
          pollId: poll.id,
          chatId: poll.chatId,
          messageId: poll.publicationMessageId,
          botId: reference?.botId ?? botId,
        });
        if (exactLookup.state === 'inconclusive') {
          return { state: 'inconclusive' };
        }
        if (exactLookup.state === 'absent') {
          return { state: 'none' };
        }
        const exactEngagement = await this.resolveExactPollChannelEngagement(
          poll,
          botId,
          exactLookup.identities,
          reference,
        );
        if (exactEngagement) {
          return exactEngagement;
        }
        return this.resolveConfiguredPollChannelEngagement(poll.chatId, botId);
      }
    }

    const publicationRevisions = Array.from(
      new Set(
        [poll.renderRevision, poll.renderedRevision, poll.renderRevision - 1].filter(
          (revision) => Number.isInteger(revision) && revision >= 0,
        ),
      ),
    );
    for (const publicationRevision of publicationRevisions) {
      const recovered = await this.loadManagedPollLedgerChannelEngagement(
        this.buildPollPublicationActionKey(poll.id, publicationRevision, poll.lockToken),
        poll.chatId,
        botId,
      );
      if (recovered.found) {
        return recovered.context
          ? { state: 'resolved', context: recovered.context, shouldRecord: true }
          : { state: 'none' };
      }
    }

    const exactLookup = await this.lookupExactPollChannelEngagement({
      pollId: poll.id,
      chatId: poll.chatId,
      messageId: poll.publicationMessageId,
      botId,
    });
    if (exactLookup.state === 'inconclusive') {
      return { state: 'inconclusive' };
    }
    if (exactLookup.state === 'absent') {
      return { state: 'none' };
    }
    const exactEngagement = await this.resolveExactPollChannelEngagement(
      poll,
      botId,
      exactLookup.identities,
      null,
    );
    if (exactEngagement) {
      return exactEngagement;
    }
    return this.resolveConfiguredPollChannelEngagement(poll.chatId, botId);
  }

  private async resolveConfiguredPollChannelEngagement(
    chatId: string,
    botId: string | null,
  ): Promise<PollChannelEngagementResolution> {
    if (typeof this.adminService.buildChannelPublicationEngagementContext !== 'function') {
      return { state: 'none' };
    }
    const context = await this.adminService.buildChannelPublicationEngagementContext(chatId, botId);
    return {
      state: 'resolved',
      context,
      shouldRecord: Boolean(
        context.threadId && (context.includeCommentsButton || context.includeSuggestButton),
      ),
    };
  }

  private async resolveExactPollChannelEngagement(
    poll: Awaited<ReturnType<ManagedPollService['loadPollAggregate']>>,
    botId: string | null,
    identities: readonly InternalChannelDialogButtonIdentity[],
    legacyReference: ManagedPollChannelEngagementReference | null,
  ): Promise<PollChannelEngagementResolution | null> {
    if (
      legacyReference &&
      this.hasExactPollChannelEngagement(
        identities,
        poll.chatId,
        legacyReference.threadId,
        legacyReference.includeCommentsButton,
        legacyReference.includeSuggestButton,
      )
    ) {
      return {
        state: 'resolved',
        context: await this.restorePollChannelEngagementContext(
          poll.chatId,
          legacyReference,
          legacyReference.botId ?? botId,
        ),
        shouldRecord: true,
      };
    }

    const threadId =
      identities.find((identity) => identity.chatId === poll.chatId && identity.threadId)
        ?.threadId ?? null;
    if (!threadId) {
      return null;
    }
    const matching = identities.filter(
      (identity) => identity.chatId === poll.chatId && identity.threadId === threadId,
    );
    const configured =
      typeof this.adminService.buildChannelPublicationEngagementContext === 'function'
        ? await this.adminService.buildChannelPublicationEngagementContext(poll.chatId, botId)
        : null;
    const reference: ManagedPollChannelEngagementReference = {
      threadId,
      includeCommentsButton:
        matching.some((identity) => identity.kind === 'comments') ||
        configured?.includeCommentsButton === true,
      includeSuggestButton:
        matching.some((identity) => identity.kind === 'suggest') ||
        configured?.includeSuggestButton === true,
      suggestButtonText: configured?.suggestButtonText ?? null,
      suggestionEntryMode: configured?.suggestionEntryMode ?? 'BOT',
      botId,
    };
    return {
      state: 'resolved',
      context: await this.restorePollChannelEngagementContext(poll.chatId, reference, botId),
      shouldRecord: true,
    };
  }

  private async restorePollChannelEngagementContext(
    chatId: string,
    reference: ManagedPollChannelEngagementReference,
    botId: string | null,
  ): Promise<ChannelPublicationEngagementContext> {
    if (!this.adminDialogLinkService) {
      throw new ServiceUnavailableException('Channel dialog link service is unavailable');
    }
    const commentsCount =
      reference.includeCommentsButton && typeof this.prisma.auditLog?.count === 'function'
        ? await this.prisma.auditLog.count({
            where: {
              chatId,
              action: CHANNEL_DIALOG_ACTION_COMMENT,
              payload: {
                path: ['threadId'],
                equals: reference.threadId,
              },
            },
          })
        : 0;
    const buttons: NonNullable<MaxSendMessageOptions['buttons']> = [];
    if (reference.includeCommentsButton) {
      buttons.push([
        this.adminDialogLinkService.buildChannelDialogButton(
          chatId,
          'comments',
          reference.threadId,
          formatCommentsButtonText('💬 Комментарии', commentsCount),
          botId,
        ),
      ]);
    }
    if (reference.includeSuggestButton) {
      buttons.push([
        this.adminDialogLinkService.buildChannelDialogButton(
          chatId,
          'suggest',
          reference.threadId,
          reference.suggestButtonText?.trim() || '📰 Предложить пост',
          botId,
          reference.suggestionEntryMode,
        ),
      ]);
    }
    return {
      buttons,
      threadId: reference.threadId,
      includeCommentsButton: reference.includeCommentsButton,
      includeSuggestButton: reference.includeSuggestButton,
      suggestButtonText: reference.suggestButtonText,
      suggestionEntryMode: reference.suggestionEntryMode,
    };
  }

  private async recordPollChannelEngagementSafely(params: {
    chatId: string;
    actorUserId: string;
    messageId: string;
    text: string;
    publishedUrl: string | null;
    context: ChannelPublicationEngagementContext;
    botId: string | null;
    verifyApplied?: boolean;
  }): Promise<void> {
    if (typeof this.adminService.recordChannelPublicationEngagement !== 'function') {
      return;
    }
    try {
      if (params.verifyApplied && !(await this.isPollChannelEngagementApplied(params))) {
        return;
      }
      await this.adminService.recordChannelPublicationEngagement({
        chatId: params.chatId,
        actorUserId: params.actorUserId,
        messageId: params.messageId,
        text: params.text,
        publishedUrl: params.publishedUrl,
        context: params.context,
        source: 'managed_poll',
        botId: params.botId,
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: params.chatId,
          messageId: params.messageId,
          botId: params.botId,
          err: this.formatError(error),
        },
        'Failed to record managed poll channel engagement binding',
      );
    }
  }

  private async isPollChannelEngagementApplied(params: {
    chatId: string;
    messageId: string;
    context: ChannelPublicationEngagementContext;
    botId: string | null;
  }): Promise<boolean> {
    const exactLookup = await this.lookupExactPollChannelEngagement(params);
    return (
      exactLookup.state === 'resolved' &&
      Boolean(params.context.threadId) &&
      this.hasExactPollChannelEngagement(
        exactLookup.identities,
        params.chatId,
        params.context.threadId ?? '',
        params.context.includeCommentsButton,
        params.context.includeSuggestButton,
      )
    );
  }

  private async lookupExactPollChannelEngagement(params: {
    pollId?: string;
    chatId: string;
    messageId: string;
    botId: string | null;
  }): Promise<PollChannelEngagementExactLookup> {
    if (typeof this.maxClient.getExactChannelDialogButtonIdentities !== 'function') {
      return { state: 'inconclusive' };
    }
    try {
      const identities = await this.maxClient.getExactChannelDialogButtonIdentities(
        params.chatId,
        params.messageId,
        this.buildMaxOptions(params.botId, MANAGED_POLL_EDIT_TIMEOUT_MS, 'background'),
      );
      return identities === null ? { state: 'absent' } : { state: 'resolved', identities };
    } catch (error: unknown) {
      this.logger.debug(
        {
          ...(params.pollId ? { pollId: params.pollId } : {}),
          chatId: params.chatId,
          messageId: params.messageId,
          err: this.formatError(error),
        },
        'Managed poll engagement lookup was inconclusive',
      );
      return { state: 'inconclusive' };
    }
  }

  private hasExactPollChannelEngagement(
    identities: readonly InternalChannelDialogButtonIdentity[],
    chatId: string,
    threadId: string,
    includeCommentsButton: boolean,
    includeSuggestButton: boolean,
  ): boolean {
    const expectedKinds = [
      ...(includeCommentsButton ? (['comments'] as const) : []),
      ...(includeSuggestButton ? (['suggest'] as const) : []),
    ];
    return (
      Boolean(threadId.trim()) &&
      expectedKinds.length > 0 &&
      expectedKinds.every((kind) =>
        identities.some(
          (identity) =>
            identity.chatId === chatId && identity.kind === kind && identity.threadId === threadId,
        ),
      )
    );
  }

  private startPublicationClaimHeartbeat(
    pollId: string,
    lockToken: string,
  ): {
    renew: () => Promise<boolean>;
    stop: () => Promise<boolean>;
  } {
    let stopped = false;
    let claimStillOwned = true;
    let refreshChain = Promise.resolve();
    const renew = (): Promise<boolean> => {
      if (stopped || !claimStillOwned) {
        return Promise.resolve(claimStillOwned);
      }
      refreshChain = refreshChain
        .then(async () => {
          if (!claimStillOwned) {
            return;
          }
          const refreshed = await this.prisma.managedPoll.updateMany({
            where: {
              id: pollId,
              lockToken,
              status: ManagedPollStatus.DRAFT,
            },
            data: { lockedAt: new Date() },
          });
          if (refreshed.count === 0) {
            claimStillOwned = false;
            this.logger.warn(
              { pollId },
              'Managed poll publication claim was lost while media was being prepared',
            );
          }
        })
        .catch((error: unknown) => {
          claimStillOwned = false;
          this.logger.warn(
            { pollId, err: this.formatError(error) },
            'Managed poll publication claim could not be renewed',
          );
        });
      return refreshChain.then(() => claimStillOwned);
    };
    const timer = setInterval(() => {
      void renew();
    }, MANAGED_POLL_PUBLICATION_CLAIM_HEARTBEAT_MS);
    timer.unref?.();

    return {
      renew,
      stop: async () => {
        if (!stopped) {
          stopped = true;
          clearInterval(timer);
        }
        await refreshChain;
        return claimStillOwned;
      },
    };
  }

  private async lockPollRow(tx: Prisma.TransactionClient, pollId: string): Promise<void> {
    await tx.$queryRaw`SELECT "id" FROM "managed_polls" WHERE "id" = ${pollId} FOR UPDATE`;
  }

  private buildIdentityHash(identitySalt: string, userId: string): string {
    return createHmac('sha256', identitySalt).update(userId).digest('hex');
  }

  private buildVoteEventHash(identitySalt: string, eventId: string): string {
    return createHmac('sha256', identitySalt).update(`event:${eventId}`).digest('hex');
  }

  private appendRecentEventHash(existing: readonly string[], eventHash: string): string[] {
    return [eventHash, ...existing.filter((value) => value !== eventHash)].slice(
      0,
      MANAGED_POLL_RECENT_EVENT_HASH_LIMIT,
    );
  }

  private buildCallbackEventId(update: MaxUpdate, callbackId: string | null): string {
    const fallbackDigest = createHash('sha256')
      .update(JSON.stringify(update.raw ?? update))
      .digest('hex');
    const updateId =
      this.readString(update.updateId) ?? callbackId ?? `synthetic:${fallbackDigest}`;
    const botId = this.readString(update.botId) ?? 'default';
    const scopedId = `${botId}:${updateId}`;
    return scopedId.length <= 256
      ? scopedId
      : `sha256:${createHash('sha256').update(scopedId).digest('hex')}`;
  }

  private extractCallbackOccurredAt(
    update: MaxUpdate,
    callback: Record<string, unknown> | null,
  ): Date {
    const raw = this.asRecord(update.raw);
    const data = this.asRecord(raw?.data);
    const event = this.asRecord(raw?.event);
    const candidates = [
      callback?.timestamp,
      callback?.created_at,
      callback?.createdAt,
      raw?.timestamp,
      raw?.created_at,
      raw?.createdAt,
      data?.timestamp,
      event?.timestamp,
    ];
    for (const candidate of candidates) {
      const parsed = this.parseCallbackDate(candidate);
      if (parsed) {
        return parsed;
      }
    }
    return new Date();
  }

  private parseCallbackDate(value: unknown): Date | null {
    if (value instanceof Date && Number.isFinite(value.getTime())) {
      return value;
    }
    if (typeof value === 'string' && value.trim() && !/^\d+(?:\.\d+)?$/u.test(value.trim())) {
      const parsed = new Date(value);
      return Number.isFinite(parsed.getTime()) ? parsed : null;
    }
    const numeric =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim()
          ? Number(value)
          : Number.NaN;
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return null;
    }
    const timestampMs = numeric < 100_000_000_000 ? numeric * 1_000 : numeric;
    const parsed = new Date(timestampMs);
    return Number.isFinite(parsed.getTime()) ? parsed : null;
  }

  private publicationNeedsReview(
    poll: Pick<ManagedPoll, 'status' | 'lockedAt' | 'lastError'>,
  ): boolean {
    if (poll.status !== ManagedPollStatus.DRAFT || !poll.lockedAt) {
      return false;
    }
    return (
      poll.lastError === MANAGED_POLL_AMBIGUOUS_PUBLICATION_ERROR ||
      Date.now() - poll.lockedAt.getTime() >= MANAGED_POLL_PUBLICATION_CLAIM_TTL_MS
    );
  }

  private buildMaxOptions(
    botId: string | null | undefined,
    timeoutMs: number,
    trafficClass: MaxApiTrafficClass = 'interactive',
  ) {
    return {
      ...(botId?.trim() ? { botId: botId.trim() } : {}),
      trafficClass,
      actionHealthLane:
        trafficClass === 'background' ? ('background' as const) : ('interactive' as const),
      sourceTag: MAX_API_SOURCE_TAGS.MANAGED_POLL,
      timeoutMs,
    };
  }

  private shouldSchedulePollRenderRepair(action: string): boolean {
    return action !== 'coalesced-repair' && action !== 'background-repair';
  }

  private async answerCallback(
    callbackId: string | null,
    notification: string,
    botId?: string | null,
    rateLimitEntityId?: string | null,
  ): Promise<void> {
    if (!callbackId) {
      return;
    }
    try {
      await this.maxClient.answerCallback(callbackId, notification, undefined, {
        ...this.buildMaxOptions(botId, MANAGED_POLL_EDIT_TIMEOUT_MS),
        trafficClass: 'critical',
        ...(rateLimitEntityId?.trim() ? { rateLimitEntityId: rateLimitEntityId.trim() } : {}),
      });
    } catch (error: unknown) {
      this.logger.debug(
        { callbackId, err: this.formatError(error) },
        'Failed to answer managed poll callback',
      );
    }
  }

  private async markPollRendered(pollId: string, renderRevision: number): Promise<boolean> {
    const updated = await this.prisma.managedPoll.updateMany({
      where: { id: pollId, renderRevision },
      data: {
        renderedRevision: renderRevision,
        renderFormatVersion: MANAGED_POLL_RENDER_FORMAT_VERSION,
        lastRenderError: null,
      },
    });
    return updated.count > 0;
  }

  private pollNeedsRenderRepair(
    poll: Pick<
      ManagedPoll,
      | 'lastRenderError'
      | 'publicationMessageId'
      | 'renderedRevision'
      | 'renderRevision'
      | 'renderFormatVersion'
    >,
  ): boolean {
    return (
      Boolean(poll.publicationMessageId) &&
      (Boolean(poll.lastRenderError) ||
        poll.renderedRevision < poll.renderRevision ||
        poll.renderFormatVersion < MANAGED_POLL_RENDER_FORMAT_VERSION)
    );
  }

  private async runPollRenderSerialized(
    pollId: string,
    operation: () => Promise<unknown>,
  ): Promise<boolean> {
    if (this.redisCounter) {
      const key = `managed-poll:render:v1:${pollId}`;
      let token: string | null = null;
      try {
        const deadline = Date.now() + MANAGED_POLL_RENDER_LOCK_WAIT_MS;
        do {
          token = await this.redisCounter.acquireLock(key, MANAGED_POLL_RENDER_LOCK_TTL_MS);
          if (token) {
            break;
          }
          await this.delay(50);
        } while (Date.now() < deadline);
      } catch (error: unknown) {
        this.logger.warn(
          { pollId, err: this.formatError(error) },
          'Managed poll Redis render lock failed; deferring publication repair',
        );
        return false;
      }

      if (!token) {
        this.logger.debug({ pollId }, 'Managed poll render lock wait timed out');
        return false;
      }
      let lockHealthy = true;
      let renewalChain = Promise.resolve();
      const renewLock = this.redisCounter.renewLock?.bind(this.redisCounter);
      const heartbeat = renewLock
        ? setInterval(() => {
            renewalChain = renewalChain
              .then(async () => {
                if (!(await renewLock(key, token, MANAGED_POLL_RENDER_LOCK_TTL_MS))) {
                  lockHealthy = false;
                }
              })
              .catch((error: unknown) => {
                lockHealthy = false;
                this.logger.warn(
                  { pollId, err: this.formatError(error) },
                  'Managed poll Redis render lock renewal failed',
                );
              });
          }, MANAGED_POLL_RENDER_LOCK_HEARTBEAT_MS)
        : null;
      heartbeat?.unref?.();
      try {
        await operation();
        await renewalChain;
        return lockHealthy;
      } finally {
        if (heartbeat) {
          clearInterval(heartbeat);
        }
        await renewalChain.catch(() => undefined);
        await this.redisCounter.releaseLock(key, token).catch(() => undefined);
      }
    }

    return this.runPollRenderLocally(pollId, operation);
  }

  private schedulePollRenderRepair(chatId: string, pollId: string): void {
    if (this.scheduledRenderRepairs.has(pollId)) {
      return;
    }

    const repair = (async () => {
      for (let attempt = 0; attempt < MANAGED_POLL_RENDER_REPAIR_ATTEMPTS; attempt += 1) {
        await this.delay(MANAGED_POLL_RENDER_REPAIR_DELAY_MS * (attempt + 1));
        let renderSucceeded = false;
        const serialized = await this.runPollRenderSerialized(pollId, async () => {
          renderSucceeded = await this.renderPollPublication(chatId, pollId, 'coalesced-repair');
        });
        if (serialized && renderSucceeded) {
          return;
        }
      }
    })()
      .catch((error: unknown) => {
        this.logger.warn(
          { pollId, chatId, err: this.formatError(error) },
          'Managed poll coalesced render repair failed',
        );
      })
      .finally(() => {
        if (this.scheduledRenderRepairs.get(pollId) === repair) {
          this.scheduledRenderRepairs.delete(pollId);
        }
      });
    this.scheduledRenderRepairs.set(pollId, repair);
  }

  private async runPollRenderLocally(
    pollId: string,
    operation: () => Promise<unknown>,
  ): Promise<boolean> {
    const previous = this.localRenderChains.get(pollId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = previous.catch(() => undefined).then(() => current);
    this.localRenderChains.set(pollId, chain);
    await previous.catch(() => undefined);
    try {
      await operation();
      return true;
    } finally {
      release();
      if (this.localRenderChains.get(pollId) === chain) {
        this.localRenderChains.delete(pollId);
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private extractCallbackNode(update: MaxUpdate): Record<string, unknown> | null {
    const raw = this.asRecord(update.raw);
    const data = this.asRecord(raw?.data);
    const event = this.asRecord(raw?.event);
    const candidates = [
      this.asRecord(raw?.callback),
      this.asRecord(raw?.message_callback),
      this.asRecord(data?.callback),
      this.asRecord(data?.message_callback),
      this.asRecord(event?.callback),
      this.asRecord(event?.message_callback),
    ];
    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }
      const nested = this.asRecord(candidate.callback);
      if (nested) {
        return nested;
      }
      if (candidate.payload !== undefined || candidate.callback_id !== undefined) {
        return candidate;
      }
    }
    return null;
  }

  private extractCallbackUser(callback: Record<string, unknown> | null): PollCallbackUser | null {
    const user = this.asRecord(callback?.user);
    const userId = this.readString(user?.user_id ?? user?.userId ?? user?.id);
    if (!userId) {
      return null;
    }
    const directName = this.readString(
      user?.display_name ?? user?.displayName ?? user?.name ?? user?.full_name ?? user?.fullName,
    );
    const firstName = this.readString(user?.first_name ?? user?.firstName);
    const lastName = this.readString(user?.last_name ?? user?.lastName);
    return {
      userId,
      displayName: directName ?? ([firstName, lastName].filter(Boolean).join(' ').trim() || null),
      username: this.readString(user?.username),
    };
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private readString(value: unknown): string | null {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return null;
    }
    const normalized = String(value).trim();
    return normalized || null;
  }

  private pollEntityAuditLabel(entityType: ManagedEntityType): 'CHAT' | 'CHANNEL' {
    return entityType === 'channel' ? 'CHANNEL' : 'CHAT';
  }

  private pollEntityName(entityType: ManagedEntityType): 'чат' | 'канал' {
    return entityType === 'channel' ? 'канал' : 'чат';
  }

  private managedEntityTypeFromPrisma(entityType: ChatEntityType): ManagedEntityType {
    return entityType === ChatEntityType.CHANNEL ? 'channel' : 'chat';
  }

  private async resolveFallbackPollBotId(
    chatId: string,
    entityType: ManagedEntityType,
  ): Promise<string | undefined> {
    return entityType === 'channel'
      ? this.adminService.resolveChannelPollBotId(chatId)
      : this.adminService.resolveChatPollBotId(chatId);
  }

  private formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private isTerminalCallbackError(error: unknown): boolean {
    const status = (error as { response?: { status?: unknown } } | null)?.response?.status;
    if (status === 400 || status === 404) {
      return true;
    }
    const data = (error as { response?: { data?: unknown } } | null)?.response?.data;
    const normalized = JSON.stringify(data ?? this.formatError(error)).toLowerCase();
    return (
      normalized.includes('callback.not.found') ||
      normalized.includes('message_callback.not_found') ||
      (normalized.includes('callback') && normalized.includes('not found'))
    );
  }

  private async recordAccessLoss(
    poll: Pick<ManagedPoll, 'id' | 'chatId'>,
    botId: string | null,
    operation: 'send' | 'edit' | 'lookup',
    error: unknown,
    entityType: ManagedEntityType,
    lifecycleEventAt: Date,
  ): Promise<void> {
    try {
      await this.managedEntityAccessLossService?.recordIfManagedEntityAccessLost({
        chatId: poll.chatId,
        botId,
        entityType: entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT,
        source: `managed_poll:${operation}`,
        operation: operation === 'lookup' ? 'message_lookup' : operation,
        error,
        lifecycleEventAt,
        lifecycleEventType: 'live_probe',
        lifecycleSource: 'live_probe',
      });
    } catch (accessLossError: unknown) {
      this.logger.debug(
        { pollId: poll.id, err: this.formatError(accessLossError) },
        'Failed to record managed poll access loss',
      );
    }
  }

  private wasManagedEntityAccessLossRecorded(error: unknown): boolean {
    return (
      Boolean(error) &&
      typeof error === 'object' &&
      (error as { maxManagedEntityAccessLossRecorded?: unknown })
        .maxManagedEntityAccessLossRecorded === true
    );
  }
}
