import {
  exactImageSettingsDigest,
  hasValidImageComparisonEvidence,
  messageDuplicateSettingsDigest,
} from './message-duplicate-state';
import {
  duplicateSettings,
  preUnicodeNearSettingsDigests,
  preSafeTextSettingsDigests,
  preBoundedPhoneSettingsDigests,
  prePhoneBoundarySettingsDigests,
  preSourceBoundPhoneSettingsDigests,
  preV3HistorySettingsDigests,
  preSemanticUnitSettingsDigests,
  prePrefixUnitSettingsDigests,
  preElectricalUnitSettingsDigests,
  preSourceReaderSettingsDigests,
} from './message-duplicate-test-fixtures';

describe('safe text evidence compatibility', () => {
  it('accepts the v2 recompression reader and rejects retained v1 proof', () => {
    const evidence = {
      compareMode: 'IMAGE',
      mediaHashes: ['b'.repeat(64)],
      original: { mediaHashes: ['a'.repeat(64)] },
      imageRecompression: {
        version: 'native-recompression-v2',
        originalHash: 'a'.repeat(64),
        currentHash: 'b'.repeat(64),
      },
    };
    expect(hasValidImageComparisonEvidence(evidence)).toBe(true);
    expect(
      hasValidImageComparisonEvidence({
        ...evidence,
        imageRecompression: { ...evidence.imageRecompression, version: 'native-recompression-v1' },
      }),
    ).toBe(false);
  });

  it('revokes IMAGE settings recorded by the v1 recompression reader', () => {
    const settings = duplicateSettings({
      duplicateWindowMode: 'INTERVAL',
      duplicateWarnWindowSec: 3600,
      duplicatePhotoScope: 'SAME_AUTHOR',
      duplicateHistoryRevision: 0,
    });
    // Recorded from the image-recompression-fixed-window-v1 digest at ffc24f5f0.
    expect(exactImageSettingsDigest(settings)).not.toBe(
      '1230b6121332223aaab76371abc640ed406ae0e40a04d302da171c52c20be950',
    );
  });

  it('uses the same text and image policy for both retained comparison settings', () => {
    const message = duplicateSettings({ duplicateCompareMode: 'MESSAGE' });
    const text = duplicateSettings({ duplicateCompareMode: 'TEXT' });
    expect(messageDuplicateSettingsDigest(message)).toBe(messageDuplicateSettingsDigest(text));
    expect(exactImageSettingsDigest(message)).toBe(exactImageSettingsDigest(text));
  });
  it.each([
    ['STANDARD', {}],
    ['STRICT', { duplicateDetectionPreset: 'STRICT' }],
    ['CUSTOM_NEAR', { duplicateDetectionPreset: 'CUSTOM', duplicateNearMatchEnabled: true }],
    ['CUSTOM_PHONE', { duplicateDetectionPreset: 'CUSTOM', duplicateIgnorePhonesEnabled: true }],
  ] as const)('revokes prior quantity-unit %s text evidence', (key, overrides) => {
    expect(messageDuplicateSettingsDigest(duplicateSettings(overrides))).not.toBe(
      preSourceReaderSettingsDigests[key],
    );
    expect(messageDuplicateSettingsDigest(duplicateSettings(overrides))).not.toBe(
      preSemanticUnitSettingsDigests[key],
    );
    expect(messageDuplicateSettingsDigest(duplicateSettings(overrides))).not.toBe(
      prePrefixUnitSettingsDigests[key],
    );
    expect(messageDuplicateSettingsDigest(duplicateSettings(overrides))).not.toBe(
      preElectricalUnitSettingsDigests[key],
    );
  });
  it('revokes earlier IMAGE authority whose publication clock used the old source reader', () => {
    expect(exactImageSettingsDigest(duplicateSettings())).not.toBe(
      preSourceReaderSettingsDigests.IMAGE,
    );
    expect(exactImageSettingsDigest(duplicateSettings())).not.toBe(
      preSemanticUnitSettingsDigests.IMAGE,
    );
    expect(exactImageSettingsDigest(duplicateSettings())).not.toBe(
      prePrefixUnitSettingsDigests.IMAGE,
    );
    expect(exactImageSettingsDigest(duplicateSettings())).not.toBe(
      preElectricalUnitSettingsDigests.IMAGE,
    );
    expect(
      exactImageSettingsDigest(duplicateSettings({ duplicateDetectionPreset: 'STRICT' })),
    ).toBe(exactImageSettingsDigest(duplicateSettings()));
  });
  it.each([
    ['STRICT', { duplicateDetectionPreset: 'STRICT' }],
    ['CUSTOM_NEAR', { duplicateDetectionPreset: 'CUSTOM', duplicateNearMatchEnabled: true }],
    ['CUSTOM_PHONE', { duplicateDetectionPreset: 'CUSTOM', duplicateIgnorePhonesEnabled: true }],
  ] as const)('invalidates previous %s evidence, including phone-only CUSTOM', (key, overrides) => {
    expect(messageDuplicateSettingsDigest(duplicateSettings(overrides))).not.toBe(
      preSafeTextSettingsDigests[key],
    );
    expect(messageDuplicateSettingsDigest(duplicateSettings(overrides))).not.toBe(
      preBoundedPhoneSettingsDigests[key],
    );
    expect(messageDuplicateSettingsDigest(duplicateSettings(overrides))).not.toBe(
      prePhoneBoundarySettingsDigests[key],
    );
    expect(messageDuplicateSettingsDigest(duplicateSettings(overrides))).not.toBe(
      preSourceBoundPhoneSettingsDigests[key],
    );
    expect(messageDuplicateSettingsDigest(duplicateSettings(overrides))).not.toBe(
      preV3HistorySettingsDigests[key],
    );
  });
  it.each(['STRICT', 'CUSTOM'] as const)('invalidates pre-Unicode %s evidence', (preset) => {
    const settings = duplicateSettings({
      duplicateDetectionPreset: preset,
      duplicateNearMatchEnabled: true,
    });
    expect(messageDuplicateSettingsDigest(settings)).not.toBe(
      preUnicodeNearSettingsDigests[preset],
    );
    if (preset === 'STRICT') {
      expect(
        messageDuplicateSettingsDigest({ ...settings, duplicateNearMatchEnabled: false }),
      ).toBe(messageDuplicateSettingsDigest(settings));
    }
  });

  it.each(['STANDARD', 'CUSTOM'] as const)(
    'revokes old exact %s grants while keeping preset-independent semantics',
    (preset) => {
      expect(
        messageDuplicateSettingsDigest(duplicateSettings({ duplicateDetectionPreset: preset })),
      ).toBe(messageDuplicateSettingsDigest(duplicateSettings()));
      expect(messageDuplicateSettingsDigest(duplicateSettings())).not.toBe(
        preV3HistorySettingsDigests.STANDARD,
      );
    },
  );

  it('revokes old CUSTOM link-only evidence after the storage incarnation changes', () => {
    expect(
      messageDuplicateSettingsDigest(
        duplicateSettings({
          duplicateDetectionPreset: 'CUSTOM',
          duplicateIgnoreLinksEnabled: true,
        }),
      ),
    ).not.toBe('1cef59a480ea7d36decb8631c350c3ed9b176309604377c98f481dac824c2a93');
  });

  it.each(['STANDARD', 'STRICT', 'CUSTOM'] as const)(
    'revokes old IMAGE grants while keeping independence of %s text settings',
    (preset) => {
      expect(
        exactImageSettingsDigest(
          duplicateSettings({
            duplicateDetectionPreset: preset,
            duplicateNearMatchEnabled: true,
            duplicateIgnorePhonesEnabled: true,
          }),
        ),
      ).toBe(exactImageSettingsDigest(duplicateSettings()));
      expect(exactImageSettingsDigest(duplicateSettings())).not.toBe(
        preV3HistorySettingsDigests.IMAGE,
      );
    },
  );
});
