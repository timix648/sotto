// ISO 6166 ISIN check digit.
//
// BLUEPRINT B1: "ISIN is checksum-validated on-chain — validate it client-side
// before submitting, or the user gets an opaque revert." ATS-SPIKE §"ISIN is
// checksum-validated on-chain": `isinValidator.sol` reverts with
// `WrongISINChecksum`, and a revert with no useful reason is exactly the stalled
// screen MECHANICS §6 warns about. So we catch it in the form instead.
//
// Algorithm: expand letters (A=10 … Z=35) to digits, then Luhn over the body,
// check digit = (10 - sum mod 10) mod 10.

export function isinCheckDigit(body: string): number | null {
  const upper = body.toUpperCase();
  if (!/^[A-Z]{2}[A-Z0-9]{9}$/.test(upper)) return null;

  let expanded = '';
  for (const ch of upper) {
    if (ch >= 'A' && ch <= 'Z') expanded += String(ch.charCodeAt(0) - 55);
    else expanded += ch;
  }

  // Luhn, doubling every second digit counting from the right of the body.
  let sum = 0;
  let double = true;
  for (let i = expanded.length - 1; i >= 0; i--) {
    let d = expanded.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return (10 - (sum % 10)) % 10;
}

export interface IsinCheck {
  valid: boolean;
  reason?: string;
  /** The ISIN this body should have had, when only the check digit is wrong. */
  suggestion?: string;
}

export function validateIsin(isin: string): IsinCheck {
  const s = isin.trim().toUpperCase();
  if (!s) return { valid: false, reason: 'An ISIN is required.' };
  if (s.length !== 12) {
    return { valid: false, reason: `An ISIN is 12 characters; this is ${s.length}.` };
  }
  if (!/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(s)) {
    return {
      valid: false,
      reason: 'Two letters for the country, nine alphanumerics, then a check digit.',
    };
  }
  const expected = isinCheckDigit(s.slice(0, 11));
  if (expected === null) return { valid: false, reason: 'Malformed ISIN.' };
  if (expected !== Number(s[11])) {
    return {
      valid: false,
      reason: `Check digit fails ISO 6166 — ATS will revert with WrongISINChecksum.`,
      suggestion: s.slice(0, 11) + String(expected),
    };
  }
  return { valid: true };
}
