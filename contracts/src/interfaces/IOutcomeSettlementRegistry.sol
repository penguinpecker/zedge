// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Read-only surface of the upgradeable Streams round registry used by collateral claims.
interface IOutcomeSettlementRegistry {
    function version() external view returns (string memory);
    function collateral() external view returns (address);
    function deploymentChainId() external view returns (uint256);
    function rulesHash() external view returns (bytes32);
    function canTrade(bytes32 roundId) external view returns (bool);
    function payoutNumerators(bytes32 roundId) external view returns (uint8 up, uint8 down, uint8 denominator);
}
