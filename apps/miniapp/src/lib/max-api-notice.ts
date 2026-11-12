export const MAX_API_NOTICE = {
  id: 'max-api-2026-11-12',
  date: '11–12.11.2026',
  title: 'Сбой на стороне MAX',
  message:
    'На стороне платформы MAX произошёл сбой. Из-за этого бот может пропускать отдельные события. Ожидаем восстановления стабильной работы MAX.',
  startsAt: Date.parse('2026-11-12T12:30:00Z'),
  expiresAt: Date.parse('2026-11-12T18:30:00Z'),
} as const;

export function isMaxApiNoticeActive(now = Date.now()): boolean {
  return now >= MAX_API_NOTICE.startsAt && now < MAX_API_NOTICE.expiresAt;
}

export function maxApiNoticeAcknowledgementKey(userId: string): string {
  return `maxim:notice:${MAX_API_NOTICE.id}:${userId}`;
}
