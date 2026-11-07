import { ConfigService } from '@nestjs/config';
import { GlobalSpammerArchiveRunnerService } from './global-spammer-archive-runner.service';
import type { GlobalSpammerIntelligenceService } from './global-spammer-intelligence.service';

type Maintenance = Pick<
  GlobalSpammerIntelligenceService,
  'archiveExpiredRegistryEntries' | 'pruneExpiredRawEvidence'
>;

describe('global spammer archive runner', () => {
  const previousRole = process.env.APP_ROLE;
  let runner: GlobalSpammerArchiveRunnerService | undefined;
  let maintenance: jest.Mocked<Maintenance>;

  beforeEach(() => {
    jest.useFakeTimers();
    process.env.APP_ROLE = 'admin';
    maintenance = {
      archiveExpiredRegistryEntries: jest
        .fn<
          ReturnType<Maintenance['archiveExpiredRegistryEntries']>,
          Parameters<Maintenance['archiveExpiredRegistryEntries']>
        >()
        .mockResolvedValue({
          ok: true,
          dryRun: false,
          cutoff: new Date().toISOString(),
          scanned: 0,
          archived: 0,
          deleted: 0,
          remainingExpired: null,
        }),
      pruneExpiredRawEvidence: jest
        .fn<
          ReturnType<Maintenance['pruneExpiredRawEvidence']>,
          Parameters<Maintenance['pruneExpiredRawEvidence']>
        >()
        .mockResolvedValue({
          ok: true,
          cutoff: new Date().toISOString(),
          scanned: 0,
          pruned: 0,
        }),
    };
  });

  afterEach(() => {
    runner?.onModuleDestroy();
    runner = undefined;
    jest.useRealTimers();
    if (previousRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = previousRole;
  });

  it('opts out of whole-backlog measurement on startup and scheduled maintenance', async () => {
    runner = new GlobalSpammerArchiveRunnerService(
      maintenance as unknown as GlobalSpammerIntelligenceService,
      new ConfigService(),
    );
    runner.onModuleInit();
    await jest.advanceTimersByTimeAsync(60000);
    expect(maintenance.archiveExpiredRegistryEntries).toHaveBeenCalledTimes(1);
    expect(maintenance.archiveExpiredRegistryEntries).toHaveBeenLastCalledWith({
      limit: 1000,
      countRemainingExpired: false,
    });
    await jest.advanceTimersByTimeAsync(6 * 60 * 60 * 1000 - 60000);
    expect(maintenance.archiveExpiredRegistryEntries).toHaveBeenCalledTimes(2);
    expect(maintenance.archiveExpiredRegistryEntries).toHaveBeenLastCalledWith({
      limit: 1000,
      countRemainingExpired: false,
    });
    expect(maintenance.pruneExpiredRawEvidence).toHaveBeenCalledTimes(2);
  });

  it('does not start archive maintenance in the action role', async () => {
    process.env.APP_ROLE = 'action';
    runner = new GlobalSpammerArchiveRunnerService(
      maintenance as unknown as GlobalSpammerIntelligenceService,
      new ConfigService(),
    );
    runner.onModuleInit();
    await jest.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(maintenance.archiveExpiredRegistryEntries).not.toHaveBeenCalled();
    expect(maintenance.pruneExpiredRawEvidence).not.toHaveBeenCalled();
  });
});
