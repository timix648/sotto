// Reveal-or-forfeit bonding, on testnet.
//
// Act 1: a dealer commits with a bond, reveals honestly, gets it back.
// Act 2: a dealer commits with a bond, vanishes, and the SELLER slashes it -
//        without the venue's involvement.
//
//   npx hardhat compile && npx tsx backend/src/scripts/bond-demo.ts
import { ethers } from 'ethers';
import { readFileSync, writeFileSync } from 'node:fs';

const RPC = 'https://testnet.hashio.io/api';
const CASH = '0x0000000000000000000000000000000000068cDa';
const QUANTITY = 250n;
const MIN_BOND = 2_000_000n;   // 2 USDC
const PRICE = 98_350_000n;
const WINDOW = 50;             // seconds

const CASH_ABI = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'];

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}
function upsertEnv(key: string, value: string) {
  let env = readFileSync('.env', 'utf8');
  env = new RegExp(`^${key}=`, 'm').test(env)
    ? env.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`)
    : env.replace(/\n*$/, '\n') + `${key}=${value}\n`;
  writeFileSync('.env', env, { mode: 0o600 });
}

/** Identical to packages/shared/src/commit.ts and to the contract. */
const commitOf = (price: bigint, qty: bigint, nonce: string, dealer: string) =>
  ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['uint256', 'uint256', 'bytes32', 'address'], [price, qty, nonce, dealer]));

async function main() {
  const env = loadEnv();
  const p = new ethers.JsonRpcProvider(RPC);
  const venue = new ethers.Wallet(env.ISSUER_PRIVATE_KEY, p);
  const seller = new ethers.Wallet(env.SELLER_PRIVATE_KEY, p);
  const dealer = new ethers.Wallet(env.DEALER_PRIVATE_KEY, p);

  const art = JSON.parse(readFileSync('artifacts/contracts/SottoDealerBond.sol/SottoDealerBond.json', 'utf8'));

  let addr = env.DEALER_BOND_ADDRESS;
  if (!addr) {
    const c = await new ethers.ContractFactory(art.abi, art.bytecode, venue).deploy(venue.address, CASH, { gasLimit: 5_000_000 });
    await c.waitForDeployment();
    addr = await c.getAddress();
    upsertEnv('DEALER_BOND_ADDRESS', addr);
    console.log(`\n  SottoDealerBond deployed ${addr}`);
  } else {
    console.log(`\n  SottoDealerBond ${addr}`);
  }
  console.log(`  hashscan https://hashscan.io/testnet/contract/${addr}`);
  console.log(`  bond token: real USDC ${CASH}\n`);

  const bondV = new ethers.Contract(addr, art.abi, venue);
  const bondD = new ethers.Contract(addr, art.abi, dealer);
  const bondS = new ethers.Contract(addr, art.abi, seller);
  const cashD = new ethers.Contract(CASH, CASH_ABI, dealer);
  const cashR = new ethers.Contract(CASH, CASH_ABI, p);

  const usd = (v: bigint) => (Number(v) / 1e6).toFixed(4);

  if ((await cashR.allowance(dealer.address, addr)) < MIN_BOND * 4n) {
    await (await cashD.approve(addr, MIN_BOND * 10n, { gasLimit: 1_000_000 })).wait();
  }

  // ---------------------------------------------------------------- ACT 1
  console.log('  ACT 1 - honest dealer: commit with a bond, reveal, get it back');
  const rfq1 = ethers.id('sotto-bond-honest-' + Date.now());
  const deadline1 = BigInt(Math.floor(Date.now() / 1000) + 600);
  await (await bondV.openAuction(rfq1, seller.address, QUANTITY, deadline1, MIN_BOND, { gasLimit: 1_000_000 })).wait();

  const n1 = ethers.hexlify(ethers.randomBytes(32));
  const before1 = await cashR.balanceOf(dealer.address);
  await (await bondD.postBond(rfq1, commitOf(PRICE, QUANTITY, n1, dealer.address), MIN_BOND, { gasLimit: 2_000_000 })).wait();
  console.log(`    posted   dealer cash ${usd(before1)} -> ${usd(await cashR.balanceOf(dealer.address))} USDC`);

  await (await bondD.revealAndRelease(rfq1, PRICE, QUANTITY, n1, { gasLimit: 2_000_000 })).wait();
  const after1 = await cashR.balanceOf(dealer.address);
  console.log(`    revealed dealer cash -> ${usd(after1)} USDC   returned: ${after1 === before1}`);

  // ---------------------------------------------------------------- ACT 2
  console.log('\n  ACT 2 - dealer vanishes: bond is slashed TO THE SELLER');
  const rfq2 = ethers.id('sotto-bond-vanish-' + Date.now());
  const deadline2 = BigInt(Math.floor(Date.now() / 1000) + WINDOW);
  await (await bondV.openAuction(rfq2, seller.address, QUANTITY, deadline2, MIN_BOND, { gasLimit: 1_000_000 })).wait();

  const n2 = ethers.hexlify(ethers.randomBytes(32));
  const sellerBefore = await cashR.balanceOf(seller.address);
  const venueBefore = await cashR.balanceOf(venue.address);
  await (await bondD.postBond(rfq2, commitOf(PRICE, QUANTITY, n2, dealer.address), MIN_BOND, { gasLimit: 2_000_000 })).wait();
  console.log(`    posted   ${usd(MIN_BOND)} USDC bonded, reveal window ${WINDOW}s`);
  console.log('    ...dealer never reveals');

  // Wait out the window, then slash.
  for (;;) {
    const now = Math.floor(Date.now() / 1000);
    if (BigInt(now) > deadline2) break;
    await new Promise(r => setTimeout(r, 5000));
  }

  // Called by the SELLER, not the venue - slashing is permissionless.
  console.log('    reveal window closed; the SELLER calls slash (no venue involvement)');
  const tx = await bondS.slash(rfq2, dealer.address, { gasLimit: 2_000_000 });
  await tx.wait();

  const sellerAfter = await cashR.balanceOf(seller.address);
  const venueAfter = await cashR.balanceOf(venue.address);
  console.log(`    slashed  ${tx.hash}`);
  console.log(`\n    seller cash ${usd(sellerBefore)} -> ${usd(sellerAfter)} USDC   (+${usd(sellerAfter - sellerBefore)})`);
  console.log(`    venue  cash ${usd(venueBefore)} -> ${usd(venueAfter)} USDC   (venue gains nothing)`);

  const ok = sellerAfter - sellerBefore === MIN_BOND && venueAfter === venueBefore;
  console.log(`\n  A junk commit now costs the dealer real money, and the money goes to`);
  console.log(`  the party it wasted - not to us. Spamming the book is no longer free.\n`);
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error('\n  FAILED:', e instanceof Error ? e.message.split('\n')[0].slice(0, 180) : e);
  process.exit(1);
});
