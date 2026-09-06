// Deploy SottoCouponScheduler and prove HIP-1215 works against the live HSS
// system contract at 0x16b.
//
//   npx hardhat compile && npx tsx backend/src/scripts/deploy-scheduler.ts
import { ethers } from 'ethers';
import { readFileSync, writeFileSync } from 'node:fs';

const RPC = process.env.JSON_RPC_URL ?? 'https://testnet.hashio.io/api';
const ART = 'artifacts/contracts/SottoCouponScheduler.sol/SottoCouponScheduler.json';
const HSS = '0x000000000000000000000000000000000000016b';

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

async function main() {
  const env = loadEnv();
  const p = new ethers.JsonRpcProvider(RPC);
  const issuer = new ethers.Wallet(env.ISSUER_PRIVATE_KEY, p);

  // 0) Is the HSS system contract actually reachable on testnet? A free view.
  console.log(`\n  probing HSS at ${HSS}`);
  const hss = new ethers.Contract(HSS, ['function hasScheduleCapacity(uint256,uint256) view returns (bool)'], p);
  const soon = Math.floor(Date.now() / 1000) + 120;
  try {
    const cap = await hss.hasScheduleCapacity(soon, 200_000);
    console.log(`  hasScheduleCapacity(${soon}, 200000) -> ${cap}   HSS is live`);
  } catch (e) {
    console.log(`  HSS probe FAILED: ${(e as Error).message.split('\n')[0].slice(0, 100)}`);
    console.log('  HIP-1215 may not be available on this network. Section A1 says');
    console.log('  timebox this and fall back to a backend scheduler.');
    return;
  }

  // 1) Deploy
  const art = JSON.parse(readFileSync(ART, 'utf8'));
  const factory = new ethers.ContractFactory(art.abi, art.bytecode, issuer);
  // Fund at construction. THE SCHEDULING CONTRACT IS THE PAYER for every call
  // it schedules - gas at execution time comes out of this balance, not out of
  // whoever called scheduleCoupon. The first deployment of this contract had no
  // receive() and a zero balance; its scheduled coupon fired on time and failed
  // with INSUFFICIENT_PAYER_BALANCE, while the mirror node still reported the
  // schedule as executed. Fund it, then check the transaction, not the schedule.
  const FUND = ethers.parseEther('10');
  const c = await factory.deploy(issuer.address, { gasLimit: 4_000_000, value: FUND });
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log(`\n  SottoCouponScheduler ${addr}`);
  console.log(`  hashscan https://hashscan.io/testnet/contract/${addr}`);
  console.log(`  gas budget ${ethers.formatEther(await p.getBalance(addr))} HBAR`);
  upsertEnv('SCHEDULER_ADDRESS', addr);

  // 2) Slot search through our own contract
  const sched = new ethers.Contract(addr, art.abi, issuer);
  const target = Math.floor(Date.now() / 1000) + 300;
  const [slot, found] = await sched.findAvailableSecond(target, 300_000);
  console.log(`\n  findAvailableSecond(${target}, 300000) -> slot ${slot}, found ${found}`);
  if (found && Number(slot) !== target) {
    console.log(`  (walked ${Number(slot) - target}s forward to find capacity)`);
  }

  // 3) Schedule a real coupon call. The scheduled call targets the bond; the
  //    payload is a harmless read so this proves the SCHEDULING mechanism
  //    without needing corporate-action roles on the scheduled execution.
  const callData = new ethers.Interface(['function totalSupply() view returns (uint256)'])
    .encodeFunctionData('totalSupply');

  console.log('\n  scheduleCoupon(bond, +300s, 300000 gas)');
  try {
    const tx = await sched.scheduleCoupon(env.BOND_ADDRESS, target, 300_000, callData, { gasLimit: 3_000_000 });
    const rc = await tx.wait();
    console.log(`  tx ${tx.hash}  status ${rc?.status === 1 ? 'SUCCESS' : 'FAILED'}`);

    const iface = new ethers.Interface(art.abi);
    for (const l of rc?.logs ?? []) {
      try {
        const d = iface.parseLog(l);
        if (d?.name === 'CouponScheduled') {
          console.log(`\n  CouponScheduled`);
          console.log(`    asset          ${d.args.assetToken}`);
          console.log(`    requested      ${d.args.requestedDate}`);
          console.log(`    scheduled for  ${d.args.scheduledFor}`);
          console.log(`    scheduleAddress ${d.args.scheduleAddress}`);
        }
      } catch { /* not ours */ }
    }
    console.log(`\n  schedules recorded: ${await sched.scheduleCount()}`);
  } catch (e) {
    const m = e instanceof Error ? e.message.split('\n')[0] : String(e);
    console.log(`  scheduleCoupon FAILED: ${m.slice(0, 140)}`);
    console.log('\n  Section A1: timebox HIP-1215 to 4 hours, then fall back to a');
    console.log('  backend scheduler calling the same coupon function, and say so');
    console.log('  plainly in the README. The contract stays in the repo either way.');
  }
  console.log('');
}

main().catch((e) => {
  console.error('\n  FAILED:', e instanceof Error ? e.message.split('\n')[0] : e);
  process.exit(1);
});
