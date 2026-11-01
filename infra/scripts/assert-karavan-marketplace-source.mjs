import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// FLAG: Enrollment and queued scoped SENDs outlive feature flags. An older
// dispatcher must never interpret their metadata as permission for a legacy send.
// Format epochs and fixed administration targets remain publication authority after a format change.
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
    ['shouldUseScopedRelay(', 'karavanMarketplacePublication: params.scopedPublication'],
  ],
  [
    'packages/contracts/src/karavan-marketplace.ts',
    [
      "'cancelled'",
      'karavanPublicationChoiceSaveSchema',
      '  format: karavanShopFormatSchema.optional(),\n  administrationStoreId: karavanMarketplaceIdSchema.nullable().optional(),\n  formatRevision: z.number().int().positive().optional(),',
    ],
  ],
  [
    'apps/api/src/integrations/karavan-marketplace/karavan-marketplace-proxy.service.ts',
    ['async cancelSetup(', "row.state === 'cancelled'", 'checkpoints.bindings.some'],
  ],
  [
    'apps/api/prisma/schema.prisma',
    [
      'model KaravanMarketplaceChatEnrollment {',
      'model KaravanMarketplaceBindingWitness {',
      'commerceRevocationEpoch',
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
