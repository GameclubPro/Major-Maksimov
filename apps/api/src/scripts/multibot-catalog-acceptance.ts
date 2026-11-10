import { evaluateCatalogLatency, type CatalogLatencyTargets } from './multibot-catalog-latency';
import { isCatalogViolation } from './multibot-catalog-workload';

export type CatalogProfile = 'uniform' | 'hot' | 'cold' | 'media' | 'mixed';
export type CatalogCohort = 'ordinary' | 'hot' | 'quiet';

export function parseCatalogTokenRps(value?: string): 25 | 30 {
  if (value === undefined || value === '25') return 25;
  if (value === '30') return 30;
  throw new Error('Use --quota=25|30');
}
export type CatalogExpectedEvent = Readonly<{
  sequence: number;
  messageId: string;
  chatId: string;
  executorId: string;
  cohort: CatalogCohort;
  decision: 'DELETE' | 'KEEP';
}>;

export function buildCatalogManifest(options: {
  caseId: string;
  chats: readonly string[];
  executorByChat: ReadonlyMap<string, string>;
  messages: number;
  bots: number;
  fixedRouting: boolean;
  profile: CatalogProfile;
  violationPercent: number;
}): CatalogExpectedEvent[] {
  const { chats, messages, bots, profile } = options;
  if (!chats.length || !Number.isSafeInteger(messages) || messages <= 0)
    throw new Error('Catalog manifest requires chats and positive messages');
  if (profile === 'mixed' && (chats.length < 5 || messages < 5 || messages > 10_000))
    throw new Error('Mixed profile requires at least 5 chats and 5..10,000 messages');
  const executorCounts = new Map<string, number>();
  return Array.from({ length: messages }, (_, sequence) => {
    const spread = Math.floor((sequence * chats.length) / messages) % chats.length;
    let chatIndex = options.fixedRouting
      ? Math.min(chats.length - 1, spread - (spread % bots) + (sequence % bots))
      : spread;
    let cohort: CatalogCohort = 'ordinary';
    if (profile === 'hot') {
      chatIndex = sequence % Math.min(4, chats.length);
      cohort = 'hot';
    } else if (profile === 'mixed') {
      // FLAG: Quiet events must arrive during the hot stream, not only after its drain.
      const quiet = sequence % 5 === 2;
      cohort = quiet ? 'quiet' : 'hot';
      chatIndex = quiet
        ? 4 + (Math.floor(sequence / 5) % (chats.length - 4))
        : (sequence - Math.floor((sequence + 2) / 5)) % 4;
    }
    const chatId = chats[chatIndex]!;
    const executorId = options.executorByChat.get(chatId);
    if (!executorId) throw new Error(`Missing fixture executor for ${chatId}`);
    const executorIndex = executorCounts.get(executorId) ?? 0;
    executorCounts.set(executorId, executorIndex + 1);
    return {
      sequence,
      messageId: `${options.caseId}-${sequence}`,
      chatId,
      executorId,
      cohort,
      // FLAG: This oracle is a declared synthetic label, independent of observed intents.
      decision: isCatalogViolation(executorIndex, options.violationPercent) ? 'DELETE' : 'KEEP',
    };
  });
}

export type CatalogEventObservation = {
  ingressAtMs: number;
  receipts: Array<{
    botId: string | null;
    chatId: string | null;
    messageId: string | null;
    status: string;
    deadlineAtMs: number | null;
  }>;
  claims: Array<{ status: string; botId: string | null; completedAtMs: number | null }>;
  intents: Array<{
    status: string;
    chatId: string;
    botId: string | null;
    remoteBotId: string | null;
    remoteSucceededAtMs: number | null;
    completedAtMs: number | null;
    verified: boolean;
    dispatchStarted: boolean;
  }>;
  deletes: Array<{ botId: string; observedAtMs: number }>;
  messagePresent: boolean | null;
};

function latencyReport(values: number[], expected: number, targets: CatalogLatencyTargets | null) {
  const result = evaluateCatalogLatency(values, expected, targets);
  const valid = values.filter((value) => Number.isFinite(value) && value >= 0);
  return {
    ...result,
    basis: 'logical_ingress_to_verified_outcome' as const,
    status: expected === 0 ? ('not_applicable' as const) : result.status,
    complete: expected === 0 || result.complete,
    maxConfirmedMs: valid.length
      ? valid.reduce((maximum, value) => Math.max(maximum, value), 0)
      : null,
  };
}

export function evaluateCatalogOutcomes(
  manifest: readonly CatalogExpectedEvent[],
  observations: ReadonlyMap<string, CatalogEventObservation>,
  expectedBotIds: readonly string[],
  targets: CatalogLatencyTargets | null,
  observedAtMs: number,
) {
  const expectedBots = new Set(expectedBotIds);
  if (
    !expectedBotIds.length ||
    expectedBots.size !== expectedBotIds.length ||
    expectedBotIds.some((id) => !id)
  )
    throw new Error('Expected mirror bot IDs must be nonempty and unique');
  if (!Number.isSafeInteger(observedAtMs) || Math.abs(observedAtMs) > 8.64e15)
    throw new Error('Observation time must be valid UTC epoch milliseconds');
  const mirrors = expectedBotIds.length;
  const cohorts = (['ordinary', 'hot', 'quiet'] as const).map((cohort) => {
    const expected = manifest.filter((event) => event.cohort === cohort);
    let submitted = 0;
    let observedReceipts = 0;
    let missingReceipts = 0;
    let duplicateMirrorReceipts = 0;
    let unexpectedMirrorReceipts = 0;
    let invalidIngressEvents = 0;
    let quarantinedReceipts = 0;
    let expiredReceipts = 0;
    let failedReceipts = 0;
    let unfinishedReceipts = 0;
    let unknownEffectEvents = 0;
    let wrongExecutorEvents = 0;
    let wrongTargetEvents = 0;
    let duplicateEffectEvents = 0;
    let unexpectedDeleteEvents = 0;
    let confirmedDeletes = 0;
    let confirmedKeeps = 0;
    const outcomeLatencies: number[] = [];
    const deleteLatencies: number[] = [];
    for (const event of expected) {
      const observation = observations.get(event.messageId);
      if (!observation) {
        missingReceipts += mirrors;
        continue;
      }
      submitted += 1;
      observedReceipts += observation.receipts.length;
      // FLAG: Receipt count alone does not prove that every exact bot observed this target.
      const observedBots = new Set<string>();
      let exactMirrors = observation.receipts.length === mirrors;
      for (const receipt of observation.receipts) {
        if (receipt.botId === null || !expectedBots.has(receipt.botId)) {
          unexpectedMirrorReceipts += 1;
          exactMirrors = false;
        } else if (observedBots.has(receipt.botId)) {
          duplicateMirrorReceipts += 1;
          exactMirrors = false;
        } else observedBots.add(receipt.botId);
        const terminal = ['PROCESSED', 'DUPLICATE'].includes(receipt.status);
        if (receipt.status === 'QUARANTINED') quarantinedReceipts += 1;
        if (
          receipt.status === 'EXPIRED' ||
          (!terminal && receipt.deadlineAtMs !== null && receipt.deadlineAtMs <= observedAtMs)
        )
          expiredReceipts += 1;
        if (receipt.status === 'FAILED') failedReceipts += 1;
        if (!terminal) unfinishedReceipts += 1;
      }
      missingReceipts += mirrors - observedBots.size;
      exactMirrors &&= observedBots.size === mirrors;
      // FLAG: Date and UTC timestamp(3) clocks in this local fixture are integer milliseconds.
      // Require proof inside [ingress, observation]; never clamp or repair uncertain clocks.
      const validIngress =
        Number.isSafeInteger(observation.ingressAtMs) &&
        Math.abs(observation.ingressAtMs) <= 8.64e15 &&
        observation.ingressAtMs <= observedAtMs;
      if (!validIngress) invalidIngressEvents += 1;
      const validProofClock = (clock: number | null): clock is number =>
        validIngress &&
        clock !== null &&
        Number.isSafeInteger(clock) &&
        clock >= observation.ingressAtMs &&
        clock <= observedAtMs;
      const completedOwners = observation.claims.filter((claim) => claim.status === 'COMPLETED');
      const wrongExecutor =
        observation.claims.some((claim) => claim.botId !== event.executorId) ||
        observation.deletes.some((effect) => effect.botId !== event.executorId) ||
        observation.intents.some(
          (intent) =>
            (intent.botId !== null && intent.botId !== event.executorId) ||
            (intent.remoteBotId !== null && intent.remoteBotId !== event.executorId),
        );
      if (wrongExecutor) wrongExecutorEvents += 1;
      const wrongTarget =
        observation.receipts.some(
          (receipt) => receipt.chatId !== event.chatId || receipt.messageId !== event.messageId,
        ) || observation.intents.some((intent) => intent.chatId !== event.chatId);
      if (wrongTarget) wrongTargetEvents += 1;
      if (observation.deletes.length > 1) duplicateEffectEvents += 1;
      if (event.decision === 'KEEP' && observation.deletes.length) unexpectedDeleteEvents += 1;
      if (
        observation.intents.some(
          (intent) =>
            intent.status === 'AMBIGUOUS' ||
            (intent.dispatchStarted && intent.remoteSucceededAtMs === null),
        )
      )
        unknownEffectEvents += 1;
      const executionComplete =
        exactMirrors &&
        observation.receipts.every((receipt) =>
          ['PROCESSED', 'DUPLICATE'].includes(receipt.status),
        ) &&
        observation.claims.length === 1 &&
        completedOwners.length === 1 &&
        !wrongExecutor &&
        !wrongTarget;
      const intent = observation.intents[0];
      if (
        event.decision === 'DELETE' &&
        executionComplete &&
        observation.intents.length === 1 &&
        intent?.status === 'SUCCEEDED' &&
        intent.botId === event.executorId &&
        intent.remoteBotId === event.executorId &&
        intent.verified &&
        intent.remoteSucceededAtMs !== null &&
        intent.completedAtMs !== null &&
        observation.deletes.length === 1 &&
        observation.messagePresent === false
      ) {
        confirmedDeletes += 1;
        const clocks = [
          intent.remoteSucceededAtMs,
          intent.completedAtMs,
          observation.deletes[0]!.observedAtMs,
        ];
        const validClocks = clocks.every(validProofClock);
        const deleteLatency = validClocks ? Math.max(...clocks) - observation.ingressAtMs : NaN;
        const ownerCompletedAtMs = completedOwners[0]!.completedAtMs;
        const outcomeLatency = validProofClock(ownerCompletedAtMs)
          ? Math.max(deleteLatency, ownerCompletedAtMs - observation.ingressAtMs)
          : NaN;
        outcomeLatencies.push(outcomeLatency);
        deleteLatencies.push(deleteLatency);
      } else if (
        event.decision === 'KEEP' &&
        executionComplete &&
        observation.intents.length === 0 &&
        observation.deletes.length === 0 &&
        observation.messagePresent === true
      ) {
        confirmedKeeps += 1;
        const ownerCompletedAtMs = completedOwners[0]!.completedAtMs;
        outcomeLatencies.push(
          validProofClock(ownerCompletedAtMs) ? ownerCompletedAtMs - observation.ingressAtMs : NaN,
        );
      }
    }
    const expectedDeletes = expected.filter((event) => event.decision === 'DELETE').length;
    const outcomeLatency = latencyReport(outcomeLatencies, expected.length, targets);
    const deleteLatency = latencyReport(deleteLatencies, expectedDeletes, targets);
    return {
      cohort,
      expectedEvents: expected.length,
      submittedEvents: submitted,
      expectedDeletes,
      expectedKeeps: expected.length - expectedDeletes,
      confirmedDeletes,
      confirmedKeeps,
      incompleteEvents: expected.length - confirmedDeletes - confirmedKeeps,
      expectedReceipts: expected.length * mirrors,
      observedReceipts,
      missingReceipts,
      duplicateMirrorReceipts,
      unexpectedMirrorReceipts,
      invalidIngressEvents,
      quarantinedReceipts,
      expiredReceipts,
      failedReceipts,
      unfinishedReceipts,
      unknownEffectEvents,
      wrongExecutorEvents,
      wrongTargetEvents,
      duplicateEffectEvents,
      unexpectedDeleteEvents,
      outcomeLatency,
      deleteLatency: { ...deleteLatency, basis: 'logical_ingress_to_confirmed_delete' as const },
    };
  });
  const correctnessFailed = cohorts.some(
    (cohort) =>
      cohort.incompleteEvents ||
      cohort.duplicateMirrorReceipts ||
      cohort.unexpectedMirrorReceipts ||
      cohort.invalidIngressEvents ||
      !cohort.outcomeLatency.complete ||
      !cohort.deleteLatency.complete ||
      cohort.unknownEffectEvents ||
      cohort.wrongExecutorEvents ||
      cohort.wrongTargetEvents ||
      cohort.duplicateEffectEvents ||
      cohort.unexpectedDeleteEvents,
  );
  return {
    correctnessStatus: correctnessFailed ? ('failed' as const) : ('passed' as const),
    status:
      correctnessFailed ||
      cohorts.some(
        (cohort) =>
          cohort.outcomeLatency.status === 'failed' || cohort.deleteLatency.status === 'failed',
      )
        ? ('failed' as const)
        : ('passed' as const),
    coverageBasis: 'all_expected_logical_events_in_pre_ingress_manifest' as const,
    observedAt: new Date(observedAtMs).toISOString(),
    cohorts,
  };
}
