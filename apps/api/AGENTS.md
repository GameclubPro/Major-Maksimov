# API Agent Notes

Root workflow and delivery rules apply. This file is the entry point; read the relevant sections
of the [API domain reference](../../docs/development/api-domain-reference.md) before changing their
code. Its detailed guards remain mandatory. Do not load unrelated domain sections.

## Select The Relevant Reference

| Work                                                        | Read before editing                                                                                                                                                                         |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime roles, governors, native media, queue lifecycle     | [Architecture](../../docs/development/api-domain-reference.md#scope-and-architecture)                                                                                                       |
| Prisma, SQL, races, durable handoffs                        | [Validation and Prisma](../../docs/development/api-domain-reference.md#validation-and-prisma) and [latency regressions](../../docs/operations/runbooks/webhook-latency-prevention.md)       |
| MAX requests, quotas, access, webhooks, deadlines, deletion | [MAX transport](../../docs/development/api-domain-reference.md#max-transport) and [webhook safety](../../docs/development/api-domain-reference.md#webhooks-and-deletion-safety)             |
| Entities, bot selection, activation, home metadata          | [Managed entities](../../docs/development/api-domain-reference.md#managed-entities-and-multi-bot) and [home presentation](../../docs/development/api-domain-reference.md#home-presentation) |
| Publications, outbound effects, VK                          | [Publishing](../../docs/development/api-domain-reference.md#publishing-and-outbound-actions) and [VK](../../docs/development/api-domain-reference.md#vk-parsing)                            |
| Moderation, duplicate/OCR rules, retention, statistics      | [Moderation](../../docs/development/api-domain-reference.md#moderation-and-read-models)                                                                                                     |
| Markup, forwarding, attachments, links                      | [Message semantics](../../docs/development/api-domain-reference.md#message-and-link-semantics)                                                                                              |
| Advertising buttons, Birzhik profiles, Karavan shops        | [Marketplace contract](../../docs/development/marketplace-integration.md) and [chat shops](../../docs/operations/runbooks/karavan-chat-marketplaces.md)                                     |
| Operational script or production audit                      | [Bounded commands](../../docs/development/api-domain-reference.md#bounded-operational-commands) and [infra notes](../../infra/AGENTS.md)                                                    |

## Core Boundaries

- NestJS/Fastify, Prisma/Postgres and BullMQ/Redis share one runtime image. Keep typed
  `APP_ROLE`/`APP_SERVICE_NAME`, Compose and deploy topology aligned. Ingress owns webhooks,
  admin owns HTTP user APIs, queue roles own their designated work.
- Hot paths use `WebhookIngestionService`, `ModerationExecutionService`, `MaxActionDispatchService`
  and `ManagedEntitiesDiscoveryService`. Admin entry points use the focused public facades.
  Do not grow legacy implementations or import them outside their thin facades.
- Fresh authorization is exact-bot, exact-entity and exact-actor. Explicit denial/removal persists;
  passive refresh, TTL expiry and transient 403/404/429/timeout must not manufacture activation
  or erase proven grants. Check entity-sensitive capabilities at final dispatch.
- One semantic EXECUTION authority owns an event's effects. Preserve original source deadlines,
  final leases, command authority, held sources and unknown-effect evidence. A started whole
  handler never replays; separately fenced action/delete/media journals own continuation.
- Slow or quarantined work must preserve independent-chat progress. Ordered expiry/parking is
  not successful moderation. Never loosen holds or replay an uncertain predecessor to serve Start.
  Handshake changes need fresh exact rights, durable roster acknowledgement and full-path tests.
- Canonical webhook dedupe is bot-scoped; logical effects dedupe separately. Publisher observations
  never acquire Major execution authority. `Update.timestamp` is event/edit time; message time is
  original creation time. Fresh edits/removals revoke the corresponding retained authority.
- Moderation-critical cleanup uses durable DELETE intents. Only a documented success or exact
  message-absence proof establishes deletion; a generic 404 does not. Retain retry deadlines,
  policy, immunity and executor guards at the actual effect.
- Preserve the working moderator at rollout; do not invent assignments from membership alone.
  Fixed moderator and explicit activation changes require compatible readers across every API
  role and both rollback paths. Read the domain references before touching their switches.
- Publication, delivery, VK, binding and user authorization are Publisher-owned. Do not create
  Major memberships from Publisher activation or route Publisher work through Major workers.
- OCR and photo decoding run only in their isolated native auxiliaries with their existing
  concurrency/resource/deadline/teardown limits. A required timeout recycle is containment,
  not permission to raise a timeout or run native work in an API role.
- Home metadata must not grant access or activate a bot. Preserve real names and previous photos
  on incomplete MAX responses; only explicit validated absence removes an avatar. Keep published
  snapshots, exact-bot catalog and header metadata consistent.

## Validate Before Broad CI

- Use the public root/API scripts; they own Prisma/contracts generation and locks. No parallel
  raw generation or `*:source`/`*:unlocked` bypass. Node 24 and `npm ci` remain required.
- Search callers and test doubles whenever a method's return/error/queue contract changes. Type
  doubles against the real method; update and run affected native full-path cases before broad CI.
- Verify test paths with `rg --files`. For Jest patterns anchor to `src/` when needed: the absolute
  worktree path also participates in matching. Use the nearest runbook's regression matrix.
- Native validation uses `node scripts/agent/with-test-stores.mjs --migrate --` followed by the
  public command. It owns isolated PostgreSQL 16/Redis 7, UTC and cleanup. Keep process and database
  clocks UTC; report any storage-dependent skip. Do not mistake a mock pass for race coverage.
- SQL hot paths need representative history, skew, locked rows and bounded probe/plan evidence.
  `LIMIT` or small mocked fixtures do not prove bounded database work.
- Import Prisma through `src/prisma/prisma-client.ts`. Schema model/enum/mapping changes need
  immutable migrations and the policy baseline update. Never edit old migrations. Destructive
  drops require a compatible reader release first. Details are in the Prisma reference above.
- Build through the public script; the runtime entrypoint is `dist/apps/api/src/main.js`.

## MAX Integration And Live Tests

- Verify current MAX behavior against `https://dev.max.ru/docs/`, then `https://dev.max.ru/docs-api/`,
  `https://help.max.ru/help/bots` and official `https://github.com/max-messenger` sources.
  Removed `GET /chats` must not return to production discovery.
- Production currently uses `https://platform-api2.max.ru`; `env.schema.ts` rejects the retired
  `platform-api.max.ru` host. Check validated configuration before writing a probe; use the normal
  client admission/cooldown and exact bot scope even for read-only diagnostic requests.
- Tokens go only in `Authorization`, never query strings or output. Keep the Russian CA bundle.
  Production uses authenticated HTTPS webhooks; long polling is development-only.
- Current `MaxClientService` defaults to 30 rps per bot token (`MAX_API_GLOBAL_RPS`). This is a
  project limit, not a guaranteed MAX allowance. Keep shared per-token admission/cooldown,
  source/lane priorities and per-role/chat/message limits; do not raise quotas without evidence.
- Hot paths use targeted member access; full rosters belong to durable background work unless
  the feature actually requires them. Preserve fresh bot and human checks for explicit Start.
- The user designated `CHAT -78271094414679` and `CHANNEL -78271171091799` for live tests.
  Verify actual entity type and exact bot access before mutation; designation does not prove
  membership/admin rights. Use only uniquely marked agent-created content while production is
  healthy, clean up only that content and restore scenario settings. Never sanction real people
  or delete pre-existing messages. See [test rules](../../docs/development/api-domain-reference.md#live-max-test-entities).
