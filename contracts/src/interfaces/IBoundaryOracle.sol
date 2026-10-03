// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Boundary verification, not a latest-price or trusted-reporter interface.
/// @dev Implementations MUST prove the first feed update at/after boundary, within maxPublishTime.
/// A signed price picked by a caller without a predecessor/uniqueness proof does not satisfy this ABI.
interface IBoundaryOracle {
    struct Observation {
        int64 price;
        uint64 confidence;
        int32 exponent;
        uint64 publishTime;
    }

    function version() external pure returns (string memory);
    function quoteFee(bytes calldata evidence) external view returns (uint256);
    function verifyBoundary(bytes32 feedId, uint64 boundary, uint64 maxPublishTime, bytes calldata evidence)
        external
        payable
        returns (Observation memory);
}
