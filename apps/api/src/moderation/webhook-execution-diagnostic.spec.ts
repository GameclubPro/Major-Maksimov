import {
  describeWebhookExecutionFailure,
  logWebhookExecutionFailure,
  webhookDiagnosticReference,
} from './webhook-execution-diagnostic';
import { recordDuplicateLookupFailure } from './message-duplicate/message-duplicate-lookup-diagnostic';
import { recordModerationGuardFailure } from './moderation-guard-failure-diagnostic';

describe('webhook execution diagnostics', () => {
  it('correlates failure and settlement without exporting identifiers or source errors', () => {
    const warn = jest.fn();
    const id = 'private-receipt-identity';
    const error = Object.assign(new Error('private source text and secret'), {
      code: 'ECONNRESET',
    });
    logWebhookExecutionFailure({ warn }, 'handler', error, 'rule-engine', id);
    const fields = warn.mock.calls[0][0];
    expect(fields).toMatchObject({
      stage: 'handler',
      errorCode: 'ECONNRESET',
      eventRef: webhookDiagnosticReference(id),
    });
    expect(fields.eventRef).toMatch(/^[a-f0-9]{24}$/u);
    expect(fields.eventRef).not.toBe(webhookDiagnosticReference('different-receipt'));
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private|secret/u);
    for (const value of [null, undefined, {}, '', 'x'.repeat(129)])
      expect(webhookDiagnosticReference(value)).toBeNull();
  });

  it('retains the first guard boundary and only its closed proof classification', () => {
    const error = Object.freeze({ response: { status: 404 }, private: 'secret' });
    recordModerationGuardFailure(error, 'duplicate_sanction_final');
    recordModerationGuardFailure(
      error,
      'duplicate_sanction_final',
      'own_delete_binding_unproven',
      'reason_unverified',
    );
    recordModerationGuardFailure(error, 'required_subscription_sanction_mutation');
    recordModerationGuardFailure(
      error,
      'duplicate_sanction_final',
      'own_delete_sanction_receipt_unproven',
    );
    const result = describeWebhookExecutionFailure(error);
    expect(result).toMatchObject({
      guardBoundary: 'duplicate_sanction_final',
      guardProofFailure: 'own_delete_binding_unproven',
      guardProofDetail: 'reason_unverified',
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(
      describeWebhookExecutionFailure({
        guardBoundary: 'duplicate_sanction_final',
        guardProofDetail: 'private-secret',
      }),
    ).not.toHaveProperty('guardBoundary');
    for (const value of [null, undefined, 0, 'secret']) {
      expect(() => recordModerationGuardFailure(value, 'duplicate_sanction_initial')).not.toThrow();
    }
  });

  it.each([
    ['MAX_API_INTERNAL_RATE_LIMIT', 'max_internal_rate_limit'],
    ['MAX_API_CIRCUIT_OPEN', 'max_circuit_open'],
    ['DUPLICATE_WINDOW_CAPACITY_EXCEEDED', 'duplicate_history_local_capacity'],
  ])('classifies the fixed local %s code without its message', (code, failureReason) => {
    const result = describeWebhookExecutionFailure({
      code,
      message: 'private-reason',
      retryAfterMs: 1234,
    });
    expect(result).toMatchObject({ failureReason, httpStatus: null });
    expect(JSON.stringify(result)).not.toMatch(/private-reason|1234/u);
    expect(describeWebhookExecutionFailure({ code: code + ':private' }).failureReason).toBe(
      'unknown',
    );
  });

  it('labels generic not.found separately from message-specific absence', () => {
    expect(
      describeWebhookExecutionFailure({ response: { status: 404, data: { code: 'not.found' } } }),
    ).toMatchObject({ httpStatus: 404, maxFailureCode: 'generic_not_found' });
  });
  it.each([
    ['Message duplicate history deadline exceeded', 'duplicate_history_reply_deadline'],
    ['Message duplicate window deadline exceeded', 'duplicate_history_admission_deadline'],
  ])('distinguishes %s without exposing private context', (message, failureReason) => {
    const error = new Error(message);
    error.stack =
      'private-value\n at x (/app/moderation/message-duplicate/message-duplicate-history.service.js:123:4)';
    const result = describeWebhookExecutionFailure(error, 'message-duplicate.observe');
    expect(result).toMatchObject({
      failureReason,
      locations: { duplicateHistory: { format: 'js', line: 123, column: 4 } },
    });
    expect(JSON.stringify(result)).not.toMatch(/private-value|\/app/u);
    expect(
      describeWebhookExecutionFailure(new Error(`${message}: private-value`)).failureReason,
    ).toBe('unknown');
  });
  it('preserves frozen HTTP errors and their first bounded duplicate lookup provenance', () => {
    const error = Object.freeze({ response: { status: 404 }, private: 'secret' });
    const before = JSON.stringify(error);
    recordDuplicateLookupFailure(error, 'delete_recheck', 'original');
    recordDuplicateLookupFailure(error, 'notice', 'current');
    const result = describeWebhookExecutionFailure(error);
    expect(result).toMatchObject({
      httpStatus: 404,
      duplicateLookupPhase: 'delete_recheck',
      duplicateLookupSource: 'original',
    });
    expect(JSON.stringify(error)).toBe(before);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(describeWebhookExecutionFailure({ response: { status: 404 } })).not.toHaveProperty(
      'duplicateLookupPhase',
    );
    for (const value of [null, undefined, 0, 'secret'])
      expect(() => recordDuplicateLookupFailure(value, 'qualification', 'current')).not.toThrow();
  });
  it('retains HTTP and source evidence without private error data', () => {
    const error = Object.assign(new Error('secret message and token'), {
      response: { status: 404, data: { token: 'secret' } },
      stack:
        'secret\n at x (/app/moderation/moderation.service.legacy.js:123:45)\n' +
        ' at y (/app/moderation/webhook-canonical-execution.service.ts:67:8)',
    });
    const result = describeWebhookExecutionFailure(error);
    expect(result.httpStatus).toBe(404);
    expect(result.locations).toEqual({
      handler: { format: 'js', line: 123, column: 45 },
      canonical: { format: 'ts', line: 67, column: 8 },
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|token|\/app|message/u);
  });

  it('ignores arbitrary paths and source locations beyond the bounded stack', () => {
    const error = new TypeError('secret');
    error.stack = `/private/secret.js:12:34\n${'x'.repeat(16_384)}\n at x (/moderation/moderation.service.legacy.js:1:2)`;
    expect(describeWebhookExecutionFailure(error)).toMatchObject({
      errorKind: 'type_error',
      locations: {},
    });
  });

  it('retains only fixed dispatch source coordinates for local deletion errors', () => {
    const error = new Error('private-id');
    error.stack =
      'private-id\n at x (/app/max/max-client.service.js:5249:13)\n' +
      ' at y (/app/max/max-action-ledger.service.ts:22:4)\n' +
      ' at z (/app/moderation/moderation-delete-intent.service.ts:2480:7)';
    const result = describeWebhookExecutionFailure(error, 'violation-delete');
    expect(result.locations).toEqual({
      maxClient: { format: 'js', line: 5249, column: 13 },
      actionLedger: { format: 'ts', line: 22, column: 4 },
      deleteIntent: { format: 'ts', line: 2480, column: 7 },
    });
    expect(JSON.stringify(result)).not.toMatch(/private-id|\/app/u);
  });

  it('tolerates hostile getters without replacing the original exception', () => {
    const error = Object.defineProperty(new Error('secret'), 'stack', {
      get() {
        throw new Error('secret getter');
      },
    });
    expect(describeWebhookExecutionFailure(error)).toMatchObject({ locations: {} });
    expect(JSON.stringify(describeWebhookExecutionFailure(error))).not.toContain('secret');
  });

  it('locates rule-engine failures without exporting their message or stack', () => {
    const error = Object.assign(new Error('private-id secret'), {
      code: 'DUPLICATE_STATE_BUDGET_EXCEEDED',
      stack:
        'private-id secret\n at x (/app/moderation/rule-engine.service.impl.js:41:2)\n' +
        ' at y (/app/moderation/rule-engine-message-limits.detector.ts:381:7)\n' +
        ' at z (/app/moderation/rule-engine-duplicate-detector.ts:307:12)\n' +
        ' at a (/app/moderation/redis-counter.service.js:121:3)',
    });
    const result = describeWebhookExecutionFailure(error, 'rule-engine.detect');
    expect(result).toMatchObject({
      failureReason: 'duplicate_state_budget',
      hotPathStage: 'rule-engine.detect',
      locations: {
        ruleEngine: { format: 'js', line: 41, column: 2 },
        messageLimits: { format: 'ts', line: 381, column: 7 },
        duplicateState: { format: 'ts', line: 307, column: 12 },
        redisCounter: { format: 'js', line: 121, column: 3 },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/private-id|secret|\/app/u);
  });

  it.each([
    'violation-delete',
    'report-submission',
    'report-submission.complete',
    'message-duplicate.observe',
    'message-duplicate.complete',
    'violation-rule-followup.persist',
    'violation-rule-followup.complete',
    'required-subscription.initial-authority',
    'required-subscription.delete-authority',
    'rule-engine.detect',
  ])('classifies HTTP routes and %s without retaining request configuration', (hotPathStage) => {
    const error = Object.assign(new Error('secret'), {
      config: {
        method: 'delete',
        url: '/messages/private-id?token=secret',
        headers: { Authorization: 'secret' },
      },
    });
    const result = describeWebhookExecutionFailure(error, hotPathStage);
    expect(result).toMatchObject({
      requestOperation: 'delete_messages',
      requestTarget: 'single',
      hotPathStage,
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|private-id|Authorization/u);
    expect(describeWebhookExecutionFailure(error, `${hotPathStage}: private-id`).hotPathStage).toBe(
      'unknown',
    );
    expect(describeWebhookExecutionFailure(error, 'private-id').hotPathStage).toBe('unknown');
    error.config.url = '/private-id/secret';
    expect(describeWebhookExecutionFailure(error).requestOperation).toBe('unknown');
  });

  it('distinguishes collection lookup failures from exact lookups without identifiers', () => {
    for (const [url, requestTarget] of [
      ['/messages?message_ids=private-id', 'collection'],
      ['/messages/private-id?token=secret', 'single'],
    ]) {
      const result = describeWebhookExecutionFailure({
        config: { method: 'get', url },
        response: { status: 404, data: { error: { code: 'message.not.found', secret: 'secret' } } },
      });
      expect(result).toMatchObject({
        requestOperation: 'get_messages',
        requestTarget,
        maxFailureCode: 'message_not_found',
      });
      expect(JSON.stringify(result)).not.toMatch(/private-id|secret|message_ids/u);
    }
  });

  it.each([
    ['max_action_executor_proof_rejected', 'executor_proof_rejected'],
    ['required_subscription_no_longer_authorized', 'subscription_authority_rejected'],
    ['Required subscription source no longer actionable', 'subscription_source_unavailable'],
    ['Required subscription fresh membership unavailable', 'subscription_membership_unavailable'],
    ['Required subscription author access unavailable', 'subscription_author_unavailable'],
    ['Required subscription execution guard unavailable', 'subscription_guard_unavailable'],
    ['Message limit state deadline exceeded', 'message_limit_state_deadline'],
    ['Media cooldown state deadline exceeded', 'media_cooldown_state_deadline'],
    ['DUPLICATE_STATE_BUDGET_EXCEEDED', 'duplicate_state_budget'],
  ])('retains only the known reason %s', (message, failureReason) => {
    expect(describeWebhookExecutionFailure(new Error(message)).failureReason).toBe(failureReason);
    expect(describeWebhookExecutionFailure({ code: message }).failureReason).toBe(failureReason);
    const result = describeWebhookExecutionFailure(new Error(`${message}: private-id`));
    expect(result.failureReason).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain('private-id');
  });

  it('ignores unknown upstream codes, malformed bodies and hostile response getters', () => {
    for (const data of [
      { code: 'private-id', message: 'secret' },
      [{ code: 'message.not.found' }],
    ]) {
      expect(describeWebhookExecutionFailure({ response: { data } }).maxFailureCode).toBe(
        'unknown',
      );
    }
    const error = Object.defineProperty(new Error('private-id'), 'response', {
      get() {
        throw new Error('secret');
      },
    });
    expect(() => describeWebhookExecutionFailure(error)).not.toThrow();
    expect(JSON.stringify(describeWebhookExecutionFailure(error))).not.toMatch(
      /private-id|secret/u,
    );
  });
});
