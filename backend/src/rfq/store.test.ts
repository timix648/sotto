// The book has to survive the process. See store.ts for the incident.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RfqStore } from './store.js';
import { RfqEngine, type RfqRecord } from './engine.js';

const dir = () => mkdtempSync(join(tmpdir(), 'sotto-store-'));

function record(id: string, status: RfqRecord['rfq']['status'] = 'OPEN'): RfqRecord {
  return {
    rfq: {
      id,
      assetToken: '0xD53072649037FEecD305920087791a37dF8D517F',
      assetSymbol: 'STO-BOND-A',
      partition: `0x${'0'.repeat(63)}1`,
      cashToken: '0x0000000000000000000000000000000000068cDa',
      quantity: '50',
      filled: '0',
      unfilled: '50',
      seller: '0x823C1545B90F4A2a28a3Ee31DF07EBdF1c2a2D1C',
      holdId: 2,
      commitDeadline: 1_789_136_578_000,
      revealDeadline: 1_789_137_578_000,
      status,
      createdAt: 1_789_130_000_000,
      hcsSequenceNumber: 102,
    },
    commits: [],
    reveals: [],
    audit: [],
    award: null,
    fills: [],
  };
}

const snap = (records: RfqRecord[], extra: Partial<{
  sellerSignatures: Record<string, Record<string, string>>;
  settledFillNonces: Record<string, string[]>;
}> = {}) => ({
  records,
  sellerSignatures: extra.sellerSignatures ?? {},
  settledFillNonces: extra.settledFillNonces ?? {},
});

test('a saved book comes back identical', () => {
  const path = join(dir(), 'book.json');
  const store = new RfqStore(path);
  const s = snap([record('a'), record('b', 'AWARDED')]);

  store.save(s);
  assert.deepEqual(store.load(), s);
});

test('the seller signatures and settled fills survive too', () => {
  // What a restart used to lose. The nonces were consumed on-chain and the cash
  // had moved; coming back believing nothing had settled would have offered the
  // same fill for settlement twice, and mislabelled a partial failure as total.
  const path = join(dir(), 'book.json');
  const store = new RfqStore(path);
  store.save(snap([record('a', 'AWARDED')], {
    sellerSignatures: { a: { '0': '0x36f8ebbc', '1': '0x394d49df' } },
    settledFillNonces: { a: ['1'] },
  }));

  const back = store.load();
  assert.deepEqual(back.sellerSignatures.a, { '0': '0x36f8ebbc', '1': '0x394d49df' });
  assert.deepEqual(back.settledFillNonces.a, ['1']);
});

test('a book written in the original array format still loads', () => {
  // A venue mid-demo should not lose its book to a schema change.
  const path = join(dir(), 'book.json');
  writeFileSync(path, JSON.stringify([record('a')]));

  const back = new RfqStore(path).load();
  assert.equal(back.records.length, 1);
  assert.deepEqual(back.sellerSignatures, {});
  assert.deepEqual(back.settledFillNonces, {});
});

test('an engine rehydrated from a snapshot serves the same requests', () => {
  const path = join(dir(), 'book.json');
  const store = new RfqStore(path);

  const before = new RfqEngine(async () => {
    throw new Error('the audit writer must not be called by dump/hydrate');
  });
  before.hydrate([record('a'), record('b')]);
  store.save(snap(before.dump()));

  // A brand new process, reading what the old one left behind.
  const after = new RfqEngine(async () => {
    throw new Error('the audit writer must not be called by dump/hydrate');
  });
  after.hydrate(store.load().records);

  assert.deepEqual(after.list().map((r) => r.id).sort(), ['a', 'b']);
  // The hold is the point: it outlives the process, so the request that
  // explains it has to as well, or the seller cannot release the escrow.
  assert.equal(after.get('a').rfq.holdId, 2);
});

test('a missing snapshot is an empty book, not a crash', () => {
  const store = new RfqStore(join(dir(), 'nothing-here.json'));
  assert.deepEqual(store.load().records, []);
});

test('a corrupt snapshot is an empty book, not a crash', () => {
  const path = join(dir(), 'book.json');
  writeFileSync(path, '{ this is not json');
  assert.deepEqual(new RfqStore(path).load().records, []);
});

test('a snapshot that is valid json but the wrong shape is refused', () => {
  const path = join(dir(), 'book.json');
  writeFileSync(path, '{"notARecordList": true}');
  assert.deepEqual(new RfqStore(path).load().records, []);
});

test('saving creates missing directories and leaves no temp file behind', () => {
  const path = join(dir(), 'nested', 'deeper', 'book.json');
  const store = new RfqStore(path);
  store.save(snap([record('a')]));

  assert.ok(existsSync(path));
  assert.equal(existsSync(`${path}.tmp`), false);
  assert.equal(store.load().records.length, 1);
});

test('each save replaces the last, so a shrinking book does not leave ghosts', () => {
  const path = join(dir(), 'book.json');
  const store = new RfqStore(path);

  store.save(snap([record('a'), record('b'), record('c')]));
  store.save(snap([record('a')]));

  assert.deepEqual(store.load().records.map((r) => r.rfq.id), ['a']);
});
