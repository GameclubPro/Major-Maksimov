import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { contractsSourceAliases } from '../../scripts/vite-contracts-source.mjs';
import { sharedSettingsChunkSources } from './shared-settings-chunks';

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const base = normalizeBasePath(env.MINIAPP_BASE_PATH || env.VITE_PUBLIC_BASE_PATH || '/app/');
  const apiFallbacksEnabled = Boolean(env.VITE_API_FALLBACK_BASES?.trim());
  const routerMode = env.VITE_ROUTER_MODE?.trim() === 'hash' ? 'hash' : 'browser';

  return {
    plugins: [
      react(),
      {
        name: 'maxim-visual-server-identity',
        apply: 'serve',
        configureServer(server) {
          const identity = process.env.MAXIM_VISUAL_SERVER_ID;
          if (identity) {
            server.middlewares.use((_request, response, next) => {
              response.setHeader('X-Maxim-Visual-Server', identity);
              next();
            });
          }
        },
      },
    ],
    resolve: {
      dedupe: ['zod'],
      alias: contractsSourceAliases(fileURLToPath(new URL('../../', import.meta.url)), command),
    },
    define: {
      __MAXIM_API_FALLBACKS_ENABLED__: JSON.stringify(apiFallbacksEnabled),
      __MAXIM_ROUTER_MODE__: JSON.stringify(routerMode),
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
    },
    base,
    build: {
      manifest: true,
      rolldownOptions: {
        output: {
          codeSplitting: {
            groups: [
              { name: 'initial', tags: ['$initial'], priority: 10 },
              ...Object.entries(sharedSettingsChunkSources).map(([name, sources]) => ({
                name,
                test: (id: string) =>
                  sources.some((source) => id.replaceAll('\\', '/').endsWith(source)),
                includeDependenciesRecursively: false,
                priority: 30,
              })),
              ...Object.entries(routeChunkSources).map(([name, sources]) => ({
                name,
                test: (id: string) =>
                  sources.some((source) => id.replaceAll('\\', '/').endsWith(source)),
                includeDependenciesRecursively: false,
              })),
            ],
          },
        },
      },
    },
  };
});

function normalizeBasePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '/app/';
  }

  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeadingSlash.endsWith('/') ? withLeadingSlash : `${withLeadingSlash}/`;
}

const routeChunkSources = {
  'managed-favorites': [
    '/src/lib/home-entity-favorites-context.tsx',
    '/src/lib/home-entity-favorites-session.ts',
    '/src/lib/home-entity-favorites.ts',
    '/src/lib/home-entity-favorite-label-sync.ts',
    '/src/lib/api/managed-entity-favorites-client.ts',
    '/src/lib/api/managed-entity-favorite-labels-response.ts',
    '/src/lib/api/managed-entity-networks-client.ts',
    '/src/lib/api/managed-entity-networks-response.ts',
  ],
  'single-chat-settings': [
    '/src/pages/settings-page.tsx',
    '/src/pages/settings-page.legacy.tsx',
    '/src/pages/settings-page-state.ts',
    '/src/pages/settings/settings-message-retention-model.ts',
    '/src/pages/settings/chat-settings-workspace.tsx',
    '/src/pages/settings/use-settings-draft.ts',
    '/src/pages/settings/use-settings-rules.ts',
    '/src/pages/settings/use-settings-required-subscription.ts',
    '/src/pages/settings/settings-page-helpers.tsx',
    '/src/pages/settings/settings-apply-target.ts',
    '/src/lib/api/chat-settings-client.ts',
    '/src/lib/api/stop-words-client.ts',
  ],
  'network-settings-editor': [
    '/src/pages/network-settings-route.tsx',
    '/src/pages/network-settings-overview.tsx',
    '/packages/contracts/dist/network-settings-read.js',
    '/src/lib/api/network-settings-client.ts',
    '/src/pages/network-settings-page.tsx',
    '/src/features/network-settings/network-settings-controller.ts',
    '/src/features/network-settings/network-settings-operation-state.ts',
    '/src/lib/network-settings-operation-storage.ts',
    '/src/lib/network-settings-workspace-state.ts',
    '/src/features/network-settings/network-settings-field-bindings.ts',
  ],
};
