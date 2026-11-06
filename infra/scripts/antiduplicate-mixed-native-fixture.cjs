'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const runtime = '/app/apps/api/dist/apps/api/src';

function compose(source, owner) {
  assert.match(owner, /^antiduplicate-mixed-ci-[a-z0-9-]+$/u);
  const lines = source.split('\n');
  const service = (name) => {
    const start = lines.indexOf(`  ${name}:`);
    assert.ok(start >= 0);
    const end = lines.findIndex((line, index) => index > start && /^\S|^ {2}\S/u.test(line));
    const block = lines.slice(start, end < 0 ? undefined : end).join('\n');
    assert.equal((block.match(/^ {4}labels:$/gmu) ?? []).length, 1);
    // FLAG: Use the checked-in production boundary, with only an ownership label added.
    return block.replace(
      '    labels:\n',
      `    labels:\n      com.maxim.mixed-native-ci: '${owner}'\n`,
    );
  };
  return `x-default-logging: &default-logging
  driver: json-file
  options: {max-size: '1m', max-file: '1'}
services:
${service('photo-native-sandbox')}
${service('ocr-native-sandbox')}
volumes:
  photo_native_ipc: {}
  ocr_native_ipc: {}
`;
}

function resources() {
  const read = (name) => fs.readFileSync(`/sys/fs/cgroup/${name}`, 'utf8').trim();
  const cpu = Object.fromEntries(
    read('cpu.stat')
      .split('\n')
      .map((line) => line.split(' ')),
  );
  const [quota, period] = read('cpu.max').split(' ').map(Number);
  assert.equal(quota, period);
  assert.equal(read('memory.max'), '1073741824');
  assert.ok(['64', '128'].includes(read('pids.max')));
  assert.equal(process.getuid(), 1000);
  assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /^NoNewPrivs:\s+1$/mu);
  assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /^CapEff:\s+0+$/mu);
  return { cpuUsec: Number(cpu.usage_usec), memoryPeakBytes: Number(read('memory.peak')) };
}

async function prepareJpegRecompressionFixture(sharp, algorithmVersion) {
  const width = 2000,
    height = 2000;
  const raw = Buffer.alloc(width * height * 3);
  let value = 0x1234abcd;
  for (let index = 0; index < raw.length; index += 3) {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    raw[index] = value & 255;
    raw[index + 1] = (value >>> 8) & 255;
    raw[index + 2] = (value >>> 16) & 255;
  }
  const original = await sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 92, chromaSubsampling: '4:2:0' })
    .toBuffer();
  const current = await sharp(original)
    .jpeg({ quality: 50, chromaSubsampling: '4:2:0' })
    .toBuffer();
  const encodedBytes = original.length + current.length;
  assert.ok(encodedBytes <= 16777216);
  const decode = async (input) => {
    const decoded = await sharp(input, { failOn: 'warning', limitInputPixels: width * height })
      .rotate()
      .toColourspace('srgb')
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    assert.equal(decoded.info.width, width);
    assert.equal(decoded.info.height, height);
    assert.equal(decoded.info.channels, 4);
    assert.equal(decoded.data.length, width * height * 4);
    return decoded;
  };
  const a = await decode(original);
  const b = await decode(current);
  const hash = (data) =>
    createHash('sha256')
      .update(`${algorithmVersion}\0${width}x${height}x4\0`)
      .update(data)
      .digest('hex');
  const originalHash = hash(a.data);
  const currentHash = hash(b.data);
  assert.notEqual(originalHash, currentHash);
  // FLAG: Independent client oracles must force the new JPEG path, not merely
  // pass the old grayscale residual. All preparation stays outside timed work.
  const gray = (data) =>
    sharp(data, { raw: { width, height, channels: 4 } })
      .removeAlpha()
      .greyscale()
      .raw()
      .toBuffer();
  const grayA = await gray(a.data);
  const grayB = await gray(b.data);
  assert.equal(grayA.length, width * height);
  assert.equal(grayB.length, grayA.length);
  let squared = 0;
  for (let index = 0; index < grayA.length; index += 1)
    squared += (grayA[index] - grayB[index]) ** 2;
  assert.ok(squared > grayA.length * 3.5 ** 2);
  return { original, current, originalHash, currentHash, encodedBytes, pixels: width * height * 2 };
}

async function workload(mode) {
  assert.ok(['warmup', 'photo', 'ocr', 'mixed'].includes(mode));
  const { NativePhotoSandboxClient } = require(
    `${runtime}/moderation/photo-duplicate/native-photo-sandbox.client.js`,
  );
  const { PHOTO_FINGERPRINT_ALGORITHM_VERSION } = require(
    `${runtime}/moderation/photo-duplicate/photo-fingerprint-version.js`,
  );
  const { runCommercialOcrWorkerSmoke } = require(
    `${runtime}/scripts/smoke-commercial-ocr-worker.js`,
  );
  const client = new NativePhotoSandboxClient('/run/maxim-photo/native-photo.sock');
  await client.probe();
  const { PhotoFingerprintService } = require(
    `${runtime}/moderation/photo-duplicate/photo-fingerprint.js`,
  );
  let jpegNativeRequests = 0;
  const nativeRecompression = client.verifyRecompression.bind(client);
  client.verifyRecompression = (...args) => {
    jpegNativeRequests += 1;
    return nativeRecompression(...args);
  };
  const jpegVerifier = new PhotoFingerprintService({
    canonicalOnly: true,
    nativeDecoder: client,
    maxInputBytes: 16777216,
    maxInputPixels: 40000000,
  });
  const sharp = require('/app/node_modules/sharp');
  // Synthetic uncompressed pixels are the independent exact-hash oracle. Fixture
  // encoding is outside the timed work and occurs only in this isolated CI client.
  const width = 1024,
    height = 768;
  const raw = Buffer.alloc(width * height * 4);
  for (let i = 0; i < raw.length; i += 4) {
    raw[i] = (i >>> 2) % 251;
    raw[i + 1] = (i >>> 12) % 241;
    raw[i + 2] = 87;
    raw[i + 3] = 255;
  }
  const input = await sharp(raw, {
    raw: { width, height, channels: 4 },
  })
    .png()
    .toBuffer();
  const expected = createHash('sha256')
    .update(`${PHOTO_FINGERPRINT_ALGORITHM_VERSION}\0${width}x${height}x4\0`)
    .update(raw)
    .digest('hex');
  const jpegFixture =
    mode === 'photo' || mode === 'mixed'
      ? await prepareJpegRecompressionFixture(sharp, PHOTO_FINGERPRINT_ALGORITHM_VERSION)
      : null;
  const jpegRecompressionMs = [];
  const jpegContentMemoMs = [];
  const photo = async (count) => {
    const latencies = [];
    if (jpegFixture) {
      assert.equal(count, 10);
      const started = performance.now();
      const result = await jpegVerifier.verifyRecompression(
        jpegFixture.original,
        jpegFixture.current,
        { deadlineAtMs: Date.now() + 10000 },
      );
      assert.deepEqual(result, {
        kind: 'recompression',
        matched: true,
        proof: {
          version: 'native-recompression-v2',
          originalHash: jpegFixture.originalHash,
          currentHash: jpegFixture.currentHash,
        },
        decodeCost: { encodedBytes: jpegFixture.encodedBytes, pixels: jpegFixture.pixels },
      });
      jpegRecompressionMs.push(performance.now() - started);
      // FLAG: Fresh independent byte buffers may reuse computation only after exact
      // hashing. The native call counter proves no second process handled this pair.
      const repeatedOriginal = Buffer.from(jpegFixture.original);
      const repeatedCurrent = Buffer.from(jpegFixture.current);
      const memoStarted = performance.now();
      const repeated = await jpegVerifier.verifyRecompression(repeatedOriginal, repeatedCurrent, {
        deadlineAtMs: Date.now() + 10000,
      });
      jpegContentMemoMs.push(performance.now() - memoStarted);
      assert.deepEqual(repeated, result);
      assert.equal(jpegNativeRequests, 1);
    }
    for (let i = 0; i < count; i++) {
      const started = performance.now();
      const result = await client.fingerprint(input, {
        deadlineAtMs: Date.now() + 10000,
        maxInputBytes: 16777216,
        maxInputPixels: 40000000,
        remainingEncodedBytes: input.length,
        remainingPixels: width * height,
        expectedFormat: 'png',
      });
      assert.equal(result.kind, 'complete');
      assert.equal(result.fingerprint.canonicalHash, expected);
      latencies.push(performance.now() - started);
    }
    return latencies;
  };
  const ocr = async (count) => {
    const latencies = [];
    for (let i = 0; i < count; i++) {
      const started = performance.now();
      await runCommercialOcrWorkerSmoke();
      latencies.push(performance.now() - started);
    }
    return latencies;
  };
  const started = performance.now();
  const [photoMs, ocrMs] =
    mode === 'warmup'
      ? [await photo(1), await ocr(1)]
      : await Promise.all([mode === 'ocr' ? [] : photo(10), mode === 'photo' ? [] : ocr(3)]);
  assert.equal(jpegRecompressionMs.length, jpegFixture ? 1 : 0);
  assert.equal(jpegContentMemoMs.length, jpegFixture ? 1 : 0);
  assert.equal(jpegNativeRequests, jpegFixture ? 1 : 0);
  return {
    schemaVersion: 1,
    mode,
    photoRequests: photoMs.length,
    ocrRequests: ocrMs.length,
    photoMs,
    ocrMs,
    elapsedMs: performance.now() - started,
    photoEncodedBytes: input.length,
    photoPixels: width * height,
    jpegRecompressionRequests: jpegRecompressionMs.length,
    jpegRecompressionMs,
    jpegNativeRequests,
    jpegContentMemoRequests: jpegContentMemoMs.length,
    jpegContentMemoMs,
    jpegRecompressionEncodedBytes: jpegFixture?.encodedBytes ?? 0,
    jpegRecompressionPixels: jpegFixture?.pixels ?? 0,
  };
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'compose')
    return fs.writeFileSync(args[1], compose(fs.readFileSync(args[0], 'utf8'), args[2]));
  if (mode === 'resources') return process.stdout.write(JSON.stringify(resources()));
  process.stdout.write(JSON.stringify(await workload(mode)) + '\n');
}
module.exports = { compose };
if (require.main === module || (module.id === '[stdin]' && process.argv[1] === '-'))
  main().catch((error) => {
    process.stderr.write(String(error.stack) + '\n');
    process.exitCode = 1;
  });
