import { Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { extractSqlText } from './admin-service-test-support';

const captureRawCall = (...args: Parameters<PrismaService['$queryRaw']>) => args;

describe('admin SQL inspection', () => {
  it('preserves nested SQL fragments and bound values in a tagged raw call', () => {
    const table = Prisma.sql`chat_moderation_feed_items`;
    const filter = Prisma.sql`WHERE chat_id = ${'chat-1'} AND action IN (${Prisma.join(['BAN', 'KICK'])})`;
    const call = captureRawCall`SELECT * FROM ${table} feed ${filter}${Prisma.empty} ORDER BY id DESC LIMIT ${3}`;

    expect(extractSqlText(call)).toBe(
      'SELECT * FROM chat_moderation_feed_items feed WHERE chat_id = chat-1 AND action IN (BAN,KICK) ORDER BY id DESC LIMIT 3',
    );
  });

  it('keeps identical ordering for a prepared Prisma SQL object without mutating its values', () => {
    const query = Prisma.sql`SELECT ${'first'}::text FROM ${Prisma.sql`feed_items`} WHERE id = ${'second'} AND rank < ${7}`;
    const expected = 'SELECT first::text FROM feed_items WHERE id = second AND rank < 7';

    expect(extractSqlText(query)).toBe(expected);
    expect(extractSqlText(captureRawCall(query))).toBe(expected);
    expect(query.values).toEqual(['first', 'second', 7]);
  });

  it('does not mistake an ordinary array parameter for a tagged template call', () => {
    const call = captureRawCall`SELECT ${['one', 'two']}::text[] AS items WHERE id = ${'last'}`;

    expect(extractSqlText(call)).toBe('SELECT one two::text[] AS items WHERE id = last');
    expect(extractSqlText(['ordinary', 'diagnostic', 'parts'])).toBe('ordinary diagnostic parts');
  });
});
