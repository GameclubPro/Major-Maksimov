# Private commercial AI diagnostic collection

This collector observes retained commercial captures without human reviewers. It
exports exact safe source text separately from AI observations, policy permission
and verified own deletion receipts. Its scope is `RETAINED_CAPTURE_DIAGNOSTIC`;
it does not establish traffic coverage, classification accuracy, independent human
truth or permission to promote a policy. Use the separate
[quality evidence procedure](commercial-ai-quality-evidence.md) for those gates.

## Release and bounded collection

Release the observation writer, additive migration and collector through the normal
exact-SHA CI/deploy gates first. Record the synchronized source SHA, immutable API
image, requested UTC window, command identity, start/deadline, exit status and
private output location. Historical rows are not backfilled with inferred attempts.
Do not start another commercial audit while this collector holds the common audit
advisory lock.

Choose an already closed UTC window of at most fourteen days. Collection requires
the actual `APP_ROLE=admin` and `APP_SERVICE_NAME=api-admin` in production; local
development may leave both unset. Select a new absolute directory outside the
workspace and every Git tree. The parent must already exist. The collector creates
the run directory as `0700` and files as `0600`, refusing an existing run directory.

Before any collection query runs in production, inspect the plain plans from this
reviewed CLI on the exact active release. `--explain` is an exclusive mode: it runs
only `EXPLAIN (FORMAT JSON)` for the real neutral-page helper and the real receipt
lookup helper with synthetic keys. It never adds `ANALYZE`, reads source rows,
loads actual source identifiers or falls through to collection. The closed-window,
admin-role, audit-lock, pool and timeout guards remain active.

First obtain the plans locally:

```bash
npm run moderation:collect-commercial-ai-diagnostics --workspace @maxim/api -- \
  --since 2026-11-01T10:00:00.000Z --until 2026-11-01T11:00:00.000Z \
  --output-dir /absolute/private/new-ai-diagnostic-plans --explain
```

Inspect `query-plans.private.json` for a bounded neutral index page and the two
ordered composite receipt seeks. Plans are private `0600` files in a new `0700`
directory; `run-state.json` records progress. The total output byte cap and finite
deadline also apply. An estimated plain plan does not prove actual row work or
deletion success. Retain its hash and release identity with the operator record.

Then collect with a separate new directory:

```bash
npm run moderation:collect-commercial-ai-diagnostics --workspace @maxim/api -- \
  --since 2026-11-01T10:00:00.000Z --until 2026-11-01T11:00:00.000Z \
  --page-size 100 --max-rows 5000 --max-bytes 50331648 \
  --output-dir /absolute/private/new-ai-diagnostic-run
```

The production image contains the compiled CLI under `/app`; it does not require
`tsx` or source dependencies. After verifying that this released image is active,
first obtain the plans through the existing VPS wrapper:

```bash
./infra/scripts/vps-connect.sh exec \
  docker compose --env-file .env -p infra -f infra/docker-compose.yml \
  exec -T api-admin node \
  apps/api/dist/apps/api/src/scripts/collect-commercial-ai-diagnostics.js \
  --since 2026-11-01T10:00:00.000Z --until 2026-11-01T11:00:00.000Z \
  --page-size 100 --max-rows 5000 --max-bytes 50331648 \
  --output-dir /tmp/maxim-ai-diagnostic-new-plans --explain
```

After reviewing both plans, run collection on that same release:

```bash
./infra/scripts/vps-connect.sh exec \
  docker compose --env-file .env -p infra -f infra/docker-compose.yml \
  exec -T api-admin node \
  apps/api/dist/apps/api/src/scripts/collect-commercial-ai-diagnostics.js \
  --since 2026-11-01T10:00:00.000Z --until 2026-11-01T11:00:00.000Z \
  --page-size 100 --max-rows 5000 --max-bytes 50331648 \
  --output-dir /tmp/maxim-ai-diagnostic-new-run
```

Replace the example times and run name with the selected closed cohort. The private
directory is inside `api-admin`; retain it privately before a later container
replacement. Transfer only through the approved private operator channel. Do not
print packs, source text, raw identifiers or predictions into shared logs or Git.
An empty closed cohort remains zero evidence.

Reads are sequential, with a Prisma pool of one plus the dedicated audit-lock
session. Each page and exact receipt lookup uses a read-only transaction, a
ten-second statement timeout and a 250 ms lock timeout. Default pages contain 100
raw rows; the maximum is 500. The total row bound defaults to 5,000 and cannot
exceed 100,000. Published files together cannot exceed the selected byte limit,
at most 48 MiB; this includes JSON escaping, duplicated capture data, the report,
manifest and final run state. A final budget failure publishes no completed pack.

The collection deadline is 120 seconds. No new read starts after it; an already
running read retains its own ten-second statement timeout. `run-state.json`
records the run identity, heartbeat and last successful page sample. A missing
heartbeat, interrupted process, missing exit status or `.partial` file is an
observation gap. Preserve the failed/interrupted run for operator inspection and
start a new bounded run rather than editing its files or fabricating completion.

## Artifacts and source binding

`blind-sources.jsonl` contains only a random `reviewId` and the exact complete safe
text. Freeze blinded reference decisions before opening the other files. It has
no model result, time, detector score, stratum, source ID or deletion hint.

`linkage.private.jsonl` binds each raw capture to its opaque source revision and
exact UTF-8 input hash, with read/update times, observation projection and explicit
omission. `evidence.private.json` is a `CAPTURE_DIAGNOSTIC` bundle with no quality
manifest, human ratings or independent sampling frames. `report.private.json`
is the deterministic diagnostic report. `manifest.private.json` records file
hashes, exact published bytes, counts, limits, omissions and the stop condition;
it is published last. The manifest does not include a self-referential file hash.

The exporter neither re-sanitizes nor substitutes a placeholder and then claims
the same model input. A retained excerpt must be complete, pass the privacy
checker, and match the observation envelope and every attempt by the SHA-256 of
its exact UTF-8 bytes. Unicode normalization is an input change. Invalid metadata,
unsupported sources, privacy refusal, incomplete/missing text, oversized payloads,
expired rows and binding mismatches remain explicit gaps. Expired source contents
and decisions are withheld even if retention pruning has not yet removed the row.
Pre-offer refusals may have no actual observed input or attempt; absence stays
absence. Never construct a synthetic attempt to fill that gap.

General asynchronous captures and dedicated seeded observations may refer to the
same source revision. Preserve all raw capture rows as the observation denominator.
The manifest separately counts unique logical sources, exact exported source
revisions and duplicate bindings. Only the blind source pack deduplicates matching
immutable revision and exact input hash. Conflicting hashes for one revision fail
the export; there is no guessed historical join.

## Own deletion evidence and interpretation

`own-receipts.private.jsonl` contains diagnostic database proofs, separate from
stored observations. Each lookup first uses the unique chat/message intent and
then its exact `COMMERCIAL_LLM_DELETE:<sourceKey>` reason.
Each lookup uses an ordered composite index seek with one candidate, then checks
both exact key components outside the seek; an adjacent intent or reason is
discarded. This keeps absent and late own reasons bounded even when one intent
has many other reasons. Verification requires
the complete real source identity and nonce, exact evidence/input hashes, positive
AI policy permission, matching registered intent hash, that reason's own
`moderationDeleteVerified=true`, and the successful remote-delete timestamp/bot.
A successful independent length reason or a shared intent's success cannot certify
the AI reason. Collection makes no MAX call and changes no observation or intent.

`ownReceiptReasonProofs` counts exact reason proofs. `ownReceiptsVerified` counts
unique physical delete receipts by intent, successful timestamp and bot; multiple
AI reasons for one deletion do not create multiple physical successes. Without a
frozen quality manifest the general quality reporter intentionally leaves these
effects unbound and `confirmedDelete=0`. The separate sidecar is diagnostic proof,
not independent effect certification or an authorization to delete.

The neutral `(observed_at,id)` index limits raw rows before source, expiry or JSON
filtering. Empty filtered pages still advance to the last raw scanned row. Reads
are consistent per page, not one immutable snapshot of the entire live table;
later writes and already expired/pruned captures remain coverage limitations.
`complete=true` means only that this bounded retained-capture window was exhausted.
`ROW_CAP`, `BYTE_CAP` and `DEADLINE` are incomplete stops; `unexportedScannedRows`
keeps rows already fetched but omitted after a cap. `nextCursor` describes raw scan
progress, not a supported resume or proof that those omitted rows were exported.
Use a new reviewed window/budget and a new directory for any subsequent run.

No output installs policy, promotes a model, creates reviewer accounts, replays
webhooks, runs inference, clears Redis, registers effects or publishes messages.
