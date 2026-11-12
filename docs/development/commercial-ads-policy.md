# Commercial advertising policy

The approved interface is recorded in
[MINIAPP-COMMERCIAL-01](miniapp-product-decisions.md#miniapp-commercial-01-категории-исключения-и-проверка-без-лишнего-текста).
The existing master toggle owns opt-in. There is no new mode selector or example copy.

## Stored policy and deletion authority

`ChatSettings.commercialAdsPolicy` is nullable JSON. Null or an absent legacy field
retains existing behavior and its exact old settings fingerprint. Opening the screen
must not materialize policy. Explicit version 1 contains all four ALLOW/BLOCK categories
and bounded participant grants. Invalid policy or unknown category evidence prevents
commercial deletion. Read repair of unrelated settings preserves the stored policy.
Omitted fields in older writes preserve it; explicit null clears it.

Each grant names one canonical user, nonempty categories and an optional exact expiry.
All blocked categories need an active matching grant. Grants never waive other moderation
rules, immunity, source identity or deadlines. Bulk category application preserves each
recipient chat's own grants; it cannot copy another chat's participant permissions.
Settings revision checks serialize concurrent writes.

Deterministic category evidence requires a real commercial detector result and preserves its
safe context. A separate bounded resolver inspects every unprotected offer block; ranked
subtypes alone do not provide the full category inventory. It excludes incidental fulfillment
and material/brand mentions, retains independently offered work and commercial community
invitations without requiring a link, and refuses incomplete original-text inspection.
The pinned `commercial-categories-v2` AI prompt reports `SERVICE_OFFER`, `BUSINESS_OFFER`
and `COMMERCIAL_COMMUNITY` directly. Mixed offers retain every reported category;
incidental delivery, material or contact language does not add another category.
Generic historical commercial reasons remain readable but supply no explicit-policy
category authority. Existing buyer, quoted-discussion and private-sale protection stays
in the resolver. Unknown categories stay unresolved. Model weights and budgets are
unchanged, and the legacy confirmation policy remains supported; prompt identity advances and old observations
cannot authorize current effects. The owner's 2026-11-07 pool decision selects
available 9B before direct 4B overflow, without follow-up model calls for 4B answers;
see the [pool scheduling contract](../operations/runbooks/commercial-ai-pool.md#scheduling-and-failure-boundaries).
Source version 3 binds explicit category
policy and personal-sale blocking while retaining v1/v2 readers. A confirmed personal
sale requires a pinned 9B result before deletion, including when 4B overflow makes
no follow-up request. A new personal-sale BLOCK
cannot be enabled while that runtime is unavailable; existing stored policy stays intact
and processing fails conservatively. Preview returns UNSURE for an unsupported deterministic
personal-sale block, never a false promise of deletion.

Quoted offers introduced as reported speech and followed by an explicit scam warning
remain protected. Protection ends at the closed quote; an independent offer in the
author’s own later text still participates in category detection. Default-ignorable
format characters inside words (including soft hyphen and invisible operators) are
removed only from the detection representation. Original text, regional letters,
combining marks and source fingerprints remain intact.

Both deterministic and AI final dispatch guards re-read current settings, category policy,
exact participant grants and expiry. Any relevant settings change revokes earlier bound
authority. All shared-image roles and both rollback paths must retain the policy resolver,
policy settings selection/fingerprint, v3 source reader and final checks, even with a feature
disabled. The additive nullable database column remains through rollback.

## Preview and journal

Preview authorizes the exact chat, validates bounded draft text and applies an actor quota.
It uses actual classification and current draft settings. AI preview uses immediate shared
server admission and yields to moderation work; pressure/unavailability is a distinct result.
It creates no deletion, strike, reputation change, durable enforcement source or text log.
Preview uses the same semantic categories and actor grants as enforcement. `UNSURE`
is displayed as «Недостаточно данных» with a warning icon, independently from `KEEP`;
mixed-category explanations never imply that every category is blocked.
Completed results scroll into view above the action footer on small phones.

The optional `classification` request field carries the complete unsaved sensitivity and both
thresholds, with the same valid ranges and strict delete-above-warn relation. Older clients that
omit it retain saved classification settings. Changing any draft classification field invalidates
the displayed preview and participates in its unsaved-settings notice.
Request validation and preview explanations have focused modules so ordinary settings and
network recovery do not load preview-only code. Existing production route budgets remain binding.

AI preview uses one expiring Redis diagnostic request, separate from enforcement sources and
proofs. Only the current `api-moderation-background` worker may claim it and reach the private
CPU model network; `api-admin` never starts model HTTP or owns a physical CPU lease. Submit,
claim and pre-dispatch checks yield to pending/live moderation in both admission namespaces.
An unavailable worker, busy CPU, pressure or expired original twenty-second deadline produces
`UNAVAILABLE`. The actual CPU handoff also requires six seconds remaining. A preview failure
cannot interrupt enforcement polling; shutdown withdraws readiness and drains actual inference.
After HTTP dispatch, diagnostic expiry revokes only the preview result. The worker continues
reading the bounded terminal response under the existing sixty-second model-client limit, even
if the caller has already received `UNAVAILABLE`. A validated late completion releases only its
own physical CPU token and never publishes the expired result. A slow cold prompt can exceed
the preview deadline; it must not quarantine the model merely because the caller stopped waiting.
Cancelling or expiring the diagnostic request never releases an uncertain physical CPU lease;
only its scheduler or the named guarded recovery procedure may settle that lease.

COMMERCIAL journal filtering happens before pagination using bounded indexed heads for
`COMMERCIAL_AD` and `COMMERCIAL_LLM_DELETE`. New cursors bind chat, period and filter.
Feedback validates an exact feed row and records an idempotent actor/chat/event audit report.
It is not ground truth or a training label. Per-actor acknowledgement is attached after
the shared page cache. Creating an exception still requires explicit draft saving.

## Mobile loading budgets

The category controls stay in the main commercial editor. Exact-chat tools, exception
forms, preview and participant search load separately; network settings do not load the
chat-only tools. Their CSS follows the same boundaries. The exception and preview budgets
include their tools and author picker, so completing either flow remains measured.

Production builds with the canonical `VITE_API_BASE` reduced the commercial editor from
10.2 to 3.2 KiB JavaScript and from 3.7 to 2.4 KiB CSS gzip after this split. The complete
network editing chain still includes the new category controls and shared policy validation:
226,432 bytes JavaScript and 103,220 bytes CSS in the first split build, before dead-style
cleanup. Its ceilings increase by exactly 1 KiB each to 226,816 and 103,424 bytes; other
existing ceilings stay unchanged. The four additional commercial budgets bound the lazy
tools, complete exception flow, complete preview flow and search separately. This is a
bounded cost for the approved policy feature after removing unrelated initial loading.

## Focused verification

- Contracts: `packages/contracts/test/commercial-policy.test.ts` and
  `commercial-ai-quality-contracts.spec.ts` retain legacy and v3 compatibility.
- API: `commercial-ads-runtime-policy.service.spec.ts`, `commercial-ads-preview.service.spec.ts`,
  `admin-commercial-ads.service.spec.ts` and `admin-logs-dashboard-runtime.spec.ts` cover
  categories, grants, preview admission, access and actor-isolated feedback.
- Native: `admin-commercial-ads-postgres.spec.ts` and
  `commercial-llm-delete-guard-postgres.spec.ts` cover persistence, CAS, bounded history,
  feedback idempotency and fresh deletion guards through the test-store wrapper.
- Native Redis: `commercial-llm-preview.redis-integration.spec.ts` covers bounded diagnostic
  handoff, priority, exact ownership, cancellation and the pre-dispatch CPU budget;
  `commercial-llm-cpu-lease.redis-integration.spec.ts` preserves uncertain HTTP fencing.
- Mobile: `apps/miniapp/test/commercial-ads-policy.test.ts` and
  `node apps/miniapp/test/settings-commercial.browser.mjs` cover draft/save/discard,
  exceptions, preview, journal, widths 320–430, light/dark and keyboard/short viewports.
  `node apps/miniapp/test/commercial-preview-draft.browser.mjs` additionally checks complete
  draft-profile transport, result invalidation and superseded asynchronous responses.
- Rollback: `infra/scripts/commercial-text-deploy-guards.test.mjs` refuses sources missing
  the policy and v3 readers. Browser evidence does not prove behavior in a physical MAX client.

## AI worker compatibility

The request contains the complete server-owned prompt and JSON grammar. The reviewed
previous Windows worker generation forwards that request without rewriting either.
Bridge hello accepts only the exact current profile or its one frozen previous prompt
hash, with the same model, template, runtime, support and protocol fields. It echoes
the accepted wire identity; internal mailbox identity and results use the current
prompt. Strict result/source checks do not use this hello compatibility path.
This lets already-installed 4B and 9B workers serve the new prompt after reconnecting
without changing model processes or replaying requests. Native bridge tests prove the
old hello/current request boundary. Closed CPU smoke checks the exact service and
personal-sale reason, not just the coarse classification; it is diagnostic evidence,
not a model accuracy certificate.
