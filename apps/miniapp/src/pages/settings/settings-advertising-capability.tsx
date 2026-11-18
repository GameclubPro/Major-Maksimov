import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ApiTransport } from '../../lib/api/transport';

export default function SettingsAdvertisingCapability({
  api,
  userId,
  children,
}: {
  api: ApiTransport;
  userId: string;
  children: ReactNode;
}) {
  const capability = useQuery({
    queryKey: ['advertising-placement-capability', userId],
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const value = await api.request('/advertising-placement/capability');
      return {
        available:
          typeof value === 'object' &&
          value !== null &&
          'available' in value &&
          value.available === true,
      };
    },
  });
  return capability.data?.available ? children : null;
}
