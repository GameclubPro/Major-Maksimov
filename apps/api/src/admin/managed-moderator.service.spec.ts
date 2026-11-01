import { randomUUID } from 'node:crypto';
import type { ChatSettings } from '@maxim/contracts';
import { ManagedModeratorService } from './managed-moderator.service';
import { publicModerator } from '../max/max-public-moderator';
import { buildBotAccessSnapshotPersistence } from '../max/bot-access-snapshot.util';

function fixture(
  options: {
    commercialAiDeleteOnly?: boolean;
    memberManagement?: boolean;
    settings?: Partial<ChatSettings>;
  } = {},
) {
  const bots = ['old', 'next'].map((id) => ({ id, state: 'active', contactId: null }));
  const epoch = new Date(Date.now() - 1000);
  const access = buildBotAccessSnapshotPersistence(
    {
      isAdmin: true,
      isOwner: false,
      permissionsKnown: true,
      permissions: [
        'read_all_messages',
        'write',
        ...(options.memberManagement === false ? [] : ['add_remove_members']),
      ],
    },
    { source: 'seed', now: epoch },
  );
  const state = {
    chatId: '-123',
    entityType: 'CHAT',
    primaryBotId: 'old',
    fixedModeratorBotId: 'old',
    routingVersion: 5,
    candidates: bots.map((bot) => ({ botId: bot.id, status: 'ACTIVE', ...access })),
  };
  const db = {
    managedModeratorAssignment: { findUnique: jest.fn().mockResolvedValue(null) },
    chatSettings: { findUnique: jest.fn().mockResolvedValue(options.settings ?? null) },
    channelSettings: { findUnique: jest.fn().mockResolvedValue(null) },
  };
  const links = {
    loadChatExecutionOwnerState: jest.fn().mockResolvedValue(state),
    recordBotAccessProbe: jest.fn().mockResolvedValue(true),
    forgetChatBotBinding: jest.fn(),
    reconcileChatRoutingState: jest.fn().mockResolvedValue(undefined),
  };
  const max = {
    getChatMembersAccess: jest.fn().mockResolvedValue(
      new Map([
        [
          'admin',
          {
            userId: 'admin',
            isAdmin: true,
            isOwner: false,
            isBot: false,
            explicitPrivilegeEvidence: true,
          },
        ],
      ]),
    ),
    getCurrentChatMemberAccess: jest.fn().mockResolvedValue({ isAdmin: true }),
    getChatSnapshot: jest.fn(),
  };
  const assignments = {
    assign: jest.fn().mockImplementation(async (input) => ({
      id: input.operationId,
      routingVersion: 6,
    })),
  };
  const cache = { invalidateManagedEntityHeader: jest.fn().mockResolvedValue(undefined) };
  const registry = {
    getAllBots: () => bots,
    getBotById: (id: string) => bots.find((bot) => bot.id === id),
  };
  const config = {
    get: (key: string) =>
      key === 'MAX_FIXED_MODERATOR_SELECTION_ENABLED'
        ? true
        : key === 'COMMERCIAL_LLM_ENFORCEMENT_ENABLED'
          ? options.commercialAiDeleteOnly
          : '',
  };
  const service = new ManagedModeratorService(
    db as never,
    registry as never,
    links as never,
    max as never,
    assignments as never,
    config as never,
    cache as never,
  );
  const user = { userId: 'admin' } as Parameters<typeof service.assign>[0];
  const request = {
    operationId: randomUUID(),
    moderatorKey: publicModerator(bots[1] as never).key,
    expectedRevision: 5,
  };
  return { service, db, links, max, assignments, cache, user, request, bots, state };
}

describe('public moderator selection', () => {
  it.each([true, false])(
    'evaluates retained commercial sanctions against AI delete-only mode=%s',
    async (commercialAiDeleteOnly) => {
      const f = fixture({
        commercialAiDeleteOnly,
        memberManagement: false,
        settings: { commercialAdsFilterEnabled: true, textFiltersBanEnabled: true },
      });
      const result = await f.service.choices(f.user, 'chat', '-123');
      expect(result.candidates.every((bot) => bot.selectable)).toBe(commercialAiDeleteOnly);
      expect(
        result.candidates.every(
          (bot) => bot.reason === (commercialAiDeleteOnly ? null : 'needs_permissions'),
        ),
      ).toBe(true);
      expect(f.assignments.assign).not.toHaveBeenCalled();
    },
  );

  it('retains independent profanity member-management duties in AI delete-only choices', async () => {
    const f = fixture({
      commercialAiDeleteOnly: true,
      memberManagement: false,
      settings: {
        commercialAdsFilterEnabled: true,
        textFiltersBanEnabled: true,
        russianProfanityFilterEnabled: true,
        profanityBanEnabled: true,
      },
    });
    const result = await f.service.choices(f.user, 'chat', '-123');
    expect(
      result.candidates.every((bot) => !bot.selectable && bot.reason === 'needs_permissions'),
    ).toBe(true);
  });

  it('can authorize through a healthy connected bot when the current token times out', async () => {
    const f = fixture();
    f.max.getChatMembersAccess.mockRejectedValueOnce(
      Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }),
    );
    const result = await f.service.choices(f.user, 'chat', '-123');
    expect(f.max.getChatMembersAccess).toHaveBeenCalledTimes(2);
    expect(result.current?.key).toBe(publicModerator(f.bots[0] as never).key);
    expect(result.candidates.every((bot) => bot.selectable)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(
      /primaryBotId|fixedModeratorBotId|permissionsSnapshot/,
    );
  });

  it('refuses a nonadministrator and never performs bot probes or writes', async () => {
    const f = fixture();
    f.max.getChatMembersAccess.mockResolvedValue(
      new Map([['admin', { isAdmin: false, isOwner: false }]]),
    );
    await expect(f.service.assign(f.user, 'chat', '-123', f.request)).rejects.toThrow(
      'администраторам',
    );
    expect(f.max.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(f.assignments.assign).not.toHaveBeenCalled();
  });

  it('rejects stale selection before probing or recording the target bot', async () => {
    const f = fixture();
    await expect(
      f.service.assign(f.user, 'chat', '-123', { ...f.request, expectedRevision: 4 }),
    ).rejects.toThrow('уже изменился');
    expect(f.max.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(f.assignments.assign).not.toHaveBeenCalled();
  });

  it('recovers an applied operation after a lost response without repeating the assignment', async () => {
    const f = fixture();
    f.db.managedModeratorAssignment.findUnique.mockResolvedValue({
      id: f.request.operationId,
      chatId: '-123',
      actorUserId: 'admin',
      botId: 'next',
      expectedRoutingVersion: 5,
      routingVersion: 6,
    });
    const result = await f.service.assign(f.user, 'chat', '-123', f.request);
    expect(result).toMatchObject({
      operationId: f.request.operationId,
      status: 'applied',
      revision: 6,
    });
    expect(f.assignments.assign).not.toHaveBeenCalled();
    expect(f.max.getCurrentChatMemberAccess).not.toHaveBeenCalled();
  });

  it('does not expose another administrator operation or reuse its request identity', async () => {
    const f = fixture();
    f.db.managedModeratorAssignment.findUnique.mockResolvedValue({
      id: f.request.operationId,
      chatId: '-123',
      actorUserId: 'someone-else',
      botId: 'next',
      expectedRoutingVersion: 5,
      routingVersion: 6,
    });
    await expect(
      f.service.operation(f.user, 'chat', '-123', f.request.operationId),
    ).rejects.toThrow('не подтверждена');
    await expect(f.service.assign(f.user, 'chat', '-123', f.request)).rejects.toThrow(
      'уже использован',
    );
    expect(f.assignments.assign).not.toHaveBeenCalled();
  });

  it('returns committed success even if advisory cache invalidation fails', async () => {
    const f = fixture();
    f.cache.invalidateManagedEntityHeader.mockRejectedValue(new Error('redis unavailable'));
    await expect(f.service.assign(f.user, 'chat', '-123', f.request)).resolves.toMatchObject({
      status: 'applied',
      revision: 6,
    });
    expect(f.assignments.assign).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRoutingVersion: 5,
        botId: 'next',
        actorProof: expect.objectContaining({ userId: 'admin' }),
      }),
    );
  });
});
