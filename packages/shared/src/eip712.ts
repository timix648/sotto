// BLUEPRINT.md section 3.2 — identical in Solidity and TS. FROZEN.
export const CHAIN_ID = 296; // Hedera testnet

export const eip712Domain = (verifyingContract: `0x${string}`) => ({
  name: 'Sotto',
  version: '1',
  chainId: CHAIN_ID,
  verifyingContract,
});

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
