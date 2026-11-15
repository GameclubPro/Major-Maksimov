import {
  PublisherActorAccessRequiredException,
  PublisherSetupRequiredException,
} from '../publisher/publisher-errors';
import {
  MAX_PUBLISHER_BULK_REFRESH_TARGETS,
  publisherEntitiesCursorQuerySchema,
  publisherEntitiesCursorResponseSchema,
  publisherEntitiesResponseSchema,
  publisherEntitySchema,
  resolvePublisherEntitiesRequestSchema,
  resolvePublisherEntitiesResponseSchema,
  updateManagedEntityPublicationPolicyRequestSchema,
  updatePublisherEntityModuleSettingsRequestSchema,
  type ManagedEntityPublicationPolicy,
  type ManagedEntityType,
  type PublisherEntitiesCursorQuery,
  type PublisherEntitiesResponse,
  type PublisherEntity,
  type PublisherEntityModuleSettings,
  type ResolvePublisherEntitiesResponse,
} from '@maxim/contracts/publisher';
import { CHANNEL_POST_SIGNATURE_DEFAULT_TEXT } from '@maxim/contracts/channel-post-signature';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  HttpStatus,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChannelPostSignaturePresentation,
  ChatEntityType,
  ManagedEntityAccessRole,
  ManagedEntityAccessState,
  Prisma,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { PublisherBindingRefreshQueueService } from '../publisher/publisher-binding-refresh.queue';
import { PublisherReadinessService } from '../publisher/publisher-readiness.service';
import {
  hasPublisherRefreshEvidence,
  isPublisherBindingConnected,
  publisherConnectedBindingWhere,
  publisherRefreshEvidenceWhere,
} from '../publisher/publisher-entity-connection.util';
import { ManagedEntitiesService } from './managed-entities.service';
import { PublisherSelectedAccessService } from './publisher-selected-access.service';
import {
  BotCapabilityRequiredException,
  type BotCapabilityPermission,
} from './bot-capability-required.error';
import { PublisherCatalogQueryService } from './publisher-catalog-query.service';

const PUBLISHER_CATALOG_LOOKUP_BATCH_SIZE = 200;
const PUBLISHER_BULK_REFRESH_QUERY_TAKE = 200;
const PUBLISHER_BULK_REFRESH_MAX_QUERY_PAGES = 10;
const MAX_PRESENTATION_URL_LENGTH = 2_048;

type PublisherCatalogPresentation = {
  title: string;
  entityType: ChatEntityType;
  avatarUrl: string | null;
  entityUrl: string | null;
};

type PublisherRefreshCandidateRow = {
  chatId: string;
  publisherBotId: string;
  status: ChatBotMembershipStatus;
  botAccessState: ChatBotAccessState;
  botAccessSource: string | null;
  permissionsSnapshot: unknown;
  lastSeenAt: Date | null;
  lastWebhookAt: Date | null;
  chat: {
    accessEdges: readonly { botId: string; entityType: ChatEntityType }[];
  };
};

@Injectable()
export class PublisherPolicyService {
  private readonly logger = new Logger(PublisherPolicyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly botRegistry: MaxBotRegistryService,
    private readonly readinessService: PublisherReadinessService,
    private readonly managedEntitiesService: ManagedEntitiesService,
    private readonly publisherBindingRefreshQueue: PublisherBindingRefreshQueueService,
    @Optional() private readonly selectedAccess?: PublisherSelectedAccessService,
    @Optional() private readonly catalogQuery?: PublisherCatalogQueryService,
  ) {}

  async listEntities(user: AuthUser, query?: unknown): Promise<PublisherEntitiesResponse> {
    const pagination = this.readPaginationMode(query);
    if (pagination === undefined) {
      return publisherEntitiesResponseSchema.parse({
        items: await this.loadScopedEntities(user, undefined, true, true),
        accessVerificationPending: false,
      });
    }

    const parsed = publisherEntitiesCursorQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    return this.listEntitiesPage(user, parsed.data);
  }

  private async loadScopedEntities(
    user: AuthUser,
    entityIds?: readonly string[],
    includeDisabled = false,
    _catalogOnly = false,
  ): Promise<PublisherEntity[]> {
    const publisherBotId = this.botRegistry.getPublisherBotDescriptor().id;
    const now = new Date();
    const [runtimeAvailable, edges] = await Promise.all([
      this.readinessService.isRuntimeAvailable(),
      this.prisma.managedEntityAccessEdge.findMany({
        where: {
          ...(entityIds ? { chatId: { in: [...entityIds] } } : {}),
          userId: user.userId,
          state: ManagedEntityAccessState.GRANTED,
          userRole: { in: [ManagedEntityAccessRole.OWNER, ManagedEntityAccessRole.ADMIN] },
          // FLAG: Retained exact-bot grants authorize until MAX explicitly revokes them.
          // Admission still checks the connected binding, catalog and publication policy.
          botId: publisherBotId,
          chat: {
            ...(!includeDisabled
              ? {
                  OR: [
                    { publicationPolicy: { is: null } },
                    { publicationPolicy: { is: { publikEnabled: true } } },
                  ],
                }
              : {}),
            publisherBinding: {
              is: publisherConnectedBindingWhere(publisherBotId),
            },
          },
        },
        orderBy: [{ checkedAt: 'desc' }, { chatId: 'asc' }],
        include: {
          chat: {
            select: {
              id: true,
              entityType: true,
              publisherSettings: true,
              channelSettings: {
                select: {
                  postSignatureEnabled: true,
                  postSignaturePresentation: true,
                  postSignatureText: true,
                  postSignatureUrl: true,
                  customPostButtonsEnabled: true,
                  customPostButtons: true,
                },
              },
              publicationPolicy: true,
              publisherBinding: true,
            },
          },
        },
      }),
    ]);

    const catalogPresentations = await this.loadCatalogPresentations(edges, publisherBotId);
    const eligibleEdges: typeof edges = [];
    const seenEntityIds = new Set<string>();
    for (const edge of edges) {
      const catalog = catalogPresentations.get(this.catalogKey(publisherBotId, edge.chatId));
      if (
        seenEntityIds.has(edge.chatId) ||
        !catalog ||
        edge.entityType !== catalog.entityType ||
        (!includeDisabled && edge.chat.publicationPolicy?.publikEnabled === false) ||
        !isPublisherBindingConnected(edge.chat.publisherBinding, publisherBotId) ||
        edge.botId !== publisherBotId
      ) {
        continue;
      }
      seenEntityIds.add(edge.chatId);
      eligibleEdges.push(edge);
    }

    return eligibleEdges
      .map((edge) =>
        this.presentEntity(
          edge.chat,
          { now, runtimeAvailable },
          catalogPresentations.get(this.catalogKey(publisherBotId, edge.chatId))!,
        ),
      )
      .sort((left, right) => this.compareEntities(left, right));
  }

  async getEntity(
    entityType: ManagedEntityType,
    entityId: string,
    user: AuthUser,
  ): Promise<PublisherEntity> {
    return this.loadScopedEntity(entityType, entityId, user, true);
  }

  async assertBotCapabilityForFeatureEnablement(
    entityType: ManagedEntityType,
    entityId: string,
    featureKeys: readonly string[],
    options: { canRecheck?: boolean } = {},
  ): Promise<void> {
    const expectedEntityType =
      entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT;
    const source = await this.prisma.chat.findUnique({
      where: { id: entityId },
      select: {
        entityType: true,
        publicationPolicy: true,
        publisherSettings: true,
        publisherBinding: true,
      },
    });
    if (!source || source.entityType !== expectedEntityType) {
      throw new BadRequestException('Managed entity type does not match');
    }
    await this.assertPublisherBotCapabilityForEnablement({ id: entityId, ...source }, featureKeys, {
      canRecheck: options.canRecheck ?? true,
    });
  }

  async getPolicyForPublisher(
    entityType: ManagedEntityType,
    entityId: string,
    user: AuthUser,
  ): Promise<ManagedEntityPublicationPolicy> {
    const source = await this.loadScopedEntitySource(entityType, entityId, user, true);
    return this.readinessService.resolvePolicy(source.chat.publicationPolicy);
  }

  async listRefreshableEntityIds(
    user: AuthUser,
    limit = MAX_PUBLISHER_BULK_REFRESH_TARGETS,
    excludedEntityIds: readonly string[] = [],
  ): Promise<string[]> {
    const publisherBotId = this.botRegistry.getPublisherBotDescriptor().id;
    const requestedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.trunc(limit))
      : MAX_PUBLISHER_BULK_REFRESH_TARGETS;
    const boundedLimit = Math.min(MAX_PUBLISHER_BULK_REFRESH_TARGETS, requestedLimit);
    const now = new Date();
    const actorEvidenceLookback = new Date(now.getTime() - 30 * 24 * 60 * 60_000);
    const accessWhere = {
      userId: user.userId,
      botId: publisherBotId,
      OR: [
        {
          state: ManagedEntityAccessState.GRANTED,
          userRole: { in: [ManagedEntityAccessRole.OWNER, ManagedEntityAccessRole.ADMIN] },
        },
        {
          state: {
            in: [ManagedEntityAccessState.USER_DENIED, ManagedEntityAccessState.BOT_DENIED],
          },
          checkedAt: { gt: actorEvidenceLookback },
        },
      ],
    } satisfies Prisma.ManagedEntityAccessEdgeWhereInput;
    const normalizedExclusions = [
      ...new Set(excludedEntityIds.map((entityId) => entityId.trim()).filter(Boolean)),
    ].slice(0, 1_000);
    const commonWhere = {
      ...publisherRefreshEvidenceWhere(publisherBotId),
      chat: {
        AND: [{ accessEdges: { some: accessWhere } }],
      },
    } satisfies Prisma.PublisherEntityBindingWhereInput;
    const selectedProblemIds = await this.selectRefreshCandidateIds({
      where: {
        ...commonWhere,
        ...(normalizedExclusions.length > 0 ? { chatId: { notIn: normalizedExclusions } } : {}),
        AND: [
          publisherRefreshEvidenceWhere(publisherBotId),
          {
            OR: [
              {
                botAccessState: {
                  in: [
                    ChatBotAccessState.UNKNOWN,
                    ChatBotAccessState.CONFIRMED_MEMBER,
                    ChatBotAccessState.DENIED,
                    ChatBotAccessState.LOST,
                    ChatBotAccessState.STALE,
                  ],
                },
              },
              { sendRouteQuarantinedUntil: { gt: now } },
            ],
          },
        ],
      },
      accessWhere,
      publisherBotId,
      limit: boundedLimit,
    });
    const remaining = boundedLimit - selectedProblemIds.length;
    if (remaining === 0) {
      return selectedProblemIds;
    }

    const readyExclusions = [...new Set([...normalizedExclusions, ...selectedProblemIds])];
    const selectedReadyIds = await this.selectRefreshCandidateIds({
      where: {
        ...commonWhere,
        ...(readyExclusions.length > 0 ? { chatId: { notIn: readyExclusions } } : {}),
        botAccessState: {
          in: [ChatBotAccessState.CONFIRMED_ADMIN, ChatBotAccessState.CONFIRMED_OWNER],
        },

        AND: [
          {
            OR: [{ sendRouteQuarantinedUntil: null }, { sendRouteQuarantinedUntil: { lte: now } }],
          },
        ],
      },
      accessWhere,
      publisherBotId,
      limit: remaining,
    });
    return [...new Set([...selectedProblemIds, ...selectedReadyIds])].slice(0, boundedLimit);
  }

  private async selectRefreshCandidateIds(params: {
    where: Prisma.PublisherEntityBindingWhereInput;
    accessWhere: Prisma.ManagedEntityAccessEdgeWhereInput;
    publisherBotId: string;
    limit: number;
  }): Promise<string[]> {
    const selected: string[] = [];
    let cursorChatId: string | null = null;

    for (
      let page = 0;
      page < PUBLISHER_BULK_REFRESH_MAX_QUERY_PAGES && selected.length < params.limit;
      page += 1
    ) {
      const rows: PublisherRefreshCandidateRow[] =
        await this.prisma.publisherEntityBinding.findMany({
          where: params.where,
          select: {
            chatId: true,
            publisherBotId: true,
            status: true,
            botAccessState: true,
            botAccessSource: true,
            permissionsSnapshot: true,
            lastSeenAt: true,
            lastWebhookAt: true,
            chat: {
              select: {
                accessEdges: {
                  where: params.accessWhere,
                  select: { botId: true, entityType: true },
                },
              },
            },
          },
          orderBy: [
            { botAccessCheckedAt: { sort: 'asc', nulls: 'first' } },
            { updatedAt: 'asc' },
            { chatId: 'asc' },
          ],
          take: PUBLISHER_BULK_REFRESH_QUERY_TAKE,
          ...(cursorChatId ? { cursor: { chatId: cursorChatId }, skip: 1 } : {}),
        });
      if (rows.length === 0) {
        break;
      }

      selected.push(
        ...(await this.filterRefreshCandidateRows(
          rows,
          params.publisherBotId,
          params.limit - selected.length,
        )),
      );
      cursorChatId = rows.at(-1)?.chatId ?? null;
      if (rows.length < PUBLISHER_BULK_REFRESH_QUERY_TAKE || !cursorChatId) {
        break;
      }
    }

    return [...new Set(selected)].slice(0, params.limit);
  }

  private async filterRefreshCandidateRows(
    rows: readonly PublisherRefreshCandidateRow[],
    publisherBotId: string,
    limit: number,
  ): Promise<string[]> {
    if (rows.length === 0 || limit <= 0) {
      return [];
    }
    const catalogRows = await this.prisma.managedBotChatCatalog.findMany({
      where: {
        botId: publisherBotId,
        status: 'ACTIVE',
        chatId: { in: [...new Set(rows.map((row) => row.chatId))] },
      },
      select: { chatId: true, entityType: true },
    });
    const catalogEntityTypeByChatId = new Map(
      catalogRows.map((row) => [row.chatId, row.entityType]),
    );
    const selected: string[] = [];
    for (const row of rows) {
      if (!hasPublisherRefreshEvidence(row, publisherBotId)) {
        continue;
      }
      const catalogEntityType = catalogEntityTypeByChatId.get(row.chatId);
      if (
        !catalogEntityType ||
        !row.chat.accessEdges.some(
          (edge) => edge.entityType === catalogEntityType && edge.botId === publisherBotId,
        )
      ) {
        continue;
      }
      selected.push(row.chatId);
      if (selected.length >= limit) {
        break;
      }
    }
    return selected;
  }

  private async loadScopedEntity(
    entityType: ManagedEntityType,
    entityId: string,
    user: AuthUser,
    includeDisabled = false,
  ): Promise<PublisherEntity> {
    const source = await this.loadScopedEntitySource(entityType, entityId, user, includeDisabled);
    return this.presentEntity(
      source.chat,
      {
        now: new Date(),
        runtimeAvailable: await this.readinessService.isRuntimeAvailable(),
      },
      source.catalogPresentation,
    );
  }

  private async loadScopedEntitySource(
    entityType: ManagedEntityType,
    entityId: string,
    user: AuthUser,
    includeDisabled: boolean,
  ) {
    // FLAG: Runtime must verify the selected actor before returning settings or allowing writes.
    if (!this.selectedAccess && process.env.NODE_ENV !== 'test')
      throw new ServiceUnavailableException('Проверка прав временно недоступна.');
    await this.selectedAccess?.assertAccess(user, entityId, entityType);
    const publisherBotId = this.botRegistry.getPublisherBotDescriptor().id;
    const edges = await this.prisma.managedEntityAccessEdge.findMany({
      where: {
        chatId: entityId,
        userId: user.userId,
        entityType: entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT,
        state: ManagedEntityAccessState.GRANTED,
        userRole: { in: [ManagedEntityAccessRole.OWNER, ManagedEntityAccessRole.ADMIN] },
        botId: publisherBotId,
        chat: {
          ...(!includeDisabled
            ? {
                OR: [
                  { publicationPolicy: { is: null } },
                  { publicationPolicy: { is: { publikEnabled: true } } },
                ],
              }
            : {}),
          publisherBinding: {
            is: publisherConnectedBindingWhere(publisherBotId),
          },
        },
      },
      orderBy: [{ checkedAt: 'desc' }, { chatId: 'asc' }],
      include: {
        chat: {
          select: {
            id: true,
            entityType: true,
            publisherSettings: true,
            channelSettings: {
              select: {
                postSignatureEnabled: true,
                postSignaturePresentation: true,
                postSignatureText: true,
                postSignatureUrl: true,
                customPostButtonsEnabled: true,
                customPostButtons: true,
              },
            },
            publicationPolicy: true,
            publisherBinding: true,
          },
        },
      },
    });
    const edge = edges.find(
      (candidate) =>
        candidate.entityType ===
          (entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT) &&
        (includeDisabled || candidate.chat.publicationPolicy?.publikEnabled !== false) &&
        isPublisherBindingConnected(candidate.chat.publisherBinding, publisherBotId) &&
        candidate.botId === publisherBotId,
    );
    if (!edge) {
      throw new BadRequestException('Managed entity is unavailable');
    }
    const catalogPresentation = await this.loadTargetedCatalogPresentation(edge, publisherBotId);
    if (!catalogPresentation) {
      throw new BadRequestException('Managed entity is unavailable');
    }
    return { chat: edge.chat, catalogPresentation };
  }

  async resolveEntities(user: AuthUser, body: unknown): Promise<ResolvePublisherEntitiesResponse> {
    const parsed = resolvePublisherEntitiesRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const requested = new Map(
      parsed.data.targets.map((target) => [`${target.entityType}:${target.id}`, target]),
    );
    const entities = await this.loadScopedEntities(user, [
      ...new Set([...requested.values()].map((target) => target.id)),
    ]);
    const entitiesByKey = new Map(
      entities.map((entity) => [`${entity.entityType}:${entity.id}`, entity]),
    );
    return resolvePublisherEntitiesResponseSchema.parse({
      items: [...requested.keys()].flatMap((key) => {
        const entity = entitiesByKey.get(key);
        return entity ? [entity] : [];
      }),
    });
  }

  async resolvePublicationTargets(
    user: AuthUser,
    targets?: readonly { chatId: string; entityType: ManagedEntityType }[],
  ): Promise<
    Array<{
      chatId: string;
      entityType: ManagedEntityType;
      title: string;
      avatarUrl: string | null;
      link: string | null;
    }>
  > {
    const entities = await this.loadScopedEntities(
      user,
      targets ? [...new Set(targets.map((target) => target.chatId))] : undefined,
      true,
    );
    const byKey = new Map(entities.map((entity) => [`${entity.entityType}:${entity.id}`, entity]));
    const missing = targets?.find((target) => !byKey.has(`${target.entityType}:${target.chatId}`));
    if (missing) {
      const now = new Date();
      const [edge] = await this.prisma.managedEntityAccessEdge.findMany({
        where: {
          chatId: missing.chatId,
          userId: user.userId,
          botId: this.botRegistry.getPublisherBotDescriptor().id,
          entityType:
            missing.entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT,
          state: ManagedEntityAccessState.GRANTED,
          userRole: { in: [ManagedEntityAccessRole.OWNER, ManagedEntityAccessRole.ADMIN] },
        },
        take: 1,
        include: {
          chat: {
            select: {
              id: true,
              entityType: true,
              publicationPolicy: true,
              publisherSettings: true,
              publisherBinding: true,
            },
          },
        },
      });
      // FLAG: Diagnose connection/catalog state only after proving this actor's
      // current exact-bot access; missing/denied access must not reveal entity metadata.
      if (!edge) throw new PublisherActorAccessRequiredException([missing.chatId]);
      const readiness = this.readinessService.resolveReadiness(edge.chat, {
        now,
        runtimeAvailable: await this.readinessService.isRuntimeAvailable(),
      });
      throw new PublisherSetupRequiredException(
        [missing.chatId],
        readiness.blockerCode ?? 'catalog_unconfirmed',
      );
    }
    const selected = targets
      ? targets.map((target) => {
          const entity = byKey.get(`${target.entityType}:${target.chatId}`);
          if (!entity) {
            throw new PublisherActorAccessRequiredException([target.chatId]);
          }
          if (!entity.policy.publikEnabled) {
            throw new PublisherSetupRequiredException([target.chatId], 'policy_disabled');
          }
          return entity;
        })
      : entities.filter((entity) => entity.policy.publikEnabled);
    return selected.map((entity) => ({
      chatId: entity.id,
      entityType: entity.entityType,
      title: entity.title,
      avatarUrl: entity.avatarUrl,
      link: entity.entityUrl,
    }));
  }

  async resolveDraftTargets(
    user: AuthUser,
    targets: readonly { chatId: string; entityType: ManagedEntityType }[],
  ) {
    if (targets.length === 0) return [];
    const entities = await this.loadScopedEntities(
      user,
      targets.map((target) => target.chatId),
      true,
    );
    const byKey = new Map(entities.map((entity) => [`${entity.entityType}:${entity.id}`, entity]));
    return targets.map((target) => {
      const entity = byKey.get(`${target.entityType}:${target.chatId}`);
      if (!entity)
        throw new BadRequestException('Получатель больше недоступен. Уберите его из черновика.');
      return { chatId: entity.id, entityType: entity.entityType };
    });
  }

  async updatePolicy(
    entityType: ManagedEntityType,
    entityId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<ManagedEntityPublicationPolicy> {
    const parsed = updateManagedEntityPublicationPolicyRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const request = parsed.data;
    await this.loadScopedEntitySource(entityType, entityId, user, true);
    const expectedEntityType =
      entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT;
    const existingChat = await this.prisma.chat.findUnique({
      where: { id: entityId },
      select: {
        entityType: true,
        publicationPolicy: true,
        publisherSettings: true,
        publisherBinding: true,
      },
    });
    if (!existingChat || existingChat.entityType !== expectedEntityType) {
      throw new BadRequestException('Managed entity type does not match');
    }
    if (existingChat.publicationPolicy?.publikEnabled === false && request.publikEnabled) {
      await this.assertPublisherBotCapabilityForEnablement(
        { id: entityId, ...existingChat },
        ['publikEnabled'],
        { canRecheck: false, enqueuePolicyEnablementRecheck: true },
      );
    }

    try {
      const policy = await this.prisma.$transaction(async (tx) => {
        let updated;
        if (!existingChat.publicationPolicy) {
          if (request.expectedRevision !== 0) {
            throw this.policyConflict();
          }
          updated = await tx.managedEntityPublicationPolicy.create({
            data: {
              chatId: entityId,
              publikEnabled: request.publikEnabled,
              updatedByUserId: user.userId,
            },
          });
        } else {
          const changed = await tx.managedEntityPublicationPolicy.updateMany({
            where: { chatId: entityId, revision: request.expectedRevision },
            data: {
              publikEnabled: request.publikEnabled,
              revision: { increment: 1 },
              updatedByUserId: user.userId,
            },
          });
          if (changed.count !== 1) {
            throw this.policyConflict();
          }
          updated = await tx.managedEntityPublicationPolicy.findUniqueOrThrow({
            where: { chatId: entityId },
          });
        }
        await tx.auditLog.create({
          data: {
            chatId: entityId,
            actorUserId: user.userId,
            action: 'UPDATE_PUBLICATION_POLICY',
            payload: {
              changed: { publikEnabled: request.publikEnabled },
              revision: updated.revision,
            } satisfies Prisma.InputJsonValue,
          },
        });
        return updated;
      });
      return this.readinessService.resolvePolicy(policy);
    } catch (error: unknown) {
      if ((error as { code?: unknown })?.code === 'P2002') {
        throw this.policyConflict();
      }
      throw error;
    }
  }

  async updateModuleSettings(
    entityType: ManagedEntityType,
    entityId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<PublisherEntityModuleSettings> {
    const parsed = updatePublisherEntityModuleSettingsRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }
    const request = parsed.data;
    if (
      entityType === 'chat' &&
      (request.channelCommentsEnabled !== undefined ||
        request.channelSuggestionsEnabled !== undefined ||
        request.channelSuggestionsRequireSubscription !== undefined ||
        request.channelSuggestionsDeleteOnUnsubscribe !== undefined)
    ) {
      throw new BadRequestException(
        'Комментарии канала и предложки Публика доступны только для каналов',
      );
    }
    if (
      entityType === 'channel' &&
      (request.chatComments !== undefined || request.autoRepliesEnabled !== undefined)
    ) {
      throw new BadRequestException('Комментарии и автоответы Публика доступны только для чатов');
    }

    await this.getEntity(entityType, entityId, user);
    const expectedEntityType =
      entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT;
    const existingChat = await this.prisma.chat.findUnique({
      where: { id: entityId },
      select: {
        entityType: true,
        publicationPolicy: true,
        publisherSettings: true,
        publisherBinding: true,
      },
    });
    if (!existingChat || existingChat.entityType !== expectedEntityType) {
      throw new BadRequestException('Managed entity type does not match');
    }
    const enablementFeatureKeys = this.resolveModuleEnablementFeatureKeys(
      request,
      existingChat.publisherSettings,
    );
    if (enablementFeatureKeys.length > 0) {
      await this.assertPublisherBotCapabilityForEnablement(
        { id: entityId, ...existingChat },
        enablementFeatureKeys,
        { canRecheck: true },
      );
    }

    try {
      const settings = await this.prisma.$transaction(async (tx) => {
        let updated;
        if (!existingChat.publisherSettings) {
          if (request.expectedRevision !== 0) {
            throw this.policyConflict();
          }
          updated = await tx.publisherEntitySettings.create({
            data: {
              chatId: entityId,
              ...(request.chatComments
                ? {
                    chatCommentsEnabled: request.chatComments.commentsEnabled,
                    chatCommentsAdminsEnabled: request.chatComments.commentsAdminsEnabled,
                    chatCommentsPostsEnabled: request.chatComments.commentsChatBroadcastsEnabled,
                    chatCommentsReplaceOriginalEnabled:
                      request.chatComments.commentsReplaceOriginalEnabled,
                  }
                : {}),
              ...(request.channelSuggestionsEnabled !== undefined
                ? { channelSuggestionsEnabled: request.channelSuggestionsEnabled }
                : {}),
              ...(request.channelSuggestionsRequireSubscription !== undefined
                ? {
                    channelSuggestionsRequireSubscription:
                      request.channelSuggestionsRequireSubscription,
                  }
                : {}),
              ...(request.channelSuggestionsDeleteOnUnsubscribe !== undefined
                ? {
                    channelSuggestionsDeleteOnUnsubscribe:
                      request.channelSuggestionsDeleteOnUnsubscribe,
                  }
                : {}),
              ...(request.channelCommentsEnabled !== undefined
                ? { channelCommentsEnabled: request.channelCommentsEnabled }
                : {}),
              ...(request.autoRepliesEnabled !== undefined
                ? { autoRepliesEnabled: request.autoRepliesEnabled }
                : {}),
              updatedByUserId: user.userId,
            },
          });
        } else {
          const changed = await tx.publisherEntitySettings.updateMany({
            where: { chatId: entityId, revision: request.expectedRevision },
            data: {
              ...(request.chatComments
                ? {
                    chatCommentsEnabled: request.chatComments.commentsEnabled,
                    chatCommentsAdminsEnabled: request.chatComments.commentsAdminsEnabled,
                    chatCommentsPostsEnabled: request.chatComments.commentsChatBroadcastsEnabled,
                    chatCommentsReplaceOriginalEnabled:
                      request.chatComments.commentsReplaceOriginalEnabled,
                  }
                : {}),
              ...(request.channelSuggestionsEnabled !== undefined
                ? { channelSuggestionsEnabled: request.channelSuggestionsEnabled }
                : {}),
              ...(request.channelSuggestionsRequireSubscription !== undefined
                ? {
                    channelSuggestionsRequireSubscription:
                      request.channelSuggestionsRequireSubscription,
                  }
                : {}),
              ...(request.channelSuggestionsDeleteOnUnsubscribe !== undefined
                ? {
                    channelSuggestionsDeleteOnUnsubscribe:
                      request.channelSuggestionsDeleteOnUnsubscribe,
                  }
                : {}),
              ...(request.channelCommentsEnabled !== undefined
                ? { channelCommentsEnabled: request.channelCommentsEnabled }
                : {}),
              ...(request.autoRepliesEnabled !== undefined
                ? { autoRepliesEnabled: request.autoRepliesEnabled }
                : {}),
              revision: { increment: 1 },
              updatedByUserId: user.userId,
            },
          });
          if (changed.count !== 1) {
            throw this.policyConflict();
          }
          updated = await tx.publisherEntitySettings.findUniqueOrThrow({
            where: { chatId: entityId },
          });
        }
        await tx.auditLog.create({
          data: {
            chatId: entityId,
            actorUserId: user.userId,
            action: 'UPDATE_PUBLISHER_MODULE_SETTINGS',
            payload: {
              changed: {
                ...(request.channelSuggestionsEnabled !== undefined
                  ? { channelSuggestionsEnabled: request.channelSuggestionsEnabled }
                  : {}),
                ...(request.channelSuggestionsRequireSubscription !== undefined
                  ? {
                      channelSuggestionsRequireSubscription:
                        request.channelSuggestionsRequireSubscription,
                    }
                  : {}),
                ...(request.channelSuggestionsDeleteOnUnsubscribe !== undefined
                  ? {
                      channelSuggestionsDeleteOnUnsubscribe:
                        request.channelSuggestionsDeleteOnUnsubscribe,
                    }
                  : {}),
                ...(request.channelCommentsEnabled !== undefined
                  ? { channelCommentsEnabled: request.channelCommentsEnabled }
                  : {}),
                ...(request.chatComments ? { chatComments: request.chatComments } : {}),
                ...(request.autoRepliesEnabled !== undefined
                  ? { autoRepliesEnabled: request.autoRepliesEnabled }
                  : {}),
              },
              revision: updated.revision,
            } satisfies Prisma.InputJsonValue,
          },
        });
        return updated;
      });
      return this.presentModuleSettings(expectedEntityType, settings);
    } catch (error: unknown) {
      if ((error as { code?: unknown })?.code === 'P2002') {
        throw this.policyConflict();
      }
      throw error;
    }
  }

  private presentModuleSettings(
    entityType: ChatEntityType,
    settings: {
      revision: number;
      chatCommentsEnabled: boolean;
      chatCommentsAdminsEnabled: boolean;
      chatCommentsPostsEnabled: boolean;
      chatCommentsReplaceOriginalEnabled?: boolean;
      channelCommentsEnabled: boolean;
      channelSuggestionsEnabled: boolean;
      channelSuggestionsRequireSubscription?: boolean;
      channelSuggestionsDeleteOnUnsubscribe?: boolean;
      autoRepliesEnabled: boolean;
    } | null,
  ): PublisherEntityModuleSettings {
    return {
      revision: settings?.revision ?? 0,
      chatComments:
        entityType === ChatEntityType.CHAT
          ? {
              commentsEnabled: settings?.chatCommentsEnabled ?? false,
              commentsAdminsEnabled: settings?.chatCommentsAdminsEnabled ?? false,
              commentsChatBroadcastsEnabled: settings?.chatCommentsPostsEnabled ?? false,
              commentsReplaceOriginalEnabled: settings?.chatCommentsReplaceOriginalEnabled ?? false,
            }
          : null,
      autoRepliesEnabled:
        entityType === ChatEntityType.CHAT ? (settings?.autoRepliesEnabled ?? false) : null,
      channelCommentsEnabled:
        entityType === ChatEntityType.CHANNEL ? (settings?.channelCommentsEnabled ?? false) : null,
      channelSuggestionsEnabled:
        entityType === ChatEntityType.CHANNEL
          ? (settings?.channelSuggestionsEnabled ?? false)
          : null,
      channelSuggestionsRequireSubscription:
        entityType === ChatEntityType.CHANNEL
          ? (settings?.channelSuggestionsRequireSubscription ?? false)
          : null,
      channelSuggestionsDeleteOnUnsubscribe:
        entityType === ChatEntityType.CHANNEL
          ? (settings?.channelSuggestionsDeleteOnUnsubscribe ?? false)
          : null,
    };
  }

  private presentEntity(
    source: {
      id: string;
      entityType: ChatEntityType;
      publisherSettings: {
        revision: number;
        chatCommentsEnabled: boolean;
        chatCommentsAdminsEnabled: boolean;
        chatCommentsPostsEnabled: boolean;
        channelCommentsEnabled: boolean;
        channelSuggestionsEnabled: boolean;
        autoRepliesEnabled: boolean;
      } | null;
      channelSettings: {
        postSignatureEnabled: boolean;
        postSignaturePresentation: ChannelPostSignaturePresentation;
        postSignatureText: string;
        postSignatureUrl: string;
        customPostButtonsEnabled: boolean;
        customPostButtons: unknown;
      } | null;
      publicationPolicy: Parameters<PublisherReadinessService['resolvePolicy']>[0];
      publisherBinding: Parameters<
        PublisherReadinessService['resolveReadiness']
      >[0]['publisherBinding'];
    },
    snapshot: { now: Date; runtimeAvailable: boolean },
    catalogPresentation: PublisherCatalogPresentation,
  ): PublisherEntity {
    const effectiveEntityType = catalogPresentation.entityType;
    const entityType = effectiveEntityType === ChatEntityType.CHANNEL ? 'channel' : 'chat';
    return publisherEntitySchema.parse({
      id: source.id,
      title: catalogPresentation.title || source.id,
      entityType,
      avatarUrl: catalogPresentation.avatarUrl,
      entityUrl: catalogPresentation.entityUrl,
      policy: this.readinessService.resolvePolicy(source.publicationPolicy),
      channelPostSignature:
        effectiveEntityType === ChatEntityType.CHANNEL
          ? {
              enabled: source.channelSettings?.postSignatureEnabled ?? false,
              presentation:
                source.channelSettings?.postSignaturePresentation ===
                ChannelPostSignaturePresentation.BUTTON
                  ? 'button'
                  : 'signature',
              text:
                source.channelSettings?.postSignatureText ?? CHANNEL_POST_SIGNATURE_DEFAULT_TEXT,
              url: source.channelSettings?.postSignatureUrl ?? '',
              customButtonsEnabled: source.channelSettings?.customPostButtonsEnabled ?? false,
              customButtons: source.channelSettings?.customPostButtons ?? [],
            }
          : null,
      moduleSettings: this.presentModuleSettings(effectiveEntityType, source.publisherSettings),
      readiness: this.readinessService.resolveReadiness(
        { ...source, entityType: effectiveEntityType },
        snapshot,
      ),
    });
  }

  private async loadCatalogPresentations(
    edges: readonly {
      chatId: string;
      entityType: ChatEntityType;
    }[],
    publisherBotId: string,
  ): Promise<Map<string, PublisherCatalogPresentation>> {
    const presentations = new Map<string, PublisherCatalogPresentation>();
    for (let offset = 0; offset < edges.length; offset += PUBLISHER_CATALOG_LOOKUP_BATCH_SIZE) {
      const batch = edges.slice(offset, offset + PUBLISHER_CATALOG_LOOKUP_BATCH_SIZE);
      const rows = await this.prisma.managedBotChatCatalog.findMany({
        where: {
          status: 'ACTIVE',
          OR: batch.map((edge) => ({
            botId: publisherBotId,
            chatId: edge.chatId,
            entityType: edge.entityType,
          })),
        },
        select: {
          botId: true,
          chatId: true,
          entityType: true,
          title: true,
          link: true,
          avatarUrl: true,
        },
      });
      for (const row of rows) {
        presentations.set(this.catalogKey(row.botId, row.chatId), {
          title: row.title?.trim() ?? '',
          entityType: row.entityType,
          avatarUrl: this.normalizeHttpPresentationUrl(row.avatarUrl),
          entityUrl: this.normalizeMaxEntityUrl(row.link),
        });
      }
    }
    return presentations;
  }

  private async loadTargetedCatalogPresentation(
    edge: {
      chatId: string;
      entityType: ChatEntityType;
    },
    publisherBotId: string,
  ): Promise<PublisherCatalogPresentation | undefined> {
    const row = await this.prisma.managedBotChatCatalog.findFirst({
      where: {
        botId: publisherBotId,
        chatId: edge.chatId,
        entityType: edge.entityType,
        status: 'ACTIVE',
      },
      select: {
        entityType: true,
        title: true,
        link: true,
        avatarUrl: true,
      },
    });
    return row
      ? {
          title: row.title?.trim() ?? '',
          entityType: row.entityType,
          avatarUrl: this.normalizeHttpPresentationUrl(row.avatarUrl),
          entityUrl: this.normalizeMaxEntityUrl(row.link),
        }
      : undefined;
  }

  private normalizeMaxEntityUrl(value: string | null): string | null {
    const parsed = this.parsePresentationUrl(value);
    if (
      !parsed ||
      parsed.protocol !== 'https:' ||
      (parsed.hostname !== 'max.ru' && parsed.hostname !== 'www.max.ru') ||
      parsed.port.length > 0 ||
      parsed.hash.length > 0 ||
      parsed.pathname === '/'
    ) {
      return null;
    }
    parsed.hostname = 'max.ru';
    return parsed.toString();
  }

  private normalizeHttpPresentationUrl(value: string | null): string | null {
    const parsed = this.parsePresentationUrl(value);
    if (!parsed || (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')) {
      return null;
    }
    return parsed.toString();
  }

  private parsePresentationUrl(value: string | null): URL | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (
      normalized.length === 0 ||
      normalized.length > MAX_PRESENTATION_URL_LENGTH ||
      [...normalized].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return (
          /\s/u.test(character) || codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
        );
      })
    ) {
      return null;
    }
    try {
      const parsed = new URL(normalized);
      return parsed.username.length === 0 && parsed.password.length === 0 ? parsed : null;
    } catch {
      return null;
    }
  }

  private catalogKey(botId: string, chatId: string): string {
    return JSON.stringify([botId, chatId]);
  }

  private async listEntitiesPage(
    user: AuthUser,
    query: PublisherEntitiesCursorQuery,
  ): Promise<PublisherEntitiesResponse> {
    if (!this.catalogQuery) throw new ServiceUnavailableException('Каталог временно недоступен.');
    const page = await this.catalogQuery.page(
      user.userId,
      this.botRegistry.getPublisherBotDescriptor().id,
      query,
      await this.readinessService.isRuntimeAvailable(),
      user.accessCheckedAfter,
    );
    const entities = page.ids.length
      ? await this.loadScopedEntities(user, page.ids, true, true)
      : [];
    const byId = new Map(entities.map((entity) => [entity.id, entity]));
    return publisherEntitiesCursorResponseSchema.parse({
      items: page.ids.flatMap((id) => {
        const entity = byId.get(id);
        if (
          !entity ||
          (query.readiness && (query.readiness === 'ready') !== entity.readiness.canPublish)
        )
          return [];
        return [entity];
      }),
      nextCursor: page.nextCursor,
      filteredTotal: page.filteredTotal,
      summary: page.summary,
      accessVerificationPending: false,
    });
  }

  private compareEntities(left: PublisherEntity, right: PublisherEntity): number {
    return (
      left.entityType.localeCompare(right.entityType) ||
      left.title.localeCompare(right.title) ||
      left.id.localeCompare(right.id)
    );
  }

  private readPaginationMode(query: unknown): unknown {
    if (!query || typeof query !== 'object' || Array.isArray(query)) {
      return undefined;
    }
    return (query as Record<string, unknown>).pagination;
  }

  private policyConflict(): ConflictException {
    return new ConflictException({
      message: 'Publication policy changed. Refresh and retry.',
      code: 'PUBLISHER_POLICY_REVISION_CONFLICT',
    });
  }

  private resolveModuleEnablementFeatureKeys(
    request: {
      chatComments?: {
        commentsEnabled: boolean;
        commentsAdminsEnabled: boolean;
        commentsChatBroadcastsEnabled: boolean;
        commentsReplaceOriginalEnabled?: boolean;
      };
      channelCommentsEnabled?: boolean;
      channelSuggestionsEnabled?: boolean;
      autoRepliesEnabled?: boolean;
    },
    current: {
      chatCommentsEnabled: boolean;
      chatCommentsAdminsEnabled: boolean;
      chatCommentsPostsEnabled: boolean;
      chatCommentsReplaceOriginalEnabled?: boolean;
      channelCommentsEnabled: boolean;
      channelSuggestionsEnabled: boolean;
      autoRepliesEnabled: boolean;
    } | null,
  ): string[] {
    const featureKeys: string[] = [];
    const effectiveChatCommentsEnabled =
      request.chatComments?.commentsEnabled ?? current?.chatCommentsEnabled ?? false;
    if (request.chatComments?.commentsEnabled && current?.chatCommentsEnabled !== true) {
      featureKeys.push('chatComments.commentsEnabled');
    }
    if (
      effectiveChatCommentsEnabled &&
      request.chatComments?.commentsAdminsEnabled &&
      current?.chatCommentsAdminsEnabled !== true
    ) {
      featureKeys.push('chatComments.commentsAdminsEnabled');
    }
    if (
      effectiveChatCommentsEnabled &&
      request.chatComments?.commentsChatBroadcastsEnabled &&
      current?.chatCommentsPostsEnabled !== true
    ) {
      featureKeys.push('chatComments.commentsChatBroadcastsEnabled');
    }
    if (request.autoRepliesEnabled && current?.autoRepliesEnabled !== true) {
      featureKeys.push('autoRepliesEnabled');
    }
    if (
      effectiveChatCommentsEnabled &&
      request.chatComments?.commentsReplaceOriginalEnabled &&
      current?.chatCommentsReplaceOriginalEnabled !== true
    ) {
      featureKeys.push('chatComments.commentsReplaceOriginalEnabled');
    }
    if (request.channelSuggestionsEnabled && current?.channelSuggestionsEnabled !== true) {
      featureKeys.push('channelSuggestionsEnabled');
    }
    if (request.channelCommentsEnabled && current?.channelCommentsEnabled !== true) {
      featureKeys.push('channelCommentsEnabled');
    }
    return featureKeys;
  }

  private async assertPublisherBotCapabilityForEnablement(
    source: Parameters<PublisherReadinessService['resolveReadiness']>[0],
    featureKeys: readonly string[],
    options: { canRecheck: boolean; enqueuePolicyEnablementRecheck?: boolean },
  ): Promise<void> {
    let runtimeAvailable: boolean;
    try {
      runtimeAvailable = await this.readinessService.isRuntimeAvailable();
    } catch {
      throw this.publisherCapabilityCheckUnavailable(
        featureKeys,
        source.publisherBinding?.botAccessCheckedAt?.toISOString() ?? null,
        'publisher_runtime_unavailable',
        options.canRecheck,
      );
    }
    const readiness = this.readinessService.resolveReadiness(source, {
      runtimeAvailable,
      assumePolicyEnabled: true,
    });
    if (readiness.canPublish) {
      return;
    }

    if (
      readiness.blockerCode === 'publisher_runtime_unavailable' ||
      readiness.blockerCode === 'route_quarantined'
    ) {
      throw this.publisherCapabilityCheckUnavailable(
        featureKeys,
        readiness.checkedAt,
        readiness.blockerCode,
        options.canRecheck,
      );
    }

    let canRecheck = options.canRecheck;
    const publisherBotId = this.botRegistry.getPublisherBotDescriptor().id;
    if (
      options.enqueuePolicyEnablementRecheck === true &&
      hasPublisherRefreshEvidence(source.publisherBinding, publisherBotId)
    ) {
      try {
        await this.publisherBindingRefreshQueue.enqueue({
          chatId: source.id,
          publisherBotId,
          reason: 'policy_enablement_recheck',
        });
        canRecheck = true;
      } catch {
        this.logger.warn(
          { chatId: source.id },
          'Failed to enqueue Publisher policy enablement recheck',
        );
        throw this.publisherCapabilityCheckUnavailable(
          featureKeys,
          readiness.checkedAt,
          'publisher_recheck_unavailable',
          false,
        );
      }
    }

    const missingPermissions: BotCapabilityPermission[] =
      readiness.blockerCode === 'write_permission_missing'
        ? ['write']
        : readiness.blockerCode === 'bot_not_admin'
          ? ['administrator']
          : readiness.blockerCode === 'bot_not_connected'
            ? ['bot_connection']
            : [];
    throw new BotCapabilityRequiredException({
      missingPermissions,
      featureKeys,
      checkedAt: readiness.checkedAt,
      blockerCode: readiness.blockerCode ?? 'bot_access_unconfirmed',
      stale:
        readiness.blockerCode === 'bot_access_expired' ||
        readiness.blockerCode === 'bot_access_unconfirmed',
      canRecheck,
    });
  }

  private publisherCapabilityCheckUnavailable(
    featureKeys: readonly string[],
    checkedAt: string | null,
    blockerCode:
      | 'publisher_runtime_unavailable'
      | 'publisher_recheck_unavailable'
      | 'route_quarantined',
    canRecheck: boolean,
  ): ServiceUnavailableException {
    return new ServiceUnavailableException({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      error: 'Service Unavailable',
      message: 'Не удалось проверить готовность бота Публика. Повторите попытку позже.',
      code: 'BOT_CAPABILITY_CHECK_UNAVAILABLE',
      featureKeys: [...featureKeys],
      checkedAt,
      blockerCode,
      stale: true,
      canRecheck,
    });
  }
}
