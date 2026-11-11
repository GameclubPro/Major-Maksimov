import type { MaxChatMemberAccess, MaxClientService } from '../max/max-client.service';
import type { MaxBotLinkService } from '../max/max-bot-link.service';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
} from '../prisma/prisma-client';
import {
  BotCapabilityCheckUnavailableException,
  BotCapabilityRequiredException,
} from './bot-capability-required.error';
import {
  assertManualBotCanManageMembers,
  captureManualModerationBotAccess,
  throwManualMemberSelectionFailure,
  type ManualMemberBotAccessProbe,
} from './manual-member-bot-access';

const allowed: MaxChatMemberAccess = {
  userId: 'bot-1',
  isOwner: false,
  isAdmin: true,
  permissionsKnown: true,
  permissions: ['read_all_messages', 'add_remove_members'],
};
const denied: MaxChatMemberAccess = { ...allowed, permissions: ['read_all_messages'] };

function client(access: MaxChatMemberAccess) {
  const getCurrentChatMemberAccess = jest
    .fn<
      ReturnType<MaxClientService['getCurrentChatMemberAccess']>,
      Parameters<MaxClientService['getCurrentChatMemberAccess']>
    >()
    .mockResolvedValue(access);
  return { getCurrentChatMemberAccess };
}

async function expectUnavailable(operation: Promise<unknown>) {
  const error: unknown = await operation.catch((reason: unknown) => reason);
  expect(error).toBeInstanceOf(BotCapabilityCheckUnavailableException);
  if (!(error instanceof BotCapabilityCheckUnavailableException)) throw error;
  expect(error.getResponse()).toEqual(
    expect.objectContaining({
      statusCode: 503,
      code: 'BOT_CAPABILITY_CHECK_UNAVAILABLE',
      operation: 'member_moderation',
      canRecheck: false,
    }),
  );
  expect(error.getResponse()).not.toHaveProperty('missingPermissions');
}

describe('manual command member permission evidence', () => {
  it('uses the selected bot evidence without rereading a stale denial', async () => {
    const max = client(denied);
    const access = { ...allowed, permissions: [...allowed.permissions] };
    const evidence = captureManualModerationBotAccess(
      'channel-1',
      'bot-1',
      'moderate_member',
      access,
    );
    access.permissions.length = 0;
    await expect(
      assertManualBotCanManageMembers(max, 'channel-1', 'BAN', 'bot-1', evidence),
    ).resolves.toBeUndefined();
    expect(max.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expect(evidence.access.permissions).toEqual(allowed.permissions);
  });

  it('does not override a current denial with an older cached grant', async () => {
    const max = client(allowed);
    const evidence = captureManualModerationBotAccess(
      'channel-1',
      'bot-1',
      'moderate_member',
      denied,
    );
    await expect(
      assertManualBotCanManageMembers(max, 'channel-1', 'BAN', 'bot-1', evidence),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        statusCode: 409,
        code: 'BOT_CAPABILITY_REQUIRED',
        operation: 'member_moderation',
        missingPermissions: ['add_remove_members'],
      }),
    });
    expect(max.getCurrentChatMemberAccess).not.toHaveBeenCalled();
  });

  it.each([
    { chatId: 'channel-2', botId: 'bot-1', action: 'moderate_member' as const },
    { chatId: 'channel-1', botId: 'bot-2', action: 'moderate_member' as const },
    { chatId: 'channel-1', botId: 'bot-1', action: 'delete_message' as const },
  ])('discards evidence for a different selection: %j', async ({ chatId, botId, action }) => {
    const max = client(denied);
    const evidence = captureManualModerationBotAccess(chatId, botId, action, allowed);
    await expect(
      assertManualBotCanManageMembers(max, 'channel-1', 'BAN', 'bot-1', evidence),
    ).rejects.toBeInstanceOf(BotCapabilityRequiredException);
    expect(max.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
  });

  it('distinguishes a complete empty permission list from an unknown empty reply', async () => {
    await expect(
      assertManualBotCanManageMembers(client({ ...allowed, permissions: [] }), 'chat-1', 'BAN'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ missingPermissions: ['add_remove_members'] }),
    });
    await expect(
      assertManualBotCanManageMembers(
        client({ ...allowed, permissions: [], permissionsKnown: false }),
        'chat-1',
        'BAN',
      ),
    ).resolves.toBeUndefined();
  });

  it('reports a missing administrator role only with explicit non-privilege evidence', async () => {
    const nonAdmin = { ...denied, isAdmin: false, explicitNonPrivilegeEvidence: true };
    await expect(
      assertManualBotCanManageMembers(client(nonAdmin), 'chat-1', 'UNBAN'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        statusCode: 409,
        missingPermissions: ['administrator'],
      }),
    });
    await expectUnavailable(
      assertManualBotCanManageMembers(
        client({ ...nonAdmin, explicitNonPrivilegeEvidence: false }),
        'chat-1',
        'UNBAN',
      ),
    );
  });

  it('does not invent a missing permission from incomplete access evidence', async () => {
    await expectUnavailable(
      assertManualBotCanManageMembers(
        client({ ...denied, permissionsKnown: false }),
        'chat-1',
        'BAN',
      ),
    );
  });

  it('preserves an immutable activation ceiling without describing it as a missing MAX right', async () => {
    const access = { ...denied, activationCapabilityCeiling: ['moderation'] };
    const evidence = captureManualModerationBotAccess('chat-1', 'bot-1', 'moderate_member', access);
    access.activationCapabilityCeiling.push('moderate_member');
    expect(evidence.access.activationCapabilityCeiling).toEqual(['moderation']);
    await expectUnavailable(
      assertManualBotCanManageMembers(client(allowed), 'chat-1', 'BAN', 'bot-1', evidence),
    );
  });

  it('reports denied self lookup as unavailable without guessing the missing right', async () => {
    const max = client(allowed);
    max.getCurrentChatMemberAccess.mockRejectedValue({
      response: {
        status: 403,
        data: { message: 'method is available only for chat administrator' },
      },
    });
    await expectUnavailable(assertManualBotCanManageMembers(max, 'chat-1', 'BAN'));
  });

  it('preserves transient upstream errors for the existing retry boundary', async () => {
    const timeout = new Error('MAX timeout');
    const max = client(allowed);
    max.getCurrentChatMemberAccess.mockRejectedValue(timeout);
    await expect(assertManualBotCanManageMembers(max, 'chat-1', 'BAN')).rejects.toBe(timeout);
  });
});

type OwnerState = NonNullable<
  Awaited<ReturnType<MaxBotLinkService['loadChatExecutionOwnerState']>>
>;

function selectionFixture(access: MaxChatMemberAccess = denied) {
  const checkedAt = new Date('2026-11-11T08:00:00.000Z');
  const source = 'admin_manual_moderation_candidate';
  const owner: OwnerState = {
    chatId: 'chat-1',
    entityType: ChatEntityType.CHAT,
    primaryBotId: 'bot-1',
    fixedModeratorBotId: 'bot-1',
    routingVersion: 4,
    candidates: [
      {
        botId: 'bot-1',
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessState: access.isAdmin
          ? ChatBotAccessState.CONFIRMED_ADMIN
          : ChatBotAccessState.CONFIRMED_MEMBER,
        botAccessCheckedAt: checkedAt,
        botAccessExpiresAt: new Date(checkedAt.getTime() + 300_000),
        botAccessSource: source,
        permissionsSnapshot: { ...access, checkedAt: checkedAt.toISOString() },
      },
    ],
  };
  const loadChatExecutionOwnerState = jest
    .fn<
      ReturnType<MaxBotLinkService['loadChatExecutionOwnerState']>,
      Parameters<MaxBotLinkService['loadChatExecutionOwnerState']>
    >()
    .mockResolvedValue(owner);
  const probes = new Map<string, ManualMemberBotAccessProbe>([
    ['bot-1', { access, checkedAt, source }],
  ]);
  return {
    owner,
    probes,
    loadChatExecutionOwnerState,
    reject: () =>
      throwManualMemberSelectionFailure({ loadChatExecutionOwnerState }, 'chat-1', probes),
  };
}

describe('manual member selection failure evidence', () => {
  it('reports the exact assigned bot permission from an acknowledged current SQL epoch', async () => {
    const f = selectionFixture();
    await expect(f.reject()).rejects.toMatchObject({
      response: expect.objectContaining({
        statusCode: 409,
        code: 'BOT_CAPABILITY_REQUIRED',
        operation: 'member_moderation',
        missingPermissions: ['add_remove_members'],
        checkedAt: '2026-11-11T08:00:00.000Z',
      }),
    });
    expect(f.loadChatExecutionOwnerState).toHaveBeenCalledWith('chat-1');
  });

  it('reports explicit administrator loss for the exact assigned bot', async () => {
    const f = selectionFixture({ ...denied, isAdmin: false, explicitNonPrivilegeEvidence: true });
    await expect(f.reject()).rejects.toMatchObject({
      response: expect.objectContaining({ missingPermissions: ['administrator'] }),
    });
  });

  it.each(['timestamp', 'source', 'unacknowledged'] as const)(
    'does not attribute a missing permission to a %s probe',
    async (mismatch) => {
      const f = selectionFixture();
      if (mismatch === 'timestamp')
        f.owner.candidates[0]!.botAccessCheckedAt = new Date('2026-11-11T08:00:01.000Z');
      if (mismatch === 'source') f.owner.candidates[0]!.botAccessSource = 'newer-source';
      if (mismatch === 'unacknowledged') f.probes.clear();
      await expectUnavailable(f.reject());
    },
  );

  it('does not describe a denied peer as the assigned moderator', async () => {
    const f = selectionFixture();
    f.owner.fixedModeratorBotId = 'bot-assigned';
    f.owner.candidates.push({ ...f.owner.candidates[0]!, botId: 'bot-assigned' });
    await expectUnavailable(f.reject());
  });

  it('does not describe a ceiling applied by SQL persistence as a missing MAX permission', async () => {
    const f = selectionFixture();
    f.owner.candidates[0]!.permissionsSnapshot = {
      ...denied,
      checkedAt: '2026-11-11T08:00:00.000Z',
      activationCapabilityCeiling: ['moderation'],
    };
    await expectUnavailable(f.reject());
  });

  it('uses a sole legacy primary but refuses to guess from an ambiguous roster', async () => {
    const f = selectionFixture();
    f.owner.fixedModeratorBotId = null;
    await expect(f.reject()).rejects.toBeInstanceOf(BotCapabilityRequiredException);
    f.owner.candidates.push({ ...f.owner.candidates[0]!, botId: 'bot-2' });
    await expectUnavailable(f.reject());
  });

  it.each([
    ['capable route rejection', allowed],
    ['unknown permissions', { ...denied, permissionsKnown: false }],
    ['activation ceiling', { ...denied, activationCapabilityCeiling: ['moderation'] }],
  ] as const)(
    'keeps %s unavailable without a fabricated missing permission',
    async (_name, access) => {
      await expectUnavailable(
        selectionFixture({ ...access, permissions: [...access.permissions] }).reject(),
      );
    },
  );

  it('does not attribute a SQL read failure to missing bot permissions', async () => {
    const f = selectionFixture();
    f.loadChatExecutionOwnerState.mockRejectedValue(new Error('database unavailable'));
    await expectUnavailable(f.reject());
  });
});

describe('settings capability error compatibility', () => {
  it('preserves settings defaults without a member operation marker', () => {
    const required = new BotCapabilityRequiredException({
      missingPermissions: ['write'],
      featureKeys: ['greeting'],
    }).getResponse();
    expect(required).toMatchObject({
      message: 'Боту не хватает прав для включения выбранной функции.',
      canRecheck: true,
    });
    expect(required).not.toHaveProperty('operation');
    const unavailable = new BotCapabilityCheckUnavailableException({
      featureKeys: ['greeting'],
    }).getResponse();
    expect(unavailable).toMatchObject({
      message: 'Не удалось подтвердить права бота MAX. Повторите попытку позже.',
      canRecheck: true,
    });
    expect(unavailable).not.toHaveProperty('operation');
  });
});
