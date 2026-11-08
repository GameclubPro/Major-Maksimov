import type { PrismaService } from '../prisma/prisma.service';
import { MaxClientService, type MaxChatMemberAccess } from './max-client.service';
import { AutomaticDeleteAuthorAccessService } from './automatic-delete-author-access.service';

const ordinary: MaxChatMemberAccess = {
  userId: '123',
  isBot: false,
  isAdmin: false,
  isOwner: false,
  permissions: [],
};
const options = { botId: 'major', bypassCache: true, timeoutMs: 5000 } as const;

function fixture(initialized = true, isAdmin = false) {
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
  );
  return { service, query, getMember };
}

describe('automatic DELETE author authority', () => {
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
