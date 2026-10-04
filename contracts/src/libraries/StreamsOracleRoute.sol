// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IStreamsBoundaryOracle} from "../interfaces/IStreamsBoundaryOracle.sol";

/// @dev Shared route encoding binds every immutable security-relevant endpoint and price rule.
library StreamsOracleRoute {
    struct Config {
        uint256 sourceChainId;
        uint256 destinationChainId;
        address sourceMessenger;
        address destinationMessenger;
        address sourceOracle;
        address publisher;
        address destinationOracle;
        bytes32 btcFeedId;
        bytes32 ethFeedId;
        uint8 btcDecimals;
        uint8 ethDecimals;
        uint32 observationWindow;
        uint32 minimumGasLimit;
    }

    error InvalidRoute();
    error InvalidObservation();

    function hash(Config memory config) internal pure returns (bytes32) {
        if (
            config.sourceChainId == 0 || config.destinationChainId == 0
                || config.sourceChainId == config.destinationChainId || config.sourceMessenger == address(0)
                || config.destinationMessenger == address(0) || config.sourceOracle == address(0)
                || config.publisher == address(0) || config.destinationOracle == address(0)
                || bytes2(config.btcFeedId) != bytes2(uint16(3))
                || bytes2(config.ethFeedId) != bytes2(uint16(3)) || config.btcFeedId == config.ethFeedId
                || config.btcDecimals > 18 || config.ethDecimals > 18 || config.observationWindow > 60
                || config.minimumGasLimit < 200_000 || config.minimumGasLimit > 2_000_000
        ) revert InvalidRoute();
        return keccak256(abi.encode("zedge-native-streams-route-v1", config));
    }

    function validate(
        IStreamsBoundaryOracle.Observation memory observation,
        uint64 boundary,
        uint64 maxPublishTime,
        uint8 decimals,
        uint256 nowTimestamp
    ) internal pure {
        if (
            boundary == 0 || boundary > maxPublishTime || boundary > nowTimestamp || observation.price <= 0
                || observation.validFromTimestamp == 0 || observation.validFromTimestamp > boundary
                || observation.observationsTimestamp < boundary
                || observation.observationsTimestamp > maxPublishTime
                || observation.observationsTimestamp > nowTimestamp
                || observation.expiresAt < observation.observationsTimestamp
                || observation.reportHash == bytes32(0) || observation.decimals != decimals
        ) revert InvalidObservation();
    }
}
