// Deploy SottoSettlement to Hedera testnet.
//
//   npx hardhat compile && npx tsx backend/src/scripts/deploy-settlement.ts
import { ethers } from 'ethers';
import { readFileSync, writeFileSync } from 'node:fs';

const RPC = process.env.JSON_RPC_URL ?? 'https://testnet.hashio.io/api';
const ARTIFACT = 'artifacts/contracts/SottoSettlement.sol/SottoSettlement.json';

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
  const artifact = JSON.parse(readFileSync(ARTIFACT, 'utf8'));
  const provider = new ethers.JsonRpcProvider(RPC);
  const issuer = new ethers.Wallet(env.ISSUER_PRIVATE_KEY, provider);

  console.log(`\n  deployer ${issuer.address}`);
  console.log(`  balance  ${ethers.formatEther(await provider.getBalance(issuer.address))} HBAR\n`);

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, issuer);
  // admin = issuer: holds DEFAULT_ADMIN_ROLE and RELAYER_ROLE. Note that neither
  // role can move user funds - RELAYER_ROLE gates deliver() only.
  const contract = await factory.deploy(issuer.address, { gasLimit: 6_000_000 });
  console.log(`  tx ${contract.deploymentTransaction()?.hash}`);

  await contract.waitForDeployment();
  const addr = await contract.getAddress();

  console.log(`  SottoSettlement deployed at ${addr}`);
  console.log(`  hashscan https://hashscan.io/testnet/contract/${addr}\n`);

  upsertEnv('SETTLEMENT_ADDRESS', addr);
  console.log('  written to .env as SETTLEMENT_ADDRESS\n');
}

main().catch((e) => {
  console.error('\n  FAILED:', e instanceof Error ? e.message.split('\n')[0] : e);
  process.exit(1);
});
