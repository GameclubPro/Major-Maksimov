import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const COMPOSE_FILES = [
  ['main', '../../../../infra/docker-compose.yml'],
  ['scale', '../../../../infra/docker-compose.scale.yml'],
] as const;

describe('production Compose commercial OCR isolation', () => {
  describe.each(COMPOSE_FILES)('%s compose', (name, composePath) => {
    const compose = readFileSync(resolve(__dirname, composePath), 'utf8');
    const mediaAnalysis = readServiceBlock(compose, 'api-media-analysis');
    const nativeSandbox = readServiceBlock(compose, 'ocr-native-sandbox');

    it('uses one fail-safe rollout, canary allowlist, and OCR version across API roles', () => {
      expect(mediaAnalysis).toContain('${MAXIM_COMPOSE_SERVICE_ENV_FILE:-../.env}');
      expect(mediaAnalysis).not.toMatch(/^\s+COMMERCIAL_OCR_ROLLOUT_MODE:/mu);
      expect(mediaAnalysis).not.toMatch(/^\s+COMMERCIAL_OCR_CANARY_CHAT_IDS:/mu);
      expect(mediaAnalysis).not.toMatch(/^\s+COMMERCIAL_OCR_VERSION:/mu);
      expect(compose).toMatch(
        /^ {2}COMMERCIAL_OCR_ROLLOUT_MODE: \$\{COMMERCIAL_OCR_ROLLOUT_MODE:-shadow\}$/mu,
      );
      expect(compose).toMatch(
        /^ {2}COMMERCIAL_OCR_CANARY_CHAT_IDS: \$\{COMMERCIAL_OCR_CANARY_CHAT_IDS:-\}$/mu,
      );
      expect(compose).toMatch(
        /^ {2}COMMERCIAL_OCR_VERSION: \$\{COMMERCIAL_OCR_VERSION:-tesseract-rus-eng-v2\}$/mu,
      );
      expect(compose).toMatch(
        /^ {2}IMAGE_TEXT_STOP_LIST_OCR_ROLLOUT_MODE: \$\{IMAGE_TEXT_STOP_LIST_OCR_ROLLOUT_MODE:-on\}$/mu,
      );
    });

    it('checks host pressure before admitting OCR behind an unrelated queue backlog', () => {
      expect(mediaAnalysis).toMatch(
        /^\s+BACKGROUND_GOVERNOR_SYSTEM_PRESSURE_ENABLED:\s+'true'\s*$/mu,
      );
    });

    it('keeps the native OCR process single-threaded and resource isolated', () => {
      for (const [key, value] of Object.entries({
        PHOTO_DUPLICATE_MAX_BYTES: 16_777_216,
        COMMERCIAL_OCR_MAX_INPUT_PIXELS: 40_000_000,
        COMMERCIAL_OCR_MAX_OUTPUT_PIXELS: 3_000_000,
        COMMERCIAL_OCR_MAX_SIDE: 2_000,
        COMMERCIAL_OCR_TESSERACT_CONCURRENCY: 1,
        COMMERCIAL_OCR_TESSERACT_MAX_QUEUE: 4,
        COMMERCIAL_OCR_TESSERACT_RECYCLE_AFTER_JOBS: 250,
        COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: 10_000,
        COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES: 16_777_216,
        COMMERCIAL_OCR_TESSERACT_MAX_OUTPUT_BYTES: 4_194_304,
        OMP_THREAD_LIMIT: 1,
      })) {
        expect(readEnvNumber(nativeSandbox, key)).toBe(value);
        expect(readEnvNumber(mediaAnalysis, key)).toBe(value);
      }
      expect(nativeSandbox).toMatch(/^\s+COMMERCIAL_OCR_TESSERACT_BINARY:\s+tesseract\s*$/mu);
      expect(mediaAnalysis).toMatch(/^\s+COMMERCIAL_OCR_TESSERACT_BINARY:\s+tesseract\s*$/mu);
      expect(mediaAnalysis).not.toMatch(/^\s+COMMERCIAL_OCR_PROCESSOR_CONCURRENCY:/mu);
      expect(nativeSandbox).toMatch(/^\s+init:\s+true\s*$/mu);
      expect(nativeSandbox).toMatch(/^\s+deploy:\n\s+replicas:\s+1\s*$/mu);
      expect(nativeSandbox).toMatch(/^\s+cpus:\s+1\.0\s*$/mu);
      expect(nativeSandbox).toMatch(/^\s+mem_limit:\s+1g\s*$/mu);
    });

    it('sandboxes native image parsing behind a no-network no-secret boundary', () => {
      expect(nativeSandbox).not.toMatch(/^\s+env_file:/mu);
      expect(nativeSandbox).not.toMatch(/^\s+secrets:/mu);
      expect(nativeSandbox).not.toMatch(/^\s+APP_(?:ROLE|SERVICE_NAME):/mu);
      expect(nativeSandbox).toMatch(/^\s+network_mode:\s+none\s*$/mu);
      expect(nativeSandbox).toMatch(/^\s+user:\s+'1000:1000'\s*$/mu);
      expect(nativeSandbox).toMatch(/^\s+read_only:\s+true\s*$/mu);
      expect(nativeSandbox).toMatch(/^\s+cap_drop:\n\s+- ALL\s*$/mu);
      expect(nativeSandbox).toMatch(
        new RegExp(
          `^\\s+security_opt:${name === 'scale' ? ' !override' : ''}\\n\\s+- no-new-privileges:true\\s*$`,
          'mu',
        ),
      );
      expect(nativeSandbox).toMatch(
        /^\s+tmpfs:\n\s+- \/tmp:size=64m,mode=1777,uid=1000,gid=1000\s*$/mu,
      );
      expect(nativeSandbox).toContain(
        'COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH: /run/maxim-ocr/native-ocr.sock',
      );
      expect(nativeSandbox).toContain('- ocr_native_ipc:/run/maxim-ocr');
      expect(mediaAnalysis).toContain('- ocr_native_ipc:/run/maxim-ocr:ro');
      expect(mediaAnalysis).toMatch(
        /^\s+ocr-native-sandbox:\n\s+condition:\s+service_healthy\s*$/mu,
      );
    });

    it('isolates every production pool member with a separate IPC volume', () => {
      const poolPaths: string[] = [];
      for (const lane of [2, 3]) {
        const service = `ocr-native-sandbox-${lane}`;
        const directory = `/run/maxim-ocr-${lane}`;
        const volume = `ocr_native_ipc_${lane}`;
        const path = `${directory}/native-ocr.sock`;
        if (name === 'scale') {
          expect(compose).not.toContain(`  ${service}:`);
          continue;
        }
        const sandbox = readServiceBlock(compose, service);
        expect(sandbox).toBe(
          nativeSandbox
            .replaceAll('/run/maxim-ocr', directory)
            .replaceAll('ocr_native_ipc', volume),
        );
        expect(mediaAnalysis).toContain(`- ${volume}:${directory}:ro`);
        expect(mediaAnalysis).toContain(`${service}:\n        condition: service_healthy`);
        poolPaths.push(path);
      }
      if (name === 'main') {
        expect(mediaAnalysis).toContain(
          `COMMERCIAL_OCR_NATIVE_SANDBOX_POOL_SOCKET_PATHS: ${poolPaths.join(',')}`,
        );
      }
    });

    it('keeps the exact lightweight probe CLI and measured healthcheck budget', () => {
      expect(nativeSandbox).toContain(
        '- apps/api/dist/apps/api/src/moderation/commercial-ocr/native-ocr-sandbox.entrypoint.js\n        - --probe',
      );
      expect(nativeSandbox).toMatch(/^\s+interval:\s+10s\s*$/mu);
      expect(nativeSandbox).toMatch(/^\s+timeout:\s+8s\s*$/mu);
    });
  });
});

function readServiceBlock(compose: string, service: string): string {
  const match = compose.match(
    new RegExp(
      `\\n  ${escapeRegExp(service)}:\\n([\\s\\S]*?)(?=\\n  [a-zA-Z0-9_-]+:|\\nvolumes:|$)`,
      'u',
    ),
  );

  if (!match?.[1]) {
    throw new Error(`Missing compose service ${service}`);
  }
  return match[1];
}

function readEnvNumber(serviceBlock: string, key: string): number {
  const match = serviceBlock.match(
    new RegExp(`^\\s{6}${escapeRegExp(key)}:\\s*'?([0-9]+)'?\\s*$`, 'mu'),
  );

  if (!match?.[1]) {
    throw new Error(`Missing compose env ${key}`);
  }
  return Number(match[1]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
