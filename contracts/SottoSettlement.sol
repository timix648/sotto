// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { AccessControl } from "@openzeppelin/contracts/access/AccessControl.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { IHoldByPartition } from "./interfaces/IHoldByPartition.sol";

/**
 * @title SottoSettlement
 * @notice Atomic delivery-versus-payment for ATS-issued securities.
 *
 * The security leg is an ATS hold whose escrow agent is this contract; the cash
 * leg is an ordinary ERC-20 transfer (HTS tokens expose an ERC-20 facade at
 * their EVM address, per HIP-218/719). Both legs move in one transaction, or
 * neither does.
 *
 * There is deliberately NO admin function that can move user funds. The only
 * privileged role is RELAYER_ROLE, and it gates `deliver` alone - see the
 * tradeoff note below and in the README.
 */
contract SottoSettlement is EIP712, AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant RELAYER_ROLE = keccak256("RELAYER_ROLE");

    /// @dev MUST match packages/shared TRADE_TYPES exactly (wire contract s3.2).
    bytes32 private constant TRADE_TYPEHASH =
        keccak256(
            "Trade(bytes32 rfqId,address assetToken,bytes32 partition,uint256 holdId,address cashToken,address seller,address buyer,uint256 quantity,uint256 notional,uint256 deadline,uint256 nonce)"
        );

    struct Trade {
        bytes32 rfqId;
        address assetToken;
        bytes32 partition;
        uint256 holdId;
        address cashToken;
        address seller;
        address buyer;
        uint256 quantity;
        uint256 notional;
        uint256 deadline;
        uint256 nonce;
    }

    /// @notice Consumed nonces, shared by `settle` and `deliver` so one Trade
    ///         cannot be settled twice, once down each path.
    mapping(address => mapping(uint256 => bool)) public nonceUsed;
    mapping(address => uint256) private _nextNonce;

    event Settled(
        bytes32 indexed rfqId,
        address indexed seller,
        address indexed buyer,
        uint256 quantity,
        uint256 notional,
        address assetToken,
        address cashToken
    );
    event HoldReleased(address indexed assetToken, address indexed holder, uint256 holdId, uint256 amount);

    error DeadlineExpired(uint256 deadline, uint256 nowTs);
    error SignatureInvalid(address expected, address recovered);
    error NonceAlreadyUsed(address account, uint256 nonce);
    error WrongEscrow(address expected, address actual);
    error HoldTooSmall(uint256 held, uint256 required);
    error HoldExpired(uint256 expiration, uint256 nowTs);
    error DeliveryFailed();
    error ReleaseFailed();
    error ZeroQuantity();

    constructor(address admin) EIP712("Sotto", "1") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(RELAYER_ROLE, admin);
    }

    // ------------------------------------------------------------------ views

    function nonces(address account) external view returns (uint256) {
        return _nextNonce[account];
    }

    function hashTrade(Trade calldata t) public view returns (bytes32) {
        return
            _hashTypedDataV4(
                keccak256(
                    abi.encode(
                        TRADE_TYPEHASH,
                        t.rfqId,
                        t.assetToken,
                        t.partition,
                        t.holdId,
                        t.cashToken,
                        t.seller,
                        t.buyer,
                        t.quantity,
                        t.notional,
                        t.deadline,
                        t.nonce
                    )
                )
            );
    }

    // ------------------------------------------------------------ settlement

    /**
     * @notice Path A - permissionless, trustless. Verifies both signatures,
     *         pulls the cash, executes the hold. Atomic by EVM revert.
     * @dev Anyone may relay a fully-signed Trade. That is a feature: the
     *      trustless path is the open one.
     */
    function settle(
        Trade calldata t,
        bytes calldata sellerSig,
        bytes calldata buyerSig
    ) external nonReentrant returns (bool) {
        _authorize(t, sellerSig, buyerSig);
        _checkHold(t);

        // CASH LEG FIRST. Not for atomicity - a revert unwinds both legs
        // whatever the order - but because HIP-551 permits at most one contract
        // call per batch and it must be last, so Path B's cash leg has to
        // precede the contract call. Path A mirrors that ordering so both paths
        // reason identically.
        IERC20(t.cashToken).safeTransferFrom(t.buyer, t.seller, t.notional);

        _deliver(t);
        emit Settled(t.rfqId, t.seller, t.buyer, t.quantity, t.notional, t.assetToken, t.cashToken);
        return true;
    }

    /**
     * @notice Path B - delivery leg only, to be the LAST inner transaction of a
     *         HIP-551 atomic batch whose earlier inner transaction moves the cash.
     * @dev Gated to RELAYER_ROLE because this contract CANNOT introspect its
     *      batch siblings: from inside the EVM there is no way to verify that the
     *      cash transfer exists or succeeded. It relies entirely on batch
     *      atomicity. A malicious assembler holding a valid signed Trade could
     *      otherwise call this standalone and take delivery without paying.
     *      So: the elegant path is permissioned, the trustless path is open.
     *      This tradeoff is stated in the README under Known limitations.
     */
    function deliver(
        Trade calldata t,
        bytes calldata sellerSig,
        bytes calldata buyerSig
    ) external onlyRole(RELAYER_ROLE) nonReentrant returns (bool) {
        _authorize(t, sellerSig, buyerSig);
        _checkHold(t);
        _deliver(t);
        emit Settled(t.rfqId, t.seller, t.buyer, t.quantity, t.notional, t.assetToken, t.cashToken);
        return true;
    }

    /**
     * @notice Escrow-side release when an RFQ dies BEFORE the hold expires, so
     *         the seller does not sit through a 48-hour timeout.
     * @dev There is deliberately no reclaim function here. After expiry ANYONE
     *      may call ATS's own reclaimHoldByPartition directly - no venue code is
     *      needed, and that is a real property worth stating: if Sotto disappears
     *      entirely, a seller's tokens are still recoverable. The venue cannot
     *      trap collateral.
     */
    function releaseHold(
        address assetToken,
        bytes32 partition,
        address holder,
        uint256 holdId,
        uint256 amount
    ) external {
        bool ok = IHoldByPartition(assetToken).releaseHoldByPartition(
            IHoldByPartition.HoldIdentifier({ partition: partition, tokenHolder: holder, holdId: holdId }),
            amount
        );
        // Same rule as delivery: the ATS call returns a bool. Check it.
        if (!ok) revert ReleaseFailed();
        emit HoldReleased(assetToken, holder, holdId, amount);
    }

    // ------------------------------------------------------------- internals

    function _authorize(Trade calldata t, bytes calldata sellerSig, bytes calldata buyerSig) private {
        if (block.timestamp > t.deadline) revert DeadlineExpired(t.deadline, block.timestamp);
        if (t.quantity == 0) revert ZeroQuantity();

        bytes32 digest = hashTrade(t);

        address recoveredSeller = ECDSA.recover(digest, sellerSig);
        if (recoveredSeller != t.seller) revert SignatureInvalid(t.seller, recoveredSeller);

        address recoveredBuyer = ECDSA.recover(digest, buyerSig);
        if (recoveredBuyer != t.buyer) revert SignatureInvalid(t.buyer, recoveredBuyer);

        // Consume the nonce INSIDE the settling call, not merely check it -
        // otherwise a signature is replayable.
        if (nonceUsed[t.seller][t.nonce]) revert NonceAlreadyUsed(t.seller, t.nonce);
        if (nonceUsed[t.buyer][t.nonce]) revert NonceAlreadyUsed(t.buyer, t.nonce);
        nonceUsed[t.seller][t.nonce] = true;
        nonceUsed[t.buyer][t.nonce] = true;
        unchecked {
            ++_nextNonce[t.seller];
            ++_nextNonce[t.buyer];
        }
    }

    function _checkHold(Trade calldata t) private view {
        (uint256 amount, uint256 expiration, address escrow, , , , ) = IHoldByPartition(t.assetToken)
            .getHoldForByPartition(
                IHoldByPartition.HoldIdentifier({
                    partition: t.partition,
                    tokenHolder: t.seller,
                    holdId: t.holdId
                })
            );

        if (escrow != address(this)) revert WrongEscrow(address(this), escrow);
        if (amount < t.quantity) revert HoldTooSmall(amount, t.quantity);
        // 0 means "never expires" in ATS - treat that as valid, not as expired.
        if (expiration != 0 && expiration <= block.timestamp) revert HoldExpired(expiration, block.timestamp);
    }

    function _deliver(Trade calldata t) private {
        (bool ok, ) = IHoldByPartition(t.assetToken).executeHoldByPartition(
            IHoldByPartition.HoldIdentifier({
                partition: t.partition,
                tokenHolder: t.seller,
                holdId: t.holdId
            }),
            t.buyer,
            t.quantity
        );
        // LOAD-BEARING. executeHoldByPartition returns (bool success_, bytes32).
        // If ATS ever signals a compliance failure by returning false instead of
        // reverting, then without this require the cash has moved and the bond
        // has not - precisely the outcome this project exists to make impossible.
        // Do not remove it on the grounds that "it reverts anyway".
        if (!ok) revert DeliveryFailed();
    }
}
