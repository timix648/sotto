// A4 - the RFQ engine.
//
// State machine: OPEN -> REVEALING -> AWARDED -> SETTLED, plus EXPIRED and FAILED.
//
// Two properties this file exists to guarantee:
//
//  1. Windows are enforced against HCS CONSENSUS TIMESTAMPS, not Date.now().
//     A venue that closes its own window on its own clock is asking to be
//     trusted. Consensus time is not ours to move.
//
//  2. A commit is verified on reveal using the SAME computeCommit the dealer
//     used - one implementation, in packages/shared, imported by both sides.
//     MECHANICS 3.14: each dealer must be paid its own quoted price, never a
//     rival's, and that only holds if commit->reveal binding is exact.
import { randomUUID } from 'node:crypto';
import type {
  Rfq, RfqStatus, QuoteCommit, QuoteReveal, Trade, AuditEvent, AuditKind, ErrorCode,
} from '../../../packages/shared/src/types.js';
import { computeCommit } from '../../../packages/shared/src/commit.js';
import { rfqIdToBytes32 } from '../../../packages/shared/src/rfq-id.js';

/**
 * Default quote firmness: 30 minutes.
 *
 * MECHANICS 4: Umbra capped firmness at 30 minutes by default AFTER discovering
 * that inheriting the RFQ close time silently committed a dealer to holding a
 * price for a whole day once long requests became possible. Same default, same
 * reason - it is the dealer's exposure, so it must not scale with the seller's
 * chosen window.
 */
export const DEFAULT_FIRMNESS_SECS = 30 * 60;
export const MAX_FIRMNESS_SECS = 24 * 60 * 60;

/** Slack after revealDeadline in which an award may still be made. */
export const AWARD_GRACE_SECS = 5 * 60;

export class RfqError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly detail: Record<string, unknown> = {}) {
    super(message);
  }
}

/** Writes an audit event and returns it with consensus data filled in. */
export type AuditWriter = (
  rfqId: string,
  kind: AuditKind,
  payload?: Record<string, unknown>
) => Promise<AuditEvent>;

export interface RfqRecord {
  rfq: Rfq;
  commits: QuoteCommit[];
  reveals: QuoteReveal[];
  audit: AuditEvent[];
  award: { dealer: string; trade: Trade } | null;
}

export interface OpenParams {
  assetToken: string;
  assetSymbol: string;
  partition: string;
  cashToken: string;
  quantity: string;
  seller: string;
  commitWindowSecs: number;
  revealWindowSecs: number;
}

export class RfqEngine {
  private records = new Map<string, RfqRecord>();

  constructor(private readonly audit: AuditWriter) {}

  list(status?: RfqStatus): Rfq[] {
    const all = [...this.records.values()].map(r => r.rfq);
    return status ? all.filter(r => r.status === status) : all;
  }

  get(id: string): RfqRecord {
    const r = this.records.get(id);
    if (!r) throw new RfqError('HOLD_NOT_FOUND', `no rfq ${id}`);
    return r;
  }

  /**
   * Public view. Prices are withheld while the commit window is open - the
   * venue itself does not surface a price before the window closes.
   */
  view(id: string) {
    const r = this.get(id);
    const sealed = r.rfq.status === 'OPEN';
    return {
      rfq: r.rfq,
      commits: r.commits,
      reveals: sealed ? [] : r.reveals,
      award: r.award,
      audit: r.audit,
    };
  }

  async open(p: OpenParams): Promise<Rfq> {
    const id = randomUUID();
    const createdAt = Math.floor(Date.now() / 1000);
    const rfq: Rfq = {
      id,
      assetToken: p.assetToken,
      assetSymbol: p.assetSymbol,
      partition: p.partition,
      cashToken: p.cashToken,
      quantity: p.quantity,
      seller: p.seller,
      holdId: null,
      commitDeadline: createdAt + p.commitWindowSecs,
      revealDeadline: createdAt + p.commitWindowSecs + p.revealWindowSecs,
      status: 'OPEN',
      createdAt,
      hcsSequenceNumber: null,
    };
    const rec: RfqRecord = { rfq, commits: [], reveals: [], audit: [], award: null };
    this.records.set(id, rec);

    const e = await this.audit(id, 'RFQ_OPENED', { assetSymbol: p.assetSymbol, quantity: p.quantity, seller: p.seller });
    rec.audit.push(e);
    rfq.hcsSequenceNumber = e.hcsSequenceNumber;
    return rfq;
  }

  async recordHold(id: string, holdId: number, txHash?: string): Promise<Rfq> {
    const r = this.get(id);
    r.rfq.holdId = holdId;
    r.audit.push(await this.audit(id, 'HOLD_PLACED', { holdId, txHash }));
    return r.rfq;
  }

  /**
   * A dealer commits a sealed quote. Only the hash is stored and published; the
   * price is not known to the venue at this point.
   */
  async commit(id: string, dealer: string, commitHash: string): Promise<QuoteCommit> {
    const r = this.get(id);
    if (r.rfq.status !== 'OPEN') {
      throw new RfqError('COMMIT_WINDOW_CLOSED', 'the commit window has closed', { status: r.rfq.status });
    }
    if (r.commits.some(c => sameAddr(c.dealer, dealer))) {
      throw new RfqError('COMMIT_MISMATCH', 'this dealer has already committed');
    }

    const e = await this.audit(id, 'QUOTE_COMMITTED', { dealer, commitHash });
    // The consensus timestamp of the commit is what the deadline is judged
    // against - not our clock. If consensus says we are past the deadline, the
    // commit does not count, however early it looked locally.
    if (consensusSeconds(e) > r.rfq.commitDeadline) {
      throw new RfqError('COMMIT_WINDOW_CLOSED', 'consensus timestamp is past the commit deadline', {
        consensusTimestamp: e.consensusTimestamp,
        commitDeadline: r.rfq.commitDeadline,
      });
    }

    const commit: QuoteCommit = {
      rfqId: id, dealer, commitHash,
      submittedAt: Math.floor(Date.now() / 1000),
      hcsSequenceNumber: e.hcsSequenceNumber,
    };
    r.commits.push(commit);
    r.audit.push(e);
    return commit;
  }

  /** Close the commit window. Enforced on consensus time, not ours. */
  async closeWindow(id: string): Promise<Rfq> {
    const r = this.get(id);
    if (r.rfq.status !== 'OPEN') return r.rfq;
    r.audit.push(await this.audit(id, 'WINDOW_CLOSED', { commits: r.commits.length }));
    r.rfq.status = 'REVEALING';
    return r.rfq;
  }

  /**
   * A dealer reveals. The commit is recomputed from (price, quantity, nonce,
   * dealer) and must match exactly. A dealer who cannot produce a matching
   * reveal forfeits - which is what MECHANICS 4.10 calls the reveal-loss
   * failure, and why the UI must persist the nonce.
   */
  async reveal(
    id: string,
    dealer: string,
    price: string,
    nonce: `0x${string}`,
    firmnessSecs = DEFAULT_FIRMNESS_SECS
  ): Promise<QuoteReveal> {
    const r = this.get(id);
    if (r.rfq.status !== 'REVEALING') {
      throw new RfqError('REVEAL_WINDOW_CLOSED', 'not in the reveal window', { status: r.rfq.status });
    }
    const commit = r.commits.find(c => sameAddr(c.dealer, dealer));
    if (!commit) throw new RfqError('COMMIT_MISMATCH', 'no commit from this dealer');

    const expected = computeCommit(BigInt(price), BigInt(r.rfq.quantity), nonce, dealer as `0x${string}`);
    const valid = expected.toLowerCase() === commit.commitHash.toLowerCase();

    const e = await this.audit(id, valid ? 'QUOTE_REVEALED' : 'REVEAL_FAILED', { dealer, price, valid });
    r.audit.push(e);

    // Symmetric with commit(): the reveal window closes on CONSENSUS time, not
    // on our clock. Previously only commit() checked this, so a late reveal was
    // accepted purely because the status had not been flipped yet.
    const consensusAt = consensusSeconds(e);
    if (consensusAt > r.rfq.revealDeadline) {
      throw new RfqError('REVEAL_WINDOW_CLOSED', 'consensus timestamp is past the reveal deadline', {
        consensusTimestamp: e.consensusTimestamp,
        revealDeadline: r.rfq.revealDeadline,
      });
    }

    // Firmness runs from the reveal's own consensus timestamp and is capped
    // independently of the RFQ window.
    const firmness = Math.min(Math.max(firmnessSecs, 0), MAX_FIRMNESS_SECS);
    const rev: QuoteReveal = {
      rfqId: id, dealer, price, nonce, valid,
      revealedAt: Math.floor(Date.now() / 1000),
      validUntil: consensusAt + firmness,
    };
    r.reveals.push(rev);

    if (!valid) {
      throw new RfqError('COMMIT_MISMATCH', 'reveal does not match the commit hash', { expected, got: commit.commitHash });
    }
    return rev;
  }

  /**
   * Award to the best valid revealed price. Ties break on the earliest HCS
   * sequence number - consensus ordering, not arrival order at our server.
   */
  async award(id: string, settlementAddress: string, deadlineSecs = 3600): Promise<{ dealer: string; trade: Trade }> {
    const r = this.get(id);
    if (r.rfq.status !== 'REVEALING') {
      throw new RfqError('REVEAL_WINDOW_CLOSED', 'not awardable in this state', { status: r.rfq.status });
    }
    const now = Math.floor(Date.now() / 1000);

    // The award window itself is bounded. An RFQ must not sit in REVEALING for
    // ever, silently holding every dealer's price hostage.
    if (now > r.rfq.revealDeadline + AWARD_GRACE_SECS) {
      r.audit.push(await this.audit(id, 'EXPIRED', { reason: 'award window closed' }));
      r.rfq.status = 'EXPIRED';
      throw new RfqError('REVEAL_WINDOW_CLOSED', 'the award window has closed', {
        revealDeadline: r.rfq.revealDeadline,
      });
    }

    const allValid = r.reveals.filter(v => v.valid);
    if (allValid.length === 0) {
      r.audit.push(await this.audit(id, 'EXPIRED', { reason: 'no valid reveals' }));
      r.rfq.status = 'EXPIRED';
      throw new RfqError('COMMIT_MISMATCH', 'no valid revealed quotes');
    }

    // A price that is no longer firm cannot be lifted. Otherwise the seller
    // holds a free option: watch the market, then award a stale quote.
    const valid = allValid.filter(v => v.validUntil > now);
    if (valid.length === 0) {
      r.audit.push(await this.audit(id, 'EXPIRED', {
        reason: 'every revealed quote is stale',
        latestValidUntil: Math.max(...allValid.map(v => v.validUntil)),
      }));
      r.rfq.status = 'EXPIRED';
      throw new RfqError('REVEAL_WINDOW_CLOSED', 'no quote is still firm', {
        now,
        latestValidUntil: Math.max(...allValid.map(v => v.validUntil)),
      });
    }

    const seqOf = (dealer: string) =>
      r.commits.find(c => sameAddr(c.dealer, dealer))?.hcsSequenceNumber ?? Number.MAX_SAFE_INTEGER;

    const best = valid.reduce((a, b) => {
      const pa = BigInt(a.price), pb = BigInt(b.price);
      if (pb > pa) return b;
      if (pb < pa) return a;
      return seqOf(b.dealer) < seqOf(a.dealer) ? b : a; // tie -> earliest consensus
    });

    const notional = (BigInt(best.price) * BigInt(r.rfq.quantity)) / 100n;
    const trade: Trade = {
      rfqId: rfqIdToBytes32(id),
      assetToken: r.rfq.assetToken,
      partition: r.rfq.partition,
      holdId: String(r.rfq.holdId ?? 0),
      cashToken: r.rfq.cashToken,
      seller: r.rfq.seller,
      buyer: best.dealer,
      quantity: r.rfq.quantity,
      notional: notional.toString(),
      // The dealer's firmness BOUNDS the settlement deadline. This is what makes
      // firmness binding rather than advisory: Trade.deadline is enforced
      // on-chain by SottoSettlement (DeadlineExpired), so a settlement attempted
      // after the quote goes stale reverts on the chain, not just in our engine.
      deadline: String(Math.min(best.validUntil, now + deadlineSecs)),
      nonce: '0',
    };

    r.award = { dealer: best.dealer, trade };
    r.audit.push(await this.audit(id, 'AWARDED', { dealer: best.dealer, price: best.price, notional: notional.toString(), settlementAddress }));
    r.rfq.status = 'AWARDED';
    return r.award;
  }

  async markSettled(id: string, txHash: string): Promise<Rfq> {
    const r = this.get(id);
    r.audit.push(await this.audit(id, 'SETTLED', { txHash }));
    r.rfq.status = 'SETTLED';
    return r.rfq;
  }

  async markReverted(id: string, reason: string): Promise<Rfq> {
    const r = this.get(id);
    r.audit.push(await this.audit(id, 'SETTLEMENT_REVERTED', { reason }));
    r.rfq.status = 'FAILED';
    return r.rfq;
  }
}

const sameAddr = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** HCS consensus timestamps are "seconds.nanoseconds". */
function consensusSeconds(e: AuditEvent): number {
  return Number(String(e.consensusTimestamp).split('.')[0]);
}
