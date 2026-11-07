import { getNetworkSettingsSectionPresentation } from './settings-workspace-sections';
import { type Dispatch, type SetStateAction } from 'react';
import { GlassCard } from '../../components/ui/glass-card';
import { SettingsDrilldownPanel } from '../../components/ui/settings-drilldown-panel';
import {
  SettingsSectionIcon,
  SettingsSectionToggle,
} from '../../components/ui/settings-section-toggle';
import { cn } from '../../lib/cn';
import type { ApiTransport } from '../../lib/api/transport';
import type {
  SettingsSectionEditorProps,
  SettingsSectionMutationProps,
  SettingsSectionShellProps,
} from './settings-section-shared';

export type SettingsStopWordsSectionProps = SettingsSectionShellProps &
  Pick<SettingsSectionEditorProps, 'botSpeechPreviewContext'> &
  Pick<SettingsSectionMutationProps, 'draft' | 'setFieldValue' | 'clearFieldError'> & {
    api: ApiTransport;
    chatId: string;
    busy: boolean;
    reloadPolicy: () => Promise<void>;
    messageLimitsBlockedWordsInput: string;
    messageLimitsBlockedDomainsInput: string;
    messageLimitsBlockedWordsError?: string;
    messageLimitsBlockedDomainsError?: string;
    stopWordsError?: string;
    storageInvalid?: boolean;
    setMessageLimitsBlockedWordsInput: Dispatch<SetStateAction<string>>;
    setMessageLimitsBlockedDomainsInput: Dispatch<SetStateAction<string>>;
  };

export type SettingsStopWordsEditorProps = SettingsStopWordsSectionProps & {
  mode: 'words' | 'domains';
  onModeChange: (mode: 'words' | 'domains') => void;
};

const SECTION_PRESENTATION = getNetworkSettingsSectionPresentation('chat', 'stopWords');

export function SettingsStopWordsSection(props: SettingsStopWordsSectionProps) {
  const {
    discardSectionChanges,
    expanded,
    isSectionDirty,
    renderApplyTargetHeaderAction,
    renderSectionSaveFooter,
    toggleSection,
  } = props;
  const policy = props.draft.stopWordsPolicy;
  const count = policy ? policy.rules.filter((rule) => rule.enabled).length : 0;
  const stopWordsCardStatus =
    !policy || props.storageInvalid ? 'Проверить' : policy.enabled ? String(count) : 'Выкл';
  const stopWordsHeaderSummary =
    !policy || props.storageInvalid
      ? 'Требуется проверка списка'
      : policy.enabled
        ? `Активно: ${count}`
        : 'Выключено';

  return (
    <GlassCard
      className="settings-section settings-home-entry settings-home-entry--list stagger-in"
      style={{ animationDelay: '214ms', order: SECTION_PRESENTATION.order }}
      aria-label="Стоп-слова"
    >
      <div className={cn('settings-section__head', 'settings-section__head--interactive')}>
        <SettingsSectionToggle
          title={SECTION_PRESENTATION.title}
          enabled={policy?.enabled}
          summary={stopWordsHeaderSummary}
          status={stopWordsCardStatus}
          icon={SECTION_PRESENTATION.icon}
          tone={SECTION_PRESENTATION.tone}
          open={expanded}
          controls="settings-stop-words-content"
          onClick={() => toggleSection('stopWords')}
        />
      </div>

      <SettingsDrilldownPanel
        id="settings-stop-words-content"
        icon={<SettingsSectionIcon name={SECTION_PRESENTATION.icon} />}
        open={expanded}
        title={SECTION_PRESENTATION.title}
        summary={stopWordsHeaderSummary}
        tone={SECTION_PRESENTATION.tone}
        className={SECTION_PRESENTATION.panelClassName}
        onClose={() => toggleSection('stopWords')}
        headerAction={renderApplyTargetHeaderAction('stopWords')}
        confirmCloseWhen={isSectionDirty('stopWords')}
        onDiscardChanges={() => discardSectionChanges('stopWords')}
        footer={renderSectionSaveFooter('stopWords')}
      >
        {expanded ? props.sharedContent : null}
      </SettingsDrilldownPanel>
    </GlassCard>
  );
}
