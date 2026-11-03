# Incident Playbook

Start read-only. Preserve logs and current state before applying a repair, migration, queue mutation,
DNS change, or container recreation.

Retain only allowlisted aggregates/classifications from production logs, plus exact UTC windows,
release/SHA, failed stage and exit status; do not persist raw logs, message content, identifiers or
credentials. State whether samples are complete, capped, rate-limited or missing. A script returning
zero without every expected stage is incomplete. For a shell script sent over stdin, keep child
commands from consuming the remaining script (`</dev/null` unless that child needs explicit input).

## Common Snapshot

```bash
./infra/scripts/vps-connect.sh doctor
./infra/scripts/vps-connect.sh health
./infra/scripts/vps-connect.sh ps
./infra/scripts/vps-connect.sh monitor-readonly 300 15
./infra/scripts/vps-connect.sh exec 'node infra/scripts/release-manifest.mjs show current'
```

`monitor-readonly` samples local/public health, Compose state, restart counts, canonical `/app/`, and
filtered role logs without reconciling webhooks or sending bot messages.

## Webhook 403 Spike

1. Inspect ingress logs without printing request authorization or secrets:

   ```bash
   ./infra/scripts/vps-connect.sh logs api-ingress 300
   ```

2. Verify that `MAX_WEBHOOK_SECRET_PATH` and `MAX_WEBHOOK_HEADER_SECRET` exist in production env,
   comparing presence/configuration only. Do not print their values.
3. Confirm backend nginx preserves `X-Max-Bot-Api-Secret` and that the public webhook still routes to
   `api-ingress`.
4. Read current MAX subscriptions. If host/domain changed, recreate the intended subscription; do
   not assume MAX rebound its configured secret automatically.
5. Recheck public live and ingress logs. Do not enable long polling while a production webhook is
   active.

## Queue Backlog Or Ready Failure

Before a correction, read the [latency prevention checklist and regression matrix](operations/runbooks/webhook-latency-prevention.md).
The [10 October recovery review](operations/incidents/2026-10-10-webhook-latency-recovery.md)
distinguishes preparation overhead, execution handoff failures and cancellation-tool defects.
Use the affected regression rows; a focused notice-name test pattern alone misses the native
full-path suite. Never remove uncertainty/order fences or clear Redis to repair SQL ordering.

1. Read the local ready snapshots and inspect `checks.queueLag`, dependency state, and per-bot lag:

   ```bash
   ./infra/scripts/vps-connect.sh exec 'curl -fsS --max-time 15 http://127.0.0.1:3001/api/health/ready'
   ./infra/scripts/vps-connect.sh exec 'curl -fsS --max-time 15 http://127.0.0.1:3002/api/health/ready'
   ```

   Read bounded database evidence only through the fixed audit catalog:

   ```bash
   ./infra/scripts/vps-connect.sh postgres-audit queue
   ./infra/scripts/vps-connect.sh postgres-audit activity
   ```

   The activity report groups active work by fixed `query_family` labels, including enqueue
   selection, ordered chat heads, execution claims, and delete intents. Compare several short
   samples with the queue trend; one snapshot does not establish a bottleneck. Raw query text and
   parameters never leave the catalog, and idle sessions are labeled `inactive`.
   `queue --explain` plans the fixed queue query without executing it and keeps the same
   read-only role and timeouts. Both status samples and oldest rows use `(created_at, id)`
   ordering and the exact valid `webhook_events_status_created_at_id_idx`; tied timestamps
   cannot change the selected head. A valid plan alone does not prove completion under live load.
   The queue report also reads only the oldest row per status for its attempt count, remaining
   retry delay, and fixed preparation category. `canonical_pending` or `membership_cache_pending`
   with a growing age calls for preparation-path diagnosis, not extra moderation consumers.
   `oldest_preparation_reason` adds an exact source-defined classification of the last deferred
   preparation error without another table lookup. Namespace recovery, source-proof waits,
   membership invalidation and owner probes remain distinct. Unknown text, prefixes and suffixes
   stay `unknown`; no reason is permission to settle, expire, bypass a fence or replay an event.
   `oldest_ordering_fence=timeout_quarantined` means the oldest message is waiting behind an
   unresolved earlier execution in that same chat. The probe uses the exact ordered-head index;
   never remove the fence or replay the old event merely because its heartbeat deadline elapsed.

   The exact predecessor reports only the fixed `message_created`/`message_edited` event type.
   Its saved `error_family` distinguishes source-defined `canonical_not_ready`,
   `canonical_business_lease_busy`, `canonical_business_lease_lost`,
   `canonical_business_lease_unavailable`, and `rules_publication_fence` failures with anchored
   source formats. A quoted literal inside unrelated error content does not qualify. These labels
   describe the last saved failure; they do not prove current lease authority or a remote outcome.
   `other` remains unknown. No classification authorizes lease expiry, quarantine removal or replay.
   `quarantine_subtype` distinguishes exact `legacy_execution_unverified` and
   `canonical_business_started` markers from source-defined UUID envelopes for `detached_timeout`,
   `unclaimed_detached_completed`, and `unclaimed_detached_failed`. A partial, embedded or malformed
   marker stays `other_pending`; an unrelated predecessor has no subtype. The
   `quarantine_deadline_present`, `quarantine_deadline_expired`, `quarantine_deadline_in_seconds`,
   and `quarantine_deadline_overdue_seconds` fields describe only that receipt's saved timeout
   boundary. An absent or elapsed deadline does not prove that execution stopped or had no effects.
   Never confuse the oldest global FAILED row with this exact same-chat predecessor.
   Source diagnostics expose only `source_marker` (`payload`, `ingress`, `missing`, `other`) and
   `raw_source_present`, which is true only for an original raw object. The `direct_update_*` and
   `direct_message_*` fields inspect only that object's numeric `.timestamp` and direct
   `.message.timestamp`; without a raw object, only an explicitly payload-marked normalized object
   is inspected. Seconds and milliseconds follow the runtime numeric threshold and truncation.
   Signed `*_receipt_delta_seconds` values are positive ahead of receipt time and negative before
   it. `direct_message_shape` describes only the direct node, not the runtime's recursively selected
   MAX message. Strings (including ISO dates), alternative date fields, nested message candidates
   and unavailable sources stay `shape_unknown`; invalid or oversized numbers cannot trigger a
   cast failure. These facts do not prove cutoff admission, all message timestamp checks, claim
   authority or absence of an older semantic mirror. Read migration-cutoff metadata separately
   through the existing `multibot-preparation` catalog.
   This extension reads the already selected predecessor only: no extra table probes, joins or
   grants. Semantic-claim lease/stage/deadline metadata remains unavailable to the audit role.

   Run catalog calls sequentially because they share a lock. The last preparation-capacity marker
   describes that row's most recent deferral, not a fleet-wide cause. FAILED rows may be historical
   quarantine: report fresh deltas separately. Raw readiness, normal/healthy mode, burst state,
   exact images and queue fences must be assessed together; HTTP 200 may be hysteresis.
   For a deferred head with no ordered predecessor, inspect `webhook-source-proof --explain`
   before `webhook-source-proof`: it follows that receipt's own semantic owner, including
   nonordered lifecycle events. `canonical_owner.source_clock` reports only the original
   direct numeric timestamp's signed lead/lag against its receipt, with bounded numeric casts.
   It neither rebuilds the semantic source nor proves cutoff admission or absence of effects.
   A pending unprepared claim and a retained legacy marker require no-replay handling, not
   whole-handler retry; distinguish a never-enqueued copy from its canonical owner.
   Readiness failure does not prevent the fixed read-only queue audit. If a reviewed queue-only
   catalog revision is needed before runtime deployment, transport its exact script bytes over SSH
   stdin into a private `infra/scripts/.maxim-multibot-audit.XXXXXXXX.sh` sibling created by `mktemp`
   in the live checkout. Verify the received SHA256 before executing `queue` with stdin redirected
   from `/dev/null`; EXIT and signal traps remove only that temporary file. Its unchanged relative
   root preserves the live `.env` and Compose context, audit lock, role and time limits. Do not
   replace tracked production files, sync dirty Git state, copy secrets or use this single-file
   path for modes that require helpers from a different revision.

2. Inspect queue-owner logs:

   ```bash
   ./infra/scripts/vps-connect.sh logs api-enqueue 300
   ./infra/scripts/vps-connect.sh logs api-moderation-critical 300
   ./infra/scripts/vps-connect.sh logs api-moderation-background 300
   ./infra/scripts/vps-connect.sh logs api-action 300
   ```

3. Determine whether lag is ingress/enqueue, a moderation shard, action dispatch, Redis, Postgres, or
   MAX API pressure before changing concurrency.
   Internal limiter warnings include the finite `limitScope`: `bot`, `role_class`, `chat`,
   `message_target`, `retention_fleet`, `retention_chat`, `managed_refresh` or `external_cooldown`.
   `unknown` means attribution is unavailable. This is the dimension returned by atomic admission,
   not an inference from an error string. External HTTP 429 still has its separate origin; a local
   cooldown refusal is not another external request. Logs remain coalesced samples, not full counts.
   The diagnostic never grants retry authority or changes configured quotas and deadlines.
   `Moderation executor readiness is waiting` records only finite reason/purpose labels and
   candidate-pass counters. It distinguishes missing local state, probe contention/supersession,
   unknown owner permissions and unavailable eligible candidates. `activationRequiredCount`
   and `capabilityDeniedCount` describe that sampled candidate pass, not permission to activate a
   bot. Records coalesce per reason/purpose/process for 30 seconds; `coalescedObservations` counts
   calls since the previous record, with no chat/bot identifiers or raw error data. These logs are
   not a complete receipt census and cannot attribute an exact queued head without independent
   evidence. A recovery may leave suppressed observations without a final record. No reason
   permits reassignment, deadline renewal, replay or weakening readiness.
4. Prefer the fixed catalog and health snapshots. Do not run raw `psql`, broad `webhook_events` or
   ledger aggregates during live pressure. A new diagnostic shape is code to review and test, not
   an inline incident command.
5. Queue/data mutation requires a separately authorized, bounded repair under the matching
   recovery runbook. Root cause and exact IDs alone do not authorize replay: prove source authority
   and the permitted continuation, preserve unknown effects and ordering fences, and never retry
   an entire handler merely because an event is stale.
6. Ready can lag live while queues drain after deploy. Confirm that effective lag and oldest queued
   timestamps are improving before recreating workers.

7. Compare complete windows of ingress, SQL selection, preparation duration/admission, ordered-head
   progress, retries and action outcomes under comparable load. Rate-limited batch logs are not a
   throughput denominator. Missing samples or low counts remain incomplete. Distinguish urgent
   nomination delay from queue wait after nomination; a completed job is not permission evidence.
   `MAX action failure window summary` records all unignored user-facing failures in its stated
   process-local window, including the first individually logged warning. Group counts retain
   bot/lane/source, classified cause and invocation-owned HTTP evidence; overflow is explicit in
   `unclassifiedFailures`. Do not add first-warning counts to summary totals or sum overlapping
   health windows. Graceful shutdown flushes the current summary; an abrupt process loss can leave
   an unreported partial window. These diagnostics neither alter action metrics nor prove effects.
8. Reproduce a proposed correction with a failing local regression before deploying it. Use real
   PostgreSQL/Redis for query plans, retained-history bounds, leases and duplicate settlement. Stop
   only verified owned collectors during a release change; preserve capacity collection where possible.
   After runtime changes, restart homogeneous acceptance clocks and cycles. Do not retry the same
   unsuccessful deployment without a changed evidenced basis, or replace readiness with a longer
   timeout solely to make a release pass.

See the [3 October 2026 queue review](operations/incidents/2026-10-03-queue-backlog.md) for the
confirmed coupled defects and the limits of their measured attribution.

Accept only closed receipt-created cohorts (`from < until <= observedAt`), with total/status
counts including pending and failed work, sample caps/gaps and invalid-clock exclusions.
Completed-only latency and MAX action outcomes are separate evidence. An empty/future window,
cancellation COMPLETE or startup slot saturation cannot prove recovery or justify more capacity.
The [sustained recovery requirement](operations/runbooks/bot-reliability-recovery.md#capacity-and-acceptance)
still applies after short samples improve.

## API Container Restart Or Failed Rollout

```bash
./infra/scripts/vps-connect.sh ps api-ingress api-admin api-enqueue api-action
./infra/scripts/vps-connect.sh logs api-ingress 300
./infra/scripts/vps-connect.sh logs api-admin 300
```

- Check disk preflight/build contention and the first failing role before retrying deploy.
- Do not recreate Redis/Postgres as an application recovery step.
- If every API/static component already runs the green exact target, all roles are stable, readiness
  recovered, the webhook queues are unpaused and unowned, and only the typed release journal remains,
  finalize without another runtime wave:

  ```bash
  ./infra/scripts/vps-connect.sh finalize-release-recovery main
  ```

  This command fails closed unless the exact runtime, strict API/static/OCR smokes, released queue
  fence, single recovery journal, synchronized HEAD, and green exact-SHA CI are all proven. It does
  not build, migrate, or recreate containers.

- If rollback is required, prefer a retained immutable API component release:

  ```bash
  : "${RELEASE_ID:?Set RELEASE_ID to a retained release manifest id}"
  ./infra/scripts/vps-connect.sh rollback-release "$RELEASE_ID" api-shared
  ```

- This reuses the manifest's exact API image, verifies its image ID and Prisma compatibility, runs
  strict API smokes, and records a new rollback manifest without switching Git or running migrations.
- If no suitable immutable API release is retained, use the ref-based API fallback with a known
  compatible ref:

  ```bash
  ROLLBACK_REF="${ROLLBACK_REF:?Set ROLLBACK_REF to a compatible Git ref}"
  ./infra/scripts/vps-connect.sh rollback-runtime "$ROLLBACK_REF"
  ```

- Stop if an API rollback's Prisma compatibility preflight fails. `rollback-runtime` requires the
  existing Postgres/Redis services, rebuilds API only, and records the resulting API component after
  strict smokes; static components are restored through `rollback-release` without database access.

## Canonical Mini App 502 Or Blank Screen

```bash
./infra/scripts/vps-connect.sh ps miniapp-major-static
./infra/scripts/vps-connect.sh logs miniapp-major-static 300
```

- Check `https://major-maksimov.ru/app/`, not app2/CDN/Object Storage.
- Confirm HTML and hashed JS/CSS assets come from the same deployment.
- `miniapp-static` serves the legacy play-team support host and is not the Major container.
- For a UI regression, reproduce against the local current tree with `npm run screenshots:miniapp`
  or `npm run audit:miniapp:visual` before preparing a new build.
- To restore a retained Major build without rebuilding or running migrations:

  ```bash
  : "${RELEASE_ID:?Set RELEASE_ID to a retained release manifest id}"
  ./infra/scripts/vps-connect.sh rollback-release "$RELEASE_ID" miniapp-major-static
  ```

## Safety Desk Failure

```bash
./infra/scripts/vps-connect.sh ps admin-static api-admin
./infra/scripts/vps-connect.sh logs admin-static 300
./infra/scripts/vps-connect.sh logs api-admin 300
```

- Separate Basic Auth/nginx failures from `api-admin` authorization or application errors.
- Confirm public Major sites still deny Safety Desk/support endpoints.
- Never print the Basic Auth password, `ADMIN_ACCESS_CODE`, forwarded authorization headers, or bot
  credentials while diagnosing.
- For a confirmed Safety Desk static regression, restore its retained immutable component:

  ```bash
  : "${RELEASE_ID:?Set RELEASE_ID to a retained release manifest id}"
  ./infra/scripts/vps-connect.sh rollback-release "$RELEASE_ID" admin-static
  ```

## Redis Restore Or Queue-State Incident

- Preserve and identify the intended Redis volume before stopping either stack.
- Do not start main and scale stacks together.
- After restore/merge, inspect schedule-driven queues before workers resume.
- Rebuild future `night-mode-transitions` from database occurrences rather than restoring stale due
  jobs blindly. Require empty wait/active/failed and no due-now delayed work; persisted
  `NIGHT_MODE_CLOSE_NOTICE` is the idempotency source.

## False-Positive Moderation

- Review the exact moderation event and explainable detector metadata.
- Determine whether the correction belongs to a chat setting, allowlist, commercial fixture/rule,
  or global-spammer review decision.
- Add a regression fixture/test before changing shared scoring or suppressors.
- Do not weaken global thresholds based on one unverified event.

## Domain Allowlist Drift

- Do not normalize or delete production rows with ad hoc SQL during an incident.
- Reproduce canonicalization against a bounded sample, encode the correction as an idempotent
  migration or reviewed repair script, and test exact-host/subdomain plus `EXACT` semantics first.
