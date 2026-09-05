// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @notice Hedera Schedule Service (HSS) system contract, HIP-1215.
 * @dev Signatures verified against Hedera's own docs via the hedera-docs MCP,
 *      not recalled from memory. Selectors are as published:
 *        scheduleCall          0x6f5bfde8   (consensus node 0.68+)
 *        hasScheduleCapacity   0xdfb4a999
 *        deleteSchedule        0x72d42394
 *
 *      scheduleCall does NOT revert. On success it returns response code 22
 *      (SUCCESS) and the new schedule address; on failure it returns a failure
 *      code from ResponseCodeEnum and the ZERO address. Check the return value -
 *      a try/catch will not save you here.
 */
interface IHederaScheduleService {
    /// @notice Schedule a call with the calling contract as payer.
    function scheduleCall(
        address to,
        uint256 expirySecond,
        uint256 gasLimit,
        uint64 value,
        bytes memory callData
    ) external returns (int64 responseCode, address scheduleAddress);

    /// @notice Is there capacity to schedule a call at this second with this gas?
    function hasScheduleCapacity(uint256 expirySecond, uint256 gasLimit) external view returns (bool);

    /// @notice Delete a previously created schedule.
    function deleteSchedule(address scheduleAddress) external returns (int64 responseCode);
}
