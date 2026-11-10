import { Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { DeleteDueContinuation } from './moderation-delete-due-selection';

type Lane = 'PENDING' | 'RETRYABLE' | 'WAITING_CAPABILITY' | 'AMBIGUOUS' | 'IN_PROGRESS';
type Candidate = { id: string; createdAt: Date; lane: Lane; eligible: boolean };
type PageRequest = { lane: Lane; limit: number; cutoff: Date; afterId?: string };

const lanes: Lane[] = ['PENDING', 'RETRYABLE', 'WAITING_CAPABILITY', 'AMBIGUOUS', 'IN_PROGRESS'];
const start = new Date('2026-11-10T10:00:00.000Z');
const at = (seconds: number) => new Date(start.getTime() + seconds * 1_000);

function candidate(id: string, lane: Lane = 'PENDING', eligible = true): Candidate {
  return { id, lane, eligible, createdAt: at(-10) };
}

function setup() {
  const queryRaw: jest.MockedFunction<PrismaService['$queryRaw']> = jest.fn();
  queryRaw.mockResolvedValue([]);
  const prisma = { $queryRaw: queryRaw } satisfies Pick<PrismaService, '$queryRaw'>;
  const continuation = new DeleteDueContinuation();
  const select = (now = start, limit = 5, headIds: string[] = []) =>
    continuation.select(prisma, {
      now,
      limit,
      rolloutFilter: Prisma.sql`TRUE`,
      headIds: new Set(headIds),
    });

  function requests(call: number): PageRequest[] {
    const statement = queryRaw.mock.calls[call]?.[0];
    if (!statement || !('text' in statement)) throw new Error('Expected a Prisma SQL query');
    const raw = statement.text.split('SELECT raw."id"')[0]!;
    return [...raw.matchAll(/\(SELECT source\."id"[\s\S]*?LIMIT \$(\d+)\)/gu)].map(
      ([page, limitParameter]) => {
        const laneParameter = page!.match(/CAST\(\$(\d+) AS "ModerationDeleteIntentStatus"\)/u);
        const cutoffParameter = page!.match(/source\."created_at" <= \$(\d+)/u);
        const afterParameter = page!.match(/>\s*\(\$\d+, \$(\d+)\)/u);
        if (!laneParameter || !cutoffParameter) throw new Error('Expected a bounded raw page');
        return {
          lane: statement.values[Number(laneParameter[1]) - 1] as Lane,
          limit: statement.values[Number(limitParameter) - 1] as number,
          cutoff: statement.values[Number(cutoffParameter[1]) - 1] as Date,
          ...(afterParameter
            ? { afterId: statement.values[Number(afterParameter[1]) - 1] as string }
            : {}),
        };
      },
    );
  }

  return { continuation, prisma, queryRaw, select, requests };
}

describe('DELETE due continuation traversal', () => {
  it.each([1, 4, 7, 100])(
    'shares a raw budget of %i without starving a status when the budget is smaller than five',
    async (limit) => {
      const { select, requests } = setup();
      const totals = new Map<Lane, number>(lanes.map((lane) => [lane, 0]));
      for (let turn = 0; turn < lanes.length; turn++) {
        const page = await select(at(turn), limit);
        expect(page.ids).toEqual([]);
        const requested = requests(turn);
        expect(requested.length).toBeGreaterThan(0);
        expect(requested.reduce((sum, row) => sum + row.limit, 0)).toBe(limit);
        expect(requested.every((row) => row.limit > 0)).toBe(true);
        for (const row of requested) totals.set(row.lane, totals.get(row.lane)! + row.limit);
        page.commit();
        page.commit();
      }
      expect([...totals.values()]).toEqual(lanes.map(() => limit));
      if (limit === 1)
        expect(Array.from({ length: 5 }, (_, turn) => requests(turn)[0]!.lane)).toEqual(lanes);
    },
  );

  it('does not advance the raw cursor, frozen horizon or status rotation after a SQL failure', async () => {
    const { queryRaw, select, requests } = setup();
    queryRaw.mockResolvedValueOnce([candidate('a'), candidate('b')]);
    const initial = await select(start, 6);
    initial.commit();

    const failure = new Error('fixture SQL failure');
    queryRaw.mockRejectedValueOnce(failure);
    await expect(select(at(1), 6)).rejects.toBe(failure);
    await select(at(2), 6);

    const failed = requests(1);
    const retried = requests(2);
    expect(failed.find((row) => row.lane === 'PENDING')).toEqual({
      lane: 'PENDING',
      limit: 1,
      cutoff: start,
      afterId: 'b',
    });
    expect(retried.find((row) => row.lane === 'PENDING')).toEqual(
      failed.find((row) => row.lane === 'PENDING'),
    );
    expect(failed.find((row) => row.lane === 'RETRYABLE')?.limit).toBe(2);
    expect(retried.map(({ lane, limit }) => ({ lane, limit }))).toEqual(
      failed.map(({ lane, limit }) => ({ lane, limit })),
    );
  });

  it('keeps an uncommitted page advisory without changing subsequent selection', async () => {
    const { queryRaw, select, requests } = setup();
    queryRaw.mockResolvedValueOnce([candidate('uncommitted')]);
    expect((await select(start, 1)).ids).toEqual([{ id: 'uncommitted' }]);
    await select(at(1), 1);
    expect(requests(1)).toEqual([{ lane: 'PENDING', limit: 1, cutoff: at(1) }]);
  });

  it('advances over head duplicates and ineligible raw rows without nominating them', async () => {
    const { queryRaw, select, requests } = setup();
    queryRaw.mockResolvedValueOnce([
      candidate('existing-head'),
      candidate('ineligible', 'RETRYABLE', false),
      candidate('missing-tail', 'WAITING_CAPABILITY'),
    ]);
    const page = await select(start, 5, ['existing-head']);
    expect(page.ids).toEqual([{ id: 'missing-tail' }]);
    page.commit();
    await select(at(1), 5);
    expect(requests(1)).toEqual(
      expect.arrayContaining([
        { lane: 'PENDING', limit: 1, cutoff: start, afterId: 'existing-head' },
        { lane: 'RETRYABLE', limit: 1, cutoff: start, afterId: 'ineligible' },
        { lane: 'WAITING_CAPABILITY', limit: 1, cutoff: start, afterId: 'missing-tail' },
      ]),
    );
  });

  it('holds the creation horizon through full pages and starts a fresh cycle after an empty page', async () => {
    const { queryRaw, select, requests } = setup();
    queryRaw.mockResolvedValueOnce([candidate('a', 'PENDING', false)]);
    const first = await select(start);
    expect(first.ids).toEqual([]);
    first.commit();
    queryRaw.mockResolvedValueOnce([candidate('b')]);
    (await select(at(1))).commit();
    (await select(at(2))).commit();
    await select(at(3));

    expect(requests(1).find((row) => row.lane === 'PENDING')).toEqual({
      lane: 'PENDING',
      limit: 1,
      cutoff: start,
      afterId: 'a',
    });
    expect(requests(2).find((row) => row.lane === 'PENDING')).toEqual({
      lane: 'PENDING',
      limit: 1,
      cutoff: start,
      afterId: 'b',
    });
    expect(requests(3).find((row) => row.lane === 'PENDING')).toEqual({
      lane: 'PENDING',
      limit: 1,
      cutoff: at(3),
    });
  });

  it('wraps a short raw page and loses only advisory traversal state on restart', async () => {
    const { continuation, prisma, queryRaw, select, requests } = setup();
    queryRaw.mockResolvedValueOnce([candidate('short')]);
    (await select(start, 10)).commit();
    await select(at(1), 10);
    expect(requests(1).find((row) => row.lane === 'PENDING')).toEqual({
      lane: 'PENDING',
      limit: 2,
      cutoff: at(1),
    });

    queryRaw.mockResolvedValueOnce([candidate('before-restart')]);
    (
      await continuation.select(prisma, {
        now: at(2),
        limit: 5,
        rolloutFilter: Prisma.sql`TRUE`,
        headIds: new Set(),
      })
    ).commit();
    await new DeleteDueContinuation().select(prisma, {
      now: at(3),
      limit: 1,
      rolloutFilter: Prisma.sql`TRUE`,
      headIds: new Set(),
    });
    expect(requests(3)).toEqual([{ lane: 'PENDING', limit: 1, cutoff: at(3) }]);
  });

  it('revisits a failed tail handoff after wrap while allowing an independent status to progress', async () => {
    const { queryRaw, select, requests } = setup();
    queryRaw.mockResolvedValueOnce([candidate('failed-tail')]);
    queryRaw.mockResolvedValueOnce([candidate('independent-tail', 'RETRYABLE')]);
    for (let turn = 2; turn < 10; turn++) queryRaw.mockResolvedValueOnce([]);
    queryRaw.mockResolvedValueOnce([candidate('failed-tail')]);

    const failedPage = await select(start, 1);
    const handoffs = await Promise.allSettled([
      Promise.reject(new Error('fixture per-job handoff failure')),
    ]);
    expect(handoffs[0]?.status).toBe('rejected');
    // FLAG: Cursor progress follows settled scheduling attempts, including rejection.
    // The durable due intent is retried after wrap; this never records an effect outcome.
    failedPage.commit();
    const independent = await select(at(1), 1);
    expect(independent.ids).toEqual([{ id: 'independent-tail' }]);
    independent.commit();
    for (let turn = 2; turn < 10; turn++) (await select(at(turn), 1)).commit();
    const retried = await select(at(10), 1);

    expect(requests(5)).toEqual([
      { lane: 'PENDING', limit: 1, cutoff: start, afterId: 'failed-tail' },
    ]);
    expect(requests(10)).toEqual([{ lane: 'PENDING', limit: 1, cutoff: at(10) }]);
    expect(retried.ids).toEqual([{ id: 'failed-tail' }]);
  });
});
