import { Injectable, NotFoundException } from '@nestjs/common';
import { moderationMessageContentSchema, type ModerationMessageDetails } from '@maxim/contracts';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { ManagedEntitiesService } from './managed-entities.service';

@Injectable()
export class ModerationMessageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ManagedEntitiesService,
  ) {}

  async getMessage(
    chatId: string,
    eventId: string,
    user: AuthUser,
  ): Promise<ModerationMessageDetails> {
    // FLAG: Authorize before reading private content, including cached/expired events.
    await this.access.assertChatAdminAccess(chatId, user);
    if (!eventId || eventId.length > 200) throw new NotFoundException('Запись не найдена.');
    const event = await this.prisma.chatModerationFeedItem.findUnique({
      where: { id: eventId },
      select: { chatId: true, maskedExcerpt: true },
    });
    if (!event || event.chatId !== chatId) throw new NotFoundException('Запись не найдена.');
    const reason = await this.prisma.moderationDeleteIntentReason.findUnique({
      where: { moderationEventId: eventId },
      select: { messageSnapshot: true },
    });
    const snapshot = reason?.messageSnapshot;
    if (snapshot) {
      const dates = {
        sourceAt: snapshot.sourceAt.toISOString(),
        expiresAt: snapshot.expiresAt.toISOString(),
      };
      // FLAG: Physical purge may lag. Expired content must never escape through a read.
      if (snapshot.purgedAt || snapshot.expiresAt.getTime() <= Date.now())
        return { eventId, state: 'expired', content: null, ...dates };
      const content = moderationMessageContentSchema.safeParse(snapshot.content);
      if (content.success)
        return {
          eventId,
          state: content.data.truncated ? 'partial' : 'saved',
          content: content.data,
          ...dates,
        };
    }
    const text = event.maskedExcerpt?.trim();
    return {
      eventId,
      state: text ? 'partial' : 'not_captured',
      content: text ? { text: text.slice(0, 16000), truncated: true, attachments: [] } : null,
      sourceAt: null,
      expiresAt: null,
    };
  }
}
