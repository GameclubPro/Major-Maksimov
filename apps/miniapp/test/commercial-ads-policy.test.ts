import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createDefaultCommercialAdsPolicy,
  type CommercialAdsException,
  type ChatSettingsScreenResponse,
} from '@maxim/contracts/settings';
import {
  commercialExceptionSettingsSearch,
  commercialCategoriesFromMetadata,
  readCommercialExceptionPrefill,
  commercialExceptionExpired,
  commercialPreviewExplanation,
} from '../src/lib/commercial-ads-policy';
import { readModerationRouteFilter } from '../src/lib/statistics-route-query';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';
import {
  previewCommercialAds,
  reportCommercialAdsMistake,
} from '../src/lib/api/commercial-ads-client';
import { getChatModerationFeed } from '../src/lib/api/events-client';
import type { ApiTransport } from '../src/lib/api/transport';

const exception: CommercialAdsException = {
  id: 'a213e5bd-5ef4-4f3c-bca8-c9f975fe1ec2',
  userId: '100000004',
  userName: 'Сергей Маркет',
  categories: ['BUSINESS'],
  expiresAt: null,
};

test('journal handoff preserves an encoded participant and category without accepting unknown identity', () => {
  const input = { userId: '12345', userName: 'Анна & Мастер', category: 'SERVICES' as const };
  const search = commercialExceptionSettingsSearch(input);
  assert.deepEqual(readCommercialExceptionPrefill(search), input);
  assert.equal(new URLSearchParams(search).get('focus'), 'commercialFilter');
  for (const value of ['0', '-5', '12/23', 'user-5', '1e3', '']) {
    assert.equal(
      readCommercialExceptionPrefill(`?commercialUser=${encodeURIComponent(value)}`),
      null,
    );
  }
  assert.deepEqual(
    readCommercialExceptionPrefill('?commercialUser=12&commercialCategory=UNKNOWN'),
    {
      userId: '12',
      userName: 'Участник',
    },
  );
});

test('journal category prefill reads deterministic and AI runtime metadata and rejects unknown categories', () => {
  assert.deepEqual(
    commercialCategoriesFromMetadata({ commercialAdsCategories: ['BUSINESS', 'UNKNOWN'] }),
    ['BUSINESS'],
  );
  assert.deepEqual(
    commercialCategoriesFromMetadata({
      commercialAdsDecision: {
        version: 1,
        categories: ['SERVICES', 'PERSONAL_SALE'],
        result: 'DELETE',
      },
    }),
    ['PERSONAL_SALE', 'SERVICES'],
  );
  assert.deepEqual(commercialCategoriesFromMetadata({ commercialAdsDecision: 'untrusted' }), []);
});

test('exception status changes at its precise deadline and indefinite exceptions stay active', () => {
  const deadline = Date.parse('2026-11-04T15:00:00+03:00');
  assert.equal(commercialExceptionExpired(exception, deadline), false);
  const limited = { ...exception, expiresAt: '2026-11-04T15:00:00+03:00' };
  assert.equal(commercialExceptionExpired(limited, deadline - 1), false);
  assert.equal(commercialExceptionExpired(limited, deadline), true);
});

test('commercial journal filter survives route entry and rejects unrecognized URL filters', () => {
  assert.equal(readModerationRouteFilter('?section=moderation&filter=COMMERCIAL'), 'COMMERCIAL');
  assert.equal(readModerationRouteFilter('?filter=BAN'), 'BAN');
  assert.equal(readModerationRouteFilter('?filter=UNRECOGNIZED'), 'ALL');
  assert.equal(readModerationRouteFilter(''), 'ALL');
});

test('preview client sends exact unsaved policy and author with cancellation, feedback requires receipt', async () => {
  const calls: Array<{ path: string; init?: Parameters<ApiTransport['request']>[1] }> = [];
  const api: ApiTransport = {
    async request(path, init) {
      calls.push({ path, init });
      return path.endsWith('/preview')
        ? {
            decision: 'KEEP',
            categories: ['BUSINESS'],
            reason: 'PARTICIPANT_EXCEPTION',
            matchedExceptionId: exception.id,
          }
        : { ok: true };
    },
    requestKeepalive() {},
  };
  const policy = { ...createDefaultCommercialAdsPolicy(), exceptions: [exception] };
  const controller = new AbortController();
  const input = {
    text: 'Товары в наличии',
    policy,
    enabled: true,
    userId: exception.userId,
    classification: {
      commercialAdsSensitivity: 'STRICT' as const,
      commercialAdsWarnThreshold: 38,
      commercialAdsDeleteThreshold: 55,
    },
  };
  const result = await previewCommercialAds(api, 'chat/1', input, controller.signal);
  assert.equal(calls[0].path, '/chats/chat%2F1/commercial-ads/preview');
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), input);
  assert.equal(calls[0].init?.signal, controller.signal);
  assert.equal(commercialPreviewExplanation(result), 'Для автора действует исключение.');
  await reportCommercialAdsMistake(api, 'chat/1', 'event-42');
  assert.deepEqual(JSON.parse(String(calls[1].init?.body)), { feedItemId: 'event-42' });
  assert.equal(calls[1].path, '/chats/chat%2F1/commercial-ads/feedback');
  await assert.rejects(
    reportCommercialAdsMistake(
      { ...api, request: async () => ({ ok: false }) },
      'chat/1',
      'event-42',
    ),
    /Не удалось отправить/u,
  );
});

test('emulator preview uses draft policy and expiry without mutating saved settings or journal', async () => {
  const api = createPreviewApiTransport();
  const before = (await api.request(
    '/chats/preview-chat/settings-screen',
  )) as ChatSettingsScreenResponse;
  const journalBefore = await getChatModerationFeed(api, 'preview-chat', {
    range: '7d',
    filter: 'COMMERCIAL',
  });
  const policy = { ...createDefaultCommercialAdsPolicy(), exceptions: [exception] };
  const common = { text: 'Товары в наличии', enabled: true, policy };
  assert.equal((await previewCommercialAds(api, 'preview-chat', common)).decision, 'DELETE');
  assert.equal(
    (await previewCommercialAds(api, 'preview-chat', { ...common, userId: exception.userId }))
      .reason,
    'PARTICIPANT_EXCEPTION',
  );
  assert.equal(
    (
      await previewCommercialAds(api, 'preview-chat', {
        ...common,
        policy: { ...policy, exceptions: [{ ...exception, expiresAt: '2000-01-01T00:00:00Z' }] },
        userId: exception.userId,
      })
    ).decision,
    'DELETE',
  );
  assert.equal(
    (await previewCommercialAds(api, 'preview-chat', { ...common, enabled: false })).reason,
    'FILTER_DISABLED',
  );
  const after = (await api.request(
    '/chats/preview-chat/settings-screen',
  )) as ChatSettingsScreenResponse;
  assert.deepEqual(after.settings, before.settings);
  assert.deepEqual(
    await getChatModerationFeed(api, 'preview-chat', { range: '7d', filter: 'COMMERCIAL' }),
    journalBefore,
  );
  assert.ok(journalBefore.items.length > 0);
  assert.equal(
    journalBefore.items.every((item) => item.ruleCode === 'COMMERCIAL_AD'),
    true,
  );
  await reportCommercialAdsMistake(api, 'preview-chat', journalBefore.items[0].id);
  const refreshed = await getChatModerationFeed(api, 'preview-chat', {
    range: '7d',
    filter: 'COMMERCIAL',
  });
  assert.equal(refreshed.items[0].metadata?.commercialFeedbackReported, true);
});

test('mixed offer explanations preserve the scope of allowed and blocked categories', () => {
  assert.equal(
    commercialPreviewExplanation({
      decision: 'KEEP',
      categories: ['SERVICES', 'BUSINESS'],
      reason: 'CATEGORY_ALLOWED',
    }),
    'Эти категории разрешены.',
  );
  assert.equal(
    commercialPreviewExplanation({
      decision: 'DELETE',
      categories: ['SERVICES', 'BUSINESS'],
      reason: 'BLOCKED_CATEGORY',
    }),
    'Есть запрещённая категория.',
  );
});
