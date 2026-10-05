// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {
    Ownable2StepUpgradeable
} from "../node_modules/@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IStreamsBoundaryOracle} from "./interfaces/IStreamsBoundaryOracle.sol";
import {IStreamsObservationCache} from "./interfaces/IStreamsObservationCache.sol";

/// @notice BTC/ETH rounds using authenticated Chainlink Streams boundary windows, behind a UUPS proxy.
/// @dev The owner can only upgrade the implementation and hand ownership over in two steps; it cannot
/// renounce. No pause, arbitrary outcome setter, token transfer or TEE-signature authority.
/// This registry does not make a private order timely: canTrade is a current-chain observation only.
contract StreamsRoundRegistry is Initializable, UUPSUpgradeable, Ownable2StepUpgradeable, ReentrancyGuard {
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
        uint8 btcDecimals;
        uint8 ethDecimals;
        uint32 observationWindow;
        uint32 openingGrace;
        uint32 voidGrace;
        uint32 cutoffBuffer;
    }

    struct Round {
        Asset asset;
        uint32 duration;
        uint64 start;
        uint64 end;
        uint64 cutoff;
        uint64 openingDeadline;
        uint64 voidableAfter;
        uint64 openedAt;
        uint64 resolvedAt;
        Outcome outcome;
        IStreamsBoundaryOracle.Observation opening;
        IStreamsBoundaryOracle.Observation closing;
    }

    error InvalidConfig();
    error InvalidSchedule();
    error RoundExists(bytes32 roundId);
    error UnknownRound(bytes32 roundId);
    error AlreadyFinalized();
    error OpeningAlreadyRecorded();
    error OpeningMissing();
    error OutsideOpeningWindow();
    error RoundNotEnded();
    error TimeoutNotReached();
    error ClosingEvidenceAvailable();
    error RenounceDisabled();
    error InvalidObservation();
    error TimestampOverflow();

    event RoundCreated(
        bytes32 indexed roundId, Asset indexed asset, uint32 duration, uint64 start, uint64 end
    );
    event OpeningRecorded(
        bytes32 indexed roundId, int192 price, uint8 decimals, uint32 observedAt, bytes32 reportHash
    );
    event RoundResolved(
        bytes32 indexed roundId, Outcome outcome, int192 closingPrice, uint32 observedAt, bytes32 reportHash
    );
    event RoundVoided(bytes32 indexed roundId, bool openingMissing);

    uint8 public constant PAYOUT_DENOMINATOR = 2;
    // Own storage starts at slot 0: every OpenZeppelin base keeps its state in ERC-7201 namespaced slots.
    // Slot 0: oracle, both decimals, observationWindow, openingGrace. Slot 1: collateral, voidGrace,
    // cutoffBuffer. Slots 2-6: feeds, chain, rules, rounds. An upgrade may only append, shrinking __gap.
    IStreamsObservationCache public oracle;
    uint8 public btcDecimals;
    uint8 public ethDecimals;
    uint32 public observationWindow;
    uint32 public openingGrace;
    address public collateral;
    uint32 public voidGrace;
    uint32 public cutoffBuffer;
    bytes32 public btcFeedId;
    bytes32 public ethFeedId;
    uint256 public deploymentChainId;
    bytes32 public rulesHash;
    mapping(bytes32 => Round) private _rounds;
    uint256[43] private __gap;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice One-time proxy setup. The configuration cannot be edited afterwards except by an upgrade.
    function initialize(Config calldata config, address initialOwner) external initializer {
        if (
            config.oracle.code.length == 0 || config.collateral.code.length == 0
                || config.btcFeedId == bytes32(0) || config.ethFeedId == bytes32(0)
                || config.btcFeedId == config.ethFeedId || config.btcDecimals > 18 || config.ethDecimals > 18
                || uint16(bytes2(config.btcFeedId)) != 3 || uint16(bytes2(config.ethFeedId)) != 3
                || config.cutoffBuffer == 0 || config.cutoffBuffer >= 300 || config.openingGrace == 0
                // A Chainlink report can be verified on Base for 30 days; void must be possible well before.
                || config.voidGrace < 1 days || config.voidGrace > 21 days || config.observationWindow > 60
                || uint256(config.observationWindow) + config.openingGrace >= 300 - config.cutoffBuffer
        ) revert InvalidConfig();
        IStreamsObservationCache cache = IStreamsObservationCache(config.oracle);
        // The cache must hold exactly the units and window this registry accepts, so that a cached
        // closing observation can always resolve. Boundary 1 can never be delivered: it must read empty.
        if (
            cache.btcFeedId() != config.btcFeedId || cache.ethFeedId() != config.ethFeedId
                || cache.btcDecimals() != config.btcDecimals || cache.ethDecimals() != config.ethDecimals
                || cache.observationWindow() != config.observationWindow
                || cache.destinationChainId() != block.chainid
                || cache.getObservation(config.btcFeedId, 1).reportHash != bytes32(0)
        ) revert InvalidConfig();
        __Ownable_init(initialOwner);
        oracle = cache;
        collateral = config.collateral;
        btcFeedId = config.btcFeedId;
        ethFeedId = config.ethFeedId;
        btcDecimals = config.btcDecimals;
        ethDecimals = config.ethDecimals;
        observationWindow = config.observationWindow;
        openingGrace = config.openingGrace;
        voidGrace = config.voidGrace;
        cutoffBuffer = config.cutoffBuffer;
        deploymentChainId = block.chainid;
        // Includes fixed tie, late-resolution and void policies via the explicit version string.
        rulesHash = keccak256(
            abi.encode(
                "zedge-streams-rounds-v2:schema3:boundary-window:exact-price:no-confidence:tie-up:late-resolution:void-half",
                block.chainid,
                config
            )
        );
    }

    function version() external pure returns (string memory) {
        return "zedge-streams-round-registry-v2";
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
        // Schema v3 carries uint32 timestamps. Never schedule an unrepresentable boundary.
        if (uint256(end) + observationWindow > type(uint32).max) revert InvalidSchedule();
        uint64 voidableAfter = _timestamp(uint256(end) + observationWindow + voidGrace);
        roundId = roundIdFor(asset, duration, start);
        if (_rounds[roundId].start != 0) revert RoundExists(roundId);
        Round storage round = _rounds[roundId];
        round.asset = asset;
        round.duration = duration;
        round.start = start;
        round.end = end;
        round.cutoff = end - cutoffBuffer;
        round.openingDeadline = _timestamp(uint256(start) + observationWindow + openingGrace);
        round.voidableAfter = voidableAfter;
        emit RoundCreated(roundId, asset, duration, start, end);
    }

    /// @notice Record the verified report whose signed window contains start.
    function recordOpening(bytes32 roundId, bytes calldata evidence) external nonReentrant {
        Round storage round = _requireRound(roundId);
        if (round.outcome != Outcome.Pending) revert AlreadyFinalized();
        if (round.openedAt != 0) revert OpeningAlreadyRecorded();
        if (block.timestamp < round.start || block.timestamp > round.openingDeadline) {
            revert OutsideOpeningWindow();
        }
        IStreamsBoundaryOracle.Observation memory observed = _verify(round.asset, round.start, evidence);
        round.opening = observed;
        round.openedAt = _timestamp(block.timestamp);
        emit OpeningRecorded(
            roundId, observed.price, observed.decimals, observed.observationsTimestamp, observed.reportHash
        );
    }

    /// @notice Close with the verified window containing end; >= opening resolves Up, otherwise Down.
    /// @dev No upper time limit: a closing observation that arrives late still decides the round.
    function resolveRound(bytes32 roundId, bytes calldata evidence) external nonReentrant {
        Round storage round = _requireRound(roundId);
        if (round.outcome != Outcome.Pending) revert AlreadyFinalized();
        if (round.openedAt == 0) revert OpeningMissing();
        if (block.timestamp < round.end) revert RoundNotEnded();
        IStreamsBoundaryOracle.Observation memory observed = _verify(round.asset, round.end, evidence);
        round.closing = observed;
        round.outcome = observed.price >= round.opening.price ? Outcome.Up : Outcome.Down;
        round.resolvedAt = _timestamp(block.timestamp);
        emit RoundResolved(
            roundId, round.outcome, observed.price, observed.observationsTimestamp, observed.reportHash
        );
    }

    /// @notice Permissionless terminal timeout: half a collateral unit per outcome share.
    /// @dev No price evidence or administrator can reverse this once recorded. Strict > makes deadline
    /// equality eligible for opening submission. An opened round can be voided only while the cache
    /// holds no closing observation: once that price is on this chain the round must be resolved.
    function voidRound(bytes32 roundId) external nonReentrant {
        Round storage round = _requireRound(roundId);
        if (round.outcome != Outcome.Pending) revert AlreadyFinalized();
        bool missing = round.openedAt == 0;
        if (block.timestamp <= (missing ? round.openingDeadline : round.voidableAfter)) {
            revert TimeoutNotReached();
        }
        if (!missing && _closingCached(round)) revert ClosingEvidenceAvailable();
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
        if (block.timestamp < round.start) return Phase.Scheduled;
        if (round.openedAt == 0) return Phase.OpeningPending;
        if (block.timestamp < round.cutoff) return Phase.Trading;
        if (block.timestamp < round.end) return Phase.Closed;
        if (block.timestamp > round.voidableAfter && !_closingCached(round)) return Phase.Voidable;
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
        returns (IStreamsBoundaryOracle.Observation memory observed)
    {
        uint64 last = _timestamp(uint256(boundary) + observationWindow);
        bytes32 feed = asset == Asset.BTC ? btcFeedId : ethFeedId;
        observed = oracle.verifyBoundary(feed, boundary, last, evidence);
        uint8 decimals = asset == Asset.BTC ? btcDecimals : ethDecimals;
        // Exact unit identity and missing-data sentinels, never equality to a changing clock.
        // Slither taints the entire oracle response from its timestamp argument. These
        // checks intentionally reject a zero fingerprint/epoch and a different price unit.
        if (
            // slither-disable-next-line incorrect-equality
            observed.reportHash == bytes32(0) || observed.validFromTimestamp == 0
                || observed.decimals != decimals
        ) {
            revert InvalidObservation();
        }
        if (
            observed.price <= 0 || observed.validFromTimestamp > boundary
                || observed.observationsTimestamp < boundary || observed.observationsTimestamp > last
                || observed.observationsTimestamp > block.timestamp
                || observed.expiresAt < observed.observationsTimestamp
        ) revert InvalidObservation();
        // The Base adapter checks report expiration when authenticating it. A native bridge
        // may deliver that authenticated historical observation later. This registry uses
        // its own opening deadline and void rule; expiration is not a cross-chain clock.
        // Keep the signed int192 value exactly. No Pyth confidence or price normalization.
    }

    /// @dev The cache's non-reverting view; a nonzero report hash means the closing price was delivered.
    function _closingCached(Round storage round) private view returns (bool) {
        bytes32 feed = round.asset == Asset.BTC ? btcFeedId : ethFeedId;
        return oracle.getObservation(feed, round.end).reportHash != bytes32(0);
    }

    /// @notice Disabled. One call would otherwise end upgrades for good, with no second step to catch a
    /// mistake; ownership moves only through transferOwnership and acceptOwnership.
    /// @dev Left nonpayable and virtual, as inherited, so the ABI still lists it as a transaction.
    function renounceOwnership() public virtual override {
        revert RenounceDisabled();
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

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
