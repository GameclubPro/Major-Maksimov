# MAXIM Reliability Refactor Plan, June 2026 Refresh

This is the historical June planning snapshot. Some implementation and dependency
statuses below are superseded; for the source audit and prioritized next steps use the
[1 November 2026 roadmap](operations/plans/2026-11-01-safe-refactoring-roadmap.md).
Applicable safety boundaries remain binding: preserve public behavior, keep runtime
deploys small, and make each extraction reviewable through focused tests.

## Non-Negotiable Boundaries

- Do not expand the allowed direct `*.legacy` import set. Public facade files remain
  the only temporary legacy import boundary.
- Runtime entrypoints stay behind focused services:
  `WebhookIngestionService`, `ModerationExecutionService`,
  `MaxActionDispatchService`, and `ManagedEntitiesDiscoveryService`.
- New runtime/admin hot-path code should route through focused services before
  touching legacy implementations.
- Do not grow `packages/contracts/src/core.ts`; add or use subpath exports for
  new domains and keep package exports, root TS paths, and API Jest mappers aligned.
- Routine mini app deploy and smoke target is only
  `https://major-maksimov.ru/app/`. Do not publish or smoke CDN/app2/Object Storage
  unless CDN/restricted-LTE work is explicitly resumed.
- Routine mini app visual tooling should also stay Major-only by default. CDN/app2
  URLs require an explicit override tied to resumed CDN/restricted-LTE work.
- For API validation, do not run Prisma-generating API Jest/typecheck commands in
  parallel.

## Current Fitness Gates

- Boundary guard: `npm run check:refactor-guards`.
- API focused gates:
  - `npm test --workspace @maxim/api -- moderation.admin-access.spec.ts moderation.shared-chat.spec.ts`
  - `npm test --workspace @maxim/api -- night-mode-transition`
  - `npm test --workspace @maxim/api -- moderation.service.spec.ts manual-moderation.service.spec.ts`
  - `npm test --workspace @maxim/api -- private-control.service.spec.ts channel-dialog.service.spec.ts managed-giveaway.service.spec.ts`
- Mini app focused gates:
  - `npm run check:miniapp-css`
  - `npm run typecheck --workspace @maxim/miniapp`
  - `npm run build --workspace @maxim/miniapp`
- Contracts gates:
  - `npm run typecheck:contracts`
  - `npm test --workspace @maxim/api -- contracts`
- Broad/risky runtime slices finish with `npm run check` before push/deploy.

## Current Hotspots

- API: `apps/api/src/admin/admin.service.legacy.ts` remains the large admin
  implementation behind the `AdminService` facade. New admin entrypoints should
  prefer focused services such as `ManagedEntitiesService`, `AdminSettingsService`,
  `ManagedBroadcastService`, `ManualModerationService`, `ChannelDialogService`,
  and `ManagedGiveawayService`.
- API: `apps/api/src/moderation/moderation.service.legacy.ts` remains the large
  moderation implementation behind the `ModerationService` facade. Webhook,
  queue, action, and discovery entrypoints must not call it directly.
- API: `apps/api/src/moderation/private-control.service.legacy.ts` remains the
  large private-control implementation behind the `PrivateControlService` facade.
- API: `apps/api/src/moderation/rule-engine.service.ts` is the rule facade and
  detector host; `detect()` remains the behavioral boundary while detectors are
  extracted.
- Mini app: `apps/miniapp/src/pages/settings-page.legacy.tsx` remains the largest
  settings route implementation behind the settings page facade.
- Contracts: `packages/contracts/src/core.ts` remains large but should not grow.

## Completed Refactor Slices

- Rule-engine extraction has already split detection context, hot-path profiling,
  message/media limits, commercial detection, normalization, topic filters,
  duplicate state, and related specs into focused modules.
- Moderation access/read-bot slice is extracted for the moderation hot path:
  `moderation-access.service.ts` owns chat-admin access checks, remote lookup
  batching/cache/backoff, and transient MAX lookup handling, with legacy wrappers
  delegating into it.
- Bot routing helpers have started and now cover the main non-I/O selection
  seams:
  `moderation-bot-routing.util.ts` centralizes read, moderation-action, and
  auto-attach/night-mode transition bot route selection helpers used by the
  legacy facade.
- Night-mode transition execution is extracted:
  `night-mode-transition-runtime.service.ts` owns transition execution logic while
  `ModerationExecutionService` remains the public queue/runtime entrypoint.
  `night-mode-transition-notice.util.ts` owns pure close/open notice rendering
  and self-notice matching. `night-mode-transition-delivery.service.ts` owns
  schedule notice send/delete flow and terminal MAX access-loss handling.
  `night-mode-transition-closed-notice-options.util.ts` owns comments/base-button
  options composition for close notices. `BotSpeechMediaService` owns shared
  bot-speech media resolution/upload/option merging for night-mode and other
  moderation notices. `NightModeTransitionEventService` owns close/open
  transition moderation-event creation and metadata. Legacy still owns the
  incoming message delete gates for active night-mode/manual-force-close checks.
- Manual/admin command bridge has started:
  forwarded admin-command parsing is isolated in `admin-forwarded-command.util.ts`,
  and `ModerationService` prefers `ManualModerationService` for group/manual admin
  command execution.
- Moderation/AdminService bridge cleanup is complete for the moderation hot path:
  channel-suggestion payload parse/build moved behind `AdminDialogLinkService`,
  `ModerationService` no longer injects `AdminService`, and
  `manualModerationCommandBridge` no longer falls back to `AdminService`.
- Private control extraction has started:
  shared private-control types/constants and `PrivateControlSessionStore` are
  separated from `private-control.service.legacy.ts`.
  `private-control-session-normalizer.ts` owns session creation, persisted
  session normalization, pending input/mass-action parsing, and private-control
  screen/entity/view parsers. `private-control-draft-normalizer.ts` owns pure
  broadcast/suggestion draft normalization, broadcast target-state resolution,
  broadcast draft cloning, and suggestion draft object normalization.
  `private-control-media-attachments.ts` owns private bot attachment extraction,
  image/video download, media MIME/filename normalization, and suggestion media
  upload draft construction.
  Private forwarded-command parsing/extraction now lives in
  `admin-forwarded-command.util.ts` private wrappers/options, while action
  handlers remain in legacy behind `ManualModerationService`.
  Private-control manual moderation/rules command calls now route through
  `ManualModerationService` instead of direct `AdminService` calls.
  `private-control-duplicate-flow.ts` owns duplicate-flow allowed-count/window
  normalization and threshold rebuild helpers used by legacy settings rendering
  and updates.
  `private-control-settings-schema.ts` owns private-control settings labels,
  field configs, section order, card groups, and bulk-apply setting key groups.
- Settings page extraction has started:
  comments and extra sections are delegated to focused components while keeping
  route-owned state and lazy boundaries intact.

## Next Optimized Plan

1. Freeze the completed moderation hot-path seams.
   Treat moderation access/read-bot and night-mode transition extraction as
   protected boundaries, not the next broad work item. `ModerationAccessService`
   owns access lookup/cache/backoff, `moderation-bot-routing.util.ts` owns read,
   action, auto-attach, and night-mode route selection, and `ModerationService`
   no longer injects `AdminService`. Residual work in moderation should be either
   regression guards, thin-wrapper deletion, or a complete service extraction.
   Do not pull destructive roster refresh scheduling or moderation-action
   fallback/backoff snapshot state apart until a full runtime service seam exists.
   Validate with:
   `npm test --workspace @maxim/api -- moderation-bot-routing.util.spec.ts moderation.admin-access.spec.ts moderation.shared-chat.spec.ts moderation.service.spec.ts`
   and `npm run typecheck --workspace @maxim/api`.

2. Make `PrivateControlService` settings schema/rendering the primary backend
   slice. `private-control.service.legacy.ts` is exactly at its guard cap, so the
   next extraction should reduce it materially without touching callback routing.
   Keep `PrivateControlService` as the only public facade and do not import
   `private-control.service.legacy.ts` from new code.
   A. Extract deterministic settings render/search helpers such as
   `findSettingMatches`, `buildFieldAliases`, `buildSectionFieldConfigs`,
   `buildSectionSummaryLines`, `buildSectionActionRows`,
   `buildChannelSectionSummary`, `buildChannelSectionRows`,
   `describeLinkPolicy`, `describeBooleanCompact`, `formatNumberPreset`, and
   `resolveSectionViewForField` into `private-control-settings-renderer.ts`.
   B. Leave `processCallback`, pending-input orchestration, `respond`, context
   parsing, and data-fetching rules/broadcast/giveaway/events/logs screens in
   legacy until the pure settings renderer is covered by focused tests.
   Preserve `SECTION_SETTING_KEYS` behavior because it controls bulk
   `applySettingsToAllChats` semantics.
   Validate with:
   `npm test --workspace @maxim/api -- private-control-duplicate-flow.spec.ts private-control-settings-renderer.spec.ts private-control.service.spec.ts`,
   then `npm run typecheck --workspace @maxim/api`, then
   `npm run check:refactor-guards`. After each reduction, set the
   `private-control.service.legacy.ts` guard cap to the new exact line count.

3. Only after the private-control settings cut, take the residual night-mode
   delete-gate slice if it still pays for itself. The focused target is
   `handleNightModeMessage`, `handleNightModeForceCloseMessage`,
   `isNightModeActiveNow`, and `isNightModeForceCloseActiveNow` in a small
   runtime service that keeps `ModerationExecutionService` as the public
   queue/runtime entrypoint. Keep terminal MAX 403/404 access-loss handling in
   the existing night-mode delivery/runtime services.
   Validate with:
   `npm test --workspace @maxim/api -- night-mode-transition moderation.service.spec.ts`
   and `npm run typecheck --workspace @maxim/api`.

4. Keep manual/admin command bridging contained behind existing facades.
   The moderation hot path is no longer directly coupled to `AdminService`, but
   `ManualModerationService` is still partly a bridge over legacy admin methods.
   Future manual-command work should split silence/open-chat, fanout,
   developer super-ban, domain allowlist, and private-control admin callbacks
   behind `ManualModerationService` or narrower focused helpers. Do not add new
   direct `AdminService` dependencies in runtime/private-control code.
   Validate with:
   `npm test --workspace @maxim/api -- moderation.service.spec.ts manual-moderation.service.spec.ts admin-dialog-link.service.spec.ts`.

5. Continue mini app settings extraction as second priority.
   `SettingsExtraSection` and `SettingsCommentsSection` are extracted. Next split
   required subscription in two stages: presentational blocks first, controller
   hook second. After that, consider lazy `rules` and `broadcast` workspaces,
   reusing channel-settings boundaries where they already exist. Keep
   `VkParsingCard`, required-subscription picker, broadcast composer, stats/events
   clients, and route CSS lazy boundaries intact. Material UI checks should use
   local screenshots or Major production-origin screenshots only.
   Validate with:
   `npm run check:miniapp-css`,
   `npm run typecheck --workspace @maxim/miniapp`,
   and `npm run build --workspace @maxim/miniapp`.

6. Keep contracts extraction subpath-based and source-runtime safe.
   If a domain needs new shared contracts, create/update a subpath export and
   synchronize package exports, root TS paths, API Jest mappers, API, mini app,
   tests, and typechecks in the same slice. Do not use `core.ts` as a catch-all.
   Audit tracked `packages/contracts/src/*.js` shims before moving runtime values:
   stale JS beside TS sources can mislead source-runtime imports even when TS/Jest
   resolution is correct.
   Validate with:
   `npm run typecheck:contracts` and API contract specs before broader checks.

## Deployment Rule

- Docs, tests, and refactor-plan updates do not require VPS deploy.
- Runtime-affecting changes in API, mini app, contracts, Prisma, Docker, or MAX
  integration should finish with local validation and a VPS deploy unless the user
  explicitly says not to deploy.
- For shared API code changes, recreate every API role that uses the shared image.
- For routine mini app production checks while Major is primary, deploy/smoke
  `miniapp-major-static` and `https://major-maksimov.ru/app/` only.

## Golden Flows

- MAX webhook ingestion: signature/header validation, queue routing, outbox
  repair, and duplicate handling.
- Moderation hot path: admin/bot bypass, rule detection, sanction/action fallback,
  timeout profile, and shared-chat execution guard.
- MAX API reliability: per-bot/service-class/per-chat rate limits, circuit/backoff behavior,
  membership lookup, media upload, and action dispatch.
- Managed entities home: fresh access edges, published snapshots/diffs, recent
  `bot_added` bootstrap, refresh/backoff state, favorites.
- Broadcasts: compose, schedule/calendar conflict detection, target audience,
  test delivery, retry/cancel/recovery.
- Giveaways: draft, publish, eligibility checks, draw, claim, reroll, delivery,
  cancellation.
- Mini app launch/deep links: `startapp` route parsing, MAX bridge init data
  refresh, bot handoff links, prefixed app deployments.

## Modernization Backlog

- Keep Node 24 as the baseline.
- Patch/minor dependency updates can proceed inside current majors after fitness
  gates pass.
- Prisma audit debt: `npm audit --omit=dev` currently reports
  `GHSA-92pp-h63x-v22m` through Prisma's `@prisma/dev -> @hono/node-server`
  chain. Do not run `npm audit fix --force` for it, because npm proposes
  installing Prisma 6.19.3. Track this until a Prisma 7-compatible patch resolves
  the transitive advisory.
- Jest 30 is complete; keep it behind the API test gate when touching test
  runtime.
- Vite 8 is complete; keep it behind the mini app typecheck, test, build, and
  bundle-budget gates.
- Zod 4 is complete; keep contract changes behind contracts, API, and mini app
  gates.
- Prisma 7 remains a separate upgrade track after decomposition.
- React Compiler and Nest SWC are opt-in experiments after component and service
  boundaries are stable.
