import type { PrismaService } from '../prisma/prisma.service';
import { MaxClientService, type MaxChatMemberAccess } from './max-client.service';
import { AutomaticDeleteAuthorAccessService } from './automatic-delete-author-access.service';
import type { StorageRuntimeMetricsService } from '../system/storage-runtime-metrics.service';
import { OptimizationRuntimeMetrics } from '../system/optimization-runtime-metrics';

const ordinary: MaxChatMemberAccess = {
  userId: '123',
  isBot: false,
  isAdmin: false,
  isOwner: false,
  permissions: [],
};
const options = { botId: 'major', bypassCache: true, timeoutMs: 5000 } as const;

function fixture(initialized = true, isAdmin = false) {
  const metrics = {
    optimization: new OptimizationRuntimeMetrics(),
    registerAutomaticDeleteAuthorSnapshot: jest.fn(),
  } satisfies Pick<
    StorageRuntimeMetricsService,
    'optimization' | 'registerAutomaticDeleteAuthorSnapshot'
  >;
  const query = jest
    .fn<ReturnType<PrismaService['$queryRaw']>, Parameters<PrismaService['$queryRaw']>>()
    .mockResolvedValue([{ initialized, isAdmin, revision: 'revision-1' }]);
  const getMember = jest
    .fn<
      ReturnType<MaxClientService['getChatMemberAccess']>,
      Parameters<MaxClientService['getChatMemberAccess']>
    >()
    .mockResolvedValue(ordinary);
  const service = new AutomaticDeleteAuthorAccessService(
    { $queryRaw: query } as unknown as PrismaService,
    { getChatMemberAccess: getMember } as unknown as MaxClientService,
    metrics as unknown as StorageRuntimeMetricsService,
  );
  return { service, query, getMember, metrics };
}

describe('automatic DELETE author authority', () => {
  it('counts actual skips, required reads, shared reads and errors by a finite module', async () => {
    const s = fixture();
    await s.service.resolve('chat', '123', options, { requireMembership: false, module: 'links' });
    await s.service.withDispatchScope(() =>
      Promise.all([
        s.service.resolve('chat', '123', options, { requireMembership: true, module: 'profanity' }),
        s.service.resolve('chat', '123', options, { requireMembership: true, module: 'stopWords' }),
      ]),
    );
    s.query.mockRejectedValue(new Error('private-db-error'));
    await expect(
      s.service.resolve('chat', '123', options, { requireMembership: false, module: 'links' }),
    ).rejects.toThrow('private-db-error');
    const snapshot = s.metrics.optimization.snapshot()!;
    expect(snapshot.authors.links).toMatchObject({
      calls: 2,
      rosterSkips: 1,
      memberCalls: 0,
      errors: 1,
    });
    expect(snapshot.authors.profanity).toMatchObject({
      membershipRequired: 1,
      memberCalls: 1,
      rosterSkips: 0,
    });
    expect(snapshot.authors.stopWords).toMatchObject({
      membershipRequired: 1,
      sharedReads: 1,
      memberCalls: 0,
    });
    expect(snapshot.timings.author).toMatchObject({ calls: 4, errors: 1 });
    expect(s.getMember).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(snapshot)).not.toContain('private');
  });

  it('counts a protected bootstrap author as skipped, not as a member call or initialized roster', async () => {
    const s = fixture(false, true);
    await s.service.resolve('chat', '123', options, {
      requireMembership: true,
      module: 'profanity',
    });
    expect(s.metrics.optimization.snapshot()!.authors.profanity).toMatchObject({
      calls: 1,
      protectedSkips: 1,
      missingRoster: 1,
      memberCalls: 0,
      rosterSkips: 0,
    });
  });
  it('uses a complete saved roster without an external author-role lookup', async () => {
    const s = fixture();
    await expect(
      s.service.resolve('chat', '123', options, { requireMembership: false }),
    ).resolves.toMatchObject({ initialized: true, isAdmin: false, member: undefined });
    expect(s.getMember).not.toHaveBeenCalled();
  });

  it('protects a saved administrator even before complete roster bootstrap', async () => {
    const s = fixture(false, true);
    expect(
      (await s.service.resolve('chat', '123', options, { requireMembership: true })).isAdmin,
    ).toBe(true);
    expect(s.getMember).not.toHaveBeenCalled();
  });

  it('retains an actual missing-membership result without fabricating a regular member', async () => {
    const s = fixture();
    s.getMember.mockResolvedValue(null);
    await expect(
      s.service.resolve('chat', '123', options, { requireMembership: true }),
    ).resolves.toMatchObject({ isAdmin: false, member: null });
    expect(s.getMember).toHaveBeenCalledTimes(1);
  });

  it('shares one real membership read only inside one attempt and one bot route', async () => {
    const s = fixture();
    const read = (botId = 'major') =>
      s.service.resolve('chat', '123', { ...options, botId }, { requireMembership: true });
    await s.service.withDispatchScope(async () => {
      await Promise.all([read(), read(), read()]);
      expect(s.query).toHaveBeenCalledTimes(1);
      expect(s.getMember).toHaveBeenCalledTimes(1);
      await read('rex');
      expect(s.getMember).toHaveBeenCalledTimes(2);
    });
    await s.service.withDispatchScope(() => read());
    expect(s.getMember).toHaveBeenCalledTimes(3);
    await read();
    expect(s.getMember).toHaveBeenCalledTimes(4);
  });

  it('keeps legacy fresh role authority until a complete roster exists', async () => {
    const s = fixture(false);
    s.getMember.mockResolvedValue({ ...ordinary, isAdmin: true });
    await expect(
      s.service.resolve('chat', '123', options, { requireMembership: false }),
    ).resolves.toMatchObject({ initialized: false, isAdmin: true });
    expect(s.getMember).toHaveBeenCalledWith(
      'chat',
      '123',
      expect.objectContaining({ bypassCache: true }),
    );
  });

  it('allows the accepted unseen promotion while keeping real membership evidence', async () => {
    const s = fixture();
    s.getMember.mockResolvedValue({ ...ordinary, isAdmin: true });
    await expect(
      s.service.resolve('chat', '123', options, { requireMembership: true }),
    ).resolves.toMatchObject({ initialized: true, isAdmin: false, member: { isAdmin: true } });
  });

  it('rechecks saved protection after awaited preparation and does not reuse the old snapshot', async () => {
    const s = fixture();
    await s.service.withDispatchScope(async () => {
      await s.service.resolve('chat', '123', options, { requireMembership: false });
      s.query.mockResolvedValue([{ initialized: true, isAdmin: true, revision: 'new-grant' }]);
      expect((await s.service.readCurrentProtection('chat', '123')).isAdmin).toBe(true);
    });
    expect(s.query).toHaveBeenCalledTimes(2);
    expect(s.getMember).not.toHaveBeenCalled();
  });

  it('preserves storage uncertainty without starting fallback MAX probes', async () => {
    const s = fixture();
    const unavailable = new Error('database unavailable');
    s.query.mockRejectedValue(unavailable);
    await expect(
      s.service.resolve('chat', '123', options, { requireMembership: false }),
    ).rejects.toBe(unavailable);
    expect(s.getMember).not.toHaveBeenCalled();
  });
});
