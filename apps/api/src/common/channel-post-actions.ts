import type { MaxMessageButton } from '../max/max-client.service';
import {
  channelPostActionLinkIdentity,
  isCompactChannelButtonText,
  layoutChannelPostActionRows,
} from '@maxim/contracts/channel-post-signature';
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
  return layoutChannelPostActionRows(
    [plan.commentsButton, plan.suggestButton, plan.ctaButton],
    plan.customButtonRows ?? [],
    readLinkIdentity,
    (button) =>
      button.type === 'link' &&
      !readInternalChannelDialogButtonIdentity(button) &&
      isCompactChannelButtonText(button.text),
  ).map((row) => row.map((button) => ({ ...button })));
}

function readLinkIdentity(button: MaxMessageButton): string | null {
  const dialogIdentity = readInternalChannelDialogButtonIdentity(button);
  if (dialogIdentity) return `dialog:${channelDialogButtonPresentationKey(dialogIdentity)}`;
  return channelPostActionLinkIdentity(
    button.type === 'link' ? button.url : button.type === 'open_app' ? button.webApp : null,
  );
}
