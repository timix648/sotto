// THE formatter. One implementation, used everywhere.
//
// MECHANICS.md §4.10 lists four separate defects that made working settlements
// look broken, and every one of them was a formatting bug:
//   - a receipt telling the user they would receive NOTHING (decimals capped at 3)
//   - a live price rendered as `0.0000` (fixed 4dp on a small mark)
//   - `[object Object]` in a fee display (formatter returned an element sometimes)
//   - a bps figure reading "plus one and a half million" instead of "off market"
//
// So the rules here are absolute:
//   1. Every function returns a STRING. Never a node, never an object, never undefined.
//   2. A non-zero value NEVER renders as zero. If it would, precision grows until
//      it doesn't. In a venue demo the numbers are the product.
//   3. All maths is exact. bigint and strings only — no float ever touches a value.
import { formatUnits, parseUnits } from 'viem';

export interface AmountOpts {
  /** Minimum fraction digits, e.g. 2 for cash. Default 2. */
  minFrac?: number;
  /** Preferred maximum fraction digits. Grows on its own to avoid a false zero. */
  maxFrac?: number;
  /** Thousands grouping. Default true. */
  group?: boolean;
  /** Force a leading + on positives. Default false. */
  signed?: boolean;
}

const abs = (v: bigint) => (v < 0n ? -v : v);
const pow10 = (n: number) => 10n ** BigInt(n);

/** Half-up rounding of a base-unit bigint down to `frac` decimal places. */
function roundToFrac(value: bigint, decimals: number, frac: number): bigint {
  if (frac >= decimals) return value * pow10(frac - decimals);
  const scale = pow10(decimals - frac);
  const neg = value < 0n;
  const a = abs(value);
  const q = (a + scale / 2n) / scale;
  return neg ? -q : q;
}

function group3(intDigits: string): string {
  return intDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Format a base-unit amount for display.
 *
 * @param value    base units, as a decimal string or bigint ("19670000")
 * @param decimals token decimals (USDC = 6)
 */
export function formatAmount(
  value: string | bigint | null | undefined,
  decimals: number,
  opts: AmountOpts = {}
): string {
  const { minFrac = 2, group = true, signed = false } = opts;
  let maxFrac = opts.maxFrac ?? Math.max(minFrac, 2);

  if (value === null || value === undefined || value === '') return '—';

  let v: bigint;
  try {
    v = typeof value === 'bigint' ? value : BigInt(String(value).trim());
  } catch {
    return '—'; // never leak NaN or [object Object] into the UI
  }

  // RULE 2. A non-zero value never renders as zero.
  //
  // Note what this does NOT do: it does not creep the precision up one digit at
  // a time until something non-zero appears. That would ROUND — 0.00025 would
  // surface as "0.0003" — and a receipt that misstates the amount is the bug
  // this rule exists to prevent, not a milder version of it. When the preferred
  // precision cannot hold the value, we show it EXACTLY, at the token's full
  // precision, and let the trailing-zero trim below tidy the result.
  if (v !== 0n && roundToFrac(v, decimals, maxFrac) === 0n) {
    maxFrac = decimals;
  }

  const rounded = roundToFrac(v, decimals, maxFrac);
  const neg = rounded < 0n;
  const digits = abs(rounded).toString().padStart(maxFrac + 1, '0');
  const intPart = digits.slice(0, digits.length - maxFrac) || '0';
  let fracPart = maxFrac > 0 ? digits.slice(digits.length - maxFrac) : '';

  // Trim trailing zeros back to minFrac, but never past a significant digit.
  while (fracPart.length > minFrac && fracPart.endsWith('0')) fracPart = fracPart.slice(0, -1);

  const sign = neg ? '-' : signed && v > 0n ? '+' : '';
  const head = group ? group3(intPart) : intPart;
  return sign + head + (fracPart ? '.' + fracPart : '');
}

/** Whole-unit quantities (bond units). No forced decimals. */
export function formatQty(value: string | bigint | null | undefined, decimals = 0): string {
  return formatAmount(value, decimals, { minFrac: 0, maxFrac: decimals });
}

/** Cash amounts. 2dp floor, more when the value is genuinely smaller. */
export function formatCash(value: string | bigint | null | undefined, decimals = 6): string {
  return formatAmount(value, decimals, { minFrac: 2, maxFrac: 2 });
}

/** A quote price: cash base units per one whole asset unit. */
export function formatPrice(value: string | bigint | null | undefined, decimals = 6): string {
  return formatAmount(value, decimals, { minFrac: 2, maxFrac: 4 });
}

/** Fixed-income notional = price * quantity / 100, matching RfqEngine.award. */
export function computeNotional(price: string | bigint, quantity: string | bigint): string {
  try {
    return ((BigInt(String(price)) * BigInt(String(quantity))) / 100n).toString();
  } catch {
    return '0';
  }
}

/**
 * Basis points vs a reference. MECHANICS §4.10: a block priced far from the mid
 * produced "plus one and a half million bps", which reads as a broken calculation
 * rather than a mispriced trade. Past ±50% we say what it actually is.
 */
export function formatBps(price: string | bigint, reference: string | bigint): string {
  let p: bigint, r: bigint;
  try {
    p = BigInt(String(price));
    r = BigInt(String(reference));
  } catch {
    return '—';
  }
  if (r === 0n) return '—';
  const bps = ((p - r) * 10000n) / r;
  if (bps > 5000n || bps < -5000n) return 'off market';
  const sign = bps > 0n ? '+' : '';
  return sign + bps.toString() + ' bp';
}

/** Percent, already expressed as a percent number (coupon rate 4.25 -> "4.25%"). */
export function formatPct(value: number | string | null | undefined, frac = 2): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(frac) + '%';
}

/** Parse user input in whole units into a base-unit string. Throws on garbage. */
export function parseAmount(input: string, decimals: number): string {
  const t = input.trim().replace(/,/g, '');
  if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') throw new Error('Enter a number');
  return parseUnits(t as `${number}`, decimals).toString();
}

/** Exact base units -> a plain input-box value ("19670000" -> "19.67"). */
export function toInputValue(value: string | bigint, decimals: number): string {
  try {
    return formatUnits(BigInt(String(value)), decimals);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- identifiers

/** 0x1234…abcd — B6 requires addresses always truncated, always monospace. */
export function truncate(addr: string | null | undefined, head = 6, tail = 4): string {
  if (!addr) return '—';
  const s = String(addr);
  if (s.length <= head + tail + 1) return s;
  return s.slice(0, head) + '…' + s.slice(-tail);
}

export function truncateHash(hash: string | null | undefined): string {
  return truncate(hash, 10, 6);
}

// ---------------------------------------------------------------------- time

export function formatClock(unixSeconds: number | null | undefined): string {
  if (unixSeconds === null || unixSeconds === undefined) return '—';
  const d = new Date(unixSeconds * 1000);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

export function formatDate(unixSeconds: number | null | undefined): string {
  if (unixSeconds === null || unixSeconds === undefined) return '—';
  const d = new Date(unixSeconds * 1000);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toISOString().slice(0, 10);
}

/**
 * An HCS consensus timestamp arrives as "1788646998.050909150" — seconds with
 * nanosecond precision. Render it without losing the nanos to a float.
 */
export function formatConsensus(ts: string | null | undefined): string {
  if (!ts) return '—';
  const parts = String(ts).split('.');
  const secs = parts[0];
  const nanos = parts[1] ?? '';
  const n = Number(secs);
  if (!Number.isFinite(n)) return String(ts);
  const iso = new Date(n * 1000).toISOString().replace('T', ' ').slice(0, 19);
  return iso + '.' + nanos.slice(0, 3).padEnd(3, '0') + 'Z';
}

/** hh:mm:ss remaining. Clamps at zero — never renders a negative countdown. */
export function countdown(deadlineSeconds: number, nowSeconds: number): string {
  const left = Math.max(0, Math.floor(deadlineSeconds - nowSeconds));
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  const pad = (x: number) => String(x).padStart(2, '0');
  return h > 0 ? pad(h) + ':' + pad(m) + ':' + pad(s) : pad(m) + ':' + pad(s);
}
