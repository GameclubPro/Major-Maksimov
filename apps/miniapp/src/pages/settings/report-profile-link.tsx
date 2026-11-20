import { useMutation } from '@tanstack/react-query';
import type { ApiTransport } from '../../lib/api/transport';
import { handoffEntityMemberProfile } from '../../lib/api/member-profile-handoff-client';
import { openPrivateBotHandoff } from '../../lib/max-bridge';

export function ReportProfileLink({
  api,
  chatId,
  userId,
  displayName,
  profileUrl,
  profileHandoffUrl,
}: {
  api: ApiTransport;
  chatId: string;
  userId: string;
  displayName?: string | null;
  profileUrl?: string | null;
  profileHandoffUrl?: string | null;
}) {
  const name = displayName?.trim() || null;
  const label = name || 'Имя недоступно';
  const handoff = useMutation({
    mutationFn: () =>
      handoffEntityMemberProfile(api, 'chat', chatId, userId, {
        displayName: name || 'Пользователь',
      }),
    onSuccess: (result) => {
      if (!openPrivateBotHandoff(result.botUrl)) throw new Error('Profile link unavailable');
    },
  });
  return (
    <span className="report-profile">
      <a
        href={safeMaxUrl(profileHandoffUrl) ?? safeMaxUrl(profileUrl) ?? '#'}
        className="report-profile__link"
        aria-label={`Открыть профиль: ${label}`}
        aria-busy={handoff.isPending}
        aria-disabled={handoff.isPending}
        onClick={(event) => {
          if (
            (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) &&
            event.currentTarget.getAttribute('href') !== '#'
          )
            return;
          event.preventDefault();
          // FLAG: The existing handoff persists the real name before MAX opens the bot dialog.
          if (!handoff.isPending) handoff.mutate();
        }}
      >
        {label}
      </a>
      {handoff.isError && (
        <span className="report-profile__error" role="alert">
          Не удалось открыть профиль.
        </span>
      )}
    </span>
  );
}

function safeMaxUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      ['max.ru', 'www.max.ru'].includes(url.hostname) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
