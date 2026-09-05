// Seed the demo: grant KYC, issue bond units to the seller.
//
// Signatures read from ATS v3.1.0 (ad8f601) - the version actually DEPLOYED at
// 0.0.7708430. Repo HEAD differs. See docs/ATS-SPIKE.md.
//
//   npx tsx backend/src/scripts/seed.ts
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';

const RPC = process.env.JSON_RPC_URL ?? 'https://testnet.hashio.io/api';
const PARTITION = '0x0000000000000000000000000000000000000000000000000000000000000001';
const UNITS = 1000n;

// ATS v3.1.0 role hashes (ad8f601, layer_1/constants/roles.sol).
//
// CRITICAL: these differ from repo HEAD. HEAD's ROLE_ISSUER is 0x5eeaf560...,
// v3.1.0's _ISSUER_ROLE is 0x4be32e88... - a DIFFERENT hash for the same role.
// The rbacs array at issuance used HEAD's constants, so every grant landed on a
// hash the deployed contract never checks. hasRole() returns true for them and
// every guarded call still reverts, because the contract asks about a different
// key. Only DEFAULT_ADMIN_ROLE (0x00) is stable across versions - which is what
// lets us repair it here.
const ROLES: Record<string, string> = {
  SSI_MANAGER: '0x0995a089e16ba792fdf9ec5a4235cba5445a9fb250d6e96224c586678b81ebd0',
  KYC: '0x6fbd421e041603fa367357d79ffc3b2f9fd37a6fc4eec661aa5537a9ae75f93d',
  ISSUER: '0x4be32e8849414d19186807008dabd451c1d87dae5f8e22f32f5ce94d486da842',
  CONTROLLER: '0xa72964c08512ad29f46841ce735cff038789243c2b506a89163cc99f76d06c0f',
  INTERNAL_KYC_MANAGER: '0x3916c5c9e68488134c2ee70660332559707c133d0a295a25971da4085441522e',
  PAUSER: '0x6f65556918c1422809d0d567462eafeb371be30159d74b38ac958dc58864faeb',
  CONTROL_LIST: '0xca537e1c88c9f52dc5692c96c482841c3bea25aafc5f3bfe96f645b5f800cac3',
  CORPORATE_ACTION: '0x8a139eeb747b9809192ae3de1b88acfd2568c15241a5c4f85db0443a536d77d6',
};
const ROLE_SSI_MANAGER = ROLES.SSI_MANAGER;

const BOND_ABI = [
  // Role admin. The deployer holds DEFAULT_ADMIN_ROLE, so it can grant itself
  // anything the rbacs array at issuance did not include.
  'function hasRole(bytes32,address) view returns (bool)',
  'function grantRole(bytes32,address)',
  // SSI issuer list. grantKyc is guarded by onlyIssuerListed(_issuer), so the
  // KYC issuer must be registered here FIRST or every grant reverts.
  'function addIssuer(address _issuer) returns (bool)',
  'function isIssuer(address _issuer) view returns (bool)',
  // internal KYC (the bond was issued with internalKycActivated: true)
  'function grantKyc(address _account, string _vcId, uint256 _validFrom, uint256 _validTo, address _issuer) returns (bool)',
  'function revokeKyc(address _account) returns (bool)',
  'function getKycStatusFor(address) view returns (uint8)',
  // ERC-1410 issuance
  'function issueByPartition((bytes32 partition,address tokenHolder,uint256 value,bytes data))',
  'function balanceOf(address) view returns (uint256)',
  'function balanceOfByPartition(bytes32,address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
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
  const provider = new ethers.JsonRpcProvider(RPC);
  const issuer = new ethers.Wallet(env.ISSUER_PRIVATE_KEY, provider);
  const bond = new ethers.Contract(env.BOND_ADDRESS, BOND_ABI, issuer);

  console.log(`\n  bond   ${env.BOND_ADDRESS}`);
  console.log(`  issuer ${issuer.address}\n`);

  const parties: [string, string][] = [
    ['ISSUER', env.ISSUER_ADDRESS],
    ['SELLER', env.SELLER_ADDRESS],
    ['DEALER', env.DEALER_ADDRESS],
  ];

  // 0) SSI: grantKyc is gated by onlyIssuerListed(_issuer). Register the issuer
  //    on the token's own issuer list first, which needs _SSI_MANAGER_ROLE -
  //    a role the issuance rbacs array did not include.
  for (const [name, hash] of Object.entries(ROLES)) {
    if (await bond.hasRole(hash, issuer.address)) {
      console.log(`  role  ${name.padEnd(21)} already held`);
      continue;
    }
    const tx = await bond.grantRole(hash, issuer.address, { gasLimit: 1_000_000 });
    await tx.wait();
    console.log(`  role  ${name.padEnd(21)} granted`);
  }

  if (!(await bond.isIssuer(issuer.address))) {
    const tx = await bond.addIssuer(issuer.address, { gasLimit: 1_000_000 });
    await tx.wait();
    console.log(`  ssi   issuer listed                  ${tx.hash}`);
  } else {
    console.log('  ssi   issuer already listed');
  }

  // 1) KYC. Internal KYC takes a verifiable-credential id and a validity window.
  const now = Math.floor(Date.now() / 1000);
  for (const [role, addr] of parties) {
    const status: bigint = await bond.getKycStatusFor(addr);
    if (status === 1n) {
      console.log(`  KYC   ${role.padEnd(7)} already granted`);
      continue;
    }
    const tx = await bond.grantKyc(addr, `vc-sotto-${role.toLowerCase()}`, now - 60, now + 365 * 24 * 3600, issuer.address, {
      gasLimit: 1_500_000,
    });
    const r = await tx.wait();
    console.log(`  KYC   ${role.padEnd(7)} ${r?.status === 1 ? 'granted' : 'FAILED'}  ${tx.hash}`);
  }

  // 2) Issue units to the seller, on the default partition.
  const held: bigint = await bond.balanceOfByPartition(PARTITION, env.SELLER_ADDRESS);
  if (held >= UNITS) {
    console.log(`\n  seller already holds ${held} units - skipping issuance`);
  } else {
    const tx = await bond.issueByPartition(
      { partition: PARTITION, tokenHolder: env.SELLER_ADDRESS, value: UNITS, data: '0x' },
      { gasLimit: 3_000_000 }
    );
    const r = await tx.wait();
    console.log(`\n  issue  ${UNITS} units -> SELLER  ${r?.status === 1 ? 'SUCCESS' : 'FAILED'}  ${tx.hash}`);
  }

  // 3) Report
  console.log('\n  --- state ---');
  console.log(`  totalSupply           ${await bond.totalSupply()}`);
  for (const [role, addr] of parties) {
    const bal = await bond.balanceOf(addr);
    const st: bigint = await bond.getKycStatusFor(addr);
    console.log(`  ${role.padEnd(7)} balance ${String(bal).padStart(6)}   kyc ${st === 1n ? 'GRANTED' : 'NOT_GRANTED'}`);
  }
  console.log('');
}

main().catch((e) => {
  console.error('\n  FAILED:', e instanceof Error ? e.message.split('\n')[0] : e);
  process.exit(1);
});
