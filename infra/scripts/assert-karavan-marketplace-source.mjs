import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// FLAG: Enrollment and queued scoped SENDs outlive feature flags. An older
// dispatcher must never interpret their metadata as permission for a legacy send.
// Format epochs and explicit administration targets remain publication authority after a format change.
// FLAG: Durable binding intents and chat reservations survive leases and disabled
// flags. Rollback must retain their journal reader and the superseded outcome.
export const KARAVAN_MARKETPLACE_SOURCE_CHECKS = Object.freeze([
  [
    'apps/api/src/max/max-action-dispatch.service.ts',
    [
      'attemptJob.ledgerContext?.karavanMarketplacePublication !== undefined',
      'Karavan marketplace dispatch guard unavailable',
      'await this.karavanMarketplaces.assertDispatch(attemptJob, candidateBotId ?? null)',
      "attemptJob.sourceTag === 'karavan_storefront_relay'",
      'attemptJob.ledgerContext?.karavanStorefrontRelay !== undefined',
    ],
  ],
  [
    'apps/api/src/integrations/karavan-marketplace/karavan-legacy-publication.guard.ts',
    [
      'prisma.karavanMarketplaceChatEnrollment.findUnique(',
      '/v1/integrations/maxim/storefronts/by-max-user/',
      'if (!response.ok)',
      'store.id !== context.data.storeId',
    ],
  ],
  [
    'apps/api/src/integrations/karavan-marketplace/karavan-marketplace-resolver.service.ts',
    [
      'this.prisma.karavanMarketplaceChatEnrollment.findUnique(',
      'const raw = job.ledgerContext?.karavanMarketplacePublication;',
      'karavanScopedPublicationSchema.parse(raw)',
      "this.config.get<boolean>('KARAVAN_STOREFRONT_RELAY_ENABLED') !== true",
      'candidateBotId !== publication.botId',
      'job.routing?.requiredBotId !== publication.botId',
      'await this.resolve(publication, publication)',
      'expected.bindingGeneration !== publication.bindingGeneration',
      'expected.sourceFingerprint !== issued.sourceFingerprint',
      "if (result.status === 'choose_store')",
      'previous.bindingGeneration === binding.generation',
      'choice.bindingGeneration',
      'format: karavanShopFormatSchema.optional(),',
      'formatRevision: z.number().int().positive().optional(),',
      '      format,\n      formatRevision,',
      "if (format === 'storefront' && result.status !== 'published')",
      'result.marketplace.administrationStoreId !== store?.id',
      "result.publicationTarget === 'administration_shop'",
      "result.publicationTarget === 'administration_store'",
      "format !== 'storefront'",
      "result.status !== 'published'",
      'payload.storeId !== null || result.stores.length !== 0',
      'result.stores[0]?.id !== payload.storeId',
      "(expected.format ?? 'community') !== format",
      '(expected.formatRevision ?? 1) !== formatRevision',
      'expected.storeId !== publication.storeId',
      'expected.url !== publication.url',
      "publication.format === 'storefront' &&",
      'buttons.length !== 1',
      'buttons[0].url !== publication.url',
    ],
  ],
  [
    'apps/api/src/integrations/karavan-storefront/karavan-storefront-relay.service.ts',
    [
      'shouldUseScopedRelay(',
      'karavanMarketplacePublication: params.scopedPublication',
      "scopedPublication.format !== 'storefront' && trigger !== 'bare'",
    ],
  ],
  [
    'packages/contracts/src/karavan-marketplace.ts',
    [
      "'cancelled'",
      'karavanPublicationChoiceSaveSchema',
      '  format: karavanShopFormatSchema.optional(),',
      '  administrationStoreId: karavanMarketplaceIdSchema.nullable().optional(),',
      '  formatRevision: z.number().int().positive().optional(),',
      "publicationTarget: z.enum(['administration_shop', 'administration_store']).optional(),",
    ],
  ],
  [
    'apps/api/src/integrations/karavan-marketplace/karavan-marketplace-proxy.service.ts',
    [
      'async cancelSetup(',
      "row.state === 'cancelled'",
      'checkpoints.bindings.some',
      'new ConnectionJournal(this.prisma).release(tx, operationId)',
      'journal.claim(tx, {',
      "existing.kind !== 'setup'",
      "row?.kind === 'setup'",
      'if (!isDurableManagementWrite(payload)) return dispatch();',
      'new ManagementJournal(this.prisma, this.config).run(',
    ],
  ],
  [
    'apps/api/src/integrations/karavan-marketplace/karavan-marketplace-connections.service.ts',
    [
      'export class KaravanMarketplaceConnectionsService',
      "new Set(['complete', 'rejected', 'cancelled', 'superseded'])",
      "row.kind !== 'binding'",
      'row.actorMaxUserId !== actorMaxUserId',
      'row.anchorChatId !== chatId',
      "kind: 'binding'",
      'if (grant && grant.scopeHash !== karavanHash(bindingScope(actorMaxUserId, chatId, input)))',
      'if (importOnly && !grant) {',
      'const receipt = await readKaravanCommandReceipt(',
      'if (!receipt)\n          throw new ForbiddenException(',
      'importedReceipt = karavanMarketplaceBindingResultSchema.parse(receipt);',
      'if (importOnly && !grant && !importedReceipt)',
      "state: importOnly || legacy ? 'unknown' : 'pending'",
      'if (importedReceipt) {\n        return tx.karavanMarketplaceConnectionOperation.update({',
      "state: 'complete',\n            activeScopeKey: null,\n            result: importedReceipt,",
      'await this.journal.claim(tx,',
      'await this.journal.release(tx, row.id)',
      'const receipt = await this.receipt(row);',
      'karavanHash(bindingScope(row.actorMaxUserId, row.anchorChatId, input))',
      "'KARAVAN_CONNECTION_SUPERSEDED'",
    ],
  ],
  [
    'apps/api/src/integrations/karavan-marketplace/karavan-connection-journal.ts',
    [
      'export class ConnectionJournal',
      "new Set(['complete', 'rejected', 'cancelled', 'superseded'])",
      'this.prisma.karavanMarketplaceConnectionScope.findUnique(',
      'lastOperationId: true',
      'await this.lock(tx, scopeIds)',
      'marketplaceIds.map((id) => `marketplace:${id}`)',
      'if (terminalStates.has(operation.state)) return;',
      'scope.revision !== input.expectedRevision',
      'lastOperationId: input.operationId',
      '!terminalStates.has(operation.state)',
      'where: { activeOperationId: operationId }',
      'data: { activeOperationId: null }',
    ],
  ],
  [
    'apps/api/src/integrations/karavan-marketplace/karavan-management-journal.ts',
    [
      'export class ManagementJournal',
      'export function managementReceiptHash(',
      "kind: 'management'",
      'previous.actorMaxUserId !== actorMaxUserId',
      'previous.anchorChatId !== request.chatId',
      'previous.requestHash !== requestHash',
      'await this.journal.claim(tx, {',
      'marketplaceIds: [request.marketplaceId]',
      'await this.journal.release(tx, row.id)',
      "action: 'manage_shop'",
      'managementRequest: request',
      'managementReceiptHash(request)',
      "state: grant ? 'unknown' : 'pending'",
      'const result = await dispatch(async () => {',
      'leaseUntil: { gt: new Date() }',
      "data: { state: 'unknown', leaseUntil:",
      'if (held.count !== 1) throw unavailable();',
      "original.state === 'pending'",
      "'KARAVAN_COMMAND_RESULT_CONFIRMED'",
    ],
  ],
  [
    'apps/api/src/integrations/karavan-marketplace/karavan-command-receipts.ts',
    [
      'export async function readKaravanCommandReceipt(',
      '/api/v1/integrations/maxim/marketplaces/command-status',
      'result.commandId !== input.commandId',
      "if (result.status === 'not_found') return null;",
      'result.requestHash !== expectedRequestHash',
      'result.managementRequestHash !== karavanHash(input.managementRequest)',
      'result.response.marketplace.id !== input.marketplaceId',
      "code: 'KARAVAN_RECEIPT_UNAVAILABLE'",
    ],
  ],
  [
    'apps/api/src/integrations/karavan-marketplace/karavan-marketplace.controller.ts',
    [
      'this.connections.snapshot(',
      'this.connections.legacyBind(',
      'this.connections.bind(',
      'this.connections.status(',
      'this.connections.resume(',
    ],
  ],
  [
    'packages/contracts/src/karavan-marketplace-connection.ts',
    [
      'karavanConnectionBindingOperationSchema',
      "'superseded'",
      'karavanConnectionSnapshotSchema',
      "kind: z.literal('binding')",
      'expectedConnectionRevision:',
    ],
  ],
  [
    'apps/api/prisma/schema.prisma',
    [
      'model KaravanMarketplaceChatEnrollment {',
      'model KaravanMarketplaceBindingWitness {',
      'commerceRevocationEpoch',
      'model KaravanMarketplaceConnectionOperation {',
      'model KaravanMarketplaceConnectionScope {',
      '@map("error_code")',
      '@relation("ActiveKaravanConnection")',
      '@relation("LastKaravanConnection")',
      '@@map("karavan_marketplace_connection_scopes")',
    ],
  ],
]);

export function assertKaravanMarketplaceSource(sha, readSource) {
  if (!/^[a-f0-9]{40}$/u.test(sha)) throw new Error('Exact source SHA required');
  for (const [path, markers] of KARAVAN_MARKETPLACE_SOURCE_CHECKS) {
    const source = readSource(path);
    if (
      typeof source !== 'string' ||
      source.length > 4 * 1024 * 1024 ||
      markers.some((marker) => !source.includes(marker))
    )
      throw new Error(
        `Rollback source lacks permanent Karavan enrollment/publication guards: ${path}`,
      );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const sha = process.argv[2];
  try {
    assertKaravanMarketplaceSource(sha, (path) =>
      execFileSync('git', ['show', `${sha}:${path}`], {
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'Karavan rollback source unavailable'}\n`,
    );
    process.exitCode = 1;
  }
}
