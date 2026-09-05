// THE FAILURE DEMO - blueprint section 8, 3:00-3:50, and section 11 item 4.
//
// Revoke the buyer's KYC, then run a settlement that is correct in every other
// respect: valid signatures, a live hold, sufficient cash, sufficient allowance.
// It reverts inside ATS's compliance check on the delivery leg, and BOTH ledgers
// are unchanged.
//
// The trade is deliberately sized so the CASH LEG WOULD SUCCEED. settle() moves
// cash at step 4 and delivers at step 5, so the cash transfer really does execute
// before the delivery reverts - and the revert unwinds it. That is the whole
// claim: both legs, or neither.
//
//   npx tsx backend/src/scripts/failure-demo.ts [--leave-revoked]
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';

const RPC = process.env.JSON_RPC_URL ?? 'https://testnet.hashio.io/api';
const PARTITION = '0x0000000000000000000000000000000000000000000000000000000000000001';
const CASH = '0x0000000000000000000000000000000000068cDa';
const QUANTITY = 1n;
const NOTIONAL = 300_000n; // 0.30 USDC - affordable, so the cash leg is NOT the blocker

const BOND_ABI = [
  'function createHoldByPartition(bytes32,(uint256 amount,uint256 expirationTimestamp,address escrow,address to,bytes data)) returns (bool,uint256)',
  'function getHoldForByPartition((bytes32,address,uint256)) view returns (uint256,uint256,address,address,bytes,bytes,uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function grantKyc(address,string,uint256,uint256,address) returns (bool)',
  'function revokeKyc(address) returns (bool)',
  'function getKycStatusFor(address) view returns (uint8)',
];
const CASH_ABI = [
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];
const SETTLE_ABI = [
  'function settle((bytes32 rfqId,address assetToken,bytes32 partition,uint256 holdId,address cashToken,address seller,address buyer,uint256 quantity,uint256 notional,uint256 deadline,uint256 nonce),bytes,bytes) returns (bool)',
  'function nonces(address) view returns (uint256)',
];

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
  const leaveRevoked = process.argv.includes('--leave-revoked');
  const p = new ethers.JsonRpcProvider(RPC);
  const issuer = new ethers.Wallet(env.ISSUER_PRIVATE_KEY, p);
  const seller = new ethers.Wallet(env.SELLER_PRIVATE_KEY, p);
  const buyer = new ethers.Wallet(env.DEALER_PRIVATE_KEY, p);

  const BOND = env.BOND_ADDRESS;
  const SETTLEMENT = env.SETTLEMENT_ADDRESS;
  const bondI = new ethers.Contract(BOND, BOND_ABI, issuer);
  const bondS = new ethers.Contract(BOND, BOND_ABI, seller);
  const bondR = new ethers.Contract(BOND, BOND_ABI, p);
  const cashB = new ethers.Contract(CASH, CASH_ABI, buyer);
  const cashR = new ethers.Contract(CASH, CASH_ABI, p);
  const settleB = new ethers.Contract(SETTLEMENT, SETTLE_ABI, buyer);

  const snapshot = async () => {
    const [sb, bb, sc, bc] = await Promise.all([
      bondR.balanceOf(seller.address), bondR.balanceOf(buyer.address),
      cashR.balanceOf(seller.address), cashR.balanceOf(buyer.address),
    ]);
    return { sb, bb, sc, bc };
  };
  const print = (l: string, s: Awaited<ReturnType<typeof snapshot>>) => {
    console.log(`  ${l}`);
    console.log(`    seller  bond ${String(s.sb).padStart(5)}   cash ${(Number(s.sc) / 1e6).toFixed(6)} USDC`);
    console.log(`    buyer   bond ${String(s.bb).padStart(5)}   cash ${(Number(s.bc) / 1e6).toFixed(6)} USDC`);
  };

  console.log(`\n  bond       ${BOND}`);
  console.log(`  settlement ${SETTLEMENT}\n`);

  // 1) Revoke the buyer's KYC. This is the toggle flipped on camera.
  console.log('  [1] issuer: revokeKyc(buyer)');
  if ((await bondR.getKycStatusFor(buyer.address)) === 1n) {
    const tx = await bondI.revokeKyc(buyer.address, { gasLimit: 1_500_000 });
    await tx.wait();
    console.log(`      tx ${tx.hash}`);
  }
  console.log(`      buyer KYC status: ${(await bondR.getKycStatusFor(buyer.address)) === 1n ? 'GRANTED' : 'NOT_GRANTED'}`);

  // 2) A hold, exactly as in a good trade.
  console.log('\n  [2] seller: createHoldByPartition');
  const expiration = BigInt(Math.floor(Date.now() / 1000) + 48 * 3600);
  const ht = await bondS.createHoldByPartition(
    PARTITION,
    { amount: QUANTITY, expirationTimestamp: expiration, escrow: SETTLEMENT, to: ethers.ZeroAddress, data: '0x' },
    { gasLimit: 3_000_000 }
  );
  await ht.wait();
  let holdId = -1n;
  for (let i = 0n; i < 30n; i++) {
    const [amount, , escrow] = await bondR.getHoldForByPartition([PARTITION, seller.address, i]);
    if (escrow.toLowerCase() === SETTLEMENT.toLowerCase() && amount >= QUANTITY) holdId = i;
  }
  if (holdId < 0n) throw new Error('no hold found');
  console.log(`      holdId ${holdId}, ${QUANTITY} unit escrowed`);

  // 3) Allowance sufficient - the cash leg is NOT the blocker.
  console.log('\n  [3] buyer: approve USDC (sufficient - cash is not the blocker)');
  if ((await cashR.allowance(buyer.address, SETTLEMENT)) < NOTIONAL) {
    const ap = await cashB.approve(SETTLEMENT, NOTIONAL, { gasLimit: 1_000_000 });
    await ap.wait();
  }
  console.log(`      allowance ${(Number(await cashR.allowance(buyer.address, SETTLEMENT)) / 1e6).toFixed(6)} USDC`);
  console.log(`      balance   ${(Number(await cashR.balanceOf(buyer.address)) / 1e6).toFixed(6)} USDC  (need ${(Number(NOTIONAL) / 1e6).toFixed(2)})`);

  const trade = {
    rfqId: ethers.id('sotto-demo-rfq-fail'),
    assetToken: BOND, partition: PARTITION, holdId, cashToken: CASH,
    seller: seller.address, buyer: buyer.address,
    quantity: QUANTITY, notional: NOTIONAL,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    nonce: await settleB.nonces(seller.address),
  };
  const domain = { name: 'Sotto', version: '1', chainId: 296, verifyingContract: SETTLEMENT };
  const types = {
    Trade: [
      { name: 'rfqId', type: 'bytes32' }, { name: 'assetToken', type: 'address' },
      { name: 'partition', type: 'bytes32' }, { name: 'holdId', type: 'uint256' },
      { name: 'cashToken', type: 'address' }, { name: 'seller', type: 'address' },
      { name: 'buyer', type: 'address' }, { name: 'quantity', type: 'uint256' },
      { name: 'notional', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
    ],
  };
  const sellerSig = await seller.signTypedData(domain, types, trade);
  const buyerSig = await buyer.signTypedData(domain, types, trade);
  console.log('\n  [4] both parties sign - signatures are VALID');

  const before = await snapshot();
  console.log('');
  print('BEFORE', before);

  console.log('\n  [5] settle() - expected to REVERT on the compliance check');
  let reverted = false;
  let reason = '';
  try {
    const tx = await settleB.settle(trade, sellerSig, buyerSig, { gasLimit: 4_000_000 });
    const rc = await tx.wait();
    if (rc?.status !== 1) { reverted = true; reason = 'transaction status 0'; }
    else console.log(`      UNEXPECTED SUCCESS ${tx.hash}`);
  } catch (e) {
    reverted = true;
    reason = e instanceof Error ? e.message.split('\n')[0].slice(0, 120) : String(e);
  }
  console.log(`      reverted: ${reverted ? 'YES' : 'NO'}`);
  if (reason) console.log(`      reason:   ${reason}`);

  const after = await snapshot();
  console.log('');
  print('AFTER', after);

  const unchanged =
    before.sb === after.sb && before.bb === after.bb &&
    before.sc === after.sc && before.bc === after.bc;
  console.log(`\n  BOTH LEDGERS UNCHANGED: ${unchanged ? 'YES - nothing moved' : 'NO - SOMETHING MOVED'}`);
  console.log('  Both legs, or neither. This is the difference between a settlement');
  console.log('  system and a token transfer.\n');

  if (!leaveRevoked) {
    const now = Math.floor(Date.now() / 1000);
    const tx = await bondI.grantKyc(buyer.address, 'vc-sotto-dealer', now - 60, now + 365 * 24 * 3600, issuer.address, { gasLimit: 1_500_000 });
    await tx.wait();
    console.log('  [restored] buyer KYC re-granted (pass --leave-revoked to keep it off for filming)\n');
  }

  if (!reverted || !unchanged) process.exit(1);
}

main().catch((e) => {
  console.error('\n  FAILED:', e instanceof Error ? e.message.split('\n')[0] : e);
  process.exit(1);
});
