import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { channelSettingsSchema, chatSettingsSchema } from '@maxim/contracts';
import type { MaxMessageButton } from '../max/max-client.service';
import type {
  ChannelSectionKey,
  PrivateSectionKey,
  PrivateSectionView,
} from './private-control.types';
import * as renderer from './private-control-settings-renderer';

// This corpus records the pre-extraction output, including the persisted callback protocol.
const fixture = JSON.parse(
  readFileSync(
    resolve(__dirname, '../../test/fixtures/private-control-settings-rendering.json'),
    'utf8',
  ),
) as {
  cases: Array<
    (
      | { kind: 'chat'; section: PrivateSectionKey; view: PrivateSectionView }
      | { kind: 'channel'; section: ChannelSectionKey }
    ) & {
      settings: Record<string, unknown>;
      expected: { summary: string[]; buttons: MaxMessageButton[][] };
    }
  >;
  search: Array<{ query: string; expected: unknown[] }>;
};

describe('private settings rendering compatibility', () => {
  it.each(['MESSAGE', 'TEXT'] as const)(
    'renders the unified duplicate rule for a retained %s setting',
    (duplicateCompareMode) => {
      const settings = chatSettingsSchema.parse({
        antiDuplicateEnabled: true,
        duplicateCompareMode,
        duplicatePhotoScope: 'CHAT',
      });
      const summary = renderer.buildSectionSummaryLines('duplicates', settings, 'advanced');
      expect(summary).toContain('Чьи картинки сравнивать: Во всём чате');
      expect(summary.join('\n')).not.toMatch(/Одинаковые картинки:|общая цепочка/u);
      expect(
        renderer
          .buildSectionActionRows('duplicates', settings, 'advanced')
          .flat()
          .some(
            (button) =>
              button.type === 'callback' && button.payload.includes('duplicateCompareMode'),
          ),
      ).toBe(false);
    },
  );

  it('keeps independent stop-word policy out of the legacy limits summary', () => {
    const summary = renderer.buildSectionSummaryLines(
      'limits',
      { ...chatSettingsSchema.parse({}), messageLimitsImageTextScanEnabled: true },
      'basic',
    );
    expect(summary.join('\n')).not.toContain('Текст на фото:');
    expect(summary.join('\n')).not.toContain('Стоп-слова:');
  });

  it('uses channel comments terminology in the settings summary', () => {
    const summary = renderer.buildChannelSectionSummary(
      'comments',
      channelSettingsSchema.parse({
        commentsEnabled: true,
        commentsModerationEnabled: false,
      }),
    );
    expect(summary[0]).toMatch(/^Комментарии:/u);
    expect(summary[1]).toMatch(/^Модерация комментариев:/u);
    expect(summary.join('\n')).not.toContain('Обсуж');
  });

  it.each(fixture.cases)('preserves $kind $section text and callback rows', (entry) => {
    const actual =
      entry.kind === 'chat'
        ? {
            summary: renderer.buildSectionSummaryLines(
              entry.section,
              chatSettingsSchema.parse(entry.settings),
              entry.view,
            ),
            buttons: renderer.buildSectionActionRows(
              entry.section,
              chatSettingsSchema.parse(entry.settings),
              entry.view,
            ),
          }
        : {
            summary: renderer.buildChannelSectionSummary(
              entry.section,
              channelSettingsSchema.parse(entry.settings),
            ),
            buttons: renderer.buildChannelSectionRows(
              entry.section,
              channelSettingsSchema.parse(entry.settings),
            ),
          };
    expect(actual).toEqual(entry.expected);
  });

  it.each(fixture.search)(
    'preserves search order and bounded results for "$query"',
    ({ query, expected }) => {
      expect(renderer.findSettingMatches(query)).toEqual(expected);
    },
  );
});
