import { ForbiddenException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../../prisma/prisma-client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StatisticsExchangeGrantsService } from './statistics-exchange-grants.service';
import { StatisticsExchangeRuntimeService } from './statistics-exchange-runtime.service';
import type { StatisticsExchangeStatisticsService } from './statistics-exchange-statistics.service';

describe('statistics access failure diagnostics', () => {
  const privateDetail = 'private peer response, actor, SQL and credential';
  const originalRole = process.env.APP_ROLE;
  beforeEach(() => {
    process.env.APP_ROLE = 'action';
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (originalRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = originalRole;
  });

  it.each([
    [
      new ServiceUnavailableException({
        code: 'MARKETPLACE_ACCESS_PENDING',
        message: privateDetail,
      }),
      'ACCESS_PENDING',
    ],
    [new ForbiddenException(privateDetail), 'ACCESS_DENIED'],
    [new ServiceUnavailableException(privateDetail), 'REMOTE_UNAVAILABLE'],
    [
      new Prisma.PrismaClientKnownRequestError(privateDetail, {
        code: 'P2034',
        clientVersion: 'test',
      }),
      'STORE_CONFLICT',
    ],
    [
      new Prisma.PrismaClientKnownRequestError(privateDetail, {
        code: 'P2010',
        clientVersion: 'test',
        meta: { code: '40001', message: privateDetail },
      }),
      'STORE_CONFLICT',
    ],
    [
      new Prisma.PrismaClientKnownRequestError(privateDetail, {
        code: 'P2010',
        clientVersion: 'test',
        meta: { code: '42703', message: privateDetail },
      }),
      'STORE_ERROR',
    ],
    [new Error(privateDetail), 'UNKNOWN'],
  ])('reports only a fixed code for %p', async (error, failureCode) => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const refreshRequestedAccess = jest
      .fn<
        ReturnType<StatisticsExchangeGrantsService['refreshRequestedAccess']>,
        Parameters<StatisticsExchangeGrantsService['refreshRequestedAccess']>
      >()
      .mockRejectedValue(error);
    const grants = { refreshRequestedAccess } satisfies Pick<
      StatisticsExchangeGrantsService,
      'refreshRequestedAccess'
    >;
    const runtime = new StatisticsExchangeRuntimeService(
      {} as PrismaService,
      new ConfigService({
        STATISTICS_CENTRAL_ENABLED: true,
        STATISTICS_CENTRAL_MODE: 'CENTRAL',
        SVYAZKA_ANALYTICS_TOKEN: 'fixture',
      }),
      {} as StatisticsExchangeStatisticsService,
      grants as unknown as StatisticsExchangeGrantsService,
    );
    await expect(runtime.refreshAccessBatch()).resolves.toBeUndefined();
    expect(refreshRequestedAccess).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith({ failureCode }, 'EXCHANGE_ACCESS_UNAVAILABLE');
    expect(JSON.stringify(warn.mock.calls)).not.toContain(privateDetail);
    await runtime.onModuleDestroy();
  });
});
