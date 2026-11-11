import { createElement, type ComponentProps } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HomeEntityFavoritesProvider } from '../../src/lib/home-entity-favorites-context';
import { getPreviewApiPrincipalUserId } from '../../src/lib/api/preview-principal';
import { SettingsApplyTargetSheet } from '../../src/pages/settings/settings-apply-target-sheet';
import { SettingsApplyPartialResult } from '../../src/pages/settings/settings-apply-partial-result';
import { createDefaultApplySettingsTarget } from '../../src/pages/settings/settings-apply-target';
import { createPreviewApiTransport } from '../../src/lib/api/preview-transport';
import { createPreviewState } from '../../src/lib/api/preview-transport-state';
import { registerNativeBackHandler, runNativeBackHandlers } from '../../src/lib/native-back';
import '../../src/styles.css';
import '../../src/styles/moderation-workspace.css';

type Props = ComponentProps<typeof SettingsApplyTargetSheet>;
type Options = Partial<Pick<Props, 'sheet' | 'preview' | 'previewLoading' | 'isApplying'>> & {
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

let options: Options = {
  sheet: { section: 'links', target: createDefaultApplySettingsTarget() },
  preview: previewFor(createDefaultApplySettingsTarget()),
  previewLoading: false,
  isApplying: false,
};
const render = (next: Options = {}) => {
  options = { ...options, ...next };
  root.render(
    <QueryClientProvider client={queryClient}>
      <HomeEntityFavoritesProvider api={api} verifiedUserId={verifiedUserId}>
        <MemoryRouter>
          {createElement(SettingsApplyTargetSheet, {
            api,
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
            onTargetChange: (target) => {
              actions.push({ kind: 'target', target });
              render({ sheet: { section: 'links', target } });
            },
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
    resolvePreview: () => render({ preview: previewFor(options.sheet!.target) }),
    back: runNativeBackHandlers,
  },
});
render();
