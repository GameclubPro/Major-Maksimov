# Mini App Agent Notes

## Scope

- These instructions apply to the public React/Vite MAX mini app. Root workflow and contract rules still apply.
- Production is served under `/app/` by `miniapp-major-static` at `https://major-maksimov.ru/app/`.
- The MAX Bridge script is loaded from `https://st.max.ru/js/max-web-app.js`. Prefer shared wrappers over raw bridge calls.
- Routine work never deploys, publishes, or smokes CDN, Object Storage, app2, or the legacy support static service.

## Design Direction

- Before any UI/UX, layout, component or copy change, read the [active product decisions](../../docs/development/miniapp-product-decisions.md). A broad redesign request does not supersede earlier explicit decisions. Check added UI text against MINIAPP-COPY-01; preserve necessary actions, errors and accessibility labels.
- In both Major and Publik, keep the interface stylish, modern and free of text clutter. Use concise, natural language: no technical jargon, filler, AI-sounding boilerplate, redundant subtitles or explanations of obvious controls. Never add copy just to fill space or restore text removed during earlier UI work. Put useful optional explanations behind an info button (ⓘ), shown only on request; verify their accuracy against current behavior first. Delete unnecessary text instead of hiding it in help. Keep essential action/field labels, errors, consequences and accessibility labels available without opening help.
- The mini app must feel bold, stylish, modern, and visually memorable, with a clear wow effect. This is the default design target for future UI work, including moderation screens.
- Major headers use graphite with blue/indigo accents. Do not introduce lime accents; preserve Publisher's separate orange identity. Entity settings omit redundant settings subtitles and the duplicate inline Back in native MAX; keep save retry in the action row.
- Smartphone settings overview entries contain only an icon, the module name, and a navigation chevron. Never add descriptions, summaries, counters, ordinary on/off labels, or status dots to these entries, including hidden copies. Put details and states inside the opened module. This applies to Major chat/channel/network settings and Publik module menus. Follow the [settings overview design](../../docs/miniapp-settings-overview-design.md) before changing these surfaces.
- Build a recognizable visual identity through expressive typography, confident color accents, deliberate composition, refined icons and imagery, and polished interaction states. Use depth and purposeful motion where they strengthen the experience; respect reduced-motion preferences.
- Minimalism and muted utilitarian styling are not product goals. Existing flat surfaces, disabled shadows, and uniform radii are implementation choices, not requirements to preserve during redesign.
- Visual ambition must support clear priorities and fast everyday actions. Keep readable contrast, accessible touch targets, responsive layouts, and coherent light/dark themes; decoration must not obscure content or controls.
- Bundle budgets protect loading speed, not a minimalist aesthetic. Optimize assets and loading to deliver the intended design within the checked budgets; do not silently raise limits or remove visual quality to avoid optimization.
- Publisher uses an orange brand/action accent in both themes. Keep success, warning, and destructive states semantic; do not restore route-local green brand overrides.
- The runtime Manrope font is WOFF2; retain the source TTF and its full Cyrillic/variable-weight coverage. The distributed license is `public/licenses/manrope.txt`.

## Validation And Visual Work

- For miniapp-only runtime/UI changes, use the impact plan's repository static checks, `npm run check:miniapp`, `npm run build:miniapp:production`, and selected local visual smoke. `check:miniapp` already includes CSS ownership, type checking, and miniapp tests; do not rerun those subcommands after it passes.
- Run focused tests/browser cases for the changed behavior first, then the planned checks. Expand or repeat successful checks only for changed inputs, a failure, or an identified coverage gap. Material UI changes need visual review of the affected screens, not an unrelated whole-product audit.
- Do not add API/Prisma/admin suites or provision PostgreSQL/Redis for isolated miniapp UI changes. Expand validation when shared contracts, server code, root dependencies/build configuration, or concrete regression evidence crosses those boundaries; inspect changed callers and test doubles first.
- Agent notes and Markdown-only changes select `check:docs` and need no browser run or runtime deploy. Runtime releases still require the root exact-SHA CI gates; these local rules do not change which jobs the current CI requires.
- The Major image bakes `VITE_API_BASE=https://major-maksimov.ru/api/v1`; budget changes must also pass a build with that value.
- Emulator examples:
  - `npm run emulator:miniapp -- --device iphone`
  - `npm run emulator:miniapp:android`
  - `npm run emulator:miniapp -- --device iphone-se`
  - add `--theme dark` and `--route '<path>'` for the exact screen
- `npm run screenshots:miniapp` and `npm run audit:miniapp:visual` are local-first and start an owned server on an unused port. Explicit base URLs keep their port and fail if occupied; reuse requires `MINIAPP_SCREENSHOT_REUSE_SERVER=1` or `MINIAPP_VISUAL_AUDIT_REUSE_SERVER=1`. Only owned process groups are stopped.
- Vite dev resolves public contract exports to TypeScript sources, so concurrent contracts builds cannot remove its inputs; production builds still use package exports.
- Use `MINIAPP_SCREENSHOT_MODE=production npm run screenshots:miniapp` or `MINIAPP_VISUAL_AUDIT_MODE=production npm run audit:miniapp:visual` only for an explicit production-origin audit.
- Narrow screenshots with `MINIAPP_SCREENSHOT_SCENARIOS`, `MINIAPP_SCREENSHOT_DEVICE`, and an explicit base URL when necessary. Output lives under `artifacts/miniapp-screenshots/`.
- Native emulator/screenshots install the safe MAX Bridge shim by default. Use `--no-max-bridge` or `MINIAPP_SCREENSHOT_MAX_BRIDGE=0` only for a deliberate bridge-free check.
- Material UI work is not complete from code review alone. Check iPhone and Android sizes, light/dark, safe areas, scrolling, and keyboard overlap.
- `MINIAPP_SCREENSHOT_PRESET=moderation npm run screenshots:miniapp` covers the moderation profile's active screens, sheets, errors, and navigation with strict layout/contrast/accessibility checks. Override `MINIAPP_SCREENSHOT_DEVICE` and `MINIAPP_SCREENSHOT_COLOR_SCHEME` for the second device/theme.

## CSS And Layout

- `src/styles.css` is the only global CSS entrypoint. Its imports use `@import ... layer(...)`; CSS imported directly from TS/TSX must be fully wrapped in an explicit `@layer`.
- Run `npm run check:miniapp-css` after CSS ownership/import changes.
- Lazy-route CSS remains loaded for the SPA session. Scope route polish to route-specific body/root selectors and test both cold loads and cross-route navigation.
- `moderation-workspace.css` owns shared moderation presentation in the `workspace` layer after route CSS. Home-only presentation lives in the same layer in lazy `pages/chats-page-signal.css` so public cold launches do not load it. Scope every rule in these workspace layers to `body[data-miniapp-profile='moderation']`; Shell sets/clears that profile for portal sheets as well. Publisher styling must remain unchanged across profile navigation.
- Participant-card-only styles load lazily from `chat-participant-card.css` in that same scoped `workspace` layer. Keep them out of global startup CSS so opening unrelated public dialogs does not load moderation tools.
- Do not put global `touch-action` or root `overscroll-behavior-y` locks on `html`/`body`; MAX WebViews can stop page and nested-list scrolling. Put `pan-y` and momentum scrolling on the actual scroll container.
- Do not apply MAX `safeTop` or CSS safe-area values as a blanket content offset; some WebViews already account for system UI. Use `visualViewport` and real element measurements around floating controls.
- Keep stable dimensions and responsive constraints on boards, grids, controls, counters, and fixed-format UI. Text and controls must not overlap at supported mobile sizes.

## Android And Native Behavior

- Android MAX file pickers require a real transparent `<input type="file">` overlay on the tapped control. Hidden 1px inputs plus programmatic `click()`/`showPicker()` can fail.
- Keep the overlay in tab order with an accessible label and visible `:focus-within` state.
- `BroadcastContentComposer` file-input styles stay in its component CSS because `/publications` does not load legacy broadcast-studio styles.
- Read selected image blobs with `Blob.arrayBuffer()` first; retain `FileReader` only as a legacy fallback.
- Use shared `TimeField`, not native `<input type="time">`; Android MAX WebViews can hide native picker actions.
- Register overlay/sheet/editor close behavior through `src/lib/native-back.ts`.
- Mirror durable device-local state through `src/lib/native-storage.ts`.
- Use `src/lib/max-bridge.ts` for MAX links, share/download, haptics, ready, viewport, and BackButton.
- Use `window.WebApp.openMaxLink` only for `https://max.ru/...`; use `openLink` for external URLs.

## Routing And Trust

- Authentication relies on API-validated `initData`/`WebAppData`; `initDataUnsafe` is presentation convenience only.
- A late MAX Bridge `initData` value must replace URL-fallback startup state. Keep Bridge discovery bounded and event-assisted, and use cryptographic/session helpers rather than `Math.random` for boot trace identifiers.
- Rich-text editor and clipboard links must use the shared `max-rich-text-link` parser. Accept credential-free HTTPS and exact `max://user/<id>` links only; never assign pasted or typed href text directly to editor HTML.
- Home launch context does not identify a target managed chat/channel. Discovery comes from server allowlist, access edges, published snapshots, and recent signals.
- Public legal routes `/app/legal/agreement` and `/app/legal/privacy`, including prefixed standalone paths, render without init data and remain before the startup auth gate.
- Public comment and suggestion routes opened by bot buttons close the mini app on native BackButton instead of navigating home.
- Parse start/startapp payloads through `src/lib/launch-route.ts`; do not build custom payload grammars.
- For bot buttons opening internal screens, prefer bot-scoped `https://max.ru/<bot>?startapp=...` links; direct `open_app`/`webApp` launch is fallback only.
- Do not expose internal primary, standby, or execution-owner details. Use `sanitizePublicManagedEntityHeader`; public headers preserve only counters/flags such as `botCount` and `hasSharedAutomation`.

## Publications And Settings

- `/publications` is Publisher-only. Major `/publications`, `/autoposts`, and retired publishing settings links render only `PublikHandoff`; they must never mount a publishing editor or fetch legacy publishing data.
- The Publisher profile home is its own `/` cabinet with `Чаты`, `Каналы`, and `Посты` navigation. Its entity catalog comes from exact Publik connections, never from the Major catalog.
- Major home uses `PublikHandoff`; its final navigation item opens the Publik bot through `publik-bot.ts` and the MAX Bridge. When server-confirmed networks access is enabled, Major navigation is Chats / Channels / Networks / Publik; Publisher retains its three items. Major settings contain no Publik policy or publishing controls. The compact `PublisherPolicyCard` belongs to Publik entity modules and uses their switch styles; disabled connections stay visible in that cabinet so their owners can re-enable them without Major.
- Publik entity module screens own chat comments, channel comments, channel suggestions, and VK import. Major keeps its independent channel comments. VK transport uses only `/publisher/entities/:entityType/:entityId/vk-parsing`; Major routes, deep links, settings state, API clients, search aliases, and CSS must not contain VK parsing controls or compatibility paths.
- Never restore Major publishing from `workspace=autoposts`, `legacyKind`/`legacyId`, `focus=broadcast`, or a private-bot handoff. `MajorSettingsRoute` intercepts those links before the settings page mounts.
- Publication search, entity/status filters, and schedules are server-side and cursor-bound; never fetch every page for client filtering.
- Rows with `publicationOccurrenceId != null` are Publication envelopes and must stay hidden from legacy broadcast/autopost APIs and UI.
- Channel publication buttons are derived directly from `commentsEnabled` and `postSuggestionsEnabled`; do not add a separate button-mode control or preview filter.
- Settings section apply defaults to the current chat. Applying all requires explicit `mode: 'all'`; keep contract, UI default, and preview transport aligned.
- Required-subscription controls preserve saved unknown sources and external-link fallback. Validate new selections without deleting existing ones on lookup failure.
- Stop-word UI owns both blocked words and blocked domains. Domain entry defaults to `DOMAIN`, not an accidental exact root URL.
- Stop-word edits use the revision-checked `/chats/:chatId/stop-words` API. Keep words/phrases atomic during bulk input, preserve unsaved buffers on failed saves, and poll only `/stop-words/status` for lightweight OCR availability. Legacy settings writes must not overwrite the independent policy.
- Keep `VkParsingCard` lazy-loaded in Publisher entity modules; do not restore it to Major settings routes.
- Publication video selection uploads up to 100 MB directly to the MAX-issued HTTPS address. Keep progress, cancellation, persistent errors, generic native MIME inference, and actor-owned asset references; never encode the selected file as base64 or send it through the API mutation tunnel. `node apps/miniapp/test/publication-video-picker.browser.mjs` checks the local upload UI after builds finish.

## Performance And Product Presentation

- Home statistics prefetch imports stay lazy; statically importing events/stats clients into `chats-page.tsx` spends startup budget.
- Stats API clients should import contracts as types where possible, and stats routes use focused CSS instead of `lazy-pages.css`.
- Channel audience charts use joined/left net growth from `series.membership`; `series.participants` is total-audience context. Prefer observed `viewsDelta`, with total views only as fallback.
- Statistics screens stay factual: metrics, freshness, coverage, charts, top posts, and publishing windows. Do not add pseudo-AI advice or coaching copy.
- Managed poll lists render persisted `imageCount`; raw poll images belong to details only.
- Home readiness is user-scoped and separate from global discovery completion. Managed entities are unique per chat/channel, not repeated per bot.
- Home loads saved navigation without per-chat authorization polling. Idle prefetch may load code, never protected settings for unopened entities. Navigate to settings immediately; cached settings may render while the selected entity is revalidated, with controls disabled until that check completes. Cached UI is never server mutation authority.
