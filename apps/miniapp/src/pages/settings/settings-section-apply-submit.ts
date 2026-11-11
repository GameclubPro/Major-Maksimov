import type {
  ApplySettingsTarget,
  ChatSettings,
  StopWordsState,
  StopWordsStorageStatus,
} from '@maxim/contracts/settings';
import type { ApiTransport } from '../../lib/api/transport';
import {
  applySettingsSectionToAll,
  patchSettingsSection,
} from '../../lib/api/chat-settings-client';
import { getStopWords } from '../../lib/api/stop-words-client';
import { SECTION_SETTING_KEYS, type ApplySectionKey } from '../settings-page-state';
import {
  saveStopWordsSettings,
  type StopWordsReplacementAuthorization,
} from './settings-save-coordinator';

export type SettingsApplySubmission = {
  sourceChatId: string;
  confirmedTargetChatIds?: string[];
  reviewedTargetTitles?: Readonly<Record<string, string>>;
  section: ApplySectionKey;
  sourceSettings: ChatSettings;
  target: ApplySettingsTarget;
  stopWordsStorageStatus?: StopWordsStorageStatus;
  stopWordsReplacement?: StopWordsReplacementAuthorization;
  isCurrentScope?: () => boolean;
};

export type SettingsApplySavedSource = {
  sourceChatId: string;
  section: ApplySectionKey;
  settings: ChatSettings;
  stopWordsReceipt?: StopWordsState;
};

export async function applySettingsSectionWithConfirmedSource(
  api: ApiTransport,
  {
    section,
    sourceChatId,
    sourceSettings,
    target,
    confirmedTargetChatIds,
    stopWordsStorageStatus,
    stopWordsReplacement,
    isCurrentScope,
  }: SettingsApplySubmission,
  onSourceSaved: (saved: SettingsApplySavedSource | null) => void,
) {
  if (!sourceChatId) {
    throw new Error('Чат не выбран');
  }

  onSourceSaved(null);
  const savedStopWords =
    section === 'stopWords' && sourceSettings.stopWordsPolicy
      ? await saveStopWordsSettings(api, {
          chatId: sourceChatId,
          draft: sourceSettings,
          storageStatus: stopWordsStorageStatus,
          replacement: stopWordsReplacement,
        })
      : null;
  const savedSourceSettings = savedStopWords
    ? {
        ...sourceSettings,
        stopWordsPolicy: savedStopWords.policy,
        stopWordsRevision: savedStopWords.revision,
      }
    : await patchSettingsSection(
        api,
        sourceChatId,
        section,
        sourceSettings,
        SECTION_SETTING_KEYS[section],
      );
  const savedSource = {
    sourceChatId,
    section,
    settings: savedSourceSettings,
    ...(savedStopWords ? { stopWordsReceipt: savedStopWords } : {}),
  };
  onSourceSaved(savedSource);
  if (isCurrentScope?.() === false) throw new Error('Чат изменился во время сохранения.');
  const needsSourceFence =
    section === 'reports' || (section === 'links' && savedSourceSettings.linkRulesPolicy != null);
  if (needsSourceFence && !savedSourceSettings.settingsRevision)
    throw new Error(
      'Не удалось подтвердить сохранённые настройки. Обновите экран перед применением.',
    );
  const result = await applySettingsSectionToAll(
    api,
    sourceChatId,
    section,
    target,
    savedStopWords?.revision,
    needsSourceFence
      ? {
          expectedSourceSettingsRevision: savedSourceSettings.settingsRevision!,
          ...(section === 'reports'
            ? { confirmedTargetChatIds: confirmedTargetChatIds ?? [] }
            : {}),
        }
      : undefined,
  );
  const refreshedSource =
    savedStopWords && isCurrentScope?.() !== false
      ? await refreshSavedStopWordsSource(api, savedSource)
      : savedSource;
  return {
    ...result,
    section,
    stopWordsReceipt: refreshedSource.stopWordsReceipt,
    sourceSettings: savedStopWords
      ? refreshedSource.settings
      : {
          ...savedSourceSettings,
          ...(result.sourceSettingsRevision
            ? { settingsRevision: result.sourceSettingsRevision }
            : {}),
        },
  };
}

export async function refreshSavedStopWordsSource(
  api: ApiTransport,
  savedSource: SettingsApplySavedSource,
): Promise<SettingsApplySavedSource> {
  try {
    const fresh = await getStopWords(api, savedSource.sourceChatId);
    return {
      ...savedSource,
      stopWordsReceipt: fresh,
      settings: {
        ...savedSource.settings,
        stopWordsPolicy: fresh.policy,
        stopWordsRevision: fresh.revision,
      },
    };
  } catch {
    // Preserve the last confirmed source snapshot on transport failure.
    return savedSource;
  }
}
