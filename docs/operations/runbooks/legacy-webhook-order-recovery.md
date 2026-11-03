# Legacy webhook recovery with permanent holds

Use `vps-connect.sh legacy-cold-recovery <private-request.json>` for the reviewed,
finite abandonment protocol. The former deploy flags `--legacy-order-preview`
and `--legacy-order-apply` and the retired direct controller remain disabled.
Do not invoke native test fixtures or the store writer directly in production.
A diagnostic candidate is not evidence that its historical effects never occurred.
A newly allocated unstarted claim can still belong to an original pre-migration
receipt; source and owner birth define that historical scope, not claim birth.

The operation preserves the original event, claims, settings and unknown action
receipts. `NO_REPLAY_ORDER_RELEASED` and positive `NO_REPLAY_HELD` receipt pointers
mean explicit abandonment under permanent protections; they do not mean execution
succeeded. Participant, global-user and exact-source holds never expire. They
suppress automatic sanctions and deletion for the protected participant. New
post-seal administrator commands use a separate command-only path with persisted
source proof and fresh actor/bot authorization before execution and final notice
send. Unknown historical commands remain blocked. A held author's `Старт` source
message is not automatically deleted.

A fresh direct `user_added` observation for an already protected global member can receive the
existing `POST_SEAL_MEMBER` receipt proof without executing join features. An optional `is_channel`
discriminator must be a real boolean and agree with the exact reparsed normalized source; strings,
unknown fields and altered entity types stay fenced. Its original numeric
MAX timestamp must fall after the seal and at most one second ahead of receipt time; exact raw
and normalized identities, a supported direct shape and the stored semantic key must agree.
Only an unqueued RECEIVED row with zero attempts and no claims qualifies. The exact old
`Legacy scope installation is not sealed` preparation deferral may remain in the immutable
snapshot; other errors, prior effects, unknown shapes and other event types cannot use this join-only path. This
does not install new holds, settle an old execution, update membership, send a welcome or count
as successful moderation. Existing permanent protections and administrator-command checks remain.

A pristine post-seal official `user_removed` has a separate observation-first recovery.
It must preserve the original removed subject (`user.user_id`, never `admin_id`), exact
parser result, event time and every matching sealed scope. Before receipt closure,
normal monotonic SQL membership-denial logic persists the leave observation, removes
only superseded administrator grants, publishes the access epoch to Redis and invalidates
the exact membership cache. Newer grants survive. This work runs outside receipt-lock
transactions; failure keeps the receipt retryable with the finite original hold deferral.
After observation, the reader locks and revalidates the same original receipt digest,
all semantic aliases, claim absence, Publisher journals and independent hold families.
Only then may it write the existing `POST_SEAL_MEMBER` / `NO_REPLAY_HELD` proof.
Ingress alone never closes this type. No ordinary handler, sanction, welcome, binding
activation, suggestion wake, MAX call or historical execution is admitted. Restart and
duplicate preparation repeat only idempotent negative observations. Queued, prepared,
started, malformed, unsealed and concurrently claimed sources remain held. The native
held-removal and membership/full-path regressions cover this boundary.
The join may retain either its exact ordinary semantic key or the exact same-bot/source
`publisher-observation:v1` key. Foreign bot/source keys and unknown namespace versions remain
blocked. This recognizes receipt identity only: it grants no Publisher or moderation authority,
never rewrites the stored namespace and preserves every independent execution claim. A compatible
reader projects the existing sealed hold through normal ingress/preparation; do not rerun the
historical recovery operation or clear the receipt to remove this deferral.

A pristine post-seal direct image/video may omit its caption or carry JSON `null` only when
the complete original source reparses to empty text and strict direct-media validation passes.
This allowance belongs only to projection of an existing permanent hold; historical installation,
modern source abandonment, captionless forwards, commands and unknown content retain their guards.
The exact saved `Legacy scope installation is not sealed` deferral does not itself prove an
execution attempt. A retry of an otherwise valid ordinary held source revalidates the original
envelope, every matching sealed authority, pristine zero-attempt RECEIVED state and absence of
all linked/semantic claims and Publisher journals under the shared admission fences. It may then
record `NO_REPLAY_HELD`, preserving the error, payloads, deadlines and holds. Other errors,
queued or attempted work and incomplete evidence remain blocked. This closure releases receipt
ordering without running moderation, downloading media or reporting successful execution.

A flat post-seal held forward may retain bounded passive formatting on its original outer and
linked text. An empty outer caption may carry only an exact copy of independently validated
linked passive markup. Only `message_created` projection additionally admits strict HTTPS link
markup and one strict linked `share` preview, including its bounded optional title, description
and image URL. The original linked sender remains mandatory. An empty outer caption may copy
only the exact independently validated linked markup; offsets use each original UTF-16 text.
Direct previews, edited-message links/previews, mentions, extra metadata, invalid offsets,
mixed previews and other unsupported media remain refused. Every original text component and
the parser-composed text must be non-command.
Fresh formatted forwards require the same complete pristine receipt, sealed-authority and
concurrent claim/journal checks as saved deferrals above.
Created forwards with a share and no markup require those same checks, including complete
matching sealed scopes, semantic admission fences and absence of Publisher delivery journals.
This projects only an existing hold; historical installation and modern source policies do not
change. It grants no replay, handler execution, image download or new moderation authority.

A pristine post-seal official `message_removed` notification may also receive the existing
`POST_SEAL_MEMBER` / `NO_REPLAY_HELD` proof. This is an explicit decision to abandon notification
execution. The top-level `user_id` identifies the removal actor, never the original message author.
Reparse the persisted original envelope and require exact bot, chat, message, actor and receipt
identity; retain the original payloads, error and digest. A missing sampled raw body is allowed
only when the complete original envelope remains in `normalized_payload.raw` and reparses exactly.
Every matching legacy scope must have a complete matching sealed authority/certificate, with
finite source and receipt clocks after its seal. Saturated or inconsistent scope evidence refuses.
Reconstruct the canonical semantic key independently of the saved key and prove absence of every
linked or semantic execution/command/Publisher source claim inside the receipt transaction.
An exact existing Publisher delivery journal also keeps the notification held, even when its
original source claim is absent. Concurrent admission
must preserve this proof and recheck the persisted receipt before acquiring execution authority.
An old scope deferral is permitted; queued/prepared/started/completed work and other errors are not.

This path preserves every installed hold and unknown historical effect. It invokes no ordinary
removal handler, duplicate-history revocation, message-retention removal handling or MAX action;
it creates neither `PROCESSED` nor an `EXECUTION_FINISHED` checkpoint. Existing webhook-body
retention remains distinct from those product effects and keeps the permanent holds/proof journal.
The persisted proof format and terminal readers remain version 1. Both rollback paths additionally
require the semantic claim fence and final receipt checks in EXECUTION, COMMAND and Publisher
claim writers. Publisher cancellation also locks and rereads the exact receipt in the same
transaction as its delivery-journal update, including transient source-fence failure. An older
writer can add authority or change a journal from a stale snapshot even if it reads the proof
format. New runtime admission is covered by native full-ingress and race regressions.

## Install compatible tooling

All 14 API roles and both native auxiliaries must first run the same reviewed
source and immutable image. The host checkout must be clean at that exact SHA.
This compatibility deployment alone does not remove an old ordering barrier.
Use the normal exact-SHA CI gate, or an explicitly authorized emergency reason;
a successful live endpoint alone is not completed recovery. During a queue incident,
`MAXIM_DEPLOY_API_READY_TIMEOUT_SEC=180` bounds the compatibility rollout wait;
the connector accepts caller values from 180 through 3600 seconds without
weakening readiness or recording a successful release.

All supported runtime entrypoints serialize through the persistent, protected
`/var/lib/maxim-deploy/deploy.lock` inode. Never unlink it. Before the first
PID-lock to flock transition, establish an exclusive operator maintenance window
with no incompatible legacy launcher, backup or repair process. Then run:

```sh
./infra/scripts/vps-connect.sh install-deploy-flock "$MAXIM_REVIEWED_OLD_HOST_SHA"
```

The local exact HEAD is the target. The helper refuses an existing legacy lock,
checks for incompatible processes, holds both protocols while fast-forwarding the
clean checkout, removes only its own PID lock, and proves the inherited flock.
It does not build, start/stop containers or touch SQL/Redis. A failure after source
synchronization requires inspection of the actual HEAD before another attempt.
Never use an old deployment wrapper to synchronize into new lock tooling.

## Bounded admission and cold review

Requests are regular, single-link, owner-only `0600` JSON files, at most 64 KiB.
The online request is:

```json
{
  "version": 1,
  "operation": "preflight",
  "targetSha": "<full-reviewed-commit>",
  "selection": {
    "ownerWebhookEventIds": ["<reviewed-owner-id>"],
    "majorBotIds": ["<all-reviewed-Major-bot-ids>"]
  }
}
```

The host independently derives the Major catalog from the exact admin container;
Publisher is excluded. Selection is finite (at most 200 owners/100 bots). Supported sources are original human plain text in a Major group and a strictly
validated flat forward with text or at most ten complete image/photo attachments.
Direct sources also admit at most ten strict image/video attachments and bounded
passive formatting spans from the official MAX shape. Video URL/token and scalar
metadata must validate; formatting cannot introduce links, mentions or targets.
Commands in direct, forwarded or composed text, replies, unknown fields and
ambiguous provenance refuse. MAX `seq` is opaque int64 metadata; explicit `mid`
supplies identity even when the sequence exceeds JavaScript exact integers. The modern duplicate guard checks both source
authors; retired photo evidence cannot authorize new deletion. Held media jobs
settle without download or repeated deferral.
MAX may deliver the same direct video to different bots with different URL/token
values. After independent strict source validation, mirror comparison ignores only
those two transport fields when the passive numeric video ID is present. Original
per-receipt raw and normalized hashes remain part of the reviewed evidence; a changed
receipt still requires a fresh inventory. This does not authorize replay or media use.
Publisher receipts share the message semantic key with Major. The host attests the
separate Publisher identity from the captured `api-admin` and `api-publisher`
generations and freezes it in the cold binding; never add it to `majorBotIds`.
A matching Publisher mirror may remain untouched only when its original source
matches, its receipt is positively `PROCESSED` within the database snapshot clock,
all queue/retry/legacy-disposition fields are empty, and an exact indexed receipt
lookup proves no execution claim of any kind. Unknown receivers, unfinished
Publisher receipts and missing/changed catalog bindings refuse. This preserves a
completed independent receipt; it neither proves historical effects absent nor
releases automatic-effect holds or authorizes Publisher replay.
The collector uses bounded exact source/claim/mirror reads and reviewed reachable
effect-family guards. It also checks the pending prefix of each selected chat
against the actual receipt materializer in a read-only snapshot: old commands,
started effects, unsupported sources and exhausted budgets refuse before stop.
Cold inventory repeats this prefix check and binds its stable semantic digest.
Preview groups receipt and claim reads in pages of at most 200 exact keys, using
indexed lateral probes; every key, response byte and query shares the existing
total budget. It never scans retained claim history for a batch.
It must report complete source coverage and
`READY_FOR_COLD_REVIEW` before any producer is stopped. A DENY leaves the runtime
running and writes private diagnostic evidence. Do not raise budgets to force an
incomplete inventory through admission. The inventory fence nonce is the SHA256
of the host controller nonce, matching the queue owner token encoding.

For a source refusal, `postgres-audit legacy-order-candidates` schema v2 keeps
the same two indexed first-row probes and adds bounded structure diagnostics for
that one candidate. `source_shape` contains only booleans and JSON type names;
it never includes message text, identities or unknown field names. The 256 KiB
shape ceiling is explicit. These observations neither validate the complete
source nor permit replay, stopping or installation. No extra audit grants apply.
For several independent blockers, `postgres-audit legacy-order-window --explain`
plans a fixed 128-receipt window plus one saturation sentinel and at most 32 chat
predecessors. Review the plain plan, then omit `--explain` for candidate IDs. Chat
grouping occurs only after the bounded status-index read; each chat still exposes
its first actual predecessor, including ineligible fences. Truncation and unknown
sources remain explicit. This window is not a fleet census or recovery authority;
every finite selected owner must still pass online admission and cold inventory.
`postgres-audit legacy-semantic-mirrors [--explain]` diagnoses only that oldest
candidate and at most eight mirrors plus a sentinel using three verified indexes.
It emits fixed equality/type flags, with no media tokens, URLs or content; matching
flags are observations and do not authorize recovery.

For observed moderation outcomes, first review
`postgres-audit moderation-outcomes --explain`, then run the same command without
`--explain`. Its existing read-only role reads the newest 513 indexed moderation
events in 60 minutes and classifies at most 512. The report distinguishes confirmed
remote bans, confirmed remove-only actions, locally installed mutes and confirmed
deletions independently attributed to an active mute. Other or ambiguous evidence
remains explicitly unverified. It emits no identities or message content and needs
no new grants. Counts are lower bounds when truncated; timestamps are event-recording
times, which may include delayed receipt settlement. Empty results, installed mutes
and individual successful actions do not establish current mute state, command
latency, successful processing of every attempt or whole-fleet recovery.

Change `operation` to `prepare` only for an approved selection. Preparation runs
native smokes, repeats fresh online admission, requires a 10 GiB Docker reserve,
and refuses an existing queue fence. Its OCR readiness probe accepts a fresh, purely
queue-backlog failure only when DB/Redis, the OCR worker and verified native identity
are healthy; final recovery and release readiness remain strict. This avoids requiring
an already drained queue before recovery can begin. It writes a durable journal before stopping
exactly the captured 14 API and two native generations. Each must use
`unless-stopped`. PostgreSQL, Redis and unrelated containers are preserved.
The controller pauses/rechecks all 24 webhook queues, collects the authoritative
cold inventory, and leaves producers stopped in `INVENTORIED` for review.

Host identity, monotonic epoch, source/image, exact generations, selection,
controller nonce and inventory/preview hashes are immutable. Private inventory
and proof artifacts are bounded to 8 MiB. SQL query-plan timings and cache costs
may differ on recheck; every semantic source/decision/child field must agree.
Diagnostics are retained separately and never authorize changed source evidence.

## Install, verify and resume

Apply uses the three exact hashes returned by successful preparation:

```json
{
  "version": 1,
  "operation": "apply",
  "targetSha": "<full-reviewed-commit>",
  "expectedJournalDigest": "<reviewed-current-journal-sha256>",
  "reviewedPreviewDigest": "<reviewed-preview-sha256>",
  "reviewedInventoryDigest": "<reviewed-inventory-sha256>"
}
```

Apply independently rechecks stopped identities, queue ownership and the same
inventory. A constrained disposable client installs the certificate and immutable
holds; it has only SQL/Redis credentials, no MAX tokens. The exact client must be
removed before independent positive SQL readback. Lost writer output never
permits replay. Finite indexed materialization then writes positive held receipt
pointers (200 rows/page, at most 200 pages/120 seconds), with another readback.
Only complete protection and chat cursors permit starting the two captured native
containers. Both must report `healthy` within the following 60 seconds, retaining
their captured identities and isolation boundaries, before the 14 captured API
containers start. Inventory commands and polling share that deadline; a healthy
readback finishing at or after expiry refuses startup. Early `starting` or
`unhealthy` probes may recover within the budget but never authorize API startup.
Strict native attestation still precedes queue resume. Three fresh samples must prove healthy DB/Redis,
exact runtime identities and released queues. A purely automatic queue-backlog
failure may remain visible while this positively proved scope completes with
`fleetReady: false`; it cannot stop unrelated chats. Other failures remain contained.
Fleet recovery and release finalization still require strict ready and lag at most
10 seconds; scope completion alone must never be reported as a drained fleet.

Any failure after cold admission attempts to stop the captured runtime first,
remove its exact client, pause its queues and persist the blocked state. It never
starts old images or automatically restores the baseline after a refusal.
Every ordinary deploy, rollback, reclaim and supported topology mutation refuses
while this journal is incomplete, except for the verified empty-install closure
described below; missing/corrupt evidence also refuses.

A separately reviewed empty-install abort may leave the original journal truthfully
at `INSTALLING` and write `legacy-cold-private/<controllerNonce>/empty-install-abort.json`.
The ordinary guard accepts only its final `EMPTY_INSTALL_ABORTED` phase after checking
the exact original journal, all referenced immutable proofs, the same full UNSEALED
certificate snapshot in two empty witnesses, inventory/attestation bindings, the
same stopped and restored 14 API plus two native generations, the owned 24-queue
fence and restart smokes. Backlog-only `fleetReady: false` remains visible and is
not fleet recovery or release acceptance. `EMPTY_INSTALL_ABORTING`, missing proof,
interrupted writes and changed generations remain blocked.

Reading this closure never rewrites the original journal or certificate. All original
journal mutations refuse, including failure containment after a rejected next
admission. A new cold admission first fsyncs an immutable archive containing the raw
journal, marker, sidecar, context, referenced proofs and next admission bindings under
`empty-install-closure-archives/`, then advances the normal monotonic marker. A pending
archive write requires diagnosis and must never be deleted to clear the guard.

When the installed tooling predates closure recognition, synchronize the reviewed
exact-green-CI commit with the normal `vps-connect.sh deploy main --plan` path first.
Plan mode holds the deploy lock and synchronizes tooling without application effects;
the subsequent normal deploy still runs the ordinary guard and its other checks.
This does not authorize installation, certificate edits or a generic journal reset.

A process interruption after installation can be reconciled with the same request
shape and `operation: "reconcile"`, using the current reviewed journal digest.
The host reports fixed stage names, page counts and elapsed times on stderr.
Startup failures additionally identify `stopped_inventory`, `start_native`,
`wait_native_health` or `start_api`. A failed Docker call may include only its fixed
command name (`ps`, `inspect`, `start` or `stop`), an exit code from 0 to 255,
allowlisted spawn code or signal. Semantic failures retain their allowlisted
failure code; unknown errors remain `unclassified_failure`. These diagnostics
contain no source identities, arguments, raw errors, stdout, stderr or inventory
and never substitute for durable proof. Diagnostic failures preserve the original
operation failure and its containment path.
Only `INSTALLING`, `SEALED` or `RESUMING` are eligible. Reconciliation first stops
producers/removes the old client/pauses queues, then reads the existing certificate
independently. It **never creates or installs a certificate again**. An absent,
unsealed or mismatched certificate stays blocked. A positive existing seal may
finish bounded receipt materialization and repeat the same strict restart checks.
A pre-install read/stop interruption can use `operation: "retry-preview"` with
`version`, `targetSha` and the current `expectedJournalDigest`. It re-proves the
same stopped fleet and owned queues, then repeats read-only preview. It cannot
install anything, change an existing reviewed inventory, or restart producers;
`INSTALLING` and later phases refuse this operation. A corrupt/interrupted durable
filesystem write requires separate diagnosis. There is no generic reset,
abort-and-start or bypass command.

## Release acceptance

Cold recovery does not write a current release manifest. After the journal is
complete, use the official `finalize-release-recovery` wrapper to prove all
required component identities, strict smokes and queue-fence release. Record the
actual exact-SHA CI results; never hand-write a successful manifest. Manifest-aware
reclaim normally follows finalization. When disk capacity blocks another recovery,
it may use exactly one complete verified transition as the recovery base after the
previous cold journal is complete. Review its explicit `--dry-run` first (the reclaim
helper defaults to apply); keep the shared lock, ordinary-effect authority check,
all retained images and component history floors. Preserve volumes, rollback images
and sibling projects. See `storage-cost-rollout.md`.

Retain exact release/time windows and distinguish ingress, selection, ordered
waits, held dispositions and confirmed remote actions. No live test messages go
to user chats. Seven-day independent duplicate labels, two-day holdout and
sustained fairness/capacity acceptance remain separate from queue recovery.
