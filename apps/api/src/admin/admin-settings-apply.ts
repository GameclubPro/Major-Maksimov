import {
  assertFixedModeratorCapabilitiesForSettings,
  chatSettingsCapabilityPurposes,
} from '../max/fixed-moderator-capabilities';
import { TRAFFIC_PROTECTION_SETTINGS_KEYS } from '../moderation/traffic-protection';
import {
  applySectionTargetPreviewRequestSchema,
  applySectionTargetPreviewResponseSchema,
  applySectionToAllRequestSchema,
  applySectionToAllResponseSchema,
  settingsApplyPartialErrorSchema,
  updateSettingsRequestSchema,
  reportSettingsSchema,
  addReportCommandIssues,
  type ApplySectionTargetPreviewResponse,
  type ApplySectionToAllResponse,
  type ApplySettingsTarget,
  type ChatSettings,
  type ReportSettings,
  type ChatSummary,
  type SettingsApplyPartialError,
  stopWordsPolicySchema,
} from '@maxim/contracts';
import { BadRequestException, ConflictException, HttpException } from '@nestjs/common';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import { ChatCatalogKind, ChatEntityType } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { mapWithConcurrencyLimit } from './admin-legacy-utils';
import type { ChatSettingsReadSnapshot, ResolvedBotAssignmentData } from './admin-chat-settings';
import {
  APPLY_SECTION_TARGET_PREVIEW_SAMPLE_LIMIT,
  APPLY_SETTINGS_TO_ALL_CHATS_CONCURRENCY,
  DEFAULT_CHAT_SETTINGS,
  SETTINGS_SECTION_BOT_SPEECH_MEDIA_KEYS,
  REQUIRED_SUBSCRIPTION_SETTING_KEYS,
  SETTINGS_SECTION_KEYS,
  type AdminActionSource,
  type ApplySettingsToAllChatsResult,
} from './admin.service.support';
import {
  DEFAULT_PUBLISHER_OWNED_CHAT_SETTINGS,
  omitPublisherOwnedChatSettings,
} from './publisher-owned-chat-settings';
import {
  CHAT_SETTINGS_BOT_CAPABILITY_SELECT,
  resolveChatSettingsBotCapabilityRequirements,
  type ChatSettingsBotCapabilityRequirement,
} from './chat-settings-bot-capability';
import { BotCapabilityRequiredException } from './bot-capability-required.error';
import {
  assertLegacyStopWordsWrite,
  LEGACY_STOP_WORD_SETTING_KEYS,
  omitStopWordsPolicy,
  omitLegacyStopWordsSettings,
} from './stop-words-settings-ownership';
import { stopWordsPolicyStorage } from '../moderation/stop-words/stop-words.policy';
import { assertReportsActivationAvailable } from './report-settings-availability';
import { assertStopWordsStorageEditable } from './stop-words-storage-boundary';

const REPORT_SETTINGS_KEYS = Object.keys(reportSettingsSchema.shape) as Array<keyof ReportSettings>;
const REPORT_COMMAND_SELECT = Object.fromEntries(
  Object.keys(DEFAULT_CHAT_SETTINGS)
    .filter((key) => /^admin.*Command(Name|Aliases)$/.test(key))
    .map((key) => [key, true]),
) as Partial<Record<keyof ChatSettings, true>>;

function assertReportPolicyForTarget(
  chatId: string,
  current: ChatSettings | null,
  next: ChatSettings,
  available: boolean,
): void {
  assertReportsActivationAvailable(current, next, available);
  const checked = reportSettingsSchema
    .superRefine((policy, ctx) => addReportCommandIssues({ ...next, ...policy }, ctx))
    .safeParse(next);
  if (!checked.success) {
    throw new BadRequestException({
      code: 'REPORTS_COMMAND_CONFLICT',
      message: 'Команды системы жалоб совпадают с командами администратора в выбранном чате.',
      chatId,
      errors: checked.error.format(),
    });
  }
}

type SettingsApplyReadinessRefresh = {
  chatIds: readonly string[];
  skipManagedEntityBotRefreshChatIds?: readonly string[];
  shouldRefreshRequiredSubscription: boolean;
  requiredSubscriptionChannelIds: readonly string[];
};

function hasOwnSetting(value: unknown, key: keyof ChatSettings): boolean {
  return Boolean(
    value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key),
  );
}

function mergeBotSpeechMediaForKeys(
  current: ChatSettings['botSpeechMedia'] | undefined,
  source: ChatSettings['botSpeechMedia'],
  keys: readonly string[],
): ChatSettings['botSpeechMedia'] {
  if (keys.length === 0) {
    return current ?? {};
  }

  const next = { ...(current ?? {}) };
  for (const key of keys) {
    const sourceImage = source[key as keyof typeof source];
    if (sourceImage && sourceImage.base64.trim()) {
      next[key as keyof typeof next] = sourceImage;
    } else {
      delete next[key as keyof typeof next];
    }
  }
  return next;
}

export async function previewApplySettingsSectionTarget(params: {
  sourceChatId: string;
  body: unknown;
  resolveTargetChats: (target: ApplySettingsTarget) => Promise<ChatSummary[]>;
}): Promise<ApplySectionTargetPreviewResponse> {
  const parsed = applySectionTargetPreviewRequestSchema.safeParse(params.body);
  if (!parsed.success) {
    throw new BadRequestException(parsed.error.format());
  }

  const target = parsed.data.target;
  const targetChats = await params.resolveTargetChats(target);

  return applySectionTargetPreviewResponseSchema.parse({
    sourceChatId: params.sourceChatId,
    targetMode: target.mode,
    favoriteTypes: target.favoriteTypes,
    updatedChats: targetChats.length,
    appliedChatIds: targetChats.map((chat) => chat.id),
    sampleChats: targetChats.slice(0, APPLY_SECTION_TARGET_PREVIEW_SAMPLE_LIMIT),
  });
}

export async function applySettingsToAllChats(params: {
  prisma: PrismaService;
  chatContextCache: Pick<ChatContextCacheService, 'invalidate'>;
  sourceChatId: string;
  actorUserId: string;
  body: unknown;
  source: AdminActionSource;
  targetOrSettingKeys?: ApplySettingsTarget | readonly (keyof ChatSettings)[];
  settingKeys?: readonly (keyof ChatSettings)[];
  confirmedTargetChatIds?: readonly string[];
  expectedSourceSettingsRevision?: string;
  normalizeSettings: (settings: ChatSettings) => ChatSettings;
  resolveTargetChats: (target: ApplySettingsTarget) => Promise<ChatSummary[]>;
  resolveBotAssignmentData: (
    chatId: string,
  ) => Promise<ResolvedBotAssignmentData> | ResolvedBotAssignmentData;
  assertRequiredSubscriptionSettings: (settings: ChatSettings) => Promise<ChatSettings | void>;
  reportsAvailable?: (chatId: string) => boolean;
  commercialAiDeleteOnly?: boolean;
  assertBotCapabilities: (
    chatId: string,
    requirements: readonly ChatSettingsBotCapabilityRequirement[],
  ) => Promise<void>;
  recordConcurrentWriteConflict: (params: {
    sourceChatId: string;
    conflictChatId: string | null;
    appliedCount: number;
    appliedChatIds: readonly string[];
  }) => void;
  onPartialApplied: (chatIds: readonly string[]) => Promise<void>;
  isRequiredSubscriptionCurrentlyActive: (settings: ChatSettings) => boolean;
  scheduleReadinessRefresh: (params: SettingsApplyReadinessRefresh) => void;
  getCurrentSourceSettings?: () => Promise<Pick<
    ChatSettings,
    | 'profanitySensitivity'
    | 'forwardedMessagesEnabled'
    | 'messageLimitsImageTextScanEnabled'
    | (typeof TRAFFIC_PROTECTION_SETTINGS_KEYS)[number]
    | keyof ReportSettings
  > | null>;
  botSpeechMediaKeys?: readonly string[];
}): Promise<ApplySettingsToAllChatsResult> {
  const parsed = updateSettingsRequestSchema.safeParse(params.body);
  if (!parsed.success) {
    throw new BadRequestException(parsed.error.format());
  }
  const hasOwnProfanitySensitivity = hasOwnSetting(params.body, 'profanitySensitivity');
  const omittedTrafficKeys = TRAFFIC_PROTECTION_SETTINGS_KEYS.filter(
    (key) => !hasOwnSetting(params.body, key),
  );
  // FLAG: Legacy clients must not reset report policies through defaults during bulk apply.
  const omittedReportKeys = REPORT_SETTINGS_KEYS.filter((key) => !hasOwnSetting(params.body, key));
  const hasOwnForwardedMessagesEnabled = hasOwnSetting(params.body, 'forwardedMessagesEnabled');
  const hasOwnMessageLimitsImageTextScanEnabled = hasOwnSetting(
    params.body,
    'messageLimitsImageTextScanEnabled',
  );
  const currentSourceSettings =
    (!hasOwnProfanitySensitivity ||
      !hasOwnForwardedMessagesEnabled ||
      !hasOwnMessageLimitsImageTextScanEnabled ||
      omittedTrafficKeys.length > 0 ||
      omittedReportKeys.length > 0) &&
    params.getCurrentSourceSettings
      ? await params.getCurrentSourceSettings()
      : null;
  const parsedSettings = currentSourceSettings
    ? {
        ...parsed.data,
        ...Object.fromEntries(omittedTrafficKeys.map((key) => [key, currentSourceSettings[key]])),
        ...Object.fromEntries(omittedReportKeys.map((key) => [key, currentSourceSettings[key]])),
        ...(!hasOwnProfanitySensitivity
          ? { profanitySensitivity: currentSourceSettings.profanitySensitivity }
          : {}),
        ...(!hasOwnForwardedMessagesEnabled
          ? { forwardedMessagesEnabled: currentSourceSettings.forwardedMessagesEnabled }
          : {}),
        ...(!hasOwnMessageLimitsImageTextScanEnabled
          ? {
              messageLimitsImageTextScanEnabled:
                currentSourceSettings.messageLimitsImageTextScanEnabled,
            }
          : {}),
      }
    : parsed.data;
  let normalizedSettings = params.normalizeSettings(parsedSettings);

  const targetOrSettingKeys = params.targetOrSettingKeys ?? {
    mode: 'all' as const,
    favoriteTypes: [],
    chatIds: [],
  };
  const usesLegacySettingKeys = Array.isArray(targetOrSettingKeys);
  const target: ApplySettingsTarget = usesLegacySettingKeys
    ? { mode: 'all' as const, favoriteTypes: [], chatIds: [] }
    : (targetOrSettingKeys as ApplySettingsTarget);
  const effectiveSettingKeys = usesLegacySettingKeys
    ? (targetOrSettingKeys as readonly (keyof ChatSettings)[])
    : params.settingKeys;
  const targetChats = await params.resolveTargetChats(target);
  if (targetChats.length === 0) {
    throw new BadRequestException('Нет доступных чатов для применения настроек.');
  }
  const appliedChatIds = targetChats.map((chat) => chat.id);
  if (params.confirmedTargetChatIds) {
    const confirmed = new Set(params.confirmedTargetChatIds);
    if (
      confirmed.size !== appliedChatIds.length ||
      appliedChatIds.some((chatId) => !confirmed.has(chatId))
    ) {
      throw new ConflictException({
        code: 'CHAT_SETTINGS_TARGETS_CHANGED',
        message: 'Список доступных чатов изменился. Проверьте и подтвердите выбор заново.',
        partialApplied: false,
        appliedCount: 0,
        appliedChatIds: [],
      });
    }
  }
  const filteredSettingKeys = Array.isArray(effectiveSettingKeys)
    ? Array.from(new Set(effectiveSettingKeys)).filter(
        (key): key is keyof ChatSettings => typeof key === 'string' && key in normalizedSettings,
      )
    : [];
  const shouldApplyBotSpeechMedia =
    filteredSettingKeys.length === 0 || filteredSettingKeys.includes('botSpeechMedia');
  const botSpeechMediaKeys =
    shouldApplyBotSpeechMedia && Array.isArray(params.botSpeechMediaKeys)
      ? params.botSpeechMediaKeys
      : [];
  const shouldValidateRequiredSubscription =
    filteredSettingKeys.length === 0 ||
    filteredSettingKeys.some((key) =>
      REQUIRED_SUBSCRIPTION_SETTING_KEYS.includes(
        key as (typeof REQUIRED_SUBSCRIPTION_SETTING_KEYS)[number],
      ),
    );
  if (shouldValidateRequiredSubscription) {
    normalizedSettings =
      (await params.assertRequiredSubscriptionSettings(normalizedSettings)) ?? normalizedSettings;
  }
  const settingsUpdatePayload: Partial<ChatSettings> =
    filteredSettingKeys.length > 0
      ? filteredSettingKeys.reduce<Partial<ChatSettings>>((acc, key) => {
          (acc as Record<keyof ChatSettings, ChatSettings[keyof ChatSettings]>)[key] =
            normalizedSettings[key];
          return acc;
        }, {})
      : normalizedSettings;
  const settingsCreatePayload =
    filteredSettingKeys.length > 0
      ? {
          ...DEFAULT_CHAT_SETTINGS,
          ...settingsUpdatePayload,
        }
      : normalizedSettings;
  // FLAG: Major bulk UPDATE payloads omit Publisher-owned comment fields entirely.
  const copiedStopWordsPolicy = settingsUpdatePayload.stopWordsPolicy;
  const legacySettingsUpdatePayload = omitStopWordsPolicy(
    omitPublisherOwnedChatSettings(settingsUpdatePayload),
  );
  const majorSettingsUpdatePayload = omitLegacyStopWordsSettings(legacySettingsUpdatePayload);
  delete majorSettingsUpdatePayload.settingsRevision;
  const requestedLegacySettings = Object.fromEntries(
    LEGACY_STOP_WORD_SETTING_KEYS.filter(
      (key) => Object.hasOwn(legacySettingsUpdatePayload, key) && hasOwnSetting(params.body, key),
    ).map((key) => [key, (params.body as Record<string, unknown>)[key]]),
  );
  const majorSettingsCreatePayload = {
    ...omitLegacyStopWordsSettings(
      omitStopWordsPolicy(omitPublisherOwnedChatSettings(settingsCreatePayload)),
    ),
    ...DEFAULT_PUBLISHER_OWNED_CHAT_SETTINGS,
  };
  delete majorSettingsCreatePayload.settingsRevision;

  const requiresReportPolicyValidation = Object.keys(majorSettingsUpdatePayload).some(
    (key) => key.startsWith('reports') || /^admin.*Command/.test(key),
  );

  const capabilityRelevantUpdate =
    Boolean(copiedStopWordsPolicy?.enabled) ||
    Object.keys(majorSettingsUpdatePayload).some(
      (key) =>
        Object.hasOwn(CHAT_SETTINGS_BOT_CAPABILITY_SELECT, key) ||
        key === 'requiredSubscriptionChannelIds',
    );
  const capabilityPreflightConfirmedChatIds = new Set<string>();
  const requiredPurposesByChatId = new Map<
    string,
    ReturnType<typeof chatSettingsCapabilityPurposes>
  >();
  let writeBaselineByChatId = new Map<string, Date>();
  if (capabilityRelevantUpdate || requiresReportPolicyValidation) {
    const currentRows = await params.prisma.chatSettings.findMany({
      where: { chatId: { in: appliedChatIds } },
      select: {
        chatId: true,
        updatedAt: true,
        ...CHAT_SETTINGS_BOT_CAPABILITY_SELECT,
        ...(requiresReportPolicyValidation ? REPORT_COMMAND_SELECT : {}),
      },
    });
    const currentByChatId = new Map(currentRows.map((row) => [row.chatId, row]));
    const targetByChatId = new Map(targetChats.map((chat) => [chat.id, chat]));
    let firstPreflightError: unknown = null;
    await mapWithConcurrencyLimit(
      appliedChatIds,
      APPLY_SETTINGS_TO_ALL_CHATS_CONCURRENCY,
      async (chatId) => {
        if (firstPreflightError) {
          return;
        }
        const current = {
          ...DEFAULT_CHAT_SETTINGS,
          ...(currentByChatId.get(chatId) ?? {}),
        } as ChatSettings;
        const next = { ...current, ...majorSettingsUpdatePayload } as ChatSettings;
        if (requiresReportPolicyValidation) {
          assertReportPolicyForTarget(
            chatId,
            current,
            next,
            params.reportsAvailable?.(chatId) ?? false,
          );
        }
        const requirements = resolveChatSettingsBotCapabilityRequirements({
          commercialAiDeleteOnly: params.commercialAiDeleteOnly,
          current,
          next,
          requestedSettings: majorSettingsUpdatePayload,
        });
        if (copiedStopWordsPolicy?.enabled) {
          requirements.push({ permission: 'write', featureKeys: ['stopWordsPolicy'] });
          if (
            copiedStopWordsPolicy.sanctions.muteEnabled ||
            copiedStopWordsPolicy.sanctions.banEnabled
          ) {
            requirements.push({
              permission: 'add_remove_members',
              featureKeys: ['stopWordsPolicy'],
            });
          }
        }
        requiredPurposesByChatId.set(chatId, chatSettingsCapabilityPurposes(requirements));
        if (requirements.length > 0) {
          try {
            await params.assertBotCapabilities(chatId, requirements);
            capabilityPreflightConfirmedChatIds.add(chatId);
          } catch (error: unknown) {
            if (!firstPreflightError) {
              const targetChat = targetByChatId.get(chatId);
              firstPreflightError =
                error instanceof BotCapabilityRequiredException && targetChat
                  ? new BotCapabilityRequiredException({
                      missingPermissions: error.missingPermissions,
                      featureKeys: error.featureKeys,
                      checkedAt: error.checkedAt,
                      blockerCode: error.blockerCode,
                      stale: error.stale,
                      canRecheck: error.canRecheck,
                      affectedEntities: [{ id: targetChat.id, title: targetChat.title }],
                    })
                  : error;
            }
          }
        }
      },
    );
    if (firstPreflightError) {
      throw firstPreflightError;
    }
    const refreshedRows = await params.prisma.chatSettings.findMany({
      where: { chatId: { in: appliedChatIds } },
      select: { chatId: true, updatedAt: true },
    });
    const initialRevisionByChatId = new Map(currentRows.map((row) => [row.chatId, row.updatedAt]));
    writeBaselineByChatId = new Map(refreshedRows.map((row) => [row.chatId, row.updatedAt]));
    if (
      appliedChatIds.some(
        (chatId) =>
          initialRevisionByChatId.get(chatId)?.getTime() !==
          writeBaselineByChatId.get(chatId)?.getTime(),
      )
    ) {
      params.recordConcurrentWriteConflict({
        sourceChatId: params.sourceChatId,
        conflictChatId: null,
        appliedCount: 0,
        appliedChatIds: [],
      });
      throw settingsApplyRevisionConflict(undefined, []);
    }
  } else {
    const currentRows = await params.prisma.chatSettings.findMany({
      where: { chatId: { in: appliedChatIds } },
      select: { chatId: true, updatedAt: true },
    });
    writeBaselineByChatId = new Map(currentRows.map((row) => [row.chatId, row.updatedAt]));
  }

  const successfullyAppliedChatIds = new Set<string>();
  if (params.expectedSourceSettingsRevision !== undefined) {
    // FLAG: Remote preflight may outlive another administrator's edit. Recheck the source before
    // the first target write while keeping the already confirmed policy snapshot immutable.
    const source = await params.prisma.chatSettings.findUnique({
      where: { chatId: params.sourceChatId },
      select: { updatedAt: true },
    });
    if (source?.updatedAt?.toISOString() !== params.expectedSourceSettingsRevision) {
      throw settingsApplyRevisionConflict(params.sourceChatId, []);
    }
    const sourceTargetBaseline = writeBaselineByChatId.get(params.sourceChatId);
    if (
      appliedChatIds.includes(params.sourceChatId) &&
      sourceTargetBaseline?.toISOString() !== params.expectedSourceSettingsRevision
    ) {
      throw settingsApplyRevisionConflict(params.sourceChatId, []);
    }
  }
  const outcomesByChatId = new Map<string, SettingsApplyPartialError['outcomes'][number]>();
  let sourceSettingsRevision = params.expectedSourceSettingsRevision;
  let firstWriteError: unknown = null;
  let firstFailure: ReturnType<typeof describeSettingsApplyFailure> | null = null;
  let conflictChatId: string | null = null;
  await mapWithConcurrencyLimit(
    appliedChatIds,
    APPLY_SETTINGS_TO_ALL_CHATS_CONCURRENCY,
    async (chatId) => {
      if (firstWriteError) {
        return;
      }
      try {
        const botAssignmentData = await params.resolveBotAssignmentData(chatId);
        if (!copiedStopWordsPolicy && Object.keys(requestedLegacySettings).length > 0) {
          const stopWordsCurrent = await params.prisma.chatSettings.findUnique({
            where: { chatId },
            select: {
              stopWordsPolicy: true,
              messageLimitsBlockedWords: true,
              messageLimitsBlockedDomains: true,
              messageLimitsImageTextScanEnabled: true,
            },
          });
          assertLegacyStopWordsWrite(stopWordsCurrent ?? {}, requestedLegacySettings);
        }
        const currentTargetSettings =
          shouldApplyBotSpeechMedia && botSpeechMediaKeys.length > 0
            ? await params.prisma.chatSettings.findUnique({
                where: { chatId },
                select: { botSpeechMedia: true },
              })
            : null;
        const scopedBotSpeechMedia =
          shouldApplyBotSpeechMedia && botSpeechMediaKeys.length > 0
            ? mergeBotSpeechMediaForKeys(
                currentTargetSettings?.botSpeechMedia as ChatSettings['botSpeechMedia'] | undefined,
                normalizedSettings.botSpeechMedia,
                botSpeechMediaKeys,
              )
            : normalizedSettings.botSpeechMedia;
        const updatePayloadForChat = {
          ...majorSettingsUpdatePayload,
          ...(copiedStopWordsPolicy
            ? {
                ...stopWordsPolicyStorage(copiedStopWordsPolicy),
                stopWordsRevision: { increment: 1 },
              }
            : {}),
          ...(shouldApplyBotSpeechMedia && botSpeechMediaKeys.length > 0
            ? { botSpeechMedia: scopedBotSpeechMedia }
            : {}),
        };
        const createPayloadForChat = {
          ...majorSettingsCreatePayload,
          ...(copiedStopWordsPolicy
            ? { ...stopWordsPolicyStorage(copiedStopWordsPolicy), stopWordsRevision: 1 }
            : {}),
          ...(shouldApplyBotSpeechMedia && botSpeechMediaKeys.length > 0
            ? { botSpeechMedia: scopedBotSpeechMedia }
            : {}),
        };
        let committedSourceRevision: string | undefined;
        try {
          committedSourceRevision = await params.prisma.$transaction(async (tx) => {
            if (requiresReportPolicyValidation) {
              const current = await tx.chatSettings.findUnique({ where: { chatId } });
              const merged = {
                ...DEFAULT_CHAT_SETTINGS,
                ...current,
                ...majorSettingsUpdatePayload,
              };
              assertReportPolicyForTarget(
                chatId,
                current as ChatSettings | null,
                merged as ChatSettings,
                params.reportsAvailable?.(chatId) ?? false,
              );
            }
            const lockedChat = await tx.chat.upsert({
              where: { id: chatId },
              create: {
                id: chatId,
                title: `Chat ${chatId}`,
                entityType: ChatEntityType.CHAT,
                catalogKind: ChatCatalogKind.MANAGED,
                ...botAssignmentData,
              },
              update: { catalogKind: ChatCatalogKind.MANAGED },
            });
            await assertFixedModeratorCapabilitiesForSettings(
              tx,
              lockedChat,
              requiredPurposesByChatId.get(chatId) ?? [],
            );
            const baselineUpdatedAt = writeBaselineByChatId.get(chatId);
            if (baselineUpdatedAt) {
              const changed = await tx.chatSettings.updateMany({
                where: {
                  chatId,
                  updatedAt: baselineUpdatedAt,
                  ...(copiedStopWordsPolicy && chatId === params.sourceChatId
                    ? { stopWordsRevision: normalizedSettings.stopWordsRevision ?? 0 }
                    : {}),
                },
                data: updatePayloadForChat,
              });
              if (changed.count !== 1) {
                throw settingsApplyRevisionConflict(chatId, []);
              }
            } else {
              await tx.chatSettings.create({
                data: { chatId, ...createPayloadForChat },
              });
            }
            await tx.auditLog.create({
              data: {
                chatId,
                actorUserId: params.actorUserId,
                action: 'APPLY_SETTINGS_TO_ALL_CHATS',
                payload: {
                  sourceChatId: params.sourceChatId,
                  targetChatId: chatId,
                  source: params.source,
                  targetMode: target.mode,
                  ...(target.favoriteTypes.length > 0
                    ? { favoriteTypes: target.favoriteTypes }
                    : {}),
                  ...(filteredSettingKeys.length > 0 ? { settingKeys: filteredSettingKeys } : {}),
                },
              },
            });
            if (
              params.expectedSourceSettingsRevision !== undefined &&
              chatId === params.sourceChatId
            ) {
              // FLAG: Return only our own source commit's fence; a later read could borrow another
              // administrator's revision for the policy snapshot confirmed by this operation.
              const writtenSource = await tx.chatSettings.findUnique({
                where: { chatId },
                select: { updatedAt: true },
              });
              return writtenSource?.updatedAt?.toISOString();
            }
            return undefined;
          });
        } catch (error: unknown) {
          if ((error as { code?: unknown })?.code === 'P2002') {
            throw settingsApplyRevisionConflict(chatId, []);
          }
          throw error;
        }
        successfullyAppliedChatIds.add(chatId);
        if (committedSourceRevision !== undefined) sourceSettingsRevision = committedSourceRevision;
        outcomesByChatId.set(chatId, { chatId, status: 'APPLIED' });
        await params.chatContextCache.invalidate(chatId);
      } catch (error: unknown) {
        const applied = successfullyAppliedChatIds.has(chatId);
        const failure = describeSettingsApplyFailure(error, applied);
        outcomesByChatId.set(chatId, {
          chatId,
          status: applied ? 'APPLIED' : 'FAILED',
          reasonCode: failure.code,
          message: failure.message,
        });
        if (!firstWriteError) {
          firstWriteError = error;
          firstFailure = failure;
          if (
            error instanceof ConflictException &&
            (error.getResponse() as { code?: unknown })?.code === 'CHAT_SETTINGS_CONCURRENT_UPDATE'
          ) {
            conflictChatId = chatId;
          }
        }
      }
    },
  );

  if (firstWriteError) {
    const partialAppliedChatIds = appliedChatIds.filter((chatId) =>
      successfullyAppliedChatIds.has(chatId),
    );
    if (partialAppliedChatIds.length > 0) {
      try {
        params.scheduleReadinessRefresh({
          chatIds: partialAppliedChatIds,
          ...(capabilityPreflightConfirmedChatIds.size > 0
            ? {
                skipManagedEntityBotRefreshChatIds: partialAppliedChatIds.filter((chatId) =>
                  capabilityPreflightConfirmedChatIds.has(chatId),
                ),
              }
            : {}),
          shouldRefreshRequiredSubscription:
            shouldValidateRequiredSubscription &&
            params.isRequiredSubscriptionCurrentlyActive(normalizedSettings),
          requiredSubscriptionChannelIds: normalizedSettings.requiredSubscriptionChannelIds,
        });
        await params.onPartialApplied(partialAppliedChatIds);
      } catch {
        // FLAG: Follow-up failure cannot erase the exact commits already observed above.
      }
    }
    if (
      firstWriteError instanceof ConflictException &&
      (firstWriteError.getResponse() as { code?: unknown })?.code ===
        'CHAT_SETTINGS_CONCURRENT_UPDATE'
    ) {
      params.recordConcurrentWriteConflict({
        sourceChatId: params.sourceChatId,
        conflictChatId,
        appliedCount: partialAppliedChatIds.length,
        appliedChatIds: partialAppliedChatIds.slice(0, 20),
      });
      if (partialAppliedChatIds.length === 0) {
        throw settingsApplyRevisionConflict(conflictChatId ?? undefined, []);
      }
    }
    if (partialAppliedChatIds.length > 0) {
      throw settingsApplyPartialFailure({
        sourceChatId: params.sourceChatId,
        sourceSettingsRevision,
        targetChatIds: appliedChatIds,
        appliedChatIds: partialAppliedChatIds,
        outcomesByChatId,
        failure: firstFailure!,
        conflictChatId,
      });
    }
    throw firstWriteError;
  }

  try {
    params.scheduleReadinessRefresh({
      chatIds: appliedChatIds,
      ...(capabilityPreflightConfirmedChatIds.size > 0
        ? {
            skipManagedEntityBotRefreshChatIds: appliedChatIds.filter((chatId) =>
              capabilityPreflightConfirmedChatIds.has(chatId),
            ),
          }
        : {}),
      shouldRefreshRequiredSubscription:
        shouldValidateRequiredSubscription &&
        params.isRequiredSubscriptionCurrentlyActive(normalizedSettings),
      requiredSubscriptionChannelIds: normalizedSettings.requiredSubscriptionChannelIds,
    });
  } catch (error) {
    throw settingsApplyPartialFailure({
      sourceChatId: params.sourceChatId,
      sourceSettingsRevision,
      targetChatIds: appliedChatIds,
      appliedChatIds,
      outcomesByChatId,
      failure: describeSettingsApplyFailure(error, true),
      conflictChatId: null,
    });
  }

  return {
    sourceChatId: params.sourceChatId,
    updatedChats: appliedChatIds.length,
    appliedChatIds,
    ...(sourceSettingsRevision !== undefined ? { sourceSettingsRevision } : {}),
  };
}

function describeSettingsApplyFailure(
  error: unknown,
  afterCommit = false,
): { code: SettingsApplyPartialError['causeCode']; message: string } {
  if (afterCommit) {
    return {
      code: 'POST_COMMIT_REFRESH_FAILED',
      message: 'Настройки сохранены, но обновление состояния не завершено.',
    };
  }
  const response = error instanceof HttpException ? error.getResponse() : null;
  const code =
    response && typeof response === 'object' && 'code' in response ? response.code : null;
  switch (code) {
    case 'REPORTS_COMMAND_CONFLICT':
      return { code, message: 'Команда системы жалоб совпадает с командой администратора.' };
    case 'REPORTS_UNAVAILABLE':
      return { code, message: 'Приём жалоб приостановлен; включение недоступно.' };
    case 'CHAT_SETTINGS_CONCURRENT_UPDATE':
      return { code, message: 'Настройки этого чата изменены другим администратором.' };
  }
  if (error instanceof BotCapabilityRequiredException) {
    return { code: 'BOT_CAPABILITY_REQUIRED', message: 'Боту не хватает прав в этом чате.' };
  }
  return { code: 'SETTINGS_WRITE_FAILED', message: 'Не удалось сохранить настройки этого чата.' };
}

function settingsApplyPartialFailure(params: {
  sourceChatId: string;
  sourceSettingsRevision?: string;
  targetChatIds: readonly string[];
  appliedChatIds: readonly string[];
  outcomesByChatId: ReadonlyMap<string, SettingsApplyPartialError['outcomes'][number]>;
  failure: ReturnType<typeof describeSettingsApplyFailure>;
  conflictChatId: string | null;
}): ConflictException {
  const applied = new Set(params.appliedChatIds);
  const unchangedChatIds = params.targetChatIds.filter((id) => !applied.has(id));
  const outcomes = params.targetChatIds.map(
    (chatId): SettingsApplyPartialError['outcomes'][number] =>
      params.outcomesByChatId.get(chatId) ?? {
        chatId,
        status: 'NOT_ATTEMPTED',
        reasonCode: 'STOPPED_AFTER_FAILURE',
        message: 'Применение остановлено после ошибки в другом чате.',
      },
  );
  // FLAG: All counts describe completed transactions; bounded samples never stand for the full retry set.
  const orderedOutcomes = [...outcomes].sort(
    (a, b) => Number(b.status !== 'APPLIED') - Number(a.status !== 'APPLIED'),
  );
  return new ConflictException(
    settingsApplyPartialErrorSchema.parse({
      code:
        params.failure.code === 'CHAT_SETTINGS_CONCURRENT_UPDATE'
          ? 'CHAT_SETTINGS_CONCURRENT_UPDATE'
          : 'SETTINGS_APPLY_PARTIAL',
      message:
        unchangedChatIds.length > 0
          ? 'Настройки применены частично. Проверьте результат и выберите чаты заново.'
          : 'Настройки сохранены во всех чатах, но обновление состояния не завершено.',
      partialApplied: true,
      sourceChatId: params.sourceChatId,
      ...(params.sourceSettingsRevision !== undefined
        ? { sourceSettingsRevision: params.sourceSettingsRevision }
        : {}),
      targetCount: params.targetChatIds.length,
      appliedCount: params.appliedChatIds.length,
      unchangedCount: unchangedChatIds.length,
      failedCount: outcomes.filter((item) => item.status === 'FAILED').length,
      notAttemptedCount: outcomes.filter((item) => item.status === 'NOT_ATTEMPTED').length,
      appliedChatIds: params.appliedChatIds.slice(0, 20),
      unchangedChatIds: unchangedChatIds.slice(0, 20),
      outcomes: orderedOutcomes.slice(0, 20),
      outcomesTruncated: outcomes.length > 20,
      causeCode: params.failure.code,
      causeMessage: params.failure.message,
      ...(params.conflictChatId ? { chatId: params.conflictChatId } : {}),
    }),
  );
}

function settingsApplyRevisionConflict(
  chatId: string | undefined,
  appliedChatIds: readonly string[],
): ConflictException {
  const boundedAppliedChatIds = appliedChatIds.slice(0, 20);
  return new ConflictException({
    code: 'CHAT_SETTINGS_CONCURRENT_UPDATE',
    message: 'Настройки чатов изменились параллельно. Обновите экран и повторите попытку.',
    ...(chatId ? { chatId } : {}),
    partialApplied: appliedChatIds.length > 0,
    appliedCount: appliedChatIds.length,
    appliedChatIds: boundedAppliedChatIds,
  });
}

export async function applySettingsSectionToAllChats(params: {
  sourceChatId: string;
  body: unknown;
  source: AdminActionSource;
  getSourceSettings: () => Promise<ChatSettings>;
  getSourceStopWordsSettings?: () => Promise<ChatSettingsReadSnapshot>;
  applySettings: (
    settings: ChatSettings,
    target: ApplySettingsTarget,
    settingKeys: readonly (keyof ChatSettings)[],
    botSpeechMediaKeys?: readonly string[],
    confirmedTargetChatIds?: readonly string[],
    expectedSourceSettingsRevision?: string,
  ) => Promise<ApplySettingsToAllChatsResult>;
  syncDomainAllowlistToChats: (targetChatIds: readonly string[]) => Promise<void>;
}): Promise<ApplySectionToAllResponse> {
  const parsed = applySectionToAllRequestSchema.safeParse(params.body);
  if (!parsed.success) {
    throw new BadRequestException(parsed.error.format());
  }
  const section = parsed.data.section;

  // FLAG: A disabled presentation of invalid storage cannot become a copied policy. The
  // source policy, validity and revision must come from one snapshot, including legacy conversion.
  const stopWordsSource =
    section === 'stopWords' ? await params.getSourceStopWordsSettings?.() : undefined;
  if (section === 'stopWords') {
    assertStopWordsStorageEditable({
      revision:
        stopWordsSource?.settings.stopWordsRevision ?? parsed.data.expectedSourceRevision ?? 0,
      storageStatus: stopWordsPolicySchema.safeParse(stopWordsSource?.settings.stopWordsPolicy)
        .success
        ? stopWordsSource?.stopWordsStorageStatus
        : undefined,
    });
  }
  const sourceSettings = stopWordsSource?.settings ?? (await params.getSourceSettings());
  if (
    section === 'stopWords' &&
    (sourceSettings.stopWordsRevision ?? 0) !== parsed.data.expectedSourceRevision
  ) {
    throw settingsApplyRevisionConflict(params.sourceChatId, []);
  }
  if (
    section === 'reports' &&
    sourceSettings.settingsRevision !== parsed.data.expectedSourceSettingsRevision
  ) {
    throw settingsApplyRevisionConflict(params.sourceChatId, []);
  }
  const result = await params.applySettings(
    sourceSettings,
    parsed.data.target,
    [
      ...SETTINGS_SECTION_KEYS[section],
      ...(SETTINGS_SECTION_BOT_SPEECH_MEDIA_KEYS[section].length > 0
        ? ['botSpeechMedia' as const]
        : []),
    ],
    SETTINGS_SECTION_BOT_SPEECH_MEDIA_KEYS[section],
    parsed.data.confirmedTargetChatIds,
    section === 'reports' ? parsed.data.expectedSourceSettingsRevision : undefined,
  );

  if (section === 'links') {
    await params.syncDomainAllowlistToChats(result.appliedChatIds);
  }

  return applySectionToAllResponseSchema.parse({
    section,
    targetMode: parsed.data.target.mode,
    favoriteTypes: parsed.data.target.favoriteTypes,
    ...result,
  });
}
