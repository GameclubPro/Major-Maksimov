import type {
  BroadcastLinkButton,
  BroadcastScheduleMode,
  BroadcastTargetMode,
  BroadcastTextFormat,
  ChannelSettings,
  ChatSettings,
  LogsDashboardRange,
  ManagedEntityType,
  MaxUpdate,
} from '@maxim/contracts';
import type { BotSpeechPersona } from '@maxim/contracts/bot-speech';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import type { MaxSendMessageOptions } from '../max/max-client.service';
import type { IncomingMessageMarkup } from './private-control-markup-importer';

export type PrivateSectionKey =
  | 'links'
  | 'greeting'
  | 'profanityFilter'
  | 'commercialFilter'
  | 'duplicates'
  | 'limits'
  | 'night'
  | 'storefront'
  | 'extra';

export type ChannelSectionKey = 'post_suggestions' | 'comments';

export type SettingFieldType = 'boolean' | 'number' | 'text' | 'url' | 'enum' | 'time' | 'timezone';

export type SettingFieldConfig = {
  key: keyof ChatSettings;
  label: string;
  type: SettingFieldType;
  min?: number;
  max?: number;
  step?: number;
  presets?: readonly number[];
  enumValues?: readonly string[];
};

export type PendingInput =
  | {
      kind: 'set_field';
      section: PrivateSectionKey;
      key: keyof ChatSettings;
      type: SettingFieldType;
      min?: number;
      max?: number;
    }
  | {
      kind: 'set_channel_field';
      section: ChannelSectionKey;
      key: keyof ChannelSettings;
      type: SettingFieldType;
      min?: number;
      max?: number;
    }
  | { kind: 'search_settings' }
  | { kind: 'add_domain' }
  | { kind: 'schedule_domain'; domain: string; domainLabel: string }
  | { kind: 'broadcast_content' }
  | { kind: 'broadcast_text' }
  | { kind: 'broadcast_button_url' }
  | { kind: 'broadcast_button_text' }
  | { kind: 'broadcast_send_at' }
  | { kind: 'broadcast_cycle_every_hours' }
  | { kind: 'broadcast_cycle_count' }
  | { kind: 'broadcast_photo' }
  | { kind: 'rules_text' }
  | { kind: 'rules_photo' }
  | { kind: 'channel_suggestion'; chatId: string; token: string }
  | { kind: 'giveaway_title' }
  | { kind: 'giveaway_content' }
  | { kind: 'giveaway_description' }
  | { kind: 'giveaway_start_at' }
  | { kind: 'giveaway_end_at' }
  | { kind: 'giveaway_claim_hours' }
  | { kind: 'giveaway_photo' }
  | { kind: 'giveaway_prize'; index: number }
  | { kind: 'manual_mute_duration'; targetUserId: string }
  | { kind: 'support_request' };

/** Dedicated state for the Karavan allowlist handoff. Kept outside pendingInput
 * so an in-progress broadcast/rules editor is never overwritten. */
export type PendingKaravanAllowlistFlow = {
  chatId: string;
  chatTitle: string | null;
  actorUserId: string;
  botId: string | null;
  nonce: string;
  stage: 'await_forward' | 'await_duration';
  targetUserId: string | null;
  targetDisplayName: string | null;
  sourceMessageId: string | null;
  expiresAt: number;
};

export type PendingMassAction =
  | {
      kind: 'apply_section';
      section: PrivateSectionKey;
      targetChats: number;
    }
  | {
      kind: 'broadcast';
      targetChats: number;
    };

export type PrivateBroadcastDraft = {
  text: string;
  textFormat: BroadcastTextFormat;
  targetMode: BroadcastTargetMode;
  targetChatIds: string[];
  applyToAllChats: boolean;
  buttons: BroadcastLinkButton[];
  buttonEnabled: boolean;
  buttonUrl: string;
  buttonText: string;
  imageEnabled: boolean;
  imageBase64: string;
  imageMimeType: string;
  imageFileName: string;
  mediaType: 'video' | null;
  mediaPayload: Record<string, unknown> | null;
  mediaMimeType: string;
  mediaFileName: string;
  scheduleMode: BroadcastScheduleMode;
  scheduleTimezone: string;
  scheduledSlots: string[];
  sendAt: string | null;
  cycleEnabled: boolean;
  cycleEveryHours: number;
  cycleCount: number;
};

export type PrivateSuggestionImageDraft = {
  kind: 'image';
  mimeType: string;
  fileName: string;
  payload: Record<string, unknown>;
};

export type PrivateSuggestionVideoDraft = {
  kind: 'video';
  mimeType: string;
  fileName: string;
  payload: Record<string, unknown>;
};

export type PrivateSuggestionMediaDraft = PrivateSuggestionImageDraft | PrivateSuggestionVideoDraft;

export type PrivateSuggestionDraft = {
  chatId: string;
  token: string;
  text: string;
  textFormat: BroadcastTextFormat;
  textMarkup: IncomingMessageMarkup[];
  images: PrivateSuggestionImageDraft[];
  video: PrivateSuggestionVideoDraft | null;
  mediaBotId: string | null;
  media?: PrivateSuggestionMediaDraft | null;
  imageBase64: string;
  imageMimeType: string;
  imageFileName: string;
  sourceMessageId: string | null;
  previewMessageId: string | null;
};

export type ActiveBotSpeechProfile = {
  persona: BotSpeechPersona;
  characterName: string;
};

export type PrivateScreen =
  | 'chat_select'
  | 'home'
  | 'settings_hub'
  | 'section'
  | 'channel_section'
  | 'domains'
  | 'rules'
  | 'broadcast'
  | 'giveaway'
  | 'events'
  | 'logs'
  | 'search'
  | 'manual_users'
  | 'manual_actions';

export type PrivateUiMode = 'modern' | 'legacy';
export type PrivateHomeTab = 'quick' | 'all';
export type PrivateSectionView = 'basic' | 'advanced';
export type PrivateBroadcastView = 'basic' | 'advanced';

export type PrivateSession = {
  version: 3;
  lastPrivateChatId: string | null;
  lastPrivateBotId: string | null;
  lastBroadcastHandoffDeliveredChatId: string | null;
  lastBroadcastHandoffDeliveredAt: number | null;
  lastGiveawayHandoffDeliveredChatId: string | null;
  lastGiveawayHandoffDeliveredAt: number | null;
  lastRulesHandoffDeliveredChatId: string | null;
  lastRulesHandoffDeliveredAt: number | null;
  lastProfileMentionHandoffDeliveredChatId: string | null;
  lastProfileMentionHandoffDeliveredAt: number | null;
  pendingProfileMentionChatId: string | null;
  pendingProfileMentionUserId: string | null;
  pendingProfileMentionDisplayName: string | null;
  pendingProfileMentionExpiresAt: number | null;
  pendingProfileMentionBotId: string | null;
  selectedChatId: string | null;
  selectedEntityType: ManagedEntityType | null;
  managedGiveawayId: string | null;
  entityTab: ManagedEntityType;
  uiMode: PrivateUiMode;
  screen: PrivateScreen;
  homeTab: PrivateHomeTab;
  sectionView: PrivateSectionView;
  searchQuery: string | null;
  lastScreenStack: string[];
  broadcastView: PrivateBroadcastView;
  section: PrivateSectionKey | null;
  channelSection: ChannelSectionKey | null;
  chatPage: number;
  domainPage: number;
  eventsPage: number;
  manualPage: number;
  logsRange: LogsDashboardRange;
  manualTargetUserId: string | null;
  pendingInput: PendingInput | null;
  pendingKaravanAllowlist: PendingKaravanAllowlistFlow | null;
  pendingMassAction: PendingMassAction | null;
  broadcastDraft: PrivateBroadcastDraft;
  suggestionDraft: PrivateSuggestionDraft | null;
};

export type PrivateContext = {
  update: MaxUpdate;
  chatId: string;
  actor: AuthUser;
  text: string;
  callbackId: string | null;
  callbackPayload: string | null;
};

export type PrivateView = {
  text: string;
  options?: MaxSendMessageOptions;
};

export type CallbackAction = {
  action: string;
  args: string[];
};

export type GiveawayHandoffStartPayload = {
  v: 1;
  k: 'giveaway-handoff';
  c: string;
  e: ManagedEntityType;
  g: string | null;
};

export type ProfileMentionStartPayload = {
  v: 1;
  k: 'profile-mention';
  c: string;
  e: ManagedEntityType;
  u: string;
  n: string;
};

export type ParsedImageAttachment = {
  url: string;
  token: string | null;
  photoId: string | null;
  width: number | null;
  height: number | null;
  mimeType: string | null;
  mediaType: string | null;
  payloadKeys: string[];
};

export type ParsedImageFileAttachment = {
  url: string;
  token: string | null;
  fileId: string | null;
  fileName: string | null;
  size: number | null;
  mimeType: string | null;
  mediaType: string | null;
  payloadKeys: string[];
};

export type ParsedImageSourceAttachment =
  | {
      kind: 'image';
      attachment: ParsedImageAttachment;
    }
  | {
      kind: 'file';
      attachment: ParsedImageFileAttachment;
    };

export type ParsedFileAttachment = {
  url: string | null;
  token: string | null;
  fileId: string | null;
  fileName: string | null;
  size: number | null;
  mimeType: string | null;
  mediaType: string | null;
  payloadKeys: string[];
};

export type ParsedVideoSourceAttachment = ParsedFileAttachment & {
  url: string | null;
  mimeType: string;
};

export type DownloadedImageAsset = {
  base64: string;
  mimeType: string;
  fileName: string;
};

export type DownloadedBinaryAsset = {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
};

export type ForwardedModerationCommand =
  | {
      action: 'BAN';
    }
  | {
      action: 'MUTE';
      muteDurationHours?: number;
      mutePermanent?: true;
    }
  | {
      action: 'RULES';
    };

export type ForwardedModerationActionCommand = Exclude<
  ForwardedModerationCommand,
  {
    action: 'RULES';
  }
>;

export type ForwardedModerationTarget = {
  chatId: string;
  chatTitle: string | null;
  userId: string;
  senderName: string | null;
};

export type ForwardedRulesSource = {
  chatId: string;
  chatTitle: string | null;
  messageId: string | null;
  url: string | null;
  text: string | null;
};
