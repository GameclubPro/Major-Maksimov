# Channel Post Buttons: Diagnosis and Resolution

## Scope and Evidence

The reported channel has both Major and Publik as administrators. Enabling comments
in both produces duplicate comment entries. Direct posts do not get the same actions
as posts composed in Publik.

The channel ID, example message IDs, button destinations, and saved settings were
not supplied. The findings below are reproduced from the repository and regression
tests, not a claim to have inspected or reconfigured that customer's channel.

## Root Causes

1. Comment presentation identity included the dialog profile. Major and Publisher
   links therefore survived the keyboard merge as two different buttons even when
   they represented the same visible channel action. The old tests explicitly
   required that behavior. The shared message edit lock prevented lost updates,
   but did not prevent this semantic duplicate.
2. `PublisherDialogContextService.prepare` includes the channel's configured CTA
   through `ChannelPostSignatureService.buildPostButton`. The direct-post worker,
   `PublisherChannelCommentDeliveryService`, previously constructed only comments
   and suggestions. It did not load the configured CTA at all.
3. Publication-specific `customButtons` are not channel defaults. A Reviews link
   supplied in the publication composer belongs to that publication. A direct
   message webhook contains no instruction to inherit it from an earlier post.
   Treating the last post's buttons as defaults would copy potentially unrelated
   advertising, payment, or contact destinations into future posts.

The missing Reviews link can be cause 2 or cause 3. Its exact origin must be checked
before promising a specific three-button setup. Button labels alone cannot identify
their purpose or destination.

## Implemented Resolution

### Compact Custom Buttons

Adjacent saved custom links with short captions share a row, two at a time, in their saved
order. Captions up to ten display units qualify (emoji count as two); longer or multiline
captions occupy their own row. Comments, suggestions and the configured channel CTA keep
their separate rows. This follows MAX's recommended caption length for two-button rows
without adding a layout setting or changing saved links.

Runtime and the settings preview share the same layout helper. Composition retains compact
custom rows after URL deduplication; transport preserves explicit row boundaries and splits
long captions instead of forcing every link into a full-width row. Existing posts are not
bulk rewritten. The regression covers saved settings through composition and final MAX
normalization in `apps/api/src/common/channel-custom-post-buttons.spec.ts`; the browser
case checks adjacent preview buttons on desktop, iPhone and Android sizes.

### One Visible Dialog Entry

- Presentation identity is `(channel, action)` for both comments and suggestions.
  Authorization identity remains `(channel, action, profile)`.
- During a merge, the already installed dialog link wins. Neither bot replaces it
  with its own token or adopts the other profile's thread.
- Later count refreshes from the other profile cannot restore a duplicate or
  overwrite the visible discussion's counter.
- Strict attachment preservation allows comment aliases to collapse only if an
  unchanged source comment button survives. Replacing an existing discussion with
  a newly generated token is still rejected.
- Ordinary custom links are not identified by label. Same-label external buttons,
  other channels' actions, callbacks, text, and media keep their existing protection.

This is first-installed-link ownership, not a preference for Major or Publisher.
It avoids silently moving readers away from an existing discussion. It does not
merge comment databases or migrate historical threads.

### Direct-Post CTA Parity

- The Publisher direct-post worker uses the same configured channel CTA service as
  ordinary Publisher publication. No new settings or database migration is needed.
- Existing comments and suggestion links keep their original labels and targets;
  the missing configured CTA is placed after them.
- The locked source snapshot is checked before adding actions. A repeated delivery
  with all required actions already installed does not issue another edit.
- Publisher audit references include the CTA but do not claim a Major comment
  thread or schedule a Publisher count reference for it.
- Runtime readiness, exact Publisher route, channel edit permission, publication
  policy/settings revisions, and the prepared CTA are checked before mutation.
- When the direct-post CTA needs a channel-link lookup, the Publisher worker
  supplies its exact bot ID; that fallback does not depend on a Major send route.
  Publication preparation in other API roles keeps its existing lookup behavior;
  those processes must not attempt to use the Publisher bot token.
- A saved button also admits fresh direct posts when Publisher comments and
  suggestions are both disabled or their settings row is absent. This covers
  channels where Major supplies the existing dialog buttons. CTA-only admission
  requires an enabled BUTTON setting older than the post, exact Publisher binding,
  and an enabled publication policy; the worker rechecks those settings and the
  prepared destination before mutation. It does not enable either Publisher dialog.

## Acceptance Coverage

### Follow-Up Regression Audit

The next audit reproduced two paths not covered by the original fix:

- Major's rejected-edit fallback replaced the entire keyboard without merging.
  It could remove Publisher's discussion, Reviews, and other existing actions.
  Both ordinary-post edit attempts now require attachment preservation and retain
  existing dialog buttons, including their labels and current counters. The retry
  changes row placement only and reads the source again under the shared edit lock.
  A preservation failure never authorizes a destructive replacement or a new post.
- Publisher's no-op check considered only missing actions. A fresh post already
  containing duplicate comment or suggestion entries was left unchanged when all
  required actions existed. The check now also detects repeated recognized actions,
  retaining the first source entry through the existing merge. Correct keyboards
  remain no-ops, and external same-label links are not considered duplicates.

This is bounded by the existing fresh-post job admission and 24-hour expiry. It
does not introduce historical scans, bulk repair, or promotion of composer links
into channel defaults. Counter refreshes retain their separate update behavior.

Regression tests cover both bot arrival orders, repeated decoration, both profiles'
count refreshes, original thread retention, profile-isolated audit references,
comments/suggestions toggle combinations, configured/disabled CTA, CTA changes
before dispatch, exact Publisher link lookup, media/text preservation, unrelated
links, and rejection of source-discussion replacement.

The three-action fixture uses an existing Comments link, an existing
Ask-a-question-or-buy suggestion entry, and Reviews as the configured channel CTA.
A separate composer test covers Comments plus a configured contact CTA plus a
publication-specific Reviews link. These are different configurations; the latter
does not make Reviews a persistent default for direct posts.

## Customer Configuration and Historical Posts

Before closing the individual complaint, obtain the channel link/ID, one direct
post and one Publik-created post, and the intended contact/Reviews destinations.
Determine whether the second action is a suggestion dialog or an ordinary contact
link, and whether Reviews is the saved channel CTA or a per-publication link.

- If Reviews is the configured CTA, the direct-post fix supplies it automatically
  through the active Publisher binding, even when its own dialogs are disabled.
- If contact and Reviews are both independent external links and only one is the
  configured CTA, exact parity needs a separately configured persistent channel
  button set. The current model has one CTA, not an arbitrary default button list.
  Do not silently promote a publication-specific URL into a shared default.
- Persisted channel defaults, if required, should use validated links, Publisher
  authorization, optimistic settings revisions, the existing shared action-row
  builder, direct-webhook admission, publication preparation, and matching preview.
  A schema/UI expansion should follow confirmation of the intended destinations.
- Do not bulk-rewrite historical posts or hide historical discussions without
  explicit message scope and a choice of the discussion to retain.

## Forwarded Posts

Fresh Major channel forwards previously went directly to copy-and-delete, even
when only comments, suggestions, or a button-style CTA were needed. That path
requires a verified administrator sender and both write/delete permissions. MAX
can omit the channel sender, so those posts were skipped before any keyboard edit.
The repair scan also excluded anonymous and locally unrecognized forward senders.

Keyboard-only decoration now edits the original forward through the live channel
edit-permission guard and shared keyboard lock. It does not require sender lookup
or delete permission, and sends neither text nor a replacement forward link.
Rejected edits never authorize a copy, reply, or deletion. The normal bounded
repair scan admits these forwards with the existing settings-time baseline.

The MAX edit transport and Publisher keyboard preparation inspect only the
forward wrapper's direct attachments. Nested media and buttons remain part of the
unchanged linked message; resending them as wrapper attachments can fail strict
preservation or duplicate source content. Copy operations retain their separate
strict source-flattening checks. Empty, null, and absent forward body text all
prevent fallback source text from being written during a keyboard edit.

Text-style signatures and quick-button templates still use the guarded replacement
path when they require rewriting forwarded content. Anonymous forwards do not
authorize that send/delete path. Legacy recovery does not gain the fresh-post
opt-in, and historical terminal markers are not reset by this change.

Regression coverage includes hidden and unrecognized senders, edit-only bots,
webhook and poll admission, text omission, direct versus nested media/keyboards,
Publisher thread isolation, and edit rejection without destructive fallback.

## Suggestion Attribution

The Publisher review worker previously copied only raw suggestion text and media
into Publication, bypassing Major's subscriber attribution and native markup
rendering. New publish/draft claims now freeze Markdown content containing
`От подписчика` with the stored author profile/full-name mention and preserve
native links and contact mentions using the original UTF-16 offsets. The trusted
audit row identifies the author, not the reviewing administrator.

The frozen claim text survives profile changes and retry. Claims created before
this change retain the old request bytes to avoid changing an already-recorded
Publication request hash. No published posts are rewritten. These checks cover
links/mentions, not importing standalone contact-card attachments; a separate
contact-recognition complaint still needs an example of the failing input.

## Validation and Release

Run `npm run check:api`, `npm run check:static`, `npm run check:docs`, and
`git diff --check`. Deploy the shared API image to all production API roles through
the exact-SHA CI-gated wrapper. No static frontend deployment or schema migration
is required by these runtime changes. Production health checks do not substitute
for a real customer-channel acceptance test.

MAX reference: <https://dev.max.ru/docs-api/methods/PUT/messages>. Inline keyboard
updates use the existing edit transport, shared lock, and attachment preservation;
this change does not introduce a new MAX API method.
