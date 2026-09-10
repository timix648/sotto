// ATS contract surface used from the browser.
//
// Verified against the deployed v3.1.0 ABI used by backend/src/chain/index.ts.
// The seller signs this transaction in their own wallet; the backend only
// verifies the resulting hold before admitting it to the RFQ lifecycle.
export const HOLD_PATH_VERIFIED = true;

export const holdAbi = [
  {
    type: 'function',
    name: 'createHoldByPartition',
    stateMutability: 'nonpayable',
    inputs: [
      { name: '_partition', type: 'bytes32' },
      {
        name: '_hold',
        type: 'tuple',
        components: [
          { name: 'amount', type: 'uint256' },
          { name: 'expirationTimestamp', type: 'uint256' },
          { name: 'escrow', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'data', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      { name: 'success_', type: 'bool' },
      { name: 'holdId_', type: 'uint256' },
    ],
  },
] as const;

/** Minimal ERC-20 surface. HTS tokens expose this facade at their EVM address
 *  (HIP-218/719), which is how the Path A cash leg settles. */
export const erc20Abi = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;

/** `0` means NEVER EXPIRES — BLUEPRINT §10. Pass a real timestamp or the seller
 *  can never reclaim the block. 48h matches the settlement flow in §2. */
export const DEFAULT_HOLD_SECONDS = 48 * 3600;
