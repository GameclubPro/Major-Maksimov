# Commercial filter quality rollout

The quality policy `commercial-intent-quality-v1` is experimental. Routine deployment
ships observation, independent review and source-read retries; it does not promote
the new text deletions. The released deterministic policy and its experimental
candidate remain separate from active asynchronous AI enforcement. Commercial
photo analysis is retired: new jobs disable its purpose and the commercial
rollout stays off; the explicit image stop-list still uses OCR. Retained commercial OCR baseline/certified guards support compatible drain
and rollback, not active image advertising analysis. Automatic corpus labels and
synthetic tests are regression evidence, not measured accuracy.

For active AI results, provisional reviewer-less diagnostics and offline routing
comparisons, use the separate [AI evidence runbook](commercial-ai-quality-evidence.md).
Missing asynchronous results are not completed deterministic KEEP decisions.

## Collection and review

Enablement follows each chat's existing commercial-filter setting. Capture all hits,
review candidates and available technical OCR failures, plus a stable approximately
10% sample of logical non-hit messages. Author/campaign/message pseudonyms use a
domain-separated keyed digest. Edits retain one logical key and distinct immutable
source snapshots; mirrored deliveries enrich the same revision. Source creation
comes from the actual Message, never the webhook event clock.

Failed exact-source reads, including HTTP 401/403/404/410, remain technically
incomplete when their existing retry policy is terminal. They preserve fail-open
enforcement, the original deadline and uncertainty about the source. A successful
empty source read retains its separate legitimate-absence outcome. Terminal
technical samples use only the original retained webhook identity and are captured
only after the terminal accounting claim wins; settled mirror/restart claims do
not create another sample. This classification never enables retired commercial
photo analysis or changes the independently enabled image stop-list.

Concurrent first captures may collide on the evidence hash. The losing insert
reloads that exact sample once and merges its observations through the existing
revision and expiry guards, preserving labels and ratings. Missing winners and
other storage failures remain explicit capture omissions; capture never retries
a MAX action or establishes complete sampling coverage.

`samplingProbability` describes capture (1 for hits/review/technical cases, about
0.1 for non-hits). `randomEvaluationIncluded` identifies the same stable uniform
10% evaluation frame across every stratum. Its `evaluationSamplingProbability` is
`ceil(0.1 * 2^32) / 2^32`, including for captured hits. Do not evaluate a population
using the enriched all-hit queue as an unweighted random sample. Freeze the sampling
frame before human labels, reconcile missing reviews, retain the exact probabilities
and keep `pseudonymizationKeyId` unchanged between development and holdout.

The closed Safety Desk obtains reviewer identity from trusted `X-Remote-User`.
Each reviewer needs a separate account. Before submitting an independent rating,
the server hides scores, decisions and other ratings, including their list order.
Ratings are append-only. Two agreeing ratings resolve a sample; disagreements
require a third independent account. Historical single labels remain historical.
Classification (`COMMERCIAL`, `NOT_COMMERCIAL`, `UNSURE`) and the expected message
action (`KEEP`, `DELETE`) are separate: a private sale can be protected by policy.
Incomplete/redaction-fallback text cannot receive a definitive independent label.

Photo cards contain only the original caption or an empty source card. They cannot
receive positive/negative image labels through this UI. Recognized OCR text is
never written to the production review queue, jobs, logs or exports. View original
photos in the private image dataset and use the existing independently reviewed
OCR corpus contract to bind labels and manual transcripts to source image hashes.

Review samples expire after 14 days. Export and freeze development sources when
the development period closes; keeping them only in the live queue would lose the
oldest sources before a seven-day holdout plus a 24-hour gap finishes. Originals,
exports, identity mappings, transcripts and annotations stay outside Git.

## Private sources and reports

The closed `GET /api/v1/safety-desk/commercial/review/export` endpoint accepts
explicit `since`, `until`, `limit` (at most 500) and cursor. It exports only samples
the caller already reviewed, with independent ratings/provenance and an eligibility
flag. Follow all pages; this scope does not prove that the entire capture frame was
reviewed. An eligibility flag alone is never certification.

`GET /api/v1/safety-desk/commercial/review/frame` exports the stable random frame
for the same window with neutral capture cursors. It includes only source and
pseudonymous provenance, with no decisions, scores, labels, strata or excerpts.
Follow pages even when `items` is empty and `nextCursor` is present. Attach these
pages as `holdoutFrame` in the report bundle; without them, passing paired metrics
describe only the provided reviews and independent improvement remains unproven.

Collect private originals through the bounded tool. Use a past fixed UTC window,
an existing owner-private directory outside the repository, and a new checkpoint:

```bash
npm run moderation:export-commercial-private-images --workspace @maxim/api -- \
  --since 2026-10-05T00:00:00.000Z --until 2026-10-06T00:00:00.000Z --limit 100 \
  --checkpoint /private/image-selection.checkpoint.json
```

Preview never downloads photos. With `--checkpoint`, it writes an owner-only,
authenticated private selection state containing bounded provenance and receipt
PKs, without raw webhook payloads, URLs or recognized text. Each run fetches at
most 5,000 raw rows across sample and receipt pages of at most 500 rows. TEXT-only
sample pages and noisy receipt padding advance their own indexed tuple cursors.
Follow `resumeRequired` by repeating the same window, key, limit and checkpoint
with `--resume`; cursors and internal IDs never enter the public aggregate.
Default preview without a checkpoint remains bounded but cannot resume.

After `sourceLookupComplete` is true, repeat with `--resume`, a new
`--output-dir /private/new-image-batch` and `--apply`. Before downloading, the tool
reloads matched receipts by PK and rechecks the frozen source revision, original
creation time, author and ordered photo identities. Edits never substitute the
latest revision. The output directory must be new and outside the actual workspace.
The checkpoint, its parent and the output parent must be real owner-private paths;
symlinks, shared files, changed window/key/source/layout and tampered cursors fail
closed. A release change invalidates earlier checkpoints; retain completed private
artifacts and start a fresh selection rather than editing their state.

Repeating a completed `--resume` returns its aggregate without downloading again.
Use `--resume --next-frame` to select the next output batch: uncaptured matched
albums are carried first, then the sample cursor continues. Supply a new output
directory when applying that batch. An album larger than the fixed image limit is
an explicit terminal budget omission; it cannot block later samples. Start a new
selection with an adequate limit to retry such albums. An interrupted `EXPORTING`
checkpoint fails closed; an operator must inspect and retain its existing files
before starting fresh. Preserve each batch's report and operator manifest.

The tool performs no native OCR, MAX send, deletion, sanction or DB write. It keeps
complete albums and enforces a 500-selected-source cap, 256 MiB byte cap and a
120-second deadline shared by paging and collection. The aggregate distinguishes
bounded continuation, source-window exhaustion, unmatched revisions and failed
revalidation. Receipts are `PROCESSED_ONLY`; late processing, missing/expired
receipts and sources outside the padded window remain explicit unknown coverage.
No cursor or completion flag proves population or independent-review completeness.
Private output keeps separate blind review sources and operator provenance with
original image file hashes.

Create a `commercial-quality-paired/v1` private bundle with `detectorSourceSha256`,
`frozenAt`, `evaluatedAt`, `development` and `holdout`. Each export page is
`{ "cursor": null, "response": <export response> }` for its first request; later
page cursors must match the preceding response's `nextCursor`. Preserve the original
responses; do not fabricate reviewers or convert historical labels into ratings.

```bash
npm run moderation:report-commercial-quality --workspace @maxim/api -- \
  --input /private/frozen-evidence.json --output /private/quality-report.json
```

The report provides original row/group denominators, source windows, missing and
uncertain reviews, Wilson 95% bounds, and paired corrected/regressed counts. It
compares deletion permission using canonical WARN-inclusive policy, recognition
and known execution separately. Unknown/pending execution is unknown; confirmed
deletion and already-absent source receipts are distinct. Candidate execution is
unevaluated in shadow mode. Caption-only OCR is unevaluated. The report never
authorizes promotion and never prints excerpts, identities, contacts or ratings.

Evaluate the experimental photo semantics against the released policy on the
same independently reviewed originals with the separate private command:

```bash
npm run moderation:run-commercial-ocr-paired-private --workspace @maxim/api -- \
  --manifest /private/manifest.json --output /private/paired-photo-report.json
```

Use the existing OCR manifest v2 contract with two independent original-image
reviews and matching original-file digests. Each original runs the existing two
native recognition passes once; both policies receive those exact pass results.
The aggregate `commercial-ocr-paired-private/v1` report keeps the candidate identity
separate from the baseline certification identity and checks the existing strict
OCR gates and paired corrected/regressed counts. Bind the immutable image, source
and benchmark environment through the existing optional evaluation arguments for
native provenance. No recognised text, caption, source identifier or reviewer
identity enters the output. Missing originals, reviews or native evidence remain
`UNAVAILABLE`/`INCOMPLETE`. Passing metrics describe the supplied private corpus;
this command cannot attest the random author/campaign/time split or authorize
production promotion. Those independent corpus requirements still apply.

The fixed production report is opt-in:

```bash
./infra/scripts/vps-connect.sh postgres-audit commercial-quality --explain
./infra/scripts/vps-connect.sh postgres-audit commercial-quality
```

After additive migrations and synchronization, preview and apply the reviewed
`postgres-audit-provision` step to grant exactly eight sample metadata columns.
The report requires the attested `commercial_review_samples_blind_queue_idx`,
walks at most 5,001 newest rows in 24 hours and returns at most 5,000 samples in
fixed aggregates. It exposes no sample IDs, original evidence or arbitrary strings.
Its counts describe captured revisions, not every message; inverse-probability
counts are estimates. `complete` describes this bounded capture report, not human
review completeness, image coverage, deletion success or filter accuracy.

OCR logical accounting separately counts one start/terminal result per admitted
source/behavior/purpose job using Redis atomics. Outcomes are complete keep,
complete deletion candidate, technical incomplete, legitimate skip or expired.
Counters across OCR purposes include image stop-list jobs; attempts/source checks
are not logical denominators. Missing/unavailable accounting remains incomplete.
Source wait, governor wait, native wait and recognition timing are distinct.

## Independent evidence and promotion

Collect at least seven days of development data, finish its independent reviews,
freeze rules and sampling frame, leave at least 24 hours, and collect at least
seven new days of holdout. Authors and every connected campaign key must be disjoint.
Both BALANCED 45/65 and STRICT 38/55 need independent evaluation; snapshots from
one live settings profile do not measure the other profile.

For the intent cohort, text promotion requires the selected artifact and separately
reviewed companion artifacts covering both prescribed profiles. Supply each
companion with `--companion-artifact /private/profile-holdout.json` and its
`--reviewed-companion-artifact-sha256` value. The control tool independently
validates each artifact and rejects differing source identities, source frames,
labels, reviewers, sampling declarations or freeze boundaries. Runtime authority
remains bound to the selected settings profile; its expiry is bounded by the
earliest reviewed artifact expiry. Extra profiles require both prescribed
companions as well as their own independent evaluation.

Text needs at least 4,000 protected and 500 advertising units per evaluated profile.
The protected false-deletion Wilson upper 95% bound must be at most 0.1%, and the
offer cleanup recall lower bound at least 95%. Both FP and FN improvements require
paired evidence; the exact one-sided paired tests use 0.025 per endpoint. Unknown
or insufficient data cannot establish improvement. OCR retains its stricter
existing original-image, two-pass, identity, native-performance and confidence
gates, including at least 4,603 negative and 500 positive independent units.

Use [the quality evidence contract](../../commercial-filter-quality-evidence.md)
and the frozen text holdout validator. Candidate holdout rows use `current` or
`sanitizedBaseline` for the candidate and `releasedBaseline` for the frozen released
decision. Their explicit `actionable` fields and decision versions are mandatory.
Candidate provenance includes all campaign keys, the stable pseudonym key ID,
`randomEvaluationIncluded: true`, complete source text and `samplingProbability`
equal to the evaluation probability, not the enriched capture probability.
Campaign grouping must be complete in development as well as holdout. The capture
extractor retains up to 32 original contact keys, including third and subsequent
contacts; oversized text/key sets are explicitly incomplete and cannot prove a split.

Candidate `samplingDesign` requires schema `commercial-quality-holdout-sampling/v1`,
`frameId`, `declaredAt` no later than the freeze, `frameSourceSnapshotSha256`,
`selection: INDEPENDENT_PROBABILITY_SAMPLE`, `inclusionProbability`,
`expectedSamples` matching the entire frozen holdout, and `complete: true`.
These declarations must be verified against the private source frame by reviewers.
Do not create them from detector decisions after looking at outcomes.

Promotion uses the existing preview-first text control and an independently
reviewed artifact hash. Start with explicitly selected canary chats. Renewals must
retain the same source/settings/cohort identity and live control to accumulate
seven continuous days; interruptions or scope changes reset that period. Broad
`on` expansion must pass the canary gate. A confirmed independent KEEP assessment
of an actual new-policy deletion stops that policy identity for future dispatch.
Emergency off and every dispatch's fresh source/settings/access/immunity/deadline
guards remain in force. Failure requires a new candidate and new frozen holdout.

Deploy the affected API roles and static consumers only through the normal wrapper
after local checks and successful exact-commit CI. Additive review migrations allow
compatible rollback without dropping labels. Before any older rollback, disable
experimental authority and retain existing text/OCR delete guard compatibility.
