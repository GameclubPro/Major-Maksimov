import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  markMaxMemberMutationAttempted,
  markMaxMemberMutationConfirmed,
} from '../max/max-client.service';
import {
  ModerationSanctionStateLockBusyError,
  ModerationSanctionStateLockUnavailableError,
} from '../moderation/moderation-sanction-state-lock.service';
import { AdminAutopostController } from './admin-autopost.controller';
import { AdminBroadcastController } from './admin-broadcast.controller';
import { AdminDialogController } from './admin-dialog.controller';
import { AdminManualModerationController } from './admin-manual-moderation.controller';
import { AdminManagedEntitiesController } from './admin-managed-entities.controller';
import { AdminSettingsController } from './admin-settings.controller';
import {
  BotCapabilityCheckUnavailableException,
  BotCapabilityRequiredException,
} from './bot-capability-required.error';
import type { ManualModerationService } from './manual-moderation.service';

describe('admin domain controllers', () => {
  const user = {
    userId: 'admin-1',
    username: null,
    displayName: null,
    chatTitle: null,
  };

  it('routes a channel ban through the channel authorization boundary', async () => {
    const service = { banChannelMember: jest.fn().mockResolvedValue({ ok: true }) };
    const controller = new AdminManualModerationController(service as never);
    await expect(controller.banChannelMember('channel-1', 'user-1', user)).resolves.toEqual({
      ok: true,
    });
    expect(service.banChannelMember).toHaveBeenCalledWith('channel-1', 'user-1', user);
  });

  it('maps channel ban lock conflicts to HTTP conflict without dispatch retries', async () => {
    const service = {
      banChannelMember: jest
        .fn()
        .mockRejectedValue(
          new ModerationSanctionStateLockBusyError({ chatId: 'channel-1', userId: 'user-1' }),
        ),
    };
    const controller = new AdminManualModerationController(service as never);
    await expect(controller.banChannelMember('channel-1', 'user-1', user)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(service.banChannelMember).toHaveBeenCalledTimes(1);
  });

  describe.each(['channel', 'chat'] as const)('%s mutation failure boundary', (entry) => {
    async function invoke(error: unknown) {
      const service = {
        banChannelMember: jest
          .fn<
            ReturnType<ManualModerationService['banChannelMember']>,
            Parameters<ManualModerationService['banChannelMember']>
          >()
          .mockRejectedValue(error),
        applyManualModerationAction: jest
          .fn<
            ReturnType<ManualModerationService['applyManualModerationAction']>,
            Parameters<ManualModerationService['applyManualModerationAction']>
          >()
          .mockRejectedValue(error),
      } satisfies Pick<ManualModerationService, 'banChannelMember' | 'applyManualModerationAction'>;
      const controller = new AdminManualModerationController(
        service as unknown as ManualModerationService,
      );
      const result = await (
        entry === 'channel'
          ? controller.banChannelMember('channel-1', 'user-1', user)
          : controller.applyManualModerationAction('chat-1', 'user-1', user, {
              action: 'BAN',
              scope: 'current_chat',
            })
      ).then(
        () => null,
        (reason: unknown) => reason,
      );
      expect(
        entry === 'channel' ? service.banChannelMember : service.applyManualModerationAction,
      ).toHaveBeenCalledTimes(1);
      expect(
        entry === 'channel' ? service.applyManualModerationAction : service.banChannelMember,
      ).not.toHaveBeenCalled();
      return result;
    }

    it.each([
      ['timeout', () => markMaxMemberMutationAttempted(new Error('MAX request timed out'))],
      [
        'connection reset',
        () =>
          markMaxMemberMutationAttempted(
            Object.assign(new Error('connection reset'), { code: 'ECONNRESET' }),
          ),
      ],
      [
        'wrapped attempted timeout',
        () =>
          markMaxMemberMutationAttempted(
            Object.assign(new ServiceUnavailableException('Temporary MAX failure'), {
              cause: Object.assign(new Error('upstream timed out'), {
                response: { status: 504 },
              }),
            }),
          ),
      ],
      [
        'confirmed mutation with a failed follow-up',
        () => markMaxMemberMutationConfirmed(new Error('result persistence failed')),
      ],
      [
        'confirmed mutation followed by a misleading conflict',
        () =>
          markMaxMemberMutationConfirmed(
            new ModerationSanctionStateLockBusyError({ chatId: 'chat-1', userId: 'user-1' }),
          ),
      ],
    ])('returns uncertain status for %s without retrying', async (_label, makeError) => {
      const result = await invoke(makeError());
      expect(result).toBeInstanceOf(ServiceUnavailableException);
      expect((result as ServiceUnavailableException).getResponse()).toEqual({
        code: 'MODERATION_ACTION_STATUS_UNCERTAIN',
        message: 'Статус действия временно недоступен. Обновите список участников.',
        retryable: false,
      });
    });

    it.each([400, 403, 500])('preserves a definitive attempted HTTP %i failure', async (status) => {
      const error = markMaxMemberMutationAttempted(
        Object.assign(new Error('MAX rejected mutation'), { response: { status } }),
      );
      expect(await invoke(error)).toBe(error);
    });

    it.each([
      () =>
        new BotCapabilityRequiredException({
          missingPermissions: ['add_remove_members'],
          featureKeys: [],
        }),
      () => new BotCapabilityCheckUnavailableException({ featureKeys: [] }),
      () => new ForbiddenException('Human administrator access required'),
      () => new Error('unattempted lookup timeout'),
    ])('preserves a pre-mutation failure without inventing an outcome', async (makeError) => {
      const error = makeError();
      expect(await invoke(error)).toBe(error);
    });
  });

  it('removes allowlist rule via query parameter', async () => {
    const manualModerationService = {
      removeDomain: jest.fn().mockResolvedValue({ ok: true }),
    };
    const controller = new AdminManualModerationController(manualModerationService as never);

    await controller.removeDomainByQuery('chat-1', 'https://max.ru/news?x=1', user as never);

    expect(manualModerationService.removeDomain).toHaveBeenCalledWith(
      'chat-1',
      user,
      'https://max.ru/news?x=1',
    );
  });

  it('prefers query parameter over path parameter for allowlist removal', async () => {
    const manualModerationService = {
      removeDomain: jest.fn().mockResolvedValue({ ok: true }),
    };
    const controller = new AdminManualModerationController(manualModerationService as never);

    await controller.removeDomain(
      'chat-1',
      'stale-path-value',
      'domain:docs.max.ru',
      user as never,
    );

    expect(manualModerationService.removeDomain).toHaveBeenCalledWith(
      'chat-1',
      user,
      'domain:docs.max.ru',
    );
  });

  it('schedules allowlist removal via query parameter', async () => {
    const manualModerationService = {
      scheduleDomainRemoval: jest.fn().mockResolvedValue({ ok: true }),
    };
    const controller = new AdminManualModerationController(manualModerationService as never);
    const body = { removeAfterAt: '2026-03-25T10:30:00.000Z' };

    await controller.scheduleDomainRemovalByQuery(
      'chat-1',
      'https://max.ru/news?x=1',
      user as never,
      body,
    );

    expect(manualModerationService.scheduleDomainRemoval).toHaveBeenCalledWith(
      'chat-1',
      user,
      'https://max.ru/news?x=1',
      body,
    );
  });

  it('rejects allowlist removal without query or path value', async () => {
    const controller = new AdminManualModerationController({} as never);

    expect(() => controller.removeDomainByQuery('chat-1', undefined, user as never)).toThrow(
      BadRequestException,
    );
  });

  it('routes broadcast endpoints through the managed broadcast domain service', async () => {
    const managedBroadcastService = {
      sendBroadcast: jest.fn().mockResolvedValue({ targetChats: 1, sentChats: 1, failedChats: 0 }),
    };
    const controller = new AdminBroadcastController(managedBroadcastService as never);
    const body = { text: 'Команда, новости на связи' };

    await controller.sendBroadcast('chat-1', user as never, body);

    expect(managedBroadcastService.sendBroadcast).toHaveBeenCalledWith('chat-1', user, body);
  });

  it('routes autopost rule endpoints through the managed autopost domain service', async () => {
    const managedAutopostService = {
      listAutopostRules: jest.fn().mockResolvedValue([]),
      getAutopostRule: jest.fn().mockResolvedValue({ id: 'rule-1' }),
      createAutopostRule: jest.fn().mockResolvedValue({ id: 'rule-1' }),
      updateAutopostRule: jest.fn().mockResolvedValue({ id: 'rule-1' }),
      deleteAutopostRule: jest.fn().mockResolvedValue({ id: 'rule-1' }),
      createChatAutopostRule: jest.fn().mockResolvedValue({ id: 'rule-1' }),
      updateChannelAutopostRule: jest.fn().mockResolvedValue({ id: 'rule-2' }),
    };
    const controller = new AdminAutopostController(managedAutopostService as never);
    const query = { entityType: 'chat' };
    const body = { payload: { text: 'Новости', scheduledSlots: [] } };

    await controller.getAutopostRules(user as never, query);
    await controller.getAutopostRule('rule-1', user as never);
    await controller.createAutopostRule(user as never, body);
    await controller.updateAutopostRule('rule-1', user as never, body);
    await controller.deleteAutopostRule('rule-1', user as never);
    await controller.createChatAutopostRule('chat-1', user as never, body);
    await controller.updateChannelAutopostRule('channel-1', 'rule-2', user as never, body);

    expect(managedAutopostService.listAutopostRules).toHaveBeenCalledWith(user, query);
    expect(managedAutopostService.getAutopostRule).toHaveBeenCalledWith('rule-1', user);
    expect(managedAutopostService.createAutopostRule).toHaveBeenCalledWith(user, body);
    expect(managedAutopostService.updateAutopostRule).toHaveBeenCalledWith('rule-1', user, body);
    expect(managedAutopostService.deleteAutopostRule).toHaveBeenCalledWith('rule-1', user);
    expect(managedAutopostService.createChatAutopostRule).toHaveBeenCalledWith(
      'chat-1',
      user,
      body,
    );
    expect(managedAutopostService.updateChannelAutopostRule).toHaveBeenCalledWith(
      'channel-1',
      'rule-2',
      user,
      body,
    );
  });

  it('routes managed entity reads through the managed entities domain service', async () => {
    const managedEntitiesService = {
      listChats: jest.fn().mockResolvedValue([]),
    };
    const controller = new AdminManagedEntitiesController(managedEntitiesService as never);

    await controller.getChats(
      user as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );

    expect(managedEntitiesService.listChats).toHaveBeenCalled();
  });

  it('routes managed entity onboarding diagnostics through the managed entities domain service', async () => {
    const managedEntitiesService = {
      getOnboardingDiagnostics: jest.fn().mockResolvedValue({ entityType: 'chat' }),
    };
    const controller = new AdminManagedEntitiesController(managedEntitiesService as never);

    await controller.getManagedEntityOnboardingDiagnostics('chat', user as never);

    expect(managedEntitiesService.getOnboardingDiagnostics).toHaveBeenCalledWith('chat', user);
  });

  it('routes settings reads through the settings domain service', async () => {
    const adminSettingsService = {
      getSettings: jest.fn().mockResolvedValue({}),
    };
    const controller = new AdminSettingsController(adminSettingsService as never);

    await controller.getSettings('chat-1', user as never);

    expect(adminSettingsService.getSettings).toHaveBeenCalledWith('chat-1', user);
  });

  it('routes moderation allowlist writes through the manual moderation domain service', async () => {
    const manualModerationService = {
      removeDomain: jest.fn().mockResolvedValue({ ok: true }),
    };
    const controller = new AdminManualModerationController(manualModerationService as never);

    await controller.removeDomainByQuery('chat-1', 'domain:docs.max.ru', user as never);

    expect(manualModerationService.removeDomain).toHaveBeenCalledWith(
      'chat-1',
      user,
      'domain:docs.max.ru',
    );
  });

  it('maps a busy manual moderation lock to an HTTP conflict', async () => {
    const manualModerationService = {
      applyManualModerationAction: jest
        .fn()
        .mockRejectedValue(
          new ModerationSanctionStateLockBusyError({ chatId: 'chat-1', userId: 'user-2' }),
        ),
    };
    const controller = new AdminManualModerationController(manualModerationService as never);

    const error = await controller
      .applyManualModerationAction('chat-1', 'user-2', user as never, {
        action: 'BAN',
        scope: 'current_chat',
      })
      .then(
        () => null,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toEqual({
      code: 'MODERATION_ACTION_IN_PROGRESS',
      message: 'Действие для этого участника уже выполняется. Дождитесь результата.',
    });
  });

  it('maps an unavailable manual moderation lock to a safe HTTP response', async () => {
    const manualModerationService = {
      applyManualModerationAction: jest.fn().mockRejectedValue(
        new ModerationSanctionStateLockUnavailableError({
          chatId: 'chat-1',
          userId: 'user-2',
        }),
      ),
    };
    const controller = new AdminManualModerationController(manualModerationService as never);

    const error = await controller
      .applyManualModerationAction('chat-1', 'user-2', user as never, {
        action: 'BAN',
        scope: 'current_chat',
      })
      .then(
        () => null,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toEqual({
      code: 'MODERATION_ACTION_STATUS_UNCERTAIN',
      message: 'Статус действия временно недоступен. Обновите список участников.',
      retryable: false,
    });
  });

  it('routes dialog messages through the channel dialog domain service', async () => {
    const channelDialogService = {
      createChatDialogMessage: jest.fn().mockResolvedValue({ id: 'message-1' }),
    };
    const controller = new AdminDialogController(channelDialogService as never);
    const body = { text: 'Есть вопрос' };

    await controller.createChatDialogMessage('chat-1', 'comments', user as never, body);

    expect(channelDialogService.createChatDialogMessage).toHaveBeenCalledWith(
      'chat-1',
      user,
      'comments',
      body,
      'moderation',
    );
  });
});
