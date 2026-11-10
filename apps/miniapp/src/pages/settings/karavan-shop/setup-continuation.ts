import type {
  KaravanMarketplaceOperation,
  KaravanMarketplaceSetup,
} from '@maxim/contracts/karavan-marketplace';

/** Continue only progress confirmed by this explicit launch, never a restored/unknown effect. */
export async function continueShopSetup(
  request: KaravanMarketplaceSetup,
  dispatch: (request: KaravanMarketplaceSetup) => Promise<KaravanMarketplaceOperation>,
  isCurrent: () => boolean,
): Promise<KaravanMarketplaceOperation> {
  let progress = request.existingMarketplaceId ? 1 : 0;
  for (let step = 0; ; step++) {
    const result = await dispatch(request);
    const next =
      Number(Boolean(result.checkpoints.marketplaceId)) +
      result.checkpoints.bindings.filter((item) => item.state === 'connected').length;
    // FLAG: No retries after uncertainty, no-progress responses, actor changes or a foreign receipt.
    if (
      !isCurrent() ||
      result.operationId !== request.operationId ||
      result.state !== 'pending' ||
      result.checkpoints.bindings.some(
        (item) => item.state !== 'pending' && item.state !== 'connected',
      ) ||
      !result.checkpoints.bindings.some((item) => item.state === 'pending') ||
      next <= progress ||
      step >= request.chatIds.length
    )
      return result;
    progress = next;
  }
}
