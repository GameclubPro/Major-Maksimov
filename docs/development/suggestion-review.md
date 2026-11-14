# Suggestion review in Major and Publik

The primary administrator flow is the private bot card: `Опубликовать`, `Править`,
`Отклонить`. The user's explicit correction on 2026-11-14 supersedes mandatory mini app
navigation for these actions. Native callbacks must work identically in Major and Publik.
Existing explicit `/suggestions/:id/edit|publish|reject` mini app URLs remain compatible;
they are not used by new card buttons. The full publication workspace remains Publik-only.

## Native card interaction

`Править` edits the existing bot card into its body-only source. The administrator replies
to that exact card with corrected text, then sees the final publication preview including
original author attribution, channel signature and retained media. `Опубликовать` saves
and publishes atomically; `Сохранить` leaves the edited suggestion pending. `Отмена` leaves
shared suggestion content unchanged. Editing the administrator's bound input message updates
its preview only while that editing session is active. Other messages/commands and replies to
other cards do not become post content or overwrite other private authoring sessions.

Historical publish callbacks enter the same bounded native queue as current cards. Their displayed
content is revision zero, so they cannot approve later edits. Retries retain the exact operation,
actor and body when a safe preparation failure has already saved an edit. Exhausted transient
failures produce a sanitized callback notice; logs keep fixed failure category and processing stage.

MAX has no documented composer-prefill/force-reply operation. A clipboard button is an
optional shortcut only for bodies of at most 1024 characters; its exact whitespace must survive
normalization. Longer text uses native message copying. Editor UI uses existing-message PUTs,
not new SENDs. Preserve every media attachment when replacing its text or keyboard.

Keyboard replacement uses the explicit guarded private-card option. General strict preservation
continues to protect existing buttons; the private option still verifies every original media
attachment and every requested new button. Native store tests execute the real attachment builder
against existing card snapshots, including transitions that remove old buttons.

Native input retains MAX entities and untrimmed UTF-16 text. Unchanged ranges keep original
styles and URLs; edits inside a style inherit it when correspondence is unambiguous. Changed
or ambiguous link labels and edits crossing style boundaries require an explicit formatting
choice or a new formatted input. Never silently attach a URL to another equal label. The
original remains retained, and author identity/profile URL are outside the editable body.

The four version-1 rejection templates are `paid`, `details`, `topic`, `rules`:
«Платное размещение», «Нужно дополнить», «Не по теме», «Не по правилам».
`Отклонить` exposes these buttons on the same card. Selecting a template commits the decision
and exact answer without another confirmation. Silent rejection sends no author message.
The paid text explicitly states that placement is paid, never invents a price, accepts payment
or publishes a post. Its MAX administrator contact is saved once per channel in the bot. The
first contact input is previewed and committed by «Сохранить и отправить»; later paid refusals
reuse it. A separate secondary action changes the contact.

## Authority and persistence

`SuggestionReviewDialog` binds a delivered card, exact bot, administrator and private chat.
Content revision, view version, input message/edit time and editing epoch prevent stale replies,
buttons and competing administrators from changing another revision. A personal preview does
not mutate shared content until save/publication. Pending sessions are independent of generic
Major inputs and Publik import/auto-reply leases because only exact replies or bound edits are
consumed. Native callbacks, including old rejection callbacks, precede those routers.

Input admission retains the latest bounded text/entities in the dialog's `draft.pendingInput`
before Redis handoff. The same primary-key conditional update binds its source message,
advances `inputAt` and the view version, and returns the card to `edit`/`contact` mode. Thus
quick source edits are already bound and earlier publish buttons cannot approve stale text.
These modes also refuse publication in older readers. A compatible reader is required to
recover retained inputs after rollback; no schema migration or history replay is needed.

The card worker consumes the newest retained input under its existing lock, even when an
older queue entry or callback reaches it first. That callback only produces a fresh preview;
publication requires another click on its new version. Lock contention retries input jobs,
while a failed Redis handoff remains recoverable from the next card interaction. Superseded
inputs cannot overwrite newer text. Invalid/expired inputs leave editing open without a
publish button; cancellation, exact session epochs, current access and five-minute source
deadlines still apply. A later input never cancels or replays an already accepted publication.

Shared review service row locks, operation hashes, publication claims and effect journal remain
authoritative. Operation IDs bind action, actor and request body. Rejected, publishing and
transferred suggestions cannot be edited. Publication freezes the same revision it accepts.
The mini app's strict text/revision/UUID contract remains unchanged.

Reopening a Major card in `publishing` reconciles its exact publication ledger. A confirmed receipt
finalizes the saved status without another SEND; unknown effects stay fenced and require review.
Reconciliation may release only a provably unattempted stale claim and never starts a publication.

Major dialog jobs execute on `admin-suggestion-delivery` in the action role. Publik uses
`publisher-suggestion-admin` in `api-publisher`, retaining identity/dispatch gates. Fresh exact
bot/actor checks precede processing; card edits recheck ownership, access and content revision
at mutation. Jobs retain original source timestamps and a five-minute command admission window.

Rejection and notification intent commit together in `suggestion_review_effects`. Replies use
the submission bot and audit author. Final dispatch rechecks current bot and reviewer access.
Preparation can retry for up to 24 hours; persisted SEND start is never replay authority.
Timeout/crash/unknown outcomes stay ambiguous. Confirmed receipts survive persistence retries
without another SEND. Card edits remain repeatable and version-aware; they do not erase an
active personal draft of the same content revision. Queue failure leaves durable recovery work.

A bounded, persisted primary-key walk upgrades already-delivered pending cards to native buttons.
Each page selects at most 25 delivery keys before profile/status/payload checks; terminal rows
are skipped and native sync intents are idempotent. Existing historical suggestions are neither
resent nor reopened. Runtime governor and profile-owned recovery remain in force.

The additive migration creates only dialog, contact and upgrade-progress tables with indexes on
new empty tables. Existing suggestion/effect statuses and publication fences retain their meaning.
All API roles use the shared release image. Rollback preserves these tables and the notification
journal; never delete/requeue attempted notifications or reset publishing suggestions. An older
binary cannot process native dialog jobs/buttons: restore a compatible reader to resume them.

## Regression checks

- [Content and protocol](../../apps/api/src/admin/suggestion-native-content.spec.ts): native and
  Markdown round trips, UTF-16 offsets, whitespace, hidden links, changed labels and ambiguity.
- [Bot cards](../../apps/api/src/admin/suggestion-review-links.spec.ts) and
  [clipboard](../../apps/api/src/max/max-inline-keyboard-layout.spec.ts): native revisioned actions,
  compatible explicit mini app URLs and exact bounded copy payloads.
- [Native dialog](../../apps/api/src/admin/suggestion-native-postgres.spec.ts): PostgreSQL/Redis,
  both bot profiles, exact reply routing, session epochs, edits, contacts, four refusals, silent
  rejection, stale/conflicting requests, retained media and old-card upgrades.
- [Review service](../../apps/api/src/admin/suggestion-review-postgres.spec.ts): actual stores,
  competing administrators, atomic save/publication/rejection, effect recovery and uncertain SEND.
- [Mini app browser](../../apps/miniapp/test/suggestion-review.browser.mjs): the retained editor's
  Chromium/Android and WebKit/iPhone round trips, profiles/themes, conflicts and network recovery.

Mocks/browser fixtures do not prove physical MAX rendering, clipboard behavior or author receipt.
Report local checks, exact-SHA CI, deployment and actual MAX acceptance separately.
