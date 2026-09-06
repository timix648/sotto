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
