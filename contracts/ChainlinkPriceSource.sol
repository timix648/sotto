// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IAggregatorV3 } from "./interfaces/IAggregatorV3.sol";

/// @notice The seam SottoNavOracle reads. Kept byte-identical to the interface
///         declared there so this contract is a drop-in.
interface IPriceSource {
    function latestPrice(address asset) external view returns (uint256 price, uint64 updatedAt, uint8 decimals);
}

/**
 * @title ChainlinkPriceSource
 * @notice An IPriceSource backed by live Chainlink aggregators on Hedera.
 *
 * WHY THIS EXISTS
 * ---------------
 * SottoNavOracle's primary path is an administrator-published NAV, because a
 * tokenised bond's NAV comes from a fund administrator and is not on a price
 * feed. But `setPriceSource(asset, source)` is a real seam: when a source is
 * configured, `referenceFor` prefers it, and SottoSettlement's band check then
 * prices that asset from the feed with NO change to the settlement contract.
 * This is the adapter that makes the seam load-bearing rather than decorative.
 *
 * THE UNIT PROBLEM, WHICH IS THE WHOLE JOB
 * ----------------------------------------
 * A Chainlink answer is "USD per unit of X" at the feed's own decimals (8 on
 * Hedera). Sotto quotes securities as a price PER 100 NOMINAL in the cash
 * token's decimals (6, for USDC). Those are different numbers in different
 * scales, and getting it wrong does not fail loudly - it silently widens or
 * narrows the band. So a feed is registered with an explicit conversion:
 *
 *     out = answer * 10^outDecimals / 10^feedDecimals * mulNum / mulDen
 *
 * `mulNum/mulDen` carries the convention change (e.g. x100 for per-100-nominal);
 * the decimal terms carry the scale change. Both are set once, on the record,
 * by an admin - not inferred.
 *
 * STALENESS IS PER FEED, NOT GLOBAL
 * ---------------------------------
 * Chainlink heartbeats differ per feed, and on Hedera TESTNET they differ a lot:
 * measured on 2026-09-06, HBAR/USD was 0.9h old while USDC/USD was 16.2h old.
 * A single global maxAge either rejects healthy feeds or accepts dead ones, so
 * each feed carries its own bound and a read past it reverts.
 *
 * WHAT THIS CONTRACT WILL NOT DO
 * ------------------------------
 * It will not invent a price. A zero or negative answer, a zero `updatedAt`, an
 * unregistered asset or a stale round all revert. A band check that cannot get a
 * price must refuse the trade, never wave it through.
 */
contract ChainlinkPriceSource is AccessControl, IPriceSource {
    struct Feed {
        IAggregatorV3 aggregator;
        uint8 outDecimals;   // decimals of the price this contract returns
        uint64 maxAge;       // per-feed staleness bound, seconds
        uint256 mulNum;      // convention numerator (e.g. 100 for per-100-nominal)
        uint256 mulDen;      // convention denominator
        bool exists;
    }

    mapping(address => Feed) public feeds;
    address[] private _assets;

    event FeedSet(
        address indexed asset,
        address indexed aggregator,
        uint8 outDecimals,
        uint64 maxAge,
        uint256 mulNum,
        uint256 mulDen
    );
    event FeedRemoved(address indexed asset);

    error NoFeed(address asset);
    error BadAnswer(address asset, int256 answer);
    error NoRound(address asset);
    error StaleRound(address asset, uint256 updatedAt, uint256 nowTs, uint64 maxAge);
    error BadConversion();

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------------ admin

    /**
     * @notice Register or replace the feed for an asset.
     * @param outDecimals decimals of the returned price (6 to match USDC)
     * @param maxAge      how old a round may be before reads revert
     * @param mulNum/mulDen convention conversion, e.g. 100/1 for per-100-nominal
     */
    function setFeed(
        address asset,
        IAggregatorV3 aggregator,
        uint8 outDecimals,
        uint64 maxAge,
        uint256 mulNum,
        uint256 mulDen
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (mulDen == 0 || mulNum == 0 || maxAge == 0) revert BadConversion();
        if (!feeds[asset].exists) _assets.push(asset);
        feeds[asset] = Feed({
            aggregator: aggregator,
            outDecimals: outDecimals,
            maxAge: maxAge,
            mulNum: mulNum,
            mulDen: mulDen,
            exists: true
        });
        emit FeedSet(asset, address(aggregator), outDecimals, maxAge, mulNum, mulDen);
    }

    function removeFeed(address asset) external onlyRole(DEFAULT_ADMIN_ROLE) {
        delete feeds[asset];
        emit FeedRemoved(asset);
    }

    // ------------------------------------------------------------------ reads

    function assetCount() external view returns (uint256) {
        return _assets.length;
    }

    function assetAt(uint256 i) external view returns (address) {
        return _assets[i];
    }

    /**
     * @inheritdoc IPriceSource
     * @dev Reverts rather than returning a sentinel. SottoNavOracle calls this
     *      from `referenceFor`, which SottoSettlement calls from `_authorize` -
     *      so a revert here refuses the settlement, which is the safe direction.
     */
    function latestPrice(address asset)
        external
        view
        override
        returns (uint256 price, uint64 updatedAt, uint8 decimals)
    {
        Feed memory f = feeds[asset];
        if (!f.exists) revert NoFeed(asset);

        (, int256 answer, , uint256 roundUpdatedAt, ) = f.aggregator.latestRoundData();
        if (answer <= 0) revert BadAnswer(asset, answer);
        if (roundUpdatedAt == 0) revert NoRound(asset);
        if (block.timestamp > roundUpdatedAt + f.maxAge) {
            revert StaleRound(asset, roundUpdatedAt, block.timestamp, f.maxAge);
        }

        uint8 feedDecimals = f.aggregator.decimals();
        uint256 raw = uint256(answer);

        // Rescale before applying the convention multiplier: scaling up first
        // keeps the integer division at the end, where it costs the least.
        if (f.outDecimals >= feedDecimals) {
            raw = raw * (10 ** uint256(f.outDecimals - feedDecimals));
        } else {
            raw = raw / (10 ** uint256(feedDecimals - f.outDecimals));
        }

        price = (raw * f.mulNum) / f.mulDen;
        updatedAt = uint64(roundUpdatedAt);
        decimals = f.outDecimals;
    }

    /// @notice The untouched feed answer, for showing the conversion's inputs.
    function rawAnswer(address asset)
        external
        view
        returns (int256 answer, uint256 updatedAt, uint8 feedDecimals, string memory description)
    {
        Feed memory f = feeds[asset];
        if (!f.exists) revert NoFeed(asset);
        (, answer, , updatedAt, ) = f.aggregator.latestRoundData();
        feedDecimals = f.aggregator.decimals();
        description = f.aggregator.description();
    }
}
