import { Suspense, type ComponentProps } from 'react';
import type { CommercialAuthor } from '../../lib/commercial-ads-policy';
import { recoverableLazyNamedComponent } from '../../lib/recoverable-lazy';
import { AppIcon } from '../../components/ui/app-icon';
import { PersonAvatar } from '../../components/ui/person-avatar';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import { Spinner } from '../../components/ui/spinner';

const LazyCommercialAuthorPicker = recoverableLazyNamedComponent<
  ComponentProps<typeof import('./commercial-policy-author-picker').CommercialAuthorPicker>
>(() => import('./commercial-policy-author-picker'), 'CommercialAuthorPicker');

export function CommercialAuthorPicker(
  props: ComponentProps<typeof import('./commercial-policy-author-picker').CommercialAuthorPicker>,
) {
  return (
    <Suspense
      fallback={
        <SettingsDrilldownPanel
          id="commercial-author-picker-loading"
          open
          title="Выбрать участника"
          className="commercial-panel"
          onClose={props.onClose}
        >
          <Spinner label="Загружаем участников" />
        </SettingsDrilldownPanel>
      }
    >
      <LazyCommercialAuthorPicker {...props} />
    </Suspense>
  );
}

export function AuthorControl({
  value,
  onChoose,
  onClear,
  optional = false,
  disabled = false,
}: {
  value: CommercialAuthor | null;
  onChoose: () => void;
  onClear?: () => void;
  optional?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="commercial-policy__author-field">
      <span className="commercial-policy__label">
        {optional ? 'Автор · необязательно' : 'Участник'}
      </span>
      <div className="commercial-policy__author-wrap">
        <button
          type="button"
          className="commercial-policy__author"
          disabled={disabled}
          onClick={onChoose}
        >
          {value ? (
            <PersonAvatar
              avatarUrl={value.avatarUrl ?? null}
              fallback={value.userName.slice(0, 1)}
              className="commercial-policy__avatar"
            />
          ) : (
            <span className="commercial-policy__author-icon">
              <AppIcon icon="User" />
            </span>
          )}
          <span>{value?.userName ?? 'Выбрать участника'}</span>
          <AppIcon icon="NavArrowRight" />
        </button>
        {value && onClear ? (
          <button
            type="button"
            className="commercial-policy__clear"
            onClick={onClear}
            aria-label="Убрать автора"
          >
            <AppIcon icon="Xmark" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
