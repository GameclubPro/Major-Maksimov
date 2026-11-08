import type { MaxChatMemberAccess } from '../max/max-client.service';
import { resolveProtectedSettingsEntryAccess } from './admin-settings-entry-protection';

const probeStartedAt = new Date('2026-11-08T00:00:00Z');
const actor: MaxChatMemberAccess = {
  userId: '123',
  isBot: false,
  isAdmin: true,
  isOwner: false,
  permissions: [],
  explicitPrivilegeEvidence: true,
};
const bot: MaxChatMemberAccess = {
  ...actor,
  userId: '777000',
  isBot: true,
};
const resolve = (userAccess: MaxChatMemberAccess | null, botAccess = bot) =>
  resolveProtectedSettingsEntryAccess({ userId: 'id123', userAccess, botAccess, probeStartedAt });

describe('settings entry human administrator evidence', () => {
  it('marks only an exact explicit human administrator for synchronous protection', () => {
    expect(resolve(actor)).toMatchObject({
      status: 'granted',
      humanAdministratorConfirmed: true,
      userRole: 'ADMIN',
      botRole: 'ADMIN',
      probeStartedAt,
    });
    expect(resolve({ ...actor, isAdmin: false, isOwner: true })).toMatchObject({
      status: 'granted',
      userRole: 'OWNER',
    });
    expect(resolve({ ...actor, isBot: true })).toMatchObject({
      status: 'denied',
      reason: 'user_not_admin',
    });
  });

  it.each([
    null,
    { ...actor, userId: 'another-human' },
    { ...actor, isBot: undefined },
    { ...actor, explicitPrivilegeEvidence: undefined },
    { ...actor, isAdmin: false, explicitPrivilegeEvidence: false },
  ])('keeps missing or incomplete human evidence unknown: %p', (access) => {
    expect(() => resolve(access)).toThrow(/MAX settings actor/u);
  });

  it('accepts complete human and bot denials without manufacturing a grant', () => {
    expect(
      resolve({
        ...actor,
        isAdmin: false,
        explicitPrivilegeEvidence: false,
        explicitNonPrivilegeEvidence: true,
      }),
    ).toMatchObject({ status: 'denied', reason: 'user_not_admin' });
    expect(
      resolve(actor, {
        ...bot,
        isAdmin: false,
        explicitPrivilegeEvidence: false,
        explicitNonPrivilegeEvidence: true,
      }),
    ).toMatchObject({ status: 'denied', reason: 'bot_not_admin' });
    expect(() => resolve(actor, { ...bot, explicitPrivilegeEvidence: undefined })).toThrow(
      'MAX settings bot privilege evidence is incomplete',
    );
  });
});
