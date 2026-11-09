import type {
  BotSpeechEditableFieldKey,
  BotSpeechStyle,
  BotSpeechSystemTemplateKey,
} from '@maxim/contracts/bot-speech';
import {
  resolveMessageLimitsSanctionReason,
  type MessageCountLimitSpeechContext,
} from './bot-speech-custom-override.util';

type MessageLimitsSanctionRenderers = {
  renderEditable: (params: {
    style: BotSpeechStyle | null;
    fieldKey: BotSpeechEditableFieldKey;
    overrideText: string;
    replacements: Record<string, string>;
  }) => string;
  renderSystem: (params: {
    style: BotSpeechStyle | null;
    templateKey: BotSpeechSystemTemplateKey;
    replacements: Record<string, string>;
  }) => string;
};

export function createMessageLimitsSanctionSpeech(renderers: MessageLimitsSanctionRenderers) {
  return {
    buildMessageLimitsWarnExplanation(
      userLabel: string,
      ruleCode: string,
      blockedWord: string | null | undefined,
      botSpeechStyle: BotSpeechStyle | null,
      templateText = '',
      quota?: MessageCountLimitSpeechContext,
    ): string {
      return renderers.renderEditable({
        style: botSpeechStyle,
        fieldKey: 'messageLimitsWarnMessageText',
        overrideText: templateText,
        replacements: {
          user: userLabel,
          reason: resolveMessageLimitsSanctionReason(ruleCode, blockedWord, templateText, quota),
        },
      });
    },

    buildMessageLimitsMuteExplanation(
      userLabel: string,
      ruleCode: string,
      blockedWord: string | null | undefined,
      botSpeechStyle: BotSpeechStyle | null,
      quota?: MessageCountLimitSpeechContext,
    ): string {
      return renderers.renderSystem({
        style: botSpeechStyle,
        templateKey: 'messageLimitsMute',
        replacements: {
          user: userLabel,
          reason: resolveMessageLimitsSanctionReason(ruleCode, blockedWord, undefined, quota),
        },
      });
    },

    buildMessageLimitsBanExplanation(
      userLabel: string,
      ruleCode: string,
      _muteDurationHours: number,
      blockedWord: string | null | undefined,
      botSpeechStyle: BotSpeechStyle | null,
      quota?: MessageCountLimitSpeechContext,
    ): string {
      return renderers.renderSystem({
        style: botSpeechStyle,
        templateKey: 'messageLimitsBan',
        replacements: {
          user: userLabel,
          reason: resolveMessageLimitsSanctionReason(ruleCode, blockedWord, undefined, quota),
        },
      });
    },
  };
}
