export const MAX_API_NOTICE = {
  id: 'max-api-2026-11-11',
  date: '11.11.2026',
  title: 'Нестабильная работа API MAX',
  message:
    'В данный момент бот может пропускать некоторые события из-за нестабильной работы API MAX. Проблема предположительно на стороне платформы, ожидаем стабилизации работы.',
  startsAt: Date.parse('2026-11-11T13:15:00Z'),
  expiresAt: Date.parse('2026-11-11T19:15:00Z'),
} as const;

export function isMaxApiNoticeActive(now = Date.now()): boolean {
  return now >= MAX_API_NOTICE.startsAt && now < MAX_API_NOTICE.expiresAt;
}

export function maxApiNoticeAcknowledgementKey(userId: string): string {
  return `maxim:notice:${MAX_API_NOTICE.id}:${userId}`;
}
