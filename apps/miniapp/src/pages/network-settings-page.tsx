import { describeUserFacingError } from '../lib/user-facing-error';
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import type { NetworkSettingsOperationResponse } from '@maxim/contracts/network-settings';
import type { ApiTransport } from '../lib/api/transport';
import {
  useNetworkSettingsController,
  carryNetworkSettingsRetryDraft,
} from '../features/network-settings/network-settings-controller';
import { createNetworkSettingsFieldAdapter } from '../features/network-settings/network-settings-field-bindings';
import type {
  ChatSettingsFieldValues,
  ChannelSettingsFieldValues,
} from '../features/network-settings/field-model';
import {
  createNetworkSettingsScope,
  readNetworkSettingsScope,
  type NetworkSettingsEditorScope,
  type NetworkChannelSettingsSection,
} from '../lib/network-settings-workspace-state';
import {
  useManagedEntityLeaveGuard,
  useManagedEntityNavigation,
} from '../lib/managed-entity-navigation';
import { recoverableLazyNamedComponent } from '../lib/recoverable-lazy';
import type { NetworkSettingsReviewProps } from '../features/network-settings/network-settings-review';
import type { NetworkSettingsOperationPanelProps } from '../features/network-settings/network-settings-operation-panel';
import { SettingsDrilldownPanel } from '../components/ui/settings-drilldown-panel';
import { SettingsSectionIcon } from '../components/ui/settings-section-toggle';
import { getNetworkSettingsSectionPresentation } from './settings/settings-workspace-sections';
import { isSupplementaryChatSettingsSection } from '../features/network-settings/field-paths';
import { NetworkScopeBadge, formatNetworkEntityCount } from '../features/networks/network-identity';
import { networkSettingsRetryCandidates } from '../features/network-settings/network-settings-retry';
import {
  listNetworkSettingsOperationReceipts,
  removeNetworkSettingsOperationReceipt,
} from '../lib/network-settings-operation-storage';
import '../styles/settings-drilldown-core.css';
import '../styles/settings-policy-controls.css';
import '../styles/settings-native-controls.css';
import '../styles/settings-link-allowlist.css';
import '../styles/settings-drilldown-polish.css';
import '../styles/settings-duration-editor.css';
import '../styles/settings-route-polish.css';
import '../styles/settings-interaction-polish.css';
import '../styles/settings-native-polish.css';
import '../styles/settings-experience.css';
import '../styles/channel-post-signature-entry.css';
import './network-settings-page.css';
export type { NetworkSettingsEditorScope, NetworkChannelSettingsSection };
export interface NetworkSettingsPageProps {
  api: ApiTransport;
  userId: string;
  scopeId: string;
  scope: NetworkSettingsEditorScope;
  title: string;
  returnTo: string;
  resumeOperationId?: string;
  retryOfOperationId?: string;
  onOperationChange?: (operation: NetworkSettingsOperationResponse | null) => void;
  onOpenLegacySites: () => void;
  onClose: () => void;
}
export type NetworkSettingsEditorProps = NetworkSettingsPageProps;
const SharedChatSettingsSection = lazy(() =>
  import('./settings/shared-chat-settings-section').then((module) => ({
    default: module.SharedChatSettingsSection,
  })),
);
const ChannelQuickButtonsFields = lazy(() =>
  import('./settings/channel-quick-buttons-fields').then((module) => ({
    default: module.ChannelQuickButtonsFields,
  })),
);
const ChannelCommentsFields = lazy(() =>
  import('./settings/channel-comments-fields').then((module) => ({
    default: module.ChannelCommentsFields,
  })),
);
const ChannelPostSuggestionsFields = lazy(() =>
  import('./settings/channel-post-suggestions-fields').then((module) => ({
    default: module.ChannelPostSuggestionsFields,
  })),
);
const SharedSupplementaryChatSettingsFields = lazy(() =>
  import('./settings/shared-supplementary-chat-settings-fields').then((module) => ({
    default: module.SharedSupplementaryChatSettingsFields,
  })),
);
const ChannelPostSignatureFields = lazy(async () => {
  const [module] = await Promise.all([
    import('./settings/channel-post-signature-fields'),
    import('../styles/channel-post-signature.css'),
  ]);
  return { default: module.ChannelPostSignatureFields };
});
const NetworkSettingsMetadataFields = lazy(() =>
  import('../features/network-settings/network-settings-metadata-fields').then((module) => ({
    default: module.NetworkSettingsMetadataFields,
  })),
);
const NetworkSettingsReview = recoverableLazyNamedComponent<NetworkSettingsReviewProps>(
  () => import('../features/network-settings/network-settings-review'),
  'NetworkSettingsReview',
);
const NetworkSettingsOperationPanel =
  recoverableLazyNamedComponent<NetworkSettingsOperationPanelProps>(
    () => import('../features/network-settings/network-settings-operation-panel'),
    'NetworkSettingsOperationPanel',
  );
export function NetworkSettingsPage(props: NetworkSettingsPageProps) {
  const controller = useNetworkSettingsController(props);
  const navigation = useManagedEntityNavigation();
  const [freshEditorError, setFreshEditorError] = useState<string | null>(null);
  const scope = props.scope;
  const section = scope.initialSection;
  const presentation = getNetworkSettingsSectionPresentation(scope.entityType, section);
  const resultVisible = Boolean(
    controller.operation &&
    (controller.operation.status !== 'PREPARED' ||
      props.resumeOperationId ||
      controller.receipt?.launchState !== 'unconfirmed'),
  );
  const reviewVisible = Boolean(controller.preview && !resultVisible);
  const stage = resultVisible
    ? 'result'
    : reviewVisible
      ? 'review'
      : controller.phase === 'preview'
        ? 'preparing'
        : 'editor';
  const stageHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (stage !== 'editor') stageHeading.current?.focus();
  }, [stage]);
  const binding = {
    entityType: scope.entityType,
    section,
    fields: controller.read?.fields ?? {},
    changes: controller.changes,
    errors: controller.errors,
    readOnly: controller.readOnly,
    onChanges: controller.setChanges,
    onError: controller.setFieldError,
  };
  const chatFields = createNetworkSettingsFieldAdapter<ChatSettingsFieldValues>(binding);
  const channelFields = createNetworkSettingsFieldAdapter<ChannelSettingsFieldValues>(binding);
  useManagedEntityLeaveGuard({
    dirty: controller.dirty,
    saving: controller.phase === 'apply',
    discardOnly: true,
    save: async () => false,
    discard: controller.discard,
  });
  const retry = () => {
    if (!controller.operation) return;
    const recipients = networkSettingsRetryCandidates(
      controller.failedRecipients,
      { ...controller.operation, userId: props.userId },
      listNetworkSettingsOperationReceipts(props.userId),
    );
    if (!recipients.length) return;
    const previous = readNetworkSettingsScope({
      userId: props.userId,
      scopeId: props.scopeId,
      entityType: scope.entityType,
    });
    const newScope = createNetworkSettingsScope({
      userId: props.userId,
      title: props.title,
      returnTo: props.returnTo,
      origin: previous?.origin,
      retryOfOperationId: controller.operation.operationId,
      scope: { ...scope, target: { mode: 'selected', entityIds: recipients.slice(0, 500) } },
    });
    carryNetworkSettingsRetryDraft(
      newScope.scopeId,
      controller.retryChanges,
      controller.navigationAllowlist,
    );
    navigation.requestNavigation(
      '/networks/' + scope.entityType + '/settings/' + section + '?scope=' + newScope.scopeId,
    );
  };
  const startAgain = async () => {
    if (!controller.canStartAgain) return;
    try {
      const previous = readNetworkSettingsScope({
        userId: props.userId,
        scopeId: props.scopeId,
        entityType: scope.entityType,
      });
      const unconfirmed = controller.operation?.status === 'PREPARED';
      if (unconfirmed && controller.operation)
        await removeNetworkSettingsOperationReceipt(props.userId, controller.operation.operationId);
      const fresh = createNetworkSettingsScope({
        userId: props.userId,
        title: props.title,
        returnTo: props.returnTo,
        origin: previous?.origin,
        retryOfOperationId: unconfirmed ? previous?.retryOfOperationId : undefined,
        scope,
      });
      if (!props.resumeOperationId && controller.operation?.status === 'PREPARED')
        carryNetworkSettingsRetryDraft(
          fresh.scopeId,
          controller.retryChanges,
          controller.navigationAllowlist,
        );
      setFreshEditorError(null);
      navigation.requestNavigation(
        '/networks/' + scope.entityType + '/settings/' + section + '?scope=' + fresh.scopeId,
      );
    } catch (cause) {
      setFreshEditorError(describeUserFacingError(cause, 'Не удалось открыть новые настройки.'));
    }
  };
  const recipientTitles = new Map(
    (controller.preview?.recipients ?? controller.read?.recipients ?? []).map((row) => [
      row.entityId,
      row.title,
    ]) ?? [],
  );
  const retryReceipts = listNetworkSettingsOperationReceipts(props.userId).filter(
    (receipt) => receipt.retryOfOperationId === controller.operation?.operationId,
  );
  const retryRecipients = controller.operation
    ? networkSettingsRetryCandidates(
        controller.failedRecipients,
        { ...controller.operation, userId: props.userId },
        listNetworkSettingsOperationReceipts(props.userId),
      )
    : [];
  const footer = (
    <>
      <div className="settings-drilldown__footer-actions is-single-action">
        {resultVisible ? (
          <button type="button" className="button button--accent" onClick={props.onClose}>
            {controller.operation?.status === 'COMPLETE' ? 'Готово' : 'К настройкам сетки'}
          </button>
        ) : reviewVisible && controller.canStartAgain ? (
          <button type="button" className="button button--accent" onClick={startAgain}>
            Проверить заново
          </button>
        ) : controller.preview ? (
          <button
            type="button"
            className="button button--accent"
            disabled={!controller.canApply || controller.phase !== 'idle'}
            aria-busy={controller.phase === 'apply' || undefined}
            onClick={() => void controller.apply()}
          >
            Применить ·{' '}
            {formatNetworkEntityCount(controller.preview.recipients.length, scope.entityType)}
          </button>
        ) : (
          <button
            type="button"
            className="button button--accent"
            disabled={
              controller.readOnly ||
              (!controller.changes.length && !controller.navigationAllowlist) ||
              Object.keys(controller.errors).length > 0
            }
            aria-busy={controller.phase === 'preview' || undefined}
            onClick={() => void controller.prepare()}
          >
            Проверить изменения
          </button>
        )}
      </div>
      {reviewVisible && !controller.readOnly ? (
        <button type="button" className="button button--ghost" onClick={controller.editPreview}>
          Изменить
        </button>
      ) : null}
    </>
  );
  return (
    <SettingsDrilldownPanel
      id={'network-settings-' + scope.entityType + '-' + section}
      open
      title={presentation.title}
      icon={
        presentation.panelIcon === false ? undefined : (
          <SettingsSectionIcon name={presentation.icon} />
        )
      }
      tone={presentation.tone}
      variant={presentation.variant}
      overlayClassName={presentation.overlayClassName}
      className={presentation.panelClassName + ' network-settings-editor'}
      onClose={reviewVisible && !controller.readOnly ? controller.editPreview : props.onClose}
      confirmCloseWhen={false}
      footer={footer}
      keepFooterVisibleWhenKeyboardOpen
    >
      <div className="network-settings-editor__content" aria-busy={controller.phase !== 'idle'}>
        <NetworkScopeBadge
          title={props.title}
          entityType={scope.entityType}
          target={scope.target}
          count={
            controller.operation?.outcomes.length ??
            controller.preview?.recipients.length ??
            controller.read?.recipientCount
          }
        />
        {stage !== 'editor' ? (
          <h2 ref={stageHeading} tabIndex={-1} className="network-settings-stage-title">
            {stage === 'review'
              ? controller.canStartAgain
                ? 'Проверка устарела'
                : 'Применить изменения?'
              : stage === 'preparing'
                ? 'Проверяем изменения'
                : 'Результат применения'}
          </h2>
        ) : null}
        {controller.phase === 'loading' ? (
          <p className="network-settings-editor__status" role="status">
            Загружаем настройки: {controller.progress.loaded}
            {controller.progress.total ? ' из ' + controller.progress.total : ''}
          </p>
        ) : null}
        {controller.error ? (
          <div className="network-settings-page__error" role="alert">
            <p>
              {describeUserFacingError(
                new Error(controller.error),
                controller.read
                  ? 'Ответ не получен. Проверяем исходную операцию.'
                  : 'Не удалось загрузить настройки.',
              )}
            </p>
            {!controller.read ? (
              <button type="button" className="button button--ghost" onClick={controller.reload}>
                Загрузить заново
              </button>
            ) : null}
          </div>
        ) : null}
        {freshEditorError ? (
          <p className="network-settings-page__error" role="alert">
            {freshEditorError}
          </p>
        ) : null}
        {controller.read?.recipientCount === 0 ? (
          <p className="network-settings-editor__status">
            В выбранной категории пока нет сообществ.
          </p>
        ) : null}
        {stage === 'editor' && controller.read && controller.read.recipientCount > 0 ? (
          <Suspense fallback={<p role="status">Загружаем раздел…</p>}>
            {scope.entityType === 'chat' ? (
              <NetworkSettingsMetadataFields
                api={props.api}
                scopeId={props.scopeId}
                read={controller.read}
                fields={chatFields}
                navigationAllowlist={controller.navigationAllowlist}
                onNavigationAllowlist={controller.setNavigationAllowlist}
                onOpenLegacySites={props.onOpenLegacySites}
              >
                {(context) =>
                  isSupplementaryChatSettingsSection(scope.initialSection) ? (
                    <SharedSupplementaryChatSettingsFields
                      section={scope.initialSection}
                      fields={chatFields}
                      context={context}
                    />
                  ) : (
                    <SharedChatSettingsSection
                      section={scope.initialSection}
                      fields={chatFields}
                      context={context}
                    />
                  )
                }
              </NetworkSettingsMetadataFields>
            ) : section === 'quickButtons' ? (
              <ChannelQuickButtonsFields fields={channelFields} />
            ) : section === 'comments' || section === 'postSuggestions' ? (
              <div className="settings-section__collapse is-open">
                <div className="settings-section__collapse-inner">
                  {section === 'comments' ? (
                    <ChannelCommentsFields fields={channelFields} />
                  ) : (
                    <ChannelPostSuggestionsFields fields={channelFields} />
                  )}
                </div>
              </div>
            ) : (
              <div className="settings-section__collapse channel-post-signature is-open">
                <div className="settings-section__collapse-inner channel-post-signature__panel-body">
                  <ChannelPostSignatureFields fields={channelFields} />
                </div>
              </div>
            )}
          </Suspense>
        ) : null}
        {reviewVisible && (controller.changes.length > 0 || controller.navigationAllowlist) ? (
          <Suspense fallback={<p role="status">Загружаем список изменений…</p>}>
            <NetworkSettingsReview controller={controller} recipientTitles={recipientTitles} />
          </Suspense>
        ) : null}
        {controller.operation && resultVisible ? (
          <Suspense fallback={<p role="status">Загружаем результат операции…</p>}>
            <NetworkSettingsOperationPanel
              key={controller.operation.operationId}
              operation={controller.operation}
              controller={{ ...controller, failedRecipients: retryRecipients }}
              recipientTitles={recipientTitles}
              resumeOperationId={props.resumeOperationId}
              onStartAgain={startAgain}
              onRetry={retry}
            />
          </Suspense>
        ) : null}
        {resultVisible && retryReceipts.length ? (
          <details className="network-settings-details">
            <summary>Повторные применения · {retryReceipts.length}</summary>
            {retryReceipts.map((receipt) => (
              <button
                type="button"
                key={receipt.operationId}
                className="button button--ghost"
                onClick={() =>
                  navigation.requestNavigation(
                    `/networks/${receipt.entityType}/settings/${receipt.section}?${new URLSearchParams({ scope: receipt.scopeId, operation: receipt.operationId })}`,
                  )
                }
              >
                Открыть повтор · {receipt.recipientIds?.length ?? 0}
              </button>
            ))}
          </details>
        ) : null}
      </div>
    </SettingsDrilldownPanel>
  );
}
export { NetworkSettingsPage as NetworkSettingsEditor };
