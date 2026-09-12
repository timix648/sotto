// Send test USDC from the issuer to a demo wallet.
//
//   npx tsx backend/src/scripts/fund-wallet.ts 0xADDRESS 5
//
// Testnet only, and only for the demo desks: a dealer that cannot cover its own
// notional cannot settle, and the failure surfaces late - the seller has already
// awarded the block by then, and the units sit escrowed until someone releases
// them. Topping a dealer up before a run is cheaper than discovering it during
// one.
//
// The recipient must already be associated with the token. HTS refuses a
// transfer to an unassociated account, which is a feature: nobody can push
// tokens at you unasked.
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';

const RPC = process.env.JSON_RPC_URL ?? 'https://testnet.hashio.io/api';

const CASH_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function transfer(address,uint256) returns (bool)',
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
  const [to, amountArg] = process.argv.slice(2);
  if (!to || !/^0x[0-9a-fA-F]{40}$/.test(to)) {
    throw new Error('usage: fund-wallet.ts <0xADDRESS> <amount in USDC>');
  }
  if (!amountArg || !/^\d+(\.\d+)?$/.test(amountArg)) {
    throw new Error('amount must be a positive decimal, e.g. 5 or 2.5');
  }

  const env = loadEnv();
  const provider = new ethers.JsonRpcProvider(RPC);
  const issuer = new ethers.Wallet(env.ISSUER_PRIVATE_KEY, provider);
  const cashAddress = env.CASH_TOKEN_EVM ?? '0x0000000000000000000000000000000000068cDa';
  const cash = new ethers.Contract(cashAddress, CASH_ABI, issuer);

  const decimals = Number(await cash.decimals());
  const amount = ethers.parseUnits(amountArg, decimals);

  const from = await cash.balanceOf(issuer.address) as bigint;
  const before = await cash.balanceOf(to) as bigint;
  console.log(`\n  token     ${cashAddress}`);
  console.log(`  from      ${issuer.address}  ${ethers.formatUnits(from, decimals)} USDC`);
  console.log(`  to        ${to}  ${ethers.formatUnits(before, decimals)} USDC`);
  console.log(`  sending   ${amountArg} USDC\n`);

  if (from < amount) {
    throw new Error(
      `the issuer holds ${ethers.formatUnits(from, decimals)} USDC, which is less than ${amountArg}`
    );
  }

  // HTS amounts are int64. A transfer that overflows it fails without a reason
  // string, so the check is worth making where it can still be explained.
  if (amount > 2n ** 63n - 1n) throw new Error('amount exceeds int64, which HTS cannot represent');

  const tx = await cash.transfer(to, amount, { gasLimit: 1_000_000 });
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error(`transfer reverted in ${receipt.hash}`);

  const after = await cash.balanceOf(to) as bigint;
  console.log(`  sent      tx ${receipt.hash}`);
  console.log(`  ${to} now holds ${ethers.formatUnits(after, decimals)} USDC`);
  console.log(`  hashscan  https://hashscan.io/testnet/transaction/${receipt.hash}\n`);

  if (after - before !== amount) {
    throw new Error(`expected +${amountArg}, saw +${ethers.formatUnits(after - before, decimals)}`);
  }
}

main().catch((e) => {
  console.error('\n  FAILED:', e instanceof Error ? e.message.split('\n')[0] : e);
  process.exit(1);
});
