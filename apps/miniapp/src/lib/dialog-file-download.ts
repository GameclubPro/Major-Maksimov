import { openMaxBotLink, parseMaxUrl, resolveNativeSideEffectBridge } from './max-bridge';

export async function downloadDialogFile(url: string, fileName: string): Promise<void> {
  const normalizedUrl = url.trim();
  const bridge = resolveNativeSideEffectBridge();
  if (normalizedUrl && bridge?.downloadFile && parseMaxUrl(normalizedUrl)?.protocol === 'https:') {
    try {
      await bridge.downloadFile(normalizedUrl, fileName.trim() || 'file');
      return;
    } catch {
      // Fall through to regular link opening when the native client refuses the download.
    }
  }

  openMaxBotLink(normalizedUrl);
}
