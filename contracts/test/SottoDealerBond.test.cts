// Reveal-or-forfeit bonding. The properties that matter are that a HONEST
// dealer always gets their bond back without anyone's permission, and that a
// dealer who vanishes pays the SELLER, not the venue.
import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers';

const RFQ = '0x2222222222222222222222222222222222222222222222222222222222222222';
const QUANTITY = 250n;
const MIN_BOND = 5_000_000n;   // 5 USDC at 6dp
const PRICE = 98_350_000n;

/** Same formula as packages/shared/src/commit.ts and the contract. */
function computeCommit(price: bigint, quantity: bigint, nonce: string, dealer: string) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint256', 'uint256', 'bytes32', 'address'],
      [price, quantity, nonce, dealer]
    )
  );
}

async function fixture() {
  const [venue, seller, honest, vanisher, stranger] = await ethers.getSigners();
  const cash = await (await ethers.getContractFactory('MockCash')).deploy();
  const bond = await (await ethers.getContractFactory('SottoDealerBond'))
    .deploy(venue.address, await cash.getAddress());

  for (const d of [honest, vanisher]) {
    await cash.mint(d.address, 100_000_000n);
    await cash.connect(d).approve(await bond.getAddress(), ethers.MaxUint256);
  }

  const revealDeadline = BigInt((await time.latest()) + 600);
  await bond.openAuction(RFQ, seller.address, QUANTITY, revealDeadline, MIN_BOND);

  return { venue, seller, honest, vanisher, stranger, cash, bond, revealDeadline };
}

describe('SottoDealerBond', () => {
  it('returns the bond to a dealer who reveals correctly', async () => {
    const { honest, cash, bond } = await loadFixture(fixture);
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const before = await cash.balanceOf(honest.address);

    await bond.connect(honest).postBond(RFQ, computeCommit(PRICE, QUANTITY, nonce, honest.address), MIN_BOND);
    expect(await cash.balanceOf(honest.address)).to.equal(before - MIN_BOND);

    await expect(bond.connect(honest).revealAndRelease(RFQ, PRICE, nonce))
      .to.emit(bond, 'BondReleased').withArgs(RFQ, honest.address, MIN_BOND, PRICE);
    expect(await cash.balanceOf(honest.address)).to.equal(before);
  });

  it('slashes a dealer who never reveals, and pays the SELLER not the venue', async () => {
    const { venue, seller, vanisher, cash, bond, revealDeadline } = await loadFixture(fixture);
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    await bond.connect(vanisher).postBond(RFQ, computeCommit(PRICE, QUANTITY, nonce, vanisher.address), MIN_BOND);

    const sellerBefore = await cash.balanceOf(seller.address);
    const venueBefore = await cash.balanceOf(venue.address);

    await time.increaseTo(revealDeadline + 1n);
    await expect(bond.slash(RFQ, vanisher.address))
      .to.emit(bond, 'BondSlashed').withArgs(RFQ, vanisher.address, seller.address, MIN_BOND);

    expect(await cash.balanceOf(seller.address)).to.equal(sellerBefore + MIN_BOND);
    expect(await cash.balanceOf(venue.address)).to.equal(venueBefore); // venue gains nothing
  });

  // The venue must not be able to slash at will, and must not be needed to release.
  it('lets ANYONE trigger a slash - the seller never waits on the venue', async () => {
    const { stranger, seller, vanisher, cash, bond, revealDeadline } = await loadFixture(fixture);
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    await bond.connect(vanisher).postBond(RFQ, computeCommit(PRICE, QUANTITY, nonce, vanisher.address), MIN_BOND);

    await time.increaseTo(revealDeadline + 1n);
    const before = await cash.balanceOf(seller.address);
    await bond.connect(stranger).slash(RFQ, vanisher.address); // unrelated address
    expect(await cash.balanceOf(seller.address)).to.equal(before + MIN_BOND);
  });

  it('refuses a slash while the reveal window is still open', async () => {
    const { vanisher, bond } = await loadFixture(fixture);
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    await bond.connect(vanisher).postBond(RFQ, computeCommit(PRICE, QUANTITY, nonce, vanisher.address), MIN_BOND);
    await expect(bond.slash(RFQ, vanisher.address)).to.be.revertedWithCustomError(bond, 'RevealWindowOpen');
  });

  it('refuses a reveal that does not match the commit', async () => {
    const { honest, bond } = await loadFixture(fixture);
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    await bond.connect(honest).postBond(RFQ, computeCommit(PRICE, QUANTITY, nonce, honest.address), MIN_BOND);
    // same nonce, altered price
    await expect(bond.connect(honest).revealAndRelease(RFQ, 99_999_999n, nonce))
      .to.be.revertedWithCustomError(bond, 'CommitMismatch');
  });

  it('will not let a dealer bond below the minimum', async () => {
    const { honest, bond } = await loadFixture(fixture);
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    await expect(
      bond.connect(honest).postBond(RFQ, computeCommit(PRICE, QUANTITY, nonce, honest.address), MIN_BOND - 1n)
    ).to.be.revertedWithCustomError(bond, 'BondTooSmall');
  });

  it('cannot slash a dealer twice, or slash one who revealed', async () => {
    const { honest, vanisher, bond, revealDeadline } = await loadFixture(fixture);
    const n1 = ethers.hexlify(ethers.randomBytes(32));
    const n2 = ethers.hexlify(ethers.randomBytes(32));
    await bond.connect(honest).postBond(RFQ, computeCommit(PRICE, QUANTITY, n1, honest.address), MIN_BOND);
    await bond.connect(vanisher).postBond(RFQ, computeCommit(PRICE, QUANTITY, n2, vanisher.address), MIN_BOND);
    await bond.connect(honest).revealAndRelease(RFQ, PRICE, n1);

    await time.increaseTo(revealDeadline + 1n);
    await bond.slash(RFQ, vanisher.address);
    await expect(bond.slash(RFQ, vanisher.address)).to.be.revertedWithCustomError(bond, 'AlreadyResolved');
    await expect(bond.slash(RFQ, honest.address)).to.be.revertedWithCustomError(bond, 'AlreadyResolved');
  });

  it('has no venue function that can release or redirect a bond', async () => {
    const { bond } = await loadFixture(fixture);
    const names = bond.interface.fragments
      .filter((f): f is import('ethers').FunctionFragment => f.type === 'function')
      .map(f => f.name);
    // The venue's only privilege is openAuction. Everything else is the dealer's
    // own reveal, or a permissionless slash.
    expect(names).to.include('openAuction');
    expect(names).to.not.include('releaseBond');
    expect(names).to.not.include('withdraw');
    expect(names).to.not.include('sweep');
  });
});
