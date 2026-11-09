import {
  SanctionAction,
  buildModerationReleaseCallbackPayload,
  INCIDENT_EXTERNAL_FORWARD_FIXTURE,
  INCIDENT_EXTERNAL_URL,
  INCIDENT_PROFILE_MENTION_FORWARD_FIXTURE,
  ModerationService,
  withAutomaticMutePersistenceFixture,
  RuleEngineService,
  ADMIN_CONTACT_DISPLAY_NAME_LOOKUP_TIMEOUT_MS,
  userMention,
  majorExplanation,
  muteNotice,
  permanentBanNotice,
  linkWarnNotice,
  editedLinkWarnNotice,
  messageLimitsWarnNotice,
  messageLimitsBanNotice,
  expectImmediateDeleteMessage,
  expectImmediateBanMember,
  createRedisCounterMock,
  createSettings,
  createUpdate,
  createLiveNavigationEnvelopeUpdate,
  createLiveNavigationHarness,
  createNumericSenderLinkBanHarness,
  createPhotoAttachmentUpdate,
  createGroupRulesCallbackUpdate,
  createChannelSuggestionCallbackUpdate,
  createOldUpdate,
  createForwardedUpdate,
  createLinkedForwardUpdate,
  createVideoAttachmentUpdate,
  createStickerAttachmentUpdate,
  createVoiceAttachmentUpdate,
  createFileAttachmentUpdate,
  createMediaGroupMarkerUpdate,
  createForwardedVideoAttachmentUpdate,
  createForwardedVoiceAttachmentUpdate,
  createForwardedFileAttachmentUpdate,
  createImageFileAttachmentUpdate,
  createReplyToPhotoUpdate,
  type MaxUpdate,
} from './moderation.service.spec-support';
import type { EnsureModerationDeleteIntentInput } from './moderation-delete-intent.types';
import { MODERATION_ACTION_DISPATCH_TIMEOUT_MS } from './moderation.service.support';
import { fingerprintLinkRulesPolicy } from './link-rules-policy.runtime';

// FLAG: Template/orchestration mocks stop at the notice producer boundary. Real v3
// authority and original-stage preservation are covered by native multibot/guard suites.
jest.mock('./message-duplicate/message-duplicate-notice-proof', () => ({
  ...jest.requireActual('./message-duplicate/message-duplicate-notice-proof'),
  buildMessageDuplicateNoticeContext: jest.fn(async () => ({
    orchestrationFixture: 'duplicate-notice-handoff',
  })),
}));

function installGuardedDeleteExecutorFixture(service: ModerationService) {
  const dependencies = service as unknown as {
    prisma: { moderationEvent: { create: jest.Mock } };
    maxClient: { deleteMessage: jest.Mock };
  };
  const allowedRules = new Set([
    'MUTE_ACTIVE_DELETE',
    'NIGHT_MODE_DELETE',
    'MANUAL_GROUP_CLOSE_DELETE',
    'MESSAGE_COUNT_LIMIT_DELETE',
    'MESSAGE_RATE_LIMIT_DELETE',
    'PHOTO_RATE_LIMIT_DELETE',
  ]);
  // FLAG: The orchestration fixture confirms its exact reason through the durable
  // service; it never enables the unsupported unguarded runtime fallback.
  const executor = {
    ensureIntent: jest.fn(),
    getRolloutForInput: () => 'execute',
    ensureAndAttempt: jest.fn(async (input: EnsureModerationDeleteIntentInput) => {
      if (!input.ruleCode || !allowedRules.has(input.ruleCode))
        throw new Error('Guarded executor fixture received an unrelated rule');
      await dependencies.maxClient.deleteMessage(input.chatId, input.messageId, {
        immediate: true,
        trafficClass: 'critical',
        actionHealthLane: 'critical',
        sourceTag: 'moderation_delete',
        timeoutMs: MODERATION_ACTION_DISPATCH_TIMEOUT_MS,
        ignoreFailureMetricStatuses: [403, 404],
      });
      await dependencies.prisma.moderationEvent.create({
        data: {
          chatId: input.chatId,
          userId: input.subjectUserId,
          messageId: input.messageId,
          eventType: 'MESSAGE',
          ruleCode: input.ruleCode,
          action: SanctionAction.DELETE_MESSAGE,
          operator: 'BOT',
          maskedExcerpt: input.event?.maskedExcerpt,
          score: input.event?.score,
          metadata: input.event?.metadata,
        },
      });
      return {
        kind: 'confirmed',
        confirmed: true,
        intentId: 'navigation-fixture-intent',
        status: 'SUCCEEDED',
        botId: 'navigation-fixture-bot',
        verifiedReasonKeys: [input.reasonKey],
      };
    }),
  };
  Object.assign(service, { moderationDeleteIntentService: executor });
  return executor;
}

describe('ModerationService', () => {
  describe('live typed navigation moderation', () => {
    it('captures the selective policy fingerprint and suppresses a cached decision after policy replacement', async () => {
      const linkRulesPolicy = {
        version: 1,
        mode: 'DENY_SELECTED',
        rules: [{ id: 'deny', effect: 'DENY', kind: 'WEB_DOMAIN', target: 'blocked.example' }],
      };
      const harness = createLiveNavigationHarness({
        linkPolicy: 'ALLOWLIST_ONLY',
        linkRulesPolicy,
      });
      const ensureIntent = jest.fn().mockResolvedValue({
        intentId: 'link-rules-intent',
        rollout: 'execute',
        status: 'PENDING',
      });
      Object.assign(harness.service, {
        moderationDeleteIntentService: {
          getRolloutForInput: () => 'execute',
          ensureIntent,
          ensureAndAttempt: jest.fn().mockResolvedValue({
            kind: 'confirmed',
            confirmed: true,
            intentId: 'link-rules-intent',
            status: 'SUCCEEDED',
            botId: 'bot-1',
          }),
        },
      });
      const update = (messageId: string) =>
        createLiveNavigationEnvelopeUpdate(
          'message_created',
          {
            body: {
              mid: 'selective-link',
              text: 'blocked',
              markup: [{ type: 'link', from: 0, length: 7, url: 'https://blocked.example/path' }],
            },
          },
          { messageId },
        );
      await harness.service.handleUpdate(update('link-policy-original'));
      expect(ensureIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: expect.objectContaining({
            metadata: expect.objectContaining({
              linkRulesPolicySha256: fingerprintLinkRulesPolicy(linkRulesPolicy),
            }),
          }),
        }),
        { enqueue: false },
      );
      ensureIntent.mockClear();
      harness.prisma.chatSettings.findUnique.mockResolvedValue({
        linkRulesPolicy: { version: 1, mode: 'ALLOW_ALL', rules: [] },
        linkPolicyRevision: 8,
        linkPolicyEffectiveAt: new Date('2026-08-10T00:00:00.000Z'),
      });
      await harness.service.handleUpdate(update('link-policy-replaced'));
      expect(ensureIntent).not.toHaveBeenCalled();
    });

    it.each(['message_created', 'message_edited'] as const)(
      'deletes bypass URLs in direct and forwarded %s messages',
      async (type) => {
        for (const text of [
          'https://allowed.example@blocked.example/path',
          `https://blocked.example/${'a'.repeat(3_000)}`,
          `https://blocked.example/${'\u044f'.repeat(400)}`,
        ]) {
          for (const forwarded of [false, true]) {
            const harness = createLiveNavigationHarness({
              linkPolicy: 'ALLOWLIST_ONLY',
              cachedAllowlist: ['domain:allowed.example'],
            });
            const content = forwarded
              ? { body: { text: '' }, link: { type: 'forward', message: { text } } }
              : { body: { text } };
            const update = createLiveNavigationEnvelopeUpdate(type, content, {
              messageId: 'bypass-message',
            });

            await harness.service.handleUpdate(update);

            expectImmediateDeleteMessage(
              harness.maxClient.deleteMessage,
              'chat-1',
              'bypass-message',
            );
            expect(harness.prisma.violation.create).toHaveBeenCalledWith({
              data: expect.objectContaining({ ruleCode: 'LINK_BLOCKED' }),
            });
          }
        }
      },
    );

    const typedProfileAllowlist = 'max-profile:user-id%3A67123224';

    const staleLinkViolation = {
      ruleCode: 'LINK_BLOCKED',
      score: 0.9,
      reason: 'Link https://blocked.example/path is not in allowlist',
    };
    const staleBlockedDomainViolation = {
      ruleCode: 'MESSAGE_BLOCKED_DOMAIN',
      score: 0.9,
      reason: 'Blocked domain detected: blocked.example',
      metadata: {
        blockedDomain: 'blocked.example',
        matchedDomain: 'blocked.example',
        matchedLink: 'https://blocked.example/path',
      },
    };

    it.each(['message_created', 'message_edited'] as const)(
      'passes the trusted event revision for %s into duplicate state',
      async (type) => {
        const harness = createLiveNavigationHarness({ linkPolicy: 'BLOCKLIST_ONLY' });
        const update = createLiveNavigationEnvelopeUpdate(type, {
          body: { text: 'Обычное сообщение без ссылки' },
        });

        await harness.service.handleUpdate(update);

        expect(update.eventTimestampSource).toBe('payload');
        expect(harness.detectSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            duplicateStateEventType: type,
            duplicateStateEventTimestampMs: Date.parse('2026-08-11T02:56:00.000Z'),
            skipStatefulMessageLimits: type === 'message_edited',
          }),
        );
      },
    );

    it('does not use the ingress fallback timestamp as a duplicate revision', async () => {
      const harness = createLiveNavigationHarness({ linkPolicy: 'BLOCKLIST_ONLY' });
      const update: MaxUpdate = {
        ...createLiveNavigationEnvelopeUpdate('message_edited', {
          body: { text: 'Обычное сообщение без ссылки' },
        }),
        eventTimestampSource: 'ingress',
      };

      await harness.service.handleUpdate(update);

      expect(harness.detectSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          duplicateStateEventType: 'message_edited',
          duplicateStateEventTimestampMs: undefined,
          skipStatefulMessageLimits: true,
        }),
      );
    });

    it('persists live link deletion with a revision-scoped policy fence', async () => {
      const harness = createLiveNavigationHarness({
        linkPolicy: 'BLOCKLIST_ONLY',
        linkPolicyEffectiveAt: '2026-08-10T00:00:00.000Z',
      });
      const ensureIntent = jest.fn().mockResolvedValue({
        intentId: 'intent-link-1',
        rollout: 'execute',
        status: 'PENDING',
      });
      (harness.service as any).moderationDeleteIntentService = {
        getRolloutForInput: jest.fn().mockReturnValue('execute'),
        ensureIntent,
        ensureAndAttempt: jest.fn().mockResolvedValue({
          kind: 'confirmed',
          confirmed: true,
          intentId: 'intent-link-1',
          status: 'SUCCEEDED',
          botId: 'bot-1',
        }),
      };

      await harness.service.handleUpdate(
        createLiveNavigationEnvelopeUpdate(
          'message_created',
          INCIDENT_EXTERNAL_FORWARD_FIXTURE as unknown as Record<string, unknown>,
        ),
      );

      expect(ensureIntent).toHaveBeenCalledWith(
        expect.objectContaining({
          reasonKey: 'LINK_BLOCKED:violation-delete:r7',
          ruleCode: 'LINK_BLOCKED_DELETE',
          event: expect.objectContaining({
            metadata: expect.objectContaining({
              linkPolicyRevision: 7,
              linkPolicyEffectiveAt: '2026-08-10T00:00:00.000Z',
            }),
          }),
        }),
        { enqueue: false },
      );
    });

    it.each([
      {
        name: 'external forward from the 02:56 incident',
        type: 'message_created' as const,
        content: INCIDENT_EXTERNAL_FORWARD_FIXTURE,
        expectedKind: 'external_url',
        expectedTarget: INCIDENT_EXTERNAL_URL,
        expectedCarriers: ['link_markup', 'share_attachment'],
        plainTextClickabilityEnabled: false,
      },
      {
        name: 'external forward from the 02:56 incident after an edit',
        type: 'message_edited' as const,
        content: INCIDENT_EXTERNAL_FORWARD_FIXTURE,
        expectedKind: 'external_url',
        expectedTarget: INCIDENT_EXTERNAL_URL,
        expectedCarriers: ['link_markup', 'share_attachment'],
        plainTextClickabilityEnabled: false,
      },
    ])('deletes $name in BLOCKLIST_ONLY mode', async (scenario) => {
      const harness = createLiveNavigationHarness({
        linkPolicy: 'BLOCKLIST_ONLY',
        plainTextClickabilityEnabled: scenario.plainTextClickabilityEnabled,
      });
      const update = createLiveNavigationEnvelopeUpdate(
        scenario.type,
        scenario.content as unknown as Record<string, unknown>,
        { messageId: `msg-${scenario.type}-${scenario.expectedKind}` },
      );

      await harness.service.handleUpdate(update);

      expect(update.type).toBe(scenario.type);
      expectImmediateDeleteMessage(
        harness.maxClient.deleteMessage,
        'chat-1',
        `msg-${scenario.type}-${scenario.expectedKind}`,
      );
      expect(harness.prisma.violation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-1',
          ruleCode: 'LINK_BLOCKED',
        }),
      });

      const navigationTargets = harness.detectSpy.mock.calls[0]?.[0].navigationTargets ?? [];
      const matchedTarget = navigationTargets.find(
        (target) =>
          target.kind === scenario.expectedKind &&
          target.normalizedTarget === scenario.expectedTarget,
      );
      expect(matchedTarget).toEqual(
        expect.objectContaining({
          enforceable: true,
          origins: expect.arrayContaining(
            scenario.expectedCarriers.map((carrier) =>
              expect.objectContaining({
                carrier,
                provenance: 'visible_forward',
                enforcement: 'eligible',
              }),
            ),
          ),
        }),
      );
    });

    it.each([
      ['message_created', 'BLOCKLIST_ONLY'],
      ['message_edited', 'BLOCKLIST_ONLY'],
      ['message_created', 'ALLOWLIST_ONLY'],
      ['message_edited', 'ALLOWLIST_ONLY'],
    ] as const)('preserves a platform profile mention on %s under %s', async (type, linkPolicy) => {
      const harness = createLiveNavigationHarness({
        linkPolicy,
        profileMentionsEnabled: true,
      });

      await harness.service.handleUpdate(
        createLiveNavigationEnvelopeUpdate(
          type,
          INCIDENT_PROFILE_MENTION_FORWARD_FIXTURE as unknown as Record<string, unknown>,
        ),
      );

      expect(harness.detectSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          navigationTargets: [
            expect.objectContaining({
              kind: 'profile_mention',
              normalizedTarget: 'max://user/67123224',
              enforceable: true,
            }),
          ],
        }),
      );
      expect(harness.maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(harness.prisma.violation.create).not.toHaveBeenCalled();
      expect(harness.prisma.moderationEvent.create).not.toHaveBeenCalled();
      expect(harness.prisma.domainAllowlist.findMany).not.toHaveBeenCalled();
    });

    it.each(['message_created', 'message_edited'] as const)(
      'preserves direct multi-participant mentions on %s',
      async (type) => {
        const text = '😀 @first и @second';
        const first = '@first';
        const second = '@second';
        const harness = createLiveNavigationHarness({
          linkPolicy: 'BLOCKLIST_ONLY',
          profileMentionsEnabled: true,
        });

        await harness.service.handleUpdate(
          createLiveNavigationEnvelopeUpdate(type, {
            body: {
              text,
              markup: [
                {
                  type: 'user_mention',
                  from: text.indexOf(first),
                  length: first.length,
                  user_id: 67123224,
                },
                {
                  type: 'user_mention',
                  from: text.indexOf(second),
                  length: second.length,
                  user_link: second,
                },
              ],
            },
          }),
        );

        expect(harness.detectSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            navigationTargets: expect.arrayContaining([
              expect.objectContaining({ kind: 'profile_mention', target: 'max://user/67123224' }),
              expect.objectContaining({ kind: 'profile_mention', target: second }),
            ]),
          }),
        );
        expect(harness.maxClient.deleteMessage).not.toHaveBeenCalled();
        expect(harness.prisma.violation.create).not.toHaveBeenCalled();
      },
    );

    it('deletes an explicit HTTP URL with fuzzy text matching disabled by default', async () => {
      const harness = createLiveNavigationHarness({ linkPolicy: 'BLOCKLIST_ONLY' });
      const update = createLiveNavigationEnvelopeUpdate('message_created', {
        body: { text: 'Открыть https://blocked.example/path' },
      });

      await harness.service.handleUpdate(update);

      expect(harness.detectSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          navigationTargets: [
            expect.objectContaining({
              normalizedTarget: 'https://blocked.example/path',
              enforceable: true,
            }),
          ],
        }),
      );
      expectImmediateDeleteMessage(
        harness.maxClient.deleteMessage,
        'chat-1',
        'msg-live-navigation-message_created',
      );
    });

    it.each([
      ['external resource', 'https://outside.example/hidden'],
      ['MAX channel', 'https://max.ru/channels/blocked-channel'],
      ['custom-scheme resource', 'tg://resolve?domain=outside'],
    ])('deletes an @-shaped hyperlink to an %s', async (_kind, url) => {
      const label = '@participant';
      const harness = createLiveNavigationHarness({ linkPolicy: 'BLOCKLIST_ONLY' });

      await harness.service.handleUpdate(
        createLiveNavigationEnvelopeUpdate('message_created', {
          body: {
            text: label,
            markup: [{ type: 'link', from: 0, length: label.length, url }],
          },
        }),
      );

      expect(harness.detectSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          navigationTargets: [
            expect.objectContaining({
              kind: 'external_url',
              normalizedTarget: url,
              enforceable: true,
            }),
          ],
        }),
      );
      expectImmediateDeleteMessage(
        harness.maxClient.deleteMessage,
        'chat-1',
        'msg-live-navigation-message_created',
      );
    });

    it('does not delete a bare-domain candidate during explicit clickability rollback', async () => {
      const harness = createLiveNavigationHarness({
        linkPolicy: 'BLOCKLIST_ONLY',
        plainTextClickabilityEnabled: false,
      });

      await harness.service.handleUpdate(
        createLiveNavigationEnvelopeUpdate('message_created', {
          body: { text: 'Открыть example.com/blocked' },
        }),
      );

      expect(harness.detectSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          navigationTargets: [
            expect.objectContaining({
              normalizedTarget: 'https://example.com/blocked',
              enforceable: false,
            }),
          ],
        }),
      );
      expect(harness.maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(harness.prisma.violation.create).not.toHaveBeenCalled();
    });

    it('deletes a client-clickable bare domain by default', async () => {
      const harness = createLiveNavigationHarness({
        linkPolicy: 'BLOCKLIST_ONLY',
      });

      await harness.service.handleUpdate(
        createLiveNavigationEnvelopeUpdate('message_created', {
          body: { text: 'Открыть example.com/blocked' },
        }),
      );

      expect(harness.detectSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          navigationTargets: [
            expect.objectContaining({
              normalizedTarget: 'https://example.com/blocked',
              enforceable: true,
            }),
          ],
        }),
      );
      expectImmediateDeleteMessage(
        harness.maxClient.deleteMessage,
        'chat-1',
        'msg-live-navigation-message_created',
      );
    });

    it('deletes a forwarded Cyrillic bare domain without link markup by default', async () => {
      const harness = createLiveNavigationHarness({ linkPolicy: 'BLOCKLIST_ONLY' });
      await harness.service.handleUpdate(
        createLiveNavigationEnvelopeUpdate('message_created', {
          body: { text: '', markup: [{ type: 'heading', from: 0, length: 8 }] },
          link: { type: 'forward', message: { text: 'Наш сайт: иксфлоу.рф', markup: [] } },
        }),
      );
      expectImmediateDeleteMessage(
        harness.maxClient.deleteMessage,
        'chat-1',
        'msg-live-navigation-message_created',
      );
    });

    it('does not require an allowlist entry for a profile mention', async () => {
      const harness = createLiveNavigationHarness({
        linkPolicy: 'ALLOWLIST_ONLY',
        profileMentionsEnabled: true,
      });
      const update = createLiveNavigationEnvelopeUpdate(
        'message_created',
        INCIDENT_PROFILE_MENTION_FORWARD_FIXTURE as unknown as Record<string, unknown>,
      );

      await harness.service.handleUpdate(update);

      expect(harness.detectSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          domainAllowlist: [],
          navigationTargets: [
            expect.objectContaining({
              kind: 'profile_mention',
              normalizedTarget: 'max://user/67123224',
              enforceable: true,
            }),
          ],
        }),
      );
      expect(harness.prisma.domainAllowlist.findMany).not.toHaveBeenCalled();
      expect(harness.maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(harness.prisma.violation.create).not.toHaveBeenCalled();
      expect(harness.prisma.moderationEvent.create).not.toHaveBeenCalled();
    });

    it('checks a hyperlink href instead of separately blocking its URL-shaped label', async () => {
      const label = 'https://visible.example.com/path';
      const allowedTarget = 'https://allowed.example.com/path';
      const harness = createLiveNavigationHarness({
        linkPolicy: 'ALLOWLIST_ONLY',
        cachedAllowlist: [allowedTarget],
        freshAllowlist: [allowedTarget],
      });

      await harness.service.handleUpdate(
        createLiveNavigationEnvelopeUpdate('message_created', {
          body: {
            text: label,
            markup: [{ type: 'link', from: 0, length: label.length, url: allowedTarget }],
          },
        }),
      );

      expect(harness.detectSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          navigationTargets: [
            expect.objectContaining({
              normalizedTarget: allowedTarget,
              enforceable: true,
              origins: [expect.objectContaining({ carrier: 'link_markup' })],
            }),
          ],
        }),
      );
      expect(harness.maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(harness.prisma.violation.create).not.toHaveBeenCalled();
    });

    it('blocks ALLOWLIST_ONLY when any structured target is not allowlisted', async () => {
      const text = 'Профиль Сайт';
      const harness = createLiveNavigationHarness({
        linkPolicy: 'ALLOWLIST_ONLY',
        cachedAllowlist: [typedProfileAllowlist],
        freshAllowlist: [typedProfileAllowlist],
        profileMentionsEnabled: true,
      });
      const update = createLiveNavigationEnvelopeUpdate('message_created', {
        body: {
          text,
          markup: [
            {
              type: 'user_mention',
              from: 0,
              length: 'Профиль'.length,
              user_link: 'user/67123224',
            },
            {
              type: 'link',
              from: text.indexOf('Сайт'),
              length: 'Сайт'.length,
              url: 'https://blocked.example/path',
            },
          ],
        },
      });

      await harness.service.handleUpdate(update);

      expectImmediateDeleteMessage(
        harness.maxClient.deleteMessage,
        'chat-1',
        'msg-live-navigation-message_created',
      );
      expect(harness.prisma.moderationEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          ruleCode: 'LINK_BLOCKED_DELETE',
          metadata: expect.objectContaining({
            reason: 'Link https://blocked.example/path is not in allowlist',
          }),
        }),
      });
    });

    it('reintroduces a violation when a fresh empty allowlist removed a cached URL target', async () => {
      const harness = createLiveNavigationHarness({
        linkPolicy: 'ALLOWLIST_ONLY',
        cachedAllowlist: [INCIDENT_EXTERNAL_URL],
        freshAllowlist: [],
      });
      const update = createLiveNavigationEnvelopeUpdate(
        'message_created',
        INCIDENT_EXTERNAL_FORWARD_FIXTURE as unknown as Record<string, unknown>,
      );

      await harness.service.handleUpdate(update);

      const initialDetection = await harness.detectSpy.mock.results[0]?.value;
      expect(initialDetection.violations).toEqual([]);
      expect(harness.prisma.domainAllowlist.findMany).toHaveBeenCalledTimes(1);
      expectImmediateDeleteMessage(
        harness.maxClient.deleteMessage,
        'chat-1',
        'msg-live-navigation-message_created',
      );
      expect(harness.prisma.violation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ ruleCode: 'LINK_BLOCKED' }),
      });
    });

    it('fails open for allowlist-dependent violations when ALLOWLIST_ONLY recheck fails', async () => {
      const harness = createLiveNavigationHarness({
        linkPolicy: 'ALLOWLIST_ONLY',
        freshAllowlistError: new Error('database unavailable'),
      });
      harness.detectSpy.mockResolvedValue({
        violations: [staleLinkViolation, staleBlockedDomainViolation],
      });

      await harness.service.handleUpdate(
        createLiveNavigationEnvelopeUpdate('message_created', {
          body: { text: 'https://blocked.example/path' },
        }),
      );

      expect(harness.prisma.domainAllowlist.findMany).toHaveBeenCalledTimes(1);
      expect(harness.maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(harness.prisma.violation.create).not.toHaveBeenCalled();
      expect(harness.prisma.moderationEvent.create).not.toHaveBeenCalled();
    });

    it('keeps ordinary LINK_BLOCKED when BLOCKLIST_ONLY recheck fails', async () => {
      const harness = createLiveNavigationHarness({
        linkPolicy: 'BLOCKLIST_ONLY',
        freshAllowlistError: new Error('database unavailable'),
      });
      harness.detectSpy.mockResolvedValue({
        violations: [staleLinkViolation, staleBlockedDomainViolation],
      });

      await harness.service.handleUpdate(
        createLiveNavigationEnvelopeUpdate('message_created', {
          body: { text: 'https://blocked.example/path' },
        }),
      );

      expectImmediateDeleteMessage(
        harness.maxClient.deleteMessage,
        'chat-1',
        'msg-live-navigation-message_created',
      );
      expect(harness.prisma.violation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ ruleCode: 'LINK_BLOCKED' }),
      });
      expect(harness.prisma.violation.create).not.toHaveBeenCalledWith({
        data: expect.objectContaining({ ruleCode: 'MESSAGE_BLOCKED_DOMAIN' }),
      });
    });

    it('preserves independent violations when fresh allowlist recheck fails', async () => {
      const harness = createLiveNavigationHarness({
        linkPolicy: 'ALLOWLIST_ONLY',
        freshAllowlistError: new Error('database unavailable'),
      });
      harness.detectSpy.mockResolvedValue({
        violations: [
          staleLinkViolation,
          staleBlockedDomainViolation,
          { ruleCode: 'PROFANITY', score: 0.95, reason: 'Profanity detected' },
        ],
      });

      Object.assign(harness.service, {
        profanityDeleteGuard: {
          assertMessageStillActionable: jest.fn().mockResolvedValue('allowed'),
        },
      });

      harness.maxClient.deleteMessage.mockImplementation(async (...args: unknown[]) => {
        const options = args[2] as
          | { beforeImmediateDeleteMutation?: () => Promise<void> }
          | undefined;
        await options?.beforeImmediateDeleteMutation?.();
      });
      await harness.service.handleUpdate(
        createLiveNavigationEnvelopeUpdate('message_created', {
          body: { text: 'https://blocked.example/path' },
        }),
      );

      expectImmediateDeleteMessage(
        harness.maxClient.deleteMessage,
        'chat-1',
        'msg-live-navigation-message_created',
      );
      expect(harness.prisma.violation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ ruleCode: 'PROFANITY' }),
      });
      expect(harness.prisma.violation.create).not.toHaveBeenCalledWith({
        data: expect.objectContaining({ ruleCode: 'LINK_BLOCKED' }),
      });
      expect(harness.prisma.violation.create).not.toHaveBeenCalledWith({
        data: expect.objectContaining({ ruleCode: 'MESSAGE_BLOCKED_DOMAIN' }),
      });
    });

    it('never deletes typed navigation in ALERT_ONLY mode', async () => {
      const harness = createLiveNavigationHarness({ linkPolicy: 'ALERT_ONLY' });
      const update = createLiveNavigationEnvelopeUpdate(
        'message_created',
        INCIDENT_EXTERNAL_FORWARD_FIXTURE as unknown as Record<string, unknown>,
      );

      await harness.service.handleUpdate(update);

      expect(harness.detectSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          navigationTargets: [expect.objectContaining({ enforceable: true })],
        }),
      );
      expect(harness.prisma.domainAllowlist.findMany).not.toHaveBeenCalled();
      expect(harness.maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(harness.prisma.violation.create).not.toHaveBeenCalled();
    });

    it('ignores structured navigation inside reply quote metadata', async () => {
      const harness = createLiveNavigationHarness({ linkPolicy: 'BLOCKLIST_ONLY' });
      const update = createLiveNavigationEnvelopeUpdate('message_created', {
        body: { text: 'Обычный ответ' },
        link: {
          type: 'reply',
          message: {
            text: 'Ссылка',
            markup: [
              {
                type: 'link',
                from: 0,
                length: 'Ссылка'.length,
                url: 'https://quoted.example/path',
              },
            ],
            attachments: [{ type: 'share', payload: { url: 'https://quoted-share.example/path' } }],
          },
        },
      });

      await harness.service.handleUpdate(update);

      expect(harness.detectSpy).toHaveBeenCalledWith(
        expect.objectContaining({ navigationTargets: [] }),
      );
      expect(harness.maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(harness.prisma.violation.create).not.toHaveBeenCalled();
    });

    it('keeps malformed link markup shadow-only', async () => {
      const harness = createLiveNavigationHarness({ linkPolicy: 'BLOCKLIST_ONLY' });
      const update = createLiveNavigationEnvelopeUpdate('message_created', {
        body: {
          text: 'Скрытая кнопка',
          markup: [
            {
              type: 'link',
              from: 99,
              length: 6,
              url: 'https://shadow.example/path',
            },
          ],
        },
      });

      await harness.service.handleUpdate(update);

      expect(harness.detectSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          navigationTargets: [
            expect.objectContaining({
              normalizedTarget: 'https://shadow.example/path',
              enforceable: false,
              origins: [
                expect.objectContaining({
                  carrier: 'link_markup',
                  enforcement: 'shadow_only',
                  range: expect.objectContaining({
                    status: 'invalid',
                    invalidReason: 'out_of_bounds',
                  }),
                }),
              ],
            }),
          ],
        }),
      );
      expect(harness.maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(harness.prisma.violation.create).not.toHaveBeenCalled();
    });

    it('preserves chat-admin immunity for structured navigation', async () => {
      const harness = createLiveNavigationHarness({
        linkPolicy: 'BLOCKLIST_ONLY',
        adminUserIds: ['user-1'],
      });
      const update = createLiveNavigationEnvelopeUpdate(
        'message_created',
        INCIDENT_PROFILE_MENTION_FORWARD_FIXTURE as unknown as Record<string, unknown>,
      );

      await harness.service.handleUpdate(update);

      expect(harness.detectSpy).not.toHaveBeenCalled();
      expect(harness.maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(harness.prisma.violation.create).not.toHaveBeenCalled();
    });

    it('preserves configured runtime-bot immunity for structured navigation', async () => {
      const maxBotLinkService = {
        isKnownBotUserId: jest.fn().mockReturnValue(true),
      };
      const harness = createLiveNavigationHarness({
        linkPolicy: 'BLOCKLIST_ONLY',
        maxBotLinkService,
      });
      const update = createLiveNavigationEnvelopeUpdate(
        'message_created',
        INCIDENT_PROFILE_MENTION_FORWARD_FIXTURE as unknown as Record<string, unknown>,
        { senderId: 'runtime-bot-user-1', senderName: 'Служебный бот' },
      );

      await harness.service.handleUpdate(update);

      expect(maxBotLinkService.isKnownBotUserId).toHaveBeenCalledWith('runtime-bot-user-1');
      expect(harness.detectSpy).not.toHaveBeenCalled();
      expect(harness.maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(harness.prisma.violation.create).not.toHaveBeenCalled();
    });
  });

  it('prioritizes link moderation over duplicate escalation for link messages', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ linkBotMessageEnabled: true }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
        duplicateDecision: {
          action: 'MUTE',
          count: 3,
          threshold: 3,
          windowSec: 24 * 60 * 60,
          hash: 'dup-link-1',
          nextAction: 'BAN',
        },
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      majorExplanation('Алексей', 'удалено', 'эта ссылка запрещена настройками чата'),
    );
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'LINK_BLOCKED',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('deduplicates mirrored six-bot link violation deliveries by message id', async () => {
    const redisCounter = createRedisCounterMock();
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: true,
            linkWarnEnabled: true,
            linkMuteEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(1),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
      }),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      redisCounter as never,
    );

    for (let botIndex = 1; botIndex <= 6; botIndex += 1) {
      await service.handleUpdate({
        ...createUpdate(),
        updateId: `upd-bot-${botIndex}-link-1`,
        botId: `bot-${botIndex}`,
      });
    }

    expect(ruleEngine.detect).toHaveBeenCalledTimes(6);
    expect(prisma.violation.create).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      majorExplanation('Алексей', 'удалено', 'эта ссылка запрещена настройками чата'),
    );
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    const messageClaimCalls = redisCounter.incrementOncePerMemberWithTtl.mock.calls.filter(
      ([counterKey]) => counterKey === 'moderation:violation-message:v1:chat-1:LINK_BLOCKED',
    );
    expect(messageClaimCalls).toHaveLength(6);
    expect(new Set(messageClaimCalls.map(([, memberKey]) => memberKey)).size).toBe(1);
    expect(messageClaimCalls[0]).toEqual([
      'moderation:violation-message:v1:chat-1:LINK_BLOCKED',
      expect.stringContaining('moderation:violation-message:v1:chat-1:LINK_BLOCKED:msg:'),
      8 * 24 * 60 * 60,
    ]);
  });

  it('deduplicates mirrored multi-bot link violation deliveries with a persisted message claim', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: true,
            linkWarnEnabled: true,
            linkMuteEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(1),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      moderationViolationMessageClaim: {
        createMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 0 }),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
      }),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    await service.handleUpdate({
      ...createUpdate(),
      updateId: 'upd-owner-link-1',
      botId: 'bot-1',
    });
    await service.handleUpdate({
      ...createUpdate(),
      updateId: 'upd-standby-link-1',
      botId: 'bot-2',
    });

    expect(prisma.moderationViolationMessageClaim.createMany).toHaveBeenCalledTimes(2);
    expect(prisma.moderationViolationMessageClaim.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          dedupeKey: expect.stringMatching(/^v1:[a-f0-9]{64}$/u),
          chatId: 'chat-1',
          userId: 'user-1',
          messageId: 'msg-1',
          ruleCode: 'LINK_BLOCKED',
          updateType: 'message_created',
        }),
      ],
      skipDuplicates: true,
    });
    expect(ruleEngine.detect).toHaveBeenCalledTimes(2);
    expect(prisma.violation.create).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
  });

  it('deduplicates mirrored multi-bot active-mute deletes with a persisted message claim', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'manual-mute-1',
          createdAt: new Date(Date.now() - 5 * 60 * 1000),
          action: SanctionAction.MUTE,
          ruleCode: 'MANUAL_MUTE',
          metadata: { mutePermanent: true },
        }),
        create: jest.fn(),
      },
      moderationViolationMessageClaim: {
        createMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 0 }),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
      getChatMembersAccess: jest.fn().mockResolvedValue(
        new Map([
          [
            'user-1',
            {
              userId: 'user-1',
              isAdmin: false,
              isOwner: false,
              permissions: [],
            },
          ],
        ]),
      ),
    };
    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );
    installGuardedDeleteExecutorFixture(service);

    await service.handleUpdate({
      ...createUpdate(),
      updateId: 'upd-owner-muted-1',
      botId: 'bot-1',
    });
    await service.handleUpdate({
      ...createUpdate(),
      updateId: 'upd-standby-muted-1',
      botId: 'bot-2',
    });

    expect(prisma.moderationViolationMessageClaim.createMany).toHaveBeenCalledTimes(2);
    expect(prisma.moderationViolationMessageClaim.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-1',
          messageId: 'msg-1',
          ruleCode: 'MUTE_ACTIVE_DELETE',
          updateType: 'message_action',
        }),
      ],
      skipDuplicates: true,
    });
    expect(maxClient.deleteMessage).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1);
  });

  it('deduplicates mirrored multi-bot night-mode deletes with a persisted message claim', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            nightModeEnabled: true,
            nightModeStartTimeMinutes: 0,
            nightModeEndTimeMinutes: 0,
            nightModeBotMessageEnabled: false,
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      moderationViolationMessageClaim: {
        createMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 0 }),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
      getChatMembersAccess: jest.fn().mockResolvedValue(
        new Map([
          [
            'user-1',
            {
              userId: 'user-1',
              isAdmin: false,
              isOwner: false,
              permissions: [],
            },
          ],
        ]),
      ),
    };
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );
    installGuardedDeleteExecutorFixture(service);

    await service.handleUpdate({
      ...createUpdate(),
      updateId: 'upd-owner-night-1',
      botId: 'bot-1',
    });
    await service.handleUpdate({
      ...createUpdate(),
      updateId: 'upd-standby-night-1',
      botId: 'bot-2',
    });

    expect(prisma.moderationViolationMessageClaim.createMany).toHaveBeenCalledTimes(2);
    expect(prisma.moderationViolationMessageClaim.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-1',
          messageId: 'msg-1',
          ruleCode: 'NIGHT_MODE_DELETE',
          updateType: 'message_action',
        }),
      ],
      skipDuplicates: true,
    });
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1);
  });

  it('deduplicates mirrored multi-bot manual group close deletes with a persisted message claim', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            nightModeForceCloseEnabled: true,
            nightModeForceCloseForever: true,
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      moderationViolationMessageClaim: {
        createMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 0 }),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
      getChatMembersAccess: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );
    installGuardedDeleteExecutorFixture(service);

    await service.handleUpdate({
      ...createUpdate(),
      updateId: 'upd-owner-manual-close-1',
      botId: 'bot-1',
    });
    await service.handleUpdate({
      ...createUpdate(),
      updateId: 'upd-standby-manual-close-1',
      botId: 'bot-2',
    });

    expect(prisma.moderationViolationMessageClaim.createMany).toHaveBeenCalledTimes(2);
    expect(prisma.moderationViolationMessageClaim.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-1',
          messageId: 'msg-1',
          ruleCode: 'MANUAL_GROUP_CLOSE_DELETE',
          updateType: 'message_action',
        }),
      ],
      skipDuplicates: true,
    });
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1);
  });

  it('atomically fences persisted message actions across rules and users', async () => {
    const claimedDedupeKeys = new Set<string>();
    const claimedMessageActionKeys = new Set<string>();
    const createMany = jest.fn(
      async (args: {
        data: Array<{
          dedupeKey: string;
          messageActionKey: string | null;
          chatId: string;
          userId: string;
          messageId: string;
          ruleCode: string;
          updateType: string;
        }>;
      }) => {
        const claim = args.data[0];
        if (
          !claim ||
          claimedDedupeKeys.has(claim.dedupeKey) ||
          (claim.messageActionKey !== null && claimedMessageActionKeys.has(claim.messageActionKey))
        ) {
          return { count: 0 };
        }

        claimedDedupeKeys.add(claim.dedupeKey);
        if (claim.messageActionKey !== null) {
          claimedMessageActionKeys.add(claim.messageActionKey);
        }
        return { count: 1 };
      },
    );
    const service = new ModerationService(
      { moderationViolationMessageClaim: { createMany } } as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
    );
    const claims = service as unknown as {
      claimMessageScopedModerationAction: (params: {
        chatId: string;
        userId: string;
        messageId: string;
        ruleCode: string;
      }) => Promise<boolean>;
      claimMessageViolationProcessing: (params: {
        chatId: string;
        userId: string;
        messageId: string;
        ruleCode: string;
        updateType: string;
      }) => Promise<boolean>;
    };

    const concurrentResults = await Promise.all([
      claims.claimMessageScopedModerationAction({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'NIGHT_MODE_DELETE',
      }),
      claims.claimMessageScopedModerationAction({
        chatId: 'chat-1',
        userId: 'user-2',
        messageId: 'msg-1',
        ruleCode: 'DUPLICATE',
      }),
    ]);
    const otherChatResult = await claims.claimMessageScopedModerationAction({
      chatId: 'chat-2',
      userId: 'user-2',
      messageId: 'msg-1',
      ruleCode: 'DUPLICATE',
    });
    const ordinaryViolationResult = await claims.claimMessageViolationProcessing({
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'msg-1',
      ruleCode: 'LINK_BLOCKED',
      updateType: 'message_created',
    });

    expect(concurrentResults).toEqual([true, false]);
    expect(otherChatResult).toBe(true);
    expect(ordinaryViolationResult).toBe(true);
    const persistedClaims = createMany.mock.calls.map(([args]) => args.data[0]!);
    expect(persistedClaims[0]?.messageActionKey).toMatch(/^v1:[a-f0-9]{64}$/u);
    expect(persistedClaims[1]?.messageActionKey).toBe(persistedClaims[0]?.messageActionKey);
    expect(persistedClaims[1]?.dedupeKey).not.toBe(persistedClaims[0]?.dedupeKey);
    expect(persistedClaims[2]?.messageActionKey).not.toBe(persistedClaims[0]?.messageActionKey);
    expect(persistedClaims[3]?.messageActionKey).toBeNull();
  });

  it('blocks generic actions after an ambiguous insert even when PostgreSQL confirms ownership', async () => {
    let storedClaim: Record<string, unknown> | undefined;
    let attempt = 0;
    const createMany = jest.fn(
      async (args: { data: Array<Record<string, unknown>> }): Promise<{ count: number }> => {
        attempt += 1;
        if (attempt === 1) {
          storedClaim = args.data[0];
          throw new Error('connection reset after commit');
        }
        return { count: 0 };
      },
    );
    const findUnique = jest.fn().mockImplementation(async () => storedClaim);
    const redisCounter = { incrementOncePerMemberWithTtl: jest.fn() };
    const service = new ModerationService(
      { moderationViolationMessageClaim: { createMany, findUnique } } as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      redisCounter as never,
    );
    const claim = (service as any).claimMessageScopedModerationAction.bind(service);

    await expect(
      Promise.all([
        claim({ chatId: 'chat-1', userId: 'user-1', messageId: 'msg-1', ruleCode: 'RULE_A' }),
        claim({ chatId: 'chat-1', userId: 'user-2', messageId: 'msg-1', ruleCode: 'RULE_B' }),
      ]),
    ).resolves.toEqual([false, false]);
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(redisCounter.incrementOncePerMemberWithTtl).not.toHaveBeenCalled();
  });

  it('blocks an ambiguous generic action insert when PostgreSQL confirms a foreign owner', async () => {
    let attemptedClaim: Record<string, unknown> | undefined;
    const createMany = jest.fn(async (args: { data: Array<Record<string, unknown>> }) => {
      attemptedClaim = args.data[0];
      throw new Error('connection reset after insert attempt');
    });
    const findUnique = jest.fn().mockImplementation(async () => ({
      ...attemptedClaim,
      dedupeKey: 'photo-duplicate-action:v2:foreign-owner',
      userId: 'user-2',
    }));
    const redisCounter = { incrementOncePerMemberWithTtl: jest.fn() };
    const service = new ModerationService(
      { moderationViolationMessageClaim: { createMany, findUnique } } as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      redisCounter as never,
    );

    await expect(
      (service as any).claimMessageScopedModerationAction({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'RULE_A',
      }),
    ).resolves.toBe(false);
    expect(redisCounter.incrementOncePerMemberWithTtl).not.toHaveBeenCalled();
  });

  it('retries an ambiguous generic action insert that PostgreSQL cannot reconcile', async () => {
    const createError = new Error('connection reset before commit status was known');
    const createMany = jest.fn().mockRejectedValue(createError);
    const findUnique = jest.fn().mockResolvedValue(null);
    const redisCounter = { incrementOncePerMemberWithTtl: jest.fn() };
    const service = new ModerationService(
      { moderationViolationMessageClaim: { createMany, findUnique } } as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      redisCounter as never,
    );

    await expect(
      (service as any).claimMessageScopedModerationAction({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'RULE_A',
      }),
    ).rejects.toBe(createError);
    expect(redisCounter.incrementOncePerMemberWithTtl).not.toHaveBeenCalled();
  });

  it('resumes the exact duplicate-decision claim owner without an early terminal lookup', async () => {
    let attemptedClaim: Record<string, unknown> | undefined;
    const createMany = jest.fn(async (args: { data: Array<Record<string, unknown>> }) => {
      attemptedClaim = args.data[0];
      return { count: 0 };
    });
    const findUnique = jest.fn().mockImplementation(async () => attemptedClaim);
    const findTerminalEvent = jest.fn();
    const service = new ModerationService(
      {
        moderationViolationMessageClaim: { createMany, findUnique },
        moderationEvent: { findFirst: findTerminalEvent },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      (service as any).claimDuplicateMessageAction({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
      }),
    ).resolves.toBe('resumed');
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findTerminalEvent).not.toHaveBeenCalled();
    expect(createMany).toHaveBeenCalledWith({
      data: [
        {
          chatId: 'chat-1',
          dedupeKey: expect.stringMatching(/^v1:[a-f0-9]{64}$/u),
          messageActionKey: expect.stringMatching(/^v1:[a-f0-9]{64}$/u),
          messageId: 'msg-1',
          ruleCode: 'DUPLICATE_MESSAGE_ACTION',
          updateType: 'message_action',
          userId: 'user-1',
        },
      ],
      skipDuplicates: true,
    });
    expect(attemptedClaim).not.toHaveProperty('resumeKnownActionOwner');
  });

  it('does not enable known-owner resume for a non-duplicate action rule', async () => {
    const createMany = jest.fn().mockResolvedValue({ count: 0 });
    const findUnique = jest.fn();
    const findTerminalEvent = jest.fn();
    const service = new ModerationService(
      {
        moderationViolationMessageClaim: { createMany, findUnique },
        moderationEvent: { findFirst: findTerminalEvent },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      (service as any).claimMessageScopedModerationAction({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'NIGHT_MODE_DELETE',
      }),
    ).resolves.toBe(false);
    expect(findUnique).not.toHaveBeenCalled();
    expect(findTerminalEvent).not.toHaveBeenCalled();
  });

  it('treats persisted message claim unique conflicts as duplicate multi-bot deliveries', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: true,
            linkWarnEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(1),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      moderationViolationMessageClaim: {
        create: jest
          .fn()
          .mockResolvedValueOnce({ id: 'claim-1' })
          .mockRejectedValueOnce({ code: 'P2002', message: 'Unique constraint failed' }),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
      }),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    await service.handleUpdate({
      ...createUpdate(),
      updateId: 'upd-owner-link-1',
      botId: 'bot-1',
    });
    await service.handleUpdate({
      ...createUpdate(),
      updateId: 'upd-standby-link-1',
      botId: 'bot-2',
    });

    expect(prisma.moderationViolationMessageClaim.create).toHaveBeenCalledTimes(2);
    expect(prisma.violation.create).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
  });

  it('deduplicates same-message link sanctions across concurrent service instances', async () => {
    const claimedKeys = new Set<string>();
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: true,
            linkWarnEnabled: true,
            linkMuteEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(1),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      moderationViolationMessageClaim: {
        createMany: jest.fn(async (args: { data: Array<{ dedupeKey: string }> }) => {
          const dedupeKey = args.data[0]?.dedupeKey;
          if (!dedupeKey || claimedKeys.has(dedupeKey)) {
            return { count: 0 };
          }

          claimedKeys.add(dedupeKey);
          return { count: 1 };
        }),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
      }),
    };
    const firstMaxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const secondMaxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const firstService = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      firstMaxClient as never,
    );
    const secondService = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      secondMaxClient as never,
    );

    await Promise.all([
      firstService.handleUpdate({
        ...createUpdate(),
        updateId: 'upd-owner-link-1',
        botId: 'bot-1',
      }),
      secondService.handleUpdate({
        ...createUpdate(),
        updateId: 'upd-standby-link-1',
        botId: 'bot-2',
      }),
    ]);

    expect(prisma.moderationViolationMessageClaim.createMany).toHaveBeenCalledTimes(2);
    expect(claimedKeys.size).toBe(1);
    expect(prisma.violation.create).toHaveBeenCalledTimes(1);
    const deleteMessageCalls =
      firstMaxClient.deleteMessage.mock.calls.length +
      secondMaxClient.deleteMessage.mock.calls.length;
    const sendMessageCalls =
      firstMaxClient.sendMessage.mock.calls.length + secondMaxClient.sendMessage.mock.calls.length;
    expect(deleteMessageCalls).toBe(1);
    expect(sendMessageCalls).toBe(1);
    expect(firstMaxClient.kickMember).not.toHaveBeenCalled();
    expect(secondMaxClient.kickMember).not.toHaveBeenCalled();
    expect(firstMaxClient.banMember).not.toHaveBeenCalled();
    expect(secondMaxClient.banMember).not.toHaveBeenCalled();
  });

  it('fails closed when persisted and Redis message claims are unavailable', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: true,
            linkWarnEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      moderationViolationMessageClaim: {
        createMany: jest.fn().mockRejectedValue(new Error('claim store unavailable')),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
      }),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('sends link explanation with inline button when button toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: true,
            linkBotButtonEnabled: true,
            linkBotButtonUrl: 'https://max.ru/channel/news',
            linkBotButtonText: 'Канал',
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      majorExplanation('Алексей', 'удалено', 'эта ссылка запрещена настройками чата'),
      {
        button: {
          text: 'Канал',
          url: 'https://max.ru/channel/news',
        },
        textFormat: 'html',
        marketplacePublication: {
          entityId: 'chat-1',
          purpose: 'MODERATION_NOTICE',
          module: 'LINKS',
        },
      },
    );
  });

  it('adds admin contact as a markdown link to link explanations', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: true,
            linkAdminContactButtonEnabled: true,
            linkAdminContactButtonUrl: 'https://max.ru/admin',
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
      }),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      `${majorExplanation(
        'Алексей',
        'удалено',
        'эта ссылка запрещена настройками чата',
      )}\n\n<a href="https://max.ru/admin">Связь с админом</a>`,
      {
        textFormat: 'html',
        marketplacePublication: {
          entityId: 'chat-1',
          purpose: 'MODERATION_NOTICE',
          module: 'LINKS',
        },
      },
    );
  });

  it('does not send repeated link explanation when warning stage is disabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: true,
            linkWarnEnabled: false,
            linkBanEnabled: false,
            linkMuteEnabled: false,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(2),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('sends link explanation for old messages when link bot toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ linkBotMessageEnabled: true }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn().mockResolvedValue(SanctionAction.WARN),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createOldUpdate());

    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-old-1');
    expect(maxClient.notifyModerators).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      majorExplanation('Алексей', 'удалено', 'эта ссылка запрещена настройками чата'),
    );
  });

  it.each([true, false])(
    'issues WARN on second link with notice bucket available=%s',
    async (bucketAvailable) => {
      const prisma = {
        chat: {
          upsert: jest.fn().mockResolvedValue({
            id: 'chat-1',
            title: 'Chat 1',
            settings: createSettings({
              linkBotMessageEnabled: false,
              linkWarnEnabled: true,
            }),
            domains: [],
          }),
        },
        violation: {
          create: jest.fn(),
          count: jest.fn().mockResolvedValue(2),
        },
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
        webhookEvent: {
          findUnique: jest.fn(),
          update: jest.fn(),
        },
      };
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({
          violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
        }),
      };
      const sanctionService = {
        resolveAction: jest.fn(),
      };
      const maxClient = {
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        sanctionService as never,
        maxClient as never,
      );
      const noticeBucket = jest
        .spyOn(service as any, 'shouldSendBotNotice')
        .mockResolvedValue(bucketAvailable);

      await service.handleUpdate(createUpdate());

      expect(noticeBucket).not.toHaveBeenCalled();
      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
        'chat-1',
        linkWarnNotice('Алексей'),
      );
      expect(maxClient.kickMember).not.toHaveBeenCalled();
      expect(maxClient.banMember).not.toHaveBeenCalled();
      expect(sanctionService.resolveAction).not.toHaveBeenCalled();
      expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
        data: expect.objectContaining({
          ruleCode: 'LINK_BLOCKED',
          action: SanctionAction.WARN,
          metadata: expect.objectContaining({
            linkViolationCount24h: 2,
            linkEscalationWindowHours: 24,
          }),
        }),
      });
    },
  );

  it('uses edited-message copy for link WARN after a quiet edit', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: false,
            linkWarnEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(2),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
      }),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    await service.handleUpdate({
      ...createUpdate(),
      type: 'message_edited',
    });

    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      editedLinkWarnNotice('Алексей'),
    );
  });

  it('sends only WARN on second link when explanation and warning are enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: true,
            linkWarnEnabled: true,
            linkBotButtonEnabled: true,
            linkBotButtonUrl: 'https://max.ru/channel/rules',
            linkBotButtonText: 'Правила',
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(2),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      linkWarnNotice('Алексей'),
      {
        button: {
          text: 'Правила',
          url: 'https://max.ru/channel/rules',
        },
        textFormat: 'html',
        marketplacePublication: {
          entityId: 'chat-1',
          purpose: 'MODERATION_NOTICE',
          module: 'LINKS',
        },
      },
    );
  });

  it('adds both manual button and rules button when both toggles are enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: true,
            linkWarnEnabled: true,
            linkBotButtonEnabled: true,
            linkBotButtonUrl: 'https://max.ru/channel/news',
            linkBotButtonText: 'Канал',
            rulesAttachViolationsEnabled: true,
          }),
          rules: {
            publishedUrl: 'https://max.ru/chats/chat-1/message/999',
          },
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(2),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
      }),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      linkWarnNotice('Алексей'),
      {
        buttons: [
          [
            {
              text: 'Канал',
              url: 'https://max.ru/channel/news',
            },
            {
              text: 'Правила',
              url: 'https://max.ru/chats/chat-1/message/999',
            },
          ],
        ],
        textFormat: 'html',
        marketplacePublication: {
          entityId: 'chat-1',
          purpose: 'MODERATION_NOTICE',
          module: 'LINKS',
        },
      },
    );
  });

  it('skips rules button when toggle is enabled but rules post is not published yet', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: true,
            linkWarnEnabled: true,
            rulesAttachViolationsEnabled: true,
          }),
          rules: {
            publishedMessageId: null,
            publishedUrl: null,
          },
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(2),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
      }),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      linkWarnNotice('Алексей'),
      expect.objectContaining({ textFormat: 'html' }),
    );
  });

  it('uses reply link to rules post without resolving a direct rules url in the hot path', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: true,
            linkWarnEnabled: true,
            rulesAttachViolationsEnabled: true,
          }),
          rules: {
            publishedMessageId: 'mid-rules-1',
            publishedUrl: null,
          },
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(2),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
      }),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
      resolveMessageLink: jest.fn().mockResolvedValue('https://max.ru/chats/chat-1/message/123'),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      linkWarnNotice('Алексей'),
      {
        messageLink: {
          type: 'reply',
          mid: 'mid-rules-1',
        },
        textFormat: 'html',
        marketplacePublication: {
          entityId: 'chat-1',
          purpose: 'MODERATION_NOTICE',
          module: 'LINKS',
        },
      },
    );
    expect(maxClient.resolveMessageLink).not.toHaveBeenCalled();
  });

  it('falls back to reply link on rules post when published url is still unavailable', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: true,
            linkWarnEnabled: true,
            rulesAttachViolationsEnabled: true,
          }),
          rules: {
            publishedMessageId: 'mid-rules-2',
            publishedUrl: null,
          },
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(2),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      chatRules: {
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
      }),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
      resolveMessageLink: jest.fn().mockResolvedValue(null),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      linkWarnNotice('Алексей'),
      {
        messageLink: {
          type: 'reply',
          mid: 'mid-rules-2',
        },
        textFormat: 'html',
        marketplacePublication: {
          entityId: 'chat-1',
          purpose: 'MODERATION_NOTICE',
          module: 'LINKS',
        },
      },
    );
  });

  it('upgrades legacy callback rules button to direct link when pressed', async () => {
    const prisma = {
      chatRules: {
        findUnique: jest.fn().mockResolvedValue({
          publishedUrl: null,
          publishedMessageId: 'mid-rules-1',
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    const maxClient = {
      answerCallback: jest.fn(),
      resolveMessageLink: jest.fn().mockResolvedValue('https://max.ru/chats/chat-1/message/777'),
      editMessageInlineKeyboard: jest.fn().mockResolvedValue(undefined),
    };

    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    await service.handleUpdate(createGroupRulesCallbackUpdate({ botId: 'bot-1' }));

    expect(maxClient.resolveMessageLink).toHaveBeenCalledWith('mid-rules-1', { botId: 'bot-1' });
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'chat-1',
      'msg-group-rules-callback-1',
      null,
      {
        button: {
          text: 'Правила',
          url: 'https://max.ru/chats/chat-1/message/777',
        },
      },
      { botId: 'bot-1' },
    );
    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-rules-1',
      'Кнопка обновлена. Нажмите ещё раз',
      undefined,
      {
        ignoreFailureMetricStatuses: [400, 404],
        rateLimitEntityId: 'chat-1',
      },
    );
  });

  it('preserves a mixed-case legacy channel suggestion payload from a channel callback', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn(),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const maxClient = {
      answerCallback: jest.fn(),
    };
    const privateControlService = {
      openChannelSuggestionFromCallback: jest.fn().mockResolvedValue(true),
    };
    const dialogLinkService = {
      parseChannelSuggestionStartPayload: jest.fn().mockReturnValue({
        chatId: 'channel-1',
        token: 'cdt-suggest-token-1',
      }),
    };

    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      undefined,
      privateControlService as never,
      dialogLinkService as never,
    );

    const legacyPayload = `cd-${Buffer.from(
      JSON.stringify({
        v: 1,
        k: 'channel-dialog',
        c: 'channel-1',
        m: 'suggest',
        t: 'cdt-CaseSensitiveToken',
      }),
      'utf8',
    ).toString('base64url')}`;
    expect(legacyPayload).not.toBe(legacyPayload.toLowerCase());

    await service.handleUpdate(createChannelSuggestionCallbackUpdate(legacyPayload));

    expect(dialogLinkService.parseChannelSuggestionStartPayload).toHaveBeenCalledWith(
      legacyPayload,
    );
    expect(privateControlService.openChannelSuggestionFromCallback).toHaveBeenCalledWith({
      userId: 'user-1',
      chatId: 'channel-1',
      token: 'cdt-suggest-token-1',
      botId: 'bot-channel-1',
    });
    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-suggest-1',
      'Бот написал в личку',
      undefined,
      {
        ignoreFailureMetricStatuses: [400, 404],
        rateLimitEntityId: 'channel-1',
      },
    );
  });

  describe('sanction display-name recovery', () => {
    const numericUserId = '195714583';

    it('uses a local full name for a numeric sender_name without calling MAX', async () => {
      const harness = createNumericSenderLinkBanHarness({
        localRows: [{ sender_name: 'Иван Петров' }],
      });

      expect(harness.update.message?.senderId).toBe(numericUserId);
      expect(harness.update.message?.senderName).toBeUndefined();

      await harness.service.handleUpdate(harness.update);

      expect(harness.prisma.$queryRaw).toHaveBeenCalledTimes(2);
      expect(harness.maxClient.getChatMemberProfiles).not.toHaveBeenCalled();
      expectImmediateBanMember(harness.maxClient.banMember, 'chat-1', numericUserId);
      (expect(harness.maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
        'chat-1',
        permanentBanNotice('Иван Петров', numericUserId),
      );
    });

    it('uses the full MAX profile name and completes lookup before banning the member', async () => {
      const operationOrder: string[] = [];
      const getChatMemberProfiles = jest.fn().mockImplementation(async () => {
        operationOrder.push('profile');
        return new Map([
          [
            numericUserId,
            {
              userId: numericUserId,
              displayName: 'Иван Петров',
              username: null,
              avatarUrl: null,
              profileUrl: null,
            },
          ],
        ]);
      });
      const banMember = jest.fn().mockImplementation(async () => {
        operationOrder.push('ban');
      });
      const harness = createNumericSenderLinkBanHarness({
        getChatMemberProfiles,
        banMember,
      });

      await harness.service.handleUpdate(harness.update);

      expect(getChatMemberProfiles).toHaveBeenCalledWith('chat-1', [numericUserId], {
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        sourceTag: 'moderation_notice',
        timeoutMs: ADMIN_CONTACT_DISPLAY_NAME_LOOKUP_TIMEOUT_MS,
        ignoreFailureMetricStatuses: [403, 404],
      });
      expect(operationOrder).toEqual(['profile', 'ban']);
      (expect(harness.maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
        'chat-1',
        permanentBanNotice('Иван Петров', numericUserId),
      );
    });

    it('keeps the ban and generic profile link when the MAX name lookup fails', async () => {
      const harness = createNumericSenderLinkBanHarness({
        getChatMemberProfiles: jest.fn().mockRejectedValue(new Error('MAX unavailable')),
      });

      await expect(harness.service.handleUpdate(harness.update)).resolves.toBeUndefined();

      expectImmediateBanMember(harness.maxClient.banMember, 'chat-1', numericUserId);
      (expect(harness.maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
        'chat-1',
        permanentBanNotice('Пользователь', numericUserId),
      );
    });

    it('keeps the ban and generic profile link when the MAX name lookup times out', async () => {
      jest.useFakeTimers();
      let markLookupStarted: (() => void) | null = null;
      const lookupStarted = new Promise<void>((resolve) => {
        markLookupStarted = resolve;
      });
      const getChatMemberProfiles = jest.fn(() => {
        markLookupStarted?.();
        return new Promise<Map<string, never>>(() => {
          // Intentionally left pending to exercise the lookup timeout.
        });
      });
      const harness = createNumericSenderLinkBanHarness({ getChatMemberProfiles });

      try {
        const updatePromise = harness.service.handleUpdate(harness.update);
        await lookupStarted;
        expect(getChatMemberProfiles).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(ADMIN_CONTACT_DISPLAY_NAME_LOOKUP_TIMEOUT_MS);
        await expect(updatePromise).resolves.toBeUndefined();

        expectImmediateBanMember(harness.maxClient.banMember, 'chat-1', numericUserId);
        (expect(harness.maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
          'chat-1',
          permanentBanNotice('Пользователь', numericUserId),
        );
      } finally {
        jest.useRealTimers();
      }
    });

    it('records a failed ban attempt without creating an active sanction event', async () => {
      const harness = createNumericSenderLinkBanHarness({
        banMember: jest.fn().mockRejectedValue(new Error('MAX rejected ban')),
      });

      await expect(harness.service.handleUpdate(harness.update)).resolves.toBeUndefined();

      expect(harness.prisma.moderationEvent.create).toHaveBeenLastCalledWith({
        data: expect.objectContaining({
          action: SanctionAction.NONE,
          metadata: expect.objectContaining({
            action: SanctionAction.NONE,
            attemptedAction: SanctionAction.BAN,
            sanctionApplied: false,
          }),
        }),
      });
      expect(harness.maxClient.sendMessage).not.toHaveBeenCalled();
    });

    it('still publishes a ban notice without a release button when event persistence fails', async () => {
      const harness = createNumericSenderLinkBanHarness({
        localRows: [],
      });
      harness.prisma.moderationEvent.create
        .mockReset()
        .mockResolvedValueOnce({ id: 'delete-event-before-persist-failure' })
        .mockRejectedValueOnce(new Error('database unavailable'));

      await expect(harness.service.handleUpdate(harness.update)).resolves.toBeUndefined();

      expectImmediateBanMember(harness.maxClient.banMember, 'chat-1', numericUserId);
      const noticeCall = harness.maxClient.sendMessage.mock.calls.find((call) =>
        String(call[1]).includes('Снять бан может администратор'),
      );
      expect(noticeCall).toBeDefined();
      expect((noticeCall?.[2] as { buttons?: unknown } | undefined)?.buttons).toBeUndefined();
    });

    it('does not announce a mute when neither the event nor runtime state can be stored', async () => {
      const maxClient = { sendMessage: jest.fn() };
      const redisCounter = {
        setStringWithTtl: jest.fn().mockRejectedValue(new Error('redis unavailable')),
      };
      const service = new ModerationService(
        {
          moderationEvent: {
            findFirst: jest.fn().mockResolvedValue(null),
          },
        } as never,
        {} as never,
        {} as never,
        maxClient as never,
        undefined,
        undefined,
        undefined,
        redisCounter as never,
      );

      await expect(
        (service as any).applySanctionAction({
          chatId: 'chat-1',
          userId: numericUserId,
          action: SanctionAction.MUTE,
          userLabel: userMention('Пользователь', numericUserId),
          messageId: 'message-mute-storage-failure',
          muteDurationHours: 6,
          deleteBotMessagesEnabled: false,
          deleteBotMessagesDelayMinutes: 0,
          botSpeechStyle: null,
          persistModerationEvent: jest.fn().mockRejectedValue(new Error('database unavailable')),
        }),
      ).rejects.toThrow('Automatic mute requires a durable sanction event');
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
    });
  });

  it('uses permanent ban flow for link BAN escalation', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: false,
            linkBanEnabled: true,
            muteDurationHours: 12,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(3),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    expectImmediateBanMember(maxClient.banMember, 'chat-1', 'user-1');
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      permanentBanNotice('Алексей'),
    );
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'LINK_BLOCKED',
        action: SanctionAction.BAN,
        metadata: expect.objectContaining({
          linkViolationCount24h: 3,
          linkEscalationWindowHours: 24,
        }),
      }),
    });
  });

  it('uses inline button in permanent link BAN notice when button toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: true,
            linkBanEnabled: true,
            muteDurationHours: 12,
            linkBotButtonEnabled: true,
            linkBotButtonUrl: 'https://max.ru/channel/rules',
            linkBotButtonText: 'Правила',
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(3),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockResolvedValueOnce({ id: 'delete-event-link-ban-button' })
          .mockResolvedValueOnce({ id: 'sanction-event-link-ban-button' }),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      permanentBanNotice('Алексей'),
      {
        buttons: [
          [
            {
              text: 'Правила',
              url: 'https://max.ru/channel/rules',
            },
          ],
          [
            {
              type: 'callback',
              text: 'Разбанить',
              payload: buildModerationReleaseCallbackPayload(
                'UNBAN',
                'sanction-event-link-ban-button',
              ),
              intent: 'positive',
            },
          ],
        ],
        textFormat: 'html',
        marketplacePublication: {
          entityId: 'chat-1',
          purpose: 'MODERATION_NOTICE',
          module: 'LINKS',
        },
      },
    );
  });

  it('issues MUTE on fourth link in 24h when mute stage is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: false,
            linkMuteEnabled: true,
            linkAdminContactButtonEnabled: true,
            linkAdminContactButtonUrl: 'https://max.ru/admin',
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(4),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    withAutomaticMutePersistenceFixture(prisma);
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      muteNotice('Алексей', '6ч'),
    );
    expect(
      maxClient.sendMessage.mock.calls.some((call) => String(call[1]).includes('Связь с админом')),
    ).toBe(false);
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'LINK_BLOCKED',
        action: SanctionAction.MUTE,
        metadata: expect.objectContaining({
          linkViolationCount24h: 4,
          linkEscalationWindowHours: 24,
        }),
      }),
    });
  });

  it('uses inline button in link MUTE message when button toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: true,
            linkMuteEnabled: true,
            linkBotButtonEnabled: true,
            linkBotButtonUrl: 'https://max.ru/channel/rules',
            linkBotButtonText: 'Правила',
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(4),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockResolvedValueOnce({ id: 'delete-event-link-mute-button' })
          .mockResolvedValueOnce({ id: 'sanction-event-link-mute-button' }),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    withAutomaticMutePersistenceFixture(prisma);
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(2);
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      muteNotice('Алексей', '6ч'),
      {
        buttons: [
          [
            {
              text: 'Правила',
              url: 'https://max.ru/channel/rules',
            },
          ],
          [
            {
              type: 'callback',
              text: 'Снять мут',
              payload: buildModerationReleaseCallbackPayload(
                'UNMUTE',
                'sanction-event-link-mute-button',
              ),
              intent: 'positive',
            },
          ],
        ],
        textFormat: 'html',
        marketplacePublication: {
          entityId: 'chat-1',
          purpose: 'MODERATION_NOTICE',
          module: 'LINKS',
        },
      },
    );
  });

  it('still sends duplicate explanation when message deletion fails', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ duplicateBotMessageEnabled: true }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
        duplicateDecision: {
          action: 'WARN',
          count: 2,
          threshold: 2,
          windowSec: 12 * 60 * 60,
          hash: 'hash-1',
          nextAction: 'MUTE',
        },
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn().mockRejectedValue(new Error('delete failed')),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'DUPLICATE_WARN',
        action: SanctionAction.WARN,
      }),
    });
  });

  it('renders duplicate explanation with actual message status when duplicate deletion fails', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            duplicateBotMessageEnabled: true,
            duplicateBotMessageText:
              'Статус: {message_status}. Контекст: {duplicate_context}. {sanction}',
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
        duplicateDecision: {
          action: 'WARN',
          count: 2,
          threshold: 2,
          windowSec: 12 * 60 * 60,
          hash: 'hash-status-1',
          nextAction: 'MUTE',
        },
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn().mockRejectedValue(new Error('delete failed')),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      'Статус: не по форме. Контекст: идёт повтором. Взял на карандаш 📝.',
    );
  });

  it('counts forwarded text length for MESSAGE_TOO_LONG and skips sanctions', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ maxMessageLengthEnabled: true, maxMessageLength: 100 }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest
        .fn()
        .mockImplementation(
          async (params: { effectiveLength?: number; settings: { maxMessageLength: number } }) => {
            const length = params.effectiveLength ?? 0;
            if (length > params.settings.maxMessageLength) {
              return {
                violations: [
                  {
                    ruleCode: 'MESSAGE_TOO_LONG',
                    score: 0.82,
                    reason: 'Message too long',
                  },
                ],
              };
            }

            return { violations: [] };
          },
        ),
    };
    const sanctionService = {
      resolveAction: jest.fn().mockResolvedValue(SanctionAction.WARN),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    const forwarded = 'x'.repeat(180);
    await service.handleUpdate(createForwardedUpdate(forwarded));

    expect(ruleEngine.detect).toHaveBeenCalledTimes(1);
    const detectionArgs = (ruleEngine.detect as jest.Mock).mock.calls[0][0] as {
      effectiveLength?: number;
    };
    expect(detectionArgs.effectiveLength).toBeGreaterThan('коротко'.length);
    expect(detectionArgs.effectiveLength).toBeGreaterThan(100);

    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-forwarded-1');
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-forwarded-1',
        ruleCode: 'MESSAGE_TOO_LONG',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('includes actual and required length in MESSAGE_TOO_LONG bot explanation', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            maxMessageLengthEnabled: true,
            maxMessageLength: 100,
            messageLimitsBotMessageEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest
        .fn()
        .mockImplementation(
          async (params: { effectiveLength?: number; settings: { maxMessageLength: number } }) => {
            const length = params.effectiveLength ?? 0;
            if (length > params.settings.maxMessageLength) {
              return {
                violations: [
                  {
                    ruleCode: 'MESSAGE_TOO_LONG',
                    score: 0.82,
                    reason: 'Message too long',
                  },
                ],
              };
            }

            return { violations: [] };
          },
        ),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    const forwarded = 'x'.repeat(180);
    await service.handleUpdate(createForwardedUpdate(forwarded));

    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      majorExplanation('Алексей', 'удалено', 'длина сообщения 187 символов при лимите 100'),
    );
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
  });

  it.each([1, 2, 3])(
    'includes configured message count window in MESSAGE_COUNT_LIMIT bot explanation at violation %i',
    async (violationCount) => {
      const prisma = {
        chat: {
          upsert: jest.fn().mockResolvedValue({
            id: 'chat-1',
            title: 'Chat 1',
            settings: createSettings({
              messageCountLimitEnabled: true,
              messageCountLimitMessages: 2,
              messageCountLimitWindowHours: 6,
              messageLimitsBotMessageEnabled: true,
              messageLimitsWarnEnabled: true,
              messageLimitsMuteEnabled: false,
              messageLimitsBanEnabled: true,
            }),
            domains: [],
          }),
        },
        violation: {
          create: jest.fn(),
          count: jest.fn().mockResolvedValue(violationCount),
        },
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
        webhookEvent: {
          findUnique: jest.fn(),
          update: jest.fn(),
        },
      };
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({
          violations: [
            {
              ruleCode: 'MESSAGE_COUNT_LIMIT',
              score: 0.87,
              reason: 'Message count limit hit',
            },
          ],
        }),
      };
      const sanctionService = {
        resolveAction: jest.fn(),
      };
      const maxClient = {
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        sanctionService as never,
        maxClient as never,
      );
      installGuardedDeleteExecutorFixture(service);

      await service.handleUpdate(createUpdate());

      (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
        'chat-1',
        violationCount === 1
          ? majorExplanation('Алексей', 'удалено', 'превышен лимит сообщений: 2 за 6 ч')
          : violationCount === 2
            ? messageLimitsWarnNotice('Алексей', 'превышен лимит сообщений: 2 за 6 ч')
            : messageLimitsBanNotice('Алексей', 'превышен лимит сообщений: 2 за 6 ч'),
      );
      expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    },
  );

  it('uploads configured bot-speech image with MESSAGE_COUNT_LIMIT explanation', async () => {
    const imageBytes = Buffer.from('bot-speech-image');
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            messageCountLimitEnabled: true,
            messageCountLimitMessages: 2,
            messageCountLimitWindowHours: 6,
            messageLimitsBotMessageEnabled: true,
            botSpeechMedia: {
              messageLimitsBotMessageText: {
                base64: imageBytes.toString('base64'),
                mimeType: 'image/png',
                fileName: 'limit-notice.png',
              },
            },
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [
          {
            ruleCode: 'MESSAGE_COUNT_LIMIT',
            score: 0.87,
            reason: 'Message count limit hit',
          },
        ],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      uploadImage: jest.fn().mockResolvedValue({ token: 'bot-speech-image-1' }),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );
    installGuardedDeleteExecutorFixture(service);

    await service.handleUpdate(createUpdate());

    expect(maxClient.uploadImage).toHaveBeenCalledWith(
      imageBytes,
      'limit-notice.png',
      'image/png',
      expect.objectContaining({
        actionHealthLane: 'background',
        sourceTag: 'moderation_notice',
        trafficClass: 'background',
      }),
    );
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      majorExplanation('Алексей', 'удалено', 'превышен лимит сообщений: 2 за 6 ч'),
      expect.objectContaining({
        imagePayload: { token: 'bot-speech-image-1' },
        textFormat: 'html',
      }),
      expect.objectContaining({
        sourceTag: 'moderation_notice',
      }),
    );
  });

  it('hard-bans built-in MESSAGE_RATE_LIMIT as system flood protection', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            antiSpamEnabled: true,
            messageLimitsBotMessageEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [
          {
            ruleCode: 'MESSAGE_RATE_LIMIT',
            score: 0.9,
            reason: 'Messages are limited to 5 per 6s',
            metadata: { count: 6, maxMessages: 5, windowSec: 6 },
          },
        ],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );
    installGuardedDeleteExecutorFixture(service);

    await service.handleUpdate(createUpdate());

    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    expectImmediateBanMember(maxClient.banMember, 'chat-1', 'user-1');
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      messageLimitsBanNotice(
        'Алексей',
        'за короткое время отправлено слишком много сообщений или стикеров',
      ),
    );
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        ruleCode: 'MESSAGE_RATE_LIMIT',
        action: SanctionAction.BAN,
      }),
    });
  });

  describe('deferred photo analysis enqueue', () => {
    function createHarness(
      options: {
        adminUserIds?: string[];
        duplicateOutcome?: 'decision' | 'hit';
        karavanResult?: 'handled' | 'duplicate';
        settingsOverrides?: Record<string, unknown>;
        violations?: Array<{
          ruleCode: string;
          score: number;
          reason: string;
          metadata?: Record<string, unknown> | null;
        }>;
      } = {},
    ) {
      const prisma = {
        chat: {
          upsert: jest.fn().mockResolvedValue({
            id: 'chat-1',
            title: 'Chat 1',
            settings: createSettings({
              antiDuplicateEnabled: true,
              duplicatePhotoEnabled: true,
              ...options.settingsOverrides,
            }),
            domains: [],
            admins: (options.adminUserIds ?? []).map((userId) => ({ userId })),
            rules: {
              publishedUrl: null,
              publishedMessageId: null,
            },
          }),
        },
        violation: {
          create: jest.fn(),
        },
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
        webhookEvent: {
          findUnique: jest.fn(),
          update: jest.fn(),
        },
      };
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({
          violations: options.violations ?? [],
          ...(options.duplicateOutcome === 'decision'
            ? {
                duplicateDecision: {
                  action: 'WARN',
                  count: 2,
                  threshold: 2,
                  windowSec: 12 * 60 * 60,
                  hash: 'text-duplicate-decision',
                  fingerprintType: 'exact',
                  nextAction: 'MUTE',
                },
              }
            : {}),
          ...(options.duplicateOutcome === 'hit'
            ? {
                duplicateHit: {
                  count: 1,
                  windowSec: 12 * 60 * 60,
                  hash: 'text-duplicate-hit',
                  fingerprintType: 'exact',
                },
              }
            : {}),
        }),
      };
      const sanctionService = {
        resolveAction: jest.fn(),
      };
      const maxClient = {
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
      };
      const photoDuplicateEnqueueService = {
        enqueue: jest.fn().mockResolvedValue('queued'),
      };
      const commercialOcrEnqueueService = {
        enqueue: jest.fn().mockImplementation(async (params) => {
          params.registerPendingActivation?.({
            jobId: `commercial-image-ocr__${'a'.repeat(64)}`,
            chatId: params.chatId,
            imageCount: params.imageCount,
            reservationTtlMs: 600_000,
          });
          return 'queued';
        }),
      };
      const karavanStorefrontRelayService = {
        handleMessageCreated: jest.fn().mockResolvedValue(options.karavanResult ?? 'noop'),
      };
      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        sanctionService as never,
        maxClient as never,
        undefined, // chatContextCache
        undefined, // systemModeService
        undefined, // configService
        undefined, // redisCounter
        undefined, // privateControlService
        undefined, // adminDialogLinkService
        undefined, // membershipLookupService
        undefined, // maxBotLinkService
        undefined, // maxBotContextService
        undefined, // queueMetricsService
        undefined, // backgroundRuntimeGovernorService
        undefined, // runtimeDiagnosticsService
        undefined, // maxChatAdminRosterSyncService
        undefined, // globalSpammerIntelligence
        undefined, // managedEntityAccessLossService
        undefined, // injectedModerationAccessService
        undefined, // injectedNightModeTransitionRuntime
        undefined, // injectedManualModerationService
        undefined, // injectedNightModeTransitionDelivery
        undefined, // injectedBotSpeechMediaService
        undefined, // injectedNightModeTransitionEventService
        karavanStorefrontRelayService as never,
        undefined, // managedPollService
        undefined, // injectedWebhookCanonicalExecutionService
        undefined, // moderationDeleteIntentService
        undefined, // maxActionLedgerService
        undefined, // channelPostSignatureService
        undefined, // injectedModerationSanctionStateLock
        undefined, // injectedModerationSanctionStateFence
        photoDuplicateEnqueueService as never,
        commercialOcrEnqueueService as never,
      );

      return {
        service,
        ruleEngine,
        photoDuplicateEnqueueService,
        commercialOcrEnqueueService,
        karavanStorefrontRelayService,
      };
    }

    it('does not enqueue an eligible message into the retired photo filter', async () => {
      const harness = createHarness();
      const update = createPhotoAttachmentUpdate(91);

      await harness.service.handleUpdate(update, undefined, 'webhook-photo-91');

      expect(harness.photoDuplicateEnqueueService.enqueue).not.toHaveBeenCalled();
    });

    it('does not revive the retired photo filter for competing violations', async () => {
      const harness = createHarness({
        violations: [
          {
            ruleCode: 'PROFANITY',
            score: 0.91,
            reason: 'Profanity detected',
          },
        ],
      });
      jest
        .spyOn(harness.service as never, 'consumeChatParticipantModerationImmunity' as never)
        .mockResolvedValue(true as never);
      const update = createPhotoAttachmentUpdate(92);

      await harness.service.handleUpdate(update, undefined, 'webhook-photo-92');

      expect(harness.photoDuplicateEnqueueService.enqueue).not.toHaveBeenCalled();
    });

    it.each(['decision', 'hit'] as const)(
      'does not revive retired photo jobs when text detection returned a %s',
      async (duplicateOutcome) => {
        const harness = createHarness({ duplicateOutcome });
        jest
          .spyOn(harness.service as never, 'consumeChatParticipantModerationImmunity' as never)
          .mockResolvedValue(true as never);
        const suffix = duplicateOutcome === 'decision' ? 95 : 96;
        const update = createPhotoAttachmentUpdate(suffix);

        await harness.service.handleUpdate(update, undefined, `webhook-photo-${suffix}`);

        expect(harness.photoDuplicateEnqueueService.enqueue).not.toHaveBeenCalled();
      },
    );

    it('does not send a handled Karavan relay into the retired photo filter', async () => {
      const harness = createHarness({ karavanResult: 'handled' });
      const update = createPhotoAttachmentUpdate(97);
      update.message!.text = '$ storefront item';
      update.raw = {
        message: {
          ...(update.raw as { message?: Record<string, unknown> }).message,
          body: {
            text: '$ storefront item',
            attachments: (update.raw as { message?: { attachments?: unknown[] } }).message
              ?.attachments,
          },
        },
      };

      await harness.service.handleUpdate(update, undefined, 'webhook-photo-97');

      expect(harness.karavanStorefrontRelayService.handleMessageCreated).toHaveBeenCalled();
      expect(harness.photoDuplicateEnqueueService.enqueue).not.toHaveBeenCalled();
    });

    it.each([
      {
        name: 'active mute',
        configure: (service: ModerationService) => {
          jest.spyOn(service as any, 'getActiveMute').mockResolvedValue({});
          jest.spyOn(service as any, 'handleActiveMuteMessage').mockResolvedValue(undefined);
        },
      },
      {
        name: 'developer-forced global spammer',
        configure: (service: ModerationService) => {
          jest
            .spyOn(service as any, 'isDeveloperForcedGlobalSpammerCachedWithHotPathBudget')
            .mockResolvedValue(true);
          jest.spyOn(service as any, 'resolveSenderChatAdminCheck').mockResolvedValue({
            isAdmin: false,
            source: 'remote',
          });
          jest.spyOn(service as any, 'deleteAndKickDetectedGlobalSpammer').mockResolvedValue(true);
        },
      },
      {
        name: 'manual group close',
        configure: (service: ModerationService) => {
          jest
            .spyOn(service as any, 'handleNightModeForceCloseMessage')
            .mockResolvedValue(undefined);
        },
      },
      {
        name: 'night mode',
        configure: (service: ModerationService) => {
          jest.spyOn(service as any, 'handleNightModeMessage').mockResolvedValue(undefined);
        },
      },
      {
        name: 'local blocklist',
        configure: (service: ModerationService) => {
          jest
            .spyOn(service as any, 'isDeveloperForcedGlobalSpammerCachedWithHotPathBudget')
            .mockResolvedValue(false);
          jest
            .spyOn(service as any, 'resolveGlobalSpammerAdminDecisionsWithHotPathBudget')
            .mockResolvedValue(new Map([['user-1', 'BLOCK']]));
          jest
            .spyOn(service as any, 'handleLocalAdminBlockedSenderMessage')
            .mockResolvedValue(true);
        },
      },
      {
        name: 'global spammer tracking',
        configure: (service: ModerationService) => {
          jest
            .spyOn(service as any, 'trackAndRegisterGlobalSpammerWithHotPathBudget')
            .mockResolvedValue({ handled: true, skipKnownSpammerCheck: false });
        },
      },
      {
        name: 'known global spammer',
        configure: (service: ModerationService) => {
          jest
            .spyOn(service as any, 'isDeveloperForcedGlobalSpammerCachedWithHotPathBudget')
            .mockResolvedValue(false);
          jest
            .spyOn(service as any, 'trackAndRegisterGlobalSpammerWithHotPathBudget')
            .mockResolvedValue({ handled: false, skipKnownSpammerCheck: false });
          jest.spyOn(service as any, 'handleKnownSpammerSenderMessage').mockResolvedValue(true);
        },
      },
      {
        name: 'required subscription',
        configure: (service: ModerationService) => {
          jest.spyOn(service as any, 'handleRequiredSubscriptionMessage').mockResolvedValue(true);
        },
      },
      {
        name: 'invitation access',
        configure: (service: ModerationService) => {
          jest.spyOn(service as any, 'handleRequiredSubscriptionMessage').mockResolvedValue(false);
          jest.spyOn(service as any, 'handleInvitationAccessMessage').mockResolvedValue(true);
        },
      },
    ])(
      'queues an observation-only photo before the $name early return',
      async ({ name, configure }) => {
        const harness = createHarness({
          settingsOverrides: {
            ...(name === 'manual group close'
              ? { nightModeForceCloseEnabled: true, nightModeForceCloseForever: true }
              : {}),
            ...(name === 'night mode'
              ? {
                  nightModeEnabled: true,
                  nightModeStartTimeMinutes: 0,
                  nightModeEndTimeMinutes: 0,
                  nightModeTimezone: 'UTC',
                }
              : {}),
            ...([
              'developer-forced global spammer',
              'local blocklist',
              'known global spammer',
            ].includes(name)
              ? { deleteSpammersEnabled: true }
              : {}),
          },
        });
        configure(harness.service);
        const update = createPhotoAttachmentUpdate(98);

        await harness.service.handleUpdate(update, undefined, 'webhook-photo-98');

        expect(harness.photoDuplicateEnqueueService.enqueue).not.toHaveBeenCalled();
        expect(harness.ruleEngine.detect).not.toHaveBeenCalled();
      },
    );

    it('keeps a developer-forced admin photo out of the duplicate queue', async () => {
      const harness = createHarness({ settingsOverrides: { deleteSpammersEnabled: true } });
      jest
        .spyOn(harness.service as any, 'isDeveloperForcedGlobalSpammerCachedWithHotPathBudget')
        .mockResolvedValue(true);
      jest.spyOn(harness.service as any, 'resolveSenderChatAdminCheck').mockResolvedValue({
        isAdmin: true,
        source: 'remote',
      });
      const deleteSpammer = jest
        .spyOn(harness.service as any, 'deleteAndKickDetectedGlobalSpammer')
        .mockResolvedValue(true);

      await harness.service.handleUpdate(
        createPhotoAttachmentUpdate(99),
        undefined,
        'webhook-photo-99',
      );

      expect(deleteSpammer).toHaveBeenCalled();
      expect(harness.photoDuplicateEnqueueService.enqueue).not.toHaveBeenCalled();
    });

    it('only lowers the duplicate action latch for photo messages from chat admins', async () => {
      const harness = createHarness({ adminUserIds: ['user-1'] });
      const update = createPhotoAttachmentUpdate(93);

      await harness.service.handleUpdate(update, undefined, 'webhook-photo-93');

      expect(harness.ruleEngine.detect).not.toHaveBeenCalled();
      expect(harness.photoDuplicateEnqueueService.enqueue).not.toHaveBeenCalled();
    });

    it('does not enqueue bot-authored photo messages', async () => {
      const harness = createHarness();
      const update = createPhotoAttachmentUpdate(94);
      update.message!.senderId = 'bot-1';
      update.raw = {
        message: {
          ...(update.raw as { message?: Record<string, unknown> }).message,
          sender: {
            user_id: 'bot-1',
            is_bot: true,
          },
        },
      };

      await harness.service.handleUpdate(update, undefined, 'webhook-photo-94');

      expect(harness.ruleEngine.detect).not.toHaveBeenCalled();
      expect(harness.photoDuplicateEnqueueService.enqueue).not.toHaveBeenCalled();
    });

    describe('image stop-list OCR', () => {
      it('never schedules OCR solely because the commercial text filter is enabled', async () => {
        const harness = createHarness({ settingsOverrides: { commercialAdsFilterEnabled: true } });
        await harness.service.handleUpdate(
          createPhotoAttachmentUpdate(112),
          undefined,
          'webhook-photo-112',
        );
        expect(harness.commercialOcrEnqueueService.enqueue).not.toHaveBeenCalled();
        expect(harness.ruleEngine.detect).toHaveBeenCalled();
      });

      it('enqueues an eligible complete album with exact source identity and image count', async () => {
        const harness = createHarness({
          settingsOverrides: {
            commercialAdsFilterEnabled: true,
            messageLimitsImageTextScanEnabled: true,
            messageLimitsBlockedWords: ['казино'],
          },
        });
        const update = createPhotoAttachmentUpdate(100);
        const rawMessage = (update.raw as { message: { attachments: unknown[] } }).message;
        rawMessage.attachments.push({
          type: 'image',
          payload: {
            photo_id: 'photo-100-secondary',
            url: 'https://cdn.example/photo-100-secondary.jpg',
          },
        });

        await harness.service.handleUpdate(update, undefined, 'webhook-photo-100');

        expect(harness.commercialOcrEnqueueService.enqueue).toHaveBeenCalledTimes(1);
        expect(harness.commercialOcrEnqueueService.enqueue).toHaveBeenCalledWith({
          webhookEventId: 'webhook-photo-100',
          chatId: 'chat-1',
          messageId: 'msg-photo-100',
          sourceCreatedAt: update.message!.createdAt,
          eventTimestamp: update.message!.createdAt,
          imageCount: 2,
          actionEligible: true,
          commercialScanRequested: false,
          imageTextScanRequested: true,
        });
      });

      it.each([
        {
          name: 'non-photo message',
          configureHarness: () =>
            createHarness({
              settingsOverrides: {
                commercialAdsFilterEnabled: true,
                messageLimitsImageTextScanEnabled: true,
                messageLimitsBlockedWords: ['казино'],
              },
            }),
          createCandidate: () => createUpdate(),
        },
        {
          name: 'disabled image stop-list',
          configureHarness: () => createHarness(),
          createCandidate: () => createPhotoAttachmentUpdate(101),
        },
        {
          name: 'bot-authored message',
          configureHarness: () =>
            createHarness({
              settingsOverrides: {
                commercialAdsFilterEnabled: true,
                messageLimitsImageTextScanEnabled: true,
                messageLimitsBlockedWords: ['казино'],
              },
            }),
          createCandidate: () => {
            const update = createPhotoAttachmentUpdate(102);
            update.message!.senderId = 'bot-ocr';
            update.raw = {
              message: {
                ...(update.raw as { message?: Record<string, unknown> }).message,
                sender: { user_id: 'bot-ocr', is_bot: true },
              },
            };
            return update;
          },
        },
        {
          name: 'service-authored message',
          configureHarness: () => {
            const harness = createHarness({
              settingsOverrides: {
                commercialAdsFilterEnabled: true,
                messageLimitsImageTextScanEnabled: true,
                messageLimitsBlockedWords: ['казино'],
              },
            });
            jest
              .spyOn(harness.service as any, 'handleServiceMembershipUpdate')
              .mockResolvedValue(undefined);
            return harness;
          },
          createCandidate: () => {
            const update = createPhotoAttachmentUpdate(103);
            update.raw = {
              message: {
                ...(update.raw as { message?: Record<string, unknown> }).message,
                sender: { user_id: 'service-ocr', type: 'service' },
              },
            };
            return update;
          },
        },
        {
          name: 'message edit',
          configureHarness: () =>
            createHarness({
              settingsOverrides: {
                commercialAdsFilterEnabled: true,
                messageLimitsImageTextScanEnabled: true,
                messageLimitsBlockedWords: ['казино'],
              },
            }),
          createCandidate: () => {
            const update = createPhotoAttachmentUpdate(104);
            update.type = 'message_edited';
            return update;
          },
        },
      ])('does not enqueue a $name for OCR', async ({ configureHarness, createCandidate }) => {
        const harness = configureHarness();

        await harness.service.handleUpdate(createCandidate(), undefined, 'webhook-ocr-negative');

        expect(harness.commercialOcrEnqueueService.enqueue).not.toHaveBeenCalled();
      });

      it('only lowers the action latch for a photo message from a chat admin', async () => {
        const harness = createHarness({
          adminUserIds: ['user-1'],
          settingsOverrides: {
            commercialAdsFilterEnabled: true,
            messageLimitsImageTextScanEnabled: true,
            messageLimitsBlockedWords: ['казино'],
          },
        });
        const update = createPhotoAttachmentUpdate(105);

        await harness.service.handleUpdate(update, undefined, 'webhook-photo-105');

        expect(harness.ruleEngine.detect).not.toHaveBeenCalled();
        expect(harness.commercialOcrEnqueueService.enqueue).toHaveBeenCalledTimes(1);
        expect(harness.commercialOcrEnqueueService.enqueue).toHaveBeenCalledWith({
          webhookEventId: 'webhook-photo-105',
          chatId: 'chat-1',
          messageId: 'msg-photo-105',
          sourceCreatedAt: update.message!.createdAt,
          eventTimestamp: update.message!.createdAt,
          imageCount: 1,
          actionEligible: false,
          commercialScanRequested: false,
          imageTextScanRequested: true,
        });
      });

      it('lowers the OCR latch for a developer-forced spammer when duplicate photos are disabled', async () => {
        const harness = createHarness({
          settingsOverrides: {
            antiDuplicateEnabled: false,
            duplicatePhotoEnabled: false,
            commercialAdsFilterEnabled: true,
            messageLimitsImageTextScanEnabled: true,
            messageLimitsBlockedWords: ['казино'],
            deleteSpammersEnabled: true,
          },
        });
        jest
          .spyOn(harness.service as any, 'isDeveloperForcedGlobalSpammerCachedWithHotPathBudget')
          .mockResolvedValue(true);
        jest.spyOn(harness.service as any, 'resolveSenderChatAdminCheck').mockResolvedValue({
          isAdmin: false,
          source: 'remote',
        });
        jest
          .spyOn(harness.service as any, 'deleteAndKickDetectedGlobalSpammer')
          .mockResolvedValue(true);
        const update = createPhotoAttachmentUpdate(110);

        await harness.service.handleUpdate(update, undefined, 'webhook-photo-110');

        expect(harness.photoDuplicateEnqueueService.enqueue).not.toHaveBeenCalled();
        expect(harness.commercialOcrEnqueueService.enqueue).toHaveBeenCalledWith({
          webhookEventId: 'webhook-photo-110',
          chatId: 'chat-1',
          messageId: 'msg-photo-110',
          sourceCreatedAt: update.message!.createdAt,
          eventTimestamp: update.message!.createdAt,
          imageCount: 1,
          actionEligible: false,
          commercialScanRequested: false,
          imageTextScanRequested: true,
        });
        expect(harness.ruleEngine.detect).not.toHaveBeenCalled();
      });

      it.each([
        {
          name: 'actionable violation',
          suffix: 106,
          options: {
            violations: [
              {
                ruleCode: 'PROFANITY',
                score: 0.91,
                reason: 'Profanity detected',
              },
            ],
          },
          configure: (service: ModerationService) => {
            jest
              .spyOn(service as any, 'consumeChatParticipantModerationImmunity')
              .mockResolvedValue(true);
          },
        },
        {
          name: 'duplicate decision',
          suffix: 107,
          options: { duplicateOutcome: 'decision' as const },
          configure: (service: ModerationService) => {
            jest
              .spyOn(service as any, 'consumeChatParticipantModerationImmunity')
              .mockResolvedValue(true);
          },
        },
        {
          name: 'early destructive path',
          suffix: 108,
          options: {},
          configure: (service: ModerationService) => {
            jest.spyOn(service as any, 'getActiveMute').mockResolvedValue({});
            jest.spyOn(service as any, 'handleActiveMuteMessage').mockResolvedValue(undefined);
          },
        },
      ])(
        'keeps the OCR action latch false for an $name',
        async ({ options, configure, suffix }) => {
          const harness = createHarness({
            ...options,
            settingsOverrides: {
              commercialAdsFilterEnabled: true,
              messageLimitsImageTextScanEnabled: true,
              messageLimitsBlockedWords: ['казино'],
            },
          });
          configure(harness.service);
          const update = createPhotoAttachmentUpdate(suffix);

          await harness.service.handleUpdate(update, undefined, `webhook-photo-${suffix}`);

          expect(harness.commercialOcrEnqueueService.enqueue).toHaveBeenCalled();
          expect(harness.commercialOcrEnqueueService.enqueue.mock.calls).toEqual(
            expect.arrayContaining([
              [
                {
                  webhookEventId: `webhook-photo-${suffix}`,
                  chatId: 'chat-1',
                  messageId: `msg-photo-${suffix}`,
                  sourceCreatedAt: update.message!.createdAt,
                  eventTimestamp: update.message!.createdAt,
                  imageCount: 1,
                  actionEligible: false,
                  commercialScanRequested: false,
                  imageTextScanRequested: true,
                },
              ],
            ]),
          );
          expect(
            harness.commercialOcrEnqueueService.enqueue.mock.calls.some(
              ([params]) => params.actionEligible === true,
            ),
          ).toBe(false);
        },
      );

      it('keeps image stop-list work eligible beside a text REVIEW_ONLY result', async () => {
        const harness = createHarness({
          settingsOverrides: {
            commercialAdsFilterEnabled: true,
            messageLimitsImageTextScanEnabled: true,
            messageLimitsBlockedWords: ['казино'],
          },
          violations: [
            {
              ruleCode: 'COMMERCIAL_AD',
              score: 0,
              reason: 'Review only commercial candidate',
              metadata: {
                actionBand: 'REVIEW_ONLY',
                actionable: false,
                recordable: false,
              },
            },
          ],
        });
        const update = createPhotoAttachmentUpdate(109);

        await harness.service.handleUpdate(update, undefined, 'webhook-photo-109');

        expect(harness.commercialOcrEnqueueService.enqueue).toHaveBeenCalledTimes(1);
        expect(harness.commercialOcrEnqueueService.enqueue).toHaveBeenCalledWith({
          webhookEventId: 'webhook-photo-109',
          chatId: 'chat-1',
          messageId: 'msg-photo-109',
          sourceCreatedAt: update.message!.createdAt,
          eventTimestamp: update.message!.createdAt,
          imageCount: 1,
          actionEligible: true,
          commercialScanRequested: false,
          imageTextScanRequested: true,
        });
      });

      it('enqueues an image-text-only stop-list scan when the opt-in is enabled', async () => {
        const harness = createHarness({
          settingsOverrides: {
            commercialAdsFilterEnabled: false,
            messageLimitsImageTextScanEnabled: true,
            messageLimitsBlockedWords: ['казино'],
          },
        });
        const update = createPhotoAttachmentUpdate(111);

        await harness.service.handleUpdate(update, undefined, 'webhook-photo-111');

        expect(harness.commercialOcrEnqueueService.enqueue).toHaveBeenCalledWith({
          webhookEventId: 'webhook-photo-111',
          chatId: 'chat-1',
          messageId: 'msg-photo-111',
          sourceCreatedAt: update.message!.createdAt,
          eventTimestamp: update.message!.createdAt,
          imageCount: 1,
          actionEligible: true,
          commercialScanRequested: false,
          imageTextScanRequested: true,
        });
      });
    });
  });

  it.each([
    ['photo', createPhotoAttachmentUpdate],
    ['video', createVideoAttachmentUpdate],
    ['file', createFileAttachmentUpdate],
    ['voice', createVoiceAttachmentUpdate],
    ['media-group marker', createMediaGroupMarkerUpdate],
  ])(
    'does not hard-ban rapid %s attachment batches through the real rule engine',
    async (_kind, createMediaUpdate) => {
      const prisma = {
        chat: {
          upsert: jest.fn().mockResolvedValue({
            id: 'chat-1',
            title: 'Chat 1',
            settings: createSettings({
              antiSpamEnabled: true,
              antiDuplicateEnabled: false,
            }),
            domains: [],
          }),
        },
        violation: {
          create: jest.fn(),
        },
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
        webhookEvent: {
          findUnique: jest.fn(),
          update: jest.fn(),
        },
      };
      const redisCounter = createRedisCounterMock();
      const ruleEngine = new RuleEngineService(redisCounter as never);
      const sanctionService = {
        resolveAction: jest.fn(),
      };
      const maxClient = {
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        sanctionService as never,
        maxClient as never,
      );

      for (let index = 1; index <= 6; index += 1) {
        await service.handleUpdate(createMediaUpdate(index));
      }

      expect(redisCounter.incrementOncePerMemberWithTtl).not.toHaveBeenCalledWith(
        expect.stringContaining('message:anti-spam-burst'),
        expect.any(String),
        expect.any(Number),
      );
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(maxClient.banMember).not.toHaveBeenCalled();
      expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    },
  );

  it('hard-bans rapid sticker messages through the real rule engine', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            antiSpamEnabled: true,
            antiDuplicateEnabled: false,
            messageLimitsBotMessageEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const redisCounter = createRedisCounterMock();
    const ruleEngine = new RuleEngineService(redisCounter as never);
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );
    installGuardedDeleteExecutorFixture(service);

    for (let index = 1; index <= 6; index += 1) {
      await service.handleUpdate(createStickerAttachmentUpdate(index));
    }

    expect(redisCounter.replaceRevisionedSetMembershipsBeforeDeadline).toHaveBeenCalledWith(
      expect.objectContaining({
        stateKey: expect.stringContaining('message:anti-spam-burst'),
        windowSeconds: 6,
        countLimit: 6,
      }),
    );
    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-sticker-6');
    expectImmediateBanMember(maxClient.banMember, 'chat-1', 'user-1');
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      messageLimitsBanNotice(
        'Алексей',
        'за короткое время отправлено слишком много сообщений или стикеров',
      ),
    );
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        messageId: 'msg-sticker-6',
        ruleCode: 'MESSAGE_RATE_LIMIT',
        action: SanctionAction.BAN,
      }),
    });
  });

  it('does not hard-ban rapid forwarded message batches through the built-in anti-spam window', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            antiSpamEnabled: true,
            antiDuplicateEnabled: false,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const redisCounter = createRedisCounterMock();
    const ruleEngine = new RuleEngineService(redisCounter as never);
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    for (let index = 1; index <= 6; index += 1) {
      await service.handleUpdate(createLinkedForwardUpdate(index));
    }

    expect(redisCounter.incrementOncePerMemberWithTtl).not.toHaveBeenCalledWith(
      expect.stringContaining('message:anti-spam-burst'),
      expect.any(String),
      expect.any(Number),
    );
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('deletes a wrapped official MAX forward when forwarded messages are disabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            forwardedMessagesEnabled: false,
            antiSpamEnabled: false,
            antiDuplicateEnabled: false,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = new RuleEngineService(createRedisCounterMock() as never);
    const detectSpy = jest.spyOn(ruleEngine, 'detect');
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      ruleEngine,
      sanctionService as never,
      maxClient as never,
    );

    const update = createLinkedForwardUpdate(77);
    update.raw = {
      update_type: 'message_created',
      data: {
        wrapper: {
          id: 'msg-linked-forward-77',
          recipient: { chat_id: 'chat-1' },
          sender: { id: 'user-1' },
          body: null,
          link: {
            type: 'forward',
            message: {
              id: 'source-linked-forward-77',
              recipient: { chat_id: 'source-chat' },
              sender: { id: 'source-user' },
              body: { text: 'пересланный текст 77' },
            },
          },
        },
      },
    };

    await service.handleUpdate(update);

    expect(detectSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        hasForwardedMessage: true,
      }),
    );
    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-linked-forward-77');
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        messageId: 'msg-linked-forward-77',
        ruleCode: 'FORWARDED_MESSAGE_BLOCKED',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('uses a generic public reason in MESSAGE_BLOCKED_WORD bot explanation', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            messageLimitsBlockedWords: ['казино'],
            messageLimitsBotMessageEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [
          {
            ruleCode: 'MESSAGE_BLOCKED_WORD',
            score: 0.89,
            reason: 'Blocked word detected: казино',
            metadata: { blockedWord: 'казино' },
          },
        ],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      majorExplanation('Алексей', 'удалено', 'сообщение совпало со стоп-листом чата'),
    );
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        ruleCode: 'MESSAGE_BLOCKED_WORD_DELETE',
        metadata: expect.objectContaining({ blockedWord: 'казино' }),
      }),
    });
  });

  it.each([true, false])(
    'uses the visible limits explanation switch %s for blocked phones',
    async (enabled) => {
      const prisma = {
        chat: {
          upsert: jest.fn().mockResolvedValue({
            id: 'chat-1',
            title: 'Chat 1',
            settings: createSettings({
              phoneNumbersEnabled: false,
              messageLimitsBotMessageEnabled: enabled,
              messageLimitsBotMessageText: 'Телефоны запрещены: {user}',
              phoneNumbersBotMessageEnabled: !enabled,
            }),
            domains: [],
          }),
        },
        violation: {
          create: jest.fn(),
        },
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
        webhookEvent: {
          findUnique: jest.fn(),
          update: jest.fn(),
        },
      };
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({
          violations: [
            {
              ruleCode: 'PHONE_NUMBER_BLOCKED',
              score: 0.88,
              reason: 'Phone numbers are disabled',
              metadata: { phoneCount: 1 },
            },
          ],
        }),
      };
      const sanctionService = {
        resolveAction: jest.fn(),
      };
      const maxClient = {
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        sanctionService as never,
        maxClient as never,
      );

      await service.handleUpdate(createUpdate());

      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      if (enabled) {
        (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
          'chat-1',
          'Телефоны запрещены: <a href="max://user/user-1">Алексей</a>',
        );
      } else expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(sanctionService.resolveAction).not.toHaveBeenCalled();
      expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(1, {
        data: expect.objectContaining({
          ruleCode: 'PHONE_NUMBER_BLOCKED_DELETE',
          metadata: expect.objectContaining({ phoneCount: 1 }),
        }),
      });
      expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
        data: expect.objectContaining({
          ruleCode: 'PHONE_NUMBER_BLOCKED',
          action: SanctionAction.NONE,
          metadata: expect.objectContaining({ phoneCount: 1 }),
        }),
      });
    },
  );

  it('issues WARN on second MESSAGE_TOO_LONG violation in 12h when warning stage is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            maxMessageLengthEnabled: true,
            maxMessageLength: 100,
            messageLimitsBotMessageEnabled: true,
            messageLimitsWarnEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(2),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'MESSAGE_TOO_LONG', score: 0.82, reason: 'Message too long' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      messageLimitsWarnNotice('Алексей', 'сообщение превышает допустимую длину'),
    );
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'MESSAGE_TOO_LONG',
        action: SanctionAction.WARN,
        metadata: expect.objectContaining({
          messageLimitsViolationCount12h: 2,
          messageLimitsEscalationWindowHours: 12,
        }),
      }),
    });
  });

  it('uses editable warning text for second MESSAGE_BLOCKED_WORD violation', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            messageLimitsBlockedWords: ['казино'],
            messageLimitsBotMessageEnabled: true,
            messageLimitsWarnEnabled: true,
            messageLimitsWarnMessageText:
              '{user}, предупреждение: такие сообщения запрещены в чате.',
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(2),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [
          {
            ruleCode: 'MESSAGE_BLOCKED_WORD',
            score: 0.89,
            reason: 'Blocked word detected: казино',
            metadata: { blockedWord: 'казино' },
          },
        ],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      '<a href="max://user/user-1">Алексей</a>, предупреждение: такие сообщения запрещены в чате.',
    );
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'MESSAGE_BLOCKED_WORD',
        action: SanctionAction.WARN,
        metadata: expect.objectContaining({
          blockedWord: 'казино',
          messageLimitsViolationCount12h: 2,
        }),
      }),
    });
  });

  it('issues permanent BAN on third PHOTO_RATE_LIMIT violation in 12h when ban stage is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            photoMessageCooldownEnabled: true,
            photoMessageCooldownHours: 12,
            messageLimitsBotMessageEnabled: false,
            messageLimitsWarnEnabled: true,
            messageLimitsBanEnabled: true,
            muteDurationHours: 12,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(3),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'PHOTO_RATE_LIMIT', score: 0.88, reason: 'Photo cooldown hit' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );
    installGuardedDeleteExecutorFixture(service);

    await service.handleUpdate(createUpdate());

    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expectImmediateBanMember(maxClient.banMember, 'chat-1', 'user-1');
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      messageLimitsBanNotice('Алексей', 'фото отправляются чаще, чем разрешено в чате'),
    );
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'PHOTO_RATE_LIMIT',
        action: SanctionAction.BAN,
        metadata: expect.objectContaining({
          messageLimitsViolationCount12h: 3,
          messageLimitsEscalationWindowHours: 12,
        }),
      }),
    });
  });

  it('issues MUTE on fourth PHOTO_RATE_LIMIT violation within 12h when mute stage is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            photoMessageCooldownEnabled: true,
            photoMessageCooldownHours: 12,
            messageLimitsBotMessageEnabled: false,
            messageLimitsWarnEnabled: true,
            messageLimitsMuteEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(4),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'PHOTO_RATE_LIMIT', score: 0.88, reason: 'Photo cooldown hit' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    withAutomaticMutePersistenceFixture(prisma);
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );
    installGuardedDeleteExecutorFixture(service);

    await service.handleUpdate(createUpdate());

    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      muteNotice('Алексей', '6ч'),
    );
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'PHOTO_RATE_LIMIT',
        action: SanctionAction.MUTE,
        metadata: expect.objectContaining({
          messageLimitsViolationCount12h: 4,
          messageLimitsEscalationWindowHours: 12,
        }),
      }),
    });
  });

  it('detects video attachment in raw payload and deletes message without sanctions', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ videoMessagesEnabled: false }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockImplementation(async (params: { hasVideoAttachment?: boolean }) => {
        if (params.hasVideoAttachment) {
          return {
            violations: [{ ruleCode: 'VIDEO_BLOCKED', score: 0.88, reason: 'Video disabled' }],
          };
        }

        return { violations: [] };
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createVideoAttachmentUpdate());

    const detectionArgs = (ruleEngine.detect as jest.Mock).mock.calls[0][0] as {
      hasVideoAttachment?: boolean;
    };
    expect(detectionArgs.hasVideoAttachment).toBe(true);
    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-video-1');
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'VIDEO_BLOCKED',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('routes delete moderation through the bot with confirmed delete permission', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ videoMessagesEnabled: false }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockImplementation(async (params: { hasVideoAttachment?: boolean }) => {
        if (params.hasVideoAttachment) {
          return {
            violations: [{ ruleCode: 'VIDEO_BLOCKED', score: 0.88, reason: 'Video disabled' }],
          };
        }

        return { violations: [] };
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const maxBotLinkService = {
      isKnownBotUserId: jest.fn().mockReturnValue(false),
      resolveBotIdForModerationAction: jest.fn().mockResolvedValue('id613002203036_4_bot'),
      resolveContactIdSync: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
    );

    await service.handleUpdate(createVideoAttachmentUpdate());

    expect(maxBotLinkService.resolveBotIdForModerationAction).toHaveBeenCalledWith({
      chatId: 'chat-1',
      action: 'delete_message',
      fallbackToPrimary: true,
    });
    expect(maxClient.deleteMessage).toHaveBeenCalledWith(
      'chat-1',
      'msg-video-1',
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
        immediate: true,
        trafficClass: 'critical',
        actionHealthLane: 'critical',
        sourceTag: 'moderation_delete',
      }),
    );
  });

  it('skips rule moderation for configured runtime bot senders', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ videoMessagesEnabled: false }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'VIDEO_BLOCKED', score: 0.88, reason: 'Video disabled' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const maxBotLinkService = {
      isKnownBotUserId: jest.fn((userId: string | null | undefined) => userId === '613002203036_5'),
      resolveContactIdSync: jest.fn(),
    };
    const update = createVideoAttachmentUpdate();
    update.message!.senderId = '613002203036_5';
    update.message!.senderName = 'Рэкс';

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
    );

    await service.handleUpdate(update);

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
  });

  it('skips delete moderation cleanly when no bot has delete permission in the chat', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ videoMessagesEnabled: false }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockImplementation(async (params: { hasVideoAttachment?: boolean }) => {
        if (params.hasVideoAttachment) {
          return {
            violations: [{ ruleCode: 'VIDEO_BLOCKED', score: 0.88, reason: 'Video disabled' }],
          };
        }

        return { violations: [] };
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const maxBotLinkService = {
      isKnownBotUserId: jest.fn().mockReturnValue(false),
      resolveBotIdForModerationAction: jest.fn().mockResolvedValue(null),
      resolveContactIdSync: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
    );

    await expect(service.handleUpdate(createVideoAttachmentUpdate())).resolves.toBeUndefined();

    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ruleCode: 'VIDEO_BLOCKED',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('passes sticker attachments separately from photos to rule engine', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            photoMessageCooldownEnabled: true,
            stickerMessageCooldownEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({ violations: [] }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createStickerAttachmentUpdate());

    const detectionArgs = (ruleEngine.detect as jest.Mock).mock.calls[0][0] as {
      hasPhotoAttachment?: boolean;
      hasStickerAttachment?: boolean;
    };
    expect(detectionArgs.hasStickerAttachment).toBe(true);
    expect(detectionArgs.hasPhotoAttachment).toBe(false);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('treats file attachments with image mime as photos', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            photoMessageCooldownEnabled: true,
            fileMessagesEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({ violations: [] }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createImageFileAttachmentUpdate());

    const detectionArgs = (ruleEngine.detect as jest.Mock).mock.calls[0][0] as {
      hasPhotoAttachment?: boolean;
      hasFileAttachment?: boolean;
    };
    expect(detectionArgs.hasPhotoAttachment).toBe(true);
    expect(detectionArgs.hasFileAttachment).toBe(false);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('ignores photo attachments from the replied-to message when photo messages are disabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ photoMessagesEnabled: false }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockImplementation(async (params: { hasPhotoAttachment?: boolean }) => {
        if (params.hasPhotoAttachment) {
          return {
            violations: [{ ruleCode: 'PHOTO_BLOCKED', score: 0.88, reason: 'Photo disabled' }],
          };
        }

        return { violations: [] };
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createReplyToPhotoUpdate());

    const detectionArgs = (ruleEngine.detect as jest.Mock).mock.calls[0][0] as {
      hasPhotoAttachment?: boolean;
    };
    expect(detectionArgs.hasPhotoAttachment).toBe(false);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('detects forwarded video attachment and moderates it as regular message content', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ videoMessagesEnabled: false }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockImplementation(async (params: { hasVideoAttachment?: boolean }) => {
        if (params.hasVideoAttachment) {
          return {
            violations: [{ ruleCode: 'VIDEO_BLOCKED', score: 0.88, reason: 'Video disabled' }],
          };
        }

        return { violations: [] };
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createForwardedVideoAttachmentUpdate());

    const detectionArgs = (ruleEngine.detect as jest.Mock).mock.calls[0][0] as {
      hasVideoAttachment?: boolean;
    };
    expect(detectionArgs.hasVideoAttachment).toBe(true);
    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-forwarded-video-1');
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'VIDEO_BLOCKED',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('detects forwarded voice attachment and moderates it as regular message content', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ voiceMessagesEnabled: false }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockImplementation(async (params: { hasVoiceAttachment?: boolean }) => {
        if (params.hasVoiceAttachment) {
          return {
            violations: [{ ruleCode: 'VOICE_BLOCKED', score: 0.88, reason: 'Voice disabled' }],
          };
        }

        return { violations: [] };
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createForwardedVoiceAttachmentUpdate());

    const detectionArgs = (ruleEngine.detect as jest.Mock).mock.calls[0][0] as {
      hasVoiceAttachment?: boolean;
    };
    expect(detectionArgs.hasVoiceAttachment).toBe(true);
    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-forwarded-voice-1');
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'VOICE_BLOCKED',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('detects forwarded file attachment and moderates it as regular message content', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ fileMessagesEnabled: false }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockImplementation(async (params: { hasFileAttachment?: boolean }) => {
        if (params.hasFileAttachment) {
          return {
            violations: [{ ruleCode: 'FILE_BLOCKED', score: 0.88, reason: 'File disabled' }],
          };
        }

        return { violations: [] };
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createForwardedFileAttachmentUpdate());

    const detectionArgs = (ruleEngine.detect as jest.Mock).mock.calls[0][0] as {
      hasFileAttachment?: boolean;
    };
    expect(detectionArgs.hasFileAttachment).toBe(true);
    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-forwarded-file-1');
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'FILE_BLOCKED',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('sends voice restriction explanation with button when message-limits toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            voiceMessagesEnabled: false,
            messageLimitsBotMessageEnabled: true,
            messageLimitsBotButtonEnabled: true,
            messageLimitsBotButtonUrl: 'https://max.ru/channel/rules',
            messageLimitsBotButtonText: 'Правила чата',
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockImplementation(async (params: { hasVoiceAttachment?: boolean }) => {
        if (params.hasVoiceAttachment) {
          return {
            violations: [{ ruleCode: 'VOICE_BLOCKED', score: 0.88, reason: 'Voice disabled' }],
          };
        }

        return { violations: [] };
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createVoiceAttachmentUpdate());

    const detectionArgs = (ruleEngine.detect as jest.Mock).mock.calls[0][0] as {
      hasVoiceAttachment?: boolean;
    };
    expect(detectionArgs.hasVoiceAttachment).toBe(true);
    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-voice-1');
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      majorExplanation('Алексей', 'удалено', 'отправка голосовых сообщений в этом чате отключена'),
      {
        button: {
          text: 'Правила чата',
          url: 'https://max.ru/channel/rules',
        },
        textFormat: 'html',
        marketplacePublication: {
          entityId: 'chat-1',
          purpose: 'MODERATION_NOTICE',
          module: 'MESSAGE_LIMITS',
        },
      },
    );
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
  });
});
