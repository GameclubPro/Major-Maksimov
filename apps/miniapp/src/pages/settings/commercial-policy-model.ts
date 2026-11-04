import type { CommercialAdCategory } from '@maxim/contracts/settings';
import type { ApiTransport } from '../../lib/api/transport';
import type { CommercialExceptionPrefill } from '../../lib/commercial-ads-policy';
import type { AppIconName } from '../../components/ui/app-icon-names';

export type CommercialSettingsScope = {
  api: ApiTransport;
  chatId: string;
  prefill?: CommercialExceptionPrefill | null;
  onOpenJournal: () => void;
};

export const categoryIcons: Record<CommercialAdCategory, AppIconName> = {
  PERSONAL_SALE: 'User',
  SERVICES: 'Wrench',
  BUSINESS: 'Shop',
  COMMUNITIES: 'Community',
};
