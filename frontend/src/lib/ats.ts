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

/**
 * How much a hold still contains.
 *
 * Not the same as the request's unfilled remainder. A fill leaves the escrow
 * only when it settles, so a request reading filled 23 / unfilled 2 can still
 * be sitting on all 25 units. Before releasing anything, ask the hold.
 */
export const holdReadAbi = [
  {
    type: 'function',
    name: 'getHoldForByPartition',
    stateMutability: 'view',
    inputs: [
      {
        name: '_holdIdentifier',
        type: 'tuple',
        components: [
          { name: 'partition', type: 'bytes32' },
          { name: 'tokenHolder', type: 'address' },
          { name: 'holdId', type: 'uint256' },
        ],
      },
    ],
    outputs: [
      { name: 'amount_', type: 'uint256' },
      { name: 'expirationTimestamp_', type: 'uint256' },
      { name: 'escrow_', type: 'address' },
      { name: 'destination_', type: 'address' },
      { name: 'data_', type: 'bytes' },
      { name: 'operatorData_', type: 'bytes' },
      { name: 'thirdPartyType_', type: 'uint8' },
    ],
  },
] as const;

/**
 * SottoSettlement's escrow release.
 *
 * A hold survives its RFQ: the ATS escrow runs for 48 hours regardless of what
 * the venue thinks, so a request that dies without filling leaves the seller's
 * size locked until then. This is how they get it back early. Only the holder
 * may call it - the contract checks msg.sender - so it is signed in the
 * seller's own wallet, exactly like the hold that created it.
 */
export const releaseHoldAbi = [
  {
    type: 'function',
    name: 'releaseHold',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'assetToken', type: 'address' },
      { name: 'partition', type: 'bytes32' },
      { name: 'holder', type: 'address' },
      { name: 'holdId', type: 'uint256' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
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
