// Resolve the ATS configuration ids and their latest versions from the live BLR.
//
// BLUEPRINT A2 requires configId + configVersion for any bond/equity deployment
// and does NOT say where they come from. Do not invent or hardcode them - the
// BLR is the authority and exposes them as view calls. This script reads them.
//
//   npx tsx backend/src/scripts/resolve-config.ts
import { ethers } from 'ethers';

const RPC = process.env.JSON_RPC_URL ?? 'https://testnet.hashio.io/api';
// BLR Proxy 0.0.7707874, per reference/ats/docs/.../deployed-addresses.md
const BLR = '0xEFEF4CAe9642631Cfc6d997D6207Ee48fa78fe42';

const BLR_ABI = [
  'function getConfigurationsLength() external view returns (uint256)',
  'function getConfigurations(uint256 _pageIndex, uint256 _pageLength) external view returns (bytes32[] memory)',
  'function getLatestVersionByConfiguration(bytes32 _configurationId) external view returns (uint256)',
  'function getBusinessLogicCount() external view returns (uint256)',
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const blr = new ethers.Contract(BLR, BLR_ABI, provider);

  console.log(`\n  BLR ${BLR}`);
  console.log(`  rpc ${RPC}\n`);

  const count: bigint = await blr.getConfigurationsLength();
  console.log(`  registered configurations: ${count}`);

  const facets: bigint = await blr.getBusinessLogicCount();
  console.log(`  registered business logics (facets): ${facets}\n`);

  if (count === 0n) {
    console.log('  none registered - nothing to resolve');
    return;
  }

  const ids: string[] = await blr.getConfigurations(0, count);
  for (const id of ids) {
    const version: bigint = await blr.getLatestVersionByConfiguration(id);
    console.log(`  ${id}`);
    console.log(`    latest version: ${version}`);
  }
  console.log('');
}

main().catch((e) => {
  console.error('  FAILED:', e instanceof Error ? e.message.split('\n')[0] : e);
  process.exit(1);
});
