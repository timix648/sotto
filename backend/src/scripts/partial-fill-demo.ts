// Partial fills, live on Hedera testnet.
//
//   npx tsx backend/src/scripts/partial-fill-demo.ts
//
// The README used to list this under Known limitations: "Partial fills are not
// supported; a block is awarded whole. Real desks split blocks, and this is the
// most obvious next mechanism." This is that mechanism.
//
// WHAT A BLOCK DESK ACTUALLY DOES
// A seller with 1,000 bonds rarely finds one dealer who wants all 1,000 at a
// good price. Forcing one dealer to price the whole block means paying them for
// the risk of warehousing it. Splitting the block across the best few bids gets
// the seller a better average and gets each dealer a size it actually wants.
//
// THE THREE THINGS THIS DEMONSTRATES ON-CHAIN
//
//  1. ONE HOLD, SEVERAL BUYERS. ATS decrements a hold on each
//     executeHoldByPartition and only removes it at zero, so the seller escrows
//     once and the block is filled by as many dealers as the book supports.
//     SottoSettlement needed no change for this: _checkHold has always required
//     amount >= quantity, not ==.
//
//  2. EACH DEALER PAYS ITS OWN PRICE. Not a uniform clearing price. MECHANICS
//     3.14 - a uniform price silently transfers value between dealers who never
//     agreed to it, and the losing side finds out from their P&L.
//
//  3. AN ALL-OR-NONE DEALER IS SKIPPED, NOT SHRUNK. A desk that says "600 or
//     nothing" and receives 200 has an odd lot it has to work out of. The
//     allocator passes over them and the size goes to the next price.
//
// The remainder that nobody bid for stays held, and the seller releases it. A
// block that does not fill is a normal outcome; hiding it would leave the seller
// believing they sold size they still own.
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';
import { RfqEngine } from '../rfq/engine.js';
import { HcsAudit } from '../hcs/client.js';
import { computeCommit } from '../../../packages/shared/src/commit.js';
import type { AuditEvent, AuditKind } from '../../../packages/shared/src/types.js';

const RPC = process.env.JSON_RPC_URL ?? 'https://testnet.hashio.io/api';
const PARTITION = '0x0000000000000000000000000000000000000000000000000000000000000001';
const BLOCK = 12n; // units on offer

const BOND_ABI = [
  'function createHoldByPartition(bytes32,(uint256 amount,uint256 expirationTimestamp,address escrow,address to,bytes data)) returns (bool,uint256)',
  'function getHoldForByPartition((bytes32,address,uint256)) view returns (uint256,uint256,address,address,bytes,bytes,uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function getHeldAmountFor(address) view returns (uint256)',
  'function symbol() view returns (string)',
];
const SETTLEMENT_ABI = [
  'function settle((bytes32 rfqId,address assetToken,bytes32 partition,uint256 holdId,address cashToken,address seller,address buyer,uint256 quantity,uint256 notional,uint256 deadline,uint256 nonce) t,bytes sellerSig,bytes buyerSig) returns (bool)',
  'function releaseHold(address,bytes32,address,uint256,uint256)',
  'function nonces(address) view returns (uint256)',
  'function nonceUsed(address,uint256) view returns (bool)',
];
const CASH_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];

const TRADE_TYPES = {
  Trade: [
    { name: 'rfqId', type: 'bytes32' },
    { name: 'assetToken', type: 'address' },
    { name: 'partition', type: 'bytes32' },
    { name: 'holdId', type: 'uint256' },
    { name: 'cashToken', type: 'address' },
    { name: 'seller', type: 'address' },
    { name: 'buyer', type: 'address' },
    { name: 'quantity', type: 'uint256' },
    { name: 'notional', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
};

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const usd = (v: bigint) => (Number(v) / 1e6).toFixed(6);
const px = (v: string) => (Number(v) / 1e6).toFixed(4);

async function main() {
  const env = loadEnv();
  const p = new ethers.JsonRpcProvider(RPC);

  const seller = new ethers.Wallet(env.SELLER_PRIVATE_KEY, p);
  // Two funded, KYC'd counterparties stand in for two dealers. A third dealer
  // is a fresh key: it is all-or-none and gets skipped, so it never has to pay.
  const dealerA = new ethers.Wallet(env.DEALER_PRIVATE_KEY, p);
  const dealerB = new ethers.Wallet(env.ISSUER_PRIVATE_KEY, p);
  const dealerC = ethers.Wallet.createRandom().connect(p);

  const SETTLEMENT = env.SETTLEMENT_ADDRESS;
  const CASH = env.USDC_EVM_ADDRESS ?? '0x0000000000000000000000000000000000068cDa';
  const bondS = new ethers.Contract(env.BOND_ADDRESS, BOND_ABI, seller);
  const bondR = new ethers.Contract(env.BOND_ADDRESS, BOND_ABI, p);
  const settle = new ethers.Contract(SETTLEMENT, SETTLEMENT_ABI, seller);
  const cash = new ethers.Contract(CASH, CASH_ABI, p);

  const hcs = new HcsAudit({
    operatorId: env.ISSUER_ACCOUNT_ID, operatorKey: env.ISSUER_PRIVATE_KEY, topicId: env.HCS_TOPIC_ID,
  });
  const audit = (id: string, kind: AuditKind, payload?: Record<string, unknown>): Promise<AuditEvent> =>
    hcs.write(id, kind, payload ?? {});
  const engine = new RfqEngine(audit);

  // --- NAV freshness -------------------------------------------------------
  //
  // The band guard refuses a settlement whose reference NAV is older than the
  // oracle's maxAge. That is not a nuisance, it is the point: a stale reference
  // is not a reference. The first run of this demo reverted at 59,260 gas
  // because the bond's administrator NAV was 79.9 hours old. An administrator
  // publishes before an auction, so that is what happens here.
  const oracle = new ethers.Contract(
    env.NAV_ORACLE_ADDRESS,
    [
      'function isFresh(address) view returns (bool)',
      'function referenceFor(address) view returns (uint256,uint64,uint8)',
      'function publishNav(address,uint256,uint8)',
    ],
    new ethers.Wallet(env.ISSUER_PRIVATE_KEY, p)
  );
  if (env.NAV_ORACLE_ADDRESS) {
    let fresh = false;
    try { fresh = await oracle.isFresh(env.BOND_ADDRESS); } catch { fresh = false; }
    if (!fresh) {
      const tx = await oracle.publishNav(env.BOND_ADDRESS, 98_350_000n, 6, { gasLimit: 1_000_000 });
      await tx.wait();
      console.log('\n  [nav]   administrator published 98.350000 (the previous reference was stale)');
    }
  }

  console.log(`\n  bond       ${env.BOND_ADDRESS}  ${await bondS.symbol()}`);
  console.log(`  settlement ${SETTLEMENT}`);
  console.log(`  seller     ${seller.address}`);
  console.log(`  block      ${BLOCK} units\n`);

  // --- open ---------------------------------------------------------------
  const rfq = await engine.open({
    assetToken: env.BOND_ADDRESS, assetSymbol: 'STO-BOND-A', partition: PARTITION,
    cashToken: CASH, quantity: BLOCK.toString(), seller: seller.address,
    commitWindowSecs: 300, revealWindowSecs: 300,
  });
  console.log(`  [open]  rfq ${rfq.id.slice(0, 8)}  HCS#${rfq.hcsSequenceNumber}`);

  // --- one hold for the whole block ---------------------------------------
  const availBefore: bigint = await bondR.balanceOf(seller.address);
  const heldBefore: bigint = await bondR.getHeldAmountFor(seller.address);
  const ht = await bondS.createHoldByPartition(
    PARTITION,
    {
      amount: BLOCK,
      expirationTimestamp: BigInt(Math.floor(Date.now() / 1000) + 48 * 3600),
      escrow: SETTLEMENT,
      // Open destination. A hold pinned to one `to` address could only ever be
      // executed to that buyer, which would make partial fills impossible.
      to: ethers.ZeroAddress,
      data: '0x',
    },
    { gasLimit: 3_000_000 }
  );
  await ht.wait();

  let holdId = -1n;
  for (let i = 0n; i < 60n; i++) {
    const [amount, , escrow] = await bondR.getHoldForByPartition([PARTITION, seller.address, i]);
    if (escrow.toLowerCase() === SETTLEMENT.toLowerCase() && amount === BLOCK) holdId = i;
  }
  if (holdId < 0n) { console.log('  could not locate the new hold'); process.exit(1); }
  await engine.recordHold(rfq.id, Number(holdId), ht.hash);
  console.log(`  [hold]  holdId ${holdId}, ${BLOCK} units escrowed  ${ht.hash}`);
  console.log(`          seller available ${availBefore} -> ${await bondR.balanceOf(seller.address)}, held ${heldBefore} -> ${await bondR.getHeldAmountFor(seller.address)}`);

  // --- sealed commits -----------------------------------------------------
  //
  // Each dealer commits keccak256(price, ITS OWN quantity, nonce, dealer). The
  // size is sealed with the price, so nobody can re-size after seeing the book.
  const book = [
    { name: 'A', w: dealerA, price: 98_400_000n, qty: 5n, minQty: 1n },
    { name: 'B', w: dealerB, price: 98_200_000n, qty: 5n, minQty: 1n },
    { name: 'C', w: dealerC, price: 98_100_000n, qty: 6n, minQty: 6n }, // all-or-none
  ];
  const nonces = new Map<string, `0x${string}`>();
  for (const d of book) {
    const n = ethers.hexlify(ethers.randomBytes(32)) as `0x${string}`;
    nonces.set(d.w.address, n);
    const c = await engine.commit(rfq.id, d.w.address, computeCommit(d.price, d.qty, n, d.w.address as `0x${string}`));
    console.log(`  [commit] dealer ${d.name}  HCS#${c.hcsSequenceNumber}  ${c.commitHash.slice(0, 18)}…  (size and price both sealed)`);
  }

  await engine.closeWindow(rfq.id);
  console.log('  [close]  commit window closed on consensus time');

  for (const d of book) {
    const r = await engine.reveal(
      rfq.id, d.w.address, d.price.toString(), nonces.get(d.w.address)!,
      undefined, d.qty.toString(), d.minQty.toString()
    );
    const aon = d.minQty === d.qty ? '  ALL-OR-NONE' : '';
    console.log(`  [reveal] dealer ${d.name}  ${px(r.price)} for ${r.quantity}${aon}`);
  }

  // --- allocate -----------------------------------------------------------
  //
  // Nonces must be free for the seller AND for each buyer: SottoSettlement marks
  // a nonce used on both sides, so a value already burned by an earlier demo
  // would make the fill revert as a replay. Probe upward for a clear run.
  const parties = [seller.address, ...book.map(d => d.w.address)];
  let base = 0;
  for (const a of parties) base = Math.max(base, Number(await settle.nonces(a)));
  const settleR = new ethers.Contract(SETTLEMENT, SETTLEMENT_ABI, p);
  outer: for (;; base++) {
    for (let k = 0; k < book.length; k++) {
      for (const a of parties) {
        if (await settleR.nonceUsed(a, base + k)) continue outer;
      }
    }
    break;
  }
  console.log(`\n  [nonce]  first free run for every party: ${base}`);

  const { fills } = await engine.award(rfq.id, SETTLEMENT, 3600, base);
  const rec = engine.get(rfq.id);
  const nameOf = (addr: string) => book.find(d => d.w.address.toLowerCase() === addr.toLowerCase())?.name ?? '?';

  console.log('\n  --- allocation ---');
  for (const f of fills) {
    console.log(`  dealer ${nameOf(f.dealer)}  ${String(f.quantity).padStart(3)} units @ ${px(f.price)}  = ${usd(BigInt(f.notional))} USDC   nonce ${f.trade.nonce}`);
  }
  for (const d of book) {
    if (!fills.some(f => f.dealer.toLowerCase() === d.w.address.toLowerCase())) {
      console.log(`  dealer ${d.name}  SKIPPED - wanted ${d.qty} all-or-none, and less than that was left`);
    }
  }
  console.log(`  filled ${rec.rfq.filled} of ${BLOCK}, unfilled ${rec.rfq.unfilled}`);

  // --- settle each fill against the SAME hold ------------------------------
  const domain = {
    name: 'Sotto', version: '1',
    chainId: Number((await p.getNetwork()).chainId),
    verifyingContract: SETTLEMENT,
  };

  console.log('\n  --- settlement ---');
  // Only read balances for parties that actually trade. HTS reverts balanceOf
  // for an account that never associated the token, and dealer C - skipped, and
  // a fresh key - never has.
  const cashBefore = new Map<string, bigint>();
  cashBefore.set(seller.address, await cash.balanceOf(seller.address));
  for (const f of fills) cashBefore.set(f.dealer, await cash.balanceOf(f.dealer));

  const txHashes: string[] = [];
  for (const f of fills) {
    const buyer = book.find(d => d.w.address.toLowerCase() === f.dealer.toLowerCase())!.w;
    const t = {
      ...f.trade,
      holdId: BigInt(f.trade.holdId),
      quantity: BigInt(f.trade.quantity),
      notional: BigInt(f.trade.notional),
      deadline: BigInt(f.trade.deadline),
      nonce: BigInt(f.trade.nonce),
    };

    const allowance: bigint = await cash.allowance(buyer.address, SETTLEMENT);
    if (allowance < t.notional) {
      // Approve the EXACT notional, never MaxUint256. HTS amounts are int64,
      // so an unlimited ERC-20-style approval overflows and the transaction
      // reverts with no reason - it just burns ~985k gas and returns status 0.
      const a = await (cash.connect(buyer) as ethers.Contract).approve(SETTLEMENT, t.notional, { gasLimit: 1_000_000 });
      await a.wait();
      console.log(`  dealer ${nameOf(f.dealer)}  approved ${usd(t.notional)} USDC`);
    }

    const sellerSig = await seller.signTypedData(domain, TRADE_TYPES, t);
    const buyerSig = await buyer.signTypedData(domain, TRADE_TYPES, t);

    const tx = await settle.settle(t, sellerSig, buyerSig, { gasLimit: 4_000_000 });
    const rc = await tx.wait();
    txHashes.push(tx.hash);

    const [heldNow] = await bondR.getHoldForByPartition([PARTITION, seller.address, holdId]);
    console.log(
      `  fill ${nameOf(f.dealer)}  ${rc?.status === 1 ? 'SUCCESS' : 'FAILED'}  gas ${rc?.gasUsed}` +
      `  hold ${heldNow} left  ${tx.hash}`
    );
  }

  // --- the remainder nobody bought ----------------------------------------
  const [remaining] = await bondR.getHoldForByPartition([PARTITION, seller.address, holdId]);
  if (remaining > 0n) {
    console.log(`\n  --- remainder ---`);
    console.log(`  ${remaining} units unsold and still escrowed. Releasing them to the seller.`);
    const rt = await settle.releaseHold(env.BOND_ADDRESS, PARTITION, seller.address, holdId, remaining, { gasLimit: 3_000_000 });
    await rt.wait();
    console.log(`  released  ${rt.hash}`);
  }

  // --- ledgers ------------------------------------------------------------
  console.log('\n  --- after ---');
  const sellerCashAfter: bigint = await cash.balanceOf(seller.address);
  console.log(`  seller cash   ${usd(cashBefore.get(seller.address)!)} -> ${usd(sellerCashAfter)} USDC`);
  for (const f of fills) {
    const after: bigint = await cash.balanceOf(f.dealer);
    const bonds: bigint = await bondR.balanceOf(f.dealer);
    console.log(`  dealer ${nameOf(f.dealer)} cash ${usd(cashBefore.get(f.dealer)!)} -> ${usd(after)} USDC   bonds ${bonds}`);
  }
  console.log(`  seller available ${await bondR.balanceOf(seller.address)}, held ${await bondR.getHeldAmountFor(seller.address)}`);

  // Each dealer paid exactly its own quote, and the seller received the sum.
  const expected = fills.reduce((a, f) => a + BigInt(f.notional), 0n);
  const got = sellerCashAfter - cashBefore.get(seller.address)!;
  const ok = got === expected;
  console.log(`\n  invariant: seller proceeds == sum of each dealer's OWN price -> ${ok ? 'HOLDS' : 'VIOLATED'} (${usd(got)} vs ${usd(expected)})`);
  if (!ok) process.exitCode = 1;

  await engine.markSettled(rfq.id, txHashes.join(','));
  hcs.close();
  console.log(`\n  audit trail  https://hashscan.io/testnet/topic/${env.HCS_TOPIC_ID}\n`);
}

main().catch((e) => {
  console.error('\n  FAILED:', e instanceof Error ? e.message.split('\n')[0] : e);
  process.exit(1);
});
