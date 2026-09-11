// Path B relay: HIP-551 atomic batch settlement, with the cash leg signed by
// the buyer's own wallet.
//
// WHAT THIS IS FOR
// Path A settles through an ERC-20 allowance: the buyer approves the settlement
// contract, and `settle()` pulls the cash. Path B grants no allowance anywhere.
// The buyer signs a NATIVE HTS transfer of their own cash, the venue signs a
// delivery call, and the network guarantees both or neither. Each party signs
// only its own leg. EVM chains structurally cannot do this.
//
// THE SPLIT, AND WHY IT IS NOT CUSTODY
// The venue is the batch OPERATOR: it holds the batchKey, assembles the batch
// and pays the outer fee. It is not a custodian and cannot become one. The
// buyer's inner transaction is frozen and signed before it ever reaches us, so
// its contents cannot be altered - the batchKey authorises SUBMISSION, not
// modification. A tampered inner transaction fails its own signature check.
//
// THE ONE THING THIS MODULE MUST GET RIGHT
// The venue chooses what to put in the batch, so it must verify that what the
// buyer signed is what the trade says. Without `verifyCashLeg`, a buyer could
// sign a transfer of one tiny unit, hand it over, and take delivery of the whole
// block against it. That check is the difference between a settlement venue and
// a way to be robbed, so it is deliberately strict: right token, right pair of
// accounts, exact amount, nothing else moving.
import { ethers } from 'ethers';
import {
  Client, AccountId, PrivateKey, PublicKey, TokenId, ContractId, Hbar,
  Transaction, TransferTransaction, ContractExecuteTransaction, BatchTransaction,
} from '@hashgraph/sdk';

export interface BatchRelayConfig {
  operatorId: string;
  operatorKey: string;
  cashTokenId: string;
  settlementAddress: string;
  mirrorUrl: string;
}

/** What a browser needs in order to build an inner cash leg we can batch. */
export interface BatchParams {
  /** DER-encoded public key the inner transaction must name as its batchKey. */
  batchPublicKey: string;
  relayerAccountId: string;
  cashTokenId: string;
  settlementAddress: string;
}

export interface BatchResult {
  transactionId: string;
  status: string;
  hashscanUrl: string;
}

/** One entry of TransferTransaction's decoded token transfer list. */
interface TokenTransferRecord {
  tokenId: TokenId;
  accountId: AccountId;
  amount: { toString(): string };
}

export class BatchRelay {
  readonly client: Client;
  private readonly key: PrivateKey;
  private readonly accountIdCache = new Map<string, string>();

  constructor(private readonly cfg: BatchRelayConfig) {
    this.key = PrivateKey.fromStringECDSA(cfg.operatorKey);
    this.client = Client.forTestnet().setOperator(AccountId.fromString(cfg.operatorId), this.key);
  }

  params(): BatchParams {
    return {
      batchPublicKey: this.key.publicKey.toStringDer(),
      relayerAccountId: this.cfg.operatorId,
      cashTokenId: this.cfg.cashTokenId,
      settlementAddress: this.cfg.settlementAddress,
    };
  }

  /**
   * Hedera account id for an EVM address.
   *
   * A Trade names its parties by EVM address, but an HTS transfer moves value
   * between ACCOUNT IDS. For the demo desks these are in .env; for a connected
   * wallet they are not, so resolve them from the mirror node rather than
   * assuming the caller told us the truth about who they are.
   */
  async accountIdFor(evmAddress: string): Promise<string> {
    const key = evmAddress.toLowerCase();
    const cached = this.accountIdCache.get(key);
    if (cached) return cached;

    const res = await fetch(`${this.cfg.mirrorUrl}/accounts/${key}`);
    if (!res.ok) throw new Error(`no Hedera account for ${evmAddress} (mirror ${res.status})`);
    const body = (await res.json()) as { account?: string };
    if (!body.account) throw new Error(`no Hedera account id for ${evmAddress}`);

    this.accountIdCache.set(key, body.account);
    return body.account;
  }

  /**
   * Refuse anything that is not exactly the cash leg this trade calls for.
   *
   * Strict on purpose. The venue decides what goes in the batch, so every
   * degree of freedom left here is one the buyer can exploit against the seller
   * - and the seller's security leg is already committed by their signature.
   */
  verifyCashLeg(
    tx: Transaction,
    expect: { buyerAccountId: string; sellerAccountId: string; notional: bigint }
  ): void {
    if (!(tx instanceof TransferTransaction)) {
      throw new Error('the inner transaction is not a TransferTransaction');
    }

    const transfers = (tx as unknown as { _tokenTransfers?: TokenTransferRecord[] })._tokenTransfers ?? [];
    if (!transfers.length) throw new Error('the inner transaction moves no tokens');

    const hbar = (tx as unknown as { _hbarTransfers?: unknown[] })._hbarTransfers ?? [];
    if (hbar.length) throw new Error('the inner cash leg must not move hbar');

    const nfts = (tx as unknown as { _nftTransfers?: unknown[] })._nftTransfers ?? [];
    if (nfts.length) throw new Error('the inner cash leg must not move NFTs');

    // Exactly two legs of exactly one token: buyer out, seller in.
    if (transfers.length !== 2) {
      throw new Error(`expected 2 token transfers, found ${transfers.length}`);
    }
    for (const t of transfers) {
      if (t.tokenId.toString() !== this.cfg.cashTokenId) {
        throw new Error(`unexpected token ${t.tokenId.toString()} in the cash leg`);
      }
    }

    const byAccount = new Map<string, bigint>();
    for (const t of transfers) {
      const id = t.accountId.toString();
      byAccount.set(id, (byAccount.get(id) ?? 0n) + BigInt(t.amount.toString()));
    }

    const debit = byAccount.get(expect.buyerAccountId);
    const credit = byAccount.get(expect.sellerAccountId);
    if (debit === undefined) throw new Error(`the cash leg does not debit the buyer ${expect.buyerAccountId}`);
    if (credit === undefined) throw new Error(`the cash leg does not credit the seller ${expect.sellerAccountId}`);
    if (debit !== -expect.notional) {
      throw new Error(`the cash leg debits ${debit} but the trade notional is ${expect.notional}`);
    }
    if (credit !== expect.notional) {
      throw new Error(`the cash leg credits ${credit} but the trade notional is ${expect.notional}`);
    }

    // The batchKey must be ours, or the network will not let us submit it - and
    // a mismatch here means the buyer signed for a different assembler.
    const batchKey = tx.batchKey as PublicKey | null;
    if (!batchKey) throw new Error('the inner transaction has no batchKey set');
    if (batchKey.toStringDer() !== this.key.publicKey.toStringDer()) {
      throw new Error('the inner transaction names a different batchKey');
    }

    if (!tx.isFrozen()) throw new Error('the inner transaction is not frozen');
  }

  /**
   * Assemble and submit the batch: the buyer's cash leg, then delivery.
   *
   * The contract call MUST be last. The network permits at most one per batch
   * and requires it to be final, so that everything before it has settled
   * before the contract runs.
   */
  async settle(args: {
    tradeTuple: unknown[];
    sellerSig: string;
    buyerSig: string;
    innerCashTxBase64: string;
    buyerEvm: string;
    sellerEvm: string;
    notional: bigint;
    settlementIface: ethers.Interface;
  }): Promise<BatchResult> {
    const cashLeg = Transaction.fromBytes(Buffer.from(args.innerCashTxBase64, 'base64'));

    const [buyerAccountId, sellerAccountId] = await Promise.all([
      this.accountIdFor(args.buyerEvm),
      this.accountIdFor(args.sellerEvm),
    ]);
    this.verifyCashLeg(cashLeg, { buyerAccountId, sellerAccountId, notional: args.notional });

    const calldata = args.settlementIface.encodeFunctionData('deliver', [
      args.tradeTuple, args.sellerSig, args.buyerSig,
    ]);

    const deliveryLeg = await new ContractExecuteTransaction()
      .setContractId(ContractId.fromEvmAddress(0, 0, this.cfg.settlementAddress))
      .setGas(1_500_000)
      .setFunctionParameters(Buffer.from(calldata.slice(2), 'hex'))
      .setMaxTransactionFee(new Hbar(20))
      .batchify(this.client, this.key.publicKey);

    const batch = new BatchTransaction()
      .addInnerTransaction(cashLeg)
      .addInnerTransaction(deliveryLeg);

    const signed = await batch.freezeWith(this.client).sign(this.key);
    const exec = await signed.execute(this.client);
    const receipt = await exec.getReceipt(this.client);
    const id = exec.transactionId.toString();

    return {
      transactionId: id,
      status: receipt.status.toString(),
      hashscanUrl: `https://hashscan.io/testnet/transaction/${id}`,
    };
  }

  close(): void {
    this.client.close();
  }
}
