import type {
  ChatSettings,
  StopWordsState,
  StopWordsStorageStatus,
} from '@maxim/contracts/settings';
import { updateSettings } from '../../lib/api/chat-settings-client';
import { updateStopWords } from '../../lib/api/stop-words-client';
import { ApiRequestError } from '../../lib/api-request-error';
import type { ApiTransport } from '../../lib/api/transport';

export type StopWordsReplacementAuthorization = Readonly<{
  chatId: string;
  expectedRevision: number;
}>;
export type StopWordsWriteContext = {
  chatId: string;
  draft: ChatSettings;
  storageStatus?: StopWordsStorageStatus;
  replacement?: StopWordsReplacementAuthorization;
};
export type SettingsSaveProgress =
  | { kind: 'ordinary'; submitted: ChatSettings; saved: ChatSettings }
  | { kind: 'stopWords'; submitted: ChatSettings; saved: StopWordsState };

const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const independentKeys = new Set([
  'settingsRevision',
  'linkRulesLegacySnapshot',
  'linkRulesStorageStatus',
  'stopWordsPolicy',
  'stopWordsRevision',
  'messageLimitsBlockedWords',
  'messageLimitsBlockedDomains',
  'messageLimitsImageTextScanEnabled',
]);

export function hasOrdinarySettingsChanges(draft: ChatSettings, baseline: ChatSettings) {
  return Object.keys(draft).some(
    (key) =>
      !independentKeys.has(key) &&
      !equal(draft[key as keyof ChatSettings], baseline[key as keyof ChatSettings]),
  );
}

export async function saveStopWordsSettings(api: ApiTransport, input: StopWordsWriteContext) {
  const expectedRevision = input.draft.stopWordsRevision ?? 0;
  const replacement =
    input.replacement?.chatId === input.chatId &&
    input.replacement.expectedRevision === expectedRevision;
  if (input.storageStatus === 'invalid' && !replacement)
    throw new ApiRequestError(
      409,
      JSON.stringify({ code: 'STOP_WORDS_POLICY_REVIEW_REQUIRED', revision: expectedRevision }),
      'Проверьте сохранённый список перед заменой.',
    );
  if (!input.draft.stopWordsPolicy) throw new Error('Не удалось подготовить список стоп-слов.');
  return updateStopWords(
    api,
    input.chatId,
    input.draft.stopWordsPolicy,
    expectedRevision,
    replacement ? { replaceInvalidStorage: true } : undefined,
  );
}

export async function saveWorkspaceSettings(
  api: ApiTransport,
  input: StopWordsWriteContext & { baseline: ChatSettings },
  onProgress: (event: SettingsSaveProgress) => void | Promise<void>,
): Promise<{ ordinary?: ChatSettings; stopWords?: StopWordsState }> {
  // FLAG: An ordinary receipt never authorizes rebasing the independent stop-word CAS.
  const submitted = structuredClone(input.draft);
  const stopWordsChanged =
    !equal(submitted.stopWordsPolicy, input.baseline.stopWordsPolicy) ||
    (input.storageStatus === 'invalid' && Boolean(input.replacement));
  if (
    stopWordsChanged &&
    input.storageStatus === 'invalid' &&
    (input.replacement?.chatId !== input.chatId ||
      input.replacement.expectedRevision !== (submitted.stopWordsRevision ?? 0))
  )
    throw new ApiRequestError(
      409,
      JSON.stringify({ code: 'STOP_WORDS_POLICY_REVIEW_REQUIRED' }),
      'Проверьте сохранённый список перед заменой.',
    );
  const result: { ordinary?: ChatSettings; stopWords?: StopWordsState } = {};
  if (hasOrdinarySettingsChanges(submitted, input.baseline)) {
    result.ordinary = await updateSettings(api, input.chatId, submitted);
    await onProgress({ kind: 'ordinary', submitted, saved: result.ordinary });
  }
  if (stopWordsChanged) {
    result.stopWords = await saveStopWordsSettings(api, { ...input, draft: submitted });
    await onProgress({ kind: 'stopWords', submitted, saved: result.stopWords });
  }
  return result;
}

export function mergeConfirmedStopWordsReceipt({
  current,
  submitted,
  receipt,
}: {
  current: ChatSettings;
  submitted: ChatSettings;
  receipt: StopWordsState;
}): ChatSettings {
  if ((current.stopWordsRevision ?? 0) > receipt.revision) return current;
  return {
    ...current,
    stopWordsPolicy: equal(current.stopWordsPolicy, submitted.stopWordsPolicy)
      ? receipt.policy
      : current.stopWordsPolicy,
    stopWordsRevision: receipt.revision,
  };
}

export function rebaseSettingsAfterStopWordsSave({
  current,
  baseline,
  fresh,
  receipt,
}: {
  current: ChatSettings;
  baseline: ChatSettings;
  fresh: ChatSettings;
  submitted?: ChatSettings;
  receipt: StopWordsState;
}): ChatSettings {
  const receiptRevision = Date.parse(receipt.settingsRevision ?? '');
  const freshRevision = Date.parse(fresh.settingsRevision ?? '');
  if (
    !Number.isFinite(receiptRevision) ||
    !Number.isFinite(freshRevision) ||
    freshRevision < receiptRevision
  )
    return current;
  const comparison = {
    ...baseline,
    stopWordsPolicy: receipt.policy,
    stopWordsRevision: receipt.revision,
  };
  const next = { ...fresh };
  const record = next as Record<keyof ChatSettings, unknown>;
  let conflict = current.settingsRevision !== baseline.settingsRevision;
  for (const key of Object.keys(current) as Array<keyof ChatSettings>) {
    if (key === 'settingsRevision' || key === 'botSpeechMedia') continue;
    if (equal(current[key], comparison[key])) continue;
    record[key] = current[key];
    if (!equal(fresh[key], comparison[key]) && !equal(fresh[key], current[key])) conflict = true;
  }
  next.botSpeechMedia = { ...fresh.botSpeechMedia };
  for (const key of new Set([
    ...Object.keys(baseline.botSpeechMedia),
    ...Object.keys(current.botSpeechMedia),
  ]) as Set<keyof ChatSettings['botSpeechMedia']>) {
    if (equal(current.botSpeechMedia[key], baseline.botSpeechMedia[key])) continue;
    const media = current.botSpeechMedia[key];
    if (media) next.botSpeechMedia[key] = media;
    else delete next.botSpeechMedia[key];
    if (
      !equal(fresh.botSpeechMedia[key], baseline.botSpeechMedia[key]) &&
      !equal(fresh.botSpeechMedia[key], media)
    )
      conflict = true;
  }
  if (!equal(current.stopWordsPolicy, receipt.policy))
    next.stopWordsRevision = current.stopWordsRevision;
  // FLAG: A partial stop-word receipt cannot bless overlapping edits in another section.
  if (conflict) next.settingsRevision = current.settingsRevision;
  return next;
}
