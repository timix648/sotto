// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { IHederaScheduleService } from "./interfaces/IHederaScheduleService.sol";

/**
 * @title SottoCouponScheduler
 * @notice On-chain lifecycle automation for tokenised bonds, using HIP-1215
 *         generalised scheduled contract calls.
 *
 * A bond's coupon dates and maturity are known at issuance. Rather than relying
 * on a backend cron - an off-chain dependency the whole point of the instrument
 * is to avoid - the contract schedules its own future calls through the Hedera
 * Schedule Service system contract at 0x16b. If this venue disappears, the
 * coupons still fire.
 *
 * Capacity is the real design constraint. A given second has a finite gas budget
 * for scheduled calls, so we probe forward with hasScheduleCapacity() until we
 * find a free slot. The walk is bounded: an unbounded search would be a gas
 * bomb on a busy network.
 */
contract SottoCouponScheduler is AccessControl {
    /// Hedera Schedule Service system contract (HIP-755/756/1215).
    IHederaScheduleService constant HSS = IHederaScheduleService(address(0x16b));

    /// Hedera response code for SUCCESS.
    int64 constant SUCCESS = 22;

    bytes32 public constant SCHEDULER_ROLE = keccak256("SCHEDULER_ROLE");

    /// How many seconds forward we are willing to probe for a free slot.
    uint256 public constant MAX_SLOT_PROBES = 60;

    struct Scheduled {
        address assetToken;
        uint256 requestedAt;   // the date the issuer asked for
        uint256 scheduledFor;  // the second we actually secured
        address scheduleAddress;
        bool isMaturity;
    }

    Scheduled[] public schedules;

    event CouponScheduled(
        address indexed assetToken,
        uint256 requestedDate,
        uint256 scheduledFor,
        address scheduleAddress
    );
    event MaturityScheduled(
        address indexed assetToken,
        uint256 requestedDate,
        uint256 scheduledFor,
        address scheduleAddress
    );
    event ScheduleDeleted(address indexed scheduleAddress, int64 responseCode);

    error NoCapacityWithinWindow(uint256 from, uint256 probes);
    error ScheduleFailed(int64 responseCode);
    error DateInPast(uint256 requested, uint256 nowTs);

    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(SCHEDULER_ROLE, admin);
    }

    function scheduleCount() external view returns (uint256) {
        return schedules.length;
    }

    /**
     * @notice Find the first second at or after `from` with capacity for a call
     *         of `gasLimit`. Bounded to MAX_SLOT_PROBES.
     * @dev Exposed as a view so the backend can pre-check without spending gas,
     *      which is what HIP-1215's own guidance recommends.
     */
    function findAvailableSecond(uint256 from, uint256 gasLimit) public view returns (uint256 second, bool found) {
        for (uint256 i = 0; i < MAX_SLOT_PROBES; ++i) {
            uint256 candidate = from + i;
            if (HSS.hasScheduleCapacity(candidate, gasLimit)) return (candidate, true);
        }
        return (0, false);
    }

    /**
     * @notice Schedule a coupon distribution call on `assetToken`.
     * @param assetToken the bond
     * @param couponDate the intended coupon date, as a unix second
     * @param gasLimit   gas for the scheduled call
     * @param callData   ABI-encoded call to execute against the bond
     */
    function scheduleCoupon(
        address assetToken,
        uint256 couponDate,
        uint256 gasLimit,
        bytes calldata callData
    ) external onlyRole(SCHEDULER_ROLE) returns (address scheduleAddress) {
        return _schedule(assetToken, couponDate, gasLimit, callData, false);
    }

    /// @notice Same mechanism, for redemption at maturity.
    function scheduleMaturity(
        address assetToken,
        uint256 maturityDate,
        uint256 gasLimit,
        bytes calldata callData
    ) external onlyRole(SCHEDULER_ROLE) returns (address scheduleAddress) {
        return _schedule(assetToken, maturityDate, gasLimit, callData, true);
    }

    function deleteSchedule(address scheduleAddress) external onlyRole(SCHEDULER_ROLE) returns (int64) {
        int64 rc = HSS.deleteSchedule(scheduleAddress);
        emit ScheduleDeleted(scheduleAddress, rc);
        return rc;
    }

    function _schedule(
        address assetToken,
        uint256 date,
        uint256 gasLimit,
        bytes calldata callData,
        bool isMaturity
    ) private returns (address scheduleAddress) {
        if (date <= block.timestamp) revert DateInPast(date, block.timestamp);

        (uint256 slot, bool found) = findAvailableSecond(date, gasLimit);
        if (!found) revert NoCapacityWithinWindow(date, MAX_SLOT_PROBES);

        // scheduleCall does not revert on failure - it returns a code and the
        // zero address. Check both, or a "scheduled" coupon silently does not
        // exist. Same rule as executeHoldByPartition in SottoSettlement.
        int64 rc;
        (rc, scheduleAddress) = HSS.scheduleCall(assetToken, slot, gasLimit, 0, callData);
        if (rc != SUCCESS || scheduleAddress == address(0)) revert ScheduleFailed(rc);

        schedules.push(Scheduled({
            assetToken: assetToken,
            requestedAt: date,
            scheduledFor: slot,
            scheduleAddress: scheduleAddress,
            isMaturity: isMaturity
        }));

        if (isMaturity) emit MaturityScheduled(assetToken, date, slot, scheduleAddress);
        else emit CouponScheduled(assetToken, date, slot, scheduleAddress);
    }
}
