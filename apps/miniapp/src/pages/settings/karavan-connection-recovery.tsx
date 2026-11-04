import { useRef, useState } from 'react';
import type { KaravanConnectionSnapshot } from '@maxim/contracts/karavan-marketplace-connection';
import type { ApiTransport } from '../../lib/api/transport';
import {
  getKaravanMarketplaceOperation,
  setupKaravanMarketplace,
  getKaravanBindingOperation,
  resumeKaravanBinding,
} from '../../lib/api/karavan-marketplace-client';
import { describeUserFacingError } from '../../lib/user-facing-error';

// FLAG: This separate reader remains useful when current marketplace access or
// its provider is unavailable. Only an explicit resume can dispatch the saved ID.
export default function ConnectionRecovery({
  api,
  chatId,
  snapshot,
  onRefresh,
}: {
  api: ApiTransport;
  chatId: string;
  snapshot: KaravanConnectionSnapshot;
  onRefresh: () => void;
}) {
  const [current, setCurrent] = useState(snapshot.operation);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const [error, setError] = useState<string | null>(null);
  if (!current)
    return snapshot.blocked ? <p role="status">Выполняется другое изменение магазина.</p> : null;
  const terminal = ['complete', 'rejected', 'cancelled', 'superseded'].includes(
    current.operation.state,
  );
  async function read(resume: boolean) {
    if (!current || working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      if (current.kind === 'setup') {
        const operation = resume
          ? await setupKaravanMarketplace(api, chatId, current.operation.request)
          : await getKaravanMarketplaceOperation(api, chatId, current.operation.operationId);
        setCurrent({ kind: 'setup', operation });
      } else {
        const operation = resume
          ? await resumeKaravanBinding(api, chatId, current.operation.operationId)
          : await getKaravanBindingOperation(api, chatId, current.operation.operationId);
        setCurrent({ kind: 'binding', operation });
      }
      onRefresh();
    } catch (cause) {
      setError(describeUserFacingError(cause, 'Не удалось проверить результат. Повторите позже.'));
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  const state = current.operation.state;
  return (
    <section aria-label="Сохранённое подключение">
      <p role="status">
        {state === 'complete'
          ? 'Подключение выполнено.'
          : state === 'rejected'
            ? 'Подключение не выполнено.'
            : state === 'cancelled'
              ? 'Подключение остановлено.'
              : state === 'superseded'
                ? 'Подключение изменилось. Прежнее действие больше не применяется.'
                : 'Есть незавершённое подключение.'}
      </p>
      {error ? <p role="alert">{error}</p> : null}
      <button type="button" disabled={busy} onClick={() => void read(false)}>
        Проверить результат
      </button>
      {!terminal ? (
        <button type="button" disabled={busy} onClick={() => void read(true)}>
          Продолжить подключение
        </button>
      ) : null}
    </section>
  );
}
