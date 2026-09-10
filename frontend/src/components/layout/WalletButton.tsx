'use client';

import { useState } from 'react';
import { useAccount, useConnect, useDisconnect, useChainId, useSwitchChain } from 'wagmi';
import { Button } from '@/components/ui/Button';
import { truncate } from '@/lib/format';
import { CHAIN_ID, WALLETCONNECT_PROJECT_ID } from '@/lib/config';

// MECHANICS §4.10: "Sign-out that bounced straight back in, because it cleared
// the app role but left the wallet connected." Disconnect here does exactly one
// thing — it disconnects the wallet. The role is untouched and the venue stays
// usable as the demo party, so there is no sign-in screen to bounce off.
export function WalletButton() {
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const [open, setOpen] = useState(false);

  if (isConnected && address) {
    const wrongChain = chainId !== CHAIN_ID;
    return (
      <div className="flex items-center gap-2">
        {wrongChain && (
          <Button variant="danger" onClick={() => switchChain({ chainId: CHAIN_ID })}>
            Switch to Hedera testnet
          </Button>
        )}
        <Button variant="ghost" onClick={() => disconnect()} title={address}>
          <span className="font-mono text-xs">{truncate(address)}</span>
          <span className="text-dim text-2xs">disconnect</span>
        </Button>
      </div>
    );
  }

  return (
    <div className="relative">
      <Button variant="primary" onClick={() => setOpen((v) => !v)} busy={isPending}>
        Connect wallet
      </Button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 w-72 z-50 panel p-2 shadow-2xl animate-slideIn">
            <p className="px-2 py-1.5 text-2xs text-dim leading-relaxed">
              Optional. Without a wallet the venue acts as the demo party for the selected role —
              the same keys the backend scripts use today.
            </p>
            {connectors.map((c) => (
              <button
                key={c.uid}
                onClick={() => { connect({ connector: c }); setOpen(false); }}
                className="w-full text-left px-2 py-2 rounded text-sm text-txt hover:bg-raised focusable"
              >
                {c.name}
              </button>
            ))}
            {!WALLETCONNECT_PROJECT_ID && (
              <p className="px-2 pt-2 mt-1 border-t border-line text-2xs text-dim leading-relaxed">
                HashPack and Blade need a WalletConnect projectId. Set{' '}
                <span className="font-mono">NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID</span> in{' '}
                <span className="font-mono">.env.local</span> to enable them.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
