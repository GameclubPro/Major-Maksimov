import { Prisma, type ChatEntityType } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import {
  MAX_API_SOURCE_TAGS,
  type MaxClientService,
  type MaxChatMemberAccess,
} from './max-client.service';
import { hasFreshExecutionAccess } from './max-execution-route-proof';
import {
  hasExplicitHumanAdministrator,
  isMajorManagedEntityActivationRequired,
} from './managed-entity-activation.util';

// FLAG: This path verifies humans only. It cannot renew, activate or revoke a bot.
export async function probeManagedEntityActor(params: {
  prisma: PrismaService;
  maxClient: MaxClientService;
  cache: ChatContextCacheService;
  chatId: string;
  botId: string;
  userId: string;
  requiredCheckedAfter: Date;
}): Promise<boolean> {
  const { prisma, maxClient, cache, chatId, botId, userId } = params;
  const identity = (id: string | null) =>
    (id ?? '')
      .trim()
      .toLowerCase()
      .replace(/^id(?=\d)/u, '');
  const canonicalUserId = identity(userId);
  const variants = [
    ...new Set([
      userId,
      canonicalUserId,
      ...(/^\d+$/u.test(canonicalUserId) ? [`id${canonicalUserId}`] : []),
    ]),
  ];
  const before = await prisma.chatBotMembership.findUnique({
    where: { chatId_botId: { chatId, botId } },
    include: { chat: { select: { entityType: true } } },
  });
  if (
    !before ||
    !hasFreshExecutionAccess(before) ||
    isMajorManagedEntityActivationRequired(before, before.chat.entityType)
  )
    return false;
  const startedAt = new Date();
  if (startedAt < params.requiredCheckedAfter) throw new Error('Actor demand starts in the future');
  const options = {
    botId,
    bypassCache: true,
    trafficClass: 'interactive' as const,
    sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
    timeoutMs: 5_000,
  };
  let access: MaxChatMemberAccess | null;
  try {
    const members = await maxClient.getChatMembersAccess(chatId, [canonicalUserId], options);
    access =
      [...members.values()].find((member) => identity(member.userId) === canonicalUserId) ?? null;
  } catch (error: unknown) {
    const status = (error as { response?: { status?: number } })?.response?.status;
    if (status !== 403 && status !== 404) throw error;
    // FLAG: A member GET refusal and absence from an administrator roster are ambiguous.
    // The fallback may prove a grant, but cannot revoke a previously confirmed human.
    const roster = await maxClient.getChatAdminAccesses(chatId, options);
    if (
      roster.some(
        (member) =>
          !member.userId ||
          typeof member.isBot !== 'boolean' ||
          !(member.isAdmin || member.isOwner) ||
          member.explicitPrivilegeEvidence !== true,
      )
    )
      throw new Error('Incomplete MAX administrator roster');
    access = roster.find((member) => identity(member.userId) === canonicalUserId) ?? null;
    if (!access) throw error;
  }
  // FLAG: An omitted requested member is not an exact negative privilege response.
  if (!access) throw new Error('MAX actor privilege evidence is unavailable');
  if (access && typeof access.isBot !== 'boolean') throw new Error('MAX actor type is unknown');
  // FLAG: Missing human privilege fields are unknown, not a revocation of a retained grant.
  if (
    !access.isAdmin &&
    !access.isOwner &&
    access.isBot !== true &&
    access.explicitNonPrivilegeEvidence !== true
  )
    throw new Error('MAX actor role evidence is incomplete');
  if (access && (access.isAdmin || access.isOwner) && access.explicitPrivilegeEvidence !== true)
    throw new Error('MAX actor privilege evidence is incomplete');
  const granted = hasExplicitHumanAdministrator(access ?? undefined, userId);
  const committed = await prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM chats WHERE id = ${chatId} FOR UPDATE`);
    if (locked.length !== 1) return false;
    const current = await tx.chatBotMembership.findUnique({
      where: { chatId_botId: { chatId, botId } },
    });
    if (
      !current ||
      !hasFreshExecutionAccess(current) ||
      isMajorManagedEntityActivationRequired(current, before.chat.entityType) ||
      current.botAccessCheckedAt?.getTime() !== before.botAccessCheckedAt?.getTime() ||
      current.botAccessSource !== before.botAccessSource ||
      current.lifecycleEventAt?.getTime() !== before.lifecycleEventAt?.getTime()
    )
      return false;
    const newer = await tx.managedEntityAccessEdge.findFirst({
      where: { chatId, userId: { in: variants }, checkedAt: { gte: startedAt } },
      select: { userId: true },
    });
    if (newer) return false;
    const changes = await tx.$queryRaw<{ userId: string }[]>(Prisma.sql`
      SELECT user_id AS "userId" FROM chat_membership_activity_events
      WHERE chat_id = ${chatId} AND user_id IN (${Prisma.join(variants)})
        AND event_type IN ('user_added', 'user_removed') AND event_at >= ${startedAt} LIMIT 1`);
    if (changes.length) return false;
    const verdict = {
      entityType: before.chat.entityType as ChatEntityType,
      state: granted ? ('GRANTED' as const) : ('USER_DENIED' as const),
      userRole: granted
        ? access!.isOwner
          ? ('OWNER' as const)
          : ('ADMIN' as const)
        : ('MEMBER' as const),
      botRole:
        current.botAccessState === 'CONFIRMED_OWNER' ? ('OWNER' as const) : ('ADMIN' as const),
      checkedAt: startedAt,
      expiresAt: new Date(startedAt.getTime() + (granted ? 3 * 86400_000 : 15 * 60_000)),
      source: 'personal_admin_access',
      deniedReason: granted ? null : 'user_not_admin',
      lastMaxErrorCode: null,
      lastMaxErrorMessage: null,
      lastMaxStatusCode: null,
    };
    await tx.managedEntityAccessEdge.upsert({
      where: { chatId_userId_botId: { chatId, userId, botId } },
      create: { chatId, userId, botId, ...verdict },
      update: verdict,
    });
    if (granted) {
      await tx.chatAdminAllowlist.upsert({
        where: { chatId_userId: { chatId, userId } },
        create: { chatId, userId },
        update: {},
      });
    } else {
      await tx.chatAdminAllowlist.deleteMany({ where: { chatId, userId: { in: variants } } });
      await tx.managedEntityAccessEdge.updateMany({
        where: {
          chatId,
          userId: { in: variants },
          checkedAt: { lte: startedAt },
          state: 'GRANTED',
        },
        data: {
          state: 'USER_DENIED',
          checkedAt: startedAt,
          expiresAt: verdict.expiresAt,
          deniedReason: verdict.deniedReason,
          source: verdict.source,
        },
      });
    }
    return true;
  });
  if (!committed) throw new Error('Actor probe superseded by a newer access epoch');
  await cache.applyAdminAccessEpochMutation({
    chatId,
    userId,
    eventAt: startedAt,
    state: granted ? 'granted' : 'user_denied',
  });
  return true;
}
