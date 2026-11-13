# Suggestion review in Major and Publik

Administrator cards open `/suggestions/:id/edit`, `/publish` or `/reject` through the
existing profile-specific `mr-` mini app links. The full publication workspace remains
Publik-only. Old rejection callbacks open the reason selector without making a decision.
Old publication callbacks cannot publish a suggestion edited after their original revision.

The shared editor accepts only text, expected content revision and a UUID operation ID.
The audit record owns author identity, original content, profile, channel and media.
Unchanged editor content keeps the original native markup; changed content is stored as
Markdown. UTF-16 offsets apply to the untrimmed original. Malformed or unsafe native
formatting stops editing with an explanation. The author link is outside the editable body.
Whitespace, paragraphs, links, mentions and supported formatting survive editor round trips
and final rendering, including channel signature insertion. Saved media is not uploaded again.

Save and rejection lock the suggestion row. Publication uses the existing atomic claims with
an expected revision and freezes the edited content in the same update. Stored operation
hashes bind action, actor and request body; a reused ID cannot authorize a different decision.
Rejected, publishing and transferred suggestions cannot be edited. A conflicting personal
mini app draft remains available separately, and pending request identities survive reopening.

The four version-1 rejection templates are `paid`, `details`, `topic` and `rules`:
«Платное размещение», «Нужно дополнить», «Не по теме», «Не по правилам».
The paid template explicitly states that the announcement is paid and requires an administrator
contact in MAX. It never invents a price, accepts payment or publishes a post. An optional
explanation is included in the exact saved answer. Silent rejection sends no author message.

Rejection and notification intent commit together in `suggestion_review_effects`. Major effects
run on the action role; Publik effects use its own worker and identity/dispatch gates. Replies
use the submission bot and audit author. Final dispatch rechecks current bot and reviewer
access. Preparation can retry for up to 24 hours; persisted SEND start is never replay authority.
A timeout, crash after SEND or unknown outcome remains ambiguous. A positive receipt is retained
without resending even if its first SQL write fails. Card edits are repeatable, version-aware
and also scheduled after late initial delivery. Queue failure leaves durable work for recovery.

The schema migration only adds the effect journal and indexes. Existing audit statuses and
publication fences retain their meaning. All API roles must use the shared release image.
Rollback must preserve the new journal: never delete/requeue attempted notifications or reset
publishing suggestions. An older binary does not process new review effects; restore a compatible
reader to resume only positively unstarted work. Confirmed/ambiguous effects remain evidence.

## Regression checks

- [Contracts](../../packages/contracts/test/suggestion-review.spec.ts): author protection,
  request validation, paid contact and exact template copy.
- [Content](../../apps/api/src/admin/suggestion-review-content.spec.ts) and
  [bot cards](../../apps/api/src/admin/suggestion-review-links.spec.ts): original markup,
  author binding, malformed formatting, revisions and profile-specific links.
- [Native service tests](../../apps/api/src/admin/suggestion-review-postgres.spec.ts): actual
  PostgreSQL/Redis, competing administrators, atomic publication/save, rejection and outbox,
  duplicate requests, queue failures, crash recovery and bounded indexed selection.
- [Browser](../../apps/miniapp/test/suggestion-review.browser.mjs): Chromium/Android and
  WebKit/iPhone sizes, both profiles/themes, whitespace/code/list round trips, edits, paid
  replies, conflicting drafts and network recovery. This owns a local Vite server and never
  sends to MAX. Screenshots live in a temporary directory printed by the runner.

Browser fixtures do not prove physical MAX rendering or author delivery. Record local checks,
exact-SHA CI, deployment and actual MAX acceptance separately for each release.
