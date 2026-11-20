import { renderPrivateProfileMentionMessage } from './private-control-profile-mention-handoff';

describe('private control profile mention handoff', () => {
  it('renders html profile mention message with escaped label and encoded user link', () => {
    const message = renderPrivateProfileMentionMessage({
      displayName: 'Анна <Admin> & Co',
      userId: 'user 55/тест',
    });

    expect(message).toEqual({
      text:
        '<strong>Профиль пользователя</strong>\n' +
        '<a href="max://user/user%2055%2F%D1%82%D0%B5%D1%81%D1%82">Анна &lt;Admin&gt; &amp; Co</a>',
      options: {
        textFormat: 'html',
      },
    });
  });
});
