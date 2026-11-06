import { DUPLICATE_ALLOWED_COUNT_MAX } from './private-control.constants';
import {
  CHANNEL_SECTION_FIELDS,
  CHANNEL_SECTION_LABELS,
  SECTION_CARD_FIELDS,
  SECTION_FIELDS,
  SECTION_LABELS,
  SECTION_ORDER,
  SECTION_SETTING_KEYS,
} from './private-control-settings-schema';
import type { PrivateSectionKey } from './private-control.types';

describe('private control settings schema', () => {
  it('keeps section order, labels, fields, and bulk setting keys aligned', () => {
    expect(SECTION_ORDER).toEqual([
      'links',
      'greeting',
      'profanityFilter',
      'commercialFilter',
      'duplicates',
      'limits',
      'night',
      'storefront',
      'extra',
    ]);
    expect(SECTION_LABELS).not.toHaveProperty('thematicFilters');
    expect(SECTION_FIELDS).not.toHaveProperty('thematicFilters');
    expect(SECTION_SETTING_KEYS).not.toHaveProperty('thematicFilters');
    expect(SECTION_CARD_FIELDS).not.toHaveProperty('thematicFilters');
    expect(SECTION_FIELDS.storefront).toEqual([
      expect.objectContaining({ key: 'karavanStorefrontEnabled', type: 'boolean' }),
      expect.objectContaining({ key: 'karavanStorefrontAdminsOnly', type: 'boolean' }),
      expect.objectContaining({ key: 'karavanStorefrontMessageText', type: 'text' }),
      expect.objectContaining({ key: 'karavanStorefrontOpenButtonText', type: 'text' }),
      expect.objectContaining({ key: 'karavanStorefrontCatalogButtonText', type: 'text' }),
      expect.objectContaining({ key: 'karavanStorefrontCreateButtonText', type: 'text' }),
    ]);

    for (const section of SECTION_ORDER) {
      expect(SECTION_LABELS[section]).toEqual(expect.any(String));
      expect(SECTION_FIELDS[section].length).toBeGreaterThan(0);
      expect(SECTION_SETTING_KEYS[section]).toEqual(
        SECTION_FIELDS[section].map((field) => field.key),
      );
    }
  });

  it('keeps card field groups scoped to known section fields', () => {
    for (const section of SECTION_ORDER) {
      const knownFields = new Set(SECTION_FIELDS[section].map((field) => field.key));
      const cardFields = [
        ...SECTION_CARD_FIELDS[section].basic,
        ...SECTION_CARD_FIELDS[section].advanced,
      ];

      expect(new Set(cardFields).size).toBe(cardFields.length);
      expect(cardFields.length).toBeLessThanOrEqual(knownFields.size);
      for (const key of cardFields) {
        expect(knownFields.has(key)).toBe(true);
      }
    }
  });

  it('keeps duplicate compact controls aligned with duplicate flow limits', () => {
    const duplicateFields = SECTION_FIELDS.duplicates;

    expect(SECTION_SETTING_KEYS.duplicates).toEqual(duplicateFields.map((field) => field.key));
    expect(duplicateFields.find((field) => field.key === 'duplicateWarnMaxCount')).toEqual(
      expect.objectContaining({
        label: 'Разрешено дублей',
        type: 'number',
        min: 0,
        max: DUPLICATE_ALLOWED_COUNT_MAX,
      }),
    );
    expect(SECTION_CARD_FIELDS.duplicates.basic).toEqual([
      'antiDuplicateEnabled',
      'duplicateBotMessageEnabled',
      'duplicateWarnEnabled',
      'duplicateMuteEnabled',
      'duplicateMuteDurationHours',
      'duplicateBanEnabled',
    ]);
    expect(
      duplicateFields.find((field) => field.key === 'duplicatePhotoMatchPreset'),
    ).toBeUndefined();
    expect(duplicateFields.find((field) => field.key === 'duplicatePhotoEnabled')).toBeUndefined();
    expect(duplicateFields.find((field) => field.key === 'duplicateCompareMode')).toBeUndefined();
    expect(duplicateFields.find((field) => field.key === 'duplicatePhotoScope')).toEqual(
      expect.objectContaining({
        type: 'enum',
        enumValues: ['SAME_AUTHOR', 'CHAT'],
      }),
    );
  });

  it('exposes profanity sensitivity as a basic enum control', () => {
    expect(
      SECTION_FIELDS.profanityFilter.find((field) => field.key === 'profanitySensitivity'),
    ).toEqual(
      expect.objectContaining({
        label: 'Чувствительность',
        type: 'enum',
        enumValues: ['CORE_ONLY', 'BALANCED', 'STRICT'],
      }),
    );
    expect(SECTION_CARD_FIELDS.profanityFilter.basic).toContain('profanitySensitivity');
  });

  it('does not expose legacy stop-list writes through private limits controls', () => {
    expect(
      SECTION_FIELDS.limits.find((field) => field.key === 'messageLimitsImageTextScanEnabled'),
    ).toBeUndefined();
    expect(
      SECTION_FIELDS.limits.some(
        (field) =>
          field.key === 'messageLimitsBlockedWords' || field.key === 'messageLimitsBlockedDomains',
      ),
    ).toBe(false);
  });

  it('keeps channel section fields aligned with labels', () => {
    expect(Object.keys(CHANNEL_SECTION_LABELS).sort()).toEqual(
      Object.keys(CHANNEL_SECTION_FIELDS).sort(),
    );

    for (const section of Object.keys(CHANNEL_SECTION_FIELDS) as Array<
      keyof typeof CHANNEL_SECTION_FIELDS
    >) {
      const fields = CHANNEL_SECTION_FIELDS[section];

      expect(CHANNEL_SECTION_LABELS[section]).toEqual(expect.any(String));
      expect(fields.length).toBeGreaterThan(0);
      for (const field of fields) {
        expect(field).toEqual(
          expect.objectContaining({
            key: expect.any(String),
            label: expect.any(String),
            type: expect.any(String),
          }),
        );
      }
    }

    expect(CHANNEL_SECTION_LABELS.comments).toBe('Комментарии в приложении');
    expect(CHANNEL_SECTION_FIELDS.comments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'commentsEnabled',
          label: 'Комментарии в приложении',
        }),
        expect.objectContaining({
          key: 'commentsModerationEnabled',
          label: 'Модерация комментариев ботом',
        }),
      ]),
    );
  });

  it('has no orphan section definitions', () => {
    const orderedSections = new Set<PrivateSectionKey>(SECTION_ORDER);

    expect(Object.keys(SECTION_LABELS).sort()).toEqual([...orderedSections].sort());
    expect(Object.keys(SECTION_FIELDS).sort()).toEqual([...orderedSections].sort());
    expect(Object.keys(SECTION_SETTING_KEYS).sort()).toEqual([...orderedSections].sort());
    expect(Object.keys(SECTION_CARD_FIELDS).sort()).toEqual([...orderedSections].sort());
  });
});
