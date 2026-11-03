# Exact webhook source envelope diagnostics

Use this opt-in read-only catalog after a source admission refuses a known owner
with `source_forward_shape`. It inspects one exact receipt, without searching for
a more convenient source or changing its execution authority.

```bash
./infra/scripts/vps-connect.sh postgres-audit webhook-source-envelope "$OWNER_RECEIPT_ID" --explain
./infra/scripts/vps-connect.sh postgres-audit webhook-source-envelope "$OWNER_RECEIPT_ID"
```

`OWNER_RECEIPT_ID` must be a previously nominated opaque receipt identifier: one
ASCII alphanumeric character followed by up to 127 alphanumeric, `_` or `-`
characters. UUIDs are supported. Review the plain JSON plan first. Synchronize
reviewed exact-green tooling before production use; no new database grants are
required. Run catalogs sequentially under the existing shared audit lock.

The report attests the complete primary-key index and reads at most one
`webhook_events` row. Before materializing JSON, it checks the original column's
storage size and compression metadata on the original table datum. Schema v2
retains the uncompressed physical-size ceiling of 262,144 bytes. On PostgreSQL 16
it also admits pglz values of at most 2,880 physical bytes and LZ4 values of at most
1,028 physical bytes. These conservative method-specific limits bound the decoded
binary datum to 262,144 bytes; they do not raise the existing budget. Missing
receipts, SQL NULL, larger compressed values, unknown compression methods and
oversized values remain explicit. No JSON extraction or unpacking decides admission.

The compressed path assumes coherent PostgreSQL-generated storage. For physical
size S, the sufficient decoded-datum bounds are `4 + 91*S` for pglz and
`4 + 255*S` for standard LZ4 blocks. PostgreSQL's inline and external physical
sizes include the complete compressed stream. The format proofs follow the
[PostgreSQL 16 pglz implementation](https://github.com/postgres/postgres/blob/8e928803020e5b5694cde58e4851fce64ef9d520/src/common/pg_lzcompress.c)
and the [LZ4 block specification](https://github.com/lz4/lz4/blob/779b3556802f61774ed7f03a72023775ffe7795a/doc/lz4_Block_format.md).
The decoder allocates from stored raw-size metadata before validating the stream;
this SQL-only policy cannot independently validate a corrupted physical header.
JSON input cannot directly choose that header. These limits also do not bound
text serialization or every SQL temporary allocation. Keep all query/session limits.

Schema v2 reports a finite `payload_storage`, the exact
`pg16_valid_storage_ratio_v1` policy, its `valid_postgresql_compressed_storage`
assumption, decoded ceiling and physical caps. Consumers must validate this version
and the caps explicitly. A sufficiently small compressed value can now report
`bounded`; larger values can remain uninspected even when their true decoded size
would fit. Neither outcome grants source validation or recovery authority.

Output contains fixed kinds, known type labels and structure booleans for the
normalized event, original message, direct body, flat linked body, linked sender
and linked chat identity. Absent and explicit null metadata remain distinct.
Only ten attachments and 32 formatting entries per body may be expanded; an
over-cap collection is reported uninspected. Unknown keys/attachment/formatting
types are boolean or `other`, never their original names or values. Text, URLs,
tokens, actor/chat/message identifiers and raw errors are not returned. The
structured report omits the requested receipt ID; its plain EXPLAIN may include
that exact caller-supplied opaque ID in the primary-key index condition.

The shape checks separate the deciding forward guard families: object kinds,
allowed keys, outer/linked identity and sequence fields, text and bot-field types,
linked sender presence, sender metadata, attachment and markup structures. They
are diagnostics, not the runtime source validator. Parser text equivalence,
command detection, full media/URL validation, formatting bounds against original
UTF-16 text and complete descendant/effect coverage are not evaluated. An
apparently supported shape grants no no-effects, replay or settlement proof.

The generic attachment `keys_supported` uses its original small structural key set.
For `share`, the separate `modern_share_keys_supported` and
`modern_share_payload_keys_supported` booleans distinguish the modern preview key
sets, including optional `description` and `image_url`. Their fixed value kinds
remain visible without values. A false generic result can therefore coexist with
supported modern keys. These observations do not validate URL safety, lengths,
text equivalence or the separate legacy post-seal content policy.

The existing audit-role privileges, READ ONLY session, pinned schema resolution,
2.5-second statement limit, 250-millisecond lock limit, eight-second wall ceiling,
memory/temp limits, private error handling and exact-backend cleanup remain in
force. The mode is excluded from `all`; it accepts no SQL, file, repair option,
payload or arbitrary range. Its SELECT does not lock the receipt for update.

For an irreversible discard, continue with the complete current
[exact-source abandonment](webhook-source-abandonment.md) admission and cold
protocol. Do not rewrite a source to pass validation, change the predecessor's
status, or infer an outer source identity from forwarded content.

Focused validation with PostgreSQL 16:

```bash
node scripts/agent/with-test-stores.mjs -- node --test --test-concurrency=1 infra/scripts/webhook-source-envelope-audit.test.mjs infra/scripts/webhook-source-envelope-compression.test.mjs infra/scripts/vps-postgres-audit.test.mjs
```

Fixtures cover retained history, exact indexed work, locked rows, malformed and
nullable shapes, over-cap collections, pglz/LZ4 inline and external TOAST, sufficient
decoded bounds, conservatively refused compressed values, oversized payloads, index drift,
limited column grants, privacy, wrapper argument rejection and private SQL errors.
Timed execution plans are local-only; production supports plain EXPLAIN.
