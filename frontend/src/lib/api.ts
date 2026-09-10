// Typed REST client for the frozen wire contract (BLUEPRINT §3.4, §3.6).
//
// Two rules that come straight out of MECHANICS §4.10:
//   - Never swallow an error. "A stalled trade with no explanation is the worst
//     demo outcome"; every failure surfaces its real code and message.
//   - Never guess success. A response is successful because the request said so,
//     not because some field happened to be truthy ("a successful settlement
//     displayed as a failure, because the success check read a field that was
//     undefined").
import { API_BASE } from './config';
import type {
  Rfq, RfqStatus, QuoteCommit, QuoteReveal, Trade, Fill, AuditEvent, ErrorCode,
} from '@sotto/shared';

// ---------------------------------------------------------------- error type

/** The §3.6 envelope, as a throwable. `code` drives the B5 failure view. */
export class SottoError extends Error {
  readonly code: ErrorCode | 'NETWORK' | 'BAD_RESPONSE' | 'UNKNOWN';
  readonly detail: Record<string, unknown>;
  readonly status: number;

  constructor(
    code: SottoError['code'],
    message: string,
    detail: Record<string, unknown> = {},
    status = 0
  ) {
    super(message);
    this.name = 'SottoError';
    this.code = code;
    this.detail = detail;
    this.status = status;
  }
}

/** Human sentence for a wire error code. Shown verbatim in the failure view. */
export const ERROR_COPY: Record<string, string> = {
  COMMIT_WINDOW_CLOSED: 'The commit window has closed. No further quotes are accepted.',
  REVEAL_WINDOW_CLOSED: 'The reveal window has closed. An unrevealed quote is forfeit.',
  COMMIT_MISMATCH: 'This reveal does not match the committed hash. The quote is void.',
  HOLD_NOT_FOUND: 'No hold was found for this RFQ. The seller has not escrowed the block.',
  HOLD_EXPIRED: 'The hold has expired. The seller can reclaim it; a new hold is needed to trade.',
  INSUFFICIENT_ALLOWANCE: 'The buyer has not approved enough cash. Neither leg moved.',
  KYC_REJECTED: 'ATS refused the transfer: the buyer is not KYC-approved for this asset. Neither leg moved.',
  SIGNATURE_INVALID: 'A signature did not recover to the expected party.',
  SETTLEMENT_REVERTED: 'The settlement transaction reverted. Both legs were rolled back.',
  TOKEN_NOT_ASSOCIATED: 'An account is not associated with this token. Run the association step first.',
  NETWORK: 'Could not reach the Sotto API.',
  BAD_RESPONSE: 'The API returned something this client could not read.',
  UNKNOWN: 'Something went wrong.',
};

export function errorCopy(e: unknown): string {
  if (e instanceof SottoError) return ERROR_COPY[e.code] ?? e.message;
  if (e instanceof Error) return e.message;
  return ERROR_COPY.UNKNOWN;
}

// ------------------------------------------------------- response-only types
// These are not part of the frozen §3.1 wire contract — they are the shapes the
// endpoints in §3.4 return around it. Fields the blueprint does not promise are
// optional, so a missing one degrades a panel instead of throwing.

export interface Health {
  ok: boolean;
  network: string;
  topicId: string | null;
  topicUrl?: string | null;
  settlementAddress: string | null;
  blockHeight?: number | null;
  /** START-HERE §4: check this is false before filming anything. */
  mock?: boolean;
  bondAddress?: string | null;
  equityAddress?: string | null;
  shortBondAddress?: string | null;
  cashToken?: string | null;
  cashTokenId?: string | null;
  cashDecimals?: number;
  navOracleAddress?: string | null;
  dealerBondAddress?: string | null;
  priceSourceAddress?: string | null;
  schedulerAddress?: string | null;
  /** Demo parties, so the role switcher can match a connected wallet. */
  accounts?: { issuer?: string; seller?: string; dealer?: string; relayer?: string };
}

export interface AssetPosition {
  token: string;
  symbol: string;
  decimals: number;
  partition?: string;
  /** All four numbers, already computed. balanceOf alone is AVAILABLE, not total. */
  total: string;
  available: string;
  held: string;
  locked: string;
}

export interface CashPosition {
  token: string;
  symbol: string;
  decimals: number;
  balance: string;
  /** Allowance granted to SottoSettlement, when the API reports it. */
  allowance?: string | null;
}

export interface Balances {
  account: string;
  assets: AssetPosition[];
  cash: CashPosition[];
}

export interface CouponRow {
  date: number;
  amount?: string | null;
  status: 'SCHEDULED' | 'EXECUTED' | 'PENDING' | string;
  scheduleId?: string | null;
  scheduleAddress?: string | null;
  txHash?: string | null;
}

export interface Asset {
  token: string;
  symbol: string;
  name: string;
  decimals: number;
  assetClass?: 'BOND' | 'EQUITY' | string;
  isin?: string | null;
  nominal?: string | null;
  couponRate?: number | null;
  couponFrequency?: number | null;
  maturity?: number | null;
  partition?: string | null;
  coupons?: CouponRow[];
  hashscanUrl?: string | null;
  /** NAV band, when the oracle has a mark for this asset. */
  nav?: string | null;
  totalSupply?: string | null;
}

export interface Award {
  dealer: string;
  price: string;
  quantity?: string;
  notional?: string;
  trade?: Trade;
  awardedAt?: number;
}

/** GET /api/rfq/:id */
export interface RfqDetail {
  rfq: Rfq;
  commits: QuoteCommit[];
  reveals: QuoteReveal[];
  award: Award | null;
  fills: Fill[];
  sellerSignatures: Record<string, string>;
  settledFillNonces: string[];
  audit: AuditEvent[];
  /** Present once settlement has been attempted. */
  settlement?: {
    status: 'PENDING' | 'SETTLED' | 'REVERTED';
    txHash?: string | null;
    hashscanUrl?: string | null;
    reason?: string | null;
    path?: 'A' | 'B' | null;
  } | null;
}

export interface AwardResponse {
  trade: Trade;
  fills: Fill[];
  filled: string;
  unfilled: string;
  digest: string;
}

export interface SettleResponse {
  txHash?: string;
  status: 'SETTLED' | 'REVERTED' | 'PENDING' | string;
  hashscanUrl?: string | null;
  reason?: string | null;
}

// -------------------------------------------------------------- the fetcher

async function request<T>(
  path: string,
  init?: Omit<RequestInit, 'body'> & { body?: unknown }
): Promise<T> {
  const url = `${API_BASE}${path}`;
  let res: Response;

  try {
    res = await fetch(url, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init?.headers as Record<string, string> | undefined),
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
      cache: 'no-store',
    });
  } catch (cause) {
    throw new SottoError('NETWORK', `Could not reach ${url}`, {
      cause: String(cause),
    });
  }

  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      if (!res.ok) {
        throw new SottoError('BAD_RESPONSE', text.slice(0, 300), {}, res.status);
      }
      throw new SottoError('BAD_RESPONSE', `Non-JSON response from ${path}`, {}, res.status);
    }
  }

  if (!res.ok) {
    const env = parsed as { error?: { code?: string; message?: string; detail?: unknown } } | null;
    const code = (env?.error?.code as ErrorCode | undefined) ?? 'UNKNOWN';
    const message = env?.error?.message || `${res.status} ${res.statusText}`;
    const detail = (env?.error?.detail as Record<string, unknown>) ?? {};
    throw new SottoError(code, message, detail, res.status);
  }

  return parsed as T;
}

// --------------------------------------------------------------- normalisers
// BLUEPRINT day 4 is explicitly "cut over from mock to live API, fix the shape
// mismatches you will find". These functions are where that fix belongs, so a
// live-API difference costs one edit here rather than fifty across components.

function asString(v: unknown, fallback = '0'): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  return fallback;
}

function normalizeRfq(raw: unknown): Rfq {
  const r = (raw ?? {}) as Record<string, any>;
  return {
    ...r,
    filled: asString(r.filled, '0'),
    unfilled: asString(r.unfilled, asString(r.quantity, '0')),
  } as Rfq;
}

function normalizeAsset(raw: unknown): Asset {
  const a = (raw ?? {}) as Record<string, any>;
  return {
    ...a,
    token: asString(a.token ?? a.assetToken, ''),
    name: asString(a.name, 'Security token'),
    symbol: asString(a.symbol, '—'),
    decimals: Number(a.decimals ?? 0),
    partition: a.partition ?? null,
    hashscanUrl: a.hashscanUrl ?? a.hashscan ?? null,
    totalSupply: a.totalSupply == null ? null : asString(a.totalSupply),
  };
}

function normalizeRfqDetail(raw: unknown): RfqDetail {
  const r = (raw ?? {}) as Record<string, any>;
  const rfq = normalizeRfq(r.rfq);
  const reveals = (Array.isArray(r.reveals) ? r.reveals : []) as QuoteReveal[];
  const fills = (Array.isArray(r.fills) ? r.fills : []) as Fill[];
  const awardRaw = r.award as Record<string, any> | null | undefined;
  const firstFill = fills[0];
  const dealer = asString(awardRaw?.dealer ?? firstFill?.dealer, '');
  const reveal = reveals.find(
    (q) => dealer && q.dealer.toLowerCase() === dealer.toLowerCase()
  );
  const trade = (awardRaw?.trade ?? firstFill?.trade) as Trade | undefined;
  const award = dealer || trade ? {
    ...awardRaw,
    dealer: dealer || trade?.buyer || '',
    price: asString(awardRaw?.price ?? firstFill?.price ?? reveal?.price),
    quantity: asString(awardRaw?.quantity ?? firstFill?.quantity ?? trade?.quantity),
    notional: asString(awardRaw?.notional ?? firstFill?.notional ?? trade?.notional),
    trade,
  } satisfies Award : null;
  const audit = (Array.isArray(r.audit) ? r.audit : []) as AuditEvent[];
  const terminal = [...audit].reverse().find(
    (e) => (e.kind === 'SETTLED' && e.payload?.partial !== true) || e.kind === 'SETTLEMENT_REVERTED'
  );
  const settlement = r.settlement ?? (terminal ? {
    status: terminal.kind === 'SETTLED' ? 'SETTLED' : 'REVERTED',
    txHash: terminal.payload?.txHash ?? null,
    hashscanUrl: terminal.payload?.hashscanUrl ?? null,
    reason: terminal.payload?.reason ?? terminal.payload?.message ?? null,
    path: terminal.payload?.path ?? null,
  } : null);

  return {
    rfq,
    commits: (Array.isArray(r.commits) ? r.commits : []) as QuoteCommit[],
    reveals,
    award,
    fills,
    sellerSignatures: (r.sellerSignatures ?? {}) as Record<string, string>,
    settledFillNonces: (Array.isArray(r.settledFillNonces) ? r.settledFillNonces : []) as string[],
    audit,
    settlement,
  };
}

export function normalizeBalances(raw: unknown, account: string): Balances {
  const r = (raw ?? {}) as Record<string, any>;

  // Preferred shape: { account, assets: [...], cash: [...] }
  if (Array.isArray(r.assets) || Array.isArray(r.cash)) {
    return {
      account: asString(r.account, account),
      assets: (r.assets ?? []).map((a: any): AssetPosition => ({
        token: asString(a.token ?? a.address, ''),
        symbol: asString(a.symbol, '—'),
        decimals: Number(a.decimals ?? 0),
        partition: a.partition ?? undefined,
        total: asString(a.total),
        available: asString(a.available),
        held: asString(a.held),
        locked: asString(a.locked),
      })),
      cash: (r.cash ?? []).map((c: any): CashPosition => ({
        token: asString(c.token ?? c.address, ''),
        symbol: asString(c.symbol, 'USDC'),
        decimals: Number(c.decimals ?? 6),
        balance: asString(c.balance ?? c.total),
        allowance: c.allowance == null ? null : asString(c.allowance),
      })),
    };
  }

  // Flat shape: { total, available, held, locked, cashBalance, ... }
  if ('available' in r || 'total' in r) {
    return {
      account: asString(r.account, account),
      assets: [{
        token: asString(r.assetToken ?? r.token, ''),
        symbol: asString(r.assetSymbol ?? r.symbol, '—'),
        decimals: Number(r.assetDecimals ?? r.decimals ?? 0),
        partition: r.partition ?? undefined,
        total: asString(r.total),
        available: asString(r.available),
        held: asString(r.held),
        locked: asString(r.locked),
      }],
      cash: r.cashBalance == null && r.cash == null ? [] : [{
        token: asString(r.cashToken, ''),
        symbol: asString(r.cashSymbol, 'USDC'),
        decimals: Number(r.cashDecimals ?? 6),
        balance: asString(r.cashBalance ?? r.cash),
        allowance: r.allowance == null ? null : asString(r.allowance),
      }],
    };
  }

  return { account, assets: [], cash: [] };
}

// ------------------------------------------------------------------ endpoints

export const api = {
  health: () => request<Health>('/api/health'),

  listRfqs: async (status?: RfqStatus) =>
    (await request<unknown[]>('/api/rfq' + (status ? `?status=${status}` : ''))).map(normalizeRfq),

  getRfq: async (id: string) => normalizeRfqDetail(await request<unknown>(`/api/rfq/${id}`)),

  createRfq: (body: {
    assetToken: string;
    partition: string;
    quantity: string;
    cashToken: string;
    seller: string;
    commitWindowSecs: number;
    revealWindowSecs: number;
  }) => request<Rfq>('/api/rfq', { method: 'POST', body }),

  reportHold: (id: string, body: { holdId: number; txHash: string }) =>
    request<Rfq>(`/api/rfq/${id}/hold`, { method: 'POST', body }),

  commit: (id: string, body: { dealer: string; commitHash: string }) =>
    request<QuoteCommit>(`/api/rfq/${id}/commit`, { method: 'POST', body }),

  closeRfq: (id: string) =>
    request<Rfq>(`/api/rfq/${id}/close`, { method: 'POST', body: {} }),

  reveal: (id: string, body: {
    dealer: string;
    price: string;
    nonce: string;
    quantity: string;
    minQuantity: string;
    firmnessSecs?: number;
  }) =>
    request<QuoteReveal>(`/api/rfq/${id}/reveal`, { method: 'POST', body }),

  award: (id: string) =>
    request<AwardResponse>(`/api/rfq/${id}/award`, { method: 'POST', body: {} }),

  submitSellerSignature: (id: string, nonce: string, signature: string) =>
    request<{ ok: true; nonce: string }>(`/api/rfq/${id}/seller-signature`, {
      method: 'POST', body: { nonce, signature },
    }),

  settle: (
    id: string,
    body: { trade: Trade; sellerSig: string; buyerSig: string }
  ) => request<SettleResponse>(`/api/rfq/${id}/settle`, { method: 'POST', body }).then((result) => {
    if (result.status === 'FAILED' || result.status === 'REVERTED') {
      throw new SottoError('SETTLEMENT_REVERTED', result.reason ?? ERROR_COPY.SETTLEMENT_REVERTED);
    }
    return result;
  }),

  audit: async (id: string) => {
    const raw = await request<AuditEvent[] | { events: AuditEvent[] }>(`/api/rfq/${id}/audit`);
    return Array.isArray(raw) ? raw : raw.events;
  },

  assets: async () => (await request<unknown[]>('/api/assets')).map(normalizeAsset),

  balances: async (account: string): Promise<Balances> =>
    normalizeBalances(await request<unknown>(`/api/balances/${account}`), account),

  issue: (body: Record<string, unknown>) =>
    request<{ assetToken: string; txHash: string }>('/api/admin/issue', { method: 'POST', body }),

  kyc: (body: { assetToken: string; account: string; granted: boolean }) =>
    request<{ txHash: string }>('/api/admin/kyc', { method: 'POST', body }),
};
