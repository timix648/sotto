'use client';

import { useAppKit, useAppKitAccount, useAppKitState } from '@reown/appkit/react';
import { useAccount, useChainId, useSwitchChain } from 'wagmi';
import { useSettlementPath } from '@/hooks/useSettlementPath';
import { nativeWalletNamespace } from '@/lib/appkit';
import { Button } from '@/components/ui/Button';
import { truncate } from '@/lib/format';
import { CHAIN_ID } from '@/lib/config';

export function WalletButton() {
  const { path } = useSettlementPath();
  const evm = useAccount();
  const native = useAppKitAccount({ namespace: nativeWalletNamespace });
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const { open } = useAppKit();
  const { loading } = useAppKitState();

  const namespace = path === 'A' ? 'eip155' : nativeWalletNamespace;
  const address = path === 'A' ? evm.address : native.address;
  const connected = path === 'A' ? evm.isConnected : native.isConnected;

  if (connected && address) {
    return (
      <div className="flex items-center gap-2">
        {path === 'A' && chainId !== CHAIN_ID && (
          <Button variant="danger" onClick={() => switchChain({ chainId: CHAIN_ID })}>
            Switch to Hedera testnet
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={() => void open({ view: 'Account', namespace })}
          title={`${path === 'A' ? 'EVM' : 'Native Hedera'} wallet ${address}`}
        >
          <span className="font-mono text-xs">{truncate(address)}</span>
          <span className="text-dim text-2xs">{path === 'A' ? 'EVM' : 'Hedera'}</span>
        </Button>
      </div>
    );
  }

  const title =
    path === 'A'
      ? 'Connect an EVM wallet for allowance-based settlement.'
      : 'Connect a Hedera-native wallet for HIP-551 batch settlement.';

  return (
    <Button
      variant="primary"
      onClick={() => void open({ view: 'Connect', namespace })}
      busy={loading}
      title={title}
    >
      {path === 'A' ? 'Connect EVM wallet' : 'Connect Hedera wallet'}
    </Button>
  );
}
