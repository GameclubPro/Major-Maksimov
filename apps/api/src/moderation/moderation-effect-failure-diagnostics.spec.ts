import {
  markMaxPreDispatchGuardRejected,
  MAX_MEMBER_PRE_DISPATCH_GUARD_REJECTED_CODE,
} from '../max/max-action-pre-dispatch-guard';
import { markMaxMemberMutationAttempted } from '../max/max-member-error.util';
import { markMaxMessageSendAttempted } from '../max/max-mutation-outcome.util';
import { buildModerationEffectFailureDiagnostic } from './moderation-effect-failure-diagnostics';
import { ModerationRuleSanctionRejectedError } from './moderation-rule-sanction-authority';
import { ModerationStateDeleteRejectedError } from './moderation-state-delete-guard.service';

const knownCauses = [
  {
    create: () => new ModerationStateDeleteRejectedError(),
    errorClass: 'ModerationStateDeleteRejectedError',
    errorCode: 'moderation_state_delete_no_longer_authorized',
  },
  {
    create: () => new ModerationRuleSanctionRejectedError(),
    errorClass: 'ModerationRuleSanctionRejectedError',
    errorCode: 'moderation_rule_sanction_no_longer_authorized',
  },
] as const;

describe.each(knownCauses)('$errorClass effect failure diagnostics', (cause) => {
  function markedError() {
    const error = cause.create();
    markMaxPreDispatchGuardRejected(error, MAX_MEMBER_PRE_DISPATCH_GUARD_REJECTED_CODE);
    return error;
  }

  it('preserves the fixed typed cause and genuine pre-dispatch refusal', () => {
    expect(buildModerationEffectFailureDiagnostic(markedError())).toEqual({
      errorClass: cause.errorClass,
      errorCode: cause.errorCode,
      preDispatchGuardRejected: true,
    });
  });

  it('does not infer transport absence from the class alone', () => {
    expect(buildModerationEffectFailureDiagnostic(cause.create())).toEqual({
      errorClass: cause.errorClass,
      errorCode: cause.errorCode,
      preDispatchGuardRejected: false,
    });
  });

  it.each([
    ['member mutation', markMaxMemberMutationAttempted],
    ['message send', markMaxMessageSendAttempted],
  ] as const)('does not certify pre-dispatch refusal after a %s attempt', (_label, markAttempt) => {
    const error = markedError();
    Object.assign(error, { response: { status: 400 } });
    markAttempt(error);
    expect(buildModerationEffectFailureDiagnostic(error)).toEqual({
      errorClass: cause.errorClass,
      errorCode: cause.errorCode,
      preDispatchGuardRejected: false,
    });
  });

  it.each([
    { message: 'Ambiguous MAX effect outcome' },
    { response: { status: 408 } },
    { response: { status: 503 } },
  ])('preserves ambiguity evidence: %j', (evidence) => {
    const error = Object.assign(markedError(), evidence);
    expect(buildModerationEffectFailureDiagnostic(error)).toEqual({
      errorClass: cause.errorClass,
      errorCode: cause.errorCode,
      preDispatchGuardRejected: false,
    });
  });

  it('ignores a forged name and code on an ordinary Error even with a genuine guard marker', () => {
    const error = Object.assign(new Error('private payload'), {
      name: cause.errorClass,
      code: cause.errorCode,
      cause: { token: 'private-token' },
      response: { data: 'private-response' },
    });
    markMaxPreDispatchGuardRejected(error, MAX_MEMBER_PRE_DISPATCH_GUARD_REJECTED_CODE);
    expect(buildModerationEffectFailureDiagnostic(error)).toEqual({
      errorClass: 'unknown',
      errorCode: null,
      preDispatchGuardRejected: false,
    });
  });
});

it.each([undefined, null, 'private value', { code: 'private-code', name: 'private-name' }])(
  'does not copy arbitrary failure fields: %p',
  (error) => {
    expect(buildModerationEffectFailureDiagnostic(error)).toEqual({
      errorClass: 'unknown',
      errorCode: null,
      preDispatchGuardRejected: false,
    });
  },
);
