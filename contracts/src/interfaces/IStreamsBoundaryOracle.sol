// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice A verified Chainlink Data Streams report whose signed validity window contains a boundary.
/// @dev This is a separate policy from Pyth confidence intervals. Prices retain the feed's exact precision.
interface IStreamsBoundaryOracle {
    struct Observation {
        int192 price;
        uint32 validFromTimestamp;
        uint32 observationsTimestamp;
        uint32 expiresAt;
        bytes32 reportHash;
        uint8 decimals;
    }

    function version() external pure returns (string memory);

    function verifyBoundary(bytes32 feedId, uint64 boundary, uint64 maxPublishTime, bytes calldata evidence)
        external
        returns (Observation memory);
}
