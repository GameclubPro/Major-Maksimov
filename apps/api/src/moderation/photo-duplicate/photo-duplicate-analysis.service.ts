import { Injectable, Optional } from '@nestjs/common';
import {
  MessageDuplicateMetricsService,
  measureDuplicatePhase,
} from '../message-duplicate/message-duplicate-metrics.service';
import { createHash } from 'node:crypto';
import { raceWithTimeout } from '../../common/promise-timeout.util';
import type { LogicalPhotoAlbum } from './photo-attachment-extractor';
import {
  createPhotoAlbumFingerprint,
  PHOTO_FINGERPRINT_ALGORITHM_VERSION,
  type PhotoFingerprint,
  PhotoFingerprintRejectedError,
  type PhotoFingerprintRejectionReason,
  type PhotoMatchPreset,
  PhotoFingerprintService,
} from './photo-fingerprint';
import {
  PhotoDuplicateHistoryStore,
  type PhotoDuplicateScope,
  type PhotoHistoryMatchKind,
  type PhotoHistoryObservationResult,
  type PhotoHistoryViolationActionBinding,
  type PhotoHistoryViolationCommitResult,
  type PhotoFingerprintCacheLookupResult,
} from './photo-duplicate-history.store';
import { PhotoDownloadTimeoutError, SecurePhotoDownloader } from './secure-photo-downloader';
import type { PhotoRecompressionProof } from './photo-recompression-version';

const PROOF_CACHE_WAIT_LIMIT_MS = 250;

// FLAG: Optional proof-cache IO may finish late, but cannot hold an attempt through
// Redis retries. A late lookup is a miss; a failed write never retries verified native work.
async function boundedProofCache<T>(
  operation: () => Promise<T>,
  deadlineAtMs: number,
  fallback: T,
): Promise<T> {
  const timeoutMs = Math.min(PROOF_CACHE_WAIT_LIMIT_MS, deadlineAtMs - Date.now());
  if (timeoutMs <= 0) return fallback;
  try {
    return await raceWithTimeout({ operation, timeoutMs, onTimeout: () => fallback });
  } catch {
    return fallback;
  }
}

export type PhotoDuplicateAnalysisResult =
  | {
      kind: 'incomplete';
      reason: 'missing_download_url' | PhotoFingerprintRejectionReason;
    }
  | {
      kind: 'observed';
      albumHash: string;
      imageCount: number;
      actionEligible: boolean;
      observation: PhotoHistoryObservationResult;
    };

@Injectable()
export class PhotoDuplicateAnalysisService {
  constructor(
    private readonly downloader: SecurePhotoDownloader,
    private readonly fingerprintService: PhotoFingerprintService,
    private readonly historyStore: PhotoDuplicateHistoryStore,
    @Optional() private readonly metrics?: MessageDuplicateMetricsService,
  ) {}

  async verifyRecompression(params: {
    originalUrl: string;
    currentUrl: string;
    expectedOriginalHash: string;
    expectedCurrentHash: string;
    deadlineAtMs: number;
  }): Promise<PhotoRecompressionProof | null> {
    if (
      !/^[a-f0-9]{64}$/.test(params.expectedOriginalHash) ||
      !/^[a-f0-9]{64}$/.test(params.expectedCurrentHash)
    )
      return null;
    // FLAG: Both independent downloads and the native pair share the original attempt deadline.
    // A candidate hash/cache entry never substitutes for either current source or exact SHA.
    const original = await measureDuplicatePhase(this.metrics, 'download', () =>
      measureDuplicatePhase(this.metrics, 'photo_download', async () => {
        const original = await this.downloader.download(params.originalUrl, {
          deadlineAtMs: params.deadlineAtMs,
        });
        return original;
      }),
    );
    const current = await measureDuplicatePhase(this.metrics, 'download', () =>
      measureDuplicatePhase(this.metrics, 'photo_download', async () => {
        const current = await this.downloader.download(params.currentUrl, {
          deadlineAtMs: params.deadlineAtMs,
        });
        return current;
      }),
    );
    const result = await this.fingerprintService.verifyRecompression(
      original.bytes,
      current.bytes,
      {
        deadlineAtMs: params.deadlineAtMs,
        timings: this.metrics,
      },
    );
    if (
      !result.matched ||
      result.proof.originalHash !== params.expectedOriginalHash ||
      result.proof.currentHash !== params.expectedCurrentHash
    )
      return null;
    return result.proof;
  }

  async analyzeAlbum(params: {
    album: LogicalPhotoAlbum;
    ttlSeconds: number;
    scope: PhotoDuplicateScope;
    preset: PhotoMatchPreset;
    actionEligible: boolean;
    authorizationConfigDigest: string;
    allowedViolationMatchKinds: readonly PhotoHistoryMatchKind[];
    resolveActionEligibility: () => Promise<boolean>;
  }): Promise<PhotoDuplicateAnalysisResult> {
    const prepared = await this.fingerprintAlbum(params.album, params.ttlSeconds);
    if (prepared.kind === 'incomplete') return prepared;
    const albumFingerprint = prepared.fingerprint;
    const authorizationConfigDigest = params.authorizationConfigDigest.trim().toLowerCase();
    const currentActionEligibility = await params.resolveActionEligibility();
    const actionEligible = params.actionEligible && currentActionEligibility;
    const observation = await this.historyStore.observeAlbum({
      chatId: params.album.chatId,
      senderId: params.album.senderId,
      messageId: params.album.messageId,
      occurredAtMs: params.album.createdAtMs,
      ttlSeconds: params.ttlSeconds,
      scope: params.scope,
      fingerprintVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
      albumHash: albumFingerprint.albumHash,
      exactMatchKind: 'canonical_sha256',
      perceptualAlbum: albumFingerprint,
      allowPerceptualMatch: true,
      perceptualPreset: params.preset,
      authorization: {
        eligible: actionEligible,
        configDigest: authorizationConfigDigest,
        allowedMatchKinds: params.allowedViolationMatchKinds,
      },
    });
    const matchKindAllowsAction =
      observation.kind === 'available' &&
      (observation.classification !== 'duplicate' ||
        (observation.matchKind !== null &&
          params.allowedViolationMatchKinds.includes(observation.matchKind)));
    const observationAuthorizationAllowsAction =
      observation.kind === 'available' &&
      observation.authorization.authorized &&
      observation.authorization.configDigest === authorizationConfigDigest;
    return {
      kind: 'observed',
      albumHash: albumFingerprint.albumHash,
      imageCount: albumFingerprint.images.length,
      actionEligible:
        actionEligible && matchKindAllowsAction && observationAuthorizationAllowsAction,
      observation,
    };
  }

  async fingerprintAlbum(
    album: LogicalPhotoAlbum,
    ttlSeconds: number,
    deadlineAtMs = Number.MAX_SAFE_INTEGER,
    requireRecompressionHash = false,
  ) {
    const params = { album, ttlSeconds };
    if (Date.now() >= deadlineAtMs) {
      return { kind: 'incomplete' as const, reason: 'decode_deadline_exceeded' as const };
    }
    const cachedFingerprints = await this.readCachedFingerprints(
      params.album,
      deadlineAtMs,
      requireRecompressionHash,
    );
    if (Date.now() >= deadlineAtMs) {
      return { kind: 'incomplete' as const, reason: 'decode_deadline_exceeded' as const };
    }
    const missingDownloadUrl = params.album.images.some(
      (image, index) => !cachedFingerprints[index] && !image.downloadUrl,
    );
    if (missingDownloadUrl) {
      return { kind: 'incomplete' as const, reason: 'missing_download_url' as const };
    }

    const albumBudget = this.fingerprintService.createAlbumDecodeBudget();
    const completeFingerprints: PhotoFingerprint[] = [];
    for (let index = 0; index < params.album.images.length; index += 1) {
      if (Date.now() >= deadlineAtMs) {
        return { kind: 'incomplete' as const, reason: 'decode_deadline_exceeded' as const };
      }
      const cached = cachedFingerprints[index];
      try {
        if (cached) {
          if (!this.fingerprintService.reserveCachedFingerprint(cached, albumBudget)) {
            return { kind: 'incomplete' as const, reason: 'album_decode_budget_exceeded' as const };
          }
          completeFingerprints.push(cached);
          continue;
        }

        const image = params.album.images[index];
        const downloaded = await measureDuplicatePhase(this.metrics, 'download', () =>
          measureDuplicatePhase(this.metrics, 'photo_download', () =>
            deadlineAtMs === Number.MAX_SAFE_INTEGER
              ? this.downloader.download(image.downloadUrl!)
              : this.downloader.download(image.downloadUrl!, { deadlineAtMs }),
          ),
        );
        if (Date.now() >= deadlineAtMs) {
          return { kind: 'incomplete' as const, reason: 'decode_deadline_exceeded' as const };
        }
        const fingerprint = await this.fingerprintService.fingerprint(downloaded.bytes, {
          albumBudget,
          expectedFormat: downloaded.format,
          deadlineAtMs,
          ...(this.metrics ? { timings: this.metrics } : {}),
        });
        completeFingerprints.push(fingerprint);
        // FLAG: A proof checkpoints one verified image, never an actionable partial album.
        // Cache identity includes the message revision/source; cost is charged again on resume.
        await boundedProofCache(
          () =>
            this.historyStore.cachePhotoFingerprints(
              [{ photoId: this.cacheIdentity(params.album, image), fingerprint }],
              params.ttlSeconds,
            ),
          deadlineAtMs,
          false,
        );
      } catch (error: unknown) {
        if (error instanceof PhotoFingerprintRejectedError) {
          return { kind: 'incomplete' as const, reason: error.reason };
        }
        if (error instanceof PhotoDownloadTimeoutError && Date.now() >= deadlineAtMs) {
          return { kind: 'incomplete' as const, reason: 'decode_deadline_exceeded' as const };
        }
        throw error;
      }
    }

    // FLAG: Checkpoint completion cannot extend the attempt or authorize an expired album.
    if (Date.now() >= deadlineAtMs) {
      return { kind: 'incomplete' as const, reason: 'decode_deadline_exceeded' as const };
    }
    const albumFingerprint = createPhotoAlbumFingerprint(completeFingerprints);
    return { kind: 'complete' as const, fingerprint: albumFingerprint };
  }

  async commitViolation(params: {
    album: LogicalPhotoAlbum;
    albumHash: string;
    ttlSeconds: number;
    scope: PhotoDuplicateScope;
    preset: PhotoMatchPreset;
    observationClusterId: string;
    matchKind: PhotoHistoryMatchKind;
    expectedRepeatCount: number;
    allowedMatchKinds: readonly PhotoHistoryMatchKind[];
    authorizationConfigDigest: string;
    actionBinding: PhotoHistoryViolationActionBinding;
  }): Promise<PhotoHistoryViolationCommitResult> {
    return this.historyStore.commitViolation({
      chatId: params.album.chatId,
      senderId: params.album.senderId,
      messageId: params.album.messageId,
      ttlSeconds: params.ttlSeconds,
      scope: params.scope,
      fingerprintVersion: PHOTO_FINGERPRINT_ALGORITHM_VERSION,
      albumHash: params.albumHash,
      perceptualPreset: params.preset,
      observationClusterId: params.observationClusterId,
      matchKind: params.matchKind,
      expectedRepeatCount: params.expectedRepeatCount,
      allowedMatchKinds: params.allowedMatchKinds,
      authorizationConfigDigest: params.authorizationConfigDigest,
      actionBinding: params.actionBinding,
    });
  }

  private async readCachedFingerprints(
    album: LogicalPhotoAlbum,
    deadlineAtMs: number,
    requireRecompressionHash = false,
  ): Promise<Array<PhotoFingerprint | null>> {
    const photoIds = album.images.map((image) => this.cacheIdentity(album, image));
    if (photoIds.length === 0) return [];
    const lookup = await boundedProofCache<PhotoFingerprintCacheLookupResult>(
      () => this.historyStore.getCachedPhotoFingerprints(photoIds),
      deadlineAtMs,
      { kind: 'unavailable' },
    );
    return album.images.map((_, index) => {
      const fingerprint = lookup.kind === 'available' ? lookup.fingerprints[index] : null;
      // Legacy proofs do not contain resource costs and cannot bypass the resumed budget.
      return fingerprint?.decodeCost && (!requireRecompressionHash || fingerprint.recompressionHash)
        ? fingerprint
        : null;
    });
  }

  private cacheIdentity(album: LogicalPhotoAlbum, image: LogicalPhotoAlbum['images'][number]) {
    // FLAG: A platform ID cannot prove equality across messages. Reuse only this verified
    // message/revision/source; persist the digest, never the source URL or its credentials.
    return createHash('sha256')
      .update(
        JSON.stringify([
          'photo-proof-v2',
          album.receiptId ?? null,
          album.chatId,
          album.senderId,
          album.messageId,
          album.createdAtMs,
          image.photoId,
          image.downloadUrl,
        ]),
      )
      .digest('hex');
  }
}
