// Create the HCS audit topic (once) and write a full RFQ lifecycle to it.
//
//   npx tsx backend/src/scripts/hcs-demo.ts
//
// Proves the ordering property the design rests on: every commit hash is
// timestamped by consensus BEFORE any price is revealed. Sequence numbers and
// consensus timestamps come back from the network, not from our clock.
import { readFileSync, writeFileSync } from 'node:fs';
import { HcsAudit } from '../hcs/client.js';
import { computeCommit } from '../../../packages/shared/src/commit.js';
import type { AuditEvent } from '../../../packages/shared/src/types.js';

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
  const hcs = new HcsAudit({
    operatorId: env.ISSUER_ACCOUNT_ID,
    operatorKey: env.ISSUER_PRIVATE_KEY,
    topicId: env.HCS_TOPIC_ID || undefined,
  });

  if (!hcs.topicId) {
    console.log('\n  creating audit topic...');
    const id = await hcs.createTopic();
    upsertEnv('HCS_TOPIC_ID', id);
    console.log(`  topic ${id}  (written to .env)`);
  } else {
    console.log(`\n  using existing topic ${hcs.topicId}`);
  }
  console.log(`  ${hcs.hashscanUrl}\n`);

  const rfqId = crypto.randomUUID();
  const dealers = [
    { addr: '0xd49B230C1985833a277B25ed9a682C4e49845cBe', price: 98_200_000n },
    { addr: '0x7a9F4C2e18bD35604F3Ae9c07b21D8FE6A0C4471', price: 98_350_000n },
    { addr: '0x2e5C81BA9D47F03e6C1b85ad0392FC7B41EE9d20', price: 98_110_000n },
  ];
  const qty = 20n;
  const events: AuditEvent[] = [];
  const log = (e: AuditEvent) => {
    events.push(e);
    console.log(`  HCS#${String(e.hcsSequenceNumber).padStart(3)}  ${e.consensusTimestamp}  ${e.kind}`);
  };

  log(await hcs.write(rfqId, 'RFQ_OPENED', { assetSymbol: 'STO-BOND-A', quantity: qty.toString() }));
  log(await hcs.write(rfqId, 'HOLD_PLACED', { holdId: 1, amount: qty.toString(), escrow: env.SETTLEMENT_ADDRESS }));

  // Commits: only the hash goes on the ledger. No price is readable yet.
  const nonces: Record<string, `0x${string}`> = {};
  for (const d of dealers) {
    const nonce = ('0x' + crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '')).slice(0, 66) as `0x${string}`;
    nonces[d.addr] = nonce;
    const commitHash = computeCommit(d.price, qty, nonce, d.addr as `0x${string}`);
    log(await hcs.write(rfqId, 'QUOTE_COMMITTED', { dealer: d.addr, commitHash }));
  }

  log(await hcs.write(rfqId, 'WINDOW_CLOSED', {}));

  // Reveals: now the prices appear - strictly after every commit's timestamp.
  for (const d of dealers) {
    log(await hcs.write(rfqId, 'QUOTE_REVEALED', { dealer: d.addr, price: d.price.toString(), nonce: nonces[d.addr], valid: true }));
  }

  const best = dealers.reduce((a, b) => (b.price > a.price ? b : a));
  log(await hcs.write(rfqId, 'AWARDED', { dealer: best.addr, price: best.price.toString() }));
  log(await hcs.write(rfqId, 'SETTLED', {
    txHash: '0x4c90cf5b62ed65ebdabb7621bb76c80596cd78dc29cf2303c68b3ccbcab552fd',
    quantity: qty.toString(), notional: '19670000',
  }));

  // The integrity property, checked rather than asserted.
  const lastCommit = events.filter(e => e.kind === 'QUOTE_COMMITTED').at(-1)!;
  const firstReveal = events.find(e => e.kind === 'QUOTE_REVEALED')!;
  const ok = lastCommit.hcsSequenceNumber < firstReveal.hcsSequenceNumber;

  console.log(`\n  rfqId ${rfqId}`);
  console.log(`  ${events.length} events, HCS #${events[0].hcsSequenceNumber}-#${events.at(-1)!.hcsSequenceNumber}`);
  console.log(`\n  every commit timestamped before any reveal: ${ok ? 'YES' : 'NO'}`);
  console.log(`    last commit  HCS#${lastCommit.hcsSequenceNumber} @ ${lastCommit.consensusTimestamp}`);
  console.log(`    first reveal HCS#${firstReveal.hcsSequenceNumber} @ ${firstReveal.consensusTimestamp}`);
  console.log('\n  No dealer could read a rival price before committing its own.\n');

  hcs.close();
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error('\n  FAILED:', e instanceof Error ? e.message.split('\n')[0] : e);
  process.exit(1);
});
