import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import { hederaTestnet } from './chain';
import { WALLETCONNECT_PROJECT_ID } from './config';

if (!WALLETCONNECT_PROJECT_ID) {
  throw new Error(
    'NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is required for the Reown AppKit wallet selector.'
  );
}

export const appKitProjectId = WALLETCONNECT_PROJECT_ID;
export const appKitNetworks: [typeof hederaTestnet] = [hederaTestnet];

/**
 * Reown owns connector discovery here. Its Wagmi adapter provides EIP-6963
 * desktop wallets, the full wallet directory, and WalletConnect QR fallback.
 */
export const wagmiAdapter = new WagmiAdapter({
  networks: appKitNetworks,
  projectId: appKitProjectId,
  ssr: true,
});
