import type { Prisma, ChannelSettings } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { ChannelAutoPostScanManager } from './channel-auto-post-runtime';
import { ChannelAutoPostScanRuntime } from './channel-auto-post-scan-runtime';

type Candidate = Pick<
  ChannelSettings,
  | 'chatId'
  | 'quickButtonsEnabled'
  | 'postSignatureEnabled'
  | 'commentsEnabled'
  | 'postSuggestionsEnabled'
>;
type ScanInput = Parameters<ChannelAutoPostScanRuntime['run']>[0];

function candidate(chatId: string, enabled = true): Candidate {
  return {
    chatId,
    quickButtonsEnabled: enabled,
    postSignatureEnabled: false,
    commentsEnabled: false,
    postSuggestionsEnabled: false,
  };
}

function fixture(rows: Candidate[], marketplaceIds: string[] = [], batchSize = 1) {
  const visits: string[] = [];
  const findMany = jest.fn(async (query: Prisma.ChannelSettingsFindManyArgs) => {
    const filter = query.where?.chatId;
    if (query.include) {
      const selected = typeof filter === 'object' && filter !== null ? filter.in : [];
      const ids = Array.isArray(selected) ? selected : [];
      return ids.flatMap((id) => {
        const row = rows.find((item) => item.chatId === id);
        return row ? [{ ...row, chat: { admins: [] } }] : [];
      });
    }
    const after = typeof filter === 'object' && filter !== null ? filter.gt : undefined;
    return rows
      .filter((row) => typeof after !== 'string' || row.chatId > after)
      .sort((a, b) => (a.chatId < b.chatId ? -1 : a.chatId > b.chatId ? 1 : 0))
      .slice(0, query.take ?? undefined);
  });
  const manager = new ChannelAutoPostScanManager({
    scanIntervalMs: 1_000,
    scanMaxChannels: batchSize,
    idleBackoffMaxMs: 8_000,
    repairSweepMs: 5_000,
    rateLimitBackoffMs: 100,
    throttleBackoffMaxMs: 500,
    now: () => 10_000,
  });
  const input: ScanInput = {
    prisma: { channelSettings: { findMany } } as unknown as PrismaService,
    manager,
    plan: { batchSize, interChannelDelayMs: 0, maxNewMessagesPerScan: 1 },
    maxClient: {
      listMarketplaceChannelPostTargets: jest.fn<
        ReturnType<NonNullable<ScanInput['maxClient']['listMarketplaceChannelPostTargets']>>,
        Parameters<NonNullable<ScanInput['maxClient']['listMarketplaceChannelPostTargets']>>
      >(async (limit, after) =>
        marketplaceIds
          .filter((id) => !after || id > after)
          .sort()
          .slice(0, limit)
          .map((chatId) => ({ chatId })),
      ),
    },
    demand: {
      selectChannels: jest
        .fn<
          ReturnType<ScanInput['demand']['selectChannels']>,
          Parameters<ScanInput['demand']['selectChannels']>
        >()
        .mockResolvedValue([]),
      process: jest.fn<
        ReturnType<ScanInput['demand']['process']>,
        Parameters<ScanInput['demand']['process']>
      >(async (channel) => {
        visits.push(`demand:${channel.channelSettings.chatId}`);
      }),
    },
    recovery: {
      runIfDue: jest
        .fn<
          ReturnType<ScanInput['recovery']['runIfDue']>,
          Parameters<ScanInput['recovery']['runIfDue']>
        >()
        .mockResolvedValue({
          status: 'not_due',
          deferReason: null,
          stopCurrentTick: false,
          scannedCandidates: 0,
          remoteLookups: 0,
          mutationAttempts: 0,
          terminalizedCandidates: 0,
        }),
    },
    processChannel: jest.fn<
      ReturnType<ScanInput['processChannel']>,
      Parameters<ScanInput['processChannel']>
    >(async (channel) => {
      visits.push(channel.channelSettings.chatId);
    }),
    sleep: jest.fn().mockResolvedValue(undefined),
    isTransientLookupError: jest.fn().mockReturnValue(false),
    onGlobalBackoff: jest.fn(),
    onFailure: jest.fn(),
    scanIntervalMs: 1_000,
    rateLimitBackoffMs: 100,
  };
  const runtime = new ChannelAutoPostScanRuntime();
  return { input, runtime, findMany, manager, visits };
}

describe('bounded channel auto-post candidate scans', () => {
  it('advances past disabled pages and carries due candidates until each is visited', async () => {
    const rows = Array.from({ length: 133 }, (_, index) =>
      candidate(`channel-${String(index).padStart(3, '0')}`, index >= 130),
    );
    const { input, runtime, findMany, visits } = fixture(rows);
    for (let tick = 0; tick < 5; tick += 1) await runtime.run(input);

    expect(visits).toEqual(['channel-130', 'channel-131', 'channel-132']);
    const pages = findMany.mock.calls.map(([query]) => query).filter((query) => query.select);
    expect(pages).toHaveLength(3);
    expect(pages.map((query) => query.where)).toEqual([
      undefined,
      { chatId: { gt: 'channel-063' } },
      { chatId: { gt: 'channel-127' } },
    ]);
    expect(pages.every((query) => query.take === 64)).toBe(true);
    expect(pages.every((query) => query.orderBy && !Array.isArray(query.orderBy))).toBe(true);
  });

  it('wraps after deleted cursor rows and eventually visits new rows on either side', async () => {
    const rows = Array.from({ length: 65 }, (_, index) =>
      candidate(`channel-${String(index).padStart(3, '0')}`, false),
    );
    rows[64] = candidate('channel-064');
    const { input, runtime, visits } = fixture(rows);
    await runtime.run(input);
    rows.splice(63, 1);
    rows.push(candidate('channel-020a'), candidate('channel-063a'));
    await runtime.run(input);
    await runtime.run(input);
    await runtime.run(input);

    expect(visits).toContain('channel-063a');
    expect(visits).toContain('channel-064');
    expect(visits).toContain('channel-020a');
  });

  it('alternates regular and marketplace candidates with one available slot', async () => {
    const regular = ['regular-1', 'regular-2', 'regular-3', 'regular-4'];
    const marketplace = ['market-1', 'market-2', 'market-3', 'market-4'];
    const rows = [
      ...regular.map((id) => candidate(id)),
      ...marketplace.map((id) => candidate(id, false)),
    ];
    const { input, runtime, visits } = fixture(rows, marketplace);
    for (let tick = 0; tick < 8; tick += 1) await runtime.run(input);

    expect(visits).toEqual([
      'regular-1',
      'market-1',
      'regular-2',
      'market-2',
      'regular-3',
      'market-3',
      'regular-4',
      'market-4',
    ]);
  });

  it('retains fallback candidates while durable demand occupies a pass', async () => {
    const rows = [
      candidate('a'),
      candidate('b'),
      candidate('demand-1', false),
      candidate('demand-2', false),
    ];
    const { input, runtime, visits } = fixture(rows, [], 2);
    const select = input.demand.selectChannels as jest.MockedFunction<
      typeof input.demand.selectChannels
    >;
    select.mockResolvedValueOnce([{ chatId: 'demand-1' }, { chatId: 'demand-2' }]);
    await runtime.run(input);
    await runtime.run(input);

    expect(visits).toEqual(['demand:demand-1', 'demand:demand-2', 'a', 'b']);
  });

  it('does not run candidates in a scoped cooldown', async () => {
    const { input, runtime, manager, visits } = fixture([candidate('a'), candidate('b')]);
    manager.recordTransientThrottle('a', true, 60_000);
    await runtime.run(input);
    expect(visits).toEqual(['b']);
  });

  it('retains the selected page if loading channel contexts fails', async () => {
    const { input, runtime, findMany, visits } = fixture([candidate('a'), candidate('b')], [], 2);
    const find = findMany.getMockImplementation()!;
    findMany.mockImplementationOnce(find).mockRejectedValueOnce(new Error('context unavailable'));

    await expect(runtime.run(input)).rejects.toThrow('context unavailable');
    await runtime.run(input);
    expect(visits).toEqual(['a', 'b']);
    expect(findMany.mock.calls.filter(([query]) => query.select)).toHaveLength(1);
  });

  it('retains unvisited candidates when a global throttle stops the batch', async () => {
    const { input, runtime, visits } = fixture([candidate('a'), candidate('b')], [], 2);
    const process = input.processChannel as jest.MockedFunction<typeof input.processChannel>;
    const isTransient = input.isTransientLookupError as jest.MockedFunction<
      typeof input.isTransientLookupError
    >;
    process.mockRejectedValueOnce(new Error('transient'));
    isTransient.mockReturnValue(true);

    await runtime.run(input);
    await runtime.run(input);
    expect(visits).toEqual(['b']);
    expect(input.onGlobalBackoff).toHaveBeenCalledTimes(1);
  });
});
