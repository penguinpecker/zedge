// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {StreamsRoundRegistry} from "../../src/StreamsRoundRegistry.sol";
import {IStreamsObservationCache} from "../../src/interfaces/IStreamsObservationCache.sol";

/// @dev UNSIGNED fixture. Never used by a deployment or as signature-verification evidence.
/// verifyBoundary returns whatever the caller encodes; getObservation returns only what setCached stored.
contract MockStreamsBoundaryOracle is IStreamsObservationCache {
    bytes32 public btcFeedId = bytes32((uint256(3) << 240) | 1);
    bytes32 public ethFeedId = bytes32((uint256(3) << 240) | 2);
    uint8 public btcDecimals = 18;
    uint8 public ethDecimals = 18;
    uint32 public observationWindow = 10;
    uint256 public destinationChainId = block.chainid;
    bool public failure;
    address public reentryTarget;
    bytes public reentryData;
    bool public reentrySucceeded;
    bytes32 public lastFeed;
    uint64 public lastBoundary;
    uint64 public lastMaximum;
    mapping(bytes32 feed => mapping(uint64 boundary => Observation)) private _cached;

    function version() external pure returns (string memory) {
        return "insecure-streams-test-fixture";
    }

    function configure(bytes32 btc, bytes32 eth, uint8 btcScale, uint8 ethScale, uint32 window, uint256 chain)
        external
    {
        (btcFeedId, ethFeedId, btcDecimals, ethDecimals) = (btc, eth, btcScale, ethScale);
        (observationWindow, destinationChainId) = (window, chain);
    }

    function setFailure(bool value) external {
        failure = value;
    }

    function setReentry(address target, bytes calldata data) external {
        reentryTarget = target;
        reentryData = data;
    }

    function setCached(bytes32 feed, uint64 boundary, Observation calldata observation) external {
        _cached[feed][boundary] = observation;
    }

    function getObservation(bytes32 feed, uint64 boundary) external view returns (Observation memory) {
        return _cached[feed][boundary];
    }

    function verifyBoundary(bytes32 feed, uint64 boundary, uint64 maximum, bytes calldata evidence)
        external
        returns (Observation memory)
    {
        require(!failure, "test oracle unavailable");
        lastFeed = feed;
        lastBoundary = boundary;
        lastMaximum = maximum;
        if (reentryTarget != address(0)) {
            (reentrySucceeded,) = reentryTarget.call(reentryData);
        }
        return abi.decode(evidence, (Observation));
    }
}

/// @dev Test deployment of the registry exactly as planned for mainnet: implementation + ERC1967Proxy.
library StreamsRegistryProxy {
    function deploy(StreamsRoundRegistry.Config memory config, address owner)
        internal
        returns (StreamsRoundRegistry)
    {
        bytes memory setup = abi.encodeCall(StreamsRoundRegistry.initialize, (config, owner));
        return StreamsRoundRegistry(address(new ERC1967Proxy(address(new StreamsRoundRegistry()), setup)));
    }
}
