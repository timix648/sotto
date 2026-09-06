// Deploy SottoNavOracle, publish reference NAVs, redeploy SottoSettlement with
// the band hook, and wire them together.
//
// The previously deployed settlement stays on-chain and still works - it simply
// has no band guard. Holds escrowed to it remain valid; new trades use the new
// address. Both are verified on Sourcify.
//
//   npx hardhat compile && npx tsx backend/src/scripts/deploy-oracle.ts
import { ethers } from 'ethers';
import { readFileSync, writeFileSync } from 'node:fs';

const RPC = process.env.JSON_RPC_URL ?? 'https://testnet.hashio.io/api';
const BAND_BPS = 500; // 5%

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
const artifact = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

async function main() {
  const env = loadEnv();
  const p = new ethers.JsonRpcProvider(RPC);
  const issuer = new ethers.Wallet(env.ISSUER_PRIVATE_KEY, p);
  console.log(`\n  deployer ${issuer.address}\n`);

  // 1) Oracle
  const oracleArt = artifact('artifacts/contracts/SottoNavOracle.sol/SottoNavOracle.json');
  const oracle = await new ethers.ContractFactory(oracleArt.abi, oracleArt.bytecode, issuer)
    .deploy(issuer.address, { gasLimit: 4_000_000 });
  await oracle.waitForDeployment();
  const oracleAddr = await oracle.getAddress();
  console.log(`  SottoNavOracle       ${oracleAddr}`);
  upsertEnv('NAV_ORACLE_ADDRESS', oracleAddr);

  // 2) Publish reference NAVs. 98.35 per 100 nominal for the bond (a note
  //    trading slightly below par); 100.00 for the equity.
  const oc = new ethers.Contract(oracleAddr, oracleArt.abi, issuer);
  for (const [label, addr, nav] of [
    ['bond  ', env.BOND_ADDRESS, 98_350_000n],
    ['equity', env.EQUITY_ADDRESS, 100_000_000n],
  ] as [string, string, bigint][]) {
    if (!addr) continue;
    const tx = await oc.publishNav(addr, nav, 6, { gasLimit: 1_000_000 });
    await tx.wait();
    console.log(`  NAV ${label}          ${Number(nav) / 1e6} per 100 nominal`);
  }

  // 3) Settlement with the band hook
  const setArt = artifact('artifacts/contracts/SottoSettlement.sol/SottoSettlement.json');
  const settlement = await new ethers.ContractFactory(setArt.abi, setArt.bytecode, issuer)
    .deploy(issuer.address, { gasLimit: 6_000_000 });
  await settlement.waitForDeployment();
  const setAddr = await settlement.getAddress();
  console.log(`\n  SottoSettlement (v2) ${setAddr}`);
  upsertEnv('SETTLEMENT_ADDRESS', setAddr);
  upsertEnv('SETTLEMENT_V1_ADDRESS', env.SETTLEMENT_ADDRESS ?? '');

  // 4) Wire
  const sc = new ethers.Contract(setAddr, setArt.abi, issuer);
  const tx = await sc.setNavOracle(oracleAddr, BAND_BPS, { gasLimit: 1_000_000 });
  await tx.wait();
  console.log(`  band guard           ON at ${BAND_BPS / 100}%`);

  console.log(`\n  hashscan oracle     https://hashscan.io/testnet/contract/${oracleAddr}`);
  console.log(`  hashscan settlement https://hashscan.io/testnet/contract/${setAddr}`);
  console.log('\n  NOTE: existing holds are escrowed to the OLD settlement address and');
  console.log('  remain valid there. New trades must place a fresh hold against the new one.\n');
}

main().catch((e) => {
  console.error('\n  FAILED:', e instanceof Error ? e.message.split('\n')[0] : e);
  process.exit(1);
});
