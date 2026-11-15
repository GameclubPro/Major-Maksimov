import '../src/styles.css';
import '../src/styles/settings-drilldown-core.css';
import '../src/styles/settings-experience.css';
import '../src/styles/moderation-workspace.css';
import { createRoot } from 'react-dom/client';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../src/components/ui/toast';
import { ModerationMessageSheet } from '../src/components/moderation-message-sheet';
import { syncMaxNativeEnvironment } from '../src/lib/max-bridge';
import type { ApiTransport } from '../src/lib/api/transport';
import { createPreviewState } from '../src/lib/api/preview-transport-state';

const scenario = new URLSearchParams(location.search).get('case') ?? 'saved';
const preview = createPreviewState({});
const event = {
  ...preview.chatViolations[0],
  id: 'message-test',
  userDisplayName: 'Елена',
  ruleCode: 'COMMERCIAL_LLM_DELETE',
  metadata: { commercialAdsDecision: { categories: ['SERVICES'] } },
};
let attempts = 0;
const api: ApiTransport = {
  async request(path) {
    if (!path.endsWith('/message')) return {};
    if (scenario === 'error' && attempts++ === 0)
      throw new Error('Не удалось загрузить сообщение.');
    const empty = ['expired', 'not_captured'].includes(scenario);
    return {
      eventId: event.id,
      state: empty ? scenario : scenario === 'partial' ? 'partial' : 'saved',
      sourceAt: null,
      expiresAt: null,
      content: empty
        ? null
        : {
            text:
              scenario === 'media'
                ? ''
                : scenario === 'long'
                  ? 'Длинное сообщение 🙂\n'.repeat(400) + 'Последняя строка.'
                  : 'Девочки, кто знает хорошего мастера?\nНужно починить стиральную машину. Буду благодарна за рекомендации.',
            truncated: scenario === 'partial',
            attachments: scenario === 'media' ? ['image', 'image', 'video'] : [],
          },
    };
  },
  requestKeepalive() {},
};
syncMaxNativeEnvironment();
document.body.dataset.miniappProfile = 'moderation';
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function Fixture() {
  const [open, setOpen] = useState(true);
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <button onClick={() => setOpen(true)}>Открыть</button>
          {open ? (
            <ModerationMessageSheet
              api={api}
              chatId="preview-chat"
              event={event}
              onClose={() => setOpen(false)}
            />
          ) : null}
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
