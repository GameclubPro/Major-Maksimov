import type { PublicMaxChannelProof } from '../../max/max-public-handle';
import type { MaxClientService } from '../../max/max-client.service';

export const PUBLIC_HANDLE_CHANNEL = {
  url: 'https://max.ru/azov_overhear',
  channelId: 69253552423018,
} satisfies PublicMaxChannelProof;

export function createHandleLookupMock() {
  return jest
    .fn<
      ReturnType<MaxClientService['resolvePublicChannelHandle']>,
      Parameters<MaxClientService['resolvePublicChannelHandle']>
    >()
    .mockResolvedValue(null);
}
