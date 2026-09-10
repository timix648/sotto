// Regression tests for MECHANICS.md §4.10 — the formatting bugs that made
// working settlements look broken. Each case below is one of those bugs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatAmount, formatCash, formatPrice, formatQty, formatBps,
  computeNotional, parseAmount, truncate, countdown, formatConsensus,
} from './format.ts';

const USDC = 6;

test('§4.10 — a receipt must never tell the user they receive NOTHING', () => {
  // 1 base unit of USDC = 0.000001. At a fixed 2dp this rendered as "0.00".
  assert.equal(formatCash('1', USDC), '0.000001');
  assert.equal(formatCash('250', USDC), '0.00025');
  // and the value that is genuinely zero is still allowed to say so
  assert.equal(formatCash('0', USDC), '0.00');
});

test('§4.10 — a real mark must never render as 0.0000', () => {
  assert.equal(formatPrice('98350000', USDC), '98.35');
  assert.equal(formatPrice('100', USDC), '0.0001');
  assert.equal(formatPrice('9', USDC), '0.000009'); // precision grows, not truncates
});

test('§4.10 — every return value is a string, for any input', () => {
  const junk: unknown[] = [null, undefined, '', 'abc', {}, [], NaN, '0x'];
  for (const j of junk) {
    const out = formatCash(j as string, USDC);
    assert.equal(typeof out, 'string', 'got ' + typeof out + ' for ' + String(j));
    assert.ok(!out.includes('[object'), 'leaked an object for ' + String(j));
    assert.ok(!out.includes('NaN'), 'leaked NaN for ' + String(j));
  }
});

test('§4.10 — an off-market price says so instead of quoting millions of bps', () => {
  assert.equal(formatBps('98350000', '98350000'), '0 bp');
  assert.equal(formatBps('98500000', '98350000'), '+15 bp');
  assert.equal(formatBps('97000000', '98350000'), '-137 bp');
  // the 80.00 bid against a 98.35 NAV that the oracle band refused
  assert.equal(formatBps('80000000', '98350000'), '-1865 bp');
  // and the case that produced "plus one and a half million"
  assert.equal(formatBps('98350000', '1'), 'off market');
});

test('exact maths — no float ever touches a value', () => {
  // 0.1 + 0.2 territory, and values past Number.MAX_SAFE_INTEGER
  assert.equal(formatCash('9007199254740993', USDC), '9,007,199,254.74');
  assert.equal(computeNotional('98350000', '250'), '245875000');
  assert.equal(formatCash(computeNotional('98350000', '250'), USDC), '245.88');
  // the README's proven trade: 20 bonds for 19.67 USDC
  assert.equal(formatCash(computeNotional('98350000', '20'), USDC), '19.67');
});

test('rounding is half-up and never drifts', () => {
  assert.equal(formatCash('5', USDC), '0.000005');
  assert.equal(formatAmount('1235000', USDC, { minFrac: 2, maxFrac: 2 }), '1.24');
  assert.equal(formatAmount('1234000', USDC, { minFrac: 2, maxFrac: 2 }), '1.23');
  assert.equal(formatAmount('-1235000', USDC, { minFrac: 2, maxFrac: 2 }), '-1.24');
});

test('quantities are whole units with grouping, matching the demo copy', () => {
  assert.equal(formatQty('1000'), '1,000');
  assert.equal(formatQty('250'), '250');
  assert.equal(formatQty('0'), '0');
});

test('signed amounts for the dual ledger', () => {
  assert.equal(formatAmount('24587500000', USDC, { signed: true }), '+24,587.50');
  assert.equal(formatAmount('-24587500000', USDC, { signed: true }), '-24,587.50');
});

test('parseAmount round-trips user input exactly', () => {
  assert.equal(parseAmount('98.35', USDC), '98350000');
  assert.equal(parseAmount('1,000', USDC), '1000000000');
  assert.equal(parseAmount('0.000001', USDC), '1');
  assert.throws(() => parseAmount('', USDC));
  assert.throws(() => parseAmount('abc', USDC));
});

test('addresses truncate to the B6 shape', () => {
  assert.equal(truncate('0xD53072649037FEecD305920087791a37dF8D517F'), '0xD530…517F');
  assert.equal(truncate(null), '—');
});

test('countdown clamps at zero and never shows a negative', () => {
  assert.equal(countdown(100, 40), '01:00');
  assert.equal(countdown(100, 100), '00:00');
  assert.equal(countdown(100, 999), '00:00');
  assert.equal(countdown(7300, 0), '02:01:40');
});

test('HCS consensus timestamps keep their nanosecond tail', () => {
  // the batch settlement record from the README
  assert.equal(formatConsensus('1788646998.050909150'), '2026-09-05 22:23:18.050Z');
  assert.equal(formatConsensus(null), '—');
});
