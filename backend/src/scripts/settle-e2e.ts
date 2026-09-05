// THE DAY-5 GATE: a real atomic DvP on Hedera testnet.
//
//   seller places an ATS hold with escrow = SottoSettlement
//   buyer approves USDC
//   both sign an EIP-712 Trade
//   settle() moves cash and bond in ONE transaction, or neither
//
//   npx tsx backend/src/scripts/settle-e2e.ts
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';

const RPC = process.env.JSON_RPC_URL ?? 'https://testnet.hashio.io/api';
const PARTITION = '0x0000000000000000000000000000000000000000000000000000000000000001';
const CASH = '0x0000000000000000000000000000000000068cDa'; // USDC 0.0.429274 long-zero
const QUANTITY = 20n;          // units, sized to the 20 USDC the faucet gives
const NOTIONAL = 19_670_000n;  // 20 units @ 98.35 of 1 USDC nominal, 6dp

const BOND_ABI = [
  'function createHoldByPartition(bytes32 _partition,(uint256 amount,uint256 expirationTimestamp,address escrow,address to,bytes data) _hold) returns (bool success_, uint256 holdId_)',
  'function getHoldForByPartition((bytes32,address,uint256)) view returns (uint256,uint256,address,address,bytes,bytes,uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function balanceOfByPartition(bytes32,address) view returns (uint256)',
];
const CASH_ABI = [
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];
const SETTLE_ABI = [
  'function settle((bytes32 rfqId,address assetToken,bytes32 partition,uint256 holdId,address cashToken,address seller,address buyer,uint256 quantity,uint256 notional,uint256 deadline,uint256 nonce) t,bytes sellerSig,bytes buyerSig) returns (bool)',
  'function nonces(address) view returns (uint256)',
  'event Settled(bytes32 indexed rfqId,address indexed seller,address indexed buyer,uint256 quantity,uint256 notional,address assetToken,address cashToken)',
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
  const p = new ethers.JsonRpcProvider(RPC);
  const seller = new ethers.Wallet(env.SELLER_PRIVATE_KEY, p);
  const buyer = new ethers.Wallet(env.DEALER_PRIVATE_KEY, p);

  const BOND = env.BOND_ADDRESS;
  const SETTLEMENT = env.SETTLEMENT_ADDRESS;

  const bondS = new ethers.Contract(BOND, BOND_ABI, seller);
  const bondR = new ethers.Contract(BOND, BOND_ABI, p);
  const cashB = new ethers.Contract(CASH, CASH_ABI, buyer);
  const cashR = new ethers.Contract(CASH, CASH_ABI, p);
  const settleB = new ethers.Contract(SETTLEMENT, SETTLE_ABI, buyer);

  const show = async (label: string) => {
    const [sb, bb, sc, bc] = await Promise.all([
      bondR.balanceOf(seller.address), bondR.balanceOf(buyer.address),
      cashR.balanceOf(seller.address), cashR.balanceOf(buyer.address),
    ]);
    console.log(`  ${label}`);
    console.log(`    seller  bond ${String(sb).padStart(5)}   cash ${(Number(sc) / 1e6).toFixed(2)} USDC`);
    console.log(`    buyer   bond ${String(bb).padStart(5)}   cash ${(Number(bc) / 1e6).toFixed(2)} USDC`);
  };

  console.log(`\n  bond       ${BOND}`);
  console.log(`  settlement ${SETTLEMENT}`);
  console.log(`  seller     ${seller.address}`);
  console.log(`  buyer      ${buyer.address}\n`);
  await show('BEFORE');

  // 1) Seller places the hold. escrow = the settlement contract, so only it can
  //    execute. `to` is left zero: the recipient is decided at award.
  const expiration = BigInt(Math.floor(Date.now() / 1000) + 48 * 3600);
  console.log('\n  [1] seller: createHoldByPartition');
  const holdTx = await bondS.createHoldByPartition(
    PARTITION,
    { amount: QUANTITY, expirationTimestamp: expiration, escrow: SETTLEMENT, to: ethers.ZeroAddress, data: '0x' },
    { gasLimit: 3_000_000 }
  );
  await holdTx.wait();
  console.log(`      tx ${holdTx.hash}`);

  // Find the hold id: ids increment per (account, partition), so scan for the
  // one this contract escrows. Reading it back also proves the hold is real.
  let holdId = -1n;
  for (let i = 0n; i < 20n; i++) {
    const [amount, , escrow] = await bondR.getHoldForByPartition([PARTITION, seller.address, i]);
    if (escrow.toLowerCase() === SETTLEMENT.toLowerCase() && amount >= QUANTITY) { holdId = i; break; }
  }
  if (holdId < 0n) throw new Error('could not locate the hold just created');
  console.log(`      holdId ${holdId}, ${QUANTITY} units escrowed to the settlement contract`);

  // 2) Buyer approves the cash leg.
  console.log('\n  [2] buyer: approve USDC');
  const cur: bigint = await cashR.allowance(buyer.address, SETTLEMENT);
  if (cur < NOTIONAL) {
    const ap = await cashB.approve(SETTLEMENT, NOTIONAL, { gasLimit: 1_000_000 });
    await ap.wait();
    console.log(`      tx ${ap.hash}`);
  } else {
    console.log('      allowance already sufficient');
  }

  // 3) Both parties sign the EIP-712 Trade.
  const trade = {
    rfqId: ethers.id('sotto-demo-rfq-1'),
    assetToken: BOND,
    partition: PARTITION,
    holdId,
    cashToken: CASH,
    seller: seller.address,
    buyer: buyer.address,
    quantity: QUANTITY,
    notional: NOTIONAL,
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
  console.log('\n  [3] both parties sign the Trade (EIP-712)');
  const sellerSig = await seller.signTypedData(domain, types, trade);
  const buyerSig = await buyer.signTypedData(domain, types, trade);
  console.log(`      seller sig ${sellerSig.slice(0, 20)}...`);
  console.log(`      buyer  sig ${buyerSig.slice(0, 20)}...`);

  // 4) Settle. Cash and bond move in ONE transaction, or neither does.
  console.log('\n  [4] settle()');
  const tx = await settleB.settle(trade, sellerSig, buyerSig, { gasLimit: 4_000_000 });
  const rc = await tx.wait();
  console.log(`      tx ${tx.hash}`);
  console.log(`      status ${rc?.status === 1 ? 'SUCCESS' : 'FAILED'}  gas ${rc?.gasUsed}`);
  console.log(`      hashscan https://hashscan.io/testnet/transaction/${tx.hash}`);

  console.log('');
  await show('AFTER');
  console.log('');
}

main().catch((e) => {
  console.error('\n  FAILED:', e instanceof Error ? e.message.split('\n')[0] : e);
  process.exit(1);
});
