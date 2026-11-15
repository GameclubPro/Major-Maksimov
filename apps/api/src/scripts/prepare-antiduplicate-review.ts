import { parseArgs } from 'node:util';
import {
  antiduplicateCorpusManifestSchema,
  antiduplicateCorpusEventSchema,
  antiduplicateCorpusEndSchema,
  assertDistinctCorpusPaths,
  corpusDigest,
  hashCorpusFile,
  readCorpusLines,
  writePrivateJson,
  type AntiduplicateCorpusEvent,
  type AntiduplicateCorpusManifest,
} from './antiduplicate-corpus';

export async function prepareAntiduplicateReview(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      input: { type: 'string' },
      output: { type: 'string' },
      'corpus-sha256': { type: 'string' },
      'per-partition': { type: 'string', default: '100' },
    },
  });
  const limit = Number(values['per-partition']);
  if (
    !values.input ||
    !values.output ||
    !/^[a-f0-9]{64}$/.test(values['corpus-sha256'] ?? '') ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 200
  )
    throw new Error(
      'Usage: --input <private-corpus.jsonl> --output <new-private-review.json> --corpus-sha256 <frozen-sha256> [--per-partition 1..200]',
    );
  const [input, output] = await assertDistinctCorpusPaths([
    { path: values.input, existing: true },
    { path: values.output, existing: false },
  ]);
  const digest = await hashCorpusFile(input!);
  if (digest !== values['corpus-sha256']) throw new Error('Frozen corpus digest mismatch');
  let manifest: AntiduplicateCorpusManifest | undefined;
  let end: ReturnType<typeof antiduplicateCorpusEndSchema.parse> | undefined;
  let events = 0;
  let previousTime = 0;
  const seen = new Set<string>();
  const samples: Record<
    'DEVELOPMENT' | 'HOLDOUT',
    Array<{ rank: string; event: AntiduplicateCorpusEvent }>
  > = { DEVELOPMENT: [], HOLDOUT: [] };
  for await (const raw of readCorpusLines(input!)) {
    if (!manifest) {
      manifest = antiduplicateCorpusManifestSchema.parse(raw);
      continue;
    }
    if (end) throw new Error('Corpus has records after END');
    if ((raw as { type?: string })?.type === 'END') {
      end = antiduplicateCorpusEndSchema.parse(raw);
      continue;
    }
    const event = antiduplicateCorpusEventSchema.parse(raw);
    const at = Date.parse(event.receivedAt);
    if (
      ++events > 2_000_000 ||
      seen.has(event.id) ||
      at < previousTime ||
      at < Date.parse(manifest.warmupFrom) ||
      at >= Date.parse(manifest.until) ||
      !Object.hasOwn(manifest.settings, event.chatId)
    )
      throw new Error('Corpus identity, order, interval, scope or event budget is invalid');
    seen.add(event.id);
    previousTime = at;
    if (at < Date.parse(manifest.from) || event.eventType === 'message_removed') continue;
    const partition = at < Date.parse(manifest.holdoutFrom) ? 'DEVELOPMENT' : 'HOLDOUT';
    const selected = samples[partition];
    // FLAG: Sampling depends only on frozen input identity, never detector predictions,
    // historical sanctions or supplied labels. Keep each temporal partition separate.
    const rank = corpusDigest(['blind-review-v1', digest, event.id]);
    if (selected.length === limit && rank >= selected.at(-1)!.rank) continue;
    selected.push({ rank, event });
    selected.sort((left, right) => left.rank.localeCompare(right.rank));
    if (selected.length > limit) selected.pop();
  }
  if (!manifest || !end || end.exported !== events || (await hashCorpusFile(input!)) !== digest)
    throw new Error('Corpus is incomplete, changed or has an invalid event count');
  const packet = {
    version: 'antiduplicate-blind-review/v1',
    corpusSha256: digest,
    sourceComplete: manifest.sourceComplete && end.sourceComplete,
    cohortComplete: manifest.cohortComplete,
    settingsBasis: manifest.settingsBasis,
    perPartitionLimit: limit,
    instruction:
      'Review each message in the complete frozen corpus sequence, including prior messages, edits and removals within its comparison window. Judge content repetition and action eligibility separately. Blank fields are not labels. Only an independent human may set reviewerKind to HUMAN. Keep HOLDOUT labels separate from tuning.',
    items: Object.entries(samples).flatMap(([partition, selected]) =>
      selected.map(({ event }) => ({
        partition,
        id: event.id,
        chatId: event.chatId,
        messageId: event.messageId,
        eventType: event.eventType,
        eventAt: event.eventAt,
        receivedAt: event.receivedAt,
        raw: event.raw,
        settings: manifest!.settings[event.chatId],
        label: {
          id: event.id,
          corpusSha256: digest,
          duplicate: null,
          actionAllowed: null,
          reviewerKind: null,
          reviewer: null,
          reviewedAt: null,
        },
      })),
    ),
  };
  await writePrivateJson(output!, packet);
  return { selected: packet.items.length, corpusSha256: digest };
}

if (require.main === module) {
  void prepareAntiduplicateReview(process.argv.slice(2)).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : 'Review preparation failed'}\n`,
      );
      process.exitCode = 1;
    },
  );
}
