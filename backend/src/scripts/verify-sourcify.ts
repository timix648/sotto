// Verify the Sotto contracts on Sourcify (which is what HashScan reads).
//
// hardhat-verify targets Sourcify's v1 API, which has been sunset - it returns
// HTML and fails with "Unexpected token '<'". Hedera's own docs also note that
// verify.hashscan.io / server-verify.hashscan.io are deprecated and redirect.
// So we post Hardhat's standard-JSON input to the v2 API directly.
//
//   npx hardhat compile && npx tsx backend/src/scripts/verify-sourcify.ts
import { readFileSync, readdirSync, statSync } from 'node:fs';

const SOURCIFY = 'https://sourcify.dev/server';
const CHAIN = '296';

const TARGETS = [
  { name: 'SottoSettlement', path: 'contracts/SottoSettlement.sol', envKey: 'SETTLEMENT_ADDRESS' },
  { name: 'SottoCouponScheduler', path: 'contracts/SottoCouponScheduler.sol', envKey: 'SCHEDULER_ADDRESS' },
  { name: 'ChainlinkPriceSource', path: 'contracts/ChainlinkPriceSource.sol', envKey: 'PRICE_SOURCE_ADDRESS' },
  { name: 'SottoNavOracle', path: 'contracts/SottoNavOracle.sol', envKey: 'NAV_ORACLE_ADDRESS' },
  { name: 'SottoDealerBond', path: 'contracts/SottoDealerBond.sol', envKey: 'DEALER_BOND_ADDRESS' },
];

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

/**
 * Find the build-info that compiled a given source file.
 *
 * Must be the NEWEST match, not the first. Recompiling leaves older build-info
 * files behind that still contain the source, and submitting one produces
 * "recompiled bytecode length doesn't match the onchain bytecode length" - which
 * reads like a compiler-settings problem and is really a stale-artifact problem.
 */
function findBuildInfo(sourcePath: string) {
  const candidates = readdirSync('artifacts/build-info')
    .map(f => {
      const path = `artifacts/build-info/${f}`;
      return { path, mtime: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  for (const c of candidates) {
    const bi = JSON.parse(readFileSync(c.path, 'utf8'));
    if (bi.input?.sources?.[sourcePath]) return bi;
  }
  return null;
}

async function status(address: string) {
  const r = await fetch(`${SOURCIFY}/v2/contract/${CHAIN}/${address}`);
  return r.json() as Promise<{ match: string | null }>;
}

async function main() {
  const env = loadEnv();

  for (const t of TARGETS) {
    const address = env[t.envKey];
    if (!address) { console.log(`\n  ${t.name}: no ${t.envKey} in .env - skipping`); continue; }

    console.log(`\n  ${t.name}  ${address}`);
    const before = await status(address);
    if (before.match) { console.log(`    already verified: ${before.match}`); continue; }

    const bi = findBuildInfo(t.path);
    if (!bi) { console.log('    no build-info found - run: npx hardhat compile'); continue; }

    const body = {
      stdJsonInput: bi.input,
      compilerVersion: bi.solcLongVersion,
      contractIdentifier: `${t.path}:${t.name}`,
    };

    const res = await fetch(`${SOURCIFY}/v2/verify/${CHAIN}/${address}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    console.log(`    submit -> HTTP ${res.status}`);

    let jobId: string | undefined;
    try { jobId = JSON.parse(text).verificationId; } catch { /* not json */ }
    if (!jobId) { console.log(`    ${text.slice(0, 200)}`); continue; }

    // Verification is asynchronous - poll the job.
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 3000));
      const j = await (await fetch(`${SOURCIFY}/v2/verify/${jobId}`)).json() as
        { isJobCompleted?: boolean; contract?: { match?: string }; error?: { message?: string } };
      if (j.isJobCompleted) {
        if (j.contract?.match) {
          console.log(`    VERIFIED: ${j.contract.match}`);
          console.log(`    https://repo.sourcify.dev/${CHAIN}/${address}`);
          console.log(`    https://hashscan.io/testnet/contract/${address}`);
        } else {
          console.log(`    failed: ${j.error?.message ?? JSON.stringify(j).slice(0, 200)}`);
        }
        break;
      }
    }
  }
  console.log('');
}

main().catch((e) => { console.error('  FAILED:', e); process.exit(1); });
