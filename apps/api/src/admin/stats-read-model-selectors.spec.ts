import {
  resolveChannelStatsPartialEdgeRanges,
  selectChannelStatsContentBucketRows,
  selectChannelStatsMembershipBucketRows,
  selectModerationFeedReadModelRows,
} from './stats-read-model-selectors';
import { extractSqlText } from './admin-service-test-support';

describe('stats read model selectors', () => {
  it('reads moderation snapshot names through bounded primary-key lookups', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const prisma = { $queryRaw: queryRaw };

    await selectModerationFeedReadModelRows(prisma as never, {
      chatId: 'chat-1',
      from: new Date('2026-07-01T00:00:00.000Z'),
      to: new Date('2026-07-14T00:00:00.000Z'),
      filter: 'ALL',
      cursor: null,
      limit: 51,
    });

    const sqlText = extractSqlText(queryRaw.mock.calls[0]);
    expect(sqlText).toContain('FROM chat_user_display_names AS snapshot');
    expect(sqlText).toContain('snapshot.chat_id = feed.chat_id');
    expect(sqlText).toContain('snapshot.user_id = feed.user_id');
    expect(sqlText).not.toContain('LEFT JOIN LATERAL');
    expect(sqlText).not.toContain('chat_membership_activity_feed_items membership');
  });

  it('resolves channel stats raw edge ranges around complete hourly rollups', () => {
    const from = new Date('2026-03-01T10:15:00.000Z');
    const to = new Date('2026-03-07T12:45:00.000Z');

    const ranges = resolveChannelStatsPartialEdgeRanges(
      from,
      to,
      new Date('2026-03-01T11:00:00.000Z'),
      new Date('2026-03-07T12:00:00.000Z'),
      true,
    );

    expect(
      ranges.map((range) => ({
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        toInclusive: range.toInclusive,
      })),
    ).toEqual([
      {
        from: '2026-03-01T10:15:00.000Z',
        to: '2026-03-01T11:00:00.000Z',
        toInclusive: false,
      },
      {
        from: '2026-03-07T12:00:00.000Z',
        to: '2026-03-07T12:45:00.000Z',
        toInclusive: true,
      },
    ]);
  });

  it('queries channel stats membership edges as two bounded ranges', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const prisma = {
      $queryRaw: queryRaw,
    };

    await selectChannelStatsMembershipBucketRows(prisma as never, {
      chatId: 'channel-1',
      from: new Date('2026-03-01T10:15:00.000Z'),
      to: new Date('2026-03-07T12:45:00.000Z'),
      bucket: 'hour',
    });

    const sqlText = extractSqlText(queryRaw.mock.calls[0]);
    expect(sqlText).toContain('FROM chat_membership_activity_feed_items');
    expect(sqlText).toContain('event_at <');
    expect(sqlText).toContain('event_at <=');
    expect(sqlText).not.toContain('AND NOT (event_at');
  });

  it('groups daily channel stats buckets on Moscow day boundaries', async () => {
    const queryRaw = jest.fn().mockResolvedValue([]);
    const prisma = {
      $queryRaw: queryRaw,
    };

    const params = {
      chatId: 'channel-1',
      from: new Date('2026-03-06T21:30:00.000Z'),
      to: new Date('2026-03-07T20:30:00.000Z'),
      bucket: 'day' as const,
    };

    await selectChannelStatsMembershipBucketRows(prisma as never, params);
    await selectChannelStatsContentBucketRows(prisma as never, params);

    const membershipSqlText = extractSqlText(queryRaw.mock.calls[0]);
    expect(membershipSqlText).toContain("bucket_start + INTERVAL '3 hours'");
    expect(membershipSqlText).toContain("event_at + INTERVAL '3 hours'");
    expect(membershipSqlText).toContain("- INTERVAL '3 hours'");

    const contentSqlText = extractSqlText(queryRaw.mock.calls[1]);
    expect(contentSqlText).toContain("bucket_start + INTERVAL '3 hours'");
    expect(contentSqlText).toContain("published_at + INTERVAL '3 hours'");
    expect(contentSqlText).toContain("- INTERVAL '3 hours'");
  });
});
