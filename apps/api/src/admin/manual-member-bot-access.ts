import type { MaxChatMemberAccess, MaxClientService } from '../max/max-client.service';
import type { MaxBotLinkService } from '../max/max-bot-link.service';
import { normalizeMembershipAccessSnapshot } from '../max/max-bot-access-policy.util';
import { isBotAdminLookupDeniedError } from './admin-legacy-utils';
import {
  BotCapabilityCheckUnavailableException,
  BotCapabilityRequiredException,
  type BotCapabilityPermission,
} from './bot-capability-required.error';
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
    readonly permissionsKnown?: boolean;
    readonly explicitNonPrivilegeEvidence?: boolean;
    readonly activationCapabilityCeiling?: readonly string[];
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
      permissionsKnown: access.permissionsKnown,
      explicitNonPrivilegeEvidence: access.explicitNonPrivilegeEvidence,
      permissions: Object.freeze([...access.permissions]),
      ...(access.activationCapabilityCeiling
        ? { activationCapabilityCeiling: Object.freeze([...access.activationCapabilityCeiling]) }
        : {}),
    }),
  });
}

export type ManualMemberBotAccessProbe = Readonly<{
  access: MaxChatMemberAccess;
  checkedAt: Date;
  source: string;
}>;

function memberCapabilityUnavailable(): BotCapabilityCheckUnavailableException {
  return new BotCapabilityCheckUnavailableException({
    operation: 'member_moderation',
    featureKeys: ['manualMemberModeration'],
    canRecheck: false,
  });
}

function memberCapabilityRequired(
  permission: BotCapabilityPermission,
  checkedAt?: string,
): BotCapabilityRequiredException {
  return new BotCapabilityRequiredException({
    operation: 'member_moderation',
    missingPermissions: [permission],
    featureKeys: ['manualMemberModeration'],
    checkedAt,
    canRecheck: false,
  });
}

export async function throwManualMemberSelectionFailure(
  links: Partial<Pick<MaxBotLinkService, 'loadChatExecutionOwnerState'>> | undefined,
  chatId: string,
  probes: ReadonlyMap<string, ManualMemberBotAccessProbe>,
): Promise<never> {
  let owner: Awaited<ReturnType<MaxBotLinkService['loadChatExecutionOwnerState']>>;
  try {
    owner = (await links?.loadChatExecutionOwnerState?.(chatId)) ?? null;
  } catch {
    throw memberCapabilityUnavailable();
  }
  if (owner?.chatId !== chatId) throw memberCapabilityUnavailable();
  const assignedBotId =
    owner?.fixedModeratorBotId ??
    (owner?.candidates.length === 1 && owner.candidates[0]?.botId === owner.primaryBotId
      ? owner.primaryBotId
      : null);
  const membership = owner?.candidates.find((candidate) => candidate.botId === assignedBotId);
  const probe = assignedBotId ? probes.get(assignedBotId) : undefined;
  const snapshot = normalizeMembershipAccessSnapshot(membership?.permissionsSnapshot);
  // FLAG: A registry peer's denial or an older probe cannot explain the assigned bot's
  // failure. Only this command's acknowledged exact SQL access epoch proves missing rights.
  if (
    membership &&
    probe &&
    snapshot &&
    membership.botAccessCheckedAt?.getTime() === probe.checkedAt.getTime() &&
    membership.botAccessSource === probe.source &&
    snapshot.checkedAt === probe.checkedAt.toISOString() &&
    snapshot.isAdmin === probe.access.isAdmin &&
    snapshot.isOwner === probe.access.isOwner &&
    !snapshot.isOwner
  ) {
    if (!snapshot.isAdmin && probe.access.explicitNonPrivilegeEvidence === true)
      throw memberCapabilityRequired('administrator', probe.checkedAt.toISOString());
    if (
      snapshot.isAdmin &&
      snapshot.permissionsKnown === true &&
      probe.access.permissionsKnown === true &&
      (!snapshot.activationCapabilityCeiling ||
        snapshot.activationCapabilityCeiling.includes('moderate_member')) &&
      (!probe.access.activationCapabilityCeiling ||
        probe.access.activationCapabilityCeiling.includes('moderate_member')) &&
      !snapshot.permissions.some(isAddRemoveMembersPermission) &&
      !probe.access.permissions.some(isAddRemoveMembersPermission)
    )
      throw memberCapabilityRequired('add_remove_members', probe.checkedAt.toISOString());
  }
  throw memberCapabilityUnavailable();
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
    throw memberCapabilityUnavailable();
  }
}

export async function assertManualBotCanManageMembers(
  maxClient: Partial<Pick<MaxClientService, 'getCurrentChatMemberAccess'>>,
  chatId: string,
  _action: ManualMemberManageMembersAction,
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
      throw memberCapabilityUnavailable();
    }
    throw error;
  }
  if (botAccess.isOwner) return;
  if (!botAccess.isAdmin) {
    if (botAccess.explicitNonPrivilegeEvidence === true)
      throw memberCapabilityRequired('administrator');
    throw memberCapabilityUnavailable();
  }
  // FLAG: Passive access may withhold a newly granted right until explicit activation.
  // Its effective permission list cannot prove that the corresponding MAX right is absent.
  if (
    botAccess.activationCapabilityCeiling &&
    !botAccess.activationCapabilityCeiling.includes('moderate_member')
  )
    throw memberCapabilityUnavailable();
  if (
    (botAccess.permissionsKnown === true || botAccess.permissions.length > 0) &&
    !botAccess.permissions.some(isAddRemoveMembersPermission)
  ) {
    if (botAccess.permissionsKnown === true) throw memberCapabilityRequired('add_remove_members');
    throw memberCapabilityUnavailable();
  }
}
