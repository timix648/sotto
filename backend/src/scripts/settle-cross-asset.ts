// SECURITY-FOR-SECURITY SETTLEMENT: a bond block paid for in equity.
//
// No stablecoin in the middle. The seller delivers bonds out of an ATS hold; the
// buyer pays in shares of a different ATS security. BOTH legs are compliance-
// checked by their own token at transfer time.
//
// The point: SottoSettlement is UNCHANGED. It never assumed one side was cash -
// `cashToken` is just an address, so any ERC-20-facing token works, including
// another ATS security. One code path, no per-asset branch. That is what turns
// "an RFQ for one bond" into secondary-market infrastructure for tokenised
// securities, which is what the track asks for ("real asset classes").
//
//   npx tsx backend/src/scripts/settle-cross-asset.ts
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';

const RPC = 'https://testnet.hashio.io/api';
const PARTITION = '0x0000000000000000000000000000000000000000000000000000000000000001';
const BOND_QTY = 10n;    // bonds the seller delivers
const EQUITY_PRICE = 12n; // shares the buyer pays

const SEC_ABI = [
  'function createHoldByPartition(bytes32,(uint256 amount,uint256 expirationTimestamp,address escrow,address to,bytes data)) returns (bool,uint256)',
  'function getHoldForByPartition((bytes32,address,uint256)) view returns (uint256,uint256,address,address,bytes,bytes,uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function issueByPartition((bytes32 partition,address tokenHolder,uint256 value,bytes data))',
  'function symbol() view returns (string)',
];
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
  const issuer = new ethers.Wallet(env.ISSUER_PRIVATE_KEY, p);
  const seller = new ethers.Wallet(env.SELLER_PRIVATE_KEY, p);
  const buyer = new ethers.Wallet(env.DEALER_PRIVATE_KEY, p);
  const SETTLEMENT = env.SETTLEMENT_ADDRESS;
  const BOND = env.BOND_ADDRESS;
  const EQUITY = env.EQUITY_ADDRESS;

  const bondR = new ethers.Contract(BOND, SEC_ABI, p);
  const bondS = new ethers.Contract(BOND, SEC_ABI, seller);
  const eqR = new ethers.Contract(EQUITY, SEC_ABI, p);
  const eqI = new ethers.Contract(EQUITY, SEC_ABI, issuer);
  const eqB = new ethers.Contract(EQUITY, SEC_ABI, buyer);
  const settleB = new ethers.Contract(SETTLEMENT, SETTLE_ABI, buyer);

  const snap = async (label: string) => {
    const [sb, bb, se, be] = await Promise.all([
      bondR.balanceOf(seller.address), bondR.balanceOf(buyer.address),
      eqR.balanceOf(seller.address), eqR.balanceOf(buyer.address),
    ]);
    console.log(`  ${label}`);
    console.log(`    seller  STO-BOND-A ${String(sb).padStart(5)}   STO-EQ-A ${String(se).padStart(5)}`);
    console.log(`    buyer   STO-BOND-A ${String(bb).padStart(5)}   STO-EQ-A ${String(be).padStart(5)}`);
  };

  console.log(`\n  bond    ${BOND}  (STO-BOND-A)`);
  console.log(`  equity  ${EQUITY}  (STO-EQ-A)`);
  console.log(`  NO STABLECOIN IN THIS TRADE\n`);

  // The buyer needs shares to pay with. Both parties are institutions holding
  // portfolios, so issue the dealer a position in the equity.
  const buyerEq: bigint = await eqR.balanceOf(buyer.address);
  if (buyerEq < EQUITY_PRICE) {
    console.log(`  [0] issuer: issue ${EQUITY_PRICE * 5n} STO-EQ-A -> buyer (it must hold shares to pay with)`);
    const tx = await eqI.issueByPartition(
      { partition: PARTITION, tokenHolder: buyer.address, value: EQUITY_PRICE * 5n, data: '0x' },
      { gasLimit: 3_000_000 }
    );
    await tx.wait();
  }

  await snap('BEFORE');

  // 1) Seller escrows the bond block.
  console.log(`\n  [1] seller: hold ${BOND_QTY} STO-BOND-A, escrow = settlement`);
  const ht = await bondS.createHoldByPartition(
    PARTITION,
    { amount: BOND_QTY, expirationTimestamp: BigInt(Math.floor(Date.now() / 1000) + 48 * 3600), escrow: SETTLEMENT, to: ethers.ZeroAddress, data: '0x' },
    { gasLimit: 3_000_000 }
  );
  await ht.wait();
  let holdId = -1n;
  for (let i = 0n; i < 80n; i++) {
    const [amount, , escrow] = await bondR.getHoldForByPartition([PARTITION, seller.address, i]);
    if (String(escrow).toLowerCase() === SETTLEMENT.toLowerCase() && (amount as bigint) >= BOND_QTY) holdId = i;
  }
  console.log(`      holdId ${holdId}`);

  // 2) Buyer approves the EQUITY as the payment leg.
  console.log(`\n  [2] buyer: approve ${EQUITY_PRICE} STO-EQ-A to the settlement contract`);
  if ((await eqR.allowance(buyer.address, SETTLEMENT)) < EQUITY_PRICE) {
    await (await eqB.approve(SETTLEMENT, EQUITY_PRICE, { gasLimit: 1_500_000 })).wait();
  }
  console.log(`      allowance ${await eqR.allowance(buyer.address, SETTLEMENT)} STO-EQ-A`);

  // 3) Sign. cashToken is the EQUITY - the contract never cared what it was.
  const trade = {
    rfqId: ethers.id('sotto-cross-asset-1'),
    assetToken: BOND,
    partition: PARTITION,
    holdId,
    cashToken: EQUITY,        // <- a second ATS security, not a stablecoin
    seller: seller.address,
    buyer: buyer.address,
    quantity: BOND_QTY,
    notional: EQUITY_PRICE,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    nonce: await settleB.nonces(seller.address),
  };
  const domain = { name: 'Sotto', version: '1', chainId: 296, verifyingContract: SETTLEMENT };
  const sellerSig = await seller.signTypedData(domain, TYPES, trade);
  const buyerSig = await buyer.signTypedData(domain, TYPES, trade);
  console.log('\n  [3] both parties sign the Trade');

  // 4) Settle. Same function, same contract, no per-asset branch.
  console.log('\n  [4] settle() - unchanged contract, security for security');
  const tx = await settleB.settle(trade, sellerSig, buyerSig, { gasLimit: 4_000_000 });
  const rc = await tx.wait();
  console.log(`      status ${rc?.status === 1 ? 'SUCCESS' : 'FAILED'}  gas ${rc?.gasUsed}`);
  console.log(`      hashscan https://hashscan.io/testnet/transaction/${tx.hash}`);

  console.log('');
  await snap('AFTER');
  console.log(`\n  ${BOND_QTY} bonds moved seller -> buyer, ${EQUITY_PRICE} shares moved buyer -> seller,`);
  console.log('  in one transaction, with both tokens enforcing their own compliance.');
  console.log('  Any ATS security for any other. No stablecoin required.\n');
}

main().catch((e) => {
  console.error('\n  FAILED:', e instanceof Error ? e.message.split('\n')[0].slice(0, 180) : e);
  process.exit(1);
});
