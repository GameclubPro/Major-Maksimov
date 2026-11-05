import { Injectable } from '@nestjs/common';
import { MaxActionLedgerService } from '../max/max-action-ledger.service';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { resolveNightModeTransitionSnapshot } from './night-mode-transition-time.util';
import {
  NightModeOpenNoticeCleanupRejectedError,
  parseNightModeOpenNoticeCleanupBinding,
  resolveNightModeOpenNoticeCleanupSession,
} from './night-mode-open-notice-cleanup-binding';

export type NightModeOpenNoticeCleanupIntent = {
  chatId: string;
  messageId: string;
  originBotId: string | null;
  entityType: 'CHAT' | 'CHANNEL' | null;
  messageAuthorKind: string | null;
  routingPolicy: string;
};

@Injectable()
export class NightModeOpenNoticeCleanupGuardService {
  constructor(private readonly prisma: PrismaService) {}

  async assertAllowed(intent: NightModeOpenNoticeCleanupIntent, value: unknown): Promise<void> {
    const binding = parseNightModeOpenNoticeCleanupBinding(value);
    if (
      !binding ||
      intent.entityType !== 'CHAT' ||
      intent.messageAuthorKind !== 'bot' ||
      intent.routingPolicy !== 'origin_only' ||
      intent.messageId !== binding.messageId ||
      intent.originBotId !== binding.botId
    )
      throw new NightModeOpenNoticeCleanupRejectedError();

    // FLAG: A later human message authorizes only this completed SEND and persisted opening
    // event. Current settings cannot turn an old, ambiguous or other-bot notice into a target.
    const proof = await new MaxActionLedgerService(
      this.prisma,
    ).inspectCompletedNightModeOpenNoticeDispatch({
      chatId: intent.chatId,
      sessionKey: binding.sessionKey,
    });
    if (
      proof.kind !== 'completed' ||
      proof.remoteMessageId !== binding.messageId ||
      proof.dispatchBotId !== binding.botId ||
      proof.completedAt.toISOString() !== binding.sendCompletedAt
    )
      throw new NightModeOpenNoticeCleanupRejectedError();
    const event = await this.prisma.moderationEvent.findFirst({
      where: {
        id: binding.eventId,
        chatId: intent.chatId,
        messageId: binding.messageId,
        botId: binding.botId,
        ruleCode: 'NIGHT_MODE_OPEN_NOTICE',
        metadata: { path: ['sessionKey'], equals: binding.sessionKey } satisfies Prisma.JsonFilter,
      },
      select: { id: true },
    });
    if (!event) throw new NightModeOpenNoticeCleanupRejectedError();

    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId: intent.chatId },
      include: { chat: { select: { entityType: true } } },
    });
    const now = new Date();
    const sourceAt = new Date(binding.trigger.createdAt);
    // FLAG: The writer excluded manual closure when it accepted this trigger. Current manual
    // settings are not closure history; recheck source schedule geometry and current effective open separately.
    const sourceSnapshot = settings ? resolveNightModeTransitionSnapshot(settings, sourceAt) : null;
    if (
      !settings ||
      settings.chat.entityType !== 'CHAT' ||
      resolveNightModeOpenNoticeCleanupSession(settings, now) !== binding.sessionKey ||
      sourceSnapshot?.status !== 'open' ||
      sourceSnapshot?.sessionKey !== binding.sessionKey ||
      sourceAt > now ||
      sourceAt.getTime() + 24 * 60 * 60_000 <= now.getTime()
    )
      throw new NightModeOpenNoticeCleanupRejectedError();
  }
}
