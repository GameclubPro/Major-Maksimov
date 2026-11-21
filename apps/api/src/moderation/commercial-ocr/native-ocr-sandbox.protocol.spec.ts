import {
  decodeNativeOcrSandboxFrame,
  encodeNativeOcrSandboxFrame,
  NATIVE_OCR_SANDBOX_FRAME_KINDS,
  NATIVE_OCR_SANDBOX_HEADER_BYTES,
  resolveNativeOcrSandboxSocketPath,
  NATIVE_OCR_SANDBOX_EXTRA_SOCKET_PATHS,
} from './native-ocr-sandbox.protocol';

describe('native OCR sandbox protocol', () => {
  const limits = { metadataBytes: 128, payloadBytes: 16 } as const;

  it('round-trips binary payloads without text encoding', () => {
    const payload = Buffer.from([0, 255, 1, 128, 7]);
    const encoded = encodeNativeOcrSandboxFrame({
      kind: NATIVE_OCR_SANDBOX_FRAME_KINDS.preprocessRequest,
      metadata: { pass: 'primary', timeoutMs: 5_000 },
      payload,
      limits,
    });
    const decoded = decodeNativeOcrSandboxFrame(encoded, limits);

    expect(decoded.kind).toBe(NATIVE_OCR_SANDBOX_FRAME_KINDS.preprocessRequest);
    expect(decoded.metadata).toEqual({ pass: 'primary', timeoutMs: 5_000 });
    expect(decoded.payload).toEqual(payload);
    expect(encoded.subarray(encoded.byteLength - payload.byteLength)).toEqual(payload);
  });

  it('rejects oversized, truncated, trailing and version-drifted frames', () => {
    expect(() =>
      encodeNativeOcrSandboxFrame({
        kind: NATIVE_OCR_SANDBOX_FRAME_KINDS.recognizeRequest,
        metadata: {},
        payload: Buffer.alloc(17),
        limits,
      }),
    ).toThrow('payload exceeds');

    const valid = encodeNativeOcrSandboxFrame({
      kind: NATIVE_OCR_SANDBOX_FRAME_KINDS.probeRequest,
      metadata: {},
      limits,
    });
    expect(() => decodeNativeOcrSandboxFrame(valid.subarray(0, -1), limits)).toThrow(
      'length is invalid',
    );
    expect(() =>
      decodeNativeOcrSandboxFrame(Buffer.concat([valid, Buffer.from([0])]), limits),
    ).toThrow('length is invalid');
    const drifted = Buffer.from(valid);
    drifted.writeUInt8(1, 4);
    expect(() => decodeNativeOcrSandboxFrame(drifted, limits)).toThrow(
      'protocol version is unsupported',
    );
  });

  it('uses a fixed header and validates the production socket directory', () => {
    const frame = encodeNativeOcrSandboxFrame({
      kind: NATIVE_OCR_SANDBOX_FRAME_KINDS.probeRequest,
      metadata: {},
      limits,
    });
    expect(frame.byteLength).toBe(NATIVE_OCR_SANDBOX_HEADER_BYTES + 2);
    expect(
      resolveNativeOcrSandboxSocketPath('/run/maxim-ocr/native-ocr.sock', {
        requireRuntimeDirectory: true,
      }),
    ).toBe('/run/maxim-ocr/native-ocr.sock');
    for (const path of NATIVE_OCR_SANDBOX_EXTRA_SOCKET_PATHS) {
      expect(resolveNativeOcrSandboxSocketPath(path, { requireRuntimeDirectory: true })).toBe(path);
    }
    expect(() =>
      resolveNativeOcrSandboxSocketPath('/run/maxim-ocr-4/native-ocr.sock', {
        requireRuntimeDirectory: true,
      }),
    ).toThrow('must be inside');
    expect(() =>
      resolveNativeOcrSandboxSocketPath('/tmp/native-ocr.sock', {
        requireRuntimeDirectory: true,
      }),
    ).toThrow('must be inside');
  });
});
