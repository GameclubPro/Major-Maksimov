import type { MaxUpdate } from '@maxim/contracts';
import { randomUUID } from 'node:crypto';
import { readWebhookEventTimestamp } from '../webhook/webhook-semantic-event-key';
import {
  buildGroupCommandKey,
  type GroupCommandPermit,
  type GroupCommandResult,
} from './group-command-authority.service';

export function createGroupCommandPermitFixture(
  params: Partial<GroupCommandPermit> = {},
): GroupCommandPermit {
  const chatId = params.chatId ?? 'chat-1';
  const messageId = params.messageId ?? 'command-1';
  return {
    claimId: 'command-claim-1',
    semanticKey: buildGroupCommandKey(chatId, messageId),
    webhookEventId: 'receipt-1',
    executionBotId: 'bot-1',
    leaseToken: 'lease-1',
    sourceAt: new Date('2026-03-09T10:00:00.000Z'),
    result: null,
    chatId,
    messageId,
    ...params,
  };
}

export function createGroupCommandAuthorityMock() {
  const records = new Map<
    string,
    { permit: GroupCommandPermit; leased: boolean; completed: boolean }
  >();
  const authority = {
    observeStart: jest.fn().mockResolvedValue(undefined),
    inspectLegacyStart: jest.fn().mockResolvedValue('fresh'),
    claim: jest.fn(async (update: MaxUpdate, executionBotId: string) => {
      const chatId = update.message!.chatId;
      const messageId = update.message!.messageId;
      const semanticKey = buildGroupCommandKey(chatId, messageId);
      let record = records.get(semanticKey);
      if (record?.leased || record?.completed) return null;
      if (!record) {
        record = {
          completed: false,
          leased: false,
          permit: {
            claimId: randomUUID(),
            semanticKey,
            webhookEventId: String(update.updateId),
            executionBotId,
            leaseToken: randomUUID(),
            chatId,
            messageId,
            sourceAt: readWebhookEventTimestamp(update) ?? new Date(),
            result: null,
          },
        };
        records.set(semanticKey, record);
      }
      record.leased = true;
      return { ...record.permit };
    }),
    isHeldSource: jest.fn().mockResolvedValue(false),
    isFreshHeldCommandAccessAllowed: jest.fn().mockResolvedValue(true),
    assertFreshHeldCommandAccess: jest.fn().mockResolvedValue(undefined),
    closureNoticeDeadline: jest
      .fn<Promise<number>, [GroupCommandPermit]>()
      .mockResolvedValue(Infinity),
    assertOwned: jest.fn().mockResolvedValue(undefined),
    prepareResult: jest.fn(async (permit: GroupCommandPermit, result: GroupCommandResult) => {
      const record = records.get(permit.semanticKey);
      if (!record || record.permit.result) throw new Error('Command result already exists');
      record.permit.result = result;
    }),
    prepareQueuedResult: jest.fn(
      async (permit: GroupCommandPermit, action: 'BAN' | 'MUTE' | 'SUPER_BAN'): Promise<void> => {
        const result: GroupCommandResult = {
          action,
          outcome: 'QUEUED',
          noticeText: null,
          applied: false,
        };
        await authority.prepareResult(permit, result);
        permit.result = result;
      },
    ),
    complete: jest.fn(async (permit: GroupCommandPermit) => {
      const record = records.get(permit.semanticKey);
      if (record) {
        record.completed = true;
        record.leased = false;
      }
    }),
    release: jest.fn(async (permit: GroupCommandPermit) => {
      const record = records.get(permit.semanticKey);
      if (record) record.leased = false;
    }),
  };
  return authority;
}
