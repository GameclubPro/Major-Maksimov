import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// FLAG: Author deadlines and unprepared recipients survive restarts. A legacy five-minute
// reader or eager SEND worker is unsafe after these intents have been written.
export const PUBLICATION_POLICY_SOURCE_CHECKS = [
  [
    'packages/contracts/src/publication.ts',
    [
      'latePolicy: publicationLatePolicySchema.optional()',
      'maxDelayMinutes: z.number().int().min(1).max(7 * 24 * 60)',
    ],
  ],
  [
    'apps/api/src/admin/publication-late-policy.ts',
    [
      'export async function isPublicationOccurrenceWindowClosed(',
      'resolvePublicationDeliveryDeadline(occurrence, now)',
      'occurrence.deliveryDeadlineAt',
      'occurrence.retryExpiresAt',
      'prisma.publicationOccurrence.findFirst(',
      'scheduleRevision: occurrence.scheduleRevision',
      'readPublicationRetryAuthorizedAt(occurrence)',
    ],
  ],
  [
    'apps/api/src/admin/publication-occurrence-dispatcher.ts',
    ['await isPublicationOccurrenceWindowClosed(context.prisma, occurrence, now)'],
  ],
  [
    'apps/api/src/admin/publication-execution-recovery.ts',
    [
      'await isPublicationOccurrenceWindowClosed(options.prisma, occurrence)',
      'readPublicationLatePolicy(occurrence.schedule.rule)',
      'preDispatchClaim.lockToken',
      'remoteMessageId: null',
      'nextAttemptAt: retryAt',
      'rateLimitDeferralCount: { increment: 1 }',
    ],
  ],
  [
    'apps/api/src/admin/publication-stopped-dispatch-cleanup.ts',
    ['await isPublicationOccurrenceWindowClosed('],
  ],
  [
    'apps/api/src/admin/publication-runner.service.ts',
    ['roleRunsPublisher(getAppRole())', 'this.boundary?.dispatchEnabled'],
  ],
  [
    'apps/api/src/admin/publisher-publication-recipient-admission.ts',
    ['delivery.nextAttemptAt', 'publisherPublicationRecipientRetryAt'],
  ],
  [
    'apps/api/src/admin/publisher-selected-access.service.ts',
    ['PUBLISHER_DURABLE_ACTOR_AUTHORITY_VERSION = 1', "edge.state !== 'GRANTED'"],
  ],
  [
    'apps/api/src/admin/publication-target-preparation.ts',
    [
      'marker.version !== 0',
      "marker.preparation !== 'pending'",
      'marker.chatId !== delivery.targetChatId',
      'marker.dialogBotId !== requiredBotId',
      "status: 'PENDING'",
      'attemptCount: 0',
      'PUBLISHER_PUBLICATION_REPREPARATION_VERSION = 2',
      'contentRevisionId: delivery.contentRevisionId',
      'marker.contentRevisionId !== delivery.contentRevisionId',
      'occurrence.retryAuthorizedAt?.getTime() !== authorizedAtMs',
      'occurrence.retryExpiresAt?.getTime() !== expiresAtMs',
      'attemptCount: current.attemptCount',
      'publisherDialogContext: { equals: marker }',
      'persisted.count !== 1',
    ],
  ],
  [
    'apps/api/src/admin/publisher-managed-broadcast-dispatch.ts',
    [
      'await this.assertDeliveryReady(delivery.targetChatId, requiredBotId, authority)',
      'await this.requiresLegacyActorAuthority(authority, requiredBotId, chatId)',
      'occurrence.publication.targets.some((target) => target.canceledAt)',
      'throw new PublisherDeliveryDeferredError(PUBLISHER_TARGET_CANCELED)',
      'resolvePublicationExecutionIntent(occurrence)',
      'occurrence.contentRevisionId !== authority.contentRevisionId',
      'occurrence.schedule.revision !== occurrence.scheduleRevision',
      'await preparePendingPublicationContext(this.context, delivery, requiredBotId)',
    ],
  ],
  [
    'apps/api/src/admin/publication-execution-authority.ts',
    [
      'PUBLISHER_ENTITY_EXECUTION_AUTHORITY_VERSION = 1',
      'readPublicationRetryAuthorizedAt(occurrence)',
      "return { kind: 'invalid' }",
      "return { kind: 'entity', deadlineAt }",
    ],
  ],
  [
    'apps/api/src/admin/publication-publisher-routing.service.ts',
    ['publication.targets.filter((target) => !target.canceledAt)'],
  ],
  [
    'apps/api/src/admin/admin-managed-broadcast-runtime.ts',
    [
      'const publisherAuthority: PublisherDeliveryAuthority',
      'await this.publisherDispatch.assertDeliveryReady(delivery.targetChatId, publisherRoute.exactBotId, publisherAuthority,)',
      'await this.publisherDispatch.deferUnreadyBeforeClaim(row, delivery, requiredPublisherBotId!, publisherAuthority,)',
    ],
  ],
  [
    'apps/api/src/publisher/publisher-publication-access-preflight.service.ts',
    ["resolvePublicationExecutionIntent(occurrence, now).kind === 'legacy_actor'"],
  ],
  [
    'apps/api/src/publisher/publisher-publication-post-actions.service.ts',
    ['resolvePublicationExecutionIntent(occurrence ?? {}, now)', 'const entityIntent'],
  ],
  [
    'apps/api/src/admin/publisher-dialog-context.service.ts',
    ['raw.version !== 1', 'raw.dialogBotId !== expectedDialogBotId'],
  ],
  [
    'apps/api/src/admin/publication.service.ts',
    ['readPublicationLatePolicy(rule)', 'maxResults: 300'],
  ],
  [
    'apps/api/src/admin/admin-managed-broadcast-media-runtime.ts',
    [
      'actorUserId: asset.actorUserId',
      'contentRevisionId: source.contentRevisionId',
      'where: publicationAssetReferenceWhere(actorUserId,',
    ],
  ],
];

export function assertPublicationPolicySource(readSource) {
  for (const [path, required] of PUBLICATION_POLICY_SOURCE_CHECKS) {
    const source = readSource(path)
      .replace(/\/\*[\s\S]*?\*\//gu, '')
      .replace(/^\s*\/\/.*$/gmu, '');
    for (const fragment of required) {
      // Formatting is immaterial; the executable reader and each dispatch caller must exist.
      if (!source.replace(/\s+/gu, '').includes(fragment.replace(/\s+/gu, '')))
        throw new Error(
          `Rollback target lacks publication deadline/preparation reader: ${path} (${fragment})`,
        );
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const sha = process.argv[2];
    if (!/^[0-9a-f]{40}$/u.test(sha ?? '')) throw new Error('Expected an exact source SHA');
    assertPublicationPolicySource((path) =>
      execFileSync('git', ['show', `${sha}:${path}`], {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
