import { BadRequestException } from '@nestjs/common';

import { applySettingsSectionToAllChats } from './admin-settings-apply';
import { SETTINGS_SECTION_KEYS } from './admin.service.support';
import { chatSettingsSchema, stopWordsPolicySchema } from '@maxim/contracts/settings';
import type { ChatSettingsReadSnapshot } from './admin-chat-settings';

type SectionApplyParams = Parameters<typeof applySettingsSectionToAllChats>[0];

describe('admin settings section apply', () => {
  it('copies a confirmed JSON link policy and skips the retired allowlist synchronization', async () => {
    const revision = '2026-11-07T10:00:00.000Z';
    const settings = chatSettingsSchema.parse({
      settingsRevision: revision,
      linkRulesPolicy: { version: 1, mode: 'DENY_SELECTED', rules: [] },
      linkRulesStorageStatus: 'valid',
    });
    const applySettings: jest.MockedFunction<SectionApplyParams['applySettings']> = jest
      .fn()
      .mockResolvedValue({ sourceChatId: 'source', updatedChats: 1, appliedChatIds: ['target'] });
    const syncDomainAllowlistToChats = jest.fn();
    await applySettingsSectionToAllChats({
      sourceChatId: 'source',
      source: 'miniapp',
      body: {
        section: 'links',
        expectedSourceSettingsRevision: revision,
        target: { mode: 'selectedChats', chatIds: ['target'] },
      },
      getSourceSettings: async () => settings,
      applySettings,
      syncDomainAllowlistToChats,
    });
    expect(applySettings).toHaveBeenCalledWith(
      settings,
      { mode: 'selectedChats', favoriteTypes: [], chatIds: ['target'] },
      [...SETTINGS_SECTION_KEYS.links, 'botSpeechMedia'],
      expect.any(Array),
      undefined,
      revision,
    );
    expect(syncDomainAllowlistToChats).not.toHaveBeenCalled();
  });
  it('rejects an intervening administrator edit before copying a report policy', async () => {
    const applySettings = jest.fn();
    await expect(
      applySettingsSectionToAllChats({
        sourceChatId: 'source',
        source: 'miniapp',
        body: {
          section: 'reports',
          expectedSourceSettingsRevision: '2026-10-01T10:00:00.000Z',
          confirmedTargetChatIds: ['target'],
          target: { mode: 'selectedChats', chatIds: ['target'] },
        },
        getSourceSettings: async () =>
          chatSettingsSchema.parse({
            settingsRevision: '2026-10-01T10:01:00.000Z',
            reportsDeleteMode: 'HISTORY_24H',
            reportsMuteEnabled: true,
          }),
        applySettings,
        syncDomainAllowlistToChats: jest.fn(),
      }),
    ).rejects.toMatchObject({ status: 409, response: { partialApplied: false, appliedCount: 0 } });
    expect(applySettings).not.toHaveBeenCalled();
  });

  it('passes one confirmed immutable report snapshot and the exact target set to the writer', async () => {
    const revision = '2026-10-01T10:00:00.000Z';
    const settings = chatSettingsSchema.parse({ settingsRevision: revision, reportsEnabled: true });
    const applySettings = jest.fn().mockResolvedValue({
      sourceChatId: 'source',
      updatedChats: 1,
      appliedChatIds: ['source'],
    });
    await applySettingsSectionToAllChats({
      sourceChatId: 'source',
      source: 'miniapp',
      body: {
        section: 'reports',
        expectedSourceSettingsRevision: revision,
        confirmedTargetChatIds: ['source'],
      },
      getSourceSettings: async () => settings,
      applySettings,
      syncDomainAllowlistToChats: jest.fn(),
    });
    expect(applySettings).toHaveBeenCalledWith(
      settings,
      { mode: 'current', favoriteTypes: [], chatIds: [] },
      SETTINGS_SECTION_KEYS.reports,
      [],
      ['source'],
      revision,
    );
  });

  it('rejects a changed source revision before copying a stop-list', async () => {
    const applySettings = jest.fn();
    const settings = chatSettingsSchema.parse({
      stopWordsPolicy: stopWordsPolicySchema.parse({}),
      stopWordsRevision: 2,
    });
    await expect(
      applySettingsSectionToAllChats({
        sourceChatId: 'source',
        source: 'miniapp',
        body: { section: 'stopWords', expectedSourceRevision: 1 },
        getSourceSettings: async () => settings,
        getSourceStopWordsSettings: async () => ({ settings, stopWordsStorageStatus: 'valid' }),
        applySettings,
        syncDomainAllowlistToChats: jest.fn(),
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(applySettings).not.toHaveBeenCalled();
  });

  it.each([
    ['missing snapshot', undefined],
    [
      'invalid storage',
      {
        settings: chatSettingsSchema.parse({
          stopWordsPolicy: stopWordsPolicySchema.parse({}),
          stopWordsRevision: 4,
        }),
        stopWordsStorageStatus: 'invalid',
      },
    ],
    [
      'unconvertible legacy storage',
      {
        settings: chatSettingsSchema.parse({ stopWordsRevision: 4 }),
        stopWordsStorageStatus: 'legacy',
      },
    ],
  ] satisfies ReadonlyArray<readonly [string, ChatSettingsReadSnapshot | undefined]>)(
    'refuses to copy a disabled fallback from %s',
    async (_kind, snapshot) => {
      const getSourceSettings: jest.MockedFunction<SectionApplyParams['getSourceSettings']> = jest
        .fn()
        .mockResolvedValue(
          chatSettingsSchema.parse({ stopWordsPolicy: stopWordsPolicySchema.parse({}) }),
        );
      const applySettings: jest.MockedFunction<SectionApplyParams['applySettings']> = jest.fn();
      await expect(
        applySettingsSectionToAllChats({
          sourceChatId: 'source',
          source: 'miniapp',
          body: { section: 'stopWords', expectedSourceRevision: 4 },
          getSourceSettings,
          ...(snapshot ? { getSourceStopWordsSettings: async () => snapshot } : {}),
          applySettings,
          syncDomainAllowlistToChats: jest.fn(),
        }),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: 'STOP_WORDS_POLICY_REVIEW_REQUIRED', revision: 4, fieldPaths: [] },
      });
      expect(getSourceSettings).not.toHaveBeenCalled();
      expect(applySettings).not.toHaveBeenCalled();
    },
  );

  it.each(['valid', 'legacy'] as const)(
    'copies one complete %s stop-list snapshot without reading a second settings presentation',
    async (stopWordsStorageStatus) => {
      const settings = chatSettingsSchema.parse({
        stopWordsPolicy: stopWordsPolicySchema.parse({
          enabled: true,
          rules: [{ id: 'source-rule', kind: 'WORD', value: 'casino' }],
        }),
        stopWordsRevision: 4,
      });
      const getSourceSettings: jest.MockedFunction<SectionApplyParams['getSourceSettings']> =
        jest.fn();
      const applySettings: jest.MockedFunction<SectionApplyParams['applySettings']> = jest
        .fn()
        .mockResolvedValue({
          sourceChatId: 'source',
          updatedChats: 1,
          appliedChatIds: ['target'],
        });
      await applySettingsSectionToAllChats({
        sourceChatId: 'source',
        source: 'miniapp',
        body: {
          section: 'stopWords',
          expectedSourceRevision: 4,
          target: { mode: 'selectedChats', chatIds: ['target'] },
        },
        getSourceSettings,
        getSourceStopWordsSettings: async () => ({ settings, stopWordsStorageStatus }),
        applySettings,
        syncDomainAllowlistToChats: jest.fn(),
      });
      expect(getSourceSettings).not.toHaveBeenCalled();
      expect(applySettings).toHaveBeenCalledWith(
        settings,
        { mode: 'selectedChats', favoriteTypes: [], chatIds: ['target'] },
        ['stopWordsPolicy'],
        [],
        undefined,
        undefined,
      );
    },
  );
  it('does not expose the retired thematic section in the server mapping', () => {
    expect(SETTINGS_SECTION_KEYS).not.toHaveProperty('thematicFilters');
  });

  it('applies every photo duplicate setting with the duplicates section', () => {
    expect(SETTINGS_SECTION_KEYS.duplicates).toEqual(
      expect.arrayContaining([
        'duplicatePhotoEnabled',
        'duplicatePhotoMatchPreset',
        'duplicatePhotoScope',
        'duplicateCompareMode',
        'duplicateWindowMode',
        'duplicateStartTimeMinutes',
        'duplicateEndTimeMinutes',
        'duplicateTimezone',
      ]),
    );
  });

  it('applies profanity sensitivity with the profanity section', () => {
    expect(SETTINGS_SECTION_KEYS.profanityFilter).toContain('profanitySensitivity');
  });

  it('applies the complete independent policy without copying a source revision', () => {
    expect(SETTINGS_SECTION_KEYS.stopWords).toEqual(['stopWordsPolicy']);
  });

  it('keeps the storefront section scoped to its toggles and texts', () => {
    expect(SETTINGS_SECTION_KEYS.storefront).toEqual([
      'karavanStorefrontEnabled',
      'karavanStorefrontAdminsOnly',
      'karavanStorefrontMessageText',
      'karavanStorefrontOpenButtonText',
      'karavanStorefrontCatalogButtonText',
      'karavanStorefrontCreateButtonText',
    ]);
  });

  it('rejects a crafted request for the retired thematic section before applying settings', async () => {
    const getSourceSettings = jest.fn();
    const applySettings = jest.fn();
    const syncDomainAllowlistToChats = jest.fn();

    await expect(
      applySettingsSectionToAllChats({
        sourceChatId: 'chat-1',
        body: {
          section: 'thematicFilters',
          target: { mode: 'all', favoriteTypes: [], chatIds: [] },
        },
        source: 'miniapp',
        getSourceSettings,
        applySettings,
        syncDomainAllowlistToChats,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(getSourceSettings).not.toHaveBeenCalled();
    expect(applySettings).not.toHaveBeenCalled();
    expect(syncDomainAllowlistToChats).not.toHaveBeenCalled();
  });
});
