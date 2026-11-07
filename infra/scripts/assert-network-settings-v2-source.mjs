import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// FLAG: The stable v2 entrypoint retains the v3 supplementary-operation floor.
// Accept its inline reader or the canonical v4 reader without losing legacy list intents/revisions.
export const NETWORK_SETTINGS_V2_SOURCE_CHECKS = Object.freeze([
  [
    'apps/api/prisma/migrations/20261022130000_network_allowlist_revision/migration.sql',
    [
      'ADD COLUMN "navigation_allowlist_revision" INTEGER NOT NULL DEFAULT 0',
      'CREATE TRIGGER navigation_allowlist_revision_insert AFTER INSERT ON domain_allowlist',
      'CREATE TRIGGER navigation_allowlist_revision_delete AFTER DELETE ON domain_allowlist',
      'CREATE TRIGGER navigation_allowlist_revision_update AFTER UPDATE ON domain_allowlist',
    ],
  ],
  [
    'apps/api/src/admin/admin.module.ts',
    [
      "import { NetworkNavigationAllowlist } from './network-navigation-allowlist';",
      'NetworkNavigationAllowlist,',
    ],
  ],
  [
    'apps/api/src/admin/network-settings.service.ts',
    [
      'assertOperationReader(stored);',
      "code: 'NETWORK_SETTINGS_READER_UNSUPPORTED'",
      'this.allowlist.commitOnly(',
      'this.allowlist.planInTransaction(',
      'request.navigationAllowlist!',
      'recipient.navigationAllowlistWitness!',
      '...payload, navigationAllowlistImpacts: impacts',
    ],
  ],
  [
    'apps/api/src/admin/network-navigation-allowlist.ts',
    [
      'SELECT navigation_allowlist_revision AS revision FROM chats WHERE id=${chatId} FOR UPDATE',
      'take: NETWORK_ALLOWLIST_PLAN_ROW_LIMIT + 1',
      'expected.revision !== actual.revision',
      "action: 'UPDATE_DOMAIN_ALLOWLIST'",
      'await options.onCommitted?.(tx, String(recipient.revision));',
    ],
  ],
  [
    'apps/api/src/admin/admin-chat-settings.ts',
    [
      'if (params.networkWrite?.beforeWrite)',
      'await params.networkWrite.beforeWrite(tx);',
      'await params.networkWrite.onCommitted(tx, savedRevision);',
    ],
  ],
  [
    'packages/contracts/src/network-settings.ts',
    [
      "export * from './network-settings-read.js';",
      "export * from './network-settings-actions.js';",
    ],
  ],
  [
    'packages/contracts/src/network-settings-read.ts',
    [
      "export const networkNavigationAllowlistIntentSchema = z.discriminatedUnion('mode', [",
      'export const networkNavigationAllowlistWitnessSchema = z',
    ],
  ],
]);

// FLAG: Match the actual parser or writer boundary. A response or neighboring method
// with the same field name cannot prove that retained requests are safely executable.
export const NETWORK_SETTINGS_V2_SCOPED_CHECKS = Object.freeze([
  [
    'packages/contracts/src/network-settings-read.ts',
    'export const networkChatSettingsSectionSchema =',
    'export const networkChannelSettingsSectionSchema =',
    ["'speechStyle'", "'rules'", "'messageRetention'", "'advertising'"],
  ],
  [
    'packages/contracts/src/network-settings-read.ts',
    'export const networkChannelSettingsSectionSchema =',
    'export const networkSettingsSectionSchema =',
    ["'quickButtons'", "'comments'", "'postSignature'", "'postSuggestions'"],
  ],
  [
    'apps/api/src/admin/network-settings-patch.ts',
    'const CHAT_SUPPLEMENTAL_SECTIONS =',
    'const retentionPatchSchema =',
    [
      "speechStyle: ['botSpeechStyle']",
      "'rules.text'",
      "'rulesAttachViolationsEnabled'",
      "messageRetention: ['messageRetention.enabled', 'messageRetention.hours']",
      "advertising: ['advertising.enabled']",
    ],
  ],
  [
    'apps/api/src/admin/network-settings-patch.ts',
    'const CHANNEL_SECTIONS =',
    'const STOP_WORD_PATHS =',
    [
      'postSuggestions: [',
      "'postSuggestionsEnabled'",
      "'postSuggestionsRequireSubscription'",
      "'postSuggestionsDeleteOnUnsubscribe'",
      "'postSuggestionsEntryMode'",
      "'postSuggestionsButtonText'",
      "'postSuggestionsText'",
      "'engagementMessageText'",
      "'postSuggestionsDailyLimit'",
    ],
  ],
  [
    'packages/contracts/src/network-settings-read.ts',
    'export const networkSettingsRecipientSchema = z',
    'export type NetworkSettingsRecipient =',
    [
      'entityId: z.string().min(1),',
      'title: z.string(),',
      'revision: revisionSchema,',
      'stopWordsRevision: z.number().int().nonnegative().optional(),',
      'navigationAllowlistWitness: networkNavigationAllowlistWitnessSchema.optional(),',
      'rulesRevision: z.string().datetime().nullable().optional(),',
      'rulesContextDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),',
      'messageRetentionRevision: z.number().int().nonnegative().optional(),',
      'advertisingRevision: z.number().int().nonnegative().optional(),',
      '.strict()',
    ],
  ],
  [
    'packages/contracts/src/network-settings-actions.ts',
    'export const networkSettingsPreviewRequestSchema = networkSettingsReadRequestSchema',
    'export type NetworkSettingsPreviewRequest =',
    [
      '.omit({ cursor: true }).extend({',
      'operationId: z.string().uuid(),',
      'compositionVersion: z.string(),',
      'recipients: z.array(networkSettingsRecipientSchema).min(1),',
      'changes: z.array(networkSettingsChangeSchema).max(128),',
      'navigationAllowlist: networkNavigationAllowlistIntentSchema.optional(),',
      "if (value.entityType !== 'chat' || value.section !== 'links')",
      'value.recipients.some((r) => !r.navigationAllowlistWitness)',
    ],
  ],
  [
    'apps/api/src/admin/network-settings.service.ts',
    'const V3_SECTIONS = new Set([',
    'type StoredPayload = {',
    ["'speechStyle'", "'rules'", "'messageRetention'", "'advertising'", "'postSuggestions'"],
  ],
  [
    'apps/api/src/admin/network-settings.service.ts',
    'function assertOperationReader(',
    'function canonical(',
    [
      'const version = payload.readerVersion ?? 1;',
      '!Number.isInteger(version)',
      'version < 1',
      'version > NETWORK_SETTINGS_OPERATION_READER_VERSION',
      '(payload.request.navigationAllowlist && version < 2)',
      '(V3_SECTIONS.has(payload.request.section) && version < 3)',
      'throw new ConflictException(',
    ],
  ],
  [
    'apps/api/src/admin/network-settings.service.ts',
    'private async snapshot(',
    'async read(',
    [
      'rulesRevision: rules?.updatedAt.toISOString() ?? null,',
      'rulesContextDigest: digest(generatedText)',
      'navigationAllowlistWitness: witness,',
      'messageRetentionRevision: policy.revision,',
      'advertisingRevision: policy.revision,',
    ],
  ],
  [
    'apps/api/src/admin/network-settings.service.ts',
    'private async writeOne(',
    'async tick(',
    [
      'currentRecipient.rulesRevision !== recipient.rulesRevision',
      'currentRecipient.messageRetentionRevision !== recipient.messageRetentionRevision',
      'currentRecipient.advertisingRevision !== recipient.advertisingRevision',
      'if (!this.retention || recipient.messageRetentionRevision === undefined) throw changed();',
      'expectedRevision: recipient.messageRetentionRevision,',
      'if (!this.advertising || recipient.advertisingRevision === undefined) throw changed();',
      'revision: recipient.advertisingRevision,',
      'if (recipient.rulesRevision === undefined) throw changed();',
      'validateChatRulesDraft(draft);',
      'authoredKeys: request.changes.some(',
      "(change) => change.path === 'rulesAttachViolationsEnabled',",
      "? ['rulesAttachViolationsEnabled'] : [],",
      'await options.beforeWrite?.(tx);',
      'await writeNetworkChatRulesDraft(tx, recipient.entityId, user.userId, draft, recipient.rulesRevision!,',
      '...request.changes.map((change) => change.path)',
      "...(generate ? ['rules.text', 'rules.textFormat'] : [])",
      '!recipient.rulesContextDigest',
      'currentRecipient.rulesContextDigest !== recipient.rulesContextDigest',
      'if (digest(text) !== recipient.rulesContextDigest) throw changed();',
      'await this.allowlist.assertWitnessInTransaction(tx, recipient.entityId, recipient.navigationAllowlistWitness,',
    ],
  ],
  [
    'apps/api/src/admin/network-settings.service.ts',
    "if (request.entityType === 'chat') { if (request.section === 'messageRetention') {",
    "if (request.section === 'advertising') {",
    [
      'return this.retention.update(',
      'expectedRevision: recipient.messageRetentionRevision, }, options, ).then(() => undefined)',
    ],
  ],
  [
    'apps/api/src/admin/network-settings.service.ts',
    "if (request.section === 'advertising') { if (!this.advertising || recipient.advertisingRevision === undefined) throw changed();",
    "if (request.section === 'rules') {",
    [
      'return this.advertising.update(',
      'revision: recipient.advertisingRevision, }, options, ).then(() => undefined)',
    ],
  ],
  [
    'apps/api/src/admin/network-settings.service.ts',
    "if (request.section === 'rules') { if (recipient.rulesRevision === undefined) throw changed();",
    "if (request.section === 'stopWords')",
    [
      'return this.settings.updateNetworkChatSettings(recipient.entityId, user, next as ChatSettings, { ...options,',
      'beforeWrite: async (tx) => { await options.beforeWrite?.(tx);',
      'await writeNetworkChatRulesDraft(tx,',
    ],
  ],
  [
    'apps/api/src/admin/admin-message-retention.service.ts',
    'async update(',
    'private async authorize(',
    [
      'if (networkWrite?.validateOnly)',
      '(current?.revision ?? 0) !== request.expectedRevision',
      'await this.prisma.$transaction(async (tx) => { await networkWrite?.beforeWrite?.(tx);',
      'SELECT "chat_id" FROM "message_retention_policies" WHERE "chat_id" = ${chatId} FOR UPDATE',
      'current.revision !== request.expectedRevision',
      "code: 'MESSAGE_RETENTION_REVISION_CONFLICT'",
      'await tx.messageRetentionPolicy.update({',
      'revision: { increment: 1 },',
      "action: 'UPDATE_MESSAGE_RETENTION'",
      'await networkWrite?.onCommitted?.(tx, String(current.revision + 1)); });',
    ],
  ],
  [
    'apps/api/src/admin/advertising-placement.service.ts',
    'async update(',
    'async send(',
    [
      'if (networkWrite?.validateOnly)',
      '(current?.revision ?? 0) !== input.revision',
      'await this.prisma.$transaction(async (tx) => { await networkWrite?.beforeWrite?.(tx);',
      'const changed = await tx.advertisingPlacement.updateMany({ where: { chatId, revision: input.revision },',
      'if (!changed.count)',
      "action: 'ADVERTISING_PLACEMENT_SETTINGS'",
      'await networkWrite?.onCommitted?.(tx, String(input.revision + 1)); });',
    ],
  ],
  [
    'apps/api/src/admin/admin-chat-rules.ts',
    'export async function writeNetworkChatRulesDraft(',
    'export async function saveChatRulesDraft(',
    [
      'tx: Prisma.TransactionClient,',
      'expectedRevision: string | null,',
      'const normalized = validateChatRulesDraft(draft);',
      '(current?.updatedAt.toISOString() ?? null) !== expectedRevision',
      "paths.filter((path) => path.startsWith('rules.')).map((path) => path.slice(6))",
      'Object.fromEntries(Object.entries(normalized).filter(([key]) => authored.has(key)))',
      "await advanceChatMutationOrder(tx, chatId, 'RULES');",
      'const saved = await tx.chatRules.updateMany({ where: { chatId, updatedAt: current.updatedAt }, data, });',
      'if (saved.count !== 1) throw new ConflictException(',
      'await tx.chatRules.create({ data: { chatId, ...data } });',
      "await tx.auditLog.create({ data: { chatId, actorUserId, action: 'UPDATE_CHAT_RULES',",
    ],
  ],
]);

export const NETWORK_SETTINGS_V2_RUNTIME_IMPORTS = Object.freeze([
  [
    'packages/contracts/src/network-settings-actions.ts',
    './network-settings-read.js',
    [
      'networkNavigationAllowlistImpactSchema',
      'networkNavigationAllowlistIntentSchema',
      'networkSettingsOperationStatusSchema',
      'networkSettingsReadRequestSchema',
      'networkSettingsRecipientSchema',
      'networkSettingsSectionSchema',
    ],
  ],
]);

const executable = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*(?:\/\/|--).*$/gmu, '')
    .replace(/\s+/gu, '');
const normalizedFragment = (fragment) => fragment.replace(/\s+/gu, '');
const failure = (path, detail = '') =>
  new Error(
    `Rollback target lacks network settings v2+ readers/writers: ${path}${detail ? ` (${detail})` : ''}`,
  );

export function assertNetworkSettingsV2Source(
  commitSha,
  readSource = (path) =>
    execFileSync('git', ['show', `${commitSha}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
) {
  if (!/^[0-9a-f]{40}$/u.test(commitSha ?? '')) throw new Error('Exact source SHA required');
  const sources = new Map();
  const sourceFor = (path) => {
    if (!sources.has(path)) {
      let source;
      try {
        source = readSource(path);
      } catch {
        throw failure(path);
      }
      if (typeof source !== 'string') throw failure(path);
      sources.set(path, executable(source));
    }
    return sources.get(path);
  };
  const requireFragments = (path, source, fragments) => {
    const missing = fragments.find((fragment) => !source.includes(normalizedFragment(fragment)));
    if (missing) throw failure(path, missing);
  };
  const requireScopedFragments = (path, start, end, fragments) => {
    const source = sourceFor(path);
    const first = source.indexOf(normalizedFragment(start));
    const last =
      first < 0
        ? -1
        : source.indexOf(normalizedFragment(end), first + normalizedFragment(start).length);
    if (first < 0 || last < 0) throw failure(path, `Missing boundary: ${start}`);
    requireFragments(path, source.slice(first, last), fragments);
  };
  const requireRuntimeImports = (path, module, names) => {
    const imports = [...sourceFor(path).matchAll(/\bimport\{([^}]*)\}from(['"])([^'"]+)\2/gu)];
    const runtime = imports.find((entry) => entry[3] === module)?.[1].split(',') ?? [];
    const missing = names.find((name) => !runtime.includes(name));
    if (missing) throw failure(path, `Missing runtime import: ${module} ${missing}`);
  };
  for (const [path, fragments] of NETWORK_SETTINGS_V2_SOURCE_CHECKS)
    requireFragments(path, sourceFor(path), fragments);
  for (const check of NETWORK_SETTINGS_V2_SCOPED_CHECKS) requireScopedFragments(...check);
  for (const check of NETWORK_SETTINGS_V2_RUNTIME_IMPORTS) requireRuntimeImports(...check);

  // FLAG: The selective-policy floor is separate. This retained v2/v3 floor must
  // continue accepting a safe pre-policy reader while verifying the real v4 runtime edge.
  const servicePath = 'apps/api/src/admin/network-settings.service.ts';
  const legacyWriter = 'V3_SECTIONS.has(request.section) ? 3 : request.navigationAllowlist ? 2 : 1';
  if (
    sourceFor(servicePath).includes(
      normalizedFragment('export const NETWORK_SETTINGS_OPERATION_READER_VERSION = 3;'),
    )
  ) {
    requireScopedFragments(servicePath, 'async preview(', 'async apply(', [
      `readerVersion: ${legacyWriter}`,
    ]);
  } else {
    const module = '@maxim/contracts/network-settings';
    requireFragments(
      'packages/contracts/src/network-settings-read.ts',
      sourceFor('packages/contracts/src/network-settings-read.ts'),
      ['export const NETWORK_SETTINGS_OPERATION_READER_VERSION = 4;'],
    );
    requireFragments(servicePath, sourceFor(servicePath), [
      `export { NETWORK_SETTINGS_OPERATION_READER_VERSION } from '${module}';`,
    ]);
    requireRuntimeImports(servicePath, module, ['NETWORK_SETTINGS_OPERATION_READER_VERSION']);
    requireScopedFragments(servicePath, 'function assertOperationReader(', 'function canonical(', [
      "(payload.request.changes.some((change) => change.path === 'linkRulesPolicy') && version < 4)",
    ]);
    requireScopedFragments(servicePath, 'async preview(', 'async apply(', [
      `readerVersion: request.changes.some((change) => change.path === 'linkRulesPolicy') ? 4 : ${legacyWriter}`,
    ]);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertNetworkSettingsV2Source(process.argv[2]);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
