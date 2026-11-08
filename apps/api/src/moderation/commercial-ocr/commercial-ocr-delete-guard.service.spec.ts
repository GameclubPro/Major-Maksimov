import type { AutomaticDeleteAuthorAccessService } from '../../max/automatic-delete-author-access.service';
import { extractLogicalPhotoAlbumResult } from '../photo-duplicate/photo-attachment-extractor';

import {
  buildCommercialOcrDeleteBinding,
  COMMERCIAL_OCR_DELETE_RULE_CODE,
  CommercialOcrDeleteGuardService,
  extractCommercialOcrDeleteSource,
  parseCommercialOcrDeleteBinding,
  type CommercialOcrPolicySettings,
} from './commercial-ocr-delete-guard.service';
import { COMMERCIAL_OCR_DECISION_POLICY_VERSION } from './commercial-ocr-decision-policy';
import { COMMERCIAL_OCR_DEFAULT_VERSION } from './commercial-ocr.queue';
import type { CommercialOcrEnforcementAuthority } from './commercial-ocr-runtime-policy.service';
import { fingerprintCommercialOcrSettingsProfile } from './commercial-ocr-settings-profile';

const sourceCreatedAt = '2026-08-12T08:00:00.000Z';
const controlExpiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
const ocrDeadlineAt = new Date(Date.now() + 30 * 60_000).toISOString();
const commercialPolicySettings: CommercialOcrPolicySettings = {
  commercialAdsFilterEnabled: true,
  commercialAdsSensitivity: 'BALANCED' as const,
  commercialAdsWarnThreshold: 45,
  commercialAdsDeleteThreshold: 65,
};
const baseInput = {
  intentId: 'intent-1',
  chatId: 'chat-1',
  messageId: 'message-1',
  subjectUserId: 'user-1',
  sourceMessageAt: new Date(sourceCreatedAt),
  botId: 'delete-bot',
};

describe('CommercialOcrDeleteGuardService', () => {
  it.each([false, true])(
    'retains the OCR member requirement after a saved role decision, absent=%s',
    async (absent) => {
      const resolve = jest
        .fn<
          ReturnType<AutomaticDeleteAuthorAccessService['resolve']>,
          Parameters<AutomaticDeleteAuthorAccessService['resolve']>
        >()
        .mockResolvedValue({
          initialized: true,
          revision: '1',
          isAdmin: false,
          member: absent
            ? null
            : { userId: 'user-1', isAdmin: true, isOwner: false, permissions: [] },
        });
      const h = buildHarness({ authorAccess: { resolve } });
      if (absent) {
        await expect(h.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
          code: 'commercial_ocr_author_access_unknown',
        });
        expect(h.maxClient.getExactMessageRow).not.toHaveBeenCalled();
        expect(h.participantImmunity.consumeForMessage).not.toHaveBeenCalled();
      } else {
        await expect(h.service.assertIntentStillActionable(baseInput)).resolves.toBe('allowed');
      }
      expect(h.maxClient.getChatMemberAccess).not.toHaveBeenCalled();
    },
  );

  const baselineAuthority: CommercialOcrEnforcementAuthority = {
    kind: 'BASELINE',
    behaviorIdentitySha256: 'a'.repeat(64),
    nativeBehaviorIdentitySha256: 'b'.repeat(64),
    settingsFingerprint: fingerprintCommercialOcrSettingsProfile(commercialPolicySettings),
  };

  it('dispatches a baseline binding only under the same release/native/profile authority', async () => {
    const harness = buildHarness({ bindingAuthority: baselineAuthority });
    await expect(harness.service.assertIntentStillActionable(baseInput)).resolves.toBe('allowed');
    expect(harness.participantImmunity.consumeForMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...baselineAuthority, behaviorIdentitySha256: 'c'.repeat(64) },
    { ...baselineAuthority, nativeBehaviorIdentitySha256: 'c'.repeat(64) },
    { ...baselineAuthority, settingsFingerprint: 'c'.repeat(64) },
    { kind: 'CERTIFIED' as const, controlRevision: 1, controlExpiresAt },
  ])('rejects a pending baseline binding after its authority changes: %o', async (changed) => {
    const harness = buildHarness({ bindingAuthority: baselineAuthority });
    const active = {
      ...runtimeResult('authorized'),
      mode: 'baseline',
      authority: baselineAuthority,
    };
    harness.runtimePolicy.resolveEffectivePolicy
      .mockResolvedValueOnce(active)
      .mockResolvedValueOnce({ ...active, authority: changed });
    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'commercial_ocr_runtime_control_changed',
    });
  });

  it('rejects legacy and ambiguous baseline certificate fields rather than inventing authority', () => {
    const binding = bindingFor(messageRow(), {}, undefined, baselineAuthority);
    expect(parseCommercialOcrDeleteBinding({ ...binding, version: 4 })).toBeNull();
    expect(parseCommercialOcrDeleteBinding({ ...binding, controlRevision: 1 })).toBeNull();
    expect(
      parseCommercialOcrDeleteBinding({
        ...binding,
        authority: { ...baselineAuthority, controlExpiresAt },
      }),
    ).toBeNull();
    expect(
      parseCommercialOcrDeleteBinding({
        ...binding,
        authority: { ...baselineAuthority, nativeBehaviorIdentitySha256: 'invalid' },
      }),
    ).toBeNull();
  });

  it('builds and parses a versioned binding without retaining caption or photo ids', () => {
    const binding = bindingFor(messageRow());

    expect(parseCommercialOcrDeleteBinding({ commercialOcrBinding: binding })).toEqual(binding);
    expect(binding).toMatchObject({
      version: 5,
      policyVersion: COMMERCIAL_OCR_DECISION_POLICY_VERSION,
      ocrVersion: COMMERCIAL_OCR_DEFAULT_VERSION,
      senderId: 'user-1',
      expectedImageCount: 2,
    });
    expect(binding.commercialPolicyDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(binding)).not.toContain('photo-1');
    expect(JSON.stringify(binding)).not.toContain('Buy now');
    expect(JSON.stringify(binding)).not.toContain('BALANCED');
  });

  it.each([
    { commercialAdsFilterEnabled: false },
    { commercialAdsSensitivity: 'STRICT' as const },
    { commercialAdsWarnThreshold: 46 },
    { commercialAdsDeleteThreshold: 66 },
  ])('binds the delete intent to commercial policy fields: %o', (settingsOverride) => {
    const original = bindingFor(messageRow());
    const changed = bindingFor(messageRow(), settingsOverride);

    expect(changed.commercialPolicyDigest).not.toBe(original.commercialPolicyDigest);
  });

  it('rejects legacy bindings and bindings without a valid commercial policy digest', () => {
    const binding = bindingFor(messageRow());

    expect(parseCommercialOcrDeleteBinding({ ...binding, version: 1 })).toBeNull();
    expect(
      parseCommercialOcrDeleteBinding({ ...binding, commercialPolicyDigest: undefined }),
    ).toBeNull();
    expect(parseCommercialOcrDeleteBinding({ ...binding, commercialPolicyDigest: 'invalid' })).toBe(
      null,
    );
  });

  it('allows an OCR-only deletion only after fresh exact content and immunity checks', async () => {
    const harness = buildHarness();

    await expect(harness.service.assertIntentStillActionable(baseInput)).resolves.toBe('allowed');

    expect(harness.maxClient.getChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      'user-1',
      expect.objectContaining({ botId: 'delete-bot', bypassCache: true }),
    );
    expect(harness.maxClient.getExactMessageRow).toHaveBeenCalledWith(
      'chat-1',
      'message-1',
      expect.objectContaining({ botId: 'delete-bot', bypassCache: true }),
    );
    expect(harness.participantImmunity.consumeForMessage).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'message-1',
      scope: 'commercial_ocr_delete',
      nightModeTimezone: 'Europe/Moscow',
    });
    expect(harness.runtimePolicy.resolveEffectivePolicy).toHaveBeenCalledWith({
      chatId: 'chat-1',
      settingsFingerprint: fingerprintCommercialOcrSettingsProfile(commercialPolicySettings),
    });
    expect(harness.prisma.chatSettings.findUnique).toHaveBeenCalledTimes(2);
    expect(harness.runtimePolicy.resolveEffectivePolicy).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      label: 'immunity is granted after intent creation',
      options: { immunityResult: 'granted' as const },
      code: 'commercial_ocr_participant_immune',
    },
    {
      label: 'immunity cannot be checked',
      options: { immunityError: new Error('db down') },
      code: 'commercial_ocr_participant_immunity_unknown',
    },
  ])('blocks dispatch when $label', async ({ options, code }) => {
    const harness = buildHarness(options);

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code,
    });
  });

  it('rejects changed caption, photo order, author or source timestamp', async () => {
    for (const exactRow of [
      messageRow({ caption: 'Changed text' }),
      messageRow({ photoIds: ['photo-2', 'photo-1'] }),
      messageRow({ senderId: 'user-2' }),
      messageRow({ timestamp: '2026-08-12T08:00:01.000Z' }),
    ]) {
      const harness = buildHarness({ exactRow });
      await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
        code: 'commercial_ocr_message_changed',
      });
    }
  });

  it.each([
    {
      label: 'bot author',
      sender: { user_id: 'user-1', is_bot: true },
      code: 'commercial_ocr_author_immune',
    },
    {
      label: 'service author',
      sender: { user_id: 'user-1', type: 'service' },
      code: 'commercial_ocr_author_immune',
    },
    {
      label: 'unknown author kind',
      sender: { user_id: 'user-1' },
      code: 'commercial_ocr_message_ambiguous',
    },
  ])('rejects an exact MAX row with $label', async ({ sender, code }) => {
    const harness = buildHarness({ exactRow: messageRow({ sender }) });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code,
    });
    expect(harness.participantImmunity.consumeForMessage).not.toHaveBeenCalled();
  });

  it('fails open when the exact message has only URL-derived image identity', async () => {
    const exactRow = messageRow();
    const attachments = (exactRow.body as { attachments: Array<Record<string, unknown>> })
      .attachments;
    attachments[0] = {
      type: 'image',
      payload: { url: 'https://i.oneme.ru/no-stable-photo-id' },
    };
    const harness = buildHarness({ exactRow });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'commercial_ocr_message_ambiguous',
    });
  });

  it.each([
    {
      label: 'rollout authorization is revoked',
      config: { COMMERCIAL_OCR_ROLLOUT_MODE: 'off' },
      code: 'commercial_ocr_runtime_revoked',
    },
    {
      label: 'OCR behavior version changed',
      bindingOcrVersion: 'tesseract-rus-eng-v1',
      code: 'commercial_ocr_version_changed',
    },
  ])('rejects when $label', async ({ config, bindingOcrVersion, code }) => {
    const harness = buildHarness({ config, bindingOcrVersion });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code,
    });
    expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
  });

  it('keeps a transient runtime-control read failure retryable', async () => {
    const harness = buildHarness({ runtimeEnforcementAuthority: 'unavailable' });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'commercial_ocr_runtime_control_unavailable',
    });
    expect(harness.maxClient.getChatMemberAccess).not.toHaveBeenCalled();
    expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
  });

  it('terminally revokes a retry when its current settings profile is not certified', async () => {
    const harness = buildHarness({ certifiedSettingsFingerprints: ['f'.repeat(64)] });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'commercial_ocr_runtime_revoked',
    });
    expect(harness.runtimePolicy.resolveEffectivePolicy).toHaveBeenCalledWith({
      chatId: 'chat-1',
      settingsFingerprint: fingerprintCommercialOcrSettingsProfile(commercialPolicySettings),
    });
    expect(harness.maxClient.getChatMemberAccess).not.toHaveBeenCalled();
    expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
  });

  it('rejects after filter disable or a fresh local/remote admin result', async () => {
    const disabled = buildHarness({ filterEnabled: false });
    await expect(disabled.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'commercial_ocr_filter_disabled',
    });

    const localAdmin = buildHarness({ adminUserIds: ['user-1'] });
    await expect(localAdmin.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'commercial_ocr_admin_immune',
    });

    const remoteAdmin = buildHarness({
      remoteAccess: { userId: 'user-1', isAdmin: true, isOwner: false, permissions: [] },
    });
    await expect(remoteAdmin.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'commercial_ocr_admin_immune',
    });
  });

  it.each([
    { commercialAdsSensitivity: 'STRICT' as const },
    { commercialAdsWarnThreshold: 46 },
    { commercialAdsDeleteThreshold: 66 },
  ])('rejects a fresh commercial policy change before MAX calls: %o', async (settingsOverride) => {
    const harness = buildHarness({ settingsOverride });

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code: 'commercial_ocr_policy_changed',
    });
    expect(harness.runtimePolicy.resolveEffectivePolicy).not.toHaveBeenCalled();
    expect(harness.maxClient.getChatMemberAccess).not.toHaveBeenCalled();
    expect(harness.maxClient.getExactMessageRow).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: 'commercial policy changes',
      finalSettings: settingsRow({
        settingsOverride: { commercialAdsSensitivity: 'STRICT' as const },
      }),
      code: 'commercial_ocr_policy_changed',
    },
    {
      label: 'the sender becomes a local administrator',
      finalSettings: settingsRow({ adminUserIds: ['user-1'] }),
      code: 'commercial_ocr_admin_immune',
    },
    {
      label: 'the immunity timezone changes',
      finalSettings: settingsRow({ nightModeTimezone: 'UTC' }),
      code: 'commercial_ocr_participant_immunity_unknown',
    },
  ])('blocks dispatch when $label during final MAX checks', async ({ finalSettings, code }) => {
    const harness = buildHarness();
    harness.prisma.chatSettings.findUnique
      .mockResolvedValueOnce(settingsRow())
      .mockResolvedValueOnce(finalSettings);

    await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
      code,
    });

    expect(harness.maxClient.getChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(harness.maxClient.getExactMessageRow).toHaveBeenCalledTimes(1);
    expect(harness.participantImmunity.consumeForMessage).toHaveBeenCalledTimes(1);
    expect(harness.runtimePolicy.resolveEffectivePolicy).toHaveBeenCalledTimes(1);
  });

  it.each([
    { authority: 'revoked' as const, code: 'commercial_ocr_runtime_revoked' },
    {
      authority: 'unavailable' as const,
      code: 'commercial_ocr_runtime_control_unavailable',
    },
  ])(
    'blocks dispatch when final runtime authorization becomes $authority',
    async ({ authority, code }) => {
      const harness = buildHarness();
      harness.runtimePolicy.resolveEffectivePolicy
        .mockResolvedValueOnce(runtimeResult('authorized'))
        .mockResolvedValueOnce(runtimeResult(authority));

      await expect(harness.service.assertIntentStillActionable(baseInput)).rejects.toMatchObject({
        code,
      });

      expect(harness.prisma.chatSettings.findUnique).toHaveBeenCalledTimes(2);
      expect(harness.runtimePolicy.resolveEffectivePolicy).toHaveBeenCalledTimes(2);
      expect(harness.participantImmunity.consumeForMessage).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps validating its durable OCR binding when an independent reason is attached', async () => {
    const harness = buildHarness({ independentReason: true });

    await expect(harness.service.assertIntentStillActionable(baseInput)).resolves.toBe('allowed');
    expect(harness.maxClient.getExactMessageRow).toHaveBeenCalledTimes(1);
  });

  it('reports exact message absence without treating arbitrary lookup errors as absence', async () => {
    const absent = buildHarness({ exactRow: null });
    await expect(absent.service.assertIntentStillActionable(baseInput)).resolves.toBe('absent');

    const lookupError = buildHarness();
    lookupError.maxClient.getExactMessageRow.mockRejectedValueOnce(new Error('transport failed'));
    await expect(lookupError.service.assertIntentStillActionable(baseInput)).rejects.toThrow(
      'transport failed',
    );
  });
});

describe('extractCommercialOcrDeleteSource', () => {
  it('extracts exact message identity, direct caption and ordered stable photos', () => {
    expect(extractCommercialOcrDeleteSource(messageRow())).toEqual({
      messageId: 'message-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      sourceCreatedAt,
      caption: 'Buy now',
      orderedPhotoIds: ['photo-1', 'photo-2'],
    });
  });

  it('uses canonical legacy and nested forward content while excluding reply previews', () => {
    const row = messageRow({ caption: 'Current offer', photoIds: ['photo-1'] });
    Object.assign(row, {
      link: {
        type: 'forward',
        message: {
          body: {
            text: 'Modern forward',
            attachments: [{ type: 'image', payload: { photo_id: 'photo-modern' } }],
            forwarded_message: {
              content: {
                caption: 'Nested forward',
                attachments: [{ type: 'image', payload: { photo_id: 'photo-nested' } }],
              },
            },
          },
        },
      },
      content: {
        forwarded_messages: [
          {
            body: {
              text: 'Legacy forward',
              attachments: [{ type: 'image', payload: { photo_id: 'photo-legacy' } }],
            },
          },
          {
            type: 'reply',
            text: 'Hidden reply',
            attachments: [{ type: 'image', payload: { photo_id: 'photo-reply' } }],
          },
        ],
      },
    });

    expect(extractCommercialOcrDeleteSource(row)).toEqual({
      messageId: 'message-1',
      chatId: 'chat-1',
      senderId: 'user-1',
      sourceCreatedAt,
      caption: 'Current offer Modern forward Nested forward Legacy forward',
      orderedPhotoIds: ['photo-1', 'photo-modern', 'photo-nested', 'photo-legacy'],
    });
  });

  it('matches canonical webhook album content for the same raw message', () => {
    const row = messageRow({ caption: 'Current offer', photoIds: ['photo-1'] });
    Object.assign(row.body as Record<string, unknown>, {
      forwarded_message: {
        body: {
          text: 'Legacy forward',
          attachments: [{ type: 'image', payload: { photo_id: 'photo-forward' } }],
        },
      },
    });
    const update = {
      updateId: 'update-parity-1',
      type: 'message_created',
      message: {
        messageId: 'message-1',
        chatId: 'chat-1',
        senderId: 'user-1',
        text: 'Current offer Legacy forward',
        createdAt: sourceCreatedAt,
      },
      raw: { update_type: 'message_created', message: row },
    } as const;
    const album = extractLogicalPhotoAlbumResult(update);
    const source = extractCommercialOcrDeleteSource(row);

    expect(album.kind).toBe('complete');
    expect(source).not.toBeNull();
    if (album.kind !== 'complete' || !source) {
      throw new Error('Canonical extraction fixture is incomplete');
    }
    expect({
      caption: album.album.caption,
      photoIds: album.album.images.map((image) => image.photoId),
    }).toEqual({ caption: source.caption, photoIds: source.orderedPhotoIds });
  });
});

function buildHarness(
  options: {
    exactRow?: Record<string, unknown> | null;
    independentReason?: boolean;
    filterEnabled?: boolean;
    adminUserIds?: string[];
    remoteAccess?: {
      userId: string | null;
      isAdmin: boolean;
      isOwner: boolean;
      permissions: string[];
    } | null;
    config?: Record<string, unknown>;
    settingsOverride?: Partial<typeof commercialPolicySettings>;
    immunityResult?: 'granted' | 'not_granted';
    immunityError?: Error;
    runtimeEnforcementAuthority?: 'authorized' | 'revoked' | 'unavailable';
    certifiedSettingsFingerprints?: readonly string[];
    bindingOcrVersion?: string;
    bindingAuthority?: CommercialOcrEnforcementAuthority;
    authorAccess?: Pick<AutomaticDeleteAuthorAccessService, 'resolve'>;
  } = {},
) {
  const exactRow = options.exactRow === undefined ? messageRow() : options.exactRow;
  const binding = bindingFor(messageRow(), {}, options.bindingOcrVersion, options.bindingAuthority);
  const prisma = {
    moderationDeleteIntentReason: {
      findMany: jest.fn().mockResolvedValue([
        {
          ruleCode: COMMERCIAL_OCR_DELETE_RULE_CODE,
          metadata: { commercialOcrBinding: binding },
        },
        ...(options.independentReason ? [{ ruleCode: 'BLOCKED_WORD_DELETE', metadata: null }] : []),
      ]),
    },
    chatSettings: {
      findUnique: jest.fn().mockResolvedValue(
        settingsRow({
          settingsOverride: options.settingsOverride,
          filterEnabled: options.filterEnabled,
          adminUserIds: options.adminUserIds,
        }),
      ),
    },
  };
  const maxClient = {
    getChatMemberAccess: jest
      .fn()
      .mockResolvedValue(
        options.remoteAccess === undefined
          ? { userId: 'user-1', isAdmin: false, isOwner: false, permissions: [] }
          : options.remoteAccess,
      ),
    getExactMessageRow: jest.fn().mockResolvedValue(exactRow),
  };
  const maxBotLinkService = { isKnownBotUserId: jest.fn().mockReturnValue(false) };
  const participantImmunity = {
    consumeForMessage: jest.fn().mockImplementation(async () => {
      if (options.immunityError) {
        throw options.immunityError;
      }
      return options.immunityResult ?? 'not_granted';
    }),
  };
  const runtimePolicy = {
    resolveEffectivePolicy: jest
      .fn()
      .mockImplementation(async (params: { settingsFingerprint: string }) => {
        const envEnabled = options.config?.COMMERCIAL_OCR_ROLLOUT_MODE !== 'off';
        const enforcementAuthority =
          options.runtimeEnforcementAuthority ?? (envEnabled ? 'authorized' : 'revoked');
        const settingsCertified =
          options.certifiedSettingsFingerprints?.includes(params.settingsFingerprint) ?? true;
        const enforce = envEnabled && enforcementAuthority === 'authorized' && settingsCertified;
        return {
          mode: enforce ? (options.config?.COMMERCIAL_OCR_ROLLOUT_MODE ?? 'on') : 'shadow',
          process: envEnabled,
          enforce,
          controlRevision: enforce ? 1 : null,
          controlExpiresAt: enforce ? controlExpiresAt : null,
          enforcementAuthority: settingsCertified ? enforcementAuthority : 'revoked',
          authority: enforce
            ? (options.bindingAuthority ?? {
                kind: 'CERTIFIED',
                controlRevision: 1,
                controlExpiresAt,
              })
            : null,
        };
      }),
  };
  const service = new CommercialOcrDeleteGuardService(
    prisma as never,
    maxClient as never,
    maxBotLinkService as never,
    participantImmunity as never,
    runtimePolicy as never,
    options.authorAccess as AutomaticDeleteAuthorAccessService | undefined,
  );
  return {
    service,
    prisma,
    maxClient,
    maxBotLinkService,
    participantImmunity,
    runtimePolicy,
  };
}

function settingsRow(
  options: {
    settingsOverride?: Partial<typeof commercialPolicySettings>;
    filterEnabled?: boolean;
    adminUserIds?: string[];
    nightModeTimezone?: string;
  } = {},
) {
  return {
    ...commercialPolicySettings,
    ...options.settingsOverride,
    commercialAdsFilterEnabled:
      options.filterEnabled ??
      options.settingsOverride?.commercialAdsFilterEnabled ??
      commercialPolicySettings.commercialAdsFilterEnabled,
    nightModeTimezone: options.nightModeTimezone ?? 'Europe/Moscow',
    chat: {
      admins: (options.adminUserIds ?? []).map((userId) => ({ userId })),
    },
  };
}

function runtimeResult(authority: 'authorized' | 'revoked' | 'unavailable') {
  const enforce = authority === 'authorized';
  return {
    mode: enforce ? 'on' : 'shadow',
    process: true,
    enforce,
    controlRevision: enforce ? 1 : null,
    controlExpiresAt: enforce ? controlExpiresAt : null,
    enforcementAuthority: authority,
    authority: enforce ? { kind: 'CERTIFIED', controlRevision: 1, controlExpiresAt } : null,
  };
}

function bindingFor(
  row: Record<string, unknown>,
  settingsOverride: Partial<typeof commercialPolicySettings> = {},
  ocrVersion = COMMERCIAL_OCR_DEFAULT_VERSION,
  authority?: CommercialOcrEnforcementAuthority,
) {
  const source = extractCommercialOcrDeleteSource(row);
  if (!source) {
    throw new Error('Fixture did not produce a commercial OCR source');
  }
  return buildCommercialOcrDeleteBinding({
    ocrVersion,
    settings: { ...commercialPolicySettings, ...settingsOverride },
    senderId: source.senderId,
    orderedPhotoIds: source.orderedPhotoIds,
    caption: source.caption,
    sourceCreatedAt: source.sourceCreatedAt,
    expectedImageCount: source.orderedPhotoIds.length,
    authority: authority ?? { kind: 'CERTIFIED', controlRevision: 1, controlExpiresAt },
    ocrDeadlineAt,
  });
}

function messageRow(
  options: {
    caption?: string;
    photoIds?: string[];
    senderId?: string;
    sender?: Record<string, unknown>;
    timestamp?: string;
  } = {},
): Record<string, unknown> {
  return {
    id: 'message-1',
    timestamp: options.timestamp ?? sourceCreatedAt,
    recipient: { chat_id: 'chat-1' },
    sender: options.sender ?? { user_id: options.senderId ?? 'user-1', is_bot: false },
    body: {
      mid: 'message-1',
      text: options.caption ?? 'Buy now',
      attachments: (options.photoIds ?? ['photo-1', 'photo-2']).map((photoId) => ({
        type: 'image',
        payload: { photo_id: photoId, url: `https://i.oneme.ru/${photoId}` },
      })),
    },
  };
}
