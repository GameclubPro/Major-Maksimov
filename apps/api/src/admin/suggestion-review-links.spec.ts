import { buildSuggestionReviewButtons, suggestionReviewUrl } from './suggestion-review-links';
import { parseSuggestionNativeCallback } from './suggestion-native-protocol';
import type { MaxBotLinkService } from '../max/max-bot-link.service';

describe('suggestion review bot cards', () => {
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
