import type { ChatClosureStatus, ChatClosureSummary } from '@maxim/contracts/settings';

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
  status: ChatClosureStatus | ChatClosureSummary;
  refreshFailed?: boolean;
}) {
  const compact = 'manualMode' in status ? status : null;
  const legacyNotices = 'notices' in status ? status.notices : undefined;
  const noticesEnabled =
    compact?.notificationsEnabled ??
    (legacyNotices?.close.enabledNow || legacyNotices?.open.enabledNow);
  const sendRoute = compact?.sendRoute ?? legacyNotices?.sendRouteNow;
  const reason =
    status.restriction === 'manual'
      ? compact?.nightActive
        ? 'вручную и по расписанию'
        : 'вручную'
      : status.restriction === 'night'
        ? 'по расписанию'
        : null;

  return (
    <div className="night-status" role="status">
      <strong className="night-status__heading">
        {refreshFailed ? 'Последнее состояние: ' : ''}
        {reason ? `Чат закрыт ${reason}` : 'Чат открыт'}
      </strong>
      {compact?.manualMode === 'forever' ? <p>Без срока</p> : null}
      {status.opensAt ? <p>Открытие: {formatTime(status.opensAt, status.timezone)}</p> : null}
      {refreshFailed ? (
        <p className="night-status__warning">Не удалось обновить состояние. Обновите экран.</p>
      ) : null}
      {status.deleteRoute === 'unavailable' ? (
        <p className="night-status__warning">
          Бот не может удалять сообщения. Проверьте его права администратора.
        </p>
      ) : null}
      {status.deleteRoute === 'unknown' &&
      (status.scheduleEnabled || status.restriction === 'manual') ? (
        <p className="night-status__warning">Не удалось проверить право бота удалять сообщения.</p>
      ) : null}
      {noticesEnabled && sendRoute === 'unknown' ? (
        <p className="night-status__warning">
          Не удалось проверить право бота отправлять уведомления.
        </p>
      ) : null}
      {noticesEnabled && sendRoute === 'unavailable' ? (
        <p className="night-status__warning">
          Бот не может отправлять уведомления. Проверьте его права администратора.
        </p>
      ) : null}
    </div>
  );
}
