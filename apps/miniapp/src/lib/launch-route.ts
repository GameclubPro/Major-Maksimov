import type { ChannelDialogType } from '@maxim/contracts';

const CHANNEL_DIALOG_START_PARAM_PREFIX = 'cd-';
const GIVEAWAY_START_PARAM_PREFIX = 'gg-';
const MINIAPP_ROUTE_START_PARAM_PREFIX = 'mr-';
const PUBLISHER_POST_IMPORT_START_PARAM_PATTERN = /^pi_([A-Za-z0-9_-]{16,256})$/u;

const CHAT_SETTINGS_FOCUS = new Set([
  'birzhik',
  'broadcast',
  'comments',
  'giveaway',
  'polls',
  'requiredSubscription',
  'rules',
  'storefront',
]);
const CHANNEL_SETTINGS_FOCUS = new Set([
  'birzhik',
  'broadcast',
  'comments',
  'giveaway',
  'polls',
  'postSuggestions',
]);
const PUBLICATIONS_VIEWS = new Set(['plan', 'schedules', 'history']);

type ChannelDialogLaunchPayload = {
  v: 1;
  k: 'channel-dialog' | 'chat-dialog';
  c: string;
  m: ChannelDialogType;
  t: string;
};

type GiveawayLaunchPayload = {
  v: 1;
  k: 'giveaway';
  g: string;
};

type MiniappRouteLaunchPayload = {
  v: 1;
  k: 'route';
  r: string;
};

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readSearchParam(source: string, names: readonly string[]): string {
  const normalized = source.trim().replace(/^[?#]/u, '');
  const directValue = readSearchParamFromNormalizedSource(normalized, names);
  if (directValue) {
    return directValue;
  }

  const queryIndex = normalized.indexOf('?');
  return queryIndex >= 0
    ? readSearchParamFromNormalizedSource(normalized.slice(queryIndex + 1), names)
    : '';
}

function readSearchParamFromNormalizedSource(source: string, names: readonly string[]): string {
  const params = new URLSearchParams(source);
  for (const name of names) {
    const candidate = params.get(name);
    if (candidate?.trim()) {
      return candidate.trim();
    }
  }

  return '';
}

function readStartParamFromLocation(): string {
  const names = ['WebAppStartParam', 'startapp', 'startApp', 'start_param', 'startParam'];
  return (
    readSearchParam(window.location.search, names) || readSearchParam(window.location.hash, names)
  );
}

function readStartParamFromBridge(): string {
  const candidates = [
    window.MAX?.WebApp?.initDataUnsafe?.start_param,
    window.MAX?.WebApp?.init_data_unsafe?.start_param,
    window.MAX?.WebApp?.startParam,
    window.MAX?.WebApp?.start_param,
    window.WebApp?.initDataUnsafe?.start_param,
    window.WebApp?.init_data_unsafe?.start_param,
    window.WebApp?.startParam,
    window.WebApp?.start_param,
  ];

  for (const candidate of candidates) {
    const normalized = readString(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return '';
}

function readStartParamFromInitData(initData: string): string {
  if (!initData.trim()) {
    return '';
  }

  return readSearchParam(initData, ['start_param', 'startParam', 'WebAppStartParam']);
}

function parseDirectChannelSuggestionRoute(pathname: string, search: string): string | null {
  const match = pathname.match(/(?:^|\/)(channel\/([^/?#]+)\/dialog\/suggest)\/?$/u);
  const chatId = readString(match?.[2]);
  if (!match?.[1] || !chatId) {
    return null;
  }

  const params = new URLSearchParams(search);
  const tokens = params.getAll('token');
  const token = readString(tokens[0]);
  if (tokens.length !== 1 || token.length < 16 || token.length > 256) {
    return null;
  }

  return `/${match[1]}?token=${encodeURIComponent(token)}`;
}

function readDirectChannelSuggestionRouteFromLocation(): string | null {
  const hashRoute = window.location.hash.trim().replace(/^#/u, '');
  if (hashRoute.startsWith('/')) {
    try {
      const parsedHashRoute = new URL(hashRoute, 'https://miniapp.local');
      const directHashRoute = parseDirectChannelSuggestionRoute(
        parsedHashRoute.pathname,
        parsedHashRoute.search,
      );
      if (directHashRoute) {
        return directHashRoute;
      }
    } catch {
      // Fall through to the browser pathname.
    }
  }

  return parseDirectChannelSuggestionRoute(window.location.pathname, window.location.search);
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = window.atob(`${normalized}${padding}`);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function parseChannelDialogStartParam(value: string): ChannelDialogLaunchPayload | null {
  const normalized = value.trim();
  if (!normalized.startsWith(CHANNEL_DIALOG_START_PARAM_PREFIX)) {
    return null;
  }

  const encodedPayload = normalized.slice(CHANNEL_DIALOG_START_PARAM_PREFIX.length);
  if (!encodedPayload) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      decodeBase64Url(encodedPayload),
    ) as Partial<ChannelDialogLaunchPayload>;
    const chatId = readString(parsed.c);
    const type = parsed.m === 'suggest' ? 'suggest' : parsed.m === 'comments' ? 'comments' : null;
    const token = readString(parsed.t);
    if (
      parsed.v !== 1 ||
      (parsed.k !== 'channel-dialog' && parsed.k !== 'chat-dialog') ||
      !chatId ||
      !type ||
      token.length < 16 ||
      token.length > 256
    ) {
      return null;
    }

    return {
      v: 1,
      k: parsed.k,
      c: chatId,
      m: type,
      t: token,
    };
  } catch {
    return null;
  }
}

function parseGiveawayStartParam(value: string): GiveawayLaunchPayload | null {
  const normalized = value.trim();
  if (!normalized.startsWith(GIVEAWAY_START_PARAM_PREFIX)) {
    return null;
  }

  const encodedPayload = normalized.slice(GIVEAWAY_START_PARAM_PREFIX.length);
  if (!encodedPayload) {
    return null;
  }

  try {
    const parsed = JSON.parse(decodeBase64Url(encodedPayload)) as Partial<GiveawayLaunchPayload>;
    const giveawayId = readString(parsed.g);
    if (parsed.v !== 1 || parsed.k !== 'giveaway' || !giveawayId) {
      return null;
    }

    return {
      v: 1,
      k: 'giveaway',
      g: giveawayId,
    };
  } catch {
    return null;
  }
}

function normalizeRouteLaunchPath(value: string): string | null {
  const normalized = readString(value);
  if (!normalized.startsWith('/')) {
    return null;
  }

  try {
    const parsed = new URL(normalized, 'https://miniapp.local');
    if (parsed.origin !== 'https://miniapp.local') {
      return null;
    }

    const pathname = parsed.pathname;
    if (pathname === '/') {
      return `${pathname}${parsed.search}`;
    }

    if (pathname === '/chats' && !parsed.search) {
      return '/';
    }

    if (pathname === '/autoposts') {
      parsed.pathname = '/publications';
    }

    if (parsed.pathname === '/publications') {
      if (!hasAllowedPublicationsSearchParams(parsed)) {
        return null;
      }
      return `${parsed.pathname}${parsed.search}`;
    }

    if (
      /^\/suggestions\/[A-Za-z0-9_-]{1,160}\/(edit|reject|publish)$/u.test(pathname) &&
      !parsed.search
    ) {
      return pathname;
    }

    if (/^\/chat\/[^/?#]+\/events$/u.test(pathname) && !parsed.search) {
      return pathname;
    }

    if (/^\/publisher\/chat\/[^/?#]+\/auto-replies$/u.test(pathname) && !parsed.search) {
      return pathname;
    }

    if (
      /^\/publisher\/(chat|channel)\/[^/?#]+$/u.test(pathname) &&
      (parsed.search === '?focus=birzhik' ||
        (pathname.startsWith('/publisher/channel/') && parsed.search === '?focus=vk'))
    ) {
      return `${pathname}${parsed.search}`;
    }

    if (/^\/channel\/[^/?#]+\/stats$/u.test(pathname) && !parsed.search) {
      return pathname;
    }

    if (/^\/chat\/[^/?#]+\/settings$/u.test(pathname)) {
      if (!hasAllowedSearchParams(parsed, CHAT_SETTINGS_FOCUS)) {
        return null;
      }
      return `${pathname}${parsed.search}`;
    }

    if (/^\/channel\/[^/?#]+\/settings$/u.test(pathname)) {
      if (!hasAllowedSearchParams(parsed, CHANNEL_SETTINGS_FOCUS)) {
        return null;
      }
      return `${pathname}${parsed.search}`;
    }

    return null;
  } catch {
    return null;
  }
}

function hasAllowedPublicationsSearchParams(parsed: URL): boolean {
  const legacyValues = parsed.searchParams.getAll('legacy');
  if (
    legacyValues.length > 1 ||
    (legacyValues.length === 1 && [...parsed.searchParams.keys()].some((key) => key !== 'legacy'))
  ) {
    return false;
  }

  for (const [key, value] of parsed.searchParams.entries()) {
    if (key === 'view') {
      if (!PUBLICATIONS_VIEWS.has(value)) {
        return false;
      }
      continue;
    }
    if (key === 'compose') {
      if (value !== '1') {
        return false;
      }
      continue;
    }
    if (key === 'legacy') {
      if (value !== '1') {
        return false;
      }
      continue;
    }
    if (key === 'entityType' || key === 'sourceType') {
      if (value !== 'chat' && value !== 'channel') {
        return false;
      }
      continue;
    }
    if (key === 'entityId' || key === 'sourceId') {
      if (!value.trim()) {
        return false;
      }
      continue;
    }
    return false;
  }
  return true;
}

function hasAllowedSearchParams(parsed: URL, allowedFocus: Set<string>): boolean {
  const focusValues = parsed.searchParams.getAll('focus');
  const handoffValues = parsed.searchParams.getAll('handoff');
  const workspaceValues = parsed.searchParams.getAll('workspace');
  const legacyKindValues = parsed.searchParams.getAll('legacyKind');
  const legacyIdValues = parsed.searchParams.getAll('legacyId');

  if (
    focusValues.length > 1 ||
    handoffValues.length > 1 ||
    workspaceValues.length > 1 ||
    legacyKindValues.length > 1 ||
    legacyIdValues.length > 1
  ) {
    return false;
  }

  for (const [key, value] of parsed.searchParams.entries()) {
    if (key === 'focus') {
      if (!allowedFocus.has(value)) {
        return false;
      }
      continue;
    }

    if (key === 'handoff') {
      if (value !== '1') {
        return false;
      }
      continue;
    }

    if (key === 'workspace') {
      if (value !== 'autoposts') {
        return false;
      }
      continue;
    }

    if (key === 'legacyKind') {
      if (value !== 'autopost' && value !== 'broadcast') {
        return false;
      }
      continue;
    }

    if (key === 'legacyId') {
      if (!value.trim() || value.length > 256) {
        return false;
      }
      continue;
    }

    return false;
  }

  const hasLegacyTarget = legacyKindValues.length === 1 || legacyIdValues.length === 1;
  if (hasLegacyTarget) {
    return (
      focusValues[0] === 'broadcast' &&
      legacyKindValues.length === 1 &&
      legacyIdValues.length === 1 &&
      handoffValues.length === 0 &&
      workspaceValues.length === 0
    );
  }

  return workspaceValues.length === 0 || focusValues[0] === 'broadcast';
}

function parseMiniappRouteStartParam(value: string): string | null {
  const normalized = value.trim();
  if (!normalized.startsWith(MINIAPP_ROUTE_START_PARAM_PREFIX)) {
    return null;
  }

  const encodedPayload = normalized.slice(MINIAPP_ROUTE_START_PARAM_PREFIX.length);
  if (!encodedPayload) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      decodeBase64Url(encodedPayload),
    ) as Partial<MiniappRouteLaunchPayload>;
    if (parsed.v !== 1 || parsed.k !== 'route') {
      return null;
    }

    return normalizeRouteLaunchPath(parsed.r ?? '');
  } catch {
    return null;
  }
}

function buildChannelDialogRoute(launch: ChannelDialogLaunchPayload): string {
  const entitySegment = launch.k === 'chat-dialog' ? 'chat' : 'channel';
  return `/${entitySegment}/${encodeURIComponent(launch.c)}/dialog/${launch.m}?token=${encodeURIComponent(launch.t)}`;
}

type ResolveLaunchRouteOptions = {
  preferLocationDialog?: boolean;
};

export function resolveLaunchRoute(
  initData: string,
  options: ResolveLaunchRouteOptions = {},
): string | null {
  const startParamFromLocation = readStartParamFromLocation();
  // MAX can reuse a WebView whose initData still contains the previous launcher. A dialog URL
  // carries its own API-verified token, so the button that produced the current URL wins.
  const directSuggestionRoute = readDirectChannelSuggestionRouteFromLocation();
  if (options.preferLocationDialog !== false && directSuggestionRoute) {
    return directSuggestionRoute;
  }

  const locationDialogLaunch = parseChannelDialogStartParam(startParamFromLocation);
  if (options.preferLocationDialog !== false && locationDialogLaunch) {
    return buildChannelDialogRoute(locationDialogLaunch);
  }

  const startParam =
    readStartParamFromInitData(initData) || readStartParamFromBridge() || startParamFromLocation;

  const selectedDialogLaunch = parseChannelDialogStartParam(startParam);
  if (selectedDialogLaunch) {
    return buildChannelDialogRoute(selectedDialogLaunch);
  }

  const routeLaunch = parseMiniappRouteStartParam(startParam);
  if (routeLaunch) {
    return routeLaunch;
  }

  const publisherPostImportToken = PUBLISHER_POST_IMPORT_START_PARAM_PATTERN.exec(startParam)?.[1];
  if (publisherPostImportToken) {
    return `/publications?import=${encodeURIComponent(publisherPostImportToken)}`;
  }

  const giveawayLaunch = parseGiveawayStartParam(startParam);
  if (giveawayLaunch) {
    return `/giveaways/${encodeURIComponent(giveawayLaunch.g)}`;
  }

  return null;
}

export function createLaunchRouteResolver(): (initData: string) => string | null {
  let hasResolved = false;
  let previousLocationStartParam = '';
  let previousDirectSuggestionRoute = '';
  let previousLauncherStartParam = '';
  let preferLocationDialog = true;

  return (initData: string) => {
    const locationStartParam = readStartParamFromLocation();
    const directSuggestionRoute = readDirectChannelSuggestionRouteFromLocation() ?? '';
    const launcherStartParam = readStartParamFromInitData(initData) || readStartParamFromBridge();

    if (
      !hasResolved ||
      locationStartParam !== previousLocationStartParam ||
      directSuggestionRoute !== previousDirectSuggestionRoute
    ) {
      preferLocationDialog = true;
    } else if (launcherStartParam !== previousLauncherStartParam) {
      // Once MAX supplies a newer launcher for the same document URL, do not let the URL fallback
      // pin the app to the dialog from the previous launch.
      preferLocationDialog = false;
    }

    hasResolved = true;
    previousLocationStartParam = locationStartParam;
    previousDirectSuggestionRoute = directSuggestionRoute;
    previousLauncherStartParam = launcherStartParam;

    return resolveLaunchRoute(initData, { preferLocationDialog });
  };
}

export const resolveLaunchDialogRoute = resolveLaunchRoute;
