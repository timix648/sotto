// Redemption at maturity with NOBODY IN THE LOOP.
//
// redeem-demo.ts proves the mechanism: maturity is an on-chain gate and the
// redemption burns units against it. But it is still a person running a script.
// This one hands the redemption to the network: SottoCouponScheduler schedules
// fullRedeemAtMaturity(holder) through HIP-1215 for a second after maturity,
// and then we stop transacting. The holder is redeemed out by the ledger.
//
//   npx tsx backend/src/scripts/schedule-redeem-demo.ts [--in 300] [--gas 1500000]
//
// Three things this had to get right:
//
// 1) THE SCHEDULING CONTRACT IS THE PAYER. Gas for a scheduled call comes out
//    of SottoCouponScheduler's own HBAR balance, not the caller's. Our first
//    scheduler had no receive() and a zero balance: its coupon fired on time and
//    failed with INSUFFICIENT_PAYER_BALANCE, while the mirror node still stamped
//    the schedule executed. The contract now has a receive() and refuses to
//    schedule at a zero balance; this script tops it up.
//
// 2) THE SCHEDULED CALL'S msg.sender IS THE SCHEDULER, not us. So
//    _MATURITY_REDEEMER_ROLE has to be granted to the scheduler contract on the
//    bond. That is the whole authorisation story: the venue's operator holds no
//    privilege at execution time and does not need to be online.
//
// 3) THE SLOT IS NOT THE SECOND YOU ASKED FOR. hasScheduleCapacity walks
//    forward until it finds a second with room, so the executed timestamp is
//    >= the requested one. Schedule strictly AFTER maturity, never on it.
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';

const RPC = process.env.JSON_RPC_URL ?? 'https://testnet.hashio.io/api';
const MIRROR = 'https://testnet.mirrornode.hedera.com/api/v1';
const PARTITION = '0x0000000000000000000000000000000000000000000000000000000000000001';

// ATS v3.1.0 (ad8f601) - the DEPLOYED version. See docs/ATS-SPIKE.md.
const ROLE_MATURITY_REDEEMER = '0xa0d696902e9ed231892dc96649f0c62b808a1cb9dd1269e78e0adc1cc4b8358c';

const BOND_ABI = [
  'function hasRole(bytes32,address) view returns (bool)',
  'function grantRole(bytes32,address)',
  'function getBondDetails() view returns ((bytes3 currency,uint256 nominalValue,uint8 nominalValueDecimals,uint256 startingDate,uint256 maturityDate))',
  'function updateMaturityDate(uint256) returns (bool)',
  'function fullRedeemAtMaturity(address)',
  'function issueByPartition((bytes32 partition,address tokenHolder,uint256 value,bytes data))',
  'function balanceOfByPartition(bytes32,address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function symbol() view returns (string)',
];

const SCHED_ABI = [
  'function scheduleMaturity(address,uint256,uint256,bytes) returns (address)',
  'function findAvailableSecond(uint256,uint256) view returns (uint256,bool)',
  'function scheduleCount() view returns (uint256)',
  'event MaturityScheduled(address indexed assetToken,uint256 requestedDate,uint256 scheduledFor,address scheduleAddress)',
];

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

function numFlag(name: string, dflt: number): number {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : dflt;
}
const iso = (s: number | bigint) => new Date(Number(s) * 1000).toISOString().replace('.000Z', 'Z');

/**
 * Hedera entity id for a LONG-ZERO EVM address (the low 8 bytes are the num).
 * Only valid for entities the network itself addressed this way - schedules
 * created by HSS are. A contract deployed over the JSON-RPC relay gets a real
 * keccak-derived address instead, and its entity id has to be looked up.
 */
const longZeroId = (addr: string) => `0.0.${BigInt(addr)}`;

async function contractId(addr: string): Promise<string> {
  try {
    const r = await fetch(`${MIRROR}/contracts/${addr}`);
    if (r.ok) return ((await r.json()) as { contract_id?: string }).contract_id ?? '?';
  } catch { /* mirror lag */ }
  return '?';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const env = loadEnv();
  const provider = new ethers.JsonRpcProvider(RPC);
  const issuer = new ethers.Wallet(env.ISSUER_PRIVATE_KEY, provider);

  const bondAddr = process.argv.find((a) => a.startsWith('0x') && a.length === 42)
    ?? env.SHORT_BOND_ADDRESS;
  const holder = env.SELLER_ADDRESS;
  const schedAddr = env.SCHEDULER_ADDRESS;
  const inSecs = numFlag('--in', 300);
  const gasLimit = numFlag('--gas', 1_500_000);
  const units = BigInt(numFlag('--units', 5));

  const bond = new ethers.Contract(bondAddr, BOND_ABI, issuer);
  const sched = new ethers.Contract(schedAddr, SCHED_ABI, issuer);

  console.log(`\n  bond      ${bondAddr}  ${await bond.symbol()}`);
  console.log(`  scheduler ${schedAddr}  (${await contractId(schedAddr)})`);
  console.log(`  holder    ${holder}`);

  // 1) Fund the scheduler. It pays for its own scheduled executions.
  const bal = await provider.getBalance(schedAddr);
  console.log(`\n  scheduler HBAR balance ${ethers.formatEther(bal)}`);
  if (bal < ethers.parseEther('5')) {
    const top = ethers.parseEther('10') - bal;
    const tx = await issuer.sendTransaction({ to: schedAddr, value: top, gasLimit: 200_000 });
    await tx.wait();
    console.log(`  funded +${ethers.formatEther(top)} HBAR  ${tx.hash}`);
    console.log(`  scheduler HBAR balance ${ethers.formatEther(await provider.getBalance(schedAddr))}`);
  }

  // 2) The scheduler, not us, is the caller at execution time.
  if (!(await bond.hasRole(ROLE_MATURITY_REDEEMER, schedAddr))) {
    const tx = await bond.grantRole(ROLE_MATURITY_REDEEMER, schedAddr, { gasLimit: 1_000_000 });
    await tx.wait();
    console.log(`\n  granted MATURITY_REDEEMER to the scheduler  ${tx.hash}`);
  } else {
    console.log('\n  scheduler already holds MATURITY_REDEEMER');
  }

  // 3) Fresh maturity, fresh units. updateMaturityDate only moves forward, so
  //    every run of this demo pushes the note out again.
  const maturity = Math.floor(Date.now() / 1000) + inSecs;
  let tx = await bond.updateMaturityDate(maturity, { gasLimit: 1_000_000 });
  await tx.wait();
  console.log(`  maturity  ${iso(maturity)}`);

  let held: bigint = await bond.balanceOfByPartition(PARTITION, holder);
  if (held === 0n) {
    tx = await bond.issueByPartition(
      { partition: PARTITION, tokenHolder: holder, value: units, data: '0x' },
      { gasLimit: 3_000_000 }
    );
    await tx.wait();
    held = await bond.balanceOfByPartition(PARTITION, holder);
    console.log(`  issued    ${units} units to the holder`);
  }
  console.log(`  holder holds ${held} units, totalSupply ${await bond.totalSupply()}`);

  // 4) Schedule the redemption for a second AFTER maturity. The slot search may
  //    walk forward from there; it can never walk backward, so this is safe.
  const requested = maturity + 30;
  const [probe, found] = await sched.findAvailableSecond(requested, gasLimit);
  console.log(`\n  findAvailableSecond(${requested}, ${gasLimit}) -> ${probe}, found ${found}`);
  if (!found) {
    console.log('  no capacity within the probe window - try a different second.\n');
    process.exitCode = 1;
    return;
  }

  const callData = new ethers.Interface(BOND_ABI).encodeFunctionData('fullRedeemAtMaturity', [holder]);
  tx = await sched.scheduleMaturity(bondAddr, requested, gasLimit, callData, { gasLimit: 3_000_000 });
  const rc = await tx.wait();
  console.log(`  scheduleMaturity  ${rc?.status === 1 ? 'SUCCESS' : 'FAILED'}  ${tx.hash}`);

  let scheduledFor = requested;
  let scheduleAddress = '';
  for (const log of rc?.logs ?? []) {
    try {
      const d = sched.interface.parseLog({ topics: [...log.topics], data: log.data });
      if (d?.name === 'MaturityScheduled') {
        scheduledFor = Number(d.args.scheduledFor);
        scheduleAddress = d.args.scheduleAddress;
      }
    } catch { /* logs from HSS */ }
  }
  if (!scheduleAddress) {
    console.log('  no MaturityScheduled event - aborting.\n');
    process.exitCode = 1;
    return;
  }
  const scheduleId = longZeroId(scheduleAddress);
  console.log(`\n  schedule  ${scheduleId}  (${scheduleAddress})`);
  console.log(`  fires at  ${iso(scheduledFor)}`);
  console.log(`  hashscan  https://hashscan.io/testnet/schedule/${scheduleId}`);
  console.log(`  mirror    ${MIRROR}/schedules/${scheduleId}`);

  // 5) Stop transacting. From here the ledger does the work.
  const blockUntil = scheduledFor + 20;
  console.log(`\n  --- waiting ${blockUntil - Math.floor(Date.now() / 1000)}s. NO further transactions are sent from here. ---`);

  let after = held;
  const deadline = Date.now() + (blockUntil - Math.floor(Date.now() / 1000) + 180) * 1000;
  while (Date.now() < deadline) {
    await sleep(15_000);
    after = await bond.balanceOfByPartition(PARTITION, holder);
    const left = Math.max(0, scheduledFor - Math.floor(Date.now() / 1000));
    console.log(`  t-${String(left).padStart(4)}s  holder units ${after}`);
    if (after === 0n) break;
  }

  // 6) Read the execution back off the mirror node, which is the only place the
  //    proof lives: we did not send this transaction.
  const res = await fetch(`${MIRROR}/schedules/${scheduleId}`);
  const info = res.ok ? await res.json() as Record<string, unknown> : null;
  console.log('\n  --- schedule, per the mirror node ---');
  if (info) {
    console.log(`  creator            ${info.creator_account_id}`);
    console.log(`  payer              ${info.payer_account_id}`);
    console.log(`  expiration_time    ${info.expiration_time}`);
    console.log(`  executed_timestamp ${info.executed_timestamp ?? '(not yet)'}`);
  } else {
    console.log(`  mirror node has not indexed ${scheduleId} yet`);
  }

  console.log('\n  --- after ---');
  console.log(`  holder units   ${held} -> ${after}`);
  console.log(`  totalSupply    ${await bond.totalSupply()}`);
  const ok = after === 0n;
  console.log(`\n  redeemed by the network, with no transaction from us -> ${ok ? 'YES' : 'NO'}`);
  if (!ok) {
    console.log('  If units are unchanged, check the scheduler HBAR balance and the');
    console.log('  gas limit: an underfunded or under-gassed scheduled call fails');
    console.log('  silently from the scheduler\'s point of view.');
    process.exitCode = 1;
  }
  console.log('');
}

main().catch((e) => {
  console.error('\n  FAILED:', e instanceof Error ? e.message.split('\n')[0] : e);
  process.exit(1);
});
