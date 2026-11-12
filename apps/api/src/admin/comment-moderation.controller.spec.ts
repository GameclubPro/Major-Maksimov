import { BadRequestException } from '@nestjs/common';
import { CommentModerationController } from './comment-moderation.controller';
import { ChannelDialogService } from './channel-dialog.service';
import { PublisherDialogLinkService } from '../publisher/publisher-dialog-link.service';
import { AdminDialogLinkHelper } from './admin-dialog-link-helper';

const user = { userId: 'admin', username: null, displayName: null };

describe('comment moderation HTTP boundary', () => {
  it.each(['publisher', 'moderation'] as const)(
    'validates %s signed scope before touching state',
    (profile) => {
      const dialogs = {
        resolveCommentThread: jest.fn(() => {
          throw new BadRequestException('Invalid token');
        }),
      };
      const moderation = { update: jest.fn(), state: jest.fn() };
      const controller = new CommentModerationController(dialogs as never, moderation as never);
      expect(() =>
        controller.state('channels', 'channel-1', user, profile, { token: 'invalid-signed-token' }),
      ).toThrow();
      expect(moderation.state).not.toHaveBeenCalled();
      expect(() =>
        controller.update('channels', 'channel-1', 'target', user, profile, {
          token: 'invalid-signed-token',
          action: 'BAN',
          expectedRevision: 0,
        }),
      ).toThrow();
      expect(moderation.update).not.toHaveBeenCalled();
    },
  );

  it('rejects arbitrary entity path segments and body profile overrides', () => {
    const dialogs = { resolveCommentThread: jest.fn(() => 'thread') };
    const moderation = { update: jest.fn() };
    const controller = new CommentModerationController(dialogs as never, moderation as never);
    expect(() =>
      controller.state('other', 'chat-1', user, 'publisher', { token: 'valid-signed-token' }),
    ).toThrow();
    expect(() =>
      controller.update('chats', 'chat-1', 'target', user, 'publisher', {
        token: 'valid-signed-token',
        action: 'BAN',
        expectedRevision: 0,
        profile: 'moderation',
      }),
    ).toThrow();
    expect(moderation.update).not.toHaveBeenCalled();
  });

  it('keeps actual signing keys, entity types and community IDs isolated', () => {
    const config = {
      get: (key: string) => (key === 'MAX_PUBLISHER_BOT_ID' ? 'publisher_bot' : undefined),
      getOrThrow: () => 'major-test-secret',
    };
    const publisher = new PublisherDialogLinkService(
      config as never,
      { getSigningKeys: () => ['publisher-test-secret'] } as never,
    );
    const major = new AdminDialogLinkHelper({
      appBaseUrl: null,
      explicitBotContactId: null,
      ownBotUserId: 'major_bot',
      maxBotToken: 'major-test-secret',
      maxBotTokenValidationSecrets: ['major-test-secret'],
    });
    const service = new ChannelDialogService(
      {} as never,
      config as never,
      {} as never,
      undefined,
      undefined,
      publisher,
    );
    const token = major.buildChannelDialogToken('chat-1', 'comments', 'thread-1');
    expect(service.resolveCommentThread('chat-1', 'channel', token, 'moderation')).toBe('thread-1');
    expect(() => service.resolveCommentThread('other', 'channel', token, 'moderation')).toThrow();
    expect(() => service.resolveCommentThread('chat-1', 'chat', token, 'moderation')).toThrow();
    expect(() => service.resolveCommentThread('chat-1', 'channel', token, 'publisher')).toThrow();
  });
});
