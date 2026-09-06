// Wire contract - BLUEPRINT.md section 3.1. FROZEN.
// Do not change without telling BOTH agents (runbook Part 6).

export type RfqStatus = 'OPEN' | 'REVEALING' | 'AWARDED' | 'SETTLED' | 'EXPIRED' | 'FAILED';

export interface Rfq {
  id: string;                    // uuid
  assetToken: string;            // 0x… ATS diamond address
  assetSymbol: string;
  partition: string;             // bytes32 hex
  cashToken: string;             // 0x… HTS token EVM address
  quantity: string;              // base units, decimal string
  seller: string;                // 0x…
  holdId: number | null;         // set once hold is on-chain
  commitDeadline: number;        // unix seconds
  revealDeadline: number;        // unix seconds
  status: RfqStatus;
  createdAt: number;
  hcsSequenceNumber: number | null;
}

export interface QuoteCommit {
  rfqId: string;
  dealer: string;
  commitHash: string;            // 0x… keccak256
  submittedAt: number;
  hcsSequenceNumber: number | null;
}

export interface QuoteReveal {
  rfqId: string;
  dealer: string;
  price: string;                 // cash base units per 1 whole asset unit
  nonce: string;                 // 0x… bytes32
  valid: boolean;                // did it match the commit?
  revealedAt: number;
  /**
   * How long this dealer's price stays FIRM, as a unix second, measured from
   * the reveal's own HCS consensus timestamp.
   *
   * This is the dealer's commitment, NOT the RFQ's close time. MECHANICS 2 and
   * 4: Umbra originally let firmness inherit the request's close time, which
   * silently committed a dealer to holding a price for a full day once long
   * requests became possible. Firmness is capped independently here for the
   * same reason.
   *
   * Without it a seller can sit on a revealed price and lift it after the
   * market moves - a free option the dealer never agreed to write.
   */
  validUntil: number;
}

export interface Trade {                 // EIP-712 payload — MUST match Solidity struct
  rfqId: string;                         // bytes32 — see rfqIdToBytes32
  assetToken: string;
  partition: string;                     // bytes32
  holdId: string;                        // uint256 as string
  cashToken: string;
  seller: string;
  buyer: string;
  quantity: string;                      // uint256
  notional: string;                      // uint256 — total cash, precomputed
  deadline: string;                      // uint256 unix seconds
  nonce: string;                         // uint256
}

export type AuditKind =
  | 'RFQ_OPENED' | 'HOLD_PLACED' | 'QUOTE_COMMITTED' | 'WINDOW_CLOSED'
  | 'QUOTE_REVEALED' | 'REVEAL_FAILED' | 'AWARDED' | 'SETTLED'
  | 'SETTLEMENT_REVERTED' | 'EXPIRED'
  // lifecycle, not trading: the bond matured and the holder was redeemed out
  | 'REDEEMED';

export interface AuditEvent {
  rfqId: string;
  kind: AuditKind;
  payload: Record<string, unknown>;
  hcsSequenceNumber: number;
  consensusTimestamp: string;
  topicId: string;
}

// section 3.6 — error envelope
export type ErrorCode =
  | 'COMMIT_WINDOW_CLOSED' | 'REVEAL_WINDOW_CLOSED' | 'COMMIT_MISMATCH'
  | 'HOLD_NOT_FOUND' | 'HOLD_EXPIRED' | 'INSUFFICIENT_ALLOWANCE'
  | 'KYC_REJECTED' | 'SIGNATURE_INVALID' | 'SETTLEMENT_REVERTED'
  | 'TOKEN_NOT_ASSOCIATED';

export interface ErrorEnvelope {
  error: { code: ErrorCode; message: string; detail: Record<string, unknown> };
}

// section 3.5 — websocket server->client frames
export type WsFrame =
  | { type: 'rfq.updated'; rfq: Rfq }
  | { type: 'quote.committed'; rfqId: string; dealer: string; commitHash: string; count: number }
  | { type: 'window.closed'; rfqId: string }
  | { type: 'quote.revealed'; rfqId: string; dealer: string; price: string; valid: boolean }
  | { type: 'awarded'; rfqId: string; dealer: string; trade: Trade }
  | { type: 'settled'; rfqId: string; txHash: string; hashscanUrl: string }
  | { type: 'reverted'; rfqId: string; reason: string }
  | { type: 'audit'; event: AuditEvent };
