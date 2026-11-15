import { handleModerationMessagePreviewRequest } from './preview-transport-moderation-message';
import type { ApiTransport } from './transport';
import { markPreviewApiPrincipal } from './preview-principal';
import { handleAutopostsPreviewRequest } from './preview-transport-autoposts';
import { handleDialogPreviewRequest } from './preview-transport-dialog';
import { handleEventsPreviewRequest } from './preview-transport-events';
import { handleGiveawaysPreviewRequest } from './preview-transport-giveaways';
import { handlePublicationsPreviewRequest } from './preview-transport-publications';
import { handlePublicationDraftsPreviewRequest } from './preview-transport-publication-drafts';
import { handlePublisherPreviewRequest } from './preview-transport-publisher';
import {
  dispatchPreviewRequest,
  PREVIEW_NOT_HANDLED,
  type PreviewApiTransportOptions,
  type PreviewRequestHandler,
} from './preview-transport-runtime';
import { handleSettingsPreviewRequest } from './preview-transport-settings';
import { createPreviewState } from './preview-transport-state';
import { handleSystemPreviewRequest } from './preview-transport-system';
import { handleVkPreviewRequest } from './preview-transport-vk';
import { handlePreviewMessageRetention } from './preview-message-retention';

export type { PreviewApiTransportOptions, PreviewClock } from './preview-transport-runtime';

export const PREVIEW_REQUEST_HANDLERS: readonly PreviewRequestHandler[] = [
  async (context) => {
    if (
      context.segments[0] !== 'networks' &&
      !(
        context.segments[0] === 'managed-entities' &&
        (context.segments[1] === 'networks' || context.segments[3] === 'favorites')
      )
    )
      return PREVIEW_NOT_HANDLED;
    const { handleNetworksPreviewRequest } = await import('./preview-transport-networks');
    return handleNetworksPreviewRequest(context);
  },
  async (context) => {
    if (context.segments[0] !== 'marketplace') return PREVIEW_NOT_HANDLED;
    const { handleMarketplacePreviewRequest } = await import('./preview-transport-marketplace');
    return handleMarketplacePreviewRequest(context);
  },
  handlePreviewMessageRetention,
  async (context) => {
    if (context.segments[2] !== 'advertising-placement') return PREVIEW_NOT_HANDLED;
    const { handleAdvertisingPreviewRequest } = await import('./preview-transport-advertising');
    return handleAdvertisingPreviewRequest(context);
  },
  handlePublisherPreviewRequest,
  handleSystemPreviewRequest,
  handlePublicationDraftsPreviewRequest,
  handlePublicationsPreviewRequest,
  handleAutopostsPreviewRequest,
  handleGiveawaysPreviewRequest,
  handleDialogPreviewRequest,
  handleVkPreviewRequest,
  handleModerationMessagePreviewRequest,
  handleEventsPreviewRequest,
  handleSettingsPreviewRequest,
];

export function createPreviewApiTransport(options: PreviewApiTransportOptions = {}): ApiTransport {
  const state = createPreviewState(options);

  const request: ApiTransport['request'] = async (requestPath, init = {}) => {
    const url = new URL(requestPath, 'https://preview.local');
    return dispatchPreviewRequest(
      {
        state,
        url,
        segments: url.pathname.split('/').filter(Boolean),
        method: (init.method ?? 'GET').toUpperCase(),
        init,
      },
      PREVIEW_REQUEST_HANDLERS,
    );
  };

  const api: ApiTransport = {
    request,
    requestKeepalive(requestPath, init = {}) {
      void request(requestPath, init).catch((error: unknown) => {
        try {
          options.onKeepaliveError?.(error);
        } catch {
          // Keepalive callers cannot observe errors; never create a secondary unhandled rejection.
        }
      });
    },
  };

  return markPreviewApiPrincipal(api, state.me.userId);
}
