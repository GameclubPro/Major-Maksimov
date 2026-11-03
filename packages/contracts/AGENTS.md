# Contracts Agent Notes

## Scope

- `packages/contracts` is the shared Zod/type boundary consumed by API, public mini app, and Safety Desk.
- A contract change normally requires matching consumer implementation, tests, typechecks, and deployment of every affected runtime component.
- Keep package subpath exports, root `tsconfig.base.json` paths, and `apps/api/jest.config.cjs` mappers synchronized.
- API Jest intentionally resolves ESM contract source through its mapper; do not point tests at stale generated JS.

## Structure And Validation

- Export reusable schemas/types from focused source modules and add an explicit `package.json` subpath when consumers import that module directly.
- Do not commit generated JS beside `src`; build output belongs only in ignored `dist/`.
- The public build script serializes and cleans `dist`, then verifies exports. Do not bypass it with `build:source` while another contracts/API validation is running.
- Run affected files through the [focused runner](../../docs/development/agent-machine-contract.md#focused-checks-before-submission),
  then let the staged commit helper own planned contracts and consumer aggregates.
  `check:contracts` includes typecheck and tests; `test:contracts` already owns its build.
  Do not repeat those subchecks or add unrelated consumers for Markdown-only changes.
- Contract tests live in `packages/contracts/test` and run with Vitest. Keep pure schema/mapping tests here instead of making API Jest own contract-only behavior.

## Compatibility

- Defaults and coercion are API behavior. Changing them requires explicit regression tests and matching UI/server assumptions.
- Preserve fail-safe settings defaults. In particular, `applySettingsTargetSchema`, mini app defaults, and preview transport default section apply to `current`; applying all chats requires explicit `mode: 'all'`.
- Keep response schemas aligned with server redaction: public managed-entity contracts must not expose primary/standby/execution-owner internals.
- Prefer type-only contract imports in performance-sensitive mini app clients when runtime validation is not needed.
