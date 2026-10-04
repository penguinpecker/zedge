// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {StreamsRoundRegistry} from "../src/StreamsRoundRegistry.sol";
import {IStreamsBoundaryOracle} from "../src/interfaces/IStreamsBoundaryOracle.sol";
import {MockStreamsBoundaryOracle} from "./mocks/MockStreamsBoundaryOracle.sol";
import {MockCollateral} from "./mocks/MockBoundaryOracle.sol";

contract StreamsRoundRegistryTest is Test {
    uint32 internal constant START = 1_800_000_000;
    bytes32 internal constant BTC = bytes32((uint256(3) << 240) | 1);
    bytes32 internal constant ETH = bytes32((uint256(3) << 240) | 2);
    MockStreamsBoundaryOracle internal oracle;
    StreamsRoundRegistry internal registry;
    StreamsRoundRegistry.Config internal config;
    bytes32 internal id;

    function setUp() public {
        vm.warp(START - 600);
        vm.deal(address(this), 100 ether);
        oracle = new MockStreamsBoundaryOracle();
        config = StreamsRoundRegistry.Config(
            address(oracle), address(new MockCollateral()), BTC, ETH, 18, 18, 10, 20, 60, 30
        );
        registry = new StreamsRoundRegistry(config);
        id = registry.createRound(StreamsRoundRegistry.Asset.BTC, 300, START);
    }

    function evidence(int192 price, uint32 publishTime) internal pure returns (bytes memory) {
        return abi.encode(
            IStreamsBoundaryOracle.Observation(
                price, START, publishTime, publishTime + 30, keccak256(abi.encode(price, publishTime)), 18
            )
        );
    }

    function open() internal {
        vm.warp(START);
        registry.recordOpening(id, evidence(100_000, START));
    }

    function testConfigIdentityAndSchedule() public view {
        assertEq(registry.version(), "zedge-streams-round-registry-v1");
        assertEq(address(registry.oracle()), address(oracle));
        assertEq(
            registry.rulesHash(),
            keccak256(
                abi.encode(
                    "zedge-streams-rounds-v1:schema3:boundary-window:exact-price:no-confidence:tie-up:void-half",
                    block.chainid,
                    config
                )
            )
        );
        assertEq(id, registry.roundIdFor(StreamsRoundRegistry.Asset.BTC, 300, START));
        StreamsRoundRegistry.Round memory round = registry.getRound(id);
        assertEq(round.start, START);
        assertEq(round.end, START + 300);
        assertEq(round.cutoff, START + 270);
        assertEq(round.openingDeadline, START + 30);
        assertEq(round.resolutionDeadline, START + 370);
        assertEq(uint8(registry.phase(id)), uint8(StreamsRoundRegistry.Phase.Scheduled));
        assertFalse(registry.canTrade(id));
    }

    function testAllFourTemplatesAndIndependentIDs() public {
        bytes32 btc15 = registry.createRound(StreamsRoundRegistry.Asset.BTC, 900, START);
        bytes32 eth5 = registry.createRound(StreamsRoundRegistry.Asset.ETH, 300, START);
        bytes32 eth15 = registry.createRound(StreamsRoundRegistry.Asset.ETH, 900, START);
        assertTrue(id != btc15 && id != eth5 && eth5 != eth15 && btc15 != eth15);
        vm.warp(START);
        registry.recordOpening(eth15, evidence(20_000, START));
        assertEq(oracle.lastFeed(), ETH);
        assertEq(registry.getRound(eth15).end, START + 900);
    }

    function testDifferentRegistryAndChainDomains() public {
        StreamsRoundRegistry other = new StreamsRoundRegistry(config);
        assertTrue(id != other.roundIdFor(StreamsRoundRegistry.Asset.BTC, 300, START));
        vm.chainId(2651420);
        StreamsRoundRegistry testnet = new StreamsRoundRegistry(config);
        assertTrue(registry.rulesHash() != testnet.rulesHash());
    }

    function testRejectDuplicatePastUnalignedAndUnsupported() public {
        vm.expectRevert(abi.encodeWithSelector(StreamsRoundRegistry.RoundExists.selector, id));
        registry.createRound(StreamsRoundRegistry.Asset.BTC, 300, START);
        vm.expectRevert(StreamsRoundRegistry.InvalidSchedule.selector);
        registry.createRound(StreamsRoundRegistry.Asset.BTC, 600, START);
        vm.expectRevert(StreamsRoundRegistry.InvalidSchedule.selector);
        registry.createRound(StreamsRoundRegistry.Asset.BTC, 300, START + 1);
        vm.warp(START);
        vm.expectRevert(StreamsRoundRegistry.InvalidSchedule.selector);
        registry.createRound(StreamsRoundRegistry.Asset.ETH, 300, START);
    }

    function testInvalidConfiguration() public {
        StreamsRoundRegistry.Config memory bad = config;
        bad.oracle = address(1);
        assertInvalidConfig(bad);
        bad = config;
        bad.collateral = address(1);
        assertInvalidConfig(bad);
        bad = config;
        bad.btcFeedId = bytes32(0);
        assertInvalidConfig(bad);
        bad = config;
        bad.ethFeedId = BTC;
        assertInvalidConfig(bad);
        bad = config;
        bad.btcDecimals = 19;
        assertInvalidConfig(bad);
        bad = config;
        bad.ethDecimals = 19;
        assertInvalidConfig(bad);
        bad = config;
        bad.cutoffBuffer = 300;
        assertInvalidConfig(bad);
        bad = config;
        bad.cutoffBuffer = 0;
        assertInvalidConfig(bad);
        bad = config;
        bad.openingGrace = 0;
        assertInvalidConfig(bad);
        bad = config;
        bad.settlementGrace = 0;
        assertInvalidConfig(bad);
        bad = config;
        bad.observationWindow = 250;
        assertInvalidConfig(bad);
        bad = config;
        bad.observationWindow = 61;
        assertInvalidConfig(bad);
        bad = config;
        bad.settlementGrace = 86_400;
        assertInvalidConfig(bad);
        bad = config;
        bad.btcFeedId = keccak256("wrong-schema");
        assertInvalidConfig(bad);
    }

    function assertInvalidConfig(StreamsRoundRegistry.Config memory bad) internal {
        vm.expectRevert(StreamsRoundRegistry.InvalidConfig.selector);
        new StreamsRoundRegistry(bad);
    }

    function testRejectTimestampOverflow() public {
        uint64 far = type(uint64).max - type(uint64).max % 300;
        vm.expectRevert(StreamsRoundRegistry.TimestampOverflow.selector);
        registry.createRound(StreamsRoundRegistry.Asset.BTC, 300, far);
    }

    function testOpeningWindowAndNoOpeningTrade() public {
        vm.expectRevert(StreamsRoundRegistry.OutsideOpeningWindow.selector);
        registry.recordOpening(id, evidence(100_000, START));
        vm.warp(START);
        assertEq(uint8(registry.phase(id)), uint8(StreamsRoundRegistry.Phase.OpeningPending));
        assertFalse(registry.canTrade(id));
        vm.warp(START + 30);
        registry.recordOpening(id, evidence(100_000, START + 10));
        assertTrue(registry.canTrade(id));
        assertEq(oracle.lastBoundary(), START);
        assertEq(oracle.lastMaximum(), START + 10);
        assertEq(address(registry).balance, 0);
        assertEq(address(oracle).balance, 0);
    }

    function testOpeningTooLateCannotChangeTimeoutOutcome() public {
        vm.warp(START + 31);
        vm.expectRevert(StreamsRoundRegistry.OutsideOpeningWindow.selector);
        registry.recordOpening(id, evidence(100_000, START));
        assertEq(uint8(registry.phase(id)), uint8(StreamsRoundRegistry.Phase.Voidable));
        registry.voidRound(id);
        assertEq(uint8(registry.getRound(id).outcome), uint8(StreamsRoundRegistry.Outcome.Void));
    }

    function testOpeningImmutable() public {
        open();
        vm.expectRevert(StreamsRoundRegistry.OpeningAlreadyRecorded.selector);
        registry.recordOpening(id, evidence(200_000, START));
        assertEq(registry.getRound(id).opening.price, 100_000);
    }

    function testCanonicalCutoffExactEquality() public {
        open();
        vm.warp(START + 269);
        assertTrue(registry.canTrade(id));
        vm.warp(START + 270);
        assertFalse(registry.canTrade(id));
        assertEq(uint8(registry.phase(id)), uint8(StreamsRoundRegistry.Phase.Closed));
        vm.warp(START + 300);
        assertEq(uint8(registry.phase(id)), uint8(StreamsRoundRegistry.Phase.ResolutionPending));
    }

    function testTieResolvesUpAndCannotRewrite() public {
        open();
        vm.warp(START + 300);
        registry.resolveRound(id, evidence(100_000, START + 300));
        assertEq(uint8(registry.getRound(id).outcome), uint8(StreamsRoundRegistry.Outcome.Up));
        assertEq(uint8(registry.phase(id)), uint8(StreamsRoundRegistry.Phase.Resolved));
        (uint8 up, uint8 down, uint8 denominator) = registry.payoutNumerators(id);
        assertEq(up, 2);
        assertEq(down, 0);
        assertEq(denominator, 2);
        vm.expectRevert(StreamsRoundRegistry.AlreadyFinalized.selector);
        registry.resolveRound(id, evidence(1, START + 300));
        vm.warp(START + 400);
        vm.expectRevert(StreamsRoundRegistry.AlreadyFinalized.selector);
        registry.voidRound(id);
    }

    function testDownResolvesAndResolutionDeadlineEquality() public {
        open();
        vm.warp(START + 370);
        vm.expectRevert(StreamsRoundRegistry.TimeoutNotReached.selector);
        registry.voidRound(id);
        registry.resolveRound(id, evidence(99_999, START + 310));
        (uint8 up, uint8 down, uint8 denominator) = registry.payoutNumerators(id);
        assertEq(up, 0);
        assertEq(down, 2);
        assertEq(denominator, 2);
        assertEq(oracle.lastBoundary(), START + 300);
    }

    function testCannotResolveEarlyOrWithoutOpening() public {
        vm.warp(START + 300);
        vm.expectRevert(StreamsRoundRegistry.OpeningMissing.selector);
        registry.resolveRound(id, evidence(1, START + 300));
        open();
        vm.warp(START + 299);
        vm.expectRevert(StreamsRoundRegistry.OutsideResolutionWindow.selector);
        registry.resolveRound(id, evidence(100_000, START + 300));
    }

    function testTimeoutAfterOpeningAndNoLateResolution() public {
        open();
        vm.warp(START + 371);
        assertEq(uint8(registry.phase(id)), uint8(StreamsRoundRegistry.Phase.Voidable));
        vm.expectRevert(StreamsRoundRegistry.OutsideResolutionWindow.selector);
        registry.resolveRound(id, evidence(100_001, START + 300));
        registry.voidRound(id);
        (uint8 up, uint8 down, uint8 denominator) = registry.payoutNumerators(id);
        assertEq(up, 1);
        assertEq(down, 1);
        assertEq(denominator, 2);
        assertFalse(registry.canTrade(id));
        assertEq(uint8(registry.phase(id)), uint8(StreamsRoundRegistry.Phase.Voided));
        vm.expectRevert(StreamsRoundRegistry.AlreadyFinalized.selector);
        registry.voidRound(id);
    }

    function testOpeningTimeoutStrictEquality() public {
        vm.warp(START + 30);
        vm.expectRevert(StreamsRoundRegistry.TimeoutNotReached.selector);
        registry.voidRound(id);
        vm.warp(START + 31);
        registry.voidRound(id);
        vm.expectRevert(StreamsRoundRegistry.AlreadyFinalized.selector);
        registry.recordOpening(id, evidence(100_000, START));
    }

    function testRejectInvalidWindowPrecisionHashPriceAndTime() public {
        vm.warp(START + 10);
        IStreamsBoundaryOracle.Observation memory good =
            abi.decode(evidence(100_000e18, START), (IStreamsBoundaryOracle.Observation));
        IStreamsBoundaryOracle.Observation memory bad = copy(good);
        bad.price = 0;
        rejectObservation(bad);
        bad = copy(good);
        bad.price = -1;
        rejectObservation(bad);
        bad = copy(good);
        bad.decimals = 8;
        rejectObservation(bad);
        bad = copy(good);
        bad.reportHash = bytes32(0);
        rejectObservation(bad);
        bad = copy(good);
        bad.validFromTimestamp = 0;
        rejectObservation(bad);
        bad = copy(good);
        bad.validFromTimestamp = START + 1;
        rejectObservation(bad);
        bad = copy(good);
        bad.observationsTimestamp = START - 1;
        rejectObservation(bad);
        bad = copy(good);
        bad.observationsTimestamp = START + 11;
        rejectObservation(bad);
        bad = copy(good);
        bad.expiresAt = START - 1;
        rejectObservation(bad);
        vm.warp(START);
        bad = copy(good);
        bad.observationsTimestamp = START + 1;
        rejectObservation(bad);
        registry.recordOpening(id, abi.encode(good));
        assertEq(registry.getRound(id).opening.price, 100_000e18);
    }

    function copy(IStreamsBoundaryOracle.Observation memory value)
        internal
        pure
        returns (IStreamsBoundaryOracle.Observation memory)
    {
        return abi.decode(abi.encode(value), (IStreamsBoundaryOracle.Observation));
    }

    function testHistoricalBridgeObservationUsesSubmissionDeadlineNotReportExpiry() public {
        vm.warp(START + 30);
        IStreamsBoundaryOracle.Observation memory observed =
            abi.decode(evidence(100_000e18, START), (IStreamsBoundaryOracle.Observation));
        observed.expiresAt = START + 1;
        // The source adapter must authenticate before expiration. This fixture models
        // the destination cache returning an already authenticated historical report.
        registry.recordOpening(id, abi.encode(observed));
        assertTrue(registry.canTrade(id));
    }

    function testNoPrecisionLossWhenPricesDifferByOneAt18Decimals() public {
        vm.warp(START);
        registry.recordOpening(id, evidence(100_000e18, START));
        vm.warp(START + 300);
        registry.resolveRound(id, evidence(100_000e18 - 1, START + 300));
        assertEq(uint8(registry.getRound(id).outcome), uint8(StreamsRoundRegistry.Outcome.Down));
    }

    function testCannotScheduleBeyondSchemaTimestampRange() public {
        uint64 start = uint64(type(uint32).max / 300) * 300;
        vm.expectRevert(StreamsRoundRegistry.InvalidSchedule.selector);
        registry.createRound(StreamsRoundRegistry.Asset.BTC, 300, start);
    }

    function rejectObservation(IStreamsBoundaryOracle.Observation memory observation) internal {
        vm.expectRevert(StreamsRoundRegistry.InvalidObservation.selector);
        registry.recordOpening(id, abi.encode(observation));
        assertEq(registry.getRound(id).openedAt, 0);
        assertEq(address(registry).balance, 0);
    }

    function testUnexpectedETHAndOracleRevertAreAtomic() public {
        vm.warp(START);
        (bool accepted,) = address(registry).call{value: 1}(
            abi.encodeCall(registry.recordOpening, (id, evidence(100_000, START)))
        );
        assertFalse(accepted);
        oracle.setFailure(true);
        vm.expectRevert("test oracle unavailable");
        registry.recordOpening(id, evidence(100_000, START));
        assertEq(registry.getRound(id).openedAt, 0);
        assertEq(address(oracle).balance, 0);
    }

    function testReentrantOracleCannotRecordAgain() public {
        vm.warp(START);
        oracle.setReentry(address(registry), abi.encodeCall(registry.recordOpening, (id, evidence(2, START))));
        registry.recordOpening(id, evidence(100_000, START));
        assertFalse(oracle.reentrySucceeded());
        assertEq(registry.getRound(id).opening.price, 100_000);
    }

    function testUnknownRoundAndNoArbitraryETH() public {
        bytes32 missing = keccak256("missing");
        assertEq(uint8(registry.phase(missing)), uint8(StreamsRoundRegistry.Phase.Missing));
        assertFalse(registry.canTrade(missing));
        vm.expectRevert(abi.encodeWithSelector(StreamsRoundRegistry.UnknownRound.selector, missing));
        registry.getRound(missing);
        (bool ok,) = address(registry).call("");
        assertFalse(ok);
        (uint8 up, uint8 down, uint8 denominator) = registry.payoutNumerators(id);
        assertEq(up, 0);
        assertEq(down, 0);
        assertEq(denominator, 0);
    }

    function testFuzzPositivePricesDetermineOnlyComparison(uint192 rawOpen, uint192 rawClose) public {
        int192 startPrice = int192(uint192(bound(rawOpen, 1, uint192(type(int192).max))));
        int192 endPrice = int192(uint192(bound(rawClose, 1, uint192(type(int192).max))));
        vm.warp(START);
        registry.recordOpening(id, evidence(startPrice, START));
        vm.warp(START + 300);
        registry.resolveRound(id, evidence(endPrice, START + 300));
        StreamsRoundRegistry.Outcome expected =
            endPrice >= startPrice ? StreamsRoundRegistry.Outcome.Up : StreamsRoundRegistry.Outcome.Down;
        assertEq(uint8(registry.getRound(id).outcome), uint8(expected));
        (uint8 up, uint8 down, uint8 denominator) = registry.payoutNumerators(id);
        assertEq(uint256(up) + down, denominator);
    }

    function testFuzzScheduleAlwaysAlignedAndImmutable(uint32 offset, bool eth, bool fifteen) public {
        uint32 duration = fifteen ? 900 : 300;
        uint64 start = START + uint64(bound(offset, 1, 10_000)) * 900;
        StreamsRoundRegistry.Asset asset =
            eth ? StreamsRoundRegistry.Asset.ETH : StreamsRoundRegistry.Asset.BTC;
        bytes32 roundId = registry.createRound(asset, duration, start);
        StreamsRoundRegistry.Round memory round = registry.getRound(roundId);
        assertEq(round.start % duration, 0);
        assertLt(round.openingDeadline, round.cutoff);
        assertLt(round.cutoff, round.end);
        assertGt(round.resolutionDeadline, round.end);
        assertEq(round.duration, duration);
    }
}
