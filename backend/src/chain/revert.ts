// Turn a reverted settlement into a sentence.
//
// Every guard in SottoSettlement and SottoNavOracle is a custom error, which is
// the right choice on-chain - four bytes instead of a string - and the worst
// possible one for a person reading a screen. ethers has nothing to decode them
// against unless you hand it the ABI, so it reports `CALL_EXCEPTION` and
// attaches the entire receipt. That whole blob was reaching the settlement view
// verbatim: five lines of logsBloom, and nowhere in it the one fact that
// mattered, which was that the quote's firmness had lapsed 331 seconds earlier.
//
// So the selectors are decoded here, where the ABI is known, and the arguments
// are used - a deadline that passed is only useful if you can see by how much.
import { ethers } from 'ethers';

/** Machine-readable cause, for the audit trail and for the UI to branch on. */
export type RevertCode =
  | 'DEADLINE_EXPIRED'
  | 'SIGNATURE_INVALID'
  | 'NONCE_USED'
  | 'WRONG_ESCROW'
  | 'HOLD_TOO_SMALL'
  | 'HOLD_EXPIRED'
  | 'DELIVERY_REFUSED'
  | 'RELEASE_FAILED'
  | 'NOT_HOLDER'
  | 'ZERO_QUANTITY'
  | 'NO_NAV_REFERENCE'
  | 'NAV_STALE'
  | 'NAV_OUTSIDE_BAND'
  | 'INSUFFICIENT_CASH'
  | 'UNKNOWN';

export interface Explained {
  code: RevertCode;
  /** One sentence, for a person. */
  message: string;
  /** The raw provider message, kept for the audit trail - never for a panel. */
  raw: string;
}

const ERRORS = [
  'error DeadlineExpired(uint256 deadline, uint256 nowTs)',
  'error SignatureInvalid(address expected, address recovered)',
  'error NonceAlreadyUsed(address account, uint256 nonce)',
  'error WrongEscrow(address expected, address actual)',
  'error HoldTooSmall(uint256 held, uint256 required)',
  'error HoldExpired(uint256 expiration, uint256 nowTs)',
  'error DeliveryFailed()',
  'error ReleaseFailed()',
  'error NotHolder(address holder, address caller)',
  'error ZeroQuantity()',
  'error NoNavReference(address asset)',
  'error NoReference(address asset)',
  'error StaleReference(address asset, uint64 updatedAt, uint64 nowTs, uint64 maxAge)',
  'error OutsideBand(address asset, uint256 price, uint256 referencePrice, uint16 bandBps)',
];

const iface = new ethers.Interface(ERRORS);

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const secs = (n: number) => {
  if (n < 60) return `${n} second${n === 1 ? '' : 's'}`;
  const m = Math.floor(n / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const h = Math.floor(m / 60);
  return `${h} hour${h === 1 ? '' : 's'}`;
};
/** Cash and NAV are both 6dp here; prices are per 100 nominal. */
const price = (v: bigint) => (Number(v) / 1e6).toFixed(2);

/** Dig the 0x… revert payload out of whichever shape ethers wrapped it in. */
function revertData(e: unknown): string | null {
  const seen = new Set<unknown>();
  let cur: unknown = e;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const o = cur as Record<string, unknown>;
    for (const key of ['data', 'revert']) {
      const v = o[key];
      if (typeof v === 'string' && v.startsWith('0x') && v.length >= 10) return v;
    }
    const info = o.info as Record<string, unknown> | undefined;
    const err = info?.error as Record<string, unknown> | undefined;
    if (typeof err?.data === 'string' && err.data.startsWith('0x')) return err.data as string;
    cur = o.error ?? o.cause ?? o.info;
  }
  return null;
}

/**
 * The reverted transaction's hash, when the error carries a receipt.
 *
 * Needed because Hedera's JSON-RPC relay does not attach revert data to the
 * error from a sent transaction - `data=null, reason=null, revert=null`. The
 * payload is only obtainable by replaying the call, and that needs the hash.
 */
export function revertedTxHash(e: unknown): string | null {
  const seen = new Set<unknown>();
  let cur: unknown = e;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const o = cur as Record<string, unknown>;
    const receipt = o.receipt as Record<string, unknown> | undefined;
    if (typeof receipt?.hash === 'string') return receipt.hash;
    if (typeof o.transactionHash === 'string') return o.transactionHash;
    cur = o.error ?? o.cause ?? o.info;
  }
  return null;
}

/**
 * @param override revert payload recovered by replaying the call, for the case
 *        above where the error itself carries none.
 */
export function explainRevert(e: unknown, override?: string | null): Explained {
  const raw = e instanceof Error ? e.message.split('\n')[0] : String(e);
  const data = override ?? revertData(e);

  if (data) {
    let parsed: ethers.ErrorDescription | null = null;
    try { parsed = iface.parseError(data); } catch { /* not one of ours */ }

    if (parsed) {
      const a = parsed.args;
      switch (parsed.name) {
        case 'DeadlineExpired':
          return {
            code: 'DEADLINE_EXPIRED', raw,
            message:
              `The quote was no longer firm. Its deadline passed ${secs(Number(a[1] - a[0]))} `
              + 'before this settlement reached the network, so the dealer is not bound to that '
              + 'price any more. Nothing moved. The block has to be re-quoted.',
          };
        case 'SignatureInvalid':
          return {
            code: 'SIGNATURE_INVALID', raw,
            message:
              `A signature did not belong to the party it claims. Expected ${short(a[0])}, `
              + `recovered ${short(a[1])}. The trade was not authorised by both sides.`,
          };
        case 'NonceAlreadyUsed':
          return {
            code: 'NONCE_USED', raw,
            message:
              `This fill was already settled — ${short(a[0])} has spent nonce ${a[1]}. `
              + 'A signed trade cannot execute twice.',
          };
        case 'WrongEscrow':
          return {
            code: 'WRONG_ESCROW', raw,
            message:
              `The hold names ${short(a[1])} as its escrow agent, not this venue `
              + `(${short(a[0])}). Sotto can only settle against a hold escrowed to itself.`,
          };
        case 'HoldTooSmall':
          return {
            code: 'HOLD_TOO_SMALL', raw,
            message:
              `The escrow holds ${a[0]} units but this fill needs ${a[1]}. `
              + 'Another fill on the same block may have taken the size first.',
          };
        case 'HoldExpired':
          return {
            code: 'HOLD_EXPIRED', raw,
            message:
              `The seller's escrow expired ${secs(Number(a[1] - a[0]))} ago. `
              + 'The units returned to the seller and are no longer reserved for this trade.',
          };
        case 'DeliveryFailed':
          return {
            code: 'DELIVERY_REFUSED', raw,
            message:
              'The ATS refused to deliver the security — its compliance rules rejected the '
              + 'transfer, most often a KYC status on the buyer. The cash leg ran a line earlier '
              + 'and was rolled back with it.',
          };
        case 'ReleaseFailed':
          return { code: 'RELEASE_FAILED', raw, message: 'The ATS refused to release the hold.' };
        case 'NotHolder':
          return {
            code: 'NOT_HOLDER', raw,
            message:
              `Only ${short(a[0])} can release that escrow, and the request came from `
              + `${short(a[1])}.`,
          };
        case 'ZeroQuantity':
          return { code: 'ZERO_QUANTITY', raw, message: 'A trade for zero units cannot settle.' };
        case 'NoNavReference':
        case 'NoReference':
          return {
            code: 'NO_NAV_REFERENCE', raw,
            message:
              'No NAV has ever been published for this asset, so the band guard has nothing to '
              + 'check the price against. The issuer publishes it from their portal.',
          };
        case 'StaleReference':
          return {
            code: 'NAV_STALE', raw,
            message:
              `The NAV mark is ${secs(Number(a[2] - a[1]))} old and the venue refuses anything `
              + `past ${secs(Number(a[3]))}. A stale reference is not trusted, so no price can be `
              + 'checked against it. The issuer republishes NAV from their portal.',
          };
        case 'OutsideBand':
          return {
            code: 'NAV_OUTSIDE_BAND', raw,
            message:
              `The price ${price(a[1])} is more than ${Number(a[3]) / 100}% away from the NAV `
              + `mark of ${price(a[2])}, both per 100 nominal. The venue will not settle a trade `
              + 'that far off the reference.',
          };
      }
    }
  }

  // Not a custom error we know. The commonest one by far is the buyer simply
  // not having the cash, which HTS reports as a plain failure.
  if (/insufficient|balance|allowance/i.test(raw)) {
    return {
      code: 'INSUFFICIENT_CASH', raw,
      message:
        'The cash leg could not be paid — the buyer is short of the notional, or has not '
        + 'approved enough of it to the settlement contract.',
    };
  }

  return {
    code: 'UNKNOWN', raw,
    message:
      'The settlement reverted and the chain returned no reason we recognise. Nothing moved on '
      + 'either leg. The raw provider error is on the transaction in HashScan.',
  };
}
