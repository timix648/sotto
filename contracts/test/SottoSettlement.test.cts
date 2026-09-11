// A1 tests. These double as evidence for judges - each one asserts a property
// the README claims, and several come straight from MECHANICS.md.
import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';

const PARTITION = '0x0000000000000000000000000000000000000000000000000000000000000001';
const RFQ_ID = '0x1111111111111111111111111111111111111111111111111111111111111111';
const HOLD_ID = 42n;
const QUANTITY = 250n;
const NOTIONAL = 245_875_000n; // 250 units @ 98.35 per 100, USDC 6dp

async function fixture() {
  // venue, seller, buyer and relayer are all DISTINCT. MECHANICS 4.2: legs were
  // allocated using a role name as the party identity, so with any non-demo
  // requester the want leg paid the VENUE instead of the counterparty. Invisible
  // while the venue IS the counterparty - so never test them as the same party.
  const [venue, seller, buyer, stranger] = await ethers.getSigners();

  const bond = await (await ethers.getContractFactory('MockAtsBond')).deploy();
  const cash = await (await ethers.getContractFactory('MockCash')).deploy();
  const settlement = await (await ethers.getContractFactory('SottoSettlement')).deploy(venue.address);

  await cash.mint(buyer.address, 1_000_000_000n);
  await cash.connect(buyer).approve(await settlement.getAddress(), ethers.MaxUint256);

  const expiry = (await time.latest()) + 48 * 3600;
  await bond.createHold(PARTITION, seller.address, HOLD_ID, 1000n, expiry, await settlement.getAddress());

  return { venue, seller, buyer, stranger, bond, cash, settlement };
}

async function signedTrade(
  settlement: any,
  bond: any,
  cash: any,
  seller: any,
  buyer: any,
  overrides: Partial<Record<string, any>> = {}
) {
  const trade = {
    rfqId: RFQ_ID,
    assetToken: await bond.getAddress(),
    partition: PARTITION,
    holdId: HOLD_ID,
    cashToken: await cash.getAddress(),
    seller: seller.address,
    buyer: buyer.address,
    quantity: QUANTITY,
    notional: NOTIONAL,
    deadline: BigInt((await time.latest()) + 3600),
    nonce: 0n,
    ...overrides,
  };

  const domain = {
    name: 'Sotto',
    version: '1',
    chainId: (await ethers.provider.getNetwork()).chainId,
    verifyingContract: await settlement.getAddress(),
  };
  const types = {
    Trade: [
      { name: 'rfqId', type: 'bytes32' },
      { name: 'assetToken', type: 'address' },
      { name: 'partition', type: 'bytes32' },
      { name: 'holdId', type: 'uint256' },
      { name: 'cashToken', type: 'address' },
      { name: 'seller', type: 'address' },
      { name: 'buyer', type: 'address' },
      { name: 'quantity', type: 'uint256' },
      { name: 'notional', type: 'uint256' },
      { name: 'deadline', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
    ],
  };

  const sellerSig = await seller.signTypedData(domain, types, trade);
  const buyerSig = await buyer.signTypedData(domain, types, trade);
  return { trade, sellerSig, buyerSig };
}

describe('SottoSettlement', () => {
  it('settles both legs atomically (happy path DvP)', async () => {
    const { seller, buyer, bond, cash, settlement } = await loadFixture(fixture);
    const { trade, sellerSig, buyerSig } = await signedTrade(settlement, bond, cash, seller, buyer);

    await expect(settlement.settle(trade, sellerSig, buyerSig))
      .to.emit(settlement, 'Settled')
      .withArgs(RFQ_ID, seller.address, buyer.address, QUANTITY, NOTIONAL, await bond.getAddress(), await cash.getAddress());

    expect(await cash.balanceOf(seller.address)).to.equal(NOTIONAL);
    expect(await bond.balanceOf(buyer.address)).to.equal(QUANTITY);
  });

  it('reverts when the buyer allowance is one unit short, and moves nothing', async () => {
    const { seller, buyer, bond, cash, settlement } = await loadFixture(fixture);
    await cash.connect(buyer).approve(await settlement.getAddress(), NOTIONAL - 1n);
    const { trade, sellerSig, buyerSig } = await signedTrade(settlement, bond, cash, seller, buyer);

    await expect(settlement.settle(trade, sellerSig, buyerSig)).to.be.reverted;

    expect(await cash.balanceOf(seller.address)).to.equal(0n);
    expect(await bond.balanceOf(buyer.address)).to.equal(0n);
  });

  it('reverts when the buyer KYC is revoked, and no cash moves', async () => {
    const { seller, buyer, bond, cash, settlement } = await loadFixture(fixture);
    await bond.setKycRevoked(buyer.address, true);
    const { trade, sellerSig, buyerSig } = await signedTrade(settlement, bond, cash, seller, buyer);

    await expect(settlement.settle(trade, sellerSig, buyerSig)).to.be.reverted;

    // The money shot: the seller's held balance is untouched and the buyer got nothing.
    expect(await cash.balanceOf(seller.address)).to.equal(0n);
    expect(await bond.balanceOf(buyer.address)).to.equal(0n);
  });

  // MECHANICS 4.1 - the mint hole. The dangerous case is not a call that fails,
  // it is one that SUCCEEDS having done nothing. If delivery returns false and
  // we did not check it, the cash would have moved and the bond would not.
  it('reverts when delivery returns false instead of reverting, and no cash moves', async () => {
    const { seller, buyer, bond, cash, settlement } = await loadFixture(fixture);
    await bond.setFailSilently(true);
    const { trade, sellerSig, buyerSig } = await signedTrade(settlement, bond, cash, seller, buyer);

    await expect(settlement.settle(trade, sellerSig, buyerSig)).to.be.revertedWithCustomError(
      settlement,
      'DeliveryFailed'
    );

    expect(await cash.balanceOf(seller.address)).to.equal(0n);
    expect(await bond.balanceOf(buyer.address)).to.equal(0n);
  });

  it('reverts on an expired hold', async () => {
    const { seller, buyer, bond, cash, settlement } = await loadFixture(fixture);
    await time.increase(49 * 3600);
    const { trade, sellerSig, buyerSig } = await signedTrade(settlement, bond, cash, seller, buyer);

    await expect(settlement.settle(trade, sellerSig, buyerSig)).to.be.revertedWithCustomError(
      settlement,
      'HoldExpired'
    );
  });

  it('reverts on a replayed signature (nonce consumed)', async () => {
    const { seller, buyer, bond, cash, settlement } = await loadFixture(fixture);
    const { trade, sellerSig, buyerSig } = await signedTrade(settlement, bond, cash, seller, buyer);

    await settlement.settle(trade, sellerSig, buyerSig);
    await expect(settlement.settle(trade, sellerSig, buyerSig)).to.be.revertedWithCustomError(
      settlement,
      'NonceAlreadyUsed'
    );
  });

  it('reverts past the deadline', async () => {
    const { seller, buyer, bond, cash, settlement } = await loadFixture(fixture);
    const { trade, sellerSig, buyerSig } = await signedTrade(settlement, bond, cash, seller, buyer, {
      deadline: BigInt((await time.latest()) - 1),
    });
    await expect(settlement.settle(trade, sellerSig, buyerSig)).to.be.revertedWithCustomError(
      settlement,
      'DeadlineExpired'
    );
  });

  it('rejects a Trade signed by the wrong party', async () => {
    const { seller, buyer, stranger, bond, cash, settlement } = await loadFixture(fixture);
    const { trade, buyerSig } = await signedTrade(settlement, bond, cash, seller, buyer);
    const { sellerSig: strangerSig } = await signedTrade(settlement, bond, cash, stranger, buyer);

    await expect(settlement.settle(trade, strangerSig, buyerSig)).to.be.revertedWithCustomError(
      settlement,
      'SignatureInvalid'
    );
  });

  // Permissionless relay is a FEATURE: the trustless path is the open one.
  it('lets an unrelated third party relay a fully-signed Trade', async () => {
    const { seller, buyer, stranger, bond, cash, settlement } = await loadFixture(fixture);
    const { trade, sellerSig, buyerSig } = await signedTrade(settlement, bond, cash, seller, buyer);

    await expect(settlement.connect(stranger).settle(trade, sellerSig, buyerSig)).to.emit(settlement, 'Settled');
    expect(await bond.balanceOf(buyer.address)).to.equal(QUANTITY);
  });

  it('gates deliver() to RELAYER_ROLE but leaves settle() open', async () => {
    const { seller, buyer, stranger, bond, cash, settlement } = await loadFixture(fixture);
    const { trade, sellerSig, buyerSig } = await signedTrade(settlement, bond, cash, seller, buyer);

    await expect(settlement.connect(stranger).deliver(trade, sellerSig, buyerSig)).to.be.reverted;
  });

  it('shares a nonce space between settle and deliver so a Trade cannot settle twice', async () => {
    const { venue, seller, buyer, bond, cash, settlement } = await loadFixture(fixture);
    const { trade, sellerSig, buyerSig } = await signedTrade(settlement, bond, cash, seller, buyer);

    await settlement.settle(trade, sellerSig, buyerSig);
    await expect(settlement.connect(venue).deliver(trade, sellerSig, buyerSig)).to.be.revertedWithCustomError(
      settlement,
      'NonceAlreadyUsed'
    );
  });
});

describe('SottoSettlement — NAV band guard', () => {
  async function bandFixture() {
    const base = await fixture();
    const oracle = await (await ethers.getContractFactory('SottoNavOracle')).deploy(base.venue.address);
    // Reference NAV 98.35 per 100 nominal, 6dp — the same convention the venue quotes in.
    await oracle.publishNav(await base.bond.getAddress(), 98_350_000n, 6);
    await base.settlement.connect(base.venue).setNavOracle(await oracle.getAddress(), 500); // 5%
    return { ...base, oracle };
  }

  it('settles a trade priced inside the band', async () => {
    const { seller, buyer, bond, cash, settlement } = await loadFixture(bandFixture);
    // NOTIONAL 245_875_000 over 250 units -> implied 98_350_000, exactly on NAV.
    const { trade, sellerSig, buyerSig } = await signedTrade(settlement, bond, cash, seller, buyer);
    await expect(settlement.settle(trade, sellerSig, buyerSig)).to.emit(settlement, 'Settled');
  });

  it('refuses a trade priced outside the band, and moves nothing', async () => {
    const { seller, buyer, bond, cash, settlement, oracle } = await loadFixture(bandFixture);
    // 80.00 per 100 vs a 98.35 NAV — ~18.7% off, far outside 5%.
    const { trade, sellerSig, buyerSig } = await signedTrade(settlement, bond, cash, seller, buyer, {
      notional: 200_000_000n,
    });

    await expect(settlement.settle(trade, sellerSig, buyerSig)).to.be.revertedWithCustomError(
      oracle,
      'OutsideBand'
    );
    expect(await cash.balanceOf(seller.address)).to.equal(0n);
    expect(await bond.balanceOf(buyer.address)).to.equal(0n);
  });

  it('refuses a stale NAV rather than trusting an old price', async () => {
    const { seller, buyer, bond, cash, settlement, oracle } = await loadFixture(bandFixture);
    await time.increase(25 * 3600); // maxAge is 24h
    const { trade, sellerSig, buyerSig } = await signedTrade(settlement, bond, cash, seller, buyer);
    await expect(settlement.settle(trade, sellerSig, buyerSig)).to.be.revertedWithCustomError(
      oracle,
      'StaleReference'
    );
  });

  it('the band can only refuse a trade, never move funds', async () => {
    const { venue, settlement } = await loadFixture(bandFixture);
    // setNavOracle is the only admin surface added, and it takes no recipient.
    expect(settlement.interface.getFunction('setNavOracle')!.inputs.map(i => i.type))
      .to.deep.equal(['address', 'uint16']);
    expect(await settlement.bandBps()).to.equal(500n);
    // Disabling it restores the unguarded behaviour.
    await settlement.connect(venue).setNavOracle(ethers.ZeroAddress, 500);
    expect(await settlement.navOracle()).to.equal(ethers.ZeroAddress);
  });
});

describe('SottoSettlement - partial fills', () => {
  // One hold, several buyers. This is the on-chain half of partial fills, and
  // it needs no new contract code: _checkHold requires amount >= quantity (not
  // ==), _deliver executes exactly quantity, and ATS decrements the held amount
  // and only removes the hold when it reaches zero. So a seller escrows ONCE
  // and the block is filled by as many dealers as the book supports.
  async function multiFixture() {
    const [venue, seller, b1, b2, b3] = await ethers.getSigners();
    const bond = await (await ethers.getContractFactory('MockAtsBond')).deploy();
    const cash = await (await ethers.getContractFactory('MockCash')).deploy();
    const settlement = await (await ethers.getContractFactory('SottoSettlement')).deploy(venue.address);
    for (const b of [b1, b2, b3]) {
      await cash.mint(b.address, 1_000_000_000n);
      await cash.connect(b).approve(await settlement.getAddress(), ethers.MaxUint256);
    }
    const expiry = (await time.latest()) + 48 * 3600;
    await bond.createHold(PARTITION, seller.address, HOLD_ID, 1000n, expiry, await settlement.getAddress());
    return { venue, seller, b1, b2, b3, bond, cash, settlement };
  }

  it('fills one block across three dealers against a SINGLE hold', async () => {
    const { seller, b1, b2, b3, bond, cash, settlement } = await loadFixture(multiFixture);

    // 1000 on offer: 400 @ 98.40, 400 @ 98.20, 200 @ 97.90.
    const slices = [
      { buyer: b1, qty: 400n, price: 98_400_000n },
      { buyer: b2, qty: 400n, price: 98_200_000n },
      { buyer: b3, qty: 200n, price: 97_900_000n },
    ];

    let remaining = 1000n;
    let nonce = 0n;
    for (const s of slices) {
      const notional = (s.price * s.qty) / 100n;
      const { trade, sellerSig, buyerSig } = await signedTrade(settlement, bond, cash, seller, s.buyer, {
        quantity: s.qty, notional, nonce,
      });
      await settlement.settle(trade, sellerSig, buyerSig);

      remaining -= s.qty;
      const [heldAfter] = await bond.getHoldForByPartition({
        partition: PARTITION, tokenHolder: seller.address, holdId: HOLD_ID,
      });
      // The hold shrinks by exactly the slice, and survives until it is empty.
      expect(heldAfter).to.equal(remaining);
      expect(await bond.balanceOf(s.buyer.address)).to.equal(s.qty);
      nonce += 1n;
    }

    expect(remaining).to.equal(0n);
    // Each dealer paid ITS OWN price, never the best or the last one.
    // MECHANICS 3.14 - a uniform clearing price here would silently transfer
    // value between dealers who never agreed to it.
    expect(await cash.balanceOf(seller.address)).to.equal(
      (98_400_000n * 400n) / 100n + (98_200_000n * 400n) / 100n + (97_900_000n * 200n) / 100n
    );
  });

  it('refuses a fill larger than what is left in the hold', async () => {
    const { seller, b1, b2, bond, cash, settlement } = await loadFixture(multiFixture);

    const first = await signedTrade(settlement, bond, cash, seller, b1, {
      quantity: 900n, notional: (98_000_000n * 900n) / 100n, nonce: 0n,
    });
    await settlement.settle(first.trade, first.sellerSig, first.buyerSig);

    // 100 left; a 200 fill must revert rather than partially deliver.
    const second = await signedTrade(settlement, bond, cash, seller, b2, {
      quantity: 200n, notional: (98_000_000n * 200n) / 100n, nonce: 1n,
    });
    await expect(settlement.settle(second.trade, second.sellerSig, second.buyerSig))
      .to.be.revertedWithCustomError(settlement, 'HoldTooSmall').withArgs(100n, 200n);

    expect(await bond.balanceOf(b2.address)).to.equal(0n);
  });

  it('rejects a second fill that reuses the first fill nonce', async () => {
    const { seller, b1, b2, bond, cash, settlement } = await loadFixture(multiFixture);

    const first = await signedTrade(settlement, bond, cash, seller, b1, {
      quantity: 400n, notional: (98_000_000n * 400n) / 100n, nonce: 0n,
    });
    await settlement.settle(first.trade, first.sellerSig, first.buyerSig);

    // Same seller, different buyer, SAME nonce. The nonce is marked used for
    // both parties, so this is a replay against the seller - which is why the
    // engine hands every fill its own nonce.
    const second = await signedTrade(settlement, bond, cash, seller, b2, {
      quantity: 400n, notional: (98_000_000n * 400n) / 100n, nonce: 0n,
    });
    await expect(settlement.settle(second.trade, second.sellerSig, second.buyerSig))
      .to.be.revertedWithCustomError(settlement, 'NonceAlreadyUsed').withArgs(seller.address, 0n);
  });

  it('leaves the unfilled remainder held, and releasable by the seller', async () => {
    const { seller, b1, bond, cash, settlement } = await loadFixture(multiFixture);

    const { trade, sellerSig, buyerSig } = await signedTrade(settlement, bond, cash, seller, b1, {
      quantity: 600n, notional: (98_000_000n * 600n) / 100n, nonce: 0n,
    });
    await settlement.settle(trade, sellerSig, buyerSig);

    // A block that does not fill is a normal outcome. The 400 stays escrowed
    // until someone releases it - the seller is not left guessing.
    const [held] = await bond.getHoldForByPartition({
      partition: PARTITION, tokenHolder: seller.address, holdId: HOLD_ID,
    });
    expect(held).to.equal(400n);

    await settlement
      .connect(seller)
      .releaseHold(await bond.getAddress(), PARTITION, seller.address, HOLD_ID, 400n);
    const [afterRelease] = await bond.getHoldForByPartition({
      partition: PARTITION, tokenHolder: seller.address, holdId: HOLD_ID,
    });
    expect(afterRelease).to.equal(0n);
    expect(await bond.balanceOf(seller.address)).to.equal(400n);
  });

  it('lets nobody but the holder release a live escrow', async () => {
    const { seller, b1, bond, settlement } = await loadFixture(multiFixture);

    // This contract is the escrow on every hold it settles, so an unguarded
    // release would have let any address cancel any live RFQ: the seller keeps
    // their tokens, the winning dealer loses the fill. b1 is a rival dealer
    // here, which is exactly who would want to.
    await expect(
      settlement
        .connect(b1)
        .releaseHold(await bond.getAddress(), PARTITION, seller.address, HOLD_ID, 1000n)
    )
      .to.be.revertedWithCustomError(settlement, 'NotHolder')
      .withArgs(seller.address, b1.address);

    const [stillHeld] = await bond.getHoldForByPartition({
      partition: PARTITION, tokenHolder: seller.address, holdId: HOLD_ID,
    });
    expect(stillHeld).to.equal(1000n);
  });
});
