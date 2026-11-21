# Developer Super Ban retirement

Release the shared API across every role before accepting the retirement. During a partial rollout, an older consumer can still process historical work. Verify the selected SHA and image identity for all roles through the guarded release command. Use the normal strict smokes and record missing observations. Avoid test commands in public groups.

The action worker no longer consumes `admin-super-ban`. Preserve retained Redis jobs, pending effects, SQL evidence and original-source inventories. The historical recovery catalog can identify those jobs for review. Clearing Redis, retrying them or manually marking them complete destroys evidence. A mixed or unknown registry source requires independent current evidence before enforcement. Historical developer fallback mutes are identifiable by their original metadata. A generic `MANUAL_BAN` event cannot identify the initiating command. Leave independent manual sanctions and their normal release operations in place.

Both API rollback entrypoints check the selected API source before switching the image. Keep the current rollback controller and choose a compatible fixed release when a rollback is needed. The retirement itself performs no bulk unban, database purge or queue cleanup.

## Historical inventory

The production audit reports counts for one page of one storage family. Synchronize the reviewed catalog and run the audit-role provisioning preview. The reviewed apply installs projections in the private `maxim_spammer_audit` schema. The audit login can read classification flags and the keys it needs for pagination. Application migrations and historical rows are separate from this provisioning.

```sh
./infra/scripts/vps-connect.sh postgres-audit-provision
./infra/scripts/vps-connect.sh postgres-audit-provision --apply
./infra/scripts/vps-connect.sh postgres-audit spammer-retirement --family registry --limit 25 --explain
./infra/scripts/vps-connect.sh postgres-audit spammer-retirement --family registry --limit 25
```

Run the plain plan before reading each family. The page probe should stop at an ordered index scan under its limit, and classification should use exact key lookups for the selected rows. Pass a nonempty `nextCursor` using `--after` with the same family. Keep cursors in the private operations record because they encode row keys. Each call returns up to 40 rows as counts. A null cursor ends that family's observed pages. Record the sample time, pages completed and any missing pages because rows may change between calls.

The families are `registry`, `candidates`, `chats`, `archives`, `observations`, `profiles` and `campaigns`. Registry reports active retired or mixed entries separately from historical totals. Raw-copy indicators identify stored excerpt or evidence fields and historical URL previews. Compressed or oversized fields contribute to the unmeasured counts. A null count means the family lacks the relevant field. A count provides workload estimates for review. Changing an individual sanction or removing an evidence copy requires independently attributable records and revalidation against their current revisions.
