# Exact group moderation diagnosis

Use `postgres-audit chat-moderation` when a group responds to «Старт» but its
automatic filters appear inactive. Resolve the exact group first. A navigation
screenshot does not establish saved filter settings; a successful Start does not
enable them or prove the later message's DELETE outcome.

Synchronize the reviewed catalog through the normal exact-green tooling path,
then preview and apply `postgres-audit-provision`. The optional extension grants
eight settings columns and four administrator-roster metadata columns together;
partial schemas receive none. The existing two chat and seven membership metadata
columns remain unchanged. No full-table SELECT or mutation grants are added.

Run the plain plan and report sequentially for one exact negative chat ID:

```bash
./infra/scripts/vps-connect.sh postgres-audit chat-moderation '-78271094414679' --explain
./infra/scripts/vps-connect.sh postgres-audit chat-moderation '-78271094414679'
```

The report uses exact chat/settings/roster key lookups and at most nine indexed
bot membership heads, retaining eight with a saturation sentinel. It preserves
the shared audit lock, dedicated read-only single-session role, 2.5-second
statement and eight-second wall limits, fixed public schema and memory/temp
budgets. Missing settings, incomplete roster state and uninspected policy JSON
remain unknown. Oversized link policy and unsupported compression are never decoded;
small PostgreSQL 16 compressed values require a conservative decompressed-size bound. The report
contains no message text, human IDs, configured words/domains or raw permissions.

Saved access and roster clocks are observations, not fresh MAX rights or proof of
execution. A nonempty supported link-rule envelope still requires the runtime's
full validation; scalar SQL shape checks do not grant deletion authority. The
report authorizes no configuration changes, replay, queue cleanup or sanctions.

Compare the settings with the actual message author: known administrators and
owners are protected from automatic user-message deletion. For a participant's
eligible message, use the existing bounded `chat-message-window` report for its
exact UTC minute, narrowing to five-second slices if the sample is saturated.
`PROCESSED` proves receipt processing only. Establish the applicable rule and a
verified DELETE or message-absence outcome before reporting recovery. Retain the
source/image, observation windows, saturation, failed exits and missing evidence
in the private task record; never fill a missing observation with an assumption.
