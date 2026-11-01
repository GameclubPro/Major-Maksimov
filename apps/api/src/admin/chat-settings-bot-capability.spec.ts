import { chatSettingsSchema } from '@maxim/contracts';
import { resolveChatSettingsBotCapabilityRequirements } from './chat-settings-bot-capability';

function resolveRequirements(
  currentOverrides: Record<string, unknown>,
  nextOverrides: Record<string, unknown>,
) {
  const current = chatSettingsSchema.parse(currentOverrides);
  const next = chatSettingsSchema.parse({ ...current, ...nextOverrides });
  return resolveChatSettingsBotCapabilityRequirements({
    current,
    next,
    requestedSettings: nextOverrides,
  });
}

describe('resolveChatSettingsBotCapabilityRequirements', () => {
  it('requires only message rights for AI deletion despite retained legacy sanctions', () => {
    const current = chatSettingsSchema.parse({
      commercialAdsFilterEnabled: false,
      textFiltersBanEnabled: true,
    });
    const requestedSettings = { commercialAdsFilterEnabled: true };
    const params = {
      current,
      next: chatSettingsSchema.parse({ ...current, ...requestedSettings }),
      requestedSettings,
      commercialAiDeleteOnly: true,
    };
    expect(resolveChatSettingsBotCapabilityRequirements(params)).toEqual([
      { permission: 'write', featureKeys: ['commercialAdsFilterEnabled'] },
    ]);
  });

  it('preserves independent ban requirements when AI ignores legacy commercial sanctions', () => {
    const current = chatSettingsSchema.parse({
      commercialAdsFilterEnabled: true,
      textFiltersBanEnabled: false,
      russianProfanityFilterEnabled: true,
      profanityBanEnabled: false,
    });
    const requestedSettings = { textFiltersBanEnabled: true, profanityBanEnabled: true };
    const params = {
      current,
      next: chatSettingsSchema.parse({ ...current, ...requestedSettings }),
      requestedSettings,
      commercialAiDeleteOnly: true,
    };
    expect(resolveChatSettingsBotCapabilityRequirements(params)).toEqual([
      { permission: 'write', featureKeys: ['profanityBanEnabled'] },
      { permission: 'add_remove_members', featureKeys: ['profanityBanEnabled'] },
    ]);
  });

  it('requires deletion rights, not member-management rights, for traffic controls', () => {
    expect(
      resolveRequirements(
        {},
        { slowModeEnabled: true, mediaMessageCooldownEnabled: true, stickerMessagesEnabled: false },
      ),
    ).toEqual([
      {
        permission: 'write',
        featureKeys: ['slowModeEnabled', 'mediaMessageCooldownEnabled', 'stickerMessagesEnabled'],
      },
    ]);
  });
  it('maps newly enabled enforcement and disabled allowed-content toggles to write', () => {
    expect(
      resolveRequirements(
        {
          antiDuplicateEnabled: false,
          linkPolicy: 'ALERT_ONLY',
          photoMessagesEnabled: true,
        },
        {
          antiDuplicateEnabled: true,
          linkPolicy: 'BLOCKLIST_ONLY',
          photoMessagesEnabled: false,
        },
      ),
    ).toEqual([
      {
        permission: 'write',
        featureKeys: ['antiDuplicateEnabled', 'photoMessagesEnabled', 'linkPolicy'],
      },
    ]);
  });

  it('requires write permission when forwarded messages are disabled', () => {
    expect(
      resolveRequirements({ forwardedMessagesEnabled: true }, { forwardedMessagesEnabled: false }),
    ).toEqual([{ permission: 'write', featureKeys: ['forwardedMessagesEnabled'] }]);
  });

  it('requires both write and member management for sanctions', () => {
    expect(
      resolveRequirements(
        {
          antiSpamEnabled: false,
          removeBotsFromGroupEnabled: false,
          profanityBanEnabled: false,
          russianProfanityFilterEnabled: true,
        },
        {
          antiSpamEnabled: true,
          removeBotsFromGroupEnabled: true,
          profanityBanEnabled: true,
        },
      ),
    ).toEqual([
      {
        permission: 'write',
        featureKeys: ['antiSpamEnabled', 'removeBotsFromGroupEnabled', 'profanityBanEnabled'],
      },
      {
        permission: 'add_remove_members',
        featureKeys: ['antiSpamEnabled', 'removeBotsFromGroupEnabled', 'profanityBanEnabled'],
      },
    ]);
  });

  it('ignores already active values and schema defaults omitted by an older client', () => {
    const current = chatSettingsSchema.parse({
      antiSpamEnabled: true,
      nightModeEnabled: true,
      photoMessagesEnabled: false,
    });
    const next = chatSettingsSchema.parse({
      ...current,
      antiSpamEnabled: true,
      nightModeEnabled: false,
    });

    expect(
      resolveChatSettingsBotCapabilityRequirements({
        current,
        next,
        requestedSettings: { antiSpamEnabled: true, nightModeEnabled: false },
      }),
    ).toEqual([]);
  });

  it('allows configuring a subfeature while its parent moderation block is disabled', () => {
    expect(
      resolveRequirements(
        { russianProfanityFilterEnabled: false, profanityBanEnabled: false },
        { profanityBanEnabled: true },
      ),
    ).toEqual([]);
  });

  it('guards a newly enabled subfeature when its parent is already active', () => {
    expect(
      resolveRequirements(
        {
          russianProfanityFilterEnabled: true,
          profanityBotMessageEnabled: false,
          profanityMuteEnabled: false,
        },
        { profanityBotMessageEnabled: true, profanityMuteEnabled: true },
      ),
    ).toEqual([
      {
        permission: 'write',
        featureKeys: ['profanityBotMessageEnabled', 'profanityMuteEnabled'],
      },
    ]);
  });

  it('guards the first stop-word detector added to an otherwise inactive limits block', () => {
    expect(
      resolveRequirements(
        { messageLimitsBlockedWords: [], messageLimitsBlockedDomains: [] },
        { messageLimitsBlockedWords: ['спам'] },
      ),
    ).toEqual([{ permission: 'write', featureKeys: ['messageLimitsBlockedWords'] }]);
  });

  it('requires write permission when image text scanning is enabled', () => {
    expect(
      resolveRequirements(
        {
          messageLimitsImageTextScanEnabled: false,
          messageLimitsBlockedWords: ['спам'],
        },
        { messageLimitsImageTextScanEnabled: true },
      ),
    ).toEqual([{ permission: 'write', featureKeys: ['messageLimitsImageTextScanEnabled'] }]);
  });

  it('requires member management when a parent activates an already staged ban', () => {
    expect(
      resolveRequirements(
        { russianProfanityFilterEnabled: false, profanityBanEnabled: true },
        { russianProfanityFilterEnabled: true },
      ),
    ).toEqual([
      { permission: 'write', featureKeys: ['russianProfanityFilterEnabled'] },
      {
        permission: 'add_remove_members',
        featureKeys: ['russianProfanityFilterEnabled'],
      },
    ]);
  });

  it('guards required-subscription activation derived from a newly added channel', () => {
    const current = chatSettingsSchema.parse({
      requiredSubscriptionEnabled: false,
      requiredSubscriptionChannelIds: [],
    });
    const next = chatSettingsSchema.parse({
      ...current,
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: ['channel-1'],
    });

    expect(
      resolveChatSettingsBotCapabilityRequirements({
        current,
        next,
        requestedSettings: { requiredSubscriptionChannelIds: ['channel-1'] },
      }),
    ).toEqual([
      {
        permission: 'write',
        featureKeys: ['requiredSubscriptionEnabled', 'requiredSubscriptionChannelIds'],
      },
    ]);
  });
});
