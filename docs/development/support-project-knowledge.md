# Project knowledge for the support assistant

The owner's request on 2026-10-29 is to answer questions about every project module.
The scope is customer support for administrators, with participant guidance for subscription,
giveaways and the support-room policy. Internal infrastructure, owner controls, credentials and
private account data are not customer instructions. Updating this knowledge does not train model
weights or give the assistant account tools.

## Coverage and sources

The maintained inventory is `moduleCoverage` in
[support-llm-knowledge.json](../../infra/scripts/support-llm-knowledge.json). Each family identifies
its facts, shared settings sections and a retrieval probe. Facts link the actual UI, contracts and,
where needed, the implementing service. `projectReview` describes the module review; per-fact
review fields identify newly checked instructions. Original MAX documentation retrieval dates
remain separate and must not be refreshed without fetching those pages again.

The owner's 9 November 2026 request retains support for the whole public project and adds concise
conversational troubleshooting. The current review corrects the chat-shop setup, unified
antiduplicate and participant controls, and adds VK source attribution/automatic deletion and the
commercial-message preview. Generic support openers and contextual requests for steps need useful
retrieval too; unrelated keyword matches cannot replace a clarification.
Storefront caller access includes the separate «Добавить пользователя» handoff and its per-chat
duration; seller admission and permission to request the bot's button remain distinct.

Nineteen canonical official MAX pages were fetched on 9 November. Their resource hashes and
HTTP modification times are recorded separately from product change dates. Selected official facts
carry their verification date into inference; the assistant has a reviewed snapshot, without live
account lookup. November's notification parameter clarification belongs to API questions;
administrator answers do not acquire unnecessary developer details.

| Area             | Covered customer modules                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access           | Eight bots, moderator connection and selection, missing communities, mini app relaunch                                                                                                                        |
| Text moderation  | Links, phone numbers, profanity, commercial text rules, AI availability and observation, stop-words and image-text distinction                                                                                |
| Message controls | Antiduplicate text and identical images, frequency and length, attachment types, required subscription, invitation access availability                                                                        |
| Administration   | Reports and their outcomes, night schedule and manual closing, rules, welcome, speech style, commands, own messages and other bots                                                                            |
| Participants     | Search and cards, temporary message restriction, protection, sanction history and release, spam review                                                                                                        |
| Reporting        | Chat statistics, moderation journal, membership events, network audience coverage                                                                                                                             |
| Engagement       | Poll creation, voting privacy, publication uncertainty; giveaway setup, eligibility, winners and prize delivery records                                                                                       |
| Channels         | Post action, quick buttons, comments in the application, suggestion intake and limits                                                                                                                         |
| Communities      | Network composition, scoped settings application and per-target outcomes                                                                                                                                      |
| Publisher        | Separate connection, posts, recipients, media, schedules and repeat, timezone, after-publication actions, delivery outcomes, MAX import, auto-replies, chat comments, VK review and automation, notifications |
| Integrations     | Karavan storefront, chat-store setup and private publication choice, pilot marketplace profile and advertising placement in Svyazka                                                                           |
| Support          | Administrator incident evidence, participant advertisement redirection, operator handoff and unavailable live account state                                                                                   |

The automated inventory comparison covers every section in
[settings-workspace-sections.ts](../../apps/miniapp/src/pages/settings/settings-workspace-sections.ts).
Polls, giveaways, participant screens and Publisher routes live outside that shared registry and
need an explicit inventory entry when their public modules change. A family being listed does not
prove every possible question or every implementation field has been evaluated.

## Preserve the product distinctions

- The support assistant interprets meaning and a bounded conversation history. Publisher
  auto-replies use administrator-prepared phrases and responses; neither installing Publisher
  nor connecting a moderator activates this support assistant in another chat.
- Publisher channel suggestions use «Каналы» → channel → «Предложения» →
  «Включить предложения», applied immediately, and the post button «✍️ Предложить объявление».
  Major's separate suggestion controls do not describe that Publisher screen.
- Membership leave events are available in statistics → «События». They do not imply a
  public departure notification; no separate public-notification setting is documented.
- A visible setting is not proof that its enforcement is available. Invitation access cannot
  currently be activated; image checks and pilot integrations retain their availability conditions.
- «Мут» keeps a person in the chat while the bot deletes new messages for the selected
  duration. Command defaults and the participant-card duration are separate. When MAX requires
  manual unblocking, the application's check does not perform that unblock.
- Anonymous poll identities are hidden from administrators too. A poll has one current answer
  per voter; a new choice changes that answer. Published questions and options cannot be edited.
- A giveaway entry is separate from verified eligibility. Recording a prize as «Выдано» does not
  transfer money or deliver it. User-specific eligibility and winnings require the actual page.
- An unknown publication outcome never proves absence. Inspect the existing poll or Publisher
  post before recommending another send. Preserve independent tasks in a combined question.
- Network settings results, network audience coverage, moderation actions and join/leave events
  are separate views. Missing observations do not prove zero activity or successful actions.
- Lastik's partial counts are lower bounds. Unknown deletion outcomes and a last completed scan
  do not establish successful deletion or complete history coverage. Its optional newer diagnostic
  labels are reviewed separately against their recorded source revision.
- Karavan chat-store connections retain one setup operation after uncertain outcomes. A saved
  storefront choice does not publish a message; legacy `$` behavior and connected-store behavior
  remain separate, and new module visibility depends on integration availability.

## Updating and validating

Inspect the public screen, limits in contracts and relevant service before changing a fact.
Use exact visible action labels rather than mistaking an editor heading for a button. Keep facts
atomic; a module's full manual should not become every answer to that module.

Update semantic retrieval as well as keywords: existing primary facts suppress fallback keyword
retrieval. Topic inheritance must support short followups and stop at a completed task or ordinary
conversation. Preserve the concise Russian response contract and verified catalog link rendering.

Publik auto-replies must also be found from a description such as “a person writes a word and
receives the administrator's prepared list”, without the product or feature name. Use the same
intent for product selection, topic inheritance and fact retrieval. A list of group links can be
the prepared response text; it does not imply network management or automatic group discovery.
Replies appear in the same chat, as a reply to the participant. A word or “trigger” alone must
not turn moderation, ordinary conversation or generative AI requests into auto-reply setup.

[Project coverage tests](../../infra/scripts/support-llm-project-coverage.test.mjs) check module
retrieval, shared registry coverage, key product limits, followups and neighboring boundaries.
Run these with the existing routing, knowledge, client and answer-policy cases before the selected
aggregate checks. For model evaluation, seal new formulations before the run, retain first answers,
raw drafts, usage and errors privately, and review semantics against the source. Revised cases
and reruns are development evidence, not an independent evaluation.

No generated evaluation messages belong in MAX groups. After exact-source CI, refresh the guarded
host knowledge and immutable workstation bundle, then use the read-only pilot preview and one
fresh worker readback. Availability is separate from real user acceptance.
