import { chatSettingsSchema } from '@maxim/contracts/settings';
import { ConflictException } from '@nestjs/common';
import { Prisma, type Chat } from '../prisma/prisma-client';
import { executionRouteProof } from './max-execution-route-proof';
import type { ChatSettingsBotCapabilityRequirement } from '../admin/chat-settings-bot-capability';
import {
  CHAT_SETTINGS_BOT_CAPABILITY_SELECT,
  currentChatSettingsBotCapabilityRequirements,
} from '../admin/chat-settings-bot-capability';
import { readStopWordsPolicy } from '../moderation/stop-words/stop-words.policy';
import type { MaxExecutionPurpose } from './max-execution-route-proof';

export async function readFixedModeratorSettingsPurposes(
  db: Pick<Prisma.TransactionClient, 'chatSettings' | 'channelSettings'>,
  chatId: string,
  entityType: 'CHAT' | 'CHANNEL',
  commercialAiDeleteOnly = false,
): Promise<MaxExecutionPurpose[]> {
  if (entityType === 'CHANNEL') {
    const settings = await db.channelSettings.findUnique({
      where: { chatId },
      select: {
        commentsEnabled: true,
        postSuggestionsEnabled: true,
        postSignatureEnabled: true,
        quickButtonsEnabled: true,
      },
    });
    return settings && Object.values(settings).some(Boolean)
      ? ['send_message', 'edit_message']
      : [];
  }
  const stored = await db.chatSettings.findUnique({
    where: { chatId },
    select: {
      ...CHAT_SETTINGS_BOT_CAPABILITY_SELECT,
      stopWordsPolicy: true,
    },
  });
  const settings = chatSettingsSchema.parse({
    ...stored,
    stopWordsPolicy: stored ? (readStopWordsPolicy(stored) ?? undefined) : undefined,
  });
  return currentChatSettingsBotCapabilityRequirements(settings, commercialAiDeleteOnly).map(
    (requirement) =>
      requirement.permission === 'add_remove_members' ? 'moderate_member' : 'send_message',
  );
}

/** FLAG: Call only after locking the parent Chat in the settings write transaction.
 * A preflight against the previous moderator cannot authorize a write after reassignment.
 * Lifecycle and assignment also lock Chat first, so this proof survives through commit. */
export async function assertFixedModeratorCapabilitiesForSettings(
  db: Pick<Prisma.TransactionClient, 'chatBotMembership'>,
  chat: Pick<Chat, 'id' | 'entityType' | 'primaryBotId' | 'fixedModeratorBotId' | 'routingVersion'>,
  purposes: readonly MaxExecutionPurpose[],
): Promise<void> {
  if (!chat.fixedModeratorBotId || purposes.length === 0) return;
  const member = await db.chatBotMembership.findUnique({
    where: { chatId_botId: { chatId: chat.id, botId: chat.fixedModeratorBotId } },
  });
  const state = { ...chat, chatId: chat.id, candidates: member ? [member] : [] };
  if (purposes.some((purpose) => !executionRouteProof(state, chat.fixedModeratorBotId!, purpose)))
    throw new ConflictException(
      'Права выбранного бота изменились. Проверьте их и сохраните настройки снова.',
    );
}

export function chatSettingsCapabilityPurposes(
  requirements: readonly ChatSettingsBotCapabilityRequirement[],
): MaxExecutionPurpose[] {
  return requirements.map((requirement) =>
    requirement.permission === 'add_remove_members' ? 'moderate_member' : 'send_message',
  );
}

export async function lockModeratorSettingsChat(
  tx: Prisma.TransactionClient,
  chatId: string,
): Promise<
  Pick<Chat, 'id' | 'entityType' | 'primaryBotId' | 'fixedModeratorBotId' | 'routingVersion'>
> {
  const rows = await tx.$queryRaw<
    Array<
      Pick<Chat, 'id' | 'entityType' | 'primaryBotId' | 'fixedModeratorBotId' | 'routingVersion'>
    >
  >(Prisma.sql`
    SELECT id, entity_type AS "entityType", primary_bot_id AS "primaryBotId",
      fixed_moderator_bot_id AS "fixedModeratorBotId", routing_version AS "routingVersion"
    FROM chats WHERE id = ${chatId} FOR UPDATE
  `);
  if (rows.length !== 1) throw new ConflictException('Сообщество больше недоступно.');
  return rows[0]!;
}
