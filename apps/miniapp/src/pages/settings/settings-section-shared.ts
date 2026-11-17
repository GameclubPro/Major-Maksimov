import type { BroadcastLinkButton } from '@maxim/contracts/broadcast';
import type { ChatSettings } from '@maxim/contracts/settings';
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { ApplySectionKey } from '../settings-page-state';
import type {
  AdminContactButtonGroup,
  AutoMuteDurationKey,
  AutoMuteEnabledKey,
  BotMessageEditorKey,
  BotMessageEditorProps,
  ChatSettingsButtonGroup,
  HintKey,
  SettingsSectionKey,
  WarnMessageEditorKey,
} from './settings-page-helpers';

export type SetChatSettingsField = <K extends keyof ChatSettings>(
  key: K,
  value: ChatSettings[K],
) => void;

export type SettingsSectionShellProps = {
  sharedContent?: ReactNode;
  expanded: boolean;
  toggleSection: (section: SettingsSectionKey) => void;
  isSectionDirty: (section: ApplySectionKey) => boolean;
  discardSectionChanges: (section: ApplySectionKey) => void;
  renderSectionSaveFooter: (
    section: ApplySectionKey,
    options?: { note?: string | null; saveLabel?: string },
  ) => ReactNode;
};

export type SettingsSectionEditorProps = {
  botSpeechEditorProps: Pick<BotMessageEditorProps, 'settings' | 'onImageChange'>;
  botSpeechPreviewContext: BotMessageEditorProps['botSpeechPreviewContext'];
  openBotEditorKey: BotMessageEditorKey | null;
  openWarnEditorKey: WarnMessageEditorKey | null;
  setOpenBotEditorKey: Dispatch<SetStateAction<BotMessageEditorKey | null>>;
  setOpenWarnEditorKey: Dispatch<SetStateAction<WarnMessageEditorKey | null>>;
  toggleBotMessageEditor: (key: BotMessageEditorKey) => void;
  toggleWarnMessageEditor: (key: WarnMessageEditorKey) => void;
};

export type SettingsSectionHintProps = {
  openHintKey: HintKey | null;
  toggleHint: (key: HintKey) => void;
  renderInlineHint: (hintKey: HintKey, hintId: string, text: string, hidden?: boolean) => ReactNode;
};

export type SettingsSectionMutationProps = {
  draft: ChatSettings;
  setDraft: Dispatch<SetStateAction<ChatSettings | null>>;
  setFieldValue: SetChatSettingsField;
  clearFieldError: (key: keyof ChatSettings) => void;
  clearButtonGroupErrors: (group: ChatSettingsButtonGroup) => void;
  updateDraftButtonGroup: (
    group: ChatSettingsButtonGroup,
    options: { buttons?: BroadcastLinkButton[]; enabled?: boolean },
  ) => void;
  renderAdminContactToggle: (group: AdminContactButtonGroup, ariaLabel?: string) => ReactNode;
  renderMuteStageToggle: (params: {
    enabledKey: AutoMuteEnabledKey;
    durationKey: AutoMuteDurationKey;
    title: string;
    onEnable: () => void;
  }) => ReactNode;
};

export type SettingsMuteDurationProps = {
  openMuteDurationKey: AutoMuteDurationKey | null;
  toggleMuteDurationEditor: (key: AutoMuteDurationKey) => void;
  renderMuteDurationEditor: (key: AutoMuteDurationKey, label: string) => ReactNode;
  formatMuteDurationCompact: (hours: number) => string;
};
