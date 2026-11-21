import {
  buildImageTextStopListBinding,
  fingerprintImageTextStopListPolicy,
  imageTextStopListSourceMatchesBinding,
  parseImageTextStopListBinding,
} from './image-text-stop-list-binding';

describe('image text stop-list delete binding', () => {
  const source = {
    senderId: 'user-1',
    sourceCreatedAt: '2026-09-06T12:00:00.000Z',
    deleteDeadlineAt: '2026-09-06T12:05:00.000Z',
    orderedPhotoIds: ['photo-1', 'photo-2'],
    caption: 'private visible text',
  } as const;
  const policyFingerprint = fingerprintImageTextStopListPolicy({
    settings: {
      messageLimitsImageTextScanEnabled: true,
      messageLimitsBlockedWords: ['казино'],
      messageLimitsBlockedDomains: ['casino.example'],
      nightModeTimezone: 'Europe/Moscow',
    },
    domainAllowlist: ['docs.example'],
  });

  it('round-trips a privacy-safe binding and matches the exact source', () => {
    const binding = buildImageTextStopListBinding({
      policyVersion: 'image-text-stop-list-v2',
      ocrVersion: 'tesseract-rus-eng-v2',
      nativeBehaviorFingerprintSha256: 'b'.repeat(64),
      policyFingerprint,
      ruleCode: 'MESSAGE_BLOCKED_WORD',
      value: 'казино',
      imageIndex: 1,
      primaryConfidencePermille: 960,
      confirmationConfidencePermille: 950,
      ...source,
    });

    expect(parseImageTextStopListBinding({ imageTextStopListBinding: binding })).toEqual(binding);
    expect(binding.policyVersion).toBe('image-text-stop-list-v2');
    const legacy = { ...binding, policyVersion: 'image-text-stop-list-v1' };
    expect(parseImageTextStopListBinding({ imageTextStopListBinding: legacy })).toEqual(legacy);
    expect(
      parseImageTextStopListBinding({
        imageTextStopListBinding: { ...binding, policyVersion: 'image-text-stop-list-v99' },
      }),
    ).toBeNull();
    expect(imageTextStopListSourceMatchesBinding(binding, source)).toBe(true);
    expect(imageTextStopListSourceMatchesBinding(binding, { ...source, caption: 'changed' })).toBe(
      false,
    );
    expect(JSON.stringify(binding)).not.toContain(source.caption);
    expect(JSON.stringify(binding)).not.toContain('photo-1');
  });

  it('rejects malformed or downgraded bindings', () => {
    const binding = buildImageTextStopListBinding({
      ocrVersion: 'tesseract-rus-eng-v2',
      nativeBehaviorFingerprintSha256: 'b'.repeat(64),
      policyFingerprint,
      ruleCode: 'MESSAGE_BLOCKED_DOMAIN',
      value: 'casino.example',
      imageIndex: 0,
      primaryConfidencePermille: 900,
      confirmationConfidencePermille: 900,
      ...source,
    });

    expect(binding.policyVersion).toBe('image-text-stop-list-v1');
    expect(
      parseImageTextStopListBinding({
        imageTextStopListBinding: { ...binding, sandboxBoundary: 'local_worker' },
      }),
    ).toBeNull();
    expect(
      parseImageTextStopListBinding({
        imageTextStopListBinding: { ...binding, confirmationConfidencePermille: 899 },
      }),
    ).toBeNull();
  });
});
