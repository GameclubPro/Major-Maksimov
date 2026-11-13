import { buildSuggestionReviewButtons, suggestionReviewUrl } from './suggestion-review-links';
import type { MaxBotLinkService } from '../max/max-bot-link.service';

describe('suggestion review bot cards', () => {
  it.each(['moderation', 'publisher'] as const)(
    'opens the exact %s suggestion in the intended bot',
    (profile) => {
      const links = {
        buildEntryMiniappStartUrlSync: (start: string) => `https://max.ru/major?startapp=${start}`,
        buildPublisherMiniappStartUrlSync: (start: string) =>
          `https://max.ru/publik?startapp=${start}`,
      } satisfies Pick<
        MaxBotLinkService,
        'buildEntryMiniappStartUrlSync' | 'buildPublisherMiniappStartUrlSync'
      >;
      const url = suggestionReviewUrl(
        links as MaxBotLinkService,
        profile,
        'suggestion-42',
        'publish',
      )!;
      const buttons = buildSuggestionReviewButtons(
        links as MaxBotLinkService,
        profile,
        'suggestion-42',
        { type: 'link', text: '📰 В публикацию', url },
      );
      expect(buttons.map((row) => row.map((button) => button.text))).toEqual([
        ['✏️ Редактировать'],
        ['📰 В публикацию', '✖️ Отклонить'],
      ]);
      expect(
        buttons.flat().map((button) => {
          if (button.type !== 'link') throw new Error('Expected mini app link');
          const link = new URL(button.url);
          expect(link.pathname).toBe(profile === 'publisher' ? '/publik' : '/major');
          return JSON.parse(
            Buffer.from(link.searchParams.get('startapp')!.slice(3), 'base64url').toString(),
          ).r;
        }),
      ).toEqual([
        '/suggestions/suggestion-42/edit',
        '/suggestions/suggestion-42/publish',
        '/suggestions/suggestion-42/reject',
      ]);
    },
  );
});
