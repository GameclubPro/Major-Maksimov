import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import { notifyManager, useQueryClient } from '@tanstack/react-query';
import { useLocation, useSearchParams } from 'react-router';
import type { MarketplaceProfileState } from '@maxim/contracts/marketplace-integration';
import { marketplaceProfileTitle, marketplaceQueryKey } from '../lib/marketplace-profile-summary';
import type { ApiTransport } from '../lib/api/transport';
import { SkeletonCard } from './ui/skeleton';
import { AppIcon } from './ui/app-icon';
import { useSmartphoneLayout } from '../lib/use-smartphone-layout';
import './marketplace-profile-card.css';

const Panel = lazy(() => import('./marketplace-profile-panel'));

export type MarketplaceProfileCardProps = {
  api: ApiTransport;
  entityId: string;
  entityTitle?: string;
  entityAvatarUrl?: string | null;
  entityType: 'chat' | 'channel';
  profile: 'moderation' | 'publisher';
};

export function MarketplaceProfileCard(props: MarketplaceProfileCardProps) {
  const smartphone = useSmartphoneLayout();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const requested = params.get('focus') === 'birzhik';
  const [open, setOpen] = useState(requested);
  useEffect(() => {
    if (requested) setOpen(true);
  }, [requested, location.key]);
  const close = () => {
    setOpen(false);
    if (requested) {
      const next = new URLSearchParams(params);
      next.delete('focus');
      setParams(next, { replace: true });
    }
  };
  const cache = useQueryClient();
  const profileKey = useMemo(
    () => marketplaceQueryKey(props.profile, props.entityType, props.entityId),
    [props.profile, props.entityType, props.entityId],
  );
  const known = useSyncExternalStore(
    useCallback(
      (changed: () => void) =>
        cache.getQueryCache().subscribe(
          notifyManager.batchCalls((event) => {
            if (
              event.type === 'updated' &&
              JSON.stringify(event.query.queryKey) === JSON.stringify(profileKey)
            )
              changed();
          }),
        ),
      [cache, profileKey],
    ),
    useCallback(
      () => cache.getQueryState<MarketplaceProfileState>(profileKey),
      [cache, profileKey],
    ),
  );
  const id = `marketplace-profile-${props.profile}-${props.entityType}`;
  return (
    <section
      className={
        'marketplace-profile-card channel-settings-card settings-home-entry' +
        (smartphone ? ' settings-section' : '')
      }
      data-settings-search="Рекламная биржа Биржик реклама взаимопиар"
      style={{ order: 32 }}
    >
      {smartphone ? (
        <div className="settings-section__head">
          <button
            type="button"
            className="settings-section__toggle is-stateless"
            data-settings-navigation-entry="true"
            aria-label="Рекламная биржа"
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen(true)}
          >
            <span className="settings-section__icon-badge is-sky" aria-hidden>
              <AppIcon icon="Shop" />
            </span>
            <span className="settings-section__toggle-main">
              <span className="settings-section__title">Рекламная биржа</span>
            </span>
            <span className="settings-section__chevron" aria-hidden>
              <AppIcon icon="NavArrowRight" />
            </span>
          </button>
        </div>
      ) : (
        <button
          className="marketplace-profile-card__open"
          aria-label="Рекламная биржа"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen(true)}
        >
          <span>
            <strong>Рекламная биржа</strong>
            <small>
              {known?.data
                ? marketplaceProfileTitle(known.data, known.status !== 'error')
                : 'Создайте профиль со статистикой'}
            </small>
          </span>
          <span aria-hidden>›</span>
        </button>
      )}
      {open && (
        <Suspense fallback={<SkeletonCard lines={5} />}>
          <Panel {...props} id={id} onClose={close} />
        </Suspense>
      )}
    </section>
  );
}
