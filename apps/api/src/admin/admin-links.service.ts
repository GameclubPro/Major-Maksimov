import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  evaluateLinkRulesPolicy,
  linkRulesPreviewRequestSchema,
  type LinkRulesPreviewResponse,
} from '@maxim/contracts/settings';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  extractEnabledNavigationTargets,
  resolveEnabledNavigationTargetOptions,
} from '../moderation/navigation/enabled-navigation-targets';
import { adaptMaxMessageNavigationView } from '../moderation/navigation/max-navigation-view.adapter';
import { isEnforceableLinkPolicyTarget } from '../moderation/navigation/link-policy-target.util';
import { ManagedEntitiesService } from './managed-entities.service';

@Injectable()
export class AdminLinksService {
  constructor(
    private readonly admin: ManagedEntitiesService,
    private readonly config: ConfigService,
  ) {}

  async preview(chatId: string, user: AuthUser, body: unknown): Promise<LinkRulesPreviewResponse> {
    await this.admin.assertChatAdminAccess(chatId, user);
    const parsed = linkRulesPreviewRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());

    // FLAG: Preview uses the same navigation extraction, runtime switches and evaluator as
    // moderation. It has no effect authority and must never persist or log the supplied text.
    const targets = extractEnabledNavigationTargets(
      adaptMaxMessageNavigationView({ body: { text: parsed.data.text } }),
      resolveEnabledNavigationTargetOptions(this.config),
    );
    const result = evaluateLinkRulesPolicy(parsed.data.policy, targets);
    return {
      allowed: result.allowed,
      reason: result.reason,
      targetsCount: targets.filter(isEnforceableLinkPolicyTarget).length,
      ...(!result.allowed
        ? {
            target: result.target.target,
            ...(result.matchedRule ? { ruleId: result.matchedRule.id } : {}),
          }
        : {}),
    };
  }
}
