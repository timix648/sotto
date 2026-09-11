'use client';

// Path B in the browser: the buyer signs their own cash leg.
//
// Path A grants the settlement contract an ERC-20 allowance and lets it pull
// the cash. Path B grants no allowance anywhere. The buyer signs a NATIVE HTS
// transfer of their own money, the venue signs the delivery call, and the
// network guarantees both or neither. Each party signs only its own leg — which
// is the thing an EVM chain structurally cannot do.
//
// THREE THINGS THAT HAD TO BE RIGHT, AND ARE EASY TO GET WRONG
//
// 1. THE SDK IDENTITY. `hedera_signTransaction` does an `instanceof Transaction`
//    check against @hiero-ledger/sdk, which is what hedera-wallet-connect
//    peer-depends on. Build the transaction with any other SDK copy and the
//    wallet rejects it with "Transaction sent in incorrect format" — a message
//    that tells you nothing about the real cause. Import from
//    '@hiero-ledger/sdk' here, always.
//
// 2. setBatchKey THEN freeze — and never touch setNodeAccountIds. An inner
//    transaction needs `nodeAccountId 0.0.0`, and freezeWith() sets exactly
//    that on its own when a batchKey is present. Setting it by hand throws
//    "list is locked". batchify() is the documented shortcut but it also calls
//    signWithOperator, which needs a private key — a browser has none, and the
//    wallet does the signing a moment later anyway.
//
// 3. THE BATCH KEY COMES FROM THE VENUE. It is fetched from /api/batch/params
//    rather than hardcoded, because the venue verifies the inner transaction
//    names its own key and refuses anything signed for a different assembler.
import {
  AccountId, Hbar, PublicKey, TokenId, TransferTransaction, TransactionId,
  type Transaction,
} from '@hiero-ledger/sdk';

/** The HederaProvider surface we use. Typed narrowly so a shape change is loud. */
export interface NativeSigner {
  hedera_signTransaction(params: {
    signerAccountId: string;
    transactionBody: Transaction;
  }): Promise<Transaction>;
}

export interface BatchParams {
  batchPublicKey: string;
  relayerAccountId: string;
  cashTokenId: string;
  settlementAddress: string;
}

/**
 * Build the inner cash leg, have the wallet sign it, and return it as base64
 * for the venue to batch.
 *
 * Nothing is submitted here. The wallet signs and hands the bytes back; only
 * the venue can submit them, and only as part of a batch whose other half is
 * the delivery call. A signature that never reaches the venue moves nothing.
 */
export async function signCashLeg(args: {
  signer: NativeSigner;
  params: BatchParams;
  buyerAccountId: string;
  sellerAccountId: string;
  /** Cash base units — the trade's notional, exactly. */
  notional: string;
}): Promise<string> {
  const amount = Number(args.notional);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(`notional ${args.notional} is not a usable transfer amount`);
  }

  const buyer = AccountId.fromString(args.buyerAccountId);
  const seller = AccountId.fromString(args.sellerAccountId);
  const token = TokenId.fromString(args.params.cashTokenId);
  const batchKey = PublicKey.fromString(args.params.batchPublicKey);

  // No client and no operator key. The transaction id names the buyer, so they
  // are the fee payer for their own leg, and freeze() fills in nodeAccountId
  // 0.0.0 because a batchKey is set.
  const inner = new TransferTransaction()
    .addTokenTransfer(token, buyer, -amount)
    .addTokenTransfer(token, seller, amount)
    .setTransactionId(TransactionId.generate(buyer))
    .setMaxTransactionFee(new Hbar(2))
    .setBatchKey(batchKey)
    .freezeWith(null);

  // The wallet prompt. HIP-820 `hedera_signTransaction` signs WITHOUT executing
  // and merges the signature back into the transaction bytes.
  const signed = await args.signer.hedera_signTransaction({
    signerAccountId: args.buyerAccountId,
    transactionBody: inner,
  });

  return bytesToBase64(signed.toBytes());
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}
