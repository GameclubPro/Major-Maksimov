import { createHash } from 'node:crypto';

import type {
  MaxNavigationMessageView,
  NavigationTargetEvidence,
} from './navigation/navigation-evidence.types';
import { isEnforceableLinkPolicyTarget } from './navigation/link-policy-target.util';
import {
  evaluateRuntimeLinkRulesPolicy,
  latestExpiredLinkRuleAllowance,
  readRuntimeLinkRulesPolicy,
} from './link-rules-policy.runtime';
import { createNavigationAllowlistMatcher } from './rule-engine-link-detector';

const MIN_UNIX_MILLISECONDS = 100_000_000_000;

export const LINK_HISTORY_RECOVERY_RULE_CODE = 'LINK_HISTORY_RECOVERY';
export const LINK_BLOCKED_DELETE_RULE_CODE = 'LINK_BLOCKED_DELETE';
export const LINK_HISTORY_RECOVERY_SOURCE_TAG = 'link_history_recovery';

// FLAG: Include the complete durable reason set, so a rejection cannot self-retry
// on unchanged reasons but never consumes a concurrently added independent reason.
export function fingerprintLinkDeleteReasons(
  reasons: readonly { ruleCode: string; reasonKey: string; score?: unknown; metadata: unknown }[],
): string {
  return createHash('sha256')
    .update(
      JSON.stringify(
        reasons
          .map(({ ruleCode, reasonKey, score, metadata }) => ({
            ruleCode,
            reasonKey,
            score,
            metadata,
          }))
          .sort((a, b) => a.reasonKey.localeCompare(b.reasonKey)),
      ),
    )
    .digest('hex');
}

export type LinkHistoryListedMessageMetadata = {
  messageId: string;
  senderId: string | null;
  timestampMs: number;
};

export function parseLinkHistoryListedMessage(
  message: Record<string, unknown>,
): LinkHistoryListedMessageMetadata | null {
  const body = asRecord(message.body);
  const sender = asRecord(message.sender);
  const from = asRecord(message.from);
  const messageId = readScalar(
    body?.mid ??
      body?.seq ??
      body?.message_id ??
      body?.messageId ??
      message.message_id ??
      message.messageId ??
      message.mid ??
      message.seq ??
      message.id,
  );
  const timestampMs = readUnixMilliseconds(
    message.timestamp ?? message.created_at ?? message.createdAt,
  );
  if (!messageId || timestampMs === null) {
    return null;
  }
  return {
    messageId,
    timestampMs,
    senderId: readScalar(
      message.sender_id ??
        message.senderId ??
        sender?.user_id ??
        sender?.userId ??
        sender?.id ??
        from?.user_id ??
        from?.userId ??
        from?.id,
    ),
  };
}

export function createMessageContentFingerprint(view: MaxNavigationMessageView): string {
  return createHash('sha256')
    .update('max-moderatable-message:v1\0')
    .update(view.direct?.contentFingerprint ?? '')
    .update('\0')
    .update(view.visibleForward?.contentFingerprint ?? '')
    .digest('hex');
}

export function filterActionableNavigationTargets(
  targets: readonly NavigationTargetEvidence[],
): NavigationTargetEvidence[] {
  return targets.filter(isActionableNavigationTarget);
}

export function hasActionableNavigationTargets(
  targets: readonly NavigationTargetEvidence[],
): boolean {
  return targets.some(isActionableNavigationTarget);
}

export function isLinkHistoryPolicyViolation(
  policy: 'ALLOWLIST_ONLY' | 'BLOCKLIST_ONLY' | 'ALERT_ONLY',
  allowlist: readonly string[],
  targets: readonly NavigationTargetEvidence[],
  linkRulesPolicy?: unknown,
): boolean {
  const current = readRuntimeLinkRulesPolicy(linkRulesPolicy);
  if (current.status !== 'legacy')
    return (
      current.status === 'valid' && !evaluateRuntimeLinkRulesPolicy(current.policy, targets).allowed
    );
  if (targets.length === 0 || policy === 'ALERT_ONLY') {
    return false;
  }
  if (policy === 'BLOCKLIST_ONLY') {
    return true;
  }
  const isAllowlisted = createNavigationAllowlistMatcher(allowlist);
  return targets.some((target) => !isAllowlisted(target));
}

export function deriveLinkPolicySemanticEffectiveAt(
  policy: 'ALLOWLIST_ONLY' | 'BLOCKLIST_ONLY' | 'ALERT_ONLY',
  storedEffectiveAt: Date | null,
  latestExpiredAllowlistAt: Date | null,
  linkRulesPolicy?: unknown,
  nowMs = Date.now(),
): Date | null {
  const current = readRuntimeLinkRulesPolicy(linkRulesPolicy);
  if (current.status === 'invalid') return null;
  if (current.status === 'valid') {
    const latest = latestExpiredLinkRuleAllowance(current.policy, nowMs);
    return storedEffectiveAt && latest && latest > storedEffectiveAt ? latest : storedEffectiveAt;
  }
  if (policy !== 'ALLOWLIST_ONLY' || !storedEffectiveAt || !latestExpiredAllowlistAt) {
    return storedEffectiveAt;
  }
  return latestExpiredAllowlistAt.getTime() > storedEffectiveAt.getTime()
    ? latestExpiredAllowlistAt
    : storedEffectiveAt;
}

function isActionableNavigationTarget(target: NavigationTargetEvidence): boolean {
  return isEnforceableLinkPolicyTarget(target);
}

function readUnixMilliseconds(value: unknown): number | null {
  const parsed =
    value instanceof Date
      ? value.getTime()
      : typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim().length > 0
          ? /^\d+$/u.test(value.trim())
            ? Number(value)
            : Date.parse(value)
          : Number.NaN;
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < MIN_UNIX_MILLISECONDS ||
    parsed > Date.now() + 24 * 60 * 60_000
  ) {
    return null;
  }
  return parsed;
}

function readScalar(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
