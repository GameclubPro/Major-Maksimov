import type { ConfigService } from '@nestjs/config';
import {
  karavanMarketplaceCreateSchema,
  karavanMarketplaceBindingResultSchema,
  karavanMarketplaceAuthorityScopeSchema,
  type KaravanMarketplaceOperation,
} from '@maxim/contracts/karavan-marketplace';
import { karavanHash } from './karavan-marketplace-authority.service';
import { readKaravanCommandReceipt } from './karavan-command-receipts';

// FLAG: Observation never dispatches a setup step or modifies its stored request.
// Missing receipts retain uncertainty, including in a partially connected legacy setup.
export async function observeKaravanSetup(
  config: ConfigService,
  actorMaxUserId: string,
  original: KaravanMarketplaceOperation,
): Promise<KaravanMarketplaceOperation> {
  if (['complete', 'cancelled', 'rejected'].includes(original.state)) return original;
  const operation = structuredClone(original);
  const { request, checkpoints } = operation;
  if (!checkpoints.marketplaceId && request.create && operation.state === 'unknown') {
    const payload = karavanMarketplaceCreateSchema.parse({
      ...request.create,
      commandId: `${operation.operationId}:create`,
    });
    const receipt = await readKaravanCommandReceipt(
      config,
      {
        actorMaxUserId,
        chatId: request.chatIds[0]!,
        commandId: payload.commandId,
        action: 'create_marketplace',
        marketplaceId: null,
      },
      karavanHash(payload),
    );
    if (receipt) {
      if (!('marketplace' in receipt)) throw new Error('Invalid create receipt');
      checkpoints.marketplaceId = receipt.marketplace.id;
      operation.state = 'pending';
    }
  }
  if (!checkpoints.marketplaceId) return operation;
  for (let index = 0; index < checkpoints.bindings.length; index++) {
    const binding = checkpoints.bindings[index]!;
    if (binding.state !== 'unknown') continue;
    const expected = request.bindingExpectations?.find((item) => item.chatId === binding.chatId);
    const action = expected?.action ?? 'bind_chat';
    const payload = {
      commandId: `${operation.operationId}:bind:${index}`,
      chatId: binding.chatId,
      expectedBindingGeneration: expected?.generation ?? null,
      ...(request.expectedPolicyRevision === undefined
        ? {}
        : { expectedPolicyRevision: request.expectedPolicyRevision }),
      ...(action === 'bind_chat' ? {} : { action }),
    };
    const scope = karavanMarketplaceAuthorityScopeSchema.parse({
      actorMaxUserId,
      chatId: binding.chatId,
      commandId: payload.commandId,
      action,
      marketplaceId: checkpoints.marketplaceId,
      expectedBindingGeneration: payload.expectedBindingGeneration,
      payloadHash: karavanHash(payload),
    });
    const receipt = await readKaravanCommandReceipt(
      config,
      {
        actorMaxUserId,
        chatId: binding.chatId,
        commandId: payload.commandId,
        action,
        marketplaceId: checkpoints.marketplaceId,
      },
      karavanHash(scope),
    );
    if (receipt) {
      const result = karavanMarketplaceBindingResultSchema.parse(receipt);
      binding.state = 'connected';
      binding.bindingId = result.bindingId;
      binding.generation = result.generation;
    }
  }
  if (
    checkpoints.bindings.length &&
    checkpoints.bindings.every((item) => item.state === 'connected')
  )
    operation.state = 'complete';
  return operation;
}
