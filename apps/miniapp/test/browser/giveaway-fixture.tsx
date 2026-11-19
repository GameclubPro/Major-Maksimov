import '../../src/styles.css';
import {
  managedGiveawayParticipantStateSchema,
  managedGiveawayPublicSchema,
} from '@maxim/contracts/giveaway';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ManagedGiveawayCard } from '../../src/components/managed-giveaway-card';
import { ToastProvider } from '../../src/components/ui/toast';
import { ApiRequestError } from '../../src/lib/api-request-error';
import { createPreviewApiTransport } from '../../src/lib/api/preview-transport';
import { GiveawayPage } from '../../src/pages/giveaway-page';
import type { ApiTransport } from '../../src/lib/api/transport';

const now = Date.now();
const data = managedGiveawayPublicSchema.parse({
  id: 'browser-test',
  serverTime: new Date(now).toISOString(),
  sourceChatId: 'source',
  sourceTitle: 'Канал организатора',
  sourceLink: 'https://max.ru/source',
  sourceAvatarUrl: 'https://images.example.test/source.webp',
  entityType: 'channel',
  title: 'Подарки для подписчиков',
  description: 'Подпишитесь на каналы и участвуйте в розыгрыше подарков.',
  status: 'ACTIVE',
  imageEnabled: false,
  imageBase64: '',
  imageMimeType: '',
  imageFileName: '',
  startsAt: null,
  endsAt: new Date(now + 3_600_000).toISOString(),
  claimHours: 24,
  requiredChannelIds: ['extra'],
  requiredChannels: [{ id: 'extra', title: 'Партнёр', link: 'https://max.ru/extra' }],
  entriesCount: 1234,
  winnersCount: 0,
  publishedAt: new Date(now).toISOString(),
  completedAt: null,
  publicationUrl: 'https://max.ru/post',
  resultsUrl: null,
  prizes: [
    {
      id: 'prize',
      position: 1,
      title: 'Сертификат на 5 000 ₽',
      displayTitle: 'Сертификат на 5 000 ₽',
    },
  ],
  winners: [],
});
let participant = managedGiveawayParticipantStateSchema.parse({
  joined: false,
  checkedAt: null,
  entryId: null,
  eligibilityState: null,
  eligibilityReason: null,
  missingChannelIds: [],
  joinedAt: null,
  isWinner: false,
  winnerId: null,
  winnerStatus: null,
  claimDeadlineAt: null,
  prizePosition: null,
  prizeTitle: null,
  prizeDisplayTitle: null,
  canClaim: false,
  claimBotUrl: null,
});
const client = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
const fixture = {
  enters: 0,
  claims: 0,
  mode: 'verified',
  opened: false,
  openedUrl: '',
  setPromotion(coverBase64: string | null, prizeCount = 1) {
    data.imageEnabled = Boolean(coverBase64);
    data.imageMimeType = coverBase64 ? 'image/webp' : '';
    data.imageBase64 = coverBase64 ?? '';
    data.prizes = managedGiveawayPublicSchema.shape.prizes.parse(
      Array.from({ length: prizeCount }, (_, index) => {
        const title =
          index === 0
            ? 'Сертификат на 5 000 ₽'
            : `Подарок ${index + 1} с длинным описанием для проверки переноса`;
        return { id: `prize-${index}`, position: index + 1, title, displayTitle: title };
      }),
    );
    void client.invalidateQueries();
  },
  setAvatar(avatarUrl: string | null, entityType: 'chat' | 'channel' = 'channel') {
    data.sourceAvatarUrl = avatarUrl;
    data.entityType = entityType;
    void client.invalidateQueries();
  },
  longConditions() {
    data.sourceTitle = 'Канал организатора с очень длинным названием для проверки переноса строк';
    data.requiredChannels = Array.from({ length: 20 }, (_, index) => ({
      id: `extra-${index}`,
      title: `Дополнительный канал ${index + 1} с очень длинным названием`,
      link: `https://max.ru/extra-${index}`,
    }));
    data.requiredChannelIds = data.requiredChannels.map((channel) => channel.id);
    void client.invalidateQueries();
  },
  refresh() {
    void client.invalidateQueries();
  },
  setScenario(scenario: string) {
    data.status =
      scenario === 'scheduled'
        ? 'SCHEDULED'
        : scenario === 'drawing'
          ? 'DRAWING'
          : scenario === 'canceled'
            ? 'CANCELED'
            : 'COMPLETED';
    if (scenario === 'scheduled') data.startsAt = new Date(Date.now() + 60_000).toISOString();
    if (scenario === 'winner' || scenario === 'expired') {
      participant = {
        ...participant,
        isWinner: true,
        winnerId: 'winner',
        winnerStatus: 'SELECTED',
        canClaim: true,
        prizePosition: 1,
        prizeTitle: 'Сертификат на 5 000 ₽',
        prizeDisplayTitle: 'Сертификат на 5 000 ₽',
        claimDeadlineAt: new Date(
          Date.now() + (scenario === 'expired' ? -1_000 : 3_600_000),
        ).toISOString(),
      };
      data.resultsUrl = 'https://max.ru/results';
      data.winners = [
        {
          prizePosition: 1,
          prizeTitle: 'Скрытый приз',
          prizeDisplayTitle: 'Скрытый приз',
          displayName: 'Победитель с длинным именем',
          status: scenario === 'expired' ? 'EXPIRED' : 'SELECTED',
        },
      ];
    }
    void client.invalidateQueries();
  },
};
Object.assign(window, {
  giveawayTest: fixture,
  WebApp: {
    openMaxLink: (url: string) => {
      fixture.opened = true;
      fixture.openedUrl = url;
    },
  },
});
const api = {
  async request(path: string) {
    if (path.endsWith('/enter')) {
      fixture.enters += 1;
      await new Promise((resolve) => window.setTimeout(resolve, 350));
      if (fixture.mode === 'error') throw new Error('Проверка временно недоступна');
      participant = {
        ...participant,
        joined: true,
        entryId: 'ticket-123',
        joinedAt: new Date().toISOString(),
        checkedAt: new Date().toISOString(),
        eligibilityState:
          fixture.mode === 'missing'
            ? 'REJECTED'
            : fixture.mode === 'pending'
              ? 'PENDING'
              : 'VERIFIED',
        missingChannelIds: fixture.mode === 'missing' ? ['extra'] : [],
      };
      return { ...participant };
    }
    if (path.endsWith('/claim')) {
      fixture.claims += 1;
      if (fixture.mode === 'claim-unavailable')
        throw new ApiRequestError(503, '', 'Проверка временно недоступна.');
      if (fixture.mode === 'claim-missing') {
        throw new ApiRequestError(
          400,
          JSON.stringify({
            code: 'GIVEAWAY_CLAIM_MISSING_CHANNELS',
            missingChannelIds: ['extra-0'],
          }),
          'Подписка не подтверждена.',
        );
      }
      participant = { ...participant, winnerStatus: 'CLAIMED', canClaim: false };
      return {
        ok: true,
        winner: {
          id: 'winner',
          prizeId: 'prize',
          prizePosition: 1,
          prizeTitle: 'Скрытый приз',
          prizeDisplayTitle: 'Скрытый приз',
          entryId: participant.entryId,
          userId: 'test-user',
          displayName: 'Участник',
          status: 'CLAIMED',
          selectedAt: new Date(now).toISOString(),
          claimDeadlineAt: participant.claimDeadlineAt,
          claimedAt: new Date().toISOString(),
          deliveredAt: null,
          expiredAt: null,
          rerolledAt: null,
        },
      };
    }
    if (path.endsWith('/me')) {
      if (fixture.mode === 'read-error') throw new Error('Статус временно недоступен');
      return { ...participant };
    }
    if (fixture.mode === 'public-error') throw new Error('Розыгрыш временно недоступен');
    return { ...data, serverTime: new Date().toISOString() };
  },
} as ApiTransport;
const editor = new URLSearchParams(location.search).has('editor');
const editorApi = editor ? createPreviewApiTransport() : null;
let queueNextRefresh = false;
if (editorApi) {
  const path = '/chats/preview-chat/giveaways/giveaway-chat-1';
  const request = editorApi.request;
  editorApi.request = async (requestPath, init) => {
    if (queueNextRefresh && requestPath.endsWith('/refresh-publication')) {
      queueNextRefresh = false;
      throw new ApiRequestError(
        409,
        JSON.stringify({ code: 'GIVEAWAY_RESULTS_SYNC_PENDING' }),
        'Итоги ожидают обновления в MAX.',
      );
    }
    return request(requestPath, init);
  };
  Object.assign(window, {
    queueNextGiveawayRefresh: () => {
      queueNextRefresh = true;
    },
    finishEmptyGiveaway: async () => {
      const latest = (await editorApi.request(path)) as { draftRevision: number };
      await editorApi.request(`${path}/publish`, {
        method: 'POST',
        body: JSON.stringify({ expectedRevision: latest.draftRevision }),
      });
      await editorApi.request(`${path}/close`, { method: 'POST' });
      await client.invalidateQueries();
    },
    changeDraftInAnotherSession: async () => {
      const latest = (await editorApi.request(path)) as {
        draftRevision: number;
        prizes: unknown[];
      };
      await editorApi.request(path, {
        method: 'PUT',
        body: JSON.stringify({
          ...latest,
          title: 'Версия второго организатора',
          requiredChannelIds: ['external-partner'],
          requiredChannels: [
            {
              id: 'external-partner',
              title: 'Гостевой канал',
              link: 'https://max.ru/giveaway-guest',
            },
          ],
          expectedRevision: latest.draftRevision,
        }),
      });
    },
  });
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <MemoryRouter initialEntries={['/giveaways/browser-test']}>
      {editorApi ? (
        <ToastProvider>
          <ManagedGiveawayCard
            api={editorApi}
            entityId="preview-chat"
            entityType="chat"
            onClosePanel={() => undefined}
          />
        </ToastProvider>
      ) : (
        <Routes>
          <Route path="/giveaways/:giveawayId" element={<GiveawayPage api={api} />} />
        </Routes>
      )}
    </MemoryRouter>
  </QueryClientProvider>,
);
