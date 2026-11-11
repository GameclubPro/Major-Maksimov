# Feature Regression Map

Use this map to find focused checks without resuming completed implementation plans.
Read the applicable agent notes, [product decisions](miniapp-product-decisions.md),
[API contracts](api-domain-reference.md) and changed callers first. These are starting
points, not an exhaustive test selection or evidence that a current run passed.

Unit and integration files below use the [focused runner](agent-machine-contract.md#focused-checks-before-submission).
Native PostgreSQL/Redis cases require the [test-store wrapper](agent-local-environment.md).
Browser scripts run directly with Node; inspect their server setup before execution.
Local preview and MAX Bridge shims do not prove live rights, delivery or physical-device behavior.
The impact planner and staged commit helper still own final validation.

## Participants And Moderation UI

The temporary MAX API notice uses an absolute campaign deadline, shared across bot profiles;
acknowledgement is mirrored per verified user and campaign on the device. Design preview excludes live notices.
It must close at expiry
and remain absent after acknowledgement or expiry. Check [time boundaries](../../apps/miniapp/test/max-api-notice.test.ts)
and [entry, acknowledgement and mobile layout](../../apps/miniapp/test/max-api-notice.browser.mjs).
The browser case owns its local Vite server and uses a fixed clock, so it remains valid after expiry.

Keep participant state bound to chat, filters and cursor. Cached first pages must keep
their own cursor; retries cannot skip pages or show another chat's rows. `totalCount`
is audience size, not search matches; the selected period changes violation counts,
not historical membership. An unavailable roster does not prove an empty chat.
Settings overview entries follow the [current design](../miniapp-settings-overview-design.md),
including its prohibition on summary/status copy in menu entries.

| Boundary                                                     | Focused checks                                                                                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Feed identity, pagination, stale responses, retry            | [Feed unit tests](../../apps/miniapp/test/chat-participants-feed.test.ts), [browser](../../apps/miniapp/test/participants-feed.browser.mjs)            |
| Restriction list, accessible actions, keyboard and scrolling | [Moderation layout](../../apps/miniapp/test/moderation-design.browser.mjs), [participant sheet](../../apps/miniapp/test/participant-sheet.browser.mjs) |
| Current bulk-apply selection and confirmation                | [Settings apply](../../apps/miniapp/test/settings-apply-target.browser.mjs)                                                                            |

These browser cases require an existing local Vite server. Set `MINIAPP_TEST_BASE_URL`
to its `/app/` URL; the scripts have different default ports. Run only the affected cases
and stop the server owned by the task afterward. Use the scoped miniapp visual workflow
for light/dark, narrow screens, native Back and safe-area review.

## Rules Publication

A new rules post may follow a reset only after the exact pending deletion is confirmed.
Unknown SEND outcomes, unconfirmed deletion and concurrent replacement remain fenced.
An accepted reset keeps the published receipt visible; it is not a deletion confirmation.
Private-bot reset feedback also requires a returned result without a message ID or URL before
announcing completion; a retained receipt or missing response cannot prove deletion.
Reset responses and bounded readbacks preserve the current revision and unsaved local text.
A revision conflict pauses automatic saves across further typing; only unchanged server content
permits rebasing a dirty draft to a newer receipt revision. Late reads cannot replace newer writes.
Actionable errors must remain fully readable on narrow screens.

| Boundary                                                                 | Focused checks                                                                                                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Explicit new post after reset, exact absence, unsafe continuation        | [Rules unit](../../apps/api/src/admin/admin-chat-rules.spec.ts), [settings callers](../../apps/api/src/admin/admin-settings.service.spec.ts)     |
| Concurrent publication and worker/reset finalization, fresh revision     | [Rules PostgreSQL](../../apps/api/src/admin/admin-chat-rules-postgres.spec.ts)                                                                   |
| Private-bot reset feedback and current persisted response                | [Private control](../../apps/api/src/moderation/private-control.service.spec.ts), [admin caller](../../apps/api/src/admin/admin.service.spec.ts) |
| Pending deletion, dirty draft, scoped refresh and mutation serialization | [Rules browser](../../apps/miniapp/test/settings-rules.browser.mjs), [draft state](../../apps/miniapp/test/settings-rules-state.test.ts)         |

The rules browser owns its local Vite server and cleanup. Native cases require the disposable
test-store wrapper. See the [rules cleanup runbook](../operations/runbooks/rules-publication-cleanup.md)
for the bounded production metadata report; local checks do not confirm delivery in a user chat.

## Sanctions And Participant Activity

Commercial category settings, participant grants, text preview and advertising journal use
the [commercial policy regression map](commercial-ads-policy.md#focused-verification).

The sanctions register reads the maintained moderation feed with bounded candidates,
not raw webhooks. Active sanctions are independent of the event journal's selected
period; the archive covers the year after completion. Keep the last authoritative
sanction state, subsequent `SANCTION_STATE_FENCE` transitions and manual releases
outside ordinary history cleanup. Dedicated cleanup uses only its remaining budget
and must not resurrect an older mute. Missing original evidence remains reviewable,
never fabricated or automatically restored.

Source-evidence checks preserve the native row and block budgets on compact,
retained and cleared source history. A small returned page must not hide repeated
scans of unrelated history. Missing sources stay visible for review with no
release action. Native plans also cover a missing source followed by a long deleted-key
gap: retain both bounds of its primary-key seek so absence never walks that gap.

Release passes the selected sanction identity through the existing lock/fence checks.
Preserve [current manual-sanction semantics](api-domain-reference.md#moderation-and-read-models),
including former-participant `LOCAL_REJOIN` bans. Native MAX capabilities, manual
confirmation and local restriction removal remain distinct; a successful HTTP response
alone does not prove restoration of membership. A countdown uses server time and
monotonic elapsed time; unknown duration is not invented.

Participant inactivity describes MAX's observed last activity, not silence in this
chat or a new automatic removal policy. Keep the 7/14/30/60/90-day and no-data filters,
missing/private activity evidence, bounded roster pages and actor/chat/filter-bound
continuations. An incomplete scan is not an empty or complete audience.

| Boundary                                                    | Focused checks                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cursor scope, active/archive/review state and bounded reads | [Service](../../apps/api/src/admin/chat-sanctions.service.spec.ts), [PostgreSQL](../../apps/api/src/admin/chat-sanctions-postgres.spec.ts), [state](../../apps/api/src/admin/chat-sanction-state.spec.ts)                                                                                                                                                                                    |
| Retained sanction state and protection                      | [Cleanup](../../apps/api/src/moderation/sanction-history-retention.spec.ts), [fences](../../apps/api/src/moderation/moderation-sanction-state-fence.service.spec.ts), [former participants](../../apps/api/src/admin/former-participant-sanctions-postgres.spec.ts)                                                                                                                          |
| Activity paging and UI release confirmation                 | [Activity](../../apps/api/src/admin/participant-activity-page.spec.ts), [browser](../../apps/miniapp/test/chat-sanctions.browser.mjs)                                                                                                                                                                                                                                                        |
| Manual bot rights and unknown mutation results              | [Permission evidence](../../apps/api/src/admin/manual-member-bot-access.spec.ts), [HTTP boundary](../../apps/api/src/admin/admin.controller.spec.ts), [native member effects](../../apps/api/src/max/shared-member-action-postgres.spec.ts), [dialog errors](../../apps/miniapp/test/channel-member-ban-error.test.ts), [channel browser](../../apps/miniapp/test/channel-stats.browser.mjs) |
| Exact-bot private-forward denial and unknown source checks  | [Handshake](../../apps/api/src/max/managed-entity-handshake.service.spec.ts)                                                                                                                                                                                                                                                                                                                 |

The sanctions browser needs an existing local server, defaulting to port 3015;
`MINIAPP_TEST_BASE_URL` selects its `/app/` URL. Local previews do not establish live
MAX unban capabilities or authorize a test in a user group.

The channel browser also needs an existing local `/app/` server selected by
`MINIAPP_TEST_BASE_URL`. Run it without `--state-only` to cover ban failures, single dispatch,
safe event refresh and repeat prevention at 320/393 px in both themes. Its preview dispatcher
fixtures exercise local UI behavior; they do not establish live bot rights or sanction outcomes.

## Links And Comment Restrictions

Allowlist reads canonicalize legacy rows without writes. Domain rules match a host and
its subdomains; exact rules retain the full URL. Re-adding an active rule preserves its
expiry, and scheduling cannot revive an expired rule. Equivalent rows retain the union
of permissions. Serialize mutations with the parent chat, commit audit/state together,
and invalidate cache only after commit. Profile mentions keep their independent immunity.

Comment sanctions are scoped to profile, entity type, community and participant; they
never sanction MAX membership or suggestions. A restricted reader may still read and
delete their own comments, but cannot create/edit comments or react. Preserve confirmed
administrator protection, self/bot immunity, expected revisions, atomic audit and the
shared participant lock used by comment writes. Publisher administrator grants are durable;
the non-admin evidence needed to impose a restriction on its target remains fresh and exact.
Remote probes and uploads stay outside the transaction; unknown roles authorize no sanction.

| Boundary                                                                   | Focused checks                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Allowlist normalization, timers, read-only GET and transaction failures    | [API](../../apps/api/src/admin/admin-domain-allowlist-runtime.spec.ts), [native network writes](../../apps/api/src/admin/network-navigation-allowlist-postgres.spec.ts), [UI](../../apps/miniapp/test/settings-link-allowlist.browser.mjs)                                                        |
| Selective URL/domain rules, exact exceptions and all-target decisions      | [Contracts](../../packages/contracts/test/link-rules-policy.spec.ts), [authenticated preview](../../apps/api/src/admin/admin-links.service.spec.ts), [mobile layout](../../apps/miniapp/test/link-policy-layout.browser.mjs), [rollback reader](../../infra/scripts/link-rules-rollback.test.mjs) |
| Comment scope, revisions, authority, enforcement and retained restrictions | [Contracts](../../packages/contracts/test/comment-moderation.spec.ts), [service](../../apps/api/src/admin/comment-moderation.service.spec.ts), [PostgreSQL](../../apps/api/src/admin/comment-restriction-postgres.spec.ts), [browser](../../apps/miniapp/test/comment-moderation.browser.mjs)     |

Both browser scripts start a local dev server through the shared server helper.
Comment moderation accepts `COMMENT_MODERATION_BASE_URL`; inspect the helper's ownership
and reuse rules before choosing a port. Vite reads contract sources; an extra build lock
around a dev browser session is unnecessary.

## Publisher And VK

Preserve server-owned drafts/revisions, explicit final confirmation, saved recipients,
schedule time zones and uncertain-effect fences. Private Test uses the Publisher path;
it must never restore the retired Major publishing runtime. Opening an editor or selecting
a preset must not enable sources or publish history. VK errors and malformed/partial
responses never prove that a source post disappeared. Keep feed polling bounded and
diagnostics separate from the ordinary feed; do not return global aggregates to that path.

Publik text preserves ordinary line breaks and the number of interior blank rows through
native Enter, review, draft save and reopening. Native editors may leave the first line as
a text node before `div`/`p` siblings; serialization must include the boundary before those
blocks. Neither serialization nor Markdown editor/preview rendering may cap interior gaps.
Verify this with the [spacing browser](../../apps/miniapp/test/max-rich-text-spacing.browser.mjs)
(Chromium and WebKit, light/dark) and the composer browser's saved draft/publish payload case.
The browser flows use local fixtures/preview transport and never publish to MAX.

| Boundary                                                               | Focused checks                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Publisher catalog, virtualized lists, last-row access, cross-route CSS | [Catalog browser](../../apps/miniapp/test/publisher-catalog-layout.browser.mjs)                                                                                                                                                                                                                 |
| Long post, recipients, keyboard, review and return to editing          | [Composer browser](../../apps/miniapp/test/publication-composer-usability.browser.mjs)                                                                                                                                                                                                          |
| Date/time validation, expired review and saved scheduled post          | [Scheduling browser](../../apps/miniapp/test/publication-scheduling-submit.browser.mjs), [time picker](../../apps/miniapp/test/publication-time-picker.browser.mjs)                                                                                                                             |
| Direct upload and native file-picker presentation                      | [Video browser](../../apps/miniapp/test/publication-video-picker.browser.mjs)                                                                                                                                                                                                                   |
| Draft consistency and private Test isolation                           | [Draft service](../../apps/api/src/admin/publication-drafts.service.spec.ts), [Test boundary](../../apps/api/src/admin/admin-managed-broadcast-runtime-publication-test-boundary.spec.ts), [shared media/access PostgreSQL](../../apps/api/src/admin/publication-admin-access-postgres.spec.ts) |
| VK transport failures, exact source, feed and worker behavior          | [HTTP client](../../apps/api/src/admin/vk-api-client.service.spec.ts), [service](../../apps/api/src/admin/vk-parsing.service.spec.ts), [native import](../../apps/api/src/admin/vk-parsing-post-import-postgres.spec.ts), [workspace browser](../../apps/miniapp/test/vk-workspace.browser.mjs) |

These browser scripts start their local server through the shared helper; port selection
differs by script. VK accepts `MINIAPP_VK_TEST_BASE_URL`. Inspect the selected entrypoint
instead of assuming that every browser test accepts `MINIAPP_TEST_BASE_URL`.
The video browser checks real photo/video clicks at the center, edge and label, reopening
after empty selection, and both photo activation modes on explicit desktop, iOS and Android
platforms. Its compact desktop case models a narrow MAX window. Chromium with a Bridge shim
does not prove that the Windows MAX client's native file dialog works; retain that as a
separate client acceptance check when investigating desktop-only complaints.
For actual publication recovery and access, use the maintained
[diagnostics](../operations/runbooks/publisher-publication-diagnostics.md) and
[access runbook](../operations/runbooks/publisher-access-refresh-rollout.md).

Mobile feedback, draft write failures/retry, numeric correction, narrow weekday controls and
keyboard/caret visibility are covered by [mobile UI quality](../../apps/miniapp/test/mobile-ui-quality.browser.mjs).
It starts an owned local server and uses WebKit/Chromium with both keyboard models.
`MOBILE_QUALITY_WIDTH` selects one of its viewport profiles for a focused rerun.

## Chat Shop

Use the [current product decisions](miniapp-product-decisions.md#miniapp-shop-07-магазин-чата--покупательский-караван-без-отдельного-оформления)
and [integration runbook](../operations/runbooks/karavan-chat-marketplaces.md).
Marketplace design is retired by MINIAPP-SHOP-07. Preserve seller Store images,
both shop formats, ordinary public Karavan navigation, exact bindings and recovery
of historical appearance/image commands. Network availability changes show all
verified chats; disconnecting one chat remains a separate exact binding action.

| Boundary                                                         | Focused checks                                                                                                                                                                                                          |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connection, public/admin links, publication settings | [Compact shop](../../apps/miniapp/test/karavan-shop-simple.browser.mjs), [actual settings route](../../apps/miniapp/test/karavan-shop-route.browser.mjs) |
| Setup authority, changed rules and partial outcomes | [Integration browser](../../apps/miniapp/test/karavan-marketplace.browser.mjs), [setup review](../../apps/miniapp/test/karavan-marketplace-setup-review.test.ts), [setup browser](../../apps/miniapp/test/karavan-shop-formats.browser.mjs) |
| Moved editors, paused/empty shop, missing target, legacy recovery | Compact shop with `SHOP_SIMPLE_ONLY=categories`, `boundaries`, `queue` |
| Durable browser commands and uncertain results                   | [Command journal](../../apps/miniapp/test/karavan-shop-command-journal.browser.mjs), [command runtime](../../apps/miniapp/test/karavan-shop-command-runtime.browser.mjs)                                                |
| Final authorized publication choice                              | [PostgreSQL](../../apps/api/src/integrations/karavan-marketplace/karavan-publication-choice-postgres.spec.ts)                                                                                                           |

Inspect each browser entrypoint's server and environment options before running it.
Major's synthetic fixtures do not validate Karavan's seller implementation or live MAX.
Karavan owns listing order/pins, applications, seller admission, categories/rules and
availability. Its `client-shop-admin.spec.ts` covers the new UI; Major retains exact
command recovery and connection/publication behavior.
For Birzhik advertising/profile cases, use the separate
[marketplace regression map](marketplace-integration.md#focused-evidence).

The former commerce-editor browser scripts are superseded by the Karavan administration
suite. Actual MAX acceptance remains separate from Chromium/WebKit emulation.
