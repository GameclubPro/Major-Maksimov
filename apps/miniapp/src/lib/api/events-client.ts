import type {
  BroadcastHandoffResponse,
  ChatParticipantImmunityUpdateRequest,
  ChatParticipantImmunityUpdateResult,
  ChatParticipantsPage,
  ChatParticipantsQuery,
  ChatUnavailableParticipantsCleanupRequest,
  ChatUnavailableParticipantsCleanupResult,
  GlobalSpammerCandidateStatus,
  GlobalSpammerReviewMetrics,
  GlobalSpammerReviewQueue,
  GlobalSpammerReviewRequest,
  GlobalSpammerReviewResult,
  GlobalSpammerUserDiagnostics,
  LogsDashboardRange,
  LogsDashboardResponse,
  ManualModerationActionRequest,
  ManualModerationActionResult,
  MembershipActivityPage,
  MembershipActivityQuery,
  ModerationFeedPage,
  ModerationFeedQuery,
  ProfileMentionHandoffRequest,
} from '@maxim/contracts';
import type { ApiTransport } from './transport';

export const MANUAL_MODERATION_ACTION_TIMEOUT_MS = 55_000;

export type ChatStatisticsIdentity = {
  id: string;
  title: string;
  avatarUrl: string | null;
  participantsCount: number | null;
};

const logsDashboardRanges = new Set<LogsDashboardRange>(['24h', '7d', '30d']);
const membershipActivityFilters = new Set<MembershipActivityQuery['filter']>([
  'all',
  'joined',
  'left',
]);
const participantRoleFilters = new Set<ChatParticipantsQuery['roleFilter']>([
  'all',
  'admins',
  'members',
  'bots',
]);
const moderationFeedFilters = new Set<ModerationFeedQuery['filter']>([
  'ALL',
  'COMMERCIAL',
  'WARN',
  'DELETE_MESSAGE',
  'MUTE',
  'BAN',
  'UNMUTE',
  'UNBAN',
]);
const globalSpammerCandidateStatuses = new Set<GlobalSpammerCandidateStatus | 'ALL'>([
  'PENDING',
  'AUTO_APPROVED',
  'APPROVED',
  'SUPPRESSED',
  'ALL',
]);
const globalSpammerRegistryStatuses = new Set([
  'NONE',
  'ACTIVE_CONFIRMED',
  'LOCAL_BLOCKED',
  'MEDIUM_REVIEW',
  'SUPPRESSED',
  'EXPIRED',
  'ADMIN_EXEMPT',
]);
const globalSpammerPolicyActions = new Set(['NONE', 'DELETE_AND_KICK', 'SHADOW_DELETE_AND_KICK']);
const globalSpammerEnforcementModes = new Set(['enforce', 'shadow']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasRequestSignal(value: unknown): value is Pick<RequestInit, 'signal'> {
  return Boolean(value && typeof value === 'object' && 'signal' in value);
}

function parseGlobalSpammerUserDiagnosticsResponse(
  response: unknown,
): GlobalSpammerUserDiagnostics {
  if (!isRecord(response) || typeof response.userId !== 'string') {
    throw new Error('Invalid spammer diagnostics response');
  }

  const policy = response.policy;
  const registry = response.registry;
  const reputationSummary = response.reputationSummary;
  if (
    !isRecord(policy) ||
    !globalSpammerRegistryStatuses.has(String(policy.registryStatus)) ||
    !globalSpammerPolicyActions.has(String(policy.action)) ||
    !globalSpammerEnforcementModes.has(String(policy.enforcementMode)) ||
    typeof policy.deleteSpammersEnabled !== 'boolean' ||
    !isRecord(registry) ||
    !Array.isArray(response.observations) ||
    !Array.isArray(response.graphSignals) ||
    !Array.isArray(response.campaigns) ||
    !isRecord(reputationSummary)
  ) {
    throw new Error('Invalid spammer diagnostics response');
  }

  return response as GlobalSpammerUserDiagnostics;
}

function parseLogsDashboardRange(range: LogsDashboardRange): LogsDashboardRange {
  if (!logsDashboardRanges.has(range)) {
    throw new Error('Invalid dashboard range');
  }

  return range;
}

function parseChatStatisticsIdentity(
  response: unknown,
  expectedChatId: string,
): ChatStatisticsIdentity {
  if (
    !isRecord(response) ||
    response.id !== expectedChatId ||
    response.entityType !== 'chat' ||
    typeof response.title !== 'string' ||
    !(
      response.avatarUrl === null ||
      response.avatarUrl === undefined ||
      typeof response.avatarUrl === 'string'
    ) ||
    !(
      response.participantsCount === null ||
      (typeof response.participantsCount === 'number' &&
        Number.isInteger(response.participantsCount) &&
        response.participantsCount >= 0)
    )
  ) {
    throw new Error('Invalid chat statistics identity');
  }

  return {
    id: response.id,
    title: response.title,
    avatarUrl: typeof response.avatarUrl === 'string' ? response.avatarUrl : null,
    participantsCount: response.participantsCount,
  };
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  const limit = value ?? fallback;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error('Invalid page limit');
  }

  return limit;
}

function normalizeMembershipActivityQuery(
  query: Partial<MembershipActivityQuery>,
): MembershipActivityQuery {
  const range = query.range ?? '7d';
  const filter = query.filter ?? 'all';
  if (!logsDashboardRanges.has(range)) {
    throw new Error('Invalid activity range');
  }
  if (!membershipActivityFilters.has(filter)) {
    throw new Error('Invalid activity filter');
  }

  const cursor = query.cursor?.trim();
  return {
    range,
    filter,
    limit: normalizeLimit(query.limit, 50),
    ...(cursor ? { cursor } : {}),
  };
}

function normalizeModerationFeedQuery(query: Partial<ModerationFeedQuery>): ModerationFeedQuery {
  const range = query.range ?? '7d';
  const filter = query.filter ?? 'ALL';
  if (!logsDashboardRanges.has(range)) {
    throw new Error('Invalid moderation range');
  }
  if (!moderationFeedFilters.has(filter)) {
    throw new Error('Invalid moderation filter');
  }

  const cursor = query.cursor?.trim();
  return {
    range,
    filter,
    limit: normalizeLimit(query.limit, 50),
    ...(cursor ? { cursor } : {}),
  };
}

function normalizeChatParticipantsQuery(
  query: Partial<ChatParticipantsQuery>,
): ChatParticipantsQuery {
  const range = query.range ?? '7d';
  const roleFilter = query.roleFilter ?? 'all';
  const activityFilter = query.activityFilter ?? 'all';
  if (!logsDashboardRanges.has(range)) {
    throw new Error('Invalid participants range');
  }
  if (!participantRoleFilters.has(roleFilter)) {
    throw new Error('Invalid participant role filter');
  }
  if (!['all', '7d', '14d', '30d', '60d', '90d', 'unknown'].includes(activityFilter)) {
    throw new Error('Invalid participant activity filter');
  }

  const cursor = query.cursor?.trim();
  const search = query.search?.trim();
  return {
    range,
    roleFilter,
    ...(activityFilter !== 'all' ? { activityFilter } : {}),
    limit: normalizeLimit(query.limit, 100),
    ...(cursor ? { cursor } : {}),
    ...(search ? { search } : {}),
  };
}

export async function getChatStatisticsIdentity(
  api: ApiTransport,
  chatId: string,
  request: Pick<RequestInit, 'signal'> = {},
): Promise<ChatStatisticsIdentity> {
  const response = await api.request(`/chats/${chatId}/header`, request);
  return parseChatStatisticsIdentity(response, chatId);
}

export async function getLogsDashboard(
  api: ApiTransport,
  chatId: string,
  range: LogsDashboardRange = '7d',
  options: Partial<{
    includeActivityPreview: boolean;
    includeModerationPreview: boolean;
  }> = {},
  request: Pick<RequestInit, 'signal'> = {},
): Promise<LogsDashboardResponse> {
  const validatedRange = parseLogsDashboardRange(range);
  const params = new URLSearchParams({
    range: validatedRange,
  });
  if (options.includeActivityPreview === false) {
    params.set('includeActivityPreview', 'false');
  }
  if (options.includeModerationPreview === false) {
    params.set('includeModerationPreview', 'false');
  }
  const response = await api.request(
    `/chats/${chatId}/logs-dashboard?${params.toString()}`,
    request,
  );
  return response as LogsDashboardResponse;
}

export async function getChatModerationDashboard(
  api: ApiTransport,
  chatId: string,
  range: LogsDashboardRange = '7d',
  request: Pick<RequestInit, 'signal'> = {},
): Promise<LogsDashboardResponse> {
  const validatedRange = parseLogsDashboardRange(range);
  const params = new URLSearchParams({
    range: validatedRange,
  });
  const response = await api.request(
    `/chats/${chatId}/moderation-dashboard?${params.toString()}`,
    request,
  );
  return response as LogsDashboardResponse;
}

export async function getChatActivityDashboard(
  api: ApiTransport,
  chatId: string,
  range: LogsDashboardRange = '7d',
  request: Pick<RequestInit, 'signal'> = {},
): Promise<LogsDashboardResponse> {
  const validatedRange = parseLogsDashboardRange(range);
  const params = new URLSearchParams({
    range: validatedRange,
  });
  const response = await api.request(
    `/chats/${chatId}/activity-dashboard?${params.toString()}`,
    request,
  );
  return response as LogsDashboardResponse;
}

export async function getChatActivityFeed(
  api: ApiTransport,
  chatId: string,
  query: Partial<MembershipActivityQuery> = {},
  request: Pick<RequestInit, 'signal'> = {},
): Promise<MembershipActivityPage> {
  const validatedQuery = normalizeMembershipActivityQuery(query);
  const params = new URLSearchParams({
    range: validatedQuery.range,
    filter: validatedQuery.filter,
    limit: String(validatedQuery.limit),
  });

  if (validatedQuery.cursor) {
    params.set('cursor', validatedQuery.cursor);
  }

  const response = await api.request(
    `/chats/${chatId}/activity-feed?${params.toString()}`,
    request,
  );
  return response as MembershipActivityPage;
}

export async function getChatModerationFeed(
  api: ApiTransport,
  chatId: string,
  query: Partial<ModerationFeedQuery> = {},
  request: Pick<RequestInit, 'signal'> = {},
): Promise<ModerationFeedPage> {
  const validatedQuery = normalizeModerationFeedQuery(query);
  const params = new URLSearchParams({
    range: validatedQuery.range,
    filter: validatedQuery.filter,
    limit: String(validatedQuery.limit),
  });

  if (validatedQuery.cursor) {
    params.set('cursor', validatedQuery.cursor);
  }

  const response = await api.request(
    `/chats/${chatId}/moderation-feed?${params.toString()}`,
    request,
  );
  return response as ModerationFeedPage;
}

export async function getChatParticipantsPage(
  api: ApiTransport,
  chatId: string,
  query: Partial<ChatParticipantsQuery> = {},
  request: Pick<RequestInit, 'signal'> = {},
): Promise<ChatParticipantsPage> {
  const validatedQuery = normalizeChatParticipantsQuery(query);
  const params = new URLSearchParams({
    range: validatedQuery.range,
    roleFilter: validatedQuery.roleFilter,
    limit: String(validatedQuery.limit),
  });

  if (validatedQuery.cursor) {
    params.set('cursor', validatedQuery.cursor);
  }
  if (validatedQuery.search) {
    params.set('search', validatedQuery.search);
  }
  if (validatedQuery.activityFilter && validatedQuery.activityFilter !== 'all') {
    params.set('activityFilter', validatedQuery.activityFilter);
  }

  const response = await api.request(`/chats/${chatId}/members?${params.toString()}`, request);
  return response as ChatParticipantsPage;
}

export async function applyManualModerationAction(
  api: ApiTransport,
  chatId: string,
  userId: string,
  payload: ManualModerationActionRequest,
): Promise<ManualModerationActionResult> {
  const requestBody = payload;
  const response = await api.request(
    `/chats/${chatId}/members/${encodeURIComponent(userId)}/moderation-action`,
    {
      method: 'POST',
      body: JSON.stringify(requestBody),
      timeoutMs: MANUAL_MODERATION_ACTION_TIMEOUT_MS,
      retryMutationOnTransportError: false,
    },
  );
  return response as ManualModerationActionResult;
}

export async function cleanupUnavailableChatParticipants(
  api: ApiTransport,
  chatId: string,
  payload: Partial<ChatUnavailableParticipantsCleanupRequest> = {},
): Promise<ChatUnavailableParticipantsCleanupResult> {
  const response = await api.request(`/chats/${chatId}/members/unavailable-cleanup`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return response as ChatUnavailableParticipantsCleanupResult;
}

export async function getGlobalSpammerReviewQueue(
  api: ApiTransport,
  chatId: string,
  query: Partial<{
    status: GlobalSpammerCandidateStatus | 'ALL';
    limit: number;
    includeProfiles: boolean;
    includeObservations: boolean;
    profileMode: 'full' | 'local';
  }> = {},
  request: Pick<RequestInit, 'signal'> = {},
): Promise<GlobalSpammerReviewQueue> {
  const status = query.status ?? 'PENDING';
  if (!globalSpammerCandidateStatuses.has(status)) {
    throw new Error('Invalid spammer review status');
  }

  const limit = normalizeLimit(query.limit, 50);
  const params = new URLSearchParams({
    status,
    limit: String(limit),
  });
  if (query.includeProfiles === false) {
    params.set('includeProfiles', 'false');
  } else if (query.includeProfiles === true) {
    params.set('includeProfiles', 'true');
  }
  if (query.includeObservations === false) {
    params.set('includeObservations', 'false');
  } else if (query.includeObservations === true) {
    params.set('includeObservations', 'true');
  }
  if (query.profileMode === 'local') {
    params.set('profileMode', 'local');
  } else if (query.profileMode === 'full') {
    params.set('profileMode', 'full');
  }
  const response = await api.request(
    `/chats/${chatId}/spammer-review?${params.toString()}`,
    request,
  );
  return response as GlobalSpammerReviewQueue;
}

export async function getGlobalSpammerReviewMetrics(
  api: ApiTransport,
  chatId: string,
  queryOrRequest:
    | Partial<{
        mode: 'summary' | 'full';
      }>
    | Pick<RequestInit, 'signal'> = {},
  request: Pick<RequestInit, 'signal'> = hasRequestSignal(queryOrRequest) ? queryOrRequest : {},
): Promise<GlobalSpammerReviewMetrics> {
  const query = hasRequestSignal(queryOrRequest) ? {} : queryOrRequest;
  const params = new URLSearchParams();
  if (query.mode === 'summary' || query.mode === 'full') {
    params.set('mode', query.mode);
  }
  const queryString = params.toString();
  const path = `/chats/${chatId}/spammer-review/metrics${queryString ? `?${queryString}` : ''}`;
  const response = await api.request(path, request);
  return response as GlobalSpammerReviewMetrics;
}

export async function getGlobalSpammerUserDiagnostics(
  api: ApiTransport,
  chatId: string,
  userId: string,
  query: Partial<{
    mode: 'shell' | 'full';
    includeProfile: boolean;
    includeObservations: boolean;
    includeGraphSignals: boolean;
    includeReputation: boolean;
    includeCampaigns: boolean;
    includeShadow: boolean;
    profileMode: 'full' | 'local';
  }> = {},
  request: Pick<RequestInit, 'signal'> = {},
): Promise<GlobalSpammerUserDiagnostics> {
  const params = new URLSearchParams();
  if (query.mode === 'full' || query.mode === 'shell') {
    params.set('mode', query.mode);
  }
  if (query.includeProfile === false) {
    params.set('includeProfile', 'false');
  } else if (query.includeProfile === true) {
    params.set('includeProfile', 'true');
  }
  if (query.includeObservations === false) {
    params.set('includeObservations', 'false');
  } else if (query.includeObservations === true) {
    params.set('includeObservations', 'true');
  }
  if (query.includeGraphSignals === false) {
    params.set('includeGraphSignals', 'false');
  } else if (query.includeGraphSignals === true) {
    params.set('includeGraphSignals', 'true');
  }
  if (query.includeReputation === false) {
    params.set('includeReputation', 'false');
  } else if (query.includeReputation === true) {
    params.set('includeReputation', 'true');
  }
  if (query.includeCampaigns === false) {
    params.set('includeCampaigns', 'false');
  } else if (query.includeCampaigns === true) {
    params.set('includeCampaigns', 'true');
  }
  if (query.includeShadow === false) {
    params.set('includeShadow', 'false');
  } else if (query.includeShadow === true) {
    params.set('includeShadow', 'true');
  }
  if (query.profileMode === 'local') {
    params.set('profileMode', 'local');
  } else if (query.profileMode === 'full') {
    params.set('profileMode', 'full');
  }
  const suffix = params.toString();
  const path = `/chats/${chatId}/spammer-diagnostics/${encodeURIComponent(userId)}`;
  const response = await api.request(suffix ? `${path}?${suffix}` : path, request);
  return parseGlobalSpammerUserDiagnosticsResponse(response);
}

export async function reviewGlobalSpammerCandidate(
  api: ApiTransport,
  chatId: string,
  userId: string,
  payload: GlobalSpammerReviewRequest,
): Promise<GlobalSpammerReviewResult> {
  const response = await api.request(
    `/chats/${chatId}/spammer-review/${encodeURIComponent(userId)}`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  );
  return response as GlobalSpammerReviewResult;
}

export async function updateChatParticipantImmunity(
  api: ApiTransport,
  chatId: string,
  userId: string,
  payload: ChatParticipantImmunityUpdateRequest,
): Promise<ChatParticipantImmunityUpdateResult> {
  const requestBody = payload;
  const response = await api.request(
    `/chats/${chatId}/members/${encodeURIComponent(userId)}/immunity`,
    {
      method: 'PUT',
      body: JSON.stringify(requestBody),
    },
  );
  return response as ChatParticipantImmunityUpdateResult;
}

export async function handoffChatMemberProfile(
  api: ApiTransport,
  chatId: string,
  userId: string,
  payload: ProfileMentionHandoffRequest,
): Promise<BroadcastHandoffResponse> {
  const requestBody = payload;
  const response = await api.request(
    `/chats/${chatId}/members/${encodeURIComponent(userId)}/profile/handoff`,
    {
      method: 'POST',
      body: JSON.stringify(requestBody),
    },
  );
  return response as BroadcastHandoffResponse;
}
