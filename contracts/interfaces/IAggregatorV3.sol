// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * @notice Chainlink's AggregatorV3Interface, reproduced rather than imported so
 *         the repo does not take an npm dependency on the Chainlink package for
 *         function signatures.
 *
 * Live on Hedera testnet (chainId 296) - these are the aggregators Hedera's own
 * example repository uses, and all seven answer today:
 *
 *   BTC/USD   0x058fE79CB5775d4b167920Ca6036B824805A9ABd
 *   DAI/USD   0xdA2aBF7C90aDC73CDF5cA8d720B87bD5F5863389
 *   ETH/USD   0xb9d461e0b962aF219866aDfA7DD19C52bB9871b9
 *   HBAR/USD  0x59bC155EB6c6C415fE43255aF66EcF0523c92B4a
 *   LINK/USD  0xF111b70231E89D69eBC9f6C9208e9890383Ef432
 *   USDC/USD  0xb632a7e7e02d76c0Ce99d9C62c7a2d1B5F92B6B5
 *   USDT/USD  0x06823de8E77d708C4cB72Cbf04495D67afF4Bd37
 */
interface IAggregatorV3 {
    function decimals() external view returns (uint8);

    function description() external view returns (string memory);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
