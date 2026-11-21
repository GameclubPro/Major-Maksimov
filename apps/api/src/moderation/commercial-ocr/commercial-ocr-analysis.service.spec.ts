import { ConfigService } from '@nestjs/config';
import { stopWordsPolicySchema } from '@maxim/contracts/settings';
import { createHash } from 'node:crypto';

import type { ChatSettings } from '../../prisma/prisma-client';
import type { LogicalPhotoAlbum } from '../photo-duplicate/photo-attachment-extractor';
import { PhotoDownloadHttpError } from '../photo-duplicate/secure-photo-downloader';
import {
  COMMERCIAL_OCR_CACHE_SCHEMA_VERSION,
  type CommercialOcrCacheIdentity,
  type CommercialOcrCacheValue,
} from './commercial-ocr-cache.store';
import { CommercialOcrAnalysisService } from './commercial-ocr-analysis.service';
import type { CommercialOcrDetector } from './commercial-ocr-decision-policy';
import {
  CommercialOcrImageRejectedError,
  CommercialOcrPreprocessUnavailableError,
} from './commercial-ocr-preprocessor';

const SETTINGS = {
  commercialAdsFilterEnabled: true,
  commercialAdsSensitivity: 'BALANCED',
  commercialAdsWarnThreshold: 45,
  commercialAdsDeleteThreshold: 65,
} as unknown as ChatSettings;

const OCR_TEXT = 'Ремонт окон, звоните +7 999 123 45 67';
const OCR_WORDS = [
  word('Ремонт', 0, 6),
  word('окон', 7, 11),
  word('звоните', 13, 20),
  word('+7', 21, 23),
  word('999', 24, 27),
  word('123', 28, 31),
  word('45', 32, 34),
  word('67', 35, 37),
];

function word(text: string, start: number, end: number) {
  return {
    text,
    start,
    end,
    confidence: 96,
    lineIndex: 0,
    boundingBox: { left: start, top: 0, width: end - start, height: 10 },
  };
}

function album(urls: Array<string | null>): LogicalPhotoAlbum {
  return {
    chatId: 'chat-1',
    messageId: 'message-1',
    senderId: 'user-1',
    createdAtMs: Date.parse('2026-08-12T08:00:00.000Z'),
    caption: '',
    images: urls.map((downloadUrl, index) => ({
      source: index % 2 === 0 ? ('direct' as const) : ('forward' as const),
      photoId: `photo-${index + 1}`,
      downloadUrl,
    })),
  };
}

function nativeResult(overrides: Record<string, unknown> = {}) {
  return {
    ok: true as const,
    status: 'recognized' as const,
    passLabel: 'primary',
    psm: 11 as const,
    text: OCR_TEXT,
    aggregateConfidence: 96,
    words: OCR_WORDS,
    lines: [],
    truncated: false,
    durationMs: 10,
    ...overrides,
  };
}

function noTextResult() {
  return nativeResult({
    status: 'no_text',
    text: '',
    aggregateConfidence: null,
    words: [],
  });
}

function recognizedTextResult(text: string, passLabel: 'primary' | 'confirmation') {
  return nativeResult({
    passLabel,
    psm: passLabel === 'primary' ? 11 : 6,
    text,
    aggregateConfidence: 96,
    words: [word(text, 0, text.length)],
  });
}

function cacheValue(): CommercialOcrCacheValue {
  return {
    schemaVersion: COMMERCIAL_OCR_CACHE_SCHEMA_VERSION,
    status: 'recognized',
    text: OCR_TEXT,
    confidencePermille: 960,
    words: OCR_WORDS.map(({ text, start, end, confidence }) => ({
      text,
      start,
      end,
      confidencePermille: confidence * 10,
    })),
  };
}

function strictDetector(): CommercialOcrDetector {
  return {
    detect: jest.fn().mockReturnValue({
      rawText: OCR_TEXT,
      confidenceScore: 96,
      decisionBand: 'HIGH',
      matchedSignals: ['service-specialty:ремонт', 'contact:phone'],
      negativeSignals: [],
      primarySubtype: 'SERVICES',
      supportingSubtypes: [],
      evidenceStrength: 'DIRECT',
      reviewRecommended: false,
      reviewReasons: [],
      campaignContext: null,
      appliedThresholds: {
        warnThreshold: 45,
        deleteThreshold: 65,
        sensitivity: 'BALANCED',
        strictness: 0.5,
      },
      classifierVersion: 'test',
      commercialProbability: 0.99,
      reviewProbability: 0.01,
      classifierReasons: [],
      actionScore: 96,
      policyFpRisk: 0,
      evidenceTier: 'DIRECT',
      actionBand: 'DELETE',
      safeContextBucket: 'none',
      actionable: true,
      recordable: true,
      deleteSuppressed: false,
      suppressionReasons: [],
      reasonCodes: [],
    }),
  };
}

function harness(
  options: {
    cacheReads?: Array<{ kind: 'hit'; value: CommercialOcrCacheValue } | { kind: 'miss' }>;
    ocrResults?: unknown[];
    config?: Record<string, unknown>;
  } = {},
) {
  const events: string[] = [];
  const downloader = {
    download: jest.fn(async (url: string) => {
      events.push(`download:${url}`);
      return { bytes: Buffer.from(`raw:${url}`), format: 'jpeg' as const };
    }),
  };
  const preprocessor = {
    prepare: jest.fn(async (bytes: Buffer, pass: string, _options?: unknown) => {
      events.push(`prepare:${pass}:${bytes.toString()}`);
      return { bytes: Buffer.from(`prepared:${pass}:${bytes.toString()}`), width: 100, height: 50 };
    }),
  };
  const ocrResults = [...(options.ocrResults ?? [])];
  const ocr = {
    recognize: jest.fn(
      async (_bytes: Buffer, recognizeOptions: { psm: number; passLabel: string }) => {
        events.push(`ocr:${recognizeOptions.passLabel}:${recognizeOptions.psm}`);
        return ocrResults.shift() ?? nativeResult(recognizeOptions);
      },
    ),
  };
  const cacheReads = [...(options.cacheReads ?? [])];
  const inFlight = new Map<string, { deadlineAtMs: number; promise: Promise<unknown> }>();
  const cache = {
    read: jest.fn(async (identity: CommercialOcrCacheIdentity) => {
      events.push(`cache-read:${identity.pass}:${identity.contentSha256}`);
      return cacheReads.shift() ?? { kind: 'miss' as const };
    }),
    write: jest.fn(async (identity: CommercialOcrCacheIdentity) => {
      events.push(`write:${identity.pass}`);
      return true;
    }),
    coalesceLocal: jest.fn(
      async <T>(
        identity: CommercialOcrCacheIdentity,
        deadlineAtMs: number,
        operation: () => Promise<T>,
        coalesceOptions: Readonly<{ onCoalesced?: () => void }> = {},
      ): Promise<T> => {
        const key = JSON.stringify(identity);
        const existing = inFlight.get(key) as
          | { deadlineAtMs: number; promise: Promise<T> }
          | undefined;
        if (existing && existing.deadlineAtMs >= deadlineAtMs) {
          coalesceOptions.onCoalesced?.();
          return existing.promise;
        }
        const pending = Promise.resolve().then(operation);
        const entry = { deadlineAtMs, promise: pending };
        inFlight.set(key, entry);
        try {
          return await pending;
        } finally {
          if (inFlight.get(key) === entry) {
            inFlight.delete(key);
          }
        }
      },
    ),
  };
  const metrics = {
    recordCounter: jest.fn(),
    recordStageDuration: jest.fn(),
    startImageCpuSample: jest.fn(() => ({
      startedUsageMicros: 1n,
      nativePasses: 0,
      finished: false,
    })),
    recordNativePass: jest.fn((sample: { nativePasses: number }) => {
      sample.nativePasses += 1;
    }),
    finishImageCpuSample: jest.fn((sample: { finished: boolean }) => {
      sample.finished = true;
    }),
  };
  const service = new CommercialOcrAnalysisService(
    downloader as never,
    preprocessor as never,
    ocr as never,
    cache as never,
    metrics as never,
    new ConfigService({
      COMMERCIAL_OCR_CACHE_TTL_SEC: 3_600,
      ...options.config,
    }),
  );
  Object.defineProperty(service, 'detector', { value: strictDetector() });
  return { service, downloader, preprocessor, ocr, cache, metrics, events };
}

function analyze(
  service: CommercialOcrAnalysisService,
  options: {
    urls?: Array<string | null>;
    caption?: string;
    authorizeStage?: jest.Mock;
    deadlineAtMs?: number;
    settings?: ChatSettings;
    commercialScanEnabled?: boolean;
    imageTextStopListScanEnabled?: boolean;
  } = {},
) {
  return service.analyzeAlbum({
    album: album(options.urls ?? ['https://i.oneme.ru/1']),
    caption: options.caption ?? '',
    settings: options.settings ?? SETTINGS,
    ocrVersion: 'tesseract-rus-eng-v1',
    deadlineAtMs: options.deadlineAtMs ?? Date.now() + 60_000,
    authorizeStage: options.authorizeStage ?? jest.fn().mockResolvedValue(true),
    ...(options.commercialScanEnabled === undefined
      ? {}
      : { commercialScanEnabled: options.commercialScanEnabled }),
    ...(options.imageTextStopListScanEnabled === undefined
      ? {}
      : { imageTextStopListScanEnabled: options.imageTextStopListScanEnabled }),
  });
}

describe('CommercialOcrAnalysisService', () => {
  it('runs a confirmation pass for an image stop-list candidate and returns no OCR text', async () => {
    const { service, downloader, ocr } = harness({
      ocrResults: [
        recognizedTextResult('казино', 'primary'),
        recognizedTextResult('КАЗИНО', 'confirmation'),
      ],
    });
    Object.defineProperty(service, 'detector', {
      value: { detect: jest.fn().mockReturnValue(null) },
    });

    const result = await analyze(service, {
      caption: 'Ищу совет по ремонту',
      urls: ['https://i.oneme.ru/1', 'https://i.oneme.ru/2'],
      settings: {
        ...SETTINGS,
        commercialAdsFilterEnabled: false,
        messageLimitsImageTextScanEnabled: true,
        messageLimitsBlockedWords: ['казино'],
        messageLimitsBlockedDomains: [],
      },
    });

    expect(result).toMatchObject({
      kind: 'complete',
      imageTextStopListDecision: {
        kind: 'match',
        ruleCode: 'MESSAGE_BLOCKED_WORD',
        value: 'казино',
        imageIndex: 0,
      },
    });
    expect(ocr.recognize).toHaveBeenCalledTimes(2);
    expect(downloader.download).toHaveBeenCalledTimes(1);
    expect(
      JSON.stringify((result as { imageTextStopListDecision: unknown }).imageTextStopListDecision),
    ).not.toContain('КАЗИНО');
  });

  const imageStopListExactSettings = {
    ...SETTINGS,
    commercialAdsFilterEnabled: false,
    stopWordsPolicy: stopWordsPolicySchema.parse({
      enabled: true,
      imageScanEnabled: true,
      rules: [{ id: 'exact', kind: 'WORD', value: 'берёза' }],
    }),
  };

  it('confirms light exact text with one grayscale retry after binary confirmation returns no text', async () => {
    const { service, preprocessor, downloader, ocr, cache } = harness({
      ocrResults: [
        nativeResult({
          text: 'берёза',
          words: [{ text: 'берёза', start: 0, end: 6, confidence: 96 }],
        }),
        noTextResult(),
        recognizedTextResult('БЕРЁЗА', 'confirmation'),
      ],
    });
    const deadlineAtMs = Date.now() + 60_000;

    await expect(
      analyze(service, {
        urls: ['https://i.oneme.ru/1', 'https://i.oneme.ru/2'],
        settings: imageStopListExactSettings,
        deadlineAtMs,
      }),
    ).resolves.toMatchObject({
      kind: 'complete',
      imageTextStopListDecision: { kind: 'match', ruleId: 'exact', imageIndex: 0 },
    });
    expect(downloader.download).toHaveBeenCalledTimes(1);
    expect(preprocessor.prepare.mock.calls.map(([, pass]) => pass)).toEqual([
      'primary',
      'confirmation',
      'primary',
    ]);
    expect(ocr.recognize).toHaveBeenLastCalledWith(expect.any(Buffer), {
      psm: 6,
      passLabel: 'confirmation',
      deadlineAtMs,
    });
    const [primary, binary, grayscale] = cache.write.mock.calls.map(([identity]) => identity);
    expect(grayscale).toMatchObject({ pass: 'confirmation', psm: 6 });
    expect(grayscale!.preprocessProfile).toBe(primary!.preprocessProfile);
    expect(grayscale!.preprocessProfile).not.toBe(binary!.preprocessProfile);
  });

  it('confirms the entire exact phrase using a grayscale crop after full-page disagreement', async () => {
    const { service, preprocessor, cache, ocr } = harness({
      ocrResults: [
        nativeResult({
          text: 'только берёза и сосна рядом\nшум',
          aggregateConfidence: 72,
          words: [
            word('только', 0, 6),
            word('берёза', 7, 13),
            word('и', 14, 15),
            word('сосна', 16, 21),
            word('рядом', 22, 27),
            {
              ...word('шум', 28, 31),
              confidence: 40,
              boundingBox: { left: 5, top: 35, width: 9, height: 10 },
            },
          ],
        }),
        recognizedTextResult('сосна', 'confirmation'),
        recognizedTextResult('берёза и сосна', 'confirmation'),
      ],
    });
    const settings = {
      ...imageStopListExactSettings,
      stopWordsPolicy: stopWordsPolicySchema.parse({
        enabled: true,
        imageScanEnabled: true,
        rules: [{ id: 'phrase', kind: 'PHRASE', value: 'берёза и сосна' }],
      }),
    };

    await expect(analyze(service, { settings })).resolves.toMatchObject({
      kind: 'complete',
      imageTextStopListDecision: { kind: 'match', ruleId: 'phrase' },
    });
    expect(preprocessor.prepare).toHaveBeenLastCalledWith(
      expect.any(Buffer),
      'primary',
      expect.objectContaining({
        crop: { left: 0, top: 0, width: 39, height: 22 },
      }),
    );
    expect(ocr.recognize).toHaveBeenCalledTimes(3);
    expect(cache.write.mock.calls[2]?.[0].preprocessProfile).toMatch(/crop-v1\.0\.0\.39\.22$/u);
  });

  it('allows only one optional grayscale pass even when two images have empty binary confirmation', async () => {
    const { service, ocr } = harness({
      ocrResults: [
        recognizedTextResult('берёза', 'primary'),
        noTextResult(),
        recognizedTextResult('сосна', 'confirmation'),
        recognizedTextResult('берёза', 'primary'),
        noTextResult(),
      ],
    });

    await expect(
      analyze(service, {
        urls: ['https://i.oneme.ru/1', 'https://i.oneme.ru/2'],
        settings: imageStopListExactSettings,
      }),
    ).resolves.toMatchObject({
      kind: 'complete',
      imageTextStopListDecision: { kind: 'no_action' },
    });
    expect(ocr.recognize).toHaveBeenCalledTimes(5);
  });

  it('keeps the baseline no-match if the optional grayscale confirmation cannot get a native slot', async () => {
    const { service } = harness({
      ocrResults: [
        recognizedTextResult('берёза', 'primary'),
        noTextResult(),
        { ok: false, reason: 'capacity_exhausted', durationMs: 1 },
      ],
    });
    await expect(analyze(service, { settings: imageStopListExactSettings })).resolves.toMatchObject(
      { kind: 'complete', imageTextStopListDecision: { kind: 'no_action' } },
    );
  });

  it('finishes commercial album traversal after an image stop-list match in a combined job', async () => {
    const { service, downloader, ocr } = harness({
      ocrResults: [
        recognizedTextResult('казино', 'primary'),
        recognizedTextResult('КАЗИНО', 'confirmation'),
        nativeResult({ passLabel: 'primary', psm: 11 }),
        nativeResult({ passLabel: 'confirmation', psm: 6 }),
      ],
    });

    const result = await analyze(service, {
      urls: ['https://i.oneme.ru/1', 'https://i.oneme.ru/2'],
      commercialScanEnabled: true,
      imageTextStopListScanEnabled: true,
      settings: {
        ...SETTINGS,
        messageLimitsImageTextScanEnabled: true,
        messageLimitsBlockedWords: ['казино'],
        messageLimitsBlockedDomains: [],
      },
    });

    expect(result).toMatchObject({
      kind: 'complete',
      decision: { action: 'DELETE' },
      imageTextStopListDecision: {
        kind: 'match',
        ruleCode: 'MESSAGE_BLOCKED_WORD',
        value: 'казино',
        imageIndex: 0,
      },
    });
    expect(downloader.download).toHaveBeenCalledTimes(2);
    expect(ocr.recognize).toHaveBeenCalledTimes(4);
  });

  it('short-circuits a safe caption before download or governor work', async () => {
    const { service, downloader, ocr, cache } = harness();
    const detector: CommercialOcrDetector = { detect: jest.fn().mockReturnValue(null) };
    Object.defineProperty(service, 'detector', { value: detector });
    const authorizeStage = jest.fn().mockResolvedValue(true);

    await expect(
      analyze(service, {
        caption: 'Ищу мастера по ремонту, бюджет 5000 рублей. Кто может посоветовать?',
        authorizeStage,
      }),
    ).resolves.toMatchObject({
      kind: 'complete',
      decision: {
        action: 'NO_ACTION',
        caption: { safeContextBucket: 'request_or_recommendation' },
      },
    });
    expect(authorizeStage).not.toHaveBeenCalled();
    expect(downloader.download).not.toHaveBeenCalled();
    expect(cache.read).not.toHaveBeenCalled();
    expect(ocr.recognize).not.toHaveBeenCalled();
  });

  it('finishes each strict candidate before downloading the next image', async () => {
    const { service, downloader, preprocessor, ocr, cache, events } = harness({
      cacheReads: [{ kind: 'miss' }, { kind: 'miss' }, { kind: 'miss' }, { kind: 'miss' }],
    });
    const authorizeStage = jest.fn(async (stage: string) => {
      events.push(`authorize:${stage}`);
      return true;
    });

    await expect(
      analyze(service, {
        urls: ['https://i.oneme.ru/1', 'https://i.oneme.ru/2'],
        authorizeStage,
      }),
    ).resolves.toMatchObject({ kind: 'complete', decision: { action: 'DELETE' } });

    expect(downloader.download).toHaveBeenCalledTimes(2);
    expect(downloader.download).toHaveBeenCalledWith('https://i.oneme.ru/1', {
      deadlineAtMs: expect.any(Number),
    });
    expect(preprocessor.prepare.mock.calls.map((call) => call[1])).toEqual([
      'primary',
      'confirmation',
      'primary',
      'confirmation',
    ]);
    expect(ocr.recognize.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ psm: 11, passLabel: 'primary', deadlineAtMs: expect.any(Number) }),
      expect.objectContaining({
        psm: 6,
        passLabel: 'confirmation',
        deadlineAtMs: expect.any(Number),
      }),
      expect.objectContaining({ psm: 11, passLabel: 'primary', deadlineAtMs: expect.any(Number) }),
      expect.objectContaining({
        psm: 6,
        passLabel: 'confirmation',
        deadlineAtMs: expect.any(Number),
      }),
    ]);
    expect(events.indexOf('ocr:confirmation:6')).toBeLessThan(
      events.indexOf('download:https://i.oneme.ru/2'),
    );
    expect(authorizeStage.mock.calls.map((call) => call[0])).toEqual([
      'download',
      'ocr',
      'ocr_dispatch',
      'ocr',
      'ocr_dispatch',
      'download',
      'ocr',
      'ocr_dispatch',
      'ocr',
      'ocr_dispatch',
    ]);

    const identities = cache.read.mock.calls.map((call) => call[0] as CommercialOcrCacheIdentity);
    expect(
      identities.map(({ pass, psm, preprocessProfile }) => ({ pass, psm, preprocessProfile })),
    ).toEqual([
      {
        pass: 'primary',
        psm: 11,
        preprocessProfile: 'gray-bounded-v4.i40000000.o3000000.s2000',
      },
      {
        pass: 'primary',
        psm: 11,
        preprocessProfile: 'gray-bounded-v4.i40000000.o3000000.s2000',
      },
      {
        pass: 'confirmation',
        psm: 6,
        preprocessProfile: 'normalized-threshold160-v4.i40000000.o3000000.s2000',
      },
      {
        pass: 'confirmation',
        psm: 6,
        preprocessProfile: 'normalized-threshold160-v4.i40000000.o3000000.s2000',
      },
      {
        pass: 'primary',
        psm: 11,
        preprocessProfile: 'gray-bounded-v4.i40000000.o3000000.s2000',
      },
      {
        pass: 'primary',
        psm: 11,
        preprocessProfile: 'gray-bounded-v4.i40000000.o3000000.s2000',
      },
      {
        pass: 'confirmation',
        psm: 6,
        preprocessProfile: 'normalized-threshold160-v4.i40000000.o3000000.s2000',
      },
      {
        pass: 'confirmation',
        psm: 6,
        preprocessProfile: 'normalized-threshold160-v4.i40000000.o3000000.s2000',
      },
    ]);
    expect(identities[0]?.contentSha256).toBe(
      createHash('sha256').update(Buffer.from('raw:https://i.oneme.ru/1')).digest('hex'),
    );
    expect(identities[1]?.contentSha256).toBe(identities[0]?.contentSha256);
  });

  it('stops remaining album work after any primary pass establishes safe context', async () => {
    const { service, downloader, ocr, cache } = harness();
    const detector = strictDetector();
    const commercialHit = (detector.detect as jest.Mock)();
    (detector.detect as jest.Mock).mockReturnValue({
      ...commercialHit,
      safeContextBucket: 'request_or_recommendation',
    });
    Object.defineProperty(service, 'detector', { value: detector });

    await expect(
      analyze(service, { urls: ['https://i.oneme.ru/1', 'https://i.oneme.ru/2'] }),
    ).resolves.toMatchObject({
      kind: 'complete',
      decision: {
        action: 'NO_ACTION',
        reasonCodes: ['image-safe-context:0:request_or_recommendation'],
      },
    });
    expect(downloader.download).toHaveBeenCalledTimes(1);
    expect(ocr.recognize).toHaveBeenCalledTimes(1);
    expect(cache.write).toHaveBeenCalledTimes(1);
  });

  it('uses an exact cache hit without preprocessing or native OCR', async () => {
    const { service, downloader, preprocessor, ocr, cache } = harness({
      cacheReads: [
        { kind: 'hit', value: cacheValue() },
        { kind: 'hit', value: cacheValue() },
      ],
    });
    const authorizeStage = jest.fn().mockResolvedValue(true);

    await expect(analyze(service, { authorizeStage })).resolves.toMatchObject({
      kind: 'complete',
      decision: { action: 'DELETE' },
    });
    expect(downloader.download).toHaveBeenCalledTimes(1);
    expect(authorizeStage.mock.calls.map((call) => call[0])).toEqual(['download']);
    expect(cache.coalesceLocal).not.toHaveBeenCalled();
    expect(preprocessor.prepare).not.toHaveBeenCalled();
    expect(ocr.recognize).not.toHaveBeenCalled();
  });

  it('isolates cache identities when an effective preprocessing ceiling changes', async () => {
    const fixture = harness({
      config: {
        COMMERCIAL_OCR_MAX_INPUT_PIXELS: 20_000_000,
        COMMERCIAL_OCR_MAX_OUTPUT_PIXELS: 2_000_000,
        COMMERCIAL_OCR_MAX_SIDE: 1_600,
      },
    });

    await expect(analyze(fixture.service)).resolves.toMatchObject({ kind: 'complete' });

    const identities = fixture.cache.read.mock.calls.map(
      (call) => call[0] as CommercialOcrCacheIdentity,
    );
    expect(identities[0]?.preprocessProfile).toBe('gray-bounded-v4.i20000000.o2000000.s1600');
    expect(identities.at(-1)?.preprocessProfile).toBe(
      'normalized-threshold160-v4.i20000000.o2000000.s1600',
    );
  });

  it('confirms only images whose primary pass satisfies the strict delete gate', async () => {
    const { service, downloader, preprocessor, ocr } = harness({
      ocrResults: [noTextResult(), nativeResult(), nativeResult({ psm: 6 })],
    });

    await expect(
      analyze(service, { urls: ['https://i.oneme.ru/1', 'https://i.oneme.ru/2'] }),
    ).resolves.toMatchObject({ kind: 'complete', decision: { action: 'DELETE' } });
    expect(downloader.download).toHaveBeenCalledTimes(2);
    expect(preprocessor.prepare.mock.calls.map((call) => call[1])).toEqual([
      'primary',
      'primary',
      'confirmation',
    ]);
    expect(ocr.recognize.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ psm: 11, passLabel: 'primary', deadlineAtMs: expect.any(Number) }),
      expect.objectContaining({ psm: 11, passLabel: 'primary', deadlineAtMs: expect.any(Number) }),
      expect.objectContaining({
        psm: 6,
        passLabel: 'confirmation',
        deadlineAtMs: expect.any(Number),
      }),
    ]);
  });

  it('runs local OCR when the exact process-local cache misses', async () => {
    const fixture = harness({ cacheReads: [{ kind: 'miss' }, { kind: 'miss' }] });
    await expect(analyze(fixture.service)).resolves.toMatchObject({ kind: 'complete' });
    expect(fixture.ocr.recognize).toHaveBeenCalledTimes(2);
    expect(fixture.cache.write).toHaveBeenCalledTimes(2);
    expect(fixture.metrics.recordNativePass).toHaveBeenCalledTimes(2);
    expect(fixture.metrics.finishImageCpuSample).toHaveBeenCalledTimes(1);
    expect(fixture.metrics.recordCounter).toHaveBeenCalledWith('cache.primary.miss');
    expect(fixture.metrics.recordCounter).toHaveBeenCalledWith('confirmation.requested');
    expect(fixture.metrics.recordCounter).toHaveBeenCalledWith('confirmation.completed');
    expect(fixture.metrics.recordStageDuration).toHaveBeenCalledWith(
      'download',
      expect.any(Number),
    );
    expect(fixture.metrics.recordStageDuration).toHaveBeenCalledWith(
      'preprocess',
      expect.any(Number),
    );
    expect(fixture.metrics.recordStageDuration).toHaveBeenCalledWith('policy', expect.any(Number));
  });

  it('coalesces matching process-local OCR work without deferring the duplicate analysis', async () => {
    const { service, ocr, cache, metrics } = harness();
    const deadlineAtMs = Date.now() + 60_000;
    let releaseOcr!: () => void;
    const ocrGate = new Promise<void>((resolve) => {
      releaseOcr = resolve;
    });
    ocr.recognize.mockImplementationOnce(async (bytes, recognizeOptions) => {
      await ocrGate;
      return nativeResult(recognizeOptions);
    });

    const first = analyze(service, { deadlineAtMs });
    await waitFor(() => ocr.recognize.mock.calls.length === 1);
    const second = analyze(service, { deadlineAtMs });
    await waitFor(() => cache.coalesceLocal.mock.calls.length >= 2);
    expect(ocr.recognize).toHaveBeenCalledTimes(1);

    releaseOcr();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ kind: 'complete' }),
      expect.objectContaining({ kind: 'complete' }),
    ]);
    expect(ocr.recognize).toHaveBeenCalledTimes(2);
    expect(cache.write).toHaveBeenCalledTimes(2);
    expect(metrics.recordCounter).toHaveBeenCalledWith('cache.primary.coalesced');
  });

  it('stops a coalesced waiter at its own earlier absolute deadline', async () => {
    jest.useFakeTimers();
    try {
      const { service, ocr } = harness();
      let releaseOcr!: () => void;
      const ocrGate = new Promise<void>((resolve) => {
        releaseOcr = resolve;
      });
      ocr.recognize.mockImplementationOnce(async (_bytes, recognizeOptions) => {
        await ocrGate;
        return nativeResult(recognizeOptions);
      });

      const first = analyze(service, { deadlineAtMs: Date.now() + 60_000 });
      await jest.advanceTimersByTimeAsync(1);
      expect(ocr.recognize).toHaveBeenCalledTimes(1);
      const second = analyze(service, { deadlineAtMs: Date.now() + 100 });

      await jest.advanceTimersByTimeAsync(100);
      await expect(second).resolves.toEqual({
        kind: 'incomplete',
        reason: 'job_deadline_exceeded',
        imageIndex: 0,
        pass: 'primary',
      });
      expect(ocr.recognize).toHaveBeenCalledTimes(1);

      releaseOcr();
      await jest.runAllTimersAsync();
      await expect(first).resolves.toMatchObject({ kind: 'complete' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not release the owning analysis while physical preprocessing is still running', async () => {
    jest.useFakeTimers();
    try {
      const { service, preprocessor, ocr } = harness();
      let releasePreprocess!: () => void;
      const preprocessGate = new Promise<void>((resolve) => {
        releasePreprocess = resolve;
      });
      preprocessor.prepare.mockImplementationOnce(async () => {
        await preprocessGate;
        return { bytes: Buffer.from('prepared'), width: 100, height: 50 };
      });

      let settled = false;
      const analysis = analyze(service, { deadlineAtMs: Date.now() + 100 }).finally(() => {
        settled = true;
      });
      await jest.advanceTimersByTimeAsync(1);
      expect(preprocessor.prepare).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);
      expect(ocr.recognize).not.toHaveBeenCalled();

      releasePreprocess();
      await expect(analysis).resolves.toEqual({
        kind: 'incomplete',
        reason: 'job_deadline_exceeded',
        imageIndex: 0,
        pass: 'primary',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('authorizes immediately before download and every native OCR call', async () => {
    const downloadDenied = harness();
    const denyDownload = jest.fn().mockResolvedValue(false);
    await expect(
      analyze(downloadDenied.service, { authorizeStage: denyDownload }),
    ).resolves.toEqual({
      kind: 'defer',
      reason: 'governor_pressure',
      delayMs: 30_000,
    });
    expect(denyDownload).toHaveBeenCalledWith('download');
    expect(downloadDenied.downloader.download).not.toHaveBeenCalled();

    const ocrDenied = harness();
    const authorizeStage = jest
      .fn()
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error('governor unavailable'));
    await expect(analyze(ocrDenied.service, { authorizeStage })).resolves.toEqual({
      kind: 'defer',
      reason: 'governor_pressure',
      delayMs: 30_000,
    });
    expect(ocrDenied.preprocessor.prepare).not.toHaveBeenCalled();
    expect(ocrDenied.ocr.recognize).not.toHaveBeenCalled();
    expect(ocrDenied.cache.write).not.toHaveBeenCalled();
  });

  it('resumes a deferred confirmation from the cached primary pass within the original deadline', async () => {
    const fixture = harness();
    const saved = new Map<string, CommercialOcrCacheValue>();
    fixture.cache.read.mockImplementation(async (identity) => {
      const value = saved.get(JSON.stringify(identity));
      return value ? { kind: 'hit', value } : { kind: 'miss' };
    });
    (fixture.cache.write as jest.Mock).mockImplementation(async (identity, value) => {
      saved.set(JSON.stringify(identity), value);
      return true;
    });
    let slots = 1;
    const authorizeStage = jest.fn(async (stage: string) =>
      stage !== 'ocr' || slots-- > 0
        ? { allowed: true, retryAfterMs: 0 }
        : { allowed: false, retryAfterMs: 20_000 },
    );
    const deadlineAtMs = Date.now() + 60_000;
    await expect(analyze(fixture.service, { authorizeStage, deadlineAtMs })).resolves.toEqual({
      kind: 'defer',
      reason: 'governor_pressure',
      delayMs: 20_000,
    });
    expect(fixture.ocr.recognize).toHaveBeenCalledTimes(1);
    expect(saved.size).toBe(1);

    slots = 1;
    await expect(analyze(fixture.service, { authorizeStage, deadlineAtMs })).resolves.toMatchObject(
      {
        kind: 'complete',
        decision: { action: 'DELETE' },
      },
    );
    expect(fixture.ocr.recognize.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({ passLabel: 'primary', deadlineAtMs }),
      expect.objectContaining({ passLabel: 'confirmation', deadlineAtMs }),
    ]);
    expect(saved.size).toBe(2);
  });

  it('checks a fresh pause between preprocessing and native dispatch', async () => {
    const { service, preprocessor, ocr } = harness();
    const authorizeStage = jest.fn(async (stage: string) =>
      stage === 'ocr_dispatch' ? { allowed: false, retryAfterMs: 60_000 } : true,
    );
    await expect(analyze(service, { authorizeStage })).resolves.toEqual({
      kind: 'defer',
      reason: 'governor_pressure',
      delayMs: 60_000,
    });
    expect(preprocessor.prepare).toHaveBeenCalledTimes(1);
    expect(ocr.recognize).not.toHaveBeenCalled();
  });

  it('fails open before any I/O when the absolute job deadline has expired', async () => {
    const { service, downloader, preprocessor, ocr, cache } = harness();
    const authorizeStage = jest.fn().mockResolvedValue(true);

    await expect(
      analyze(service, { deadlineAtMs: Date.now() - 1, authorizeStage }),
    ).resolves.toEqual({ kind: 'incomplete', reason: 'job_deadline_exceeded' });
    expect(authorizeStage).not.toHaveBeenCalled();
    expect(downloader.download).not.toHaveBeenCalled();
    expect(preprocessor.prepare).not.toHaveBeenCalled();
    expect(ocr.recognize).not.toHaveBeenCalled();
    expect(cache.read).not.toHaveBeenCalled();
  });

  it('stops before native OCR when preprocessing consumes the remaining job budget', async () => {
    const { service, preprocessor, ocr, cache } = harness();
    const deadlineAtMs = Date.now() + 60_000;
    preprocessor.prepare.mockImplementationOnce(async () => {
      jest.spyOn(Date, 'now').mockReturnValue(deadlineAtMs);
      return { bytes: Buffer.from('prepared'), width: 100, height: 50 };
    });

    try {
      await expect(analyze(service, { deadlineAtMs })).resolves.toEqual({
        kind: 'incomplete',
        reason: 'job_deadline_exceeded',
        imageIndex: 0,
        pass: 'primary',
      });
      expect(ocr.recognize).not.toHaveBeenCalled();
      expect(cache.write).not.toHaveBeenCalled();
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('fails open with an explicit reason when the bounded Sharp operation times out', async () => {
    const { service, preprocessor, ocr, cache } = harness();
    preprocessor.prepare.mockRejectedValueOnce(
      new CommercialOcrImageRejectedError('processing_timeout'),
    );

    await expect(analyze(service)).resolves.toEqual({
      kind: 'incomplete',
      reason: 'preprocess_timeout',
      imageIndex: 0,
      pass: 'primary',
    });
    expect(preprocessor.prepare).toHaveBeenCalledWith(
      expect.any(Buffer),
      'primary',
      expect.objectContaining({ deadlineAtMs: expect.any(Number) }),
    );
    expect(ocr.recognize).not.toHaveBeenCalled();
    expect(cache.write).not.toHaveBeenCalled();
  });

  it('retries a transient sandbox preprocessing outage within the bounded job policy', async () => {
    const { service, preprocessor, ocr, cache } = harness();
    preprocessor.prepare.mockRejectedValueOnce(new CommercialOcrPreprocessUnavailableError());

    await expect(analyze(service)).resolves.toEqual({
      kind: 'retry',
      reason: 'ocr_failed',
      imageIndex: 0,
      pass: 'primary',
    });
    expect(ocr.recognize).not.toHaveBeenCalled();
    expect(cache.write).not.toHaveBeenCalled();
  });

  it('fails open and never caches truncated OCR output', async () => {
    const { service, cache } = harness({ ocrResults: [nativeResult({ truncated: true })] });
    await expect(analyze(service)).resolves.toEqual({
      kind: 'incomplete',
      reason: 'ocr_truncated',
      imageIndex: 0,
      pass: 'primary',
    });
    expect(cache.write).not.toHaveBeenCalled();
  });

  it.each(['invalid_input', 'artifact_unverified', 'invalid_output', 'output_limit'] as const)(
    'fails open and never caches terminal OCR failure %s',
    async (reason) => {
      const { service, cache } = harness({
        ocrResults: [
          {
            ok: false,
            status: 'failed_open',
            passLabel: 'primary',
            psm: 11,
            reason,
            durationMs: 5,
          },
        ],
      });
      await expect(analyze(service)).resolves.toEqual({
        kind: 'incomplete',
        reason: 'ocr_failed',
        imageIndex: 0,
        pass: 'primary',
      });
      expect(cache.write).not.toHaveBeenCalled();
    },
  );

  it('fails open with a terminal reason when native OCR reaches its time budget', async () => {
    const { service, cache } = harness({
      ocrResults: [
        {
          ok: false,
          status: 'failed_open',
          passLabel: 'primary',
          psm: 11,
          reason: 'timeout',
          durationMs: 10_000,
        },
      ],
    });

    await expect(analyze(service)).resolves.toEqual({
      kind: 'incomplete',
      reason: 'ocr_timeout',
      imageIndex: 0,
      pass: 'primary',
    });
    expect(cache.write).not.toHaveBeenCalled();
  });

  it.each(['worker_unavailable', 'tesseract_failed', 'shutting_down'] as const)(
    'returns a retry for transient OCR failure %s',
    async (reason) => {
      const { service, cache } = harness({
        ocrResults: [
          {
            ok: false,
            status: 'failed_open',
            passLabel: 'primary',
            psm: 11,
            reason,
            durationMs: 5,
          },
        ],
      });

      await expect(analyze(service)).resolves.toEqual({
        kind: 'retry',
        reason: 'ocr_failed',
        imageIndex: 0,
        pass: 'primary',
      });
      expect(cache.write).not.toHaveBeenCalled();
    },
  );

  it('does not replay an active operation whose response deadline is uncertain', async () => {
    const { service, cache } = harness({
      ocrResults: [
        {
          ok: false,
          status: 'failed_open',
          passLabel: 'primary',
          psm: 11,
          reason: 'request_timeout',
          durationMs: 10_000,
        },
      ],
    });
    await expect(analyze(service)).resolves.toEqual({
      kind: 'incomplete',
      reason: 'ocr_request_timeout',
      imageIndex: 0,
      pass: 'primary',
    });
    expect(cache.write).not.toHaveBeenCalled();
  });

  it.each(['capacity_exhausted', 'request_deadline_exceeded'] as const)(
    'defers native backpressure %s without spending a transport retry',
    async (reason) => {
      const { service, cache } = harness({
        ocrResults: [
          {
            ok: false,
            status: 'failed_open',
            passLabel: 'primary',
            psm: 11,
            reason,
            durationMs: 5,
          },
        ],
      });
      await expect(analyze(service)).resolves.toEqual({
        kind: 'defer',
        reason: 'native_backpressure',
        delayMs: 5_000,
      });
      expect(cache.write).not.toHaveBeenCalled();
    },
  );

  it.each(['unverified', 'invalid_response', 'invalid_input'] as const)(
    'does not retry an unsafe preprocess boundary %s',
    async (reason) => {
      const { service, preprocessor, ocr, cache } = harness();
      preprocessor.prepare.mockRejectedValueOnce(
        new CommercialOcrPreprocessUnavailableError(reason),
      );
      await expect(analyze(service)).resolves.toEqual({
        kind: 'incomplete',
        reason: 'ocr_failed',
        imageIndex: 0,
        pass: 'primary',
      });
      expect(ocr.recognize).not.toHaveBeenCalled();
      expect(cache.write).not.toHaveBeenCalled();
    },
  );

  it('uses the governor delay instead of a fixed retry interval', async () => {
    const { service, downloader } = harness();
    await expect(
      analyze(service, {
        authorizeStage: jest.fn().mockResolvedValue({ allowed: false, retryAfterMs: 60_000 }),
      }),
    ).resolves.toEqual({ kind: 'defer', reason: 'governor_pressure', delayMs: 60_000 });
    expect(downloader.download).not.toHaveBeenCalled();
  });

  it('returns a retry when the OCR adapter rejects unexpectedly', async () => {
    const { service, ocr, cache, metrics } = harness();
    ocr.recognize.mockRejectedValueOnce(new Error('worker IPC closed'));

    await expect(analyze(service)).resolves.toEqual({
      kind: 'retry',
      reason: 'ocr_failed',
      imageIndex: 0,
      pass: 'primary',
    });
    expect(cache.write).not.toHaveBeenCalled();
    expect(metrics.recordNativePass).toHaveBeenCalledWith(expect.any(Object), expect.any(Number));
    expect(metrics.finishImageCpuSample).toHaveBeenCalledTimes(1);
  });

  it.each([
    new Error('Photo download timed out'),
    Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }),
    new PhotoDownloadHttpError(429),
    new PhotoDownloadHttpError(503),
  ])('returns a retry for a transient download failure', async (error) => {
    const { service, downloader, ocr } = harness();
    downloader.download.mockRejectedValueOnce(error);

    await expect(analyze(service)).resolves.toEqual({
      kind: 'retry',
      reason: 'download_failed',
      imageIndex: 0,
    });
    expect(ocr.recognize).not.toHaveBeenCalled();
  });

  it('treats a permanent photo HTTP response as terminal incomplete work', async () => {
    const { service, downloader, ocr } = harness();
    downloader.download.mockRejectedValueOnce(new PhotoDownloadHttpError(404));

    await expect(analyze(service)).resolves.toEqual({
      kind: 'incomplete',
      reason: 'download_failed',
      imageIndex: 0,
    });
    expect(ocr.recognize).not.toHaveBeenCalled();
  });

  it('fails the whole album open when any image is incomplete', async () => {
    const { service, downloader, ocr } = harness();
    downloader.download.mockRejectedValueOnce(new Error('network unavailable'));

    await expect(
      analyze(service, { urls: ['https://i.oneme.ru/1', 'https://i.oneme.ru/2'] }),
    ).resolves.toEqual({ kind: 'incomplete', reason: 'download_failed', imageIndex: 0 });
    expect(ocr.recognize).not.toHaveBeenCalled();

    const missing = harness();
    await expect(
      analyze(missing.service, { urls: ['https://i.oneme.ru/1', null] }),
    ).resolves.toEqual({
      kind: 'incomplete',
      reason: 'missing_download_url',
      imageIndex: 1,
    });
    expect(missing.downloader.download).not.toHaveBeenCalled();
  });
});

async function waitFor(read: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (read()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for test state');
}
