import {
  BOT_SPEECH_EDITABLE_FIELD_KEYS,
  BOT_SPEECH_PERSONA_VALUES,
  BOT_SPEECH_STYLE_VALUES,
  BOT_SPEECH_SYSTEM_TEMPLATE_KEYS,
  applyBotSpeechStylePreset,
  getBotSpeechEditableTemplate,
  getBotSpeechSystemTemplate,
  hasBotSpeechEditableOverrides,
  type BotSpeechSettingsSubset,
  type BotSpeechStyle,
} from '@maxim/contracts/bot-speech';
import { ModerationService } from './moderation.service';

function extractTemplatePlaceholders(template: string): string[] {
  return [...template.matchAll(/\{([a-z_]+)\}/gu)].map((match) => match[1]!).sort();
}

const EXPECTED_EDITABLE_PLACEHOLDERS = {
  greetingBotMessageText: ['bot_character_name', 'user'],
  linkBotMessageText: ['message_status', 'reason', 'user'],
  linkWarnMessageText: ['reason', 'user'],
  requiredSubscriptionBotMessageText: ['channels', 'message_status', 'user'],
  requiredSubscriptionWarnMessageText: ['channels', 'reason', 'user'],
  invitationAccessBotMessageText: [
    'invited_count',
    'message_status',
    'remaining_invites',
    'required_invites',
    'required_invites_count',
    'user',
  ],
  invitationAccessWarnMessageText: [
    'invited_count',
    'reason',
    'required_invites',
    'required_invites_count',
    'user',
  ],
  textFiltersBotMessageText: ['message_status', 'reason', 'user'],
  profanityBotMessageText: ['message_status', 'reason', 'user'],
  textFiltersWarnMessageText: ['reason', 'user'],
  profanityWarnMessageText: ['reason', 'user'],
  duplicateBotMessageText: ['sanction', 'user'],
  messageLimitsBotMessageText: ['message_status', 'reason', 'user'],
  messageLimitsWarnMessageText: ['reason', 'user'],
  phoneNumbersBotMessageText: ['message_status', 'reason', 'user'],
  nightModeBotMessageText: ['night_status', 'night_timezone', 'night_window'],
  nightModeOpenMessageText: ['opening_status'],
} satisfies Record<(typeof BOT_SPEECH_EDITABLE_FIELD_KEYS)[number], string[]>;

const INVITATION_PLACEHOLDER_OMISSIONS: Record<
  BotSpeechStyle,
  { explanation: string[]; warning: string[] }
> = {
  ROBOT: { explanation: ['required_invites'], warning: ['required_invites'] },
  FRIENDLY: { explanation: ['required_invites'], warning: ['required_invites'] },
  POLICE: {
    explanation: ['invited_count', 'required_invites', 'required_invites_count'],
    warning: ['invited_count', 'required_invites_count'],
  },
  IRONIC: {
    explanation: ['invited_count', 'required_invites', 'required_invites_count'],
    warning: ['invited_count', 'required_invites_count'],
  },
};

const EXPECTED_SYSTEM_PLACEHOLDERS = {
  linkEdited: ['message_status', 'reason', 'user'],
  linkEditedWarn: ['reason', 'user'],
  linkMute: ['user'],
  requiredSubscriptionMute: ['channels', 'mute_duration', 'user'],
  requiredSubscriptionBan: ['channels', 'user'],
  invitationAccessMute: ['remaining_invites', 'user'],
  invitationAccessBan: ['user'],
  textFiltersMuteCommercial: ['user'],
  textFiltersMuteProfanity: ['user'],
  textFiltersMuteGeneric: ['user'],
  muteNotice: ['mute_duration', 'user'],
  permanentBanNotice: ['user'],
  messageLimitsWarn: ['reason', 'user'],
  messageLimitsMute: ['reason', 'user'],
  messageLimitsBan: ['reason', 'user'],
  duplicatePhoto: ['sanction', 'user'],
  duplicateAlbum: ['sanction', 'user'],
  duplicateWarn: [],
  duplicateMute: ['mute_duration'],
  duplicateBan: [],
  duplicatePassiveDeleted: [],
  duplicatePassiveKept: [],
} satisfies Record<(typeof BOT_SPEECH_SYSTEM_TEMPLATE_KEYS)[number], string[]>;

function createBotSpeechSettings(
  overrides: Partial<BotSpeechSettingsSubset> = {},
): BotSpeechSettingsSubset {
  return {
    botSpeechStyle: null,
    greetingBotMessageText: '',
    linkBotMessageText: '',
    linkWarnMessageText: '',
    requiredSubscriptionBotMessageText: '',
    requiredSubscriptionWarnMessageText: '',
    invitationAccessBotMessageText: '',
    invitationAccessWarnMessageText: '',
    textFiltersBotMessageText: '',
    profanityBotMessageText: '',
    textFiltersWarnMessageText: '',
    profanityWarnMessageText: '',
    duplicateBotMessageText: '',
    messageLimitsBotMessageText: '',
    messageLimitsWarnMessageText: '',
    phoneNumbersBotMessageText: '',
    nightModeBotMessageText: '',
    nightModeOpenMessageText: '',
    ...overrides,
  };
}

function createService(): ModerationService {
  return new ModerationService({} as never, {} as never, {} as never, {} as never);
}

describe('bot speech styles', () => {
  it('uses the current police preset when style is null and matches explicit POLICE', () => {
    const service = createService();
    const userLabel = '**Алексей**';

    const legacyLinkText = (service as any).buildLinkExplanation(userLabel, true, '', null);
    const policeLinkText = (service as any).buildLinkExplanation(userLabel, true, '', 'POLICE');
    const legacyWarnText = service
      .getRuleFollowupHost()
      .buildMessageLimitsWarnExplanation(userLabel, 'MESSAGE_TOO_LONG', null, null);
    const policeWarnText = service
      .getRuleFollowupHost()
      .buildMessageLimitsWarnExplanation(userLabel, 'MESSAGE_TOO_LONG', null, 'POLICE');

    expect(legacyLinkText).toBe(
      '**Алексей**, сообщение удалено. Причина: эта ссылка запрещена настройками чата. Отправьте текст без этой ссылки.',
    );
    expect(legacyWarnText).toBe(
      '**Алексей**, предупреждение по правилам чата: сообщение превышает допустимую длину.',
    );
    expect(policeLinkText).toBe(legacyLinkText);
    expect(policeWarnText).toBe(legacyWarnText);
  });

  it('renders robot, friendly and ironic templates with style presets', () => {
    const service = createService();
    const userLabel = '**Алексей**';

    expect((service as any).buildGreetingMessage(userLabel, '', 'ROBOT')).toBe(
      'Здравствуйте, **Алексей**. Я Майор Максимов. Перед общением ознакомьтесь с правилами чата.',
    );
    expect(
      (service as any).buildNightModeOpenedNotice(23 * 60, 8 * 60, 'Europe/Moscow', '', 'ROBOT'),
    ).toBe('Чат снова открыт.');

    expect((service as any).buildLinkExplanation(userLabel, true, '', 'ROBOT')).toBe(
      '**Алексей**, сообщение удалено. Причина: эта ссылка запрещена настройками чата.',
    );
    expect(
      (service as any).buildRequiredSubscriptionWarnExplanation(
        userLabel,
        ['Новости MAX'],
        '',
        'ROBOT',
      ),
    ).toBe(
      '**Алексей**, предупреждение: обязательная подписка ещё не подтверждена. Подпишитесь на Новости MAX.',
    );

    expect(
      (service as any).buildMessageLimitsExplanation(
        userLabel,
        'MESSAGE_TOO_LONG',
        true,
        1,
        5,
        1,
        5,
        187,
        100,
        null,
        '',
        'ROBOT',
      ),
    ).toBe('**Алексей**, сообщение удалено. Причина: длина сообщения 187 символов при лимите 100.');

    expect((service as any).buildDuplicateHitExplanation(userLabel, true, '', 'ROBOT')).toBe(
      '**Алексей**, обнаружен повтор сообщения. Повтор удалён.',
    );

    expect((service as any).buildDuplicateHitExplanation(userLabel, false, '', 'ROBOT')).toBe(
      '**Алексей**, обнаружен повтор сообщения. Сообщение не удалено.',
    );

    expect(
      (service as any).buildDuplicateHitExplanation(userLabel, true, '', 'ROBOT', 'image'),
    ).toBe('**Алексей**, обнаружен повтор фотографии. Повтор удалён.');

    expect(
      (service as any).buildDuplicateHitExplanation(userLabel, true, '', 'FRIENDLY', 'image_set'),
    ).toBe('**Алексей**, такой альбом уже отправляли. Повтор удалён.');

    expect(
      (service as any).buildDuplicateExplanation(
        userLabel,
        {
          action: 'WARN',
          count: 2,
          threshold: 2,
          windowSec: 30,
          hash: 'dup-hash',
          nextAction: 'MUTE',
        },
        6,
        true,
        '',
        'ROBOT',
      ),
    ).toBe('**Алексей**, обнаружен повтор сообщения. Вынесено предупреждение.');

    expect(
      service
        .getRuleFollowupHost()
        .buildMessageLimitsWarnExplanation(userLabel, 'MESSAGE_TOO_LONG', null, 'ROBOT'),
    ).toBe('**Алексей**, предупреждение: сообщение превышает допустимую длину.');

    expect((service as any).buildGreetingMessage(userLabel, '', 'POLICE')).toBe(
      'Приветствую, **Алексей**! На связи Майор Максимов. Располагайтесь — паспорт и прописка не понадобятся.',
    );

    expect((service as any).buildDuplicateHitExplanation(userLabel, true, '', 'POLICE')).toBe(
      '**Алексей**, зафиксирован повтор сообщения. Копия удалена. Для протокола достаточно одного экземпляра.',
    );

    expect((service as any).buildGreetingMessage(userLabel, '', 'FRIENDLY')).toBe(
      'Добро пожаловать, **Алексей**! 👋 Я Майор Максимов. Загляните в правила и присоединяйтесь к общению.',
    );
    expect(
      (service as any).buildNightModeOpenedNotice(23 * 60, 8 * 60, 'Europe/Moscow', '', 'FRIENDLY'),
    ).toBe('Чат снова открыт. Хорошего общения!');

    expect((service as any).buildLinkExplanation(userLabel, true, '', 'FRIENDLY')).toBe(
      '**Алексей**, сообщение удалено. Причина: эта ссылка запрещена настройками чата. Пожалуйста, отправьте текст без этой ссылки.',
    );

    expect(
      (service as any).buildMessageLimitsExplanation(
        userLabel,
        'MESSAGE_TOO_LONG',
        true,
        1,
        5,
        1,
        5,
        187,
        100,
        null,
        '',
        'FRIENDLY',
      ),
    ).toBe('**Алексей**, сообщение удалено. Причина: длина сообщения 187 символов при лимите 100.');

    expect(
      (service as any).buildMessageLimitsExplanation(
        userLabel,
        'PHOTO_RATE_LIMIT',
        true,
        1,
        5,
        2,
        5,
        undefined,
        undefined,
        null,
        '',
        'FRIENDLY',
      ),
    ).toBe(
      '**Алексей**, сообщение удалено. Причина: между отправками фото должно пройти не менее 2 ч.',
    );

    expect((service as any).buildDuplicateHitExplanation(userLabel, true, '', 'FRIENDLY')).toBe(
      '**Алексей**, такое сообщение уже отправляли. Повтор удалён.',
    );

    expect((service as any).buildDuplicateHitExplanation(userLabel, false, '', 'FRIENDLY')).toBe(
      '**Алексей**, такое сообщение уже отправляли. Сообщение не удалено.',
    );

    expect(
      (service as any).buildDuplicateExplanation(
        userLabel,
        {
          action: 'WARN',
          count: 2,
          threshold: 2,
          windowSec: 30,
          hash: 'dup-hash',
          nextAction: 'MUTE',
        },
        6,
        true,
        '',
        'FRIENDLY',
      ),
    ).toBe('**Алексей**, такое сообщение уже отправляли. Это предупреждение.');

    expect(
      service
        .getRuleFollowupHost()
        .buildMessageLimitsWarnExplanation(userLabel, 'MESSAGE_TOO_LONG', null, 'FRIENDLY'),
    ).toBe('**Алексей**, предупреждение: сообщение превышает допустимую длину.');
    expect(
      (service as any).buildRequiredSubscriptionMuteExplanation(
        userLabel,
        ['Новости MAX'],
        'FRIENDLY',
        6,
      ),
    ).toBe(
      '**Алексей**, за сообщения без подписки действует мут на 6ч. Пока он действует, новые сообщения будут удаляться. Подпишитесь на Новости MAX, чтобы продолжить общение после окончания мута.',
    );

    expect((service as any).buildGreetingMessage(userLabel, '', 'IRONIC')).toBe(
      'Привет, **Алексей**! На связи Майор Максимов. Располагайтесь — знакомиться можно без презентации на сорок слайдов.',
    );
    expect(
      (service as any).buildNightModeOpenedNotice(23 * 60, 8 * 60, 'Europe/Moscow', '', 'IRONIC'),
    ).toBe('Чат снова открыт. Совещание по итогам тишины отменяется.');

    expect((service as any).buildLinkExplanation(userLabel, true, '', 'IRONIC')).toBe(
      '**Алексей**, сообщение удалено. Причина: эта ссылка запрещена настройками чата. Отправьте текст без этой ссылки.',
    );

    expect((service as any).buildDuplicateHitExplanation(userLabel, true, '', 'IRONIC')).toBe(
      '**Алексей**, это сообщение уже отправляли. Копия удалена. Повторный показ отменяется.',
    );

    expect(
      (service as any).buildDuplicateExplanation(
        userLabel,
        {
          action: 'WARN',
          count: 2,
          threshold: 2,
          windowSec: 30,
          hash: 'dup-hash',
          nextAction: 'MUTE',
        },
        6,
        true,
        '',
        'IRONIC',
      ),
    ).toBe('**Алексей**, это сообщение уже отправляли. Вынесено предупреждение.');
  });

  it('keeps inherited invitation counters grammatical without rewriting custom copy', () => {
    const service = createService();
    const userLabel = '**Алексей**';

    expect(
      (service as any).buildInvitationAccessExplanation(userLabel, true, 3, 2, '', 'ROBOT'),
    ).toBe(
      '**Алексей**, сообщение удалено. Чтобы писать в чат, осталось пригласить 1 друга. Засчитано 2 из 3.',
    );
    expect((service as any).buildInvitationAccessMuteExplanation(userLabel, 3, 1, 'POLICE')).toBe(
      '**Алексей**, действует мут: не выполнено условие по приглашениям. Для участия осталось пригласить 2 друзей.',
    );
    expect(
      (service as any).buildInvitationAccessExplanation(
        userLabel,
        true,
        3,
        2,
        'Осталось: {remaining_invites}.',
        'ROBOT',
      ),
    ).toBe('Осталось: 1 друга.');
  });

  it.each(BOT_SPEECH_STYLE_VALUES)(
    'keeps actual deletion status explicit in %s notices',
    (style) => {
      const service = createService() as any;
      const user = '**Алексей**';
      const notices = (deleted: boolean): string[] => [
        service.buildLinkExplanation(user, deleted, '', style),
        service.buildLinkExplanation(user, deleted, '', style, true),
        service.buildRequiredSubscriptionExplanation(user, deleted, ['Новости MAX'], '', style),
        service.buildInvitationAccessExplanation(user, deleted, 3, 2, '', style),
        service.buildTextFilterExplanation(user, 'COMMERCIAL_AD', deleted, '', style),
        service.buildTextFilterExplanation(user, 'PROFANITY', deleted, '', style),
        service.buildMessageLimitsExplanation(
          user,
          'MESSAGE_TOO_LONG',
          deleted,
          5,
          1,
          1,
          5,
          187,
          100,
          null,
          '',
          style,
        ),
        service.buildPhoneNumbersExplanation(user, deleted, '', style),
      ];

      for (const message of notices(true)) {
        expect(message).toContain('удалено.');
        expect(message).not.toContain('не удалено');
      }
      for (const message of notices(false)) {
        expect(message).toContain('не удалено.');
        expect(message).not.toContain('не удалено:');
      }
      expect(
        service.buildRequiredSubscriptionExplanation(user, null, ['Новости MAX'], '', style),
      ).toContain('сообщение ожидает удаления.');
      for (const fingerprint of ['exact', 'image', 'image_set']) {
        const removed = service.buildDuplicateHitExplanation(user, true, '', style, fingerprint);
        const kept = service.buildDuplicateHitExplanation(user, false, '', style, fingerprint);
        expect(removed).toMatch(/(?:удален[ао]|удалён)/u);
        expect(kept).toContain(
          style === 'ROBOT' || style === 'FRIENDLY'
            ? 'Сообщение не удалено.'
            : 'Сообщение осталось в чате.',
        );
      }
    },
  );

  it.each([
    [
      'image',
      '**Алексей**, зафиксирован повтор фото. Копия удалена. Для протокола достаточно одного экземпляра.',
    ],
    [
      'image_set',
      '**Алексей**, зафиксирован повтор альбома. Копия удалена. Для протокола достаточно одного экземпляра.',
    ],
  ])('uses POLICE copy for the unset style and %s duplicates', (fingerprint, expected) => {
    const service = createService() as any;
    expect(service.buildDuplicateHitExplanation('**Алексей**', true, '', null, fingerprint)).toBe(
      expected,
    );
    expect(
      service.buildDuplicateHitExplanation('**Алексей**', true, '', 'POLICE', fingerprint),
    ).toBe(expected);
    const decision = { action: 'WARN', count: 2, threshold: 2, windowSec: 30, hash: 'photo-hash' };
    expect(
      service.buildDuplicateExplanation('**Алексей**', decision, 6, true, '', null, fingerprint),
    ).toBe(
      service.buildDuplicateExplanation(
        '**Алексей**',
        decision,
        6,
        true,
        '',
        'POLICE',
        fingerprint,
      ),
    );
  });

  it.each(BOT_SPEECH_STYLE_VALUES)(
    'renders every inherited %s scenario without missing context',
    (style) => {
      const service = createService() as any;
      const user = '**Алексей**';
      const channels = ['Новости MAX'];
      const messages: string[] = [
        service.buildGreetingMessage(user, '', style),
        service.buildLinkExplanation(user, true, '', style),
        service.buildLinkExplanation(user, false, '', style, true),
        service.buildLinkWarnExplanation(user, '', style),
        service.buildLinkWarnExplanation(user, '', style, true),
        service.buildLinkMuteExplanation(user, style),
        service.buildRequiredSubscriptionExplanation(user, null, channels, '', style),
        service.buildRequiredSubscriptionWarnExplanation(user, channels, '', style),
        service.buildRequiredSubscriptionMuteExplanation(user, channels, style, 6),
        service.buildRequiredSubscriptionBanExplanation(user, channels, 6, style),
        service.buildInvitationAccessExplanation(user, true, 3, 2, '', style),
        service.buildInvitationAccessWarnExplanation(user, 3, 2, '', style),
        service.buildInvitationAccessMuteExplanation(user, 3, 2, style),
        service.buildInvitationAccessBanExplanation(user, 3, 2, 6, style),
        service.buildTextFilterMuteExplanation(user, 'OTHER', style),
        service.buildPhoneNumbersExplanation(user, false, '', style),
        service.buildMuteNotice(user, 6, style),
        service.buildPermanentBanNotice(user, style),
        service.buildNightModeClosedNotice(23 * 60, 8 * 60, 'Europe/Moscow', '', style),
        service.buildNightModeOpenedNotice(23 * 60, 8 * 60, 'Europe/Moscow', '', style),
      ];
      for (const rule of ['COMMERCIAL_AD', 'PROFANITY']) {
        messages.push(
          service.buildTextFilterExplanation(user, rule, true, '', style),
          service.buildTextFilterWarnExplanation(user, rule, '', style),
          service.buildTextFilterMuteExplanation(user, rule, style),
        );
      }
      for (const rule of [
        'MESSAGE_COUNT_LIMIT',
        'MESSAGE_RATE_LIMIT',
        'MESSAGE_TOO_LONG',
        'PHOTO_RATE_LIMIT',
        'STICKER_RATE_LIMIT',
        'PHOTO_BLOCKED',
        'VIDEO_BLOCKED',
        'FILE_BLOCKED',
        'VOICE_BLOCKED',
        'FORWARDED_MESSAGE_BLOCKED',
        'PHONE_NUMBER_BLOCKED',
        'MESSAGE_BLOCKED_WORD',
        'MESSAGE_BLOCKED_DOMAIN',
      ]) {
        messages.push(
          service.buildMessageLimitsExplanation(
            user,
            rule,
            true,
            2,
            1,
            1,
            5,
            187,
            100,
            'тест',
            '',
            style,
          ),
          service
            .getRuleFollowupHost()
            .buildMessageLimitsWarnExplanation(user, rule, 'тест', style),
          service
            .getRuleFollowupHost()
            .buildMessageLimitsMuteExplanation(user, rule, 'тест', style),
          service
            .getRuleFollowupHost()
            .buildMessageLimitsBanExplanation(user, rule, 6, 'тест', style),
        );
      }
      for (const fingerprint of ['exact', 'image', 'image_set']) {
        messages.push(
          service.buildDuplicateHitExplanation(user, true, '', style, fingerprint),
          service.buildDuplicateHitExplanation(user, false, '', style, fingerprint),
        );
        for (const action of ['WARN', 'MUTE', 'BAN']) {
          messages.push(
            service.buildDuplicateExplanation(
              user,
              { action, count: 4, threshold: 2, windowSec: 30, hash: 'duplicate-hash' },
              6,
              true,
              '',
              style,
              fingerprint,
            ),
          );
        }
      }

      for (const message of messages) {
        expect(message.trim()).not.toBe('');
        expect(message).not.toMatch(/\{[a-z_]+\}|undefined|NaN/u);
      }
      const subscriptionMute = service.buildRequiredSubscriptionMuteExplanation(
        user,
        channels,
        style,
        6,
      );
      expect(subscriptionMute).toContain('мут на 6ч');
      expect(subscriptionMute).toContain('Новости MAX');
      expect(subscriptionMute).toContain('новые сообщения будут удаляться');
    },
  );

  it.each([1, 2, 5, 10])(
    'keeps a %s-message quota grammatical without changing custom placeholders',
    (count) => {
      const service = createService() as any;
      const inherited = service.buildMessageLimitsExplanation(
        '**Алексей**',
        'MESSAGE_COUNT_LIMIT',
        true,
        count,
        1,
        1,
        5,
        undefined,
        undefined,
        null,
        '',
        'ROBOT',
      );
      expect(inherited).toBe(
        `**Алексей**, сообщение удалено. Причина: превышен лимит сообщений: ${count} за 1 ч.`,
      );
      const custom = service.buildMessageLimitsExplanation(
        '**Алексей**',
        'MESSAGE_COUNT_LIMIT',
        true,
        count,
        1,
        1,
        5,
        undefined,
        undefined,
        null,
        'Причина: {reason}.',
        'ROBOT',
      );
      expect(custom).toBe(`Причина: слишком частая отправка сообщений: не более ${count} за 1ч.`);
    },
  );

  it.each(BOT_SPEECH_STYLE_VALUES)(
    'includes the saved quota in %s warnings, mutes and bans',
    (style) => {
      const host = createService().getRuleFollowupHost();
      const quota = { messageCountLimitMessages: 2, messageCountLimitWindowHours: 6 };
      const userLabel = '**Алексей**';
      const messages = [
        host.buildMessageLimitsWarnExplanation(
          userLabel,
          'MESSAGE_COUNT_LIMIT',
          null,
          style,
          '',
          quota,
        ),
        host.buildMessageLimitsMuteExplanation(
          userLabel,
          'MESSAGE_COUNT_LIMIT',
          null,
          style,
          quota,
        ),
        host.buildMessageLimitsBanExplanation(
          userLabel,
          'MESSAGE_COUNT_LIMIT',
          6,
          null,
          style,
          quota,
        ),
      ];
      for (const message of messages) {
        expect(message).toContain('превышен лимит сообщений: 2 за 6 ч');
        expect(message).not.toMatch(/\{[a-z_]+\}|undefined|NaN/u);
      }
    },
  );

  it('preserves custom quota warning sources and placeholders through the host facade', () => {
    const host = createService().getRuleFollowupHost();
    const quota = { messageCountLimitMessages: 3, messageCountLimitWindowHours: 24 };
    const warn = (templateText: string) =>
      host.buildMessageLimitsWarnExplanation(
        '**Алексей**',
        'MESSAGE_COUNT_LIMIT',
        null,
        'ROBOT',
        templateText,
        quota,
      );

    expect(warn('  Свой текст для {user}: {reason}.\n')).toBe(
      '  Свой текст для **Алексей**: слишком частая отправка сообщений: не более 3 за 24ч.\n',
    );
    expect(warn('  Свой текст для {user}.\n')).toBe('  Свой текст для **Алексей**.\n');
    expect(warn('   ')).toBe('   ');
    expect(warn(getBotSpeechEditableTemplate('ROBOT', 'messageLimitsWarnMessageText'))).toBe(
      '**Алексей**, предупреждение: слишком частая отправка сообщений: не более 3 за 24ч.',
    );
  });

  it('keeps host quota sanctions without optional context compatible', () => {
    const host = createService().getRuleFollowupHost();
    for (const message of [
      host.buildMessageLimitsWarnExplanation('Алексей', 'MESSAGE_COUNT_LIMIT', null, 'ROBOT'),
      host.buildMessageLimitsMuteExplanation('Алексей', 'MESSAGE_COUNT_LIMIT', null, 'ROBOT'),
      host.buildMessageLimitsBanExplanation('Алексей', 'MESSAGE_COUNT_LIMIT', 6, null, 'ROBOT'),
    ]) {
      expect(message).toContain('лимит сообщений за выбранный период превышен');
    }
  });

  it('keeps current sanction defaults gender-neutral for every bot persona', () => {
    expect(getBotSpeechEditableTemplate('POLICE', 'linkBotMessageText', 'female')).toBe(
      getBotSpeechEditableTemplate('POLICE', 'linkBotMessageText', 'male'),
    );
    expect(getBotSpeechEditableTemplate('POLICE', 'duplicateBotMessageText', 'neutral')).toBe(
      getBotSpeechEditableTemplate('POLICE', 'duplicateBotMessageText', 'male'),
    );
    expect(getBotSpeechSystemTemplate('POLICE', 'messageLimitsWarn', 'female')).toBe(
      getBotSpeechSystemTemplate('POLICE', 'messageLimitsWarn', 'neutral'),
    );
    expect(getBotSpeechSystemTemplate('POLICE', 'messageLimitsWarn', 'neutral')).not.toMatch(
      /(?:^|[^\p{L}])(?:взял|взяла|прикрыл|прикрыла)(?=$|[^\p{L}])/u,
    );
  });

  it('keeps system notices on the selected base style when one editable field is overridden', () => {
    const service = createService();
    const userLabel = '**Алексей**';

    expect(
      (service as any).buildLinkExplanation(
        userLabel,
        true,
        'Ручной разбор для {user}. Причина: {reason}.',
        'IRONIC',
      ),
    ).toBe('Ручной разбор для **Алексей**. Причина: в этом чате ссылки не проходят, без ссылок.');

    expect(
      service
        .getRuleFollowupHost()
        .buildMessageLimitsWarnExplanation(userLabel, 'MESSAGE_TOO_LONG', null, 'IRONIC'),
    ).toBe('**Алексей**, предупреждение по правилам чата: сообщение превышает допустимую длину.');

    expect((service as any).buildLinkMuteExplanation(userLabel, 'IRONIC')).toBe(
      '**Алексей**, действует мут за запрещённую ссылку.',
    );
    expect((service as any).buildMuteNotice(userLabel, 6, 'IRONIC')).toBe(
      '**Алексей**, действует мут на 6ч. До его окончания новые сообщения будут удаляться.',
    );
  });

  it('uses subtle edited-message copy for default link notices', () => {
    const service = createService();
    const userLabel = '**Алексей**';

    expect((service as any).buildLinkExplanation(userLabel, true, '', 'POLICE', true)).toBe(
      '**Алексей**, после редактирования сообщение удалено. Причина: добавленная при редактировании ссылка запрещена настройками чата. Отправьте текст без этой ссылки.',
    );
    expect((service as any).buildLinkWarnExplanation(userLabel, '', 'POLICE', true)).toBe(
      '**Алексей**, предупреждение: добавленная при редактировании ссылка запрещена настройками чата. Уберите эту ссылку.',
    );

    expect(
      (service as any).buildLinkWarnExplanation(
        userLabel,
        'Ручной текст: {warning}. Причина: {reason}.',
        'POLICE',
        true,
      ),
    ).toBe(
      'Ручной текст: вынесено предупреждение за ссылку после редактирования. Причина: ссылка появилась после тихой правки; в этом чате ссылки всё ещё нельзя.',
    );
  });

  it('uses new defaults only for inherited fields and preserves legacy custom rendering', () => {
    const service = createService();
    const userLabel = '**Алексей**';
    const formerRobotDefault = '🔗 {user}, сообщение {message_status}. Причина: {reason}.';

    expect((service as any).buildLinkExplanation(userLabel, true, '', 'ROBOT')).toBe(
      '**Алексей**, сообщение удалено. Причина: эта ссылка запрещена настройками чата.',
    );
    expect(
      (service as any).buildLinkExplanation(userLabel, true, formerRobotDefault, 'ROBOT'),
    ).toBe(
      '🔗 **Алексей**, сообщение снято с линии. Причина: в этом чате ссылки не проходят, без ссылок.',
    );

    expect(
      (service as any).buildDuplicateExplanation(
        userLabel,
        {
          action: 'WARN',
          count: 2,
          threshold: 2,
          windowSec: 30,
          hash: 'dup-custom-hash',
          nextAction: 'MUTE',
        },
        6,
        false,
        'Статус: {message_status}. Контекст: {duplicate_context}. {sanction}',
        'ROBOT',
      ),
    ).toBe('Статус: не по форме. Контекст: идёт повтором. ⚠️ Предупреждение записано.');

    expect((service as any).buildPhoneNumbersExplanation(userLabel, true, '', 'POLICE')).toBe(
      '**Алексей**, сообщение удалено. Причина: номера телефонов в сообщениях запрещены. Уберите номер телефона перед повторной отправкой.',
    );
    expect(
      (service as any).buildPhoneNumbersExplanation(
        userLabel,
        true,
        '☎️ {user}, сообщение {message_status}. Причина: {reason}.',
        'POLICE',
      ),
    ).toBe(
      '☎️ **Алексей**, сообщение снято с линии. Причина: телефонные номера в этом чате запрещены.',
    );

    expect(
      (service as any).buildTextFilterExplanation(
        userLabel,
        'COMMERCIAL_AD',
        true,
        'Своя проверка: {message_status}; {reason}.',
        'POLICE',
      ),
    ).toBe('Своя проверка: снято с линии; коммерческая реклама в этом чате запрещена.');
  });

  it('preserves every non-empty custom template without trimming whitespace', () => {
    const service = createService();
    const customTemplate = '  Свой текст для {user}.\n';

    expect(
      (service as any).buildLinkExplanation('**Алексей**', true, customTemplate, 'ROBOT'),
    ).toBe('  Свой текст для **Алексей**.\n');
    expect(
      hasBotSpeechEditableOverrides(
        createBotSpeechSettings({
          linkBotMessageText: '   ',
        }),
      ),
    ).toBe(true);
  });

  it('keeps shared default templates accurate for ads and blocked content', () => {
    const service = createService();
    const userLabel = '**Алексей**';

    expect(
      (service as any).buildTextFilterExplanation(userLabel, 'COMMERCIAL_AD', true, '', 'FRIENDLY'),
    ).toBe(
      '**Алексей**, сообщение удалено. Причина: коммерческая реклама запрещена правилами чата.',
    );
    expect(
      (service as any).buildMessageLimitsExplanation(
        userLabel,
        'MESSAGE_BLOCKED_WORD',
        true,
        5,
        1,
        1,
        5,
        undefined,
        undefined,
        'казино',
        '',
        'IRONIC',
      ),
    ).toBe(
      '**Алексей**, сообщение удалено. Ограничение чата: сообщение совпало со стоп-листом чата.',
    );
    expect(
      service
        .getRuleFollowupHost()
        .buildMessageLimitsMuteExplanation(userLabel, 'VOICE_BLOCKED', null, 'POLICE'),
    ).toBe(
      '**Алексей**, действует мут. Причина: отправка голосовых сообщений в этом чате отключена.',
    );
  });

  it('keeps placeholder sets aligned and all current presets persona-neutral', () => {
    const genderedOrForeignPersonaCopy =
      /(?:^|[^\p{L}])(?:Майор|Максимов|Максимова|Капитан|взял|взяла|прикрыл|прикрыла|включил|включила|убрал|убрала)(?=$|[^\p{L}])/iu;

    for (const fieldKey of BOT_SPEECH_EDITABLE_FIELD_KEYS) {
      for (const style of BOT_SPEECH_STYLE_VALUES) {
        const omitted =
          fieldKey === 'invitationAccessBotMessageText'
            ? INVITATION_PLACEHOLDER_OMISSIONS[style].explanation
            : fieldKey === 'invitationAccessWarnMessageText'
              ? INVITATION_PLACEHOLDER_OMISSIONS[style].warning
              : [];
        const expectedPlaceholders = EXPECTED_EDITABLE_PLACEHOLDERS[fieldKey].filter(
          (placeholder) => !omitted.includes(placeholder),
        );
        const neutralTemplate = getBotSpeechEditableTemplate(style, fieldKey, 'neutral');
        expect(extractTemplatePlaceholders(neutralTemplate)).toEqual(expectedPlaceholders);
        expect(neutralTemplate).not.toMatch(genderedOrForeignPersonaCopy);
        for (const persona of BOT_SPEECH_PERSONA_VALUES) {
          expect(getBotSpeechEditableTemplate(style, fieldKey, persona)).toBe(neutralTemplate);
        }
      }
    }

    for (const templateKey of BOT_SPEECH_SYSTEM_TEMPLATE_KEYS) {
      const expectedPlaceholders = EXPECTED_SYSTEM_PLACEHOLDERS[templateKey];
      for (const style of BOT_SPEECH_STYLE_VALUES) {
        const neutralTemplate = getBotSpeechSystemTemplate(style, templateKey, 'neutral');
        expect(extractTemplatePlaceholders(neutralTemplate)).toEqual(expectedPlaceholders);
        expect(neutralTemplate).not.toMatch(genderedOrForeignPersonaCopy);
        for (const persona of BOT_SPEECH_PERSONA_VALUES) {
          expect(getBotSpeechSystemTemplate(style, templateKey, persona)).toBe(neutralTemplate);
        }
      }
    }
  });

  it('keeps link mute copy accurate when the configured threshold is one', () => {
    for (const style of BOT_SPEECH_STYLE_VALUES) {
      expect(getBotSpeechSystemTemplate(style, 'linkMute')).not.toMatch(/повтор|новые ссылки/iu);
    }
  });

  it('keeps inherited fields empty while switching them to the selected style fallback', () => {
    const nextSettings = applyBotSpeechStylePreset(
      createBotSpeechSettings({
        botSpeechStyle: 'POLICE',
      }),
      'FRIENDLY',
    );

    expect(hasBotSpeechEditableOverrides(nextSettings)).toBe(false);
    expect(nextSettings.botSpeechStyle).toBe('FRIENDLY');

    for (const key of BOT_SPEECH_EDITABLE_FIELD_KEYS) {
      expect(nextSettings[key]).toBe('');
      expect(getBotSpeechEditableTemplate(nextSettings.botSpeechStyle, key)).not.toBe('');
    }
    expect(
      getBotSpeechEditableTemplate(nextSettings.botSpeechStyle, 'greetingBotMessageText'),
    ).toBe(
      'Добро пожаловать, {user}! 👋 Я {bot_character_name}. Загляните в правила и присоединяйтесь к общению.',
    );
  });

  it('preserves every custom template byte-for-byte when switching styles', () => {
    const settings = createBotSpeechSettings({ botSpeechStyle: 'POLICE' });
    for (const [index, key] of BOT_SPEECH_EDITABLE_FIELD_KEYS.entries()) {
      settings[key] = index === 0 ? '   ' : `  Свой текст ${key}.\n`;
    }

    const nextSettings = applyBotSpeechStylePreset(settings, 'IRONIC');

    expect(nextSettings.botSpeechStyle).toBe('IRONIC');
    expect(hasBotSpeechEditableOverrides(nextSettings)).toBe(true);
    for (const key of BOT_SPEECH_EDITABLE_FIELD_KEYS) {
      expect(nextSettings[key]).toBe(settings[key]);
    }
  });

  it('detects manual overrides before preset reset', () => {
    expect(
      hasBotSpeechEditableOverrides(
        createBotSpeechSettings({
          textFiltersWarnMessageText: 'Ручное предупреждение',
        }),
      ),
    ).toBe(true);
  });
});
