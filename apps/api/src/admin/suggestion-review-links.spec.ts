import {
  buildPublishedSuggestionButton,
  buildSuggestionReviewButtons,
  suggestionReviewUrl,
} from './suggestion-review-links';
import { parseSuggestionNativeCallback } from './suggestion-native-protocol';
import type { MaxBotLinkService } from '../max/max-bot-link.service';

describe('suggestion review bot cards', () => {
  const receipt = {
    reviewStatus: 'published',
    publishedMessageId: 'post-42',
    publishedUrl: 'https://max.ru/c/-123/42?context=channel#post',
  };
  it('opens the saved exact post destination without replacing it with the channel link', () => {
    expect(buildPublishedSuggestionButton('moderation', receipt)).toEqual({
      type: 'link',
      text: 'Опубликовано',
      url: receipt.publishedUrl,
    });
  });
  it.each([
    undefined,
    '',
    'https://max.ru/',
    'https://example.com/post',
    'https://max.ru.example.com/post',
    'https://user:password@max.ru/post',
    'https://max.ru:8443/post',
    'javascript:alert(1)',
    'https://max.ru/' + 'a'.repeat(2048),
  ])('does not invent a post destination from an invalid saved URL: %s', (publishedUrl) => {
    expect(buildPublishedSuggestionButton('moderation', { ...receipt, publishedUrl })).toBeNull();
  });
  it('requires a confirmed Major receipt and keeps Publik handoff distinct from publication', () => {
    expect(buildPublishedSuggestionButton('publisher', receipt)).toBeNull();
    for (const reviewStatus of ['pending', 'publishing', 'cancelled', 'drafted'])
      expect(buildPublishedSuggestionButton('moderation', { ...receipt, reviewStatus })).toBeNull();
    expect(
      buildPublishedSuggestionButton('moderation', { ...receipt, publishedMessageId: null }),
    ).toBeNull();
  });
  const links = {
    buildEntryMiniappStartUrlSync: (start: string) => `https://max.ru/major?startapp=${start}`,
    buildPublisherMiniappStartUrlSync: (start: string) => `https://max.ru/publik?startapp=${start}`,
  } satisfies Pick<
    MaxBotLinkService,
    'buildEntryMiniappStartUrlSync' | 'buildPublisherMiniappStartUrlSync'
  >;
  it.each(['moderation', 'publisher'] as const)(
    'moderates %s entirely inside its bot',
    (profile) => {
      const buttons = buildSuggestionReviewButtons(
        links as MaxBotLinkService,
        profile,
        'suggestion-42',
        undefined,
        7,
      );
      expect(buttons.map((row) => row.map((button) => button.text))).toEqual([
        ['Опубликовать'],
        ['Править', 'Отклонить'],
      ]);
      expect(
        buttons
          .flat()
          .map((button) =>
            button.type === 'callback' ? parseSuggestionNativeCallback(button.payload) : null,
          ),
      ).toEqual([
        { action: 'publish', id: 'suggestion-42', revision: 7, version: 0 },
        { action: 'edit', id: 'suggestion-42', revision: 7, version: 0 },
        { action: 'reject', id: 'suggestion-42', revision: 7, version: 0 },
      ]);
    },
  );
  it('keeps existing explicit miniapp entry links compatible', () => {
    const url = new URL(
      suggestionReviewUrl(links as MaxBotLinkService, 'publisher', 'suggestion-42', 'publish')!,
    );
    expect(url.pathname).toBe('/publik');
    expect(
      JSON.parse(Buffer.from(url.searchParams.get('startapp')!.slice(3), 'base64url').toString()).r,
    ).toBe('/suggestions/suggestion-42/publish');
  });
});
