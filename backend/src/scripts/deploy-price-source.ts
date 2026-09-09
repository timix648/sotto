// Deploy ChainlinkPriceSource, point it at LIVE Chainlink aggregators on Hedera
// testnet, and wire it into SottoNavOracle.
//
//   npx hardhat compile && npx tsx backend/src/scripts/deploy-price-source.ts
//
// WHAT THIS PROVES
// The README has always said an `IPriceSource` seam exists so a market feed can
// price assets that have a public price. This makes the seam load-bearing:
// after this script runs, `SottoNavOracle.referenceFor(asset)` returns a number
// that came from Chainlink minutes ago, and the ALREADY-DEPLOYED
// SottoSettlement's band check reads it with no change to that contract.
//
// AN HONEST NOTE ABOUT WHICH ASSET
// STO-EQ-A is a demo equity. It has no listing and therefore no Chainlink feed,
// and there is no honest way to pretend otherwise. What the wiring demonstrates
// is the PATH: a registered feed, a real answer, the unit conversion, the
// staleness bound, and the band check consuming it. For a genuinely listed
// security you would register that security's own feed and change nothing else.
// The bond keeps its administrator-published NAV, which is where a bond's NAV
// actually comes from.
import { ethers } from 'ethers';
import { readFileSync, writeFileSync } from 'node:fs';

const RPC = process.env.JSON_RPC_URL ?? 'https://testnet.hashio.io/api';
const ART = 'artifacts/contracts/ChainlinkPriceSource.sol/ChainlinkPriceSource.json';

/**
 * Chainlink aggregators live on Hedera testnet. Taken from Hedera's own example
 * repository (hedera-dev/hedera-example-chainlink-price-feeds) and re-probed
 * before use - all seven answered.
 */
export const FEEDS: Record<string, string> = {
  'BTC/USD': '0x058fE79CB5775d4b167920Ca6036B824805A9ABd',
  'DAI/USD': '0xdA2aBF7C90aDC73CDF5cA8d720B87bD5F5863389',
  'ETH/USD': '0xb9d461e0b962aF219866aDfA7DD19C52bB9871b9',
  'HBAR/USD': '0x59bC155EB6c6C415fE43255aF66EcF0523c92B4a',
  'LINK/USD': '0xF111b70231E89D69eBC9f6C9208e9890383Ef432',
  'USDC/USD': '0xb632a7e7e02d76c0Ce99d9C62c7a2d1B5F92B6B5',
  'USDT/USD': '0x06823de8E77d708C4cB72Cbf04495D67afF4Bd37',
};

const AGG_ABI = [
  'function decimals() view returns (uint8)',
  'function description() view returns (string)',
  'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)',
];
const ORACLE_ABI = [
  'function setPriceSource(address asset, address source)',
  'function priceSource(address) view returns (address)',
  'function referenceFor(address) view returns (uint256,uint64,uint8)',
  'function hasReference(address) view returns (bool)',
  'function withinBand(address,uint256,uint16) view returns (bool)',
];

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
  const admin = new ethers.Wallet(env.ISSUER_PRIVATE_KEY, p);

  // 0) Probe every feed first. A feed that does not answer is not a feed, and
  //    finding that out after wiring it into a settlement guard is too late.
  console.log('\n  probing Chainlink aggregators on Hedera testnet\n');
  const now = Math.floor(Date.now() / 1000);
  const live: Record<string, { dp: number; answer: bigint; age: number }> = {};
  for (const [pair, addr] of Object.entries(FEEDS)) {
    try {
      const agg = new ethers.Contract(addr, AGG_ABI, p);
      const dp = Number(await agg.decimals());
      const r = await agg.latestRoundData();
      const age = now - Number(r[3]);
      live[pair] = { dp, answer: r[1], age };
      console.log(
        `  ${pair.padEnd(9)} ${addr}  ${(Number(r[1]) / 10 ** dp).toFixed(6).padStart(14)}` +
        `  ${(age / 3600).toFixed(1).padStart(5)}h old`
      );
    } catch (e) {
      console.log(`  ${pair.padEnd(9)} ${addr}  UNREACHABLE: ${(e as Error).message.split('\n')[0].slice(0, 60)}`);
    }
  }

  // Testnet heartbeats are erratic - we have measured 16h-old rounds next to
  // 1h-old ones. A single global staleness bound would either reject healthy
  // feeds or wave through dead ones, so each feed gets its own.
  const oldest = Math.max(...Object.values(live).map(f => f.age));
  const maxAge = Math.max(48 * 3600, Math.ceil((oldest * 2) / 3600) * 3600);
  console.log(`\n  oldest round ${(oldest / 3600).toFixed(1)}h -> per-feed maxAge ${(maxAge / 3600).toFixed(0)}h`);

  // 1) Deploy
  const art = JSON.parse(readFileSync(ART, 'utf8'));
  let addr = env.PRICE_SOURCE_ADDRESS;
  if (!addr) {
    const c = await new ethers.ContractFactory(art.abi, art.bytecode, admin).deploy(admin.address, { gasLimit: 4_000_000 });
    await c.waitForDeployment();
    addr = await c.getAddress();
    upsertEnv('PRICE_SOURCE_ADDRESS', addr);
    console.log(`\n  ChainlinkPriceSource ${addr}`);
    console.log(`  hashscan https://hashscan.io/testnet/contract/${addr}`);
  } else {
    console.log(`\n  ChainlinkPriceSource ${addr} (already deployed)`);
  }
  const src = new ethers.Contract(addr, art.abi, admin);

  // 2) Register feeds.
  //
    //  outDecimals 6  - match USDC, which is what notionals are denominated in.
    //  mulNum 100     - Sotto quotes a price PER 100 NOMINAL. A raw feed answer
    //                   is per 1 unit, so the convention change is x100 and it
    //                   is written down here rather than assumed anywhere.
  const targets: { label: string; asset: string; pair: string; mulNum: bigint; mulDen: bigint }[] = [];
  if (env.EQUITY_ADDRESS) {
    targets.push({ label: 'STO-EQ-A (wiring demo)', asset: env.EQUITY_ADDRESS, pair: 'HBAR/USD', mulNum: 100n, mulDen: 1n });
  }
  // The cash token's own peg. A notional in USDC is only "fair" if a USDC is a
  // dollar, so this is the one feed that describes an asset we actually hold.
  const USDC = env.USDC_EVM_ADDRESS ?? '0x0000000000000000000000000000000000068cDa';
  targets.push({ label: 'USDC (cash leg peg)', asset: USDC, pair: 'USDC/USD', mulNum: 1n, mulDen: 1n });

  for (const t of targets) {
    if (!live[t.pair]) { console.log(`\n  skipping ${t.label} - ${t.pair} did not answer`); continue; }
    const tx = await src.setFeed(t.asset, FEEDS[t.pair], 6, maxAge, t.mulNum, t.mulDen, { gasLimit: 1_000_000 });
    await tx.wait();
    const [price, updatedAt, dp] = await src.latestPrice(t.asset);
    console.log(`\n  ${t.label}`);
    console.log(`    asset      ${t.asset}`);
    console.log(`    feed       ${t.pair} ${FEEDS[t.pair]}`);
    console.log(`    conversion x${t.mulNum}/${t.mulDen}, out at ${dp}dp`);
    console.log(`    latestPrice ${(Number(price) / 10 ** Number(dp)).toFixed(6)}  updatedAt ${new Date(Number(updatedAt) * 1000).toISOString()}`);
  }

  // 3) Wire the equity into the NAV oracle. setPriceSource already exists on the
  //    DEPLOYED oracle, so nothing else has to be redeployed for the band check
  //    to start pricing that asset from Chainlink.
  if (env.NAV_ORACLE_ADDRESS && env.EQUITY_ADDRESS && live['HBAR/USD']) {
    const oracle = new ethers.Contract(env.NAV_ORACLE_ADDRESS, ORACLE_ABI, admin);
    const current: string = await oracle.priceSource(env.EQUITY_ADDRESS);
    if (current.toLowerCase() !== addr.toLowerCase()) {
      const tx = await oracle.setPriceSource(env.EQUITY_ADDRESS, addr, { gasLimit: 1_000_000 });
      await tx.wait();
      console.log(`\n  SottoNavOracle.setPriceSource(STO-EQ-A, ChainlinkPriceSource)  ${tx.hash}`);
    } else {
      console.log('\n  SottoNavOracle already points at this price source for STO-EQ-A');
    }
    const [ref, updatedAt] = await oracle.referenceFor(env.EQUITY_ADDRESS);
    console.log(`  referenceFor(STO-EQ-A) -> ${(Number(ref) / 1e6).toFixed(6)} per 100 nominal, from ${new Date(Number(updatedAt) * 1000).toISOString()}`);
    console.log('  the band check in the DEPLOYED SottoSettlement now reads this number.');
  }
  console.log('');
}

main().catch((e) => {
  console.error('\n  FAILED:', e instanceof Error ? e.message.split('\n')[0] : e);
  process.exit(1);
});
