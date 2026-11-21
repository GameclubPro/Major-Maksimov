import { stopWordsPolicySchema } from '@maxim/contracts/settings';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Prisma } from '../../prisma/prisma-client';
import {
  createMultibotHarness,
  type MultibotHarness,
} from '../../webhook/webhook-multibot-fullpath.spec-support';
import { buildMessageScopedModerationActionClaimKey } from '../moderation-message-action-claim';
import type { ModerationDeleteIntentService } from '../moderation-delete-intent.service';
import type { SecurePhotoDownloader } from '../photo-duplicate/secure-photo-downloader';
import { CommercialOcrAnalysisService } from './commercial-ocr-analysis.service';
import * as nativeBehavior from './commercial-ocr-behavior-identity';
import { CommercialOcrCacheStore } from './commercial-ocr-cache.store';
import { COMMERCIAL_OCR_DELETE_RULE_CODE } from './commercial-ocr-delete-guard.service';
import { CommercialOcrMetricsService } from './commercial-ocr-metrics.service';
import type { CommercialOcrPreprocessor } from './commercial-ocr-preprocessor';
import { COMMERCIAL_OCR_DEFAULT_VERSION } from './commercial-ocr.queue';
import {
  buildImageTextStopListBinding,
  fingerprintImageTextStopListPolicy,
  IMAGE_TEXT_STOP_LIST_ACTION_DEDUPE_PREFIX,
  IMAGE_TEXT_STOP_LIST_MESSAGE_ACTION_RULE_CODE,
  parseImageTextStopListBinding,
} from './image-text-stop-list-binding';
import type { NativeTesseractOcrAdapter } from './native-tesseract-ocr.adapter';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const describeStores = databaseUrl && redisUrl ? describe : describe.skip;
const resolveExpectedIdentity =
  nativeBehavior.resolveExpectedCommercialOcrProductionBehaviorIdentity;
type ClaimedIntentInput = Parameters<
  ModerationDeleteIntentService['ensureIntentWithMessageActionClaim']
>[0];
type PolicyKind = 'legacy-latin' | 'typed-word' | 'typed-phrase';

jest.setTimeout(60_000);

describeStores(
  'image stop-list analysis and final authorization with native PostgreSQL/Redis',
  () => {
    let harness: MultibotHarness | undefined;
    let cache: CommercialOcrCacheStore | undefined;
    let metrics: CommercialOcrMetricsService | undefined;
    let directory: string;
    let manifestPath: string;

    beforeAll(async () => {
      directory = await mkdtemp(join(tmpdir(), 'maxim-stop-list-native-'));
      manifestPath = join(directory, 'synthetic-native-manifest.json');
      // FLAG: Synthetic native artifacts isolate OCR from the machine. Production identity parsing,
      // fingerprinting, stores, durable claims, final guards and HTTP mutation admission stay real.
      const manifest = nativeBehavior.createCommercialOcrNativeBuildManifest({
        runtime: {
          nodeVersion: process.version,
          platform: 'linux',
          architecture: 'x64',
          sharpVersion: '0.35.5',
          libvipsVersion: '8.18.3',
        },
        tesseract: {
          version: 'tesseract 5.5.2',
          binarySha256: '1'.repeat(64),
          availableLanguages: ['eng', 'rus'],
          traineddataSha256: { eng: '2'.repeat(64), rus: '3'.repeat(64) },
        },
      });
      await writeFile(
        manifestPath,
        nativeBehavior.serializeCommercialOcrNativeBuildManifest(manifest),
        { mode: 0o444 },
      );
    });
    beforeEach(() => {
      jest
        .spyOn(nativeBehavior, 'resolveExpectedCommercialOcrProductionBehaviorIdentity')
        .mockImplementation((config) => resolveExpectedIdentity(config, manifestPath));
    });
    afterEach(async () => {
      try {
        cache?.onModuleDestroy();
        await metrics?.onModuleDestroy();
      } finally {
        try {
          await harness?.dispose();
        } finally {
          cache = undefined;
          metrics = undefined;
          harness = undefined;
          jest.restoreAllMocks();
        }
      }
    });
    afterAll(async () => {
      if (directory) await rm(directory, { recursive: true, force: true });
    });

    async function fixture(
      kind: PolicyKind = 'typed-word',
      failure?: 'disagreement' | 'low-confidence',
    ) {
      const s = (harness = await createMultibotHarness({
        databaseUrl,
        redisUrl,
        bots: 2,
        mode: 'on',
      }));
      s.config.set('IMAGE_TEXT_STOP_LIST_OCR_ROLLOUT_MODE', 'on');
      await s.deleteQueue.pause();
      const value = kind === 'typed-phrase' ? 'доход без вложений' : 'casino';
      const policy = stopWordsPolicySchema.parse({
        enabled: true,
        imageScanEnabled: true,
        rules: [{ id: 'image-rule', kind: kind === 'typed-phrase' ? 'PHRASE' : 'WORD', value }],
        sanctions: { warnEnabled: true, muteEnabled: true, banEnabled: true },
      });
      const [chatId] = await s.seedCatalog(1, {
        maxMessageLengthEnabled: false,
        antiSpamEnabled: false,
        commercialAdsFilterEnabled: false,
        messageLimitsImageTextScanEnabled: kind === 'legacy-latin',
        messageLimitsBlockedWords: kind === 'legacy-latin' ? ['casino'] : [],
        stopWordsPolicy: kind === 'legacy-latin' ? Prisma.DbNull : policy,
        messageLimitsWarnEnabled: true,
        messageLimitsMuteEnabled: true,
        messageLimitsBanEnabled: true,
      });
      const id = chatId!;
      const messageId = `image-stop-list-${randomUUID()}`;
      const photoId = `photo-${randomUUID()}`;
      const sourceAt = new Date(Date.now() - 1_000);
      const deadline = new Date(Date.now() + 60_000);
      const caption = 'Private caption stays in the remote source fixture';
      const source = {
        id: messageId,
        timestamp: sourceAt.getTime(),
        recipient: { chat_id: id, chat_type: 'chat' },
        sender: { user_id: 'fixture-user', is_bot: false },
        body: {
          mid: messageId,
          text: caption,
          attachments: [
            { type: 'image', payload: { photo_id: photoId, url: 'https://i.oneme.ru/test' } },
          ],
        },
      };
      s.messages.set(messageId, source);
      const settings = await s.prisma.chatSettings.findUniqueOrThrow({ where: { chatId: id } });
      const primaryText = `Private OCR context ${value.toUpperCase()}`;
      const confirmationText =
        failure === 'disagreement'
          ? 'Unrelated harmless confirmation'
          : `Different private OCR context ${value}`;
      const downloader = {
        download: jest
          .fn<
            ReturnType<SecurePhotoDownloader['download']>,
            Parameters<SecurePhotoDownloader['download']>
          >()
          .mockResolvedValue({ bytes: Buffer.from(randomUUID()), format: 'jpeg' }),
      } satisfies Pick<SecurePhotoDownloader, 'download'>;
      const preprocessor = {
        prepare: jest
          .fn<
            ReturnType<CommercialOcrPreprocessor['prepare']>,
            Parameters<CommercialOcrPreprocessor['prepare']>
          >()
          .mockImplementation(async (bytes) => ({ bytes, width: 100, height: 50 })),
      } satisfies Pick<CommercialOcrPreprocessor, 'prepare'>;
      const native = {
        recognize: jest
          .fn<
            ReturnType<NativeTesseractOcrAdapter['recognize']>,
            Parameters<NativeTesseractOcrAdapter['recognize']>
          >()
          .mockImplementation(async (_bytes, options = {}) => {
            const primary = options.passLabel === 'primary';
            const text = primary ? primaryText : confirmationText;
            return {
              ok: true,
              status: 'recognized',
              passLabel: options.passLabel ?? 'primary',
              psm: options.psm ?? 11,
              text,
              aggregateConfidence: 96,
              lines: [],
              truncated: false,
              durationMs: 1,
              words: [...text.matchAll(/\S+/gu)].map((match) => ({
                text: match[0],
                start: match.index!,
                end: match.index! + match[0].length,
                confidence: failure === 'low-confidence' && !primary ? 89 : 96,
                lineIndex: 0,
                boundingBox: { left: 0, top: 0, width: 10, height: 10 },
              })),
            };
          }),
      } satisfies Pick<NativeTesseractOcrAdapter, 'recognize'>;
      cache = new CommercialOcrCacheStore();
      metrics = new CommercialOcrMetricsService(s.config);
      const analysis = new CommercialOcrAnalysisService(
        downloader as unknown as SecurePhotoDownloader,
        preprocessor as unknown as CommercialOcrPreprocessor,
        native as unknown as NativeTesseractOcrAdapter,
        cache,
        metrics,
        s.config,
      );
      const analyzed = await analysis.analyzeAlbum({
        album: {
          chatId: id,
          messageId,
          senderId: 'fixture-user',
          createdAtMs: sourceAt.getTime(),
          caption,
          images: [{ source: 'direct', photoId, downloadUrl: 'https://i.oneme.ru/test' }],
        },
        caption,
        settings,
        ocrVersion: COMMERCIAL_OCR_DEFAULT_VERSION,
        deadlineAtMs: deadline.getTime(),
        authorizeStage: async () => true,
        commercialScanEnabled: false,
        imageTextStopListScanEnabled: true,
      });
      expect(analyzed.kind).toBe('complete');
      if (analyzed.kind !== 'complete')
        throw new Error('Expected completed synthetic native analysis');
      const expectCrop = failure !== undefined && kind !== 'legacy-latin';
      expect(native.recognize.mock.calls.map((call) => [call[1]?.passLabel, call[1]?.psm])).toEqual(
        [['primary', 11], ['confirmation', 6], ...(expectCrop ? [['confirmation', 6]] : [])],
      );
      expect(
        preprocessor.prepare.mock.calls.map(([, pass, options]) => [pass, options?.crop]),
      ).toEqual([
        ['primary', undefined],
        ['confirmation', undefined],
        ...(expectCrop ? [['primary', { left: 0, top: 0, width: 22, height: 22 }]] : []),
      ]);
      expect(downloader.download).toHaveBeenCalledTimes(1);
      const decision = analyzed.imageTextStopListDecision;
      const persist = async () => {
        if (decision.kind !== 'match')
          throw new Error('Unconfirmed OCR must never persist an intent');
        const expected = nativeBehavior.resolveExpectedCommercialOcrProductionBehaviorIdentity(
          s.config,
        ).identity;
        expect(expected.complete).toBe(true);
        const binding = buildImageTextStopListBinding({
          ocrVersion: COMMERCIAL_OCR_DEFAULT_VERSION,
          nativeBehaviorFingerprintSha256: expected.fingerprintSha256,
          policyFingerprint: fingerprintImageTextStopListPolicy({ settings, domainAllowlist: [] }),
          ...decision,
          senderId: 'fixture-user',
          sourceCreatedAt: sourceAt.toISOString(),
          deleteDeadlineAt: deadline.toISOString(),
          orderedPhotoIds: [photoId],
          caption,
        });
        const digest = createHash('sha256')
          .update(JSON.stringify([messageId, COMMERCIAL_OCR_DELETE_RULE_CODE, binding]))
          .digest('hex');
        const input: ClaimedIntentInput = {
          claim: {
            dedupeKey: IMAGE_TEXT_STOP_LIST_ACTION_DEDUPE_PREFIX + digest,
            messageActionKey: buildMessageScopedModerationActionClaimKey(id, messageId),
            chatId: id,
            userId: 'fixture-user',
            messageId,
            ruleCode: IMAGE_TEXT_STOP_LIST_MESSAGE_ACTION_RULE_CODE,
            updateType: 'message_action',
          },
          intent: {
            chatId: id,
            messageId,
            subjectUserId: 'fixture-user',
            sourceMessageAt: sourceAt,
            reasonKey: 'image-text-stop-list-delete:' + digest,
            ruleCode: COMMERCIAL_OCR_DELETE_RULE_CODE,
            entityType: 'CHAT',
            messageAuthorKind: 'user',
            originBotId: s.bots[0]!.id,
            routingPolicy: 'delete_capable',
            retryUntilAt: deadline,
            commercialOcrDeadlineAt: deadline,
            event: {
              userId: 'fixture-user',
              eventType: 'MESSAGE',
              score: 0.96,
              metadata: {
                source: 'image_text_ocr',
                enforcementScope: 'delete_only',
                matchedRuleCode: decision.ruleCode,
                blockedWord: decision.value,
                imageTextStopListBinding: binding,
              },
            },
          },
        };
        const persisted = await s.intents.ensureIntentWithMessageActionClaim(input);
        expect(persisted.intent).toMatchObject({ rollout: 'execute', status: 'PENDING' });
        if (!persisted.intent?.intentId)
          throw new Error('Expected a persisted OCR intent identity');
        return { intentId: persisted.intent.intentId };
      };
      return {
        s,
        chatId: id,
        messageId,
        source,
        caption,
        primaryText,
        confirmationText,
        decision,
        persist,
      };
    }

    it.each(['legacy-latin', 'typed-word', 'typed-phrase'] as const)(
      'confirms %s in two passes and deletes once with no sanctions or persisted OCR text',
      async (kind) => {
        const f = await fixture(kind);
        expect(f.decision).toMatchObject({ kind: 'match', ruleCode: 'MESSAGE_BLOCKED_WORD' });
        await f.persist();
        await f.persist();
        const jobs = await f.s.deleteQueue.getJobs(['paused', 'wait', 'prioritized', 'delayed']);
        expect(jobs).toHaveLength(1);
        expect(Object.keys(jobs[0]!.data)).toEqual(['intentId']);
        await f.s.deleteQueue.resume();
        await f.s.drain();
        const intent = await f.s.prisma.moderationDeleteIntent.findUniqueOrThrow({
          where: { chatId_messageId: { chatId: f.chatId, messageId: f.messageId } },
          include: { reasons: true },
        });
        expect(intent.status).toBe('SUCCEEDED');
        expect(intent.remoteDeleteSucceededAt).not.toBeNull();
        expect(intent.reasons).toHaveLength(1);
        expect(intent.reasons[0]!.metadata).toMatchObject({ moderationDeleteVerified: true });
        expect(parseImageTextStopListBinding(intent.reasons[0]!.metadata)).toMatchObject({
          value:
            kind === 'legacy-latin'
              ? 'сасино'
              : kind === 'typed-phrase'
                ? 'доход без вложений'
                : 'casino',
          ...(kind === 'legacy-latin' ? {} : { ruleId: 'image-rule' }),
        });
        expect(f.s.effects).toEqual([
          expect.objectContaining({ method: 'delete', messageId: f.messageId }),
        ]);
        const events = await f.s.prisma.moderationEvent.findMany({ where: { chatId: f.chatId } });
        expect(events).toEqual([
          expect.objectContaining({
            ruleCode: COMMERCIAL_OCR_DELETE_RULE_CODE,
            action: 'DELETE_MESSAGE',
            operator: 'BOT',
            metadata: expect.objectContaining({ moderationDeleteVerified: true }),
          }),
        ]);
        expect(events.some((event) => ['WARN', 'MUTE', 'BAN'].includes(event.action))).toBe(false);
        const persisted = JSON.stringify({
          reasons: intent.reasons,
          events,
          jobs: jobs.map((job) => job.data),
        });
        for (const privateText of [f.caption, f.primaryText, f.confirmationText])
          expect(persisted).not.toContain(privateText);
        expect(f.s.failures).toEqual([]);
      },
    );

    it.each([
      ['policy', 'image_text_stop_list_settings_disabled'],
      ['source', 'image_text_stop_list_message_changed'],
      ['immunity', 'image_text_stop_list_participant_immune'],
    ] as const)('refuses final dispatch after queued %s revocation', async (change, errorCode) => {
      const f = await fixture();
      await f.persist();
      if (change === 'policy')
        await f.s.prisma.chatSettings.update({
          where: { chatId: f.chatId },
          data: {
            stopWordsPolicy: stopWordsPolicySchema.parse({}),
            stopWordsRevision: { increment: 1 },
          },
        });
      else if (change === 'source')
        f.s.messages.set(f.messageId, {
          ...f.source,
          body: {
            ...f.source.body,
            attachments: [
              {
                type: 'image',
                payload: { photo_id: 'replacement-photo', url: 'https://i.oneme.ru/changed' },
              },
            ],
          },
        });
      else
        await f.s.prisma.chatParticipantModerationImmunity.create({
          data: {
            chatId: f.chatId,
            userId: 'fixture-user',
            dailyViolationLimit: 1,
            expiresAt: new Date(Date.now() + 86_400_000),
          },
        });
      await f.s.deleteQueue.resume();
      await f.s.drain();
      const intent = await f.s.prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { chatId_messageId: { chatId: f.chatId, messageId: f.messageId } },
        include: { reasons: true },
      });
      expect(intent).toMatchObject({
        status: 'FAILED_TERMINAL',
        lastErrorCode: errorCode,
        remoteDeleteSucceededAt: null,
      });
      expect(f.s.effects).toEqual([]);
      expect(intent.reasons).toHaveLength(1);
      expect(intent.reasons[0]!.metadata).not.toHaveProperty('moderationDeleteVerified');
      expect(
        await f.s.prisma.moderationEvent.count({
          where: { chatId: f.chatId, action: 'DELETE_MESSAGE' },
        }),
      ).toBe(0);
      expect(f.s.messages.has(f.messageId)).toBe(true);
      expect(f.s.failures).toEqual([]);
    });

    it('retains an unknown remote DELETE without an OCR success receipt', async () => {
      const f = await fixture();
      const persisted = await f.persist();
      f.s.ambiguousNextDelete();
      await f.s.intents.attemptIntent(persisted.intentId);
      const intent = await f.s.prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { chatId_messageId: { chatId: f.chatId, messageId: f.messageId } },
        include: { reasons: true },
      });
      expect(intent).toMatchObject({ status: 'AMBIGUOUS', remoteDeleteSucceededAt: null });
      expect(intent.deleteDispatchStartedAt).not.toBeNull();
      expect(intent.reasons[0]!.metadata).not.toHaveProperty('moderationDeleteVerified');
      expect(
        await f.s.prisma.moderationEvent.count({
          where: { chatId: f.chatId, action: 'DELETE_MESSAGE' },
        }),
      ).toBe(0);
      expect(f.s.effects).toEqual([
        expect.objectContaining({ method: 'delete', messageId: f.messageId }),
      ]);
      expect(f.s.messages.has(f.messageId)).toBe(true);
      expect(f.s.failures).toEqual([]);
    });

    it.each([
      ['native-identity', 'image_text_stop_list_binding_stale'],
      ['decision-identity', 'image_text_stop_list_binding_invalid'],
    ] as const)(
      "does not grant a secondary OCR reason another reason's %s proof",
      async (change, errorCode) => {
        const f = await fixture();
        const persisted = await f.persist();
        const original = await f.s.prisma.moderationDeleteIntentReason.findFirstOrThrow({
          where: { intentId: persisted.intentId },
        });
        const binding = parseImageTextStopListBinding(original.metadata)!;
        const metadata = original.metadata as Record<string, Prisma.JsonValue>;
        await f.s.prisma.moderationDeleteIntentReason.create({
          data: {
            id: randomUUID(),
            intentId: persisted.intentId,
            reasonKey: 'secondary-image-stop-list',
            ruleCode: COMMERCIAL_OCR_DELETE_RULE_CODE,
            userId: 'fixture-user',
            eventType: 'MESSAGE',
            createdAt: new Date(original.createdAt.getTime() + 1),
            metadata: {
              ...metadata,
              ...(change === 'decision-identity'
                ? { matchedRuleCode: 'MESSAGE_BLOCKED_DOMAIN' }
                : {
                    imageTextStopListBinding: {
                      ...binding,
                      nativeBehaviorFingerprintSha256:
                        binding.nativeBehaviorFingerprintSha256 === 'a'.repeat(64)
                          ? 'b'.repeat(64)
                          : 'a'.repeat(64),
                    },
                  }),
            },
          },
        });
        await f.s.intents.attemptIntent(persisted.intentId);
        const intent = await f.s.prisma.moderationDeleteIntent.findUniqueOrThrow({
          where: { id: persisted.intentId },
          include: { reasons: true },
        });
        expect(intent).toMatchObject({
          status: 'FAILED_TERMINAL',
          lastErrorCode: errorCode,
          remoteDeleteSucceededAt: null,
        });
        expect(intent.reasons).toHaveLength(2);
        for (const reason of intent.reasons)
          expect(reason.metadata).not.toHaveProperty('moderationDeleteVerified');
        expect(f.s.effects).toEqual([]);
        expect(f.s.failures).toEqual([]);
      },
    );

    it('does not grant a revoked OCR reason the independent length reason receipt', async () => {
      const f = await fixture();
      const persisted = await f.persist();
      await f.s.prisma.chatSettings.update({
        where: { chatId: f.chatId },
        data: {
          stopWordsPolicy: stopWordsPolicySchema.parse({}),
          stopWordsRevision: { increment: 1 },
          maxMessageLengthEnabled: true,
          maxMessageLength: 10,
        },
      });
      await f.s.intents.ensureIntent(
        {
          chatId: f.chatId,
          messageId: f.messageId,
          subjectUserId: 'fixture-user',
          sourceMessageAt: new Date(f.source.timestamp),
          originBotId: f.s.bots[0]!.id,
          entityType: 'CHAT',
          messageAuthorKind: 'user',
          reasonKey: 'independent-length',
          ruleCode: 'MESSAGE_TOO_LONG_DELETE',
          event: { userId: 'fixture-user', eventType: 'MESSAGE' },
        },
        { enqueue: false },
      );
      await f.s.intents.attemptIntent(persisted.intentId);
      const intent = await f.s.prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { chatId_messageId: { chatId: f.chatId, messageId: f.messageId } },
        include: { reasons: true },
      });
      expect(intent.status).toBe('SUCCEEDED');
      expect(intent.remoteDeleteSucceededAt).not.toBeNull();
      expect(intent.reasons).toHaveLength(2);
      expect(
        intent.reasons.find((reason) => reason.ruleCode === COMMERCIAL_OCR_DELETE_RULE_CODE)!
          .metadata,
      ).not.toHaveProperty('moderationDeleteVerified');
      expect(
        intent.reasons.find((reason) => reason.ruleCode === 'MESSAGE_TOO_LONG_DELETE')!.metadata,
      ).toMatchObject({ moderationDeleteVerified: true });
      const events = await f.s.prisma.moderationEvent.findMany({ where: { chatId: f.chatId } });
      expect(
        events.filter((event) => event.ruleCode === COMMERCIAL_OCR_DELETE_RULE_CODE),
      ).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            metadata: expect.objectContaining({ moderationDeleteVerified: true }),
          }),
        ]),
      );
      expect(f.s.effects).toEqual([
        expect.objectContaining({ method: 'delete', messageId: f.messageId }),
      ]);
      expect(f.s.failures).toEqual([]);
    });

    it('does not create an OCR receipt while settling an earlier remote success', async () => {
      const f = await fixture();
      const persisted = await f.persist();
      await f.s.prisma.moderationDeleteIntent.update({
        where: { id: persisted.intentId },
        data: {
          status: 'AMBIGUOUS',
          remoteDeleteSucceededAt: new Date(),
          remoteDeleteSucceededBotId: f.s.bots[0]!.id,
        },
      });
      f.s.messages.delete(f.messageId);
      await f.s.intents.attemptIntent(persisted.intentId);
      const intent = await f.s.prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { id: persisted.intentId },
        include: { reasons: true },
      });
      expect(intent.status).toBe('SUCCEEDED');
      expect(intent.reasons[0]!.metadata).not.toHaveProperty('moderationDeleteVerified');
      const events = await f.s.prisma.moderationEvent.findMany({ where: { chatId: f.chatId } });
      for (const event of events)
        expect(event.metadata).not.toHaveProperty('moderationDeleteVerified');
      expect(f.s.effects).toEqual([]);
      expect(f.s.failures).toEqual([]);
    });

    it('keeps the original OCR deadline after the last awaited database fence', async () => {
      const f = await fixture();
      const persisted = await f.persist();
      type DeadlineFence = {
        assertVerifiedReasonDeadlineFence(
          intent: unknown,
          leaseToken: string,
          botId: string,
          proof: {
            verifiedReasonDeadlines?: { reasonKey: string; deadlineAtMs: number }[];
          },
        ): Promise<number>;
      };
      const service = f.s.intents as unknown as DeadlineFence;
      const fence = service.assertVerifiedReasonDeadlineFence.bind(service);
      const finalFence = jest
        .spyOn(service, 'assertVerifiedReasonDeadlineFence')
        .mockImplementation(async (...args) => {
          const clockAtMs = await fence(...args);
          const [permit] = args[3].verifiedReasonDeadlines ?? [];
          expect(permit).toBeDefined();
          jest.spyOn(Date, 'now').mockReturnValue(permit!.deadlineAtMs + 1);
          return clockAtMs;
        });
      try {
        await f.s.intents.attemptIntent(persisted.intentId);
        expect(finalFence).toHaveBeenCalledTimes(1);
      } finally {
        jest.restoreAllMocks();
      }
      const intent = await f.s.prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { id: persisted.intentId },
        include: { reasons: true },
      });
      expect(intent.status).not.toBe('SUCCEEDED');
      expect(intent.remoteDeleteSucceededAt).toBeNull();
      expect(intent.reasons[0]!.metadata).not.toHaveProperty('moderationDeleteVerified');
      expect(f.s.effects).toEqual([]);
      expect(f.s.failures).toEqual([]);
    });

    it.each(['disagreement', 'low-confidence'] as const)(
      'does not persist an action after %s OCR passes',
      async (failure) => {
        const f = await fixture('typed-word', failure);
        expect(f.decision).toEqual({ kind: 'no_action' });
        expect(await f.s.prisma.moderationDeleteIntent.count({ where: { chatId: f.chatId } })).toBe(
          0,
        );
        expect(
          await f.s.prisma.moderationViolationMessageClaim.count({ where: { chatId: f.chatId } }),
        ).toBe(0);
        expect(f.s.effects).toEqual([]);
      },
    );
  },
);
