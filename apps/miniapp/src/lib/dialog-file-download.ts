import { MAX_CHANNEL_DIALOG_ATTACHMENTS_TOTAL_BASE64 } from '@maxim/contracts/channel-dialog';
import { openMaxBotLink, parseMaxUrl, resolveNativeSideEffectBridge } from './max-bridge';

const inlineAttachmentPattern =
  /^data:(?:image\/(?:bmp|gif|jpeg|png|webp)|text\/(?:plain|csv)|application\/(?:pdf|json|zip|octet-stream|msword|vnd\.[a-z0-9.+-]+));base64,([a-z0-9+/]+={0,2})$/iu;
const maxAttachmentDataUrlLength = MAX_CHANNEL_DIALOG_ATTACHMENTS_TOTAL_BASE64 + 256;

export async function downloadDialogFile(url: string, fileName: string): Promise<void> {
  const normalizedUrl = url.trim();
  if (!normalizedUrl || normalizedUrl.length > maxAttachmentDataUrlLength) {
    return;
  }

  const target = parseMaxUrl(normalizedUrl);
  if (!target || target.username || target.password) {
    return;
  }
  const name = fileName.trim() || 'file';
  const href = target.href;
  const dataMatch = href.length <= maxAttachmentDataUrlLength && inlineAttachmentPattern.exec(href);
  if (
    (dataMatch && dataMatch[1]!.length <= MAX_CHANNEL_DIALOG_ATTACHMENTS_TOTAL_BASE64) ||
    (target.protocol === 'blob:' && target.origin === window.location.origin)
  ) {
    // FLAG: Inline attachments are downloads. Keep them out of the document navigation path.
    const anchor = document.createElement('a');
    anchor.download = name;
    anchor.href = href;
    anchor.click();
    return;
  }

  const bridge = resolveNativeSideEffectBridge();
  if (bridge?.downloadFile && target.protocol === 'https:') {
    try {
      await bridge.downloadFile(href, name);
      return;
    } catch {
      // Fall through to regular link opening when the native client refuses the download.
    }
  }

  openMaxBotLink(href);
}
