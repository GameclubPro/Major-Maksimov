import type { Logger } from '@nestjs/common';
import type { ChatSummary, ManagedEntitiesResponseDiff, ManagedEntityType } from '@maxim/contracts';

import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import type { MaxBotRegistryService } from '../max/max-bot-registry.service';
import type { MaxClientService } from '../max/max-client.service';
import type { PrismaService } from '../prisma/prisma.service';
import type {
  AssertChatAdminOptions,
  ManagedEntitiesListOptions,
  ManagedEntitiesListResult,
  ManagedEntitiesRefreshJobOutcome,
  ManagedEntityTypeFilter,
} from './admin.service.support';

export type ManagedEntitiesRefreshRunOptions = {
  bypassRemoteCache?: boolean;
  resetRefreshCursor?: boolean;
};

export type AdminManagedEntitiesRuntimeContext = {
  readonly prisma: PrismaService;
  readonly chatContextCache: ChatContextCacheService;
  readonly maxClient: MaxClientService;
  readonly logger: Logger;
  readonly maxBotRegistry?: MaxBotRegistryService;
  assertChatAdmin(
    chatId: string,
    userId: string,
    entityType?: ManagedEntityType | null,
    options?: AssertChatAdminOptions,
  ): Promise<void>;
  assertReadOnlyChatAdmin(
    chatId: string,
    userId: string,
    entityType?: ManagedEntityType | null,
    options?: {
      forceRemote?: boolean;
      timeoutMs?: number;
      protectHumanAdministrator?: boolean;
    },
  ): Promise<void>;
  attachManagedEntityFavoriteTypes(
    userId: string,
    items: readonly ChatSummary[],
  ): Promise<ChatSummary[]>;
  attachManagedEntityFavoriteTypesToDiff(
    userId: string,
    diff: ManagedEntitiesResponseDiff | null | undefined,
  ): Promise<ManagedEntitiesResponseDiff | null | undefined>;
  collectManagedEntitiesForMassAction(
    user: AuthUser,
    entityType: ManagedEntityType,
    options?: {
      discoveryMode?: 'full' | 'cached-first';
    },
  ): Promise<ChatSummary[]>;
  ensureEntityType(
    chatId: string,
    userId: string,
    expectedEntityType: ManagedEntityType,
  ): Promise<void>;
  isManagedEntityRuntimeBotId(botId: string | null | undefined): boolean;
  listManagedEntitiesDetailed(
    user: AuthUser,
    entityType?: ManagedEntityTypeFilter,
    options?: ManagedEntitiesListOptions,
  ): Promise<ManagedEntitiesListResult>;
  resolveBackgroundReadBotAssignment(chatId: string): Promise<string | undefined>;
  runManagedEntitiesBoundedRefreshJob(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options?: ManagedEntitiesRefreshRunOptions,
  ): Promise<ManagedEntitiesRefreshJobOutcome>;
  runManagedEntitiesRemoteFullRefresh(
    user: AuthUser,
    entityType: ManagedEntityTypeFilter,
    options?: ManagedEntitiesRefreshRunOptions,
  ): Promise<ManagedEntitiesRefreshJobOutcome>;
};

export function createAdminManagedEntitiesRuntimeContext(
  target: AdminManagedEntitiesRuntimeContext,
): AdminManagedEntitiesRuntimeContext {
  return target;
}
