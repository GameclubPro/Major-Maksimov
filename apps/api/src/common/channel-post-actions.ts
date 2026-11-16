import type { MaxMessageButton } from '../max/max-client.service';
import { isCompactChannelButtonText } from '@maxim/contracts/channel-post-signature';
import {
  channelDialogButtonPresentationKey,
  readInternalChannelDialogButtonIdentity,
} from './channel-dialog-button-identity.util';

export type ChannelPostActionPlan = {
  commentsButton?: MaxMessageButton | null;
  suggestButton?: MaxMessageButton | null;
  ctaButton?: MaxMessageButton | null;
  customButtonRows?: readonly (readonly MaxMessageButton[])[];
};

export function buildChannelPostActionRows(plan: ChannelPostActionPlan): MaxMessageButton[][] {
  const rows: MaxMessageButton[][] = [];
  const seenLinks = new Set<string>();

  appendFullWidthButton(rows, seenLinks, plan.commentsButton);
  appendFullWidthButton(rows, seenLinks, plan.suggestButton);
  appendFullWidthButton(rows, seenLinks, plan.ctaButton);

  for (const row of plan.customButtonRows ?? []) {
    let compactRow: MaxMessageButton[] | null = null;
    for (const button of row) {
      const previousLength = rows.length;
      appendFullWidthButton(rows, seenLinks, button);
      if (rows.length === previousLength) continue;
      const appended = rows[rows.length - 1];
      if (
        button.type === 'link' &&
        !readInternalChannelDialogButtonIdentity(button) &&
        isCompactChannelButtonText(button.text)
      ) {
        if (compactRow?.length === 1) {
          compactRow.push(...appended);
          rows.pop();
          compactRow = null;
        } else {
          compactRow = appended;
        }
      } else {
        compactRow = null;
      }
    }
  }

  return rows;
}

function appendFullWidthButton(
  rows: MaxMessageButton[][],
  seenLinks: Set<string>,
  button: MaxMessageButton | null | undefined,
): void {
  if (!button) {
    return;
  }

  const linkIdentity = readLinkIdentity(button);
  if (linkIdentity && seenLinks.has(linkIdentity)) {
    return;
  }
  if (linkIdentity) {
    seenLinks.add(linkIdentity);
  }
  rows.push([{ ...button }]);
}

function readLinkIdentity(button: MaxMessageButton): string | null {
  const dialogIdentity = readInternalChannelDialogButtonIdentity(button);
  if (dialogIdentity) return `dialog:${channelDialogButtonPresentationKey(dialogIdentity)}`;
  const rawUrl =
    button.type === 'link' ? button.url : button.type === 'open_app' ? button.webApp : null;
  if (!rawUrl?.trim()) {
    return null;
  }

  try {
    const url = new URL(rawUrl.trim());
    return url.toString();
  } catch {
    return rawUrl.trim();
  }
}
