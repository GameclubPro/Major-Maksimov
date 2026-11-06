import { describe, expect, it } from 'vitest';
import {
  buildDuplicateRulesTextItems,
  chatSettingsSchema,
  duplicatePhotoModerationModeSchema,
} from '../src/settings.js';
import { buildDuplicateRulesTextItems as rootFormatter } from '../src/index.js';
import cases from './fixtures/duplicate-rules.json';

describe('duplicate rules presentation', () => {
  it.each(cases)('$name', (fixture) => {
    const settings = chatSettingsSchema.parse(fixture.settings);
    const before = structuredClone(settings);
    expect(
      buildDuplicateRulesTextItems(
        settings,
        duplicatePhotoModerationModeSchema.parse(fixture.photoMode),
      ),
    ).toEqual(fixture.expected);
    expect(settings).toEqual(before);
  });

  it('describes one active rule regardless of the retained comparison selector', () => {
    const message = chatSettingsSchema.parse({
      antiDuplicateEnabled: true,
      duplicateCompareMode: 'MESSAGE',
    });
    const text = chatSettingsSchema.parse({ ...message, duplicateCompareMode: 'TEXT' });
    expect(buildDuplicateRulesTextItems(text, 'FULL')).toEqual(
      buildDuplicateRulesTextItems(message, 'FULL'),
    );
    expect(buildDuplicateRulesTextItems(text, 'FULL')).toEqual(
      expect.arrayContaining([expect.stringContaining('Одинаковые картинки')]),
    );
  });

  it('keeps root and settings exports compatible without promising unknown photo authority', () => {
    expect(rootFormatter).toBe(buildDuplicateRulesTextItems);
    expect(rootFormatter(chatSettingsSchema.parse({ antiDuplicateEnabled: true }))).not.toEqual(
      expect.arrayContaining([expect.stringContaining('картинки')]),
    );
  });
  it.each([
    [{ duplicateWarnEnabled: true, duplicateMuteEnabled: true, duplicateBanEnabled: true }, 1],
    [{ duplicateWarnEnabled: false, duplicateMuteEnabled: true, duplicateBanEnabled: true }, 24],
    [{ duplicateWarnEnabled: false, duplicateMuteEnabled: false, duplicateBanEnabled: true }, 48],
    [{ duplicateWarnEnabled: false, duplicateMuteEnabled: false, duplicateBanEnabled: false }, 1],
  ])(
    'describes the first enabled reaction interval without changing the stored ladder',
    (stages, hours) => {
      const settings = chatSettingsSchema.parse({
        antiDuplicateEnabled: true,
        duplicateWarnWindowSec: 3600,
        duplicateMuteWindowSec: 86400,
        duplicateBanWindowSec: 172800,
        ...stages,
      });
      expect(buildDuplicateRulesTextItems(settings)[0]).toContain(
        `в течение ${hours} ч с принятого оригинала`,
      );
    },
  );
});
