// NAV BAND GUARD, on testnet.
//
// A commit-reveal auction stops a dealer last-looking off a rival's price. It
// does NOT stop a seller awarding themselves a deliberately bad price through a
// colluding dealer - the auction was "fair", the price was not.
//
// The band makes that non-executable. Enforced ON-CHAIN in settle(), not in our
// backend: a venue that only checks its own arithmetic is asking to be trusted.
//
//   npx tsx backend/src/scripts/oracle-demo.ts
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';

const RPC = 'https://testnet.hashio.io/api';
const PARTITION = '0x0000000000000000000000000000000000000000000000000000000000000001';
const CASH = '0x0000000000000000000000000000000000068cDa';
const QTY = 5n;
const FAIR = 98_350_000n;       // on NAV
const MANIPULATED = 80_000_000n; // ~18.7% below NAV, far outside a 5% band

const SEC_ABI = [
  'function createHoldByPartition(bytes32,(uint256 amount,uint256 expirationTimestamp,address escrow,address to,bytes data)) returns (bool,uint256)',
  'function getHoldForByPartition((bytes32,address,uint256)) view returns (uint256,uint256,address,address,bytes,bytes,uint8)',
  'function balanceOf(address) view returns (uint256)',
];
const CASH_ABI = ['function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)'];
const SETTLE_ABI = [
  'function settle((bytes32 rfqId,address assetToken,bytes32 partition,uint256 holdId,address cashToken,address seller,address buyer,uint256 quantity,uint256 notional,uint256 deadline,uint256 nonce),bytes,bytes) returns (bool)',
  'function nonces(address) view returns (uint256)',
  'function navOracle() view returns (address)',
  'function bandBps() view returns (uint16)',
];
const ORACLE_ABI = [
  'function referenceFor(address) view returns (uint256,uint64,uint8)',
  'function withinBand(address,uint256,uint16) view returns (bool)',
  'function isFresh(address) view returns (bool)',
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
  const buyer = new ethers.Wallet(env.DEALER_PRIVATE_KEY, p);
  const SETTLEMENT = env.SETTLEMENT_ADDRESS;
  const BOND = env.BOND_ADDRESS;

  const bondS = new ethers.Contract(BOND, SEC_ABI, seller);
  const bondR = new ethers.Contract(BOND, SEC_ABI, p);
  const cashB = new ethers.Contract(CASH, CASH_ABI, buyer);
  const cashR = new ethers.Contract(CASH, CASH_ABI, p);
  const settleB = new ethers.Contract(SETTLEMENT, SETTLE_ABI, buyer);
  const oracle = new ethers.Contract(env.NAV_ORACLE_ADDRESS, ORACLE_ABI, p);

  const [ref, updatedAt] = await oracle.referenceFor(BOND);
  const band: bigint = await settleB.bandBps();
  console.log(`\n  settlement ${SETTLEMENT}`);
  console.log(`  oracle     ${await settleB.navOracle()}`);
  console.log(`  reference NAV  ${Number(ref) / 1e6} per 100 nominal`);
  console.log(`  published at   ${new Date(Number(updatedAt) * 1000).toISOString()}  fresh: ${await oracle.isFresh(BOND)}`);
  console.log(`  band           ${Number(band) / 100}%\n`);

  // One hold, reused for both attempts.
  console.log('  [1] seller: place a hold against the guarded settlement');
  const ht = await bondS.createHoldByPartition(
    PARTITION,
    { amount: QTY * 2n, expirationTimestamp: BigInt(Math.floor(Date.now() / 1000) + 48 * 3600), escrow: SETTLEMENT, to: ethers.ZeroAddress, data: '0x' },
    { gasLimit: 3_000_000 }
  );
  await ht.wait();
  let holdId = -1n;
  for (let i = 0n; i < 90n; i++) {
    const [amount, , escrow] = await bondR.getHoldForByPartition([PARTITION, seller.address, i]);
    if (String(escrow).toLowerCase() === SETTLEMENT.toLowerCase() && (amount as bigint) >= QTY) holdId = i;
  }
  console.log(`      holdId ${holdId}`);

  const domain = { name: 'Sotto', version: '1', chainId: 296, verifyingContract: SETTLEMENT };
  const build = async (price: bigint) => {
    const notional = (price * QTY) / 100n;
    const trade = {
      rfqId: ethers.id('sotto-band-' + price.toString()),
      assetToken: BOND, partition: PARTITION, holdId, cashToken: CASH,
      seller: seller.address, buyer: buyer.address,
      quantity: QTY, notional,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      nonce: await settleB.nonces(seller.address),
    };
    return {
      trade,
      sellerSig: await seller.signTypedData(domain, TYPES, trade),
      buyerSig: await buyer.signTypedData(domain, TYPES, trade),
    };
  };

  const bal = async () => ({
    sc: (await cashR.balanceOf(seller.address)) as bigint,
    bb: (await bondR.balanceOf(buyer.address)) as bigint,
  });

  // --- attempt 1: manipulated price, must be refused -----------------------
  console.log(`\n  [2] MANIPULATED: award at ${Number(MANIPULATED) / 1e6} vs NAV ${Number(ref) / 1e6}`);
  const inBandCheck = await oracle.withinBand(BOND, MANIPULATED, band);
  console.log(`      oracle.withinBand -> ${inBandCheck}`);
  const before = await bal();
  const m = await build(MANIPULATED);
  await (await cashB.approve(SETTLEMENT, m.trade.notional, { gasLimit: 1_000_000 })).wait();
  let refused = false;
  try {
    const tx = await settleB.settle(m.trade, m.sellerSig, m.buyerSig, { gasLimit: 4_000_000 });
    const rc = await tx.wait();
    if (rc?.status !== 1) refused = true;
    else console.log('      UNEXPECTED SUCCESS - band did not hold');
  } catch { refused = true; }
  const afterBad = await bal();
  console.log(`      settle() refused: ${refused ? 'YES' : 'NO'}`);
  console.log(`      seller cash unchanged: ${before.sc === afterBad.sc}   buyer bond unchanged: ${before.bb === afterBad.bb}`);

  // --- attempt 2: fair price, must settle ----------------------------------
  console.log(`\n  [3] FAIR: award at ${Number(FAIR) / 1e6}, on NAV`);
  const f = await build(FAIR);
  await (await cashB.approve(SETTLEMENT, f.trade.notional, { gasLimit: 1_000_000 })).wait();
  const tx = await settleB.settle(f.trade, f.sellerSig, f.buyerSig, { gasLimit: 4_000_000 });
  const rc = await tx.wait();
  console.log(`      settle() ${rc?.status === 1 ? 'SUCCESS' : 'FAILED'}  ${tx.hash}`);
  console.log(`      hashscan https://hashscan.io/testnet/transaction/${tx.hash}`);

  const end = await bal();
  console.log(`\n  seller cash ${(Number(before.sc) / 1e6).toFixed(4)} -> ${(Number(end.sc) / 1e6).toFixed(4)} USDC`);
  console.log(`  buyer bond  ${before.bb} -> ${end.bb}`);
  console.log('\n  Same auction, same signatures, same hold. The only difference was the');
  console.log('  price - and the chain refused the one that was off-market.\n');

  if (!refused) process.exit(1);
}

main().catch((e) => {
  console.error('\n  FAILED:', e instanceof Error ? e.message.split('\n')[0].slice(0, 180) : e);
  process.exit(1);
});
