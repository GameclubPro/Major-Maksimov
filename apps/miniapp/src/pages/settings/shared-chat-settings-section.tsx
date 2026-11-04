import { Suspense, type ReactNode } from 'react';
import type { ApplySectionKey } from '../settings-page-state';
import type { ApiTransport } from '../../lib/api/transport';
import type {
  ChatScalarFieldPath,
  ChatSettingsFieldAdapter,
} from '../../features/network-settings/field-model';
import { recoverableLazyNamedComponent } from '../../lib/recoverable-lazy';
import { Spinner } from '../../components/ui/spinner';
import type {
  DuplicatePhotoEffectivePolicy,
  StopWordsStorageStatus,
} from '@maxim/contracts/settings';
import type { CommercialSettingsScope } from './commercial-policy-model';
import type { StopWordsFocusRequest } from './stop-words-settings-feedback';

export type SharedChatSettingsContext = {
  mode: 'single' | 'network';
  hasPublishedRules?: boolean;
  api: ApiTransport;
  sectionTools?: Partial<Record<ApplySectionKey, ReactNode>>;
  stopWordsTools?: Partial<Record<'toolbar' | 'notice' | 'preview' | 'imageScan', ReactNode>>;
  stopWordsEditor?: {
    storageStatus?: StopWordsStorageStatus;
    replacementAuthorized: boolean;
    onAuthorizeReplacement: () => void;
    focusRequest?: StopWordsFocusRequest;
    moduleError?: string | null;
  };
  navigationAllowlist?: ReactNode;
  requiredSubscriptionSources?: ReactNode;
  renderAdminContact?: (input: {
    enabledPath: ChatScalarFieldPath;
    urlPath: ChatScalarFieldPath;
    label: string;
    ariaLabel?: string;
    presentation?: 'rules';
  }) => ReactNode;
  runtimeNotes?: Partial<Record<ApplySectionKey, ReactNode>>;
  invitationActivationAvailable?: boolean;
  reportsActivationAvailable?: boolean;
  commercialScope?: CommercialSettingsScope;
  commercialAiModerationMode?: 'OFF' | 'OBSERVE' | 'DELETE_ONLY';
  limitsRuntime?: {
    deleteSpammersStatus: string;
    enforcementMode?: string;
  };
  duplicatePresentation?: {
    messageMode: 'OFF' | 'OBSERVE' | 'DELETE_ONLY' | 'FULL';
    photoPolicy: DuplicatePhotoEffectivePolicy;
  };
};

export type SharedChatSettingsSectionProps = {
  section: ApplySectionKey;
  fields: ChatSettingsFieldAdapter;
  context: SharedChatSettingsContext;
};

const LazySharedChatSettingsFields = recoverableLazyNamedComponent<SharedChatSettingsSectionProps>(
  () => import('./shared-chat-settings-fields'),
  'SharedChatSettingsFields',
);

export function SharedChatSettingsSection(props: SharedChatSettingsSectionProps) {
  return (
    <Suspense fallback={<Spinner label="Загружаем настройки" />}>
      <LazySharedChatSettingsFields {...props} />
    </Suspense>
  );
}
