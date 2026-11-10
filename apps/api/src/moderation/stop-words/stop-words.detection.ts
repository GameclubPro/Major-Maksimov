import type { RuleViolation } from '../rule-engine.contract';
import { createHash } from 'node:crypto';
import type { NavigationTargetEvidence } from '../navigation/navigation-evidence.types';
import { selectMaxMessageCandidate } from '../../max/max-message-candidate.util';
import { extractMaxVisibleContentTextSegments } from '../../max/max-visible-content-text';
import { MessageLimitsBlockedWordDetector } from '../rule-engine-blocked-words.detector';
import { MessageLimitsBlockedDomainDetector } from '../rule-engine-blocked-domains.detector';
import { readStopWordsPolicy } from './stop-words.policy';
import { StopWordsMatcher } from './stop-words.matcher';

const matcher = new StopWordsMatcher();
const legacyWords = new MessageLimitsBlockedWordDetector();
const legacyDomains = new MessageLimitsBlockedDomainDetector();

export function fingerprintStopWordsSource(params: {
  text: string;
  textSegments?: readonly string[];
  navigationTargets?: readonly NavigationTargetEvidence[];
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        text: params.textSegments ?? [params.text],
        targets: [
          ...new Set(
            (params.navigationTargets ?? [])
              .filter((target) => target.enforceable)
              .map((target) => target.normalizedTarget),
          ),
        ].sort(),
      }),
    )
    .digest('hex');
}

export function detectStopWordsViolations(params: {
  text: string;
  settings: { stopWordsPolicy?: unknown; stopWordsRevision?: number };
  textSegments?: readonly string[];
  navigationTargets?: readonly NavigationTargetEvidence[];
  isLinkAllowlisted?: (link: string) => boolean;
}): RuleViolation[] {
  const policy = readStopWordsPolicy(params.settings);
  if (!policy) return [];
  const matches = [
    ...matcher.detect({ ...params, policy: { ...policy, domains: [] }, limit: 1 }),
    ...matcher.detect({ ...params, policy: { ...policy, rules: [] }, limit: 1 }),
  ];
  if (matches.length === 0) return [];
  const sourceSha256 = fingerprintStopWordsSource(params);
  const seen = new Set<string>();
  return matches.flatMap((match): RuleViolation[] => {
    const ruleCode = match.kind === 'DOMAIN' ? 'MESSAGE_BLOCKED_DOMAIN' : 'MESSAGE_BLOCKED_WORD';
    if (seen.has(ruleCode)) return [];
    seen.add(ruleCode);
    return [
      {
        ruleCode,
        score: match.kind === 'DOMAIN' ? 0.9 : 0.89,
        reason: `Stop-list rule matched: ${match.value}`,
        metadata: {
          stopWordsRuleId: match.ruleId,
          stopWordsPolicyVersion: policy.version,
          stopWordsRevision: params.settings.stopWordsRevision ?? 0,
          stopWordsSourceSha256: sourceSha256,
          matchKind: match.matchKind,
          ...(match.kind === 'DOMAIN'
            ? { blockedDomain: match.value, matchedLink: match.fragment }
            : { blockedWord: match.value }),
        },
      },
    ];
  });
}

export function extractStopWordsTextSegments(rawUpdate: unknown, fallback: string): string[] {
  const root = asRecord(rawUpdate);
  if (!root) return [fallback];
  const type = String(root.type ?? root.update_type ?? root.event_type ?? 'unknown');
  const selected = selectMaxMessageCandidate(root, type);
  if (!selected) return [fallback];
  const direct = extractMaxVisibleContentTextSegments(selected.node);
  const link = asRecord(selected.node.link);
  const forward =
    typeof link?.type === 'string' && link.type.trim().toLowerCase() === 'forward'
      ? (asRecord(link.message) ?? asRecord(link.body))
      : undefined;
  // FLAG: Never synthesize a phrase across aliases, a visible forward, or quoted reply content.
  return [
    ...(direct.length ? direct : ['']),
    ...(forward ? extractMaxVisibleContentTextSegments(forward) : []),
  ];
}

export function splitStopWordsSourceParagraphs(params: {
  text: string;
  textSegments?: readonly string[];
}): string[] {
  // FLAG: Legacy morphology/masking stays inside a single visible source and paragraph.
  // The parser's flattened presentation must never join independent content into authority.
  return (params.textSegments ?? [params.text]).flatMap((value) =>
    value.replace(/\r\n|\r|\v|\u2028/gu, '\n').split(/[\f\u2029]|\n[\p{Zs}\t]*\n/u),
  );
}

export function detectLegacyStopWordsViolations(params: {
  text: string;
  textSegments?: readonly string[];
  settings: {
    messageLimitsBlockedWords: readonly string[];
    messageLimitsBlockedDomains: readonly string[];
  };
  isLinkAllowlisted?: (link: string) => boolean;
}): RuleViolation[] {
  const segments = splitStopWordsSourceParagraphs(params);
  let word: ReturnType<typeof legacyWords.detect> = null;
  let domain: ReturnType<typeof legacyDomains.detect> = null;
  for (const text of segments) {
    word ??= legacyWords.detect(text, params.settings.messageLimitsBlockedWords);
    domain ??= legacyDomains.detect(text, params.settings.messageLimitsBlockedDomains, {
      isLinkAllowlisted: params.isLinkAllowlisted,
    });
    if (word && domain) break;
  }
  return [
    ...(word
      ? [
          {
            ruleCode: 'MESSAGE_BLOCKED_WORD',
            score: 0.89,
            reason: `Blocked word detected: ${word.blockedWord}`,
            metadata: { blockedWord: word.blockedWord, matchKind: word.matchKind },
          },
        ]
      : []),
    ...(domain
      ? [
          {
            ruleCode: 'MESSAGE_BLOCKED_DOMAIN',
            score: 0.9,
            reason: `Blocked domain detected: ${domain.blockedDomain}`,
            metadata: {
              blockedDomain: domain.blockedDomain,
              matchedDomain: domain.matchedDomain,
              matchedLink: domain.matchedLink,
            },
          },
        ]
      : []),
  ];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
