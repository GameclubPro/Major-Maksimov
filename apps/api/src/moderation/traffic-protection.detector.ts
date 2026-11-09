import { createHash } from 'node:crypto';
import { raceWithTimeout } from '../common/promise-timeout.util';
import { DUPLICATE_EVENT_MAX_FUTURE_SKEW_MS } from './duplicate-state';
import type { ModerationMediaFlags } from './moderation-update-extractors';
import type { RedisCounterService } from './redis-counter.service';
import type { RuleViolation } from './rule-engine.contract';
import type { RuleEvaluationObserver } from './rule-engine-observation';
import {
  fingerprintTrafficSource,
  hasTrafficMedia,
  trafficRuleInterval,
  trafficPolicyEffectiveAtMs,
  TRAFFIC_PROTECTION_MAX_DELETE_AGE_MS,
  type TrafficProtectionRule,
  type TrafficProtectionSettings,
} from './traffic-protection';

const STATE_TIMEOUT_MS = 200;

export class TrafficProtectionDetector {
  constructor(private readonly redis: RedisCounterService) {}

  async detect(params: {
    chatId: string;
    userId: string;
    messageId?: string;
    eventTimestampMs?: number;
    eventType?: 'message_created' | 'message_edited';
    mediaGroupId?: string | null;
    text: string;
    media: Partial<ModerationMediaFlags>;
    settings: TrafficProtectionSettings;
    observer?: RuleEvaluationObserver;
  }): Promise<RuleViolation | null> {
    params.observer?.configured(true);
    const { settings, media, eventTimestampMs } = params;
    if (
      !params.messageId?.trim() ||
      !Number.isSafeInteger(eventTimestampMs) ||
      !eventTimestampMs ||
      eventTimestampMs <= 0 ||
      !Number.isSafeInteger(settings.trafficPolicyRevision) ||
      settings.trafficPolicyRevision < 0 ||
      !Number.isFinite(trafficPolicyEffectiveAtMs(settings.trafficPolicyEffectiveAt)) ||
      eventTimestampMs < trafficPolicyEffectiveAtMs(settings.trafficPolicyEffectiveAt)
    ) {
      params.observer?.finish({ kind: 'skip', reason: 'state' });
      return null;
    }

    const rule: TrafficProtectionRule | null =
      media.hasStickerAttachment && settings.stickerMessagesEnabled === false
        ? 'STICKER_BLOCKED'
        : null;
    if (rule) {
      params.observer?.eligible();
      return this.violation(params, rule, 300);
    }
    // FLAG: An edit is not a send, and an album without a stable MAX identity cannot
    // safely consume a per-message quota. Never guess its identity from timing alone.
    if (params.eventType !== 'message_created' || (media.hasMediaBatch && !params.mediaGroupId)) {
      params.observer?.finish({ kind: 'skip', reason: 'state' });
      return null;
    }

    let evaluated = false;
    let stale = false;
    for (const candidate of ['SLOW_MODE', 'MEDIA_RATE_LIMIT'] as const) {
      const interval = trafficRuleInterval(candidate, settings);
      if (!interval || (candidate === 'MEDIA_RATE_LIMIT' && !hasTrafficMedia(media))) continue;
      params.observer?.configured(true);
      params.observer?.eligible();
      const key = `traffic:v1:${params.chatId}:${params.userId}:${candidate}:${settings.trafficPolicyRevision}:${interval}`;
      const identity = params.mediaGroupId
        ? `album:${params.mediaGroupId}`
        : `message:${params.messageId}`;
      const member = createHash('sha256').update(identity).digest('hex');
      const deadlineAtMs = Date.now() + STATE_TIMEOUT_MS;
      const outcome = await raceWithTimeout({
        operation: () =>
          this.redis.claimEventCooldown({
            key,
            memberKey: `${key}:${member}`,
            eventTimestampMs,
            windowSeconds: interval,
            deadlineAtMs,
            memberTimestampToleranceMs: params.mediaGroupId ? 2000 : 0,
          }),
        timeoutMs: STATE_TIMEOUT_MS,
        onTimeout: () => 'deadline_exceeded' as const,
      });
      if (outcome === 'deadline_exceeded') throw new Error('Traffic protection state unavailable');
      if (outcome === 'blocked') return this.violation(params, candidate, interval);
      if (outcome === 'stale') {
        stale = true;
        params.observer?.finish({ kind: 'skip', reason: 'state' });
      } else {
        evaluated = true;
        params.observer?.finish({ kind: 'evaluated', matched: false });
      }
    }
    params.observer?.finish(
      evaluated
        ? { kind: 'evaluated', matched: false }
        : { kind: 'skip', reason: stale ? 'state' : 'content' },
    );
    return null;
  }

  private violation(
    params: Parameters<TrafficProtectionDetector['detect']>[0],
    rule: TrafficProtectionRule,
    interval: number,
  ): RuleViolation | null {
    const occurredAt = params.eventTimestampMs!;
    const deadline = occurredAt + Math.min(interval * 1000, TRAFFIC_PROTECTION_MAX_DELETE_AGE_MS);
    if (Date.now() >= deadline || occurredAt - Date.now() > DUPLICATE_EVENT_MAX_FUTURE_SKEW_MS) {
      params.observer?.finish({ kind: 'skip', reason: 'expired' });
      return null;
    }
    params.observer?.finish({ kind: 'evaluated', matched: true });
    return {
      ruleCode: rule,
      score: 0.85,
      reason:
        rule === 'STICKER_BLOCKED'
          ? 'Stickers are disabled by chat settings'
          : `Minimum ${rule === 'SLOW_MODE' ? 'message' : 'media'} interval is ${interval}s`,
      metadata: {
        trafficPolicyVersion: 1,
        trafficPolicyRevision: params.settings.trafficPolicyRevision,
        trafficEventTimestampMs: occurredAt,
        trafficIntervalSeconds: interval,
        trafficDeadlineAtMs: deadline,
        trafficSourceSha256: fingerprintTrafficSource(params.text, params.media),
        messageDisposition: 'DELETE',
        userSanction: 'NONE',
      },
    };
  }
}
