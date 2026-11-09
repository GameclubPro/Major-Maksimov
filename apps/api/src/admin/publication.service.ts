import {
  readPublicationLatePolicy,
  snapshotPublicationDeliveryDeadline,
  withDefaultPublicationLatePolicy,
  withPreservedPublicationLatePolicy,
  resolvePublicationRecurrenceFrom,
} from './publication-late-policy';
import {
  mapPublicationPostActions,
  publicationPostActionsInitialData,
  publicationPostActionsRetryData,
  type PublicationPostActionRetryContent,
} from './publication-post-actions';
import {
  createPublicationRequestSchema,
  decodePublicationListCursor,
  encodePublicationListCursor,
  listPublicationDeliveriesQuerySchema,
  listPublicationDeliveriesResponseSchema,
  listPublicationsQuerySchema,
  listPublicationsResponseSchema,
  publicationCalendarAvailabilityRequestSchema,
  publicationCalendarAvailabilityResponseSchema,
  publicationActionRequestSchema,
  publicationScheduleInputSchema,
  resolvePublicationAmbiguousDeliveryRequestSchema,
  retryPublicationOccurrenceRequestSchema,
  testPublicationRequestSchema,
  updatePublicationRequestSchema,
  type CreatePublicationRequest,
  type ListPublicationDeliveriesResponse,
  type ListPublicationsResponse,
  type PublicationCalendarAvailabilityResponse,
  type PublicationAudienceInput,
  type PublicationDetails,
  type PublicationScheduleInput,
  type PublicationSummary,
  type PublicationTargetInput,
  type UpdatePublicationRequest,
} from '@maxim/contracts/publication';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { MAX_API_SOURCE_TAGS } from '../max/max-client.service';
import {
  ChatEntityType,
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  Prisma,
  PublicationAudienceMode,
  PublicationAudienceSelection,
  PublicationContentFormat,
  PublicationDeliveryVerificationSource,
  PublicationDispatchProfile,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationScheduleMode,
  PublicationScheduleStatus,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { BackgroundRuntimeGovernorService } from '../system/background-runtime-governor.service';
import { SystemModeService } from '../system/system-mode.service';
import { isPrismaKnownError } from './admin-legacy-utils';
import { ManagedBroadcastService } from './managed-broadcast.service';
import { ManagedEntitiesService } from './managed-entities.service';
import { PUBLISHER_EXPLICIT_RETRY_CODE } from './publication-dispatch-issue';
import { deleteUnstartedPublicationExecutionEnvelopes } from './publication-access-loss-recovery';
import { PUBLICATION_DELIVERY_VERIFICATION_RESET_DATA } from './publication-delivery-verification-state';
import {
  normalizePublicationContent,
  PublicationContentService,
} from './publication-content.service';
import {
  selectCurrentRevisionFailedPublicationPage,
  selectPublicationSearchPage,
} from './publication-failed-page-query';
import { isImportedEmptyPublicationDraft } from './publication-imported-draft';
import { readPublicationRetryAuthorizedAt } from './publication-late-policy';
import {
  PublicationPublisherRoutingService,
  type ResolvedPublicationTarget,
} from './publication-publisher-routing.service';
import { publicationBackgroundAccess } from './publication-background-access';
import { tryCancelAccessiblePublicationTargets } from './publication-target-cancellation';
import {
  publicationAdminAccessWhere,
  publicationAdminScope,
  publicationAdminTargetWhere,
  publicationAdminLifecycleWhere,
  publicationAdminListWhere,
} from './publication-admin-access';
import { readStoredPublicationButtons } from './publication-buttons';
import {
  buildPublicationCalendarTargetPredicates,
  releaseRetiredMajorCalendarSlots,
} from './publication-calendar';
import {
  findPublicationCalendarConflicts,
  type PublicationCalendarConflictOccurrence,
  type PublicationCalendarConflicts,
} from './publication-calendar-conflicts';
import { cancelUntouchedScheduledPublicationOccurrences } from './publication-stale-occurrence-cleanup';
import {
  buildUnsafePublicationExecutionDeliveryWhere,
  cancelUnstartedPublicationExecutionBroadcasts,
  reviseUnstartedPublicationExecutionBroadcasts,
  throwPublicationExecutionRequiresManualReview,
} from './publication-execution-safety';
import {
  reconcileOrphanedPublicationOccurrences as reconcilePublicationOrphans,
  syncPublicationBroadcastAfterDeliveryResolution,
  recordPublicationDeliveryResolution,
  syncResolvedPublicationOccurrence,
} from './publication-execution-recovery';
import {
  buildPublisherPublicationWakeDispatch,
  dispatchScheduledPublicationOccurrences,
  type PublicationOccurrenceDispatchScope,
} from './publication-occurrence-dispatcher';
import { PublicationOccurrenceRollupScanner } from './publication-occurrence-rollup-scanner';
import { rollupPublicationOccurrence } from './publication-occurrence-rollup';
import {
  parsePublicationOccurrenceRollupNoopRollout,
  PublicationOccurrenceRollupNoopReader,
} from './publication-occurrence-rollup-noop';
import {
  PublicationPresenterService,
  PUBLICATION_DELIVERY_PRESENTATION_INCLUDE,
  isPublicationDeliveryDispatchStopped,
  mapPublicationDeliveryWait,
} from './publication-presenter.service';
import { PublisherPublicationWakeupQueueService } from './publisher-publication-wakeup.queue';
import {
  buildEffectiveDeliveryListWhere,
  buildManualReviewDeliveryWhere,
  resolveEffectivePublicationDeliveryStatus,
} from './publication-legacy-automated-absence';
import * as publicationManualRetrySafety from './publication-manual-retry-safety';
import { expandPublicationSchedule } from './publication-recurrence';
import { normalizePublicationSchedule } from './publication-schedule-normalization';
import {
  deferPublicationRecurrencePreparation,
  recoverPublicationRecurrencePreparationFailure,
} from './publication-recurrence-recovery';

const PUBLICATION_RECURRENCE_HORIZON_MS = 14 * 24 * 60 * 60_000;
const PUBLICATION_RECURRENCE_LOOKAHEAD_MS = 450 * 24 * 60 * 60_000;
const PUBLICATION_RECURRENCE_REFRESH_MS = 12 * 60 * 60_000;
const PUBLICATION_PAST_GRACE_MS = 5 * 60_000;
const PUBLICATION_MATERIALIZE_BATCH = 50;
const PUBLICATION_DISPATCH_BATCH = 50;
const PUBLICATION_DEADLINE_DISPATCH_BATCH = 25;
const PUBLICATION_SLOW_BATCH = 2;
const PUBLICATION_RECONCILE_BATCH = 200;

class StalePublicationRollupError extends Error {}

@Injectable()
export class PublicationService {
  private readonly logger = new Logger(PublicationService.name);
  private throttleLogAtMs = 0;
  private readonly activeOccurrenceRollups = new PublicationOccurrenceRollupScanner();
  private readonly occurrenceRollupNoop: PublicationOccurrenceRollupNoopReader;

  constructor(
    private readonly prisma: PrismaService,
    private readonly publicationContentService: PublicationContentService,
    private readonly publicationPresenterService: PublicationPresenterService,
    private readonly managedEntitiesService: ManagedEntitiesService,
    private readonly managedBroadcastService: ManagedBroadcastService,
    private readonly backgroundRuntimeGovernorService: BackgroundRuntimeGovernorService,
    private readonly systemModeService: SystemModeService,
    private readonly publisherRouting: PublicationPublisherRoutingService,
    private readonly publisherPublicationWakeupQueue: PublisherPublicationWakeupQueueService,
    configService: ConfigService,
  ) {
    this.occurrenceRollupNoop = new PublicationOccurrenceRollupNoopReader(
      prisma,
      parsePublicationOccurrenceRollupNoopRollout(
        configService.get<unknown>('PUBLISHER_OCCURRENCE_ROLLUP_NOOP_ROLLOUT'),
      ),
      this.logger,
    );
  }

  async list(
    user: AuthUser,
    query: unknown,
    dispatchProfile?: PublicationDispatchProfile,
  ): Promise<ListPublicationsResponse> {
    const parsed = listPublicationsQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const cursor = parsed.data.cursor ? decodePublicationListCursor(parsed.data.cursor) : null;
    if (
      parsed.data.cursor &&
      (!cursor ||
        cursor.view !== parsed.data.view ||
        cursor.query !== parsed.data.query ||
        cursor.entityType !== parsed.data.entityType ||
        cursor.status !== parsed.data.status)
    ) {
      throw new BadRequestException('Курсор списка публикаций недействителен.');
    }

    const lifecycle =
      parsed.data.view === 'drafts'
        ? [PublicationLifecycle.DRAFT]
        : parsed.data.view === 'history'
          ? [PublicationLifecycle.COMPLETED, PublicationLifecycle.CANCELED]
          : [PublicationLifecycle.ACTIVE, PublicationLifecycle.PAUSED, PublicationLifecycle.ERROR];
    const publisherBotId =
      dispatchProfile === PublicationDispatchProfile.PUBLIK_V1
        ? this.publisherRouting.requireNewRoute().requiredBotId
        : null;
    const scope = publicationAdminScope(user.userId, publisherBotId ?? undefined);
    const publisherScope = publisherBotId ? scope : undefined;
    const filters: Prisma.PublicationWhereInput[] = [];
    if (parsed.data.query && !publisherBotId) {
      const searchBranches: Prisma.PublicationWhereInput[] = [
        { title: { contains: parsed.data.query, mode: 'insensitive' } },
        {
          canonicalContentRevision: {
            is: { text: { contains: parsed.data.query, mode: 'insensitive' } },
          },
        },
      ];
      searchBranches.push({
        targets: {
          some: {
            chat: { title: { contains: parsed.data.query, mode: 'insensitive' } },
          },
        },
      });
      filters.push({
        OR: searchBranches,
      });
    }
    if (parsed.data.view === 'schedules') {
      filters.push({
        schedule: {
          is: {
            mode: {
              in: [
                PublicationScheduleMode.ONCE,
                PublicationScheduleMode.SLOTS,
                PublicationScheduleMode.RECURRENCE,
              ],
            },
          },
        },
      });
    } else if (parsed.data.view === 'current') {
      filters.push({
        schedule: { is: { mode: PublicationScheduleMode.NOW } },
      });
    }
    if (parsed.data.entityType) {
      const entityType = this.toPrismaEntityType(parsed.data.entityType);
      const audienceSelection =
        parsed.data.entityType === 'channel'
          ? PublicationAudienceSelection.ALL_CHANNELS
          : PublicationAudienceSelection.ALL_CHATS;
      filters.push(
        publisherBotId
          ? {
              targets: {
                some: {
                  entityType,
                  ...publicationAdminTargetWhere(scope),
                },
              },
            }
          : {
              OR: [
                { audienceSelection: PublicationAudienceSelection.ALL_MANAGED },
                { audienceSelection },
                { targets: { some: { entityType } } },
              ],
            },
      );
    }
    const usesCurrentRevisionFailedSelector =
      parsed.data.status === 'failed' &&
      (parsed.data.view === 'current' || parsed.data.view === 'schedules');
    if (parsed.data.status) {
      if (parsed.data.status === 'failed') {
        if (!usesCurrentRevisionFailedSelector) {
          filters.push({
            OR: [
              { lifecycle: PublicationLifecycle.ERROR },
              {
                occurrences: {
                  some: {
                    deliveries: {
                      some: {
                        status: {
                          in: [
                            ManagedBroadcastDeliveryStatus.FAILED,
                            ManagedBroadcastDeliveryStatus.AMBIGUOUS,
                          ],
                        },
                      },
                    },
                  },
                },
              },
            ],
          });
        }
      } else {
        const statusLifecycle =
          parsed.data.status === 'active'
            ? [PublicationLifecycle.ACTIVE]
            : parsed.data.status === 'paused'
              ? [PublicationLifecycle.PAUSED]
              : [PublicationLifecycle.COMPLETED, PublicationLifecycle.CANCELED];
        filters.push(
          publisherBotId
            ? publicationAdminLifecycleWhere(scope, statusLifecycle)
            : { lifecycle: { in: statusLifecycle } },
        );
      }
    }
    if (cursor) {
      const cursorUpdatedAt = new Date(cursor.updatedAt);
      filters.push({
        OR: [
          { updatedAt: { lt: cursorUpdatedAt } },
          { updatedAt: cursorUpdatedAt, id: { lt: cursor.id } },
        ],
      });
    }

    const publicationWhere: Prisma.PublicationWhereInput = {
      ...publicationAdminAccessWhere(scope, dispatchProfile),
      ...(dispatchProfile ? { dispatchProfile } : {}),
      ...publicationAdminListWhere(publisherScope, lifecycle, filters),
    };
    let failedPageIdentifiers: Array<{ id: string; updatedAt: Date }> = [];
    let rows: any[];
    const usesSqlPageSelector =
      usesCurrentRevisionFailedSelector ||
      Boolean(publisherBotId && (parsed.data.query || parsed.data.status === 'failed'));
    if (usesSqlPageSelector) {
      const pageParams = {
        actorUserId: user.userId,
        view: parsed.data.view,
        status: parsed.data.status,
        query: parsed.data.query,
        entityType: parsed.data.entityType,
        cursor,
        limit: parsed.data.limit + 1,
        dispatchProfile,
        publisherBotId: publisherBotId ?? undefined,
      };
      failedPageIdentifiers = usesCurrentRevisionFailedSelector
        ? await selectCurrentRevisionFailedPublicationPage(this.prisma, {
            ...pageParams,
            view: parsed.data.view as 'current' | 'schedules',
          })
        : await selectPublicationSearchPage(this.prisma, pageParams);
      if (failedPageIdentifiers.length === 0) {
        rows = [];
      } else {
        const hydratedRows = await this.prisma.publication.findMany({
          where: {
            ...publicationWhere,
            id: { in: failedPageIdentifiers.map((row) => row.id) },
          },
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take: parsed.data.limit + 1,
          include: this.publicationPresenterService.publicationSummaryInclude(publisherScope),
        });
        const hydratedById = new Map(hydratedRows.map((row) => [row.id, row]));
        rows = failedPageIdentifiers.flatMap((row) => {
          const hydrated = hydratedById.get(row.id);
          return hydrated ? [hydrated] : [];
        });
      }
    } else {
      rows = await this.prisma.publication.findMany({
        where: publicationWhere,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: parsed.data.limit + 1,
        include: this.publicationPresenterService.publicationSummaryInclude(publisherScope),
      });
    }

    const hasMore = rows.length > parsed.data.limit;
    const page = hasMore ? rows.slice(0, parsed.data.limit) : rows;
    const presentation = await this.publicationPresenterService.loadPublicationListPresentation({
      rows: page,
      actorUserId: user.userId,
      dispatchProfile,
      publisherBotId,
    });
    const items: PublicationSummary[] = await Promise.all(
      page.map((row) =>
        this.publicationPresenterService.mapPublicationSummary(
          row,
          presentation.deliveryStats.get(row.id),
          presentation.actionableDeliveryStats.get(row.id),
          presentation.publisherTargetPresentations,
          presentation.dispatchIssues.byPublicationId.get(row.id) ?? null,
        ),
      ),
    );
    const last = page.at(-1);
    const lastFailedIdentifier =
      usesSqlPageSelector && last ? failedPageIdentifiers.find((row) => row.id === last.id) : null;

    return listPublicationsResponseSchema.parse({
      items,
      nextCursor:
        hasMore && last
          ? encodePublicationListCursor({
              v: 1,
              updatedAt: (lastFailedIdentifier?.updatedAt ?? last.updatedAt).toISOString(),
              id: last.id,
              view: parsed.data.view,
              query: parsed.data.query,
              entityType: parsed.data.entityType,
              status: parsed.data.status,
            })
          : null,
    });
  }

  async getCalendarAvailability(
    user: AuthUser,
    body: unknown,
    dispatchProfile: PublicationDispatchProfile = PublicationDispatchProfile.PUBLIK_V1,
  ): Promise<PublicationCalendarAvailabilityResponse> {
    const parsed = publicationCalendarAvailabilityRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const request = parsed.data;
    this.assertNewPublicationProfile(dispatchProfile);
    const excludedPublication = request.excludePublicationId
      ? await this.assertPublicationOwner(
          request.excludePublicationId,
          user.userId,
          dispatchProfile,
        )
      : null;
    const targetDispatchProfile =
      excludedPublication?.dispatchProfile ??
      this.publisherRouting.requireNewRoute().dispatchProfile;
    const targets = await this.resolveAudienceTargets(
      user,
      request.audience,
      targetDispatchProfile,
    );
    const from = new Date(request.from);
    const to = new Date(request.to);
    const targetKeys = new Set(
      targets.map((target) => `${this.toPrismaEntityType(target.entityType)}:${target.chatId}`),
    );
    const targetPredicates = buildPublicationCalendarTargetPredicates(targets);
    const [reservations, occurrences] = await Promise.all([
      this.prisma.managedBroadcastCalendarReservation.findMany({
        where: {
          scheduledAt: { gte: from, lte: to },
          OR: targetPredicates,
          broadcast: {
            is: {
              dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
              status: {
                in: [
                  ManagedBroadcastStatus.ACTIVE,
                  ManagedBroadcastStatus.PARTIAL,
                  ManagedBroadcastStatus.FAILED,
                ],
              },
            },
          },
        },
        select: {
          entityType: true,
          targetChatId: true,
          scheduledAt: true,
          broadcast: {
            select: {
              publicationOccurrence: { select: { publicationId: true } },
            },
          },
        },
      }),
      this.prisma.publicationOccurrence.findMany({
        where: {
          ...(request.excludePublicationId
            ? { publicationId: { not: request.excludePublicationId } }
            : {}),
          scheduledAt: { gte: from, lte: to },
          status: {
            in: [PublicationOccurrenceStatus.SCHEDULED, PublicationOccurrenceStatus.IN_PROGRESS],
          },
          schedule: {
            is: {
              status: {
                in: [PublicationScheduleStatus.ACTIVE, PublicationScheduleStatus.ERROR],
              },
            },
          },
          publication: {
            is: {
              dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
              lifecycle: { in: [PublicationLifecycle.ACTIVE, PublicationLifecycle.ERROR] },
              targets: { some: { OR: targetPredicates, canceledAt: null } },
            },
          },
        },
        select: {
          scheduledAt: true,
          publication: {
            select: {
              targets: {
                where: { canceledAt: null },
                select: { targetChatId: true, entityType: true },
              },
            },
          },
        },
      }),
    ]);

    const slots = new Map<string, { scheduledAt: Date; targetKeys: Set<string> }>();
    const addSlot = (scheduledAt: Date, targetKey: string) => {
      const key = scheduledAt.toISOString();
      const current = slots.get(key) ?? { scheduledAt, targetKeys: new Set<string>() };
      current.targetKeys.add(targetKey);
      slots.set(key, current);
    };

    for (const reservation of reservations) {
      if (
        reservation.broadcast.publicationOccurrence?.publicationId === request.excludePublicationId
      ) {
        continue;
      }
      const targetKey = `${reservation.entityType}:${reservation.targetChatId}`;
      if (targetKeys.has(targetKey)) {
        addSlot(reservation.scheduledAt, targetKey);
      }
    }
    for (const occurrence of occurrences) {
      for (const target of occurrence.publication.targets) {
        const targetKey = `${target.entityType}:${target.targetChatId}`;
        if (targetKeys.has(targetKey)) {
          addSlot(occurrence.scheduledAt, targetKey);
        }
      }
    }

    return publicationCalendarAvailabilityResponseSchema.parse({
      from: from.toISOString(),
      to: to.toISOString(),
      slots: [...slots.values()]
        .sort((left, right) => left.scheduledAt.getTime() - right.scheduledAt.getTime())
        .map((slot) => ({
          scheduledAt: slot.scheduledAt.toISOString(),
          targetCount: slot.targetKeys.size,
        })),
    });
  }

  async get(
    publicationId: string,
    user: AuthUser,
    dispatchProfile?: PublicationDispatchProfile,
  ): Promise<PublicationDetails> {
    const row = await this.publicationPresenterService.loadPublicationDetailsRow(
      publicationId,
      user.userId,
      dispatchProfile,
      dispatchProfile === PublicationDispatchProfile.PUBLIK_V1
        ? this.publisherRouting.requireNewRoute().requiredBotId
        : undefined,
    );
    if (!row || (dispatchProfile && row.dispatchProfile !== dispatchProfile)) {
      throw new NotFoundException('Публикация не найдена.');
    }
    const publisherTargetPresentations =
      row.dispatchProfile === PublicationDispatchProfile.PUBLIK_V1
        ? await this.publicationPresenterService.loadPublisherTargetPresentations(
            row.targets,
            this.publisherRouting.requireNewRoute().requiredBotId,
          )
        : undefined;
    return this.publicationPresenterService.mapPublicationDetails(
      row,
      publisherTargetPresentations,
    );
  }

  async create(
    user: AuthUser,
    body: unknown,
    dispatchProfile: PublicationDispatchProfile = PublicationDispatchProfile.PUBLIK_V1,
  ): Promise<PublicationDetails> {
    const parsed = createPublicationRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const request = this.normalizeCreateRequest(parsed.data);
    this.assertNewPublicationProfile(dispatchProfile);
    const requestHash = this.hashMutationRequest(request);
    const replay = await this.findMutationReplay(user.userId, request.requestId, requestHash);
    if (replay) {
      await this.get(replay.publicationId, user, dispatchProfile);
      await this.publisherPublicationWakeupQueue.enqueueAfterCommittedMutation({
        publicationId: replay.publicationId,
        mutationRequestId: request.requestId,
        reason: 'create',
      });
      return this.get(replay.publicationId, user, dispatchProfile);
    }
    const dispatchRoute = this.publisherRouting.requireNewRoute();

    const targets = await this.resolveAudienceTargets(
      user,
      request.audience,
      dispatchRoute.dispatchProfile,
    );
    if (request.intent === 'publish') {
      await this.publisherRouting.assertTargetsReady(targets, dispatchRoute.requiredBotId);
    }
    const now = new Date();
    const schedule = request.schedule
      ? this.normalizeSchedule(withDefaultPublicationLatePolicy(request.schedule), now)
      : null;
    const initialSlots = schedule ? this.expandInitialSchedule(schedule, now) : [];
    const initialScheduleExhausted = this.isInitialRecurrenceExhausted(schedule, initialSlots, now);
    if (request.intent === 'publish') {
      this.assertPublishableSchedule(schedule, initialSlots, now);
      await this.assertCalendarAvailability(targets, initialSlots, schedule, user.userId);
    }
    const initialNextMaterializeAt =
      request.intent === 'publish'
        ? this.resolveInitialRecurrenceMaterializeAt(
            schedule,
            initialSlots,
            initialScheduleExhausted,
            now,
          )
        : null;
    const preparedContent = await this.publicationContentService.prepareContentRevision(
      request.content,
    );
    await this.publicationContentService.assertPublisherCompatibleContent(
      preparedContent,
      user.userId,
    );

    let publicationId: string;
    try {
      publicationId = await this.prisma.$transaction(async (tx: any) => {
        const publication = await tx.publication.create({
          data: {
            actorUserId: user.userId,
            requestId: request.requestId,
            title: request.title,
            lifecycle:
              request.intent === 'draft' ? PublicationLifecycle.DRAFT : PublicationLifecycle.ACTIVE,
            audienceSelection: request.audience.selection as PublicationAudienceSelection,
            audienceMode: request.audience.mode as PublicationAudienceMode,
            dispatchProfile: dispatchRoute.dispatchProfile,
            requiredBotId: dispatchRoute.requiredBotId,
            targets: {
              create: targets.map((target, position) => ({
                targetChatId: target.chatId,
                entityType: this.toPrismaEntityType(target.entityType),
                position,
              })),
            },
          },
          select: { id: true },
        });

        const contentRevision = await this.publicationContentService.persistPreparedContentRevision(
          tx,
          publication.id,
          1,
          preparedContent,
          user.userId,
        );
        await tx.publication.update({
          where: { id: publication.id },
          data: { canonicalContentRevisionId: contentRevision.id },
        });

        if (schedule) {
          if (request.intent === 'publish' && initialSlots.length > 0) {
            await this.reservePublicationCalendar(
              tx,
              targets,
              initialSlots,
              schedule,
              publication.id,
              user.userId,
            );
          }
          const persistedSchedule = await tx.publicationSchedule.create({
            data: {
              publicationId: publication.id,
              mode: this.toPrismaScheduleMode(schedule.mode),
              timezone: schedule.timezone,
              rule: schedule as Prisma.InputJsonValue,
              status:
                request.intent === 'draft'
                  ? PublicationScheduleStatus.DRAFT
                  : PublicationScheduleStatus.ACTIVE,
              nextMaterializeAt: initialNextMaterializeAt,
              lastMaterializedAt: request.intent === 'publish' ? now : null,
            },
            select: { id: true, revision: true },
          });
          if (request.intent === 'publish' && initialSlots.length > 0) {
            await tx.publicationOccurrence.createMany({
              data: initialSlots.map((scheduledAt) => ({
                publicationId: publication.id,
                scheduleId: persistedSchedule.id,
                contentRevisionId: contentRevision.id,
                scheduleRevision: persistedSchedule.revision,
                scheduledAt,
                deliveryDeadlineAt: snapshotPublicationDeliveryDeadline(scheduledAt, schedule),
                dispatchProfile: dispatchRoute.dispatchProfile,
                requiredBotId: dispatchRoute.requiredBotId,
              })),
              skipDuplicates: true,
            });
          }
        }

        await tx.publicationMutationRecord.create({
          data: {
            actorUserId: user.userId,
            requestId: request.requestId,
            requestHash,
            publicationId: publication.id,
            resultingVersion: 1,
          },
        });
        return publication.id;
      });
    } catch (error: unknown) {
      if (isPrismaKnownError(error, 'P2002') || error instanceof ConflictException) {
        const concurrentReplay = await this.findMutationReplay(
          user.userId,
          request.requestId,
          requestHash,
        );
        if (concurrentReplay) {
          await this.publisherPublicationWakeupQueue.enqueueAfterCommittedMutation({
            publicationId: concurrentReplay.publicationId,
            mutationRequestId: request.requestId,
            reason: 'create',
          });
          return this.get(concurrentReplay.publicationId, user, dispatchProfile);
        }
      }
      throw error;
    }

    await this.publisherPublicationWakeupQueue.enqueueAfterCommittedMutation({
      publicationId,
      mutationRequestId: request.requestId,
      reason: 'create',
    });
    return this.get(publicationId, user, dispatchProfile);
  }

  async update(
    publicationId: string,
    user: AuthUser,
    body: unknown,
    dispatchProfile?: PublicationDispatchProfile,
  ): Promise<PublicationDetails> {
    const parsed = updatePublicationRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const request = this.normalizeUpdateRequest(parsed.data);
    const requestHash = this.hashMutationRequest({ publicationId, ...request });
    const replay = await this.findMutationReplay(user.userId, request.requestId, requestHash);
    if (replay) {
      await this.assertPublicationOwner(publicationId, user.userId, dispatchProfile);
      this.assertReplayPublication(replay.publicationId, publicationId);
      await this.publisherPublicationWakeupQueue.enqueueAfterCommittedMutation({
        publicationId,
        mutationRequestId: request.requestId,
        reason: 'update',
      });
      return this.get(publicationId, user, dispatchProfile);
    }
    const existing = await this.prisma.publication.findFirst({
      where: {
        id: publicationId,
        ...this.publicationAccessWhere(user.userId, dispatchProfile),
        ...(dispatchProfile ? { dispatchProfile } : {}),
      },
      include: {
        schedule: true,
        targets: { orderBy: { position: 'asc' } },
        canonicalContentRevision: true,
      },
    });
    if (!existing) {
      throw new NotFoundException('Публикация не найдена.');
    }
    if (
      existing.lifecycle === PublicationLifecycle.CANCELED ||
      existing.lifecycle === PublicationLifecycle.COMPLETED
    ) {
      throw new ConflictException('Завершённую публикацию нельзя изменить. Создайте копию.');
    }
    if (existing.version !== request.expectedRevision) {
      throw new ConflictException({
        code: 'PUBLICATION_REVISION_CONFLICT',
        message: 'Публикация уже изменена. Обновите экран и повторите правку.',
        currentRevision: existing.version,
      });
    }
    const audienceChanged =
      request.audience !== undefined &&
      !this.isPublicationAudienceEquivalent(request.audience, existing);
    const rootProfile = existing.dispatchProfile;
    let targets: ResolvedPublicationTarget[];
    if (audienceChanged && request.audience) {
      if (!isImportedEmptyPublicationDraft(existing)) {
        await this.resolvePersistedPublicationTargets(user, existing.targets, rootProfile);
      }
      targets = await this.resolveAudienceTargets(user, request.audience, rootProfile);
    } else {
      targets = await this.resolvePersistedPublicationTargets(user, existing.targets, rootProfile);
    }
    const now = new Date();
    const existingSchedule =
      existing.schedule && existing.schedule.status !== PublicationScheduleStatus.DRAFT
        ? publicationScheduleInputSchema.parse(existing.schedule.rule)
        : null;
    const previousSchedulePolicy =
      existingSchedule ??
      (existing.schedule?.status === PublicationScheduleStatus.DRAFT
        ? (publicationScheduleInputSchema.safeParse(existing.schedule.rule).data ?? null)
        : null);
    const schedule =
      request.schedule === undefined
        ? existingSchedule
        : request.schedule === null
          ? null
          : withPreservedPublicationLatePolicy(
              this.normalizeSchedule(request.schedule, now),
              previousSchedulePolicy,
              existingSchedule !== null,
              (previous, schedule) =>
                this.arePublicationSchedulesEquivalent(previous, schedule, true),
            );
    const desiredIntent =
      request.intent ?? (existing.lifecycle === PublicationLifecycle.DRAFT ? 'draft' : 'publish');
    if (desiredIntent === 'publish' && !schedule) {
      throw new BadRequestException('Выберите время публикации.');
    }
    if (
      desiredIntent === 'publish' &&
      existing.dispatchProfile === PublicationDispatchProfile.PUBLIK_V1
    ) {
      await this.publisherRouting.assertTargetsReady(targets, existing.requiredBotId);
    }
    const currentIntent = existing.lifecycle === PublicationLifecycle.DRAFT ? 'draft' : 'publish';
    const scheduleChanged =
      request.schedule !== undefined &&
      !this.arePublicationSchedulesEquivalent(existingSchedule, schedule);
    const scheduleRebuildRequested =
      audienceChanged || scheduleChanged || desiredIntent !== currentIntent;
    const repairErroredSchedule =
      !scheduleRebuildRequested &&
      request.schedule !== undefined &&
      request.intent === 'publish' &&
      rootProfile === PublicationDispatchProfile.PUBLIK_V1 &&
      existing.lifecycle !== PublicationLifecycle.PAUSED &&
      schedule?.mode === 'recurrence' &&
      existing.schedule?.status === PublicationScheduleStatus.ERROR;
    if (repairErroredSchedule && schedule.maxOccurrences !== null) {
      throw new BadRequestException('Для перезапуска серии с лимитом задайте новое расписание.');
    }
    const shouldRebuildSchedule = scheduleRebuildRequested || repairErroredSchedule;
    PublicationPublisherRoutingService.assertRootUpdateAllowed(
      existing.dispatchProfile,
      shouldRebuildSchedule || request.content !== undefined,
    );
    const initialSlots =
      desiredIntent === 'publish' && schedule && shouldRebuildSchedule
        ? this.expandInitialSchedule(schedule, now)
        : [];
    const scheduleExhausted = this.isInitialRecurrenceExhausted(schedule, initialSlots, now);
    if (desiredIntent === 'publish' && shouldRebuildSchedule) {
      this.assertPublishableSchedule(schedule, initialSlots, now);
      await this.assertCalendarAvailability(
        targets,
        initialSlots,
        schedule,
        user.userId,
        publicationId,
      );
    }
    const initialNextMaterializeAt =
      desiredIntent === 'publish' &&
      shouldRebuildSchedule &&
      existing.lifecycle !== PublicationLifecycle.PAUSED
        ? this.resolveInitialRecurrenceMaterializeAt(schedule, initialSlots, scheduleExhausted, now)
        : null;
    const preparedContent = request.content
      ? await this.publicationContentService.prepareContentRevision(request.content)
      : null;
    if (preparedContent && existing.dispatchProfile === PublicationDispatchProfile.PUBLIK_V1) {
      await this.publicationContentService.assertPublisherCompatibleContent(
        preparedContent,
        user.userId,
        publicationId,
      );
    }
    const nextVersion = existing.version + 1;
    try {
      await this.prisma.$transaction(async (tx: any) => {
        const calendarAlreadyLocked = shouldRebuildSchedule || preparedContent !== null;
        if (calendarAlreadyLocked) {
          await this.lockPublicationCalendar(tx);
        }
        const updated = await tx.publication.updateMany({
          where: {
            id: publicationId,
            ...this.publicationAccessWhere(user.userId, existing.dispatchProfile),
            dispatchProfile: existing.dispatchProfile,
            version: request.expectedRevision,
            lifecycle: existing.lifecycle,
          },
          data: {
            version: { increment: 1 },
            ...(request.title !== undefined ? { title: request.title } : {}),
            ...(audienceChanged && request.audience
              ? {
                  audienceSelection: request.audience.selection as PublicationAudienceSelection,
                  audienceMode: request.audience.mode as PublicationAudienceMode,
                }
              : {}),
            lifecycle:
              desiredIntent === 'draft'
                ? PublicationLifecycle.DRAFT
                : existing.lifecycle === PublicationLifecycle.PAUSED
                  ? PublicationLifecycle.PAUSED
                  : rootProfile === PublicationDispatchProfile.PUBLIK_V1 &&
                      !shouldRebuildSchedule &&
                      existing.schedule?.status === PublicationScheduleStatus.ERROR
                    ? PublicationLifecycle.ERROR
                    : PublicationLifecycle.ACTIVE,
          },
        });
        if (updated.count === 0) {
          throw new ConflictException({
            code: 'PUBLICATION_REVISION_CONFLICT',
            message: 'Публикация уже изменена. Обновите экран и повторите правку.',
          });
        }
        let contentRevisionId = existing.canonicalContentRevisionId;
        if (preparedContent) {
          const contentRevision =
            await this.publicationContentService.persistPreparedContentRevision(
              tx,
              publicationId,
              nextVersion,
              preparedContent,
              user.userId,
            );
          contentRevisionId = contentRevision.id;
          await tx.publication.update({
            where: { id: publicationId },
            data: { canonicalContentRevisionId: contentRevision.id },
          });
        }
        if (!contentRevisionId) {
          throw new BadRequestException('Содержимое публикации не найдено.');
        }
        if (audienceChanged && request.audience) {
          await tx.publicationTarget.deleteMany({ where: { publicationId } });
          await tx.publicationTarget.createMany({
            data: targets.map((target, position) => ({
              publicationId,
              targetChatId: target.chatId,
              entityType: this.toPrismaEntityType(target.entityType),
              position,
              canceledAt:
                existing.targets.find((saved) => saved.targetChatId === target.chatId)
                  ?.canceledAt ?? null,
            })),
          });
        }
        if (shouldRebuildSchedule) {
          await this.cancelFuturePublicationWork(tx, publicationId, now, initialSlots);
          if (desiredIntent === 'publish' && schedule && initialSlots.length > 0) {
            await this.reservePublicationCalendar(
              tx,
              targets,
              initialSlots,
              schedule,
              publicationId,
              user.userId,
              calendarAlreadyLocked,
            );
          }
          if (!schedule) {
            if (existing.schedule) {
              await tx.publicationSchedule.update({
                where: { publicationId },
                data: {
                  revision: { increment: 1 },
                  status: PublicationScheduleStatus.DRAFT,
                  nextMaterializeAt: null,
                  lastError: null,
                },
              });
            }
          } else if (existing.schedule) {
            const scheduleRevision = existing.schedule.revision + 1;
            const persistedSchedule = await tx.publicationSchedule.update({
              where: { publicationId },
              data: {
                mode: this.toPrismaScheduleMode(schedule.mode),
                timezone: schedule.timezone,
                rule: schedule as Prisma.InputJsonValue,
                revision: scheduleRevision,
                status:
                  desiredIntent === 'draft'
                    ? PublicationScheduleStatus.DRAFT
                    : existing.lifecycle === PublicationLifecycle.PAUSED
                      ? PublicationScheduleStatus.PAUSED
                      : PublicationScheduleStatus.ACTIVE,
                nextMaterializeAt: initialNextMaterializeAt,
                lastMaterializedAt: desiredIntent === 'publish' ? now : null,
                lastError: null,
              },
              select: { id: true },
            });
            if (desiredIntent === 'publish' && initialSlots.length > 0) {
              await tx.publicationOccurrence.createMany({
                data: initialSlots.map((scheduledAt) => ({
                  publicationId,
                  scheduleId: persistedSchedule.id,
                  contentRevisionId,
                  scheduleRevision,
                  scheduledAt,
                  deliveryDeadlineAt: snapshotPublicationDeliveryDeadline(scheduledAt, schedule),
                  dispatchProfile: existing.dispatchProfile,
                  requiredBotId: existing.requiredBotId,
                })),
                skipDuplicates: true,
              });
            }
          } else {
            const persistedSchedule = await tx.publicationSchedule.create({
              data: {
                publicationId,
                mode: this.toPrismaScheduleMode(schedule.mode),
                timezone: schedule.timezone,
                rule: schedule as Prisma.InputJsonValue,
                status:
                  desiredIntent === 'draft'
                    ? PublicationScheduleStatus.DRAFT
                    : PublicationScheduleStatus.ACTIVE,
                nextMaterializeAt: initialNextMaterializeAt,
                lastMaterializedAt: desiredIntent === 'publish' ? now : null,
              },
              select: { id: true, revision: true },
            });
            if (desiredIntent === 'publish' && initialSlots.length > 0) {
              await tx.publicationOccurrence.createMany({
                data: initialSlots.map((scheduledAt) => ({
                  publicationId,
                  scheduleId: persistedSchedule.id,
                  contentRevisionId,
                  scheduleRevision: persistedSchedule.revision,
                  scheduledAt,
                  deliveryDeadlineAt: snapshotPublicationDeliveryDeadline(scheduledAt, schedule),
                  dispatchProfile: existing.dispatchProfile,
                  requiredBotId: existing.requiredBotId,
                })),
                skipDuplicates: true,
              });
            }
          }
        } else if (request.content) {
          const scheduledOccurrenceWhere = {
            publicationId,
            ...(existing.schedule
              ? {
                  scheduleId: existing.schedule.id,
                  scheduleRevision: existing.schedule.revision,
                }
              : {}),
            status: PublicationOccurrenceStatus.SCHEDULED,
          };
          const broadcasts = await tx.managedBroadcast.findMany({
            where: { publicationOccurrence: { is: scheduledOccurrenceWhere } },
            select: { id: true, lockedAt: true, lockToken: true },
          });
          await reviseUnstartedPublicationExecutionBroadcasts(
            tx,
            broadcasts,
            {
              text: request.content.text,
              textFormat: request.content.textFormat,
              buttons: request.content.buttons.map(({ text, url }) => ({
                text,
                url,
              })) as Prisma.InputJsonValue,
              buttonEnabled: request.content.buttons.length > 0,
              buttonUrl: request.content.buttons[0]?.url ?? '',
              buttonText: request.content.buttons[0]?.text ?? 'Открыть',
              publicationContentRevisionId: contentRevisionId,
              imageEnabled: false,
              imageBase64: '',
              imageMimeType: '',
              imageFileName: '',
              mediaType: null,
              mediaPayload: Prisma.DbNull,
              mediaMimeType: '',
              mediaFileName: '',
            },
            'Публикация уже начала отправку. Проверьте доставки отдельно.',
          );
          await tx.publicationOccurrence.updateMany({
            where: scheduledOccurrenceWhere,
            data: { contentRevisionId },
          });
          await tx.managedBroadcastDelivery.updateMany({
            where: {
              publicationOccurrence: {
                is: scheduledOccurrenceWhere,
              },
              status: ManagedBroadcastDeliveryStatus.PENDING,
            },
            data: {
              contentRevisionId,
              ...publicationPostActionsInitialData(request.content.postPublish, new Date()),
            },
          });
        }
        await tx.publicationMutationRecord.create({
          data: {
            actorUserId: user.userId,
            requestId: request.requestId,
            requestHash,
            publicationId,
            resultingVersion: nextVersion,
          },
        });
      });
    } catch (error: unknown) {
      if (isPrismaKnownError(error, 'P2002') || error instanceof ConflictException) {
        const concurrentReplay = await this.findMutationReplay(
          user.userId,
          request.requestId,
          requestHash,
        );
        if (concurrentReplay) {
          this.assertReplayPublication(concurrentReplay.publicationId, publicationId);
          await this.publisherPublicationWakeupQueue.enqueueAfterCommittedMutation({
            publicationId,
            mutationRequestId: request.requestId,
            reason: 'update',
          });
          return this.get(publicationId, user, dispatchProfile);
        }
      }
      throw error;
    }
    await this.publisherPublicationWakeupQueue.enqueueAfterCommittedMutation({
      publicationId,
      mutationRequestId: request.requestId,
      reason: 'update',
    });
    return this.get(publicationId, user, dispatchProfile);
  }

  async sendTest(user: AuthUser, body: unknown) {
    const parsed = testPublicationRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const request = parsed.data;
    await this.assertTargetAdminAccess(request.sourceTarget, user);
    const legacyPayload = await this.publicationContentService.buildLegacyTestPayload(
      request,
      user.userId,
    );
    return request.sourceTarget.entityType === 'channel'
      ? this.managedBroadcastService.sendPublicationChannelBroadcastTest(
          request.sourceTarget.chatId,
          user,
          legacyPayload,
        )
      : this.managedBroadcastService.sendPublicationBroadcastTest(
          request.sourceTarget.chatId,
          user,
          legacyPayload,
        );
  }

  async pause(
    publicationId: string,
    user: AuthUser,
    body: unknown,
    dispatchProfile?: PublicationDispatchProfile,
  ): Promise<PublicationDetails> {
    return this.transitionPublication(publicationId, user, body, 'pause', dispatchProfile);
  }

  async resume(
    publicationId: string,
    user: AuthUser,
    body: unknown,
    dispatchProfile?: PublicationDispatchProfile,
  ): Promise<PublicationDetails> {
    return this.transitionPublication(publicationId, user, body, 'resume', dispatchProfile);
  }

  async cancel(
    publicationId: string,
    user: AuthUser,
    body: unknown,
    dispatchProfile?: PublicationDispatchProfile,
  ): Promise<PublicationDetails> {
    if (
      dispatchProfile === PublicationDispatchProfile.PUBLIK_V1 &&
      (await tryCancelAccessiblePublicationTargets(
        this.prisma,
        publicationAdminScope(user.userId, this.publisherRouting.requireNewRoute().requiredBotId),
        publicationId,
        body,
        (value) => this.hashMutationRequest(value),
        (requestId, hash) => this.findMutationReplay(user.userId, requestId, hash),
      ))
    ) {
      return this.get(publicationId, user, dispatchProfile);
    }
    return this.transitionPublication(publicationId, user, body, 'cancel', dispatchProfile);
  }

  async listDeliveries(
    publicationId: string,
    user: AuthUser,
    query: unknown,
    dispatchProfile?: PublicationDispatchProfile,
  ): Promise<ListPublicationDeliveriesResponse> {
    const publication = await this.assertPublicationOwner(
      publicationId,
      user.userId,
      dispatchProfile,
      'read',
    );
    const parsed = listPublicationDeliveriesQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    const rows = await this.prisma.managedBroadcastDelivery.findMany({
      where: {
        ...(publication.dispatchProfile === PublicationDispatchProfile.PUBLIK_V1
          ? { targetChatId: { in: publication.targets.map((target) => target.targetChatId) } }
          : {}),
        publicationOccurrence: {
          is: {
            publicationId,
            ...(parsed.data.occurrenceId ? { id: parsed.data.occurrenceId } : {}),
          },
        },
        ...buildEffectiveDeliveryListWhere(parsed.data),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: parsed.data.limit + 1,
      ...(parsed.data.cursor ? { cursor: { id: parsed.data.cursor }, skip: 1 } : {}),
      include: PUBLICATION_DELIVERY_PRESENTATION_INCLUDE,
    });
    const hasMore = rows.length > parsed.data.limit;
    const page = hasMore ? rows.slice(0, parsed.data.limit) : rows;
    const publisherTargetPresentations =
      publication.dispatchProfile === PublicationDispatchProfile.PUBLIK_V1
        ? await this.publicationPresenterService.loadPublisherTargetPresentations(
            page.map((row) => ({
              targetChatId: row.targetChatId,
              entityType: row.broadcast.entityType,
            })),
            this.publisherRouting.requireNewRoute().requiredBotId,
          )
        : undefined;
    const chats = publisherTargetPresentations
      ? []
      : await this.prisma.chat.findMany({
          where: { id: { in: [...new Set(page.map((row) => row.targetChatId))] } },
          select: { id: true, title: true },
        });
    const chatTitleById = new Map(chats.map((chat) => [chat.id, chat.title]));

    return listPublicationDeliveriesResponseSchema.parse({
      items: page.map((row) => ({
        id: row.id,
        occurrenceId: row.publicationOccurrence?.id ?? '',
        target: this.publicationPresenterService.mapTarget(
          {
            targetChatId: row.targetChatId,
            entityType: row.broadcast.entityType,
            chat: { title: chatTitleById.get(row.targetChatId) ?? null },
          },
          publication.dispatchProfile,
          publisherTargetPresentations,
        ),
        status: resolveEffectivePublicationDeliveryStatus(row),
        dispatchStopped: isPublicationDeliveryDispatchStopped(row),
        ...this.publicationPresenterService.mapDeliveryContentRevision(row),
        ...mapPublicationDeliveryWait(row),
        attemptCount: row.attemptCount,
        remoteMessageId: row.remoteMessageId,
        lastError: row.lastError,
        sentAt: row.sentAt?.toISOString() ?? null,
        postActions: mapPublicationPostActions(row, row.contentRevision?.postPublish),
      })),
      nextCursor: hasMore ? (page.at(-1)?.id ?? null) : null,
    });
  }

  async retryOccurrence(
    publicationId: string,
    occurrenceId: string,
    user: AuthUser,
    body: unknown,
    dispatchProfile?: PublicationDispatchProfile,
  ): Promise<PublicationDetails> {
    const parsed = retryPublicationOccurrenceRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const requestHash = this.hashMutationRequest({ publicationId, occurrenceId, ...parsed.data });
    const replay = await this.findMutationReplay(user.userId, parsed.data.requestId, requestHash);
    if (replay) {
      await this.assertPublicationOwner(publicationId, user.userId, dispatchProfile);
      this.assertReplayPublication(replay.publicationId, publicationId);
      await this.publisherPublicationWakeupQueue.enqueueAfterCommittedMutation({
        publicationId,
        mutationRequestId: parsed.data.requestId,
        occurrenceId,
        reason: 'retry',
      });
      return this.get(publicationId, user, dispatchProfile);
    }
    const publication = await this.assertPublicationOwner(
      publicationId,
      user.userId,
      dispatchProfile,
    );
    await this.resolvePersistedPublicationTargets(
      user,
      publication.targets,
      publication.dispatchProfile,
    );
    if (
      publication.lifecycle !== PublicationLifecycle.ACTIVE &&
      publication.lifecycle !== PublicationLifecycle.ERROR
    ) {
      throw new ConflictException('Повтор доступен только для активной публикации с ошибкой.');
    }
    const occurrence = await this.prisma.publicationOccurrence.findFirst({
      where: { id: occurrenceId, publicationId },
      include: {
        schedule: { select: { id: true, mode: true } },
        contentRevision: { select: { revision: true, postPublish: true } },
        _count: { select: { deliveries: true, legacyBroadcasts: true } },
      },
    });
    if (!occurrence) {
      throw new NotFoundException('Запуск публикации не найден.');
    }
    if (!publicationManualRetrySafety.isRetryablePublicationOccurrenceStatus(occurrence.status)) {
      throw new ConflictException('Этот запуск больше нельзя повторить. Обновите экран.');
    }
    const retryableDeliveryWhere =
      publicationManualRetrySafety.buildRetryablePublicationDeliveryWhere();
    const retryableDeliveryCount = await this.prisma.managedBroadcastDelivery.count({
      where: {
        publicationOccurrenceId: occurrenceId,
        ...retryableDeliveryWhere,
      },
    });
    const retryWithoutExecutionEnvelope =
      retryableDeliveryCount === 0 &&
      occurrence.status === PublicationOccurrenceStatus.FAILED &&
      occurrence.legacyBroadcastId === null &&
      occurrence._count.deliveries === 0 &&
      occurrence._count.legacyBroadcasts === 0;
    if (retryableDeliveryCount === 0 && !retryWithoutExecutionEnvelope) {
      throw new ConflictException(
        'Нет доставок, которые можно безопасно повторить. Неоднозначные отправки сначала нужно проверить.',
      );
    }
    const contentMode = parsed.data.contentMode ?? 'original';
    const retryContentRevisionId =
      contentMode === 'latest'
        ? publication.canonicalContentRevisionId
        : occurrence.contentRevisionId;
    if (!retryContentRevisionId) {
      throw new ConflictException('Содержимое публикации больше недоступно.');
    }
    let latestContent: PublicationPostActionRetryContent | null = null;
    if (contentMode === 'latest') {
      if (
        parsed.data.expectedPublicationVersion !== publication.version ||
        !publication.canonicalContentRevisionId
      ) {
        throw new ConflictException({
          code: 'PUBLICATION_REVISION_CONFLICT',
          message: 'Публикация уже изменена. Обновите экран и повторите действие.',
        });
      }
      latestContent = await this.prisma.publicationContentRevision.findFirst({
        where: { id: publication.canonicalContentRevisionId, publicationId },
        select: {
          id: true,
          revision: true,
          text: true,
          textFormat: true,
          buttons: true,
          postPublish: true,
        },
      });
      if (!latestContent || parsed.data.expectedContentRevision !== latestContent.revision) {
        throw new ConflictException({
          code: 'PUBLICATION_REVISION_CONFLICT',
          message: 'Содержимое публикации уже изменено. Обновите экран.',
        });
      }
    }
    try {
      await this.prisma.$transaction(async (tx: any) => {
        // FLAG: Delivery retry changes only definitively failed or provably untouched PENDING
        // targets. SENT and AMBIGUOUS deliveries retain their recorded content revision. A
        // missing-envelope retry is allowed only when both execution broadcasts and deliveries
        // are still absent under the transaction lock.
        await this.lockPublicationCalendar(tx);
        const retryLockToken = `publication-retry:${randomUUID()}`;
        const retryLockedAt = new Date();
        let retryableBroadcastIds: string[] = [];
        if (!retryWithoutExecutionEnvelope) {
          const retryableBroadcasts = await tx.managedBroadcast.findMany({
            where: {
              publicationOccurrenceId: occurrenceId,
              status: { in: publicationManualRetrySafety.RETRYABLE_PUBLICATION_BROADCAST_STATUSES },
              deliveries: {
                some: {
                  publicationOccurrenceId: occurrenceId,
                  ...retryableDeliveryWhere,
                },
              },
            },
            select: { id: true },
          });
          retryableBroadcastIds = retryableBroadcasts.map(
            (broadcast: { id: string }) => broadcast.id,
          );
          if (retryableBroadcastIds.length === 0) {
            throw new ConflictException('Не осталось доставок для безопасного повтора.');
          }
          const claimedBroadcasts = await tx.managedBroadcast.updateMany({
            where: {
              id: { in: retryableBroadcastIds },
              publicationOccurrenceId: occurrenceId,
              status: { in: publicationManualRetrySafety.RETRYABLE_PUBLICATION_BROADCAST_STATUSES },
              lockedAt: null,
              lockToken: null,
              deliveries: {
                some: {
                  publicationOccurrenceId: occurrenceId,
                  ...retryableDeliveryWhere,
                },
                none: {
                  publicationOccurrenceId: occurrenceId,
                  OR: [
                    {
                      status: {
                        in: [
                          ManagedBroadcastDeliveryStatus.SENDING,
                          ManagedBroadcastDeliveryStatus.AMBIGUOUS,
                        ],
                      },
                    },
                    publicationManualRetrySafety.buildUnsafePendingPublicationDeliveryWhere(),
                  ],
                },
              },
            },
            data: { lockedAt: retryLockedAt, lockToken: retryLockToken },
          });
          if (claimedBroadcasts.count !== retryableBroadcastIds.length) {
            throw new ConflictException({
              code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW',
              message: 'Доставка уже обрабатывается или требует проверки.',
            });
          }
        }
        const activatedPublication = await tx.publication.updateMany({
          where: {
            id: publicationId,
            ...this.publicationAccessWhere(user.userId, publication.dispatchProfile),
            dispatchProfile: publication.dispatchProfile,
            lifecycle: { in: [PublicationLifecycle.ACTIVE, PublicationLifecycle.ERROR] },
            ...(contentMode === 'latest'
              ? {
                  version: parsed.data.expectedPublicationVersion,
                  canonicalContentRevisionId: retryContentRevisionId,
                }
              : {}),
          },
          data: { lifecycle: PublicationLifecycle.ACTIVE },
        });
        if (activatedPublication.count === 0) {
          throw new ConflictException('Публикация больше не активна.');
        }
        const activatedSchedule = await tx.publicationSchedule.updateMany({
          where: {
            id: occurrence.scheduleId,
            revision: occurrence.scheduleRevision,
            status: { in: [PublicationScheduleStatus.ACTIVE, PublicationScheduleStatus.ERROR] },
            publication: { is: { id: publicationId, lifecycle: PublicationLifecycle.ACTIVE } },
          },
          data: {
            status: PublicationScheduleStatus.ACTIVE,
            nextMaterializeAt:
              occurrence.schedule.mode === PublicationScheduleMode.RECURRENCE ? new Date() : null,
            lastError: null,
          },
        });
        if (activatedSchedule.count === 0) {
          throw new ConflictException('Расписание публикации изменилось или остановлено.');
        }
        const claimedOccurrence = await tx.publicationOccurrence.updateMany({
          where: {
            id: occurrenceId,
            publicationId,
            scheduleRevision: occurrence.scheduleRevision,
            ...(retryWithoutExecutionEnvelope
              ? {
                  status: PublicationOccurrenceStatus.FAILED,
                  legacyBroadcastId: null,
                  legacyBroadcasts: { none: {} },
                  deliveries: { none: {} },
                }
              : {
                  status: {
                    in: [PublicationOccurrenceStatus.FAILED, PublicationOccurrenceStatus.PARTIAL],
                  },
                }),
            contentRevisionId: occurrence.contentRevisionId,
          },
          data: {
            status: retryWithoutExecutionEnvelope
              ? PublicationOccurrenceStatus.SCHEDULED
              : PublicationOccurrenceStatus.IN_PROGRESS,
            // FLAG: Persist the author's bounded past-slot authorization. A Redis wake
            // or an ordinary poller must observe the same choice after a crash.
            dispatchBlockerCode: PUBLISHER_EXPLICIT_RETRY_CODE,
            dispatchBlockedAt: retryLockedAt,
            retryAuthorizedAt: retryLockedAt,
            retryExpiresAt: new Date(retryLockedAt.getTime() + 24 * 60 * 60_000),
            ...(contentMode === 'latest' ? { contentRevisionId: retryContentRevisionId } : {}),
          },
        });
        if (claimedOccurrence.count === 0) {
          throw new ConflictException('Запуск публикации уже изменён. Обновите экран.');
        }
        if (retryWithoutExecutionEnvelope) {
          await tx.publicationMutationRecord.create({
            data: {
              actorUserId: user.userId,
              requestId: parsed.data.requestId,
              requestHash,
              publicationId,
              resultingVersion: publication.version,
            },
          });
          return;
        }
        const resetDeliveries = await tx.managedBroadcastDelivery.updateMany({
          where: {
            publicationOccurrenceId: occurrenceId,
            broadcastId: { in: retryableBroadcastIds },
            ...retryableDeliveryWhere,
          },
          data: {
            status: ManagedBroadcastDeliveryStatus.PENDING,
            botId: null,
            remoteMessageId: null,
            ...PUBLICATION_DELIVERY_VERIFICATION_RESET_DATA,
            legacySentWithoutRemoteId: false,
            sentAt: null,
            lockedAt: null,
            lockToken: null,
            lastErrorCode: null,
            lastError: null,
            dispatchBlockerCode: null,
            dispatchBlockedAt: null,
            contentRevisionId: retryContentRevisionId,
            ...publicationPostActionsRetryData(
              latestContent?.postPublish ?? occurrence.contentRevision?.postPublish,
            ),
          },
        });
        if (resetDeliveries.count === 0) {
          throw new ConflictException('Не осталось доставок для безопасного повтора.');
        }
        const latestButtons = latestContent
          ? readStoredPublicationButtons(latestContent.buttons)
          : [];
        const reactivatedBroadcasts = await tx.managedBroadcast.updateMany({
          where: {
            id: { in: retryableBroadcastIds },
            publicationOccurrenceId: occurrenceId,
            status: { in: publicationManualRetrySafety.RETRYABLE_PUBLICATION_BROADCAST_STATUSES },
            lockToken: retryLockToken,
            lockedAt: retryLockedAt,
          },
          data: {
            status: ManagedBroadcastStatus.ACTIVE,
            nextSendAt: new Date(),
            lockedAt: null,
            lockToken: null,
            lastError: null,
            ...(latestContent
              ? {
                  text: latestContent.text,
                  textFormat:
                    latestContent.textFormat === PublicationContentFormat.MARKDOWN
                      ? 'markdown'
                      : 'plain',
                  buttons: latestButtons.map(({ text, url }) => ({
                    text,
                    url,
                  })) as Prisma.InputJsonValue,
                  buttonEnabled: latestButtons.length > 0,
                  buttonUrl: latestButtons[0]?.url ?? '',
                  buttonText: latestButtons[0]?.text ?? 'Открыть',
                  publicationContentRevisionId: retryContentRevisionId,
                }
              : {}),
          },
        });
        if (reactivatedBroadcasts.count !== retryableBroadcastIds.length) {
          throw new ConflictException('Не удалось безопасно запустить повтор.');
        }
        await tx.publicationMutationRecord.create({
          data: {
            actorUserId: user.userId,
            requestId: parsed.data.requestId,
            requestHash,
            publicationId,
            resultingVersion: publication.version,
          },
        });
      });
    } catch (error: unknown) {
      if (isPrismaKnownError(error, 'P2002') || error instanceof ConflictException) {
        const concurrentReplay = await this.findMutationReplay(
          user.userId,
          parsed.data.requestId,
          requestHash,
        );
        if (concurrentReplay) {
          this.assertReplayPublication(concurrentReplay.publicationId, publicationId);
          await this.publisherPublicationWakeupQueue.enqueueAfterCommittedMutation({
            publicationId,
            mutationRequestId: parsed.data.requestId,
            occurrenceId,
            reason: 'retry',
          });
          return this.get(publicationId, user, dispatchProfile);
        }
      }
      throw error;
    }
    await this.publisherPublicationWakeupQueue.enqueueAfterCommittedMutation({
      publicationId,
      mutationRequestId: parsed.data.requestId,
      occurrenceId,
      reason: 'retry',
    });
    return this.get(publicationId, user, dispatchProfile);
  }

  async resolveAmbiguousDelivery(
    publicationId: string,
    occurrenceId: string,
    user: AuthUser,
    body: unknown,
    dispatchProfile?: PublicationDispatchProfile,
  ): Promise<PublicationDetails> {
    const parsed = resolvePublicationAmbiguousDeliveryRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const requestHash = this.hashMutationRequest({ publicationId, occurrenceId, ...parsed.data });
    const wakeup = this.publisherPublicationWakeupQueue;
    const finishResolution = async (): Promise<PublicationDetails> => {
      await this.rollupOccurrence(occurrenceId);
      await this.rollupPublicationLifecycle(publicationId);
      await wakeup.enqueueResolution(publicationId, occurrenceId, parsed.data.requestId);
      return this.get(publicationId, user, dispatchProfile);
    };
    const publication = await this.assertPublicationOwner(
      publicationId,
      user.userId,
      dispatchProfile,
      'read',
    );
    if (publication.dispatchProfile !== PublicationDispatchProfile.PUBLIK_V1) {
      await this.resolvePersistedPublicationTargets(
        user,
        publication.targets,
        publication.dispatchProfile,
      );
    }
    const delivery = await this.prisma.managedBroadcastDelivery.findFirst({
      where: {
        id: parsed.data.deliveryId,
        ...(publication.dispatchProfile === PublicationDispatchProfile.PUBLIK_V1
          ? { targetChatId: { in: publication.targets.map((target) => target.targetChatId) } }
          : {}),
        publicationOccurrenceId: occurrenceId,
        publicationOccurrence: { is: { publicationId } },
      },
    });
    if (!delivery) {
      throw new NotFoundException('Доставка не найдена.');
    }
    if (publication.dispatchProfile === PublicationDispatchProfile.PUBLIK_V1) {
      await this.resolvePersistedPublicationTargets(
        user,
        publication.targets.filter((target) => target.targetChatId === delivery.targetChatId),
        publication.dispatchProfile,
      );
    }
    const replay = await this.findMutationReplay(user.userId, parsed.data.requestId, requestHash);
    if (replay) {
      this.assertReplayPublication(replay.publicationId, publicationId);
      return finishResolution();
    }
    const manualReviewWhere = buildManualReviewDeliveryWhere(delivery);
    if (!manualReviewWhere) {
      throw new ConflictException('Эта доставка больше не требует ручной проверки.');
    }
    const resolutionAt = new Date();
    try {
      await this.prisma.$transaction(async (tx: any) => {
        await this.lockPublicationCalendar(tx);
        const resolved = await tx.managedBroadcastDelivery.updateMany({
          where: manualReviewWhere,
          data:
            parsed.data.resolution === 'mark_sent'
              ? {
                  status: ManagedBroadcastDeliveryStatus.SENT,
                  sentAt: delivery.sentAt ?? resolutionAt,
                  ...PUBLICATION_DELIVERY_VERIFICATION_RESET_DATA,
                  remoteMessageVerificationSource: delivery.remoteMessageId
                    ? PublicationDeliveryVerificationSource.MANUAL_CONFIRMED
                    : null,
                  remoteMessageVerifiedAt: delivery.remoteMessageId ? resolutionAt : null,
                  legacySentWithoutRemoteId: delivery.remoteMessageId === null,
                  lastErrorCode: null,
                  lastError: null,
                }
              : {
                  status: ManagedBroadcastDeliveryStatus.FAILED,
                  lastErrorCode: null,
                  lastError: 'Администратор подтвердил, что сообщение не было опубликовано.',
                },
        });
        if (resolved.count === 0) {
          throw new ConflictException('Эта доставка уже обработана.');
        }
        await syncPublicationBroadcastAfterDeliveryResolution(
          tx,
          delivery.broadcastId,
          delivery.occurrenceIndex,
        );
        await syncResolvedPublicationOccurrence(tx, occurrenceId);
        await recordPublicationDeliveryResolution(tx, {
          delivery,
          actorUserId: user.userId,
          publicationId,
          occurrenceId,
          requestId: parsed.data.requestId,
          resolution: parsed.data.resolution,
        });
        await tx.publicationMutationRecord.create({
          data: {
            actorUserId: user.userId,
            requestId: parsed.data.requestId,
            requestHash,
            publicationId,
            resultingVersion: publication.version,
          },
        });
      });
    } catch (error: unknown) {
      if (isPrismaKnownError(error, 'P2002') || error instanceof ConflictException) {
        const concurrentReplay = await this.findMutationReplay(
          user.userId,
          parsed.data.requestId,
          requestHash,
        );
        if (concurrentReplay) {
          this.assertReplayPublication(concurrentReplay.publicationId, publicationId);
          return finishResolution();
        }
      }
      throw error;
    }
    return finishResolution();
  }

  async processDuePublications(reason: 'startup' | 'scheduled'): Promise<void> {
    await this.normalizeStalePublicationOccurrences(PUBLICATION_RECONCILE_BATCH);
    await this.reconcileOrphanedPublicationOccurrences(PUBLICATION_RECONCILE_BATCH);
    await this.reconcileActiveRecurrenceSchedules(PUBLICATION_RECONCILE_BATCH);
    await this.dispatchScheduledOccurrences(PUBLICATION_DISPATCH_BATCH, [
      PublicationScheduleMode.NOW,
    ]);
    await this.rollupActiveOccurrences();
    await this.rollupPublicationLifecycles();

    const decision = await this.resolveBackgroundDecision(reason);
    if (decision === 'pause') {
      return;
    }

    const backgroundBatch =
      decision === 'slow' ? PUBLICATION_SLOW_BATCH : PUBLICATION_DEADLINE_DISPATCH_BATCH;
    await this.dispatchScheduledOccurrences(backgroundBatch, [
      PublicationScheduleMode.ONCE,
      PublicationScheduleMode.SLOTS,
      PublicationScheduleMode.RECURRENCE,
    ]);
    await this.materializeRecurringSchedules(
      decision === 'slow' ? PUBLICATION_SLOW_BATCH : PUBLICATION_MATERIALIZE_BATCH,
    );
    await this.dispatchScheduledOccurrences(
      decision === 'slow' ? PUBLICATION_SLOW_BATCH : PUBLICATION_DISPATCH_BATCH,
      [
        PublicationScheduleMode.ONCE,
        PublicationScheduleMode.SLOTS,
        PublicationScheduleMode.RECURRENCE,
      ],
    );
    await this.rollupActiveOccurrences();
    await this.rollupPublicationLifecycles();
  }

  async processPublisherPublicationWake(
    publicationId: string,
    options: { allowPastScheduled: boolean; occurrenceId?: string },
  ): Promise<void> {
    const wake = buildPublisherPublicationWakeDispatch(
      publicationId,
      options,
      new Date(),
      PUBLICATION_PAST_GRACE_MS,
    );
    await this.dispatchScheduledOccurrences(
      PUBLICATION_DISPATCH_BATCH,
      wake.scheduleModes,
      wake.scope,
    );
  }

  private async normalizeStalePublicationOccurrences(limit: number): Promise<void> {
    if (!Number.isSafeInteger(limit) || limit <= 0) return;
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await this.lockPublicationCalendar(tx);
      await cancelUntouchedScheduledPublicationOccurrences(tx, {
        now,
        limit: Math.min(limit, PUBLICATION_RECONCILE_BATCH),
      });
    });
  }

  private async reconcileOrphanedPublicationOccurrences(limit: number): Promise<void> {
    await reconcilePublicationOrphans({
      prisma: this.prisma,
      logger: this.logger,
      limit,
      maxBatch: PUBLICATION_RECONCILE_BATCH,
      staleBefore: new Date(Date.now() - PUBLICATION_PAST_GRACE_MS),
    });
  }

  private async reconcileActiveRecurrenceSchedules(limit: number): Promise<void> {
    const now = new Date();
    const horizon = new Date(now.getTime() + PUBLICATION_RECURRENCE_HORIZON_MS);
    const schedules = await this.prisma.publicationSchedule.findMany({
      where: {
        mode: PublicationScheduleMode.RECURRENCE,
        status: PublicationScheduleStatus.ACTIVE,
        nextMaterializeAt: { gt: now },
        lastError: null,
        publication: { is: { lifecycle: PublicationLifecycle.ACTIVE } },
      },
      orderBy: { nextMaterializeAt: 'asc' },
      take: limit,
      include: {
        occurrences: {
          where: {
            scheduledAt: { gte: now },
            status: {
              in: [PublicationOccurrenceStatus.SCHEDULED, PublicationOccurrenceStatus.IN_PROGRESS],
            },
          },
          select: { scheduleRevision: true },
        },
      },
    });
    for (const schedule of schedules) {
      try {
        const scheduledRefreshAt = schedule.nextMaterializeAt;
        if (!scheduledRefreshAt) {
          continue;
        }
        const rule = publicationScheduleInputSchema.parse(schedule.rule);
        if (rule.mode !== 'recurrence') {
          continue;
        }
        const hasFutureOccurrence = schedule.occurrences.some(
          (occurrence) => occurrence.scheduleRevision === schedule.revision,
        );
        if (hasFutureOccurrence) {
          continue;
        }

        const [existingCount, latest] = await Promise.all([
          this.prisma.publicationOccurrence.count({
            where: {
              scheduleId: schedule.id,
              scheduleRevision: schedule.revision,
              ...(readPublicationLatePolicy(rule)
                ? {}
                : { status: { not: PublicationOccurrenceStatus.CANCELED } }),
            },
          }),
          this.prisma.publicationOccurrence.findFirst({
            where: {
              scheduleId: schedule.id,
              scheduleRevision: schedule.revision,
              ...(readPublicationLatePolicy(rule)
                ? {}
                : { status: { not: PublicationOccurrenceStatus.CANCELED } }),
            },
            orderBy: { scheduledAt: 'desc' },
            select: { scheduledAt: true },
          }),
        ]);
        const from = resolvePublicationRecurrenceFrom(rule, schedule, latest, now);
        const slots =
          from <= horizon
            ? expandPublicationSchedule(rule, {
                from,
                to: horizon,
                existingCount,
                now,
                maxResults: 1,
              })
            : [];
        const nextSlot = slots[0] ?? this.findNextRecurrenceSlot(rule, from, existingCount);
        if (!nextSlot) {
          continue;
        }
        const desiredMaterializeAt =
          nextSlot <= horizon ? now : this.resolveRecurrenceHorizonEntry(nextSlot, now);
        if (desiredMaterializeAt >= scheduledRefreshAt) {
          continue;
        }

        await this.prisma.publicationSchedule.updateMany({
          where: {
            id: schedule.id,
            revision: schedule.revision,
            status: PublicationScheduleStatus.ACTIVE,
            nextMaterializeAt: scheduledRefreshAt,
            publication: { is: { lifecycle: PublicationLifecycle.ACTIVE } },
          },
          data: { nextMaterializeAt: desiredMaterializeAt },
        });
      } catch (error: unknown) {
        this.logger.warn(
          {
            scheduleId: schedule.id,
            publicationId: schedule.publicationId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to reconcile publication recurrence',
        );
      }
    }
  }

  private async materializeRecurringSchedules(limit: number): Promise<void> {
    const dispatchProfile = PublicationDispatchProfile.PUBLIK_V1;
    const now = new Date();
    const schedules = await this.prisma.publicationSchedule.findMany({
      where: {
        mode: PublicationScheduleMode.RECURRENCE,
        status: PublicationScheduleStatus.ACTIVE,
        nextMaterializeAt: { lte: now },
        publication: { is: { lifecycle: PublicationLifecycle.ACTIVE, dispatchProfile } },
      },
      orderBy: { nextMaterializeAt: 'asc' },
      take: limit,
      include: {
        publication: {
          include: { targets: { orderBy: { position: 'asc' } } },
        },
      },
    });

    for (const schedule of schedules) {
      try {
        const rule = publicationScheduleInputSchema.parse(schedule.rule);
        if (rule.mode !== 'recurrence' || !schedule.publication.canonicalContentRevisionId) {
          throw new Error('Повтор публикации повреждён.');
        }
        const [latest, existingCount] = await Promise.all([
          this.prisma.publicationOccurrence.findFirst({
            where: {
              scheduleId: schedule.id,
              scheduleRevision: schedule.revision,
              ...(readPublicationLatePolicy(rule)
                ? {}
                : { status: { not: PublicationOccurrenceStatus.CANCELED } }),
            },
            orderBy: { scheduledAt: 'desc' },
            select: { scheduledAt: true },
          }),
          this.prisma.publicationOccurrence.count({
            where: {
              scheduleId: schedule.id,
              scheduleRevision: schedule.revision,
              ...(readPublicationLatePolicy(rule)
                ? {}
                : { status: { not: PublicationOccurrenceStatus.CANCELED } }),
            },
          }),
        ]);
        const from = resolvePublicationRecurrenceFrom(rule, schedule, latest, now);
        const horizon = new Date(now.getTime() + PUBLICATION_RECURRENCE_HORIZON_MS);
        const slots = expandPublicationSchedule(rule, {
          from,
          to: horizon,
          existingCount,
          now,
          maxResults: 300,
        });
        const reachedMax =
          rule.maxOccurrences !== null && existingCount + slots.length >= rule.maxOccurrences;
        const reachedEnd =
          rule.endsAt !== null && new Date(rule.endsAt) <= horizon && slots.length < 300;
        if (slots.length === 0 && existingCount === 0 && reachedEnd) {
          throw new Error('Расписание не содержит ни одного будущего запуска.');
        }
        const nextSlot =
          slots.length === 0 && !reachedMax && !reachedEnd
            ? this.findNextRecurrenceSlot(rule, from, existingCount)
            : null;
        if (slots.length === 0 && !reachedMax && !reachedEnd && !nextSlot) {
          throw new Error('Не удалось определить следующий запуск публикации.');
        }
        const nextMaterializeAt =
          reachedMax || reachedEnd
            ? null
            : slots.length === 300
              ? now
              : nextSlot
                ? this.resolveRecurrenceHorizonEntry(nextSlot, now)
                : new Date(now.getTime() + PUBLICATION_RECURRENCE_REFRESH_MS);
        const targets =
          slots.length > 0
            ? await publicationBackgroundAccess.recurrence(
                () => this.resolveOccurrenceTargets(schedule.publication),
                this.logger,
                schedule,
              )
            : [];
        if (targets === null) {
          const databaseAvailable = await deferPublicationRecurrencePreparation({
            prisma: this.prisma,
            logger: this.logger,
            schedule,
            publicationVersion: schedule.publication.version,
            lockCalendar: (tx) => this.lockPublicationCalendar(tx),
          });
          if (!databaseAvailable) break;
          continue;
        }
        await this.prisma.$transaction(async (tx: any) => {
          if (slots.length > 0) {
            await this.lockPublicationCalendar(tx);
          }
          const claimed = await tx.publicationSchedule.updateMany({
            where: {
              id: schedule.id,
              revision: schedule.revision,
              status: PublicationScheduleStatus.ACTIVE,
              nextMaterializeAt: { lte: now },
              publication: { is: { lifecycle: PublicationLifecycle.ACTIVE } },
            },
            data: {
              lastMaterializedAt: now,
              nextMaterializeAt,
              lastError: null,
            },
          });
          if (claimed.count === 0) {
            return;
          }
          if (slots.length > 0) {
            const currentPublication = await tx.publication.findUnique({
              where: { id: schedule.publicationId },
              select: { canonicalContentRevisionId: true },
            });
            if (!currentPublication?.canonicalContentRevisionId) {
              throw new Error('Содержимое повтора больше недоступно.');
            }
            await this.reservePublicationCalendar(
              tx,
              targets,
              slots,
              rule,
              schedule.publicationId,
              schedule.publication.actorUserId,
              true,
            );
            await tx.publicationOccurrence.createMany({
              data: slots.map((scheduledAt) => ({
                publicationId: schedule.publicationId,
                scheduleId: schedule.id,
                contentRevisionId: currentPublication.canonicalContentRevisionId,
                scheduleRevision: schedule.revision,
                scheduledAt,
                deliveryDeadlineAt: snapshotPublicationDeliveryDeadline(scheduledAt, rule),
                dispatchProfile: schedule.publication.dispatchProfile,
                requiredBotId: schedule.publication.requiredBotId,
              })),
              skipDuplicates: true,
            });
          }
        });
      } catch (error: unknown) {
        const databaseAvailable = await recoverPublicationRecurrencePreparationFailure({
          prisma: this.prisma,
          logger: this.logger,
          schedule,
          publicationVersion: schedule.publication.version,
          lockCalendar: (tx) => this.lockPublicationCalendar(tx),
          error,
        });
        if (!databaseAvailable) break;
      }
    }
  }

  private async dispatchScheduledOccurrences(
    limit: number,
    scheduleModes?: PublicationScheduleMode[],
    scope: PublicationOccurrenceDispatchScope = {},
  ): Promise<void> {
    await dispatchScheduledPublicationOccurrences(
      {
        prisma: this.prisma,
        publisherRouting: this.publisherRouting,
        logger: this.logger,
        resolveTargets: (publication) => this.resolveOccurrenceTargets(publication),
        createExecution: (occurrence, targets, schedule) =>
          this.createOccurrenceExecution(occurrence, targets, schedule),
        lockCalendar: (tx) => this.lockPublicationCalendar(tx),
        cancelFutureWork: (tx, publicationId, now) =>
          this.cancelFuturePublicationWork(tx, publicationId, now),
      },
      limit,
      scheduleModes,
      scope,
    );
  }

  private async createOccurrenceExecution(
    occurrence: any,
    targets: ResolvedPublicationTarget[],
    schedule: PublicationScheduleInput,
  ): Promise<void> {
    const publicationButtons = readStoredPublicationButtons(occurrence.contentRevision.buttons);
    const publisherRoute = await this.publisherRouting.prepareOccurrenceRoute(
      occurrence.dispatchProfile,
      occurrence.requiredBotId,
      targets,
      publicationButtons,
    );
    const groups = [
      {
        entityType: ChatEntityType.CHAT,
        targets: targets.filter((target) => target.entityType === 'chat'),
      },
      {
        entityType: ChatEntityType.CHANNEL,
        targets: targets.filter((target) => target.entityType === 'channel'),
      },
    ].filter((group) => group.targets.length > 0);
    const replaceConflicts = 'replaceConflicts' in schedule && schedule.replaceConflicts;
    const postClaimStatus =
      occurrence.scheduledAt > new Date()
        ? PublicationOccurrenceStatus.SCHEDULED
        : PublicationOccurrenceStatus.IN_PROGRESS;

    await this.prisma.$transaction(async (tx: any) => {
      await this.lockPublicationCalendar(tx);
      const claimed = await tx.publicationOccurrence.updateMany({
        where: {
          id: occurrence.id,
          status: PublicationOccurrenceStatus.SCHEDULED,
          scheduleRevision: occurrence.scheduleRevision,
          contentRevisionId: occurrence.contentRevisionId,
          retryAuthorizedAt: occurrence.retryAuthorizedAt ?? null,
          retryExpiresAt: occurrence.retryExpiresAt ?? null,
          deliveryDeadlineAt: occurrence.deliveryDeadlineAt ?? null,
          dispatchBlockerCode: occurrence.dispatchBlockerCode ?? null,
          dispatchBlockedAt: occurrence.dispatchBlockedAt ?? null,
          schedule: {
            is: {
              revision: occurrence.scheduleRevision,
              status: PublicationScheduleStatus.ACTIVE,
              publication: { is: { lifecycle: PublicationLifecycle.ACTIVE } },
            },
          },
        },
        data: {
          status: PublicationOccurrenceStatus.IN_PROGRESS,
          // FLAG: Author retry authorization must survive materialization and process restarts.
          // Execution preserves the explicit expiry, including legacy five-minute grants.
          retryAuthorizedAt: readPublicationRetryAuthorizedAt(occurrence),
          dispatchBlockerCode: null,
          dispatchBlockedAt: null,
        },
      });
      if (claimed.count === 0) {
        return;
      }
      const existing = await tx.managedBroadcast.count({
        where: { publicationOccurrenceId: occurrence.id },
      });
      if (existing > 0) {
        await tx.publicationOccurrence.update({
          where: { id: occurrence.id },
          data: { status: postClaimStatus },
        });
        return;
      }

      let firstBroadcastId: string | null = occurrence.legacyBroadcastId;
      for (const group of groups) {
        const targetChatIds = group.targets.map((target) => target.chatId);
        await releaseRetiredMajorCalendarSlots(
          tx,
          group.entityType,
          targetChatIds,
          occurrence.scheduledAt,
        );
        const conflicts = await tx.managedBroadcastCalendarReservation.findMany({
          where: {
            entityType: group.entityType,
            targetChatId: { in: targetChatIds },
            scheduledAt: occurrence.scheduledAt,
          },
          select: { broadcastId: true },
        });
        if (conflicts.length > 0 && !replaceConflicts) {
          throw new ConflictException('В выбранное время уже есть публикация.');
        }
        if (conflicts.length > 0) {
          const conflictingBroadcastIds: string[] = conflicts.map(
            (conflict: { broadcastId: string }) => conflict.broadcastId,
          );
          await this.cancelConflictingBroadcasts(tx, [...new Set(conflictingBroadcastIds)], {
            entityType: group.entityType,
            scheduledAt: occurrence.scheduledAt,
            targetChatIds,
            actorUserId: occurrence.publication.actorUserId,
          });
        }

        const buttons = publicationButtons;
        const broadcast = await tx.managedBroadcast.create({
          data: {
            sourceChatId: targetChatIds[0],
            entityType: group.entityType,
            actorUserId: occurrence.publication.actorUserId,
            text: occurrence.contentRevision.text,
            textFormat:
              occurrence.contentRevision.textFormat === PublicationContentFormat.MARKDOWN
                ? 'markdown'
                : 'plain',
            applyToAllChats: false,
            targetChatIds: targetChatIds as Prisma.InputJsonValue,
            buttons: buttons.map(({ text, url }) => ({ text, url })) as Prisma.InputJsonValue,
            buttonEnabled: buttons.length > 0,
            buttonUrl: buttons[0]?.url ?? '',
            buttonText: buttons[0]?.text ?? 'Открыть',
            imageEnabled: false,
            imageBase64: '',
            imageMimeType: '',
            imageFileName: '',
            mediaType: null,
            mediaPayload: Prisma.DbNull,
            mediaMimeType: '',
            mediaFileName: '',
            scheduleMode: 'calendar',
            scheduleTimezone: occurrence.schedule.timezone,
            nextSendAt: occurrence.scheduledAt,
            cycleEnabled: false,
            cycleEveryHours: 1,
            cycleCount: 1,
            sentCount: 0,
            status: ManagedBroadcastStatus.ACTIVE,
            publicationOccurrenceId: occurrence.id,
            publicationContentRevisionId: occurrence.contentRevisionId,
            ...publisherRoute.broadcastData,
          },
          select: { id: true },
        });
        firstBroadcastId ??= broadcast.id;
        await tx.managedBroadcastOccurrence.create({
          data: {
            broadcastId: broadcast.id,
            sourceChatId: targetChatIds[0],
            entityType: group.entityType,
            occurrenceIndex: 1,
            scheduledAt: occurrence.scheduledAt,
          },
        });
        await tx.managedBroadcastDelivery.createMany({
          data: targetChatIds.map((targetChatId) => ({
            broadcastId: broadcast.id,
            occurrenceIndex: 1,
            targetChatId,
            publicationOccurrenceId: occurrence.id,
            contentRevisionId: occurrence.contentRevisionId,
            ...publisherRoute.deliveryDataByChatId.get(targetChatId)!,
            ...publicationPostActionsInitialData(
              occurrence.contentRevision.postPublish,
              occurrence.scheduledAt,
            ),
          })),
        });
        await tx.managedBroadcastCalendarReservation.createMany({
          data: targetChatIds.map((targetChatId) => ({
            broadcastId: broadcast.id,
            sourceChatId: targetChatIds[0],
            entityType: group.entityType,
            occurrenceIndex: 1,
            targetChatId,
            scheduledAt: occurrence.scheduledAt,
          })),
        });
      }
      await tx.publicationOccurrence.update({
        where: { id: occurrence.id },
        data: { legacyBroadcastId: firstBroadcastId, status: postClaimStatus },
      });
    });
  }

  private async rollupActiveOccurrences(): Promise<void> {
    await this.activeOccurrenceRollups.scan({
      prisma: this.prisma,
      rollup: (occurrenceId) => this.rollupOccurrence(occurrenceId),
      onError: (occurrenceId, error) =>
        this.logger.warn(
          {
            occurrenceId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to roll up publication occurrence',
        ),
    });
  }

  private async rollupOccurrence(occurrenceId: string): Promise<void> {
    if (await this.occurrenceRollupNoop.canSkip(occurrenceId)) return;
    await rollupPublicationOccurrence(this.prisma, occurrenceId);
  }

  private async rollupPublicationLifecycles(): Promise<void> {
    const publications = await this.prisma.publication.findMany({
      where: {
        OR: [
          { lifecycle: PublicationLifecycle.ACTIVE },
          {
            lifecycle: PublicationLifecycle.ERROR,
            occurrences: {
              some: {
                status: {
                  in: [PublicationOccurrenceStatus.SENT, PublicationOccurrenceStatus.CANCELED],
                },
              },
              none: {
                status: {
                  in: [
                    PublicationOccurrenceStatus.FAILED,
                    PublicationOccurrenceStatus.PARTIAL,
                    PublicationOccurrenceStatus.AMBIGUOUS,
                  ],
                },
              },
            },
          },
        ],
        schedule: { is: { nextMaterializeAt: null } },
        occurrences: {
          none: {
            status: {
              in: [PublicationOccurrenceStatus.SCHEDULED, PublicationOccurrenceStatus.IN_PROGRESS],
            },
          },
        },
      },
      take: 200,
      select: { id: true },
    });
    for (const publication of publications) {
      await this.rollupPublicationLifecycle(publication.id);
    }
  }

  private async rollupPublicationLifecycle(publicationId: string): Promise<void> {
    const publication = await this.prisma.publication.findFirst({
      where: {
        id: publicationId,
        lifecycle: { in: [PublicationLifecycle.ACTIVE, PublicationLifecycle.ERROR] },
      },
      include: { schedule: true },
    });
    if (
      !publication?.schedule ||
      publication.schedule.nextMaterializeAt ||
      !new Set<PublicationScheduleStatus>([
        PublicationScheduleStatus.ACTIVE,
        PublicationScheduleStatus.ERROR,
      ]).has(publication.schedule.status)
    ) {
      return;
    }
    const currentSchedule = publication.schedule;
    const grouped = await this.prisma.publicationOccurrence.groupBy({
      by: ['status'],
      where: {
        publicationId,
        scheduleId: currentSchedule.id,
        scheduleRevision: currentSchedule.revision,
      },
      _count: { _all: true },
    });
    const activeOccurrenceStatuses = [
      PublicationOccurrenceStatus.SCHEDULED,
      PublicationOccurrenceStatus.IN_PROGRESS,
    ] as const;
    const activeStatuses = new Set<PublicationOccurrenceStatus>(activeOccurrenceStatuses);
    const active = grouped.some((group) => activeStatuses.has(group.status));
    if (active) {
      return;
    }
    let invalidRecurrenceMessage: string | null = null;
    if (
      currentSchedule.status === PublicationScheduleStatus.ACTIVE &&
      currentSchedule.mode === PublicationScheduleMode.RECURRENCE
    ) {
      try {
        const rule = publicationScheduleInputSchema.parse(currentSchedule.rule);
        if (rule.mode !== 'recurrence') {
          throw new Error('Повтор публикации повреждён.');
        }
        const nonCanceledCount = grouped.reduce(
          (count, group) =>
            !readPublicationLatePolicy(rule) &&
            group.status === PublicationOccurrenceStatus.CANCELED
              ? count
              : count + group._count._all,
          0,
        );
        const totalCount = grouped.reduce((count, group) => count + group._count._all, 0);
        const reachedMax = rule.maxOccurrences !== null && nonCanceledCount >= rule.maxOccurrences;
        const latest = await this.prisma.publicationOccurrence.findFirst({
          where: {
            publicationId,
            scheduleId: currentSchedule.id,
            scheduleRevision: currentSchedule.revision,
            ...(readPublicationLatePolicy(rule)
              ? {}
              : { status: { not: PublicationOccurrenceStatus.CANCELED } }),
          },
          orderBy: { scheduledAt: 'desc' },
          select: { scheduledAt: true },
        });
        const now = new Date();
        const from = resolvePublicationRecurrenceFrom(rule, currentSchedule, latest, now);
        const nextSlot = reachedMax
          ? null
          : this.findNextRecurrenceSlot(rule, from, nonCanceledCount);
        if (nextSlot) {
          const nextMaterializeAt = this.resolveRecurrenceHorizonEntry(nextSlot, now);
          try {
            await this.prisma.$transaction(async (tx: any) => {
              const restoredPublication = await tx.publication.updateMany({
                where: {
                  id: publicationId,
                  lifecycle: publication.lifecycle,
                  schedule: {
                    is: {
                      id: currentSchedule.id,
                      revision: currentSchedule.revision,
                      status: PublicationScheduleStatus.ACTIVE,
                      nextMaterializeAt: null,
                    },
                  },
                },
                data: { lifecycle: PublicationLifecycle.ACTIVE },
              });
              if (restoredPublication.count === 0) {
                return;
              }
              const restoredSchedule = await tx.publicationSchedule.updateMany({
                where: {
                  id: currentSchedule.id,
                  revision: currentSchedule.revision,
                  status: PublicationScheduleStatus.ACTIVE,
                  nextMaterializeAt: null,
                  publication: {
                    is: { id: publicationId, lifecycle: PublicationLifecycle.ACTIVE },
                  },
                },
                data: { nextMaterializeAt, lastError: null },
              });
              if (restoredSchedule.count === 0) {
                throw new StalePublicationRollupError();
              }
            });
          } catch (error: unknown) {
            if (!(error instanceof StalePublicationRollupError)) {
              throw error;
            }
          }
          return;
        }

        const ended = rule.endsAt !== null && new Date(rule.endsAt) <= now;
        if (!reachedMax && (!ended || totalCount === 0)) {
          invalidRecurrenceMessage = 'Расписание не содержит ни одного будущего запуска.';
        }
      } catch (error: unknown) {
        invalidRecurrenceMessage = error instanceof Error ? error.message : String(error);
      }
    }
    const errorStatuses = new Set<PublicationOccurrenceStatus>([
      PublicationOccurrenceStatus.FAILED,
      PublicationOccurrenceStatus.PARTIAL,
      PublicationOccurrenceStatus.AMBIGUOUS,
    ]);
    const hasErrors =
      invalidRecurrenceMessage !== null ||
      (grouped.length === 0
        ? currentSchedule.status === PublicationScheduleStatus.ERROR
        : grouped.some((group) => errorStatuses.has(group.status)));
    const nextLifecycle = hasErrors ? PublicationLifecycle.ERROR : PublicationLifecycle.COMPLETED;
    const nextScheduleStatus = hasErrors
      ? PublicationScheduleStatus.ERROR
      : PublicationScheduleStatus.COMPLETED;
    if (publication.lifecycle === nextLifecycle && currentSchedule.status === nextScheduleStatus) {
      return;
    }
    try {
      await this.prisma.$transaction(async (tx: any) => {
        await this.lockPublicationCalendar(tx);
        const activeOccurrenceCount = await tx.publicationOccurrence.count({
          where: {
            publicationId,
            scheduleId: currentSchedule.id,
            scheduleRevision: currentSchedule.revision,
            status: { in: activeOccurrenceStatuses },
          },
        });
        if (activeOccurrenceCount > 0) {
          return;
        }
        const updatedPublication = await tx.publication.updateMany({
          where: {
            id: publicationId,
            lifecycle: publication.lifecycle,
            occurrences: {
              none: {
                scheduleId: currentSchedule.id,
                scheduleRevision: currentSchedule.revision,
                status: { in: activeOccurrenceStatuses },
              },
            },
            schedule: {
              is: {
                id: currentSchedule.id,
                revision: currentSchedule.revision,
                status: currentSchedule.status,
                nextMaterializeAt: null,
              },
            },
          },
          data: { lifecycle: nextLifecycle },
        });
        if (updatedPublication.count === 0) {
          return;
        }
        const updatedSchedule = await tx.publicationSchedule.updateMany({
          where: {
            id: currentSchedule.id,
            revision: currentSchedule.revision,
            status: currentSchedule.status,
            nextMaterializeAt: null,
            publication: {
              is: {
                id: publicationId,
                lifecycle: nextLifecycle,
                occurrences: {
                  none: {
                    scheduleId: currentSchedule.id,
                    scheduleRevision: currentSchedule.revision,
                    status: { in: activeOccurrenceStatuses },
                  },
                },
              },
            },
          },
          data: {
            status: nextScheduleStatus,
            ...(invalidRecurrenceMessage ? { lastError: invalidRecurrenceMessage } : {}),
          },
        });
        if (updatedSchedule.count === 0) {
          throw new StalePublicationRollupError();
        }
      });
    } catch (error: unknown) {
      if (error instanceof StalePublicationRollupError) {
        return;
      }
      throw error;
    }
  }

  private async transitionPublication(
    publicationId: string,
    user: AuthUser,
    body: unknown,
    action: 'pause' | 'resume' | 'cancel',
    dispatchProfile?: PublicationDispatchProfile,
  ): Promise<PublicationDetails> {
    const parsed = publicationActionRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const requestHash = this.hashMutationRequest({ publicationId, action, ...parsed.data });
    const replay = await this.findMutationReplay(user.userId, parsed.data.requestId, requestHash);
    if (replay) {
      await this.assertPublicationOwner(publicationId, user.userId, dispatchProfile);
      this.assertReplayPublication(replay.publicationId, publicationId);
      if (action === 'resume') {
        await this.publisherPublicationWakeupQueue.enqueueAfterCommittedMutation({
          publicationId,
          mutationRequestId: parsed.data.requestId,
          reason: 'resume',
        });
      }
      return this.get(publicationId, user, dispatchProfile);
    }
    const publication = await this.assertPublicationOwner(
      publicationId,
      user.userId,
      dispatchProfile,
    );
    const allowedLifecycle =
      action === 'resume'
        ? publication.lifecycle === PublicationLifecycle.PAUSED
        : action === 'pause'
          ? new Set<PublicationLifecycle>([
              PublicationLifecycle.ACTIVE,
              PublicationLifecycle.ERROR,
            ]).has(publication.lifecycle)
          : !new Set<PublicationLifecycle>([
              PublicationLifecycle.CANCELED,
              PublicationLifecycle.COMPLETED,
            ]).has(publication.lifecycle);
    if (!allowedLifecycle) {
      throw new ConflictException(
        action === 'resume'
          ? 'Возобновить можно только публикацию на паузе.'
          : action === 'pause'
            ? 'Поставить на паузу можно только активную публикацию.'
            : 'Публикация уже завершена.',
      );
    }
    if (publication.version !== parsed.data.expectedRevision) {
      throw new ConflictException({
        code: 'PUBLICATION_REVISION_CONFLICT',
        message: 'Публикация уже изменена. Обновите экран.',
        currentRevision: publication.version,
      });
    }
    if (action === 'resume') {
      await this.resolvePersistedPublicationTargets(
        user,
        publication.targets,
        publication.dispatchProfile,
      );
    }
    const now = new Date();
    const nextVersion = publication.version + 1;

    try {
      await this.prisma.$transaction(async (tx: any) => {
        await this.lockPublicationCalendar(tx);
        const updated = await tx.publication.updateMany({
          where: {
            id: publicationId,
            ...this.publicationAccessWhere(user.userId, publication.dispatchProfile),
            dispatchProfile: publication.dispatchProfile,
            version: parsed.data.expectedRevision,
            lifecycle: publication.lifecycle,
          },
          data: {
            version: { increment: 1 },
            lifecycle:
              action === 'pause'
                ? PublicationLifecycle.PAUSED
                : action === 'resume'
                  ? PublicationLifecycle.ACTIVE
                  : PublicationLifecycle.CANCELED,
          },
        });
        if (updated.count === 0) {
          throw new ConflictException('Публикация уже изменена. Обновите экран.');
        }

        if (action === 'pause') {
          await cancelUntouchedScheduledPublicationOccurrences(tx, { publicationId, now });
          await deleteUnstartedPublicationExecutionEnvelopes(tx, publicationId, {
            scheduledAfter: now,
          });
          await tx.publicationSchedule.updateMany({
            where: { publicationId },
            data: { status: PublicationScheduleStatus.PAUSED, nextMaterializeAt: null },
          });
        } else if (action === 'resume') {
          const schedule = await tx.publicationSchedule.findUnique({
            where: { publicationId },
          });
          if (!schedule) {
            throw new BadRequestException('У публикации нет расписания.');
          }
          await this.restoreAccessLossPausedOccurrences(
            tx,
            publicationId,
            schedule.id,
            schedule.revision,
            now,
          );
          await cancelUntouchedScheduledPublicationOccurrences(tx, { publicationId, now });
          await tx.publicationSchedule.update({
            where: { id: schedule.id },
            data: {
              status: PublicationScheduleStatus.ACTIVE,
              nextMaterializeAt: schedule.mode === PublicationScheduleMode.RECURRENCE ? now : null,
              lastError: null,
            },
          });
        } else {
          await this.cancelFuturePublicationWork(tx, publicationId, now);
          await tx.publicationSchedule.updateMany({
            where: { publicationId },
            data: {
              status: PublicationScheduleStatus.CANCELED,
              nextMaterializeAt: null,
            },
          });
        }

        await tx.publicationMutationRecord.create({
          data: {
            actorUserId: user.userId,
            requestId: parsed.data.requestId,
            requestHash,
            publicationId,
            resultingVersion: nextVersion,
          },
        });
      });
    } catch (error: unknown) {
      if (isPrismaKnownError(error, 'P2002') || error instanceof ConflictException) {
        const concurrentReplay = await this.findMutationReplay(
          user.userId,
          parsed.data.requestId,
          requestHash,
        );
        if (concurrentReplay) {
          this.assertReplayPublication(concurrentReplay.publicationId, publicationId);
          if (action === 'resume') {
            await this.publisherPublicationWakeupQueue.enqueueAfterCommittedMutation({
              publicationId,
              mutationRequestId: parsed.data.requestId,
              reason: 'resume',
            });
          }
          return this.get(publicationId, user, dispatchProfile);
        }
      }
      throw error;
    }
    if (action === 'resume') {
      await this.publisherPublicationWakeupQueue.enqueueAfterCommittedMutation({
        publicationId,
        mutationRequestId: parsed.data.requestId,
        reason: 'resume',
      });
    }
    return this.get(publicationId, user, dispatchProfile);
  }

  private async resolveAudienceTargets(
    user: AuthUser,
    audience: PublicationAudienceInput,
    dispatchProfile: PublicationDispatchProfile = PublicationDispatchProfile.LEGACY_ROUTED,
  ): Promise<ResolvedPublicationTarget[]> {
    return this.publisherRouting.resolveAudienceTargets(user, audience, dispatchProfile);
  }

  private async resolveOccurrenceTargets(publication: any): Promise<ResolvedPublicationTarget[]> {
    if (publication.dispatchProfile === PublicationDispatchProfile.PUBLIK_V1) {
      return this.publisherRouting.resolveScheduledTargets(publication);
    }
    return publicationBackgroundAccess.resolveOccurrence(
      publication,
      (user, targets) =>
        this.resolvePersistedPublicationTargets(user, targets, publication.dispatchProfile),
      (user, audience) => this.resolveAudienceTargets(user, audience, publication.dispatchProfile),
    );
  }

  private resolvePersistedPublicationTargets(
    user: AuthUser,
    targets: Array<{ targetChatId: string; entityType: ChatEntityType }>,
    dispatchProfile: PublicationDispatchProfile = PublicationDispatchProfile.LEGACY_ROUTED,
  ): Promise<ResolvedPublicationTarget[]> {
    return this.publisherRouting.resolvePersistedTargets(user, targets, dispatchProfile);
  }

  private isPublicationAudienceEquivalent(
    audience: PublicationAudienceInput,
    publication: {
      audienceSelection: PublicationAudienceSelection;
      audienceMode: PublicationAudienceMode;
      targets: Array<{ targetChatId: string; entityType: ChatEntityType }>;
    },
  ): boolean {
    if (
      (audience.selection as PublicationAudienceSelection) !== publication.audienceSelection ||
      (audience.mode as PublicationAudienceMode) !== publication.audienceMode
    ) {
      return false;
    }
    if (audience.selection !== 'SELECTED') {
      return true;
    }

    const requestedTargets = audience.targets
      .map((target) => `${target.entityType}:${target.chatId}`)
      .sort();
    const persistedTargets = publication.targets
      .map((target) => `${this.fromPrismaEntityType(target.entityType)}:${target.targetChatId}`)
      .sort();
    return (
      requestedTargets.length === persistedTargets.length &&
      requestedTargets.every((target, index) => target === persistedTargets[index])
    );
  }

  private arePublicationSchedulesEquivalent(
    left: PublicationScheduleInput | null,
    right: PublicationScheduleInput | null,
    ignoreLatePolicy = false,
  ): boolean {
    if (left === null || right === null) {
      return left === right;
    }
    return (
      this.stableStringify(this.canonicalizePublicationSchedule(left, ignoreLatePolicy)) ===
      this.stableStringify(this.canonicalizePublicationSchedule(right, ignoreLatePolicy))
    );
  }

  private canonicalizePublicationSchedule(
    schedule: PublicationScheduleInput,
    ignoreLatePolicy = false,
  ): unknown {
    if (schedule.mode === 'now') {
      return { mode: schedule.mode, timezone: schedule.timezone };
    }
    if (schedule.mode === 'once') {
      return {
        mode: schedule.mode,
        timezone: schedule.timezone,
        ...(!ignoreLatePolicy && 'latePolicy' in schedule
          ? { latePolicy: schedule.latePolicy }
          : {}),
        at: new Date(schedule.at).toISOString(),
      };
    }
    if (schedule.mode === 'slots') {
      return {
        mode: schedule.mode,
        timezone: schedule.timezone,
        ...(!ignoreLatePolicy && 'latePolicy' in schedule
          ? { latePolicy: schedule.latePolicy }
          : {}),
        slots: [...new Set(schedule.slots.map((slot) => new Date(slot).getTime()))]
          .sort((left, right) => left - right)
          .map((slot) => new Date(slot).toISOString()),
      };
    }
    return {
      mode: schedule.mode,
      timezone: schedule.timezone,
      ...(!ignoreLatePolicy && 'latePolicy' in schedule ? { latePolicy: schedule.latePolicy } : {}),
      frequency: schedule.frequency,
      interval: schedule.interval,
      weekdays: schedule.frequency === 'weekly' ? [...schedule.weekdays].sort((a, b) => a - b) : [],
      times: [...schedule.times].sort(),
      startsAt: schedule.startsAt ? new Date(schedule.startsAt).toISOString() : null,
      endsAt: schedule.endsAt ? new Date(schedule.endsAt).toISOString() : null,
      maxOccurrences: schedule.maxOccurrences,
    };
  }

  private normalizeCreateRequest(request: CreatePublicationRequest): CreatePublicationRequest {
    return {
      ...request,
      title: request.title.trim(),
      content: normalizePublicationContent(request.content),
    };
  }

  private normalizeUpdateRequest(request: UpdatePublicationRequest): UpdatePublicationRequest {
    return {
      ...request,
      ...(request.title !== undefined ? { title: request.title.trim() } : {}),
      ...(request.content ? { content: normalizePublicationContent(request.content) } : {}),
    };
  }

  private normalizeSchedule(
    schedule: PublicationScheduleInput,
    now: Date,
  ): PublicationScheduleInput {
    return normalizePublicationSchedule(schedule, now, PUBLICATION_PAST_GRACE_MS);
  }

  private expandInitialSchedule(schedule: PublicationScheduleInput, now: Date): Date[] {
    if (schedule.mode === 'once') {
      return [new Date(schedule.at)];
    }
    if (schedule.mode === 'slots') {
      return [...new Set(schedule.slots.map((slot) => new Date(slot).getTime()))]
        .sort((left, right) => left - right)
        .map((timestamp) => new Date(timestamp));
    }
    if (schedule.mode === 'now') {
      return [now];
    }
    return expandPublicationSchedule(schedule, {
      from: now,
      to: new Date(now.getTime() + PUBLICATION_RECURRENCE_HORIZON_MS),
      existingCount: 0,
      now,
    });
  }

  private isInitialRecurrenceExhausted(
    schedule: PublicationScheduleInput | null,
    initialSlots: Date[],
    now: Date,
  ): boolean {
    if (schedule?.mode !== 'recurrence') {
      return false;
    }
    if (schedule.maxOccurrences !== null && initialSlots.length >= schedule.maxOccurrences) {
      return true;
    }
    const horizon = new Date(now.getTime() + PUBLICATION_RECURRENCE_HORIZON_MS);
    return schedule.endsAt !== null && new Date(schedule.endsAt) <= horizon;
  }

  private assertPublishableSchedule(
    schedule: PublicationScheduleInput | null,
    initialSlots: Date[],
    now: Date,
  ): void {
    if (
      schedule?.mode !== 'recurrence' ||
      initialSlots.length > 0 ||
      schedule.endsAt === null ||
      this.findNextRecurrenceSlot(schedule, now, 0)
    ) {
      return;
    }

    throw new BadRequestException({
      code: 'PUBLICATION_SCHEDULE_EMPTY',
      message: 'Расписание не содержит ни одного будущего запуска.',
    });
  }

  private resolveInitialRecurrenceMaterializeAt(
    schedule: PublicationScheduleInput | null,
    initialSlots: Date[],
    exhausted: boolean,
    now: Date,
  ): Date | null {
    if (schedule?.mode !== 'recurrence' || exhausted) {
      return null;
    }
    if (initialSlots.length > 0) {
      return new Date(now.getTime() + PUBLICATION_RECURRENCE_REFRESH_MS);
    }

    const nextSlot = this.findNextRecurrenceSlot(schedule, now, 0);
    return nextSlot ? this.resolveRecurrenceHorizonEntry(nextSlot, now) : now;
  }

  private findNextRecurrenceSlot(
    schedule: Extract<PublicationScheduleInput, { mode: 'recurrence' }>,
    from: Date,
    existingCount: number,
  ): Date | null {
    const startsAt = schedule.startsAt ? new Date(schedule.startsAt) : from;
    const searchFrom = startsAt > from ? startsAt : from;
    const lookaheadEnd = new Date(searchFrom.getTime() + PUBLICATION_RECURRENCE_LOOKAHEAD_MS);
    const endsAt = schedule.endsAt ? new Date(schedule.endsAt) : null;
    const searchTo = endsAt && endsAt < lookaheadEnd ? endsAt : lookaheadEnd;
    if (searchTo < searchFrom) {
      return null;
    }

    return (
      expandPublicationSchedule(schedule, {
        from: searchFrom,
        to: searchTo,
        existingCount,
        now: from,
      })[0] ?? null
    );
  }

  private resolveRecurrenceHorizonEntry(nextSlot: Date, now: Date): Date {
    return new Date(
      Math.max(now.getTime(), nextSlot.getTime() - PUBLICATION_RECURRENCE_HORIZON_MS),
    );
  }

  private async assertCalendarAvailability(
    targets: ResolvedPublicationTarget[],
    slots: Date[],
    schedule: PublicationScheduleInput | null,
    actorUserId: string,
    excludePublicationId?: string,
  ): Promise<void> {
    if (!schedule || schedule.mode === 'now' || slots.length === 0) {
      return;
    }
    const conflicts = await findPublicationCalendarConflicts(
      this.prisma,
      targets,
      slots,
      excludePublicationId,
    );
    if (conflicts.reservations.length === 0 && conflicts.occurrences.length === 0) {
      return;
    }
    const replaceConflicts = 'replaceConflicts' in schedule && schedule.replaceConflicts;
    if (!replaceConflicts) {
      this.throwPublicationCalendarConflict(conflicts, targets);
    }
    this.assertPublicationOccurrenceReplacementSafe(conflicts.occurrences, targets);
  }

  private async reservePublicationCalendar(
    tx: any,
    targets: ResolvedPublicationTarget[],
    slots: Date[],
    schedule: PublicationScheduleInput,
    excludePublicationId: string,
    actorUserId: string,
    calendarAlreadyLocked = false,
  ): Promise<void> {
    if (schedule.mode === 'now' || slots.length === 0) {
      return;
    }
    if (!calendarAlreadyLocked) {
      await this.lockPublicationCalendar(tx);
    }
    const conflicts = await findPublicationCalendarConflicts(
      tx,
      targets,
      slots,
      excludePublicationId,
    );
    if (conflicts.reservations.length === 0 && conflicts.occurrences.length === 0) {
      return;
    }
    const replaceConflicts = 'replaceConflicts' in schedule && schedule.replaceConflicts;
    if (!replaceConflicts) {
      this.throwPublicationCalendarConflict(conflicts, targets);
    }
    this.assertPublicationOccurrenceReplacementSafe(conflicts.occurrences, targets);

    const publicationOccurrenceIds = conflicts.occurrences.map((occurrence) => occurrence.id);
    const publicationExecutionBroadcasts =
      publicationOccurrenceIds.length > 0
        ? await tx.managedBroadcast.findMany({
            where: { publicationOccurrenceId: { in: publicationOccurrenceIds } },
            select: { id: true },
          })
        : [];
    const publicationExecutionBroadcastIds = new Set<string>(
      publicationExecutionBroadcasts.map((broadcast: { id: string }) => broadcast.id),
    );
    const reservationGroups = new Map<
      string,
      {
        entityType: ChatEntityType;
        scheduledAt: Date;
        broadcastIds: Set<string>;
        targetChatIds: Set<string>;
      }
    >();
    for (const reservation of conflicts.reservations) {
      if (publicationExecutionBroadcastIds.has(reservation.broadcastId)) {
        continue;
      }
      const key = `${reservation.entityType}:${reservation.scheduledAt.toISOString()}`;
      const group = reservationGroups.get(key) ?? {
        entityType: reservation.entityType,
        scheduledAt: reservation.scheduledAt,
        broadcastIds: new Set<string>(),
        targetChatIds: new Set<string>(),
      };
      group.broadcastIds.add(reservation.broadcastId);
      for (const target of targets) {
        if (this.toPrismaEntityType(target.entityType) === reservation.entityType) {
          group.targetChatIds.add(target.chatId);
        }
      }
      reservationGroups.set(key, group);
    }
    for (const group of reservationGroups.values()) {
      await this.cancelConflictingBroadcasts(tx, [...group.broadcastIds], {
        entityType: group.entityType,
        scheduledAt: group.scheduledAt,
        targetChatIds: [...group.targetChatIds],
        actorUserId,
      });
    }
    if (conflicts.occurrences.length > 0) {
      await this.cancelConflictingPublicationOccurrences(tx, conflicts.occurrences);
    }
  }

  private async lockPublicationCalendar(tx: any): Promise<void> {
    await tx.$executeRaw(Prisma.sql`
      SELECT pg_advisory_xact_lock(hashtext('publication-calendar'))
    `);
  }

  private throwPublicationCalendarConflict(
    conflicts: PublicationCalendarConflicts,
    targets: ResolvedPublicationTarget[],
  ): never {
    const requestedTargets = new Set(
      targets.map((target) => `${this.toPrismaEntityType(target.entityType)}:${target.chatId}`),
    );
    const details = [
      ...conflicts.reservations.map((conflict) => ({
        chatId: conflict.targetChatId,
        scheduledAt: conflict.scheduledAt.toISOString(),
      })),
      ...conflicts.occurrences.flatMap((occurrence) =>
        occurrence.publication.targets
          .filter((target) => requestedTargets.has(`${target.entityType}:${target.targetChatId}`))
          .map((target) => ({
            chatId: target.targetChatId,
            scheduledAt: occurrence.scheduledAt.toISOString(),
          })),
      ),
    ];
    throw new ConflictException({
      code: 'PUBLICATION_SCHEDULE_CONFLICT',
      message: 'В выбранное время уже запланирована публикация.',
      conflicts: details.slice(0, 20),
    });
  }

  private assertPublicationOccurrenceReplacementSafe(
    occurrences: PublicationCalendarConflictOccurrence[],
    targets: ResolvedPublicationTarget[],
  ): void {
    // FLAG: Every replacement target has current administrator authority. The complete
    // conflicting audience must be included; its creator is retained as audit attribution.
    const replacementTargets = new Set(
      targets.map((target) => `${this.toPrismaEntityType(target.entityType)}:${target.chatId}`),
    );
    if (
      occurrences.some((occurrence) =>
        occurrence.publication.targets.some(
          (target) => !replacementTargets.has(`${target.entityType}:${target.targetChatId}`),
        ),
      )
    ) {
      throw new ConflictException({
        code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW',
        message: 'Конфликтующая публикация включает другие чаты или каналы. Измените её отдельно.',
      });
    }
  }

  private async cancelConflictingPublicationOccurrences(
    tx: any,
    occurrences: PublicationCalendarConflictOccurrence[],
  ): Promise<void> {
    const occurrenceIds = occurrences.map((occurrence) => occurrence.id);
    const attemptedDeliveries = await tx.managedBroadcastDelivery.count({
      where: {
        publicationOccurrenceId: { in: occurrenceIds },
        ...buildUnsafePublicationExecutionDeliveryWhere(),
      },
    });
    if (attemptedDeliveries > 0) {
      throwPublicationExecutionRequiresManualReview(
        'Конфликтующая публикация уже начала отправку. Проверьте её отдельно.',
      );
    }
    const broadcasts = await tx.managedBroadcast.findMany({
      where: {
        publicationOccurrenceId: { in: occurrenceIds },
        status: {
          in: [
            ManagedBroadcastStatus.ACTIVE,
            ManagedBroadcastStatus.PARTIAL,
            ManagedBroadcastStatus.FAILED,
          ],
        },
      },
      select: { id: true, lockedAt: true, lockToken: true },
    });
    const broadcastIds = await cancelUnstartedPublicationExecutionBroadcasts(
      tx,
      broadcasts,
      'Конфликтующая публикация уже начала отправку. Проверьте её отдельно.',
    );
    const canceled = await tx.publicationOccurrence.updateMany({
      where: {
        OR: occurrences.map((occurrence) => ({
          id: occurrence.id,
          scheduleId: occurrence.scheduleId,
          scheduleRevision: occurrence.scheduleRevision,
          status: {
            in: [PublicationOccurrenceStatus.SCHEDULED, PublicationOccurrenceStatus.IN_PROGRESS],
          },
        })),
      },
      data: { status: PublicationOccurrenceStatus.CANCELED },
    });
    if (canceled.count !== occurrences.length) {
      throw new ConflictException('Конфликтующая публикация уже изменилась. Обновите экран.');
    }
    if (broadcastIds.length === 0) {
      return;
    }
    await tx.managedBroadcastCalendarReservation.deleteMany({
      where: { broadcastId: { in: broadcastIds } },
    });
    await tx.managedBroadcastDelivery.updateMany({
      where: {
        broadcastId: { in: broadcastIds },
        status: {
          in: [ManagedBroadcastDeliveryStatus.PENDING, ManagedBroadcastDeliveryStatus.FAILED],
        },
      },
      data: { status: ManagedBroadcastDeliveryStatus.CANCELED, lockedAt: null, lockToken: null },
    });
  }

  private async cancelFuturePublicationWork(
    tx: any,
    publicationId: string,
    now: Date,
    retainedSlots: Date[] = [],
  ): Promise<void> {
    const elapsedRetainedSlots = retainedSlots.filter((slot) => slot < now);
    const occurrences = await tx.publicationOccurrence.findMany({
      where: {
        publicationId,
        OR: [
          { status: PublicationOccurrenceStatus.SCHEDULED },
          {
            status: PublicationOccurrenceStatus.IN_PROGRESS,
            // FLAG: Only an explicit schedule replacement may reclaim its own elapsed,
            // untouched retained slot; ordinary pause/cancel keeps its historical scope.
            ...(elapsedRetainedSlots.length
              ? {
                  OR: [
                    { scheduledAt: { gte: now } },
                    { scheduledAt: { in: elapsedRetainedSlots } },
                  ],
                }
              : { scheduledAt: { gte: now } }),
          },
        ],
        deliveries: {
          none: buildUnsafePublicationExecutionDeliveryWhere(),
        },
      },
      select: { id: true },
    });
    const occurrenceIds = occurrences.map((occurrence: any) => occurrence.id);
    if (occurrenceIds.length === 0) {
      return;
    }
    const broadcasts = await tx.managedBroadcast.findMany({
      where: {
        publicationOccurrenceId: { in: occurrenceIds },
        status: {
          in: [
            ManagedBroadcastStatus.ACTIVE,
            ManagedBroadcastStatus.PARTIAL,
            ManagedBroadcastStatus.FAILED,
          ],
        },
      },
      select: { id: true, lockedAt: true, lockToken: true },
    });
    const broadcastIds = await cancelUnstartedPublicationExecutionBroadcasts(
      tx,
      broadcasts,
      'Публикация уже начала отправку. Проверьте доставки отдельно.',
    );
    if (broadcastIds.length > 0) {
      await tx.managedBroadcastCalendarReservation.deleteMany({
        where: { broadcastId: { in: broadcastIds } },
      });
      await tx.managedBroadcastDelivery.updateMany({
        where: {
          broadcastId: { in: broadcastIds },
          status: {
            in: [ManagedBroadcastDeliveryStatus.PENDING, ManagedBroadcastDeliveryStatus.FAILED],
          },
        },
        data: { status: ManagedBroadcastDeliveryStatus.CANCELED, lockedAt: null, lockToken: null },
      });
    }
    const canceledOccurrences = await tx.publicationOccurrence.updateMany({
      where: {
        id: { in: occurrenceIds },
        deliveries: {
          none: buildUnsafePublicationExecutionDeliveryWhere(),
        },
      },
      data: { status: PublicationOccurrenceStatus.CANCELED },
    });
    if (canceledOccurrences.count !== occurrenceIds.length) {
      throwPublicationExecutionRequiresManualReview(
        'Публикация уже начала отправку. Проверьте доставки отдельно.',
      );
    }
  }

  private async restoreAccessLossPausedOccurrences(
    tx: any,
    publicationId: string,
    scheduleId: string,
    scheduleRevision: number,
    now: Date,
  ): Promise<void> {
    const recoverable = await tx.publicationOccurrence.findMany({
      where: {
        publicationId,
        scheduleId,
        scheduleRevision,
        status: PublicationOccurrenceStatus.SCHEDULED,
        scheduledAt: { gte: now },
        deliveries: {
          none: {
            OR: [
              { attemptCount: { gt: 0 } },
              {
                status: {
                  in: [
                    ManagedBroadcastDeliveryStatus.SENDING,
                    ManagedBroadcastDeliveryStatus.SENT,
                    ManagedBroadcastDeliveryStatus.AMBIGUOUS,
                  ],
                },
              },
            ],
          },
        },
        legacyBroadcasts: { every: { status: ManagedBroadcastStatus.CANCELED } },
      },
      select: { id: true },
    });
    const occurrenceIds = recoverable.map((occurrence: { id: string }) => occurrence.id);
    if (occurrenceIds.length === 0) {
      return;
    }
    const broadcasts = await tx.managedBroadcast.findMany({
      where: {
        publicationOccurrenceId: { in: occurrenceIds },
        status: ManagedBroadcastStatus.CANCELED,
      },
      select: { id: true },
    });
    const broadcastIds = broadcasts.map((broadcast: { id: string }) => broadcast.id);
    if (broadcastIds.length > 0) {
      await tx.managedBroadcast.deleteMany({ where: { id: { in: broadcastIds } } });
    }
  }

  private async cancelConflictingBroadcasts(
    tx: any,
    broadcastIds: string[],
    replacement: {
      entityType: ChatEntityType;
      scheduledAt: Date;
      targetChatIds: string[];
      actorUserId: string;
    },
  ): Promise<void> {
    const uniqueBroadcastIds = [...new Set(broadcastIds)];
    if (uniqueBroadcastIds.length === 0) {
      return;
    }
    const [attemptedDeliveries, unsafeBroadcasts] = await Promise.all([
      tx.managedBroadcastDelivery.count({
        where: {
          broadcastId: { in: uniqueBroadcastIds },
          OR: [
            { attemptCount: { gt: 0 } },
            { lockedAt: { not: null } },
            {
              status: {
                in: [
                  ManagedBroadcastDeliveryStatus.SENDING,
                  ManagedBroadcastDeliveryStatus.SENT,
                  ManagedBroadcastDeliveryStatus.AMBIGUOUS,
                ],
              },
            },
          ],
        },
      }),
      tx.managedBroadcast.findMany({
        where: {
          id: { in: uniqueBroadcastIds },
          OR: [
            { actorUserId: { not: replacement.actorUserId } },
            { sentCount: { gt: 0 } },
            { lockedAt: { not: null } },
            { lockToken: { not: null } },
          ],
        },
        select: { id: true, actorUserId: true },
      }),
    ]);
    if (
      unsafeBroadcasts.some(
        (broadcast: { actorUserId: string }) => broadcast.actorUserId !== replacement.actorUserId,
      )
    ) {
      throw new ConflictException({
        code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW',
        message: 'Слот занят отправкой другого администратора. Выберите другое время.',
      });
    }
    if (attemptedDeliveries > 0 || unsafeBroadcasts.length > 0) {
      throw new ConflictException({
        code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW',
        message: 'Конфликтующая публикация уже начала отправку. Проверьте её отдельно.',
      });
    }
    const reservations = await tx.managedBroadcastCalendarReservation.findMany({
      where: { broadcastId: { in: uniqueBroadcastIds } },
      select: {
        broadcastId: true,
        entityType: true,
        targetChatId: true,
        scheduledAt: true,
      },
    });
    const replacementTargets = new Set(replacement.targetChatIds);
    const replacementTime = replacement.scheduledAt.getTime();
    const reservationBroadcastIds = new Set(
      reservations.map((reservation: { broadcastId: string }) => reservation.broadcastId),
    );
    const canReplaceWholeBroadcast =
      reservationBroadcastIds.size === uniqueBroadcastIds.length &&
      uniqueBroadcastIds.every((broadcastId) => reservationBroadcastIds.has(broadcastId)) &&
      reservations.every(
        (reservation: { entityType: ChatEntityType; targetChatId: string; scheduledAt: Date }) =>
          reservation.entityType === replacement.entityType &&
          reservation.scheduledAt.getTime() === replacementTime &&
          replacementTargets.has(reservation.targetChatId),
      );
    if (!canReplaceWholeBroadcast) {
      throw new ConflictException({
        code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW',
        message: 'Конфликтующая публикация включает другие чаты или время. Измените её отдельно.',
      });
    }
    const canceledBroadcasts = await tx.managedBroadcast.updateMany({
      where: {
        id: { in: uniqueBroadcastIds },
        actorUserId: replacement.actorUserId,
        status: {
          in: [
            ManagedBroadcastStatus.ACTIVE,
            ManagedBroadcastStatus.PARTIAL,
            ManagedBroadcastStatus.FAILED,
          ],
        },
        sentCount: 0,
        lockedAt: null,
        lockToken: null,
        deliveries: {
          none: {
            OR: [
              { attemptCount: { gt: 0 } },
              { lockedAt: { not: null } },
              {
                status: {
                  in: [
                    ManagedBroadcastDeliveryStatus.SENDING,
                    ManagedBroadcastDeliveryStatus.SENT,
                    ManagedBroadcastDeliveryStatus.AMBIGUOUS,
                  ],
                },
              },
            ],
          },
        },
      },
      data: {
        status: ManagedBroadcastStatus.CANCELED,
        nextSendAt: null,
        lockedAt: null,
        lockToken: null,
      },
    });
    if (canceledBroadcasts.count !== uniqueBroadcastIds.length) {
      throw new ConflictException({
        code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW',
        message: 'Конфликтующая публикация уже начала отправку. Проверьте её отдельно.',
      });
    }
    await tx.managedBroadcastCalendarReservation.deleteMany({
      where: { broadcastId: { in: uniqueBroadcastIds } },
    });
    await tx.managedBroadcastDelivery.updateMany({
      where: {
        broadcastId: { in: uniqueBroadcastIds },
        status: {
          in: [ManagedBroadcastDeliveryStatus.PENDING, ManagedBroadcastDeliveryStatus.FAILED],
        },
      },
      data: { status: ManagedBroadcastDeliveryStatus.CANCELED, lockedAt: null, lockToken: null },
    });
    await tx.publicationOccurrence.updateMany({
      where: {
        legacyBroadcasts: {
          some: { id: { in: uniqueBroadcastIds } },
          every: { status: ManagedBroadcastStatus.CANCELED },
        },
      },
      data: { status: PublicationOccurrenceStatus.CANCELED },
    });
  }

  private async assertPublicationOwner(
    publicationId: string,
    actorUserId: string,
    dispatchProfile?: PublicationDispatchProfile,
    mode: 'read' | 'manage' = 'manage',
  ) {
    const publication = await this.prisma.publication.findFirst({
      where: {
        id: publicationId,
        ...this.publicationAccessWhere(actorUserId, dispatchProfile, mode),
        ...(dispatchProfile ? { dispatchProfile } : {}),
      },
      select: {
        id: true,
        version: true,
        lifecycle: true,
        dispatchProfile: true,
        requiredBotId: true,
        canonicalContentRevisionId: true,
        targets: {
          ...(dispatchProfile === PublicationDispatchProfile.PUBLIK_V1 && mode === 'read'
            ? {
                where: publicationAdminTargetWhere(
                  publicationAdminScope(
                    actorUserId,
                    this.publisherRouting.requireNewRoute().requiredBotId,
                  ),
                ),
              }
            : {}),
          orderBy: { position: 'asc' },
          select: { targetChatId: true, entityType: true },
        },
      },
    });
    if (!publication) {
      throw new NotFoundException('Публикация не найдена.');
    }
    return publication;
  }

  private publicationAccessWhere(
    actorUserId: string,
    profile?: PublicationDispatchProfile,
    mode: 'read' | 'manage' = 'manage',
  ): Prisma.PublicationWhereInput {
    return publicationAdminAccessWhere(
      publicationAdminScope(
        actorUserId,
        profile === PublicationDispatchProfile.PUBLIK_V1
          ? this.publisherRouting.requireNewRoute().requiredBotId
          : undefined,
      ),
      profile,
      mode,
    );
  }

  private assertNewPublicationProfile(dispatchProfile: PublicationDispatchProfile): void {
    if (dispatchProfile !== PublicationDispatchProfile.PUBLIK_V1) {
      throw new BadRequestException('Новые публикации создаются только через Публик.');
    }
  }

  private async assertTargetAdminAccess(target: PublicationTargetInput, user: AuthUser) {
    return target.entityType === 'channel'
      ? this.managedEntitiesService.assertChannelAdminAccess(target.chatId, user)
      : this.managedEntitiesService.assertChatAdminAccess(target.chatId, user);
  }

  private async findMutationReplay(actorUserId: string, requestId: string, requestHash: string) {
    const record = await this.prisma.publicationMutationRecord.findUnique({
      where: { actorUserId_requestId: { actorUserId, requestId } },
      select: { publicationId: true, requestHash: true },
    });
    if (!record) {
      return null;
    }
    if (record.requestHash !== requestHash) {
      throw new BadRequestException('Ключ повтора уже использован для другого изменения.');
    }
    return record;
  }

  private assertReplayPublication(actualPublicationId: string, expectedPublicationId: string) {
    if (actualPublicationId !== expectedPublicationId) {
      throw new BadRequestException('Ключ повтора относится к другой публикации.');
    }
  }

  private hashMutationRequest(value: unknown): string {
    return createHash('sha256').update(this.stableStringify(value)).digest('hex');
  }

  private stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }
    if (value && typeof value === 'object') {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => `${JSON.stringify(key)}:${this.stableStringify(item)}`)
        .join(',')}}`;
    }
    return JSON.stringify(value);
  }

  private toPrismaEntityType(entityType: 'chat' | 'channel'): ChatEntityType {
    return entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT;
  }

  private fromPrismaEntityType(entityType: ChatEntityType): 'chat' | 'channel' {
    return entityType === ChatEntityType.CHANNEL ? 'channel' : 'chat';
  }

  private toPrismaScheduleMode(mode: PublicationScheduleInput['mode']): PublicationScheduleMode {
    return {
      now: PublicationScheduleMode.NOW,
      once: PublicationScheduleMode.ONCE,
      slots: PublicationScheduleMode.SLOTS,
      recurrence: PublicationScheduleMode.RECURRENCE,
    }[mode];
  }

  private async resolveBackgroundDecision(
    reason: 'startup' | 'scheduled',
  ): Promise<'run' | 'slow' | 'pause'> {
    const decision = await this.backgroundRuntimeGovernorService.decide({
      component: 'publication-materializer',
      publicationMetadataOnly: true,
      sourceTag: MAX_API_SOURCE_TAGS.MANAGED_BROADCAST,
      allowRecoveryWindowRun: true,
      allowMaxApiCapacitySlowPath: true,
      allowQueueBacklogSlowPath: true,
    });
    if (decision.action !== 'run') {
      this.logThrottle(reason, decision.action, decision.reason);
      return decision.action;
    }
    return 'run';
  }

  private logThrottle(
    reason: 'startup' | 'scheduled',
    action: 'slow' | 'pause',
    details: string,
  ): void {
    const now = Date.now();
    if (now - this.throttleLogAtMs < 60_000) {
      return;
    }
    this.throttleLogAtMs = now;
    this.logger.log(
      { reason, action, details },
      action === 'pause' ? 'Paused publication materializer' : 'Throttled publication materializer',
    );
  }
}
