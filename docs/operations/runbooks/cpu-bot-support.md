# CPU bot support pilot

The selected CPU support profile is Gemma 4 26B-A4B UD-Q5_K_M through an independent
llama.cpp b11804 installation. This is retrieval from reviewed customer instructions, not fine-tuning.
The existing GPU commercial classifier and server moderation remain separate.

An optional owner-selected API profile uses `gpt-6.1-terra` with `reasoning_effort: max`
through the pinned third-party HTTPS gateway in `infra/scripts/support-llm-provider.mjs`.
The gateway's model label and acceptance of a parameter do not independently establish its
underlying implementation or pricing. Reviewed support facts and bounded question/history are
sent to that provider; MAX application credentials remain on the VPS.

## API support mode

The default remains CPU when `service/provider.json` is absent. For the authorized API pilot,
stop the installed chat worker and CPU supervisor, install the reviewed immutable bundle, then
place `{"version":1,"backend":"api"}` in `~/.local/share/maxim-support-llm/service/provider.json`
and the provider key in the sibling `provider-api-key` file. Both files must be owned by the
current user, nonsymlinks and mode `0600`; keep them outside Git. Never change provider selection
or credentials while its worker is running. Preserve the existing CPU key, weights and bundles.

`maxim-support ask` uses this selection. In API mode `maxim-support chat-start` attests the exact
model in the provider catalog and starts the existing fenced worker without starting Gemma or
requiring a CPU tokenizer. `chat-status` reports the actual model, backend, reasoning effort,
connection heartbeat and delivery counts. `start`, `stop` and `status` still control the CPU model;
they do not prove API availability. API mode does not require that CPU supervisor to run.

API inference uses the same retrieval, mandatory policies, structured JSON/source validation,
presentation and final canonical bot links. A conservative 24000-byte application input budget
trims oldest history and lower-ranked facts while retaining both mandatory facts and the best
topic. This is an application budget, not a statement about the provider's model context. The
completion budget is 4096 tokens including any provider reasoning; final text retains its existing
1800-character boundary. Requests keep the original 120-second deadline, pin HTTPS origin, refuse
redirects, bound JSON response bytes and never automatically retry inference or fall back to a
different model. Provider errors stay private and produce no diagnostic reply in MAX.
Questions asking which messages Lastik does not delete or touch retain its complete exclusion
fact even when the question does not name pins, rules or giveaways explicitly.

Ordinary administrator answers use Russian permission descriptions and aim for 500–800
characters while preserving required conditions and every requested task. Platform owner
details are included for explicit API/developer questions or an actual failure to add a bot,
not routine onboarding. Known `read_all_messages` and `write` codes in ordinary model drafts
are rendered as Russian descriptions; technical API answers retain the codes.

API `ask` returns sanitized provider-reported `usage`; missing or inconsistent counts remain
`null`. `completionTokens` includes `reasoningTokens`; never add reasoning again to `totalTokens`.
The private `chat-status.json` retains `lastInference` and `lastReplyUsage` for this worker run.
The latter requires a matching source digest and confirmed `sent` settlement; inference alone
does not prove publication. Entries hold timestamps, a hashed source identity and numeric usage,
without question/answer text or credentials. `no-api-request` identifies a direct local reply;
`provider-reported` with `usage: null` means counts were unavailable, not zero. These fields are
never sent to MAX. Historical responses without saved usage cannot be reconstructed exactly,
and provider counts do not establish a monetary price.

The bridge accepts the exact reviewed API configuration digest in a distinct `apiProfileSha256`
field, or the existing CPU weight digest. Frames carrying both identities are rejected. The API
key never crosses SSH or enters a MAX message. After exact-source CI and guarded tooling sync,
check local grounded answers, run the read-only preview, start the worker and take one fresh
identity/availability readback. To return to CPU, stop the worker, remove only the private provider
selection file, start the verified CPU model, then start the worker again; preserve source fences.

## Identity and scope

- The pinned repository, revision, byte count and SHA-256 live in
  `infra/scripts/support-llm-profile.mjs`. Weights live outside Git under
  `~/.local/share/maxim-support-llm/`; the installer verifies them before installation
  and startup. The existing pinned b11804 runtime archives are verified and extracted
  into a separate immutable bundle.
- CPU execution uses `--device none`, zero GPU layers, eight inference threads, one
  slot, 4096 context tokens and at most 384 output tokens. Prompt-cache RAM is capped at
  1024 MiB, with minimum checkpoint spacing of 512 tokens. Thinking and context
  shifting are disabled. Only `127.0.0.1:18085` is exposed, with a private random API key.
- Gemma uses its embedded native chat template through `--jinja`, without a template override.
  Keep thinking explicitly disabled at both server and request boundaries. Check actual
  tokenization, completed structured answers and the existing 120-second request deadline
  before enabling the pilot.
- The owner-approved recipients are **CHAT `-78271094414679`** and
  **CHAT `-79143082792210`** (owner request of 9 November 2026). Each bridge process
  selects exactly one allowlisted chat, with independent history, Redis lease and source
  fences. The original chat keeps its existing Redis namespace and uncertain-send fences.
  The bridge
  selects only its existing fixed, primary or legacy assigned moderator, verifies the
  actual remote entity type and fresh exact bot access, and refuses assignment drift.
  It never changes bot assignments, activation, webhooks or settings.
- The PC initiates strict-key SSH. Application tokens and database/Redis credentials
  remain on the VPS. The host verifies the running `api-action` image against the
  immutable component manifest before running the reviewed bridge inside that container.
  The bridge constructs focused real services without starting application workers.

## Grounding and delivery

`infra/scripts/support-llm-knowledge.json` contains reviewed customer instructions and
source paths, plus an official MAX source catalog with retrieval time and content digests.
The 2026-10-26 review covers moderation, rights, networks, Publisher posts/schedules,
VK, comments, suggestions and platform questions. A retrieval date is not a publication
or update date; retain unknown `Last-Modified` values and recheck changed official facts.
Do not index operational runbooks, agent instructions, environment files or private
customer histories. Update entries against current UI/code. The local installer includes
the knowledge and scripts in its immutable bundle; an update requires reinstalling that
bundle. Knowledge digests must match across the PC and host.

The owner-reviewed group onboarding cards are represented by two `onboardingGuides` entries:
11 moderator cards and 11 Publik cards. The catalog retains only reviewed source references,
ordered MAX photo identities and content digests. Original images, chat exports, CDN URLs and
media tokens stay outside Git. The helper may select one symbolic guide ID for a clear eligible
group setup request; channels, Lastik, troubleshooting, already completed setup and unrelated
conversation do not automatically receive these group cards. Moderator cards use Major as their
example; another moderator must use its own verified profile.

For a selected guide, the host reads its exact pinned forwarded messages with the existing
assigned moderator. It requires every image identity and its order to match before using only
the fresh MAX image tokens. Forwarded text and URLs do not become model instructions or outgoing
media. Both guides describe two alternatives after admin rights: an administrator's explicit
`Старт` in the group, or forwarding a group message to the correct bot's private dialog. Publik
also needs permission to send/publish; the card highlighting reading does not waive that right.

A guide is sent as two ordered image batches of ten and one, with a short explanation. Every
batch rechecks the user's exact source, access, holds, deadline and session heartbeat. Child
Redis fences require the previous batch's confirmed receipt; the original source fence remains
unchanged. Missing acknowledgements or a partial result remain fenced without automatic replay.
Only all confirmed batches settle the full answer as sent. Preparation and delivery retain the
same bounded lease; no guide response extends the source's original 180-second deadline.

The reviewed public catalog contains eight bots: three main moderators (Максимов,
Максимова, Рэкс), three reserve moderators (Максимов 2, Максимова 2, Рэкс 2), Публик
and the separate Ластик. Main/reserve is the owner's product classification, not proof of
a chat's current assignment or automatic failover. Canonical profile URLs come from the
project's public bot constants. Ластик has separate facts for connection, retention periods
and old history, exclusions, progress, permission recovery, uncertain saves, stopping and
irreversible deletion; verify these against the current mini app before updating them.

The [customer support policy](../../bot-support-policy.md) comes from the project owner,
not MAX platform rules. This chat helps administrators with bots. A participant asking
how to place an advertisement or why it disappeared in another group is directed to that
group's administrators, with a brief explanation of this support chat's purpose. Help
administrators publish through Publik or check moderation settings; clarify an ambiguous
role instead of refusing a relevant question. Placement/removal questions remain eligible
without the word "bot", including common Russian spelling variants and complaints.
The context router distinguishes an administrator, a participant and an unknown role. The latest
explicit self-report wins; it is conversational context, never authorization to perform an action.
Only an explicit participant advertisement request uses the reviewed room-policy answer directly.
An unknown role is clarified when it changes the next step. Functional questions about bots must
not be replaced by this policy. A model's off-topic classification cannot suppress required help.
Exact commercial AI interface questions use short reviewed facts selected by intent. Bounded
facts also cover personal subscription complaints, evidence for support incidents and ordinary
public-channel eligibility. Mixed questions and other individual incidents use grounded inference.
Explicit AI retrieval excludes
instructions for unrelated settings. Most administrator tasks and Publisher instructions use inference; bounded rules-replacement and
manual VK-import procedures use reviewed answers. Profile and reserve-selection answers use
canonical catalog identities and the reviewed selection steps;
profiled complaints, action requests and contextual answers require `reply`, including one known
source. Ordinary conversation and completed acknowledgements are skipped.

The owner's 9 November 2026 correction requires silence during conversations between
participants. A reply or mention directed at somebody else is skipped before inference,
unless the same message explicitly addresses this assistant. Exact MAX bot identity and
confirmed AI replies establish that address; another bot's flag alone does not. Specific
project questions and incident reports remain eligible without a mention. A generic word
shared with the knowledge base, a launch-plan announcement or any question after earlier
support is insufficient. A real clarification or a continuation of the current support task
can retain context. The bridge keeps only confirmed user/assistant pairs, expires them after
five minutes and clears the user's context on a skip. No diagnostic messages are posted to
verify these rules.

An interrupted publication send retrieves result-verification instructions before creation steps;
an explicit request to switch to a named moderator retrieves both the selection procedure and
the bot catalog. These requests require an explanation, never an executed action or an assumed
successful result. Ordinary recurring schedules and profile requests retain their own routes.

Successful answers use short paragraphs, numbered instructions and visible bullet points in
plain text. The client also separates dense prose at sentence boundaries and adds the fixed
footer `✦ Ответ подготовлен ИИ-помощником «Майор Максимов»` once, in its own paragraph.
This applies to model answers and reviewed direct-answer routes. The final text, including
the footer, must fit the bridge's 1800-character limit; oversized answers fail silently rather
than losing steps to truncation. Skipped questions and errors receive no footer or public reply.
The model returns plain text. At the final bridge boundary, all text is HTML-escaped and
verified bot names become links from the eight-entry catalog. Longer aliases win, each bot
is linked once, and the fixed footer stays unlinked. Catalog validation rejects ambiguous
aliases and noncanonical targets at startup. Rendering must also fit 4000 HTML characters
before source revalidation or the send fence can advance. The host receives the catalog from
the same knowledge bytes used for the PC/host digest handshake. These eight profile URLs
are allowed separately from retrieved official documentation URLs.
When a bot is named several times, its catalog item and canonical name take precedence over
an introductory alias for the one profile link. Alias-only references remain supported.

Questions and context are untrusted user data. Responses are constrained JSON with
`reply` or `skip`, bounded text and IDs from the selected knowledge. Internal paths,
invented links, incomplete generations and technical errors cannot become public replies.
Official documentation links are allowed only when they belong to the retrieved source
catalog. Template links are absent from public facts. Topic retrieval folds common Russian
endings, recognizes product tasks and technical paths, and includes related prerequisite facts;
the support policy and operator limitations are always included. Before inference the installed
tokenizer checks the 4096-token context with space reserved for output and chat framing.
If necessary, trim the oldest history and then lower-ranked facts, retaining both policies
and the best topic. Unavailable tokenization or an irreducibly oversized prompt stays silent.
The model has no tools. Account state, removal reasons, tariffs and other unavailable
facts require operator verification. Visible source metadata and false claims to be a human
are rejected independently of the appended AI signature. For those identity/internal-content
rejections on a single task alone, the client can separately validate and deliver the leading
reviewed topic fact. Mixed requests retain the rejection rather than lose a second task.
The rejected draft stays rejected; quality evaluation retains its reason and distinguishes the
reviewed replacement from model-authored text. Link, source and incomplete-output failures do not
use this route. Generated source IDs are validation,
not a guarantee that the wording is correct. Requests enable prompt-prefix caching; measure
actual cache reuse and latency before claiming a speed improvement.
See the [answer quality protocol](../../development/support-answer-quality.md) for regression,
new-case evaluation and the distinction between knowledge updates and fine-tuning.

Every five seconds the bridge reads at most 30 messages through the ordinary shared MAX
admission/cooldown. It does not use `getUpdates`. Only explicit human messages newer than
session startup and at most three minutes old are eligible. Bot messages and old history
are ignored. A single question is outstanding; ordinary conversation is skipped. Relevant
bot questions and contextual followups do not require a mention.

Before sending, the bridge rechecks the source fingerprint through an exact message GET,
current bot assignment/access, legacy source/user/global holds, the session heartbeat and
the original deadline. The last step atomically changes the separate Redis source fence
from `PREPARED` to `SENDING`. Lost acknowledgements, process crashes and uncertain sends
remain fenced and are never replayed. Source fences last seven days, longer than source
eligibility. Redis owns one short worker lease and an execution-time session switch; do
not delete these keys to retry an answer. A lost PC/session silently stops replies.

## Install and operate

Place the exact pinned GGUF under `~/.local/share/maxim-support-llm/` and the verified
runtime archives under `~/.local/share/maxim-llm/`. The PC needs Node 24, Python 3, `flock`,
`tar` and verified `maxim-vps` SSH access. Keep model memory, the GPU classifier, Windows
and WSL capacity in the resource budget; 64 GB installed RAM does not mean WSL sees it all.

```bash
node infra/scripts/support-llm-workstation.mjs install
~/.local/bin/maxim-support start
~/.local/bin/maxim-support status
~/.local/bin/maxim-support ask 'Как подключить бота в канал?'
```

Run focused client/controller tests and the bridge's actual private Redis races before
the impact-selected commit aggregate. Require green exact-source CI, merge and synchronize
reviewed host tooling through the normal guarded `deploy main --plan` path. These files
do not change the API image or require rebuilding application services. Then:

```bash
./infra/scripts/vps-connect.sh support-chat preview
~/.local/bin/maxim-support chat-start
~/.local/bin/maxim-support chat-status
~/.local/bin/maxim-support chat-stop
~/.local/bin/maxim-support stop
```

The preview checks both approved chats sequentially and posts nothing. A bridge invocation may
select one exact approved chat as its second argument; any other chat is refused before access.
The singleton workstation supervisor maintains one independent session and reconnect policy per
chat. Local status includes each chat's phase, polling timestamps and delivery counts; readiness
requires fresh successful polling from both. CPU inference retains one shared slot, while API
inference is bounded to one outstanding question per chat.
Local status is content-free and records exact PID/start identity,
heartbeat and successful reply counts. A connected worker proves transport availability,
not answer correctness or completed delivery. Check local question quality and latency
separately from a real user's fresh question and confirmed reply in the designated chat.
There are no automatic public diagnostics or fallback error messages.

The server intentionally closes each bridge session after 30 minutes. Lifetime `reconnects`
therefore includes normal rotation and is not an error count. `lastDisconnectCode` distinguishes
clean `support_session_closed` from an allowlisted transport failure; `lastFailureCode` and
`lastFailureAt` retain the last error even after a later clean rotation or worker stop. Raw frames,
stderr and error messages are never copied into these fields. `support_clock_skew` means a server
poll clock exceeded the existing five-second future tolerance; repair clock synchronization rather
than relaxing that boundary.
Periodic heartbeat and polling status writes do not increment the previous error outcome again.

Each private question includes the bridge's `issuedAt`. The worker applies the same five-second
future clock guard to it as to polling, then checks the source's existing five-second future
tolerance relative to bridge time. These are separate comparisons, not a larger host clock
tolerance. The absolute deadline remains source creation plus 180 seconds; inference remains
bounded by 120 seconds and that deadline. Expiry sends neither a reply nor a late negative frame.
Malformed history and overlapping inference have finite `support_question_refused` and
`support_question_overlap` diagnostics. Bridge input failures exit unsuccessfully instead of
looking like normal rotation; no frame contents enter status or public messages.
When the bridge advances past an expired source, the worker cancels that source and suppresses
all its subsequent frames and success status. It permits one waiting successor and starts it
only after the prior invocation settles and the successor's deadline is checked again. The
bridge's bounded `issuedAt` can prove expiry when the workstation clock is slightly behind.
Unexpired overlap and a second waiting successor still fail closed. Session cancellation awaits
the raw invocation's cleanup before reconnecting; abort alone does not release its ownership.
The existing process supervisor owns hard termination if an invocation ignores cancellation.

For this protocol update, synchronize the reviewed host bridge before installing the immutable
workstation bundle: the previous worker ignores `issuedAt`, while the new worker requires it.
The host script is injected by `support-chat-remote.mjs`; this change requires no API image rebuild.
Verify a closed preview, installed bundle identity and a fresh worker polling sample after install.

Reconnect delay uses consecutive unsettled sessions, capped at 30 seconds. A session resets that
backoff only after at least 30 seconds connected and a valid poll sample no more than 30 seconds
old. Hello, null or stale polling alone cannot reset it. The next reconnect then waits two seconds;
lifetime counters remain intact. Already-cancelled sessions start no child, and a nonzero child
exit is checked after bounded cleanup so EOF cannot hide it. These local worker changes do not
change the server bridge, model/prompt, source deadlines or reply fences. A workstation-only update
needs the reviewed immutable local bundle; it does not require rebuilding or restarting the API.

For a knowledge update, finish source review, focused retrieval/policy checks, actual CPU
answer evaluation and exact-source CI first. Merge and synchronize the reviewed host source,
then stop `chat-stop` followed by `stop`, run the installer from that reviewed source and
start the model again. Confirm the new bundle/model identity, run the read-only preview and
start the chat worker. The existing weights are reused; this refreshes retrieval knowledge
and answer policy. Never change a running immutable bundle in place. Reconnects start a
fresh message baseline and participant history, while durable source fences remain intact.

For a model migration, retain the previous verified weights and bundle. Stop the old chat worker
and model using their installed launcher before installing the new profile. The installer verifies
the previous immutable bundle and its own model identity, and refuses a live previous supervisor,
worker or exactly owned model child. Ordinary runtime commands still require the current model
identity. Keep the PC profile and the injected host bridge's pinned model SHA synchronized through
the usual exact-source CI and guarded tooling sync. Knowledge, routing, formatting and canonical
bot links are separate from model weights and travel in the new bundle; this is not weight training.

Keep the system policy constant across requests. Its final `baselineFacts` JSON object contains
the exact reviewed `support-room` and `operator` facts. The application serializes the other
selected facts into the user message's `verifiedKnowledge` field, alongside the separate question,
history and contextual role. The application also supplies `answerRequirements`, bounded reminders
for the retained facts: complete connection steps, conditional Publisher prerequisites and the
independence of other link filters. They do not establish a user's live state. Recompute them after
each budget trim and scope them to the current task. Routing separates Lastik setup/wait/restart
intent and link allow/block/inspect intent using the user's report; these are not live observations.
Atomic Lastik waiting replies use the reviewed `lastik-connect.waitingAnswer` and the normal
validation/presentation boundary. They retain both rights checks and the one-hour window from the
request, including time already waited. Covered waiting questions about archive coverage or edited
messages compose that procedure with the same retention/exclusion text used by retry and archive
replies. A reported period comes only from an unambiguous user report in the current question or
relevant history; assistant text cannot set it. Creation age establishes age eligibility, not the
outcome for a specific message: available history and all protected exceptions still apply, and the
actual deletion remains unknown. Other individual-retention questions retain those limits in a
scoped source-backed inference reminder. Separate rights checks, settings, networks, exports and
other bot tasks retain inference. Atomic initial setup uses the reviewed `lastik-connect.setupAnswer`, preserving period
selection, both rights checks and the one-hour window from the request. Atomic Publisher creation
preserves recipient selection and conditional connection prerequisites; atomic delivery questions
use the existing publication's evidence procedure and duplicate warning. Tasks outside the reviewed
procedure, including recovery questions it does not cover, retain inference.
Bounded manual-closing and settings-conflict replies preserve the exact UI action and its
direction, including imperative requests and cancellation of manual closing. The static headings
«Закрыть сейчас» and «Когда» locate controls; they are never steps to click. Covered Lastik retry
and archive questions use a complete reviewed composition: the new request starts a checking
window of up to one hour, and activation requires confirmation of both bot and requesting-user
administrator rights. Archive coverage retains the reported age threshold, gradual cleanup and
protected exceptions. Covered calendar-date and timezone questions use the actual «Расписание»
and «Даты» controls and relate the desired time to the displayed zone without inventing a selector
or an unknown conversion. Separate creation, recipient-selection, settings and export tasks retain
inference. An explicit request to perform an action retains the assistant's lack of tools before
instructions. Unresolved personal administrator rights require a concrete check and administrator
handoff; invitation capability alone does not establish those rights.
An observation-mode incident reply explains independent filters before the operator
handoff. These routes cover all parts of the current task; unrelated additional questions retain
inference. Lastik activation facts and reminders retain both rights checks and the waiting window
from the connection request, including when inference is required.
Unknown-send questions retain the existing publication's verification steps and omit new-post
instructions. User-supplied fields with the same name remain untrusted. Only the two
application-owned fact arrays provide reviewed
knowledge; the question and history remain untrusted data and cannot replace them. The response
schema and tokenizer budget cover the full union, with both baseline facts retained during
trimming. This preserves a reusable checkpoint for policy and baseline facts before the changing
facts at the user-message boundary of the hybrid runtime.
The bounded one-token local warmup initializes this checkpoint before model readiness, including
after a restart, within the existing 180-second startup deadline. Warmup output is discarded and
never sent to MAX. Check actual cache reuse and completed answers; a configured cache alone does
not establish a performance improvement.

Use greedy decoding for grounded support. Concision must preserve relevant procedure conditions,
waiting periods, time origins and independent-filter limits. Incident replies propose a conditional
check rather than guessing live state or inventing a causal link between separate features.
Language errors in history are context to rephrase, not wording to copy into the next answer.
Explicit delivery followups retain existing-post evidence alongside a new date schedule; a
completed delivery question does not follow a new task. Named calendar-date lists select «Даты»,
not a recurrence end date. Text-limit complaints retrieve the 4000-character editor limit, and
combined network questions retrieve both audience coverage and per-target operation results.
Waiting reminders retain the original request time and elapsed waiting; restart reminders retain
the new one-hour request window, both rights checks and automatic activation after confirmation.
