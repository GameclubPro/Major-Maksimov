import type { ChatClosureStatus } from '@maxim/contracts/settings';

function formatTime(value: string, timezone: string) {
  try {
    return new Date(value).toLocaleString('ru-RU', {
      timeZone: timezone,
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return 'время не определено';
  }
}

export default function SettingsChatClosureStatus({
  status,
  refreshFailed = false,
}: {
  status: ChatClosureStatus;
  refreshFailed?: boolean;
}) {
  const noticesEnabled = status.notices?.close.enabledNow || status.notices?.open.enabledNow;
  return (
    <div className="night-status" role="status">
      <strong className="night-status__heading">
        {refreshFailed ? 'Последнее состояние: ' : ''}
        {status.restriction === 'open' ? 'Чат открыт' : 'Чат закрыт'}
      </strong>
      {status.opensAt ? <p>Открытие: {formatTime(status.opensAt, status.timezone)}</p> : null}
      {refreshFailed ? (
        <p className="night-status__warning">Не удалось обновить состояние. Обновите экран.</p>
      ) : null}
      {status.deleteRoute === 'unavailable' ? (
        <p className="night-status__warning">
          Бот не может удалять сообщения. Проверьте его права администратора.
        </p>
      ) : null}
      {noticesEnabled && status.notices?.sendRouteNow === 'unavailable' ? (
        <p className="night-status__warning">
          Бот не может отправлять уведомления. Проверьте его права администратора.
        </p>
      ) : null}
    </div>
  );
}
