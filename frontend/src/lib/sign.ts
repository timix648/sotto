'use client';

// EIP-712 signing of the Trade.
//
// The domain and the type list come from the FROZEN wire contract
// (src/shared/eip712.ts). START-HERE §3: "Import them; do not retype them. The
// contract verifies signatures against precisely those fields." A single
// mistyped field name produces a signature that recovers to a different address
// and a settlement that reverts with SIGNATURE_INVALID for no visible reason.
//
// We call the wallet's `eth_signTypedData_v4` directly rather than going through
// wagmi's `useSignTypedData`. That is not a stylistic choice:
//
//   Awarding a two-fill RFQ from the browser failed with the wallet returning
//   "Unable to encode value: Invalid number. Expected a valid number value, but
//   received \"2n\"". The 2 was holdId, the first uint256 in the struct. The
//   suffixed form is what a BigInt-with-'n' serialiser emits - @walletconnect's
//   safe-json does exactly `value.toString() + "n"` - so a bigint was reaching
//   the transport intact and being reformatted into something no wallet can
//   parse. Signing the identical struct straight against the injected provider,
//   with every uint256 as a decimal string, succeeded.
//
// So: no bigint ever leaves this module. The Trade already crosses the wire as
// decimal strings and EIP-712 JSON wants decimal strings, so the values are
// passed through untouched and the whole payload is stringified here, once,
// where we can see it. There is no layer left that could reformat a number.
import { useCallback, useState } from 'react';
import { useAccount } from 'wagmi';
import { getAddress } from 'viem';
import { eip712Domain, EIP712_DOMAIN_TYPE, TRADE_TYPES } from '@sotto/shared';
import type { Trade } from '@sotto/shared';

/** The EIP-712 `message` for a Trade: hex stays hex, uint256 stays a decimal string. */
export function tradeToMessage(trade: Trade) {
  return {
    rfqId: trade.rfqId,
    // START-HERE §4: addresses must be EIP-55 checksummed or wallets reject them.
    assetToken: getAddress(trade.assetToken),
    partition: trade.partition,
    holdId: String(trade.holdId),
    cashToken: getAddress(trade.cashToken),
    seller: getAddress(trade.seller),
    buyer: getAddress(trade.buyer),
    quantity: String(trade.quantity),
    notional: String(trade.notional),
    deadline: String(trade.deadline),
    nonce: String(trade.nonce),
  };
}

/** An EIP-1193 provider, which is all we need from whichever connector is live. */
interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export function useSignTrade(settlementAddress: string | null | undefined) {
  const { address, connector } = useAccount();
  const [isPending, setPending] = useState(false);

  const sign = useCallback(
    async (trade: Trade): Promise<`0x${string}`> => {
      if (!settlementAddress) {
        throw new Error(
          'No settlement address. GET /api/health must report one before a Trade can be signed.'
        );
      }
      if (!address || !connector) {
        throw new Error('Connect a wallet before signing the Trade.');
      }

      const provider = (await connector.getProvider()) as Eip1193 | undefined;
      if (!provider?.request) {
        throw new Error('The connected wallet did not expose an EIP-1193 provider.');
      }

      // Stringified here, deliberately: see the note at the top of the file.
      const typedData = JSON.stringify({
        domain: eip712Domain(getAddress(settlementAddress)),
        types: { EIP712Domain: EIP712_DOMAIN_TYPE, Trade: TRADE_TYPES.Trade },
        primaryType: 'Trade',
        message: tradeToMessage(trade),
      });

      setPending(true);
      try {
        const signature = await provider.request({
          method: 'eth_signTypedData_v4',
          params: [address, typedData],
        });
        if (typeof signature !== 'string' || !signature.startsWith('0x')) {
          throw new Error('The wallet returned something that is not a signature.');
        }
        return signature as `0x${string}`;
      } finally {
        setPending(false);
      }
    },
    [settlementAddress, address, connector]
  );

  return { sign, isPending };
}
