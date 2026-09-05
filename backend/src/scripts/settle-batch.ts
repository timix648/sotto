// PATH B - HIP-551 atomic batch settlement. Blueprint section 2.1.
//
//   BatchTransaction (batchKey = venue relayer)
//     inner 1: TransferTransaction        cash buyer -> seller   [signed by buyer]
//     inner 2: ContractExecuteTransaction SottoSettlement.deliver(...)  <- MUST BE LAST
//
// Each party signs only its own leg. No ERC-20 allowance anywhere. The cash leg
// is a NATIVE HTS transfer, not a facade call. Atomicity comes from the network,
// not from the contract.
//
// THE TRADEOFF, stated plainly (and in the README under Known limitations):
// deliver() CANNOT introspect its batch siblings. From inside the EVM there is
// no way to verify that inner transaction 1 exists or succeeded - it relies
// entirely on batch atomicity. So deliver() is gated to RELAYER_ROLE while
// settle() (Path A) is permissionless. The trustless path is the open one; the
// elegant path is the permissioned one.
//
// Network rules (verified against the Hedera docs MCP):
//   - a batch may contain AT MOST ONE ContractExecuteTransaction, and it must be LAST
//   - inner transactions set batchKey and nodeAccountId 0.0.0 (batchify does this)
//   - 50 inner transactions max, 6KB total batch size
//   - inner transactions are charged even if the batch fails
//
//   npx tsx backend/src/scripts/settle-batch.ts
import { ethers } from 'ethers';
import { readFileSync } from 'node:fs';
import {
  Client, AccountId, PrivateKey, TokenId, ContractId, Hbar,
  TransferTransaction, ContractExecuteTransaction, BatchTransaction, TransactionId,
} from '@hashgraph/sdk';

const RPC = 'https://testnet.hashio.io/api';
const PARTITION = '0x0000000000000000000000000000000000000000000000000000000000000001';
const CASH_EVM = '0x0000000000000000000000000000000000068cDa';
const CASH_ID = '0.0.429274';
const QUANTITY = 3n;
const NOTIONAL = 2_950_500n; // 3 units @ 98.35

const BOND_ABI = [
  'function createHoldByPartition(bytes32,(uint256 amount,uint256 expirationTimestamp,address escrow,address to,bytes data)) returns (bool,uint256)',
  'function getHoldForByPartition((bytes32,address,uint256)) view returns (uint256,uint256,address,address,bytes,bytes,uint8)',
  'function balanceOf(address) view returns (uint256)',
];
const SETTLE_IFACE = new ethers.Interface([
  'function deliver((bytes32 rfqId,address assetToken,bytes32 partition,uint256 holdId,address cashToken,address seller,address buyer,uint256 quantity,uint256 notional,uint256 deadline,uint256 nonce),bytes,bytes) returns (bool)',
  'function nonces(address) view returns (uint256)',
]);
const TYPES = {
  Trade: [
    { name: 'rfqId', type: 'bytes32' }, { name: 'assetToken', type: 'address' },
    { name: 'partition', type: 'bytes32' }, { name: 'holdId', type: 'uint256' },
    { name: 'cashToken', type: 'address' }, { name: 'seller', type: 'address' },
    { name: 'buyer', type: 'address' }, { name: 'quantity', type: 'uint256' },
    { name: 'notional', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
};

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

async function main() {
  const env = loadEnv();
  const p = new ethers.JsonRpcProvider(RPC);
  const seller = new ethers.Wallet(env.SELLER_PRIVATE_KEY, p);
  const buyer = new ethers.Wallet(env.DEALER_PRIVATE_KEY, p);
  const SETTLEMENT = env.SETTLEMENT_ADDRESS;

  // Hedera-native identities for the batch
  const relayerId = AccountId.fromString(env.ISSUER_ACCOUNT_ID);
  const relayerKey = PrivateKey.fromStringECDSA(env.ISSUER_PRIVATE_KEY);
  const buyerId = AccountId.fromString(env.DEALER_ACCOUNT_ID);
  const buyerKey = PrivateKey.fromStringECDSA(env.DEALER_PRIVATE_KEY);
  const sellerId = AccountId.fromString(env.SELLER_ACCOUNT_ID);

  const client = Client.forTestnet().setOperator(relayerId, relayerKey);

  const bondS = new ethers.Contract(env.BOND_ADDRESS, BOND_ABI, seller);
  const bondR = new ethers.Contract(env.BOND_ADDRESS, BOND_ABI, p);
  const cashR = new ethers.Contract(CASH_EVM, ['function balanceOf(address) view returns (uint256)'], p);

  const snap = async (label: string) => {
    const [sb, bb, sc, bc] = await Promise.all([
      bondR.balanceOf(seller.address), bondR.balanceOf(buyer.address),
      cashR.balanceOf(seller.address), cashR.balanceOf(buyer.address),
    ]);
    console.log(`  ${label}`);
    console.log(`    seller  bond ${String(sb).padStart(5)}   cash ${(Number(sc) / 1e6).toFixed(4)} USDC`);
    console.log(`    buyer   bond ${String(bb).padStart(5)}   cash ${(Number(bc) / 1e6).toFixed(4)} USDC`);
  };

  console.log(`\n  settlement ${SETTLEMENT}`);
  console.log(`  relayer    ${env.ISSUER_ACCOUNT_ID} (holds RELAYER_ROLE)\n`);
  await snap('BEFORE');

  // 1) Seller places the hold - identical to Path A.
  console.log('\n  [1] seller: createHoldByPartition');
  const ht = await bondS.createHoldByPartition(
    PARTITION,
    { amount: QUANTITY, expirationTimestamp: BigInt(Math.floor(Date.now() / 1000) + 48 * 3600), escrow: SETTLEMENT, to: ethers.ZeroAddress, data: '0x' },
    { gasLimit: 3_000_000 }
  );
  await ht.wait();
  let holdId = -1n;
  for (let i = 0n; i < 60n; i++) {
    const [amount, , escrow] = await bondR.getHoldForByPartition([PARTITION, seller.address, i]);
    if (escrow.toLowerCase() === SETTLEMENT.toLowerCase() && amount >= QUANTITY) holdId = i;
  }
  console.log(`      holdId ${holdId}`);

  // 2) Both parties sign the Trade. No allowance is granted anywhere.
  const settleRead = new ethers.Contract(SETTLEMENT, SETTLE_IFACE.fragments, p);
  const trade = {
    rfqId: ethers.id('sotto-batch-rfq-1'),
    assetToken: env.BOND_ADDRESS, partition: PARTITION, holdId,
    cashToken: CASH_EVM, seller: seller.address, buyer: buyer.address,
    quantity: QUANTITY, notional: NOTIONAL,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    nonce: await settleRead.nonces(seller.address),
  };
  const domain = { name: 'Sotto', version: '1', chainId: 296, verifyingContract: SETTLEMENT };
  const sellerSig = await seller.signTypedData(domain, TYPES, trade);
  const buyerSig = await buyer.signTypedData(domain, TYPES, trade);
  console.log('\n  [2] both parties sign the Trade - NO allowance granted');

  // 3) Inner 1: the cash leg as a NATIVE HTS transfer, signed by the buyer.
  console.log('\n  [3] inner 1: native HTS transfer, buyer -> seller');
  const cashLeg = await new TransferTransaction()
    .addTokenTransfer(TokenId.fromString(CASH_ID), buyerId, -Number(NOTIONAL))
    .addTokenTransfer(TokenId.fromString(CASH_ID), sellerId, Number(NOTIONAL))
    .setTransactionId(TransactionId.generate(buyerId))
    .batchify(client, relayerKey.publicKey);
  await cashLeg.sign(buyerKey);
  console.log(`      ${Number(NOTIONAL) / 1e6} USDC, signed by the buyer only`);

  // 4) Inner 2: the delivery leg. MUST be the last inner transaction.
  const calldata = SETTLE_IFACE.encodeFunctionData('deliver', [
    [trade.rfqId, trade.assetToken, trade.partition, trade.holdId, trade.cashToken,
     trade.seller, trade.buyer, trade.quantity, trade.notional, trade.deadline, trade.nonce],
    sellerSig, buyerSig,
  ]);
  console.log(`\n  [4] inner 2: deliver() - calldata ${(calldata.length - 2) / 2} bytes`);
  const deliveryLeg = await new ContractExecuteTransaction()
    .setContractId(ContractId.fromEvmAddress(0, 0, SETTLEMENT))
    .setGas(1_500_000)
    .setFunctionParameters(Buffer.from(calldata.slice(2), 'hex'))
    .setMaxTransactionFee(new Hbar(20))
    .batchify(client, relayerKey.publicKey);

  // 5) The batch. Both legs, or neither - guaranteed by the network.
  console.log('\n  [5] BatchTransaction: [cash leg, delivery leg]');
  const batch = new BatchTransaction()
    .addInnerTransaction(cashLeg)
    .addInnerTransaction(deliveryLeg);

  const resp = await batch.freezeWith(client).sign(relayerKey);
  const exec = await resp.execute(client);
  const receipt = await exec.getReceipt(client);
  console.log(`      status ${receipt.status.toString()}`);
  console.log(`      tx ${exec.transactionId.toString()}`);
  console.log(`      hashscan https://hashscan.io/testnet/transaction/${exec.transactionId.toString()}`);

  // MECHANICS 4.3: a completion arriving is NOT the same moment as the state
  // being visible. Reading immediately after the receipt showed the batch as
  // "SUCCESS with nothing moved", which is the most misleading output possible.
  // Poll for visibility instead of trusting the receipt's timing.
  console.log('\n  waiting for state visibility (not the same moment as commit)...');
  const target = (await cashR.balanceOf(seller.address)) as bigint;
  for (let i = 0; i < 30; i++) {
    const now = (await cashR.balanceOf(seller.address)) as bigint;
    if (now !== target || i > 0) {
      const bb = (await bondR.balanceOf(buyer.address)) as bigint;
      if (bb > 0n) break;
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('');
  await snap('AFTER');
  console.log('\n  Each party signed only its own leg. No allowance. Atomicity from');
  console.log('  the network, not the contract. That is not something an EVM chain does.\n');
  client.close();
}

main().catch((e) => {
  console.error('\n  FAILED:', e instanceof Error ? e.message.split('\n')[0] : e);
  process.exit(1);
});
