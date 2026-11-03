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

| Boundary                                                                   | Focused checks                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Allowlist normalization, timers, read-only GET and transaction failures    | [API](../../apps/api/src/admin/admin-domain-allowlist-runtime.spec.ts), [native network writes](../../apps/api/src/admin/network-navigation-allowlist-postgres.spec.ts), [UI](../../apps/miniapp/test/settings-link-allowlist.browser.mjs)                                                    |
| Comment scope, revisions, authority, enforcement and retained restrictions | [Contracts](../../packages/contracts/test/comment-moderation.spec.ts), [service](../../apps/api/src/admin/comment-moderation.service.spec.ts), [PostgreSQL](../../apps/api/src/admin/comment-restriction-postgres.spec.ts), [browser](../../apps/miniapp/test/comment-moderation.browser.mjs) |

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
For actual publication recovery and access, use the maintained
[diagnostics](../operations/runbooks/publisher-publication-diagnostics.md) and
[access runbook](../operations/runbooks/publisher-access-refresh-rollout.md).
