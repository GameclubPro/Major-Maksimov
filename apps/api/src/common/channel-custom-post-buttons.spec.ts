import { buildChannelCustomPostButtons } from './channel-custom-post-buttons';
import { buildChannelPostActionRows } from './channel-post-actions';

describe('saved channel button delivery', () => {
  it('keeps comments, suggestions and valid custom links when a legacy hostname is invalid', () => {
    const buttons = [
      { id: '11111111-1111-4111-8111-111111111111', text: 'First', url: 'https://example.com/one' },
      {
        id: '22222222-2222-4222-8222-222222222222',
        text: 'Invalid',
        url: 'https://example.com1/two',
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        text: 'Third',
        url: 'https://example.com/three',
      },
    ];
    const settings = {
      customPostButtonsEnabled: true,
      customPostButtons: buttons,
      customPostButtonsSince: new Date('2026-11-16T17:00:00Z'),
    };
    const rows = buildChannelCustomPostButtons(settings, '2026-11-16T17:54:00Z');
    expect(rows.flat().map((button) => button.text)).toEqual(['First', 'Third']);
    expect(
      buildChannelPostActionRows({
        commentsButton: { type: 'link', text: 'Comments', url: 'https://max.ru/comments' },
        suggestButton: { type: 'link', text: 'Suggest', url: 'https://max.ru/suggest' },
        customButtonRows: rows,
      })
        .flat()
        .map((button) => button.text),
    ).toEqual(['Comments', 'Suggest', 'First', 'Third']);
    expect(settings.customPostButtons).toEqual(buttons);
    expect(buildChannelCustomPostButtons(settings, '2026-11-15T17:54:00Z')).toEqual([]);
    expect(buildChannelCustomPostButtons({ ...settings, customPostButtonsEnabled: false })).toEqual(
      [],
    );
  });
});
