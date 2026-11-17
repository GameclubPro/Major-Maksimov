import { getNetworkSettingsSectionPresentation } from './settings-workspace-sections';
import type { DuplicatePhotoEffectivePolicy } from '@maxim/contracts/settings';
import { lazy, Suspense } from 'react';
import { GlassCard } from '../../components/ui/glass-card';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import {
  SettingsSectionIcon,
  SettingsSectionToggle,
} from '../../components/ui/settings-section-toggle';
import type { ApiTransport } from '../../lib/api/transport';
import type { BroadcastLinkButtonFieldErrors } from '../../lib/broadcast-link-buttons';
import type { DuplicateDetectionPreset } from '../settings-page.constants';
import type { FieldErrors } from './settings-page-helpers';
import type {
  SettingsMuteDurationProps,
  SettingsSectionEditorProps,
  SettingsSectionHintProps,
  SettingsSectionMutationProps,
  SettingsSectionShellProps,
} from './settings-section-shared';

export type SettingsDuplicatesSectionProps = SettingsSectionShellProps &
  SettingsMuteDurationProps &
  Pick<
    SettingsSectionEditorProps,
    | 'botSpeechEditorProps'
    | 'botSpeechPreviewContext'
    | 'openBotEditorKey'
    | 'setOpenBotEditorKey'
    | 'toggleBotMessageEditor'
  > &
  Pick<SettingsSectionHintProps, 'openHintKey' | 'toggleHint'> &
  Pick<
    SettingsSectionMutationProps,
    | 'draft'
    | 'setFieldValue'
    | 'clearButtonGroupErrors'
    | 'updateDraftButtonGroup'
    | 'renderAdminContactToggle'
  > & {
    api: ApiTransport;
    chatId: string;
    userId: string | null;
    adjustDuplicateAllowedCount: (currentValue: number, delta: number) => void;
    applyDuplicateDetectionPreset: (preset: DuplicateDetectionPreset) => void;
    applyDuplicateFlowConfig: (overrides: {
      allowedCount?: number;
      windowSec?: number;
      duplicateBotMessageEnabled?: boolean;
      duplicateWarnEnabled?: boolean;
      duplicateMuteEnabled?: boolean;
      duplicateBanEnabled?: boolean;
    }) => void;
    duplicateAllowedCount: number;
    duplicateBotButtonErrors: BroadcastLinkButtonFieldErrors[];
    duplicatePhotoModerationPolicy: DuplicatePhotoEffectivePolicy;
    duplicateMessageModerationMode?: 'OFF' | 'OBSERVE' | 'DELETE_ONLY' | 'FULL';
    duplicateSharedWindowHours: number;
    duplicateWindowInputValue: string | null;
    duplicatesHeaderSummary: string;
    fieldErrors: FieldErrors;
    handleDuplicateWindowHoursBlur: () => void;
    handleDuplicateWindowHoursChange: (rawValue: string) => void;
    hasDuplicateBotButtonError: boolean;
  };

const LazySettingsDuplicateDiagnostics = lazy(() => import('./settings-duplicate-diagnostics'));
const SECTION_PRESENTATION = getNetworkSettingsSectionPresentation('chat', 'duplicates');

export function SettingsDuplicatesSection(props: SettingsDuplicatesSectionProps) {
  const { draft, expanded, duplicatesHeaderSummary, toggleSection } = props;
  return (
    <GlassCard
      className="settings-section settings-home-entry settings-home-entry--list stagger-in"
      style={{ animationDelay: '180ms', order: SECTION_PRESENTATION.order }}
      aria-label="Антидубль"
    >
      <div className="settings-section__head settings-section__head--interactive">
        <SettingsSectionToggle
          title={SECTION_PRESENTATION.title}
          enabled={draft.antiDuplicateEnabled}
          summary={duplicatesHeaderSummary}
          status={draft.antiDuplicateEnabled ? 'Вкл' : 'Выкл'}
          icon={SECTION_PRESENTATION.icon}
          tone={SECTION_PRESENTATION.tone}
          open={expanded}
          controls="settings-duplicates-content"
          onClick={() => toggleSection('duplicates')}
        />
      </div>
      <SettingsDrilldownPanel
        id="settings-duplicates-content"
        icon={<SettingsSectionIcon name={SECTION_PRESENTATION.icon} />}
        open={expanded}
        title={SECTION_PRESENTATION.title}
        summary={duplicatesHeaderSummary}
        tone={SECTION_PRESENTATION.tone}
        className={SECTION_PRESENTATION.panelClassName}
        onClose={() => toggleSection('duplicates')}
        confirmCloseWhen={props.isSectionDirty('duplicates')}
        onDiscardChanges={() => props.discardSectionChanges('duplicates')}
        footer={props.renderSectionSaveFooter('duplicates')}
      >
        {expanded ? (
          <>
            <Suspense fallback={<p role="status">Загружаем состояние бота</p>}>
              <LazySettingsDuplicateDiagnostics
                key={`${props.userId}:${props.chatId}`}
                api={props.api}
                chatId={props.chatId}
                userId={props.userId}
              />
            </Suspense>
            {props.sharedContent}
          </>
        ) : null}
      </SettingsDrilldownPanel>
    </GlassCard>
  );
}
