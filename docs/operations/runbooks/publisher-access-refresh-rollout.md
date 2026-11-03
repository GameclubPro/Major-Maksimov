# Publisher Access And Preparation

Use this runbook for current access behavior, bounded diagnostics and the retained
migration recovery procedure. The former expiry-renewal scheduler is retired.
Historical canary parameters are not instructions to restart it or activate a rollout.
See also [publishing contracts](../../development/api-domain-reference.md#publishing-and-outbound-actions)
and [publication diagnostics](publisher-publication-diagnostics.md).

## Current Operation

Confirmed exact-bot and Publisher human ADMIN/OWNER grants are durable. Neither
`checkedAt`, `expiresAt` nor a new miniapp session expires them. Commands read current
SQL authority; explicit exact-member nonadmin evidence, trusted removal and exact bot
access loss still revoke rights. Generic 403/404, partial responses, timeouts and absence
from an administrator roster do not revoke a confirmed human grant. A roster discovers
positive grants; it never copies Major access into Publisher.

Saved home catalogs are local. Opening the cabinet starts no all-chat permissions scan;
selected Publisher settings use the exact stored grant. Major moderation settings retain
their separate fresh authorization boundary. Feature-specific negative evidence, such as
proving that a comment-sanction target is not an administrator, retains its fresh checks.
A stored grant does not waive connection, catalog, policy, lifecycle or final effect guards.
Missing or explicitly denied authority never becomes usable through cached history.

Explicit activation requires fresh bot and human administrator proof. Known denial or
missing baseline capabilities cannot recover merely through a timer or passive webhook.
Retired `scheduled_bot_access` and `binding_maintenance` jobs drain without MAX calls.
Connection rosters and actual missing-evidence work retain their bounded queue paths;
keep SQL/lifecycle/version fences and existing worker concurrency and MAX quotas.

Current publication preflight runs every two seconds with a ten-minute lookahead,
up to eight target nominations per pass and sixteen queued preparation jobs. Two queued
urgent jobs suspend speculative admission; worker concurrency remains two. Deadline
dispatch and preflight each have an independent coalesced slot; other recovery work is
serialized. Preparation serves concrete publication work and nominates genuinely missing
evidence. It never periodically renews existing rights or extends send deadlines.

## Retained Compatibility

Legacy job envelopes, diagnostic obligations and additive migration state remain readable.
A null bot expiry is valid durable evidence, not `missing_proof_identity` or a renewal
obligation. Do not rewrite retained obligations, delete bindings/access edges, clear queues
or reset ambiguous publications to make diagnostics look healthy. SQL evidence and job
completion are neither send receipts nor permission grants. Metrics readers accept the
`reused` bot outcome without counting it as a newly committed proof.

Older `publisher_refresh_v1` measurement bases, expiry-cohort metrics and hourly obligation
reports describe the retired scheduler. Preserve release/window/basis when interpreting
them; never merge incompatible samples or use an empty denominator as successful acceptance.
Both API rollback paths must retain durable authority, activation and current publication
readers. Leave additive columns, indexes and immutable migration receipts in place.

## Bounded Population Census

For a bounded population snapshot, first review the fixed plan, then run:

```bash
./infra/scripts/vps-connect.sh postgres-audit publisher-access-census --explain
./infra/scripts/vps-connect.sh postgres-audit publisher-access-census
```

Schema v2 uses seven exact binding metadata columns, including `bot_access_source`.
After synchronizing the catalog, preview and apply the reviewed audit-role provision
before running it. The publisher metadata group now has 17 exact columns; permission
payloads and user identities are still inaccessible. The primary-key walk stops at
50,001 rows before filtering or aggregation; only 50,000 enter the report.

Cohorts retain their deterministic SHA-256 split for historical comparison. Current
categories are `durable_confirmed`, `activation_required`, `explicit_denied` and
`metadata_unknown`. Old/null expiry does not invalidate a confirmed observation.
Missing/future observation clocks are unknown; pending activation overrides a saved
positive role. Inactive bindings are counted separately. This is **role metadata**:
`permissions=not_inspected` and `actor_authorization=not_inspected` deliberately prevent
using it as a full readiness verdict. Known capability loss and current actor authority
remain runtime checks.

`source_truncated` prevents fleet-wide conclusions. Multiple active bot scopes must be
reconciled with runtime identity before comparison. Timestamps describe observations,
not binding-hours, historical deadline success or permission to send. The census never
repairs, activates, or replays a publication. Historical scheduler acceptance is not a
gate for the current runtime.

## Interrupted Index Migration

If `20261002120100_index_publisher_access_schedule` fails with a lock timeout, leave the
immutable migration unchanged. Synchronize the reviewed recovery tooling only after exact-SHA
CI is green, then run:

```bash
./infra/scripts/vps-connect.sh recover-publisher-access-migration
./infra/scripts/vps-connect.sh recover-publisher-access-migration --apply
./infra/scripts/vps-connect.sh recover-publisher-access-migration
```

Review the preview before apply. The fixed helper verifies the successful additive prerequisite,
both nullable timestamp definitions, the exact failed receipt/checksum and both index definitions.
It only creates missing indexes or reindexes matching invalid indexes concurrently, under the
deploy lock with a 512 MiB table limit, 30-second lock timeout, 120-second statement timeout and
10-minute overall deadline. Unknown drift, competing failures, leftover concurrent-reindex artifacts
or unhealthy runtime abort recovery. Resolution requires both indexes valid and verifies the final
Prisma receipt. No binding/access rows, queues or release journals are changed.

Resume through normal guarded deploy with caller-only `MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE=1`
when the interrupted transition journal requires adoption. Never persist that flag in production
environment. The adoption path must re-prove the exact image and queue fence before release.

## Focused Validation

Select changed callers through the [machine interface](../../development/agent-machine-contract.md).
Relevant cases include [durable selected access](../../../apps/api/src/admin/publisher-selected-access.service.spec.ts),
[roster grants](../../../apps/api/src/publisher/publisher-admin-roster.spec.ts),
[binding refresh](../../../apps/api/src/publisher/publisher-binding-refresh.service.spec.ts),
[preflight admission](../../../apps/api/src/publisher/publisher-publication-access-preflight.service.spec.ts)
and [native access scheduling](../../../apps/api/src/publisher/publisher-access-schedule-postgres.spec.ts).
Native cases require the [test-store wrapper](../../development/agent-local-environment.md).
Preserve tests for explicit denial, missing evidence, proof supersession, retired-job drain,
independent recipient progress and uncertain effects. Local tests do not establish live delivery.

Runtime changes follow the normal impact-selected release and exact-SHA CI gates.
Use a task-specific bounded observation window only when required by that change;
record release identity, missing samples and actual outcome evidence. Census counts,
queue age and successful health checks alone cannot prove all permissions or sends.

### Acceptance protocol for the combined priority refactoring release

This anchor remains for historical references. The 24-hour canary, expiry-renewal
percentages and periodic-roster savings protocol belonged to the retired scheduler;
it is not a current release gate or an instruction to promote `MAX_PUBLISHER_ACCESS_REFRESH_MODE`.
The [original protocol](https://github.com/GameclubPro/Major-Maksimov/blob/932c81a1b195d2c0464285fc92ecc364cc613779/docs/operations/runbooks/publisher-access-refresh-rollout.md#acceptance-protocol-for-the-combined-priority-refactoring-release)
is available in Git history for interpreting that release's incomplete observations.
