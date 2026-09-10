'use client';

import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, createConfig, http } from 'wagmi';
import { injected, walletConnect } from 'wagmi/connectors';
import { hederaTestnet } from '@/lib/chain';
import { JSON_RPC_URL, WALLETCONNECT_PROJECT_ID } from '@/lib/config';
import { RoleProvider } from '@/hooks/useRole';
import { ThemeProvider } from '@/hooks/useTheme';

// MECHANICS §4.10: "A wallet extension prompting for a signature on page load,
// from loading a redundant bundle, which looked like the venue asking for a
// signature nobody requested." Nothing here touches a wallet until the user
// presses Connect: no autoConnect, no eager provider calls.
const connectors = [
  injected({ shimDisconnect: true }),
  // HashPack and Blade arrive over WalletConnect; without a projectId the
  // connector is simply not offered, rather than offered and broken.
  ...(WALLETCONNECT_PROJECT_ID
    ? [walletConnect({ projectId: WALLETCONNECT_PROJECT_ID, showQrModal: true })]
    : []),
];

const wagmiConfig = createConfig({
  chains: [hederaTestnet],
  connectors,
  transports: { [hederaTestnet.id]: http(JSON_RPC_URL) },
  ssr: true,
});

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: 1,
            refetchOnWindowFocus: false,
            staleTime: 2_000,
          },
        },
      })
  );

  return (
    <ThemeProvider>
      <WagmiProvider config={wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <RoleProvider>{children}</RoleProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </ThemeProvider>
  );
}
