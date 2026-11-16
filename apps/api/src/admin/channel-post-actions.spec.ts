import type { MaxMessageButton } from '../max/max-client.service';
import { buildChannelPostActionRows } from '../common/channel-post-actions';
import { AdminDialogLinkHelper } from './admin-dialog-link-helper';

function link(text: string, url: string): MaxMessageButton {
  return { type: 'link', text, url };
}

describe('buildChannelPostActionRows', () => {
  it('retains custom row boundaries after deduplicating the separate channel CTA', () => {
    const cta = link('Сайт', 'https://example.com/site');
    const catalog = link('Каталог', 'https://example.com/catalog');
    const contact = link('Контакты', 'https://example.com/contact');
    const reviews = link('Отзывы', 'https://example.com/reviews');
    const customButtonRows = [
      [cta, catalog],
      [contact, reviews],
    ];
    const snapshot = structuredClone(customButtonRows);
    expect(buildChannelPostActionRows({ ctaButton: cta, customButtonRows })).toEqual([
      [cta],
      [catalog],
      [contact, reviews],
    ]);
    expect(customButtonRows).toEqual(snapshot);
  });

  it('keeps one suggestion when an old button is also present in CTA or custom rows', () => {
    const helper = new AdminDialogLinkHelper({
      appBaseUrl: null,
      explicitBotContactId: null,
      ownBotUserId: 'major-bot',
      maxBotToken: 'test',
      maxBotTokenValidationSecrets: ['test'],
    });
    const old = helper.buildChannelDialogButton(
      '-100',
      'suggest',
      '11111111-1111-4111-8111-111111111111',
      'Suggest',
      'major-bot',
      'BOT',
    );
    const current = helper.buildChannelDialogButton(
      '-100',
      'suggest',
      'new-thread',
      'Suggest',
      'major-bot',
      'MINIAPP',
    );
    const other = helper.buildChannelDialogButton(
      '-200',
      'suggest',
      'other-thread',
      'Suggest',
      'major-bot',
      'MINIAPP',
    );
    const ad = link('Advertise', 'https://example.com/ads');
    const sameLabelCustom = link('Suggest', 'https://example.com/custom');
    expect(
      buildChannelPostActionRows({
        suggestButton: current,
        ctaButton: old,
        customButtonRows: [[ad, old, other, sameLabelCustom]],
      }),
    ).toEqual([[current], [ad], [other], [sameLabelCustom]]);
  });
  it('keeps managed channel actions first in their product order', () => {
    expect(
      buildChannelPostActionRows({
        commentsButton: link('Comments', 'https://max.ru/comments'),
        suggestButton: link('Suggest', 'https://max.ru/suggest'),
        ctaButton: link('Advertise', 'https://example.test/ads'),
        customButtonRows: [
          [
            link('First custom', 'https://example.test/first'),
            link('Second custom', 'https://example.test/second'),
          ],
        ],
      }),
    ).toEqual([
      [link('Comments', 'https://max.ru/comments')],
      [link('Suggest', 'https://max.ru/suggest')],
      [link('Advertise', 'https://example.test/ads')],
      [link('First custom', 'https://example.test/first')],
      [link('Second custom', 'https://example.test/second')],
    ]);
  });

  it('preserves links to different fragments of the same page', () => {
    expect(
      buildChannelPostActionRows({
        ctaButton: link('Advertise', 'https://example.test/ads#contact'),
        customButtonRows: [
          [
            link('Duplicate', 'https://example.test/ads'),
            link('Details', 'https://example.test/info'),
          ],
        ],
      }),
    ).toEqual([
      [link('Advertise', 'https://example.test/ads#contact')],
      [link('Duplicate', 'https://example.test/ads'), link('Details', 'https://example.test/info')],
    ]);
  });

  it('does not collapse callback buttons without a stable link identity', () => {
    const callback: MaxMessageButton = { type: 'callback', text: 'Vote', payload: 'vote:1' };
    expect(buildChannelPostActionRows({ customButtonRows: [[callback, callback]] })).toEqual([
      [callback],
      [callback],
    ]);
  });

  it('deduplicates recognized comments across bot profiles but not labels or channels', () => {
    const helper = (publisher: boolean) =>
      new AdminDialogLinkHelper({
        appBaseUrl: null,
        explicitBotContactId: null,
        ownBotUserId: publisher ? 'publik' : 'major',
        maxBotToken: 'test',
        maxBotTokenValidationSecrets: ['test'],
        ...(publisher ? { dialogProfile: 'publisher' } : {}),
      });
    const major = helper(false).buildChannelDialogButton(
      '-100',
      'comments',
      'major-thread',
      'Comments',
      'major',
      'MINIAPP',
    );
    const publisher = helper(true).buildChannelDialogButton(
      '-100',
      'comments',
      'publisher-thread',
      'Comments',
      'publik',
      'MINIAPP',
    );
    const other = helper(true).buildChannelDialogButton(
      '-200',
      'comments',
      'other-thread',
      'Comments',
      'publik',
      'MINIAPP',
    );
    const custom = link('Comments', 'https://example.test/comments');
    expect(
      buildChannelPostActionRows({
        commentsButton: major,
        customButtonRows: [[publisher, other, custom]],
      }),
    ).toEqual([[major], [other], [custom]]);
  });
});
