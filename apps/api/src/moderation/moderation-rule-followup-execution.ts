import {
  withMarketplaceModerationMessage,
  marketplaceModuleForRule,
} from '../max/marketplace-publication-button';
import { EventType, Operator, SanctionAction } from '../prisma/prisma-client';
import type { MaxSendMessageOptions } from '../max/max-client.service';
import type { BotSpeechMediaFieldKey } from '@maxim/contracts/bot-speech';
import type { ModerationService } from './moderation.service';
import type { RuleFollowupExecutionContext } from './moderation-rule-followup.contract';
import {
  createModerationSanctionCallbacks,
  createCommercialNoticeDispatchOptions,
} from './moderation-execution-guard-callbacks';
import {
  createStopWordsSanctionGuard,
  verifyStopWordsSanction,
} from './stop-words/stop-words.execution';
import { extractMessageLimitsBlockedToken } from './message-limits-blocked-reason.util';
import { persistModerationDecisionWithoutAppliedSanction } from './moderation-sanction-event.util';
import {
  PROFANITY_AUTOMATIC_ESCALATION_MIN_SCORE,
  TEXT_FILTER_ESCALATION_WINDOW_HOURS,
  MESSAGE_LIMITS_ESCALATION_WINDOW_HOURS,
} from './moderation.service.support';

// FLAG: This focused executor continues only the saved rule. It never evaluates the engine,
// updates rate/duplicate history, creates DELETEs or reissues the original source deadline.
export async function executeModerationRuleFollowUp(
  host: ReturnType<ModerationService['getRuleFollowupHost']>,
  context: RuleFollowupExecutionContext,
): Promise<void> {
  const {
    chatId,
    senderId,
    messageId,
    topViolation,
    settings,
    updateType,
    maskedExcerpt,
    effectiveMessageLength,
    rulesPublishedUrl,
    rulesPublishedMessageId,
    messageDeleted,
    isCommercialReviewOnly,
    ownRuleGuards,
    authorizeCommercialSanction,
    authorizeCommercialFinal,
    beforeNoticeSend,
    durable,
    recoveringOwnEffect,
  } = context;
  let { userLabel } = context;
  if (!recoveringOwnEffect) await ownRuleGuards?.assertBeforeFollowUp();
  if (authorizeCommercialSanction && !(await authorizeCommercialSanction())) return;
  const linkMessageOptions =
    topViolation.ruleCode === 'LINK_BLOCKED'
      ? host.buildBotMessageOptions(
          chatId,
          settings.linkBotButtons,
          settings.linkBotButtonEnabled,
          settings.linkBotButtonUrl,
          settings.linkBotButtonText,
          settings.rulesAttachViolationsEnabled,
          rulesPublishedUrl,
          rulesPublishedMessageId,
        )
      : null;
  const linkViolationCount24h =
    topViolation.ruleCode === 'LINK_BLOCKED'
      ? await host.countRecentLinkViolations(chatId, senderId, settings.linkEscalationWindowHours, {
          messageId,
          updateType,
        })
      : null;
  const isTextFilterHit =
    host.isTextFilterViolation(topViolation.ruleCode) && !isCommercialReviewOnly;
  const isEscalatingTextFilterHit =
    isTextFilterHit &&
    (topViolation.ruleCode !== 'PROFANITY' ||
      topViolation.score >= PROFANITY_AUTOMATIC_ESCALATION_MIN_SCORE);
  // FLAG: Phone blocking uses the visible Limits actions, including their templates and window.
  // Retained phone-specific fields cannot silently enable a separate sanction policy.
  const isMessageLimitsHit = host.isMessageLimitsViolation(topViolation.ruleCode);
  const messageLimitsBlockedWord = extractMessageLimitsBlockedToken(topViolation.metadata);
  const textFilterEscalationSettings = isTextFilterHit
    ? host.resolveTextFilterEscalationSettings(topViolation.ruleCode, settings)
    : null;
  const textFilterMessageOptions = isTextFilterHit
    ? host.buildBotMessageOptions(
        chatId,
        // FLAG: Commercial custom buttons never appear on independent profanity notices.
        topViolation.ruleCode === 'PROFANITY' ? [] : settings.textFiltersBotButtons,
        topViolation.ruleCode !== 'PROFANITY' && settings.textFiltersBotButtonEnabled,
        topViolation.ruleCode === 'PROFANITY' ? '' : settings.textFiltersBotButtonUrl,
        topViolation.ruleCode === 'PROFANITY' ? '' : settings.textFiltersBotButtonText,
        settings.rulesAttachViolationsEnabled,
        rulesPublishedUrl,
        rulesPublishedMessageId,
      )
    : null;
  const limitsMessageOptions = isMessageLimitsHit
    ? host.buildBotMessageOptions(
        chatId,
        settings.messageLimitsBotButtons,
        settings.messageLimitsBotButtonEnabled,
        settings.messageLimitsBotButtonUrl,
        settings.messageLimitsBotButtonText,
        settings.rulesAttachViolationsEnabled,
        rulesPublishedUrl,
        rulesPublishedMessageId,
      )
    : null;
  const textFilterViolationCount24h = isEscalatingTextFilterHit
    ? await host.countRecentTextFilterViolations(chatId, senderId, topViolation.ruleCode, {
        messageId,
        updateType,
      })
    : null;
  const messageLimitsViolationCount12h = isMessageLimitsHit
    ? (durable?.plan.violationCount ??
      (await host.countRecentMessageLimitsViolations(chatId, senderId, topViolation.ruleCode, {
        messageId,
        updateType,
      })))
    : null;
  let action: SanctionAction = durable?.plan.action ?? SanctionAction.NONE;
  const sendChatBotMessage = async (
    textValue: string,
    messageOptions?: MaxSendMessageOptions,
    mediaFieldKey?: BotSpeechMediaFieldKey,
  ) =>
    durable?.journal.receiptOnly
      ? Promise.resolve(false)
      : host.sendBotMessageWithOptionalAutoDelete({
          ...createCommercialNoticeDispatchOptions(authorizeCommercialFinal),
          chatId,
          text: textValue,
          media: host.resolveBotSpeechMedia(settings, mediaFieldKey),
          messageOptions: withMarketplaceModerationMessage(
            messageOptions,
            chatId,
            'MODERATION_NOTICE',
            marketplaceModuleForRule(topViolation.ruleCode),
          ),
          deleteBotMessagesEnabled: settings.deleteBotMessagesEnabled,
          deleteBotMessagesDelayMinutes: settings.deleteBotMessagesDelayMinutes,
          userFacing: action === SanctionAction.WARN,
          // FLAG: Recheck after asynchronous contact/media work, immediately before send handoff.
          beforeSend: beforeNoticeSend,
          ledgerContext: ownRuleGuards?.noticeLedgerContext,
          ...(durable
            ? { idempotencyKey: `${durable.row.id}:explanation`, bypassNoticeBucket: true }
            : {}),
        });

  const actionMuteDurationHours =
    durable?.plan.muteDurationHours ??
    host.resolveAutomaticMuteDurationHours(topViolation.ruleCode, settings);

  if (!durable) {
    if (topViolation.ruleCode === 'LINK_BLOCKED') {
      action = host.resolveLinkEscalationAction(linkViolationCount24h ?? 1, {
        warnEnabled: settings.linkWarnEnabled,
        banEnabled: settings.linkBanEnabled,
        muteEnabled: settings.linkMuteEnabled,
        warnMaxCount: settings.linkWarnMaxCount,
        muteMaxCount: settings.linkMuteMaxCount,
        banMaxCount: settings.linkBanMaxCount,
      });
    } else if (isEscalatingTextFilterHit) {
      action = host.resolveTextFilterEscalationAction(textFilterViolationCount24h ?? 1, {
        warnEnabled: Boolean(textFilterEscalationSettings?.warnEnabled),
        banEnabled: Boolean(textFilterEscalationSettings?.banEnabled),
        muteEnabled: Boolean(textFilterEscalationSettings?.muteEnabled),
      });
    } else if (topViolation.ruleCode === 'MESSAGE_RATE_LIMIT') {
      // Burst flooding can starve moderation workers, so this guard is enforced as a hard ban.
      action = SanctionAction.BAN;
    } else if (isMessageLimitsHit) {
      action = host.resolveMessageLimitsEscalationAction(messageLimitsViolationCount12h ?? 1, {
        warnEnabled: settings.messageLimitsWarnEnabled,
        banEnabled: settings.messageLimitsBanEnabled,
        muteEnabled: settings.messageLimitsMuteEnabled,
      });
    } else if (host.shouldResolveSanction(topViolation.ruleCode)) {
      action = await host.sanctionService.resolveAction({
        chatId,
        userId: senderId,
        warnThreshold: settings.warnThreshold,
      });
    }
  }

  if (
    !durable?.journal.receiptOnly &&
    (action === SanctionAction.MUTE || action === SanctionAction.BAN)
  ) {
    userLabel = await host.resolveSanctionUserLabel(chatId, senderId, userLabel);
  }

  const stopWordsSanctionGuard = createStopWordsSanctionGuard(host.stopWordsDeleteGuard, {
    hasPolicy: settings.stopWordsPolicy != null,
    chatId,
    messageId,
    senderId,
    ruleCode: topViolation.ruleCode,
    metadata: topViolation.metadata,
    action,
  });
  if (
    !recoveringOwnEffect &&
    settings.stopWordsPolicy != null &&
    !(await verifyStopWordsSanction(stopWordsSanctionGuard))
  )
    return;

  const isFirstLinkViolation =
    topViolation.ruleCode === 'LINK_BLOCKED' && linkViolationCount24h === 1;
  const isFirstTextFilterViolation = isEscalatingTextFilterHit && textFilterViolationCount24h === 1;
  const isFirstMessageLimitsViolation = isMessageLimitsHit && messageLimitsViolationCount12h === 1;

  if (topViolation.ruleCode === 'LINK_BLOCKED') {
    if (action === SanctionAction.NONE && isFirstLinkViolation && settings.linkBotMessageEnabled) {
      try {
        await sendChatBotMessage(
          await host.appendAdminContactMarkdownLink(
            chatId,
            host.buildLinkExplanation(
              userLabel,
              messageDeleted,
              settings.linkBotMessageText,
              settings.botSpeechStyle,
              updateType === 'message_edited',
            ),
            settings.linkAdminContactButtonEnabled,
            settings.linkAdminContactButtonUrl,
          ),
          linkMessageOptions ?? undefined,
          'linkBotMessageText',
        );
      } catch (error: unknown) {
        if (durable) throw error;
        host.logger.warn(
          {
            chatId,
            userId: senderId,
            messageId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to send link explanation message',
        );
      }
    } else if (action === SanctionAction.WARN) {
      try {
        await sendChatBotMessage(
          await host.appendAdminContactMarkdownLink(
            chatId,
            host.buildLinkWarnExplanation(
              userLabel,
              settings.linkWarnMessageText,
              settings.botSpeechStyle,
              updateType === 'message_edited',
            ),
            settings.linkAdminContactButtonEnabled,
            settings.linkAdminContactButtonUrl,
          ),
          linkMessageOptions ?? undefined,
          'linkWarnMessageText',
        );
      } catch (error: unknown) {
        if (durable) throw error;
        host.logger.warn(
          {
            chatId,
            userId: senderId,
            messageId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to send link warning message',
        );
      }
    }
  }

  if (isMessageLimitsHit) {
    if (
      action === SanctionAction.NONE &&
      isFirstMessageLimitsViolation &&
      settings.messageLimitsBotMessageEnabled
    ) {
      try {
        await sendChatBotMessage(
          await host.appendAdminContactMarkdownLink(
            chatId,
            host.buildMessageLimitsExplanation(
              userLabel,
              topViolation.ruleCode,
              messageDeleted,
              settings.messageCountLimitMessages,
              settings.messageCountLimitWindowHours,
              settings.photoMessageCooldownHours,
              settings.stickerMessageCooldownMinutes,
              effectiveMessageLength,
              settings.maxMessageLength,
              messageLimitsBlockedWord,
              settings.messageLimitsBotMessageText,
              settings.botSpeechStyle,
            ),
            settings.messageLimitsAdminContactButtonEnabled,
            settings.messageLimitsAdminContactButtonUrl,
          ),
          limitsMessageOptions ?? undefined,
          'messageLimitsBotMessageText',
        );
      } catch (error: unknown) {
        if (durable) throw error;
        host.logger.warn(
          {
            chatId,
            userId: senderId,
            messageId,
            ruleCode: topViolation.ruleCode,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to send message limits explanation message',
        );
      }
    } else if (action === SanctionAction.WARN) {
      try {
        await sendChatBotMessage(
          await host.appendAdminContactMarkdownLink(
            chatId,
            host.buildMessageLimitsWarnExplanation(
              userLabel,
              topViolation.ruleCode,
              messageLimitsBlockedWord,
              settings.botSpeechStyle,
              settings.messageLimitsWarnMessageText,
              settings,
            ),
            settings.messageLimitsAdminContactButtonEnabled,
            settings.messageLimitsAdminContactButtonUrl,
          ),
          limitsMessageOptions ?? undefined,
          'messageLimitsWarnMessageText',
        );
      } catch (error: unknown) {
        if (durable) throw error;
        host.logger.warn(
          {
            chatId,
            userId: senderId,
            messageId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to send message limits warning message',
        );
      }
    }
  }

  if (isTextFilterHit) {
    if (
      action === SanctionAction.NONE &&
      isFirstTextFilterViolation &&
      textFilterEscalationSettings?.botMessageEnabled
    ) {
      try {
        await sendChatBotMessage(
          await host.appendAdminContactMarkdownLink(
            chatId,
            host.buildTextFilterExplanation(
              userLabel,
              topViolation.ruleCode,
              messageDeleted,
              textFilterEscalationSettings.botMessageText,
              settings.botSpeechStyle,
            ),
            textFilterEscalationSettings.adminContactButtonEnabled,
            textFilterEscalationSettings.adminContactButtonUrl,
          ),
          textFilterMessageOptions ?? undefined,
          topViolation.ruleCode === 'PROFANITY'
            ? 'profanityBotMessageText'
            : 'textFiltersBotMessageText',
        );
      } catch (error: unknown) {
        if (durable) throw error;
        host.logger.warn(
          {
            chatId,
            userId: senderId,
            messageId,
            ruleCode: topViolation.ruleCode,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to send text filter explanation message',
        );
      }
    } else if (action === SanctionAction.WARN) {
      try {
        await sendChatBotMessage(
          await host.appendAdminContactMarkdownLink(
            chatId,
            host.buildTextFilterWarnExplanation(
              userLabel,
              topViolation.ruleCode,
              textFilterEscalationSettings?.warnMessageText ??
                (topViolation.ruleCode === 'PROFANITY'
                  ? settings.profanityWarnMessageText
                  : settings.textFiltersWarnMessageText),
              settings.botSpeechStyle,
            ),
            textFilterEscalationSettings?.adminContactButtonEnabled ?? false,
            textFilterEscalationSettings?.adminContactButtonUrl ?? '',
          ),
          textFilterMessageOptions ?? undefined,
          topViolation.ruleCode === 'PROFANITY'
            ? 'profanityWarnMessageText'
            : 'textFiltersWarnMessageText',
        );
      } catch (error: unknown) {
        if (durable) throw error;
        host.logger.warn(
          {
            chatId,
            userId: senderId,
            messageId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to send text filter warning message',
        );
      }
    }
  }

  const persistModerationEvent = (
    metadataPatch: Record<string, unknown> = {},
    actionOverride: SanctionAction = action,
  ) =>
    host.persistRuleFollowupEvent(durable, {
      data: {
        chatId,
        userId: senderId,
        messageId,
        eventType: EventType.MESSAGE,
        ruleCode: topViolation.ruleCode,
        action: actionOverride,
        maskedExcerpt,
        score: topViolation.score,
        operator: Operator.BOT,
        metadata: {
          reason: topViolation.reason,
          ...(topViolation.metadata && typeof topViolation.metadata === 'object'
            ? topViolation.metadata
            : {}),
          action: actionOverride,
          ...(topViolation.ruleCode === 'LINK_BLOCKED' && linkViolationCount24h !== null
            ? {
                linkViolationCount24h,
                linkEscalationWindowHours: settings.linkEscalationWindowHours,
              }
            : {}),
          ...(isTextFilterHit && textFilterViolationCount24h !== null
            ? {
                textFilterViolationCount24h,
                textFilterEscalationWindowHours: TEXT_FILTER_ESCALATION_WINDOW_HOURS,
              }
            : {}),
          ...(isMessageLimitsHit && messageLimitsViolationCount12h !== null
            ? {
                messageLimitsViolationCount12h,
                messageLimitsEscalationWindowHours: MESSAGE_LIMITS_ESCALATION_WINDOW_HOURS,
              }
            : {}),
          ...metadataPatch,
        },
      },
    });
  let sanctionEventPersisted = false;
  if (action !== SanctionAction.NONE) {
    sanctionEventPersisted = await host.applyRuleFollowupSanction(durable, {
      ...createModerationSanctionCallbacks(
        authorizeCommercialSanction,
        ownRuleGuards,
        stopWordsSanctionGuard,
        action,
        authorizeCommercialFinal,
      ),
      chatId,
      userId: senderId,
      action,
      userLabel,
      messageId,
      muteDurationHours: actionMuteDurationHours,
      deleteBotMessagesEnabled: settings.deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes: settings.deleteBotMessagesDelayMinutes,
      botMessageOptions: withMarketplaceModerationMessage(
        topViolation.ruleCode === 'LINK_BLOCKED'
          ? (linkMessageOptions ?? undefined)
          : isMessageLimitsHit
            ? (limitsMessageOptions ?? undefined)
            : isTextFilterHit
              ? (textFilterMessageOptions ?? undefined)
              : undefined,
        chatId,
        'MODERATION_NOTICE',
        marketplaceModuleForRule(topViolation.ruleCode),
      ),
      sanctionNoticeText:
        isMessageLimitsHit && action === SanctionAction.BAN
          ? host.buildMessageLimitsBanExplanation(
              userLabel,
              topViolation.ruleCode,
              actionMuteDurationHours,
              messageLimitsBlockedWord,
              settings.botSpeechStyle,
              settings,
            )
          : undefined,
      botSpeechStyle: settings.botSpeechStyle,
      persistModerationEvent,
    });

    if (ownRuleGuards?.wasRejected()) return;
    if (topViolation.ruleCode === 'LINK_BLOCKED' && action === SanctionAction.MUTE) {
      try {
        await sendChatBotMessage(
          host.buildLinkMuteExplanation(userLabel, settings.botSpeechStyle),
          linkMessageOptions ?? undefined,
        );
      } catch (error: unknown) {
        if (durable) throw error;
        host.logger.warn(
          {
            chatId,
            userId: senderId,
            messageId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to send link mute message',
        );
      }
    }

    if (isTextFilterHit && action === SanctionAction.MUTE) {
      try {
        await sendChatBotMessage(
          host.buildTextFilterMuteExplanation(
            userLabel,
            topViolation.ruleCode,
            settings.botSpeechStyle,
          ),
          textFilterMessageOptions ?? undefined,
        );
      } catch (error: unknown) {
        if (durable) throw error;
        host.logger.warn(
          {
            chatId,
            userId: senderId,
            messageId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to send text filter mute message',
        );
      }
    }

    if (isMessageLimitsHit && action === SanctionAction.MUTE) {
      try {
        await sendChatBotMessage(
          host.buildMessageLimitsMuteExplanation(
            userLabel,
            topViolation.ruleCode,
            messageLimitsBlockedWord,
            settings.botSpeechStyle,
            settings,
          ),
          limitsMessageOptions ?? undefined,
        );
      } catch (error: unknown) {
        if (durable) throw error;
        host.logger.warn(
          {
            chatId,
            userId: senderId,
            messageId,
            ruleCode: topViolation.ruleCode,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to send message limits mute message',
        );
      }
    }
  }

  if (!sanctionEventPersisted) {
    await persistModerationDecisionWithoutAppliedSanction(persistModerationEvent, action);
  }
}
