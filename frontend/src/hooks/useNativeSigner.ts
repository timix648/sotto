'use client';

// The Hedera-native (HIP-820) session, for Path B.
//
// Separate from the EVM connection on purpose. A dealer settling Path B needs
// BOTH: an EVM signature for the EIP-712 Trade, and a native signature for the
// HTS cash leg. They are different namespaces, different sessions, and a wallet
// may provide one and not the other — so this hook reports exactly which of the
// two you have rather than collapsing them into "connected".
//
// KNOWN TRAP, upstream: HashPack's direct injected button can hand back an EVM
// session where you asked for a native one
// (hashgraph/hedera-wallet-connect#670). The symptom is `accountId` staying
// null here while the EVM side connects fine. Use the WalletConnect QR or
// deep-link route instead of the direct button.
import { useMemo } from 'react';
import { useAppKitAccount, useAppKitProvider } from '@reown/appkit/react';
import { nativeWalletNamespace } from '@/lib/appkit';
import type { NativeSigner } from '@/lib/batch';

export interface NativeSession {
  /** The signer, once a native session exists. */
  signer: NativeSigner | null;
  /** Plain `0.0.x`, with any `hedera:testnet:` prefix stripped. */
  accountId: string | null;
  connected: boolean;
}

export function useNativeSigner(): NativeSession {
  const account = useAppKitAccount({ namespace: nativeWalletNamespace });
  const { walletProvider } = useAppKitProvider<NativeSigner | undefined>(nativeWalletNamespace);

  return useMemo(() => {
    // HIP-30 ids arrive as `hedera:testnet:0.0.x`; the SDK wants the tail.
    const raw = account?.address ?? null;
    const accountId = raw ? (raw.split(':').pop() ?? null) : null;

    // A provider without hedera_signTransaction is not a native session,
    // whatever the connection state claims.
    const usable =
      walletProvider && typeof walletProvider.hedera_signTransaction === 'function'
        ? walletProvider
        : null;

    return {
      signer: usable,
      accountId,
      connected: Boolean(usable && accountId),
    };
  }, [account?.address, walletProvider]);
}
