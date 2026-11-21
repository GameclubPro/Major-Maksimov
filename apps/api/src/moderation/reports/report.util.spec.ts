import { WebhookParser } from '../../webhook/webhook.parser';
import {
  isEligibleReporter,
  REPORT_DAY_MS,
  reportContentHash,
  reportReplyTarget,
} from './report.util';

const policy = { reportsEnabled: true, reportsAliases: ['спам'] };
function update(overrides: Record<string, unknown> = {}, type = 'message_created') {
  return new WebhookParser().parse({
    update_type: type,
    timestamp: Date.now(),
    message: {
      sender: { user_id: 10, is_bot: false },
      recipient: { chat_id: -100, chat_type: 'chat' },
      timestamp: Date.now(),
      body: { mid: 'command', text: ' /REPORT ' },
      link: { type: 'reply', chat_id: -100, message: { mid: 'target' } },
      ...overrides,
    },
  });
}
describe('report trigger and eligibility', () => {
  it('keeps immutable photos bound across signed URL refreshes, but detects replacement', () => {
    const photo = (photo_id: string, url: string) => ({
      body: { attachments: [{ type: 'image', payload: { photo_id, url } }] },
    });
    expect(reportContentHash(photo('one', 'https://cdn.example/a?sig=old'))).toBe(
      reportContentHash(photo('one', 'https://cdn.example/a?sig=new')),
    );
    expect(reportContentHash(photo('one', 'https://cdn.example/a'))).not.toBe(
      reportContentHash(photo('two', 'https://cdn.example/a')),
    );
  });
  it('keeps linked immutable photos stable without hiding linked content edits', () => {
    const reply = (photoId: string, url: string, text = 'linked text') => ({
      body: { text: 'reported reply' },
      link: {
        type: 'reply',
        message: {
          body: {
            mid: 'linked',
            text,
            attachments: [{ type: 'image', payload: { photo_id: photoId, url } }],
          },
        },
      },
    });
    expect(reportContentHash(reply('photo', 'https://cdn.example/a?sig=old'))).toBe(
      reportContentHash(reply('photo', 'https://cdn.example/a?sig=new')),
    );
    expect(reportContentHash(reply('other', 'https://cdn.example/a?sig=new'))).not.toBe(
      reportContentHash(reply('photo', 'https://cdn.example/a?sig=new')),
    );
    expect(reportContentHash(reply('photo', 'https://cdn.example/a?sig=new', 'edited'))).not.toBe(
      reportContentHash(reply('photo', 'https://cdn.example/a?sig=new')),
    );
  });
  it.each(['/супер-бан', 'super--ban'])(
    'ignores retired command saved as a report alias %s',
    (alias) => {
      expect(
        reportReplyTarget(update({ body: { mid: 'command', text: alias } }), {
          reportsEnabled: true,
          reportsAliases: [alias],
        }),
      ).toBeNull();
    },
  );
  it('requires an exact, case-insensitive direct reply', () => {
    expect(reportReplyTarget(update(), policy)).toBe('target');
    expect(reportReplyTarget(update({ body: { mid: 'command', text: 'жалоба' } }), policy)).toBe(
      'target',
    );
    expect(reportReplyTarget(update({ body: { mid: 'command', text: 'спам' } }), policy)).toBe(
      'target',
    );
  });
  it.each([
    { link: { type: 'forward', message: { mid: 'target' } } },
    { link: { type: 'reply', chat_id: -200, message: { mid: 'target' } } },
    { link: null },
    { body: { mid: 'command', text: 'это жалоба' } },
    { body: { mid: 'command', text: 'жалоба', attachments: [{ type: 'image' }] } },
  ])('does not treat ordinary or forwarded content as a vote: %j', (value) => {
    expect(reportReplyTarget(update(value), policy)).toBeNull();
  });
  it('ignores edited commands and disabled modules', () => {
    expect(reportReplyTarget(update({}, 'message_edited'), policy)).toBeNull();
    expect(reportReplyTarget(update(), { ...policy, reportsEnabled: false })).toBeNull();
  });
  it('requires known human membership for at least 24 hours', () => {
    const now = 10 * REPORT_DAY_MS;
    const member = { userId: '10', isBot: false, joinedAtMs: now - REPORT_DAY_MS };
    expect(isEligibleReporter(member, '10', now)).toBe(true);
    expect(isEligibleReporter({ ...member, joinedAtMs: member.joinedAtMs + 1 }, '10', now)).toBe(
      false,
    );
    expect(isEligibleReporter({ userId: '10', isBot: false }, '10', now)).toBe(false);
    expect(isEligibleReporter({ ...member, isBot: true }, '10', now)).toBe(false);
    expect(isEligibleReporter(member, '20', now)).toBe(false);
  });
  it('binds text, markup and media, independent of object key order', () => {
    expect(reportContentHash({ body: { text: 'text', markup: [] } })).toBe(
      reportContentHash({ body: { markup: [], text: 'text' } }),
    );
    expect(reportContentHash({ body: { text: 'text' } })).not.toBe(
      reportContentHash({ body: { text: 'edited' } }),
    );
    expect(
      reportContentHash({
        body: { text: 'text', attachments: [{ type: 'image', payload: { token: 'a' } }] },
      }),
    ).not.toBe(
      reportContentHash({
        body: { text: 'text', attachments: [{ type: 'image', payload: { token: 'b' } }] },
      }),
    );
  });
});
