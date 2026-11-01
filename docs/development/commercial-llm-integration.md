# Commercial advertisement LLM integration

## Current scope

The shadow design below describes the initial observation mode. The implementation
also supports guarded asynchronous `DELETE_ONLY` enforcement and the three-node
pool. In active enforcement, synchronous `COMMERCIAL_AD` results are removed before
AI admission; a missing, expired or refused AI result does not restore baseline
enforcement. A model result alone never grants an effect: current source, policy,
rights, immunity, deadline and exact durable DELETE proof still apply.

The pool's `confirm-positive` policy requires an immediate available 9B consultation
after a positive or uncertain 4B result. A negative 4B result completes without that
consultation. `direct-4b` is a separate supported policy, not the default or an
automatic capacity fallback. Commercial image analysis is retired; image stop-list
OCR is independent.

Use the [pool runbook](../operations/runbooks/commercial-ai-pool.md),
[runtime runbook](../operations/runbooks/commercial-llm-shadow.md),
[quality evidence procedure](../operations/runbooks/commercial-ai-quality-evidence.md)
and [current audit and plan](../operations/plans/2026-11-01-commercial-ai-reliability.md)
for the maintained execution, acceptance and improvement boundaries. Shadow-only
statements, admission budgets and rollback behavior below apply to that initial
consumer, not to active enforcement or the pool.

## Objective and authority

Qwen3.5-9B Q5_K_M supplies a second semantic opinion on Russian commercial
advertisements. The initial implementation is **shadow only**: the existing deterministic
filter and all final delete/access/source/deadline guards remain the enforcement authority.
An LLM positive cannot create a DELETE, mute, ban or reputation observation. An LLM negative
cannot cancel an existing guarded decision. No MAX requests originate from this consumer.

This is a deployment and measurement phase, not model quality certification. A running model,
valid JSON and a few correct examples do not establish advertisement recall or false-positive
rates.

## Architecture

```mermaid
flowchart LR
  M[Existing moderation] --> R[Sanitized review samples]
  M --> G[Existing guarded effects]
  R --> B[Bounded background shadow consumer]
  P[Runtime pressure governor] --> B
  B --> L[Private CPU llama.cpp service]
  L --> S[Separate expiring shadow observation]
  H[Blind independent reviewers] --> Q[Human labels]
  S --> E[Offline quality comparison]
  Q --> E
```

The detector/webhook never waits for inference or enqueues new LLM work. Only the existing
`api-moderation-background` role starts the optional consumer. It polls at most 64 recent
review rows through the existing `(observed_at DESC, id DESC)` index. JSON eligibility checks
follow the limited indexed head; it never scans the 14-day retained history to fill a batch.
It considers the oldest eligible unfinished sample within this head, with a 15-minute lookback.
Overload is dropped by design: `pageCapped` reports a capped head, not a precise dropped-message
count. Repeated scan counts are observations of pages, not counts of unique messages.

Admission requires the existing governor to return `run`, at least 12 GiB host `MemAvailable`,
and a dedicated fail-fast Redis lease/cooldown. There is one client request at a time and at
most one admission per 10 seconds across overlapping consumers. A 120-second lease contains a
90-second work budget and a 60-second absolute inference deadline. Ownership is checked before
inference and persistence; loss aborts the request. Shutdown stops admission and aborts HTTP.
DB statements retain the production timeout; there is no long transaction around inference.

Only unexpired complete **TEXT** samples with source, logical-message and settings identities
are eligible. Review capture already redacts contacts and limits excerpts to 2,500 characters;
truncated, image-required, OCR and incomplete records are excluded. The model sees the excerpt
only, without chat/user IDs, bot credentials, human labels or the detector's decision. It has no
tools, public port or outbound network access. This phase makes no claims about image contents.

## Reproducibility and persistence

The runtime image, GGUF and embedded chat template are pinned by digest in
`infra/scripts/commercial-llm-profiles.mjs`. Provisioning verifies exact byte counts and SHA256
before starting the service. Weights live outside Git, Docker build contexts and API images.
The bounded independent service is limited to 6 CPU, 12 GiB RAM, one slot and 4,096 context
tokens; reasoning is disabled. Its attestation receipt is independent of the three application
release components. See the operational runbook for the guarded installation commands.

The versioned Russian prompt treats the source as untrusted JSON data and asks for
`COMMERCIAL`, `NOT_COMMERCIAL` or `UNSURE` plus a closed set of reason codes. A grammar constrains
JSON generation; the client also validates schema, category/reason consistency, exact model
alias, completion status, response size and deadline. Free-text rationale, quotes, tools,
reasoning and numerical confidence are rejected. A generated confidence is not a calibrated
probability.

`commercial_review_samples.llm_shadow` is an additive nullable JSON column. Results have the
same retention/cascade lifetime as their source sample. Human labels, ratings, review state,
evidence and strict shared quality metadata are not overwritten or exposed to the model.
Source/policy/retention are checked again before a conditional write. Existing execution
enrichment cannot replace this separate observation column.

The input identity binds logical message, exact source snapshot, settings profile, sanitized
excerpt, model SHA, prompt SHA, runtime version and protocol policy version. Mirrored captures
reuse the existing evidence identity; an edit or policy/model/prompt change cannot reuse a
verdict based solely on matching redacted text. Technical failure is stored distinctly and
never interpreted as either class. A sample is attempted once per input identity in this pilot;
transient failures remain visible rather than creating a retry backlog.

## Delivery and acceptance stages

1. **Local and CI validation.** Run focused protocol/HTTP tests and native PostgreSQL/Redis races,
   including concurrent consumers, source expiry/change, blind reviewer preservation, retained
   history bounds, pressure, cancellation, malformed output and dependency failure. Complete
   the impact-selected aggregate, then require exact-SHA `Required` and JavaScript/TypeScript
   analysis before any production mutation.
2. **Bounded installation.** Synchronize reviewed tooling without runtime changes, install and
   attest pinned artifacts under the shared deploy lock, enable the shadow setting and deploy
   the shared API image through the normal release path. Recreate all API roles and native
   auxiliaries without recreating stores. Preserve Svyazka and Karavan resources and routes.
3. **Technical readback.** Verify model/image/template identities, cgroup limits, no public port,
   closed synthetic structured inference, real latency and memory, strict application smokes,
   background heartbeat and recorded coverage/technical failures. Compare the same host and
   sibling-container observations before/after. Report missing samples explicitly. Keep
   historical quarantine separate from new active queue progress.
4. **Independent quality evaluation.** Collect blind human labels, adjudicate disagreement and
   report model-vs-human and detector-vs-human errors separately. Preserve source sampling
   probabilities and report incomplete, excluded and capped coverage. This pilot's admission
   subset is not automatically representative of all messages. Reserve a holdout split by time,
   author and campaign; edits, mirrors and near copies must not cross splits. The existing
   protected-negative/offer/time and confidence-interval gates remain prerequisites for an
   enforcement proposal; do not weaken them to obtain a green result.
5. **Optional enforcement proposal.** Only after quality and latency acceptance, design a new
   explicitly versioned guarded authority. It must retain fresh rights/immunity, source/edit,
   policy and original absolute deadline checks. Inference completion must never renew the
   five-minute text-delete proof. Activating new model-driven effects requires a separate
   reviewed product decision and compatible readers across both rollback paths.

## Training decision

No local fine-tuning is required for installation. Start with the frozen instruction model,
strict prompt and independent error analysis. Fix input completeness or policy ambiguity before
training. If the frozen model repeatedly fails a defined class despite prompt improvements,
prepare an independently labelled train/dev/holdout corpus with campaign separation. Evaluate
classical/reranker baselines alongside LoRA/QLoRA; a larger generative model is not automatically
the best final classifier. Train on a separate GPU machine, never on the shared production
host. Ship a new immutable quantized artifact only after holdout and CPU resource evaluation;
retain the prior model and receipt for rollback.

## Operational evidence and rollback

The consumer uses one optional PostgreSQL connection with a 1,500 ms statement timeout and
1,000 ms lock timeout; it does not change other background SQL budgets. Shadow writes advance
the sample's existing `updatedAt` revision, so an already open review form may need a refresh.

The consumer emits content-free structured `commercial-llm-shadow` observations: heartbeat,
outcome, duration, scanned/ineligible counts and head cap. Redis status expires after five
minutes; stale/missing status is a gap. Model availability and heartbeat are distinct from
successful classifications and independent quality acceptance.

Stopping the optional service immediately removes its CPU load and leaves the existing filter
operational. Disable future admission through the guarded environment operation and the normal
API deployment flow; abort/expiry contains an in-flight observation. Do not delete review rows,
queues, Redis namespaces, other projects' containers or retained model artifacts to roll back.
Old API images ignore the additive nullable column. No rollback may bypass existing reader
floors or the protected deploy lock.
