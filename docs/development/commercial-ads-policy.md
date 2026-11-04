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

Deterministic category evidence reuses the commercial detector's subtypes and safe context.
The pinned `commercial-categories-v2` AI prompt reports `SERVICE_OFFER`, `BUSINESS_OFFER`
and `COMMERCIAL_COMMUNITY` directly. Mixed offers retain every reported category;
incidental delivery, material or contact language does not add another category.
Generic historical commercial reasons remain readable but supply no explicit-policy
category authority. Existing buyer, quoted-discussion and private-sale protection stays
in the resolver. Unknown categories stay unresolved. Model weights, budgets and the
4B confirmation policy are unchanged; prompt identity advances and old observations
cannot authorize current effects. Source version 3 binds explicit category
policy and personal-sale blocking while retaining v1/v2 readers. A confirmed personal
sale requires the pinned server confirmation before deletion. A new personal-sale BLOCK
cannot be enabled while that runtime is unavailable; existing stored policy stays intact
and processing fails conservatively. Preview returns UNSURE for an unsupported deterministic
personal-sale block, never a false promise of deletion.

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
- Mobile: `apps/miniapp/test/commercial-ads-policy.test.ts` and
  `node apps/miniapp/test/settings-commercial.browser.mjs` cover draft/save/discard,
  exceptions, preview, journal, widths 320–430, light/dark and keyboard/short viewports.
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
