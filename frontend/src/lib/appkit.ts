import { WagmiAdapter } from '@reown/appkit-adapter-wagmi';
import {
  HederaAdapter,
  HederaChainDefinition,
  hederaNamespace,
} from '@hashgraph/hedera-wallet-connect';
import { hederaTestnet } from './chain';
import { WALLETCONNECT_PROJECT_ID } from './config';
import { HEDERA_NAMESPACE } from './namespace';

if (!WALLETCONNECT_PROJECT_ID) {
  throw new Error(
    'NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is required for the Reown AppKit wallet selector.'
  );
}

export const appKitProjectId = WALLETCONNECT_PROJECT_ID;
export const appKitEvmNetworks: [typeof hederaTestnet] = [hederaTestnet];
export const hederaNativeTestnet = HederaChainDefinition.Native.Testnet;
export const nativeWalletNamespace = hederaNamespace;

// `@/lib/namespace` re-states this string so pages can name the namespace
// without importing the SDK behind HederaAdapter. Assert they agree here, where
// the package is already loaded, so a drift is loud rather than silent.
if (HEDERA_NAMESPACE !== hederaNamespace) {
  throw new Error(
    `namespace drift: @/lib/namespace says "${HEDERA_NAMESPACE}", ` +
    `hedera-wallet-connect says "${hederaNamespace}"`
  );
}
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
