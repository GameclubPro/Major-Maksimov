import { BadRequestException } from '@nestjs/common';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { ModerationMessageController } from './moderation-message.controller';
import type { ModerationMessageService } from './moderation-message.service';

const user = { userId: 'admin' } as AuthUser;
describe('moderation message HTTP boundary', () => {
  const getMessage = jest.fn<
    ReturnType<ModerationMessageService['getMessage']>,
    Parameters<ModerationMessageService['getMessage']>
  >();
  const controller = new ModerationMessageController({
    getMessage,
  } as unknown as ModerationMessageService);
  beforeEach(() => getMessage.mockReset());
  it.each([undefined, null, [], ['event', 'other'], {}, '', 'x'.repeat(201)])(
    'refuses malformed path input before service access: %p',
    (value) => {
      expect(() => controller.getMessage('chat', value, user)).toThrow(BadRequestException);
      expect(() => controller.getMessage(value, 'event', user)).toThrow(BadRequestException);
      expect(getMessage).not.toHaveBeenCalled();
    },
  );
  it('passes only bounded string identities and the authenticated actor', () => {
    controller.getMessage('chat', 'event', user);
    expect(getMessage).toHaveBeenCalledWith('chat', 'event', user);
  });
});
