// Chain adapter: everything the API needs to read from or write to Hedera.
//
// All ATS signatures here are verified against ATS v3.1.0 (ad8f601), the version
// actually DEPLOYED at 0.0.7708430. Repo HEAD reordered structs and changed role
// hashes - see docs/ATS-SPIKE.md before touching any of these.
import { ethers } from 'ethers';

export const PARTITION_DEFAULT = '0x0000000000000000000000000000000000000000000000000000000000000001';

export const BOND_ABI = [
  // ERC-1410 / balances. NOTE: balanceOf is AVAILABLE, not total.
  'function balanceOf(address) view returns (uint256)',
  'function balanceOfByPartition(bytes32,address) view returns (uint256)',
  'function getHeldAmountFor(address) view returns (uint256)',
  'function getHeldAmountForByPartition(bytes32,address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  // holds
  'function createHoldByPartition(bytes32,(uint256 amount,uint256 expirationTimestamp,address escrow,address to,bytes data)) returns (bool,uint256)',
  'function getHoldForByPartition((bytes32,address,uint256)) view returns (uint256,uint256,address,address,bytes,bytes,uint8)',
  // internal KYC
  'function grantKyc(address,string,uint256,uint256,address) returns (bool)',
  'function revokeKyc(address) returns (bool)',
  'function getKycStatusFor(address) view returns (uint8)',
  // issuance
  'function issueByPartition((bytes32 partition,address tokenHolder,uint256 value,bytes data))',
];

export const SETTLEMENT_ABI = [
  'function settle((bytes32 rfqId,address assetToken,bytes32 partition,uint256 holdId,address cashToken,address seller,address buyer,uint256 quantity,uint256 notional,uint256 deadline,uint256 nonce),bytes,bytes) returns (bool)',
  'function deliver((bytes32 rfqId,address assetToken,bytes32 partition,uint256 holdId,address cashToken,address seller,address buyer,uint256 quantity,uint256 notional,uint256 deadline,uint256 nonce),bytes,bytes) returns (bool)',
  'function nonces(address) view returns (uint256)',
  'event Settled(bytes32 indexed rfqId,address indexed seller,address indexed buyer,uint256 quantity,uint256 notional,address assetToken,address cashToken)',
];

export const CASH_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

export interface ChainConfig {
  rpcUrl: string;
  mirrorUrl: string;
  bondAddress: string;
  settlementAddress: string;
  cashAddress: string;
  issuerKey: string;
}

/** Total / Available / Held / Locked - the four numbers B2's card animates. */
export interface Balances {
  account: string;
  assetToken: string;
  symbol: string;
  total: string;
  available: string;
  held: string;
  locked: string;
  cash: string;
  cashToken: string;
  cashDecimals: number;
  allowance: string;
}

export class Chain {
  readonly provider: ethers.JsonRpcProvider;
  readonly issuer: ethers.Wallet;
  readonly bond: ethers.Contract;
  readonly settlement: ethers.Contract;
  readonly cash: ethers.Contract;

  constructor(readonly cfg: ChainConfig) {
    this.provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
    this.issuer = new ethers.Wallet(cfg.issuerKey, this.provider);
    this.bond = new ethers.Contract(cfg.bondAddress, BOND_ABI, this.issuer);
    this.settlement = new ethers.Contract(cfg.settlementAddress, SETTLEMENT_ABI, this.issuer);
    this.cash = new ethers.Contract(cfg.cashAddress, CASH_ABI, this.provider);
  }

  /**
   * balanceOf on an ATS token returns AVAILABLE, not total - placing a hold
   * makes it drop. Total is available + held. Reading balanceOf alone makes a
   * seller look like they lost tokens.
   */
  async balances(account: string): Promise<Balances> {
    const [available, held, symbol, cash, cashDecimals, allowance] = await Promise.all([
      this.bond.balanceOf(account) as Promise<bigint>,
      this.bond.getHeldAmountFor(account) as Promise<bigint>,
      this.bond.symbol() as Promise<string>,
      this.cash.balanceOf(account) as Promise<bigint>,
      this.cash.decimals() as Promise<bigint>,
      this.cash.allowance(account, this.cfg.settlementAddress) as Promise<bigint>,
    ]);
    return {
      account,
      assetToken: this.cfg.bondAddress,
      symbol,
      total: (available + held).toString(),
      available: available.toString(),
      held: held.toString(),
      locked: '0', // separate ATS lock facet; not used by Sotto
      cash: cash.toString(),
      cashToken: this.cfg.cashAddress,
      cashDecimals: Number(cashDecimals),
      allowance: allowance.toString(),
    };
  }

  async asset() {
    const [name, symbol, decimals, totalSupply] = await Promise.all([
      this.bond.name(), this.bond.symbol(), this.bond.decimals(), this.bond.totalSupply(),
    ]);
    return {
      assetToken: this.cfg.bondAddress,
      name, symbol,
      decimals: Number(decimals),
      totalSupply: totalSupply.toString(),
      hashscan: `https://hashscan.io/testnet/contract/${this.cfg.bondAddress}`,
    };
  }

  /** Find the hold id a seller escrowed to the settlement contract. */
  async findHold(seller: string, minAmount: bigint, partition = PARTITION_DEFAULT): Promise<number | null> {
    for (let i = 0n; i < 60n; i++) {
      const [amount, , escrow] = await this.bond.getHoldForByPartition([partition, seller, i]);
      if (
        String(escrow).toLowerCase() === this.cfg.settlementAddress.toLowerCase() &&
        (amount as bigint) >= minAmount
      ) return Number(i);
    }
    return null;
  }

  async readHold(seller: string, holdId: number, partition = PARTITION_DEFAULT) {
    const [amount, expiration, escrow, destination] =
      await this.bond.getHoldForByPartition([partition, seller, holdId]);
    return {
      holdId,
      amount: (amount as bigint).toString(),
      expirationTimestamp: Number(expiration),
      escrow,
      destination,
      isEscrowedHere: String(escrow).toLowerCase() === this.cfg.settlementAddress.toLowerCase(),
    };
  }

  async kycStatus(account: string): Promise<'GRANTED' | 'NOT_GRANTED'> {
    return (await this.bond.getKycStatusFor(account)) === 1n ? 'GRANTED' : 'NOT_GRANTED';
  }

  async setKyc(account: string, granted: boolean): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const tx = granted
      ? await this.bond.grantKyc(account, `vc-sotto-${account.slice(2, 10)}`, now - 60, now + 365 * 24 * 3600, this.issuer.address, { gasLimit: 1_500_000 })
      : await this.bond.revokeKyc(account, { gasLimit: 1_500_000 });
    await tx.wait();
    return tx.hash;
  }

  /**
   * A6: reconcile against the mirror node. The receipt tells you a transaction
   * committed; it does not tell you the state is visible yet. Confirm
   * optimistically on the receipt, reconcile from the mirror node after.
   */
  async settledEvents(fromBlock = -2000): Promise<Array<{ rfqId: string; txHash: string; blockNumber: number }>> {
    const latest = await this.provider.getBlockNumber();
    const start = fromBlock < 0 ? Math.max(0, latest + fromBlock) : fromBlock;
    const logs = await this.provider.getLogs({
      address: this.cfg.settlementAddress,
      fromBlock: start,
      toBlock: latest,
      topics: [ethers.id('Settled(bytes32,address,address,uint256,uint256,address,address)')],
    });
    return logs.map(l => ({ rfqId: l.topics[1], txHash: l.transactionHash, blockNumber: l.blockNumber }));
  }

  async blockHeight(): Promise<number> {
    return this.provider.getBlockNumber();
  }
}
