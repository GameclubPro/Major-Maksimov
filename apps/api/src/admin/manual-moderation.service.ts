import {
  globalSpammerCandidateStatusSchema,
  globalSpammerReviewMetricsSchema,
  globalSpammerReviewQueueSchema,
  globalSpammerReviewRequestSchema,
  globalSpammerReviewResultSchema,
  globalSpammerUserDiagnosticsSchema,
  manualModerationActionRequestSchema,
  type GlobalSpammerCandidateStatus,
  type GlobalSpammerReviewQueue,
  type GlobalSpammerUserDiagnostics,
} from '@maxim/contracts';
import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { type AuthUser } from '../common/decorators/current-user.decorator';
import { ChatEntityType } from '../prisma/prisma-client';
import { GlobalSpammerIntelligenceService } from '../moderation/global-spammer-intelligence.service';
import { RuntimeDiagnosticsService } from '../system/runtime-diagnostics.service';
import { AdminService } from './admin.service';
import { type ResolvedUserProfile } from './admin.service.support';
import { ChatSanctionsService } from './chat-sanctions.service';

type GlobalSpammerProfileMode = 'full' | 'local';
type GlobalSpammerDiagnosticsMode = 'shell' | 'full';
type GlobalSpammerReviewMetricsMode = 'summary' | 'full';

@Injectable()
export class ManualModerationService {
  private readonly logger = new Logger(ManualModerationService.name);

  constructor(
    private readonly legacyAdminService: AdminService,
    private readonly globalSpammerIntelligence: GlobalSpammerIntelligenceService,
    @Optional() private readonly runtimeDiagnostics?: RuntimeDiagnosticsService,
    @Optional() private readonly chatSanctions?: ChatSanctionsService,
  ) {}

  async getChatSanctions(chatId: string, user: AuthUser, query: unknown) {
    await this.legacyAdminService.assertChatAdmin(chatId, user.userId, 'chat');
    if (!this.chatSanctions) throw new Error('Chat sanctions service is unavailable');
    const page = await this.chatSanctions.getPage(chatId, user.userId, query);
    const profiles = await this.resolveGlobalSpammerProfiles(
      chatId,
      page.items.map((item) => item.userId),
      { allowRemoteLookup: false },
    );
    return {
      ...page,
      items: page.items.map((item) => {
        const profile = profiles.get(item.userId);
        return {
          ...item,
          userDisplayName:
            item.userDisplayName === 'Участник'
              ? profile?.displayName || item.userDisplayName
              : item.userDisplayName,
          avatarUrl: this.sanitizeContractUrl(profile?.avatarUrl),
          profileHandoffUrl: this.sanitizeContractUrl(profile?.profileHandoffUrl),
        };
      }),
    };
  }

  getChannelStats(
    ...args: Parameters<AdminService['getChannelStats']>
  ): ReturnType<AdminService['getChannelStats']> {
    return this.legacyAdminService.getChannelStats(...args);
  }

  getChannelActivityFeed(
    ...args: Parameters<AdminService['getChannelActivityFeed']>
  ): ReturnType<AdminService['getChannelActivityFeed']> {
    return this.legacyAdminService.getChannelActivityFeed(...args);
  }

  getChatActivityFeed(
    ...args: Parameters<AdminService['getChatActivityFeed']>
  ): ReturnType<AdminService['getChatActivityFeed']> {
    return this.legacyAdminService.getChatActivityFeed(...args);
  }

  getChatModerationFeed(
    ...args: Parameters<AdminService['getChatModerationFeed']>
  ): ReturnType<AdminService['getChatModerationFeed']> {
    return this.legacyAdminService.getChatModerationFeed(...args);
  }

  getChatParticipantsPage(
    ...args: Parameters<AdminService['getChatParticipantsPage']>
  ): ReturnType<AdminService['getChatParticipantsPage']> {
    return this.legacyAdminService.getChatParticipantsPage(...args);
  }

  getChatParticipantDetails(chatId: string, targetUserId: string, user: AuthUser, query: unknown) {
    return this.legacyAdminService.getChatParticipantDetails(chatId, targetUserId, user, query);
  }

  updateChatParticipantImmunity(
    ...args: Parameters<AdminService['updateChatParticipantImmunity']>
  ): ReturnType<AdminService['updateChatParticipantImmunity']> {
    return this.legacyAdminService.updateChatParticipantImmunity(...args);
  }

  cleanupUnavailableChatParticipants(
    ...args: Parameters<AdminService['cleanupUnavailableChatParticipants']>
  ): ReturnType<AdminService['cleanupUnavailableChatParticipants']> {
    return this.legacyAdminService.cleanupUnavailableChatParticipants(...args);
  }

  getEvents(...args: Parameters<AdminService['getEvents']>): ReturnType<AdminService['getEvents']> {
    return this.legacyAdminService.getEvents(...args);
  }

  getLogsDashboard(
    ...args: Parameters<AdminService['getLogsDashboard']>
  ): ReturnType<AdminService['getLogsDashboard']> {
    return this.legacyAdminService.getLogsDashboard(...args);
  }

  async getGlobalSpammerReviewQueue(chatId: string, user: AuthUser, query: unknown) {
    const startedAtMs = Date.now();
    await this.legacyAdminService.assertChatAdmin(chatId, user.userId, 'chat');
    const assertAdminMs = Date.now() - startedAtMs;
    const queryRecord =
      query && typeof query === 'object' ? (query as Record<string, unknown>) : {};
    const rawStatus = typeof queryRecord.status === 'string' ? queryRecord.status.trim() : '';
    const status = rawStatus === '' ? 'PENDING' : this.parseGlobalSpammerCandidateStatus(rawStatus);
    if (!status) {
      throw new BadRequestException({ status: ['Invalid spammer review status'] });
    }
    const rawLimit =
      typeof queryRecord.limit === 'string' || typeof queryRecord.limit === 'number'
        ? Number(queryRecord.limit)
        : NaN;
    const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(100, Math.trunc(rawLimit))) : 20;
    const includeProfiles = this.parseBooleanQuery(queryRecord.includeProfiles, true);
    const includeObservations = this.parseBooleanQuery(queryRecord.includeObservations, false);
    const profileMode = this.parseGlobalSpammerProfileMode(queryRecord.profileMode, 'local');
    const queueStartedAtMs = Date.now();
    const response = await this.globalSpammerIntelligence.listReviewQueue({
      chatId,
      reviewerUserId: user.userId,
      ...(typeof queryRecord.cursor === 'string' && queryRecord.cursor.length <= 1024
        ? { cursor: queryRecord.cursor }
        : {}),
      status,
      limit,
      includeObservations,
      includeLocalProfiles: includeProfiles && profileMode === 'local',
    });
    const queueMs = Date.now() - queueStartedAtMs;
    const parseStartedAtMs = Date.now();
    const parsedResponse = globalSpammerReviewQueueSchema.parse(response);
    const initialParseMs = Date.now() - parseStartedAtMs;
    if (!includeProfiles) {
      this.logSpammerSurfaceTiming('spammer-review', {
        chatId,
        assertAdminMs,
        queueMs,
        profileMs: 0,
        zodParseMs: initialParseMs,
        totalMs: Date.now() - startedAtMs,
        itemCount: parsedResponse.items.length,
        profileMode,
        includeProfiles,
        includeObservations,
      });
      return parsedResponse;
    }
    const profileStartedAtMs = Date.now();
    const enrichedResponse = await this.attachGlobalSpammerReviewProfiles(chatId, parsedResponse, {
      allowRemoteLookup: profileMode === 'full',
    });
    const profileMs = Date.now() - profileStartedAtMs;
    const finalParseStartedAtMs = Date.now();
    const finalResponse = globalSpammerReviewQueueSchema.parse(enrichedResponse);
    this.logSpammerSurfaceTiming('spammer-review', {
      chatId,
      assertAdminMs,
      queueMs,
      profileMs,
      zodParseMs: initialParseMs + (Date.now() - finalParseStartedAtMs),
      totalMs: Date.now() - startedAtMs,
      itemCount: finalResponse.items.length,
      profileMode,
      includeProfiles,
      includeObservations,
    });
    return finalResponse;
  }

  async getGlobalSpammerReviewMetrics(chatId: string, user: AuthUser, query: unknown = {}) {
    const startedAtMs = Date.now();
    await this.legacyAdminService.assertChatAdmin(chatId, user.userId, 'chat');
    const assertAdminMs = Date.now() - startedAtMs;
    const queryRecord =
      query && typeof query === 'object' ? (query as Record<string, unknown>) : {};
    const includeHeavy = this.parseBooleanQuery(queryRecord.includeHeavy, false);
    if (queryRecord.mode === 'mode' && !includeHeavy) {
      return globalSpammerReviewMetricsSchema.parse({
        enforcementMode: this.globalSpammerIntelligence.getEnforcementMode(),
        pending: 0,
        approved: 0,
        suppressed: 0,
        reviewed: 0,
        falsePositiveCount: 0,
        falsePositiveRate: 0,
        recentObservations: [],
        suppressedObservations: [],
        sourceAlerts: [],
      });
    }
    const mode = includeHeavy ? 'full' : this.parseGlobalSpammerReviewMetricsMode(queryRecord.mode);
    const metricsStartedAtMs = Date.now();
    const response = await this.globalSpammerIntelligence.getReviewMetrics({
      chatId,
      reviewerUserId: user.userId,
      mode,
    });
    const metricsMs = Date.now() - metricsStartedAtMs;
    const parseStartedAtMs = Date.now();
    const parsedResponse = globalSpammerReviewMetricsSchema.parse(response);
    this.logSpammerSurfaceTiming('spammer-review-metrics', {
      chatId,
      assertAdminMs,
      metricsMs,
      zodParseMs: Date.now() - parseStartedAtMs,
      totalMs: Date.now() - startedAtMs,
      mode,
    });
    return parsedResponse;
  }

  async getGlobalSpammerUserDiagnostics(
    chatId: string,
    targetUserId: string,
    user: AuthUser,
    query: unknown = {},
  ) {
    const startedAtMs = Date.now();
    await this.legacyAdminService.assertChatAdmin(chatId, user.userId, 'chat');
    const assertAdminMs = Date.now() - startedAtMs;
    const queryRecord =
      query && typeof query === 'object' ? (query as Record<string, unknown>) : {};
    const includeProfile = this.parseBooleanQuery(
      queryRecord.includeProfile ?? queryRecord.includeProfiles,
      true,
    );
    const diagnosticsMode = this.parseGlobalSpammerDiagnosticsMode(queryRecord.mode);
    const includeHeavyDiagnosticsByDefault = diagnosticsMode === 'full';
    const profileMode = this.parseGlobalSpammerProfileMode(
      queryRecord.profileMode,
      includeHeavyDiagnosticsByDefault ? 'full' : 'local',
    );
    const diagnosticsOptions = {
      includeObservations: this.parseBooleanQuery(
        queryRecord.includeObservations,
        includeHeavyDiagnosticsByDefault,
      ),
      includeGraphSignals: this.parseBooleanQuery(
        queryRecord.includeGraphSignals,
        includeHeavyDiagnosticsByDefault,
      ),
      includeReputation: this.parseBooleanQuery(
        queryRecord.includeReputation,
        includeHeavyDiagnosticsByDefault,
      ),
      includeCampaigns: this.parseBooleanQuery(
        queryRecord.includeCampaigns,
        includeHeavyDiagnosticsByDefault,
      ),
      includeShadow: this.parseBooleanQuery(
        queryRecord.includeShadow,
        includeHeavyDiagnosticsByDefault,
      ),
    };
    await this.globalSpammerIntelligence.assertReviewSubjectInChat(chatId, targetUserId);
    const diagnosticsStartedAtMs = Date.now();
    const response = await this.globalSpammerIntelligence.getUserDiagnostics({
      chatId,
      userId: targetUserId,
      options: diagnosticsOptions,
    });
    const diagnosticsMs = Date.now() - diagnosticsStartedAtMs;
    const parseStartedAtMs = Date.now();
    const parsedResponse = globalSpammerUserDiagnosticsSchema.parse(response);
    const initialParseMs = Date.now() - parseStartedAtMs;
    if (!includeProfile) {
      this.logSpammerSurfaceTiming('spammer-diagnostics', {
        chatId,
        targetUserId,
        assertAdminMs,
        diagnosticsMs,
        profileMs: 0,
        zodParseMs: initialParseMs,
        totalMs: Date.now() - startedAtMs,
        diagnosticsMode,
        profileMode,
        includeProfile,
        ...diagnosticsOptions,
      });
      return parsedResponse;
    }
    const profileStartedAtMs = Date.now();
    const enrichedResponse = await this.attachGlobalSpammerDiagnosticsProfile(
      chatId,
      parsedResponse,
      {
        allowRemoteLookup: profileMode === 'full',
      },
    );
    const profileMs = Date.now() - profileStartedAtMs;
    const finalParseStartedAtMs = Date.now();
    const finalResponse = globalSpammerUserDiagnosticsSchema.parse(enrichedResponse);
    this.logSpammerSurfaceTiming('spammer-diagnostics', {
      chatId,
      targetUserId,
      assertAdminMs,
      diagnosticsMs,
      profileMs,
      zodParseMs: initialParseMs + (Date.now() - finalParseStartedAtMs),
      totalMs: Date.now() - startedAtMs,
      diagnosticsMode,
      profileMode,
      includeProfile,
      ...diagnosticsOptions,
    });
    return finalResponse;
  }

  async reviewGlobalSpammerCandidate(
    chatId: string,
    targetUserId: string,
    user: AuthUser,
    body: unknown,
  ) {
    await this.legacyAdminService.assertChatAdmin(chatId, user.userId, 'chat', {
      trafficClass: 'critical',
    });
    const row = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const reason =
      typeof row.reason === 'string' && row.reason.trim() ? row.reason.trim() : undefined;
    const parsed = globalSpammerReviewRequestSchema.safeParse({
      action: typeof row.action === 'string' ? row.action.trim().toUpperCase() : row.action,
      ...(reason ? { reason } : {}),
    });
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.format());
    }

    await this.globalSpammerIntelligence.assertReviewSubjectInChat(chatId, targetUserId);
    const response = await this.globalSpammerIntelligence.reviewCandidate({
      chatId,
      userId: targetUserId,
      reviewerUserId: user.userId,
      action: parsed.data.action,
      reason: parsed.data.reason ?? null,
    });
    return globalSpammerReviewResultSchema.parse(response);
  }

  private parseGlobalSpammerCandidateStatus(
    value: string,
  ): GlobalSpammerCandidateStatus | 'ALL' | undefined {
    const normalized = value.trim().toUpperCase();
    if (normalized === 'ALL') {
      return normalized;
    }
    if (globalSpammerCandidateStatusSchema.safeParse(normalized).success) {
      return normalized as GlobalSpammerCandidateStatus;
    }
    return undefined;
  }

  private parseBooleanQuery(value: unknown, fallback: boolean): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value !== 'string') {
      return fallback;
    }
    const normalized = value.trim().toLowerCase();
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    return fallback;
  }

  private parseGlobalSpammerProfileMode(
    value: unknown,
    fallback: GlobalSpammerProfileMode,
  ): GlobalSpammerProfileMode {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (normalized === 'local' || normalized === 'cached') {
      return 'local';
    }
    if (normalized === 'full' || normalized === 'remote') {
      return 'full';
    }
    return fallback;
  }

  private parseGlobalSpammerDiagnosticsMode(value: unknown): GlobalSpammerDiagnosticsMode {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (normalized === 'full' || normalized === 'details' || normalized === 'heavy') {
      return 'full';
    }
    return 'shell';
  }

  private parseGlobalSpammerReviewMetricsMode(value: unknown): GlobalSpammerReviewMetricsMode {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (normalized === 'full' || normalized === 'details' || normalized === 'heavy') {
      return 'full';
    }
    return 'summary';
  }

  private logSpammerSurfaceTiming(surface: string, details: Record<string, unknown>): void {
    this.logger.debug({
      event: 'admin.spammer_surface_timing',
      surface,
      ...details,
    });
    this.recordSpammerSurfaceTiming(surface, details);
  }

  private recordSpammerSurfaceTiming(surface: string, details: Record<string, unknown>): void {
    const timings = Object.fromEntries(
      Object.entries(details)
        .filter(([key, value]) => key.endsWith('Ms') && typeof value === 'number')
        .map(([key, value]) => [key.replace(/Ms$/u, ''), value as number]),
    );
    void this.runtimeDiagnostics
      ?.recordSpammerSurfaceTiming({ surface, timings })
      .catch((error: unknown) => {
        this.logger.debug(
          {
            event: 'admin.spammer_surface_timing_record_failed',
            surface,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to record spammer surface timing',
        );
      });
  }

  private async attachGlobalSpammerReviewProfiles(
    chatId: string,
    response: GlobalSpammerReviewQueue,
    options: { allowRemoteLookup?: boolean } = {},
  ): Promise<GlobalSpammerReviewQueue> {
    const profiles =
      options.allowRemoteLookup === false
        ? new Map<string, ResolvedUserProfile>()
        : await this.resolveGlobalSpammerProfiles(
            chatId,
            response.items.map((item) => item.userId),
            options,
          );

    return {
      ...response,
      items: response.items.map((item) => {
        const profile = profiles.get(item.userId.trim());
        return {
          ...item,
          displayName:
            this.readTrimmedString(profile?.displayName) ??
            this.readTrimmedString(item.displayName) ??
            this.readTrimmedString(item.lastUserLabel) ??
            null,
          avatarUrl:
            this.sanitizeContractUrl(profile?.avatarUrl) ??
            this.sanitizeContractUrl(item.avatarUrl),
          profileUrl:
            this.sanitizeContractUrl(profile?.profileUrl) ??
            this.sanitizeContractUrl(item.profileUrl),
          profileHandoffUrl:
            this.sanitizeContractUrl(profile?.profileHandoffUrl) ??
            this.sanitizeContractUrl(item.profileHandoffUrl),
        };
      }),
    };
  }

  private async attachGlobalSpammerDiagnosticsProfile(
    chatId: string,
    response: GlobalSpammerUserDiagnostics,
    options: { allowRemoteLookup?: boolean } = {},
  ): Promise<GlobalSpammerUserDiagnostics> {
    if (options.allowRemoteLookup === false) {
      const profile = (
        await this.globalSpammerIntelligence.resolveLocalReviewProfiles({
          chatId,
          userIds: [response.userId],
        })
      ).get(response.userId.trim());

      return {
        ...response,
        displayName:
          this.readTrimmedString(profile?.displayName) ??
          this.readTrimmedString(response.displayName) ??
          null,
        avatarUrl: this.sanitizeContractUrl(response.avatarUrl),
        profileUrl: this.sanitizeContractUrl(response.profileUrl),
        profileHandoffUrl: this.sanitizeContractUrl(response.profileHandoffUrl),
      };
    }

    const profile = (
      await this.resolveGlobalSpammerProfiles(chatId, [response.userId], options)
    ).get(response.userId.trim());

    return {
      ...response,
      displayName:
        this.readTrimmedString(profile?.displayName) ??
        this.readTrimmedString(response.displayName) ??
        null,
      avatarUrl:
        this.sanitizeContractUrl(profile?.avatarUrl) ??
        this.sanitizeContractUrl(response.avatarUrl),
      profileUrl:
        this.sanitizeContractUrl(profile?.profileUrl) ??
        this.sanitizeContractUrl(response.profileUrl),
      profileHandoffUrl:
        this.sanitizeContractUrl(profile?.profileHandoffUrl) ??
        this.sanitizeContractUrl(response.profileHandoffUrl),
    };
  }

  private readTrimmedString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }

  private sanitizeContractUrl(value: unknown): string | null {
    const trimmed = this.readTrimmedString(value);
    if (!trimmed) {
      return null;
    }

    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
      }
      return trimmed;
    } catch {
      return null;
    }
  }

  private async resolveGlobalSpammerProfiles(
    chatId: string,
    userIds: readonly string[],
    options: { allowRemoteLookup?: boolean } = {},
  ): Promise<Map<string, ResolvedUserProfile>> {
    const normalizedUserIds = [...new Set(userIds.map((item) => item.trim()).filter(Boolean))];
    if (normalizedUserIds.length === 0) {
      return new Map();
    }

    return this.legacyAdminService.resolveUserProfilesForAdminSurface(
      chatId,
      'chat',
      normalizedUserIds,
      {
        allowRemoteLookup: options.allowRemoteLookup !== false,
      },
    );
  }

  applyManualModerationAction(
    ...args: Parameters<AdminService['applyManualModerationAction']>
  ): ReturnType<AdminService['applyManualModerationAction']> {
    const parsed = manualModerationActionRequestSchema.safeParse(args[3]);
    if (parsed.success && parsed.data.expectedSanctionEventId) {
      args[5] = { ...args[5], expectedSanctionEventId: parsed.data.expectedSanctionEventId };
    }
    return this.legacyAdminService.applyManualModerationAction(...args);
  }

  async banChannelMember(chatId: string, targetUserId: string, user: AuthUser) {
    await this.legacyAdminService.assertManagedEntityAdminAccess(chatId, user.userId, 'channel');
    return this.legacyAdminService.applyManualModerationAction(
      chatId,
      targetUserId,
      user,
      { action: 'BAN', scope: 'current_chat' },
      'miniapp',
      { entityType: ChatEntityType.CHANNEL, actorAlreadyVerified: true },
    );
  }

  applyManualSystemBan(
    ...args: Parameters<AdminService['applyManualSystemBan']>
  ): ReturnType<AdminService['applyManualSystemBan']> {
    return this.legacyAdminService.applyManualSystemBan(...args);
  }

  adoptChatRulesFromMessage(
    ...args: Parameters<AdminService['adoptChatRulesFromMessage']>
  ): ReturnType<AdminService['adoptChatRulesFromMessage']> {
    return this.legacyAdminService.adoptChatRulesFromMessage(...args);
  }

  applyManualChatSilenceCommand(
    ...args: Parameters<AdminService['applyManualChatSilenceCommand']>
  ): ReturnType<AdminService['applyManualChatSilenceCommand']> {
    return this.legacyAdminService.applyManualChatSilenceCommand(...args);
  }

  applyManualOpenChatCommand(
    ...args: Parameters<AdminService['applyManualOpenChatCommand']>
  ): ReturnType<AdminService['applyManualOpenChatCommand']> {
    return this.legacyAdminService.applyManualOpenChatCommand(...args);
  }

  enqueueManualGroupModerationCommand(
    ...args: Parameters<AdminService['enqueueManualGroupModerationCommand']>
  ): ReturnType<AdminService['enqueueManualGroupModerationCommand']> {
    return this.legacyAdminService.enqueueManualGroupModerationCommand(...args);
  }

  addAdmin(...args: Parameters<AdminService['addAdmin']>): ReturnType<AdminService['addAdmin']> {
    return this.legacyAdminService.addAdmin(...args);
  }

  removeAdmin(
    ...args: Parameters<AdminService['removeAdmin']>
  ): ReturnType<AdminService['removeAdmin']> {
    return this.legacyAdminService.removeAdmin(...args);
  }

  addDomain(...args: Parameters<AdminService['addDomain']>): ReturnType<AdminService['addDomain']> {
    return this.legacyAdminService.addDomain(...args);
  }

  getDomainAllowlist(
    ...args: Parameters<AdminService['getDomainAllowlist']>
  ): ReturnType<AdminService['getDomainAllowlist']> {
    return this.legacyAdminService.getDomainAllowlist(...args);
  }

  getDomainAllowlistDetails(
    ...args: Parameters<AdminService['getDomainAllowlistDetails']>
  ): ReturnType<AdminService['getDomainAllowlistDetails']> {
    return this.legacyAdminService.getDomainAllowlistDetails(...args);
  }

  removeDomain(
    ...args: Parameters<AdminService['removeDomain']>
  ): ReturnType<AdminService['removeDomain']> {
    return this.legacyAdminService.removeDomain(...args);
  }

  scheduleDomainRemoval(
    ...args: Parameters<AdminService['scheduleDomainRemoval']>
  ): ReturnType<AdminService['scheduleDomainRemoval']> {
    return this.legacyAdminService.scheduleDomainRemoval(...args);
  }

  processManualModerationFanoutJob(
    ...args: Parameters<AdminService['processManualModerationFanoutJob']>
  ): ReturnType<AdminService['processManualModerationFanoutJob']> {
    return this.legacyAdminService.processManualModerationFanoutJob(...args);
  }
}
