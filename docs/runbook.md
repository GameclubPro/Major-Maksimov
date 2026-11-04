# Production Runbook

This is the active production entrypoint. Select maintained references through the
[documentation index](README.md); dated reports do not establish current production state.

## Production Shape

- Main stack: `infra/docker-compose.yml` with Postgres, Redis, fourteen shared-image API roles,
  `miniapp-major-static`, legacy support `miniapp-static`, and `admin-static`.
- Canonical mini app: `https://major-maksimov.ru/app/`, served by `miniapp-major-static`.
- Closed Safety Desk: `https://admin.major-maksimov.ru/`, served by `admin-static` behind Basic Auth.
- Public health/webhooks terminate at `api-ingress`; `/api/v1/` and owner APIs terminate at
  `api-admin`.
- CDN, Object Storage, and app2 are not production deploy or smoke targets.

Publisher private greetings use the `publisher-start` queue on `api-publisher`. The worker requires
enabled dispatch, attested Publisher identity, and healthy dispatch. Events older than one day are
discarded; retained jobs carry a pre-send marker that prevents replay after an ambiguous send or
worker restart. Do not remove that marker or manually retry a greeting that already attempted send.

Old-message cleanup uses the isolated `api-message-retention` role and `message-retention`
queue. It defaults off; follow [the retention rollout gates](operations/runbooks/message-retention-rollout.md)
before enabling capture or deletion. It never shares the critical moderation deletion lane.

## First Deployment

1. On the VPS, create root `.env` from `.env.example` and set real database, MAX, webhook, admin,
   and security values. Treat it as dotenv, not a shell script.
2. On the operator machine, create ignored `.env.vps` from `infra/env/vps.env.example` and configure
   the SSH target/repository path.
3. Verify access:

   ```bash
   ./infra/scripts/vps-connect.sh doctor
   ```

4. Deploy the manifest-selected production components:

   ```bash
   ./infra/scripts/vps-connect.sh deploy main --auto
   ```

   The local wrapper requires successful `Required` and `Analyze JavaScript and TypeScript` checks
   from trusted main-push GitHub Actions for the exact selected local `main` SHA and requires the
   synchronized VPS `HEAD` to match. It prepares and preloads the selected CI-tested GHCR images,
   applies Prisma migrations only when API is selected, recreates the selected application
   containers, and runs strict health/smoke checks before recording the release. Follow the
   [current deploy and preload procedure](development/production-operations-reference.md#deploy-and-rollback).

5. Let the ingress reconciler create MAX webhook subscriptions from `MAX_WEBHOOK_BASE_URL`. The
   canonical webhook shape is
   `https://major-maksimov.ru/api/webhook/max/<bot-id>/<MAX_WEBHOOK_SECRET_PATH>`.

Run
`MAXIM_EXPECTED_DEPLOY_SHA=<full-reviewed-sha> ./infra/scripts/vps-pull-build-up.sh main [services...]`
directly only from the backend VPS. That low-level script does not query GitHub CI by itself, so
routine operators use the guarded local wrapper or the acknowledged operator-fallback workflow. A
mutating direct invocation without the expected full SHA is rejected; only `--plan` may omit it.

## Routine Access

Production is the REG.RU dedicated server via `maxim-vps`, not the retired Yandex VM.
Use the [production profile](operations/runbooks/reg-production-profile.md) for hardware,
storage, access recovery and capacity changes. The server also hosts Svyazka and Karavan.

```bash
./infra/scripts/vps-connect.sh health
./infra/scripts/vps-connect.sh ps
./infra/scripts/vps-connect.sh logs api-ingress
./infra/scripts/vps-connect.sh monitor-readonly 300 15
./infra/scripts/vps-connect.sh postgres-audit all
```

`npm run vps -- <command>` and `npm run prod -- <command>` call the same wrapper.

### Durable capacity summaries

`monitor-readonly` runs one bounded, privacy-safe capacity sampler independently from its heavier
diagnostic samples and records the summaries on the operator machine. The capacity cadence defaults
to 15 seconds and must remain between 15 and 60 seconds; override it with
`MAXIM_MONITOR_CAPACITY_INTERVAL_SEC`. Run for at least five minutes to evaluate sustained alerts:

```bash
./infra/scripts/vps-connect.sh monitor-readonly 600 300
```

The default archive is
`${XDG_STATE_HOME:-$HOME/.local/state}/maxim/capacity-monitor`. Override it only with an absolute
local path through `MAXIM_MONITOR_CAPACITY_ARCHIVE_DIR`. Set
`MAXIM_MONITOR_CAPACITY_BLOCK_DEVICE` when monitoring another host. The default is REG.RU's
NVMe RAID1 device `md1`, shared by the root and cold filesystems. A missing device is an
unavailable sample, not zero utilization. CPU count is hardware threads (24 on this host),
not physical cores; the host has 12 physical cores.

The archive contains only allowlisted numeric, boolean, and fixed-enum readiness, queue-fence,
memory, filesystem, swap, CPU, block-device, aggregate action-health, and API fleet summaries.
Action-health counts are retained only when `total = success + failure`, `critical <= failure`, and
both rates match their counts; malformed or old snapshots use `null` rather than plausible zeroes.
Fleet records contain only counts for the source release's expected singleton/running roles (normally
14; supported pre-Publisher/OCR rollback releases have 11, 12, or 13), exact `APP_SERVICE_NAME`/`APP_ROLE`
identity plus protected-image/owned-Compose-name matches, exact-image matches, duplicates, restarts,
and unexpected API containers split into main, scale, and manual/foreign counts. They never contain
role names, container names or IDs, env values, image refs, or SHA values. The archive never stores
service logs, URLs, request data, event/job
identifiers, bot/chat/user identifiers, payloads, or secrets. Full monitor output is not copied into
this archive. By default it is written to a private random local file only while the monitor runs and
is removed on exit. To retain it for a reviewed incident, set
`MAXIM_MONITOR_LOG` to an absolute, previously unused path inside an existing owner-private
directory; the monitor creates it as `0600` and refuses existing targets. Remove a retained raw log
as soon as the review is complete.

Restart evidence separates API, OCR and photo container totals from changes between
observations. One remote request-driven collector keeps at most the expected API and native
container generations in memory; identities never enter its output or the local archive.
The first observation, a new session, a gap over 90 seconds, an invalid/missing class,
counter decrease or container replacement has unknown delta. A proved replacement is marked
separately, even when total counts happen to match. Other classes retain their own evidence.
Historical native totals alone do not establish a current API failure or a timeout cause.

The stream accepts one bounded request at a time. The sampler checks its owner generation
at least once per second while waiting, rejects partial/oversized/unsolicited replies and
archives each complete JSON response separately. EOF, signals and connection failure cancel
owned work; cleanup waits for children. Sessions have a 90-second idle lease and 3600-second
TTL, with planned rotation before expiry. A new session begins with unknown deltas.
Use synchronized exact-green tooling on the VPS before starting this stream; older remote
tooling fails the sample rather than providing a one-shot baseline. The probe's one-shot CLI
remains available for historical totals with unknown interval evidence.

Summary files are private hourly `capacity-YYYYMMDDTHH.jsonl` files. Each update is written through
a private temporary file, fsynced, and atomically renamed. Files older than 14 days are removed;
the archive is additionally capped at 337 hourly files and 240 records per hour. Unknown files
in the directory are never removed. Inspect the archive without `jq`:

```bash
CAPACITY_ARCHIVE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/maxim/capacity-monitor"
find "$CAPACITY_ARCHIVE_DIR" -maxdepth 1 -type f -name 'capacity-*.jsonl' -mtime -1 -print
```

Every sample prints explicit `clear`, `pending`, `firing`, or `unknown` outcomes for:

- one-minute host load per CPU above 0.85 for five minutes and above 1.25 for two minutes;
- I/O wait above 15% for five minutes and above 30% for two minutes;
- available memory below 25% for five minutes and below 15% for two minutes;
- swap-in activity for five minutes and swap use above 10% for five minutes;
- block-device utilization above 80% for five minutes and above 95% for two minutes;
- less than 40 GiB free on the Docker filesystem;
- ingress/admin readiness, stale queue-metrics fallback, queue-metrics availability, automatic
  normal mode/no burst (a manual override warns even when set to `normal`), the allowlisted
  `healthy|queue_backlog|max_api|mixed|stabilizing|manual|unknown` condition, queue lag above 10/30
  seconds, a paused or owned webhook queue fence, and a missing/stopped/duplicate/wrong-identity/
  wrong-image API role. Any unexpected main, scale, or manual/foreign MAXIM API container also fires
  the topology alert. Version 2 `api_fleet_restarts` warns about confirmed API interval changes;
  `ocr_native_restarts` and `photo_native_restarts` report their own changes. Each carries an
  explicit interval basis. Legacy version 1 alerts retain their historical-total basis; they
  cannot prove a current restart or a healthy interval. Unknown generation evidence stays
  `unknown`. The archive never stores the free-form system-mode reason.

Sustained alerts require a continuous series with no gap above 90 seconds. Full diagnostics cannot
delay that series because the dedicated sampler runs in its own lifecycle-bound process group. The
sampler never overlaps probes; if a capacity probe itself stalls long enough to cross the continuity
limit, the window resets instead of inventing data. A current breach remains `pending` until its full
window is observed; missing or malformed allowlisted fields are `unknown`. Archive failure is
reported as a failed monitor step but does not suppress the remaining read-only diagnostics.
The slower BullMQ census includes active webhook/action/Publisher/OCR queues plus the retired
`moderation-default` and `vk-parsing-publish` regression sentinels; non-zero sentinel work requires
review and must never be deleted as an automatic monitoring response.

For `api_fleet_topology`, use the fixed `capacity-api-fleet` counters before taking action:

- `observed`, `singleton`, `running`, `identity`, `exactImage`, and `duplicates` isolate expected-role
  absence, stopped/duplicate containers, runtime identity drift, and image drift. Review
  `./infra/scripts/vps-connect.sh ps --all`, the current release manifest, and the queue fence before
  choosing the normal guarded deploy or immutable rollback.
- `unexpectedMain` is visible through `./infra/scripts/vps-connect.sh ps --all`.
- `unexpectedScale` can be confirmed without image refs or container identifiers with
  `./infra/scripts/vps-connect.sh exec docker compose -p infra-scale -f infra/docker-compose.scale.yml ps --all --format '{{.Service}} {{.State}}'`.
- `unexpectedManual` covers manual, unlabelled, or foreign-project containers carrying MAXIM API
  identity, image, protected-label, or owned-name signals. Stop automated recovery and use the
  reviewed break-glass shell to identify the exact container; do not print that inventory into a
  retained monitor log or delete a guessed container.

For `api_fleet_restarts`, compare the archived counter trend with the bounded service log window;
do not recreate a role merely to clear its restart counter.

An interactive VPS shell and direct PostgreSQL CLIs are reviewed break-glass paths, not routine
diagnostics. Keep the authorization in the invoking process only and supply a non-empty reason:

```bash
MAXIM_VPS_DATABASE_BREAK_GLASS=1 \
  MAXIM_VPS_DATABASE_BREAK_GLASS_REASON='reviewed incident recovery' \
  ./infra/scripts/vps-connect.sh shell
```

Never persist those variables in `.env.vps`. Use `postgres-audit` for queue, activity, and
identifier-free Antiduplicate evidence.

Provision or re-harden the dedicated audit role after the reviewed source is synchronized to a VPS.
The first command is preview-only; `--apply` is the explicit database mutation:

```bash
./infra/scripts/vps-connect.sh postgres-audit-provision
./infra/scripts/vps-connect.sh postgres-audit-provision --apply
./infra/scripts/vps-connect.sh postgres-audit all
```

The role has exact table grants for the original queue audit, exact column grants for the bounded
Antiduplicate report, aggregate activity visibility, read-only resource defaults, and a single
connection. It does not receive `pg_read_all_data`. Run
`./infra/scripts/vps-connect.sh postgres-audit duplicate` for capped settings, recent moderation,
and recent delete-intent aggregates. Every section reports its cap and whether a count is complete
or only a lower bound.

For disk attribution, use the opt-in
[`postgres-audit storage` report](operations/runbooks/postgres-storage-audit.md).
It measures table/index files through catalogs and statistics without scanning
application rows; `--explain` previews its plan. It is excluded from `all`.

## Bot Auto-Delete Access-Ambiguity Recovery

When the closed dashboard reports recent auto-delete `access-ambiguous` ledger rows, run the
admin-only bounded discovery as a dry-run in the `api-admin` runtime environment:

```bash
npm run moderation:repair-bot-auto-delete-presence --workspace @maxim/api -- --discover-access-ambiguous --json
```

The command examines at most 20 `moderation_notice` rows from the last 24 hours, verifies each exact
DELETE-to-SEND ledger chain, and performs a fresh exact MAX message lookup. Treat its output as
sensitive because the explicit operator command includes target identifiers. Apply only after the
dry-run contains the expected candidates and production is healthy:

```bash
MAXIM_REPAIR_ACTOR_ID='reviewed-operator-id'
npm run moderation:repair-bot-auto-delete-presence --workspace @maxim/api -- --discover-access-ambiguous --apply --actor-user-id "$MAXIM_REPAIR_ACTOR_ID" --json
```

Apply rechecks and locks both ledger rows before creating the audited durable delete intent. A
changed ledger, unavailable MAX lookup, missing active origin membership, or unsupported candidate
fails closed. Keep `MAXIM_REPAIR_ACTOR_ID` in the invoking shell only, rerun the dry-run after apply,
and never retry the terminal action-ledger job directly.

## Legacy VK Publish Queue Retirement

After the release that removes every `vk-parsing-publish` producer and worker is active, preview the
one-time Redis cleanup:

```bash
./infra/scripts/vps-connect.sh vk-parsing-retire-legacy-queue
```

The preview is read-only. It reports fixed BullMQ counters and worker counts; absent counters also
require a complete bounded scan of every `bull:vk-parsing-publish:*` key. A clean exact source
descending from the producer retirement, fourteen running API generations and both healthy native
auxiliaries must match the immutable API image before and after the command. The shared deploy
lock protects that source/fleet binding; this does not claim a green release manifest.

For ordinary indexed queue state, apply only after the preview shows no legacy worker:

```bash
./infra/scripts/vps-connect.sh vk-parsing-retire-legacy-queue --apply
```

Apply holds the shared deploy lock, refuses a live worker, pauses only `vk-parsing-publish`, then
rechecks that worker and active counts are zero before calling BullMQ obliteration with `force`
disabled. If active work remains, the command fails and deliberately leaves the legacy queue
paused. A namespace proved completely absent is a successful no-op. It
does not query or mutate Postgres and never touches `vk-parsing-sync` or `vk-parsing-publisher`.
Obliteration uses batches of 1,000 with a 120-second wrapper deadline. A timeout can leave a
partially removed queue paused; inspect it again and repeat the same apply command after review.

If counters are absent but initial orphan job hashes remain, the preview reports
`would_remove_never_started_orphans`, `orphanCount` and `previewDigest`. Review that evidence and
use its exact digest:

```bash
read -r -p 'Reviewed preview digest: ' reviewed_digest
./infra/scripts/vps-connect.sh vk-parsing-retire-legacy-queue --apply --reviewed-digest "$reviewed_digest"
```

This branch never pauses or obliterates a queue. It accepts only the exact six initial hash fields
and historical producer envelope/options; attempts, results, unknown fields, expiration, locks,
logs, flow/repeat dependencies or ordinary queue keys prevent admission. Hash shape proves only
retained queue state; it never establishes a prior MAX outcome or modifies action journals.
Two complete equal reads must match the reviewed source/fleet/content digest. Each batch of at
most 32 fixed hashes then compares all six original field values atomically before deletion.
Changing indexed state cannot fall back to ordinary obliteration. A final complete scan must
prove absence; a lost acknowledgement or late key requires a fresh preview and digest review,
because removal may be partial. Uncertain commands are never automatically resent.

Every full namespace pass caps Redis at 12 million keys, `SCAN COUNT 4096` work hints at 16 million,
4,096 pages, 10,000 matched keys, 4 MiB of returned key bytes and 32 MiB of hash values, under
15 seconds. COUNT is advisory; every page and hash batch separately limits bytes and server work.
A Redis script or observed call over 50 ms refuses acceptance. The caller's absolute deadline
also gates each delete inside Redis and expires before the fixed 120-second host timeout.
Missing, exceeded or incomplete evidence never authorizes partial-scope cleanup.
Keep the legacy queue in `monitor-readonly` as a zero-count regression sentinel after cleanup.

## Legacy Default Webhook Queue Retirement

After the sharded `moderation-default-0..15` release is active, preview the retired unsharded queue:

```bash
./infra/scripts/vps-connect.sh moderation-default-retire-legacy-queue
```

The preview is read-only and reports aggregate counters only. It requires the exact clean active
post-sharding API release, the complete 14-role fleet, a released webhook queue fence, healthy
ingress/admin endpoints, no legacy worker, an allowlisted bounded historical job cohort, unpaused
active shards, and primary-key-bounded PostgreSQL proof that every referenced webhook event is
`PROCESSED`, `DUPLICATE`, or absent. Review that result before applying:

```bash
./infra/scripts/vps-connect.sh moderation-default-retire-legacy-queue --apply
```

Apply holds the shared deploy lock, attests `api-enqueue` as the sole production enqueue role,
briefly stops it, then takes a fresh private snapshot and repeats the database proof. It pauses only
`moderation-default` before non-forced obliteration and refuses any job carrying BullMQ flow,
parent, repeat, or dependency linkage. A referenced in-container watchdog expires before the outer
host timeout. After an ambiguous remote exit, cleanup waits past that deadline and attempts a fresh
Redis settlement barrier before restoring `api-enqueue`; restoration still proceeds after the
deadline if the barrier is unavailable, while the command remains failed for operator review. The
EXIT path requires two stable exact-fleet/readiness samples with an unchanged restart count. It
never replays jobs, changes PostgreSQL, restarts Postgres or Redis, or touches the active shards. If
deletion does not complete, the remaining legacy queue stays paused; if obliteration completed
before a later postcheck failed, the queue is already absent. After either error, rerun the aggregate
preview before reviewing the same apply command as recovery. An already absent queue is an
idempotent success. Keep `moderation-default` in the append-only rollout queue registry and
`monitor-readonly` census as a zero-count regression sentinel.

If REG.RU SSH is blocked, verify the destination and host/provider firewall, then use its
server console/IPMI if necessary. Leave Yandex security-group settings unset in the production
`.env.vps` and keep `MAXIM_VPS_AUTO_AUTHORIZE_SSH=0`; the legacy `ensure-ssh`/`yc-shell` recovery
path does not manage REG.RU.

## Submit And Deploy Gate

The submit helper is staged-only by default. On the task branch, stage the intended paths, then run:

```bash
git add --patch
./infra/scripts/local-commit-push.sh "describe the change"
```

It runs staged-impact validation, commits, and pushes the exact resulting `HEAD`. `--all` is an
explicit broad-staging option. All root/scoped `AGENTS.md` files are excluded from `--all` unless
`--include-agents` is present, and the helper refuses already-staged agent notes without that flag.

The routine local deploy path resolves the requested branch to a full SHA and queries GitHub for
successful `Required` and `Analyze JavaScript and TypeScript` checks from GitHub Actions on that exact commit. The same SHA is passed to the VPS, which refuses
the rollout if its post-sync `HEAD` differs. The legacy initial source-gate exception requires both
`MAXIM_DEPLOY_EMERGENCY_BYPASS=1` and a non-empty `MAXIM_DEPLOY_EMERGENCY_REASON`; registry evidence
and the final production gate remain required.

## Focused Deployment

```bash
# Read the manifest-based component plan without deploying
./infra/scripts/vps-connect.sh deploy main --plan

# Deploy every component selected since its recorded source SHA
./infra/scripts/vps-connect.sh deploy main --auto

# Request the canonical mini app
./infra/scripts/vps-connect.sh deploy main miniapp-major-static

# Request the closed Safety Desk UI
./infra/scripts/vps-connect.sh deploy main admin-static

# Any API role request expands to every shared-image API role
./infra/scripts/vps-connect.sh deploy main api-ingress
```

Contract changes normally require all API roles plus affected public/admin clients. Do not deploy
`miniapp-static` for ordinary Major work.
Explicit service arguments are not exclusion lists: cumulative manifest reconciliation can also
select pending components. Inspect `--plan` and follow the
[component-selection rules](development/production-operations-reference.md#deploy-and-rollback).

Any API role expands to all fourteen roles and both native auxiliaries. A genuinely static-only
deploy reuses its verified image without running API migrations. The deploy compares each active
component's recorded source SHA with the target and adds unreleased affected components, so an
explicit service list cannot silently leave known component impact behind.

Shared API builds fail closed when any Docker input differs from `HEAD`, whether tracked, staged,
untracked, or Git-ignored. Commit or remove the input before a deploy or ref-based rollback. A new
intentional Docker exclusion must be reviewed together with the deploy guard allowlist so the image
revision label always describes its actual contents.

Nginx site changes are applied separately after config review. For the closed admin site:

```bash
./infra/scripts/vps-apply-major-admin-site.sh maxim-vps
```

Before applying `maxim.play-team.ru` nginx config, compare it with the live backend file because
sibling application routes may exist there.

## Sibling Marketplace

Svyazka is an independent MAX mini app at `https://major-maksimov.ru/market/`.
The canonical nginx site strips `/market/` and proxies to `127.0.0.1:4311`.
Its `svyazka` Compose project, PostgreSQL volume, immutable source releases, and
secrets under `/var/www/svyazka` are not part of MAXIM deploys or database audits.
Use the separate MAX-MARKET repository's deployment runbook for that service.
Preserve the `/market/` location when changing the canonical nginx site. A routing
smoke is `https://major-maksimov.ru/market/api/health`; it must identify `svyazka`.
Only `/market/api/media` accepts photo uploads up to the 9 MiB nginx envelope;
the marketplace validates a single JPEG/PNG up to 8 MiB. Other API routes remain
limited to 64 KiB. Marketplace publication workers are separate from MAXIM roles.

## Health And Smoke Checks

- Local ingress live: `http://127.0.0.1:3001/api/health/live`
- Local ingress ready: `http://127.0.0.1:3001/api/health/ready`
- Local admin live/ready: the same paths on `127.0.0.1:3002`
- Public live: `https://major-maksimov.ru/api/health/live`
- Canonical mini app: `https://major-maksimov.ru/app/`
- Local Safety Desk static: `http://127.0.0.1:3004/`

Public `/api/health/ready` is intentionally hidden. During API rollout, ready can recover later than
live while queues drain; observe it before declaring failure.

## Commercial OCR Rollout

Production must keep `COMMERCIAL_OCR_ROLLOUT_MODE=shadow` unless a real, production-temporal,
independently adjudicated schema-v2 corpus passes the enforcement gates and produces a currently
valid Ed25519-signed certificate for the exact active source and immutable image. Schema v1,
synthetic/public data, a locally improvised annotation set, an unsigned certificate, or a signature
from any key other than the provisioned trust anchor can support diagnostics only and can never
authorize production deletion. Recognition may use the installed `rus+eng` Tesseract data, but the
first enforcement cohort is runtime-limited to two Cyrillic-only OCR passes. Latin, mixed, unknown,
phone-only, incomplete, or ambiguous results remain report-only. The service does not persist OCR
text, source pixels, or MAX image URLs in Redis, Postgres, or ordinary logs.

Each native OCR pass has one continuous 10-second Tesseract budget. The sandbox verifies its
dedicated process group after normal completion, but every forced timeout/output-limit path retires
the entire sandbox container so a descendant that escaped that group cannot survive in the cgroup.
The UDS client watchdog is bounded beyond the native budget; a lost response may therefore surface
as retryable `worker_unavailable` while the sandbox restarts.
Queue-capacity, worker-startup, shutdown, IPC, and transient download failures remain eligible for
the queue's bounded three attempts. Keep raster preprocessing at 3 MP / 2000 px, processor and
native-worker concurrency at one, `OMP_THREAD_LIMIT=1`, and the role CPU ceiling at `1.0` until a
new corpus and production-throughput review justifies changing them.

This timeout policy is behavior version `tesseract-rus-eng-v2`. Keep the same version across every
API role. A version transition intentionally rejects older queued jobs and invalidates older OCR
delete bindings instead of evaluating them under different recognition behavior.

Deploy and both rollback paths read that behavior identity from the target API source, export it
over any `.env` value, and verify it on all 14 effective and running API roles. They stop the old
`api-media-analysis` before its sandbox, recreate and attest the target no-network sandbox, and run
the real UDS Sharp/Tesseract raster smoke from a one-off media client before starting media analysis
or producer roles. A target that predates
the sandbox removes the auxiliary and uses the legacy smoke branch; a target that predates the OCR
role removes both. Treat any missing or non-literal target version, image/boundary mismatch, or
non-`shadow` effective commercial rollout mode as a failed deployment; do not edit `.env` to bypass
the gate.

Image-text stop-list enforcement introduces an irreversible API rollback floor. Both immutable and
ref-based API rollback require binding version 1 and the explicit image-text pre-dispatch delete
guard in the target source before any image build or runtime mutation. A pending delete intent can
outlive an environment downgrade, so `shadow` is not authority to bypass this floor; choose the
first guarded shadow release or a newer compatible release instead.

`IMAGE_TEXT_STOP_LIST_OCR_ROLLOUT_MODE` is the independent emergency ceiling for this opt-in path:
`off` skips analysis, `shadow` records no executable image-text intent, and `on` permits delete-only
enforcement after the per-chat toggle and sandbox checks pass. A reviewed change to `shadow` or
`off` also stops pending image-text-only intents at dispatch. Commercial OCR promotion, downgrade,
and recovery commands do not change this setting; never use them as its kill switch.

Keep the eval corpus outside Git or under `artifacts/commercial-ocr-private/`. Schema-v1 manifests
remain readable for diagnostics, but enforcement certification requires schema v2 with temporal
source provenance, frozen split/cluster membership, image digests, transcripts and script labels,
two independent reviewers (three for tie-break adjudication), critical evidence tokens, and an
expectation for every certified settings profile. Holdout representatives are shared across
profiles but each profile is certified independently; results must never be pooled. An image digest
may repeat only inside its owning cluster and can never supply evidence to another split or cluster.
The report records the manifest digest, exact Git/dirty state,
OCR/preprocess/policy/detector fingerprints, runtime/native dependency versions, traineddata
digests, and effective OCR resource settings.

Each certified profile requires 5,103 independent holdout representatives: at least 500 expected
enforcement deletes and 4,603 expected no-actions. Every required hard-negative category must
contain at least 100 cases across at least 60 independent clusters:
`rules_or_moderation_context`, `spam_complaint_or_fraud_warning`, `news_or_analytics`,
`brand_mention_only`, `private_one_off_sale`, `ordinary_recruitment`,
`public_training_or_help`, and `request_or_recommendation`. Each of the nine enforcement-supported
commercial subtypes requires at least 25 positive clusters. Certification permits zero commercial
or enforcement false deletes, zero hard-negative false deletes, and zero adversarial mismatches.
The adversarial split must contain at least 100 cases across at least 60 independent clusters; the
remaining recall, incompleteness, and one-sided exact confidence-bound gates are enforced by the
checked-in evaluator. `captionLanguage` remains a diagnostic slice, not deletion authority.

Evaluation and approval are separate trust domains. Run the corpus evaluation in an ephemeral,
no-secret environment built from the reviewed immutable image; freeze its certification request,
transfer only that bounded metadata request, and destroy the eval environment before signing. A
separate trusted host/principal owns the dedicated Ed25519 private key and runs only the sign-only
CLI. Never copy that private key to the eval host, VPS, repository, container, `.env`, shell
arguments, report, request, or certification artifact. The signer requires an independently reviewed
SHA-256 of the exact request bytes before it opens the key. `--approval-private-key-file` accepts only
a bounded regular owner-only file, opens it with `O_NOFOLLOW`, verifies that it is Ed25519, and clears
the loaded byte buffer after use. Provision only the corresponding public trust anchor in production as
`COMMERCIAL_OCR_CERTIFICATION_APPROVAL_PUBLIC_KEY_BASE64`: it must be the exact canonical base64 of
the Ed25519 public key in DER SPKI form, with no PEM wrapper, whitespace, or line break. The active
image verifier rejects an empty, malformed, non-Ed25519, or different public key. Treat trust-anchor
rotation as a reviewed configuration change and issue a new certificate with the matching private
key.

Run the reviewed gate with `--enforce-cyrillic-gates`, the exact clean source SHA, and the reviewed
64-hex immutable API-image digest without the `sha256:` prefix. The evaluator records and validates
the supplied digest but does not query a registry, so the operator must verify it against the
immutable artifact before starting the run. Case-level `--concurrency` defaults to `1` and is
bounded to `1..4`; case workers retain at most one raw image each while OCR pass results are reused
across settings profiles. Keep concurrency at `1` on the resource-capped production role. Higher
values are for an isolated eval host only. Before the enforcement run, independently freeze and
review both the benchmark-environment descriptor from a diagnostic run in that exact environment
and the SHA-256 key ID of the approved public DER SPKI key. The enforcement run receives only those
public digests and has no access to the private key:

```bash
: "${IMMUTABLE_API_IMAGE_SHA256:?set the reviewed 64-hex digest without the sha256 prefix}"
: "${BENCHMARK_ENVIRONMENT_SHA256:?set the independently reviewed environment descriptor digest}"
: "${COMMERCIAL_OCR_APPROVAL_KEY_ID_SHA256:?set the reviewed public-key DER SPKI digest}"
umask 077
npm run moderation:run-commercial-ocr-eval --workspace @maxim/api -- \
  --manifest artifacts/commercial-ocr-private/manifest.json \
  --enforce-cyrillic-gates --concurrency 1 \
  --immutable-image-sha256 "$IMMUTABLE_API_IMAGE_SHA256" \
  --source-sha "$(git rev-parse HEAD)" \
  --benchmark-environment-sha256 "$BENCHMARK_ENVIRONMENT_SHA256" \
  --approval-key-id-sha256 "$COMMERCIAL_OCR_APPROVAL_KEY_ID_SHA256" \
  > artifacts/commercial-ocr-private/eval-result.json

node -e '
  const { readFileSync, writeFileSync } = require("node:fs");
  const result = JSON.parse(readFileSync(process.argv[1], "utf8"));
  if (result?.gates?.passed !== true || !result?.certificationRequest) process.exit(2);
  writeFileSync(process.argv[2], `${JSON.stringify(result.certificationRequest)}\n`, { mode: 0o600 });
' artifacts/commercial-ocr-private/eval-result.json \
  artifacts/commercial-ocr-private/certification-request.json
```

Freeze the exact `certification-request.json` bytes and have a second reviewer independently compute
and approve their lowercase SHA-256 in the external change record. On the separate trusted signing
host, use that reviewed digest verbatim; do not derive it inline in the signing invocation:

```bash
: "${REVIEWED_CERTIFICATION_REQUEST_SHA256:?set the independently reviewed lowercase digest}"
: "${COMMERCIAL_OCR_APPROVAL_PRIVATE_KEY_FILE:?set the owner-only Ed25519 private-key path}"
umask 077
npm run moderation:sign-commercial-ocr-certification --workspace @maxim/api -- \
  --request-file artifacts/commercial-ocr-private/certification-request.json \
  --expected-request-sha256 "$REVIEWED_CERTIFICATION_REQUEST_SHA256" \
  --approval-private-key-file "$COMMERCIAL_OCR_APPROVAL_PRIVATE_KEY_FILE" \
  > artifacts/commercial-ocr-private/certification.json
```

The strict certification envelope expires 30 days after the evaluated report and must be issued
within 24 hours of it, so extracting or copying an old request cannot extend its authority. The
request and certificate contain only bounded metadata and digests: the passing gate profile, report,
corpus manifest and provenance, source/image, audit tool, and OCR behavior. Keep the eval result,
request, and certificate private and attach their SHA-256 digests to the external review record. The
certificate also binds every independently gated settings profile by its ID, canonical settings
fingerprint, and metrics digest. The normalized unique
fingerprints are sorted and bound as `certifiedSettingsFingerprintSetSha256`, calculated as SHA-256
of `fingerprints.join("\n") + "\n"`. The rollout verifier additionally requires at least 24 hours of
certificate validity to remain.

After the exact `certification.json` bytes are frozen, a second reviewer must independently compute
and approve their lowercase SHA-256 through the external change record. Use that reviewed value as
the promotion argument; do not generate the argument inline from the candidate file during the same
promotion invocation. The local wrapper recomputes the file digest and stops before SSH if it differs
from the independently reviewed value.

Sharp/libvips and Tesseract run only in `ocr-native-sandbox`, which has no network, API identity,
runtime env file, or secrets. The media worker sends bounded frames over the project-scoped Unix
socket; only those two services may mount that volume. The sandbox has its own cgroup limits,
verifies normal process-group teardown, and recycles its whole container after forced native
timeouts. This removes the prior structural boundary blocker, but the old evaluation and
certificate do not cover this implementation. Keep production Commercial OCR in `shadow` until the
sandbox-backed runtime/native identity is evaluated and freshly certified.

Changing the environment ceiling alone cannot authorize deletion. An enforcing ceiling also
requires a fresh shared runtime-control document with exact chat IDs, a compare-and-set revision,
operator/reason metadata, the reviewed `certificationSha256`, the exact sorted
`certifiedSettingsFingerprints`, their `certifiedSettingsFingerprintSetSha256`, the verified
`certificationExpiresAt`, and an expiry no more than 24 hours away and no later than that certificate
expiry. The current sensitivity/warn/delete settings are fingerprinted at runtime, while
the filter-enabled flag is checked separately; enforcement is allowed only when that current
fingerprint belongs to the certificate-bound set. Legacy controls without these bindings are invalid.
Missing, invalid, expired, unreadable, uncertified, or settings-mismatched control downgrades intent
creation and intent execution to shadow. Keep the control TTL shorter than the reviewed observation
window and renew it with a new revision; do not use a wildcard or an unbounded expiry. The guarded
rollout requires at least 10 minutes initially and proves that at least 5 minutes of the same logical
expiry remain after producer restart.

An explicit revocation, missing or expired control, policy change, author immunity, or changed
message terminalizes the old delete intent so it cannot become actionable again later. A transient
Redis, MAX, or immunity-check failure performs no deletion but remains retryable only within the
intent's bounded retry horizon.

The OCR decision path reloads settings immediately before committing a durable delete intent and
binds the policy plus control revision/expiry into that intent. Every execution retry runs the OCR
guard on both sides of the dispatch marker. After its fresh MAX author/content and participant
immunity checks, the final guard reloads settings, local-admin state, immunity timezone, current
settings fingerprint, and runtime control again and requires the same bound control revision and
expiry. A mid-flight change or unknown authorization state therefore performs no MAX delete.

Use the guarded VPS wrapper for the first canary. Put one reviewed exact numeric MAX chat ID per
line in a local file; blank lines and `#` comments are allowed. Supply the extracted passing
certification from the same immutable image evaluation plus the independently reviewed certificate
SHA-256. The normalized comma-separated cohort must also fit below the guarded 96 KiB environment
entry ceiling, leaving margin below Linux's per-string execution limit. The wrapper transfers both
bounded files over one framed SSH stdin stream and exposes only their SHA-256/count metadata, never
their content in process arguments or logs. The verifier runs from the exact active `api-admin`
image and rejects an expired, failed, unsigned, untrusted, reprofiled, source/image-mismatched,
behavior-mismatched, malformed, settings-set-mismatched, or digest-mismatched certification before
any rollout mutation. The wrapper then takes the shared deploy lock and checks the active release
manifest/image/SHA/version across all 14 API roles.
Promotion additionally requires an empty OCR queue across waiting, active, delayed, prioritized,
paused, and waiting-children states, plus zero admission units and no held reservations. The
read-only preflight checks that state once. An applied promotion checks it again only after all seven
webhook moderation roles that can produce OCR work have stopped, closing the enqueue-to-control
race. It scans admission metadata in bounded pages and fails closed on excess size, timeout, concurrent
mutation, or an incomplete scan; raw reservation identifiers and values never leave Redis. It also
rejects running orphan, legacy, foreign-project, ambiguous, or duplicate API containers. Recovery
may stop only an unreviewed container with the exact `infra` Compose project/service identity or an
unlabelled exact `infra` container name. A foreign or ambiguous container blocks the operation and
is never stopped or killed; explicit legacy `APP_ROLE=all` containers are included in that
fail-closed inventory. Exported caller rollout variables are removed before Compose interpolation,
so the atomically patched production `.env` remains the only source for
`COMMERCIAL_OCR_ROLLOUT_MODE` and `COMMERCIAL_OCR_CANARY_CHAT_IDS`.

Read the privacy-safe control kind, exact revision, cohort count, logical expiry, and
remaining lifetime before choosing an operation. This command never prints chat IDs or audit text:

```bash
./infra/scripts/vps-connect.sh commercial-ocr-status
```

Promotion and downgrade are read-only preflights without `--apply`:

```bash
: "${REVIEWED_CERTIFICATION_SHA256:?set the independently reviewed lowercase 64-hex digest}"
CHAT_IDS_FILE=./reviewed-chat-ids.txt
CERTIFICATION_FILE=artifacts/commercial-ocr-private/certification.json
./infra/scripts/vps-connect.sh commercial-ocr-promote \
  "$CHAT_IDS_FILE" "$CERTIFICATION_FILE" \
  "$REVIEWED_CERTIFICATION_SHA256" none
./infra/scripts/vps-connect.sh commercial-ocr-promote \
  "$CHAT_IDS_FILE" "$CERTIFICATION_FILE" \
  "$REVIEWED_CERTIFICATION_SHA256" none --apply
```

If a prior successful clear left the environment in `shadow` with a missing positive revision
fence, pass the exact revision reported by `commercial-ocr-status` instead of `none`. Expiry does
not restore the environment ceiling: first run guarded downgrade with the expired/missing revision,
then read status again and use the incremented missing revision for a later promotion. Promotion
atomically patches the production environment file with the OCR mode and canary allowlist, then
recreates and verifies every role; the OCR-specific delete-intent lane derives its authority from
those same two OCR variables. It recreates the 12 non-media roles in the reviewed order, attests the
unchanged sandbox, starts `api-media-analysis` last, and verifies readiness and identity/mode/image
parity for all 14 roles plus the auxiliary. The HTTP-serving `api-ingress`, `api-admin`, and `api-media-analysis` roles must answer
their internal ready endpoint twice across a five-second stability window. Every role, including
the ten headless queue workers, must keep exactly one running container with the same container ID
and restart count across that window. Every readiness `docker compose ps`, `docker exec`, and
`docker inspect` call has a host-side timeout
clamped to the same absolute readiness deadline, including its kill grace. Promotion
then stops the exact seven OCR producer roles, proves the queue and admission state drained again,
performs the runtime-control CAS, restarts those producers, and repeats the 14-role
readiness/parity/stability check. A CAS conflict means another operator changed the control; stop
and review status instead of retrying blindly. The wrapper also re-reads the control after producer
restart and refuses to complete if its revision, cohort, logical expiry, or minimum remaining
lifetime changed. The authoritative drain uses an absolute 180-second wall-clock budget by default;
each Redis probe is clamped to the remaining budget, so a slow scan cannot multiply that window by
the retry count. Keep the code deploy and promotion as separate change records. Redis stores the
active TTL document and revision fence, not immutable operator history.

Emergency downgrade uses the same CAS discipline and clears runtime authority before changing the
environment or recreating roles. It accepts an active, expired, or already-missing control only when
the supplied revision exactly matches the persistent fence. An invalid public snapshot may enter
preflight only when it still exposes that positive fence; the Redis CAS can clear it only when the
stored low-level v1 document and revision remain parseable and consistent. Malformed JSON, a
missing or malformed revision, or a document/revision mismatch remains fail-closed and requires the
recovery and repair flow below. The CAS clear advances the fence even when expiry has already
removed the TTL document, so expiry never blocks restoration of the environment ceilings:

```bash
ACTIVE_REVISION=1 # replace with the exact revision reported by commercial-ocr-status
./infra/scripts/vps-connect.sh commercial-ocr-downgrade "$ACTIVE_REVISION"
./infra/scripts/vps-connect.sh commercial-ocr-downgrade "$ACTIVE_REVISION" --apply
```

The applied command proves the revision increment, atomically patches the environment file to
`COMMERCIAL_OCR_ROLLOUT_MODE=shadow` with an empty `COMMERCIAL_OCR_CANARY_CHAT_IDS`, recreates all
roles with media analysis last, and verifies readiness/parity/restart stability. If Redis is
unavailable during preflight, enforcement already fails closed and the wrapper stops before
environment mutation. Recovery is armed before a clear can be dispatched, so a Redis failure after
that boundary conservatively patches the environment back to shadow and may recreate API roles even
when the clear outcome is unknown. The wrapper never restarts or recreates Redis. If a later
promotion step fails after `.env` mutation, it attempts the same full shadow recovery and reports a
critical error unless all 14 roles are proven ready and shadowed.

Recovery is armed before either set or clear can be dispatched to Redis. If a mutation outcome is
ambiguous, the wrapper restores and verifies shadow ceilings across all 14 roles before returning an
error. Recovery first quiesces `api-action`, all seven OCR producers, and only detected unreviewed API
containers with proven `infra` ownership. Foreign or ambiguous API-like containers remain untouched
and prevent quiescence from being proven. Recovery must prove that stopped inventory before patching
`.env` or recreating anything; after that boundary, it attempts every role even when one recreation
fails. It reports success only after all 14 roles pass readiness, restart stability, image, identity,
version, and shadow parity; otherwise it proves the enforcement-capable roles stopped again or
reports that quiescence could not be established.

If promotion was interrupted before the first control CAS (`missing`, revision `null`), the control
is invalid, or ordinary automatic recovery could not be proven, use the dedicated environment-only
reconcile. It never mutates Redis and is a preflight without `--apply`:

```bash
./infra/scripts/vps-connect.sh commercial-ocr-recover-shadow
./infra/scripts/vps-connect.sh commercial-ocr-recover-shadow --apply
./infra/scripts/vps-connect.sh commercial-ocr-status
```

Applied environment-only recovery attempts enforcement-role quiescence before validating the exact
release manifest/image/source fence. If that fence is unavailable or invalid, it leaves proven
quiesced roles stopped and performs no environment patch or recreation; repair the release inventory
before retrying reconciliation.

After recovery, clear an active, expired, positive missing, or low-level parseable invalid revision
through guarded downgrade if needed. Any invalid Redis control that the guarded CAS cannot clear
remains fail-closed and requires a separate reviewed control-store repair before promotion; do not
delete or rewrite its keys ad hoc.

Every API image build in CI starts the compiled sandbox without network or secrets and sends the
compiled raster smoke from a separate container over the read-only client side of the UDS volume
before the image can be packaged. API deploy and rollback repeat exact `rus`/`eng`, runtime
isolation, process cleanup, and media-to-sandbox raster smokes. After deployment, confirm media is
live/ready, exactly one sandbox is healthy on the same image, neither restarted, and Commercial OCR
still receives the `shadow` ceiling. Audit the terminal timeout count separately from retryable OCR failures and compare native-worker
restarts, queue wait p95, OCR duration p95/p99, and CPU seconds per image with the prior release. Do
not raise rollout during the code deployment.

The internal `api-media-analysis` readiness response exposes privacy-safe `checks.ocr.rolloutMetrics`.
Process counters and the latest 512 first-attempt queue waits, stage durations, and attempted-image
cgroup CPU samples remain bounded in process memory. Counters are also durably aggregated in Redis
under the OCR/preprocess/policy/detector behavior fingerprint, both for the behavior release and
15-minute buckets over a 24-hour window. They contain no OCR text, pixels, URLs, arbitrary errors,
or chat/message identifiers. `observed` is cumulative since `processStartedAt`, while `sampled`,
`oldestSampleAt`, and `newestSampleAt` describe the bounded percentile population. Queue wait is
recorded only when BullMQ first moves a job to active, so retries and governor deferrals cannot
inflate it. CPU evidence must come from the sandbox cgroup around the request that reached native
OCR. A media-container cgroup delta no longer includes Tesseract and is not valid candidate evidence.
Compare sandbox CPU only while it remains single-concurrency; unavailable or media-only CPU evidence
blocks the performance gate.

Capture a baseline with at least 100 sampled first-attempt jobs and 100 sampled attempted images
immediately before deployment. Capture the candidate only after its new process has observed at
least 100 of each. Each command is read-only and writes only an operator-local artifact:

```bash
./infra/scripts/vps-connect.sh exec \
  'docker compose --env-file .env -p infra -f infra/docker-compose.yml exec -T api-media-analysis node -e '\''fetch("http://127.0.0.1:3001/api/health/ready").then(async (response) => { const body = await response.json(); if (!response.ok || !body?.checks?.ocr?.ready) process.exit(1); console.log(JSON.stringify({capturedAt:new Date().toISOString(),ocr:body.checks.ocr})); }).catch(() => process.exit(1));'\''' \
  > artifacts/commercial-ocr-private/rollout-before.json

# Run the same command after deployment with rollout-after.json as the output path.
```

For the first shadow deployment that introduces `rolloutMetrics`, the previous image cannot provide
a comparable baseline. Record that absence explicitly in the change record; do not fabricate or
substitute host-wide metrics. Keep the deployment in `shadow`, apply every absolute candidate gate
below after 100 samples, and retain the accepted candidate snapshot as the baseline for the next
release. A bootstrap snapshot without a comparable baseline can never support an enforcement
promotion.

Fail closed and keep `COMMERCIAL_OCR_ROLLOUT_MODE=shadow` if any candidate condition holds:

- fewer than 100 new `queueWaitMs.observed` or `cpuSecondsPerImage.observed` samples;
- `queueWaitMs.p95 > 30_000`, `nativePassDurationMs.p95 > 10_000`, or
  `nativePassDurationMs.p99 > 10_500`;
- `cpuSecondsPerImage.p95 > 20.0` or any CPU sample is unavailable;
- candidate `counters.restarts - counters.recycles > 0`, or candidate retryable
  `worker_unavailable`, `tesseract_failed`, and `capacity_exhausted` failures total more than 1% of
  candidate `nativePassDurationMs.observed`;
- candidate p95/p99/CPU is more than 25% above a baseline built from at least 100 samples.

Timeouts remain a separate quality/coverage signal because a 10-second timeout is terminal and
fail-open, not a retryable infrastructure failure. These operational metrics can reject a release;
they can never authorize deletion. Enforcement remains blocked until the separately reviewed,
real independently adjudicated schema-v2 corpus gate passes, the exact valid signed certificate is
verified against its independently reviewed SHA-256 and active trust anchor, and an operator
deliberately changes the rollout control.

## Release Inventory

Mandatory release components are `api-shared`, `miniapp-major-static`, and `admin-static`;
installed Lastik adds the optional `eraser` component. Their immutable local image refs use
`maxim-api`, `maxim-miniapp-major`, `maxim-admin`, and `maxim-eraser` with the full source SHA tag.
The inventory under `/var/lib/maxim-deploy` stores each component's source SHA, image ref, exact
Docker image ID and registry provenance, together with applied migrations and successful smokes.

Unchanged component records carry forward into the next manifest. `current.json` is replaced
atomically only after every selected service runs the expected image ID and all selected strict
smokes pass. A failed build, recreate, or smoke therefore does not promote the candidate release.
At least five release manifests are retained.

Inspect the current manifest and retained IDs from the operator machine:

```bash
./infra/scripts/vps-connect.sh exec 'node infra/scripts/release-manifest.mjs show current'
./infra/scripts/vps-connect.sh exec 'ls -1 /var/lib/maxim-deploy/releases'
```

## Interrupted Release Finalization

When a guarded deploy completed every runtime recreation and released the webhook queue fence but
timed out before recording `current.json`, do not repeat the build, migrations, or container waves.
After readiness has recovered, finalize the already-running exact release through the guarded local
wrapper:

```bash
./infra/scripts/vps-connect.sh finalize-release-recovery main
```

The wrapper requires green `Required` and `Analyze JavaScript and TypeScript` checks for the exact
local SHA, then runs the existing host finalizer without pulling or synchronizing the VPS checkout.
The finalizer fails closed unless the clean VPS `HEAD` and `origin/main` already equal that exact SHA,
exactly one complete typed recovery journal exists, and the current manifest is absent. It verifies
the target refs and image IDs for all 14 API roles, `miniapp-major-static`, and `admin-static`; rejects
duplicate or ambiguous API containers; proves all 24 webhook queues are unpaused with no rollout
owner; runs strict local/public live and ready, Major/Safety Desk static, and Commercial OCR
shadow/language/raster/internal-readiness smokes; and rechecks runtime identity, restart stability,
images, queues, and the journal before commit/archive. The committed manifest records a bounded,
read-only snapshot of the currently successful Prisma migrations rather than inheriting the stale
journal list.

This command never builds, migrates, starts, stops, or recreates a container. If queues remain paused
or owned, any runtime component is not already on the exact target, or readiness is still red, stop
and use the normal reviewed deploy/rollback recovery path. Do not hand-write `current.json` or archive
the journal manually.

## Immutable Release Rollback

Prefer a retained immutable release over rebuilding an old ref. Omit component names to restore all
three active components, or name any subset of `api-shared`, `miniapp-major-static`, and
`admin-static`:

```bash
: "${RELEASE_ID:?Set RELEASE_ID to a retained release manifest id}"
./infra/scripts/vps-connect.sh rollback-release "$RELEASE_ID" miniapp-major-static
```

The rollback refuses unknown/mutable component records, missing local images, and image-ID
mismatches. When `api-shared` is selected it also requires the recorded API source commit, existing
Postgres/Redis readiness, and every already-applied Prisma migration. A static-only rollback needs
only the retained image and recorded image ID; it does not depend on Git or database availability.
The script force-recreates only selected component services, verifies their image IDs, runs strict
API/Major/Safety Desk smokes as applicable, and records a new current rollback manifest.

This path does not switch the VPS Git checkout, build an image, or run Prisma migrations. If an
attempt mutates a service but does not record the rollback manifest, it invalidates stale
`current.json` inventory. If any preflight or smoke fails, stop and investigate; do not replace the
recorded image or bypass the compatibility check.

## API Ref-Based Fallback Rollback

Use the ref-based helper only when no suitable retained immutable API release exists. It supports API
runtime roles only:

```bash
ROLLBACK_REF="${ROLLBACK_REF:?Set ROLLBACK_REF to a compatible Git ref}"
./infra/scripts/vps-connect.sh rollback-runtime "$ROLLBACK_REF"
```

It requires the current Postgres and Redis services to be running and ready, then checks that the
target contains all Prisma migrations already applied. Before switching the VPS checkout it
preserves the current Compose file and release/smoke helpers, so historical Compose cannot recreate
stateful services. Before switching refs or building, it applies the same 10 GiB API build-capacity
floor as a normal deploy. It builds a SHA-scoped shared API image, runs the API migration command,
recreates all API roles by default with implicit Compose builds disabled, verifies image IDs, runs
strict health checks, and records the rolled-back API component in a new release manifest. It cannot
restore either static component. If an attempt changes runtime but does not reach a recorded
manifest, stale `current.json` inventory is invalidated so the next deploy fails closed. Do not use
`deploy main` as a substitute for rolling back a selected ref.

If migration compatibility fails, stop and prepare an explicit database/runtime recovery plan. Do
not bypass the preflight or attempt an ad hoc destructive migration rollback.

## Stateful-Service Safety

- Do not recreate Postgres or Redis during ordinary application deployment.
- API deploy requires both services to be already running and ready; it fails closed instead of
  starting either service.
- Use `postgres-audit` for fixed, indexed, bounded production diagnostics; never improvise broad
  webhook/ledger aggregates during incidents.
- After any Redis data restore, audit delayed/waiting/active/failed queues before starting workers.
- Backup/restore timers remain disabled until their separate volumes and capacity preflights have
  completed successfully.

## Docker Space Reclaim

Run `./infra/scripts/vps-docker-space-reclaim.sh` only after reviewing disk and release inventory.
The helper holds the deploy lock, validates every retained manifest, preserves image IDs/refs from
those manifests and every container, and removes only old unused immutable MAXIM release refs. It
does not prune shared BuildKit cache, generic images, containers, or volumes.

The shared component-aware preflight preserves 10 GiB free for an API rollout and 6 GiB for a
static-only rollout; mixed releases use 10 GiB. The API floor is 10,737,418,240 bytes. Percentage
thresholds report warning or critical storage pressure but do not block a sufficient absolute
reserve. When every selected local image ref exactly matches the verified target commit
(`maxim-api:<sha>`, `maxim-miniapp-major:<sha>`, and/or `maxim-admin:<sha>`), the normal deploy uses
the same absolute component reserve and runs in reuse-only mode:
runtime recreation uses `--no-build`, and a target image that disappears after the preflight aborts
the rollout instead of falling back to a build. Manual, full, mixed API/static, missing-image,
wrong-SHA, and unknown targets receive no mode-based bypass; each selected exact image must be
present. Runtime rollback always receives the API floor. Scale deploy applies the relevant floor
before creating/copying its Redis volume or stopping the main stack. The legacy percentage emergency
override never bypasses an absolute component floor, and `MAXIM_DEPLOY_DISK_MIN_FREE_BYTES` can only
raise it.

Required online multibot migration preparation has a separate 10 GiB admission and
supervised reserve on every involved data/temp/WAL/Docker filesystem. Its modeled
index/sort/WAL peak remains visible as advisory information, rather than a higher
admission threshold. Production preparation uses the host supervisor, bounded
non-overlapping capacity samples and a unique PostgreSQL session tag. Lost reserve,
unavailable samples, device drift or interruption abort only that preparation
attempt; old API roles stay live and failed receipts/partial indexes are preserved.
The reserve is sampled, not a guarantee against disk exhaustion between checks.
See [multibot preparation](operations/runbooks/multibot-reliability-rollout.md).

Normal deploy prepares missing exact-main images in CI and preloads verified GHCR digests under
the shared deploy lock before runtime changes. Pull admission requires the component rollout
reserve plus twice the tested image size; preload does not bypass that reserve. The
[deploy and preload procedure](development/production-operations-reference.md#deploy-and-rollback)
owns the commands and admission gates; [CI image delivery](development/ci-image-delivery.md)
defines exact-SHA CI, publication, provenance/SBOM and separate digest/image-ID evidence.
