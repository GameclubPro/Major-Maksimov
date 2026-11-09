import { normalizeMessageLimitsBlockedDomainCandidate } from '@maxim/contracts/settings';
import { extractUrlsFromText } from '../common/url-text.util';
import type { RuleEvaluationObserver } from './rule-engine-observation';

export type BlockedDomainDetection = {
  blockedDomain: string;
  matchedDomain: string;
  matchedLink: string;
};

type ResolvedBlockedDomainIndex = {
  domains: readonly string[];
};

const BLOCKED_DOMAIN_LIST_CACHE_MAX_ENTRIES = 512;

export class MessageLimitsBlockedDomainDetector {
  private readonly blockedDomainListCache = new Map<string, ResolvedBlockedDomainIndex>();

  detect(
    text: string,
    blockedDomains: readonly string[],
    options: {
      isLinkAllowlisted?: (link: string) => boolean;
      observer?: RuleEvaluationObserver;
    } = {},
  ): BlockedDomainDetection | null {
    return this.detectMatches(text, blockedDomains, options, true)[0] ?? null;
  }

  detectAll(
    text: string,
    blockedDomains: readonly string[],
    options: { isLinkAllowlisted?: (link: string) => boolean } = {},
  ): BlockedDomainDetection[] {
    return this.detectMatches(text, blockedDomains, options, false);
  }

  private detectMatches(
    text: string,
    blockedDomains: readonly string[],
    options: { isLinkAllowlisted?: (link: string) => boolean; observer?: RuleEvaluationObserver },
    stopAfterFirst: boolean,
  ): BlockedDomainDetection[] {
    const observer = options.observer;
    observer?.configured(Array.isArray(blockedDomains) && blockedDomains.length > 0);
    if (!text || !Array.isArray(blockedDomains) || blockedDomains.length === 0) {
      observer?.finish({ kind: 'skip', reason: blockedDomains?.length ? 'content' : 'disabled' });
      return [];
    }

    const blockedDomainIndex = this.resolveMessageLimitsBlockedDomainList(blockedDomains);
    if (blockedDomainIndex.domains.length === 0) {
      observer?.finish({ kind: 'skip', reason: 'state' });
      return [];
    }

    const links = extractUrlsFromText(text);
    if (links.length === 0) {
      observer?.finish({ kind: 'skip', reason: 'content' });
      return [];
    }

    observer?.eligible();
    const detections: BlockedDomainDetection[] = [];
    const detectedDomains = new Set<string>();
    for (const link of links) {
      const matchedDomain = normalizeMessageLimitsBlockedDomainCandidate(link);
      if (!matchedDomain) {
        continue;
      }

      const blockedDomainMatches = this.findBlockedDomainMatches(
        matchedDomain,
        blockedDomainIndex.domains,
      );
      if (blockedDomainMatches.length === 0 || options.isLinkAllowlisted?.(link)) {
        continue;
      }
      for (const blockedDomain of blockedDomainMatches) {
        if (detectedDomains.has(blockedDomain)) {
          continue;
        }
        detectedDomains.add(blockedDomain);
        detections.push({
          blockedDomain,
          matchedDomain,
          matchedLink: link,
        });
        if (stopAfterFirst) {
          observer?.finish({ kind: 'evaluated', matched: true });
          return detections;
        }
      }
    }

    observer?.finish({ kind: 'evaluated', matched: detections.length > 0 });
    return detections;
  }

  private resolveMessageLimitsBlockedDomainList(
    blockedDomains: readonly string[],
  ): ResolvedBlockedDomainIndex {
    const cacheKey = this.buildBlockedDomainListCacheKey(blockedDomains);
    const cached = this.blockedDomainListCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const domains = [
      ...new Set(
        blockedDomains
          .map((item) => normalizeMessageLimitsBlockedDomainCandidate(item))
          .filter((item): item is string => Boolean(item)),
      ),
    ].sort((left, right) => right.length - left.length);
    const resolved = { domains };

    this.blockedDomainListCache.set(cacheKey, resolved);
    if (this.blockedDomainListCache.size > BLOCKED_DOMAIN_LIST_CACHE_MAX_ENTRIES) {
      const oldestKey = this.blockedDomainListCache.keys().next().value;
      if (typeof oldestKey === 'string') {
        this.blockedDomainListCache.delete(oldestKey);
      }
    }

    return resolved;
  }

  private findBlockedDomainMatches(
    matchedDomain: string,
    blockedDomains: readonly string[],
  ): string[] {
    return blockedDomains.filter(
      (blockedDomain) =>
        matchedDomain === blockedDomain || matchedDomain.endsWith(`.${blockedDomain}`),
    );
  }

  private buildBlockedDomainListCacheKey(blockedDomains: readonly string[]): string {
    return blockedDomains.join('\u001f');
  }
}
