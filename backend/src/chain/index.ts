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
  // The band the guard actually enforces. Read from the contract rather than
  // mirrored as a constant, so what the UI shows a dealer cannot drift from
  // what settle() will reject them for.
  'function bandBps() view returns (uint16)',
  'function navOracle() view returns (address)',
  // The authoritative record of which nonces are spent. nonces() returns a
  // COUNT of settlements, which is a different thing - see safeNonceBase.
  'function nonceUsed(address,uint256) view returns (bool)',
  'event Settled(bytes32 indexed rfqId,address indexed seller,address indexed buyer,uint256 quantity,uint256 notional,address assetToken,address cashToken)',
];

export const CASH_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  // The issuer pays redemption principal with a plain transfer. ATS burns the
  // units; it does not move money, so the cash leg is ours to make.
  'function transfer(address,uint256) returns (bool)',
];

export const NAV_ORACLE_ABI = [
  'function referenceFor(address) view returns (uint256,uint64,uint8)',
  'function hasReference(address) view returns (bool)',
  'function isFresh(address) view returns (bool)',
  'function maxAge() view returns (uint64)',
  'function priceSource(address) view returns (address)',
  'function publishNav(address,uint256,uint8)',
];

/**
 * The Bond facet's maturity surface. ATS v3.1.0 role hashes and guards - see
 * docs/ATS-SPIKE.md, "Redemption at maturity, and why maturity only moves
 * forward". fullRedeemAtMaturity is gated on
 * onlyAfterCurrentMaturityDate(_blockTimestamp()), so an early call reverts
 * with BondMaturityDateWrong() (selector 0x67d08758) rather than succeeding.
 */
export const BOND_LIFECYCLE_ABI = [
  'function getBondDetails() view returns ((bytes3 currency,uint256 nominalValue,uint8 nominalValueDecimals,uint256 startingDate,uint256 maturityDate))',
  'function getPrincipalFor(address) view returns ((uint256 numerator,uint256 denominator))',
  'function fullRedeemAtMaturity(address)',
  'function balanceOfByPartition(bytes32,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function getKycStatusFor(address) view returns (uint8)',
];

export interface ChainConfig {
  rpcUrl: string;
  mirrorUrl: string;
  bondAddress: string;
  settlementAddress: string;
  cashAddress: string;
  issuerKey: string;
  /** SottoNavOracle. Absent = the band guard is not configured. */
  navOracleAddress?: string;
  /** Short-dated note used for the redemption demo. */
  shortBondAddress?: string;
}

/** What the issuer portal needs to render the band guard honestly. */
export interface NavState {
  assetToken: string;
  /** Null when no reference has ever been published for this asset. */
  price: string | null;
  decimals: number;
  updatedAt: number | null;
  ageSeconds: number | null;
  fresh: boolean;
  maxAge: number;
  /** A configured IPriceSource wins over the published NAV - see the oracle. */
  source: 'administrator' | 'market-feed' | 'none';
  priceSource: string | null;
  oracle: string;
}

/** Redemption state for one holder of one bond. */
export interface LifecycleState {
  assetToken: string;
  symbol: string;
  name: string;
  currency: string;
  nominalValue: string;
  nominalValueDecimals: number;
  maturityDate: number;
  matured: boolean;
  secondsToMaturity: number;
  totalSupply: string;
  holder: string;
  holderUnits: string;
  holderKyc: 'GRANTED' | 'NOT_GRANTED';
  /** units x nominalValue, in cash base units. */
  principalDue: string;
  issuerCash: string;
  issuerCanPay: boolean;
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
  readonly navOracle: ethers.Contract | null;

  constructor(readonly cfg: ChainConfig) {
    this.provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
    this.issuer = new ethers.Wallet(cfg.issuerKey, this.provider);
    this.bond = new ethers.Contract(cfg.bondAddress, BOND_ABI, this.issuer);
    this.settlement = new ethers.Contract(cfg.settlementAddress, SETTLEMENT_ABI, this.issuer);
    this.cash = new ethers.Contract(cfg.cashAddress, CASH_ABI, this.provider);
    this.navOracle = cfg.navOracleAddress
      ? new ethers.Contract(cfg.navOracleAddress, NAV_ORACLE_ABI, this.issuer)
      : null;
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

  // ----------------------------------------------------------- NAV / band

  /**
   * Read the band guard's reference for an asset.
   *
   * `referenceFor` REVERTS when nothing has been published and no market source
   * is configured, so the absence of a reference is an exception, not a zero.
   * Surfacing that difference is the whole point of this call: a settlement
   * against a stale or missing reference reverts at ~59,000 gas with nothing
   * useful in the message, which reads as a broken app rather than a working
   * control. The portal shows the age so the refusal is legible BEFORE anyone
   * signs anything.
   */
  /**
   * The band the deployed settlement will enforce, in basis points.
   *
   * A fresh settlement starts with navOracle unset, and settle() skips the band
   * entirely in that case - so "there is a band" and "the band is on" are two
   * different questions and both belong on screen. Null means no oracle is
   * wired and no price will be refused for being off-market.
   */
  /**
   * The first of `count` consecutive nonces that no participant has spent.
   *
   * SottoSettlement keeps two different things: `nonceUsed[addr][n]`, the set of
   * nonces actually consumed, and `_nextNonce[addr]`, a counter incremented once
   * per settlement and returned by `nonces()`. They agree only while every
   * assigned nonce is consumed in order, and a partial fill breaks that: a
   * request awarded nonces 2 and 3 where only 3 settled leaves the counter at 3
   * and nonce 3 spent. Basing the next award on the counter then handed out a
   * nonce already in the used set, and the settlement reverted with
   * NonceAlreadyUsed after the seller had signed.
   *
   * So ask the set. Every fill marks its nonce used for the seller AND the
   * buyer, so a nonce is only safe if it is free for all of them - the dealers
   * checked here are everyone who revealed, not just the eventual winners,
   * because the winners are not known until the book is allocated.
   */
  /**
   * Replay a reverted transaction to recover its revert payload.
   *
   * Hedera's relay returns `data=null` on the error from a sent transaction, so
   * a custom error's four bytes never reach the caller and every revert decodes
   * as UNKNOWN. eth_call against the same block returns them.
   */
  async revertDataFor(txHash: string): Promise<string | null> {
    try {
      const tx = await this.provider.getTransaction(txHash);
      if (!tx) return null;
      await this.provider.call({
        to: tx.to ?? undefined,
        from: tx.from,
        data: tx.data,
        blockTag: tx.blockNumber ?? undefined,
      });
      return null; // replayed without reverting; nothing to decode
    } catch (e) {
      const o = e as { data?: unknown; info?: { error?: { data?: unknown } } };
      const d = o.data ?? o.info?.error?.data;
      return typeof d === 'string' && d.startsWith('0x') ? d : null;
    }
  }

  async safeNonceBase(seller: string, dealers: string[], count: number): Promise<number> {
    const parties = [seller, ...dealers];
    const counters = await Promise.all(
      parties.map((p) => this.settlement.nonces(p) as Promise<bigint>)
    );
    let base = Number(counters.reduce((a, b) => (a > b ? a : b), 0n));

    // Bounded: a venue that cannot find a free window in 512 tries has a
    // problem no retry will fix, and an unbounded loop would hang the award.
    for (let attempt = 0; attempt < 512; attempt += 1) {
      const checks: Promise<boolean>[] = [];
      for (let i = 0; i < count; i += 1) {
        for (const party of parties) {
          checks.push(this.settlement.nonceUsed(party, base + i) as Promise<boolean>);
        }
      }
      if (!(await Promise.all(checks)).some(Boolean)) return base;
      base += 1;
    }
    throw new Error(`no free window of ${count} nonces found above ${base}`);
  }

  async navBandBps(): Promise<number | null> {
    try {
      const oracle = (await this.settlement.navOracle?.()) as string | undefined;
      if (oracle && oracle === ethers.ZeroAddress) return null;
      return Number(await this.settlement.bandBps());
    } catch {
      return null;
    }
  }

  async navState(assetToken: string): Promise<NavState | null> {
    if (!this.navOracle) return null;
    const oracle = this.navOracle;
    const [maxAge, priceSource] = await Promise.all([
      oracle.maxAge() as Promise<bigint>,
      oracle.priceSource(assetToken) as Promise<string>,
    ]);
    const hasSource = priceSource !== ethers.ZeroAddress;

    const base = {
      assetToken,
      maxAge: Number(maxAge),
      priceSource: hasSource ? priceSource : null,
      oracle: this.cfg.navOracleAddress as string,
    };

    try {
      const [price, updatedAt, decimals] = await oracle.referenceFor(assetToken);
      const age = Math.floor(Date.now() / 1000) - Number(updatedAt);
      return {
        ...base,
        price: (price as bigint).toString(),
        decimals: Number(decimals),
        updatedAt: Number(updatedAt),
        ageSeconds: age,
        fresh: age <= Number(maxAge),
        source: hasSource ? 'market-feed' : 'administrator',
      };
    } catch {
      // NoReference, or a market source that refused (stale round, bad answer).
      return {
        ...base,
        price: null,
        decimals: 6,
        updatedAt: null,
        ageSeconds: null,
        fresh: false,
        source: hasSource ? 'market-feed' : 'none',
      };
    }
  }

  /**
   * Publish an administrator NAV. This is the ordinary act the oracle is
   * designed around - a fund administrator strikes a NAV and publishes it - and
   * it is deliberately a deliberate act. Nothing here republishes on a timer:
   * an automated re-stamp of a constant would leave the staleness guard looking
   * intact on-chain while making it impossible for it to ever fire.
   */
  async publishNav(assetToken: string, price: bigint, decimals: number): Promise<string> {
    if (!this.navOracle) throw new Error('no NAV oracle configured');
    const tx = await this.navOracle.publishNav(assetToken, price, decimals, { gasLimit: 1_000_000 });
    await tx.wait();
    return tx.hash;
  }

  // ------------------------------------------------------------ redemption

  /** The short-dated note, unless a specific token is asked for. */
  redemptionToken(assetToken?: string | null): string {
    const token = assetToken || this.cfg.shortBondAddress || this.cfg.bondAddress;
    return ethers.getAddress(token);
  }

  async lifecycleState(assetToken: string, holder: string): Promise<LifecycleState> {
    const bond = new ethers.Contract(assetToken, BOND_LIFECYCLE_ABI, this.provider);
    const [details, symbol, name, totalSupply, holderUnits, kyc, issuerCash] = await Promise.all([
      bond.getBondDetails(),
      bond.symbol() as Promise<string>,
      bond.name() as Promise<string>,
      bond.totalSupply() as Promise<bigint>,
      bond.balanceOfByPartition(PARTITION_DEFAULT, holder) as Promise<bigint>,
      bond.getKycStatusFor(holder) as Promise<bigint>,
      this.cash.balanceOf(this.issuer.address) as Promise<bigint>,
    ]);

    const maturityDate = Number(details.maturityDate);
    const now = Math.floor(Date.now() / 1000);
    // Principal is units x nominalValue in the bond's own currency. The chain
    // agrees: getPrincipalFor returns the same figure as numerator/denominator.
    const principalDue = (holderUnits as bigint) * (details.nominalValue as bigint);

    return {
      assetToken,
      symbol,
      name,
      currency: Buffer.from(String(details.currency).slice(2), 'hex').toString('utf8'),
      nominalValue: (details.nominalValue as bigint).toString(),
      nominalValueDecimals: Number(details.nominalValueDecimals),
      maturityDate,
      matured: now >= maturityDate,
      secondsToMaturity: maturityDate - now,
      totalSupply: (totalSupply as bigint).toString(),
      holder,
      holderUnits: (holderUnits as bigint).toString(),
      holderKyc: kyc === 1n ? 'GRANTED' : 'NOT_GRANTED',
      principalDue: principalDue.toString(),
      issuerCash: (issuerCash as bigint).toString(),
      issuerCanPay: (issuerCash as bigint) >= principalDue,
    };
  }

  /**
   * Redeem a holder out at maturity: pay the principal, THEN burn the units.
   *
   * The order is not cosmetic. ATS burns units and does not move money, so if
   * the cash leg were second a failure there would leave a holder with nothing
   * -- no units and no payment. Paid first, a holder who is not paid still
   * holds their claim.
   */
  async redeemAtMaturity(assetToken: string, holder: string): Promise<{
    cashTxHash: string | null;
    redeemTxHash: string;
    unitsBurned: string;
    principalPaid: string;
  }> {
    const state = await this.lifecycleState(assetToken, holder);
    if (!state.matured) {
      throw new Error(
        `the bond matures ${new Date(state.maturityDate * 1000).toISOString()}; ` +
        'fullRedeemAtMaturity reverts with BondMaturityDateWrong() before then'
      );
    }
    if (state.holderUnits === '0') throw new Error('the holder has no units to redeem');
    if (!state.issuerCanPay) {
      throw new Error(
        `the issuer holds ${state.issuerCash} cash base units but owes ${state.principalDue}; ` +
        'the burn is deliberately not run, because the units are the holder\'s claim on that cash'
      );
    }

    const principal = BigInt(state.principalDue);
    let cashTxHash: string | null = null;
    if (principal > 0n) {
      const cashWriter = this.cash.connect(this.issuer) as ethers.Contract;
      const payTx = await cashWriter.transfer(holder, principal, { gasLimit: 1_000_000 });
      await payTx.wait();
      cashTxHash = payTx.hash;
    }

    const bond = new ethers.Contract(assetToken, BOND_LIFECYCLE_ABI, this.issuer);
    const tx = await bond.fullRedeemAtMaturity(holder, { gasLimit: 4_000_000 });
    await tx.wait();

    return {
      cashTxHash,
      redeemTxHash: tx.hash,
      unitsBurned: state.holderUnits,
      principalPaid: principal.toString(),
    };
  }
}
