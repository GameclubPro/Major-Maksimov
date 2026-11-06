import { MaxBotContextService } from '../../max/max-bot-context.service';
import {
  parseMessageDuplicateBinding,
  exactImageSettingsDigest,
  type MessageDuplicateBinding,
} from './message-duplicate-state';
import {
  extractDuplicateMessageContent,
  digestDuplicateContent,
} from './message-duplicate-content';
import { ConfigService } from '@nestjs/config';
import type { MaxClientService } from '../../max/max-client.service';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { MaxUpdate } from '@maxim/contracts';
import type {
  ChatSettings,
  ModerationDeleteIntent,
  ModerationDeleteIntentReason,
  Prisma,
} from '../../prisma/prisma-client';
import { WebhookParser } from '../../webhook/webhook.parser';
import type { DuplicateModerationActionRequest } from '../duplicate-moderation.actions';
import type { EnsureModerationDeleteIntentInput } from '../moderation-delete-intent.types';
import { PhotoDuplicateAnalysisService } from '../photo-duplicate/photo-duplicate-analysis.service';
import { PhotoDuplicateHistoryStore } from '../photo-duplicate/photo-duplicate-history.store';
import {
  PhotoDownloadHttpError,
  type SecurePhotoDownloader,
} from '../photo-duplicate/secure-photo-downloader';
import {
  PHOTO_FINGERPRINT_ALGORITHM_VERSION,
  PhotoFingerprintService,
} from '../photo-duplicate/photo-fingerprint';
import { RedisCounterService } from '../redis-counter.service';
import { MessageDuplicateDeleteGuardService } from './message-duplicate-delete-guard.service';
import { MessageDuplicateEnforcementService } from './message-duplicate-enforcement.service';
import { MessageDuplicateHistoryService } from './message-duplicate-history.service';
import { MessageDuplicateMediaService } from './message-duplicate-media.service';
import { MessageDuplicateProcessor } from './message-duplicate.processor';
import {
  MessageDuplicateEnqueueService,
  MessageDuplicateOrderingStore,
  type MessageDuplicateJob,
} from './message-duplicate.queue';
import { MessageDuplicateService } from './message-duplicate.service';
import { duplicateSettings } from './message-duplicate-test-fixtures';
import {
  duplicateRevocationKey,
  MessageDuplicateAuthorizationService,
} from './message-duplicate-authorization.service';
import { MessageDuplicateAdmissionService } from './message-duplicate-admission.service';
import {
  MessageDuplicateRecompressionIndex,
  type MessageDuplicateRecompressionCandidate,
} from './message-duplicate-recompression-index';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL ?? '';
const localRedis = /^redis:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(redisUrl);
const shortHash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);

const recompressionPoster = (phone = '8-902-009-99-49', price = 'Price 1000') =>
  Buffer.from(`<svg width="512" height="512"><rect width="512" height="512" fill="#253b53"/>
        <circle cx="180" cy="200" r="110" fill="#d0a040"/><circle cx="180" cy="200" r="60" fill="#253b53"/>
        <path d="M0 330L512 290L512 380L0 420Z" fill="#e5e1d7"/>
        <text x="30" y="60" font-family="DejaVu Sans" font-size="34" fill="white">TYRE SERVICE</text>
        <text x="30" y="445" font-family="DejaVu Sans" font-size="28" fill="white">${phone}</text>
        <text x="30" y="485" font-family="DejaVu Sans" font-size="28" fill="white">${price}</text></svg>`);

async function prepareSyntheticImages() {
  const png = await sharp(
    Buffer.from(Array.from({ length: 32 * 24 * 3 }, (_, index) => (index * 17) % 256)),
    { raw: { width: 32, height: 24, channels: 3 } },
  )
    .png()
    .toBuffer();
  const webp = await sharp(png).webp({ lossless: true }).toBuffer();
  const different = await sharp(png).negate().png().toBuffer();
  const variants = await Promise.all(
    [0, 1, 2, 3].map(async (index) => {
      const image = await sharp(png)
        .rotate(index * 90)
        .png()
        .toBuffer();
      return Object.freeze({
        png: image,
        webp: await sharp(image).webp({ lossless: true }).toBuffer(),
        different: await sharp(image).negate().png().toBuffer(),
      });
    }),
  );
  const posters: Record<
    string,
    Readonly<{ quality92: Buffer; quality89: Buffer; jpeg92: Buffer; jpeg65: Buffer }>
  > = {};
  for (const [phone, price] of [
    ['8-902-009-99-49', 'Price 1000'],
    ['8-902-009-99-48', 'Price 1000'],
    ['8-902-009-99-49', 'Price 1009'],
  ]) {
    const source = recompressionPoster(phone, price);
    const jpeg92 = await sharp(source).jpeg({ quality: 92 }).toBuffer();
    posters[JSON.stringify([phone, price])] = Object.freeze({
      quality92: await sharp(source).webp({ quality: 92 }).toBuffer(),
      quality89: await sharp(source).webp({ quality: 89 }).toBuffer(),
      jpeg92,
      jpeg65: await sharp(jpeg92).jpeg({ quality: 65 }).toBuffer(),
    });
  }
  const grayImage = (gray: number) =>
    sharp({
      create: {
        width: 128,
        height: 128,
        channels: 3,
        background: { r: gray, g: gray, b: gray },
      },
    })
      .png()
      .toBuffer();
  const grayscale = Object.freeze({
    0: await grayImage(0),
    32: await grayImage(32),
    64: await grayImage(64),
    96: await grayImage(96),
    128: await grayImage(128),
    129: await grayImage(129),
    130: await grayImage(130),
  });
  return Object.freeze({
    png,
    webp,
    different,
    variants: Object.freeze(variants),
    posters: Object.freeze(posters),
    grayscale,
  });
}

let syntheticImages: Awaited<ReturnType<typeof prepareSyntheticImages>> | undefined;

function preparedSyntheticImages() {
  if (!syntheticImages) throw new Error('Synthetic duplicate images must be prepared before Redis');
  return syntheticImages;
}

function recompressionPosterImages(phone = '8-902-009-99-49', price = 'Price 1000') {
  const images = preparedSyntheticImages().posters[JSON.stringify([phone, price])];
  if (!images) throw new Error('Unknown synthetic duplicate poster');
  return images;
}

type SanctionDeleteReceipt = Pick<
  ModerationDeleteIntent,
  | 'id'
  | 'status'
  | 'chatId'
  | 'messageId'
  | 'subjectUserId'
  | 'remoteDeleteSucceededAt'
  | 'remoteDeleteSucceededBotId'
  | 'succeededBotId'
> & {
  reasons: Pick<
    ModerationDeleteIntentReason,
    'reasonKey' | 'ruleCode' | 'userId' | 'metadata' | 'createdAt'
  >[];
};

async function createFlow(overrides: Partial<ChatSettings> = {}) {
  const { png, webp, different, variants } = preparedSyntheticImages();
  const suffix = randomUUID();
  const chatId = `-${randomBytes(6).readUIntBE(0, 6)}`;
  const config = new ConfigService({ REDIS_URL: redisUrl });
  const inspector = new Redis(redisUrl);
  const redis = new RedisCounterService(config);
  const photoStore = new PhotoDuplicateHistoryStore(config);
  const ordering = new MessageDuplicateOrderingStore(config);
  const queue = new Queue<MessageDuplicateJob>(`test-message-duplicate-${suffix}`, {
    connection: { url: redisUrl },
  });
  const keys = new Set<string>();
  const cachePhotos = photoStore.cachePhotoFingerprints.bind(photoStore);
  jest.spyOn(photoStore, 'cachePhotoFingerprints').mockImplementation((entries, ttl) => {
    entries.forEach(({ photoId }) =>
      keys.add(
        `photo-duplicate:history:v2:fingerprint-cache:${shortHash(PHOTO_FINGERPRINT_ALGORITHM_VERSION)}:${shortHash(photoId)}`,
      ),
    );
    return cachePhotos(entries, ttl);
  });
  const replace = redis.replaceRevisionedSetMembershipsBeforeDeadline.bind(redis);
  jest.spyOn(redis, 'replaceRevisionedSetMembershipsBeforeDeadline').mockImplementation((input) => {
    keys.add(input.stateKey);
    input.membershipKeys.forEach((key) => keys.add(key));
    return replace(input);
  });
  const set = redis.setStringWithTtl.bind(redis);
  const imageIndex = redis.duplicateRecompressionIndex.bind(redis);
  jest.spyOn(redis, 'duplicateRecompressionIndex').mockImplementation((indexKeys, input) => {
    indexKeys.forEach((key) => keys.add(key));
    return imageIndex(indexKeys, input);
  });
  jest.spyOn(redis, 'setStringWithTtl').mockImplementation((key, value, ttl) => {
    keys.add(key);
    return set(key, value, ttl);
  });
  const setAbsent = redis.setStringIfAbsentWithTtl.bind(redis);
  jest.spyOn(redis, 'setStringIfAbsentWithTtl').mockImplementation((key, value, ttl) => {
    keys.add(key);
    return setAbsent(key, value, ttl);
  });
  for (const part of [
    'pending',
    'expiry',
    'members',
    'sequence',
    'completed',
    'lock',
    'action-eligibility',
  ]) {
    keys.add(`message-duplicate:ordering:v1:${shortHash(chatId)}:${part}`);
  }
  const settings = {
    ...duplicateSettings({ duplicatePhotoEnabled: true, ...overrides }),
    chat: { entityType: 'CHAT', admins: [] as { userId: string }[], rules: null },
  };
  const start = Date.now() - 10000;
  const policyValue = {
    mode: 'full',
    revision: 1,
    effectiveAtMs: start - 604800000,
    expiresAtMs: Number.MAX_SAFE_INTEGER,
  };
  const policy = { resolve: jest.fn(async () => policyValue) };
  const rows = new Map<string, MaxUpdate>();
  const remote = new Map<string, Record<string, unknown>>();
  const images = new Map<string, Buffer>();
  const downloadFailures = new Map<string, Error>();
  const deleted: string[] = [];
  const sanctions: Array<{ messageId: string; action: string }> = [];
  const records = new Map<
    string,
    {
      input: EnsureModerationDeleteIntentInput;
      at: Date;
      deletedAt: Date | null;
      verifiedReceiptMetadata: Record<string, unknown> | null;
    }
  >();
  const durableClaims = new Map<string, { id: string; createdAt: Date; [key: string]: unknown }>();
  const claimedMessages = new Set<string>();
  const intents = {
    claimMessageActionBeforeQualification: jest.fn(async ({ messageId }: { messageId: string }) => {
      const resumed = claimedMessages.has(messageId);
      claimedMessages.add(messageId);
      return resumed ? 'resumed' : 'claimed';
    }),
    releaseUnmaterializedMessageAction: jest.fn(
      async ({
        claim,
        binding,
      }: {
        claim: { messageId: string };
        binding: MessageDuplicateBinding;
      }) => {
        if (records.has(`intent:${claim.messageId}`) || !claimedMessages.delete(claim.messageId))
          return false;
        for (const eventTimestampMs of new Set([
          binding.eventTimestampMs,
          binding.authorization!.eventTimestampMs,
        ])) {
          const key = duplicateRevocationKey(chatId, claim.messageId, eventTimestampMs);
          durableClaims.set(key, { id: key, createdAt: new Date() });
        }
        return true;
      },
    ),
    ensureIntentWithMessageActionClaim: jest.fn(
      async ({ intent }: { intent: EnsureModerationDeleteIntentInput }) => {
        const id = `intent:${intent.messageId}`;
        if (!records.has(id))
          records.set(id, {
            input: intent,
            at: new Date(),
            deletedAt: null,
            verifiedReceiptMetadata: null,
          });
        return { claim: 'claimed', intent: { intentId: id, rollout: 'execute' } };
      },
    ),
  };
  const max = {
    getChatMemberAccess: jest.fn(async (_chatId: string, userId: string) => ({
      userId,
      isAdmin: false,
      isOwner: false,
    })),
    getExactMessageRow: jest.fn<
      ReturnType<MaxClientService['getExactMessageRow']>,
      Parameters<MaxClientService['getExactMessageRow']>
    >(async (_chatId: string, messageId: string) => remote.get(messageId) ?? null),
    deleteMessage: jest.fn(async (_chatId: string, messageId: string) => {
      remote.delete(messageId);
      deleted.push(messageId);
      const record = records.get(`intent:${messageId}`)!;
      record.deletedAt = new Date();
      record.verifiedReceiptMetadata = {
        ...(record.input.event?.metadata as Record<string, unknown>),
        moderationDeleteVerified: true,
      };
      return { success: true };
    }),
  };
  const prisma = {
    moderationViolationMessageClaim: {
      createMany: jest.fn(
        async ({ data }: { data: Array<{ dedupeKey: string; [key: string]: unknown }> }) => {
          let count = 0;
          for (const row of data) {
            if (durableClaims.has(row.dedupeKey)) continue;
            durableClaims.set(row.dedupeKey, { ...row, id: row.dedupeKey, createdAt: new Date() });
            count += 1;
          }
          return { count };
        },
      ),
      findUnique: jest.fn(
        async ({ where }: { where: { dedupeKey: string } }) =>
          durableClaims.get(where.dedupeKey) ?? null,
      ),
    },
    chatSettings: { findUnique: jest.fn(async () => settings) },
    webhookEvent: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => {
        const update = rows.get(where.id);
        return update ? { status: 'PROCESSED', botId: 'bot', normalizedPayload: update } : null;
      }),
    },
    moderationEvent: { findFirst: jest.fn(async () => null) },
    moderationDeleteIntentReason: {
      findMany: jest.fn(async ({ where }: { where: { intentId: string } }) => {
        const record = records.get(where.intentId);
        return record
          ? [
              {
                ruleCode: record.input.ruleCode,
                reasonKey: record.input.reasonKey,
                metadata: record.input.event?.metadata,
              },
            ]
          : [];
      }),
    },
    moderationDeleteIntent: {
      findUnique: jest.fn(
        async ({
          where,
          select,
        }: {
          where: { id: string };
          select?: { reasons?: { where?: { reasonKey?: string } } };
        }): Promise<SanctionDeleteReceipt | null> => {
          const record = records.get(where.id);
          if (!record) return null;
          const reasonKey = select?.reasons?.where?.reasonKey;
          return {
            id: where.id,
            status: record.deletedAt ? 'SUCCEEDED' : 'PENDING',
            chatId,
            messageId: record.input.messageId,
            subjectUserId: record.input.subjectUserId ?? null,
            remoteDeleteSucceededAt: record.deletedAt,
            remoteDeleteSucceededBotId: record.deletedAt ? 'bot' : null,
            succeededBotId: record.deletedAt ? 'bot' : null,
            reasons:
              reasonKey && reasonKey !== record.input.reasonKey
                ? []
                : [
                    {
                      reasonKey: record.input.reasonKey,
                      ruleCode: record.input.ruleCode ?? record.input.reasonKey,
                      userId: record.input.event?.userId ?? record.input.subjectUserId ?? null,
                      metadata: (record.verifiedReceiptMetadata ??
                        record.input.event?.metadata ??
                        null) as Prisma.JsonValue,
                      createdAt: record.at,
                    },
                  ],
          };
        },
      ),
    },
  };
  const bots = {
    isKnownBotUserId: (userId: string) => userId === '999',
    isRegisteredModerationBotId: (botId: string) => botId === 'bot',
    getDefaultBotId: () => 'bot',
    resolveExecutableBotId: (botId: string) => (botId === 'bot' ? botId : null),
  };
  const immunity = { consumeForMessage: jest.fn(async () => 'not_granted') };
  const governor = { decide: jest.fn(async () => ({ action: 'allow' })) };
  const history = new MessageDuplicateHistoryService(redis);
  const authorization = new MessageDuplicateAuthorizationService(prisma as never, ordering);
  const admission = new MessageDuplicateAdmissionService(prisma as never);
  const guard = new MessageDuplicateDeleteGuardService(
    prisma as never,
    max as never,
    bots as never,
    immunity as never,
    policy as never,
    history,
    config,
    authorization,
  );
  const enforcement = new MessageDuplicateEnforcementService(
    intents as never,
    policy as never,
    guard,
  );
  const downloads = jest.fn<
    ReturnType<SecurePhotoDownloader['download']>,
    Parameters<SecurePhotoDownloader['download']>
  >(async (url) => {
    const failure = downloadFailures.get(url);
    if (failure) throw failure;
    const bytes = images.get(url);
    if (!bytes) throw new Error('Synthetic photo source unavailable');
    const pathname = new URL(url).pathname;
    return {
      bytes,
      format: pathname.endsWith('.webp') ? 'webp' : pathname.endsWith('.jpeg') ? 'jpeg' : 'png',
    };
  });
  const photos = new PhotoDuplicateAnalysisService(
    { download: downloads } as never,
    new PhotoFingerprintService({ canonicalOnly: true }),
    photoStore,
  );
  const media = new MessageDuplicateMediaService(
    prisma as never,
    redis,
    photos,
    policy as never,
    history,
    enforcement,
    bots as never,
    governor as never,
    config,
    max as never,
    new MaxBotContextService(),
  );
  const execute = jest.fn(async (request: DuplicateModerationActionRequest) => {
    const id = `intent:${request.messageId}`;
    if (!records.get(id)?.deletedAt) {
      if (!(await request.authorizeDelete())) return;
      const allowed = await guard.assertIntentStillActionable({
        intentId: id,
        chatId,
        messageId: request.messageId,
        subjectUserId: request.userId,
        botId: 'bot',
      });
      if (allowed !== 'allowed') return;
      await max.deleteMessage(chatId, request.messageId);
    }
    if (
      request.outcome.kind === 'decision' &&
      request.authorizeSanction &&
      (await request.authorizeSanction())
    ) {
      await request.beforeSanctionMutation?.();
      sanctions.push({ messageId: request.messageId, action: request.outcome.decision.action });
    }
  });
  const processor = new MessageDuplicateProcessor(
    {
      processMessageDuplicateJob: (
        job: MessageDuplicateJob,
        lease: Parameters<MessageDuplicateMediaService['process']>[1],
      ) => media.process(job, lease, execute),
    } as never,
    ordering,
  );
  const service = new MessageDuplicateService(
    policy as never,
    history,
    enforcement,
    new MessageDuplicateEnqueueService(queue, ordering, admission),
    authorization,
  );
  let next = 0;
  const prepare = (
    options: {
      id?: string;
      text?: string;
      markup?: Record<string, unknown>[];
      buttons?: Record<string, unknown>[][];
      photo?: 'png' | 'webp' | 'different';
      imageBytes?: Buffer;
      imageFormat?: 'png' | 'webp' | 'jpeg';
      photoId?: string;
      photoCount?: number;
      reversePhotos?: boolean;
      changedPhotoIndex?: number;
      missingUrl?: boolean;
      messageLink?: 'forward' | 'reply';
      userId?: number;
      time?: number;
      editedFrom?: number;
    } = {},
  ) => {
    const id = options.id ?? `message-${++next}`;
    const time = options.time ?? start + next * 100;
    const photoId = `${suffix}:${options.photoId ?? id}`;
    const imageFormat = options.imageFormat ?? (options.photo === 'webp' ? 'webp' : 'png');
    const url = `https://i.oneme.ru/${suffix}:${id}.${imageFormat}`;
    const attachments = options.photo
      ? Array.from({ length: options.photoCount ?? 1 }, (_, index) => ({
          type: 'image',
          payload: {
            photo_id: `${photoId}:${index}`,
            ...(options.missingUrl ? {} : { url: `${url}?item=${index}` }),
          },
        }))
      : [];
    const keyboard = options.buttons
      ? [{ type: 'inline_keyboard', payload: { buttons: options.buttons } }]
      : [];
    const message = (photoAttachments: typeof attachments) => {
      const content = {
        text: options.text ?? '',
        ...(options.markup ? { markup: options.markup } : {}),
        attachments: [...photoAttachments, ...keyboard],
      };
      return {
        sender: { user_id: options.userId ?? 123, name: 'Test' },
        recipient: { chat_id: Number(chatId), chat_type: 'chat' },
        timestamp: options.editedFrom ?? time,
        body: options.messageLink
          ? { mid: id, text: options.messageLink === 'reply' ? (options.text ?? '') : '' }
          : { mid: id, ...content },
        ...(options.messageLink
          ? {
              link: {
                type: options.messageLink,
                chat_id: -987654321,
                sender: { user_id: 789, name: 'Original author' },
                message: { mid: `source-${id}`, ...content },
              },
            }
          : {}),
      };
    };
    const raw = {
      update_type: options.editedFrom === undefined ? 'message_created' : 'message_edited',
      timestamp: time,
      message: message(attachments),
    };
    const update = new WebhookParser().parse(raw);
    const receipt = `${suffix}:${id}:${time}`;
    rows.set(receipt, update);
    remote.set(
      id,
      message(
        options.photo
          ? Array.from({ length: options.photoCount ?? 1 }, (_, index) => ({
              type: 'image',
              payload: { photo_id: `${photoId}:${index}`, url: `${url}?item=${index}` },
            }))
          : [],
      ),
    );
    if (options.photo) {
      images.set(
        url,
        options.imageBytes ??
          (options.photo === 'different' ? different : options.photo === 'webp' ? webp : png),
      );
      for (let index = 0; index < (options.photoCount ?? 1); index += 1) {
        const variant =
          variants[
            (options.reversePhotos ? (options.photoCount ?? 1) - index - 1 : index) %
              variants.length
          ]!;
        images.set(
          `${url}?item=${index}`,
          options.imageBytes ??
            variant[options.changedPhotoIndex === index ? 'different' : options.photo!],
        );
      }
    }
    return { update, receipt, id, time };
  };
  const ingest = async (item: ReturnType<typeof prepare>, actionEligible = true) => {
    await service.observeLifecycle(item.update);
    await service.observe({
      update: item.update,
      webhookEventId: item.receipt,
      eventTimestampMs: item.time,
      settings,
      botId: 'bot',
      actionEligible,
      track: true,
      executeFullAction: execute,
    });
    return (await queue.getJobs(['delayed'])).find(
      (job) => job.data.webhookEventId === item.receipt,
    );
  };
  return {
    prepare,
    ingest,
    service,
    media,
    photos,
    remote,
    redis,
    chatId,
    processor,
    settings,
    deleted,
    sanctions,
    downloads,
    downloadFailures,
    images,
    intents,
    claimedMessages,
    records,
    max,
    inspector,
    keys,
    policyValue,
    immunity,
    governor,
    history,
    guard,
    authorization,
    queue,
    ordering,
    async close() {
      await redis.deleteKeysByPattern(`dup:window:v1:${digestDuplicateContent(chatId)}:*`);
      await redis.deleteKeysByPattern(`message-duplicate:ordering:v2:${shortHash(chatId)}:*`);
      await queue.obliterate();
      await queue.close();
      if (keys.size) await inspector.del(...keys);
      await ordering.onModuleDestroy();
      await photoStore.onModuleDestroy();
      await redis.onModuleDestroy();
      await inspector.quit();
    },
  };
}

(localRedis ? describe : describe.skip)(
  'message duplicate flow with real Redis, ordering and image fingerprints',
  () => {
    let flow: Awaited<ReturnType<typeof createFlow>>;
    // FLAG: Cold rendering belongs to bounded suite setup, before any Redis clients.
    // Cases share read-only bytes while retaining fresh state and their 5-second budget.
    beforeAll(async () => {
      syntheticImages = await prepareSyntheticImages();
    }, 30_000);
    afterEach(async () => {
      jest.restoreAllMocks();
      await flow?.close();
    });

    const prepareStaleRecompressionOriginal = async (
      format: 'webp' | 'jpeg',
      failure: number | 'missing',
      currentMissingUrl = false,
    ) => {
      flow = await createFlow({ duplicatePhotoScope: 'CHAT' });
      const poster = recompressionPosterImages();
      const originalBytes = format === 'jpeg' ? poster.jpeg92 : poster.quality92;
      const repeatedBytes = format === 'jpeg' ? poster.jpeg65 : poster.quality89;
      const original = flow.prepare({
        photo: 'webp',
        imageFormat: format,
        imageBytes: originalBytes,
        missingUrl: failure === 'missing',
      });
      const filler = flow.prepare({ photo: 'different' });
      for (const item of [original, filler])
        await flow.processor.process((await flow.ingest(item))!);
      const buckets = await Promise.all(
        [...flow.keys]
          .filter((key) => key.startsWith('dup:recompression:v1:'))
          .map((key) => flow.inspector.get(key)),
      );
      const anchor = buckets
        .flatMap((raw) => JSON.parse(raw ?? '[]') as MessageDuplicateRecompressionCandidate[])
        .find((candidate) => candidate.messageId === original.id);
      expect(anchor).toBeDefined();
      const renewed = structuredClone(flow.remote.get(original.id)!);
      const body = renewed.body as {
        attachments: Array<{ type: string; payload: { photo_id: string; url: string } }>;
      };
      const originalUrl = body.attachments[0]!.payload.url;
      expect(flow.downloads.mock.calls.filter(([url]) => url === originalUrl)).toHaveLength(1);
      const freshUrl = `${originalUrl}&renewed=1`;
      body.attachments[0]!.payload.url = freshUrl;
      flow.remote.set(original.id, renewed);
      flow.images.set(freshUrl, originalBytes);
      flow.downloadFailures.set(
        originalUrl,
        new PhotoDownloadHttpError(failure === 'missing' ? 403 : failure),
      );
      flow.downloads.mockClear();
      flow.max.getExactMessageRow.mockClear();
      const repeat = flow.prepare({
        photo: 'webp',
        imageFormat: format,
        imageBytes: repeatedBytes,
        userId: 456,
        missingUrl: currentMissingUrl,
      });
      return {
        original,
        repeat,
        originalUrl,
        freshUrl,
        renewed,
        body,
        repeatedBytes,
        anchor: anchor!,
      };
    };

    it.each(['MESSAGE', 'TEXT', 'IMAGE'] as const)(
      'deletes an identical announcement from a parser-supported array envelope (%s)',
      async (mode) => {
        flow = await createFlow({ duplicateCompareMode: mode === 'IMAGE' ? 'MESSAGE' : mode });
        const options = {
          text: 'Одинаковое объявление',
          ...(mode === 'IMAGE' ? { photo: 'png' as const } : {}),
        };
        const firstJob = await flow.ingest(flow.prepare(options));
        if (firstJob) await flow.processor.process(firstJob);
        const repeat = flow.prepare(options);
        const raw = repeat.update.raw as Record<string, unknown>;
        Object.assign(
          repeat.update,
          new WebhookParser().parse({
            update_type: 'message_created',
            timestamp: repeat.time,
            data: { items: [raw.message] },
          }),
        );
        const repeatJob = await flow.ingest(repeat);
        if (repeatJob) await flow.processor.process(repeatJob);
        expect(flow.deleted).toEqual([repeat.id]);
      },
    );

    it('verifies a repeated announcement when the exact MAX read returns a content body', async () => {
      flow = await createFlow();
      await flow.ingest(flow.prepare({ text: 'Одинаковое объявление' }));
      const repeat = flow.prepare({ text: 'Одинаковое объявление' });
      const { body, ...row } = flow.remote.get(repeat.id)!;
      flow.remote.set(repeat.id, { ...row, content: body });
      await flow.ingest(repeat);
      expect(flow.deleted).toEqual([repeat.id]);
    });

    it('deletes an edit into an existing announcement from an event envelope', async () => {
      flow = await createFlow();
      await flow.ingest(flow.prepare({ id: 'original', text: 'Одинаковое объявление' }));
      const first = flow.prepare({ id: 'edited', text: 'Другое объявление' });
      await flow.ingest(first);
      const edit = flow.prepare({
        id: first.id,
        text: 'Одинаковое объявление',
        time: first.time + 100,
        editedFrom: first.time,
      });
      const raw = edit.update.raw as Record<string, unknown>;
      Object.assign(
        edit.update,
        new WebhookParser().parse({
          update_type: 'message_edited',
          timestamp: edit.time,
          message_edited: { message: raw.message },
        }),
      );
      await flow.ingest(edit);
      expect(flow.deleted).toEqual([edit.id]);
    });

    it('does not renew a delayed envelope original beyond its publication window', async () => {
      flow = await createFlow({ duplicateWarnWindowSec: 3600 });
      const now = Date.now();
      const original = flow.prepare({
        id: 'delayed',
        text: 'Одинаковое объявление',
        time: now - 30 * 60_000,
      });
      const raw = original.update.raw as Record<string, unknown>;
      const originalMessage = {
        ...(raw.message as Record<string, unknown>),
        timestamp: now - 70 * 60_000,
      };
      flow.remote.set(original.id, originalMessage);
      Object.assign(
        original.update,
        new WebhookParser().parse({
          update_type: 'message_created',
          timestamp: original.time,
          data: { message: originalMessage },
        }),
      );
      await flow.ingest(original);
      await flow.ingest(flow.prepare({ text: 'Одинаковое объявление', time: now - 1000 }));
      expect(flow.deleted).toEqual([]);
    });

    it.each(['MESSAGE', 'TEXT'] as const)(
      'anchors the 24-hour window to the accepted original (%s)',
      async (mode) => {
        flow = await createFlow({ duplicateCompareMode: mode, duplicateWarnWindowSec: 86400 });
        let now = Date.now();
        jest.spyOn(Date, 'now').mockImplementation(() => now);
        const originalTime = now;
        await flow.ingest(flow.prepare({ id: 'original', text: 'offer', time: now }));
        now = originalTime + 21 * 3600000;
        await flow.ingest(flow.prepare({ id: 'morning', text: 'offer', time: now }));
        expect(flow.deleted).toEqual(['morning']);
        now = originalTime + 30 * 3600000;
        await flow.ingest(flow.prepare({ id: 'evening', text: 'offer', time: now }));
        expect(flow.deleted).toEqual(['morning']);
        now = originalTime + 43 * 3600000;
        await flow.ingest(flow.prepare({ id: 'next-morning', text: 'offer', time: now }));
        expect(flow.deleted).toEqual(['morning', 'next-morning']);
        const evidence = parseMessageDuplicateBinding(
          flow.records.get('intent:next-morning')!.input.event!.metadata,
        )!;
        expect(evidence.original!.messageId).toBe('evening');
        expect(evidence.original!.expiresAtMs).toBe(originalTime + 54 * 3600000);
      },
    );

    it('resumes the same sanction stage after deletion without counting the retry', async () => {
      flow = await createFlow({ duplicateWarnEnabled: true, duplicateMuteEnabled: true });
      await flow.ingest(flow.prepare({ text: 'offer' }));
      const repeat = flow.prepare({ text: 'offer' });
      await flow.ingest(repeat);
      // The production executor deduplicates sanctions; this fixture verifies the immutable stage.
      await flow.ingest(repeat);
      expect(flow.sanctions.map((sanction) => sanction.action)).toEqual(['WARN', 'WARN']);
      expect(flow.deleted).toEqual([repeat.id]);
      const next = flow.prepare({ text: 'offer' });
      await flow.ingest(next);
      expect(flow.sanctions.at(-1)?.action).toBe('MUTE');
    });

    it('does not let protected attempts advance WARN to MUTE or BAN', async () => {
      flow = await createFlow({
        duplicateWarnEnabled: true,
        duplicateMuteEnabled: true,
        duplicateBanEnabled: true,
      });
      await flow.ingest(flow.prepare({ text: 'offer' }));
      flow.immunity.consumeForMessage.mockResolvedValue('granted');
      await flow.ingest(flow.prepare({ text: 'offer' }));
      await flow.ingest(flow.prepare({ text: 'offer' }));
      flow.immunity.consumeForMessage.mockResolvedValue('not_granted');
      const repeat = flow.prepare({ text: 'offer' });
      await flow.ingest(repeat);
      expect(flow.sanctions).toEqual([{ messageId: repeat.id, action: 'WARN' }]);
    });

    it('requires a live original even when no removal webhook was delivered', async () => {
      flow = await createFlow();
      const first = flow.prepare({ text: 'offer' });
      await flow.ingest(first);
      flow.remote.delete(first.id);
      await flow.ingest(flow.prepare({ text: 'offer' }));
      expect(flow.deleted).toEqual([]);
    });

    it.each(['text', 'image'] as const)(
      'recovers %s comparisons after structured original absence without a removal webhook',
      async (kind) => {
        flow = await createFlow();
        flow.max.getExactMessageRow.mockImplementation(async (_chatId, messageId) => {
          const row = flow.remote.get(messageId);
          if (!row) throw { response: { status: 404, data: { code: 'message.not.found' } } };
          return row;
        });
        const remove = jest.spyOn(flow.history, 'remove');
        const prepare = () => flow.prepare(kind === 'image' ? { photo: 'png' } : { text: 'offer' });
        const observe = async (item: ReturnType<typeof prepare>) => {
          const job = await flow.ingest(item);
          if (job) await flow.processor.process(job);
        };
        const original = prepare();
        await observe(original);
        flow.remote.delete(original.id);
        const unverifiedRepeat = prepare();
        await observe(unverifiedRepeat);
        expect(remove).toHaveBeenCalledWith(flow.chatId, original.id);
        expect(flow.deleted).toEqual([]);
        expect(flow.sanctions).toEqual([]);
        expect(flow.records.size).toBe(0);

        const freshOriginal = prepare();
        await observe(freshOriginal);
        const confirmedRepeat = prepare();
        await observe(confirmedRepeat);
        expect(flow.deleted).toEqual([confirmedRepeat.id]);
        const binding = parseMessageDuplicateBinding(
          flow.records.get(`intent:${confirmedRepeat.id}`)!.input.event!.metadata,
        )!;
        expect(binding.original!.messageId).toBe(freshOriginal.id);
        expect(binding.original!.publishedAtMs).toBe(freshOriginal.time);
      },
    );

    it.each(['text', 'image'] as const)(
      'resumes %s sanctions after our confirmed DELETE and a transient lookup failure',
      async (kind) => {
        flow = await createFlow({ duplicateWarnEnabled: true, duplicateWarnMaxCount: 1 });
        let interruptSanction = true;
        flow.max.getExactMessageRow.mockImplementation(async (_chatId, messageId) => {
          const row = flow.remote.get(messageId);
          if (row) return row;
          if (interruptSanction) {
            interruptSanction = false;
            throw new Error('Temporary post-delete lookup failure');
          }
          throw { response: { status: 404, data: { code: 'message.not.found' } } };
        });
        const prepare = () => flow.prepare(kind === 'image' ? { photo: 'png' } : { text: 'offer' });
        const firstJob = await flow.ingest(prepare());
        if (firstJob) await flow.processor.process(firstJob);
        const repeat = prepare();
        let job: Awaited<ReturnType<typeof flow.ingest>> = undefined;
        if (kind === 'image') {
          job = await flow.ingest(repeat);
          await expect(flow.processor.process(job!)).rejects.toThrow(
            'Temporary post-delete lookup failure',
          );
        } else {
          await expect(flow.ingest(repeat)).rejects.toThrow('Temporary post-delete lookup failure');
        }
        expect(flow.deleted).toEqual([repeat.id]);
        expect(flow.sanctions).toEqual([]);
        const binding = parseMessageDuplicateBinding(
          flow.records.get(`intent:${repeat.id}`)!.input.event!.metadata,
        )!;
        expect(binding.sanction!.repeatCount).toBe(1);

        if (kind === 'image') await flow.processor.process(job!);
        else await flow.ingest(repeat);
        expect(flow.deleted).toEqual([repeat.id]);
        expect(flow.sanctions).toEqual([{ messageId: repeat.id, action: 'WARN' }]);
        expect(
          parseMessageDuplicateBinding(
            flow.records.get(`intent:${repeat.id}`)!.input.event!.metadata,
          )!.sanction!.repeatCount,
        ).toBe(1);
      },
    );

    it('never deletes the original after a cosmetic edit following a rejected duplicate', async () => {
      flow = await createFlow();
      const first = flow.prepare({ text: 'offer' });
      await flow.ingest(first);
      const second = flow.prepare({ text: 'offer' });
      await flow.ingest(second);
      await flow.ingest(
        flow.prepare({
          id: first.id,
          text: '  offer  ',
          time: second.time + 100,
          editedFrom: first.time,
        }),
      );
      expect(flow.deleted).toEqual([second.id]);
    });

    it('checks materially changed old content against a newer original', async () => {
      flow = await createFlow();
      const old = flow.prepare({ text: 'old unrelated text' });
      await flow.ingest(old);
      const original = flow.prepare({ text: 'offer' });
      await flow.ingest(original);
      await flow.ingest(
        flow.prepare({
          id: old.id,
          text: 'offer',
          time: original.time + 100,
          editedFrom: old.time,
        }),
      );
      expect(flow.deleted).toEqual([old.id]);
    });

    it('does not rejuvenate an old original when whitespace is edited', async () => {
      flow = await createFlow({ duplicateWarnWindowSec: 86400 });
      const now = Date.now();
      const old = flow.prepare({ id: 'old', text: 'offer', time: now - 26 * 3600000 });
      await flow.history.observe({
        chatId: flow.chatId,
        userId: '123',
        messageId: old.id,
        eventTimestampMs: old.time,
        controlRevision: 1,
        settings: flow.settings,
        content: extractDuplicateMessageContent(old.update.raw),
      });
      await flow.ingest(
        flow.prepare({ id: old.id, text: ' offer ', time: now - 1000, editedFrom: old.time }),
      );
      await flow.ingest(flow.prepare({ text: 'offer', time: now }));
      expect(flow.deleted).toEqual([]);
    });

    it('invalidates evidence for an edit even when normal observation is bypassed', async () => {
      flow = await createFlow();
      const first = flow.prepare({ text: 'offer' });
      await flow.ingest(first);
      const edit = flow.prepare({
        id: first.id,
        text: 'different',
        time: first.time + 100,
        editedFrom: first.time,
      });
      await flow.service.observeLifecycle(edit.update);
      await flow.ingest(flow.prepare({ text: 'offer', time: first.time + 200 }));
      expect(flow.deleted).toEqual([]);
    });

    it('fails open on conflicting edits with the same event timestamp', async () => {
      flow = await createFlow();
      const first = flow.prepare({ text: 'offer' });
      await flow.ingest(first);
      await flow.ingest(
        flow.prepare({ id: first.id, text: 'different', time: first.time, editedFrom: first.time }),
      );
      await flow.ingest(flow.prepare({ text: 'offer', time: first.time + 200 }));
      expect(flow.deleted).toEqual([]);
    });

    it('fences pre-release originals and delayed media after a manual reset', async () => {
      flow = await createFlow();
      const first = flow.prepare({ text: 'offer' });
      await flow.ingest(first);
      await flow.redis.resetDuplicateWindow(flow.chatId, '123');
      await flow.ingest(first);
      await flow.ingest(flow.prepare({ text: 'offer', time: Date.now() + 100 }));
      expect(flow.deleted).toEqual([]);
    });

    it('rejects a real history reset during the final transport checkpoint', async () => {
      flow = await createFlow({ duplicateCompareMode: 'TEXT', duplicatePhotoEnabled: false });
      const text = 'Repeated native participant source keeps its durable deletion authority';
      const first = flow.prepare({ text });
      const repeat = flow.prepare({ text });
      const observe = (item: typeof first) =>
        flow.history.observe({
          chatId: flow.chatId,
          userId: '123',
          messageId: item.id,
          eventTimestampMs: item.time,
          controlRevision: flow.policyValue.revision,
          settings: flow.settings,
          content: extractDuplicateMessageContent(item.update.raw),
        });
      expect(await observe(first)).toBeNull();
      const match = await observe(repeat);
      expect(match).not.toBeNull();
      const binding = match!.binding;
      binding.authorization = {
        eventTimestampMs: repeat.time,
        deadlineAtMs: repeat.time + 600_000,
      };
      const request = {
        chatId: flow.chatId,
        messageId: repeat.id,
        subjectUserId: '123',
        botId: 'bot',
        binding,
      };
      await expect(flow.guard.assertMessageStillActionable(request)).resolves.toBe('allowed');
      const beforeFinalAuthority = jest.fn(async () => {
        await flow.redis.resetDuplicateWindow(flow.chatId, '123');
        expect(await flow.history.stillMatches(flow.chatId, binding)).toBe(false);
        expect(await flow.authorization.isAllowed(flow.chatId, binding)).toBe(true);
      });
      await expect(
        flow.guard.assertMessageStillActionable({ ...request, beforeFinalAuthority }),
      ).rejects.toMatchObject({ code: 'message_duplicate_history_changed' });
      expect(beforeFinalAuthority).toHaveBeenCalledTimes(1);
      expect(flow.deleted).toEqual([]);
      expect(flow.sanctions).toEqual([]);
    });

    it.each(['MESSAGE', 'TEXT'] as const)(
      'deletes a repeated caption without waiting for image recognition under retained %s settings',
      async (duplicateCompareMode) => {
        flow = await createFlow({
          duplicateCompareMode,
          duplicateWarnEnabled: true,
          duplicateMuteEnabled: true,
        });
        const original = flow.prepare({ photo: 'png', text: 'Selling the same aquarium today' });
        await flow.ingest(original);
        flow.downloads.mockRejectedValue(new Error('Image recognition unavailable'));
        const repeat = flow.prepare({
          photo: 'different',
          text: 'Selling the same aquarium today',
        });
        expect(await flow.ingest(repeat)).toBeUndefined();
        expect(flow.deleted).toEqual([repeat.id]);
        expect(flow.sanctions).toEqual([{ messageId: repeat.id, action: 'WARN' }]);
        expect(flow.downloads).not.toHaveBeenCalled();
        await flow.ingest(repeat);
        expect(flow.deleted).toEqual([repeat.id]);
        expect(flow.sanctions.map((entry) => entry.action)).toEqual(['WARN', 'WARN']);
        const next = flow.prepare({ photo: 'different', text: 'Selling the same aquarium today' });
        await flow.ingest(next);
        expect(flow.sanctions.at(-1)?.action).toBe('MUTE');
      },
    );

    it.each(['MESSAGE', 'TEXT'] as const)(
      'still recognizes a repeated image with changed text under retained %s settings',
      async (duplicateCompareMode) => {
        flow = await createFlow({ duplicateCompareMode });
        await flow.processor.process(
          (await flow.ingest(flow.prepare({ photo: 'png', text: 'First offer' })))!,
        );
        const repeat = flow.prepare({ photo: 'webp', text: 'A completely different caption' });
        await flow.processor.process((await flow.ingest(repeat))!);
        expect(flow.deleted).toEqual([repeat.id]);
        expect(flow.downloads).toHaveBeenCalledTimes(2);
      },
    );

    it.each(['MESSAGE', 'TEXT'] as const)(
      'resumes deferred caption qualification with photos under retained %s settings',
      async (duplicateCompareMode) => {
        flow = await createFlow({ duplicateCompareMode });
        await flow.processor.process(
          (await flow.ingest(flow.prepare({ photo: 'png', text: 'Repeated offer with a photo' })))!,
        );
        const repeat = flow.prepare({ photo: 'different', text: 'Repeated offer with a photo' });
        flow.max.getExactMessageRow.mockRejectedValueOnce(
          Object.assign(new Error('Exact source temporarily unavailable'), {
            response: { status: 404, data: {} },
          }),
        );
        const job = (await flow.ingest(repeat))!;
        expect(job.data.comparison).toBe('TEXT');
        expect(flow.deleted).toEqual([]);
        expect(flow.downloads).not.toHaveBeenCalled();
        await flow.processor.process(job);
        expect(flow.deleted).toEqual([repeat.id]);
        expect(flow.downloads).not.toHaveBeenCalled();
      },
    );

    it.each(['callback', 'link'] as const)(
      'preserves different captionless photos with the same %s keyboard and deletes a real image repeat',
      async (type) => {
        flow = await createFlow();
        const buttons = [
          [
            {
              type,
              text: 'Open',
              ...(type === 'link' ? { url: 'https://example.com' } : { payload: 'open' }),
            },
          ],
        ];
        const original = flow.prepare({ photo: 'png', buttons });
        const different = flow.prepare({ photo: 'different', buttons });
        for (const item of [original, different])
          await flow.processor.process((await flow.ingest(item))!);
        expect(flow.deleted).toEqual([]);
        expect(flow.sanctions).toEqual([]);
        const repeat = flow.prepare({ photo: 'different', buttons });
        await flow.processor.process((await flow.ingest(repeat))!);
        expect(flow.deleted).toEqual([repeat.id]);
      },
    );

    it('counts one violation when both caption and image repeat, including replay', async () => {
      flow = await createFlow({ duplicateWarnEnabled: true, duplicateMuteEnabled: true });
      await flow.processor.process(
        (await flow.ingest(flow.prepare({ photo: 'png', text: 'Same offer' })))!,
      );
      const repeat = flow.prepare({ photo: 'webp', text: 'Same offer' });
      expect(await flow.ingest(repeat)).toBeUndefined();
      await flow.ingest(repeat);
      expect(flow.deleted).toEqual([repeat.id]);
      expect(flow.sanctions.map((entry) => entry.action)).toEqual(['WARN', 'WARN']);
      const next = flow.prepare({ photo: 'webp', text: 'Same offer' });
      await flow.ingest(next);
      expect(flow.sanctions.at(-1)).toEqual({ messageId: next.id, action: 'MUTE' });
      expect(flow.downloads).not.toHaveBeenCalled();
    });

    it('deletes the second photo-only message, even with a new ID and lossless encoding', async () => {
      flow = await createFlow();
      const first = flow.prepare({ photo: 'png' });
      await flow.processor.process((await flow.ingest(first))!);
      expect(flow.downloads).not.toHaveBeenCalled();
      const second = flow.prepare({ photo: 'webp' });
      const job = (await flow.ingest(second))!;
      await flow.processor.process(job);
      expect(flow.deleted).toEqual([second.id]);
      expect(flow.downloads).toHaveBeenCalledTimes(2);
      await flow.ingest(second);
      await flow.processor.process(job);
      expect(flow.deleted).toEqual([second.id]);
      expect(flow.downloads).toHaveBeenCalledTimes(2);
    });

    const prepareExactCandidatePriority = async (nearCount: 0 | 1 | 4 = 4) => {
      flow = await createFlow({ duplicatePhotoScope: 'CHAT' });
      const candidates = new MessageDuplicateRecompressionIndex(flow.redis);
      const scope = digestDuplicateContent([
        flow.chatId,
        null,
        1,
        exactImageSettingsDigest(flow.settings),
        undefined,
      ]);
      const levels = [0, 32, 64, 96] as const;
      const originals = [];
      for (const level of [...levels.slice(0, nearCount), 128] as const) {
        const item = flow.prepare({
          photo: 'png',
          imageBytes: preparedSyntheticImages().grayscale[level],
        });
        await flow.service.observeLifecycle(item.update);
        const content = extractDuplicateMessageContent(item.update.raw);
        const fingerprint = await flow.photos.fingerprintAlbum(
          {
            receiptId: item.receipt,
            chatId: flow.chatId,
            senderId: item.update.message!.senderId,
            messageId: item.id,
            createdAtMs: item.time,
            caption: content.text,
            images: content.media.map((image) => ({
              source: 'direct' as const,
              photoId: image.photoId,
              downloadUrl: image.url,
            })),
          },
          3600,
          Date.now() + 30_000,
          true,
        );
        if (fingerprint.kind !== 'complete') throw new Error('Exact priority fixture incomplete');
        const image = fingerprint.fingerprint.images[0]!;
        const observation = {
          chatId: flow.chatId,
          userId: item.update.message!.senderId,
          messageId: item.id,
          eventTimestampMs: item.time,
          publishedAtMs: item.time,
          controlRevision: 1,
          settings: flow.settings,
          content,
          mediaHashes: [image.canonicalHash],
          imageScope: 'CHAT' as const,
        };
        await flow.history.observeWithOutcome(observation);
        const original = await flow.history.findImageOriginal(observation);
        expect(original?.messageId).toBe(item.id);
        expect(image.recompressionHash).toBe('0000000000000000');
        const candidate: MessageDuplicateRecompressionCandidate = {
          webhookEventId: item.receipt,
          messageId: item.id,
          eventTimestampMs: item.time,
          publishedAtMs: item.time,
          canonicalHash: image.canonicalHash,
          recompressionHash: image.recompressionHash!,
          expiresAtMs: item.time + 3_600_000,
        };
        await candidates.remember(digestDuplicateContent([scope, content.actions]), candidate);
        for (const key of flow.history.candidateKeys(content, flow.settings, true))
          await flow.redis.setStringWithTtl(
            `message-duplicate:candidate:v1:${scope}:${key}`,
            JSON.stringify({
              webhookEventId: item.receipt,
              messageId: item.id,
              eventTimestampMs: item.time,
            }),
            3600,
          );
        originals.push({ item, candidate, original: original! });
      }
      const exact = originals.at(-1)!;
      const repeat = flow.prepare({
        photo: 'png',
        userId: 456,
        imageBytes: preparedSyntheticImages().grayscale[128],
      });
      const job = (await flow.ingest(repeat))!;
      const content = extractDuplicateMessageContent(repeat.update.raw);
      const input: Parameters<MessageDuplicateMediaService['findRecompression']>[0] = {
        scope,
        job: job.data,
        source: { update: repeat.update, botId: 'bot', eventTimestampMs: repeat.time },
        settings: flow.settings,
        verified: { content, hashes: [exact.candidate.canonicalHash] },
        hash: exact.candidate.recompressionHash,
        deadlineAtMs: Date.now() + 30_000,
        budget: { remaining: 20 },
        lease: { assertOwned: jest.fn(), resolveActionEligibility: async () => true },
        heavyWorkAdmitted: true,
        refreshedPhotoSources: new Map(),
      };
      const nativePair = jest.spyOn(flow.photos, 'verifyRecompression');
      return {
        exact,
        repeat,
        job,
        input,
        nativePair,
        lookup: () => flow.media['findRecompression'](input),
      };
    };

    it('prefers exact canonical history beyond four colliding near candidates without native pairs', async () => {
      const { exact, repeat, job, nativePair } = await prepareExactCandidatePriority();
      await flow.processor.process(job);
      expect(flow.deleted).toEqual([repeat.id]);
      const binding = parseMessageDuplicateBinding(
        flow.records.get(`intent:${repeat.id}`)!.input.event!.metadata,
      )!;
      expect(binding.original).toEqual(exact.original);
      expect(binding.mediaHashes).toEqual(binding.original!.mediaHashes);
      expect(binding.imageRecompression).toBeUndefined();
      expect(await flow.history.qualified(flow.chatId, binding)).toBe(1);
      expect(nativePair).not.toHaveBeenCalled();
    });

    it('does not require or consume the native pair budget for exact canonical history', async () => {
      const { exact, input, lookup, nativePair } = await prepareExactCandidatePriority(1);
      input.budget.remaining = 0;
      const result = await lookup();
      expect(result.anchor).toEqual(exact.candidate);
      expect(result.proof).toBeUndefined();
      expect(input.budget.remaining).toBe(0);
      expect(input.lease.assertOwned).toHaveBeenCalled();
      expect(nativePair).not.toHaveBeenCalled();
    });

    it('respects the existing deadline even for exact canonical history', async () => {
      const { input, lookup, nativePair } = await prepareExactCandidatePriority(0);
      input.deadlineAtMs = Date.now() - 1;
      await expect(lookup()).rejects.toMatchObject({ reason: 'proof_budget' });
      expect(input.budget.remaining).toBe(20);
      expect(nativePair).not.toHaveBeenCalled();
    });

    it.each(['removed', 'reset', 'source_chat'] as const)(
      'keeps exact canonical candidates fenced after their original is %s',
      async (change) => {
        const { exact, lookup, nativePair } = await prepareExactCandidatePriority(0);
        if (change === 'removed') await flow.history.remove(flow.chatId, exact.item.id);
        else if (change === 'reset')
          await flow.redis.resetDuplicateWindow(flow.chatId, exact.item.update.message!.senderId);
        else exact.item.update.message!.chatId = '-999999';
        expect((await lookup()).anchor).toBeUndefined();
        expect(nativePair).not.toHaveBeenCalled();
        expect(flow.deleted).toEqual([]);
      },
    );

    it('deletes a cross-author recompressed copy after unrelated photos, retaining both exact identities', async () => {
      flow = await createFlow({ duplicatePhotoScope: 'CHAT' });
      const original = flow.prepare({
        photo: 'webp',
        imageBytes: recompressionPosterImages().quality92,
      });
      const filler = flow.prepare({ photo: 'different' });
      const repeat = flow.prepare({
        photo: 'webp',
        userId: 456,
        imageBytes: recompressionPosterImages().quality89,
      });
      for (const item of [original, filler, repeat])
        await flow.processor.process((await flow.ingest(item))!);
      expect(flow.deleted).toEqual([repeat.id]);
      const record = flow.records.get(`intent:${repeat.id}`)!;
      const binding = parseMessageDuplicateBinding(record.input.event!.metadata)!;
      expect(binding.original?.messageId).toBe(original.id);
      expect(binding.imageRecompression).toEqual({
        version: 'native-recompression-v2',
        originalHash: binding.original!.mediaHashes[0],
        currentHash: binding.mediaHashes[0],
      });
      expect(binding.mediaHashes[0]).not.toBe(binding.original!.mediaHashes[0]);
      const downloads = flow.downloads.mock.calls.length;
      await flow.processor.process((await flow.ingest(repeat))!);
      expect(flow.deleted).toEqual([repeat.id]);
      expect(flow.downloads).toHaveBeenCalledTimes(downloads);
    });

    it.each([
      ['webp', 403],
      ['webp', 404],
      ['webp', 410],
      ['webp', 'missing'],
      ['jpeg', 403],
    ] as const)(
      'renews a cached original %s source after %s and verifies the recompressed copy once',
      async (format, failure) => {
        const { original, repeat, originalUrl, freshUrl, anchor } =
          await prepareStaleRecompressionOriginal(format, failure);
        const job = (await flow.ingest(repeat))!;
        await flow.processor.process(job);
        expect(flow.deleted).toEqual([repeat.id]);
        const binding = parseMessageDuplicateBinding(
          flow.records.get(`intent:${repeat.id}`)!.input.event!.metadata,
        )!;
        expect(binding.original).toEqual(
          expect.objectContaining({
            messageId: original.id,
            publishedAtMs: anchor.publishedAtMs,
            expiresAtMs: anchor.expiresAtMs,
            mediaHashes: [anchor.canonicalHash],
          }),
        );
        expect(binding.imageRecompression).toEqual({
          version: 'native-recompression-v2',
          originalHash: anchor.canonicalHash,
          currentHash: binding.mediaHashes[0],
        });
        expect(binding.mediaHashes[0]).not.toBe(anchor.canonicalHash);
        expect(flow.downloads.mock.calls.filter(([url]) => url === originalUrl)).toHaveLength(
          failure === 'missing' ? 0 : 1,
        );
        expect(flow.downloads.mock.calls.filter(([url]) => url === freshUrl)).toHaveLength(1);
        const refreshes = flow.max.getExactMessageRow.mock.calls.filter(
          ([, , options]) =>
            typeof options === 'object' && options.sourceTag === 'message_duplicate_media',
        );
        expect(refreshes.filter(([, messageId]) => messageId === original.id)).toHaveLength(1);
        expect(
          refreshes.filter(([, messageId]) => messageId === repeat.id).length,
        ).toBeLessThanOrEqual(1);
        expect(
          refreshes.every(
            ([chatId, , options]) =>
              chatId === flow.chatId &&
              typeof options === 'object' &&
              options.botId === 'bot' &&
              options.bypassCache === true &&
              options.trafficClass === 'background',
          ),
        ).toBe(true);
        const downloads = flow.downloads.mock.calls.length;
        const lookups = flow.max.getExactMessageRow.mock.calls.length;
        await flow.processor.process(job);
        expect(flow.deleted).toEqual([repeat.id]);
        expect(flow.downloads).toHaveBeenCalledTimes(downloads);
        expect(flow.max.getExactMessageRow).toHaveBeenCalledTimes(lookups);
      },
    );

    it('reuses the current fingerprint source renewal when recovering an expired original pair', async () => {
      const { original, repeat, freshUrl, anchor } = await prepareStaleRecompressionOriginal(
        'webp',
        403,
        true,
      );
      const currentUrl = extractDuplicateMessageContent(flow.remote.get(repeat.id)!, false)
        .media[0]!.url!;
      const job = (await flow.ingest(repeat))!;
      await flow.processor.process(job);
      expect(flow.deleted).toEqual([repeat.id]);
      const binding = parseMessageDuplicateBinding(
        flow.records.get(`intent:${repeat.id}`)!.input.event!.metadata,
      )!;
      expect(binding.original).toEqual(
        expect.objectContaining({
          messageId: original.id,
          publishedAtMs: anchor.publishedAtMs,
          expiresAtMs: anchor.expiresAtMs,
          mediaHashes: [anchor.canonicalHash],
        }),
      );
      expect(binding.imageRecompression).toEqual({
        version: 'native-recompression-v2',
        originalHash: anchor.canonicalHash,
        currentHash: binding.mediaHashes[0],
      });
      expect(binding.mediaHashes[0]).not.toBe(anchor.canonicalHash);
      const refreshes = flow.max.getExactMessageRow.mock.calls.filter(
        ([, , options]) =>
          typeof options === 'object' && options.sourceTag === 'message_duplicate_media',
      );
      expect(refreshes.map(([, messageId]) => messageId)).toEqual([repeat.id, original.id]);
      expect(flow.downloads.mock.calls.filter(([url]) => url === freshUrl)).toHaveLength(1);
      expect(flow.downloads.mock.calls.filter(([url]) => url === currentUrl)).toHaveLength(2);
      const downloads = flow.downloads.mock.calls.length;
      const lookups = flow.max.getExactMessageRow.mock.calls.length;
      await flow.processor.process(job);
      expect(flow.deleted).toEqual([repeat.id]);
      expect(flow.downloads).toHaveBeenCalledTimes(downloads);
      expect(flow.max.getExactMessageRow).toHaveBeenCalledTimes(lookups);
    });

    it.each(['pixels', 'sender', 'photoId'] as const)(
      'preserves a recompressed copy when the renewed cached original changes its %s',
      async (change) => {
        const { original, repeat, freshUrl, renewed, body, repeatedBytes } =
          await prepareStaleRecompressionOriginal('webp', 403);
        if (change === 'pixels') flow.images.set(freshUrl, repeatedBytes);
        if (change === 'sender') renewed.sender = { user_id: 789, name: 'Changed author' };
        if (change === 'photoId') body.attachments[0]!.payload.photo_id += ':changed';
        const job = (await flow.ingest(repeat))!;
        await flow.processor.process(job);
        expect(flow.deleted).toEqual([]);
        expect(flow.sanctions).toEqual([]);
        expect(flow.intents.ensureIntentWithMessageActionClaim).not.toHaveBeenCalled();
        expect(
          flow.max.getExactMessageRow.mock.calls.filter(
            ([, messageId, options]) =>
              messageId === original.id &&
              typeof options === 'object' &&
              options.sourceTag === 'message_duplicate_media',
          ),
        ).toHaveLength(1);
        expect(flow.downloads.mock.calls.filter(([url]) => url === freshUrl)).toHaveLength(
          change === 'pixels' ? 1 : 0,
        );
      },
    );

    it('stops after one source renewal when the cached original locator is still expired', async () => {
      const { original, repeat, originalUrl, freshUrl } = await prepareStaleRecompressionOriginal(
        'webp',
        403,
      );
      flow.downloadFailures.set(freshUrl, new PhotoDownloadHttpError(410));
      await flow.processor.process((await flow.ingest(repeat))!);
      expect(flow.deleted).toEqual([]);
      expect(flow.sanctions).toEqual([]);
      expect(flow.intents.ensureIntentWithMessageActionClaim).not.toHaveBeenCalled();
      expect(flow.downloads.mock.calls.filter(([url]) => url === originalUrl)).toHaveLength(1);
      expect(flow.downloads.mock.calls.filter(([url]) => url === freshUrl)).toHaveLength(1);
      const refreshes = flow.max.getExactMessageRow.mock.calls.filter(
        ([, , options]) =>
          typeof options === 'object' && options.sourceTag === 'message_duplicate_media',
      );
      expect(refreshes.filter(([, messageId]) => messageId === original.id)).toHaveLength(1);
      expect(
        refreshes.filter(([, messageId]) => messageId === repeat.id).length,
      ).toBeLessThanOrEqual(1);
    });

    it.each(['callback', 'link'] as const)(
      'keeps changed %s buttons separate for recompressed photos while ignoring captions',
      async (type) => {
        flow = await createFlow({ duplicatePhotoScope: 'CHAT' });
        const originalBytes = recompressionPosterImages().quality92;
        const repeatedBytes = recompressionPosterImages().quality89;
        const buttons = (value: string) => [
          [
            {
              type,
              text: 'Open',
              ...(type === 'callback' ? { payload: value } : { url: value }),
            },
          ],
        ];
        const original = flow.prepare({
          photo: 'webp',
          imageBytes: originalBytes,
          buttons: buttons('https://example.com/a'),
          text: 'Original caption',
        });
        const changed = flow.prepare({
          photo: 'webp',
          imageBytes: originalBytes,
          userId: 456,
          buttons: buttons('https://example.com/b'),
          text: 'Changed caption',
        });
        const repeat = flow.prepare({
          photo: 'webp',
          imageBytes: repeatedBytes,
          userId: 789,
          buttons: buttons('https://example.com/b'),
          text: 'Another caption with https://example.org',
        });
        for (const item of [original, changed])
          await flow.processor.process((await flow.ingest(item))!);
        expect(flow.deleted).toEqual([]);
        expect(flow.sanctions).toEqual([]);
        await flow.processor.process((await flow.ingest(repeat))!);
        expect(flow.deleted).toEqual([repeat.id]);
        const binding = parseMessageDuplicateBinding(
          flow.records.get(`intent:${repeat.id}`)!.input.event!.metadata,
        )!;
        expect(binding.original?.messageId).toBe(changed.id);
        expect(binding.imageRecompression).toBeDefined();
      },
    );

    it.each(['remove', 'reset'] as const)(
      'uses a fresh exact original for recompressed copies after the previous source is fenced by %s',
      async (change) => {
        flow = await createFlow({ duplicatePhotoScope: 'CHAT' });
        const originalBytes = recompressionPosterImages().quality92;
        const repeatedBytes = recompressionPosterImages().quality89;
        const original = flow.prepare({ photo: 'webp', imageBytes: originalBytes });
        const filler = flow.prepare({ photo: 'different' });
        for (const item of [original, filler])
          await flow.processor.process((await flow.ingest(item))!);
        if (change === 'remove') {
          await flow.history.remove(flow.chatId, original.id);
          flow.remote.delete(original.id);
        } else await flow.redis.resetDuplicateWindow(flow.chatId, '123');
        const freshTime = Date.now() + 100;
        const freshOriginal = flow.prepare({
          photo: 'webp',
          imageBytes: originalBytes,
          time: freshTime,
        });
        await flow.processor.process((await flow.ingest(freshOriginal))!);
        expect(flow.deleted).toEqual([]);
        const repeat = flow.prepare({
          photo: 'webp',
          imageBytes: repeatedBytes,
          userId: 789,
          time: freshTime + 100,
        });
        await flow.processor.process((await flow.ingest(repeat))!);
        expect(flow.deleted).toEqual([repeat.id]);
        const binding = parseMessageDuplicateBinding(
          flow.records.get(`intent:${repeat.id}`)!.input.event!.metadata,
        )!;
        expect(binding.original?.messageId).toBe(freshOriginal.id);
        expect(binding.imageRecompression).toBeDefined();
      },
    );

    it.each([
      ['phone', '8-902-009-99-48', 'Price 1000'],
      ['price', '8-902-009-99-49', 'Price 1009'],
    ])(
      'preserves a changed %s while deleting its actual recompressed repeat',
      async (_field, phone, price) => {
        flow = await createFlow({ duplicatePhotoScope: 'CHAT' });
        const original = flow.prepare({
          photo: 'webp',
          imageBytes: recompressionPosterImages().quality92,
        });
        const changed = flow.prepare({
          photo: 'webp',
          userId: 456,
          imageBytes: recompressionPosterImages(phone, price).quality89,
        });
        const repeat = flow.prepare({
          photo: 'webp',
          userId: 789,
          imageBytes: recompressionPosterImages(phone, price).quality92,
        });
        for (const item of [original, changed, repeat])
          await flow.processor.process((await flow.ingest(item))!);
        expect(flow.deleted).toEqual([repeat.id]);
        const binding = parseMessageDuplicateBinding(
          flow.records.get(`intent:${repeat.id}`)!.input.event!.metadata,
        )!;
        expect(binding.original?.messageId).toBe(changed.id);
      },
    );

    it('always verifies recompressed copies against the original instead of chaining small changes', async () => {
      flow = await createFlow({ duplicatePhotoScope: 'CHAT' });
      const { grayscale } = preparedSyntheticImages();
      const original = flow.prepare({ photo: 'png', imageBytes: grayscale[128] });
      const firstCopy = flow.prepare({ photo: 'png', userId: 456, imageBytes: grayscale[129] });
      const drifted = flow.prepare({ photo: 'png', userId: 789, imageBytes: grayscale[130] });
      for (const item of [original, firstCopy, drifted])
        await flow.processor.process((await flow.ingest(item))!);
      expect(flow.deleted).toEqual([firstCopy.id]);
      const actualRepeat = flow.prepare({
        photo: 'png',
        userId: 456,
        imageBytes: grayscale[130],
      });
      await flow.processor.process((await flow.ingest(actualRepeat))!);
      expect(flow.deleted).toEqual([firstCopy.id, actualRepeat.id]);
      const binding = parseMessageDuplicateBinding(
        flow.records.get(`intent:${actualRepeat.id}`)!.input.event!.metadata,
      )!;
      expect(binding.original?.messageId).toBe(drifted.id);
    });

    it('deletes the second identical short text without a media job', async () => {
      flow = await createFlow();
      const first = flow.prepare({ text: 'Hello!' });
      const second = flow.prepare({ text: '  HELLO!  ' });
      expect(await flow.ingest(first)).toBeUndefined();
      expect(await flow.ingest(second)).toBeUndefined();
      expect(flow.deleted).toEqual([second.id]);
    });

    it.each(['STANDARD', 'STRICT', 'CUSTOM'] as const)(
      'keeps changed hidden-link associations and deletes their actual repeat in %s',
      async (preset) => {
        flow = await createFlow({
          duplicateDetectionPreset: preset,
          duplicateNearMatchEnabled: true,
          duplicateIgnoreLinksEnabled: false,
          duplicateIgnorePhonesEnabled: false,
        });
        const linked = (
          swapped: boolean,
          text = 'Participants can purchase comfortable iPhone equipment or practical Samsung devices today',
        ) =>
          flow.prepare({
            text,
            markup: ['iPhone', 'Samsung'].map((anchor, index) => ({
              type: 'link',
              from: text.indexOf(anchor),
              length: anchor.length,
              url: `https://example.com/${swapped ? 1 - index : index}`,
            })),
          });
        await flow.ingest(linked(false));
        await flow.ingest(linked(true));
        expect(flow.deleted).toEqual([]);
        expect(flow.sanctions).toEqual([]);
        const repeat = linked(
          true,
          '  PARTICIPANTS can purchase comfortable iPhone equipment\nor practical Samsung devices today ',
        );
        await flow.ingest(repeat);
        expect(flow.deleted).toEqual([repeat.id]);
      },
    );

    it('keeps swapped case-sensitive visible URLs and deletes their actual repeat in STANDARD', async () => {
      flow = await createFlow({ duplicateDetectionPreset: 'STANDARD' });
      await flow.ingest(flow.prepare({ text: 'https://example.com/One https://example.com/one' }));
      await flow.ingest(flow.prepare({ text: 'https://example.com/one https://example.com/One' }));
      expect(flow.deleted).toEqual([]);
      expect(flow.sanctions).toEqual([]);
      const repeat = flow.prepare({ text: '  https://example.com/one\nhttps://example.com/One  ' });
      await flow.ingest(repeat);
      expect(flow.deleted).toEqual([repeat.id]);
    });

    it.each(['current', 'original'] as const)(
      'rejects a hidden-link swap in the fresh %s message without an edit webhook',
      async (changed) => {
        flow = await createFlow();
        const text = 'Buy iPhone Buy Samsung';
        const markup = ['iPhone', 'Samsung'].map((anchor, index) => ({
          type: 'link',
          from: text.indexOf(anchor),
          length: anchor.length,
          url: `https://example.com/${index}`,
        }));
        const original = flow.prepare({ text, markup });
        await flow.ingest(original);
        const current = flow.prepare({ text, markup });
        const message = flow.remote.get(changed === 'current' ? current.id : original.id)!;
        flow.remote.set(changed === 'current' ? current.id : original.id, {
          ...message,
          body: {
            ...(message.body as Record<string, unknown>),
            markup: markup.map((item, index) => ({
              ...item,
              url: `https://example.com/${1 - index}`,
            })),
          },
        });
        await flow.ingest(current);
        expect(flow.deleted).toEqual([]);
        expect(flow.sanctions).toEqual([]);
        expect(flow.intents.ensureIntentWithMessageActionClaim).not.toHaveBeenCalled();
      },
    );

    it.each(['callback', 'link'] as const)(
      'keeps identical photos with different %s buttons and deletes an actual repeat',
      async (type) => {
        flow = await createFlow();
        const prepare = (value: string) =>
          flow.prepare({
            photo: 'png',
            buttons: [
              [
                {
                  type,
                  text: 'Open',
                  ...(type === 'callback' ? { payload: value } : { url: value }),
                },
              ],
            ],
          });
        await flow.processor.process((await flow.ingest(prepare('https://example.com/a')))!);
        await flow.processor.process((await flow.ingest(prepare('https://example.com/b')))!);
        expect(flow.deleted).toEqual([]);
        expect(flow.sanctions).toEqual([]);
        const repeat = prepare('https://example.com/b');
        await flow.processor.process((await flow.ingest(repeat))!);
        expect(flow.deleted).toEqual([repeat.id]);
      },
    );

    it('keeps distinct images with a reused platform ID and independently verifies a later repeat', async () => {
      flow = await createFlow();
      const first = flow.prepare({ photo: 'png', photoId: 'shared-id' });
      await flow.processor.process((await flow.ingest(first))!);
      const different = flow.prepare({ photo: 'different', photoId: 'shared-id' });
      await flow.processor.process((await flow.ingest(different))!);
      expect(flow.downloads).toHaveBeenCalledTimes(2);
      expect(flow.deleted).toEqual([]);
      expect(flow.sanctions).toEqual([]);
      const repeat = flow.prepare({ photo: 'different', photoId: 'shared-id' });
      await flow.processor.process((await flow.ingest(repeat))!);
      expect(flow.deleted).toEqual([repeat.id]);
      expect(flow.downloads).toHaveBeenCalledTimes(3);
    });

    it.each(['before-add', 'lost-response', 'lost-registration-response'] as const)(
      'preserves photo enforcement after a transient %s failure',
      async (failure) => {
        flow = await createFlow();
        await flow.processor.process((await flow.ingest(flow.prepare({ photo: 'png' })))!);
        const repeat = flow.prepare({ photo: 'webp' });
        if (failure === 'lost-registration-response') {
          const announce = flow.ordering.announce.bind(flow.ordering);
          jest.spyOn(flow.ordering, 'announce').mockImplementationOnce(async (...args) => {
            await announce(...args);
            return { kind: 'unavailable' };
          });
        } else {
          const add = flow.queue.add.bind(flow.queue);
          jest.spyOn(flow.queue, 'add').mockImplementationOnce(async (...args) => {
            if (failure === 'lost-response') await add(...args);
            throw new Error('temporary queue add failure');
          });
        }
        await expect(flow.ingest(repeat)).rejects.toThrow();
        const job = (await flow.ingest(repeat))!;
        await flow.processor.process(job);
        expect(flow.deleted).toEqual([repeat.id]);
        expect(flow.downloads).toHaveBeenCalledTimes(2);
        await flow.processor.process(job);
        expect(flow.deleted).toEqual([repeat.id]);
      },
    );

    it('keeps a concurrent restrictive replay after a lost queue acknowledgement', async () => {
      flow = await createFlow();
      await flow.processor.process((await flow.ingest(flow.prepare({ photo: 'png' })))!);
      const repeat = flow.prepare({ photo: 'webp' });
      const add = flow.queue.add.bind(flow.queue);
      jest.spyOn(flow.queue, 'add').mockImplementationOnce(async (...args) => {
        const job = await add(...args);
        await flow.ordering.announce(
          {
            chatId: job.data.chatId,
            jobId: job.data.idempotencyKey,
            sourceCreatedAt: job.data.sourceCreatedAt,
          },
          false,
        );
        throw new Error('lost queue acknowledgement');
      });
      await expect(flow.ingest(repeat)).rejects.toThrow('lost queue acknowledgement');
      await flow.processor.process((await flow.ingest(repeat))!);
      expect(flow.deleted).toEqual([]);
      expect(flow.sanctions).toEqual([]);
      expect(flow.intents.ensureIntentWithMessageActionClaim).not.toHaveBeenCalled();
    });

    it('retains both originals when repeated pictures are interleaved', async () => {
      flow = await createFlow();
      const items = [
        flow.prepare({ photo: 'png' }),
        flow.prepare({ photo: 'different' }),
        flow.prepare({ photo: 'webp' }),
        flow.prepare({ photo: 'different' }),
      ];
      for (const item of items) await flow.processor.process((await flow.ingest(item))!);
      expect(flow.deleted).toEqual([items[2]!.id, items[3]!.id]);
      expect(flow.downloads).toHaveBeenCalledTimes(4);
    });

    it('matches exact pictures independently of different captions and links', async () => {
      flow = await createFlow({
        duplicateDetectionPreset: 'CUSTOM',
        duplicateIgnoreLinksEnabled: true,
      });
      const first = flow.prepare({ photo: 'different', text: 'https://first.example/item' });
      const second = flow.prepare({ photo: 'png', text: 'https://second.example/item' });
      const repeat = flow.prepare({
        photo: 'webp',
        text: 'https://third.example/item',
      });
      await flow.processor.process((await flow.ingest(first))!);
      await flow.processor.process((await flow.ingest(second))!);
      expect(flow.downloads).toHaveBeenCalledTimes(2);
      const job = (await flow.ingest(repeat))!;
      await flow.processor.process(job);
      expect(flow.deleted).toEqual([repeat.id]);
      expect(flow.downloads).toHaveBeenCalledTimes(3);
      await flow.processor.process(job);
      expect(flow.deleted).toEqual([repeat.id]);
      expect(flow.downloads).toHaveBeenCalledTimes(3);
    });

    it('preserves different pictures, other authors and the original while ignoring captions', async () => {
      flow = await createFlow();
      for (const item of [
        flow.prepare({ photo: 'png' }),
        flow.prepare({ photo: 'different' }),
        flow.prepare({ photo: 'png', text: 'Different caption' }),
        flow.prepare({ photo: 'png', userId: 456 }),
      ])
        await flow.processor.process((await flow.ingest(item))!);
      expect(flow.deleted).toEqual(['message-3']);
    });

    it('keeps WARN/MUTE escalation after changing only the original photo caption', async () => {
      flow = await createFlow({
        duplicateWarnEnabled: true,
        duplicateMuteEnabled: true,
        duplicateWarnMaxCount: 1,
        duplicateMuteMaxCount: 2,
      });
      const original = flow.prepare({ photo: 'png', text: 'Original caption' });
      await flow.processor.process((await flow.ingest(original))!);
      const first = flow.prepare({ photo: 'png' });
      await flow.processor.process((await flow.ingest(first))!);
      expect(flow.sanctions.map((entry) => entry.action)).toEqual(['WARN']);
      const edited = flow.prepare({
        id: original.id,
        photo: 'png',
        text: 'Changed caption with https://example.org/new',
        time: first.time + 100,
        editedFrom: original.time,
      });
      await flow.processor.process((await flow.ingest(edited))!);
      const next = flow.prepare({ photo: 'png', time: edited.time + 100 });
      await flow.processor.process((await flow.ingest(next))!);
      expect(flow.deleted).toEqual([first.id, next.id]);
      expect(flow.sanctions.map((entry) => entry.action)).toEqual(['WARN', 'MUTE']);
    });

    it('keeps the spent photo allowance after changing only the original caption', async () => {
      flow = await createFlow({ duplicateWarnEnabled: true, duplicateWarnMaxCount: 2 });
      const original = flow.prepare({ photo: 'png', text: 'Original caption' });
      await flow.processor.process((await flow.ingest(original))!);
      const allowed = flow.prepare({ photo: 'png' });
      await flow.processor.process((await flow.ingest(allowed))!);
      expect(flow.deleted).toEqual([]);
      const edited = flow.prepare({
        id: original.id,
        photo: 'png',
        text: 'Changed caption',
        time: allowed.time + 100,
        editedFrom: original.time,
      });
      await flow.processor.process((await flow.ingest(edited))!);
      const next = flow.prepare({ photo: 'png', time: edited.time + 100 });
      await flow.processor.process((await flow.ingest(next))!);
      expect(flow.deleted).toEqual([next.id]);
      expect(flow.sanctions.map((entry) => entry.action)).toEqual(['WARN']);
    });

    it('blocks a late ordering denial during MAX checks before reserving a stage', async () => {
      flow = await createFlow({
        duplicateWarnEnabled: true,
        duplicateMuteEnabled: true,
        duplicateWarnMaxCount: 1,
        duplicateMuteMaxCount: 2,
      });
      await flow.processor.process((await flow.ingest(flow.prepare({ photo: 'png' })))!);
      const repeat = flow.prepare({ photo: 'png' });
      const job = (await flow.ingest(repeat))!;
      const qualify = jest.spyOn(flow.history, 'qualify');
      flow.max.getExactMessageRow.mockImplementation(async (_chatId, messageId) => {
        if (messageId === repeat.id) {
          await flow.ordering.announce(
            {
              chatId: flow.chatId,
              jobId: job.data.idempotencyKey,
              sourceCreatedAt: job.data.sourceCreatedAt,
              deadlineAtMs: job.data.deadlineAtMs,
            },
            false,
          );
        }
        return flow.remote.get(messageId) ?? null;
      });
      await flow.processor.process(job);
      expect(qualify).not.toHaveBeenCalled();
      expect(flow.deleted).toEqual([]);
      expect(flow.sanctions).toEqual([]);
      expect(flow.intents.releaseUnmaterializedMessageAction).toHaveBeenCalledTimes(1);
      expect(flow.claimedMessages.has(repeat.id)).toBe(false);
      await flow.processor.process(job);
      expect(flow.intents.claimMessageActionBeforeQualification).toHaveBeenCalledTimes(1);
      expect(flow.intents.ensureIntentWithMessageActionClaim).not.toHaveBeenCalled();
      const next = flow.prepare({ photo: 'png' });
      await flow.processor.process((await flow.ingest(next))!);
      expect(flow.deleted).toEqual([next.id]);
      expect(flow.sanctions.map((entry) => entry.action)).toEqual(['WARN']);
    });

    it('releases a removed photo candidate without MAX retries and lets the next duplicate progress', async () => {
      flow = await createFlow({ duplicateWarnEnabled: true, duplicateWarnMaxCount: 1 });
      await flow.processor.process((await flow.ingest(flow.prepare({ photo: 'png' })))!);
      const repeat = flow.prepare({ photo: 'png' });
      const job = (await flow.ingest(repeat))!;
      jest.spyOn(flow.history, 'qualified').mockImplementationOnce(async () => {
        await flow.history.remove(flow.chatId, repeat.id);
        flow.max.getChatMemberAccess.mockClear();
        flow.max.getChatMemberAccess.mockRejectedValue(new Error('MAX unavailable'));
        return null;
      });
      await flow.processor.process(job);
      expect(flow.max.getChatMemberAccess).not.toHaveBeenCalled();
      expect(flow.deleted).toEqual([]);
      expect(flow.sanctions).toEqual([]);
      expect(flow.intents.releaseUnmaterializedMessageAction).toHaveBeenCalledTimes(1);
      expect(flow.claimedMessages.has(repeat.id)).toBe(false);
      expect(flow.intents.ensureIntentWithMessageActionClaim).not.toHaveBeenCalled();
      flow.max.getChatMemberAccess.mockImplementation(async (_chatId, userId) => ({
        userId,
        isAdmin: false,
        isOwner: false,
      }));
      const next = flow.prepare({ photo: 'png' });
      await flow.processor.process((await flow.ingest(next))!);
      expect(flow.deleted).toEqual([next.id]);
      expect(flow.sanctions.map((entry) => entry.action)).toEqual(['WARN']);
    });

    it('blocks a denial after qualification and before persisting the delete intent', async () => {
      flow = await createFlow({ duplicateWarnEnabled: true, duplicateWarnMaxCount: 1 });
      await flow.processor.process((await flow.ingest(flow.prepare({ photo: 'png' })))!);
      const repeat = flow.prepare({ photo: 'png' });
      const job = (await flow.ingest(repeat))!;
      const persist = flow.intents.ensureIntentWithMessageActionClaim.getMockImplementation()!;
      flow.intents.ensureIntentWithMessageActionClaim.mockImplementation(async (input) => {
        await flow.ordering.announce(
          {
            chatId: flow.chatId,
            jobId: job.data.idempotencyKey,
            sourceCreatedAt: job.data.sourceCreatedAt,
            deadlineAtMs: job.data.deadlineAtMs,
          },
          false,
        );
        return persist(input);
      });
      await flow.processor.process(job);
      expect(flow.deleted).toEqual([]);
      expect(flow.sanctions).toEqual([]);
      const binding = parseMessageDuplicateBinding(
        flow.records.get(`intent:${repeat.id}`)!.input.event?.metadata,
      )!;
      expect(await flow.history.qualified(flow.chatId, binding)).toBe(1);
      await expect(
        flow.guard.assertIntentStillActionable({
          intentId: `intent:${repeat.id}`,
          chatId: flow.chatId,
          messageId: repeat.id,
          subjectUserId: '123',
          botId: 'bot',
        }),
      ).rejects.toThrow('message_duplicate_action_revoked');
    });

    it('keeps a persisted intent revoked independently of background recovery', async () => {
      flow = await createFlow({ duplicateWarnEnabled: true, duplicateWarnMaxCount: 1 });
      await flow.processor.process((await flow.ingest(flow.prepare({ photo: 'png' })))!);
      const repeat = flow.prepare({ photo: 'png' });
      const job = (await flow.ingest(repeat))!;
      const persist = flow.intents.ensureIntentWithMessageActionClaim.getMockImplementation()!;
      flow.intents.ensureIntentWithMessageActionClaim.mockImplementationOnce(async (input) => {
        await persist(input);
        throw new Error('Synthetic crash after intent persistence');
      });
      await expect(flow.processor.process(job)).rejects.toThrow('after intent persistence');
      expect(flow.records.has(`intent:${repeat.id}`)).toBe(true);
      await flow.authorization.revoke({
        chatId: flow.chatId,
        messageId: repeat.id,
        senderId: '123',
        eventTimestampMs: repeat.time,
      });
      await flow.ordering.announce(
        {
          chatId: flow.chatId,
          jobId: job.data.idempotencyKey,
          sourceCreatedAt: job.data.sourceCreatedAt,
          deadlineAtMs: job.data.deadlineAtMs,
        },
        true,
      );
      await expect(
        flow.guard.assertIntentStillActionable({
          intentId: `intent:${repeat.id}`,
          chatId: flow.chatId,
          messageId: repeat.id,
          subjectUserId: '123',
          botId: 'bot',
        }),
      ).rejects.toThrow('message_duplicate_action_revoked');
      await flow.processor.process(job);
      expect(flow.deleted).toEqual([]);
      expect(flow.sanctions).toEqual([]);
    });

    it('fails closed when the admitted permit disappears before a worker retry', async () => {
      flow = await createFlow();
      await flow.processor.process((await flow.ingest(flow.prepare({ photo: 'png' })))!);
      const repeat = flow.prepare({ photo: 'png' });
      const job = (await flow.ingest(repeat))!;
      const permit = `message-duplicate:ordering:v2:${shortHash(flow.chatId)}:permit:${createHash('sha256').update(job.data.idempotencyKey).digest('hex')}`;
      expect(await flow.inspector.hget(permit, 'eligible')).toBe('1');
      await flow.inspector.del(permit);
      await flow.processor.process(job);
      expect(flow.deleted).toEqual([]);
      expect(flow.intents.ensureIntentWithMessageActionClaim).not.toHaveBeenCalled();
      expect(flow.sanctions).toEqual([]);
      expect(await flow.inspector.hget(permit, 'eligible')).toBe('0');
    });

    it.each(['retained-job', 'lost-job'] as const)(
      'does not renew a persisted intent through webhook replay after permit loss (%s)',
      async (state) => {
        flow = await createFlow({ duplicateWarnEnabled: true, duplicateWarnMaxCount: 1 });
        await flow.processor.process((await flow.ingest(flow.prepare({ photo: 'png' })))!);
        const repeat = flow.prepare({ photo: 'png' });
        const job = (await flow.ingest(repeat))!;
        const persist = flow.intents.ensureIntentWithMessageActionClaim.getMockImplementation()!;
        flow.intents.ensureIntentWithMessageActionClaim.mockImplementationOnce(async (input) => {
          await persist(input);
          throw new Error('Synthetic crash after intent persistence');
        });
        await expect(flow.processor.process(job)).rejects.toThrow('after intent persistence');
        const params = {
          intentId: `intent:${repeat.id}`,
          chatId: flow.chatId,
          messageId: repeat.id,
          subjectUserId: '123',
          botId: 'bot',
        };
        await expect(flow.guard.assertIntentStillActionable(params)).resolves.toBe('allowed');
        const permit = `message-duplicate:ordering:v2:${shortHash(flow.chatId)}:permit:${createHash('sha256').update(job.data.idempotencyKey).digest('hex')}`;
        await flow.inspector.del(permit);
        if (state === 'lost-job') {
          await job.remove();
          jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 5001);
        }
        await expect(flow.guard.assertIntentStillActionable(params)).rejects.toThrow(
          'message_duplicate_action_revoked',
        );
        const replay = (await flow.ingest(repeat, true))!;
        await expect(flow.guard.assertIntentStillActionable(params)).rejects.toThrow(
          'message_duplicate_action_revoked',
        );
        await flow.processor.process(replay);
        expect(flow.deleted).toEqual([]);
        expect(flow.sanctions).toEqual([]);
        expect(await flow.inspector.hget(permit, 'eligible')).toBe('0');
      },
    );

    it('keeps an untracked moderation replay denied when tracking resumes', async () => {
      flow = await createFlow();
      await flow.processor.process((await flow.ingest(flow.prepare({ photo: 'png' })))!);
      const repeat = flow.prepare({ photo: 'png' });
      const job = (await flow.ingest(repeat))!;
      await flow.service.observe({
        update: repeat.update,
        webhookEventId: repeat.receipt,
        eventTimestampMs: repeat.time,
        settings: flow.settings,
        botId: 'bot',
        actionEligible: false,
        track: false,
      });
      await flow.ingest(repeat, true);
      await flow.processor.process(job);
      expect(flow.deleted).toEqual([]);
      expect(flow.sanctions).toEqual([]);
      expect(flow.intents.ensureIntentWithMessageActionClaim).not.toHaveBeenCalled();
    });

    it('resumes a photo deletion after URL recovery and a transient intent persistence failure', async () => {
      flow = await createFlow({
        duplicateWarnEnabled: true,
        duplicateWarnMaxCount: 1,
        duplicateMuteEnabled: true,
        duplicateMuteMaxCount: 2,
      });
      await flow.processor.process((await flow.ingest(flow.prepare({ photo: 'png' })))!);
      const second = flow.prepare({ photo: 'png', missingUrl: true });
      const job = (await flow.ingest(second))!;
      flow.intents.ensureIntentWithMessageActionClaim.mockRejectedValueOnce(
        new Error('temporary intent failure'),
      );
      await expect(flow.processor.process(job)).rejects.toThrow('temporary intent failure');
      const firstQualification = flow.intents.ensureIntentWithMessageActionClaim.mock.calls[0]![0]
        .intent.event!.metadata as { count: number };
      await flow.processor.process(job);
      const resumedQualification = flow.intents.ensureIntentWithMessageActionClaim.mock.calls[1]![0]
        .intent.event!.metadata as { count: number };
      expect(resumedQualification.count).toBe(firstQualification.count);
      expect(flow.intents.claimMessageActionBeforeQualification).toHaveBeenCalledTimes(2);
      expect(flow.deleted).toEqual([second.id]);
      expect(flow.sanctions).toEqual([{ messageId: second.id, action: 'WARN' }]);
      expect(flow.downloads).toHaveBeenCalledTimes(2);
    });

    it('resumes deletion when its per-message proof cache disappears before retry', async () => {
      flow = await createFlow();
      await flow.processor.process((await flow.ingest(flow.prepare({ photo: 'png' })))!);
      const second = flow.prepare({ photo: 'png' });
      const job = (await flow.ingest(second))!;
      flow.intents.ensureIntentWithMessageActionClaim.mockRejectedValueOnce(
        new Error('temporary intent failure'),
      );
      await expect(flow.processor.process(job)).rejects.toThrow('temporary intent failure');
      const proofKeys = [...flow.keys].filter((key) =>
        key.startsWith('message-duplicate:media-hash:'),
      );
      await flow.inspector.del(...proofKeys);
      await flow.processor.process(job);
      expect(flow.deleted).toEqual([second.id]);
    });

    it('recovers a cached pending delete under image-analysis pressure without decoding again', async () => {
      flow = await createFlow();
      await flow.processor.process((await flow.ingest(flow.prepare({ photo: 'png' })))!);
      const second = flow.prepare({ photo: 'png' });
      const job = (await flow.ingest(second))!;
      flow.intents.ensureIntentWithMessageActionClaim.mockRejectedValueOnce(
        new Error('temporary intent failure'),
      );
      await expect(flow.processor.process(job)).rejects.toThrow('temporary intent failure');
      flow.governor.decide.mockResolvedValue({ action: 'pause' });
      await flow.processor.process(job);
      expect(flow.deleted).toEqual([second.id]);
      expect(flow.downloads).toHaveBeenCalledTimes(2);
    });

    it.each(['corrupt', 'expired'] as const)(
      'recovers the next matching pair after a %s candidate',
      async (kind) => {
        flow = await createFlow();
        const old = flow.prepare({ photo: 'png' });
        await flow.processor.process((await flow.ingest(old))!);
        const key = [...flow.keys].find((key) => key.startsWith('message-duplicate:candidate:'))!;
        await flow.inspector.set(
          key,
          kind === 'corrupt'
            ? 'x'.repeat(2048)
            : JSON.stringify({
                webhookEventId: old.receipt,
                messageId: old.id,
                eventTimestampMs: old.time - 604800000,
              }),
        );
        const first = flow.prepare({ photo: 'png' });
        const second = flow.prepare({ photo: 'webp' });
        await flow.processor.process((await flow.ingest(first))!);
        await flow.processor.process((await flow.ingest(second))!);
        expect(flow.deleted).toEqual([second.id]);
      },
    );

    it('respects an explicitly allowed repeat and applies WARN/MUTE/BAN only to subsequent duplicates', async () => {
      flow = await createFlow({
        duplicateWarnEnabled: true,
        duplicateMuteEnabled: true,
        duplicateBanEnabled: true,
        duplicateWarnMaxCount: 2,
        duplicateMuteMaxCount: 3,
        duplicateBanMaxCount: 4,
      });
      const items = Array.from({ length: 5 }, () => flow.prepare({ photo: 'png' }));
      for (const item of items) {
        const job = (await flow.ingest(item))!;
        await flow.processor.process(job);
        await flow.ingest(item);
        await flow.processor.process(job);
      }
      expect(flow.deleted).toEqual(items.slice(2).map((item) => item.id));
      expect(flow.sanctions.map((entry) => entry.action)).toEqual(['WARN', 'MUTE', 'BAN']);
    });

    it('handles four distinct pictures with text as one logical occurrence', async () => {
      flow = await createFlow({ duplicatePhotoEnabled: false });
      const first = flow.prepare({
        photo: 'png',
        photoCount: 4,
        text: 'Selling a complete aquarium. Contact in private.',
      });
      const repeat = flow.prepare({
        photo: 'webp',
        photoCount: 4,
        reversePhotos: true,
        text: 'Second caption for the same album.',
      });
      await flow.processor.process((await flow.ingest(first))!);
      const job = (await flow.ingest(repeat))!;
      await flow.processor.process(job);
      expect(flow.deleted).toEqual([repeat.id]);
      expect(flow.downloads).toHaveBeenCalledTimes(8);
      await flow.processor.process(job);
      expect(flow.deleted).toEqual([repeat.id]);
    });

    it('retains an album if one of its four pictures is different', async () => {
      flow = await createFlow();
      await flow.processor.process(
        (await flow.ingest(flow.prepare({ photo: 'png', photoCount: 4, text: 'same caption' })))!,
      );
      await flow.processor.process(
        (await flow.ingest(
          flow.prepare({
            photo: 'png',
            photoCount: 4,
            changedPhotoIndex: 2,
            text: 'different caption',
          }),
        ))!,
      );
      expect(flow.deleted).toEqual([]);
      expect(flow.sanctions).toEqual([]);
    });

    it('honors an explicitly allowed first repeat for a four-picture post', async () => {
      flow = await createFlow({ duplicateWarnMaxCount: 2 });
      const items = Array.from({ length: 3 }, () =>
        flow.prepare({ photo: 'png', photoCount: 4, text: 'same caption' }),
      );
      for (const item of items) {
        const job = await flow.ingest(item);
        if (job) await flow.processor.process(job);
      }
      expect(flow.deleted).toEqual([items[2]!.id]);
    });

    it.each([
      ['direct', 'forward'],
      ['forward', 'direct'],
      ['forward', 'forward'],
    ] as const)(
      'keeps the outer author and personal WARN for CHAT image repeats from %s to %s',
      async (originalKind, repeatKind) => {
        flow = await createFlow({
          duplicatePhotoScope: 'CHAT',
          duplicateWarnEnabled: true,
          duplicateMuteEnabled: true,
          duplicateWarnMaxCount: 1,
          duplicateMuteMaxCount: 2,
        });
        const original = flow.prepare({
          photo: 'png',
          messageLink: originalKind === 'forward' ? 'forward' : undefined,
          userId: 123,
        });
        const ownRepeat = flow.prepare({
          photo: 'png',
          messageLink: originalKind === 'forward' ? 'forward' : undefined,
          userId: 123,
        });
        const otherAuthorRepeat = flow.prepare({
          photo: 'webp',
          messageLink: repeatKind === 'forward' ? 'forward' : undefined,
          userId: 456,
          text: 'Another author and caption',
        });
        for (const item of [original, ownRepeat])
          await flow.processor.process((await flow.ingest(item))!);
        const job = (await flow.ingest(otherAuthorRepeat))!;
        await flow.processor.process(job);

        expect(flow.deleted).toEqual([ownRepeat.id, otherAuthorRepeat.id]);
        expect(flow.sanctions).toEqual([
          { messageId: ownRepeat.id, action: 'WARN' },
          { messageId: otherAuthorRepeat.id, action: 'WARN' },
        ]);
        const intent = flow.records.get(`intent:${otherAuthorRepeat.id}`)!.input;
        const binding = parseMessageDuplicateBinding(intent.event!.metadata)!;
        expect(intent.subjectUserId).toBe('456');
        expect(binding).toMatchObject({
          senderId: '456',
          messageId: otherAuthorRepeat.id,
          original: { senderId: '123', messageId: original.id },
        });
        expect(flow.remote.has(original.id)).toBe(true);
        expect(flow.downloads).toHaveBeenCalledTimes(3);

        await flow.ingest(otherAuthorRepeat);
        await flow.processor.process(job);
        expect(flow.deleted).toEqual([ownRepeat.id, otherAuthorRepeat.id]);
        expect(flow.sanctions).toHaveLength(2);
        expect(flow.downloads).toHaveBeenCalledTimes(3);
      },
    );

    it('keeps cross-author forwards separate in SAME_AUTHOR despite the same nested sender', async () => {
      flow = await createFlow({
        duplicatePhotoScope: 'SAME_AUTHOR',
        duplicateWarnEnabled: true,
      });
      for (const userId of [123, 456]) {
        const item = flow.prepare({ photo: 'png', messageLink: 'forward', userId });
        await flow.processor.process((await flow.ingest(item))!);
      }
      expect(flow.deleted).toEqual([]);
      expect(flow.sanctions).toEqual([]);
    });

    it('preserves a changed forwarded image in CHAT comparison', async () => {
      flow = await createFlow({ duplicatePhotoScope: 'CHAT', duplicateWarnEnabled: true });
      const original = flow.prepare({ photo: 'png', userId: 123 });
      const changed = flow.prepare({ photo: 'different', messageLink: 'forward', userId: 456 });
      for (const item of [original, changed])
        await flow.processor.process((await flow.ingest(item))!);
      expect(flow.deleted).toEqual([]);
      expect(flow.sanctions).toEqual([]);
      expect(flow.remote.has(original.id)).toBe(true);
      expect(flow.remote.has(changed.id)).toBe(true);
    });

    it('does not compare an image present only in a reply reference as a repost', async () => {
      flow = await createFlow({ duplicatePhotoScope: 'CHAT', duplicateWarnEnabled: true });
      const original = flow.prepare({ photo: 'png', userId: 123 });
      await flow.processor.process((await flow.ingest(original))!);
      const reply = flow.prepare({
        photo: 'png',
        messageLink: 'reply',
        userId: 456,
        text: 'Is this still available?',
      });
      expect(await flow.ingest(reply)).toBeUndefined();
      expect(flow.deleted).toEqual([]);
      expect(flow.sanctions).toEqual([]);
      expect(flow.downloads).not.toHaveBeenCalled();
      expect(flow.remote.has(original.id)).toBe(true);
      expect(flow.remote.has(reply.id)).toBe(true);
    });

    it('keeps each author on their own sanction ladder in chat-wide image comparison', async () => {
      flow = await createFlow({
        duplicatePhotoScope: 'CHAT',
        duplicateWarnEnabled: true,
        duplicateMuteEnabled: true,
        duplicateBanEnabled: true,
        duplicateWarnMaxCount: 1,
        duplicateMuteMaxCount: 2,
        duplicateBanMaxCount: 3,
      });
      const items = [
        flow.prepare({ photo: 'png', userId: 123 }),
        flow.prepare({ photo: 'png', userId: 123 }),
        flow.prepare({ photo: 'png', userId: 123 }),
        flow.prepare({ photo: 'png', userId: 456, text: 'Different caption' }),
        flow.prepare({ photo: 'png', userId: 123 }),
        flow.prepare({ photo: 'png', userId: 456 }),
      ];
      for (const item of items) await flow.processor.process((await flow.ingest(item))!);
      expect(flow.sanctions.map((entry) => entry.action)).toEqual([
        'WARN',
        'MUTE',
        'WARN',
        'BAN',
        'MUTE',
      ]);
      expect(flow.deleted).toEqual(items.slice(1).map((item) => item.id));
    });

    it('does not turn an edit of one photo message into a second publication', async () => {
      flow = await createFlow();
      const first = flow.prepare({ photo: 'png' });
      await flow.processor.process((await flow.ingest(first))!);
      const edited = flow.prepare({
        id: first.id,
        photo: 'png',
        time: first.time + 100,
        editedFrom: first.time,
      });
      expect(edited.update.message!.createdAt).toBe(new Date(edited.time).toISOString());
      await flow.processor.process((await flow.ingest(edited))!);
      expect(flow.deleted).toEqual([]);
      const second = flow.prepare({ photo: 'png', time: edited.time + 100 });
      await flow.processor.process((await flow.ingest(second))!);
      expect(flow.deleted).toEqual([second.id]);
    });

    it.each(['off', 'admin', 'immunity', 'edited', 'downgrade-during-check'] as const)(
      'checks %s again at final dispatch',
      async (reason) => {
        flow = await createFlow();
        await flow.processor.process((await flow.ingest(flow.prepare({ photo: 'png' })))!);
        const second = flow.prepare({ photo: 'png' });
        const job = (await flow.ingest(second))!;
        if (reason === 'off') flow.policyValue.mode = 'off';
        if (reason === 'downgrade-during-check')
          flow.max.getChatMemberAccess.mockImplementation(async (_chatId, userId) => {
            flow.policyValue.mode = 'off';
            return { userId, isAdmin: false, isOwner: false };
          });
        if (reason === 'admin')
          flow.max.getChatMemberAccess.mockResolvedValue({
            userId: '123',
            isAdmin: true,
            isOwner: false,
          });
        if (reason === 'immunity') flow.immunity.consumeForMessage.mockResolvedValue('granted');
        if (reason === 'edited')
          flow.prepare({
            id: second.id,
            photo: 'different',
            text: 'Changed after ingestion',
            time: second.time + 1,
            editedFrom: second.time,
          });
        await flow.processor.process(job);
        expect(flow.deleted).toEqual([]);
        expect(flow.sanctions).toEqual([]);
      },
    );
  },
);
