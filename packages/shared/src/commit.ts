// BLUEPRINT.md section 3.3 — ONE implementation, used by both sides. FROZEN.
import { keccak256, encodeAbiParameters } from 'viem';

export function computeCommit(
  price: bigint, quantity: bigint, nonce: `0x${string}`, dealer: `0x${string}`
): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'address' }],
      [price, quantity, nonce, dealer]
    )
  );
}
