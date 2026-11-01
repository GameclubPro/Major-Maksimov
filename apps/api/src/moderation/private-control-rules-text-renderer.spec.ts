import {
  chatSettingsSchema,
  domainAllowlistEntrySchema,
  managedEntityHeaderSchema,
} from '@maxim/contracts';
import { buildPrivateRulesTextItems } from './private-control-rules-text-renderer';

type RulesInput = Parameters<typeof buildPrivateRulesTextItems>[0];

function createInput(settings: Partial<RulesInput['settings']> = {}): RulesInput {
  return {
    settings: chatSettingsSchema.parse(settings),
    requiredSubscriptionChannels: [],
    domains: [],
    duplicatePhotoModerationMode: 'OBSERVE',
  };
}

function createChannel(
  id: string,
  title: string,
): RulesInput['requiredSubscriptionChannels'][number] {
  return managedEntityHeaderSchema.parse({
    id,
    title,
    entityType: 'channel',
    link: null,
    participantsCount: null,
  });
}

describe('buildPrivateRulesTextItems', () => {
  it('preserves the complete literal item order and final sanctions', () => {
    const input = createInput({
      linkPolicy: 'BLOCKLIST_ONLY',
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: ['channel-1', 'channel-2'],
      russianProfanityFilterEnabled: true,
      profanitySensitivity: 'STRICT',
      commercialAdsFilterEnabled: true,
      antiDuplicateEnabled: true,
      duplicateDetectionPreset: 'STANDARD',
      duplicateCompareMode: 'MESSAGE',
      duplicatePhotoScope: 'SAME_AUTHOR',
      duplicateWarnEnabled: true,
      duplicateWarnMaxCount: 1,
      duplicateMuteEnabled: true,
      duplicateMuteMaxCount: 2,
      duplicateBanEnabled: true,
      duplicateBanMaxCount: 3,
      duplicateWarnWindowSec: 43_200,
      antiSpamEnabled: true,
      slowModeEnabled: true,
      slowModeIntervalSeconds: 45,
      mediaMessageCooldownEnabled: true,
      mediaMessageCooldownSeconds: 90,
      messageCountLimitEnabled: true,
      messageCountLimitMessages: 3,
      messageCountLimitWindowHours: 2,
      maxMessageLengthEnabled: true,
      maxMessageLength: 500,
      photoMessageCooldownEnabled: true,
      photoMessageCooldownHours: 5,
      stickerMessageCooldownEnabled: true,
      stickerMessageCooldownMinutes: 21,
      stickerMessagesEnabled: true,
      photoMessagesEnabled: false,
      videoMessagesEnabled: false,
      fileMessagesEnabled: false,
      voiceMessagesEnabled: false,
      forwardedMessagesEnabled: false,
      phoneNumbersEnabled: false,
      nightModeEnabled: true,
      nightModeStartTimeMinutes: 23 * 60,
      nightModeEndTimeMinutes: 7 * 60 + 30,
      linkWarnEnabled: true,
      textFiltersMuteEnabled: true,
      messageLimitsBanEnabled: true,
    });
    input.requiredSubscriptionChannels = [
      createChannel('channel-1', 'Новости'),
      createChannel('channel-2', 'Анонсы'),
    ];
    input.duplicatePhotoModerationMode = 'FULL';

    expect(buildPrivateRulesTextItems(input)).toEqual([
      'Пожалуйста, не отправляйте ссылки: бот их удаляет.',
      'Чтобы писать в чат, сначала подпишитесь на: Новости, Анонсы.',
      'Пожалуйста, без мата, грубой лексики и оскорблений.',
      'Коммерческую рекламу публикуйте только по согласованию с администраторами.',
      'Повторы учитываются в течение 12 ч с принятого оригинала. Удалённые повторы не продлевают этот срок.',
      'Не отправляйте одинаковые сообщения.',
      'Одинаковые картинки одного участника считаются повтором независимо от подписи. Действует общая цепочка антидубля.',
      'Пожалуйста, не флудите и не спамьте.',
      'Интервал между сообщениями: 45 сек.',
      'Интервал между медиа: 90 сек.',
      'Пожалуйста, не отправляйте больше 3 сообщений за 2 часа.',
      'Старайтесь писать короче: до 500 символов в одном сообщении.',
      'Фото можно отправлять не чаще одного раза в 5 часов.',
      'Стикеры можно отправлять не чаще одного раза в 21 минуту.',
      'Фото сюда отправлять нельзя.',
      'Видео сюда отправлять нельзя.',
      'Файлы сюда отправлять нельзя.',
      'Голосовые сообщения сюда отправлять нельзя.',
      'Пересланные сообщения сюда отправлять нельзя.',
      'Телефонные номера в сообщениях запрещены.',
      'Ночью чат работает тише: ограничения действуют с 23:00 до 07:30.',
      'За повторные нарушения бот может предупредить, временно ограничить сообщения и заблокировать.',
    ]);
  });

  it('keeps the disabled-stickers prohibition and omits its dormant cooldown', () => {
    const input = createInput({
      stickerMessagesEnabled: false,
      stickerMessageCooldownEnabled: true,
      stickerMessageCooldownMinutes: 5,
    });

    expect(buildPrivateRulesTextItems(input)).toEqual([
      'Ссылки бот проверяет, но не удаляет автоматически.',
      'Стикеры сюда отправлять нельзя.',
    ]);
  });

  it.each([
    {
      name: 'an empty allowlist',
      linkPolicy: 'ALLOWLIST_ONLY',
      hasDomain: false,
      expected: 'Ссылки здесь ограничены: если нужно, сначала согласуйте их с администраторами.',
    },
    {
      name: 'a configured allowlist',
      linkPolicy: 'ALLOWLIST_ONLY',
      hasDomain: true,
      expected: 'Можно отправлять только ссылки из разрешённого списка.',
    },
    {
      name: 'alert-only links',
      linkPolicy: 'ALERT_ONLY',
      hasDomain: true,
      expected: 'Ссылки бот проверяет, но не удаляет автоматически.',
    },
  ] as const)('preserves the exact wording for $name', ({ linkPolicy, hasDomain, expected }) => {
    const input = createInput({ linkPolicy });
    if (hasDomain) {
      input.domains = [
        domainAllowlistEntrySchema.parse({
          domain: 'example.com',
          normalizedValue: 'example.com',
          matchType: 'DOMAIN',
          removeAfterAt: null,
        }),
      ];
    }

    expect(buildPrivateRulesTextItems(input)).toEqual([expected]);
  });

  it.each([
    { name: 'disabled typed subscription with retained IDs', enabled: false, ids: ['channel-1'] },
    { name: 'typed subscription without target IDs', enabled: true, ids: [] },
  ])('omits $name wording and its dormant sanctions', ({ enabled, ids }) => {
    const input = createInput({
      requiredSubscriptionEnabled: enabled,
      requiredSubscriptionChannelIds: ids,
      requiredSubscriptionWarnEnabled: true,
      requiredSubscriptionMuteEnabled: true,
      requiredSubscriptionBanEnabled: true,
    });
    // The schema derives this flag from IDs; preserve both raw typed defensive boundaries here.
    input.settings.requiredSubscriptionEnabled = enabled;
    input.requiredSubscriptionChannels = [createChannel('channel-1', 'Новости')];

    expect(buildPrivateRulesTextItems(input)).toEqual([
      'Ссылки бот проверяет, но не удаляет автоматически.',
    ]);
  });

  it.each([
    { name: 'missing headers', titles: [] },
    { name: 'empty and whitespace titles', titles: ['', '   '] },
  ])('uses the generic active-subscription phrase for $name', ({ titles }) => {
    const input = createInput({
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: ['channel-1', 'channel-2'],
      requiredSubscriptionWarnEnabled: true,
    });
    input.requiredSubscriptionChannels = titles.map((title, index) =>
      createChannel(`channel-${index + 1}`, title),
    );

    expect(buildPrivateRulesTextItems(input)).toEqual([
      'Ссылки бот проверяет, но не удаляет автоматически.',
      'Чтобы писать в чат, сначала подпишитесь на обязательные чаты или каналы.',
      'За повторные нарушения бот может предупредить.',
    ]);
  });

  it('trims and deduplicates subscription titles before the ordered three-title preview', () => {
    const titles = [
      '  Новости ',
      'Анонсы',
      'Новости',
      '',
      '   ',
      'Обсуждения',
      'Календарь',
      'Эфиры',
    ];
    const input = createInput({
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: titles.map((_title, index) => `channel-${index + 1}`),
    });
    input.requiredSubscriptionChannels = titles.map((title, index) =>
      createChannel(`channel-${index + 1}`, title),
    );

    expect(buildPrivateRulesTextItems(input)).toEqual([
      'Ссылки бот проверяет, но не удаляет автоматически.',
      'Чтобы писать в чат, сначала подпишитесь на: Новости, Анонсы, Обсуждения и ещё 2.',
    ]);
  });

  it('omits duplicate items and all duplicate-only sanctions while their master is disabled', () => {
    const input = createInput({
      antiDuplicateEnabled: false,
      duplicateWarnEnabled: true,
      duplicateMuteEnabled: true,
      duplicateBanEnabled: true,
    });
    input.duplicatePhotoModerationMode = 'FULL';

    expect(buildPrivateRulesTextItems(input)).toEqual([
      'Ссылки бот проверяет, но не удаляет автоматически.',
    ]);
  });

  it.each([
    ['CORE_ONLY', 'Пожалуйста, без мата.'],
    ['BALANCED', 'Пожалуйста, без мата и грубой лексики.'],
    ['STRICT', 'Пожалуйста, без мата, грубой лексики и оскорблений.'],
  ] as const)('preserves %s profanity wording', (profanitySensitivity, expected) => {
    const input = createInput({ russianProfanityFilterEnabled: true, profanitySensitivity });

    expect(buildPrivateRulesTextItems(input)).toEqual([
      'Ссылки бот проверяет, но не удаляет автоматически.',
      expected,
    ]);
  });

  it.each([
    {
      name: 'warn',
      settings: { linkWarnEnabled: true },
      expected: 'За повторные нарушения бот может предупредить.',
    },
    {
      name: 'mute',
      settings: { textFiltersMuteEnabled: true },
      expected: 'За повторные нарушения бот может временно ограничить сообщения.',
    },
    {
      name: 'ban',
      settings: { messageLimitsBanEnabled: true },
      expected: 'За повторные нарушения бот может заблокировать.',
    },
    {
      name: 'warn and mute',
      settings: { linkWarnEnabled: true, textFiltersMuteEnabled: true },
      expected: 'За повторные нарушения бот может предупредить и временно ограничить сообщения.',
    },
    {
      name: 'warn and ban',
      settings: { textFiltersWarnEnabled: true, linkBanEnabled: true },
      expected: 'За повторные нарушения бот может предупредить и заблокировать.',
    },
    {
      name: 'mute and ban',
      settings: { messageLimitsMuteEnabled: true, textFiltersBanEnabled: true },
      expected: 'За повторные нарушения бот может временно ограничить сообщения и заблокировать.',
    },
    {
      name: 'all three with overlapping sources',
      settings: {
        linkWarnEnabled: true,
        textFiltersWarnEnabled: true,
        linkMuteEnabled: true,
        messageLimitsMuteEnabled: true,
        linkBanEnabled: true,
        textFiltersBanEnabled: true,
      },
      expected:
        'За повторные нарушения бот может предупредить, временно ограничить сообщения и заблокировать.',
    },
  ] as const)('preserves $name sanctions and conjunction order', ({ settings, expected }) => {
    expect(buildPrivateRulesTextItems(createInput(settings))).toEqual([
      'Ссылки бот проверяет, но не удаляет автоматически.',
      expected,
    ]);
  });

  it.each([
    {
      value: 1,
      count: 'Пожалуйста, не отправляйте больше 3 сообщений за 1 час.',
      photo: 'Фото можно отправлять не чаще одного раза в 1 час.',
      sticker: 'Стикеры можно отправлять не чаще одного раза в 1 минуту.',
    },
    {
      value: 2,
      count: 'Пожалуйста, не отправляйте больше 3 сообщений за 2 часа.',
      photo: 'Фото можно отправлять не чаще одного раза в 2 часа.',
      sticker: 'Стикеры можно отправлять не чаще одного раза в 2 минуты.',
    },
    {
      value: 5,
      count: 'Пожалуйста, не отправляйте больше 3 сообщений за 5 часов.',
      photo: 'Фото можно отправлять не чаще одного раза в 5 часов.',
      sticker: 'Стикеры можно отправлять не чаще одного раза в 5 минут.',
    },
    {
      value: 11,
      count: 'Пожалуйста, не отправляйте больше 3 сообщений за 11 часов.',
      photo: 'Фото можно отправлять не чаще одного раза в 11 часов.',
      sticker: 'Стикеры можно отправлять не чаще одного раза в 11 минут.',
    },
    {
      value: 21,
      count: 'Пожалуйста, не отправляйте больше 3 сообщений за 21 час.',
      photo: 'Фото можно отправлять не чаще одного раза в 21 час.',
      sticker: 'Стикеры можно отправлять не чаще одного раза в 21 минуту.',
    },
  ])(
    'preserves the Russian hour and minute forms for $value',
    ({ value, count, photo, sticker }) => {
      const input = createInput({
        messageCountLimitEnabled: true,
        messageCountLimitMessages: 3,
        messageCountLimitWindowHours: value,
        photoMessageCooldownEnabled: true,
        photoMessageCooldownHours: value,
        stickerMessageCooldownEnabled: true,
        stickerMessageCooldownMinutes: value,
      });

      expect(buildPrivateRulesTextItems(input)).toEqual([
        'Ссылки бот проверяет, но не удаляет автоматически.',
        count,
        photo,
        sticker,
      ]);
    },
  );

  it('preserves truncation for a typed fractional minute outside the validated integer schema', () => {
    const input = createInput({ nightModeEnabled: true, nightModeEndTimeMinutes: 481 });
    input.settings.nightModeStartTimeMinutes = 90.9;

    expect(buildPrivateRulesTextItems(input)).toEqual([
      'Ссылки бот проверяет, но не удаляет автоматически.',
      'Ночью чат работает тише: ограничения действуют с 01:30 до 08:01.',
    ]);
  });

  it('leaves frozen input unchanged and gives each caller an independent result array', () => {
    const input = createInput({
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: ['channel-1'],
      requiredSubscriptionWarnEnabled: true,
    });
    input.requiredSubscriptionChannels = [createChannel('channel-1', '  Новости  ')];
    const before = structuredClone(input);
    Object.freeze(input.settings.requiredSubscriptionChannelIds);
    Object.freeze(input.settings);
    input.requiredSubscriptionChannels.forEach((channel) => Object.freeze(channel));
    Object.freeze(input.requiredSubscriptionChannels);
    Object.freeze(input.domains);
    Object.freeze(input);

    const first = buildPrivateRulesTextItems(input);
    const second = buildPrivateRulesTextItems(input);
    expect(first).not.toBe(second);
    first[0] = 'caller override';
    first.push('caller extra item');

    expect(second).toEqual([
      'Ссылки бот проверяет, но не удаляет автоматически.',
      'Чтобы писать в чат, сначала подпишитесь на: Новости.',
      'За повторные нарушения бот может предупредить.',
    ]);
    expect(buildPrivateRulesTextItems(input)).toEqual(second);
    expect(input).toEqual(before);
  });

  it('loads and renders independently when loading Nest runtime dependencies is forbidden', () => {
    try {
      jest.isolateModules(() => {
        jest.doMock('@nestjs/common', () => {
          throw new Error('Private rules rendering must not load Nest runtime dependencies');
        });
        const renderer = jest.requireActual<typeof import('./private-control-rules-text-renderer')>(
          './private-control-rules-text-renderer',
        );

        expect(renderer.buildPrivateRulesTextItems(createInput())).toEqual([
          'Ссылки бот проверяет, но не удаляет автоматически.',
        ]);
      });
    } finally {
      jest.dontMock('@nestjs/common');
    }
  });
});
