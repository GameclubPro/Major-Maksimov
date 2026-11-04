# Local Runtime Observer

The observer reads the shared Safety Desk evidence every 15 seconds. It never collects SQL,
reads message text, clears queues or deploys. The admin collector and its existing bounded
PostgreSQL/Redis budgets remain the only source of observations. Machine reads omit history,
coalesce simultaneous Redis reads and cache them for one second. Missing evidence stays missing.

## Access And Configuration

Use Node 24, the normal separate `npm ci` dependencies and the public contracts build in this
checkout. Do not run the observer from a mutable task checkout or share its writable dependencies
with CI runners. Prepare a private configuration without starting observation or sending mail:

```bash
npm run observer -- init
npm run observer -- check
```

The default directory is `~/.config/maxim-observer` with mode 0700 and files 0600. Existing
configuration is never replaced. Safe 0755 XDG parents are allowed. `overview-reader.json`
contains a new independent token and Basic Auth password. `server-provision.json` contains
the token SHA-256 and Basic credentials needed for server installation; keep it private.
The observer does not receive `ADMIN_ACCESS_CODE`, MAX credentials, SSH or deployment keys.

Provision `RUNTIME_OVERVIEW_READER_TOKEN_SHA256` from that private file for `api-admin` only;
both Compose topologies explicitly erase it for other API roles. Blank disables the endpoint.
After the exact-SHA application release, install the separate `maxim-observer` Basic Auth entry
in the existing nginx admin credentials file using a private input, preserving other entries.
Follow the [nginx/environment procedure](../../development/production-operations-reference.md#nginx-and-edge).
Never print either password in command arguments or logs. nginx already authenticates the
closed host and overwrites `X-Remote-User`; the reader additionally requires that exact user,
the token, admin role, allowed host, HTTPS forwarding and a permitted origin.

Only `GET /api/v1/safety-desk/runtime-observer/overview` accepts the machine token.
The existing owner/support content and mutation routes retain their separate admin access code.
Reader tokens are redacted from HTTP and provider error logs. The response uses the existing
strict overview contract without message contents; the observer retains only timestamps,
fixed reason codes, delivery identities and bounded numeric counts.

## Mail.ru

An ordinary Mail.ru mailbox works. The approved sender and recipient are `73budchenko@mail.ru`.
Create an application password in Mail.ru account security and save its single line in
`~/.config/maxim-observer/mailru-app-password` using a local editor. Keep mode 0600.
Do not use the mailbox login password or put the application password in Git/chat.
The fixed transport is `smtp.mail.ru:465` with certificate verification and a 30-second total
deadline. `check` reports whether the password is present, without connecting or sending mail.

An empty password keeps events pending without consuming delivery attempts. The next poll
reloads the private configuration. If the incident recovers before any attempt, its unsent
problem is suppressed. No unsolicited test email is sent by init/check/status.

## Incidents And Delivery Evidence

Critical latency requires more than 30 seconds of measured receipt/action delay and two
minutes of continuous advancing source observations. Completed-action p95 alone never
proves a healthy unfinished queue. Partial, stale or missing samples interrupt confirmation;
two minutes of missing/incomplete observation raises its own incident. The panel separately
shows the warning threshold above 10 seconds. A silent idle bot does not fail merely because
it has no incoming messages. Publisher uses its own heartbeat and dispatch state.

One incident creates one problem event; a complete healthy sample creates one recovery event
after a sent or uncertain problem. Identical state creates no repeat emails. The service uses
a real Linux flock so a second process cannot observe/send concurrently. Atomic private state
is fsynced before SMTP begins. A crash during `SENDING`, an unproved transport outcome or loss
of the final DATA acknowledgement becomes `UNCERTAIN` and is never automatically resent.
A definite rejection may retry after five minutes, at most three total attempts. Successful
SMTP acceptance means the provider accepted the message; mailbox arrival is a separate check.

```bash
npm run observer -- run
npm run observer -- status
```

`status` reads the atomic state without acquiring the live process lock. It reports the last
poll heartbeat, last advancing source observation, active incident and delivery counts.
An old heartbeat means observation has stopped; it is not evidence that the bots recovered.
On restart critical confirmation starts again, persisted uncertain delivery stays fenced.
Invalid state, unsafe paths or a full 256-event ledger stop safely with a fixed error code;
preserve evidence for review instead of deleting it to cause a resend.

## Supervision And Acceptance

The [systemd unit](../../../infra/systemd/maxim-local-observer.service) is an installation
template for a Linux host with systemd. It runs as a dedicated unprivileged `maxim-observer`
user, with read-only sources in `/opt/maxim-observer`, private configuration in
`/etc/maxim-observer` and `config.json.stateDirectory=/var/lib/maxim-observer`. Configuration
must be readable only by that user; the code and dependencies must remain root-owned.
Verify `/usr/bin/node` is Node 24 and the public contracts build is present. The unit caps
CPU/memory and allows graceful completion of an already-started bounded SMTP attempt.
Do not install/start it until the reader release and credential provisioning are accepted.

WSL without systemd cannot use this unit. Windows/WSL boot supervision and an actual reboot
test are independent acceptance gates. CI VM runners must have no access to observer files,
Windows user mounts, mailbox credentials or deployment identity. WSL interop with writable
Windows mounts does not establish this isolation.

Before activation, prove fresh and stale responses through the restricted real nginx path,
403 on owner/support routes, restart/no-replay, lost observations, SMTP absence/reappearance,
one problem/recovery pair and process/host reboot. Sending a problem notification must follow
a real incident or an explicitly selected acceptance scenario. Record SMTP acceptance separately
from inbox arrival. A local process/unit test is not production or reboot acceptance.
