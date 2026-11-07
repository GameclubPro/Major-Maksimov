import {
  NetworkNavigationAllowlist,
  normalizeNetworkAllowlistIntent,
} from './network-navigation-allowlist';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';

export function retentionOperationId(operationId: string, entityId: string): string {
  const bytes = createHash('sha256')
    .update(`eraser-policy:v1:${operationId}:${entityId}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
import {
  NETWORK_SETTINGS_OPERATION_READER_VERSION,
  networkSettingsApplyRequestSchema,
  networkNavigationAllowlistReadRequestSchema,
  networkNavigationAllowlistReadResponseSchema,
  type NetworkNavigationAllowlistImpact,
  networkSettingsOperationResponseSchema,
  networkSettingsPreviewRequestSchema,
  networkSettingsPreviewResponseSchema,
  networkSettingsReadRequestSchema,
  networkSettingsReadResponseSchema,
  type NetworkSettingsPreviewRequest,
  type NetworkSettingsPreviewResponse,
  type NetworkSettingsReadRequest,
  type NetworkSettingsRecipient,
} from '@maxim/contracts/network-settings';
import {
  chatRulesSchema,
  type ChannelSettings,
  type ChatSettings,
  type ChatRules,
} from '@maxim/contracts';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { ChatEntityType, Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { ManagedEntityNetworksService } from './managed-entity-networks.service';
import { ManagedEntitiesService } from './managed-entities.service';
import { AdminSettingsService } from './admin-settings.service';
import { AdminStopWordsService } from './admin-stop-words.service';
import { ChannelPostSignatureService } from './channel-post-signature.service';
import {
  buildNetworkSettingsPatch,
  commonNetworkSettingsFields,
  networkSettingsAuthoredKeys,
  networkSettingsPaths,
} from './network-settings-patch';
import type { NetworkSettingsWriteOptions } from './network-settings-write';
import { AdminMessageRetentionService } from './admin-message-retention.service';
import { AdvertisingPlacementService } from './advertising-placement.service';
import {
  mapChatRules,
  validateChatRulesDraft,
  writeNetworkChatRulesDraft,
} from './admin-chat-rules';
import { assertStopWordsStorageEditable } from './stop-words-storage-boundary';

const PREVIEW_TTL_MS = 10 * 60_000;
const LEASE_MS = 5 * 60_000;
const READ_PAGE_SIZE = 4;
const WORK_CHUNK_SIZE = 2;
const ACTIVE_STATUSES = ['PREVIEWING', 'AUTHORIZING', 'RUNNING'];
export { NETWORK_SETTINGS_OPERATION_READER_VERSION } from '@maxim/contracts/network-settings';
const V3_SECTIONS = new Set([
  'speechStyle',
  'rules',
  'messageRetention',
  'advertising',
  'postSuggestions',
]);
type StoredPayload = {
  readerVersion?: number;
  request: NetworkSettingsPreviewRequest;
  expiresAt: string;
  navigationAllowlistImpacts?: NetworkNavigationAllowlistImpact[];
};

function assertOperationReader(payload: StoredPayload): void {
  // FLAG: Unknown persisted readers remain unsettled; never fabricate completion under an incompatible runner.
  const version = payload.readerVersion ?? 1;
  if (
    !Number.isInteger(version) ||
    version < 1 ||
    version > NETWORK_SETTINGS_OPERATION_READER_VERSION ||
    (payload.request.navigationAllowlist && version < 2) ||
    (V3_SECTIONS.has(payload.request.section) && version < 3) ||
    (payload.request.changes.some((change) => change.path === 'linkRulesPolicy') && version < 4)
  )
    throw new ConflictException({
      code: 'NETWORK_SETTINGS_READER_UNSUPPORTED',
      message: 'Операция ожидает совместимую версию обработки.',
    });
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function changed(): ConflictException {
  return new ConflictException({
    code: 'NETWORK_SETTINGS_CHANGED',
    message: 'Состав или настройки изменились. Проверьте изменения заново.',
  });
}
function parse<T>(
  schema: {
    safeParse(
      value: unknown,
    ): { success: true; data: T } | { success: false; error: { format(): unknown } };
  },
  body: unknown,
): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new BadRequestException(parsed.error.format());
  return parsed.data;
}

@Injectable()
export class NetworkSettingsService {
  private readonly logger = new Logger(NetworkSettingsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly networks: ManagedEntityNetworksService,
    private readonly managed: ManagedEntitiesService,
    private readonly settings: AdminSettingsService,
    private readonly stopWords: AdminStopWordsService,
    private readonly signatures: ChannelPostSignatureService,
    private readonly allowlist: NetworkNavigationAllowlist,
    @Optional() private readonly retention?: AdminMessageRetentionService,
    @Optional() private readonly advertising?: AdvertisingPlacementService,
  ) {}

  private async selection(user: AuthUser, request: NetworkSettingsReadRequest) {
    if (request.target.mode === 'category')
      return this.networks.resolveSelection(user, request.entityType, request.target.favoriteType);
    const entityIds = [...request.target.entityIds].sort();
    return { entityIds, compositionVersion: digest({ entityType: request.entityType, entityIds }) };
  }

  private assertSelection(
    request: NetworkSettingsPreviewRequest,
    selection: { entityIds: string[]; compositionVersion: string },
  ) {
    if (
      selection.compositionVersion !== request.compositionVersion ||
      digest([...selection.entityIds].sort()) !==
        digest(request.recipients.map((r) => r.entityId).sort())
    )
      throw changed();
  }

  private async snapshot(user: AuthUser, request: NetworkSettingsReadRequest, entityId: string) {
    await this.managed.assertManagedEntityAdminAccess(entityId, user, request.entityType);
    if (request.entityType === 'chat') {
      const value = await this.settings.getSettings(entityId, user, {
        skipAdminCheck: true,
        skipEntityCheck: true,
      });
      const stop =
        request.section === 'stopWords' ? await this.stopWords.read(entityId, user) : null;
      if (stop) assertStopWordsStorageEditable(stop);
      const row = await this.prisma.chat.findUniqueOrThrow({
        where: { id: entityId },
        select: { title: true, settings: { select: { updatedAt: true } } },
      });
      if (!row.settings || !value.settingsRevision) throw changed();
      if (request.section === 'rules') {
        const rules = await this.prisma.chatRules.findUnique({ where: { chatId: entityId } });
        let generatedText: string | undefined;
        try {
          generatedText = await this.settings.buildNetworkRulesText(entityId, user);
        } catch (error) {
          if (!(error instanceof BadRequestException)) throw error;
        }
        const witness = (await this.allowlist.read(entityId, undefined, false)).witness;
        return {
          value: { ...value, rules: rules ? mapChatRules(rules) : chatRulesSchema.parse({}) },
          recipient: {
            entityId,
            title: row.title,
            revision: value.settingsRevision,
            rulesRevision: rules?.updatedAt.toISOString() ?? null,
            ...(generatedText === undefined ? {} : { rulesContextDigest: digest(generatedText) }),
            navigationAllowlistWitness: witness,
          } satisfies NetworkSettingsRecipient,
        };
      }
      if (request.section === 'messageRetention') {
        if (!this.retention)
          throw new ServiceUnavailableException('Модуль удаления сообщений недоступен.');
        const policy = await this.retention.read(entityId, user);
        return {
          value: { ...value, messageRetention: { enabled: policy.enabled, hours: policy.hours } },
          recipient: {
            entityId,
            title: row.title,
            revision: value.settingsRevision,
            messageRetentionRevision: policy.revision,
          } satisfies NetworkSettingsRecipient,
        };
      }
      if (request.section === 'advertising') {
        if (!this.advertising)
          throw new ServiceUnavailableException('Рекламная площадка недоступна.');
        const policy = await this.advertising.state(entityId, user);
        return {
          value: { ...value, advertising: { enabled: policy.enabled } },
          recipient: {
            entityId,
            title: row.title,
            revision: value.settingsRevision,
            advertisingRevision: policy.revision,
          } satisfies NetworkSettingsRecipient,
        };
      }
      return {
        value: stop ? { ...value, stopWordsPolicy: stop.policy } : value,
        recipient: {
          entityId,
          title: row.title,
          revision: stop ? row.settings.updatedAt.toISOString() : value.settingsRevision,
          ...(stop ? { stopWordsRevision: stop.revision } : {}),
        } satisfies NetworkSettingsRecipient,
      };
    }
    const settings = await this.settings.getChannelSettings(entityId, user, {
      skipAdminCheck: true,
      skipEntityCheck: true,
    });
    const value =
      request.section === 'postSignature' ? await this.signatures.getSettings(entityId) : settings;
    const row = await this.prisma.chat.findUniqueOrThrow({
      where: { id: entityId },
      select: { title: true },
    });
    if (value.revision === undefined) throw changed();
    return {
      value,
      recipient: {
        entityId,
        title: row.title,
        revision: value.revision,
      } satisfies NetworkSettingsRecipient,
    };
  }

  async read(user: AuthUser, body: unknown) {
    const request = parse(networkSettingsReadRequestSchema, body);
    const paths = networkSettingsPaths(request.entityType, request.section);
    const selection = await this.selection(user, request);
    const binding = digest({
      actor: user.userId,
      entityType: request.entityType,
      target: request.target,
      section: request.section,
    });
    let offset = 0;
    if (request.cursor) {
      try {
        const cursor = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8')) as {
          binding?: unknown;
          version?: unknown;
          offset?: unknown;
        };
        if (
          cursor.binding !== binding ||
          !Number.isSafeInteger(cursor.offset) ||
          (cursor.offset as number) < 0
        )
          throw new Error('cursor');
        if (cursor.version !== selection.compositionVersion) throw changed();
        offset = cursor.offset as number;
        if (offset > selection.entityIds.length) throw new Error('cursor');
      } catch (error) {
        if (error instanceof ConflictException) throw error;
        throw new BadRequestException('Недействительный курсор настроек.');
      }
    }
    const snapshots = [];
    // FLAG: Every page binds to the complete server category; loading pages never truncates the
    // target category. Clients must finish all pages before treating values as network-wide.
    for (const entityId of selection.entityIds.slice(offset, offset + READ_PAGE_SIZE))
      snapshots.push(await this.snapshot(user, request, entityId));
    const nextOffset = offset + snapshots.length;
    const complete = nextOffset >= selection.entityIds.length;
    return networkSettingsReadResponseSchema.parse({
      ...(request.section === 'commercialFilter'
        ? { commercialAiModerationMode: this.settings.commercialAiModerationMode() }
        : {}),
      entityType: request.entityType,
      target: request.target,
      section: request.section,
      compositionVersion: selection.compositionVersion,
      recipientCount: selection.entityIds.length,
      complete,
      nextCursor: complete
        ? null
        : Buffer.from(
            JSON.stringify({ binding, version: selection.compositionVersion, offset: nextOffset }),
          ).toString('base64url'),
      recipients: snapshots.map((snapshot) => snapshot.recipient),
      fields: snapshots.length
        ? commonNetworkSettingsFields(
            paths,
            snapshots.map((snapshot) => snapshot.value),
          )
        : {},
    });
  }

  async readNavigationAllowlist(user: AuthUser, body: unknown) {
    const request = parse(networkNavigationAllowlistReadRequestSchema, body);
    if (request.entityType !== 'chat' || request.section !== 'links')
      throw new BadRequestException('Список доступен только в настройках ссылок чатов.');
    const selected = await this.selection(user, request);
    if (
      selected.compositionVersion !== request.compositionVersion ||
      !selected.entityIds.includes(request.entityId)
    )
      throw changed();
    await this.managed.assertManagedEntityAdminAccess(request.entityId, user, 'chat');
    const result = await this.allowlist.read(
      request.entityId,
      request.cursor,
      request.includeEntries ?? true,
    );
    const current = await this.selection(user, request);
    if (current.compositionVersion !== request.compositionVersion) throw changed();
    return networkNavigationAllowlistReadResponseSchema.parse({
      ...result,
      compositionVersion: request.compositionVersion,
    });
  }

  async preview(user: AuthUser, body: unknown): Promise<NetworkSettingsPreviewResponse> {
    const request = parse(networkSettingsPreviewRequestSchema, body);
    if (
      request.navigationAllowlist &&
      request.changes.some((change) => change.path === 'linkRulesPolicy')
    ) {
      throw new BadRequestException(
        'Выберите правила ссылок или изменение старого списка отдельным действием.',
      );
    }
    if (request.navigationAllowlist)
      request.navigationAllowlist = normalizeNetworkAllowlistIntent(request.navigationAllowlist);
    const requestHash = digest(request);
    let existing = await this.prisma.networkSettingsOperation.findUnique({
      where: { id: request.operationId },
    });
    if (!existing) {
      // FLAG: Accepted operations retain their exact payload/hash after an authored field is retired.
      const allowed = networkSettingsPaths(request.entityType, request.section);
      if (request.changes.some((change) => !allowed.includes(change.path)))
        throw new BadRequestException('Поле не входит в выбранный раздел.');
      this.assertSelection(request, await this.selection(user, request));
      const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS).toISOString();
      try {
        existing = await this.prisma.networkSettingsOperation.create({
          data: {
            id: request.operationId,
            actorUserId: user.userId,
            entityType:
              request.entityType === 'chat' ? ChatEntityType.CHAT : ChatEntityType.CHANNEL,
            requestHash,
            section: request.section,
            status: 'PREVIEWING',
            payload: {
              readerVersion: request.changes.some((change) => change.path === 'linkRulesPolicy')
                ? 4
                : V3_SECTIONS.has(request.section)
                  ? 3
                  : request.navigationAllowlist
                    ? 2
                    : 1,
              request,
              expiresAt,
            } as unknown as Prisma.InputJsonValue,
            targets: {
              create: request.recipients.map((recipient) => ({
                entityId: recipient.entityId,
                revision: String(recipient.revision),
                stopWordsRevision: recipient.stopWordsRevision,
                status: 'PENDING',
              })),
            },
          },
        });
      } catch (error) {
        if ((error as { code?: string }).code === 'P2002') return this.preview(user, body);
        throw error;
      }
    }
    if (existing.actorUserId !== user.userId || existing.requestHash !== requestHash)
      throw changed();
    return networkSettingsPreviewResponseSchema.parse({
      operationId: existing.id,
      previewHash: requestHash,
      expiresAt: (existing.payload as unknown as StoredPayload).expiresAt,
      status: existing.status,
      entityType: request.entityType,
      section: request.section,
      recipients: request.recipients,
      changes: request.changes,
      ...(request.navigationAllowlist
        ? {
            navigationAllowlist: request.navigationAllowlist,
            navigationAllowlistImpacts:
              (existing.payload as unknown as StoredPayload).navigationAllowlistImpacts ?? [],
          }
        : {}),
    });
  }

  async apply(user: AuthUser, body: unknown) {
    const input = parse(networkSettingsApplyRequestSchema, body);
    const operation = await this.ownedOperation(user, input.operationId);
    assertOperationReader(operation.payload as unknown as StoredPayload);
    if (operation.requestHash !== input.previewHash) throw changed();
    if (operation.status === 'PREVIEWING')
      throw new ConflictException('Проверка получателей ещё выполняется.');
    if (operation.status === 'PREPARED') {
      const stored = operation.payload as unknown as StoredPayload;
      assertOperationReader(stored);
      if (Date.parse(stored.expiresAt) <= Date.now()) throw changed();
      const request = networkSettingsPreviewRequestSchema.parse(stored.request);
      const confirm = async (
        tx: Prisma.TransactionClient,
        selection: { entityIds: string[]; compositionVersion: string },
      ) => {
        if (Date.parse(stored.expiresAt) <= Date.now()) throw changed();
        this.assertSelection(request, selection);
        await tx.networkSettingsOperation.updateMany({
          where: { id: operation.id, status: 'PREPARED' },
          data: { status: 'AUTHORIZING' },
        });
      };
      // FLAG: Category composition is checked under the same lock as all favorites writers,
      // and the exact frozen operation is confirmed before releasing that lock.
      if (request.target.mode === 'category')
        await this.networks.withLockedSelection(
          user,
          request.entityType,
          request.target.favoriteType,
          confirm,
        );
      else {
        const selection = await this.selection(user, request);
        await this.prisma.$transaction((tx) => confirm(tx, selection));
      }
    }
    return this.status(user, operation.id);
  }

  private async ownedOperation(user: AuthUser, operationId: string) {
    const operation = await this.prisma.networkSettingsOperation.findUnique({
      where: { id: operationId },
    });
    if (!operation || operation.actorUserId !== user.userId)
      throw new NotFoundException('Операция не найдена.');
    return operation;
  }

  async status(user: AuthUser, operationId: string) {
    const operation = await this.ownedOperation(user, operationId);
    const targets = await this.prisma.networkSettingsOperationTarget.findMany({
      where: { operationId },
      orderBy: { entityId: 'asc' },
    });
    return networkSettingsOperationResponseSchema.parse({
      operationId,
      entityType: operation.entityType === ChatEntityType.CHAT ? 'chat' : 'channel',
      section: operation.section,
      status: operation.status,
      expiresAt: (operation.payload as unknown as StoredPayload).expiresAt,
      ...((operation.payload as unknown as StoredPayload).navigationAllowlistImpacts
        ? {
            navigationAllowlistImpacts: (operation.payload as unknown as StoredPayload)
              .navigationAllowlistImpacts,
          }
        : {}),
      outcomes: targets.map((target) => ({
        entityId: target.entityId,
        status: target.status,
        ...(target.failureCode ? { failureCode: target.failureCode } : {}),
        ...(target.failureMessage ? { failureMessage: target.failureMessage } : {}),
      })),
    });
  }

  private async writeOne(
    user: AuthUser,
    request: NetworkSettingsPreviewRequest,
    recipient: NetworkSettingsRecipient,
    options: NetworkSettingsWriteOptions,
  ) {
    const eraserOperationId = retentionOperationId(request.operationId, recipient.entityId);
    if (
      request.entityType === 'chat' &&
      request.section === 'messageRetention' &&
      !options.validateOnly &&
      this.retention
    ) {
      // FLAG: Resume the exact durable remote request before comparing a changed remote revision.
      // The previous response may have been lost after Lastik committed it.
      const resumed = await this.retention.resumeEraserOperation(
        recipient.entityId,
        user,
        eraserOperationId,
        options,
      );
      if (resumed) return;
    }
    const snapshot = await this.snapshot(user, request, recipient.entityId);
    const currentRecipient: NetworkSettingsRecipient = snapshot.recipient;
    if (
      currentRecipient.revision !== recipient.revision ||
      currentRecipient.stopWordsRevision !== recipient.stopWordsRevision ||
      currentRecipient.rulesRevision !== recipient.rulesRevision ||
      currentRecipient.messageRetentionRevision !== recipient.messageRetentionRevision ||
      currentRecipient.advertisingRevision !== recipient.advertisingRevision
    )
      throw changed();
    let impact: NetworkNavigationAllowlistImpact | undefined;
    if (request.navigationAllowlist) {
      if (!recipient.navigationAllowlistWitness) throw changed();
      impact = await this.allowlist.validate(
        recipient.entityId,
        request.navigationAllowlist,
        recipient.navigationAllowlistWitness,
        user.userId,
      );
      if (!request.changes.length) {
        if (options.validateOnly) return impact;
        return this.allowlist.commitOnly(
          recipient.entityId,
          recipient,
          request.navigationAllowlist,
          user.userId,
          options,
        );
      }
    }
    const next = buildNetworkSettingsPatch(
      snapshot.value,
      request.entityType,
      request.section,
      request.changes,
    );
    if (request.entityType === 'chat') {
      if (request.section === 'messageRetention') {
        if (!this.retention || recipient.messageRetentionRevision === undefined) throw changed();
        return this.retention
          .update(
            recipient.entityId,
            user,
            {
              ...(next as unknown as { messageRetention: object }).messageRetention,
              operationId: eraserOperationId,
              expectedRevision: recipient.messageRetentionRevision,
            },
            options,
          )
          .then(() => undefined);
      }
      if (request.section === 'advertising') {
        if (!this.advertising || recipient.advertisingRevision === undefined) throw changed();
        return this.advertising
          .update(
            recipient.entityId,
            user,
            {
              ...(next as unknown as { advertising: object }).advertising,
              revision: recipient.advertisingRevision,
            },
            options,
          )
          .then(() => undefined);
      }
      if (request.section === 'rules') {
        if (recipient.rulesRevision === undefined) throw changed();
        let draft = (next as unknown as { rules: ChatRules }).rules;
        const generate = request.changes.some(
          (change) =>
            change.path === 'rules.autoTextEnabled' && change.op === 'set' && change.value === true,
        );
        if (generate) {
          if (
            !recipient.rulesContextDigest ||
            currentRecipient.rulesContextDigest !== recipient.rulesContextDigest
          )
            throw changed();
          const text = await this.settings.buildNetworkRulesText(recipient.entityId, user);
          if (digest(text) !== recipient.rulesContextDigest) throw changed();
          draft = { ...draft, text, textFormat: 'plain' };
        }
        validateChatRulesDraft(draft);
        return this.settings
          .updateNetworkChatSettings(recipient.entityId, user, next as ChatSettings, {
            ...options,
            authoredKeys: request.changes.some(
              (change) => change.path === 'rulesAttachViolationsEnabled',
            )
              ? ['rulesAttachViolationsEnabled']
              : [],
            beforeWrite: async (tx) => {
              await options.beforeWrite?.(tx);
              if (generate) {
                if (!recipient.navigationAllowlistWitness) throw changed();
                await this.allowlist.assertWitnessInTransaction(
                  tx,
                  recipient.entityId,
                  recipient.navigationAllowlistWitness,
                );
              }
              await writeNetworkChatRulesDraft(
                tx,
                recipient.entityId,
                user.userId,
                draft,
                recipient.rulesRevision!,
                [
                  ...request.changes.map((change) => change.path),
                  ...(generate ? ['rules.text', 'rules.textFormat'] : []),
                ],
              );
            },
          })
          .then(() => undefined);
      }
      if (request.section === 'stopWords')
        return this.stopWords.updateNetworkSettings(
          recipient.entityId,
          user,
          (next as ChatSettings).stopWordsPolicy!,
          recipient.stopWordsRevision!,
          String(recipient.revision),
          options,
        );
      await this.settings.updateNetworkChatSettings(
        recipient.entityId,
        user,
        next as ChatSettings,
        {
          ...options,
          authoredKeys: networkSettingsAuthoredKeys(request.changes),
          ...(request.navigationAllowlist && !options.validateOnly
            ? {
                beforeWrite: async (tx: Prisma.TransactionClient) => {
                  impact = await this.allowlist.planInTransaction(
                    tx,
                    recipient.entityId,
                    request.navigationAllowlist!,
                    recipient.navigationAllowlistWitness!,
                    user.userId,
                    false,
                  );
                },
              }
            : {}),
        },
      );
      return impact;
    }
    if (request.section === 'postSignature')
      return this.signatures.updateSettings(
        recipient.entityId,
        user.userId,
        {
          ...Object.fromEntries(
            request.changes.map((change) => [
              change.path,
              'value' in change ? change.value : undefined,
            ]),
          ),
          expectedRevision: recipient.revision,
        },
        options,
      );
    if (
      (request.section === 'comments' && (next as ChannelSettings).commentsEnabled) ||
      (request.section === 'quickButtons' && (next as ChannelSettings).quickButtonsEnabled)
    )
      await this.signatures.assertNetworkSettingsEditingAccess(recipient.entityId);
    return this.settings.updateNetworkChannelSettings(
      recipient.entityId,
      user,
      next as ChannelSettings,
      request.changes.map((change) => change.path),
      options,
    );
  }

  async tick(limit = 2): Promise<boolean> {
    // FLAG: Only durable target/stage advancement requests an early scheduling pass.
    // Lease renewal and retry metadata alone must retain the runner's idle backoff.
    const operations = await this.prisma.networkSettingsOperation.findMany({
      where: {
        status: { in: ACTIVE_STATUSES },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: Math.max(1, Math.min(limit, 4)),
      select: { id: true },
    });
    let progressed = false;
    for (const operation of operations) {
      try {
        if (await this.runOperation(operation.id)) progressed = true;
      } catch (error) {
        this.logger.warn(
          {
            operationId: operation.id,
            error: error instanceof Error ? error.message : String(error),
          },
          'Network settings operation awaits durable retry',
        );
      }
    }
    return progressed;
  }

  private async withLease(
    operationId: string,
    leaseToken: string,
    status: string,
    work: (tx: Prisma.TransactionClient) => Promise<void>,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const owned = await tx.networkSettingsOperation.updateMany({
        where: { id: operationId, leaseToken, status, leaseUntil: { gt: new Date() } },
        data: { leaseUntil: new Date(Date.now() + LEASE_MS) },
      });
      if (!owned.count) throw changed();
      await work(tx);
    });
  }

  private async runOperation(operationId: string): Promise<boolean> {
    const leaseToken = randomUUID();
    const claimed = await this.prisma.networkSettingsOperation.updateMany({
      where: {
        id: operationId,
        status: { in: ACTIVE_STATUSES },
        OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }],
      },
      data: { leaseToken, leaseUntil: new Date(Date.now() + LEASE_MS) },
    });
    if (!claimed.count) return false;
    let progressed = false;
    try {
      const operation = await this.prisma.networkSettingsOperation.findUniqueOrThrow({
        where: { id: operationId },
      });
      const stored = operation.payload as unknown as StoredPayload;
      assertOperationReader(stored);
      const request = networkSettingsPreviewRequestSchema.parse(stored.request);
      const user: AuthUser = { userId: operation.actorUserId, username: null, displayName: null };
      const preflight = operation.status !== 'RUNNING';
      const from =
        operation.status === 'PREVIEWING'
          ? 'PENDING'
          : operation.status === 'AUTHORIZING'
            ? 'VALIDATED'
            : 'AUTHORIZED';
      const targets = await this.prisma.networkSettingsOperationTarget.findMany({
        where: { operationId, status: { in: preflight ? [from] : ['AUTHORIZED', 'COMMITTED'] } },
        orderBy: [{ updatedAt: 'asc' }, { entityId: 'asc' }],
        take: WORK_CHUNK_SIZE,
      });
      for (const target of targets) {
        const renewed = await this.prisma.networkSettingsOperation.updateMany({
          where: {
            id: operationId,
            leaseToken,
            status: operation.status,
            leaseUntil: { gt: new Date() },
          },
          data: { leaseUntil: new Date(Date.now() + LEASE_MS) },
        });
        if (!renewed.count) return progressed;
        if (target.status !== 'COMMITTED') {
          const recipient = request.recipients.find((item) => item.entityId === target.entityId)!;
          try {
            const impact = await this.writeOne(
              user,
              request,
              recipient,
              preflight
                ? { validateOnly: true }
                : {
                    deferFollowup: true,
                    beforeWrite: async (tx) => {
                      const owned = await tx.networkSettingsOperation.updateMany({
                        where: {
                          id: operationId,
                          leaseToken,
                          status: 'RUNNING',
                          leaseUntil: { gt: new Date() },
                        },
                        data: { leaseUntil: new Date(Date.now() + LEASE_MS) },
                      });
                      if (!owned.count) throw changed();
                      const writable = await tx.networkSettingsOperationTarget.findUnique({
                        where: { operationId_entityId: { operationId, entityId: target.entityId } },
                        select: { status: true },
                      });
                      if (writable?.status !== 'AUTHORIZED') throw changed();
                    },
                    onCommitted: async (tx, revision) => {
                      // FLAG: Settings and their durable receipt commit together. A stale lease owner
                      // cannot commit either; recovery resumes COMMITTED followups without another write.
                      const owned = await tx.networkSettingsOperation.updateMany({
                        where: {
                          id: operationId,
                          leaseToken,
                          status: 'RUNNING',
                          leaseUntil: { gt: new Date() },
                        },
                        data: { leaseUntil: new Date(Date.now() + LEASE_MS) },
                      });
                      if (!owned.count) throw changed();
                      const recorded = await tx.networkSettingsOperationTarget.updateMany({
                        where: { operationId, entityId: target.entityId, status: 'AUTHORIZED' },
                        data: { status: 'COMMITTED', committedRevision: revision },
                      });
                      if (!recorded.count) throw changed();
                    },
                  },
            );
            if (preflight)
              await this.withLease(operationId, leaseToken, operation.status, async (tx) => {
                if (
                  request.navigationAllowlist &&
                  operation.status === 'PREVIEWING' &&
                  impact &&
                  'entityId' in impact
                ) {
                  const current = await tx.networkSettingsOperation.findUniqueOrThrow({
                    where: { id: operationId },
                  });
                  const payload = current.payload as unknown as StoredPayload;
                  const impacts = [
                    ...(payload.navigationAllowlistImpacts ?? []).filter(
                      (row) => row.entityId !== target.entityId,
                    ),
                    impact as NetworkNavigationAllowlistImpact,
                  ];
                  await tx.networkSettingsOperation.update({
                    where: { id: operationId },
                    data: {
                      payload: {
                        ...payload,
                        navigationAllowlistImpacts: impacts,
                      } as unknown as Prisma.InputJsonValue,
                    },
                  });
                }
                await tx.networkSettingsOperationTarget.updateMany({
                  where: { operationId, entityId: target.entityId, status: from },
                  data: { status: operation.status === 'PREVIEWING' ? 'VALIDATED' : 'AUTHORIZED' },
                });
              });
            progressed = true;
          } catch (error) {
            const status = error instanceof HttpException ? error.getStatus() : 503;
            if (!preflight && request.section === 'messageRetention' && status >= 500) {
              // FLAG: A lost remote response is still pending, never FAILED or completed.
              // Durable request identity lets the next lease reconcile the same operation.
              await this.withLease(operationId, leaseToken, operation.status, async (tx) => {
                await tx.networkSettingsOperationTarget.updateMany({
                  where: { operationId, entityId: target.entityId, status: 'AUTHORIZED' },
                  data: {
                    failureCode: 'TRANSIENT',
                    failureMessage:
                      'Ответ Ластика ожидается. Состояние будет проверено автоматически.',
                  },
                });
              });
              continue;
            }
            const failureCode = [401, 403].includes(status)
              ? 'DENIED'
              : [409, 412, 428].includes(status)
                ? 'CONFLICT'
                : [400, 422].includes(status)
                  ? 'INVALID'
                  : 'TRANSIENT';
            await this.withLease(operationId, leaseToken, operation.status, async (tx) => {
              if (preflight) {
                // FLAG: Preflight may settle only proven-unwritten targets. Committed receipts
                // and unknown states keep the operation unsettled for compatible recovery.
                const uncertain = await tx.networkSettingsOperationTarget.count({
                  where: {
                    operationId,
                    OR: [
                      { status: { notIn: ['PENDING', 'VALIDATED', 'AUTHORIZED', 'FAILED'] } },
                      { committedRevision: { not: null } },
                    ],
                  },
                });
                if (uncertain) throw changed();
              }
              await tx.networkSettingsOperationTarget.updateMany({
                where: { operationId, entityId: target.entityId, status: from },
                data: {
                  status: 'FAILED',
                  failureCode,
                  failureMessage:
                    'Настройки не применены. Обновите экран и проверьте доступ и значения.',
                },
              });
              if (preflight) {
                await tx.networkSettingsOperationTarget.updateMany({
                  where: { operationId, status: { in: ['PENDING', 'VALIDATED', 'AUTHORIZED'] } },
                  data: {
                    status: 'FAILED',
                    failureCode: 'PREFLIGHT_ABORTED',
                    failureMessage:
                      'Проверка сетки остановлена. Настройки не изменены; проверьте сетку заново.',
                  },
                });
                await tx.networkSettingsOperation.update({
                  where: { id: operationId },
                  data: { status: 'FAILED' },
                });
              }
            });
            progressed = true;
            if (preflight) return progressed;
          }
        }
        if (!preflight) {
          const committed = await this.prisma.networkSettingsOperationTarget.findUniqueOrThrow({
            where: { operationId_entityId: { operationId, entityId: target.entityId } },
          });
          if (committed.status === 'COMMITTED') {
            let complete = false;
            try {
              await this.settings.finishNetworkSettingsFollowup(
                target.entityId,
                request.entityType,
                request.section,
              );
              complete = true;
            } catch {
              // FLAG: Keep committed receipts retryable and rotate their retry timestamp so a
              // failing cache/readiness followup cannot starve the remaining frozen recipients.
            }
            await this.withLease(operationId, leaseToken, operation.status, async (tx) => {
              await tx.networkSettingsOperationTarget.updateMany({
                where: { operationId, entityId: target.entityId, status: 'COMMITTED' },
                data: complete
                  ? { status: 'COMPLETE', failureCode: null, failureMessage: null }
                  : {
                      failureCode: 'TRANSIENT',
                      failureMessage:
                        'Настройки сохранены. Обновление состояния повторится автоматически.',
                    },
              });
            });
            if (complete) progressed = true;
          }
        }
      }
      const unfinished = await this.prisma.networkSettingsOperationTarget.count({
        where: { operationId, status: { in: preflight ? [from] : ['AUTHORIZED', 'COMMITTED'] } },
      });
      if (!unfinished) {
        await this.withLease(operationId, leaseToken, operation.status, async (tx) => {
          if (preflight) {
            const expiresAt =
              operation.status === 'PREVIEWING'
                ? new Date(Date.now() + PREVIEW_TTL_MS).toISOString()
                : stored.expiresAt;
            await tx.networkSettingsOperation.update({
              where: { id: operationId },
              data: {
                status: operation.status === 'PREVIEWING' ? 'PREPARED' : 'RUNNING',
                payload: {
                  ...((
                    await tx.networkSettingsOperation.findUniqueOrThrow({
                      where: { id: operationId },
                    })
                  ).payload as unknown as StoredPayload),
                  request,
                  expiresAt,
                } as unknown as Prisma.InputJsonValue,
              },
            });
          } else {
            const failed = await tx.networkSettingsOperationTarget.count({
              where: { operationId, status: 'FAILED' },
            });
            const complete = await tx.networkSettingsOperationTarget.count({
              where: { operationId, status: 'COMPLETE' },
            });
            await tx.networkSettingsOperation.update({
              where: { id: operationId },
              data: { status: failed ? (complete ? 'PARTIAL' : 'FAILED') : 'COMPLETE' },
            });
          }
        });
        progressed = true;
      }
    } finally {
      await this.prisma.networkSettingsOperation.updateMany({
        where: { id: operationId, leaseToken },
        data: { leaseUntil: null, leaseToken: null },
      });
    }
    return progressed;
  }
}
