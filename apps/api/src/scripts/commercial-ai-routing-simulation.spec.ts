import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  POOL_NODE_IDS,
  type CommercialLlmPoolNodeId,
} from '../moderation/commercial/commercial-llm-pool.protocol';
import {
  commercialAiRoutingExpectedIdentity,
  commercialAiRoutingScenarioSchema,
  simulateCommercialAiRouting,
  type CommercialAiRoutingScenario,
} from './commercial-ai-routing-simulation';
import { runCommercialAiRoutingSimulation } from './simulate-commercial-ai-routing';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
type Arrival = CommercialAiRoutingScenario['arrivals'][number];
type Observation = Arrival['observations'][number];
// Synthetic hand-calculable declarations only; no actual durations, model quality or human labels.
function observed(nodeId: CommercialLlmPoolNodeId, change: Partial<Observation> = {}): Observation {
  return {
    nodeId,
    phase: 'PRIMARY',
    attempt: 1,
    evidenceSha256: sha('synthetic-evidence'),
    durationMs: 1000,
    physicalCompletionMs: 1000,
    outcome: 'COMPLETE',
    classification: 'NOT_COMMERCIAL',
    ...change,
  };
}
function arrival(id: string, offeredAtMs = 0, change: Partial<Arrival> = {}): Arrival {
  return {
    sourceKey: sha(`source-${id}`),
    chatKey: sha(`chat-${id}`),
    messageKey: sha(`message-${id}`),
    eventAtMs: offeredAtMs,
    offeredAtMs,
    observations: POOL_NODE_IDS.map((id) => observed(id)),
    ...change,
  };
}
function scenario(
  arrivals: Arrival[],
  change: Partial<CommercialAiRoutingScenario> = {},
): CommercialAiRoutingScenario {
  return commercialAiRoutingScenarioSchema.parse({
    schemaVersion: 'commercial-ai-routing-scenario/v1',
    mode: 'DECLARED_SCENARIO',
    inputObservationSha256: sha('synthetic-input'),
    ...commercialAiRoutingExpectedIdentity(),
    seed: 42,
    horizonMs: 30_000,
    frozenRanking: {
      evidenceSha256: sha('synthetic-frozen-ranking'),
      frozenAtMs: 0,
      expectedUsefulCompletionCostMs: { 'pc-a-4b': 1, 'pc-b-9b': 2, 'server-9b': 3 },
    },
    nodeIntervals: [],
    arrivals,
    ...change,
  });
}
const frozen = (input: CommercialAiRoutingScenario) =>
  simulateCommercialAiRouting(input).strategies[1]!;

describe('bounded offline pool routing simulation', () => {
  it('admits only two pending inputs during a simultaneous burst and conserves every arrival', () => {
    const result = frozen(
      scenario(Array.from({ length: 5 }, (_, index) => arrival(String(index)))),
    );
    expect(result).toMatchObject({
      arrivals: 5,
      admitted: 2,
      completed: 2,
      maximumPending: 2,
      accountingGap: 0,
      rejected: { buffer_full: 3 },
      invariantViolations: [],
    });
  });
  it('caps active sources at three while queued inputs expire at their own three seconds', () => {
    const arrivals = [0, 250, 500, 750, 1000].map((at, index) =>
      arrival(String(index), at, {
        observations: POOL_NODE_IDS.map((id) =>
          observed(id, { durationMs: 10_000, physicalCompletionMs: 10_000 }),
        ),
      }),
    );
    expect(frozen(scenario(arrivals))).toMatchObject({
      admitted: 5,
      started: 3,
      maximumActive: 3,
      maximumPending: 2,
      rejected: { pending_expired: 2 },
      completed: 3,
      accountingGap: 0,
    });
  });
  it('excludes another same-chat primary while allowing an unrelated chat to progress', () => {
    const first = arrival('first');
    const second = arrival('second', 250, { chatKey: first.chatKey });
    const result = frozen(scenario([first, second, arrival('unrelated', 500)]));
    expect(result).toMatchObject({
      admitted: 2,
      rejected: { chat_busy: 1 },
      completed: 2,
      accountingGap: 0,
    });
  });
  it('abstains from a positive 4B answer when no idle 9B can confirm it', () => {
    const input = scenario(
      [
        arrival('positive', 0, {
          observations: [observed('pc-a-4b', { classification: 'COMMERCIAL' })],
        }),
      ],
      {
        nodeIntervals: [
          { nodeId: 'server-9b', kind: 'HELD', startMs: 0, endMs: null },
          { nodeId: 'pc-b-9b', kind: 'HELD', startMs: 0, endMs: null },
        ],
      },
    );
    expect(frozen(input)).toMatchObject({
      outcomes: { COMMERCIAL: 0, UNSURE: 1 },
      consultations: { demand: 1, noCapacity: 1 },
    });
  });
  it('keeps pending primary work ahead of a consultation and never queues that consultation', () => {
    const first = arrival('positive', 0, {
      observations: [
        observed('pc-a-4b', {
          classification: 'COMMERCIAL',
          durationMs: 100,
          physicalCompletionMs: 100,
        }),
      ],
    });
    const result = frozen(scenario([first, arrival('waiting', 1)]));
    expect(result).toMatchObject({
      outcomes: { UNSURE: 1, NOT_COMMERCIAL: 1 },
      consultations: { noCapacity: 1, completed: 0 },
    });
  });
  it('uses only one primary retry on a distinct node', () => {
    const input = scenario([
      arrival('retry', 0, {
        observations: [
          observed('pc-a-4b', { outcome: 'FAILURE', classification: null }),
          observed('pc-b-9b', { attempt: 2 }),
        ],
      }),
    ]);
    const result = frozen(input);
    expect(result).toMatchObject({
      primaryRetryOpportunities: 1,
      outcomes: { NOT_COMMERCIAL: 1 },
      accountingGap: 0,
    });
    expect(result.nodes.find((node) => node.nodeId === 'pc-a-4b')?.reservations).toBe(1);
    expect(result.nodes.find((node) => node.nodeId === 'pc-b-9b')?.reservations).toBe(1);
  });
  it('preserves the CPU remaining-budget floor after a slow failed primary', () => {
    const input = scenario(
      [
        arrival('cpu-floor', 0, {
          observations: [
            observed('pc-a-4b', {
              outcome: 'FAILURE',
              classification: null,
              durationMs: 15_001,
              physicalCompletionMs: 15_001,
            }),
          ],
        }),
      ],
      { nodeIntervals: [{ nodeId: 'pc-b-9b', kind: 'HELD', startMs: 0, endMs: null }] },
    );
    const result = frozen(input);
    expect(result).toMatchObject({ cpuFloorSkips: 1, outcomes: { TECHNICAL_FAILURE: 1 } });
    expect(result.nodes.find((node) => node.nodeId === 'server-9b')?.reservations).toBe(0);
  });
  it('closes inference at twenty seconds and retains physical work through its observed completion', () => {
    const input = scenario([
      arrival('deadline', 0, {
        observations: [observed('pc-a-4b', { durationMs: 25_000, physicalCompletionMs: 25_000 })],
      }),
    ]);
    const result = frozen(input);
    expect(result).toMatchObject({ outcomes: { EXPIRED: 1 }, completedLatencyMs: { p50: 20_000 } });
    expect(result.nodes.find((node) => node.nodeId === 'pc-a-4b')).toMatchObject({
      busyMs: 20_000,
      heldMs: 5000,
      idleMs: 5000,
    });
  });
  it('never invents an answer or a physical completion for an unobserved alternative node', () => {
    const result = frozen(scenario([arrival('unknown', 0, { observations: [] })]));
    expect(result).toMatchObject({
      definitiveDecisions: 0,
      outcomes: { COUNTERFACTUAL_UNKNOWN: 1 },
      accountingGap: 0,
    });
    expect(result.nodes.find((node) => node.nodeId === 'pc-a-4b')).toMatchObject({
      missingObservations: 1,
      unknownPhysicalCompletionAtBoundary: true,
      // The missing observation proves no computation interval; its reservation is uncertain from admission.
      busyMs: 0,
      heldMs: 30_000,
    });
  });
  it('does not reuse a timeout-held node for a later source', () => {
    const first = arrival('timeout', 0, {
      observations: [
        observed('pc-a-4b', {
          outcome: 'TIMEOUT',
          classification: null,
          physicalCompletionMs: null,
        }),
        observed('pc-b-9b', { attempt: 2 }),
      ],
    });
    const result = frozen(scenario([first, arrival('later', 3000)]));
    expect(result.nodes.find((node) => node.nodeId === 'pc-a-4b')).toMatchObject({
      reservations: 1,
      unknownPhysicalCompletionAtBoundary: true,
    });
    expect(result).toMatchObject({ completed: 2, accountingGap: 0 });
  });
  it('reports a censored tail and produces deterministic aggregates with no source identifiers', () => {
    const input = scenario([arrival('PRIVATE SENTINEL')], { horizonMs: 500 });
    const report = simulateCommercialAiRouting(input);
    expect(report).toEqual(simulateCommercialAiRouting(input));
    expect(report).toMatchObject({
      runtimeChangesApplied: false,
      runtimeReplay: false,
      qualityEvaluated: false,
      promotionAuthorized: false,
    });
    expect(report.strategies[1]).toMatchObject({ censored: 1, completed: 0, accountingGap: 0 });
    expect(JSON.stringify(report)).not.toContain(input.arrivals[0]!.sourceKey);
  });
  it('rejects stale identities, duplicate keyed samples, contradictory completion and overlapping intervals', () => {
    const input = scenario([arrival('one')]);
    expect(() => simulateCommercialAiRouting({ ...input, topologySha256: sha('stale') })).toThrow(
      'identity is stale',
    );
    const duplicate = structuredClone(input);
    duplicate.arrivals[0]!.observations.push(duplicate.arrivals[0]!.observations[0]!);
    expect(() => simulateCommercialAiRouting(duplicate)).toThrow('schema is invalid');
    const contradictory = structuredClone(input);
    contradictory.arrivals[0]!.observations[0]!.physicalCompletionMs = null;
    expect(() => simulateCommercialAiRouting(contradictory)).toThrow('schema is invalid');
    expect(() =>
      scenario([], {
        nodeIntervals: [
          { nodeId: 'pc-a-4b', kind: 'HELD', startMs: 0, endMs: 1000 },
          { nodeId: 'pc-a-4b', kind: 'OUTAGE', startMs: 500, endMs: 1500 },
        ],
      }),
    ).toThrow();
  });
  it('writes a private aggregate, refuses replacement and redacts malformed inputs and symlinks', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'commercial-ai-routing-'));
    const stdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const input = join(folder, 'input.json');
      const output = join(folder, 'output.json');
      await writeFile(input, JSON.stringify(scenario([arrival('one')])));
      await runCommercialAiRoutingSimulation(['--input', input, '--output', output]);
      expect((await stat(output)).mode & 0o777).toBe(0o600);
      expect(await readFile(output, 'utf8')).not.toContain(sha('source-one'));
      await expect(
        runCommercialAiRoutingSimulation(['--input', input, '--output', output]),
      ).rejects.toThrow('output could not be written');
      const link = join(folder, 'link.json');
      await symlink(input, link);
      await expect(
        runCommercialAiRoutingSimulation([
          '--input',
          link,
          '--output',
          join(folder, 'symlink.json'),
        ]),
      ).rejects.toThrow('file is invalid or unavailable');
      await writeFile(input, '{"PRIVATE SENTINEL":');
      await expect(
        runCommercialAiRoutingSimulation(['--input', input, '--output', join(folder, 'bad.json')]),
      ).rejects.toThrow('file is invalid or unavailable');
    } finally {
      stdout.mockRestore();
      await rm(folder, { recursive: true, force: true });
    }
  });
});
