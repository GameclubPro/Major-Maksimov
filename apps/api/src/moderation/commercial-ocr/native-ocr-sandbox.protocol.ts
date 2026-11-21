import { isAbsolute } from 'node:path';

export const NATIVE_OCR_SANDBOX_PROTOCOL_VERSION = 2 as const;
export const NATIVE_OCR_SANDBOX_SOCKET_PATH_ENV =
  'COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH' as const;
export const NATIVE_OCR_SANDBOX_DEFAULT_SOCKET_PATH = '/run/maxim-ocr/native-ocr.sock';
export const NATIVE_OCR_SANDBOX_SOCKET_DIRECTORY = '/run/maxim-ocr';
export const NATIVE_OCR_SANDBOX_POOL_SOCKET_PATHS_ENV =
  'COMMERCIAL_OCR_NATIVE_SANDBOX_POOL_SOCKET_PATHS' as const;
export const NATIVE_OCR_SANDBOX_EXTRA_SOCKET_PATHS = [
  '/run/maxim-ocr-2/native-ocr.sock',
  '/run/maxim-ocr-3/native-ocr.sock',
] as const;
export const NATIVE_OCR_SANDBOX_POOL_SOCKET_PATHS = NATIVE_OCR_SANDBOX_EXTRA_SOCKET_PATHS.join(',');

export function resolveNativeOcrSandboxExtraPaths(
  primary: unknown,
  pool: unknown,
): readonly string[] {
  if (pool === undefined || pool === '') return [];
  if (
    primary !== NATIVE_OCR_SANDBOX_DEFAULT_SOCKET_PATH ||
    pool !== NATIVE_OCR_SANDBOX_POOL_SOCKET_PATHS
  ) {
    throw new Error(`${NATIVE_OCR_SANDBOX_POOL_SOCKET_PATHS_ENV} does not identify the OCR pool`);
  }
  return NATIVE_OCR_SANDBOX_EXTRA_SOCKET_PATHS;
}

export const NATIVE_OCR_SANDBOX_HEADER_BYTES = 16;
// FLAG: Native execution keeps its own limit. Reserve teardown (up to 500ms) and
// response delivery separately, once, inside the caller's immutable total budget.
export const NATIVE_OCR_SANDBOX_IPC_GRACE_MS = 1_000;
export const NATIVE_OCR_SANDBOX_MAX_REQUEST_METADATA_BYTES = 4 * 1024;
export const NATIVE_OCR_SANDBOX_MAX_RESPONSE_METADATA_BYTES = 4 * 1024 * 1024;
export const NATIVE_OCR_SANDBOX_MAX_SOURCE_IMAGE_BYTES = 32 * 1024 * 1024;
export const NATIVE_OCR_SANDBOX_MAX_PREPARED_IMAGE_BYTES = 64 * 1024 * 1024;
export const NATIVE_OCR_SANDBOX_MAX_FRAME_BYTES =
  NATIVE_OCR_SANDBOX_HEADER_BYTES +
  NATIVE_OCR_SANDBOX_MAX_RESPONSE_METADATA_BYTES +
  NATIVE_OCR_SANDBOX_MAX_PREPARED_IMAGE_BYTES;

const FRAME_MAGIC = Buffer.from('MXOR', 'ascii');
const SOCKET_PATH_PATTERN = /^\/[A-Za-z0-9._/-]+$/u;

export const NATIVE_OCR_SANDBOX_FRAME_KINDS = Object.freeze({
  probeRequest: 1,
  preprocessRequest: 2,
  recognizeRequest: 3,
  probeResponse: 129,
  preprocessResponse: 130,
  recognizeResponse: 131,
} as const);

export type NativeOcrSandboxFrameKind =
  (typeof NATIVE_OCR_SANDBOX_FRAME_KINDS)[keyof typeof NATIVE_OCR_SANDBOX_FRAME_KINDS];

export type NativeOcrSandboxFrame = Readonly<{
  kind: NativeOcrSandboxFrameKind;
  metadata: Readonly<Record<string, unknown>>;
  payload: Buffer;
}>;

export type NativeOcrSandboxFrameLimits = Readonly<{
  metadataBytes: number;
  payloadBytes: number;
  frameBytes?: number;
}>;

export function encodeNativeOcrSandboxFrame(params: {
  kind: NativeOcrSandboxFrameKind;
  metadata: Readonly<Record<string, unknown>>;
  payload?: Buffer;
  limits: NativeOcrSandboxFrameLimits;
}): Buffer {
  requireFrameKind(params.kind);
  const metadata = Buffer.from(JSON.stringify(params.metadata), 'utf8');
  const payload = params.payload ?? Buffer.alloc(0);
  const limits = normalizeFrameLimits(params.limits);
  requireBoundedLength(metadata.byteLength, limits.metadataBytes, 'metadata');
  requireBoundedLength(payload.byteLength, limits.payloadBytes, 'payload');
  const frameBytes = NATIVE_OCR_SANDBOX_HEADER_BYTES + metadata.byteLength + payload.byteLength;
  requireBoundedLength(frameBytes, limits.frameBytes, 'frame');

  const header = Buffer.alloc(NATIVE_OCR_SANDBOX_HEADER_BYTES);
  FRAME_MAGIC.copy(header, 0);
  header.writeUInt8(NATIVE_OCR_SANDBOX_PROTOCOL_VERSION, 4);
  header.writeUInt8(params.kind, 5);
  header.writeUInt16BE(0, 6);
  header.writeUInt32BE(metadata.byteLength, 8);
  header.writeUInt32BE(payload.byteLength, 12);
  return Buffer.concat([header, metadata, payload], frameBytes);
}

export function decodeNativeOcrSandboxFrame(
  bytes: Buffer,
  limitsInput: NativeOcrSandboxFrameLimits,
): NativeOcrSandboxFrame {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < NATIVE_OCR_SANDBOX_HEADER_BYTES) {
    throw new Error('Native OCR sandbox frame is incomplete');
  }
  const limits = normalizeFrameLimits(limitsInput);
  requireBoundedLength(bytes.byteLength, limits.frameBytes, 'frame');
  if (!bytes.subarray(0, FRAME_MAGIC.byteLength).equals(FRAME_MAGIC)) {
    throw new Error('Native OCR sandbox frame magic is invalid');
  }
  if (bytes.readUInt8(4) !== NATIVE_OCR_SANDBOX_PROTOCOL_VERSION) {
    throw new Error('Native OCR sandbox protocol version is unsupported');
  }
  const kind = bytes.readUInt8(5);
  requireFrameKind(kind);
  if (bytes.readUInt16BE(6) !== 0) {
    throw new Error('Native OCR sandbox frame reserved bits are non-zero');
  }
  const metadataBytes = bytes.readUInt32BE(8);
  const payloadBytes = bytes.readUInt32BE(12);
  requireBoundedLength(metadataBytes, limits.metadataBytes, 'metadata');
  requireBoundedLength(payloadBytes, limits.payloadBytes, 'payload');
  const expectedBytes = NATIVE_OCR_SANDBOX_HEADER_BYTES + metadataBytes + payloadBytes;
  if (bytes.byteLength !== expectedBytes) {
    throw new Error('Native OCR sandbox frame length is invalid');
  }

  let metadata: unknown;
  try {
    metadata = JSON.parse(
      bytes
        .subarray(NATIVE_OCR_SANDBOX_HEADER_BYTES, NATIVE_OCR_SANDBOX_HEADER_BYTES + metadataBytes)
        .toString('utf8'),
    ) as unknown;
  } catch {
    throw new Error('Native OCR sandbox frame metadata is invalid');
  }
  if (!isPlainRecord(metadata)) {
    throw new Error('Native OCR sandbox frame metadata must be an object');
  }
  return Object.freeze({
    kind: kind as NativeOcrSandboxFrameKind,
    metadata: Object.freeze(metadata),
    payload: bytes.subarray(expectedBytes - payloadBytes),
  });
}

export function inspectNativeOcrSandboxDeclaredFrameBytes(header: Buffer): number {
  if (!Buffer.isBuffer(header) || header.byteLength < NATIVE_OCR_SANDBOX_HEADER_BYTES) {
    throw new Error('Native OCR sandbox frame header is incomplete');
  }
  if (!header.subarray(0, FRAME_MAGIC.byteLength).equals(FRAME_MAGIC)) {
    throw new Error('Native OCR sandbox frame magic is invalid');
  }
  if (header.readUInt8(4) !== NATIVE_OCR_SANDBOX_PROTOCOL_VERSION) {
    throw new Error('Native OCR sandbox protocol version is unsupported');
  }
  requireFrameKind(header.readUInt8(5));
  if (header.readUInt16BE(6) !== 0) {
    throw new Error('Native OCR sandbox frame reserved bits are non-zero');
  }
  return NATIVE_OCR_SANDBOX_HEADER_BYTES + header.readUInt32BE(8) + header.readUInt32BE(12);
}

export function resolveNativeOcrSandboxSocketPath(
  value: unknown,
  options: Readonly<{ requireRuntimeDirectory?: boolean }> = {},
): string | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`${NATIVE_OCR_SANDBOX_SOCKET_PATH_ENV} must be a string`);
  }
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 100 ||
    normalized.includes('\0') ||
    !isAbsolute(normalized) ||
    !SOCKET_PATH_PATTERN.test(normalized) ||
    !normalized.endsWith('.sock') ||
    normalized.includes('//') ||
    normalized.includes('/./') ||
    normalized.includes('/../') ||
    normalized.endsWith('/..')
  ) {
    throw new Error(`${NATIVE_OCR_SANDBOX_SOCKET_PATH_ENV} is invalid`);
  }
  if (
    options.requireRuntimeDirectory &&
    !(NATIVE_OCR_SANDBOX_EXTRA_SOCKET_PATHS as readonly string[]).includes(normalized) &&
    !new RegExp(`^${NATIVE_OCR_SANDBOX_SOCKET_DIRECTORY}/[A-Za-z0-9._-]+\\.sock$`, 'u').test(
      normalized,
    )
  ) {
    throw new Error(
      `${NATIVE_OCR_SANDBOX_SOCKET_PATH_ENV} must be inside ${NATIVE_OCR_SANDBOX_SOCKET_DIRECTORY}`,
    );
  }
  return normalized;
}

function normalizeFrameLimits(
  limits: NativeOcrSandboxFrameLimits,
): Required<NativeOcrSandboxFrameLimits> {
  const frameBytes = limits.frameBytes ?? NATIVE_OCR_SANDBOX_MAX_FRAME_BYTES;
  for (const [name, value] of [
    ['metadataBytes', limits.metadataBytes],
    ['payloadBytes', limits.payloadBytes],
    ['frameBytes', frameBytes],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0 || value > NATIVE_OCR_SANDBOX_MAX_FRAME_BYTES) {
      throw new Error(`Native OCR sandbox ${name} limit is invalid`);
    }
  }
  return { ...limits, frameBytes };
}

function requireBoundedLength(actual: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(actual) || actual < 0 || actual > maximum) {
    throw new Error(`Native OCR sandbox ${label} exceeds its byte limit`);
  }
}

function requireFrameKind(value: number): asserts value is NativeOcrSandboxFrameKind {
  if (!(Object.values(NATIVE_OCR_SANDBOX_FRAME_KINDS) as readonly number[]).includes(value)) {
    throw new Error('Native OCR sandbox frame kind is invalid');
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
