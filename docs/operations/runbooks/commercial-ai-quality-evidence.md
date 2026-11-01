# Commercial AI quality evidence

Use separate evidence for classification, permission to delete, and the confirmed
effect. A standalone model response does not establish the running pool policy or
an actual deletion. Missing responses, `UNSURE`, capacity refusals and technical
failures are distinct outcomes. The deterministic quality report cannot certify AI.

## Collection without human reviewers

Use the existing bounded commercial audit collector described in
[the collection runbook](commercial-quality-rollout.md). Freeze the exact source
revision, requested and observed UTC windows, candidate limit, source/file hashes,
sanitized inputs, source completeness and sampling limitations outside Git. A newest
capped receipt sample is a diagnostic cohort, not a probability sample of traffic.
Repeated messages, authors and campaigns are correlated observations.

Use only complete inputs that pass the privacy checker. Obfuscated digits and
contacts are masked using a separate scan representation; original moderation text
and phone-detection evidence remain separate. Unresolved contact candidates refuse
audit output and model input. Record omissions explicitly rather than assigning a
negative classification. Preserve layout and original fingerprints when exporting.

For an observation with a real model, pin model, prompt, template, runtime and
support artifact identities before starting. Use ordinary idle-only admission and
the original deadlines, bounded duty and a finite run deadline. Observation tools
must not construct MAX effects, register enforcement work, replay webhooks, change
the pool policy or clear leases. Record heartbeat, last successful response, each
terminal outcome and observed process exit. A missing response is not a negative.

Two blinded AI assessments may supply a provisional `AI_REFERENCE` comparison.
Freeze them before inspecting model responses; preserve disagreements as `UNKNOWN`.
They do not constitute two independent human reviewers. No reviewer account, human
rating, policy approval or independent truth may be fabricated to complete a report.

## Private report

```bash
npm run moderation:report-commercial-ai-quality --workspace @maxim/api -- \
  --input /absolute/private/evidence.json \
  --output /absolute/private/report.json
```

The input is a bounded `commercial-ai-quality-evidence/v1` bundle. Its modes are
`CAPTURE_DIAGNOSTIC`, `AI_REFERENCE` and `INDEPENDENT_REVIEW`. Captures can contain
standalone diagnostic results or separately source-bound AI observations; a
standalone result never creates an admission, policy or effect receipt. Preserve
`diagnosticOutcome` for capacity, privacy, unsupported inputs, transport uncertainty
and absent work. Output files are new private files; existing files are refused.

The report checks declared identity and provenance and reports missing evidence.
It does not collect production data, infer missing attempts, contact MAX, write the
database, install policy or authorize promotion. No source text, contacts, reviewer
identities or source identifiers appear in its aggregate output.

`CommercialAiReviewItem.llmEnforcement` is an optional typed observation projection
in the dedicated `@maxim/contracts/commercial-ai-quality` export contract. Ordinary
Safety Desk queue items keep their lightweight contract. AI evidence is hidden
before the independent rating. Its absence means not observed. The
schema and reporter alone do not install a durable production observation writer;
exports lacking the field retain an explicit evidence gap. Existing synchronous
capture for AI mode uses a distinct asynchronous identity and no completed
classification. It must not be interpreted as a deterministic KEEP or model result.

## Independent quality evaluation

Before examining holdout outcomes, freeze the policy identity, manifest, required
protected cohorts, selection design and criteria. Supply complete development and
holdout review exports and their matching random sampling frames. Keep seven days
in each source period, a gap of at least 24 hours, immutable source revisions and
one pseudonymization key. Reconcile every selected frame revision, including
negative, uncertain and failed model outcomes. Shared authors or any transitive
campaign contact across the splits invalidate independence.

Human evidence uses two distinct blind reviewers and, on disagreement, a separate
adjudicator. Classification and expected disposition remain separate. The report
checks connected author/campaign units, per-cohort denominators, Wilson bounds,
source-bound results and exact own verified effect receipts. Missing labels,
frames, identities, attempts or receipts never become successful negatives.
Complete retained capture frames still cannot prove coverage of uncaptured ingress.

The proposed AI policy criteria are at most 0.1% upper 95% unsafe-permission rate
and at least 95% lower 95% offer eligibility recall, with explicit independent
sample and protected-cohort requirements. They are AI-specific evidence criteria;
deterministic or OCR approval cannot substitute for them. A passing report always
retains `promotionAuthorized=false`. Any policy change requires its own reviewed
gate and normal exact-SHA release.

## Offline routing comparison

```bash
npm run moderation:simulate-commercial-ai-routing --workspace @maxim/api -- \
  --input /absolute/private/scenario.json \
  --output /absolute/private/simulation.json
```

Use measured arrival, node-availability, duration and completion evidence. Keep the
current topology, three active and two pending source bounds, per-chat ownership,
three-second pending expiry, immediate consultation, original deadlines and
confirm-positive policy. Missing per-source outcomes for another node are unknown
counterfactuals; they cannot be invented as successful model responses. A timed-out
physical inference continues occupying its slot until completion or protected
recovery is proved. Throughput forecasts do not establish model accuracy or permit
raising concurrency, extending deadlines or bypassing 9B confirmation.

Commercial image analysis remains retired. OCR/VLM, QR, edits and voice/video need
their own full-source datasets, opt-in contracts, native resource budgets and
independent quality gates before enforcement can expand.
