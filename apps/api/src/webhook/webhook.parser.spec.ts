import { WebhookParser } from './webhook.parser';
import { extractManagedEntityForwardedRecoveryCandidate } from '../common/managed-entity-forwarded-recovery.util';

describe('WebhookParser', () => {
  const parser = new WebhookParser();

  it('uses a real message ID after a blank outer alias', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      timestamp: Date.now(),
      message: {
        message_id: ' ',
        chat_id: '-100123',
        sender_id: 'user',
        body: { mid: 'real-mid', text: 'text' },
      },
    });
    expect(parsed.message?.messageId).toBe('real-mid');
  });

  it('does not normalize a group message with only blank IDs', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      timestamp: Date.now(),
      message: {
        message_id: ' ',
        chat_id: '-100123',
        sender_id: 'user',
        body: { mid: '\t', text: 'text' },
      },
    });
    expect(parsed.message).toBeUndefined();
  });

  it.each([
    ['-100123', 'chat'],
    ['-100124', 'channel'],
    ['100124', 'channel'],
  ])(
    'does not invent a quota identity for a public pure forward in %s (%s)',
    (chatId, chatType) => {
      const parsed = parser.parse({
        update_type: 'message_created',
        update_id: 'per-bot-event',
        timestamp: Date.now(),
        message: {
          recipient: { chat_id: chatId, chat_type: chatType },
          sender: { user_id: 'user' },
          body: null,
          link: {
            type: 'forward',
            chat_id: '-100200',
            message: { mid: 'linked-source', text: 'forwarded text' },
          },
        },
      });
      expect(parsed.message).toBeUndefined();
    },
  );

  it('uses a deterministic synthetic update id when MAX omits update_id', () => {
    const payload = {
      update_type: 'message_created',
      message: {
        message_id: 'msg-dedup-1',
        chat_id: 'chat-dedup-1',
        sender_id: 'user-dedup-1',
        text: 'same webhook',
        created_at: '2026-07-06T09:00:00.000Z',
      },
    };

    const first = parser.parse(payload);
    const second = parser.parse({
      message: payload.message,
      update_type: payload.update_type,
    });

    expect(first.updateId).toMatch(/^synthetic:message_created:[a-f0-9]{64}$/u);
    expect(second.updateId).toBe(first.updateId);
  });

  it('produces different synthetic update ids for different no-id payloads', () => {
    const first = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-dedup-1',
        chat_id: 'chat-dedup-1',
        sender_id: 'user-dedup-1',
        text: 'first webhook',
        created_at: '2026-07-06T09:00:00.000Z',
      },
    });
    const second = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-dedup-2',
        chat_id: 'chat-dedup-1',
        sender_id: 'user-dedup-1',
        text: 'second webhook',
        created_at: '2026-07-06T09:00:00.000Z',
      },
    });

    expect(second.updateId).not.toBe(first.updateId);
  });

  it('extracts chatTitle from recipient.title', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-1',
        chat_id: 'chat-1',
        sender_id: 'user-1',
        text: 'hello',
        created_at: '2026-02-28T05:00:00.000Z',
        recipient: {
          title: 'My Chat Title',
        },
      },
    });

    expect(parsed.message?.chatTitle).toBe('My Chat Title');
  });

  it('extracts chatTitle from chat_title', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-2',
        chat_id: 'chat-2',
        sender_id: 'user-2',
        text: 'hello',
        created_at: '2026-02-28T05:00:00.000Z',
        chat_title: 'Another Chat',
      },
    });

    expect(parsed.message?.chatTitle).toBe('Another Chat');
  });

  it('normalizes top-level chat_title_changed updates with a synthetic message id', () => {
    const parsed = parser.parse({
      update_id: 'u-title-1',
      update_type: 'chat_title_changed',
      chat_id: '-100501',
      title: 'Новое название',
      actor: {
        user_id: 'user-title-1',
        first_name: 'Анна',
      },
      timestamp: '2026-07-06T09:00:00.000Z',
    });

    expect(parsed.type).toBe('chat_title_changed');
    expect(parsed.message).toMatchObject({
      messageId: 'chat_title_changed:u-title-1',
      chatId: '-100501',
      chatTitle: 'Новое название',
      senderId: 'user-title-1',
      senderName: 'Анна',
      text: '',
      createdAt: '2026-07-06T09:00:00.000Z',
    });
  });

  it('normalizes nested chat_title_changed updates from their event envelope', () => {
    const parsed = parser.parse({
      update_id: 'u-title-2',
      type: 'chat_title_changed',
      chat_title_changed: {
        chat_id: '-100502',
        chat_title: 'Nested Title',
        actor: {
          user_id: 'user-title-2',
          first_name: 'Пётр',
        },
      },
      timestamp: '2026-07-06T09:01:00.000Z',
    });

    expect(parsed.message).toMatchObject({
      messageId: 'chat_title_changed:u-title-2',
      chatId: '-100502',
      chatTitle: 'Nested Title',
      senderId: 'user-title-2',
      senderName: 'Пётр',
      text: '',
      createdAt: '2026-07-06T09:01:00.000Z',
    });
  });

  it('extracts senderName from sender profile fields', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-name-1',
        chat_id: 'chat-name-1',
        sender: {
          user_id: 'user-name-1',
          first_name: 'Иван',
          last_name: 'Петров',
          name: 'Иван',
          nickname: 'Ваня',
        },
        text: 'hello',
        created_at: '2026-02-28T05:00:00.000Z',
      },
    });

    expect(parsed.message?.senderName).toBe('Иван Петров');
  });

  it('extracts channel entityType from bot_added is_channel payloads without explicit chat type', () => {
    const parsed = parser.parse(
      {
        update_type: 'bot_added',
        chat_id: '-100777',
        is_channel: true,
        user: {
          user_id: 'user-channel-1',
          first_name: 'Иван',
          last_name: 'Администратор',
        },
        timestamp: '2026-04-21T10:15:00.000Z',
      },
      { botId: 'managed-bot-1' },
    );

    expect(parsed.message?.chatId).toBe('-100777');
    expect(parsed.message?.entityType).toBe('channel');
    expect(parsed.message?.senderId).toBe('user-channel-1');
    expect(parsed.message?.senderName).toBe('Иван Администратор');
    expect(parsed.membership).toEqual({
      action: 'added',
      memberUserIds: ['managed-bot-1'],
    });
    expect(parsed.eventTimestampSource).toBe('payload');
  });

  it('marks locally synthesized lifecycle timestamps as ingress-only evidence', () => {
    const parsed = parser.parse({
      update_type: 'bot_added',
      chat_id: '-100778',
      user: { user_id: 'bot-contact-1', is_bot: true },
    });

    expect(parsed.eventTimestampSource).toBe('ingress');
    expect(parsed.message?.createdAt).toEqual(expect.any(String));
  });

  it.each(['message_created', 'message_edited'])(
    'uses the update timestamp rather than the original message timestamp for %s',
    (type) => {
      const parsed = parser.parse({
        type,
        timestamp: '2026-07-10T14:00:00.456Z',
        message: {
          timestamp: '2026-07-10T13:50:00.123Z',
          body: {
            mid: 'mid-edited-1',
            text: 'edited text',
          },
          recipient: {
            chat_id: '-100123',
          },
          sender: {
            user_id: 'user-1',
          },
        },
      });

      expect(parsed.eventTimestampSource).toBe('payload');
      expect(parsed.message?.createdAt).toBe('2026-07-10T14:00:00.456Z');
    },
  );

  it('extracts text from nested body.text when message.text is missing', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-3',
        chat_id: 'chat-3',
        sender_id: 'user-3',
        created_at: '2026-02-28T05:00:00.000Z',
        body: {
          text: 'смотри ссылку https://example.com/abc',
        },
      },
    });

    expect(parsed.message?.text).toContain('https://example.com/abc');
  });

  it('extracts captions from MAX body, payload, and nested message nodes', () => {
    const bodyCaption = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-body-caption',
        chat_id: 'chat-body-caption',
        sender_id: 'user-body-caption',
        created_at: '2026-06-25T09:00:00.000Z',
        body: {
          caption: 'Фото с подписью казино',
          attachments: [{ type: 'image', payload: { token: 'photo-token-1' } }],
        },
      },
    });
    const payloadCaption = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-payload-caption',
        chat_id: 'chat-payload-caption',
        sender_id: 'user-payload-caption',
        created_at: '2026-06-25T09:01:00.000Z',
        payload: {
          caption: 'Видео с подписью ставки',
        },
      },
    });
    const nestedMessageCaption = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-nested-caption',
        chat_id: 'chat-nested-caption',
        sender_id: 'user-nested-caption',
        created_at: '2026-06-25T09:02:00.000Z',
        message: {
          caption: 'Вложенная подпись букмекер',
        },
      },
    });

    expect(bodyCaption.message?.text).toContain('Фото с подписью казино');
    expect(payloadCaption.message?.text).toContain('Видео с подписью ставки');
    expect(nestedMessageCaption.message?.text).toContain('Вложенная подпись букмекер');
  });

  it('extracts unicode-domain urls from nested body.text', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-3-unicode',
        chat_id: 'chat-3-unicode',
        sender_id: 'user-3-unicode',
        created_at: '2026-03-15T07:08:54.854Z',
        body: {
          text: 'вакансии https://центр-занятости-иркутск38.рф',
        },
      },
    });

    expect(parsed.message?.text).toContain('https://центр-занятости-иркутск38.рф');
  });

  it('does not recursively append urls from undocumented forwarded payload fields', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-4a',
        chat_id: 'chat-4a',
        sender_id: 'user-4a',
        created_at: '2026-02-28T05:00:00.000Z',
        body: {
          text: 'пересланное сообщение',
          forwarded_message: {
            body: {
              text: 'источник: https://spam-forwarded.example/path',
            },
          },
        },
      },
    });

    expect(parsed.message?.text).toContain('пересланное сообщение');
    expect(parsed.message?.text).not.toContain('https://spam-forwarded.example/path');
  });

  it('does not append service urls from forwarded metadata when forwarded text has no links', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-4a-meta',
        chat_id: 'chat-4a-meta',
        sender_id: 'user-4a-meta',
        created_at: '2026-02-28T05:00:00.000Z',
        body: {
          text: 'пересланное сообщение',
          forwarded_message: {
            source: {
              message_url: 'https://max.ru/chats/source/message/123',
            },
          },
        },
      },
    });

    expect(parsed.message?.text).toBe('пересланное сообщение');
    expect(parsed.message?.text).not.toContain('https://max.ru/chats/source/message/123');
  });

  it('does not duplicate urls already present in direct text', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-4b',
        chat_id: 'chat-4b',
        sender_id: 'user-4b',
        created_at: '2026-02-28T05:00:00.000Z',
        body: {
          text: 'ссылка https://dup.example/path',
          forwarded_message: {
            body: {
              text: 'https://dup.example/path',
            },
          },
        },
      },
    });

    const matches = parsed.message?.text.match(/https?:\/\/dup\.example\/path/gi) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('does not treat an untyped MAX message.link payload as a visible forward', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-4c',
        chat_id: 'chat-4c',
        sender_id: 'user-4c',
        created_at: '2026-02-28T05:00:00.000Z',
        body: {
          text: 'переслано',
        },
        link: {
          body: {
            text: 'оригинал: https://forward-link.example/news',
          },
        },
      },
    });

    expect(parsed.message?.text).not.toContain('https://forward-link.example/news');
  });

  it('keeps hidden markup targets separate from normalized visible text', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-4c-markup',
        chat_id: 'chat-4c-markup',
        sender_id: 'user-4c-markup',
        created_at: '2026-03-09T09:11:10.174Z',
        body: {
          text: '',
        },
        link: {
          type: 'forward',
          message: {
            text: 'Приглашаю в группы бесплатных объявлений. Краснодар и край',
            markup: [
              {
                type: 'link',
                from: 42,
                length: 18,
                url: 'https://max.ru/join/hidden-anchor-link',
              },
            ],
          },
        },
      },
    });

    expect(parsed.message?.text).toContain('Приглашаю в группы бесплатных объявлений');
    expect(parsed.message?.text).not.toContain('https://max.ru/join/hidden-anchor-link');
  });

  it('does not synthesize normalized text from direct markup or share targets', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-4c-body-markup',
        chat_id: 'chat-4c-body-markup',
        sender_id: 'user-4c-body-markup',
        created_at: '2026-03-09T09:11:10.174Z',
        body: {
          text: '',
          markup: [
            {
              type: 'link',
              from: 91,
              length: 12,
              url: 'https://max.ru/join/xte75O0CZf_31UDr3PI1bqaRoWidHatl4yn3U2Rf8ZQ',
            },
          ],
          attachments: [
            {
              type: 'share',
              title: 'MAX',
              description:
                'MAX позволяет отправлять любые виды сообщений и звонить даже на слабых устройствах.',
              payload: {
                url: 'https://max.ru/join/xte75O0CZf_31UDr3PI1bqaRoWidHatl4yn3U2Rf8ZQ',
              },
            },
          ],
        },
      },
    });

    expect(parsed.message?.text).toBe('');
  });

  it('keeps direct share targets out of normalized visible text', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-direct-share-1',
        chat_id: 'chat-direct-share-1',
        sender_id: 'user-direct-share-1',
        created_at: '2026-03-09T09:11:10.174Z',
        body: {
          text: '',
          attachments: [
            {
              type: 'share',
              title: 'Внешняя ссылка',
              payload: {
                url: 'https://example.com/direct-share-link',
              },
            },
          ],
        },
      },
    });

    expect(parsed.message?.text).toBe('');
  });

  it('ignores MAX preview metadata on direct share attachments', () => {
    const allowlistedUrl = 'https://max.ru/join/allowed-direct-share';
    const previewUrl = 'https://i.oneme.ru/i?r=service-preview-token';
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-direct-share-preview-1',
        chat_id: 'chat-direct-share-preview-1',
        sender_id: 'user-direct-share-preview-1',
        created_at: '2026-07-25T10:00:00.000Z',
        body: {
          text: allowlistedUrl,
          attachments: [
            {
              type: 'share',
              image_url: previewUrl,
              payload: {
                url: allowlistedUrl,
              },
            },
          ],
        },
      },
    });

    expect(parsed.message?.text).toBe(allowlistedUrl);
    expect(parsed.message?.text).not.toContain(previewUrl);
  });

  it('does not append reply quote text or buttons to the current message', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-reply-1',
        chat_id: 'chat-reply-1',
        sender_id: 'user-reply-1',
        created_at: '2026-03-27T07:59:59.886Z',
        body: {
          text: 'Здравствуйте, это первое объявление было сегодня!',
        },
        link: {
          type: 'reply',
          sender: {
            user_id: 'bot-1',
            name: 'Майор Максимов',
            is_bot: true,
          },
          message: {
            text: 'Товарищ Ольга, сообщение завернул. Причина: слишком частая отправка фото.',
            attachments: [
              {
                type: 'inline_keyboard',
                payload: {
                  buttons: [
                    [
                      {
                        type: 'link',
                        text: 'Правила',
                        url: 'https://max.ru/c/-71520449562631/AZ0U59k8egE',
                      },
                    ],
                  ],
                },
              },
            ],
          },
        },
      },
    });

    expect(parsed.message?.text).toBe('Здравствуйте, это первое объявление было сегодня!');
    expect(parsed.message?.text).not.toContain('Правила');
    expect(parsed.message?.text).not.toContain('https://max.ru/c/-71520449562631/AZ0U59k8egE');
    expect(parsed.message?.text).not.toContain('слишком частая отправка фото');
  });

  it('does not append forwarded share preview urls when forwarded text has no links', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-forward-share-1',
        chat_id: 'chat-forward-share-1',
        sender_id: 'user-forward-share-1',
        created_at: '2026-03-27T08:16:08.596Z',
        body: {
          text: '',
        },
        link: {
          type: 'forward',
          message: {
            text: 'Пересланное объявление без ссылок',
            attachments: [
              {
                type: 'share',
                title: 'Внешний preview',
                payload: {
                  url: 'https://example.com/hidden-preview-link',
                },
                description: 'Карточка с превью',
              },
            ],
          },
        },
      },
    });

    expect(parsed.message?.text).toBe('Пересланное объявление без ссылок');
    expect(parsed.message?.text).not.toContain('https://example.com/hidden-preview-link');
  });

  it('excludes a forwarded MAX media preview url repeated in forwarded text', () => {
    const inviteUrl = 'https://max.ru/join/allowed-forwarded-invite';
    const mediaPreviewUrl = 'https://i.oneme.ru/i?r=forwarded-preview-token';
    const externalUrl = 'https://bad.example/offer';
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-forward-media-preview-1',
        chat_id: 'chat-forward-media-preview-1',
        sender_id: 'user-forward-media-preview-1',
        created_at: '2026-07-09T10:34:00.000Z',
        body: {
          text: '',
        },
        link: {
          type: 'forward',
          message: {
            body: {
              text: `${inviteUrl} ${mediaPreviewUrl} ${externalUrl}`,
              attachments: [
                {
                  type: 'image',
                  payload: {
                    token: 'forwarded-preview-image-token',
                    url: mediaPreviewUrl,
                  },
                },
              ],
            },
          },
        },
      },
    });

    expect(parsed.message?.text).toContain(inviteUrl);
    expect(parsed.message?.text).toContain(externalUrl);
    expect(parsed.message?.text).not.toContain(mediaPreviewUrl);
  });

  it('keeps a MAX media URL from forwarded text when it is not a media attachment preview', () => {
    const inviteUrl = 'https://max.ru/join/allowed-forwarded-invite';
    const mediaPreviewUrl = 'https://i.oneme.ru/i?r=text-only-forwarded-url';
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-forward-text-url-1',
        chat_id: 'chat-forward-text-url-1',
        sender_id: 'user-forward-text-url-1',
        created_at: '2026-07-09T10:35:00.000Z',
        body: {
          text: '',
        },
        link: {
          type: 'forward',
          message: {
            body: {
              text: `${inviteUrl} ${mediaPreviewUrl}`,
            },
          },
        },
      },
    });

    expect(parsed.message?.text).toContain(inviteUrl);
    expect(parsed.message?.text).toContain(mediaPreviewUrl);
  });

  it('does not append forwarded inline keyboard button urls when forwarded text has no links', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-forward-buttons-1',
        chat_id: 'chat-forward-buttons-1',
        sender_id: 'user-forward-buttons-1',
        created_at: '2026-03-27T08:16:08.596Z',
        body: {
          text: '',
        },
        link: {
          type: 'forward',
          message: {
            text: 'Пересланное сообщение без ссылок',
            attachments: [
              {
                type: 'inline_keyboard',
                payload: {
                  buttons: [
                    [
                      {
                        type: 'link',
                        text: 'Открыть',
                        url: 'https://example.com/hidden-button-link',
                      },
                    ],
                  ],
                },
              },
            ],
          },
        },
      },
    });

    expect(parsed.message?.text).toBe('Пересланное сообщение без ссылок');
    expect(parsed.message?.text).not.toContain('https://example.com/hidden-button-link');
  });

  it('does not recursively promote arbitrary nested url fields into message text', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-4',
        chat_id: 'chat-4',
        sender_id: 'user-4',
        created_at: '2026-02-28T05:00:00.000Z',
        attachments: [
          {
            type: 'link',
            data: {
              url: 'https://bad.com/path',
            },
          },
        ],
      },
    });

    expect(parsed.message?.text).toBe('');
  });

  it('parses message from message_created.message envelope and fills ids', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      timestamp: '2026-02-28T05:10:00.000Z',
      message_created: {
        message: {
          id: 'msg-5',
          sender: { id: 'user-5' },
          recipient: {
            chat_id: '-71527248136199',
            title: 'MAXIM Test Chat',
          },
          body: {
            text: 'check https://example.org',
          },
        },
      },
    });

    expect(parsed.type).toBe('message_created');
    expect(parsed.message?.messageId).toBe('msg-5');
    expect(parsed.message?.chatId).toBe('-71527248136199');
    expect(parsed.message?.senderId).toBe('user-5');
    expect(parsed.message?.chatTitle).toBe('MAXIM Test Chat');
    expect(parsed.message?.text).toContain('https://example.org');
  });

  it('parses edited messages from message_edited.message envelope', () => {
    const parsed = parser.parse({
      update_type: 'message_edited',
      timestamp: '2026-02-28T05:10:10.000Z',
      message_edited: {
        message: {
          id: 'msg-edited-1',
          sender: { id: 'user-edited-1' },
          recipient: {
            chat_id: '-71527248136199',
            title: 'MAXIM Test Chat',
          },
          body: {
            text: 'теперь тут ссылка https://edited.example',
          },
        },
      },
    });

    expect(parsed.type).toBe('message_edited');
    expect(parsed.message?.messageId).toBe('msg-edited-1');
    expect(parsed.message?.chatId).toBe('-71527248136199');
    expect(parsed.message?.senderId).toBe('user-edited-1');
    expect(parsed.message?.text).toContain('https://edited.example');
  });

  it('parses message from message_created object when nested message key is absent', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message_created: {
        message_id: 'msg-6',
        chat: {
          id: 'chat-6',
          title: 'Envelope Chat',
        },
        from: {
          id: 'user-6',
        },
        content: {
          text: 'hello from envelope',
        },
        created_at: '2026-02-28T05:11:00.000Z',
      },
    });

    expect(parsed.message?.messageId).toBe('msg-6');
    expect(parsed.message?.chatId).toBe('chat-6');
    expect(parsed.message?.senderId).toBe('user-6');
    expect(parsed.message?.chatTitle).toBe('Envelope Chat');
    expect(parsed.message?.text).toBe('hello from envelope');
  });

  it('shares recursive wrapped-message selection with navigation moderation', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      data: {
        wrapper: {
          id: 'message-wrapped-1',
          recipient: { chat_id: 'chat-wrapped-1' },
          sender: { id: 'user-wrapped-1' },
          body: { text: 'Wrapped message' },
          timestamp: 1772249118580,
        },
      },
    });

    expect(parsed.message).toMatchObject({
      messageId: 'message-wrapped-1',
      chatId: 'chat-wrapped-1',
      senderId: 'user-wrapped-1',
      text: 'Wrapped message',
    });
  });

  it('keeps a wrapped outer message ahead of a fuller forwarded message', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      data: {
        wrapper: {
          id: 'outer-message',
          recipient: { chat_id: 'managed-chat' },
          sender: { id: 'outer-user' },
          body: { text: 'Outer' },
          link: {
            type: 'forward',
            message: {
              id: 'inner-message',
              recipient: { chat_id: 'source-chat' },
              sender: { id: 'inner-user' },
              body: { text: 'Inner' },
              timestamp: 1772249118580,
            },
          },
        },
      },
    });

    expect(parsed.message).toMatchObject({
      messageId: 'outer-message',
      chatId: 'managed-chat',
      senderId: 'outer-user',
    });
  });

  it('parses MAX payload with body.mid and numeric sender/chat ids', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      timestamp: 1772249118580,
      message: {
        sender_name: '195714583',
        body: {
          mid: 'mid.ffffbef220e477f9019ca24777741421',
          seq: 116146118235264030,
          text: 'Gffc https://web.telegram.org/',
          markup: [
            {
              url: 'https://web.telegram.org/',
              type: 'link',
            },
          ],
        },
        sender: {
          user_id: 195714583,
        },
        recipient: {
          chat_id: -71527833503751,
          chat_type: 'chat',
        },
        timestamp: 1772249118580,
      },
    });

    expect(parsed.message?.messageId).toBe('mid.ffffbef220e477f9019ca24777741421');
    expect(parsed.message?.chatId).toBe('-71527833503751');
    expect(parsed.message?.senderId).toBe('195714583');
    expect(parsed.message?.senderName).toBeUndefined();
    expect(parsed.message?.text).toContain('https://web.telegram.org/');
  });

  it('keeps forwarded channel posts when MAX sends message id outside body', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      timestamp: 1772249118580,
      message: {
        id: 'mid-forward-channel-1',
        sender: {
          user_id: 195714583,
        },
        recipient: {
          chat_id: -71527833503751,
          chat_type: 'channel',
        },
        body: null,
        link: {
          type: 'forward',
          message: {
            text: 'Пересланный пост из другого канала',
          },
        },
      },
    });

    expect(parsed.message?.messageId).toBe('mid-forward-channel-1');
    expect(parsed.message?.chatId).toBe('-71527833503751');
    expect(parsed.message?.senderId).toBe('195714583');
    expect(parsed.message?.text).toContain('Пересланный пост из другого канала');
  });

  it('normalizes an official pure forward with null body for durable recovery', () => {
    const payload = {
      update_type: 'message_created',
      timestamp: 1_785_541_200,
      message: {
        sender: {
          user_id: 195_714_583,
          name: 'Администратор',
        },
        recipient: {
          chat_id: 195_714_583,
          chat_type: 'dialog',
        },
        body: null,
        link: {
          type: 'forward',
          chat_id: -71_527_833_503_751,
          message: {
            mid: 'source-mid-1',
            seq: 42,
            text: 'Пересланный пост',
            attachments: [],
          },
        },
      },
    };
    const parsed = parser.parse(payload, { botId: 'launch-bot' });
    const repeated = parser.parse(payload, { botId: 'launch-bot' });

    expect(parsed.message).toEqual(
      expect.objectContaining({
        messageId: `message_created:${parsed.updateId}`,
        chatId: '195714583',
        senderId: '195714583',
      }),
    );
    expect(repeated.updateId).toBe(parsed.updateId);
    expect(repeated.message?.messageId).toBe(parsed.message?.messageId);
    expect(extractManagedEntityForwardedRecoveryCandidate(parsed)).toEqual({
      privateChatId: '195714583',
      sourceChatId: '-71527833503751',
      forwarderUserId: '195714583',
      incomingMessageId: `message_created:${parsed.updateId}`,
      sourceMessageId: 'source-mid-1',
    });
  });

  it('does not synthesize a message id for an incomplete pure-forward link', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      timestamp: 1_785_541_200,
      message: {
        sender: { user_id: 195_714_583 },
        recipient: { chat_id: 195_714_583, chat_type: 'dialog' },
        body: null,
        link: {
          type: 'forward',
          message: { mid: 'source-mid-without-chat' },
        },
      },
    });

    expect(parsed.message).toBeUndefined();
  });

  it('keeps service join message when sender id is missing', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        body: {
          mid: 'mid-service-join-1',
          new_members: [
            {
              user_id: 777,
              display_name: 'Новый участник',
            },
          ],
        },
        recipient: {
          chat_id: -123456789,
        },
        timestamp: 1772249118580,
      },
    });

    expect(parsed.message?.messageId).toBe('mid-service-join-1');
    expect(parsed.message?.chatId).toBe('-123456789');
    expect(parsed.message?.senderId).toBe('');
  });

  it('builds normalized message for user_added update without message payload', () => {
    const parsed = parser.parse({
      update_id: 'upd-user-added-1',
      update_type: 'user_added',
      chat_id: -123456789,
      user: {
        user_id: 888,
        first_name: 'Иван',
        last_name: 'Смирнов',
        name: 'Иван',
      },
      timestamp: 1772249118580,
    });

    expect(parsed.type).toBe('user_added');
    expect(parsed.message?.messageId).toBe('user_added:upd-user-added-1');
    expect(parsed.message?.chatId).toBe('-123456789');
    expect(parsed.message?.senderId).toBe('888');
    expect(parsed.message?.senderName).toBe('Иван Смирнов');
    expect(parsed.membership).toEqual({
      action: 'added',
      memberUserIds: ['888'],
    });
  });

  it('parses MAX Unix-second timestamps as seconds, not milliseconds', () => {
    const parsed = parser.parse({
      update_id: 'upd-user-added-seconds',
      update_type: 'user_added',
      chat_id: -123456789,
      user: {
        user_id: 888,
        first_name: 'Иван',
      },
      timestamp: 1772249118,
    });

    expect(parsed.message?.createdAt).toBe('2026-02-28T03:25:18.000Z');
  });

  it.each([1e20, 8_640_000_000_000_001, Number.POSITIVE_INFINITY, new Date('invalid')])(
    'uses ingress time for an invalid lifecycle timestamp %s without throwing',
    (timestamp) => {
      const before = Date.now();
      const parsed = parser.parse(
        {
          update_type: 'bot_removed',
          chat_id: '-123456789',
          timestamp,
        },
        { botId: 'managed-bot-1' },
      );

      expect(parsed.eventTimestampSource).toBe('ingress');
      const eventAtMs = Date.parse(parsed.message!.createdAt);
      expect(eventAtMs).toBeGreaterThanOrEqual(before);
      expect(eventAtMs).toBeLessThanOrEqual(Date.now());
    },
  );

  it('uses the next valid event timestamp when an earlier candidate is outside the date range', () => {
    const parsed = parser.parse({
      update_type: 'user_removed',
      chat_id: '-123456789',
      user_id: '888',
      timestamp: 1e20,
      data: { timestamp: '2026-02-28T03:25:18.580Z' },
    });

    expect(parsed.eventTimestampSource).toBe('payload');
    expect(parsed.message?.createdAt).toBe('2026-02-28T03:25:18.580Z');
  });

  it.each(['1970-01-02T00:00:00.123Z', new Date('1970-01-02T00:00:00.123Z')])(
    'keeps a parsed date in milliseconds even below the Unix seconds threshold: %s',
    (timestamp) => {
      const parsed = parser.parse({
        update_type: 'user_removed',
        chat_id: '-123456789',
        user_id: '888',
        timestamp,
      });

      expect(parsed.eventTimestampSource).toBe('payload');
      expect(parsed.message?.createdAt).toBe('1970-01-02T00:00:00.123Z');
    },
  );

  it('keeps inviter id for user_added updates', () => {
    const parsed = parser.parse({
      update_id: 'upd-user-added-inviter-1',
      update_type: 'user_added',
      chat_id: -123456789,
      inviter_id: 777,
      user: {
        user_id: 888,
        first_name: 'Иван',
      },
      timestamp: 1772249118580,
    });

    expect(parsed.membership).toEqual({
      action: 'added',
      memberUserIds: ['888'],
      inviterId: '777',
    });
  });

  it('prefers the nested added user over top-level user_id for user_added updates', () => {
    const parsed = parser.parse({
      update_id: 'upd-user-added-distinct-ids-1',
      update_type: 'user_added',
      chat_id: -123456789,
      user_id: 999,
      inviter_id: 777,
      user: {
        user_id: 888,
        first_name: 'Иван',
        last_name: 'Смирнов',
      },
      timestamp: 1772249118580,
    });

    expect(parsed.message?.senderId).toBe('888');
    expect(parsed.message?.senderName).toBe('Иван Смирнов');
    expect(parsed.membership).toEqual({
      action: 'added',
      memberUserIds: ['888'],
      inviterId: '777',
    });
  });

  it('builds normalized user_added message from member payloads', () => {
    const parsed = parser.parse({
      update_id: 'upd-user-added-member-1',
      update_type: 'user_added',
      chat_id: -123456789,
      member: {
        id: 889,
        first_name: 'Анна',
        last_name: 'Петрова',
      },
      timestamp: 1772249118580,
    });

    expect(parsed.type).toBe('user_added');
    expect(parsed.message?.messageId).toBe('user_added:upd-user-added-member-1');
    expect(parsed.message?.chatId).toBe('-123456789');
    expect(parsed.message?.senderId).toBe('889');
    expect(parsed.message?.senderName).toBe('Анна Петрова');
    expect(parsed.membership).toEqual({
      action: 'added',
      memberUserIds: ['889'],
    });
  });

  it('builds normalized message for user_removed update without message payload', () => {
    const parsed = parser.parse({
      update_id: 'upd-user-removed-1',
      update_type: 'user_removed',
      chat_id: -123456789,
      user: {
        user_id: 889,
        first_name: 'Петр',
        last_name: 'Иванов',
      },
      timestamp: 1772249118580,
    });

    expect(parsed.type).toBe('user_removed');
    expect(parsed.message?.messageId).toBe('user_removed:upd-user-removed-1');
    expect(parsed.message?.chatId).toBe('-123456789');
    expect(parsed.message?.senderId).toBe('889');
    expect(parsed.message?.senderName).toBe('Петр Иванов');
    expect(parsed.membership).toEqual({
      action: 'removed',
      memberUserIds: ['889'],
    });
  });

  it('captures membership additions from service message payloads with new_members', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'mid-service-join-membership',
        chat_id: -123456789,
        sender_id: 777,
        new_members: [
          {
            user_id: 1001,
            display_name: 'Первый',
          },
          {
            user: {
              user_id: 1002,
              display_name: 'Второй',
            },
          },
        ],
        created_at: '2026-03-29T11:00:00.000Z',
      },
    });

    expect(parsed.membership).toEqual({
      action: 'added',
      memberUserIds: ['1001', '1002'],
    });
  });

  it('captures membership removals from service message payloads with removed_members', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'mid-service-leave-membership',
        chat_id: -123456789,
        sender_id: 777,
        removed_members: [
          {
            user_id: 1003,
            display_name: 'Третий',
          },
          {
            user: {
              user_id: 1004,
              display_name: 'Четвертый',
            },
          },
        ],
        created_at: '2026-03-29T11:01:00.000Z',
      },
    });

    expect(parsed.membership).toEqual({
      action: 'removed',
      memberUserIds: ['1003', '1004'],
    });
  });

  it('keeps the human bot_removed actor separate from the authenticated bot subject', () => {
    const parsed = parser.parse(
      {
        update_id: 'upd-bot-removed-1',
        update_type: 'bot_removed',
        chat_id: -123456789,
        chat: {
          chat_id: -123456789,
          chat_type: 'channel',
        },
        user: {
          user_id: 890,
          first_name: 'Иван',
          last_name: 'Администратор',
        },
        timestamp: 1772249118580,
      },
      { botId: 'managed-bot-2' },
    );

    expect(parsed.type).toBe('bot_removed');
    expect(parsed.message?.messageId).toBe('bot_removed:upd-bot-removed-1');
    expect(parsed.message?.chatId).toBe('-123456789');
    expect(parsed.message?.entityType).toBe('channel');
    expect(parsed.message?.senderId).toBe('890');
    expect(parsed.message?.senderName).toBe('Иван Администратор');
    expect(parsed.membership).toEqual({
      action: 'removed',
      memberUserIds: ['managed-bot-2'],
    });
  });

  it.each([
    ['post_id', 'native-post-1'],
    ['postId', 'native-post-2'],
  ])('normalizes message.recipient.%s as message.postId', (field, postId) => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        body: { mid: `comment-${postId}`, text: 'Комментарий' },
        recipient: {
          chat_id: -123456789,
          chat_type: 'channel',
          [field]: postId,
        },
        sender: { user_id: 891 },
        timestamp: 1772249118580,
      },
    });

    expect(parsed.message?.postId).toBe(postId);
  });

  it('normalizes the official top-level message_removed post_id', () => {
    const parsed = parser.parse({
      update_type: 'message_removed',
      timestamp: 1772249118580,
      message_id: 'removed-comment-1',
      chat_id: -123456789,
      user_id: 891,
      post_id: 'native-post-removed-1',
    });

    expect(parsed.message).toMatchObject({
      messageId: 'removed-comment-1',
      postId: 'native-post-removed-1',
      chatId: '-123456789',
      senderId: '891',
    });
  });

  it('accepts the official message_callback shape when its source message was deleted', () => {
    const parsed = parser.parse(
      {
        update_type: 'message_callback',
        timestamp: 1772249118580,
        callback: {
          timestamp: 1772249118580,
          callback_id: 'callback-deleted-message-1',
          payload: 'pc2|broadcast_send',
          user: { user_id: 891 },
        },
        message: null,
        user_locale: 'ru-RU',
      },
      { botId: 'managed-bot-1' },
    );

    expect(parsed).toMatchObject({
      type: 'message_callback',
      botId: 'managed-bot-1',
      eventTimestampSource: 'payload',
      raw: {
        callback: {
          callback_id: 'callback-deleted-message-1',
          payload: 'pc2|broadcast_send',
          user: { user_id: 891 },
        },
        message: null,
      },
    });
    expect(parsed.updateId).toMatch(/^synthetic:message_callback:/u);
    expect(parsed.message).toBeUndefined();
  });

  it('extracts normalized chat entity type from recipient chat_type', () => {
    const parsed = parser.parse({
      update_type: 'message_created',
      message: {
        message_id: 'msg-entity-1',
        chat_id: '-100500',
        sender_id: 'user-entity-1',
        text: 'hello',
        created_at: '2026-03-31T05:00:00.000Z',
        recipient: {
          chat_type: 'channel',
          title: 'Новости',
        },
      },
    });

    expect(parsed.message?.entityType).toBe('channel');
  });

  it('builds normalized message for bot_started update without message payload', () => {
    const parsed = parser.parse({
      update_id: 'upd-bot-started-1',
      update_type: 'bot_started',
      chat_id: 152517912,
      user: {
        user_id: 100500,
        first_name: 'MAX',
        last_name: 'User',
      },
      timestamp: 1772249118580,
    });

    expect(parsed.type).toBe('bot_started');
    expect(parsed.message?.messageId).toBe('bot_started:upd-bot-started-1');
    expect(parsed.message?.chatId).toBe('152517912');
    expect(parsed.message?.senderId).toBe('100500');
    expect(parsed.message?.senderName).toBe('MAX User');
  });
});
