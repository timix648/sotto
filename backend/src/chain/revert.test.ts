// A revert has to arrive as a sentence, not a receipt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { explainRevert } from './revert.js';

const iface = new ethers.Interface([
  'error DeadlineExpired(uint256 deadline, uint256 nowTs)',
  'error SignatureInvalid(address expected, address recovered)',
  'error OutsideBand(address asset, uint256 price, uint256 referencePrice, uint16 bandBps)',
  'error StaleReference(address asset, uint64 updatedAt, uint64 nowTs, uint64 maxAge)',
  'error DeliveryFailed()',
  'error NotHolder(address holder, address caller)',
  'error HoldTooSmall(uint256 held, uint256 required)',
]);

/** What ethers hands us: a CALL_EXCEPTION with the payload buried in it. */
function callException(data: string) {
  const e = new Error(
    'transaction execution reverted (action="sendTransaction", data=null, reason=null, '
    + 'invocation=null, revert=null, transaction={ ... }, receipt={ "logsBloom": "0x000…" }, '
    + 'code=CALL_EXCEPTION, version=6.17.0)'
  );
  (e as unknown as { info: unknown }).info = { error: { data } };
  return e;
}

test('a lapsed firmness deadline says so, and by how much', () => {
  // The real one: deadline 01:48:26Z, submitted 01:53:57Z.
  const data = iface.encodeErrorResult('DeadlineExpired', [1789177706n, 1789178037n]);
  const out = explainRevert(callException(data));

  assert.equal(out.code, 'DEADLINE_EXPIRED');
  assert.match(out.message, /no longer firm/);
  assert.match(out.message, /5 minutes/);
  // The blob is kept, but not as the thing anyone reads.
  assert.match(out.raw, /CALL_EXCEPTION/);
  assert.doesNotMatch(out.message, /logsBloom|CALL_EXCEPTION|0x/);
});

test('an off-band price names the price, the mark and the band', () => {
  const data = iface.encodeErrorResult('OutsideBand', [
    '0xD53072649037FEecD305920087791a37dF8D517F', 1_200_000n, 98_350_000n, 500,
  ]);
  const out = explainRevert(callException(data));

  assert.equal(out.code, 'NAV_OUTSIDE_BAND');
  assert.match(out.message, /1\.20/);
  assert.match(out.message, /98\.35/);
  assert.match(out.message, /5%/);
});

test('a stale NAV explains the age against the limit', () => {
  const data = iface.encodeErrorResult('StaleReference', [
    '0xD53072649037FEecD305920087791a37dF8D517F', 1789000000n, 1789100000n, 86400n,
  ]);
  const out = explainRevert(callException(data));

  assert.equal(out.code, 'NAV_STALE');
  assert.match(out.message, /27 hours/);
  assert.match(out.message, /24 hours/);
});

test('a compliance refusal is reported as one, and only then', () => {
  const out = explainRevert(callException(iface.encodeErrorResult('DeliveryFailed', [])));
  assert.equal(out.code, 'DELIVERY_REFUSED');
  assert.match(out.message, /compliance/);
});

test('a bad signature names both addresses', () => {
  const data = iface.encodeErrorResult('SignatureInvalid', [
    '0x823C1545B90F4A2a28a3Ee31DF07EBdF1c2a2D1C',
    '0xe996838Fda4aA7EB68736dDF189578E6DD4a2DF4',
  ]);
  const out = explainRevert(callException(data));
  assert.equal(out.code, 'SIGNATURE_INVALID');
  assert.match(out.message, /0x823C…2D1C/);
  assert.match(out.message, /0xe996…2DF4/);
});

test('a hold short of the fill says both numbers', () => {
  const out = explainRevert(callException(iface.encodeErrorResult('HoldTooSmall', [3n, 7n])));
  assert.equal(out.code, 'HOLD_TOO_SMALL');
  assert.match(out.message, /3 units/);
  assert.match(out.message, /needs 7/);
});

test('releasing an escrow you do not hold is refused by name', () => {
  const data = iface.encodeErrorResult('NotHolder', [
    '0x823C1545B90F4A2a28a3Ee31DF07EBdF1c2a2D1C',
    '0xe996838Fda4aA7EB68736dDF189578E6DD4a2DF4',
  ]);
  const out = explainRevert(callException(data));
  assert.equal(out.code, 'NOT_HOLDER');
  assert.match(out.message, /Only 0x823C…2D1C/);
});

test('the payload is found however ethers nested it', () => {
  const data = iface.encodeErrorResult('DeliveryFailed', []);
  const direct = new Error('reverted');
  (direct as unknown as { data: string }).data = data;
  assert.equal(explainRevert(direct).code, 'DELIVERY_REFUSED');

  const nested = new Error('reverted');
  (nested as unknown as { cause: unknown }).cause = { info: { error: { data } } };
  assert.equal(explainRevert(nested).code, 'DELIVERY_REFUSED');
});

test('an unfunded buyer is recognised without a custom error', () => {
  const out = explainRevert(new Error('execution reverted: insufficient allowance'));
  assert.equal(out.code, 'INSUFFICIENT_CASH');
  assert.match(out.message, /short of the notional/);
});

test('an unknown revert admits it rather than dumping the receipt', () => {
  const out = explainRevert(callException('0xdeadbeef'));
  assert.equal(out.code, 'UNKNOWN');
  assert.doesNotMatch(out.message, /logsBloom|0xdeadbeef/);
  assert.match(out.message, /Nothing moved/);
});
