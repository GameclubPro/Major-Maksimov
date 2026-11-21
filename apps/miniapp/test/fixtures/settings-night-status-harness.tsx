import { useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ApiTransport } from '../../src/lib/api/transport';
import { ApiRequestError } from '../../src/lib/api-request-error';
import SettingsChatClosureStatus from '../../src/pages/settings/settings-chat-closure-status';
import { getNightTimezoneOptions } from '../../src/pages/settings/settings-timezones';
import {
  useChatClosureSummary,
  useSettingsScreenQuery,
} from '../../src/pages/settings/use-settings-screen-query';
import { useSettingsDraft } from '../../src/pages/settings/use-settings-draft';
import '../../src/styles.css';
import '../../src/styles/settings-native-controls.css';
import '../../src/pages/settings/settings-night-status.css';

document.body.dataset.miniappProfile = 'moderation';
function Harness() {
  const [expanded, setExpanded] = useState(true);
  const api = useMemo<ApiTransport>(
    () => ({
      async request(path, init) {
        const response = await fetch(`/api${path}`, init);
        const body = await response.text();
        if (!response.ok) throw new ApiRequestError(response.status, body, 'Ошибка запроса');
        return JSON.parse(body);
      },
      requestKeepalive() {},
    }),
    [],
  );
  const screen = useSettingsScreenQuery({
    api,
    chatId: 'chat-a',
    expandedSections: { night: expanded, links: false, duplicates: false },
  });
  const closure = useChatClosureSummary({
    api,
    chatId: 'chat-a',
    enabled: expanded && screen.isSuccess,
    principal: 'user-1',
  });
  const settings = useSettingsDraft({
    api,
    chatId: 'chat-a',
    userId: 'user-1',
    serverSettings: screen.data?.settings,
    refetchSettings: screen.refetch,
    onHydrated() {},
    onStopWordsSaved() {},
    onSaved() {},
    onError() {},
  });
  return (
    <main style={{ padding: 16, maxWidth: 520, margin: '0 auto' }}>
      <h1>Ночной режим</h1>
      <button onClick={() => setExpanded((value) => !value)}>
        {expanded ? 'Закрыть раздел' : 'Открыть раздел'}
      </button>
      <div data-testid="fetch-state" hidden>
        {closure.fetchStatus}
      </div>
      {settings.draft && (
        <div style={{ display: 'grid', gap: 12, margin: '16px 0' }}>
          <label>
            Начало в минутах
            <input
              aria-label="Начало в минутах"
              type="number"
              value={settings.draft.nightModeStartTimeMinutes}
              onChange={(event) =>
                settings.setDraft(
                  (current) =>
                    current && {
                      ...current,
                      nightModeStartTimeMinutes: Number(event.target.value),
                    },
                )
              }
            />
          </label>
          <label>
            Часовой пояс
            <select
              aria-label="Часовой пояс"
              value={settings.draft.nightModeTimezone}
              onChange={(event) =>
                settings.setDraft(
                  (current) => current && { ...current, nightModeTimezone: event.target.value },
                )
              }
            >
              {getNightTimezoneOptions(settings.draft.nightModeTimezone).map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <output data-testid="draft-state">
            {settings.hasChanges ? 'Есть несохранённые изменения' : 'Сохранено'}
          </output>
        </div>
      )}
      {expanded && closure.data && (
        <SettingsChatClosureStatus status={closure.data} refreshFailed={closure.isError} />
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider
    client={
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, refetchOnWindowFocus: false },
          mutations: { retry: false },
        },
      })
    }
  >
    <Harness />
  </QueryClientProvider>,
);
