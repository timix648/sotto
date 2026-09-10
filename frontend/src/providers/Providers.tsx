'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createAppKit, useAppKitTheme } from '@reown/appkit/react';
import { WagmiProvider } from 'wagmi';
import { appKitNetworks, appKitProjectId, wagmiAdapter } from '@/lib/appkit';
import { APP_URL } from '@/lib/config';
import { RoleProvider } from '@/hooks/useRole';
import { ThemeProvider, useTheme } from '@/hooks/useTheme';

createAppKit({
  adapters: [wagmiAdapter],
  networks: appKitNetworks,
  defaultNetwork: appKitNetworks[0],
  projectId: appKitProjectId,
  metadata: {
    name: 'Sotto',
    description: 'RFQ block trading for tokenised securities on Hedera',
    url: APP_URL,
    icons: [],
  },
  defaultAccountTypes: { eip155: 'eoa' },
  coinbasePreference: 'eoaOnly',
  features: {
    email: false,
    socials: false,
    swaps: false,
    onramp: false,
    send: false,
    receive: false,
    history: false,
    analytics: false,
    allWallets: true,
    connectMethodsOrder: ['wallet'],
    connectorTypeOrder: ['recent', 'injected', 'featured', 'walletConnect', 'recommended'],
  },
  themeVariables: {
    '--apkt-accent': '#702636',
    '--apkt-color-mix': '#702636',
    '--apkt-color-mix-strength': 8,
    '--apkt-font-family': 'var(--font-sans), sans-serif',
    '--apkt-border-radius-master': '6px',
    '--apkt-z-index': 90,
  },
});

function AppKitThemeSync() {
  const { theme, ready } = useTheme();
  const { setThemeMode } = useAppKitTheme();

  useEffect(() => {
    if (ready) setThemeMode(theme);
  }, [ready, setThemeMode, theme]);

  return null;
}

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
      <WagmiProvider config={wagmiAdapter.wagmiConfig}>
        <QueryClientProvider client={queryClient}>
          <AppKitThemeSync />
          <RoleProvider>{children}</RoleProvider>
        </QueryClientProvider>
      </WagmiProvider>
    </ThemeProvider>
  );
}
