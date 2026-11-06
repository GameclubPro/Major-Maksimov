# Offline anti-duplicate quality evaluation

The offline evaluator uses production text/window comparison in isolated local stores. It imports
no MAX client, starts no moderation workers and cannot delete messages or apply sanctions.
Production PostgreSQL remains accessible only through the fixed diagnostic catalog. Do not take
an ad hoc live dump or point these tools at a production store.

## Prepare a verified snapshot

Use an existing encrypted, checksum-verified backup with its verification ACK. Decrypt only in
an owner-private directory outside the repository (directory `0700`, files `0600`). Verify the
plaintext SHA-256 against the backup's source digest. Do not print or copy the age identity.
The encrypted original remains intact; remove the owned plaintext archive after extraction.

Run `infra/scripts/restore-antiduplicate-snapshot.mjs` inside the disposable native-store runner,
then export before that runner exits. It accepts only a loopback database whose name begins
`maxim_race_test_` or `maxim_antiduplicate_replay_`. Never use `--migrate` for this historical
restore: the archive provides its own pre-data schema, without foreign keys or historical
triggers. Only settings and webhook receipts receive data; bot/token tables remain empty.
The restorer verifies the private archive and restores fourteen complete UTC days ending at
the snapshot's last midnight. Exceeding its bounded event budget fails the restore rather than
silently claiming a complete sample. Native PostgreSQL 16 clients (`pg_restore`, `pg_dump`,
`psql`, `createdb`, `dropdb`) and Redis 7 are required for restore validation.

Create a private local driver that runs these commands sequentially within one invocation of
`node scripts/agent/with-test-stores.mjs -- node <private-driver.mjs>`:

```bash
node infra/scripts/restore-antiduplicate-snapshot.mjs \
  --input "${MAXIM_CORPUS_DIR:?private directory required}/snapshot.dump" \
  --expected-sha256 "${MAXIM_CORPUS_SHA256:?verified plaintext SHA required}" \
  --snapshot-at "${MAXIM_CORPUS_SNAPSHOT_AT:?UTC snapshot date required}"
npm run moderation:export-antiduplicate-corpus --workspace @maxim/api -- \
  --output "$MAXIM_CORPUS_DIR/corpus.jsonl" --snapshot-sha256 "$MAXIM_CORPUS_SHA256" \
  --snapshot-at "${MAXIM_CORPUS_SNAPSHOT_AT:?UTC snapshot date required}" --minimum-chats 20
npm run moderation:replay-antiduplicate-corpus --workspace @maxim/api -- \
  --input "$MAXIM_CORPUS_DIR/corpus.jsonl" --output "$MAXIM_CORPUS_DIR/decisions.jsonl" \
  --summary "$MAXIM_CORPUS_DIR/summary.json"
```

Pass only the disposable store URLs and basic tool environment to the driver. It does not need
production env files, bot credentials or network access. Build scripts with the public API wrapper
before using packaged dist commands; source and dist must describe the same reviewed revision.
Output paths must be distinct, owner-private real paths. Existing outputs are never overwritten.

## Freeze and label

The corpus contains seven evaluation days, seven preceding warm-up days and a temporal holdout
covering the final two evaluation days. Export selects active enabled chats across preset, mode,
image scope, schedule and calm/middle/hot activity. Strata of five or fewer chats are included
in full; larger strata contribute several activity levels, with at least twenty chats overall.
An insufficient cohort is reported explicitly. Message receipts keep their actual arrival order;
edits and removals are replayed. Physical LF framing preserves Unicode paragraph/line separators
inside user text.

Names and entity/message identifiers are pseudonymized. Text, numerical values, URLs and callback
navigation remain faithful because changing them would hide comparison defects. The corpus is
still private data, not an anonymous public fixture. Do not commit it, upload it to CI or include
its contents in metrics, public API responses or shared reports.

Freeze the complete corpus SHA-256 before independent review. Reviewers examine original and
repeat in their sequence and label two separate questions: whether content repeats, and whether
an action is allowed under the captured settings. Detector output is never the reference answer.
Each private JSONL label uses the schema in `antiduplicate-corpus.ts`, binds the frozen
`corpusSha256` and event `id`, and includes `duplicate`, `actionAllowed`, `reviewerKind`,
`reviewer` and `reviewedAt`. Only independently supplied `HUMAN` labels enter primary quality
scores; agent labels are exploratory. Do not tune on the final two days. Resolve disagreements
independently and preserve the reviewed label file with the corpus.

Replay again with `--labels <private-reviewed-labels.jsonl>` and new output paths. Reports
separate development/holdout results, matching/action predictions, infrastructure unknowns and
confirmed historical receipts, with sample sizes and Wilson 95% intervals. Missing binary hashes
are unknowns for media comparison, never negative content examples. Replay follows the common
`text-or-image-v1` policy: it compares text/captions first regardless of the captured legacy
selector, then considers independently proved images or non-photo media when text has no match.
A confirmed text repeat remains scorable without image proof. Media proofs must bind the exact
source digest, hash count and algorithm version; this evaluator does not fetch historical media
from MAX. Captured selector values remain cohort metadata, and input-content cohorts stay
independent of which evidence produced the prediction.

## Interpret evidence and release gates

Snapshot settings are not verified historical settings. Default export marks `SNAPSHOT_REPLAY`
and historical action correctness `UNKNOWN`; fresh rights and lack of immunity are assumptions
for policy replay. A stale backup cannot establish current-release fleet accuracy. EOF, event
counts, caps and rejected records determine source completeness; a successful process alone
does not prove full seven-day coverage.

Zero false actions on mandatory negative regressions, preserved genuine repeats and the fixed
TEXT lifecycle case gate reliability changes. Independent holdout quality remains `INCOMPLETE`
when data, proofs, modes or labels are insufficient. The evaluator never activates sanctions.
Keep `MESSAGE_DUPLICATE_MEDIA_SHARED_ADMISSION_ENABLED=false` until sustained hot/calm chat
and OCR/photo acceptance demonstrates latency improvement without lost deadlines or a change
in allowed actions. Redis pacing correctness alone does not satisfy that capacity gate.

The effective comparison window is at most 48 hours, including legacy settings above that
ceiling. Replay uses the same resolver and v4 absolute-expiry history script. Snapshot policy
normalization clamps only safe-integer legacy windows before parsing and
does not mutate the source corpus. Replay therefore evaluates the current 48-hour policy;
it does not establish whether a historical seven-day action was permissible. Historical binding
parsing can still recognize seven-day metadata, but fresh action guards revoke all pre-v3
proofs, including exact-only and IMAGE. v4 starts with a fresh baseline and preserves v3 negative reset/removal evidence; never import v2 reset,
removal or group records into it or delete BullMQ/authority state to accelerate memory recovery.
Group/count and message/qualification use their own window plus eleven-minute proof grace;
lifecycle/reset/removal are bounded by 48h11m. Grace is retention only, never action authority.
See [bounded-history review](../../antiduplicate-bounded-history-2026-10-05.md) for the known
recall/resource tradeoffs and the measurement backlog.

Run local restore integration coverage with:

```bash
node scripts/agent/with-test-stores.mjs -- \
  node --test infra/scripts/restore-antiduplicate-snapshot.test.mjs
```

See [message-duplicate rollout](message-duplicate-rollout.md) for exact-SHA deployment,
all-role transition fencing, diagnostic history recovery and compatible rollback.
