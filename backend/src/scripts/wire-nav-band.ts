// Point the current SottoSettlement at the NAV oracle and switch the band on.
//
//   npx tsx backend/src/scripts/wire-nav-band.ts
//
// A freshly deployed settlement has navOracle == address(0), and the band check
// in settle() is written to skip entirely when that is the case - a deliberate
// choice, so the venue still works before an oracle exists. The consequence is
// that redeploying the contract turns the guard OFF silently: nothing reverts,
// nothing logs, trades simply stop being checked against NAV. That is a claimed
// property disappearing without a sound, which is worse than one that fails
// loudly. deploy-oracle.ts wires it as part of deploying the oracle, but a
// settlement redeploy on its own had no such step, so this is it.
//
// Idempotent: re-running it re-sets the same values.
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';

const RPC = process.env.JSON_RPC_URL ?? 'https://testnet.hashio.io/api';
const BAND_BPS = 500; // 5%, matching deploy-oracle.ts

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
  const artifact = JSON.parse(
    readFileSync('artifacts/contracts/SottoSettlement.sol/SottoSettlement.json', 'utf8')
  );

  if (!env.SETTLEMENT_ADDRESS) throw new Error('SETTLEMENT_ADDRESS is not set');
  if (!env.NAV_ORACLE_ADDRESS) throw new Error('NAV_ORACLE_ADDRESS is not set');

  const provider = new ethers.JsonRpcProvider(RPC);
  const issuer = new ethers.Wallet(env.ISSUER_PRIVATE_KEY, provider);
  const settlement = new ethers.Contract(env.SETTLEMENT_ADDRESS, artifact.abi, issuer);

  const before = await settlement.navOracle();
  console.log(`\n  settlement  ${env.SETTLEMENT_ADDRESS}`);
  console.log(`  oracle now  ${before}`);

  const tx = await settlement.setNavOracle(env.NAV_ORACLE_ADDRESS, BAND_BPS, {
    gasLimit: 1_000_000,
  });
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error(`setNavOracle reverted in ${receipt.hash}`);

  const after = await settlement.navOracle();
  const band = await settlement.bandBps();
  console.log(`  oracle set  ${after}`);
  console.log(`  band guard  ON at ${Number(band) / 100}%`);
  console.log(`  tx          ${receipt.hash}\n`);

  if (after.toLowerCase() !== env.NAV_ORACLE_ADDRESS.toLowerCase()) {
    throw new Error('the oracle address did not take; the band is NOT on');
  }
}

main().catch((e) => {
  console.error('\n  FAILED:', e instanceof Error ? e.message.split('\n')[0] : e);
  process.exit(1);
});
