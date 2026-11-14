import {
  assertEditableAttachmentsPreserved,
  readStrictEditableAttachments,
} from './max-editable-message-preservation';
import { AdminDialogLinkHelper } from '../admin/admin-dialog-link-helper';

describe('strict editable message preservation', () => {
  it('replaces an explicitly owned keyboard while preserving every media attachment', () => {
    const photo = { type: 'image', payload: { token: 'photo' } };
    const video = { type: 'video', payload: { token: 'video' } };
    const source = [
      photo,
      video,
      {
        type: 'inline_keyboard',
        payload: {
          buttons: [[{ type: 'callback', text: 'Опубликовать', payload: 'sr1|publish|id|0|0' }]],
        },
      },
    ];
    expect(() => assertEditableAttachmentsPreserved(source, [photo, video], [])).toThrow(
      'A button would be lost',
    );
    expect(() =>
      assertEditableAttachmentsPreserved(source, [photo, video], [], {
        replaceSourceKeyboard: true,
      }),
    ).not.toThrow();
    for (const result of [[photo], [video], [photo, { ...video, payload: { token: 'changed' } }]]) {
      expect(() =>
        assertEditableAttachmentsPreserved(source, result, [], {
          replaceSourceKeyboard: true,
        }),
      ).toThrow('An attachment would be lost');
    }
    expect(() =>
      assertEditableAttachmentsPreserved(
        source,
        [photo, video],
        [[{ type: 'callback', text: 'Новая', payload: 'sr1|edit|id|0|1' }]],
        { replaceSourceKeyboard: true },
      ),
    ).toThrow('A button would be lost');
  });
  it('allows only a recognized same-channel suggestion alias, never lost ads or comments', () => {
    const helper = new AdminDialogLinkHelper({
      appBaseUrl: null,
      explicitBotContactId: null,
      ownBotUserId: 'major',
      maxBotToken: 'test',
      maxBotTokenValidationSecrets: ['test'],
    });
    const button = (chatId: string, kind: 'suggest' | 'comments', thread: string) =>
      helper.buildChannelDialogButton(chatId, kind, thread, 'Same label', 'major', 'MINIAPP');
    const keyboard = (value: unknown) => ({
      type: 'inline_keyboard',
      payload: { buttons: [[value]] },
    });
    const original = button('-100', 'suggest', 'old');
    expect(() =>
      assertEditableAttachmentsPreserved(
        [keyboard(original)],
        [keyboard(button('-100', 'suggest', 'new'))],
        [],
      ),
    ).not.toThrow();
    for (const replacement of [
      button('-200', 'suggest', 'old'),
      button('-100', 'comments', 'old'),
      { type: 'link', text: 'Same label', url: 'https://example.com/ads' },
    ]) {
      expect(() =>
        assertEditableAttachmentsPreserved([keyboard(original)], [keyboard(replacement)], []),
      ).toThrow('would be lost');
      expect(() =>
        assertEditableAttachmentsPreserved([keyboard(replacement)], [keyboard(original)], []),
      ).toThrow('would be lost');
    }
    expect(() =>
      assertEditableAttachmentsPreserved(
        [keyboard(button('-100', 'comments', 'old'))],
        [keyboard(button('-100', 'comments', 'new'))],
        [],
      ),
    ).toThrow('would be lost');
  });
  it('rejects missing messages and incomplete attachment collections', () => {
    expect(() => readStrictEditableAttachments(null)).toThrow();
    expect(() => readStrictEditableAttachments({ body: { attachments: {} } })).toThrow();
  });
  it('allows comment aliases only when an unchanged source discussion survives', () => {
    const helper = new AdminDialogLinkHelper({
      appBaseUrl: null,
      explicitBotContactId: null,
      ownBotUserId: 'major',
      maxBotToken: 'test',
      maxBotTokenValidationSecrets: ['test'],
    });
    const button = (chat: string, thread: string) =>
      helper.buildChannelDialogButton(chat, 'comments', thread, 'Comments', 'major', 'MINIAPP');
    const old = button('-100', 'old');
    const duplicate = button('-100', 'duplicate');
    const keyboard = (buttons: unknown[]) => ({
      type: 'inline_keyboard',
      payload: { buttons: buttons.map((item) => [item]) },
    });
    expect(() =>
      assertEditableAttachmentsPreserved([keyboard([old])], [keyboard([old])], [[duplicate]]),
    ).not.toThrow();
    expect(() =>
      assertEditableAttachmentsPreserved([keyboard([old, duplicate])], [keyboard([old])], []),
    ).not.toThrow();
    expect(() =>
      assertEditableAttachmentsPreserved([keyboard([old])], [keyboard([duplicate])], [[duplicate]]),
    ).toThrow('would be lost');
    expect(() =>
      assertEditableAttachmentsPreserved(
        [keyboard([old])],
        [keyboard([old])],
        [[button('-200', 'other')]],
      ),
    ).toThrow('would be lost');
    expect(() => assertEditableAttachmentsPreserved([], [keyboard([old])], [[duplicate]])).toThrow(
      'would be lost',
    );
  });
  it('does not guess between different direct and forwarded media collections', () => {
    expect(() =>
      readStrictEditableAttachments({
        body: { attachments: [{ type: 'image', payload: { token: 'one' } }] },
        link: {
          type: 'forward',
          message: { attachments: [{ type: 'image', payload: { token: 'two' } }] },
        },
      }),
    ).toThrow('ambiguous');
  });
  it('keeps direct and linked attachments separate for in-place forward edits', () => {
    const direct = [{ type: 'inline_keyboard', payload: { buttons: [] } }];
    const message = {
      body: { attachments: direct },
      link: {
        type: 'forward',
        message: { body: { attachments: [{ type: 'video', payload: { token: 'nested' } }] } },
      },
    };
    expect(readStrictEditableAttachments(message, false)).toEqual(direct);
    expect(readStrictEditableAttachments({ ...message, body: { attachments: [] } }, false)).toEqual(
      [],
    );
    expect(() => readStrictEditableAttachments(message)).toThrow('ambiguous');
    expect(() =>
      readStrictEditableAttachments({ ...message, body: { attachments: {} } }, false),
    ).toThrow('incomplete');
  });
  it('rejects an unsupported existing keyboard instead of silently dropping it', () => {
    expect(() =>
      assertEditableAttachmentsPreserved(
        [{ type: 'inline_keyboard', payload: { buttons: [[{ type: 'unknown', text: 'Keep' }]] } }],
        [],
        [],
      ),
    ).toThrow('would be lost');
  });
});
