# Suggestion Subscriptions

## Policy And Scope

- Major channel settings: `postSuggestionsRequireSubscription` and `postSuggestionsDeleteOnUnsubscribe`.
- Publik module settings: `channelSuggestionsRequireSubscription` and `channelSuggestionsDeleteOnUnsubscribe`.
- Both default to false and are independently configured per channel, not globally enabled during deploy.
- Submission checks cover Major private-bot and mini app submissions and Publik mini app submissions. Admin approval rechecks the requirement. A signed dialog link does not bypass membership.
- Publik approval checks the original author's subscription separately from the reviewing administrator's durable access. `SUGGESTION_SUBSCRIPTION_REQUIRED` produces an author-subscription notification, never an administrator-rights error. A refusal leaves the suggestion pending without a publication claim. Cancellation and already accepted claims retain their existing authority.
- Terminal private-button review refusals log `Publisher suggestion review rejected` with the suggestion/bot identity, action, HTTP status and a fixed reason (`author_subscription_required`, `administrator_access_required`, `review_conflict` or `request_rejected`). No raw exception, author/editor identity or post content is logged. Temporary verification failures remain retryable and do not revoke rights.
- MAX errors mean unknown membership: reject new restricted submissions with a retryable error and perform no subscription-driven deletion.
- Deletion covers only confirmed suggestion publications enrolled while the deletion option was enabled. No historical backfill, channel member listing, or audit-log scan is performed. Publik suggestions converted to drafts are independent editor-owned publications and are not enrolled.
- Turning deletion off pauses existing watches and cancels dispatch authority. Re-enabling resumes already enrolled posts. An administrator's explicit Publication deletion schedule remains independent.

## Execution And Budgets

- The blocking API Redis CI lane runs the Publisher suggestion review queue regressions with real Redis, including terminal refusal and retryable verification failure.
- `api-admin` cannot read the Publik token. Its targeted submission checks use the existing `publisher-suggestion-admin` queue, bounded to 100 outstanding jobs, one attempt, an eight-second deadline, and 30-second result retention. `api-publisher` is the sole consumer.
- `SuggestionSubscriptionMonitorService` runs in `api-action` for Major and `api-publisher` for Publik. No new runtime role or queue is needed. Publisher dispatch-off disables its monitor; identity, health and background coordination remain mandatory.
- One durable watch per channel/author/profile/bot consolidates all enrolled posts. A 30-second timer selects at most 25 due watches by `(profile, next_check_at, id)`, under the existing background governor and a ten-second sweep budget. A slow decision selects one watch.
- Membership queries batch authors by channel and exact bot. Positive membership is checked again after six hours. Membership webhooks wake only exact author watches and invalidate the stored evidence epoch. Missed channel events are therefore bounded by the periodic reconciliation interval and backlog, not an immediate-deletion guarantee.
- Absence requires two successful uncached membership observations at least 30 seconds apart. MAX failures reset absence evidence and defer for five minutes. Each author pass processes at most ten enrolled posts with a keyset cursor.
- Leases are durable and expire after two minutes. A webhook revision change cannot be overwritten by a delayed probe or lease release.
- Major deletes use `ModerationDeleteIntentService` with `SUGGESTION_AUTHOR_UNSUBSCRIBED`, exact original bot, and `suggestion_subscription_id`. Publik uses its existing durable Publication post-action worker and `subscription_delete_id`.
- Dispatch requires the exact enrolled message, current enabled policy, and fresh negative evidence. Final guards make no nested MAX requests inside the DELETE transport slot. Resubscription invalidates pending evidence; generic HTTP 404 is never success.

## Release And Rollback

The additive `20260925120000_add_suggestion_subscription` migration adds default-false settings, nullable execution bindings, and two initially empty indexed tables. It does not mutate existing posts or settings. Validate Prisma, API, contracts, mini app, Safety Desk, and infra before deploying all shared API roles and affected static consumers.

Both API rollback wrappers require the subscription-aware Major and Publik final guards. Do not bypass this source floor: persisted deletion work can outlive a settings change or process restart. Use a compatible immutable release for rollback.

### Failed Migration Recovery

For a failed `20260925120000_add_suggestion_subscription`, synchronize the reviewed
recovery tooling and run `./infra/scripts/vps-connect.sh recover-suggestion-subscription-migration`.
This fixed, deploy-locked preview reads bounded catalog and Prisma metadata only. It requires
exactly one checksum-matching, zero-step lock-timeout, statement-timeout, or deadlock failure.
It recognizes only absent DDL, the exact first-five-column prefix with all new tables/types/indexes
absent, or the complete schema. Wrong types/defaults/nullability, unknown partial states, another
failed migration, changed metadata, and oversized migration metadata stop recovery.

After reviewing a `failed` result, repeat with `--apply`. The helper checks runtime health,
revalidates the snapshot, marks only that failed attempt rolled back using the running immutable
Prisma image, and verifies the rollback receipt. Normal deployment must then execute the original
immutable migration. A `retry-ready` result is idempotent.

For `complete-prefix`, apply completes only the original immutable suffix in one transaction.
It takes `ACCESS EXCLUSIVE ... NOWAIT` on `moderation_delete_intents`, never waiting in front of
live traffic, and bounds statements to ten seconds. A lock failure rolls back the entire suffix;
recheck activity and rerun preview before a reviewed retry. After completion, every additive
column, new table column, check/foreign-key/primary-key constraint, and index must match the
fixed catalog definition before Prisma may resolve it applied. `resolve-ready` resumes only
that metadata resolution after an interrupted successful DDL transaction. `applied` is a
verified no-op. No path drops objects or changes application rows. An interrupted release still
requires the normal typed-journal and queue-fence adoption workflow.

Focused checks:

```sh
node scripts/agent/focused.mjs --test apps/api/src/suggestions/suggestion-subscription.service.spec.ts --test apps/api/src/admin/publisher-suggestion.service.spec.ts --test apps/api/src/admin/publisher-suggestion-admin.processor.spec.ts
node scripts/agent/with-test-stores.mjs --migrate -- node scripts/agent/focused.mjs --test apps/api/src/admin/publisher-suggestion-admin.redis-integration.spec.ts
npm run test:contracts
npm run check:prisma
```
