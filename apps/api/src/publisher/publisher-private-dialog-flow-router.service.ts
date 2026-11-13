import { SuggestionNativeQueueService } from './suggestion-native.queue';
import type { MaxUpdate } from '@maxim/contracts';
import { Injectable, Optional } from '@nestjs/common';
import { PublisherVkBotReviewQueueService } from './publisher-vk-bot-review.queue';
import { PublisherAutoReplyAuthoringService } from './publisher-auto-reply-authoring.service';
import { PublisherPostImportService } from './publisher-post-import.service';
import { PublisherSuggestionAdminCallbackObserverService } from './publisher-suggestion-admin-callback-observer.service';
import { PublisherStartQueueService } from './publisher-start.queue';

@Injectable()
export class PublisherPrivateDialogFlowRouterService {
  constructor(
    private readonly suggestionAdminCallbacks: PublisherSuggestionAdminCallbackObserverService,
    private readonly autoReplyAuthoring: PublisherAutoReplyAuthoringService,
    private readonly postImport: PublisherPostImportService,
    private readonly start: PublisherStartQueueService,
    @Optional() private readonly vkReview?: PublisherVkBotReviewQueueService,
    @Optional() private readonly nativeReview?: SuggestionNativeQueueService,
  ) {}

  async observeWebhook(
    update: MaxUpdate,
    webhookEventId: string | null,
    options: { duplicate?: boolean } = {},
  ): Promise<boolean> {
    if (await this.nativeReview?.observeWebhook(update)) return true;
    if (await this.vkReview?.observeWebhook(update)) return true;
    if (await this.suggestionAdminCallbacks.observeWebhook(update, webhookEventId, options)) {
      return true;
    }
    if (await this.autoReplyAuthoring.observeWebhook(update, webhookEventId, options)) {
      return true;
    }
    if (await this.postImport.observeWebhook(update, webhookEventId, options)) {
      return true;
    }
    return this.start.observeWebhook(update);
  }
}
