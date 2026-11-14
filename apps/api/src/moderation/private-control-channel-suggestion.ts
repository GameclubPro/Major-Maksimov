import { BadRequestException, HttpException } from '@nestjs/common';
import { isAmbiguousMaxSendError } from '../max/max-send-ambiguity.util';
import { isMaxApiCircuitOpenError } from '../max/max-client.service';
import { MaxApiInternalRateLimitError } from '../max/max-api-internal-rate-limit.error';
import { extractPrivateControlUserErrorDetails } from './private-control-bad-request.util';
import type { PrivateSuggestionDraft } from './private-control.types';

export function privateSuggestionReviewErrorDiagnostic(error: unknown) {
  const status =
    error instanceof HttpException
      ? error.getStatus()
      : (error as { response?: { status?: number } } | null)?.response?.status;
  const reason =
    error instanceof MaxApiInternalRateLimitError
      ? 'local_capacity'
      : isMaxApiCircuitOpenError(error)
        ? 'circuit_open'
        : isAmbiguousMaxSendError(error)
          ? 'transport_unconfirmed'
          : typeof status === 'number'
            ? 'request_rejected'
            : 'unexpected';
  return { reason, httpStatus: typeof status === 'number' ? status : null };
}

export function describePrivateSuggestionReviewError(error: unknown): string {
  if (error instanceof MaxApiInternalRateLimitError || isMaxApiCircuitOpenError(error)) {
    return 'MAX временно ограничил запросы. Предложка сохранена; повторите действие немного позже.';
  }
  // FLAG: Translate only this known application refusal, never arbitrary technical MAX text.
  if (
    error instanceof HttpException &&
    error.getStatus() === 503 &&
    error.message === 'MAX API временно ограничил проверку прав администратора. Повторите попытку.'
  ) {
    return 'MAX временно ограничил проверку прав администратора. Повторите попытку немного позже.';
  }
  const publicMessage = extractPrivateControlUserErrorDetails(
    error instanceof HttpException ? new BadRequestException(error.getResponse()) : error,
  );
  if (publicMessage) return publicMessage;
  const status =
    error instanceof HttpException
      ? error.getStatus()
      : (error as { response?: { status?: number } } | null)?.response?.status;
  if (status === 403 || status === 404) {
    return 'Не удалось обработать предложку. Проверьте, что вы и бот по-прежнему администраторы канала и у бота есть право публикации.';
  }
  if (status === 429) {
    return 'MAX временно ограничил запросы. Предложка сохранена; повторите действие немного позже.';
  }
  if (isAmbiguousMaxSendError(error)) {
    return 'MAX не подтвердил результат. Проверьте канал перед повторным действием; если статус не обновится, обратитесь в поддержку.';
  }
  return 'Не удалось подтвердить результат обработки предложки. Проверьте канал и повторно откройте карточку; если ошибка сохраняется, обратитесь в поддержку.';
}

export function buildPrivateChannelSuggestionSubmissionPayload(draft: PrivateSuggestionDraft) {
  return {
    token: draft.token,
    text: draft.text,
    ...(draft.textMarkup.length > 0 ? { textMarkup: draft.textMarkup } : {}),
    ...(draft.textMarkup.length === 0 && draft.textFormat === 'markdown'
      ? { textFormat: draft.textFormat }
      : {}),
    ...(draft.images.length > 0
      ? {
          images: draft.images.map((image) => ({
            payload: image.payload,
            mimeType: image.mimeType || null,
            fileName: image.fileName || null,
          })),
        }
      : draft.video
        ? {
            mediaType: draft.video.kind,
            mediaPayload: draft.video.payload,
            mediaMimeType: draft.video.mimeType || null,
            mediaFileName: draft.video.fileName || null,
          }
        : draft.imageBase64
          ? {
              imageBase64: draft.imageBase64,
              imageMimeType: draft.imageMimeType || null,
              imageFileName: draft.imageFileName || null,
            }
          : {}),
  };
}

export function assertPrivateSuggestionMediaBot(
  draft: PrivateSuggestionDraft | null | undefined,
  currentBotId: string | null | undefined,
): void {
  if (!draft || !hasBotScopedDraftMedia(draft)) return;
  const storedBotId = draft.mediaBotId?.trim() ?? '';
  const normalizedCurrentBotId = currentBotId?.trim() ?? '';
  if (storedBotId && normalizedCurrentBotId === storedBotId) return;
  throw new BadRequestException(
    'Медиа этой предложки загружено другим ботом. Вернитесь к исходному боту или создайте новую предложку.',
  );
}

export function assertPrivateSuggestionMediaCaptureBot(
  hasIncomingMedia: boolean,
  currentBotId: string | null | undefined,
): void {
  if (!hasIncomingMedia || currentBotId?.trim()) return;
  throw new BadRequestException(
    'Не удалось определить бота, который загружает медиа. Откройте предложку заново.',
  );
}

function hasBotScopedDraftMedia(draft: PrivateSuggestionDraft): boolean {
  const hasToken = (payload: Record<string, unknown>) =>
    typeof payload.token === 'string' && payload.token.trim().length > 0;
  return (
    draft.images.some((image) => hasToken(image.payload)) ||
    Boolean(draft.video && hasToken(draft.video.payload))
  );
}
