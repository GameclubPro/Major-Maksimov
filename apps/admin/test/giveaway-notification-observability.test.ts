import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DeleteDesk } from '../src/delete-desk';
import { safetyDeskDeleteRuntimeResponseSchema } from '@maxim/contracts/safety-desk';
import {
  giveawayWinnerNotificationEventAt,
  matchesGiveawayWinnerNotificationQuery,
} from '../src/giveaway-notification-observability';

const item = {
  notificationId: 'notification-1',
  giveawayId: 'giveaway-1',
  giveawayTitle: 'Главный приз',
  sourceChatId: 'channel-1',
  winnerId: 'winner-1',
  userId: 'user-1',
  botId: 'bot-1',
  status: 'AMBIGUOUS' as const,
  attemptCount: 2,
  lastError: 'MAX send timed out',
  nextAttemptAt: '2026-07-18T12:00:00.000Z',
  lockedAt: null,
  dispatchedAt: '2026-07-18T12:01:00.000Z',
  ambiguousAt: '2026-07-18T12:02:00.000Z',
  createdAt: '2026-07-18T11:59:00.000Z',
  updatedAt: '2026-07-18T12:03:00.000Z',
};

const runtime = safetyDeskDeleteRuntimeResponseSchema.parse({
  generatedAt: '2026-07-18T12:04:00.000Z',
  rolloutMode: 'on',
  summary: {
    total: 0,
    open: 0,
    failed: 0,
    statusCounts: {
      OBSERVED: 0,
      PENDING: 0,
      IN_PROGRESS: 0,
      RETRYABLE: 0,
      WAITING_CAPABILITY: 0,
      AMBIGUOUS: 0,
      SUCCEEDED: 0,
      ALREADY_ABSENT: 0,
      EXPIRED: 0,
      FAILED_TERMINAL: 0,
    },
    due: { count: 0, oldestAt: null },
    staleLeases: { count: 0, oldestAt: null },
    ambiguousSends: { count: 0, oldestAt: null },
    giveawayWinnerNotificationDeadEnds: {
      count: 51,
      ambiguous: 51,
      failedTerminal: 0,
      oldestAt: item.createdAt,
    },
    oldestOpen: { createdAt: null, ageMs: null },
  },
  items: [],
  ambiguousSends: [],
  giveawayWinnerNotificationDeadEnds: [item],
});

test('parses bounded giveaway winner notification dead ends in the Safety Desk contract', () => {
  const parsed = runtime;

  assert.equal(parsed.giveawayWinnerNotificationDeadEnds[0]?.notificationId, 'notification-1');
  assert.throws(
    () =>
      safetyDeskDeleteRuntimeResponseSchema.parse({
        ...parsed,
        giveawayWinnerNotificationDeadEnds: Array.from({ length: 51 }, (_, index) => ({
          ...item,
          notificationId: `notification-${index}`,
        })),
      }),
    /Too big|maximum|50/u,
  );
});

test('filters dead-end notifications and displays their event time', () => {
  assert.equal(matchesGiveawayWinnerNotificationQuery(item, 'главный'), true);
  assert.equal(matchesGiveawayWinnerNotificationQuery(item, 'winner-1'), true);
  assert.equal(matchesGiveawayWinnerNotificationQuery(item, 'unrelated'), false);
  assert.equal(giveawayWinnerNotificationEventAt(item), item.ambiguousAt);
});

test('distinguishes overdue results and offers exact lookup beyond the notification sample', () => {
  const snapshot = {
    ...runtime,
    giveawayPendingResults: {
      hasMore: false,
      items: [
        {
          giveawayId: 'older-id',
          sourceChatId: 'chat',
          title: 'Подарок',
          status: 'DUE' as const,
          nextAttemptAt: runtime.generatedAt,
          overdueMs: 60_000,
          attempts: 2,
          claimDeadlineAt: null,
        },
      ],
    },
  };
  const noop = () => {};
  const html = renderToStaticMarkup(
    createElement(DeleteDesk, {
      busyAmbiguousSendId: null,
      busyDeleteIntentId: null,
      filter: 'all',
      query: 'older-id',
      runtime: snapshot,
      selectedItem: undefined,
      visibleItems: [],
      onFilterChange: noop,
      onAllowAmbiguousSendRetry: noop,
      onQueryChange: noop,
      onRetryDeleteIntent: noop,
      onSelect: noop,
    }),
  );
  assert.match(html, /Задержка 1 мин/u);
  assert.match(html, /В показанных уведомлениях совпадений нет/u);
  assert.match(html, /Найти по точному ID уведомления/u);
});
