import {
  buildNightModeClosedNoticeOptions,
  buildNightModeCommentsButton,
} from './night-mode-transition-closed-notice-options.util';

describe('night mode transition closed notice options util', () => {
  it('returns base options unchanged when no comments button is available', () => {
    const baseOptions = {
      button: {
        text: 'Правила',
        url: 'https://max.ru/rules',
      },
    };

    expect(
      buildNightModeClosedNoticeOptions({
        baseOptions,
        commentsButton: null,
      }),
    ).toBe(baseOptions);
    expect(
      buildNightModeClosedNoticeOptions({
        baseOptions: null,
        commentsButton: null,
      }),
    ).toBeNull();
  });

  it('returns a comments button row when no base options exist', () => {
    const commentsButton = {
      type: 'link' as const,
      text: 'Комментарии',
      url: 'https://max.ru/comments',
    };

    expect(
      buildNightModeClosedNoticeOptions({
        baseOptions: null,
        commentsButton,
      }),
    ).toEqual({
      buttons: [[commentsButton]],
    });
  });

  it('prepends the comments button before existing button rows', () => {
    const commentsButton = {
      type: 'link' as const,
      text: 'Комментарии',
      url: 'https://max.ru/comments',
    };

    expect(
      buildNightModeClosedNoticeOptions({
        commentsButton,
        baseOptions: {
          buttons: [
            [
              {
                type: 'link' as const,
                text: 'Правила',
                url: 'https://max.ru/rules',
              },
              {
                type: 'link' as const,
                text: 'Помощь',
                url: 'https://max.ru/help',
              },
            ],
          ],
          messageLink: {
            type: 'reply',
            mid: 'rules-message-1',
          },
          debugContext: {
            screen: 'night-mode',
            action: 'close-notice',
          },
        },
      }),
    ).toEqual({
      buttons: [
        [commentsButton],
        [
          {
            type: 'link',
            text: 'Правила',
            url: 'https://max.ru/rules',
          },
          {
            type: 'link',
            text: 'Помощь',
            url: 'https://max.ru/help',
          },
        ],
      ],
      messageLink: {
        type: 'reply',
        mid: 'rules-message-1',
      },
      debugContext: {
        screen: 'night-mode',
        action: 'close-notice',
      },
    });
  });

  it('promotes a single legacy button into a row after comments', () => {
    const commentsButton = {
      type: 'link' as const,
      text: 'Комментарии',
      url: 'https://max.ru/comments',
    };
    const legacyButton = {
      text: 'Правила',
      url: 'https://max.ru/rules',
    };

    expect(
      buildNightModeClosedNoticeOptions({
        commentsButton,
        baseOptions: {
          button: legacyButton,
        },
      }),
    ).toEqual({
      buttons: [[commentsButton], [legacyButton]],
    });
  });

  it('preserves a message link when comments are the only button row', () => {
    const commentsButton = {
      type: 'link' as const,
      text: 'Комментарии',
      url: 'https://max.ru/comments',
    };

    expect(
      buildNightModeClosedNoticeOptions({
        commentsButton,
        baseOptions: {
          messageLink: {
            type: 'reply',
            mid: 'rules-message-1',
          },
        },
      }),
    ).toEqual({
      buttons: [[commentsButton]],
      messageLink: {
        type: 'reply',
        mid: 'rules-message-1',
      },
    });
  });

  it('builds a scoped discussion from the independent night-mode switch', () => {
    const buildButton = jest.fn(({ chatId, threadId, text }) => ({
      type: 'link' as const,
      text,
      url: `https://max.ru/${chatId}/${threadId}`,
    }));
    const uuid = '12345678-1234-4234-9234-1234567890ab';
    const threadId = `night-close-v1:${uuid}`;
    const createThreadId = jest.fn().mockReturnValue(uuid);

    expect(
      buildNightModeCommentsButton({
        chatId: 'chat-1',
        nightModeCommentsEnabled: true,
        buildButton,
        createThreadId,
      }),
    ).toEqual({
      type: 'link',
      text: '💬 Комментарии',
      url: `https://max.ru/chat-1/${threadId}`,
    });

    expect(buildButton).toHaveBeenCalledWith({
      chatId: 'chat-1',
      threadId,
      text: '💬 Комментарии',
    });

    buildButton.mockClear();
    createThreadId.mockClear();

    expect(
      buildNightModeCommentsButton({
        chatId: 'chat-1',
        nightModeCommentsEnabled: false,
        buildButton,
        createThreadId,
      }),
    ).toBeNull();
    expect(buildButton).not.toHaveBeenCalled();
    expect(createThreadId).not.toHaveBeenCalled();
  });
});
