'use client';

import { useAppKit, useAppKitState } from '@reown/appkit/react';
import { useAccount, useChainId, useSwitchChain } from 'wagmi';
import { Button } from '@/components/ui/Button';
import { truncate } from '@/lib/format';
import { CHAIN_ID } from '@/lib/config';

// Wallet selection and account management belong to AppKit. The Sotto role is
// deliberately separate, so changing or disconnecting a wallet never changes
// the desk the user is viewing.
export function WalletButton() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const { open } = useAppKit();
  const { loading } = useAppKitState();

  if (isConnected && address) {
    const wrongChain = chainId !== CHAIN_ID;
    return (
      <div className="flex items-center gap-2">
        {wrongChain && (
          <Button variant="danger" onClick={() => switchChain({ chainId: CHAIN_ID })}>
            Switch to Hedera testnet
          </Button>
        )}
        <Button variant="ghost" onClick={() => void open({ view: 'Account' })} title={address}>
          <span className="font-mono text-xs">{truncate(address)}</span>
          <span className="text-dim text-2xs">wallet</span>
        </Button>
      </div>
    );
  }

  return (
    <Button variant="primary" onClick={() => void open({ view: 'Connect' })} busy={loading}>
      Connect wallet
    </Button>
  );
}
