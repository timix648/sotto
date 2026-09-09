// Engine unit tests. A fake audit writer stands in for HCS so these are
// deterministic and run in milliseconds - and, more usefully, it lets us control
// the consensus timestamp, which is the thing the engine's deadlines are judged
// against.
//
//   npm run test:engine
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { RfqEngine, RfqError, DEFAULT_FIRMNESS_SECS, MAX_FIRMNESS_SECS } from './engine.js';
import { computeCommit } from '../../../packages/shared/src/commit.js';
import type { AuditEvent, AuditKind } from '../../../packages/shared/src/types.js';

const SETTLEMENT = '0x98164562Ac1A7005C5E0e00C1018669fc62843E8';
const QTY = '250';
const PRICE = 98_350_000n;

/** Audit writer whose consensus clock we control. */
function fakeAudit(clock: { now: number }) {
  let seq = 0;
  return async (rfqId: string, kind: AuditKind, payload: Record<string, unknown> = {}): Promise<AuditEvent> => ({
    rfqId, kind, payload,
    hcsSequenceNumber: ++seq,
    consensusTimestamp: `${clock.now}.000000000`,
    topicId: '0.0.test',
  });
}

async function openRfq(engine: RfqEngine, seller: string) {
  return engine.open({
    assetToken: '0x00000000000000000000000000000000007A1b2c',
    assetSymbol: 'STO-BOND-A',
    partition: '0x' + '0'.repeat(63) + '1',
    cashToken: '0x0000000000000000000000000000000000068cDa',
    quantity: QTY, seller,
    commitWindowSecs: 120, revealWindowSecs: 120,
  });
}

async function commitReveal(engine: RfqEngine, id: string, dealer: ethers.HDNodeWallet, firmness?: number) {
  const nonce = ethers.hexlify(ethers.randomBytes(32)) as `0x${string}`;
  const hash = computeCommit(PRICE, BigInt(QTY), nonce, dealer.address as `0x${string}`);
  await engine.commit(id, dealer.address, hash);
  await engine.closeWindow(id);
  return engine.reveal(id, dealer.address, PRICE.toString(), nonce, firmness);
}

/** Commit a sized bid WITHOUT closing the window - for multi-dealer books. */
async function commitSized(
  engine: RfqEngine, id: string, dealer: ethers.HDNodeWallet, price: bigint, quantity: bigint
) {
  const nonce = ethers.hexlify(ethers.randomBytes(32)) as `0x${string}`;
  const hash = computeCommit(price, quantity, nonce, dealer.address as `0x${string}`);
  await engine.commit(id, dealer.address, hash);
  return nonce;
}

test('a reveal carries a firmness deadline measured from consensus time', async () => {
  const clock = { now: Math.floor(Date.now() / 1000) };
  const engine = new RfqEngine(fakeAudit(clock));
  const seller = ethers.Wallet.createRandom();
  const dealer = ethers.Wallet.createRandom();

  const rfq = await openRfq(engine, seller.address);
  const rev = await commitReveal(engine, rfq.id, dealer);

  assert.equal(rev.validUntil, clock.now + DEFAULT_FIRMNESS_SECS);
});

test('firmness is capped independently of the RFQ window', async () => {
  const clock = { now: Math.floor(Date.now() / 1000) };
  const engine = new RfqEngine(fakeAudit(clock));
  const seller = ethers.Wallet.createRandom();
  const dealer = ethers.Wallet.createRandom();

  const rfq = await openRfq(engine, seller.address);
  // A dealer asking for a year of firmness gets the cap, not a year.
  const rev = await commitReveal(engine, rfq.id, dealer, 365 * 24 * 3600);
  assert.equal(rev.validUntil, clock.now + MAX_FIRMNESS_SECS);
});

test('a stale quote cannot be lifted — the seller has no free option', async () => {
  const clock = { now: Math.floor(Date.now() / 1000) };
  const engine = new RfqEngine(fakeAudit(clock));
  const seller = ethers.Wallet.createRandom();
  const dealer = ethers.Wallet.createRandom();

  const rfq = await openRfq(engine, seller.address);
  await commitReveal(engine, rfq.id, dealer, 1); // firm for one second

  // The seller waits for the market to move, then tries to lift.
  await new Promise(r => setTimeout(r, 1500));

  await assert.rejects(
    () => engine.award(rfq.id, SETTLEMENT),
    (e: unknown) => e instanceof RfqError && e.code === 'REVEAL_WINDOW_CLOSED'
  );
  assert.equal(engine.get(rfq.id).rfq.status, 'EXPIRED');
});

test("the awarded Trade deadline is bounded by the dealer's firmness", async () => {
  const clock = { now: Math.floor(Date.now() / 1000) };
  const engine = new RfqEngine(fakeAudit(clock));
  const seller = ethers.Wallet.createRandom();
  const dealer = ethers.Wallet.createRandom();

  const rfq = await openRfq(engine, seller.address);
  await commitReveal(engine, rfq.id, dealer, 120); // 2 minutes

  const { trade } = await engine.award(rfq.id, SETTLEMENT, 3600); // asks for an hour
  // Firmness wins: the chain will refuse a settlement after it, because
  // Trade.deadline is enforced on-chain by SottoSettlement.
  assert.ok(Number(trade.deadline) <= clock.now + 120, `deadline ${trade.deadline} should be <= ${clock.now + 120}`);
});

test('a reveal past the reveal deadline is refused on consensus time', async () => {
  const clock = { now: Math.floor(Date.now() / 1000) };
  const engine = new RfqEngine(fakeAudit(clock));
  const seller = ethers.Wallet.createRandom();
  const dealer = ethers.Wallet.createRandom();

  const rfq = await openRfq(engine, seller.address);
  const nonce = ethers.hexlify(ethers.randomBytes(32)) as `0x${string}`;
  const hash = computeCommit(PRICE, BigInt(QTY), nonce, dealer.address as `0x${string}`);
  await engine.commit(rfq.id, dealer.address, hash);
  await engine.closeWindow(rfq.id);

  // Consensus says we are past the reveal deadline, even though our status
  // still says REVEALING. Consensus wins.
  clock.now = rfq.revealDeadline + 10;

  await assert.rejects(
    () => engine.reveal(rfq.id, dealer.address, PRICE.toString(), nonce),
    (e: unknown) => e instanceof RfqError && e.code === 'REVEAL_WINDOW_CLOSED'
  );
});

test('a commit past the commit deadline is refused on consensus time', async () => {
  const clock = { now: Math.floor(Date.now() / 1000) };
  const engine = new RfqEngine(fakeAudit(clock));
  const seller = ethers.Wallet.createRandom();
  const dealer = ethers.Wallet.createRandom();

  const rfq = await openRfq(engine, seller.address);
  clock.now = rfq.commitDeadline + 10;

  const nonce = ethers.hexlify(ethers.randomBytes(32)) as `0x${string}`;
  await assert.rejects(
    () => engine.commit(rfq.id, dealer.address, computeCommit(PRICE, BigInt(QTY), nonce, dealer.address as `0x${string}`)),
    (e: unknown) => e instanceof RfqError && e.code === 'COMMIT_WINDOW_CLOSED'
  );
});

// --------------------------------------------------------------- partial fills

/** Build a book of sized bids and award it. Returns the fills. */
async function bookAndAward(
  bids: { price: bigint; quantity: bigint; minQuantity?: bigint }[],
  blockQty = 1000n
) {
  const clock = { now: Math.floor(Date.now() / 1000) };
  const engine = new RfqEngine(fakeAudit(clock));
  const seller = ethers.Wallet.createRandom();
  const rfq = await engine.open({
    assetToken: '0x00000000000000000000000000000000007A1b2c',
    assetSymbol: 'STO-BOND-A',
    partition: '0x' + '0'.repeat(63) + '1',
    cashToken: '0x0000000000000000000000000000000000068cDa',
    quantity: blockQty.toString(), seller: seller.address,
    commitWindowSecs: 120, revealWindowSecs: 120,
  });
  await engine.recordHold(rfq.id, 7);

  const dealers = bids.map(() => ethers.Wallet.createRandom());
  const nonces: `0x${string}`[] = [];
  for (let i = 0; i < bids.length; i++) {
    nonces.push(await commitSized(engine, rfq.id, dealers[i], bids[i].price, bids[i].quantity));
  }
  await engine.closeWindow(rfq.id);
  for (let i = 0; i < bids.length; i++) {
    await engine.reveal(
      rfq.id, dealers[i].address, bids[i].price.toString(), nonces[i], undefined,
      bids[i].quantity.toString(), (bids[i].minQuantity ?? 1n).toString()
    );
  }
  const res = await engine.award(rfq.id, SETTLEMENT);
  return { engine, rfq, dealers, ...res };
}

test('a block fills across several dealers, best price first', async () => {
  const { fills, engine, rfq, dealers } = await bookAndAward([
    { price: 98_200_000n, quantity: 400n },  // dealers[0]
    { price: 98_400_000n, quantity: 400n },  // dealers[1] - best
    { price: 97_900_000n, quantity: 500n },  // dealers[2] - marginal
  ]);

  assert.equal(fills.length, 3);
  assert.equal(fills[0].dealer, dealers[1].address);
  assert.equal(fills[0].quantity, '400');
  assert.equal(fills[1].dealer, dealers[0].address);
  assert.equal(fills[1].quantity, '400');
  // The marginal dealer wanted 500 and gets only what is left.
  assert.equal(fills[2].dealer, dealers[2].address);
  assert.equal(fills[2].quantity, '200');

  assert.equal(engine.get(rfq.id).rfq.filled, '1000');
  assert.equal(engine.get(rfq.id).rfq.unfilled, '0');
});

test('each dealer pays its OWN price, not a uniform clearing price', async () => {
  const { fills } = await bookAndAward([
    { price: 98_400_000n, quantity: 400n },
    { price: 98_200_000n, quantity: 600n },
  ]);
  assert.equal(fills[0].notional, ((98_400_000n * 400n) / 100n).toString());
  assert.equal(fills[1].notional, ((98_200_000n * 600n) / 100n).toString());
});

test('every fill settles against the same hold, with a distinct nonce', async () => {
  const { fills } = await bookAndAward([
    { price: 98_400_000n, quantity: 400n },
    { price: 98_200_000n, quantity: 400n },
    { price: 97_900_000n, quantity: 400n },
  ]);
  // One escrow, three buyers - the seller does not fragment their position.
  assert.deepEqual([...new Set(fills.map(f => f.trade.holdId))], ['7']);
  // Distinct nonces, or SottoSettlement rejects the second fill as a replay.
  assert.deepEqual(fills.map(f => f.trade.nonce), ['0', '1', '2']);
});

test('an all-or-none dealer is skipped rather than given an odd lot', async () => {
  const { fills, dealers } = await bookAndAward([
    { price: 98_400_000n, quantity: 700n },                      // takes 700
    { price: 98_300_000n, quantity: 600n, minQuantity: 600n },   // AON, only 300 left
    { price: 98_000_000n, quantity: 300n },                      // takes the 300
  ]);

  assert.equal(fills.length, 2);
  assert.equal(fills[0].dealer, dealers[0].address);
  assert.equal(fills[1].dealer, dealers[2].address);
  assert.equal(fills[1].quantity, '300');
  assert.ok(!fills.some(f => f.dealer === dealers[1].address), 'the AON dealer must not be filled');
});

test('a block that cannot be filled whole reports the remainder', async () => {
  const { fills, engine, rfq } = await bookAndAward([
    { price: 98_400_000n, quantity: 300n },
    { price: 98_000_000n, quantity: 250n },
  ]);
  assert.equal(fills.length, 2);
  assert.equal(engine.get(rfq.id).rfq.filled, '550');
  // The seller sold 550 of 1000. Reporting this is not optional - the other
  // 450 is still held, and still their position.
  assert.equal(engine.get(rfq.id).rfq.unfilled, '450');
});

test('equal prices are allocated in HCS consensus order', async () => {
  const { fills, dealers } = await bookAndAward([
    { price: 98_000_000n, quantity: 600n },  // committed first
    { price: 98_000_000n, quantity: 600n },  // same price, later commit
  ]);
  assert.equal(fills[0].dealer, dealers[0].address);
  assert.equal(fills[0].quantity, '600');
  assert.equal(fills[1].dealer, dealers[1].address);
  assert.equal(fills[1].quantity, '400');
});

test('a bid larger than the block is refused, not truncated', async () => {
  const clock = { now: Math.floor(Date.now() / 1000) };
  const engine = new RfqEngine(fakeAudit(clock));
  const seller = ethers.Wallet.createRandom();
  const dealer = ethers.Wallet.createRandom();
  const rfq = await openRfq(engine, seller.address);           // QTY = 250

  const tooBig = BigInt(QTY) + 1n;
  const nonce = await commitSized(engine, rfq.id, dealer, PRICE, tooBig);
  await engine.closeWindow(rfq.id);

  await assert.rejects(
    () => engine.reveal(rfq.id, dealer.address, PRICE.toString(), nonce, undefined, tooBig.toString()),
    (e: unknown) => e instanceof RfqError && e.code === 'COMMIT_MISMATCH'
  );
});

test('a sized reveal that does not match its commit is refused', async () => {
  const clock = { now: Math.floor(Date.now() / 1000) };
  const engine = new RfqEngine(fakeAudit(clock));
  const seller = ethers.Wallet.createRandom();
  const dealer = ethers.Wallet.createRandom();
  const rfq = await openRfq(engine, seller.address);

  // Commit to 100, reveal 200 - re-sizing after the window closed.
  const nonce = await commitSized(engine, rfq.id, dealer, PRICE, 100n);
  await engine.closeWindow(rfq.id);
  await assert.rejects(
    () => engine.reveal(rfq.id, dealer.address, PRICE.toString(), nonce, undefined, '200'),
    (e: unknown) => e instanceof RfqError && e.code === 'COMMIT_MISMATCH'
  );
});
