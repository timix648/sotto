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
  /** Units allocated at award. Zero until awarded. */
  filled: string;
  /**
   * Units still held and unsold after the award. A block that does not fill is
   * a normal outcome, not an error - the seller keeps the remainder held and
   * may re-offer or release it. Showing this is not optional: a seller who
   * thinks they sold 1,000 and actually sold 600 has an unhedged position.
   */
  unfilled: string;
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
  /**
   * The size THIS dealer is bidding for, in the same base units as
   * `Rfq.quantity`. Bound into the commit hash alongside the price, so a dealer
   * cannot re-size a bid after seeing the book.
   *
   * A dealer may bid for less than the block. That is the whole of partial
   * fills: the seller's 1,000 can be filled 400 + 600 by two dealers at two
   * different prices, which beats forcing one dealer to price the whole block
   * and charge for the risk of doing so.
   */
  quantity: string;
  /**
   * The smallest fill this dealer will accept, in the same units. Equal to
   * `quantity` means all-or-none: the dealer would rather not trade than be
   * left with an odd lot. Defaults to 1 (any partial welcome).
   *
   * NOT bound into the commit, deliberately - it can only ever shrink the
   * dealer's own allocation, so there is nothing to gain by misstating it, and
   * binding it would have forced a fourth field into a commit formula that is
   * already deployed on-chain in SottoDealerBond.
   */
  minQuantity: string;
}

/**
 * One dealer's slice of a block. An RFQ that fills whole has exactly one.
 */
export interface Fill {
  dealer: string;
  price: string;                 // per 100 nominal, as quoted
  quantity: string;              // units allocated to this dealer
  notional: string;              // price * quantity / 100
  trade: Trade;                  // the EIP-712 payload that settles this slice
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
  | { type: 'quote.revealed'; rfqId: string; dealer: string; price: string; quantity: string; valid: boolean }
  // `award`/`trade` are the best single slice, kept so a whole-block consumer
  // still works. `fills` is the truth when a block splits across dealers.
  | {
      type: 'awarded'; rfqId: string; dealer: string; trade: Trade;
      fills: Fill[]; filled: string; unfilled: string;
    }
  | { type: 'settled'; rfqId: string; txHash: string; hashscanUrl: string }
  | { type: 'reverted'; rfqId: string; reason: string }
  | { type: 'audit'; event: AuditEvent };
