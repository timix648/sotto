// The Path B cash-leg check.
//
// These run offline, because the property they protect is worth checking on
// every commit and not only when testnet is reachable.
//
// The venue chooses what goes into a batch. The buyer chooses what they signed.
// If those two are allowed to disagree, a buyer signs a transfer of one tiny
// unit, hands it to the venue, and takes delivery of the whole block against
// it - and the seller's security leg is already committed by their own
// signature, so they have no say. Every test below is one way to try that.
//
//   npm run test:batch
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Client, AccountId, PrivateKey, TokenId, TransferTransaction, TransactionId, Hbar,
  Transaction,
} from '@hashgraph/sdk';
import { BatchRelay } from './batch.js';

const CASH = '0.0.429274';
const BUYER = '0.0.1001';
const SELLER = '0.0.1002';
const STRANGER = '0.0.1003';
const NOTIONAL = 4_920_000n;

const venueKey = PrivateKey.generateECDSA();
const otherKey = PrivateKey.generateECDSA();
const buyerKey = PrivateKey.generateECDSA();

/**
 * A client whose operator is the buyer. batchify() signs with the operator key,
 * which is exactly what the buyer's wallet does in the real flow - so building
 * the fixture this way exercises the same shape the browser produces.
 */
const buyerClient = Client.forTestnet().setOperator(AccountId.fromString(BUYER), buyerKey);

function relay() {
  return new BatchRelay({
    operatorId: '0.0.999',
    operatorKey: venueKey.toStringDer(),
    cashTokenId: CASH,
    settlementAddress: '0x73195C1f91899Bc1E822bb1D039033Eb38926931',
    mirrorUrl: 'https://testnet.mirrornode.hedera.com/api/v1',
  });
}

/**
 * A frozen, batch-ready cash leg, ROUND-TRIPPED THROUGH BYTES - because that is
 * how it reaches the venue, and a check that only passes on an in-memory object
 * proves nothing about what arrives over the wire.
 *
 * `tweak` is how each test misbehaves.
 */
async function cashLeg(
  tweak: (tx: TransferTransaction) => void = () => {},
  batchKey = venueKey.publicKey
): Promise<Transaction> {
  const tx = new TransferTransaction()
    .addTokenTransfer(TokenId.fromString(CASH), AccountId.fromString(BUYER), -Number(NOTIONAL))
    .addTokenTransfer(TokenId.fromString(CASH), AccountId.fromString(SELLER), Number(NOTIONAL));
  tweak(tx);
  const frozen = await tx
    .setTransactionId(TransactionId.generate(AccountId.fromString(BUYER)))
    .setMaxTransactionFee(new Hbar(2))
    .batchify(buyerClient, batchKey);
  return Transaction.fromBytes(frozen.toBytes());
}

/** Same, for a leg built from scratch with different contents. */
async function customLeg(build: () => TransferTransaction): Promise<Transaction> {
  const frozen = await build()
    .setTransactionId(TransactionId.generate(AccountId.fromString(BUYER)))
    .setMaxTransactionFee(new Hbar(2))
    .batchify(buyerClient, venueKey.publicKey);
  return Transaction.fromBytes(frozen.toBytes());
}

const expected = { buyerAccountId: BUYER, sellerAccountId: SELLER, notional: NOTIONAL };

test('accepts the cash leg the trade actually calls for', async () => {
  relay().verifyCashLeg(await cashLeg(), expected);
});

test('refuses a cash leg that short-changes the seller', async () => {
  // The attack this whole check exists for: sign for a pittance, take the block.
  const short = await customLeg(() =>
    new TransferTransaction()
      .addTokenTransfer(TokenId.fromString(CASH), AccountId.fromString(BUYER), -1)
      .addTokenTransfer(TokenId.fromString(CASH), AccountId.fromString(SELLER), 1)
  );
  assert.throws(() => relay().verifyCashLeg(short, expected), /debits -1 but the trade notional/);
});

test('refuses a cash leg that pays somebody other than the seller', async () => {
  const misdirected = await customLeg(() =>
    new TransferTransaction()
      .addTokenTransfer(TokenId.fromString(CASH), AccountId.fromString(BUYER), -Number(NOTIONAL))
      .addTokenTransfer(TokenId.fromString(CASH), AccountId.fromString(STRANGER), Number(NOTIONAL))
  );
  assert.throws(() => relay().verifyCashLeg(misdirected, expected), /does not credit the seller/);
});

test('refuses a cash leg denominated in the wrong token', async () => {
  const wrongToken = await customLeg(() =>
    new TransferTransaction()
      .addTokenTransfer(TokenId.fromString('0.0.999999'), AccountId.fromString(BUYER), -Number(NOTIONAL))
      .addTokenTransfer(TokenId.fromString('0.0.999999'), AccountId.fromString(SELLER), Number(NOTIONAL))
  );
  assert.throws(() => relay().verifyCashLeg(wrongToken, expected), /unexpected token/);
});

test('refuses extra transfers smuggled alongside the real one', async () => {
  // Right payment to the seller, plus a third leg naming somebody else.
  const smuggled = await cashLeg((tx) => {
    tx.addTokenTransfer(TokenId.fromString(CASH), AccountId.fromString(STRANGER), 0);
  });
  assert.throws(() => relay().verifyCashLeg(smuggled, expected), /expected 2 token transfers/);
});

test('refuses a cash leg that also moves hbar', async () => {
  const withHbar = await cashLeg((tx) => {
    tx.addHbarTransfer(AccountId.fromString(BUYER), new Hbar(-1));
    tx.addHbarTransfer(AccountId.fromString(STRANGER), new Hbar(1));
  });
  assert.throws(() => relay().verifyCashLeg(withHbar, expected), /must not move hbar/);
});

test('refuses a cash leg that names a different batchKey', async () => {
  // Signed for a different assembler: not ours to submit, and not ours to trust.
  const foreign = await cashLeg(() => {}, otherKey.publicKey);
  assert.throws(() => relay().verifyCashLeg(foreign, expected), /names a different batchKey/);
});

test('refuses an inner transaction that is not a transfer at all', async () => {
  const { ContractExecuteTransaction, ContractId } = await import('@hashgraph/sdk');
  const frozen = await new ContractExecuteTransaction()
    .setContractId(ContractId.fromString('0.0.1234'))
    .setGas(100_000)
    .setTransactionId(TransactionId.generate(AccountId.fromString(BUYER)))
    .batchify(buyerClient, venueKey.publicKey);
  const notATransfer = Transaction.fromBytes(frozen.toBytes());

  assert.throws(
    () => relay().verifyCashLeg(notATransfer, expected),
    /not a TransferTransaction/
  );
});

test('the batchKey it publishes is the one it will verify against', async () => {
  const r = relay();
  assert.equal(r.params().batchPublicKey, venueKey.publicKey.toStringDer());
  // A browser that builds against params().batchPublicKey must pass the check.
  r.verifyCashLeg(await cashLeg(), expected);
});

test.after(() => buyerClient.close());
