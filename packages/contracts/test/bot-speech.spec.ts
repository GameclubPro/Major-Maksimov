import { describe, expect, it } from 'vitest';
import {
  BOT_SPEECH_EDITABLE_FIELD_KEYS,
  BOT_SPEECH_PERSONA_VALUES,
  BOT_SPEECH_STYLE_VALUES,
  applyBotSpeechStylePreset,
  getBotSpeechEditableTemplate,
  getBotSpeechSystemTemplate,
  hasBotSpeechEditableOverrides,
  hasCustomBotSpeechText,
  updateBotSpeechStyleRequestSchema,
  updateBotSpeechStyleResponseSchema,
  type BotSpeechSettingsSubset,
} from '@maxim/contracts/bot-speech';

const revision = '2026-10-04T10:00:00.000Z';

describe('dedicated speech style update contract', () => {
  it.each(BOT_SPEECH_STYLE_VALUES)('accepts only the selected %s style in the request', (style) => {
    expect(updateBotSpeechStyleRequestSchema.parse({ botSpeechStyle: style })).toEqual({
      botSpeechStyle: style,
    });
    expect(
      updateBotSpeechStyleResponseSchema.parse({
        botSpeechStyle: style,
        settingsRevision: revision,
      }),
    ).toEqual({ botSpeechStyle: style, settingsRevision: revision });
  });

  it.each([
    {},
    { botSpeechStyle: null },
    { botSpeechStyle: 'CUSTOM' },
    { botSpeechStyle: 'FRIENDLY', greetingBotMessageText: '' },
    { botSpeechStyle: 'FRIENDLY', botSpeechMedia: {} },
    { botSpeechStyle: 'FRIENDLY', settingsRevision: revision },
    { botSpeechStyle: 'FRIENDLY', mode: 'all' },
  ])('rejects invalid or unrelated mutations: %j', (request) => {
    expect(updateBotSpeechStyleRequestSchema.safeParse(request).success).toBe(false);
  });

  it.each([
    { botSpeechStyle: 'FRIENDLY' },
    { botSpeechStyle: 'FRIENDLY', settingsRevision: 'not-a-revision' },
    { botSpeechStyle: 'FRIENDLY', settingsRevision: revision, greetingBotMessageText: '' },
  ])('requires a valid revision without unrelated response fields: %j', (response) => {
    expect(updateBotSpeechStyleResponseSchema.safeParse(response).success).toBe(false);
  });
});

describe('speech style text ownership', () => {
  it.each(BOT_SPEECH_STYLE_VALUES)('preserves every custom field when selecting %s', (style) => {
    const samples = [
      '',
      ' \n\t ',
      'Привет, {user}. Я {bot_character_name}. Подскажу правила и помогу освоиться в чате.',
      '**Текст администратора**\n{reason} — {sanction}\n[Правила](https://example.org/rules)',
    ];
    const texts = Object.fromEntries(
      BOT_SPEECH_EDITABLE_FIELD_KEYS.map((key, index) => [key, samples[index % samples.length]]),
    ) as Record<(typeof BOT_SPEECH_EDITABLE_FIELD_KEYS)[number], string>;
    const settings: BotSpeechSettingsSubset & {
      botSpeechMedia: Record<string, { token: string }>;
      settingsRevision: string;
    } = {
      ...texts,
      botSpeechStyle: null,
      botSpeechMedia: { greetingBotMessageText: { token: 'user-media-token' } },
      settingsRevision: revision,
    };
    const before = structuredClone(settings);

    const result = applyBotSpeechStylePreset(settings, style);

    expect(result).toEqual({ ...before, botSpeechStyle: style });
    expect(settings).toEqual(before);
    expect(result.botSpeechMedia).toBe(settings.botSpeechMedia);
    expect(hasBotSpeechEditableOverrides(result)).toBe(true);
    for (const key of BOT_SPEECH_EDITABLE_FIELD_KEYS) {
      expect(result[key]).toBe(settings[key]);
    }
  });

  it('treats only an empty or absent value as inherited', () => {
    expect(hasCustomBotSpeechText('')).toBe(false);
    expect(hasCustomBotSpeechText(null)).toBe(false);
    expect(hasCustomBotSpeechText(undefined)).toBe(false);
    expect(hasCustomBotSpeechText(' \n\t ')).toBe(true);
    expect(hasCustomBotSpeechText('{user}, сообщение {message_status}: {reason}.')).toBe(true);
  });

  it.each(BOT_SPEECH_STYLE_VALUES)('keeps empty fields inherited after selecting %s', (style) => {
    const settings = {
      botSpeechStyle: null,
      ...Object.fromEntries(BOT_SPEECH_EDITABLE_FIELD_KEYS.map((key) => [key, ''])),
    } as BotSpeechSettingsSubset;
    const result = applyBotSpeechStylePreset(settings, style);

    expect(hasBotSpeechEditableOverrides(result)).toBe(false);
    for (const key of BOT_SPEECH_EDITABLE_FIELD_KEYS) {
      expect(result[key]).toBe('');
      expect(getBotSpeechEditableTemplate(style, key).trim().length).toBeGreaterThan(0);
    }
  });
});

describe('inherited speech scenario coverage', () => {
  it.each(BOT_SPEECH_STYLE_VALUES)(
    'asks for subscription without deletion workflow status for %s',
    (style) => {
      const template = getBotSpeechEditableTemplate(style, 'requiredSubscriptionBotMessageText');
      expect(extractPlaceholders(template)).toEqual(['channels', 'user']);
      expect(template).toMatch(/подпишитесь/iu);
      expect(template).not.toMatch(/удал|ожида|ждёт/iu);
    },
  );

  it.each(BOT_SPEECH_STYLE_VALUES)('makes subscription mute duration available for %s', (style) => {
    const template = getBotSpeechSystemTemplate(style, 'requiredSubscriptionMute');
    expect(extractPlaceholders(template)).toEqual(['channels', 'mute_duration', 'user']);
  });

  it.each(['duplicatePhoto', 'duplicateAlbum'] as const)(
    'keeps %s usable with only the existing duplicate rendering context',
    (key) => {
      for (const style of BOT_SPEECH_STYLE_VALUES) {
        const template = getBotSpeechSystemTemplate(style, key);
        expect(extractPlaceholders(template)).toEqual(['sanction', 'user']);
        for (const persona of BOT_SPEECH_PERSONA_VALUES) {
          expect(getBotSpeechSystemTemplate(style, key, persona)).toBe(template);
        }
      }
      expect(getBotSpeechSystemTemplate(null, key)).toBe(getBotSpeechSystemTemplate('POLICE', key));
    },
  );
});

function extractPlaceholders(template: string): string[] {
  return [...template.matchAll(/\{([a-z_]+)\}/gu)].map((match) => match[1]!).sort();
}
