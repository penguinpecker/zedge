// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IConfiguredStreamsOracle} from "./INativeOracleMessenger.sol";

/// @notice Read surface of the Horizen price cache that the round registry binds to.
/// @dev getObservation does not revert for an absent entry: reportHash == 0 means nothing is cached.
interface IStreamsObservationCache is IConfiguredStreamsOracle {
    function observationWindow() external view returns (uint32);
    function destinationChainId() external view returns (uint256);
    function getObservation(bytes32 feedId, uint64 boundary) external view returns (Observation memory);
}
