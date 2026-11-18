import { NETWORK_SETTINGS_ADAPTIVE_PAGE_LIMIT } from '@maxim/contracts/network-settings-read';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  NetworkSettingsChange,
  NetworkSettingsField,
  NetworkSettingsOperationResponse,
  NetworkSettingsPreviewResponse,
  NetworkSettingsReadRequest,
  NetworkSettingsReadResponse,
  NetworkNavigationAllowlistIntent,
} from '@maxim/contracts/network-settings';
import type { ApiTransport } from '../../lib/api/transport';
import {
  getNetworkSettingsOperation,
  readNetworkSettingsPage,
} from '../../lib/api/network-settings-client';
import {
  listNetworkSettingsOperationReceipts,
  persistNetworkSettingsOperationReceipt,
  removeNetworkSettingsOperationReceipt,
  mergeNetworkSettingsReceipt,
  mergeNetworkSettingsOperationStatus,
  type NetworkSettingsOperationReceipt,
} from '../../lib/network-settings-operation-storage';
import type { NetworkSettingsEditorScope } from '../../lib/network-settings-workspace-state';
import { parseSettingsField, settingsSectionPaths } from './field-registry';
import {
  NetworkSettingsPreviewConflict,
  assertOperationIdentity,
  canonicalNetworkValue,
} from './network-settings-operation-state';
import type { NetworkSettingsOperationPort } from './network-settings-operation-runtime';
export { canonicalNetworkValue } from './network-settings-operation-state';

type NetworkSettingsOperationRuntime = typeof import('./network-settings-operation-runtime');
export async function withNetworkSettingsOperationRuntime(
  isCurrent: () => boolean,
  run: (runtime: NetworkSettingsOperationRuntime) => Promise<void>,
  load: () => Promise<NetworkSettingsOperationRuntime> = () =>
    import('./network-settings-operation-runtime'),
): Promise<void> {
  const runtime = await load();
  // FLAG: A delayed code load cannot authorize storage or requests for an obsolete editor draft.
  if (!isCurrent()) return;
  await run(runtime);
}

function targetKey(target: NetworkSettingsReadRequest['target']) {
  return canonicalNetworkValue(
    target.mode === 'selected' ? { ...target, entityIds: [...target.entityIds].sort() } : target,
  );
}
export async function readCompleteNetworkSettings(
  api: ApiTransport,
  input: Omit<NetworkSettingsReadRequest, 'cursor'>,
  onProgress?: (loaded: number, total: number) => void,
  signal?: AbortSignal,
): Promise<NetworkSettingsReadResponse> {
  const paths = settingsSectionPaths(input.entityType, input.section);
  const expected = new Set(paths);
  const ids = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let folded: Record<string, NetworkSettingsField> | undefined;
  let first: NetworkSettingsReadResponse | undefined;
  const recipients: NetworkSettingsReadResponse['recipients'] = [];
  do {
    signal?.throwIfAborted();
    const page = await readNetworkSettingsPage(
      api,
      { ...input, ...(cursor ? { cursor } : {}) },
      signal,
    );
    signal?.throwIfAborted();
    if (
      page.entityType !== input.entityType ||
      page.section !== input.section ||
      targetKey(page.target) !== targetKey(input.target) ||
      page.recipients.length > NETWORK_SETTINGS_ADAPTIVE_PAGE_LIMIT ||
      !page.compositionVersion
    )
      throw new Error('Получен другой состав настроек.');
    if (
      first &&
      (page.compositionVersion !== first.compositionVersion ||
        page.recipientCount !== first.recipientCount)
    )
      throw new Error('Состав сетки изменился. Загрузите его заново.');
    first ??= page;
    if (page.recipients.length === 0 && page.recipientCount !== 0)
      throw new Error('Страница настроек не завершена.');
    for (const recipient of page.recipients) {
      if (ids.has(recipient.entityId)) throw new Error('Получатели повторяются.');
      ids.add(recipient.entityId);
      recipients.push(recipient);
    }
    if (page.recipients.length) {
      if (
        Object.keys(page.fields).length !== expected.size ||
        Object.keys(page.fields).some((p) => !expected.has(p))
      )
        throw new Error('Неполный набор полей настроек.');
      const validated = Object.fromEntries(
        paths.map((path) => {
          const field = page.fields[path];
          if (!field) throw new Error('Поле настроек отсутствует.');
          return [
            path,
            field.kind === 'common'
              ? {
                  kind: 'common' as const,
                  value: parseSettingsField(input.entityType, input.section, path, field.value),
                }
              : { kind: 'mixed' as const },
          ];
        }),
      );
      folded = folded
        ? Object.fromEntries(
            paths.map((path) => {
              const a = folded![path],
                b = validated[path];
              return [
                path,
                a.kind === 'common' &&
                b.kind === 'common' &&
                canonicalNetworkValue(a.value) === canonicalNetworkValue(b.value)
                  ? a
                  : { kind: 'mixed' },
              ];
            }),
          )
        : validated;
    }
    if (ids.size > page.recipientCount || page.complete !== (page.nextCursor === null))
      throw new Error('Неверная граница страниц настроек.');
    onProgress?.(ids.size, page.recipientCount);
    if (page.complete) {
      if (ids.size !== page.recipientCount) throw new Error('Загружены не все получатели.');
      break;
    }
    if (!page.nextCursor || cursors.has(page.nextCursor) || !page.recipients.length)
      throw new Error('Повтор страницы настроек.');
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor);
  return { ...first!, recipients, fields: folded ?? {}, complete: true, nextCursor: null };
}
export function mergeNetworkSettingsOperation(
  previous: NetworkSettingsOperationResponse | null,
  next: NetworkSettingsOperationResponse,
): NetworkSettingsOperationResponse {
  if (!previous) return next;
  if (previous.operationId !== next.operationId) return previous;
  assertOperationIdentity(
    next,
    previous.operationId,
    previous.entityType,
    previous.section,
    previous.outcomes.map((row) => row.entityId),
  );
  if (
    (terminal(previous.status) && previous.status !== next.status) ||
    mergeNetworkSettingsOperationStatus(previous.status, next.status) !== next.status
  )
    return previous;
  const outcomeRank = {
    PENDING: 0,
    VALIDATED: 1,
    AUTHORIZED: 2,
    COMMITTED: 3,
    COMPLETE: 4,
    FAILED: 4,
  } as const;
  return {
    ...next,
    outcomes: next.outcomes.map((row) => {
      const old = previous.outcomes.find((item) => item.entityId === row.entityId)!;
      return outcomeRank[old.status] >= outcomeRank[row.status] ? old : row;
    }),
  };
}
export async function readVerifiedNetworkSettingsOperation(
  api: ApiTransport,
  expected: Pick<NetworkSettingsOperationResponse, 'operationId' | 'entityType' | 'section'> & {
    recipientIds?: string[];
  },
): Promise<NetworkSettingsOperationResponse> {
  const value = await getNetworkSettingsOperation(api, expected.operationId);
  assertOperationIdentity(
    value,
    expected.operationId,
    expected.entityType,
    expected.section,
    expected.recipientIds,
  );
  return value;
}
export function networkSettingsReceiptForStatus(
  receipt: NetworkSettingsOperationReceipt,
  value: NetworkSettingsOperationResponse,
): NetworkSettingsOperationReceipt {
  assertOperationIdentity(
    value,
    receipt.operationId,
    receipt.entityType,
    receipt.section,
    receipt.recipientIds,
  );
  const observedAt = new Date().toISOString();
  const recipientIds = receipt.recipientIds ?? value.outcomes.map((row) => row.entityId);
  const complete =
    value.status === 'COMPLETE' &&
    recipientIds.length > 0 &&
    value.outcomes.every((row) => row.status === 'COMPLETE');
  return mergeNetworkSettingsReceipt(receipt, {
    ...receipt,
    recipientIds,
    lastKnownStatus: value.status,
    expiresAt: value.expiresAt,
    updatedAt: observedAt,
    ...(!['PREVIEWING', 'PREPARED'].includes(value.status)
      ? { launchState: 'submitted' as const }
      : {}),
    ...(complete ? { completionConfirmedAt: observedAt } : {}),
    ...(isNetworkSettingsOperationSettled(value) ? { settlementConfirmedAt: observedAt } : {}),
  });
}
function frozenRecipientIds(
  operationId: string,
  scope: NetworkSettingsEditorScope,
  receipt: NetworkSettingsOperationReceipt | null,
  preview: NetworkSettingsPreviewResponse | null,
): string[] | undefined {
  if (receipt?.operationId === operationId && receipt.recipientIds) return receipt.recipientIds;
  if (preview?.operationId === operationId) return preview.recipients.map((row) => row.entityId);
  return scope.target.mode === 'selected' ? [...scope.target.entityIds] : undefined;
}
const terminal = (status: string) => ['COMPLETE', 'PARTIAL', 'FAILED'].includes(status);
export function isNetworkSettingsOperationSettled(
  value: NetworkSettingsOperationResponse,
): boolean {
  return (
    terminal(value.status) &&
    value.outcomes.every((row) => row.status === 'COMPLETE' || row.status === 'FAILED')
  );
}
export function networkSettingsFailedRecipients(
  value: NetworkSettingsOperationResponse | null,
): string[] {
  if (!value || !isNetworkSettingsOperationSettled(value)) return [];
  return value.outcomes.filter((row) => row.status === 'FAILED').map((row) => row.entityId);
}
const launched = (receipt: NetworkSettingsOperationReceipt | null) =>
  receipt !== null && receipt.launchState !== 'unconfirmed';
export function networkSettingsResultReadOnly(
  receipt: NetworkSettingsOperationReceipt | null,
  resumeOperationId?: string,
): boolean {
  return launched(receipt) || Boolean(resumeOperationId);
}
const pendingDrafts = new Map<
  string,
  { changes: NetworkSettingsChange[]; navigationAllowlist?: NetworkNavigationAllowlistIntent }
>();
export function carryNetworkSettingsRetryDraft(
  scopeId: string,
  changes: readonly NetworkSettingsChange[],
  navigationAllowlist?: NetworkNavigationAllowlistIntent,
) {
  pendingDrafts.set(scopeId, structuredClone({ changes: [...changes], navigationAllowlist }));
}
export function useNetworkSettingsController(input: {
  api: ApiTransport;
  userId: string;
  scopeId: string;
  scope: NetworkSettingsEditorScope;
  title: string;
  retryOfOperationId?: string;
  resumeOperationId?: string;
  onOperationChange?: (operation: NetworkSettingsOperationResponse | null) => void;
}) {
  const [read, setRead] = useState<NetworkSettingsReadResponse | null>(null);
  const [progress, setProgress] = useState({ loaded: 0, total: 0 });
  const carriedDraft = useMemo(() => pendingDrafts.get(input.scopeId), [input.scopeId]);
  const [changes, setChangesState] = useState<NetworkSettingsChange[]>(
    () => carriedDraft?.changes ?? [],
  );
  const [navigationAllowlist, setNavigationAllowlistState] = useState<
    NetworkNavigationAllowlistIntent | undefined
  >();
  const [statusIssue, setStatusIssue] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<NetworkSettingsPreviewResponse | null>(null);
  const [operation, setOperation] = useState<NetworkSettingsOperationResponse | null>(null);
  const [receipt, setReceipt] = useState<NetworkSettingsOperationReceipt | null>(null);
  const [phase, setPhase] = useState<'loading' | 'idle' | 'preview' | 'apply'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [previewChanged, setPreviewChanged] = useState(false);
  const conflictDraft = useRef<{
    identity: string;
    changes: NetworkSettingsChange[];
    navigationAllowlist?: NetworkNavigationAllowlistIntent;
  } | null>(null);
  const generation = useRef(0);
  const applying = useRef(false);
  const frozen = useRef<string | null>(null);
  const current = useRef({
    input,
    read,
    changes,
    navigationAllowlist,
    errors,
    preview,
    operation,
    receipt,
    statusIssue,
  });
  current.current = {
    input,
    read,
    changes,
    navigationAllowlist,
    errors,
    preview,
    operation,
    receipt,
    statusIssue,
  };
  const identity =
    input.userId +
    ':' +
    input.scopeId +
    ':' +
    input.scope.entityType +
    ':' +
    input.scope.initialSection;
  const draftKey = canonicalNetworkValue({
    identity,
    compositionVersion: read?.compositionVersion,
    recipients: read?.recipients,
    changes,
    navigationAllowlist,
  });
  const liveKey = useRef(draftKey);
  liveKey.current = draftKey;
  const makeReceipt = useCallback(
    (
      operationId: string,
      launchState: NetworkSettingsOperationReceipt['launchState'],
      extra: Partial<NetworkSettingsOperationReceipt> = {},
    ): NetworkSettingsOperationReceipt => ({
      version: 1,
      scopeId: input.scopeId,
      userId: input.userId,
      entityType: input.scope.entityType,
      section: input.scope.initialSection,
      title: input.title,
      operationId,
      ...(input.retryOfOperationId ? { retryOfOperationId: input.retryOfOperationId } : {}),
      launchState,
      updatedAt: new Date().toISOString(),
      ...extra,
    }),
    [
      input.scopeId,
      input.userId,
      input.scope.entityType,
      input.scope.initialSection,
      input.title,
      input.retryOfOperationId,
    ],
  );
  useEffect(() => {
    const revision = ++generation.current;
    const readAbort = new AbortController();
    setRead(null);
    setProgress({ loaded: 0, total: 0 });
    setPhase('loading');
    setError(null);
    setStatusIssue(false);
    setNavigationAllowlistState(undefined);
    setPreview(null);
    setOperation(null);
    frozen.current = null;
    setErrors({});
    const carried =
      conflictDraft.current?.identity === identity ? conflictDraft.current : carriedDraft;
    pendingDrafts.delete(input.scopeId);
    setChangesState(carried?.changes ?? []);
    setNavigationAllowlistState(carried?.navigationAllowlist);
    const recovered = input.resumeOperationId
      ? (listNetworkSettingsOperationReceipts(input.userId).find(
          (r) =>
            r.operationId === input.resumeOperationId &&
            r.scopeId === input.scopeId &&
            r.entityType === input.scope.entityType &&
            r.section === input.scope.initialSection,
        ) ?? null)
      : null;
    setReceipt(recovered);
    void readCompleteNetworkSettings(
      input.api,
      {
        entityType: input.scope.entityType,
        target: input.scope.target,
        section: input.scope.initialSection,
      },
      (loaded, total) => {
        if (generation.current === revision) setProgress({ loaded, total });
      },
      readAbort.signal,
    )
      .then((value) => {
        if (generation.current === revision) setRead(value);
      })
      .catch((cause) => {
        if (generation.current === revision)
          setError(cause instanceof Error ? cause.message : 'Не удалось загрузить настройки.');
      })
      .finally(() => {
        if (generation.current === revision) setPhase('idle');
      });
    if (input.resumeOperationId)
      void readVerifiedNetworkSettingsOperation(input.api, {
        operationId: input.resumeOperationId,
        entityType: input.scope.entityType,
        section: input.scope.initialSection,
        recipientIds: frozenRecipientIds(input.resumeOperationId, input.scope, recovered, null),
      })
        .then(async (value) => {
          if (generation.current !== revision) return;
          setOperation((previous) => mergeNetworkSettingsOperation(previous, value));
          if (recovered) {
            const next = networkSettingsReceiptForStatus(recovered, value);
            await persistNetworkSettingsOperationReceipt(next);
            if (generation.current !== revision) return;
            setReceipt((previous) => mergeNetworkSettingsReceipt(previous ?? undefined, next));
          }
        })
        .catch((cause) => {
          if (generation.current === revision)
            setError(cause instanceof Error ? cause.message : 'Не удалось проверить операцию.');
        });
    return () => {
      readAbort.abort();
      generation.current++;
    };
    // FLAG: The immutable actor/scope/section identity owns all asynchronous responses.
  }, [identity, reload, input.api, input.resumeOperationId, carriedDraft]);
  useEffect(() => {
    input.onOperationChange?.(operation);
  }, [operation, input.onOperationChange]);
  const operationId =
    phase === 'preview' ? undefined : (operation?.operationId ?? receipt?.operationId);
  useEffect(() => {
    if (!operationId || (operation && isNetworkSettingsOperationSettled(operation))) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const revision = generation.current;
    const poll = async () => {
      try {
        const value = await readVerifiedNetworkSettingsOperation(input.api, {
          operationId,
          entityType: input.scope.entityType,
          section: input.scope.initialSection,
          recipientIds: frozenRecipientIds(
            operationId,
            input.scope,
            current.current.receipt,
            current.current.preview,
          ),
        });
        if (stopped || generation.current !== revision) return;
        const old = current.current.receipt;
        if (old?.operationId === operationId) {
          const next = networkSettingsReceiptForStatus(old, value);
          await persistNetworkSettingsOperationReceipt(next);
          if (stopped || generation.current !== revision) return;
          setReceipt((previous) => mergeNetworkSettingsReceipt(previous ?? undefined, next));
        }
        if (stopped || generation.current !== revision) return;
        setOperation((previous) => mergeNetworkSettingsOperation(previous, value));
        setStatusIssue(false);
        setError(null);
        if (!isNetworkSettingsOperationSettled(value))
          timer = setTimeout(poll, value.status === 'PREPARED' ? 5000 : 1500);
      } catch {
        if (stopped || generation.current !== revision) return;
        setStatusIssue(true);
        setError('Статус пока не получен. Проверяем исходную операцию; её номер сохранён.');
        timer = setTimeout(poll, 5000);
      }
    };
    timer = setTimeout(poll, 500);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [operationId, input.api, identity, operation?.status]);
  const setChanges = useCallback((next: NetworkSettingsChange[]) => {
    const old = current.current.receipt;
    if (
      current.current.statusIssue ||
      networkSettingsResultReadOnly(old, current.current.input.resumeOperationId)
    )
      return;
    setChangesState(structuredClone(next));
    setPreview(null);
    frozen.current = null;
    if (old?.launchState === 'unconfirmed') {
      generation.current++;
      void removeNetworkSettingsOperationReceipt(old.userId, old.operationId);
      setReceipt(null);
      setOperation(null);
    }
  }, []);
  const setFieldError = useCallback(
    (path: string, message: string | null) =>
      setErrors((old) => {
        const next = { ...old };
        if (message) next[path] = message;
        else delete next[path];
        return next;
      }),
    [],
  );
  const operationPort = useCallback(
    (revision: number, key: string): NetworkSettingsOperationPort => ({
      api: input.api,
      scope: input.scope,
      isCurrent: () => generation.current === revision && liveKey.current === key,
      isGenerationCurrent: () => generation.current === revision,
      makeReceipt,
      persistNetworkSettingsOperationReceipt,
      readVerifiedNetworkSettingsOperation,
      mergeNetworkSettingsOperation,
      networkSettingsReceiptForStatus,
      setReceipt,
      setPreview,
      setOperation,
      setStatusIssue,
    }),
    [input.api, input.scope, makeReceipt],
  );
  const prepare = useCallback(async () => {
    const state = current.current;
    if (
      !state.read?.recipientCount ||
      (!state.changes.length && !state.navigationAllowlist) ||
      Object.keys(state.errors).length ||
      state.statusIssue ||
      networkSettingsResultReadOnly(state.receipt, state.input.resumeOperationId) ||
      applying.current
    )
      return;
    const revision = generation.current;
    const key = liveKey.current;
    const operationId = crypto.randomUUID();
    conflictDraft.current = null;
    setPreviewChanged(false);
    setPhase('preview');
    setError(null);
    setOperation(null);
    frozen.current = key;
    const initial = makeReceipt(operationId, 'unconfirmed', {
      recipientIds: state.read.recipients.map((row) => row.entityId),
    });
    setReceipt(initial);
    const port = operationPort(revision, key);
    try {
      await withNetworkSettingsOperationRuntime(port.isCurrent, (runtime) =>
        runtime.prepareNetworkSettingsOperation({
          port,
          initial,
          read: state.read!,
          changes: state.changes,
          navigationAllowlist: state.navigationAllowlist,
        }),
      );
    } catch (cause) {
      if (!port.isCurrent() && cause instanceof DOMException && cause.name === 'AbortError') return;
      if (generation.current === revision) {
        if (cause instanceof NetworkSettingsPreviewConflict) {
          conflictDraft.current = {
            identity,
            changes: state.changes,
            navigationAllowlist: state.navigationAllowlist,
          };
          setReceipt(null);
          setOperation(null);
          setPreview(null);
          setRead(null);
          frozen.current = null;
          setStatusIssue(false);
          setPreviewChanged(true);
          setReload((value) => value + 1);
          return;
        }
        setStatusIssue(Boolean(current.current.preview));
        setError(
          cause instanceof Error ? cause.message : 'Ответ не получен. Проверяем исходную операцию.',
        );
      }
    } finally {
      if (generation.current === revision) setPhase('idle');
    }
  }, [identity, makeReceipt, operationPort]);
  const impactsComplete =
    !navigationAllowlist ||
    Boolean(
      operation?.navigationAllowlistImpacts &&
      preview &&
      operation.navigationAllowlistImpacts.length === preview.recipients.length &&
      new Set(operation.navigationAllowlistImpacts.map((row) => row.entityId)).size ===
        preview.recipients.length &&
      operation.navigationAllowlistImpacts.every((row) =>
        preview.recipients.some((recipient) => recipient.entityId === row.entityId),
      ),
    );
  const canApply = Boolean(
    !statusIssue &&
    impactsComplete &&
    preview &&
    operation?.status === 'PREPARED' &&
    receipt?.launchState === 'unconfirmed' &&
    receipt.previewHash === preview.previewHash &&
    frozen.current === draftKey &&
    !Object.keys(errors).length &&
    Date.parse(operation.expiresAt) > Date.now(),
  );
  const apply = useCallback(async () => {
    if (applying.current) return;
    const state = current.current;
    const reviewed = state.preview;
    if (
      state.statusIssue ||
      !canApply ||
      !reviewed ||
      state.operation?.status !== 'PREPARED' ||
      state.receipt?.launchState !== 'unconfirmed' ||
      frozen.current !== liveKey.current ||
      Date.parse(state.operation.expiresAt) <= Date.now() ||
      Object.keys(state.errors).length
    )
      return;
    applying.current = true;
    setPhase('apply');
    setError(null);
    const revision = generation.current;
    const key = liveKey.current;
    const port = operationPort(revision, key);
    try {
      await withNetworkSettingsOperationRuntime(port.isCurrent, (runtime) =>
        runtime.applyNetworkSettingsOperation({ port, reviewed, operation: state.operation! }),
      );
    } catch (cause) {
      if (!port.isCurrent() && cause instanceof DOMException && cause.name === 'AbortError') return;
      if (generation.current === revision) {
        const uncertain = makeReceipt(reviewed.operationId, 'uncertain', {
          recipientIds: reviewed.recipients.map((row) => row.entityId),
          previewHash: reviewed.previewHash,
          expiresAt: state.operation.expiresAt,
        });
        // Storage failure before dispatch also stays status-only. A retry never guesses whether apply ran.
        setReceipt((previous) => mergeNetworkSettingsReceipt(previous ?? undefined, uncertain));
        setStatusIssue(true);
        void persistNetworkSettingsOperationReceipt(uncertain).catch(() => setStatusIssue(true));
        setError(
          cause instanceof Error ? cause.message : 'Ответ не получен. Проверяем исходную операцию.',
        );
      }
    } finally {
      applying.current = false;
      if (generation.current === revision) setPhase('idle');
    }
  }, [makeReceipt, canApply, operationPort]);
  const resultReadOnly = networkSettingsResultReadOnly(receipt, input.resumeOperationId);
  const setNavigationAllowlist = useCallback(
    (intent: NetworkNavigationAllowlistIntent | undefined) => {
      const state = current.current;
      if (
        state.statusIssue ||
        networkSettingsResultReadOnly(state.receipt, state.input.resumeOperationId)
      )
        return;
      setNavigationAllowlistState(intent ? structuredClone(intent) : undefined);
      setPreview(null);
      frozen.current = null;
      if (state.receipt?.launchState === 'unconfirmed') {
        generation.current++;
        void removeNetworkSettingsOperationReceipt(state.receipt.userId, state.receipt.operationId);
        setReceipt(null);
        setOperation(null);
      }
    },
    [],
  );
  return {
    read,
    progress,
    changes,
    navigationAllowlist,
    setNavigationAllowlist,
    errors,
    preview,
    operation,
    receipt,
    phase,
    error,
    canApply,
    previewChanged,
    prepare,
    apply,
    setChanges,
    setFieldError,
    readOnly: phase !== 'idle' || !read || statusIssue || resultReadOnly,
    dirty:
      (changes.length > 0 || Boolean(navigationAllowlist) || Object.keys(errors).length > 0) &&
      !resultReadOnly,
    canStartAgain:
      phase === 'idle' &&
      !statusIssue &&
      Boolean(
        operation &&
        (isNetworkSettingsOperationSettled(operation) ||
          (operation.status === 'PREPARED' &&
            receipt?.launchState === 'unconfirmed' &&
            (Boolean(input.resumeOperationId) || Date.parse(operation.expiresAt) <= Date.now()))),
      ),
    editPreview: () => {
      if (phase === 'idle' && !statusIssue && !resultReadOnly) setChanges([...changes]);
    },
    discard: () => {
      setChanges([]);
      setNavigationAllowlist(undefined);
      setErrors({});
    },
    reload: () => setReload((value) => value + 1),
    failedRecipients: networkSettingsFailedRecipients(operation),
    retryChanges: structuredClone(changes),
  };
}
