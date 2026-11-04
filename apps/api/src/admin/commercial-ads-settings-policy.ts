import { commercialAdsPolicySchema } from '@maxim/contracts/settings';
import { BadRequestException } from '@nestjs/common';

export function assertCommercialPersonalSalePolicyAvailable(params: {
  currentPolicy: unknown;
  nextPolicy: unknown;
  commercialAiDeleteOnly?: boolean;
}): void {
  if (params.commercialAiDeleteOnly === true) return;
  const next = commercialAdsPolicySchema.safeParse(params.nextPolicy);
  if (!next.success || next.data.categories.PERSONAL_SALE !== 'BLOCK') return;
  const current = commercialAdsPolicySchema.safeParse(params.currentPolicy);
  // FLAG: Deterministic moderation cannot newly promise personal-sale deletion. Preserve an
  // existing explicit BLOCK during an AI outage; the runtime independently denies deletion.
  if (current.success && current.data.categories.PERSONAL_SALE === 'BLOCK') return;
  throw new BadRequestException('Запрет личных продаж доступен при ИИ-проверке');
}
