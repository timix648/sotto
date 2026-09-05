// BLUEPRINT.md section 3.7 - mock server.
// Full API surface of section 3.4 returning fixtures, plus a scripted RFQ that
// advances through EVERY state on a 90-second loop.
//
//   npm run mock   ->  http://localhost:4000   ws://localhost:4000/ws
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { randomUUID } from 'node:crypto';
import type {
  Rfq, QuoteCommit, QuoteReveal, Trade, AuditEvent, AuditKind, WsFrame, ErrorCode,
} from '../../../packages/shared/src/types.js';
import { computeCommit } from '../../../packages/shared/src/commit.js';
import { rfqIdToBytes32 } from '../../../packages/shared/src/rfq-id.js';
import * as F from './fixtures.js';

const PORT = Number(process.env.MOCK_PORT ?? 4000);
const now = () => Math.floor(Date.now() / 1000);
const hex64 = () => '0x' + randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');

type Cycle = {
  rfq: Rfq;
  commits: QuoteCommit[];
  reveals: QuoteReveal[];
  audit: AuditEvent[];
  award: { dealer: string; trade: Trade } | null;
  nonces: Record<string, `0x${string}`>;
};

const cycles: Cycle[] = [];
let seq = 1;
const sockets = new Set<{ send: (s: string) => void; rfqId?: string }>();

function broadcast(f: WsFrame, rfqId: string) {
  const msg = JSON.stringify(f);
  for (const s of sockets) {
    if (!s.rfqId || s.rfqId === rfqId) {
      try { s.send(msg); } catch { /* socket gone */ }
    }
  }
}

function audit(c: Cycle, kind: AuditKind, payload: Record<string, unknown> = {}): AuditEvent {
  const e: AuditEvent = {
    rfqId: c.rfq.id,
    kind,
    payload,
    hcsSequenceNumber: seq++,
    consensusTimestamp: now() + '.000000000',
    topicId: F.TOPIC_ID,
  };
  c.audit.push(e);
  broadcast({ type: 'audit', event: e }, c.rfq.id);
  return e;
}

function update(c: Cycle, status: Rfq['status']) {
  c.rfq.status = status;
  broadcast({ type: 'rfq.updated', rfq: c.rfq }, c.rfq.id);
}

const err = (code: ErrorCode, message: string, detail: Record<string, unknown> = {}) =>
  ({ error: { code, message, detail } });

// notional = price (6dp per 100 nominal) * quantity / 100
const notionalOf = (price: string, qty: string) => String((BigInt(price) * BigInt(qty)) / 100n);

// ------------------------------------------------------------ scripted loop
// Outcomes rotate so the frontend can reach every terminal state on demand:
//   cycle 0 -> SETTLED   cycle 1 -> FAILED   cycle 2 -> EXPIRED
let cycleIndex = 0;
const at = (ms: number, fn: () => void) => setTimeout(fn, ms);

function startCycle() {
  const outcome = (['SETTLED', 'FAILED', 'EXPIRED'] as const)[cycleIndex % 3];
  cycleIndex++;
  const t = now();
  const c: Cycle = {
    rfq: {
      id: randomUUID(),
      assetToken: F.ASSET_TOKEN,
      assetSymbol: F.ASSET_SYMBOL,
      partition: F.PARTITION,
      cashToken: F.CASH_TOKEN,
      quantity: '250',
      seller: F.SELLER,
      holdId: null,
      commitDeadline: t + 32,
      revealDeadline: t + 60,
      status: 'OPEN',
      createdAt: t,
      hcsSequenceNumber: null,
    },
    commits: [], reveals: [], audit: [], award: null, nonces: {},
  };
  cycles.unshift(c);
  if (cycles.length > 8) cycles.length = 8;

  c.rfq.hcsSequenceNumber = audit(c, 'RFQ_OPENED', {
    quantity: c.rfq.quantity, assetSymbol: F.ASSET_SYMBOL, outcome,
  }).hcsSequenceNumber;
  update(c, 'OPEN');

  at(1500, () => {
    c.rfq.holdId = 40000 + cycleIndex;
    audit(c, 'HOLD_PLACED', { holdId: c.rfq.holdId, amount: '250', escrow: F.SETTLEMENT });
    broadcast({ type: 'rfq.updated', rfq: c.rfq }, c.rfq.id);
  });

  // Commits: only the hash goes out. Prices stay sealed.
  F.DEALERS.forEach((d, i) => at(6000 + i * 5500, () => {
    const nonce = hex64().slice(0, 66) as `0x${string}`;
    c.nonces[d.addr] = nonce;
    const commitHash = computeCommit(BigInt(d.price), 250n, nonce, d.addr as `0x${string}`);
    const commit: QuoteCommit = {
      rfqId: c.rfq.id, dealer: d.addr, commitHash, submittedAt: now(), hcsSequenceNumber: null,
    };
    commit.hcsSequenceNumber = audit(c, 'QUOTE_COMMITTED', { dealer: d.addr, commitHash }).hcsSequenceNumber;
    c.commits.push(commit);
    broadcast({ type: 'quote.committed', rfqId: c.rfq.id, dealer: d.addr, commitHash, count: c.commits.length }, c.rfq.id);
  }));

  at(32000, () => {
    audit(c, 'WINDOW_CLOSED', { consensusTimestamp: now() + '.000000000' });
    broadcast({ type: 'window.closed', rfqId: c.rfq.id }, c.rfq.id);
    update(c, 'REVEALING');
  });

  if (outcome === 'EXPIRED') {
    at(62000, () => {
      audit(c, 'EXPIRED', { reason: 'no valid reveals before the deadline' });
      update(c, 'EXPIRED');
    });
    at(90000, startCycle);
    return;
  }

  // Three reveal; the fourth forfeits by never revealing.
  F.DEALERS.slice(0, 3).forEach((d, i) => at(38000 + i * 5000, () => {
    const r: QuoteReveal = {
      rfqId: c.rfq.id, dealer: d.addr, price: d.price,
      nonce: c.nonces[d.addr], valid: true, revealedAt: now(),
    };
    c.reveals.push(r);
    audit(c, 'QUOTE_REVEALED', { dealer: d.addr, price: d.price, valid: true });
    broadcast({ type: 'quote.revealed', rfqId: c.rfq.id, dealer: d.addr, price: d.price, valid: true }, c.rfq.id);
  }));

  at(55000, () => {
    const d = F.DEALERS[3];
    audit(c, 'REVEAL_FAILED', { dealer: d.addr, reason: 'no reveal before the deadline - quote forfeited' });
    broadcast({ type: 'quote.revealed', rfqId: c.rfq.id, dealer: d.addr, price: '0', valid: false }, c.rfq.id);
  });

  at(62000, () => {
    // best valid revealed price wins; tie -> earliest HCS sequence number
    const best = [...c.reveals].sort((a, b) => (BigInt(b.price) > BigInt(a.price) ? 1 : -1))[0];
    const trade: Trade = {
      rfqId: rfqIdToBytes32(c.rfq.id),
      assetToken: F.ASSET_TOKEN,
      partition: F.PARTITION,
      holdId: String(c.rfq.holdId),
      cashToken: F.CASH_TOKEN,
      seller: F.SELLER,
      buyer: best.dealer,
      quantity: c.rfq.quantity,
      notional: notionalOf(best.price, c.rfq.quantity),
      deadline: String(now() + 3600),
      nonce: '0',
    };
    c.award = { dealer: best.dealer, trade };
    audit(c, 'AWARDED', { dealer: best.dealer, price: best.price });
    broadcast({ type: 'awarded', rfqId: c.rfq.id, dealer: best.dealer, trade }, c.rfq.id);
    update(c, 'AWARDED');
  });

  at(74000, () => {
    if (outcome === 'SETTLED') {
      const txHash = hex64();
      audit(c, 'SETTLED', { txHash, notional: c.award?.trade.notional });
      broadcast({ type: 'settled', rfqId: c.rfq.id, txHash, hashscanUrl: 'https://hashscan.io/testnet/transaction/' + txHash }, c.rfq.id);
      update(c, 'SETTLED');
    } else {
      audit(c, 'SETTLEMENT_REVERTED', {
        reason: 'KYC_REJECTED',
        detail: 'buyer KYC revoked - executeHoldByPartition reverted; no cash moved, held balance unchanged',
      });
      broadcast({ type: 'reverted', rfqId: c.rfq.id, reason: 'KYC_REJECTED' }, c.rfq.id);
      update(c, 'FAILED');
    }
  });

  at(90000, startCycle);
}

// ------------------------------------------------------------ routes (3.4)
const app = Fastify({ logger: false });
await app.register(websocket);

app.addHook('onSend', async (_req, reply) => {
  reply.header('access-control-allow-origin', '*');
  reply.header('access-control-allow-headers', 'content-type');
  reply.header('access-control-allow-methods', 'GET,POST,OPTIONS');
});
app.options('/*', async (_req, reply) => reply.send());

const find = (id: string) => cycles.find(c => c.rfq.id === id);
const sameAddr = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

app.get('/api/health', async () => ({
  ok: true, network: 'testnet-mock', topicId: F.TOPIC_ID,
  settlementAddress: F.SETTLEMENT, blockHeight: 1000000 + seq, mock: true,
}));

app.get('/api/rfq', async (req) => {
  const status = (req.query as Record<string, string>)?.status;
  return cycles.map(c => c.rfq).filter(r => !status || r.status === status);
});

app.get('/api/rfq/:id', async (req, reply) => {
  const c = find((req.params as { id: string }).id);
  if (!c) return reply.code(404).send(err('HOLD_NOT_FOUND', 'no such rfq'));
  // Prices are never exposed while the commit window is still open.
  const sealed = c.rfq.status === 'OPEN';
  return {
    rfq: c.rfq,
    commits: c.commits,
    reveals: sealed ? [] : c.reveals,
    award: c.award,
    audit: c.audit,
  };
});

app.post('/api/rfq', async (req) => {
  const b = (req.body ?? {}) as Record<string, string>;
  const t = now();
  const c: Cycle = {
    rfq: {
      id: randomUUID(),
      assetToken: b.assetToken ?? F.ASSET_TOKEN,
      assetSymbol: F.ASSET_SYMBOL,
      partition: b.partition ?? F.PARTITION,
      cashToken: b.cashToken ?? F.CASH_TOKEN,
      quantity: String(b.quantity ?? '250'),
      seller: F.SELLER,
      holdId: null,
      commitDeadline: t + Number(b.commitWindowSecs ?? 32),
      revealDeadline: t + Number(b.revealWindowSecs ?? 60),
      status: 'OPEN', createdAt: t, hcsSequenceNumber: null,
    },
    commits: [], reveals: [], audit: [], award: null, nonces: {},
  };
  cycles.unshift(c);
  c.rfq.hcsSequenceNumber = audit(c, 'RFQ_OPENED', { quantity: c.rfq.quantity }).hcsSequenceNumber;
  return c.rfq;
});

app.post('/api/rfq/:id/hold', async (req, reply) => {
  const c = find((req.params as { id: string }).id);
  if (!c) return reply.code(404).send(err('HOLD_NOT_FOUND', 'no such rfq'));
  const b = (req.body ?? {}) as Record<string, string>;
  c.rfq.holdId = Number(b.holdId ?? 0);
  audit(c, 'HOLD_PLACED', { holdId: c.rfq.holdId, txHash: b.txHash });
  broadcast({ type: 'rfq.updated', rfq: c.rfq }, c.rfq.id);
  return c.rfq;
});

app.post('/api/rfq/:id/commit', async (req, reply) => {
  const c = find((req.params as { id: string }).id);
  if (!c) return reply.code(404).send(err('HOLD_NOT_FOUND', 'no such rfq'));
  if (c.rfq.status !== 'OPEN') {
    return reply.code(409).send(err('COMMIT_WINDOW_CLOSED', 'the commit window has closed'));
  }
  const b = (req.body ?? {}) as Record<string, string>;
  const commit: QuoteCommit = {
    rfqId: c.rfq.id, dealer: b.dealer, commitHash: b.commitHash,
    submittedAt: now(), hcsSequenceNumber: null,
  };
  commit.hcsSequenceNumber = audit(c, 'QUOTE_COMMITTED', { dealer: b.dealer, commitHash: b.commitHash }).hcsSequenceNumber;
  c.commits.push(commit);
  broadcast({ type: 'quote.committed', rfqId: c.rfq.id, dealer: b.dealer, commitHash: b.commitHash, count: c.commits.length }, c.rfq.id);
  return commit;
});

app.post('/api/rfq/:id/reveal', async (req, reply) => {
  const c = find((req.params as { id: string }).id);
  if (!c) return reply.code(404).send(err('HOLD_NOT_FOUND', 'no such rfq'));
  if (c.rfq.status !== 'REVEALING') {
    return reply.code(409).send(err('REVEAL_WINDOW_CLOSED', 'not in the reveal window'));
  }
  const b = (req.body ?? {}) as Record<string, string>;
  const commit = c.commits.find(x => sameAddr(x.dealer, b.dealer));
  const expected = commit
    ? computeCommit(BigInt(b.price), BigInt(c.rfq.quantity), b.nonce as `0x${string}`, b.dealer as `0x${string}`)
    : null;
  const valid = !!expected && !!commit && expected === commit.commitHash;
  const r: QuoteReveal = {
    rfqId: c.rfq.id, dealer: b.dealer, price: String(b.price),
    nonce: b.nonce, valid, revealedAt: now(),
  };
  c.reveals.push(r);
  audit(c, valid ? 'QUOTE_REVEALED' : 'REVEAL_FAILED', { dealer: b.dealer, price: r.price, valid });
  broadcast({ type: 'quote.revealed', rfqId: c.rfq.id, dealer: b.dealer, price: r.price, valid }, c.rfq.id);
  if (!valid) {
    return reply.code(409).send(err('COMMIT_MISMATCH', 'reveal does not match the commit hash', { expected }));
  }
  return r;
});

app.post('/api/rfq/:id/award', async (req, reply) => {
  const c = find((req.params as { id: string }).id);
  if (!c) return reply.code(404).send(err('HOLD_NOT_FOUND', 'no such rfq'));
  const dealer = ((req.body ?? {}) as Record<string, string>).dealer;
  const win = c.reveals.find(r => sameAddr(r.dealer, dealer) && r.valid);
  if (!win) return reply.code(409).send(err('COMMIT_MISMATCH', 'no valid revealed quote for that dealer'));
  const trade: Trade = {
    rfqId: rfqIdToBytes32(c.rfq.id),
    assetToken: c.rfq.assetToken,
    partition: c.rfq.partition,
    holdId: String(c.rfq.holdId ?? 0),
    cashToken: c.rfq.cashToken,
    seller: c.rfq.seller,
    buyer: win.dealer,
    quantity: c.rfq.quantity,
    notional: notionalOf(win.price, c.rfq.quantity),
    deadline: String(now() + 3600),
    nonce: '0',
  };
  c.award = { dealer: win.dealer, trade };
  audit(c, 'AWARDED', { dealer: win.dealer, price: win.price });
  broadcast({ type: 'awarded', rfqId: c.rfq.id, dealer: win.dealer, trade }, c.rfq.id);
  update(c, 'AWARDED');
  return { trade, digest: rfqIdToBytes32(c.rfq.id) };
});

app.post('/api/rfq/:id/settle', async (req, reply) => {
  const c = find((req.params as { id: string }).id);
  if (!c) return reply.code(404).send(err('HOLD_NOT_FOUND', 'no such rfq'));
  const txHash = hex64();
  audit(c, 'SETTLED', { txHash });
  broadcast({ type: 'settled', rfqId: c.rfq.id, txHash, hashscanUrl: 'https://hashscan.io/testnet/transaction/' + txHash }, c.rfq.id);
  update(c, 'SETTLED');
  return { txHash, status: 'SETTLED' };
});

app.get('/api/rfq/:id/audit', async (req, reply) => {
  const c = find((req.params as { id: string }).id);
  if (!c) return reply.code(404).send(err('HOLD_NOT_FOUND', 'no such rfq'));
  return c.audit;
});

app.get('/api/assets', async () => F.ASSETS);

app.post('/api/admin/issue', async () => ({ assetToken: F.ASSET_TOKEN, txHash: hex64() }));

app.post('/api/admin/kyc', async (req) => ({
  txHash: hex64(), ...(req.body as Record<string, unknown>),
}));

// B2's position card: Total / Available / Held / Locked
app.get('/api/balances/:account', async (req) => {
  const live = cycles.find(c => ['OPEN', 'REVEALING', 'AWARDED'].includes(c.rfq.status));
  const held = live ? 250 : 0;
  return {
    account: (req.params as { account: string }).account,
    assetToken: F.ASSET_TOKEN, symbol: F.ASSET_SYMBOL,
    total: '1000', available: String(1000 - held), held: String(held), locked: '0',
  };
});

// ------------------------------------------------------------ websocket (3.5)
app.get('/ws', { websocket: true }, (socket) => {
  const entry: { send: (s: string) => void; rfqId?: string } = { send: (s) => socket.send(s) };
  sockets.add(entry);
  socket.on('message', (raw: Buffer) => {
    try {
      const m = JSON.parse(raw.toString());
      if (m.type === 'subscribe') entry.rfqId = m.rfqId;
    } catch { /* ignore malformed frame */ }
  });
  socket.on('close', () => sockets.delete(entry));
});

startCycle();
await app.listen({ port: PORT, host: '0.0.0.0' });
console.log('\n  Sotto mock server  ->  http://localhost:' + PORT);
console.log('  websocket          ->  ws://localhost:' + PORT + '/ws');
console.log('  scripted RFQ       ->  90s loop, rotating SETTLED / FAILED / EXPIRED\n');
