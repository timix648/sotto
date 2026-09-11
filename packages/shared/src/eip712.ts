// BLUEPRINT.md section 3.2 — identical in Solidity and TS. FROZEN.
export const CHAIN_ID = 296; // Hedera testnet

export const eip712Domain = (verifyingContract: `0x${string}`) => ({
  name: 'Sotto',
  version: '1',
  chainId: CHAIN_ID,
  verifyingContract,
});

/**
 * The domain struct's own type list.
 *
 * viem used to generate this for us inside `signTypedData`. We now serialise the
 * typed data ourselves before handing it to the wallet (see frontend/src/lib/sign.ts
 * for why), so it has to be stated. These four fields are exactly the ones
 * `eip712Domain` above populates, in order, so the digest is unchanged.
 */
export const EIP712_DOMAIN_TYPE = [
  { name: 'name',              type: 'string'  },
  { name: 'version',           type: 'string'  },
  { name: 'chainId',           type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
] as const;

export const TRADE_TYPES = {
  Trade: [
    { name: 'rfqId',      type: 'bytes32' },
    { name: 'assetToken', type: 'address' },
    { name: 'partition',  type: 'bytes32' },
    { name: 'holdId',     type: 'uint256' },
    { name: 'cashToken',  type: 'address' },
    { name: 'seller',     type: 'address' },
    { name: 'buyer',      type: 'address' },
    { name: 'quantity',   type: 'uint256' },
    { name: 'notional',   type: 'uint256' },
    { name: 'deadline',   type: 'uint256' },
    { name: 'nonce',      type: 'uint256' },
  ],
} as const;
