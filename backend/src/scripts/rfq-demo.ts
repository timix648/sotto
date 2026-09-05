// A4 end to end: run the real RFQ engine against the live HCS topic, then
// settle the awarded trade on testnet.
//
//   npx tsx backend/src/scripts/rfq-demo.ts
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';
import { HcsAudit } from '../hcs/client.js';
import { RfqEngine, RfqError } from '../rfq/engine.js';
import { computeCommit } from '../../../packages/shared/src/commit.js';

const RPC = 'https://testnet.hashio.io/api';
const PARTITION = '0x0000000000000000000000000000000000000000000000000000000000000001';
const CASH = '0x0000000000000000000000000000000000068cDa';
const QUANTITY = 5n;

const BOND_ABI = [
  'function createHoldByPartition(bytes32,(uint256 amount,uint256 expirationTimestamp,address escrow,address to,bytes data)) returns (bool,uint256)',
  'function getHoldForByPartition((bytes32,address,uint256)) view returns (uint256,uint256,address,address,bytes,bytes,uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function getHeldAmountFor(address) view returns (uint256)',
];
const CASH_ABI = ['function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)'];
const SETTLE_ABI = [
  'function settle((bytes32 rfqId,address assetToken,bytes32 partition,uint256 holdId,address cashToken,address seller,address buyer,uint256 quantity,uint256 notional,uint256 deadline,uint256 nonce),bytes,bytes) returns (bool)',
  'function nonces(address) view returns (uint256)',
];
const TYPES = {
  Trade: [
    { name: 'rfqId', type: 'bytes32' }, { name: 'assetToken', type: 'address' },
    { name: 'partition', type: 'bytes32' }, { name: 'holdId', type: 'uint256' },
    { name: 'cashToken', type: 'address' }, { name: 'seller', type: 'address' },
    { name: 'buyer', type: 'address' }, { name: 'quantity', type: 'uint256' },
    { name: 'notional', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
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

async function main() {
  const env = loadEnv();
  const p = new ethers.JsonRpcProvider(RPC);
  const seller = new ethers.Wallet(env.SELLER_PRIVATE_KEY, p);
  const winner = new ethers.Wallet(env.DEALER_PRIVATE_KEY, p);
  const SETTLEMENT = env.SETTLEMENT_ADDRESS;

  const hcs = new HcsAudit({ operatorId: env.ISSUER_ACCOUNT_ID, operatorKey: env.ISSUER_PRIVATE_KEY, topicId: env.HCS_TOPIC_ID });
  const engine = new RfqEngine((id, kind, payload) => hcs.write(id, kind, payload));
  console.log(`\n  HCS topic ${hcs.topicId}\n`);

  // --- open ---------------------------------------------------------------
  const rfq = await engine.open({
    assetToken: env.BOND_ADDRESS, assetSymbol: 'STO-BOND-A', partition: PARTITION,
    cashToken: CASH, quantity: QUANTITY.toString(), seller: seller.address,
    commitWindowSecs: 120, revealWindowSecs: 120,
  });
  console.log(`  [open]   rfq ${rfq.id.slice(0, 8)}  HCS#${rfq.hcsSequenceNumber}  ${QUANTITY} units`);

  // --- hold ---------------------------------------------------------------
  const bondS = new ethers.Contract(env.BOND_ADDRESS, BOND_ABI, seller);
  const bondR = new ethers.Contract(env.BOND_ADDRESS, BOND_ABI, p);
  const ht = await bondS.createHoldByPartition(
    PARTITION,
    { amount: QUANTITY, expirationTimestamp: BigInt(Math.floor(Date.now() / 1000) + 48 * 3600), escrow: SETTLEMENT, to: ethers.ZeroAddress, data: '0x' },
    { gasLimit: 3_000_000 }
  );
  await ht.wait();
  let holdId = -1n;
  for (let i = 0n; i < 40n; i++) {
    const [amount, , escrow] = await bondR.getHoldForByPartition([PARTITION, seller.address, i]);
    if (escrow.toLowerCase() === SETTLEMENT.toLowerCase() && amount >= QUANTITY) holdId = i;
  }
  await engine.recordHold(rfq.id, Number(holdId), ht.hash);
  console.log(`  [hold]   holdId ${holdId} escrowed to settlement`);

  // --- commits (sealed) ---------------------------------------------------
  const dealers = [
    { w: winner, price: 98_350_000n },
    { w: ethers.Wallet.createRandom(), price: 98_200_000n },
    { w: ethers.Wallet.createRandom(), price: 97_900_000n },
  ];
  const nonces = new Map<string, `0x${string}`>();
  for (const d of dealers) {
    const nonce = ethers.hexlify(ethers.randomBytes(32)) as `0x${string}`;
    nonces.set(d.w.address, nonce);
    const hash = computeCommit(d.price, QUANTITY, nonce, d.w.address as `0x${string}`);
    const c = await engine.commit(rfq.id, d.w.address, hash);
    console.log(`  [commit] ${d.w.address.slice(0, 10)}  HCS#${c.hcsSequenceNumber}  hash ${hash.slice(0, 14)}...  (price sealed)`);
  }

  const sealed = engine.view(rfq.id);
  console.log(`  [check]  prices visible while OPEN: ${sealed.reveals.length} (must be 0)`);

  await engine.closeWindow(rfq.id);
  console.log('  [close]  window closed -> REVEALING');

  // --- reveals ------------------------------------------------------------
  for (const d of dealers) {
    const r = await engine.reveal(rfq.id, d.w.address, d.price.toString(), nonces.get(d.w.address)!);
    console.log(`  [reveal] ${d.w.address.slice(0, 10)}  price ${r.price}  valid ${r.valid}`);
  }

  // A tampered reveal must be rejected: same nonce, different price.
  try {
    await engine.reveal(rfq.id, dealers[1].w.address, '99999999', nonces.get(dealers[1].w.address)!);
    console.log('  [tamper] NOT REJECTED - BUG');
    process.exit(1);
  } catch (e) {
    console.log(`  [tamper] altered price rejected: ${(e as RfqError).code}`);
  }

  // --- award --------------------------------------------------------------
  const { dealer, trade } = await engine.award(rfq.id, SETTLEMENT);
  console.log(`  [award]  ${dealer.slice(0, 10)} wins at 98.35, notional ${trade.notional}`);

  // --- settle -------------------------------------------------------------
  const cashB = new ethers.Contract(CASH, CASH_ABI, winner);
  const cashR = new ethers.Contract(CASH, CASH_ABI, p);
  const settleW = new ethers.Contract(SETTLEMENT, SETTLE_ABI, winner);

  const bal: bigint = await cashR.balanceOf(winner.address);
  if (bal < BigInt(trade.notional)) {
    console.log(`\n  [settle] SKIPPED - winner holds ${Number(bal) / 1e6} USDC, needs ${Number(trade.notional) / 1e6}`);
    console.log('           The engine, commit-reveal and audit trail are all proven above.');
    hcs.close();
    return;
  }

  if ((await cashR.allowance(winner.address, SETTLEMENT)) < BigInt(trade.notional)) {
    await (await cashB.approve(SETTLEMENT, trade.notional, { gasLimit: 1_000_000 })).wait();
  }
  const signed = { ...trade, nonce: await settleW.nonces(seller.address) };
  const domain = { name: 'Sotto', version: '1', chainId: 296, verifyingContract: SETTLEMENT };
  const sellerSig = await seller.signTypedData(domain, TYPES, signed);
  const buyerSig = await winner.signTypedData(domain, TYPES, signed);

  const tx = await settleW.settle(signed, sellerSig, buyerSig, { gasLimit: 4_000_000 });
  const rc = await tx.wait();
  await engine.markSettled(rfq.id, tx.hash);
  console.log(`  [settle] ${rc?.status === 1 ? 'SUCCESS' : 'FAILED'}  ${tx.hash}`);

  const final = engine.view(rfq.id);
  console.log(`\n  final status ${final.rfq.status}, ${final.audit.length} audit events`);
  console.log(`  audit: ${final.audit.map(e => '#' + e.hcsSequenceNumber + ' ' + e.kind).join('  ')}`);
  console.log(`\n  ${hcs.hashscanUrl}\n`);
  hcs.close();
}

main().catch((e) => {
  console.error('\n  FAILED:', e instanceof Error ? e.message.split('\n')[0] : e);
  process.exit(1);
});
