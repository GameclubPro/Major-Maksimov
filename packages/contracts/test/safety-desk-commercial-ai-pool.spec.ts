import { describe, expect, it } from 'vitest';
import {
  commercialAiPoolDiagnosticsSchema,
  safetyDeskCommercialAiPoolResponseSchema,
} from '../src/safety-desk';

const nodeOrder = ['server-9b', 'pc-a-4b', 'pc-b-9b', 'pc-a-cpu-9b'];
const nodeStates = (ids: string[]) =>
  ids.map((nodeId) => ({ nodeId, state: 'READY', validUntil: null }));
const diagnostics = (ids: string[]) => ({
  schemaVersion: 1,
  nodes: ids.map((nodeId) => ({
    nodeId,
    completedAttempts: 0,
    failedAttempts: 0,
    lastCompletedAt: null,
    lastFailureAt: null,
    ewmaDurationMs: null,
  })),
  consultations: { completed: 0, noCapacity: 0, budgetExhausted: 0 },
});
const snapshot = {
  schemaVersion: 1,
  generatedAt: '2026-10-28T12:00:00.000Z',
  observedAt: null,
  workersEnabled: true,
  routingEnabled: true,
  policy: 'confirm-positive',
  availability: 'UNAVAILABLE',
  nodes: null,
  metrics: null,
  trafficCoverage: 'NOT_ESTABLISHED',
  confirmedDeletes: null,
};
describe('pool diagnostic contract', () => {
  it('preserves unavailable observations without invented counts or deletions', () => {
    expect(safetyDeskCommercialAiPoolResponseSchema.parse(snapshot)).toEqual(snapshot);
  });
  it.each([3, 4])('preserves the canonical %i-node observation without adding nodes', (length) => {
    const ids = nodeOrder.slice(0, length);
    const nodes = nodeStates(ids);
    expect(safetyDeskCommercialAiPoolResponseSchema.parse({ ...snapshot, nodes }).nodes).toEqual(
      nodes,
    );
    expect(commercialAiPoolDiagnosticsSchema.parse(diagnostics(ids))).toEqual(diagnostics(ids));
  });
  it('keeps old process metrics independent of the fourth node readiness', () => {
    const metrics = {
      availability: 'FRESH',
      observedAt: snapshot.generatedAt,
      observationProcessId: '1348126b-9210-4a0e-88cb-e8c1afbd959e',
      observationStartedAt: snapshot.generatedAt,
      basis: 'PROCESS_MODEL_ATTEMPTS',
      diagnostics: diagnostics(nodeOrder.slice(0, 3)),
    };
    const result = safetyDeskCommercialAiPoolResponseSchema.parse({
      ...snapshot,
      nodes: nodeStates(nodeOrder),
      metrics,
    });
    expect(result.nodes).toHaveLength(4);
    expect(result.metrics).toEqual(metrics);
    expect(result.metrics?.diagnostics.nodes).toHaveLength(3);
  });
  it.each(
    [
      ['server-9b', 'pc-a-4b'],
      ['server-9b', 'pc-a-4b', 'pc-a-cpu-9b'],
      ['server-9b', 'pc-a-4b', 'pc-b-9b', 'pc-b-9b'],
      ['server-9b', 'pc-a-cpu-9b', 'pc-a-4b', 'pc-b-9b'],
      ['pc-a-4b', 'server-9b', 'pc-b-9b'],
      [...nodeOrder, 'pc-a-cpu-9b'],
      ['server-9b', 'pc-a-4b', 'pc-b-9b', 'unknown-9b'],
    ].map((ids) => ({ ids })),
  )('rejects noncanonical node observations $ids', ({ ids }) => {
    expect(
      safetyDeskCommercialAiPoolResponseSchema.safeParse({
        ...snapshot,
        nodes: nodeStates(ids),
      }).success,
    ).toBe(false);
    expect(commercialAiPoolDiagnosticsSchema.safeParse(diagnostics(ids)).success).toBe(false);
  });
  it.each([
    { confirmedDeletes: 1 },
    { token: 'secret' },
    { policy: 'automatic' },
    { nodes: [] },
    { trafficCoverage: 'COMPLETE' },
  ])('rejects unsupported evidence %j', (patch) => {
    expect(
      safetyDeskCommercialAiPoolResponseSchema.safeParse({ ...snapshot, ...patch }).success,
    ).toBe(false);
  });
  it('refuses duplicated nodes and extra ownership fields', () => {
    const node = { nodeId: 'pc-a-4b', state: 'READY', validUntil: null };
    expect(
      safetyDeskCommercialAiPoolResponseSchema.safeParse({ ...snapshot, nodes: [node, node, node] })
        .success,
    ).toBe(false);
    const nodes = nodeStates(nodeOrder);
    expect(safetyDeskCommercialAiPoolResponseSchema.safeParse({ ...snapshot, nodes }).success).toBe(
      true,
    );
    expect(
      safetyDeskCommercialAiPoolResponseSchema.safeParse({
        ...snapshot,
        nodes: nodes.map((n) => ({ ...n, session: 'private' })),
      }).success,
    ).toBe(false);
    const metrics = diagnostics(nodeOrder);
    expect(
      commercialAiPoolDiagnosticsSchema.safeParse({
        ...metrics,
        nodes: metrics.nodes.map((n) => ({ ...n, session: 'private' })),
      }).success,
    ).toBe(false);
  });
});
