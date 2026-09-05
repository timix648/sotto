// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IHoldByPartition } from "../interfaces/IHoldByPartition.sol";

/**
 * @notice Minimal stand-in for the ATS hold facet, for unit tests only.
 *
 * It exists to let us test the cases the real chain makes expensive or slow to
 * reproduce - a revoked-KYC delivery, an expired hold, a hold that returns
 * `false` instead of reverting.
 *
 * That last one is the important one. MECHANICS.md 4.1: the original Umbra
 * allocation credited the receiver the full amount WITHOUT comparing it to the
 * sender's balance, so underfunded trades settled and created value from
 * nothing. The dangerous case is not a transfer that fails - it is one that
 * SUCCEEDS when it should not. `failSilently` reproduces exactly that shape so
 * we can prove SottoSettlement refuses it.
 */
contract MockAtsBond is IHoldByPartition {
    struct Hold {
        uint256 amount;
        uint256 expirationTimestamp;
        address escrow;
        address to;
        bool exists;
    }

    mapping(bytes32 => Hold) public holds;
    mapping(address => uint256) public balanceOf;
    mapping(address => bool) public kycRevoked;

    /// @dev When true, executeHoldByPartition returns (false, ...) instead of
    ///      reverting - the "succeeds but did nothing" shape.
    bool public failSilently;

    function setFailSilently(bool v) external { failSilently = v; }
    function setKycRevoked(address who, bool v) external { kycRevoked[who] = v; }

    function _key(bytes32 partition, address holder, uint256 holdId) private pure returns (bytes32) {
        return keccak256(abi.encode(partition, holder, holdId));
    }

    function createHold(
        bytes32 partition,
        address holder,
        uint256 holdId,
        uint256 amount,
        uint256 expiration,
        address escrow
    ) external {
        holds[_key(partition, holder, holdId)] = Hold(amount, expiration, escrow, address(0), true);
    }

    function getHoldForByPartition(
        HoldIdentifier calldata id
    )
        external
        view
        returns (uint256, uint256, address, address, bytes memory, bytes memory, uint8)
    {
        Hold memory h = holds[_key(id.partition, id.tokenHolder, id.holdId)];
        return (h.amount, h.expirationTimestamp, h.escrow, h.to, "", "", 0);
    }

    function executeHoldByPartition(
        HoldIdentifier calldata id,
        address to,
        uint256 amount
    ) external returns (bool, bytes32) {
        Hold storage h = holds[_key(id.partition, id.tokenHolder, id.holdId)];
        require(h.exists, "no hold");
        require(msg.sender == h.escrow, "not escrow");

        // A revoked-KYC recipient is refused. Depending on `failSilently` this
        // either reverts (ATS's normal behaviour) or returns false - both of
        // which SottoSettlement must treat as a failure.
        if (kycRevoked[to] || failSilently) {
            if (failSilently) return (false, id.partition);
            revert("KYC_REJECTED");
        }

        require(h.amount >= amount, "hold too small");
        h.amount -= amount;
        balanceOf[to] += amount;
        return (true, id.partition);
    }

    function releaseHoldByPartition(HoldIdentifier calldata id, uint256 amount) external returns (bool) {
        Hold storage h = holds[_key(id.partition, id.tokenHolder, id.holdId)];
        require(h.exists, "no hold");
        require(msg.sender == h.escrow, "not escrow");
        if (failSilently) return false;
        h.amount -= amount;
        balanceOf[id.tokenHolder] += amount;
        return true;
    }
}
