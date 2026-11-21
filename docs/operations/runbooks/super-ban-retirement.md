# Developer Super Ban retirement

Release the shared API across every role before accepting the retirement. During a partial rollout, an older consumer can still process historical work. Verify the selected SHA and image identity for all roles through the guarded release command. Use the normal strict smokes and record missing observations. Avoid test commands in public groups.

The action worker no longer consumes `admin-super-ban`. Preserve retained Redis jobs, pending effects, SQL evidence and original-source inventories. The historical recovery catalog can identify those jobs for review. Clearing Redis, retrying them or manually marking them complete destroys evidence. A mixed or unknown registry source requires independent current evidence before enforcement. Historical developer fallback mutes are identifiable by their original metadata. A generic `MANUAL_BAN` event cannot identify the initiating command. Leave independent manual sanctions and their normal release operations in place.

Both API rollback entrypoints check the selected API source before switching the image. Keep the current rollback controller and choose a compatible fixed release when a rollback is needed. The retirement itself performs no bulk unban, database purge or queue cleanup.
