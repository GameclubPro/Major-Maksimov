import type { MarketplaceStateService } from '../integrations/marketplace/marketplace-state.service';
import {
  HIGHER_PRIORITY_ACTIVITY_KEY,
  HIGHER_PRIORITY_ACTIVITY_UNAVAILABLE_KEY,
  RETENTION_PRIORITY_PERMIT_KEY,
  RETENTION_PRIORITY_RESERVATION_MARKER,
  RETENTION_PRIORITY_VERSION,
} from './retention-priority-admission';
import { ManagedEntityActivationRequiredError } from './managed-entity-activation.util';
import { restrictPassiveManagedEntityAccess } from './managed-entity-passive-access.util';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
} from '../prisma/prisma-client';
import type { MaxBotLinkService } from './max-bot-link.service';
import { maxApiMinuteCounterAddress } from './max-api-counter-storage';
import { WebhookLegacyHoldRejectedError } from '../webhook/webhook-legacy-hold.service';
import {
  isMaxMutationOutcomeAmbiguous,
  markMaxMessageSendAttempted,
} from './max-mutation-outcome.util';
import { isMaxExactMessageLookupMissingIdError } from './max-exact-message-lookup.error';
import {
  MAX_API_SOURCE_TAGS,
  MAX_SEND_AUTO_DELETE_CONFIRMATION_KINDS,
  MAX_SEND_AUTO_DELETE_MARKER_VERSION,
  MAX_SEND_AUTO_DELETE_VERIFICATION_UNKNOWN_ERROR_CODE,
  MaxApiCircuitOpenError,
  MaxApiInternalRateLimitError,
  MaxApiRequestRejectedError,
  MaxClientService,
  consumeMaxChatMemberAccessHttp429,
  consumeMaxExactMessageLookupHttp429,
  markMaxMemberMutationAttempted,
  normalizeMaxActionIdempotencyKeyPart,
  type MaxActionDispatchOptions,
  type MaxActionJob,
  wasMaxMemberMutationAttempted,
  wasMaxMemberMutationConfirmed,
  wasMaxMessageSendAttempted,
} from './max-client.service';
import { from, of, throwError } from 'rxjs';
import Redis from 'ioredis';
import { UnrecoverableError } from 'bullmq';
import {
  MAX_ACTION_BACKGROUND_QUEUE,
  MAX_ACTION_CRITICAL_QUEUE,
  MAX_ACTION_INTERACTIVE_QUEUE,
} from './max-action.queue';
import {
  MAX_API_SOURCE_DIMENSION_CATALOG_KEY,
  serializeMaxApiSourceMetricDimension,
} from './max-api-metrics-key.util';
import { MaxActionDispatchService } from './max-action-dispatch.service';
import {
  MAX_MEMBER_RESTORE_RETIRES_AT,
  MaxMemberRestoreUnavailableError,
} from './max-member-restore-capability';
import {
  MAX_FILE_UPLOAD_MAX_BYTES,
  MAX_IMAGE_UPLOAD_MAX_BYTES,
  MAX_VIDEO_UPLOAD_MAX_BYTES,
} from './max-video-upload.constants';
import {
  MAX_DELETE_PRE_DISPATCH_GUARD_REJECTED_CODE,
  MAX_EDIT_PRE_DISPATCH_GUARD_REJECTED_CODE,
  MAX_MEMBER_PRE_DISPATCH_GUARD_REJECTED_CODE,
  MAX_SEND_PRE_DISPATCH_GUARD_REJECTED_CODE,
  wasMaxPreDispatchGuardRejected,
  withMaxFinalAuthorityCheckpoint,
} from './max-action-pre-dispatch-guard';
import {
  MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES,
  MaxMediaUploadValidationError,
} from './max-media-upload-validation';
import { TINY_VALID_MP4 } from '../../test/fixtures/max-media';
import { AdminDialogLinkHelper } from '../admin/admin-dialog-link-helper';
import { readInternalChannelDialogButtonIdentity } from '../common/channel-dialog-button-identity.util';
import { PublisherStartProcessor } from '../publisher/publisher-start.processor';
import type { PublisherStartJob } from '../publisher/publisher-start.queue';
import type { Job } from 'bullmq';
import { MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES } from '../moderation/moderation.service.support';
import { ConfigService } from '@nestjs/config';
import { MaxBotRegistryService } from './max-bot-registry.service';
import { MAX_ERASER_BOT_CONTACT_ID, MAX_ERASER_BOT_ID } from './max-service-bot-identities';
import type { HttpService } from '@nestjs/axios';
import { AxiosHeaders } from 'axios';
import type { Logger } from '@nestjs/common';
import type { ActionHealthService } from '../system/action-health.service';
import type { MaxActionLedgerService } from './max-action-ledger.service';
import type { MaxModerationRuleNoticeGuardService } from './max-moderation-rule-notice.guard';
import {
  MaxSendCapacityDeferralError,
  readMaxSendCapacityDeferral,
} from './max-send-capacity-deferral';
import { ModerationStateDeleteGuardService } from '../moderation/moderation-state-delete-guard.service';
import { RequiredSubscriptionExecutionGuardService } from '../moderation/required-subscription-execution-guard.service';
import { fingerprintModerationSettings } from '../moderation/message-limits-delete-guard.service';
import { LinkHistoryDeleteGuardService } from '../moderation/link-history-delete-guard.service';
import {
  LINK_BLOCKED_DELETE_RULE_CODE,
  LINK_HISTORY_RECOVERY_RULE_CODE,
} from '../moderation/link-history-recovery.util';

const TINY_JPEG_BASE64 =
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAAAf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AJXAIf/Z';
const TINY_JPEG = Buffer.from(TINY_JPEG_BASE64, 'base64');
function createMp4Fixture(size = TINY_VALID_MP4.length, fill = 0): Buffer {
  const targetSize = Math.max(size, TINY_VALID_MP4.length);
  const paddingSize = targetSize - TINY_VALID_MP4.length;
  if (paddingSize < 8) {
    return Buffer.from(TINY_VALID_MP4);
  }
  const free = Buffer.alloc(paddingSize, fill);
  free.writeUInt32BE(paddingSize, 0);
  free.write('free', 4, 4, 'latin1');
  return Buffer.concat([TINY_VALID_MP4, free]);
}

function reservationDimensions(call: readonly unknown[]) {
  const allKeyCount = Number(call[1]);
  const metadata = String(call.at(-2));
  const count = metadata.startsWith(RETENTION_PRIORITY_RESERVATION_MARKER)
    ? (
        JSON.parse(metadata.slice(RETENTION_PRIORITY_RESERVATION_MARKER.length)) as {
          dimensions: number;
        }
      ).dimensions
    : allKeyCount;
  return {
    keyCount: count,
    keys: call.slice(2, 2 + count).map(String),
    limits: call.slice(2 + allKeyCount, 2 + allKeyCount + count),
    burstToleranceSlots: call.slice(2 + allKeyCount + count, 2 + allKeyCount + 2 * count),
  };
}

jest.mock('ioredis', () => {
  const store = new Map<string, { value: string; expiresAtMs: number | null }>();
  const setStore = new Map<string, Set<string>>();
  const readEntry = (key: string) => {
    const entry = store.get(key);
    if (!entry) {
      return null;
    }
    if (entry.expiresAtMs !== null && entry.expiresAtMs <= Date.now()) {
      store.delete(key);
      return null;
    }
    return entry;
  };
  const RedisMock = Object.assign(
    jest.fn().mockImplementation(() => {
      const instance = {
        incr: jest.fn().mockImplementation(async (key: string) => {
          const current = Number(readEntry(key)?.value ?? '0');
          const next = current + 1;
          store.set(key, {
            value: String(next),
            expiresAtMs: readEntry(key)?.expiresAtMs ?? null,
          });
          return next;
        }),
        hincrby: jest
          .fn()
          .mockImplementation(async (key: string, field: string, increment: number) => {
            const entry = readEntry(key);
            const fields = JSON.parse(entry?.value ?? '{}') as Record<string, string>;
            const next = Number(fields[field] ?? 0) + increment;
            fields[field] = String(next);
            store.set(key, {
              value: JSON.stringify(fields),
              expiresAtMs: entry?.expiresAtMs ?? null,
            });
            return next;
          }),
        hget: jest.fn().mockImplementation(async (key: string, field: string) => {
          const entry = readEntry(key);
          return entry
            ? ((JSON.parse(entry.value) as Record<string, string>)[field] ?? null)
            : null;
        }),
        expireat: jest.fn().mockImplementation(async (key: string, expiresAtSec: number) => {
          const entry = readEntry(key);
          if (!entry) return 0;
          store.set(key, { ...entry, expiresAtMs: expiresAtSec * 1_000 });
          return 1;
        }),
        expire: jest.fn().mockImplementation(async (key: string, ttlSec: number) => {
          const entry = readEntry(key);
          if (!entry) {
            return 0;
          }
          store.set(key, {
            ...entry,
            expiresAtMs: Date.now() + ttlSec * 1_000,
          });
          return 1;
        }),
        pexpire: jest.fn().mockImplementation(async (key: string, ttlMs: number) => {
          const entry = readEntry(key);
          if (!entry) {
            return 0;
          }
          store.set(key, {
            ...entry,
            expiresAtMs: Date.now() + ttlMs,
          });
          return 1;
        }),
        pttl: jest.fn().mockImplementation(async (key: string) => {
          const entry = readEntry(key);
          if (!entry) {
            return -2;
          }
          if (entry.expiresAtMs === null) {
            return -1;
          }
          return Math.max(0, entry.expiresAtMs - Date.now());
        }),
        get: jest.fn().mockImplementation(async (key: string) => readEntry(key)?.value ?? null),
        set: jest
          .fn()
          .mockImplementation(async (key: string, value: string, ...args: unknown[]) => {
            let expiresAtMs: number | null = null;
            if (args[0] === 'EX' && typeof args[1] === 'number' && Number.isFinite(args[1])) {
              expiresAtMs = Date.now() + args[1] * 1_000;
            }
            if (args[0] === 'PX' && typeof args[1] === 'number' && Number.isFinite(args[1])) {
              expiresAtMs = Date.now() + args[1];
            }
            store.set(key, {
              value,
              expiresAtMs,
            });
            return 'OK';
          }),
        zrem: jest.fn().mockImplementation(async (key: string, id: string) => {
          const entry = readEntry(key);
          const leases = JSON.parse(entry?.value ?? '{}') as Record<string, number>;
          if (!(id in leases)) return 0;
          delete leases[id];
          store.set(key, { value: JSON.stringify(leases), expiresAtMs: null });
          return 1;
        }),
        del: jest.fn().mockImplementation(async (...keys: string[]) => {
          let deleted = 0;
          for (const key of keys) {
            if (store.delete(key)) {
              deleted += 1;
            }
          }
          return deleted;
        }),
        sadd: jest.fn().mockImplementation(async (key: string, ...members: string[]) => {
          const values = setStore.get(key) ?? new Set<string>();
          let added = 0;
          for (const member of members) {
            if (!values.has(member)) {
              values.add(member);
              added += 1;
            }
          }
          setStore.set(key, values);
          return added;
        }),
        smembers: jest
          .fn()
          .mockImplementation(async (key: string) => [...(setStore.get(key) ?? new Set<string>())]),
        eval: jest
          .fn()
          .mockImplementation(
            async (script: string, numKeys: number, ...args: Array<string | number>) => {
              const keys = args.slice(0, numKeys).map((value) => String(value));
              const argValues = args.slice(numKeys);

              if (script.includes('MAX_API_GCRA_RESERVE_V1')) {
                const nowMs = Date.now();
                const metadata = String(argValues.at(-2) ?? '');
                const marker = 'retention-priority:v1:';
                const priority = metadata.startsWith(marker)
                  ? (JSON.parse(metadata.slice(marker.length)) as {
                      dimensions: number;
                      retention: boolean;
                      operationId: string;
                    })
                  : null;
                const dimensionCount = priority?.dimensions ?? numKeys;
                if (priority?.retention) {
                  if (readEntry(keys[dimensionCount + 2]))
                    return [0, -1, 1000, 'metrics_unavailable'];
                  const leases = JSON.parse(
                    readEntry(keys[dimensionCount + 1])?.value ?? '{}',
                  ) as Record<string, number>;
                  if (Object.keys(leases).length) return [0, -1, 1000, 'higher_priority_active'];
                  const entry = readEntry(keys[dimensionCount]);
                  if (!entry) return [0, -1, 1000, 'permit_missing'];
                  const permit = JSON.parse(entry.value) as Record<string, string>;
                  if (
                    permit.version !== '1' ||
                    Number(permit.sampleStartedAtMs) > nowMs ||
                    nowMs - Number(permit.sampleStartedAtMs) > 2000 ||
                    Number(permit.validUntilMs) <= nowMs ||
                    entry.expiresAtMs === null ||
                    entry.expiresAtMs - nowMs > 1000
                  )
                    return [0, -1, 1000, 'permit_expired'];
                }
                const windowKey = `${keys[0]}:window:v1`;
                const window = (JSON.parse(readEntry(windowKey)?.value ?? '[]') as number[]).filter(
                  (at) => at > nowMs - 1_000,
                );
                if (window.length >= Number(argValues[0]))
                  return [0, 1, Math.max(1, window[0]! + 1_000 - nowMs)];
                const ttlFloorMs = Number(argValues[argValues.length - 1] ?? 0);
                const updates: Array<{ key: string; tat: number; ttlMs: number }> = [];
                for (let index = 0; index < dimensionCount; index += 1) {
                  const limit = Number(argValues[index] ?? 0);
                  const intervalMs = 1_000 / limit;
                  const burstToleranceSlots = Number(argValues[dimensionCount + index] ?? 0);
                  const burstToleranceMs = burstToleranceSlots * intervalMs;
                  const storedTat = Number(readEntry(keys[index])?.value ?? nowMs);
                  const tat = Math.max(storedTat, nowMs);
                  const allowAtMs = tat - burstToleranceMs;
                  if (nowMs < allowAtMs) {
                    return [0, index + 1, Math.max(1, Math.ceil(allowAtMs - nowMs))];
                  }
                  const nextTat = tat + intervalMs;
                  updates.push({
                    key: keys[index],
                    tat: nextTat,
                    ttlMs: Math.max(
                      ttlFloorMs,
                      Math.ceil(nextTat - nowMs + burstToleranceMs + intervalMs),
                    ),
                  });
                }

                for (const update of updates) {
                  store.set(update.key, {
                    value: String(update.tat),
                    expiresAtMs: nowMs + update.ttlMs,
                  });
                }
                store.set(windowKey, {
                  value: JSON.stringify([...window, nowMs]),
                  expiresAtMs: nowMs + 1_000,
                });
                if (priority && !priority.retention) {
                  const activityKey = keys[dimensionCount + 1];
                  const leases = JSON.parse(readEntry(activityKey)?.value ?? '{}') as Record<
                    string,
                    number
                  >;
                  leases[priority.operationId] = nowMs + 30_000;
                  store.set(activityKey, { value: JSON.stringify(leases), expiresAtMs: null });
                }
                return [1, 0, 0];
              }

              if (script.includes('MAX_HIGHER_PRIORITY_ACTIVITY_RENEW_V1')) {
                const leases = JSON.parse(readEntry(keys[0])?.value ?? '{}') as Record<
                  string,
                  number
                >;
                const id = String(argValues[0]);
                if ((leases[id] ?? 0) <= Date.now()) {
                  store.set(keys[1], { value: 'activity_coverage_lost', expiresAtMs: null });
                  return 0;
                }
                leases[id] = Date.now() + Number(argValues[1]);
                store.set(keys[0], { value: JSON.stringify(leases), expiresAtMs: null });
                return 1;
              }

              const readFailures = (key: string, cutoffMs: number) =>
                (readEntry(key)?.value ?? '')
                  .split(',')
                  .map((value) => Number(value))
                  .filter((value) => Number.isFinite(value) && value >= cutoffMs);

              if (script.includes('MAX_API_CIRCUIT_ACQUIRE_V1')) {
                const nowMs = Date.now();
                const threshold = Number(argValues[0]);
                const windowMs = Number(argValues[1]);
                const openMs = Number(argValues[2]);
                const probeTtlMs = Number(argValues[3]);
                const stateTtlMs = Number(argValues[4]);
                const probeToken = String(argValues[5]);
                const openUntilMs = Number(readEntry(keys[1])?.value ?? 0);
                if (openUntilMs > nowMs) {
                  return [0, 0, Math.max(1, Math.ceil(openUntilMs - nowMs))];
                }

                const failures = readFailures(keys[0], nowMs - windowMs);
                if (failures.length > 0) {
                  store.set(keys[0], {
                    value: failures.join(','),
                    expiresAtMs: nowMs + stateTtlMs,
                  });
                } else {
                  store.delete(keys[0]);
                }

                if (openUntilMs > 0) {
                  const activeProbe = readEntry(keys[2]);
                  if (!activeProbe) {
                    store.set(keys[2], {
                      value: probeToken,
                      expiresAtMs: nowMs + probeTtlMs,
                    });
                    return [1, 1, 0];
                  }
                  return [
                    0,
                    0,
                    Math.max(1, (activeProbe.expiresAtMs ?? nowMs + probeTtlMs) - nowMs),
                  ];
                }

                if (failures.length >= threshold) {
                  store.set(keys[1], {
                    value: String(nowMs + openMs),
                    expiresAtMs: nowMs + stateTtlMs,
                  });
                  store.delete(keys[2]);
                  return [0, 0, openMs];
                }

                return [1, 0, 0];
              }

              if (script.includes('MAX_API_CIRCUIT_FAILURE_V1')) {
                const nowMs = Date.now();
                const threshold = Number(argValues[0]);
                const windowMs = Number(argValues[1]);
                const openMs = Number(argValues[2]);
                const stateTtlMs = Number(argValues[3]);
                const forceOpen = Number(argValues[4]) === 1;
                const failures = readFailures(keys[0], nowMs - windowMs);
                failures.push(nowMs);
                store.set(keys[0], {
                  value: failures.join(','),
                  expiresAtMs: nowMs + stateTtlMs,
                });
                let openUntilMs = Number(readEntry(keys[1])?.value ?? 0);
                if (forceOpen || failures.length >= threshold) {
                  openUntilMs = nowMs + openMs;
                  store.set(keys[1], {
                    value: String(openUntilMs),
                    expiresAtMs: nowMs + stateTtlMs,
                  });
                  store.delete(keys[2]);
                }
                return [failures.length, openUntilMs];
              }

              if (script.includes('MAX_API_CIRCUIT_CLOSE_V1')) {
                if (readEntry(keys[2])?.value === String(argValues[0])) {
                  keys.forEach((key) => store.delete(key));
                  return 1;
                }
                return 0;
              }

              if (script.includes('MAX_API_CIRCUIT_RELEASE_PROBE_V1')) {
                if (readEntry(keys[0])?.value === String(argValues[0])) {
                  store.delete(keys[0]);
                  return 1;
                }
                return 0;
              }

              if (script.includes('MAX_MESSAGE_EDIT_LOCK_ACQUIRE_V1')) {
                const activeLock = readEntry(keys[0]);
                const ttlMs = Number(argValues[1]);
                if (!activeLock) {
                  store.set(keys[0], {
                    value: String(argValues[0]),
                    expiresAtMs: Date.now() + ttlMs,
                  });
                  return [1, ttlMs];
                }
                return [
                  0,
                  Math.max(1, (activeLock.expiresAtMs ?? Date.now() + ttlMs) - Date.now()),
                ];
              }

              if (script.includes('MAX_MESSAGE_EDIT_LOCK_RENEW_V1')) {
                const activeLock = readEntry(keys[0]);
                if (activeLock?.value === String(argValues[0])) {
                  activeLock.expiresAtMs = Date.now() + Number(argValues[1]);
                  return 1;
                }
                return 0;
              }

              if (script.includes('MAX_MESSAGE_EDIT_LOCK_RELEASE_V1')) {
                if (readEntry(keys[0])?.value === String(argValues[0])) {
                  store.delete(keys[0]);
                  return 1;
                }
                return 0;
              }

              throw new Error('Unexpected Redis eval script');
            },
          ),
        quit: jest.fn().mockResolvedValue(undefined),
        multi: jest.fn().mockImplementation(() => {
          const operations: Array<
            ['incr' | 'expire' | 'sadd' | 'hincrby' | 'expireat', ...unknown[]]
          > = [];
          const pipeline = {
            sadd: (key: string, ...members: string[]) => {
              operations.push(['sadd', key, ...members]);
              return pipeline;
            },
            incr: (key: string) => {
              operations.push(['incr', key]);
              return pipeline;
            },
            hincrby: (key: string, field: string, increment: number) => {
              operations.push(['hincrby', key, field, increment]);
              return pipeline;
            },
            expireat: (key: string, expiresAtSec: number) => {
              operations.push(['expireat', key, expiresAtSec]);
              return pipeline;
            },
            expire: (key: string, ttlSec: number) => {
              operations.push(['expire', key, ttlSec]);
              return pipeline;
            },
            exec: jest.fn().mockImplementation(async () => {
              const results: Array<[null, unknown]> = [];
              for (const [method, ...args] of operations) {
                results.push([
                  null,
                  await (instance[method] as (...values: unknown[]) => Promise<unknown>)(...args),
                ]);
              }
              return results;
            }),
          };
          return pipeline;
        }),
      };

      return instance;
    }),
    {
      __store: store,
    },
  );

  return {
    __esModule: true,
    default: RedisMock,
  };
});

describe('MAX action idempotency key normalization', () => {
  function referenceNormalize(value: string): string {
    const normalized: string[] = [];
    for (const character of value.trim().toLowerCase()) {
      const code = character.charCodeAt(0);
      const allowed =
        (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || character === '-';
      if (allowed) {
        normalized.push(character);
      } else if (normalized.at(-1) !== '_') {
        normalized.push('_');
      }
    }
    while (normalized[0] === '_') {
      normalized.shift();
    }
    while (normalized.at(-1) === '_') {
      normalized.pop();
    }
    return normalized.join('').slice(0, 48);
  }

  it('preserves readable-key semantics across separator and Unicode inputs', () => {
    const alphabet = ['a', 'Z', '0', '_', '-', ' ', '!', 'e', '\u0130', '\ud83d\ude00', '\n'];
    const corpus = [
      '',
      '___',
      '  Moderation:Notice:Chat-1:User_1  ',
      '__a_--_b__',
      '#-leading',
      'trailing-#',
      'RUS:\u041f\u0440\u0438\u0432\u0435\u0442',
      'emoji:\ud83d\ude00\ud83d\ude80:done',
      'A'.repeat(80),
    ];
    let frontier = [''];
    for (let length = 0; length < 4; length += 1) {
      frontier = frontier.flatMap((prefix) => alphabet.map((character) => prefix + character));
      corpus.push(...frontier);
    }

    for (const value of corpus) {
      expect(normalizeMaxActionIdempotencyKeyPart(value)).toBe(referenceNormalize(value));
    }
  });

  it('handles a long adversarial separator run in one pass', () => {
    const value = `${'!_'.repeat(250_000)}Action-1${'_!'.repeat(250_000)}`;
    expect(normalizeMaxActionIdempotencyKeyPart(value)).toBe('action-1');
  });
});

describe('MaxClientService inline keyboard guardrails', () => {
  it.each(['edit', 'copy', 'comment_refresh'] as const)(
    'keeps one old suggestion entry with media and advertising during %s',
    async (operation) => {
      const links = (publisher: boolean) =>
        new AdminDialogLinkHelper({
          appBaseUrl: null,
          explicitBotContactId: null,
          ownBotUserId: publisher ? 'publik-bot' : 'major-bot',
          maxBotToken: 'test',
          maxBotTokenValidationSecrets: ['test'],
          ...(publisher ? { dialogProfile: 'publisher' } : {}),
        });
      const major = links(false);
      const publisher = links(true);
      const old = major.buildChannelDialogButton(
        'channel-1',
        'suggest',
        '11111111-1111-4111-8111-111111111111',
        'Suggest',
        'major-bot',
        'BOT',
      );
      const duplicate = publisher.buildChannelDialogButton(
        'channel-1',
        'suggest',
        'publisher-thread',
        'Suggest',
        'publik-bot',
        'MINIAPP',
      );
      const comment = publisher.buildChannelDialogButton(
        'channel-1',
        'comments',
        'publisher-thread',
        'Comments',
        'publik-bot',
        'MINIAPP',
      );
      const ad = { type: 'link', text: 'Advertise', url: 'https://example.com/ads' };
      const media = { type: 'image', payload: { token: 'image-token' } };
      let message = {
        body: {
          mid: 'post-1',
          text: 'Post',
          attachments: [
            media,
            { type: 'inline_keyboard', payload: { buttons: [[old], [ad], [duplicate]] } },
          ],
        },
      };
      const mutations: Record<string, unknown>[] = [];
      const http = {
        request: jest
          .fn()
          .mockImplementation((request: { method: string; data: Record<string, unknown> }) => {
            if (request.method === 'get') return of({ status: 200, data: { messages: [message] } });
            mutations.push(request.data);
            message = {
              body: {
                ...message.body,
                attachments: request.data.attachments as typeof message.body.attachments,
              },
            };
            return of({ status: 200, data: { success: true, message: { body: { mid: 'copy' } } } });
          }),
      };
      const service = createService(http);
      const options = {
        buttons: operation === 'comment_refresh' ? [[comment]] : [[comment], [duplicate]],
        mergeExistingInlineKeyboard: true,
        appendNewInlineKeyboardRows: true,
        requireAllAttachmentsPreserved: true,
      };
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          if (operation !== 'copy')
            await service.editMessageInlineKeyboard('channel-1', 'post-1', null, options);
          else
            await service.sendMessageCopyWithInlineKeyboard('channel-1', 'post-1', 'Post', options);
        }
        for (const mutation of mutations) {
          const attachments = mutation.attachments as Array<{
            type: string;
            payload: { buttons?: unknown[][] };
          }>;
          expect(attachments).toContainEqual(media);
          const buttons = attachments
            .find((a) => a.type === 'inline_keyboard')!
            .payload.buttons!.flat();
          expect(buttons).toContainEqual(old);
          expect(buttons).toContainEqual(ad);
          expect(buttons).toContainEqual(comment);
          expect(
            buttons.filter(
              (button) => readInternalChannelDialogButtonIdentity(button)?.kind === 'suggest',
            ),
          ).toHaveLength(1);
        }
      } finally {
        await service.onModuleDestroy();
      }
    },
  );

  it('does not append a Major suggestion when Publisher already attached one to a manual post', async () => {
    const helper = (publisher: boolean) =>
      new AdminDialogLinkHelper({
        appBaseUrl: null,
        explicitBotContactId: null,
        ownBotUserId: publisher ? 'publik' : 'major',
        maxBotToken: 'test',
        maxBotTokenValidationSecrets: ['test'],
        ...(publisher ? { dialogProfile: 'publisher' } : {}),
      });
    const publisher = helper(true).buildChannelDialogButton(
      'channel-1',
      'suggest',
      'shared-thread',
      'Suggest',
      'publik',
      'MINIAPP',
    );
    const major = helper(false).buildChannelDialogButton(
      'channel-1',
      'suggest',
      'shared-thread',
      'Suggest',
      'major',
      'MINIAPP',
    );
    const http = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'manual',
                    text: 'Post',
                    attachments: [{ type: 'inline_keyboard', payload: { buttons: [[publisher]] } }],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(of({ status: 200, data: { success: true } })),
    };
    const service = createService(http);
    try {
      await service.editMessageInlineKeyboard('channel-1', 'manual', null, {
        buttons: [[major]],
        mergeExistingInlineKeyboard: true,
        requireAllAttachmentsPreserved: true,
      });
      expect(http.request.mock.calls[1]![0].data.attachments).toEqual([
        { type: 'inline_keyboard', payload: { buttons: [[publisher]] } },
      ]);
    } finally {
      await service.onModuleDestroy();
    }
  });
  it.each([true, false])(
    'keeps the first comments entry when Publisher arrives first: %s',
    async (publisherFirst) => {
      const buildButton = (publisher: boolean) => {
        const token = `cdt-${Buffer.from(JSON.stringify({ v: 1, d: publisher ? 'publisher-thread' : 'major-thread', s: 'a'.repeat(64) })).toString('base64url')}`;
        const payload = {
          v: 1,
          k: 'channel-dialog',
          c: 'channel-1',
          m: 'comments',
          t: token,
          ...(publisher ? { p: 'publisher' } : {}),
        };
        return {
          type: 'link' as const,
          text: publisher ? 'Publisher comments' : 'Major comments',
          url: `https://max.ru/${publisher ? 'publik' : 'major'}?startapp=cd-${Buffer.from(JSON.stringify(payload)).toString('base64url')}`,
        };
      };
      const major = buildButton(false);
      const publisher = buildButton(true);
      const existing = publisherFirst ? publisher : major;
      const incoming = publisherFirst ? major : publisher;
      const media = { type: 'image', payload: { token: 'image-token' } };
      const message = {
        body: {
          mid: 'locked-post',
          text: 'Original',
          attachments: [media, { type: 'inline_keyboard', payload: { buttons: [[existing]] } }],
        },
      };
      const httpService = {
        request: jest
          .fn()
          .mockReturnValueOnce(of({ status: 200, data: { messages: [message] } }))
          .mockReturnValueOnce(of({ status: 200, data: { success: true } })),
      };
      const service = createService(httpService);
      const prepareInlineKeyboard = jest.fn().mockResolvedValue([[incoming]]);
      await service.editMessageInlineKeyboard('channel-1', 'locked-post', null, {
        prepareInlineKeyboard,
        mergeExistingInlineKeyboard: true,
        appendNewInlineKeyboardRows: true,
        requireAllAttachmentsPreserved: true,
      });
      expect(prepareInlineKeyboard).toHaveBeenCalledWith(message);
      expect(httpService.request).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          method: 'put',
          data: {
            attachments: [media, { type: 'inline_keyboard', payload: { buttons: [[existing]] } }],
          },
        }),
      );
      await service.onModuleDestroy();
    },
  );

  it.each([true, false])(
    'keeps three actions through mirrored edits and counter refreshes (Publisher first: %s)',
    async (publisherFirst) => {
      const build = (publisher: boolean, kind: 'comments' | 'suggest', text: string) =>
        new AdminDialogLinkHelper({
          appBaseUrl: null,
          explicitBotContactId: null,
          ownBotUserId: publisher ? 'publik' : 'major',
          maxBotToken: 'test',
          maxBotTokenValidationSecrets: ['test'],
          ...(publisher ? { dialogProfile: 'publisher' } : {}),
        }).buildChannelDialogButton(
          'channel-1',
          kind,
          publisher ? 'publisher-thread' : 'major-thread',
          text,
          publisher ? 'publik' : 'major',
          'MINIAPP',
        );
      const media = { type: 'image', payload: { token: 'image-token' } };
      const reviews = {
        type: 'link' as const,
        text: 'Отзывы',
        url: 'https://example.test/reviews',
      };
      const winner = build(publisherFirst, 'comments', 'Комментарии');
      const contact = build(publisherFirst, 'suggest', 'Задать вопрос или приобрести');
      let attachments: unknown[] = [media];
      const request = jest.fn((config: { method: string; data?: { attachments: unknown[] } }) => {
        if (config.method === 'get')
          return of({
            status: 200,
            data: {
              messages: [
                {
                  body: { mid: 'three-actions', text: 'Original', attachments },
                },
              ],
            },
          });
        attachments = config.data!.attachments;
        return of({ status: 200, data: { success: true } });
      });
      const service = createService({ request });
      const options = { mergeExistingInlineKeyboard: true, requireAllAttachmentsPreserved: true };
      try {
        await service.editMessageInlineKeyboard('channel-1', 'three-actions', null, {
          ...options,
          buttons: [[winner], [contact], [reviews]],
        });
        for (let repeat = 0; repeat < 2; repeat++) {
          await service.editMessageInlineKeyboard('channel-1', 'three-actions', null, {
            ...options,
            buttons: [
              [build(!publisherFirst, 'comments', 'Комментарии')],
              [build(!publisherFirst, 'suggest', 'Предложить пост')],
              [reviews],
            ],
          });
        }
        const updatedWinner = { ...winner, text: 'Комментарии (5)' };
        await service.editMessageInlineKeyboard('channel-1', 'three-actions', null, {
          buttons: [[updatedWinner]],
          mergeExistingInlineKeyboard: true,
        });
        await service.editMessageInlineKeyboard('channel-1', 'three-actions', null, {
          buttons: [[build(!publisherFirst, 'comments', 'Комментарии (2)')]],
          mergeExistingInlineKeyboard: true,
        });
        expect(attachments).toEqual([
          media,
          {
            type: 'inline_keyboard',
            payload: { buttons: [[updatedWinner], [contact], [reviews]] },
          },
        ]);
        for (const [config] of request.mock.calls) {
          if (config.method === 'put') expect(config.data).not.toHaveProperty('text');
        }
      } finally {
        await service.onModuleDestroy();
      }
    },
  );

  it.each([true, false])(
    'preserves live channel actions across a rejected decoration and retry (same profile: %s)',
    async (sameProfile) => {
      const build = (publisher: boolean, kind: 'comments' | 'suggest', text: string) =>
        new AdminDialogLinkHelper({
          appBaseUrl: null,
          explicitBotContactId: null,
          ownBotUserId: publisher ? 'publik' : 'major',
          maxBotToken: 'test',
          maxBotTokenValidationSecrets: ['test'],
          ...(publisher ? { dialogProfile: 'publisher' } : {}),
        }).buildChannelDialogButton(
          'channel-1',
          kind,
          'retained-thread',
          text,
          publisher ? 'publik' : 'major',
          'MINIAPP',
        );
      const comments = build(!sameProfile, 'comments', 'Comments (7)');
      const contact = build(!sameProfile, 'suggest', 'Contact');
      const reviews = { type: 'link', text: 'Reviews', url: 'https://example.test/reviews' };
      const photo = { type: 'image', payload: { token: 'photo-token' } };
      const callback = { type: 'callback', text: 'Vote', payload: 'vote:existing' };
      let attachments: unknown[] = [
        photo,
        { type: 'inline_keyboard', payload: { buttons: [[comments], [contact], [reviews]] } },
      ];
      let attempts = 0;
      const http = {
        request: jest.fn((config: { method: string; data?: { attachments: unknown[] } }) => {
          if (config.method === 'get') {
            return of({
              status: 200,
              data: {
                messages: [{ body: { mid: 'preserved-retry', text: 'Original', attachments } }],
              },
            });
          }
          if (attempts++ === 0) {
            // Another writer's button must also survive the fresh locked read on retry.
            attachments = [
              photo,
              {
                type: 'inline_keyboard',
                payload: { buttons: [[comments], [contact], [reviews], [callback]] },
              },
            ];
            return of({ status: 200, data: { success: false } });
          }
          attachments = config.data!.attachments;
          return of({ status: 200, data: { success: true } });
        }),
      };
      const service = createService(http);
      const options = {
        buttons: [[build(false, 'comments', 'Comments (0)')], [build(false, 'suggest', 'Suggest')]],
        mergeExistingInlineKeyboard: true,
        preserveExistingChannelDialogButtons: true,
        requireAllAttachmentsPreserved: true,
      };
      try {
        await expect(
          service.editMessageInlineKeyboard('channel-1', 'preserved-retry', null, options),
        ).rejects.toThrow();
        await service.editMessageInlineKeyboard('channel-1', 'preserved-retry', null, {
          ...options,
          appendNewInlineKeyboardRows: true,
        });
        expect(attempts).toBe(2);
        expect(attachments).toEqual([
          photo,
          {
            type: 'inline_keyboard',
            payload: { buttons: [[reviews], [callback], [comments], [contact]] },
          },
        ]);
        for (const [config] of http.request.mock.calls) {
          if (config.method === 'put') expect(config.data).not.toHaveProperty('text');
        }
      } finally {
        await service.onModuleDestroy();
      }
    },
  );

  it('skips the MAX mutation when locked keyboard preparation finds no missing buttons', async () => {
    const httpService = {
      request: jest.fn().mockReturnValue(
        of({
          status: 200,
          data: { messages: [{ body: { mid: 'already-decorated', attachments: [] } }] },
        }),
      ),
    };
    const service = createService(httpService);
    const beforeEditMutation = jest.fn();
    await service.editMessageInlineKeyboard('channel-1', 'already-decorated', null, {
      prepareInlineKeyboard: async () => null,
      beforeEditMutation,
    });
    expect(httpService.request).toHaveBeenCalledTimes(1);
    expect(beforeEditMutation).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });
  it('brands a frozen member-mutation error without replacing it', () => {
    const frozenError = Object.freeze(
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    );

    expect(markMaxMemberMutationAttempted(frozenError)).toBe(frozenError);
    expect(wasMaxMemberMutationAttempted(frozenError)).toBe(true);
  });

  beforeEach(() => {
    (
      Redis as unknown as { __store: Map<string, { value: string; expiresAtMs: number | null }> }
    ).__store.clear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('replaces own published rules only after exact author and operation guards', async () => {
    const request = jest.fn().mockReturnValue(of({ status: 200, data: { success: true } }));
    const service = createService({ request });
    jest.spyOn(service, 'getCurrentChatMemberAccess').mockResolvedValue({
      userId: '777000',
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
    });
    const exact = jest.spyOn(service, 'getExactMessageRow').mockResolvedValue({
      body: { mid: 'rules-current' },
      sender: { user_id: 777000, is_bot: true },
      recipient: { chat_id: 'chat-1' },
    });
    const beforeMutation = jest.fn();
    try {
      await service.replaceOwnMessage(
        'chat-1',
        'rules-current',
        'New rules',
        { textFormat: 'html', imagePayload: { token: 'new-image' } },
        { botId: '777000_bot', sourceTag: MAX_API_SOURCE_TAGS.CHAT_RULES },
        beforeMutation,
      );
      expect(exact).toHaveBeenCalledWith(
        'chat-1',
        'rules-current',
        expect.objectContaining({ botId: '777000_bot', bypassCache: true }),
      );
      expect(beforeMutation).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'put',
          url: 'https://platform-api2.max.ru/messages',
          params: { message_id: 'rules-current' },
          data: {
            text: 'New rules',
            format: 'html',
            attachments: [{ type: 'image', payload: { token: 'new-image' } }],
            notify: false,
          },
        }),
      );
    } finally {
      await service.onModuleDestroy();
    }
  });

  it.each([
    { sender: { user_id: 123, is_bot: true } },
    { sender: { user_id: 777000, is_bot: false } },
    null,
  ])('never replaces foreign or unverifiable rules content: %o', async (message) => {
    const request = jest.fn();
    const service = createService({ request });
    jest.spyOn(service, 'getCurrentChatMemberAccess').mockResolvedValue({
      userId: '777000',
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
    });
    jest.spyOn(service, 'getExactMessageRow').mockResolvedValue(message);
    try {
      await expect(
        service.replaceOwnMessage(
          'chat-1',
          'rules-current',
          'New rules',
          undefined,
          { botId: '777000_bot' },
          async () => {},
        ),
      ).rejects.toThrow('автора');
      expect(request).not.toHaveBeenCalled();
    } finally {
      await service.onModuleDestroy();
    }
  });

  it.each(['access', 'target', 'operation'])(
    'does not dispatch a rules edit when the %s guard rejects it',
    async (failure) => {
      const request = jest.fn();
      const service = createService({ request });
      jest.spyOn(service, 'getCurrentChatMemberAccess').mockResolvedValue({
        userId: '777000',
        isAdmin: failure !== 'access',
        isOwner: false,
        permissions: ['write'],
      });
      const exact = jest.spyOn(service, 'getExactMessageRow').mockResolvedValue({
        sender: { user_id: 777000, is_bot: true },
      });
      if (failure === 'target') exact.mockRejectedValue(new Error('Exact message target mismatch'));
      try {
        await expect(
          service.replaceOwnMessage(
            'chat-1',
            'rules-current',
            'New rules',
            undefined,
            { botId: '777000_bot' },
            async () => {
              throw new Error('Operation ownership changed');
            },
          ),
        ).rejects.toThrow();
        expect(request).not.toHaveBeenCalled();
      } finally {
        await service.onModuleDestroy();
      }
    },
  );

  it('requires a documented successful edit response and supports removing old attachments', async () => {
    const request = jest.fn().mockReturnValue(of({ status: 200, data: { success: false } }));
    const service = createService({ request });
    jest.spyOn(service, 'getCurrentChatMemberAccess').mockResolvedValue({
      userId: '777000',
      isAdmin: true,
      isOwner: false,
      permissions: ['write'],
    });
    jest
      .spyOn(service, 'getExactMessageRow')
      .mockResolvedValue({ sender: { user_id: 777000, is_bot: true } });
    try {
      await expect(
        service.replaceOwnMessage(
          'chat-1',
          'rules-current',
          'New rules',
          undefined,
          { botId: '777000_bot' },
          async () => {},
        ),
      ).rejects.toThrow('success=false');
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({ data: { text: 'New rules', attachments: [], notify: false } }),
      );
    } finally {
      await service.onModuleDestroy();
    }
  });

  describe('immediate executor capability boundary', () => {
    it.each(['plain', 'custom', 'private'] as const)(
      'marks actual %s send failures as attempted without trusting access-denial text',
      async (kind) => {
        const failure = Object.assign(new Error('network socket closed: access denied'), {
          code: 'ECONNRESET',
        });
        const request = jest.fn().mockReturnValue(throwError(() => failure));
        const service = createService({ request });
        try {
          const sending =
            kind === 'plain'
              ? service.sendMessageImmediateWithId('-123', 'text')
              : kind === 'custom'
                ? service.sendCustomMessageImmediate('-123', { text: 'text' })
                : service.sendMessageImmediateToUser('human', 'text');
          const error = await sending.catch((caught: unknown) => caught);
          expect(error).toBe(failure);
          expect(wasMaxMessageSendAttempted(error)).toBe(true);
          expect(isMaxMutationOutcomeAmbiguous(error, true)).toBe(true);
          expect(request).toHaveBeenCalledTimes(1);
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it('does not mark a raw feature permit rejection as an attempted send', async () => {
      const failure = new Error('feature permit rejected');
      const request = jest.fn();
      const service = createService({ request });
      try {
        const error = await service
          .sendMessageImmediateWithId('-123', 'text', {
            beforeSend: async () => {
              throw failure;
            },
          })
          .catch((caught: unknown) => caught);
        expect(error).toBe(failure);
        expect(wasMaxMessageSendAttempted(error)).toBe(false);
        expect(request).not.toHaveBeenCalled();
      } finally {
        await service.onModuleDestroy();
      }
    });

    it.each(['SEND_MESSAGE', 'DELETE_MESSAGE', 'BAN_MEMBER', 'KICK_MEMBER'] as const)(
      'reserves exactly one quota for %s after proof preparation and before the final permit',
      async (actionType) => {
        const order: string[] = [];
        const request = jest.fn(() => {
          order.push('http');
          return of({ status: 200, data: { success: true, mid: 'sent' } });
        });
        const service = createService({ request }, { MAX_API_GLOBAL_BURST: '0' });
        const proof = {
          botId: '777000_bot',
          routingVersion: 2,
          accessEpoch: { checkedAt: new Date(), source: 'test' },
          changed: false,
        };
        const verify = jest.fn(async () => {
          order.push('epoch');
          return true;
        });
        Object.defineProperty(service, 'maxBotLinkService', {
          value: {
            getFreshChatBotExecutionProof: jest.fn(async () => {
              order.push('proof');
              return proof;
            }),
            verifyChatExecutionProof: verify,
          },
        });
        const reserve = jest
          .spyOn(service as any, 'reserveRateLimitSlot')
          .mockImplementation(async () => {
            order.push('quota');
          });
        const permit = async () => {
          order.push('permit');
        };
        try {
          await service.executeActionJob(
            {
              actionType,
              chatId: '-123',
              messageId: 'message',
              userId: 'human',
              text: 'text',
              botId: '777000_bot',
              attempt: 1,
              idempotencyKey: `quota-${actionType}`,
              createdAt: new Date().toISOString(),
            },
            {
              beforeSendMutation: permit,
              beforeDeleteMutation: permit,
              beforeMemberMutation: permit,
            },
          );
          expect(order).toEqual(['proof', 'quota', 'epoch', 'permit', 'http']);
          expect(reserve).toHaveBeenCalledTimes(1);
          expect(verify).toHaveBeenCalledWith(
            expect.objectContaining({
              maxAgeMs: actionType === 'SEND_MESSAGE' ? 15 * 60_000 : 5 * 60_000,
            }),
          );
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it.each(['BAN_MEMBER', 'KICK_MEMBER'] as const)(
      'blocks %s when the executor loses authority during final feature qualification',
      async (actionType) => {
        const order: string[] = [];
        const request = jest.fn();
        const service = createService({ request });
        let currentEpoch = true;
        const proof = {
          botId: '777000_bot',
          routingVersion: 2,
          accessEpoch: { checkedAt: new Date(), source: 'test' },
          changed: false,
        };
        const verify = jest.fn(async () => {
          order.push('epoch');
          return currentEpoch;
        });
        Object.defineProperty(service, 'maxBotLinkService', {
          value: {
            getFreshChatBotExecutionProof: jest.fn(async () => proof),
            verifyChatExecutionProof: verify,
          },
        });
        const reserve = jest
          .spyOn(service as any, 'reserveRateLimitSlot')
          .mockImplementation(async () => {
            order.push('quota');
          });
        const finalPermit = jest.fn();
        try {
          const error = await service
            .executeActionJob(
              {
                actionType,
                chatId: '-123',
                userId: 'human',
                botId: '777000_bot',
                attempt: 1,
                idempotencyKey: `demoted-during-qualification-${actionType}`,
                createdAt: new Date().toISOString(),
              },
              {
                beforeMemberMutation: async (revalidateRoute) => {
                  order.push('author-read');
                  await Promise.resolve();
                  currentEpoch = false;
                  await revalidateRoute?.();
                  finalPermit();
                },
              },
            )
            .catch((caught: unknown) => caught);
          expect(error).toMatchObject({ code: 'max_action_executor_proof_rejected' });
          expect(wasMaxPreDispatchGuardRejected(error)).toBe(true);
          expect(wasMaxMemberMutationAttempted(error)).toBe(false);
          expect(order).toEqual(['quota', 'epoch', 'author-read', 'epoch']);
          expect(reserve).toHaveBeenCalledTimes(1);
          expect(verify).toHaveBeenCalledTimes(2);
          expect(finalPermit).not.toHaveBeenCalled();
          expect(request).not.toHaveBeenCalled();
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it.each(['SEND_MESSAGE', 'BAN_MEMBER', 'KICK_MEMBER'] as const)(
      'vetoes an expired %s feature permit after quota waiting',
      async (actionType) => {
        const request = jest.fn();
        const service = createService({ request });
        const deadlineAtMs = Date.now() + 1000;
        const now = jest.spyOn(Date, 'now').mockReturnValue(deadlineAtMs - 1);
        jest.spyOn(service as any, 'reserveRateLimitSlot').mockImplementation(async () => {
          now.mockReturnValue(deadlineAtMs + 1);
        });
        const permit = async () => {
          if (Date.now() >= deadlineAtMs)
            throw new Error('feature permit expired during quota wait');
        };
        try {
          const error = await service
            .executeActionJob(
              {
                actionType,
                chatId: '-123',
                userId: 'human',
                text: 'text',
                botId: '777000_bot',
                attempt: 1,
                idempotencyKey: `expired-${actionType}`,
                createdAt: new Date().toISOString(),
              },
              {
                beforeSendMutation: permit,
                beforeMemberMutation: permit,
              },
            )
            .catch((caught: unknown) => caught);
          expect(error).toMatchObject({ message: 'feature permit expired during quota wait' });
          expect(wasMaxMemberMutationAttempted(error)).toBe(false);
          expect(request).not.toHaveBeenCalled();
        } finally {
          now.mockRestore();
          await service.onModuleDestroy();
        }
      },
    );

    it('releases the claimed send fence when its deferred quota rejects and preserves critical health', async () => {
      const request = jest.fn();
      const ledger = {
        claimSendDispatch: jest
          .fn<
            ReturnType<MaxActionLedgerService['claimSendDispatch']>,
            Parameters<MaxActionLedgerService['claimSendDispatch']>
          >()
          .mockResolvedValue({ kind: 'claimed', dispatchToken: 'quota-fence' }),
        releaseSendDispatch: jest
          .fn<
            ReturnType<MaxActionLedgerService['releaseSendDispatch']>,
            Parameters<MaxActionLedgerService['releaseSendDispatch']>
          >()
          .mockResolvedValue(undefined),
        completeSendDispatch: jest.fn<
          ReturnType<MaxActionLedgerService['completeSendDispatch']>,
          Parameters<MaxActionLedgerService['completeSendDispatch']>
        >(),
        recordAmbiguousSendDispatch: jest.fn<
          ReturnType<MaxActionLedgerService['recordAmbiguousSendDispatch']>,
          Parameters<MaxActionLedgerService['recordAmbiguousSendDispatch']>
        >(),
      };
      const service = createService(
        { request },
        { MAX_API_RATE_LIMIT_WAIT_MS_CRITICAL: '0' },
        undefined,
        ledger,
      );
      const diagnostics = observeActionFailureDiagnostics(service);
      diagnostics.quota.mockResolvedValueOnce([1, 0, 0]).mockResolvedValueOnce([0, 2, 1000]);
      const permit = jest.fn();
      try {
        const job = {
          actionType: 'SEND_MESSAGE' as const,
          chatId: '-123',
          text: 'text',
          botId: '777000_bot',
          attempt: 1,
          idempotencyKey: 'quota-rejection',
          createdAt: new Date().toISOString(),
        };
        await expect(
          service.executeActionJob(job, { beforeSendMutation: permit }),
        ).rejects.toMatchObject({
          code: 'MAX_API_INTERNAL_RATE_LIMIT',
          preDispatch: true,
          retryAfterMs: 1000,
        });
        expect(ledger.releaseSendDispatch).toHaveBeenCalledWith(job, 'quota-fence');
        expect(ledger.recordAmbiguousSendDispatch).not.toHaveBeenCalled();
        expect(ledger.completeSendDispatch).not.toHaveBeenCalled();
        expect(permit).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
        expect(diagnostics.failure).toHaveBeenCalledTimes(1);
        expect(diagnostics.failure).toHaveBeenCalledWith('critical', true, '777000_bot');
        expect(
          diagnostics.warn.mock.calls.filter(([, message]) => message === ACTION_FAILURE_WARNING),
        ).toEqual([
          [
            expect.objectContaining({
              failureOrigin: 'local_quota',
              isCritical: true,
              requestAssociation: 'unlinked',
              method: 'unknown',
              endpointKind: 'unknown',
            }),
            ACTION_FAILURE_WARNING,
          ],
        ]);
      } finally {
        await service.onModuleDestroy();
      }
    });

    it('counts a nested critical lookup quota rejection once while the final send permit is running', async () => {
      const request = jest.fn();
      const service = createService({ request }, { MAX_API_RATE_LIMIT_WAIT_MS_CRITICAL: '0' });
      const diagnostics = observeActionFailureDiagnostics(service);
      diagnostics.quota
        .mockResolvedValueOnce([1, 0, 0])
        .mockResolvedValueOnce([1, 0, 0])
        .mockResolvedValueOnce([1, 0, 0])
        .mockResolvedValueOnce([0, 2, 1000]);
      try {
        await expect(
          service.sendMessageImmediateWithId('-123', 'text', {
            beforeSend: async () => {
              await service.getCurrentChatMemberAccess('-123', {
                bypassCache: true,
                trafficClass: 'critical',
              });
            },
          }),
        ).rejects.toMatchObject({ code: 'MAX_API_INTERNAL_RATE_LIMIT' });
        expect(diagnostics.failure).toHaveBeenCalledTimes(1);
        expect(
          diagnostics.warn.mock.calls.filter(([, message]) => message === ACTION_FAILURE_WARNING),
        ).toHaveLength(1);
        expect(request).not.toHaveBeenCalled();
      } finally {
        await service.onModuleDestroy();
      }
    });

    it.each([403, 404])(
      'releases a queued SEND fence after an own-member HTTP %s denial without attempting POST',
      async (status) => {
        const denial = Object.assign(new Error('own-member access denied'), {
          response: { status, data: { code: 'chat.denied' } },
        });
        const request = jest.fn().mockReturnValue(throwError(() => denial));
        const ledger = {
          claimSendDispatch: jest.fn<
            ReturnType<MaxActionLedgerService['claimSendDispatch']>,
            Parameters<MaxActionLedgerService['claimSendDispatch']>
          >(async () => ({
            kind: 'claimed',
            dispatchToken: 'proof-fence',
          })),
          releaseSendDispatch: jest.fn(),
          completeSendDispatch: jest.fn(),
          recordAmbiguousSendDispatch: jest.fn(),
        };
        const service = createService({ request }, {}, undefined, ledger);
        Object.defineProperty(service, 'maxBotLinkService', {
          value: { getFreshChatBotExecutionProof: jest.fn().mockResolvedValue(null) },
        });
        const permit = jest.fn();
        const job = {
          actionType: 'SEND_MESSAGE' as const,
          chatId: '-123',
          text: 'text',
          botId: '777000_bot',
          attempt: 1,
          idempotencyKey: `own-member-rejection-${status}`,
          createdAt: new Date().toISOString(),
        };
        try {
          const error = await service
            .executeActionJob(job, { beforeSendMutation: permit })
            .catch((caught: unknown) => caught);
          expect(error).toMatchObject({
            code: 'max_action_executor_proof_rejected',
            response: denial.response,
            cause: denial,
          });
          expect(wasMaxMessageSendAttempted(error)).toBe(false);
          expect(ledger.claimSendDispatch).toHaveBeenCalledTimes(1);
          expect(ledger.releaseSendDispatch).toHaveBeenCalledWith(job, 'proof-fence');
          expect(ledger.completeSendDispatch).not.toHaveBeenCalled();
          expect(ledger.recordAmbiguousSendDispatch).not.toHaveBeenCalled();
          expect(permit).not.toHaveBeenCalled();
          expect(request).toHaveBeenCalledTimes(1);
          expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: 'get' }));
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it.each(['BAN_MEMBER', 'KICK_MEMBER'] as const)(
      'preserves a retryable own-member proof 503 before %s was attempted',
      async (actionType) => {
        const failure = Object.assign(new Error('own-member proof unavailable'), {
          response: { status: 503 },
        });
        const request = jest.fn().mockReturnValue(throwError(() => failure));
        const service = createService({ request });
        Object.defineProperty(service, 'maxBotLinkService', {
          value: {
            getFreshChatBotExecutionProof: jest.fn().mockResolvedValue(null),
          },
        });
        try {
          const error = await service
            .executeActionJob({
              actionType,
              chatId: '-123',
              userId: 'human',
              botId: '777000_bot',
              attempt: 1,
              idempotencyKey: `proof-unavailable-${actionType}`,
              createdAt: new Date().toISOString(),
            })
            .catch((caught: unknown) => caught);
          expect(error).toBe(failure);
          expect(wasMaxMemberMutationAttempted(error)).toBe(false);
          expect(error).not.toBeInstanceOf(UnrecoverableError);
          expect(request).toHaveBeenCalledTimes(1);
          expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: 'get' }));
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it.each(['BAN_MEMBER', 'KICK_MEMBER'] as const)(
      'does not mark %s attempted when its deferred quota rejects',
      async (actionType) => {
        const request = jest.fn();
        const service = createService({ request }, { MAX_API_RATE_LIMIT_WAIT_MS_CRITICAL: '0' });
        jest
          .spyOn(service as any, 'tryReserveRateLimitSlot')
          .mockResolvedValue({ ok: false, retryAfterMs: 1000, reason: 'quota busy' });
        try {
          const error = await service
            .executeActionJob({
              actionType,
              chatId: '-123',
              userId: 'human',
              botId: '777000_bot',
              attempt: 1,
              idempotencyKey: `quota-rejection-${actionType}`,
              createdAt: new Date().toISOString(),
            })
            .catch((caught: unknown) => caught);
          expect(error).toMatchObject({ code: 'MAX_API_INTERNAL_RATE_LIMIT', preDispatch: true });
          expect(wasMaxMemberMutationAttempted(error)).toBe(false);
          expect(error).not.toBeInstanceOf(UnrecoverableError);
          expect(request).not.toHaveBeenCalled();
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it('checks queued executor proof before the final feature permit', async () => {
      const order: string[] = [];
      const request = jest.fn().mockImplementation(() => {
        order.push('delete');
        return of({ status: 200, data: { success: true } });
      });
      const service = createService({ request });
      const proof = {
        botId: '777000_bot',
        routingVersion: 2,
        accessEpoch: { checkedAt: new Date(), source: 'test' },
        changed: false,
      };
      Object.defineProperty(service, 'maxBotLinkService', {
        value: {
          getFreshChatBotExecutionProof: jest.fn().mockResolvedValue(proof),
          verifyChatExecutionProof: jest.fn().mockImplementation(async () => {
            order.push('proof');
            return true;
          }),
        },
      });
      try {
        await service.executeActionJob(
          {
            actionType: 'DELETE_MESSAGE',
            chatId: '-123',
            messageId: 'original',
            botId: '777000_bot',
            attempt: 1,
            idempotencyKey: 'delete-one',
            createdAt: new Date().toISOString(),
            scheduledFor: new Date().toISOString(),
          },
          {
            beforeDeleteMutation: async () => {
              order.push('feature-permit');
            },
          },
        );
        expect(order).toEqual(['proof', 'feature-permit', 'delete']);
      } finally {
        await service.onModuleDestroy();
      }
    });
    it.each(['plain', 'custom', 'reply'] as const)(
      'blocks %s send when a limiter wait invalidates the route proof',
      async (kind) => {
        const request = jest
          .fn()
          .mockReturnValue(of({ status: 200, data: { message: { body: { mid: 'sent' } } } }));
        const service = createService({ request });
        const proof = {
          botId: '777000_bot',
          routingVersion: 2,
          accessEpoch: { checkedAt: new Date(), source: 'test' },
          changed: false,
        };
        let valid = true;
        const link = {
          getFreshChatBotExecutionProof: jest.fn().mockResolvedValue(proof),
          verifyChatExecutionProof: jest.fn(async () => valid),
        };
        Object.defineProperty(service, 'maxBotLinkService', { value: link });
        jest.spyOn(service as any, 'reserveRateLimitSlot').mockImplementation(async () => {
          valid = false;
        });
        try {
          const send =
            kind === 'plain'
              ? service.sendMessageImmediateWithId('-123', 'text')
              : kind === 'custom'
                ? service.sendCustomMessageImmediate('-123', { text: 'text' })
                : service.sendMessageReplyWithInlineKeyboard('-123', 'original', 'text', {
                    button: { text: 'Open', url: 'https://example.com' },
                  });
          await expect(send).rejects.toMatchObject({ code: 'max_action_executor_proof_rejected' });
          expect(request).not.toHaveBeenCalled();
          expect(link.verifyChatExecutionProof).toHaveBeenCalledWith(
            expect.objectContaining({
              chatId: '-123',
              botId: '777000_bot',
              purpose: 'send_message',
            }),
          );
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it('checks proof before the final immediate send callback', async () => {
      const order: string[] = [];
      const request = jest.fn().mockImplementation(() => {
        order.push('send');
        return of({ status: 200, data: { message: { body: { mid: 'sent' } } } });
      });
      const service = createService({ request });
      const proof = {
        botId: '777000_bot',
        routingVersion: 2,
        accessEpoch: { checkedAt: new Date(), source: 'test' },
        changed: false,
      };
      Object.defineProperty(service, 'maxBotLinkService', {
        value: {
          getFreshChatBotExecutionProof: jest.fn().mockResolvedValue(proof),
          verifyChatExecutionProof: jest.fn().mockImplementation(async () => {
            order.push('proof');
            return true;
          }),
        },
      });
      try {
        await service.sendMessageImmediateWithId('-123', 'text', {
          beforeSend: async () => {
            order.push('callback');
          },
        });
        expect(order).toEqual(['proof', 'callback', 'send']);
      } finally {
        await service.onModuleDestroy();
      }
    });

    it.each(['plain', 'custom'] as const)(
      'rejects an expired %s feature permit after an awaited executor proof',
      async (kind) => {
        const request = jest.fn().mockReturnValue(of({ status: 200, data: { mid: 'unexpected' } }));
        const service = createService({ request });
        const deadlineAtMs = Date.now() + 1000;
        const now = jest.spyOn(Date, 'now').mockReturnValue(deadlineAtMs - 1);
        const proof = {
          botId: '777000_bot',
          routingVersion: 2,
          accessEpoch: { checkedAt: new Date(), source: 'test' },
          changed: false,
        };
        Object.defineProperty(service, 'maxBotLinkService', {
          value: {
            getFreshChatBotExecutionProof: jest.fn().mockResolvedValue(proof),
            verifyChatExecutionProof: jest.fn(async () => {
              now.mockReturnValue(deadlineAtMs + 1);
              return true;
            }),
          },
        });
        const finalGuard = jest.fn(async () => {
          if (Date.now() >= deadlineAtMs) throw new Error('feature permit expired');
        });
        try {
          const sending =
            kind === 'plain'
              ? service.sendMessageImmediateWithId('-123', 'text', { beforeSend: finalGuard })
              : service.sendCustomMessageImmediate('-123', { text: 'text' }, {}, finalGuard);
          await expect(sending).rejects.toThrow('feature permit expired');
          expect(finalGuard).toHaveBeenCalledTimes(1);
          expect(request).not.toHaveBeenCalled();
        } finally {
          now.mockRestore();
          await service.onModuleDestroy();
        }
      },
    );

    it('does not pass queued execution proof to a nested raw send in its feature callback', async () => {
      const request = jest.fn().mockReturnValue(of({ status: 200, data: { success: true } }));
      const service = createService({ request });
      const proof = {
        botId: '777000_bot',
        routingVersion: 2,
        accessEpoch: { checkedAt: new Date(), source: 'test' },
        changed: false,
      };
      const verify = jest.fn(
        async ({ purpose }: { purpose: string }) => purpose === 'delete_message',
      );
      Object.defineProperty(service, 'maxBotLinkService', {
        value: {
          getFreshChatBotExecutionProof: jest.fn().mockResolvedValue(proof),
          verifyChatExecutionProof: verify,
        },
      });
      try {
        await expect(
          service.executeActionJob(
            {
              actionType: 'DELETE_MESSAGE',
              chatId: '-123',
              messageId: 'original',
              botId: '777000_bot',
              attempt: 1,
              idempotencyKey: 'delete-nested',
              createdAt: new Date().toISOString(),
              scheduledFor: new Date().toISOString(),
            },
            {
              beforeDeleteMutation: async () => {
                await service.sendMessageImmediateWithId('-123', 'nested notification');
              },
            },
          ),
        ).rejects.toMatchObject({ code: 'max_action_executor_proof_rejected' });
        expect(verify.mock.calls.map(([params]) => params.purpose)).toEqual([
          'delete_message',
          'send_message',
        ]);
        expect(request).not.toHaveBeenCalled();
      } finally {
        await service.onModuleDestroy();
      }
    });

    it.each([403, 404])(
      'normalizes definite live proof HTTP %s to a no-send route rejection',
      async (status) => {
        const denial = Object.assign(new Error('chat access denied'), {
          code: 'ERR_BAD_REQUEST',
          response: { status, data: { code: 'chat.denied' } },
        });
        const request = jest.fn().mockReturnValue(throwError(() => denial));
        const service = createService({ request });
        Object.defineProperty(service, 'maxBotLinkService', {
          value: {
            getFreshChatBotExecutionProof: jest.fn().mockResolvedValue(null),
          },
        });
        const guard = jest.fn();
        try {
          await expect(
            service.sendMessageImmediateWithId('-123', 'text', { beforeSend: guard }),
          ).rejects.toMatchObject({
            code: 'max_action_executor_proof_rejected',
            response: denial.response,
            cause: denial,
          });
          expect(guard).not.toHaveBeenCalled();
          expect(request).toHaveBeenCalledTimes(1);
          expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: 'get' }));
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it.each([408, 500, 503])(
      'keeps live proof HTTP %s outside definite route rejection',
      async (status) => {
        const failure = Object.assign(new Error('own member lookup unavailable'), {
          response: { status },
        });
        const request = jest.fn().mockReturnValue(throwError(() => failure));
        const service = createService({ request });
        Object.defineProperty(service, 'maxBotLinkService', {
          value: {
            getFreshChatBotExecutionProof: jest.fn().mockResolvedValue(null),
          },
        });
        try {
          await expect(service.sendMessageImmediateWithId('-123', 'text')).rejects.toBe(failure);
          expect((failure as Error & { code?: string }).code).toBe(
            MAX_SEND_PRE_DISPATCH_GUARD_REJECTED_CODE,
          );
          expect(request).toHaveBeenCalledTimes(1);
          expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: 'get' }));
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it('keeps direct private replies independent of group execution membership', async () => {
      const request = jest
        .fn()
        .mockReturnValue(of({ status: 200, data: { message: { body: { mid: 'sent' } } } }));
      const service = createService({ request });
      const read = jest.fn();
      Object.defineProperty(service, 'maxBotLinkService', {
        value: { getFreshChatBotExecutionProof: read },
      });
      try {
        await service.sendMessageImmediateToUser('42', 'private result');
        expect(read).not.toHaveBeenCalled();
        expect(request).toHaveBeenCalledTimes(1);
      } finally {
        await service.onModuleDestroy();
      }
    });
  });

  const ACTION_FAILURE_WARNING = 'Recorded unignored user-facing MAX API action failure';

  function observeActionFailureDiagnostics(service: MaxClientService) {
    const runtime = service as unknown as {
      logger: Pick<Logger, 'warn'>;
      actionHealthService: Pick<
        ActionHealthService,
        'recordFailureForLane' | 'recordSuccessForLane'
      >;
      limiterRedis: Pick<Redis, 'eval'>;
    };
    return {
      warn: jest.spyOn(runtime.logger, 'warn').mockImplementation(() => undefined),
      failure: jest.spyOn(runtime.actionHealthService, 'recordFailureForLane'),
      success: jest.spyOn(runtime.actionHealthService, 'recordSuccessForLane'),
      quota: jest.spyOn(runtime.limiterRedis, 'eval'),
    };
  }

  function createService(
    httpService: { request?: jest.Mock } = {},
    configOverrides: Partial<Record<string, boolean | string>> = {},
    actionQueue?: { add: jest.Mock; getJob: jest.Mock },
    actionLedgerService?: Partial<
      Pick<
        MaxActionLedgerService,
        | 'isIrreversibleAction'
        | 'assertCanEnqueue'
        | 'recordStarted'
        | 'recordSucceeded'
        | 'recordFailed'
        | 'recordEnqueuedIfAbsent'
        | 'recordEnqueueFailedIfAbsent'
        | 'hasExecutionEvidenceSince'
        | 'getCompletedSendDispatch'
        | 'getCompletedSendDispatchResult'
        | 'claimSendDispatch'
        | 'completeSendDispatch'
        | 'releaseSendDispatch'
        | 'recordAmbiguousSendDispatch'
        | 'clearTerminalBanStateAfterUnban'
      >
    >,
    marketplaceState?: { resolvePublicationButton: jest.Mock; recordButtonDiagnostic: jest.Mock },
  ) {
    const configService = {
      getOrThrow: jest.fn((key: string) => {
        if (key === 'MAX_API_BASE_URL') {
          return 'https://platform-api2.max.ru';
        }
        if (key === 'MAX_BOT_TOKEN') {
          return 'test-token';
        }
        if (key === 'REDIS_URL') {
          return 'redis://localhost:6379/0';
        }
        throw new Error(`Unexpected key ${key}`);
      }),
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key in configOverrides) {
          return configOverrides[key];
        }
        return fallback;
      }),
    };
    const actionHealthService = {
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
      recordSuccessForLane: jest.fn(),
      recordFailureForLane: jest.fn(),
      getSnapshot: jest.fn(),
    };
    const botRegistry = {
      getDefaultBot: jest.fn().mockReturnValue({
        id: '777000_bot',
        token: 'test-token',
        webhookSecretPath: 'secret-path',
        webhookHeaderSecret: 'header-secret',
        webhookUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
        maskedWebhookUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/***',
      }),
      getBotById: jest.fn((botId?: string | null) =>
        !botId || botId === '777000_bot'
          ? {
              id: '777000_bot',
              token: 'test-token',
              webhookSecretPath: 'secret-path',
              webhookHeaderSecret: 'header-secret',
              webhookUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
              maskedWebhookUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/***',
            }
          : null,
      ),
      getConfiguredWebhookSubscriptionTarget: jest.fn(() => ({
        url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
        maskedUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/***',
      })),
      isKnownBotUserId: jest.fn().mockReturnValue(false),
    };
    let activeBotId: string | null = null;
    const botContext = {
      getActiveBotId: jest.fn(() => activeBotId),
      runWithBot: jest.fn((botId: string, callback: () => unknown) => {
        const previousBotId = activeBotId;
        activeBotId = botId;
        try {
          const result = callback();
          if (result && typeof (result as Promise<unknown>).finally === 'function') {
            return (result as Promise<unknown>).finally(() => {
              activeBotId = previousBotId;
            });
          }
          activeBotId = previousBotId;
          return result;
        } catch (error: unknown) {
          activeBotId = previousBotId;
          throw error;
        }
      }),
    };

    return new MaxClientService(
      httpService as never,
      configService as never,
      actionHealthService as never,
      botRegistry as never,
      botContext as never,
      actionQueue as never,
      undefined,
      actionLedgerService as never,
      undefined,
      undefined,
      undefined,
      undefined,
      marketplaceState as never,
    );
  }

  describe('permanent legacy effects hold at the transport boundary', () => {
    function holds(messageHeld = true) {
      return {
        isOutboundJobHeld: jest.fn().mockResolvedValue(false),
        isMessageHeld: jest.fn().mockResolvedValue(messageHeld),
        isMemberHeld: jest.fn().mockResolvedValue(false),
        isGlobalUserHeld: jest.fn().mockResolvedValue(false),
        isLegacyChatSendHeld: jest.fn().mockResolvedValue(false),
      };
    }
    const job = {
      actionType: 'DELETE_MESSAGE',
      chatId: '-100',
      messageId: 'held-source',
      createdAt: new Date().toISOString(),
      idempotencyKey: 'held-source-delete',
      attempt: 1,
      maxAttempts: 3,
      retryPolicy: 'default',
    } as MaxActionJob;

    it('denies immediate legacy DELETE before HTTP with a proven pre-dispatch failure', async () => {
      const request = jest.fn();
      const service = createService({ request });
      Object.assign(service, { legacyHolds: holds() });
      let error: unknown;
      try {
        await service.executeActionJob(job);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(WebhookLegacyHoldRejectedError);
      expect(wasMaxPreDispatchGuardRejected(error)).toBe(true);
      expect(request).not.toHaveBeenCalled();
    });

    it('fails closed on hold lookup loss before HTTP', async () => {
      const request = jest.fn();
      const service = createService({ request });
      const hold = holds(false);
      hold.isMessageHeld.mockRejectedValue(new Error('Hold store unavailable'));
      Object.assign(service, { legacyHolds: hold });
      await expect(service.executeActionJob(job)).rejects.toThrow('Hold store unavailable');
      expect(request).not.toHaveBeenCalled();
    });

    it('settles a known completed SEND without checking holds or sending again', async () => {
      const request = jest.fn();
      const service = createService({ request }, {}, undefined, {
        getCompletedSendDispatchResult: jest.fn().mockResolvedValue({
          remoteMessageId: 'confirmed-message',
          dispatchBotId: 'default',
          completedAt: new Date(),
        }),
      });
      const hold = holds();
      Object.assign(service, { legacyHolds: hold });
      await expect(
        service.executeActionJob({ ...job, actionType: 'SEND_MESSAGE', text: 'notice' }),
      ).resolves.toMatchObject({ messageId: 'confirmed-message' });
      expect(hold.isOutboundJobHeld).not.toHaveBeenCalled();
      expect(hold.isMessageHeld).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
    });

    it('recovers a concurrent positive SEND receipt after hold rejection without creating auto-delete', async () => {
      const request = jest.fn();
      const completedAt = new Date();
      const readReceipt = jest.fn().mockResolvedValueOnce(null).mockResolvedValue({
        remoteMessageId: 'late-confirmed-message',
        dispatchBotId: '777000_bot',
        completedAt,
      });
      const claim = jest.fn().mockResolvedValue({
        kind: 'claimed',
        dispatchToken: 'late-confirmation-token',
      });
      const queue = {
        add: jest.fn().mockResolvedValue(undefined),
        getJob: jest.fn().mockResolvedValue(null),
      };
      const service = createService({ request }, {}, queue, {
        getCompletedSendDispatchResult: readReceipt,
        claimSendDispatch: claim,
        assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
        recordEnqueuedIfAbsent: jest.fn().mockResolvedValue(undefined),
      });
      const hold = holds();
      Object.assign(service, { legacyHolds: hold });
      await expect(
        service.executeActionJob({
          ...job,
          actionType: 'SEND_MESSAGE',
          text: 'notice',
          botId: '777000_bot',
          autoDeleteDelayMs: 60_000,
        }),
      ).resolves.toMatchObject({
        messageId: 'late-confirmed-message',
        recoveredSendDispatch: { dispatchBotId: '777000_bot' },
      });
      expect(readReceipt).toHaveBeenCalledTimes(2);
      expect(hold.isMessageHeld).toHaveBeenCalled();
      expect(claim).toHaveBeenCalledTimes(1);
      expect(request).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it.each(['message', 'member', 'global_user', 'child', 'old_chat', 'reply'] as const)(
      'settles a confirmed SEND under %s hold without a new child or ledger entry',
      async (scope) => {
        const request = jest.fn();
        const queue = {
          add: jest.fn(),
          getJob: jest.fn().mockResolvedValue(null),
        };
        const ledger = {
          getCompletedSendDispatchResult: jest.fn().mockResolvedValue({
            remoteMessageId: 'confirmed-parent',
            dispatchBotId: '777000_bot',
            completedAt: new Date(),
          }),
          claimSendDispatch: jest.fn(),
          assertCanEnqueue: jest.fn(),
          recordEnqueuedIfAbsent: jest.fn(),
          recordEnqueueFailedIfAbsent: jest.fn(),
        };
        const service = createService({ request }, {}, queue, ledger);
        const hold = holds(false);
        const method = {
          message: 'isMessageHeld',
          member: 'isMemberHeld',
          global_user: 'isGlobalUserHeld',
          child: 'isOutboundJobHeld',
          old_chat: 'isLegacyChatSendHeld',
          reply: 'isMessageHeld',
        }[scope] as keyof typeof hold;
        hold[method].mockResolvedValue(true);
        Object.assign(service, { legacyHolds: hold });
        try {
          await expect(
            service.executeActionJob({
              ...job,
              actionType: 'SEND_MESSAGE',
              ...(scope === 'reply'
                ? {
                    messageId: undefined,
                    options: { messageLink: { type: 'reply' as const, mid: 'held-reply-source' } },
                  }
                : {}),
              userId: 'source-user',
              text: 'notice',
              autoDeleteDelayMs: 60_000,
            }),
          ).resolves.toMatchObject({ messageId: 'confirmed-parent' });
          expect(hold[method]).toHaveBeenCalled();
          expect(request).not.toHaveBeenCalled();
          expect(queue.add).not.toHaveBeenCalled();
          expect(ledger.claimSendDispatch).not.toHaveBeenCalled();
          expect(ledger.assertCanEnqueue).not.toHaveBeenCalled();
          expect(ledger.recordEnqueuedIfAbsent).not.toHaveBeenCalled();
          expect(ledger.recordEnqueueFailedIfAbsent).not.toHaveBeenCalled();
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it.each(['independent_reply', 'incomplete_moderation'] as const)(
      'keeps unrelated chat holds scoped for %s auto-delete',
      async (source) => {
        const request = jest.fn().mockReturnValue(of({ data: { success: true } }));
        const queue = {
          add: jest.fn().mockResolvedValue(undefined),
          getJob: jest.fn().mockResolvedValue(null),
        };
        const completed = {
          remoteMessageId: 'confirmed-independent-parent',
          dispatchBotId: '777000_bot',
          completedAt: new Date(),
        };
        const ledger = {
          getCompletedSendDispatchResult: jest
            .fn()
            .mockImplementation(async (action: MaxActionJob) =>
              action.actionType === 'SEND_MESSAGE' ? completed : null,
            ),
          assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
          recordEnqueuedIfAbsent: jest.fn().mockResolvedValue(undefined),
        };
        const service = createService({ request }, {}, queue, ledger);
        const hold = holds(false);
        const sealedAt = Date.parse('2026-10-01T00:00:00.000Z');
        hold.isMessageHeld.mockImplementation(
          async (_chatId: string, messageId: string) => messageId === 'unrelated-held-source',
        );
        hold.isLegacyChatSendHeld.mockImplementation(
          async (_chatId: string, createdAt: Date) =>
            !Number.isFinite(createdAt.getTime()) || createdAt.getTime() <= sealedAt,
        );
        Object.assign(service, { legacyHolds: hold });
        jest.spyOn(service, 'getExactMessagePresence').mockResolvedValue('present');
        try {
          await expect(
            service.executeActionJob({
              ...job,
              actionType: 'SEND_MESSAGE',
              messageId: undefined,
              userId: undefined,
              text: 'independently authored reply',
              options: { messageLink: { type: 'reply', mid: 'independent-reply-source' } },
              autoDeleteDelayMs: 60_000,
              createdAt: '2026-10-05T00:00:00.000Z',
              ...(source === 'incomplete_moderation'
                ? {
                    ledgerContext: {
                      moderationSource: {
                        version: 1,
                        chatId: '-100',
                        messageId: 'unheld-rule-source',
                      },
                    },
                  }
                : {}),
            }),
          ).resolves.toMatchObject({ messageId: completed.remoteMessageId });
          if (source === 'incomplete_moderation') {
            expect(queue.add).not.toHaveBeenCalled();
            expect(request).not.toHaveBeenCalled();
            return;
          }
          expect(queue.add).toHaveBeenCalledTimes(1);
          const child = queue.add.mock.calls[0][1] as MaxActionJob;
          expect(child).toMatchObject({
            actionType: 'DELETE_MESSAGE',
            options: { messageLink: { type: 'reply', mid: 'independent-reply-source' } },
            sendAutoDelete: {
              sourceMessageId: null,
              sourceUserId: null,
              sourceCreatedAt: '2026-10-05T00:00:00.000Z',
            },
          });
          await expect(service.executeActionJob(child)).resolves.toBeUndefined();
          expect(request).toHaveBeenCalledTimes(1);
          expect(request).toHaveBeenCalledWith(
            expect.objectContaining({
              method: 'delete',
              params: { message_id: completed.remoteMessageId },
            }),
          );
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it.each(['initial', 'queue_admission'] as const)(
      'fails closed on %s hold lookup outage while recovering a confirmed parent',
      async (stage) => {
        const request = jest.fn();
        const queue = { add: jest.fn(), getJob: jest.fn().mockResolvedValue(null) };
        const ledger = {
          getCompletedSendDispatchResult: jest.fn().mockResolvedValue({
            remoteMessageId: 'confirmed-parent',
            dispatchBotId: '777000_bot',
            completedAt: new Date(),
          }),
          assertCanEnqueue: jest.fn(),
          recordEnqueuedIfAbsent: jest.fn(),
          recordEnqueueFailedIfAbsent: jest.fn(),
        };
        const service = createService({ request }, {}, queue, ledger);
        const hold = holds(false);
        const outage = new Error('Authoritative hold lookup unavailable');
        hold.isOutboundJobHeld.mockRejectedValue(outage);
        if (stage === 'queue_admission') {
          hold.isOutboundJobHeld.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
        }
        Object.assign(service, { legacyHolds: hold });
        try {
          await expect(
            service.executeActionJob({
              ...job,
              actionType: 'SEND_MESSAGE',
              text: 'notice',
              autoDeleteDelayMs: 60_000,
            }),
          ).rejects.toBe(outage);
          expect(request).not.toHaveBeenCalled();
          expect(queue.add).not.toHaveBeenCalled();
          expect(ledger.recordEnqueuedIfAbsent).not.toHaveBeenCalled();
          expect(ledger.recordEnqueueFailedIfAbsent).not.toHaveBeenCalled();
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it('releases a denied SEND despite a late receipt-read outage and permits a fresh retry', async () => {
      const request = jest.fn().mockReturnValue(of({ data: { mid: 'fresh-retry-message' } }));
      let claimedToken: string | null = null;
      const ledger = {
        getCompletedSendDispatchResult: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockRejectedValueOnce(new Error('Transient receipt lookup unavailable'))
          .mockResolvedValue(null),
        claimSendDispatch: jest.fn().mockImplementation(async (action: MaxActionJob) => {
          if (claimedToken) throw new Error('A surviving send fence prevents a fresh retry');
          claimedToken = `attempt-${action.attempt}`;
          return { kind: 'claimed', dispatchToken: claimedToken };
        }),
        releaseSendDispatch: jest
          .fn()
          .mockImplementation(async (_action: MaxActionJob, token: string) => {
            expect(token).toBe(claimedToken);
            claimedToken = null;
          }),
        completeSendDispatch: jest.fn().mockImplementation(async () => {
          claimedToken = null;
          return new Date();
        }),
        recordAmbiguousSendDispatch: jest.fn(),
      };
      const service = createService({ request }, {}, undefined, ledger);
      const hold = holds();
      Object.assign(service, { legacyHolds: hold });
      const action = { ...job, actionType: 'SEND_MESSAGE' as const, text: 'notice' };
      try {
        let failure: unknown;
        try {
          await service.executeActionJob(action);
        } catch (error: unknown) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(WebhookLegacyHoldRejectedError);
        expect(wasMaxPreDispatchGuardRejected(failure)).toBe(true);
        expect(wasMaxMessageSendAttempted(failure)).toBe(false);
        expect(isMaxMutationOutcomeAmbiguous(failure, true)).toBe(false);
        expect(request).not.toHaveBeenCalled();
        expect(ledger.releaseSendDispatch).toHaveBeenCalledWith(action, 'attempt-1');
        expect(claimedToken).toBeNull();

        hold.isMessageHeld.mockResolvedValue(false);
        await expect(service.executeActionJob({ ...action, attempt: 2 })).resolves.toMatchObject({
          messageId: 'fresh-retry-message',
        });
        expect(request).toHaveBeenCalledTimes(1);
        expect(ledger.claimSendDispatch).toHaveBeenCalledTimes(2);
        expect(ledger.completeSendDispatch).toHaveBeenCalledTimes(1);
        expect(ledger.recordAmbiguousSendDispatch).not.toHaveBeenCalled();
      } finally {
        await service.onModuleDestroy();
      }
    });

    it('retains quarantine when receipt lookup and the mandatory denied SEND release both fail', async () => {
      const request = jest.fn();
      const ledger = {
        getCompletedSendDispatchResult: jest
          .fn()
          .mockResolvedValueOnce(null)
          .mockRejectedValue(new Error('Transient receipt lookup unavailable')),
        claimSendDispatch: jest.fn().mockResolvedValue({
          kind: 'claimed',
          dispatchToken: 'unreleased-token',
        }),
        releaseSendDispatch: jest.fn().mockRejectedValue(new Error('Dispatch release unavailable')),
        recordAmbiguousSendDispatch: jest.fn().mockResolvedValue(true),
      };
      const service = createService({ request }, {}, undefined, ledger);
      Object.assign(service, { legacyHolds: holds() });
      const action = { ...job, actionType: 'SEND_MESSAGE' as const, text: 'notice' };
      try {
        let failure: unknown;
        try {
          await service.executeActionJob(action);
        } catch (error: unknown) {
          failure = error;
        }
        expect(isMaxMutationOutcomeAmbiguous(failure, true)).toBe(true);
        expect(ledger.releaseSendDispatch).toHaveBeenCalledWith(action, 'unreleased-token');
        expect(ledger.recordAmbiguousSendDispatch).toHaveBeenCalledTimes(1);
        expect(request).not.toHaveBeenCalled();
      } finally {
        await service.onModuleDestroy();
      }
    });

    it('settles a no-origin SEND receipt found at the wrapper final hold without running its revoked feature', async () => {
      const request = jest.fn();
      const readReceipt = jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValue({
          remoteMessageId: 'wrapper-confirmed-message',
          dispatchBotId: '777000_bot',
          completedAt: new Date(),
        });
      const ledger = {
        getCompletedSendDispatchResult: readReceipt,
        assertCanExecute: jest.fn().mockResolvedValue(undefined),
        recordStarted: jest.fn().mockResolvedValue(undefined),
        recordSucceeded: jest.fn().mockResolvedValue(undefined),
        recordFailed: jest.fn().mockResolvedValue(undefined),
        claimSendDispatch: jest.fn().mockResolvedValue({
          kind: 'claimed',
          dispatchToken: 'wrapper-late-confirmation-token',
        }),
      };
      const service = createService({ request }, {}, undefined, ledger);
      const hold = holds();
      hold.isMessageHeld
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValue(true);
      Object.assign(service, { legacyHolds: hold });
      const dispatch = new MaxActionDispatchService(
        service,
        undefined,
        ledger as never,
        undefined,
        undefined,
        hold as never,
      );
      const feature = jest.fn().mockRejectedValue(new Error('Notice settings revoked'));
      await expect(
        dispatch.execute(
          { ...job, actionType: 'SEND_MESSAGE', text: 'notice' },
          {
            beforeSendMutation: feature,
          },
        ),
      ).resolves.toMatchObject({ messageId: 'wrapper-confirmed-message', botId: '777000_bot' });
      expect(readReceipt).toHaveBeenCalledTimes(3);
      expect(feature).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      expect(ledger.claimSendDispatch).toHaveBeenCalledTimes(1);
      expect(ledger.recordSucceeded).not.toHaveBeenCalled();
      expect(ledger.recordFailed).not.toHaveBeenCalled();
    });

    it('denies direct EDIT even when the message was read successfully', async () => {
      const request = jest.fn().mockImplementation(() =>
        of({
          data: {
            sender: { user_id: 'source-user' },
            recipient: { chat_id: '-100' },
            body: { mid: 'held-source', text: 'Original', attachments: [] },
          },
        }),
      );
      const service = createService({ request });
      Object.assign(service, { legacyHolds: holds() });
      await expect(
        service.editMessageInlineKeyboard('-100', 'held-source', 'Changed'),
      ).rejects.toBeInstanceOf(WebhookLegacyHoldRejectedError);
      expect(request.mock.calls.some(([call]) => String(call.method).toLowerCase() === 'put')).toBe(
        false,
      );
    });

    it.each(['immediate', 'custom', 'copy', 'reply', 'queued'] as const)(
      'denies %s SEND from a held source before its feature guard or HTTP publication',
      async (kind) => {
        const request = jest.fn().mockImplementation(() =>
          of({
            data: {
              sender: { user_id: 'source-user' },
              recipient: { chat_id: '-100' },
              body: { mid: 'held-source', text: 'Original', attachments: [] },
            },
          }),
        );
        const service = createService({ request });
        const hold = holds();
        Object.assign(service, { legacyHolds: hold });
        const beforeSend = jest.fn().mockResolvedValue(undefined);
        const link = { type: 'reply' as const, mid: 'held-source' };
        const button = { text: 'Open', url: 'https://example.com' };
        const send =
          kind === 'immediate'
            ? () =>
                service.sendMessageImmediateWithId('-100', 'Reply', {
                  messageLink: link,
                  beforeSend,
                })
            : kind === 'custom'
              ? () =>
                  service.sendCustomMessageImmediate(
                    '-100',
                    { text: 'Reply', messageLink: link },
                    {},
                    beforeSend,
                  )
              : kind === 'copy'
                ? () =>
                    service.sendMessageCopyWithInlineKeyboard('-100', 'held-source', null, {
                      button,
                      beforeSend,
                    })
                : kind === 'reply'
                  ? () =>
                      service.sendMessageReplyWithInlineKeyboard('-100', 'held-source', 'Reply', {
                        button,
                      })
                  : () =>
                      service.executeActionJob(
                        {
                          ...job,
                          actionType: 'SEND_MESSAGE',
                          messageId: undefined,
                          text: 'Reply',
                          options: { messageLink: link },
                        },
                        { beforeSendMutation: beforeSend },
                      );
        try {
          let failure: unknown;
          try {
            await send();
          } catch (error: unknown) {
            failure = error;
          }
          expect(failure).toBeInstanceOf(WebhookLegacyHoldRejectedError);
          expect(wasMaxPreDispatchGuardRejected(failure)).toBe(true);
          expect(wasMaxMessageSendAttempted(failure)).toBe(false);
          expect(hold.isMessageHeld).toHaveBeenCalledWith(
            '-100',
            'held-source',
            ...(kind === 'queued' ? [undefined] : []),
          );
          expect(beforeSend).not.toHaveBeenCalled();
          expect(
            request.mock.calls.some(([call]) => String(call.method).toLowerCase() === 'post'),
          ).toBe(false);
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it.each(['original', 'nested_reply'] as const)(
      'checks a cross-chat copy against the actual source chat for %s holds',
      async (scope) => {
        const request = jest.fn().mockReturnValue(
          of({
            data: {
              sender: { user_id: 'source-user' },
              recipient: { chat_id: '-200' },
              body: { mid: 'copy-source', text: 'Original', attachments: [] },
              link: { type: 'reply', mid: 'held-parent' },
            },
          }),
        );
        const service = createService({ request });
        const hold = holds(false);
        hold.isMessageHeld.mockImplementation(
          async (chatId: string, messageId: string) =>
            chatId === '-200' &&
            messageId === (scope === 'original' ? 'copy-source' : 'held-parent'),
        );
        Object.assign(service, { legacyHolds: hold });
        const beforeSend = jest.fn().mockResolvedValue(undefined);
        try {
          await expect(
            service.sendMessageCopyWithInlineKeyboard('-100', 'copy-source', null, { beforeSend }),
          ).rejects.toBeInstanceOf(WebhookLegacyHoldRejectedError);
          expect(hold.isMessageHeld).toHaveBeenCalledWith(
            '-200',
            scope === 'original' ? 'copy-source' : 'held-parent',
          );
          expect(beforeSend).not.toHaveBeenCalled();
          expect(
            request.mock.calls.some(([call]) => String(call.method).toLowerCase() === 'post'),
          ).toBe(false);
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it('rejects malformed linked-source identity before the original feature guard', async () => {
      const request = jest.fn();
      const service = createService({ request });
      Object.assign(service, { legacyHolds: holds(false) });
      const beforeSend = jest.fn().mockResolvedValue(undefined);
      try {
        await expect(
          service.sendMessageImmediateWithId('-100', 'Reply', {
            messageLink: { type: 'reply', mid: ' held-source ' },
            beforeSend,
          }),
        ).rejects.toBeInstanceOf(WebhookLegacyHoldRejectedError);
        expect(beforeSend).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
      } finally {
        await service.onModuleDestroy();
      }
    });

    it('keeps the current feature guard last for an allowed linked source', async () => {
      const order: string[] = [];
      const request = jest.fn().mockImplementation(() => {
        order.push('http');
        return of({ data: { mid: 'allowed-reply' } });
      });
      const service = createService({ request });
      const hold = holds(false);
      hold.isMessageHeld.mockImplementation(async () => {
        order.push('hold');
        return false;
      });
      Object.assign(service, { legacyHolds: hold });
      const beforeSend = jest.fn().mockImplementation(async () => {
        order.push('feature');
      });
      try {
        await expect(
          service.sendMessageImmediateWithId('-100', 'Reply', {
            messageLink: { type: 'reply', mid: 'allowed-source' },
            beforeSend,
          }),
        ).resolves.toMatchObject({ messageId: 'allowed-reply' });
        expect(order).toEqual(['hold', 'feature', 'http']);
        expect(beforeSend).toHaveBeenCalledTimes(1);
      } finally {
        await service.onModuleDestroy();
      }
    });
  });

  describe('marketplace public-post delivery boundary', () => {
    const marketplaceUrl =
      'https://max.ru/svyazka_bot?startapp=listing_channel_10000000-0000-4000-8000-000000000001';
    const intent = { purpose: 'PUBLICATION' as const, entityId: '-100' };
    function fixture() {
      const http = {
        request: jest.fn().mockReturnValue(of({ status: 200, data: { mid: 'marketplace-send' } })),
      };
      const marketplace = {
        resolvePublicationButton: jest
          .fn<
            ReturnType<MarketplaceStateService['resolvePublicationButton']>,
            Parameters<MarketplaceStateService['resolvePublicationButton']>
          >()
          .mockResolvedValue({ url: marketplaceUrl, revision: 3, caption: 'Заказать рекламу' }),
        recordButtonDiagnostic: jest.fn(),
      };
      return { http, marketplace };
    }

    it('keeps the platform description in a verified snapshot for profile prefill', async () => {
      const http = {
        request: jest.fn().mockReturnValue(
          of({
            status: 200,
            data: {
              chat_id: '-100',
              type: 'channel',
              title: 'Канал',
              description: ' Проверенное описание ',
            },
          }),
        ),
      };
      const service = createService(http);
      expect((await service.getChatSnapshot('-100', { bypassCache: true })).description).toBe(
        'Проверенное описание',
      );
      await service.onModuleDestroy();
    });

    it('resolves against the actual sending bot before the final send guard and keeps private messages untouched', async () => {
      const f = fixture();
      const service = createService(f.http, {}, undefined, undefined, f.marketplace);
      const order: string[] = [];
      f.marketplace.resolvePublicationButton.mockImplementation(async () => {
        order.push('resolve');
        return { url: marketplaceUrl, revision: 3, caption: 'Реклама здесь' };
      });
      await service.sendMessageImmediateWithId('-100', 'Пост', {
        marketplacePublication: intent,
        beforeSend: async () => {
          order.push('guard');
        },
      });
      expect(order).toEqual(['resolve', 'guard', 'resolve']);
      expect(f.marketplace.resolvePublicationButton).toHaveBeenCalledWith({
        chatId: '-100',
        botId: '777000_bot',
        purpose: 'PUBLICATION',
      });
      expect(f.http.request.mock.calls[0][0].data.attachments[0].payload.buttons).toEqual([
        [{ type: 'link', text: 'Реклама здесь', url: marketplaceUrl }],
      ]);
      expect(f.http.request.mock.calls[0][0].data).not.toHaveProperty('marketplacePublication');
      await service.sendMessageImmediateToUser('100', 'Превью', { marketplacePublication: intent });
      await service.sendMessageImmediateWithId('100', 'Превью', { marketplacePublication: intent });
      await service.sendMessageImmediateWithId('-101', 'Другая площадка', {
        marketplacePublication: intent,
      });
      await service.sendMessageImmediateWithId('-100', 'Служебное уведомление');
      expect(f.marketplace.resolvePublicationButton).toHaveBeenCalledTimes(2);
      await service.onModuleDestroy();
    });

    it.each(['GREETING', 'MODERATION_NOTICE'] as const)(
      'resolves %s only for the authorized queued destination and final sender',
      async (purpose) => {
        const f = fixture();
        const service = createService(f.http, {}, undefined, undefined, f.marketplace);
        try {
          await service.executeActionJob({
            actionType: 'SEND_MESSAGE',
            chatId: '-100',
            text: 'Notice',
            options: { marketplacePublication: { entityId: '-100', purpose } },
            attempt: 1,
            idempotencyKey: `marketplace-${purpose}`,
            createdAt: new Date().toISOString(),
          });
          expect(f.marketplace.resolvePublicationButton).toHaveBeenCalledWith({
            chatId: '-100',
            botId: '777000_bot',
            purpose,
          });
          expect(
            f.http.request.mock.calls[0][0].data.attachments[0].payload.buttons[0][0].url,
          ).toBe(marketplaceUrl);
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it.each(['ADDED', 'DUPLICATE', 'EXPIRED', 'FULL'] as const)(
      'channel edit %s preserves the post and never sends a replacement',
      async (outcome) => {
        const existing =
          outcome === 'DUPLICATE'
            ? [[{ type: 'link', text: 'Existing', url: marketplaceUrl }]]
            : outcome === 'FULL'
              ? Array.from({ length: 30 }, (_, n) => [
                  { type: 'link', text: `Link ${n}`, url: `https://example.com/${n}` },
                ])
              : [[{ type: 'callback', text: 'Comments', payload: 'comments' }]];
        const media = { type: 'image', payload: { token: 'source-image' } };
        const original = {
          body: {
            mid: 'source',
            text: 'Original post',
            attachments: [media, { type: 'inline_keyboard', payload: { buttons: existing } }],
          },
        };
        const http = {
          request: jest.fn().mockImplementation((request: { method: string }) =>
            of({
              status: 200,
              data: request.method === 'get' ? { messages: [original] } : { success: true },
            }),
          ),
        };
        const f = fixture();
        if (outcome === 'EXPIRED') f.marketplace.resolvePublicationButton.mockResolvedValue(null);
        const service = createService(http, {}, undefined, undefined, f.marketplace);
        try {
          const edited = await service.editMessageInlineKeyboard('-100', 'source', null, {
            preserveExistingInlineKeyboard: true,
            requireAllAttachmentsPreserved: true,
            marketplaceChannelPost: {
              entityId: '-100',
              sourceAt: '2026-10-28T09:00:00.000Z',
              only: true,
            },
          });
          expect(f.marketplace.resolvePublicationButton).toHaveBeenCalledWith({
            chatId: '-100',
            botId: '777000_bot',
            purpose: 'CHANNEL_POST',
            sourceAt: new Date('2026-10-28T09:00:00.000Z'),
          });
          const writes = http.request.mock.calls.map(([r]) => r).filter((r) => r.method !== 'get');
          if (outcome === 'ADDED') {
            expect(edited).toBe(true);
            expect(writes).toHaveLength(1);
            expect(writes[0].method).toBe('put');
            expect(writes[0].data.text).toBeUndefined();
            expect(writes[0].data.attachments).toEqual([
              media,
              {
                type: 'inline_keyboard',
                payload: {
                  buttons: [
                    ...existing,
                    [{ type: 'link', text: 'Заказать рекламу', url: marketplaceUrl }],
                  ],
                },
              },
            ]);
          } else {
            expect(edited).toBe(false);
            expect(writes).toEqual([]);
          }
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it('honors policy disabled or expired after enqueue and survives integration failures', async () => {
      const f = fixture();
      const service = createService(f.http, {}, undefined, undefined, f.marketplace);
      const job: MaxActionJob = {
        actionType: 'SEND_MESSAGE',
        chatId: '-100',
        text: 'Пост',
        options: { marketplacePublication: intent },
        attempt: 1,
        idempotencyKey: 'marketplace-expired',
        createdAt: new Date().toISOString(),
      };
      f.marketplace.resolvePublicationButton
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error('local unavailable'));
      await service.executeActionJob(job);
      await service.executeActionJob({ ...job, idempotencyKey: 'marketplace-outage' });
      for (const call of f.http.request.mock.calls)
        expect(call[0].data).not.toHaveProperty('attachments');
      expect(job.options).not.toHaveProperty('buttons');
      await service.onModuleDestroy();
    });

    it('keeps the durable fence before HTTP and never prepares or resends recovered messages', async () => {
      const f = fixture();
      const ledger = {
        claimSendDispatch: jest.fn().mockResolvedValue({ kind: 'claimed', dispatchToken: 'token' }),
        completeSendDispatch: jest.fn(),
        releaseSendDispatch: jest.fn(),
      };
      const service = createService(f.http, {}, undefined, ledger, f.marketplace);
      const job: MaxActionJob = {
        actionType: 'SEND_MESSAGE',
        chatId: '-100',
        text: 'Пост',
        options: { marketplacePublication: intent },
        attempt: 1,
        idempotencyKey: 'marketplace-ledger',
        createdAt: new Date().toISOString(),
      };
      await service.executeActionJob(job);
      expect(f.marketplace.resolvePublicationButton.mock.invocationCallOrder[0]).toBeGreaterThan(
        ledger.claimSendDispatch.mock.invocationCallOrder[0],
      );
      expect(f.http.request.mock.calls[0][0].data.attachments[0].payload.buttons).toEqual([
        [{ type: 'link', text: 'Заказать рекламу', url: marketplaceUrl }],
      ]);
      ledger.claimSendDispatch.mockResolvedValueOnce({
        kind: 'recovered',
        remoteMessageId: 'marketplace-send',
        dispatchBotId: '777000_bot',
      });
      f.marketplace.resolvePublicationButton.mockResolvedValueOnce(null);
      await service.executeActionJob(job);
      expect(f.http.request).toHaveBeenCalledTimes(1);
      expect(f.marketplace.resolvePublicationButton).toHaveBeenCalledTimes(1);
      await service.onModuleDestroy();
    });

    it('drops a queued optional button revoked during quota wait before the final notice permit', async () => {
      const f = fixture();
      const order: string[] = [];
      let enabled = true;
      f.marketplace.resolvePublicationButton.mockImplementation(async () => {
        order.push('profile');
        return enabled ? { url: marketplaceUrl, revision: 3, caption: 'Заказать рекламу' } : null;
      });
      f.http.request.mockImplementation(() => {
        order.push('http');
        return of({ status: 200, data: { mid: 'marketplace-send' } });
      });
      const service = createService(f.http, {}, undefined, undefined, f.marketplace);
      const internal = service as unknown as {
        reserveRateLimitSlot: (...args: unknown[]) => Promise<string | undefined>;
      };
      jest.spyOn(internal, 'reserveRateLimitSlot').mockImplementation(async () => {
        order.push('quota');
        enabled = false;
        return undefined;
      });
      try {
        await service.executeActionJob(
          {
            actionType: 'SEND_MESSAGE',
            chatId: '-100',
            text: 'Notice',
            options: { marketplacePublication: { entityId: '-100', purpose: 'MODERATION_NOTICE' } },
            attempt: 1,
            idempotencyKey: 'profile-quota-revoke',
            createdAt: new Date().toISOString(),
          },
          {
            beforeSendMutation: async () => {
              order.push('permit');
            },
          },
        );
        expect(order).toEqual(['quota', 'profile', 'permit', 'http']);
        expect(f.http.request.mock.calls[0][0].data).not.toHaveProperty('attachments');
      } finally {
        await service.onModuleDestroy();
      }
    });

    it.each(['quota', 'guard'] as const)(
      'skips optional-only channel edit revoked at %s',
      async (stage) => {
        let enabled = true;
        const f = fixture();
        f.marketplace.resolvePublicationButton.mockImplementation(async () =>
          enabled ? { url: marketplaceUrl, revision: 3, caption: 'Заказать рекламу' } : null,
        );
        const http = {
          request: jest.fn().mockImplementation((request: { method: string }) =>
            of({
              status: 200,
              data:
                request.method === 'get'
                  ? { messages: [{ body: { mid: 'source', text: 'Original', attachments: [] } }] }
                  : { success: true },
            }),
          ),
        };
        const service = createService(http, {}, undefined, undefined, f.marketplace);
        const internal = service as unknown as {
          reserveRateLimitSlot: (...args: unknown[]) => Promise<string | undefined>;
        };
        jest.spyOn(internal, 'reserveRateLimitSlot').mockImplementation(async (...args) => {
          if (
            stage === 'quota' &&
            (args[5] as { operation?: string } | undefined)?.operation === 'edit'
          )
            enabled = false;
          return undefined;
        });
        try {
          expect(
            await service.editMessageInlineKeyboard('-100', 'source', null, {
              preserveExistingInlineKeyboard: true,
              requireAllAttachmentsPreserved: true,
              marketplaceChannelPost: {
                entityId: '-100',
                sourceAt: '2026-10-28T09:00:00.000Z',
                only: true,
              },
              beforeEditMutation: async () => {
                if (stage === 'guard') enabled = false;
              },
            }),
          ).toBe(false);
          expect(http.request.mock.calls.map(([request]) => request.method)).toEqual(['get']);
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it('records capacity omission without changing authored buttons', async () => {
      const f = fixture();
      const service = createService(f.http, {}, undefined, undefined, f.marketplace);
      const buttons = Array.from({ length: 30 }, (_, i) => [
        { type: 'link' as const, text: `Ссылка ${i}`, url: `https://example.com/${i}` },
      ]);
      await service.sendMessageImmediateWithId('-100', 'Пост', {
        buttons,
        marketplacePublication: intent,
      });
      expect(f.marketplace.recordButtonDiagnostic).toHaveBeenCalledWith({
        chatId: '-100',
        botId: '777000_bot',
        revision: 3,
        purpose: 'PUBLICATION',
        code: 'KEYBOARD_FULL',
      });
      expect(f.http.request.mock.calls[0][0].data.attachments[0].payload.buttons).toEqual(buttons);
      await service.onModuleDestroy();
    });
  });

  it('refuses to kick or ban configured bot users', async () => {
    const httpService = { request: jest.fn() };
    const service = createService(httpService);
    (service as any).botRegistry.isKnownBotUserId.mockImplementation(
      (userId: string | null | undefined) => userId === '613002203036_5',
    );

    await expect(
      service.kickMember('chat-1', '613002203036_5', { immediate: true }),
    ).rejects.toThrow('Refusing to kick configured MAX bot user');
    await expect(
      service.banMember('chat-1', '613002203036_5', { immediate: true }),
    ).rejects.toThrow('Refusing to ban configured MAX bot user');
    expect(httpService.request).not.toHaveBeenCalled();
  });

  it('skips stale queued kick or ban jobs for configured bot users', async () => {
    const httpService = { request: jest.fn() };
    const service = createService(httpService);
    (service as any).botRegistry.isKnownBotUserId.mockImplementation(
      (userId: string | null | undefined) => userId === '613002203036_5',
    );

    await service.executeActionJob({
      actionType: 'BAN_MEMBER',
      chatId: 'chat-1',
      userId: '613002203036_5',
      attempt: 1,
      idempotencyKey: 'ban-bot',
      createdAt: new Date().toISOString(),
    });

    await service.executeActionJob({
      actionType: 'KICK_MEMBER',
      chatId: 'chat-1',
      userId: '613002203036_5',
      attempt: 1,
      idempotencyKey: 'kick-bot',
      createdAt: new Date().toISOString(),
    });

    expect(httpService.request).not.toHaveBeenCalled();
  });

  it.each([MAX_ERASER_BOT_CONTACT_ID, MAX_ERASER_BOT_ID, '269798165', 'id613000037577_3_bot'])(
    'protects independent service bot %s from direct and previously queued kick/ban using the real registry',
    async (userId) => {
      const httpService = {
        request: jest.fn(() => of({ status: 200, data: { success: true } })),
      };
      const service = createService(httpService);
      const registry = new MaxBotRegistryService(
        new ConfigService({
          APP_BASE_URL: 'https://major-maksimov.ru',
          MAX_BOT_ID: '777000_bot',
          MAX_BOT_TOKEN: 'test-token',
          MAX_WEBHOOK_SECRET_PATH: 'secret-path',
          MAX_WEBHOOK_HEADER_SECRET: 'header-secret',
        }),
      );
      Object.assign(service, { botRegistry: registry });
      try {
        await expect(service.kickMember('chat-1', userId, { immediate: true })).rejects.toThrow(
          'Refusing to kick configured MAX bot user',
        );
        await expect(service.banMember('chat-1', userId, { immediate: true })).rejects.toThrow(
          'Refusing to ban configured MAX bot user',
        );
        for (const actionType of ['KICK_MEMBER', 'BAN_MEMBER'] as const) {
          await service.executeActionJob({
            actionType,
            chatId: 'chat-1',
            userId,
            attempt: 1,
            idempotencyKey: `preexisting-${actionType}-${userId}`,
            createdAt: new Date().toISOString(),
          });
        }
        expect(httpService.request).not.toHaveBeenCalled();

        await service.kickMember('chat-1', '281772329', { immediate: true });
        expect(httpService.request).toHaveBeenCalledTimes(1);
        expect(httpService.request).toHaveBeenCalledWith(
          expect.objectContaining({
            method: 'delete',
            url: 'https://platform-api2.max.ru/chats/chat-1/members',
            params: { user_id: '281772329' },
          }),
        );
      } finally {
        await service.onModuleDestroy();
      }
    },
  );

  it('refuses stale queued actions with an explicit non-executable bot id', async () => {
    const httpService = { request: jest.fn() };
    const service = createService(httpService);
    const botRegistry = (service as any).botRegistry;
    const defaultBot = botRegistry.getDefaultBot();
    botRegistry.getBotById.mockImplementation((botId?: string | null) => {
      if (!botId || botId === defaultBot.id) {
        return defaultBot;
      }
      if (botId === 'draining-bot') {
        return {
          id: 'draining-bot',
          token: 'draining-token',
          state: 'draining',
          webhookSecretPath: 'draining-secret',
          webhookHeaderSecret: 'draining-header-secret',
          webhookUrl: 'https://major-maksimov.ru/api/webhook/max/draining-bot/draining-secret',
          maskedWebhookUrl: 'https://major-maksimov.ru/api/webhook/max/draining-bot/***',
        };
      }
      return null;
    });

    await expect(
      service.executeActionJob({
        actionType: 'DELETE_MESSAGE',
        chatId: 'chat-1',
        messageId: 'mid-1',
        botId: 'draining-bot',
        attempt: 1,
        idempotencyKey: 'delete-draining',
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    const memberActionError = await service
      .executeActionJob({
        actionType: 'BAN_MEMBER',
        chatId: 'chat-1',
        userId: 'user-1',
        botId: 'draining-bot',
        attempt: 1,
        idempotencyKey: 'ban-draining',
        createdAt: new Date().toISOString(),
      })
      .catch((caught: unknown) => caught);

    expect(memberActionError).toBeInstanceOf(UnrecoverableError);
    expect(wasMaxMemberMutationAttempted(memberActionError)).toBe(false);
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('refuses enqueue-time actions with explicit non-executable or unknown bot ids', async () => {
    const httpService = { request: jest.fn() };
    const actionQueue = {
      add: jest.fn(),
      getJob: jest.fn(),
    };
    const service = createService(httpService, {}, actionQueue);
    const botRegistry = (service as any).botRegistry;
    const defaultBot = botRegistry.getDefaultBot();
    botRegistry.getBotById.mockImplementation((botId?: string | null) => {
      if (!botId || botId === defaultBot.id) {
        return defaultBot;
      }
      if (botId === 'draining-bot') {
        return {
          ...defaultBot,
          id: 'draining-bot',
          token: 'draining-token',
          state: 'draining',
        };
      }
      return null;
    });

    await expect(
      service.sendMessage('chat-1', 'hello', undefined, { botId: 'draining-bot' }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(
      service.deleteMessage('chat-1', 'mid-1', { botId: 'removed-bot' }),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(actionQueue.add).not.toHaveBeenCalled();
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('refuses stale queued actions with an explicit unknown bot id', async () => {
    const httpService = { request: jest.fn() };
    const service = createService(httpService);

    await expect(
      service.executeActionJob({
        actionType: 'DELETE_MESSAGE',
        chatId: 'chat-1',
        messageId: 'mid-1',
        botId: 'removed-bot',
        attempt: 1,
        idempotencyKey: 'delete-removed-bot',
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it.each([
    'bot_access',
    'members',
    'snapshot',
    'admins',
    'identity',
    'subscriptions',
    'exact_message',
  ] as const)(
    'refuses an unknown explicit bot before a %s read uses another token',
    async (lookup) => {
      const httpService = { request: jest.fn() };
      const service = createService(httpService);
      const { botRegistry, botContext, limiterRedis } = service as any;
      const defaultBot = botRegistry.getDefaultBot();
      const contextBot = { ...defaultBot, id: 'context-bot', token: 'context-token' };
      botRegistry.getBotById.mockImplementation((botId?: string | null) =>
        botId === contextBot.id ? contextBot : botId === defaultBot.id ? defaultBot : null,
      );
      const options = { botId: 'removed-bot' };
      const reads = {
        bot_access: () => service.getCurrentChatMemberAccess('chat-1', options),
        members: () => service.getChatMembersAccess('chat-1', ['user-1'], options),
        snapshot: () => service.getChatSnapshot('chat-1', options),
        admins: () => service.getChatAdminMembers('chat-1', options),
        identity: () => service.getOwnProfileIdentity(options),
        subscriptions: () => service.listWebhookSubscriptions(options),
        exact_message: () => service.getExactMessagePresence('chat-1', 'mid-1', options),
      };

      try {
        await expect(reads[lookup]()).rejects.toBeInstanceOf(UnrecoverableError);
        await expect(botContext.runWithBot(contextBot.id, reads[lookup])).rejects.toBeInstanceOf(
          UnrecoverableError,
        );
        expect(httpService.request).not.toHaveBeenCalled();
        expect(limiterRedis.get).not.toHaveBeenCalled();
        expect(limiterRedis.set).not.toHaveBeenCalled();
      } finally {
        await service.onModuleDestroy();
      }
    },
  );

  it.each(['default', 'context', 'explicit_draining'] as const)(
    'preserves the %s token for readable bot access',
    async (route) => {
      const httpService = {
        request: jest.fn().mockImplementation((request: { headers: { Authorization: string } }) =>
          of({
            status: 200,
            data: {
              user_id: request.headers.Authorization === 'test-token' ? '777000' : '888111',
              is_admin: true,
              permissions: ['write'],
            },
          }),
        ),
      };
      const service = createService(httpService);
      const { botRegistry, botContext } = service as any;
      const defaultBot = botRegistry.getDefaultBot();
      const drainingBot = {
        ...defaultBot,
        id: 'draining-bot',
        token: 'draining-token',
        state: 'draining',
      };
      botRegistry.getBotById.mockImplementation((botId?: string | null) =>
        botId === drainingBot.id ? drainingBot : botId === defaultBot.id ? defaultBot : null,
      );
      try {
        const read = () =>
          service.getCurrentChatMemberAccess('chat-1', {
            bypassCache: true,
            ...(route === 'explicit_draining' ? { botId: drainingBot.id } : {}),
          });
        const access = await (route === 'context'
          ? botContext.runWithBot(drainingBot.id, read)
          : read());
        expect(access.userId).toBe(route === 'default' ? '777000' : '888111');
        expect(access.isAdmin).toBe(true);
        expect(httpService.request).toHaveBeenCalledTimes(1);
        expect(httpService.request).toHaveBeenCalledWith(
          expect.objectContaining({
            headers: { Authorization: route === 'default' ? 'test-token' : 'draining-token' },
          }),
        );
      } finally {
        await service.onModuleDestroy();
      }
    },
  );

  it('passes timeout override to queued delete message jobs', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            success: true,
          },
        }),
      ),
    };
    const service = createService(httpService);
    const presence = jest.spyOn(service, 'getExactMessagePresence');

    await service.executeActionJob({
      actionType: 'DELETE_MESSAGE',
      chatId: 'chat-1',
      messageId: 'mid-delete-timeout-1',
      timeoutMs: 1_234,
      attempt: 1,
      idempotencyKey: 'delete-timeout',
      createdAt: new Date().toISOString(),
    });
    expect(httpService.request).toHaveBeenCalledWith({
      method: 'delete',
      url: 'https://platform-api2.max.ru/messages',
      params: {
        message_id: 'mid-delete-timeout-1',
      },
      timeout: 1_234,
      headers: {
        Authorization: 'test-token',
      },
    });
    expect(presence).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('skips DELETE when marked send-side auto-delete preflight confirms absence', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(of({ status: 200, data: { success: true } })),
    };
    const service = createService(httpService);
    const presence = jest.spyOn(service, 'getExactMessagePresence').mockResolvedValue('absent');
    const job = {
      actionType: 'DELETE_MESSAGE' as const,
      chatId: 'chat-1',
      botId: '777000_bot',
      messageId: 'mid-auto-delete-verified-1',
      sendAutoDelete: {
        version: MAX_SEND_AUTO_DELETE_MARKER_VERSION,
        sourceSendJobId: 'send-job-1',
        sourceSendCompletedAt: '2026-08-31T12:00:00.000Z',
        requestedDelayMs: 60_000,
        originBotId: '777000_bot',
      },
      attempt: 1,
      idempotencyKey: 'delete-auto-delete-verified-1',
      createdAt: '2026-08-31T12:01:00.000Z',
    };

    await expect(service.executeActionJob(job)).resolves.toBeUndefined();

    expect(presence).toHaveBeenCalledWith('chat-1', 'mid-auto-delete-verified-1', {
      boundObject: { kind: 'send', id: 'send-job-1' },
      botId: '777000_bot',
      trafficClass: undefined,
      actionHealthLane: undefined,
      sourceTag: undefined,
      timeoutMs: undefined,
      ignoreFailureMetricStatuses: [403, 404],
      bypassCache: true,
    });
    expect(httpService.request).not.toHaveBeenCalled();
    expect(job.sendAutoDelete).toMatchObject({
      version: MAX_SEND_AUTO_DELETE_MARKER_VERSION,
      confirmedAt: expect.any(String),
      confirmationKind: MAX_SEND_AUTO_DELETE_CONFIRMATION_KINDS.EXACT_ABSENCE_PREFLIGHT,
    });
    await service.onModuleDestroy();
  });

  it('accepts documented DELETE success without a post-delete exact-message lookup', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(of({ status: 200, data: { success: true } })),
    };
    const service = createService(httpService);
    const presence = jest.spyOn(service, 'getExactMessagePresence').mockResolvedValue('present');
    const job = {
      actionType: 'DELETE_MESSAGE' as const,
      chatId: 'chat-1',
      botId: '777000_bot',
      messageId: 'mid-auto-delete-post-verified-1',
      sendAutoDelete: {
        version: MAX_SEND_AUTO_DELETE_MARKER_VERSION,
        sourceSendJobId: 'send-job-1',
        sourceSendCompletedAt: '2026-08-31T12:00:00.000Z',
        requestedDelayMs: 60_000,
        originBotId: '777000_bot',
      },
      attempt: 1,
      idempotencyKey: 'delete-auto-delete-post-verified-1',
      createdAt: '2026-08-31T12:01:00.000Z',
    };

    await expect(service.executeActionJob(job)).resolves.toBeUndefined();

    expect(presence).toHaveBeenCalledTimes(1);
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'delete',
        params: { message_id: 'mid-auto-delete-post-verified-1' },
      }),
    );
    expect(job.sendAutoDelete).toMatchObject({
      version: MAX_SEND_AUTO_DELETE_MARKER_VERSION,
      confirmedAt: expect.any(String),
      confirmationKind: MAX_SEND_AUTO_DELETE_CONFIRMATION_KINDS.DOCUMENTED_DELETE_SUCCESS,
    });
    await service.onModuleDestroy();
  });

  it('upgrades a queued v1 marker after documented DELETE success', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(of({ status: 200, data: { success: true } })),
    };
    const service = createService(httpService);
    const presence = jest.spyOn(service, 'getExactMessagePresence').mockResolvedValue('present');
    const job = {
      actionType: 'DELETE_MESSAGE' as const,
      chatId: 'chat-1',
      botId: '777000_bot',
      messageId: 'mid-auto-delete-v1-1',
      sendAutoDelete: {
        version: 1 as const,
        sourceSendJobId: 'send-job-1',
        sourceSendCompletedAt: '2026-08-31T12:00:00.000Z',
        requestedDelayMs: 60_000,
        originBotId: '777000_bot',
      },
      attempt: 1,
      idempotencyKey: 'delete-auto-delete-v1-1',
      createdAt: '2026-08-31T12:01:00.000Z',
    };

    await expect(service.executeActionJob(job)).resolves.toBeUndefined();

    expect(presence).toHaveBeenCalledTimes(1);
    expect(httpService.request).toHaveBeenCalledTimes(1);
    expect(job.sendAutoDelete).toMatchObject({
      version: MAX_SEND_AUTO_DELETE_MARKER_VERSION,
      confirmedAt: expect.any(String),
      confirmationKind: MAX_SEND_AUTO_DELETE_CONFIRMATION_KINDS.DOCUMENTED_DELETE_SUCCESS,
    });
    await service.onModuleDestroy();
  });

  it('keeps an access-masked preflight 404 unknown without issuing DELETE', async () => {
    const lookupError = Object.assign(new Error('MAX message unavailable'), {
      response: {
        status: 404,
        data: { code: 'message.not.found', message: 'Message mid-auto-delete-unknown-1 not found' },
      },
    });
    const httpService = {
      request: jest.fn().mockReturnValueOnce(of({ status: 200, data: { success: true } })),
    };
    const service = createService(httpService);
    const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    jest.spyOn(service, 'getExactMessagePresence').mockRejectedValue(lookupError);

    await expect(
      service.executeActionJob({
        actionType: 'DELETE_MESSAGE',
        chatId: 'chat-1',
        botId: '777000_bot',
        messageId: 'mid-auto-delete-unknown-1',
        sendAutoDelete: {
          version: MAX_SEND_AUTO_DELETE_MARKER_VERSION,
          sourceSendJobId: 'send-job-1',
          sourceSendCompletedAt: null,
          requestedDelayMs: 60_000,
          originBotId: '777000_bot',
        },
        attempt: 1,
        idempotencyKey: 'delete-auto-delete-unknown-1',
        createdAt: '2026-08-31T12:01:00.000Z',
      }),
    ).rejects.toMatchObject({
      name: 'MaxSendAutoDeleteVerificationError',
      message: 'Could not verify sent bot message for auto-delete',
      code: MAX_SEND_AUTO_DELETE_VERIFICATION_UNKNOWN_ERROR_CODE,
      cause: lookupError,
      maxSendAutoDeleteVerificationDiagnostic: {
        kind: 'access_ambiguous',
        statusCode: 404,
        errorCode: 'message.not.found',
      },
    });
    expect(warnSpy).toHaveBeenCalledWith(
      {
        botId: '777000_bot',
        trafficClass: null,
        actionHealthLane: null,
        sourceTag: null,
        attempt: 1,
        verificationCauseKind: 'access_ambiguous',
        verificationStatusCode: 404,
        verificationErrorCode: 'message.not.found',
      },
      'Failed exact MAX presence verification for send-side auto-delete',
    );
    expect(JSON.stringify(warnSpy.mock.calls)).not.toMatch(
      /chat-1|mid-auto-delete-unknown-1|MAX message unavailable/iu,
    );
    expect(httpService.request).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it.each([403, 404])(
    'ignores auto-delete verification GET HTTP %s in action health metrics',
    async (status) => {
      const lookupError = Object.assign(new Error('MAX message unavailable'), {
        response: {
          status,
          data: {
            code: status === 403 ? 'access.denied' : 'message.not.found',
            message: 'Message unavailable',
          },
        },
      });
      const httpService = {
        request: jest.fn().mockReturnValue(throwError(() => lookupError)),
      };
      const service = createService(httpService);
      jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
      const actionHealthService = (service as any).actionHealthService;

      await expect(
        service.executeActionJob({
          actionType: 'DELETE_MESSAGE',
          chatId: 'chat-1',
          botId: '777000_bot',
          messageId: 'mid-auto-delete-verification-metric',
          actionHealthLane: 'background',
          sendAutoDelete: {
            version: MAX_SEND_AUTO_DELETE_MARKER_VERSION,
            sourceSendJobId: 'send-job-1',
            sourceSendCompletedAt: null,
            requestedDelayMs: 60_000,
            originBotId: '777000_bot',
          },
          attempt: 1,
          idempotencyKey: 'delete-auto-delete-verification-metric',
          createdAt: '2026-09-03T08:01:00.000Z',
        }),
      ).rejects.toMatchObject({
        name: 'MaxSendAutoDeleteVerificationError',
        maxSendAutoDeleteVerificationDiagnostic: {
          kind: 'access_ambiguous',
          statusCode: status,
        },
      });

      expect(actionHealthService.recordFailureForLane).not.toHaveBeenCalled();
      expect(httpService.request).toHaveBeenCalled();
      for (const [request] of httpService.request.mock.calls) {
        expect(request.method).toBe('get');
      }
      await service.onModuleDestroy();
    },
  );

  it('keeps production auto-delete GET suppressions scoped away from the DELETE metric', async () => {
    const deleteError = Object.assign(new Error('Delete failed'), {
      response: {
        status: 404,
        data: { code: 'message.not.found', message: 'Message not found' },
      },
    });
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              messages: [
                {
                  body: { mid: 'mid-auto-delete-delete-metric' },
                  recipient: { chat_id: 'chat-1' },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(throwError(() => deleteError)),
    };
    const actionQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const service = createService(httpService, {}, actionQueue);
    const actionHealthService = (service as any).actionHealthService;

    await service.ensureSendAutoDeleteScheduled(
      {
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        botId: '777000_bot',
        text: 'Moderation notice',
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        ignoreFailureMetricStatuses: [403, 404],
        autoDeleteDelayMs: 60_000,
        attempt: 1,
        idempotencyKey: 'send-auto-delete-production-metrics',
        createdAt: '2026-09-03T08:00:00.000Z',
      },
      {
        remoteMessageId: 'mid-auto-delete-delete-metric',
        dispatchBotId: '777000_bot',
        completedAt: new Date('2026-09-03T08:00:00.000Z'),
      },
    );
    const autoDeleteJob = actionQueue.add.mock.calls[0]?.[1] as MaxActionJob;
    const presence = jest.spyOn(service, 'getExactMessagePresence');

    await expect(service.executeActionJob(autoDeleteJob)).rejects.toBe(deleteError);

    expect(autoDeleteJob).toEqual(
      expect.objectContaining({
        actionType: 'DELETE_MESSAGE',
        messageId: 'mid-auto-delete-delete-metric',
        trafficClass: 'interactive',
        actionHealthLane: 'background',
      }),
    );
    expect(autoDeleteJob).not.toEqual(
      expect.objectContaining({ ignoreFailureMetricStatuses: expect.anything() }),
    );
    expect(presence).toHaveBeenCalledWith('chat-1', 'mid-auto-delete-delete-metric', {
      boundObject: { kind: 'send', id: 'send-auto-delete-production-metrics' },
      botId: '777000_bot',
      trafficClass: 'interactive',
      actionHealthLane: 'background',
      sourceTag: undefined,
      timeoutMs: undefined,
      ignoreFailureMetricStatuses: [403, 404],
      bypassCache: true,
    });
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ method: 'delete' }),
    );
    expect(actionHealthService.recordFailureForLane).toHaveBeenCalledTimes(1);
    expect(actionHealthService.recordFailureForLane).toHaveBeenCalledWith(
      'background',
      false,
      '777000_bot',
    );
    await service.onModuleDestroy();
  });

  it('checks the immediate delete guard at the final boundary before MAX HTTP', async () => {
    const guardError = new Error('photo ordering lease lost');
    const events: string[] = [];
    const httpService = {
      request: jest.fn(() => {
        events.push('max-http');
        return of({ status: 200, data: { success: true } });
      }),
    };
    const beforeImmediateDeleteMutation = jest.fn(async () => {
      events.push('delete-guard');
      throw guardError;
    });
    const service = createService(httpService);

    await expect(
      service.deleteMessage('chat-1', 'mid-delete-guard-1', {
        immediate: true,
        botId: '777000_bot',
        beforeImmediateDeleteMutation,
      }),
    ).rejects.toBe(guardError);

    expect(events).toEqual(['delete-guard']);
    expect(beforeImmediateDeleteMutation).toHaveBeenCalledTimes(1);
    expect((guardError as Error & { code?: string }).code).toBe(
      MAX_DELETE_PRE_DISPATCH_GUARD_REJECTED_CODE,
    );
    expect(httpService.request).not.toHaveBeenCalled();
    expect((service as any).actionHealthService.recordFailureForLane).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it.each(['missing', 'repeated', 'swallowed-quota-error'] as const)(
    'refuses a malformed final authority checkpoint without HTTP: %s',
    async (failure) => {
      const httpService = { request: jest.fn() };
      const service = createService(httpService);
      const quotaError = new MaxApiInternalRateLimitError('Fixture local quota', 250);
      const reserve = jest.spyOn(service as any, 'reserveRateLimitSlot');
      reserve.mockImplementation(async () => {
        if (failure === 'swallowed-quota-error') throw quotaError;
        return undefined;
      });
      const guard = withMaxFinalAuthorityCheckpoint(async (checkpoint) => {
        if (failure === 'missing') return;
        if (failure === 'swallowed-quota-error') {
          await checkpoint!().catch(() => undefined);
          return;
        }
        await checkpoint!();
        await checkpoint!().catch(() => undefined);
      });
      try {
        const sending = service.sendMessage('chat-1', 'Guarded fixture', undefined, {
          immediate: true,
          beforeImmediateSendMutation: guard,
        });
        if (failure === 'swallowed-quota-error') await expect(sending).rejects.toBe(quotaError);
        else await expect(sending).rejects.toThrow('MAX final authority checkpoint');
        expect(reserve).toHaveBeenCalledTimes(failure === 'missing' ? 0 : 1);
        expect(httpService.request).not.toHaveBeenCalled();
      } finally {
        await service.onModuleDestroy();
      }
    },
  );

  it('checks the immediate send guard after limiter and dispatch claim before MAX HTTP', async () => {
    const guardError = new Error('night transition changed while waiting for limiter');
    const events: string[] = [];
    let current = true;
    let releaseLimiter: () => void = () => undefined;
    const limiterGate = new Promise<void>((resolve) => {
      releaseLimiter = resolve;
    });
    let markLimiterEntered: () => void = () => undefined;
    const limiterEntered = new Promise<void>((resolve) => {
      markLimiterEntered = resolve;
    });
    const httpService = {
      request: jest.fn(() => {
        events.push('max-http');
        return of({ status: 200, data: { message_id: 'unexpected-message' } });
      }),
    };
    const actionLedgerService = {
      isIrreversibleAction: jest.fn().mockReturnValue(true),
      assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordSucceeded: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockResolvedValue(undefined),
      getCompletedSendDispatchResult: jest.fn().mockResolvedValue(null),
      claimSendDispatch: jest.fn().mockImplementation(async () => {
        events.push('send-claim');
        return { kind: 'claimed', dispatchToken: 'dispatch-token-night-1' };
      }),
      completeSendDispatch: jest.fn(),
      releaseSendDispatch: jest.fn().mockImplementation(async () => {
        events.push('send-release');
      }),
      recordAmbiguousSendDispatch: jest.fn(),
    };
    const beforeImmediateSendMutation = jest.fn(async () => {
      events.push('send-guard');
      if (!current) {
        throw guardError;
      }
    });
    const service = createService(httpService, {}, undefined, actionLedgerService);
    jest.spyOn(service as any, 'reserveRateLimitSlot').mockImplementation(async () => {
      events.push('limiter-enter');
      markLimiterEntered();
      await limiterGate;
      events.push('limiter-exit');
    });

    const sending = service.sendMessage('chat-1', 'Night notice', undefined, {
      immediate: true,
      botId: '777000_bot',
      idempotencyKey: 'night-mode:close:chat-1:session:session-guard-1',
      beforeImmediateSendMutation,
    });
    await limiterEntered;
    expect(actionLedgerService.claimSendDispatch).toHaveBeenCalledTimes(1);
    expect(beforeImmediateSendMutation).not.toHaveBeenCalled();
    current = false;
    releaseLimiter();

    await expect(sending).rejects.toBe(guardError);
    expect(events).toEqual([
      'send-claim',
      'limiter-enter',
      'limiter-exit',
      'send-guard',
      'send-release',
    ]);
    expect((guardError as Error & { code?: string }).code).toBe(
      MAX_SEND_PRE_DISPATCH_GUARD_REJECTED_CODE,
    );
    expect(actionLedgerService.releaseSendDispatch).toHaveBeenCalledTimes(1);
    expect(actionLedgerService.completeSendDispatch).not.toHaveBeenCalled();
    expect(actionLedgerService.recordFailed).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'SEND_MESSAGE',
        idempotencyKey: expect.stringMatching(/^max-action__explicit__777000_bot__send_message__/),
      }),
      guardError,
    );
    expect(httpService.request).not.toHaveBeenCalled();
    expect((service as any).actionHealthService.recordFailureForLane).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it.each(['terminal', 'caller'] as const)(
    'retains the %s failure policy after a one-shot immediate send guard refuses HTTP',
    async (policy) => {
      const refusal = new Error('Start authority expired before transport');
      const httpService = { request: jest.fn() };
      const ledger: jest.Mocked<
        Pick<
          MaxActionLedgerService,
          | 'isIrreversibleAction'
          | 'assertCanEnqueue'
          | 'recordStarted'
          | 'recordFailed'
          | 'recordSucceeded'
          | 'getCompletedSendDispatchResult'
          | 'claimSendDispatch'
          | 'releaseSendDispatch'
          | 'recordAmbiguousSendDispatch'
        >
      > = {
        isIrreversibleAction: jest.fn().mockReturnValue(true),
        assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
        recordStarted: jest.fn().mockResolvedValue(undefined),
        recordFailed: jest.fn().mockResolvedValue(undefined),
        recordSucceeded: jest.fn().mockResolvedValue(undefined),
        getCompletedSendDispatchResult: jest.fn().mockResolvedValue(null),
        claimSendDispatch: jest.fn().mockResolvedValue({ kind: 'claimed', dispatchToken: 'start' }),
        releaseSendDispatch: jest.fn().mockResolvedValue(undefined),
        recordAmbiguousSendDispatch: jest.fn().mockResolvedValue(true),
      };
      const guard = jest.fn(async () => {
        throw refusal;
      });
      const options: MaxActionDispatchOptions = {
        immediate: true,
        botId: '777000_bot',
        idempotencyKey: `one-shot-start-${policy}`,
        beforeImmediateSendMutation: guard,
        ...(policy === 'terminal' ? { immediateFailurePolicy: 'terminal' } : {}),
      };
      const service = createService(httpService, {}, undefined, ledger);
      try {
        await expect(service.sendMessage('chat-1', 'Connected', undefined, options)).rejects.toBe(
          refusal,
        );
        expect(wasMaxPreDispatchGuardRejected(refusal)).toBe(true);
        expect(wasMaxMessageSendAttempted(refusal)).toBe(false);
        expect(guard).toHaveBeenCalledTimes(1);
        expect(httpService.request).not.toHaveBeenCalled();
        expect(ledger.releaseSendDispatch).toHaveBeenCalledTimes(1);
        const job = ledger.recordStarted.mock.calls[0]![0];
        expect(ledger.releaseSendDispatch).toHaveBeenCalledWith(job, 'start');
        expect(ledger.recordFailed.mock.calls).toEqual([
          policy === 'terminal' ? [job, refusal, { exhausted: true }] : [job, refusal],
        ]);
        expect(ledger.recordSucceeded).not.toHaveBeenCalled();
        expect(ledger.recordAmbiguousSendDispatch).not.toHaveBeenCalled();
      } finally {
        await service.onModuleDestroy();
      }
    },
  );

  it('keeps a one-shot immediate unknown SEND fenced before the next call reaches HTTP', async () => {
    const timeout = Object.assign(new Error('Start confirmation response timed out'), {
      code: 'ETIMEDOUT',
    });
    const quarantinedError = new UnrecoverableError('Unknown Start send requires manual review');
    const httpService = { request: jest.fn(() => throwError(() => timeout)) };
    let quarantined = false;
    const ledger: jest.Mocked<
      Pick<
        MaxActionLedgerService,
        | 'isIrreversibleAction'
        | 'assertCanEnqueue'
        | 'recordStarted'
        | 'recordFailed'
        | 'recordSucceeded'
        | 'getCompletedSendDispatchResult'
        | 'claimSendDispatch'
        | 'releaseSendDispatch'
        | 'recordAmbiguousSendDispatch'
      >
    > = {
      isIrreversibleAction: jest.fn().mockReturnValue(true),
      assertCanEnqueue: jest.fn<
        ReturnType<MaxActionLedgerService['assertCanEnqueue']>,
        Parameters<MaxActionLedgerService['assertCanEnqueue']>
      >(async () => {
        if (quarantined) throw quarantinedError;
      }),
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockResolvedValue(undefined),
      recordSucceeded: jest.fn().mockResolvedValue(undefined),
      getCompletedSendDispatchResult: jest.fn().mockResolvedValue(null),
      claimSendDispatch: jest.fn().mockResolvedValue({ kind: 'claimed', dispatchToken: 'unknown' }),
      releaseSendDispatch: jest.fn().mockResolvedValue(undefined),
      recordAmbiguousSendDispatch: jest.fn<
        ReturnType<MaxActionLedgerService['recordAmbiguousSendDispatch']>,
        Parameters<MaxActionLedgerService['recordAmbiguousSendDispatch']>
      >(async () => {
        quarantined = true;
        return true;
      }),
    };
    const options: MaxActionDispatchOptions = {
      immediate: true,
      immediateFailurePolicy: 'terminal',
      botId: '777000_bot',
      idempotencyKey: 'one-shot-unknown-start',
    };
    const service = createService(httpService, {}, undefined, ledger);
    try {
      await expect(
        service.sendMessage('chat-1', 'Connected', undefined, options),
      ).rejects.toBeInstanceOf(UnrecoverableError);
      await expect(service.sendMessage('chat-1', 'Connected', undefined, options)).rejects.toBe(
        quarantinedError,
      );
      expect(httpService.request).toHaveBeenCalledTimes(1);
      expect(ledger.recordStarted).toHaveBeenCalledTimes(1);
      expect(ledger.recordAmbiguousSendDispatch).toHaveBeenCalledTimes(1);
      expect(ledger.releaseSendDispatch).not.toHaveBeenCalled();
      expect(ledger.recordSucceeded).not.toHaveBeenCalled();
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('requires explicit immediate dispatch for terminal failure settlement', async () => {
    const httpService = {
      request: jest.fn(() => of({ status: 200, data: { message_id: 'unexpected-send' } })),
    };
    const options: MaxActionDispatchOptions = {
      immediateFailurePolicy: 'terminal',
    };
    const service = createService(httpService);
    try {
      await expect(service.sendMessage('chat-1', 'Connected', undefined, options)).rejects.toThrow(
        'Terminal failure settlement requires immediate dispatch',
      );
      expect(httpService.request).not.toHaveBeenCalled();
    } finally {
      await service.onModuleDestroy();
    }
  });

  describe('SEND capacity origin', () => {
    function fixture() {
      const now = Date.now();
      const http = { request: jest.fn() };
      const ledger: jest.Mocked<
        Pick<
          MaxActionLedgerService,
          | 'getCompletedSendDispatchResult'
          | 'claimSendDispatch'
          | 'releaseSendDispatch'
          | 'recordAmbiguousSendDispatch'
        >
      > = {
        getCompletedSendDispatchResult: jest.fn().mockResolvedValue(null),
        claimSendDispatch: jest.fn().mockResolvedValue({ kind: 'claimed', dispatchToken: 'quota' }),
        releaseSendDispatch: jest.fn().mockResolvedValue(undefined),
        recordAmbiguousSendDispatch: jest.fn().mockResolvedValue(true),
      };
      const notice: jest.Mocked<Pick<MaxModerationRuleNoticeGuardService, 'assertAllowed'>> = {
        assertAllowed: jest.fn<
          ReturnType<MaxModerationRuleNoticeGuardService['assertAllowed']>,
          Parameters<MaxModerationRuleNoticeGuardService['assertAllowed']>
        >(async (_action, _botId, _reader, checkpoint) => {
          await checkpoint?.();
        }),
      };
      const service = createService(
        http,
        { MAX_API_RATE_LIMIT_WAIT_MS_CRITICAL: '0' },
        undefined,
        ledger,
      );
      Object.defineProperty(service, 'moderationRuleNoticeGuard', { value: notice });
      const quota = observeActionFailureDiagnostics(service).quota;
      const job: MaxActionJob = {
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        botId: '777000_bot',
        text: 'Synthetic moderation notice',
        sourceTag: MAX_API_SOURCE_TAGS.MODERATION_NOTICE,
        trafficClass: 'critical',
        attempt: 1,
        idempotencyKey: 'current-send-capacity',
        createdAt: new Date(now).toISOString(),
        ledgerContext: {
          moderationRuleNotice: {
            version: 1,
            chatId: 'chat-1',
            messageId: 'synthetic-source',
            userId: 'human',
            reasonKey: 'LINKS_BLOCKED_DELETE:synthetic-source',
            ruleCode: 'LINKS',
            policySha256: 'a'.repeat(64),
            deadlineAtMs: now + 300_000,
          },
        },
      };
      return { now, http, ledger, notice, service, quota, job };
    }

    it('certifies the actual limiter refusal only after releasing this SEND fence', async () => {
      const f = fixture();
      f.quota.mockResolvedValueOnce([1, 0, 0]).mockResolvedValueOnce([0, 1, 60_000]);
      try {
        const error = await f.service.executeActionJob(f.job).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(MaxApiInternalRateLimitError);
        expect(wasMaxPreDispatchGuardRejected(error)).toBe(true);
        expect(wasMaxMessageSendAttempted(error)).toBe(false);
        expect(f.ledger.releaseSendDispatch).toHaveBeenCalledTimes(1);
        expect(f.http.request).not.toHaveBeenCalled();
        expect(f.ledger.recordAmbiguousSendDispatch).not.toHaveBeenCalled();
        const deferral = readMaxSendCapacityDeferral(error, f.job, f.now);
        expect(deferral).toBeInstanceOf(MaxSendCapacityDeferralError);
        expect(deferral).toMatchObject({
          jobId: f.job.idempotencyKey,
          retryAtMs: f.now + 60_000,
          deadlineAtMs: f.now + 300_000,
        });
        expect(readMaxSendCapacityDeferral(error, f.job, f.now)).toBeNull();
      } finally {
        await f.service.onModuleDestroy();
      }
    });

    it('keeps an uncertain fence release ambiguous without certifying a capacity retry', async () => {
      const f = fixture();
      const releaseError = new Error('SEND fence release unavailable');
      f.ledger.releaseSendDispatch.mockRejectedValueOnce(releaseError);
      f.quota.mockResolvedValueOnce([1, 0, 0]).mockResolvedValueOnce([0, 1, 60_000]);
      try {
        const error = await f.service.executeActionJob(f.job).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(UnrecoverableError);
        expect(f.ledger.releaseSendDispatch).toHaveBeenCalledTimes(1);
        expect(f.ledger.recordAmbiguousSendDispatch).toHaveBeenCalledWith(
          expect.objectContaining({ idempotencyKey: f.job.idempotencyKey }),
          'quota',
          error,
        );
        expect(readMaxSendCapacityDeferral(error, f.job, f.now)).toBeNull();
        expect(f.http.request).not.toHaveBeenCalled();
      } finally {
        await f.service.onModuleDestroy();
      }
    });

    it('refuses a real nested GET quota error from the SEND final guard', async () => {
      const f = fixture();
      f.notice.assertAllowed.mockImplementationOnce(async () => {
        await f.service.getCurrentChatMemberAccess(f.job.chatId, {
          botId: f.job.botId,
          bypassCache: true,
          trafficClass: 'critical',
        });
      });
      f.quota
        .mockResolvedValueOnce([1, 0, 0])
        .mockResolvedValueOnce([1, 0, 0])
        .mockResolvedValueOnce([0, 1, 60_000]);
      try {
        const error = await f.service.executeActionJob(f.job).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(MaxApiInternalRateLimitError);
        expect(wasMaxPreDispatchGuardRejected(error)).toBe(true);
        expect(f.ledger.releaseSendDispatch).toHaveBeenCalledTimes(1);
        expect(readMaxSendCapacityDeferral(error, f.job, f.now)).toBeNull();
        expect(f.http.request).not.toHaveBeenCalled();
      } finally {
        await f.service.onModuleDestroy();
      }
    });

    it('refuses an unconsumed genuine quota error borrowed from the prior SEND invocation', async () => {
      const f = fixture();
      f.quota.mockResolvedValueOnce([1, 0, 0]).mockResolvedValueOnce([0, 1, 60_000]);
      try {
        const oldError = await f.service.executeActionJob(f.job).catch((caught: unknown) => caught);
        expect(oldError).toBeInstanceOf(MaxApiInternalRateLimitError);
        f.notice.assertAllowed.mockRejectedValueOnce(oldError);
        await expect(f.service.executeActionJob(f.job)).rejects.toBe(oldError);
        expect(f.ledger.releaseSendDispatch).toHaveBeenCalledTimes(2);
        expect(readMaxSendCapacityDeferral(oldError, f.job, f.now)).toBeNull();
        expect(f.http.request).not.toHaveBeenCalled();
      } finally {
        await f.service.onModuleDestroy();
      }
    });
  });

  it.each([false, true])(
    'keeps the Publisher greeting fence after Redis job restoration (ambiguous=%s)',
    async (ambiguous) => {
      const previousRole = process.env.APP_ROLE;
      const previousService = process.env.APP_SERVICE_NAME;
      process.env.APP_ROLE = 'publisher';
      process.env.APP_SERVICE_NAME = 'api-publisher';
      let claimed = false;
      let dispatchToken: string | null = null;
      let remoteMessageId: string | null = null;
      const actionLedgerService = {
        isIrreversibleAction: jest.fn().mockReturnValue(true),
        assertCanEnqueue: jest.fn(async () => {
          if (dispatchToken && !remoteMessageId) throw new UnrecoverableError('manual review');
        }),
        recordStarted: jest.fn().mockResolvedValue(undefined),
        recordSucceeded: jest.fn().mockResolvedValue(undefined),
        recordFailed: jest.fn().mockResolvedValue(undefined),
        getCompletedSendDispatchResult: jest.fn(async () =>
          remoteMessageId
            ? { remoteMessageId, dispatchBotId: '777000_bot', completedAt: new Date() }
            : null,
        ),
        claimSendDispatch: jest.fn<
          ReturnType<MaxActionLedgerService['claimSendDispatch']>,
          Parameters<MaxActionLedgerService['claimSendDispatch']>
        >(async () => {
          if (dispatchToken) throw new UnrecoverableError('retained dispatch');
          dispatchToken = 'durable-token';
          return { kind: 'claimed', dispatchToken };
        }),
        completeSendDispatch: jest.fn(async (_job, _token, messageId) => {
          remoteMessageId = messageId;
          return new Date();
        }),
        recordAmbiguousSendDispatch: jest.fn().mockResolvedValue(true),
      };
      const httpService = {
        request: jest.fn(() =>
          ambiguous
            ? throwError(() => Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }))
            : of({ status: 200, data: { message_id: 'publisher-greeting' } }),
        ),
      };
      const service = createService(httpService, {}, undefined, actionLedgerService);
      const processor = new PublisherStartProcessor(
        service,
        { getPublisherBotDescriptor: () => ({ id: '777000_bot' }) } as never,
        { buildMiniappStartUrlSync: () => null } as never,
        { get: () => undefined } as never,
        { assertDispatchEnabled: () => undefined } as never,
        { assertAttested: async () => undefined } as never,
        { assertDispatchAllowed: async () => undefined } as never,
        {
          claimDispatch: async () => {
            if (claimed) return false;
            claimed = true;
            return true;
          },
        } as never,
      );
      const original: PublisherStartJob = {
        version: 2,
        publisherBotId: '777000_bot',
        privateChatId: '123',
        requestedAt: new Date().toISOString(),
      };
      const restoredJob = () => {
        const job = {
          id: 'publisher-start-snapshot-fixture',
          data: { ...original },
          updateData: async (data: PublisherStartJob) => {
            job.data = data;
          },
        };
        return job as unknown as Job<PublisherStartJob>;
      };
      try {
        if (ambiguous) await expect(processor.process(restoredJob())).rejects.toThrow();
        else await processor.process(restoredJob());
        expect(httpService.request).toHaveBeenCalledTimes(1);
        expect(actionLedgerService.claimSendDispatch).toHaveBeenCalledTimes(1);
        claimed = false;
        (Redis as unknown as { __store: Map<string, unknown> }).__store.clear();
        if (ambiguous)
          await expect(processor.process(restoredJob())).rejects.toThrow('manual review');
        else await processor.process(restoredJob());
        expect(httpService.request).toHaveBeenCalledTimes(1);
        expect(actionLedgerService.claimSendDispatch).toHaveBeenCalledTimes(1);
        const jobs = actionLedgerService.assertCanEnqueue.mock.calls as unknown as [MaxActionJob][];
        expect(jobs).toHaveLength(2);
        expect(jobs[0][0].idempotencyKey).toBe(jobs[1][0].idempotencyKey);
        expect(jobs[0][0]).toMatchObject({ botId: '777000_bot', sourceTag: 'publisher_start' });
      } finally {
        await service.onModuleDestroy();
        if (previousRole === undefined) delete process.env.APP_ROLE;
        else process.env.APP_ROLE = previousRole;
        if (previousService === undefined) delete process.env.APP_SERVICE_NAME;
        else process.env.APP_SERVICE_NAME = previousService;
      }
    },
  );

  it('rejects an ephemeral send guard on queued dispatch', async () => {
    const beforeImmediateSendMutation = jest.fn();
    const actionQueue = { add: jest.fn(), getJob: jest.fn() };
    const service = createService({ request: jest.fn() }, {}, actionQueue);

    await expect(
      service.sendMessage('chat-1', 'hello', undefined, {
        beforeImmediateSendMutation,
      }),
    ).rejects.toThrow('Send mutation guard requires immediate dispatch');

    expect(beforeImmediateSendMutation).not.toHaveBeenCalled();
    expect(actionQueue.add).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('rejects an immediate send guard for a non-send action', async () => {
    const beforeImmediateSendMutation = jest.fn();
    const service = createService({ request: jest.fn() });

    await expect(
      service.deleteMessage('chat-1', 'mid-delete-with-send-guard', {
        immediate: true,
        beforeImmediateSendMutation,
      }),
    ).rejects.toThrow('Send mutation guard requires a message send action');

    expect(beforeImmediateSendMutation).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('returns a recovered immediate send without rewriting its terminal ledger state', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-31T12:00:30.000Z'));
    const httpService = { request: jest.fn() };
    const beforeImmediateSendMutation = jest.fn();
    const actionQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const actionLedgerService = {
      isIrreversibleAction: jest.fn().mockReturnValue(true),
      assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordSucceeded: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockResolvedValue(undefined),
      recordEnqueuedIfAbsent: jest.fn().mockResolvedValue(undefined),
      getCompletedSendDispatchResult: jest.fn().mockResolvedValue({
        remoteMessageId: 'mid-immediate-recovered-1',
        dispatchBotId: '777000_bot',
        completedAt: new Date('2026-08-31T12:00:00.000Z'),
      }),
      claimSendDispatch: jest.fn(),
      completeSendDispatch: jest.fn(),
      releaseSendDispatch: jest.fn(),
      recordAmbiguousSendDispatch: jest.fn(),
    };
    const service = createService(httpService, {}, actionQueue, actionLedgerService);

    await expect(
      service.sendMessage('chat-1', 'Night notice', undefined, {
        immediate: true,
        botId: '777000_bot',
        idempotencyKey: 'night-mode:open:chat-1:session:session-recovered-1',
        autoDeleteDelayMs: 60_000,
        beforeImmediateSendMutation,
      }),
    ).resolves.toEqual({
      messageId: 'mid-immediate-recovered-1',
      url: null,
      recoveredSendDispatch: {
        dispatchBotId: '777000_bot',
      },
    });

    expect(actionLedgerService.assertCanEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: expect.stringMatching(/^max-action__explicit__777000_bot__send_message__/),
      }),
    );
    expect(actionLedgerService.recordStarted).toHaveBeenCalledTimes(1);
    expect(actionLedgerService.recordSucceeded).not.toHaveBeenCalled();
    expect(actionLedgerService.recordFailed).not.toHaveBeenCalled();
    expect(actionLedgerService.claimSendDispatch).not.toHaveBeenCalled();
    expect(beforeImmediateSendMutation).not.toHaveBeenCalled();
    expect(httpService.request).not.toHaveBeenCalled();
    expect(actionQueue.add).toHaveBeenCalledWith(
      'execute-max-action',
      expect.objectContaining({
        actionType: 'DELETE_MESSAGE',
        chatId: 'chat-1',
        messageId: 'mid-immediate-recovered-1',
        botId: '777000_bot',
        sendAutoDelete: expect.objectContaining({
          version: MAX_SEND_AUTO_DELETE_MARKER_VERSION,
          sourceSendCompletedAt: '2026-08-31T12:00:00.000Z',
          requestedDelayMs: 60_000,
          originBotId: '777000_bot',
        }),
      }),
      expect.objectContaining({ delay: 30_000 }),
    );

    await service.onModuleDestroy();
  });

  it('rejects an ephemeral delete guard on queued dispatch', async () => {
    const beforeImmediateDeleteMutation = jest.fn();
    const actionQueue = { add: jest.fn(), getJob: jest.fn() };
    const service = createService({ request: jest.fn() }, {}, actionQueue);

    await expect(
      service.deleteMessage('chat-1', 'mid-delete-guard-queued-1', {
        beforeImmediateDeleteMutation,
      }),
    ).rejects.toThrow('Delete mutation guard requires immediate dispatch');

    expect(beforeImmediateDeleteMutation).not.toHaveBeenCalled();
    expect(actionQueue.add).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it.each([
    { label: 'success=false', payload: { success: false } },
    { label: 'missing success', payload: {} },
  ])('rejects a 200 delete response with $label', async ({ payload }) => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: payload,
        }),
      ),
    };
    const service = createService(httpService);

    const deletion = service.executeActionJob({
      actionType: 'DELETE_MESSAGE',
      chatId: 'chat-1',
      messageId: 'mid-delete-rejected-1',
      attempt: 1,
      idempotencyKey: 'delete-rejected',
      createdAt: new Date().toISOString(),
    });

    await expect(deletion).rejects.toBeInstanceOf(MaxApiRequestRejectedError);
    await expect(deletion).rejects.toMatchObject({
      response: {
        status: 200,
        data: payload,
      },
    });

    await service.onModuleDestroy();
  });

  it('marks ambiguous queued SEND_MESSAGE transport timeouts as unrecoverable', async () => {
    const timeoutError = Object.assign(new Error('timeout of 1500ms exceeded'), {
      code: 'ECONNABORTED',
    });
    const httpService = {
      request: jest.fn(() => throwError(() => timeoutError)),
    };
    const service = createService(httpService);

    await expect(
      service.executeActionJob({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        text: 'hello',
        attempt: 1,
        idempotencyKey: 'send-timeout',
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
      }),
    );

    await service.onModuleDestroy();
  });

  it('persists the SEND_MESSAGE remote id behind the dispatch token before returning', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            mid: 'mid-fenced-1',
          },
        }),
      ),
    };
    const actionLedgerService = {
      claimSendDispatch: jest.fn().mockResolvedValue({
        kind: 'claimed',
        dispatchToken: 'dispatch-token-1',
      }),
      completeSendDispatch: jest.fn().mockResolvedValue(undefined),
      releaseSendDispatch: jest.fn().mockResolvedValue(undefined),
      recordAmbiguousSendDispatch: jest.fn().mockResolvedValue(true),
    };
    const service = createService(httpService, {}, undefined, actionLedgerService);
    const job = {
      actionType: 'SEND_MESSAGE' as const,
      chatId: 'chat-1',
      text: 'hello',
      attempt: 1,
      idempotencyKey: 'send-fenced-success',
      createdAt: new Date().toISOString(),
    };

    await service.executeActionJob(job);

    expect(actionLedgerService.claimSendDispatch).toHaveBeenCalledWith(job, '777000_bot');
    expect(actionLedgerService.completeSendDispatch).toHaveBeenCalledWith(
      job,
      'dispatch-token-1',
      'mid-fenced-1',
    );
    expect(actionLedgerService.releaseSendDispatch).not.toHaveBeenCalled();
    expect(actionLedgerService.recordAmbiguousSendDispatch).not.toHaveBeenCalled();
    expect(actionLedgerService.claimSendDispatch.mock.invocationCallOrder[0]).toBeLessThan(
      httpService.request.mock.invocationCallOrder[0],
    );
    expect(httpService.request.mock.invocationCallOrder[0]).toBeLessThan(
      actionLedgerService.completeSendDispatch.mock.invocationCallOrder[0],
    );

    await service.onModuleDestroy();
  });

  it('releases the send fence when the final pre-HTTP guard rejects', async () => {
    const httpService = { request: jest.fn() };
    const actionLedgerService = {
      claimSendDispatch: jest.fn().mockResolvedValue({
        kind: 'claimed',
        dispatchToken: 'dispatch-token-guard-1',
      }),
      completeSendDispatch: jest.fn(),
      releaseSendDispatch: jest.fn().mockResolvedValue(undefined),
      recordAmbiguousSendDispatch: jest.fn(),
    };
    const service = createService(httpService, {}, undefined, actionLedgerService);
    const guardError = new Error('suggestion claim changed');
    const beforeSendMutation = jest.fn().mockRejectedValue(guardError);
    const job = {
      actionType: 'SEND_MESSAGE' as const,
      chatId: 'channel-1',
      text: 'publication',
      attempt: 1,
      idempotencyKey: 'channel-suggestion:publish:v1:suggestion-guard-1',
      createdAt: new Date().toISOString(),
    };

    await expect(service.executeActionJob(job, { beforeSendMutation })).rejects.toBe(guardError);

    expect(actionLedgerService.claimSendDispatch).toHaveBeenCalledWith(job, '777000_bot');
    expect(beforeSendMutation).toHaveBeenCalledTimes(1);
    expect(actionLedgerService.releaseSendDispatch).toHaveBeenCalledWith(
      job,
      'dispatch-token-guard-1',
    );
    expect(httpService.request).not.toHaveBeenCalled();
    expect(actionLedgerService.completeSendDispatch).not.toHaveBeenCalled();
    expect(actionLedgerService.recordAmbiguousSendDispatch).not.toHaveBeenCalled();
    expect(actionLedgerService.claimSendDispatch.mock.invocationCallOrder[0]).toBeLessThan(
      beforeSendMutation.mock.invocationCallOrder[0],
    );

    await service.onModuleDestroy();
  });

  it('recovers a persisted SEND_MESSAGE result without another MAX request', async () => {
    const httpService = {
      request: jest.fn(),
    };
    const actionLedgerService = {
      claimSendDispatch: jest.fn().mockResolvedValue({
        kind: 'recovered',
        remoteMessageId: 'mid-recovered-1',
        dispatchBotId: 'bot-1',
      }),
      completeSendDispatch: jest.fn(),
      releaseSendDispatch: jest.fn(),
      recordAmbiguousSendDispatch: jest.fn(),
    };
    const service = createService(httpService, {}, undefined, actionLedgerService);

    await expect(
      service.executeActionJob({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        text: 'hello',
        attempt: 2,
        idempotencyKey: 'send-fenced-recovered',
        createdAt: new Date().toISOString(),
      }),
    ).resolves.toEqual({
      messageId: 'mid-recovered-1',
      url: null,
      recoveredSendDispatch: {
        dispatchBotId: 'bot-1',
      },
    });

    expect(httpService.request).not.toHaveBeenCalled();
    expect(actionLedgerService.completeSendDispatch).not.toHaveBeenCalled();
    expect(actionLedgerService.releaseSendDispatch).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('propagates a completion that appears between the early ledger read and dispatch claim', async () => {
    const httpService = { request: jest.fn() };
    let signalClaimEntered: (() => void) | undefined;
    const claimEntered = new Promise<void>((resolve) => {
      signalClaimEntered = resolve;
    });
    let resolveClaim:
      | ((value: {
          kind: 'recovered';
          remoteMessageId: string;
          dispatchBotId: string | null;
        }) => void)
      | undefined;
    const claimResult = new Promise<{
      kind: 'recovered';
      remoteMessageId: string;
      dispatchBotId: string | null;
    }>((resolve) => {
      resolveClaim = resolve;
    });
    const actionLedgerService = {
      getCompletedSendDispatchResult: jest.fn().mockResolvedValue(null),
      claimSendDispatch: jest.fn().mockImplementation(async () => {
        signalClaimEntered?.();
        return claimResult;
      }),
      completeSendDispatch: jest.fn(),
      releaseSendDispatch: jest.fn(),
      recordAmbiguousSendDispatch: jest.fn(),
    };
    const service = createService(httpService, {}, undefined, actionLedgerService);
    const job = {
      actionType: 'SEND_MESSAGE' as const,
      chatId: 'channel-1',
      botId: '777000_bot',
      routing: { purpose: 'send_message' as const, requiredBotId: '777000_bot' },
      text: 'publication',
      attempt: 2,
      idempotencyKey: 'channel-suggestion:publish:v1:claim-barrier',
      createdAt: new Date().toISOString(),
    };

    const execution = service.executeActionJob(job);
    await claimEntered;
    resolveClaim?.({
      kind: 'recovered',
      remoteMessageId: 'mid-claim-barrier',
      dispatchBotId: '777000_bot',
    });

    await expect(execution).resolves.toEqual({
      messageId: 'mid-claim-barrier',
      url: null,
      recoveredSendDispatch: {
        dispatchBotId: '777000_bot',
      },
    });
    expect(actionLedgerService.getCompletedSendDispatchResult).toHaveBeenCalledTimes(1);
    expect(httpService.request).not.toHaveBeenCalled();
    expect(actionLedgerService.completeSendDispatch).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it.each([
    { label: 'a foreign bot', dispatchBotId: 'foreign-bot' },
    { label: 'no persisted bot', dispatchBotId: null },
  ])('rejects late required-bot claim recovery from $label', async ({ dispatchBotId }) => {
    const httpService = { request: jest.fn() };
    const actionLedgerService = {
      getCompletedSendDispatchResult: jest.fn().mockResolvedValue(null),
      claimSendDispatch: jest.fn().mockResolvedValue({
        kind: 'recovered',
        remoteMessageId: 'mid-invalid-required-claim',
        dispatchBotId,
      }),
      completeSendDispatch: jest.fn(),
      releaseSendDispatch: jest.fn(),
      recordAmbiguousSendDispatch: jest.fn(),
    };
    const service = createService(httpService, {}, undefined, actionLedgerService);

    await expect(
      service.executeActionJob({
        actionType: 'SEND_MESSAGE',
        chatId: 'channel-1',
        botId: '777000_bot',
        routing: { purpose: 'send_message', requiredBotId: '777000_bot' },
        text: 'publication',
        attempt: 2,
        idempotencyKey: 'channel-suggestion:publish:v1:invalid-required-claim',
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it.each([400, 403, 429])(
    'releases the SEND_MESSAGE dispatch fence after definitive HTTP %s rejection',
    async (status) => {
      const statusError = {
        response: {
          status,
          data: {
            message: 'definitive rejection',
          },
        },
      };
      const httpService = {
        request: jest.fn(() => throwError(() => statusError)),
      };
      const actionLedgerService = {
        claimSendDispatch: jest.fn().mockResolvedValue({
          kind: 'claimed',
          dispatchToken: 'dispatch-token-1',
        }),
        completeSendDispatch: jest.fn(),
        releaseSendDispatch: jest.fn().mockResolvedValue(undefined),
        recordAmbiguousSendDispatch: jest.fn(),
      };
      const service = createService(httpService, {}, undefined, actionLedgerService);
      const job = {
        actionType: 'SEND_MESSAGE' as const,
        chatId: 'chat-1',
        text: 'hello',
        attempt: 1,
        idempotencyKey: `send-fenced-${status}`,
        createdAt: new Date().toISOString(),
      };

      const thrown = await service.executeActionJob(job).then(
        () => null,
        (error: unknown) => error,
      );

      if (status === 429) {
        expect(thrown).toBe(statusError);
      } else {
        expect(thrown).toBeInstanceOf(UnrecoverableError);
        expect(thrown).toHaveProperty('response', statusError.response);
        expect(thrown).toHaveProperty(
          'message',
          `MAX SEND_MESSAGE received definitive HTTP ${status} for chat chat-1`,
        );
      }

      expect(actionLedgerService.releaseSendDispatch).toHaveBeenCalledWith(job, 'dispatch-token-1');
      expect(actionLedgerService.recordAmbiguousSendDispatch).not.toHaveBeenCalled();

      await service.onModuleDestroy();
    },
  );

  it('integrates definitive 403 fence release with routed survivor failover', async () => {
    const denied = {
      response: {
        status: 403,
        data: {
          code: 'chat.denied',
          message: 'chat denied',
        },
      },
    };
    const httpService = {
      request: jest.fn((config: { headers?: { Authorization?: string } }) =>
        config.headers?.Authorization === 'bot-1-token'
          ? throwError(() => denied)
          : of({
              status: 200,
              data: {
                mid: 'mid-survivor-1',
              },
            }),
      ),
    };
    const actionLedgerService = {
      getCompletedSendDispatch: jest.fn().mockResolvedValue(null),
      claimSendDispatch: jest.fn<
        ReturnType<MaxActionLedgerService['claimSendDispatch']>,
        Parameters<MaxActionLedgerService['claimSendDispatch']>
      >(async (_job, botId) => ({
        kind: 'claimed',
        dispatchToken: `dispatch-${botId}`,
      })),
      completeSendDispatch: jest.fn().mockResolvedValue(undefined),
      releaseSendDispatch: jest.fn().mockResolvedValue(undefined),
      recordAmbiguousSendDispatch: jest.fn().mockResolvedValue(true),
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordSucceeded: jest.fn().mockResolvedValue(undefined),
      recordSkipped: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockResolvedValue(undefined),
    };
    const client = createService(httpService, {}, undefined, actionLedgerService);
    const botRegistry = (client as any).botRegistry;
    const defaultBot = botRegistry.getDefaultBot();
    botRegistry.getBotById.mockImplementation((botId?: string | null) => {
      if (!botId || botId === defaultBot.id) {
        return defaultBot;
      }
      if (botId === 'bot-1' || botId === 'bot-2') {
        return {
          ...defaultBot,
          id: botId,
          token: `${botId}-token`,
        };
      }
      return null;
    });
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue({
        classification: {
          kind: 'managed_entity_access_lost',
          reason: 'bot_denied',
          statusCode: 403,
          code: 'chat.denied',
          message: 'chat denied',
        },
        reason: 'bot_denied',
        recorded: {
          chatId: 'chat-1',
          botId: 'bot-1',
          nextOwnerBotId: 'bot-2',
          updatedAccessEdges: 1,
          cleanup: {
            nightModeJobsCleared: false,
            canceledBroadcasts: null,
            canceledBroadcastDeliveries: null,
            canceledBroadcastOccurrences: null,
            clearedVkPublishPosts: null,
            pausedVkSources: null,
            removedRosterSyncJobs: null,
          },
        },
      }),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        reason: 'primary_confirmed',
      }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const dispatch = new MaxActionDispatchService(
      client,
      managedEntityAccessLossService as never,
      actionLedgerService as never,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'on' : undefined)),
      } as never,
    );

    await dispatch.execute({
      actionType: 'SEND_MESSAGE',
      chatId: 'chat-1',
      botId: 'bot-1',
      candidateBotIds: ['bot-1', 'bot-2'],
      routing: { purpose: 'send_message' },
      text: 'hello',
      attempt: 1,
      idempotencyKey: 'send-fenced-survivor',
      createdAt: new Date().toISOString(),
    });

    expect(httpService.request).toHaveBeenCalledTimes(2);
    expect(actionLedgerService.releaseSendDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'bot-1' }),
      'dispatch-bot-1',
    );
    expect(actionLedgerService.completeSendDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'bot-2' }),
      'dispatch-bot-2',
      'mid-survivor-1',
    );
    expect(actionLedgerService.recordAmbiguousSendDispatch).not.toHaveBeenCalled();

    await client.onModuleDestroy();
  });

  it.each([
    {
      label: 'timeout',
      error: Object.assign(new Error('timeout of 1500ms exceeded'), {
        code: 'ECONNABORTED',
      }),
    },
    {
      label: 'HTTP 500',
      error: {
        response: {
          status: 500,
          data: {
            message: 'server failure',
          },
        },
      },
    },
  ])('retains and quarantines the SEND_MESSAGE fence after $label', async ({ error }) => {
    const httpService = {
      request: jest.fn(() => throwError(() => error)),
    };
    const retainedFenceError = Object.assign(
      new UnrecoverableError('Ambiguous MAX SEND_MESSAGE dispatch fence requires manual review'),
      { maxSendDispatchLedgerFinalized: true },
    );
    const actionLedgerService = {
      claimSendDispatch: jest
        .fn()
        .mockResolvedValueOnce({
          kind: 'claimed',
          dispatchToken: 'dispatch-token-1',
        })
        .mockRejectedValueOnce(retainedFenceError),
      completeSendDispatch: jest.fn(),
      releaseSendDispatch: jest.fn(),
      recordAmbiguousSendDispatch: jest.fn().mockResolvedValue(true),
    };
    const service = createService(httpService, {}, undefined, actionLedgerService);
    const job = {
      actionType: 'SEND_MESSAGE' as const,
      chatId: 'chat-1',
      text: 'hello',
      attempt: 1,
      idempotencyKey: 'send-fenced-ambiguous',
      createdAt: new Date().toISOString(),
    };

    await expect(service.executeActionJob(job)).rejects.toMatchObject({
      name: 'UnrecoverableError',
      maxSendDispatchLedgerFinalized: true,
    });
    await expect(
      service.executeActionJob({
        ...job,
        attempt: 2,
      }),
    ).rejects.toBe(retainedFenceError);

    expect(httpService.request).toHaveBeenCalledTimes(1);
    expect(actionLedgerService.releaseSendDispatch).not.toHaveBeenCalled();
    expect(actionLedgerService.recordAmbiguousSendDispatch).toHaveBeenCalledWith(
      job,
      'dispatch-token-1',
      expect.any(UnrecoverableError),
    );

    await service.onModuleDestroy();
  });

  it('inherits queued send dispatch context when scheduling auto-delete', async () => {
    const sourceCreatedAt = new Date().toISOString();
    const ledgerContext = {
      moderationSource: {
        version: 1,
        chatId: 'chat-1',
        messageId: 'original-source',
        userId: 'original-author',
      },
    };
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            mid: 'mid-sent-1',
          },
        }),
      ),
    };
    const actionQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const service = createService(httpService, {}, actionQueue);

    await service.executeActionJob({
      actionType: 'SEND_MESSAGE',
      chatId: 'chat-1',
      messageId: 'original-source',
      userId: 'original-author',
      ledgerContext,
      options: { messageLink: { type: 'reply', mid: 'reply-source' } },
      text: 'hello',
      botId: '777000_bot',
      trafficClass: 'background',
      actionHealthLane: 'background',
      sourceTag: MAX_API_SOURCE_TAGS.MANAGED_BROADCAST,
      timeoutMs: 1_234,
      autoDeleteDelayMs: 60_000,
      ignoreFailureMetricStatuses: [403, 404, 409],
      attempt: 1,
      idempotencyKey: 'send-auto-delete-context',
      createdAt: sourceCreatedAt,
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        timeout: 1_234,
      }),
    );
    expect(actionQueue.add).toHaveBeenCalledWith(
      'execute-max-action',
      expect.objectContaining({
        actionType: 'DELETE_MESSAGE',
        chatId: 'chat-1',
        messageId: 'mid-sent-1',
        botId: '777000_bot',
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_BROADCAST,
        timeoutMs: 1_234,
        ignoreFailureMetricStatuses: [409],
        ledgerContext,
        options: { messageLink: { type: 'reply', mid: 'reply-source' } },
        sendAutoDelete: {
          version: MAX_SEND_AUTO_DELETE_MARKER_VERSION,
          sourceSendJobId: 'send-auto-delete-context',
          sourceChatId: 'chat-1',
          sourceUserId: 'original-author',
          sourceMessageId: 'original-source',
          sourceCreatedAt,
          sourceSendCompletedAt: null,
          requestedDelayMs: 60_000,
          originBotId: '777000_bot',
        },
      }),
      expect.objectContaining({
        delay: 60_000,
      }),
    );

    await service.onModuleDestroy();
  });

  it('anchors fresh auto-delete delay to the exact ledger completion time', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-31T12:00:00.000Z'));
    const completedAt = new Date('2026-08-31T12:00:00.000Z');
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            mid: 'mid-slow-completion-1',
          },
        }),
      ),
    };
    const actionQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const actionLedgerService = {
      getCompletedSendDispatchResult: jest.fn().mockResolvedValue(null),
      claimSendDispatch: jest.fn().mockResolvedValue({
        kind: 'claimed',
        dispatchToken: 'dispatch-token-slow-completion-1',
      }),
      completeSendDispatch: jest.fn().mockImplementation(async () => {
        jest.setSystemTime(new Date('2026-08-31T12:00:25.000Z'));
        return completedAt;
      }),
      releaseSendDispatch: jest.fn(),
      recordAmbiguousSendDispatch: jest.fn(),
      assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
      recordEnqueuedIfAbsent: jest.fn().mockResolvedValue(undefined),
    };
    const service = createService(httpService, {}, actionQueue, actionLedgerService);

    await service.executeActionJob({
      actionType: 'SEND_MESSAGE',
      chatId: 'chat-1',
      text: 'hello',
      botId: '777000_bot',
      autoDeleteDelayMs: 60_000,
      attempt: 1,
      idempotencyKey: 'send-auto-delete-slow-completion',
      createdAt: completedAt.toISOString(),
    });

    expect(actionQueue.add).toHaveBeenCalledWith(
      'execute-max-action',
      expect.objectContaining({
        actionType: 'DELETE_MESSAGE',
        messageId: 'mid-slow-completion-1',
      }),
      expect.objectContaining({ delay: 35_000 }),
    );

    await service.onModuleDestroy();
  });

  it('recovers a completed send after auto-delete enqueue failure without sending twice', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-31T12:00:00.000Z'));
    const enqueueError = new Error('redis is unavailable');
    const completedAt = new Date('2026-08-31T12:00:00.000Z');
    let completedSend: {
      remoteMessageId: string;
      dispatchBotId: string;
      completedAt: Date;
    } | null = null;
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            mid: 'mid-auto-delete-enqueue-failed-1',
          },
        }),
      ),
    };
    const actionQueue = {
      add: jest.fn().mockRejectedValueOnce(enqueueError).mockResolvedValueOnce(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const actionLedgerService = {
      getCompletedSendDispatchResult: jest.fn().mockImplementation(async () => completedSend),
      claimSendDispatch: jest.fn().mockResolvedValue({
        kind: 'claimed',
        dispatchToken: 'dispatch-token-auto-delete-1',
      }),
      completeSendDispatch: jest.fn().mockImplementation(async () => {
        completedSend = {
          remoteMessageId: 'mid-auto-delete-enqueue-failed-1',
          dispatchBotId: '777000_bot',
          completedAt,
        };
        return completedAt;
      }),
      releaseSendDispatch: jest.fn(),
      recordAmbiguousSendDispatch: jest.fn(),
      assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
      hasExecutionEvidenceSince: jest.fn().mockResolvedValue(false),
      recordEnqueueFailedIfAbsent: jest.fn().mockResolvedValue(undefined),
      recordEnqueuedIfAbsent: jest.fn().mockResolvedValue(undefined),
    };
    const service = createService(httpService, {}, actionQueue, actionLedgerService);
    const job = {
      actionType: 'SEND_MESSAGE' as const,
      chatId: 'chat-1',
      text: 'hello',
      botId: '777000_bot',
      autoDeleteDelayMs: 60_000,
      attempt: 1,
      idempotencyKey: 'send-auto-delete-enqueue-failure',
      createdAt: new Date().toISOString(),
    };

    await expect(service.executeActionJob(job)).rejects.toBe(enqueueError);

    expect(actionLedgerService.completeSendDispatch).toHaveBeenCalledWith(
      job,
      'dispatch-token-auto-delete-1',
      'mid-auto-delete-enqueue-failed-1',
    );
    jest.setSystemTime(new Date('2026-08-31T12:00:20.000Z'));

    await expect(
      service.executeActionJob({
        ...job,
        attempt: 2,
      }),
    ).resolves.toEqual({
      messageId: 'mid-auto-delete-enqueue-failed-1',
      url: null,
      recoveredSendDispatch: {
        dispatchBotId: '777000_bot',
      },
    });

    expect(httpService.request).toHaveBeenCalledTimes(1);
    expect(actionLedgerService.claimSendDispatch).toHaveBeenCalledTimes(1);
    expect(actionQueue.add).toHaveBeenCalledTimes(2);
    expect(actionQueue.add.mock.calls[0][2].jobId).toBe(actionQueue.add.mock.calls[1][2].jobId);
    expect(actionLedgerService.recordEnqueueFailedIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'DELETE_MESSAGE',
        messageId: 'mid-auto-delete-enqueue-failed-1',
      }),
      enqueueError,
    );
    expect(actionLedgerService.recordEnqueuedIfAbsent).toHaveBeenCalledTimes(1);
    expect(actionQueue.add).toHaveBeenNthCalledWith(
      2,
      'execute-max-action',
      expect.objectContaining({
        actionType: 'DELETE_MESSAGE',
        messageId: 'mid-auto-delete-enqueue-failed-1',
      }),
      expect.objectContaining({ delay: 40_000 }),
    );

    await service.onModuleDestroy();
  });

  it('enqueues an overdue recovered auto-delete without another delay', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-31T12:02:00.000Z'));
    const actionQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const service = createService({}, {}, actionQueue);

    await service.ensureSendAutoDeleteScheduled(
      {
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        text: 'hello',
        botId: '777000_bot',
        autoDeleteDelayMs: 60_000,
        attempt: 2,
        idempotencyKey: 'send-auto-delete-overdue',
        createdAt: '2026-08-31T12:00:00.000Z',
      },
      {
        remoteMessageId: 'mid-auto-delete-overdue-1',
        dispatchBotId: '777000_bot',
        completedAt: new Date('2026-08-31T12:00:30.000Z'),
      },
    );

    expect(actionQueue.add).toHaveBeenCalledWith(
      'execute-max-action',
      expect.objectContaining({
        actionType: 'DELETE_MESSAGE',
        messageId: 'mid-auto-delete-overdue-1',
      }),
      expect.not.objectContaining({ delay: expect.anything() }),
    );

    await service.onModuleDestroy();
  });

  it('uses configurable failed action job retention limits', async () => {
    const actionQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const service = createService(
      {},
      {
        MAX_ACTION_FAILED_RETENTION_AGE_SEC: '3600',
        MAX_ACTION_FAILED_RETENTION_COUNT: '250',
      },
      actionQueue,
    );

    await service.sendMessage('chat-1', 'hello');

    expect(actionQueue.add).toHaveBeenCalledWith(
      'execute-max-action',
      expect.any(Object),
      expect.objectContaining({
        removeOnFail: {
          age: 3_600,
          count: 250,
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('persists caller ledger context on queued sends', async () => {
    const actionQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const service = createService({}, {}, actionQueue);

    await service.sendMessage('chat-1', 'Витрина продавца', undefined, {
      idempotencyKey: 'storefront-relay-chat-1-message-1',
      sourceTag: MAX_API_SOURCE_TAGS.KARAVAN_STOREFRONT_RELAY,
      ledgerContext: {
        karavanStorefrontRelay: {
          sourceMessageId: 'message-1',
          senderId: 'user-1',
        },
      },
    });

    expect(actionQueue.add).toHaveBeenCalledWith(
      'execute-max-action',
      expect.objectContaining({
        actionType: 'SEND_MESSAGE',
        sourceTag: MAX_API_SOURCE_TAGS.KARAVAN_STOREFRONT_RELAY,
        ledgerContext: {
          karavanStorefrontRelay: {
            sourceMessageId: 'message-1',
            senderId: 'user-1',
          },
        },
      }),
      expect.any(Object),
    );

    await service.onModuleDestroy();
  });

  it('keeps interactive traffic priority but backgrounds auto-delete action health', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            mid: 'mid-immediate-1',
          },
        }),
      ),
    };
    const actionQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const service = createService(httpService, {}, actionQueue);

    await service.sendMessage('chat-1', 'hello', undefined, {
      immediate: true,
      autoDeleteDelayMs: 30_000,
      trafficClass: 'interactive',
      actionHealthLane: 'interactive',
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_NOTICE,
      ledgerContext: { moderationNoticeEnvelope: { version: 1 } },
      timeoutMs: 2_345,
      ignoreFailureMetricStatuses: [409],
      botId: '777000_bot',
    });

    expect(actionQueue.add).toHaveBeenCalledWith(
      'execute-max-action',
      expect.objectContaining({
        actionType: 'DELETE_MESSAGE',
        chatId: 'chat-1',
        messageId: 'mid-immediate-1',
        botId: '777000_bot',
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.MODERATION_NOTICE,
        timeoutMs: 2_345,
        ignoreFailureMetricStatuses: [409],
      }),
      expect.objectContaining({
        delay: 30_000,
      }),
    );

    await service.onModuleDestroy();
  });

  it.each([408, 504])(
    'marks ambiguous queued SEND_MESSAGE HTTP %s responses as unrecoverable',
    async (status) => {
      const statusError = {
        response: {
          status,
          data: {
            message: 'upstream timeout',
          },
        },
      };
      const httpService = {
        request: jest.fn(() => throwError(() => statusError)),
      };
      const service = createService(httpService);

      await expect(
        service.executeActionJob({
          actionType: 'SEND_MESSAGE',
          chatId: 'chat-1',
          text: 'hello',
          attempt: 1,
          idempotencyKey: `send-http-${status}`,
          createdAt: new Date().toISOString(),
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);

      await service.onModuleDestroy();
    },
  );

  it.each([
    {
      actionType: 'BAN_MEMBER' as const,
      expectedParams: {
        user_id: 'user-1',
        block: true,
      },
    },
    {
      actionType: 'KICK_MEMBER' as const,
      expectedParams: {
        user_id: 'user-1',
      },
    },
  ])(
    'marks ambiguous queued $actionType transport timeouts as unrecoverable',
    async ({ actionType, expectedParams }) => {
      const timeoutError = Object.assign(new Error('socket hang up'), {
        code: 'ECONNRESET',
      });
      const httpService = {
        request: jest.fn(() => throwError(() => timeoutError)),
      };
      const service = createService(httpService);

      const error = await service
        .executeActionJob({
          actionType,
          chatId: 'chat-1',
          userId: 'user-1',
          attempt: 1,
          idempotencyKey: `${actionType.toLowerCase()}-timeout`,
          createdAt: new Date().toISOString(),
        })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(UnrecoverableError);
      expect(wasMaxMemberMutationAttempted(error)).toBe(true);
      expect(httpService.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'delete',
          url: 'https://platform-api2.max.ru/chats/chat-1/members',
          params: expectedParams,
        }),
      );

      await service.onModuleDestroy();
    },
  );

  it.each(['BAN_MEMBER', 'KICK_MEMBER'] as const)(
    'marks ambiguous queued %s HTTP 504 responses as unrecoverable',
    async (actionType) => {
      const statusError = {
        response: {
          status: 504,
          data: {
            message: 'gateway timeout',
          },
        },
      };
      const httpService = {
        request: jest.fn(() => throwError(() => statusError)),
      };
      const service = createService(httpService);

      await expect(
        service.executeActionJob({
          actionType,
          chatId: 'chat-1',
          userId: 'user-1',
          attempt: 1,
          idempotencyKey: `${actionType.toLowerCase()}-http-504`,
          createdAt: new Date().toISOString(),
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);

      await service.onModuleDestroy();
    },
  );

  describe.each(['BAN_MEMBER', 'KICK_MEMBER', 'UNBAN_MEMBER'] as const)(
    '%s response confirmation',
    (actionType) => {
      beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-09-28T00:00:00Z')));
      it.each([
        null,
        {},
        [],
        { success: 'true' },
        { success: 1 },
        { message: 'User is already a chat member' },
        { success: true, failed_user_ids: ['user-1'] },
        { success: true, failed_user_details: [{ user_id: 'user-1', error: 'denied' }] },
        { success: true, failed_user_ids: 'malformed' },
      ])('does not confirm a malformed response: %j', async (payload) => {
        const httpService = {
          request: jest.fn(() => of({ status: 200, data: payload })),
        };
        const actionLedgerService = {
          clearTerminalBanStateAfterUnban: jest.fn(),
        };
        const service = createService(httpService, {}, undefined, actionLedgerService);

        try {
          const error = await service
            .executeActionJob({
              actionType,
              chatId: 'chat-1',
              userId: 'user-1',
              attempt: 1,
              idempotencyKey: `${actionType}-unconfirmed`,
              createdAt: new Date().toISOString(),
            })
            .catch((caught: unknown) => caught);

          expect(error).toBeInstanceOf(UnrecoverableError);
          expect(wasMaxMemberMutationAttempted(error)).toBe(true);
          expect(wasMaxMemberMutationConfirmed(error)).toBe(false);
          expect(actionLedgerService.clearTerminalBanStateAfterUnban).not.toHaveBeenCalled();
          expect(httpService.request).toHaveBeenCalledTimes(1);
        } finally {
          await service.onModuleDestroy();
        }
      });

      it('passes the normalized timeout to a confirmed HTTP mutation', async () => {
        const httpService = {
          request: jest.fn(() => of({ status: 200, data: { success: true } })),
        };
        const service = createService(httpService);
        try {
          await service.executeActionJob({
            actionType,
            chatId: 'chat-1',
            userId: 'user-1',
            attempt: 1,
            timeoutMs: 1_234.9,
            idempotencyKey: `${actionType}-http-timeout`,
            createdAt: new Date().toISOString(),
          });

          expect(httpService.request).toHaveBeenCalledWith(
            expect.objectContaining({
              method: actionType === 'UNBAN_MEMBER' ? 'post' : 'delete',
              url: 'https://platform-api2.max.ru/chats/chat-1/members',
              timeout: 1_234,
            }),
          );
        } finally {
          await service.onModuleDestroy();
        }
      });
    },
  );

  it('rejects old queued unbans after retirement without a remote attempt or ledger cleanup', async () => {
    jest.useFakeTimers().setSystemTime(new Date(MAX_MEMBER_RESTORE_RETIRES_AT));
    const httpService = { request: jest.fn() };
    const ledger = { clearTerminalBanStateAfterUnban: jest.fn() };
    const service = createService(httpService, {}, undefined, ledger);
    try {
      await expect(
        service.executeActionJob({
          actionType: 'UNBAN_MEMBER',
          chatId: 'chat-1',
          userId: 'user-1',
          attempt: 1,
          idempotencyKey: 'retired-unban',
          createdAt: '2026-09-28T00:00:00Z',
        }),
      ).rejects.toBeInstanceOf(MaxMemberRestoreUnavailableError);
      expect(httpService.request).not.toHaveBeenCalled();
      expect(ledger.clearTerminalBanStateAfterUnban).not.toHaveBeenCalled();
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('does not enqueue delayed unbans due after retirement', async () => {
    jest.useFakeTimers().setSystemTime(new Date(MAX_MEMBER_RESTORE_RETIRES_AT - 30_000));
    const service = createService({ request: jest.fn() });
    const dispatch = jest.spyOn(service as any, 'dispatchAction');
    try {
      await expect(
        service.unbanMember('chat-1', 'user-1', { delayMs: 60_000 }),
      ).rejects.toBeInstanceOf(MaxMemberRestoreUnavailableError);
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('clears terminal ban state only after MAX confirms an unban', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-28T00:00:00Z'));
    const httpService = {
      request: jest.fn(() => of({ data: { success: true } })),
    };
    const actionLedgerService = {
      clearTerminalBanStateAfterUnban: jest.fn().mockResolvedValue(undefined),
    };
    const service = createService(httpService, {}, undefined, actionLedgerService);

    await service.executeActionJob({
      actionType: 'UNBAN_MEMBER',
      chatId: 'chat-1',
      userId: 'user-1',
      attempt: 1,
      idempotencyKey: 'unban-member-1',
      createdAt: new Date().toISOString(),
    });

    expect(actionLedgerService.clearTerminalBanStateAfterUnban).toHaveBeenCalledWith(
      'chat-1',
      'user-1',
    );
    expect(httpService.request.mock.invocationCallOrder[0]).toBeLessThan(
      actionLedgerService.clearTerminalBanStateAfterUnban.mock.invocationCallOrder[0],
    );

    await service.onModuleDestroy();
  });

  it('marks an UNBAN_MEMBER transport failure after its HTTP mutation callback begins', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-28T00:00:00Z'));
    const transportError = Object.assign(new Error('socket hang up'), {
      code: 'ECONNRESET',
    });
    const httpService = {
      request: jest.fn(() => throwError(() => transportError)),
    };
    const actionLedgerService = {
      clearTerminalBanStateAfterUnban: jest.fn(),
    };
    const service = createService(httpService, {}, undefined, actionLedgerService);

    const error = await service
      .executeActionJob({
        actionType: 'UNBAN_MEMBER',
        chatId: 'chat-1',
        userId: 'user-1',
        attempt: 1,
        idempotencyKey: 'unban-member-transport-failure',
        createdAt: new Date().toISOString(),
      })
      .catch((caught: unknown) => caught);

    expect(error).toBe(transportError);
    expect(wasMaxMemberMutationAttempted(error)).toBe(true);
    expect(wasMaxMemberMutationConfirmed(error)).toBe(false);
    expect(actionLedgerService.clearTerminalBanStateAfterUnban).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('keeps the UNBAN_MEMBER attempt marker when post-mutation ledger cleanup fails', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-28T00:00:00Z'));
    const ledgerError = new Error('terminal ban state cleanup failed');
    const httpService = {
      request: jest.fn(() => of({ data: { success: true } })),
    };
    const actionLedgerService = {
      clearTerminalBanStateAfterUnban: jest.fn().mockRejectedValue(ledgerError),
    };
    const service = createService(httpService, {}, undefined, actionLedgerService);

    const error = await service
      .executeActionJob({
        actionType: 'UNBAN_MEMBER',
        chatId: 'chat-1',
        userId: 'user-1',
        attempt: 1,
        idempotencyKey: 'unban-member-ledger-failure',
        createdAt: new Date().toISOString(),
      })
      .catch((caught: unknown) => caught);

    expect(error).toBe(ledgerError);
    expect(wasMaxMemberMutationAttempted(error)).toBe(true);
    expect(wasMaxMemberMutationConfirmed(error)).toBe(true);
    expect(httpService.request).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('treats a documented already-present success=false response as confirmed unban state', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-28T00:00:00Z'));
    const httpService = {
      request: jest.fn(() =>
        of({
          status: 200,
          data: {
            success: false,
            message: 'User is already a chat member',
          },
        }),
      ),
    };
    const actionLedgerService = {
      clearTerminalBanStateAfterUnban: jest.fn().mockResolvedValue(undefined),
    };
    const service = createService(httpService, {}, undefined, actionLedgerService);

    await expect(
      service.executeActionJob({
        actionType: 'UNBAN_MEMBER',
        chatId: 'chat-1',
        userId: 'user-1',
        attempt: 1,
        idempotencyKey: 'unban-member-already-present',
        createdAt: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined();

    expect(actionLedgerService.clearTerminalBanStateAfterUnban).toHaveBeenCalledWith(
      'chat-1',
      'user-1',
    );

    await service.onModuleDestroy();
  });

  it('keeps terminal ban state when MAX rejects an unban', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-28T00:00:00Z'));
    const maxError = new Error('unban rejected');
    const httpService = {
      request: jest.fn(() => throwError(() => maxError)),
    };
    const actionLedgerService = {
      clearTerminalBanStateAfterUnban: jest.fn(),
    };
    const service = createService(httpService, {}, undefined, actionLedgerService);

    await expect(
      service.executeActionJob({
        actionType: 'UNBAN_MEMBER',
        chatId: 'chat-1',
        userId: 'user-1',
        attempt: 1,
        idempotencyKey: 'unban-member-rejected',
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toBe(maxError);

    expect(actionLedgerService.clearTerminalBanStateAfterUnban).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('does not treat an already-member phrase in a 5xx response as confirmed unban state', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-28T00:00:00Z'));
    const serverError = {
      response: {
        status: 500,
        data: {
          message: 'User is already a chat member',
        },
      },
    };
    const httpService = {
      request: jest.fn(() => throwError(() => serverError)),
    };
    const actionLedgerService = {
      clearTerminalBanStateAfterUnban: jest.fn(),
    };
    const service = createService(httpService, {}, undefined, actionLedgerService);

    await expect(
      service.executeActionJob({
        actionType: 'UNBAN_MEMBER',
        chatId: 'chat-1',
        userId: 'user-1',
        attempt: 1,
        idempotencyKey: 'unban-member-server-error',
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toBe(serverError);

    expect(actionLedgerService.clearTerminalBanStateAfterUnban).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  describe('guarded unban attempt', () => {
    function ledger() {
      return {
        isIrreversibleAction: jest.fn().mockReturnValue(true),
        assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
        recordStarted: jest.fn().mockResolvedValue(undefined),
        recordSucceeded: jest.fn().mockResolvedValue(undefined),
        recordFailed: jest.fn().mockResolvedValue(undefined),
        clearTerminalBanStateAfterUnban: jest.fn(),
      };
    }
    const options = () => ({
      immediate: true,
      idempotencyKey: 'selected-ban',
      beforeImmediateMemberMutation: jest.fn().mockResolvedValue(undefined),
    });

    it('sends explicit DELETE block=false after POST retirement and retains BAN evidence', async () => {
      jest.useFakeTimers().setSystemTime(new Date(MAX_MEMBER_RESTORE_RETIRES_AT + 1));
      const http = { request: jest.fn(() => of({ status: 200, data: { success: true } })) };
      const log = ledger();
      const service = createService(http, {}, undefined, log);
      try {
        const opts = options();
        await service.attemptUnbanMember('chat-1', 'user-1', opts);
        expect(http.request).toHaveBeenCalledWith(
          expect.objectContaining({
            method: 'delete',
            url: 'https://platform-api2.max.ru/chats/chat-1/members',
            params: { user_id: 'user-1', block: false },
          }),
        );
        expect(opts.beforeImmediateMemberMutation).toHaveBeenCalledTimes(1);
        expect(opts.beforeImmediateMemberMutation.mock.invocationCallOrder[0]).toBeLessThan(
          http.request.mock.invocationCallOrder[0]!,
        );
        expect(log.recordSucceeded).toHaveBeenCalledWith(
          expect.objectContaining({ actionType: 'TRY_UNBAN_MEMBER' }),
        );
        expect(log.clearTerminalBanStateAfterUnban).not.toHaveBeenCalled();
      } finally {
        await service.onModuleDestroy();
      }
    });

    it.each([
      { immediate: false },
      { idempotencyKey: '' },
      { beforeImmediateMemberMutation: undefined },
      { delayMs: 1 },
    ])('rejects unsafe dispatch options %j before any request', async (overrides) => {
      const http = { request: jest.fn() };
      const service = createService(http, {}, undefined, ledger());
      try {
        await expect(
          service.attemptUnbanMember('chat-1', 'user-1', { ...options(), ...overrides }),
        ).rejects.toThrow();
        expect(http.request).not.toHaveBeenCalled();
      } finally {
        await service.onModuleDestroy();
      }
    });

    it.each([false, true])(
      'rejects queued execution without its ephemeral guard (legacy reader=%s)',
      async (withLegacyHolds) => {
        const http = { request: jest.fn() };
        const service = createService(http);
        if (withLegacyHolds)
          Object.assign(service, {
            legacyHolds: {
              isOutboundJobHeld: jest.fn().mockResolvedValue(false),
              isMessageHeld: jest.fn().mockResolvedValue(false),
              isMemberHeld: jest.fn().mockResolvedValue(false),
              isGlobalUserHeld: jest.fn().mockResolvedValue(false),
              isLegacyChatSendHeld: jest.fn().mockResolvedValue(false),
            },
          });
        try {
          await expect(
            service.executeActionJob({
              actionType: 'TRY_UNBAN_MEMBER',
              chatId: 'chat-1',
              userId: 'user-1',
              idempotencyKey: 'queued-attempt',
              attempt: 1,
              createdAt: new Date().toISOString(),
            }),
          ).rejects.toThrow('live guard');
          expect(http.request).not.toHaveBeenCalled();
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it('stops before HTTP when the final absence guard rejects', async () => {
      const http = { request: jest.fn() };
      const log = ledger();
      const service = createService(http, {}, undefined, log);
      try {
        await expect(
          service.attemptUnbanMember('chat-1', 'user-1', {
            ...options(),
            beforeImmediateMemberMutation: async () => {
              throw new Error('participant returned');
            },
          }),
        ).rejects.toThrow('participant returned');
        expect(http.request).not.toHaveBeenCalled();
        expect(log.recordFailed).toHaveBeenCalled();
        expect(log.recordSucceeded).not.toHaveBeenCalled();
      } finally {
        await service.onModuleDestroy();
      }
    });

    it.each(['invalid_response', 'connection_reset'])(
      'does not replay %s or clear the BAN',
      async (failure) => {
        const http = {
          request: jest.fn(() =>
            failure === 'invalid_response'
              ? of({ status: 200, data: { success: false } })
              : throwError(() =>
                  Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
                ),
          ),
        };
        const log = ledger();
        const service = createService(http, {}, undefined, log);
        try {
          await expect(service.attemptUnbanMember('chat-1', 'user-1', options())).rejects.toThrow();
          expect(http.request).toHaveBeenCalledTimes(1);
          expect(log.recordFailed).toHaveBeenCalled();
          expect(log.recordSucceeded).not.toHaveBeenCalled();
          expect(log.clearTerminalBanStateAfterUnban).not.toHaveBeenCalled();
        } finally {
          await service.onModuleDestroy();
        }
      },
    );
  });

  it('records successful immediate irreversible actions in the durable ledger', async () => {
    const httpService = {
      request: jest.fn(() => of({ data: { success: true } })),
    };
    const actionLedgerService = {
      isIrreversibleAction: jest.fn().mockReturnValue(true),
      assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordSucceeded: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockResolvedValue(undefined),
    };
    const service = createService(httpService, {}, undefined, actionLedgerService);

    await service.banMember('chat-1', 'user-1', { immediate: true });

    const job = actionLedgerService.recordStarted.mock.calls[0][0];
    expect(job).toEqual(
      expect.objectContaining({
        actionType: 'BAN_MEMBER',
        chatId: 'chat-1',
        userId: 'user-1',
        idempotencyKey: expect.stringMatching(/^max-action__logical__/),
      }),
    );
    expect(actionLedgerService.recordStarted).toHaveBeenCalledWith(job, new Date(job.createdAt));
    expect(actionLedgerService.assertCanEnqueue).toHaveBeenCalledWith(job);
    expect(actionLedgerService.recordSucceeded).toHaveBeenCalledWith(job);
    expect(actionLedgerService.recordFailed).not.toHaveBeenCalled();
    expect(actionLedgerService.assertCanEnqueue.mock.invocationCallOrder[0]).toBeLessThan(
      actionLedgerService.recordStarted.mock.invocationCallOrder[0],
    );
    expect(actionLedgerService.recordStarted.mock.invocationCallOrder[0]).toBeLessThan(
      httpService.request.mock.invocationCallOrder[0],
    );
    expect(httpService.request.mock.invocationCallOrder[0]).toBeLessThan(
      actionLedgerService.recordSucceeded.mock.invocationCallOrder[0],
    );

    await service.onModuleDestroy();
  });

  it.each(['BAN_MEMBER', 'KICK_MEMBER'] as const)(
    'resolves an exact logical %s receipt key from the dispatcher across bot identities',
    async (actionType) => {
      const ledger = {
        isIrreversibleAction: jest.fn().mockReturnValue(true),
        assertCanEnqueue: jest.fn(async () => undefined),
        recordStarted: jest.fn(async (_job: MaxActionJob) => undefined),
        recordSucceeded: jest.fn(async () => undefined),
        recordFailed: jest.fn(async () => undefined),
      };
      const request = jest.fn(() => of({ status: 200, data: { success: true } }));
      const service = createService({ request }, {}, undefined, ledger);
      (service as any).botRegistry.getBotById.mockImplementation((id: string) => ({
        id,
        token: `synthetic-${id}`,
      }));
      const key = 'immutable-outbox:sanction-member';
      try {
        const action = actionType === 'BAN_MEMBER' ? service.banMember : service.kickMember;
        for (const botId of ['777000_bot', 'surviving-peer'])
          await action.call(service, '-123', 'human', {
            immediate: true,
            botId,
            idempotencyKey: key,
          });
        const dispatched = ledger.recordStarted.mock.calls[0][0];
        expect(ledger.recordStarted.mock.calls[1][0].idempotencyKey).toBe(
          dispatched.idempotencyKey,
        );
        expect(service.getExplicitActionJobId(actionType, key)).toBe(dispatched.idempotencyKey);
        expect(service.getExplicitActionJobId(actionType, key)).not.toBe(
          service.getExplicitActionJobId(
            actionType === 'BAN_MEMBER' ? 'KICK_MEMBER' : 'BAN_MEMBER',
            key,
          ),
        );
        expect(() => service.getExplicitActionJobId(actionType, ' ')).toThrow('nonempty');
      } finally {
        await service.onModuleDestroy();
      }
    },
  );

  it.each(['SEND_MESSAGE', 'BAN_MEMBER', 'KICK_MEMBER'] as const)(
    'keeps an unknown %s fenced after safe immediate failover without trying a third bot',
    async (actionType) => {
      const failure = Object.assign(new Error('Synthetic socket closed after dispatch'), {
        code: 'ECONNRESET',
      });
      const request = jest.fn(() => throwError(() => failure));
      const ledger = {
        isIrreversibleAction: jest.fn().mockReturnValue(true),
        assertCanEnqueue: jest.fn(async () => undefined),
        recordStarted: jest.fn(async (_job: MaxActionJob) => undefined),
        recordSucceeded: jest.fn(async () => undefined),
        recordFailed: jest.fn(async () => undefined),
        getCompletedSendDispatchResult: jest.fn(async () => null),
        claimSendDispatch: jest.fn<
          ReturnType<MaxActionLedgerService['claimSendDispatch']>,
          Parameters<MaxActionLedgerService['claimSendDispatch']>
        >(async () => ({ kind: 'claimed', dispatchToken: 'safe-fence' })),
        releaseSendDispatch: jest.fn(async () => undefined),
        recordAmbiguousSendDispatch: jest.fn(async () => true),
      };
      const service = createService(
        { request },
        { MAX_ROUTED_MUTATIONS_MODE: 'on' },
        undefined,
        ledger,
      );
      (service as any).botRegistry.getBotById.mockImplementation((id: string) => ({
        id,
        token: `synthetic-${id}`,
      }));
      let demoted = false;
      const resolveBotRoute = jest.fn(async () => ({
        purpose: actionType === 'SEND_MESSAGE' ? 'send_message' : 'moderation_action',
        action: 'moderate_member',
        chatId: '-123',
        primaryBotId: 'peer-2',
        botId: 'peer-2',
        candidateBotIds: ['peer-2', 'peer-3'],
        reason: 'alternate_confirmed',
        routingVersion: 3,
      }));
      Object.defineProperty(service, 'maxBotLinkService', {
        value: {
          resolveBotRoute,
          getFreshChatBotExecutionProof: async ({ botId }: { botId: string }) => ({
            botId,
            routingVersion: 3,
            accessEpoch: { checkedAt: new Date(), source: 'test' },
            changed: false,
          }),
          verifyChatExecutionProof: async ({ botId }: { botId: string }) =>
            botId !== '777000_bot' || !demoted,
        },
      });
      const qualified: string[] = [];
      const permit = async (revalidateRoute?: () => Promise<void>) => {
        const botId = (service as any).botContext.getActiveBotId() as string;
        qualified.push(botId);
        if (botId === '777000_bot') demoted = true;
        await revalidateRoute?.();
      };
      const options = {
        immediate: true,
        botId: '777000_bot',
        candidateBotIds: ['777000_bot', 'peer-2', 'peer-3'],
        idempotencyKey: 'immutable-failover',
        beforeImmediateSendMutation: actionType === 'SEND_MESSAGE' ? permit : undefined,
        beforeImmediateMemberMutation: actionType !== 'SEND_MESSAGE' ? permit : undefined,
      };
      try {
        const operation =
          actionType === 'SEND_MESSAGE'
            ? service.sendMessage('-123', 'Synthetic send', undefined, options)
            : actionType === 'BAN_MEMBER'
              ? service.banMember('-123', 'human', options)
              : service.kickMember('-123', 'human', options);
        const error = await operation.catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(UnrecoverableError);
        expect(request).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledWith(
          expect.objectContaining({ headers: { Authorization: 'synthetic-peer-2' } }),
        );
        expect(qualified).toEqual(['777000_bot', 'peer-2']);
        expect(resolveBotRoute).toHaveBeenCalledTimes(1);
        expect(ledger.recordStarted).toHaveBeenCalledTimes(1);
        expect(ledger.recordSucceeded).not.toHaveBeenCalled();
        expect(ledger.recordFailed).toHaveBeenCalledWith(
          expect.objectContaining({ botId: 'peer-2' }),
          error,
        );
        if (actionType === 'SEND_MESSAGE')
          expect(ledger.recordAmbiguousSendDispatch).toHaveBeenCalledTimes(1);
      } finally {
        await service.onModuleDestroy();
      }
    },
  );

  it.each(['off', 'shadow', 'pinned', 'publisher'] as const)(
    'preserves %s routing boundaries for immediate executor rejection',
    async (boundary) => {
      const request = jest.fn();
      const ledger = {
        isIrreversibleAction: jest.fn().mockReturnValue(true),
        assertCanEnqueue: jest.fn(async () => undefined),
        recordStarted: jest.fn(async () => undefined),
        recordSucceeded: jest.fn(async () => undefined),
        recordFailed: jest.fn(async () => undefined),
        getCompletedSendDispatchResult: jest.fn(async () => null),
        claimSendDispatch: jest.fn<
          ReturnType<MaxActionLedgerService['claimSendDispatch']>,
          Parameters<MaxActionLedgerService['claimSendDispatch']>
        >(async () => ({
          kind: 'claimed',
          dispatchToken: 'binding-fence',
        })),
        releaseSendDispatch: jest.fn(async () => undefined),
      };
      const service = createService(
        { request },
        {
          MAX_ROUTED_MUTATIONS_MODE: boundary === 'off' || boundary === 'shadow' ? boundary : 'on',
        },
        undefined,
        ledger,
      );
      const resolveBotRoute = jest.fn();
      Object.defineProperty(service, 'maxBotLinkService', { value: { resolveBotRoute } });
      const failure = Object.assign(new Error('Executor changed before HTTP'), {
        code: 'max_action_executor_proof_rejected',
      });
      try {
        const error = await service
          .sendMessage('-123', 'Synthetic send', undefined, {
            immediate: true,
            botId: '777000_bot',
            candidateBotIds: ['777000_bot', 'peer-2'],
            routing:
              boundary === 'pinned'
                ? { purpose: 'send_message', requiredBotId: '777000_bot' }
                : boundary === 'publisher'
                  ? { purpose: 'publisher_exact_send' }
                  : undefined,
            beforeImmediateSendMutation: async () => {
              throw failure;
            },
          })
          .catch((caught: unknown) => caught);
        expect(error).toBe(failure);
        expect(wasMaxPreDispatchGuardRejected(error)).toBe(true);
        expect(wasMaxMessageSendAttempted(error)).toBe(false);
        expect(resolveBotRoute).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
      } finally {
        await service.onModuleDestroy();
      }
    },
  );

  it('creates the durable SEND start before queue-less fallback claims its dispatch fence', async () => {
    const order: string[] = [];
    const httpService = {
      request: jest.fn(() => {
        order.push('http');
        return of({ status: 200, data: { message: { body: { mid: 'fallback-sent' } } } });
      }),
    };
    let started = false;
    const ledger = {
      isIrreversibleAction: jest.fn().mockReturnValue(true),
      assertCanEnqueue: jest.fn(),
      recordStarted: jest.fn(async () => {
        started = true;
        order.push('journal');
      }),
      recordSucceeded: jest.fn(async () => undefined),
      recordFailed: jest.fn(async () => undefined),
      getCompletedSendDispatchResult: jest.fn(async () => null),
      claimSendDispatch: jest.fn<
        ReturnType<MaxActionLedgerService['claimSendDispatch']>,
        Parameters<MaxActionLedgerService['claimSendDispatch']>
      >(async () => {
        if (!started) throw new UnrecoverableError('Missing durable SEND journal');
        order.push('claim');
        return { kind: 'claimed', dispatchToken: 'fallback-token' };
      }),
      completeSendDispatch: jest.fn(async () => new Date()),
    };
    const service = createService(httpService, {}, undefined, ledger);
    try {
      await service.sendMessage('-123', 'Fallback notice', undefined, {
        idempotencyKey: 'fallback-notice',
      });
      expect(order).toEqual(['journal', 'claim', 'http']);
      expect(ledger.recordStarted).toHaveBeenCalledTimes(1);
      expect(ledger.completeSendDispatch).toHaveBeenCalledWith(
        expect.objectContaining({ actionType: 'SEND_MESSAGE' }),
        'fallback-token',
        'fallback-sent',
      );
      expect(ledger.recordFailed).not.toHaveBeenCalled();
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('keeps an unknown queue-less SEND outcome fenced before the next fallback can reach HTTP', async () => {
    const timeout = Object.assign(new Error('Synthetic fallback timeout'), { code: 'ETIMEDOUT' });
    const manualReview = new UnrecoverableError('Unknown fallback SEND requires manual review');
    const httpService = { request: jest.fn(() => throwError(() => timeout)) };
    let quarantined = false;
    const ledger = {
      isIrreversibleAction: jest.fn().mockReturnValue(true),
      assertCanEnqueue: jest.fn(async () => {
        if (quarantined) throw manualReview;
      }),
      recordStarted: jest.fn(async () => undefined),
      recordSucceeded: jest.fn(async () => undefined),
      recordFailed: jest.fn(async () => undefined),
      getCompletedSendDispatchResult: jest.fn(async () => null),
      claimSendDispatch: jest.fn<
        ReturnType<MaxActionLedgerService['claimSendDispatch']>,
        Parameters<MaxActionLedgerService['claimSendDispatch']>
      >(async () => ({ kind: 'claimed', dispatchToken: 'unknown-token' })),
      recordAmbiguousSendDispatch: jest.fn(async () => {
        quarantined = true;
        return true;
      }),
    };
    const service = createService(httpService, {}, undefined, ledger);
    try {
      await expect(
        service.sendMessage('-123', 'Fallback notice', undefined, {
          idempotencyKey: 'unknown-fallback',
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
      await expect(
        service.sendMessage('-123', 'Fallback notice', undefined, {
          idempotencyKey: 'unknown-fallback',
        }),
      ).rejects.toBe(manualReview);
      expect(ledger.recordStarted).toHaveBeenCalledTimes(1);
      expect(httpService.request).toHaveBeenCalledTimes(1);
      expect(ledger.recordAmbiguousSendDispatch).toHaveBeenCalledTimes(1);
      expect(ledger.recordSucceeded).not.toHaveBeenCalled();
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('does not mark a member mutation attempted when the immediate action ledger start fails', async () => {
    const recordStartedError = new Error('action ledger unavailable');
    const httpService = {
      request: jest.fn(),
    };
    const actionLedgerService = {
      isIrreversibleAction: jest.fn().mockReturnValue(true),
      assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
      recordStarted: jest.fn().mockRejectedValue(recordStartedError),
      recordSucceeded: jest.fn(),
      recordFailed: jest.fn(),
    };
    const service = createService(httpService, {}, undefined, actionLedgerService);

    const error = await service
      .banMember('chat-1', 'user-1', { immediate: true })
      .catch((caught: unknown) => caught);

    expect(error).toBe(recordStartedError);
    expect(wasMaxMemberMutationAttempted(error)).toBe(false);
    expect(httpService.request).not.toHaveBeenCalled();
    expect(actionLedgerService.recordSucceeded).not.toHaveBeenCalled();
    expect(actionLedgerService.recordFailed).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('checks the immediate member guard after routing and ledger work but before MAX HTTP', async () => {
    const leaseLostError = new Error('photo ordering lease lost');
    const httpService = {
      request: jest.fn(() => of({ data: { success: true } })),
    };
    const actionLedgerService = {
      isIrreversibleAction: jest.fn().mockReturnValue(true),
      assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordSucceeded: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockResolvedValue(undefined),
    };
    const resolveBotRoute = jest.fn().mockResolvedValue({
      purpose: 'moderation_action',
      chatId: 'chat-1',
      primaryBotId: '777000_bot',
      botId: '777000_bot',
      candidateBotIds: ['777000_bot'],
      reason: 'primary_confirmed',
      action: 'moderate_member',
    });
    const beforeImmediateMemberMutation = jest.fn().mockRejectedValue(leaseLostError);
    const service = createService(httpService, {}, undefined, actionLedgerService);
    (service as any).maxBotLinkService = { resolveBotRoute };

    const error = await service
      .banMember('chat-1', 'user-1', {
        immediate: true,
        beforeImmediateMemberMutation,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBe(leaseLostError);
    expect((error as Error & { code?: string }).code).toBe(
      MAX_MEMBER_PRE_DISPATCH_GUARD_REJECTED_CODE,
    );
    expect(wasMaxMemberMutationAttempted(error)).toBe(false);
    expect(resolveBotRoute).toHaveBeenCalledTimes(1);
    expect(actionLedgerService.assertCanEnqueue).toHaveBeenCalledTimes(1);
    expect(actionLedgerService.recordStarted).toHaveBeenCalledTimes(1);
    expect(beforeImmediateMemberMutation).toHaveBeenCalledTimes(1);
    expect(httpService.request).not.toHaveBeenCalled();
    expect(actionLedgerService.recordFailed).toHaveBeenCalledWith(
      expect.not.objectContaining({ beforeImmediateMemberMutation: expect.anything() }),
      leaseLostError,
    );
    expect(actionLedgerService.recordSucceeded).not.toHaveBeenCalled();
    expect((service as any).actionHealthService.recordFailureForLane).not.toHaveBeenCalled();
    expect(resolveBotRoute.mock.invocationCallOrder[0]).toBeLessThan(
      actionLedgerService.recordStarted.mock.invocationCallOrder[0],
    );
    expect(actionLedgerService.recordStarted.mock.invocationCallOrder[0]).toBeLessThan(
      beforeImmediateMemberMutation.mock.invocationCallOrder[0],
    );

    await expect(
      service.banMember('chat-1', 'user-1', { immediate: true }),
    ).resolves.toBeUndefined();

    expect(actionLedgerService.assertCanEnqueue).toHaveBeenCalledTimes(2);
    expect(actionLedgerService.recordStarted).toHaveBeenCalledTimes(2);
    expect(httpService.request).toHaveBeenCalledTimes(1);
    expect(actionLedgerService.recordSucceeded).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('rejects a queued member mutation guard before routing or enqueue', async () => {
    const beforeImmediateMemberMutation = jest.fn();
    const resolveBotRoute = jest.fn();
    const service = createService({ request: jest.fn() });
    (service as any).maxBotLinkService = { resolveBotRoute };

    await expect(
      service.banMember('chat-1', 'user-1', { beforeImmediateMemberMutation }),
    ).rejects.toThrow('Member mutation guard requires immediate dispatch');

    expect(beforeImmediateMemberMutation).not.toHaveBeenCalled();
    expect(resolveBotRoute).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('quarantines ambiguous immediate irreversible actions before later retries reach MAX', async () => {
    const timeoutError = Object.assign(new Error('timeout exceeded when trying to connect'), {
      code: 'ETIMEDOUT',
    });
    const manualReviewError = new UnrecoverableError('manual review required');
    const httpService = {
      request: jest.fn(() => throwError(() => timeoutError)),
    };
    const actionLedgerService = {
      isIrreversibleAction: jest.fn().mockReturnValue(true),
      assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordSucceeded: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockResolvedValue(undefined),
    };
    const service = createService(httpService, {}, undefined, actionLedgerService);

    await expect(
      service.kickMember('chat-1', 'user-1', { immediate: true }),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    const job = actionLedgerService.recordStarted.mock.calls[0][0];
    expect(job).toEqual(
      expect.objectContaining({
        actionType: 'KICK_MEMBER',
        chatId: 'chat-1',
        userId: 'user-1',
        idempotencyKey: expect.any(String),
      }),
    );
    expect(job.idempotencyKey).not.toMatch(/^max-action__logical__/);
    expect(actionLedgerService.recordFailed).toHaveBeenCalledWith(
      job,
      expect.any(UnrecoverableError),
    );
    expect(actionLedgerService.recordSucceeded).not.toHaveBeenCalled();

    httpService.request.mockClear();
    actionLedgerService.recordStarted.mockClear();
    actionLedgerService.recordFailed.mockClear();
    actionLedgerService.assertCanEnqueue.mockRejectedValueOnce(manualReviewError);

    await expect(service.kickMember('chat-1', 'user-1', { immediate: true })).rejects.toBe(
      manualReviewError,
    );
    expect(httpService.request).not.toHaveBeenCalled();
    expect(actionLedgerService.recordStarted).not.toHaveBeenCalled();
    expect(actionLedgerService.recordFailed).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it.each([500, 502, 503])(
    'marks queued SEND_MESSAGE HTTP %s responses as ambiguous and unrecoverable',
    async (status) => {
      const statusError = {
        response: {
          status,
          data: {
            message: 'server failure',
          },
        },
      };
      const httpService = {
        request: jest.fn(() => throwError(() => statusError)),
      };
      const service = createService(httpService);

      await expect(
        service.executeActionJob({
          actionType: 'SEND_MESSAGE',
          chatId: 'chat-1',
          text: 'hello',
          attempt: 1,
          idempotencyKey: `send-http-${status}`,
          createdAt: new Date().toISOString(),
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
      expect(httpService.request).toHaveBeenCalledTimes(1);

      await service.onModuleDestroy();
    },
  );

  it.each(['BAN_MEMBER', 'KICK_MEMBER'] as const)(
    'marks queued %s HTTP 5xx responses as ambiguous and unrecoverable',
    async (actionType) => {
      const statusError = {
        response: {
          status: 500,
          data: {
            message: 'server failure',
          },
        },
      };
      const httpService = {
        request: jest.fn(() => throwError(() => statusError)),
      };
      const service = createService(httpService);

      const error = await service
        .executeActionJob({
          actionType,
          chatId: 'chat-1',
          userId: 'user-1',
          attempt: 1,
          idempotencyKey: `${actionType.toLowerCase()}-http-500`,
          createdAt: new Date().toISOString(),
        })
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(UnrecoverableError);
      expect(error).toMatchObject({
        response: statusError.response,
      });
      expect(wasMaxMemberMutationAttempted(error)).toBe(true);
      expect(httpService.request).toHaveBeenCalledTimes(1);

      await service.onModuleDestroy();
    },
  );

  it.each(['BAN_MEMBER', 'KICK_MEMBER'] as const)(
    'keeps queued %s HTTP 429 responses retryable',
    async (actionType) => {
      const rateLimitError = {
        response: {
          status: 429,
          data: {
            code: 'too.many.requests',
            message: 'too many requests',
          },
        },
      };
      const httpService = {
        request: jest.fn(() => throwError(() => rateLimitError)),
      };
      const service = createService(httpService);

      const error = await service
        .executeActionJob({
          actionType,
          chatId: 'chat-1',
          userId: 'user-1',
          attempt: 1,
          idempotencyKey: `${actionType.toLowerCase()}-http-429`,
          createdAt: new Date().toISOString(),
        })
        .catch((caught: unknown) => caught);

      expect(error).toBe(rateLimitError);
      expect(error).not.toBeInstanceOf(UnrecoverableError);
      expect(wasMaxMemberMutationAttempted(error)).toBe(true);
      expect(httpService.request).toHaveBeenCalledTimes(1);

      await service.onModuleDestroy();
    },
  );

  it('trims inline keyboard buttons to 210 and logs warning', async () => {
    const service = createService();
    const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

    const buttons = Array.from({ length: 220 }, (_, index) => ({
      type: 'callback' as const,
      text: `B${index + 1}`,
      payload: `p${index + 1}`,
    }));

    const normalized = (service as any).normalizeInlineKeyboardButtons({
      buttons: [buttons],
      debugContext: {
        screen: 'home',
        action: 'render',
      },
    }) as Array<Array<Record<string, unknown>>> | null;

    const delivered = (normalized ?? []).reduce((acc, row) => acc + row.length, 0);
    expect(delivered).toBe(210);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedButtons: 220,
        deliveredButtons: 210,
        screen: 'home',
        action: 'render',
      }),
      expect.stringContaining('Inline keyboard exceeds MAX limit'),
    );

    await service.onModuleDestroy();
  });

  it('keeps inline keyboard as-is when button count is within limit', async () => {
    const service = createService();
    const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

    const buttons = Array.from({ length: 3 }, (_, index) => ({
      type: 'callback' as const,
      text: `B${index + 1}`,
      payload: `p${index + 1}`,
    }));

    const normalized = (service as any).normalizeInlineKeyboardButtons({
      buttons: [buttons],
    }) as Array<Array<Record<string, unknown>>> | null;

    const delivered = (normalized ?? []).reduce((acc, row) => acc + row.length, 0);
    expect(delivered).toBe(3);
    expect(warnSpy).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('splits oversized callback rows to MAX row limits', async () => {
    const service = createService();

    const buttons = Array.from({ length: 8 }, (_, index) => ({
      type: 'callback' as const,
      text: `B${index + 1}`,
      payload: `p${index + 1}`,
    }));

    const normalized = (service as any).normalizeInlineKeyboardButtons({
      buttons: [buttons],
    }) as Array<Array<Record<string, unknown>>> | null;

    expect(normalized?.map((row) => row.length)).toEqual([7, 1]);

    await service.onModuleDestroy();
  });

  it('moves link and open_app action buttons to their own MAX rows', async () => {
    const service = createService();

    const normalized = (service as any).normalizeInlineKeyboardButtons({
      buttons: [
        [
          { type: 'link' as const, text: 'L1', url: 'https://example.com/1' },
          { type: 'link' as const, text: 'L2', url: 'https://example.com/2' },
          {
            type: 'open_app' as const,
            text: 'App',
            webApp: 'https://major-maksimov.ru/app/',
          },
          { type: 'link' as const, text: 'L4', url: 'https://example.com/4' },
        ],
      ],
    }) as Array<Array<Record<string, unknown>>> | null;

    expect(normalized?.map((row) => row.length)).toEqual([1, 1, 1, 1]);

    await service.onModuleDestroy();
  });

  it('keeps Karavan-style channel CTA buttons from sharing one clipped MAX row', async () => {
    const service = createService();

    const normalized = (service as any).normalizeInlineKeyboardButtons({
      buttons: [
        [
          {
            type: 'link' as const,
            text: 'Зайти в Караван🐪',
            url: 'https://example.com/karavan',
          },
          {
            type: 'link' as const,
            text: 'Открыть свою витрину 🏪',
            url: 'https://example.com/storefront',
          },
          {
            type: 'link' as const,
            text: 'Тех поддержка ⚙️',
            url: 'https://example.com/support',
          },
        ],
      ],
    }) as Array<Array<Record<string, unknown>>> | null;

    expect(normalized?.map((row) => row.map((button) => button.text))).toEqual([
      ['Зайти в Караван🐪'],
      ['Открыть свою витрину 🏪'],
      ['Тех поддержка ⚙️'],
    ]);

    await service.onModuleDestroy();
  });

  it('moves long link button labels to their own MAX rows', async () => {
    const service = createService();

    const normalized = (service as any).normalizeInlineKeyboardButtons({
      buttons: [
        [
          {
            type: 'link' as const,
            text: 'Связь с администратором',
            url: 'https://example.com/admin',
          },
          {
            type: 'link' as const,
            text: 'Открыть подробные правила',
            url: 'https://example.com/rules',
          },
          {
            type: 'link' as const,
            text: 'Проверить обязательную подписку',
            url: 'https://example.com/subscription',
          },
        ],
      ],
    }) as Array<Array<Record<string, unknown>>> | null;

    expect(normalized?.map((row) => row.map((button) => button.text))).toEqual([
      ['Связь с администратором'],
      ['Открыть подробные правила'],
      ['Проверить обязательную подписку'],
    ]);

    await service.onModuleDestroy();
  });

  it('supports open_app button type for native miniapp opening', async () => {
    const service = createService();

    const normalized = (service as any).normalizeInlineKeyboardButtons({
      buttons: [
        [
          {
            type: 'open_app',
            text: 'Открыть miniapp',
            webApp: 'https://major-maksimov.ru/app/',
            contactId: '613002203036',
          },
        ],
      ],
    }) as Array<Array<Record<string, unknown>>> | null;

    expect(normalized).toEqual([
      [
        {
          type: 'open_app',
          text: 'Открыть miniapp',
          web_app: 'https://major-maksimov.ru/app/',
          contact_id: '613002203036',
        },
      ],
    ]);

    await service.onModuleDestroy();
  });

  it('drops link buttons with non-http or oversized urls before MAX send', async () => {
    const service = createService();

    const normalized = (service as any).normalizeInlineKeyboardButtons({
      buttons: [
        [
          { type: 'link', text: 'Bad scheme', url: 'max://user/user-42' },
          { type: 'link', text: 'Bad url', url: 'not a url' },
          {
            type: 'link',
            text: 'Whitespace and nested url',
            url: 'https://example.test/path https://nested.example.test',
          },
          {
            type: 'link',
            text: 'Nested url path',
            url: 'https://max.ru/chat/example/https://nested.example.test',
          },
          {
            type: 'link',
            text: 'Encoded nested url path',
            url: 'https://max.ru/chat/example/https%3A%2F%2Fnested.example.test',
          },
          { type: 'link', text: 'Too long', url: `https://example.com/${'a'.repeat(2049)}` },
          {
            type: 'link',
            text: 'Too long before canonicalization',
            url: `https://example.com/${'a/../'.repeat(500)}open`,
          },
          { type: 'link', text: 'Good', url: ' https://example.com/path?x=1 ' },
        ],
      ],
    }) as Array<Array<Record<string, unknown>>> | null;

    expect(normalized).toEqual([
      [{ type: 'link', text: 'Good', url: 'https://example.com/path?x=1' }],
    ]);

    await service.onModuleDestroy();
  });

  it('drops open_app buttons without a valid web_app or contact_id', async () => {
    const service = createService();

    const normalized = (service as any).normalizeInlineKeyboardButtons({
      buttons: [
        [
          { type: 'open_app', text: 'Bad app', webApp: 'javascript:alert(1)' },
          { type: 'open_app', text: 'Contact only', contactId: 613002203036 },
          { type: 'open_app', text: 'Good app', webApp: 'https://major-maksimov.ru/app/' },
        ],
      ],
    }) as Array<Array<Record<string, unknown>>> | null;

    expect(normalized).toEqual([
      [
        {
          type: 'open_app',
          text: 'Contact only',
          contact_id: '613002203036',
        },
      ],
      [
        {
          type: 'open_app',
          text: 'Good app',
          web_app: 'https://major-maksimov.ru/app/',
        },
      ],
    ]);

    await service.onModuleDestroy();
  });

  it('supports clipboard button type', async () => {
    const service = createService();

    const normalized = (service as any).normalizeInlineKeyboardButtons({
      buttons: [
        [
          {
            type: 'clipboard',
            text: 'Скопировать',
            payload: 'promo-2026',
          },
        ],
      ],
    }) as Array<Array<Record<string, unknown>>> | null;

    expect(normalized).toEqual([
      [
        {
          type: 'clipboard',
          text: 'Скопировать',
          payload: 'promo-2026',
        },
      ],
    ]);

    await service.onModuleDestroy();
  });

  it('throws when MAX mutation responds with success=false under HTTP 200', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-edit-1',
                    text: 'Текст',
                    format: 'html',
                    attachments: [],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              success: false,
              message: 'Error on message edit',
            },
          }),
        ),
    };
    const service = createService(httpService);

    await expect(
      service.editMessageInlineKeyboard('chat-1', 'mid-edit-1', 'Текст', {
        button: {
          text: 'Открыть',
          url: 'https://major-maksimov.ru/app/',
        },
      }),
    ).rejects.toThrow('Error on message edit');
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'put',
        url: 'https://platform-api2.max.ru/messages',
        params: {
          message_id: 'mid-edit-1',
        },
        data: expect.objectContaining({
          text: 'Текст',
          format: 'html',
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('runs an edit guard after reading the source message and before the HTTP mutation', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            messages: [
              {
                body: {
                  mid: 'mid-edit-guard-1',
                  text: 'Текст',
                  attachments: [],
                },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);
    const guardError = new Error('edit no longer authorized');
    const beforeEditMutation = jest.fn(async () => {
      expect(httpService.request).toHaveBeenCalledTimes(1);
      throw guardError;
    });

    await expect(
      service.editMessageInlineKeyboard('chat-1', 'mid-edit-guard-1', 'Текст', {
        beforeEditMutation,
      }),
    ).rejects.toBe(guardError);

    expect(beforeEditMutation).toHaveBeenCalledTimes(1);
    expect(httpService.request).toHaveBeenCalledTimes(1);
    expect((guardError as Error & { code?: string }).code).toBe(
      MAX_EDIT_PRE_DISPATCH_GUARD_REJECTED_CODE,
    );

    await service.onModuleDestroy();
  });

  it('answers callback with notification and inline keyboard update in one request', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-01T18:00:35.000Z'));

    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            success: true,
            message: {
              message_id: 'mid-reply-1',
            },
          },
        }),
      ),
    };
    const service = createService(httpService);
    const limiterRedis = (
      service as unknown as { limiterRedis: { eval: jest.Mock; get: jest.Mock } }
    ).limiterRedis;
    const nowSec = Math.floor(Date.now() / 1_000);

    await service.answerCallback('callback-1', 'Действие выполнено', {
      text: 'Обновление\n\n1. Вариант - 1 (100%)',
      options: {
        buttons: [[{ type: 'callback', text: 'Вариант (1)', payload: 'action|sample-1|1|0' }]],
      },
    });

    expect(httpService.request).toHaveBeenCalledTimes(1);
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/answers',
        params: {
          callback_id: 'callback-1',
        },
        data: {
          notification: 'Действие выполнено',
          message: {
            text: 'Обновление\n\n1. Вариант - 1 (100%)',
            attachments: [
              {
                type: 'inline_keyboard',
                payload: {
                  buttons: [
                    [{ type: 'callback', text: 'Вариант (1)', payload: 'action|sample-1|1|0' }],
                  ],
                },
              },
            ],
          },
        },
      }),
    );
    await expect(
      limiterRedis.get(`maxapi:rps:source:v1:777000_bot:critical:callback_answer:${nowSec}`),
    ).resolves.toBe('1');
    const answerRateLimitKeys = limiterRedis.eval.mock.calls.flatMap((call) => {
      const keyCount = Number(call[1]);
      return call
        .slice(2, 2 + keyCount)
        .map(String)
        .filter((key: string) => key.includes('message-mutation:operation:answer:'));
    });
    expect(answerRateLimitKeys).toContain(
      'maxapi:gcra:v1:message-mutation:operation:answer:scope:unknown-target:bot:777000_bot',
    );
    expect(answerRateLimitKeys.join(' ')).not.toContain('callback-1');

    await service.onModuleDestroy();
  });

  it('answers callback with a message update without adding an undocumented notification', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: { success: true },
        }),
      ),
    };
    const service = createService(httpService);

    await service.answerCallback('callback-message-only', undefined, {
      text: 'Текст администратора',
      options: {
        buttons: [[{ type: 'callback', text: 'Да', payload: 'poll|v2|poll-1|option-1' }]],
      },
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/answers',
        params: { callback_id: 'callback-message-only' },
        data: {
          message: {
            text: 'Текст администратора',
            attachments: [
              {
                type: 'inline_keyboard',
                payload: {
                  buttons: [[{ type: 'callback', text: 'Да', payload: 'poll|v2|poll-1|option-1' }]],
                },
              },
            ],
          },
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('answers callback against the exact message while replacing only matching callback rows', async () => {
    const existingImage = { type: 'image', payload: { token: 'poll-image-token' } };
    const existingComments = {
      type: 'link',
      text: 'Комментарии',
      url: 'https://major-maksimov.ru/app/channel/channel-1/dialog/comments?token=comments-1',
    };
    const unrelatedCallback = {
      type: 'callback',
      text: 'Другое действие',
      payload: 'custom|poll-1|action',
    };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-poll-answer-1',
                    text: 'Текст опроса',
                    attachments: [
                      existingImage,
                      {
                        type: 'inline_keyboard',
                        payload: {
                          buttons: [
                            [existingComments],
                            [
                              {
                                type: 'callback',
                                text: 'Старый ответ',
                                payload: 'poll|v2|poll-1|option-old',
                              },
                            ],
                            [unrelatedCallback],
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(of({ status: 200, data: { success: true } })),
    };
    const service = createService(httpService);

    await service.answerCallback('callback-poll-answer-1', undefined, {
      messageId: 'mid-poll-answer-1',
      text: 'Текст опроса',
      options: {
        buttons: [
          [
            {
              type: 'callback',
              text: 'Новый ответ',
              payload: 'poll|v2|poll-1|option-new',
            },
          ],
        ],
        replaceCallbackPayloadPrefixes: ['poll|v2|poll-1|'],
      },
    });

    expect(httpService.request).toHaveBeenCalledTimes(2);
    expect(httpService.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages',
        params: { message_ids: 'mid-poll-answer-1' },
      }),
    );
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/answers',
        params: { callback_id: 'callback-poll-answer-1' },
        data: {
          message: {
            text: 'Текст опроса',
            attachments: [
              existingImage,
              {
                type: 'inline_keyboard',
                payload: {
                  buttons: [
                    [existingComments],
                    [
                      {
                        type: 'callback',
                        text: 'Новый ответ',
                        payload: 'poll|v2|poll-1|option-new',
                      },
                    ],
                    [unrelatedCallback],
                  ],
                },
              },
            ],
          },
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it.each(['message', 'chat', 'poll', 'private-chat', 'noncanonical-chat'] as const)(
    'rejects an invalid bound poll callback %s before preparation',
    async (invalid) => {
      const httpService = { request: jest.fn() };
      const service = createService(httpService);
      const edit: NonNullable<Parameters<MaxClientService['answerCallback']>[2]> = {
        messageId: 'mid-poll',
        text: 'Poll',
      };
      const options: NonNullable<Parameters<MaxClientService['answerCallback']>[3]> = {
        rateLimitEntityId: '-100',
        boundObject: { kind: 'poll', id: 'poll-1' },
      };
      if (invalid === 'message') delete edit.messageId;
      if (invalid === 'chat') delete options.rateLimitEntityId;
      if (invalid === 'poll') options.boundObject = { kind: 'poll', id: '' };
      if (invalid === 'private-chat') options.rateLimitEntityId = '12345';
      if (invalid === 'noncanonical-chat') options.rateLimitEntityId = ' -100 ';
      try {
        const error = await service
          .answerCallback('callback-invalid', undefined, edit, options)
          .catch((caught: unknown) => caught);
        expect(wasMaxPreDispatchGuardRejected(error)).toBe(true);
        expect(httpService.request).not.toHaveBeenCalled();
      } finally {
        await service.onModuleDestroy();
      }
    },
  );

  it('does not mark a callback dispatch attempt when exact-message preparation fails', async () => {
    const preparationError = new Error('Exact callback message lookup failed');
    const httpService = {
      request: jest.fn().mockReturnValueOnce(throwError(() => preparationError)),
    };
    const service = createService(httpService);
    const onDispatchAttempt = jest.fn();

    await expect(
      service.answerCallback(
        'callback-prepare-failure',
        undefined,
        {
          messageId: 'mid-callback-prepare-failure',
          text: 'Текст опроса',
        },
        { onDispatchAttempt },
      ),
    ).rejects.toBe(preparationError);

    expect(onDispatchAttempt).not.toHaveBeenCalled();
    expect(httpService.request).toHaveBeenCalledTimes(1);
    expect(httpService.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'get' }));
    expect(httpService.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'post' }),
    );

    await service.onModuleDestroy();
  });

  it('marks a callback dispatch immediately before POST even when the POST fails', async () => {
    const order: string[] = [];
    const dispatchError = new Error('Callback answer POST failed');
    const httpService = {
      request: jest.fn().mockImplementation((config: { method: string }) => {
        if (config.method === 'get') {
          order.push('get');
          return of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-callback-dispatch-failure',
                    text: 'Текст опроса',
                    attachments: [],
                  },
                },
              ],
            },
          });
        }
        order.push('post');
        return throwError(() => dispatchError);
      }),
    };
    const service = createService(httpService);
    const onDispatchAttempt = jest.fn(() => {
      order.push('dispatch-attempt');
    });

    await expect(
      service.answerCallback(
        'callback-dispatch-failure',
        undefined,
        {
          messageId: 'mid-callback-dispatch-failure',
          text: 'Текст опроса',
        },
        { onDispatchAttempt },
      ),
    ).rejects.toBe(dispatchError);

    expect(order).toEqual(['get', 'dispatch-attempt', 'post']);
    expect(onDispatchAttempt).toHaveBeenCalledTimes(1);
    expect(httpService.request).toHaveBeenCalledTimes(2);

    await service.onModuleDestroy();
  });

  it('does not edit a message after losing the keyboard lock before the mutation', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            messages: [
              {
                body: {
                  mid: 'mid-lost-edit-lock-1',
                  text: 'Текст опроса',
                  attachments: [],
                },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);
    const evalMock = (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis
      .eval;
    const originalEval = evalMock.getMockImplementation()!;
    let renewalCount = 0;
    evalMock.mockImplementation(async (script: string, ...args: unknown[]) => {
      if (script.includes('MAX_MESSAGE_EDIT_LOCK_RENEW_V1')) {
        renewalCount += 1;
        return renewalCount === 1 ? 1 : 0;
      }
      return originalEval(script, ...args);
    });

    await expect(
      service.editMessageInlineKeyboard('channel-1', 'mid-lost-edit-lock-1', 'Текст опроса', {
        buttons: [
          [
            {
              type: 'callback',
              text: 'Да',
              payload: 'poll|v2|poll-1|option-1',
            },
          ],
        ],
      }),
    ).rejects.toThrow('Lost ownership of the MAX message keyboard edit lock');
    expect(httpService.request).toHaveBeenCalledTimes(1);
    expect(httpService.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'put' }),
    );
    expect(renewalCount).toBe(2);

    await service.onModuleDestroy();
  });

  it('synchronously rejects an expired keyboard lock after an asynchronous edit guard', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            messages: [
              {
                body: {
                  mid: 'mid-lost-edit-lock-after-guard-1',
                  text: 'Текст опроса',
                  attachments: [],
                },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);
    const evalMock = (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis
      .eval;
    const originalEval = evalMock.getMockImplementation()!;
    const checkedAtMs = Date.now();
    const now = jest.spyOn(Date, 'now').mockReturnValue(checkedAtMs);
    let renewalCount = 0;
    evalMock.mockImplementation(async (script: string, ...args: unknown[]) => {
      if (script.includes('MAX_MESSAGE_EDIT_LOCK_RENEW_V1')) {
        renewalCount += 1;
        return 1;
      }
      return originalEval(script, ...args);
    });
    const beforeEditMutation = jest.fn(async () => {
      now.mockReturnValue(checkedAtMs + 60_000);
    });

    await expect(
      service.editMessageInlineKeyboard(
        'channel-1',
        'mid-lost-edit-lock-after-guard-1',
        'Текст опроса',
        {
          buttons: [
            [
              {
                type: 'callback',
                text: 'Да',
                payload: 'poll|v2|poll-1|option-1',
              },
            ],
          ],
          beforeEditMutation,
        },
      ),
    ).rejects.toThrow('Lost ownership of the MAX message keyboard edit lock');

    expect(beforeEditMutation).toHaveBeenCalledTimes(1);
    expect(renewalCount).toBe(2);
    expect(httpService.request).toHaveBeenCalledTimes(1);
    expect(httpService.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'put' }),
    );

    now.mockRestore();
    await service.onModuleDestroy();
  });

  it('does not answer a callback after losing the exact-message keyboard lock', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            messages: [
              {
                body: {
                  mid: 'mid-lost-callback-lock-1',
                  text: 'Текст опроса',
                  attachments: [],
                },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);
    const evalMock = (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis
      .eval;
    const originalEval = evalMock.getMockImplementation()!;
    let renewalCount = 0;
    evalMock.mockImplementation(async (script: string, ...args: unknown[]) => {
      if (script.includes('MAX_MESSAGE_EDIT_LOCK_RENEW_V1')) {
        renewalCount += 1;
        return renewalCount === 1 ? 1 : 0;
      }
      return originalEval(script, ...args);
    });

    await expect(
      service.answerCallback('callback-lost-lock-1', undefined, {
        messageId: 'mid-lost-callback-lock-1',
        text: 'Текст опроса',
        options: {
          buttons: [
            [
              {
                type: 'callback',
                text: 'Да',
                payload: 'poll|v2|poll-1|option-1',
              },
            ],
          ],
        },
      }),
    ).rejects.toThrow('Lost ownership of the MAX message keyboard edit lock');
    expect(httpService.request).toHaveBeenCalledTimes(1);
    expect(httpService.request).not.toHaveBeenCalledWith(
      expect.objectContaining({ method: 'post' }),
    );
    expect(renewalCount).toBe(2);

    await service.onModuleDestroy();
  });

  it('serializes callback and comment-counter keyboard edits for the same message', async () => {
    const commentsButton = {
      type: 'link' as const,
      text: 'Комментарии · 1',
      url: 'https://major-maksimov.ru/app/',
    };
    let currentAttachments: unknown[] = [];
    let releaseAnswer!: () => void;
    let markAnswerStarted!: () => void;
    const answerGate = new Promise<void>((resolve) => {
      releaseAnswer = resolve;
    });
    const answerStarted = new Promise<void>((resolve) => {
      markAnswerStarted = resolve;
    });
    const httpService = {
      request: jest.fn().mockImplementation((config: any) => {
        if (config.method === 'get') {
          return of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-serialized-keyboard-1',
                    text: 'Текст опроса',
                    attachments: currentAttachments,
                  },
                },
              ],
            },
          });
        }
        if (config.method === 'post' && config.url.endsWith('/answers')) {
          markAnswerStarted();
          return from(
            answerGate.then(() => {
              currentAttachments = config.data.message.attachments;
              return { status: 200, data: { success: true } };
            }),
          );
        }
        if (config.method === 'put') {
          currentAttachments = config.data.attachments;
          return of({ status: 200, data: { success: true } });
        }
        throw new Error(`Unexpected request ${config.method} ${config.url}`);
      }),
    };
    const service = createService(httpService);

    const callbackEdit = service.answerCallback('callback-serialized-1', undefined, {
      messageId: 'mid-serialized-keyboard-1',
      text: 'Текст опроса',
      options: {
        buttons: [
          [
            {
              type: 'callback',
              text: 'Да',
              payload: 'poll|v2|poll-1|option-1',
            },
          ],
        ],
        replaceCallbackPayloadPrefixes: ['poll|v2|poll-1|'],
      },
    });
    await answerStarted;

    const counterEdit = service.editMessageInlineKeyboard(
      'channel-1',
      'mid-serialized-keyboard-1',
      null,
      {
        buttons: [[commentsButton]],
        appendNewInlineKeyboardRows: true,
        mergeExistingInlineKeyboard: true,
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      httpService.request.mock.calls.filter(([config]: [any]) => config.method === 'get'),
    ).toHaveLength(1);

    releaseAnswer();
    await Promise.all([callbackEdit, counterEdit]);

    expect(currentAttachments).toEqual([
      {
        type: 'inline_keyboard',
        payload: {
          buttons: [
            [
              {
                type: 'callback',
                text: 'Да',
                payload: 'poll|v2|poll-1|option-1',
              },
            ],
            [commentsButton],
          ],
        },
      },
    ]);

    await service.onModuleDestroy();
  });

  it('preserves explicit source tags and action health lanes for callback answers', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-01T18:00:45.000Z'));

    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            success: true,
          },
        }),
      ),
    };
    const service = createService(httpService);
    const limiterRedis = (
      service as unknown as {
        limiterRedis: { get: jest.Mock; sadd: jest.Mock; smembers: jest.Mock };
      }
    ).limiterRedis;
    const nowSec = Math.floor(Date.now() / 1_000);

    await service.answerCallback('callback-2', 'Открываю', undefined, {
      actionHealthLane: 'background',
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_NOTICE,
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/answers',
        params: { callback_id: 'callback-2' },
        data: { notification: 'Открываю' },
      }),
    );
    await expect(
      limiterRedis.get(`maxapi:rps:source:v1:777000_bot:critical:moderation_notice:${nowSec}`),
    ).resolves.toBe('1');

    await service.onModuleDestroy();
  });

  it('sends direct messages via user_id when notifying a private user', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            mid: 'mid-private-1',
            recipient: {
              chat_id: '165176099',
            },
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.sendMessageImmediateToUser('user-42', 'Личное уведомление');

    expect(result).toEqual({
      messageId: 'mid-private-1',
      url: null,
      chatId: '165176099',
    });
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        params: {
          user_id: 'user-42',
        },
        data: {
          text: 'Личное уведомление',
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('runs the direct-user send fence immediately before the MAX POST', async () => {
    const order: string[] = [];
    const httpService = {
      request: jest.fn().mockImplementationOnce(() => {
        order.push('post');
        return of({
          status: 200,
          data: {
            mid: 'mid-private-fenced',
            recipient: { chat_id: '165176099' },
          },
        });
      }),
    };
    const service = createService(httpService);

    await service.sendMessageImmediateToUser('user-42', 'Личное уведомление', {
      beforeSend: async () => {
        order.push('fence');
      },
    });

    expect(order).toEqual(['fence', 'post']);
    await service.onModuleDestroy();
  });

  it('reposts a source chat message as bot copy with preserved attachments and reply link', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-source-1',
                    text: 'Исходный пост админа',
                    markup: [
                      {
                        from: 0,
                        type: 'strong',
                        length: 8,
                      },
                    ],
                    attachments: [
                      {
                        type: 'image',
                        payload: { token: 'upload-token-1' },
                      },
                    ],
                  },
                  link: {
                    type: 'reply',
                    message: {
                      mid: 'mid-parent-1',
                    },
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              mid: 'mid-copy-1',
              url: 'https://max.ru/chats/chat-1/message/789',
            },
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.sendMessageCopyWithInlineKeyboard(
      'chat-1',
      'mid-source-1',
      'Фолбэк текст',
      {
        button: {
          text: '💬 Комментарии',
          url: 'https://major-maksimov.ru/app/',
        },
      },
    );

    expect(result).toEqual({
      messageId: 'mid-copy-1',
      url: 'https://max.ru/chats/chat-1/message/789',
    });
    expect(httpService.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages',
        params: { message_ids: 'mid-source-1' },
      }),
    );
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        params: { chat_id: 'chat-1' },
        data: {
          text: '<strong>Исходный</strong> пост админа',
          format: 'html',
          link: {
            type: 'reply',
            mid: 'mid-parent-1',
          },
          attachments: [
            {
              type: 'image',
              payload: { token: 'upload-token-1' },
            },
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [
                    {
                      type: 'link',
                      text: '💬 Комментарии',
                      url: 'https://major-maksimov.ru/app/',
                    },
                  ],
                ],
              },
            },
          ],
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('runs the replacement send fence after source preparation and immediately before POST', async () => {
    const order: string[] = [];
    const httpService = {
      request: jest
        .fn()
        .mockImplementationOnce(() => {
          order.push('get');
          return of({
            status: 200,
            data: {
              messages: [{ body: { mid: 'mid-source-fence', text: 'Source', attachments: [] } }],
            },
          });
        })
        .mockImplementationOnce(() => {
          order.push('post');
          return of({ status: 200, data: { mid: 'mid-copy-fence' } });
        }),
    };
    const service = createService(httpService);

    await service.sendMessageCopyWithInlineKeyboard('chat-1', 'mid-source-fence', 'Source', {
      inspectSource: (message) => {
        expect(message?.body).toMatchObject({ mid: 'mid-source-fence', text: 'Source' });
        order.push('inspect');
      },
      beforeSend: async () => {
        order.push('fence');
      },
    });

    expect(order).toEqual(['get', 'inspect', 'fence', 'post']);
    await service.onModuleDestroy();
  });

  it('does not run the replacement send fence when reading the source message fails', async () => {
    const beforeSend = jest.fn();
    const httpService = {
      request: jest.fn().mockReturnValue(
        throwError(() => ({
          response: { status: 404, data: { code: 'message.not.found' } },
          message: 'Source message not found',
        })),
      ),
    };
    const service = createService(httpService);

    const error = await service
      .sendMessageCopyWithInlineKeyboard('chat-1', 'mid-source-missing', 'Source', { beforeSend })
      .catch((caught: unknown) => caught);

    expect(beforeSend).not.toHaveBeenCalled();
    expect(httpService.request).toHaveBeenCalledTimes(2);
    expect(httpService.request.mock.calls.map(([request]) => request.method)).toEqual([
      'get',
      'get',
    ]);
    expect(wasMaxMessageSendAttempted(error)).toBe(false);
    await service.onModuleDestroy();
  });

  it('does not POST when the replacement send fence cannot be persisted', async () => {
    const fenceError = new Error('marker unavailable');
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            messages: [{ body: { mid: 'mid-source-no-post', text: 'Source', attachments: [] } }],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const error = await service
      .sendMessageCopyWithInlineKeyboard('chat-1', 'mid-source-no-post', 'Source', {
        beforeSend: async () => {
          throw fenceError;
        },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBe(fenceError);
    expect(httpService.request).toHaveBeenCalledTimes(1);
    expect(wasMaxMessageSendAttempted(error)).toBe(false);
    await service.onModuleDestroy();
  });

  it('marks a replacement POST timeout as an attempted MAX send', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [{ body: { mid: 'mid-source-timeout', text: 'Source', attachments: [] } }],
            },
          }),
        )
        .mockReturnValueOnce(
          throwError(() => Object.assign(new Error('send timed out'), { code: 'ETIMEDOUT' })),
        ),
    };
    const service = createService(httpService);

    const error = await service
      .sendMessageCopyWithInlineKeyboard('chat-1', 'mid-source-timeout', 'Source', {
        beforeSend: async () => undefined,
      })
      .catch((caught: unknown) => caught);

    expect(wasMaxMessageSendAttempted(error)).toBe(true);
    await service.onModuleDestroy();
  });

  it('marks a replacement response without a message id as an attempted MAX send', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [{ body: { mid: 'mid-source-no-id', text: 'Source', attachments: [] } }],
            },
          }),
        )
        .mockReturnValueOnce(of({ status: 200, data: { success: true } })),
    };
    const service = createService(httpService);

    const error = await service
      .sendMessageCopyWithInlineKeyboard('chat-1', 'mid-source-no-id', 'Source', {
        beforeSend: async () => undefined,
      })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(wasMaxMessageSendAttempted(error)).toBe(true);
    await service.onModuleDestroy();
  });

  it('uses fallback text and linked attachments when reposting a forwarded message', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-forward-source-1',
                    text: '',
                    attachments: [],
                  },
                  link: {
                    type: 'forward',
                    message: {
                      text: 'Пересланный пост',
                      attachments: [
                        {
                          type: 'image',
                          payload: { token: 'upload-token-forward-1' },
                        },
                      ],
                    },
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              mid: 'mid-forward-copy-1',
              url: 'https://max.ru/chats/chat-1/message/790',
            },
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.sendMessageCopyWithInlineKeyboard(
      'chat-1',
      'mid-forward-source-1',
      'Пересланный пост',
      {
        button: {
          text: '💬 Комментарии',
          url: 'https://major-maksimov.ru/app/',
        },
      },
    );

    expect(result).toEqual({
      messageId: 'mid-forward-copy-1',
      url: 'https://max.ru/chats/chat-1/message/790',
    });
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        params: { chat_id: 'chat-1' },
        data: {
          text: 'Пересланный пост',
          attachments: [
            {
              type: 'image',
              payload: { token: 'upload-token-forward-1' },
            },
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [
                    {
                      type: 'link',
                      text: '💬 Комментарии',
                      url: 'https://major-maksimov.ru/app/',
                    },
                  ],
                ],
              },
            },
          ],
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('preserves linked forwarded message markup and paragraphs when reposting with inline keyboard', async () => {
    const sourceText = '🔥MAX Docs\n\nВторой абзац';
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-forward-rich-source-1',
                    text: '',
                    attachments: [],
                  },
                  link: {
                    type: 'forward',
                    message: {
                      text: sourceText,
                      markup: [
                        {
                          from: 2,
                          type: 'strong',
                          length: 8,
                        },
                        {
                          from: 2,
                          type: 'link',
                          length: 8,
                          url: 'https://dev.max.ru/docs-api',
                        },
                      ],
                    },
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              mid: 'mid-forward-rich-copy-1',
              url: 'https://max.ru/chats/chat-1/message/791',
            },
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.sendMessageCopyWithInlineKeyboard(
      'chat-1',
      'mid-forward-rich-source-1',
      sourceText,
      {
        button: {
          text: '💬 Комментарии',
          url: 'https://major-maksimov.ru/app/',
        },
      },
    );

    expect(result).toEqual({
      messageId: 'mid-forward-rich-copy-1',
      url: 'https://max.ru/chats/chat-1/message/791',
    });
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        params: { chat_id: 'chat-1' },
        data: expect.objectContaining({
          text: '🔥<a href="https://dev.max.ru/docs-api"><strong>MAX Docs</strong></a>\n\nВторой абзац',
          format: 'html',
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('preserves multi-paragraph MAX markup when reposting a source message copy', async () => {
    const sourceText = 'Заголовок\n\nВторой абзац';
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-source-paragraphs-1',
                    text: sourceText,
                    markup: [
                      {
                        from: 0,
                        type: 'strong',
                        length: sourceText.length,
                      },
                    ],
                    attachments: [],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              mid: 'mid-copy-paragraphs-1',
              url: 'https://max.ru/chats/chat-1/message/792',
            },
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.sendMessageCopyWithInlineKeyboard(
      'chat-1',
      'mid-source-paragraphs-1',
      sourceText,
      {
        button: {
          text: '💬 Комментарии',
          url: 'https://major-maksimov.ru/app/',
        },
      },
    );

    expect(result).toEqual({
      messageId: 'mid-copy-paragraphs-1',
      url: 'https://max.ru/chats/chat-1/message/792',
    });
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        params: { chat_id: 'chat-1' },
        data: expect.objectContaining({
          text: '<strong>Заголовок</strong>\n\n<strong>Второй абзац</strong>',
          format: 'html',
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('reconstructs nested emoji-rich MAX markup as escaped HTML without generated Markdown', async () => {
    const first = 'Первая **буквально**';
    const second = 'Вторая <tag> [скобки]';
    const sourceText = `🔥${first}\n\n${second}`;
    const secondStart = sourceText.indexOf(second);
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-source-nested-html-1',
                    text: sourceText,
                    markup: [
                      { from: 2, type: 'strong', length: sourceText.length - 2 },
                      { from: 2, type: 'emphasized', length: first.length },
                      { from: secondStart, type: 'underline', length: second.length },
                    ],
                    attachments: [],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(of({ status: 200, data: { mid: 'mid-copy-nested-html-1' } })),
    };
    const service = createService(httpService);

    await service.sendMessageCopyWithInlineKeyboard(
      'chat-1',
      'mid-source-nested-html-1',
      sourceText,
    );

    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          text: `🔥<strong><em>${first}</em></strong>\n\n<strong><u>Вторая &lt;tag&gt; [скобки]</u></strong>`,
          format: 'html',
        }),
      }),
    );
    await service.onModuleDestroy();
  });

  it('preserves current official heading, highlight, quote, and user_id markup when reposting', async () => {
    const sourceText = 'Title\nFocus\nQuote\nUser';
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-source-current-markup-1',
                    text: sourceText,
                    markup: [
                      { type: 'heading', from: 0, length: 5 },
                      { type: 'highlighted', from: 6, length: 5 },
                      { type: 'quote', from: 12, length: 5 },
                      { type: 'user_mention', from: 18, length: 4, user_id: 67123224 },
                    ],
                    attachments: [],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(of({ status: 200, data: { mid: 'mid-copy-current-markup-1' } })),
    };
    const service = createService(httpService);

    await service.sendMessageCopyWithInlineKeyboard(
      'chat-1',
      'mid-source-current-markup-1',
      sourceText,
    );

    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          text: '<h3>Title</h3>\n<mark>Focus</mark>\n<blockquote>Quote</blockquote>\n<a href="max://user/67123224">User</a>',
          format: 'html',
        }),
      }),
    );
    await service.onModuleDestroy();
  });

  it('canonicalizes partially overlapping MAX ranges into balanced HTML segments', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-source-crossing-html-1',
                    text: 'ABCDEFGH',
                    markup: [
                      { from: 0, type: 'strong', length: 5 },
                      { from: 3, type: 'emphasized', length: 5 },
                    ],
                    attachments: [],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(of({ status: 200, data: { mid: 'mid-copy-crossing-html-1' } })),
    };
    const service = createService(httpService);

    await service.sendMessageCopyWithInlineKeyboard(
      'chat-1',
      'mid-source-crossing-html-1',
      'ABCDEFGH',
    );

    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          text: '<strong>ABC<em>DE</em></strong><em>FGH</em>',
          format: 'html',
        }),
      }),
    );
    await service.onModuleDestroy();
  });

  it('preserves MAX body markup when editing inline keyboard on an existing message', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-edit-markup-1',
                    text: '🔥Привет мир',
                    markup: [
                      {
                        from: 2,
                        type: 'strong',
                        length: 6,
                      },
                    ],
                    attachments: [],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              success: true,
            },
          }),
        ),
    };
    const service = createService(httpService);

    await service.editMessageInlineKeyboard('chat-1', 'mid-edit-markup-1', '🔥Привет мир', {
      button: {
        text: 'Открыть',
        url: 'https://major-maksimov.ru/app/',
      },
    });

    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'put',
        url: 'https://platform-api2.max.ru/messages',
        params: {
          message_id: 'mid-edit-markup-1',
        },
        data: expect.objectContaining({
          text: '🔥<strong>Привет</strong> мир',
          format: 'html',
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('extracts MAX body markup as markdown text for imported rules', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            messages: [
              {
                body: {
                  mid: 'mid-rules-markup-1',
                  text: '🔥MAX Docs',
                  markup: [
                    {
                      from: 2,
                      type: 'strong',
                      length: 8,
                    },
                    {
                      from: 2,
                      type: 'emphasized',
                      length: 8,
                    },
                    {
                      from: 2,
                      type: 'underline',
                      length: 8,
                    },
                    {
                      from: 2,
                      type: 'link',
                      length: 8,
                      url: 'https://dev.max.ru/docs-api',
                    },
                  ],
                },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getMessageTextAsMarkdown('mid-rules-markup-1');

    expect(result).toBe('🔥[**_++MAX Docs++_**](https://dev.max.ru/docs-api)');
    await service.onModuleDestroy();
  });

  it('extracts alternate MAX body text markup fields as markdown text', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            messages: [
              {
                body: {
                  mid: 'mid-rules-text-markup-1',
                  text: 'MAX Docs',
                  text_markup: [
                    {
                      from: 0,
                      type: 'strong',
                      length: 8,
                    },
                  ],
                },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getMessageTextAsMarkdown('mid-rules-text-markup-1');

    expect(result).toBe('**MAX Docs**');
    await service.onModuleDestroy();
  });

  it('normalizes MAX user_link and user_id mention markup to max user links', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            messages: [
              {
                body: {
                  mid: 'mid-rules-mention-1',
                  text: 'Стас Анна',
                  markup: [
                    {
                      from: 0,
                      type: 'user_mention',
                      length: 4,
                      user_link: 'user/67123224',
                    },
                    {
                      from: 5,
                      type: 'user_mention',
                      length: 4,
                      user_id: 67123225,
                    },
                  ],
                },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getMessageTextAsMarkdown('mid-rules-mention-1');

    expect(result).toBe('[Стас](max://user/67123224) [Анна](max://user/67123225)');
    await service.onModuleDestroy();
  });

  it('extracts current official heading, highlight, and quote markup as markdown', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            messages: [
              {
                body: {
                  mid: 'mid-rules-current-markup-1',
                  text: 'Title\nFocus\nQuote',
                  markup: [
                    { type: 'heading', from: 0, length: 5 },
                    { type: 'highlighted', from: 6, length: 5 },
                    { type: 'quote', from: 12, length: 5 },
                  ],
                },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getMessageTextAsMarkdown('mid-rules-current-markup-1');

    expect(result).toBe('# Title\n^^Focus^^\n> Quote');
    await service.onModuleDestroy();
  });

  it('extracts crossing MAX markup as balanced markdown', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            messages: [
              {
                body: {
                  mid: 'mid-rules-crossing-markup-1',
                  text: 'ABCDEFGH',
                  markup: [
                    { type: 'strong', from: 0, length: 5 },
                    { type: 'emphasized', from: 3, length: 5 },
                  ],
                },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    await expect(service.getMessageTextAsMarkdown('mid-rules-crossing-markup-1')).resolves.toBe(
      '**ABC_DE_**_FGH_',
    );
    await service.onModuleDestroy();
  });

  it('does not expose markdown escapes inside extracted monospaced text', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            messages: [
              {
                body: {
                  mid: 'mid-rules-code-markup-1',
                  text: 'a_b*c',
                  markup: [{ type: 'monospaced', from: 0, length: 5 }],
                },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    await expect(service.getMessageTextAsMarkdown('mid-rules-code-markup-1')).resolves.toBe(
      '`a_b*c`',
    );
    await service.onModuleDestroy();
  });

  it('splits multi-paragraph MAX markup when extracting markdown text', async () => {
    const sourceText = 'Заголовок\n\nВторой абзац';
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            messages: [
              {
                body: {
                  mid: 'mid-rules-markup-2',
                  text: sourceText,
                  markup: [
                    {
                      from: 0,
                      type: 'strong',
                      length: sourceText.length,
                    },
                  ],
                },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getMessageTextAsMarkdown('mid-rules-markup-2');

    expect(result).toBe('**Заголовок**\n\n**Второй абзац**');
    await service.onModuleDestroy();
  });

  it('falls back to direct message lookup when batch lookup returns a different message', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-other-1',
                    text: 'Не тот пост',
                    attachments: [
                      {
                        type: 'image',
                        payload: { token: 'wrong-image-token' },
                      },
                    ],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              body: {
                mid: 'mid-edit-fallback-1',
                text: 'Старое сообщение',
                attachments: [
                  {
                    type: 'inline_keyboard',
                    payload: {
                      buttons: [
                        [{ type: 'callback', text: 'Да (1)', payload: 'action|sample-1|1|0' }],
                      ],
                    },
                  },
                ],
              },
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              success: true,
            },
          }),
        ),
    };
    const service = createService(httpService);

    await service.editMessageInlineKeyboard('chat-1', 'mid-edit-fallback-1', 'Итоги действия', {
      buttons: [[{ type: 'callback', text: 'Да (2)', payload: 'action|sample-1|1|0' }]],
    });

    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages/mid-edit-fallback-1',
      }),
    );
    expect(httpService.request).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        method: 'put',
        url: 'https://platform-api2.max.ru/messages',
        params: {
          message_id: 'mid-edit-fallback-1',
        },
        data: {
          text: 'Итоги действия',
          attachments: [
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [[{ type: 'callback', text: 'Да (2)', payload: 'action|sample-1|1|0' }]],
              },
            },
          ],
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('replaces a guarded private keyboard and retains original media in the actual PUT', async () => {
    const httpService = {
      request: jest.fn().mockReturnValue(of({ status: 200, data: { success: true } })),
    };
    const service = createService(httpService);
    const media = { type: 'image', payload: { token: 'photo-token' } };
    jest.spyOn(service as any, 'getMessageById').mockResolvedValue({
      body: {
        text: 'Предложка',
        attachments: [
          media,
          {
            type: 'inline_keyboard',
            payload: {
              buttons: [
                [{ type: 'callback', text: 'Опубликовать', payload: 'sr1|publish|id|0|0' }],
              ],
            },
          },
        ],
      },
    });
    const beforeEditMutation = jest.fn().mockResolvedValue(undefined);
    try {
      await service.editMessageInlineKeyboard('101', 'card', 'Опубликовано', {
        buttons: [],
        requireAllAttachmentsPreserved: true,
        replaceOwnedInlineKeyboard: true,
        beforeEditMutation,
      });
      expect(beforeEditMutation).toHaveBeenCalledTimes(1);
      expect(httpService.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'put',
          data: { text: 'Опубликовано', attachments: [media] },
        }),
      );
      httpService.request.mockClear();
      for (const [chatId, guard] of [
        ['-101', beforeEditMutation],
        ['101', undefined],
      ] as const) {
        await expect(
          service.editMessageInlineKeyboard(chatId, 'card', null, {
            buttons: [],
            requireAllAttachmentsPreserved: true,
            replaceOwnedInlineKeyboard: true,
            beforeEditMutation: guard,
          }),
        ).rejects.toThrow('guarded private card');
      }
      expect(httpService.request).not.toHaveBeenCalled();
    } finally {
      await service.onModuleDestroy();
    }
  });

  it.each([false, true])(
    'uses fresh prepared text instead of stale caller text (omit=%s)',
    async (omitText) => {
      const httpService = {
        request: jest.fn().mockReturnValue(of({ status: 200, data: { success: true } })),
      };
      const service = createService(httpService);
      const media = { type: 'image', payload: { token: 'photo-token' } };
      const snapshot = { body: { text: 'Fresh author edit', attachments: [media] } };
      jest.spyOn(service as any, 'getMessageById').mockResolvedValue(snapshot);
      const prepareMessageText = jest.fn().mockResolvedValue(
        omitText
          ? null
          : {
              text: '<strong>Fresh author edit</strong>\n\nSignature',
              textFormat: 'html',
            },
      );
      await service.editMessageInlineKeyboard('channel-1', 'fresh-post', 'Stale webhook', {
        textFormat: 'markdown',
        prepareMessageText,
        requireAllAttachmentsPreserved: true,
      });
      expect(prepareMessageText).toHaveBeenCalledWith(snapshot);
      expect(httpService.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'put',
          data: {
            ...(omitText
              ? {}
              : { text: '<strong>Fresh author edit</strong>\n\nSignature', format: 'html' }),
            attachments: [media],
          },
        }),
      );
      await service.onModuleDestroy();
    },
  );

  it('prepares a copied post from the fetched source instead of the stale fallback', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValue(of({ status: 200, data: { message: { body: { mid: 'copy' } } } })),
    };
    const service = createService(httpService);
    const snapshot = { body: { text: 'Fresh source', attachments: [] } };
    jest.spyOn(service as any, 'getMessageById').mockResolvedValue(snapshot);
    const prepareMessageText = jest.fn().mockResolvedValue({ text: 'Fresh source + signature' });
    await service.sendMessageCopyWithInlineKeyboard('channel-1', 'source', 'Stale source', {
      prepareMessageText,
    });
    expect(prepareMessageText).toHaveBeenCalledWith(snapshot);
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        data: expect.objectContaining({ text: 'Fresh source + signature' }),
      }),
    );
    await service.onModuleDestroy();
  });

  it('does not mutate a message when fresh text preparation fails', async () => {
    const httpService = { request: jest.fn() };
    const service = createService(httpService);
    jest
      .spyOn(service as any, 'getMessageById')
      .mockResolvedValue({ body: { text: 'Post', attachments: [] } });
    await expect(
      service.editMessageInlineKeyboard('channel-1', 'fresh-post', 'Stale', {
        prepareMessageText: async () => {
          throw new Error('Failed preparation');
        },
      }),
    ).rejects.toThrow('Failed preparation');
    expect(httpService.request).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it('honors explicit html text format when editing an existing message', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-edit-html-1',
                    text: 'Старый текст',
                    attachments: [],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              success: true,
            },
          }),
        ),
    };
    const service = createService(httpService);

    await service.editMessageInlineKeyboard('chat-1', 'mid-edit-html-1', '<p>Новый текст</p>', {
      textFormat: 'html',
    });

    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'put',
        url: 'https://platform-api2.max.ru/messages',
        params: {
          message_id: 'mid-edit-html-1',
        },
        data: expect.objectContaining({
          text: '<p>Новый текст</p>',
          format: 'html',
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('edits a contact post using the documented contact identity and preserves existing buttons', async () => {
    const httpService = {
      request: jest.fn().mockReturnValue(of({ status: 200, data: { success: true } })),
    };
    const service = createService(httpService);
    const existing = { type: 'callback', text: 'Vote', payload: 'poll|one' };
    const added = { type: 'link' as const, text: 'Suggest', url: 'https://example.com/' };
    jest.spyOn(service as any, 'getMessageById').mockResolvedValue({
      body: {
        text: null,
        attachments: [
          {
            type: 'contact',
            payload: {
              max_info: {
                user_id: 123456789,
                first_name: 'Test',
                last_name: 'Contact',
                name: 'Test Contact',
                is_bot: false,
                last_activity_time: 0,
              },
            },
          },
          { type: 'inline_keyboard', payload: { buttons: [[existing]] } },
        ],
      },
    });
    try {
      await service.editMessageInlineKeyboard('channel-1', 'contact-post', null, {
        requireAllAttachmentsPreserved: true,
        mergeExistingInlineKeyboard: true,
        buttons: [[added]],
      });
      expect(httpService.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'put',
          data: {
            attachments: [
              { type: 'contact', payload: { contact_id: '123456789', name: 'Test Contact' } },
              { type: 'inline_keyboard', payload: { buttons: [[added], [existing]] } },
            ],
          },
        }),
      );
    } finally {
      await service.onModuleDestroy();
    }
  });

  it.each([
    { max_info: { user_id: Number.MAX_SAFE_INTEGER + 1 } },
    { contact_id: '123', max_info: { user_id: 456 } },
    { max_info: { user_id: 123 }, unknown: 'must not disappear' },
  ])('refuses an unsafe contact before any PUT: %j', async (payload) => {
    const httpService = { request: jest.fn() };
    const service = createService(httpService);
    jest.spyOn(service as any, 'getMessageById').mockResolvedValue({
      body: { text: null, attachments: [{ type: 'contact', payload }] },
    });
    try {
      await expect(
        service.editMessageInlineKeyboard('channel-1', 'contact-post', null, {
          requireAllAttachmentsPreserved: true,
          buttons: [[{ type: 'link', text: 'Suggest', url: 'https://example.com/' }]],
        }),
      ).rejects.toThrow('Contact data cannot be preserved');
      expect(httpService.request).not.toHaveBeenCalled();
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('preserves all media, existing buttons and explicit rich text when converting channel templates', async () => {
    const httpService = {
      request: jest.fn().mockReturnValue(of({ status: 200, data: { success: true } })),
    };
    const service = createService(httpService);
    const media = ['image', 'video', 'audio', 'file'].map((type) => ({
      type,
      payload: { token: `${type}-token` },
    }));
    const existingButton = { type: 'callback', text: 'Vote', payload: 'poll|one' };
    const newButton = { type: 'link' as const, text: 'Read', url: 'https://example.com/' };
    jest.spyOn(service as any, 'getMessageById').mockResolvedValue({
      body: {
        text: 'Post "Read"="https://example.com"',
        attachments: [
          ...media,
          { type: 'inline_keyboard', payload: { buttons: [[existingButton]] } },
        ],
      },
    });
    await service.editMessageInlineKeyboard('channel-1', 'mid-quick', '<strong>Post</strong> ', {
      textFormat: 'html',
      expectedSourceText: 'Post "Read"="https://example.com"',
      requireAllAttachmentsPreserved: true,
      mergeExistingInlineKeyboard: true,
      buttons: [[newButton]],
    });
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'put',
        data: {
          text: '<strong>Post</strong> ',
          format: 'html',
          attachments: [
            ...media,
            { type: 'inline_keyboard', payload: { buttons: [[newButton], [existingButton]] } },
          ],
        },
      }),
    );
    await service.onModuleDestroy();
  });

  it('copies nested forwarded media with cleaned rich text before source cleanup can run', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValue(of({ status: 200, data: { message: { body: { mid: 'new-copy' } } } })),
    };
    const service = createService(httpService);
    const attachment = { type: 'video', payload: { token: 'video-token' } };
    jest.spyOn(service as any, 'getMessageById').mockResolvedValue({
      body: { text: '' },
      link: {
        type: 'forward',
        message: { body: { text: 'Post "Read"="https://example.com"', attachments: [attachment] } },
      },
    });
    const beforeSend = jest.fn().mockResolvedValue(undefined);
    const copy = await service.sendMessageCopyWithInlineKeyboard(
      'channel-1',
      'mid-quick',
      '<strong>Post</strong> ',
      {
        textFormat: 'html',
        expectedSourceText: 'Post "Read"="https://example.com"',
        requireAllAttachmentsPreserved: true,
        mergeExistingInlineKeyboard: true,
        buttons: [[{ type: 'link', text: 'Read', url: 'https://example.com/' }]],
        beforeSend,
      },
    );
    expect(copy.messageId).toBe('new-copy');
    expect(beforeSend).toHaveBeenCalledTimes(1);
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        data: expect.objectContaining({
          text: '<strong>Post</strong> ',
          format: 'html',
          attachments: expect.arrayContaining([attachment]),
        }),
      }),
    );
    await service.onModuleDestroy();
  });

  it.each(['edit', 'copy'] as const)(
    'does not mutate a changed source during strict %s',
    async (mode) => {
      const httpService = { request: jest.fn() };
      const service = createService(httpService);
      jest
        .spyOn(service as any, 'getMessageById')
        .mockResolvedValue({ body: { text: 'Changed by admin', attachments: [] } });
      const options = {
        expectedSourceText: 'Original template',
        requireAllAttachmentsPreserved: true,
      };
      const operation =
        mode === 'edit'
          ? service.editMessageInlineKeyboard('channel-1', 'mid-quick', 'Replacement', options)
          : service.sendMessageCopyWithInlineKeyboard(
              'channel-1',
              'mid-quick',
              'Replacement',
              options,
            );
      await expect(operation).rejects.toThrow('Source text changed');
      expect(httpService.request).not.toHaveBeenCalled();
      await service.onModuleDestroy();
    },
  );

  it.each(['missing-media-payload', 'keyboard-overflow'] as const)(
    'leaves the original untouched on %s',
    async (failure) => {
      const httpService = { request: jest.fn() };
      const service = createService(httpService);
      const attachments =
        failure === 'missing-media-payload'
          ? [{ type: 'image' }]
          : [
              {
                type: 'inline_keyboard',
                payload: {
                  buttons: Array.from({ length: 30 }, (_, i) => [
                    { type: 'link', text: `${i}`, url: `https://example.com/${i}` },
                  ]),
                },
              },
            ];
      jest
        .spyOn(service as any, 'getMessageById')
        .mockResolvedValue({ body: { text: 'Post', attachments } });
      await expect(
        service.editMessageInlineKeyboard('channel-1', 'mid-quick', 'Post', {
          expectedSourceText: 'Post',
          requireAllAttachmentsPreserved: true,
          mergeExistingInlineKeyboard: true,
          buttons: [[{ type: 'link', text: 'Read', url: 'https://example.com/new' }]],
        }),
      ).rejects.toThrow('would be lost');
      expect(httpService.request).not.toHaveBeenCalled();
      await service.onModuleDestroy();
    },
  );

  it('does not overwrite newer formatting on unchanged source text', async () => {
    const httpService = { request: jest.fn() };
    const service = createService(httpService);
    jest.spyOn(service as any, 'getMessageById').mockResolvedValue({
      body: { text: 'Post', markup: [{ type: 'strong', from: 0, length: 4 }] },
    });
    await expect(
      service.editMessageInlineKeyboard('channel-1', 'mid-quick', 'Post', {
        expectedSourceText: 'Post',
        expectedSourceMarkup: [],
        requireAllAttachmentsPreserved: true,
      }),
    ).rejects.toThrow('Source formatting changed');
    expect(httpService.request).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it('requires an affirmative MAX response for a strict post edit', async () => {
    const httpService = {
      request: jest.fn().mockReturnValue(of({ status: 200, data: { success: false } })),
    };
    const service = createService(httpService);
    jest
      .spyOn(service as any, 'getMessageById')
      .mockResolvedValue({ body: { text: 'Post', attachments: [] } });
    await expect(
      service.editMessageInlineKeyboard('channel-1', 'mid-quick', 'Post', {
        requireAllAttachmentsPreserved: true,
      }),
    ).rejects.toThrow();
    await service.onModuleDestroy();
  });

  it('converts quick buttons after a concurrent keyboard addition without losing either action', async () => {
    const httpService = {
      request: jest.fn().mockReturnValue(of({ status: 200, data: { success: true } })),
    };
    const service = createService(httpService);
    const existing = { type: 'link', text: 'Shop', url: 'https://example.com/shop' };
    const quick = { type: 'link' as const, text: 'Read', url: 'https://example.com/' };
    jest.spyOn(service as any, 'getMessageById').mockResolvedValue({
      body: {
        text: 'Post\nRead=https://example.com',
        attachments: [{ type: 'inline_keyboard', payload: { buttons: [[existing]] } }],
      },
    });
    await service.editMessageInlineKeyboard('channel-1', 'mid-quick', 'Post\n', {
      expectedSourceAttachmentTypes: [],
      requireAllAttachmentsPreserved: true,
      mergeExistingInlineKeyboard: true,
      buttons: [[quick]],
    });
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'put',
        data: expect.objectContaining({
          attachments: [{ type: 'inline_keyboard', payload: { buttons: [[quick], [existing]] } }],
        }),
      }),
    );
    await service.onModuleDestroy();
  });

  it('serializes fresh counts and changes only the live button label', async () => {
    const button = {
      type: 'link' as const,
      text: 'Comments 0',
      url: 'https://example.com/comments',
    };
    const shop = { type: 'link' as const, text: 'New shop', url: 'https://example.com/shop' };
    let snapshot = {
      body: {
        text: 'Post',
        attachments: [{ type: 'inline_keyboard', payload: { buttons: [[shop], [button]] } }],
      },
    };
    const httpService = {
      request: jest.fn().mockImplementation((config: any) => {
        snapshot = { body: { text: 'Post', attachments: config.data.attachments } };
        return of({ status: 200, data: { success: true } });
      }),
    };
    const service = createService(httpService);
    jest
      .spyOn(service as any, 'getMessageById')
      .mockImplementation(async () => JSON.parse(JSON.stringify(snapshot)));
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let count = 1;
    const first = service.editMessageInlineKeyboard('channel-1', 'counter-race', null, {
      refreshButtonText: {
        button,
        readText: async () => {
          entered();
          await gate;
          return `Comments ${count}`;
        },
      },
    });
    await started;
    const readText = jest.fn(async () => `Comments ${count}`);
    const second = service.editMessageInlineKeyboard('channel-1', 'counter-race', null, {
      buttons: [[{ ...shop, text: 'Old shop' }]],
      refreshButtonText: { button, readText },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(readText).not.toHaveBeenCalled();
    count = 2;
    release();
    await Promise.all([first, second]);
    expect(readText).toHaveBeenCalledTimes(1);
    expect(httpService.request).toHaveBeenCalledTimes(1);
    expect(snapshot.body.attachments[0]!.payload.buttons).toEqual([
      [shop],
      [{ ...button, text: 'Comments 2' }],
    ]);
    expect(httpService.request.mock.calls[0]![0].data).not.toHaveProperty('text');
    await service.onModuleDestroy();
  });

  it('does not clear media when the message GET omits webhook attachments', async () => {
    const httpService = { request: jest.fn() };
    const service = createService(httpService);
    jest.spyOn(service as any, 'getMessageById').mockResolvedValue({ body: { text: 'Post' } });
    await expect(
      service.editMessageInlineKeyboard('channel-1', 'mid-quick', 'Post', {
        expectedSourceAttachmentTypes: ['image'],
        requireAllAttachmentsPreserved: true,
        buttons: [[{ type: 'link', text: 'Read', url: 'https://example.com/' }]],
      }),
    ).rejects.toThrow('Source attachments changed');
    expect(httpService.request).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it('does not treat a missing known source keyboard as a concurrent keyboard addition', async () => {
    const httpService = { request: jest.fn() };
    const service = createService(httpService);
    jest
      .spyOn(service as any, 'getMessageById')
      .mockResolvedValue({ body: { text: 'Post', attachments: [] } });
    await expect(
      service.editMessageInlineKeyboard('channel-1', 'mid-missing-keyboard', 'Post', {
        expectedSourceAttachmentTypes: ['inline_keyboard'],
        requireAllAttachmentsPreserved: true,
        buttons: [[{ type: 'link', text: 'Read', url: 'https://example.com/' }]],
      }),
    ).rejects.toThrow('Source attachments changed');
    expect(httpService.request).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it('preserves an existing inline keyboard when a text-only decorator edits the message', async () => {
    const existingKeyboard = {
      type: 'inline_keyboard',
      payload: {
        buttons: [
          [
            {
              type: 'link',
              text: 'Открыть',
              url: 'https://major-maksimov.ru/app/',
            },
          ],
        ],
      },
    };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-edit-preserve-keyboard-1',
                    text: 'Исходный текст',
                    attachments: [
                      { type: 'image', payload: { token: 'image-token-1' } },
                      existingKeyboard,
                    ],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(of({ status: 200, data: { success: true } })),
    };
    const service = createService(httpService);

    await service.editMessageInlineKeyboard(
      'chat-1',
      'mid-edit-preserve-keyboard-1',
      'Исходный текст<br><br><a href="https://max.ru/channel">Канал</a>',
      {
        textFormat: 'html',
        preserveExistingInlineKeyboard: true,
      },
    );

    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'put',
        data: expect.objectContaining({
          format: 'html',
          attachments: [{ type: 'image', payload: { token: 'image-token-1' } }, existingKeyboard],
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('replaces only matching callback payload prefixes during an active poll edit', async () => {
    const existingImage = { type: 'image', payload: { token: 'poll-image-token' } };
    const commentsButton = {
      type: 'link',
      text: 'Комментарии',
      url: 'https://major-maksimov.ru/app/channel/channel-1/dialog/comments?token=comments-1',
    };
    const unrelatedPollCallback = {
      type: 'callback',
      text: 'Другой опрос',
      payload: 'poll|v2|poll-10|option-1',
    };
    const customCallback = {
      type: 'callback',
      text: 'Настроить',
      payload: 'custom|settings',
    };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-active-poll-edit-1',
                    text: 'Текст опроса',
                    attachments: [
                      existingImage,
                      {
                        type: 'inline_keyboard',
                        payload: {
                          buttons: [
                            [commentsButton],
                            [
                              {
                                type: 'callback',
                                text: 'Старый 1',
                                payload: 'poll|v2|poll-1|option-old-1',
                              },
                            ],
                            [
                              {
                                type: 'callback',
                                text: 'Старый 2',
                                payload: 'poll|v2|poll-1|option-old-2',
                              },
                              customCallback,
                            ],
                            [unrelatedPollCallback],
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(of({ status: 200, data: { success: true } })),
    };
    const service = createService(httpService);

    await service.editMessageInlineKeyboard('channel-1', 'mid-active-poll-edit-1', 'Текст опроса', {
      buttons: [
        [
          {
            type: 'callback',
            text: 'Новый 1',
            payload: 'poll|v2|poll-1|option-new-1',
          },
        ],
        [
          {
            type: 'callback',
            text: 'Новый 2',
            payload: 'poll|v2|poll-1|option-new-2',
          },
        ],
      ],
      replaceCallbackPayloadPrefixes: ['poll|v2|poll-1|'],
    });

    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'put',
        data: expect.objectContaining({
          attachments: [
            existingImage,
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [commentsButton],
                  [
                    {
                      type: 'callback',
                      text: 'Новый 1',
                      payload: 'poll|v2|poll-1|option-new-1',
                    },
                  ],
                  [
                    {
                      type: 'callback',
                      text: 'Новый 2',
                      payload: 'poll|v2|poll-1|option-new-2',
                    },
                  ],
                  [customCallback],
                  [unrelatedPollCallback],
                ],
              },
            },
          ],
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('unwraps the exact direct-message fallback before preserving poll media and engagement', async () => {
    const existingImage = { type: 'image', payload: { token: 'poll-image-token' } };
    const commentsButton = {
      type: 'link',
      text: 'Комментарии',
      url: 'https://major-maksimov.ru/app/channel/channel-1/dialog/comments?token=comments-1',
    };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [{ body: { mid: 'some-other-message', attachments: [] } }],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              message: {
                body: {
                  mid: 'mid-direct-wrapper-poll-1',
                  text: 'Текст опроса',
                  attachments: [
                    existingImage,
                    {
                      type: 'inline_keyboard',
                      payload: {
                        buttons: [
                          [
                            {
                              type: 'callback',
                              text: 'Старый ответ',
                              payload: 'poll|v2|poll-1|option-old',
                            },
                          ],
                          [commentsButton],
                        ],
                      },
                    },
                  ],
                },
              },
            },
          }),
        )
        .mockReturnValueOnce(of({ status: 200, data: { success: true } })),
    };
    const service = createService(httpService);

    await service.editMessageInlineKeyboard(
      'channel-1',
      'mid-direct-wrapper-poll-1',
      'Текст опроса',
      {
        buttons: [
          [
            {
              type: 'callback',
              text: 'Новый ответ',
              payload: 'poll|v2|poll-1|option-new',
            },
          ],
        ],
        replaceCallbackPayloadPrefixes: ['poll|v2|poll-1|'],
      },
    );

    expect(httpService.request).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        method: 'put',
        data: expect.objectContaining({
          attachments: [
            existingImage,
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [
                    {
                      type: 'callback',
                      text: 'Новый ответ',
                      payload: 'poll|v2|poll-1|option-new',
                    },
                  ],
                  [commentsButton],
                ],
              },
            },
          ],
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('adds missing poll engagement without duplicating an existing dialog button', async () => {
    const threadId = '12345678-1234-4123-8123-123456789abc';
    const token = `cdt-${Buffer.from(
      JSON.stringify({ v: 1, d: threadId, s: 'a'.repeat(64) }),
      'utf8',
    ).toString('base64url')}`;
    const commentsButton = {
      type: 'link' as const,
      text: 'Комментарии',
      url: `https://major-maksimov.ru/app/channel/channel-1/dialog/comments?token=${token}`,
    };
    const existingSuggestButton = {
      type: 'link' as const,
      text: 'Предложить пост',
      url: `https://major-maksimov.ru/app/channel/channel-1/dialog/suggest?token=${token}`,
    };
    const rebuiltSuggestButton = {
      ...existingSuggestButton,
      text: 'Предложить',
    };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-missing-engagement-1',
                    text: 'Текст опроса',
                    attachments: [
                      {
                        type: 'inline_keyboard',
                        payload: {
                          buttons: [
                            [
                              {
                                type: 'callback',
                                text: 'Старый ответ',
                                payload: 'poll|v2|poll-1|option-old',
                              },
                            ],
                            [existingSuggestButton],
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(of({ status: 200, data: { success: true } })),
    };
    const service = createService(httpService);

    await service.editMessageInlineKeyboard(
      'channel-1',
      'mid-missing-engagement-1',
      'Текст опроса',
      {
        buttons: [
          [
            {
              type: 'callback',
              text: 'Новый ответ',
              payload: 'poll|v2|poll-1|option-new',
            },
          ],
          [commentsButton],
          [rebuiltSuggestButton],
        ],
        replaceCallbackPayloadPrefixes: ['poll|v2|poll-1|'],
      },
    );

    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'put',
        data: expect.objectContaining({
          attachments: [
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [
                    {
                      type: 'callback',
                      text: 'Новый ответ',
                      payload: 'poll|v2|poll-1|option-new',
                    },
                  ],
                  [commentsButton],
                  [existingSuggestButton],
                ],
              },
            },
          ],
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('removes only matching callback payload prefixes when a poll closes', async () => {
    const existingImage = { type: 'image', payload: { token: 'poll-image-token' } };
    const commentsButton = {
      type: 'link',
      text: 'Комментарии',
      url: 'https://major-maksimov.ru/app/channel/channel-1/dialog/comments?token=comments-1',
    };
    const unrelatedCallback = {
      type: 'callback',
      text: 'Другое действие',
      payload: 'custom|action',
    };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-closed-poll-edit-1',
                    text: 'Текст опроса',
                    attachments: [
                      existingImage,
                      {
                        type: 'inline_keyboard',
                        payload: {
                          buttons: [
                            [
                              {
                                type: 'callback',
                                text: 'Ответ',
                                payload: 'poll|v2|poll-1|option-1',
                              },
                            ],
                            [commentsButton],
                            [unrelatedCallback],
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(of({ status: 200, data: { success: true } })),
    };
    const service = createService(httpService);

    await service.editMessageInlineKeyboard('channel-1', 'mid-closed-poll-edit-1', 'Текст опроса', {
      replaceCallbackPayloadPrefixes: ['poll|v2|poll-1|'],
    });

    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'put',
        data: expect.objectContaining({
          attachments: [
            existingImage,
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [[commentsButton], [unrelatedCallback]],
              },
            },
          ],
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('updates a channel dialog label when the route changes but the thread stays the same', async () => {
    const threadId = '12345678-1234-4123-8123-123456789abc';
    const token = `cdt-${Buffer.from(
      JSON.stringify({ v: 1, d: threadId, s: 'a'.repeat(64) }),
      'utf8',
    ).toString('base64url')}`;
    const startParam = `cd-${Buffer.from(
      JSON.stringify({
        v: 1,
        k: 'channel-dialog',
        c: 'channel-1',
        m: 'comments',
        t: token,
      }),
      'utf8',
    ).toString('base64url')}`;
    const existingCommentsUrl = `https://major-maksimov.ru/app/channel/channel-1/dialog/comments?token=${token}`;
    const updatedCommentsUrl = `https://max.ru/bot-2?startapp=${startParam}`;
    const existingKeyboard = {
      type: 'inline_keyboard',
      payload: {
        buttons: [
          [
            {
              type: 'link',
              text: 'Комментарии · 1',
              url: existingCommentsUrl,
            },
          ],
          [
            {
              type: 'link',
              text: 'Сайт',
              url: 'https://example.com/',
            },
          ],
        ],
      },
    };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-edit-merge-keyboard-1',
                    text: 'Исходный текст',
                    attachments: [
                      { type: 'image', payload: { token: 'image-token-1' } },
                      existingKeyboard,
                    ],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(of({ status: 200, data: { success: true } })),
    };
    const service = createService(httpService);

    await service.editMessageInlineKeyboard(
      'chat-1',
      'mid-edit-merge-keyboard-1',
      'Исходный текст',
      {
        buttons: [
          [
            {
              type: 'link',
              text: 'Комментарии · 2',
              url: updatedCommentsUrl,
            },
          ],
        ],
        mergeExistingInlineKeyboard: true,
      },
    );

    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'put',
        data: expect.objectContaining({
          attachments: [
            { type: 'image', payload: { token: 'image-token-1' } },
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [
                    {
                      type: 'link',
                      text: 'Комментарии · 2',
                      url: updatedCommentsUrl,
                    },
                  ],
                  [
                    {
                      type: 'link',
                      text: 'Сайт',
                      url: 'https://example.com/',
                    },
                  ],
                ],
              },
            },
          ],
        }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('keeps custom row order and the existing thread while appending scanner system buttons', async () => {
    const buildDialogUrl = (kind: 'comments' | 'suggest', threadId: string) => {
      const token = `cdt-${Buffer.from(
        JSON.stringify({ v: 1, d: threadId, s: 'a'.repeat(64) }),
        'utf8',
      ).toString('base64url')}`;
      const payload = Buffer.from(
        JSON.stringify({
          v: 1,
          k: 'channel-dialog',
          c: 'channel-1',
          m: kind,
          t: token,
        }),
        'utf8',
      ).toString('base64url');
      return `https://max.ru/bot-1?startapp=cd-${payload}`;
    };
    const existingCommentsUrl = buildDialogUrl('comments', 'existing-thread');
    const replacementCommentsUrl = buildDialogUrl('comments', 'new-thread');
    const suggestionUrl = buildDialogUrl('suggest', 'new-thread');
    const existingKeyboard = {
      type: 'inline_keyboard',
      payload: {
        buttons: [
          [
            {
              type: 'link',
              text: 'Обсудить публикацию',
              url: existingCommentsUrl,
            },
          ],
          [{ type: 'link', text: 'Сайт', url: 'https://example.com/' }],
          [
            {
              type: 'link',
              text: 'Комментарии другого канала',
              url: 'https://major-maksimov.ru/app/channel/channel-2/dialog/comments?token=cdt-other',
            },
          ],
        ],
      },
    };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-edit-semantic-merge-1',
                    text: 'Исходный текст',
                    attachments: [existingKeyboard],
                  },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(of({ status: 200, data: { success: true } })),
    };
    const service = createService(httpService);

    await service.editMessageInlineKeyboard(
      'channel-1',
      'mid-edit-semantic-merge-1',
      'Исходный текст',
      {
        buttons: [
          [{ type: 'link', text: 'Комментарии', url: replacementCommentsUrl }],
          [{ type: 'link', text: 'Предложить', url: suggestionUrl }],
        ],
        appendNewInlineKeyboardRows: true,
        mergeExistingInlineKeyboard: true,
      },
    );

    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          attachments: [
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [{ type: 'link', text: 'Сайт', url: 'https://example.com/' }],
                  [
                    {
                      type: 'link',
                      text: 'Комментарии другого канала',
                      url: 'https://major-maksimov.ru/app/channel/channel-2/dialog/comments?token=cdt-other',
                    },
                  ],
                  [
                    {
                      type: 'link',
                      text: 'Обсудить публикацию',
                      url: existingCommentsUrl,
                    },
                  ],
                  [{ type: 'link', text: 'Предложить', url: suggestionUrl }],
                ],
              },
            },
          ],
        }),
      }),
    );

    const editRequest = httpService.request.mock.calls[1]?.[0] as {
      data?: { attachments?: Array<{ payload?: { buttons?: unknown[][] } }> };
    };
    const deliveredButtons = editRequest.data?.attachments?.[0]?.payload?.buttons?.flat() ?? [];
    expect(deliveredButtons).not.toContainEqual(
      expect.objectContaining({ url: replacementCommentsUrl }),
    );
    await service.onModuleDestroy();
  });

  it.each(['', null, undefined])(
    'omits text when editing a forwarded message with body text %j',
    async (bodyText) => {
      const httpService = {
        request: jest
          .fn()
          .mockReturnValueOnce(
            of({
              status: 200,
              data: {
                messages: [
                  {
                    body: {
                      mid: 'mid-edit-forward-1',
                      text: bodyText,
                      attachments: [],
                    },
                    link: {
                      type: 'forward',
                      message: {
                        text: 'Пересланный текст',
                      },
                    },
                  },
                ],
              },
            }),
          )
          .mockReturnValueOnce(
            of({
              status: 200,
              data: {
                success: true,
              },
            }),
          ),
      };
      const service = createService(httpService);

      await service.editMessageInlineKeyboard('chat-1', 'mid-edit-forward-1', 'Пересланный текст', {
        button: {
          text: 'Открыть',
          url: 'https://major-maksimov.ru/app/',
        },
      });

      expect(httpService.request).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          method: 'put',
          url: 'https://platform-api2.max.ru/messages',
          params: {
            message_id: 'mid-edit-forward-1',
          },
          data: {
            attachments: [
              {
                type: 'inline_keyboard',
                payload: {
                  buttons: [
                    [
                      {
                        type: 'link',
                        text: 'Открыть',
                        url: 'https://major-maksimov.ru/app/',
                      },
                    ],
                  ],
                },
              },
            ],
          },
        }),
      );

      await service.onModuleDestroy();
    },
  );

  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])(
    'edits only the forward wrapper without reattaching nested media (strict %s, direct %s)',
    async (strict, hasDirectAttachments) => {
      const existing = { type: 'link', text: 'Existing', url: 'https://example.com/existing' };
      const added = {
        type: 'link' as const,
        text: 'Comments',
        url: 'https://example.com/comments',
      };
      const directMedia = { type: 'image', payload: { token: 'direct-image' } };
      const message = {
        body: {
          mid: 'forward-wrapper',
          text: null,
          attachments: hasDirectAttachments
            ? [directMedia, { type: 'inline_keyboard', payload: { buttons: [[existing]] } }]
            : [],
        },
        link: {
          type: 'forward',
          message: {
            text: 'Original',
            body: { attachments: [{ type: 'video', payload: { token: 'linked-video' } }] },
            attachments: [{ type: 'image', payload: { token: 'linked-image' } }],
          },
        },
      };
      const httpService = {
        request: jest
          .fn()
          .mockReturnValueOnce(of({ status: 200, data: { messages: [message] } }))
          .mockReturnValueOnce(of({ status: 200, data: { success: true } })),
      };
      const service = createService(httpService);
      try {
        await service.editMessageInlineKeyboard('channel-1', 'forward-wrapper', null, {
          buttons: [[added]],
          mergeExistingInlineKeyboard: true,
          requireAllAttachmentsPreserved: strict,
        });
        const request = httpService.request.mock.calls[1]![0];
        expect(request.method).toBe('put');
        expect(request.data).toEqual({
          attachments: [
            ...(hasDirectAttachments ? [directMedia] : []),
            {
              type: 'inline_keyboard',
              payload: { buttons: hasDirectAttachments ? [[added], [existing]] : [[added]] },
            },
          ],
        });
        expect(message.link.message.body.attachments[0]!.payload.token).toBe('linked-video');
      } finally {
        await service.onModuleDestroy();
      }
    },
  );

  it('sends attachment-only reply messages with inline keyboard', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            success: true,
            message: {
              message_id: 'mid-reply-1',
            },
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.sendMessageReplyWithInlineKeyboard('chat-1', 'mid-source-1', 'Открыть действия', {
      button: {
        text: 'Открыть',
        url: 'https://major-maksimov.ru/app/',
      },
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        params: {
          chat_id: 'chat-1',
        },
        data: {
          text: 'Открыть действия',
          link: {
            type: 'reply',
            mid: 'mid-source-1',
          },
          attachments: [
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [
                    {
                      type: 'link',
                      text: 'Открыть',
                      url: 'https://major-maksimov.ru/app/',
                    },
                  ],
                ],
              },
            },
          ],
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('publishes message and resolves post link via follow-up message fetch', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              mid: 'mid-rules-1',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              messages: [
                {
                  body: { mid: 'mid-rules-1' },
                  message_url: 'https://max.ru/chats/chat-1/message/123',
                },
              ],
            },
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.sendMessageImmediateWithResolvedLink('chat-1', 'Правила чата', {
      textFormat: 'markdown',
    });

    expect(result).toEqual({
      messageId: 'mid-rules-1',
      url: 'https://max.ru/chats/chat-1/message/123',
    });
    expect(httpService.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        params: { chat_id: 'chat-1' },
        data: { text: 'Правила чата', format: 'markdown' },
      }),
    );
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages',
        params: { message_ids: 'mid-rules-1' },
      }),
    );

    await service.onModuleDestroy();
  });

  it('uses link returned directly by MAX send response when available', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            message_id: 'mid-rules-2',
            url: 'https://max.ru/chats/chat-1/message/456',
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.sendMessageImmediateWithResolvedLink('chat-1', 'Правила');

    expect(result).toEqual({
      messageId: 'mid-rules-2',
      url: 'https://max.ru/chats/chat-1/message/456',
    });
    expect(httpService.request).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('runs an immediate send fence before the MAX POST', async () => {
    const order: string[] = [];
    const httpService = {
      request: jest.fn().mockImplementationOnce(() => {
        order.push('post');
        return of({
          status: 200,
          data: {
            message_id: 'mid-fenced-reply',
            url: 'https://max.ru/chats/chat-1/message/fenced-reply',
          },
        });
      }),
    };
    const service = createService(httpService);

    await service.sendMessageImmediateWithResolvedLink('chat-1', 'Reply', {
      beforeSend: async () => {
        order.push('fence');
      },
    });

    expect(order).toEqual(['fence', 'post']);
    await service.onModuleDestroy();
  });

  it('uses nullable text for an immediate attachment-only reply', async () => {
    const order: string[] = [];
    const httpService = {
      request: jest.fn().mockImplementationOnce(() => {
        order.push('post');
        return of({
          status: 200,
          data: {
            message_id: 'mid-comments-reply',
            url: 'https://max.ru/chats/chat-1/message/comments-reply',
          },
        });
      }),
    };
    const service = createService(httpService);

    await service.sendMessageImmediateWithResolvedLink('chat-1', '', {
      buttons: [
        [
          {
            type: 'link',
            text: 'Комментарии',
            url: 'https://major-maksimov.ru/app/',
          },
        ],
      ],
      messageLink: {
        type: 'reply',
        mid: 'mid-source',
      },
      textFormat: 'markdown',
      beforeSend: async () => {
        order.push('fence');
      },
    });

    expect(order).toEqual(['fence', 'post']);
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        params: { chat_id: 'chat-1' },
        data: {
          text: null,
          link: {
            type: 'reply',
            mid: 'mid-source',
          },
          attachments: [
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [
                    {
                      type: 'link',
                      text: 'Комментарии',
                      url: 'https://major-maksimov.ru/app/',
                    },
                  ],
                ],
              },
            },
          ],
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('normalizes whitespace-only queued text when an inline keyboard is present', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: { message_id: 'mid-keyboard-only' },
        }),
      ),
    };
    const service = createService(httpService);

    await service.sendMessage(
      'chat-1',
      '   ',
      {
        button: {
          type: 'link',
          text: 'Открыть',
          url: 'https://example.com',
        },
        textFormat: 'markdown',
      },
      { immediate: true },
    );

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        params: { chat_id: 'chat-1' },
        data: {
          text: null,
          attachments: [
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [
                    {
                      type: 'link',
                      text: 'Открыть',
                      url: 'https://example.com/',
                    },
                  ],
                ],
              },
            },
          ],
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('normalizes whitespace-only text before a BullMQ send handoff', async () => {
    const actionQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const httpService = { request: jest.fn() };
    const service = createService(httpService, {}, actionQueue);

    await service.sendMessage('chat-1', '   ', {
      button: {
        type: 'link',
        text: 'Открыть',
        url: 'https://example.com',
      },
      textFormat: 'markdown',
    });

    expect(actionQueue.add).toHaveBeenCalledWith(
      'execute-max-action',
      expect.objectContaining({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        text: '',
        options: expect.objectContaining({ textFormat: 'markdown' }),
      }),
      expect.any(Object),
    );
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('normalizes whitespace-only immediate text when an inline keyboard is present', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: { message_id: 'mid-immediate-keyboard-only' },
        }),
      ),
    };
    const service = createService(httpService);

    await service.sendMessageImmediateWithId(
      'chat-1',
      '   ',
      {
        button: {
          type: 'link',
          text: 'Открыть',
          url: 'https://example.com',
        },
        textFormat: 'markdown',
      },
      {},
    );

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          text: null,
          attachments: expect.any(Array),
        }),
      }),
    );
    expect(httpService.request.mock.calls[0]?.[0]?.data).not.toHaveProperty('format');

    await service.onModuleDestroy();
  });

  it('normalizes whitespace-only direct-user text when an inline keyboard is present', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: { message_id: 'mid-user-keyboard-only' },
        }),
      ),
    };
    const service = createService(httpService);

    await service.sendMessageImmediateToUser('user-1', '   ', {
      button: {
        type: 'link',
        text: 'Открыть',
        url: 'https://example.com',
      },
      textFormat: 'markdown',
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { user_id: 'user-1' },
        data: expect.objectContaining({
          text: null,
          attachments: expect.any(Array),
        }),
      }),
    );
    expect(httpService.request.mock.calls[0]?.[0]?.data).not.toHaveProperty('format');

    await service.onModuleDestroy();
  });

  it('normalizes whitespace-only custom text when an attachment is present', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(of({ status: 200, data: { success: true } })),
    };
    const service = createService(httpService);

    await service.sendCustomMessageImmediate('chat-1', {
      text: '   ',
      textFormat: 'markdown',
      attachments: [{ type: 'image', payload: { token: 'image-token' } }],
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          text: null,
          attachments: [{ type: 'image', payload: { token: 'image-token' } }],
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('preserves a custom link-only message while omitting whitespace text formatting', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(of({ status: 200, data: { success: true } })),
    };
    const service = createService(httpService);

    await service.sendCustomMessageImmediate('chat-1', {
      text: '   ',
      textFormat: 'markdown',
      messageLink: { type: 'reply', mid: 'linked-message-1' },
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          text: null,
          link: { type: 'reply', mid: 'linked-message-1' },
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('rejects a whitespace-only queued message without non-text content before dispatch', async () => {
    const httpService = { request: jest.fn() };
    const service = createService(httpService);

    await expect(service.sendMessage('chat-1', '   ', { textFormat: 'markdown' })).rejects.toThrow(
      'MAX SEND_MESSAGE payload has no text, attachments, or link',
    );
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('rejects a stale empty queued action before calling MAX', async () => {
    const httpService = { request: jest.fn() };
    const service = createService(httpService);

    await expect(
      service.executeActionJob({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        text: '   ',
        options: { textFormat: 'markdown' },
        attempt: 1,
        idempotencyKey: 'empty-stale-send',
        createdAt: new Date().toISOString(),
      }),
    ).rejects.toThrow('MAX SEND_MESSAGE payload has no text, attachments, or link');
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('preserves invisible non-empty text for an immediate keyboard reply', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            message_id: 'mid-comments-reply',
            url: 'https://max.ru/chats/chat-1/message/comments-reply',
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.sendMessageImmediateWithResolvedLink('chat-1', '\u200B', {
      buttons: [
        [
          {
            type: 'link',
            text: 'Комментарии',
            url: 'https://major-maksimov.ru/app/',
          },
        ],
      ],
      messageLink: {
        type: 'reply',
        mid: 'mid-source',
      },
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        params: { chat_id: 'chat-1' },
        data: {
          text: '\u200B',
          link: {
            type: 'reply',
            mid: 'mid-source',
          },
          attachments: [
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [
                    {
                      type: 'link',
                      text: 'Комментарии',
                      url: 'https://major-maksimov.ru/app/',
                    },
                  ],
                ],
              },
            },
          ],
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('does not POST an immediate send when its fence cannot be persisted', async () => {
    const fenceError = new Error('reply marker unavailable');
    const httpService = { request: jest.fn() };
    const service = createService(httpService);

    const error = await service
      .sendMessageImmediateWithResolvedLink('chat-1', 'Reply', {
        beforeSend: async () => {
          throw fenceError;
        },
      })
      .catch((caught: unknown) => caught);

    expect(error).toBe(fenceError);
    expect(httpService.request).not.toHaveBeenCalled();
    expect(wasMaxMessageSendAttempted(error)).toBe(false);
    await service.onModuleDestroy();
  });

  it('passes request options to follow-up link resolution after send', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            mid: 'mid-rules-bot-1',
          },
        }),
      ),
    };
    const service = createService(httpService);
    const resolveSpy = jest
      .spyOn(service as any, 'resolveMessageLink')
      .mockResolvedValue('https://max.ru/chats/chat-1/message/999');

    const result = await service.sendMessageImmediateWithResolvedLink(
      'chat-1',
      'Правила чата',
      undefined,
      {
        botId: '777000_bot',
        trafficClass: 'critical',
      },
    );

    expect(result).toEqual({
      messageId: 'mid-rules-bot-1',
      url: 'https://max.ru/chats/chat-1/message/999',
    });
    expect(resolveSpy).toHaveBeenCalledWith(
      'mid-rules-bot-1',
      expect.objectContaining({
        botId: '777000_bot',
        trafficClass: 'critical',
      }),
    );

    await service.onModuleDestroy();
  });

  it('passes timeout override to immediate chat message sends', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            mid: 'mid-timeout-chat-1',
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.sendMessageImmediateWithId('chat-1', 'Сообщение', undefined, {
      timeoutMs: 1_234,
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        timeout: 1_234,
      }),
    );

    await service.onModuleDestroy();
  });

  it('passes timeout override to immediate private message sends', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            mid: 'mid-timeout-private-1',
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.sendMessageImmediateToUser('user-1', 'Сообщение', undefined, {
      timeoutMs: 2_345,
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        timeout: 2_345,
      }),
    );

    await service.onModuleDestroy();
  });

  it('passes timeout override to immediate custom message sends', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            mid: 'mid-timeout-custom-1',
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.sendCustomMessageImmediate(
      'chat-1',
      {
        text: 'Сообщение',
      },
      {
        timeoutMs: 3_456,
      },
    );

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        timeout: 3_456,
      }),
    );

    await service.onModuleDestroy();
  });

  it('passes timeout override to immediate reply-with-keyboard sends', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            mid: 'mid-timeout-reply-1',
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.sendMessageReplyWithInlineKeyboard(
      'chat-1',
      'mid-source-1',
      'Ответ',
      {
        button: {
          text: 'Открыть',
          url: 'https://max.ru/777000_bot?start=test',
        },
      },
      {
        timeoutMs: 4_567,
      },
    );

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        timeout: 4_567,
      }),
    );

    await service.onModuleDestroy();
  });

  it('keeps successful send result when follow-up link resolution fails', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            mid: 'mid-rules-send-ok-1',
          },
        }),
      ),
    };
    const service = createService(httpService);
    const resolveSpy = jest
      .spyOn(service as any, 'resolveMessageLink')
      .mockRejectedValue(new Error('resolve failed'));
    const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

    const result = await service.sendMessageImmediateWithResolvedLink('chat-1', 'Правила чата');

    expect(result).toEqual({
      messageId: 'mid-rules-send-ok-1',
      url: null,
    });
    expect(resolveSpy).toHaveBeenCalledWith('mid-rules-send-ok-1', {});
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'mid-rules-send-ok-1',
        err: 'resolve failed',
      }),
      'Failed to resolve MAX message link after successful send',
    );

    await service.onModuleDestroy();
  });

  it.each([403, 404])(
    'does not count ignored terminal send HTTP %s failures in action health metrics',
    async (status) => {
      const error = {
        response: {
          status,
          data: {
            code: status === 403 ? 'chat.denied' : 'chat.not.found',
            message: status === 403 ? 'Chat denied' : 'Chat not found',
          },
        },
      };
      const httpService = {
        request: jest.fn().mockReturnValueOnce(throwError(() => error)),
      };
      const service = createService(httpService);
      const warnSpy = jest
        .spyOn((service as any).logger, 'warn')
        .mockImplementation(() => undefined);
      const actionHealthService = (
        service as unknown as {
          actionHealthService: {
            recordSuccess: jest.Mock;
            recordFailure: jest.Mock;
            recordSuccessForLane: jest.Mock;
            recordFailureForLane: jest.Mock;
          };
        }
      ).actionHealthService;

      await expect(
        service.sendMessageImmediateWithId('chat-1', 'Правила', undefined, {
          ignoreFailureMetricStatuses: [403, 404],
        }),
      ).rejects.toBe(error);

      expect(actionHealthService.recordFailure).not.toHaveBeenCalled();
      expect(actionHealthService.recordSuccess).not.toHaveBeenCalled();
      expect(actionHealthService.recordFailureForLane).not.toHaveBeenCalled();
      expect(actionHealthService.recordSuccessForLane).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();

      await service.onModuleDestroy();
    },
  );

  it('logs privacy-safe unignored user-facing failures at most once per bot per 30 seconds', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-01T01:00:00.000Z'));
    const error = Object.assign(new Error('request failed for chat-private user-private'), {
      response: {
        status: 503,
        data: {
          code: 'service.unavailable',
          message: 'request failed for chat-private user-private',
        },
      },
    });
    const httpService = {
      request: jest.fn().mockReturnValue(throwError(() => error)),
    };
    const service = createService(httpService);
    const diagnostics = observeActionFailureDiagnostics(service);
    const requestOptions = {
      bypassCache: true,
      trafficClass: 'critical' as const,
      actionHealthLane: 'interactive' as const,
      sourceTag: 'Required Subscription Membership',
    };

    await expect(service.getChatTitle('chat-private-1', requestOptions)).rejects.toBe(error);
    await expect(service.getChatTitle('chat-private-2', requestOptions)).rejects.toBe(error);
    jest.advanceTimersByTime(29_999);
    await expect(service.getChatTitle('chat-private-3', requestOptions)).rejects.toBe(error);

    expect(diagnostics.warn).toHaveBeenCalledTimes(1);
    expect(diagnostics.warn).toHaveBeenLastCalledWith(
      {
        statusCode: 503,
        errorCode: 'service.unavailable',
        limitScope: null,
        trafficClass: 'critical',
        lane: 'interactive',
        sourceTag: 'required_subscription_membership',
        botId: '777000_bot',
        failureOrigin: 'unlinked',
        isCritical: true,
        requestAssociation: 'unlinked',
        method: 'unknown',
        endpointKind: 'unknown',
      },
      'Recorded unignored user-facing MAX API action failure',
    );

    jest.advanceTimersByTime(1);
    await expect(service.getChatTitle('chat-private-4', requestOptions)).rejects.toBe(error);

    expect(diagnostics.warn).toHaveBeenCalledTimes(3);
    expect(diagnostics.warn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        totalFailures: 3,
        unclassifiedFailures: 0,
        groups: [expect.objectContaining({ count: 3, errorCode: 'service.unavailable' })],
      }),
      'MAX action failure window summary',
    );
    expect(diagnostics.failure).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(diagnostics.warn.mock.calls)).not.toContain('chat-private');
    expect(JSON.stringify(diagnostics.warn.mock.calls)).not.toContain('user-private');

    await service.onModuleDestroy();
  });

  it.each([
    { status: 404, code: 'chat.not.found', isCritical: false },
    { status: 503, code: 'service.unavailable', isCritical: true },
    { status: 429, code: 'rate.limit', isCritical: true },
    { status: undefined, code: 'ECONNABORTED', isCritical: true },
  ])(
    '2A0 preserves classifier criticality $isCritical for $code without inferring an HTTP association',
    async ({ status, code, isCritical }) => {
      const error = Object.freeze(
        Object.assign(new Error('private-user private-chat private-token'), {
          code,
          ...(status === undefined ? {} : { response: { status, data: { code } } }),
          config: {
            method: 'post',
            url: 'https://private.example/messages',
            headers: { Authorization: 'private-token' },
            data: 'private-body',
          },
        }),
      );
      const service = createService({
        request: jest.fn().mockReturnValue(throwError(() => error)),
      });
      const diagnostics = observeActionFailureDiagnostics(service);
      try {
        await expect(
          service.getChatTitle('private-chat', {
            bypassCache: true,
            trafficClass: 'critical',
            actionHealthLane: 'critical',
            sourceTag: 'moderation_sanction',
          }),
        ).rejects.toBe(error);

        expect(diagnostics.failure).toHaveBeenCalledTimes(1);
        expect(diagnostics.failure).toHaveBeenCalledWith('critical', isCritical, '777000_bot');
        expect(diagnostics.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            failureOrigin: 'unlinked',
            isCritical,
            requestAssociation: 'unlinked',
            method: 'unknown',
            endpointKind: 'unknown',
          }),
          ACTION_FAILURE_WARNING,
        );
        const actionWarnings = diagnostics.warn.mock.calls.filter(
          ([, message]) => message === ACTION_FAILURE_WARNING,
        );
        expect(actionWarnings).toHaveLength(1);
        expect(JSON.stringify(actionWarnings)).not.toMatch(
          /private-(?:user|chat|token|body)|private\.example/,
        );
      } finally {
        await service.onModuleDestroy();
      }
    },
  );

  describe('2A invocation-owned HTTP failure diagnostics through public paths', () => {
    const requestOptions = {
      botId: '777000_bot',
      trafficClass: 'critical' as const,
      actionHealthLane: 'critical' as const,
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_SANCTION,
    };

    function executeMemberJob(service: MaxClientService) {
      return service.executeActionJob({
        actionType: 'KICK_MEMBER',
        chatId: 'private-chat',
        userId: 'private-user',
        attempt: 1,
        idempotencyKey: 'private-member-job',
        createdAt: new Date().toISOString(),
        ...requestOptions,
      });
    }

    function executeSelectedPath(
      service: MaxClientService,
      path: 'targeted_get' | 'message_delete' | 'member_delete',
    ) {
      if (path === 'targeted_get')
        return service.getChatMembersAccess('private-chat', ['private-user'], {
          ...requestOptions,
          bypassCache: true,
        });
      if (path === 'message_delete')
        return service.deleteMessage('private-chat', 'private-message', {
          ...requestOptions,
          immediate: true,
        });
      return executeMemberJob(service);
    }

    const readOptions = {
      ...requestOptions,
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      bypassCache: true,
    };
    type AssociatedReadPath =
      | 'message_row_list'
      | 'message_row_direct'
      | 'message_presence_list'
      | 'message_presence_direct'
      | 'current_bot_access'
      | 'chat_snapshot';

    function executeAssociatedRead(service: MaxClientService, path: AssociatedReadPath) {
      if (path === 'current_bot_access')
        return service.getCurrentChatMemberAccess('private-chat', readOptions);
      if (path === 'chat_snapshot') return service.getChatSnapshot('private-chat', readOptions);
      if (path.startsWith('message_presence'))
        return service.getExactMessagePresence('private-chat', 'private-message', readOptions);
      return service.getExactMessageRow('private-chat', 'private-message', readOptions);
    }

    function mockHttpRequest() {
      return jest.fn<ReturnType<HttpService['request']>, Parameters<HttpService['request']>>();
    }

    function messageListResponse(
      messages: readonly Record<string, unknown>[] = [],
    ): ReturnType<HttpService['request']> {
      return of({
        status: 200,
        statusText: 'OK',
        headers: {},
        config: { headers: new AxiosHeaders() },
        data: { messages },
      });
    }

    it.each(
      (
        [
          { path: 'message_row_list', endpointKind: 'messages' },
          { path: 'message_row_direct', endpointKind: 'message' },
          { path: 'message_presence_list', endpointKind: 'messages' },
          { path: 'message_presence_direct', endpointKind: 'message' },
          { path: 'current_bot_access', endpointKind: 'chat_member_self' },
          { path: 'chat_snapshot', endpointKind: 'chat' },
        ] satisfies { path: AssociatedReadPath; endpointKind: string }[]
      ).flatMap((target) =>
        (['synchronous', 'observable'] as const).map((mode) => ({ ...target, mode })),
      ),
    )(
      'links $path $mode timeout to its exact GET without borrowing private error.config',
      async ({ path, endpointKind, mode }) => {
        const error = Object.freeze(
          Object.assign(new Error('private-chat private-message private-token'), {
            code: 'ECONNABORTED',
            config: {
              method: 'delete',
              url: 'https://private.example/wrong-endpoint',
              headers: { Authorization: 'private-token' },
              data: 'private-body',
            },
          }),
        );
        const direct = path.endsWith('_direct');
        const request = mockHttpRequest().mockImplementation(() => {
          if (mode === 'synchronous') throw error;
          return throwError(() => error);
        });
        if (direct) request.mockReturnValueOnce(messageListResponse());
        const service = createService({ request });
        const diagnostics = observeActionFailureDiagnostics(service);
        try {
          await expect(executeAssociatedRead(service, path)).rejects.toBe(error);
          expect(request).toHaveBeenCalledTimes(direct ? 2 : 1);
          expect(request.mock.calls.every(([config]) => config.method === 'get')).toBe(true);
          expect(diagnostics.success).toHaveBeenCalledTimes(direct ? 1 : 0);
          expect(diagnostics.failure).toHaveBeenCalledTimes(1);
          expect(diagnostics.failure).toHaveBeenCalledWith('critical', true, '777000_bot');
          expect(diagnostics.warn).toHaveBeenCalledWith(
            {
              statusCode: null,
              errorCode: 'econnaborted',
              limitScope: null,
              trafficClass: 'critical',
              lane: 'critical',
              sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
              botId: '777000_bot',
              failureOrigin: 'unlinked',
              isCritical: true,
              requestAssociation: 'linked',
              method: 'get',
              endpointKind,
              phase: 'adapter_rejection',
              receivedStatusCode: null,
            },
            ACTION_FAILURE_WARNING,
          );
          expect(
            diagnostics.quota.mock.calls.filter(([script]) =>
              String(script).includes('MAX_API_CIRCUIT_FAILURE_V1'),
            ),
          ).toHaveLength(1);
          expect(JSON.stringify(diagnostics.warn.mock.calls)).not.toMatch(
            /private-(?:chat|message|token|body)|private\.example/,
          );
          expect(Object.getOwnPropertySymbols(error)).toEqual([]);
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it.each(['message_row_direct', 'message_presence_direct'] as const)(
      'keeps an ignored list404 separate from the %s timeout',
      async (path) => {
        const error = Object.freeze(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }));
        const request = mockHttpRequest()
          .mockReturnValueOnce(throwError(() => ({ response: { status: 404 } })))
          .mockReturnValueOnce(throwError(() => error));
        const service = createService({ request });
        const diagnostics = observeActionFailureDiagnostics(service);
        try {
          const options = { ...readOptions, ignoreFailureMetricStatuses: [404] };
          const result =
            path === 'message_row_direct'
              ? service.getExactMessageRow('private-chat', 'private-message', options)
              : service.getExactMessagePresence('private-chat', 'private-message', options);
          await expect(result).rejects.toBe(error);
          expect(request).toHaveBeenCalledTimes(2);
          expect(diagnostics.success).not.toHaveBeenCalled();
          expect(diagnostics.failure).toHaveBeenCalledTimes(1);
          expect(diagnostics.warn).toHaveBeenCalledTimes(1);
          expect(diagnostics.warn).toHaveBeenCalledWith(
            expect.objectContaining({
              requestAssociation: 'linked',
              method: 'get',
              endpointKind: 'message',
              phase: 'adapter_rejection',
              receivedStatusCode: null,
            }),
            ACTION_FAILURE_WARNING,
          );
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it('keeps batch and parallel direct-presence requests independently owned with one frozen error', async () => {
      const error = Object.freeze(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }));
      const requests = Array.from({ length: 51 }, (_, index) => ({
        chatId: 'private-chat',
        messageId: `private-message-${index}`,
      }));
      const directMessageIds = new Set(requests.slice(0, 4).map((item) => item.messageId));
      const request = mockHttpRequest().mockImplementation((config) =>
        config.url?.endsWith('/messages')
          ? messageListResponse(
              String(config.params?.message_ids ?? '')
                .split(',')
                .filter((messageId) => !directMessageIds.has(messageId))
                .map((messageId) => ({
                  body: { mid: messageId },
                  recipient: { chat_id: 'private-chat' },
                })),
            )
          : throwError(() => error),
      );
      const service = createService({ request });
      const diagnostics = observeActionFailureDiagnostics(service);
      try {
        const results = await service.getExactMessagePresences(requests, readOptions);
        expect(results).toHaveLength(51);
        expect(
          results.slice(0, 4).every((result) => 'error' in result && result.error === error),
        ).toBe(true);
        expect(
          results.slice(4).every((result) => 'presence' in result && result.presence === 'present'),
        ).toBe(true);
        expect(request).toHaveBeenCalledTimes(6);
        expect(diagnostics.success).toHaveBeenCalledTimes(2);
        expect(diagnostics.failure).toHaveBeenCalledTimes(4);
        expect(diagnostics.warn).toHaveBeenCalledTimes(1);
        expect(diagnostics.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            requestAssociation: 'linked',
            method: 'get',
            endpointKind: 'message',
            phase: 'adapter_rejection',
          }),
          ACTION_FAILURE_WARNING,
        );
        expect(JSON.stringify(diagnostics.warn.mock.calls)).not.toContain('private');
        expect(Object.getOwnPropertySymbols(error)).toEqual([]);
      } finally {
        await service.onModuleDestroy();
      }
    });

    it.each(['message_row_list', 'message_row_direct'] as const)(
      'attributes a final-guard %s timeout only to GET and never dispatches DELETE',
      async (path) => {
        const error = Object.freeze(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }));
        const request = mockHttpRequest().mockReturnValue(throwError(() => error));
        const direct = path.endsWith('_direct');
        if (direct) request.mockReturnValueOnce(messageListResponse());
        const service = createService({ request });
        const diagnostics = observeActionFailureDiagnostics(service);
        const guard = jest.fn(async () => {
          await executeAssociatedRead(service, path);
        });
        try {
          await expect(
            service.deleteMessage('private-chat', 'private-message', {
              ...readOptions,
              immediate: true,
              beforeImmediateDeleteMutation: guard,
            }),
          ).rejects.toBe(error);
          expect(wasMaxPreDispatchGuardRejected(error)).toBe(true);
          expect(guard).toHaveBeenCalledTimes(1);
          expect(request).toHaveBeenCalledTimes(direct ? 2 : 1);
          expect(request.mock.calls.every(([config]) => config.method === 'get')).toBe(true);
          expect(diagnostics.success).toHaveBeenCalledTimes(direct ? 1 : 0);
          expect(diagnostics.failure).toHaveBeenCalledTimes(1);
          expect(diagnostics.warn).toHaveBeenCalledTimes(1);
          expect(diagnostics.warn).toHaveBeenCalledWith(
            expect.objectContaining({
              requestAssociation: 'linked',
              method: 'get',
              endpointKind: direct ? 'message' : 'messages',
              phase: 'adapter_rejection',
            }),
            ACTION_FAILURE_WARNING,
          );
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it.each([
      { path: 'targeted_get' as const, method: 'get', endpointKind: 'chat_members' },
      { path: 'message_delete' as const, method: 'delete', endpointKind: 'messages' },
      { path: 'member_delete' as const, method: 'delete', endpointKind: 'chat_members' },
    ])(
      'links $path adapter rejection without borrowing error.config or changing accounting',
      async ({ path, method, endpointKind }) => {
        const error = Object.freeze(
          Object.assign(new Error('private-user private-chat private-token'), {
            response: { status: 404, data: { code: 'not.found' } },
            config: {
              method: 'post',
              url: 'https://private.example/incorrect-endpoint',
              headers: { Authorization: 'private-token' },
              data: 'private-body',
            },
          }),
        );
        const request = jest.fn().mockReturnValue(throwError(() => error));
        const service = createService({ request });
        const diagnostics = observeActionFailureDiagnostics(service);
        try {
          await expect(executeSelectedPath(service, path)).rejects.toBe(error);
          expect(request).toHaveBeenCalledTimes(1);
          expect(diagnostics.failure).toHaveBeenCalledTimes(1);
          expect(diagnostics.failure).toHaveBeenCalledWith('critical', false, '777000_bot');
          expect(diagnostics.success).not.toHaveBeenCalled();
          expect(diagnostics.warn).toHaveBeenCalledWith(
            {
              statusCode: 404,
              errorCode: 'not.found',
              limitScope: null,
              trafficClass: 'critical',
              lane: 'critical',
              sourceTag: MAX_API_SOURCE_TAGS.MODERATION_SANCTION,
              botId: '777000_bot',
              failureOrigin: 'unlinked',
              isCritical: false,
              requestAssociation: 'linked',
              method,
              endpointKind,
              phase: 'adapter_rejection',
              receivedStatusCode: null,
            },
            ACTION_FAILURE_WARNING,
          );
          const admissionCalls = diagnostics.quota.mock.calls
            .map(([script]) => String(script))
            .filter((script) => /MAX_API_(?:CIRCUIT|GCRA)_/u.test(script));
          expect(admissionCalls).toHaveLength(2);
          expect(admissionCalls[0]).toContain('MAX_API_CIRCUIT_ACQUIRE_V1');
          expect(admissionCalls[1]).toContain('MAX_API_GCRA_RESERVE_V1');
          expect(diagnostics.quota.mock.invocationCallOrder[1]).toBeLessThan(
            request.mock.invocationCallOrder[0]!,
          );
          expect(request.mock.invocationCallOrder[0]).toBeLessThan(
            diagnostics.failure.mock.invocationCallOrder[0]!,
          );
          expect(JSON.stringify(diagnostics.warn.mock.calls)).not.toMatch(
            /private-(?:user|chat|token|body|message|member-job)|private\.example/,
          );
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it.each(['synchronous', 'observable'] as const)(
      'preserves a public message-delete timeout from a %s adapter failure',
      async (mode) => {
        const error = Object.freeze(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }));
        const request = jest.fn(() => {
          if (mode === 'synchronous') throw error;
          return throwError(() => error);
        });
        const service = createService({ request });
        const diagnostics = observeActionFailureDiagnostics(service);
        try {
          await expect(executeSelectedPath(service, 'message_delete')).rejects.toBe(error);
          expect(request).toHaveBeenCalledTimes(1);
          expect(diagnostics.failure).toHaveBeenCalledTimes(1);
          expect(diagnostics.failure).toHaveBeenCalledWith('critical', true, '777000_bot');
          expect(diagnostics.success).not.toHaveBeenCalled();
          expect(diagnostics.warn).toHaveBeenCalledWith(
            expect.objectContaining({
              statusCode: null,
              errorCode: 'econnaborted',
              isCritical: true,
              requestAssociation: 'linked',
              method: 'delete',
              endpointKind: 'messages',
              phase: 'adapter_rejection',
              receivedStatusCode: null,
            }),
            ACTION_FAILURE_WARNING,
          );
          expect(
            diagnostics.quota.mock.calls.filter(([script]) =>
              String(script).includes('MAX_API_CIRCUIT_FAILURE_V1'),
            ),
          ).toHaveLength(1);
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it('retains external429 cooldown before circuit bookkeeping while keeping received HTTP status unknown', async () => {
      const error = Object.assign(new Error('limited'), {
        response: { status: 429, data: { code: 'rate.limit' } },
      });
      const request = jest.fn().mockReturnValue(throwError(() => error));
      const service = createService({ request });
      const diagnostics = observeActionFailureDiagnostics(service);
      try {
        await expect(executeSelectedPath(service, 'targeted_get')).rejects.toBe(error);
        expect(request).toHaveBeenCalledTimes(1);
        expect(diagnostics.failure).toHaveBeenCalledTimes(1);
        expect(diagnostics.failure).toHaveBeenCalledWith('critical', true, '777000_bot');
        expect(diagnostics.success).not.toHaveBeenCalled();
        const events = diagnostics.quota.mock.calls.flatMap(([script], index) => {
          const name = String(script).match(
            /MAX_API_(?:CIRCUIT_ACQUIRE|GCRA_RESERVE|CIRCUIT_FAILURE|EXTERNAL_COOLDOWN)_V1/u,
          )?.[0];
          return name ? [{ name, order: diagnostics.quota.mock.invocationCallOrder[index]! }] : [];
        });
        expect(events.map(({ name }) => name)).toEqual([
          'MAX_API_CIRCUIT_ACQUIRE_V1',
          'MAX_API_GCRA_RESERVE_V1',
          'MAX_API_EXTERNAL_COOLDOWN_V1',
          'MAX_API_CIRCUIT_FAILURE_V1',
        ]);
        expect(events[1]!.order).toBeLessThan(request.mock.invocationCallOrder[0]!);
        expect(request.mock.invocationCallOrder[0]).toBeLessThan(
          diagnostics.failure.mock.invocationCallOrder[0]!,
        );
        expect(diagnostics.failure.mock.invocationCallOrder[0]).toBeLessThan(events[2]!.order);
        expect(diagnostics.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            statusCode: 429,
            requestAssociation: 'linked',
            method: 'get',
            endpointKind: 'chat_members',
            phase: 'adapter_rejection',
            receivedStatusCode: null,
          }),
          ACTION_FAILURE_WARNING,
        );
      } finally {
        await service.onModuleDestroy();
      }
    });

    it.each([
      { status: 202, receivedStatusCode: 202 },
      { status: undefined, receivedStatusCode: null },
      { status: Number.NaN, receivedStatusCode: null },
      { status: Number.POSITIVE_INFINITY, receivedStatusCode: null },
    ])(
      'keeps resolved status $status distinct from synthetic rejection status',
      async ({ status, receivedStatusCode }) => {
        const request = jest.fn().mockReturnValue(of({ status, data: {} }));
        const service = createService({ request });
        const diagnostics = observeActionFailureDiagnostics(service);
        try {
          const failure: unknown = await executeSelectedPath(service, 'message_delete').catch(
            (error: unknown) => error,
          );
          expect(failure).toBeInstanceOf(MaxApiRequestRejectedError);
          expect(failure).toMatchObject({ response: { status: 200, data: {} } });
          expect(request).toHaveBeenCalledTimes(1);
          expect(diagnostics.failure).toHaveBeenCalledTimes(1);
          expect(diagnostics.failure).toHaveBeenCalledWith('critical', false, '777000_bot');
          expect(diagnostics.success).not.toHaveBeenCalled();
          expect(diagnostics.warn).toHaveBeenCalledWith(
            expect.objectContaining({
              statusCode: 200,
              requestAssociation: 'linked',
              method: 'delete',
              endpointKind: 'messages',
              phase: 'domain_validation',
              receivedStatusCode,
            }),
            ACTION_FAILURE_WARNING,
          );
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it.each(['message_delete', 'member_delete'] as const)(
      'keeps generic response rejection separate from domain validation for $0',
      async (path) => {
        const payload = { success: false, code: 'request.rejected', message: 'rejected' };
        const request = jest.fn().mockReturnValue(of({ status: 202, data: payload }));
        const service = createService({ request });
        const diagnostics = observeActionFailureDiagnostics(service);
        try {
          const failure: unknown = await executeSelectedPath(service, path).catch(
            (error: unknown) => error,
          );
          expect(failure).toBeInstanceOf(MaxApiRequestRejectedError);
          expect(failure).toMatchObject({ response: { status: 202, data: payload } });
          expect(request).toHaveBeenCalledTimes(1);
          expect(diagnostics.failure).toHaveBeenCalledTimes(1);
          expect(diagnostics.failure).toHaveBeenCalledWith('critical', false, '777000_bot');
          expect(diagnostics.success).not.toHaveBeenCalled();
          expect(diagnostics.warn).toHaveBeenCalledWith(
            expect.objectContaining({
              statusCode: 202,
              requestAssociation: 'linked',
              method: 'delete',
              endpointKind: path === 'message_delete' ? 'messages' : 'chat_members',
              phase: 'response_rejection',
              receivedStatusCode: 202,
            }),
            ACTION_FAILURE_WARNING,
          );
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it('keeps failed member mutation evidence and its original unrecoverable domain error', async () => {
      const request = jest
        .fn()
        .mockReturnValue(
          of({ status: 200, data: { success: true, failed_user_ids: ['private-user'] } }),
        );
      const service = createService({ request });
      const diagnostics = observeActionFailureDiagnostics(service);
      try {
        const failure: unknown = await executeMemberJob(service).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(UnrecoverableError);
        expect(failure).toMatchObject({
          message:
            'Ambiguous MAX KICK_MEMBER transport failure for chat private-chat user private-user: ambiguous max member mutation response: expected success=true',
        });
        expect(wasMaxMemberMutationAttempted(failure)).toBe(true);
        expect(request).toHaveBeenCalledTimes(1);
        expect(diagnostics.failure).toHaveBeenCalledTimes(1);
        expect(diagnostics.failure).toHaveBeenCalledWith('critical', true, '777000_bot');
        expect(diagnostics.success).not.toHaveBeenCalled();
        expect(diagnostics.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            isCritical: true,
            requestAssociation: 'linked',
            method: 'delete',
            endpointKind: 'chat_members',
            phase: 'domain_validation',
            receivedStatusCode: 200,
          }),
          ACTION_FAILURE_WARNING,
        );
      } finally {
        await service.onModuleDestroy();
      }
    });

    it.each([undefined, Number.NaN, 200])(
      'preserves successful undefined message-delete results with resolved status %s',
      async (status) => {
        const request = jest.fn().mockReturnValue(of({ status, data: { success: true } }));
        const service = createService({ request });
        const diagnostics = observeActionFailureDiagnostics(service);
        try {
          await expect(executeSelectedPath(service, 'message_delete')).resolves.toBeUndefined();
          expect(request).toHaveBeenCalledTimes(1);
          expect(diagnostics.success).toHaveBeenCalledTimes(1);
          expect(diagnostics.success).toHaveBeenCalledWith('critical', '777000_bot');
          expect(diagnostics.failure).not.toHaveBeenCalled();
          expect(diagnostics.warn).not.toHaveBeenCalled();
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it('gives each targeted chunk its own outcome and does not count a prior success twice', async () => {
      const userIds = Array.from({ length: 101 }, (_, index) => `private-user-${index}`);
      const error = Object.freeze(
        Object.assign(new Error('second chunk unavailable'), {
          response: { status: 503, data: { code: 'service.unavailable' } },
        }),
      );
      const request = jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              members: userIds.slice(0, 100).map((userId) => ({ user_id: userId, role: 'member' })),
            },
          }),
        )
        .mockReturnValueOnce(throwError(() => error));
      const service = createService({ request });
      const diagnostics = observeActionFailureDiagnostics(service);
      try {
        await expect(
          service.getChatMembersAccess('private-chat', userIds, {
            ...requestOptions,
            bypassCache: true,
          }),
        ).rejects.toBe(error);
        expect(request).toHaveBeenCalledTimes(2);
        expect(request).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            method: 'get',
            url: 'https://platform-api2.max.ru/chats/private-chat/members?user_ids=private-user-100',
          }),
        );
        expect(diagnostics.success).toHaveBeenCalledTimes(1);
        expect(diagnostics.success).toHaveBeenCalledWith('critical', '777000_bot');
        expect(diagnostics.failure).toHaveBeenCalledTimes(1);
        expect(diagnostics.failure).toHaveBeenCalledWith('critical', true, '777000_bot');
        expect(diagnostics.warn).toHaveBeenCalledWith(
          expect.objectContaining({
            requestAssociation: 'linked',
            method: 'get',
            endpointKind: 'chat_members',
            phase: 'adapter_rejection',
            receivedStatusCode: null,
          }),
          ACTION_FAILURE_WARNING,
        );
      } finally {
        await service.onModuleDestroy();
      }
    });

    it('keeps targeted cache and in-flight followers outside HTTP success accounting', async () => {
      let finishRequest: (value: {
        status: number;
        data: { members: { user_id: string; role: string }[] };
      }) => void = () => undefined;
      const response = new Promise<{
        status: number;
        data: { members: { user_id: string; role: string }[] };
      }>((resolve) => {
        finishRequest = resolve;
      });
      let markRequestStarted: () => void = () => undefined;
      const requestStarted = new Promise<void>((resolve) => {
        markRequestStarted = resolve;
      });
      const request = jest.fn(() => {
        markRequestStarted();
        return from(response);
      });
      const service = createService({ request });
      const diagnostics = observeActionFailureDiagnostics(service);
      try {
        const first = service.getChatMembersAccess(
          'private-chat',
          ['private-user'],
          requestOptions,
        );
        const follower = service.getChatMembersAccess(
          'private-chat',
          ['private-user'],
          requestOptions,
        );
        await requestStarted;
        finishRequest({
          status: 200,
          data: { members: [{ user_id: 'private-user', role: 'member' }] },
        });
        const [firstResult, followerResult] = await Promise.all([first, follower]);
        const cachedResult = await service.getChatMembersAccess(
          'private-chat',
          ['private-user'],
          requestOptions,
        );
        expect([...firstResult.keys()]).toEqual(['private-user']);
        expect(followerResult).toEqual(firstResult);
        expect(cachedResult).toEqual(firstResult);
        expect(request).toHaveBeenCalledTimes(1);
        expect(diagnostics.success).toHaveBeenCalledTimes(1);
        expect(diagnostics.success).toHaveBeenCalledWith('critical', '777000_bot');
        expect(diagnostics.failure).not.toHaveBeenCalled();
        expect(diagnostics.warn).not.toHaveBeenCalled();
      } finally {
        await service.onModuleDestroy();
      }
    });

    it('does not carry a linked frozen error into a later unsupported public request', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-18T20:00:00.000Z'));
      const error = Object.freeze(
        Object.assign(new Error('same failure object'), {
          response: { status: 404, data: { code: 'not.found' } },
        }),
      );
      const request = jest.fn().mockReturnValue(throwError(() => error));
      const service = createService({ request });
      const diagnostics = observeActionFailureDiagnostics(service);
      try {
        await expect(executeSelectedPath(service, 'targeted_get')).rejects.toBe(error);
        jest.advanceTimersByTime(30_000);
        await expect(
          service.getChatTitle('private-chat', {
            ...requestOptions,
            bypassCache: true,
          }),
        ).rejects.toBe(error);
        expect(request).toHaveBeenCalledTimes(2);
        expect(diagnostics.failure).toHaveBeenCalledTimes(2);
        expect(diagnostics.success).not.toHaveBeenCalled();
        expect(diagnostics.warn).toHaveBeenNthCalledWith(
          1,
          expect.objectContaining({
            requestAssociation: 'linked',
            method: 'get',
            endpointKind: 'chat_members',
            phase: 'adapter_rejection',
            receivedStatusCode: null,
          }),
          ACTION_FAILURE_WARNING,
        );
        expect(diagnostics.warn).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            totalFailures: 1,
            groups: [
              expect.objectContaining({
                count: 1,
                requestAssociation: 'linked',
                endpointKind: 'chat_members',
              }),
            ],
          }),
          'MAX action failure window summary',
        );
        expect(diagnostics.warn).toHaveBeenNthCalledWith(
          3,
          {
            statusCode: 404,
            errorCode: 'not.found',
            limitScope: null,
            trafficClass: 'critical',
            lane: 'critical',
            sourceTag: MAX_API_SOURCE_TAGS.MODERATION_SANCTION,
            botId: '777000_bot',
            failureOrigin: 'unlinked',
            isCritical: false,
            requestAssociation: 'unlinked',
            method: 'unknown',
            endpointKind: 'unknown',
          },
          ACTION_FAILURE_WARNING,
        );
      } finally {
        await service.onModuleDestroy();
      }
    });

    it('keeps malformed targeted200 parsing after wrapper success without a new HTTP failure', async () => {
      const request = jest.fn().mockReturnValue(of({ status: 200, data: { success: false } }));
      const service = createService({ request });
      const diagnostics = observeActionFailureDiagnostics(service);
      try {
        await expect(executeSelectedPath(service, 'targeted_get')).rejects.toThrow(
          'Invalid MAX chat members response',
        );
        expect(request).toHaveBeenCalledTimes(1);
        expect(diagnostics.success).toHaveBeenCalledTimes(1);
        expect(diagnostics.success).toHaveBeenCalledWith('critical', '777000_bot');
        expect(diagnostics.failure).not.toHaveBeenCalled();
        expect(diagnostics.warn).not.toHaveBeenCalled();
      } finally {
        await service.onModuleDestroy();
      }
    });

    it.each(
      (['message_delete', 'message_send'] as const).flatMap((path) =>
        [403, 404].map((status) => ({ path, status })),
      ),
    )(
      'attributes a nested final-guard GET$status only to GET before $path',
      async ({ path, status }) => {
        const error = Object.assign(new Error('guard membership unavailable'), {
          response: { status, data: { code: status === 403 ? 'chat.denied' : 'not.found' } },
        });
        const request = jest.fn().mockReturnValue(throwError(() => error));
        const service = createService({ request });
        const diagnostics = observeActionFailureDiagnostics(service);
        const guard = jest.fn(async () => {
          await service.getChatMembersAccess('private-chat', ['private-user'], {
            ...requestOptions,
            bypassCache: true,
          });
        });
        try {
          const operation =
            path === 'message_delete'
              ? service.deleteMessage('private-chat', 'private-message', {
                  ...requestOptions,
                  immediate: true,
                  beforeImmediateDeleteMutation: guard,
                })
              : service.sendMessageImmediateWithId(
                  'private-chat',
                  'guarded notice',
                  { beforeSend: guard },
                  requestOptions,
                );
          await expect(operation).rejects.toBe(error);
          expect(wasMaxPreDispatchGuardRejected(error)).toBe(true);
          expect(guard).toHaveBeenCalledTimes(1);
          expect(request).toHaveBeenCalledTimes(1);
          expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: 'get' }));
          expect(diagnostics.failure).toHaveBeenCalledTimes(1);
          expect(diagnostics.failure).toHaveBeenCalledWith('critical', false, '777000_bot');
          expect(diagnostics.success).not.toHaveBeenCalled();
          expect(diagnostics.warn).toHaveBeenCalledTimes(1);
          expect(diagnostics.warn).toHaveBeenCalledWith(
            expect.objectContaining({
              requestAssociation: 'linked',
              method: 'get',
              endpointKind: 'chat_members',
              phase: 'adapter_rejection',
              receivedStatusCode: null,
            }),
            ACTION_FAILURE_WARNING,
          );
          expect(
            diagnostics.quota.mock.calls.filter(([script]) =>
              String(script).includes('MAX_API_CIRCUIT_ACQUIRE_V1'),
            ),
          ).toHaveLength(2);
        } finally {
          await service.onModuleDestroy();
        }
      },
    );
  });

  it('2A0 identifies an initial critical quota refusal without HTTP or retry changes', async () => {
    const request = jest.fn();
    const service = createService({ request }, { MAX_API_RATE_LIMIT_WAIT_MS_CRITICAL: '0' });
    const diagnostics = observeActionFailureDiagnostics(service);
    diagnostics.quota.mockResolvedValueOnce([1, 0, 0]).mockResolvedValueOnce([0, 2, 1234]);
    try {
      await expect(
        service.getChatSnapshot('private-chat', {
          bypassCache: true,
          trafficClass: 'critical',
          actionHealthLane: 'interactive',
        }),
      ).rejects.toMatchObject({
        code: 'MAX_API_INTERNAL_RATE_LIMIT',
        preDispatch: true,
        retryAfterMs: 1234,
      });
      expect(request).not.toHaveBeenCalled();
      expect(diagnostics.failure).toHaveBeenCalledTimes(1);
      expect(diagnostics.failure).toHaveBeenCalledWith('interactive', true, '777000_bot');
      expect(diagnostics.success).not.toHaveBeenCalled();
      expect(
        diagnostics.warn.mock.calls.filter(([, message]) => message === ACTION_FAILURE_WARNING),
      ).toEqual([
        [
          expect.objectContaining({
            failureOrigin: 'local_quota',
            isCritical: true,
            requestAssociation: 'unlinked',
            method: 'unknown',
            endpointKind: 'unknown',
          }),
          ACTION_FAILURE_WARNING,
        ],
      ]);
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('does not log action failure diagnostics for background traffic or lanes', async () => {
    const backgroundTrafficError = Object.assign(new Error('background failed'), {
      response: { status: 503, data: { code: 'service.unavailable' } },
    });
    const backgroundLaneError = Object.assign(new Error('background lane denied'), {
      response: { status: 403, data: { code: 'chat.denied' } },
    });
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(throwError(() => backgroundTrafficError))
        .mockReturnValueOnce(throwError(() => backgroundLaneError)),
    };
    const service = createService(httpService);
    const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    const actionHealthService = (
      service as unknown as {
        actionHealthService: {
          recordFailureForLane: jest.Mock;
        };
      }
    ).actionHealthService;

    await expect(
      service.getChatSnapshot('chat-background-traffic', {
        bypassCache: true,
        trafficClass: 'background',
        actionHealthLane: 'interactive',
        sourceTag: 'managed_refresh',
      }),
    ).rejects.toBe(backgroundTrafficError);
    await expect(
      service.getChatSnapshot('chat-background-lane', {
        bypassCache: true,
        trafficClass: 'critical',
        actionHealthLane: 'background',
        sourceTag: 'managed_refresh',
      }),
    ).rejects.toBe(backgroundLaneError);

    expect(actionHealthService.recordFailureForLane).toHaveBeenNthCalledWith(
      1,
      'interactive',
      true,
      '777000_bot',
    );
    expect(actionHealthService.recordFailureForLane).toHaveBeenNthCalledWith(
      2,
      'background',
      false,
      '777000_bot',
    );
    expect(warnSpy).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('refuses direct send mutations with explicit non-executable or unknown bot ids', async () => {
    const httpService = { request: jest.fn() };
    const service = createService(httpService);
    const botRegistry = (service as any).botRegistry;
    const defaultBot = botRegistry.getDefaultBot();
    botRegistry.getBotById.mockImplementation((botId?: string | null) => {
      if (!botId || botId === defaultBot.id) {
        return defaultBot;
      }
      if (botId === 'draining-bot') {
        return {
          ...defaultBot,
          id: 'draining-bot',
          token: 'draining-token',
          state: 'draining',
        };
      }
      return null;
    });

    await expect(
      service.sendMessageImmediateWithId('chat-1', 'hello', undefined, {
        botId: 'draining-bot',
      }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    await expect(
      service.sendMessageImmediateWithId('chat-1', 'hello', undefined, {
        botId: 'removed-bot',
      }),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('publishes custom attachment-only message and resolves post link', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              mid: 'mid-custom-1',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              messages: [
                {
                  body: { mid: 'mid-custom-1' },
                  message_url: 'https://max.ru/chats/chat-1/message/custom-1',
                },
              ],
            },
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.sendCustomMessageImmediateWithResolvedLink('chat-1', {
      attachments: [
        {
          type: 'image',
          payload: { token: 'upload-token-1' },
        },
      ],
    });

    expect(result).toEqual({
      messageId: 'mid-custom-1',
      url: 'https://max.ru/chats/chat-1/message/custom-1',
    });
    expect(httpService.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        params: { chat_id: 'chat-1' },
        data: {
          text: null,
          attachments: [
            {
              type: 'image',
              payload: { token: 'upload-token-1' },
            },
          ],
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('normalizes raw custom inline keyboard attachments before sending', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            mid: 'mid-custom-buttons-1',
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.sendCustomMessageImmediate('chat-1', {
      text: 'Проверьте кнопки',
      attachments: [
        {
          type: 'inline_keyboard',
          payload: {
            buttons: [
              [
                {
                  type: '',
                  text: 'Связь с администратором',
                  url: 'https://example.com/admin',
                },
                {
                  type: 'link',
                  text: 'Проверить обязательную подписку',
                  url: 'https://example.com/subscription',
                },
              ],
            ],
          },
        },
      ],
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        params: { chat_id: 'chat-1' },
        data: {
          text: 'Проверьте кнопки',
          attachments: [
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [
                    {
                      type: 'link',
                      text: 'Связь с администратором',
                      url: 'https://example.com/admin',
                    },
                  ],
                  [
                    {
                      type: 'link',
                      text: 'Проверить обязательную подписку',
                      url: 'https://example.com/subscription',
                    },
                  ],
                ],
              },
            },
          ],
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('does not fail when MAX omits a direct message url for chat posts', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              mid: 'mid-rules-3',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              messages: [
                {
                  body: { mid: 'mid-rules-3' },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              mid: 'mid-rules-3',
            },
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.sendMessageImmediateWithResolvedLink('chat-1', 'Правила чата');

    expect(result).toEqual({
      messageId: 'mid-rules-3',
      url: null,
    });

    await service.onModuleDestroy();
  });

  it('recovers direct post link via GET /messages/{id} when batch lookup has no url', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              mid: 'mid-rules-4',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              messages: [
                {
                  body: { mid: 'mid-rules-4' },
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              mid: 'mid-rules-4',
              url: 'https://max.ru/chats/chat-1/message/789',
            },
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.sendMessageImmediateWithResolvedLink('chat-1', 'Правила чата');

    expect(result).toEqual({
      messageId: 'mid-rules-4',
      url: 'https://max.ru/chats/chat-1/message/789',
    });
    expect(httpService.request).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages/mid-rules-4',
      }),
    );

    await service.onModuleDestroy();
  });

  it('recovers the correct post link when batch lookup returns a different message id', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              mid: 'mid-rules-4b',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              messages: [
                {
                  body: { mid: 'mid-other-4b' },
                  url: 'https://max.ru/chats/chat-1/message/wrong',
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              mid: 'mid-rules-4b',
              url: 'https://max.ru/chats/chat-1/message/correct',
            },
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.sendMessageImmediateWithResolvedLink('chat-1', 'Правила чата');

    expect(result).toEqual({
      messageId: 'mid-rules-4b',
      url: 'https://max.ru/chats/chat-1/message/correct',
    });
    expect(httpService.request).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages/mid-rules-4b',
      }),
    );

    await service.onModuleDestroy();
  });

  it('builds chat post link from message id tail when MAX omits direct url fields', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              mid: 'mid-rules-5',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              messages: [
                {
                  recipient: {
                    chat_id: -71768670111751,
                    chat_type: 'chat',
                  },
                  body: {
                    mid: 'mid-rules-5',
                    seq: '116200222364336232',
                  },
                },
              ],
            },
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.sendMessageImmediateWithResolvedLink('chat-1', 'Правила чата');

    expect(result).toEqual({
      messageId: 'mid-rules-5',
      url: 'https://max.ru/c/-71768670111751/AZzTfJDZAGg',
    });
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages',
        params: { message_ids: 'mid-rules-5' },
      }),
    );

    await service.onModuleDestroy();
  });

  it('sends reply link payload when message link is provided', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            mid: 'mid-rules-link-1',
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.sendMessage(
      'chat-1',
      'Нарушение',
      {
        textFormat: 'markdown',
        messageLink: {
          type: 'reply',
          mid: 'mid-rules-1',
        },
      },
      { immediate: true },
    );

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        params: { chat_id: 'chat-1' },
        data: {
          text: 'Нарушение',
          format: 'markdown',
          link: {
            type: 'reply',
            mid: 'mid-rules-1',
          },
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('allocates a bounded direct video session without sending any binary data', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValue(
          of({ data: { url: 'https://omub.okcdn.ru/upload', token: 'media-token' } }),
        ),
    };
    const service = createService(httpService);
    await expect(
      service.createVideoUploadSession({ trafficClass: 'interactive' }),
    ).resolves.toEqual({ url: 'https://omub.okcdn.ru/upload', token: 'media-token' });
    expect(httpService.request).toHaveBeenCalledTimes(1);
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'post', params: { type: 'video' } }),
    );
    await service.onModuleDestroy();
  });

  it.each([
    { url: 'http://omub.okcdn.ru/upload', token: 'token' },
    { url: 'https://omub.okcdn.ru.evil.example/upload', token: 'token' },
    { url: 'https://user:password@omub.okcdn.ru/upload', token: 'token' },
    { url: 'https://omub.okcdn.ru/upload', token: '' },
  ])('rejects unsafe or incomplete direct upload sessions', async (data) => {
    const service = createService({ request: jest.fn().mockReturnValue(of({ data })) });
    await expect(service.createVideoUploadSession({})).rejects.toThrow('session is invalid');
    await service.onModuleDestroy();
  });

  it('keeps multipart video upload available through the rollback flag', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              url: 'https://upload.max.ru/video-1',
              token: 'video-upload-token-1',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {},
          }),
        ),
    };
    const service = createService(httpService, {
      MAX_RESUMABLE_VIDEO_UPLOAD_ENABLED: false,
    });

    const result = await service.uploadVideo(
      TINY_VALID_MP4,
      'channel-suggestion-video.mp4',
      'video/mp4',
    );

    expect(result).toEqual({ token: 'video-upload-token-1' });
    expect(httpService.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/uploads',
        params: {
          type: 'video',
        },
      }),
    );
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'post',
        url: 'https://upload.max.ru/video-1',
      }),
    );

    await service.onModuleDestroy();
  });

  it.each([
    ['a plain retval', 'retval'],
    ['an empty response', null],
  ])('uses the video upload-session token when binary upload returns %s', async (_label, data) => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              url: 'https://upload.max.ru/video-session-token',
              token: 'video-session-token',
            },
          }),
        )
        .mockReturnValueOnce(of({ data })),
    };
    const service = createService(httpService, {
      MAX_RESUMABLE_VIDEO_UPLOAD_ENABLED: false,
    });

    await expect(
      service.uploadVideo(TINY_VALID_MP4, 'publication.mp4', 'video/mp4'),
    ).resolves.toEqual({ token: 'video-session-token' });

    await service.onModuleDestroy();
  });

  it('uploads video in bounded Content-Range chunks by default', async () => {
    const chunkBytes = 4 * 1_024 * 1_024;
    const video = createMp4Fixture(chunkBytes + 3, 7);
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              url: 'https://upload.max.ru/video-range-1?signature=secret',
              token: 'video-range-token-1',
            },
          }),
        )
        .mockReturnValueOnce(of({ data: '' }))
        .mockReturnValueOnce(of({ data: '' })),
    };
    const service = createService(httpService);

    const result = await service.uploadVideo(video, '../range-video.mp4', 'video/mp4', {
      timeoutMs: 12_345,
    });

    expect(result).toEqual({ token: 'video-range-token-1' });
    expect(httpService.request).toHaveBeenCalledTimes(3);
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'post',
        url: 'https://upload.max.ru/video-range-1?signature=secret',
        data: expect.any(Buffer),
        headers: expect.objectContaining({
          'Content-Disposition': 'attachment; filename="range-video.mp4"',
          'Content-Length': String(chunkBytes),
          'Content-Range': `bytes 0-${chunkBytes - 1}/${video.length}`,
          'Content-Type': 'application/x-binary; charset=x-user-defined',
          'X-File-Name': 'range-video.mp4',
          'X-Uploading-Mode': 'parallel',
          Connection: 'keep-alive',
        }),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: expect.any(Number),
      }),
    );
    expect(httpService.request.mock.calls[1]?.[0].headers).not.toHaveProperty('Authorization');
    expect((httpService.request.mock.calls[1]?.[0].data as Buffer).length).toBe(chunkBytes);
    expect(httpService.request.mock.calls[1]?.[0].timeout).toBeGreaterThan(0);
    expect(httpService.request.mock.calls[1]?.[0].timeout).toBeLessThanOrEqual(12_345);
    expect(httpService.request).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        url: 'https://upload.max.ru/video-range-1?signature=secret',
        data: expect.any(Buffer),
        headers: expect.objectContaining({
          'Content-Length': '3',
          'Content-Range': `bytes ${chunkBytes}-${chunkBytes + 2}/${video.length}`,
        }),
      }),
    );
    expect((httpService.request.mock.calls[2]?.[0].data as Buffer).length).toBe(3);
    expect(httpService.request.mock.calls[2]?.[0].timeout).toBeGreaterThan(0);
    expect(httpService.request.mock.calls[2]?.[0].timeout).toBeLessThanOrEqual(
      httpService.request.mock.calls[1]?.[0].timeout,
    );

    await service.onModuleDestroy();
  });

  it('rejects empty and oversized videos before creating an upload session', async () => {
    const httpService = { request: jest.fn() };
    const service = createService(httpService);

    await expect(service.uploadVideo(Buffer.alloc(0), 'empty.mp4', 'video/mp4')).rejects.toThrow(
      'MAX video upload payload is empty',
    );
    await expect(
      service.uploadVideo(
        { length: MAX_VIDEO_UPLOAD_MAX_BYTES + 1 } as Buffer,
        'oversized.mp4',
        'video/mp4',
      ),
    ).rejects.toThrow('MAX video upload exceeds the documented 250 MB limit');
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('rejects empty and oversized image or file payloads before creating an upload session', async () => {
    const httpService = { request: jest.fn() };
    const service = createService(httpService);

    await expect(service.uploadImage(Buffer.alloc(0), 'empty.jpg', 'image/jpeg')).rejects.toThrow(
      'MAX image upload payload is empty',
    );
    await expect(
      service.uploadImage(
        { length: MAX_IMAGE_UPLOAD_MAX_BYTES + 1 } as Buffer,
        'oversized.jpg',
        'image/jpeg',
      ),
    ).rejects.toThrow('MAX image upload exceeds the documented 50 MB limit');
    await expect(service.uploadFile(Buffer.alloc(0), 'empty.txt', 'text/plain')).rejects.toThrow(
      'MAX file upload payload is empty',
    );
    await expect(
      service.uploadFile(
        { length: MAX_FILE_UPLOAD_MAX_BYTES + 1 } as Buffer,
        'oversized.bin',
        'application/octet-stream',
      ),
    ).rejects.toThrow('MAX file upload exceeds the documented 4 GB limit');
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('rejects invalid media bytes before bot resolution or upload HTTP', async () => {
    const httpService = { request: jest.fn() };
    const service = createService(httpService);
    const resolveExecutableBot = jest.spyOn(service as any, 'resolveExecutableBot');

    let error: unknown;
    try {
      await service.uploadImage(Buffer.from('not-an-image'), 'spoofed.jpg', 'image/jpeg', {
        botId: 'unknown-bot',
      });
    } catch (caught: unknown) {
      error = caught;
    }

    expect(error).toBeInstanceOf(MaxMediaUploadValidationError);
    expect(error).toMatchObject({
      code: MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD,
      retryable: false,
    });
    expect(resolveExecutableBot).not.toHaveBeenCalled();
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('canonicalizes image MIME and filename from the uploaded bytes', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              url: 'https://upload.max.ru/image-canonical',
              token: 'image-canonical-session-token',
            },
          }),
        )
        .mockReturnValueOnce(of({ data: { token: 'image-canonical-token' } })),
    };
    const service = createService(httpService);

    await expect(service.uploadImage(TINY_JPEG, '../spoofed.png', 'image/png')).resolves.toEqual({
      token: 'image-canonical-token',
    });

    const uploadRequest = httpService.request.mock.calls[1]?.[0] as {
      data?: { getBuffer?: () => Buffer };
    };
    const multipartBody = uploadRequest.data?.getBuffer?.().toString('latin1') ?? '';
    expect(multipartBody).toContain('filename="spoofed.jpg"');
    expect(multipartBody).toContain('Content-Type: image/jpeg');
    expect(multipartBody).not.toContain('filename="spoofed.png"');

    await service.onModuleDestroy();
  });

  it('uses one decreasing timeout budget across upload sessions and range chunks', async () => {
    const chunkBytes = 4 * 1_024 * 1_024;
    const video = createMp4Fixture(chunkBytes + 1, 7);
    let now = 1_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const httpService = {
      request: jest.fn().mockImplementation((request: { url?: string }) => {
        if (request.url === 'https://platform-api2.max.ru/uploads') {
          now += 100;
          return of({
            data: {
              url: 'https://upload.max.ru/video-deadline',
              token: 'video-deadline-token',
            },
          });
        }
        now += 2_500;
        return of({ data: '' });
      }),
    };
    const service = createService(httpService, {
      MAX_RESUMABLE_VIDEO_UPLOAD_ENABLED: true,
    });

    try {
      await expect(
        service.uploadVideo(video, 'deadline.mp4', 'video/mp4', { timeoutMs: 10_000 }),
      ).resolves.toEqual({ token: 'video-deadline-token' });

      expect(httpService.request.mock.calls.map(([request]) => request.timeout)).toEqual([
        10_000, 9_900, 7_400,
      ]);
    } finally {
      nowSpy.mockRestore();
      await service.onModuleDestroy();
    }
  });

  it('recomputes the upload-session request timeout after internal rate-limit waiting', async () => {
    let now = 1_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              url: 'https://upload.max.ru/video-rate-limit-budget',
              token: 'video-rate-limit-token',
            },
          }),
        )
        .mockReturnValueOnce(of({ data: '' })),
    };
    const service = createService(httpService, {
      MAX_RESUMABLE_VIDEO_UPLOAD_ENABLED: true,
    });
    jest.spyOn(service as any, 'reserveRateLimitSlot').mockImplementation(async () => {
      now += 4_000;
    });

    try {
      await expect(
        service.uploadVideo(TINY_VALID_MP4, 'rate-limit.mp4', 'video/mp4', {
          timeoutMs: 10_000,
        }),
      ).resolves.toEqual({ token: 'video-rate-limit-token' });

      expect(httpService.request.mock.calls[0]?.[0].timeout).toBe(6_000);
      expect(httpService.request.mock.calls[1]?.[0].timeout).toBe(6_000);
    } finally {
      nowSpy.mockRestore();
      await service.onModuleDestroy();
    }
  });

  it('does not start a fresh upload session after the overall deadline expires', async () => {
    let now = 1_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    const httpService = {
      request: jest
        .fn()
        .mockImplementationOnce(() => {
          now += 100;
          return of({
            data: {
              url: 'https://upload.max.ru/video-expired',
              token: 'video-expired-token',
            },
          });
        })
        .mockImplementationOnce(() => {
          now = 11_001;
          return throwError(() =>
            Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
          );
        }),
    };
    const service = createService(httpService, {
      MAX_RESUMABLE_VIDEO_UPLOAD_ENABLED: true,
    });

    try {
      await expect(
        service.uploadVideo(TINY_VALID_MP4, 'expired.mp4', 'video/mp4', {
          timeoutMs: 10_000,
        }),
      ).rejects.toMatchObject({ name: 'MaxMediaUploadError' });
      expect(httpService.request).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
      await service.onModuleDestroy();
    }
  });

  it('uses an ASCII-safe filename in resumable video headers', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              url: 'https://upload.max.ru/video-unicode',
              token: 'video-unicode-token',
            },
          }),
        )
        .mockReturnValueOnce(of({ data: '' })),
    };
    const service = createService(httpService, {
      MAX_RESUMABLE_VIDEO_UPLOAD_ENABLED: true,
    });

    await service.uploadVideo(TINY_VALID_MP4, 'видео.mp4', 'video/mp4');

    expect(httpService.request.mock.calls[1]?.[0].headers).toEqual(
      expect.objectContaining({
        'Content-Disposition': 'attachment; filename="upload.mp4"',
        'X-File-Name': 'upload.mp4',
      }),
    );
    await service.onModuleDestroy();
  });

  it('uses multipart fallback when a resumable video session has no token', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              url: 'https://upload.max.ru/video-multipart-fallback',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              token: 'video-multipart-token-1',
            },
          }),
        ),
    };
    const service = createService(httpService, {
      MAX_RESUMABLE_VIDEO_UPLOAD_ENABLED: true,
    });

    const result = await service.uploadVideo(TINY_VALID_MP4, 'видео.mp4', 'video/mp4');

    expect(result).toEqual({ token: 'video-multipart-token-1' });
    const uploadRequest = httpService.request.mock.calls[1]?.[0] as {
      data?: { getBuffer?: () => Buffer };
      headers?: Record<string, unknown>;
    };
    expect(uploadRequest.data?.getBuffer).toEqual(expect.any(Function));
    expect(uploadRequest.headers?.['content-type']).toMatch(/^multipart\/form-data; boundary=/u);
    expect(uploadRequest.headers).not.toHaveProperty('Content-Range');
    expect(uploadRequest.data?.getBuffer?.().toString('utf8')).toContain('filename="видео.mp4"');

    await service.onModuleDestroy();
  });

  it('starts a fresh resumable video session after an ambiguous chunk failure', async () => {
    const firstUploadUrl = 'https://upload.max.ru/video-range-first?signature=do-not-log';
    const secondUploadUrl = 'https://upload.max.ru/video-range-second?signature=do-not-log-either';
    const ambiguousError = Object.assign(new Error(`socket hang up for ${firstUploadUrl}`), {
      code: 'ECONNRESET',
    });
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({ data: { url: firstUploadUrl, token: 'video-range-token-first' } }),
        )
        .mockReturnValueOnce(throwError(() => ambiguousError))
        .mockReturnValueOnce(
          of({ data: { url: secondUploadUrl, token: 'video-range-token-second' } }),
        )
        .mockReturnValueOnce(of({ data: '' })),
    };
    const service = createService(httpService, {
      MAX_RESUMABLE_VIDEO_UPLOAD_ENABLED: true,
    });

    const result = await service.uploadVideo(TINY_VALID_MP4, 'retry-video.mp4', 'video/mp4');

    expect(result).toEqual({ token: 'video-range-token-second' });
    expect(httpService.request).toHaveBeenCalledTimes(4);
    expect(httpService.request.mock.calls[1]?.[0].url).toBe(firstUploadUrl);
    expect(httpService.request.mock.calls[3]?.[0].url).toBe(secondUploadUrl);

    await service.onModuleDestroy();
  });

  it('redacts resumable video upload URLs from terminal transport errors', async () => {
    const firstUploadUrl = 'https://upload.max.ru/video-range-first?signature=first-secret';
    const secondUploadUrl = 'https://upload.max.ru/video-range-second?signature=second-secret';
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({ data: { url: firstUploadUrl, token: 'video-range-token-first' } }),
        )
        .mockReturnValueOnce(
          throwError(() =>
            Object.assign(new Error(`timeout while posting ${firstUploadUrl}`), {
              code: 'ETIMEDOUT',
            }),
          ),
        )
        .mockReturnValueOnce(
          of({ data: { url: secondUploadUrl, token: 'video-range-token-second' } }),
        )
        .mockReturnValueOnce(
          throwError(() =>
            Object.assign(new Error(`timeout while posting ${secondUploadUrl}`), {
              code: 'ETIMEDOUT',
            }),
          ),
        ),
    };
    const service = createService(httpService, {
      MAX_RESUMABLE_VIDEO_UPLOAD_ENABLED: true,
    });

    let uploadError: unknown;
    try {
      await service.uploadVideo(TINY_VALID_MP4, 'failed-video.mp4', 'video/mp4');
    } catch (error: unknown) {
      uploadError = error;
    }

    expect(uploadError).toBeInstanceOf(Error);
    expect((uploadError as Error).name).toBe('MaxMediaUploadError');
    expect((uploadError as Error).message).toContain('ambiguous transport timeout');
    expect((uploadError as Error).message).not.toContain(firstUploadUrl);
    expect((uploadError as Error).message).not.toContain(secondUploadUrl);

    await service.onModuleDestroy();
  });

  it('sanitizes multipart upload filenames before passing them to form-data', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              url: 'https://upload.max.ru/image-1',
              token: 'image-upload-token-1',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              token: 'image-binary-token-1',
            },
          }),
        ),
    };
    const service = createService(httpService);

    await service.uploadImage(
      TINY_JPEG,
      '../evil\r\nContent-Disposition: form-data; name="x".jpg',
      'image/jpeg',
    );

    const uploadRequest = httpService.request.mock.calls[1]?.[0] as {
      data?: { getBuffer?: () => Buffer };
    };
    const multipartBody = uploadRequest.data?.getBuffer?.().toString('utf8') ?? '';

    expect(multipartBody).toContain('filename="evil_Content-Disposition_ form-data_ name_x_.jpg"');
    expect(multipartBody).not.toContain('filename="../evil');
    expect(multipartBody).not.toContain('\r\nContent-Disposition: form-data; name="x"');

    await service.onModuleDestroy();
  });

  it('keeps bot auth on /uploads but omits it from the returned multipart upload URL', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              url: 'https://upload.max.ru/image-1',
              token: 'image-upload-token-1',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              token: 'image-binary-token-1',
            },
          }),
        ),
    };
    const service = createService(httpService);
    const defaultBot = (service as any).botRegistry.getDefaultBot();
    (service as any).botRegistry.getBotById.mockImplementation((botId?: string | null) => {
      if (botId === '888000_bot') {
        return {
          ...defaultBot,
          id: '888000_bot',
          token: 'selected-bot-token',
          webhookSecretPath: 'selected-secret-path',
        };
      }
      return !botId || botId === defaultBot.id ? defaultBot : null;
    });

    const result = await service.uploadImage(TINY_JPEG, 'private-control-image.jpg', 'image/jpeg', {
      botId: '888000_bot',
    });

    expect(result).toEqual({ token: 'image-binary-token-1' });
    expect(httpService.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/uploads',
        headers: expect.objectContaining({
          Authorization: 'selected-bot-token',
        }),
      }),
    );
    const uploadRequest = httpService.request.mock.calls[1]?.[0] as {
      method?: string;
      url?: string;
      headers?: Record<string, unknown>;
    };
    expect(uploadRequest).toEqual(
      expect.objectContaining({
        method: 'post',
        url: 'https://upload.max.ru/image-1',
      }),
    );
    expect(uploadRequest.headers).not.toHaveProperty('Authorization');

    await service.onModuleDestroy();
  });

  it('sends generic media attachments together with inline keyboard', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            mid: 'mid-video-1',
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.sendMessage(
      'chat-1',
      'Видео предложки',
      {
        textFormat: 'markdown',
        attachments: [{ type: 'video', payload: { token: 'video-upload-token-1' } }],
        buttons: [[{ type: 'callback', text: '✅ Подтвердить', payload: 'review|publish' }]],
      },
      { immediate: true },
    );

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/messages',
        params: { chat_id: 'chat-1' },
        data: {
          text: 'Видео предложки',
          format: 'markdown',
          attachments: [
            {
              type: 'video',
              payload: { token: 'video-upload-token-1' },
            },
            {
              type: 'inline_keyboard',
              payload: {
                buttons: [
                  [{ type: 'callback', text: '✅ Подтвердить', payload: 'review|publish' }],
                ],
              },
            },
          ],
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('pins a message in chat without system notify when requested', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            success: true,
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.pinMessage('chat-1', 'mid-rules-3', false);

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'put',
        url: 'https://platform-api2.max.ru/chats/chat-1/pin',
        data: {
          message_id: 'mid-rules-3',
          notify: false,
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it.each([
    { data: {}, expected: null },
    { data: { message: null }, expected: null },
    {
      data: { message: { body: { mid: 'm1' }, recipient: { chat_id: -1 } } },
      expected: 'm1',
    },
  ])('reads documented pin response $data', async ({ data, expected }) => {
    const httpService = {
      request: jest.fn(() => of({ data })),
    };
    const service = createService(httpService);
    try {
      await expect(
        service.getPinnedMessageId('-1', { trafficClass: 'background', timeoutMs: 4_000 }),
      ).resolves.toBe(expected);
      expect(httpService.request).toHaveBeenCalledTimes(1);
      expect(httpService.request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'get',
          url: 'https://platform-api2.max.ru/chats/-1/pin',
          timeout: 4_000,
        }),
      );
    } finally {
      await service.onModuleDestroy();
    }
  });

  it.each(
    [
      null,
      [],
      '',
      { success: true },
      { message: {} },
      { message: [] },
      { message: { body: { mid: '' }, recipient: { chat_id: -1 } } },
      { message: { body: { mid: 'm1' } } },
      { message: { body: { mid: 'm1' }, recipient: { chat_id: -2 } } },
    ].map((data) => ({ data })),
  )('rejects unverifiable pin response $data', async ({ data }) => {
    const service = createService({ request: jest.fn(() => of({ data })) });
    try {
      await expect(
        service.getPinnedMessageId('-1', { trafficClass: 'background' }),
      ).rejects.toThrow();
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('pins with explicit notification and executes the durable fence before HTTP', async () => {
    const beforeMutation = jest.fn().mockResolvedValue(undefined);
    const httpService = {
      request: jest.fn(() => {
        expect(beforeMutation).toHaveBeenCalledTimes(1);
        return of({ data: { success: true } });
      }),
    };
    const service = createService(httpService);
    await service.pinMessage('chat-1', 'mid-1', true, {
      botId: '777000_bot',
      trafficClass: 'background',
      timeoutMs: 10_000,
      beforeMutation,
    });
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'put',
        timeout: 10_000,
        data: { message_id: 'mid-1', notify: true },
        headers: expect.objectContaining({ Authorization: 'test-token' }),
      }),
    );
    await service.onModuleDestroy();
  });

  it('does not send a pin after its pre-dispatch fence rejects', async () => {
    const httpService = { request: jest.fn() };
    const service = createService(httpService);
    await expect(
      service.pinMessage('chat-1', 'mid-1', true, {
        beforeMutation: async () => {
          throw new Error('lease lost');
        },
      }),
    ).rejects.toThrow('lease lost');
    expect(httpService.request).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it.each([{}, null, { success: false }])(
    'does not accept an unconfirmed pin response %j',
    async (data) => {
      const service = createService({ request: jest.fn(() => of({ data })) });
      await expect(service.pinMessage('chat-1', 'mid-1', true)).rejects.toThrow();
      await service.onModuleDestroy();
    },
  );

  it('sends MAX message history boundaries as Unix milliseconds', async () => {
    const from = new Date('2026-03-06T00:00:00.123Z');
    const to = '2026-03-07T12:00:00.456Z';
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            messages: [],
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.listMessages('chat-1', {
      count: 1,
      from,
      to,
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages',
        params: {
          chat_id: 'chat-1',
          count: 1,
          from: from.getTime(),
          to: Date.parse(to),
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('parses official message snapshots, preserves missing views, and deduplicates pages', async () => {
    const latestTs = Date.parse('2026-03-07T09:00:00.000Z');
    const previousTs = Date.parse('2026-03-06T09:00:00.000Z');
    const rangeFromTs = Date.parse('2026-03-06T00:00:00.000Z');
    const rangeToTs = Date.parse('2026-03-07T12:00:00.000Z');
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              messages: [
                {
                  timestamp: latestTs,
                  body: {
                    mid: 'mid-2',
                    attachments: [
                      {
                        type: 'image',
                        payload: {
                          photos: {
                            128: 'https://cdn.max.ru/news/post-2-small.jpg',
                            1024: 'https://cdn.max.ru/news/post-2.jpg',
                          },
                        },
                      },
                    ],
                  },
                  stat: {
                    views: 260,
                    reactions: [
                      { emoji: '🔥', count: 5 },
                      { emoji: '❤️', count: 3 },
                    ],
                  },
                  url: 'https://max.ru/news/post-2',
                },
                {
                  timestamp: previousTs,
                  body: { mid: 'mid-1' },
                  stat: { reactions: { count: 12 } },
                  url: 'https://max.ru/news/post-1',
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              messages: [
                {
                  timestamp: previousTs,
                  body: { mid: 'mid-1' },
                  url: 'https://max.ru/news/post-1',
                },
              ],
            },
          }),
        ),
    };
    const service = createService(httpService);
    const botRegistry = (service as any).botRegistry;
    const defaultBot = botRegistry.getDefaultBot();
    botRegistry.getBotById.mockImplementation((botId?: string | null) =>
      botId === 'stats-bot'
        ? { ...defaultBot, id: 'stats-bot', token: 'stats-token' }
        : !botId || botId === defaultBot.id
          ? defaultBot
          : null,
    );

    const result = await service.listMessageSnapshots('channel-1', {
      from: '2026-03-06T00:00:00.000Z',
      to: '2026-03-07T12:00:00.000Z',
      count: 2,
      maxPages: 3,
      botId: 'stats-bot',
    });

    expect(result).toEqual([
      {
        chatId: 'channel-1',
        messageId: 'mid-2',
        publishedAt: '2026-03-07T09:00:00.000Z',
        publishedAtMs: latestTs,
        url: 'https://max.ru/news/post-2',
        previewUrl: 'https://cdn.max.ru/news/post-2.jpg',
        views: 260,
        reactionsTotal: 8,
        reactions: [
          { emoji: '🔥', count: 5 },
          { emoji: '❤️', count: 3 },
        ],
      },
      {
        chatId: 'channel-1',
        messageId: 'mid-1',
        publishedAt: '2026-03-06T09:00:00.000Z',
        publishedAtMs: previousTs,
        url: 'https://max.ru/news/post-1',
        previewUrl: null,
        views: null,
        reactionsTotal: 12,
        reactions: [],
      },
    ]);
    expect(httpService.request).toHaveBeenCalledTimes(2);
    expect(httpService.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages',
        params: {
          chat_id: 'channel-1',
          count: 2,
          from: rangeToTs,
          to: rangeFromTs,
        },
        headers: { Authorization: 'stats-token' },
      }),
    );
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages',
        params: {
          chat_id: 'channel-1',
          count: 2,
          from: previousTs - 1,
          to: rangeFromTs,
        },
        headers: { Authorization: 'stats-token' },
      }),
    );

    await service.onModuleDestroy();
  });

  it('keeps millisecond-adjacent messages in the same second across snapshot pages', async () => {
    const newestTimestamp = Date.parse('2026-03-07T09:00:00.901Z');
    const pageBoundaryTimestamp = newestTimestamp - 1;
    const nextTimestamp = pageBoundaryTimestamp - 1;
    const rangeFromTs = Date.parse('2026-03-07T08:59:00.000Z');
    const rangeToTs = Date.parse('2026-03-07T09:01:00.000Z');
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              messages: [
                { timestamp: newestTimestamp, body: { mid: 'mid-ms-newest' } },
                { timestamp: pageBoundaryTimestamp, body: { mid: 'mid-ms-boundary' } },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              messages: [{ timestamp: nextTimestamp, body: { mid: 'mid-ms-older' } }],
            },
          }),
        ),
    };
    const service = createService(httpService);

    const result = await service.listMessageSnapshots('channel-1', {
      from: rangeFromTs,
      to: rangeToTs,
      count: 2,
      maxPages: 2,
    });

    expect(result.map((item) => item.messageId)).toEqual([
      'mid-ms-newest',
      'mid-ms-boundary',
      'mid-ms-older',
    ]);
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        params: {
          chat_id: 'channel-1',
          count: 2,
          from: nextTimestamp,
          to: rangeFromTs,
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('continues snapshot pagination when a full page ends with a timestamp tie', async () => {
    const newestTimestamp = Date.parse('2026-03-07T09:00:01.000Z');
    const tiedTimestamp = Date.parse('2026-03-07T09:00:00.900Z');
    const olderTimestamp = tiedTimestamp - 1;
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              messages: [
                { timestamp: newestTimestamp, body: { mid: 'mid-tie-newest' } },
                { timestamp: tiedTimestamp, body: { mid: 'mid-tie-a' } },
                { timestamp: tiedTimestamp, body: { mid: 'mid-tie-b' } },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              messages: [{ timestamp: olderTimestamp, body: { mid: 'mid-tie-older' } }],
            },
          }),
        ),
    };
    const service = createService(httpService);

    await expect(
      service.listMessageSnapshots('channel-1', {
        from: tiedTimestamp - 60_000,
        to: newestTimestamp + 60_000,
        count: 3,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ messageId: 'mid-tie-newest' }),
        expect.objectContaining({ messageId: 'mid-tie-a' }),
        expect.objectContaining({ messageId: 'mid-tie-b' }),
        expect.objectContaining({ messageId: 'mid-tie-older' }),
      ]),
    );
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        params: expect.objectContaining({ from: tiedTimestamp - 1 }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('keeps messages published exactly on both snapshot range boundaries', async () => {
    const rangeFromTs = Date.parse('2026-03-06T09:00:00.000Z');
    const rangeToTs = Date.parse('2026-03-07T12:00:00.000Z');
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            messages: [
              {
                timestamp: rangeToTs,
                body: { mid: 'mid-upper-boundary' },
                stat: { views: 200 },
              },
              {
                timestamp: rangeFromTs,
                body: { mid: 'mid-lower-boundary' },
                stat: { views: 100 },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.listMessageSnapshots('channel-1', {
      from: rangeFromTs,
      to: rangeToTs,
      count: 100,
      maxPages: 1,
    });

    expect(result.map((snapshot) => snapshot.messageId)).toEqual([
      'mid-upper-boundary',
      'mid-lower-boundary',
    ]);
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        params: {
          chat_id: 'channel-1',
          count: 100,
          from: rangeToTs,
          to: rangeFromTs,
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('loads a single official message snapshot with a MAX image payload URL', async () => {
    const publishedAtMs = Date.parse('2026-06-08T17:56:14.328Z');
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            messages: [
              {
                timestamp: publishedAtMs,
                body: {
                  mid: 'mid.ffffbb80bddbf2f4019ea860c3782a5a',
                  attachments: [
                    {
                      payload: {
                        photo_id: 24149085858,
                        token: 'photo-token',
                        url: 'https://i.oneme.ru/i?r=BTGBPUwtwgYUeoFhO7rESmr8VstQjUx',
                      },
                      type: 'image',
                    },
                  ],
                },
                stat: {
                  views: 5926,
                },
                url: 'https://max.ru/id613002203036_biz/AZ7gWKGdJ-o',
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getMessageSnapshot(
      '-75313361194252',
      'mid.ffffbb80bddbf2f4019ea860c3782a5a',
      {
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_STATS_SYNC,
        botId: '777000_bot',
      },
    );

    expect(result).toEqual({
      chatId: '-75313361194252',
      messageId: 'mid.ffffbb80bddbf2f4019ea860c3782a5a',
      publishedAt: '2026-06-08T17:56:14.328Z',
      publishedAtMs,
      url: 'https://max.ru/id613002203036_biz/AZ7gWKGdJ-o',
      previewUrl: 'https://i.oneme.ru/i?r=BTGBPUwtwgYUeoFhO7rESmr8VstQjUx',
      views: 5926,
      reactionsTotal: null,
      reactions: [],
    });
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages',
        params: {
          message_ids: 'mid.ffffbb80bddbf2f4019ea860c3782a5a',
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('returns an exact raw message only when MAX identifies the requested chat', async () => {
    const rawMessage = {
      body: {
        mid: 'mid-exact-link-1',
        text: 'masked label',
        markup: [{ type: 'link', from: 0, length: 12, url: 'https://example.com/path' }],
      },
      recipient: { chat_id: 'chat-1' },
    };
    const httpService = {
      request: jest.fn().mockReturnValueOnce(of({ data: { messages: [rawMessage] } })),
    };
    const service = createService(httpService);

    await expect(
      service.getExactMessageRow('chat-1', 'mid-exact-link-1', {
        trafficClass: 'critical',
        botId: '777000_bot',
      }),
    ).resolves.toBe(rawMessage);
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages',
        params: { message_ids: 'mid-exact-link-1' },
      }),
    );

    await service.onModuleDestroy();
  });

  describe('bound initial-read HTTP 429 evidence', () => {
    const exactBinding = { chatId: 'chat-1', messageId: 'mid-429', botId: '777000_bot' };
    const memberBinding = { chatId: 'chat-1', userId: 'user-1', botId: '777000_bot' };

    it.each(['list', 'direct-after-404', 'direct-after-empty-list'] as const)(
      'retains the original %s error/cooldown and grants one exact-read consumption',
      async (route) => {
        const error = Object.freeze({ response: { status: 429 } });
        const request = jest.fn().mockReturnValue(throwError(() => error));
        if (route === 'direct-after-404')
          request.mockReturnValueOnce(throwError(() => ({ response: { status: 404 } })));
        if (route === 'direct-after-empty-list')
          request.mockReturnValueOnce(of({ status: 200, data: { messages: [] } }));
        const service = createService({ request });
        const diagnostics = observeActionFailureDiagnostics(service);
        try {
          await expect(
            service.getExactMessageRow(' chat-1 ', ' mid-429 ', { botId: '777000_bot' }),
          ).rejects.toBe(error);
          expect(request).toHaveBeenCalledTimes(route === 'list' ? 1 : 2);
          expect(request.mock.calls.every(([config]) => config.method === 'get')).toBe(true);
          expect(request.mock.calls.at(-1)?.[0]).toEqual(
            expect.objectContaining({
              url:
                route === 'list'
                  ? 'https://platform-api2.max.ru/messages'
                  : 'https://platform-api2.max.ru/messages/mid-429',
              headers: expect.objectContaining({ Authorization: 'test-token' }),
            }),
          );
          expect(
            diagnostics.quota.mock.calls.some(([script]) =>
              String(script).includes('MAX_API_EXTERNAL_COOLDOWN'),
            ),
          ).toBe(true);
          expect(consumeMaxExactMessageLookupHttp429({ ...error }, exactBinding)).toBe(false);
          expect(
            consumeMaxExactMessageLookupHttp429(JSON.parse(JSON.stringify(error)), exactBinding),
          ).toBe(false);
          expect(consumeMaxExactMessageLookupHttp429(error, exactBinding)).toBe(true);
          expect(consumeMaxExactMessageLookupHttp429(error, exactBinding)).toBe(false);
          expect(Object.getOwnPropertySymbols(error)).toEqual([]);
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it.each(['chatId', 'messageId', 'botId'] as const)(
      'consumes and rejects exact-read evidence bound to a different %s',
      async (field) => {
        const error = Object.freeze({ response: { status: 429 } });
        const service = createService({
          request: jest.fn().mockReturnValue(throwError(() => error)),
        });
        try {
          await expect(service.getExactMessageRow('chat-1', 'mid-429')).rejects.toBe(error);
          expect(
            consumeMaxExactMessageLookupHttp429(error, { ...exactBinding, [field]: 'other' }),
          ).toBe(false);
          expect(consumeMaxExactMessageLookupHttp429(error, exactBinding)).toBe(false);
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it.each([
      { name: 'generic status', make: () => ({ status: 429 }) },
      { name: 'generic getter', make: () => ({ getStatus: () => 429 }) },
      { name: 'non429 response', make: () => ({ response: { status: 403 } }) },
      {
        name: 'conflicting method',
        make: () => ({ response: { status: 429 }, config: { method: 'delete' } }),
      },
      {
        name: 'conflicting response method',
        make: () => ({ response: { status: 429, config: { method: 'post' } } }),
      },
      {
        name: 'send attempt',
        make: () => markMaxMessageSendAttempted({ response: { status: 429 } }),
      },
      {
        name: 'member attempt',
        make: () => markMaxMemberMutationAttempted({ response: { status: 429 } }),
      },
      {
        name: 'ambiguous effect',
        make: () => Object.assign(new Error('Ambiguous MAX effect'), { response: { status: 429 } }),
      },
    ])('rejects $name despite an adapter read failure', async ({ make }) => {
      const error = make();
      const request = jest.fn().mockReturnValue(throwError(() => error));
      const service = createService({ request });
      try {
        await expect(service.getExactMessageRow('chat-1', 'mid-429')).rejects.toBe(error);
        expect(consumeMaxExactMessageLookupHttp429(error, exactBinding)).toBe(false);
        expect(request).toHaveBeenCalledTimes(1);
      } finally {
        await service.onModuleDestroy();
      }
    });

    it('rejects unlinked and pre-admission errors without minting HTTP evidence', async () => {
      for (const boundary of ['unlinked', 'admission'] as const) {
        const error = Object.freeze({ response: { status: 429 } });
        const request = jest.fn();
        const service = createService({ request });
        const runtime = service as unknown as {
          getMessageById(): Promise<never>;
          reserveRateLimitSlot(): Promise<never>;
        };
        jest
          .spyOn(runtime, boundary === 'unlinked' ? 'getMessageById' : 'reserveRateLimitSlot')
          .mockRejectedValue(error);
        try {
          await expect(service.getExactMessageRow('chat-1', 'mid-429')).rejects.toBe(error);
          expect(consumeMaxExactMessageLookupHttp429(error, exactBinding)).toBe(false);
          expect(request).not.toHaveBeenCalled();
        } finally {
          await service.onModuleDestroy();
        }
      }
    });

    it('does not lend an ignored genuine proof to a later unlinked invocation reusing its error', async () => {
      const error = Object.freeze({ response: { status: 429 } });
      const request = jest.fn().mockReturnValue(throwError(() => error));
      const service = createService({ request });
      try {
        await expect(service.getExactMessageRow('chat-1', 'mid-429')).rejects.toBe(error);
        const runtime = service as unknown as { getMessageById(): Promise<never> };
        jest.spyOn(runtime, 'getMessageById').mockRejectedValue(error);
        await expect(service.getExactMessageRow('chat-1', 'mid-429')).rejects.toBe(error);
        expect(consumeMaxExactMessageLookupHttp429(error, exactBinding)).toBe(false);
        expect(request).toHaveBeenCalledTimes(1);
      } finally {
        await service.onModuleDestroy();
      }
    });

    it('binds a fresh targeted author read once without changing its single request', async () => {
      const error = Object.freeze({ response: { status: 429 } });
      const request = jest.fn().mockReturnValue(throwError(() => error));
      const service = createService({ request });
      try {
        await expect(
          service.getChatMemberAccess(' chat-1 ', ' user-1 ', {
            bypassCache: true,
            botId: '777000_bot',
          }),
        ).rejects.toBe(error);
        expect(request).toHaveBeenCalledTimes(1);
        expect(request).toHaveBeenCalledWith(
          expect.objectContaining({
            method: 'get',
            url: 'https://platform-api2.max.ru/chats/chat-1/members?user_ids=user-1',
          }),
        );
        expect(consumeMaxChatMemberAccessHttp429({ ...error }, memberBinding)).toBe(false);
        expect(consumeMaxChatMemberAccessHttp429(error, memberBinding)).toBe(true);
        expect(consumeMaxChatMemberAccessHttp429(error, memberBinding)).toBe(false);
      } finally {
        await service.onModuleDestroy();
      }
    });

    it('rejects a different author and consumes its genuine one-use evidence', async () => {
      const error = Object.freeze({ response: { status: 429 } });
      const service = createService({
        request: jest.fn().mockReturnValue(throwError(() => error)),
      });
      try {
        await expect(
          service.getChatMemberAccess('chat-1', 'user-1', { bypassCache: true }),
        ).rejects.toBe(error);
        expect(
          consumeMaxChatMemberAccessHttp429(error, { ...memberBinding, userId: 'other' }),
        ).toBe(false);
        expect(consumeMaxChatMemberAccessHttp429(error, memberBinding)).toBe(false);
      } finally {
        await service.onModuleDestroy();
      }
    });

    it.each(['snapshot', 'presence', 'multi-member', 'cached-member'] as const)(
      'keeps other %s read failures outside initial-read evidence',
      async (path) => {
        const error = Object.freeze({ response: { status: 429 } });
        const request = jest.fn().mockReturnValue(throwError(() => error));
        const service = createService({ request });
        try {
          const reading =
            path === 'snapshot'
              ? service.getMessageSnapshot('chat-1', 'mid-429')
              : path === 'presence'
                ? service.getExactMessagePresence('chat-1', 'mid-429')
                : path === 'multi-member'
                  ? service.getChatMembersAccess('chat-1', ['user-1'], { bypassCache: true })
                  : service.getChatMemberAccess('chat-1', 'user-1');
          await expect(reading).rejects.toBe(error);
          expect(consumeMaxExactMessageLookupHttp429(error, exactBinding)).toBe(false);
          expect(consumeMaxChatMemberAccessHttp429(error, memberBinding)).toBe(false);
          expect(request).toHaveBeenCalledTimes(1);
        } finally {
          await service.onModuleDestroy();
        }
      },
    );
  });

  it.each([
    ['raw message', 1_250.8, 1_250],
    ['presence', 1_250.8, 1_250],
    ['raw message', undefined, undefined],
    ['presence', undefined, undefined],
    ['raw message', Number.NaN, undefined],
    ['presence', Number.POSITIVE_INFINITY, undefined],
  ] as const)(
    'passes the normalized timeout to both %s lookup HTTP routes (%s)',
    async (lookup, timeoutMs, expectedTimeout) => {
      const message = {
        body: { mid: 'mid-timeout', text: 'test' },
        recipient: { chat_id: 'chat-1' },
      };
      const httpService = {
        request: jest
          .fn()
          .mockReturnValueOnce(of({ data: { messages: [] } }))
          .mockReturnValueOnce(of({ data: { message } })),
      };
      const service = createService(httpService);
      const options = { botId: '777000_bot', timeoutMs };

      if (lookup === 'presence') {
        await expect(
          service.getExactMessagePresence('chat-1', 'mid-timeout', options),
        ).resolves.toBe('present');
      } else {
        await expect(service.getExactMessageRow('chat-1', 'mid-timeout', options)).resolves.toBe(
          message,
        );
      }

      expect(httpService.request).toHaveBeenCalledTimes(2);
      for (const [request] of httpService.request.mock.calls) {
        expect(request.timeout).toBe(expectedTimeout);
        if (expectedTimeout === undefined) {
          expect(request).not.toHaveProperty('timeout');
        }
      }
      await service.onModuleDestroy();
    },
  );

  it.each([{}, { code: 'message.not.found' }])(
    'recovers an exact raw message through its direct path after list-route 404 (%j)',
    async (data) => {
      const message = {
        body: { mid: 'mid-list-fallback', text: 'test' },
        recipient: { chat_id: 'chat-1' },
      };
      const httpService = {
        request: jest
          .fn()
          .mockReturnValueOnce(throwError(() => ({ response: { status: 404, data } })))
          .mockReturnValueOnce(of({ data: { message } })),
      };
      const service = createService(httpService);

      await expect(
        service.getExactMessageRow('chat-1', 'mid-list-fallback', {
          botId: '777000_bot',
          timeoutMs: 1250,
          trafficClass: 'critical',
        }),
      ).resolves.toBe(message);
      expect(httpService.request).toHaveBeenCalledTimes(2);
      expect(httpService.request.mock.calls.map(([request]) => request.url)).toEqual([
        'https://platform-api2.max.ru/messages',
        'https://platform-api2.max.ru/messages/mid-list-fallback',
      ]);
      for (const [request] of httpService.request.mock.calls) {
        expect(request).toEqual(
          expect.objectContaining({
            method: 'get',
            timeout: 1250,
            headers: expect.objectContaining({ Authorization: 'test-token' }),
          }),
        );
      }
      await service.onModuleDestroy();
    },
  );

  it.each([
    { response: { status: 404, data: {} } },
    { response: { status: 404, data: { code: 'message.not.found' } } },
    { response: { status: 403, data: { code: 'access.denied' } } },
    { response: { status: 503, data: {} } },
    { code: 'ETIMEDOUT' },
  ])('preserves the exact direct lookup failure after list-route 404 (%j)', async (error) => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(throwError(() => ({ response: { status: 404 } })))
        .mockReturnValueOnce(throwError(() => error)),
    };
    const service = createService(httpService);

    await expect(service.getExactMessageRow('chat-1', 'mid-unavailable')).rejects.toBe(error);
    expect(httpService.request).toHaveBeenCalledTimes(2);
    expect(httpService.request.mock.calls.map(([request]) => request.method)).toEqual([
      'get',
      'get',
    ]);
    await service.onModuleDestroy();
  });

  it.each([
    { message: {}, missingRequestedId: true },
    {
      message: { body: { mid: 'another-message' }, recipient: { chat_id: 'chat-1' } },
      missingRequestedId: true,
    },
    {
      message: { body: { mid: 'mid-list-fallback' }, recipient: { chat_id: 'another-chat' } },
      missingRequestedId: false,
    },
    { message: { body: { mid: 'mid-list-fallback' } }, missingRequestedId: false },
  ])(
    'rejects unverified direct identity after list-route 404 (%j)',
    async ({ message, missingRequestedId }) => {
      const httpService = {
        request: jest
          .fn()
          .mockReturnValueOnce(throwError(() => ({ response: { status: 404 } })))
          .mockReturnValueOnce(of({ data: { message } })),
      };
      const service = createService(httpService);

      const error = await service
        .getExactMessageRow('chat-1', 'mid-list-fallback')
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect(isMaxExactMessageLookupMissingIdError(error)).toBe(missingRequestedId);
      expect(httpService.request).toHaveBeenCalledTimes(2);
      await service.onModuleDestroy();
    },
  );

  it('does not fall back to another route after a list lookup transport failure', async () => {
    const error = { code: 'ETIMEDOUT' };
    const httpService = { request: jest.fn().mockReturnValueOnce(throwError(() => error)) };
    const service = createService(httpService);

    await expect(service.getExactMessageRow('chat-1', 'mid-timeout')).rejects.toBe(error);
    expect(httpService.request).toHaveBeenCalledTimes(1);
    await service.onModuleDestroy();
  });

  it.each([403, 404, 429, 503])(
    'keeps a failed moderation pre-delete lookup HTTP %s fail-closed without false global pressure',
    async (status) => {
      const error = {
        response: { status, data: { code: status === 404 ? 'not.found' : 'lookup.failed' } },
      };
      const httpService = {
        request: jest.fn().mockReturnValue(throwError(() => error)),
      };
      const service = createService(httpService);
      const health = (
        service as unknown as {
          actionHealthService: { recordFailureForLane: jest.Mock };
        }
      ).actionHealthService;
      const options = {
        botId: '777000_bot',
        trafficClass: 'critical' as const,
        actionHealthLane: 'critical' as const,
        sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
        ignoreFailureMetricStatuses: MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES,
      };

      await expect(
        service.deleteMessage('chat-1', 'mid-guarded', {
          ...options,
          immediate: true,
          beforeImmediateDeleteMutation: async () => {
            await service.getExactMessageRow('chat-1', 'mid-guarded', options);
          },
        }),
      ).rejects.toBe(error);
      expect(httpService.request).toHaveBeenCalledTimes(status === 404 ? 2 : 1);
      expect(httpService.request).toHaveBeenCalledWith(expect.objectContaining({ method: 'get' }));
      if (status === 403 || status === 404) {
        expect(health.recordFailureForLane).not.toHaveBeenCalled();
      } else {
        expect(health.recordFailureForLane).toHaveBeenCalledTimes(1);
        expect(health.recordFailureForLane).toHaveBeenCalledWith('critical', true, '777000_bot');
      }
      await service.onModuleDestroy();
    },
  );

  describe.each(['state', 'subscription', 'live-links', 'history-links'] as const)(
    '%s authority read health isolation',
    (kind) => {
      it.each(
        (['member', 'source'] as const).flatMap((boundary) =>
          [403, 404, 429, 503, 'timeout'].map((failure) => ({ boundary, failure })),
        ),
      )(
        'retains the $boundary refusal after $failure without unrelated pressure',
        async ({ boundary, failure }) => {
          const error =
            failure === 'timeout'
              ? Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' })
              : {
                  response: { status: failure, data: { code: 'not.found' } },
                  config: { method: 'get' },
                };
          const httpService = { request: jest.fn().mockReturnValue(throwError(() => error)) };
          const client = createService(httpService);
          const health = (client as any).actionHealthService;
          const at = Date.now();
          const settings = {
            requiredSubscriptionEnabled: true,
            requiredSubscriptionChannelIds: ['target'],
            linkPolicy: 'BLOCKLIST_ONLY',
            linkPolicyRevision: 1,
            linkPolicyEffectiveAt: new Date(at - 60_000),
            chat: { entityType: 'CHAT', admins: [] },
          };
          const prisma = {
            chatSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
            $transaction: (operations: Promise<unknown>[]) => Promise.all(operations),
            domainAllowlist: {
              findMany: jest.fn().mockResolvedValue([]),
              aggregate: jest.fn().mockResolvedValue({ _max: { removeAfterAt: null } }),
            },
            moderationDeleteIntentReason: {
              findMany: jest.fn().mockResolvedValue([
                kind === 'history-links'
                  ? {
                      ruleCode: LINK_HISTORY_RECOVERY_RULE_CODE,
                      metadata: {
                        contentFingerprint: 'a'.repeat(64),
                        policyRevision: 1,
                        policyEffectiveAt: settings.linkPolicyEffectiveAt.toISOString(),
                      },
                    }
                  : {
                      ruleCode: LINK_BLOCKED_DELETE_RULE_CODE,
                      metadata: {
                        linkPolicyRevision: 1,
                        linkPolicyEffectiveAt: settings.linkPolicyEffectiveAt.toISOString(),
                      },
                    },
              ]),
            },
          };
          const bots = { isKnownBotUserId: () => false };
          const immunity = { consumeForMessage: jest.fn() };
          const guard =
            kind === 'state'
              ? new ModerationStateDeleteGuardService(
                  prisma as never,
                  client,
                  bots as never,
                  immunity as never,
                  {} as never,
                  {} as never,
                  new ConfigService(),
                )
              : kind === 'subscription'
                ? new RequiredSubscriptionExecutionGuardService(
                    prisma as never,
                    client,
                    bots as never,
                    {} as never,
                    immunity as never,
                    new ConfigService(),
                  )
                : new LinkHistoryDeleteGuardService(
                    prisma as never,
                    client,
                    bots as never,
                    new ConfigService({ MODERATION_LINK_HISTORY_DELETE_ENABLED: true }),
                  );
          if (boundary === 'source') {
            jest.spyOn(client, 'getChatMemberAccess').mockResolvedValue({
              userId: 'user-1',
              isAdmin: false,
              isOwner: false,
            } as never);
          }
          try {
            const input = {
              chatId: '-123',
              messageId: 'mid-guard-read',
              subjectUserId: 'user-1',
              botId: '777000_bot',
            };
            const operation =
              guard instanceof LinkHistoryDeleteGuardService
                ? guard.assertIntentStillActionable({ ...input, intentId: 'intent-guard-read' })
                : guard.authorize({
                    ...input,
                    reasons: [
                      {
                        ruleCode:
                          kind === 'state' ? 'MUTE_ACTIVE_DELETE' : 'REQUIRED_SUBSCRIPTION_DELETE',
                        reasonKey: 'reason',
                        metadata: {
                          requiredSubscriptionGuardVersion: 1,
                          requiredSubscriptionSourceAtMs: at,
                          requiredSubscriptionDeadlineAtMs: at + 300_000,
                          requiredSubscriptionPolicySha256: fingerprintModerationSettings(
                            settings,
                            'REQUIRED_SUBSCRIPTION',
                          ),
                        },
                      },
                    ],
                  });
            await expect(operation).rejects.toBe(error);
            expect(immunity.consumeForMessage).not.toHaveBeenCalled();
            expect(httpService.request).toHaveBeenCalled();
            expect(
              httpService.request.mock.calls.every(([request]) => request.method === 'get'),
            ).toBe(true);
            expect(health.recordSuccessForLane).not.toHaveBeenCalled();
            if (failure === 403 || failure === 404) {
              expect(health.recordFailureForLane).not.toHaveBeenCalled();
            } else {
              expect(health.recordFailureForLane).toHaveBeenCalledTimes(1);
              expect(health.recordFailureForLane).toHaveBeenCalledWith(
                'critical',
                true,
                '777000_bot',
              );
            }
          } finally {
            await client.onModuleDestroy();
          }
        },
      );
    },
  );

  it('keeps exact raw-message absence and chat mismatch fail-closed', async () => {
    const mismatchService = createService({
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            messages: [
              {
                body: { mid: 'mid-exact-mismatch' },
                recipient: { chat_id: 'chat-2' },
              },
            ],
          },
        }),
      ),
    });
    await expect(
      mismatchService.getExactMessageRow('chat-1', 'mid-exact-mismatch'),
    ).rejects.toThrow('for chat chat-2 instead of chat-1');
    await mismatchService.onModuleDestroy();

    const exactNotFound = {
      response: {
        status: 404,
        data: { code: 'message.not.found', message: 'Message not found' },
      },
    };
    const absentService = createService({
      request: jest
        .fn()
        .mockReturnValueOnce(of({ data: { messages: [] } }))
        .mockReturnValueOnce(throwError(() => exactNotFound)),
    });
    await expect(absentService.getExactMessageRow('chat-1', 'mid-exact-absent')).rejects.toBe(
      exactNotFound,
    );
    await absentService.onModuleDestroy();
  });

  it('loads internal channel dialog identities by exact message id for background repair', async () => {
    const threadId = '12345678-1234-4123-8123-123456789abc';
    const token = `cdt-${Buffer.from(
      JSON.stringify({ v: 1, d: threadId, s: 'a'.repeat(64) }),
      'utf8',
    ).toString('base64url')}`;
    const startParam = `cd-${Buffer.from(
      JSON.stringify({
        v: 1,
        k: 'channel-dialog',
        c: 'channel-1',
        m: 'comments',
        t: token,
      }),
      'utf8',
    ).toString('base64url')}`;
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            messages: [
              {
                body: {
                  mid: 'mid-dialog-buttons-1',
                  attachments: [
                    {
                      type: 'inline_keyboard',
                      payload: {
                        buttons: [
                          [
                            {
                              type: 'link',
                              text: 'Комментарии',
                              url: `https://max.ru/bot-1?startapp=${startParam}`,
                            },
                          ],
                          [
                            {
                              type: 'link',
                              text: 'Предложить',
                              url: `https://max.ru/bot-1?start=cds-channel-1.${threadId.replaceAll(
                                '-',
                                '',
                              )}.${'a'.repeat(24)}`,
                            },
                          ],
                          [{ type: 'link', text: 'Сайт', url: 'https://example.com/' }],
                        ],
                      },
                    },
                  ],
                },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    await expect(
      service.getExactChannelDialogButtonIdentities('channel-1', 'mid-dialog-buttons-1', {
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
        botId: '777000_bot',
      }),
    ).resolves.toEqual([
      { chatId: 'channel-1', kind: 'comments', threadId },
      { chatId: 'channel-1', kind: 'suggest', threadId },
    ]);
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages',
        params: { message_ids: 'mid-dialog-buttons-1' },
      }),
    );

    await service.onModuleDestroy();
  });

  it('distinguishes an existing message without owned buttons from an ambiguous 404', async () => {
    const presentHttpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            messages: [
              {
                body: {
                  mid: 'mid-without-dialog-buttons',
                  attachments: [
                    {
                      type: 'inline_keyboard',
                      payload: {
                        buttons: [[{ type: 'link', text: 'Сайт', url: 'https://example.com/' }]],
                      },
                    },
                  ],
                },
              },
            ],
          },
        }),
      ),
    };
    const presentService = createService(presentHttpService);
    await expect(
      presentService.getExactChannelDialogButtonIdentities(
        'channel-1',
        'mid-without-dialog-buttons',
      ),
    ).resolves.toEqual([]);
    await presentService.onModuleDestroy();

    const notFoundError = {
      response: {
        status: 404,
        data: { code: 'message.not.found', message: 'Message not found' },
      },
    };
    const absentHttpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(of({ data: { messages: [] } }))
        .mockReturnValueOnce(throwError(() => notFoundError)),
    };
    const absentService = createService(absentHttpService);
    await expect(
      absentService.getExactChannelDialogButtonIdentities('channel-1', 'mid-absent-dialog'),
    ).rejects.toBe(notFoundError);
    expect(absentHttpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages/mid-absent-dialog',
      }),
    );
    await absentService.onModuleDestroy();
  });

  it('reports an exact raw message as present even when snapshot fields are malformed', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            messages: [
              {
                body: { mid: 'mid-malformed-snapshot' },
                timestamp: 'not-a-timestamp',
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    await expect(
      service.getExactMessagePresence('chat-1', 'mid-malformed-snapshot', {
        botId: '777000_bot',
      }),
    ).resolves.toBe('present');
    expect(httpService.request).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('keeps a list result inconclusive when the message belongs to another chat', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            messages: [
              {
                body: { mid: 'mid-shared' },
                recipient: { chat_id: 'chat-1' },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const results = await service.getExactMessagePresences(
      [
        { chatId: 'chat-1', messageId: 'mid-shared' },
        { chatId: 'chat-2', messageId: 'mid-shared' },
      ],
      { botId: '777000_bot' },
    );

    expect(results[0]).toEqual({
      chatId: 'chat-1',
      messageId: 'mid-shared',
      presence: 'present',
    });
    expect(results[1]).toEqual(
      expect.objectContaining({
        chatId: 'chat-2',
        messageId: 'mid-shared',
        error: expect.any(Error),
      }),
    );
    expect((results[1] as { error: Error }).error.message).toContain(
      'for chat chat-1 instead of chat-2',
    );
    expect(httpService.request).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('matches duplicate message ids to their exact chats regardless of response order', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            messages: [
              {
                body: { mid: 'mid-shared' },
                recipient: { chat_id: 'chat-2' },
              },
              {
                body: { mid: 'mid-shared' },
                recipient: { chat_id: 'chat-1' },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    await expect(
      service.getExactMessagePresences(
        [
          { chatId: 'chat-1', messageId: 'mid-shared' },
          { chatId: 'chat-2', messageId: 'mid-shared' },
        ],
        { botId: '777000_bot' },
      ),
    ).resolves.toEqual([
      { chatId: 'chat-1', messageId: 'mid-shared', presence: 'present' },
      { chatId: 'chat-2', messageId: 'mid-shared', presence: 'present' },
    ]);
    expect(httpService.request).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('keeps an unscoped duplicate message id inconclusive for multiple target chats', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          data: {
            messages: [{ body: { mid: 'mid-shared' } }],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const results = await service.getExactMessagePresences(
      [
        { chatId: 'chat-1', messageId: 'mid-shared' },
        { chatId: 'chat-2', messageId: 'mid-shared' },
      ],
      { botId: '777000_bot' },
    );

    expect(results).toEqual([
      expect.objectContaining({
        chatId: 'chat-1',
        messageId: 'mid-shared',
        error: expect.any(Error),
      }),
      expect.objectContaining({
        chatId: 'chat-2',
        messageId: 'mid-shared',
        error: expect.any(Error),
      }),
    ]);
    expect(httpService.request).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('keeps a direct result inconclusive when the message belongs to another chat', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(of({ data: { messages: [] } }))
        .mockReturnValueOnce(
          of({
            data: {
              message: {
                body: { mid: 'mid-wrong-chat' },
                recipient: { chat_id: 'chat-2' },
              },
            },
          }),
        ),
    };
    const service = createService(httpService);

    await expect(
      service.getExactMessagePresence('chat-1', 'mid-wrong-chat', {
        botId: '777000_bot',
      }),
    ).rejects.toThrow('for chat chat-2 instead of chat-1');
    expect(httpService.request).toHaveBeenCalledTimes(2);

    await service.onModuleDestroy();
  });

  it('keeps a documented message-not-found response ambiguous because it may mean no access', async () => {
    const exactNotFound = {
      response: {
        status: 404,
        data: { code: 'message.not.found', message: 'Message not found' },
      },
    };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(of({ data: { messages: [] } }))
        .mockReturnValueOnce(throwError(() => exactNotFound)),
    };
    const service = createService(httpService);

    await expect(
      service.getExactMessagePresence('chat-1', 'mid-absent', { botId: '777000_bot' }),
    ).rejects.toBe(exactNotFound);
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages/mid-absent',
      }),
    );

    await service.onModuleDestroy();
  });

  it('keeps a direct not-found response ambiguous even when it names the requested message', async () => {
    const exactNotFound = {
      response: {
        status: 404,
        data: {
          code: 'not.found',
          message: 'Message mid-live-absent was not found',
        },
      },
    };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(of({ data: { messages: [] } }))
        .mockReturnValueOnce(throwError(() => exactNotFound)),
    };
    const service = createService(httpService);

    await expect(
      service.getExactMessagePresence('chat-1', 'mid-live-absent', {
        botId: '777000_bot',
      }),
    ).rejects.toBe(exactNotFound);

    await service.onModuleDestroy();
  });

  it('does not infer exact absence from a generic direct not-found response', async () => {
    const genericNotFound = {
      response: {
        status: 404,
        data: { code: 'not.found', message: 'Requested resource was not found' },
      },
    };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(of({ data: { messages: [] } }))
        .mockReturnValueOnce(throwError(() => genericNotFound)),
    };
    const service = createService(httpService);

    await expect(
      service.getExactMessagePresence('chat-1', 'mid-unknown', { botId: '777000_bot' }),
    ).rejects.toBe(genericNotFound);

    await service.onModuleDestroy();
  });

  it('does not infer exact absence when a direct not-found response names another message', async () => {
    const anotherMessageNotFound = {
      response: {
        status: 404,
        data: {
          code: 'not.found',
          message: 'Message mid-requested-other was not found',
        },
      },
    };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(of({ data: { messages: [] } }))
        .mockReturnValueOnce(throwError(() => anotherMessageNotFound)),
    };
    const service = createService(httpService);

    await expect(
      service.getExactMessagePresence('chat-1', 'mid-requested', { botId: '777000_bot' }),
    ).rejects.toBe(anotherMessageNotFound);

    await service.onModuleDestroy();
  });

  it('falls back to direct lookup when the message list returns a bare 404', async () => {
    const bareNotFound = { response: { status: 404, data: {} } };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(throwError(() => bareNotFound))
        .mockReturnValueOnce(of({ data: { message: { body: { mid: 'mid-unknown' } } } })),
    };
    const service = createService(httpService);

    await expect(
      service.getExactMessagePresence('chat-1', 'mid-unknown', { botId: '777000_bot' }),
    ).resolves.toBe('present');
    expect(httpService.request).toHaveBeenCalledTimes(2);
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages/mid-unknown',
      }),
    );

    await service.onModuleDestroy();
  });

  it('does not treat a bare direct-message 404 as exact absence', async () => {
    const listNotFound = {
      response: {
        status: 404,
        data: { code: 'message.not.found', message: 'Message not found' },
      },
    };
    const directBareNotFound = { response: { status: 404, data: {} } };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(throwError(() => listNotFound))
        .mockReturnValueOnce(throwError(() => directBareNotFound)),
    };
    const service = createService(httpService);

    await expect(
      service.getExactMessagePresence('chat-1', 'mid-unknown', { botId: '777000_bot' }),
    ).rejects.toBe(directBareNotFound);

    await service.onModuleDestroy();
  });

  it('does not infer exact absence from direct-message error text without the documented code', async () => {
    const messageOnlyNotFound = {
      response: { status: 404, data: { message: 'Message not found' } },
    };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(of({ data: { messages: [] } }))
        .mockReturnValueOnce(throwError(() => messageOnlyNotFound)),
    };
    const service = createService(httpService);

    await expect(
      service.getExactMessagePresence('chat-1', 'mid-unknown', { botId: '777000_bot' }),
    ).rejects.toBe(messageOnlyNotFound);

    await service.onModuleDestroy();
  });

  it('checks multiple exact messages with one list request and direct fallback for missing ids', async () => {
    const directNotFound = {
      response: {
        status: 404,
        data: { code: 'message.not.found', message: 'Message not found' },
      },
    };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(of({ data: { messages: [{ body: { mid: 'mid-present' } }] } }))
        .mockReturnValueOnce(throwError(() => directNotFound)),
    };
    const service = createService(httpService);

    await expect(
      service.getExactMessagePresences(
        [
          { chatId: 'chat-1', messageId: 'mid-present' },
          { chatId: 'chat-2', messageId: 'mid-absent' },
        ],
        { botId: '777000_bot' },
      ),
    ).resolves.toEqual([
      { chatId: 'chat-1', messageId: 'mid-present', presence: 'present' },
      { chatId: 'chat-2', messageId: 'mid-absent', error: directNotFound },
    ]);
    expect(httpService.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages',
        params: { message_ids: 'mid-present,mid-absent' },
      }),
    );
    expect(httpService.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/messages/mid-absent',
      }),
    );

    await service.onModuleDestroy();
  });

  it('keeps a message-list transport failure ambiguous without direct absence inference', async () => {
    const transportFailure = { response: { status: 503, data: {} } };
    const httpService = {
      request: jest.fn().mockReturnValueOnce(throwError(() => transportFailure)),
    };
    const service = createService(httpService);

    await expect(
      service.getExactMessagePresences(
        [
          { chatId: 'chat-1', messageId: 'mid-1' },
          { chatId: 'chat-2', messageId: 'mid-2' },
        ],
        { botId: '777000_bot' },
      ),
    ).resolves.toEqual([
      { chatId: 'chat-1', messageId: 'mid-1', error: transportFailure },
      { chatId: 'chat-2', messageId: 'mid-2', error: transportFailure },
    ]);
    expect(httpService.request).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('keeps a per-message unknown result when a batch direct fallback is inconclusive', async () => {
    const directBareNotFound = { response: { status: 404, data: {} } };
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(of({ data: { messages: [{ body: { mid: 'mid-present' } }] } }))
        .mockReturnValueOnce(throwError(() => directBareNotFound)),
    };
    const service = createService(httpService);

    const results = await service.getExactMessagePresences(
      [
        { chatId: 'chat-1', messageId: 'mid-present' },
        { chatId: 'chat-2', messageId: 'mid-unknown' },
      ],
      { botId: '777000_bot' },
    );

    expect(results).toEqual([
      { chatId: 'chat-1', messageId: 'mid-present', presence: 'present' },
      { chatId: 'chat-2', messageId: 'mid-unknown', error: directBareNotFound },
    ]);

    await service.onModuleDestroy();
  });

  it('returns current bot member access with granular permissions', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            user_id: 'bot-1',
            is_bot: true,
            role: 'admin',
            is_admin: true,
            permissions: ['add_remove_members', 'change_chat_info'],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getCurrentChatMemberAccess('chat-1');

    expect(result).toEqual({
      userId: 'bot-1',
      isBot: true,
      isAdmin: true,
      isOwner: false,
      permissions: ['add_remove_members', 'change_chat_info'],
      permissionsKnown: true,
      explicitPrivilegeEvidence: true,
      explicitNonPrivilegeEvidence: false,
    });
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/chats/chat-1/members/me',
      }),
    );

    await service.onModuleDestroy();
  });

  describe('incomplete current bot self-access evidence', () => {
    const priorPermissions = ['read_all_messages', 'write', 'add_remove_members'];
    const complete = {
      user_id: '777000_bot',
      is_bot: true,
      is_admin: true,
      is_owner: false,
      permissions: priorPermissions,
    };
    function retainKnownPermissions(service: MaxClientService) {
      const current: NonNullable<
        Awaited<ReturnType<MaxBotLinkService['assertChatBotAccessProbeAllowed']>>
      > = {
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
        botAccessCheckedAt: new Date('2026-10-26T00:00:00Z'),
        botAccessSource: 'explicit_admin_start',
        lifecycleEventAt: null,
        permissionsSnapshot: {
          isAdmin: true,
          isOwner: false,
          permissionsKnown: true,
          permissions: priorPermissions,
        },
        chat: { entityType: ChatEntityType.CHAT },
      };
      const gate: jest.MockedFunction<MaxBotLinkService['assertChatBotAccessProbeAllowed']> = jest
        .fn()
        .mockResolvedValue(current);
      const links: Pick<MaxBotLinkService, 'assertChatBotAccessProbeAllowed'> = {
        assertChatBotAccessProbeAllowed: gate,
      };
      Object.assign(service, { maxBotLinkService: links });
    }

    it.each([null, { is_admin: false }, { is_owner: false }, {}, { permissions: [] }])(
      'rejects incomplete self role %p without caching it',
      async (data) => {
        const httpService = {
          request: jest
            .fn()
            .mockReturnValueOnce(of({ status: 200, data }))
            .mockReturnValue(of({ status: 200, data: complete })),
        };
        const service = createService(httpService);
        try {
          await expect(service.getCurrentChatMemberAccess('self-role')).rejects.toThrow(
            /evidence is incomplete/iu,
          );
          await expect(service.getCurrentChatMemberAccess('self-role')).resolves.toMatchObject({
            isAdmin: true,
            permissionsKnown: true,
          });
          expect(httpService.request).toHaveBeenCalledTimes(2);
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it.each([undefined, null])(
      'rejects omitted known permissions (%p) and allows a later complete self proof',
      async (permissions) => {
        const role = {
          user_id: complete.user_id,
          is_bot: true,
          is_admin: true,
          is_owner: false,
        };
        const httpService = {
          request: jest
            .fn()
            .mockReturnValueOnce(
              of({
                status: 200,
                data: { ...role, ...(permissions === null ? { permissions } : {}) },
              }),
            )
            .mockReturnValue(of({ status: 200, data: complete })),
        };
        const service = createService(httpService);
        retainKnownPermissions(service);
        try {
          await expect(service.getCurrentChatMemberAccess('self-permissions')).rejects.toThrow(
            /evidence is incomplete/iu,
          );
          await expect(
            service.getCurrentChatMemberAccess('self-permissions'),
          ).resolves.toMatchObject({ permissionsKnown: true, permissions: priorPermissions });
          await service.getCurrentChatMemberAccess('self-permissions');
          expect(httpService.request).toHaveBeenCalledTimes(2);
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it('accepts an explicit empty self permission list after a known grant', async () => {
      const httpService = {
        request: jest
          .fn()
          .mockReturnValue(of({ status: 200, data: { ...complete, permissions: [] } })),
      };
      const service = createService(httpService);
      retainKnownPermissions(service);
      try {
        await expect(service.getCurrentChatMemberAccess('self-empty')).resolves.toMatchObject({
          isAdmin: true,
          permissionsKnown: true,
          permissions: [],
        });
      } finally {
        await service.onModuleDestroy();
      }
    });

    it.each(['admin', 'owner'] as const)(
      'accepts explicit legacy %s role evidence on a complete self response',
      async (role) => {
        const httpService = {
          request: jest.fn().mockReturnValue(
            of({
              status: 200,
              data: { user_id: complete.user_id, role, permissions: priorPermissions },
            }),
          ),
        };
        const service = createService(httpService);
        try {
          await expect(
            service.getCurrentChatMemberAccess('self-role-alias'),
          ).resolves.toMatchObject({
            isAdmin: true,
            isOwner: role === 'owner',
            explicitPrivilegeEvidence: true,
            permissionsKnown: true,
          });
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it.each([
      { isAdmin: false },
      { isAdmin: false, explicitNonPrivilegeEvidence: false },
      { isAdmin: true },
      { isAdmin: true, explicitPrivilegeEvidence: false },
      { isAdmin: true, explicitPrivilegeEvidence: true, permissionsKnown: false },
    ])(
      'rereads a legacy self cache without complete role/permission evidence (%p)',
      async (cachedRole) => {
        const store = (
          Redis as unknown as {
            __store: Map<string, { value: string; expiresAtMs: number | null }>;
          }
        ).__store;
        store.set('maxapi:cache:v1:chat-member-access:777000_bot:self-legacy:__self', {
          expiresAtMs: Date.now() + 60_000,
          value: JSON.stringify({
            userId: '777000_bot',
            isBot: true,
            isOwner: false,
            permissionsKnown: true,
            permissions: [],
            ...cachedRole,
          }),
        });
        const httpService = {
          request: jest.fn().mockReturnValue(of({ status: 200, data: complete })),
        };
        const service = createService(httpService);
        retainKnownPermissions(service);
        try {
          await expect(service.getCurrentChatMemberAccess('self-legacy')).resolves.toMatchObject({
            isAdmin: true,
          });
          expect(httpService.request).toHaveBeenCalledTimes(1);
        } finally {
          await service.onModuleDestroy();
        }
      },
    );
  });

  it('checks dormant authority before a cached self access response or forced probe', async () => {
    const httpService = {
      request: jest.fn().mockReturnValue(
        of({
          status: 200,
          data: {
            user_id: '777000_bot',
            is_bot: true,
            is_admin: true,
            permissions: ['read_all_messages', 'write'],
          },
        }),
      ),
    };
    const service = createService(httpService);
    await service.getCurrentChatMemberAccess('chat-dormant');
    const gate = jest.fn().mockRejectedValue(new ManagedEntityActivationRequiredError());
    Object.assign(service, { maxBotLinkService: { assertChatBotAccessProbeAllowed: gate } });
    for (const bypassCache of [false, true])
      await expect(
        service.getCurrentChatMemberAccess('chat-dormant', { bypassCache }),
      ).rejects.toBeInstanceOf(ManagedEntityActivationRequiredError);
    expect(httpService.request).toHaveBeenCalledTimes(1);
    expect(gate).toHaveBeenCalledTimes(2);
    await service.onModuleDestroy();
  });

  it('isolates explicit raw self evidence from passive cache and preserves a denied optional purpose', async () => {
    const httpService = {
      request: jest.fn().mockReturnValue(
        of({
          status: 200,
          data: {
            user_id: '777000_bot',
            is_bot: true,
            is_admin: true,
            is_owner: true,
            permissions: ['can_read_all_messages', 'can_write', 'can_ban_members'],
          },
        }),
      ),
    };
    const service = createService(httpService);
    const previous = {
      isAdmin: true,
      isOwner: false,
      permissionsKnown: true,
      permissions: ['read_all_messages', 'write'],
    };
    const gate = jest.fn().mockResolvedValue({ permissionsSnapshot: previous });
    Object.assign(service, {
      maxBotLinkService: {
        assertChatBotAccessProbeAllowed: gate,
        restrictPassiveBotAccess: (
          _botId: string,
          access: Parameters<typeof restrictPassiveManagedEntityAccess>[0],
        ) => restrictPassiveManagedEntityAccess(access, previous, ChatEntityType.CHAT),
      },
    });
    const proof = {
      kind: 'start_in_chat' as const,
      sourceAt: new Date(),
      updateId: 'fixture-start',
      actorUserId: 'human',
      botId: '777000_bot',
      chatId: 'chat-explicit',
    };
    expect(
      (await service.getCurrentChatMemberAccess('chat-explicit', { explicitActivation: proof }))
        .permissions,
    ).toContain('can_ban_members');
    const passive = await service.getCurrentChatMemberAccess('chat-explicit');
    expect(passive.permissions).not.toContain('can_ban_members');
    expect(passive.activationCapabilityCeiling).not.toContain('moderate_member');
    expect(passive.permissions).toEqual(expect.arrayContaining(['read_all_messages', 'write']));
    await service.getCurrentChatMemberAccess('chat-explicit');
    expect(httpService.request).toHaveBeenCalledTimes(2);
    expect(gate).toHaveBeenCalledWith('chat-explicit', '777000_bot', proof);
    await service.onModuleDestroy();
  });

  it('distinguishes an explicitly empty permission list from a nullable one', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              user_id: 'bot-1',
              is_admin: true,
              permissions: [],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              user_id: 'bot-1',
              is_admin: true,
              permissions: null,
            },
          }),
        ),
    };
    const service = createService(httpService);

    await expect(service.getCurrentChatMemberAccess('channel-known')).resolves.toMatchObject({
      permissions: [],
      permissionsKnown: true,
    });
    await expect(service.getCurrentChatMemberAccess('channel-legacy')).resolves.toMatchObject({
      permissions: [],
      permissionsKnown: false,
    });

    await service.onModuleDestroy();
  });

  it('single-flights concurrent current bot member access checks and shares the Redis cache', async () => {
    const httpService = {
      request: jest.fn().mockReturnValue(
        from(
          Promise.resolve({
            status: 200,
            data: {
              user_id: 'bot-1',
              role: 'admin',
              is_admin: true,
              permissions: ['delete_message'],
            },
          }),
        ),
      ),
    };
    const service = createService(httpService);

    const [first, second] = await Promise.all([
      service.getCurrentChatMemberAccess('chat-1'),
      service.getCurrentChatMemberAccess('chat-1'),
    ]);

    expect(first).toEqual(second);
    expect(httpService.request).toHaveBeenCalledTimes(1);

    const secondHttpService = { request: jest.fn() };
    const secondService = createService(secondHttpService);

    await expect(secondService.getCurrentChatMemberAccess('chat-1')).resolves.toEqual(first);
    expect(secondHttpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
    await secondService.onModuleDestroy();
  });

  it('passes timeout override to targeted chat member lookups', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [
              {
                user_id: 'user-1',
                role: 'member',
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getChatMembersAccess('chat-1', ['user-1'], {
      trafficClass: 'critical',
      timeoutMs: 1_234,
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/chats/chat-1/members?user_ids=user-1',
        timeout: 1_234,
      }),
    );
    expect(result.get('user-1')?.isBot).toBeNull();

    await service.onModuleDestroy();
  });

  it('encodes batched targeted chat member lookups as a comma separated user_ids value', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [
              {
                user_id: 'user-1',
                is_bot: false,
                role: 'member',
              },
              {
                user_id: 'user-2',
                is_bot: true,
                role: 'member',
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getChatMembersAccess('chat-1', ['user-1', 'user-2']);

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/chats/chat-1/members?user_ids=user-1%2Cuser-2',
      }),
    );
    expect([...result.keys()]).toEqual(['user-1', 'user-2']);
    expect(result.get('user-1')?.isBot).toBe(false);
    expect(result.get('user-2')?.isBot).toBe(true);

    await service.onModuleDestroy();
  });

  it.each([
    { role: 'member', is_admin: true, expectedOwner: false },
    { role: 'member', is_owner: true, expectedOwner: true },
    { role: 'guest', is_admin: true, expectedOwner: false },
  ])('protects canonical privilege flags before legacy role $role', async (row) => {
    const { expectedOwner, ...member } = row;
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({ status: 200, data: { members: [{ user_id: 'user-1', is_bot: false, ...member }] } }),
        ),
    };
    const service = createService(httpService);
    await expect(
      service.getChatMemberAccess('chat-1', 'user-1', { bypassCache: true }),
    ).resolves.toEqual(
      expect.objectContaining({ userId: 'user-1', isAdmin: true, isOwner: expectedOwner }),
    );
    await service.onModuleDestroy();
  });

  it.each([
    { role: 'member', is_admin: 'false' },
    { role: 'member', is_admin: null },
    { role: 'member', is_admin: false, isAdmin: true },
    { role: 'member', is_owner: false, isOwner: true },
    { role: 'member', is_owner: true, is_admin: 'false' },
    { role: 'member', member_role: 'admin' },
    { role: 'admin', is_admin: false },
    { role: 'owner', is_owner: false },
    { role: 'creator', is_creator: false },
    { role: 'moderator', is_moderator: false },
    { role: 123, is_admin: false },
  ])('rejects ambiguous fresh privilege evidence %s', async (member) => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({ status: 200, data: { members: [{ user_id: 'user-1', is_bot: false, ...member }] } }),
        ),
    };
    const service = createService(httpService);
    await expect(
      service.getChatMemberAccess('chat-1', 'user-1', { bypassCache: true }),
    ).rejects.toThrow(/(?:Invalid|Conflicting) MAX chat member/u);
    await service.onModuleDestroy();
  });

  it('caches targeted chat member access and respects bypassCache', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              members: [
                {
                  user_id: 'user-1',
                  role: 'admin',
                  is_admin: true,
                  permissions: ['delete_message'],
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              members: [
                {
                  user_id: 'user-1',
                  role: 'member',
                },
              ],
            },
          }),
        ),
    };
    const service = createService(httpService);

    const first = await service.getChatMembersAccess('chat-1', ['user-1']);
    const cached = await service.getChatMembersAccess('chat-1', ['user-1']);
    const fresh = await service.getChatMembersAccess('chat-1', ['user-1'], { bypassCache: true });

    expect(first.get('user-1')).toEqual(
      expect.objectContaining({
        isAdmin: true,
        permissions: ['delete_message'],
      }),
    );
    expect(cached.get('user-1')).toEqual(first.get('user-1'));
    expect(fresh.get('user-1')).toEqual(
      expect.objectContaining({
        isAdmin: false,
        permissions: [],
      }),
    );
    expect(httpService.request).toHaveBeenCalledTimes(2);

    await service.onModuleDestroy();
  });

  it('passes timeout override to chat admin lookups', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [
              {
                user_id: 'user-1',
                role: 'admin',
                is_admin: true,
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    await service.getChatAdminIds('chat-1', {
      trafficClass: 'critical',
      timeoutMs: 1_234,
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/chats/chat-1/members/admins',
        timeout: 1_234,
      }),
    );

    await service.onModuleDestroy();
  });

  it('caches chat admin id lookups per bot and shares them through Redis', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [
              {
                user_id: 'user-1',
                role: 'admin',
                is_admin: true,
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    await expect(service.getChatAdminIds('chat-1')).resolves.toEqual(['user-1']);
    await expect(service.getChatAdminIds('chat-1')).resolves.toEqual(['user-1']);
    expect(httpService.request).toHaveBeenCalledTimes(1);

    const secondHttpService = { request: jest.fn() };
    const secondService = createService(secondHttpService);

    await expect(secondService.getChatAdminIds('chat-1')).resolves.toEqual(['user-1']);
    expect(secondHttpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
    await secondService.onModuleDestroy();
  });

  it('paginates chat admin lookups until MAX stops returning a marker', async () => {
    const request = jest.fn();
    for (let index = 0; index < 21; index += 1) {
      request.mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [
              {
                user_id: `user-${index + 1}`,
                role: 'admin',
                is_admin: true,
              },
            ],
            marker: index < 20 ? index + 1 : null,
          },
        }),
      );
    }
    const service = createService({ request });

    await expect(service.getChatAdminIds('chat-1')).resolves.toEqual(
      Array.from({ length: 21 }, (_, index) => `user-${index + 1}`),
    );
    expect(request).toHaveBeenCalledTimes(21);

    await service.onModuleDestroy();
  });

  it.each([{}, { members: null }, { members: [{}] }, { members: [], marker: {} }])(
    'rejects malformed admin rosters without caching an empty authorization result: %j',
    async (data) => {
      const request = jest
        .fn()
        .mockReturnValueOnce(of({ status: 200, data }))
        .mockReturnValueOnce(
          of({ status: 200, data: { members: [{ user: { user_id: 'user-1' }, is_admin: true }] } }),
        );
      const service = createService({ request });
      await expect(service.getChatAdminIds('chat-1')).rejects.toThrow('Invalid MAX chat admin');
      await expect(service.getChatAdminIds('chat-1')).resolves.toEqual(['user-1']);
      await service.onModuleDestroy();
    },
  );

  it('rejects a repeated admin pagination marker instead of returning a partial roster', async () => {
    const request = jest
      .fn()
      .mockReturnValue(
        of({ status: 200, data: { members: [{ user_id: 'user-1', is_admin: true }], marker: 1 } }),
      );
    const service = createService({ request });
    await expect(service.getChatAdminIds('chat-1')).rejects.toThrow(
      'Incomplete MAX chat admin roster',
    );
    expect(request).toHaveBeenCalledTimes(2);
    await service.onModuleDestroy();
  });

  it.each([{}, { members: null }, { members: [{}] }])(
    'rejects malformed targeted membership responses: %j',
    async (data) => {
      const request = jest.fn().mockReturnValue(of({ status: 200, data }));
      const service = createService({ request });
      await expect(service.getChatMemberAccess('chat-1', 'user-1')).rejects.toThrow(
        'Invalid MAX chat members response',
      );
      await service.onModuleDestroy();
    },
  );

  it.each([
    { data: null },
    { data: {} },
    { data: { success: false } },
    { data: { members: null } },
    { data: { members: [{}] } },
    { data: { users: [null] } },
    { data: { members: [{ user_id: 'user-1' }, {}] } },
  ])('keeps malformed successful membership checks unknown: $data', async ({ data }) => {
    const request = jest
      .fn()
      .mockReturnValueOnce(of({ status: 200, data }))
      .mockReturnValueOnce(of({ status: 200, data: { members: [{ user_id: 'user-1' }] } }));
    const service = createService({ request });
    try {
      await expect(service.hasChatMember('chat-1', 'user-1')).rejects.toThrow(
        'Invalid MAX chat members response',
      );
      await expect(service.hasChatMember('chat-1', 'user-1')).resolves.toBe(true);
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      await service.onModuleDestroy();
    }
  });

  it.each([
    { data: { members: [] }, expected: false },
    { data: { users: [] }, expected: false },
    { data: { members: [{ user_id: 'another-user' }] }, expected: false },
    { data: { members: [{ user_id: 'user-1' }] }, expected: true },
    { data: { users: [{ user: { user_id: 'user-1' } }] }, expected: true },
  ])('preserves a valid exact membership answer: $data', async ({ data, expected }) => {
    const request = jest.fn().mockReturnValue(of({ status: 200, data }));
    const service = createService({ request });
    try {
      await expect(
        service.hasChatMember('chat-1', ' user-1 ', { timeoutMs: 1_234, botId: '777000_bot' }),
      ).resolves.toBe(expected);
      expect(request).toHaveBeenCalledTimes(1);
      expect(request).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'get',
          params: { user_ids: 'user-1' },
          timeout: 1_234,
          headers: { Authorization: 'test-token' },
        }),
      );
    } finally {
      await service.onModuleDestroy();
    }
  });

  describe('initial admin page for source-free settings metadata', () => {
    it('rejects an empty chat identifier before sending a request', async () => {
      const request = jest.fn();
      const service = createService({ request });
      try {
        await expect(service.getChatAdminMembersPage('   ')).rejects.toThrow(
          'MAX chat ID is required',
        );
        expect(request).not.toHaveBeenCalled();
      } finally {
        await service.onModuleDestroy();
      }
    });

    it('makes exactly one documented GET without marker or count query parameters', async () => {
      const request = jest.fn().mockReturnValue(
        of({
          status: 200,
          data: { members: [{ user_id: 'human', role: 'admin', is_bot: false }], marker: null },
        }),
      );
      const service = createService({ request });
      try {
        const page = await service.getChatAdminMembersPage('chat-1', {
          botId: '777000_bot',
          timeoutMs: 1234,
          trafficClass: 'interactive',
          bypassCache: true,
        });
        expect(page.complete).toBe(true);
        expect(page.members).toEqual([expect.objectContaining({ userId: 'human', isBot: false })]);
        expect(request).toHaveBeenCalledTimes(1);
        const config = request.mock.calls[0][0];
        expect(config).toEqual(
          expect.objectContaining({
            method: 'get',
            url: 'https://platform-api2.max.ru/chats/chat-1/members/admins',
            timeout: 1234,
            headers: { Authorization: 'test-token' },
          }),
        );
        expect(config.params).toBeUndefined();
        expect(new URL(config.url).search).toBe('');
      } finally {
        await service.onModuleDestroy();
      }
    });

    it.each([0, 42, 'next-page'])(
      'marks response marker %p incomplete without inventing a continuation request',
      async (marker) => {
        const request = jest.fn().mockReturnValue(
          of({
            status: 200,
            data: { members: [{ user_id: 'human', role: 'admin', is_bot: false }], marker },
          }),
        );
        const service = createService({ request });
        try {
          await expect(service.getChatAdminMembersPage('chat-1')).resolves.toEqual({
            complete: false,
            members: [expect.objectContaining({ userId: 'human', isBot: false })],
          });
          expect(request).toHaveBeenCalledTimes(1);
          expect(request.mock.calls[0][0].params).toBeUndefined();
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it.each([true, false, {}, [], '', '   ', Number.NaN, Number.POSITIVE_INFINITY, 0.5])(
      'rejects malformed response marker %p after one request',
      async (marker) => {
        const request = jest
          .fn()
          .mockReturnValue(of({ status: 200, data: { members: [], marker } }));
        const service = createService({ request });
        try {
          await expect(service.getChatAdminMembersPage('chat-1')).rejects.toThrow(
            'Invalid MAX chat admin pagination marker',
          );
          expect(request).toHaveBeenCalledTimes(1);
        } finally {
          await service.onModuleDestroy();
        }
      },
    );

    it('preserves unknown bot flags and explicit false for humans with a bot-looking username', async () => {
      const request = jest.fn().mockReturnValue(
        of({
          status: 200,
          data: {
            members: [
              { user_id: 'unknown', username: 'unknown_bot', role: 'admin' },
              { user_id: 'string-flag', role: 'admin', is_bot: 'false' },
              {
                user: { user_id: 'human_bot', username: 'human_bot', is_bot: false },
                role: 'owner',
              },
              { user_id: 'explicit-bot', role: 'admin', is_bot: true },
            ],
          },
        }),
      );
      const service = createService({ request });
      try {
        const page = await service.getChatAdminMembersPage('chat-1');
        expect(page.complete).toBe(true);
        expect(page.members.map(({ userId, isBot }) => ({ userId, isBot }))).toEqual([
          { userId: 'unknown', isBot: null },
          { userId: 'string-flag', isBot: null },
          { userId: 'human_bot', isBot: false },
          { userId: 'explicit-bot', isBot: true },
        ]);
        expect(request).toHaveBeenCalledTimes(1);
      } finally {
        await service.onModuleDestroy();
      }
    });
  });

  it('preserves explicit bot markers for the narrow admin roster lookup', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [
              { user_id: 123, role: 'admin', is_bot: true },
              {
                user: { user_id: 'human_bot', username: 'human_bot', is_bot: false },
                role: 'owner',
              },
              { user_id: 'human-2', role: 'admin', isBot: false },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    await expect(service.getChatAdminMembers('chat-1')).resolves.toEqual([
      { userId: '123', isBot: true },
      { userId: 'human_bot', isBot: false },
      { userId: 'human-2', isBot: false },
    ]);
    await expect(service.getChatAdminMembers('chat-1')).resolves.toEqual([
      { userId: '123', isBot: true },
      { userId: 'human_bot', isBot: false },
      { userId: 'human-2', isBot: false },
    ]);
    expect(httpService.request).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('preserves unknown bot identity and owner roles in authorization rosters', async () => {
    const request = jest.fn().mockReturnValue(
      of({
        status: 200,
        data: {
          members: [
            { user_id: 'owner', is_owner: true, is_bot: false },
            { user: { user_id: 'admin', is_bot: false }, is_admin: true },
            { user_id: 'bot', is_admin: true, is_bot: true },
            { user_id: 'unknown', is_admin: true },
          ],
        },
      }),
    );
    const service = createService({ request });
    await expect(service.getChatAdminAccesses('chat-1')).resolves.toEqual([
      expect.objectContaining({ userId: 'owner', isOwner: true, isBot: false }),
      expect.objectContaining({ userId: 'admin', isAdmin: true, isBot: false }),
      expect.objectContaining({ userId: 'bot', isAdmin: true, isBot: true }),
      expect.objectContaining({ userId: 'unknown', isAdmin: true, isBot: null }),
    ]);
    await service.onModuleDestroy();
  });

  it('paginates and caches rich admin roster entries independently from admin ids', async () => {
    const request = jest
      .fn()
      .mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [{ user_id: 'bot-1', role: 'admin', is_bot: true }],
            marker: 42,
          },
        }),
      )
      .mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [{ user_id: 'user-1', role: 'admin', is_bot: false }],
            marker: null,
          },
        }),
      );
    const service = createService({ request });

    await expect(service.getChatAdminMembers('chat-1')).resolves.toEqual([
      { userId: 'bot-1', isBot: true },
      { userId: 'user-1', isBot: false },
    ]);
    await expect(service.getChatAdminMembers('chat-1')).resolves.toEqual([
      { userId: 'bot-1', isBot: true },
      { userId: 'user-1', isBot: false },
    ]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        params: { marker: 42 },
      }),
    );

    await service.onModuleDestroy();
  });

  it('returns null when requested chat member is absent', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getChatMemberAccess('chat-1', 'user-404');

    expect(result).toBeNull();
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/chats/chat-1/members?user_ids=user-404',
      }),
    );

    await service.onModuleDestroy();
  });

  it('returns chat member profiles with avatar urls and usernames', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [
              {
                user_id: 'user-1',
                first_name: 'Алексей',
                last_name: 'Иванов',
                name: 'Алексей',
                username: 'aleksey',
                avatar_url: 'https://cdn.max.ru/u/1/avatar-small.jpg',
                full_avatar_url: 'https://cdn.max.ru/u/1/avatar-full.jpg',
              },
              {
                user: {
                  user_id: 'user-2',
                  first_name: 'Марина',
                  last_name: 'Соколова',
                  nickname: 'Марина',
                  username: 'marina',
                  avatar_url: 'https://cdn.max.ru/u/2/avatar-small.jpg',
                },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getChatMemberProfiles('chat-1', ['user-1', 'user-2'], {
      timeoutMs: 2_500.9,
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        timeout: 2_500,
        url: 'https://platform-api2.max.ru/chats/chat-1/members?user_ids=user-1%2Cuser-2',
      }),
    );
    expect(result.get('user-1')).toEqual({
      userId: 'user-1',
      displayName: 'Алексей Иванов',
      username: 'aleksey',
      avatarUrl: 'https://cdn.max.ru/u/1/avatar-full.jpg',
      profileUrl: null,
    });
    expect(result.get('user-2')).toEqual({
      userId: 'user-2',
      displayName: 'Марина Соколова',
      username: 'marina',
      avatarUrl: 'https://cdn.max.ru/u/2/avatar-small.jpg',
      profileUrl: null,
    });

    await service.onModuleDestroy();
  });

  it('returns paginated chat member roster items with roles, avatars and bot markers', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [
              {
                user_id: 'user-1',
                first_name: 'Алексей',
                username: 'aleksey',
                role: 'owner',
                full_avatar_url: 'https://cdn.max.ru/u/1/avatar-full.jpg',
                last_activity_time: Date.parse('2026-01-01T12:00:00.000Z'),
              },
              {
                user: {
                  user_id: 'moderation_bot',
                  first_name: 'MAXIM',
                  username: 'moderation_bot',
                  avatar_url: 'https://cdn.max.ru/u/bot/avatar.jpg',
                  is_bot: true,
                },
                role: 'admin',
              },
            ],
            marker: 'page-2',
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getChatMembersPage('chat-1', {
      limit: 100,
      marker: 'page-1',
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/chats/chat-1/members',
        params: {
          count: 100,
          marker: 'page-1',
        },
      }),
    );
    expect(result).toEqual({
      items: [
        {
          userId: 'user-1',
          displayName: 'Алексей',
          username: 'aleksey',
          avatarUrl: 'https://cdn.max.ru/u/1/avatar-full.jpg',
          profileUrl: null,
          role: 'owner',
          isBot: false,
          unavailableReason: null,
          lastMaxActivityAt: '2026-01-01T12:00:00.000Z',
          activityCheckedAt: expect.any(String),
        },
        {
          userId: 'moderation_bot',
          displayName: 'MAXIM',
          username: 'moderation_bot',
          avatarUrl: 'https://cdn.max.ru/u/bot/avatar.jpg',
          profileUrl: null,
          role: 'admin',
          isBot: true,
          unavailableReason: null,
          lastMaxActivityAt: null,
          activityCheckedAt: expect.any(String),
        },
      ],
      nextMarker: 'page-2',
    });

    await service.onModuleDestroy();
  });

  it('returns direct profile urls from chat member payloads', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [
              {
                user_id: 'user-1',
                first_name: 'Алексей',
                url: 'https://max.ru/aleksey-profile',
              },
              {
                user: {
                  user_id: 'user-2',
                  first_name: 'Марина',
                  profile_url: 'https://max.ru/marina-profile',
                },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getChatMemberProfiles('chat-1', ['user-1', 'user-2']);

    expect(result.get('user-1')).toEqual({
      userId: 'user-1',
      displayName: 'Алексей',
      username: null,
      avatarUrl: null,
      profileUrl: 'https://max.ru/aleksey-profile',
    });
    expect(result.get('user-2')).toEqual({
      userId: 'user-2',
      displayName: 'Марина',
      username: null,
      avatarUrl: null,
      profileUrl: 'https://max.ru/marina-profile',
    });

    await service.onModuleDestroy();
  });

  it('combines first and last names for chat member roster profiles', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [
              {
                user_id: 'user-1',
                first_name: 'Алексей',
                last_name: 'Иванов',
                username: 'aleksey',
                is_bot: false,
              },
            ],
            marker: null,
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getChatMembersPage('chat-1');

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        userId: 'user-1',
        displayName: 'Алексей Иванов',
      }),
    );

    await service.onModuleDestroy();
  });

  it('reads explicit unavailable account markers from chat member roster payloads', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [
              {
                user_id: 'deleted-1',
                name: 'MAX account',
                is_deleted: true,
              },
              {
                user: {
                  user_id: 'blocked-1',
                  name: 'MAX account',
                  account_status: 'blocked',
                },
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getChatMembersPage('chat-1');

    expect(result.items).toEqual([
      expect.objectContaining({
        userId: 'deleted-1',
        unavailableReason: 'deleted',
      }),
      expect.objectContaining({
        userId: 'blocked-1',
        unavailableReason: 'blocked',
      }),
    ]);

    await service.onModuleDestroy();
  });

  it('treats exact MAX deleted-user placeholders as unavailable without matching named users', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            members: [
              {
                user_id: 'deleted-placeholder',
                name: 'DELETED USER',
                first_name: 'DELETED',
                last_name: 'USER',
                is_bot: false,
              },
              {
                user_id: 'spoofed-profile',
                name: 'DELETED USER',
                first_name: 'DELETED',
                last_name: 'USER',
                username: 'deleted_user',
                is_bot: false,
              },
              {
                user_id: 'ordinary-user',
                name: 'Deleted User',
                first_name: 'Deleted',
                last_name: '',
                is_bot: false,
              },
            ],
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getChatMembersPage('chat-1');

    expect(result.items).toEqual([
      expect.objectContaining({
        userId: 'deleted-placeholder',
        unavailableReason: 'deleted',
      }),
      expect.objectContaining({
        userId: 'spoofed-profile',
        unavailableReason: null,
      }),
      expect.objectContaining({
        userId: 'ordinary-user',
        unavailableReason: null,
      }),
    ]);

    await service.onModuleDestroy();
  });

  it('reads the current bot profile from GET /me', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            user_id: '214634783',
            first_name: 'Майор',
            last_name: 'Максимова',
            name: 'Майор',
            username: 'id613002203036_4_bot',
            avatar_url: 'https://i.oneme.ru/i?r=small-avatar',
            full_avatar_url: 'https://i.oneme.ru/i?r=full-avatar',
          },
        }),
      ),
    };
    const service = createService(httpService);

    const result = await service.getOwnProfile({
      botId: '777000_bot',
      sourceTag: MAX_API_SOURCE_TAGS.SETTINGS_BOT_PROFILE,
    });

    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/me',
      }),
    );
    expect(result).toEqual({
      userId: '214634783',
      displayName: 'Майор Максимова',
      username: 'id613002203036_4_bot',
      avatarUrl: 'https://i.oneme.ru/i?r=full-avatar',
      profileUrl: 'https://max.ru/id613002203036_4_bot',
    });

    await service.onModuleDestroy();
  });

  it('returns only remote /me identity variants for exact-token attestation', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            user_id: '214634783',
            userId: '214634783',
            username: 'id613002203036_4_bot',
          },
        }),
      ),
    };
    const service = createService(httpService);

    await expect(
      service.getOwnProfileIdentity({
        botId: '777000_bot',
        sourceTag: 'publisher_identity_attestation',
      }),
    ).resolves.toEqual({
      userIds: ['214634783'],
      username: 'id613002203036_4_bot',
    });
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/me',
        headers: expect.objectContaining({ Authorization: 'test-token' }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('applies the per-bot MAX API rate limit to read requests', async () => {
    const httpService = {
      request: jest.fn(),
    };
    const service = createService(httpService, {
      MAX_API_GLOBAL_RPS: '30',
      MAX_API_RATE_LIMIT_WAIT_MS_INTERACTIVE: '0',
    });

    (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis.eval
      .mockResolvedValueOnce([1, 0, 0])
      .mockResolvedValueOnce([0, 1, 1]);

    await expect(service.listMessages('chat-1', 10)).rejects.toThrow(
      'MAX API per-bot rate limit exceeded',
    );
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('applies interactive MAX API rate limit to global chat discovery requests', async () => {
    const httpService = {
      request: jest.fn(),
    };
    const service = createService(httpService, {
      MAX_API_GLOBAL_RPS: '30',
      MAX_API_GLOBAL_RPS_INTERACTIVE: '1',
      MAX_API_RATE_LIMIT_WAIT_MS_INTERACTIVE: '0',
    });

    const limiterRedis = (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis;
    limiterRedis.eval.mockResolvedValueOnce([1, 0, 0]).mockResolvedValueOnce([0, 2, 1]);

    await expect(service.listBotChats()).rejects.toThrow('MAX API interactive rate limit exceeded');
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('does not count interactive throttle errors in action health metrics', async () => {
    const httpService = {
      request: jest.fn(),
    };
    const service = createService(httpService, {
      MAX_API_GLOBAL_RPS: '30',
      MAX_API_GLOBAL_RPS_INTERACTIVE: '1',
      MAX_API_RATE_LIMIT_WAIT_MS_INTERACTIVE: '0',
    });
    const actionHealthService = (
      service as unknown as {
        actionHealthService: {
          recordSuccess: jest.Mock;
          recordFailure: jest.Mock;
        };
      }
    ).actionHealthService;

    const limiterRedis = (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis;
    limiterRedis.eval.mockResolvedValueOnce([1, 0, 0]).mockResolvedValueOnce([0, 2, 1]);

    await expect(service.listBotChats()).rejects.toThrow('MAX API interactive rate limit exceeded');

    expect(actionHealthService.recordFailure).not.toHaveBeenCalled();
    expect(actionHealthService.recordSuccess).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('counts a critical internal limiter rejection in action health before dispatch', async () => {
    const httpService = {
      request: jest.fn(),
    };
    const service = createService(httpService, {
      MAX_API_RATE_LIMIT_WAIT_MS_CRITICAL: '0',
    });
    const diagnostics = observeActionFailureDiagnostics(service);
    diagnostics.quota.mockResolvedValueOnce([1, 0, 0]).mockResolvedValueOnce([0, 2, 1]);

    await expect(
      service.deleteMessage('chat-1', 'message-1', {
        immediate: true,
        trafficClass: 'critical',
        actionHealthLane: 'critical',
      }),
    ).rejects.toMatchObject({ code: 'MAX_API_INTERNAL_RATE_LIMIT' });

    expect(diagnostics.failure).toHaveBeenCalledWith('critical', true, '777000_bot');
    expect(diagnostics.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        failureOrigin: 'local_quota',
        isCritical: true,
        requestAssociation: 'unlinked',
        method: 'unknown',
        endpointKind: 'unknown',
      }),
      ACTION_FAILURE_WARNING,
    );
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('waits briefly for a MAX API slot before executing the request', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            chats: [],
            marker: null,
          },
        }),
      ),
    };
    const service = createService(httpService, {
      MAX_API_GLOBAL_RPS: '30',
      MAX_API_GLOBAL_RPS_INTERACTIVE: '1',
      MAX_API_RATE_LIMIT_WAIT_MS_INTERACTIVE: '10',
      MAX_API_RATE_LIMIT_RETRY_FLOOR_MS: '1',
    });
    const limiterRedis = (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis;
    limiterRedis.eval
      .mockResolvedValueOnce([1, 0, 0])
      .mockResolvedValueOnce([0, 2, 1])
      .mockResolvedValueOnce([1, 0, 0]);

    await expect(service.listBotChats()).resolves.toEqual([]);

    expect(limiterRedis.eval).toHaveBeenCalledTimes(3);
    expect(httpService.request).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('yields a Publisher publication slot immediately with the exact cooldown', async () => {
    const service = createService({}, { MAX_API_RATE_LIMIT_WAIT_MS_BACKGROUND: '5000' });
    const internal = service as any;
    internal.botRegistry.getPublisherBotDescriptor = () => ({ id: '777000_bot' });
    const reserve = jest.spyOn(internal, 'tryReserveRateLimitSlot').mockResolvedValue({
      ok: false,
      retryAfterMs: 30_000,
      reason: 'external cooldown',
    });
    const sleep = jest.spyOn(internal, 'sleep');
    jest.spyOn(internal, 'recordRateLimitOutcome').mockResolvedValue(undefined);
    await expect(
      internal.reserveRateLimitSlot(
        '777000_bot',
        'chat-1',
        'background',
        MAX_API_SOURCE_TAGS.MANAGED_BROADCAST,
        undefined,
        { operation: 'send', entityId: 'chat-1' },
      ),
    ).rejects.toMatchObject({
      code: 'MAX_API_INTERNAL_RATE_LIMIT',
      preDispatch: true,
      retryAfterMs: 30_000,
    });
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it('gives moderation deletes a dedicated bounded slot wait without widening critical traffic', async () => {
    const service = createService(
      {},
      {
        MAX_API_RATE_LIMIT_WAIT_MS_CRITICAL: '1000',
      },
    );

    expect(
      (service as any).resolveTrafficClassRateLimitWaitMs(
        'critical',
        MAX_API_SOURCE_TAGS.MODERATION_DELETE,
        { operation: 'delete', entityId: 'chat-1' },
      ),
    ).toBe(2_500);
    expect(
      (service as any).resolveTrafficClassRateLimitWaitMs(
        'critical',
        MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      ),
    ).toBe(1_000);
    expect(
      (service as any).resolveTrafficClassRateLimitWaitMs(
        'critical',
        MAX_API_SOURCE_TAGS.MODERATION_SANCTION,
        { operation: 'delete', entityId: 'chat-1' },
      ),
    ).toBe(1_000);
    expect(
      (service as any).resolveTrafficClassRateLimitWaitMs(
        'interactive',
        MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      ),
    ).toBe(1_500);

    await service.onModuleDestroy();
  });

  it('uses the dedicated moderation delete budget while keeping the critical limiter deadline', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-11T09:59:00.000Z'));
    const service = createService(
      {},
      {
        MAX_API_RATE_LIMIT_WAIT_MS_CRITICAL: '1000',
        MAX_API_RATE_LIMIT_WAIT_MS_MODERATION_DELETE: '2000',
        MAX_API_RATE_LIMIT_RETRY_FLOOR_MS: '1',
      },
    );
    const internal = service as any;
    const reserve = jest.spyOn(internal, 'tryReserveRateLimitSlot');
    jest.spyOn(internal, 'recordRateLimitUsage').mockResolvedValue(undefined);
    jest.spyOn(internal, 'recordRateLimitOutcome').mockResolvedValue(undefined);

    reserve
      .mockResolvedValueOnce({
        ok: false,
        retryAfterMs: 1_500,
        reason: 'MAX API delete message rate limit exceeded for target chat-1',
      })
      .mockResolvedValueOnce({ ok: true });
    const moderationDeleteReservation = internal.reserveRateLimitSlot(
      '777000_bot',
      'chat-1',
      'critical',
      MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      5_000,
      { operation: 'delete', entityId: 'chat-1' },
    );

    await jest.advanceTimersByTimeAsync(1_500);
    const activityId = await moderationDeleteReservation;
    expect(activityId).toMatch(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
    expect(reserve.mock.calls[0]?.[5]).toBe(activityId);
    expect(reserve.mock.calls[1]?.[5]).toBe(activityId);

    reserve.mockReset().mockResolvedValue({
      ok: false,
      retryAfterMs: 1_500,
      reason: 'MAX API delete message rate limit exceeded for target chat-1',
    });
    const deadlineBoundDeleteReservation = internal.reserveRateLimitSlot(
      '777000_bot',
      'chat-1',
      'critical',
      MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      500,
      { operation: 'delete', entityId: 'chat-1' },
    );
    const deadlineBoundDeleteExpectation = expect(
      deadlineBoundDeleteReservation,
    ).rejects.toMatchObject({
      code: 'MAX_API_INTERNAL_RATE_LIMIT',
      preDispatch: true,
    });

    await jest.advanceTimersByTimeAsync(500);
    await deadlineBoundDeleteExpectation;

    reserve.mockReset().mockResolvedValue({
      ok: false,
      retryAfterMs: 1_500,
      reason: 'MAX API critical rate limit exceeded for bot 777000_bot',
    });
    const regularCriticalReservation = internal.reserveRateLimitSlot(
      '777000_bot',
      'chat-2',
      'critical',
      MAX_API_SOURCE_TAGS.MODERATION_SANCTION,
      5_000,
    );
    const regularCriticalExpectation = expect(regularCriticalReservation).rejects.toMatchObject({
      code: 'MAX_API_INTERNAL_RATE_LIMIT',
      preDispatch: true,
    });

    await jest.advanceTimersByTimeAsync(1_000);
    await regularCriticalExpectation;

    await service.onModuleDestroy();
  });

  it('uses no shared hard GCRA dimension across independent bot tokens', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-11T10:00:00.000Z'));
    const firstService = createService(
      {},
      {
        MAX_API_GLOBAL_RPS: '1',
        MAX_API_GLOBAL_RPS_BACKGROUND: '1',
        MAX_API_MANAGED_REFRESH_RPS: '1',
      },
    );
    const secondService = createService(
      {},
      {
        MAX_API_GLOBAL_RPS: '1',
        MAX_API_GLOBAL_RPS_BACKGROUND: '1',
        MAX_API_MANAGED_REFRESH_RPS: '1',
      },
    );

    await expect(
      (firstService as any).tryReserveRateLimitSlot(
        'bot-a',
        'chat-a',
        'background',
        MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
      ),
    ).resolves.toEqual({ ok: true });
    await expect(
      (secondService as any).tryReserveRateLimitSlot(
        'bot-b',
        'chat-b',
        'background',
        MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
      ),
    ).resolves.toEqual({ ok: true });

    const readLastDimensions = (service: MaxClientService) => {
      const limiterRedis = (service as unknown as { limiterRedis: { eval: jest.Mock } })
        .limiterRedis;
      const call = limiterRedis.eval.mock.calls.at(-1) as unknown[];
      return { ...reservationDimensions(call), limiterRedis };
    };
    const first = readLastDimensions(firstService);
    const second = readLastDimensions(secondService);
    expect(first.keys).toEqual([
      'maxapi:gcra:v1:bot:bot-a:all',
      'maxapi:gcra:v1:service:api:bot:bot-a:class:background',
      'maxapi:gcra:v1:chat:bot-a:chat-a',
      'maxapi:gcra:v1:service:api:source:bot-a:managed_refresh',
    ]);
    expect(second.keys).toEqual([
      'maxapi:gcra:v1:bot:bot-b:all',
      'maxapi:gcra:v1:service:api:bot:bot-b:class:background',
      'maxapi:gcra:v1:chat:bot-b:chat-b',
      'maxapi:gcra:v1:service:api:source:bot-b:managed_refresh',
    ]);
    expect(first.keys.filter((key) => second.keys.includes(key))).toEqual([]);
    expect([...first.keys, ...second.keys].some((key) => key.includes(':stack:'))).toBe(false);

    for (let rejectedIndex = 1; rejectedIndex <= first.keyCount; rejectedIndex += 1) {
      first.limiterRedis.eval.mockResolvedValueOnce([0, rejectedIndex, 1]);
      const rejected = await (firstService as any).tryReserveRateLimitSlot(
        'bot-a',
        'chat-a',
        'background',
        MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
      );
      expect(rejected.reason).not.toContain('across all bots');
    }

    await firstService.onModuleDestroy();
    await secondService.onModuleDestroy();
  });

  it('shares the per-bot GCRA reservation across service instances for the same token', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-11T10:00:00.000Z'));
    const firstService = createService(
      {},
      {
        APP_SERVICE_NAME: 'API Action / A',
        MAX_API_GLOBAL_RPS: '1',
        MAX_API_GLOBAL_RPS_INTERACTIVE: '2',
      },
    );
    const secondService = createService(
      {},
      {
        APP_SERVICE_NAME: 'API Action / B',
        MAX_API_GLOBAL_RPS: '1',
        MAX_API_GLOBAL_RPS_INTERACTIVE: '2',
      },
    );

    await expect(
      (firstService as any).tryReserveRateLimitSlot('bot-a', 'chat-a', 'interactive'),
    ).resolves.toEqual({ ok: true });
    await expect(
      (secondService as any).tryReserveRateLimitSlot('bot-a', 'chat-b', 'interactive'),
    ).resolves.toEqual({
      ok: false,
      retryAfterMs: 1_000,
      reason: 'MAX API per-bot rate limit exceeded for bot bot-a',
      limitScope: 'bot',
    });

    await firstService.onModuleDestroy();
    await secondService.onModuleDestroy();
  });

  it('adds operation, bot, and entity GCRA dimensions to message mutations', async () => {
    const httpService = {
      request: jest.fn((request: { method?: string }) => {
        if (request.method === 'post') {
          return of({ status: 200, data: { message_id: 'mid-send-1' } });
        }
        if (request.method === 'get') {
          return of({
            status: 200,
            data: {
              messages: [
                {
                  body: {
                    mid: 'mid-edit-1',
                    text: 'Before',
                    attachments: [],
                  },
                },
              ],
            },
          });
        }
        if (request.method === 'put' || request.method === 'delete') {
          return of({ status: 200, data: { success: true } });
        }
        throw new Error(`Unexpected MAX request method ${String(request.method)}`);
      }),
    };
    const service = createService(httpService, {
      MAX_API_GLOBAL_RPS: '100',
      MAX_API_GLOBAL_RPS_CRITICAL: '100',
      MAX_API_CHAT_RPS: '100',
    });

    await service.sendMessageImmediateWithId('chat-send', 'Hello');
    await service.sendMessageImmediateToUser('user-send', 'Direct hello');
    await service.executeActionJob({
      actionType: 'SEND_MESSAGE',
      chatId: 'chat-queued-send',
      text: 'Queued hello',
      attempt: 1,
      idempotencyKey: 'send-rate-limit-key',
      createdAt: new Date().toISOString(),
    });
    await service.editMessageInlineKeyboard('chat-edit', 'mid-edit-1', 'After');
    await service.executeActionJob({
      actionType: 'DELETE_MESSAGE',
      chatId: 'chat-delete',
      messageId: 'mid-delete-1',
      attempt: 1,
      idempotencyKey: 'delete-rate-limit-key',
      createdAt: new Date().toISOString(),
    });
    await service.answerCallback('callback-rate-limit', 'Done', undefined, {
      rateLimitEntityId: 'chat-answer',
    });

    const limiterRedis = (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis;
    const messageMutationKeys = limiterRedis.eval.mock.calls.flatMap((call) => {
      if (!String(call[0]).includes('MAX_API_GCRA_RESERVE_V1')) {
        return [];
      }
      const keyCount = Number(call[1]);
      return call
        .slice(2, 2 + keyCount)
        .map((key: unknown) => String(key))
        .filter((key: string) => key.startsWith('maxapi:gcra:v1:message-mutation:'));
    });

    expect(messageMutationKeys).toEqual([
      'maxapi:gcra:v1:message-mutation:operation:send:scope:target:chat-send',
      'maxapi:gcra:v1:message-mutation:operation:send:scope:target:user%3Auser-send',
      'maxapi:gcra:v1:message-mutation:operation:send:scope:target:chat-queued-send',
      'maxapi:gcra:v1:message-mutation:operation:edit:scope:target:chat-edit',
      'maxapi:gcra:v1:message-mutation:operation:delete:scope:target:chat-delete',
      'maxapi:gcra:v1:message-mutation:operation:answer:scope:target:chat-answer',
    ]);

    await service.onModuleDestroy();
  });

  it('shares a smoothed two-per-second message mutation quota while isolating dimensions', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-11T10:02:00.000Z'));
    const config = {
      MAX_API_GLOBAL_RPS: '100',
      MAX_API_GLOBAL_RPS_CRITICAL: '100',
      MAX_API_CHAT_RPS: '100',
    };
    const firstService = createService({}, config);
    const secondService = createService({}, config);
    const reserve = (
      service: MaxClientService,
      operation: 'send' | 'edit' | 'delete' | 'answer',
      botId: string,
      entityId: string,
    ) =>
      (service as any).tryReserveRateLimitSlot(botId, entityId, 'critical', undefined, {
        operation,
        entityId,
      });

    await expect(reserve(firstService, 'send', 'bot-a', 'chat-a')).resolves.toEqual({
      ok: true,
    });
    await expect(reserve(secondService, 'send', 'bot-a', 'chat-a')).resolves.toEqual({
      ok: false,
      retryAfterMs: 500,
      reason: 'MAX API send message rate limit exceeded for target chat-a',
      limitScope: 'message_target',
    });

    jest.advanceTimersByTime(500);
    await expect(reserve(secondService, 'send', 'bot-a', 'chat-a')).resolves.toEqual({
      ok: true,
    });
    await expect(reserve(firstService, 'send', 'bot-a', 'chat-a')).resolves.toEqual({
      ok: false,
      retryAfterMs: 500,
      reason: 'MAX API send message rate limit exceeded for target chat-a',
      limitScope: 'message_target',
    });

    await expect(reserve(secondService, 'edit', 'bot-a', 'chat-a')).resolves.toEqual({
      ok: true,
    });
    await expect(reserve(secondService, 'delete', 'bot-a', 'chat-a')).resolves.toEqual({
      ok: true,
    });
    await expect(reserve(secondService, 'send', 'bot-a', 'chat-b')).resolves.toEqual({
      ok: true,
    });
    await expect(reserve(secondService, 'send', 'bot-b', 'chat-a')).resolves.toEqual({
      ok: false,
      retryAfterMs: 500,
      reason: 'MAX API send message rate limit exceeded for target chat-a',
      limitScope: 'message_target',
    });
    await expect(reserve(firstService, 'answer', 'bot-a', 'chat-answer')).resolves.toEqual({
      ok: true,
    });
    await expect(reserve(secondService, 'answer', 'bot-a', 'chat-answer')).resolves.toEqual({
      ok: false,
      retryAfterMs: 500,
      reason: 'MAX API answer message rate limit exceeded for target chat-answer',
      limitScope: 'message_target',
    });

    await firstService.onModuleDestroy();
    await secondService.onModuleDestroy();
  });

  it('shares an open circuit across instances before dispatch', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-11T10:05:00.000Z'));
    const upstreamFailure = Object.assign(new Error('MAX unavailable'), {
      response: { status: 500, data: { message: 'MAX unavailable' } },
    });
    const firstHttpService = {
      request: jest.fn().mockReturnValue(throwError(() => upstreamFailure)),
    };
    const firstService = createService(firstHttpService, {
      MAX_API_CIRCUIT_FAILURE_THRESHOLD: '1',
      MAX_API_CIRCUIT_WINDOW_SEC: '30',
      MAX_API_CIRCUIT_OPEN_SEC: '2',
    });
    const secondHttpService = { request: jest.fn() };
    const secondService = createService(secondHttpService, {
      MAX_API_CIRCUIT_FAILURE_THRESHOLD: '1',
      MAX_API_CIRCUIT_WINDOW_SEC: '30',
      MAX_API_CIRCUIT_OPEN_SEC: '2',
    });

    await expect(firstService.getChatSnapshot('chat-1')).rejects.toBe(upstreamFailure);
    const circuitError = await secondService
      .executeActionJob({
        actionType: 'BAN_MEMBER',
        chatId: 'chat-1',
        userId: 'user-1',
        attempt: 1,
        idempotencyKey: 'ban-open-circuit',
        createdAt: new Date().toISOString(),
      })
      .catch((caught: unknown) => caught);

    expect(circuitError).toMatchObject({
      name: 'MaxApiCircuitOpenError',
      code: 'MAX_API_CIRCUIT_OPEN',
      preDispatch: true,
      botId: '777000_bot',
      retryAfterMs: 2_000,
    });
    expect(wasMaxMemberMutationAttempted(circuitError)).toBe(false);
    expect(secondHttpService.request).not.toHaveBeenCalled();

    await firstService.onModuleDestroy();
    await secondService.onModuleDestroy();
  });

  it.each([
    ['connection reset', 'ECONNRESET'],
    ['DNS lookup failure', 'ENOTFOUND'],
    ['connection refusal', 'ECONNREFUSED'],
    ['TLS certificate failure', 'ERR_TLS_CERT_ALTNAME_INVALID'],
  ])('opens the shared circuit after a %s without an HTTP response', async (_label, code) => {
    const transportFailure = Object.assign(new Error(`MAX transport failed: ${code}`), { code });
    const firstService = createService(
      {
        request: jest.fn().mockReturnValue(throwError(() => transportFailure)),
      },
      {
        MAX_API_CIRCUIT_FAILURE_THRESHOLD: '1',
        MAX_API_CIRCUIT_WINDOW_SEC: '30',
        MAX_API_CIRCUIT_OPEN_SEC: '2',
      },
    );
    const secondHttpService = { request: jest.fn() };
    const secondService = createService(secondHttpService, {
      MAX_API_CIRCUIT_FAILURE_THRESHOLD: '1',
      MAX_API_CIRCUIT_WINDOW_SEC: '30',
      MAX_API_CIRCUIT_OPEN_SEC: '2',
    });

    await expect(firstService.getChatSnapshot('chat-transport')).rejects.toBe(transportFailure);
    await expect(secondService.getChatSnapshot('chat-transport')).rejects.toBeInstanceOf(
      MaxApiCircuitOpenError,
    );
    expect(secondHttpService.request).not.toHaveBeenCalled();

    await firstService.onModuleDestroy();
    await secondService.onModuleDestroy();
  });

  it('keeps a half-open circuit open when its probe times out', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-11T10:07:00.000Z'));
    const config = {
      MAX_API_CIRCUIT_FAILURE_THRESHOLD: '1',
      MAX_API_CIRCUIT_WINDOW_SEC: '30',
      MAX_API_CIRCUIT_OPEN_SEC: '1',
      MAX_API_CIRCUIT_HALF_OPEN_PROBE_SEC: '60',
    };
    const initialFailure = Object.assign(new Error('MAX unavailable'), {
      response: { status: 500 },
    });
    const timeoutFailure = Object.assign(new Error('request timed out'), {
      code: 'ETIMEDOUT',
    });
    const firstService = createService(
      {
        request: jest.fn().mockReturnValue(throwError(() => initialFailure)),
      },
      config,
    );
    const probeService = createService(
      {
        request: jest.fn().mockReturnValue(throwError(() => timeoutFailure)),
      },
      config,
    );
    const blockedHttpService = { request: jest.fn() };
    const blockedService = createService(blockedHttpService, config);

    await expect(firstService.getChatSnapshot('chat-probe')).rejects.toBe(initialFailure);
    jest.advanceTimersByTime(1_000);
    await expect(probeService.getChatSnapshot('chat-probe')).rejects.toBe(timeoutFailure);
    await expect(blockedService.getChatSnapshot('chat-probe')).rejects.toBeInstanceOf(
      MaxApiCircuitOpenError,
    );
    expect(blockedHttpService.request).not.toHaveBeenCalled();

    await firstService.onModuleDestroy();
    await probeService.onModuleDestroy();
    await blockedService.onModuleDestroy();
  });

  it('closes a half-open circuit after an ordinary HTTP 4xx response', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-11T10:08:00.000Z'));
    const config = {
      MAX_API_CIRCUIT_FAILURE_THRESHOLD: '1',
      MAX_API_CIRCUIT_WINDOW_SEC: '30',
      MAX_API_CIRCUIT_OPEN_SEC: '1',
      MAX_API_CIRCUIT_HALF_OPEN_PROBE_SEC: '60',
    };
    const firstService = createService({}, config);
    const initialPermit = await (firstService as any).acquireCircuitPermit('777000_bot');
    await (firstService as any).registerCriticalFailure('777000_bot', initialPermit);
    jest.advanceTimersByTime(1_000);

    const forbidden = Object.assign(new Error('forbidden'), {
      response: { status: 403 },
    });
    const probeService = createService(
      {
        request: jest.fn().mockReturnValue(throwError(() => forbidden)),
      },
      config,
    );
    await expect(probeService.getChatSnapshot('chat-forbidden')).rejects.toBe(forbidden);

    const nextService = createService({}, config);
    await expect((nextService as any).acquireCircuitPermit('777000_bot')).resolves.toEqual({
      halfOpenProbeToken: null,
    });

    await firstService.onModuleDestroy();
    await probeService.onModuleDestroy();
    await nextService.onModuleDestroy();
  });

  it('allows only one shared half-open probe and closes it with a fenced token', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-11T10:10:00.000Z'));
    const config = {
      MAX_API_CIRCUIT_FAILURE_THRESHOLD: '1',
      MAX_API_CIRCUIT_WINDOW_SEC: '30',
      MAX_API_CIRCUIT_OPEN_SEC: '1',
      MAX_API_CIRCUIT_HALF_OPEN_PROBE_SEC: '60',
    };
    const firstService = createService({}, config);
    const secondService = createService({}, config);
    const thirdService = createService({}, config);
    const firstPermit = await (firstService as any).acquireCircuitPermit('777000_bot');
    await (firstService as any).registerCriticalFailure('777000_bot', firstPermit);

    jest.advanceTimersByTime(1_000);
    const probePermit = await (secondService as any).acquireCircuitPermit('777000_bot');
    expect(probePermit.halfOpenProbeToken).toEqual(expect.any(String));
    await expect((thirdService as any).acquireCircuitPermit('777000_bot')).rejects.toBeInstanceOf(
      MaxApiCircuitOpenError,
    );

    await (secondService as any).closeCircuitAfterSuccessfulProbe('777000_bot', probePermit);
    await expect((thirdService as any).acquireCircuitPermit('777000_bot')).resolves.toEqual({
      halfOpenProbeToken: null,
    });

    await firstService.onModuleDestroy();
    await secondService.onModuleDestroy();
    await thirdService.onModuleDestroy();
  });

  it.each([
    [0, 'external_cooldown', undefined, false],
    [1, 'bot', undefined, false],
    [2, 'role_class', undefined, false],
    [3, 'chat', undefined, false],
    [4, 'message_target', undefined, true],
    [5, 'retention_fleet', MAX_API_SOURCE_TAGS.MESSAGE_RETENTION, true],
    [6, 'retention_chat', MAX_API_SOURCE_TAGS.MESSAGE_RETENTION, true],
    [4, 'managed_refresh', MAX_API_SOURCE_TAGS.MANAGED_REFRESH, false],
    [99, 'unknown', undefined, false],
  ])(
    'reports refused quota scope %s/%s without dispatching or changing retry delay',
    async (index, limitScope, sourceTag, mutation) => {
      const request = jest.fn();
      const service = createService({ request });
      const internal = service as any;
      const warn = jest.spyOn(internal.logger, 'warn');
      internal.limiterRedis.eval.mockResolvedValueOnce([0, index, 12_345]);
      try {
        await expect(
          internal.reserveRateLimitSlot(
            '777000_bot',
            'chat-private',
            'background',
            sourceTag,
            0,
            mutation ? { operation: 'delete', entityId: 'chat-private' } : undefined,
          ),
        ).rejects.toMatchObject({
          code: 'MAX_API_INTERNAL_RATE_LIMIT',
          preDispatch: true,
          retryAfterMs: 12_345,
          limitScope,
        });
        expect(request).not.toHaveBeenCalled();
        expect(internal.limiterRedis.eval).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ limitScope, retryAfterMs: 12_345 }),
          'MAX API internal limiter rejected request before dispatch',
        );
      } finally {
        await service.onModuleDestroy();
      }
    },
  );

  it('records internal limiter rejection separately from an external MAX 429', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-11T10:15:00.000Z'));
    const internalService = createService(
      { request: jest.fn() },
      {
        MAX_API_RATE_LIMIT_WAIT_MS_INTERACTIVE: '0',
      },
    );
    const internalRedis = (internalService as any).limiterRedis;
    const internalDiagnostics = {
      recordProblemChat: jest.fn().mockResolvedValue(undefined),
    };
    (internalService as any).runtimeDiagnosticsService = internalDiagnostics;
    const internalWarn = jest.spyOn((internalService as any).logger, 'warn');
    internalRedis.eval.mockResolvedValueOnce([1, 0, 0]).mockResolvedValueOnce([0, 1, 250]);

    await expect(internalService.getChatSnapshot('chat-internal')).rejects.toMatchObject({
      code: 'MAX_API_INTERNAL_RATE_LIMIT',
      preDispatch: true,
      retryAfterMs: 250,
      limitScope: 'bot',
    });
    const nowSec = Math.floor(Date.now() / 1_000);
    await expect(
      internalRedis.get(`maxapi:rate-limit:v1:internal_limiter:777000_bot:interactive:${nowSec}`),
    ).resolves.toBe('1');
    expect(internalDiagnostics.recordProblemChat).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'max_api_internal_limiter', statusCode: null }),
    );
    expect(internalWarn).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'internal_limiter', limitScope: 'bot' }),
      'MAX API internal limiter rejected request before dispatch',
    );
    await (internalService as any).recordRateLimitOutcome({
      origin: 'internal_limiter',
      botId: '777000_bot',
      chatId: 'chat-internal-2',
      trafficClass: 'interactive',
      reason: 'another internal reject',
      retryAfterMs: 200,
    });
    await expect(
      internalRedis.get(`maxapi:rate-limit:v1:internal_limiter:777000_bot:interactive:${nowSec}`),
    ).resolves.toBe('2');
    expect(internalWarn).toHaveBeenCalledTimes(1);
    await internalService.onModuleDestroy();

    (
      Redis as unknown as { __store: Map<string, { value: string; expiresAtMs: number | null }> }
    ).__store.clear();
    const externalError = Object.assign(new Error('MAX API rate limit exceeded'), {
      response: { status: 429, data: { message: 'MAX API rate limit exceeded' } },
    });
    const externalService = createService({
      request: jest.fn().mockReturnValue(throwError(() => externalError)),
    });
    const externalRedis = (externalService as any).limiterRedis;
    const externalDiagnostics = {
      recordProblemChat: jest.fn().mockResolvedValue(undefined),
    };
    (externalService as any).runtimeDiagnosticsService = externalDiagnostics;
    const externalWarn = jest.spyOn((externalService as any).logger, 'warn');

    await expect(externalService.getChatSnapshot('chat-external')).rejects.toBe(externalError);
    await expect(
      externalRedis.get(`maxapi:rate-limit:v1:external_429:777000_bot:interactive:${nowSec}`),
    ).resolves.toBe('1');
    expect(externalDiagnostics.recordProblemChat).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'max_api_external_429', statusCode: 429 }),
    );
    expect(externalWarn).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'external_429', statusCode: 429 }),
      'MAX API returned external HTTP 429',
    );
    await externalService.onModuleDestroy();
  });

  it('lets user-facing traffic classes borrow spare global headroom while capping background work', async () => {
    const service = createService(
      {},
      {
        MAX_API_GLOBAL_RPS: '30',
        MAX_API_GLOBAL_RPS_CRITICAL: '12',
        MAX_API_GLOBAL_RPS_INTERACTIVE: '10',
        MAX_API_GLOBAL_RPS_BACKGROUND: '4',
      },
    );

    expect((service as any).resolveTrafficClassEffectiveRpsLimit('critical')).toBe(16);
    expect((service as any).resolveTrafficClassEffectiveRpsLimit('interactive')).toBe(14);
    expect((service as any).resolveTrafficClassEffectiveRpsLimit('background')).toBe(4);

    await service.onModuleDestroy();
  });

  it('reuses Redis cache for bot chat discovery across service instances', async () => {
    const firstHttpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            chats: [
              {
                chat_id: 'chat-1',
                title: 'Chat 1',
                last_event_time: 1710000000000,
                type: 'chat',
                link: 'https://max.ru/chat-1',
              },
            ],
            marker: null,
          },
        }),
      ),
    };
    const firstService = createService(firstHttpService, {
      MAX_API_LIST_BOT_CHATS_CACHE_SEC: '15',
    });

    const firstResult = await firstService.listBotChats();

    const secondHttpService = {
      request: jest.fn(),
    };
    const secondService = createService(secondHttpService, {
      MAX_API_LIST_BOT_CHATS_CACHE_SEC: '15',
    });

    const secondResult = await secondService.listBotChats();

    expect(firstResult).toEqual(secondResult);
    expect(firstHttpService.request).toHaveBeenCalledTimes(1);
    expect(secondHttpService.request).not.toHaveBeenCalled();

    await firstService.onModuleDestroy();
    await secondService.onModuleDestroy();
  });

  it('paginates bot chat discovery beyond twenty pages', async () => {
    const request = jest.fn();
    for (let index = 0; index < 21; index += 1) {
      request.mockReturnValueOnce(
        of({
          status: 200,
          data: {
            chats: [
              {
                chat_id: `chat-${index + 1}`,
                title: `Chat ${index + 1}`,
                type: 'chat',
              },
            ],
            marker: index < 20 ? index + 1 : null,
          },
        }),
      );
    }
    const service = createService({ request });

    await expect(service.listBotChats({ bypassCache: true })).resolves.toEqual(
      Array.from({ length: 21 }, (_, index) => ({
        chatId: `chat-${index + 1}`,
        title: `Chat ${index + 1}`,
        lastEventTime: null,
        entityType: 'chat',
        link: null,
        avatarUrl: null,
        botId: '777000_bot',
        botIds: ['777000_bot'],
      })),
    );
    expect(request).toHaveBeenCalledTimes(21);

    await service.onModuleDestroy();
  });

  it('shares an in-flight bot chat discovery request for the same bot', async () => {
    let resolveResponse!: (value: { status: number; data: Record<string, unknown> }) => void;
    const response = new Promise<{ status: number; data: Record<string, unknown> }>((resolve) => {
      resolveResponse = resolve;
    });
    const request = jest.fn().mockReturnValue(from(response));
    const service = createService({ request });

    const first = service.listBotChats({ bypassCache: true });
    const second = service.listBotChats({ bypassCache: true });

    await new Promise((resolve) => setImmediate(resolve));
    expect(request).toHaveBeenCalledTimes(1);

    resolveResponse({
      status: 200,
      data: {
        chats: [
          {
            chat_id: 'chat-1',
            title: 'Chat 1',
            type: 'chat',
          },
        ],
        marker: null,
      },
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      [
        {
          chatId: 'chat-1',
          title: 'Chat 1',
          lastEventTime: null,
          entityType: 'chat',
          link: null,
          avatarUrl: null,
          botId: '777000_bot',
          botIds: ['777000_bot'],
        },
      ],
      [
        {
          chatId: 'chat-1',
          title: 'Chat 1',
          lastEventTime: null,
          entityType: 'chat',
          link: null,
          avatarUrl: null,
          botId: '777000_bot',
          botIds: ['777000_bot'],
        },
      ],
    ]);

    await service.onModuleDestroy();
  });

  it('blocks legacy bot chat discovery in production before limiter or HTTP calls', async () => {
    const httpService = {
      request: jest.fn(),
    };
    const service = createService(httpService, {
      NODE_ENV: 'production',
    });
    const limiterRedis = (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis;

    await expect(service.listBotChats({ bypassCache: true })).rejects.toThrow(
      'MAX API GET /chats is not supported in production',
    );

    expect(limiterRedis.eval).not.toHaveBeenCalled();
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('bypasses cached chat snapshot when explicitly requested', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              title: 'Chat 1',
              participants_count: 10,
              status: 'active',
              is_public: false,
              last_event_time: '2026-03-26T10:00:00.000Z',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              title: 'Chat 1 Updated',
              participants_count: 12,
              status: 'active',
              is_public: true,
              link: 'https://max.ru/chat-1',
              last_event_time: '2026-03-26T10:00:05.000Z',
            },
          }),
        ),
    };
    const service = createService(httpService, {
      MAX_API_CHAT_SNAPSHOT_CACHE_SEC: '10',
    });

    const firstSnapshot = await service.getChatSnapshot('chat-1');
    const cachedSnapshot = await service.getChatSnapshot('chat-1');
    const freshSnapshot = await service.getChatSnapshot('chat-1', { bypassCache: true });

    expect(firstSnapshot.title).toBe('Chat 1');
    expect(cachedSnapshot.title).toBe('Chat 1');
    expect(freshSnapshot.title).toBe('Chat 1 Updated');
    expect(httpService.request).toHaveBeenCalledTimes(2);

    await service.onModuleDestroy();
  });

  it('resolves channel snapshots by public chat link without listing bot chats', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            chat_id: 'channel-1',
            title: 'Новости MAX',
            participants_count: 10,
            status: 'active',
            is_public: true,
            link: 'https://max.ru/channels/news-max',
            type: 'channel',
          },
        }),
      ),
    };
    const service = createService(httpService);

    await expect(service.getChannelSnapshotByLink('news-max')).resolves.toEqual(
      expect.objectContaining({
        chatId: 'channel-1',
        title: 'Новости MAX',
        entityType: 'channel',
        link: 'https://max.ru/channels/news-max',
      }),
    );
    expect(httpService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'get',
        url: 'https://platform-api2.max.ru/chats/news-max',
      }),
    );

    await service.onModuleDestroy();
  });

  it('detects channel snapshots from public /channels links when MAX omits an explicit type', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            title: 'Новости MAX',
            participants_count: 10,
            status: 'active',
            is_public: true,
            link: 'https://max.ru/channels/news-max',
          },
        }),
      ),
    };
    const service = createService(httpService);

    await expect(service.getChatSnapshot('channel-1')).resolves.toEqual(
      expect.objectContaining({
        chatId: 'channel-1',
        title: 'Новости MAX',
        entityType: 'channel',
        link: 'https://max.ru/channels/news-max',
      }),
    );

    await service.onModuleDestroy();
  });

  it('detects private channel snapshots from is_channel when MAX omits type and link', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            title: 'Приватный канал',
            participants_count: 4,
            status: 'active',
            is_public: false,
            is_channel: true,
          },
        }),
      ),
    };
    const service = createService(httpService);

    await expect(service.getChatSnapshot('channel-private-1')).resolves.toEqual(
      expect.objectContaining({
        chatId: 'channel-private-1',
        title: 'Приватный канал',
        entityType: 'channel',
        isPublic: false,
        link: null,
      }),
    );

    await service.onModuleDestroy();
  });

  it('applies background MAX API rate limit to background snapshot reads', async () => {
    const httpService = {
      request: jest.fn(),
    };
    const service = createService(httpService, {
      MAX_API_GLOBAL_RPS: '30',
      MAX_API_GLOBAL_RPS_BACKGROUND: '2',
      MAX_API_RATE_LIMIT_WAIT_MS_BACKGROUND: '0',
    });

    const limiterRedis = (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis;
    limiterRedis.eval.mockResolvedValueOnce([1, 0, 0]).mockResolvedValueOnce([0, 2, 1]);

    await expect(service.getChatSnapshot('chat-1', { trafficClass: 'background' })).rejects.toThrow(
      'MAX API background rate limit exceeded',
    );
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('records source-level MAX API usage for tagged background reads', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-01T18:00:05.000Z'));

    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            title: 'Chat 1',
            participants_count: 10,
            status: 'active',
          },
        }),
      ),
    };
    const service = createService(httpService);
    const limiterRedis = (
      service as unknown as {
        limiterRedis: { get: jest.Mock; sadd: jest.Mock; smembers: jest.Mock };
      }
    ).limiterRedis;
    const nowSec = Math.floor(Date.now() / 1_000);

    await expect(
      service.getChatSnapshot('chat-1', {
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
      } as never),
    ).resolves.toEqual(
      expect.objectContaining({
        chatId: 'chat-1',
        title: 'Chat 1',
      }),
    );

    await expect(
      limiterRedis.get(`maxapi:rps:source:v1:777000_bot:background:managed_refresh:${nowSec}`),
    ).resolves.toBe('1');
    await expect(limiterRedis.smembers(MAX_API_SOURCE_DIMENSION_CATALOG_KEY)).resolves.toContain(
      serializeMaxApiSourceMetricDimension({
        botId: '777000_bot',
        trafficClass: 'background',
        sourceTag: 'managed_refresh',
      }),
    );
    expect(limiterRedis.sadd).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  describe('bounded asynchronous MAX usage metrics', () => {
    type UsageMetricsInternals = {
      logger: Pick<Logger, 'warn'>;
      recordRateLimitUsage(
        botId: string,
        trafficClass: 'critical' | 'interactive' | 'background',
        sourceTag?: string | null,
      ): Promise<void>;
      recordRateLimitUsageWithoutWaiting(
        botId: string,
        trafficClass: 'critical' | 'interactive' | 'background',
        sourceTag?: string | null,
      ): void;
    };

    it('bounds pending usage writes at 128 and accepts a new write only after settlement', async () => {
      const service = createService();
      const internal = service as unknown as UsageMetricsInternals;
      const completions: Array<() => void> = [];
      const writer = jest.spyOn(internal, 'recordRateLimitUsage').mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            completions.push(resolve);
          }),
      );
      const warn = jest.spyOn(internal.logger, 'warn').mockImplementation(() => undefined);
      const record = () =>
        internal.recordRateLimitUsageWithoutWaiting('777000_bot', 'background', 'managed_refresh');
      try {
        for (let index = 0; index < 128; index++) record();
        expect(writer).toHaveBeenCalledTimes(128);
        record();
        expect(writer).toHaveBeenCalledTimes(128);
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ pendingWrites: 128, droppedObservations: 1 }),
          'MAX API usage metrics incomplete under write pressure',
        );
        completions[0]!();
        await Promise.resolve();
        record();
        expect(writer).toHaveBeenCalledTimes(129);
        expect(writer).toHaveBeenLastCalledWith('777000_bot', 'background', 'managed_refresh');
      } finally {
        for (const complete of completions) complete();
        await Promise.resolve();
        await service.onModuleDestroy();
      }
    });

    it.each(['reject', 'throw'] as const)(
      'contains a usage writer %s without blocking subsequent observations',
      async (failure) => {
        const service = createService();
        const internal = service as unknown as UsageMetricsInternals;
        const error = new Error('usage metrics unavailable');
        const writer = jest
          .spyOn(internal, 'recordRateLimitUsage')
          .mockImplementationOnce(() => {
            if (failure === 'throw') throw error;
            return Promise.reject(error);
          })
          .mockResolvedValue(undefined);
        try {
          expect(() =>
            internal.recordRateLimitUsageWithoutWaiting('777000_bot', 'background'),
          ).not.toThrow();
          await Promise.resolve();
          internal.recordRateLimitUsageWithoutWaiting('777000_bot', 'background');
          expect(writer).toHaveBeenCalledTimes(2);
          await Promise.resolve();
        } finally {
          await service.onModuleDestroy();
        }
      },
    );
  });

  it('retries source dimension registration after a Redis transaction failure and then caches it', async () => {
    const service = createService({ request: jest.fn() });
    const internal = service as unknown as {
      limiterRedis: { sadd: jest.Mock };
      recordRateLimitUsage: (
        botId: string,
        trafficClass: 'background',
        sourceTag: string,
      ) => Promise<void>;
    };
    internal.limiterRedis.sadd.mockRejectedValueOnce(new Error('catalog unavailable'));

    await internal.recordRateLimitUsage('catalog-retry-bot', 'background', 'catalog_retry_source');
    await internal.recordRateLimitUsage('catalog-retry-bot', 'background', 'catalog_retry_source');
    await internal.recordRateLimitUsage('catalog-retry-bot', 'background', 'catalog_retry_source');

    expect(internal.limiterRedis.sadd).toHaveBeenCalledTimes(2);

    await service.onModuleDestroy();
  });

  it('writes minute counters once per event with exact fields, catalog atomicity and separate TTLs', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-01T18:00:05.000Z'));
    const service = createService(
      { request: jest.fn() },
      {
        APP_SERVICE_NAME: 'api-action',
        MAX_API_METRICS_STORAGE_LAYOUT: 'minute',
      },
    );
    const internal = service as unknown as {
      limiterRedis: {
        get: jest.Mock;
        hget: jest.Mock;
        pttl: jest.Mock;
        sadd: jest.Mock;
        multi: jest.Mock;
      };
      recordRateLimitUsage: (
        botId: string,
        trafficClass: 'background',
        sourceTag: string,
      ) => Promise<void>;
      recordRateLimitOutcome: (params: Record<string, unknown>) => Promise<void>;
    };
    const redis = internal.limiterRedis;
    const nowSec = Math.floor(Date.now() / 1_000);
    redis.sadd.mockRejectedValueOnce(new Error('catalog unavailable'));
    // A failed first transaction must not mark the process-local dimension registered.
    await internal.recordRateLimitUsage('minute-bot', 'background', 'managed_refresh');
    await internal.recordRateLimitUsage('minute-bot', 'background', 'managed_refresh');
    await internal.recordRateLimitUsage('minute-bot', 'background', 'managed_refresh');
    expect(redis.sadd).toHaveBeenCalledTimes(2);
    expect(redis.multi).toHaveBeenCalledTimes(3);
    for (const [stem, ttlSec] of [
      ['maxapi:rps:global:minute-bot', 21600],
      ['maxapi:rps:global:minute-bot:background', 21600],
      ['maxapi:rps:stack', 21600],
      ['maxapi:rps:stack:background', 21600],
      ['maxapi:rps:source:v1:minute-bot:background:managed_refresh', 21600],
      ['maxapi:rps:service:v1:api-action:bot:minute-bot:background', 120],
      ['maxapi:rps:service:v1:api-action:stack:background', 120],
    ] as const) {
      const legacyKey = `${stem}:${nowSec}`;
      const address = maxApiMinuteCounterAddress(legacyKey);
      if (ttlSec === 120) {
        await expect(redis.get(legacyKey)).resolves.toBe('2');
        await expect(redis.pttl(legacyKey)).resolves.toBe(120000);
        await expect(redis.hget(address.key, address.field)).resolves.toBeNull();
      } else {
        await expect(redis.get(legacyKey)).resolves.toBeNull();
        await expect(redis.hget(address.key, address.field)).resolves.toBe('2');
        await expect(redis.pttl(address.key)).resolves.toBe((ttlSec + 55) * 1000);
      }
    }
    await internal.recordRateLimitOutcome({
      origin: 'external_429',
      botId: 'minute-bot',
      chatId: null,
      trafficClass: 'background',
      reason: 'test',
    });
    const outcome = maxApiMinuteCounterAddress(
      `maxapi:rate-limit:v1:external_429:minute-bot:background:${nowSec}`,
    );
    await expect(redis.hget(outcome.key, outcome.field)).resolves.toBe('1');
    await expect(
      redis.get(`maxapi:rate-limit:v1:external_429:minute-bot:background:${nowSec}`),
    ).resolves.toBeNull();
    jest.setSystemTime(new Date('2026-04-01T18:00:59.000Z'));
    await internal.recordRateLimitUsage('minute-bot', 'background', 'managed_refresh');
    const serviceCounter = `maxapi:rps:service:v1:api-action:stack:background:${nowSec + 54}`;
    await expect(redis.pttl(serviceCounter)).resolves.toBe(120000);
    await service.onModuleDestroy();
  });

  it.each(['legacy', 'minute'])(
    'preserves the partial service TTL boundary second with %s layout',
    async (layout) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-04-01T18:00:05.900Z'));
      const service = createService(
        { request: jest.fn() },
        {
          APP_SERVICE_NAME: 'api-action',
          MAX_API_METRICS_STORAGE_LAYOUT: layout,
        },
      );
      const internal = service as unknown as {
        limiterRedis: { get: jest.Mock; pttl: jest.Mock };
        recordRateLimitUsage: (botId: string, trafficClass: 'background') => Promise<void>;
      };
      const nowSec = Math.floor(Date.now() / 1000);
      const key = `maxapi:rps:service:v1:api-action:stack:background:${nowSec}`;
      await internal.recordRateLimitUsage('partial-ttl-bot', 'background');
      jest.setSystemTime(new Date('2026-04-01T18:02:05.100Z'));
      await expect(internal.limiterRedis.get(key)).resolves.toBe('1');
      await expect(internal.limiterRedis.pttl(key)).resolves.toBe(800);
      jest.setSystemTime(new Date('2026-04-01T18:02:05.900Z'));
      await expect(internal.limiterRedis.get(key)).resolves.toBeNull();
      await service.onModuleDestroy();
    },
  );

  it('records shared usage once while isolating service-scoped class metrics', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-01T18:00:10.000Z'));

    const response = {
      status: 200,
      data: {
        title: 'Chat 1',
        participants_count: 10,
        status: 'active',
      },
    };
    const serviceA = createService(
      { request: jest.fn().mockReturnValueOnce(of(response)) },
      { APP_SERVICE_NAME: 'API Action / A' },
    );
    const serviceB = createService(
      { request: jest.fn().mockReturnValueOnce(of(response)) },
      { APP_SERVICE_NAME: 'API Action / B' },
    );
    const limiterRedis = (
      serviceA as unknown as { limiterRedis: { get: jest.Mock; pttl: jest.Mock } }
    ).limiterRedis;
    const nowSec = Math.floor(Date.now() / 1_000);

    await serviceA.getChatSnapshot('chat-a', { trafficClass: 'background' });
    await serviceB.getChatSnapshot('chat-b', { trafficClass: 'background' });

    await expect(limiterRedis.get(`maxapi:rps:global:777000_bot:${nowSec}`)).resolves.toBe('2');
    await expect(
      limiterRedis.get(`maxapi:rps:global:777000_bot:background:${nowSec}`),
    ).resolves.toBe('2');
    await expect(limiterRedis.get(`maxapi:rps:stack:${nowSec}`)).resolves.toBe('2');
    await expect(limiterRedis.get(`maxapi:rps:stack:background:${nowSec}`)).resolves.toBe('2');
    await expect(
      limiterRedis.get(`maxapi:rps:service:v1:api_action_a:bot:777000_bot:background:${nowSec}`),
    ).resolves.toBe('1');
    await expect(
      limiterRedis.get(`maxapi:rps:service:v1:api_action_b:bot:777000_bot:background:${nowSec}`),
    ).resolves.toBe('1');
    await expect(
      limiterRedis.get(`maxapi:rps:service:v1:api_action_a:stack:background:${nowSec}`),
    ).resolves.toBe('1');
    await expect(
      limiterRedis.get(`maxapi:rps:service:v1:api_action_b:stack:background:${nowSec}`),
    ).resolves.toBe('1');
    await expect(
      limiterRedis.pttl(`maxapi:rps:service:v1:api_action_a:stack:background:${nowSec}`),
    ).resolves.toBe(120_000);
    await expect(limiterRedis.pttl(`maxapi:rps:stack:background:${nowSec}`)).resolves.toBe(
      6 * 60 * 60 * 1_000,
    );

    await serviceA.onModuleDestroy();
    await serviceB.onModuleDestroy();
  });

  it.each([
    { label: 'omitted configuration', globalRps: '30', burst: undefined, expected: '29' },
    { label: 'explicit zero', globalRps: '30', burst: '0', expected: '0' },
    { label: 'fraction below one slot', globalRps: '30', burst: '0.9', expected: '0' },
    { label: 'fractional slots', globalRps: '30', burst: '7.9', expected: '7' },
    { label: 'negative fallback', globalRps: '30', burst: '-1', expected: '29' },
    { label: 'non-numeric fallback', globalRps: '30', burst: 'NaN', expected: '29' },
    { label: 'upper clamp', globalRps: '30', burst: '100', expected: '29' },
    { label: 'lower token quota', globalRps: '5', burst: '100', expected: '4' },
    { label: 'capped token quota', globalRps: '45', burst: '100', expected: '29' },
    { label: 'single-slot token quota', globalRps: '1', burst: undefined, expected: '0' },
  ])(
    'bounds token burst tolerance for $label without changing other dimensions',
    async ({ globalRps, burst, expected }) => {
      const service = createService(
        {},
        {
          MAX_API_GLOBAL_RPS: globalRps,
          MAX_API_GLOBAL_RPS_CRITICAL: '12',
          MAX_API_CHAT_RPS: '10',
          ...(burst === undefined ? {} : { MAX_API_GLOBAL_BURST: burst }),
        },
      );
      const runtime = service as unknown as {
        limiterRedis: { eval: jest.Mock };
        tryReserveRateLimitSlot(
          botId: string,
          chatId: string,
          trafficClass: 'critical',
          sourceTag: undefined,
          messageMutation: { operation: 'delete'; entityId: string },
        ): Promise<{ ok: boolean }>;
      };
      try {
        await runtime.tryReserveRateLimitSlot('777000_bot', 'chat-1', 'critical', undefined, {
          operation: 'delete',
          entityId: 'chat-1',
        });
        const call = runtime.limiterRedis.eval.mock.calls.at(-1) as unknown[];
        const { limits, burstToleranceSlots } = reservationDimensions(call);
        expect(limits).toEqual([String(Math.min(Number(globalRps), 30)), '12', '10', '2']);
        expect(burstToleranceSlots).toEqual([expected, '11', '9', '0']);
      } finally {
        await service.onModuleDestroy();
      }
    },
  );

  it('caps each token at 30 with only bot-scoped hard class and source dimensions', async () => {
    const service = createService(
      { request: jest.fn() },
      {
        APP_SERVICE_NAME: 'API Action / A',
        MAX_API_GLOBAL_RPS: '45',
      },
    );
    const limiterRedis = (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis;

    await (
      service as unknown as {
        tryReserveRateLimitSlot: (
          botId: string,
          chatId: string,
          trafficClass: 'background',
          sourceTag: string,
        ) => Promise<{ ok: boolean }>;
      }
    ).tryReserveRateLimitSlot(
      '777000_bot',
      'chat-1',
      'background',
      MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
    );

    const call = limiterRedis.eval.mock.calls.at(-1) as unknown[];
    const { keys, limits } = reservationDimensions(call);
    expect(keys).toEqual([
      'maxapi:gcra:v1:bot:777000_bot:all',
      'maxapi:gcra:v1:service:api_action_a:bot:777000_bot:class:background',
      'maxapi:gcra:v1:chat:777000_bot:chat-1',
      'maxapi:gcra:v1:service:api_action_a:source:777000_bot:managed_refresh',
    ]);
    expect(limits[0]).toBe('30');
    expect(limits.at(-1)).toBe('2');

    await service.onModuleDestroy();
  });

  it('defers retention immediately without a current quiet permit and does not call HTTP', async () => {
    const http = { request: jest.fn() };
    const service = createService(http, { MAX_API_RATE_LIMIT_WAIT_MS_BACKGROUND: '5000' });
    try {
      await expect(
        service.getChatSnapshot('chat-1', {
          trafficClass: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.MESSAGE_RETENTION,
        }),
      ).rejects.toMatchObject({
        code: 'MAX_API_INTERNAL_RATE_LIMIT',
        preDispatch: true,
        limitScope: 'retention_priority',
      });
      expect(http.request).not.toHaveBeenCalled();
      const redis = (
        service as unknown as {
          limiterRedis: { eval: jest.Mock; get(key: string): Promise<string | null> };
        }
      ).limiterRedis;
      expect(
        redis.eval.mock.calls.filter(([script]) =>
          String(script).includes('MAX_API_GCRA_RESERVE_V1'),
        ),
      ).toHaveLength(1);
      expect(await redis.get('maxapi:gcra:v1:bot:777000_bot:all')).toBeNull();
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('admits retention reads with a fresh permit while preserving its source budget', async () => {
    const at = Date.now();
    (
      Redis as unknown as { __store: Map<string, { value: string; expiresAtMs: number | null }> }
    ).__store.set(RETENTION_PRIORITY_PERMIT_KEY, {
      value: JSON.stringify({
        version: RETENTION_PRIORITY_VERSION,
        sampleStartedAtMs: String(at),
        validUntilMs: String(at + 1000),
      }),
      expiresAtMs: at + 1000,
    });
    const http = {
      request: jest
        .fn()
        .mockReturnValue(of({ status: 200, data: { title: 'Chat', participants_count: 10 } })),
    };
    const service = createService(http);
    try {
      await expect(
        service.getChatSnapshot('chat-1', {
          trafficClass: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.MESSAGE_RETENTION,
        }),
      ).resolves.toEqual(expect.objectContaining({ chatId: 'chat-1' }));
      expect(http.request).toHaveBeenCalledTimes(1);
      const redis = (
        service as unknown as { limiterRedis: { get(key: string): Promise<string | null> } }
      ).limiterRedis;
      expect(await redis.get(HIGHER_PRIORITY_ACTIVITY_KEY)).toBeNull();
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('keeps HTTP available when synchronous observational Redis MULTI fails', async () => {
    const http = {
      request: jest
        .fn()
        .mockReturnValue(of({ status: 200, data: { title: 'Chat', participants_count: 10 } })),
    };
    const service = createService(http);
    const redis = (service as unknown as { limiterRedis: Pick<Redis, 'multi' | 'get'> })
      .limiterRedis;
    jest.spyOn(redis, 'multi').mockImplementation(() => {
      throw new Error('Synthetic synchronous observation failure');
    });
    try {
      await expect(service.getChatSnapshot('chat-1')).resolves.toEqual(
        expect.objectContaining({ chatId: 'chat-1' }),
      );
      expect(http.request).toHaveBeenCalledTimes(1);
      expect(await redis.get(HIGHER_PRIORITY_ACTIVITY_UNAVAILABLE_KEY)).toBe(
        'http_traffic_unavailable',
      );
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('holds a non-retention HTTP lease through its response and releases it afterwards', async () => {
    let complete!: (value: {
      status: number;
      data: { title: string; participants_count: number };
    }) => void;
    const response = new Promise<{
      status: number;
      data: { title: string; participants_count: number };
    }>((resolve) => {
      complete = resolve;
    });
    const http = { request: jest.fn().mockReturnValue(from(response)) };
    const service = createService(http);
    const redis = (
      service as unknown as { limiterRedis: { get(key: string): Promise<string | null> } }
    ).limiterRedis;
    try {
      const read = service.getChatSnapshot('chat-1');
      for (let i = 0; i < 50 && !http.request.mock.calls.length; i++) await Promise.resolve();
      expect(http.request).toHaveBeenCalledTimes(1);
      expect(
        Object.keys(JSON.parse((await redis.get(HIGHER_PRIORITY_ACTIVITY_KEY)) ?? '{}')),
      ).toHaveLength(1);
      complete({ status: 200, data: { title: 'Chat', participants_count: 10 } });
      await read;
      expect(await redis.get(HIGHER_PRIORITY_ACTIVITY_KEY)).toBe('{}');
      expect(await redis.get(HIGHER_PRIORITY_ACTIVITY_UNAVAILABLE_KEY)).toBeNull();
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('returns HTTP before a slow lease release but waits for its acknowledgment at shutdown', async () => {
    const http = {
      request: jest
        .fn()
        .mockReturnValue(of({ status: 200, data: { title: 'Chat', participants_count: 10 } })),
    };
    const service = createService(http);
    const redis = (service as unknown as { limiterRedis: { zrem: jest.Mock; quit: jest.Mock } })
      .limiterRedis;
    let acknowledge!: (removed: number) => void;
    redis.zrem.mockReturnValueOnce(
      new Promise<number>((resolve) => {
        acknowledge = resolve;
      }),
    );
    let shutdown: Promise<void> | undefined;
    try {
      await expect(service.getChatSnapshot('chat-1')).resolves.toEqual(
        expect.objectContaining({ chatId: 'chat-1' }),
      );
      expect(redis.zrem).toHaveBeenCalledTimes(1);
      expect(redis.quit).not.toHaveBeenCalled();

      let stopped = false;
      shutdown = service.onModuleDestroy().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      expect(redis.quit).not.toHaveBeenCalled();

      acknowledge(1);
      await shutdown;
      expect(stopped).toBe(true);
      expect(redis.quit).toHaveBeenCalledTimes(1);
    } finally {
      acknowledge(1);
      await (shutdown ?? service.onModuleDestroy());
    }
  });

  it('adds a fleet-wide retention budget without sharing the normal token budget', async () => {
    const service = createService({ request: jest.fn() });
    const internal = service as unknown as {
      tryReserveRateLimitSlot(
        bot: string,
        chat: string,
        traffic: string,
        source: string,
        mutation: { operation: string; entityId: string },
      ): Promise<unknown>;
      limiterRedis: { eval: jest.Mock };
    };
    try {
      await internal.tryReserveRateLimitSlot(
        'bot',
        '-1',
        'background',
        MAX_API_SOURCE_TAGS.MESSAGE_RETENTION,
        { operation: 'delete', entityId: '-1' },
      );
      const call = internal.limiterRedis.eval.mock.calls.at(-1) as unknown[];
      const dimensions = reservationDimensions(call);
      const { keys } = dimensions;
      const limits = dimensions.limits.map(Number);
      expect(limits[keys.indexOf('maxapi:gcra:v1:source:message-retention:all')]).toBe(2);
      expect(limits[keys.indexOf('maxapi:gcra:v1:source:message-retention:chat:target:-1')]).toBe(
        1,
      );
      expect(keys).toContain('maxapi:gcra:v1:bot:bot:all');
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('applies the managed_refresh source budget before background reads consume the shared pool', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-01T18:01:05.000Z'));

    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              title: 'Chat 1',
              participants_count: 10,
              status: 'active',
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            status: 200,
            data: {
              title: 'Chat 1',
              participants_count: 10,
              status: 'active',
            },
          }),
        ),
    };
    const service = createService(httpService, {
      MAX_API_MANAGED_REFRESH_RPS: '1',
      MAX_API_RATE_LIMIT_WAIT_MS_BACKGROUND: '0',
    });

    await expect(
      service.getChatSnapshot('chat-1', {
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
      } as never),
    ).resolves.toEqual(expect.objectContaining({ chatId: 'chat-1' }));

    await expect(
      service.getChatSnapshot('chat-2', {
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_REFRESH,
      } as never),
    ).rejects.toThrow('MAX API managed_refresh source limit exceeded for bot 777000_bot');
    expect(httpService.request).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('preserves source-level MAX API usage tags for immediate dispatched mutations', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-01T18:00:25.000Z'));

    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: { success: true },
        }),
      ),
    };
    const service = createService(httpService);
    const limiterRedis = (service as unknown as { limiterRedis: { get: jest.Mock } }).limiterRedis;
    const nowSec = Math.floor(Date.now() / 1_000);

    await expect(
      service.deleteMessage('channel-1', 'mid-1', {
        immediate: true,
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
      }),
    ).resolves.toBeUndefined();

    await expect(
      limiterRedis.get(`maxapi:rps:source:v1:777000_bot:background:channel_auto_post:${nowSec}`),
    ).resolves.toBe('1');

    await service.onModuleDestroy();
  });

  it('can record admin MAX reads in a background action health lane while keeping interactive traffic class', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            title: 'Chat 1',
            participants_count: 10,
            status: 'active',
          },
        }),
      ),
    };
    const service = createService(httpService);
    const actionHealthService = (
      service as unknown as {
        actionHealthService: {
          recordSuccessForLane: jest.Mock;
          recordFailureForLane: jest.Mock;
        };
      }
    ).actionHealthService;

    await expect(
      service.getChatSnapshot('chat-1', {
        trafficClass: 'interactive',
        actionHealthLane: 'background',
      } as never),
    ).resolves.toEqual(
      expect.objectContaining({
        chatId: 'chat-1',
        title: 'Chat 1',
      }),
    );

    expect(actionHealthService.recordSuccessForLane).toHaveBeenCalledWith(
      'background',
      '777000_bot',
    );
    expect(actionHealthService.recordFailureForLane).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('preserves a background action health lane for mutations even when traffic stays critical', async () => {
    const httpService = {
      request: jest.fn().mockReturnValueOnce(
        of({
          status: 200,
          data: {
            message_id: 'mid-1',
          },
        }),
      ),
    };
    const service = createService(httpService);
    const actionHealthService = (
      service as unknown as {
        actionHealthService: {
          recordSuccessForLane: jest.Mock;
          recordFailureForLane: jest.Mock;
        };
      }
    ).actionHealthService;

    await expect(
      service.sendMessageImmediateWithId('chat-1', 'Фоновое сообщение', undefined, {
        actionHealthLane: 'background',
      } as never),
    ).resolves.toEqual(
      expect.objectContaining({
        messageId: 'mid-1',
      }),
    );

    expect(actionHealthService.recordSuccessForLane).toHaveBeenCalledWith(
      'background',
      '777000_bot',
    );
    expect(actionHealthService.recordFailureForLane).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('applies per-chat MAX API rate limit to profile lookups', async () => {
    const httpService = {
      request: jest.fn(),
    };
    const service = createService(httpService, {
      MAX_API_GLOBAL_RPS: '100',
      MAX_API_CHAT_RPS: '1',
      MAX_API_RATE_LIMIT_WAIT_MS_INTERACTIVE: '0',
    });

    const limiterRedis = (service as unknown as { limiterRedis: { eval: jest.Mock } }).limiterRedis;
    limiterRedis.eval.mockResolvedValueOnce([1, 0, 0]).mockResolvedValueOnce([0, 3, 1]);

    await expect(service.getChatMemberProfiles('chat-1', ['user-1'])).rejects.toThrow(
      'MAX API per-chat rate limit exceeded for bot 777000_bot chat chat-1',
    );
    expect(httpService.request).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('extends webhook subscriptions with churn update types', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              subscriptions: [
                {
                  url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
                  update_types: ['message_created', 'user_added', 'bot_started'],
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(of({ data: {} })),
    };
    const service = createService(httpService, {
      APP_BASE_URL: 'https://major-maksimov.ru',
      MAX_BOT_ID: '777000_bot',
      MAX_WEBHOOK_SECRET_PATH: 'secret-path',
      MAX_WEBHOOK_HEADER_SECRET: 'header-secret',
    });

    const result = await service.ensureWebhookSubscription([
      'message_created',
      'user_added',
      'user_removed',
      'bot_added',
      'bot_removed',
      'bot_started',
    ]);

    expect(result).toEqual({
      url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
      updateTypes: [
        'bot_added',
        'bot_removed',
        'bot_started',
        'message_created',
        'user_added',
        'user_removed',
      ],
    });
    expect(httpService.request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/subscriptions',
        data: {
          url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
          update_types: [
            'bot_added',
            'bot_removed',
            'bot_started',
            'message_created',
            'user_added',
            'user_removed',
          ],
          secret: 'header-secret',
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('upserts the exact webhook target when an existing URL has a trailing slash', async () => {
    const exactUrl = 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path';
    const updateTypes = ['message_created', 'message_callback'];
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              subscriptions: [
                {
                  url: `${exactUrl}/`,
                  update_types: updateTypes,
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(of({ data: {} })),
    };
    const service = createService(httpService, {
      APP_BASE_URL: 'https://major-maksimov.ru',
      MAX_BOT_ID: '777000_bot',
      MAX_WEBHOOK_SECRET_PATH: 'secret-path',
      MAX_WEBHOOK_HEADER_SECRET: 'header-secret',
    });

    expect(service.matchesConfiguredWebhookUrl(`${exactUrl}/`)).toBe(false);
    await expect(service.ensureWebhookSubscription(updateTypes)).resolves.toEqual({
      url: exactUrl,
      updateTypes: [...updateTypes].sort(),
    });

    expect(httpService.request).toHaveBeenCalledTimes(2);
    expect(httpService.request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/subscriptions',
        data: {
          url: exactUrl,
          update_types: [...updateTypes].sort(),
          secret: 'header-secret',
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('replaces webhook update types only when exact reconciliation is requested', async () => {
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              subscriptions: [
                {
                  url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
                  update_types: ['message_created', 'message_removed'],
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(of({ data: {} })),
    };
    const service = createService(httpService, {
      APP_BASE_URL: 'https://major-maksimov.ru',
      MAX_BOT_ID: '777000_bot',
      MAX_WEBHOOK_SECRET_PATH: 'secret-path',
      MAX_WEBHOOK_HEADER_SECRET: 'header-secret',
    });

    const result = await service.ensureWebhookSubscription(['message_created'], {
      replaceUpdateTypes: true,
    });

    expect(result).toEqual({
      url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
      updateTypes: ['message_created'],
    });
    expect(httpService.request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/subscriptions',
        data: {
          url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
          update_types: ['message_created'],
          secret: 'header-secret',
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('forces a webhook subscription POST upsert for secret rotation without deleting first', async () => {
    const updateTypes = ['message_created', 'bot_added'];
    const httpService = {
      request: jest
        .fn()
        .mockReturnValueOnce(
          of({
            data: {
              subscriptions: [
                {
                  url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
                  update_types: updateTypes,
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(of({ data: {} })),
    };
    const service = createService(httpService, {
      APP_BASE_URL: 'https://major-maksimov.ru',
      MAX_BOT_ID: '777000_bot',
      MAX_WEBHOOK_SECRET_PATH: 'secret-path',
      MAX_WEBHOOK_HEADER_SECRET: 'rotated-header-secret',
    });

    await service.ensureWebhookSubscription(updateTypes, { forceUpsert: true });

    expect(httpService.request).toHaveBeenCalledTimes(2);
    expect(httpService.request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        method: 'post',
        url: 'https://platform-api2.max.ru/subscriptions',
        data: expect.objectContaining({
          secret: 'header-secret',
        }),
      }),
    );

    await service.onModuleDestroy();
  });
});

describe('MaxClientService delayed member actions', () => {
  function createServiceWithQueue(
    queue: { add: jest.Mock; getJob: jest.Mock },
    actionLedgerService?: {
      assertCanEnqueue?: jest.Mock;
      recordEnqueuedIfAbsent?: jest.Mock;
      recordEnqueueFailedIfAbsent?: jest.Mock;
      recordEnqueueAmbiguousIfAbsent?: jest.Mock;
      hasExecutionEvidenceSince?: jest.Mock;
    },
    maxBotLinkService?: {
      resolveBotRoute?: jest.Mock;
    },
    laneQueues: Partial<
      Record<
        | typeof MAX_ACTION_CRITICAL_QUEUE
        | typeof MAX_ACTION_INTERACTIVE_QUEUE
        | typeof MAX_ACTION_BACKGROUND_QUEUE,
        { add: jest.Mock; getJob: jest.Mock }
      >
    > = {},
  ) {
    const configService = {
      getOrThrow: jest.fn((key: string) => {
        if (key === 'MAX_API_BASE_URL') {
          return 'https://platform-api2.max.ru';
        }
        if (key === 'MAX_BOT_TOKEN') {
          return 'test-token';
        }
        if (key === 'REDIS_URL') {
          return 'redis://localhost:6379/0';
        }
        throw new Error(`Unexpected key ${key}`);
      }),
      get: jest.fn((_key: string, fallback?: unknown) => fallback),
    };
    const actionHealthService = {
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
      getSnapshot: jest.fn(),
    };
    const botRegistry = {
      getDefaultBot: jest.fn().mockReturnValue({
        id: '777000_bot',
        token: 'test-token',
        webhookSecretPath: 'secret-path',
        webhookHeaderSecret: 'header-secret',
        webhookUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
        maskedWebhookUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/***',
      }),
      getBotById: jest.fn((botId?: string | null) =>
        !botId || botId === '777000_bot'
          ? {
              id: '777000_bot',
              token: 'test-token',
              webhookSecretPath: 'secret-path',
              webhookHeaderSecret: 'header-secret',
              webhookUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
              maskedWebhookUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/***',
            }
          : null,
      ),
      getConfiguredWebhookSubscriptionTarget: jest.fn(() => ({
        url: 'https://major-maksimov.ru/api/webhook/max/777000_bot/secret-path',
        maskedUrl: 'https://major-maksimov.ru/api/webhook/max/777000_bot/***',
      })),
    };
    const botContext = {
      getActiveBotId: jest.fn().mockReturnValue(null),
      runWithBot: jest.fn((_botId: string, callback: () => unknown) => callback()),
    };

    return new MaxClientService(
      {} as never,
      configService as never,
      actionHealthService as never,
      botRegistry as never,
      botContext as never,
      queue as never,
      undefined,
      actionLedgerService as never,
      maxBotLinkService as never,
      laneQueues[MAX_ACTION_CRITICAL_QUEUE] as never,
      laneQueues[MAX_ACTION_INTERACTIVE_QUEUE] as never,
      laneQueues[MAX_ACTION_BACKGROUND_QUEUE] as never,
    );
  }

  function createCollapsingQueue() {
    const jobsById = new Map<string, unknown>();
    return {
      jobsById,
      queue: {
        add: jest.fn().mockImplementation(async (_name: string, job: unknown, options: unknown) => {
          const jobId = (options as { jobId?: string }).jobId;
          if (jobId && !jobsById.has(jobId)) {
            jobsById.set(jobId, job);
          }
          return { id: jobId };
        }),
        getJob: jest.fn().mockResolvedValue(null),
      },
    };
  }

  it('routes queued actions into physical traffic lanes while keeping legacy as fallback', async () => {
    const createQueue = () => ({
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    });
    const legacy = createQueue();
    const critical = createQueue();
    const interactive = createQueue();
    const background = createQueue();
    const service = createServiceWithQueue(legacy, undefined, undefined, {
      [MAX_ACTION_CRITICAL_QUEUE]: critical,
      [MAX_ACTION_INTERACTIVE_QUEUE]: interactive,
      [MAX_ACTION_BACKGROUND_QUEUE]: background,
    });

    await service.sendMessage('chat-1', 'interactive notice');
    await service.deleteMessage('chat-1', 'message-1');
    await service.sendMessage('chat-1', 'background notice', undefined, {
      trafficClass: 'background',
    });

    expect(interactive.add).toHaveBeenCalledWith(
      'execute-max-action',
      expect.objectContaining({ actionType: 'SEND_MESSAGE', text: 'interactive notice' }),
      expect.any(Object),
    );
    expect(critical.add).toHaveBeenCalledWith(
      'execute-max-action',
      expect.objectContaining({ actionType: 'DELETE_MESSAGE', messageId: 'message-1' }),
      expect.any(Object),
    );
    expect(background.add).toHaveBeenCalledWith(
      'execute-max-action',
      expect.objectContaining({
        actionType: 'SEND_MESSAGE',
        text: 'background notice',
        trafficClass: 'background',
      }),
      expect.any(Object),
    );
    expect(legacy.add).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('dispatches queued delete actions with the active bot context when botId is omitted', async () => {
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const configService = {
      getOrThrow: jest.fn((key: string) => {
        if (key === 'MAX_API_BASE_URL') {
          return 'https://platform-api2.max.ru';
        }
        if (key === 'MAX_BOT_TOKEN') {
          return 'test-token';
        }
        if (key === 'REDIS_URL') {
          return 'redis://localhost:6379/0';
        }
        throw new Error(`Unexpected key ${key}`);
      }),
      get: jest.fn((_key: string, fallback?: unknown) => fallback),
    };
    const actionHealthService = {
      recordSuccess: jest.fn(),
      recordFailure: jest.fn(),
      getSnapshot: jest.fn(),
    };
    const botRegistry = {
      getDefaultBot: jest.fn().mockReturnValue({
        id: 'id613002203036_bot',
        token: 'default-token',
        webhookSecretPath: 'default-secret',
        webhookHeaderSecret: 'default-header-secret',
        webhookUrl: 'https://major-maksimov.ru/api/webhook/max/id613002203036_bot/default-secret',
        maskedWebhookUrl: 'https://major-maksimov.ru/api/webhook/max/id613002203036_bot/***',
      }),
      getBotById: jest.fn((botId?: string | null) => {
        if (!botId || botId === 'id613002203036_bot') {
          return {
            id: 'id613002203036_bot',
            token: 'default-token',
            webhookSecretPath: 'default-secret',
            webhookHeaderSecret: 'default-header-secret',
            webhookUrl:
              'https://major-maksimov.ru/api/webhook/max/id613002203036_bot/default-secret',
            maskedWebhookUrl: 'https://major-maksimov.ru/api/webhook/max/id613002203036_bot/***',
          };
        }

        if (botId === 'id613002203036_4_bot') {
          return {
            id: 'id613002203036_4_bot',
            token: 'secondary-token',
            webhookSecretPath: 'secondary-secret',
            webhookHeaderSecret: 'secondary-header-secret',
            webhookUrl:
              'https://major-maksimov.ru/api/webhook/max/id613002203036_4_bot/secondary-secret',
            maskedWebhookUrl: 'https://major-maksimov.ru/api/webhook/max/id613002203036_4_bot/***',
          };
        }

        return null;
      }),
      getConfiguredWebhookSubscriptionTarget: jest.fn(() => ({
        url: 'https://major-maksimov.ru/api/webhook/max/id613002203036_bot/default-secret',
        maskedUrl: 'https://major-maksimov.ru/api/webhook/max/id613002203036_bot/***',
      })),
    };
    const botContext = {
      getActiveBotId: jest.fn().mockReturnValue('id613002203036_4_bot'),
      runWithBot: jest.fn((_botId: string, callback: () => unknown) => callback()),
    };
    const service = new MaxClientService(
      {} as never,
      configService as never,
      actionHealthService as never,
      botRegistry as never,
      botContext as never,
      queue as never,
    );

    await service.deleteMessage('-72881707399277', 'mid-delete-1');

    expect(queue.add).toHaveBeenCalledWith(
      'execute-max-action',
      expect.objectContaining({
        actionType: 'DELETE_MESSAGE',
        chatId: '-72881707399277',
        messageId: 'mid-delete-1',
        botId: 'id613002203036_4_bot',
      }),
      expect.objectContaining({
        attempts: 5,
        removeOnComplete: true,
        removeOnFail: {
          age: 7 * 24 * 60 * 60,
          count: 1_000,
        },
      }),
    );

    await service.onModuleDestroy();
  });

  it('uses caller-provided idempotency keys as stable BullMQ job ids', async () => {
    const { jobsById, queue } = createCollapsingQueue();
    const service = createServiceWithQueue(queue);

    await service.sendMessage('chat-1', 'first notice', undefined, {
      idempotencyKey: ' moderation:notice:chat-1:user-1 ',
    });
    await service.sendMessage('chat-1', 'second notice', undefined, {
      idempotencyKey: 'moderation:notice:chat-1:user-1',
    });

    const firstJobId = queue.add.mock.calls[0][2].jobId;
    const secondJobId = queue.add.mock.calls[1][2].jobId;

    expect(firstJobId).toBe(secondJobId);
    expect(firstJobId).toMatch(/^max-action__explicit__/);
    expect(firstJobId).not.toContain(':');
    expect(jobsById.size).toBe(1);
    expect([...jobsById.values()][0]).toEqual(
      expect.objectContaining({
        actionType: 'SEND_MESSAGE',
        text: 'first notice',
        idempotencyKey: firstJobId,
      }),
    );

    await service.onModuleDestroy();
  });

  it('keeps routed job ids logical and carries route candidates into BullMQ', async () => {
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const service = createServiceWithQueue(queue);

    await service.sendMessage('chat-1', 'notice', undefined, {
      botId: '777000_bot',
      candidateBotIds: ['777000_bot', 'standby-bot'],
      routing: {
        purpose: 'send_message',
        primaryBotId: '777000_bot',
        reason: 'primary_confirmed',
        routingVersion: 7,
      },
      idempotencyKey: 'publication:occurrence-1:chat-1',
    });

    const queuedJob = queue.add.mock.calls[0][1];
    expect(queuedJob).toEqual(
      expect.objectContaining({
        botId: '777000_bot',
        candidateBotIds: ['777000_bot', 'standby-bot'],
        routing: expect.objectContaining({
          purpose: 'send_message',
          routingVersion: 7,
        }),
      }),
    );
    expect(queuedJob.idempotencyKey).toMatch(/^max-action__explicit__send_message__/);
    expect(queuedJob.idempotencyKey).not.toContain('777000_bot');

    await service.onModuleDestroy();
  });

  it('resolves managed-chat route candidates when callers do not bind a bot', async () => {
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: '-100-chat-1',
        primaryBotId: '777000_bot',
        botId: '777000_bot',
        candidateBotIds: ['777000_bot', 'standby-bot'],
        reason: 'primary_confirmed',
      }),
    };
    const service = createServiceWithQueue(queue, undefined, maxBotLinkService);

    await service.sendMessage('-100-chat-1', 'notice', undefined, {
      idempotencyKey: 'publication:occurrence-1:chat-1',
    });

    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledWith({
      purpose: 'send_message',
      chatId: '-100-chat-1',
      fallbackToPrimary: true,
    });
    expect(queue.add.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        botId: '777000_bot',
        candidateBotIds: ['777000_bot', 'standby-bot'],
        routing: expect.objectContaining({ purpose: 'send_message' }),
      }),
    );

    await service.onModuleDestroy();
  });

  it('fails closed when a managed group route resolves without an eligible bot', async () => {
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: '-100-chat-without-route',
        primaryBotId: null,
        botId: null,
        candidateBotIds: [],
        reason: null,
        routingVersion: 3,
      }),
    };
    const service = createServiceWithQueue(queue, undefined, maxBotLinkService);

    await expect(
      service.sendMessage('-100-chat-without-route', 'must not use default'),
    ).rejects.toThrow('has no eligible routed bot candidate');

    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledTimes(1);
    expect(queue.add).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('fails closed without default-bot fallback when managed route resolution throws', async () => {
    const routeError = new Error('managed route lookup timed out');
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockRejectedValue(routeError),
    };
    const service = createServiceWithQueue(queue, undefined, maxBotLinkService);
    const getDefaultBot = (service as any).botRegistry.getDefaultBot as jest.Mock;
    getDefaultBot.mockClear();

    await expect(service.sendMessage('-100-route-error', 'must retry routing')).rejects.toBe(
      routeError,
    );

    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledTimes(1);
    expect(queue.add).not.toHaveBeenCalled();
    expect(getDefaultBot).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('keeps private dialog sends on their explicit bot context instead of managed routing', async () => {
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn(),
    };
    const service = createServiceWithQueue(queue, undefined, maxBotLinkService);

    await service.sendMessage('123456789', 'private notice');

    expect(maxBotLinkService.resolveBotRoute).not.toHaveBeenCalled();
    expect(queue.add.mock.calls[0][1]).toEqual(
      expect.not.objectContaining({
        routing: expect.anything(),
        candidateBotIds: expect.anything(),
      }),
    );

    await service.onModuleDestroy();
  });

  it('dedupes delete and ban state while assigning a fresh id to each kick episode', async () => {
    const { jobsById, queue } = createCollapsingQueue();
    const service = createServiceWithQueue(queue);

    await service.deleteMessage('chat-1', 'mid-1');
    await service.deleteMessage('chat-1', 'mid-1');
    await service.kickMember('chat-1', 'user-1');
    await service.kickMember('chat-1', 'user-1');
    await service.banMember('chat-1', 'user-1');

    const deleteJobId = queue.add.mock.calls[0][2].jobId;
    const duplicateDeleteJobId = queue.add.mock.calls[1][2].jobId;
    const kickJobId = queue.add.mock.calls[2][2].jobId;
    const duplicateKickJobId = queue.add.mock.calls[3][2].jobId;
    const banJobId = queue.add.mock.calls[4][2].jobId;

    expect(duplicateDeleteJobId).toBe(deleteJobId);
    expect(duplicateKickJobId).not.toBe(kickJobId);
    expect(deleteJobId).toMatch(/^max-action__logical__/);
    expect(kickJobId).not.toMatch(/^max-action__logical__/);
    expect(duplicateKickJobId).not.toMatch(/^max-action__logical__/);
    expect(banJobId).toMatch(/^max-action__logical__/);
    expect(new Set([deleteJobId, kickJobId, duplicateKickJobId, banJobId]).size).toBe(4);
    expect(jobsById.size).toBe(4);

    await service.onModuleDestroy();
  });

  it('records queued actions only after BullMQ accepts the job', async () => {
    const bullMqCreatedAt = Date.parse('2026-07-16T12:00:00.000Z');
    const queue = {
      add: jest.fn().mockResolvedValue({ timestamp: bullMqCreatedAt }),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const actionLedgerService = {
      assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
      recordEnqueuedIfAbsent: jest.fn().mockResolvedValue(undefined),
      recordEnqueueFailedIfAbsent: jest.fn().mockResolvedValue(undefined),
      hasExecutionEvidenceSince: jest.fn().mockResolvedValue(false),
    };
    const service = createServiceWithQueue(queue, actionLedgerService);

    await service.banMember('chat-1', 'user-1', {
      botId: '777000_bot',
      sourceTag: 'interactive',
    });

    const job = queue.add.mock.calls[0][1];
    expect(actionLedgerService.assertCanEnqueue).toHaveBeenCalledWith(job);
    expect(actionLedgerService.recordEnqueuedIfAbsent).toHaveBeenCalledWith(
      job,
      new Date(bullMqCreatedAt),
    );
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.invocationCallOrder[0]).toBeLessThan(
      actionLedgerService.recordEnqueuedIfAbsent.mock.invocationCallOrder[0],
    );
    expect(actionLedgerService.recordEnqueueFailedIfAbsent).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('keeps an accepted BullMQ action when create-only ledger bookkeeping fails', async () => {
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const actionLedgerService = {
      assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
      recordEnqueuedIfAbsent: jest.fn().mockRejectedValue(new Error('database unavailable')),
      recordEnqueueFailedIfAbsent: jest.fn().mockResolvedValue(undefined),
      hasExecutionEvidenceSince: jest.fn().mockResolvedValue(false),
    };
    const service = createServiceWithQueue(queue, actionLedgerService);

    await expect(service.banMember('chat-1', 'user-1')).resolves.toBeUndefined();

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(actionLedgerService.recordEnqueuedIfAbsent).toHaveBeenCalledWith(
      queue.add.mock.calls[0][1],
      undefined,
    );
    expect(actionLedgerService.recordEnqueueFailedIfAbsent).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('does not enqueue actions blocked by a durable ambiguous ledger entry', async () => {
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const actionLedgerService = {
      assertCanEnqueue: jest.fn().mockRejectedValue(new UnrecoverableError('manual review')),
      recordEnqueuedIfAbsent: jest.fn().mockResolvedValue(undefined),
      recordEnqueueFailedIfAbsent: jest.fn().mockResolvedValue(undefined),
      hasExecutionEvidenceSince: jest.fn().mockResolvedValue(false),
    };
    const service = createServiceWithQueue(queue, actionLedgerService);

    await expect(service.banMember('chat-1', 'user-1')).rejects.toBeInstanceOf(UnrecoverableError);

    expect(queue.getJob).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
    expect(actionLedgerService.recordEnqueuedIfAbsent).not.toHaveBeenCalled();
    expect(actionLedgerService.recordEnqueueFailedIfAbsent).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('records queue add failures in the durable ledger', async () => {
    const error = new Error('redis is unavailable');
    const queue = {
      add: jest.fn().mockRejectedValue(error),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const actionLedgerService = {
      assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
      recordEnqueuedIfAbsent: jest.fn().mockResolvedValue(undefined),
      recordEnqueueFailedIfAbsent: jest.fn().mockResolvedValue(undefined),
      hasExecutionEvidenceSince: jest.fn().mockResolvedValue(false),
    };
    const service = createServiceWithQueue(queue, actionLedgerService);

    await expect(service.banMember('chat-1', 'user-1')).rejects.toBe(error);

    const job = queue.add.mock.calls[0][1];
    expect(actionLedgerService.recordEnqueuedIfAbsent).not.toHaveBeenCalled();
    expect(actionLedgerService.recordEnqueueFailedIfAbsent).toHaveBeenCalledWith(job, error);

    await service.onModuleDestroy();
  });

  it('recovers an ambiguous BullMQ add when the deterministic job is retained', async () => {
    const error = new Error('redis reply lost');
    const bullMqCreatedAt = Date.parse('2026-07-16T12:00:00.000Z');
    const retainedJob = {
      id: 'retained-job',
      timestamp: bullMqCreatedAt,
      getState: jest.fn().mockResolvedValue('waiting'),
    };
    const queue = {
      add: jest.fn().mockRejectedValue(error),
      getJob: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(retainedJob),
    };
    const actionLedgerService = {
      assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
      recordEnqueuedIfAbsent: jest.fn().mockResolvedValue(undefined),
      recordEnqueueFailedIfAbsent: jest.fn().mockResolvedValue(undefined),
      hasExecutionEvidenceSince: jest.fn().mockResolvedValue(false),
    };
    const service = createServiceWithQueue(queue, actionLedgerService);

    await expect(service.banMember('chat-1', 'user-1')).resolves.toBeUndefined();

    const job = queue.add.mock.calls[0][1];
    expect(queue.getJob).toHaveBeenLastCalledWith(job.idempotencyKey);
    expect(actionLedgerService.hasExecutionEvidenceSince).not.toHaveBeenCalled();
    expect(actionLedgerService.recordEnqueueFailedIfAbsent).not.toHaveBeenCalled();
    expect(actionLedgerService.recordEnqueuedIfAbsent).toHaveBeenCalledWith(
      job,
      new Date(bullMqCreatedAt),
    );

    await service.onModuleDestroy();
  });

  it('recovers an ambiguous BullMQ add when a fast worker already recorded execution', async () => {
    const error = new Error('redis reply lost after completion');
    const queue = {
      add: jest.fn().mockRejectedValue(error),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const actionLedgerService = {
      assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
      recordEnqueuedIfAbsent: jest.fn().mockResolvedValue(undefined),
      recordEnqueueFailedIfAbsent: jest.fn().mockResolvedValue(undefined),
      hasExecutionEvidenceSince: jest.fn().mockResolvedValue(true),
    };
    const service = createServiceWithQueue(queue, actionLedgerService);

    await expect(service.banMember('chat-1', 'user-1')).resolves.toBeUndefined();

    const job = queue.add.mock.calls[0][1];
    expect(actionLedgerService.hasExecutionEvidenceSince).toHaveBeenCalledWith(
      job.idempotencyKey,
      expect.any(Date),
    );
    expect(actionLedgerService.recordEnqueueFailedIfAbsent).not.toHaveBeenCalled();
    expect(actionLedgerService.recordEnqueuedIfAbsent).toHaveBeenCalledWith(job, undefined);

    await service.onModuleDestroy();
  });

  it('retries the same job id when BullMQ ownership lookup is unavailable', async () => {
    const error = new Error('redis response was lost');
    const queue = {
      add: jest.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(undefined),
      getJob: jest
        .fn()
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error('redis lookup unavailable')),
    };
    const actionLedgerService = {
      assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
      recordEnqueuedIfAbsent: jest.fn().mockResolvedValue(undefined),
      recordEnqueueFailedIfAbsent: jest.fn().mockResolvedValue(undefined),
      recordEnqueueAmbiguousIfAbsent: jest.fn().mockResolvedValue(undefined),
      hasExecutionEvidenceSince: jest.fn().mockResolvedValue(false),
    };
    const service = createServiceWithQueue(queue, actionLedgerService);

    await expect(service.banMember('chat-1', 'user-1')).resolves.toBeUndefined();

    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add.mock.calls[0][2].jobId).toBe(queue.add.mock.calls[1][2].jobId);
    expect(actionLedgerService.recordEnqueueFailedIfAbsent).not.toHaveBeenCalled();
    expect(actionLedgerService.recordEnqueuedIfAbsent).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('quarantines SEND_MESSAGE when both add attempts and ownership lookup are ambiguous', async () => {
    const error = new Error('redis response was lost');
    const queue = {
      add: jest.fn().mockRejectedValue(error),
      getJob: jest.fn().mockRejectedValue(new Error('redis lookup unavailable')),
    };
    const actionLedgerService = {
      assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
      recordEnqueuedIfAbsent: jest.fn().mockResolvedValue(undefined),
      recordEnqueueFailedIfAbsent: jest.fn().mockResolvedValue(undefined),
      recordEnqueueAmbiguousIfAbsent: jest.fn().mockResolvedValue(undefined),
      hasExecutionEvidenceSince: jest.fn().mockResolvedValue(false),
    };
    const service = createServiceWithQueue(queue, actionLedgerService);

    await expect(service.sendMessage('chat-1', 'notice')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    expect(queue.add).toHaveBeenCalledTimes(2);
    expect(queue.add.mock.calls[0][2].jobId).toBe(queue.add.mock.calls[1][2].jobId);
    expect(actionLedgerService.recordEnqueueAmbiguousIfAbsent).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: 'SEND_MESSAGE' }),
      expect.any(UnrecoverableError),
    );
    expect(actionLedgerService.recordEnqueueFailedIfAbsent).not.toHaveBeenCalled();
    expect(actionLedgerService.recordEnqueuedIfAbsent).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('does not accept a retained final job without fresh execution evidence', async () => {
    const error = new Error('redis add failed');
    const retainedJob = {
      getState: jest.fn().mockResolvedValue('failed'),
    };
    const queue = {
      add: jest.fn().mockRejectedValue(error),
      getJob: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(retainedJob),
    };
    const actionLedgerService = {
      assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
      recordEnqueuedIfAbsent: jest.fn().mockResolvedValue(undefined),
      recordEnqueueFailedIfAbsent: jest.fn().mockResolvedValue(undefined),
      hasExecutionEvidenceSince: jest.fn().mockResolvedValue(false),
    };
    const service = createServiceWithQueue(queue, actionLedgerService);

    await expect(service.banMember('chat-1', 'user-1')).rejects.toBe(error);

    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(actionLedgerService.recordEnqueueFailedIfAbsent).toHaveBeenCalledWith(
      expect.any(Object),
      error,
    );
    expect(actionLedgerService.recordEnqueuedIfAbsent).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('replaces retained failed logical jobs so repair retries are not swallowed', async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    const failedJob = {
      getState: jest.fn().mockResolvedValue('failed'),
      remove,
    };
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(failedJob),
    };
    const service = createServiceWithQueue(queue);

    await service.deleteMessage('chat-1', 'mid-1');
    const firstJobId = queue.add.mock.calls[0][2].jobId;
    await service.deleteMessage('chat-1', 'mid-1');

    expect(queue.getJob).toHaveBeenNthCalledWith(2, firstJobId);
    expect(failedJob.getState).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[1][2].jobId).toBe(firstJobId);

    await service.onModuleDestroy();
  });

  it('does not replace retained ambiguous irreversible action jobs', async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    const failedJob = {
      data: {
        actionType: 'BAN_MEMBER',
      },
      failedReason: 'Ambiguous MAX BAN_MEMBER transport failure for chat chat-1 user user-1',
      getState: jest.fn().mockResolvedValue('failed'),
      remove,
    };
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(failedJob),
    };
    const service = createServiceWithQueue(queue);

    await expect(service.banMember('chat-1', 'user-1')).rejects.toBeInstanceOf(UnrecoverableError);

    expect(queue.getJob).toHaveBeenCalledTimes(1);
    expect(failedJob.getState).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('keeps an existing logical job on the legacy drain queue during lane rollout', async () => {
    const retainedJob = {
      getState: jest.fn().mockResolvedValue('waiting'),
      remove: jest.fn(),
    };
    const legacy = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(retainedJob),
    };
    const interactive = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const service = createServiceWithQueue(legacy, undefined, undefined, {
      [MAX_ACTION_INTERACTIVE_QUEUE]: interactive,
    });

    await service.sendMessage('chat-1', 'same logical notice', undefined, {
      idempotencyKey: 'notice-1',
    });

    expect(retainedJob.getState).toHaveBeenCalledTimes(1);
    expect(legacy.add).toHaveBeenCalledTimes(1);
    expect(interactive.add).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('uses deterministic queue job id for delayed unban', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-16T12:00:00.000Z'));
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const service = createServiceWithQueue(queue);
    const expectedJobId = 'member-action__777000_bot__UNBAN_MEMBER__chat-1__user-1';

    await service.unbanMember('chat-1', 'user-1', {
      delayMs: 60_000,
      idempotencyKey: 'manual-unban:user-1',
    });

    expect(queue.getJob).toHaveBeenCalledWith(expectedJobId);
    expect(queue.add).toHaveBeenCalledWith(
      'execute-max-action',
      expect.objectContaining({
        actionType: 'UNBAN_MEMBER',
        chatId: 'chat-1',
        userId: 'user-1',
        idempotencyKey: expectedJobId,
        createdAt: '2026-07-16T12:00:00.000Z',
        scheduledFor: '2026-07-16T12:01:00.000Z',
      }),
      expect.objectContaining({
        jobId: expectedJobId,
        delay: 60_000,
        removeOnComplete: true,
        removeOnFail: {
          age: 7 * 24 * 60 * 60,
          count: 1_000,
        },
      }),
    );
    expect(expectedJobId.includes(':')).toBe(false);

    await service.onModuleDestroy();
  });

  it('uses bot-independent delayed unban ids for routed jobs', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-28T00:00:00Z'));
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'moderation_action',
        chatId: '-100-chat-1',
        primaryBotId: '777000_bot',
        botId: '777000_bot',
        candidateBotIds: ['777000_bot', 'standby-bot'],
        reason: 'primary_confirmed',
        action: 'moderate_member',
      }),
    };
    const service = createServiceWithQueue(queue, undefined, maxBotLinkService);

    await service.unbanMember('-100-chat-1', 'user-1', { delayMs: 60_000 });

    expect(queue.add).toHaveBeenCalledWith(
      'execute-max-action',
      expect.objectContaining({
        candidateBotIds: ['777000_bot', 'standby-bot'],
        idempotencyKey: 'member-action__logical__UNBAN_MEMBER__-100-chat-1__user-1',
      }),
      expect.objectContaining({
        jobId: 'member-action__logical__UNBAN_MEMBER__-100-chat-1__user-1',
      }),
    );

    await service.onModuleDestroy();
  });

  it('removes queued delayed unban when cancelling manual override', async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    const queue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValueOnce({ remove }).mockResolvedValueOnce(null),
    };
    const service = createServiceWithQueue(queue);

    await service.cancelScheduledUnban('chat-1', 'user-2');

    expect(queue.getJob).toHaveBeenCalledWith(
      'member-action__777000_bot__UNBAN_MEMBER__chat-1__user-2',
    );
    expect(queue.getJob).toHaveBeenCalledWith(
      'member-action__logical__UNBAN_MEMBER__chat-1__user-2',
    );
    expect(remove).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('removes a delayed unban found in a split action lane', async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    const legacy = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const critical = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValueOnce({ remove }).mockResolvedValueOnce(null),
    };
    const service = createServiceWithQueue(legacy, undefined, undefined, {
      [MAX_ACTION_CRITICAL_QUEUE]: critical,
    });

    await service.cancelScheduledUnban('chat-1', 'user-3');

    expect(critical.getJob).toHaveBeenCalledTimes(2);
    expect(remove).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });
});
