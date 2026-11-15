import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import type { ManagedEntitiesService } from './managed-entities.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { ModerationMessageService } from './moderation-message.service';

const actor = { userId: 'admin' } as AuthUser;
function fixture() {
  const access = {
    assertChatAdminAccess: jest.fn<
      ReturnType<ManagedEntitiesService['assertChatAdminAccess']>,
      Parameters<ManagedEntitiesService['assertChatAdminAccess']>
    >(),
  };
  const feed = jest.fn().mockResolvedValue({ chatId: 'chat', maskedExcerpt: 'Legacy excerpt' });
  const reason = jest.fn().mockResolvedValue(null);
  const prisma = {
    chatModerationFeedItem: { findUnique: feed },
    moderationDeleteIntentReason: { findUnique: reason },
  };
  return {
    access,
    feed,
    reason,
    service: new ModerationMessageService(
      prisma as unknown as PrismaService,
      access as unknown as ManagedEntitiesService,
    ),
  };
}

describe('private moderation message details', () => {
  it('authorizes before reading and refuses an event from another chat', async () => {
    const h = fixture();
    h.access.assertChatAdminAccess.mockRejectedValueOnce(new ForbiddenException());
    await expect(h.service.getMessage('chat', 'event', actor)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(h.feed).not.toHaveBeenCalled();
    h.feed.mockResolvedValueOnce({ chatId: 'another', maskedExcerpt: 'private' });
    await expect(h.service.getMessage('chat', 'event', actor)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(h.reason).not.toHaveBeenCalled();
  });
  it('never returns expired content even before physical purge', async () => {
    const h = fixture();
    h.reason.mockResolvedValue({
      messageSnapshot: {
        sourceAt: new Date(0),
        expiresAt: new Date(Date.now() - 1),
        purgedAt: null,
        content: { text: 'private', truncated: false, attachments: ['image'] },
      },
    });
    expect(await h.service.getMessage('chat', 'event', actor)).toMatchObject({
      state: 'expired',
      content: null,
    });
  });
  it('returns saved content without exposing origin or execution metadata', async () => {
    const h = fixture();
    h.reason.mockResolvedValue({
      messageSnapshot: {
        reasonId: 'private-origin',
        sourceAt: new Date(),
        expiresAt: new Date(Date.now() + 1000),
        purgedAt: null,
        content: {
          text: 'First\nSecond',
          truncated: false,
          attachments: ['image'],
          token: 'must-not-leak',
        },
      },
    });
    const result = await h.service.getMessage('chat', 'event', actor);
    expect(result).toMatchObject({
      eventId: 'event',
      state: 'saved',
      content: { text: 'First\nSecond', attachments: ['image'] },
    });
    expect(JSON.stringify(result)).not.toMatch(/private-origin|must-not-leak/);
  });
  it('distinguishes a historical excerpt from missing content', async () => {
    const h = fixture();
    expect(await h.service.getMessage('chat', 'event', actor)).toMatchObject({
      state: 'partial',
      content: { text: 'Legacy excerpt', truncated: true },
    });
    h.feed.mockResolvedValue({ chatId: 'chat', maskedExcerpt: null });
    expect(await h.service.getMessage('chat', 'event', actor)).toMatchObject({
      state: 'not_captured',
      content: null,
    });
  });
});
