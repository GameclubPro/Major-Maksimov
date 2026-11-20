import { getPreviewDevicePreset, type PreviewDevice } from './preview-device';

export type MaxSharePayload =
  | {
      text?: string;
      link?: string;
    }
  | {
      mid: string;
      chatType?: 'DIALOG' | 'CHAT';
    };

type MaxBackButtonHandler = () => void;
export type MaxPlatform = 'ios' | 'android' | 'desktop' | 'web' | 'unknown';
export type MaxTheme = 'light' | 'dark';

const LEGACY_ANDROID_MAJOR_MAX = 9;
const LEGACY_ANDROID_CHROMIUM_MAJOR_MAX = 99;
const KEYBOARD_OPEN_OVERLAP_THRESHOLD_PX = 120;
const NATIVE_HAPTIC_DEDUPLICATE_MS = 80;
const VISUAL_VIEWPORT_BOTTOM_INSET_MAX_PX = 96;
const THEME_COLOR: Record<MaxTheme, string> = {
  light: '#f3f6f8',
  dark: '#0d141b',
};

function resolveBridge() {
  if (typeof window === 'undefined') {
    return undefined;
  }

  return window.MAX?.WebApp ?? window.WebApp;
}

export function getMaxBridge() {
  return resolveBridge();
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasNonEmptyObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && Object.keys(value).length > 0;
}

function hasBridgeRuntimePayload(bridge: ReturnType<typeof resolveBridge>): boolean {
  return Boolean(
    hasNonEmptyString(bridge?.initData) ||
    hasNonEmptyString(bridge?.init_data) ||
    hasNonEmptyObject(bridge?.initDataUnsafe) ||
    hasNonEmptyObject(bridge?.init_data_unsafe),
  );
}

function shouldSkipNativeSideEffects(): boolean {
  if (typeof window !== 'undefined' && window.__MAXIM_VISUAL_BRIDGE__) {
    return false;
  }

  if (typeof window !== 'undefined' && window.__MAXIM_FORCE_NATIVE_VISUAL_MODE__ === true) {
    return true;
  }

  if (typeof document === 'undefined') {
    return false;
  }

  const client = document.documentElement.dataset.maxClient;
  return client === 'preview' || client === 'browser';
}

export function resolveNativeSideEffectBridge() {
  const bridge = resolveBridge();
  if (!bridge || shouldSkipNativeSideEffects() || !hasBridgeRuntimePayload(bridge)) {
    return undefined;
  }

  return bridge;
}

function clampPx(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveViewportMetrics() {
  const viewport = window.visualViewport;
  const height = Math.round(viewport?.height ?? window.innerHeight);
  const top = Math.round(viewport?.offsetTop ?? 0);
  const rawBottomInset = Math.max(0, Math.round(window.innerHeight - (height + top)));
  const keyboardOverlap = rawBottomInset;

  return {
    width: Math.round(viewport?.width ?? window.innerWidth),
    height,
    top,
    left: Math.round(viewport?.offsetLeft ?? 0),
    bottom:
      keyboardOverlap >= KEYBOARD_OPEN_OVERLAP_THRESHOLD_PX
        ? 0
        : clampPx(rawBottomInset, 0, VISUAL_VIEWPORT_BOTTOM_INSET_MAX_PX),
    keyboardOverlap,
  };
}

let reliableSettingsGridLayout: boolean | null = null;

function parseMajorVersion(userAgent: string, pattern: RegExp): number | null {
  const match = userAgent.match(pattern);
  if (!match?.[1]) {
    return null;
  }

  const major = Number.parseInt(match[1], 10);
  return Number.isFinite(major) ? major : null;
}

export function isLegacyAndroidSettingsDrilldownUserAgent(userAgent: string): boolean {
  if (!/Android/i.test(userAgent)) {
    return false;
  }

  const androidMajor = parseMajorVersion(userAgent, /Android\s+(\d+)/i);
  if (androidMajor !== null && androidMajor <= LEGACY_ANDROID_MAJOR_MAX) {
    return true;
  }

  const chromiumMajor = parseMajorVersion(userAgent, /(?:Chrome|Chromium)\/(\d+)/i);
  return chromiumMajor !== null && chromiumMajor <= LEGACY_ANDROID_CHROMIUM_MAJOR_MAX;
}

function hasReliableSettingsGridLayout(): boolean {
  if (reliableSettingsGridLayout !== null) {
    return reliableSettingsGridLayout;
  }

  if (
    typeof CSS === 'undefined' ||
    typeof CSS.supports !== 'function' ||
    !CSS.supports('display', 'grid') ||
    !CSS.supports('grid-template-rows', 'minmax(0, 1fr) auto')
  ) {
    reliableSettingsGridLayout = false;
    return reliableSettingsGridLayout;
  }

  if (!document.body) {
    return true;
  }

  const host = document.createElement('div');
  const body = document.createElement('div');
  const filler = document.createElement('div');
  const footer = document.createElement('div');

  host.style.cssText = [
    'position:absolute',
    'left:-10000px',
    'top:-10000px',
    'width:100px',
    'height:100px',
    'display:grid',
    'grid-template-rows:minmax(0, 1fr) auto',
    'overflow:hidden',
    'visibility:hidden',
  ].join(';');
  body.style.cssText = 'min-height:0;overflow:auto';
  filler.style.cssText = 'height:200px';
  footer.style.cssText = 'height:20px';

  body.appendChild(filler);
  host.appendChild(body);
  host.appendChild(footer);
  document.body.appendChild(host);

  const hostRect = host.getBoundingClientRect();
  const bodyRect = body.getBoundingClientRect();
  const footerRect = footer.getBoundingClientRect();
  host.parentNode?.removeChild(host);

  reliableSettingsGridLayout =
    bodyRect.height > 70 &&
    bodyRect.height < 82 &&
    footerRect.height > 18 &&
    footerRect.bottom <= hostRect.bottom + 1;

  return reliableSettingsGridLayout;
}

function resolveSettingsDrilldownLegacyReason(
  platform: MaxPlatform,
): 'user-agent' | 'layout' | null {
  if (platform !== 'android') {
    return null;
  }

  if (
    typeof navigator !== 'undefined' &&
    isLegacyAndroidSettingsDrilldownUserAgent(navigator.userAgent)
  ) {
    return 'user-agent';
  }

  return hasReliableSettingsGridLayout() ? null : 'layout';
}

function normalizePlatform(
  value: string | undefined,
  previewDevice: PreviewDevice | null | undefined,
): MaxPlatform {
  if (previewDevice) {
    return getPreviewDevicePreset(previewDevice).platform === 'ios' ? 'ios' : 'android';
  }

  const normalized = value?.trim().toLowerCase();
  if (normalized === 'ios' || normalized === 'iphone') {
    return 'ios';
  }
  if (normalized === 'android') {
    return 'android';
  }
  if (normalized === 'desktop') {
    return 'desktop';
  }
  if (normalized === 'web') {
    return 'web';
  }

  return 'unknown';
}

function normalizeTheme(value: unknown): MaxTheme | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'dark' || normalized === 'night') {
    return 'dark';
  }
  if (normalized === 'light' || normalized === 'day') {
    return 'light';
  }

  return null;
}

function parseHexColor(value: unknown): [number, number, number] | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().replace(/^#/u, '');
  const expanded =
    normalized.length === 3
      ? normalized
          .split('')
          .map((part) => `${part}${part}`)
          .join('')
      : normalized;

  if (!/^[0-9a-f]{6}$/iu.test(expanded)) {
    return null;
  }

  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
  ];
}

function isDarkHexColor(value: unknown): boolean | null {
  const rgb = parseHexColor(value);
  if (!rgb) {
    return null;
  }

  const [red, green, blue] = rgb.map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0);

  return luminance < 0.42;
}

function resolveThemeFromBridge(bridge: ReturnType<typeof resolveBridge>): MaxTheme | null {
  const explicitTheme =
    normalizeTheme(bridge?.colorScheme) ??
    normalizeTheme(bridge?.color_scheme) ??
    normalizeTheme(bridge?.theme);
  if (explicitTheme) {
    return explicitTheme;
  }

  const themeParams = bridge?.themeParams ?? bridge?.theme_params;
  if (themeParams) {
    const darkBackground =
      isDarkHexColor(themeParams.bg_color) ??
      isDarkHexColor(themeParams.background_color) ??
      isDarkHexColor(themeParams.secondary_bg_color);
    if (darkBackground !== null) {
      return darkBackground ? 'dark' : 'light';
    }
  }

  return null;
}

function resolvePreferredTheme(bridge: ReturnType<typeof resolveBridge>): MaxTheme {
  const bridgeTheme = resolveThemeFromBridge(bridge);
  if (bridgeTheme) {
    return bridgeTheme;
  }

  if (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches
  ) {
    return 'dark';
  }

  return 'light';
}

function applyRootEnvironment(
  options: { previewDevice?: PreviewDevice | null } = {},
  viewportProbe?: HTMLElement | null,
) {
  const root = document.documentElement;
  const bridge = resolveBridge();
  const {
    width,
    height,
    top: viewportTop,
    left: viewportLeft,
    bottom: viewportBottom,
    keyboardOverlap,
  } = resolveViewportMetrics();
  const previewPreset = options.previewDevice
    ? getPreviewDevicePreset(options.previewDevice)
    : null;
  const platform = normalizePlatform(bridge?.platform, options.previewDevice);
  const theme = resolvePreferredTheme(bridge);
  const forceNativeVisualMode = window.__MAXIM_FORCE_NATIVE_VISUAL_MODE__ === true;

  root.dataset.maxPlatform = platform;
  root.dataset.maxTheme = theme;
  const themeColorMeta =
    typeof document.querySelector === 'function'
      ? document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      : null;
  themeColorMeta?.setAttribute('content', THEME_COLOR[theme]);
  root.dataset.maxClient = forceNativeVisualMode
    ? 'native'
    : previewPreset
      ? 'preview'
      : bridge
        ? 'native'
        : 'browser';

  const legacySettingsDrilldownReason = resolveSettingsDrilldownLegacyReason(platform);
  if (legacySettingsDrilldownReason) {
    root.dataset.maxLegacySettingsDrilldown = 'true';
    root.dataset.maxLegacySettingsDrilldownReason = legacySettingsDrilldownReason;
  } else {
    delete root.dataset.maxLegacySettingsDrilldown;
    delete root.dataset.maxLegacySettingsDrilldownReason;
  }

  if (platform === 'ios') {
    root.style.setProperty('--app-shell-max-width', '560px');
    root.style.setProperty('--app-topbar-radius', '24px');
    root.style.setProperty('--app-bottom-nav-radius', '26px');
  } else if (platform === 'android') {
    root.style.setProperty('--app-shell-max-width', '520px');
    root.style.setProperty('--app-topbar-radius', '20px');
    root.style.setProperty('--app-bottom-nav-radius', '20px');
  } else {
    root.style.setProperty('--app-shell-max-width', '540px');
    root.style.setProperty('--app-topbar-radius', '22px');
    root.style.setProperty('--app-bottom-nav-radius', '24px');
  }

  if (options.previewDevice) {
    root.dataset.maxPreviewDevice = options.previewDevice;
  } else {
    delete root.dataset.maxPreviewDevice;
  }

  root.style.setProperty('--app-viewport-height', `${height}px`);
  root.style.setProperty('--app-viewport-width', `${width}px`);
  root.style.setProperty('--app-visual-viewport-top', `${viewportTop}px`);
  root.style.setProperty('--app-visual-viewport-left', `${viewportLeft}px`);
  root.style.setProperty('--app-visual-viewport-bottom', `${viewportBottom}px`);
  // A native WebView can inset fixed positioning without shrinking visualViewport.
  const layoutViewportBottom = viewportProbe
    ? clampPx(
        Math.round(window.innerHeight - viewportProbe.getBoundingClientRect().bottom),
        0,
        VISUAL_VIEWPORT_BOTTOM_INSET_MAX_PX,
      )
    : 0;
  root.style.setProperty(
    '--app-layout-viewport-bottom',
    `${keyboardOverlap >= KEYBOARD_OPEN_OVERLAP_THRESHOLD_PX ? 0 : layoutViewportBottom}px`,
  );
  root.style.setProperty('--app-keyboard-overlap', `${keyboardOverlap}px`);

  if (keyboardOverlap >= KEYBOARD_OPEN_OVERLAP_THRESHOLD_PX) {
    root.dataset.maxKeyboardOpen = 'true';
  } else {
    delete root.dataset.maxKeyboardOpen;
  }
}

export function syncMaxNativeEnvironment(
  options: { previewDevice?: PreviewDevice | null } = {},
): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => undefined;
  }

  const viewportProbe = document.body ? document.createElement('div') : null;
  if (viewportProbe) {
    viewportProbe.setAttribute('aria-hidden', 'true');
    viewportProbe.style.cssText =
      'position:fixed;bottom:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none';
    document.body.appendChild(viewportProbe);
  }
  const apply = () => {
    applyRootEnvironment(options, viewportProbe);
  };
  const colorSchemeMedia = window.matchMedia?.('(prefers-color-scheme: dark)');

  apply();

  window.addEventListener('resize', apply, { passive: true });
  window.visualViewport?.addEventListener('resize', apply);
  window.visualViewport?.addEventListener('scroll', apply);
  colorSchemeMedia?.addEventListener?.('change', apply);

  return () => {
    window.removeEventListener('resize', apply);
    window.visualViewport?.removeEventListener('resize', apply);
    window.visualViewport?.removeEventListener('scroll', apply);
    colorSchemeMedia?.removeEventListener?.('change', apply);
    viewportProbe?.remove();
  };
}

export function parseMaxUrl(url: string, absolute = false): URL | null {
  try {
    return new URL(url, absolute ? undefined : window.location.href);
  } catch {
    return null;
  }
}

function isMaxDeepLink(url: URL): boolean {
  return url.protocol === 'https:' && (url.hostname === 'max.ru' || url.hostname === 'www.max.ru');
}

function scheduleMiniAppClose(): void {
  window.setTimeout(() => {
    resolveBridge()?.close?.();
  }, 40);
}

export function readyMaxMiniApp(): boolean {
  const bridge = resolveNativeSideEffectBridge();
  if (typeof bridge?.ready !== 'function') {
    return false;
  }

  bridge.ready();
  return true;
}

export function closeMaxMiniApp(fallback?: () => void): void {
  const bridge = resolveBridge();
  if (typeof bridge?.close === 'function') {
    bridge.close();
    return;
  }

  fallback?.();
}

type LinkOpenMethod = 'bridge-external' | 'bridge-max' | 'location' | 'noop';

export function openLink(url: string, maxOnly = false): LinkOpenMethod {
  const normalizedUrl = url.trim();
  if (!normalizedUrl) {
    return 'noop';
  }

  const parsed = parseMaxUrl(normalizedUrl, maxOnly);
  if (!parsed || parsed.username || parsed.password) {
    return 'noop';
  }
  // FLAG: Validate the exact address passed to the browser or native bridge.
  const href = parsed.href;
  if (!href.startsWith('https://') && !href.startsWith('http://')) {
    return 'noop';
  }

  const isDeepLink = isMaxDeepLink(parsed);
  if (maxOnly && (!isDeepLink || parsed.port || parsed.pathname === '/')) {
    return 'noop';
  }

  const bridge = resolveBridge();
  if (isDeepLink && typeof bridge?.openMaxLink === 'function') {
    bridge.openMaxLink(href);
    return 'bridge-max';
  }
  if (!isDeepLink && typeof bridge?.openLink === 'function') {
    bridge.openLink(href);
    return 'bridge-external';
  }

  window.location.assign(href);
  return 'location';
}

export function openMaxBotLink(url: string): LinkOpenMethod {
  return openLink(url);
}

export function openPrivateBotHandoff(url: string): boolean {
  // FLAG: MAX does not acknowledge openMaxLink. Keep the current screen available for retry.
  return openMaxProfileLink(url, false);
}

export function openMaxBotLinkAndClose(url: string): boolean {
  const method = openMaxBotLink(url);
  if (method === 'noop') {
    return false;
  }
  if (method !== 'location') {
    scheduleMiniAppClose();
  }
  return true;
}

export function openMaxProfileLink(url: string, closeOnOpen = true): boolean {
  try {
    const method = openLink(url, true);
    if (closeOnOpen && method === 'bridge-max') {
      scheduleMiniAppClose();
    }
    return method !== 'noop';
  } catch {
    return false;
  }
}

export function canShareMaxContent(): boolean {
  const bridge = resolveNativeSideEffectBridge();
  return typeof bridge?.shareMaxContent === 'function';
}

export async function shareMaxContent(payload: MaxSharePayload): Promise<void> {
  const bridge = resolveNativeSideEffectBridge();
  if (typeof bridge?.shareMaxContent !== 'function') {
    throw new Error('Native share недоступен в этой версии MAX.');
  }

  await Promise.resolve(bridge.shareMaxContent(payload));
}

export function canShareNativeContent(): boolean {
  const bridge = resolveNativeSideEffectBridge();
  return (
    typeof bridge?.shareContent === 'function' || typeof bridge?.shareMaxContent === 'function'
  );
}

export async function shareNativeContent(payload: {
  text?: string;
  link?: string;
  preferMax?: boolean;
}): Promise<void> {
  const { preferMax = false, ...sharePayload } = payload;
  const bridge = resolveNativeSideEffectBridge();

  if (preferMax && typeof bridge?.shareMaxContent === 'function') {
    await Promise.resolve(bridge.shareMaxContent(sharePayload));
    return;
  }

  if (typeof bridge?.shareContent === 'function') {
    await Promise.resolve(bridge.shareContent(sharePayload));
    return;
  }

  if (typeof bridge?.shareMaxContent === 'function') {
    await Promise.resolve(bridge.shareMaxContent(sharePayload));
    return;
  }

  throw new Error('Native share недоступен в этой версии MAX.');
}

export function setMaxClosingConfirmation(enabled: boolean): void {
  const bridge = resolveNativeSideEffectBridge();
  if (!bridge) {
    return;
  }

  if (enabled) {
    bridge.enableClosingConfirmation?.();
    return;
  }

  bridge.disableClosingConfirmation?.();
}

export function setMaxBackButtonVisible(visible: boolean): void {
  const backButton = resolveNativeSideEffectBridge()?.BackButton;
  if (!backButton) {
    return;
  }

  if (visible) {
    backButton.show?.();
    return;
  }

  backButton.hide?.();
}

let lastExplicitHapticAt = 0;

function noteExplicitHaptic(): void {
  lastExplicitHapticAt = Date.now();
}

export function bindMaxBackButton(handler: MaxBackButtonHandler): () => void {
  const backButton = resolveNativeSideEffectBridge()?.BackButton;
  if (!backButton?.onClick) {
    return () => undefined;
  }

  backButton.onClick(handler);
  return () => {
    backButton.offClick?.(handler);
  };
}

export function maxImpact(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft' = 'light'): void {
  noteExplicitHaptic();
  resolveNativeSideEffectBridge()?.HapticFeedback?.impactOccurred?.(style);
}

export function maxNotify(type: 'error' | 'success' | 'warning'): void {
  noteExplicitHaptic();
  resolveNativeSideEffectBridge()?.HapticFeedback?.notificationOccurred?.(type);
}

export function maxSelectionChanged(): void {
  noteExplicitHaptic();
  resolveNativeSideEffectBridge()?.HapticFeedback?.selectionChanged?.();
}

function resolveInteractiveTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) {
    return null;
  }

  return target.closest<HTMLElement>(
    'button, a, input[type="checkbox"], input[type="radio"], [role="button"], [role="tab"]',
  );
}

function isDisabledInteractiveElement(element: HTMLElement): boolean {
  if (element.getAttribute('aria-disabled') === 'true') {
    return true;
  }

  return element instanceof HTMLButtonElement ||
    element instanceof HTMLInputElement ||
    element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement
    ? element.disabled
    : false;
}

function shouldSkipDelegatedHaptic(element: HTMLElement): boolean {
  return (
    element.dataset.nativeHaptic === 'none' ||
    Boolean(element.closest('[data-native-haptic="none"]')) ||
    Date.now() - lastExplicitHapticAt < NATIVE_HAPTIC_DEDUPLICATE_MS
  );
}

function resolveDelegatedHaptic(element: HTMLElement): 'selection' | 'light' | 'medium' | 'heavy' {
  if (
    element instanceof HTMLInputElement &&
    (element.type === 'checkbox' || element.type === 'radio')
  ) {
    return 'selection';
  }

  if (
    element.getAttribute('role') === 'tab' ||
    element.getAttribute('aria-pressed') !== null ||
    element.classList.contains('settings-native-switch')
  ) {
    return 'selection';
  }

  const className = element.className.toString();
  if (/danger|delete|destructive/iu.test(className)) {
    return 'heavy';
  }
  if (/accent|confirm|primary|save|publish/iu.test(className)) {
    return 'medium';
  }

  return 'light';
}

export function installMaxNativeInteractionFeedback(): () => void {
  if (typeof document === 'undefined') {
    return () => undefined;
  }

  const handleClick = (event: MouseEvent) => {
    const element = resolveInteractiveTarget(event.target);
    if (!element || isDisabledInteractiveElement(element) || shouldSkipDelegatedHaptic(element)) {
      return;
    }

    const haptic = resolveDelegatedHaptic(element);
    if (haptic === 'selection') {
      maxSelectionChanged();
      return;
    }

    maxImpact(haptic);
  };

  document.addEventListener('click', handleClick);

  return () => {
    document.removeEventListener('click', handleClick);
  };
}
