import type { PublisherPostImportSession } from '@maxim/contracts/publisher';

export type PublisherPostImportPresentation = {
  title: string;
  detail: string | null;
  tone: 'neutral' | 'ready' | 'danger';
  action: 'open-bot' | 'open-draft' | 'retry' | null;
};

export type PublisherPostImportDraftContext = {
  sessionId: string | null;
  omissions: PublisherPostImportSession['omissions'];
};

export function resolvePublisherPostImportDraftContext(
  session: PublisherPostImportSession | null | undefined,
  publicationId: string,
): PublisherPostImportDraftContext {
  if (session?.status !== 'ready' || session.publicationId !== publicationId) {
    return { sessionId: null, omissions: [] };
  }

  return { sessionId: session.id, omissions: [...session.omissions] };
}

export function shouldOfferPublisherButtonRecovery(
  omissions: PublisherPostImportSession['omissions'],
  customButtonCount: number,
): boolean {
  return customButtonCount === 0 && omissions.includes('buttons_not_imported');
}

function describeImportFailure(code: PublisherPostImportSession['failureCode']): string {
  switch (code) {
    case 'empty_content':
      return 'В сообщении нет текста или медиа';
    case 'media_invalid':
      return 'Файл повреждён или имеет другой формат';
    case 'image_dimensions':
      return 'Слишком большое разрешение фото';
    case 'draft_quota':
      return 'Освободите место в черновиках';
    case 'invalid_forward':
      return 'Перешлите исходный пост';
    case 'message_unavailable':
      return 'Пост больше недоступен';
    case 'unsupported_content':
      return 'Этот формат не поддерживается';
    case 'text_too_long':
      return 'Пост слишком длинный';
    case 'too_many_images':
      return 'В посте слишком много фото';
    case 'image_too_large':
    case 'media_too_large':
      return 'Фото или видео слишком большое';
    case 'media_download_failed':
      return 'Не удалось загрузить фото или видео';
    case 'processing_timeout':
      return 'Перенос занял слишком много времени';
    default:
      return 'Не удалось перенести пост';
  }
}

function describeImportOmissions(
  omissions: PublisherPostImportSession['omissions'],
): string | null {
  const buttonsOmitted = omissions.includes('buttons_not_imported');
  const attachmentsOmitted = omissions.includes('attachments_not_imported');
  const details: string[] = [];
  if (attachmentsOmitted && buttonsOmitted) {
    details.push('Не перенесены: часть вложений, кнопки');
  } else if (attachmentsOmitted) {
    details.push('Часть вложений не перенесена');
  } else if (buttonsOmitted) {
    details.push('Кнопки не перенесены');
  }
  if (omissions.includes('formatting_not_preserved')) {
    details.push('Форматирование упрощено');
  }
  return details.length > 0 ? details.join(' · ') : null;
}

export function resolvePublisherPostImportPresentation(
  session: PublisherPostImportSession,
): PublisherPostImportPresentation | null {
  switch (session.status) {
    case 'waiting':
      return {
        title: session.inputMode === 'collection' ? 'Собираю пост' : 'Жду пост',
        detail:
          session.inputMode === 'collection'
            ? `Сообщений: ${session.collectedCount ?? 0}. Когда закончите, нажмите «Готово» в диалоге.`
            : null,
        tone: 'neutral',
        action: session.botUrl ? 'open-bot' : null,
      };
    case 'processing':
      return { title: 'Готовлю черновик', detail: null, tone: 'neutral', action: null };
    case 'ready':
      return {
        title: 'Черновик готов',
        detail: describeImportOmissions(session.omissions),
        tone: 'ready',
        action: session.publicationId ? 'open-draft' : null,
      };
    case 'failed':
      return {
        title: describeImportFailure(session.failureCode),
        detail: null,
        tone: 'danger',
        action: 'retry',
      };
    case 'expired':
      return { title: 'Время вышло', detail: null, tone: 'neutral', action: 'retry' };
    case 'canceled':
      return null;
  }
}
