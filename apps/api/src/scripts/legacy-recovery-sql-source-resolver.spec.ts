import { Prisma } from '../prisma/prisma-client';
import { buildPhotoDuplicateJobId } from '../moderation/photo-duplicate/photo-duplicate.queue';
import {
  buildMessageDuplicateJobId,
  MESSAGE_DUPLICATE_JOB_VERSION,
} from '../moderation/message-duplicate/message-duplicate.queue';
import { legacySnapshotDigest } from '../webhook/webhook-legacy-source';
import {
  resolveLegacyRecoverySqlSource,
  type LegacyRecoverySqlSourceInput,
} from './legacy-recovery-sql-source-resolver';
const at = '2026-10-01T00:00:00.000Z';
function input(): LegacyRecoverySqlSourceInput {
  const jobId = buildPhotoDuplicateJobId({ chatId: '-fixture', messageId: 'm' });
  const data = {
    webhookEventId: 'receipt',
    chatId: '-fixture',
    messageId: 'm',
    sourceCreatedAt: at,
    createdAt: at,
    actionEligible: true,
    algorithmVersion: 2,
    sourceTag: 'photo-duplicate',
    retryPolicyName: 'photo-duplicate',
    idempotencyKey: jobId,
  };
  return {
    queueName: 'photo-duplicates',
    jobId,
    data,
    jobPayloadDigest: legacySnapshotDigest(data),
  };
}
const scopes = [
  { chatId: '-selected', messageId: 'selected', userId: 'selected', sourceAt: new Date(at) },
];
const budget = () => ({
  pages: 4,
  rows: 3,
  probes: 3,
  bytes: 16 * 1024 * 1024,
  deadlineAtMs: Date.now() + 30_000,
});
const plan = () => [
  {
    Plan: {
      'Node Type': 'Index Scan',
      'Relation Name': 'webhook_events',
      'Index Name': 'webhook_events_pkey',
      'Index Cond': "(id = 'receipt'::text)",
      'Scan Direction': 'Forward',
    },
  },
];
const context = [{ readonly: 'on', isolation: 'repeatable read', timeout: '5s' }];
describe('exact SQL source input and query admission', () => {
  it.each([
    'secondary-origin',
    'identity',
    'digest',
    'version',
    'missing-metadata',
    'coercion',
  ] as const)('rejects %s before any SQL', async (fault) => {
    const request = input(),
      data = { ...(request.data as Record<string, unknown>) };
    if (fault === 'secondary-origin') data.parentWebhookEventId = 'unknown';
    if (fault === 'identity') data.messageId = 'changed';
    if (fault === 'version') data.algorithmVersion = 1;
    if (fault === 'missing-metadata') delete data.sourceTag;
    if (fault === 'coercion') data.actionEligible = 'true';
    const read = jest.fn();
    const result = await resolveLegacyRecoverySqlSource(
      { $queryRaw: read } as unknown as Prisma.TransactionClient,
      {
        ...request,
        data,
        jobPayloadDigest: fault === 'digest' ? '0'.repeat(64) : legacySnapshotDigest(data),
      },
      scopes,
      budget(),
    );
    expect(result.decision).toBe('DENY');
    expect(read).not.toHaveBeenCalled();
  });
  it('rejects an unknown message comparison before any SQL', async () => {
    const eventTimestampMs = Date.parse(at);
    const jobId = buildMessageDuplicateJobId('-fixture', 'm', eventTimestampMs, 'TEXT');
    const data = {
      webhookEventId: 'receipt',
      chatId: '-fixture',
      messageId: 'm',
      sourceCreatedAt: at,
      createdAt: at,
      actionEligible: true,
      idempotencyKey: jobId,
      version: MESSAGE_DUPLICATE_JOB_VERSION,
      eventTimestampMs,
      controlRevision: 1,
      policyRevision: 1,
      settingsDigest: 'a'.repeat(64),
      deadlineAtMs: eventTimestampMs + 60_000,
      comparison: 'UNKNOWN',
    };
    const read = jest.fn();
    const result = await resolveLegacyRecoverySqlSource(
      { $queryRaw: read } as unknown as Prisma.TransactionClient,
      {
        queueName: 'message-duplicates',
        jobId,
        data,
        jobPayloadDigest: legacySnapshotDigest(data),
      },
      scopes,
      budget(),
    );
    expect(result.decision).toBe('DENY');
    expect(read).not.toHaveBeenCalled();
  });
  it.each(['sequential', 'wrong-index-condition', 'filter', 'nested-scan', 'wrong-table'] as const)(
    'refuses %s plans before EXPLAIN ANALYZE can scan history',
    async (fault) => {
      const p = plan();
      const node = p[0]!.Plan as Record<string, unknown>;
      if (fault === 'sequential') node['Node Type'] = 'Seq Scan';
      if (fault === 'wrong-index-condition') node['Index Cond'] = "(id > 'receipt'::text)";
      if (fault === 'filter') node.Filter = "(id = 'receipt'::text)";
      if (fault === 'nested-scan')
        node.Plans = [{ 'Node Type': 'Seq Scan', 'Relation Name': 'webhook_events' }];
      if (fault === 'wrong-table') node['Relation Name'] = 'other';
      const read = jest
        .fn()
        .mockResolvedValueOnce(context)
        .mockResolvedValueOnce([{ 'QUERY PLAN': p }]);
      const result = await resolveLegacyRecoverySqlSource(
        { $queryRaw: read } as unknown as Prisma.TransactionClient,
        input(),
        scopes,
        budget(),
      );
      expect(result.decision).toBe('DENY');
      expect(read).toHaveBeenCalledTimes(2);
    },
  );
  it('charges measured buffer and row work before returning a source body', async () => {
    const p = plan();
    const measured = [
      { Plan: { ...p[0]!.Plan, 'Actual Rows': 1, 'Actual Loops': 1, 'Shared Hit Blocks': 10000 } },
    ];
    const read = jest
      .fn()
      .mockResolvedValueOnce(context)
      .mockResolvedValueOnce([{ 'QUERY PLAN': p }])
      .mockResolvedValueOnce([{ 'QUERY PLAN': measured }]);
    const result = await resolveLegacyRecoverySqlSource(
      { $queryRaw: read } as unknown as Prisma.TransactionClient,
      input(),
      scopes,
      budget(),
    );
    expect(result.decision).toBe('DENY');
    expect(read).toHaveBeenCalledTimes(3);
    expect(result.cost.bytes).toBeGreaterThan(10000 * 8192 * 2);
    expect(result.cost.rows).toBe(3);
    expect(result.cost.probes).toBe(3);
  });
  it('fails generically when SQL loses its response and does not retry', async () => {
    const read = jest
      .fn()
      .mockResolvedValueOnce(context)
      .mockRejectedValueOnce(new Error('PRIVATE body or SQL detail'));
    const result = await resolveLegacyRecoverySqlSource(
      { $queryRaw: read } as unknown as Prisma.TransactionClient,
      input(),
      scopes,
      budget(),
    );
    expect(result.decision).toBe('DENY');
    expect(read).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
});
