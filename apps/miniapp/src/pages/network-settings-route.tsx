import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { networkChannelSettingsSectionSchema } from '@maxim/contracts/network-settings-read';
import type { ApiTransport } from '../lib/api/transport';
import {
  hydrateNetworkSettingsScope,
  createNetworkSettingsScope,
  networkChatWorkspaceSectionSchema,
  type StoredNetworkSettingsScope,
} from '../lib/network-settings-workspace-state';
import { NetworkSettingsPage, type NetworkSettingsEditorScope } from './network-settings-page';
import { NetworkSettingsOverview } from './network-settings-overview';
import { useManagedEntityNavigation } from '../lib/managed-entity-navigation';

import { Spinner } from '../components/ui/spinner';
import { AppIcon } from '../components/ui/app-icon';
import './network-settings-route.css';
import {
  hydrateNetworkSettingsOperationReceipts,
  listNetworkSettingsOperationReceipts,
} from '../lib/network-settings-operation-storage';
import { resolveNetworkRouteOperation } from '../features/networks/network-route-state';
import { useHomeEntityFavorites } from '../lib/home-entity-favorites-context';

export function NetworkSettingsRoute({ api, userId }: { api: ApiTransport; userId: string }) {
  const { type, section } = useParams();
  const location = useLocation();
  const { requestNavigation } = useManagedEntityNavigation();
  const { snapshot } = useHomeEntityFavorites();
  const query = new URLSearchParams(location.search);
  const scopeId = query.get('scope') ?? '';
  const operationId = query.get('operation') ?? undefined;
  const identity = `${userId}:${type}:${scopeId}`;
  const [loaded, setLoaded] = useState<{
    identity: string;
    value: StoredNetworkSettingsScope | null;
  } | null>(null);
  useEffect(() => {
    let active = true;
    if ((type !== 'chat' && type !== 'channel') || !/^[a-f0-9-]{36}$/iu.test(scopeId)) {
      setLoaded({ identity, value: null });
      return;
    }
    void Promise.all([
      hydrateNetworkSettingsScope({ userId, scopeId, entityType: type }),
      hydrateNetworkSettingsOperationReceipts(userId),
    ]).then(
      ([value]) => {
        if (active) setLoaded({ identity, value });
      },
      () => {
        if (active) setLoaded({ identity, value: null });
      },
    );
    return () => {
      active = false;
    };
  }, [identity, scopeId, type, userId]);
  if (loaded?.identity !== identity)
    return (
      <div className="network-route-loading" role="status" aria-live="polite">
        <Spinner />
        <div>
          <strong>Открываем настройки</strong>
          <span>Загружаем сохранённый выбор сообществ…</span>
        </div>
      </div>
    );
  const stored = loaded.value;
  const parsed =
    section === undefined
      ? null
      : type === 'chat'
        ? networkChatWorkspaceSectionSchema.safeParse(section)
        : networkChannelSettingsSectionSchema.safeParse(section);
  const recovered = stored
    ? resolveNetworkRouteOperation({
        userId,
        scopeId,
        entityType: stored.scope.entityType,
        section,
        requestedOperationId: operationId,
        receipts: listNetworkSettingsOperationReceipts(userId),
      })
    : { kind: 'none' as const };
  const operationUnavailable = recovered.kind === 'unavailable';
  if (
    !stored ||
    (parsed !== null && !parsed.success) ||
    stored.scope.entityType !== type ||
    operationUnavailable
  )
    return (
      <div className="network-route-error" role="alert">
        <span className="network-route-error__icon" aria-hidden>
          <AppIcon icon="Group" />
        </span>
        <h1>
          {operationUnavailable ? 'Операция не связана с этим выбором' : 'Выбор не сохранился'}
        </h1>
        <p>
          {operationUnavailable
            ? 'Откройте сохранённую операцию из раздела «Сетки».'
            : 'Откройте сетку ещё раз.'}
        </p>
        <Link to="/networks">
          <AppIcon icon="NavArrowLeft" aria-hidden />К сеткам
        </Link>
      </div>
    );
  const hubPath = `/networks/${type}/settings?${new URLSearchParams({ scope: scopeId })}`;
  const liveTitle =
    stored.scope.target.mode === 'category'
      ? snapshot.labels.resolved[stored.scope.target.favoriteType]
      : stored.title;
  const openSection = (
    nextSection: import('@maxim/contracts/network-settings-read').NetworkSettingsSection,
  ) => {
    const last = listNetworkSettingsOperationReceipts(userId).find(
      (receipt) => receipt.scopeId === scopeId && receipt.section === nextSection,
    );
    const fresh =
      last && (last.settlementConfirmedAt || last.completionConfirmedAt)
        ? createNetworkSettingsScope({
            userId,
            title: liveTitle,
            returnTo: stored.returnTo,
            origin: stored.origin,
            scope: { ...stored.scope, initialSection: nextSection } as NetworkSettingsEditorScope,
          })
        : null;
    requestNavigation(
      `/networks/${type}/settings/${nextSection}?${new URLSearchParams({ scope: fresh?.scopeId ?? scopeId })}`,
    );
  };
  const scope = parsed?.success
    ? ({ ...stored.scope, initialSection: parsed.data } as NetworkSettingsEditorScope)
    : null;
  return (
    <NetworkSettingsOverview
      api={api}
      stored={stored}
      section={scope?.initialSection}
      onSectionChange={openSection}
    >
      {scope ? (
        <NetworkSettingsPage
          key={`${identity}:${scope.initialSection}:${operationId ?? ''}`}
          api={api}
          userId={userId}
          scopeId={scopeId}
          scope={scope}
          title={recovered.kind === 'resume' ? stored.title : liveTitle}
          retryOfOperationId={stored.retryOfOperationId}
          returnTo={stored.returnTo}
          resumeOperationId={recovered.kind === 'resume' ? recovered.operationId : undefined}
          onOpenLegacySites={() => openSection('stopWords')}
          onClose={() => requestNavigation(hubPath, { replace: true })}
        />
      ) : null}
    </NetworkSettingsOverview>
  );
}
