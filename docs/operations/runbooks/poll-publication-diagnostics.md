# Managed poll publication diagnostics

Use this report when an existing poll repeatedly fails to render or its message
cannot be read. A bare MAX HTTP 403/404 does not prove revoked access or a deleted
message. Preserve the original publication bot, message binding and uncertain
effect evidence until a stronger result is available.

Synchronize the reviewed tooling through the normal exact-green-CI deploy plan.
Preview `postgres-audit-provision`, review its exact grants, then apply with
`postgres-audit-provision --apply`. The report adds nineteen metadata columns:
twelve on `managed_polls` and seven on `chat_bot_memberships`. It grants no
question, image, voter, actor or permission payload access. General reports accept
an absent legacy metadata group; this report requires both complete groups.

Take one poll ID from a bounded incident log. Run the plain plan first, then the
report sequentially under the existing audit lock:

```bash
: "${POLL_AUDIT_ID:?Set one reviewed poll ID}"
./infra/scripts/vps-connect.sh postgres-audit poll-publication "$POLL_AUDIT_ID" --explain
./infra/scripts/vps-connect.sh postgres-audit poll-publication "$POLL_AUDIT_ID"
```

The query reads one poll by primary key and joins only its exact original bot
membership through `(chat_id, bot_id)`. Admission attests both unique indexes;
the shared audit wrapper retains its server and wall-clock limits. Reject a live
plan that scans retained membership history. This opt-in report is excluded from
`all` and accepts no SQL, paths, repair flags or bulk IDs.

Interpret the report narrowly:

- `found=false` means the local poll row is absent; it says nothing about MAX.
- Missing publication/bot metadata requires binding investigation. Never borrow
  another moderator or automatically republish the poll.
- Missing or denied original membership explains why local authorization may
  refuse an effect. Confirm the exact activation/capability boundary separately;
  this report deliberately does not read permission payloads.
- Matching revisions describe persisted rendering state, not current remote
  message presence. A positive membership is durable role evidence, not proof
  that the original message can still be edited.
- Error families are coarse classifications of retained errors. In particular,
  `http_404_unknown_presence` cannot authorize deletion, cancellation or replay.

Keep the UTC incident window, exact runtime SHA and report time with the evidence.
Diagnostics never mutate poll status, membership, callbacks or publication ledgers.

## Background pressure

The background render-repair pass consults the shared runtime governor before selection and
each repair. Pause admits no work; slow admits at most one repair and retains the governor's
retry interval. A five-second dispatch budget stops new repairs without cancelling an edit
already in progress. Shutdown stops further admission and drains the owned pass. SQL revision,
error and publication evidence remain unchanged when admission is deferred; a skipped repair
is not a successful render or proof that a publication was deleted. Interactive poll operations
retain their existing exact access and publication guards.

## Repeated unknown access results

Repeated ambiguous access failures use a durable, exact-publication retry schedule:
5, 10, 20, 40, 80, 160, 320 minutes, then at most six hours between attempts.
Only consecutive ambiguous access results increase the count; an explicit access denial
or other transport failure uses the existing five-minute delay. MAX admission and token
cooldowns continue to apply. A timeout or 429 does not inherit a six-hour access delay.

PostgreSQL stores the next attempt and the original message/bot identity. Background
selection excludes waiting rows before its ten-item limit, so they cannot fill the batch.
Votes and render-revision changes do not reset the wait. A replacement message or bot
has its own schedule; a stale failure cannot update a replacement binding. Successful
rendering clears retry state together with the guarded rendered-revision update. The
bounded local/Redis five-minute cooldown remains a fallback if persistence fails.

An explicitly authorized manual refresh may bypass the extended wait after the same
five-minute minimum. It retains the ordinary access checks and never republishes the
message. A failed manual attempt advances the same consecutive-failure schedule.
Closed polls remain eligible for final-result repair. Unknown presence never closes a
poll, clears its binding, removes bot rights or authorizes a replacement SEND.

The column migration adds only nullable/constant-default columns without a history backfill.
A separate concurrent partial index orders pending format-v7 repairs by their effective due
time; delayed polls and rendered history do not require scans before admitting a batch.
Presentation-format upgrades must update this index and the native history-plan regression. Previous runtime versions ignore these columns and keep their old retry
frequency; rollback preserves publication identity and stored retry metadata.
