import { ModerationService } from './moderation.service';
import type {
  ChannelAutoPostExecutionPlan,
  ManagedChannelContext,
} from './moderation.service.support';

type ScanTask = {
  processChannelAutoPostButtons(): Promise<void>;
  processManagedChannelAutoPostButtons(channel: ManagedChannelContext): Promise<void>;
};

describe('channel scan scheduled task', () => {
  const role = process.env.APP_ROLE;
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (role === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = role;
  });

  function fixture() {
    const service = new ModerationService({} as never, {} as never, {} as never, {} as never);
    const plan: ChannelAutoPostExecutionPlan = {
      batchSize: 1,
      interChannelDelayMs: 0,
      maxNewMessagesPerScan: 1,
    };
    const resolvePlan = jest
      .fn<Promise<ChannelAutoPostExecutionPlan | null>, []>()
      .mockResolvedValue(plan);
    const run = jest.fn().mockResolvedValue(undefined);
    const warn = jest.fn();
    Object.assign(service, {
      prisma: { channelSettings: { findMany: jest.fn() } },
      backgroundTasksEnabled: true,
      channelAutoPostScanMaxChannels: 1,
      channelAutoPostScanIntervalMs: 100,
      channelAutoPostStartupDelayMs: 10,
      channelAutoPostStartupJitterMs: 0,
      resolveChannelAutoPostExecutionPlan: resolvePlan,
      channelAutoPostScanRuntime: { run },
      logger: { warn, log: jest.fn() },
    });
    return { service, task: service as unknown as ScanTask, plan, resolvePlan, run, warn };
  }

  it('reserves the scan before awaiting its execution plan', async () => {
    const f = fixture();
    let finish!: (plan: ChannelAutoPostExecutionPlan) => void;
    f.resolvePlan.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const first = f.task.processChannelAutoPostButtons();
    const second = f.task.processChannelAutoPostButtons();
    expect(f.resolvePlan).toHaveBeenCalledTimes(1);
    finish(f.plan);
    await Promise.all([first, second]);
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it.each(['plan', 'query'] as const)(
    'contains a shared %s failure and allows the next scan',
    async (stage) => {
      const f = fixture();
      const failure = new Error('private database detail');
      if (stage === 'plan') f.resolvePlan.mockRejectedValueOnce(failure);
      else f.run.mockRejectedValueOnce(failure);
      await expect(f.task.processChannelAutoPostButtons()).resolves.toBeUndefined();
      expect(f.warn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(f.warn.mock.calls)).not.toContain(failure.message);
      await f.task.processChannelAutoPostButtons();
      expect(f.run).toHaveBeenCalledTimes(stage === 'plan' ? 1 : 2);
    },
  );

  it('releases the reservation when pressure suppresses a scan', async () => {
    const f = fixture();
    f.resolvePlan.mockResolvedValueOnce(null);
    await f.task.processChannelAutoPostButtons();
    expect(f.run).not.toHaveBeenCalled();
    await f.task.processChannelAutoPostButtons();
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it.each(['startup', 'interval'] as const)(
    'contains a failure from the %s timer and continues',
    async (timer) => {
      jest.useFakeTimers();
      process.env.APP_ROLE = 'moderation';
      const f = fixture();
      f.run.mockRejectedValueOnce(new Error('private query failure'));
      f.service.onModuleInit();
      if (timer === 'interval') {
        await jest.advanceTimersByTimeAsync(10);
        f.run.mockClear();
        f.run.mockRejectedValueOnce(new Error('private query failure'));
        f.warn.mockClear();
        await jest.advanceTimersByTimeAsync(90);
      } else {
        await jest.advanceTimersByTimeAsync(10);
      }
      expect(f.warn).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(100);
      expect(f.run).toHaveBeenCalledTimes(2);
      f.service.onModuleDestroy();
    },
  );

  it('does not use a default bot when the channel has no exact scan route', async () => {
    const f = fixture();
    const listMessages = jest.fn();
    const accessLoss = jest.fn();
    Object.assign(f.service, {
      channelAutoPostScanManager: { isDue: () => true },
      resolveUnifiedBotRoute: jest.fn().mockResolvedValue(null),
      maxBotLinkService: { resolveBotIdForCapability: jest.fn().mockResolvedValue(null) },
      maxClient: { listMessages },
      recordChannelAutoPostAccessLossIfTerminal: accessLoss,
    });
    await f.task.processManagedChannelAutoPostButtons({
      channelSettings: { chatId: 'channel-a' },
    } as ManagedChannelContext);
    expect(listMessages).not.toHaveBeenCalled();
    expect(accessLoss).not.toHaveBeenCalled();
  });
});
