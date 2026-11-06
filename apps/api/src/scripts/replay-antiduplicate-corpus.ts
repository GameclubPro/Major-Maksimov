import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { open, unlink } from 'node:fs/promises';
import Redis from 'ioredis';
import {
  antiduplicateCorpusManifestSchema,
  antiduplicateCorpusEventSchema,
  antiduplicateCorpusLabelSchema,
  antiduplicateCorpusEndSchema,
  assertDistinctCorpusPaths,
  assertLocalReplayUrl,
  hashCorpusFile,
  normalizeCorpusSettings,
  readCorpusLines,
  wilsonInterval,
  writePrivateJson,
  type AntiduplicateCorpusEvent,
  type AntiduplicateCorpusManifest,
  type AntiduplicateCorpusLabel,
} from './antiduplicate-corpus';
import {
  MessageDuplicateHistoryService,
  type MessageDuplicateHistoryObservation,
} from '../moderation/message-duplicate/message-duplicate-history.service';
import {
  MESSAGE_DUPLICATE_WINDOW_SCRIPT,
  type DuplicateWindowResult,
} from '../moderation/message-duplicate/message-duplicate-window.script';
import {
  extractDuplicateMessageContent,
  digestDuplicateContent,
  isExactImageContent,
  isDuplicateContentComparable,
} from '../moderation/message-duplicate/message-duplicate-content';
import { duplicateSourceDigest } from '../moderation/message-duplicate/message-duplicate-history.service';
import { MESSAGE_DUPLICATE_MEDIA_VERSION } from '../moderation/message-duplicate/message-duplicate-state';
import { WebhookParser } from '../webhook/webhook.parser';
import { duplicatePublicationTime } from '../moderation/message-duplicate/message-duplicate-publication-time';
import { isDuplicateScheduleOpen } from '../moderation/message-duplicate/message-duplicate-schedule';
import { classifyDuplicateEventTime } from '../moderation/duplicate-enforcement-safety';
import { resolveDuplicateFlowConfig } from '../moderation/duplicate-flow-policy';
import { PHOTO_FINGERPRINT_ALGORITHM_VERSION } from '../moderation/photo-duplicate/photo-fingerprint-version';
import type { RedisCounterService } from '../moderation/redis-counter.service';

const REPLAY_CANDIDATE_BRANCH =
  'elseif original.member ~= p.member and publishedAt >= original.publishedAtMs and p.at < original.expiresAtMs then';
// FLAG: The reviewed addition pins tolerant observations to a live original before writes;
// exact observation, qualification and offline candidate instrumentation stay in place.
const REVIEWED_WINDOW_SHA256 = '26babfb8fd835b1cfc2a3c3ea65c7e93c04a0e67b1fe1b3cec44089a4b7faa32';
export function buildOfflineDuplicateScript(source = MESSAGE_DUPLICATE_WINDOW_SCRIPT): string {
  if (
    createHash('sha256').update(source).digest('hex') !== REVIEWED_WINDOW_SHA256 ||
    source.split(REPLAY_CANDIDATE_BRANCH).length !== 2
  )
    throw new Error('Production window source changed; offline instrumentation requires review');
  // FLAG: Clock/TTL instrumentation exists only in this no-MAX CLI and a random private
  // namespace. It preserves the production comparison/window decisions, including allowance.
  const instrumented = source
    .replaceAll('redis.call(', 'replayRedis(')
    .replace(
      REPLAY_CANDIDATE_BRANCH,
      `${REPLAY_CANDIDATE_BRANCH}\n    replayRedis('RPUSH', KEYS[1] .. 'offline:candidates', cjson.encode({ fingerprint = fingerprint, original = original }))`,
    );
  return `
local replayInput = cjson.decode(ARGV[1])
local replayNow = tonumber(replayInput.replayNowMs)
if not replayNow or replayNow <= 0 then return redis.error_reply('Invalid replay clock') end
if not string.match(KEYS[1], '^offline%-antiduplicate:[a-f0-9%-]+:[a-f0-9]+:$') then
  return redis.error_reply('Invalid private replay namespace')
end
local expiryKey = KEYS[1] .. 'offline:expiry'
local due = redis.call('ZRANGEBYSCORE', expiryKey, '-inf', replayNow, 'LIMIT', 0, 256)
for _, key in ipairs(due) do
  if string.sub(key, 1, string.len(KEYS[1])) ~= KEYS[1] then
    return redis.error_reply('Replay expiry key escaped private namespace')
  end
  redis.call('DEL', key); redis.call('ZREM', expiryKey, key)
end
local function replayRedis(command, ...)
  local args = {...}
  if command == 'TIME' then return { tostring(math.floor(replayNow / 1000)), tostring((replayNow % 1000) * 1000) } end
  if type(args[1]) ~= 'string' or string.sub(args[1], 1, string.len(KEYS[1])) ~= KEYS[1] then
    return redis.error_reply('Replay key escaped private namespace')
  end
  if command == 'GET' or command == 'PEXPIRETIME' then
    local expires = tonumber(redis.call('ZSCORE', expiryKey, args[1]))
    if expires and expires <= replayNow then
      redis.call('DEL', args[1]); redis.call('ZREM', expiryKey, args[1]); return command == 'PEXPIRETIME' and -2 or false
    end
    if command == 'PEXPIRETIME' then return expires or -2 end
  end
  if command == 'SET' and (args[3] == 'EX' or args[3] == 'PXAT') then
    local result = redis.call('SET', args[1], args[2])
    local expiresAt = args[3] == 'PXAT' and tonumber(args[4]) or (replayNow + tonumber(args[4]) * 1000)
    redis.call('ZADD', expiryKey, tostring(expiresAt), args[1])
    return result
  end
  if command ~= 'GET' and command ~= 'RPUSH' then return redis.error_reply('Unsupported replay command') end
  return redis.call(command, unpack(args))
end
${instrumented}`;
}

type Candidate = { fingerprint: string; original: { messageId: string; senderId: string } };
export class OfflineDuplicateWindow {
  private readonly namespace = `offline-antiduplicate:${randomUUID()}:`;
  now = 0;
  candidates: Candidate[] = [];
  lastMutationKind: DuplicateWindowResult['kind'] | undefined;
  constructor(
    private readonly redis: Redis,
    private readonly script = buildOfflineDuplicateScript(),
  ) {}
  async duplicateWindow(
    chatId: string,
    input: Record<string, unknown>,
  ): Promise<DuplicateWindowResult> {
    const prefix = `${this.namespace}${digestDuplicateContent(chatId)}:`;
    if (input.op === 'observe') await this.redis.del(`${prefix}offline:candidates`);
    const result = JSON.parse(
      String(
        await this.redis.eval(
          this.script,
          1,
          prefix,
          JSON.stringify({ ...input, replayNowMs: this.now, deadline: this.now + 250 }),
        ),
      ),
    );
    if (input.op === 'observe') {
      this.lastMutationKind = result.kind;
      this.candidates = (await this.redis.lrange(`${prefix}offline:candidates`, 0, 15)).map((x) =>
        JSON.parse(x),
      );
    }
    return result;
  }
  async close() {
    let cursor = '0';
    do {
      const scan = await this.redis.scan(cursor, 'MATCH', `${this.namespace}*`, 'COUNT', 256);
      cursor = scan[0];
      if (scan[1].length) await this.redis.unlink(...scan[1]);
    } while (cursor !== '0');
  }
}

type Confusion = { tp: number; fp: number; fn: number; tn: number };
const emptyConfusion = (): Confusion => ({ tp: 0, fp: 0, fn: 0, tn: 0 });
function classify(counter: Confusion, predicted: boolean, expected: boolean) {
  ++counter[predicted ? (expected ? 'tp' : 'fp') : expected ? 'fn' : 'tn'];
}
function presentConfusion(x: Confusion) {
  return {
    ...x,
    precision: wilsonInterval(x.tp, x.tp + x.fp),
    recall: wilsonInterval(x.tp, x.tp + x.fn),
  };
}

export async function replayAntiduplicateCorpus(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      input: { type: 'string' },
      labels: { type: 'string' },
      output: { type: 'string' },
      summary: { type: 'string' },
    },
  });
  if (!values.input || !values.output || !values.summary)
    throw new Error(
      'Usage: --input <private-corpus.jsonl> [--labels <reviewed.jsonl>] --output <private-decisions.jsonl> --summary <private-summary.json>',
    );
  const redisUrl = process.env.MAXIM_TEST_REDIS_URL;
  if (!redisUrl) throw new Error('Offline replay requires disposable MAXIM_TEST_REDIS_URL');
  assertLocalReplayUrl(redisUrl, 'redis');
  const [input, output, summaryPath, labelsPath] = await assertDistinctCorpusPaths([
    { path: values.input, existing: true },
    { path: values.output, existing: false },
    { path: values.summary, existing: false },
    ...(values.labels ? [{ path: values.labels, existing: true }] : []),
  ]);
  if (!input || !output || !summaryPath) throw new Error('Missing corpus paths');
  const corpusSha256 = await hashCorpusFile(input);
  const labels = new Map<string, AntiduplicateCorpusLabel>();
  const labelsSha256 = labelsPath ? await hashCorpusFile(labelsPath) : null;
  if (labelsPath) {
    for await (const raw of readCorpusLines(labelsPath)) {
      const label = antiduplicateCorpusLabelSchema.parse(raw);
      if (label.corpusSha256 !== corpusSha256 || labels.has(label.id))
        throw new Error('Labels must bind this exact frozen corpus without repeated IDs');
      labels.set(label.id, label);
      if (labels.size > 500_000) throw new Error('Label budget exceeded');
    }
    if ((await hashCorpusFile(labelsPath)) !== labelsSha256)
      throw new Error('Frozen labels changed while reading');
  }
  const script = buildOfflineDuplicateScript();
  const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 0,
    connectTimeout: 5000,
    commandTimeout: 5000,
  });
  const window = new OfflineDuplicateWindow(redis, script);
  const history = new MessageDuplicateHistoryService(window as unknown as RedisCounterService);
  let manifest: AntiduplicateCorpusManifest | undefined;
  let end: ReturnType<typeof antiduplicateCorpusEndSchema.parse> | undefined;
  let created = false;
  let complete = false;
  let file: Awaited<ReturnType<typeof open>> | undefined;
  const seen = new Set<string>();
  const outcomes: Record<string, number> = {};
  const kinds: Record<string, number> = {};
  const scores = {
    DEVELOPMENT: { content: emptyConfusion(), action: emptyConfusion(), humanLabels: 0 },
    HOLDOUT: { content: emptyConfusion(), action: emptyConfusion(), humanLabels: 0 },
  };
  const byKind = new Map<string, { content: Confusion; action: Confusion; labels: number }>();
  const expectedHoldoutGroups = new Set<string>();
  const holdoutGroupEvents = new Map<string, number>();
  const holdoutPolicyStrata = new Map<string, { events: number; humanLabels: number }>();
  const policyStratum = (settings: ReturnType<typeof normalizeCorpusSettings>) =>
    [
      settings.duplicateCompareMode,
      settings.duplicateDetectionPreset,
      settings.duplicatePhotoScope,
      settings.duplicateWindowMode,
    ].join(':');
  let events = 0;
  let evaluationEvents = 0;
  let mediaUnverified = 0;
  let labeledEvents = 0;
  let confirmedHistoricalDeletes = 0;
  let unscorableHumanLabels = 0;
  try {
    file = await open(output, 'wx', 0o600);
    created = true;
    for await (const raw of readCorpusLines(input)) {
      if (!manifest) {
        manifest = antiduplicateCorpusManifestSchema.parse(raw);
        for (const setting of Object.values(manifest.settings))
          holdoutPolicyStrata.set(policyStratum(normalizeCorpusSettings(setting)), {
            events: 0,
            humanLabels: 0,
          });
        continue;
      }
      if (end) throw new Error('Corpus contains data after its completion sentinel');
      if ((raw as Record<string, unknown>).type === 'END') {
        end = antiduplicateCorpusEndSchema.parse(raw);
        continue;
      }
      const event: AntiduplicateCorpusEvent = antiduplicateCorpusEventSchema.parse(raw);
      if (++events > 2_000_000 || seen.has(event.id))
        throw new Error('Corpus event budget or unique identity violated');
      seen.add(event.id);
      const setting = manifest.settings[event.chatId];
      if (!setting) throw new Error('Corpus event has no frozen chat settings');
      const settings = normalizeCorpusSettings(setting);
      const eventAt = Date.parse(event.eventAt);
      const receivedAt = Date.parse(event.receivedAt);
      if (receivedAt < window.now)
        throw new Error('Corpus must preserve nondecreasing receipt order');
      window.now = receivedAt;
      if (
        eventAt < Date.parse(manifest.warmupFrom) ||
        eventAt >= Date.parse(manifest.until) ||
        receivedAt < Date.parse(manifest.warmupFrom) ||
        receivedAt >= Date.parse(manifest.until)
      )
        throw new Error('Corpus event is outside its frozen interval');
      const update = new WebhookParser().parse(event.raw);
      if (
        !update.message ||
        update.type !== event.eventType ||
        update.eventTimestampSource !== 'payload' ||
        update.message.chatId !== event.chatId ||
        update.message.messageId !== event.messageId ||
        (event.userId !== null && update.message.senderId !== event.userId) ||
        Date.parse(update.message.createdAt) !== eventAt
      )
        throw new Error('Corpus raw and frozen event identities disagree');
      const actualPublication = duplicatePublicationTime(update);
      if (
        (actualPublication ? new Date(actualPublication).toISOString() : null) !== event.publishedAt
      )
        throw new Error('Corpus publication proof disagrees with its raw source');
      if (event.eventType === 'message_removed') {
        await history.remove(event.chatId, event.messageId);
        await file.write(
          `${JSON.stringify({
            id: event.id,
            partition:
              receivedAt < Date.parse(manifest.from)
                ? 'WARMUP'
                : receivedAt < Date.parse(manifest.holdoutFrom)
                  ? 'DEVELOPMENT'
                  : 'HOLDOUT',
            outcome: 'LIFECYCLE_REMOVED',
            scorable: false,
            predictedDuplicate: null,
            predictedAction: null,
          })}\n`,
        );
        continue;
      }
      const content = extractDuplicateMessageContent(event.raw);
      if (event.eventType === 'message_edited')
        await history.observeLifecycle({
          chatId: event.chatId,
          messageId: event.messageId,
          eventTimestampMs: eventAt,
          ...(event.publishedAt ? { publishedAtMs: Date.parse(event.publishedAt) } : {}),
          content,
        });
      const image = content.media.some((item) => item.kind === 'photo');
      const mediaMode = image ? 'IMAGE' : 'MESSAGE';
      const proofValid =
        event.mediaProof?.sourceDigest === duplicateSourceDigest(content, mediaMode) &&
        event.mediaProof.hashes.length === content.media.length &&
        event.mediaProof.algorithmVersion ===
          (image ? PHOTO_FINGERPRINT_ALGORITHM_VERSION : MESSAGE_DUPLICATE_MEDIA_VERSION);
      const mediaComparable =
        content.media.length > 0 &&
        isDuplicateContentComparable(content, mediaMode) &&
        (image ? isExactImageContent(content) : true);
      const publicationKnown = event.publishedAt !== null;
      const comparison = {
        content,
        chatId: event.chatId,
        userId: event.userId!,
        messageId: event.messageId,
        eventTimestampMs: eventAt,
        ...(event.publishedAt ? { publishedAtMs: Date.parse(event.publishedAt) } : {}),
        controlRevision: 1,
        settings,
      };
      window.candidates = [];
      window.lastMutationKind = undefined;
      const scheduleOpen = isDuplicateScheduleOpen(settings, eventAt, receivedAt);
      const eventTimeRejected =
        (actualPublication !== undefined && actualPublication > eventAt + 60_000) ||
        classifyDuplicateEventTime({
          eventTimestampMs: eventAt,
          nowMs: receivedAt,
          windowSec:
            settings.duplicateWindowMode === 'DAILY'
              ? 172800
              : resolveDuplicateFlowConfig(settings).windowSec,
        }) !== null;
      let mode: 'TEXT' | 'MESSAGE' | 'IMAGE' = 'TEXT';
      let comparable = isDuplicateContentComparable(content, 'TEXT');
      let observation: MessageDuplicateHistoryObservation = {
        outcome: 'CONTENT_UNVERIFIED',
        match: null,
      };
      const candidates: Candidate[] = [];
      if (publicationKnown && scheduleOpen && !eventTimeRejected) {
        // FLAG: Replay the current text-first policy, independent of the captured selector.
        // Missing optional media proof cannot invalidate an independently proved text repeat.
        observation = await history.observeWithOutcome({ ...comparison, comparison: 'TEXT' });
        candidates.push(...window.candidates);
        if (!observation.match && mediaComparable) {
          mode = mediaMode;
          comparable = true;
          observation = await history.observeWithOutcome({
            ...comparison,
            comparison: 'MESSAGE',
            ...(proofValid ? { mediaHashes: event.mediaProof!.hashes } : {}),
            ...(image ? { imageScope: settings.duplicatePhotoScope } : {}),
          });
          candidates.push(...window.candidates);
        }
      }
      const unsupportedProof = mode !== 'TEXT' && !proofValid;
      const actionCandidate =
        !unsupportedProof &&
        settings.antiDuplicateEnabled &&
        scheduleOpen &&
        !eventTimeRejected &&
        Boolean(observation.match) &&
        receivedAt < observation.match!.binding.original!.expiresAtMs;
      const qualified =
        actionCandidate && (await history.stillMatches(event.chatId, observation.match!.binding))
          ? await history.qualify(event.chatId, observation.match!.binding)
          : null;
      const predictedAction = actionCandidate && qualified !== null;
      const partition =
        receivedAt < Date.parse(manifest.from)
          ? 'WARMUP'
          : receivedAt < Date.parse(manifest.holdoutFrom)
            ? 'DEVELOPMENT'
            : 'HOLDOUT';
      // FLAG: Coverage cohorts describe input content, independently of matcher predictions.
      const kind = image ? 'image' : content.media.length ? 'other_media' : 'text';
      const cohortMode = content.media.length ? mediaMode : 'TEXT';
      const predictedDuplicate = candidates.length > 0 || Boolean(observation.match);
      const outcome = !scheduleOpen
        ? 'SCHEDULE_CLOSED'
        : eventTimeRejected
          ? 'EVENT_TIME_REJECTED'
          : !publicationKnown
            ? 'PUBLICATION_TIME_UNKNOWN'
            : !comparable
              ? 'UNSUPPORTED_CONTENT'
              : window.lastMutationKind === 'replayed'
                ? 'TRANSPORT_REPLAY'
                : unsupportedProof
                  ? 'MEDIA_PROOF_UNAVAILABLE'
                  : observation.outcome;
      const scorable =
        scheduleOpen &&
        !eventTimeRejected &&
        comparable &&
        publicationKnown &&
        !unsupportedProof &&
        window.lastMutationKind !== 'replayed' &&
        ['COMPARED_NO_MATCH', 'MATCHED'].includes(observation.outcome);
      const stratum = policyStratum(settings);
      const groupKey = `${partition}:${stratum}:${cohortMode}:${kind}`;
      if (partition === 'HOLDOUT') {
        expectedHoldoutGroups.add(groupKey);
        holdoutGroupEvents.set(groupKey, (holdoutGroupEvents.get(groupKey) ?? 0) + 1);
        ++holdoutPolicyStrata.get(stratum)!.events;
      }
      if (partition !== 'WARMUP') {
        ++evaluationEvents;
        outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
        kinds[kind] = (kinds[kind] ?? 0) + 1;
        if (unsupportedProof) ++mediaUnverified;
        if (event.historicalAction === 'DELETE_CONFIRMED') ++confirmedHistoricalDeletes;
        const label = labels.get(event.id);
        if (label) ++labeledEvents;
        // FLAG: Agent labels are exploratory. Missing labels, unavailable media or incomplete
        // provenance must never become passing human precision/recall or historical authority.
        if (label?.reviewerKind === 'HUMAN' && !scorable) ++unscorableHumanLabels;
        if (label?.reviewerKind === 'HUMAN' && scorable) {
          ++scores[partition].humanLabels;
          classify(scores[partition].content, predictedDuplicate, label.duplicate);
          classify(scores[partition].action, predictedAction, label.actionAllowed);
          const group = byKind.get(groupKey) ?? {
            content: emptyConfusion(),
            action: emptyConfusion(),
            labels: 0,
          };
          ++group.labels;
          classify(group.content, predictedDuplicate, label.duplicate);
          classify(group.action, predictedAction, label.actionAllowed);
          byKind.set(groupKey, group);
          if (partition === 'HOLDOUT') ++holdoutPolicyStrata.get(stratum)!.humanLabels;
        }
      }
      await file.write(
        `${JSON.stringify({
          id: event.id,
          partition,
          mode,
          preset: settings.duplicateDetectionPreset,
          kind,
          outcome,
          predictedDuplicate,
          predictedAction,
          originalMessageId:
            observation.match?.binding.original?.messageId ??
            candidates[0]?.original.messageId ??
            null,
          scorable,
          reviewedOriginalMessageId: labels.get(event.id)?.originalMessageId ?? null,
          historicalAction: event.historicalAction,
          eligibilityBasis: 'ASSUMED_FOR_POLICY_REPLAY',
          historicalSettingsKnown: manifest.settingsBasis === 'HISTORICAL_VERIFIED',
        })}\n`,
      );
    }
    if (!manifest || !end || end.exported !== events)
      throw new Error('Corpus EOF/count is missing or inconsistent');
    if ((await hashCorpusFile(input)) !== corpusSha256)
      throw new Error('Frozen corpus changed during replay');
    if (labelsPath && (await hashCorpusFile(labelsPath)) !== labelsSha256)
      throw new Error('Frozen labels changed during replay');
    if ([...labels.keys()].some((id) => !seen.has(id)))
      throw new Error('Labels contain unknown corpus event IDs');
    await file.sync();
    await file.close();
    file = undefined;
    const sourceComplete = end.sourceComplete === true && end.saturated === false;
    const summary = {
      version: 'antiduplicate-evaluation/v1',
      comparisonPolicy: 'text-or-image-v1',
      corpusSha256,
      labelsSha256,
      sourceSnapshotAt: manifest.sourceSnapshotAt,
      evaluationFrom: manifest.from,
      evaluationUntil: manifest.until,
      holdoutFrom: manifest.holdoutFrom,
      settingsBasis: manifest.settingsBasis,
      historicalActionAccuracy:
        manifest.settingsBasis === 'HISTORICAL_VERIFIED' ? 'REQUIRES_RIGHTS_EVIDENCE' : 'UNKNOWN',
      selectedChats: manifest.selectedChats,
      eligibleChats: manifest.eligibleChats,
      cohortComplete: manifest.cohortComplete,
      sourceComplete,
      sourceRejectionCauses: end.rejectionCauses ?? {},
      uniqueSourceEvents: events,
      evaluationEvents,
      labeledEvents,
      mediaUnverified,
      confirmedHistoricalDeletes,
      unscorableHumanLabels,
      simulatedClockBasis: 'RECEIVED_AT',
      mediaProofBasis: 'EXTERNAL_SOURCE_BOUND_HASHES',
      snapshotAgeDays: Math.max(
        0,
        Math.floor((Date.now() - Date.parse(manifest.sourceSnapshotAt)) / 86_400_000),
      ),
      warnings:
        Date.now() - Date.parse(manifest.sourceSnapshotAt) > 7 * 86_400_000
          ? ['HISTORICAL_SNAPSHOT_NOT_CURRENT_PRODUCTION']
          : [],
      outcomes,
      kinds,
      development: {
        humanLabels: scores.DEVELOPMENT.humanLabels,
        content: presentConfusion(scores.DEVELOPMENT.content),
        action: presentConfusion(scores.DEVELOPMENT.action),
      },
      holdout: {
        humanLabels: scores.HOLDOUT.humanLabels,
        content: presentConfusion(scores.HOLDOUT.content),
        action: presentConfusion(scores.HOLDOUT.action),
      },
      groups: [...new Set([...byKind.keys(), ...expectedHoldoutGroups])].map((key) => {
        const group = byKind.get(key) ?? {
          labels: 0,
          content: emptyConfusion(),
          action: emptyConfusion(),
        };
        return {
          key,
          events: holdoutGroupEvents.get(key) ?? null,
          labels: group.labels,
          content: presentConfusion(group.content),
          action: presentConfusion(group.action),
        };
      }),
      holdoutPolicyStrata: [...holdoutPolicyStrata].map(([key, value]) => ({ key, ...value })),
      acceptance:
        sourceComplete &&
        manifest.cohortComplete &&
        manifest.selectedChats >= 20 &&
        scores.HOLDOUT.humanLabels >= 1000 &&
        [...holdoutPolicyStrata.values()].every((stratum) => stratum.humanLabels >= 20) &&
        expectedHoldoutGroups.size > 0 &&
        [...expectedHoldoutGroups].every((key) => (byKind.get(key)?.labels ?? 0) >= 20) &&
        scores.HOLDOUT.content.fp === 0 &&
        scores.HOLDOUT.action.fp === 0
          ? 'REVIEW_REQUIRED'
          : 'INCOMPLETE',
      limitations: [
        'Policy replay assumes fresh rights and no immunity; it cannot prove historical enforcement.',
        'Unavailable binary proofs are operational unknowns, not negative content labels.',
        'Quality thresholds require independent review of the frozen holdout; this tool never activates sanctions.',
      ],
    };
    await writePrivateJson(summaryPath, summary);
    complete = true;
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return summary;
  } finally {
    if (file) await file.close();
    if (created && !complete) await unlink(output).catch(() => undefined);
    await window.close().catch(() => undefined);
    await redis.quit().catch(() => redis.disconnect());
  }
}
if (require.main === module)
  void replayAntiduplicateCorpus(process.argv.slice(2)).catch(() => {
    process.stderr.write('Antiduplicate replay failed; private inputs were not printed.\n');
    process.exitCode = 1;
  });
