// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @notice A market data source that can price an asset. Implement this to plug
 *         Chainlink, Pyth or Supra in for assets that have a public market
 *         price; all three are live on Hedera.
 * @dev Deliberately minimal so an adapter is a few lines.
 */
interface IPriceSource {
    /// @return price scaled to `decimals`, and the timestamp it was observed.
    function latestPrice(address asset) external view returns (uint256 price, uint64 updatedAt, uint8 decimals);
}

/**
 * @title SottoNavOracle
 * @notice Reference NAV for tokenised securities, and the band check that stops
 *         an auction settling at a manipulated price.
 *
 * WHY THIS IS NOT A CHAINLINK FEED
 * --------------------------------
 * A tokenised bond's NAV is not on a crypto price feed and never will be. It
 * comes from the issuer or a fund administrator, the same place it comes from
 * in traditional markets. So the primary source here is a signed publication by
 * an accountable NAV_PUBLISHER, with an explicit staleness bound - not an
 * invented on-chain price.
 *
 * For assets that DO have a public market price, set an `IPriceSource` adapter
 * and the contract prefers it. That is the seam where Chainlink/Pyth/Supra plug
 * in without changing anything else.
 *
 * WHAT THE BAND IS FOR
 * --------------------
 * A commit-reveal auction is resistant to front-running but not to a seller
 * awarding themselves a deliberately bad price through a colluding dealer. The
 * band makes that non-executable: a trade more than `bandBps` away from the
 * reference NAV cannot settle. It is a circuit breaker, not a pricing engine.
 *
 * Note Hedera's Exchange Rate system contract at 0x168 is NOT used here. Its own
 * documentation says it "should not be treated as a live price oracle" - it is
 * the HBAR/USD rate the network uses to charge fees. Using it to price a bond
 * would be dishonest.
 */
contract SottoNavOracle is AccessControl {
    bytes32 public constant NAV_PUBLISHER_ROLE = keccak256("NAV_PUBLISHER_ROLE");

    struct Nav {
        uint256 price;     // reference price per 100 nominal, scaled to `decimals`
        uint64 updatedAt;  // unix seconds
        uint8 decimals;
        bool exists;
    }

    mapping(address => Nav) private _nav;
    mapping(address => IPriceSource) public priceSource;

    /// @notice How old a NAV may be before it is refused. Default 24h.
    uint64 public maxAge = 24 hours;

    event NavPublished(address indexed asset, uint256 price, uint8 decimals, uint64 updatedAt);
    event PriceSourceSet(address indexed asset, address indexed source);
    event MaxAgeSet(uint64 maxAge);

    error NoReference(address asset);
    error StaleReference(address asset, uint64 updatedAt, uint64 nowTs, uint64 maxAge);
    error OutsideBand(address asset, uint256 price, uint256 referencePrice, uint16 bandBps);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(NAV_PUBLISHER_ROLE, admin);
    }

    // ------------------------------------------------------------ admin

    function setMaxAge(uint64 newMaxAge) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxAge = newMaxAge;
        emit MaxAgeSet(newMaxAge);
    }

    /// @notice Plug in a market feed for assets that have a public price.
    function setPriceSource(address asset, IPriceSource source) external onlyRole(DEFAULT_ADMIN_ROLE) {
        priceSource[asset] = source;
        emit PriceSourceSet(asset, address(source));
    }

    /// @notice Publish an administrator NAV. This is the normal path for a bond.
    function publishNav(address asset, uint256 price, uint8 decimals) external onlyRole(NAV_PUBLISHER_ROLE) {
        _nav[asset] = Nav({ price: price, updatedAt: uint64(block.timestamp), decimals: decimals, exists: true });
        emit NavPublished(asset, price, decimals, uint64(block.timestamp));
    }

    // ------------------------------------------------------------ reads

    /**
     * @notice The reference for an asset. A configured market source wins;
     *         otherwise the published administrator NAV.
     */
    function referenceFor(address asset) public view returns (uint256 price, uint64 updatedAt, uint8 decimals) {
        IPriceSource src = priceSource[asset];
        if (address(src) != address(0)) {
            return src.latestPrice(asset);
        }
        Nav memory n = _nav[asset];
        if (!n.exists) revert NoReference(asset);
        return (n.price, n.updatedAt, n.decimals);
    }

    function hasReference(address asset) external view returns (bool) {
        return _nav[asset].exists || address(priceSource[asset]) != address(0);
    }

    function isFresh(address asset) public view returns (bool) {
        (, uint64 updatedAt, ) = referenceFor(asset);
        return block.timestamp <= uint256(updatedAt) + maxAge;
    }

    /// @notice Is `price` within `bandBps` of the reference? 10000 bps = 100%.
    function withinBand(address asset, uint256 price, uint16 bandBps) public view returns (bool) {
        (uint256 ref, , ) = referenceFor(asset);
        if (ref == 0) return false;
        uint256 diff = price > ref ? price - ref : ref - price;
        // diff/ref <= bandBps/10000, without dividing (no precision loss).
        return diff * 10_000 <= ref * bandBps;
    }

    /**
     * @notice Reverts unless the price is fresh and inside the band.
     * @dev This is what a settlement contract calls. It reverts rather than
     *      returning false so a caller cannot forget to check the result -
     *      the same reasoning as require(success_) on the delivery leg.
     */
    function requireWithinBand(address asset, uint256 price, uint16 bandBps) external view {
        (uint256 ref, uint64 updatedAt, ) = referenceFor(asset);
        if (block.timestamp > uint256(updatedAt) + maxAge) {
            revert StaleReference(asset, updatedAt, uint64(block.timestamp), maxAge);
        }
        if (!withinBand(asset, price, bandBps)) {
            revert OutsideBand(asset, price, ref, bandBps);
        }
    }
}
