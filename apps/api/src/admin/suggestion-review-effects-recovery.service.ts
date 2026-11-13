import {
  Injectable,
  Logger,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { getAppRole, roleRunsAction, roleRunsPublisher } from '../runtime/app-role';
import { PublisherRuntimeBoundaryService } from '../publisher/publisher-runtime-boundary.service';
import { BackgroundRuntimeGovernorService } from '../system/background-runtime-governor.service';
import { MAX_API_SOURCE_TAGS } from '../max/max-client.service';
import { SuggestionReviewEffectsService } from './suggestion-review-effects.service';

@Injectable()
export class SuggestionReviewEffectsRecoveryService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private readonly logger = new Logger(SuggestionReviewEffectsRecoveryService.name);
  constructor(
    private readonly effects: SuggestionReviewEffectsService,
    private readonly governor: BackgroundRuntimeGovernorService,
    @Optional() private readonly publisher?: PublisherRuntimeBoundaryService,
  ) {}
  onModuleInit() {
    this.timer = setInterval(() => {
      void this.recover();
    }, 30_000);
    this.timer.unref();
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
  async recover() {
    if (this.busy) return;
    const profile =
      roleRunsPublisher(getAppRole()) &&
      process.env.APP_SERVICE_NAME === 'api-publisher' &&
      this.publisher?.dispatchEnabled
        ? 'publisher'
        : roleRunsAction(getAppRole())
          ? 'moderation'
          : null;
    if (!profile) return;
    this.busy = true;
    try {
      const decision = await this.governor.decide({
        component: 'suggestion-review-effects',
        sourceTag: MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY,
      });
      if (decision.action !== 'pause') {
        await this.effects.upgradeNativeCards(profile);
        await this.effects.recover(profile);
      }
    } catch {
      this.logger.warn('Suggestion review effect recovery unavailable');
    } finally {
      this.busy = false;
    }
  }
}
