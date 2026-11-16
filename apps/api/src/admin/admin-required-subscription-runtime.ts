import { mergeManagedBotChatCatalogRows } from './admin-managed-bot-catalog-values';
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  type Logger,
} from '@nestjs/common';
import { raceWithTimeout } from '../common/promise-timeout.util';
import { resolveExplicitMembershipAccessDenial } from '../max/max-membership-access-error';
import { readSavedRequiredSubscriptionHeaders } from './admin-required-subscription-metadata';
import {
  normalizeRequiredSubscriptionTargetLink,
  readRequiredSubscriptionTargetLink,
  rememberRequiredSubscriptionTargetLink,
} from '../common/required-subscription-target-link';
import { ManagedEntityActivationRequiredError } from '../max/managed-entity-activation.util';
import type { ChatSettings, ManagedEntityHeader, ManagedEntityType } from '@maxim/contracts';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { MaxBotLinkService } from '../max/max-bot-link.service';
import type { MaxBotRegistryService } from '../max/max-bot-registry.service';
import {
  MAX_API_SOURCE_TAGS,
  type MaxBotChat,
  type MaxClientService,
} from '../max/max-client.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  extractMaxErrorStatus,
  fromPrismaEntityType,
  isBotAdminLookupDeniedError,
  isMaxApiThrottleError,
  isMaxApiTimeoutError,
  mapWithConcurrencyLimit,
} from './admin-legacy-utils';
import type {
  AdminRequiredSubscriptionRuntimeContext,
  ResolveRequiredSubscriptionCandidateBotIdsOptions,
} from './admin-required-subscription-runtime-context';
import { resolveRequiredSubscriptionChannelByKnownLink } from './admin-required-subscription-catalog';
import {
  ADMIN_ACTION_HEALTH_LANE,
  REQUIRED_SUBSCRIPTION_CHANNEL_CHECK_CONCURRENCY,
  mapManagedEntityTypeToChatEntityType,
} from './admin.service.support';
import {
  createManagedEntityHeader,
  sanitizePublicManagedEntityHeader,
} from './admin-managed-entity-header';

type RequiredSubscriptionProbePersistenceResult =
  | { status: 'persisted' }
  | { status: 'stale' }
  | { status: 'unavailable'; error: unknown };

export class AdminRequiredSubscriptionRuntime {
  private readonly linkLookups = new Map<string, Promise<MaxBotChat>>();
  constructor(private readonly context: AdminRequiredSubscriptionRuntimeContext) {}

  private get prisma(): PrismaService {
    return this.context.prisma;
  }

  private get maxClient(): MaxClientService {
    return this.context.maxClient;
  }

  private get chatContextCache(): ChatContextCacheService {
    return this.context.chatContextCache;
  }

  private get logger(): Logger {
    return this.context.logger;
  }

  private get maxBotLinkService(): MaxBotLinkService | undefined {
    return this.context.maxBotLinkService;
  }

  private get maxBotRegistry(): MaxBotRegistryService | undefined {
    return this.context.maxBotRegistry;
  }

  private resolveBotAssignment(chatId: string): Promise<string | undefined> {
    return this.context.resolveBotAssignment(chatId);
  }

  private resolveCandidateBotIdsForChat(
    chatId: string,
    options?: ResolveRequiredSubscriptionCandidateBotIdsOptions,
  ): Promise<string[]> {
    return this.context.resolveCandidateBotIdsForChat(chatId, options);
  }

  private refreshManagedEntityBotAccessSnapshots(
    chatId: string,
    entityType: ManagedEntityType,
    reason: string,
  ): Promise<void> {
    return this.context.refreshManagedEntityBotAccessSnapshots(chatId, entityType, reason);
  }

  async resolveRequiredSubscriptionChannelHeaders(
    channelIds: readonly string[],
  ): Promise<ManagedEntityHeader[]> {
    const normalizedChannelIds = Array.from(
      new Set(
        channelIds
          .map((value) => value.trim())
          .filter((value): value is string => value.length > 0),
      ),
    );
    return readSavedRequiredSubscriptionHeaders(
      normalizedChannelIds,
      this.prisma,
      this.chatContextCache,
    );
  }

  async resolveRequiredSubscriptionChannelReference(value: string): Promise<ManagedEntityHeader> {
    const observedAt = new Date();
    const normalizedValue = value.trim();
    if (!normalizedValue) {
      throw new BadRequestException(
        'Укажите публичную ссылку, ссылку на чат/пост MAX или ID чата/канала.',
      );
    }

    const extractedChatId = this.extractRequiredSubscriptionChannelIdFromValue(normalizedValue);
    if (extractedChatId) {
      return this.resolveRequiredSubscriptionChannelById(extractedChatId);
    }

    const normalizedLink = this.normalizeRequiredSubscriptionChannelLink(normalizedValue);
    if (normalizedLink) {
      const channel = await this.resolveRequiredSubscriptionChannelByLink(normalizedLink);
      return this.resolveRequiredSubscriptionChannelById(channel.chatId, {
        preferredBotId: channel.botId ?? null,
        observedBotIds: channel.botIds ?? [],
        verifiedLink: channel.link,
        observedAt,
      });
    }

    return this.resolveRequiredSubscriptionChannelById(normalizedValue);
  }

  buildRequiredSubscriptionChannelUrlCandidates(value: string | null | undefined): string[] {
    if (typeof value !== 'string') {
      return [];
    }

    const trimmed = value.trim();
    if (!trimmed) {
      return [];
    }

    const candidates = [trimmed];
    if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) {
      if (trimmed.startsWith('/')) {
        candidates.unshift(`https://max.ru${trimmed}`);
      } else if (trimmed.startsWith('max.ru/') || trimmed.startsWith('www.max.ru/')) {
        candidates.unshift(`https://${trimmed}`);
      } else if (trimmed.includes('/') && !/\s/u.test(trimmed)) {
        candidates.unshift(`https://max.ru/${trimmed.replace(/^\/+/u, '')}`);
      }
    }

    return Array.from(new Set(candidates));
  }

  extractRequiredSubscriptionChannelIdFromValue(value: string | null | undefined): string | null {
    for (const candidate of this.buildRequiredSubscriptionChannelUrlCandidates(value)) {
      try {
        const parsed = new URL(candidate);
        const hostname = parsed.hostname.trim().toLowerCase();
        if (hostname !== 'max.ru' && hostname !== 'www.max.ru') {
          continue;
        }

        const pathSegments = parsed.pathname
          .split('/')
          .map((segment) => segment.trim())
          .filter(Boolean);
        const rootSegment = pathSegments[0]?.toLowerCase();
        if (rootSegment !== 'chats' && rootSegment !== 'c' && rootSegment !== 'chat') {
          continue;
        }

        const chatId = decodeURIComponent(pathSegments[1] ?? '').trim();
        if (chatId) {
          return chatId;
        }
      } catch {
        // Ignore invalid candidate and try the next one.
      }
    }

    return null;
  }

  async resolveRequiredSubscriptionChannelByLink(link: string): Promise<MaxBotChat> {
    const normalizedLink = this.normalizeRequiredSubscriptionChannelLink(link);
    if (!normalizedLink) {
      throw new BadRequestException('Укажите корректную ссылку чата или канала MAX.');
    }

    let lookup = this.linkLookups.get(normalizedLink);
    if (!lookup) {
      if (this.linkLookups.size >= 128)
        throw new ServiceUnavailableException('Проверка источников занята. Повторите попытку.');
      lookup = this.lookupRequiredSubscriptionChannelByLink(normalizedLink, Date.now() + 12_000);
      this.linkLookups.set(normalizedLink, lookup);
      void lookup.finally(() => this.linkLookups.delete(normalizedLink)).catch(() => undefined);
    }
    // Retain single-flight ownership until the actual read ends, even after the caller's deadline.
    return raceWithTimeout({
      operation: lookup,
      timeoutMs: 12_000,
      onTimeout: () => {
        throw new ServiceUnavailableException('MAX не успел проверить ссылку. Повторите попытку.');
      },
    });
  }

  private async lookupRequiredSubscriptionChannelByLink(
    normalizedLink: string,
    deadline: number,
  ): Promise<MaxBotChat> {
    let locallyKnownChannel: MaxBotChat | null = null;
    try {
      locallyKnownChannel = await resolveRequiredSubscriptionChannelByKnownLink({
        normalizedLink,
        catalog: this.prisma.managedBotChatCatalog,
        normalizeLink: (value) => this.normalizeRequiredSubscriptionChannelLink(value),
        mergeCatalogRows: (rows) =>
          mergeManagedBotChatCatalogRows(rows, (botId) =>
            this.context.normalizeRuntimeManagedEntityBotId(botId),
          ),
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          link: normalizedLink,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to resolve required subscription entity by local catalog link',
      );
      throw new ServiceUnavailableException(
        'Не удалось проверить сохраненную ссылку чата или канала. Повторите попытку.',
      );
    }

    if (locallyKnownChannel) {
      return locallyKnownChannel;
    }

    const channelLink = this.extractRequiredSubscriptionPublicChannelLink(normalizedLink);
    if (channelLink && typeof this.maxClient.getChannelSnapshotByLink === 'function') {
      const candidates = this.maxBotRegistry?.getDiscoveryBots().map((bot) => bot.id) ?? [
        undefined,
      ];
      let unavailable = false;
      for (const botId of candidates.slice(0, 6)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          unavailable = true;
          break;
        }
        try {
          const snapshot = await this.maxClient.getChannelSnapshotByLink(channelLink, {
            ...(botId ? { botId } : {}),
            timeoutMs: Math.min(2_000, remaining),
            trafficClass: 'interactive',
            actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
            sourceTag: MAX_API_SOURCE_TAGS.REQUIRED_SUBSCRIPTION_METADATA,
          });
          return {
            chatId: snapshot.chatId,
            title: snapshot.title,
            entityType: snapshot.entityType,
            link: snapshot.link ?? normalizedLink,
            avatarUrl: snapshot.avatarUrl,
            lastEventTime: snapshot.lastEventAt ? Date.parse(snapshot.lastEventAt) : null,
            ...(botId ? { botId, botIds: [botId] } : {}),
          };
        } catch (error: unknown) {
          if (isBotAdminLookupDeniedError(error)) continue;
          unavailable = true;
          this.logger.warn(
            {
              link: normalizedLink,
              channelLink,
              err: error instanceof Error ? error.message : String(error),
            },
            'Failed to resolve required subscription channel by targeted public link lookup',
          );
        }
      }
      if (unavailable || candidates.length === 0)
        throw new ServiceUnavailableException(
          'Не удалось проверить публичную ссылку канала MAX. Повторите попытку.',
        );
    }

    throw new BadRequestException(
      'Чат или канал по этой ссылке не найден. Проверьте ссылку и убедитесь, что бот состоит там администратором.',
    );
  }

  extractRequiredSubscriptionPublicChannelLink(normalizedLink: string): string | null {
    try {
      const parsed = new URL(normalizedLink);
      const hostname = parsed.hostname.trim().toLowerCase();
      if (hostname !== 'max.ru' && hostname !== 'www.max.ru') {
        return null;
      }

      const pathSegments = parsed.pathname
        .split('/')
        .map((segment) => segment.trim())
        .filter(Boolean);
      if (pathSegments.length !== 1) {
        return null;
      }

      const slug = pathSegments[0];
      const reservedSegments = new Set(['chat', 'chats', 'c', 'join']);
      if (reservedSegments.has(slug.toLowerCase())) {
        return null;
      }

      return slug;
    } catch {
      return null;
    }
  }

  async resolveRequiredSubscriptionChannelById(
    chatId: string,
    options: {
      preferredBotId?: string | null;
      observedBotIds?: readonly string[] | null;
      verifiedLink?: string | null;
      observedAt?: Date;
    } = {},
  ): Promise<ManagedEntityHeader> {
    const observedAt = options.observedAt ?? new Date();
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      throw new BadRequestException('Укажите корректный ID чата или канала.');
    }

    const resolvedBotId =
      this.maxBotRegistry?.getBotById(options.preferredBotId)?.id ??
      (await this.resolveBotAssignment(normalizedChatId)) ??
      null;
    const verifiedBotId =
      (await this.assertBotCanInspectRequiredSubscriptionChannel(normalizedChatId, {
        preferredBotId: resolvedBotId,
        observedBotIds: options.observedBotIds ?? [],
      })) ?? resolvedBotId;
    let snapshot;
    try {
      snapshot = verifiedBotId
        ? await this.maxClient.getChatSnapshot(normalizedChatId, {
            botId: verifiedBotId,
            actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
            sourceTag: MAX_API_SOURCE_TAGS.REQUIRED_SUBSCRIPTION_METADATA,
          })
        : await this.maxClient.getChatSnapshot(normalizedChatId, {
            actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
            sourceTag: MAX_API_SOURCE_TAGS.REQUIRED_SUBSCRIPTION_METADATA,
          });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: normalizedChatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to load required subscription entity snapshot',
      );
      if (this.isTransientRequiredSubscriptionMaxError(error)) {
        throw new ServiceUnavailableException(
          'Не удалось загрузить данные чата или канала MAX. Повторите позже.',
        );
      }
      throw new BadRequestException(
        'Чат или канал не найден в MAX или бот не имеет к нему доступа.',
      );
    }

    const observedLink =
      normalizeRequiredSubscriptionTargetLink(snapshot.link) ??
      normalizeRequiredSubscriptionTargetLink(options.verifiedLink);
    const cachedHeader = observedLink
      ? null
      : await this.chatContextCache.getManagedEntityHeader?.(normalizedChatId, snapshot.entityType);
    const link = await readRequiredSubscriptionTargetLink(
      this.prisma,
      normalizedChatId,
      observedLink ?? cachedHeader?.link,
    );
    const entityType = snapshot.entityType;
    const prismaEntityType = mapManagedEntityTypeToChatEntityType(entityType);

    const header = createManagedEntityHeader({
      id: normalizedChatId,
      title: snapshot.title?.trim() || normalizedChatId,
      entityType,
      link,
      participantsCount: snapshot.participantsCount,
      avatarUrl: snapshot.avatarUrl,
      primaryBotId: verifiedBotId,
    });

    try {
      await this.prisma.chat.upsert({
        where: { id: normalizedChatId },
        create: {
          id: normalizedChatId,
          title: header.title,
          entityType: prismaEntityType,
        },
        update: {
          title: header.title,
          entityType: prismaEntityType,
        },
      });
      await this.maxBotLinkService?.bindDiscoveredChatBots?.({
        chatId: normalizedChatId,
        primaryBotId: verifiedBotId,
        botIds:
          verifiedBotId || (options.observedBotIds?.length ?? 0) > 0
            ? [verifiedBotId, ...(options.observedBotIds ?? [])].filter(
                (botId): botId is string => typeof botId === 'string' && botId.trim().length > 0,
              )
            : [],
        title: header.title,
        entityType: prismaEntityType,
      });
      if (observedLink && verifiedBotId) {
        await rememberRequiredSubscriptionTargetLink(this.prisma, {
          chatId: normalizedChatId,
          botId: verifiedBotId,
          entityType: prismaEntityType,
          link: observedLink,
          observedAt,
        });
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: normalizedChatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to persist resolved required subscription entity title',
      );
    }

    await this.chatContextCache.setManagedEntityHeader?.(header);
    return sanitizePublicManagedEntityHeader(header);
  }

  async assertBotCanInspectRequiredSubscriptionChannel(
    chatId: string,
    options: {
      preferredBotId?: string | null;
      observedBotIds?: readonly string[] | null;
    } = {},
  ): Promise<string | null> {
    const candidateBotIds = Array.from(
      new Set(
        [
          this.maxBotRegistry?.getBotById(options.preferredBotId)?.id ?? null,
          ...((options.observedBotIds ?? []).map(
            (botId) => this.maxBotRegistry?.getBotById(botId)?.id ?? null,
          ) as Array<string | null>),
          ...(await this.resolveCandidateBotIdsForChat(chatId, {
            includeDiscoveryFallback: true,
          })),
        ].filter((botId): botId is string => Boolean(botId)),
      ),
    );

    let probeParentEnsured = false;
    if (candidateBotIds.length > 0) {
      try {
        // FLAG: A missing parent cannot retain negative epochs from concurrent probes.
        // Snapshot existence before the first remote lookup so concurrent inserts still re-probe.
        probeParentEnsured = Boolean(
          await this.prisma.chat.findUnique({
            where: { id: chatId },
            select: { id: true },
          }),
        );
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to inspect required subscription entity before access verification',
        );
        throw new ServiceUnavailableException(
          'Не удалось проверить права бота в чате или канале MAX. Повторите попытку.',
        );
      }
    }

    let serviceFailure: unknown = null;
    let activationRequired = false;
    for (const botId of candidateBotIds) {
      let probeStartedAt = new Date();
      let access: Awaited<ReturnType<MaxClientService['getCurrentChatMemberAccess']>>;
      try {
        access = await this.probeRequiredSubscriptionBotAccess(chatId, botId);
      } catch (error: unknown) {
        if (error instanceof ManagedEntityActivationRequiredError) {
          activationRequired = true;
          continue;
        }
        const terminalErrorCode = this.resolveTerminalBotAccessErrorCode(error);
        if (terminalErrorCode) {
          const persistence = await this.persistRequiredSubscriptionBotAccessProbe({
            chatId,
            botId,
            access: null,
            checkedAt: probeStartedAt,
            lastErrorCode: terminalErrorCode,
          });
          if (persistence.status === 'unavailable') {
            serviceFailure = serviceFailure ?? persistence.error;
          }
          continue;
        }
        serviceFailure = serviceFailure ?? error;
        continue;
      }

      let hasRequiredAccess = access.isAdmin || access.isOwner;
      let allowMembershipRecovery = hasRequiredAccess;
      if (hasRequiredAccess && !probeParentEnsured) {
        try {
          // FLAG: recordBotAccessProbe serializes on the parent Chat and rejects missing rows.
          // Materialize only after MAX proves access, without preselecting a primary bot.
          await this.prisma.chat.createMany({
            data: {
              id: chatId,
              title: chatId,
            },
            skipDuplicates: true,
          });
          probeParentEnsured = true;
        } catch (error: unknown) {
          serviceFailure = serviceFailure ?? error;
          this.logger.warn(
            {
              chatId,
              botId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Failed to materialize required subscription entity before access probe persistence',
          );
          continue;
        }

        probeStartedAt = new Date();
        try {
          access = await this.probeRequiredSubscriptionBotAccess(chatId, botId);
        } catch (error: unknown) {
          const terminalErrorCode = this.resolveTerminalBotAccessErrorCode(error);
          if (terminalErrorCode) {
            const persistence = await this.persistRequiredSubscriptionBotAccessProbe({
              chatId,
              botId,
              access: null,
              checkedAt: probeStartedAt,
              lastErrorCode: terminalErrorCode,
            });
            if (persistence.status === 'unavailable') {
              serviceFailure = serviceFailure ?? persistence.error;
            }
            continue;
          }
          serviceFailure = serviceFailure ?? error;
          continue;
        }
        hasRequiredAccess = access.isAdmin || access.isOwner;
        allowMembershipRecovery = true;
      }
      const persistence = await this.persistRequiredSubscriptionBotAccessProbe({
        chatId,
        botId,
        access,
        checkedAt: probeStartedAt,
        allowMembershipRecovery,
      });
      if (persistence.status === 'unavailable') {
        serviceFailure = serviceFailure ?? persistence.error;
      }
      if (hasRequiredAccess && persistence.status === 'persisted') {
        return botId;
      }
      if (hasRequiredAccess && persistence.status === 'stale') {
        try {
          if (await this.maxBotLinkService?.isChatBotActivationRequired?.(chatId, botId)) {
            activationRequired = true;
          } else {
            serviceFailure ??= new Error('Required subscription access proof was superseded');
          }
        } catch (error) {
          serviceFailure ??= error;
        }
      }
    }

    if (candidateBotIds.length === 0) {
      serviceFailure = new Error(
        'No configured MAX bot candidate can verify required subscription',
      );
    }

    if (!serviceFailure) {
      if (activationRequired)
        throw new ConflictException({
          code: 'REQUIRED_SUBSCRIPTION_ACTIVATION_REQUIRED',
          chatId,
          message:
            'Нужно подтвердить подключение источника. Его администратору следует отправить «Старт» в группу или переслать сообщение из источника в личный диалог с ботом, которому выданы права.',
        });
      throw new BadRequestException(
        'Бот должен быть администратором этого чата или канала, чтобы проверять подписку.',
      );
    }

    this.logger.warn(
      {
        chatId,
        err: serviceFailure instanceof Error ? serviceFailure.message : String(serviceFailure),
      },
      'Failed to verify bot admin access for required subscription entity',
    );
    throw new ServiceUnavailableException(
      'Не удалось проверить права бота в чате или канале MAX. Повторите попытку.',
    );
  }

  private probeRequiredSubscriptionBotAccess(
    chatId: string,
    botId?: string,
  ): ReturnType<MaxClientService['getCurrentChatMemberAccess']> {
    return this.maxClient.getCurrentChatMemberAccess(chatId, {
      trafficClass: 'interactive',
      actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
      sourceTag: MAX_API_SOURCE_TAGS.REQUIRED_SUBSCRIPTION_METADATA,
      bypassCache: true,
      ...(botId ? { botId } : {}),
    });
  }

  private async persistRequiredSubscriptionBotAccessProbe(params: {
    chatId: string;
    botId: string;
    access: Awaited<ReturnType<MaxClientService['getCurrentChatMemberAccess']>> | null;
    checkedAt: Date;
    lastErrorCode?: string;
    allowMembershipRecovery?: boolean;
  }): Promise<RequiredSubscriptionProbePersistenceResult> {
    const recordBotAccessProbe = this.maxBotLinkService?.recordBotAccessProbe;
    if (typeof recordBotAccessProbe !== 'function') {
      return {
        status: 'unavailable',
        error: new Error('MaxBotLinkService.recordBotAccessProbe is unavailable'),
      };
    }

    try {
      const persisted = await recordBotAccessProbe.call(this.maxBotLinkService, {
        chatId: params.chatId,
        botId: params.botId,
        access: params.access,
        source: MAX_API_SOURCE_TAGS.REQUIRED_SUBSCRIPTION_METADATA,
        checkedAt: params.checkedAt,
        ...(params.lastErrorCode ? { lastErrorCode: params.lastErrorCode } : {}),
        allowMembershipRecovery: params.allowMembershipRecovery === true,
      });
      return { status: persisted ? 'persisted' : 'stale' };
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: params.chatId,
          botId: params.botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to persist required subscription bot access probe',
      );
      return { status: 'unavailable', error };
    }
  }

  private resolveTerminalBotAccessErrorCode(error: unknown): string | null {
    return resolveExplicitMembershipAccessDenial(error);
  }

  private isTransientRequiredSubscriptionMaxError(error: unknown): boolean {
    if (isMaxApiThrottleError(error) || isMaxApiTimeoutError(error)) {
      return true;
    }

    const status = extractMaxErrorStatus(error);
    if (status !== null && status >= 500) {
      return true;
    }

    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code !== 'string') {
      return false;
    }
    return new Set(['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT']).has(
      code.trim().toUpperCase(),
    );
  }

  normalizeRequiredSubscriptionChannelLink(value: string | null | undefined): string | null {
    for (const candidate of this.buildRequiredSubscriptionChannelUrlCandidates(value)) {
      try {
        const parsed = new URL(candidate);
        const hostname = parsed.hostname.trim().toLowerCase();
        if (hostname !== 'max.ru' && hostname !== 'www.max.ru') {
          continue;
        }

        let pathname = parsed.pathname.replace(/\/+$/u, '');
        if (!pathname) {
          continue;
        }

        const pathSegments = pathname
          .split('/')
          .map((segment) => segment.trim())
          .filter(Boolean);
        const rootSegment = pathSegments[0]?.toLowerCase();
        if ((rootSegment === 'channel' || rootSegment === 'channels') && pathSegments[1]) {
          pathname = `/${pathSegments[1]}`;
        } else if (
          pathSegments.length === 1 &&
          rootSegment !== 'chat' &&
          rootSegment !== 'chats' &&
          rootSegment !== 'c' &&
          rootSegment !== 'join'
        ) {
          pathname = `/${pathSegments[0]}`;
        }

        parsed.search = '';
        parsed.hash = '';

        return `https://max.ru${pathname}`;
      } catch {
        // Ignore invalid candidate and try the next one.
      }
    }

    return null;
  }

  async assertRequiredSubscriptionSettings(settings: ChatSettings): Promise<ChatSettings> {
    if (!settings.requiredSubscriptionEnabled) {
      return settings;
    }

    const selectedChannelIds = settings.requiredSubscriptionChannelIds;
    if (selectedChannelIds.length === 0) {
      return {
        ...settings,
        requiredSubscriptionEnabled: false,
        requiredSubscriptionChannelIds: [],
        requiredSubscriptionBotMessageEnabled: false,
      };
    }

    await mapWithConcurrencyLimit(
      selectedChannelIds,
      REQUIRED_SUBSCRIPTION_CHANNEL_CHECK_CONCURRENCY,
      async (channelId) => {
        await this.resolveRequiredSubscriptionChannelById(channelId);
      },
    );
    return settings;
  }

  async resolveRequiredSubscriptionEntityType(chatId: string): Promise<ManagedEntityType> {
    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return 'channel';
    }

    const cachedChannelHeader = await this.chatContextCache.getManagedEntityHeader?.(
      normalizedChatId,
      'channel',
    );
    if (cachedChannelHeader) {
      return 'channel';
    }

    const cachedChatHeader = await this.chatContextCache.getManagedEntityHeader?.(
      normalizedChatId,
      'chat',
    );
    if (cachedChatHeader) {
      return 'chat';
    }

    try {
      const resolved = await this.resolveRequiredSubscriptionChannelById(normalizedChatId);
      return resolved.entityType;
    } catch {
      const persisted = await this.prisma.chat.findUnique({
        where: { id: normalizedChatId },
        select: {
          entityType: true,
        },
      });
      if (persisted?.entityType) {
        return fromPrismaEntityType(persisted.entityType);
      }
    }

    return 'channel';
  }

  async refreshRequiredSubscriptionAccessSnapshots(
    entityIds: readonly string[],
    reason: string,
  ): Promise<void> {
    const normalizedEntityIds = Array.from(
      new Set(
        entityIds.map((entityId) => entityId.trim()).filter((entityId) => entityId.length > 0),
      ),
    );
    await mapWithConcurrencyLimit(
      normalizedEntityIds,
      REQUIRED_SUBSCRIPTION_CHANNEL_CHECK_CONCURRENCY,
      async (entityId) => {
        await this.refreshManagedEntityBotAccessSnapshots(
          entityId,
          await this.resolveRequiredSubscriptionEntityType(entityId),
          reason,
        );
      },
    );
  }
}
