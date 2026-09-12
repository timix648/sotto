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
  Rfq, RfqStatus, QuoteCommit, QuoteReveal, Trade, Fill, AuditEvent, AuditKind, ErrorCode,
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
  /**
   * The best single slice, kept so a consumer that only knows about whole-block
   * awards still reads the right dealer and price. `fills` is the truth.
   */
  award: { dealer: string; trade: Trade } | null;
  fills: Fill[];
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

  /**
   * The whole book, for snapshotting. See rfq/store.ts for why this exists:
   * the ATS hold outlives the process, so the request that explains it has to
   * as well.
   */
  dump(): RfqRecord[] {
    return [...this.records.values()];
  }

  /** Replace the book with a snapshot. Called once, at boot, before serving. */
  hydrate(records: RfqRecord[]): void {
    this.records.clear();
    for (const rec of records) {
      if (rec?.rfq?.id) this.records.set(rec.rfq.id, rec);
    }
  }

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
      fills: r.fills,
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
      filled: '0',
      unfilled: p.quantity,
    };
    const rec: RfqRecord = { rfq, commits: [], reveals: [], audit: [], award: null, fills: [] };
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
    firmnessSecs = DEFAULT_FIRMNESS_SECS,
    /**
     * The dealer's bid size. Defaults to the whole block, which is what every
     * quote was before partial fills existed - so an existing caller that omits
     * it keeps the old behaviour exactly.
     */
    quantity?: string,
    /** Smallest acceptable fill. Equal to `quantity` = all-or-none. */
    minQuantity?: string
  ): Promise<QuoteReveal> {
    const r = this.get(id);
    if (r.rfq.status !== 'REVEALING') {
      throw new RfqError('REVEAL_WINDOW_CLOSED', 'not in the reveal window', { status: r.rfq.status });
    }
    const commit = r.commits.find(c => sameAddr(c.dealer, dealer));
    if (!commit) throw new RfqError('COMMIT_MISMATCH', 'no commit from this dealer');

    const block = BigInt(r.rfq.quantity);
    const bid = quantity === undefined ? block : BigInt(quantity);
    // Refuse rather than truncate. A dealer who believes they bought more than
    // the block exists has a position they did not intend, and finding out at
    // settlement is far worse than finding out here. Mirrors the on-chain
    // InvalidQuantity check in SottoDealerBond.revealAndRelease.
    if (bid <= 0n || bid > block) {
      throw new RfqError('COMMIT_MISMATCH', 'bid quantity must be between 1 and the block size', {
        quantity: bid.toString(), blockQuantity: r.rfq.quantity,
      });
    }
    const minBid = minQuantity === undefined ? 1n : BigInt(minQuantity);
    if (minBid <= 0n || minBid > bid) {
      throw new RfqError('COMMIT_MISMATCH', 'minQuantity must be between 1 and quantity', {
        minQuantity: minBid.toString(), quantity: bid.toString(),
      });
    }

    // The commit binds the dealer's OWN size, so a dealer cannot re-size after
    // seeing the book. Same formula, same field order, same file as the dealer
    // bond contract uses on-chain.
    const expected = computeCommit(BigInt(price), bid, nonce, dealer as `0x${string}`);
    const valid = expected.toLowerCase() === commit.commitHash.toLowerCase();

    const e = await this.audit(id, valid ? 'QUOTE_REVEALED' : 'REVEAL_FAILED', {
      dealer, price, quantity: bid.toString(), valid,
    });
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
      quantity: bid.toString(),
      minQuantity: minBid.toString(),
    };
    r.reveals.push(rev);

    if (!valid) {
      throw new RfqError('COMMIT_MISMATCH', 'reveal does not match the commit hash', { expected, got: commit.commitHash });
    }
    return rev;
  }

  /**
   * Award the block. Allocation is STRICT PRICE PRIORITY: walk the valid,
   * still-firm quotes from the best price down, giving each dealer the smaller
   * of what they asked for and what is left, until the block is exhausted.
   * Ties break on the earliest HCS sequence number - consensus ordering, not
   * arrival order at our server.
   *
   * WHY PRICE PRIORITY AND NOTHING CLEVERER
   * A seller could in principle be better off skipping a dealer to reach a
   * larger one behind them, and a venue that did that would be choosing winners
   * on a rule nobody can check. Price priority is the rule every dealer can
   * verify against the public audit trail after the fact: if you were skipped,
   * either someone bid better, or you refused the size on offer. That
   * verifiability is worth more than the last basis point.
   *
   * WHY A DEALER MAY BE SKIPPED
   * A quote carries `minQuantity`. A dealer bidding 600 all-or-none is passed
   * over when only 400 remain, and the 400 goes to the next price. Real desks
   * refuse odd lots; a venue that silently hands them one is not usable.
   *
   * @param nonceBase first EIP-712 nonce to assign. Each fill consumes one, and
   *        SottoSettlement marks nonces used for BOTH parties - so N fills
   *        against one seller need N distinct nonces. Callers settling live
   *        should pass the seller's current on-chain nonce.
   */
  async award(
    id: string,
    settlementAddress: string,
    deadlineSecs = 3600,
    nonceBase = 0
  ): Promise<{ dealer: string; trade: Trade; fills: Fill[] }> {
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

    // Best price first; equal prices settle in consensus order.
    const book = [...valid].sort((a, b) => {
      const pa = BigInt(a.price), pb = BigInt(b.price);
      if (pb > pa) return 1;
      if (pb < pa) return -1;
      return seqOf(a.dealer) - seqOf(b.dealer);
    });

    const block = BigInt(r.rfq.quantity);
    let remaining = block;
    let nonce = BigInt(nonceBase);
    const fills: Fill[] = [];
    const skipped: { dealer: string; wanted: string; minQuantity: string; remaining: string }[] = [];

    for (const q of book) {
      if (remaining === 0n) break;
      const wanted = BigInt(q.quantity);
      const minBid = BigInt(q.minQuantity);
      const take = wanted < remaining ? wanted : remaining;
      if (take < minBid) {
        // All-or-none, and there is not enough left. Pass over, do not shrink.
        skipped.push({
          dealer: q.dealer, wanted: q.quantity, minQuantity: q.minQuantity, remaining: remaining.toString(),
        });
        continue;
      }

      const notional = (BigInt(q.price) * take) / 100n;
      const trade: Trade = {
        rfqId: rfqIdToBytes32(id),
        assetToken: r.rfq.assetToken,
        partition: r.rfq.partition,
        // Every fill settles against the SAME hold. ATS decrements the held
        // amount on each executeHoldByPartition and only removes the hold when
        // it reaches zero, so one escrow serves N buyers - the seller does not
        // place a hold per dealer and does not fragment their position.
        holdId: String(r.rfq.holdId ?? 0),
        cashToken: r.rfq.cashToken,
        seller: r.rfq.seller,
        buyer: q.dealer,
        quantity: take.toString(),
        notional: notional.toString(),
        // The dealer's firmness BOUNDS the settlement deadline. This is what
        // makes firmness binding rather than advisory: Trade.deadline is
        // enforced on-chain by SottoSettlement (DeadlineExpired), so a
        // settlement attempted after the quote goes stale reverts on the chain,
        // not just in our engine. Each fill carries its OWN dealer's firmness.
        deadline: String(Math.min(q.validUntil, now + deadlineSecs)),
        // Distinct per fill: SottoSettlement marks the nonce used for both
        // parties, so reusing one would make the second fill revert as a replay.
        nonce: nonce.toString(),
      };
      nonce += 1n;
      remaining -= take;
      fills.push({
        dealer: q.dealer, price: q.price, quantity: take.toString(), notional: notional.toString(), trade,
      });
    }

    if (fills.length === 0) {
      r.audit.push(await this.audit(id, 'EXPIRED', { reason: 'no quote could be allocated', skipped }));
      r.rfq.status = 'EXPIRED';
      throw new RfqError('COMMIT_MISMATCH', 'no quote could be allocated', { skipped });
    }

    const filled = block - remaining;
    r.fills = fills;
    r.rfq.filled = filled.toString();
    r.rfq.unfilled = remaining.toString();
    // `award` stays the best single slice so a consumer that predates partial
    // fills still reads a sensible dealer and trade.
    r.award = { dealer: fills[0].dealer, trade: fills[0].trade };

    r.audit.push(await this.audit(id, 'AWARDED', {
      settlementAddress,
      filled: filled.toString(),
      unfilled: remaining.toString(),
      fills: fills.map(f => ({ dealer: f.dealer, price: f.price, quantity: f.quantity, notional: f.notional })),
      skipped,
    }));
    r.rfq.status = 'AWARDED';
    return { ...r.award, fills };
  }

  /**
   * `detail` names which fill this transaction settled.
   *
   * Every partial settlement already recorded its nonce, dealer and size; the
   * last one - the one that completes the block - did not, because it goes
   * through here instead. The settlement view then had one transaction it could
   * attribute and one it could only guess at, so it showed the first fill and
   * nothing else. A block filled across two dealers rendered as a single trade.
   */
  async markSettled(
    id: string,
    txHash: string,
    detail: { nonce?: string; dealer?: string; quantity?: string } = {}
  ): Promise<Rfq> {
    const r = this.get(id);
    r.audit.push(await this.audit(id, 'SETTLED', { txHash, ...detail }));
    r.rfq.status = 'SETTLED';
    return r.rfq;
  }

  /**
   * `reason` is the sentence a person reads. `detail` carries the machine
   * code and the provider's own text - the audit trail should lose nothing,
   * but a panel should not be where anyone meets a logsBloom.
   */
  async markReverted(
    id: string,
    reason: string,
    detail: { code?: string; raw?: string } = {},
    /**
     * How many of this request's fills have already settled on-chain.
     *
     * A block filled across several dealers settles as several transactions,
     * and one reverting says nothing about the others. This used to set FAILED
     * regardless: a request where 4 of 7 units had moved - cash and securities
     * both, nonces consumed, irreversible - was labelled Reverted, next to a
     * ledger panel correctly showing the units gone. FAILED now means nothing
     * settled, which is the only thing it can honestly mean.
     */
    settledCount = 0
  ): Promise<Rfq> {
    const r = this.get(id);
    r.audit.push(await this.audit(id, 'SETTLEMENT_REVERTED', { reason, ...detail, settledCount }));
    r.rfq.status = settledCount > 0 ? 'PARTIALLY_SETTLED' : 'FAILED';
    return r.rfq;
  }
}

const sameAddr = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** HCS consensus timestamps are "seconds.nanoseconds". */
function consensusSeconds(e: AuditEvent): number {
  return Number(String(e.consensusTimestamp).split('.')[0]);
}
