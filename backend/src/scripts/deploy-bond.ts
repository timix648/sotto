// Issue the Sotto demo bond from the deployed ATS factory.
//
// The SDK has no server-key path (SupportedWallets.CLIENT is commented out; the
// only headless options are custodial), so we call Factory.deployBond directly
// with ethers over the JSON-RPC relay. Struct shapes come from
// reference/ats/.../factory/IFactory.sol - see docs/ATS-SPIKE.md.
//
//   npx tsx backend/src/scripts/deploy-bond.ts [configId]
//   npx tsx backend/src/scripts/deploy-bond.ts --dry     # static call only, no gas
import { ethers } from 'ethers';
import { readFileSync, writeFileSync } from 'node:fs';

const RPC = 'https://testnet.hashio.io/api';
const FACTORY = '0x5fA65CA30d1984701F10476664327f97c864A9D3'; // 0.0.7708432
const BLR = '0xEFEF4CAe9642631Cfc6d997D6207Ee48fa78fe42';     // 0.0.7707874

// constants/roles.sol
const ROLE = {
  DEFAULT_ADMIN: '0x0000000000000000000000000000000000000000000000000000000000000000',
  ISSUER: '0x5eeaf5602c75bf26e73b5206d0bd6ee82f621166255e5fd73cc06bc7bd84a95f',
  CONTROLLER: '0xb4d2b850c3ed8a234d390d5c157bbb1824883213c335ffe2a0f0761bb168713e',
  KYC: '0x754f499f9fdfbb089d12bdec817a6863d593d8a3ea7f546c00a5cafd20957bfc',
  INTERNAL_KYC_MANAGER: '0xdd78fdcd1b38a5360405cef8d91e758ad0f42bf2ced681b803b3c2704b0a32a7',
  CORPORATE_ACTION: '0xa1acfc499025c99f55059195e6276f639d34a18aad7b8121b9192b7f438c55cd',
  PAUSER: '0x3cb8b459fdb6e7dc3d2a2aa529e530f885d45e03584adb438423209c86a2731f',
  CONTROL_LIST: '0x6ed9a91e996c6475ecdc28ecbdbe9bd1122fc62b30cdbe6da8271884b51ec74d',
};

// CRITICAL: this is the ATS v3.1.0 field order, which is what is DEPLOYED at
// 0.0.7708430 (the factory proxy has never been upgraded - its EIP-1967 slot
// still points there). Repo HEAD reorders these same 17 fields, giving selector
// 0x29002951, which is NOT in the deployed bytecode and reverts with no data.
// The deployed selector is 0x5133f0e0. See docs/ATS-SPIKE.md.
const SECURITY_DATA =
  '(bool arePartitionsProtected,bool isMultiPartition,address resolver,' +
  '(bytes32 key,uint256 version) resolverProxyConfiguration,' +
  '(bytes32 role,address[] members)[] rbacs,bool isControllable,bool isWhiteList,' +
  'uint256 maxSupply,(string name,string symbol,string isin,uint8 decimals) erc20MetadataInfo,' +
  'bool clearingActive,bool internalKycActivated,address[] externalPauses,' +
  'address[] externalControlLists,address[] externalKycLists,bool erc20VotesActivated,' +
  'address compliance,address identityRegistry)';
const BOND_DETAILS = '(bytes3 currency,uint256 nominalValue,uint8 nominalValueDecimals,uint256 startingDate,uint256 maturityDate)';
const BOND_DATA = `(${SECURITY_DATA} security,${BOND_DETAILS} bondDetails,address[] proceedRecipients,bytes[] proceedRecipientsData)`;
const REG_DATA = '(uint8 regulationType,uint8 regulationSubType,(bool countriesControlListType,string listOfCountries,string info) additionalSecurityData)';

const FACTORY_ABI = [
  `function deployBond(${BOND_DATA} _bondData,${REG_DATA} _factoryRegulationData) external returns (address bondAddress_)`,
];

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
  const dry = process.argv.includes('--dry');
  const configId = process.argv.find(a => a.startsWith('0x'))
    ?? '0x0000000000000000000000000000000000000000000000000000000000000003';

  const provider = new ethers.JsonRpcProvider(RPC);
  const issuer = new ethers.Wallet(env.ISSUER_PRIVATE_KEY, provider);
  const factory = new ethers.Contract(FACTORY, FACTORY_ABI, issuer);

  // configVersion comes from the BLR, not from a constant. The ATS docs example
  // says "0", which reverts - every registered config is at version 1.
  const blr = new ethers.Contract(BLR, ['function getLatestVersionByConfiguration(bytes32) view returns (uint256)'], provider);
  const configVersion: bigint = await blr.getLatestVersionByConfiguration(configId);

  const now = Math.floor(Date.now() / 1000);
  const rbacFor = (addr: string) => Object.values(ROLE).map(role => ({ role, members: [addr] }));

  const bondData = {
    security: {
      resolver: BLR,
      maxSupply: 1_000_000n,
      resolverProxyConfiguration: { key: configId, version: configVersion },
      erc20MetadataInfo: {
        name: process.env.BOND_NAME ?? 'Sotto Demo Senior Note 2030',
        symbol: process.env.BOND_SYMBOL ?? 'STO-BOND-A',
        // ISIN is checksum-validated on-chain by isinValidator.sol (ISO 6166).
        // XS0000000001 REVERTS - the check digit must be 9. Verified: the same
        // algorithm reproduces Apple's real ISIN US0378331005.
        isin: process.env.BOND_ISIN ?? 'XS0000000009',
        decimals: 0,
      },
      rbacs: rbacFor(issuer.address),
      externalPauses: [],
      externalControlLists: [],
      externalKycLists: [],
      compliance: ethers.ZeroAddress,
      identityRegistry: ethers.ZeroAddress,
      arePartitionsProtected: false,   // we use plain createHoldByPartition
      isMultiPartition: false,         // single default partition 0x..01
      isControllable: true,            // controller ops / force transfer
      isWhiteList: false,              // blocklist, not approval list
      clearingActive: false,           // no two-step gate in front of settle()
      internalKycActivated: true,      // REQUIRED: the failure demo revokes KYC
      erc20VotesActivated: false,
    },
    bondDetails: {
      currency: '0x555344',            // "USD" as bytes3
      nominalValue: 1_000_000n,        // 1 USDC per unit at 6dp
      nominalValueDecimals: 6,
      startingDate: BigInt(now + (process.env.BOND_MATURITY_SECS ? 30 : 300)),
      // A short-dated bond is how redemption at maturity gets demonstrated:
      // updateMaturityDate can only push maturity FORWARD (onlyAfterCurrent
      // MaturityDate), so a 2030 bond can never be matured early.
      maturityDate: process.env.BOND_MATURITY_SECS
        ? BigInt(Math.floor(Date.now() / 1000) + Number(process.env.BOND_MATURITY_SECS))
        : BigInt(Math.floor(Date.UTC(2030, 8, 5) / 1000)),
    },
    proceedRecipients: [],
    proceedRecipientsData: [],
  };

  // REG_S, because REG_D imposes a 6-month-to-1-year resale hold period and this
  // is a secondary market. See constants/regulation.sol.
  const regulationData = {
    regulationType: 1,      // REG_S
    regulationSubType: 0,   // NONE
    additionalSecurityData: { countriesControlListType: false, listOfCountries: '', info: 'Sotto demo bond' },
  };

  console.log(`\n  factory   ${FACTORY}`);
  console.log(`  issuer    ${issuer.address}`);
  console.log(`  configId  ${configId}  version ${configVersion}`);
  console.log(`  mode      ${dry ? 'DRY RUN (static call, no gas)' : 'LIVE'}\n`);

  if (dry) {
    const addr = await factory.deployBond.staticCall(bondData, regulationData);
    console.log(`  static call OK -> would deploy at ${addr}\n`);
    return;
  }

  const tx = await factory.deployBond(bondData, regulationData, { gasLimit: 15_000_000 });
  console.log(`  tx ${tx.hash}`);
  const receipt = await tx.wait();
  console.log(`  status ${receipt?.status === 1 ? 'SUCCESS' : 'FAILED'}  gas ${receipt?.gasUsed}`);

  // Read the deployed address from the receipt logs. Do NOT staticCall again
  // here - after the tx the nonce has moved, so it predicts the NEXT deployment.
  const addr = receipt?.logs.map(l => l.address).find(a => a.toLowerCase() !== FACTORY.toLowerCase()) ?? null;
  console.log(`\n  bond deployed. hashscan: https://hashscan.io/testnet/transaction/${tx.hash}`);
  if (addr) {
    console.log(`  address ${addr}`);
    let env2 = readFileSync('.env', 'utf8');
    // Honour BOND_ENV_KEY. Without this a second bond overwrites BOND_ADDRESS,
    // which is what happened the first time the short-dated note was deployed.
    const key = process.env.BOND_ENV_KEY ?? 'BOND_ADDRESS';
    env2 = new RegExp(`^${key}=`, 'm').test(env2)
      ? env2.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${addr}`)
      : env2.replace(/\n*$/, '\n') + `${key}=${addr}\n`;
    writeFileSync('.env', env2, { mode: 0o600 });
    console.log('  written to .env as ' + (process.env.BOND_ENV_KEY ?? 'BOND_ADDRESS'));
  }
  console.log('');
}

main().catch((e) => {
  const m = e instanceof Error ? e.message : String(e);
  console.error('\n  FAILED:', m.split('\n')[0]);
  if (m.includes('ResolverProxyConfigurationNoRegistered')) console.error('  -> wrong configId or version');
  process.exit(1);
});
