import type { CommercialAdsPreviewResponse } from '@maxim/contracts/settings';

export function commercialPreviewExplanation(result: CommercialAdsPreviewResponse): string {
  switch (result.reason) {
    case 'FILTER_DISABLED':
      return 'Фильтр выключен.';
    case 'CATEGORY_ALLOWED':
      return result.categories.length > 1 ? 'Эти категории разрешены.' : 'Эта категория разрешена.';
    case 'PARTICIPANT_EXCEPTION':
      return 'Для автора действует исключение.';
    case 'BLOCKED_CATEGORY':
      return result.categories.length > 1
        ? 'Есть запрещённая категория.'
        : 'Эта категория запрещена.';
    case 'NOT_ADVERTISING':
      return 'Признаков рекламы не найдено.';
    case 'CLASSIFIER_UNAVAILABLE':
      return 'Повторите проверку позже.';
    case 'INVALID_POLICY':
      return 'Проверьте настройки рекламы.';
    case 'LEGACY_POLICY':
      return 'По действующим правилам рекламы.';
    case 'INSUFFICIENT_CONTEXT':
      return 'Недостаточно признаков для удаления.';
  }
}
