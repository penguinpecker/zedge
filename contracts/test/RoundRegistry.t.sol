// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {RoundRegistry} from "../src/RoundRegistry.sol";
import {IBoundaryOracle} from "../src/interfaces/IBoundaryOracle.sol";
import {MockBoundaryOracle, MockCollateral} from "./mocks/MockBoundaryOracle.sol";

contract RoundRegistryTest is Test {
    uint64 internal constant START = 1_800_000_000;
    bytes32 internal constant BTC = keccak256("TEST-BTC-USD");
    bytes32 internal constant ETH = keccak256("TEST-ETH-USD");
    MockBoundaryOracle internal oracle;
    RoundRegistry internal registry;
    RoundRegistry.Config internal config;
    bytes32 internal id;

    function setUp() public {
        vm.warp(START - 600);
        vm.deal(address(this), 100 ether);
        oracle = new MockBoundaryOracle();
        config = RoundRegistry.Config(
            address(oracle), address(new MockCollateral()), BTC, ETH, -8, -8, 10, 20, 60, 30, 100
        );
        registry = new RoundRegistry(config);
        id = registry.createRound(RoundRegistry.Asset.BTC, 300, START);
    }

    function evidence(int64 price, uint64 publishTime) internal pure returns (bytes memory) {
        return abi.encode(IBoundaryOracle.Observation(price, 0, -8, publishTime));
    }

    function open() internal {
        vm.warp(START);
        registry.recordOpening{value: 1}(id, evidence(100_000, START));
    }

    function testConfigIdentityAndSchedule() public view {
        assertEq(registry.version(), "zedge-round-registry-v1");
        assertEq(address(registry.oracle()), address(oracle));
        assertEq(
            registry.rulesHash(),
            keccak256(abi.encode("zedge-round-registry-v1:tie-up:void-half", block.chainid, config))
        );
        assertEq(id, registry.roundIdFor(RoundRegistry.Asset.BTC, 300, START));
        RoundRegistry.Round memory round = registry.getRound(id);
        assertEq(round.start, START);
        assertEq(round.end, START + 300);
        assertEq(round.cutoff, START + 270);
        assertEq(round.openingDeadline, START + 30);
        assertEq(round.resolutionDeadline, START + 370);
        assertEq(uint8(registry.phase(id)), uint8(RoundRegistry.Phase.Scheduled));
        assertFalse(registry.canTrade(id));
    }

    function testAllFourTemplatesAndIndependentIDs() public {
        bytes32 btc15 = registry.createRound(RoundRegistry.Asset.BTC, 900, START);
        bytes32 eth5 = registry.createRound(RoundRegistry.Asset.ETH, 300, START);
        bytes32 eth15 = registry.createRound(RoundRegistry.Asset.ETH, 900, START);
        assertTrue(id != btc15 && id != eth5 && eth5 != eth15 && btc15 != eth15);
        vm.warp(START);
        registry.recordOpening{value: 1}(eth15, evidence(20_000, START));
        assertEq(oracle.lastFeed(), ETH);
        assertEq(registry.getRound(eth15).end, START + 900);
    }

    function testDifferentRegistryAndChainDomains() public {
        RoundRegistry other = new RoundRegistry(config);
        assertTrue(id != other.roundIdFor(RoundRegistry.Asset.BTC, 300, START));
        vm.chainId(2651420);
        RoundRegistry testnet = new RoundRegistry(config);
        assertTrue(registry.rulesHash() != testnet.rulesHash());
    }

    function testRejectDuplicatePastUnalignedAndUnsupported() public {
        vm.expectRevert(abi.encodeWithSelector(RoundRegistry.RoundExists.selector, id));
        registry.createRound(RoundRegistry.Asset.BTC, 300, START);
        vm.expectRevert(RoundRegistry.InvalidSchedule.selector);
        registry.createRound(RoundRegistry.Asset.BTC, 600, START);
        vm.expectRevert(RoundRegistry.InvalidSchedule.selector);
        registry.createRound(RoundRegistry.Asset.BTC, 300, START + 1);
        vm.warp(START);
        vm.expectRevert(RoundRegistry.InvalidSchedule.selector);
        registry.createRound(RoundRegistry.Asset.ETH, 300, START);
    }

    function testInvalidConfiguration() public {
        RoundRegistry.Config memory bad = config;
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
        bad.btcExponent = 1;
        assertInvalidConfig(bad);
        bad = config;
        bad.ethExponent = -19;
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
        bad.maxConfidenceBps = 0;
        assertInvalidConfig(bad);
        bad = config;
        bad.maxConfidenceBps = 10_001;
        assertInvalidConfig(bad);
    }

    function assertInvalidConfig(RoundRegistry.Config memory bad) internal {
        vm.expectRevert(RoundRegistry.InvalidConfig.selector);
        new RoundRegistry(bad);
    }

    function testRejectTimestampOverflow() public {
        uint64 far = type(uint64).max - type(uint64).max % 300;
        vm.expectRevert(RoundRegistry.TimestampOverflow.selector);
        registry.createRound(RoundRegistry.Asset.BTC, 300, far);
    }

    function testOpeningWindowAndNoOpeningTrade() public {
        vm.expectRevert(RoundRegistry.OutsideOpeningWindow.selector);
        registry.recordOpening{value: 1}(id, evidence(100_000, START));
        vm.warp(START);
        assertEq(uint8(registry.phase(id)), uint8(RoundRegistry.Phase.OpeningPending));
        assertFalse(registry.canTrade(id));
        vm.warp(START + 30);
        registry.recordOpening{value: 1}(id, evidence(100_000, START + 10));
        assertTrue(registry.canTrade(id));
        assertEq(oracle.lastBoundary(), START);
        assertEq(oracle.lastMaximum(), START + 10);
        assertEq(address(registry).balance, 0);
        assertEq(address(oracle).balance, 1);
    }

    function testOpeningTooLateCannotChangeTimeoutOutcome() public {
        vm.warp(START + 31);
        vm.expectRevert(RoundRegistry.OutsideOpeningWindow.selector);
        registry.recordOpening{value: 1}(id, evidence(100_000, START));
        assertEq(uint8(registry.phase(id)), uint8(RoundRegistry.Phase.Voidable));
        registry.voidRound(id);
        assertEq(uint8(registry.getRound(id).outcome), uint8(RoundRegistry.Outcome.Void));
    }

    function testOpeningImmutable() public {
        open();
        vm.expectRevert(RoundRegistry.OpeningAlreadyRecorded.selector);
        registry.recordOpening{value: 1}(id, evidence(200_000, START));
        assertEq(registry.getRound(id).opening.price, 100_000);
    }

    function testCanonicalCutoffExactEquality() public {
        open();
        vm.warp(START + 269);
        assertTrue(registry.canTrade(id));
        vm.warp(START + 270);
        assertFalse(registry.canTrade(id));
        assertEq(uint8(registry.phase(id)), uint8(RoundRegistry.Phase.Closed));
        vm.warp(START + 300);
        assertEq(uint8(registry.phase(id)), uint8(RoundRegistry.Phase.ResolutionPending));
    }

    function testTieResolvesUpAndCannotRewrite() public {
        open();
        vm.warp(START + 300);
        registry.resolveRound{value: 1}(id, evidence(100_000, START + 300));
        assertEq(uint8(registry.getRound(id).outcome), uint8(RoundRegistry.Outcome.Up));
        assertEq(uint8(registry.phase(id)), uint8(RoundRegistry.Phase.Resolved));
        (uint8 up, uint8 down, uint8 denominator) = registry.payoutNumerators(id);
        assertEq(up, 2);
        assertEq(down, 0);
        assertEq(denominator, 2);
        vm.expectRevert(RoundRegistry.AlreadyFinalized.selector);
        registry.resolveRound{value: 1}(id, evidence(1, START + 300));
        vm.warp(START + 400);
        vm.expectRevert(RoundRegistry.AlreadyFinalized.selector);
        registry.voidRound(id);
    }

    function testDownResolvesAndResolutionDeadlineEquality() public {
        open();
        vm.warp(START + 370);
        vm.expectRevert(RoundRegistry.TimeoutNotReached.selector);
        registry.voidRound(id);
        registry.resolveRound{value: 1}(id, evidence(99_999, START + 310));
        (uint8 up, uint8 down, uint8 denominator) = registry.payoutNumerators(id);
        assertEq(up, 0);
        assertEq(down, 2);
        assertEq(denominator, 2);
        assertEq(oracle.lastBoundary(), START + 300);
    }

    function testCannotResolveEarlyOrWithoutOpening() public {
        vm.warp(START + 300);
        vm.expectRevert(RoundRegistry.OpeningMissing.selector);
        registry.resolveRound{value: 1}(id, evidence(1, START + 300));
        open();
        vm.warp(START + 299);
        vm.expectRevert(RoundRegistry.OutsideResolutionWindow.selector);
        registry.resolveRound{value: 1}(id, evidence(100_000, START + 300));
    }

    function testTimeoutAfterOpeningAndNoLateResolution() public {
        open();
        vm.warp(START + 371);
        assertEq(uint8(registry.phase(id)), uint8(RoundRegistry.Phase.Voidable));
        vm.expectRevert(RoundRegistry.OutsideResolutionWindow.selector);
        registry.resolveRound{value: 1}(id, evidence(100_001, START + 300));
        registry.voidRound(id);
        (uint8 up, uint8 down, uint8 denominator) = registry.payoutNumerators(id);
        assertEq(up, 1);
        assertEq(down, 1);
        assertEq(denominator, 2);
        assertFalse(registry.canTrade(id));
        assertEq(uint8(registry.phase(id)), uint8(RoundRegistry.Phase.Voided));
        vm.expectRevert(RoundRegistry.AlreadyFinalized.selector);
        registry.voidRound(id);
    }

    function testOpeningTimeoutStrictEquality() public {
        vm.warp(START + 30);
        vm.expectRevert(RoundRegistry.TimeoutNotReached.selector);
        registry.voidRound(id);
        vm.warp(START + 31);
        registry.voidRound(id);
        vm.expectRevert(RoundRegistry.AlreadyFinalized.selector);
        registry.recordOpening{value: 1}(id, evidence(100_000, START));
    }

    function testRejectObservationPriceExponentConfidenceAndTime() public {
        vm.warp(START + 10);
        rejectObservation(IBoundaryOracle.Observation(0, 0, -8, START));
        rejectObservation(IBoundaryOracle.Observation(-1, 0, -8, START));
        rejectObservation(IBoundaryOracle.Observation(100_000, 0, -7, START));
        rejectObservation(IBoundaryOracle.Observation(100_000, 1001, -8, START));
        rejectObservation(IBoundaryOracle.Observation(100_000, 0, -8, START - 1));
        rejectObservation(IBoundaryOracle.Observation(100_000, 0, -8, START + 11));
        vm.warp(START);
        rejectObservation(IBoundaryOracle.Observation(100_000, 0, -8, START + 1));
        registry.recordOpening{value: 1}(
            id, abi.encode(IBoundaryOracle.Observation(100_000, 1000, -8, START))
        );
        assertEq(registry.getRound(id).opening.confidence, 1000);
    }

    function rejectObservation(IBoundaryOracle.Observation memory observation) internal {
        vm.expectRevert(RoundRegistry.InvalidObservation.selector);
        registry.recordOpening{value: 1}(id, abi.encode(observation));
        assertEq(registry.getRound(id).openedAt, 0);
        assertEq(address(registry).balance, 0);
    }

    function testWrongFeesAndOracleRevertAreAtomic() public {
        vm.warp(START);
        vm.expectRevert(abi.encodeWithSelector(RoundRegistry.IncorrectFee.selector, 1, 0));
        registry.recordOpening(id, evidence(100_000, START));
        vm.expectRevert(abi.encodeWithSelector(RoundRegistry.IncorrectFee.selector, 1, 2));
        registry.recordOpening{value: 2}(id, evidence(100_000, START));
        oracle.setFailure(true);
        vm.expectRevert("test oracle unavailable");
        registry.recordOpening{value: 1}(id, evidence(100_000, START));
        assertEq(registry.getRound(id).openedAt, 0);
        assertEq(address(oracle).balance, 0);
    }

    function testReentrantOracleCannotRecordAgain() public {
        vm.warp(START);
        oracle.setReentry(address(registry), abi.encodeCall(registry.recordOpening, (id, evidence(2, START))));
        registry.recordOpening{value: 1}(id, evidence(100_000, START));
        assertFalse(oracle.reentrySucceeded());
        assertEq(registry.getRound(id).opening.price, 100_000);
    }

    function testUnknownRoundAndNoArbitraryETH() public {
        bytes32 missing = keccak256("missing");
        assertEq(uint8(registry.phase(missing)), uint8(RoundRegistry.Phase.Missing));
        assertFalse(registry.canTrade(missing));
        vm.expectRevert(abi.encodeWithSelector(RoundRegistry.UnknownRound.selector, missing));
        registry.getRound(missing);
        (bool ok,) = address(registry).call{value: 1}("");
        assertFalse(ok);
        (uint8 up, uint8 down, uint8 denominator) = registry.payoutNumerators(id);
        assertEq(up, 0);
        assertEq(down, 0);
        assertEq(denominator, 0);
    }

    function testFuzzPositivePricesDetermineOnlyComparison(uint64 rawOpen, uint64 rawClose) public {
        int64 startPrice = int64(uint64(bound(rawOpen, 1, uint64(type(int64).max))));
        int64 endPrice = int64(uint64(bound(rawClose, 1, uint64(type(int64).max))));
        vm.warp(START);
        registry.recordOpening{value: 1}(id, evidence(startPrice, START));
        vm.warp(START + 300);
        registry.resolveRound{value: 1}(id, evidence(endPrice, START + 300));
        RoundRegistry.Outcome expected =
            endPrice >= startPrice ? RoundRegistry.Outcome.Up : RoundRegistry.Outcome.Down;
        assertEq(uint8(registry.getRound(id).outcome), uint8(expected));
        (uint8 up, uint8 down, uint8 denominator) = registry.payoutNumerators(id);
        assertEq(uint256(up) + down, denominator);
    }

    function testFuzzScheduleAlwaysAlignedAndImmutable(uint32 offset, bool eth, bool fifteen) public {
        uint32 duration = fifteen ? 900 : 300;
        uint64 start = START + uint64(bound(offset, 1, 10_000)) * 900;
        RoundRegistry.Asset asset = eth ? RoundRegistry.Asset.ETH : RoundRegistry.Asset.BTC;
        bytes32 roundId = registry.createRound(asset, duration, start);
        RoundRegistry.Round memory round = registry.getRound(roundId);
        assertEq(round.start % duration, 0);
        assertLt(round.openingDeadline, round.cutoff);
        assertLt(round.cutoff, round.end);
        assertGt(round.resolutionDeadline, round.end);
        assertEq(round.duration, duration);
    }
}
