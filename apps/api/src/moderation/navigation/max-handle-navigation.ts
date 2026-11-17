import type { MaxClientService } from '../../max/max-client.service';
import { isRuntimeLinkPolicyActive } from '../link-rules-policy.runtime';
import {
  extractEnabledNavigationTargets,
  type EnabledNavigationTargetOptions,
} from './enabled-navigation-targets';
import { adaptMaxWebhookNavigationView } from './max-navigation-view.adapter';
import { extractClientClickableTextEvidence } from './client-clickable-text.extractor';
import { extractNavigationEvidence } from './navigation-evidence.extractor';
import type { MaxNavigationMessageView, PlainTextLinkCandidate } from './navigation-evidence.types';

type HandleClient = Pick<MaxClientService, 'resolvePublicChannelHandle'>;

const HANDLE = /^[a-z0-9_][a-z0-9_-]{0,63}$/iu;
const NON_CLICKABLE = new Set(['code', 'pre', 'monospaced']);
const LOOKUP_LIMIT = 4;
const LOOKUP_BUDGET_MS = 2_000;

export async function resolveEnabledWebhookNavigationTargets(
  raw: unknown,
  options: EnabledNavigationTargetOptions,
  client: HandleClient,
  settings: { linkPolicy: string; linkRulesPolicy?: unknown },
) {
  if (!raw) return undefined;
  return resolveEnabledNavigationTargets(
    adaptMaxWebhookNavigationView(raw),
    options,
    client,
    isRuntimeLinkPolicyActive(settings.linkPolicy, settings.linkRulesPolicy),
  );
}

export async function resolveEnabledNavigationTargets(
  view: MaxNavigationMessageView,
  options: EnabledNavigationTargetOptions,
  client: HandleClient,
  enabled = true,
) {
  const targets = extractEnabledNavigationTargets(view, options);
  if (!enabled) return targets;
  const candidates = collectHandleCandidates(view, options);
  const confirmed = new Set<string>();
  const deadline = Date.now() + LOOKUP_BUDGET_MS;
  for (const target of [...new Set(candidates.map((candidate) => candidate.target))].slice(
    0,
    LOOKUP_LIMIT,
  )) {
    const remaining = deadline - Date.now();
    if (remaining < 2) break;
    try {
      const proof = await client.resolvePublicChannelHandle(target, Math.min(800, remaining));
      // FLAG: A name can resolve to a person. Only typed public-channel evidence for
      // this exact canonical URL grants link authority; final DELETE resolves again.
      if (proof?.url === target) confirmed.add(target);
    } catch {
      // FLAG: Missing/denied/failed resolution is uncertainty, never link-delete authority.
    }
  }
  const resolved = extractNavigationEvidence(view, {
    plainTextCandidates: candidates.filter((candidate) => confirmed.has(candidate.target)),
  }).targets.filter((target) => target.origins.some((origin) => origin.carrier === 'plain_text'));
  return [...targets, ...resolved];
}

function collectHandleCandidates(
  view: MaxNavigationMessageView,
  options: EnabledNavigationTargetOptions,
): PlainTextLinkCandidate[] {
  const candidates: PlainTextLinkCandidate[] = [];
  const urls = extractClientClickableTextEvidence(view);
  for (const content of [
    view.direct,
    options.forwardedTargetsEnabled ? view.visibleForward : null,
  ]) {
    if (!content) continue;
    const excluded: Array<{ from: number; end: number }> = urls
      .filter((url) => url.provenance === content.provenance)
      .map((url) => ({ from: url.from, end: url.from + url.length }));
    const named: PlainTextLinkCandidate[] = [];
    const protectedRanges: Array<{ from: number; end: number }> = [];
    let ambiguousRange = false;
    for (const markup of content.markup) {
      if (
        !markup.type ||
        (!NON_CLICKABLE.has(markup.type) && !['link', 'user_mention'].includes(markup.type))
      )
        continue;
      const from = readOffset(markup.from);
      const length = readOffset(markup.length);
      if (
        markup.from == null ||
        markup.length == null ||
        !Number.isSafeInteger(from) ||
        !Number.isSafeInteger(length) ||
        from < 0 ||
        length <= 0 ||
        from + length > content.text.length
      ) {
        ambiguousRange = true;
        continue;
      }
      excluded.push({ from, end: from + length });
      if (
        NON_CLICKABLE.has(markup.type) ||
        markup.type === 'link' ||
        (markup.type === 'user_mention' && (markup.userId != null || !markup.userLink))
      ) {
        protectedRanges.push({ from, end: from + length });
      }
      // FLAG: ID-bound and targetless user mentions stay exempt regardless of their label.
      if (
        markup.type !== 'user_mention' ||
        markup.userId != null ||
        !options.structuredTargetsEnabled ||
        typeof markup.userLink !== 'string'
      )
        continue;
      const handle = markup.userLink.replace(/^@/u, '');
      if (HANDLE.test(handle))
        named.push({
          provenance: content.provenance,
          target: `https://max.ru/${handle.toLowerCase()}`,
          from,
          length,
          sourcePath: markup.path,
        });
    }
    if (ambiguousRange) continue;
    candidates.push(
      ...named.filter(
        (candidate) =>
          !protectedRanges.some(
            (range) => candidate.from < range.end && candidate.from + candidate.length > range.from,
          ),
      ),
    );
    if (!options.textClickabilityEnabled) continue;
    const pattern =
      /(?<![\p{L}\p{N}\p{Cf}_@./+%:-])@([a-z0-9_][a-z0-9_-]{0,63})(?![\p{L}\p{N}\p{Cf}_@-]|\.[\p{L}\p{N}_])/giu;
    for (const match of content.text.matchAll(pattern)) {
      const from = match.index;
      const end = from + match[0].length;
      if (excluded.some((range) => from < range.end && end > range.from)) continue;
      candidates.push({
        provenance: content.provenance,
        target: `https://max.ru/${match[1]!.toLowerCase()}`,
        from,
        length: end - from,
        sourcePath: `${content.path}.text`,
      });
    }
  }
  return candidates;
}

function readOffset(value: unknown): number {
  return typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')
    ? Number(value)
    : Number.NaN;
}
