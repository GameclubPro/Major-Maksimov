import { useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import {
  chatRulesSchema,
  chatSettingsSchema,
  type ChatSettingsScreenResponse,
} from '@maxim/contracts/settings';
import { useSettingsRules } from '../../src/pages/settings/use-settings-rules';
import { ApiRequestError } from '../../src/lib/api-request-error';
import type { ApiTransport } from '../../src/lib/api/transport';
import { getRules } from '../../src/lib/api/chat-settings-client';
const initial = chatRulesSchema.parse({
  revision: '2026-11-10T06:00:00.000Z',
  text: 'Сохранённые правила',
  publishedMessageId: 'old-post',
  publishedUrl: 'https://max.ru/old-post',
});
const api: ApiTransport = {
  async request(path, init) {
    const response = await fetch(`/api${path}`, init);
    const body = await response.text();
    if (!response.ok) throw new ApiRequestError(response.status, body, 'Ошибка сохранения');
    return JSON.parse(body);
  },
  requestKeepalive() {},
};
function Harness() {
  const [chatId, setChatId] = useState('chat-a');
  const [events, setEvents] = useState<string[]>([]);
  const [moduleOpen, setModuleOpen] = useState(true);
  const pushToast = useCallback(
    (toast: { title: string }) => setEvents((current) => [...current, toast.title]),
    [],
  );
  const query = useQuery({
    queryKey: ['settings-screen', chatId],
    queryFn: async () => ({ rules: await getRules(api, chatId) }) as ChatSettingsScreenResponse,
    initialData: () => ({ rules: initial }) as ChatSettingsScreenResponse,
    enabled: false,
  });
  const state = useSettingsRules({
    api,
    chatId,
    serverRules: query.data?.rules,
    rulesModuleOpen: moduleOpen,
    currentRulesTextSource: {
      settings: chatSettingsSchema.parse({ antiSpamEnabled: true }),
      duplicatePhotoModerationMode: 'OFF',
      domains: [],
      requiredSubscriptionChannels: [],
    },
    isUpdatingRulesAttachment: false,
    pushToast,
  });
  return (
    <main>
      <button onClick={() => setChatId(chatId === 'chat-a' ? 'chat-b' : 'chat-a')}>
        Другой чат
      </button>
      <button onClick={() => void query.refetch()}>Обновить с сервера</button>
      <label>
        Правила
        <textarea
          aria-label="Правила"
          value={state.rulesDraft?.text ?? ''}
          disabled={state.isRulesDraftEditingDisabled}
          onChange={(event) =>
            state.setRulesDraft((draft) => (draft ? { ...draft, text: event.target.value } : draft))
          }
        />
      </label>
      <button disabled={state.isRulesBusy} onClick={() => void state.handleSaveRulesDraft()}>
        Сохранить
      </button>
      <button
        disabled={state.isRulesBusy}
        onClick={() => void state.handleRulesAutoTextChange(true)}
      >
        Автотекст
      </button>
      <button disabled={state.isRulesBusy} onClick={() => void state.handlePublishRules()}>
        Опубликовать
      </button>
      <button disabled={state.isRulesBusy} onClick={state.confirmResetPublishedRules}>
        Удалить публикацию
      </button>
      <button onClick={state.handleResetPublishedRules}>Проверить удаление</button>
      <button onClick={() => setModuleOpen((open) => !open)}>Скрыть правила</button>
      <button onClick={() => state.handleRulesImagePreparationChange(!state.isPreparingRulesImage)}>
        Подготовить фото
      </button>
      <output data-testid="state">
        {JSON.stringify({
          chatId,
          draft: state.rulesDraft,
          dirty: state.hasRulesChanges,
          busy: state.isRulesBusy,
          textError: state.rulesTextError,
          pendingReset: state.isRulesResetPending,
          checking: state.isCheckingRulesPublication,
          resetConfirmation: state.rulesResetConfirmationOpen,
          events,
        })}
      </output>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider
    client={
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      })
    }
  >
    <Harness />
  </QueryClientProvider>,
);
