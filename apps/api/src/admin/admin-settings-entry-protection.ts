import type { MaxChatMemberAccess } from '../max/max-client.service';
import { hasExplicitHumanAdministrator } from '../max/managed-entity-activation.util';
import type {
  AdminAccessResolution,
  AdminReadBypassOptions,
  AssertChatAdminOptions,
} from './admin.service.support';

export type ReadOnlyAdminOptions = Pick<
  AdminReadBypassOptions,
  'forceRemote' | 'timeoutMs' | 'protectHumanAdministrator'
>;

export function protectEntry(options: AdminReadBypassOptions): AdminReadBypassOptions {
  return { ...options, protectHumanAdministrator: true };
}

export function readOnlyAdminOptions(options: ReadOnlyAdminOptions): AssertChatAdminOptions {
  return {
    syncPersistedAccess: false,
    trafficClass: options.forceRemote === true ? 'interactive' : undefined,
    timeoutMs: options.timeoutMs,
    allowPersistedFallback: false,
    bypassPositiveCache: true,
    ...(options.protectHumanAdministrator === true ? { protectHumanAdministrator: true } : {}),
  };
}

export function resolveProtectedSettingsEntryAccess(params: {
  userId: string;
  userAccess: MaxChatMemberAccess | null;
  botAccess: MaxChatMemberAccess;
  botUserId?: string | null;
  probeStartedAt: Date;
}): Extract<AdminAccessResolution, { status: 'granted' | 'denied' }> {
  const { userId, userAccess, botAccess, probeStartedAt } = params;
  const identity = (value: string | null) =>
    (value ?? '')
      .trim()
      .toLowerCase()
      .replace(/^id(?=\d)/u, '');
  if (params.botUserId && identity(botAccess.userId) !== identity(params.botUserId))
    throw new Error('MAX settings bot identity does not match');
  const botPrivileged = botAccess.isAdmin || botAccess.isOwner;
  if (
    botPrivileged
      ? botAccess.explicitPrivilegeEvidence !== true
      : botAccess.explicitNonPrivilegeEvidence !== true
  )
    throw new Error('MAX settings bot privilege evidence is incomplete');
  const botRole = botAccess.isOwner ? 'OWNER' : botAccess.isAdmin ? 'ADMIN' : 'MEMBER';
  if (!botPrivileged)
    return { status: 'denied', source: 'remote', reason: 'bot_not_admin', botRole, probeStartedAt };

  // FLAG: Missing/type-ambiguous actor evidence cannot grant settings access or revoke a human.
  if (!userAccess || typeof userAccess.isBot !== 'boolean')
    throw new Error('MAX settings actor identity evidence is incomplete');
  if (!identity(userAccess.userId) || identity(userAccess.userId) !== identity(userId))
    throw new Error('MAX settings actor identity does not match');
  const humanAdministrator = hasExplicitHumanAdministrator(userAccess, userId);
  if (
    !humanAdministrator &&
    userAccess.isBot !== true &&
    (userAccess.isAdmin || userAccess.isOwner || userAccess.explicitNonPrivilegeEvidence !== true)
  )
    throw new Error('MAX settings actor privilege evidence is incomplete');
  const userRole = userAccess.isOwner ? 'OWNER' : userAccess.isAdmin ? 'ADMIN' : 'MEMBER';
  return humanAdministrator
    ? {
        status: 'granted',
        source: 'remote',
        userRole,
        botRole,
        probeStartedAt,
        humanAdministratorConfirmed: true,
      }
    : {
        status: 'denied',
        source: 'remote',
        reason: 'user_not_admin',
        userRole,
        botRole,
        probeStartedAt,
      };
}
