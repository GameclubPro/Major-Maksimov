import '../../src/styles.css';

import { createElement, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  HomeEntityFavoritesProvider,
  useHomeEntityFavorites,
} from '../../src/lib/home-entity-favorites-context';
import { getPreviewApiPrincipalUserId } from '../../src/lib/api/preview-principal';
import { SettingsApplyTargetSheet } from '../../src/pages/settings/settings-apply-target-sheet';
import { SettingsApplyPartialResult } from '../../src/pages/settings/settings-apply-partial-result';
import { createDefaultApplySettingsTarget } from '../../src/pages/settings/settings-apply-target';
import { SettingsSectionSaveFooter } from '../../src/pages/settings/settings-section-save-footer';
import { useSettingsSaveFolder } from '../../src/pages/settings/use-settings-save-folder';
import '../../src/pages/settings/settings-section-save-footer.css';
import { createPreviewApiTransport } from '../../src/lib/api/preview-transport';
import { createPreviewState } from '../../src/lib/api/preview-transport-state';
import { registerNativeBackHandler, runNativeBackHandlers } from '../../src/lib/native-back';
import '../../src/styles/moderation-workspace.css';

type Props = ComponentProps<typeof SettingsApplyTargetSheet>;
type Options = Partial<
  Pick<Props, 'sheet' | 'preview' | 'previewLoading' | 'previewError' | 'isApplying'>
> & {
  hasChanges?: boolean;
  partial?: Omit<ComponentProps<typeof SettingsApplyPartialResult>, 'onClose'> | null;
};
type Target = NonNullable<Props['sheet']>['target'];

const api = createPreviewApiTransport();
const queryClient = new QueryClient();
const verifiedUserId = getPreviewApiPrincipalUserId(api)!;
const sourceState = createPreviewState({});
const actions: Array<{ kind: string; target?: Target }> = [];
const root = createRoot(document.getElementById('root')!);
const previewFor = (target: Target): NonNullable<Props['preview']> => {
  const chats = target.mode === 'current' ? sourceState.chats.slice(0, 1) : sourceState.chats;
  return {
    sourceChatId: sourceState.chats[0]!.id,
    targetMode: target.mode,
    favoriteTypes: target.favoriteTypes,
    updatedChats: chats.length,
    appliedChatIds: chats.map((chat) => chat.id),
    sampleChats: chats,
  };
};

const allTarget: Target = { ...createDefaultApplySettingsTarget(), mode: 'all' };
const sourceChatId = sourceState.chats[0]!.id;
let favoriteActions: ReturnType<typeof useHomeEntityFavorites>['actions'];
let options: Options = {
  sheet: { sourceChatId, section: 'links', target: allTarget },
  preview: previewFor(allTarget),
  previewLoading: false,
  isApplying: false,
  hasChanges: true,
};
function open(target: Target) {
  actions.push({ kind: 'target', target });
  render({
    sheet: { sourceChatId, section: 'links', target },
    previewLoading: true,
    previewError: null,
  });
}
function Harness() {
  favoriteActions = useHomeEntityFavorites().actions;
  const folder = useSettingsSaveFolder(sourceChatId, null);
  return (
    <>
      <div className="settings-drilldown__footer" style={{ maxWidth: 390, margin: '30px auto' }}>
        <SettingsSectionSaveFooter
          section="links"
          hasChanges={options.hasChanges ?? true}
          isSavingSettings={false}
          savingSection={null}
          isApplyingSectionToAll={options.isApplying ?? false}
          applyingSection={options.isApplying ? 'links' : null}
          onSaveSection={() => actions.push({ kind: 'source' })}
          onSaveAll={() => open(allTarget)}
          folder={
            folder
              ? {
                  ...folder,
                  onSave: () =>
                    open({ mode: 'favoriteTypes', favoriteTypes: [folder.type], chatIds: [] }),
                }
              : null
          }
        />
      </div>
      {createElement(SettingsApplyTargetSheet, {
        sheet: null,
        preview: null,
        previewLoading: false,
        previewError: null,
        sectionLabel: 'Ссылки',
        overlayStyle: undefined,
        isApplying: false,
        ...options,
        onClose: () => {
          actions.push({ kind: 'close' });
          render({ sheet: null });
        },
        onRetry: () => render({ previewLoading: true, previewError: null }),
        onConfirm: () => {
          actions.push({ kind: 'confirm', target: options.sheet!.target });
          render({ isApplying: true });
        },
      })}
      {options.partial ? (
        <SettingsApplyPartialResult
          {...options.partial}
          onClose={() => render({ partial: null })}
        />
      ) : null}
    </>
  );
}
const render = (next: Options = {}) => {
  options = { ...options, ...next };
  root.render(
    <QueryClientProvider client={queryClient}>
      <HomeEntityFavoritesProvider api={api} verifiedUserId={verifiedUserId}>
        <MemoryRouter>
          <Harness />
        </MemoryRouter>
      </HomeEntityFavoritesProvider>
    </QueryClientProvider>,
  );
};

registerNativeBackHandler(
  () => {
    actions.push({ kind: 'parent-back' });
    return true;
  },
  { priority: 620 },
);
document.body.dataset.miniappProfile = 'moderation';
Object.assign(window, {
  settingsApplyTargetTest: {
    actions,
    render,
    target: () => options.sheet?.target,
    resolvePreview: () =>
      render({ preview: previewFor(options.sheet!.target), previewLoading: false }),
    moveSource: () =>
      favoriteActions.setFavorite({
        entityType: 'chat',
        entityId: sourceChatId,
        expectedFavoriteType: 'important',
        favoriteType: 'broadcast',
      }),
    back: runNativeBackHandlers,
  },
});
render();
