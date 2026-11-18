import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { NetworkSettingsOperationResponse } from '@maxim/contracts/network-settings';
import { NetworkSettingsOperationPanel } from '../../src/features/network-settings/network-settings-operation-panel';
import { SearchField } from '../../src/components/ui/search-field';
import '../../src/pages/network-settings-page.css';
import '../../src/styles/moderation-catalogue-palette.css';
import '../../src/styles/moderation-workspace.css';

export function mountNetworkOperationResultsFixture() {
  const host = document.createElement('main');
  document.body.replaceChildren(host);
  document.body.dataset.miniappProfile = 'moderation';
  const operation: NetworkSettingsOperationResponse = {
    operationId: '00000000-0000-4000-8000-000000000001',
    entityType: 'chat',
    section: 'links',
    status: 'PARTIAL',
    expiresAt: '2026-10-24T00:00:00.000Z',
    outcomes: Array.from({ length: 180 }, (_, index) => ({
      entityId: `chat-${index}`,
      status: index < 120 ? 'FAILED' : 'COMPLETE',
      ...(index < 120
        ? {
            failureCode: 'CONFLICT',
            failureMessage: 'Настройки изменились. Проверьте новую версию.',
          }
        : {}),
    })),
  };
  const titles = new Map(
    operation.outcomes.map((row) => [row.entityId, `Сообщество ${row.entityId}`]),
  );
  titles.delete('chat-0');
  titles.delete('chat-1');
  function Fixture() {
    const [search, setSearch] = useState('Длинный поисковый запрос');
    const [status, setStatus] = useState<NetworkSettingsOperationResponse['status']>('PARTIAL');
    return (
      <div className="network-settings-editor" style={{ padding: 12, minWidth: 0 }}>
        <SearchField value={search} onChange={setSearch} label="Поиск получателей" />
        <button type="button" onClick={() => setStatus('RUNNING')}>
          Продолжить наблюдение
        </button>
        <button type="button" onClick={() => setStatus('FAILED')}>
          Получить итог
        </button>
        <NetworkSettingsOperationPanel
          operation={{ ...operation, status }}
          controller={{
            preview: null,
            canStartAgain: false,
            failedRecipients: [],
            retryChanges: [],
            navigationAllowlist: null,
          }}
          recipientTitles={titles}
          onStartAgain={() => {}}
          onRetry={() => {}}
        />
      </div>
    );
  }
  createRoot(host).render(<Fixture />);
}
