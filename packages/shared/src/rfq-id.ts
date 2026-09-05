// BLUEPRINT.md section 3.1 — UUID <-> bytes32. FROZEN.
// A UUID is 128 bits; bytes32 is 256. It fits, so do NOT hash it.
// Right-padding keeps it reversible: anyone reading a Settled event on HashScan
// can recover the RFQ id without access to our database.
//
// NOTE: .toLowerCase() is a normalisation guard, not a spec change. Output is
// byte-identical to the blueprint for every lowercase UUID (all crypto.randomUUID
// produces). Without it an uppercase UUID yields a DIFFERENT bytes32 and the
// counterparty's EIP-712 digest silently fails to match.
export function rfqIdToBytes32(uuid: string): `0x${string}` {
  return ('0x' + uuid.toLowerCase().replace(/-/g, '') + '0'.repeat(32)) as `0x${string}`;
}

export function bytes32ToRfqId(b: string): string {
  const h = b.slice(2, 34);
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20, 32)].join('-');
}
