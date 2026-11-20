import {
  channelCustomPostButtonInputSchema,
  channelCustomPostButtonsSchema,
  channelPostActionLinkIdentity,
  isCompactChannelButtonText,
  layoutChannelCustomButtonRows,
  layoutChannelPostActionRows,
} from '@maxim/contracts/channel-post-signature';
import {
  chunkBroadcastLinkButtons,
  trimBroadcastLinkButtons,
} from '../../lib/broadcast-link-buttons';
import {
  buildPublicationSystemButtons,
  type PublicationDraft,
  type PublicationTarget,
} from './publication-model';

type ReviewButton = { text: string; url?: string; kind?: 'comments' | 'suggest' | 'cta' };

export function buildPublicationReviewButtonRows(
  target: PublicationTarget | undefined,
  draft: Pick<PublicationDraft, 'buttons' | 'buttonEnabled'>,
): ReviewButton[][] {
  const system = buildPublicationSystemButtons(target ? [target] : []).map((button) => ({
    ...button,
    text: button.kind === 'comments' ? button.text + ' · 0' : button.text,
    url: button.kind === 'cta' ? target?.publisherChannelPostSignature?.url : undefined,
  }));
  const postButtons = draft.buttonEnabled ? trimBroadcastLinkButtons(draft.buttons) : [];
  if (target?.entityType !== 'channel') {
    return [...chunkBroadcastLinkButtons(postButtons), ...system.map((button) => [button])];
  }

  const settings = target.publisherChannelPostSignature;
  const saved = channelCustomPostButtonsSchema.safeParse(settings?.customButtons);
  const permanent =
    settings?.customButtonsEnabled && saved.success
      ? saved.data.filter((button) => channelCustomPostButtonInputSchema.safeParse(button).success)
      : [];
  return layoutChannelPostActionRows<ReviewButton>(
    system,
    [...layoutChannelCustomButtonRows(permanent), ...chunkBroadcastLinkButtons(postButtons, 1)],
    (button) => channelPostActionLinkIdentity(button.url),
    (button) => Boolean(button.url) && isCompactChannelButtonText(button.text),
  );
}
