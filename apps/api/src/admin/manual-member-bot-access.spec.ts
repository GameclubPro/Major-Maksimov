import { ForbiddenException } from '@nestjs/common';
import type { MaxChatMemberAccess, MaxClientService } from '../max/max-client.service';
import {
  assertManualBotCanManageMembers,
  captureManualModerationBotAccess,
} from './manual-member-bot-access';

const allowed: MaxChatMemberAccess = {
  userId: 'bot-1',
  isOwner: false,
  isAdmin: true,
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
    ).rejects.toBeInstanceOf(ForbiddenException);
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
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(max.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
  });
});
