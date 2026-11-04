import {
  PublisherAutoReplyDeliveryStatus,
  type Prisma,
  type PublisherAutoReplyDelivery,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type {
  PublisherAutoReplyJobEnsureResult,
  PublisherAutoReplyQueueService,
} from './publisher-auto-reply.queue';
import {
  PublisherAutoReplyRecoveryService,
  type PublisherAutoReplyRecoveryResult,
} from './publisher-auto-reply-recovery.service';
import type { PublisherAutoReplyUploadRecoveryRow } from './publisher-auto-reply-upload-recovery';

type Delivery = Pick<
  PublisherAutoReplyDelivery,
  'id' | 'status' | 'dueAt' | 'lockedAt' | 'lockToken' | 'dispatchStartedAt'
>;
const now = new Date('2026-08-29T12:10:00.000Z');
const dueAt = new Date('2026-08-29T12:00:00.000Z');
const staleLease = new Date('2026-08-29T12:01:00.000Z');

function delivery(id: string, overrides: Partial<Delivery> = {}): Delivery {
  return {
    id,
    status: PublisherAutoReplyDeliveryStatus.PENDING,
    dueAt,
    lockedAt: null,
    lockToken: null,
    dispatchStartedAt: null,
    ...overrides,
  };
}
function page(): Delivery[] {
  return Array.from({ length: 100 }, (_, index) =>
    delivery(`delivery-${String(index).padStart(3, '0')}`),
  );
}
function uploadResult(
  overrides: Partial<PublisherAutoReplyUploadRecoveryRow> = {},
): PublisherAutoReplyUploadRecoveryRow[] {
  return [
    {
      changed_count: 0n,
      candidate_count: 0n,
      last_id: null,
      last_locked_at: null,
      last_updated_at: null,
      ...overrides,
    },
  ];
}
function fixture(rows: Delivery[] = []) {
  const deliveryQuery = jest
    .fn<Promise<Delivery[]>, [Prisma.Sql]>()
    .mockImplementation(async (query) => {
      const pending = query.text.includes("status = 'PENDING'");
      const nullLease = query.text.includes('locked_at IS NULL');
      const take = query.values.at(-1) as number;
      const cutoff = query.values[0] as Date;
      const cursorId = query.text.includes(' > ') ? (query.values.at(-2) as string) : null;
      const cursorAt = cursorId && !nullLease ? (query.values.at(-3) as Date) : null;
      const time = (row: Delivery) => (pending ? row.dueAt : row.lockedAt);
      return rows
        .filter((row) => {
          if (row.status !== (pending ? 'PENDING' : 'SENDING')) return false;
          const at = time(row);
          if (nullLease ? at !== null : at === null || at > cutoff) return false;
          if (!cursorId) return true;
          return nullLease
            ? row.id > cursorId
            : at! > cursorAt! || (+at! === +cursorAt! && row.id > cursorId);
        })
        .sort(
          (left, right) =>
            Number(time(left)) - Number(time(right)) ||
            (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
        )
        .slice(0, take);
    });
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const uploadQuery = jest
    .fn<Promise<PublisherAutoReplyUploadRecoveryRow[]>, [Prisma.Sql]>()
    .mockResolvedValue(uploadResult());
  const executeRaw = jest
    .fn<
      ReturnType<Prisma.TransactionClient['$executeRaw']>,
      Parameters<Prisma.TransactionClient['$executeRaw']>
    >()
    .mockResolvedValue(0);
  const transaction = jest
    .fn<ReturnType<PrismaService['$transaction']>, Parameters<PrismaService['$transaction']>>()
    .mockImplementation(async (operation) =>
      operation({
        $executeRaw: executeRaw,
        $queryRaw: (query: Prisma.Sql) => deliveryQuery(query),
      } as unknown as Prisma.TransactionClient),
    );
  const prisma = {
    publisherAutoReplyDelivery: { updateMany },
    $transaction: transaction,
    $queryRaw: (query: Prisma.Sql) => {
      if (!query.text.includes('publisher_auto_reply_asset_uploads')) {
        throw new Error('Delivery reads require the page transaction');
      }
      return uploadQuery(query);
    },
  };
  const queue = {
    ensureDeliveryJob: jest
      .fn<
        ReturnType<PublisherAutoReplyQueueService['ensureDeliveryJob']>,
        Parameters<PublisherAutoReplyQueueService['ensureDeliveryJob']>
      >()
      .mockResolvedValue({ outcome: 'add_acknowledged' }),
  } satisfies Pick<PublisherAutoReplyQueueService, 'ensureDeliveryJob'>;
  const service = new PublisherAutoReplyRecoveryService(
    prisma as unknown as PrismaService,
    queue as never,
    { dispatchEnabled: true } as never,
    { isGloballyPaused: jest.fn().mockResolvedValue(false) } as never,
    { assertAttested: jest.fn().mockResolvedValue(undefined) } as never,
    {
      runExclusive: jest.fn(
        (_lane: string, operation: () => Promise<PublisherAutoReplyRecoveryResult>) => operation(),
      ),
    } as never,
  );
  return { service, rows, deliveryQuery, updateMany, uploadQuery, queue, executeRaw, transaction };
}
function pendingSelections(h: ReturnType<typeof fixture>): Prisma.Sql[] {
  return h.deliveryQuery.mock.calls
    .map(([query]) => query)
    .filter((query) => query.text.includes("status = 'PENDING'"));
}

describe('PublisherAutoReplyRecoveryService', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('refuses an unprotected delivery read without effects or cursor progress when planner setup fails', async () => {
    const h = fixture([delivery('first')]);
    const failure = new Error('Planner setup refused');
    h.executeRaw.mockRejectedValueOnce(failure);
    await expect(h.service.recoverOnce(now)).rejects.toBe(failure);
    expect(h.deliveryQuery).not.toHaveBeenCalled();
    expect(h.updateMany).not.toHaveBeenCalled();
    expect(h.queue.ensureDeliveryJob).not.toHaveBeenCalled();
    expect(h.uploadQuery).not.toHaveBeenCalled();

    await expect(h.service.recoverOnce(now)).resolves.toMatchObject({
      scanned: 1,
      addAcknowledged: 1,
      errors: 0,
    });
    expect(pendingSelections(h)[0]!.values).toEqual([now, 100]);
    expect(h.queue.ensureDeliveryJob).toHaveBeenCalledWith('first', dueAt);
  });

  it('requeues pending/pre-send work and quarantines a stale send fence', async () => {
    const preparing = delivery('preparing-1', {
      status: PublisherAutoReplyDeliveryStatus.SENDING,
      lockedAt: staleLease,
      lockToken: 'stale-lock',
    });
    const fenced = delivery('fenced-1', {
      status: PublisherAutoReplyDeliveryStatus.SENDING,
      lockedAt: staleLease,
      lockToken: 'stale-fence',
      dispatchStartedAt: staleLease,
    });
    const h = fixture([delivery('pending-1'), preparing, fenced]);
    h.uploadQuery.mockResolvedValue(uploadResult({ changed_count: 2n, candidate_count: 2n }));
    await expect(h.service.recoverOnce(now)).resolves.toEqual({
      scanned: 3,
      alreadyLive: 0,
      addAcknowledged: 2,
      reset: 1,
      ambiguous: 1,
      uploadsReset: 2,
      errors: 0,
      alreadyRunning: false,
      budgetExhausted: false,
    });
    expect(h.queue.ensureDeliveryJob.mock.calls).toEqual([
      ['pending-1', dueAt],
      ['preparing-1', dueAt],
    ]);
    expect(h.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'fenced-1',
        status: PublisherAutoReplyDeliveryStatus.SENDING,
        lockedAt: staleLease,
        lockToken: 'stale-fence',
        dispatchStartedAt: staleLease,
      },
      data: {
        status: PublisherAutoReplyDeliveryStatus.AMBIGUOUS,
        lockedAt: null,
        lockToken: null,
        failureCode: 'STALE_SEND_FENCE',
        failureMessage: null,
      },
    });
    expect(h.uploadQuery).toHaveBeenCalledTimes(1);
  });

  it('continues beyond a full page of live jobs on the next recovery pass', async () => {
    const tail = delivery('delivery-100');
    const h = fixture([...page(), tail]);
    h.queue.ensureDeliveryJob.mockImplementation(async (id) => ({
      outcome: id === tail.id ? 'add_acknowledged' : 'already_live',
    }));
    await expect(h.service.recoverOnce(now)).resolves.toMatchObject({
      scanned: 100,
      alreadyLive: 100,
      addAcknowledged: 0,
    });
    h.queue.ensureDeliveryJob.mockClear();
    await expect(h.service.recoverOnce(now)).resolves.toMatchObject({
      scanned: 1,
      alreadyLive: 0,
      addAcknowledged: 1,
    });
    expect(h.queue.ensureDeliveryJob.mock.calls).toEqual([['delivery-100', dueAt]]);
    expect(pendingSelections(h)[1]!.values).toEqual([now, dueAt, 'delivery-099', 100]);
  });

  it.each(['empty', 'short'] as const)(
    'wraps after a fully consumed %s page and finds earlier work',
    async (lastPage) => {
      const earlier = delivery('earlier', { dueAt: new Date(dueAt.getTime() - 1) });
      const h = fixture([...page(), ...(lastPage === 'short' ? [delivery('delivery-100')] : [])]);
      await h.service.recoverOnce(now);
      await h.service.recoverOnce(now);
      h.rows.push(earlier);
      h.queue.ensureDeliveryJob.mockClear();
      await h.service.recoverOnce(now);
      expect(pendingSelections(h)[1]!.values).toContain('delivery-099');
      expect(pendingSelections(h)[2]!.values).toEqual([now, 100]);
      expect(h.queue.ensureDeliveryJob).toHaveBeenNthCalledWith(1, earlier.id, earlier.dueAt);
    },
  );

  it('advances past a failed ensure while preserving the original failure outcome', async () => {
    const h = fixture([...page(), delivery('delivery-100')]);
    h.queue.ensureDeliveryJob.mockImplementation(async (id) => {
      if (id === 'delivery-099')
        throw Object.assign(new Error('Redis unavailable'), { code: 'REDIS' });
      return { outcome: 'add_acknowledged' };
    });
    await expect(h.service.recoverOnce(now)).resolves.toMatchObject({
      scanned: 100,
      addAcknowledged: 99,
      errors: 1,
    });
    await h.service.recoverOnce(now);
    expect(pendingSelections(h)[1]!.values).toEqual([now, dueAt, 'delivery-099', 100]);
    expect(h.queue.ensureDeliveryJob).toHaveBeenLastCalledWith('delivery-100', dueAt);
  });

  it('does not queue a stale preparation after losing its exact lease CAS', async () => {
    const stale = delivery('preparing', {
      status: PublisherAutoReplyDeliveryStatus.SENDING,
      lockedAt: staleLease,
      lockToken: 'old-token',
    });
    const h = fixture([stale, delivery('independent')]);
    h.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(h.service.recoverOnce(now)).resolves.toMatchObject({
      scanned: 2,
      reset: 0,
      addAcknowledged: 1,
    });
    expect(h.updateMany.mock.calls[0]![0].where).toEqual({
      id: 'preparing',
      status: PublisherAutoReplyDeliveryStatus.SENDING,
      dispatchStartedAt: null,
      lockedAt: staleLease,
      lockToken: 'old-token',
    });
    expect(h.queue.ensureDeliveryJob.mock.calls).toEqual([['independent', dueAt]]);
  });

  it('rotates recovery families within a shared budget and seeks leases independently of due order', async () => {
    const stale = Array.from({ length: 101 }, (_, index) =>
      delivery(`stale-${String(index).padStart(3, '0')}`, {
        status: PublisherAutoReplyDeliveryStatus.SENDING,
        lockedAt: staleLease,
        lockToken: `lease-${index}`,
        dueAt: new Date(dueAt.getTime() - index),
      }),
    );
    const legacyNull = delivery('legacy-null', {
      status: PublisherAutoReplyDeliveryStatus.SENDING,
    });
    const h = fixture([...page(), ...stale, legacyNull]);
    h.queue.ensureDeliveryJob.mockResolvedValue({ outcome: 'already_live' });
    for (let pass = 0; pass < 3; pass += 1) {
      expect((await h.service.recoverOnce(now)).scanned).toBeLessThanOrEqual(100);
    }
    expect(h.queue.ensureDeliveryJob).toHaveBeenCalledWith(stale[100]!.id, stale[100]!.dueAt);
    expect(h.queue.ensureDeliveryJob).toHaveBeenCalledWith(legacyNull.id, legacyNull.dueAt);
    const sendingQueries = h.deliveryQuery.mock.calls
      .map(([query]) => query)
      .filter((query) => query.text.includes("status = 'SENDING' AND locked_at <="));
    expect(sendingQueries[1]!.values).toContain('stale-099');
    expect(sendingQueries[1]!.values).toContain(staleLease);
  });

  it('holds the eligibility cutoff until wrap, then admits newly due work', async () => {
    const nextNow = new Date(now.getTime() + 30_000);
    const future = delivery('future', { dueAt: new Date(now.getTime() + 10_000) });
    const h = fixture([...page(), future]);
    await h.service.recoverOnce(now);
    h.rows.length = 0;
    h.rows.push(future);
    await h.service.recoverOnce(nextNow);
    expect(h.queue.ensureDeliveryJob).not.toHaveBeenCalledWith(future.id, future.dueAt);
    expect(pendingSelections(h)[1]!.values[0]).toEqual(now);
    await h.service.recoverOnce(nextNow);
    expect(h.queue.ensureDeliveryJob).toHaveBeenCalledWith(future.id, future.dueAt);
  });

  it('moves the upload cursor beyond skipped locks and resets it only after exhaustion', async () => {
    const h = fixture();
    h.uploadQuery
      .mockResolvedValueOnce(
        uploadResult({
          candidate_count: 100n,
          last_id: 'locked-099',
          last_locked_at: staleLease,
          last_updated_at: dueAt,
        }),
      )
      .mockResolvedValueOnce(uploadResult({ changed_count: 1n, candidate_count: 1n }));
    await expect(h.service.recoverOnce(now)).resolves.toMatchObject({ uploadsReset: 0 });
    await expect(h.service.recoverOnce(now)).resolves.toMatchObject({ uploadsReset: 1 });
    await h.service.recoverOnce(now);
    expect(h.uploadQuery.mock.calls[1]![0].values).toContain('locked-099');
    expect(h.uploadQuery.mock.calls[1]![0].values).toContain(dueAt);
    expect(h.uploadQuery.mock.calls[2]![0].values).not.toContain('locked-099');
  });

  it('awaits an unknown enqueue result beyond the soft budget, then resumes unvisited rows', async () => {
    jest.useFakeTimers();
    const h = fixture([delivery('first'), delivery('second')]);
    let acknowledge!: (value: PublisherAutoReplyJobEnsureResult) => void;
    const pending = new Promise<PublisherAutoReplyJobEnsureResult>((resolve) => {
      acknowledge = resolve;
    });
    h.queue.ensureDeliveryJob.mockReturnValueOnce(pending);
    h.uploadQuery.mockResolvedValue(uploadResult({ changed_count: 2n, candidate_count: 2n }));
    const first = h.service.recoverOnce(now);
    await jest.advanceTimersByTimeAsync(6_000);
    const coalesced = h.service.recoverOnce(now);
    expect(h.deliveryQuery).toHaveBeenCalledTimes(1);
    expect(h.queue.ensureDeliveryJob).toHaveBeenCalledTimes(1);
    expect(h.uploadQuery).not.toHaveBeenCalled();
    acknowledge({ outcome: 'add_acknowledged' });
    await expect(first).resolves.toMatchObject({
      scanned: 1,
      addAcknowledged: 1,
      uploadsReset: 2,
      budgetExhausted: true,
      alreadyRunning: false,
    });
    await expect(coalesced).resolves.toMatchObject({ alreadyRunning: true });
    expect(h.uploadQuery).toHaveBeenCalledTimes(1);
    await expect(h.service.recoverOnce(now)).resolves.toMatchObject({
      scanned: 1,
      addAcknowledged: 1,
      budgetExhausted: false,
    });
    expect(pendingSelections(h)[1]!.values).toEqual([now, dueAt, 'first', 100]);
    expect(h.queue.ensureDeliveryJob).toHaveBeenLastCalledWith('second', dueAt);
  });
});
