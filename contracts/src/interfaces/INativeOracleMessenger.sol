// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IStreamsBoundaryOracle} from "./IStreamsBoundaryOracle.sol";

/// @notice The existing OP Stack parent/child messenger ABI. No custom signing authority is introduced.
interface INativeOracleMessenger {
    function otherMessenger() external view returns (address);
    function xDomainMessageSender() external view returns (address);
    function sendMessage(address target, bytes calldata message, uint32 minGasLimit) external payable;
}

interface IStreamsObservationReceiver {
    function receiveObservation(
        bytes32 routeHash,
        bytes32 feedId,
        uint64 boundary,
        IStreamsBoundaryOracle.Observation calldata observation
    ) external;
}

interface IConfiguredStreamsOracle is IStreamsBoundaryOracle {
    function btcFeedId() external view returns (bytes32);
    function ethFeedId() external view returns (bytes32);
    function btcDecimals() external view returns (uint8);
    function ethDecimals() external view returns (uint8);
}
