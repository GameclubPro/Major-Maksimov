import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import type { MaxChatMemberAccess, MaxClientService } from '../max/max-client.service';
import { Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  createAdminServiceFixture,
  createChatContextCacheMock,
  createConfigMock,
  createPrismaMock,
  extractSqlText,
} from './admin-service-test-support';

const captureRawCall = (...args: Parameters<PrismaService['$queryRaw']>) => args;

describe('admin SQL inspection', () => {
  it('preserves nested SQL fragments and bound values in a tagged raw call', () => {
    const table = Prisma.sql`chat_moderation_feed_items`;
    const filter = Prisma.sql`WHERE chat_id = ${'chat-1'} AND action IN (${Prisma.join(['BAN', 'KICK'])})`;
    const call = captureRawCall`SELECT * FROM ${table} feed ${filter}${Prisma.empty} ORDER BY id DESC LIMIT ${3}`;

    expect(extractSqlText(call)).toBe(
      'SELECT * FROM chat_moderation_feed_items feed WHERE chat_id = chat-1 AND action IN (BAN,KICK) ORDER BY id DESC LIMIT 3',
    );
  });

  it('keeps identical ordering for a prepared Prisma SQL object without mutating its values', () => {
    const query = Prisma.sql`SELECT ${'first'}::text FROM ${Prisma.sql`feed_items`} WHERE id = ${'second'} AND rank < ${7}`;
    const expected = 'SELECT first::text FROM feed_items WHERE id = second AND rank < 7';

    expect(extractSqlText(query)).toBe(expected);
    expect(extractSqlText(captureRawCall(query))).toBe(expected);
    expect(query.values).toEqual(['first', 'second', 7]);
  });

  it('does not mistake an ordinary array parameter for a tagged template call', () => {
    const call = captureRawCall`SELECT ${['one', 'two']}::text[] AS items WHERE id = ${'last'}`;

    expect(extractSqlText(call)).toBe('SELECT one two::text[] AS items WHERE id = last');
    expect(extractSqlText(['ordinary', 'diagnostic', 'parts'])).toBe('ordinary diagnostic parts');
  });
});

describe('AdminService feature fixture authorization', () => {
  it('models exact settings protection without consuming independent action or business SQL mocks', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockResolvedValueOnce([{ business: 'reserved result' }]);
    const selfAccess = jest.fn<
      ReturnType<MaxClientService['getCurrentChatMemberAccess']>,
      Parameters<MaxClientService['getCurrentChatMemberAccess']>
    >();
    const client = {
      getChatAdminIds: jest
        .fn<
          ReturnType<MaxClientService['getChatAdminIds']>,
          Parameters<MaxClientService['getChatAdminIds']>
        >()
        .mockResolvedValue(['id123']),
      getCurrentChatMemberAccess: selfAccess,
    };
    const service = createAdminServiceFixture(
      prisma as unknown as PrismaService,
      client as unknown as MaxClientService,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.assertManagedEntityAdminAccess('chat-1', '123', 'chat'),
    ).resolves.toBeUndefined();

    expect(prisma).not.toHaveProperty('managedEntityAccessEdge');
    expect(client.getChatAdminIds).toHaveBeenCalledTimes(1);
    expect(client.getChatAdminIds).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({ bypassCache: true }),
    );
    expect(selfAccess).not.toHaveBeenCalled();
    expect(prisma.chatAdminAllowlist.upsert).toHaveBeenCalledWith({
      where: { chatId_userId: { chatId: 'chat-1', userId: '123' } },
      create: { chatId: 'chat-1', userId: '123' },
      update: {},
    });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    await expect(prisma.$queryRaw(Prisma.sql`SELECT 'business'`)).resolves.toEqual([
      { business: 'reserved result' },
    ]);
  });

  it('preserves a configured administrator denial', async () => {
    const prisma = createPrismaMock();
    const client = {
      getChatAdminIds: jest
        .fn<
          ReturnType<MaxClientService['getChatAdminIds']>,
          Parameters<MaxClientService['getChatAdminIds']>
        >()
        .mockResolvedValue([]),
    };
    const service = createAdminServiceFixture(
      prisma as unknown as PrismaService,
      client as unknown as MaxClientService,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.assertManagedEntityAdminAccess('chat-1', '123', 'chat'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.chatAdminAllowlist.upsert).not.toHaveBeenCalled();
  });

  it('leaves a supplied incomplete exact actor response unknown', async () => {
    const prisma = createPrismaMock();
    const incompleteActor: MaxChatMemberAccess = {
      userId: '123',
      isAdmin: true,
      isOwner: false,
      permissions: [],
      explicitPrivilegeEvidence: true,
    };
    const client = {
      getChatAdminIds: jest
        .fn<
          ReturnType<MaxClientService['getChatAdminIds']>,
          Parameters<MaxClientService['getChatAdminIds']>
        >()
        .mockResolvedValue(['123']),
      getChatMembersAccess: jest
        .fn<
          ReturnType<MaxClientService['getChatMembersAccess']>,
          Parameters<MaxClientService['getChatMembersAccess']>
        >()
        .mockResolvedValue(new Map([['123', incompleteActor]])),
      getCurrentChatMemberAccess: jest
        .fn<
          ReturnType<MaxClientService['getCurrentChatMemberAccess']>,
          Parameters<MaxClientService['getCurrentChatMemberAccess']>
        >()
        .mockResolvedValue({
          userId: '777000',
          isBot: true,
          isAdmin: true,
          isOwner: false,
          permissions: [],
          explicitPrivilegeEvidence: true,
        }),
    };
    const service = createAdminServiceFixture(
      prisma as unknown as PrismaService,
      client as unknown as MaxClientService,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.assertManagedEntityAdminAccess('chat-1', '123', 'chat'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(client.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(client.getChatAdminIds).not.toHaveBeenCalled();
    expect(prisma.chatAdminAllowlist.upsert).not.toHaveBeenCalled();
  });
});
