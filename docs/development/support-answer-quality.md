# Support answer quality

Improve support in this order: contextual routing, reviewed facts and retrieval, grounded
procedures, concise language, then measured CPU latency. A knowledge or prompt update does not
fine-tune model weights. Fine-tuning is reserved for persistent errors after these changes and
requires separately reviewed examples and an unused evaluation set.

## Response contract

Answer the current question first, then give an available next step. Ask one useful question only
when its answer changes that step. Usually use two to four short sentences; a procedure needs its
actual ordered steps. Preserve the required conditions and exact UI labels. Do not add unrelated
FAQ, repeat completed checks or ask again for unavailable screens.

The owner's 9 November 2026 request reinforces concise conversation: usually 250–600 characters,
without padding a sufficient shorter answer. Continue from the user's last result and ask one
specific missing observation. A greeting with a request for help gets a brief task clarification;
ordinary participant conversation still stays silent. A request for steps keeps its current topic.
Official MAX statements retain the supplied verification date and cannot imply live browsing.

Use respectful Russian with «вы». Understand colloquial language, typos and irritation without
copying insults or giving lectures. The name «Майор Максимов» does not imply military roleplay.
One short acknowledgement of a difficulty can help; repeating it in every answer cannot replace
the solution. Keep the application-managed AI signature once in its own paragraph.

Use the public project name «Майор Максимов»; MAX is the messenger. Internal repository and
runtime names do not belong in customer prose. The shared presentation boundary normalizes
the public name and separates dense prose, inline numbered steps and long list items while
preserving words, quoted controls, URLs, times and numeric limits. A full bot directory uses
eight item lines grouped by role, with one verified profile link per bot. Check the body before
the signature: a blank line that only separates the signature does not prove readable layout.

The latest explicitly stated role is contextual information. An unknown role is distinct from
a participant. Advertisements in another group go to that group's administrators; questions
about the bot receive product help. The assistant has no account tools and cannot confirm live
settings, current prices, a person's identity or the cause of an individual deletion.

Suggested editorial examples, to verify against the current UI before using for training:

| Situation                                               | Useful response shape                                                                       |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Text exceeds a verified editor limit                    | Name that limit first; suggest shortening or splitting the post.                            |
| A completed setting did not resolve the problem         | Continue from the completed check; ask for the one missing observation.                     |
| The user cannot see Events                              | Offer a next step using available information; do not require that same screen again.       |
| A participant wants to place an advertisement           | Direct them to the administrators of that particular group and explain this chat's purpose. |
| An administrator asks the assistant to change a setting | Explain that the assistant cannot perform it, then give the verified path.                  |
| A send result is unknown                                | Check the existing result before trying again; do not recommend blind resubmission.         |

## Facts and regression

Keep instructions atomic by task, with their product, audience, checked UI names, prerequisites,
limitations and sources. Separate mass-setting operation results from audience statistics, text
filters from AI controls, native MAX features from Publisher, and platform support from project
support. Customer facts must not contain internal imperatives, source metadata or invalid example
links. A source ID in generated JSON does not prove every sentence is supported.
Maintain the [project module inventory](support-project-knowledge.md) when public modules change;
new facts also need semantic retrieval and followup coverage.

Application-authored answer requirements may highlight conditions in retained facts. Keep them
separate from the facts and untrusted question/history; rebuild them after context trimming.
Scope reminders to the current task, not every retrieved prerequisite. Keep allow/block/inspect
link goals separate, and describe all three modes neutrally in the shared fact. A URL requested
for an answer is not itself a link-filter task. An unknown publication result needs its existing
card and recipient/send evidence; it must not acquire a new-post procedure from a related fact.
General connection instructions use conditional administrator rights. Already requested Lastik
connection needs the waiting/activation conditions, not repeated onboarding. A post-creation answer
mentions separate Publisher connection conditionally, without assuming the recipient is missing.
Connection intent describes user reports, not verified live status. Waiting, expired/cancelled
requests and initial setup require different next steps. Keep explicit reading/deletion rights
and successful rights confirmation in Lastik's activation condition.
An atomic Lastik waiting question uses the reviewed `lastik-connect.waitingAnswer`, preserving
both bot and requesting administrator checks and the one-hour window from the connection request.
Only an unmixed waiting task with no other functional or incident facts takes that shortcut;
an atomic initial setup uses the reviewed `lastik-connect.setupAnswer` with the verified periods,
rights and one-hour window from the request. Recovery and additional questions retain inference.
Atomic Publisher creation preserves recipient selection and conditional separate connection;
an already reported ready connection is not repeated. An atomic delivery question uses the reviewed
existing-publication evidence procedure and duplicate warning. Additional tasks retain inference.
Reviewed manual closing preserves the independent night schedule and distinguishes the section
heading from the actual toggle. A Lastik conflict distinguishes accepting saved settings from
overwriting them with the local draft. An observation-mode incident handoff preserves the absence
of automatic AI deletion, independent filters and the available operator evidence. These bounded
procedures may cover several parts of one task; an additional unrelated or unknown task retains
inference. Both activation checks and the request-based waiting window remain in the neural facts
and reminders as well as the reviewed Lastik replies.
Forwarding questions for a moderator retain the connection prerequisites. An offered community
link is not a link-filter task; a reported ready connection is not an onboarding request.
Named reserve comparisons retain catalog roles and the selection procedure. Moderator selection
identifies «Сейчас выбран» and requires «Сменить бота» before waiting for «Бот выбран»; choosing
a radio item alone does not submit. Archive scope preserves the selected age from creation time.
An incidental completed connection check does not replace the existing publication's inspection
and unresolved-result handoff. An incident handoff
must also answer an explicit AI observation-mode question, including when its subject is in history.
An unknown delivery label keeps verification of the existing publication ahead of connection
facts. Link-mode reminders preserve the reported mode and distinguish the desired result from
a proposed way to achieve it.
An explicit resend followup retains its delivery context alongside a new scheduling question;
completion or a switch to another task drops that context. Two named calendar dates use «Даты»,
while «По дате» in repeat settings limits the end of recurrence. Text-length complaints in
«знаках» retrieve the same 4000-character limit as «символах». Network audience coverage and
per-target settings results are separate facts even when both are requested in one question.
Lastik waiting time starts at the submitted request, including elapsed waiting time; restarting
starts a new request window and still requires both rights checks before automatic activation.
Catalog links prefer the bot's item or canonical name over an introductory project alias, while
retaining alias-only links and the separate unlinked AI signature.

Focused tests cover eligibility and required replies together, role changes, contextual topic
retrieval, API paths, mandatory policy retention, source/link validation, honest AI identity and
intent-specific FAQ. The installer must include every imported runtime module in its immutable
manifest. Keep the bridge's per-user history and uncertain-send fences intact.

The bridge keeps six turns of at most 300 characters each. For a longer turn it preserves the
beginning and end, removing the assistant's redundant signature. This retains a final clarification
and the user's latest observed result; it is bounded context, not complete conversation memory.

Before changing the candidate, record the previous source identity and results. Freeze candidate
bytes before the final CPU run. Retain each first result, rejected draft, error and timing; label
development reruns separately. Count neural calls, direct replies and pre-model skips separately.
Record delivery origin independently: a reviewed replacement after a rejected model draft still
incurred inference and retains that raw failure. Judge the delivered text and rejected draft
separately; a useful replacement cannot erase the model's error.
Review content against checked facts; expected text matching alone is insufficient. Keep
substantive errors and disputed expectations independently crosschecked.

Evaluate the existing regression set and a separately sealed set of new formulations. Examples
used for tuning are not independent test evidence. AI reviews must be labelled as such; they are
not human approval. Compare paired cases rather than inferring that a user's tone causes errors
from uneven topic/style counts. No generated test messages belong in a live user group.

For the new set, mark in advance every request needing product help. Use that same denominator
for accepted replies and replies rated pass; skips and rejected answers count against both.
Suggested future targets are at least 99% accepted replies and 90% pass, with all known critical
regressions closed separately. These are targets, not a declaration that a release has met them.
Report delivered-text quality and appropriate silence on ordinary conversation separately.

Measure tokenizer/context processing, decoding, actual cache reuse and full local response time.
Sequential CPU evaluation does not establish multi-user queue capacity or delivery latency in MAX.
After exact-source CI and immutable bundle refresh, use the read-only pilot preview and one
identity/availability readback; a connected worker does not prove semantic acceptance.
