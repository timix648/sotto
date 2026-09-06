// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title SottoDealerBond
 * @notice Reveal-or-forfeit staking for the commit-reveal auction.
 *
 * THE PROBLEM
 * -----------
 * A dealer who commits and never reveals currently just "forfeits" - at zero
 * cost. So spamming an auction with junk commits is free: it inflates the
 * apparent depth, and a dealer can wait to see whether revealing is in their
 * interest and walk away if it is not. That is a free option written by the
 * seller, which is exactly what a real venue refuses to hand out.
 *
 * THE FIX
 * -------
 * A dealer posts a bond to commit. Reveal correctly and it comes back. Fail to
 * reveal before the deadline and it is slashed to the SELLER - the injured
 * party, not the venue. There is no scenario where the venue profits from a
 * slash, which is what keeps the incentive honest.
 *
 * WHY THE VENUE CANNOT CHEAT
 * --------------------------
 * Slashing is not a venue decision. The contract verifies the reveal ITSELF,
 * recomputing the commit with the same formula the dealer used
 * (packages/shared/src/commit.ts, and SottoSettlement's auction):
 *
 *     keccak256(abi.encode(price, quantity, nonce, dealer))
 *
 * If that matches, the bond is released and no one can stop it. If the deadline
 * passes without a valid reveal, ANYONE may trigger the slash - it is
 * permissionless, so a seller is never dependent on the venue acting. The venue
 * role can only open an auction and set its parameters up front; it can neither
 * release nor slash.
 */
contract SottoDealerBond is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant VENUE_ROLE = keccak256("VENUE_ROLE");

    struct Auction {
        address seller;         // receives any slashed bonds
        uint256 quantity;       // bound into every commit for this auction
        uint64 revealDeadline;
        uint256 minBond;
        bool exists;
    }

    struct Posted {
        uint256 amount;
        bytes32 commitHash;
        bool revealed;
        bool resolved;          // released or slashed; terminal
    }

    IERC20 public immutable bondToken;

    mapping(bytes32 => Auction) public auctions;                       // rfqId
    mapping(bytes32 => mapping(address => Posted)) public posted;      // rfqId => dealer
    mapping(bytes32 => uint256) public bondedDealers;                  // rfqId => count

    event AuctionOpened(bytes32 indexed rfqId, address indexed seller, uint256 quantity, uint64 revealDeadline, uint256 minBond);
    event BondPosted(bytes32 indexed rfqId, address indexed dealer, uint256 amount, bytes32 commitHash);
    event BondReleased(bytes32 indexed rfqId, address indexed dealer, uint256 amount, uint256 price);
    event BondSlashed(bytes32 indexed rfqId, address indexed dealer, address indexed seller, uint256 amount);

    error AuctionExists(bytes32 rfqId);
    error NoAuction(bytes32 rfqId);
    error AlreadyPosted(bytes32 rfqId, address dealer);
    error BondTooSmall(uint256 sent, uint256 minBond);
    error RevealWindowClosed(uint64 deadline, uint256 nowTs);
    error RevealWindowOpen(uint64 deadline, uint256 nowTs);
    error NoBond(bytes32 rfqId, address dealer);
    error AlreadyResolved(bytes32 rfqId, address dealer);
    error CommitMismatch(bytes32 expected, bytes32 actual);

    constructor(address admin, IERC20 token) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(VENUE_ROLE, admin);
        bondToken = token;
    }

    /**
     * @notice Open an auction. The venue's ONLY privilege - it fixes the terms
     *         up front and then has no further say in who is paid or slashed.
     */
    function openAuction(
        bytes32 rfqId,
        address seller,
        uint256 quantity,
        uint64 revealDeadline,
        uint256 minBond
    ) external onlyRole(VENUE_ROLE) {
        if (auctions[rfqId].exists) revert AuctionExists(rfqId);
        auctions[rfqId] = Auction({
            seller: seller,
            quantity: quantity,
            revealDeadline: revealDeadline,
            minBond: minBond,
            exists: true
        });
        emit AuctionOpened(rfqId, seller, quantity, revealDeadline, minBond);
    }

    /**
     * @notice Post a bond and commit a sealed quote in one step.
     * @dev The dealer must have approved `amount` of bondToken to this contract.
     */
    function postBond(bytes32 rfqId, bytes32 commitHash, uint256 amount) external nonReentrant {
        Auction memory a = auctions[rfqId];
        if (!a.exists) revert NoAuction(rfqId);
        if (block.timestamp > a.revealDeadline) revert RevealWindowClosed(a.revealDeadline, block.timestamp);
        if (posted[rfqId][msg.sender].amount != 0) revert AlreadyPosted(rfqId, msg.sender);
        if (amount < a.minBond) revert BondTooSmall(amount, a.minBond);

        bondToken.safeTransferFrom(msg.sender, address(this), amount);
        posted[rfqId][msg.sender] = Posted({ amount: amount, commitHash: commitHash, revealed: false, resolved: false });
        unchecked { ++bondedDealers[rfqId]; }

        emit BondPosted(rfqId, msg.sender, amount, commitHash);
    }

    /**
     * @notice Reveal and reclaim the bond. The contract verifies the commit
     *         itself, so release cannot be withheld by anyone.
     * @dev Commit formula is identical to packages/shared/src/commit.ts:
     *      keccak256(abi.encode(price, quantity, nonce, dealer)).
     */
    function revealAndRelease(bytes32 rfqId, uint256 price, bytes32 nonce) external nonReentrant {
        Auction memory a = auctions[rfqId];
        if (!a.exists) revert NoAuction(rfqId);
        if (block.timestamp > a.revealDeadline) revert RevealWindowClosed(a.revealDeadline, block.timestamp);

        Posted storage b = posted[rfqId][msg.sender];
        // Check resolved FIRST: a released bond has amount 0, so the other order
        // reports NoBond for a bond that plainly existed. A misleading error is
        // worse than a missing one.
        if (b.resolved) revert AlreadyResolved(rfqId, msg.sender);
        if (b.amount == 0) revert NoBond(rfqId, msg.sender);

        bytes32 expected = keccak256(abi.encode(price, a.quantity, nonce, msg.sender));
        if (expected != b.commitHash) revert CommitMismatch(expected, b.commitHash);

        b.revealed = true;
        b.resolved = true;
        uint256 amount = b.amount;
        b.amount = 0;

        bondToken.safeTransfer(msg.sender, amount);
        emit BondReleased(rfqId, msg.sender, amount, price);
    }

    /**
     * @notice Slash a dealer who never revealed. PERMISSIONLESS - anyone may
     *         call it once the window has closed, so the seller is never waiting
     *         on the venue to act.
     */
    function slash(bytes32 rfqId, address dealer) external nonReentrant {
        Auction memory a = auctions[rfqId];
        if (!a.exists) revert NoAuction(rfqId);
        if (block.timestamp <= a.revealDeadline) revert RevealWindowOpen(a.revealDeadline, block.timestamp);

        Posted storage b = posted[rfqId][dealer];
        if (b.resolved) revert AlreadyResolved(rfqId, dealer);
        if (b.amount == 0) revert NoBond(rfqId, dealer);

        b.resolved = true;
        uint256 amount = b.amount;
        b.amount = 0;

        // To the SELLER, never to the venue. The venue must not profit from a
        // failed reveal or it has an incentive to design for them.
        bondToken.safeTransfer(a.seller, amount);
        emit BondSlashed(rfqId, dealer, a.seller, amount);
    }

    // ------------------------------------------------------------------ views

    function bondOf(bytes32 rfqId, address dealer) external view returns (uint256 amount, bytes32 commitHash, bool revealed, bool resolved) {
        Posted memory b = posted[rfqId][dealer];
        return (b.amount, b.commitHash, b.revealed, b.resolved);
    }

    /// @notice Would this (price, nonce) satisfy the dealer's commit? Free to call.
    function checkCommit(bytes32 rfqId, address dealer, uint256 price, bytes32 nonce) external view returns (bool) {
        Auction memory a = auctions[rfqId];
        if (!a.exists) return false;
        return keccak256(abi.encode(price, a.quantity, nonce, dealer)) == posted[rfqId][dealer].commitHash;
    }
}
