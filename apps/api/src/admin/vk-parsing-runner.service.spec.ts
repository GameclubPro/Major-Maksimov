import type { VkParsingService } from './vk-parsing.service';
import { VkParsingRunnerService } from './vk-parsing-runner.service';

describe('VkParsingRunnerService', () => {
  const previousRole = process.env.APP_ROLE;
  const previousServiceName = process.env.APP_SERVICE_NAME;

  beforeEach(() => {
    process.env.APP_ROLE = 'publisher';
    process.env.APP_SERVICE_NAME = 'api-publisher';
  });

  afterEach(() => {
    jest.useRealTimers();
    if (previousRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = previousRole;
    if (previousServiceName === undefined) delete process.env.APP_SERVICE_NAME;
    else process.env.APP_SERVICE_NAME = previousServiceName;
  });

  function createFixture(dispatchEnabled = true) {
    const vkParsingService = {
      getSyncIntervalMs: jest.fn().mockReturnValue(600_000),
      getSchedulerIntervalMs: jest.fn().mockReturnValue(120_000),
      syncDueSources: jest.fn().mockResolvedValue(0),
      reconcileAutoPublishSchedules: jest.fn().mockResolvedValue(0),
      recoverStalePublishJobs: jest.fn().mockResolvedValue(0),
      enqueueDueAutoDeletes: jest.fn().mockResolvedValue(0),
      recoverStalePublisherRollbackJobs: jest.fn().mockResolvedValue(0),
    } satisfies Pick<
      VkParsingService,
      | 'getSyncIntervalMs'
      | 'getSchedulerIntervalMs'
      | 'syncDueSources'
      | 'reconcileAutoPublishSchedules'
      | 'recoverStalePublishJobs'
      | 'enqueueDueAutoDeletes'
      | 'recoverStalePublisherRollbackJobs'
    >;
    const runner = new VkParsingRunnerService(
      vkParsingService as never,
      {
        dispatchEnabled,
      } as never,
    );
    const run = (reason: 'startup' | 'scheduled' = 'scheduled') =>
      (
        runner as unknown as {
          run: (runReason: 'startup' | 'scheduled') => Promise<void>;
        }
      ).run(reason);

    return { runner, run, vkParsingService };
  }

  it('recovers Publisher publish jobs even when Publisher source scheduling fails', async () => {
    const { run, vkParsingService } = createFixture();
    vkParsingService.syncDueSources.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(run()).resolves.toBeUndefined();

    expect(vkParsingService.recoverStalePublishJobs).toHaveBeenCalledTimes(1);
    expect(vkParsingService.reconcileAutoPublishSchedules).toHaveBeenCalledTimes(1);
    expect(vkParsingService.enqueueDueAutoDeletes).toHaveBeenCalledTimes(1);
    expect(vkParsingService.recoverStalePublisherRollbackJobs).toHaveBeenCalledTimes(1);
  });

  it('does not scan or recover while Publisher dispatch is disabled', async () => {
    const { runner, run, vkParsingService } = createFixture(false);

    expect(() => runner.onModuleInit()).not.toThrow();
    await expect(run()).resolves.toBeUndefined();

    expect(vkParsingService.getSyncIntervalMs).not.toHaveBeenCalled();
    expect(vkParsingService.getSchedulerIntervalMs).not.toHaveBeenCalled();
    expect(vkParsingService.syncDueSources).not.toHaveBeenCalled();
    expect(vkParsingService.reconcileAutoPublishSchedules).not.toHaveBeenCalled();
    expect(vkParsingService.recoverStalePublishJobs).not.toHaveBeenCalled();
    expect(vkParsingService.enqueueDueAutoDeletes).not.toHaveBeenCalled();
    expect(vkParsingService.recoverStalePublisherRollbackJobs).not.toHaveBeenCalled();
  });

  it('fails closed outside the exact api-publisher runtime', () => {
    process.env.APP_ROLE = 'action';
    process.env.APP_SERVICE_NAME = 'api-action';
    const { runner, vkParsingService } = createFixture();

    expect(() => runner.onModuleInit()).toThrow('only run inside api-publisher');
    expect(vkParsingService.getSyncIntervalMs).not.toHaveBeenCalled();
    expect(vkParsingService.getSchedulerIntervalMs).not.toHaveBeenCalled();
  });
});
