import { karavanHash } from './karavan-marketplace-authority.service';
import type { ConfigService } from '@nestjs/config';
import { ServiceUnavailableException } from '@nestjs/common';
import {
  karavanCommandStatusRequestSchema,
  karavanCommandStatusResponseSchema,
  type KaravanCommandStatusRequest,
} from '@maxim/contracts/karavan-marketplace-connection';

// FLAG: Call only for an actor/chat-owned durable operation or a validated legacy
// import. The internal service token is not public mutation or marketplace authority.
export async function readKaravanCommandReceipt(
  config: ConfigService,
  raw: KaravanCommandStatusRequest,
  expectedRequestHash: string,
) {
  const input = karavanCommandStatusRequestSchema.parse(raw);
  try {
    const response = await fetch(
      `${config.getOrThrow<string>('KARAVAN_MARKETPLACE_API_BASE_URL').replace(/\/$/u, '')}/api/v1/integrations/maxim/marketplaces/command-status`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.getOrThrow<string>('KARAVAN_MARKETPLACE_COMMAND_TOKEN')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(8_000),
        redirect: 'error',
      },
    );
    if (!response.ok) throw new Error('Receipt unavailable');
    const result = karavanCommandStatusResponseSchema.parse(await response.json());
    if (result.commandId !== input.commandId) throw new Error('Receipt identity mismatch');
    if (result.status === 'not_found') return null;
    if (result.requestHash !== expectedRequestHash) throw new Error('Receipt hash mismatch');
    if (
      input.action === 'manage_shop' &&
      result.managementRequestHash !== karavanHash(input.managementRequest)
    )
      throw new Error('Management receipt request mismatch');
    if (
      input.action !== 'manage_shop' &&
      input.marketplaceId &&
      (!('marketplace' in result.response) ||
        result.response.marketplace.id !== input.marketplaceId)
    )
      throw new Error('Receipt marketplace mismatch');
    return result.response;
  } catch {
    throw new ServiceUnavailableException({
      code: 'KARAVAN_RECEIPT_UNAVAILABLE',
      message: 'Не удалось проверить результат. Повторите позже.',
    });
  }
}
