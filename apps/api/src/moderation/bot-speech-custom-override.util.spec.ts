import {
  buildLegacyDuplicatePassiveSanctionLabel,
  buildLegacyDuplicateSanctionLabel,
  buildMessageLimitsExplanationReplacements,
  hasCustomBotSpeechTemplate,
  resolveBotSpeechDuplicateContext,
  resolveBotSpeechMessageStatus,
  resolveMessageLimitsSanctionReason,
  resolveTextFilterExplanationReason,
} from './bot-speech-custom-override.util';

describe('bot speech custom override compatibility', () => {
  it('treats only non-empty stored values as custom', () => {
    expect(hasCustomBotSpeechTemplate('')).toBe(false);
    expect(hasCustomBotSpeechTemplate('   ')).toBe(true);
    expect(hasCustomBotSpeechTemplate('Свой текст')).toBe(true);
  });

  it('keeps legacy status and duplicate placeholders for custom templates', () => {
    expect(resolveBotSpeechMessageStatus('Свой {message_status}', true)).toBe('снято с линии');
    expect(resolveBotSpeechMessageStatus('', true)).toBe('удалено');
    expect(resolveBotSpeechDuplicateContext('Свой {duplicate_context}', false)).toBe(
      'идёт повтором',
    );
    expect(resolveBotSpeechDuplicateContext('', false)).toBe('отмечено как повтор');
  });

  it.each([
    ['male', 'Взял на карандаш 📝.'],
    ['female', 'Взяла на карандаш 📝.'],
    ['neutral', 'Предупреждение за повтор зафиксировано 📝.'],
  ] as const)(
    'keeps police duplicate warnings consistent with the %s persona',
    (persona, expected) => {
      expect(
        buildLegacyDuplicateSanctionLabel({
          style: 'POLICE',
          persona,
          action: 'WARN',
          muteDurationLabel: '2 часа',
        }),
      ).toBe(expected);
    },
  );

  it.each([
    ['male', '🔒 Включил мут на 2 часа.'],
    ['female', '🔒 Включила мут на 2 часа.'],
    ['neutral', '🔒 Мут включён на 2 часа.'],
  ] as const)(
    'keeps friendly duplicate mutes consistent with the %s persona',
    (persona, expected) => {
      expect(
        buildLegacyDuplicateSanctionLabel({
          style: 'FRIENDLY',
          persona,
          action: 'MUTE',
          muteDurationLabel: '2 часа',
        }),
      ).toBe(expected);
    },
  );

  it.each([
    ['POLICE', false, 'Повтор обнаружен.'],
    ['POLICE', true, 'Повтор удалён.'],
    [null, false, 'Повтор обнаружен.'],
    ['FRIENDLY', false, 'Повтор обнаружен.'],
    ['FRIENDLY', true, 'Повтор удалён.'],
    ['IRONIC', false, 'Повтор обнаружен.'],
    ['IRONIC', true, 'Повтор удалён.'],
  ] as const)(
    'uses neutral duplicate placeholder copy for Rex in %s style when deleted=%s',
    (style, messageDeleted, expected) => {
      expect(
        buildLegacyDuplicatePassiveSanctionLabel({
          style,
          persona: 'neutral',
          messageDeleted,
        }),
      ).toBe(expected);
    },
  );

  it.each([
    ['FRIENDLY', 'male', 'Повтор удалён.'],
    ['FRIENDLY', 'female', 'Повтор удалён.'],
    ['IRONIC', 'male', 'Повтор удалён.'],
    ['IRONIC', 'female', 'Повтор удалён.'],
  ] as const)(
    'keeps passive duplicate copy consistent for the %s style and %s persona',
    (style, persona, expected) => {
      expect(
        buildLegacyDuplicatePassiveSanctionLabel({
          style,
          persona,
          messageDeleted: true,
        }),
      ).toBe(expected);
    },
  );

  it('keeps legacy text-filter reasons only for custom templates', () => {
    expect(resolveTextFilterExplanationReason('COMMERCIAL_AD', 'Свой {reason}')).toBe(
      'коммерческая реклама в этом чате запрещена',
    );
    expect(resolveTextFilterExplanationReason('COMMERCIAL_AD', '')).toBe(
      'коммерческая реклама запрещена правилами чата',
    );
  });

  it('keeps legacy message-limit placeholders while inherited defaults use current copy', () => {
    const custom = buildMessageLimitsExplanationReplacements({
      templateText: 'Статус: {message_status}. Причина: {reason}.',
      ruleCode: 'MESSAGE_TOO_LONG',
      messageDeleted: true,
      messageCountLimitMessages: 5,
      messageCountLimitWindowHours: 1,
      photoCooldownHours: 2,
      stickerCooldownMinutes: 5,
      messageLength: 187,
      maxMessageLength: 100,
    });
    const inherited = buildMessageLimitsExplanationReplacements({
      templateText: '',
      ruleCode: 'MESSAGE_TOO_LONG',
      messageDeleted: true,
      messageCountLimitMessages: 5,
      messageCountLimitWindowHours: 1,
      photoCooldownHours: 2,
      stickerCooldownMinutes: 5,
      messageLength: 187,
      maxMessageLength: 100,
    });

    expect(custom).toMatchObject({
      message_status: 'снято с линии',
      reason: 'слишком длинное сообщение: 187 символов при лимите 100',
    });
    expect(inherited).toMatchObject({
      message_status: 'удалено',
      reason: 'длина сообщения 187 символов при лимите 100',
    });
  });

  it.each([
    [101, '101 символ'],
    [102, '102 символа'],
    [105, '105 символов'],
    [111, '111 символов'],
    [114, '114 символов'],
    [121, '121 символ'],
    [124, '124 символа'],
  ] as const)(
    'declines an inherited %i-character explanation while preserving custom wording',
    (messageLength, characterCount) => {
      const context = {
        ruleCode: 'MESSAGE_TOO_LONG',
        messageDeleted: true,
        messageCountLimitMessages: 5,
        messageCountLimitWindowHours: 1,
        photoCooldownHours: 2,
        stickerCooldownMinutes: 5,
        messageLength,
        maxMessageLength: 100,
      };
      expect(buildMessageLimitsExplanationReplacements({ ...context, templateText: '' })).toEqual({
        reason: `длина сообщения ${characterCount} при лимите 100`,
        message_status: 'удалено',
        actual_length: String(messageLength),
        max_length: '100',
      });
      for (const templateText of ['Своя причина: {reason}', '   ']) {
        expect(buildMessageLimitsExplanationReplacements({ ...context, templateText })).toEqual({
          reason: `слишком длинное сообщение: ${messageLength} символов при лимите 100`,
          message_status: 'снято с линии',
          actual_length: String(messageLength),
          max_length: '100',
        });
      }
    },
  );

  it.each([1, 2, 5, 10])(
    'keeps count limits grammatical for %i without changing custom reasons',
    (count) => {
      const context = {
        ruleCode: 'MESSAGE_COUNT_LIMIT',
        messageDeleted: false,
        messageCountLimitMessages: count,
        messageCountLimitWindowHours: 6,
        photoCooldownHours: 2,
        stickerCooldownMinutes: 5,
      };
      expect(
        buildMessageLimitsExplanationReplacements({ ...context, templateText: '' }),
      ).toMatchObject({
        reason: `превышен лимит сообщений: ${count} за 6 ч`,
        message_status: 'не удалено',
        message_limit_count: String(count),
        message_limit_window_hours: '6',
      });
      for (const templateText of ['Свой текст: {reason}', '   ']) {
        expect(
          buildMessageLimitsExplanationReplacements({ ...context, templateText }),
        ).toMatchObject({
          reason: `слишком частая отправка сообщений: не более ${count} за 6ч`,
          message_status: 'не по форме',
        });
      }
    },
  );

  it.each([1, 2, 5, 10])(
    'includes the configured %i-message quota in sanction reasons',
    (count) => {
      for (const hours of [1, 6, 24]) {
        const quota = {
          messageCountLimitMessages: count,
          messageCountLimitWindowHours: hours,
        };
        expect(resolveMessageLimitsSanctionReason('MESSAGE_COUNT_LIMIT', null, '', quota)).toBe(
          `превышен лимит сообщений: ${count} за ${hours} ч`,
        );
        expect(
          resolveMessageLimitsSanctionReason('MESSAGE_COUNT_LIMIT', null, undefined, quota),
        ).toBe(`превышен лимит сообщений: ${count} за ${hours} ч`);
        for (const templateText of ['Свой текст: {reason}', '   ']) {
          expect(
            resolveMessageLimitsSanctionReason('MESSAGE_COUNT_LIMIT', null, templateText, quota),
          ).toBe(`слишком частая отправка сообщений: не более ${count} за ${hours}ч`);
        }
      }
    },
  );

  it('keeps quota-less and unrelated sanction reasons compatible', () => {
    expect(resolveMessageLimitsSanctionReason('MESSAGE_COUNT_LIMIT', null, '')).toBe(
      'лимит сообщений за выбранный период превышен',
    );
    expect(resolveMessageLimitsSanctionReason('MESSAGE_COUNT_LIMIT', null, 'Свой {reason}')).toBe(
      'слишком частая отправка сообщений',
    );
    const quota = { messageCountLimitMessages: 2, messageCountLimitWindowHours: 24 };
    for (const ruleCode of [
      'MESSAGE_BLOCKED_WORD',
      'MESSAGE_BLOCKED_DOMAIN',
      'PHONE_NUMBER_BLOCKED',
      'MESSAGE_TOO_LONG',
      'MESSAGE_RATE_LIMIT',
      'PHOTO_RATE_LIMIT',
      'STICKER_RATE_LIMIT',
      'PHOTO_BLOCKED',
      'VIDEO_BLOCKED',
      'FILE_BLOCKED',
      'VOICE_BLOCKED',
      'FORWARDED_MESSAGE_BLOCKED',
      'UNKNOWN_LIMIT',
    ]) {
      for (const templateText of ['', 'Свой {reason}', '   ']) {
        expect(resolveMessageLimitsSanctionReason(ruleCode, 'казино', templateText, quota)).toBe(
          resolveMessageLimitsSanctionReason(ruleCode, 'казино', templateText),
        );
      }
    }
  });

  it('uses the same safe quota defaults in initial and sanction explanations', () => {
    const quota = { messageCountLimitMessages: Number.NaN, messageCountLimitWindowHours: 25 };
    expect(resolveMessageLimitsSanctionReason('MESSAGE_COUNT_LIMIT', null, '', quota)).toBe(
      'превышен лимит сообщений: 5 за 1 ч',
    );
  });

  it('does not expose blocked tokens and preserves custom blocked-list wording', () => {
    expect(
      buildMessageLimitsExplanationReplacements({
        templateText: 'Причина: {reason}.',
        ruleCode: 'MESSAGE_BLOCKED_WORD',
        messageDeleted: true,
        messageCountLimitMessages: 5,
        messageCountLimitWindowHours: 1,
        photoCooldownHours: 2,
        stickerCooldownMinutes: 5,
        blockedWord: 'казино',
      }).reason,
    ).toBe('такие сообщения запрещены в чате');
    expect(
      buildMessageLimitsExplanationReplacements({
        templateText: '',
        ruleCode: 'MESSAGE_BLOCKED_WORD',
        messageDeleted: true,
        messageCountLimitMessages: 5,
        messageCountLimitWindowHours: 1,
        photoCooldownHours: 2,
        stickerCooldownMinutes: 5,
        blockedWord: 'казино',
      }).reason,
    ).toBe('сообщение совпало со стоп-листом чата');
    expect(resolveMessageLimitsSanctionReason('MESSAGE_BLOCKED_WORD', 'казино', 'Свой')).toBe(
      'такие сообщения запрещены в чате',
    );
    expect(resolveMessageLimitsSanctionReason('MESSAGE_BLOCKED_WORD', 'казино', '')).toBe(
      'сообщение совпало со стоп-листом чата',
    );
    expect(resolveMessageLimitsSanctionReason('PHOTO_RATE_LIMIT', null, '')).toBe(
      'фото отправляются чаще, чем разрешено в чате',
    );
    expect(resolveMessageLimitsSanctionReason('PHOTO_RATE_LIMIT', null, 'Свой шаблон')).toBe(
      'слишком частая отправка фото',
    );
    expect(resolveMessageLimitsSanctionReason('STICKER_RATE_LIMIT', null, '')).toBe(
      'стикеры отправляются чаще, чем разрешено в чате',
    );
    expect(resolveMessageLimitsSanctionReason('UNKNOWN_LIMIT', null, '')).toBe(
      'нарушено ограничение на отправку сообщений',
    );
  });
});
