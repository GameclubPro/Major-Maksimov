import type { PrivateView } from './private-control.types';

export function suggestionReviewResultView(status: string, publishedUrl: string): PrivateView {
  if (status !== 'published') return { text: '**✖️ Предложка отклонена**\n\nРешение сохранено.' };
  return {
    text: [
      '**✅ Предложка опубликована**',
      '',
      ...(publishedUrl ? [`Пост: [Открыть пост](${publishedUrl})`, ''] : []),
      'Решение сохранено.',
    ].join('\n'),
    ...(publishedUrl
      ? {
          options: {
            buttons: [[{ type: 'link' as const, text: 'Открыть пост', url: publishedUrl }]],
          },
        }
      : {}),
  };
}
