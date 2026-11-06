export const MESSAGE_DUPLICATE_PHASES = [
  'policy',
  'source',
  'prehead_wait',
  'governor_gate',
  'governor_wait',
  'proof_read',
  'photo_download',
  'binary_download',
  'media',
  'history',
  'enforcement',
  'download',
  'decode_wait',
  'native_roundtrip',
  'local_fingerprint',
  'recompression_decode_wait',
  'recompression_native_roundtrip',
  'recompression_reuse',
  'local_recompression',
  'ordering_acquire',
  'qualification',
  'intent_handoff',
  'delete_dispatch',
  'delete_receipt',
  'cleanup',
  'cleanup_sweep',
] as const;
export type MessageDuplicatePhase = (typeof MESSAGE_DUPLICATE_PHASES)[number];
export type DuplicatePhaseRecorder = {
  recordPhase: (phase: MessageDuplicatePhase, elapsedMs: number) => void;
};

export function recordDuplicatePhase(
  metrics: DuplicatePhaseRecorder | undefined,
  phase: MessageDuplicatePhase,
  elapsedMs: number,
): void {
  // FLAG: Only fixed labels and durations cross this optional observer boundary.
  // Observer faults must not replace a result, error, ownership check or native teardown.
  try {
    metrics?.recordPhase?.(phase, elapsedMs);
  } catch {
    /* FLAG: Telemetry cannot replace the moderation outcome. */
  }
}

export async function measureDuplicatePhase<T>(
  metrics: DuplicatePhaseRecorder | undefined,
  phase: MessageDuplicatePhase,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    recordDuplicatePhase(metrics, phase, performance.now() - startedAt);
  }
}
