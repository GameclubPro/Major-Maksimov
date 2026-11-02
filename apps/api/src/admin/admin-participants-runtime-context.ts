import type { Logger } from '@nestjs/common';
import type { ManagedEntityHeader, ManagedEntityType } from '@maxim/contracts';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import type { ManagedEntityAccessLossService } from '../max/managed-entity-access-loss.service';
import type { MaxClientService } from '../max/max-client.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AdminReadBypassOptions } from './admin.service.support';

export type PrepareManualModerationTargetOptions = {
  skipActorAdminCheck?: boolean;
};

export type AdminParticipantsRuntimeContext = {
  readonly prisma: PrismaService;
  readonly maxClient: MaxClientService;
  readonly logger: Logger;
  readonly managedEntityAccessLossService?: ManagedEntityAccessLossService;
  assertReadOnlyChatAdmin(
    chatId: string,
    userId: string,
    entityType?: ManagedEntityType | null,
    options?: {
      forceRemote?: boolean;
      timeoutMs?: number;
    },
  ): Promise<void>;
  buildProfileMentionHandoffUrl(
    chatId: string,
    entityType: ManagedEntityType,
    userId: string,
    displayName: string | null,
    botId?: string | null,
  ): string | null;
  ensureEntityType(
    chatId: string,
    userId: string,
    expectedEntityType: ManagedEntityType,
  ): Promise<void>;
  getManagedEntityHeader(
    chatId: string,
    user: AuthUser,
    entityType: ManagedEntityType,
    options?: AdminReadBypassOptions,
  ): Promise<ManagedEntityHeader>;
  prepareManualModerationTarget(
    chatId: string,
    targetUserIdRaw: string,
    user: AuthUser,
    options?: PrepareManualModerationTargetOptions,
  ): Promise<string>;
  resolveBackgroundReadBotAssignment(chatId: string): Promise<string | undefined>;
  resolveParticipantCleanupBotAssignment(chatId: string): Promise<string | undefined>;
  isKnownRuntimeBotUserId(userId: string): boolean;
};

export function createAdminParticipantsRuntimeContext(
  target: AdminParticipantsRuntimeContext,
): AdminParticipantsRuntimeContext {
  return target;
}
