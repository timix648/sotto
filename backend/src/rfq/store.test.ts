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

test('a saved book comes back identical', () => {
  const path = join(dir(), 'book.json');
  const store = new RfqStore(path);
  const records = [record('a'), record('b', 'AWARDED')];

  store.save(records);
  assert.deepEqual(store.load(), records);
});

test('an engine rehydrated from a snapshot serves the same requests', () => {
  const path = join(dir(), 'book.json');
  const store = new RfqStore(path);

  const before = new RfqEngine(async () => {
    throw new Error('the audit writer must not be called by dump/hydrate');
  });
  before.hydrate([record('a'), record('b')]);
  store.save(before.dump());

  // A brand new process, reading what the old one left behind.
  const after = new RfqEngine(async () => {
    throw new Error('the audit writer must not be called by dump/hydrate');
  });
  after.hydrate(store.load());

  assert.deepEqual(after.list().map((r) => r.id).sort(), ['a', 'b']);
  // The hold is the point: it outlives the process, so the request that
  // explains it has to as well, or the seller cannot release the escrow.
  assert.equal(after.get('a').rfq.holdId, 2);
});

test('a missing snapshot is an empty book, not a crash', () => {
  const store = new RfqStore(join(dir(), 'nothing-here.json'));
  assert.deepEqual(store.load(), []);
});

test('a corrupt snapshot is an empty book, not a crash', () => {
  const path = join(dir(), 'book.json');
  writeFileSync(path, '{ this is not json');
  assert.deepEqual(new RfqStore(path).load(), []);
});

test('a snapshot that is valid json but the wrong shape is refused', () => {
  const path = join(dir(), 'book.json');
  writeFileSync(path, '{"records": []}');
  assert.deepEqual(new RfqStore(path).load(), []);
});

test('saving creates missing directories and leaves no temp file behind', () => {
  const path = join(dir(), 'nested', 'deeper', 'book.json');
  const store = new RfqStore(path);
  store.save([record('a')]);

  assert.ok(existsSync(path));
  assert.equal(existsSync(`${path}.tmp`), false);
  assert.equal(store.load().length, 1);
});

test('each save replaces the last, so a shrinking book does not leave ghosts', () => {
  const path = join(dir(), 'book.json');
  const store = new RfqStore(path);

  store.save([record('a'), record('b'), record('c')]);
  store.save([record('a')]);

  assert.deepEqual(store.load().map((r) => r.rfq.id), ['a']);
});
