import {
  addDomainRequestSchema,
  applySectionTargetPreviewResponseSchema,
  applySectionToAllResponseSchema,
  applySettingsTargetSchema,
  chatRulesSchema,
  chatSettingsSchema,
  chatSettingsScreenResponseSchema,
  domainAllowlistEntrySchema,
  publishChatRulesResultSchema,
  publishChatRulesRequestSchema,
  resolveRequiredSubscriptionChannelRequestSchema,
  resolveRequiredSubscriptionChannelResponseSchema,
  scheduleDomainRemovalRequestSchema,
  updateChatRulesRequestSchema,
  updateSettingsRequestSchema,
  patchSettingsSectionRequestSchema,
  type ApplySettingsSection,
  type ApplySectionToAllResponse,
  type ApplySectionTargetPreviewResponse,
  type ApplySettingsTarget,
  type AllowlistMatchType,
  type ChatRules,
  type ChatSettings,
  type ChatSettingsScreenResponse,
  type DomainAllowlistEntry,
  type NavigationAllowlistKind,
  type PublishChatRulesResult,
  type PublishChatRulesRequest,
  type ResolveRequiredSubscriptionChannelResponse,
} from '@maxim/contracts/settings';
import { BOT_SPEECH_EDITABLE_FIELD_KEYS } from '@maxim/contracts/bot-speech';
import {
  broadcastHandoffRequestSchema,
  broadcastHandoffResponseSchema,
  broadcastHandoffStateSchema,
  managedBroadcastDetailsSchema,
  managedBroadcastCalendarResponseSchema,
  managedBroadcastSummarySchema,
  createManagedAutopostRuleRequestSchema,
  managedAutopostRuleDetailsSchema,
  managedAutopostRuleSummarySchema,
  updateManagedAutopostRuleRequestSchema,
  sendBroadcastRequestSchema,
  sendBroadcastResultSchema,
  sendBroadcastTestResultSchema,
  type BroadcastHandoffState,
  type ManagedBroadcastCalendarResponse,
  type ManagedBroadcastDetails,
  type ManagedBroadcastSummary,
  type CreateManagedAutopostRuleRequest,
  type ManagedAutopostRuleDetails,
  type ManagedAutopostRuleSummary,
  type UpdateManagedAutopostRuleRequest,
  type SendBroadcastResult,
  type SendBroadcastTestResult,
} from '@maxim/contracts/broadcast';
import {
  managedEntityAccessRecheckResponseSchema,
  managedEntityBotExecutionPlanSchema,
  managedEntityHeaderSchema,
  promoteManagedEntityStandbyRequestSchema,
  updateManagedEntityPartnerAssistRequestSchema,
  updateManagedEntityPrimaryBotRequestSchema,
  type ManagedEntityBotExecutionPlan,
  type ManagedEntityAccessRecheckResponse,
  type ManagedEntityHeader,
} from '@maxim/contracts/managed-entities';
import {
  karavanStorefrontAllowlistRevokeResponseSchema,
  karavanStorefrontAllowlistResponseSchema,
  karavanStorefrontHandoffResponseSchema,
  type KaravanStorefrontAllowlistEntry,
  type KaravanStorefrontAllowlistResponse,
  type KaravanStorefrontHandoffResponse,
} from '@maxim/contracts/karavan-storefront';
import type {
  BroadcastHandoffPayload,
  SendBroadcastPayload,
  UpdateChatRulesPayload,
} from './shared-types';
import type { ApiTransport } from './transport';
import {
  updateBotSpeechStyleRequestSchema,
  updateBotSpeechStyleResponseSchema,
  type UpdateBotSpeechStyleRequest,
  type UpdateBotSpeechStyleResponse,
} from '@maxim/contracts/bot-speech';

export type BroadcastComposerClientResetState = {
  resetAt: string | null;
};

function parseBroadcastComposerClientResetState(
  response: unknown,
): BroadcastComposerClientResetState {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    return { resetAt: null };
  }

  const resetAt = (response as Record<string, unknown>).resetAt;
  return {
    resetAt: typeof resetAt === 'string' && resetAt.trim().length > 0 ? resetAt.trim() : null,
  };
}

export function createBroadcastRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/-/gu, '');
  }

  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
}

export async function getChatHeader(
  api: ApiTransport,
  chatId: string,
): Promise<ManagedEntityHeader> {
  const response = await api.request(`/chats/${chatId}/header`);
  return managedEntityHeaderSchema.parse(response);
}

export async function getChatBotExecutionPlan(
  api: ApiTransport,
  chatId: string,
  options: { refresh?: boolean; signal?: AbortSignal } = {},
): Promise<ManagedEntityBotExecutionPlan> {
  const query = options.refresh ? '?refresh=1' : '';
  const response = await api.request(`/chats/${chatId}/bots/plan${query}`, {
    signal: options.signal,
  });
  return managedEntityBotExecutionPlanSchema.parse(response);
}

export async function updateChatPrimaryBot(
  api: ApiTransport,
  chatId: string,
  botId: string,
): Promise<ManagedEntityBotExecutionPlan> {
  const requestBody = updateManagedEntityPrimaryBotRequestSchema.parse({ botId });
  const response = await api.request(`/chats/${chatId}/bots/primary`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return managedEntityBotExecutionPlanSchema.parse(response);
}

export async function updateChatPartnerAssist(
  api: ApiTransport,
  chatId: string,
  payload: { botId: string; enabled: boolean },
): Promise<ManagedEntityBotExecutionPlan> {
  const requestBody = updateManagedEntityPartnerAssistRequestSchema.parse(payload);
  const response = await api.request(`/chats/${chatId}/bots/partner-assist`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return managedEntityBotExecutionPlanSchema.parse(response);
}

export async function promoteChatStandbyBot(
  api: ApiTransport,
  chatId: string,
  botId?: string,
): Promise<ManagedEntityBotExecutionPlan> {
  const requestBody = promoteManagedEntityStandbyRequestSchema.parse(botId ? { botId } : {});
  const response = await api.request(`/chats/${chatId}/bots/promote-standby`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return managedEntityBotExecutionPlanSchema.parse(response);
}

export async function getSettings(api: ApiTransport, chatId: string): Promise<ChatSettings> {
  const response = await api.request(`/chats/${chatId}/settings`);
  return chatSettingsSchema.parse(response);
}

export async function getSettingsScreen(
  api: ApiTransport,
  chatId: string,
  request: Pick<RequestInit, 'signal'> & { prefetch?: boolean } = {},
): Promise<ChatSettingsScreenResponse> {
  const query = request.prefetch === true ? '?prefetch=1' : '';
  const response = await api.request(`/chats/${chatId}/settings-screen${query}`, {
    signal: request.signal,
  });
  return chatSettingsScreenResponseSchema.parse(response);
}

export async function recheckManagedEntityAccess(
  api: ApiTransport,
  entityType: 'chat' | 'channel',
  entityId: string,
): Promise<ManagedEntityAccessRecheckResponse> {
  const response = await api.request(
    `/managed-entities/${entityType}/${encodeURIComponent(entityId)}/access/recheck`,
    {
      method: 'POST',
    },
  );
  return managedEntityAccessRecheckResponseSchema.parse(response);
}

export async function resolveRequiredSubscriptionChannel(
  api: ApiTransport,
  chatId: string,
  value: string,
): Promise<ResolveRequiredSubscriptionChannelResponse> {
  const requestBody = resolveRequiredSubscriptionChannelRequestSchema.parse({ value });
  const response = await api.request(`/chats/${chatId}/required-subscription/channels/resolve`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return resolveRequiredSubscriptionChannelResponseSchema.parse(response);
}

export async function updateBotSpeechStyle(
  api: ApiTransport,
  chatId: string,
  botSpeechStyle: UpdateBotSpeechStyleRequest['botSpeechStyle'],
): Promise<UpdateBotSpeechStyleResponse> {
  const requestBody = updateBotSpeechStyleRequestSchema.parse({ botSpeechStyle });
  const response = await api.request(`/chats/${chatId}/settings/speech-style`, {
    method: 'PATCH',
    body: JSON.stringify(requestBody),
  });
  return updateBotSpeechStyleResponseSchema.parse(response);
}

export async function updateSettings(
  api: ApiTransport,
  chatId: string,
  data: ChatSettings,
  options: { recheckBotCapabilities?: boolean } = {},
): Promise<ChatSettings> {
  const query = options.recheckBotCapabilities ? '?recheckBotCapabilities=1' : '';
  const requestBody: Partial<ChatSettings> = updateSettingsRequestSchema.parse({
    ...data,
    stopWordsPolicy: undefined,
    stopWordsRevision: undefined,
  });
  // FLAG: The ordinary settings endpoint cannot author or transport independent stop-list data.
  delete requestBody.stopWordsPolicy;
  delete requestBody.stopWordsRevision;
  delete requestBody.messageLimitsBlockedWords;
  delete requestBody.messageLimitsBlockedDomains;
  delete requestBody.messageLimitsImageTextScanEnabled;
  const response = await api.request(`/chats/${chatId}/settings${query}`, {
    method: 'PUT',
    body: JSON.stringify(requestBody),
  });
  return chatSettingsSchema.parse(response);
}

export async function patchSettingsSection(
  api: ApiTransport,
  chatId: string,
  section: ApplySettingsSection,
  data: ChatSettings,
  keys: readonly (keyof ChatSettings)[],
  options: { recheckBotCapabilities?: boolean } = {},
): Promise<ChatSettings> {
  const changes: Record<string, unknown> = Object.fromEntries(keys.map((key) => [key, data[key]]));
  const mediaKeys = BOT_SPEECH_EDITABLE_FIELD_KEYS.filter((key) => keys.includes(key));
  if (mediaKeys.length > 0) {
    changes.botSpeechMedia = Object.fromEntries(
      mediaKeys
        .filter((key) => data.botSpeechMedia[key])
        .map((key) => [key, data.botSpeechMedia[key]]),
    );
  }
  const request = patchSettingsSectionRequestSchema.parse({
    section,
    expectedRevision: data.settingsRevision,
    changes,
  });
  const query = options.recheckBotCapabilities ? '?recheckBotCapabilities=1' : '';
  return chatSettingsSchema.parse(
    await api.request(`/chats/${chatId}/settings/section${query}`, {
      method: 'PATCH',
      body: JSON.stringify(request),
    }),
  );
}

export async function getKaravanStorefrontAllowlist(
  api: ApiTransport,
  chatId: string,
  options: Pick<RequestInit, 'signal'> & {
    cursor?: string;
    limit?: number;
    includeExpired?: boolean;
  } = {},
): Promise<KaravanStorefrontAllowlistResponse> {
  const query = new URLSearchParams();
  if (options.cursor) {
    query.set('cursor', options.cursor);
  }
  if (options.limit !== undefined) {
    query.set('limit', String(options.limit));
  }
  if (options.includeExpired !== undefined) {
    query.set('includeExpired', options.includeExpired ? 'true' : 'false');
  }
  const suffix = query.toString();
  const response = await api.request(
    `/chats/${chatId}/karavan-storefront/allowlist${suffix ? `?${suffix}` : ''}`,
    { signal: options.signal },
  );
  return karavanStorefrontAllowlistResponseSchema.parse(response);
}

export async function handoffKaravanStorefrontAllowlist(
  api: ApiTransport,
  chatId: string,
): Promise<KaravanStorefrontHandoffResponse> {
  const response = await api.request(`/chats/${chatId}/karavan-storefront/allowlist/handoff`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  return karavanStorefrontHandoffResponseSchema.parse(response);
}

export async function revokeKaravanStorefrontAllowlistEntry(
  api: ApiTransport,
  chatId: string,
  entryId: string,
) {
  const response = await api.request(
    `/chats/${chatId}/karavan-storefront/allowlist/${encodeURIComponent(entryId)}`,
    { method: 'DELETE' },
  );
  return karavanStorefrontAllowlistRevokeResponseSchema.parse(response);
}

// Keep the type available to consumers that need to render an entry without importing contracts.
export type { KaravanStorefrontAllowlistEntry };

export async function applySettingsSectionToAll(
  api: ApiTransport,
  chatId: string,
  section: ApplySectionToAllResponse['section'],
  target?: ApplySettingsTarget,
  expectedSourceRevision?: number,
  confirmedSource?: {
    expectedSourceSettingsRevision: string;
    confirmedTargetChatIds?: string[];
  },
): Promise<ApplySectionToAllResponse> {
  const requestBody = {
    section,
    ...(section === 'stopWords' ? { expectedSourceRevision } : {}),
    ...(section === 'reports'
      ? confirmedSource
      : section === 'links' && confirmedSource
        ? { expectedSourceSettingsRevision: confirmedSource.expectedSourceSettingsRevision }
        : {}),
    ...(target ? { target: applySettingsTargetSchema.parse(target) } : {}),
  };
  const response = await api.request(`/chats/${chatId}/settings/apply-section-to-all`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
    retryMutationOnTransportError: false,
  });
  return applySectionToAllResponseSchema.parse(response);
}

export async function previewApplySettingsSectionTarget(
  api: ApiTransport,
  chatId: string,
  target: ApplySettingsTarget,
): Promise<ApplySectionTargetPreviewResponse> {
  const response = await api.request(`/chats/${chatId}/settings/apply-section-preview`, {
    method: 'POST',
    body: JSON.stringify({ target: applySettingsTargetSchema.parse(target) }),
  });
  return applySectionTargetPreviewResponseSchema.parse(response);
}

export async function getRules(api: ApiTransport, chatId: string): Promise<ChatRules> {
  const response = await api.request(`/chats/${chatId}/rules`);
  return chatRulesSchema.parse(response);
}

export async function updateRules(
  api: ApiTransport,
  chatId: string,
  payload: UpdateChatRulesPayload,
): Promise<ChatRules> {
  const requestBody = updateChatRulesRequestSchema.parse(payload);
  const response = await api.request(`/chats/${chatId}/rules`, {
    method: 'PUT',
    body: JSON.stringify(requestBody),
  });
  return chatRulesSchema.parse(response);
}

export async function publishRules(
  api: ApiTransport,
  chatId: string,
  request: PublishChatRulesRequest = {},
): Promise<PublishChatRulesResult> {
  const response = await api.request(`/chats/${chatId}/rules/publish`, {
    method: 'POST',
    body: JSON.stringify(publishChatRulesRequestSchema.parse(request)),
  });
  return publishChatRulesResultSchema.parse(response);
}

export async function resetPublishedRules(api: ApiTransport, chatId: string): Promise<ChatRules> {
  const response = await api.request(`/chats/${chatId}/rules/publish`, {
    method: 'DELETE',
  });
  return chatRulesSchema.parse(response);
}

export async function handoffBroadcast(
  api: ApiTransport,
  chatId: string,
  payload: BroadcastHandoffPayload,
) {
  const requestBody = broadcastHandoffRequestSchema.parse(payload);
  const response = await api.request(`/chats/${chatId}/broadcast/handoff`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return broadcastHandoffResponseSchema.parse(response);
}

export async function getBroadcastHandoffState(
  api: ApiTransport,
  chatId: string,
): Promise<BroadcastHandoffState> {
  const response = await api.request(`/chats/${chatId}/broadcast/handoff`);
  return broadcastHandoffStateSchema.parse(response);
}

export async function clearBroadcastHandoffState(
  api: ApiTransport,
  chatId: string,
): Promise<BroadcastHandoffState> {
  const response = await api.request(`/chats/${chatId}/broadcast/handoff`, {
    method: 'DELETE',
  });
  return broadcastHandoffStateSchema.parse(response);
}

export async function getBroadcastComposerClientResetState(
  api: ApiTransport,
  chatId: string,
  options: { signal?: AbortSignal } = {},
): Promise<BroadcastComposerClientResetState> {
  const response = await api.request(`/chats/${chatId}/broadcast/client-reset`, {
    signal: options.signal,
  });
  return parseBroadcastComposerClientResetState(response);
}

export async function handoffRules(api: ApiTransport, chatId: string) {
  const response = await api.request(`/chats/${chatId}/rules/handoff`, {
    method: 'POST',
  });
  return broadcastHandoffResponseSchema.parse(response);
}

export async function getManagedBroadcasts(
  api: ApiTransport,
  chatId: string,
): Promise<ManagedBroadcastSummary[]> {
  const response = await api.request(`/chats/${chatId}/broadcasts`);
  if (!Array.isArray(response)) {
    throw new Error('Invalid managed broadcasts response');
  }

  return response.map((item: unknown) => managedBroadcastSummarySchema.parse(item));
}

export async function getManagedBroadcastCalendar(
  api: ApiTransport,
  chatId: string,
  params: {
    from?: string;
    to?: string;
    targetMode?: 'current' | 'selected' | 'all';
    targetChatIds?: readonly string[];
  } = {},
): Promise<ManagedBroadcastCalendarResponse> {
  const search = new URLSearchParams();
  if (params.from) {
    search.set('from', params.from);
  }
  if (params.to) {
    search.set('to', params.to);
  }
  if (params.targetMode) {
    search.set('targetMode', params.targetMode);
  }
  if (params.targetChatIds && params.targetChatIds.length > 0) {
    search.set('targetChatIds', params.targetChatIds.join(','));
  }

  const response = await api.request(
    `/chats/${chatId}/broadcast-calendar${search.toString() ? `?${search.toString()}` : ''}`,
  );
  return managedBroadcastCalendarResponseSchema.parse(response);
}

export async function getManagedBroadcast(
  api: ApiTransport,
  chatId: string,
  broadcastId: string,
): Promise<ManagedBroadcastDetails> {
  const response = await api.request(`/chats/${chatId}/broadcasts/${broadcastId}`);
  return managedBroadcastDetailsSchema.parse(response);
}

export async function updateManagedBroadcast(
  api: ApiTransport,
  chatId: string,
  broadcastId: string,
  payload: SendBroadcastPayload,
): Promise<ManagedBroadcastDetails> {
  const requestBody = sendBroadcastRequestSchema.parse({
    ...payload,
    requestId: payload.requestId ?? createBroadcastRequestId(),
  });
  const response = await api.request(`/chats/${chatId}/broadcasts/${broadcastId}`, {
    method: 'PUT',
    body: JSON.stringify(requestBody),
  });
  return managedBroadcastDetailsSchema.parse(response);
}

export async function cancelManagedBroadcast(
  api: ApiTransport,
  chatId: string,
  broadcastId: string,
): Promise<ManagedBroadcastDetails> {
  const response = await api.request(`/chats/${chatId}/broadcasts/${broadcastId}`, {
    method: 'DELETE',
  });
  return managedBroadcastDetailsSchema.parse(response);
}

export async function retryManagedBroadcast(
  api: ApiTransport,
  chatId: string,
  broadcastId: string,
): Promise<ManagedBroadcastDetails> {
  const response = await api.request(`/chats/${chatId}/broadcasts/${broadcastId}/retry`, {
    method: 'POST',
  });
  return managedBroadcastDetailsSchema.parse(response);
}

export async function getManagedAutopostRules(
  api: ApiTransport,
  chatId: string,
): Promise<ManagedAutopostRuleSummary[]> {
  const response = await api.request(`/chats/${chatId}/autopost-rules`);
  if (!Array.isArray(response)) {
    throw new Error('Invalid managed autopost rules response');
  }

  return response.map((item: unknown) => managedAutopostRuleSummarySchema.parse(item));
}

export async function getManagedAutopostRule(
  api: ApiTransport,
  chatId: string,
  ruleId: string,
): Promise<ManagedAutopostRuleDetails> {
  const response = await api.request(`/chats/${chatId}/autopost-rules/${ruleId}`);
  return managedAutopostRuleDetailsSchema.parse(response);
}

export async function createManagedAutopostRule(
  api: ApiTransport,
  chatId: string,
  payload: CreateManagedAutopostRuleRequest,
): Promise<ManagedAutopostRuleDetails> {
  const requestBody = createManagedAutopostRuleRequestSchema.parse(payload);
  const response = await api.request(`/chats/${chatId}/autopost-rules`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return managedAutopostRuleDetailsSchema.parse(response);
}

export async function updateManagedAutopostRule(
  api: ApiTransport,
  chatId: string,
  ruleId: string,
  payload: UpdateManagedAutopostRuleRequest,
): Promise<ManagedAutopostRuleDetails> {
  const requestBody = updateManagedAutopostRuleRequestSchema.parse(payload);
  const response = await api.request(`/chats/${chatId}/autopost-rules/${ruleId}`, {
    method: 'PUT',
    body: JSON.stringify(requestBody),
  });
  return managedAutopostRuleDetailsSchema.parse(response);
}

export async function deleteManagedAutopostRule(
  api: ApiTransport,
  chatId: string,
  ruleId: string,
): Promise<ManagedAutopostRuleDetails> {
  const response = await api.request(`/chats/${chatId}/autopost-rules/${ruleId}`, {
    method: 'DELETE',
  });
  return managedAutopostRuleDetailsSchema.parse(response);
}

export async function getDomainAllowlistDetails(
  api: ApiTransport,
  chatId: string,
): Promise<DomainAllowlistEntry[]> {
  const response = await api.request(`/chats/${chatId}/domain-allowlist/details`);
  if (!Array.isArray(response)) {
    throw new Error('Invalid domain allowlist details response');
  }

  return response.map((item: unknown) => domainAllowlistEntrySchema.parse(item));
}

export async function addDomain(
  api: ApiTransport,
  chatId: string,
  payload: {
    domain: string;
    kind?: NavigationAllowlistKind;
    matchType?: AllowlistMatchType;
  },
): Promise<void> {
  const requestBody = addDomainRequestSchema.parse(payload);
  await api.request(`/chats/${chatId}/domain-allowlist`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
}

export async function removeDomain(
  api: ApiTransport,
  chatId: string,
  domain: string,
): Promise<void> {
  await api.request(`/chats/${chatId}/domain-allowlist?domain=${encodeURIComponent(domain)}`, {
    method: 'DELETE',
  });
}

export async function scheduleDomainRemoval(
  api: ApiTransport,
  chatId: string,
  domain: string,
  removeAfterAt: string | null,
): Promise<void> {
  const payload = scheduleDomainRemovalRequestSchema.parse({ removeAfterAt });
  await api.request(
    `/chats/${chatId}/domain-allowlist/removal-schedule?domain=${encodeURIComponent(domain)}`,
    {
      method: 'PUT',
      body: JSON.stringify(payload),
    },
  );
}

export async function sendBroadcast(
  api: ApiTransport,
  chatId: string,
  payload: SendBroadcastPayload,
): Promise<SendBroadcastResult> {
  const requestBody = sendBroadcastRequestSchema.parse({
    ...payload,
    requestId: payload.requestId ?? createBroadcastRequestId(),
  });
  const response = await api.request(`/chats/${chatId}/broadcast`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return sendBroadcastResultSchema.parse(response);
}

export async function sendBroadcastTest(
  api: ApiTransport,
  chatId: string,
  payload: SendBroadcastPayload,
): Promise<SendBroadcastTestResult> {
  const requestBody = sendBroadcastRequestSchema.parse({
    ...payload,
    targetMode: 'current',
    targetChatIds: [chatId],
    applyToAllChats: false,
    scheduleMode: 'legacy',
    scheduledSlots: [],
    sendAt: null,
    cycleEnabled: false,
    cycleEveryHours: 1,
    cycleCount: 1,
  });
  const response = await api.request(`/chats/${chatId}/broadcast/test`, {
    method: 'POST',
    body: JSON.stringify(requestBody),
  });
  return sendBroadcastTestResultSchema.parse(response);
}
