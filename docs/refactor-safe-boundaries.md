# Safe Refactoring Boundaries

Preserve public API responses, callback payloads, queue envelopes, stored jobs, authorization
and the order of external effects. Verify the affected boundary against the current code and
its focused tests; these contracts do not establish current production acceptance.

Use the [behavior evidence procedure](development/behavior-evidence.md) before changing behavior,
the [release workflow](development-reliability-plan.md) for checks and delivery, and the
[candidate roadmap](operations/plans/2026-11-01-safe-refactoring-roadmap.md) to select a useful
slice. Historical test totals, bundle measurements and release snapshots remain in Git history.

## Validation And Delivery

Find callers and typed test doubles, run affected focused/native cases, then let the commit
helper own the planned aggregate. Preserve compatibility readers and rollback floors. Runtime
changes require exact-SHA CI, scoped deployment and strict smokes. Add monitoring only when the
current task or the affected rollout contract requires it; a previous task's ten- or thirty-minute
window is not a universal release gate. Documentation-only changes need no runtime deployment.

`check:refactor-guards` protects public facades, import cycles and typed runtime capabilities.
Do not grow exception baselines or import legacy implementations outside their thin facades.
Private settings rendering remains separate from Nest input parsing and callback/session ownership.

## Allowlist and rules dependency boundary

The allowlist and rule-text runtimes now accept explicit capabilities. Their composition in
`AdminService` preserves lazy access to constructor-owned clients, cache identity and method
receivers. Rules no longer expose arbitrary property reads/writes or require `as any` calls;
obsolete forwarding methods and copied unused imports have been removed. No new cache or persistence format is introduced.

Focused cases cover denial/no-I/O and transaction/audit/cache ordering. Runtime tests construct these
components independently of `AdminService`. Release verification remains per PR.

## Participants and statistics state ownership

Participant pages, channel statistics and activity dashboards own their response maps and
pending refreshes inside their runtimes. The assembly supplies typed authorization, profile,
client and cross-domain feed capabilities. Participant details reuse the same runtime as
participant lists; no caller constructs a fresh runtime from a legacy object. Pure date,
number, profile and participant-query helpers no longer call back into `AdminService`.
Cache keys, TTLs, authorization
on cache hits and identity checks before failed-promise eviction are preserved.

Existing behavioral cases remain; context-forwarding tests cover the remaining capabilities.
Additional independent channel-statistics cases exercise concurrent reads, revoked cached
access, late failure after invalidation, per-channel invalidation and refresh coalescing.

## Managed entities access and snapshot ownership

Discovery snapshots and coalesced allowlist reads now have one owner with two explicit
capabilities: runtime-scope filtering and the existing uncached loader. User/type keys,
TTL boundaries, clone behavior, first-entity-wins ordering, actor-wide invalidation and
late-rejection identity checks remain unchanged. Access denial mutations live with access
pruning and retain the exact Major bot scope. Refresh presentation is a standalone function.
The managed-entities facade port declares independent signatures. Full discovery orchestration
and SQL query policy remain unchanged.

Independent access-runtime tests cover bot-scope isolation, live capability replacement,
blank identity and best-effort persistence failure. Release verification remains per PR.

## Manual actions and required-subscription capabilities

Manual moderation and required-subscription runtimes now receive explicit capabilities.
Manual notice identity, persisted-result interpretation, error classification and summaries
use independent functions. The group-mute follow-up calls its own runtime directly rather
than round-tripping through a legacy forwarding method. The existing external lease boundary
is unchanged. Delivery-bot capabilities explicitly describe their existing null/undefined
fallback, and ledger views describe the metadata already returned by persistence.

Required-subscription headers reuse the existing equivalent header builder. Catalog merging
accepts an explicit bot-normalization capability and preserves row order, bot scope and
metadata precedence. Neither domain adds a cache or changes queue/ledger/persistence formats.
Independent manual-notice cases verify claim/attempt/send/receipt order, duplicate claims,
lost MAX replies and failed receipt commits. Existing independent subscription epoch/race
cases remain active. Use the affected validation and release scope.

## Broadcast and suggestion delivery capability boundary

Broadcast and suggestion-delivery runtimes receive explicit lazy capabilities. Broadcast
throttle timestamps now belong to each runtime; governor and system-mode warnings retain
one shared 60-second suppression interval within that runtime. Suggestion recovery retains
the existing job identifier, eight attempts, exponential backoff and failed/completed-job
retry behavior.

Broadcast button construction has a separate typed dependency boundary. Chat/channel row
ordering, comments/suggestion flags, bot scope and copied persisted button rows are checked
without constructing `AdminService`. The legacy test facade no longer forwards four private
broadcast methods through `any`; existing occurrence and reconciliation scenarios invoke
the owning runtime. Persisted publication, delivery, callback and queue formats remain unchanged.

## Dialog and suggestion capability boundary

The remaining dialog mapping, suggestion image and suggestion publication contexts now use
explicit dependencies. Parsing, attachment classification, reactions and stored actor
identity are pure functions; generic value readers are shared without importing the manual
moderation runtime. The dialog facade declares independent signatures using the existing
contract types. The unsafe-context exception baseline remains empty.

The corpus captured from the compiled legacy class protects normal and malformed
payload interpretation. Independent tests cover viewer/admin permissions and required
versus legacy image storage. Existing suggestion publication scenarios retain crash,
ambiguous-send and bot-scope coverage. Explicit composition exposed two previously hidden
type mismatches: review synchronization returns a count, and published suggestion text is
always HTML or Markdown. Types now express those existing results; the unreachable plain
fallback is removed without changing generated content or ledger digests.

## Required-subscription UI ownership

The required-subscription controller owns source lookup, refresh state, locally resolved
headers and source-selection actions. The page retains the settings draft; functional
updates preserve unrelated edits. Lookup replies carry chat, generation, request and input
identity, so navigation, unmount and subsequent input invalidate stale effects. Failed
lookup and a full selection reached during lookup preserve the entered link. Server
refreshes no longer discard metadata for unsaved external sources.

The browser suite runs against the extracted controller and real source-input component,
asserting request bodies, delayed success/error, navigation, duplicate clicks, concurrent
draft edits, selection limits and error retention. It also opens the actual settings route
on iPhone/Android in light/dark themes. CI runs this suite in the existing Mini App lane.
Existing mini app tests and production gzip/CSS budgets remain required.

## Settings draft and section-save ownership

`useSettingsDraft` owns the settings draft, hydration baseline, field errors, permission
retry and section conflict state. Section saves retain the source chat and a per-visit
identity, including navigation away and back to the same chat. Cache updates remain scoped
to that source; UI effects require the current visit. The draft present at submission is
kept separately from the normalized request payload, preserving edits made during a save
without discarding prepared stop-word inputs. Saved stop-word buffers clear only if unchanged.

The existing section merge and revision rules, stop-word endpoint and permission rollback
remain in use. Conflict presentation retains the latest draft, including edits made while
waiting. Browser cases cover real PATCH bodies, network failures, version conflicts,
background refresh, late replies, a repeated visit and navigation during conflict refresh.
The existing leave guard receives a setter bound to its originating visit. Speech-style
completion uses the same scoped synchronization. No layout or contract format changes.

## Rules editor ownership

`useSettingsRules` owns the rules draft, validation, image-preparation gate, hydration baseline,
autosave timer, publication mode and reset confirmation. It reuses the existing serialization,
button validation, automatic text generation and save-before-publish comparison. Each network
operation carries its originating visit and chat; stale completion updates/invalidate only
that chat's cache and cannot publish after navigation or show messages on another screen.
Image callbacks and the workspace leave guard use the same scoped draft setter.

Independent browser scenarios cover PUT payloads, edits during autosave, failed-save retry
suppression, navigation between save and publication, late publication results, duplicate
clicks and missing publication links. The real settings route also exercises native image
selection, decoder failure/cancellation, editor closing, save/publish gating, keyboard focus
and native Back across iPhone/Android light/dark and a desktop viewport. These browser suites
run in the existing CI lane; no production chat is used for test publication.

## Publication feed and calendar boundaries

The publication list controller owns URL filters, search debounce, cursor queries, legacy
list presentation and list navigation. Calendar availability has its own target scope,
publication exclusion and daily range refresh. Query keys, limits, polling intervals,
cursor merging and enablement conditions are unchanged; the editor still uses the existing
composer and request identities. A page-size guard prevents the extracted responsibilities
from returning to the page.

Browser scenarios assert server cursors, explicit load-more, filter-specific pagination,
late-query isolation, query suspension while editing, calendar target/exclusion payloads
and filters after editor return. Existing profile-separation and video-upload scenarios
remain required; the new list suite is included in CI.

## Publication action boundaries

The action controller owns cancel/pause/resume, retry-version selection, ambiguous delivery
confirmation and their pending targets. It receives the existing page request-identity owner;
identities survive errors and are cleared only after success, independently per action slot.
Revision conflicts retain the original refresh and feedback behavior. Confirmation sheets
preserve their ordering around publication details, pending guards and native Back handling.
Browser checks exercise actual payloads, duplicate-click prevention, retries after a lost
response, revision conflicts and original/latest content selection through the real API client.

## Publication editor session boundary

The editor session composes the existing local composer and cloud autosave controller. It
owns edit/create/import context, the isolated-edit baseline and saved create draft, close
confirmation, route changes and focus return. The page still owns save/test request identities,
media upload cancellation and submission validation. A successful isolated publication clears
only its matching saved cloud draft before restoring the create draft.

Browser cases cover dirty close/keep/discard, local edits rebased onto a fresh revision,
missing-image restoration, failed opening and local recovery after a failed cloud flush.
The existing direct video-upload browser scenarios retain the real page coverage.

## Closed-chat message moderation boundary

`ClosedChatMessageModerationService` receives explicit intent, semantic claim, guarded-delete,
event and logging capabilities. Chat-only selection, immunity and fresh access checks retain
their positions in the existing event handler. The service preserves intent-before-claim,
execution/event ordering, exact reason keys/metadata and the previous exception boundaries.
Thin legacy delegates keep existing entry-point tests and method interception compatible.

Independent tests cover night/timed/permanent close, storage failures, duplicate claims,
already-absent/unconfirmed outcomes and intent-owned events. The explicit PostgreSQL race
lane also runs the closed-chat suite with real intent persistence, semantic claims and Redis
wakeups, including restarts before/after the claim and execution disabled after persistence.

## Static Settings Search

Private settings search precomputes frozen descriptors and aliases for its static catalog.
Queries receive independent mutable results with the original ordering and result limit.
Do not cache user settings, query results or request state in that process-local index.
Preserve renderer compatibility and caller-mutation isolation. Re-measure the current source
before claiming a performance gain; earlier pure-search timings are not API latency evidence.

The heavy publication editor, review, details, drafts and schedule modules remain lazy-loaded.
Further frontend splitting or API read caching requires a measured benefit.
