# Safety Desk Agent Notes

## Scope And Boundary

- `apps/admin` is the closed owner-side React/Vite Safety Desk, not a MAX mini app. Do not add MAX Bridge or init-data assumptions.
- Production is `https://admin.major-maksimov.ru/`, protected by nginx Basic Auth and served by `admin-static` on `127.0.0.1:3004`.
- Browser API calls are same-origin `/api/v1/...`; admin nginx proxies them to `api-admin`.
- API guards require the admin forwarded host plus Basic Auth `X-Remote-User`. Public nginx sites must deny `/api/v1/safety-desk` and `/api/v1/support-requests` before their generic `/api/v1/` proxies.
- Basic Auth is the owner login; do not add another access-code prompt. Preserve the server host/user and origin checks. See the [owner access decision](../../docs/project-description.md#7-safety-desk).
- Never read or print the Basic Auth password during ordinary UI work. Retrieve credentials only for an explicit owner request, into a private file outside Git.

## Workflow

- Inspect changed callers and run the affected focused cases first. The impact planner and
  staged commit helper select `check:admin`, which includes admin tests, build and browser smoke.
  Do not pre-run the same aggregate or repeat its included subchecks. Markdown-only work needs
  `check:docs`, with no browser setup or runtime deploy.
- UI-only changes deploy `admin-static`.
- Shared contracts or API authentication/authorization changes also validate and deploy every shared API role.
- Changes to `infra/nginx/admin.major-maksimov.ru.conf` are separate infrastructure work; follow `infra/AGENTS.md` and apply the site with the repo script only after nginx review.

## Product Rules

- Keep Safety Desk operational, compact, and scan-oriented. It is a review/action tool, not a marketing surface.
- Moderation, support, delete-intent, giveaway-notification, and audit data remain server-authoritative; never infer permissions or final action state only in the client.
- Keep review lists lightweight and load profiles, observations, or diagnostics on demand.
- Preserve explicit loading, empty, denied, conflict, retry, and terminal states for every owner action.
- Do not expose access codes, bot tokens, webhook secrets, raw authorization headers, or internal credentials in client errors or downloaded diagnostics.
