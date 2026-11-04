import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import {
  commercialAdsPreviewRequestSchema,
  type CommercialAdsPreviewResponse,
} from '@maxim/contracts/settings';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { CommercialAdsPreviewService } from '../moderation/commercial/commercial-ads-preview.service';
import { RedisCounterService } from '../moderation/redis-counter.service';
import { PrismaService } from '../prisma/prisma.service';
import { DEFAULT_CHAT_SETTINGS } from './admin.service.support';
import { ManagedEntitiesService } from './managed-entities.service';
import { commercialAdsFeedbackId, COMMERCIAL_AD_FEED_RULE_CODES } from './commercial-ads-feedback';

const feedbackRequestSchema = z.object({ feedItemId: z.string().trim().min(1).max(200) }).strict();
const unavailable = (): CommercialAdsPreviewResponse => ({
  decision: 'UNAVAILABLE',
  categories: [],
  reason: 'CLASSIFIER_UNAVAILABLE',
});

@Injectable()
export class AdminCommercialAdsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ManagedEntitiesService,
    private readonly classifier: CommercialAdsPreviewService,
    private readonly redis: RedisCounterService,
  ) {}

  async preview(
    chatId: string,
    user: AuthUser,
    body: unknown,
  ): Promise<CommercialAdsPreviewResponse> {
    await this.access.assertChatAdminAccess(chatId, user);
    const parsed = commercialAdsPreviewRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    // FLAG: An authenticated draft check has no webhook/effect authority. Bound its resource
    // use per actor and fail unavailable if shared admission cannot be observed.
    try {
      if ((await this.redis.incrementWithTtl(`commercial-preview:v1:${user.userId}`, 60)) > 8)
        return unavailable();
    } catch {
      return unavailable();
    }
    const settings = await this.prisma.chatSettings.findUnique({ where: { chatId } });
    return this.classifier.preview(parsed.data, settings ?? DEFAULT_CHAT_SETTINGS);
  }

  async feedback(chatId: string, user: AuthUser, body: unknown): Promise<{ ok: true }> {
    await this.access.assertChatAdminAccess(chatId, user);
    const parsed = feedbackRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    const item = await this.prisma.chatModerationFeedItem.findUnique({
      where: { id: parsed.data.feedItemId },
      select: { id: true, chatId: true, ruleCode: true },
    });
    if (!item || item.chatId !== chatId || !COMMERCIAL_AD_FEED_RULE_CODES.has(item.ruleCode))
      throw new NotFoundException('Запись о рекламе не найдена.');
    const id = commercialAdsFeedbackId(chatId, user.userId, item.id);
    // FLAG: This is an administrator report, not a verified quality label. It never mutates
    // reputation, enforcement evidence, model training labels or the community's policy.
    await this.prisma.auditLog.createMany({
      data: [
        {
          id,
          chatId,
          actorUserId: user.userId,
          action: 'REPORT_COMMERCIAL_AD_ERROR',
          payload: { version: 1, feedItemId: item.id, ruleCode: item.ruleCode },
        },
      ],
      skipDuplicates: true,
    });
    return { ok: true };
  }
}
