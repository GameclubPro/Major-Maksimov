# Stop-Word Policy Rollout

## Compatibility Release

Deploy the additive `20260916130000_add_stop_words_policy` migration and compatible API runtime first. Keep the original lists and message-limit columns. A null policy is a compatibility state; a malformed non-null policy disables stop-list enforcement instead of falling back to broader legacy matching.

All 14 API roles and both `ocr-native-sandbox` and `photo-native-sandbox` auxiliaries must use the same green exact-SHA image. The normal deploy wrapper owns queue fencing, migrations, health checks and the immutable component manifest. Do not recreate PostgreSQL or Redis. Commercial OCR promotion is separate and remains subject to its existing certification gates.

The compatible rollback floor requires the typed policy reader, current-message stop-word delete guard, and independent-sanction guard. Do not roll back to pre-policy code after any policy has been saved.

## Data Migration

Inside the compatible `api-admin` container, preview the bounded migration:

```bash
node apps/api/dist/apps/api/src/scripts/migrate-stop-words-policy.js --limit 1000 --json
```

Review the separate valid, convertible legacy and invalid counts, `conflicts`, `exhausted`, stopping reason and `nextCursor`. A non-null value is validated, including its version and separate media; its presence alone is not evidence of validity. The command prints no configured text, message templates, media or credentials. It reads one settings row per batch through the primary-key cursor and stops after 60 seconds or the row limit. A capped or interrupted preview is incomplete. Media is stored in `stop_words_media`, separately from `stop_words_policy`, so dispatch guards never select image payloads.

Migration is an independent, explicitly selected operation; it is not required to repair legacy detection or complete the reliability release. If authorized, repeat with `--apply` only after the compatible release is healthy. Resume from the returned `--after <nextCursor>` until `exhausted` is true. Invalid rows remain unchanged; concurrent changes are skipped and require a fresh preview. A policy save and its audit are transactional, followed by shared context-cache invalidation. A failed invalidation stops the command; restore Redis health and rerun from the previous cursor. Apply also refreshes caches for already migrated valid rows, recovering a commit followed by an interrupted invalidation without rewriting policies.

Migration preserves configured sanctions, mute duration, messages, buttons and nonempty media. Only the checked-in phrase mapping expands known built-in compounds; no dictionary guessing or suffix removal is used. Existing IDs are deterministic. Newly created policies default to exact matching, and new chats default to disabled enforcement.

## Editor Release

Apply `20260916140000_default_new_chat_stop_words_policy` with the editor release. It gives future settings rows an independent disabled policy at creation, without rewriting legacy null rows. This prevents later edits to general limits from becoming implicit stop-word defaults in a new chat.

Deploy `miniapp-major-static` after compatible APIs. Use only `https://major-maksimov.ru/app/`. The editor saves through `PUT /chats/:chatId/stop-words` with `expectedRevision`; ordinary settings updates cannot write the policy. Section copy transfers policy content, increments each target's own revision, and leaves the allowlist in its existing ownership boundary.

`GET /stop-words/status` exposes revision and effective OCR availability without returning policy/media. `POST /stop-words/preview` uses the production matcher, requires chat-admin access and does not persist test text or create actions.

Words and phrases ignore letter case in both EXACT and MASKED matching, including Greek final sigma. Matching retains authored rule values and original message fragments/offsets. Sigma folding applies only inside the matcher: stored-policy validation and duplicate identity remain compatible with existing lists. The miniapp adds no explanatory copy about case; see [the active copy decision](../../development/miniapp-product-decisions.md#miniapp-copy-01-текст-должен-помогать-действию).

Legacy null-policy matching also ignores case when excluding product codes. A whole alphanumeric token explicitly present in the configured list (for example, `1xbet`) remains detectable in every case; partial matches inside longer product codes remain excluded.

Full GET responses add optional `storageStatus: valid|legacy|invalid`; `settings-screen` carries the same information as top-level `stopWordsStorageStatus`, outside mutable settings. Full GET/PUT also include optional `settingsRevision` from the authoritative read or committed transaction, so the editor can track its own successful write without inventing a timestamp. It does not authorize rebasing unrelated dirty settings over another administrator's changes. Invalid stored policies retain the disabled runtime fallback. Editor presentation does not rewrite policy/media. Unconvertible legacy state returns structured `STOP_WORDS_POLICY_REVIEW_REQUIRED` without source values. Replacement of invalid storage requires an explicit administrator action.

Network edits and section-copy sources reject invalid storage with `STOP_WORDS_POLICY_REVIEW_REQUIRED`; a disabled presentation cannot become a policy source. Convertible legacy sources remain supported. An explicit full copy from a valid source retains its confirmed target-replacement behavior. Already committed network operations resume only their cache/readiness followup without rewriting policy storage.

Standalone PUT replaces invalid storage only with boolean `replaceInvalidStorage: true` and the current `expectedRevision`; absent or false intent returns the same review-required conflict. Older cached clients therefore cannot save the disabled fallback over invalid data. The editor sends this flag only after a replacement confirmation bound to the selected chat and revision. Exact committed retries retain the original request and do not add another revision or audit.

Section save and save-before-navigation use the same coordinator. A stop-list-only change sends only the revision API request; a mixed save acknowledges ordinary settings first and then writes the originally submitted policy and stop-list revision. A partial failure retains the acknowledged baseline and remaining draft, and blocks navigation. A stop-list receipt updates only its own policy, revision and storage metadata. Advancing the general settings fence requires an awaited complete settings refresh and a nonoverlapping three-way comparison; a stale, missing, failed or conflicting refresh preserves the old fence.

Validation retains full nested paths and indices, reveals the relevant tab or editor, and focuses the first error. Unadded word and domain buffers remain dirty and survive failed saves and conflicts. A policy conflict requires an explicitly confirmed reload; it cannot reuse the ordinary settings overwrite action. Review-required responses retain the draft, revoke an earlier replacement confirmation and refresh storage diagnostics without automatically retrying with replacement intent. Failed reloads preserve local buffers; successful explicit reloads reset them. Late responses are scoped to the original editor instance, including leaving and returning to the same chat.

Malformed separate media also marks editor storage invalid and hides the editable fallback until review. The existing runtime reader suppresses corrupt media while retaining otherwise valid text rules; final delete guards continue to read policies without image payloads.

An exact standalone PUT retry with saved revision `expectedRevision + 1` and identical normalized policy **including media** redoes invalidation and returns the committed state without another revision or audit. Different content remains HTTP 409. Network writes retain their operation-receipt protocol. Local context TTL is absolute; reads and title changes cannot extend settings freshness. With default Redis 60 seconds and local 30 seconds, a missed Pub/Sub invalidation refreshes within their combined 90-second bound.

OCR availability comes from a diagnostic Redis heartbeat published by `api-media-analysis` every five seconds with a 15-second TTL. It samples existing local readiness and native identity without OCR/MAX requests. HTTP remains loopback-only. Readers verify source, version, size, timestamp and remaining TTL; missing, malformed, stale or unreadable observations yield `unavailable`. The heartbeat never authorizes deletion or changes rollout mode. OCR stop-list actions remain delete-only.

## Bounded Audit

Use `./infra/scripts/vps-connect.sh postgres-audit moderation-outcomes [--bot <bot-id>]` sequentially. This reviewed collector checks its index and admits at most 513 recent indexed events, reporting 512 over a fixed 60-minute recorded-event window. It retains the existing statement/lock limits and audit grants. No message text, configured words/domains, identities or raw errors enter the report.

`stop_words_rows` separates WORD, DOMAIN and OCR observations into `DETECTED`, `GUARD_REJECTED`, `GUARD_DEFERRED`, `DELETE_REMOTE_CONFIRMED` and `OUTCOME_UNKNOWN`. Only BOT DELETE events with boolean `moderationDeleteVerified: true` prove a deletion. Fixed `rejection_reason` values distinguish policy/source changes and protection/immunity; unsupported or historical diagnostics remain `UNSPECIFIED`. Refusal events are emitted only after a lease-owned terminal guard transition, never for a concurrently added executable reason. A fresh certified bot-rights loss emits `permission_changed` with separate `GUARD_DEFERRED` evidence only when the owned intent actually enters `WAITING_CAPABILITY`, preserving peer failover and retry. Counts are recorded events, not unique messages or eligible inputs; detection and guard coverage flags remain false. Check `sample_truncated`, `sample_complete`, scope and timestamps on every report. Empty or capped results do not prove fleet accuracy.

The existing profanity audit also recognizes domains and stop-list OCR and requires boolean deletion proof. Its text opt-in applies to built-in profanity only; stop-list content remains excluded. Use the reviewed collector above for routine production SQL.

## Acceptance

Select validation with `scripts/agent/plan.mjs --worktree`; run affected callers and focused unit/native regressions before the helper's final aggregate. API coverage includes concurrent revision PUTs and Redis-failure retry, lost cache Pub/Sub under continuous reads, visible text/caption carriers through webhook→intent→fresh guard→DELETE, legacy inflections/masking, two-pass OCR identity, reply/forward/paragraph boundaries and fresh policy/source/immunity refusal. Test heartbeat freshness, invalid values, Redis failure, restart and module composition. Use actual disposable PostgreSQL/Redis for storage invariants.

For the mini app, run mobile browser flows covering section and leave-save, mixed changes, partial failure, stale revisions with retained drafts, confirmed reload, errors in hidden tabs and invalid-storage replacement. Check iPhone and Android, light and dark themes, keyboard overlap, scrolling and maximum-length entries. Preserve explicit EXACT/MASKED; fuzzy matching, mass policy rewrites, MASKED accent support and Unicode length changes are separate work.

Release the compatible API before the mini app. Each runtime release requires green `Required` and `Analyze JavaScript and TypeScript` on the exact selected SHA, guarded deployment and strict role/native smokes. Verify the canonical mini app, ingress/admin health, synchronized VPS SHA, all 14 API roles, both native identities and component manifest. Verify new policy and old-client rejection using only the designated test entities, freshly checked exact bot/admin access and uniquely marked own messages. Do not sanction real participants or replay historical messages; restore scenario settings. After the last release and controlled scenarios, observe for 30 minutes with identified collector processes, heartbeat and last-successful samples. Missing observations remain acceptance gaps; earlier diagnostics do not substitute for this window.
