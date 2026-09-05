// Associate the demo accounts with a token.
//
// WHY THIS EXISTS: maxAutomaticTokenAssociations = -1 means "no limit on the
// number of automatic associations this account can accept". It does NOT mean
// tokens are pre-associated. An association is only created when Hedera
// processes a transfer that is ELIGIBLE for automatic association - and the
// Circle USDC faucet transfer is not. Without an explicit association the
// transfer silently never lands.
//
// BLUEPRINT.md section 10 lists this trap; the -1 default hides it until a
// transfer that doesn't qualify comes along.
//
//   npx tsx backend/src/scripts/associate.ts               # associates USDC
//   npx tsx backend/src/scripts/associate.ts 0.0.123456    # any token id
//
// Each account pays its own association fee from its own HBAR balance.
import {
  Client, AccountId, PrivateKey, TokenId,
  TokenAssociateTransaction, Status,
} from '@hashgraph/sdk';
import { readFileSync } from 'node:fs';

const ROLES = ['ISSUER', 'SELLER', 'DEALER'] as const;

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
  const tokenId = TokenId.fromString(process.argv[2] ?? env.USDC_TOKEN_ID ?? '0.0.429274');
  console.log(`\n  Associating token ${tokenId.toString()} with ${ROLES.length} accounts\n`);

  for (const role of ROLES) {
    const accountId = env[`${role}_ACCOUNT_ID`];
    const rawKey = env[`${role}_PRIVATE_KEY`];
    if (!accountId || !rawKey) {
      console.log(`  ${role.padEnd(7)} SKIP - missing ${role}_ACCOUNT_ID or _PRIVATE_KEY in .env`);
      continue;
    }

    const key = PrivateKey.fromStringECDSA(rawKey);
    const client = Client.forTestnet().setOperator(AccountId.fromString(accountId), key);

    try {
      const tx = await new TokenAssociateTransaction()
        .setAccountId(AccountId.fromString(accountId))
        .setTokenIds([tokenId])
        .freezeWith(client)
        .sign(key);

      const receipt = await (await tx.execute(client)).getReceipt(client);
      console.log(`  ${role.padEnd(7)} ${accountId.padEnd(14)} ${receipt.status.toString()}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Already associated is a success for our purposes - it means the account
      // can receive the token, which is the only thing we care about.
      if (msg.includes('TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT')) {
        console.log(`  ${role.padEnd(7)} ${accountId.padEnd(14)} ALREADY ASSOCIATED (fine)`);
      } else {
        console.log(`  ${role.padEnd(7)} ${accountId.padEnd(14)} FAILED - ${msg.split('\n')[0]}`);
      }
    } finally {
      client.close();
    }
  }

  console.log('\n  Done. Re-run the Circle faucet now - the transfer will land.\n');
}

main().catch((e) => { console.error(e); process.exit(1); });
