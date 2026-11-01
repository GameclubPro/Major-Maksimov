# Commercial filter quality evidence

Automatic corpus labels are regression evidence. They do not establish independent accuracy, safe deletion, or sanction quality. Preserve historical labels and report newly exposed mismatches; do not rewrite them to make release checks pass.

Active AI has a separate [bounded evidence report and routing simulator](operations/runbooks/commercial-ai-quality-evidence.md).
Its diagnostic AI references cannot supply independent human labels, authorize
promotion or establish actual deletion from a model response.

Cleanup eligibility is the canonical `isCommercialMessageDeleteEligible` policy. `WARN` includes message cleanup. Explicit `KEEP`, an invalid disposition, and `actionable=false` cannot authorize cleanup. Detection false-positive rate and cleanup false-positive rate are separate measurements. Benchmark evidence now uses `commercial-detector-benchmark/v2` and reports both.

## Independent corpus checks

Run the public workspace command with a frozen development corpus and a separately reviewed holdout:

```bash
npm run moderation:validate-commercial-corpus --workspace @maxim/api -- \
  --input /absolute/path/holdout.jsonl \
  --quality-gate \
  --development-input /absolute/path/frozen-development.jsonl \
  --holdout-cutoff 2026-08-01T00:00:00.000Z \
  --min-holdout-gap-hours 24
```

The quality gate requires manual labels, explicit `expectedDisposition: KEEP|DELETE`, and explicit actual `actionable` and `messageDisposition`. A manual label-source string alone is insufficient. Current action-band checks remain available independently of cleanup checks.

Every development and holdout record carries `reviewProvenance`:

| Field                  | Meaning                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `schemaVersion`        | `commercial-corpus-provenance/v1`                                                    |
| `datasetRole`          | `DEVELOPMENT` or `HOLDOUT`                                                           |
| `datasetId`            | Stable identifier for the frozen dataset                                             |
| `sampleId`             | Stable identifier for the source sample                                              |
| `sourceSnapshotSha256` | SHA-256 of the frozen original source snapshot                                       |
| `authorGroupId`        | Stable pseudonymous group for the actual author                                      |
| `campaignGroupId`      | Stable pseudonymous group for the actual campaign or independent non-campaign sample |
| `messageCreatedAt`     | Actual immutable source creation time, UTC ISO                                       |

Holdout records also require `labelAuthorId`, two to eight distinct `reviewerIds`, `reviewedAt`, and `reviewedTextSha256` binding the exact independently reviewed sanitized `text`. Reviewers must be separate from all label authors declared in either corpus. Development samples must precede the explicit cutoff; holdout samples must follow it by the configured gap. The default gap is 24 hours.

The checker rejects shared dataset, source sample, source snapshot, author, or campaign identities between development and holdout, and duplicate holdout samples. Use the real grouping consistently: assigning a new group to each repeated message would invalidate the declared independence. Keep original private sources and identity mappings outside Git. These checks validate declared provenance and boundaries; the operator must verify the underlying source and human review.

The experimental `commercial-intent-quality-v1` cohort additionally requires all
`campaignGroupIds`, complete grouping and source text in both splits, and one
unchanged `pseudonymizationKeyId`. Its stable uniform evaluation frame is separate
from enriched capture: every hit may be captured, while only the preselected 10%
cohort is appropriate for the unweighted paired evaluation. Provenance
`samplingProbability` uses `evaluationSamplingProbability` for this cohort;
`randomEvaluationIncluded` must be true. Unknown grouping or rotated pseudonyms
cannot establish author/campaign separation.

The checked-in automatic fixture remains a structural and behavioural regression dataset. Canonical cleanup currently exposes seven legacy campaign-only predictions in its frozen snapshots. Its test preserves and reports `campaign_only_delete_count=7`; this dataset cannot be presented as independent release evidence.

## Frozen text promotion artifact

`validateCommercialTextHoldoutArtifact` accepts a `commercial-text-holdout/v1` artifact with:

- `detectorSourceSha256`, matching the current generated detector source digest;
- `decisionVersion`, matching the version selected by the artifact cohorts (`commercial-intent-quality-v1` when that cohort is included, otherwise the current released engine version);
- `settingsProfileDigest`, matching the exact public commercial settings tuple;
- UTC ISO `evaluatedAt`, `expiresAt`, and `holdoutCutoffAt`;
- explicit `minHoldoutGapHours`;
- `cohorts`, containing one or more of `owned-service-contrast-v1`, `sliding-campaign-v1`, and `commercial-intent-quality-v1`;
- non-empty `developmentRecords` and `holdoutRecords`, bounded at 100,000 rows each;
- each holdout record's explicit `cohortId` in addition to the corpus/provenance fields above.

An artifact must be no more than 24 hours old and must expire within 24 hours of evaluation. Source creation and independent review must precede evaluation. Each selected cohort must contain observed sources spanning at least seven days and must pass independently.

The validator recomputes quality from explicit manual KEEP/DELETE labels and actual canonical cleanup decisions. It collapses connected author/campaign groups into statistical units so correlated repeated messages cannot inflate the denominator. A protected unit fails if any expected-KEEP message is cleanup-eligible; an offer unit succeeds only if every expected-DELETE offer in it is cleanup-eligible.

Promotion requires the Wilson 95% upper confidence bound for protected-negative cleanup errors to be at most 0.1%, and the Wilson 95% lower confidence bound for independent-offer cleanup recall to be at least 95%. A missing denominator is unevaluated and rejects promotion. Approximately 3,838 independent protected units with zero errors are required just to meet the false-positive bound; larger representative samples are preferable.

Any unknown, malformed, mismatched, expired, overlapping, incomplete, or insufficient evidence returns `approvedCohorts=[]`. Promotion also requires the operator's independently reviewed artifact SHA-256 in the runtime-control command. Computing a digest inline from a newly created artifact is not independent authorization. The tooling and synthetic tests do not constitute a real reviewed holdout artifact. Experimental text expansion remains a separate promotion decision from the shipped deterministic baseline.

The new intent cohort requires at least 4,000 protected and 500 offer units,
seven-day development and holdout periods, a minimum 24-hour gap, and explicit
`releasedBaseline` snapshots beside candidate `current`/`sanitizedBaseline`
snapshots. Both false deletion permission and missed cleanup must improve in
paired independent units; each exact one-sided test uses 0.025. A complete
predeclared `commercial-quality-holdout-sampling/v1` design binds the frame and
its expected sample count. Evaluate BALANCED 45/65 and STRICT 38/55 separately.
Intent-cohort promotion requires independently reviewed artifacts for both
prescribed profiles with matching frozen sources and human evidence. The selected
settings binding remains exact; a passing companion cannot authorize its settings.
The observation report cannot authorize promotion, and a paginated OWN_REVIEWED
export alone does not prove review of the full random frame. Reconcile it with
the closed sampling-frame export and show missing/uncertain evidence explicitly.
See [the collection and rollout runbook](operations/runbooks/commercial-quality-rollout.md).

## OCR clocks and coverage

Commercial OCR schema v3 separates immutable `sourceCreatedAt` from `eventTimestamp`. The candidate reads source creation from the selected raw Message; normalized `message.createdAt` remains the MAX event time used by other moderation paths. Admission age and the absolute OCR deadline use event time. The worker verifies both fields against the persisted receipt and binds deletion to the immutable creation timestamp and exact fresh photo identity.

Job identity excludes event time and action eligibility so mirrored deliveries cannot multiply the same immutable source work or extend an already queued deadline. Schema v1/v2 work drains with its original event/deadline semantics. No fuzzy timestamp tolerance is used.

Fixed `source.*` counters distinguish ready source checks, missing/unavailable/failed/invalid receipts, terminal semantic owners, identity or creation-time mismatch, unavailable/absent/invalid exact reads, ineligible authors, and changed sources. These are counts of checks or terminal outcomes, not a deduplicated count of participants or messages; source checks may repeat on retries. They contain no message identifiers, OCR text, or contact data.

Commercial image analysis is retired and its rollout stays `off`; new image jobs
do not schedule commercial OCR. The retained baseline and certified readers exist
for compatible draining and rollback. Their historical review observations use
only the visible caption or an empty metadata-only excerpt, never recognized OCR
text or critical/contact signatures. Pending observations are KEEP; a DELETE
sample requires the actual fresh confirmed deletion path. Review feedback does
not independently certify a native OCR behavior identity. Retained baseline guards
preserve two high-confidence passes, critical evidence confidence, Cyrillic
evidence, safe-context vetoes, high-risk offer requirements, exact unchanged source
identity, current author/admin/immunity checks and the original absolute deadline.
They provide no authority to reactivate commercial image analysis or apply
OCR-driven participant sanctions.

Delete binding v5 records an explicit authority union. `BASELINE` binds the current release behavior digest, the verified live sandbox native digest, and the exact settings fingerprint; it has no certificate, control revision, or control expiry. The worker must attest complete matching live native artifacts inside the no-network sandbox, and the dispatch guard compares the image-owned expected identity and fresh settings with that binding. A changed authority, source, native release, settings, or expired deadline cancels pending deletion.

`CERTIFIED` retains the fresh signed promotion/exact-chat Redis control and its revision/expiry. Baseline is excluded from the signed-control schema, and changing baseline to certified mode cannot inherit an earlier pending authorization. Earlier v4 bindings fail closed. Rollback must keep the v5-capable guard or disable OCR and drain pending work before using an older release. Independent reviewed OCR corpus evidence remains required for any future widening of the strict baseline; enabling baseline does not assert a measured OCR false-positive rate.

## Read-only production image audit

Run `npm run moderation:audit-commercial-ocr-images --workspace @maxim/api -- --lookback-hours 1` inside the reviewed media image, or its compiled `audit-commercial-ocr-images.js` entrypoint. The lookback is an integer from 1 to 24 hours; there are no write or apply options. The tool uses the shared commercial-audit lock, a fixed read-only indexed window of at most 500 processed receipts, and at most three unique photos from complete user-authored albums in chats that currently opt in. Captionless images are included.

Photos download through `SecurePhotoDownloader`. Raster preprocessing and both PSM 11/6 recognition passes use only the existing verified no-network UDS sandbox. There is no local native fallback, OCR cache write, queue admission, MAX action, message deletion, settings change, or participant sanction. The diagnostic recognizes all selected images even when the caption is safe; the strict decision still receives that original caption and every image’s veto. Current commercial settings are used for each selected chat.

Output contains aggregate counters, pass latency, and native/policy identities. It contains no source identifiers, URLs, captions, recognized text, signatures, photos, or private transport error details; image buffers are cleared after use. `strict_delete_candidates` is a read-only policy result, never a count of deletions or an independently labelled precision estimate. Tiny operational samples demonstrate that actual production photos reach native OCR; they cannot establish statistical quality, manual labels, provenance, or certification.
