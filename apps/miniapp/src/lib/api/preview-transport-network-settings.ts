import {
  networkSettingsReadRequestSchema,
  NETWORK_SETTINGS_ADAPTIVE_PAGE_LIMIT,
  networkSettingsPreviewRequestSchema,
  networkSettingsApplyRequestSchema,
  networkSettingsRequiredSubscriptionResolveRequestSchema,
  networkSettingsAdminContactsReadRequestSchema,
  networkSettingsAdminContactsResolveRequestSchema,
  networkNavigationAllowlistReadRequestSchema,
  type NetworkSettingsReadRequest,
  type NetworkSettingsPreviewRequest,
  type NetworkSettingsOperationResponse,
  type NetworkNavigationAllowlistIntent,
} from '@maxim/contracts/network-settings';
import { managedEntityHeaderSchema } from '@maxim/contracts/managed-entities';
import { settingsSectionPaths } from '../../features/network-settings/field-paths';
import { readSettingsPath, writeSettingsPath } from '../../features/network-settings/field-model';
import { ApiRequestError } from '../api-request-error';
import { PREVIEW_NOT_HANDLED, type PreviewRequestContext } from './preview-transport-runtime';
import type { PreviewState } from './preview-transport-state';
import {
  getPreviewNetworkEntities,
  getPreviewNetworkVersion,
} from './preview-transport-network-state';
type Entry = {
  value: string;
  kind: 'WEB_DOMAIN' | 'WEB_EXACT' | 'MAX_PROFILE' | 'MAX_ENTITY' | 'MINI_APP';
  removeAfterAt: string | null;
};
type Operation = {
  request: NetworkSettingsPreviewRequest;
  hash: string;
  expiresAt: string;
  status: NetworkSettingsOperationResponse['status'];
  processed: number;
  applied: Set<string>;
  lost: boolean;
  impacts?: NonNullable<NetworkSettingsOperationResponse['navigationAllowlistImpacts']>;
};
type Fixture = {
  values: Map<string, object>;
  revisions: Map<string, number>;
  lists: Map<string, Entry[]>;
  listRevisions: Map<string, number>;
  operations: Map<string, Operation>;
  sessions: Map<string, { binding: string; next: number }>;
};
const fixtures = new WeakMap<PreviewState, Fixture>();
function storageKey(state: PreviewState) {
  return (
    'maxim.preview.network-settings.server.v1:' +
    encodeURIComponent(state.me.userId) +
    ':' +
    state.networksScenario
  );
}
function saveFixture(state: PreviewState) {
  if (typeof window === 'undefined') return;
  const f = fixtures.get(state);
  if (!f) return;
  window.sessionStorage.setItem(
    storageKey(state),
    JSON.stringify({
      version: 1,
      revisions: [...f.revisions],
      lists: [...f.lists],
      listRevisions: [...f.listRevisions],
      operations: [...f.operations].map(([id, op]) => [id, { ...op, applied: [...op.applied] }]),
    }),
  );
}
function fixture(state: PreviewState): Fixture {
  let value = fixtures.get(state);
  if (value) return value;
  value = {
    values: new Map(),
    revisions: new Map(),
    lists: new Map(),
    listRevisions: new Map(),
    operations: new Map(),
    sessions: new Map(),
  };
  fixtures.set(state, value);
  if (typeof window !== 'undefined')
    try {
      const stored = JSON.parse(window.sessionStorage.getItem(storageKey(state)) ?? 'null');
      if (stored?.version === 1) {
        value.revisions = new Map(stored.revisions);
        value.lists = new Map(stored.lists);
        value.listRevisions = new Map(stored.listRevisions);
        for (const [id, raw] of stored.operations) {
          const request = networkSettingsPreviewRequestSchema.parse(raw.request);
          if (request.operationId !== id) throw new Error('Wrong preview operation');
          const op: Operation = { ...raw, request, applied: new Set(raw.applied) };
          value.operations.set(id, op);
        }
        // Restore the simulated server state without dispatching an apply request or external action.
        for (const operation of value.operations.values())
          for (const id of operation.applied) {
            const entity = values(
              state,
              operation.request.entityType,
              operation.request.section,
              id,
            );
            for (const change of operation.request.changes)
              writeSettingsPath(
                entity,
                change.path,
                change.op === 'clear' ? undefined : change.value,
                change.op === 'clear',
              );
          }
      }
    } catch {
      window.sessionStorage.removeItem(storageKey(state));
    }
  return value;
}
function canonical(value: unknown): string {
  return Array.isArray(value)
    ? '[' + value.map(canonical).join(',') + ']'
    : value && typeof value === 'object'
      ? '{' +
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, v]) => JSON.stringify(key) + ':' + canonical(v))
          .join(',') +
        '}'
      : JSON.stringify(value);
}
function hash(value: unknown) {
  const text = canonical(value);
  let n = 2166136261;
  for (let i = 0; i < text.length; i++) n = Math.imul(n ^ text.charCodeAt(i), 16777619) >>> 0;
  return n.toString(16).padStart(8, '0').repeat(8);
}
function fail(status: number, message: string, code?: string): never {
  throw new ApiRequestError(status, JSON.stringify({ code }), message);
}
function selection(state: PreviewState, request: NetworkSettingsReadRequest) {
  const rows = getPreviewNetworkEntities(state, request.entityType)
    .filter((row) =>
      request.target.mode === 'selected'
        ? request.target.entityIds.includes(row.id)
        : row.favoriteTypes?.[0] === request.target.favoriteType,
    )
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    rows,
    version:
      request.target.mode === 'category'
        ? getPreviewNetworkVersion(state, request.entityType, request.target.favoriteType)
        : 'preview-selected-' + hash(rows.map((row) => row.id)),
  };
}
function values(state: PreviewState, type: 'chat' | 'channel', section: string, id: string) {
  const store = fixture(state);
  const key =
    type + ':' + (type === 'channel' && section === 'postSignature' ? 'signature:' : '') + id;
  let value = store.values.get(key);
  if (!value) {
    value = structuredClone(
      type === 'chat'
        ? {
            ...state.chatSettings,
            rules: state.chatRules,
            messageRetention: { enabled: false, hours: 48 },
            advertising: { enabled: false },
          }
        : section === 'postSignature'
          ? state.channelPostSignature
          : state.channelSettings,
    );
    const index = getPreviewNetworkEntities(state, type).findIndex((row) => row.id === id);
    if (type === 'chat')
      writeSettingsPath(value, 'linkPolicy', index % 2 ? 'ALLOWLIST_ONLY' : 'ALERT_ONLY');
    if (index % 2 && type === 'channel' && section === 'quickButtons')
      writeSettingsPath(value, 'quickButtonsEnabled', false);
    store.values.set(key, value);
  }
  return value;
}
function list(state: PreviewState, id: string) {
  const store = fixture(state);
  if (!store.lists.has(id))
    store.lists.set(id, [{ kind: 'WEB_DOMAIN', value: 'example.org', removeAfterAt: null }]);
  return store.lists.get(id)!;
}
function witness(state: PreviewState, id: string) {
  return {
    revision: String(fixture(state).listRevisions.get(id) ?? 0),
    observedAt: new Date().toISOString(),
    nextExpiryAt:
      list(state, id)
        .map((row) => row.removeAfterAt)
        .filter((v): v is string => v !== null)
        .sort()[0] ?? null,
  };
}
function impact(state: PreviewState, id: string, intent: NetworkNavigationAllowlistIntent) {
  const before = list(state, id);
  const after = new Map(before.map((row) => [row.kind + ':' + row.value, row]));
  let noops = 0;
  if (intent.mode === 'replace') {
    after.clear();
    for (const entry of intent.entries) after.set(entry.kind + ':' + entry.value, entry);
  } else
    for (const action of intent.actions) {
      const key = action.target.kind + ':' + action.target.value;
      const old = after.get(key);
      if (action.op === 'remove') {
        if (!after.delete(key)) noops++;
      } else {
        if (action.op === 'setExpiry' && !old) fail(409, 'Ссылка отсутствует в одном из списков.');
        const entry = {
          ...action.target,
          removeAfterAt:
            action.removeAfterAt === undefined
              ? (old?.removeAfterAt ?? null)
              : action.removeAfterAt,
        };
        if (old?.removeAfterAt === entry.removeAfterAt) noops++;
        after.set(key, entry);
      }
    }
  const prior = new Map(before.map((row) => [row.kind + ':' + row.value, row]));
  const entries = [...after.values()];
  return {
    entries,
    summary: {
      entityId: id,
      before: before.length,
      after: after.size,
      added: entries.filter((row) => !prior.has(row.kind + ':' + row.value)).length,
      removed: before.filter((row) => !after.has(row.kind + ':' + row.value)).length,
      expiryChanged: entries.filter((row) => {
        const old = prior.get(row.kind + ':' + row.value);
        return old && old.removeAfterAt !== row.removeAfterAt;
      }).length,
      noops,
    },
  };
}
function operationResponse(
  state: PreviewState,
  id: string,
  operation: Operation,
): NetworkSettingsOperationResponse {
  const request = operation.request;
  return {
    operationId: id,
    entityType: request.entityType,
    section: request.section,
    status: operation.status,
    expiresAt: operation.expiresAt,
    ...(request.navigationAllowlist ? { navigationAllowlistImpacts: operation.impacts ?? [] } : {}),
    outcomes: request.recipients.map((row, index) => ({
      entityId: row.entityId,
      status:
        operation.status === 'PREPARED'
          ? 'VALIDATED'
          : operation.status === 'PREVIEWING'
            ? index < operation.processed
              ? 'VALIDATED'
              : 'PENDING'
            : operation.applied.has(row.entityId)
              ? state.networksScenario === 'committed' && operation.status === 'RUNNING'
                ? 'COMMITTED'
                : 'COMPLETE'
              : operation.status === 'PARTIAL'
                ? 'FAILED'
                : 'AUTHORIZED',
      ...(operation.status === 'PARTIAL' && !operation.applied.has(row.entityId)
        ? {
            failureCode: 'CONFLICT',
            failureMessage: 'Настройки этого сообщества изменились. Проверьте их заново.',
          }
        : {}),
    })),
  };
}
export async function handleNetworkSettingsPreviewRequest(context: PreviewRequestContext) {
  const { state, segments, method, init } = context;
  if (segments[0] !== 'networks' || segments[1] !== 'settings') return PREVIEW_NOT_HANDLED;
  if (!state.me.networksEnabled) fail(404, 'Раздел недоступен.');
  const store = fixture(state);
  const body = () => JSON.parse(String(init.body ?? '{}')) as unknown;
  if (segments[2] === 'read' && method === 'POST') {
    const request = networkSettingsReadRequestSchema.parse(body());
    const selected = selection(state, request);
    let offset = 0;
    if (request.cursor) {
      const cursor = JSON.parse(atob(request.cursor)) as {
        version: string;
        offset: number;
        binding: string;
      };
      if (
        cursor.version !== selected.version ||
        cursor.binding !== canonical({ ...request, cursor: undefined }) ||
        !Number.isSafeInteger(cursor.offset) ||
        cursor.offset < 0
      )
        fail(409, 'Состав изменился.');
      offset = cursor.offset;
    }
    const pageSize = context.url.searchParams.get('paging') === 'adaptive' ? NETWORK_SETTINGS_ADAPTIVE_PAGE_LIMIT : 4;
    const rows = selected.rows.slice(offset, offset + pageSize);
    const paths = settingsSectionPaths(request.entityType, request.section);
    const fields = Object.fromEntries(
      paths.map((path) => {
        const v = rows.map(
          (row) =>
            readSettingsPath(values(state, request.entityType, request.section, row.id), path) ??
            null,
        );
        return [
          path,
          v.every((value) => canonical(value) === canonical(v[0]))
            ? { kind: 'common', value: v[0] }
            : { kind: 'mixed' },
        ];
      }),
    );
    const next = offset + rows.length;
    return {
      entityType: request.entityType,
      target: request.target,
      section: request.section,
      compositionVersion: selected.version,
      ...(request.section === 'commercialFilter'
        ? { commercialAiModerationMode: 'DELETE_ONLY' }
        : {}),
      recipients: rows.map((row) => ({
        entityId: row.id,
        title: row.title,
        revision: store.revisions.get(row.id) ?? 1,
        ...(request.section === 'stopWords' ? { stopWordsRevision: 1 } : {}),
        ...(request.section === 'rules'
          ? { rulesRevision: new Date(store.revisions.get(row.id) ?? 1).toISOString() }
          : {}),
        ...(request.section === 'messageRetention'
          ? { messageRetentionRevision: store.revisions.get(row.id) ?? 1 }
          : {}),
        ...(request.section === 'advertising'
          ? { advertisingRevision: store.revisions.get(row.id) ?? 1 }
          : {}),
      })),
      fields,
      recipientCount: selected.rows.length,
      complete: next >= selected.rows.length,
      nextCursor:
        next < selected.rows.length
          ? btoa(
              JSON.stringify({
                version: selected.version,
                offset: next,
                binding: canonical({ ...request, cursor: undefined }),
              }),
            )
          : null,
    };
  }
  if (segments[2] === 'preview' && method === 'POST') {
    const request = networkSettingsPreviewRequestSchema.parse(body());
    const selected = selection(state, request);
    if (
      selected.version !== request.compositionVersion ||
      canonical(selected.rows.map((row) => row.id).sort()) !==
        canonical(request.recipients.map((row) => row.entityId).sort())
    )
      fail(409, 'Состав изменился.', 'NETWORK_SETTINGS_CHANGED');
    for (const recipient of request.recipients) {
      if (recipient.revision !== (store.revisions.get(recipient.entityId) ?? 1))
        fail(409, 'Настройки изменились.', 'NETWORK_SETTINGS_CHANGED');
      if (
        request.navigationAllowlist &&
        recipient.navigationAllowlistWitness?.revision !==
          witness(state, recipient.entityId).revision
      )
        fail(409, 'Список изменился.', 'NETWORK_SETTINGS_CHANGED');
    }
    const key = hash(request);
    let operation = store.operations.get(request.operationId);
    if (operation && operation.hash !== key)
      fail(409, 'Другие изменения операции.', 'NETWORK_SETTINGS_CHANGED');
    if (!operation) {
      operation = {
        request,
        hash: key,
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        status: 'PREVIEWING',
        processed: 0,
        applied: new Set(),
        lost: false,
        ...(request.navigationAllowlist
          ? {
              impacts: request.recipients.map(
                (row) => impact(state, row.entityId, request.navigationAllowlist!).summary,
              ),
            }
          : {}),
      };
      store.operations.set(request.operationId, operation);
      saveFixture(state);
    }
    return {
      operationId: request.operationId,
      previewHash: key,
      expiresAt: operation.expiresAt,
      status: operation.status,
      entityType: request.entityType,
      section: request.section,
      recipients: request.recipients,
      changes: request.changes,
      ...(request.navigationAllowlist
        ? { navigationAllowlist: request.navigationAllowlist, navigationAllowlistImpacts: [] }
        : {}),
    };
  }
  if (segments[2] === 'apply' && method === 'POST') {
    const request = networkSettingsApplyRequestSchema.parse(body());
    const operation = store.operations.get(request.operationId);
    if (!operation) fail(404, 'Операция не найдена.');
    if (operation.hash !== request.previewHash) fail(409, 'Предпросмотр изменился.');
    if (operation.status === 'PREPARED') {
      if (Date.parse(operation.expiresAt) <= Date.now()) fail(409, 'Предпросмотр истёк.');
      const current = selection(state, operation.request);
      if (current.version !== operation.request.compositionVersion) fail(409, 'Состав изменился.');
      for (const recipient of operation.request.recipients)
        if (recipient.revision !== (store.revisions.get(recipient.entityId) ?? 1))
          fail(409, 'Настройки изменились.');
      operation.status = 'RUNNING';
      operation.processed = 0;
      saveFixture(state);
    }
    if (state.networksScenario === 'uncertain' && !operation.lost) {
      operation.lost = true;
      saveFixture(state);
      fail(503, 'Ответ потерян.');
    }
    return operationResponse(state, request.operationId, operation);
  }
  if (segments[2] === 'operations' && segments[3] && method === 'GET') {
    const operation = store.operations.get(segments[3]);
    if (!operation) fail(404, 'Операция не найдена.');
    if (operation.status === 'PREVIEWING') {
      operation.processed = Math.min(operation.processed + 8, operation.request.recipients.length);
      if (operation.processed === operation.request.recipients.length)
        operation.status = 'PREPARED';
    } else if (operation.status === 'RUNNING') {
      for (const recipient of operation.request.recipients.slice(
        operation.processed,
        operation.processed + 8,
      )) {
        if (
          operation.applied.has(recipient.entityId) ||
          (state.networksScenario === 'partial' &&
            recipient.entityId === operation.request.recipients.at(-1)?.entityId)
        )
          continue;
        const value = values(
          state,
          operation.request.entityType,
          operation.request.section,
          recipient.entityId,
        );
        for (const change of operation.request.changes)
          writeSettingsPath(
            value,
            change.path,
            change.op === 'clear' ? undefined : change.value,
            change.op === 'clear',
          );
        if (operation.request.navigationAllowlist) {
          store.lists.set(
            recipient.entityId,
            impact(state, recipient.entityId, operation.request.navigationAllowlist).entries,
          );
          store.listRevisions.set(
            recipient.entityId,
            (store.listRevisions.get(recipient.entityId) ?? 0) + 1,
          );
        }
        store.revisions.set(recipient.entityId, (store.revisions.get(recipient.entityId) ?? 1) + 1);
        operation.applied.add(recipient.entityId);
      }
      operation.processed = Math.min(operation.processed + 8, operation.request.recipients.length);
      if (operation.processed === operation.request.recipients.length) {
        if (state.networksScenario === 'committed' && !operation.lost) operation.lost = true;
        else operation.status = state.networksScenario === 'partial' ? 'PARTIAL' : 'COMPLETE';
      }
    }
    saveFixture(state);
    return operationResponse(state, segments[3], operation);
  }
  if (segments[2] === 'navigation-allowlist' && segments[3] === 'read' && method === 'POST') {
    const request = networkNavigationAllowlistReadRequestSchema.parse(body());
    const selected = selection(state, request);
    if (
      request.compositionVersion !== selected.version ||
      !selected.rows.some((row) => row.id === request.entityId)
    )
      fail(409, 'Состав изменился.');
    const entries = list(state, request.entityId);
    return {
      entityId: request.entityId,
      compositionVersion: selected.version,
      witness: witness(state, request.entityId),
      entries: request.includeEntries === false ? [] : entries,
      totalEntries: entries.length,
      complete: true,
      nextCursor: null,
    };
  }
  if (segments[2] === 'required-subscription' && segments[3] === 'resolve' && method === 'POST') {
    const request = networkSettingsRequiredSubscriptionResolveRequestSchema.parse(body());
    if (selection(state, request).version !== request.compositionVersion)
      fail(409, 'Состав изменился.');
    return {
      requestId: request.requestId,
      compositionVersion: request.compositionVersion,
      channel: managedEntityHeaderSchema.parse({
        id: 'preview-required-' + hash(request.value).slice(0, 8),
        title: 'Канал обязательной подписки',
        entityType: 'channel',
        link: 'https://max.ru/preview_required',
        participantsCount: 1240,
      }),
    };
  }
  if (segments[2] === 'admin-contacts' && method === 'POST') {
    if (segments[3] === 'read') {
      const request = networkSettingsAdminContactsReadRequestSchema.parse(body());
      const selected = selection(state, request);
      if (selected.version !== request.compositionVersion) fail(409, 'Состав изменился.');
      const binding = canonical({ ...request, cursor: undefined });
      const id = request.cursor ?? request.requestId;
      let session = store.sessions.get(id);
      if (session && session.binding !== binding) fail(409, 'Выбор изменился.');
      session ??= { binding, next: 0 };
      store.sessions.set(id, session);
      const sources = selected.rows.slice(session.next, session.next + 2).map((row) => row.id);
      session.next = Math.min(session.next + 2, selected.rows.length);
      return {
        requestId: request.requestId,
        compositionVersion: request.compositionVersion,
        sessionId: id,
        items: sources.length
          ? [
              {
                userId: 'preview-human_bot',
                displayName: 'Анна · администратор',
                url: 'https://max.ru/preview_admin',
                sources,
              },
            ]
          : [],
        scannedSources: session.next,
        totalSources: selected.rows.length,
        incompleteSources: [],
        unavailableSources: [],
        complete: session.next === selected.rows.length,
        nextCursor: session.next < selected.rows.length ? id : null,
      };
    }
    if (segments[3] === 'resolve') {
      const request = networkSettingsAdminContactsResolveRequestSchema.parse(body());
      if (
        selection(state, request).version !== request.compositionVersion ||
        !store.sessions.has(request.cursor)
      )
        fail(409, 'Выбор изменился.');
      return {
        requestId: request.requestId,
        compositionVersion: request.compositionVersion,
        contact: {
          userId: request.userId,
          displayName: 'Анна · администратор',
          url: 'https://max.ru/preview_admin',
          sources: [request.sourceEntityId],
        },
      };
    }
  }
  return PREVIEW_NOT_HANDLED;
}
