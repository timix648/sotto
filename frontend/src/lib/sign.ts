'use client';

// EIP-712 signing of the Trade.
//
// The domain and the type list come from the FROZEN wire contract
// (src/shared/eip712.ts). START-HERE §3: "Import them; do not retype them. The
// contract verifies signatures against precisely those fields." A single
// mistyped field name produces a signature that recovers to a different address
// and a settlement that reverts with SIGNATURE_INVALID for no visible reason.
//
// The Trade crosses the wire as decimal strings; viem needs bigint for uint256
// and 0x-hex for bytes32/address. That conversion happens here, once.
import { useCallback } from 'react';
import { useSignTypedData } from 'wagmi';
import { getAddress } from 'viem';
import { eip712Domain, TRADE_TYPES } from '@sotto/shared';
import type { Trade } from '@sotto/shared';

export function tradeToMessage(trade: Trade) {
  return {
    rfqId: trade.rfqId as `0x${string}`,
    // START-HERE §4: viem rejects non-EIP-55-checksummed addresses at encode time.
    assetToken: getAddress(trade.assetToken),
    partition: trade.partition as `0x${string}`,
    holdId: BigInt(trade.holdId),
    cashToken: getAddress(trade.cashToken),
    seller: getAddress(trade.seller),
    buyer: getAddress(trade.buyer),
    quantity: BigInt(trade.quantity),
    notional: BigInt(trade.notional),
    deadline: BigInt(trade.deadline),
    nonce: BigInt(trade.nonce),
  } as const;
}

export function useSignTrade(settlementAddress: string | null | undefined) {
  const { signTypedDataAsync, isPending } = useSignTypedData();

  const sign = useCallback(
    async (trade: Trade): Promise<`0x${string}`> => {
      if (!settlementAddress) {
        throw new Error(
          'No settlement address. GET /api/health must report one before a Trade can be signed.'
        );
      }
      return signTypedDataAsync({
        domain: eip712Domain(getAddress(settlementAddress)),
        types: TRADE_TYPES,
        primaryType: 'Trade',
        message: tradeToMessage(trade),
      });
    },
    [signTypedDataAsync, settlementAddress]
  );

  return { sign, isPending };
}
