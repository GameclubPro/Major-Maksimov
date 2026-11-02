import { z } from 'zod';
import { botSpeechPersonaSchema, type BotSpeechPersona } from '@maxim/contracts/bot-speech';
import { collectBotTokenSecrets } from '../common/bot-token.util';
import {
  canExecuteActionsForBotState,
  isAdminVisibleByDefaultForBotState,
} from './max-bot-state.util';

export const maxBotLifecycleStateSchema = z.enum(['active', 'dormant', 'draining', 'disabled']);
export type MaxBotLifecycleState = z.infer<typeof maxBotLifecycleStateSchema>;

const maxAdditionalBotSchema = z.object({
  id: z.string().trim().min(3),
  label: z.string().trim().min(1).max(64).optional(),
  characterName: z.string().trim().min(1).max(128).optional(),
  speechPersona: botSpeechPersonaSchema.optional(),
  token: z.string().trim().min(10),
  tokenPrevious: z.string().trim().min(10).optional(),
  webhookSecretPath: z.string().trim().min(8),
  webhookHeaderSecret: z.string().trim().min(8),
  webhookHeaderSecretPrevious: z.string().trim().min(8).optional(),
  contactId: z.string().trim().regex(/^\d+$/u).optional(),
  state: maxBotLifecycleStateSchema.default('active'),
  ownershipWeight: z.number().finite().positive().max(1_000).default(1),
  visibleInAdmin: z.boolean().optional(),
});

const maxAdditionalBotsSchema = z.array(maxAdditionalBotSchema);

export type AdditionalMaxBotConfig = z.infer<typeof maxAdditionalBotSchema>;

export type ResolvedMaxBotConfig = {
  id: string;
  label: string;
  characterName: string;
  speechPersona: BotSpeechPersona;
  token: string;
  tokenValidationSecrets: readonly string[];
  webhookSecretPath: string;
  webhookHeaderSecret: string;
  webhookHeaderSecrets: readonly string[];
  contactId: string | null;
  state: MaxBotLifecycleState;
  ownershipWeight: number;
  visibleInAdmin: boolean;
  isDefault: boolean;
};

const KNOWN_MAX_BOT_SPEECH_PROFILES: Readonly<
  Record<string, { characterName: string; speechPersona: BotSpeechPersona }>
> = Object.freeze({
  id613070470872_9_bot: { characterName: 'Майор Максимов', speechPersona: 'male' },
  id613002203036_bot: { characterName: 'Майор Максимов', speechPersona: 'male' },
  id613070470872_5_bot: { characterName: 'Майор Максимова', speechPersona: 'female' },
  id613002203036_4_bot: { characterName: 'Майор Максимова', speechPersona: 'female' },
  id613070470872_6_bot: { characterName: 'Рэкс', speechPersona: 'neutral' },
  id613002203036_5_bot: { characterName: 'Рэкс', speechPersona: 'neutral' },
});

export function parseAdditionalMaxBotsJson(
  rawValue: string | null | undefined,
): AdditionalMaxBotConfig[] {
  const normalized = typeof rawValue === 'string' ? rawValue.trim() : '';
  if (!normalized) {
    return [];
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(normalized);
  } catch {
    throw new Error('MAX_BOTS_JSON must be valid JSON');
  }

  const parsed = maxAdditionalBotsSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(
      `MAX_BOTS_JSON is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
        .join('; ')}`,
    );
  }

  const seenBotIds = new Set<string>();
  for (const bot of parsed.data) {
    const normalizedBotId = bot.id.trim();
    if (seenBotIds.has(normalizedBotId)) {
      throw new Error(`MAX_BOTS_JSON contains duplicate bot id "${normalizedBotId}"`);
    }
    seenBotIds.add(normalizedBotId);
  }

  return parsed.data.map((bot) => ({
    ...bot,
    id: bot.id.trim(),
    token: bot.token.trim(),
    tokenPrevious: bot.tokenPrevious?.trim(),
    webhookSecretPath: bot.webhookSecretPath.trim(),
    webhookHeaderSecret: bot.webhookHeaderSecret.trim(),
    webhookHeaderSecretPrevious: bot.webhookHeaderSecretPrevious?.trim(),
    contactId: bot.contactId?.trim(),
    label: bot.label?.trim(),
    characterName: bot.characterName?.trim(),
    speechPersona: bot.speechPersona,
    state: bot.state,
    visibleInAdmin: bot.visibleInAdmin,
  }));
}

export function buildResolvedMaxBotConfigs(input: {
  defaultBot: {
    id: string;
    token: string;
    tokenPrevious?: string | null;
    webhookSecretPath: string;
    webhookHeaderSecret: string;
    webhookHeaderSecretPrevious?: string | null;
    contactId?: string | null;
    label?: string | null;
    characterName?: string | null;
    speechPersona?: BotSpeechPersona | null;
    state?: MaxBotLifecycleState | null;
    ownershipWeight?: number | null;
  };
  additionalBotsJson?: string | null;
}): ResolvedMaxBotConfig[] {
  const defaultBotId = input.defaultBot.id.trim();
  const defaultKnownProfile = resolveKnownMaxBotSpeechProfile(defaultBotId);
  const defaultBotLabel =
    normalizeBotLabel(input.defaultBot.label) ?? defaultKnownProfile?.characterName ?? defaultBotId;
  const defaultBotSpeechPersona =
    input.defaultBot.speechPersona ?? defaultKnownProfile?.speechPersona ?? 'male';
  const bots: ResolvedMaxBotConfig[] = [
    {
      id: defaultBotId,
      label: defaultBotLabel,
      characterName: resolveBotCharacterName({
        explicitCharacterName:
          normalizeBotCharacterName(input.defaultBot.characterName) ??
          defaultKnownProfile?.characterName,
        label: defaultBotLabel,
        speechPersona: defaultBotSpeechPersona,
        isDefault: true,
      }),
      speechPersona: defaultBotSpeechPersona,
      token: input.defaultBot.token.trim(),
      tokenValidationSecrets: collectBotTokenSecrets(
        input.defaultBot.token,
        input.defaultBot.tokenPrevious,
      ),
      webhookSecretPath: input.defaultBot.webhookSecretPath.trim(),
      webhookHeaderSecret: input.defaultBot.webhookHeaderSecret.trim(),
      webhookHeaderSecrets: collectBotTokenSecrets(
        input.defaultBot.webhookHeaderSecret,
        input.defaultBot.webhookHeaderSecretPrevious,
      ),
      contactId:
        normalizeContactId(input.defaultBot.contactId) ?? inferContactIdFromBotId(defaultBotId),
      state: input.defaultBot.state ?? 'active',
      ownershipWeight: normalizeOwnershipWeight(input.defaultBot.ownershipWeight),
      visibleInAdmin: isAdminVisibleByDefaultForBotState(input.defaultBot.state ?? 'active'),
      isDefault: true,
    },
  ];

  for (const bot of parseAdditionalMaxBotsJson(input.additionalBotsJson)) {
    if (bot.id === defaultBotId) {
      throw new Error(`MAX_BOTS_JSON must not repeat default bot id "${defaultBotId}"`);
    }

    const knownProfile = resolveKnownMaxBotSpeechProfile(bot.id);
    const botLabel = normalizeBotLabel(bot.label) ?? knownProfile?.characterName ?? bot.id;
    const speechPersona = bot.speechPersona ?? knownProfile?.speechPersona ?? 'male';

    bots.push({
      id: bot.id,
      label: botLabel,
      characterName: resolveBotCharacterName({
        explicitCharacterName:
          normalizeBotCharacterName(bot.characterName) ?? knownProfile?.characterName,
        label: botLabel,
        speechPersona,
        isDefault: false,
      }),
      speechPersona,
      token: bot.token,
      tokenValidationSecrets: collectBotTokenSecrets(bot.token, bot.tokenPrevious),
      webhookSecretPath: bot.webhookSecretPath,
      webhookHeaderSecret: bot.webhookHeaderSecret,
      webhookHeaderSecrets: collectBotTokenSecrets(
        bot.webhookHeaderSecret,
        bot.webhookHeaderSecretPrevious,
      ),
      contactId: normalizeContactId(bot.contactId) ?? inferContactIdFromBotId(bot.id),
      state: bot.state,
      ownershipWeight: bot.ownershipWeight,
      visibleInAdmin: bot.visibleInAdmin ?? isAdminVisibleByDefaultForBotState(bot.state),
      isDefault: false,
    });
  }

  validateResolvedMaxBotConfigs(bots);
  return bots;
}

export function resolveMaxEntryBotConfig(
  bots: readonly ResolvedMaxBotConfig[],
  configuredBotId: string | null | undefined,
): ResolvedMaxBotConfig {
  const normalizedBotId = typeof configuredBotId === 'string' ? configuredBotId.trim() : '';
  if (normalizedBotId) {
    const configuredBot = bots.find((bot) => bot.id === normalizedBotId) ?? null;
    if (!configuredBot) {
      throw new Error(
        `MAX_ENTRY_BOT_ID must match MAX_BOT_ID or one of MAX_BOTS_JSON ids (got "${normalizedBotId}")`,
      );
    }
    if (!canExecuteActionsForBotState(configuredBot.state)) {
      throw new Error(
        `MAX_ENTRY_BOT_ID must reference an active bot; got "${normalizedBotId}" with state "${configuredBot.state}"`,
      );
    }
    return configuredBot;
  }

  const defaultBot = bots.find((bot) => bot.isDefault) ?? null;
  if (defaultBot && canExecuteActionsForBotState(defaultBot.state)) {
    return defaultBot;
  }

  const firstActionableBot = bots.find((bot) => canExecuteActionsForBotState(bot.state)) ?? null;
  if (firstActionableBot) {
    return firstActionableBot;
  }

  throw new Error('MAX bot configuration must contain at least one active actionable entry bot');
}

export function normalizeContactId(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized && /^\d+$/u.test(normalized) ? normalized : null;
}

function normalizeOwnershipWeight(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(value, 1_000)
    : 1;
}

function normalizeBotLabel(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

function normalizeBotCharacterName(value: string | null | undefined): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

function resolveKnownMaxBotSpeechProfile(
  botId: string | null | undefined,
): { characterName: string; speechPersona: BotSpeechPersona } | null {
  const normalizedBotId = typeof botId === 'string' ? botId.trim() : '';
  return normalizedBotId ? (KNOWN_MAX_BOT_SPEECH_PROFILES[normalizedBotId] ?? null) : null;
}

function resolveBotCharacterName(params: {
  explicitCharacterName: string | null | undefined;
  label: string;
  speechPersona: BotSpeechPersona;
  isDefault: boolean;
}): string {
  const explicitCharacterName = normalizeBotCharacterName(params.explicitCharacterName);
  if (explicitCharacterName) {
    return explicitCharacterName;
  }

  if (params.isDefault) {
    return params.speechPersona === 'female' ? 'Майор Максимова' : 'Майор Максимов';
  }

  return params.label;
}

export function inferContactIdFromBotId(botId: string): string | null {
  const normalized = botId.trim().replace(/^id/iu, '').replace(/_bot$/iu, '');
  return /^\d+$/u.test(normalized) ? normalized : null;
}

export function buildBotIdVariants(value: string | null | undefined): Set<string> {
  if (typeof value !== 'string') {
    return new Set<string>();
  }

  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return new Set<string>();
  }

  const variants = new Set<string>([normalized]);
  if (normalized.startsWith('id') && normalized.length > 2) {
    variants.add(normalized.slice(2));
  }
  if (normalized.endsWith('_bot') && normalized.length > 4) {
    variants.add(normalized.slice(0, -4));
  }
  if (normalized.startsWith('id') && normalized.endsWith('_bot') && normalized.length > 6) {
    variants.add(normalized.slice(2, -4));
  }

  return variants;
}

function validateResolvedMaxBotConfigs(bots: readonly ResolvedMaxBotConfig[]): void {
  assertUniqueCrossBotValues(bots, 'token', (bot) => bot.tokenValidationSecrets);
  assertUniqueCrossBotValues(bots, 'webhookSecretPath', (bot) => [bot.webhookSecretPath]);
  assertUniqueCrossBotValues(bots, 'webhookHeaderSecret', (bot) => bot.webhookHeaderSecrets);

  const identityOwnerByVariant = new Map<string, string>();
  for (const bot of bots) {
    const variants = new Set([...buildBotIdVariants(bot.id), ...buildBotIdVariants(bot.contactId)]);
    for (const variant of variants) {
      const existingOwner = identityOwnerByVariant.get(variant);
      if (existingOwner && existingOwner !== bot.id) {
        throw new Error(
          `MAX bot contact identity must be unique across bots "${existingOwner}" and "${bot.id}"`,
        );
      }
      identityOwnerByVariant.set(variant, bot.id);
    }
  }

  resolveMaxEntryBotConfig(bots, null);
}

function assertUniqueCrossBotValues(
  bots: readonly ResolvedMaxBotConfig[],
  fieldName: string,
  readValues: (bot: ResolvedMaxBotConfig) => readonly string[],
): void {
  const ownerByValue = new Map<string, string>();
  for (const bot of bots) {
    for (const value of new Set(
      readValues(bot)
        .map((item) => item.trim())
        .filter(Boolean),
    )) {
      const existingOwner = ownerByValue.get(value);
      if (existingOwner && existingOwner !== bot.id) {
        throw new Error(
          `MAX bot ${fieldName} must be unique across bots "${existingOwner}" and "${bot.id}"`,
        );
      }
      ownerByValue.set(value, bot.id);
    }
  }
}
