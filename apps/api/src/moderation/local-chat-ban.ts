import { createHash } from 'node:crypto';
import type { MaxUpdate } from '@maxim/contracts';
import { withMaxFinalAuthorityCheckpoint } from '../max/max-action-pre-dispatch-guard';
import {
  MAX_API_SOURCE_TAGS,
  type MaxActionDispatchOptions,
  type MaxClientService,
} from '../max/max-client.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { ModerationEvent } from '../prisma/prisma-client';
import type { WebhookLegacyHoldService } from '../webhook/webhook-legacy-hold.service';
import { WebhookParser } from '../webhook/webhook.parser';
import type { ModerationSanctionStateFenceService } from './moderation-sanction-state-fence.service';
import type { ModerationSanctionStateLockService } from './moderation-sanction-state-lock.service';

export const LOCAL_CHAT_BAN_READER_VERSION = 1;
export const LOCAL_CHAT_BAN_MODE = 'LOCAL_REJOIN' as const;
const SOURCE_LIFETIME_MS = 5 * 60_000;
const parser = new WebhookParser();

export type ActiveLocalChatBan = {
  id: string;
  createdAt: Date;
  initiatedByUserId: string | null;
};

type LatestChatSanctionState = Pick<
  ModerationEvent,
  'id' | 'ruleCode' | 'action' | 'operator' | 'metadata' | 'createdAt'
>;

export async function readLatestChatSanctionState(
  prisma: Pick<PrismaService, '$queryRaw'>,
  chatId: string,
  userId: string,
): Promise<LatestChatSanctionState | null> {
  // FLAG: Fixed literal sanction predicates match the partial state index. Prisma's
  // parameterized enum IN casts otherwise make PostgreSQL scan unrelated history.
  const rows = await prisma.$queryRaw<LatestChatSanctionState[]>`
    SELECT "id", "rule_code" AS "ruleCode", "action", "operator", "metadata",
      "created_at" AS "createdAt"
    FROM "moderation_events"
    WHERE "chat_id" = ${chatId} AND "user_id" = ${userId}
      AND ("action" IN ('MUTE', 'BAN') OR "rule_code" IN ('MANUAL_UNMUTE', 'MANUAL_UNBAN'))
    ORDER BY "created_at" DESC, "id" DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

export async function readActiveLocalChatBan(
  prisma: Pick<PrismaService, '$queryRaw'>,
  fence: Pick<ModerationSanctionStateFenceService, 'isSanctionEventInvalidated'>,
  chatId: string,
  userId: string,
): Promise<ActiveLocalChatBan | null> {
  const latest = await readLatestChatSanctionState(prisma, chatId, userId);
  const metadata = readMetadata(latest?.metadata);
  if (
    !latest ||
    latest.action !== 'BAN' ||
    latest.ruleCode !== 'MANUAL_BAN' ||
    latest.operator !== 'ADMIN' ||
    metadata.mode !== LOCAL_CHAT_BAN_MODE ||
    metadata.sanctionApplied === false ||
    (await fence.isSanctionEventInvalidated({
      chatId,
      userId,
      sanctionEventId: latest.id,
      eventCreatedAt: latest.createdAt,
    }))
  )
    return null;
  return {
    id: latest.id,
    createdAt: latest.createdAt,
    initiatedByUserId:
      typeof metadata.initiatedByUserId === 'string' ? metadata.initiatedByUserId : null,
  };
}

type LocalChatBanContext = {
  prisma: Pick<PrismaService, '$queryRaw' | 'chat'>;
  fence: Pick<ModerationSanctionStateFenceService, 'isSanctionEventInvalidated'>;
  sanctionLock: Pick<ModerationSanctionStateLockService, 'runExclusive'>;
  max: Pick<
    MaxClientService,
    | 'getChatMemberAccess'
    | 'getCurrentChatMemberAccess'
    | 'getExactMessageRow'
    | 'clearTerminalBanStateAfterConfirmedUnban'
  >;
  legacyHolds?: Pick<
    WebhookLegacyHoldService,
    'isMessageHeld' | 'isMemberHeld' | 'isGlobalUserHeld'
  >;
  isKnownBotUserId(userId: string): boolean;
  kick(
    chatId: string,
    userId: string,
    optionsForBot: (botId?: string) => Promise<MaxActionDispatchOptions>,
  ): Promise<boolean>;
};

class LocalChatBanRejectedError extends Error {
  readonly code = 'local_chat_ban_no_longer_authorized';
}

export async function enforceLocalChatBan(
  update: MaxUpdate,
  userId: string,
  context: LocalChatBanContext,
): Promise<boolean> {
  const message = update.message;
  if (!message || !userId || context.isKnownBotUserId(userId)) return false;
  const isJoin =
    update.membership?.action === 'added' && update.membership.memberUserIds.includes(userId);
  const isMessage =
    update.type === 'message_created' && message.senderId === userId && !update.membership;
  if (!isJoin && !isMessage) return false;
  const sourceAt = Date.parse(message.createdAt);
  const sourceValid = () =>
    Number.isSafeInteger(sourceAt) &&
    sourceAt > 0 &&
    sourceAt <= Date.now() &&
    Date.now() < sourceAt + SOURCE_LIFETIME_MS;
  if (!sourceValid()) return false;
  const { chatId, messageId } = message;
  const initial = await readActiveLocalChatBan(context.prisma, context.fence, chatId, userId);
  if (!initial || sourceAt < initial.createdAt.getTime()) return false;

  const assertSourceAllowed = async () => {
    if (
      !sourceValid() ||
      context.isKnownBotUserId(userId) ||
      (await context.legacyHolds?.isMessageHeld(chatId, messageId)) ||
      (await context.legacyHolds?.isMemberHeld(chatId, userId)) ||
      (await context.legacyHolds?.isGlobalUserHeld(userId))
    )
      throw new LocalChatBanRejectedError();
  };
  const readCurrent = () => readActiveLocalChatBan(context.prisma, context.fence, chatId, userId);
  const assertCurrent = async () => {
    const chat = await context.prisma.chat.findUnique({
      where: { id: chatId },
      select: { entityType: true, admins: { select: { userId: true } } },
    });
    if (!chat || chat.entityType !== 'CHAT' || chat.admins.some((admin) => admin.userId === userId))
      throw new LocalChatBanRejectedError();
    const current = await readCurrent();
    if (current?.id !== initial.id) throw new LocalChatBanRejectedError();
  };
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        initial.id,
        chatId,
        userId,
        isJoin ? 'join' : 'message',
        messageId,
        sourceAt,
      ]),
    )
    .digest('hex');
  try {
    return await context.sanctionLock.runExclusive({ chatId, userId }, async (lease) => {
      await lease.assertOwned();
      await assertSourceAllowed();
      await assertCurrent();
      return context.kick(chatId, userId, async (botId) => {
        if (!botId) throw new LocalChatBanRejectedError();
        const options = {
          botId,
          bypassCache: true,
          trafficClass: 'critical' as const,
          actionHealthLane: 'critical' as const,
          sourceTag: MAX_API_SOURCE_TAGS.MODERATION_SANCTION,
          timeoutMs: 5_000,
        };
        const assertOrdinaryTarget = async () => {
          const target = await context.max.getChatMemberAccess(chatId, userId, options);
          if (
            !target ||
            target.userId !== userId ||
            target.isAdmin !== false ||
            target.isOwner !== false ||
            target.isBot !== false
          )
            throw new LocalChatBanRejectedError();
        };
        const probeStartedAt = new Date();
        await assertOrdinaryTarget();
        await assertSourceAllowed();
        await assertCurrent();
        await lease.assertOwned();
        // FLAG: Exact selected-bot presence retires only older confirmed BAN success.
        // The cutoff path retains uncertain effects and bans completed during the probe.
        await context.max.clearTerminalBanStateAfterConfirmedUnban(chatId, userId, probeStartedAt);
        await lease.assertOwned();
        return {
          idempotencyKey: `local-chat-ban:v1:${digest}`,
          beforeImmediateMemberMutation: withMaxFinalAuthorityCheckpoint(
            async (beforeFinalAuthority) => {
              await assertOrdinaryTarget();
              const bot = await context.max.getCurrentChatMemberAccess(chatId, options);
              if (
                !(
                  bot.isOwner === true ||
                  (bot.isAdmin === true && bot.permissions.includes('add_remove_members'))
                )
              )
                throw new LocalChatBanRejectedError();
              if (isMessage) {
                const row = await context.max.getExactMessageRow(chatId, messageId, options);
                const live = row
                  ? parser.parse({
                      type: 'message_created',
                      updateId: 'local-chat-ban-source',
                      message: row,
                    }).message
                  : null;
                if (
                  !live ||
                  live.chatId !== chatId ||
                  live.messageId !== messageId ||
                  live.senderId !== userId ||
                  live.entityType === 'channel' ||
                  Date.parse(live.createdAt) !== sourceAt
                )
                  throw new LocalChatBanRejectedError();
              }
              // FLAG: The exact executor is checked after remote preparation. The final
              // sanction/lease/source reads cannot be replaced by the earlier candidate.
              await beforeFinalAuthority?.();
              await assertSourceAllowed();
              await assertCurrent();
              await lease.assertOwned();
              if (!sourceValid()) throw new LocalChatBanRejectedError();
            },
          ),
        };
      });
    });
  } catch (error: unknown) {
    if (error instanceof LocalChatBanRejectedError) return false;
    throw error;
  }
}

function readMetadata(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
