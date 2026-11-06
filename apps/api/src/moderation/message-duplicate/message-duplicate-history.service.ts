import { Injectable, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ChatSettings } from '../../prisma/prisma-client';
import { raceWithTimeout } from '../../common/promise-timeout.util';
import { resolveDuplicateFlowConfig } from '../duplicate-flow-policy';
import { RedisCounterService } from '../redis-counter.service';
import {
  RuleEngineDuplicateDetector,
  type DuplicateFingerprint,
} from '../rule-engine-duplicate-detector';
import type { DuplicateHit } from '../rule-engine.contract';
import { MessageDuplicateMetricsService } from './message-duplicate-metrics.service';
import { resolveDuplicateDailyWindow } from './message-duplicate-schedule';
import {
  buildMessageDuplicateIdentity,
  digestDuplicateContent,
  exactImageSourceDigest,
  isDuplicateContentComparable,
  type DuplicateMessageContent,
} from './message-duplicate-content';
import {
  MESSAGE_DUPLICATE_MEDIA_VERSION,
  messageDuplicateOriginalSchema,
  messageDuplicateSettingsDigest,
  exactImageSettingsDigest,
  hasValidImageComparisonEvidence,
  type MessageDuplicateBinding,
  type MessageDuplicateOriginal,
} from './message-duplicate-state';
import {
  PHOTO_RECOMPRESSION_VERSION,
  type PhotoRecompressionProof,
} from '../photo-duplicate/photo-recompression-version';

export type MessageDuplicateObservation = {
  content: DuplicateMessageContent;
  chatId: string;
  userId: string;
  messageId: string;
  eventTimestampMs: number;
  publishedAtMs?: number;
  controlRevision: number;
  settings: ChatSettings;
  comparison?: 'TEXT' | 'MESSAGE';
  mediaHashes?: readonly string[];
  imageScope?: 'SAME_AUTHOR' | 'CHAT';
  imageRecompression?: PhotoRecompressionProof;
  imageOriginal?: MessageDuplicateOriginal;
};

export type MessageDuplicateHistoryObservation = {
  outcome: 'SCHEDULE_CLOSED' | 'CONTENT_UNVERIFIED' | 'STALE' | 'COMPARED_NO_MATCH' | 'MATCHED';
  match: { hit: DuplicateHit; binding: MessageDuplicateBinding } | null;
};

export const MESSAGE_DUPLICATE_FINGERPRINT_LIMIT = 16;

export function selectMessageDuplicateFingerprints(
  fingerprints: readonly DuplicateFingerprint[],
): DuplicateFingerprint[] {
  if (fingerprints.length <= MESSAGE_DUPLICATE_FINGERPRINT_LIMIT) return [...fingerprints];
  const groups = new Map<DuplicateFingerprint['type'], DuplicateFingerprint[]>();
  for (const fingerprint of fingerprints) {
    const group = groups.get(fingerprint.type) ?? [];
    group.push(fingerprint);
    groups.set(fingerprint.type, group);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  }
  // FLAG: A large link list must not evict enabled phone/content/near matching. Both candidate
  // lookup and verified membership use this deterministic, type-balanced bounded selection.
  const selected: DuplicateFingerprint[] = [];
  for (let index = 0; selected.length < MESSAGE_DUPLICATE_FINGERPRINT_LIMIT; index += 1) {
    for (const group of groups.values()) {
      if (group[index]) selected.push(group[index]);
      if (selected.length === MESSAGE_DUPLICATE_FINGERPRINT_LIMIT) break;
    }
  }
  return selected;
}

@Injectable()
export class MessageDuplicateHistoryService {
  private readonly fingerprints: RuleEngineDuplicateDetector;
  constructor(
    private readonly redis: RedisCounterService,
    @Optional() private readonly metrics?: MessageDuplicateMetricsService,
  ) {
    this.fingerprints = new RuleEngineDuplicateDetector(redis);
  }

  candidateKeys(
    content: DuplicateMessageContent,
    settings: ChatSettings,
    imageOnly = false,
  ): string[] {
    if (imageOnly) return [digestDuplicateContent(['exact-image-v1', content.media.length])];
    const parts = this.buildFingerprints(content, settings);
    return parts.map((part) =>
      digestDuplicateContent({
        version: 1,
        value: part.value,
        type: part.type,
        textPresent: content.text.length > 0,
        actions: content.actions,
        media: content.media.map((media) => media.kind),
      }),
    );
  }

  async observe(
    input: MessageDuplicateObservation,
  ): Promise<{ hit: DuplicateHit; binding: MessageDuplicateBinding } | null> {
    return (await this.observeWithOutcome(input)).match;
  }

  async observeWithOutcome(
    input: MessageDuplicateObservation,
  ): Promise<MessageDuplicateHistoryObservation> {
    const mode = input.imageScope
      ? 'IMAGE'
      : (input.comparison ?? (input.settings.duplicateCompareMode === 'TEXT' ? 'TEXT' : 'MESSAGE'));
    const dailyWindow = resolveDuplicateDailyWindow(input.settings, input.eventTimestampMs);
    if (dailyWindow === null) {
      await this.window(input.chatId, {
        op: 'lifecycle',
        member: digestDuplicateContent(input.messageId),
        at: input.eventTimestampMs,
        publishedAt: input.publishedAtMs ?? input.eventTimestampMs,
        sources: { [mode]: lifecycleSourceDigest(input.content, mode) },
      });
      return { outcome: 'SCHEDULE_CLOSED', match: null };
    }
    const mediaHashes = [...(input.mediaHashes ?? [])];
    const identity = buildMessageDuplicateIdentity(input.content, mode, mediaHashes);
    const recompression = input.imageRecompression;
    if (
      recompression &&
      (mode !== 'IMAGE' ||
        mediaHashes.length !== 1 ||
        recompression.version !== PHOTO_RECOMPRESSION_VERSION ||
        !/^[a-f0-9]{64}$/.test(recompression.originalHash) ||
        recompression.currentHash !== mediaHashes[0] ||
        recompression.currentHash === recompression.originalHash ||
        !input.imageOriginal ||
        input.imageOriginal.mediaHashes.length !== 1 ||
        input.imageOriginal.mediaHashes[0] !== recompression.originalHash)
    )
      throw new Error('Invalid image recompression evidence');
    const anchorIdentity = recompression
      ? buildMessageDuplicateIdentity(input.content, 'IMAGE', [recompression.originalHash])
      : identity;
    const flow = resolveDuplicateFlowConfig(input.settings);
    const windowSec = dailyWindow
      ? Math.ceil((dailyWindow.endMs - dailyWindow.startMs) / 1000)
      : flow.windowSec;
    const parts: DuplicateFingerprint[] = identity
      ? mode === 'IMAGE'
        ? [
            {
              type: input.content.media.length === 1 ? 'image' : 'image_set',
              value: anchorIdentity!,
            },
          ]
        : this.buildFingerprints(input.content, input.settings)
      : [];
    const settingsDigest =
      mode === 'IMAGE'
        ? exactImageSettingsDigest(input.settings)
        : messageDuplicateSettingsDigest(input.settings);
    const patterns = parts.map((part) => ({
      part,
      hash: digestDuplicateContent({
        version: 1,
        mode,
        controlRevision: input.controlRevision,
        settingsDigest,
        type: part.type,
        textPresent: mode === 'IMAGE' ? false : input.content.text.length > 0,
        value: part.value,
        actions: mode === 'IMAGE' ? [] : input.content.actions,
        media:
          mode === 'MESSAGE'
            ? input.content.media.map((media, index) => [media.kind, mediaHashes[index]])
            : [],
      }),
    }));
    const sourceDigest = duplicateSourceDigest(input.content, mode);
    const mutation = await this.window(input.chatId, {
      op: 'observe',
      mode,
      scope:
        mode === 'IMAGE' && input.imageScope === 'CHAT'
          ? 'chat'
          : digestDuplicateContent(input.userId),
      member: digestDuplicateContent(input.messageId),
      author: digestDuplicateContent(input.userId),
      messageId: input.messageId,
      senderId: input.userId,
      at: input.eventTimestampMs,
      publishedAt: input.publishedAtMs ?? input.eventTimestampMs,
      source: sourceDigest,
      lifecycleSource: lifecycleSourceDigest(input.content, mode),
      identity: identity ?? '',
      pendingSafe: isDuplicateContentComparable(input.content, mode),
      mediaHashes,
      ...(recompression ? { recompressionOriginal: input.imageOriginal } : {}),
      fingerprints: patterns.map((pattern) => pattern.hash),
      allowed: flow.allowedCount,
      windowMs: windowSec * 1000,
      context: digestDuplicateContent([
        settingsDigest,
        input.controlRevision,
        dailyWindow?.startMs,
      ]),
      ...(dailyWindow ? { periodStart: dailyWindow.startMs, periodEnd: dailyWindow.endMs } : {}),
    });
    if (mutation.kind === 'replayed') this.metrics?.record('history.replayed');
    if (!identity || mutation.kind === 'stale' || !mutation.revision) {
      this.metrics?.record(identity ? 'history.stale' : 'history.unverified');
      return { outcome: identity ? 'STALE' : 'CONTENT_UNVERIFIED', match: null };
    }
    const matches = Array.isArray(mutation.matches) ? mutation.matches : [];
    const selected = matches.sort((a, b) => (b.qualified ?? b.count) - (a.qualified ?? a.count))[0];
    const pattern = selected && patterns.find((part) => part.hash === selected.fingerprint);
    if (!selected || !pattern) {
      this.metrics?.record('history.no_match_or_allowed');
      return { outcome: 'COMPARED_NO_MATCH', match: null };
    }
    this.metrics?.record('history.matched');
    const match = { ...pattern, count: selected.qualified ?? selected.count };
    const binding: MessageDuplicateBinding = {
      version: 3,
      enforcementScope: mode === 'IMAGE' ? 'full' : 'delete_only',
      lifecycleRevision: mutation.revision,
      policyRevision: input.settings.duplicatePolicyRevision,
      original: messageDuplicateOriginalSchema.parse({
        ...selected.original,
        mediaHashes: Array.isArray(selected.original.mediaHashes)
          ? selected.original.mediaHashes
          : [],
      }),
      senderId: input.userId,
      messageId: input.messageId,
      eventTimestampMs: mutation.observedAt ?? input.eventTimestampMs,
      controlRevision: input.controlRevision,
      compareMode: mode,
      ...(input.imageScope ? { imageScope: input.imageScope } : {}),
      settingsDigest,
      sourceDigest,
      contentDigest: identity,
      fingerprint: match.hash,
      mediaHashes,
      mediaVersion: MESSAGE_DUPLICATE_MEDIA_VERSION,
      ...(recompression ? { imageRecompression: recompression } : {}),
      hasPhotos: mode !== 'TEXT' && input.content.media.some((media) => media.kind === 'photo'),
      photoControlRevision: null,
      windowSeconds: windowSec,
      requiredCount: flow.allowedCount + 2,
    };
    if (!hasValidImageComparisonEvidence(binding))
      return { outcome: 'CONTENT_UNVERIFIED', match: null };
    return {
      outcome: 'MATCHED',
      match: {
        binding,
        hit: {
          count: match.count,
          windowSec,
          hash: match.hash,
          fingerprintType: match.part.type,
          metadata: { duplicateSource: 'message_v1', messageDuplicate: binding },
        },
      },
    };
  }

  async observeLifecycle(input: {
    chatId: string;
    messageId: string;
    eventTimestampMs: number;
    publishedAtMs?: number;
    content: DuplicateMessageContent;
  }): Promise<void> {
    await this.window(input.chatId, {
      op: 'lifecycle',
      member: digestDuplicateContent(input.messageId),
      at: input.eventTimestampMs,
      ...(input.publishedAtMs ? { publishedAt: input.publishedAtMs } : {}),
      sources: {
        TEXT: lifecycleSourceDigest(input.content, 'TEXT'),
        MESSAGE: lifecycleSourceDigest(input.content, 'MESSAGE'),
        IMAGE: lifecycleSourceDigest(input.content, 'IMAGE'),
      },
    });
  }

  async invalidateLifecycle(input: {
    chatId: string;
    messageId: string;
    content: DuplicateMessageContent;
  }): Promise<void> {
    // FLAG: A fresh MAX read proves the old evidence stale, but does not establish
    // when edited content was introduced. A worker clock must not admit a new original.
    await this.window(input.chatId, {
      op: 'invalidate',
      member: digestDuplicateContent(input.messageId),
      sources: {
        TEXT: lifecycleSourceDigest(input.content, 'TEXT'),
        MESSAGE: lifecycleSourceDigest(input.content, 'MESSAGE'),
        IMAGE: lifecycleSourceDigest(input.content, 'IMAGE'),
      },
    });
  }

  async remove(chatId: string, messageId: string): Promise<void> {
    await this.window(chatId, { op: 'remove', member: digestDuplicateContent(messageId) });
  }

  async stillMatches(
    chatId: string,
    binding: MessageDuplicateBinding,
    afterDelete = false,
  ): Promise<boolean> {
    if (!this.hasCurrentRevision(binding)) return false;
    const result = await this.window(chatId, {
      ...this.checkInput(binding),
      op: 'check',
      afterDelete,
    });
    return result.kind === 'ok' && (result.count ?? 0) >= binding.requiredCount - 1;
  }

  async qualified(chatId: string, binding: MessageDuplicateBinding): Promise<number | null> {
    if (!this.hasCurrentRevision(binding)) return null;
    const result = await this.window(chatId, {
      ...this.checkInput(binding),
      op: 'check',
      afterDelete: true,
    });
    return result.kind === 'ok' ? (result.qualified ?? null) : null;
  }

  async findImageOriginal(input: MessageDuplicateObservation) {
    if (!input.imageScope || input.mediaHashes?.length !== 1) return null;
    const identity = buildMessageDuplicateIdentity(input.content, 'IMAGE', input.mediaHashes);
    const period = resolveDuplicateDailyWindow(input.settings, input.eventTimestampMs);
    if (!identity || period === null) return null;
    const fingerprint = digestDuplicateContent({
      version: 1,
      mode: 'IMAGE',
      controlRevision: input.controlRevision,
      settingsDigest: exactImageSettingsDigest(input.settings),
      type: 'image',
      textPresent: false,
      value: identity,
      actions: [],
      media: [],
    });
    const result = await this.window(input.chatId, {
      op: 'image_anchor',
      mode: 'IMAGE',
      fingerprint,
      scope: input.imageScope === 'CHAT' ? 'chat' : digestDuplicateContent(input.userId),
      at: input.eventTimestampMs,
      ...(period ? { periodStart: period.startMs } : {}),
    });
    const original = messageDuplicateOriginalSchema.safeParse(result.original);
    return result.kind === 'ok' && original.success ? original.data : null;
  }

  async qualify(chatId: string, binding: MessageDuplicateBinding): Promise<number | null> {
    if (!this.hasCurrentRevision(binding)) return null;
    const result = await this.window(chatId, { ...this.checkInput(binding), op: 'qualify' });
    return result.kind === 'ok' ? (result.count ?? null) : null;
  }

  private checkInput(binding: MessageDuplicateBinding) {
    return {
      mode: binding.compareMode,
      revision: binding.lifecycleRevision,
      member: digestDuplicateContent(binding.messageId),
      author: digestDuplicateContent(binding.senderId),
      source: binding.sourceDigest,
      identity: binding.contentDigest,
      original: binding.original,
      fingerprint: binding.fingerprint,
      at: binding.eventTimestampMs,
      allowed: binding.requiredCount - 2,
      windowMs: binding.windowSeconds * 1000,
    };
  }

  private async window(chatId: string, input: Record<string, unknown>) {
    return raceWithTimeout({
      operation: () =>
        this.redis.duplicateWindow(chatId, {
          ...input,
          token: digestDuplicateContent(randomUUID()),
        }),
      // FLAG: Redis retains its independent 250 ms admission deadline before mutation.
      // Allow a bounded reply delay for a command it already accepted. Never retry the
      // unknown mutation or treat a missing reply as a match or successful observation.
      timeoutMs: 1_000,
      onTimeout: () => {
        throw new Error('Message duplicate history deadline exceeded');
      },
    }).catch((error: unknown) => {
      this.metrics?.record('history.unavailable');
      throw error;
    });
  }

  private hasCurrentRevision(binding: MessageDuplicateBinding): boolean {
    return (
      binding.version === 3 &&
      hasValidImageComparisonEvidence(binding) &&
      !!binding.lifecycleRevision &&
      !!binding.original?.revision &&
      !!binding.original.originalId
    );
  }

  private buildFingerprints(content: DuplicateMessageContent, settings: ChatSettings) {
    const all = this.fingerprints.buildFingerprints(
      // FLAG: URL paths, query values and fragments are case-sensitive. Normalize prose inside
      // the detector, never before extracting navigation value fingerprints.
      content.rawText,
      settings,
      content.navigationTargets,
    );
    if (all.length > MESSAGE_DUPLICATE_FINGERPRINT_LIMIT)
      this.metrics?.record('history.fingerprint_budget');
    const parts = selectMessageDuplicateFingerprints(all);
    if (parts.length === 0) parts.push({ type: 'exact', value: '' });
    return parts;
  }
}

export function duplicateSourceDigest(
  content: DuplicateMessageContent,
  mode: 'TEXT' | 'MESSAGE' | 'IMAGE',
): string {
  return mode === 'IMAGE'
    ? exactImageSourceDigest(content)
    : mode === 'TEXT'
      ? (buildMessageDuplicateIdentity(content, 'TEXT') ?? content.sourceDigest)
      : content.sourceDigest;
}

function lifecycleSourceDigest(
  content: DuplicateMessageContent,
  mode: 'TEXT' | 'MESSAGE' | 'IMAGE',
): string {
  const source = duplicateSourceDigest(content, mode);
  return isDuplicateContentComparable(content, mode)
    ? source
    : digestDuplicateContent(['invalid-comparison-content-v2', source]);
}
