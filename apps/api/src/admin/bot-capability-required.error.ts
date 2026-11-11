import { ConflictException, HttpStatus, ServiceUnavailableException } from '@nestjs/common';

export const BOT_CAPABILITY_REQUIRED_CODE = 'BOT_CAPABILITY_REQUIRED';

export type BotCapabilityPermission =
  | 'write'
  | 'add_remove_members'
  | 'administrator'
  | 'bot_connection';

export type BotCapabilityAffectedEntity = { id: string; title: string };
export type BotCapabilityOperation = 'member_moderation';

export class BotCapabilityRequiredException extends ConflictException {
  readonly missingPermissions: readonly BotCapabilityPermission[];
  readonly featureKeys: readonly string[];
  readonly checkedAt: string | null;
  readonly blockerCode: string;
  readonly stale: boolean;
  readonly canRecheck: boolean;

  constructor(params: {
    missingPermissions: readonly BotCapabilityPermission[];
    featureKeys: readonly string[];
    checkedAt?: string | null;
    blockerCode?: string;
    stale?: boolean;
    canRecheck?: boolean;
    affectedEntities?: readonly BotCapabilityAffectedEntity[];
    operation?: BotCapabilityOperation;
  }) {
    super({
      statusCode: HttpStatus.CONFLICT,
      error: 'Conflict',
      message:
        params.operation === 'member_moderation'
          ? 'Боту не хватает подтверждённых прав для модерации участников.'
          : 'Боту не хватает прав для включения выбранной функции.',
      code: BOT_CAPABILITY_REQUIRED_CODE,
      missingPermissions: [...params.missingPermissions],
      featureKeys: [...params.featureKeys],
      checkedAt: params.checkedAt ?? null,
      blockerCode: params.blockerCode ?? 'bot_capability_missing',
      stale: params.stale ?? false,
      canRecheck: params.canRecheck ?? true,
      ...(params.operation ? { operation: params.operation } : {}),
      ...(params.affectedEntities
        ? {
            affectedEntities: params.affectedEntities.slice(0, 20).map((entity) => ({
              id: entity.id.trim().slice(0, 128),
              title: entity.title.trim().slice(0, 160),
            })),
          }
        : {}),
    });
    this.name = 'BotCapabilityRequiredException';
    this.missingPermissions = [...params.missingPermissions];
    this.featureKeys = [...params.featureKeys];
    this.checkedAt = params.checkedAt ?? null;
    this.blockerCode = params.blockerCode ?? 'bot_capability_missing';
    this.stale = params.stale ?? false;
    this.canRecheck = params.canRecheck ?? true;
  }
}

export class BotCapabilityCheckUnavailableException extends ServiceUnavailableException {
  constructor(params: {
    featureKeys: readonly string[];
    checkedAt?: string | null;
    blockerCode?: string;
    canRecheck?: boolean;
    operation?: BotCapabilityOperation;
  }) {
    super({
      statusCode: HttpStatus.SERVICE_UNAVAILABLE,
      error: 'Service Unavailable',
      message:
        params.operation === 'member_moderation'
          ? 'Не удалось подтвердить права бота для модерации участников. Обновите список и проверьте права бота в MAX.'
          : 'Не удалось подтвердить права бота MAX. Повторите попытку позже.',
      code: 'BOT_CAPABILITY_CHECK_UNAVAILABLE',
      featureKeys: [...params.featureKeys],
      checkedAt: params.checkedAt ?? null,
      blockerCode: params.blockerCode ?? 'bot_capability_check_unavailable',
      stale: true,
      canRecheck: params.canRecheck ?? true,
      ...(params.operation ? { operation: params.operation } : {}),
    });
    this.name = 'BotCapabilityCheckUnavailableException';
  }
}
