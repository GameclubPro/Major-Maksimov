import { execFileSync } from 'node:child_process';

// FLAG: Installed exact-source exclusions survive rollback. Preserving only the
// schema or legacy member-wide readers cannot fence these independent sources.
export const SOURCE_ABANDONMENT_SOURCE_CHECKS = Object.freeze([
  [
    'apps/api/src/webhook/webhook-source-abandonment.contract.ts',
    [
      "SOURCE_ABANDONMENT_OPERATION = 'MODERN_SOURCE_ABANDONMENT_V1'",
      'SOURCE_ABANDONMENT_VERSION = 1',
      "SOURCE_ABANDONMENT_HUMAN_PROFILE = 'HUMAN_CHAT_V1'",
      "SOURCE_ABANDONMENT_CHANNEL_PROFILE = 'CHANNEL_AUTHORLESS_V1'",
    ],
  ],
  [
    'apps/api/src/webhook/webhook-source-abandonment.ts',
    [
      'export async function materializeSourceAbandonmentReceipt(',
      'certificate.sealedAt',
      'sourceAbandonmentReceiptSourceDigest(event, proof.originalStatus)',
      'source_frozen_owner_unproved',
      'source_receipt_independent_claim',
      'tx.webhookSourceReceiptDisposition.create(',
      'sourceDispositionId: proof.id',
      'sourceDispositionReceiptId: event.id',
      'inspectSourceAbandonmentAnySource(owner, onRefusal)',
      'inspectSourceAbandonmentAnySource(owner, onRefusal, settings ?? undefined)',
      'const provenance = inspectSourceAbandonmentAnySource(',
      'source.sourceProfile === undefined ? SOURCE_ABANDONMENT_HUMAN_PROFILE : source.sourceProfile',
      'source.subjectUserId !== null',
      '{ sourceProfile: SOURCE_ABANDONMENT_CHANNEL_PROFILE, userId: null }',
      '!isSourceAbandonmentCheckpointSupported(owner, claim)',
      '!isSourceAbandonmentCheckpointSupported(owner, ownerClaim)',
      'buildWebhookReceiptSemanticKey(event.normalizedPayload as never, publisherBotId)',
      'receiptSemanticKey !== event.semanticKey',
      'const independentClaims = await readLegacyReceiptClaims(',
      'if (independentClaims.length)',
      'const publisherBotId = binding?.publisherBotId;',
      'majorBotIds.includes(publisherBotId)',
    ],
  ],
  [
    'apps/api/src/webhook/webhook-receipt-semantic-key.ts',
    [
      'export function buildWebhookReceiptSemanticKey(',
      'update.botId?.trim() !== publisherBotId',
      'publisher-observation:v1:${publisherBotId}:${key}',
    ],
  ],
  [
    'apps/api/src/webhook/webhook-source-abandonment-checkpoint.ts',
    [
      'export function isSourceAbandonmentCheckpointSupported(',
      "const waitingKeys = ['kind', 'authorityVersion', 'webhookEventId', 'semanticKey', 'deadlineAt'];",
      'if (claim.commandResult === null) return true;',
      'keys.length === waitingKeys.length',
      'keys.every((key) => waitingKeys.includes(key))',
      "checkpoint.kind === 'EXECUTION_WAITING'",
      'checkpoint.authorityVersion === MULTIBOT_EXECUTION_AUTHORITY_VERSION',
      'claim.webhookEventId === owner.id',
      'claim.semanticKey === owner.semanticKey',
      'checkpoint.webhookEventId === owner.id',
      'checkpoint.semanticKey === owner.semanticKey',
      'Number.isFinite(deadline.getTime())',
      'Number.isFinite(started.getTime())',
      'started.getTime() < deadline.getTime()',
      'checkpoint.deadlineAt === deadline.toISOString()',
    ],
  ],
  [
    'apps/api/src/webhook/webhook-semantic-authority.ts',
    ["MULTIBOT_EXECUTION_AUTHORITY_VERSION = 'semantic-owner-lease-v1'"],
  ],
  [
    'apps/api/src/webhook/webhook-source-abandonment-channel.ts',
    [
      'export function inspectChannelAuthorlessSource(',
      'export function inspectSourceAbandonmentAnySource(',
      'export function isSourceAbandonmentChannelMedia(',
      '!isSourceAbandonmentChannelMedia(body.attachments, message.link)',
      "button.type === 'link'",
      "button.type !== 'open_app'",
      "!keys(button, ['type', 'text', 'web_app', 'contact_id', 'url', 'payload'])",
      "recipient.chat_type !== 'channel' || normalized.entityType !== 'channel'",
      "message.sender !== undefined || normalized.senderId !== ''",
      'legacySnapshotDigest(storedRaw) !== legacySnapshotDigest(raw)',
      '(!postSeal || Object.keys(storedRaw).length)',
      'sourceProfile: SOURCE_ABANDONMENT_CHANNEL_PROFILE',
      'userId: null',
      'inspectChannelAuthorlessSource(owner, onRefusal, settings, postSeal)',
      "inspectSourceAbandonmentReplyText(linkedUpdate, 'SOURCE_ABANDONMENT', settings)",
      'inspectSourceAbandonmentPostSealSource(owner, settings)',
      'inspectSourceAbandonmentSource(owner, onRefusal, settings)',
    ],
  ],
  [
    'apps/api/src/webhook/webhook-legacy-forward-source.ts',
    [
      'export function inspectLegacyForwardText(',
      'export function inspectLegacyPostSealForwardText(',
      'export function inspectSourceAbandonmentForwardText(',
      "return inspectForwardText(update, settings, 'legacy');",
      "return inspectForwardText(update, settings, 'legacy-post-seal');",
      "return inspectForwardText(update, settings, 'source-abandonment');",
      "const omittedSender = profile === 'source-abandonment' && link?.sender === undefined;",
      "link.type !== 'forward'",
      // FLAG: Keep modern, created-only legacy links/previews and the strict fresh
      // legacy default independent; see legacy-webhook-order-recovery.md.
      "const modern = profile === 'source-abandonment';",
      "const createdLegacyForward =\n    profile === 'legacy-post-seal' &&\n    update.type === 'message_created' &&\n    raw?.update_type === 'message_created' &&\n    record(message?.link)?.type === 'forward';",
      "modern\n      ? (item) => isSourceAbandonmentOuterMarkup(item, message?.link)\n      : profile === 'legacy-post-seal'\n        ? (item) =>\n            isLegacyPostSealOuterMarkup(\n              item,\n              message?.link,\n              createdLegacyForward ? update.type : undefined,\n            )\n        : undefined",
      "modern\n      ? (item) => isSourceAbandonmentMarkup(item.markup, item.text)\n      : profile === 'legacy-post-seal'\n        ? (item) => isLegacyPostSealMarkup(item.markup, item.text, createdLegacyForward)\n        : undefined",
      "modern\n      ? (attachments) =>\n          isSourceAbandonmentLinkedMedia(attachments, 'forward', 'SOURCE_ABANDONMENT')\n      : createdLegacyForward\n        ? isLegacyPostSealLinkedMedia\n        : undefined",
      `function isLegacyPostSealMarkup(value: unknown, text: unknown, allowLinks: boolean): boolean {
  return (
    isLegacyPassiveMarkup(value, text) ||
    (allowLinks &&
      Array.isArray(value) &&
      value.length <= 64 &&
      value.every(
        (entry) => record(entry)?.type === 'link' || isLegacyPassiveMarkup([entry], text),
      ) &&
      isSourceAbandonmentMarkup(value, text))
  );
}`,
      `function isLegacyPostSealLinkedMedia(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length > 10) return false;
  return (
    value.every(isLegacyImageAttachment) ||
    (value.length === 1 &&
      record(value[0])?.type === 'share' &&
      isSourceAbandonmentDirectMedia(value, undefined))
  );
}`,
      `export function isLegacyPostSealOuterMarkup(
  body: Record<string, unknown>,
  linkValue: unknown,
  updateType?: unknown,
): boolean {
  const link = record(linkValue);
  const allowLinks = updateType === 'message_created' && link?.type === 'forward';
  if (isLegacyPostSealMarkup(body.markup, body.text, allowLinks)) return true;
  const linked = record(link?.message);
  return Boolean(
    body.text === '' &&
    link?.type === 'forward' &&
    linked &&
    Array.isArray(body.markup) &&
    body.markup.length <= 64 &&
    isLegacyPostSealMarkup(linked.markup, linked.text, allowLinks) &&
    JSON.stringify(body.markup) === JSON.stringify(linked.markup),
  );
}`,
      'item.attachments.length <= 10',
      'item.attachments.every(isLegacyImageAttachment)',
      'legacyParsedTextMatches(update)',
      '[direct.text, linked.text, normalized.text]',
      'parseAdminForwardedModerationCommand(text, settings)',
    ],
  ],
  [
    'apps/api/src/webhook/webhook-source-abandonment-content.ts',
    [
      "} from './webhook-source-abandonment-media';",
      'export function inspectSourceAbandonmentReplyText(',
      "link.type !== 'reply'",
      "isSourceAbandonmentLinkedMedia(item.attachments, 'reply', purpose)",
      'legacyParsedTextMatches(update)',
      '[direct.text, linked.text, normalized.text]',
      'parseAdminForwardedModerationCommand(text, settings)',
    ],
  ],
  [
    'apps/api/src/webhook/webhook-source-abandonment-media.ts',
    [
      'export function isSourceAbandonmentDirectMedia(',
      'if (link !== undefined || !Array.isArray(value)) return false;',
      'if (isLegacyDirectMedia(value)) return true;',
      "item.type === 'share'",
      "onlyKeys(item, ['type', 'payload', 'title', 'description', 'image_url'])",
      "if (item?.type === 'audio')",
      'isLegacyOpaqueSequence(payload.id)',
      'export function isSourceAbandonmentLinkedMedia(',
      'purpose: SourceAbandonmentContentPurpose',
      'if (value.length !== 1) return false;',
      "if (relation === 'reply' && item?.type === 'audio')",
      "return purpose === 'SOURCE_ABANDONMENT' && isSourceAbandonmentDirectMedia(value, undefined);",
      'if (!Array.isArray(value) || value.length > 10) return false;',
      'if (value.every(isLegacyImageAttachment)) return true;',
      "if (item?.type === 'video') return isLegacyDirectMedia(value);",
      "if (relation === 'forward' && item?.type === 'share')",
      "if (relation !== 'reply' || item?.type !== 'sticker') return false;",
      "onlyKeys(payload, ['url', 'code'])",
    ],
  ],
  [
    'apps/api/src/webhook/webhook-legacy-content-primitives.ts',
    [
      'export function isLegacyImageAttachment(',
      "onlyKeys(payload, ['photo_id', 'token', 'url'])",
      "url.protocol !== 'https:' || url.username || url.password",
      'export function isLegacyOpaqueSequence(',
      "typeof value === 'number' && Number.isInteger(value) && Math.abs(value) <= 2 ** 63",
    ],
  ],
  [
    'apps/api/src/webhook/webhook-source-abandonment-markup.ts',
    [
      'export function isSourceAbandonmentMarkup(',
      "item.type === 'link'",
      'item.from + item.length > text.length',
      "if (item.type === 'user_mention')",
      "onlyKeys(item, ['type', 'from', 'length', 'user_id'])",
      'Number.isSafeInteger(item.user_id)',
      'sourceAbandonmentHttpsUrl(item.url)',
      'export function isSourceAbandonmentOuterMarkup(',
      "body.text === ''",
      "link?.type === 'forward'",
      'isSourceAbandonmentMarkup(linked.markup, linked.text)',
      'JSON.stringify(body.markup) === JSON.stringify(linked.markup)',
    ],
  ],
  [
    'apps/api/src/webhook/webhook-legacy-direct-source.ts',
    [
      'export function isLegacyDirectMedia(',
      'value.length <= 10',
      'value.every((item) => isLegacyImageAttachment(item) || video(item))',
      "item.type === 'video'",
      "onlyKeys(payload, ['url', 'token', 'id'])",
      'httpsUrl(payload.url)',
      'videoThumbnail(item.thumbnail)',
    ],
  ],
  [
    'apps/api/src/webhook/webhook-legacy-source.ts',
    [
      'inspectLegacyForwardText(update, settings)',
      'inspectSourceAbandonmentForwardText(update, settings)',
      'export function inspectSourceAbandonmentSource(',
      'export function inspectSourceAbandonmentPostSealSource(',
      "profile: 'legacy' | 'source-abandonment' = 'legacy'",
      '!isSourceAbandonmentDirectMedia(body.attachments, message.link)',
      '!isSourceAbandonmentOuterMarkup(body, message.link)',
      'inspectSourceAbandonmentReplyText(update, purpose, settings)',
      'export function inspectPristineOperatorDiscardSource(',
      "    'source-abandonment',\n    'PRISTINE_OPERATOR_DISCARD_V1',",
      'const chatId = identity(recipient.chat_id);',
      'const messageId = identity(body.mid);',
      'const userId = identity(sender.user_id);',
      'return { chatId, messageId, userId, sourceAt: new Date(sourceAt) };',
    ],
  ],
  [
    'apps/api/src/webhook/webhook-pristine-discard.ts',
    [
      'inspectPristineOperatorDiscardSource(owner, settings ?? undefined)',
      'inspectPristineOperatorDiscardSource(event, settings ?? undefined)',
    ],
  ],
  [
    'apps/api/src/webhook/webhook-legacy-hold.service.ts',
    [
      'async isSourceAbandoned(',
      'async isSourceChildHeld(',
      'FROM "webhook_source_abandonments"',
      'FROM "webhook_source_child_holds"',
      'materializeSourceAbandonmentReceipt(tx, webhookEventId)',
      '."source_disposition_id" IS NOT NULL',
      "'PhotoDuplicateModerationService'",
      "'CommercialOcrModerationService'",
      "'MessageDuplicateMediaService'",
      "'MessageDuplicateDeleteGuardService'",
    ],
  ],
  [
    'apps/api/prisma/schema.prisma',
    [
      'model WebhookSourceAbandonmentCertificate {',
      'model WebhookSourceAbandonment {',
      'model WebhookSourceChildHold {',
      'model WebhookSourceReceiptDisposition {',
      'fields: [sourceDispositionReceiptId, sourceDispositionId], references: [receiptId, id]',
      'sourceProfile String @default("HUMAN_CHAT_V1") @map("source_profile")',
      'subjectUserId String? @map("subject_user_id")',
    ],
  ],
  [
    'apps/api/src/moderation/channel-auto-post-legacy-recovery.ts',
    [
      'isMessageHeld: (chatId: string, messageId: string) => Promise<boolean>',
      'if (await this.dependencies.isMessageHeld(candidate.chatId, candidate.messageId)) continue;',
      "if (await this.dependencies.isMessageHeld(candidate.chatId, candidate.messageId))\n        return 'done';",
    ],
  ],
  [
    'apps/api/src/moderation/moderation.service.legacy.ts',
    [
      'isMessageHeld: async (chatId, messageId) =>',
      "if (await this.legacyHolds?.isMessageHeld(chatId, messageId)) return 'skipped';",
    ],
  ],
  [
    'apps/api/src/moderation/photo-duplicate/photo-duplicate-moderation.service.ts',
    [
      'private readonly legacyHolds?: WebhookLegacyHoldService',
      'if (await this.legacyHolds?.isUpdateHeld(update)) return;',
      'await this.legacyHolds?.isMessageHeld(album.chatId, observation.duplicateOfMessageId)',
    ],
  ],
  [
    'apps/api/src/moderation/commercial-ocr/commercial-ocr-moderation.service.ts',
    [
      'private readonly legacyHolds?: WebhookLegacyHoldService',
      'if (await this.legacyHolds?.isUpdateHeld(update)) return;',
      'await this.legacyHolds?.isUpdateHeld(webhookEvent.normalizedPayload as unknown as MaxUpdate)',
    ],
  ],
  [
    'apps/api/src/moderation/message-duplicate/message-duplicate-media.service.ts',
    [
      'private readonly legacyHolds?: WebhookLegacyHoldService',
      'if (update?.message && (await this.legacyHolds?.isUpdateHeld(update))) return null;',
    ],
  ],
  [
    'apps/api/src/moderation/message-duplicate/message-duplicate-delete-guard.service.ts',
    [
      'private readonly legacyHolds?: WebhookLegacyHoldService',
      'await this.assertLegacySourcesAllowed(chatId, binding);',
      'await this.assertLegacySourcesAllowed(params.chatId, binding);',
      'await this.legacyHolds?.isAnyMessageSourceHeld(chatId, [',
      '{ messageId: binding.messageId, userId: binding.senderId }',
      '{ messageId: binding.original.messageId, userId: binding.original.senderId }',
    ],
  ],
  [
    'apps/api/src/moderation/moderation-delete-intent.service.ts',
    [
      'private async isAbandonedIntentWithoutReceipt(',
      'if (await this.isAbandonedIntentWithoutReceipt(intent)) return this.toAttemptResult(intent);',
      'if (intent.retentionOwned || (await this.isAbandonedIntentWithoutReceipt(intent))) return;',
      '!(intent.remoteDeleteSucceededAt && intent.remoteDeleteSucceededBotId)',
      'FROM "webhook_source_abandonments" held',
    ],
  ],
  [
    'apps/api/src/moderation/moderation-rule-followup.service.ts',
    ['FROM "webhook_source_abandonments" held', 'isSourceAbandoned?.(row.chatId, row.messageId)'],
  ],
  [
    'apps/api/src/moderation/global-spammer-intelligence.service.ts',
    [
      "isSourceChildHeld?.('SPAMMER_OBSERVATION', job.observationId)",
      'private async isAbandonedSourceObservation(',
      'isSourceAbandoned?.(input.chatId, input.messageId)',
    ],
  ],
  [
    'apps/api/src/webhook/webhook-outbox.service.ts',
    [
      '"source_disposition_id",',
      '"legacy_disposition_id" IS NULL AND "source_disposition_id" IS NULL',
      'FROM "webhook_source_abandonments" original',
      'FROM "webhook_source_receipt_dispositions" proof',
    ],
  ],
]);

export function assertSourceAbandonmentSource(
  commitSha,
  readSource = (path) =>
    execFileSync('git', ['show', `${commitSha}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
) {
  if (!/^[0-9a-f]{40}$/u.test(commitSha ?? '')) throw new Error('Exact source SHA required');
  for (const [path, markers] of SOURCE_ABANDONMENT_SOURCE_CHECKS) {
    const source = readSource(path);
    if (typeof source !== 'string' || markers.some((marker) => !source.includes(marker)))
      throw new Error(`Rollback target lacks permanent exact-source abandonment readers: ${path}`);
  }
  const holds = readSource('apps/api/src/webhook/webhook-legacy-hold.service.ts');
  const members = holds.slice(
    holds.indexOf('  async hasChatHolds('),
    holds.indexOf('  async isAnyMessageSourceHeld('),
  );
  if (!members || members.includes('webhook_source_'))
    throw new Error('Exact-source abandonment must not grant blanket participant immunity');
}
