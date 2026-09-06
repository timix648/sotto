// Issue an EQUITY from the deployed ATS factory - Sotto's second asset class.
//
// The track is judged on "real asset classes and real lifecycle management ...
// over a token with a name on it". One bond is one class. An equity has a
// genuinely different lifecycle (dividends, voting rights) and - the point -
// the SAME RfqEngine and the SAME settle() handle it with no per-asset branch.
//
// Struct order is ATS v3.1.0-through-v5.0.0 (bools first), which is what is
// DEPLOYED at 0.0.7708430. main reorders SecurityData. See docs/ATS-SPIKE.md.
//
//   npx tsx backend/src/scripts/deploy-equity.ts [--dry] [configId]
import { ethers } from 'ethers';
import { readFileSync, writeFileSync } from 'node:fs';

const RPC = process.env.JSON_RPC_URL ?? 'https://testnet.hashio.io/api';
const FACTORY = '0x5fA65CA30d1984701F10476664327f97c864A9D3';
const BLR = '0xEFEF4CAe9642631Cfc6d997D6207Ee48fa78fe42';
// Config 0x..01 - identified empirically by probing each configuration's facet
// set for equity-specific selectors. It is NOT SecurityType enum order.
const EQUITY_CONFIG = '0x0000000000000000000000000000000000000000000000000000000000000001';

// ATS v3.1.0 role hashes (layer_1/constants/roles.sol). These differ from main.
const ROLES: Record<string, string> = {
  DEFAULT_ADMIN: '0x0000000000000000000000000000000000000000000000000000000000000000',
  SSI_MANAGER: '0x0995a089e16ba792fdf9ec5a4235cba5445a9fb250d6e96224c586678b81ebd0',
  KYC: '0x6fbd421e041603fa367357d79ffc3b2f9fd37a6fc4eec661aa5537a9ae75f93d',
  ISSUER: '0x4be32e8849414d19186807008dabd451c1d87dae5f8e22f32f5ce94d486da842',
  CONTROLLER: '0xa72964c08512ad29f46841ce735cff038789243c2b506a89163cc99f76d06c0f',
  INTERNAL_KYC_MANAGER: '0x3916c5c9e68488134c2ee70660332559707c133d0a295a25971da4085441522e',
  PAUSER: '0x6f65556918c1422809d0d567462eafeb371be30159d74b38ac958dc58864faeb',
  CORPORATE_ACTION: '0x8a139eeb747b9809192ae3de1b88acfd2568c15241a5c4f85db0443a536d77d6',
};

const SECURITY_DATA =
  '(bool arePartitionsProtected,bool isMultiPartition,address resolver,' +
  '(bytes32 key,uint256 version) resolverProxyConfiguration,' +
  '(bytes32 role,address[] members)[] rbacs,bool isControllable,bool isWhiteList,' +
  'uint256 maxSupply,(string name,string symbol,string isin,uint8 decimals) erc20MetadataInfo,' +
  'bool clearingActive,bool internalKycActivated,address[] externalPauses,' +
  'address[] externalControlLists,address[] externalKycLists,bool erc20VotesActivated,' +
  'address compliance,address identityRegistry)';
// EquityDetailsData: seven rights, then dividendType, then currency/nominal.
const EQUITY_DETAILS =
  '(bool votingRight,bool informationRight,bool liquidationRight,bool subscriptionRight,' +
  'bool conversionRight,bool redemptionRight,bool putRight,uint8 dividendRight,' +
  'bytes3 currency,uint256 nominalValue,uint8 nominalValueDecimals)';
const REG_DATA =
  '(uint8 regulationType,uint8 regulationSubType,(bool countriesControlListType,string listOfCountries,string info) additionalSecurityData)';

const FACTORY_ABI = [
  `function deployEquity((${SECURITY_DATA} security,${EQUITY_DETAILS} equityDetails) _equityData,${REG_DATA} _factoryRegulationData) external returns (address equityAddress_)`,
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
  const dry = process.argv.includes('--dry');
  const configId = process.argv.find(a => a.startsWith('0x') && a.length === 66) ?? EQUITY_CONFIG;

  const p = new ethers.JsonRpcProvider(RPC);
  const issuer = new ethers.Wallet(env.ISSUER_PRIVATE_KEY, p);
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, issuer);

  const blr = new ethers.Contract(BLR, ['function getLatestVersionByConfiguration(bytes32) view returns (uint256)'], p);
  const configVersion: bigint = await blr.getLatestVersionByConfiguration(configId);

  const rbacs = Object.values(ROLES).map(role => ({ role, members: [issuer.address] }));

  const equityData = {
    security: {
      arePartitionsProtected: false,
      isMultiPartition: false,
      resolver: BLR,
      resolverProxyConfiguration: { key: configId, version: configVersion },
      rbacs,
      isControllable: true,
      isWhiteList: false,
      maxSupply: 1_000_000n,
      erc20MetadataInfo: {
        name: 'Sotto Demo Equity Class A',
        symbol: 'STO-EQ-A',
        // ISIN is checksum-validated on-chain (ISO 6166). Check digit computed,
        // not guessed - XS0000000017 verifies.
        isin: 'XS0000000017',
        decimals: 0,
      },
      clearingActive: false,
      internalKycActivated: true, // the failure demo needs internal KYC to revoke
      externalPauses: [],
      externalControlLists: [],
      externalKycLists: [],
      erc20VotesActivated: false,
      compliance: ethers.ZeroAddress,
      identityRegistry: ethers.ZeroAddress,
    },
    equityDetails: {
      votingRight: true,
      informationRight: true,
      liquidationRight: true,
      subscriptionRight: false,
      conversionRight: false,
      redemptionRight: false,
      putRight: false,
      dividendRight: 2,          // DividendType.COMMON  (NONE=0, PREFERRED=1, COMMON=2)
      currency: '0x555344',      // "USD" as bytes3
      nominalValue: 1_000_000n,  // 1 USDC per share at 6dp
      nominalValueDecimals: 6,
    },
  };

  // REG_S: REG_D imposes a 6-month-to-1-year resale hold, which would block the
  // secondary trading this venue exists for.
  const regulationData = {
    regulationType: 1,
    regulationSubType: 0,
    additionalSecurityData: { countriesControlListType: false, listOfCountries: '', info: 'Sotto demo equity' },
  };

  console.log(`\n  factory   ${FACTORY}`);
  console.log(`  configId  ${configId}  version ${configVersion}`);
  console.log(`  mode      ${dry ? 'DRY RUN' : 'LIVE'}\n`);

  if (dry) {
    const addr = await factory.deployEquity.staticCall(equityData, regulationData);
    console.log(`  static call OK -> would deploy at ${addr}\n`);
    return;
  }

  const tx = await factory.deployEquity(equityData, regulationData, { gasLimit: 15_000_000 });
  console.log(`  tx ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  status ${receipt?.status === 1 ? 'SUCCESS' : 'FAILED'}  gas ${receipt?.gasUsed}`);

  // Read the address from the logs, NOT a second staticCall - the nonce has
  // moved, so a repeat static call predicts the NEXT deployment.
  const addr = receipt?.logs.map(l => l.address).find(a => a.toLowerCase() !== FACTORY.toLowerCase());
  if (addr) {
    console.log(`\n  equity deployed at ${addr}`);
    console.log(`  hashscan https://hashscan.io/testnet/contract/${addr}`);
    upsertEnv('EQUITY_ADDRESS', addr);
    console.log('  written to .env as EQUITY_ADDRESS');
  }
  console.log('');
}

main().catch((e) => {
  const m = e instanceof Error ? e.message : String(e);
  console.error('\n  FAILED:', m.split('\n')[0].slice(0, 200));
  process.exit(1);
});
