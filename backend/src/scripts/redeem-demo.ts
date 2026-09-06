// Redemption at maturity - the last leg of the bond lifecycle.
//
// The track brief asks for "bonds with a lifecycle including issuance, coupon
// payments, and redemption at maturity, all on-chain." Issuance is seed.ts,
// coupons are bond-demo.ts and SottoCouponScheduler; this is the third.
//
//   npx tsx backend/src/scripts/redeem-demo.ts                 # redeem now
//   npx tsx backend/src/scripts/redeem-demo.ts --extend 900    # push maturity, then run
//   npx tsx backend/src/scripts/redeem-demo.ts --extend 900 --stop-after-extend
//
// Two things are worth watching.
//
// 1) Maturity is a HARD on-chain gate, not a UI convention. ATS guards
//    fullRedeemAtMaturity with onlyAfterCurrentMaturityDate(_blockTimestamp()),
//    so this script tries the redemption BEFORE maturity first and shows the
//    revert. A venue that only checked maturity in its own backend would have
//    redeemed early here.
//
// 2) Maturity can only ever move FORWARD - updateMaturityDate carries the same
//    modifier against the NEW date. An issuer can extend a bond; it can never
//    pull one in. That is why the demo runs against a short-dated note
//    (STO-BOND-M) rather than the 2030 senior note: a 2030 bond cannot be
//    matured early by anybody, including us.
//
// The cash leg is deliberately separate. ATS burns the units; it does not move
// money. Nominal value x units, in the bond's own currency, is an ordinary
// USDC transfer from issuer to holder, and it goes FIRST - a holder who is not
// paid still holds their claim.
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';
import { HcsAudit } from '../hcs/client.js';

const RPC = process.env.JSON_RPC_URL ?? 'https://testnet.hashio.io/api';
const PARTITION = '0x0000000000000000000000000000000000000000000000000000000000000001';

// ATS v3.1.0 (ad8f601) role hashes - the version DEPLOYED at 0.0.7708430.
// Repo HEAD hashes the same role names to different values. See docs/ATS-SPIKE.md.
const ROLE_MATURITY_REDEEMER = '0xa0d696902e9ed231892dc96649f0c62b808a1cb9dd1269e78e0adc1cc4b8358c';
const ROLE_BOND_MANAGER = '0x8e99f55d84328dd46dd7790df91f368b44ea448d246199c88b97896b3f83f65d';

const BOND_ABI = [
  'function hasRole(bytes32,address) view returns (bool)',
  'function grantRole(bytes32,address)',
  'function getBondDetails() view returns ((bytes3 currency,uint256 nominalValue,uint8 nominalValueDecimals,uint256 startingDate,uint256 maturityDate))',
  'function getPrincipalFor(address) view returns ((uint256 numerator,uint256 denominator))',
  'function updateMaturityDate(uint256) returns (bool)',
  'function fullRedeemAtMaturity(address)',
  'function balanceOf(address) view returns (uint256)',
  'function balanceOfByPartition(bytes32,address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function symbol() view returns (string)',
  'function getKycStatusFor(address) view returns (uint8)',
  'event RedeemedByPartition(bytes32 indexed partition,address indexed operator,address indexed from,uint256 value,bytes data,bytes operatorData)',
  'error BondMaturityDateWrong()',
];
const USDC_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address,uint256) returns (bool)',
  'function decimals() view returns (uint8)',
];

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const flag = (name: string) => process.argv.includes(name);
function numFlag(name: string): number | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : null;
}
const iso = (s: number | bigint) => new Date(Number(s) * 1000).toISOString().replace('.000Z', 'Z');
const usd = (v: bigint) => (Number(v) / 1e6).toFixed(6);

async function ensureRole(bond: ethers.Contract, hash: string, who: string, label: string) {
  if (await bond.hasRole(hash, who)) {
    console.log(`  role   ${label.padEnd(18)} already held`);
    return;
  }
  const tx = await bond.grantRole(hash, who, { gasLimit: 1_000_000 });
  await tx.wait();
  console.log(`  role   ${label.padEnd(18)} granted`);
}

async function main() {
  const env = loadEnv();
  const provider = new ethers.JsonRpcProvider(RPC);
  const issuer = new ethers.Wallet(env.ISSUER_PRIVATE_KEY, provider);

  const argAddr = process.argv.find(a => a.startsWith('0x') && a.length === 42);
  const token = argAddr ?? env.SHORT_BOND_ADDRESS ?? env.BOND_ADDRESS;
  const holder = env.SELLER_ADDRESS;

  const bond = new ethers.Contract(token, BOND_ABI, issuer);
  const usdc = new ethers.Contract(
    env.USDC_EVM_ADDRESS ?? '0x0000000000000000000000000000000000068cDa',
    USDC_ABI,
    issuer
  );

  console.log(`\n  bond    ${token}  ${await bond.symbol()}`);
  console.log(`  issuer  ${issuer.address}`);
  console.log(`  holder  ${holder}\n`);

  // 0) Roles. The issuance rbacs array used HEAD's role hashes, none of which
  //    the deployed contract checks, so both of these have to be granted here.
  await ensureRole(bond, ROLE_BOND_MANAGER, issuer.address, 'BOND_MANAGER');
  await ensureRole(bond, ROLE_MATURITY_REDEEMER, issuer.address, 'MATURITY_REDEEMER');

  // 1) Optionally push maturity forward. Only forward: updateMaturityDate is
  //    itself guarded by onlyAfterCurrentMaturityDate(_newMaturityDate).
  const extend = numFlag('--extend');
  if (extend !== null) {
    const target = Math.floor(Date.now() / 1000) + extend;
    const tx = await bond.updateMaturityDate(target, { gasLimit: 1_000_000 });
    const r = await tx.wait();
    console.log(`\n  maturity moved to ${iso(target)}  ${r?.status === 1 ? 'SUCCESS' : 'FAILED'}`);
    console.log(`  https://hashscan.io/testnet/transaction/${tx.hash}`);
    if (flag('--stop-after-extend')) {
      console.log('');
      return;
    }
  }

  const details = await bond.getBondDetails();
  const maturity = Number(details.maturityDate);
  const nominal: bigint = details.nominalValue;
  const currency = Buffer.from(details.currency.slice(2), 'hex').toString('utf8');

  const unitsBefore: bigint = await bond.balanceOfByPartition(PARTITION, holder);
  const supplyBefore: bigint = await bond.totalSupply();
  const cashHolderBefore: bigint = await usdc.balanceOf(holder);
  const cashIssuerBefore: bigint = await usdc.balanceOf(issuer.address);
  const principal = await bond.getPrincipalFor(holder);

  console.log('\n  --- before ---');
  console.log(`  currency / nominal   ${currency} ${usd(nominal)} per unit`);
  console.log(`  maturity             ${iso(maturity)}`);
  console.log(`  holder units         ${unitsBefore}`);
  console.log(`  totalSupply          ${supplyBefore}`);
  console.log(`  getPrincipalFor      ${principal.numerator} / ${principal.denominator}`);
  console.log(`  holder cash          ${usd(cashHolderBefore)} USDC`);
  console.log(`  issuer cash          ${usd(cashIssuerBefore)} USDC`);

  if (unitsBefore === 0n) {
    console.log('\n  holder has no units - run seed.ts against this bond first.\n');
    return;
  }
  if ((await bond.getKycStatusFor(holder)) !== 1n) {
    console.log('\n  holder KYC is not GRANTED - fullRedeemAtMaturity would revert.\n');
    return;
  }

  // 2) The negative test. Only possible while we are still pre-maturity, which
  //    is the whole reason this demo uses a short-dated note.
  let now = Math.floor(Date.now() / 1000);
  if (now < maturity) {
    console.log(`\n  --- pre-maturity attempt (${maturity - now}s early) ---`);
    try {
      await bond.fullRedeemAtMaturity.staticCall(holder);
      console.log('  UNEXPECTED: the call succeeded before maturity');
      process.exitCode = 1;
      return;
    } catch (e) {
      const err = e as { data?: string };
      const sel = typeof err.data === 'string' ? err.data.slice(0, 10) : '(no revert data)';
      const named = sel === '0x67d08758' ? 'BondMaturityDateWrong()' : sel;
      console.log(`  refused on-chain: ${named}`);
    }

    const waitFor = maturity - Math.floor(Date.now() / 1000) + 5;
    console.log(`\n  waiting ${waitFor}s for maturity...`);
    await new Promise((r) => setTimeout(r, waitFor * 1000));
    now = Math.floor(Date.now() / 1000);
  } else {
    console.log(`\n  bond matured ${now - maturity}s ago - skipping the pre-maturity attempt.`);
    console.log('  (re-run with --extend 600 to see maturity refuse an early redemption)');
  }

  // 3) Cash leg first. Principal owed = units x nominal value, in the bond's
  //    currency. ATS does not move money; this is where the money moves.
  const owed = unitsBefore * nominal;
  console.log('\n  --- principal ---');
  console.log(`  ${unitsBefore} units x ${usd(nominal)} ${currency} = ${usd(owed)} USDC`);
  if (cashIssuerBefore < owed) {
    console.log(`  issuer holds only ${usd(cashIssuerBefore)} USDC - cannot pay principal. Aborting.`);
    console.log("  (the burn is deliberately NOT run: units are the holder's claim on the cash)\n");
    process.exitCode = 1;
    return;
  }
  const payTx = await usdc.transfer(holder, owed, { gasLimit: 1_000_000 });
  const payRc = await payTx.wait();
  console.log(`  paid  ${payRc?.status === 1 ? 'SUCCESS' : 'FAILED'}  https://hashscan.io/testnet/transaction/${payTx.hash}`);

  // 4) Burn. fullRedeemAtMaturity walks every partition the holder has and
  //    redeems the whole balance of each.
  const tx = await bond.fullRedeemAtMaturity(holder, { gasLimit: 4_000_000 });
  const rc = await tx.wait();
  console.log(`\n  redeem  ${rc?.status === 1 ? 'SUCCESS' : 'FAILED'}  gas ${rc?.gasUsed}`);
  console.log(`  https://hashscan.io/testnet/transaction/${tx.hash}`);

  for (const log of rc?.logs ?? []) {
    try {
      const parsed = bond.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (parsed?.name === 'RedeemedByPartition') {
        console.log(`  event   RedeemedByPartition  from ${parsed.args.from}  value ${parsed.args.value}`);
      }
    } catch {
      /* logs emitted by other contracts in the same tx */
    }
  }

  const unitsAfter: bigint = await bond.balanceOfByPartition(PARTITION, holder);
  const supplyAfter: bigint = await bond.totalSupply();
  const cashHolderAfter: bigint = await usdc.balanceOf(holder);

  console.log('\n  --- after ---');
  console.log(`  holder units         ${unitsBefore} -> ${unitsAfter}`);
  console.log(`  totalSupply          ${supplyBefore} -> ${supplyAfter}`);
  console.log(`  holder cash          ${usd(cashHolderBefore)} -> ${usd(cashHolderAfter)} USDC`);

  const ok =
    unitsAfter === 0n &&
    supplyAfter === supplyBefore - unitsBefore &&
    cashHolderAfter === cashHolderBefore + owed;
  console.log(`\n  invariant: units burned == supply reduction, principal paid in full -> ${ok ? 'HOLDS' : 'VIOLATED'}`);
  if (!ok) process.exitCode = 1;

  // 5) Audit. A redemption is a lifecycle event like any other, and it belongs
  //    on the same consensus-ordered log as the trades that preceded it.
  if (env.HCS_TOPIC_ID) {
    const hcs = new HcsAudit({
      operatorId: env.ISSUER_ACCOUNT_ID,
      operatorKey: env.ISSUER_PRIVATE_KEY,
      topicId: env.HCS_TOPIC_ID,
    });
    const ev = await hcs.write(`redeem-${token.slice(2, 10)}`, 'REDEEMED', {
      token,
      holder,
      units: unitsBefore.toString(),
      principal: owed.toString(),
      currency,
      maturityDate: maturity,
      redeemTx: tx.hash,
      cashTx: payTx.hash,
    });
    hcs.close();
    console.log(`  hcs #${ev.hcsSequenceNumber} @ ${ev.consensusTimestamp}  ${env.HCS_TOPIC_ID}`);
  }
  console.log('');
}

main().catch((e) => {
  console.error('\n  FAILED:', e instanceof Error ? e.message.split('\n')[0] : e);
  process.exit(1);
});
