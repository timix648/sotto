// The real API server. Same surface as the mock (BLUEPRINT section 3.4/3.5/3.6),
// backed by the live RFQ engine, the live HCS topic and Hedera testnet - so the
// frontend swaps MOCK_MODE off and changes nothing else.
//
//   npm run serve
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { HcsAudit } from './hcs/client.js';
import { RfqEngine, RfqError } from './rfq/engine.js';
import { Chain, PARTITION_DEFAULT } from './chain/index.js';
import type { WsFrame, Rfq } from '../../packages/shared/src/types.js';

const PORT = Number(process.env.PORT ?? 4000);

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch { /* no .env - env vars only */ }
  return { ...out, ...process.env } as Record<string, string>;
}

const env = loadEnv();
const CASH = env.CASH_TOKEN_EVM ?? '0x0000000000000000000000000000000000068cDa';

const chain = new Chain({
  rpcUrl: env.JSON_RPC_URL ?? 'https://testnet.hashio.io/api',
  mirrorUrl: 'https://testnet.mirrornode.hedera.com/api/v1',
  bondAddress: env.BOND_ADDRESS,
  settlementAddress: env.SETTLEMENT_ADDRESS,
  cashAddress: CASH,
  issuerKey: env.ISSUER_PRIVATE_KEY,
});

const hcs = new HcsAudit({
  operatorId: env.ISSUER_ACCOUNT_ID,
  operatorKey: env.ISSUER_PRIVATE_KEY,
  topicId: env.HCS_TOPIC_ID,
});

const engine = new RfqEngine((id, kind, payload) => hcs.write(id, kind, payload));

// ---------------------------------------------------------------- websocket
const sockets = new Set<{ send: (s: string) => void; rfqId?: string }>();
function broadcast(f: WsFrame, rfqId: string) {
  const msg = JSON.stringify(f);
  for (const s of sockets) {
    if (!s.rfqId || s.rfqId === rfqId) { try { s.send(msg); } catch { /* gone */ } }
  }
}
const pushRfq = (rfq: Rfq) => broadcast({ type: 'rfq.updated', rfq }, rfq.id);

const app = Fastify({ logger: false });
await app.register(websocket);

app.addHook('onSend', async (_req, reply) => {
  reply.header('access-control-allow-origin', '*');
  reply.header('access-control-allow-headers', 'content-type');
  reply.header('access-control-allow-methods', 'GET,POST,OPTIONS');
});
app.options('/*', async (_req, reply) => reply.send());

// Map engine errors onto section 3.6's envelope.
app.setErrorHandler((err, _req, reply) => {
  if (err instanceof RfqError) {
    return reply.code(409).send({ error: { code: err.code, message: err.message, detail: err.detail } });
  }
  return reply.code(500).send({ error: { code: 'SETTLEMENT_REVERTED', message: err.message, detail: {} } });
});

// ---------------------------------------------------------------- routes
app.get('/api/health', async () => ({
  ok: true,
  network: 'testnet',
  mock: false,
  topicId: hcs.topicId,
  topicUrl: hcs.hashscanUrl,
  settlementAddress: env.SETTLEMENT_ADDRESS,
  assetToken: env.BOND_ADDRESS,
  cashToken: CASH,
  schedulerAddress: env.SCHEDULER_ADDRESS ?? null,
  blockHeight: await chain.blockHeight(),
}));

app.get('/api/assets', async () => {
  const a = await chain.asset();
  return [{ ...a, partition: PARTITION_DEFAULT, cashToken: CASH }];
});

app.get('/api/balances/:account', async (req) => {
  const { account } = req.params as { account: string };
  const b = await chain.balances(account);
  return { ...b, kyc: await chain.kycStatus(account) };
});

app.get('/api/rfq', async (req) => {
  const status = (req.query as Record<string, string>)?.status as Rfq['status'] | undefined;
  return engine.list(status);
});

app.get('/api/rfq/:id', async (req) => engine.view((req.params as { id: string }).id));

app.get('/api/rfq/:id/audit', async (req) => {
  const r = engine.get((req.params as { id: string }).id);
  return { topicId: hcs.topicId, topicUrl: hcs.hashscanUrl, events: r.audit };
});

app.post('/api/rfq', async (req) => {
  const b = (req.body ?? {}) as Record<string, string | number>;
  const asset = await chain.asset();
  const rfq = await engine.open({
    assetToken: env.BOND_ADDRESS,
    assetSymbol: asset.symbol,
    partition: String(b.partition ?? PARTITION_DEFAULT),
    cashToken: CASH,
    quantity: String(b.quantity ?? '20'),
    seller: String(b.seller ?? env.SELLER_ADDRESS),
    commitWindowSecs: Number(b.commitWindowSecs ?? 120),
    revealWindowSecs: Number(b.revealWindowSecs ?? 120),
  });
  pushRfq(rfq);
  return rfq;
});

app.post('/api/rfq/:id/hold', async (req) => {
  const { id } = req.params as { id: string };
  const b = (req.body ?? {}) as Record<string, string | number>;
  const rfq = engine.get(id).rfq;

  // Trust but verify: if the client did not supply a holdId, find it on-chain.
  let holdId = b.holdId !== undefined ? Number(b.holdId) : null;
  if (holdId === null) holdId = await chain.findHold(rfq.seller, BigInt(rfq.quantity), rfq.partition);
  if (holdId === null) {
    return { error: { code: 'HOLD_NOT_FOUND', message: 'no hold escrowed to the settlement contract', detail: {} } };
  }
  const hold = await chain.readHold(rfq.seller, holdId, rfq.partition);
  if (!hold.isEscrowedHere) {
    return { error: { code: 'HOLD_NOT_FOUND', message: 'hold is not escrowed to this venue', detail: hold } };
  }
  const updated = await engine.recordHold(id, holdId, b.txHash as string | undefined);
  pushRfq(updated);
  return { ...updated, hold };
});

app.post('/api/rfq/:id/commit', async (req) => {
  const { id } = req.params as { id: string };
  const b = (req.body ?? {}) as Record<string, string>;
  const c = await engine.commit(id, b.dealer, b.commitHash);
  broadcast({ type: 'quote.committed', rfqId: id, dealer: b.dealer, commitHash: b.commitHash, count: engine.get(id).commits.length }, id);
  return c;
});

app.post('/api/rfq/:id/close', async (req) => {
  const { id } = req.params as { id: string };
  const rfq = await engine.closeWindow(id);
  broadcast({ type: 'window.closed', rfqId: id }, id);
  pushRfq(rfq);
  return rfq;
});

app.post('/api/rfq/:id/reveal', async (req) => {
  const { id } = req.params as { id: string };
  const b = (req.body ?? {}) as Record<string, string>;
  const r = await engine.reveal(id, b.dealer, b.price, b.nonce as `0x${string}`);
  broadcast({ type: 'quote.revealed', rfqId: id, dealer: r.dealer, price: r.price, valid: r.valid }, id);
  return r;
});

app.post('/api/rfq/:id/award', async (req) => {
  const { id } = req.params as { id: string };
  const { dealer, trade } = await engine.award(id, env.SETTLEMENT_ADDRESS);
  broadcast({ type: 'awarded', rfqId: id, dealer, trade }, id);
  pushRfq(engine.get(id).rfq);
  return { trade, digest: trade.rfqId };
});

app.post('/api/rfq/:id/settle', async (req) => {
  const { id } = req.params as { id: string };
  const b = (req.body ?? {}) as Record<string, unknown>;
  const rec = engine.get(id);
  const trade = (b.trade as Record<string, unknown>) ?? rec.award?.trade;
  if (!trade) throw new RfqError('HOLD_NOT_FOUND', 'no awarded trade to settle');

  try {
    const tx = await chain.settlement.settle(trade, b.sellerSig, b.buyerSig, { gasLimit: 4_000_000 });
    const receipt = await tx.wait();
    if (receipt?.status !== 1) throw new Error('transaction status 0');

    const rfq = await engine.markSettled(id, tx.hash);
    broadcast({ type: 'settled', rfqId: id, txHash: tx.hash, hashscanUrl: `https://hashscan.io/testnet/transaction/${tx.hash}` }, id);
    pushRfq(rfq);
    return { txHash: tx.hash, status: 'SETTLED' };
  } catch (e) {
    const reason = e instanceof Error ? e.message.split('\n')[0] : String(e);
    const rfq = await engine.markReverted(id, reason);
    broadcast({ type: 'reverted', rfqId: id, reason }, id);
    pushRfq(rfq);
    return { status: 'FAILED', reason };
  }
});

// admin
app.post('/api/admin/kyc', async (req) => {
  const b = (req.body ?? {}) as { account: string; granted: boolean };
  const txHash = await chain.setKyc(b.account, b.granted);
  return { txHash, account: b.account, granted: b.granted, status: await chain.kycStatus(b.account) };
});

app.post('/api/admin/issue', async (req) => {
  const b = (req.body ?? {}) as { to: string; amount: string };
  const tx = await chain.bond.issueByPartition(
    { partition: PARTITION_DEFAULT, tokenHolder: b.to, value: BigInt(b.amount), data: '0x' },
    { gasLimit: 3_000_000 }
  );
  await tx.wait();
  return { assetToken: env.BOND_ADDRESS, txHash: tx.hash };
});

app.get('/ws', { websocket: true }, (socket) => {
  const entry: { send: (s: string) => void; rfqId?: string } = { send: (s) => socket.send(s) };
  sockets.add(entry);
  socket.on('message', (raw: Buffer) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === 'subscribe') entry.rfqId = m.rfqId;
    } catch { /* ignore */ }
  });
  socket.on('close', () => sockets.delete(entry));
});

// ------------------------------------------------- A6: mirror-node reconcile
// The receipt says a transaction committed; it does not say the state is
// visible. Confirm optimistically on the receipt above, reconcile here after.
const seen = new Set<string>();
setInterval(async () => {
  try {
    for (const ev of await chain.settledEvents()) {
      if (seen.has(ev.txHash)) continue;
      seen.add(ev.txHash);
      broadcast({ type: 'audit', event: {
        rfqId: ev.rfqId, kind: 'SETTLED',
        payload: { txHash: ev.txHash, blockNumber: ev.blockNumber, source: 'mirror-reconcile' },
        hcsSequenceNumber: 0, consensusTimestamp: '', topicId: hcs.topicId ?? '',
      } }, ev.rfqId);
    }
  } catch { /* mirror lag or transient RPC - never let the poller kill the server */ }
}, 5000).unref();

await app.listen({ port: PORT, host: '0.0.0.0' });
console.log(`\n  Sotto API (LIVE)  ->  http://localhost:${PORT}`);
console.log(`  websocket         ->  ws://localhost:${PORT}/ws`);
console.log(`  bond              ->  ${env.BOND_ADDRESS}`);
console.log(`  settlement        ->  ${env.SETTLEMENT_ADDRESS}`);
console.log(`  hcs topic         ->  ${hcs.topicId}\n`);
