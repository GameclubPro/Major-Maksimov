import { BadRequestException } from '@nestjs/common';
import type { MaxUpdate } from '@maxim/contracts';
import {
  dedupeForwardedModerationTargets,
  extractDirectIncomingMessageText,
  extractForwardedModerationTargets,
  extractForwardedRulesSources,
  extractPrivateForwardedModerationTargets,
  extractPrivateForwardedRulesSources,
  getAdminCommandName,
  parseAdminForwardedModerationCommand,
  parsePrivateForwardedModerationCommand,
} from './admin-forwarded-command.util';

function createCommandUpdate(
  params: {
    text?: string;
    forwardedChatId?: string | number;
    forwardedMessageId?: string | number;
    forwardedUserId?: string | number;
  } = {},
): MaxUpdate {
  const text = params.text ?? 'бан';
  const forwardedChatId = params.forwardedChatId ?? 'chat-1';
  const forwardedMessageId = params.forwardedMessageId ?? 'mid-forward-1';
  const forwardedUserId = params.forwardedUserId ?? 'user-2';
  return {
    updateId: 'upd-admin-forward-1',
    type: 'message_created',
    message: {
      messageId: 'msg-admin-forward-1',
      chatId: 'chat-1',
      senderId: 'admin-1',
      senderName: 'Админ',
      text,
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_created',
      message: {
        sender: {
          user_id: 'admin-1',
          display_name: 'Админ',
        },
        recipient: {
          chat_id: 'chat-1',
        },
        body: {
          text,
          forwarded_message: {
            sender: {
              user_id: forwardedUserId,
              display_name: 'Нарушитель',
            },
            recipient: {
              chat_id: forwardedChatId,
              title: forwardedChatId === 'chat-1' ? 'Chat 1' : 'Другой чат',
            },
            body: {
              mid: forwardedMessageId,
              text: 'spam message',
            },
          },
        },
      },
    },
  };
}

function createReplyUpdate(text = 'мут'): MaxUpdate {
  return {
    updateId: 'upd-admin-reply-1',
    type: 'message_created',
    message: {
      messageId: 'msg-admin-reply-1',
      chatId: 'chat-1',
      senderId: 'admin-1',
      senderName: 'Админ',
      text,
      createdAt: new Date().toISOString(),
    },
    raw: {
      update_type: 'message_created',
      message: {
        sender: {
          user_id: 'admin-1',
          display_name: 'Админ',
        },
        recipient: {
          chat_id: 'chat-1',
        },
        link: {
          type: 'reply',
          sender: {
            user_id: 'user-2',
            first_name: 'Иван',
            last_name: 'Петров',
          },
          message: {
            mid: 'mid-reply-target-1',
            text: 'spam reply',
          },
        },
        body: {
          text,
        },
      },
    },
  };
}

function createRulesUpdate(
  text = 'правило',
  params: {
    forwardedChatId?: string | number;
    body?: Record<string, unknown>;
  } = {},
): MaxUpdate {
  const forwardedChatId = params.forwardedChatId ?? 'chat-1';
  const body = params.body ?? {
    mid: 'mid-rules-source-1',
    text: '1. Без спама.',
  };
  return {
    updateId: 'upd-admin-rules-1',
    type: 'message_created',
    message: {
      messageId: 'msg-admin-rules-1',
      chatId: 'chat-1',
      senderId: 'admin-1',
      senderName: 'Админ',
      text,
      createdAt: new Date().toISOString(),
    },
    raw: {
      message: {
        body: {
          text,
          forwarded_message: {
            recipient: {
              chat_id: forwardedChatId,
              title: forwardedChatId === 'chat-1' ? 'Chat 1' : 'Другой чат',
            },
            body,
          },
        },
      },
    },
  };
}

describe('admin forwarded command util', () => {
  it('parses built-in and custom moderation commands', () => {
    expect(parseAdminForwardedModerationCommand('БаН!')).toEqual({
      action: 'BAN',
      fanoutAllChats: true,
    });
    expect(parseAdminForwardedModerationCommand('мут 12ч')).toEqual({
      action: 'MUTE',
      muteDurationHours: 12,
    });
    expect(parseAdminForwardedModerationCommand('Мут!')).toEqual({
      action: 'MUTE',
      fanoutAllChats: true,
      muteDurationHours: 6,
    });
    expect(parseAdminForwardedModerationCommand('Мут! 24')).toEqual({
      action: 'MUTE',
      fanoutAllChats: true,
      muteDurationHours: 24,
    });
    expect(parseAdminForwardedModerationCommand('мут 88')).toEqual({
      action: 'MUTE',
      mutePermanent: true,
    });
    expect(parseAdminForwardedModerationCommand('super-ban.')).toBeNull();
    expect(
      parseAdminForwardedModerationCommand('регламент', { adminRulesCommandName: 'Регламент' }),
    ).toEqual({
      action: 'RULES',
    });
    expect(
      parseAdminForwardedModerationCommand('открыть', {
        adminOpenChatCommandName: 'Открыть',
      }),
    ).toEqual({
      action: 'OPEN_CHAT',
    });
  });

  it('does not accept extra punctuation after a configured command that already has punctuation', () => {
    expect(parseAdminForwardedModerationCommand('бан!!')).toBeNull();
    expect(
      parseAdminForwardedModerationCommand('мера!!', { adminBanAllCommandName: 'мера!' }),
    ).toBeNull();
    expect(
      parseAdminForwardedModerationCommand('точка..', { adminRulesCommandName: 'точка.' }),
    ).toBeNull();
    expect(
      parseAdminForwardedModerationCommand('мера!', { adminBanAllCommandName: 'мера!' }),
    ).toEqual({
      action: 'BAN',
      fanoutAllChats: true,
    });
  });

  it('parses private forwarded commands with private-only semantics', () => {
    expect(parsePrivateForwardedModerationCommand('БаН!')).toEqual({
      action: 'BAN',
    });
    expect(parsePrivateForwardedModerationCommand('ban!')).toEqual({
      action: 'BAN',
    });
    expect(parsePrivateForwardedModerationCommand('мут')).toEqual({
      action: 'MUTE',
      muteDurationHours: 6,
    });
    expect(parsePrivateForwardedModerationCommand('мью 12ч')).toEqual({
      action: 'MUTE',
      muteDurationHours: 12,
    });
    expect(parsePrivateForwardedModerationCommand('мут 88')).toEqual({
      action: 'MUTE',
      mutePermanent: true,
    });
    expect(parsePrivateForwardedModerationCommand('правила.')).toEqual({
      action: 'RULES',
    });

    expect(parsePrivateForwardedModerationCommand('супер бан')).toBeNull();
    expect(parsePrivateForwardedModerationCommand('бан везде')).toBeNull();
    expect(parsePrivateForwardedModerationCommand('тишина')).toBeNull();
    expect(parsePrivateForwardedModerationCommand('открыть')).toBeNull();
  });

  it('rejects obsolete ban durations and invalid mute/silence durations', () => {
    expect(() => parseAdminForwardedModerationCommand('бан 24')).toThrow(BadRequestException);
    expect(() => parseAdminForwardedModerationCommand('мут 999')).toThrow(BadRequestException);
    expect(() => parseAdminForwardedModerationCommand('Мут! 0')).toThrow(BadRequestException);
    expect(() => parseAdminForwardedModerationCommand('Мут! 999')).toThrow(BadRequestException);
    expect(() => parseAdminForwardedModerationCommand('тишина 0')).toThrow(BadRequestException);
    expect(() => parsePrivateForwardedModerationCommand('бан 24')).toThrow(
      'Команда «бан» применяется без срока. Отправьте её без длительности.',
    );
    expect(() => parsePrivateForwardedModerationCommand('мут 999')).toThrow(
      'Для мута укажите срок от 1 до 336 ч.',
    );
  });

  it('normalizes configured command labels', () => {
    expect(getAdminCommandName('  Бан   Везде ', 'бан')).toBe('бан везде');
    expect(getAdminCommandName(null, 'бан')).toBe('бан');
  });

  it('extracts direct command text from the normalized message or raw payload', () => {
    expect(extractDirectIncomingMessageText(createCommandUpdate({ text: 'мут' }))).toBe('мут');
    const update = createCommandUpdate({ text: 'бан' });
    update.message!.text = '';
    expect(extractDirectIncomingMessageText(update)).toBe('бан');
  });

  it('extracts and deduplicates forwarded moderation targets', () => {
    const targets = extractForwardedModerationTargets(createCommandUpdate());
    expect(targets).toEqual([
      {
        chatId: 'chat-1',
        chatTitle: 'Chat 1',
        userId: 'user-2',
        senderName: 'Нарушитель',
        messageId: 'mid-forward-1',
      },
    ]);

    expect(
      dedupeForwardedModerationTargets([
        {
          chatId: 'chat-1',
          chatTitle: null,
          userId: 'user-2',
          senderName: null,
          messageId: null,
        },
        {
          chatId: 'chat-1',
          chatTitle: null,
          userId: 'user-2',
          senderName: null,
          messageId: 'mid-later',
        },
      ]),
    ).toEqual([
      {
        chatId: 'chat-1',
        chatTitle: null,
        userId: 'user-2',
        senderName: null,
        messageId: 'mid-later',
      },
    ]);
  });

  it('uses the current chat as fallback for reply-linked moderation targets', () => {
    expect(extractForwardedModerationTargets(createReplyUpdate(), 'chat-1')).toEqual([
      {
        chatId: 'chat-1',
        chatTitle: null,
        userId: 'user-2',
        senderName: 'Иван Петров',
        messageId: 'mid-reply-target-1',
      },
    ]);
  });

  it('prefers split first and last names over legacy reply sender names', () => {
    const update = createReplyUpdate();
    const raw = update.raw as {
      message?: { link?: { sender?: Record<string, unknown> } };
    };
    const replySender = raw.message?.link?.sender;
    if (!replySender) {
      throw new Error('Reply sender fixture is missing');
    }
    Object.assign(replySender, {
      name: 'Иван',
      nickname: 'Ваня',
    });

    expect(extractForwardedModerationTargets(update, 'chat-1')[0]?.senderName).toBe('Иван Петров');
  });

  it('keeps private forwarded extraction narrower than admin extraction', () => {
    expect(extractPrivateForwardedModerationTargets(createReplyUpdate())).toEqual([]);
    expect(
      extractPrivateForwardedModerationTargets(
        createCommandUpdate({
          forwardedChatId: '123456',
        }),
      ),
    ).toEqual([]);
    expect(
      extractPrivateForwardedModerationTargets(
        createCommandUpdate({
          forwardedChatId: '-100123456',
          forwardedUserId: 42,
        }),
      ),
    ).toEqual([
      {
        chatId: '-100123456',
        chatTitle: 'Другой чат',
        userId: '42',
        senderName: 'Нарушитель',
      },
    ]);
  });

  it('extracts forwarded rules sources separately from moderation targets', () => {
    expect(extractForwardedRulesSources(createRulesUpdate())).toEqual([
      {
        chatId: 'chat-1',
        chatTitle: 'Chat 1',
        messageId: 'mid-rules-source-1',
        url: null,
        text: '1. Без спама.',
      },
    ]);
  });

  it('filters private direct dialogs for private forwarded rule sources', () => {
    expect(
      extractPrivateForwardedRulesSources(
        createRulesUpdate('правила', {
          forwardedChatId: '123456',
        }),
      ),
    ).toEqual([]);
    expect(
      extractPrivateForwardedRulesSources(
        createRulesUpdate('правила', {
          forwardedChatId: '-100123456',
          body: {
            mid: 'mid-rules-source-2',
            caption: '1. Не флудить.',
          },
        }),
      ),
    ).toEqual([
      {
        chatId: '-100123456',
        chatTitle: 'Другой чат',
        messageId: 'mid-rules-source-2',
        url: null,
        text: '1. Не флудить.',
      },
    ]);
  });
});
