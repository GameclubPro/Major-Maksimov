import { ConfigService } from '@nestjs/config';

import { CommercialOcrPreprocessor } from '../moderation/commercial-ocr/commercial-ocr-preprocessor';
import { NativeOcrSandboxPool } from '../moderation/commercial-ocr/native-ocr-sandbox.pool';
import { NativeTesseractOcrAdapter } from '../moderation/commercial-ocr/native-tesseract-ocr.adapter';

const STARTUP_TIMEOUT_MS = 15_000;
const RECOGNITION_TIMEOUT_MS = 8_000;
const CYRILLIC_SERVICE_TEXT = 'РЕМОНТ КВАРТИР';
const LATIN_SERVICE_TEXT = 'REPAIR SERVICE';
const CYRILLIC_CALL_TO_ACTION = 'ЗВОНИТЕ';
const EXPECTED_PHONE_DIGITS = '79991234567';

export async function runCommercialOcrWorkerSmoke(expectedReadyLanes?: number): Promise<void> {
  const config = createCommercialOcrWorkerSmokeConfig();
  const pool = new NativeOcrSandboxPool(config);
  const adapter = new NativeTesseractOcrAdapter(config, pool);
  const preprocessor = new CommercialOcrPreprocessor(config, pool);
  const readyLanes = expectedReadyLanes ?? pool.count;
  if (!Number.isInteger(readyLanes) || readyLanes < 1 || readyLanes > pool.count) {
    throw new Error('Invalid expected number of ready OCR lanes');
  }
  adapter.onModuleInit();
  try {
    await waitForReady(adapter, STARTUP_TIMEOUT_MS, readyLanes);
    await Promise.allSettled(
      Array.from({ length: readyLanes }, async () => {
        let prepared: Buffer | null = null;
        try {
          prepared = (
            await preprocessor.prepare(buildSmokeVector(), 'confirmation', {
              deadlineAtMs: Date.now() + RECOGNITION_TIMEOUT_MS,
            })
          ).bytes;
          const result = await adapter.recognize(prepared, {
            psm: 6,
            passLabel: 'deploy-smoke',
            deadlineAtMs: Date.now() + RECOGNITION_TIMEOUT_MS,
          });
          if (!result.ok) {
            throw new Error(`Commercial OCR worker smoke failed open: ${result.reason}`);
          }
          assertCommercialOcrWorkerSmokeText(result.text);
        } finally {
          prepared?.fill(0);
        }
      }),
    ).then((results) => {
      const failure = results.find((result) => result.status === 'rejected');
      if (failure) throw failure.reason;
    });
  } finally {
    await adapter.onModuleDestroy();
  }
}

export function createCommercialOcrWorkerSmokeConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ConfigService {
  // Media analysis verifies every native control against its production behavior identity.
  return new ConfigService({ ...environment });
}

export function assertCommercialOcrWorkerSmokeText(text: string): void {
  const normalized = text
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const digits = text.replace(/\D+/gu, '');
  if (
    !normalized.includes(CYRILLIC_SERVICE_TEXT) ||
    !normalized.includes(LATIN_SERVICE_TEXT) ||
    !normalized.includes(CYRILLIC_CALL_TO_ACTION) ||
    !digits.includes(EXPECTED_PHONE_DIGITS)
  ) {
    throw new Error('Commercial OCR worker smoke did not recognize the expected opaque fixture');
  }
}

async function waitForReady(
  adapter: NativeTesseractOcrAdapter,
  timeoutMs: number,
  readyLanes: number,
): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    const status = adapter.getRuntimeStatus();
    if (status.ready && status.workers.ready === readyLanes) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Commercial OCR worker did not become ready: ${adapter.getRuntimeStatus().state}`,
  );
}

function buildSmokeVector(): Buffer {
  return Buffer.from(
    [
      '<svg width="1400" height="390" xmlns="http://www.w3.org/2000/svg">',
      '<rect width="1400" height="390" fill="white"/>',
      '<text x="60" y="100" font-family="DejaVu Sans" font-size="64" font-weight="700">',
      CYRILLIC_SERVICE_TEXT,
      '</text>',
      '<text x="60" y="215" font-family="DejaVu Sans" font-size="64" font-weight="700">',
      LATIN_SERVICE_TEXT,
      '</text>',
      '<text x="60" y="330" font-family="DejaVu Sans" font-size="64" font-weight="700">',
      `${CYRILLIC_CALL_TO_ACTION} +7 999 123 45 67`,
      '</text>',
      '</svg>',
    ].join(''),
    'utf8',
  );
}

if (require.main === module) {
  void runCommercialOcrWorkerSmoke(
    process.argv[2] === undefined ? undefined : Number(process.argv[2]),
  )
    .then(() => process.stdout.write('Commercial OCR worker smoke passed.\n'))
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
