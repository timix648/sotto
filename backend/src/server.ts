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
import { Chain, PARTITION_DEFAULT, BOND_ABI as ISSUE_ABI, SETTLEMENT_ABI } from './chain/index.js';
import { BatchRelay } from './chain/batch.js';
import { eip712Domain, TRADE_TYPES } from '../../packages/shared/src/eip712.js';
import type { WsFrame, Rfq, Trade } from '../../packages/shared/src/types.js';

const PORT = Number(process.env.PORT ?? 4000);
/**
 * Bind address. Defaults to 0.0.0.0 so `npm run serve` is reachable in local
 * development without ceremony. Behind a TLS terminator set HOST=127.0.0.1, so
 * the proxy is the only way in — otherwise the API keeps answering plaintext on
 * the public interface even with a certificate sitting in front of it.
 */
const HOST = process.env.HOST ?? '0.0.0.0';

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
  navOracleAddress: env.NAV_ORACLE_ADDRESS,
  shortBondAddress: env.SHORT_BOND_ADDRESS,
});

const hcs = new HcsAudit({
  operatorId: env.ISSUER_ACCOUNT_ID,
  operatorKey: env.ISSUER_PRIVATE_KEY,
  topicId: env.HCS_TOPIC_ID,
});

const engine = new RfqEngine((id, kind, payload) => hcs.write(id, kind, payload));

/**
 * Path B relay. The venue holds the batchKey and assembles; each party signs
 * only its own leg. Absent when there is no operator account configured, in
 * which case the Path B routes report that plainly rather than half-working.
 */
const batchRelay = env.ISSUER_ACCOUNT_ID && env.ISSUER_PRIVATE_KEY
  ? new BatchRelay({
      operatorId: env.ISSUER_ACCOUNT_ID,
      operatorKey: env.ISSUER_PRIVATE_KEY,
      cashTokenId: env.USDC_TOKEN_ID ?? '0.0.429274',
      settlementAddress: env.SETTLEMENT_ADDRESS,
      mirrorUrl: 'https://testnet.mirrornode.hedera.com/api/v1',
    })
  : null;
const settlementIface = new ethers.Interface(SETTLEMENT_ABI);
const sellerSignatures = new Map<string, Map<string, string>>();
const settledFillNonces = new Map<string, Set<string>>();

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
  const message = err instanceof Error ? err.message : String(err);
  return reply.code(500).send({ error: { code: 'SETTLEMENT_REVERTED', message, detail: {} } });
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
  bondAddress: env.BOND_ADDRESS,
  equityAddress: env.EQUITY_ADDRESS ?? null,
  shortBondAddress: env.SHORT_BOND_ADDRESS ?? null,
  navOracleAddress: env.NAV_ORACLE_ADDRESS ?? null,
  dealerBondAddress: env.DEALER_BOND_ADDRESS ?? null,
  priceSourceAddress: env.PRICE_SOURCE_ADDRESS ?? null,
  cashToken: CASH,
  cashTokenId: env.USDC_TOKEN_ID ?? null,
  cashDecimals: 6,
  schedulerAddress: env.SCHEDULER_ADDRESS ?? null,
  accounts: {
    issuer: env.ISSUER_ADDRESS ?? null,
    seller: env.SELLER_ADDRESS ?? null,
    dealer: env.DEALER_ADDRESS ?? null,
  },
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

app.get('/api/rfq/:id', async (req) => {
  const id = (req.params as { id: string }).id;
  return {
    ...engine.view(id),
    sellerSignatures: Object.fromEntries(sellerSignatures.get(id) ?? []),
    settledFillNonces: [...(settledFillNonces.get(id) ?? [])],
  };
});

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
    throw new RfqError('HOLD_NOT_FOUND', 'no hold escrowed to the settlement contract');
  }
  const hold = await chain.readHold(rfq.seller, holdId, rfq.partition);
  if (!hold.isEscrowedHere) {
    throw new RfqError('HOLD_NOT_FOUND', 'hold is not escrowed to this venue', hold);
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
  const r = await engine.reveal(
    id, b.dealer, b.price, b.nonce as `0x${string}`,
    b.firmnessSecs ? Number(b.firmnessSecs) : undefined,
    // Omitted = bid for the whole block, which is what every quote was before
    // partial fills existed.
    b.quantity, b.minQuantity
  );
  broadcast({
    type: 'quote.revealed', rfqId: id, dealer: r.dealer, price: r.price,
    quantity: r.quantity, valid: r.valid,
  }, id);
  return r;
});

app.post('/api/rfq/:id/award', async (req) => {
  const { id } = req.params as { id: string };
  const b = (req.body ?? {}) as Record<string, unknown>;
  // A block may fill across several dealers. Each fill is its own Trade with
  // its own nonce, and SottoSettlement marks a nonce used for BOTH parties -
  // so N fills against one seller need N distinct nonces. Start from the
  // seller's current on-chain nonce so a replay of an earlier RFQ's trade
  // cannot collide with this one.
  const seller = engine.get(id).rfq.seller;
  const nonceBase = b.nonceBase !== undefined
    ? Number(b.nonceBase)
    : Number(await chain.settlement.nonces(seller));
  const { dealer, trade, fills } = await engine.award(id, env.SETTLEMENT_ADDRESS, undefined, nonceBase);
  const rfq = engine.get(id).rfq;
  broadcast({ type: 'awarded', rfqId: id, dealer, trade, fills, filled: rfq.filled, unfilled: rfq.unfilled }, id);
  pushRfq(rfq);
  return { trade, fills, filled: rfq.filled, unfilled: rfq.unfilled, digest: trade.rfqId };
});

app.post('/api/rfq/:id/seller-signature', async (req) => {
  const { id } = req.params as { id: string };
  const b = (req.body ?? {}) as { nonce: string; signature: string };
  const rec = engine.get(id);
  const trade = rec.fills.find((fill) => fill.trade.nonce === String(b.nonce))?.trade as Trade | undefined;
  if (!trade) throw new RfqError('SIGNATURE_INVALID', 'no awarded fill matches that trade nonce');

  let recovered: string;
  try {
    recovered = ethers.verifyTypedData(
      eip712Domain(env.SETTLEMENT_ADDRESS as `0x${string}`),
      TRADE_TYPES as unknown as Record<string, Array<ethers.TypedDataField>>,
      trade,
      b.signature
    );
  } catch {
    throw new RfqError('SIGNATURE_INVALID', 'seller signature is malformed');
  }
  if (recovered.toLowerCase() !== trade.seller.toLowerCase()) {
    throw new RfqError('SIGNATURE_INVALID', 'signature did not recover to the RFQ seller');
  }

  const byNonce = sellerSignatures.get(id) ?? new Map<string, string>();
  byNonce.set(trade.nonce, b.signature);
  sellerSignatures.set(id, byNonce);
  return { ok: true, nonce: trade.nonce };
});

/**
 * What a browser needs to build an inner cash leg this venue can batch: the
 * batchKey to name, the token to move, and who is assembling.
 */
app.get('/api/batch/params', async () => {
  if (!batchRelay) throw new RfqError('SETTLEMENT_REVERTED', 'Path B is not configured on this server');
  const p = batchRelay.params();
  return { ...p, available: true };
});

/** Hedera account id for an EVM address - an HTS transfer needs the account id. */
app.get('/api/batch/account/:evm', async (req) => {
  if (!batchRelay) throw new RfqError('SETTLEMENT_REVERTED', 'Path B is not configured on this server');
  const { evm } = req.params as { evm: string };
  return { evmAddress: evm, accountId: await batchRelay.accountIdFor(evm) };
});

/**
 * Path B settlement. The buyer has already signed a native HTS transfer of
 * their own cash; the venue verifies it says what the trade says, wraps it with
 * the delivery call, and submits the pair atomically.
 *
 * No allowance is granted anywhere, and the venue never holds either asset.
 */
app.post('/api/rfq/:id/settle-batch', async (req) => {
  if (!batchRelay) throw new RfqError('SETTLEMENT_REVERTED', 'Path B is not configured on this server');
  const { id } = req.params as { id: string };
  const b = (req.body ?? {}) as {
    trade?: Trade; sellerSig?: string; buyerSig?: string; innerCashTxBase64?: string;
  };
  const rec = engine.get(id);
  const trade = b.trade ?? rec.award?.trade;
  if (!trade) throw new RfqError('HOLD_NOT_FOUND', 'no awarded trade to settle');
  if (!b.sellerSig || !b.buyerSig) throw new RfqError('SIGNATURE_INVALID', 'both signatures are required');
  if (!b.innerCashTxBase64) throw new RfqError('SIGNATURE_INVALID', 'the buyer-signed cash leg is required');

  // Same guards as Path A: it must be an awarded fill, and it must not already
  // have settled down either path. The nonce space is shared on-chain too.
  const awarded = rec.fills.some((fill) => fill.trade.nonce === trade.nonce);
  if (!awarded) throw new RfqError('SIGNATURE_INVALID', 'trade is not an awarded fill for this RFQ');
  const completed = settledFillNonces.get(id) ?? new Set<string>();
  if (completed.has(trade.nonce)) {
    throw new RfqError('SETTLEMENT_REVERTED', 'this awarded fill is already settled');
  }

  try {
    const result = await batchRelay.settle({
      tradeTuple: [
        trade.rfqId, trade.assetToken, trade.partition, trade.holdId, trade.cashToken,
        trade.seller, trade.buyer, trade.quantity, trade.notional, trade.deadline, trade.nonce,
      ],
      sellerSig: b.sellerSig,
      buyerSig: b.buyerSig,
      innerCashTxBase64: b.innerCashTxBase64,
      buyerEvm: trade.buyer,
      sellerEvm: trade.seller,
      notional: BigInt(trade.notional),
      settlementIface,
    });

    completed.add(trade.nonce);
    settledFillNonces.set(id, completed);
    const allSettled = rec.fills.every((fill) => completed.has(fill.trade.nonce));
    const rfq = allSettled ? await engine.markSettled(id, result.transactionId) : rec.rfq;
    if (!allSettled) {
      rec.audit.push(await hcs.write(id, 'SETTLED', {
        txHash: result.transactionId, nonce: trade.nonce, dealer: trade.buyer,
        quantity: trade.quantity, path: 'B', partial: true,
      }));
    }
    broadcast({
      type: 'settled', rfqId: id, txHash: result.transactionId, hashscanUrl: result.hashscanUrl,
    }, id);
    if (allSettled) pushRfq(rfq);

    return {
      ...result,
      path: 'B',
      status: allSettled ? 'SETTLED' : 'PARTIALLY_SETTLED',
      batchStatus: result.status,
      settledFillNonces: [...completed],
    };
  } catch (e) {
    const reason = e instanceof Error ? e.message.split('\n')[0] : String(e);
    const rfq = await engine.markReverted(id, reason);
    broadcast({ type: 'reverted', rfqId: id, reason }, id);
    pushRfq(rfq);
    return { status: 'FAILED', path: 'B', reason };
  }
});

app.post('/api/rfq/:id/settle', async (req) => {
  const { id } = req.params as { id: string };
  const b = (req.body ?? {}) as Record<string, unknown>;
  const rec = engine.get(id);
  const trade = (b.trade as Trade | undefined) ?? rec.award?.trade;
  if (!trade) throw new RfqError('HOLD_NOT_FOUND', 'no awarded trade to settle');
  const awarded = rec.fills.some((fill) => fill.trade.nonce === trade.nonce);
  if (!awarded) throw new RfqError('SIGNATURE_INVALID', 'trade is not an awarded fill for this RFQ');
  const completed = settledFillNonces.get(id) ?? new Set<string>();
  if (completed.has(trade.nonce)) {
    throw new RfqError('SETTLEMENT_REVERTED', 'this awarded fill is already settled');
  }

  try {
    const tx = await chain.settlement.settle(trade, b.sellerSig, b.buyerSig, { gasLimit: 4_000_000 });
    const receipt = await tx.wait();
    if (receipt?.status !== 1) throw new Error('transaction status 0');

    completed.add(trade.nonce);
    settledFillNonces.set(id, completed);
    const allSettled = rec.fills.every((fill) => completed.has(fill.trade.nonce));
    const rfq = allSettled
      ? await engine.markSettled(id, tx.hash)
      : rec.rfq;
    if (!allSettled) {
      rec.audit.push(await hcs.write(id, 'SETTLED', {
        txHash: tx.hash,
        nonce: trade.nonce,
        dealer: trade.buyer,
        quantity: trade.quantity,
        partial: true,
      }));
    }
    broadcast({ type: 'settled', rfqId: id, txHash: tx.hash, hashscanUrl: `https://hashscan.io/testnet/transaction/${tx.hash}` }, id);
    if (allSettled) pushRfq(rfq);
    return {
      txHash: tx.hash,
      status: allSettled ? 'SETTLED' : 'PARTIALLY_SETTLED',
      settledFillNonces: [...completed],
    };
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

/**
 * The band guard's reference for an asset, with its age.
 *
 * This exists so a stale reference is visible BEFORE anyone signs. Without it
 * the first sign of trouble is a settlement reverting at ~59,000 gas with
 * nothing readable in the message, which looks like a broken venue rather than
 * a working control.
 */
app.get('/api/nav/:token', async (req) => {
  const { token } = req.params as { token: string };
  const state = await chain.navState(token === 'default' ? env.BOND_ADDRESS : token);
  if (!state) throw new RfqError('SETTLEMENT_REVERTED', 'no NAV oracle is configured');
  return state;
});

/**
 * Publish an administrator NAV.
 *
 * Deliberately a deliberate act, and deliberately not on a timer. An automated
 * re-stamp of an unchanging number would leave the staleness guard looking
 * intact on-chain while making it impossible for it ever to fire - a weaker
 * control than the 24h bound, and an invisible one. A fund administrator
 * strikes a NAV and publishes it; this is that.
 */
app.post('/api/admin/nav', async (req) => {
  const b = (req.body ?? {}) as { assetToken?: string; price?: string; decimals?: number };
  const assetToken = b.assetToken || env.BOND_ADDRESS;
  if (!b.price) throw new RfqError('SETTLEMENT_REVERTED', 'a price is required');

  let price: bigint;
  try {
    price = BigInt(b.price);
  } catch {
    throw new RfqError('SETTLEMENT_REVERTED', 'price must be an integer in cash base units');
  }
  if (price <= 0n) throw new RfqError('SETTLEMENT_REVERTED', 'price must be greater than zero');

  const txHash = await chain.publishNav(assetToken, price, Number(b.decimals ?? 6));
  return { txHash, assetToken, nav: await chain.navState(assetToken) };
});

/** Redemption state for one holder: maturity, units, principal owed. */
app.get('/api/lifecycle/:token', async (req) => {
  const { token } = req.params as { token: string };
  const q = (req.query ?? {}) as Record<string, string>;
  const assetToken = chain.redemptionToken(token === 'default' ? null : token);
  const holder = q.holder || env.SELLER_ADDRESS;
  return chain.lifecycleState(assetToken, holder);
});

/**
 * Redeem a holder out at maturity. Principal first, then the burn - see
 * Chain.redeemAtMaturity for why that order is load-bearing.
 */
app.post('/api/admin/redeem', async (req) => {
  const b = (req.body ?? {}) as { assetToken?: string; holder?: string };
  const assetToken = chain.redemptionToken(b.assetToken);
  const holder = b.holder || env.SELLER_ADDRESS;

  let result;
  try {
    result = await chain.redeemAtMaturity(assetToken, holder);
  } catch (e) {
    // Maturity, funding and empty-position refusals are all expected states, not
    // server faults - surface them as 409s so the portal can explain them.
    throw new RfqError('SETTLEMENT_REVERTED', e instanceof Error ? e.message : String(e), { assetToken, holder });
  }

  const lifecycle = await chain.lifecycleState(assetToken, holder);
  // A redemption is a lifecycle event and belongs on the same consensus-ordered
  // log as the trades that preceded it.
  try {
    await hcs.write(`redeem-${assetToken.slice(2, 10)}`, 'REDEEMED', {
      token: assetToken,
      holder,
      units: result.unitsBurned,
      principal: result.principalPaid,
      redeemTx: result.redeemTxHash,
      cashTx: result.cashTxHash,
    });
  } catch { /* the redemption happened; an audit write failing must not undo it */ }

  return { ...result, assetToken, holder, lifecycle };
});

app.post('/api/admin/issue', async (req) => {
  const b = (req.body ?? {}) as { to: string; amount: string; assetToken?: string };
  // Defaults to the primary bond. The short-dated note is a valid target too:
  // redeeming burns its whole supply, so demonstrating redemption twice needs a
  // way to reload it that is not a script.
  const assetToken = b.assetToken ? ethers.getAddress(b.assetToken) : env.BOND_ADDRESS;
  const token = assetToken.toLowerCase() === env.BOND_ADDRESS.toLowerCase()
    ? chain.bond
    : new ethers.Contract(assetToken, ISSUE_ABI, chain.issuer);

  const tx = await token.issueByPartition(
    { partition: PARTITION_DEFAULT, tokenHolder: b.to, value: BigInt(b.amount), data: '0x' },
    { gasLimit: 3_000_000 }
  );
  await tx.wait();
  return { assetToken, txHash: tx.hash };
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

await app.listen({ port: PORT, host: HOST });
console.log(`\n  Sotto API (LIVE)  ->  http://${HOST}:${PORT}`);
console.log(`  websocket         ->  ws://${HOST}:${PORT}/ws`);
console.log(`  bond              ->  ${env.BOND_ADDRESS}`);
console.log(`  settlement        ->  ${env.SETTLEMENT_ADDRESS}`);
console.log(`  hcs topic         ->  ${hcs.topicId}\n`);
