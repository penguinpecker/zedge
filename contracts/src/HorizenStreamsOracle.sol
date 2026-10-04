// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IStreamsBoundaryOracle} from "./interfaces/IStreamsBoundaryOracle.sol";
import {INativeOracleMessenger, IStreamsObservationReceiver} from "./interfaces/INativeOracleMessenger.sol";
import {StreamsOracleRoute} from "./libraries/StreamsOracleRoute.sol";

/// @notice Immutable cache of Base-authenticated observations delivered by Horizen's native messenger.
/// @dev Does not verify DON signatures locally. Registry deadlines remain independent of delivery.
contract HorizenStreamsOracle is IStreamsBoundaryOracle, IStreamsObservationReceiver {
    error InvalidConfig();
    error UnauthorizedMessenger();
    error WrongRoute();
    error WrongChain();
    error UnknownFeed();
    error InvalidEvidence();
    error MissingObservation();
    error ConflictingObservation();

    event ObservationReceived(bytes32 indexed feedId, uint64 indexed boundary, bytes32 indexed reportHash);

    INativeOracleMessenger public immutable nativeMessenger;
    address public immutable publisher;
    address public immutable sourceMessenger;
    address public immutable sourceOracle;
    uint256 public immutable sourceChainId;
    uint256 public immutable destinationChainId;
    bytes32 public immutable routeHash;
    bytes32 public immutable btcFeedId;
    bytes32 public immutable ethFeedId;
    uint8 public immutable btcDecimals;
    uint8 public immutable ethDecimals;
    uint32 public immutable observationWindow;
    uint32 public immutable minimumGasLimit;

    mapping(bytes32 feedId => mapping(uint64 boundary => Observation)) private _observations;

    constructor(StreamsOracleRoute.Config memory config) {
        routeHash = StreamsOracleRoute.hash(config);
        if (
            block.chainid != config.destinationChainId || address(this) != config.destinationOracle
                || config.destinationMessenger.code.length == 0
                || INativeOracleMessenger(config.destinationMessenger).otherMessenger()
                    != config.sourceMessenger
        ) revert InvalidConfig();
        nativeMessenger = INativeOracleMessenger(config.destinationMessenger);
        publisher = config.publisher;
        sourceMessenger = config.sourceMessenger;
        sourceOracle = config.sourceOracle;
        sourceChainId = config.sourceChainId;
        destinationChainId = config.destinationChainId;
        btcFeedId = config.btcFeedId;
        ethFeedId = config.ethFeedId;
        btcDecimals = config.btcDecimals;
        ethDecimals = config.ethDecimals;
        observationWindow = config.observationWindow;
        minimumGasLimit = config.minimumGasLimit;
    }

    function version() external pure returns (string memory) {
        return "zedge-horizen-streams-oracle-v1";
    }

    function getObservation(bytes32 feedId, uint64 boundary) external view returns (Observation memory) {
        return _observations[feedId][boundary];
    }

    function receiveObservation(
        bytes32 claimedRouteHash,
        bytes32 feedId,
        uint64 boundary,
        Observation calldata observation
    ) external {
        if (block.chainid != destinationChainId) revert WrongChain();
        if (msg.sender != address(nativeMessenger) || nativeMessenger.xDomainMessageSender() != publisher) {
            revert UnauthorizedMessenger();
        }
        if (claimedRouteHash != routeHash) revert WrongRoute();
        StreamsOracleRoute.validate(
            observation, boundary, boundary + observationWindow, _decimals(feedId), block.timestamp
        );
        Observation storage existing = _observations[feedId][boundary];
        if (existing.reportHash != bytes32(0)) {
            if (keccak256(abi.encode(existing)) != keccak256(abi.encode(observation))) {
                revert ConflictingObservation();
            }
            return;
        }
        _observations[feedId][boundary] = observation;
        emit ObservationReceived(feedId, boundary, observation.reportHash);
    }

    function verifyBoundary(bytes32 feedId, uint64 boundary, uint64 maxPublishTime, bytes calldata evidence)
        external
        view
        returns (Observation memory observation)
    {
        if (block.chainid != destinationChainId) revert WrongChain();
        if (evidence.length != 0) revert InvalidEvidence();
        uint8 decimals = _decimals(feedId);
        if (maxPublishTime < boundary || maxPublishTime > boundary + observationWindow) {
            revert StreamsOracleRoute.InvalidObservation();
        }
        observation = _observations[feedId][boundary];
        if (observation.reportHash == bytes32(0)) revert MissingObservation();
        StreamsOracleRoute.validate(observation, boundary, maxPublishTime, decimals, block.timestamp);
    }

    function _decimals(bytes32 feedId) private view returns (uint8) {
        if (feedId == btcFeedId) return btcDecimals;
        if (feedId == ethFeedId) return ethDecimals;
        revert UnknownFeed();
    }
}
