import {
  CHAT_SETTINGS_OVERVIEW_GROUPS,
  SettingsOverviewEntry,
  SettingsOverviewGroups,
} from '../components/ui/settings-overview-groups';
import { getNetworkSettingsSectionPresentation } from './settings/settings-workspace-sections';
import { readCommercialExceptionPrefill } from '../lib/commercial-ads-policy';
import { SharedChatSettingsSection } from './settings/shared-chat-settings-section';
import { Spinner } from '../components/ui/spinner';
import { createChatSettingsFieldAdapter } from '../features/network-settings/settings-field-bindings';
import { settingsSectionPaths } from '../features/network-settings/field-paths';
import { useHomeEntityFavorites } from '../lib/home-entity-favorites-context';
import { SettingsOverviewSearchPlaceholder } from '../components/ui/settings-overview-search-placeholder';
import { SettingsOverviewLoading } from '../components/ui/settings-overview-skeleton';
import { useSettingsRules } from './settings/use-settings-rules';
import { useSettingsDraft } from './settings/use-settings-draft';
import { useSettingsRequiredSubscription } from './settings/use-settings-required-subscription';
import { getStopWords } from '../lib/api/stop-words-client';
import { prepareStopWordsInput } from '../lib/stop-words-editor';
import {
  RequiredSubscriptionExternalSource,
  RequiredSubscriptionHelp,
  RequiredSubscriptionSourceDisclosure,
} from './settings/settings-required-subscription-ui';
import {
  MAX_CHAT_RULES_TEXT_LENGTH,
  DUPLICATE_WINDOW_MAX_SEC,
  REQUIRED_SUBSCRIPTION_MAX_CHANNELS,
  type SettingsApplyPartialError,
  updateSettingsRequestSchema,
  normalizeNavigationAllowlistTarget,
  normalizeStoredNavigationAllowlistEntry,
  stepDeleteBotMessagesDelayMinutes,
  type ChatSettings,
  type ChatSettingsScreenResponse,
  type DomainAllowlistEntry,
  type NavigationAllowlistKind,
} from '@maxim/contracts/settings';
import {
  type BroadcastLinkButton,
  type BroadcastTargetMode,
  type ManagedAutopostRuleDetails,
  type ManagedAutopostRuleSummary,
  type ManagedBroadcastDetails,
} from '@maxim/contracts/broadcast';
import { type ChatSummary, type ManagedEntityHeader } from '@maxim/contracts/managed-entities';
import {
  BOT_SPEECH_STYLE_METADATA,
  resolveBotSpeechStyle,
  type BotSpeechStyle,
} from '@maxim/contracts/bot-speech';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import '../styles/settings-drilldown-core.css';
import '../styles/settings-policy-controls.css';
import '../styles/settings-native-controls.css';
import '../styles/settings-home-compact.css';
import '../styles/settings-home-route-polish.css';
import '../styles/broadcast-studio-base.css';
import './settings/settings-rules-publication.css';
import '../styles/settings-link-allowlist.css';
import { useSettingsScreenQuery } from './settings/use-settings-screen-query';
import { formatTimezoneLabel } from '../lib/timezone-label';
import '../styles/settings-drilldown-polish.css';
import '../styles/settings-duration-editor.css';
import '../styles/settings-route-polish.css';
import '../styles/settings-interaction-polish.css';
import '../styles/managed-giveaway.css';
import '../styles/broadcast-studio.css';
import './settings-page.css';
import './settings/settings-duplicate-stage.css';
import './settings/settings-duplicate-photo.css';
import '../styles/broadcast-autopost-polish.css';
import '../styles/settings-tile-grid.css';
import '../styles/settings-native-polish.css';
import '../styles/settings-experience.css';
import {
  Suspense,
  lazy,
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
} from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import type { BroadcastSchedulePlannerSelectionState } from '../components/broadcast-schedule-planner';
import type { ManagedGiveawayCardHandle } from '../components/managed-giveaway-card';
import {
  BroadcastStudioHeader,
  type BroadcastStudioSignal,
} from '../components/broadcast-studio-header';
import {
  BroadcastHistoryFilterTabs,
  BroadcastWorkspaceChrome,
  countManagedBroadcastHistoryFilters,
  filterManagedBroadcastsByHistoryFilter,
  type BroadcastHistoryFilter,
} from '../components/broadcast-studio-workspace';
import { EntityAvatar } from '../components/ui/entity-avatar';
import { GlassCard } from '../components/ui/glass-card';
import { SegmentedControl } from '../components/ui/segmented-control';
import { ResetIcon } from '../components/ui/reset-icon';
import { SettingsDrilldownPanel } from '../components/ui/settings-drilldown-panel';
import {
  SettingsSectionIcon,
  SettingsSectionToggle,
} from '../components/ui/settings-section-toggle';
import { MarketplaceProfileCard } from '../components/marketplace-profile-card';
import type { MarketplaceButtonModule } from '@maxim/contracts/marketplace-integration';
const MarketplaceModuleToggle = lazy(() => import('../components/marketplace-module-toggle'));
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import {
  addDomain,
  cancelManagedBroadcast,
  clearBroadcastHandoffState,
  createBroadcastRequestId,
  deleteManagedAutopostRule,
  getBroadcastComposerClientResetState,
  getBroadcastHandoffState,
  getManagedAutopostRules,
  getManagedBroadcast,
  getManagedBroadcastCalendar,
  previewApplySettingsSectionTarget,
  removeDomain,
  recheckManagedEntityAccess,
  retryManagedBroadcast,
  scheduleDomainRemoval,
  sendBroadcast,
  sendBroadcastTest,
  updateManagedAutopostRule,
  updateManagedBroadcast,
  updateSettings,
  updateBotSpeechStyle,
} from '../lib/api/chat-settings-client';
import { buildBroadcastSendFeedback } from '../lib/broadcast-send-feedback';
import { getGlobalSpammerReviewMetrics } from '../lib/api/spammer-review-client';
import { getMe } from '../lib/api/me-client';
import type { ApiTransport } from '../lib/api/transport';
import type { BroadcastHandoffPayload, SendBroadcastPayload } from '../lib/api/shared-types';
import {
  buildBroadcastLinkButtonLegacyFields,
  createEmptyBroadcastLinkButton,
  formatBroadcastButtonsPreview,
  formatBroadcastButtonsStatus,
  hasBroadcastLinkButtonErrors,
  trimBroadcastLinkButtons,
  validateBroadcastLinkButtons,
  type BroadcastLinkButtonFieldErrors,
} from '../lib/broadcast-link-buttons';
import {
  buildManagedAutopostRuleFacts,
  normalizeManagedAutopostPayload,
  sortManagedAutopostRules,
} from '../lib/managed-autopost-ui';
import { useKeyboardOpen } from '../lib/use-keyboard-open';
import {
  createDefaultBroadcastCycleDraft,
  findBroadcastSlotConflicts,
  formatBroadcastCycleSummary,
  getBroadcastCycleValidationError,
  hasBroadcastHandoffDraft,
  normalizeBroadcastCycleDraft,
  resolveBroadcastHandoffLoadMode,
  resolveBroadcastHandoffSchedule,
  resolveBroadcastCycleSendAt,
  resolveBroadcastScheduleConflict,
  resolveBroadcastScheduleTimezone,
  sortAndUniqueBroadcastSlots,
  type BroadcastCycleDraft,
  type BroadcastTimingMode,
} from '../lib/broadcast-schedule';
import {
  clearBroadcastComposerDraft,
  hasAppliedBroadcastComposerReset,
  loadBroadcastComposerDraftAsync,
  markBroadcastComposerResetApplied,
  saveBroadcastComposerDraft,
  type BroadcastComposerDraft,
} from '../lib/broadcast-composer-draft';
import { buildChatBroadcastSystemButtons } from '../lib/broadcast-system-buttons';
import { cn } from '../lib/cn';
import {
  normalizeBroadcastAudienceTargetChatIds,
  resolveBroadcastAudienceLastScopedMode,
  resolveBroadcastAudiencePayload,
  restoreBroadcastAudienceModeFromAll,
  type BroadcastScopedTargetMode,
} from '../lib/broadcast-audience';
import {
  buildBroadcastAudiencePresentation,
  buildBroadcastAudiencePreviewBundle,
  toManagedBroadcastTargetPreview,
} from '../lib/broadcast-audience-presentation';
import { maxNotify, openMaxBotLink } from '../lib/max-bridge';
import { shouldRetryTransientApiError } from '../lib/api-retry';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { useHintPopoverAutoPosition } from '../lib/hint-popover';
import { buildManagedEntitiesRoute, saveLastEntityId } from '../lib/last-chat';
import { findTerminalSettingsLoadError } from '../lib/settings-load-error';
import { useAutoHideHeader } from '../lib/use-auto-hide-header';
import { useManagedEntitiesSync } from '../lib/use-managed-entities-sync';
import {
  MANAGED_ENTITIES_VISIBILITY_REFRESH_MIN_HIDDEN_MS,
  MANAGED_ENTITIES_VISIBILITY_REFRESH_MIN_INTERVAL_MS,
  buildManagedEntitiesSettledMarker,
  useManagedEntitiesVisibilityRefresh,
} from '../lib/use-managed-entities-visibility-refresh';
import { useVisualViewportOverlayStyle } from '../lib/use-visual-viewport-overlay-style';
import {
  resolveLegacyBroadcastEditorTarget,
  resolveLegacyPublicationReturnPath,
} from '../features/publications/legacy-autoposts';
import { SettingsCommercialFilterSection } from './settings/settings-commercial-filter-section';
import { SettingsReportsSection } from './settings/settings-reports-entry';
import {
  applySettingsSectionWithConfirmedSource,
  refreshSavedStopWordsSource,
  type SettingsApplySubmission,
  type SettingsApplySavedSource,
} from './settings/settings-section-apply-submit';
import {
  mapStopWordsValidationIssues,
  type StopWordsFocusRequest,
  type StopWordsFocusTarget,
} from './settings/stop-words-settings-feedback';
import { ApiRequestError } from '../lib/api-request-error';
import {
  formatDuplicateSettingsSummary,
  resolveDuplicatePhotoPolicyForDraft,
} from './settings/settings-duplicate-photo-status';
import { SettingsDuplicatesSection } from './settings/settings-duplicates-entry';
import { SettingsExtraSection } from './settings/settings-extra-entry';
import { SettingsLimitsSection } from './settings/settings-limits-section';
import { SettingsNightSection } from './settings/settings-night-entry';
import { SettingsMessageRetentionSection } from './settings/settings-message-retention-section';
import { SettingsStopWordsSection } from './settings/settings-stop-words-section';
import { useBroadcastImageDraft } from './settings/use-broadcast-image-draft';
import {
  SECTION_SETTING_KEYS,
  type ApplySectionKey,
  hasSectionBotSpeechMediaChanges,
  hasSectionSettingChanges,
  mergeSectionSettings,
  normalizeRequiredSubscriptionDraftSettings,
  normalizeSectionDraftSettings,
} from './settings-page-state';
import {
  PROFANITY_SENSITIVITY_LABELS,
  type DuplicateDetectionPreset,
} from './settings-page.constants';
import { createManagedEntityHeader } from '../lib/managed-entity-header';
import {
  FieldErrors,
  ManagedBroadcastListItem,
  MailingWorkspaceView,
  PendingBroadcastPublishReview,
  resolveBroadcastImagesFromLegacyFields,
  areBroadcastImagesReady,
  ChatSettingsButtonGroup,
  AdminContactButtonGroup,
  LazyBroadcastAudienceControls,
  LazyBroadcastSchedulePlanner,
  LazySettingsDateField,
  LazyBroadcastContentComposer,
  LazyBroadcastButtonsSheet,
  LazyBroadcastPublishReviewSheet,
  LazySettingsHandoffState as HandoffState,
  LazyManagedGiveawayCard,
  LazyActionConfirmMarkdownPreview,
  LazyManagedAutopostRuleCard,
  LazyManagedBroadcastHistoryCard,
  LazySettingsTimeFields,
  LazyRequiredSubscriptionSourcePicker,
  LazyManagedEntityAccessDiagnosticsBanner,
  LazySettingsAdminCommandsSection,
  preloadBotSpeechMessageEditorSheet,
  AUTO_MUTE_DURATION_MIN_HOURS,
  AUTO_MUTE_DURATION_MAX_HOURS,
  AUTO_MUTE_DURATION_PRESET_HOURS,
  DUPLICATE_ALLOWED_COUNT_MIN,
  STICKER_COOLDOWN_MIN_MINUTES,
  STICKER_COOLDOWN_MAX_MINUTES,
  DOMAIN_REMOVAL_MIN_FUTURE_MS,
  MAX_BROADCAST_TEXT_LENGTH,
  MIN_BROADCAST_CYCLE_HOURS,
  DEFAULT_RULES_POST_BUTTON_TEXT,
  ADMIN_CONTACT_BUTTON_TEXT,
  BROADCAST_HOUR_MS,
  AutoMuteDurationKey,
  AutoMuteEnabledKey,
  HintKey,
  BotSpeechMediaFieldKey,
  BotSpeechMediaImage,
  BotMessageEditorKey,
  WarnMessageEditorKey,
  SettingsSectionKey,
  INITIAL_EXPANDED_SECTIONS,
  SECTION_LABELS,
  createDefaultApplySettingsTarget,
  resolveDuplicateSharedWindowSec,
  resolveDuplicateAllowedCount,
  resolveDuplicateAllowedCountMax,
  buildDuplicateFlowSettings,
  resolveBotSpeechPreviewContext,
  formatApiError,
  minutesToTimeInput,
  toLocalDateInputValue,
  toLocalTimeInputValue,
  parseIsoToLocalDateTime,
  formatRemovalDateTime,
  formatNavigationAllowlistEntryKindLabel,
  formatNavigationAllowlistEntryTarget,
  getNavigationAllowlistTargetOption,
  NAVIGATION_ALLOWLIST_TARGET_OPTIONS,
  formatCompactBroadcastDateTime,
  formatRussianCountLabel,
  formatBroadcastPayloadScheduleLabel,
  resolveBroadcastCountdown,
  resolveManagedBroadcastCardTone,
  resolveManagedBroadcastCardBadge,
  resolveManagedBroadcastCardTitle,
  resolveManagedBroadcastMetric,
  buildManagedBroadcastFactChips,
  formatNightForceCloseDuration,
  formatMuteDurationCompact,
  secondsToHours,
  resolveCommercialSensitivityConfig,
  getCommercialSensitivityLabel,
  inferCommercialSensitivitySliderValue,
  formatRequiredSubscriptionCount,
  formatRequiredSubscriptionEntityLabel,
  formatRequiredSubscriptionLinkPreview,
  getRouteChatTitle,
  getRouteChatAvatarUrl,
  CalendarIcon,
  ClockIcon,
  TrashIcon,
  EMPTY_BROADCAST_PLANNER_STATE,
  areBroadcastPlannerStatesEqual,
} from './settings/settings-page-helpers';
import {
  ChatSettingsWorkspaceHeader,
  handleDesktopToggleRowClick,
  useChatSettingsWorkspaceLeaveGuard,
} from './settings/chat-settings-workspace';
import {
  AdminContactToggle,
  BroadcastPublishBar,
  LazyActionConfirmSheet,
  SettingsLoadErrorState,
  SettingsPollsSection,
  SettingsStorefrontSection,
} from './settings/settings-lazy-surfaces';

const SharedRulesSettingsStudio = lazy(() =>
  import('./settings/shared-rules-settings-studio').then((module) => ({
    default: module.SharedRulesSettingsStudio,
  })),
);
const LazyBotPermissionRequiredDialog = lazy(() =>
  import('../components/bot-permission-required-dialog').then((module) => ({
    default: module.BotPermissionRequiredDialog,
  })),
);
const LazySettingsSectionSaveFooter = lazy(() =>
  import('./settings/settings-section-save-footer').then((module) => ({
    default: module.SettingsSectionSaveFooter,
  })),
);
let settingsApplyTargetSheetPromise: Promise<{
  default: typeof import('./settings/settings-apply-target-sheet').SettingsApplyTargetSheet;
}> | null = null;
function preloadSettingsApplyTargetSheet() {
  settingsApplyTargetSheetPromise ??= import('./settings/settings-apply-target-sheet').then(
    (module) => ({ default: module.SettingsApplyTargetSheet }),
  );
  return settingsApplyTargetSheetPromise;
}
const LazySettingsApplyTargetSheet = lazy(preloadSettingsApplyTargetSheet);
const LazySettingsApplyPartialResult = lazy(() =>
  import('./settings/settings-apply-partial-result').then((module) => ({
    default: module.SettingsApplyPartialResult,
  })),
);
const LazySettingsOverviewSearch = lazy(() =>
  import('../components/ui/settings-overview-search').then((module) => ({
    default: module.SettingsOverviewSearch,
  })),
);
const LazySettingsSpeechStylePanel = lazy(() => import('./settings/settings-speech-style-panel'));
const LazySettingsStopWordsSingleTools = lazy(() =>
  import('./settings/settings-stop-words-single-tools').then((module) => ({
    default: module.SettingsStopWordsSingleTools,
  })),
);
const LazySettingsLinkLegacySites = lazy(() =>
  import('./settings/settings-link-legacy-sites').then((module) => ({
    default: module.SettingsLinkLegacySites,
  })),
);

const SHARED_CHAT_SECTION_PRESENTATIONS = {
  links: getNetworkSettingsSectionPresentation('chat', 'links'),
  greeting: getNetworkSettingsSectionPresentation('chat', 'greeting'),
  profanityFilter: getNetworkSettingsSectionPresentation('chat', 'profanityFilter'),
  requiredSubscription: getNetworkSettingsSectionPresentation('chat', 'requiredSubscription'),
} as const;

export function SettingsPage({ api }: { api: ApiTransport }) {
  const { chatId } = useParams();
  const { snapshot: favoritesSnapshot } = useHomeEntityFavorites();
  const favoritesCompositionEpoch = favoritesSnapshot.byType.chat.compositionEpoch;
  const favoritesCompositionEpochRef = useRef(favoritesCompositionEpoch);
  favoritesCompositionEpochRef.current = favoritesCompositionEpoch;
  const [applyTargetPreviewEpoch, setApplyTargetPreviewEpoch] = useState<number | null>(null);
  const [sharedFieldErrors, setSharedFieldErrors] = useState<Record<string, string>>({});
  const [stopWordsFocusRequest, setStopWordsFocusRequest] = useState<StopWordsFocusRequest>();
  const [stopWordsModuleError, setStopWordsModuleError] = useState<string | null>(null);
  const stopWordsFocusSequenceRef = useRef(0);
  const [isReloadingStopWords, setIsReloadingStopWords] = useState(false);
  const stopWordsReloadRequestRef = useRef<symbol | null>(null);
  useEffect(() => {
    stopWordsReloadRequestRef.current = null;
    setIsReloadingStopWords(false);
  }, [chatId]);
  const [sharedSectionEpochs, setSharedSectionEpochs] = useState<
    Partial<Record<ApplySectionKey, number>>
  >({});
  useEffect(() => {
    setSharedFieldErrors({});
    setStopWordsFocusRequest(undefined);
    setStopWordsModuleError(null);
  }, [chatId]);
  const location = useLocation();
  const navigate = useNavigate();
  const { isCompact: isHeaderCompact } = useAutoHideHeader();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const activeChatIdRef = useRef(chatId);
  activeChatIdRef.current = chatId;

  const [domainInput, setDomainInput] = useState('');
  const [domainInputKind, setDomainInputKind] = useState<NavigationAllowlistKind>('WEB_DOMAIN');
  const [domainInputError, setDomainInputError] = useState('');
  const [messageLimitsBlockedWordsInput, setMessageLimitsBlockedWordsInput] = useState('');
  const [messageLimitsBlockedDomainsInput, setMessageLimitsBlockedDomainsInput] = useState('');
  const [scheduleDomain, setScheduleDomain] = useState<string | null>(null);
  const [scheduleDate, setScheduleDate] = useState('');
  const [scheduleTime, setScheduleTime] = useState('');
  const [scheduleError, setScheduleError] = useState('');
  const [mailingText, setMailingText] = useState('');
  const [mailingTargetMode, setMailingTargetMode] = useState<BroadcastTargetMode>('current');
  const [mailingTargetChatIds, setMailingTargetChatIds] = useState<string[]>([]);
  const [mailingLastScopedTargetMode, setMailingLastScopedTargetMode] =
    useState<BroadcastScopedTargetMode>('current');
  const [mailingAudienceError, setMailingAudienceError] = useState('');
  const [mailingButtons, setMailingButtons] = useState<BroadcastLinkButton[]>([]);
  const [mailingButtonsSheetOpen, setMailingButtonsSheetOpen] = useState(false);
  const [mailingButtonRevealSignal, setMailingButtonRevealSignal] = useState(0);
  const {
    mailingImageEnabled,
    mailingImageBase64,
    mailingImageMimeType,
    mailingImageFileName,
    mailingImages,
    mailingImagesPreparing,
    applyMailingImages,
    resetMailingImages,
    setMailingImagesPreparing,
  } = useBroadcastImageDraft();
  const [mailingVideoCleared, setMailingVideoCleared] = useState(false);
  const [mailingScheduledSlots, setMailingScheduledSlots] = useState<string[]>([]);
  const [mailingTimingMode, setMailingTimingMode] = useState<BroadcastTimingMode>('now');
  const [mailingCycleDraft, setMailingCycleDraft] = useState<BroadcastCycleDraft>(() =>
    createDefaultBroadcastCycleDraft(),
  );
  const [mailingScheduleTimezone, setMailingScheduleTimezone] = useState(() =>
    resolveBroadcastScheduleTimezone(),
  );
  const [, setMailingScheduleEnabled] = useState(false);
  const [, setMailingScheduleDays] = useState(0);
  const [, setMailingScheduleTime] = useState(() =>
    toLocalTimeInputValue(new Date(Date.now() + BROADCAST_HOUR_MS)),
  );
  const [, setMailingCycleEnabled] = useState(false);
  const [, setMailingCycleEveryHours] = useState(MIN_BROADCAST_CYCLE_HOURS);
  const [, setMailingCycleCount] = useState(2);
  const [mailingTextError, setMailingTextError] = useState('');
  const [mailingButtonErrors, setMailingButtonErrors] = useState<BroadcastLinkButtonFieldErrors[]>(
    [],
  );
  const [mailingImageError, setMailingImageError] = useState('');
  const [mailingScheduleError, setMailingScheduleError] = useState('');
  const [mailingCycleError, setMailingCycleError] = useState('');
  useEffect(() => {
    const { body } = document;
    body.classList.add('settings-home-page-open');

    return () => {
      body.classList.remove('settings-home-page-open');
    };
  }, []);

  const [mailingPlannerResetKey, setMailingPlannerResetKey] = useState(0);
  const [mailingPlannerState, setMailingPlannerState] =
    useState<BroadcastSchedulePlannerSelectionState>(EMPTY_BROADCAST_PLANNER_STATE);
  const [editingManagedBroadcast, setEditingManagedBroadcast] =
    useState<ManagedBroadcastDetails | null>(null);
  const [editingManagedAutopostRule, setEditingManagedAutopostRule] =
    useState<ManagedAutopostRuleDetails | null>(null);
  const [managedBroadcastDeleteTarget, setManagedBroadcastDeleteTarget] =
    useState<ManagedBroadcastListItem | null>(null);
  const [managedAutopostRuleDeleteTarget, setManagedAutopostRuleDeleteTarget] =
    useState<ManagedAutopostRuleSummary | null>(null);
  const [pendingMailingSlotConflict, setPendingMailingSlotConflict] = useState<{
    broadcastId: string | null;
    payload: SendBroadcastPayload;
  } | null>(null);
  const [pendingMailingPublishReview, setPendingMailingPublishReview] =
    useState<PendingBroadcastPublishReview | null>(null);

  const [applyTargetSheet, setApplyTargetSheet] = useState<SettingsApplySubmission | null>(null);
  const [applyTargetPreview, setApplyTargetPreview] = useState<Awaited<
    ReturnType<typeof previewApplySettingsSectionTarget>
  > | null>(null);
  const [applyPartialResult, setApplyPartialResult] = useState<{
    result: SettingsApplyPartialError;
    recipientTitles: Readonly<Record<string, string>>;
  } | null>(null);
  const [applyTargetPreviewLoading, setApplyTargetPreviewLoading] = useState(false);
  const [applyTargetPreviewError, setApplyTargetPreviewError] = useState<string | null>(null);
  const applyTargetSavedSourceRef = useRef<SettingsApplySavedSource | null>(null);
  const applyTargetOverlayStyle = useVisualViewportOverlayStyle(Boolean(applyTargetSheet));

  useEffect(() => {
    if (!applyTargetSheet) {
      return undefined;
    }

    const { body, documentElement } = document;
    const previousBodyOverflow = body.style.overflow;
    const previousDocumentOverflow = documentElement.style.overflow;

    body.classList.add('settings-apply-target-open');
    body.style.overflow = 'hidden';
    documentElement.style.overflow = 'hidden';

    return () => {
      body.classList.remove('settings-apply-target-open');
      body.style.overflow = previousBodyOverflow;
      documentElement.style.overflow = previousDocumentOverflow;
    };
  }, [applyTargetSheet]);

  const [chatsListRefreshRequest, setChatsListRefreshRequest] = useState<{
    nonce: number;
    behavior: 'default' | 'manual' | 'recovery';
  }>({
    nonce: 0,
    behavior: 'default',
  });
  const [mailingNowMs, setMailingNowMs] = useState(() => Date.now());
  const [mailingWorkspaceView, setMailingWorkspaceView] = useState<MailingWorkspaceView>('compose');
  const [mailingHistoryFilter, setMailingHistoryFilter] =
    useState<BroadcastHistoryFilter>('future');
  const [duplicateWindowInputValue, setDuplicateWindowInputValue] = useState<string | null>(null);

  const giveawayCardRef = useRef<ManagedGiveawayCardHandle | null>(null);

  const [openHintKey, setOpenHintKey] = useState<HintKey | null>(null);
  const [openMuteDurationKey, setOpenMuteDurationKey] = useState<AutoMuteDurationKey | null>(null);
  const [openBotEditorKey, setOpenBotEditorKey] = useState<BotMessageEditorKey | null>(null);
  const [openWarnEditorKey, setOpenWarnEditorKey] = useState<WarnMessageEditorKey | null>(null);
  const [speechStylePanelOpen, setSpeechStylePanelOpen] = useState(false);
  const [pendingSpeechStyle, setPendingSpeechStyle] = useState<BotSpeechStyle | null>(null);
  const [expandedSections, setExpandedSections] =
    useState<Record<SettingsSectionKey, boolean>>(INITIAL_EXPANDED_SECTIONS);
  const isLinksKeyboardOpen = useKeyboardOpen(120, expandedSections.links);
  const appliedBroadcastHandoffSignatureRef = useRef<string | null>(null);
  const appliedLegacyEditorTargetRef = useRef<string | null>(null);
  const broadcastDraftRestoreEpochRef = useRef(0);
  const [broadcastDraftRestoreReady, setBroadcastDraftRestoreReady] = useState(false);

  const routeChatTitle = getRouteChatTitle(location.state);
  const routeChatAvatarUrl = getRouteChatAvatarUrl(location.state);
  const searchParams = new URLSearchParams(location.search);
  const focusSection = searchParams.get('focus');
  const handoffRequested = searchParams.get('handoff') === '1';
  const legacyEditorTarget = resolveLegacyBroadcastEditorTarget(location.search);
  const broadcastComposerClientResetQuery = useQuery({
    queryKey: ['broadcast-composer-client-reset', chatId],
    queryFn: ({ signal }) => getBroadcastComposerClientResetState(api, chatId ?? '', { signal }),
    enabled: false,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (
      focusSection !== 'links' &&
      focusSection !== 'rules' &&
      focusSection !== 'comments' &&
      focusSection !== 'stopWords' &&
      focusSection !== 'commercialFilter' &&
      focusSection !== 'giveaway' &&
      focusSection !== 'polls' &&
      focusSection !== 'broadcast' &&
      focusSection !== 'requiredSubscription' &&
      focusSection !== 'storefront'
    ) {
      return;
    }

    setExpandedSections({
      ...INITIAL_EXPANDED_SECTIONS,
      ...(focusSection === 'links'
        ? { links: true }
        : focusSection === 'rules'
          ? { rules: true }
          : focusSection === 'comments'
            ? { comments: true }
            : focusSection === 'commercialFilter'
              ? { commercialFilter: true }
              : focusSection === 'stopWords'
                ? { stopWords: true }
                : focusSection === 'giveaway'
                  ? { giveaway: true }
                  : focusSection === 'polls'
                    ? { polls: true }
                    : focusSection === 'requiredSubscription'
                      ? { requiredSubscription: true }
                      : focusSection === 'storefront'
                        ? { storefront: true }
                        : { mailing: true }),
    });
  }, [focusSection]);

  useEffect(() => {
    if (chatId) {
      saveLastEntityId('chat', chatId);
    }
  }, [chatId]);

  useEffect(() => {
    setApplyTargetSheet(null);
    setApplyTargetPreview(null);
    setApplyTargetPreviewError(null);
    setApplyTargetPreviewLoading(false);
    setMailingTargetMode('current');
    setMailingTargetChatIds(chatId ? [chatId] : []);
    setMailingLastScopedTargetMode('current');
    setMailingAudienceError('');
    setMailingText('');
    setMailingButtons([]);
    setMailingButtonsSheetOpen(false);
    applyMailingImages([]);
    setMailingVideoCleared(false);
    setMailingTimingMode('now');
    setMailingCycleDraft(createDefaultBroadcastCycleDraft());
    setMailingScheduledSlots([]);
    setMailingScheduleTimezone(resolveBroadcastScheduleTimezone());
    setMailingScheduleEnabled(false);
    setMailingScheduleDays(0);
    setMailingScheduleTime(toLocalTimeInputValue(new Date(Date.now() + BROADCAST_HOUR_MS)));
    setMailingCycleEnabled(false);
    setMailingCycleEveryHours(MIN_BROADCAST_CYCLE_HOURS);
    setMailingCycleCount(2);
    setMailingTextError('');
    setMailingButtonErrors([]);
    setMailingImageError('');
    setMailingScheduleError('');
    setMailingCycleError('');
    resetMailingPlanner();
    setEditingManagedBroadcast(null);
    setEditingManagedAutopostRule(null);
    setMailingWorkspaceView('compose');
    const restoreEpoch = ++broadcastDraftRestoreEpochRef.current;
    setBroadcastDraftRestoreReady(false);
    setDuplicateWindowInputValue(null);
    setPendingSpeechStyle(null);

    if (!chatId || !broadcastComposerClientResetQuery.isSuccess) {
      return;
    }

    const resetAt = broadcastComposerClientResetQuery.data?.resetAt;
    const shouldApplyReset =
      Boolean(resetAt) && !hasAppliedBroadcastComposerReset('chat', chatId, resetAt);
    let cancelled = false;
    const markRestoreReady = () => {
      if (cancelled || restoreEpoch !== broadcastDraftRestoreEpochRef.current) {
        return;
      }

      setBroadcastDraftRestoreReady(true);
    };

    if (shouldApplyReset && resetAt) {
      void (async () => {
        await clearBroadcastComposerDraft('chat', chatId);
        if (cancelled || restoreEpoch !== broadcastDraftRestoreEpochRef.current) {
          return;
        }

        markBroadcastComposerResetApplied('chat', chatId, resetAt);
        appliedBroadcastHandoffSignatureRef.current = null;
        resetMailingComposer();
        void queryClient.invalidateQueries({ queryKey: ['broadcast-handoff-state', chatId] });
        markRestoreReady();
      })();

      return () => {
        cancelled = true;
      };
    }

    const applySavedBroadcastDraft = (savedBroadcastDraft: BroadcastComposerDraft) => {
      if (cancelled || restoreEpoch !== broadcastDraftRestoreEpochRef.current) {
        return;
      }

      setMailingTargetMode(savedBroadcastDraft.targetMode);
      setMailingTargetChatIds(
        savedBroadcastDraft.targetChatIds.length > 0
          ? savedBroadcastDraft.targetChatIds
          : chatId
            ? [chatId]
            : [],
      );
      setMailingLastScopedTargetMode(savedBroadcastDraft.lastScopedTargetMode);
      setMailingText(savedBroadcastDraft.text);
      setMailingButtons(savedBroadcastDraft.buttons);
      setMailingTimingMode(savedBroadcastDraft.timingMode);
      setMailingCycleDraft(normalizeBroadcastCycleDraft(savedBroadcastDraft.cycle));
      setMailingScheduledSlots(sortAndUniqueBroadcastSlots(savedBroadcastDraft.scheduledSlots));
      setMailingScheduleTimezone(
        savedBroadcastDraft.scheduleTimezone.trim() || resolveBroadcastScheduleTimezone(),
      );
    };

    void loadBroadcastComposerDraftAsync('chat', chatId).then((draft) => {
      if (draft) {
        applySavedBroadcastDraft(draft);
      }
      markRestoreReady();
    });

    return () => {
      cancelled = true;
    };
  }, [
    broadcastComposerClientResetQuery.data?.resetAt,
    broadcastComposerClientResetQuery.isSuccess,
    chatId,
    queryClient,
  ]);

  const meQuery = useQuery({
    queryKey: ['me', chatId ?? null],
    queryFn: ({ signal }) =>
      getMe(api, { chatId: chatId ?? undefined, entityType: 'chat', signal }),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const settingsScreenQuery = useSettingsScreenQuery({
    api,
    chatId,
    handoffRequested,
    expandedSections,
  });
  const {
    draft,
    setDraft,
    fieldErrors,
    setFieldErrors,
    permissionBlocker,
    setPermissionBlocker,
    pendingPermissionRetryRef,
    settingsConflict,
    setSettingsConflict,
    hasChanges,
    clearFieldError,
    syncSavedSectionSettings,
    syncSavedBotSpeechStyle,
    syncSavedStopWords,
    stopWordsStorageStatus,
    stopWordsReplacement,
    authorizeStopWordsReplacement,
    discardStopWordsEditorState,
    stopWordsConflict,
    stopWordsSaveError,
    handleStopWordsSaveError,
    saveWorkspaceDraft,
    handleSettingsPermissionError,
    saveSectionMutation,
    isSavingSettings,
    savingSection,
    mutateSettingsAsync,
    isCurrentSettingsScope,
  } = useSettingsDraft({
    api,
    chatId,
    userId: meQuery.data?.userId ?? null,
    serverSettings: settingsScreenQuery.data?.settings,
    stopWordsStorageStatus: settingsScreenQuery.data?.stopWordsStorageStatus,
    refetchSettings: settingsScreenQuery.refetch,
    onHydrated: () => setDuplicateWindowInputValue(null),
    onStopWordsSaved: () => {
      setMessageLimitsBlockedWordsInput((value) =>
        value === messageLimitsBlockedWordsInput ? '' : value,
      );
      setMessageLimitsBlockedDomainsInput((value) =>
        value === messageLimitsBlockedDomainsInput ? '' : value,
      );
    },
    onSaved: (section) => {
      pushToast({
        tone: 'success',
        title:
          section === 'links' || (section === 'stopWords' && expandedSections.links)
            ? 'Блок «Ссылки» сохранён'
            : `Блок «${SECTION_LABELS[section]}» сохранен`,
      });
      maxNotify('success');
    },
    onError: (error, section, permission) => {
      if (section === 'stopWords') applyStopWordsServerValidation(error);
      if (!permission)
        pushToast({
          tone: 'danger',
          title:
            section === 'stopWords' && expandedSections.links
              ? 'Не удалось сохранить блок «Ссылки»'
              : `Не удалось сохранить блок «${SECTION_LABELS[section]}»`,
          description: formatApiError(error),
        });
      maxNotify('error');
    },
  });
  const stopWordsReplacementAuthorized = Boolean(
    stopWordsReplacement &&
    stopWordsReplacement.chatId === chatId &&
    stopWordsReplacement.expectedRevision === (draft?.stopWordsRevision ?? 0),
  );
  const stopWordsStorageLocked =
    stopWordsStorageStatus === 'invalid' && !stopWordsReplacementAuthorized;
  const reportsAvailabilityQuery = useQuery({
    queryKey: ['report-availability', chatId],
    queryFn: async ({ signal }) => {
      const { getReportAvailability } = await import('../lib/api/report-availability-client');
      return getReportAvailability(api, chatId ?? '', signal);
    },
    enabled: Boolean(chatId) && expandedSections.reports,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
    refetchInterval: expandedSections.reports ? 30_000 : false,
    refetchIntervalInBackground: false,
  });
  const broadcastHandoffStateQuery = useQuery({
    queryKey: ['broadcast-handoff-state', chatId],
    queryFn: () => getBroadcastHandoffState(api, chatId ?? ''),
    enabled:
      Boolean(chatId) &&
      !editingManagedBroadcast &&
      focusSection === 'broadcast' &&
      handoffRequested,
    refetchOnWindowFocus: false,
  });
  const handoffMode = resolveBroadcastHandoffLoadMode({
    requested: Boolean(chatId) && focusSection === 'broadcast' && handoffRequested,
    queries: [settingsScreenQuery, broadcastHandoffStateQuery],
  });
  const handoffError = findTerminalSettingsLoadError(
    settingsScreenQuery.error,
    broadcastHandoffStateQuery.error,
  );
  const hasLegacyBroadcastHandoff =
    handoffRequested &&
    Boolean(
      broadcastHandoffStateQuery.data &&
      hasBroadcastHandoffDraft(broadcastHandoffStateQuery.data, { includeTargets: true }),
    );
  const legacyBroadcastWorkspaceRequested =
    focusSection === 'broadcast' &&
    (hasLegacyBroadcastHandoff ||
      searchParams.get('workspace') === 'autoposts' ||
      legacyEditorTarget !== null);
  const sendBroadcastHandoffMutation = useMutation({
    mutationFn: (payload: SendBroadcastPayload) => sendBroadcast(api, chatId ?? '', payload),
    onSuccess: async (result) => {
      const feedback = buildBroadcastSendFeedback(result);
      if (feedback.clearDraft) {
        resetMailingComposer();
      }
      let cleanupFailed = false;
      if (chatId) {
        const handoffQueryKey = ['broadcast-handoff-state', chatId] as const;
        if (feedback.clearDraft) {
          try {
            await clearBroadcastHandoffState(api, chatId);
            await queryClient.invalidateQueries({ queryKey: handoffQueryKey });
          } catch {
            cleanupFailed = true;
            queryClient.setQueryData(handoffQueryKey, null);
          }
        }
        void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
        void queryClient.invalidateQueries({ queryKey: ['managed-broadcast-calendar', chatId] });
      }
      void queryClient.invalidateQueries({ queryKey: ['publications', 'legacy'] });
      pushToast({
        tone: cleanupFailed && feedback.tone === 'success' ? 'info' : feedback.tone,
        title: feedback.title,
        description:
          [
            feedback.description ?? '',
            cleanupFailed ? 'Черновик не удалось очистить. Не запускайте его повторно.' : '',
          ]
            .filter(Boolean)
            .join(' ') || undefined,
      });
      maxNotify(cleanupFailed ? 'warning' : feedback.notification);
    },
    onError: (error) => {
      const description = reportMailingAudienceApiError(error);
      pushToast({
        tone: 'danger',
        title: 'Не удалось запустить публикацию',
        description,
      });
      maxNotify('error');
    },
  });
  const spammerReviewMetricsQuery = useQuery({
    queryKey: ['global-spammer-review-metrics', chatId, 'summary'],
    queryFn: ({ signal }) =>
      getGlobalSpammerReviewMetrics(api, chatId ?? '', { mode: 'summary' }, { signal }),
    enabled: Boolean(chatId) && Boolean(settingsScreenQuery.data),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const shouldLoadRequiredSubscriptionChannels =
    Boolean(chatId) &&
    (expandedSections.requiredSubscription || focusSection === 'requiredSubscription');
  const chatsList = useManagedEntitiesSync({
    api,
    entityType: 'chat',
    reloadNonce: chatsListRefreshRequest.nonce,
    reloadBehavior: chatsListRefreshRequest.behavior,
    backgroundRefreshOnFirstLoad: true,
    persistLocalCache: true,
    localCacheScope: 'home',
  });
  const {
    requiredSubscriptionExternalChannelValue,
    requiredSubscriptionExternalChannelError,
    requiredSubscriptionEntitiesLoading,
    requiredSubscriptionEntitiesSyncing,
    requiredSubscriptionEntitiesError,
    requiredSubscriptionEntitiesBackoffActive,
    selectedRequiredSubscriptionChannels,
    selectedRequiredSubscriptionChannelHeaders,
    selectedUnavailableRequiredSubscriptionChannels,
    unavailableManagedRequiredSubscriptionChannels,
    availableRequiredSubscriptionChannelChoices,
    isResolvingRequiredSubscriptionChannel,
    setRequiredSubscriptionExternalChannelValue,
    setRequiredSubscriptionExternalChannelError,
    addRequiredSubscriptionChannel,
    removeRequiredSubscriptionChannel,
    refreshRequiredSubscriptionChannels,
    handleResolveRequiredSubscriptionExternalChannel,
  } = useSettingsRequiredSubscription({
    api,
    chatId,
    draft,
    setDraft,
    chatsList,
    enabled: shouldLoadRequiredSubscriptionChannels,
    serverChannels: settingsScreenQuery.data?.requiredSubscriptionChannels,
    refreshChats: () =>
      setChatsListRefreshRequest((current) => ({ nonce: current.nonce + 1, behavior: 'manual' })),
    clearSelectionError: () => clearFieldError('requiredSubscriptionChannelIds'),
    formatError: formatApiError,
    onResolved: (channel, alreadySelected) => {
      const entityLabel = formatRequiredSubscriptionEntityLabel(channel.entityType);
      pushToast({
        tone: 'success',
        title: alreadySelected
          ? `${entityLabel} уже в списке`
          : `${entityLabel} «${channel.title}» добавлен`,
      });
      maxNotify('success');
    },
    onResolveError: () => maxNotify('error'),
  });

  const settledChatsListMarker = useMemo(
    () =>
      buildManagedEntitiesSettledMarker({
        hasLoadedFromServer: chatsList.hasLoadedFromServer,
        isSyncComplete: chatsList.isSyncComplete,
        isBackoffActive: chatsList.isBackoffActive,
        snapshotVersion: chatsList.snapshot?.version,
        snapshotBuiltAt: chatsList.snapshot?.builtAt,
        lastSyncedAt: chatsList.refreshState?.lastSyncedAt,
      }),
    [
      chatsList.hasLoadedFromServer,
      chatsList.isBackoffActive,
      chatsList.isSyncComplete,
      chatsList.refreshState?.lastSyncedAt,
      chatsList.snapshot?.builtAt,
      chatsList.snapshot?.version,
    ],
  );
  useManagedEntitiesVisibilityRefresh({
    enabled: true,
    hasLoadedFromServer: chatsList.hasLoadedFromServer,
    isLoading: chatsList.isLoading,
    isRefreshing: chatsList.isRefreshing,
    isSyncComplete: chatsList.isSyncComplete,
    snapshotStale: chatsList.snapshot?.stale ?? null,
    settledMarker: settledChatsListMarker,
    minIntervalMs: MANAGED_ENTITIES_VISIBILITY_REFRESH_MIN_INTERVAL_MS,
    minHiddenDurationMs: MANAGED_ENTITIES_VISIBILITY_REFRESH_MIN_HIDDEN_MS,
    onVisibilityReturnRefresh: () => {
      startTransition(() => {
        setChatsListRefreshRequest((current) => ({
          nonce: current.nonce + 1,
          behavior: 'recovery',
        }));
      });
    },
  });
  const settingsQuery = {
    data: settingsScreenQuery.data?.settings,
    isLoading: settingsScreenQuery.isLoading,
    error: settingsScreenQuery.error,
    refetch: settingsScreenQuery.refetch,
  };
  const rulesQuery = {
    data: settingsScreenQuery.data?.rules,
    isLoading: settingsScreenQuery.isLoading,
    error: settingsScreenQuery.error,
  };

  useEffect(() => {
    preloadBotSpeechMessageEditorSheet();
  }, []);

  const managedBroadcastsQuery = {
    data: settingsScreenQuery.data?.managedBroadcasts,
    isLoading: settingsScreenQuery.isLoading,
    error: settingsScreenQuery.error,
  };
  const chatHeaderQuery = {
    data: settingsScreenQuery.data?.header,
  };
  const botSpeechPreviewContext = useMemo(
    () => resolveBotSpeechPreviewContext(settingsScreenQuery.data?.botSpeechPreviewProfile),
    [settingsScreenQuery.data?.botSpeechPreviewProfile],
  );
  const domainsQuery = {
    data: settingsScreenQuery.data?.domains,
    isLoading: settingsScreenQuery.isLoading,
    error: settingsScreenQuery.error,
  };
  const duplicatePhotoModerationPolicy = resolveDuplicatePhotoPolicyForDraft(
    settingsScreenQuery.data?.duplicatePhotoPolicyMatrix,
    settingsScreenQuery.data?.duplicatePhotoModerationMode ?? 'OBSERVE',
  );
  const duplicatePhotoModerationMode = duplicatePhotoModerationPolicy.moderationMode;
  const currentRulesTextSource = useMemo(() => {
    const currentSettings = draft ?? settingsScreenQuery.data?.settings;
    if (!currentSettings) {
      return null;
    }

    const channelById = new Map<string, ManagedEntityHeader>();
    for (const channel of settingsScreenQuery.data?.requiredSubscriptionChannels ?? []) {
      channelById.set(channel.id, channel);
    }
    for (const channel of selectedRequiredSubscriptionChannelHeaders) {
      channelById.set(channel.id, channel);
    }
    for (const channel of selectedUnavailableRequiredSubscriptionChannels) {
      channelById.set(
        channel.id,
        createManagedEntityHeader({
          id: channel.id,
          title: channel.title,
          entityType: 'channel',
          link: null,
          participantsCount: null,
        }),
      );
    }

    return {
      settings: currentSettings,
      duplicatePhotoModerationMode,
      domains: domainsQuery.data ?? settingsScreenQuery.data?.domains ?? [],
      requiredSubscriptionChannels: currentSettings.requiredSubscriptionChannelIds
        .map((channelId) => channelById.get(channelId))
        .filter((channel): channel is ManagedEntityHeader => Boolean(channel)),
    };
  }, [
    domainsQuery.data,
    draft,
    duplicatePhotoModerationMode,
    selectedRequiredSubscriptionChannelHeaders,
    selectedUnavailableRequiredSubscriptionChannels,
    settingsScreenQuery.data?.domains,
    settingsScreenQuery.data?.requiredSubscriptionChannels,
    settingsScreenQuery.data?.settings,
  ]);

  const updateRulesAttachMutation = useMutation({
    onMutate: () => ({ chatId, setDraft, isCurrentSettingsScope }),
    mutationFn: (enabled: boolean) => {
      const base = settingsQuery.data ?? draft;
      if (!chatId || !base) {
        throw new Error('Чат не выбран');
      }

      return updateSettings(api, chatId, {
        ...base,
        rulesAttachViolationsEnabled: enabled,
      });
    },
    onSuccess: (saved, _enabled, scope) => {
      scope?.setDraft((current) =>
        current
          ? {
              ...current,
              rulesAttachViolationsEnabled: saved.rulesAttachViolationsEnabled,
              settingsRevision: saved.settingsRevision,
            }
          : saved,
      );
      queryClient.setQueryData<ChatSettingsScreenResponse | undefined>(
        ['settings-screen', scope?.chatId],
        (current) =>
          current
            ? {
                ...current,
                settings: {
                  ...current.settings,
                  rulesAttachViolationsEnabled: saved.rulesAttachViolationsEnabled,
                  settingsRevision: saved.settingsRevision,
                },
              }
            : current,
      );
      if (!scope?.isCurrentSettingsScope()) return;
      pushToast({
        tone: 'success',
        title: saved.rulesAttachViolationsEnabled
          ? 'Кнопка «Правила» включена'
          : 'Кнопка «Правила» выключена',
      });
      maxNotify('success');
    },
    onError: (error, _enabled, scope) => {
      if (!scope?.isCurrentSettingsScope()) return;
      pushToast({
        tone: 'danger',
        title: 'Не удалось обновить кнопку «Правила»',
        description: formatApiError(error),
      });
      maxNotify('error');
    },
  });

  const {
    rulesDraft,
    setRulesDraft,
    rulesPublicationMode,
    setRulesPublicationMode,
    rulesTextError,
    setRulesTextError,
    rulesImageError,
    setRulesImageError,
    isPreparingRulesImage,
    handleRulesImagePreparationChange,
    rulesButtonErrors,
    setRulesButtonErrors,
    setRulesButtonFieldsTouched,
    rulesButtonsSheetOpen,
    setRulesButtonsSheetOpen,
    rulesButtonRevealSignal,
    isPreparingRulesPublish,
    rulesResetConfirmationOpen,
    setRulesResetConfirmationOpen,
    handleRulesAutoTextChange,
    saveRulesDraftNow,
    handleSaveRulesDraft,
    handlePublishRules,
    handleResetPublishedRules,
    confirmResetPublishedRules,
    handleRulesButtonsEnabledChange,
    handleRulesAdminContactButtonChange,
    hasRulesChanges,
    rulesPublishedUrl,
    hasPublishedRules,
    isRulesResetPending,
    isCheckingRulesPublication,
    isSavingRules,
    isPublishingRules,
    isResettingPublishedRules,
    isRulesDraftEditingDisabled,
    isRulesBusy,
  } = useSettingsRules({
    api,
    chatId,
    serverRules: rulesQuery.data,
    rulesModuleOpen: expandedSections.rules,
    currentRulesTextSource,
    isUpdatingRulesAttachment: updateRulesAttachMutation.isPending,
    pushToast,
  });

  const chatTitle = useMemo(() => {
    if (!chatId) {
      return '';
    }

    const fromHeader = chatHeaderQuery.data?.title?.trim();
    if (fromHeader) {
      return fromHeader;
    }

    if (routeChatTitle) {
      return routeChatTitle;
    }

    return readChatTitle(chatId);
  }, [chatHeaderQuery.data?.title, chatId, routeChatTitle]);

  useEffect(() => {
    if (!chatId || !chatTitle) {
      return;
    }

    saveChatTitle(chatId, chatTitle);
  }, [chatId, chatTitle]);

  useEffect(() => {
    if (!broadcastHandoffStateQuery.data || !handoffRequested) {
      return;
    }

    if (!hasBroadcastHandoffDraft(broadcastHandoffStateQuery.data, { includeTargets: true })) {
      appliedBroadcastHandoffSignatureRef.current = null;
      return;
    }

    const signature = JSON.stringify(broadcastHandoffStateQuery.data);
    if (appliedBroadcastHandoffSignatureRef.current === signature) {
      return;
    }

    appliedBroadcastHandoffSignatureRef.current = signature;
    broadcastDraftRestoreEpochRef.current += 1;
    setEditingManagedBroadcast(null);
    setEditingManagedAutopostRule(null);
    const handoffTargetChatIds = normalizeBroadcastAudienceTargetChatIds(
      broadcastHandoffStateQuery.data.targetChatIds,
    );
    setMailingTargetMode(broadcastHandoffStateQuery.data.targetMode);
    setMailingTargetChatIds(
      broadcastHandoffStateQuery.data.targetMode === 'selected' && handoffTargetChatIds.length === 0
        ? chatId
          ? [chatId]
          : []
        : handoffTargetChatIds,
    );
    setMailingLastScopedTargetMode(
      resolveBroadcastAudienceLastScopedMode({
        targetMode: broadcastHandoffStateQuery.data.targetMode,
        targetChatIds: handoffTargetChatIds,
        currentChatId: chatId ?? undefined,
      }),
    );
    setMailingAudienceError('');
    setMailingButtons(broadcastHandoffStateQuery.data.buttons);
    const handoffSchedule = resolveBroadcastHandoffSchedule(broadcastHandoffStateQuery.data);
    setMailingTimingMode(handoffSchedule.timingMode);
    setMailingCycleDraft(handoffSchedule.cycle);
    setMailingScheduledSlots(handoffSchedule.scheduledSlots);
    setMailingScheduleTimezone(
      broadcastHandoffStateQuery.data.scheduleTimezone.trim() || resolveBroadcastScheduleTimezone(),
    );
    setMailingButtonErrors([]);
    setMailingScheduleError('');
    setMailingCycleError('');
    resetMailingPlanner();
    setExpandedSections((current) => ({ ...current, mailing: true }));
    setMailingWorkspaceView('compose');
  }, [broadcastHandoffStateQuery.data, chatId, handoffRequested]);

  useEffect(() => {
    if (
      !chatId ||
      editingManagedBroadcast ||
      editingManagedAutopostRule ||
      !broadcastDraftRestoreReady
    ) {
      return;
    }

    const draftToPersist: BroadcastComposerDraft = {
      text: mailingText,
      targetMode: mailingTargetMode,
      targetChatIds: mailingTargetChatIds,
      lastScopedTargetMode: mailingLastScopedTargetMode,
      buttons: mailingButtons,
      imageEnabled: mailingImageEnabled,
      imageBase64: mailingImageBase64,
      imageMimeType: mailingImageMimeType,
      imageFileName: mailingImageFileName,
      images: mailingImages,
      timingMode: mailingTimingMode,
      scheduledSlots: mailingScheduledSlots,
      scheduleTimezone: mailingScheduleTimezone,
      cycle: mailingCycleDraft,
    };

    saveBroadcastComposerDraft('chat', chatId, draftToPersist);
  }, [
    broadcastDraftRestoreReady,
    chatId,
    editingManagedBroadcast,
    editingManagedAutopostRule,
    mailingButtons,
    mailingCycleDraft,
    mailingImageBase64,
    mailingImageEnabled,
    mailingImageFileName,
    mailingImageMimeType,
    mailingImages,
    mailingLastScopedTargetMode,
    mailingScheduleTimezone,
    mailingScheduledSlots,
    mailingTargetChatIds,
    mailingTargetMode,
    mailingText,
    mailingTimingMode,
  ]);

  useEffect(() => {
    if (!scheduleDomain) {
      return;
    }

    const exists = (domainsQuery.data ?? []).some(
      (item) => item.normalizedValue === scheduleDomain,
    );
    if (!exists) {
      setScheduleDomain(null);
      setScheduleError('');
    }
  }, [domainsQuery.data, scheduleDomain]);

  const recheckAccessMutation = useMutation({
    mutationFn: () => recheckManagedEntityAccess(api, 'chat', chatId ?? ''),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
      pushToast({
        tone: 'success',
        title: 'Проверка доступа запущена',
      });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось запустить проверку доступа',
        description: formatApiError(error),
      });
      maxNotify('error');
    },
  });

  const saveSpeechStyleMutation = useMutation({
    onMutate: () => ({ isCurrentSettingsScope, syncSavedBotSpeechStyle }),
    mutationFn: (style: BotSpeechStyle) => updateBotSpeechStyle(api, chatId ?? '', style),
    onSuccess: async (saved, variables, scope) => {
      await scope?.syncSavedBotSpeechStyle(saved);
      if (!scope?.isCurrentSettingsScope()) return;
      setSpeechStylePanelOpen(false);
      setPendingSpeechStyle(null);
      pushToast({
        tone: 'success',
        title: `Стиль «${BOT_SPEECH_STYLE_METADATA[variables].label}» применен`,
      });
      maxNotify('success');
    },
    onError: (error, _variables, scope) => {
      if (!scope?.isCurrentSettingsScope()) return;
      pushToast({
        tone: 'danger',
        title: 'Не удалось применить стиль речи',
        description: formatApiError(error),
      });
      maxNotify('error');
    },
  });
  const isSavingSpeechStyle = saveSpeechStyleMutation.isPending;

  const isHeaderSaving =
    isSavingSettings ||
    isSavingRules ||
    isPreparingRulesPublish ||
    isSavingSpeechStyle ||
    updateRulesAttachMutation.isPending;
  const activeSpeechStyle = resolveBotSpeechStyle(draft?.botSpeechStyle);
  const botSpeechEditorProps = draft
    ? {
        settings: draft,
        onImageChange: setBotSpeechMediaImage,
      }
    : undefined;

  const applySectionToAllMutation = useMutation({
    mutationFn: (variables: SettingsApplySubmission) =>
      applySettingsSectionWithConfirmedSource(api, variables, (saved) => {
        if (variables.isCurrentScope?.() !== false) applyTargetSavedSourceRef.current = saved;
      }),
    onSuccess: async (result, variables) => {
      if (variables.isCurrentScope?.() === false) return;
      applyTargetSavedSourceRef.current = null;
      if (result.stopWordsReceipt) {
        await syncSavedStopWords(
          result.stopWordsReceipt,
          variables.sourceSettings,
          variables.sourceSettings,
          variables.sourceChatId,
        );
        if (variables.isCurrentScope?.() === false) return;
      } else
        syncSavedSectionSettings(
          result.section,
          result.sourceSettings,
          variables.sourceSettings.settingsRevision,
          variables.sourceChatId,
          variables.sourceSettings,
        );
      if (activeChatIdRef.current !== variables.sourceChatId) return;
      if (result.section === 'stopWords') {
        setMessageLimitsBlockedWordsInput('');
        setMessageLimitsBlockedDomainsInput('');
      }
      pushToast({
        tone: 'success',
        title: `Настройки «${SECTION_LABELS[result.section]}» применены`,
        description: `Обновлено чатов: ${result.updatedChats}.`,
      });
      setApplyTargetSheet(null);
      maxNotify('success');
    },
    onError: async (error, variables) => {
      if (variables.isCurrentScope?.() === false) return;
      let savedSource = applyTargetSavedSourceRef.current;
      applyTargetSavedSourceRef.current = null;
      const sourceSaved =
        savedSource?.section === variables.section &&
        savedSource?.sourceChatId === variables.sourceChatId;
      if (sourceSaved && variables.section === 'stopWords' && savedSource) {
        savedSource = await refreshSavedStopWordsSource(api, savedSource);
        if (variables.isCurrentScope?.() === false) return;
        if (activeChatIdRef.current === variables.sourceChatId) {
          setMessageLimitsBlockedWordsInput('');
          setMessageLimitsBlockedDomainsInput('');
        }
      }
      const { parseSettingsApplyPartial } = await import('../lib/chat-settings-conflict');
      if (variables.isCurrentScope?.() === false) return;
      const partial = parseSettingsApplyPartial(error);
      if (sourceSaved && savedSource) {
        if (savedSource.stopWordsReceipt) {
          await syncSavedStopWords(
            savedSource.stopWordsReceipt,
            variables.sourceSettings,
            variables.sourceSettings,
            variables.sourceChatId,
          );
          if (variables.isCurrentScope?.() === false) return;
        } else
          syncSavedSectionSettings(
            savedSource.section,
            {
              ...savedSource.settings,
              ...(partial?.sourceSettingsRevision
                ? { settingsRevision: partial.sourceSettingsRevision }
                : {}),
            },
            variables.sourceSettings.settingsRevision,
            variables.sourceChatId,
            variables.sourceSettings,
          );
      }
      if (partial) {
        if (activeChatIdRef.current !== variables.sourceChatId) {
          pushToast({
            tone: 'info',
            title: 'Часть настроек применена',
            description: `Обновлено чатов: ${partial.appliedCount} из ${partial.targetCount}. ${partial.causeMessage}`,
          });
          return;
        }
        setApplyPartialResult({
          result: partial,
          recipientTitles: variables.reviewedTargetTitles ?? {},
        });
        setApplyTargetSheet(null);
        void queryClient.invalidateQueries({
          queryKey: ['settings-screen', variables.sourceChatId],
        });
        maxNotify('warning');
        return;
      }
      if (activeChatIdRef.current !== variables.sourceChatId) return;
      const { resolveChatSettingsSaveError } = await import('../lib/chat-settings-save-error');
      if (activeChatIdRef.current !== variables.sourceChatId) return;
      const persisted = settingsQuery.data;
      if (variables.isCurrentScope?.() === false) return;
      if (variables.section === 'stopWords') {
        await handleStopWordsSaveError(error);
        if (variables.isCurrentScope?.() === false) return;
      }
      const resolution = resolveChatSettingsSaveError(
        error,
        persisted ? normalizeRequiredSubscriptionDraftSettings(persisted) : null,
        SECTION_SETTING_KEYS[variables.section],
      );
      if (resolution?.kind === 'permission' && (sourceSaved || resolution.revert)) {
        if (!sourceSaved) {
          setDraft((current) => (current ? (resolution.revert?.(current) ?? current) : current));
        }
        pendingPermissionRetryRef.current = null;
        setPermissionBlocker(resolution.blocker);
        setApplyTargetSheet(null);
        maxNotify('error');
        return;
      }
      if (resolution?.kind === 'concurrent') {
        setApplyTargetSheet(null);
        pushToast({
          tone: 'info',
          title: resolution.title,
          description: resolution.description,
        });
        maxNotify('warning');
        return;
      }
      pushToast({
        tone: 'danger',
        title: 'Не удалось применить настройки',
        description: formatApiError(error),
      });
      maxNotify('error');
    },
  });
  const isApplyingSectionToAll = applySectionToAllMutation.isPending;
  const applyingSection = applySectionToAllMutation.variables?.section ?? null;

  useEffect(() => {
    if (!chatId || !applyTargetSheet) {
      setApplyTargetPreview(null);
      setApplyTargetPreviewError(null);
      setApplyTargetPreviewLoading(false);
      return;
    }

    let cancelled = false;
    const requestEpoch = favoritesCompositionEpoch;
    setApplyTargetPreviewEpoch(null);
    setApplyTargetPreview(null);
    setApplyTargetPreviewLoading(true);
    setApplyTargetPreviewError(null);

    void previewApplySettingsSectionTarget(api, chatId, applyTargetSheet.target)
      .then((preview) => {
        if (cancelled || favoritesCompositionEpochRef.current !== requestEpoch) {
          return;
        }

        setApplyTargetPreviewEpoch(requestEpoch);
        setApplyTargetPreview(preview);
      })
      .catch((error: unknown) => {
        if (cancelled || favoritesCompositionEpochRef.current !== requestEpoch) {
          return;
        }

        setApplyTargetPreviewEpoch(requestEpoch);
        setApplyTargetPreview(null);
        setApplyTargetPreviewError(formatApiError(error));
      })
      .finally(() => {
        if (!cancelled && favoritesCompositionEpochRef.current === requestEpoch) {
          setApplyTargetPreviewLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [api, applyTargetSheet, chatId, favoritesCompositionEpoch]);

  const addDomainMutation = useMutation({
    mutationFn: (payload: { domain: string; kind: NavigationAllowlistKind }) =>
      addDomain(api, chatId ?? '', payload),
    onSuccess: async (_, payload) => {
      setDomainInput('');
      setDomainInputError('');
      await queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
      pushToast({
        tone: 'success',
        title: getNavigationAllowlistTargetOption(payload.kind).successTitle,
      });
    },
    onError: (error, payload) => {
      setDomainInputError(formatApiError(error));
      pushToast({
        tone: 'danger',
        title: getNavigationAllowlistTargetOption(payload.kind).errorTitle,
        description: formatApiError(error),
      });
    },
  });

  const removeDomainMutation = useMutation({
    mutationFn: (domain: string) => removeDomain(api, chatId ?? '', domain),
    onSuccess: async () => {
      setScheduleDomain(null);
      setScheduleError('');
      await queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
      pushToast({ tone: 'success', title: 'Удалено из разрешённых целей' });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось удалить правило',
        description: formatApiError(error),
      });
    },
  });

  const scheduleDomainRemovalMutation = useMutation({
    mutationFn: (payload: { domain: string; removeAfterAt: string | null }) =>
      scheduleDomainRemoval(api, chatId ?? '', payload.domain, payload.removeAfterAt),
    onSuccess: async (_, payload) => {
      setScheduleError('');
      setScheduleDomain(null);
      await queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
      if (payload.removeAfterAt) {
        pushToast({
          tone: 'success',
          title: 'Удаление правила запланировано',
          description: `Правило будет удалено ${formatRemovalDateTime(payload.removeAfterAt)}.`,
        });
        return;
      }

      pushToast({ tone: 'success', title: 'Отложенное удаление отменено' });
    },
    onError: (error) => {
      setScheduleError(formatApiError(error));
      pushToast({
        tone: 'danger',
        title: 'Не удалось обновить расписание удаления',
        description: formatApiError(error),
      });
    },
  });

  const sendBroadcastTestMutation = useMutation({
    mutationFn: (payload: SendBroadcastPayload) => sendBroadcastTest(api, chatId ?? '', payload),
    onSuccess: () => {
      pushToast({
        tone: 'success',
        title: 'Тест отправлен',
      });
      maxNotify('success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Тест не отправлен',
        description: formatApiError(error),
      });
      maxNotify('error');
    },
  });

  const clearBroadcastHandoffMutation = useMutation({
    mutationFn: () => clearBroadcastHandoffState(api, chatId ?? ''),
    onSuccess: () => {
      appliedBroadcastHandoffSignatureRef.current = null;
      resetMailingComposer();
      void queryClient.invalidateQueries({ queryKey: ['broadcast-handoff-state', chatId] });
      pushToast({
        tone: 'info',
        title: 'Черновик очищен',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось очистить черновик',
        description: formatApiError(error),
      });
    },
  });

  const invalidateChatAutopostData = () => {
    void queryClient.invalidateQueries({ queryKey: ['managed-autopost-rules', chatId] });
    void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
    void queryClient.invalidateQueries({ queryKey: ['managed-broadcast-calendar', chatId] });
  };

  const updateManagedAutopostRuleMutation = useMutation({
    mutationFn: ({
      ruleId,
      payload,
      status,
    }: {
      ruleId: string;
      payload?: SendBroadcastPayload;
      status?: 'ACTIVE' | 'PAUSED';
    }) =>
      updateManagedAutopostRule(api, chatId ?? '', ruleId, {
        ...(payload
          ? {
              payload: normalizeManagedAutopostPayload(payload),
            }
          : {}),
        ...(status ? { status } : {}),
      }),
    onSuccess: (rule) => {
      invalidateChatAutopostData();
      const savedEditingRule = editingManagedAutopostRule?.id === rule.id;
      if (savedEditingRule) {
        resetMailingComposer();
        setMailingWorkspaceView('autoposts');
      }
      pushToast({
        tone: rule.status === 'PAUSED' ? 'info' : 'success',
        title: savedEditingRule
          ? 'Автопост сохранён'
          : rule.status === 'PAUSED'
            ? 'Пауза'
            : 'Автопост запущен',
      });
      maxNotify(rule.status === 'PAUSED' ? 'warning' : 'success');
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось обновить автопост',
        description: formatApiError(error),
      });
      maxNotify('error');
    },
  });

  const deleteManagedAutopostRuleMutation = useMutation({
    mutationFn: (ruleId: string) => deleteManagedAutopostRule(api, chatId ?? '', ruleId),
    onSuccess: () => {
      invalidateChatAutopostData();
      if (deleteManagedAutopostRuleMutation.variables === editingManagedAutopostRule?.id) {
        resetMailingComposer();
      }
      setManagedAutopostRuleDeleteTarget(null);
      pushToast({ tone: 'info', title: 'Автопост отменён' });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось отменить автопост',
        description: formatApiError(error),
      });
      maxNotify('error');
    },
  });

  const updateManagedBroadcastMutation = useMutation({
    mutationFn: ({
      broadcastId,
      payload,
    }: {
      broadcastId: string;
      payload: SendBroadcastPayload;
    }) => updateManagedBroadcast(api, chatId ?? '', broadcastId, payload),
    onSuccess: (broadcast) => {
      void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
      void queryClient.invalidateQueries({ queryKey: ['managed-broadcast-calendar', chatId] });
      resetMailingComposer();
      pushToast({
        tone: broadcast.status === 'FAILED' ? 'info' : 'success',
        title: 'Автопостинг обновлён',
        description: broadcast.nextSendAt
          ? `Следующая отправка: ${formatRemovalDateTime(
              broadcast.nextSendAt,
              broadcast.scheduleTimezone,
            )}.`
          : 'Изменения сохранены.',
      });
    },
    onError: (error) => {
      const description = reportMailingAudienceApiError(error);
      pushToast({
        tone: 'danger',
        title: 'Не удалось обновить автопостинг',
        description,
      });
    },
  });

  const cancelManagedBroadcastMutation = useMutation({
    mutationFn: (broadcastId: string) => cancelManagedBroadcast(api, chatId ?? '', broadcastId),
    onSuccess: (broadcast) => {
      void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
      void queryClient.invalidateQueries({ queryKey: ['managed-broadcast-calendar', chatId] });
      setManagedBroadcastDeleteTarget(null);
      if (editingManagedBroadcast?.id === broadcast.id) {
        resetMailingComposer();
      }
      pushToast({
        tone: 'info',
        title: 'Отправки отменены',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось отменить',
        description: formatApiError(error),
      });
    },
  });

  const retryManagedBroadcastMutation = useMutation({
    mutationFn: (broadcastId: string) => retryManagedBroadcast(api, chatId ?? '', broadcastId),
    onSuccess: (broadcast) => {
      void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
      void queryClient.invalidateQueries({ queryKey: ['managed-broadcast-calendar', chatId] });
      pushToast({
        tone: broadcast.status === 'FAILED' || broadcast.status === 'PARTIAL' ? 'info' : 'success',
        title:
          broadcast.status === 'FAILED' || broadcast.status === 'PARTIAL'
            ? 'Часть чатов все еще с ошибкой'
            : 'Повтор выполнен',
        description: broadcast.nextSendAt
          ? `Следующая отправка: ${formatRemovalDateTime(
              broadcast.nextSendAt,
              broadcast.scheduleTimezone,
            )}.`
          : 'Ошибка закрыта.',
      });
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось повторить автопостинг',
        description: formatApiError(error),
      });
    },
  });

  function applyManagedBroadcastToMailingComposer(broadcast: ManagedBroadcastDetails) {
    const targetChatIds = normalizeBroadcastAudienceTargetChatIds(broadcast.targetChatIds);
    setEditingManagedAutopostRule(null);
    setEditingManagedBroadcast(broadcast);
    setMailingTargetMode(broadcast.targetMode);
    setMailingTargetChatIds(
      broadcast.targetMode === 'selected' && targetChatIds.length === 0
        ? chatId
          ? [chatId]
          : []
        : targetChatIds,
    );
    setMailingLastScopedTargetMode(
      resolveBroadcastAudienceLastScopedMode({
        targetMode: broadcast.targetMode,
        targetChatIds,
        currentChatId: chatId ?? undefined,
      }),
    );
    setMailingAudienceError('');
    setMailingText(broadcast.text);
    setMailingButtons(broadcast.buttons);
    applyMailingImages(resolveBroadcastImagesFromLegacyFields(broadcast));
    setMailingVideoCleared(false);
    const restoredTimingMode: BroadcastTimingMode =
      broadcast.scheduleMode === 'calendar'
        ? 'scheduled'
        : broadcast.cycleEnabled
          ? 'cycle'
          : broadcast.nextSendAt
            ? 'scheduled'
            : 'now';
    setMailingTimingMode(restoredTimingMode);
    setMailingCycleDraft(
      normalizeBroadcastCycleDraft({
        startMode: broadcast.nextSendAt ? 'later' : 'now',
        startAt: broadcast.nextSendAt ?? createDefaultBroadcastCycleDraft().startAt,
        everyHours: broadcast.cycleEveryHours,
        count: Math.max(2, broadcast.cycleCount),
      }),
    );
    setMailingScheduledSlots(
      sortAndUniqueBroadcastSlots(
        broadcast.scheduleMode === 'calendar'
          ? broadcast.scheduledSlots
          : broadcast.nextSendAt && !broadcast.cycleEnabled
            ? [broadcast.nextSendAt]
            : [],
      ),
    );
    setMailingScheduleTimezone(
      broadcast.scheduleTimezone.trim() || resolveBroadcastScheduleTimezone(),
    );
    setMailingTextError('');
    setMailingButtonErrors([]);
    setMailingImageError('');
    setMailingScheduleError('');
    setMailingCycleError('');
    resetMailingPlanner();
    setMailingWorkspaceView('compose');
    setExpandedSections((current) => ({ ...current, mailing: true }));
  }

  const openManagedBroadcastEditorMutation = useMutation({
    mutationFn: (broadcastId: string) => getManagedBroadcast(api, chatId ?? '', broadcastId),
    retry: (failureCount, error) => shouldRetryTransientApiError(failureCount, error, 2),
    onSuccess: (broadcast) => {
      applyManagedBroadcastToMailingComposer(broadcast);
    },
    onError: (error) => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось открыть автопостинг',
        description: formatApiError(error),
      });
    },
  });

  function setFieldValue<K extends keyof ChatSettings>(key: K, value: ChatSettings[K]) {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
    clearFieldError(key);
  }

  function setBotSpeechMediaImage(key: BotSpeechMediaFieldKey, image: BotSpeechMediaImage | null) {
    setDraft((current) => {
      if (!current) {
        return current;
      }

      const nextMedia = { ...current.botSpeechMedia };
      if (image?.base64) {
        nextMedia[key] = image;
      } else {
        delete nextMedia[key];
      }
      return { ...current, botSpeechMedia: nextMedia };
    });
    clearFieldError('botSpeechMedia');
  }

  function clearButtonGroupErrors(group: ChatSettingsButtonGroup) {
    clearFieldError(group.buttonsKey);
    clearFieldError(group.urlKey);
    clearFieldError(group.textKey);
  }

  function updateDraftButtonGroup(
    group: ChatSettingsButtonGroup,
    options: {
      buttons?: BroadcastLinkButton[];
      enabled?: boolean;
    },
  ) {
    setDraft((current) => {
      if (!current) {
        return current;
      }

      const nextButtons = options.buttons ?? current[group.buttonsKey];
      const buttonState = buildBroadcastLinkButtonLegacyFields(nextButtons);

      return {
        ...current,
        [group.buttonsKey]: nextButtons,
        [group.enabledKey]: options.enabled ?? current[group.enabledKey],
        [group.urlKey]: buttonState.buttonUrl,
        [group.textKey]: buttonState.buttonText,
      };
    });
    clearButtonGroupErrors(group);
  }

  function updateAdminContactButtonGroup(
    group: AdminContactButtonGroup,
    enabled: boolean,
    url: string,
  ) {
    setDraft((current) =>
      current
        ? ({
            ...current,
            [group.enabledKey]: enabled,
            [group.urlKey]: enabled ? url : '',
          } as ChatSettings)
        : current,
    );
    clearFieldError(group.enabledKey);
    clearFieldError(group.urlKey);
  }

  function renderAdminContactToggle(
    group: AdminContactButtonGroup,
    ariaLabel = 'Добавить связь с админом в сообщение бота',
  ) {
    if (!draft || !chatId) {
      return null;
    }

    return (
      <AdminContactToggle
        key={`${chatId}:${group.urlKey}`}
        api={api}
        chatId={chatId}
        title={ADMIN_CONTACT_BUTTON_TEXT}
        checked={Boolean(draft[group.enabledKey])}
        url={draft[group.urlKey]}
        onChange={(enabled, url) => updateAdminContactButtonGroup(group, enabled, url)}
        ariaLabel={ariaLabel}
        nested
      />
    );
  }

  function revealStopWordsFeedback(
    target: StopWordsFocusTarget | null,
    message: string | null = null,
  ) {
    const sites =
      target?.field === 'stopWordsPolicy.domains' ||
      (expandedSections.links && target?.field !== 'stopWordsPolicy.rules');
    setExpandedSections({ ...INITIAL_EXPANDED_SECTIONS, [sites ? 'links' : 'stopWords']: true });
    setStopWordsModuleError(message);
    if (target)
      setStopWordsFocusRequest({ ...target, requestId: ++stopWordsFocusSequenceRef.current });
  }
  function revealSharedStopWordsErrors() {
    const feedback = mapStopWordsValidationIssues(
      Object.entries(sharedFieldErrors).map(([path, message]) => ({
        path: path.split('.'),
        message,
      })),
    );
    if (feedback.first || feedback.moduleError)
      revealStopWordsFeedback(feedback.first, feedback.moduleError);
  }
  function revealSharedSettingsErrors() {
    if (sharedFieldErrors.linkRulesPolicy) {
      setExpandedSections({ ...INITIAL_EXPANDED_SECTIONS, links: true });
      requestAnimationFrame(() => {
        const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
          '.links-panel__editor input, .links-panel__editor textarea',
        );
        input?.focus();
        input?.scrollIntoView({ block: 'center' });
      });
      return;
    }
    revealSharedStopWordsErrors();
  }
  function applyStopWordsServerValidation(error: unknown) {
    if (!(error instanceof ApiRequestError) || error.status !== 400) return;
    const issues = Array.isArray(error.payload?.issues) ? error.payload.issues : [];
    const normalized = issues.flatMap((issue) => {
      if (
        !issue ||
        typeof issue !== 'object' ||
        Array.isArray(issue) ||
        !Array.isArray(issue.path) ||
        typeof issue.message !== 'string' ||
        !issue.path.every(
          (part: unknown) =>
            typeof part === 'string' || (typeof part === 'number' && Number.isSafeInteger(part)),
        )
      )
        return [];
      return [
        {
          path: issue.path.map((part: string | number, index: number) =>
            index === 0 && part === 'policy' ? 'stopWordsPolicy' : part,
          ),
          message: issue.message.slice(0, 500),
        },
      ];
    });
    const feedback = mapStopWordsValidationIssues(normalized);
    setSharedFieldErrors((current) => ({ ...current, ...feedback.errors }));
    revealStopWordsFeedback(
      feedback.first,
      feedback.moduleError ?? (feedback.first ? null : 'Проверьте настройки стоп-слов.'),
    );
  }
  function validateDraft(value: ChatSettings, section?: ApplySectionKey): ChatSettings | null {
    if (isReloadingStopWords) return null;
    const paths = section ? new Set(settingsSectionPaths('chat', section)) : null;
    if (Object.keys(sharedFieldErrors).some((path) => !paths || paths.has(path))) {
      if (section === 'stopWords') revealSharedStopWordsErrors();
      else revealSharedSettingsErrors();
      return null;
    }
    if (
      stopWordsStorageLocked &&
      JSON.stringify(value.stopWordsPolicy) !== JSON.stringify(settingsQuery.data?.stopWordsPolicy)
    ) {
      revealStopWordsFeedback(null, 'Подтвердите замену сохранённого списка.');
      return null;
    }
    const normalizedValue = normalizeRequiredSubscriptionDraftSettings(value);
    const parsed = updateSettingsRequestSchema.safeParse(normalizedValue);

    if (parsed.success) {
      const normalizedParsed = normalizeRequiredSubscriptionDraftSettings(parsed.data);
      const nextErrors: FieldErrors = {};

      if (
        normalizedParsed.requiredSubscriptionEnabled &&
        selectedUnavailableRequiredSubscriptionChannels.length > 0
      ) {
        nextErrors.requiredSubscriptionChannelIds =
          'Удалите недоступные чаты или каналы без рабочей ссылки и выберите их заново.';
      }

      if (Object.keys(nextErrors).length === 0) {
        setFieldErrors({});
        setStopWordsModuleError(null);
        return normalizedParsed;
      }

      setFieldErrors(nextErrors);
      return null;
    }

    const nextErrors: FieldErrors = {};
    const stopFeedback = mapStopWordsValidationIssues(parsed.error.issues);
    if (stopFeedback.first || stopFeedback.moduleError) {
      setSharedFieldErrors((current) => ({ ...current, ...stopFeedback.errors }));
      revealStopWordsFeedback(stopFeedback.first, stopFeedback.moduleError);
    }
    for (const issue of parsed.error.issues) {
      const key = issue.path[0] as keyof ChatSettings | undefined;
      if (key === 'stopWordsPolicy') continue;
      if (!key || nextErrors[key]) {
        continue;
      }
      nextErrors[key] = issue.message;
    }

    setFieldErrors(nextErrors);
    return null;
  }

  function applyDuplicateFlowConfig(overrides: {
    allowedCount?: number;
    windowSec?: number;
    duplicateBotMessageEnabled?: boolean;
    duplicateWarnEnabled?: boolean;
    duplicateMuteEnabled?: boolean;
    duplicateBanEnabled?: boolean;
  }) {
    setDraft((current) => {
      if (!current) {
        return current;
      }

      const duplicateBotMessageEnabled =
        overrides.duplicateBotMessageEnabled ?? current.duplicateBotMessageEnabled;
      const duplicateWarnEnabled = overrides.duplicateWarnEnabled ?? current.duplicateWarnEnabled;
      const duplicateMuteEnabled = overrides.duplicateMuteEnabled ?? current.duplicateMuteEnabled;
      const duplicateBanEnabled = overrides.duplicateBanEnabled ?? current.duplicateBanEnabled;
      const allowedCount = overrides.allowedCount ?? resolveDuplicateAllowedCount(current);
      const windowSec = overrides.windowSec ?? resolveDuplicateSharedWindowSec(current);

      return {
        ...current,
        duplicateBotMessageEnabled,
        duplicateWarnEnabled,
        duplicateMuteEnabled,
        duplicateBanEnabled,
        ...buildDuplicateFlowSettings({
          duplicateBotMessageEnabled,
          duplicateWarnEnabled,
          duplicateMuteEnabled,
          duplicateBanEnabled,
          allowedCount,
          windowSec,
        }),
      };
    });

    clearFieldError('duplicateWarnWindowSec');
    clearFieldError('duplicateWarnMaxCount');
    clearFieldError('duplicateMuteWindowSec');
    clearFieldError('duplicateMuteMaxCount');
    clearFieldError('duplicateBanWindowSec');
    clearFieldError('duplicateBanMaxCount');
  }

  function handleDuplicateWindowHoursChange(rawValue: string) {
    setDuplicateWindowInputValue(rawValue);

    const normalized = rawValue.trim();
    if (normalized.length === 0) {
      return;
    }

    const hours = Number(normalized);
    if (!Number.isFinite(hours)) {
      return;
    }

    const safeHours = Math.min(DUPLICATE_WINDOW_MAX_SEC / 3_600, Math.max(1, Math.round(hours)));
    applyDuplicateFlowConfig({ windowSec: safeHours * 3600 });
  }

  function handleDuplicateWindowHoursBlur() {
    const rawValue = duplicateWindowInputValue;
    const normalized = rawValue?.trim() ?? '';
    const parsed = normalized ? Number(normalized) : Number.NaN;

    const fallbackHours = draft ? secondsToHours(resolveDuplicateSharedWindowSec(draft)) : 1;
    const safeHours = !Number.isFinite(parsed)
      ? fallbackHours
      : Math.min(DUPLICATE_WINDOW_MAX_SEC / 3_600, Math.max(1, Math.round(parsed)));
    applyDuplicateFlowConfig({ windowSec: safeHours * 3600 });
    setDuplicateWindowInputValue(null);
  }

  function setMuteDurationValue(key: AutoMuteDurationKey, nextValue: number) {
    const safeValue = Math.min(
      AUTO_MUTE_DURATION_MAX_HOURS,
      Math.max(AUTO_MUTE_DURATION_MIN_HOURS, Math.round(nextValue)),
    );
    setFieldValue(key, safeValue as ChatSettings[AutoMuteDurationKey]);
  }

  function adjustMuteDuration(key: AutoMuteDurationKey, deltaHours: number) {
    if (!draft) {
      return;
    }

    setMuteDurationValue(key, Number(draft[key]) + deltaHours);
  }

  function adjustDeleteBotMessagesDelayValue(
    key: 'deleteBotMessagesDelayMinutes' | 'greetingDeleteBotMessageDelayMinutes',
    direction: number,
  ) {
    if (!draft) {
      return;
    }

    const next = stepDeleteBotMessagesDelayMinutes(Number(draft[key]), direction);

    setFieldValue(key, next as ChatSettings[typeof key]);
  }

  function adjustDeleteBotMessagesDelay(direction: number) {
    adjustDeleteBotMessagesDelayValue('deleteBotMessagesDelayMinutes', direction);
  }

  function adjustStickerMessageCooldown(deltaMinutes: number) {
    if (!draft) {
      return;
    }

    const next = Math.min(
      STICKER_COOLDOWN_MAX_MINUTES,
      Math.max(
        STICKER_COOLDOWN_MIN_MINUTES,
        Number(draft.stickerMessageCooldownMinutes) + deltaMinutes,
      ),
    );

    setFieldValue(
      'stickerMessageCooldownMinutes',
      next as ChatSettings['stickerMessageCooldownMinutes'],
    );
  }

  function adjustDuplicateAllowedCount(currentValue: number, delta: number) {
    if (!draft) {
      return;
    }

    const next = Math.min(
      resolveDuplicateAllowedCountMax(draft),
      Math.max(DUPLICATE_ALLOWED_COUNT_MIN, Number(currentValue) + delta),
    );
    applyDuplicateFlowConfig({ allowedCount: next });
  }

  function applyDuplicateDetectionPreset(preset: DuplicateDetectionPreset) {
    setDraft((current) => {
      if (!current) {
        return current;
      }

      return {
        ...current,
        duplicateDetectionPreset: preset,
        ...(preset === 'STANDARD'
          ? {
              duplicateIgnoreLinksEnabled: false,
              duplicateIgnorePhonesEnabled: false,
              duplicateNearMatchEnabled: false,
            }
          : preset === 'STRICT'
            ? {
                duplicateIgnoreLinksEnabled: true,
                duplicateIgnorePhonesEnabled: true,
                duplicateNearMatchEnabled: true,
              }
            : {}),
      };
    });
    clearFieldError('duplicateDetectionPreset');
    clearFieldError('duplicateIgnoreLinksEnabled');
    clearFieldError('duplicateIgnorePhonesEnabled');
    clearFieldError('duplicateNearMatchEnabled');
  }

  function handleAddDomain() {
    if (!chatId || isDomainMutationPending) {
      return;
    }

    const inputOption = getNavigationAllowlistTargetOption(domainInputKind);
    const normalizedInput = normalizeNavigationAllowlistTarget(domainInput, domainInputKind);
    const normalizedValue = normalizeStoredNavigationAllowlistEntry(domainInput, domainInputKind);

    if (!normalizedInput || !normalizedValue) {
      setDomainInputError(inputOption.invalidMessage);
      return;
    }

    const alreadyExists = (domainsQuery.data ?? []).some(
      (item) => item.normalizedValue === normalizedValue,
    );
    if (alreadyExists) {
      setDomainInputError('');
      setDomainInput('');
      pushToast({ title: 'Такое правило уже есть в списке' });
      return;
    }

    setDomainInputError('');
    addDomainMutation.mutate({
      domain: normalizedInput,
      kind: domainInputKind,
    });
  }

  function toggleDomainScheduleEditor(entry: DomainAllowlistEntry) {
    if (scheduleDomain === entry.normalizedValue) {
      setScheduleDomain(null);
      setScheduleError('');
      return;
    }

    const initial = parseIsoToLocalDateTime(entry.removeAfterAt);
    setScheduleDate(initial.date);
    setScheduleTime(initial.time);
    setScheduleError('');
    setScheduleDomain(entry.normalizedValue);
  }

  function submitDomainSchedule(domain: string) {
    if (!chatId || isDomainMutationPending) {
      return;
    }

    if (!scheduleDate) {
      setScheduleError('Сначала выберите день удаления.');
      return;
    }

    if (!scheduleTime) {
      setScheduleError('Сначала выберите время удаления.');
      return;
    }

    const scheduledAt = new Date(`${scheduleDate}T${scheduleTime}:00`);
    if (Number.isNaN(scheduledAt.getTime())) {
      setScheduleError('Не удалось распознать дату и время.');
      return;
    }

    if (scheduledAt.getTime() <= Date.now() + DOMAIN_REMOVAL_MIN_FUTURE_MS) {
      setScheduleError('Укажите время в будущем.');
      return;
    }

    setScheduleError('');
    scheduleDomainRemovalMutation.mutate({
      domain,
      removeAfterAt: scheduledAt.toISOString(),
    });
  }

  function clearDomainSchedule(domain: string) {
    if (!chatId || isDomainMutationPending) {
      return;
    }

    setScheduleError('');
    scheduleDomainRemovalMutation.mutate({
      domain,
      removeAfterAt: null,
    });
  }

  function handleManagedPostLinkClick(event: MouseEvent<HTMLElement>, url: string) {
    if (!(window.MAX?.WebApp ?? window.WebApp)) {
      return;
    }

    event.preventDefault();
    openMaxBotLink(url);
  }

  function resetMailingComposer() {
    setEditingManagedBroadcast(null);
    setEditingManagedAutopostRule(null);
    setMailingTargetMode('current');
    setMailingTargetChatIds(chatId ? [chatId] : []);
    setMailingLastScopedTargetMode('current');
    setMailingAudienceError('');
    setMailingText('');
    setMailingButtons([]);
    resetMailingImages();
    setMailingVideoCleared(false);
    setMailingTimingMode('now');
    setMailingCycleDraft(createDefaultBroadcastCycleDraft());
    setMailingScheduledSlots([]);
    setMailingScheduleTimezone(resolveBroadcastScheduleTimezone());
    setMailingScheduleEnabled(false);
    setMailingScheduleDays(0);
    setMailingScheduleTime(toLocalTimeInputValue(new Date(Date.now() + BROADCAST_HOUR_MS)));
    setMailingCycleEnabled(false);
    setMailingCycleEveryHours(MIN_BROADCAST_CYCLE_HOURS);
    setMailingCycleCount(2);
    setMailingTextError('');
    setMailingButtonErrors([]);
    setMailingImageError('');
    setMailingScheduleError('');
    setMailingCycleError('');
    setPendingMailingSlotConflict(null);
    setPendingMailingPublishReview(null);
    setMailingButtonsSheetOpen(false);
    setMailingWorkspaceView('compose');
    resetMailingPlanner();
  }

  function handleCancelMailingEdit() {
    resetMailingComposer();
  }

  function handleClearMailingComposer() {
    if (editingManagedBroadcast || editingManagedAutopostRule) {
      handleCancelMailingEdit();
      return;
    }

    if (!chatId || clearBroadcastHandoffMutation.isPending) {
      resetMailingComposer();
      return;
    }

    clearBroadcastHandoffMutation.mutate();
  }

  function handleMailingAllChatsToggle(enabled: boolean) {
    setMailingAudienceError('');
    if (enabled) {
      setMailingTargetMode('all');
      return;
    }

    const savedTargetChatIds = normalizeBroadcastAudienceTargetChatIds(mailingTargetChatIds);
    if (savedTargetChatIds.length === 0) {
      setMailingTargetChatIds(chatId ? [chatId] : []);
      setMailingTargetMode('current');
      setMailingLastScopedTargetMode('current');
      return;
    }

    setMailingTargetChatIds(savedTargetChatIds);
    setMailingTargetMode(
      restoreBroadcastAudienceModeFromAll({
        lastScopedMode: mailingLastScopedTargetMode,
        targetChatIds: savedTargetChatIds,
      }),
    );
  }

  function handleMailingScopedTargetModeChange(value: string) {
    const nextMode: BroadcastScopedTargetMode = value === 'selected' ? 'selected' : 'current';
    setMailingAudienceError('');
    setMailingLastScopedTargetMode(nextMode);
    setMailingTargetMode(nextMode);
    if (nextMode === 'selected') {
      setMailingTargetChatIds((current) => {
        const normalized = normalizeBroadcastAudienceTargetChatIds(current);
        if (normalized.length > 0) {
          return normalized;
        }

        return chatId ? [chatId] : [];
      });
    }
  }

  function handleApplyMailingAudienceSelection(nextSelection: string[]) {
    const normalizedSelection = normalizeBroadcastAudienceTargetChatIds(nextSelection);
    setMailingTargetChatIds(normalizedSelection);
    setMailingLastScopedTargetMode('selected');
    setMailingTargetMode('selected');
    setMailingAudienceError('');
  }

  function handleRefreshMailingAudienceChoices() {
    startTransition(() => {
      setChatsListRefreshRequest((current) => ({
        nonce: current.nonce + 1,
        behavior: 'manual',
      }));
    });
  }

  function reportMailingAudienceApiError(error: unknown) {
    const scheduleConflict = resolveBroadcastScheduleConflict(error);
    const message = formatApiError(error);
    if (
      message.toLowerCase().includes('выбранные чаты') ||
      message.toLowerCase().includes('выберите хотя бы один чат')
    ) {
      setMailingAudienceError('Обновите выбор чатов.');
    }
    if (scheduleConflict === 'target') {
      setMailingScheduleError('Занято у получателя.');
      void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
      void queryClient.invalidateQueries({ queryKey: ['managed-broadcast-calendar', chatId] });
    } else if (scheduleConflict === 'slot') {
      setMailingScheduleError('Занято.');
      void queryClient.invalidateQueries({ queryKey: ['settings-screen', chatId] });
      void queryClient.invalidateQueries({ queryKey: ['managed-broadcast-calendar', chatId] });
    }
    return message;
  }

  function handleMailingPlannerStateChange(nextState: BroadcastSchedulePlannerSelectionState) {
    setMailingPlannerState((current) =>
      areBroadcastPlannerStatesEqual(current, nextState) ? current : nextState,
    );
  }

  function handleDeleteManagedBroadcast(broadcast: ManagedBroadcastListItem) {
    if (!chatId || cancelManagedBroadcastMutation.isPending) {
      return;
    }

    setManagedBroadcastDeleteTarget(broadcast);
  }

  function handleEditManagedBroadcast(broadcast: ManagedBroadcastListItem) {
    if (!chatId || openManagedBroadcastEditorMutation.isPending) {
      return;
    }

    openManagedBroadcastEditorMutation.mutate(broadcast.id);
  }

  function handleDeleteManagedBroadcastById(broadcastId: string) {
    const broadcast = managedBroadcasts.find((item) => item.id === broadcastId);
    if (!broadcast) {
      return;
    }

    handleDeleteManagedBroadcast(broadcast);
  }

  function handleEditManagedBroadcastById(broadcastId: string) {
    const broadcast = managedBroadcasts.find((item) => item.id === broadcastId);
    if (!broadcast) {
      return;
    }

    handleEditManagedBroadcast(broadcast);
  }

  function confirmDeleteManagedBroadcast() {
    if (!managedBroadcastDeleteTarget || !chatId || cancelManagedBroadcastMutation.isPending) {
      return;
    }

    cancelManagedBroadcastMutation.mutate(managedBroadcastDeleteTarget.id);
  }

  function handleDeleteManagedAutopostRule(rule: ManagedAutopostRuleSummary) {
    setManagedAutopostRuleDeleteTarget(rule);
  }

  function confirmDeleteManagedAutopostRule() {
    if (
      !managedAutopostRuleDeleteTarget ||
      !chatId ||
      deleteManagedAutopostRuleMutation.isPending
    ) {
      return;
    }

    deleteManagedAutopostRuleMutation.mutate(managedAutopostRuleDeleteTarget.id);
  }

  function handleMailingButtonsEnabledChange(enabled: boolean) {
    if (enabled) {
      if (mailingButtons.length === 0) {
        setMailingButtonRevealSignal((current) => current + 1);
      }
      setMailingButtons((current) =>
        current.length > 0 ? current : [createEmptyBroadcastLinkButton()],
      );
      return;
    }

    setMailingButtons([]);
    setMailingButtonErrors([]);
  }

  function validateMailingButtonDraft() {
    const nextErrors = validateBroadcastLinkButtons(normalizedMailingButtons);
    setMailingButtonErrors(nextErrors);
    return !hasBroadcastLinkButtonErrors(nextErrors);
  }

  function buildMailingPublishBasePayload(): BroadcastHandoffPayload {
    const buttonState = buildBroadcastLinkButtonLegacyFields(normalizedMailingButtons);
    const scheduledSlots = sortAndUniqueBroadcastSlots(mailingScheduledSlots);
    const cycleDraft = normalizeBroadcastCycleDraft(mailingCycleDraft);
    const isCalendarSchedule = mailingTimingMode === 'scheduled';
    const isCycleSchedule = mailingTimingMode === 'cycle';
    const audiencePayload = resolveBroadcastAudiencePayload({
      targetMode: mailingTargetMode,
      targetChatIds: mailingTargetChatIds,
      currentChatId: chatId ?? undefined,
    });

    return {
      targetMode: audiencePayload.targetMode,
      targetChatIds: audiencePayload.targetChatIds,
      applyToAllChats: audiencePayload.applyToAllChats,
      buttons: buttonState.buttons,
      buttonEnabled: buttonState.buttonEnabled,
      buttonUrl: buttonState.buttonUrl,
      buttonText: buttonState.buttonText,
      scheduleMode: isCalendarSchedule ? 'calendar' : 'legacy',
      scheduleTimezone: mailingScheduleTimezone.trim() || resolveBroadcastScheduleTimezone(),
      scheduledSlots: isCalendarSchedule ? scheduledSlots : [],
      sendAt: isCycleSchedule ? resolveBroadcastCycleSendAt(cycleDraft) : null,
      cycleEnabled: isCycleSchedule,
      cycleEveryHours: isCycleSchedule ? cycleDraft.everyHours : 1,
      cycleCount: isCycleSchedule ? cycleDraft.count : 1,
    };
  }

  function buildMailingTestPayload(): SendBroadcastPayload {
    const buttonState = buildBroadcastLinkButtonLegacyFields(normalizedMailingButtons);
    const videoSource = mailingVideoSource;
    const keepVideoMedia =
      !mailingVideoCleared &&
      !mailingImageEnabled &&
      videoSource?.mediaType === 'video' &&
      videoSource.mediaPayload;

    return {
      text: mailingText.trim(),
      textFormat: 'markdown',
      targetMode: 'current',
      targetChatIds: chatId ? [chatId] : [],
      applyToAllChats: false,
      buttons: buttonState.buttons,
      buttonEnabled: buttonState.buttonEnabled,
      buttonUrl: buttonState.buttonUrl,
      buttonText: buttonState.buttonText,
      imageEnabled: mailingImageEnabled,
      imageBase64: mailingImageEnabled ? mailingImageBase64 : '',
      imageMimeType: mailingImageEnabled ? mailingImageMimeType : '',
      imageFileName: mailingImageEnabled ? mailingImageFileName : '',
      images: mailingImageEnabled ? mailingImages : [],
      mediaType: keepVideoMedia ? 'video' : null,
      mediaPayload: keepVideoMedia ? (videoSource?.mediaPayload ?? null) : null,
      mediaMimeType: keepVideoMedia ? (videoSource?.mediaMimeType ?? '') : '',
      mediaFileName: keepVideoMedia ? (videoSource?.mediaFileName ?? '') : '',
      scheduleMode: 'legacy',
      scheduleTimezone: mailingScheduleTimezone.trim() || resolveBroadcastScheduleTimezone(),
      scheduledSlots: [],
      sendAt: null,
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: 1,
    };
  }

  function submitMailingPayload(broadcastId: string | null, payload: SendBroadcastPayload) {
    if (broadcastId) {
      updateManagedBroadcastMutation.mutate({
        broadcastId,
        payload,
      });
      return;
    }

    if (hasLegacyBroadcastHandoff) {
      sendBroadcastHandoffMutation.mutate(payload);
      return;
    }

    navigate('/publications');
  }

  function handleCloseMailingPublishReview() {
    if (!isMailingBusy) {
      setPendingMailingPublishReview(null);
    }
  }

  function confirmMailingPublishReview() {
    if (!pendingMailingPublishReview || isMailingBusy) {
      return;
    }

    const { broadcastId, payload } = pendingMailingPublishReview;
    setPendingMailingPublishReview(null);

    const hasConflictingSlots =
      payload.scheduleMode === 'calendar' &&
      findBroadcastSlotConflicts(payload.scheduledSlots, mailingConflictOccupiedSlots).length > 0;
    if (hasConflictingSlots) {
      setPendingMailingSlotConflict({ broadcastId, payload });
      return;
    }

    submitMailingPayload(broadcastId, payload);
  }

  function handleCloseMailingSlotConflict() {
    setPendingMailingSlotConflict(null);
    setMailingScheduleError('Занято.');
  }

  function confirmMailingSlotReplacement() {
    if (!pendingMailingSlotConflict) {
      return;
    }

    const { broadcastId, payload } = pendingMailingSlotConflict;
    setPendingMailingSlotConflict(null);
    setMailingScheduleError('');
    submitMailingPayload(broadcastId, {
      ...payload,
      replaceConflictingSlots: true,
    });
  }

  function handleSaveChatAutopostRule() {
    if (!chatId || mailingAutopostDisabled) {
      return;
    }

    if (!editingManagedAutopostRule) {
      navigate('/publications');
      return;
    }

    const audiencePayload = resolveBroadcastAudiencePayload({
      targetMode: mailingTargetMode,
      targetChatIds: mailingTargetChatIds,
      currentChatId: chatId,
    });
    const keepVideoMedia = editingMailingHasVideo;
    const nextPayload: SendBroadcastPayload = {
      text: normalizedMailingText,
      textFormat: 'markdown',
      ...buildMailingPublishBasePayload(),
      targetMode: audiencePayload.targetMode,
      targetChatIds: audiencePayload.targetChatIds,
      applyToAllChats: audiencePayload.applyToAllChats,
      replaceConflictingSlots: false,
      imageEnabled: mailingImageEnabled,
      imageBase64: mailingImageEnabled ? mailingImageBase64 : '',
      imageMimeType: mailingImageEnabled ? mailingImageMimeType : '',
      imageFileName: mailingImageEnabled ? mailingImageFileName : '',
      images: mailingImageEnabled ? mailingImages : [],
      mediaType: keepVideoMedia ? 'video' : null,
      mediaPayload: keepVideoMedia ? (mailingVideoSource?.mediaPayload ?? null) : null,
      mediaMimeType: keepVideoMedia ? (mailingVideoSource?.mediaMimeType ?? '') : '',
      mediaFileName: keepVideoMedia ? (mailingVideoSource?.mediaFileName ?? '') : '',
      scheduleMode: 'calendar',
      scheduledSlots: sortAndUniqueBroadcastSlots(mailingScheduledSlots),
      sendAt: null,
      cycleEnabled: false,
      cycleEveryHours: 1,
      cycleCount: 1,
    };

    updateManagedAutopostRuleMutation.mutate({
      ruleId: editingManagedAutopostRule.id,
      payload: nextPayload,
    });
  }

  function handleSendBroadcast() {
    if (!chatId) {
      return;
    }

    if (!editingManagedBroadcast && !hasLegacyBroadcastHandoff) {
      navigate('/publications');
      return;
    }

    const normalizedText = mailingText.trim();
    const scheduledSlots = sortAndUniqueBroadcastSlots(mailingScheduledSlots);
    const cycleDraft = normalizeBroadcastCycleDraft(mailingCycleDraft);
    const cycleError =
      mailingTimingMode === 'cycle'
        ? getBroadcastCycleValidationError(cycleDraft, Date.now())
        : null;
    const audiencePayload = resolveBroadcastAudiencePayload({
      targetMode: mailingTargetMode,
      targetChatIds: mailingTargetChatIds,
      currentChatId: chatId,
    });

    let hasError = false;
    const videoSource = mailingVideoSource;
    const keepVideoMedia =
      !mailingVideoCleared &&
      !mailingImageEnabled &&
      videoSource?.mediaType === 'video' &&
      videoSource.mediaPayload;
    const mailingImagesReady = areBroadcastImagesReady(mailingImages);
    const hasDirectContent = Boolean(normalizedText || mailingImageEnabled || keepVideoMedia);
    if (editingManagedBroadcast) {
      if (!normalizedText && !mailingImageEnabled && !keepVideoMedia) {
        setMailingTextError('В сохранённом автопостинге нет текста, фото или видео.');
        hasError = true;
      } else if (normalizedText.length > MAX_BROADCAST_TEXT_LENGTH) {
        setMailingTextError(`Максимум ${MAX_BROADCAST_TEXT_LENGTH} символов.`);
        hasError = true;
      } else {
        setMailingTextError('');
      }

      if (mailingImageEnabled) {
        if (mailingImagesPreparing) {
          setMailingImageError('Фото ещё готовится.');
          hasError = true;
        } else if (!mailingImagesReady) {
          setMailingImageError('В сохранённом автопостинге отсутствует фото.');
          hasError = true;
        } else {
          setMailingImageError('');
        }
      } else {
        setMailingImageError('');
      }
    } else {
      if (!hasDirectContent) {
        setMailingTextError('Добавьте текст, фото или видео.');
        hasError = true;
      } else if (normalizedText.length > MAX_BROADCAST_TEXT_LENGTH) {
        setMailingTextError(`Максимум ${MAX_BROADCAST_TEXT_LENGTH} символов.`);
        hasError = true;
      } else {
        setMailingTextError('');
      }

      if (mailingImageEnabled) {
        if (mailingImagesPreparing) {
          setMailingImageError('Фото ещё готовится.');
          hasError = true;
        } else if (!mailingImagesReady) {
          setMailingImageError('Фото не готово.');
          hasError = true;
        } else {
          setMailingImageError('');
        }
      } else {
        setMailingImageError('');
      }
    }

    if (!validateMailingButtonDraft()) {
      hasError = true;
    }

    if (audiencePayload.targetMode === 'selected' && audiencePayload.targetChatIds.length === 0) {
      setMailingAudienceError('Выберите хотя бы один чат.');
      hasError = true;
    } else {
      setMailingAudienceError('');
    }

    if (mailingTimingMode === 'scheduled' && scheduledSlots.length === 0) {
      setMailingScheduleError('Добавьте время.');
      hasError = true;
    } else if (mailingTimingMode === 'scheduled' && mailingPlannerState.hasBlockingIssue) {
      setMailingScheduleError('Проверьте время.');
      hasError = true;
    } else if (mailingTimingMode === 'scheduled' && mailingPlannerState.futureSlotCount === 0) {
      setMailingScheduleError('Есть прошедшее время.');
      hasError = true;
    } else if (mailingTimingMode === 'cycle' && cycleError) {
      setMailingCycleError(cycleError);
      hasError = true;
    } else {
      setMailingScheduleError('');
      setMailingCycleError('');
    }

    if (hasError) {
      return;
    }

    const publishBasePayload = {
      ...buildMailingPublishBasePayload(),
      targetMode: audiencePayload.targetMode,
      targetChatIds: audiencePayload.targetChatIds,
      applyToAllChats: audiencePayload.applyToAllChats,
      replaceConflictingSlots: false,
    };

    const payload: SendBroadcastPayload = {
      text: normalizedText,
      textFormat: 'markdown',
      ...publishBasePayload,
      requestId: createBroadcastRequestId(),
      imageEnabled: mailingImageEnabled,
      imageBase64: mailingImageEnabled ? mailingImageBase64 : '',
      imageMimeType: mailingImageEnabled ? mailingImageMimeType : '',
      imageFileName: mailingImageEnabled ? mailingImageFileName : '',
      images: mailingImageEnabled ? mailingImages : [],
      mediaType: keepVideoMedia ? 'video' : null,
      mediaPayload: keepVideoMedia ? (videoSource?.mediaPayload ?? null) : null,
      mediaMimeType: keepVideoMedia ? (videoSource?.mediaMimeType ?? '') : '',
      mediaFileName: keepVideoMedia ? (videoSource?.mediaFileName ?? '') : '',
    };

    setPendingMailingPublishReview({
      broadcastId: editingManagedBroadcast?.id ?? null,
      payload,
    });
  }

  function handleSendBroadcastTest() {
    if (!chatId || sendBroadcastTestMutation.isPending) {
      return;
    }

    const normalizedText = mailingText.trim();
    const videoSource = mailingVideoSource;
    const keepVideoMedia =
      !mailingVideoCleared &&
      !mailingImageEnabled &&
      videoSource?.mediaType === 'video' &&
      videoSource.mediaPayload;
    const mailingImagesReady = areBroadcastImagesReady(mailingImages);
    let hasError = false;

    if (!normalizedText && !mailingImageEnabled && !keepVideoMedia) {
      setMailingTextError('Добавьте текст, фото или видео.');
      hasError = true;
    } else if (normalizedText.length > MAX_BROADCAST_TEXT_LENGTH) {
      setMailingTextError(`Максимум ${MAX_BROADCAST_TEXT_LENGTH} символов.`);
      hasError = true;
    } else {
      setMailingTextError('');
    }

    if (mailingImageEnabled) {
      if (mailingImagesPreparing) {
        setMailingImageError('Фото ещё готовится.');
        hasError = true;
      } else if (!mailingImagesReady) {
        setMailingImageError('Фото не готово.');
        hasError = true;
      } else {
        setMailingImageError('');
      }
    } else {
      setMailingImageError('');
    }

    if (!validateMailingButtonDraft()) {
      hasError = true;
    }

    if (hasError) {
      return;
    }

    sendBroadcastTestMutation.mutate(buildMailingTestPayload());
  }

  function handleCommercialSensitivitySliderChange(rawValue: number) {
    if (!draft) {
      return;
    }

    const config = resolveCommercialSensitivityConfig(rawValue);
    setFieldValue('commercialAdsSensitivity', config.sensitivity);
    setFieldValue('commercialAdsWarnThreshold', config.warnThreshold);
    setFieldValue('commercialAdsDeleteThreshold', config.deleteThreshold);
  }

  function toggleHint(key: HintKey) {
    setOpenHintKey((current) => (current === key ? null : key));
  }

  function toggleMuteDurationEditor(key: AutoMuteDurationKey) {
    setOpenMuteDurationKey((current) => (current === key ? null : key));
  }

  function renderInlineHint(hintKey: HintKey, hintId: string, text: string, hidden = false) {
    if (hidden || openHintKey !== hintKey) {
      return null;
    }

    return (
      <p id={hintId} className="settings-native-toggle__hint settings-native-toggle__hint--inline">
        {text}
      </p>
    );
  }

  function renderMuteDurationEditor(key: AutoMuteDurationKey, label: string) {
    if (!draft || openMuteDurationKey !== key) {
      return null;
    }

    const value = Number(draft[key]);

    return (
      <div id={`mute-duration-${key}`} className="settings-duration-editor">
        <div className="settings-native-toggle__row">
          <div className="settings-native-toggle__title-wrap">
            <ClockIcon />
            <span className="settings-native-toggle__title">{label}</span>
          </div>
          <output className="ban-duration-stepper__value" aria-live="polite">
            {formatMuteDurationCompact(value)}
          </output>
        </div>

        <div className="settings-duration-editor__presets">
          {AUTO_MUTE_DURATION_PRESET_HOURS.map((hours) => (
            <button
              key={hours}
              type="button"
              className={cn('settings-duration-editor__preset', value === hours && 'is-active')}
              onClick={() => setMuteDurationValue(key, hours)}
            >
              {formatMuteDurationCompact(hours)}
            </button>
          ))}
        </div>

        <div className="settings-duration-editor__controls">
          <div className="ban-duration-stepper">
            <button
              type="button"
              className="ban-duration-stepper__button"
              onClick={() => adjustMuteDuration(key, -1)}
              disabled={value <= AUTO_MUTE_DURATION_MIN_HOURS}
            >
              -
            </button>
            <output className="ban-duration-stepper__value" aria-live="polite">
              {value}ч
            </output>
            <button
              type="button"
              className="ban-duration-stepper__button"
              onClick={() => adjustMuteDuration(key, 1)}
              disabled={value >= AUTO_MUTE_DURATION_MAX_HOURS}
            >
              +
            </button>
          </div>

          <label className="settings-duration-editor__hours-input">
            <span>Часы</span>
            <input
              type="number"
              min={AUTO_MUTE_DURATION_MIN_HOURS}
              max={AUTO_MUTE_DURATION_MAX_HOURS}
              step={1}
              value={value}
              onChange={(event) => {
                const nextValue = Number(event.target.value);
                if (!Number.isFinite(nextValue)) {
                  return;
                }

                setMuteDurationValue(key, nextValue);
              }}
            />
            <small>
              {AUTO_MUTE_DURATION_MIN_HOURS}–{AUTO_MUTE_DURATION_MAX_HOURS}ч
            </small>
          </label>
        </div>
      </div>
    );
  }

  function renderMuteStageToggle(params: {
    enabledKey: AutoMuteEnabledKey;
    durationKey: AutoMuteDurationKey;
    title: string;
    onEnable: () => void;
  }) {
    if (!draft) {
      return null;
    }

    const enabled = draft[params.enabledKey];
    const durationValue = Number(draft[params.durationKey]);
    const isOpen = openMuteDurationKey === params.durationKey;
    const error = fieldErrors[params.durationKey];

    return (
      <div
        className={cn(
          'settings-native-toggle',
          'settings-native-toggle--nested',
          error && 'field--error',
        )}
      >
        <div className="settings-native-toggle__row">
          <div className="settings-native-toggle__title-wrap">
            <span className="settings-native-toggle__title">{params.title}</span>
            <div className="settings-native-toggle__title-actions">
              <button
                type="button"
                className={cn(
                  'settings-duration-editor__preset settings-duration-editor__preset--trigger',
                  isOpen && 'is-active',
                )}
                onClick={() => toggleMuteDurationEditor(params.durationKey)}
              >
                <ClockIcon />
                <span>{formatMuteDurationCompact(durationValue)}</span>
              </button>
            </div>
          </div>

          <label className="settings-native-switch" aria-label={params.title}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => {
                const nextEnabled = event.target.checked;
                setFieldValue(params.enabledKey, nextEnabled as ChatSettings[AutoMuteEnabledKey]);
                if (nextEnabled) {
                  params.onEnable();
                }
              }}
            />
            <span className="toggle-switch" aria-hidden>
              <span className="toggle-switch__thumb" />
            </span>
          </label>
        </div>

        {renderMuteDurationEditor(params.durationKey, 'Срок ограничения')}

        {error ? <small className="field__hint">{error}</small> : null}
      </div>
    );
  }

  function toggleBotMessageEditor(key: BotMessageEditorKey) {
    setOpenWarnEditorKey(null);
    setOpenBotEditorKey((current) => (current === key ? null : key));
  }

  function toggleWarnMessageEditor(key: WarnMessageEditorKey) {
    setOpenBotEditorKey(null);
    setOpenWarnEditorKey((current) => (current === key ? null : key));
  }

  function closeSection(section: SettingsSectionKey) {
    const legacyReturnPath = resolveLegacyPublicationReturnPath(location.state);
    if (section === 'mailing' && legacyEditorTarget && legacyReturnPath) {
      navigate(-1);
      return;
    }
    if (
      (section === 'mailing' && focusSection === 'broadcast') ||
      (section === 'giveaway' && focusSection === 'giveaway') ||
      (section === 'polls' && focusSection === 'polls') ||
      (section === 'requiredSubscription' && focusSection === 'requiredSubscription') ||
      (section === 'storefront' && focusSection === 'storefront') ||
      (section === 'commercialFilter' && focusSection === 'commercialFilter')
    ) {
      const nextSearchParams = new URLSearchParams(location.search);
      [
        'focus',
        'handoff',
        'workspace',
        'legacyKind',
        'legacyId',
        'commercialUser',
        'commercialName',
        'commercialCategory',
      ].forEach((key) => nextSearchParams.delete(key));
      navigate(
        {
          pathname: location.pathname,
          search: nextSearchParams.toString() ? `?${nextSearchParams.toString()}` : '',
        },
        { replace: true, state: location.state },
      );
    }

    setExpandedSections((current) => (current[section] ? INITIAL_EXPANDED_SECTIONS : current));
  }

  function toggleSection(section: SettingsSectionKey) {
    if (expandedSections[section]) {
      closeSection(section);
      return;
    }

    if (section === 'duplicates' && !expandedSections.duplicates)
      void settingsScreenQuery.refetch();
    startTransition(() => {
      setExpandedSections({ ...INITIAL_EXPANDED_SECTIONS, [section]: true });
    });
  }

  function requestGiveawaySectionClose() {
    if (giveawayCardRef.current && !giveawayCardRef.current.requestClose()) {
      return;
    }
    closeSection('giveaway');
  }

  function toggleGiveawaySection() {
    if (expandedSections.giveaway) {
      requestGiveawaySectionClose();
      return;
    }
    toggleSection('giveaway');
  }

  if (!chatId) {
    return (
      <GlassCard>
        <StatusState
          tone="warning"
          title="Чат не выбран"
          description="Откройте экран настроек из карточки чата."
          action={
            <Link to={buildManagedEntitiesRoute('chat')} className="button button--accent">
              К списку чатов
            </Link>
          }
        />
      </GlassCard>
    );
  }

  const requiredSubscriptionChannelsError = fieldErrors.requiredSubscriptionChannelIds;
  const allowlistEntries: DomainAllowlistEntry[] = domainsQuery.data ?? [];
  const isDomainMutationPending =
    addDomainMutation.isPending ||
    removeDomainMutation.isPending ||
    scheduleDomainRemovalMutation.isPending;
  const isAllowlistMode =
    draft?.linkPolicy === 'ALLOWLIST_ONLY' ||
    (draft?.linkRulesStorageStatus === 'legacy' && !draft.linkRulesLegacySnapshot);
  const showDuplicateBotButtonErrors = Boolean(
    draft?.duplicateBotMessageEnabled && draft?.duplicateBotButtonEnabled,
  );
  const duplicateBotButtonErrors =
    showDuplicateBotButtonErrors && fieldErrors.duplicateBotButtons
      ? validateBroadcastLinkButtons(draft?.duplicateBotButtons ?? [])
      : [];
  const hasDuplicateBotButtonError = Boolean(fieldErrors.duplicateBotButtons);
  const showMessageLimitsBotButtonErrors = Boolean(
    draft?.messageLimitsBotMessageEnabled && draft?.messageLimitsBotButtonEnabled,
  );
  const messageLimitsBlockedWordsError = fieldErrors.messageLimitsBlockedWords;
  const messageLimitsBlockedDomainsError = fieldErrors.messageLimitsBlockedDomains;
  const stopWordsError =
    fieldErrors.stopWordsPolicy ||
    messageLimitsBlockedWordsError ||
    messageLimitsBlockedDomainsError;
  const messageLimitsBotButtonErrors =
    showMessageLimitsBotButtonErrors && fieldErrors.messageLimitsBotButtons
      ? validateBroadcastLinkButtons(draft?.messageLimitsBotButtons ?? [])
      : [];
  const hasMessageLimitsBotButtonError = Boolean(fieldErrors.messageLimitsBotButtons);

  const showTextFiltersBotButtonErrors = Boolean(
    draft?.textFiltersBotMessageEnabled && draft?.textFiltersBotButtonEnabled,
  );
  const textFiltersBotButtonErrors =
    showTextFiltersBotButtonErrors && fieldErrors.textFiltersBotButtons
      ? validateBroadcastLinkButtons(draft?.textFiltersBotButtons ?? [])
      : [];
  const hasTextFiltersBotButtonError = Boolean(fieldErrors.textFiltersBotButtons);
  const showNightBotButtonErrors = Boolean(
    draft?.nightModeBotMessageEnabled && draft?.nightModeBotButtonEnabled,
  );
  const nightBotButtonErrors =
    showNightBotButtonErrors && fieldErrors.nightModeBotButtons
      ? validateBroadcastLinkButtons(draft?.nightModeBotButtons ?? [])
      : [];
  const hasNightBotButtonError = Boolean(fieldErrors.nightModeBotButtons);
  const nightTimeError =
    fieldErrors.nightModeEndTimeMinutes ?? fieldErrors.nightModeStartTimeMinutes;
  const nightTimezoneError = fieldErrors.nightModeTimezone;
  const showNightForceCloseDurationErrors = Boolean(
    draft?.nightModeForceCloseEnabled && !draft?.nightModeForceCloseForever,
  );
  const nightForceCloseHoursError = showNightForceCloseDurationErrors
    ? fieldErrors.nightModeForceCloseHours
    : undefined;
  const nightForceCloseDaysError = showNightForceCloseDurationErrors
    ? fieldErrors.nightModeForceCloseDays
    : undefined;
  const hasNightForceCloseDurationError = Boolean(
    nightForceCloseHoursError || nightForceCloseDaysError,
  );
  const linkStagesEnabledCount = [
    draft?.linkBotMessageEnabled,
    draft?.linkWarnEnabled,
    draft?.linkBanEnabled,
    draft?.linkMuteEnabled,
  ].filter(Boolean).length;
  const linksHeaderSummary =
    draft?.linkPolicy === 'ALERT_ONLY'
      ? 'Ссылки не удаляются'
      : draft?.linkPolicy === 'ALLOWLIST_ONLY'
        ? `Разрешено: ${allowlistEntries.length}`
        : `Действий: ${linkStagesEnabledCount} из 4`;
  const linksCardStatus =
    draft?.linkPolicy === 'ALERT_ONLY'
      ? 'Без удаления'
      : draft?.linkPolicy === 'ALLOWLIST_ONLY'
        ? allowlistEntries.length > 0
          ? `${allowlistEntries.length}`
          : 'Пусто'
        : `${linkStagesEnabledCount}/4`;
  const rulesPublishedAtLabel = formatRemovalDateTime(
    rulesDraft?.publishedAt ?? rulesQuery.data?.publishedAt ?? null,
  );
  const rulesHeaderSummary = hasPublishedRules
    ? rulesPublishedAtLabel
      ? `Пост правил · ${rulesPublishedAtLabel}`
      : 'Опубликовано'
    : rulesDraft?.text.trim()
      ? `Черновик · ${rulesDraft.text.trim().length}/${MAX_CHAT_RULES_TEXT_LENGTH}`
      : rulesDraft?.autoTextEnabled
        ? 'Из настроек'
        : 'Не настроено';
  const rulesCardStatus = hasPublishedRules
    ? 'Пост'
    : rulesDraft?.text.trim()
      ? 'Черновик'
      : rulesDraft?.autoTextEnabled
        ? 'Авто'
        : 'Пусто';
  const normalizedRulesText = rulesDraft?.text.trim() ?? '';
  const normalizedRulesButtons = trimBroadcastLinkButtons(rulesDraft?.buttons ?? []);
  const rulesButtonEnabled = Boolean(rulesDraft?.buttonEnabled);
  const rulesButtonDraftValid =
    !rulesButtonEnabled ||
    !hasBroadcastLinkButtonErrors(validateBroadcastLinkButtons(normalizedRulesButtons));
  const rulesHasImage = Boolean(rulesDraft?.imageBase64 && rulesDraft?.imageMimeType);
  const rulesImageReady = !isPreparingRulesImage && (!rulesDraft?.imageBase64 || rulesHasImage);
  const rulesHasPublishableContent = Boolean(normalizedRulesText || rulesDraft?.autoTextEnabled);
  const rulesPublishIssueLabels = [
    !rulesHasPublishableContent ? 'Текст' : null,
    !rulesImageReady ? 'Фото' : null,
    !rulesButtonDraftValid ? 'Кнопки' : null,
  ].filter((item): item is string => Boolean(item));
  const rulesPublishReady = Boolean(
    rulesDraft && rulesHasPublishableContent && rulesImageReady && rulesButtonDraftValid,
  );
  const rulesButtonStatus = rulesButtonEnabled
    ? formatBroadcastButtonsStatus(normalizedRulesButtons)
    : 'Без кнопок';
  const rulesAutoFillSummary = rulesDraft?.autoTextEnabled ? 'Включено' : 'Выключено';
  const rulesViolationButtonSummary = draft?.rulesAttachViolationsEnabled
    ? 'Включена'
    : 'Выключена';
  const rulesFooterTitle =
    rulesPublishIssueLabels.length > 0 ? `Проверьте: ${rulesPublishIssueLabels.join(' · ')}` : '';
  const rulesFooterMeta = [
    normalizedRulesText ? `${normalizedRulesText.length}/${MAX_CHAT_RULES_TEXT_LENGTH}` : null,
    rulesDraft?.autoTextEnabled ? 'Авто' : null,
    rulesHasImage ? 'Фото' : null,
    rulesButtonEnabled ? rulesButtonStatus : null,
    rulesDraft?.adminContactButtonEnabled ? ADMIN_CONTACT_BUTTON_TEXT : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const rulesStudioReadyCount = [
    rulesHasPublishableContent,
    rulesImageReady,
    rulesButtonDraftValid,
    hasPublishedRules,
  ].filter(Boolean).length;
  const rulesStudioSignals: BroadcastStudioSignal[] = [
    {
      label: 'Текст',
      value: rulesDraft?.autoTextEnabled
        ? 'Авто'
        : normalizedRulesText
          ? `${normalizedRulesText.length}/${MAX_CHAT_RULES_TEXT_LENGTH}`
          : 'Пусто',
      tone: rulesHasPublishableContent ? 'ready' : 'pending',
      icon: 'content',
    },
    {
      label: 'Фото',
      value: isPreparingRulesImage ? 'Готовим' : rulesHasImage ? 'Есть' : 'Нет',
      tone: isPreparingRulesImage
        ? 'pending'
        : rulesHasImage
          ? 'ready'
          : rulesImageReady
            ? 'neutral'
            : 'danger',
      icon: 'content',
    },
    {
      label: 'Кнопки',
      value: rulesButtonStatus,
      tone: rulesButtonDraftValid ? (rulesButtonEnabled ? 'ready' : 'neutral') : 'danger',
      icon: 'button',
    },
    {
      label: 'Публикация',
      value: hasPublishedRules ? 'Есть' : 'Черновик',
      tone: hasPublishedRules ? 'ready' : 'pending',
      icon: 'channel',
    },
  ];
  const rulesStudioSubtitle =
    rulesFooterMeta ||
    (hasPublishedRules && rulesPublishedAtLabel ? rulesPublishedAtLabel : 'Черновик');
  const rulesAdminContactButtonSummary = rulesDraft?.adminContactButtonEnabled
    ? 'Включено'
    : 'Выключено';
  const rulesSaveLabel = isSavingRules
    ? 'Сохраняем...'
    : hasRulesChanges
      ? 'Сохранить'
      : 'Сохранено';
  const rulesDrilldownFooter = rulesDraft ? (
    <div
      className={cn(
        'broadcast-publish-bar rules-publish-bar',
        hasPublishedRules && 'rules-publish-bar--with-reset',
      )}
    >
      {isRulesResetPending ? (
        <div className="broadcast-publish-bar__copy" role="status">
          <strong>Прежний пост ещё удаляется</strong>
        </div>
      ) : null}
      {rulesPublishIssueLabels.length > 0 ? (
        <div className="broadcast-publish-bar__copy">
          <strong>{rulesFooterTitle}</strong>
          {rulesPublishIssueLabels.length > 0 && !isRulesBusy ? (
            <span className="broadcast-publish-bar__issues" aria-label="Не готово">
              {rulesPublishIssueLabels.map((label) => (
                <span key={`rules-publish-issue-${label}`}>{label}</span>
              ))}
            </span>
          ) : null}
        </div>
      ) : null}

      {hasPublishedRules && !isRulesResetPending ? (
        <SegmentedControl
          className="rules-publication-mode"
          ariaLabel="Действие с правилами"
          value={rulesPublicationMode}
          options={[
            { value: 'new_message', label: 'Новый пост', disabled: isRulesBusy },
            { value: 'update', label: 'Обновить пост', disabled: isRulesBusy },
          ]}
          onChange={setRulesPublicationMode}
        />
      ) : null}
      <div className="rules-publish-bar__commands">
        {rulesPublishedUrl ? (
          <button
            type="button"
            className="button button--ghost broadcast-publish-bar__test rules-publish-bar__open"
            onClick={(event) => handleManagedPostLinkClick(event, rulesPublishedUrl)}
          >
            <span>Открыть</span>
          </button>
        ) : null}

        {hasPublishedRules ? (
          <button
            type="button"
            className="button button--ghost broadcast-publish-bar__test rules-publish-bar__reset"
            onClick={handleResetPublishedRules}
            disabled={isRulesBusy || isCheckingRulesPublication}
            aria-label={isRulesResetPending ? 'Проверить удаление' : 'Удалить пост правил'}
            title={isRulesResetPending ? 'Проверить удаление' : 'Удалить пост правил'}
          >
            <ResetIcon />
          </button>
        ) : null}

        <button
          type="button"
          className="button button--ghost rules-publish-bar__save"
          onClick={() => void handleSaveRulesDraft()}
          disabled={isRulesBusy || !hasRulesChanges}
        >
          <span>{rulesSaveLabel}</span>
        </button>

        <button
          type="button"
          className="button button--accent broadcast-publish-bar__button broadcast-publish-bar__primary"
          onClick={() => void handlePublishRules()}
          disabled={isRulesBusy || !rulesPublishReady}
        >
          <span>
            {isPreparingRulesPublish
              ? 'Сохраняем...'
              : isPublishingRules
                ? hasPublishedRules && !isRulesResetPending && rulesPublicationMode === 'update'
                  ? 'Обновляем...'
                  : 'Публикуем...'
                : hasPublishedRules && !isRulesResetPending && rulesPublicationMode === 'update'
                  ? 'Обновить пост'
                  : isRulesResetPending
                    ? 'Проверить и опубликовать'
                    : 'Опубликовать в чат'}
          </span>
        </button>
      </div>
    </div>
  ) : null;
  const greetingHeaderSummary =
    draft?.greetingEnabled && draft?.greetingBotMessageEnabled
      ? draft?.greetingBotButtonEnabled || draft?.greetingRulesButtonEnabled
        ? 'Сообщение + кнопки'
        : 'Только сообщение'
      : 'Выключено';
  const greetingCardStatus =
    draft?.greetingEnabled && draft?.greetingBotMessageEnabled ? 'Вкл' : 'Выкл';
  const duplicateAllowedCount = draft ? resolveDuplicateAllowedCount(draft) : 1;
  const duplicateSharedWindowHours = draft
    ? secondsToHours(resolveDuplicateSharedWindowSec(draft))
    : 12;
  const duplicatesHeaderSummary = formatDuplicateSettingsSummary(
    draft,
    duplicateSharedWindowHours,
    duplicatePhotoModerationPolicy,
  );
  const profanityStagesEnabledCount = draft?.russianProfanityFilterEnabled
    ? [
        draft?.profanityBotMessageEnabled,
        draft?.profanityWarnEnabled,
        draft?.profanityBanEnabled,
        draft?.profanityMuteEnabled,
      ].filter(Boolean).length
    : 0;
  const profanitySensitivityLabel = draft
    ? PROFANITY_SENSITIVITY_LABELS[draft.profanitySensitivity]
    : PROFANITY_SENSITIVITY_LABELS.BALANCED;
  const textFiltersStagesEnabledCount = draft?.commercialAdsFilterEnabled
    ? [
        draft?.textFiltersBotMessageEnabled,
        draft?.textFiltersWarnEnabled,
        draft?.textFiltersBanEnabled,
        draft?.textFiltersMuteEnabled,
      ].filter(Boolean).length
    : 0;
  const commercialSensitivitySliderValue = draft
    ? inferCommercialSensitivitySliderValue(draft)
    : 50;
  const commercialSensitivityLabel = getCommercialSensitivityLabel(
    commercialSensitivitySliderValue ?? 69,
  );
  const limitsRulesEnabledCount = [
    draft?.slowModeEnabled,
    draft?.mediaMessageCooldownEnabled,
    draft?.stickerMessagesEnabled === false,
    draft?.antiSpamEnabled,
    draft?.deleteSpammersEnabled,
    draft?.messageCountLimitEnabled,
    draft?.maxMessageLengthEnabled,
    draft?.photoMessageCooldownEnabled,
    draft?.stickerMessageCooldownEnabled,
    draft ? !draft.photoMessagesEnabled : false,
    draft ? !draft.videoMessagesEnabled : false,
    draft ? !draft.fileMessagesEnabled : false,
    draft ? !draft.voiceMessagesEnabled : false,
    draft ? !draft.forwardedMessagesEnabled : false,
    draft ? !draft.phoneNumbersEnabled : false,
  ].filter(Boolean).length;
  const limitsCardStatus = limitsRulesEnabledCount > 0 ? `${limitsRulesEnabledCount}` : 'Выкл';
  const nightTimezoneLabel = formatTimezoneLabel(draft?.nightModeTimezone ?? 'Europe/Moscow');
  const nightWindowLabel = draft
    ? `${minutesToTimeInput(draft.nightModeStartTimeMinutes)}-${minutesToTimeInput(
        draft.nightModeEndTimeMinutes,
      )}`
    : '23:00-08:00';
  const nightForceCloseSummary = draft?.nightModeForceCloseEnabled
    ? draft.nightModeForceCloseForever
      ? 'Чат закрыт вручную без срока'
      : `Чат закрыт вручную на ${formatNightForceCloseDuration(
          draft.nightModeForceCloseDays,
          draft.nightModeForceCloseHours,
        )}`
    : null;
  const nightHeaderSummary = nightForceCloseSummary
    ? nightForceCloseSummary
    : draft?.nightModeEnabled
      ? `${nightWindowLabel} • ${nightTimezoneLabel}`
      : 'Выключено';
  const nightCardStatus = nightForceCloseSummary
    ? 'Закрыто'
    : draft?.nightModeEnabled
      ? nightWindowLabel
      : 'Выкл';
  const requiredSubscriptionSelectedCount = draft?.requiredSubscriptionChannelIds.length ?? 0;
  const requiredSubscriptionStaleCount = selectedUnavailableRequiredSubscriptionChannels.length;
  const requiredSubscriptionUnavailableCount =
    unavailableManagedRequiredSubscriptionChannels.length;
  const requiredSubscriptionIsActive = requiredSubscriptionSelectedCount > 0;
  const areChannelsSyncing =
    requiredSubscriptionEntitiesLoading || requiredSubscriptionEntitiesSyncing;
  const requiredSubscriptionPickerEmptyState =
    requiredSubscriptionSelectedCount >= REQUIRED_SUBSCRIPTION_MAX_CHANNELS
      ? 'Лимит выбран.'
      : requiredSubscriptionUnavailableCount > 0
        ? 'Нет доступных источников.'
        : 'Добавьте ссылку вручную.';
  const requiredSubscriptionHeaderSummary = areChannelsSyncing
    ? 'Обновляем...'
    : requiredSubscriptionStaleCount > 0
      ? `Нужно исправить: ${formatRequiredSubscriptionCount(requiredSubscriptionStaleCount)}`
      : requiredSubscriptionIsActive
        ? formatRequiredSubscriptionCount(requiredSubscriptionSelectedCount)
        : 'Не настроена';
  const requiredSubscriptionCardStatus =
    requiredSubscriptionStaleCount > 0
      ? 'Проверить'
      : requiredSubscriptionIsActive
        ? `${requiredSubscriptionSelectedCount}`
        : '0';
  const profanityFilterHeaderSummary = draft?.russianProfanityFilterEnabled
    ? `Действий: ${profanityStagesEnabledCount} из 4 · ${profanitySensitivityLabel.toLowerCase()}`
    : 'Выключено';
  const profanityFilterCardStatus = draft?.russianProfanityFilterEnabled
    ? `${profanityStagesEnabledCount}/4`
    : 'Выкл';
  const commercialFilterHeaderSummary = draft?.commercialAdsFilterEnabled
    ? `Удаление рекламы · ${commercialSensitivitySliderValue === null ? 'свои настройки' : commercialSensitivityLabel.toLowerCase()}`
    : 'Выключено';
  const commercialFilterCardStatus = draft?.commercialAdsFilterEnabled
    ? `${textFiltersStagesEnabledCount}/4`
    : 'Выкл';
  const extraEnabledCount = [
    draft?.deleteBotMessagesEnabled,
    draft?.removeBotsFromGroupEnabled,
  ].filter(Boolean).length;
  const deleteSpammersRuntimeStatus = !draft?.deleteSpammersEnabled
    ? 'Выкл'
    : spammerReviewMetricsQuery.data?.enforcementMode === 'shadow'
      ? 'Проверка'
      : 'Активно';
  const extraHeaderSummary = extraEnabledCount > 0 ? `Включено: ${extraEnabledCount}` : 'Выключено';
  const extraCardStatus = extraEnabledCount > 0 ? `${extraEnabledCount}` : 'Выкл';
  const storefrontHeaderSummary = draft?.karavanStorefrontEnabled
    ? draft.karavanStorefrontAdminsOnly
      ? 'Только админы и разрешённые пользователи'
      : 'Кнопка после сообщений с $'
    : 'Выключено';
  const storefrontCardStatus = !draft?.karavanStorefrontEnabled
    ? 'Выкл'
    : draft.karavanStorefrontAdminsOnly
      ? 'Админы'
      : 'Вкл';
  const chatsCount = chatsList.data?.length ?? 0;
  const canApplyToAllChats = !chatsList.isSyncComplete || chatsCount > 1;
  const mailingAudienceChoices = useMemo(() => {
    const choicesById = new Map<string, ChatSummary>();
    for (const chat of chatsList.data ?? []) {
      if (chat.entityType === 'chat') {
        choicesById.set(chat.id, chat);
      }
    }

    const currentChatId = chatId?.trim() ?? '';
    if (currentChatId && !choicesById.has(currentChatId)) {
      choicesById.set(currentChatId, {
        id: currentChatId,
        title: chatTitle || 'Текущий чат',
        createdAt: new Date(0).toISOString(),
        entityType: 'chat',
        link: chatHeaderQuery.data?.link ?? null,
        avatarUrl: chatHeaderQuery.data?.avatarUrl ?? null,
        channelOverview: null,
        primaryBotId: null,
        assignedBots: [],
        sharedMode: 'owned',
        botCount: chatHeaderQuery.data?.botCount,
        hasSharedAutomation: chatHeaderQuery.data?.hasSharedAutomation,
      });
    }

    return [...choicesById.values()];
  }, [
    chatHeaderQuery.data?.avatarUrl,
    chatHeaderQuery.data?.botCount,
    chatHeaderQuery.data?.hasSharedAutomation,
    chatHeaderQuery.data?.link,
    chatId,
    chatTitle,
    chatsList.data,
  ]);
  const mailingAudiencePayload = useMemo(
    () =>
      resolveBroadcastAudiencePayload({
        targetMode: mailingTargetMode,
        targetChatIds: mailingTargetChatIds,
        currentChatId: chatId ?? undefined,
      }),
    [chatId, mailingTargetChatIds, mailingTargetMode],
  );
  const mailingCalendarTargetChatIds = useMemo(
    () => (mailingAudiencePayload.targetMode === 'all' ? [] : mailingAudiencePayload.targetChatIds),
    [mailingAudiencePayload.targetChatIds, mailingAudiencePayload.targetMode],
  );
  const mailingCalendarQuery = useQuery({
    queryKey: [
      'managed-broadcast-calendar',
      chatId,
      mailingAudiencePayload.targetMode,
      mailingCalendarTargetChatIds.join(':'),
      editingManagedBroadcast?.id ?? null,
    ],
    queryFn: () =>
      getManagedBroadcastCalendar(api, chatId ?? '', {
        targetMode: mailingAudiencePayload.targetMode,
        targetChatIds: mailingCalendarTargetChatIds,
      }),
    enabled: legacyBroadcastWorkspaceRequested && Boolean(chatId) && expandedSections.mailing,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  const mailingAudienceChoicesLoading = chatsList.isLoading && (chatsList.data?.length ?? 0) === 0;
  const mailingAudienceChoicesError = chatsList.error
    ? formatApiError(chatsList.error) || 'Не удалось загрузить список чатов.'
    : null;
  const managedChatsRoute = buildManagedEntitiesRoute('chat');
  const refetchSettings = () => {
    void settingsQuery.refetch();
    if (handoffRequested) {
      void broadcastHandoffStateQuery.refetch();
    }
  };
  const managedBroadcasts = managedBroadcastsQuery.data ?? [];
  const managedAutopostRulesQuery = useQuery({
    queryKey: ['managed-autopost-rules', chatId],
    queryFn: () => getManagedAutopostRules(api, chatId ?? ''),
    enabled: legacyBroadcastWorkspaceRequested && Boolean(chatId) && expandedSections.mailing,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });
  const orderedManagedAutopostRules = useMemo(
    () => sortManagedAutopostRules(managedAutopostRulesQuery.data ?? []),
    [managedAutopostRulesQuery.data],
  );

  useEffect(() => {
    if (!legacyEditorTarget) {
      appliedLegacyEditorTargetRef.current = null;
      return;
    }

    const signature = `${chatId}:${legacyEditorTarget.kind}:${legacyEditorTarget.id}`;
    if (appliedLegacyEditorTargetRef.current === signature) {
      return;
    }

    if (legacyEditorTarget.kind === 'autopost') {
      appliedLegacyEditorTargetRef.current = signature;
      setMailingWorkspaceView('autoposts');
      return;
    }

    if (!settingsScreenQuery.data || openManagedBroadcastEditorMutation.isPending) {
      return;
    }

    appliedLegacyEditorTargetRef.current = signature;
    setMailingWorkspaceView('history');
    openManagedBroadcastEditorMutation.mutate(legacyEditorTarget.id);
  }, [chatId, legacyEditorTarget, openManagedBroadcastEditorMutation, settingsScreenQuery.data]);
  const orderedManagedBroadcasts = useMemo(() => {
    const priority = (item: ManagedBroadcastListItem): number => {
      if (item.status === 'FAILED') {
        return 0;
      }
      if (item.status === 'PARTIAL') {
        return 1;
      }
      if (item.status === 'ACTIVE') {
        return 2;
      }
      if (item.status === 'COMPLETED') {
        return 3;
      }
      return 4;
    };

    const parseTimestamp = (value: string | null): number => {
      if (!value) {
        return Number.MAX_SAFE_INTEGER;
      }

      const parsed = new Date(value).getTime();
      return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
    };

    return [...managedBroadcasts].sort((left, right) => {
      const priorityDiff = priority(left) - priority(right);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }

      const nextSendDiff = parseTimestamp(left.nextSendAt) - parseTimestamp(right.nextSendAt);
      if (nextSendDiff !== 0) {
        return nextSendDiff;
      }

      return parseTimestamp(right.updatedAt) - parseTimestamp(left.updatedAt);
    });
  }, [managedBroadcasts]);
  const mailingHistoryCounts = useMemo(
    () => countManagedBroadcastHistoryFilters(orderedManagedBroadcasts),
    [orderedManagedBroadcasts],
  );
  const filteredManagedBroadcasts = useMemo(
    () => filterManagedBroadcastsByHistoryFilter(orderedManagedBroadcasts, mailingHistoryFilter),
    [mailingHistoryFilter, orderedManagedBroadcasts],
  );
  const mailingOccupiedSlots = managedBroadcasts
    .filter(
      (broadcast) =>
        broadcast.id !== editingManagedBroadcast?.id &&
        broadcast.autopostRuleId !== editingManagedAutopostRule?.id,
    )
    .flatMap((broadcast) => broadcast.scheduledSlots);
  const mailingConflictOccupiedSlots =
    mailingCalendarQuery.data?.slots && mailingCalendarQuery.data.slots.length > 0
      ? sortAndUniqueBroadcastSlots(
          mailingCalendarQuery.data.slots
            .filter(
              (slot) =>
                slot.hasTargetOverlap &&
                (!editingManagedBroadcast || slot.broadcastId !== editingManagedBroadcast.id) &&
                (!editingManagedAutopostRule ||
                  slot.autopostRuleId !== editingManagedAutopostRule.id),
            )
            .map((slot) => slot.scheduledAt),
        )
      : mailingOccupiedSlots;
  const pendingMailingConflictSlots = pendingMailingSlotConflict
    ? findBroadcastSlotConflicts(
        pendingMailingSlotConflict.payload.scheduledSlots,
        mailingConflictOccupiedSlots,
      )
    : [];
  const pendingMailingConflictPreviewSlot =
    pendingMailingConflictSlots[0] ?? pendingMailingSlotConflict?.payload.scheduledSlots[0] ?? null;
  const mailingCurrentChatChoice = mailingAudienceChoices.find((chat) => chat.id === chatId);
  const mailingCurrentChatPreview = mailingCurrentChatChoice
    ? toManagedBroadcastTargetPreview(mailingCurrentChatChoice)
    : chatId
      ? {
          id: chatId,
          title: chatTitle || 'Текущий чат',
          entityType: 'chat' as const,
          link: chatHeaderQuery.data?.link ?? null,
          avatarUrl: chatHeaderQuery.data?.avatarUrl ?? null,
        }
      : null;
  const mailingSystemButtons = buildChatBroadcastSystemButtons({
    commentsEnabled: draft?.commentsEnabled,
    commentsChatBroadcastsEnabled: draft?.commentsChatBroadcastsEnabled,
  });
  const pendingMailingReviewPayload = pendingMailingPublishReview?.payload ?? null;
  const pendingMailingReviewAudienceLabel = pendingMailingReviewPayload
    ? buildBroadcastAudiencePresentation({
        targetMode: pendingMailingReviewPayload.targetMode,
        targetChatIds:
          pendingMailingReviewPayload.targetMode === 'all'
            ? mailingCalendarTargetChatIds
            : pendingMailingReviewPayload.targetChatIds,
        targetPreviews: buildBroadcastAudiencePreviewBundle({
          targetChatIds:
            pendingMailingReviewPayload.targetMode === 'all'
              ? mailingCalendarTargetChatIds
              : pendingMailingReviewPayload.targetChatIds,
          choices: mailingAudienceChoices,
          currentChat: mailingCurrentChatPreview,
        }).previews,
        targetChats:
          pendingMailingReviewPayload.targetMode === 'all'
            ? mailingAudienceChoices.length
            : pendingMailingReviewPayload.targetChatIds.length,
        currentLabel: 'Текущий чат',
        currentTitle: chatTitle,
      }).label
    : '';
  const pendingMailingReviewFacts = pendingMailingReviewPayload
    ? [
        `Кому · ${pendingMailingReviewAudienceLabel}`,
        `Время · ${formatBroadcastPayloadScheduleLabel(pendingMailingReviewPayload)}`,
        pendingMailingReviewPayload.buttonEnabled || mailingSystemButtons.length > 0
          ? `Кнопки · ${formatBroadcastButtonsPreview([
              ...pendingMailingReviewPayload.buttons,
              ...mailingSystemButtons,
            ])}`
          : 'Кнопки · нет',
        pendingMailingReviewPayload.imageEnabled ||
        pendingMailingReviewPayload.mediaType === 'video'
          ? 'Медиа'
          : null,
      ].filter((item): item is string => Boolean(item))
    : [];
  const activeManagedBroadcast = orderedManagedBroadcasts.find((broadcast) => {
    if (broadcast.status !== 'ACTIVE' && broadcast.status !== 'PARTIAL') {
      return false;
    }

    return resolveBroadcastCountdown(broadcast.nextSendAt, mailingNowMs) !== null;
  });
  const activeManagedBroadcastCountdown = activeManagedBroadcast
    ? resolveBroadcastCountdown(activeManagedBroadcast.nextSendAt, mailingNowMs)
    : null;
  const hasActiveManagedBroadcastCountdown = activeManagedBroadcastCountdown !== null;
  const isUpdatingManagedBroadcast = updateManagedBroadcastMutation.isPending;
  const isOpeningManagedBroadcastEditor = openManagedBroadcastEditorMutation.isPending;
  const isMailingBusy =
    sendBroadcastTestMutation.isPending ||
    sendBroadcastHandoffMutation.isPending ||
    clearBroadcastHandoffMutation.isPending ||
    updateManagedAutopostRuleMutation.isPending ||
    deleteManagedAutopostRuleMutation.isPending ||
    isOpeningManagedBroadcastEditor ||
    isUpdatingManagedBroadcast ||
    cancelManagedBroadcastMutation.isPending ||
    retryManagedBroadcastMutation.isPending;
  const mailingAudiencePreviewBundle = buildBroadcastAudiencePreviewBundle({
    targetChatIds:
      mailingTargetMode === 'all'
        ? mailingCalendarTargetChatIds
        : mailingAudiencePayload.targetChatIds,
    choices: mailingAudienceChoices,
    currentChat: mailingCurrentChatPreview,
  });
  const mailingHeaderTargetPresentation = buildBroadcastAudiencePresentation({
    targetMode: mailingTargetMode,
    targetChatIds:
      mailingTargetMode === 'all'
        ? mailingCalendarTargetChatIds
        : mailingAudiencePayload.targetChatIds,
    targetPreviews: mailingAudiencePreviewBundle.previews,
    targetOverflowCount: mailingAudiencePreviewBundle.overflowCount,
    targetChats:
      mailingTargetMode === 'all'
        ? mailingCalendarTargetChatIds.length
        : mailingAudiencePayload.targetChatIds.length,
    currentLabel: 'Текущий чат',
    currentTitle: chatTitle,
  });
  const mailingHeaderTargetLabel = mailingHeaderTargetPresentation.label;
  const mailingSlotsLabel = formatRussianCountLabel(
    mailingScheduledSlots.length,
    'отправка',
    'отправки',
    'отправок',
  );
  const normalizedMailingText = mailingText.trim();
  const normalizedMailingButtons = trimBroadcastLinkButtons(mailingButtons);
  const mailingButtonEnabled = normalizedMailingButtons.length > 0;
  const mailingVisibleButtons = [...normalizedMailingButtons, ...mailingSystemButtons];
  const mailingHasVisibleButtons = mailingVisibleButtons.length > 0;
  const mailingVisibleButtonStatus = formatBroadcastButtonsStatus(mailingVisibleButtons);
  const mailingVideoSource = editingManagedBroadcast ?? editingManagedAutopostRule?.payload;
  const editingMailingHasVideo =
    !mailingVideoCleared &&
    mailingVideoSource?.mediaType === 'video' &&
    Boolean(mailingVideoSource.mediaPayload);
  const mailingHasDirectContent = Boolean(
    normalizedMailingText || mailingImageEnabled || editingMailingHasVideo,
  );
  const mailingImagesReady = !mailingImageEnabled || areBroadcastImagesReady(mailingImages);
  const mailingMediaReady = mailingImagesReady && !mailingImagesPreparing;
  const mailingHasPublishableContent = mailingHasDirectContent;
  const mailingContentReady = mailingHasPublishableContent && mailingMediaReady;
  const mailingNormalizedCycle = normalizeBroadcastCycleDraft(mailingCycleDraft, mailingNowMs);
  const mailingCycleValidationError =
    mailingTimingMode === 'cycle'
      ? getBroadcastCycleValidationError(mailingNormalizedCycle, mailingNowMs)
      : null;
  const mailingTimingSummary =
    mailingTimingMode === 'now'
      ? 'Сейчас'
      : mailingTimingMode === 'cycle'
        ? formatBroadcastCycleSummary(mailingNormalizedCycle, mailingNowMs)
        : mailingScheduledSlots.length > 0
          ? mailingSlotsLabel
          : 'Без времени';
  const mailingHeaderSummary = [mailingHeaderTargetLabel, mailingTimingSummary]
    .filter(Boolean)
    .join(' · ');
  const mailingCardStatus =
    editingManagedBroadcast || editingManagedAutopostRule
      ? 'Правка'
      : mailingTimingMode === 'cycle'
        ? 'Цикл'
        : mailingTimingMode === 'scheduled'
          ? mailingScheduledSlots.length > 0
            ? mailingSlotsLabel
            : 'План'
          : mailingHasPublishableContent
            ? 'Готов'
            : 'Черновик';
  const showMailingResetAction =
    editingManagedBroadcast !== null ||
    mailingTargetMode !== 'current' ||
    mailingTimingMode !== 'now' ||
    mailingScheduledSlots.length > 0 ||
    normalizedMailingText.length > 0 ||
    mailingImageEnabled ||
    mailingButtonEnabled;
  const mailingButtonDraftValid = !hasBroadcastLinkButtonErrors(
    validateBroadcastLinkButtons(normalizedMailingButtons),
  );
  const mailingPlannerPending = mailingPlannerState.isDaySheetOpen;
  const mailingAudienceReady =
    mailingTargetMode !== 'selected' || mailingAudiencePayload.targetChatIds.length > 0;
  const mailingHasFutureSlots =
    mailingTimingMode === 'now' ||
    (mailingTimingMode === 'cycle' && !mailingCycleValidationError) ||
    (mailingTimingMode === 'scheduled' &&
      mailingPlannerState.futureSlotCount > 0 &&
      !mailingPlannerState.hasBlockingIssue);
  const mailingCalendarScheduleReady =
    mailingTimingMode === 'scheduled' &&
    mailingScheduledSlots.length > 0 &&
    mailingPlannerState.futureSlotCount > 0 &&
    !mailingPlannerPending &&
    !mailingPlannerState.hasBlockingIssue;
  const mailingScheduleReady =
    mailingTimingMode === 'now' ||
    (mailingTimingMode === 'cycle' && !mailingCycleValidationError) ||
    mailingCalendarScheduleReady;
  const mailingTestReady = mailingContentReady && mailingButtonDraftValid;
  const mailingSendDisabled =
    isMailingBusy ||
    !mailingContentReady ||
    !mailingAudienceReady ||
    !mailingScheduleReady ||
    !mailingHasFutureSlots ||
    !mailingButtonDraftValid;
  const mailingAutopostDisabled =
    isMailingBusy ||
    !mailingContentReady ||
    !mailingAudienceReady ||
    !mailingCalendarScheduleReady ||
    !mailingButtonDraftValid;
  const mailingPublishIssueLabels = [
    !mailingHasPublishableContent ? 'Текст' : null,
    mailingHasPublishableContent && !mailingMediaReady ? 'Фото' : null,
    !mailingAudienceReady ? 'Адресат' : null,
    !mailingScheduleReady || !mailingHasFutureSlots ? 'Время' : null,
    !mailingButtonDraftValid ? 'Кнопки' : null,
  ].filter((item): item is string => Boolean(item));
  const mailingPublishIssueActions = mailingPublishIssueLabels.map((label) => ({
    label,
    onClick: () => {
      setMailingWorkspaceView('compose');

      if (label === 'Текст') {
        setMailingTextError('Добавьте текст, фото или видео.');
        return;
      }

      if (label === 'Фото') {
        setMailingImageError(mailingImagesPreparing ? 'Фото ещё готовится.' : 'Фото не готово.');
        return;
      }

      if (label === 'Адресат') {
        setMailingAudienceError('Выберите хотя бы один чат.');
        return;
      }

      if (label === 'Время') {
        if (mailingTimingMode === 'cycle') {
          setMailingCycleError(mailingCycleValidationError ?? 'Проверьте цикл публикаций.');
          return;
        }

        setMailingScheduleError('Выберите время публикации.');
        return;
      }

      if (label === 'Кнопки') {
        setMailingButtonsSheetOpen(true);
      }
    },
  }));
  const mailingFooterIssueActions = showMailingResetAction ? mailingPublishIssueActions : [];
  const mailingPrimaryActionLabel = editingManagedBroadcast
    ? 'Сохранить'
    : editingManagedAutopostRule
      ? 'Сохранить'
      : mailingTimingMode === 'now'
        ? 'Опубликовать'
        : mailingTimingMode === 'scheduled'
          ? 'Запланировать публикацию'
          : 'Запустить';
  const mailingFooterPrimaryActionLabel = editingManagedBroadcast
    ? 'Сохранить'
    : editingManagedAutopostRule
      ? 'Сохранить'
      : mailingTimingMode === 'now'
        ? 'Опубликовать'
        : mailingTimingMode === 'scheduled'
          ? 'Запланировать публикацию'
          : 'Запустить';
  const showMailingWorkspaceTabs = !editingManagedBroadcast && !editingManagedAutopostRule;
  const activeMailingWorkspaceView =
    legacyBroadcastWorkspaceRequested &&
    !handoffRequested &&
    showMailingWorkspaceTabs &&
    (mailingWorkspaceView === 'compose' || mailingWorkspaceView === 'calendar')
      ? legacyEditorTarget?.kind === 'broadcast'
        ? 'history'
        : 'autoposts'
      : mailingWorkspaceView;
  const mailingResetActionLabel = editingManagedBroadcast
    ? 'Сбросить изменения'
    : editingManagedAutopostRule
      ? 'Сбросить изменения'
      : 'Очистить автопостинг';
  const mailingDrilldownFooter = (
    <BroadcastPublishBar
      title={mailingFooterIssueActions.length > 0 ? 'Проверьте публикацию' : ''}
      issues={mailingFooterIssueActions}
      busy={isMailingBusy}
      testLabel={sendBroadcastTestMutation.isPending ? 'Тест...' : 'Тест'}
      testAriaLabel={sendBroadcastTestMutation.isPending ? 'Отправляем тест' : 'Отправить тест'}
      testDisabled={isMailingBusy || !mailingTestReady}
      primaryLabel={
        updateManagedAutopostRuleMutation.isPending && editingManagedAutopostRule
          ? 'Сохраняем...'
          : isUpdatingManagedBroadcast
            ? 'Сохраняем...'
            : isOpeningManagedBroadcastEditor
              ? 'Открываем...'
              : mailingFooterPrimaryActionLabel
      }
      primaryDisabled={editingManagedAutopostRule ? mailingAutopostDisabled : mailingSendDisabled}
      onTest={handleSendBroadcastTest}
      onPrimary={editingManagedAutopostRule ? handleSaveChatAutopostRule : handleSendBroadcast}
    />
  );

  useEffect(() => {
    if (editingManagedBroadcast && mailingWorkspaceView !== 'compose') {
      setMailingWorkspaceView('compose');
    }
  }, [editingManagedBroadcast, mailingWorkspaceView]);

  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      !expandedSections.mailing ||
      !hasActiveManagedBroadcastCountdown
    ) {
      return undefined;
    }

    setMailingNowMs(Date.now());
    const timerId = window.setInterval(() => {
      setMailingNowMs(Date.now());
    }, 30_000);

    return () => {
      window.clearInterval(timerId);
    };
  }, [expandedSections.mailing, hasActiveManagedBroadcastCountdown]);

  useHintPopoverAutoPosition(openHintKey !== null, openHintKey, () => setOpenHintKey(null));

  function resetMailingPlanner() {
    setMailingPlannerState(EMPTY_BROADCAST_PLANNER_STATE);
    setMailingPlannerResetKey((current) => current + 1);
  }

  function hasSharedSectionErrors(section: ApplySectionKey) {
    return settingsSectionPaths('chat', section).some((path) => Boolean(sharedFieldErrors[path]));
  }
  function isSectionDirty(section: ApplySectionKey) {
    if (section === 'links' && isSectionDirty('stopWords')) return true;
    if (section === 'stopWords' && stopWordsReplacementAuthorized) return true;
    if (hasSharedSectionErrors(section)) return true;
    if (!draft || !settingsQuery.data) {
      return false;
    }
    if (
      section === 'stopWords' &&
      (messageLimitsBlockedWordsInput.trim() || messageLimitsBlockedDomainsInput.trim())
    )
      return true;

    const draftSettings = normalizeSectionDraftSettings(draft, section);
    const savedSettings = normalizeSectionDraftSettings(settingsQuery.data, section);
    return (
      hasSectionSettingChanges(draftSettings, savedSettings, section) ||
      hasSectionBotSpeechMediaChanges(draftSettings, savedSettings, section)
    );
  }

  function resetSharedSectionEditor(section: ApplySectionKey) {
    const paths = new Set(settingsSectionPaths('chat', section));
    setSharedFieldErrors((current) =>
      Object.fromEntries(Object.entries(current).filter(([path]) => !paths.has(path))),
    );
    setSharedSectionEpochs((current) => ({ ...current, [section]: (current[section] ?? 0) + 1 }));
  }

  function discardSectionChanges(section: ApplySectionKey) {
    resetSharedSectionEditor(section);
    if (!settingsQuery.data) {
      return;
    }

    const savedSettings = normalizeSectionDraftSettings(settingsQuery.data, section);
    if (section === 'stopWords') {
      discardStopWordsEditorState();
      setStopWordsModuleError(null);
      setStopWordsFocusRequest(undefined);
      setMessageLimitsBlockedWordsInput('');
      setMessageLimitsBlockedDomainsInput('');
      clearFieldError('messageLimitsBlockedWords');
      clearFieldError('messageLimitsBlockedDomains');
    }

    if (section === 'duplicates') {
      setDuplicateWindowInputValue(null);
    }

    setDraft((current) =>
      current ? mergeSectionSettings(current, savedSettings, section) : current,
    );
  }

  function buildSectionPayload(section: ApplySectionKey) {
    if (section === 'stopWords' && isReloadingStopWords) return null;
    if (section === 'stopWords' && stopWordsStorageLocked) {
      revealStopWordsFeedback(null, 'Подтвердите замену сохранённого списка.');
      return null;
    }
    if (hasSharedSectionErrors(section)) {
      if (section === 'stopWords') revealSharedStopWordsErrors();
      return null;
    }
    if (!draft || !settingsQuery.data) {
      return null;
    }

    const baseSettings =
      section === 'requiredSubscription'
        ? normalizeRequiredSubscriptionDraftSettings(settingsQuery.data)
        : settingsQuery.data;
    let draftSettings =
      section === 'requiredSubscription'
        ? normalizeRequiredSubscriptionDraftSettings(draft)
        : draft;
    if (section === 'stopWords' && draft.stopWordsPolicy) {
      const prepared = prepareStopWordsInput(
        draft.stopWordsPolicy,
        messageLimitsBlockedWordsInput,
        messageLimitsBlockedDomainsInput,
      );
      if (prepared.errors.length) {
        setFieldErrors((current) => ({
          ...current,
          messageLimitsBlockedWords: prepared.errors.join(' '),
        }));
        revealStopWordsFeedback({
          field: 'stopWordsPolicy.rules',
          path: ['stopWordsPolicy', 'rules'],
        });
        return null;
      }
      draftSettings = { ...draft, stopWordsPolicy: prepared.policy };
    }

    return validateDraft(mergeSectionSettings(baseSettings, draftSettings, section), section);
  }

  async function handleSaveSection(section: ApplySectionKey) {
    if (!chatId) {
      return;
    }
    if (section === 'links' && isSectionDirty('stopWords')) {
      pushToast({
        replaceKey: 'settings-links-sites-save',
        tone: 'danger',
        title: 'Сохраните прежние правила сайтов',
        description: 'Кнопка сохранения находится в блоке «Сайты из стоп-слов».',
      });
      return;
    }
    if (settingsConflict?.section === section && settingsConflict.viewingSaved) {
      setSettingsConflict(null);
      closeSection(section);
      return;
    }

    if (!isSectionDirty(section)) {
      closeSection(section);
      return;
    }

    const payload = buildSectionPayload(section);
    if (!payload) {
      if (section === 'stopWords') return;
      if (section === 'links' && sharedFieldErrors.linkRulesPolicy) {
        const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
          '.links-panel__editor input, .links-panel__editor textarea',
        );
        input?.focus();
        input?.scrollIntoView({ block: 'center' });
        return;
      }
      pushToast({
        replaceKey: `settings-validation:${section}`,
        tone: 'danger',
        title: `Исправьте блок «${SECTION_LABELS[section]}»`,
        description: 'В блоке есть ошибки, их нужно исправить перед сохранением.',
      });
      return;
    }
    if (settingsConflict?.section === section)
      payload.settingsRevision = settingsConflict.saved.settingsRevision;

    try {
      await mutateSettingsAsync({ section, payload });
      if (isCurrentSettingsScope()) closeSection(section);
    } catch {
      // Errors are handled by the mutation.
    }
  }

  function openApplyTargetSheet(section: ApplySectionKey) {
    if (!chatId || !draft) {
      return;
    }
    if (section === 'links' && isSectionDirty('stopWords')) {
      pushToast({
        replaceKey: 'settings-links-sites-save',
        tone: 'danger',
        title: 'Сохраните прежние правила сайтов',
        description: 'Кнопка сохранения находится в блоке «Сайты из стоп-слов».',
      });
      return;
    }

    const payload = buildSectionPayload(section);
    if (!payload) {
      if (section === 'stopWords') return;
      if (section === 'links' && sharedFieldErrors.linkRulesPolicy) {
        const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(
          '.links-panel__editor input, .links-panel__editor textarea',
        );
        input?.focus();
        input?.scrollIntoView({ block: 'center' });
        return;
      }
      pushToast({
        replaceKey: `settings-validation:${section}`,
        tone: 'danger',
        title: `Исправьте блок «${SECTION_LABELS[section]}»`,
        description: 'В блоке есть ошибки, их нужно исправить перед сохранением.',
      });
      return;
    }

    void preloadSettingsApplyTargetSheet();
    setApplyTargetPreview(null);
    setApplyTargetPreviewEpoch(null);
    setApplyTargetPreviewLoading(true);
    setApplyTargetSheet({
      sourceChatId: chatId,
      section,
      sourceSettings: payload,
      stopWordsStorageStatus,
      stopWordsReplacement,
      isCurrentScope: isCurrentSettingsScope,
      target: createDefaultApplySettingsTarget(),
    });
  }

  async function handleConfirmApplyTarget() {
    if (!applyTargetSheet) {
      return;
    }
    if (applyTargetSheet.isCurrentScope?.() === false) return;
    if (
      applyTargetSheet.section === 'stopWords' &&
      (stopWordsStorageLocked ||
        (applyTargetSheet.stopWordsReplacement &&
          (applyTargetSheet.stopWordsReplacement.expectedRevision !==
            stopWordsReplacement?.expectedRevision ||
            applyTargetSheet.stopWordsReplacement.chatId !== stopWordsReplacement?.chatId)))
    ) {
      setApplyTargetSheet(null);
      revealStopWordsFeedback(
        null,
        stopWordsStorageLocked
          ? 'Подтвердите замену сохранённого списка.'
          : 'Список изменился. Загрузите сохранённый список перед применением.',
      );
      return;
    }

    if (
      applyTargetPreviewEpoch !== favoritesCompositionEpochRef.current ||
      !applyTargetPreview ||
      applyTargetPreviewLoading
    ) {
      setApplyTargetPreview(null);
      setApplyTargetSheet((current) => (current ? { ...current } : current));
      return;
    }
    try {
      if (
        applyTargetSheet.section === 'reports' &&
        (!applyTargetPreview ||
          applyTargetPreviewLoading ||
          applyTargetPreview.appliedChatIds.length > 500)
      )
        return;
      await applySectionToAllMutation.mutateAsync({
        ...applyTargetSheet,
        sourceChatId: applyTargetSheet.sourceChatId,
        confirmedTargetChatIds:
          applyTargetSheet.section === 'reports' ? applyTargetPreview?.appliedChatIds : undefined,
        reviewedTargetTitles: Object.fromEntries(
          applyTargetPreview.sampleChats
            .filter((chat) => applyTargetPreview.appliedChatIds.includes(chat.id))
            .map((chat) => [chat.id, chat.title]),
        ),
      });
      if (applyTargetSheet.isCurrentScope?.() !== false) closeSection(applyTargetSheet.section);
    } catch {
      // Errors are handled by the mutation.
    }
  }

  async function handleApplyBotSpeechStyle(style: BotSpeechStyle) {
    if (!chatId || isSavingSpeechStyle || style === activeSpeechStyle) {
      return;
    }

    try {
      await saveSpeechStyleMutation.mutateAsync(style);
    } catch {
      // Errors are handled by the mutation.
    }
  }

  useChatSettingsWorkspaceLeaveGuard({
    api,
    chatId,
    draft,
    serverSettings: settingsQuery.data,
    serverRules: rulesQuery.data,
    settingsDirty:
      hasChanges || stopWordsReplacementAuthorized || Object.keys(sharedFieldErrors).length > 0,
    rulesDirty: hasRulesChanges,
    saving:
      isHeaderSaving || isApplyingSectionToAll || isPublishingRules || isResettingPublishedRules,
    validateDraft,
    saveSettings: saveWorkspaceDraft,
    saveRules: () => saveRulesDraftNow({ forceButtonErrors: true }),
    setDraft,
    setRulesDraft,
    onSettingsSaveError: (error) => {
      applyStopWordsServerValidation(error);
      return handleSettingsPermissionError(error, null);
    },
    clearValidationErrors: () => {
      discardStopWordsEditorState();
      setStopWordsModuleError(null);
      setStopWordsFocusRequest(undefined);
      setSharedFieldErrors({});
      setFieldErrors({});
      setRulesTextError('');
      setRulesImageError('');
      setRulesButtonErrors([]);
    },
  });

  function renderSectionSaveFooter(
    section: ApplySectionKey,
    options?: {
      note?: string | null;
      saveLabel?: string;
    },
  ) {
    if (!isSectionDirty(section) && settingsConflict?.section !== section) {
      return null;
    }

    return (
      <Suspense fallback={null}>
        <LazySettingsSectionSaveFooter
          section={section}
          options={options}
          disabled={section === 'stopWords' && stopWordsStorageLocked}
          isSavingSettings={isSavingSettings || (section === 'stopWords' && isReloadingStopWords)}
          savingSection={savingSection}
          isApplyingSectionToAll={isApplyingSectionToAll}
          applyingSection={applyingSection}
          conflict={
            settingsConflict?.section === section
              ? {
                  viewingSaved: settingsConflict.viewingSaved,
                  onToggle: () => {
                    setDraft((current) =>
                      current
                        ? {
                            ...mergeSectionSettings(
                              current,
                              settingsConflict.viewingSaved
                                ? settingsConflict.draft
                                : settingsConflict.saved,
                              section,
                            ),
                            settingsRevision: current.settingsRevision,
                          }
                        : current,
                    );
                    setSettingsConflict({
                      ...settingsConflict,
                      viewingSaved: !settingsConflict.viewingSaved,
                    });
                  },
                }
              : undefined
          }
          onSaveSection={(targetSection) => void handleSaveSection(targetSection)}
        />
      </Suspense>
    );
  }

  function renderApplyTargetHeaderAction(section: ApplySectionKey) {
    if (!canApplyToAllChats) {
      return null;
    }

    const isApplying = isApplyingSectionToAll && applyingSection === section;
    return (
      <button
        type="button"
        className="settings-drilldown__header-action"
        aria-label="Применить к другим чатам"
        onClick={() => openApplyTargetSheet(section)}
        disabled={
          isSavingSettings ||
          isApplyingSectionToAll ||
          (section === 'stopWords' && (isReloadingStopWords || stopWordsStorageLocked))
        }
      >
        {isApplying ? (
          'Применяем...'
        ) : (
          <>
            <span className="settings-drilldown__header-action-label--full">Другие чаты</span>
            <span className="settings-drilldown__header-action-label--compact">Ещё чаты</span>
          </>
        )}
      </button>
    );
  }

  function createSingleFields(section: ApplySectionKey) {
    return draft
      ? createChatSettingsFieldAdapter({
          settings: draft,
          baseline: settingsQuery.data,
          onChange: (next) => {
            if (section === 'stopWords' && stopWordsStorageLocked) return;
            setDraft(next);
          },
          readOnly:
            isSavingSettings ||
            isApplyingSectionToAll ||
            (section === 'stopWords' && isReloadingStopWords),
          errors: { ...fieldErrors, ...sharedFieldErrors },
          onError: (path, error) =>
            setSharedFieldErrors((current) => {
              const next = { ...current };
              if (error) next[path] = error;
              else delete next[path];
              return next;
            }),
        })
      : null;
  }
  const singleNavigationAllowlist = (
    <>
      {isAllowlistMode ? (
        <div className="allowlist-workspace">
          <div
            className={cn('field', 'allowlist-panel', domainInputError && 'allowlist-panel--error')}
          >
            <div className="allowlist-panel__head">
              <span className="field__label">Разрешённые ссылки</span>
            </div>

            <div className="allowlist-composer">
              <label className="allowlist-composer__head">
                <span className="field__label allowlist-composer__label">Что разрешить</span>
                <select
                  className="button button--ghost"
                  value={domainInputKind}
                  disabled={isDomainMutationPending}
                  onChange={(event) => {
                    setDomainInputKind(event.target.value as NavigationAllowlistKind);
                    setDomainInputError('');
                  }}
                  aria-label="Что разрешить"
                >
                  {NAVIGATION_ALLOWLIST_TARGET_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="allowlist-add-row">
                <input
                  type="text"
                  inputMode={getNavigationAllowlistTargetOption(domainInputKind).inputMode}
                  value={domainInput}
                  disabled={isDomainMutationPending}
                  aria-invalid={Boolean(domainInputError)}
                  aria-describedby={domainInputError ? 'allowlist-input-error' : undefined}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  enterKeyHint="done"
                  onChange={(event) => {
                    setDomainInput(event.target.value);
                    setDomainInputError('');
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      handleAddDomain();
                    }
                  }}
                  placeholder={getNavigationAllowlistTargetOption(domainInputKind).placeholder}
                  aria-label={getNavigationAllowlistTargetOption(domainInputKind).ariaLabel}
                />

                {domainInput.trim() ? (
                  <button
                    type="button"
                    className="button button--accent allowlist-add-row__button"
                    onClick={handleAddDomain}
                    disabled={isDomainMutationPending}
                  >
                    {addDomainMutation.isPending ? 'Добавляем...' : 'Добавить'}
                  </button>
                ) : null}
              </div>
            </div>

            {domainInputError ? (
              <small id="allowlist-input-error" className="field__hint" role="alert">
                {domainInputError}
              </small>
            ) : null}

            {domainsQuery.isLoading ? <p className="allowlist-empty">Загрузка...</p> : null}

            {domainsQuery.error ? (
              <p className="allowlist-empty allowlist-empty--error">
                Ошибка: {formatApiError(domainsQuery.error)}
              </p>
            ) : null}

            {!domainsQuery.isLoading && !domainsQuery.error ? (
              allowlistEntries.length > 0 ? (
                <div className="allowlist-results">
                  <ul className="allowlist-list" aria-label="Разрешённые навигационные цели">
                    {allowlistEntries.map((entry) => {
                      const isScheduleOpen = scheduleDomain === entry.normalizedValue;
                      const targetLabel = formatNavigationAllowlistEntryTarget(entry);
                      const scheduledAtLabel = formatRemovalDateTime(entry.removeAfterAt);
                      return (
                        <li
                          key={entry.normalizedValue}
                          className={cn('allowlist-item', 'allowlist-item--domain')}
                        >
                          <div className="allowlist-item__stack">
                            <div className="allowlist-item__header">
                              <div className="allowlist-item__lead">
                                <span className="allowlist-item__domain" title={targetLabel}>
                                  {targetLabel}
                                </span>
                                <small className="allowlist-item__type">
                                  {formatNavigationAllowlistEntryKindLabel(entry)} ·{' '}
                                  {scheduledAtLabel ? `до ${scheduledAtLabel}` : 'без срока'}
                                </small>
                              </div>
                              <div className="allowlist-item__actions">
                                <button
                                  type="button"
                                  className={cn(
                                    'allowlist-item__action',
                                    'allowlist-item__action--schedule',
                                    isScheduleOpen && 'is-open',
                                  )}
                                  aria-label={
                                    isScheduleOpen
                                      ? `Закрыть выбор срока для ${targetLabel}`
                                      : scheduledAtLabel
                                        ? `Изменить срок для ${targetLabel}`
                                        : `Задать срок для ${targetLabel}`
                                  }
                                  title={
                                    isScheduleOpen
                                      ? 'Закрыть'
                                      : scheduledAtLabel
                                        ? 'Изменить срок'
                                        : 'Задать срок'
                                  }
                                  onClick={() => toggleDomainScheduleEditor(entry)}
                                  disabled={isDomainMutationPending}
                                >
                                  <CalendarIcon />
                                </button>
                                <button
                                  type="button"
                                  className={cn(
                                    'allowlist-item__action',
                                    'allowlist-item__action--remove',
                                  )}
                                  onClick={() => removeDomainMutation.mutate(entry.normalizedValue)}
                                  disabled={isDomainMutationPending}
                                  aria-label={`Удалить ${targetLabel}`}
                                  title="Удалить"
                                >
                                  <TrashIcon />
                                </button>
                              </div>
                            </div>

                            {isScheduleOpen ? (
                              <div
                                className="allowlist-item__schedule-editor"
                                role="group"
                                aria-label={`План удаления ${targetLabel}`}
                              >
                                <div className="allowlist-item__schedule-fields">
                                  <Suspense fallback={null}>
                                    <LazySettingsDateField
                                      className="allowlist-item__schedule-field"
                                      label="День удаления"
                                      value={scheduleDate}
                                      min={toLocalDateInputValue(new Date())}
                                      onChange={(nextValue) => {
                                        setScheduleDate(nextValue);
                                        setScheduleError('');
                                      }}
                                    />
                                  </Suspense>
                                  <div className="field allowlist-item__schedule-field">
                                    <Suspense fallback={null}>
                                      <LazySettingsTimeFields
                                        kind="schedule"
                                        value={scheduleTime}
                                        onChange={(nextValue) => {
                                          setScheduleTime(nextValue);
                                          setScheduleError('');
                                        }}
                                      />
                                    </Suspense>
                                  </div>
                                </div>

                                {scheduleError ? (
                                  <small className="field__hint">{scheduleError}</small>
                                ) : null}

                                <div className="allowlist-item__schedule-actions">
                                  <button
                                    type="button"
                                    className="button button--accent"
                                    onClick={() => submitDomainSchedule(entry.normalizedValue)}
                                    disabled={isDomainMutationPending}
                                  >
                                    {scheduleDomainRemovalMutation.isPending
                                      ? 'Сохраняем...'
                                      : 'Сохранить'}
                                  </button>
                                  {entry.removeAfterAt ? (
                                    <button
                                      type="button"
                                      className="button button--ghost"
                                      onClick={() => clearDomainSchedule(entry.normalizedValue)}
                                      disabled={isDomainMutationPending}
                                    >
                                      Убрать таймер
                                    </button>
                                  ) : null}
                                </div>
                              </div>
                            ) : null}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : (
                <p className="allowlist-empty">Пока пусто</p>
              )
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
  const singleSubscriptionSources = (
    <>
      <div className="managed-giveaway__section required-subscription__board">
        <div className="managed-giveaway__title-row">
          <div className="managed-giveaway__section-copy required-subscription__heading">
            <strong>Куда подписаться</strong>
            <small
              className="required-subscription__count"
              data-state={
                requiredSubscriptionStaleCount > 0
                  ? 'warning'
                  : requiredSubscriptionIsActive
                    ? 'active'
                    : 'empty'
              }
              aria-label={`Выбрано источников: ${requiredSubscriptionSelectedCount} из ${REQUIRED_SUBSCRIPTION_MAX_CHANNELS}`}
            >
              {requiredSubscriptionSelectedCount}/{REQUIRED_SUBSCRIPTION_MAX_CHANNELS}
            </small>
          </div>
        </div>

        {requiredSubscriptionStaleCount > 0 ? (
          <p className={cn('settings-native-toggle__hint', 'settings-native-toggle__hint--danger')}>
            Есть недоступные ссылки. Исправьте или удалите их.
          </p>
        ) : null}

        {requiredSubscriptionSelectedCount === 0 ? (
          <div className="required-subscription__selection-empty">
            <strong>Источники пока не выбраны</strong>
          </div>
        ) : null}

        {selectedRequiredSubscriptionChannels.length > 0 ? (
          <div className="required-subscription__selection-list">
            {selectedRequiredSubscriptionChannels.map((channel) => {
              const linkPreview = formatRequiredSubscriptionLinkPreview(channel.link);

              return (
                <div
                  key={`required-subscription-channel-${channel.id}`}
                  className="required-subscription__selection-card"
                >
                  <EntityAvatar
                    title={channel.title}
                    entityType={channel.entityType}
                    avatarUrl={channel.avatarUrl}
                    className="required-subscription__selection-avatar"
                  />
                  <div
                    className="required-subscription__selection-body"
                    title={channel.link || channel.title}
                  >
                    <strong className="required-subscription__selection-title">
                      {channel.title}
                    </strong>
                    <div className="required-subscription__selection-meta">
                      <span className="required-subscription__selection-kind">
                        {formatRequiredSubscriptionEntityLabel(channel.entityType)}
                      </span>
                      {linkPreview ? (
                        <span className="required-subscription__selection-link">{linkPreview}</span>
                      ) : null}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="required-subscription__selection-remove"
                    onClick={() => removeRequiredSubscriptionChannel(channel.id)}
                    aria-label={`Удалить ${formatRequiredSubscriptionEntityLabel(channel.entityType).toLowerCase()} ${channel.title}`}
                  >
                    <TrashIcon />
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}

        {selectedUnavailableRequiredSubscriptionChannels.length > 0 ? (
          <div className="required-subscription__selection-list">
            {selectedUnavailableRequiredSubscriptionChannels.map((channel, index) => (
              <div
                key={`required-subscription-stale-${channel.id}`}
                className={cn('required-subscription__selection-card', 'is-warning')}
              >
                <span className="required-subscription__selection-rank">
                  {selectedRequiredSubscriptionChannels.length + index + 1}
                </span>
                <div className="required-subscription__selection-body" title={channel.description}>
                  <div className="required-subscription__selection-meta">
                    <span className="required-subscription__selection-state">Недоступно</span>
                  </div>
                  <strong className="required-subscription__selection-title">
                    Недоступный источник {selectedRequiredSubscriptionChannels.length + index + 1}
                  </strong>
                  <small className="required-subscription__selection-detail">
                    {channel.description}
                  </small>
                </div>
                <button
                  type="button"
                  className="required-subscription__selection-remove"
                  onClick={() => removeRequiredSubscriptionChannel(channel.id)}
                  aria-label={`Удалить недоступный источник ${selectedRequiredSubscriptionChannels.length + index + 1}`}
                >
                  <TrashIcon />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        {requiredSubscriptionChannelsError ? (
          <small className="field__hint">{requiredSubscriptionChannelsError}</small>
        ) : null}

        <RequiredSubscriptionSourceDisclosure
          initiallyOpen={requiredSubscriptionSelectedCount === 0}
        >
          <Suspense
            fallback={
              <div className="required-subscription__source-picker">
                <div className="required-subscription__source-skeleton" aria-hidden>
                  <span />
                  <span />
                  <span />
                </div>
              </div>
            }
          >
            <LazyRequiredSubscriptionSourcePicker
              choices={availableRequiredSubscriptionChannelChoices}
              selectedCount={requiredSubscriptionSelectedCount}
              maxSelectedCount={REQUIRED_SUBSCRIPTION_MAX_CHANNELS}
              loading={requiredSubscriptionEntitiesLoading}
              syncing={requiredSubscriptionEntitiesSyncing}
              error={
                requiredSubscriptionEntitiesError
                  ? formatApiError(requiredSubscriptionEntitiesError)
                  : null
              }
              backoffActive={requiredSubscriptionEntitiesBackoffActive}
              emptyState={requiredSubscriptionPickerEmptyState}
              onAdd={addRequiredSubscriptionChannel}
              onRefresh={refreshRequiredSubscriptionChannels}
            />
          </Suspense>

          <RequiredSubscriptionExternalSource
            value={requiredSubscriptionExternalChannelValue}
            error={requiredSubscriptionExternalChannelError}
            loading={isResolvingRequiredSubscriptionChannel}
            limitReached={requiredSubscriptionSelectedCount >= REQUIRED_SUBSCRIPTION_MAX_CHANNELS}
            onChange={(value) => {
              setRequiredSubscriptionExternalChannelValue(value);
              setRequiredSubscriptionExternalChannelError('');
            }}
            onSubmit={handleResolveRequiredSubscriptionExternalChannel}
          />
        </RequiredSubscriptionSourceDisclosure>
      </div>
    </>
  );
  async function reloadStopWordsPolicy() {
    if (!chatId || !settingsQuery.data || isReloadingStopWords) return;
    const request = Symbol('stop-words-reload');
    stopWordsReloadRequestRef.current = request;
    setIsReloadingStopWords(true);
    try {
      const saved = await getStopWords(api, chatId);
      if (!isCurrentSettingsScope() || stopWordsReloadRequestRef.current !== request) return;
      const accepted = await syncSavedStopWords(
        saved,
        draft ?? settingsQuery.data,
        settingsQuery.data,
        chatId,
        true,
      );
      if (
        accepted === false ||
        !isCurrentSettingsScope() ||
        stopWordsReloadRequestRef.current !== request
      )
        return;
      setMessageLimitsBlockedWordsInput('');
      setMessageLimitsBlockedDomainsInput('');
      clearFieldError('messageLimitsBlockedWords');
      clearFieldError('messageLimitsBlockedDomains');
      setStopWordsModuleError(null);
      setStopWordsFocusRequest(undefined);
      resetSharedSectionEditor('stopWords');
    } finally {
      if (stopWordsReloadRequestRef.current === request) {
        stopWordsReloadRequestRef.current = null;
        setIsReloadingStopWords(false);
      }
    }
  }
  function renderSharedChatSection(section: ApplySectionKey) {
    const singleFields = createSingleFields(section);
    if (!singleFields) return null;
    const reportsAvailable = expandedSections.reports
      ? !reportsAvailabilityQuery.isError &&
        reportsAvailabilityQuery.data?.reportsAvailable === true
      : settingsScreenQuery.data?.reportsAvailable === true;
    const stopWordsTool = (slot: 'toolbar' | 'notice' | 'preview' | 'imageScan') => (
      <Suspense fallback={null}>
        <LazySettingsStopWordsSingleTools
          slot={slot}
          api={api}
          chatId={chatId ?? ''}
          policy={draft?.stopWordsPolicy}
          revision={draft?.stopWordsRevision}
          dirty={isSectionDirty('stopWords')}
          busy={isSavingSettings || isApplyingSectionToAll || isReloadingStopWords}
          invalid={hasSharedSectionErrors('stopWords') || stopWordsStorageLocked}
          conflict={stopWordsConflict}
          reloadPolicy={reloadStopWordsPolicy}
        />
      </Suspense>
    );
    const advertisingModules: Partial<Record<ApplySectionKey, MarketplaceButtonModule>> = {
      greeting: 'GREETING',
      links: 'LINKS',
      profanityFilter: 'PROFANITY',
      commercialFilter: 'COMMERCIAL',
      duplicates: 'DUPLICATES',
      limits: 'MESSAGE_LIMITS',
      stopWords: 'STOP_WORDS',
      phones: 'PHONE_NUMBERS',
      requiredSubscription: 'REQUIRED_SUBSCRIPTION',
      invitationAccess: 'INVITATION_ACCESS',
      night: 'NIGHT_MODE',
    };
    const advertisingModule = advertisingModules[section];
    return (
      <SharedChatSettingsSection
        key={`${chatId}:${section}:${sharedSectionEpochs[section] ?? 0}`}
        section={section}
        fields={singleFields}
        context={{
          mode: 'single',
          stopWordsEditor:
            section === 'stopWords'
              ? {
                  storageStatus: stopWordsStorageStatus,
                  replacementAuthorized: stopWordsReplacementAuthorized,
                  onAuthorizeReplacement: () => {
                    authorizeStopWordsReplacement();
                    setStopWordsModuleError(null);
                  },
                  focusRequest: stopWordsFocusRequest,
                  moduleError: stopWordsModuleError ?? stopWordsSaveError,
                }
              : undefined,
          sectionTools:
            advertisingModule && chatId && expandedSections[section]
              ? {
                  [section]: (
                    <Suspense fallback={null}>
                      <MarketplaceModuleToggle
                        api={api}
                        entityId={chatId}
                        entityType="chat"
                        profile="moderation"
                        module={advertisingModule}
                      />
                    </Suspense>
                  ),
                }
              : undefined,
          hasPublishedRules,
          api,
          commercialAiModerationMode: settingsScreenQuery.data?.commercialAiModerationMode,
          commercialScope:
            section === 'commercialFilter' && chatId
              ? {
                  api,
                  chatId,
                  prefill: readCommercialExceptionPrefill(location.search),
                  onOpenJournal: () =>
                    navigate(
                      `/chat/${encodeURIComponent(chatId)}/events?section=moderation&moderationView=history&filter=COMMERCIAL`,
                    ),
                }
              : undefined,
          stopWordsTools:
            section === 'stopWords'
              ? {
                  toolbar: stopWordsTool('toolbar'),
                  notice: stopWordsTool('notice'),
                  preview: stopWordsTool('preview'),
                  imageScan: stopWordsTool('imageScan'),
                }
              : undefined,
          duplicatePresentation: {
            messageMode: settingsScreenQuery.data?.duplicateMessageModerationMode ?? 'OFF',
            photoPolicy: duplicatePhotoModerationPolicy,
          },
          limitsRuntime: {
            deleteSpammersStatus: deleteSpammersRuntimeStatus,
            enforcementMode: spammerReviewMetricsQuery.data?.enforcementMode,
          },
          navigationAllowlist: singleNavigationAllowlist,
          linkRules:
            section === 'links'
              ? {
                  legacySnapshot: draft?.linkRulesLegacySnapshot,
                  storageStatus: draft?.linkRulesStorageStatus,
                  replacementAuthorized: draft?.linkRulesReplaceInvalidStorage === true,
                  onAuthorizeReplacement: () =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            linkRulesReplaceInvalidStorage: true,
                            linkRulesPolicy: { version: 1, mode: 'ALLOW_ALL', rules: [] },
                          }
                        : current,
                    ),
                  loading: settingsScreenQuery.isLoading,
                  error: settingsScreenQuery.error
                    ? formatApiError(settingsScreenQuery.error)
                    : null,
                  preview: chatId
                    ? async (policy, text) => {
                        const { previewLinks } = await import('../lib/api/links-client');
                        return previewLinks(api, chatId, policy, text);
                      }
                    : undefined,
                  legacySites:
                    draft?.stopWordsPolicy?.domains.length ||
                    settingsQuery.data?.stopWordsPolicy?.domains.length ||
                    stopWordsStorageStatus === 'invalid' ? (
                      <Suspense fallback={<Spinner label="Загружаем сайты" />}>
                        <LazySettingsLinkLegacySites
                          fields={createSingleFields('stopWords') ?? singleFields}
                          context={{
                            mode: 'single',
                            api,
                            stopWordsEditor: {
                              storageStatus: stopWordsStorageStatus,
                              replacementAuthorized: stopWordsReplacementAuthorized,
                              onAuthorizeReplacement: authorizeStopWordsReplacement,
                              focusRequest: stopWordsFocusRequest,
                              moduleError: stopWordsModuleError ?? stopWordsSaveError,
                            },
                            stopWordsTools: {
                              toolbar: stopWordsTool('toolbar'),
                              notice: stopWordsTool('notice'),
                              imageScan: stopWordsTool('imageScan'),
                            },
                          }}
                          dirty={isSectionDirty('stopWords')}
                          saving={isSavingSettings}
                          onDiscard={() => discardSectionChanges('stopWords')}
                          onSave={async () => {
                            const payload = buildSectionPayload('stopWords');
                            if (payload)
                              await mutateSettingsAsync({ section: 'stopWords', payload });
                          }}
                        />
                      </Suspense>
                    ) : null,
                }
              : undefined,
          requiredSubscriptionSources: singleSubscriptionSources,
          reportsActivationAvailable:
            reportsAvailable || settingsQuery.data?.reportsEnabled === true,
          runtimeNotes: {
            reports: reportsAvailable ? null : (
              <p className="reports-availability" role="status">
                {reportsAvailabilityQuery.isPending
                  ? 'Проверяем приём жалоб…'
                  : 'Приём жалоб приостановлен оператором.'}
              </p>
            ),
          },
          renderAdminContact: ({ enabledPath, urlPath, label }) => {
            if (!chatId) return null;
            const enabled = singleFields.read(enabledPath);
            const url = singleFields.read(urlPath);
            return (
              <AdminContactToggle
                api={api}
                chatId={chatId}
                title={ADMIN_CONTACT_BUTTON_TEXT}
                checked={enabled.kind === 'common' && enabled.value === true}
                url={url.kind === 'common' && typeof url.value === 'string' ? url.value : ''}
                ariaLabel={label}
                nested
                onChange={(nextEnabled, nextUrl) =>
                  singleFields.transact([
                    { op: 'set', path: enabledPath, value: nextEnabled },
                    { op: 'set', path: urlPath, value: nextUrl },
                  ])
                }
              />
            );
          },
        }}
      />
    );
  }

  return (
    <div className="page-stack page-enter" data-managed-entity-workspace="chat-settings">
      <ChatSettingsWorkspaceHeader
        api={api}
        userId={meQuery.data?.userId ?? null}
        chatId={chatId}
        title={chatTitle}
        header={chatHeaderQuery.data}
        fallbackAvatarUrl={routeChatAvatarUrl}
        backTo={managedChatsRoute}
        counterpartHidden={
          !chatId || handoffRequested || Boolean(handoffMode) || legacyBroadcastWorkspaceRequested
        }
        compact={isHeaderCompact}
      />

      {applyTargetSheet ? (
        <Suspense fallback={null}>
          <LazySettingsApplyTargetSheet
            api={api}
            sheet={applyTargetSheet}
            preview={
              applyTargetPreviewEpoch === favoritesCompositionEpoch ? applyTargetPreview : null
            }
            previewLoading={
              applyTargetPreviewLoading || applyTargetPreviewEpoch !== favoritesCompositionEpoch
            }
            previewError={applyTargetPreviewError}
            sectionLabel={SECTION_LABELS[applyTargetSheet.section]}
            overlayStyle={applyTargetOverlayStyle}
            isApplying={isApplyingSectionToAll}
            onClose={() => setApplyTargetSheet(null)}
            onTargetChange={(target) => {
              setApplyTargetPreview(null);
              setApplyTargetPreviewEpoch(null);
              setApplyTargetPreviewLoading(true);
              setApplyTargetSheet((current) => (current ? { ...current, target } : current));
            }}
            onConfirm={() => void handleConfirmApplyTarget()}
          />
        </Suspense>
      ) : null}

      <Suspense fallback={null}>
        <LazyBotPermissionRequiredDialog
          id="chat-settings-bot-permission"
          blocker={permissionBlocker}
          isRechecking={saveSectionMutation.isPending}
          onClose={() => {
            pendingPermissionRetryRef.current = null;
            setPermissionBlocker(null);
          }}
          onRecheck={() => {
            const pendingRetry = pendingPermissionRetryRef.current;
            if (!pendingRetry) {
              setPermissionBlocker(null);
              return;
            }
            setPermissionBlocker(null);
            saveSectionMutation.mutate({
              ...pendingRetry,
              recheckBotCapabilities: true,
            });
          }}
        />
      </Suspense>

      {handoffMode ? (
        <Suspense fallback={null}>
          <HandoffState mode={handoffMode} error={handoffError} onRetry={refetchSettings} />
        </Suspense>
      ) : null}

      {settingsQuery.isLoading && handoffMode !== 'loading' ? (
        <section className="settings-sections" aria-label="Загрузка настроек">
          <SettingsOverviewLoading desktopLines={5} />
        </section>
      ) : null}

      {settingsQuery.error && handoffMode !== 'error' ? (
        <SettingsLoadErrorState
          entityType="chat"
          error={settingsQuery.error}
          onRetry={refetchSettings}
        />
      ) : null}

      {settingsScreenQuery.data &&
      settingsScreenQuery.isFetching &&
      !settingsScreenQuery.isFetchedAfterMount ? (
        <p role="status">Проверяем права. Сохранённые настройки уже доступны для просмотра.</p>
      ) : null}
      {!handoffMode && !settingsQuery.isLoading && !settingsQuery.error && draft ? (
        <section
          className="settings-sections settings-sections--chat-home"
          aria-label="Настройки чата"
          inert={settingsScreenQuery.isFetching && !settingsScreenQuery.isFetchedAfterMount}
          onClickCapture={handleDesktopToggleRowClick}
        >
          {settingsScreenQuery.data?.header.accessDiagnostics?.state === 'bot_access_lost' ? (
            <Suspense fallback={null}>
              <LazyManagedEntityAccessDiagnosticsBanner
                diagnostics={settingsScreenQuery.data.header.accessDiagnostics}
                entityLabel="чат"
                isRechecking={recheckAccessMutation.isPending}
                onRecheck={() => recheckAccessMutation.mutate()}
              />
            </Suspense>
          ) : null}

          {speechStylePanelOpen && pendingSpeechStyle ? (
            <Suspense fallback={null}>
              <LazySettingsSpeechStylePanel
                activeStyle={activeSpeechStyle}
                selectedStyle={pendingSpeechStyle}
                previewContext={botSpeechPreviewContext}
                isSaving={isSavingSpeechStyle}
                onSelect={setPendingSpeechStyle}
                onClose={() => {
                  if (!isSavingSpeechStyle) {
                    setSpeechStylePanelOpen(false);
                    setPendingSpeechStyle(null);
                  }
                }}
                onCancel={() => {
                  setSpeechStylePanelOpen(false);
                  setPendingSpeechStyle(null);
                }}
                onDiscard={() => setPendingSpeechStyle(activeSpeechStyle)}
                onSave={(style) => void handleApplyBotSpeechStyle(style)}
              />
            </Suspense>
          ) : null}

          <Suspense fallback={<SettingsOverviewSearchPlaceholder />}>
            <LazySettingsOverviewSearch
              key={chatId}
              containerId="chat-settings-overview"
              entrySelector=".settings-home-entry"
              groupSelector=".settings-home-group-head"
            />
          </Suspense>

          <div id="chat-settings-overview" className="settings-sections-shell">
            <SettingsOverviewGroups groups={CHAT_SETTINGS_OVERVIEW_GROUPS}>
              <SettingsOverviewEntry order={SHARED_CHAT_SECTION_PRESENTATIONS.links.order}>
                <GlassCard
                  className="settings-section settings-home-entry settings-home-entry--priority stagger-in"
                  style={{ order: SHARED_CHAT_SECTION_PRESENTATIONS.links.order }}
                >
                  <div
                    className={cn('settings-section__head', 'settings-section__head--interactive')}
                  >
                    <SettingsSectionToggle
                      title={SHARED_CHAT_SECTION_PRESENTATIONS.links.title}
                      enabled={draft.linkPolicy !== 'ALERT_ONLY'}
                      summary={linksHeaderSummary}
                      status={linksCardStatus}
                      icon={SHARED_CHAT_SECTION_PRESENTATIONS.links.icon}
                      tone={SHARED_CHAT_SECTION_PRESENTATIONS.links.tone}
                      open={expandedSections.links}
                      controls="settings-links-content"
                      onClick={() => toggleSection('links')}
                    />
                  </div>

                  <SettingsDrilldownPanel
                    id="settings-links-content"
                    icon={
                      <SettingsSectionIcon name={SHARED_CHAT_SECTION_PRESENTATIONS.links.icon} />
                    }
                    open={expandedSections.links}
                    title={SHARED_CHAT_SECTION_PRESENTATIONS.links.title}
                    summary={linksHeaderSummary}
                    tone={SHARED_CHAT_SECTION_PRESENTATIONS.links.tone}
                    className={SHARED_CHAT_SECTION_PRESENTATIONS.links.panelClassName}
                    onClose={() => toggleSection('links')}
                    headerAction={renderApplyTargetHeaderAction('links')}
                    confirmCloseWhen={isSectionDirty('links')}
                    onDiscardChanges={() => {
                      discardSectionChanges('links');
                      discardSectionChanges('stopWords');
                    }}
                    footer={renderSectionSaveFooter('links', {
                      note: isLinksKeyboardOpen ? null : undefined,
                    })}
                    keepFooterVisibleWhenKeyboardOpen
                  >
                    {expandedSections.links ? renderSharedChatSection('links') : null}
                  </SettingsDrilldownPanel>
                </GlassCard>
              </SettingsOverviewEntry>

              <SettingsOverviewEntry order={21}>
                <GlassCard
                  className="settings-section settings-home-entry settings-home-entry--list stagger-in"
                  style={{ animationDelay: '45ms', order: 21 }}
                  aria-label="Правила"
                >
                  <div
                    className={cn('settings-section__head', 'settings-section__head--interactive')}
                  >
                    <SettingsSectionToggle
                      title="Правила"
                      summary={rulesHeaderSummary}
                      status={rulesCardStatus}
                      icon="rules"
                      tone="ink"
                      open={expandedSections.rules}
                      controls="settings-rules-content"
                      onClick={() => toggleSection('rules')}
                    />
                  </div>

                  <SettingsDrilldownPanel
                    id="settings-rules-content"
                    icon={<SettingsSectionIcon name="rules" />}
                    open={expandedSections.rules}
                    title="Правила"
                    summary={rulesHeaderSummary}
                    variant="screen"
                    tone="ink"
                    className="settings-drilldown__panel--campaign settings-drilldown__panel--rules settings-drilldown__panel--broadcast-screen settings-drilldown__panel--rules-screen"
                    onClose={() => toggleSection('rules')}
                    footer={rulesDrilldownFooter}
                  >
                    <div
                      id="settings-rules-content"
                      className={cn(
                        'settings-section__collapse',
                        expandedSections.rules && 'is-open',
                      )}
                    >
                      {expandedSections.rules ? (
                        <div className="settings-section__collapse-inner">
                          <div className="rules-panel">
                            {rulesQuery.isLoading ? (
                              <p className="allowlist-empty">Загрузка правил...</p>
                            ) : null}

                            {rulesQuery.error ? (
                              <p className="allowlist-empty allowlist-empty--error">
                                Ошибка: {formatApiError(rulesQuery.error)}
                              </p>
                            ) : null}

                            {!rulesQuery.isLoading && !rulesQuery.error && rulesDraft ? (
                              <Suspense fallback={<SkeletonCard lines={4} />}>
                                <SharedRulesSettingsStudio
                                  header={
                                    <BroadcastStudioHeader
                                      title="Пост правил"
                                      subtitle={rulesStudioSubtitle}
                                      readyCount={rulesStudioReadyCount}
                                      totalCount={rulesStudioSignals.length}
                                      signals={rulesStudioSignals}
                                      busy={isRulesBusy}
                                      ariaLabel="Сводка правил"
                                    />
                                  }
                                  composer={
                                    <Suspense fallback={null}>
                                      <LazyBroadcastContentComposer
                                        key={chatId}
                                        className="rules-content-composer"
                                        text={rulesDraft.text}
                                        sourceFormat={rulesDraft.textFormat}
                                        maxLength={MAX_CHAT_RULES_TEXT_LENGTH}
                                        image={{
                                          enabled: rulesHasImage,
                                          base64: rulesDraft.imageBase64,
                                          mimeType: rulesDraft.imageMimeType,
                                          fileName: rulesDraft.imageFileName,
                                        }}
                                        disabled={isRulesDraftEditingDisabled}
                                        textError={rulesTextError}
                                        imageError={rulesImageError}
                                        onImagePreparationChange={handleRulesImagePreparationChange}
                                        messageAriaLabel="Пост правил"
                                        textPlaceholder="Текст правил"
                                        textAriaLabel="Текст правил"
                                        onTextChange={(nextText) => {
                                          setRulesTextError('');
                                          setRulesDraft((current) =>
                                            current
                                              ? {
                                                  ...current,
                                                  autoTextEnabled: false,
                                                  text: nextText,
                                                  textFormat: 'markdown',
                                                }
                                              : current,
                                          );
                                        }}
                                        onImageChange={(nextImage) => {
                                          setRulesImageError('');
                                          setRulesDraft((current) =>
                                            current
                                              ? {
                                                  ...current,
                                                  imageBase64: nextImage.enabled
                                                    ? nextImage.base64
                                                    : '',
                                                  imageMimeType: nextImage.enabled
                                                    ? nextImage.mimeType
                                                    : '',
                                                  imageFileName: nextImage.enabled
                                                    ? nextImage.fileName
                                                    : '',
                                                }
                                              : current,
                                          );
                                        }}
                                        onError={(message) => {
                                          setRulesImageError(message);
                                          maxNotify('error');
                                        }}
                                        buttons={normalizedRulesButtons}
                                        buttonsStatusLabel={rulesButtonStatus}
                                        buttonsActive={rulesButtonEnabled}
                                        buttonsError={!rulesButtonDraftValid}
                                        onOpenButtons={() => setRulesButtonsSheetOpen(true)}
                                      />
                                    </Suspense>
                                  }
                                  hasContent={rulesHasPublishableContent}
                                  autoText={{
                                    kind: 'common',
                                    value: Boolean(rulesDraft.autoTextEnabled),
                                  }}
                                  autoTextSummary={rulesAutoFillSummary}
                                  onAutoTextChange={(enabled) =>
                                    void handleRulesAutoTextChange(enabled)
                                  }
                                  adminContact={
                                    chatId ? (
                                      <>
                                        <AdminContactToggle
                                          key={`${chatId}:rules`}
                                          api={api}
                                          chatId={chatId}
                                          title={ADMIN_CONTACT_BUTTON_TEXT}
                                          checked={Boolean(rulesDraft.adminContactButtonEnabled)}
                                          url={rulesDraft.adminContactButtonUrl}
                                          onChange={handleRulesAdminContactButtonChange}
                                          ariaLabel="Добавить связь с админом в пост правил"
                                          meta={rulesAdminContactButtonSummary}
                                          className="rules-native-card"
                                        />
                                        <Suspense fallback={null}>
                                          <MarketplaceModuleToggle
                                            api={api}
                                            entityId={chatId}
                                            entityType="chat"
                                            profile="moderation"
                                            module="RULES"
                                          />
                                        </Suspense>
                                      </>
                                    ) : null
                                  }
                                  attachViolations={{
                                    kind: 'common',
                                    value: Boolean(draft?.rulesAttachViolationsEnabled),
                                  }}
                                  violationsSummary={rulesViolationButtonSummary}
                                  attachDisabled={updateRulesAttachMutation.isPending}
                                  onAttachViolationsChange={(enabled) =>
                                    updateRulesAttachMutation.mutate(enabled)
                                  }
                                />
                              </Suspense>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  </SettingsDrilldownPanel>
                </GlassCard>
              </SettingsOverviewEntry>

              <SettingsOverviewEntry order={24}>
                {chatId ? (
                  <SettingsPollsSection
                    api={api}
                    chatId={chatId}
                    expanded={expandedSections.polls}
                    onOpen={() => toggleSection('polls')}
                    onClose={() => closeSection('polls')}
                  />
                ) : null}
              </SettingsOverviewEntry>

              <SettingsOverviewEntry order={25}>
                {chatId ? (
                  <GlassCard
                    className="settings-section settings-home-entry settings-home-entry--list stagger-in"
                    style={{ animationDelay: '56ms', order: 25 }}
                    aria-label="Розыгрыши"
                  >
                    <div
                      className={cn(
                        'settings-section__head',
                        'settings-section__head--interactive',
                      )}
                    >
                      <SettingsSectionToggle
                        title="Розыгрыши"
                        summary="Запуск, участники и итоги"
                        status=""
                        icon="gift"
                        tone="amber"
                        open={expandedSections.giveaway}
                        controls="settings-giveaway-content"
                        onClick={toggleGiveawaySection}
                      />
                    </div>

                    <SettingsDrilldownPanel
                      id="settings-giveaway-content"
                      icon={<SettingsSectionIcon name="gift" />}
                      open={expandedSections.giveaway}
                      title="Розыгрыши"
                      summary="Запуск, участники и итоги"
                      tone="amber"
                      className="settings-drilldown__panel--campaign settings-drilldown__panel--giveaway"
                      onClose={requestGiveawaySectionClose}
                    >
                      <div
                        id="settings-giveaway-content"
                        className={cn(
                          'settings-section__collapse',
                          expandedSections.giveaway && 'is-open',
                        )}
                      >
                        {expandedSections.giveaway ? (
                          <div className="settings-section__collapse-inner">
                            <Suspense fallback={<SkeletonCard lines={4} />}>
                              <LazyManagedGiveawayCard
                                ref={giveawayCardRef}
                                api={api}
                                entityType="chat"
                                entityId={chatId}
                                onClosePanel={() => closeSection('giveaway')}
                              />
                            </Suspense>
                          </div>
                        ) : null}
                      </div>
                    </SettingsDrilldownPanel>
                  </GlassCard>
                ) : null}
              </SettingsOverviewEntry>

              <SettingsOverviewEntry order={SHARED_CHAT_SECTION_PRESENTATIONS.greeting.order}>
                <GlassCard
                  className="settings-section settings-home-entry settings-home-entry--list stagger-in"
                  style={{
                    animationDelay: '60ms',
                    order: SHARED_CHAT_SECTION_PRESENTATIONS.greeting.order,
                  }}
                  aria-label="Приветствие новых участников"
                >
                  <div
                    className={cn('settings-section__head', 'settings-section__head--interactive')}
                  >
                    <SettingsSectionToggle
                      title={SHARED_CHAT_SECTION_PRESENTATIONS.greeting.title}
                      enabled={draft.greetingEnabled && draft.greetingBotMessageEnabled}
                      summary={greetingHeaderSummary}
                      status={greetingCardStatus}
                      icon={SHARED_CHAT_SECTION_PRESENTATIONS.greeting.icon}
                      tone={SHARED_CHAT_SECTION_PRESENTATIONS.greeting.tone}
                      open={expandedSections.greeting}
                      controls="settings-greeting-content"
                      onClick={() => toggleSection('greeting')}
                    />
                  </div>

                  <SettingsDrilldownPanel
                    id="settings-greeting-content"
                    icon={
                      <SettingsSectionIcon name={SHARED_CHAT_SECTION_PRESENTATIONS.greeting.icon} />
                    }
                    open={expandedSections.greeting}
                    title={SHARED_CHAT_SECTION_PRESENTATIONS.greeting.title}
                    summary={greetingHeaderSummary}
                    tone={SHARED_CHAT_SECTION_PRESENTATIONS.greeting.tone}
                    className={SHARED_CHAT_SECTION_PRESENTATIONS.greeting.panelClassName}
                    onClose={() => toggleSection('greeting')}
                    headerAction={renderApplyTargetHeaderAction('greeting')}
                    confirmCloseWhen={isSectionDirty('greeting')}
                    onDiscardChanges={() => discardSectionChanges('greeting')}
                    footer={renderSectionSaveFooter('greeting')}
                  >
                    {expandedSections.greeting ? renderSharedChatSection('greeting') : null}
                  </SettingsDrilldownPanel>
                </GlassCard>
              </SettingsOverviewEntry>

              <SettingsOverviewEntry
                order={SHARED_CHAT_SECTION_PRESENTATIONS.profanityFilter.order}
              >
                <GlassCard
                  className="settings-section settings-home-entry settings-home-entry--list stagger-in"
                  style={{
                    animationDelay: '90ms',
                    order: SHARED_CHAT_SECTION_PRESENTATIONS.profanityFilter.order,
                  }}
                  aria-label="Мат и оскорбления"
                >
                  <div
                    className={cn('settings-section__head', 'settings-section__head--interactive')}
                  >
                    <SettingsSectionToggle
                      title={SHARED_CHAT_SECTION_PRESENTATIONS.profanityFilter.title}
                      enabled={draft.russianProfanityFilterEnabled}
                      summary={profanityFilterHeaderSummary}
                      status={profanityFilterCardStatus}
                      icon={SHARED_CHAT_SECTION_PRESENTATIONS.profanityFilter.icon}
                      tone={SHARED_CHAT_SECTION_PRESENTATIONS.profanityFilter.tone}
                      open={expandedSections.profanityFilter}
                      controls="settings-profanity-filter-content"
                      onClick={() => toggleSection('profanityFilter')}
                    />
                  </div>

                  <SettingsDrilldownPanel
                    id="settings-profanity-filter-content"
                    icon={
                      <SettingsSectionIcon
                        name={SHARED_CHAT_SECTION_PRESENTATIONS.profanityFilter.icon}
                      />
                    }
                    open={expandedSections.profanityFilter}
                    title={SHARED_CHAT_SECTION_PRESENTATIONS.profanityFilter.title}
                    summary={profanityFilterHeaderSummary}
                    tone={SHARED_CHAT_SECTION_PRESENTATIONS.profanityFilter.tone}
                    className={SHARED_CHAT_SECTION_PRESENTATIONS.profanityFilter.panelClassName}
                    onClose={() => toggleSection('profanityFilter')}
                    headerAction={renderApplyTargetHeaderAction('profanityFilter')}
                    confirmCloseWhen={isSectionDirty('profanityFilter')}
                    onDiscardChanges={() => discardSectionChanges('profanityFilter')}
                    footer={renderSectionSaveFooter('profanityFilter')}
                  >
                    {expandedSections.profanityFilter
                      ? renderSharedChatSection('profanityFilter')
                      : null}
                  </SettingsDrilldownPanel>
                </GlassCard>
              </SettingsOverviewEntry>

              <SettingsOverviewEntry
                order={getNetworkSettingsSectionPresentation('chat', 'commercialFilter').order}
              >
                <SettingsCommercialFilterSection
                  sharedContent={renderSharedChatSection('commercialFilter')}
                  api={api}
                  botSpeechEditorProps={botSpeechEditorProps!}
                  botSpeechPreviewContext={botSpeechPreviewContext}
                  clearButtonGroupErrors={clearButtonGroupErrors}
                  commercialFilterCardStatus={commercialFilterCardStatus}
                  commercialFilterHeaderSummary={commercialFilterHeaderSummary}
                  commercialSensitivityLabel={commercialSensitivityLabel}
                  commercialSensitivitySliderValue={commercialSensitivitySliderValue}
                  discardSectionChanges={discardSectionChanges}
                  draft={draft}
                  expanded={expandedSections.commercialFilter}
                  handleCommercialSensitivitySliderChange={handleCommercialSensitivitySliderChange}
                  hasTextFiltersBotButtonError={hasTextFiltersBotButtonError}
                  isSectionDirty={isSectionDirty}
                  openBotEditorKey={openBotEditorKey}
                  openHintKey={openHintKey}
                  openWarnEditorKey={openWarnEditorKey}
                  renderAdminContactToggle={renderAdminContactToggle}
                  renderApplyTargetHeaderAction={renderApplyTargetHeaderAction}
                  renderInlineHint={renderInlineHint}
                  renderMuteStageToggle={renderMuteStageToggle}
                  renderSectionSaveFooter={renderSectionSaveFooter}
                  setFieldValue={setFieldValue}
                  setOpenBotEditorKey={setOpenBotEditorKey}
                  setOpenWarnEditorKey={setOpenWarnEditorKey}
                  textFiltersBotButtonErrors={textFiltersBotButtonErrors}
                  toggleBotMessageEditor={toggleBotMessageEditor}
                  toggleHint={toggleHint}
                  toggleSection={toggleSection}
                  toggleWarnMessageEditor={toggleWarnMessageEditor}
                  updateDraftButtonGroup={updateDraftButtonGroup}
                />
              </SettingsOverviewEntry>

              <SettingsOverviewEntry
                order={getNetworkSettingsSectionPresentation('chat', 'reports').order}
              >
                <SettingsReportsSection
                  sharedContent={renderSharedChatSection('reports')}
                  api={api}
                  reportsAvailable={
                    expandedSections.reports
                      ? !reportsAvailabilityQuery.isError &&
                        (reportsAvailabilityQuery.data?.reportsAvailable ?? false)
                      : (settingsScreenQuery.data?.reportsAvailable ?? false)
                  }
                  reportsAvailabilityLoading={reportsAvailabilityQuery.isPending}
                  persistedReportsEnabled={settingsQuery.data?.reportsEnabled ?? false}
                  fieldErrors={fieldErrors}
                  chatId={chatId!}
                  draft={draft}
                  setFieldValue={setFieldValue}
                  expanded={expandedSections.reports}
                  toggleSection={toggleSection}
                  isSectionDirty={isSectionDirty}
                  discardSectionChanges={discardSectionChanges}
                  renderApplyTargetHeaderAction={renderApplyTargetHeaderAction}
                  renderSectionSaveFooter={renderSectionSaveFooter}
                />
              </SettingsOverviewEntry>

              <SettingsOverviewEntry
                order={getNetworkSettingsSectionPresentation('chat', 'duplicates').order}
              >
                <SettingsDuplicatesSection
                  sharedContent={renderSharedChatSection('duplicates')}
                  adjustDuplicateAllowedCount={adjustDuplicateAllowedCount}
                  api={api}
                  chatId={chatId!}
                  userId={meQuery.data?.userId ?? null}
                  applyDuplicateDetectionPreset={applyDuplicateDetectionPreset}
                  applyDuplicateFlowConfig={applyDuplicateFlowConfig}
                  botSpeechEditorProps={botSpeechEditorProps!}
                  botSpeechPreviewContext={botSpeechPreviewContext}
                  clearButtonGroupErrors={clearButtonGroupErrors}
                  discardSectionChanges={discardSectionChanges}
                  draft={draft}
                  duplicateAllowedCount={duplicateAllowedCount}
                  duplicateBotButtonErrors={duplicateBotButtonErrors}
                  duplicatePhotoModerationPolicy={duplicatePhotoModerationPolicy}
                  duplicateMessageModerationMode={
                    settingsScreenQuery.data?.duplicateMessageModerationMode ?? 'OFF'
                  }
                  duplicateSharedWindowHours={duplicateSharedWindowHours}
                  duplicateWindowInputValue={duplicateWindowInputValue}
                  duplicatesHeaderSummary={duplicatesHeaderSummary}
                  expanded={expandedSections.duplicates}
                  fieldErrors={fieldErrors}
                  formatMuteDurationCompact={formatMuteDurationCompact}
                  handleDuplicateWindowHoursBlur={handleDuplicateWindowHoursBlur}
                  handleDuplicateWindowHoursChange={handleDuplicateWindowHoursChange}
                  hasDuplicateBotButtonError={hasDuplicateBotButtonError}
                  isSectionDirty={isSectionDirty}
                  openBotEditorKey={openBotEditorKey}
                  openHintKey={openHintKey}
                  openMuteDurationKey={openMuteDurationKey}
                  renderAdminContactToggle={renderAdminContactToggle}
                  renderApplyTargetHeaderAction={renderApplyTargetHeaderAction}
                  renderMuteDurationEditor={renderMuteDurationEditor}
                  renderSectionSaveFooter={renderSectionSaveFooter}
                  setFieldValue={setFieldValue}
                  setOpenBotEditorKey={setOpenBotEditorKey}
                  toggleBotMessageEditor={toggleBotMessageEditor}
                  toggleHint={toggleHint}
                  toggleMuteDurationEditor={toggleMuteDurationEditor}
                  toggleSection={toggleSection}
                  updateDraftButtonGroup={updateDraftButtonGroup}
                />
              </SettingsOverviewEntry>

              <SettingsOverviewEntry
                order={getNetworkSettingsSectionPresentation('chat', 'limits').order}
              >
                <SettingsLimitsSection
                  sharedContent={renderSharedChatSection('limits')}
                  adjustStickerMessageCooldown={adjustStickerMessageCooldown}
                  api={api}
                  botSpeechEditorProps={botSpeechEditorProps!}
                  botSpeechPreviewContext={botSpeechPreviewContext}
                  clearButtonGroupErrors={clearButtonGroupErrors}
                  deleteSpammersRuntimeStatus={deleteSpammersRuntimeStatus}
                  discardSectionChanges={discardSectionChanges}
                  draft={draft}
                  expanded={expandedSections.limits}
                  fieldErrors={fieldErrors}
                  hasMessageLimitsBotButtonError={hasMessageLimitsBotButtonError}
                  isSectionDirty={isSectionDirty}
                  limitsCardStatus={limitsCardStatus}
                  limitsRulesEnabledCount={limitsRulesEnabledCount}
                  onMaxMessageLengthError={(message) =>
                    setSharedFieldErrors((current) => {
                      const next = { ...current };
                      if (message) next.maxMessageLength = message;
                      else delete next.maxMessageLength;
                      return next;
                    })
                  }
                  messageLimitsBotButtonErrors={messageLimitsBotButtonErrors}
                  openBotEditorKey={openBotEditorKey}
                  openHintKey={openHintKey}
                  renderAdminContactToggle={renderAdminContactToggle}
                  renderApplyTargetHeaderAction={renderApplyTargetHeaderAction}
                  renderInlineHint={renderInlineHint}
                  renderMuteStageToggle={renderMuteStageToggle}
                  renderSectionSaveFooter={renderSectionSaveFooter}
                  setFieldValue={setFieldValue}
                  setOpenBotEditorKey={setOpenBotEditorKey}
                  spammerReviewMetricsQuery={spammerReviewMetricsQuery}
                  toggleBotMessageEditor={toggleBotMessageEditor}
                  toggleHint={toggleHint}
                  toggleSection={toggleSection}
                  updateDraftButtonGroup={updateDraftButtonGroup}
                />
              </SettingsOverviewEntry>

              <SettingsOverviewEntry
                order={getNetworkSettingsSectionPresentation('chat', 'stopWords').order}
              >
                <SettingsStopWordsSection
                  storageInvalid={stopWordsStorageStatus === 'invalid'}
                  sharedContent={renderSharedChatSection('stopWords')}
                  api={api}
                  chatId={chatId ?? ''}
                  draft={draft}
                  busy={isSavingSettings || isApplyingSectionToAll || isReloadingStopWords}
                  expanded={expandedSections.stopWords}
                  toggleSection={toggleSection}
                  isSectionDirty={isSectionDirty}
                  discardSectionChanges={discardSectionChanges}
                  renderApplyTargetHeaderAction={renderApplyTargetHeaderAction}
                  renderSectionSaveFooter={renderSectionSaveFooter}
                  setFieldValue={setFieldValue}
                  clearFieldError={clearFieldError}
                  botSpeechPreviewContext={botSpeechPreviewContext}
                  messageLimitsBlockedWordsInput={messageLimitsBlockedWordsInput}
                  messageLimitsBlockedDomainsInput={messageLimitsBlockedDomainsInput}
                  setMessageLimitsBlockedWordsInput={setMessageLimitsBlockedWordsInput}
                  setMessageLimitsBlockedDomainsInput={setMessageLimitsBlockedDomainsInput}
                  messageLimitsBlockedWordsError={messageLimitsBlockedWordsError}
                  messageLimitsBlockedDomainsError={messageLimitsBlockedDomainsError}
                  stopWordsError={stopWordsError}
                  reloadPolicy={reloadStopWordsPolicy}
                />
              </SettingsOverviewEntry>

              <SettingsOverviewEntry order={15}>
                <SettingsMessageRetentionSection
                  key={chatId}
                  api={api}
                  chatId={chatId!}
                  initialSummary={settingsScreenQuery.data?.messageRetention}
                />
              </SettingsOverviewEntry>

              <SettingsOverviewEntry
                order={getNetworkSettingsSectionPresentation('chat', 'night').order}
              >
                <SettingsNightSection
                  sharedContent={renderSharedChatSection('night')}
                  api={api}
                  closureStatus={settingsScreenQuery.data?.closure}
                  closureRefreshFailed={settingsScreenQuery.isError}
                  botSpeechEditorProps={botSpeechEditorProps!}
                  botSpeechPreviewContext={botSpeechPreviewContext}
                  clearButtonGroupErrors={clearButtonGroupErrors}
                  clearFieldError={clearFieldError}
                  discardSectionChanges={discardSectionChanges}
                  draft={draft}
                  expanded={expandedSections.night}
                  hasNightBotButtonError={hasNightBotButtonError}
                  hasNightForceCloseDurationError={hasNightForceCloseDurationError}
                  hasPublishedRules={hasPublishedRules}
                  isSectionDirty={isSectionDirty}
                  nightBotButtonErrors={nightBotButtonErrors}
                  nightCardStatus={nightCardStatus}
                  nightForceCloseDaysError={nightForceCloseDaysError}
                  nightForceCloseHoursError={nightForceCloseHoursError}
                  nightHeaderSummary={nightHeaderSummary}
                  nightTimeError={nightTimeError}
                  nightTimezoneError={nightTimezoneError}
                  openBotEditorKey={openBotEditorKey}
                  openHintKey={openHintKey}
                  renderApplyTargetHeaderAction={renderApplyTargetHeaderAction}
                  renderInlineHint={renderInlineHint}
                  renderSectionSaveFooter={renderSectionSaveFooter}
                  setDraft={setDraft}
                  setFieldValue={setFieldValue}
                  setOpenBotEditorKey={setOpenBotEditorKey}
                  toggleBotMessageEditor={toggleBotMessageEditor}
                  toggleHint={toggleHint}
                  toggleSection={toggleSection}
                  updateDraftButtonGroup={updateDraftButtonGroup}
                />
              </SettingsOverviewEntry>

              <SettingsOverviewEntry order={5}>
                {legacyBroadcastWorkspaceRequested ? (
                  <GlassCard
                    className="settings-section settings-home-entry settings-home-entry--priority stagger-in"
                    style={{ animationDelay: '315ms', order: 5 }}
                    aria-label="Ранее созданные посты"
                  >
                    <div
                      className={cn(
                        'settings-section__head',
                        'settings-section__head--interactive',
                      )}
                    >
                      <SettingsSectionToggle
                        title="Автопостинг"
                        summary={mailingHeaderSummary}
                        status={mailingCardStatus}
                        icon="send"
                        tone="sky"
                        open={expandedSections.mailing}
                        controls="settings-mailing-content"
                        onClick={() => toggleSection('mailing')}
                      />
                    </div>

                    <SettingsDrilldownPanel
                      id="settings-mailing-content"
                      open={expandedSections.mailing}
                      title="Автопостинг"
                      summary={mailingHeaderSummary}
                      variant="screen"
                      tone="sky"
                      className="settings-drilldown__panel--campaign settings-drilldown__panel--mailing settings-drilldown__panel--broadcast-screen"
                      onClose={() => toggleSection('mailing')}
                      footer={
                        activeMailingWorkspaceView === 'compose' ? mailingDrilldownFooter : null
                      }
                    >
                      <div
                        id="settings-mailing-content"
                        className={cn(
                          'settings-section__collapse',
                          expandedSections.mailing && 'is-open',
                        )}
                      >
                        {expandedSections.mailing ? (
                          <div className="settings-section__collapse-inner settings-mailing">
                            <div className="broadcast-studio-shell broadcast-studio-screen broadcast-studio-screen--chat">
                              <div className="broadcast-studio-screen__chrome">
                                <BroadcastWorkspaceChrome
                                  showTabs={showMailingWorkspaceTabs && !handoffRequested}
                                  value={activeMailingWorkspaceView}
                                  autopostCount={orderedManagedAutopostRules.length}
                                  historyCount={orderedManagedBroadcasts.length}
                                  compatibilityOnly
                                  disabled={isMailingBusy}
                                  showReset={showMailingResetAction}
                                  resetLabel={mailingResetActionLabel}
                                  resetPending={clearBroadcastHandoffMutation.isPending}
                                  onChange={setMailingWorkspaceView}
                                  onReset={handleClearMailingComposer}
                                />
                              </div>

                              {activeMailingWorkspaceView === 'compose' ? (
                                <div className="broadcast-compose-flow broadcast-compose-flow--screen">
                                  <div className="broadcast-stage-card broadcast-stage-card--message broadcast-stage-card--primary">
                                    <div className="broadcast-stage-card__head">
                                      <div className="broadcast-stage-card__title-wrap">
                                        <strong>Сообщение</strong>
                                      </div>
                                      <span
                                        className={cn(
                                          'broadcast-stage-card__status',
                                          mailingContentReady ? 'is-ready' : 'is-pending',
                                        )}
                                      >
                                        {mailingContentReady
                                          ? 'Готов'
                                          : mailingImagesPreparing
                                            ? 'Фото...'
                                            : mailingHasDirectContent
                                              ? 'Проверка'
                                              : 'Пусто'}
                                      </span>
                                    </div>

                                    <div className="broadcast-stage-card__body">
                                      <Suspense fallback={null}>
                                        <LazyBroadcastContentComposer
                                          text={mailingText}
                                          maxLength={MAX_BROADCAST_TEXT_LENGTH}
                                          images={mailingImages}
                                          videoLabel={editingMailingHasVideo ? 'Видео' : null}
                                          disabled={isMailingBusy}
                                          textError={mailingTextError}
                                          imageError={mailingImageError}
                                          onTextChange={(nextText) => {
                                            setMailingText(nextText);
                                            if (mailingTextError) {
                                              setMailingTextError('');
                                            }
                                          }}
                                          onImagesChange={(nextImages) => {
                                            applyMailingImages(nextImages);
                                            if (nextImages.length > 0) {
                                              setMailingVideoCleared(true);
                                            }
                                            setMailingImageError('');
                                            if (mailingTextError) {
                                              setMailingTextError('');
                                            }
                                          }}
                                          onImagePreparationChange={setMailingImagesPreparing}
                                          onClearVideo={() => {
                                            setMailingVideoCleared(true);
                                          }}
                                          onError={(message) => {
                                            setMailingImageError(message);
                                            pushToast({
                                              tone: 'danger',
                                              title: 'Фото не добавлено',
                                              description: message,
                                            });
                                            maxNotify('error');
                                          }}
                                          buttons={normalizedMailingButtons}
                                          systemButtons={mailingSystemButtons}
                                          buttonsStatusLabel={mailingVisibleButtonStatus}
                                          buttonsActive={mailingHasVisibleButtons}
                                          buttonsError={!mailingButtonDraftValid}
                                          onOpenButtons={() => setMailingButtonsSheetOpen(true)}
                                        />
                                      </Suspense>
                                    </div>
                                  </div>

                                  <div className="broadcast-stage-card broadcast-stage-card--scope">
                                    <div className="broadcast-stage-card__head">
                                      <div className="broadcast-stage-card__title-wrap">
                                        <strong>Кому</strong>
                                      </div>
                                    </div>

                                    <div className="broadcast-stage-card__body">
                                      <Suspense fallback={null}>
                                        <LazyBroadcastAudienceControls
                                          targetMode={mailingTargetMode}
                                          currentChatId={chatId ?? ''}
                                          targetChatIds={mailingAudiencePayload.targetChatIds}
                                          favoriteUserId={meQuery.data?.userId ?? null}
                                          choices={mailingAudienceChoices}
                                          loading={mailingAudienceChoicesLoading}
                                          refreshing={chatsList.isRefreshing}
                                          remoteError={mailingAudienceChoicesError}
                                          validationError={mailingAudienceError || null}
                                          disabled={isMailingBusy}
                                          onToggleAllChats={handleMailingAllChatsToggle}
                                          onChangeScopedMode={handleMailingScopedTargetModeChange}
                                          onApplySelection={handleApplyMailingAudienceSelection}
                                          onClearValidationError={() => setMailingAudienceError('')}
                                          onRefreshChoices={handleRefreshMailingAudienceChoices}
                                        />
                                      </Suspense>
                                    </div>
                                  </div>

                                  <div className="broadcast-stage-card broadcast-stage-card--planner">
                                    <div className="broadcast-stage-card__head">
                                      <div className="broadcast-stage-card__title-wrap">
                                        <strong>Когда</strong>
                                      </div>
                                    </div>

                                    <div className="broadcast-stage-card__body">
                                      <Suspense fallback={null}>
                                        <LazyBroadcastSchedulePlanner
                                          resetKey={mailingPlannerResetKey}
                                          value={mailingScheduledSlots}
                                          occupiedSlots={mailingOccupiedSlots}
                                          error={mailingScheduleError || mailingCycleError}
                                          disabled={isMailingBusy}
                                          managedBroadcasts={managedBroadcasts}
                                          calendarSlots={mailingCalendarQuery.data?.slots ?? []}
                                          targetAwareAvailability
                                          sourceChatId={chatId}
                                          managedBroadcastsLoading={
                                            settingsScreenQuery.isLoading ||
                                            settingsScreenQuery.isFetching ||
                                            mailingCalendarQuery.isFetching
                                          }
                                          currentTargetLabel="Текущий чат"
                                          targetContextLabel={
                                            mailingHeaderTargetPresentation.compactLabel
                                          }
                                          calendarRefreshing={mailingCalendarQuery.isFetching}
                                          excludeBroadcastId={editingManagedBroadcast?.id ?? null}
                                          excludeAutopostRuleId={
                                            editingManagedAutopostRule?.id ?? null
                                          }
                                          onEditBroadcast={handleEditManagedBroadcastById}
                                          onDeleteBroadcast={handleDeleteManagedBroadcastById}
                                          pendingEditBroadcastId={
                                            openManagedBroadcastEditorMutation.isPending
                                              ? openManagedBroadcastEditorMutation.variables
                                              : null
                                          }
                                          pendingDeleteBroadcastId={
                                            cancelManagedBroadcastMutation.isPending
                                              ? cancelManagedBroadcastMutation.variables
                                              : null
                                          }
                                          timingMode={mailingTimingMode}
                                          cycle={mailingCycleDraft}
                                          onTimingModeChange={(nextMode) => {
                                            setMailingTimingMode(nextMode);
                                            setMailingScheduleError('');
                                            setMailingCycleError('');
                                          }}
                                          onCycleChange={(nextCycle) => {
                                            setMailingCycleDraft(nextCycle);
                                            setMailingCycleError('');
                                          }}
                                          onSelectionStateChange={handleMailingPlannerStateChange}
                                          onChange={(nextValue) => {
                                            setMailingScheduledSlots(nextValue);
                                            if (mailingScheduleError) {
                                              setMailingScheduleError('');
                                            }
                                          }}
                                        />
                                      </Suspense>
                                    </div>
                                  </div>
                                </div>
                              ) : activeMailingWorkspaceView === 'calendar' ? (
                                <div className="broadcast-stage-card broadcast-stage-card--planner broadcast-stage-card--calendar">
                                  <div className="broadcast-stage-card__head">
                                    <div className="broadcast-stage-card__title-wrap">
                                      <strong>Календарь</strong>
                                    </div>
                                  </div>

                                  <div className="broadcast-stage-card__body">
                                    <Suspense fallback={null}>
                                      <LazyBroadcastSchedulePlanner
                                        resetKey={`calendar-${mailingPlannerResetKey}`}
                                        value={[]}
                                        occupiedSlots={mailingOccupiedSlots}
                                        disabled={isMailingBusy}
                                        managedBroadcasts={managedBroadcasts}
                                        calendarSlots={mailingCalendarQuery.data?.slots ?? []}
                                        sourceChatId={chatId}
                                        managedBroadcastsLoading={
                                          settingsScreenQuery.isLoading ||
                                          settingsScreenQuery.isFetching ||
                                          mailingCalendarQuery.isFetching
                                        }
                                        currentTargetLabel="Текущий чат"
                                        targetContextLabel={
                                          mailingHeaderTargetPresentation.compactLabel
                                        }
                                        calendarRefreshing={mailingCalendarQuery.isFetching}
                                        excludeBroadcastId={editingManagedBroadcast?.id ?? null}
                                        excludeAutopostRuleId={
                                          editingManagedAutopostRule?.id ?? null
                                        }
                                        onEditBroadcast={handleEditManagedBroadcastById}
                                        onDeleteBroadcast={handleDeleteManagedBroadcastById}
                                        pendingEditBroadcastId={
                                          openManagedBroadcastEditorMutation.isPending
                                            ? openManagedBroadcastEditorMutation.variables
                                            : null
                                        }
                                        pendingDeleteBroadcastId={
                                          cancelManagedBroadcastMutation.isPending
                                            ? cancelManagedBroadcastMutation.variables
                                            : null
                                        }
                                        viewMode="calendar"
                                        onSelectionStateChange={handleMailingPlannerStateChange}
                                        onChange={(nextValue) => {
                                          setMailingTimingMode('scheduled');
                                          setMailingScheduledSlots(nextValue);
                                          setMailingScheduleError('');
                                          setMailingWorkspaceView('compose');
                                        }}
                                      />
                                    </Suspense>
                                  </div>
                                </div>
                              ) : activeMailingWorkspaceView === 'autoposts' ? (
                                <div className="broadcast-stage-card broadcast-stage-card--feed">
                                  <div className="broadcast-stage-card__head">
                                    <div className="broadcast-stage-card__title-wrap">
                                      <strong>Автопосты</strong>
                                      <small>
                                        {managedAutopostRulesQuery.isLoading
                                          ? 'Загрузка'
                                          : orderedManagedAutopostRules.length > 0
                                            ? `${orderedManagedAutopostRules.length} шт.`
                                            : 'Пусто'}
                                      </small>
                                    </div>
                                  </div>

                                  <div className="broadcast-stage-card__body">
                                    <div className="managed-broadcasts-list managed-broadcasts-list--autoposts">
                                      {orderedManagedAutopostRules.length === 0 &&
                                      !managedAutopostRulesQuery.isLoading ? (
                                        <div className="managed-broadcasts-list__empty">
                                          Автопостов пока нет.
                                        </div>
                                      ) : null}

                                      <Suspense fallback={<SkeletonCard lines={2} />}>
                                        {orderedManagedAutopostRules.map((rule) => (
                                          <LazyManagedAutopostRuleCard
                                            key={rule.id}
                                            rule={rule}
                                            nextLabel={formatCompactBroadcastDateTime(
                                              rule.nextSendAt,
                                              rule.scheduleTimezone,
                                            )}
                                            facts={buildManagedAutopostRuleFacts(
                                              rule,
                                              'Текущий чат',
                                            )}
                                            isBusy={isMailingBusy}
                                            onPause={() =>
                                              updateManagedAutopostRuleMutation.mutate({
                                                ruleId: rule.id,
                                                status: 'PAUSED',
                                              })
                                            }
                                            onDelete={() => handleDeleteManagedAutopostRule(rule)}
                                          />
                                        ))}
                                      </Suspense>
                                    </div>
                                  </div>
                                </div>
                              ) : (
                                <div className="broadcast-stage-card broadcast-stage-card--feed">
                                  <div className="broadcast-stage-card__head">
                                    <div className="broadcast-stage-card__title-wrap">
                                      <strong>История</strong>
                                      <small>
                                        {managedBroadcastsQuery.isLoading
                                          ? 'Загрузка'
                                          : filteredManagedBroadcasts.length > 0
                                            ? `${filteredManagedBroadcasts.length} записей`
                                            : 'Пусто'}
                                      </small>
                                    </div>
                                  </div>

                                  <div className="broadcast-stage-card__body">
                                    <BroadcastHistoryFilterTabs
                                      value={mailingHistoryFilter}
                                      counts={mailingHistoryCounts}
                                      onChange={setMailingHistoryFilter}
                                    />

                                    <div className="managed-broadcasts-list">
                                      {filteredManagedBroadcasts.length === 0 &&
                                      !managedBroadcastsQuery.isLoading ? (
                                        <div className="managed-broadcasts-list__empty">
                                          История пока пустая.
                                        </div>
                                      ) : null}

                                      <Suspense fallback={<SkeletonCard lines={2} />}>
                                        {filteredManagedBroadcasts.map((broadcast) => {
                                          const cardTone =
                                            resolveManagedBroadcastCardTone(broadcast);
                                          const cardMetric = resolveManagedBroadcastMetric(
                                            broadcast,
                                            mailingNowMs,
                                          );
                                          const cardFacts =
                                            buildManagedBroadcastFactChips(broadcast);
                                          const canEditBroadcastSchedule =
                                            broadcast.scheduleMode === 'calendar' &&
                                            broadcast.status !== 'COMPLETED' &&
                                            broadcast.status !== 'CANCELED';
                                          const canCancelBroadcast =
                                            broadcast.status !== 'COMPLETED' &&
                                            broadcast.status !== 'CANCELED';
                                          const isDeletingBroadcast =
                                            cancelManagedBroadcastMutation.isPending &&
                                            cancelManagedBroadcastMutation.variables ===
                                              broadcast.id;
                                          const isOpeningBroadcastEditor =
                                            openManagedBroadcastEditorMutation.isPending &&
                                            openManagedBroadcastEditorMutation.variables ===
                                              broadcast.id;
                                          const isRetryingBroadcast =
                                            retryManagedBroadcastMutation.isPending &&
                                            retryManagedBroadcastMutation.variables ===
                                              broadcast.id;
                                          const cardBadge = isOpeningBroadcastEditor
                                            ? 'Открываем'
                                            : resolveManagedBroadcastCardBadge(broadcast);

                                          return (
                                            <LazyManagedBroadcastHistoryCard
                                              key={broadcast.id}
                                              broadcast={broadcast}
                                              tone={cardTone}
                                              badge={cardBadge}
                                              title={resolveManagedBroadcastCardTitle(broadcast)}
                                              metric={cardMetric}
                                              facts={cardFacts}
                                              canEdit={canEditBroadcastSchedule}
                                              canCancel={canCancelBroadcast}
                                              isBusy={isMailingBusy}
                                              isDeleting={isDeletingBroadcast}
                                              isRetrying={isRetryingBroadcast}
                                              onEdit={() => handleEditManagedBroadcast(broadcast)}
                                              onRetry={() =>
                                                retryManagedBroadcastMutation.mutate(broadcast.id)
                                              }
                                              onDelete={() =>
                                                handleDeleteManagedBroadcast(broadcast)
                                              }
                                            />
                                          );
                                        })}
                                      </Suspense>
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    </SettingsDrilldownPanel>
                  </GlassCard>
                ) : null}
              </SettingsOverviewEntry>

              <SettingsOverviewEntry
                order={SHARED_CHAT_SECTION_PRESENTATIONS.requiredSubscription.order}
              >
                <GlassCard
                  className="settings-section settings-home-entry settings-home-entry--priority settings-home-entry--wide stagger-in"
                  style={{
                    animationDelay: '360ms',
                    order: SHARED_CHAT_SECTION_PRESENTATIONS.requiredSubscription.order,
                  }}
                  aria-label="Подписка на чат или канал"
                >
                  <div
                    className={cn('settings-section__head', 'settings-section__head--interactive')}
                  >
                    <SettingsSectionToggle
                      title={SHARED_CHAT_SECTION_PRESENTATIONS.requiredSubscription.title}
                      enabled={draft.requiredSubscriptionEnabled && requiredSubscriptionIsActive}
                      summary={requiredSubscriptionHeaderSummary}
                      status={requiredSubscriptionCardStatus}
                      icon={SHARED_CHAT_SECTION_PRESENTATIONS.requiredSubscription.icon}
                      tone={SHARED_CHAT_SECTION_PRESENTATIONS.requiredSubscription.tone}
                      open={expandedSections.requiredSubscription}
                      controls="settings-required-subscription-content"
                      onClick={() => toggleSection('requiredSubscription')}
                    />
                  </div>

                  <SettingsDrilldownPanel
                    id="settings-required-subscription-content"
                    icon={
                      <SettingsSectionIcon
                        name={SHARED_CHAT_SECTION_PRESENTATIONS.requiredSubscription.icon}
                      />
                    }
                    open={expandedSections.requiredSubscription}
                    title={SHARED_CHAT_SECTION_PRESENTATIONS.requiredSubscription.title}
                    summary={requiredSubscriptionHeaderSummary}
                    tone={SHARED_CHAT_SECTION_PRESENTATIONS.requiredSubscription.tone}
                    className={
                      SHARED_CHAT_SECTION_PRESENTATIONS.requiredSubscription.panelClassName
                    }
                    onClose={() => toggleSection('requiredSubscription')}
                    headerAction={
                      <>
                        <RequiredSubscriptionHelp />
                        {renderApplyTargetHeaderAction('requiredSubscription')}
                      </>
                    }
                    confirmCloseWhen={isSectionDirty('requiredSubscription')}
                    onDiscardChanges={() => discardSectionChanges('requiredSubscription')}
                    footer={renderSectionSaveFooter('requiredSubscription')}
                  >
                    {expandedSections.requiredSubscription
                      ? renderSharedChatSection('requiredSubscription')
                      : null}
                  </SettingsDrilldownPanel>
                </GlassCard>
              </SettingsOverviewEntry>

              <SettingsOverviewEntry
                order={getNetworkSettingsSectionPresentation('chat', 'commands').order}
              >
                <Suspense fallback={null}>
                  <LazySettingsAdminCommandsSection
                    sharedContent={renderSharedChatSection('commands')}
                    draft={draft}
                    expanded={expandedSections.commands}
                    fieldErrors={fieldErrors}
                    headerAction={renderApplyTargetHeaderAction('commands')}
                    footer={renderSectionSaveFooter('commands')}
                    hasChanges={isSectionDirty('commands')}
                    onDiscardChanges={() => discardSectionChanges('commands')}
                    onToggleSection={() => toggleSection('commands')}
                    onFieldChange={(key, value) => setFieldValue(key, value)}
                  />
                </Suspense>
              </SettingsOverviewEntry>

              <SettingsOverviewEntry
                order={getNetworkSettingsSectionPresentation('chat', 'storefront').order}
              >
                <SettingsStorefrontSection
                  sharedContent={renderSharedChatSection('storefront')}
                  draft={draft}
                  api={api}
                  chatId={chatId}
                  expanded={expandedSections.storefront}
                  summary={storefrontHeaderSummary}
                  status={storefrontCardStatus}
                  headerAction={renderApplyTargetHeaderAction('storefront')}
                  footer={renderSectionSaveFooter('storefront')}
                  hasChanges={isSectionDirty('storefront')}
                  onDiscardChanges={() => discardSectionChanges('storefront')}
                  onToggleSection={() => toggleSection('storefront')}
                  onFieldChange={(enabled) => setFieldValue('karavanStorefrontEnabled', enabled)}
                  onTextChange={setFieldValue}
                  onAdminsOnlyChange={(enabled) =>
                    setFieldValue('karavanStorefrontAdminsOnly', enabled)
                  }
                />
              </SettingsOverviewEntry>

              <SettingsOverviewEntry order={32}>
                <MarketplaceProfileCard
                  api={api}
                  entityTitle={chatTitle}
                  entityAvatarUrl={chatHeaderQuery.data?.avatarUrl ?? null}
                  entityId={chatId ?? ''}
                  entityType="chat"
                  profile="moderation"
                />
              </SettingsOverviewEntry>

              <SettingsOverviewEntry
                order={getNetworkSettingsSectionPresentation('chat', 'extra').order}
              >
                <SettingsExtraSection
                  sharedContent={renderSharedChatSection('extra')}
                  draft={draft}
                  expanded={expandedSections.extra}
                  summary={extraHeaderSummary}
                  status={extraCardStatus}
                  openHintKey={openHintKey}
                  fieldErrors={fieldErrors}
                  headerAction={renderApplyTargetHeaderAction('extra')}
                  footer={renderSectionSaveFooter('extra')}
                  hasChanges={isSectionDirty('extra')}
                  onDiscardChanges={() => discardSectionChanges('extra')}
                  onToggleSection={() => toggleSection('extra')}
                  onToggleHint={toggleHint}
                  onFieldChange={(key, value) => setFieldValue(key, value)}
                  onAdjustDeleteBotMessagesDelay={adjustDeleteBotMessagesDelay}
                />
              </SettingsOverviewEntry>

              <SettingsOverviewEntry order={33}>
                <GlassCard
                  className="settings-section settings-home-entry stagger-in"
                  style={{ order: 33 }}
                >
                  <div
                    className={cn('settings-section__head', 'settings-section__head--interactive')}
                  >
                    <SettingsSectionToggle
                      title="Стиль речи"
                      summary="Тон ответов и сообщений бота"
                      status={BOT_SPEECH_STYLE_METADATA[activeSpeechStyle].label}
                      icon="comments"
                      tone="mint"
                      open={speechStylePanelOpen}
                      controls="settings-bot-speech-style"
                      onClick={() => {
                        setPendingSpeechStyle(activeSpeechStyle);
                        setSpeechStylePanelOpen(true);
                      }}
                    />
                  </div>
                </GlassCard>
              </SettingsOverviewEntry>
            </SettingsOverviewGroups>
          </div>
        </section>
      ) : null}

      {!settingsQuery.isLoading && !settingsQuery.error && !draft ? (
        <GlassCard>
          <StatusState
            tone="warning"
            title="Настройки не найдены"
            description="Повторите загрузку страницы."
          />
        </GlassCard>
      ) : null}

      <Suspense fallback={null}>
        <LazyBroadcastButtonsSheet
          open={rulesButtonsSheetOpen}
          api={api}
          enabled={rulesButtonEnabled}
          buttons={rulesDraft?.buttons ?? []}
          errors={rulesButtonErrors}
          revealNextStepSignal={rulesButtonRevealSignal}
          disabled={isRulesDraftEditingDisabled}
          urlPlaceholder="https://max.ru/channel/rules"
          textPlaceholder={DEFAULT_RULES_POST_BUTTON_TEXT}
          onEnabledChange={handleRulesButtonsEnabledChange}
          onChange={(nextButtons) => {
            setRulesButtonFieldsTouched(true);
            setRulesButtonErrors([]);
            const buttonState = buildBroadcastLinkButtonLegacyFields(nextButtons);
            setRulesDraft((current) =>
              current
                ? {
                    ...current,
                    buttons: nextButtons,
                    buttonEnabled: nextButtons.length > 0,
                    buttonUrl: buttonState.buttonUrl,
                    buttonText: buttonState.buttonText,
                  }
                : current,
            );
          }}
          onClose={() => setRulesButtonsSheetOpen(false)}
        />
      </Suspense>

      <Suspense fallback={null}>
        <LazyBroadcastButtonsSheet
          open={mailingButtonsSheetOpen}
          api={api}
          enabled={mailingButtonEnabled}
          buttons={mailingButtons}
          errors={mailingButtonErrors}
          revealNextStepSignal={mailingButtonRevealSignal}
          disabled={isMailingBusy}
          urlPlaceholder="https://max.ru/channel/..."
          textPlaceholder="Открыть"
          onEnabledChange={handleMailingButtonsEnabledChange}
          onChange={(nextButtons) => {
            setMailingButtons(nextButtons);
            if (mailingButtonErrors.length > 0) {
              setMailingButtonErrors([]);
            }
          }}
          onClose={() => setMailingButtonsSheetOpen(false)}
        />
      </Suspense>

      {applyPartialResult && (
        <Suspense fallback={null}>
          <LazySettingsApplyPartialResult
            result={applyPartialResult.result}
            recipientTitles={applyPartialResult.recipientTitles}
            onClose={() => setApplyPartialResult(null)}
          />
        </Suspense>
      )}
      <Suspense fallback={null}>
        <LazyActionConfirmSheet
          id="rules-reset-confirmation"
          open={rulesResetConfirmationOpen}
          title="Удалить пост правил?"
          summary="Опубликованный пост будет удалён. Черновик правил останется в настройках."
          confirmLabel="Удалить пост"
          confirmBusyLabel="Удаляем..."
          cancelLabel="Оставить"
          tone="danger"
          isBusy={isResettingPublishedRules}
          onClose={() => setRulesResetConfirmationOpen(false)}
          onConfirm={confirmResetPublishedRules}
        />
      </Suspense>

      <Suspense fallback={null}>
        <LazyBroadcastPublishReviewSheet
          id="mailing-publish-review"
          open={pendingMailingPublishReview !== null}
          text={pendingMailingReviewPayload?.text ?? ''}
          hasMedia={Boolean(
            pendingMailingReviewPayload?.imageEnabled ||
            pendingMailingReviewPayload?.mediaType === 'video',
          )}
          facts={pendingMailingReviewFacts}
          confirmLabel={mailingPrimaryActionLabel}
          confirmBusyLabel={
            updateManagedBroadcastMutation.isPending ? 'Сохраняем...' : 'Публикуем...'
          }
          isBusy={
            updateManagedBroadcastMutation.isPending || sendBroadcastHandoffMutation.isPending
          }
          extraActionBusy={sendBroadcastTestMutation.isPending}
          extraActionDisabled={!mailingTestReady}
          onExtraAction={handleSendBroadcastTest}
          onClose={handleCloseMailingPublishReview}
          onConfirm={confirmMailingPublishReview}
        />
      </Suspense>

      <Suspense fallback={null}>
        <LazyActionConfirmSheet
          id="mailing-slot-conflict"
          open={pendingMailingSlotConflict !== null}
          title="Время занято"
          summary="Можно заменить только эту отправку."
          previewTitle={
            pendingMailingConflictPreviewSlot
              ? formatCompactBroadcastDateTime(
                  pendingMailingConflictPreviewSlot,
                  pendingMailingSlotConflict?.payload.scheduleTimezone,
                )
              : 'Занято'
          }
          previewMeta={
            pendingMailingConflictSlots.length > 1
              ? formatRussianCountLabel(
                  pendingMailingConflictSlots.length,
                  'занятая отправка',
                  'занятые отправки',
                  'занятых отправок',
                )
              : 'Заменим, если получатели свободны.'
          }
          confirmLabel="Заменить"
          cancelLabel="Другое время"
          tone="accent"
          onClose={handleCloseMailingSlotConflict}
          onConfirm={confirmMailingSlotReplacement}
        />
      </Suspense>

      <Suspense fallback={null}>
        <LazyActionConfirmSheet
          id="managed-broadcast-delete"
          open={managedBroadcastDeleteTarget !== null}
          title="Отменить отправки?"
          previewTitle={
            managedBroadcastDeleteTarget ? (
              <LazyActionConfirmMarkdownPreview
                value={managedBroadcastDeleteTarget.textPreview}
                fallback={
                  managedBroadcastDeleteTarget.textPreview ||
                  (managedBroadcastDeleteTarget.hasImage ? 'Фото без текста' : null)
                }
              />
            ) : undefined
          }
          previewMeta={
            managedBroadcastDeleteTarget
              ? managedBroadcastDeleteTarget.nextSendAt
                ? `Следующая отправка · ${formatCompactBroadcastDateTime(
                    managedBroadcastDeleteTarget.nextSendAt,
                    managedBroadcastDeleteTarget.scheduleTimezone,
                  )}`
                : 'Будущие отправки будут сняты.'
              : undefined
          }
          confirmLabel="Отменить"
          confirmBusyLabel="Отменяем..."
          tone="danger"
          isBusy={cancelManagedBroadcastMutation.isPending}
          onClose={() => setManagedBroadcastDeleteTarget(null)}
          onConfirm={confirmDeleteManagedBroadcast}
        />
      </Suspense>

      <Suspense fallback={null}>
        <LazyActionConfirmSheet
          id="managed-autopost-rule-delete"
          open={managedAutopostRuleDeleteTarget !== null}
          title="Отменить автопост?"
          previewTitle={
            managedAutopostRuleDeleteTarget ? (
              <LazyActionConfirmMarkdownPreview
                value={managedAutopostRuleDeleteTarget.textPreview}
                fallback={
                  managedAutopostRuleDeleteTarget.textPreview ||
                  (managedAutopostRuleDeleteTarget.hasVideo
                    ? 'Видео без текста'
                    : managedAutopostRuleDeleteTarget.hasImage
                      ? 'Фото без текста'
                      : 'Пусто')
                }
              />
            ) : undefined
          }
          previewMeta={
            managedAutopostRuleDeleteTarget?.nextSendAt
              ? `Следующий · ${formatCompactBroadcastDateTime(
                  managedAutopostRuleDeleteTarget.nextSendAt,
                  managedAutopostRuleDeleteTarget.scheduleTimezone,
                )}`
              : undefined
          }
          confirmLabel="Отменить"
          confirmBusyLabel="Отменяем..."
          tone="danger"
          isBusy={deleteManagedAutopostRuleMutation.isPending}
          onClose={() => setManagedAutopostRuleDeleteTarget(null)}
          onConfirm={confirmDeleteManagedAutopostRule}
        />
      </Suspense>
    </div>
  );
}
