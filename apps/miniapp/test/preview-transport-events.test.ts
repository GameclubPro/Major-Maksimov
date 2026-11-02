import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChannelStatsResponse } from '@maxim/contracts/channel-stats';
import type { ChatParticipantDetails, ChatSanctionsPage } from '@maxim/contracts';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';

test('preview former participants keep sanctions independent from immunity and expose local ban release', async () => {
  const api = createPreviewApiTransport();
  const details = (await api.request(
    '/chats/preview-chat/members/preview-old-ban?range=7d',
  )) as ChatParticipantDetails;
  assert.equal(details.membershipStatus, 'left');
  assert.equal(details.canManage, false);
  assert.equal(details.canMute, true);
  assert.equal(details.canBan, true);
  await api.request('/chats/preview-chat/members/preview-old-ban/moderation-action', {
    method: 'POST',
    body: JSON.stringify({ action: 'BAN', scope: 'current_chat' }),
  });
  const sanctions = (await api.request(
    '/chats/preview-chat/sanctions?status=active&userId=preview-old-ban',
  )) as ChatSanctionsPage;
  assert.equal(sanctions.items.length, 1);
  assert.equal(sanctions.items[0]?.banOnRejoin, true);
  assert.equal(sanctions.items[0]?.releaseAction, 'UNBAN');
  const unknown = (await api.request(
    '/chats/preview-chat/members/unseen-user?range=7d',
  )) as ChatParticipantDetails;
  assert.equal(unknown.canMute, false);
  assert.equal(unknown.canBan, false);
});

test('preview channel ban adds one departure without changing chat moderation', async () => {
  const api = createPreviewApiTransport();
  const readActivity = () =>
    api.request('/channels/preview-channel/activity-feed?range=7d') as Promise<{
      items: Array<{ userId: string; type: string }>;
    }>;
  const before = await readActivity();
  const member = before.items.find(
    (item, index, items) =>
      item.type === 'joined' && items.findIndex((entry) => entry.userId === item.userId) === index,
  )!;
  const chatsBefore = await api.request('/chats/preview-chat/moderation-feed?range=7d');
  const result = (await api.request(`/channels/preview-channel/members/${member.userId}/ban`, {
    method: 'POST',
  })) as { action: string; message: string };
  assert.equal(result.action, 'BAN');
  assert.equal(result.message, 'Бан включён.');
  const after = await readActivity();
  assert.equal(after.items.length, before.items.length + 1);
  assert.equal(after.items[0]?.userId, member.userId);
  assert.equal(after.items[0]?.type, 'left');
  await assert.rejects(
    api.request(`/channels/preview-channel/members/${member.userId}/ban`, { method: 'POST' }),
  );
  assert.deepEqual(await api.request('/chats/preview-chat/moderation-feed?range=7d'), chatsBefore);
});

test('slow moderation preview holds only the action and writes one event after completion', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const api = createPreviewApiTransport({ search: '?moderationState=slow' });
  const readFeed = () =>
    api.request('/chats/preview-chat/moderation-feed?range=7d') as Promise<{
      items: Array<{ id: string }>;
    }>;
  const before = await readFeed();
  let completed = false;
  const action = api
    .request('/chats/preview-chat/members/sergey-market/moderation-action', {
      method: 'POST',
      body: JSON.stringify({ action: 'BAN', scope: 'current_chat' }),
    })
    .then((result) => {
      completed = true;
      return result;
    });

  assert.equal((await readFeed()).items.length, before.items.length);
  assert.equal(completed, false);
  t.mock.timers.tick(799);
  await Promise.resolve();
  assert.equal(completed, false);
  t.mock.timers.tick(1);
  await action;
  assert.equal(completed, true);
  assert.equal((await readFeed()).items.length, before.items.length + 1);
});

test('preview channel stats marks empty view buckets with zero posts', async () => {
  const api = createPreviewApiTransport();

  const stats = (await api.request(
    '/channels/preview-channel/stats?range=24h',
  )) as ChannelStatsResponse;
  const currentViews = stats.official.series.views;
  const currentMembership = stats.official.series.membership;
  const currentParticipants = stats.official.series.participants;
  const previousViews = stats.comparison.series?.views ?? [];

  assert.equal(stats.period.bucket, 'hour');
  assert.equal(currentViews.length > 0, true);
  assert.equal(previousViews.length > 0, true);
  assert.deepEqual(
    currentMembership.map((point) => point.at),
    currentViews.map((point) => point.at),
  );
  assert.deepEqual(
    currentParticipants.map((point) => point.at),
    currentViews.map((point) => point.at),
  );
  for (let index = 1; index < currentViews.length; index += 1) {
    assert.equal(
      Date.parse(currentViews[index]!.at) - Date.parse(currentViews[index - 1]!.at),
      60 * 60 * 1000,
    );
  }
  assert.equal(
    currentViews.some((point) => point.posts > 0),
    true,
  );
  assert.equal(
    currentViews.some((point) => point.posts === 0 && point.views === 0),
    true,
  );
  assert.equal(
    previousViews.every((point) => Number.isInteger(point.posts)),
    true,
  );
  assert.equal(stats.summary.daily.at(-1)?.source, 'flow');
  assert.equal(stats.summary.daily.at(-1)?.confidence, 'medium');
});

test('preview channel stats overview mirrors production lightweight fields', async () => {
  const api = createPreviewApiTransport();

  const stats = (await api.request(
    '/channels/preview-channel/stats?range=7d&mode=overview&includeActivityPreview=false',
  )) as ChannelStatsResponse;
  const expectedAverage = Math.round(
    stats.official.content.views / Math.max(1, stats.official.content.posts),
  );

  assert.equal(stats.official.content.topPosts.length, 0);
  assert.equal(stats.official.content.topReactions.length, 0);
  assert.equal(stats.signals.bestWindows.length, 0);
  assert.equal(stats.comparison.series, undefined);
  assert.equal(stats.comparison.deltas.averageViewsPerPost.current, expectedAverage);
  assert.equal(stats.activityFeed.items.length, 0);
});

test('preview post-age reach metrics stay fixed across chart ranges', async () => {
  const api = createPreviewApiTransport();
  const stats24h = (await api.request(
    '/channels/preview-channel/stats?range=24h&mode=full',
  )) as ChannelStatsResponse;
  const stats30d = (await api.request(
    '/channels/preview-channel/stats?range=30d&mode=full',
  )) as ChannelStatsResponse;

  const { asOf: asOf24h, ...reach24h } = stats24h.summary.reach;
  const { asOf: asOf30d, ...reach30d } = stats30d.summary.reach;
  assert.deepEqual(reach24h, reach30d);
  assert.equal(Number.isFinite(Date.parse(asOf24h ?? '')), true);
  assert.equal(Number.isFinite(Date.parse(asOf30d ?? '')), true);
  assert.equal(stats24h.summary.reach.method, 'post-age-cohort');
  assert.equal(stats24h.summary.reach.coverage24h, 'ready');
  assert.equal(stats24h.summary.reach.coverage48h, 'ready');
  assert.equal(
    stats24h.summary.reach.err48Percent,
    Math.round(
      ((stats24h.summary.reach.averageViews48h ?? 0) /
        (stats24h.summary.reach.subscriberDenominator ?? 1)) *
        100 *
        10,
    ) / 10,
  );
});
