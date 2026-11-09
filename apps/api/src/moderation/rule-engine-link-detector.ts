import {
  buildNavigationAllowlistPolicyKeys,
  normalizeNavigationAllowlistTarget,
  parseStoredAllowlistEntry,
  type NavigationAllowlistPolicyKey,
} from '@maxim/contracts/settings';
import { LinkPolicy } from '../prisma/prisma-client';
import { extractUrlsFromText as extractTextUrls } from '../common/url-text.util';
import { isEnforceableLinkPolicyTarget } from './navigation/link-policy-target.util';
import type { NavigationTargetEvidence } from './navigation/navigation-evidence.types';
import type { RuleEvaluationObserver } from './rule-engine-observation';
import {
  evaluateRuntimeLinkRulesPolicy,
  readRuntimeLinkRulesPolicy,
} from './link-rules-policy.runtime';

type AllowlistMatchers = {
  exactLinks: Set<string>;
  domains: Set<string>;
  typedTargets: Set<string>;
};

export type AllowlistLinkMatcher = (value: string) => boolean;
export type NavigationAllowlistMatcher = (value: NavigationTargetEvidence) => boolean;

type ResolvedLink = {
  raw: string;
  match: {
    normalizedLink: string;
    normalizedDomain: string | null;
  };
  allowlisted: boolean;
  explicit: boolean;
};

export function detectBlockedLink(
  text: string,
  policy: LinkPolicy,
  allowlist: readonly string[],
  allowlistMatcher?: AllowlistLinkMatcher,
  navigationTargets?: readonly NavigationTargetEvidence[],
  linkRulesPolicy?: unknown,
  observer?: RuleEvaluationObserver,
): string | null {
  observer?.configured(false);
  const rules = readRuntimeLinkRulesPolicy(linkRulesPolicy);
  if (rules.status !== 'legacy') {
    if (rules.status === 'invalid') {
      observer?.finish({ kind: 'skip', reason: 'state' });
      return null;
    }
    observer?.configured(rules.policy.mode !== 'ALLOW_ALL');
    const targets =
      navigationTargets ??
      extractUrlsFromText(text).map((target) => ({
        kind: 'external_url' as const,
        target,
        normalizedTarget: target,
        enforceable: true,
        origins: [],
      }));
    const result = evaluateRuntimeLinkRulesPolicy(rules.policy, targets, Date.now(), observer);
    return result.allowed
      ? null
      : result.reason === 'DENY_ALL'
        ? 'Links are not allowed by policy'
        : result.reason === 'DENY_RULE'
          ? `Link ${result.target.normalizedTarget} is blocked by a link rule`
          : `Link ${result.target.normalizedTarget} is not allowed by a link rule`;
  }
  if (policy === LinkPolicy.ALERT_ONLY) {
    observer?.finish({ kind: 'skip', reason: 'disabled' });
    return null;
  }

  observer?.configured(true);
  if (navigationTargets) {
    const enforceableTargets = navigationTargets.filter(isEnforceableLinkPolicyTarget);
    if (enforceableTargets.length === 0) {
      observer?.finish({ kind: 'skip', reason: 'content' });
      return null;
    }
    observer?.eligible();
    if (policy === LinkPolicy.BLOCKLIST_ONLY) {
      observer?.finish({ kind: 'evaluated', matched: true });
      return 'Links are not allowed by policy';
    }

    const isAllowlisted = createNavigationAllowlistMatcher(allowlist);
    const blockedTarget = enforceableTargets.find((target) => !isAllowlisted(target));
    observer?.finish({ kind: 'evaluated', matched: Boolean(blockedTarget) });
    return blockedTarget ? `Link ${blockedTarget.normalizedTarget} is not in allowlist` : null;
  }

  const links = extractUrlsFromText(text);

  if (links.length === 0) {
    observer?.finish({ kind: 'skip', reason: 'content' });
    return null;
  }

  observer?.eligible();
  if (policy === LinkPolicy.BLOCKLIST_ONLY) {
    observer?.finish({ kind: 'evaluated', matched: true });
    return 'Links are not allowed by policy';
  }

  const resolvedLinks = resolveDetectedLinks(
    links,
    allowlistMatcher ?? createAllowlistLinkMatcher(allowlist),
  );
  const allowlistedExplicitDomains = new Set(
    resolvedLinks
      .filter((link) => link.allowlisted && link.explicit && link.match.normalizedDomain)
      .map((link) => link.match.normalizedDomain as string),
  );
  const allowlistedExplicitDomainLabels = new Set(
    [...allowlistedExplicitDomains]
      .map((domain) => extractDomainBrandLabel(domain))
      .filter((label): label is string => label !== null),
  );
  for (const link of resolvedLinks) {
    if (link.allowlisted) {
      continue;
    }

    if (
      !link.explicit &&
      link.match.normalizedDomain &&
      (allowlistedExplicitDomains.has(link.match.normalizedDomain) ||
        isBareBrandMentionForAllowedLink(
          link.raw,
          link.match.normalizedDomain,
          allowlistedExplicitDomainLabels,
        ))
    ) {
      continue;
    }

    observer?.finish({ kind: 'evaluated', matched: true });
    return `Link ${link.match.normalizedLink} is not in allowlist`;
  }

  observer?.finish({ kind: 'evaluated', matched: false });
  return null;
}

export function extractUrlsFromText(value: string): string[] {
  return extractTextUrls(value);
}

export function createAllowlistLinkMatcher(allowlist: readonly string[]): AllowlistLinkMatcher {
  const matchers = buildAllowlistMatchers(allowlist);
  return (value: string) => {
    const match = resolveAllowlistMatch(value);
    return match ? isAllowlistedLink(matchers, match) : false;
  };
}

export function createNavigationAllowlistMatcher(
  allowlist: readonly string[],
): NavigationAllowlistMatcher {
  const matchers = buildAllowlistMatchers(allowlist);
  return (value) =>
    buildNavigationTargetAllowlistPolicyKeys(value).some((key) =>
      isAllowlistedNavigationPolicyKey(matchers, key),
    );
}

export function buildNavigationTargetAllowlistPolicyKeys(
  value: NavigationTargetEvidence,
): NavigationAllowlistPolicyKey[] {
  const keys = [
    ...buildNavigationAllowlistPolicyKeys(value.target, value.kind),
    ...(value.allowlistAliases ?? []).flatMap((alias) =>
      buildNavigationAllowlistPolicyKeys(alias.target, alias.kind),
    ),
  ];
  const seen = new Set<string>();
  return keys.filter((key) => {
    const serialized = serializeNavigationPolicyKey(key);
    if (seen.has(serialized)) {
      return false;
    }
    seen.add(serialized);
    return true;
  });
}

function buildAllowlistMatchers(allowlist: readonly string[]): AllowlistMatchers {
  const exactLinks = new Set<string>();
  const domains = new Set<string>();
  const typedTargets = new Set<string>();

  for (const entry of allowlist) {
    const parsed = parseStoredAllowlistEntry(entry);
    if (!parsed) {
      continue;
    }

    typedTargets.add(serializeNavigationPolicyKey(parsed));

    if (parsed.matchType === 'DOMAIN') {
      domains.add(parsed.domain);
      continue;
    }

    exactLinks.add(parsed.domain);
  }

  return { exactLinks, domains, typedTargets };
}

function isAllowlistedNavigationPolicyKey(
  matchers: AllowlistMatchers,
  key: NavigationAllowlistPolicyKey,
): boolean {
  if (matchers.typedTargets.has(serializeNavigationPolicyKey(key))) {
    return true;
  }
  if (key.kind !== 'WEB_DOMAIN') {
    return false;
  }
  return matchesAllowedDomain(matchers.domains, key.target);
}

function serializeNavigationPolicyKey(key: NavigationAllowlistPolicyKey): string {
  return `${key.kind}\0${key.target}`;
}

function resolveDetectedLinks(
  links: readonly string[],
  allowlistMatcher: AllowlistLinkMatcher,
): ResolvedLink[] {
  const resolved: ResolvedLink[] = [];

  for (const raw of links) {
    const match = resolveAllowlistMatch(raw);
    resolved.push({
      raw,
      match: match ?? { normalizedLink: raw, normalizedDomain: null },
      allowlisted: match !== null && allowlistMatcher(raw),
      explicit: isExplicitLink(raw),
    });
  }

  return resolved;
}

function resolveAllowlistMatch(
  value: string,
): { normalizedLink: string; normalizedDomain: string | null } | null {
  const normalizedLink = normalizeNavigationAllowlistTarget(value, 'WEB_EXACT');
  const normalizedDomain = normalizedLink
    ? new URL(normalizedLink).hostname.replace(/\.$/u, '')
    : normalizeNavigationAllowlistTarget(value, 'WEB_DOMAIN');
  if (!normalizedLink && !normalizedDomain) {
    return null;
  }

  return {
    normalizedLink: normalizedLink ?? value,
    normalizedDomain,
  };
}

function isAllowlistedLink(
  matchers: AllowlistMatchers,
  match: { normalizedLink: string; normalizedDomain: string | null },
): boolean {
  if (matchers.exactLinks.has(match.normalizedLink)) {
    return true;
  }

  return Boolean(
    match.normalizedDomain && matchesAllowedDomain(matchers.domains, match.normalizedDomain),
  );
}

function matchesAllowedDomain(domains: ReadonlySet<string>, hostname: string): boolean {
  for (let start = 0; start < hostname.length; ) {
    if (domains.has(hostname.slice(start))) return true;
    const dot = hostname.indexOf('.', start);
    if (dot === -1) break;
    start = dot + 1;
  }
  return false;
}

function isBareBrandMentionForAllowedLink(
  raw: string,
  normalizedDomain: string,
  allowlistedDomainLabels: ReadonlySet<string>,
): boolean {
  if (!/[A-Z]/.test(raw)) {
    return false;
  }

  const brandLabel = extractDomainBrandLabel(normalizedDomain);
  return brandLabel !== null && allowlistedDomainLabels.has(brandLabel);
}

function extractDomainBrandLabel(domain: string): string | null {
  const labels = domain
    .trim()
    .toLowerCase()
    .split('.')
    .filter((label) => label.length > 0);
  if (labels.length < 2) {
    return null;
  }

  return labels[labels.length - 2] ?? null;
}

function isExplicitLink(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) {
    return false;
  }

  if (/^https?:\/\//i.test(normalized)) {
    return true;
  }

  return /[/?#]/.test(normalized);
}
