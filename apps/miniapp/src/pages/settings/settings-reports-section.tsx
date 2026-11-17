import { getNetworkSettingsSectionPresentation } from './settings-workspace-sections';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { createChatSettingsFieldAdapter } from '../../features/network-settings/settings-field-bindings';
import { ReportsSettingsFields } from './reports-settings-fields';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import {
  SettingsSectionIcon,
  SettingsSectionToggle,
} from '../../components/ui/settings-section-toggle';
import type { ApiTransport } from '../../lib/api/transport';
import type {
  SettingsSectionMutationProps,
  SettingsSectionShellProps,
} from './settings-section-shared';
import type { FieldErrors } from './settings-page-helpers';
import './settings-reports.css';

export type SettingsReportsSectionProps = SettingsSectionShellProps &
  Pick<SettingsSectionMutationProps, 'draft' | 'setFieldValue'> & {
    api: ApiTransport;
    chatId: string;
    fieldErrors: FieldErrors;
    reportsAvailable: boolean;
    persistedReportsEnabled: boolean;
    reportsAvailabilityLoading?: boolean;
  };

const SECTION_PRESENTATION = getNetworkSettingsSectionPresentation('chat', 'reports');

export function SettingsReportsSection(props: SettingsReportsSectionProps) {
  const { draft, setFieldValue, expanded } = props;
  const [tab, setTab] = useState<'settings' | 'journal'>('settings');
  const paneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (
      expanded &&
      tab === 'settings' &&
      Object.keys(props.fieldErrors).some((key) => key.startsWith('reports'))
    )
      paneRef.current
        ?.querySelector<HTMLElement>('[aria-invalid="true"]:not(.reports-threshold-input)')
        ?.focus();
  }, [props.fieldErrors, expanded, tab]);
  const reportsFields = createChatSettingsFieldAdapter({
    settings: draft,
    errors: props.fieldErrors,
    onChange: (next) => {
      for (const path of [
        'reportsEnabled',
        'reportsThreshold',
        'reportsDeleteMode',
        'reportsMuteEnabled',
        'reportsMuteDurationHours',
        'reportsAliases',
      ] as const) {
        if (JSON.stringify(next[path]) !== JSON.stringify(draft[path]))
          setFieldValue(path, next[path]);
      }
    },
  });
  return (
    <section
      className="settings-section settings-home-entry settings-home-entry--list"
      style={{ order: SECTION_PRESENTATION.order }}
      aria-label="Система жалоб"
    >
      <div className="settings-section__head settings-section__head--interactive">
        <SettingsSectionToggle
          title={SECTION_PRESENTATION.title}
          enabled={draft.reportsEnabled}
          paused={draft.reportsEnabled && !props.reportsAvailable}
          summary={draft.reportsEnabled ? `Порог: ${draft.reportsThreshold}` : ''}
          status={
            draft.reportsEnabled ? (props.reportsAvailable ? 'Вкл' : 'Приостановлен') : 'Выкл'
          }
          icon={SECTION_PRESENTATION.icon}
          tone={SECTION_PRESENTATION.tone}
          open={expanded}
          controls="settings-reports-content"
          onClick={() => props.toggleSection('reports')}
        />
      </div>
      <SettingsDrilldownPanel
        id="settings-reports-content"
        icon={<SettingsSectionIcon name={SECTION_PRESENTATION.icon} />}
        open={expanded}
        title={SECTION_PRESENTATION.title}
        tone={SECTION_PRESENTATION.tone}
        className={SECTION_PRESENTATION.panelClassName}
        onClose={() => props.toggleSection('reports')}
        confirmCloseWhen={props.isSectionDirty('reports')}
        onDiscardChanges={() => props.discardSectionChanges('reports')}
        footer={tab === 'settings' ? props.renderSectionSaveFooter('reports') : null}
      >
        {expanded && (
          <div className="reports-settings">
            <div
              className="reports-tabs"
              role="tablist"
              aria-label="Система жалоб"
              onKeyDown={(event) => {
                if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const next =
                  event.key === 'Home'
                    ? 'settings'
                    : event.key === 'End'
                      ? 'journal'
                      : tab === 'settings'
                        ? 'journal'
                        : 'settings';
                setTab(next);
                const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button');
                buttons[next === 'settings' ? 0 : 1]?.focus();
              }}
            >
              <button
                type="button"
                role="tab"
                id="reports-settings-tab"
                aria-controls="reports-settings-pane"
                aria-selected={tab === 'settings'}
                tabIndex={tab === 'settings' ? 0 : -1}
                onClick={() => setTab('settings')}
              >
                Настройки
              </button>
              <button
                type="button"
                role="tab"
                id="reports-journal-tab"
                aria-controls="reports-journal-pane"
                aria-selected={tab === 'journal'}
                tabIndex={tab === 'journal' ? 0 : -1}
                onClick={() => setTab('journal')}
              >
                Журнал
              </button>
            </div>
            {tab === 'journal' ? (
              <ReportJournal api={props.api} chatId={props.chatId} />
            ) : (
              <div
                ref={paneRef}
                role="tabpanel"
                id="reports-settings-pane"
                aria-labelledby="reports-settings-tab"
              >
                {props.sharedContent ?? (
                  <ReportsSettingsFields
                    fields={reportsFields}
                    activationAvailable={props.reportsAvailable || props.persistedReportsEnabled}
                    availabilityNote={
                      !props.reportsAvailable ? (
                        <p className="reports-availability" role="status">
                          {props.reportsAvailabilityLoading
                            ? 'Проверяем приём жалоб…'
                            : 'Приём жалоб приостановлен оператором.'}
                        </p>
                      ) : null
                    }
                  />
                )}
              </div>
            )}
          </div>
        )}
      </SettingsDrilldownPanel>
    </section>
  );
}

const LazyReportJournal = lazy(() =>
  import('./settings-reports-journal').then((module) => ({ default: module.ReportJournal })),
);

export function ReportJournal(props: { api: ApiTransport; chatId: string }) {
  return (
    <Suspense
      fallback={
        <div
          className="reports-journal"
          role="tabpanel"
          id="reports-journal-pane"
          aria-labelledby="reports-journal-tab"
        >
          <p role="status">Загружаем журнал…</p>
          <div className="reports-journal__loading" aria-hidden="true">
            <span />
            <span />
          </div>
        </div>
      }
    >
      <LazyReportJournal {...props} />
    </Suspense>
  );
}
