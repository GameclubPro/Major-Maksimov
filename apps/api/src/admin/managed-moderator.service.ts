import { readFixedModeratorSettingsPurposes } from '../max/fixed-moderator-capabilities';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  assignManagedModeratorRequestSchema,
  managedEntityTypeSchema,
  type ManagedEntityType,
  type ManagedModeratorChoices,
  type ManagedModeratorAssignmentResult,
} from '@maxim/contracts';
import { z } from 'zod';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { MaxBotLinkService } from '../max/max-bot-link.service';
import { MaxClientService, MAX_API_SOURCE_TAGS } from '../max/max-client.service';
import {
  hasExplicitHumanAdministrator,
  isMajorManagedEntityActivationRequired,
} from '../max/managed-entity-activation.util';
import { executionRouteProof } from '../max/max-execution-route-proof';
import { publicModerator } from '../max/max-public-moderator';
import {
  MaxFixedModeratorAssignmentService,
  requiredFixedModeratorPurposes,
} from '../max/max-fixed-moderator-assignment.service';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import { isFixedModeratorSelectionEnabled } from '../max/fixed-moderator.config';

const entityIdSchema = z.string().trim().min(1).max(128);

@Injectable()
export class ManagedModeratorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: MaxBotRegistryService,
    private readonly links: MaxBotLinkService,
    private readonly max: MaxClientService,
    private readonly assignments: MaxFixedModeratorAssignmentService,
    private readonly config: ConfigService,
    private readonly cache: ChatContextCacheService,
  ) {}

  private enabled(chatId: string): boolean {
    return isFixedModeratorSelectionEnabled(this.config, chatId);
  }

  private async authorize(user: AuthUser, rawType: string, rawId: string, preferredBotId?: string) {
    const entityType = managedEntityTypeSchema.parse(rawType);
    const chatId = entityIdSchema.parse(rawId);
    const state = await this.links.loadChatExecutionOwnerState(chatId);
    if (!state || state.entityType !== (entityType === 'chat' ? 'CHAT' : 'CHANNEL'))
      throw new NotFoundException('Сообщество не найдено.');
    const candidates = [...state.candidates].sort(
      (a, b) =>
        Number(b.botId === (preferredBotId ?? state.primaryBotId)) -
        Number(a.botId === (preferredBotId ?? state.primaryBotId)),
    );
    // FLAG: A dead assigned bot cannot prevent its administrator from selecting a healthy
    // connected bot. Authorization remains an exact fresh human lookup, never a home edge.
    const deadline = Date.now() + 4500;
    for (const candidate of candidates.slice(0, 6)) {
      if (Date.now() >= deadline) break;
      if (preferredBotId && candidate.botId !== preferredBotId) continue;
      const checkedAt = new Date();
      try {
        const users = await this.max.getChatMembersAccess(chatId, [user.userId], {
          botId: candidate.botId,
          bypassCache: true,
          timeoutMs: Math.max(1, Math.min(1500, deadline - Date.now())),
          trafficClass: 'interactive',
          sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
        });
        if (!hasExplicitHumanAdministrator(users.get(user.userId), user.userId))
          throw new ForbiddenException('Выбор бота доступен администраторам сообщества.');
        return { state, chatId, entityType, actorProof: { userId: user.userId, checkedAt } };
      } catch (error) {
        if (error instanceof ForbiddenException) throw error;
        const status = (error as { response?: { status?: number } }).response?.status;
        const code = (error as { code?: string }).code;
        const unavailable =
          status === 401 ||
          status === 403 ||
          status === 404 ||
          status === 429 ||
          (typeof status === 'number' && status >= 500) ||
          code === 'ETIMEDOUT' ||
          code === 'ECONNABORTED' ||
          code === 'ECONNRESET';
        if (!unavailable) throw error;
      }
    }
    throw new ForbiddenException('Пока не удалось проверить ваши права. Попробуйте снова.');
  }

  async choices(
    user: AuthUser,
    entityType: string,
    chatId: string,
  ): Promise<ManagedModeratorChoices> {
    const { state } = await this.authorize(user, entityType, chatId);
    const legacy = { ...state, fixedModeratorBotId: null };
    const required = [
      ...requiredFixedModeratorPurposes(legacy),
      ...(await readFixedModeratorSettingsPurposes(
        this.prisma,
        chatId,
        state.entityType!,
        this.config.get<boolean>('COMMERCIAL_LLM_ENFORCEMENT_ENABLED') === true,
      )),
    ];
    const currentId = state.fixedModeratorBotId ?? state.primaryBotId;
    const current = currentId ? this.registry.getBotById(currentId) : null;
    return {
      revision: state.routingVersion,
      current: current ? publicModerator(current) : null,
      selectionEnabled: this.enabled(chatId),
      candidates: state.candidates.map((member) => {
        const bot = this.registry.getBotById(member.botId)!;
        const activation = isMajorManagedEntityActivationRequired(member, state.entityType);
        const capable = required.every((purpose) =>
          executionRouteProof(legacy, member.botId, purpose),
        );
        return {
          ...publicModerator(bot),
          selectable: !activation && capable,
          reason: activation
            ? ('needs_activation' as const)
            : capable
              ? null
              : ('needs_permissions' as const),
        };
      }),
    };
  }

  async assign(
    user: AuthUser,
    rawType: string,
    rawId: string,
    body: unknown,
  ): Promise<ManagedModeratorAssignmentResult> {
    const request = assignManagedModeratorRequestSchema.parse(body);
    const chatId = entityIdSchema.parse(rawId);
    if (!this.enabled(chatId)) throw new ForbiddenException('Выбор бота пока недоступен.');
    const bot = this.registry
      .getAllBots()
      .find((candidate) => publicModerator(candidate).key === request.moderatorKey);
    if (!bot) throw new NotFoundException('Бот не найден.');
    const authorized = await this.authorize(user, rawType, chatId, bot.id);
    const prior = await this.prisma.managedModeratorAssignment.findUnique({
      where: { id: request.operationId },
    });
    if (prior) {
      if (
        prior.chatId !== chatId ||
        prior.actorUserId !== user.userId ||
        prior.botId !== bot.id ||
        prior.expectedRoutingVersion !== request.expectedRevision
      )
        throw new ConflictException('Этот запрос уже использован. Откройте выбор бота заново.');
      return {
        operationId: prior.id,
        status: 'applied',
        revision: prior.routingVersion,
        moderator: publicModerator(bot),
      };
    }
    if (authorized.state.routingVersion !== request.expectedRevision)
      throw new ConflictException('Выбор бота уже изменился. Обновите список.');
    const checkedAt = new Date();
    const access = await this.max.getCurrentChatMemberAccess(chatId, {
      botId: bot.id,
      bypassCache: true,
      timeoutMs: 1500,
      trafficClass: 'interactive',
      sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
    });
    let channelReadVerified = false;
    if (authorized.entityType === 'channel') {
      const snapshot = await this.max.getChatSnapshot(chatId, {
        botId: bot.id,
        bypassCache: true,
        timeoutMs: 1500,
        trafficClass: 'interactive',
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
      });
      channelReadVerified = snapshot.chatId === chatId && snapshot.entityType === 'channel';
    }
    const accepted = await this.links.recordBotAccessProbe({
      chatId,
      botId: bot.id,
      access,
      checkedAt,
      source: 'moderator_selection',
      allowMembershipRecovery: false,
      channelReadVerified,
    });
    if (!accepted) throw new ConflictException('Права бота изменились. Обновите список.');
    const operation = await this.assignments.assign({
      operationId: request.operationId,
      chatId,
      botId: bot.id,
      entityType: authorized.entityType === 'chat' ? 'CHAT' : 'CHANNEL',
      expectedRoutingVersion: request.expectedRevision,
      expectedAccessEpoch: { checkedAt, source: 'moderator_selection' },
      actorProof: authorized.actorProof,
    });
    // SQL and the idempotent result are authoritative even if advisory cache work fails.
    this.links.forgetChatBotBinding(chatId);
    await Promise.allSettled([
      this.links.reconcileChatRoutingState({ chatId }),
      this.cache.invalidateManagedEntityHeader(chatId),
    ]);
    return {
      operationId: operation.id,
      status: 'applied',
      revision: operation.routingVersion,
      moderator: publicModerator(bot),
    };
  }

  async operation(
    user: AuthUser,
    entityType: ManagedEntityType | string,
    chatId: string,
    rawId: string,
  ) {
    const operationId = z.string().uuid().parse(rawId);
    await this.authorize(user, entityType, chatId);
    const result = await this.prisma.managedModeratorAssignment.findUnique({
      where: { id: operationId },
    });
    if (!result || result.chatId !== chatId || result.actorUserId !== user.userId)
      throw new NotFoundException('Смена бота ещё не подтверждена.');
    const bot = this.registry.getBotById(result.botId);
    if (!bot) throw new ConflictException('Список ботов изменился. Обновите страницу.');
    return {
      operationId: result.id,
      status: 'applied' as const,
      revision: result.routingVersion,
      moderator: publicModerator(bot),
    };
  }
}
