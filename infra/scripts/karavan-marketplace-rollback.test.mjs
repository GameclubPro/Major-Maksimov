import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertKaravanMarketplaceSource,
  KARAVAN_MARKETPLACE_SOURCE_CHECKS,
} from './assert-karavan-marketplace-source.mjs';
const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
test('current source retains publication guards and durable connection readers', () => {
  assert.doesNotThrow(() => assertKaravanMarketplaceSource('a'.repeat(40), read));
});

const integrationRoot = 'apps/api/src/integrations/karavan-marketplace/';
for (const { name, path, before, after } of [
  {
    name: 'setup-only runtime cannot interpret durable binding rows',
    path: `${integrationRoot}karavan-marketplace-connections.service.ts`,
    before: "kind: 'binding'",
    after: "kind: 'setup'",
  },
  {
    name: 'superseded binding outcome cannot revert to an active unknown state',
    path: `${integrationRoot}karavan-marketplace-connections.service.ts`,
    before: "new Set(['complete', 'rejected', 'cancelled', 'superseded'])",
    after: "new Set(['complete', 'rejected', 'cancelled'])",
  },
  {
    name: 'setup admission must share the durable chat reservation',
    path: `${integrationRoot}karavan-marketplace-proxy.service.ts`,
    before: 'journal.claim(tx, {',
    after: 'legacyActorScope.claim(tx, {',
  },
  {
    name: 'legacy binding imports must verify the retained grant scope',
    path: `${integrationRoot}karavan-marketplace-connections.service.ts`,
    before:
      'if (grant && grant.scopeHash !== karavanHash(bindingScope(actorMaxUserId, chatId, input)))',
    after: 'if (false)',
  },
  {
    name: 'legacy binding imports without a grant must read an exact receipt',
    path: `${integrationRoot}karavan-marketplace-connections.service.ts`,
    before: 'if (importOnly && !grant) {',
    after: 'if (importOnly && grant) {',
  },
  {
    name: 'legacy binding imports cannot accept an absent receipt',
    path: `${integrationRoot}karavan-marketplace-connections.service.ts`,
    before: 'if (!receipt)\n          throw new ForbiddenException(',
    after: 'if (false)\n          throw new ForbiddenException(',
  },
  {
    name: 'legacy binding admission must require original proof inside the transaction',
    path: `${integrationRoot}karavan-marketplace-connections.service.ts`,
    before: 'if (importOnly && !grant && !importedReceipt)',
    after: 'if (importOnly && !grant && importedReceipt)',
  },
  {
    name: 'legacy binding imports cannot be reclassified as undispatched commands',
    path: `${integrationRoot}karavan-marketplace-connections.service.ts`,
    before: "state: importOnly || legacy ? 'unknown' : 'pending'",
    after: "state: 'pending'",
  },
  {
    name: 'receipt-only imports must finish without claiming active scopes',
    path: `${integrationRoot}karavan-marketplace-connections.service.ts`,
    before:
      'if (importedReceipt) {\n        return tx.karavanMarketplaceConnectionOperation.update({',
    after: 'if (false) {\n        return tx.karavanMarketplaceConnectionOperation.update({',
  },
  {
    name: 'receipt-only imports cannot turn confirmed results back into unknown operations',
    path: `${integrationRoot}karavan-marketplace-connections.service.ts`,
    before:
      "state: 'complete',\n            activeScopeKey: null,\n            result: importedReceipt,",
    after:
      "state: 'unknown',\n            activeScopeKey: null,\n            result: importedReceipt,",
  },
  {
    name: 'release cannot discard the retained operation identity',
    path: `${integrationRoot}karavan-connection-journal.ts`,
    before: 'data: { activeOperationId: null }',
    after: 'data: { activeOperationId: null, lastOperationId: null }',
  },
  {
    name: 'daily writes cannot return to the unjournaled management dispatch',
    path: `${integrationRoot}karavan-marketplace-proxy.service.ts`,
    before: 'new ManagementJournal(this.prisma, this.config).run(',
    after: 'legacyManagementDispatch(',
  },
  {
    name: 'daily management rows cannot be interpreted as setup operations',
    path: `${integrationRoot}karavan-management-journal.ts`,
    before: "kind: 'management'",
    after: "kind: 'setup'",
  },
  {
    name: 'daily writes in another chat must reserve the shared marketplace',
    path: `${integrationRoot}karavan-management-journal.ts`,
    before: 'marketplaceIds: [request.marketplaceId]',
    after: 'marketplaceIds: []',
  },
  {
    name: 'legacy management grants cannot be reclassified as an undispatched command',
    path: `${integrationRoot}karavan-management-journal.ts`,
    before: "state: grant ? 'unknown' : 'pending'",
    after: "state: 'pending'",
  },
  {
    name: 'daily dispatch must durably record uncertainty before the HTTP effect',
    path: `${integrationRoot}karavan-management-journal.ts`,
    before: "data: { state: 'unknown', leaseUntil:",
    after: "data: { state: 'pending', leaseUntil:",
  },
  {
    name: 'daily dispatch cannot proceed after losing its exact execution lease',
    path: `${integrationRoot}karavan-management-journal.ts`,
    before: 'if (held.count !== 1) throw unavailable();',
    after: 'if (held.count < 0) throw unavailable();',
  },
  {
    name: 'confirmed short receipts must request a fresh view instead of rejection',
    path: `${integrationRoot}karavan-management-journal.ts`,
    before: "'KARAVAN_COMMAND_RESULT_CONFIRMED'",
    after: "'KARAVAN_MANAGEMENT_REJECTED'",
  },
  {
    name: 'management receipts must validate the full admitted request as well as the domain hash',
    path: `${integrationRoot}karavan-command-receipts.ts`,
    before: 'result.managementRequestHash !== karavanHash(input.managementRequest)',
    after: 'result.managementRequestHash !== result.managementRequestHash',
  },
  {
    name: 'historical receipt must validate the admitted original request hash',
    path: `${integrationRoot}karavan-command-receipts.ts`,
    before: 'result.requestHash !== expectedRequestHash',
    after: 'result.requestHash !== result.requestHash',
  },
  {
    name: 'not-found receipts cannot become import proof',
    path: `${integrationRoot}karavan-command-receipts.ts`,
    before: "if (result.status === 'not_found') return null;",
    after: "if (result.status === 'not_found') return result;",
  },
  {
    name: 'binding receipts cannot be adopted for another marketplace',
    path: `${integrationRoot}karavan-command-receipts.ts`,
    before: 'result.response.marketplace.id !== input.marketplaceId',
    after: 'result.response.marketplace.id !== result.response.marketplace.id',
  },
  {
    name: 'public state must retain the connection snapshot reader',
    path: `${integrationRoot}karavan-marketplace.controller.ts`,
    before: 'this.connections.snapshot(',
    after: 'this.proxy.activeSetup(',
  },
  {
    name: 'wire reader must preserve superseded separately from complete',
    path: 'packages/contracts/src/karavan-marketplace-connection.ts',
    before: "'superseded'",
    after: "'complete'",
  },
  {
    name: 'database reader must retain the last operation after release',
    path: 'apps/api/prisma/schema.prisma',
    before: '@relation("LastKaravanConnection")',
    after: '@relation("LegacyKaravanConnection")',
  },
])
  test(`rollback refuses semantic connection downgrade: ${name}`, () => {
    assert.ok(read(path).includes(before), `current fixture is missing ${before}`);
    assert.throws(
      () =>
        assertKaravanMarketplaceSource('a'.repeat(40), (sourcePath) =>
          sourcePath === path ? read(path).replaceAll(before, after) : read(sourcePath),
        ),
      (error) => error instanceof Error && error.message.endsWith(path),
    );
  });

for (const [path, markers] of KARAVAN_MARKETPLACE_SOURCE_CHECKS)
  for (const marker of markers)
    test(`rollback refuses missing Karavan guard: ${marker}`, () => {
      assert.throws(
        () =>
          assertKaravanMarketplaceSource('a'.repeat(40), (sourcePath) =>
            sourcePath === path ? read(path).replaceAll(marker, 'missing_guard') : read(sourcePath),
          ),
        (error) =>
          error instanceof Error &&
          error.message.includes('lacks permanent Karavan') &&
          error.message.endsWith(path),
      );
    });
for (const file of [
  'infra/scripts/vps-release-rollback.sh',
  'infra/scripts/vps-runtime-rollback.sh',
])
  test(`${file} checks Karavan reader floor before runtime mutation`, () => {
    const source = read(file);
    const guard = source.indexOf('maxim_topology_require_karavan_marketplaces ');
    assert.ok(guard > 0);
    assert.ok(guard < source.lastIndexOf('maxim_webhook_quiesce_for_api_rollout'));
  });
