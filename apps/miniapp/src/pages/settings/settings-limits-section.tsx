import { getNetworkSettingsSectionPresentation } from './settings-workspace-sections';
import { Suspense } from 'react';
import { GlassCard } from '../../components/ui/glass-card';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import {
  SettingsSectionIcon,
  SettingsSectionToggle,
} from '../../components/ui/settings-section-toggle';
import { Spinner } from '../../components/ui/spinner';
import type { ApiTransport } from '../../lib/api/transport';
import type { BroadcastLinkButtonFieldErrors } from '../../lib/broadcast-link-buttons';
import { cn } from '../../lib/cn';
import { recoverableLazyNamedComponent } from '../../lib/recoverable-lazy';
import type { FieldErrors } from './settings-page-helpers';
import type {
  SettingsSectionEditorProps,
  SettingsSectionHintProps,
  SettingsSectionMutationProps,
  SettingsSectionShellProps,
} from './settings-section-shared';

export type SettingsLimitsSectionProps = SettingsSectionShellProps &
  Pick<
    SettingsSectionEditorProps,
    | 'botSpeechEditorProps'
    | 'botSpeechPreviewContext'
    | 'openBotEditorKey'
    | 'setOpenBotEditorKey'
    | 'toggleBotMessageEditor'
  > &
  SettingsSectionHintProps &
  Pick<
    SettingsSectionMutationProps,
    | 'draft'
    | 'setFieldValue'
    | 'clearButtonGroupErrors'
    | 'updateDraftButtonGroup'
    | 'renderAdminContactToggle'
    | 'renderMuteStageToggle'
  > & {
    api: ApiTransport;
    adjustStickerMessageCooldown: (deltaMinutes: number) => void;
    deleteSpammersRuntimeStatus: string;
    fieldErrors: FieldErrors;
    onMaxMessageLengthError: (message: string | null) => void;
    hasMessageLimitsBotButtonError: boolean;
    limitsCardStatus: string;
    limitsRulesEnabledCount: number;
    messageLimitsBotButtonErrors: BroadcastLinkButtonFieldErrors[];
    spammerReviewMetricsQuery: {
      data?: { enforcementMode?: string };
    };
  };

const LazySettingsLimitsEditor = recoverableLazyNamedComponent<SettingsLimitsSectionProps>(
  () => import('./settings-limits-editor'),
  'SettingsLimitsEditor',
);

const SECTION_PRESENTATION = getNetworkSettingsSectionPresentation('chat', 'limits');

export function SettingsLimitsSection(props: SettingsLimitsSectionProps) {
  const {
    discardSectionChanges,
    expanded,
    isSectionDirty,
    limitsCardStatus,
    limitsRulesEnabledCount,
    renderApplyTargetHeaderAction,
    renderSectionSaveFooter,
    toggleSection,
  } = props;

  return (
    <GlassCard
      className="settings-section settings-home-entry settings-home-entry--priority stagger-in"
      style={{ animationDelay: '225ms', order: SECTION_PRESENTATION.order }}
      aria-label="Ограничения"
    >
      <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
        <SettingsSectionToggle
          title={SECTION_PRESENTATION.title}
          enabled={limitsRulesEnabledCount > 0}
          summary={`Активных ограничений: ${limitsRulesEnabledCount}`}
          status={limitsCardStatus}
          icon={SECTION_PRESENTATION.icon}
          tone={SECTION_PRESENTATION.tone}
          open={expanded}
          controls="settings-limits-content"
          onClick={() => toggleSection('limits')}
        />
      </div>

      <SettingsDrilldownPanel
        id="settings-limits-content"
        icon={<SettingsSectionIcon name={SECTION_PRESENTATION.icon} />}
        open={expanded}
        title={SECTION_PRESENTATION.title}
        summary={`Активных ограничений: ${limitsRulesEnabledCount}`}
        tone={SECTION_PRESENTATION.tone}
        className={SECTION_PRESENTATION.panelClassName}
        onClose={() => toggleSection('limits')}
        headerAction={renderApplyTargetHeaderAction('limits')}
        confirmCloseWhen={isSectionDirty('limits')}
        onDiscardChanges={() => discardSectionChanges('limits')}
        footer={renderSectionSaveFooter('limits')}
      >
        {props.sharedContent ? (
          <>{expanded ? <>{props.sharedContent}</> : null}</>
        ) : (
          <>
            <div
              id="settings-limits-content"
              className={cn('settings-section__collapse', expanded && 'is-open')}
            >
              {expanded ? (
                <Suspense fallback={<Spinner label="Загружаем ограничения" />}>
                  <LazySettingsLimitsEditor {...props} />
                </Suspense>
              ) : null}
            </div>
          </>
        )}
      </SettingsDrilldownPanel>
    </GlassCard>
  );
}
