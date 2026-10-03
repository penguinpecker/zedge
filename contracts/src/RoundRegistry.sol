// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IBoundaryOracle} from "./interfaces/IBoundaryOracle.sol";

/// @notice Immutable, noncustodial public rules and resolution registry for ZEDGE binary rounds.
/// @dev No owner, proxy, arbitrary outcome setter, token transfer or TEE-signature authority.
/// This registry does not make a private order timely: canTrade is a current-chain observation only.
contract RoundRegistry is ReentrancyGuard {
    enum Asset {
        BTC,
        ETH
    }
    enum Outcome {
        Pending,
        Up,
        Down,
        Void
    }
    enum Phase {
        Missing,
        Scheduled,
        OpeningPending,
        Trading,
        Closed,
        ResolutionPending,
        Resolved,
        Voided,
        Voidable
    }

    struct Config {
        address oracle;
        address collateral;
        bytes32 btcFeedId;
        bytes32 ethFeedId;
        int32 btcExponent;
        int32 ethExponent;
        uint32 observationWindow;
        uint32 openingGrace;
        uint32 settlementGrace;
        uint32 cutoffBuffer;
        uint16 maxConfidenceBps;
    }

    struct Round {
        Asset asset;
        uint32 duration;
        uint64 start;
        uint64 end;
        uint64 cutoff;
        uint64 openingDeadline;
        uint64 resolutionDeadline;
        uint64 openedAt;
        uint64 resolvedAt;
        Outcome outcome;
        IBoundaryOracle.Observation opening;
        IBoundaryOracle.Observation closing;
    }

    error InvalidConfig();
    error InvalidSchedule();
    error RoundExists(bytes32 roundId);
    error UnknownRound(bytes32 roundId);
    error AlreadyFinalized();
    error OpeningAlreadyRecorded();
    error OpeningMissing();
    error OutsideOpeningWindow();
    error OutsideResolutionWindow();
    error TimeoutNotReached();
    error InvalidObservation();
    error IncorrectFee(uint256 expected, uint256 received);
    error TimestampOverflow();

    event RoundCreated(
        bytes32 indexed roundId, Asset indexed asset, uint32 duration, uint64 start, uint64 end
    );
    event OpeningRecorded(
        bytes32 indexed roundId, int64 price, uint64 confidence, int32 exponent, uint64 publishTime
    );
    event RoundResolved(bytes32 indexed roundId, Outcome outcome, int64 closingPrice, uint64 publishTime);
    event RoundVoided(bytes32 indexed roundId, bool openingMissing);

    uint8 public constant PAYOUT_DENOMINATOR = 2;
    IBoundaryOracle public immutable oracle;
    address public immutable collateral;
    bytes32 public immutable btcFeedId;
    bytes32 public immutable ethFeedId;
    int32 public immutable btcExponent;
    int32 public immutable ethExponent;
    uint32 public immutable observationWindow;
    uint32 public immutable openingGrace;
    uint32 public immutable settlementGrace;
    uint32 public immutable cutoffBuffer;
    uint16 public immutable maxConfidenceBps;
    uint256 public immutable deploymentChainId;
    bytes32 public immutable rulesHash;
    mapping(bytes32 => Round) private _rounds;

    constructor(Config memory config) {
        if (
            config.oracle.code.length == 0 || config.collateral.code.length == 0
                || config.btcFeedId == bytes32(0) || config.ethFeedId == bytes32(0)
                || config.btcFeedId == config.ethFeedId || config.btcExponent > 0 || config.btcExponent < -18
                || config.ethExponent > 0 || config.ethExponent < -18 || config.cutoffBuffer == 0
                || config.cutoffBuffer >= 300 || config.openingGrace == 0 || config.settlementGrace == 0
                || config.observationWindow > 60
                || uint256(config.observationWindow) + config.settlementGrace > 86_400
                || uint256(config.observationWindow) + config.openingGrace >= 300 - config.cutoffBuffer
                || config.maxConfidenceBps == 0 || config.maxConfidenceBps > 10_000
        ) revert InvalidConfig();
        oracle = IBoundaryOracle(config.oracle);
        collateral = config.collateral;
        btcFeedId = config.btcFeedId;
        ethFeedId = config.ethFeedId;
        btcExponent = config.btcExponent;
        ethExponent = config.ethExponent;
        observationWindow = config.observationWindow;
        openingGrace = config.openingGrace;
        settlementGrace = config.settlementGrace;
        cutoffBuffer = config.cutoffBuffer;
        maxConfidenceBps = config.maxConfidenceBps;
        deploymentChainId = block.chainid;
        // Includes fixed tie and void policies via the explicit version string.
        rulesHash = keccak256(abi.encode("zedge-round-registry-v1:tie-up:void-half", block.chainid, config));
    }

    function version() external pure returns (string memory) {
        return "zedge-round-registry-v1";
    }

    function roundIdFor(Asset asset, uint32 duration, uint64 start) public view returns (bytes32) {
        return keccak256(abi.encode(deploymentChainId, address(this), rulesHash, asset, duration, start));
    }

    /// @notice Anybody may pre-schedule a canonical round. No creator controls the rules or outcome.
    function createRound(Asset asset, uint32 duration, uint64 start) external returns (bytes32 roundId) {
        if ((duration != 300 && duration != 900) || start <= block.timestamp || start % duration != 0) {
            revert InvalidSchedule();
        }
        uint64 end = _timestamp(uint256(start) + duration);
        uint64 deadline = _timestamp(uint256(end) + observationWindow + settlementGrace);
        roundId = roundIdFor(asset, duration, start);
        if (_rounds[roundId].start != 0) revert RoundExists(roundId);
        Round storage round = _rounds[roundId];
        round.asset = asset;
        round.duration = duration;
        round.start = start;
        round.end = end;
        round.cutoff = end - cutoffBuffer;
        round.openingDeadline = _timestamp(uint256(start) + observationWindow + openingGrace);
        round.resolutionDeadline = deadline;
        emit RoundCreated(roundId, asset, duration, start, end);
    }

    /// @notice Record the unique first update at/after start. Unusable first updates cannot be replaced later.
    function recordOpening(bytes32 roundId, bytes calldata evidence) external payable nonReentrant {
        Round storage round = _requireRound(roundId);
        if (round.outcome != Outcome.Pending) revert AlreadyFinalized();
        if (round.openedAt != 0) revert OpeningAlreadyRecorded();
        if (block.timestamp < round.start || block.timestamp > round.openingDeadline) {
            revert OutsideOpeningWindow();
        }
        IBoundaryOracle.Observation memory observed = _verify(round.asset, round.start, evidence);
        round.opening = observed;
        round.openedAt = _timestamp(block.timestamp);
        emit OpeningRecorded(
            roundId, observed.price, observed.confidence, observed.exponent, observed.publishTime
        );
    }

    /// @notice Close with the unique first update at/after end; >= opening resolves Up, otherwise Down.
    function resolveRound(bytes32 roundId, bytes calldata evidence) external payable nonReentrant {
        Round storage round = _requireRound(roundId);
        if (round.outcome != Outcome.Pending) revert AlreadyFinalized();
        if (round.openedAt == 0) revert OpeningMissing();
        if (block.timestamp < round.end || block.timestamp > round.resolutionDeadline) {
            revert OutsideResolutionWindow();
        }
        IBoundaryOracle.Observation memory observed = _verify(round.asset, round.end, evidence);
        round.closing = observed;
        round.outcome = observed.price >= round.opening.price ? Outcome.Up : Outcome.Down;
        round.resolvedAt = _timestamp(block.timestamp);
        emit RoundResolved(roundId, round.outcome, observed.price, observed.publishTime);
    }

    /// @notice Permissionless terminal timeout: half a collateral unit per outcome share.
    /// @dev No price evidence or administrator can reverse this once recorded. Strict > makes deadline
    /// equality eligible for observation submission and prevents a same-timestamp resolve/void race.
    function voidRound(bytes32 roundId) external nonReentrant {
        Round storage round = _requireRound(roundId);
        if (round.outcome != Outcome.Pending) revert AlreadyFinalized();
        bool missing = round.openedAt == 0;
        if (block.timestamp <= (missing ? round.openingDeadline : round.resolutionDeadline)) {
            revert TimeoutNotReached();
        }
        round.outcome = Outcome.Void;
        round.resolvedAt = _timestamp(block.timestamp);
        emit RoundVoided(roundId, missing);
    }

    function getRound(bytes32 roundId) external view returns (Round memory) {
        return _requireRound(roundId);
    }

    function phase(bytes32 roundId) public view returns (Phase) {
        Round storage round = _rounds[roundId];
        if (round.start == 0) return Phase.Missing;
        if (round.outcome == Outcome.Void) return Phase.Voided;
        if (round.outcome != Outcome.Pending) return Phase.Resolved;
        if (round.openedAt == 0 && block.timestamp > round.openingDeadline) return Phase.Voidable;
        if (block.timestamp > round.resolutionDeadline) return Phase.Voidable;
        if (block.timestamp < round.start) return Phase.Scheduled;
        if (round.openedAt == 0) return Phase.OpeningPending;
        if (block.timestamp < round.cutoff) return Phase.Trading;
        if (block.timestamp < round.end) return Phase.Closed;
        return Phase.ResolutionPending;
    }

    /// @dev Informational only. Does not admit, sequence or commit confidential orders.
    function canTrade(bytes32 roundId) external view returns (bool) {
        return phase(roundId) == Phase.Trading;
    }

    /// @notice Payout ratio per whole share in collateral units, not a dollar-peg guarantee.
    function payoutNumerators(bytes32 roundId)
        external
        view
        returns (uint8 up, uint8 down, uint8 denominator)
    {
        Outcome result = _requireRound(roundId).outcome;
        if (result == Outcome.Pending) return (0, 0, 0);
        if (result == Outcome.Up) return (2, 0, PAYOUT_DENOMINATOR);
        if (result == Outcome.Down) return (0, 2, PAYOUT_DENOMINATOR);
        return (1, 1, PAYOUT_DENOMINATOR);
    }

    function _verify(Asset asset, uint64 boundary, bytes calldata evidence)
        private
        returns (IBoundaryOracle.Observation memory observed)
    {
        uint256 fee = oracle.quoteFee(evidence);
        if (msg.value != fee) revert IncorrectFee(fee, msg.value);
        uint64 last = _timestamp(uint256(boundary) + observationWindow);
        bytes32 feed = asset == Asset.BTC ? btcFeedId : ethFeedId;
        observed = oracle.verifyBoundary{value: fee}(feed, boundary, last, evidence);
        int32 exponent = asset == Asset.BTC ? btcExponent : ethExponent;
        if (
            observed.price <= 0 || observed.exponent != exponent || observed.publishTime < boundary
                || observed.publishTime > last || observed.publishTime > block.timestamp
        ) revert InvalidObservation();
        // Positive int64 price and uint64 confidence times <=10000 fit comfortably in uint256.
        if (uint256(observed.confidence) * 10_000 > uint256(uint64(observed.price)) * maxConfidenceBps) {
            revert InvalidObservation();
        }
    }

    function _requireRound(bytes32 roundId) private view returns (Round storage round) {
        round = _rounds[roundId];
        if (round.start == 0) revert UnknownRound(roundId);
    }

    function _timestamp(uint256 value) private pure returns (uint64) {
        if (value > type(uint64).max) revert TimestampOverflow();
        // Safe because the exact uint64 upper bound is checked immediately above.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint64(value);
    }
}
