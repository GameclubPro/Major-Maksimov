import { ServiceUnavailableException } from '@nestjs/common';
import type { Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { SafetyDeskOverviewPendingService } from './safety-desk-overview-pending.service';

function harness() {
  const query = jest.fn();
  const execute = jest.fn().mockResolvedValue(0);
  const transaction = jest.fn(async (run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
    run({ $queryRaw: query, $executeRaw: execute } as unknown as Prisma.TransactionClient),
  );
  const prisma: Pick<PrismaService, '$transaction'> = {
    $transaction: transaction as unknown as PrismaService['$transaction'],
  };
  return {
    service: new SafetyDeskOverviewPendingService(prisma as PrismaService),
    query,
    execute,
    transaction,
  };
}

describe('SafetyDeskOverviewPendingService', () => {
  it('requires the reviewed indexes before any retained-history read and redacts failures', async () => {
    const { service, query, execute, transaction } = harness();
    query.mockResolvedValueOnce([{ ready: false }]);
    await expect(service.getSnapshot(['major'])).rejects.toThrow(ServiceUnavailableException);
    expect(query).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 2_000,
      timeout: 5_000,
    });
    expect(execute.mock.calls.map(([parts]) => parts.join(''))).toEqual([
      'SET TRANSACTION READ ONLY',
      "SET LOCAL statement_timeout = '2000ms'",
      "SET LOCAL lock_timeout = '250ms'",
      'SET LOCAL max_parallel_workers_per_gather = 0',
      'SET LOCAL enable_bitmapscan = off',
    ]);
    query.mockRejectedValueOnce(new Error('postgres://private-password@private-host'));
    await expect(service.getSnapshot(['major'])).rejects.toThrow(
      'Ожидающая работа временно недоступна.',
    );
  });

  it('rejects oversized scope and default-bot drift before opening a transaction', async () => {
    const { service, transaction } = harness();
    await expect(
      service.getSnapshot(Array.from({ length: 33 }, (_, i) => String(i))),
    ).rejects.toThrow(ServiceUnavailableException);
    await expect(service.getSnapshot(['major'], 'foreign')).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(transaction).not.toHaveBeenCalled();
  });

  it('does not turn malformed/future evidence into zero counts', async () => {
    const { service, query } = harness();
    for (const snapshot of [
      null,
      {
        observedAt: new Date().toISOString(),
        invalidClocks: true,
        unfinishedActions: { countLowerBound: 0, truncated: false, oldestStateAt: null },
        bots: [],
      },
    ]) {
      query.mockResolvedValueOnce([{ ready: true }]).mockResolvedValueOnce([{ snapshot }]);
      await expect(service.getSnapshot(['major'])).rejects.toThrow(ServiceUnavailableException);
    }
  });

  it.each([
    { botIds: ['major'] },
    { botIds: ['major', 'major'] },
    { botIds: ['major', 'foreign'] },
  ])('rejects incomplete or misattributed SQL catalog $botIds', async ({ botIds }) => {
    const { service, query } = harness();
    const unfinishedActions = { countLowerBound: 0, truncated: false, oldestStateAt: null };
    const receipts = { countLowerBound: 0, truncated: false, oldestAt: null };
    query.mockResolvedValueOnce([{ ready: true }]).mockResolvedValueOnce([
      {
        snapshot: {
          observedAt: new Date().toISOString(),
          invalidClocks: false,
          unfinishedActions,
          bots: botIds.map((botId) => ({
            botId,
            received: receipts,
            queued: receipts,
            unfinishedActions,
          })),
        },
      },
    ]);
    await expect(service.getSnapshot(['major', 'second'])).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
});
