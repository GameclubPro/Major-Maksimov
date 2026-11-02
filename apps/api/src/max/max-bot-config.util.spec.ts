import {
  buildResolvedMaxBotConfigs,
  parseAdditionalMaxBotsJson,
  resolveMaxEntryBotConfig,
} from './max-bot-config.util';

describe('max bot config util', () => {
  it('does not include malformed bot credentials in a JSON parse error', () => {
    const malformed = '[{"token":synthetic_token_123456}]';
    expect(() => parseAdditionalMaxBotsJson(malformed)).toThrow(
      /^MAX_BOTS_JSON must be valid JSON$/u,
    );
  });

  it.each([
    ['id613070470872_9_bot', 'Майор Максимов', 'male'],
    ['id613002203036_bot', 'Майор Максимов', 'male'],
    ['id613070470872_5_bot', 'Майор Максимова', 'female'],
    ['id613002203036_4_bot', 'Майор Максимова', 'female'],
    ['id613070470872_6_bot', 'Рэкс', 'neutral'],
    ['id613002203036_5_bot', 'Рэкс', 'neutral'],
  ] as const)(
    'resolves the known speech profile for %s without mixing bot identities',
    (id, characterName, speechPersona) => {
      const [bot] = buildResolvedMaxBotConfigs({
        defaultBot: {
          id,
          token: 'token-primary-123456',
          webhookSecretPath: 'secret-path-123456',
          webhookHeaderSecret: 'header-secret-123456',
        },
      });

      expect(bot).toMatchObject({ id, characterName, speechPersona });
    },
  );

  it('keeps explicit speech metadata above the built-in profile for a known bot id', () => {
    const [bot] = buildResolvedMaxBotConfigs({
      defaultBot: {
        id: 'id613002203036_5_bot',
        characterName: 'Рэкс тестовый',
        speechPersona: 'male',
        token: 'token-primary-123456',
        webhookSecretPath: 'secret-path-123456',
        webhookHeaderSecret: 'header-secret-123456',
      },
    });

    expect(bot).toMatchObject({
      id: 'id613002203036_5_bot',
      characterName: 'Рэкс тестовый',
      speechPersona: 'male',
    });
  });

  it('parses dormant additional bots with explicit female persona metadata', () => {
    const [bot] = parseAdditionalMaxBotsJson(
      JSON.stringify([
        {
          id: 'id700000000001_bot',
          label: 'Женский бот',
          characterName: 'Капитан Максимова',
          speechPersona: 'female',
          token: 'token-secondary-123456',
          webhookSecretPath: 'webhook-path-123456',
          webhookHeaderSecret: 'webhook-header-123456',
          state: 'dormant',
        },
      ]),
    );

    expect(bot).toMatchObject({
      id: 'id700000000001_bot',
      label: 'Женский бот',
      characterName: 'Капитан Максимова',
      speechPersona: 'female',
      state: 'dormant',
    });
  });

  it('keeps disabled additional bots hidden from admin by default', () => {
    const bots = buildResolvedMaxBotConfigs({
      defaultBot: {
        id: 'id613002203036_bot',
        token: 'token-primary-123456',
        webhookSecretPath: 'primary-webhook-path-123456',
        webhookHeaderSecret: 'primary-webhook-header-123456',
      },
      additionalBotsJson: JSON.stringify([
        {
          id: 'id613002203036_6_bot',
          token: 'token-disabled-123456',
          webhookSecretPath: 'disabled-webhook-path-123456',
          webhookHeaderSecret: 'disabled-webhook-header-123456',
          state: 'disabled',
        },
      ]),
    });

    expect(bots.at(1)).toMatchObject({
      id: 'id613002203036_6_bot',
      state: 'disabled',
      visibleInAdmin: false,
    });
  });

  it('resolves multiple additional bots without collapsing the registry to a pair', () => {
    const bots = buildResolvedMaxBotConfigs({
      defaultBot: {
        id: 'id613002203036_bot',
        token: 'token-primary-123456',
        webhookSecretPath: 'primary-webhook-path-123456',
        webhookHeaderSecret: 'primary-webhook-header-123456',
      },
      additionalBotsJson: JSON.stringify([
        {
          id: 'id613002203036_4_bot',
          label: 'Майор Максимова',
          characterName: 'Майор Максимова',
          token: 'token-secondary-123456',
          webhookSecretPath: 'secondary-webhook-path-123456',
          webhookHeaderSecret: 'secondary-webhook-header-123456',
          state: 'active',
        },
        {
          id: 'id613002203036_5_bot',
          label: 'Рэкс',
          characterName: 'Рэкс',
          token: 'token-rex-123456',
          webhookSecretPath: 'rex-webhook-path-123456',
          webhookHeaderSecret: 'rex-webhook-header-123456',
          state: 'active',
        },
      ]),
    });

    expect(bots.map((bot) => bot.id)).toEqual([
      'id613002203036_bot',
      'id613002203036_4_bot',
      'id613002203036_5_bot',
    ]);
    expect(bots.at(2)).toMatchObject({
      label: 'Рэкс',
      characterName: 'Рэкс',
      speechPersona: 'neutral',
      state: 'active',
      visibleInAdmin: true,
      isDefault: false,
    });
  });

  it('supports lifecycle state and ownership weight for the default and additional bots', () => {
    const bots = buildResolvedMaxBotConfigs({
      defaultBot: {
        id: 'id613002203036_bot',
        token: 'token-primary-123456',
        webhookSecretPath: 'primary-webhook-path-123456',
        webhookHeaderSecret: 'primary-webhook-header-123456',
        state: 'draining',
        ownershipWeight: 2,
      },
      additionalBotsJson: JSON.stringify([
        {
          id: 'id613002203036_4_bot',
          token: 'token-secondary-123456',
          webhookSecretPath: 'secondary-webhook-path-123456',
          webhookHeaderSecret: 'secondary-webhook-header-123456',
          state: 'active',
          ownershipWeight: 3,
        },
      ]),
    });

    expect(bots[0]).toMatchObject({ state: 'draining', ownershipWeight: 2 });
    expect(bots[1]).toMatchObject({ state: 'active', ownershipWeight: 3 });
    expect(resolveMaxEntryBotConfig(bots, null).id).toBe('id613002203036_4_bot');
  });

  it.each([
    {
      field: 'token',
      defaultValue: { token: 'shared-token-123456' },
      additionalValue: { token: 'shared-token-123456' },
    },
    {
      field: 'webhookSecretPath',
      defaultValue: { webhookSecretPath: 'shared-webhook-path' },
      additionalValue: { webhookSecretPath: 'shared-webhook-path' },
    },
    {
      field: 'webhookHeaderSecret',
      defaultValue: { webhookHeaderSecret: 'shared-webhook-header' },
      additionalValue: { webhookHeaderSecret: 'shared-webhook-header' },
    },
    {
      field: 'contact identity',
      defaultValue: { contactId: '214634782' },
      additionalValue: { contactId: '214634782' },
    },
  ])('rejects cross-bot duplicate $field values', ({ field, defaultValue, additionalValue }) => {
    expect(() =>
      buildResolvedMaxBotConfigs({
        defaultBot: {
          id: 'id613002203036_bot',
          token: 'token-primary-123456',
          webhookSecretPath: 'primary-webhook-path-123456',
          webhookHeaderSecret: 'primary-webhook-header-123456',
          contactId: '214634782',
          ...defaultValue,
        },
        additionalBotsJson: JSON.stringify([
          {
            id: 'custom-secondary-bot',
            token: 'token-secondary-123456',
            webhookSecretPath: 'secondary-webhook-path-123456',
            webhookHeaderSecret: 'secondary-webhook-header-123456',
            contactId: '214634783',
            state: 'active',
            ...additionalValue,
          },
        ]),
      }),
    ).toThrow(new RegExp(field.replace(' ', '.*'), 'u'));
  });

  it('rejects configurations without an active actionable entry bot', () => {
    expect(() =>
      buildResolvedMaxBotConfigs({
        defaultBot: {
          id: 'id613002203036_bot',
          token: 'token-primary-123456',
          webhookSecretPath: 'primary-webhook-path-123456',
          webhookHeaderSecret: 'primary-webhook-header-123456',
          state: 'draining',
        },
        additionalBotsJson: JSON.stringify([
          {
            id: 'id613002203036_4_bot',
            token: 'token-secondary-123456',
            webhookSecretPath: 'secondary-webhook-path-123456',
            webhookHeaderSecret: 'secondary-webhook-header-123456',
            state: 'dormant',
          },
        ]),
      }),
    ).toThrow(/at least one active actionable entry bot/u);
  });
});
