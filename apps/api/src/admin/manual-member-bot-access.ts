import { ForbiddenException } from '@nestjs/common';
import type { MaxChatMemberAccess, MaxClientService } from '../max/max-client.service';
import type { MaxBotLinkService } from '../max/max-bot-link.service';
import { isBotAdminLookupDeniedError } from './admin-legacy-utils';
import {
  ADMIN_ACTION_HEALTH_LANE,
  type ManualMemberManageMembersAction,
  type ManualModerationBotAction,
} from './admin.service.support';

export type ManualModerationBotAccessEvidence = Readonly<{
  chatId: string;
  botId: string;
  action: ManualModerationBotAction;
  access: Readonly<Pick<MaxChatMemberAccess, 'isOwner' | 'isAdmin'>> & {
    readonly permissions: readonly string[];
  };
}>;

export function captureManualModerationBotAccess(
  chatId: string,
  botId: string,
  action: ManualModerationBotAction,
  access: MaxChatMemberAccess,
): ManualModerationBotAccessEvidence {
  return Object.freeze({
    chatId,
    botId,
    action,
    access: Object.freeze({
      isOwner: access.isOwner,
      isAdmin: access.isAdmin,
      permissions: Object.freeze([...access.permissions]),
    }),
  });
}

export function isAddRemoveMembersPermission(permission: string): boolean {
  const normalized = permission
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/gu, '_');
  return /^(?:can_)?(?:add_remove_members|remove_members|manage_members|kick_members|ban_members|ban_users|delete_members)$/u.test(
    normalized,
  );
}

export async function assertCurrentManualMemberAuthority(
  maxClient: Partial<Pick<MaxClientService, 'getCurrentChatMemberAccess'>>,
  links: Partial<Pick<MaxBotLinkService, 'getFreshChatBotExecutionProof'>> | undefined,
  chatId: string,
  botId?: string,
): Promise<void> {
  if (!botId || !links?.getFreshChatBotExecutionProof) {
    return assertManualBotCanManageMembers(maxClient, chatId, 'BAN', botId);
  }
  // FLAG: Former-participant bans have no MAX mutation to run its final SQL guard.
  // Recheck current authority before local sanctions and their follow-up effects.
  const proof = await links.getFreshChatBotExecutionProof({
    chatId,
    botId,
    purpose: 'moderate_member',
  });
  if (!proof) {
    throw new ForbiddenException(
      'Действие недоступно: права бота или его назначение в этом чате изменились.',
    );
  }
}

export async function assertManualBotCanManageMembers(
  maxClient: Partial<Pick<MaxClientService, 'getCurrentChatMemberAccess'>>,
  chatId: string,
  action: ManualMemberManageMembersAction,
  botId?: string,
  evidence?: ManualModerationBotAccessEvidence,
): Promise<void> {
  if (typeof maxClient.getCurrentChatMemberAccess !== 'function') return;

  let botAccess: ManualModerationBotAccessEvidence['access'];
  try {
    // FLAG: Only the current command's selected exact-bot evidence may replace a
    // stale cache read. Final SQL route/access proof and sanction leases still own dispatch.
    botAccess =
      evidence?.chatId === chatId.trim() &&
      evidence.botId === botId &&
      evidence.action === 'moderate_member'
        ? evidence.access
        : await maxClient.getCurrentChatMemberAccess(chatId, {
            trafficClass: 'critical',
            actionHealthLane: ADMIN_ACTION_HEALTH_LANE,
            ...(botId ? { botId } : {}),
          });
  } catch (error: unknown) {
    if (isBotAdminLookupDeniedError(error)) {
      throw new ForbiddenException(
        'Действие недоступно: бот больше не состоит в этом чате MAX или утратил права администратора.',
      );
    }
    throw error;
  }
  if (botAccess.isOwner) return;
  if (!botAccess.isAdmin) {
    throw new ForbiddenException(
      action === 'BAN'
        ? 'Для бана боту нужны права администратора этого чата MAX.'
        : action === 'UNBAN'
          ? 'Чтобы снять блокировку и вернуть участника, боту нужны права администратора этого чата MAX.'
          : 'Для модерации участников боту нужны права администратора этого чата MAX.',
    );
  }
  if (
    botAccess.permissions.length > 0 &&
    !botAccess.permissions.some(isAddRemoveMembersPermission)
  ) {
    throw new ForbiddenException(
      action === 'BAN'
        ? 'В правах бота нет управления участниками (add_remove_members), поэтому бан недоступен.'
        : action === 'UNBAN'
          ? 'В правах бота нет управления участниками (add_remove_members), поэтому снять блокировку нельзя.'
          : 'В правах бота нет управления участниками (add_remove_members), поэтому действие недоступно.',
    );
  }
}
