import type { SuggestionReviewWrite } from '@maxim/contracts/publisher';
import {
  assertSuggestionPublicationLength,
  suggestionContentPatch,
  suggestionRevision,
  hasSuggestionRequest,
  suggestionRequestPatch,
  publicationEditorInput,
} from './suggestion-review-content';
import { SuggestionSubscriptionService } from '../suggestions/suggestion-subscription.service';
import {
  publisherSuggestionSchema,
  publisherSuggestionsQuerySchema,
  publisherSuggestionsResponseSchema,
  reviewPublisherSuggestionRequestSchema,
  reviewPublisherSuggestionResponseSchema,
  type PublisherSuggestion,
  type PublisherSuggestionsResponse,
  type ReviewPublisherSuggestionRequest,
  type ReviewPublisherSuggestionResponse,
} from '@maxim/contracts/publisher';
import type { PublicationMediaInput } from '@maxim/contracts/publication';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { PublicationDispatchProfile, Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherDialogLinkService } from '../publisher/publisher-dialog-link.service';
import { PublisherSuggestionAdminQueueService } from '../publisher/publisher-suggestion-admin.queue';
import {
  loadStoredChannelSuggestionImages,
  readLegacyChannelSuggestionImages,
} from './admin-channel-suggestion-image-storage';
import { PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST } from './admin.service.support';
import type { ChannelSuggestionImageAsset } from './admin.service.support';
import { PublicationService } from './publication.service';
import { PublisherPolicyService } from './publisher-policy.service';
import { PublisherSuggestionPublicationQueueService } from './publisher-suggestion-publication-queue.service';
import { buildPublisherSuggestionPublicationText } from './publisher-suggestion-content';
import {
  buildPublisherSuggestionPublicationRequestId,
  isPublisherSuggestionReviewProtocol,
  PUBLISHER_SUGGESTION_DISPATCH_PROFILE,
  PUBLISHER_SUGGESTION_LEGACY_INLINE_STALE_MS,
  PUBLISHER_SUGGESTION_REVIEW_PROTOCOL,
  readLegacyPublisherSuggestionInlineClaim,
  readPublisherSuggestionReviewClaim,
  type PublisherSuggestionReviewClaim,
} from './publisher-suggestion-review-protocol';

type PublisherSuggestionRow = {
  id: string;
  payload: Prisma.JsonValue;
  createdAt: Date;
};

type PublisherSuggestionStoredRow = PublisherSuggestionRow & {
  chatId: string;
  actorUserId: string;
};

type LegacyPublisherSuggestion = Omit<
  PublisherSuggestion,
  'textFormat' | 'imageCount' | 'reviewError'
>;
type LegacyPublisherSuggestionsResponse = { items: LegacyPublisherSuggestion[] };
type LegacyReviewPublisherSuggestionResponse = { suggestion: LegacyPublisherSuggestion };

type PublisherSuggestionListCursor = {
  entityId: string;
  view: 'pending' | 'history';
  createdAt: string;
  id: string;
};

@Injectable()
export class PublisherSuggestionService {
  private readonly logger = new Logger(PublisherSuggestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PublisherPolicyService,
    private readonly publications: PublicationService,
    private readonly publicationQueue: PublisherSuggestionPublicationQueueService,
    @Optional()
    private readonly adminQueue?: PublisherSuggestionAdminQueueService,
    @Optional()
    private readonly publisherDialogLinks?: PublisherDialogLinkService,
    @Optional() private readonly suggestionSubscriptions?: SuggestionSubscriptionService,
  ) {}

  async list(
    entityId: string,
    user: AuthUser,
    query?: unknown,
  ): Promise<PublisherSuggestionsResponse | LegacyPublisherSuggestionsResponse> {
    await this.policy.getEntity('channel', entityId, user);
    if (!this.isPaginatedListQuery(query)) {
      const rows = await this.prisma.auditLog.findMany({
        where: { chatId: entityId, action: PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: { id: true, payload: true, createdAt: true },
      });
      return { items: rows.map((row) => this.presentLegacy(row)) };
    }
    const parsed = publisherSuggestionsQuerySchema.safeParse(query ?? {});
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const { view, limit } = parsed.data;
    const cursor = parsed.data.cursor
      ? this.decodeListCursor(parsed.data.cursor, entityId, view)
      : null;
    const statusPredicate =
      view === 'pending'
        ? Prisma.sql`COALESCE(NULLIF(LOWER(payload->>'reviewStatus'), ''), 'pending') NOT IN ('published', 'drafted', 'cancelled')`
        : Prisma.sql`COALESCE(NULLIF(LOWER(payload->>'reviewStatus'), ''), 'pending') IN ('published', 'drafted', 'cancelled')`;
    const cursorPredicate = cursor
      ? Prisma.sql`AND (
          created_at < ${new Date(cursor.createdAt)}
          OR (created_at = ${new Date(cursor.createdAt)} AND id < ${cursor.id}::text)
        )`
      : Prisma.empty;

    const [rows, totals] = await Promise.all([
      this.prisma.$queryRaw<PublisherSuggestionRow[]>(Prisma.sql`
        SELECT id, payload, created_at AS "createdAt"
        FROM audit_logs
        WHERE chat_id = ${entityId}::text
          AND action = ${PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST}::text
          AND jsonb_typeof(payload::jsonb) = 'object'
          AND ${statusPredicate}
          ${cursorPredicate}
        ORDER BY created_at DESC, id DESC
        LIMIT ${limit + 1}
      `),
      this.prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
        SELECT COUNT(*)::integer AS total
        FROM audit_logs
        WHERE chat_id = ${entityId}::text
          AND action = ${PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST}::text
          AND jsonb_typeof(payload::jsonb) = 'object'
          AND ${statusPredicate}
      `),
    ]);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return publisherSuggestionsResponseSchema.parse({
      items: page.map((row) => this.present(row)),
      total: totals[0]?.total ?? 0,
      nextCursor:
        hasMore && last
          ? this.encodeListCursor({
              entityId,
              view,
              createdAt: last.createdAt.toISOString(),
              id: last.id,
            })
          : null,
    });
  }

  async review(
    entityId: string,
    suggestionId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ReviewPublisherSuggestionResponse | LegacyReviewPublisherSuggestionResponse> {
    await this.policy.getEntity('channel', entityId, user);
    const parsed = reviewPublisherSuggestionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const responseVersion = parsed.data.responseVersion === 2 ? 2 : 1;
    const reviewAction = parsed.data.action;
    let row = await this.findRow(suggestionId.trim(), entityId);
    if (!row) {
      throw new BadRequestException('Предложка не найдена.');
    }
    let payload = this.readPayload(row.payload);
    let currentStatus = this.readStatus(payload.reviewStatus);
    if (currentStatus === 'publishing' && payload.reviewPublicationProtocol == null) {
      row =
        (await this.migrateLegacyInlineClaim(row, payload, user)) ??
        (await this.requireRow(row.id, entityId));
      payload = this.readPayload(row.payload);
      currentStatus = this.readStatus(payload.reviewStatus);
    }
    if (parsed.data.editor) {
      const same = hasSuggestionRequest(payload, 'publish', user.userId, parsed.data.editor);
      if (currentStatus !== 'pending' && !same)
        throw new ConflictException('По предложке уже принято другое решение. Обновите её.');
    }
    const durableClaim = readPublisherSuggestionReviewClaim(payload, row.id, {
      allowPending: true,
    });
    if (currentStatus === 'pending' && durableClaim) {
      currentStatus = 'publishing';
    }
    if (
      currentStatus === 'published' ||
      currentStatus === 'drafted' ||
      currentStatus === 'cancelled'
    ) {
      await this.cleanupStoredImagesBestEffort(row.id, currentStatus);
      const expectedStatus = this.terminalStatusForAction(reviewAction);
      if (currentStatus === expectedStatus) {
        return this.reviewResponse(row, responseVersion);
      }
      throw this.terminalStatusConflict(currentStatus);
    }

    if (reviewAction === 'cancel') {
      if (currentStatus === 'publishing') {
        throw new ConflictException('Предложка уже публикуется и не может быть отклонена.');
      }
      const cancelled = await this.cancelPending(row.id, entityId, user);
      if (cancelled) {
        await this.cleanupStoredImagesBestEffort(cancelled.id, 'cancelled');
        return this.reviewResponse(cancelled, responseVersion);
      }
      const latest = await this.requireRow(row.id, entityId);
      if (this.readStatus(this.readPayload(latest.payload).reviewStatus) !== 'cancelled') {
        throw new ConflictException('Состояние предложки изменилось до отмены.');
      }
      await this.cleanupStoredImagesBestEffort(latest.id, 'cancelled');
      return this.reviewResponse(latest, responseVersion);
    }

    if (currentStatus === 'publishing') {
      if (durableClaim) {
        this.assertMatchingReviewAction(durableClaim, reviewAction);
        if (reviewAction === 'draft') {
          return this.completeDraftClaim(row, durableClaim, responseVersion);
        }
        await this.enqueueClaim(row.id, durableClaim.claimToken);
      }
      return this.reviewResponse(row, responseVersion);
    }

    const text = this.readString(payload.text);
    if (!text && this.readImageCount(payload) === 0) {
      throw new BadRequestException('В предложке нет текста или фото.');
    }
    await this.suggestionSubscriptions?.assertCanSubmit(row.chatId, row.actorUserId, 'publisher');
    const claimed = await this.claimPending(
      row.id,
      entityId,
      user,
      reviewAction,
      row,
      parsed.data.editor,
    );
    if (!claimed) {
      const latest = await this.requireRow(row.id, entityId);
      const latestPayload = this.readPayload(latest.payload);
      const latestStatus = this.readStatus(latestPayload.reviewStatus);
      if (
        parsed.data.editor &&
        !hasSuggestionRequest(latestPayload, 'publish', user.userId, parsed.data.editor)
      )
        throw new ConflictException('Предложку уже изменили. Обновите её перед решением.');
      if (latestStatus === 'cancelled') {
        throw new ConflictException('Предложка уже отклонена.');
      }
      if (latestStatus === 'published' || latestStatus === 'drafted') {
        if (latestStatus === this.terminalStatusForAction(reviewAction)) {
          return this.reviewResponse(latest, responseVersion);
        }
        throw this.terminalStatusConflict(latestStatus);
      }
      const latestClaim = readPublisherSuggestionReviewClaim(latestPayload, row.id, {
        allowPending: true,
      });
      if (latestClaim) {
        this.assertMatchingReviewAction(latestClaim, reviewAction);
        if (reviewAction === 'draft') {
          return this.completeDraftClaim(latest, latestClaim, responseVersion);
        }
        await this.enqueueClaim(latest.id, latestClaim.claimToken);
        return this.reviewResponse(latest, responseVersion);
      }
      if (latestStatus === 'pending') {
        throw new ConflictException('Не удалось зафиксировать заявку на публикацию.');
      }
      return this.reviewResponse(latest, responseVersion);
    }
    const claim = readPublisherSuggestionReviewClaim(this.readPayload(claimed.payload), row.id);
    if (!claim) {
      throw new ConflictException('Не удалось подтвердить заявку на публикацию.');
    }
    this.assertMatchingReviewAction(claim, reviewAction);
    if (reviewAction === 'draft') {
      return this.completeDraftClaim(claimed, claim, responseVersion);
    }
    await this.enqueueClaim(row.id, claim.claimToken);
    return this.reviewResponse(claimed, responseVersion);
  }

  /** Returns false only for a legacy claim owned by the old channel-dialog pipeline. */
  async processPublicationJob(suggestionId: string, expectedClaimToken: string): Promise<boolean> {
    const row = await this.prisma.auditLog.findFirst({
      where: {
        id: suggestionId.trim(),
        action: PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST,
      },
      select: { id: true, chatId: true, actorUserId: true, payload: true, createdAt: true },
    });
    if (!row) return false;

    const payload = this.readPayload(row.payload);
    if (!isPublisherSuggestionReviewProtocol(payload)) return false;
    const claim = readPublisherSuggestionReviewClaim(payload, row.id, { allowPending: true });
    if (!claim || claim.claimToken !== expectedClaimToken.trim()) return true;

    try {
      const images = await loadStoredChannelSuggestionImages({
        auditLogId: row.id,
        payload,
        legacyImages: readLegacyChannelSuggestionImages(payload),
        repository: this.prisma.channelSuggestionImageAsset,
        logger: this.logger,
      });
      // FLAG: Freeze new claim text before dispatch; legacy claims keep their original request hash.
      const publicationText =
        typeof payload.reviewPublicationText === 'string' ? payload.reviewPublicationText : null;
      const text = publicationText ?? this.readString(payload.text) ?? '';
      if (!text && images.length === 0) {
        await this.releaseTerminalClaim(row, claim, 'В предложке нет текста или фото.');
        return true;
      }
      const publication = await this.publications.create(
        claim.user,
        {
          requestId: claim.requestId,
          title: 'Предложка',
          content: {
            text,
            textFormat:
              publicationText || this.readString(payload.textFormat) === 'markdown'
                ? 'markdown'
                : 'plain',
            buttons: [],
            media: this.buildPublicationImageMedia(images),
          },
          audience: {
            selection: 'SELECTED',
            mode: 'SNAPSHOT',
            targets: [{ chatId: row.chatId, entityType: 'channel' }],
          },
          schedule: claim.action === 'draft' ? null : { mode: 'now', timezone: 'Europe/Moscow' },
          intent: claim.action,
        },
        PublicationDispatchProfile.PUBLIK_V1,
      );
      await this.finalizeClaimOrThrow(row, claim, publication.id);
      await this.cleanupStoredImagesBestEffort(
        row.id,
        claim.action === 'draft' ? 'drafted' : 'published',
      );
      return true;
    } catch (error: unknown) {
      if (await this.reconcileAlreadyTerminalClaim(row, claim)) {
        return true;
      }
      // A failed lookup throws and keeps the claim until exact mutation absence is proven.
      const mutationExists = await this.hasClaimMutationRecord(claim);
      if (mutationExists) {
        // PublicationService owns request-hash validation. Retrying it is the only safe way
        // to distinguish an exact replay from a colliding request id.
        throw error;
      }
      if (this.isTerminalPublicationError(error)) {
        await this.releaseTerminalClaim(
          row,
          claim,
          error instanceof Error ? error.message.slice(0, 300) : 'Ошибка публикации',
        );
        return true;
      }
      throw error;
    }
  }

  private async migrateLegacyInlineClaim(
    row: PublisherSuggestionStoredRow,
    payload: Record<string, unknown>,
    currentUser: AuthUser,
  ): Promise<PublisherSuggestionStoredRow | null> {
    const legacyClaim = readLegacyPublisherSuggestionInlineClaim(payload, row.id);
    if (!legacyClaim) {
      return null;
    }
    const { claimedAt, claimedByUserId, requestId } = legacyClaim;
    const staleBefore = new Date(
      Date.now() - PUBLISHER_SUGGESTION_LEGACY_INLINE_STALE_MS,
    ).toISOString();
    const claimToken = randomUUID();
    const sameReviewer = currentUser.userId === claimedByUserId;
    const patch = {
      reviewAction: 'publish',
      reviewDispatchProfile: PUBLISHER_SUGGESTION_DISPATCH_PROFILE,
      reviewPublicationProtocol: PUBLISHER_SUGGESTION_REVIEW_PROTOCOL,
      reviewPublicationRequestId: requestId,
      reviewClaimToken: claimToken,
      reviewClaimedAt: claimedAt,
      reviewClaimedByUserId: claimedByUserId,
      reviewClaimedByUsername: sameReviewer ? currentUser.username?.trim() || null : null,
      reviewClaimedByDisplayName: sameReviewer ? currentUser.displayName?.trim() || null : null,
      reviewClaimedByAvatarUrl: sameReviewer ? currentUser.avatarUrl?.trim() || null : null,
      reviewClaimedByProfileUrl: sameReviewer ? currentUser.profileUrl?.trim() || null : null,
      reviewClaimMigratedFrom: 'inline_v0',
    } satisfies Prisma.InputJsonObject;
    const rows = await this.prisma.$queryRaw<PublisherSuggestionStoredRow[]>(Prisma.sql`
      UPDATE audit_logs
      SET payload = payload::jsonb || ${JSON.stringify(patch)}::jsonb
      WHERE id = ${row.id}::text
        AND chat_id = ${row.chatId}::text
        AND action = ${PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST}::text
        AND payload->>'type' = 'suggest'
        AND payload->>'reviewStatus' = 'publishing'
        AND payload->>'reviewPublicationProtocol' IS NULL
        AND payload->>'reviewedByUserId' = ${claimedByUserId}::text
        AND payload->>'reviewedAt' = ${claimedAt}::text
        AND payload->>'reviewedAt' <= ${staleBefore}::text
      RETURNING id, chat_id AS "chatId", actor_user_id AS "actorUserId", payload, created_at AS "createdAt"
    `);
    return rows[0] ?? null;
  }

  private async claimPending(
    suggestionId: string,
    entityId: string,
    user: AuthUser,
    action: PublisherSuggestionReviewClaim['action'],
    source: PublisherSuggestionStoredRow,
    editor?: SuggestionReviewWrite,
  ): Promise<PublisherSuggestionStoredRow | null> {
    const sourcePayload = this.readPayload(source.payload);
    const contentPatch = suggestionContentPatch(
      sourcePayload,
      editor
        ? publicationEditorInput(sourcePayload, user.userId, editor)
        : { expectedRevision: 0, requestId: '00000000-0000-4000-8000-000000000000' },
      user.userId,
    );
    const effectivePayload = { ...sourcePayload, ...contentPatch };
    assertSuggestionPublicationLength(source.actorUserId, effectivePayload);
    const claimToken = randomUUID();
    const claimPatch = {
      ...contentPatch,
      ...(editor
        ? {
            reviewContentRequestId: editor.requestId,
            ...suggestionRequestPatch(
              sourcePayload,
              'publish',
              user.userId,
              editor,
              suggestionRevision(effectivePayload),
            ),
          }
        : {}),
      reviewStatus: 'publishing',
      reviewPublicationText: buildPublisherSuggestionPublicationText(
        source.actorUserId,
        effectivePayload,
      ),
      reviewAction: action,
      reviewDispatchProfile: PUBLISHER_SUGGESTION_DISPATCH_PROFILE,
      reviewPublicationProtocol: PUBLISHER_SUGGESTION_REVIEW_PROTOCOL,
      reviewPublicationRequestId: buildPublisherSuggestionPublicationRequestId(
        suggestionId,
        claimToken,
      ),
      reviewClaimToken: claimToken,
      reviewClaimedAt: new Date().toISOString(),
      reviewClaimedByUserId: user.userId,
      reviewClaimedByUsername: user.username?.trim() || null,
      reviewClaimedByDisplayName: user.displayName?.trim() || null,
      reviewClaimedByAvatarUrl: user.avatarUrl?.trim() || null,
      reviewClaimedByProfileUrl: user.profileUrl?.trim() || null,
      reviewedByUserId: user.userId,
      reviewClaimMigratedFrom: null,
      reviewError: null,
    };
    const rows = await this.prisma.$queryRaw<PublisherSuggestionStoredRow[]>(Prisma.sql`
      UPDATE audit_logs
      SET payload = payload::jsonb || ${JSON.stringify(claimPatch)}::jsonb
      WHERE id = ${suggestionId}::text
        AND chat_id = ${entityId}::text
        AND action = ${PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST}::text
        AND payload->>'type' = 'suggest'
        AND COALESCE(NULLIF(LOWER(payload->>'reviewStatus'), ''), 'pending') = 'pending'
        AND payload->>'reviewClaimToken' IS NULL
        AND COALESCE((payload->>'reviewContentRevision')::integer, 0) = ${suggestionRevision(sourcePayload)}
      RETURNING id, chat_id AS "chatId", actor_user_id AS "actorUserId", payload, created_at AS "createdAt"
    `);
    return rows[0] ?? null;
  }

  private async cancelPending(
    suggestionId: string,
    entityId: string,
    user: AuthUser,
  ): Promise<PublisherSuggestionStoredRow | null> {
    const patch = {
      reviewStatus: 'cancelled',
      reviewedAt: new Date().toISOString(),
      reviewedByUserId: user.userId,
      reviewedByDisplayName: user.displayName?.trim() || user.userId,
      reviewError: null,
    } satisfies Prisma.InputJsonObject;
    const rows = await this.prisma.$queryRaw<PublisherSuggestionStoredRow[]>(Prisma.sql`
      UPDATE audit_logs
      SET payload = (
        payload::jsonb || ${JSON.stringify(patch)}::jsonb
      )
        - 'reviewAction'
        - 'reviewDispatchProfile'
        - 'reviewPublicationProtocol'
        - 'reviewPublicationRequestId'
        - 'reviewClaimToken'
        - 'reviewClaimedAt'
        - 'reviewClaimedByUserId'
        - 'reviewClaimedByUsername'
        - 'reviewClaimedByDisplayName'
        - 'reviewClaimedByAvatarUrl'
        - 'reviewClaimedByProfileUrl'
      WHERE id = ${suggestionId}::text
        AND chat_id = ${entityId}::text
        AND action = ${PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST}::text
        AND payload->>'type' = 'suggest'
        AND COALESCE(NULLIF(LOWER(payload->>'reviewStatus'), ''), 'pending') = 'pending'
        AND payload->>'reviewClaimToken' IS NULL
      RETURNING id, chat_id AS "chatId", actor_user_id AS "actorUserId", payload, created_at AS "createdAt"
    `);
    return rows[0] ?? null;
  }

  private async finalizeClaim(
    row: PublisherSuggestionStoredRow,
    claim: PublisherSuggestionReviewClaim,
    publicationId: string,
  ): Promise<PublisherSuggestionStoredRow | null> {
    const reviewStatus = claim.action === 'draft' ? 'drafted' : 'published';
    if (claim.action === 'publish' && this.suggestionSubscriptions) {
      const botId = this.publisherDialogLinks?.getBotId();
      if (!botId) throw new Error('Publisher suggestion identity unavailable');
      await this.prisma.$transaction((tx) =>
        this.suggestionSubscriptions!.track(
          {
            id: row.id,
            chatId: row.chatId,
            authorUserId: row.actorUserId,
            profile: 'publisher',
            botId,
            publicationId,
          },
          tx,
        ),
      );
    }
    const finalizedAt = new Date().toISOString();
    const patch = {
      reviewStatus,
      publicationId,
      ...(claim.action === 'draft' ? { draftedAt: finalizedAt } : { publishedAt: finalizedAt }),
      reviewedAt: finalizedAt,
      reviewedByUserId: claim.user.userId,
      reviewedByDisplayName: claim.user.displayName?.trim() || claim.user.userId,
      reviewError: null,
    } satisfies Prisma.InputJsonObject;
    const rows = await this.prisma.$queryRaw<PublisherSuggestionStoredRow[]>(Prisma.sql`
      UPDATE audit_logs
      SET payload = (
        payload::jsonb || ${JSON.stringify(patch)}::jsonb
      )
        - 'reviewAction'
        - 'reviewClaimToken'
        - 'reviewClaimedAt'
        - 'reviewClaimedByUsername'
        - 'reviewClaimedByDisplayName'
        - 'reviewClaimedByAvatarUrl'
        - 'reviewClaimedByProfileUrl'
      WHERE id = ${row.id}::text
        AND chat_id = ${row.chatId}::text
        AND action = ${PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST}::text
        AND payload->>'reviewStatus' IN ('publishing', 'pending')
        AND payload->>'reviewPublicationProtocol' = ${PUBLISHER_SUGGESTION_REVIEW_PROTOCOL}::text
        AND payload->>'reviewPublicationRequestId' = ${claim.requestId}::text
        AND payload->>'reviewClaimToken' = ${claim.claimToken}::text
        AND payload->>'reviewAction' = ${claim.action}::text
        AND payload->>'reviewClaimedByUserId' = ${claim.user.userId}::text
      RETURNING id, chat_id AS "chatId", actor_user_id AS "actorUserId", payload, created_at AS "createdAt"
    `);
    return rows[0] ?? null;
  }

  private async finalizeClaimOrThrow(
    row: PublisherSuggestionStoredRow,
    claim: PublisherSuggestionReviewClaim,
    publicationId: string,
  ): Promise<void> {
    if (await this.finalizeClaim(row, claim, publicationId)) {
      return;
    }
    const latest = await this.requireRow(row.id, row.chatId);
    const latestPayload = this.readPayload(latest.payload);
    if (
      this.readStatus(latestPayload.reviewStatus) ===
        (claim.action === 'draft' ? 'drafted' : 'published') &&
      this.readString(latestPayload.publicationId) === publicationId
    ) {
      return;
    }
    throw new ConflictException(
      'Состояние предложки изменилось после создания публикации. Требуется повторная проверка.',
    );
  }

  private async releaseTerminalClaim(
    row: PublisherSuggestionStoredRow,
    claim: PublisherSuggestionReviewClaim,
    error: string,
  ): Promise<void> {
    const patch = {
      reviewStatus: 'pending',
      reviewError: error.slice(0, 300),
      reviewClaimReleasedAt: new Date().toISOString(),
    } satisfies Prisma.InputJsonObject;
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE audit_logs
      SET payload = (
        payload::jsonb || ${JSON.stringify(patch)}::jsonb
      )
        - 'reviewAction'
        - 'reviewDispatchProfile'
        - 'reviewPublicationProtocol'
        - 'reviewPublicationRequestId'
        - 'reviewPublicationText'
        - 'reviewClaimToken'
        - 'reviewClaimedAt'
        - 'reviewClaimedByUserId'
        - 'reviewClaimedByUsername'
        - 'reviewClaimedByDisplayName'
        - 'reviewClaimedByAvatarUrl'
        - 'reviewClaimedByProfileUrl'
      WHERE id = ${row.id}::text
        AND chat_id = ${row.chatId}::text
        AND action = ${PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST}::text
        AND payload->>'reviewStatus' IN ('publishing', 'pending')
        AND payload->>'reviewPublicationProtocol' = ${PUBLISHER_SUGGESTION_REVIEW_PROTOCOL}::text
        AND payload->>'reviewPublicationRequestId' = ${claim.requestId}::text
        AND payload->>'reviewClaimToken' = ${claim.claimToken}::text
        AND payload->>'reviewAction' = ${claim.action}::text
        AND payload->>'reviewClaimedByUserId' = ${claim.user.userId}::text
    `);
  }

  private async hasClaimMutationRecord(claim: PublisherSuggestionReviewClaim): Promise<boolean> {
    const record = await this.prisma.publicationMutationRecord.findUnique({
      where: {
        actorUserId_requestId: {
          actorUserId: claim.user.userId,
          requestId: claim.requestId,
        },
      },
      select: { publicationId: true },
    });
    return Boolean(record);
  }

  private async reconcileAlreadyTerminalClaim(
    row: PublisherSuggestionStoredRow,
    claim: PublisherSuggestionReviewClaim,
  ): Promise<boolean> {
    const latest = await this.findRow(row.id, row.chatId);
    if (!latest) return false;
    const payload = this.readPayload(latest.payload);
    const expectedStatus = claim.action === 'draft' ? 'drafted' : 'published';
    if (
      this.readStatus(payload.reviewStatus) !== expectedStatus ||
      !this.readString(payload.publicationId)
    ) {
      return false;
    }
    await this.cleanupStoredImagesBestEffort(row.id, expectedStatus);
    return true;
  }

  private async enqueueClaim(suggestionId: string, claimToken: string): Promise<void> {
    try {
      await this.publicationQueue.enqueue(suggestionId, claimToken, { recycleCompleted: true });
    } catch (error: unknown) {
      this.logger.warn(
        {
          suggestionId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Publik suggestion claim persisted but immediate queue enqueue failed; recovery will retry',
      );
    }
  }

  private async cleanupStoredImagesBestEffort(
    suggestionId: string,
    terminalStatus: 'published' | 'drafted' | 'cancelled',
  ): Promise<void> {
    try {
      await this.prisma.channelSuggestionImageAsset.deleteMany({
        where: { auditLogId: suggestionId },
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          suggestionId,
          terminalStatus,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to clean terminal Publisher suggestion image assets; bounded recovery will retry',
      );
    }
  }

  private async completeDraftClaim(
    row: PublisherSuggestionStoredRow,
    claim: PublisherSuggestionReviewClaim,
    responseVersion: 1 | 2,
  ): Promise<ReviewPublisherSuggestionResponse | LegacyReviewPublisherSuggestionResponse> {
    await this.enqueueClaim(row.id, claim.claimToken);
    await this.processPublicationJob(row.id, claim.claimToken);
    const latest = await this.requireRow(row.id, row.chatId);
    const payload = this.readPayload(latest.payload);
    const status = this.readStatus(payload.reviewStatus);
    if (status === 'drafted' && this.readString(payload.publicationId)) {
      return this.reviewResponse(latest, responseVersion);
    }
    if (status === 'pending') {
      throw new BadRequestException(
        this.readString(payload.reviewError) ?? 'Не удалось создать черновик публикации.',
      );
    }
    if (status === 'published' || status === 'cancelled') {
      throw this.terminalStatusConflict(status);
    }
    throw new ConflictException(
      'Создание черновика ещё не завершено. Повторите запрос с тем же действием.',
    );
  }

  private assertMatchingReviewAction(
    claim: PublisherSuggestionReviewClaim,
    action: PublisherSuggestionReviewClaim['action'],
  ): void {
    if (claim.action !== action) {
      throw new ConflictException(
        claim.action === 'draft'
          ? 'Предложка уже переносится в черновик.'
          : 'Предложка уже публикуется.',
      );
    }
  }

  private terminalStatusForAction(
    action: ReviewPublisherSuggestionRequest['action'],
  ): Extract<PublisherSuggestion['reviewStatus'], 'published' | 'drafted' | 'cancelled'> {
    return action === 'publish' ? 'published' : action === 'draft' ? 'drafted' : 'cancelled';
  }

  private terminalStatusConflict(
    status: Extract<PublisherSuggestion['reviewStatus'], 'published' | 'drafted' | 'cancelled'>,
  ): ConflictException {
    return new ConflictException(
      status === 'published'
        ? 'Предложка уже принята в публикацию.'
        : status === 'drafted'
          ? 'Предложка уже перенесена в черновик.'
          : 'Предложка уже отклонена.',
    );
  }

  private requireRow(id: string, chatId: string): Promise<PublisherSuggestionStoredRow> {
    return this.prisma.auditLog.findFirstOrThrow({
      where: { id, chatId, action: PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST },
      select: { id: true, chatId: true, actorUserId: true, payload: true, createdAt: true },
    });
  }

  private findRow(id: string, chatId: string): Promise<PublisherSuggestionStoredRow | null> {
    return this.prisma.auditLog.findFirst({
      where: { id, chatId, action: PUBLISHER_CHANNEL_DIALOG_ACTION_SUGGEST },
      select: { id: true, chatId: true, actorUserId: true, payload: true, createdAt: true },
    });
  }

  private async reviewResponse(
    row: PublisherSuggestionRow,
    responseVersion: 1 | 2,
  ): Promise<ReviewPublisherSuggestionResponse | LegacyReviewPublisherSuggestionResponse> {
    const suggestion = this.present(row);
    if (
      suggestion.reviewStatus === 'published' ||
      suggestion.reviewStatus === 'drafted' ||
      suggestion.reviewStatus === 'cancelled'
    ) {
      await this.enqueueAdminCardSync(row.id, suggestion.reviewStatus);
    }
    if (responseVersion === 2) {
      return reviewPublisherSuggestionResponseSchema.parse({ suggestion });
    }
    return { suggestion: this.presentLegacy(row) };
  }

  private async enqueueAdminCardSync(
    suggestionId: string,
    reviewStatus: 'published' | 'drafted' | 'cancelled',
  ): Promise<void> {
    const requiredBotId = this.publisherDialogLinks?.getBotId().trim() ?? '';
    if (!this.adminQueue || !requiredBotId) return;
    await this.adminQueue.enqueueSync({
      suggestionId,
      requiredBotId,
      reviewStatus,
      recoverExisting: true,
    });
  }

  private present(row: PublisherSuggestionRow): PublisherSuggestion {
    const payload = this.readPayload(row.payload);
    return publisherSuggestionSchema.parse({
      id: row.id,
      text: this.readString(payload.text) ?? '',
      textFormat: this.readString(payload.textFormat) === 'markdown' ? 'markdown' : 'plain',
      authorDisplayName: this.readString(payload.authorDisplayName),
      createdAt: row.createdAt.toISOString(),
      reviewStatus: this.readStatus(payload.reviewStatus),
      publicationId: this.readString(payload.publicationId),
      imageCount: this.readImageCount(payload),
      reviewError: this.readString(payload.reviewError),
    });
  }

  private presentLegacy(row: PublisherSuggestionRow): LegacyPublisherSuggestion {
    const suggestion = this.present(row);
    return {
      id: suggestion.id,
      text: suggestion.text,
      authorDisplayName: suggestion.authorDisplayName,
      createdAt: suggestion.createdAt,
      reviewStatus: suggestion.reviewStatus,
      publicationId: suggestion.publicationId,
    };
  }

  private isPaginatedListQuery(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const query = value as Record<string, unknown>;
    return 'view' in query || 'limit' in query || 'cursor' in query;
  }

  private encodeListCursor(cursor: PublisherSuggestionListCursor): string {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  private decodeListCursor(
    value: string,
    entityId: string,
    view: 'pending' | 'history',
  ): PublisherSuggestionListCursor {
    try {
      const parsed = JSON.parse(
        Buffer.from(value, 'base64url').toString('utf8'),
      ) as Partial<PublisherSuggestionListCursor>;
      if (
        parsed.entityId !== entityId ||
        parsed.view !== view ||
        typeof parsed.createdAt !== 'string' ||
        !Number.isFinite(new Date(parsed.createdAt).getTime()) ||
        typeof parsed.id !== 'string' ||
        !parsed.id.trim() ||
        parsed.id.length > 256
      ) {
        throw new Error('cursor mismatch');
      }
      return {
        entityId,
        view,
        createdAt: new Date(parsed.createdAt).toISOString(),
        id: parsed.id,
      };
    } catch {
      throw new BadRequestException('Курсор предложек устарел или повреждён.');
    }
  }

  private readPayload(value: Prisma.JsonValue): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private readImageCount(payload: Record<string, unknown>): number {
    const declared = payload.imageCount;
    if (typeof declared === 'number' && Number.isSafeInteger(declared) && declared >= 0) {
      return Math.min(10, declared);
    }
    const legacyCount = readLegacyChannelSuggestionImages(payload).length;
    return legacyCount > 0 ? legacyCount : payload.hasImage === true ? 1 : 0;
  }

  private buildPublicationImageMedia(
    images: ChannelSuggestionImageAsset[],
  ): PublicationMediaInput[] {
    return images.map((image) => {
      const base64 = this.readString(image.base64);
      const mimeType = this.readString(image.mimeType)?.toLowerCase();
      if (image.type === 'video') {
        if (!base64 || !mimeType?.startsWith('video/'))
          throw new BadRequestException('Сохранённое видео предложки повреждено.');
        return {
          type: 'video',
          payload: null,
          base64,
          mimeType,
          fileName: this.readString(image.fileName) ?? '',
        };
      }
      if (!base64 || !mimeType?.startsWith('image/')) {
        throw new BadRequestException('Сохранённое фото предложки повреждено.');
      }
      return {
        type: 'image',
        base64,
        mimeType,
        fileName: this.readString(image.fileName) ?? '',
      };
    });
  }

  private readStatus(value: unknown): PublisherSuggestion['reviewStatus'] {
    return value === 'publishing' ||
      value === 'published' ||
      value === 'drafted' ||
      value === 'cancelled'
      ? value
      : 'pending';
  }

  private isTerminalPublicationError(error: unknown): boolean {
    if (!(error instanceof HttpException)) return false;
    const status = error.getStatus();
    return (
      status >= 400 &&
      status < 500 &&
      status !== HttpStatus.REQUEST_TIMEOUT &&
      status !== HttpStatus.TOO_MANY_REQUESTS
    );
  }
}
