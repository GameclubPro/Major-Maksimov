import { chmod, lstat, unlink } from 'node:fs/promises';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname } from 'node:path';
import {
  createNativeSandboxRecycle,
  writeNativeSandboxLifecycleEvent,
} from '../native-sandbox-recycle';

import {
  resolveCommercialOcrNativeEngineConfig,
  resolveCommercialOcrNativeRuntimeControls,
  resolveCommercialOcrProductionNativeConfigReader,
  resolveExpectedCommercialOcrProductionBehaviorIdentity,
  resolveVerifiedCommercialOcrNativeBehaviorIdentity,
  type CommercialOcrNativeBehaviorIdentity,
  type CommercialOcrNativeArtifactVerification,
} from './commercial-ocr-behavior-identity';
import { restrictNativeOcrSandboxEnvironment } from './native-ocr-sandbox.environment';
import {
  CommercialOcrImageRejectedError,
  resolveCommercialOcrPreprocessLimits,
} from './commercial-ocr-preprocess-config';
import type { NativeOcrImagePreprocessor } from './native-ocr-image-preprocessor';
import {
  decodeNativeOcrSandboxFrame,
  encodeNativeOcrSandboxFrame,
  inspectNativeOcrSandboxDeclaredFrameBytes,
  NATIVE_OCR_SANDBOX_FRAME_KINDS,
  NATIVE_OCR_SANDBOX_HEADER_BYTES,
  NATIVE_OCR_SANDBOX_IPC_GRACE_MS,
  NATIVE_OCR_SANDBOX_MAX_FRAME_BYTES,
  NATIVE_OCR_SANDBOX_MAX_PREPARED_IMAGE_BYTES,
  NATIVE_OCR_SANDBOX_MAX_REQUEST_METADATA_BYTES,
  NATIVE_OCR_SANDBOX_MAX_RESPONSE_METADATA_BYTES,
  NATIVE_OCR_SANDBOX_MAX_SOURCE_IMAGE_BYTES,
  NATIVE_OCR_SANDBOX_SOCKET_PATH_ENV,
  resolveNativeOcrSandboxSocketPath,
  type NativeOcrSandboxFrame,
  type NativeOcrSandboxFrameKind,
} from './native-ocr-sandbox.protocol';
import {
  nativeProcessGroupIsolationSupported,
  signalNativeProcessGroup,
  verifyNativeProcessGroupTeardown,
} from './native-process-group';
import { probeNativeTesseract, runNativeTesseract } from './native-tesseract-runner';
import {
  nativeOcrSandboxExecutionBudgetMs,
  parseNativeOcrSandboxDeadline,
  remainingNativeOcrSandboxTimeoutMs,
} from './native-ocr-sandbox.deadline';
import { assertNativeOcrSandboxSharedClock } from './native-ocr-sandbox.clock';
import {
  NATIVE_OCR_SANDBOX_REQUEST_FAILURE_REASONS,
  NativeOcrSandboxRollingMetric,
  type NativeOcrSandboxRequestFailureReason,
  type NativeOcrSandboxRuntimeStatus,
} from './native-ocr-sandbox.runtime';

const SOCKET_MODE = 0o600;
const REQUEST_RECEIVE_TIMEOUT_MS = 5_000;
const NATIVE_CONTAINMENT_GRACE_MS = 500;
const MAX_CONNECTIONS = 5;

const BOUNDARY_ATTESTATION = Object.freeze({
  transport: 'unix_socket',
  network: 'none',
  environment: 'allowlist',
  processGroupTeardown: 'verified_or_cgroup_recycle',
  instanceId: randomUUID(),
} as const);

type PendingRequest = {
  socket: Socket;
  frame: NativeOcrSandboxFrame;
  receivedAtNs: bigint;
  deadlineNs: bigint;
  timeoutMs: number;
  operation: 'preprocess' | 'recognize';
  expiryTimer: NodeJS.Timeout | null;
};

type NativeOcrSandboxRecycleReason =
  | 'native_timeout'
  | 'native_output_limit'
  | 'active_client_cancel'
  | 'sharp_deadline'
  | 'process_group_teardown_failed';
type NativeOcrSandboxLifecycleEvent = Readonly<{
  event: 'native_ocr_sandbox_recycle';
  reason: NativeOcrSandboxRecycleReason;
  operation: 'idle' | 'preprocess' | 'recognize';
  psm: 6 | 11 | 'unavailable';
  preprocessPass: 'primary' | 'confirmation' | 'unavailable';
  payloadBytes: number | 'unavailable';
  queueDepth: number;
  pendingBytes: number;
  requestedTimeoutMs: number | 'unavailable';
  executionBudgetMs: number | 'unavailable';
  queueWaitMs: number | 'unavailable';
  operationElapsedMs: number | 'unavailable';
}>;

export type NativeOcrSandboxServer = Readonly<{
  close: () => Promise<void>;
  socketPath: string;
}>;

export type NativeOcrSandboxServerDependencies = Readonly<{
  networkInterfaces: typeof networkInterfaces;
  verifyNativeIdentity: (
    config: Readonly<{ get(propertyPath: string): unknown }>,
    expected: CommercialOcrNativeBehaviorIdentity,
  ) => Promise<CommercialOcrNativeArtifactVerification>;
  probeNativeTesseract: typeof probeNativeTesseract;
  runNativeTesseract: typeof runNativeTesseract;
  createPreprocessor: (
    config: Readonly<{ get(propertyPath: string): unknown }>,
  ) => Promise<Pick<NativeOcrImagePreprocessor, 'prepare'>>;
  signalNativeProcessGroup: typeof signalNativeProcessGroup;
  verifyNativeProcessGroupTeardown: typeof verifyNativeProcessGroupTeardown;
  fatalExit: () => void;
  recordLifecycleEvent: (event: NativeOcrSandboxLifecycleEvent) => void | Promise<void>;
  allowTestSocketPath: boolean;
}>;

export async function startNativeOcrSandboxServer(
  environment: NodeJS.ProcessEnv = process.env,
  dependencyOverrides: Partial<NativeOcrSandboxServerDependencies> = {},
): Promise<NativeOcrSandboxServer> {
  const dependencies = resolveServerDependencies(dependencyOverrides);
  // FLAG: Normalize and verify isolation before loading Sharp or spawning Tesseract.
  restrictNativeOcrSandboxEnvironment(environment);
  assertNativeOcrSandboxSharedClock();
  if (!nativeProcessGroupIsolationSupported()) {
    throw new Error('Native OCR sandbox requires POSIX process-group isolation');
  }
  assertNativeOcrSandboxNetworkIsolated(dependencies.networkInterfaces());
  const config = environmentConfigReader(environment);
  const productionConfig = resolveCommercialOcrProductionNativeConfigReader(config);
  const socketPath = resolveNativeOcrSandboxSocketPath(
    environment[NATIVE_OCR_SANDBOX_SOCKET_PATH_ENV],
    { requireRuntimeDirectory: !dependencies.allowTestSocketPath },
  );
  if (!socketPath) {
    throw new Error(`${NATIVE_OCR_SANDBOX_SOCKET_PATH_ENV} is required`);
  }
  const controls = resolveCommercialOcrNativeRuntimeControls(productionConfig);
  if (controls.concurrency !== 1 || controls.ompThreadLimit !== 1) {
    throw new Error('Native OCR sandbox production concurrency must remain one');
  }
  const expected =
    resolveExpectedCommercialOcrProductionBehaviorIdentity(productionConfig).identity;
  const verification = await dependencies.verifyNativeIdentity(productionConfig, expected);
  if (
    !verification.verified ||
    !verification.identity.complete ||
    verification.identity.fingerprintSha256 !== expected.fingerprintSha256
  ) {
    throw new Error('Native OCR sandbox artifact identity verification failed');
  }
  const engine = resolveCommercialOcrNativeEngineConfig(productionConfig);
  let containmentFailed = false;
  const languageProbe = await dependencies.probeNativeTesseract({
    binary: engine.binary,
    ...(engine.tessdataPrefix ? { tessdataPrefix: engine.tessdataPrefix } : {}),
    timeoutMs: 4_000,
    maxOutputBytes: 64 * 1024,
    requireProcessGroupTeardown: true,
    onProcessGroupTeardownFailure: () => {
      containmentFailed = true;
    },
  });
  if (!languageProbe.ok || containmentFailed) {
    throw new Error('Native OCR sandbox language or process-group probe failed');
  }

  await assertOwnedSocketDirectory(socketPath);
  await removeOwnedStaleSocket(socketPath);
  const preprocessor = await dependencies.createPreprocessor(productionConfig);
  const pending: PendingRequest[] = [];
  const openSockets = new Set<Socket>();
  let pendingBytes = 0;
  let active = false;
  let activeSocket: Socket | null = null;
  let activeRequestKind: 'preprocess' | 'recognize' | null = null;
  let activeAttribution: Pick<
    NativeOcrSandboxLifecycleEvent,
    'psm' | 'preprocessPass' | 'payloadBytes'
  > | null = null;
  let activeTiming: {
    requestedTimeoutMs: number;
    executionBudgetMs: number;
    queueWaitMs: number;
    startedAtNs: bigint;
  } | null = null;
  let activeRequest: Promise<void> | null = null;
  let activeNativeProcess: ChildProcessWithoutNullStreams | null = null;
  let shuttingDown = false;
  const recycle = createNativeSandboxRecycle<NativeOcrSandboxLifecycleEvent>({
    fatalExit: dependencies.fatalExit,
    recordLifecycleEvent: dependencies.recordLifecycleEvent,
  });
  const maximumPendingBytes = Math.min(
    NATIVE_OCR_SANDBOX_MAX_FRAME_BYTES * controls.maxQueue,
    Math.max(controls.maxSourceImageBytes, controls.maxImageBytes) * controls.maxQueue,
  );
  const queueWaitMs = new NativeOcrSandboxRollingMetric();
  const preprocessDurationMs = new NativeOcrSandboxRollingMetric();
  const recognizeDurationMs = new NativeOcrSandboxRollingMetric();
  let activeExecutionDeadlineNs: bigint | null = null;
  const counters = {
    started: 0,
    completed: 0,
    failed: 0,
    probes: 0,
    rejections: Object.fromEntries(
      NATIVE_OCR_SANDBOX_REQUEST_FAILURE_REASONS.map((reason) => [reason, 0]),
    ) as Record<NativeOcrSandboxRequestFailureReason, number>,
  };
  const increment = (value: number): number => Math.min(Number.MAX_SAFE_INTEGER, value + 1);
  const runtimeStatus = (operationCompleted = false): NativeOcrSandboxRuntimeStatus => ({
    activeOperation: operationCompleted ? 'idle' : (activeRequestKind ?? 'idle'),
    queueDepth: pending.length,
    pendingBytes,
    queueWaitMs: queueWaitMs.snapshot(),
    durationMs: {
      preprocess: preprocessDurationMs.snapshot(),
      recognize: recognizeDurationMs.snapshot(),
    },
    remainingBudgetMs:
      operationCompleted || activeExecutionDeadlineNs === null
        ? null
        : remainingNativeOcrSandboxTimeoutMs(activeExecutionDeadlineNs),
    counters: { ...counters, rejections: { ...counters.rejections } },
  });
  const rejectRequest = (
    request: PendingRequest,
    reason: NativeOcrSandboxRequestFailureReason,
  ): void => {
    if (request.expiryTimer) clearTimeout(request.expiryTimer);
    queueWaitMs.record(Number(process.hrtime.bigint() - request.receivedAtNs) / 1_000_000);
    counters.rejections[reason] = increment(counters.rejections[reason]);
    respondFailure(
      request.socket,
      responseKindForRequest(request.frame.kind),
      expected,
      reason,
      runtimeStatus(),
    );
    request.frame.payload.fill(0);
  };

  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (shuttingDown || openSockets.size >= MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    openSockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => {
      openSockets.delete(socket);
      const pendingIndex = pending.findIndex((request) => request.socket === socket);
      if (pendingIndex >= 0) {
        const [abandoned] = pending.splice(pendingIndex, 1);
        if (abandoned) {
          if (abandoned.expiryTimer) clearTimeout(abandoned.expiryTimer);
          pendingBytes -= abandoned.frame.payload.byteLength;
          abandoned.frame.payload.fill(0);
        }
      }
      if (!shuttingDown && activeSocket === socket) {
        if (activeRequestKind === 'preprocess') {
          // Sharp has no reliable per-operation cancellation boundary. Recycle its cgroup.
          fatalContainmentFailure('active_client_cancel');
          return;
        }
        if (activeNativeProcess) {
          dependencies.signalNativeProcessGroup(activeNativeProcess, 'SIGKILL', {
            requireIsolatedGroup: true,
          });
          // A forced native cancellation must also cover descendants that escaped the PGID.
          fatalContainmentFailure('active_client_cancel');
        }
      }
    });
    void readRequest(socket, Math.max(controls.maxSourceImageBytes, controls.maxImageBytes))
      .then((frame) => {
        if (frame.kind === NATIVE_OCR_SANDBOX_FRAME_KINDS.probeRequest) {
          if (frame.payload.byteLength !== 0 || !hasExactKeys(frame.metadata, [])) {
            frame.payload.fill(0);
            socket.destroy();
            return;
          }
          counters.probes = increment(counters.probes);
          respondProbe(socket, verification.identity, runtimeStatus());
          return;
        }
        let request: PendingRequest;
        try {
          const input =
            frame.kind === NATIVE_OCR_SANDBOX_FRAME_KINDS.preprocessRequest
              ? validatePreprocessRequest(frame, controls.maxSourceImageBytes)
              : validateRecognizeRequest(frame, controls.maxImageBytes, controls.timeoutMs);
          request = {
            socket,
            frame,
            receivedAtNs: process.hrtime.bigint(),
            expiryTimer: null,
            deadlineNs: parseNativeOcrSandboxDeadline(
              frame.metadata.deadlineNs,
              input.timeoutMs + NATIVE_OCR_SANDBOX_IPC_GRACE_MS,
            ),
            timeoutMs: input.timeoutMs,
            operation:
              frame.kind === NATIVE_OCR_SANDBOX_FRAME_KINDS.preprocessRequest
                ? 'preprocess'
                : 'recognize',
          };
        } catch {
          counters.rejections.invalid_input = increment(counters.rejections.invalid_input);
          respondFailure(
            socket,
            responseKindForRequest(frame.kind),
            expected,
            'invalid_input',
            runtimeStatus(),
          );
          frame.payload.fill(0);
          return;
        }
        if (nativeOcrSandboxExecutionBudgetMs(request.deadlineNs, request.timeoutMs) < 1) {
          rejectRequest(request, 'request_deadline_exceeded');
          return;
        }
        if (
          shuttingDown ||
          pending.length >= controls.maxQueue ||
          pendingBytes + frame.payload.byteLength > maximumPendingBytes
        ) {
          rejectRequest(request, shuttingDown ? 'shutting_down' : 'capacity_exhausted');
          return;
        }
        pending.push(request);
        pendingBytes += frame.payload.byteLength;
        // FLAG: Expire only waiting work. Never cancel another request's active native
        // operation or reset the absolute deadline when draining the queue.
        request.expiryTimer = setTimeout(
          () => {
            const index = pending.indexOf(request);
            if (index < 0) return;
            pending.splice(index, 1);
            pendingBytes -= request.frame.payload.byteLength;
            rejectRequest(request, 'request_deadline_exceeded');
          },
          nativeOcrSandboxExecutionBudgetMs(request.deadlineNs, request.timeoutMs) + 1,
        );
        request.expiryTimer.unref();
        drain();
      })
      .catch(() => socket.destroy());
  });
  server.maxConnections = MAX_CONNECTIONS;

  const fatalContainmentFailure = (reason: NativeOcrSandboxRecycleReason): void => {
    if (shuttingDown) return;
    const event: NativeOcrSandboxLifecycleEvent = {
      event: 'native_ocr_sandbox_recycle',
      reason,
      operation: activeRequestKind ?? 'idle',
      psm: activeAttribution?.psm ?? 'unavailable',
      preprocessPass: activeAttribution?.preprocessPass ?? 'unavailable',
      payloadBytes: activeAttribution?.payloadBytes ?? 'unavailable',
      queueDepth: pending.length,
      pendingBytes,
      // FLAG: Only validated enums and finite scalars (or unavailable without active work) leave
      // this boundary; images, text, identities and absolute deadlines remain private.
      requestedTimeoutMs: activeTiming?.requestedTimeoutMs ?? 'unavailable',
      executionBudgetMs: activeTiming?.executionBudgetMs ?? 'unavailable',
      queueWaitMs: activeTiming?.queueWaitMs ?? 'unavailable',
      operationElapsedMs: activeTiming
        ? Math.max(
            0,
            Math.round(Number(process.hrtime.bigint() - activeTiming.startedAtNs) / 1_000_000),
          )
        : 'unavailable',
    };
    shuttingDown = true;
    process.exitCode = 1;
    server.close();
    for (const request of pending.splice(0)) {
      if (request.expiryTimer) clearTimeout(request.expiryTimer);
      request.frame.payload.fill(0);
      request.socket.destroy();
    }
    pendingBytes = 0;
    for (const socket of openSockets) socket.destroy();
    recycle(event);
  };

  const processRequest = async (request: PendingRequest): Promise<void> => {
    const { frame, socket } = request;
    const startedAtNs = process.hrtime.bigint();
    let resultRecorded = false;
    counters.started = increment(counters.started);
    const recordResult = (succeeded: boolean): void => {
      if (resultRecorded) return;
      resultRecorded = true;
      if (succeeded) counters.completed = increment(counters.completed);
      else counters.failed = increment(counters.failed);
      const duration = Number(process.hrtime.bigint() - startedAtNs) / 1_000_000;
      (request.operation === 'preprocess' ? preprocessDurationMs : recognizeDurationMs).record(
        duration,
      );
    };
    try {
      if (socket.destroyed) return;
      if (frame.kind === NATIVE_OCR_SANDBOX_FRAME_KINDS.preprocessRequest) {
        const input = validatePreprocessRequest(frame, controls.maxSourceImageBytes);
        activeAttribution = {
          psm: 'unavailable',
          preprocessPass: input.pass,
          payloadBytes: frame.payload.byteLength,
        };
        const hardDeadline = setTimeout(
          () => fatalContainmentFailure('sharp_deadline'),
          request.timeoutMs + NATIVE_CONTAINMENT_GRACE_MS,
        );
        try {
          const result = await preprocessor.prepare(frame.payload, input.pass, {
            deadlineAtMs: Date.now() + request.timeoutMs,
          });
          recordResult(true);
          respond(
            socket,
            NATIVE_OCR_SANDBOX_FRAME_KINDS.preprocessResponse,
            expected,
            {
              status: 'ok',
              width: result.width,
              height: result.height,
            },
            result.bytes,
            controls.maxImageBytes,
            runtimeStatus(true),
          );
          result.bytes.fill(0);
        } catch (error: unknown) {
          const reason =
            error instanceof CommercialOcrImageRejectedError ? error.reason : 'processing_timeout';
          recordResult(false);
          respondFailure(
            socket,
            NATIVE_OCR_SANDBOX_FRAME_KINDS.preprocessResponse,
            expected,
            reason,
            runtimeStatus(true),
          );
          if (reason === 'processing_timeout') {
            fatalContainmentFailure('sharp_deadline');
          }
        } finally {
          clearTimeout(hardDeadline);
        }
        return;
      }

      const input = validateRecognizeRequest(frame, controls.maxImageBytes, controls.timeoutMs);
      if (socket.destroyed) return;
      activeAttribution = {
        psm: input.psm,
        preprocessPass: 'unavailable',
        payloadBytes: frame.payload.byteLength,
      };
      let processGroupTeardownFailed = false;
      let requestNativeProcess: ChildProcessWithoutNullStreams | null = null;
      const result = await dependencies.runNativeTesseract({
        binary: engine.binary,
        ...(engine.tessdataPrefix ? { tessdataPrefix: engine.tessdataPrefix } : {}),
        image: frame.payload,
        psm: input.psm,
        timeoutMs: request.timeoutMs,
        maxOutputBytes: controls.maxOutputBytes,
        ompThreadLimit: controls.ompThreadLimit,
        requireProcessGroupTeardown: true,
        onProcessGroupTeardownFailure: () => {
          processGroupTeardownFailed = true;
        },
        onProcessChange: (child) => {
          if (child) {
            requestNativeProcess = child;
            activeNativeProcess = child;
            if (socket.destroyed) {
              dependencies.signalNativeProcessGroup(child, 'SIGKILL', {
                requireIsolatedGroup: true,
              });
              fatalContainmentFailure('active_client_cancel');
            }
          } else if (activeNativeProcess === requestNativeProcess) {
            activeNativeProcess = null;
          }
        },
      });
      if (processGroupTeardownFailed) {
        recordResult(false);
        socket.destroy();
        fatalContainmentFailure('process_group_teardown_failed');
        return;
      }
      recordResult(result.ok);
      respond(
        socket,
        NATIVE_OCR_SANDBOX_FRAME_KINDS.recognizeResponse,
        expected,
        { status: 'ok', result },
        Buffer.alloc(0),
        0,
        runtimeStatus(true),
      );
      if (!result.ok && (result.reason === 'timeout' || result.reason === 'output_limit')) {
        fatalContainmentFailure(
          result.reason === 'timeout' ? 'native_timeout' : 'native_output_limit',
        );
      }
    } catch {
      recordResult(false);
      respond(
        socket,
        responseKindForRequest(frame.kind),
        expected,
        { status: 'ok', result: { ok: false, reason: 'tesseract_failed' } },
        Buffer.alloc(0),
        0,
        runtimeStatus(true),
      );
    } finally {
      frame.payload.fill(0);
      recordResult(false);
    }
  };

  function drain(): void {
    if (active || shuttingDown) return;
    let request = pending.shift();
    while (request?.socket.destroyed) {
      if (request.expiryTimer) clearTimeout(request.expiryTimer);
      pendingBytes -= request.frame.payload.byteLength;
      request.frame.payload.fill(0);
      request = pending.shift();
    }
    if (!request) return;
    if (request.expiryTimer) clearTimeout(request.expiryTimer);
    pendingBytes -= request.frame.payload.byteLength;
    const executionBudgetMs = nativeOcrSandboxExecutionBudgetMs(
      request.deadlineNs,
      request.timeoutMs,
    );
    // Sharp's timer is whole-second based. An insufficient queue budget must not
    // start Sharp and subsequently recycle an otherwise healthy sandbox.
    if (executionBudgetMs < (request.operation === 'preprocess' ? 1_000 : 1)) {
      rejectRequest(request, 'request_deadline_exceeded');
      drain();
      return;
    }
    const startedAtNs = process.hrtime.bigint();
    const waitedMs = Number(startedAtNs - request.receivedAtNs) / 1_000_000;
    queueWaitMs.record(waitedMs);
    activeTiming = {
      requestedTimeoutMs: request.timeoutMs,
      executionBudgetMs,
      queueWaitMs: Math.max(0, Math.round(waitedMs)),
      startedAtNs,
    };
    activeExecutionDeadlineNs =
      request.deadlineNs - BigInt(NATIVE_OCR_SANDBOX_IPC_GRACE_MS) * 1_000_000n;
    request.timeoutMs = executionBudgetMs;
    active = true;
    activeSocket = request.socket;
    activeRequestKind =
      request.frame.kind === NATIVE_OCR_SANDBOX_FRAME_KINDS.preprocessRequest
        ? 'preprocess'
        : 'recognize';
    const operation = processRequest(request).finally(() => {
      active = false;
      activeAttribution = null;
      activeTiming = null;
      activeExecutionDeadlineNs = null;
      if (activeSocket === request.socket) {
        activeSocket = null;
        activeRequestKind = null;
      }
      if (activeRequest === operation) activeRequest = null;
      drain();
    });
    activeRequest = operation;
    void operation;
  }

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(socketPath);
  });
  try {
    await chmod(socketPath, SOCKET_MODE);
  } catch (error: unknown) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await removeOwnedStaleSocket(socketPath).catch(() => undefined);
    throw error;
  }

  return Object.freeze({
    socketPath,
    close: async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      for (const request of pending.splice(0)) {
        if (request.expiryTimer) clearTimeout(request.expiryTimer);
        request.frame.payload.fill(0);
        request.socket.destroy();
      }
      pendingBytes = 0;
      if (activeNativeProcess) {
        const nativeProcess = activeNativeProcess;
        if (
          !dependencies.signalNativeProcessGroup(nativeProcess, 'SIGKILL', {
            requireIsolatedGroup: true,
          }) ||
          !(await dependencies.verifyNativeProcessGroupTeardown(nativeProcess, {
            graceMs: NATIVE_CONTAINMENT_GRACE_MS,
            requireIsolatedGroup: true,
          }))
        ) {
          throw new Error('Native OCR sandbox could not verify process-group teardown');
        }
      }
      activeSocket = null;
      for (const socket of openSockets) socket.destroy();
      if (activeRequest) {
        await waitBounded(activeRequest, NATIVE_CONTAINMENT_GRACE_MS);
      }
      await waitBounded(
        new Promise<void>((resolve) => server.close(() => resolve())),
        NATIVE_CONTAINMENT_GRACE_MS,
      );
      await removeOwnedStaleSocket(socketPath);
    },
  });
}

export function assertNativeOcrSandboxNetworkIsolated(
  interfaces: ReturnType<typeof networkInterfaces>,
): void {
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses ?? []) {
      if (!address.internal || (name !== 'lo' && name !== 'lo0')) {
        throw new Error('Native OCR sandbox has a non-loopback network interface');
      }
    }
  }
}

async function readRequest(
  socket: Socket,
  maximumPayloadBytes: number,
): Promise<NativeOcrSandboxFrame> {
  const bytes = await readSingleFrame(
    socket,
    REQUEST_RECEIVE_TIMEOUT_MS,
    Math.min(
      NATIVE_OCR_SANDBOX_MAX_FRAME_BYTES,
      NATIVE_OCR_SANDBOX_HEADER_BYTES +
        NATIVE_OCR_SANDBOX_MAX_REQUEST_METADATA_BYTES +
        maximumPayloadBytes,
    ),
  );
  const frame = decodeNativeOcrSandboxFrame(bytes, {
    metadataBytes: NATIVE_OCR_SANDBOX_MAX_REQUEST_METADATA_BYTES,
    payloadBytes: maximumPayloadBytes,
  });
  if (
    frame.kind !== NATIVE_OCR_SANDBOX_FRAME_KINDS.probeRequest &&
    frame.kind !== NATIVE_OCR_SANDBOX_FRAME_KINDS.preprocessRequest &&
    frame.kind !== NATIVE_OCR_SANDBOX_FRAME_KINDS.recognizeRequest
  ) {
    throw new Error('Native OCR sandbox received a response frame');
  }
  socket.once('data', () => socket.destroy());
  socket.once('end', () => socket.destroy());
  socket.resume();
  return frame;
}

function readSingleFrame(socket: Socket, timeoutMs: number, maximumBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let declaredBytes: number | null = null;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.removeListener('data', onData);
      socket.removeListener('end', onEnd);
      socket.removeListener('error', onError);
      if (error) {
        reject(error);
      } else {
        resolve(Buffer.concat(chunks, receivedBytes));
      }
    };
    const onData = (chunk: Buffer) => {
      receivedBytes += chunk.byteLength;
      if (receivedBytes > maximumBytes) {
        finish(new Error('Native OCR sandbox request exceeds its byte limit'));
        socket.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
      if (declaredBytes === null && receivedBytes >= NATIVE_OCR_SANDBOX_HEADER_BYTES) {
        try {
          declaredBytes = inspectNativeOcrSandboxDeclaredFrameBytes(
            Buffer.concat(chunks, receivedBytes).subarray(0, NATIVE_OCR_SANDBOX_HEADER_BYTES),
          );
          if (declaredBytes > maximumBytes) {
            throw new Error('Native OCR sandbox declared frame exceeds its byte limit');
          }
        } catch (error: unknown) {
          finish(error instanceof Error ? error : new Error('Native OCR sandbox frame is invalid'));
          socket.destroy();
        }
      }
      if (declaredBytes !== null) {
        if (receivedBytes > declaredBytes) {
          finish(new Error('Native OCR sandbox request has trailing bytes'));
          socket.destroy();
        } else if (receivedBytes === declaredBytes) {
          socket.pause();
          finish();
        }
      }
    };
    const onEnd = () => {
      finish(new Error('Native OCR sandbox request frame is truncated'));
    };
    const onError = () => finish(new Error('Native OCR sandbox request socket failed'));
    const timeout = setTimeout(() => {
      finish(new Error('Native OCR sandbox request timed out'));
      socket.destroy();
    }, timeoutMs);
    timeout.unref();
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onError);
  });
}

function respondProbe(
  socket: Socket,
  identity: CommercialOcrNativeBehaviorIdentity,
  runtimeStatus: NativeOcrSandboxRuntimeStatus,
): void {
  respond(
    socket,
    NATIVE_OCR_SANDBOX_FRAME_KINDS.probeResponse,
    identity,
    {
      status: 'ok',
      identity: { fingerprintSha256: identity.fingerprintSha256, manifest: identity.manifest },
    },
    Buffer.alloc(0),
    0,
    runtimeStatus,
  );
}

function respondFailure(
  socket: Socket,
  kind: NativeOcrSandboxFrameKind,
  identity: CommercialOcrNativeBehaviorIdentity,
  reason: string,
  runtimeStatus: NativeOcrSandboxRuntimeStatus,
): void {
  respond(socket, kind, identity, { status: 'error', reason }, Buffer.alloc(0), 0, runtimeStatus);
}

function respond(
  socket: Socket,
  kind: NativeOcrSandboxFrameKind,
  identity: CommercialOcrNativeBehaviorIdentity,
  metadata: Readonly<Record<string, unknown>>,
  payload: Buffer,
  maximumPayloadBytes: number,
  runtimeStatus: NativeOcrSandboxRuntimeStatus,
): void {
  try {
    const frame = encodeNativeOcrSandboxFrame({
      kind,
      metadata: {
        ...metadata,
        fingerprintSha256: identity.fingerprintSha256,
        boundary: BOUNDARY_ATTESTATION,
        runtimeStatus,
      },
      payload,
      limits: {
        metadataBytes: NATIVE_OCR_SANDBOX_MAX_RESPONSE_METADATA_BYTES,
        payloadBytes: maximumPayloadBytes,
      },
    });
    socket.once('finish', () => frame.fill(0));
    socket.once('close', () => frame.fill(0));
    socket.end(frame);
  } catch {
    socket.destroy();
  }
}

function validatePreprocessRequest(
  frame: NativeOcrSandboxFrame,
  maximumImageBytes: number,
): { pass: 'primary' | 'confirmation'; timeoutMs: number } {
  if (
    frame.kind !== NATIVE_OCR_SANDBOX_FRAME_KINDS.preprocessRequest ||
    frame.payload.byteLength < 1 ||
    frame.payload.byteLength >
      Math.min(maximumImageBytes, NATIVE_OCR_SANDBOX_MAX_SOURCE_IMAGE_BYTES) ||
    (frame.metadata.pass !== 'primary' && frame.metadata.pass !== 'confirmation') ||
    !isIntegerBetween(frame.metadata.timeoutMs, 1, 5_000) ||
    !hasExactKeys(frame.metadata, ['pass', 'timeoutMs', 'deadlineNs'])
  ) {
    throw new Error('Native OCR sandbox preprocess request is invalid');
  }
  return {
    pass: frame.metadata.pass,
    timeoutMs: frame.metadata.timeoutMs as number,
  };
}

function validateRecognizeRequest(
  frame: NativeOcrSandboxFrame,
  maximumImageBytes: number,
  maximumTimeoutMs: number,
): { psm: 6 | 11; timeoutMs: number } {
  if (
    frame.kind !== NATIVE_OCR_SANDBOX_FRAME_KINDS.recognizeRequest ||
    frame.payload.byteLength < 1 ||
    frame.payload.byteLength >
      Math.min(maximumImageBytes, NATIVE_OCR_SANDBOX_MAX_PREPARED_IMAGE_BYTES) ||
    (frame.metadata.psm !== 6 && frame.metadata.psm !== 11) ||
    !isIntegerBetween(frame.metadata.timeoutMs, 1, maximumTimeoutMs) ||
    !hasExactKeys(frame.metadata, ['psm', 'timeoutMs', 'deadlineNs'])
  ) {
    throw new Error('Native OCR sandbox recognition request is invalid');
  }
  return { psm: frame.metadata.psm, timeoutMs: frame.metadata.timeoutMs as number };
}

function responseKindForRequest(kind: NativeOcrSandboxFrameKind): NativeOcrSandboxFrameKind {
  if (kind === NATIVE_OCR_SANDBOX_FRAME_KINDS.preprocessRequest) {
    return NATIVE_OCR_SANDBOX_FRAME_KINDS.preprocessResponse;
  }
  if (kind === NATIVE_OCR_SANDBOX_FRAME_KINDS.recognizeRequest) {
    return NATIVE_OCR_SANDBOX_FRAME_KINDS.recognizeResponse;
  }
  return NATIVE_OCR_SANDBOX_FRAME_KINDS.probeResponse;
}

function environmentConfigReader(environment: NodeJS.ProcessEnv) {
  return Object.freeze({ get: (propertyPath: string): unknown => environment[propertyPath] });
}

function resolveServerDependencies(
  overrides: Partial<NativeOcrSandboxServerDependencies>,
): NativeOcrSandboxServerDependencies {
  return Object.freeze({
    networkInterfaces: overrides.networkInterfaces ?? networkInterfaces,
    verifyNativeIdentity:
      overrides.verifyNativeIdentity ??
      ((config) => resolveVerifiedCommercialOcrNativeBehaviorIdentity(config)),
    probeNativeTesseract: overrides.probeNativeTesseract ?? probeNativeTesseract,
    runNativeTesseract: overrides.runNativeTesseract ?? runNativeTesseract,
    createPreprocessor:
      overrides.createPreprocessor ??
      (async (config) => {
        const { NativeOcrImagePreprocessor } = await import('./native-ocr-image-preprocessor');
        return new NativeOcrImagePreprocessor(resolveCommercialOcrPreprocessLimits(config));
      }),
    signalNativeProcessGroup: overrides.signalNativeProcessGroup ?? signalNativeProcessGroup,
    verifyNativeProcessGroupTeardown:
      overrides.verifyNativeProcessGroupTeardown ?? verifyNativeProcessGroupTeardown,
    fatalExit: overrides.fatalExit ?? (() => process.exit(1)),
    recordLifecycleEvent:
      overrides.recordLifecycleEvent ??
      // FLAG: One bounded identifier-free event is flushed before mandatory cgroup
      // recycle only within its hard budget; arbitrary errors, OCR text and images never enter it.
      writeNativeSandboxLifecycleEvent,
    allowTestSocketPath: overrides.allowTestSocketPath ?? false,
  });
}

async function removeOwnedStaleSocket(socketPath: string): Promise<void> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try {
    stat = await lstat(socketPath);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException | null | undefined)?.code === 'ENOENT') return;
    throw error;
  }
  if (!stat.isSocket() || stat.uid !== process.getuid?.() || stat.nlink !== 1) {
    throw new Error('Native OCR sandbox socket path is occupied by an unsafe entry');
  }
  await unlink(socketPath);
}

async function assertOwnedSocketDirectory(socketPath: string): Promise<void> {
  const directory = await lstat(dirname(socketPath));
  const currentUserId = process.getuid?.();
  if (
    !directory.isDirectory() ||
    currentUserId === undefined ||
    directory.uid !== currentUserId ||
    (directory.mode & 0o077) !== 0
  ) {
    throw new Error('Native OCR sandbox socket directory is unsafe');
  }
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    keys.every((key, index) => key === [...expected].sort()[index])
  );
}

function isIntegerBetween(value: unknown, minimum: number, maximum: number): boolean {
  return (
    Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
  );
}

async function waitBounded(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Native OCR sandbox shutdown timed out')),
          timeoutMs,
        );
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
