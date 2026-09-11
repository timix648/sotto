import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import {
  HederaAdapter,
  HederaChainDefinition,
  hederaNamespace,
} from '@hashgraph/hedera-wallet-connect';
import { hederaTestnet } from './chain';
import { WALLETCONNECT_PROJECT_ID } from './config';

if (!WALLETCONNECT_PROJECT_ID) {
  throw new Error(
    'NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is required for the Reown AppKit wallet selector.'
  );
}

export const appKitProjectId = WALLETCONNECT_PROJECT_ID;
export const appKitEvmNetworks: [typeof hederaTestnet] = [hederaTestnet];
export const hederaNativeTestnet = HederaChainDefinition.Native.Testnet;
export const nativeWalletNamespace = hederaNamespace;
export const appKitNetworks: [typeof hederaTestnet, typeof hederaNativeTestnet] = [
  hederaTestnet,
  hederaNativeTestnet,
];

/**
 * Reown owns connector discovery here. Its Wagmi adapter provides EIP-6963
 * desktop wallets, the full wallet directory, and WalletConnect QR fallback.
 */
export const wagmiAdapter = new WagmiAdapter({
  networks: appKitEvmNetworks,
  projectId: appKitProjectId,
  ssr: true,
});

/** Native HIP-820 wallet sessions used by the Path B demo. */
export const hederaNativeAdapter = new HederaAdapter({
  networks: [hederaNativeTestnet],
  namespace: hederaNamespace,
  projectId: appKitProjectId,
  namespaceMode: 'optional',
});
