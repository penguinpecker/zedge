// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IStreamsBoundaryOracle} from "./interfaces/IStreamsBoundaryOracle.sol";
import {
    INativeOracleMessenger,
    IStreamsObservationReceiver,
    IConfiguredStreamsOracle
} from "./interfaces/INativeOracleMessenger.sol";
import {StreamsOracleRoute} from "./libraries/StreamsOracleRoute.sol";

/// @notice Verifies a boundary on Base and publishes its exact observation through the native messenger.
/// @dev Permissionless callers supply reports/gas, never a signing authority. No assets are held.
contract BaseStreamsPublisher is ReentrancyGuard {
    error InvalidConfig();
    error WrongChain();
    error UnknownFeed();
    error ConflictingObservation();
    error MissingObservation();

    event BoundaryPublished(bytes32 indexed feedId, uint64 indexed boundary, bytes32 indexed reportHash);
    event BoundarySent(bytes32 indexed feedId, uint64 indexed boundary, bytes32 indexed reportHash);

    INativeOracleMessenger public immutable nativeMessenger;
    IConfiguredStreamsOracle public immutable sourceOracle;
    address public immutable destinationOracle;
    address public immutable destinationMessenger;
    uint256 public immutable sourceChainId;
    uint256 public immutable destinationChainId;
    bytes32 public immutable routeHash;
    bytes32 public immutable btcFeedId;
    bytes32 public immutable ethFeedId;
    uint8 public immutable btcDecimals;
    uint8 public immutable ethDecimals;
    uint32 public immutable observationWindow;
    uint32 public immutable minimumGasLimit;

    mapping(bytes32 feedId => mapping(uint64 boundary => IStreamsBoundaryOracle.Observation)) private
        _observations;

    constructor(StreamsOracleRoute.Config memory config) {
        routeHash = StreamsOracleRoute.hash(config);
        if (
            block.chainid != config.sourceChainId || address(this) != config.publisher
                || config.sourceMessenger.code.length == 0 || config.sourceOracle.code.length == 0
                || INativeOracleMessenger(config.sourceMessenger).otherMessenger()
                    != config.destinationMessenger
        ) revert InvalidConfig();
        IConfiguredStreamsOracle oracle = IConfiguredStreamsOracle(config.sourceOracle);
        if (
            oracle.btcFeedId() != config.btcFeedId || oracle.ethFeedId() != config.ethFeedId
                || oracle.btcDecimals() != config.btcDecimals || oracle.ethDecimals() != config.ethDecimals
        ) revert InvalidConfig();
        nativeMessenger = INativeOracleMessenger(config.sourceMessenger);
        sourceOracle = oracle;
        destinationOracle = config.destinationOracle;
        destinationMessenger = config.destinationMessenger;
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
        return "zedge-base-streams-publisher-v1";
    }

    function getObservation(bytes32 feedId, uint64 boundary)
        external
        view
        returns (IStreamsBoundaryOracle.Observation memory)
    {
        return _observations[feedId][boundary];
    }

    function publishBoundary(bytes32 feedId, uint64 boundary, bytes calldata evidence)
        external
        nonReentrant
        returns (IStreamsBoundaryOracle.Observation memory observation)
    {
        if (block.chainid != sourceChainId) revert WrongChain();
        uint8 decimals = _decimals(feedId);
        uint64 latest = boundary + observationWindow;
        observation = sourceOracle.verifyBoundary(feedId, boundary, latest, evidence);
        StreamsOracleRoute.validate(observation, boundary, latest, decimals, block.timestamp);
        // Only first verification checks wall-clock expiry. Resending a verified result need not renew it.
        if (block.timestamp > observation.expiresAt) revert StreamsOracleRoute.InvalidObservation();
        IStreamsBoundaryOracle.Observation storage existing = _observations[feedId][boundary];
        if (existing.reportHash == bytes32(0)) {
            _observations[feedId][boundary] = observation;
            emit BoundaryPublished(feedId, boundary, observation.reportHash);
        } else if (keccak256(abi.encode(existing)) != keccak256(abi.encode(observation))) {
            revert ConflictingObservation();
        }
        _send(feedId, boundary, observation);
    }

    /// @notice Re-publish an already authenticated result after delivery failure, even after report expiry.
    function resendBoundary(bytes32 feedId, uint64 boundary) external nonReentrant {
        if (block.chainid != sourceChainId) revert WrongChain();
        IStreamsBoundaryOracle.Observation memory observation = _observations[feedId][boundary];
        if (observation.reportHash == bytes32(0)) revert MissingObservation();
        _send(feedId, boundary, observation);
    }

    function _send(bytes32 feedId, uint64 boundary, IStreamsBoundaryOracle.Observation memory observation)
        private
    {
        nativeMessenger.sendMessage(
            destinationOracle,
            abi.encodeCall(
                IStreamsObservationReceiver.receiveObservation, (routeHash, feedId, boundary, observation)
            ),
            minimumGasLimit
        );
        emit BoundarySent(feedId, boundary, observation.reportHash);
    }

    function _decimals(bytes32 feedId) private view returns (uint8) {
        if (feedId == btcFeedId) return btcDecimals;
        if (feedId == ethFeedId) return ethDecimals;
        revert UnknownFeed();
    }
}
