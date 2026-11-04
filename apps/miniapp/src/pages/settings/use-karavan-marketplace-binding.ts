import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { KaravanMarketplaceModule } from '@maxim/contracts/karavan-marketplace';
import {
  karavanConnectionBindingInputSchema,
  type KaravanConnectionBindingInput,
  type KaravanConnectionBindingOperation,
  type KaravanConnectionSnapshot,
} from '@maxim/contracts/karavan-marketplace-connection';
import {
  getKaravanBindingOperation,
  getKaravanConnection,
  importKaravanBinding,
  resumeKaravanBinding,
  startKaravanBinding,
} from '../../lib/api/karavan-marketplace-client';
import type { ApiTransport } from '../../lib/api/transport';
import { localShopRecoveryReaders } from './karavan-shop/storage-recovery';
import { describeUserFacingError } from '../../lib/user-facing-error';
import {
  karavanBindingRecoveryMessage,
  readKaravanBindingRecovery,
  type KaravanBindingRecoveryState,
} from './karavan-binding-recovery';

type BindingState = {
  key: string | null;
  snapshot: KaravanConnectionSnapshot | undefined;
  operation: KaravanConnectionBindingOperation | null;
  original: KaravanConnectionBindingInput | null;
  dismissed: string | null;
  feedback: boolean;
  error: string | null;
  busy: boolean;
  legacyRecovery: KaravanBindingRecoveryState | null;
};
const isActive = (state: KaravanConnectionBindingOperation['state']) =>
  state === 'pending' || state === 'unknown';
const upgradeMessage = 'Обновите приложение, чтобы изменить подключение магазина.';
function initial(key: string | null, snapshot?: KaravanConnectionSnapshot): BindingState {
  return {
    key,
    snapshot,
    operation: key && snapshot?.operation?.kind === 'binding' ? snapshot.operation.operation : null,
    original: null,
    dismissed: null,
    feedback: false,
    error: null,
    busy: false,
    legacyRecovery: null,
  };
}
function observe(current: BindingState, snapshot: KaravanConnectionSnapshot): BindingState {
  if (current.snapshot && snapshot.revision < current.snapshot.revision) return current;
  let operation = snapshot.operation?.kind === 'binding' ? snapshot.operation.operation : null;
  // FLAG: A read can present an exact committed receipt before an explicit write
  // settles its reservation. A stale module snapshot cannot undo that observation.
  if (
    current.operation &&
    operation?.operationId === current.operation.operationId &&
    !isActive(current.operation.state) &&
    isActive(operation.state)
  )
    operation = current.operation;
  if (!operation && current.operation && snapshot.revision === current.snapshot?.revision)
    operation = current.operation;
  return {
    ...current,
    snapshot,
    operation,
    original: operation ? null : current.original,
    feedback: operation?.operationId === current.operation?.operationId ? current.feedback : false,
  };
}

export function useKaravanMarketplaceBinding(
  api: ApiTransport,
  chatId: string,
  actorId?: string,
  _freshBinding?: KaravanMarketplaceModule['binding'],
  localOnlyRecovery = false,
  connection?: KaravanConnectionSnapshot,
) {
  const queryClient = useQueryClient();
  const key = actorId ? `${actorId}:${chatId}` : null;
  const [state, setState] = useState(() => initial(key, connection));
  const active = useRef({ key, epoch: 0 });
  const working = useRef<symbol | null>(null);
  if (active.current.key !== key) {
    active.current = { key, epoch: active.current.epoch + 1 };
    working.current = null;
  }
  const renderIdentity = { ...active.current };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setState((current) => {
      if (current.key !== key) return initial(key, connection);
      if (JSON.stringify(current.snapshot) === JSON.stringify(connection)) return current;
      return connection ? observe(current, connection) : { ...current, snapshot: undefined };
    });
  }, [key, connection]);
  const current = state.key === key ? state : initial(key, connection);
  const supported = Boolean(current.snapshot?.version === 2);
  const matches = (identity: { key: string | null; epoch: number }) =>
    mounted.current &&
    identity.key !== null &&
    active.current.key === identity.key &&
    active.current.epoch === identity.epoch;
  const update = (
    identity: typeof active.current,
    change: (value: BindingState) => BindingState,
  ) => {
    if (!matches(identity)) return;
    setState((value) => (value.key === identity.key ? change(value) : value));
  };
  const invalidate = async () => {
    try {
      await queryClient.invalidateQueries({ queryKey: ['karavan-marketplace', chatId] });
    } catch {
      // FLAG: Failed refresh never turns a stored receipt back into an unknown action.
    }
  };
  const work = async <T>(
    action: () => Promise<T>,
    apply: (value: BindingState, result: T) => BindingState,
    refreshModule = false,
  ) => {
    if (!key || !matches(renderIdentity) || working.current) return;
    const identity = renderIdentity;
    const token = Symbol();
    working.current = token;
    update(identity, (value) => ({ ...value, busy: true, error: null }));
    try {
      const result = await action();
      update(identity, (value) => apply(value, result));
      if (refreshModule) await invalidate();
    } catch (cause) {
      update(identity, (value) => ({
        ...value,
        error: describeUserFacingError(
          cause,
          'Результат пока не подтверждён. Обновите состояние подключения.',
        ),
      }));
    } finally {
      if (working.current === token) working.current = null;
      update(identity, (value) => ({ ...value, busy: false }));
    }
  };
  const applyOperation = (value: BindingState, operation: KaravanConnectionBindingOperation) => ({
    ...value,
    operation,
    original: null,
    dismissed: null,
    feedback: true,
    error: null,
  });
  const operation = current.operation;
  const request =
    operation &&
    (isActive(operation.state) ||
      (operation.state === 'rejected' && current.dismissed !== operation.operationId))
      ? operation.request
      : current.original;
  const activeSetup =
    current.snapshot?.operation?.kind === 'setup' &&
    ['pending', 'partial', 'unknown'].includes(current.snapshot.operation.operation.state);
  const blocked =
    !supported || Boolean(current.snapshot?.blocked || activeSetup || request || current.busy);
  const refresh = () => {
    if (!supported) return invalidate();
    return work(
      async () => {
        const snapshot = await getKaravanConnection(api, chatId);
        const id =
          snapshot.operation?.kind === 'binding'
            ? snapshot.operation.operation.operationId
            : operation?.operationId;
        const observed = id ? await getKaravanBindingOperation(api, chatId, id) : null;
        return { snapshot, observed };
      },
      (value, result) => {
        const next = observe(value, result.snapshot);
        return result.observed ? applyOperation(next, result.observed) : next;
      },
      true,
    );
  };
  const resume = () => {
    if (!supported || !request || (operation && !isActive(operation.state))) return;
    return work(
      () =>
        operation
          ? resumeKaravanBinding(api, chatId, operation.operationId)
          : startKaravanBinding(api, chatId, request),
      applyOperation,
      true,
    );
  };
  const legacyRecovery = current.legacyRecovery;
  return {
    request,
    operation,
    supported,
    blocked,
    hydrated: Boolean(key),
    hydrationState: key
      ? ({ status: 'ready', request } as const)
      : ({ status: 'loading' } as const),
    recoveryError: key && !supported ? upgradeMessage : null,
    error: current.error,
    rejected: operation?.state === 'rejected' && current.dismissed !== operation.operationId,
    notice: !current.feedback
      ? null
      : operation?.state === 'superseded'
        ? 'Подключение уже изменилось. Обновите состояние магазина.'
        : operation?.state === 'cancelled'
          ? 'Подключение отменено.'
          : operation?.state === 'complete'
            ? operation.request.action === 'unbind_chat'
              ? 'Чат отключён.'
              : 'Подключение сохранено.'
            : null,
    isPending: current.busy,
    start(input: Omit<KaravanConnectionBindingInput, 'commandId' | 'expectedConnectionRevision'>) {
      if (!key || !actorId || blocked || working.current || !current.snapshot) return;
      const original = karavanConnectionBindingInputSchema.parse({
        ...input,
        commandId: crypto.randomUUID(),
        expectedConnectionRevision: current.snapshot.revision,
      });
      // FLAG: Retain this frozen identity through a lost admission response. The
      // server revision also fences a delayed first POST after another device wins.
      update(renderIdentity, (value) => ({
        ...value,
        operation: null,
        original,
        dismissed: null,
        feedback: false,
        error: null,
      }));
      return work(() => startKaravanBinding(api, chatId, original), applyOperation, true);
    },
    refresh,
    resume,
    retry: resume,
    retryRecovery: refresh,
    resetRejected() {
      if (operation?.state !== 'rejected' || current.busy) return;
      update(renderIdentity, (value) => ({
        ...value,
        dismissed: operation.operationId,
        error: null,
      }));
      void invalidate();
    },
    legacyRecovery,
    inspectLegacy() {
      if (!actorId || !key || working.current) return;
      update(renderIdentity, (value) => ({
        ...value,
        legacyRecovery: { status: 'loading' },
      }));
      return work(
        () =>
          readKaravanBindingRecovery(
            `karavan-binding:v1:${actorId}:${chatId}`,
            localOnlyRecovery ? localShopRecoveryReaders : undefined,
          ),
        (value, result) => ({
          ...value,
          legacyRecovery: result,
          error: result.status === 'error' ? karavanBindingRecoveryMessage(result.reason) : null,
        }),
      );
    },
    importLegacy() {
      if (!supported || blocked || legacyRecovery?.status !== 'ready' || !legacyRecovery.request)
        return;
      // FLAG: Legacy adoption is an explicit registration only. Reading storage or
      // mounting this hook never imports, retries, erases or replaces either copy.
      return work(
        () => importKaravanBinding(api, chatId, legacyRecovery.request!),
        applyOperation,
        true,
      );
    },
  };
}
