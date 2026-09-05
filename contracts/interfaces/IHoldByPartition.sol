// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @notice The subset of the ATS hold facet that Sotto settles against.
 * @dev Signatures verified against reference/ats/.../facets/holdByPartition/
 *      IHoldByPartition.sol. Do NOT recall these from memory - the ATS contract
 *      API is absent from Hedera's published docs, so an invented signature will
 *      look plausible and fail at dispatch with no useful error.
 */
interface IHoldByPartition {
    struct HoldIdentifier {
        bytes32 partition;
        address tokenHolder;
        uint256 holdId;
    }

    /// @dev Returns (success_, partition_). BOTH must be checked - see SottoSettlement.
    function executeHoldByPartition(
        HoldIdentifier calldata _holdIdentifier,
        address _to,
        uint256 _amount
    ) external returns (bool success_, bytes32 partition_);

    /// @dev Escrow-only, before expiry. Returns success_.
    function releaseHoldByPartition(
        HoldIdentifier calldata _holdIdentifier,
        uint256 _amount
    ) external returns (bool success_);

    function getHoldForByPartition(
        HoldIdentifier calldata _holdIdentifier
    )
        external
        view
        returns (
            uint256 amount_,
            uint256 expirationTimestamp_,
            address escrow_,
            address destination_,
            bytes memory data_,
            bytes memory operatorData_,
            uint8 thirdPartyType_
        );
}
