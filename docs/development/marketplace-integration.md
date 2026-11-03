# Marketplace Integration And Advertising Buttons

This is the maintained Major/Publik boundary with «Биржик» (Market). Product decisions
are recorded in [MINIAPP-ADS-01 and MINIAPP-ADS-02](miniapp-product-decisions.md#miniapp-ads-01-текст-кнопки-рекламы-принадлежит-площадке).
It replaces the superseded October implementation plans. Historical release evidence
remains in Git; this reference does not attest current deployment or live MAX acceptance.
Karavan's chat shop uses its [separate runbook](../operations/runbooks/karavan-chat-marketplaces.md).

## Authority And Navigation

- The entity settings entry is «Рекламная биржа», with only icon, name and chevron.
  There is no advertising banner before the home entity list. The destination service
  remains «Биржик»; purchases and transactions belong to it.
- A verified administrator may read an existing profile and manage the entity's button
  policy. Reading never creates a profile or changes its owner. Profile editing, prices
  and transactions remain owner-only. A second administrator gets the permitted public
  view and independent button controls. Profile creation does not authorize placements.
- Major and Publik retain their exact bot/profile scopes. Statistics exchange, profile
  publication, placement readiness and button consent are independent. Do not add a
  statistics-consent screen or use a statistics collector as button-send authority.
- The signed compact `b1` navigation context contains a known destination, registry bot
  and selected entity. Preserve the 128-character startapp bound and canonical-link
  fallback. Navigation is not authorization. The return path is allowlisted; public
  message buttons contain the entity's public card link without personal return context.
- Profile access has its own `/bindings/:id/access` evidence. Preserve exact actor/bot/
  entity checks, expiry, and revocation checks before and after remote work and at commit.
  A passive refresh neither activates a dormant bot nor revives revoked consent.

Owners: [contracts](../../packages/contracts/src/marketplace-integration.ts),
[navigation](../../apps/api/src/integrations/marketplace/marketplace-navigation.service.ts),
[policy](../../apps/api/src/integrations/marketplace/marketplace-button-policy.service.ts),
[access](../../apps/api/src/integrations/marketplace/marketplace-access.service.ts).

## Button Policy And Compatibility

One revisioned label belongs to the entity across Major and Publik; its default is
«Заказать рекламу». Changing it affects future sends only. It is independent from the
button-policy revision, authority, publication and consent. Module switches save
independently from the module's settings draft and are not copied by network apply.

The legacy groups are `GREETINGS`, `MODERATION_NOTICES`, `CHANNEL_POSTS` and
`PUBLICATIONS`. Current policy additionally supports individual moderation modules
and publication/VK/suggestion contexts. Use the
[shared context schemas](../../packages/contracts/src/marketplace-integration.ts) and
[module mapping](../../apps/miniapp/src/lib/marketplace-button-policy.ts), not the old
four-switch UI as a complete inventory. A group switch applies to the entire group;
mixed state is explicit. Enabling a button never enables its parent module or sends a test.

Outside the central exchange section, the whole button block is absent unless the
entity profile is published. Central revocation remains available for previously saved
consent, including a hidden profile or unavailable Market. Preserve `expectedRevision`,
`requestId`, exact replay responses and conflict handling. An unknown write outcome is
read back with its original identity, never blindly repeated.

Keep both installed migration contracts:

- [Initial policies](../../apps/api/prisma/migrations/20261028010000_add_marketplace_button_policies/migration.sql)
  import only the previous scope's publication consent. Known revoked access cannot
  become active through lazy import or a later attestation. Preserve lock ordering,
  exact receipt/hash checks, existing permissions, statistics and history.
- [Module policies](../../apps/api/prisma/migrations/20261029010000_marketplace_button_modules/migration.sql)
  specialize an old aggregate under the existing locks; night mode and rules do not
  inherit old consent. Old group revocation reaches child policies even when the parent
  was already disabled. Old senders must honor a child's disable, and legacy publication
  sending must read the common entity label.

Version 2 responses are explicit (`version=2`); old clients retain their strict response
shape and ability to revoke groups. Keep installed migration/reader rollback checks.
Do not rewrite old migrations, receipts or queues during documentation or UI cleanup.

## Final Send And UI State

Carry the original moderation module through the sanction notice. Final dispatch checks
that module's current consent, common label, actual sender and confirmation owner.
Expired/unavailable proof omits the optional button without changing the permitted
message. Known revocation blocks immediately. Hidden profiles suppress the button;
deletion, ownership change or lost confirmer rights require explicit renewed consent.
Refresh work stays bounded. Preserve required keyboard buttons when capacity is full.
Do not delete/repost channel content or repeat an uncertain SEND to add an advertisement.

A confirmed public profile always offers «Посмотреть профиль» as its main action.
Placement setup stays separate: `READY` does not prove public visibility or complete
prices, and `SETUP_REQUIRED` does not identify a particular missing field. Editing
opens the fields directly. Save, publish and hide are separate explicit actions;
unsaved edits prevent publication/hiding. Confirmed publication returns to the overview.

Internal Back retains both drafts, scroll and focus for the current session. Full exit
or an external transition confirms unsaved changes; entity/account changes cannot
transfer drafts to another context. Loss of owner rights keeps the open draft readable
and prevents private fetches, writes and statistics access. Refresh on return, expiry,
conflicts and lost responses must not manufacture a success state.

## Focused Evidence

Use the [focused runner](agent-machine-contract.md#focused-checks-before-submission),
with [native stores](agent-local-environment.md) for PostgreSQL cases.

| Boundary                                       | Tests                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Public policy shape and module mapping         | [Contracts](../../packages/contracts/test/marketplace-buttons.spec.ts), [entry](../../apps/miniapp/test/marketplace-entry.test.ts)                                                                                                                                                                           |
| Scope, revocation, old clients and migration   | [Policy](../../apps/api/src/integrations/marketplace/marketplace-button-policy-postgres.spec.ts), [migration](../../apps/api/src/integrations/marketplace/marketplace-button-migration-postgres.spec.ts), [refresh](../../apps/api/src/integrations/marketplace/marketplace-button-refresh-postgres.spec.ts) |
| Final message composition                      | [Send helper](../../apps/api/src/max/marketplace-publication-button.spec.ts), [channel decoration](../../apps/api/src/moderation/channel-marketplace-decoration.spec.ts)                                                                                                                                     |
| Profile authority and navigation               | [Access](../../apps/api/src/integrations/marketplace/marketplace-profile-access-postgres.spec.ts), [navigation](../../apps/api/src/integrations/marketplace/marketplace-navigation.spec.ts)                                                                                                                  |
| Overview, drafts, role loss and unknown writes | [View model](../../apps/miniapp/test/marketplace-profile.test.ts), [profile browser](../../apps/miniapp/test/marketplace-profile.browser.mjs), [state browser](../../apps/miniapp/test/marketplace-profile-states.browser.mjs), [module browser](../../apps/miniapp/test/marketplace-modules.browser.mjs)    |

These browser scripts own a local server via the shared helper. Inspect their
`MINIAPP_MARKETPLACE_TEST_*` options before selecting a port or reusing a server.
Synthetic browser success does not prove real MAX Android/iOS, cross-bot navigation
or delivered messages. Keep the exact-SHA CI, deployment and live acceptance separate.
