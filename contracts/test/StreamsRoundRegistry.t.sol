// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {
    OwnableUpgradeable
} from "../node_modules/@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {HorizenStreamsOracle} from "../src/HorizenStreamsOracle.sol";
import {StreamsRoundRegistry} from "../src/StreamsRoundRegistry.sol";
import {IStreamsObservationReceiver} from "../src/interfaces/INativeOracleMessenger.sol";
import {IStreamsBoundaryOracle} from "../src/interfaces/IStreamsBoundaryOracle.sol";
import {IStreamsObservationCache} from "../src/interfaces/IStreamsObservationCache.sol";
import {StreamsOracleRoute} from "../src/libraries/StreamsOracleRoute.sol";
import {MockStreamsBoundaryOracle, StreamsRegistryProxy} from "./mocks/MockStreamsBoundaryOracle.sol";
import {MockCollateral} from "./mocks/MockBoundaryOracle.sol";
import {NativeMessengerFixture} from "./NativeStreamsRouting.t.sol";

/// @dev TEST ONLY next implementation: identical storage and rules plus one new function.
contract StreamsRoundRegistryUpgradeFixture is StreamsRoundRegistry {
    function upgradeMarker() external pure returns (uint256) {
        return 2;
    }
}

contract StreamsRoundRegistryTest is Test {
    uint32 internal constant START = 1_800_000_000;
    // end + observationWindow + voidGrace of the five-minute round under the fixture rules.
    uint32 internal constant VOIDABLE_AFTER = START + 300 + 10 + 1 days;
    bytes32 internal constant BTC = bytes32((uint256(3) << 240) | 1);
    bytes32 internal constant ETH = bytes32((uint256(3) << 240) | 2);
    address internal constant OWNER = address(0x0111E4);
    MockStreamsBoundaryOracle internal oracle;
    StreamsRoundRegistry internal implementation;
    StreamsRoundRegistry internal registry;
    StreamsRoundRegistry.Config internal config;
    bytes32 internal id;

    function setUp() public {
        vm.warp(START - 600);
        vm.deal(address(this), 100 ether);
        oracle = new MockStreamsBoundaryOracle();
        config = StreamsRoundRegistry.Config(
            address(oracle), address(new MockCollateral()), BTC, ETH, 18, 18, 10, 20, 1 days, 30
        );
        implementation = new StreamsRoundRegistry();
        registry = proxy(config);
        id = registry.createRound(StreamsRoundRegistry.Asset.BTC, 300, START);
    }

    function proxy(StreamsRoundRegistry.Config memory value) internal returns (StreamsRoundRegistry) {
        bytes memory setup = abi.encodeCall(StreamsRoundRegistry.initialize, (value, OWNER));
        return StreamsRoundRegistry(address(new ERC1967Proxy(address(implementation), setup)));
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
        assertEq(registry.version(), "zedge-streams-round-registry-v2");
        assertEq(address(registry.oracle()), address(oracle));
        assertEq(registry.collateral(), config.collateral);
        assertEq(registry.btcFeedId(), BTC);
        assertEq(registry.ethFeedId(), ETH);
        assertEq(registry.btcDecimals(), 18);
        assertEq(registry.ethDecimals(), 18);
        assertEq(registry.observationWindow(), 10);
        assertEq(registry.openingGrace(), 20);
        assertEq(registry.voidGrace(), 1 days);
        assertEq(registry.cutoffBuffer(), 30);
        assertEq(registry.deploymentChainId(), block.chainid);
        assertEq(registry.owner(), OWNER);
        assertEq(
            registry.rulesHash(),
            keccak256(
                abi.encode(
                    "zedge-streams-rounds-v2:schema3:boundary-window:exact-price:no-confidence:tie-up:late-resolution:void-half",
                    block.chainid,
                    config
                )
            )
        );
        assertEq(id, registry.roundIdFor(StreamsRoundRegistry.Asset.BTC, 300, START));
        // The documented formula, recomputed without roundIdFor: chain, proxy, rules, asset, duration, start.
        assertEq(
            id,
            keccak256(
                abi.encode(
                    block.chainid,
                    address(registry),
                    registry.rulesHash(),
                    StreamsRoundRegistry.Asset.BTC,
                    uint32(300),
                    uint64(START)
                )
            )
        );
        StreamsRoundRegistry.Round memory round = registry.getRound(id);
        assertEq(round.start, START);
        assertEq(round.end, START + 300);
        assertEq(round.cutoff, START + 270);
        assertEq(round.openingDeadline, START + 30);
        assertEq(round.voidableAfter, VOIDABLE_AFTER);
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
        // A second proxy of the same implementation is a different registry: the ID binds the proxy.
        StreamsRoundRegistry other = proxy(config);
        assertEq(other.rulesHash(), registry.rulesHash());
        assertTrue(id != other.roundIdFor(StreamsRoundRegistry.Asset.BTC, 300, START));
        vm.chainId(2651420);
        oracle.configure(BTC, ETH, 18, 18, 10, 2651420);
        StreamsRoundRegistry testnet = proxy(config);
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
        bad.voidGrace = 2 minutes - 1;
        assertInvalidConfig(bad);
        bad = config;
        bad.observationWindow = 250;
        assertInvalidConfig(bad);
        bad = config;
        bad.observationWindow = 61;
        assertInvalidConfig(bad);
        bad = config;
        bad.voidGrace = 21 days + 1;
        assertInvalidConfig(bad);
        bad = config;
        bad.btcFeedId = keccak256("wrong-schema");
        assertInvalidConfig(bad);
        // The accepted void grace is exactly 2 minutes to 21 days.
        bad = config;
        bad.voidGrace = 2 minutes;
        assertEq(proxy(bad).voidGrace(), 120);
        bad.voidGrace = 21 days;
        assertEq(proxy(bad).voidGrace(), 21 days);
    }

    function testInvalidETHFeedAndOpeningDeadlineAtCutoff() public {
        StreamsRoundRegistry.Config memory bad = config;
        bad.ethFeedId = bytes32(0);
        assertInvalidConfig(bad);
        // A well-formed ID of another report schema: only the two-byte prefix is wrong.
        bad = config;
        bad.ethFeedId = bytes32((uint256(4) << 240) | 2);
        assertInvalidConfig(bad);
        // window 10 + grace 260 = 270 = 300 - cutoffBuffer: the opening deadline would reach the cutoff.
        bad = config;
        bad.openingGrace = 260;
        assertInvalidConfig(bad);
        bad.openingGrace = 259;
        assertEq(proxy(bad).openingGrace(), 259);
    }

    function testInitializeRejectsCacheThatDisagreesWithConfig() public {
        bytes32 other = bytes32((uint256(3) << 240) | 9);
        assertCacheRejected(other, ETH, 18, 18, 10, block.chainid);
        assertCacheRejected(BTC, other, 18, 18, 10, block.chainid);
        assertCacheRejected(BTC, ETH, 8, 18, 10, block.chainid);
        assertCacheRejected(BTC, ETH, 18, 8, 10, block.chainid);
        assertCacheRejected(BTC, ETH, 18, 18, 60, block.chainid);
        assertCacheRejected(BTC, ETH, 18, 18, 10, block.chainid + 1);
        // An entry at the undeliverable boundary 1 means reportHash is not this cache's absence marker.
        oracle.setCached(BTC, 1, abi.decode(evidence(1, 1), (IStreamsBoundaryOracle.Observation)));
        assertCacheRejected(BTC, ETH, 18, 18, 10, block.chainid);
        IStreamsBoundaryOracle.Observation memory empty;
        oracle.setCached(BTC, 1, empty);
        oracle.configure(BTC, ETH, 18, 18, 10, block.chainid);
        assertEq(address(proxy(config).oracle()), address(oracle));
    }

    /// @dev The valid fixture config against a cache reporting the given, different, values.
    function assertCacheRejected(
        bytes32 btc,
        bytes32 eth,
        uint8 btcScale,
        uint8 ethScale,
        uint32 window,
        uint256 chain
    ) internal {
        oracle.configure(btc, eth, btcScale, ethScale, window, chain);
        bytes memory setup = abi.encodeCall(StreamsRoundRegistry.initialize, (config, OWNER));
        vm.expectRevert(StreamsRoundRegistry.InvalidConfig.selector);
        new ERC1967Proxy(address(implementation), setup);
    }

    function testInitializeRejectsUnreadableCacheZeroOwnerAndSecondCall() public {
        bytes memory setup = abi.encodeCall(StreamsRoundRegistry.initialize, (config, OWNER));
        vm.mockCallRevert(
            address(oracle), abi.encodeWithSelector(IStreamsObservationCache.getObservation.selector), "down"
        );
        vm.expectRevert(bytes("down"));
        new ERC1967Proxy(address(implementation), setup);
        vm.clearMockedCalls();
        // A contract with code that is not a price cache at all.
        StreamsRoundRegistry.Config memory bad = config;
        bad.oracle = config.collateral;
        vm.expectRevert();
        new ERC1967Proxy(
            address(implementation), abi.encodeCall(StreamsRoundRegistry.initialize, (bad, OWNER))
        );
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableInvalidOwner.selector, address(0)));
        new ERC1967Proxy(
            address(implementation), abi.encodeCall(StreamsRoundRegistry.initialize, (config, address(0)))
        );
        // Neither the implementation nor an initialised proxy accepts initialize, even from the owner.
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        implementation.initialize(config, address(this));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        registry.initialize(config, address(this));
        vm.prank(OWNER);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        registry.initialize(config, address(this));
        assertEq(registry.owner(), OWNER);
        assertEq(implementation.owner(), address(0));
        assertEq(implementation.rulesHash(), bytes32(0));
    }

    /// @dev The cache fixture is made to agree with `bad`, so only the registry's own range checks reject.
    function assertInvalidConfig(StreamsRoundRegistry.Config memory bad) internal {
        oracle.configure(
            bad.btcFeedId,
            bad.ethFeedId,
            bad.btcDecimals,
            bad.ethDecimals,
            bad.observationWindow,
            block.chainid
        );
        bytes memory setup = abi.encodeCall(StreamsRoundRegistry.initialize, (bad, OWNER));
        vm.expectRevert(StreamsRoundRegistry.InvalidConfig.selector);
        new ERC1967Proxy(address(implementation), setup);
        oracle.configure(BTC, ETH, 18, 18, 10, block.chainid);
    }

    function testOnlyOwnerCanUpgradeAndOnlyThroughTheProxy() public {
        address next = address(new StreamsRoundRegistryUpgradeFixture());
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, address(this))
        );
        registry.upgradeToAndCall(next, "");
        // The implementation itself cannot be upgraded.
        vm.expectRevert(UUPSUpgradeable.UUPSUnauthorizedCallContext.selector);
        implementation.upgradeToAndCall(next, "");
        vm.startPrank(OWNER);
        vm.expectRevert(
            abi.encodeWithSelector(ERC1967Utils.ERC1967InvalidImplementation.selector, config.collateral)
        );
        registry.upgradeToAndCall(config.collateral, "");
        registry.upgradeToAndCall(next, "");
        vm.stopPrank();
        assertEq(implementationOf(registry), next);
    }

    function testUpgradePreservesRoundsRulesOwnerAndKeepsWorking() public {
        bytes32 pending = registry.createRound(StreamsRoundRegistry.Asset.ETH, 900, START);
        open();
        registry.recordOpening(pending, evidence(20_000, START));
        vm.warp(START + 300);
        registry.resolveRound(id, evidence(99_999, START + 300));
        bytes memory resolvedBefore = abi.encode(registry.getRound(id));
        bytes memory pendingBefore = abi.encode(registry.getRound(pending));
        bytes32 rules = registry.rulesHash();
        assertEq(implementationOf(registry), address(implementation));

        address next = address(new StreamsRoundRegistryUpgradeFixture());
        vm.prank(OWNER);
        registry.upgradeToAndCall(next, "");

        assertEq(implementationOf(registry), next);
        assertEq(StreamsRoundRegistryUpgradeFixture(address(registry)).upgradeMarker(), 2);
        assertEq(abi.encode(registry.getRound(id)), resolvedBefore);
        assertEq(abi.encode(registry.getRound(pending)), pendingBefore);
        assertEq(registry.rulesHash(), rules);
        assertEq(registry.owner(), OWNER);
        assertEq(address(registry.oracle()), address(oracle));
        assertEq(registry.voidGrace(), 1 days);
        assertEq(registry.roundIdFor(StreamsRoundRegistry.Asset.BTC, 300, START), id);
        (uint8 up, uint8 down,) = registry.payoutNumerators(id);
        assertEq(up, 0);
        assertEq(down, 2);
        // The round opened before the upgrade resolves after it; the upgrade cannot be re-initialised.
        vm.warp(START + 900);
        registry.resolveRound(pending, evidence(20_000, START + 900));
        assertEq(uint8(registry.getRound(pending).outcome), uint8(StreamsRoundRegistry.Outcome.Up));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        registry.initialize(config, address(this));
    }

    function testOwnershipTransferIsTwoStepAndCannotBeRenounced() public {
        address successor = address(0x5CCE5504);
        address next = address(new StreamsRoundRegistryUpgradeFixture());
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, address(this))
        );
        registry.transferOwnership(successor);
        vm.prank(OWNER);
        registry.transferOwnership(successor);
        assertEq(registry.owner(), OWNER);
        assertEq(registry.pendingOwner(), successor);
        vm.prank(successor);
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, successor)
        );
        registry.upgradeToAndCall(next, "");
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, address(this))
        );
        registry.acceptOwnership();
        vm.prank(successor);
        registry.acceptOwnership();
        assertEq(registry.owner(), successor);
        assertEq(registry.pendingOwner(), address(0));
        vm.prank(OWNER);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, OWNER));
        registry.upgradeToAndCall(next, "");
        // Nobody can renounce: one mistaken call must not remove the upgrade path for good.
        vm.expectRevert(StreamsRoundRegistry.RenounceDisabled.selector);
        registry.renounceOwnership();
        vm.startPrank(successor);
        vm.expectRevert(StreamsRoundRegistry.RenounceDisabled.selector);
        registry.renounceOwnership();
        assertEq(registry.owner(), successor);
        registry.upgradeToAndCall(next, "");
        vm.stopPrank();
        assertEq(implementationOf(registry), next);
    }

    function implementationOf(StreamsRoundRegistry target) internal view returns (address) {
        return address(uint160(uint256(vm.load(address(target), ERC1967Utils.IMPLEMENTATION_SLOT))));
    }

    /// @dev The raw slots a deployed proxy holds. An implementation that inserts, removes or reorders a
    /// state variable or a Round/Observation field moves them while every ABI-level test still passes,
    /// and upgrading to it would strand the existing rounds. Change this test only for an appended slot.
    function testProxyStorageLayoutIsPinned() public {
        oracle.configure(BTC, ETH, 18, 8, 10, block.chainid);
        StreamsRoundRegistry.Config memory mixed = config;
        mixed.ethDecimals = 8;
        StreamsRoundRegistry other = proxy(mixed);
        address target = address(other);
        bytes32 eth = other.createRound(StreamsRoundRegistry.Asset.ETH, 900, START);
        IStreamsBoundaryOracle.Observation memory opening =
            IStreamsBoundaryOracle.Observation(7, START - 1, START + 2, START + 3, keccak256("opening"), 8);
        IStreamsBoundaryOracle.Observation memory closing = IStreamsBoundaryOracle.Observation(
            6, START + 4, START + 905, START + 906, keccak256("closing"), 8
        );
        vm.warp(START + 5);
        other.recordOpening(eth, abi.encode(opening));
        vm.warp(START + 909);
        other.resolveRound(eth, abi.encode(closing));
        // Slot 0: oracle | btcDecimals | ethDecimals | observationWindow | openingGrace.
        assertEq(
            stored(target, 0),
            uint256(uint160(address(oracle))) | (18 << 160) | (8 << 168) | (10 << 176) | (20 << 208)
        );
        // Slot 1: collateral | voidGrace | cutoffBuffer.
        assertEq(
            stored(target, 1), uint256(uint160(config.collateral)) | (uint256(1 days) << 160) | (30 << 192)
        );
        assertEq(stored(target, 2), uint256(BTC));
        assertEq(stored(target, 3), uint256(ETH));
        assertEq(stored(target, 4), block.chainid);
        assertEq(stored(target, 5), uint256(other.rulesHash()));
        // Slot 6 is the root of the rounds mapping; slots 7-49 are the gap.
        for (uint256 index = 6; index < 50; ++index) {
            assertEq(stored(target, index), 0);
        }
        uint256 base = uint256(keccak256(abi.encode(eth, uint256(6))));
        // Round slot 0: asset | duration | start | end | cutoff.
        assertEq(
            stored(target, base),
            1 | (900 << 8) | (uint256(START) << 40) | (uint256(START + 900) << 104)
                | (uint256(START + 870) << 168)
        );
        // Round slot 1: openingDeadline | voidableAfter | openedAt | resolvedAt.
        assertEq(
            stored(target, base + 1),
            uint256(START + 30) | (uint256(START + 910 + 1 days) << 64) | (uint256(START + 5) << 128)
                | (uint256(START + 909) << 192)
        );
        assertEq(stored(target, base + 2), uint8(StreamsRoundRegistry.Outcome.Down));
        // Each observation: price | validFromTimestamp | observationsTimestamp, expiresAt, reportHash, decimals.
        assertEq(stored(target, base + 3), 7 | (uint256(START - 1) << 192) | (uint256(START + 2) << 224));
        assertEq(stored(target, base + 4), START + 3);
        assertEq(stored(target, base + 5), uint256(keccak256("opening")));
        assertEq(stored(target, base + 6), 8);
        assertEq(stored(target, base + 7), 6 | (uint256(START + 4) << 192) | (uint256(START + 905) << 224));
        assertEq(stored(target, base + 8), START + 906);
        assertEq(stored(target, base + 9), uint256(keccak256("closing")));
        assertEq(stored(target, base + 10), 8);
        assertEq(stored(target, base + 11), 0);
    }

    function stored(address target, uint256 index) internal view returns (uint256) {
        return uint256(vm.load(target, bytes32(index)));
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
        assertEq(registry.getRound(id).openedAt, START + 30);
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
        vm.expectEmit(address(registry));
        emit StreamsRoundRegistry.RoundResolved(
            id,
            StreamsRoundRegistry.Outcome.Up,
            100_000,
            START + 300,
            keccak256(abi.encode(int192(100_000), START + 300))
        );
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

    function testDownResolvesAndVoidableAfterEquality() public {
        open();
        vm.warp(VOIDABLE_AFTER);
        assertEq(uint8(registry.phase(id)), uint8(StreamsRoundRegistry.Phase.ResolutionPending));
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
        vm.expectRevert(StreamsRoundRegistry.RoundNotEnded.selector);
        registry.resolveRound(id, evidence(100_000, START + 300));
    }

    function testTimeoutAfterOpeningWithoutClosingObservation() public {
        open();
        vm.warp(VOIDABLE_AFTER + 1);
        assertEq(uint8(registry.phase(id)), uint8(StreamsRoundRegistry.Phase.Voidable));
        vm.expectEmit(address(registry));
        emit StreamsRoundRegistry.RoundVoided(id, false);
        registry.voidRound(id);
        assertEq(registry.getRound(id).resolvedAt, VOIDABLE_AFTER + 1);
        (uint8 up, uint8 down, uint8 denominator) = registry.payoutNumerators(id);
        assertEq(up, 1);
        assertEq(down, 1);
        assertEq(denominator, 2);
        assertFalse(registry.canTrade(id));
        assertEq(uint8(registry.phase(id)), uint8(StreamsRoundRegistry.Phase.Voided));
        vm.expectRevert(StreamsRoundRegistry.AlreadyFinalized.selector);
        registry.voidRound(id);
        vm.expectRevert(StreamsRoundRegistry.AlreadyFinalized.selector);
        registry.resolveRound(id, evidence(100_001, START + 300));
    }

    function testLateResolutionHasNoDeadline() public {
        open();
        // Six days after the end: far beyond the retired registry's one-hour resolution window.
        // It is also past this fixture's one-day void grace: an unvoided round still resolves.
        vm.warp(START + 300 + 6 days);
        assertEq(uint8(registry.phase(id)), uint8(StreamsRoundRegistry.Phase.Voidable));
        registry.resolveRound(id, evidence(99_999, START + 300));
        assertEq(uint8(registry.getRound(id).outcome), uint8(StreamsRoundRegistry.Outcome.Down));
        assertEq(registry.getRound(id).resolvedAt, START + 300 + 6 days);
        assertEq(uint8(registry.phase(id)), uint8(StreamsRoundRegistry.Phase.Resolved));
    }

    function testCachedClosingBlocksVoidAndSelectsTheRoundFeed() public {
        bytes32 eth = registry.createRound(StreamsRoundRegistry.Asset.ETH, 300, START);
        open();
        registry.recordOpening(eth, evidence(20_000, START));
        // Only the BTC closing price reached the cache.
        oracle.setCached(
            BTC, START + 300, abi.decode(evidence(99_999, START + 300), (IStreamsBoundaryOracle.Observation))
        );
        vm.warp(VOIDABLE_AFTER + 1);
        assertEq(uint8(registry.phase(id)), uint8(StreamsRoundRegistry.Phase.ResolutionPending));
        assertEq(uint8(registry.phase(eth)), uint8(StreamsRoundRegistry.Phase.Voidable));
        vm.expectRevert(StreamsRoundRegistry.ClosingEvidenceAvailable.selector);
        registry.voidRound(id);
        registry.voidRound(eth);
        assertEq(uint8(registry.getRound(eth).outcome), uint8(StreamsRoundRegistry.Outcome.Void));
        registry.resolveRound(id, evidence(99_999, START + 300));
        assertEq(uint8(registry.getRound(id).outcome), uint8(StreamsRoundRegistry.Outcome.Down));
    }

    function testReentrantOracleCannotVoidDuringResolution() public {
        open();
        vm.warp(VOIDABLE_AFTER + 1);
        // Without the guard this nested void would succeed and the outer call would then overwrite it.
        oracle.setReentry(address(registry), abi.encodeCall(registry.voidRound, (id)));
        registry.resolveRound(id, evidence(100_000, START + 300));
        assertFalse(oracle.reentrySucceeded());
        assertEq(uint8(registry.getRound(id).outcome), uint8(StreamsRoundRegistry.Outcome.Up));
    }

    function testReentrancyGuardNeedsNoInitialisationBehindTheProxy() public {
        // OpenZeppelin 5.6.1 keeps the guard in this ERC-7201 slot and sets it to 1 in a constructor,
        // which only runs for the implementation. The proxy starts at 0, which is also "not entered".
        bytes32 slot = 0x9b779b17422d0df92223018b32b4d1fa46e071723d6817e2486d003becc55f00;
        assertEq(vm.load(address(implementation), slot), bytes32(uint256(1)));
        assertEq(vm.load(address(registry), slot), bytes32(0));
        vm.warp(START);
        oracle.setReentry(address(registry), abi.encodeCall(registry.recordOpening, (id, evidence(2, START))));
        registry.recordOpening(id, evidence(100_000, START));
        assertFalse(oracle.reentrySucceeded());
        assertEq(registry.getRound(id).opening.price, 100_000);
        assertEq(vm.load(address(registry), slot), bytes32(uint256(1)));
    }

    function testEachAssetUsesItsOwnDecimals() public {
        oracle.configure(BTC, ETH, 18, 8, 10, block.chainid);
        StreamsRoundRegistry.Config memory mixed = config;
        mixed.ethDecimals = 8;
        StreamsRoundRegistry other = proxy(mixed);
        bytes32 btc = other.createRound(StreamsRoundRegistry.Asset.BTC, 300, START);
        bytes32 eth = other.createRound(StreamsRoundRegistry.Asset.ETH, 300, START);
        IStreamsBoundaryOracle.Observation memory eight =
            abi.decode(evidence(100_000, START), (IStreamsBoundaryOracle.Observation));
        eight.decimals = 8;
        vm.warp(START);
        vm.expectRevert(StreamsRoundRegistry.InvalidObservation.selector);
        other.recordOpening(btc, abi.encode(eight));
        vm.expectRevert(StreamsRoundRegistry.InvalidObservation.selector);
        other.recordOpening(eth, evidence(100_000, START));
        other.recordOpening(btc, evidence(100_000, START));
        other.recordOpening(eth, abi.encode(eight));
        assertEq(other.getRound(btc).opening.decimals, 18);
        assertEq(other.getRound(eth).opening.decimals, 8);
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
        vm.expectEmit(address(registry));
        emit StreamsRoundRegistry.RoundResolved(
            id,
            StreamsRoundRegistry.Outcome.Down,
            100_000e18 - 1,
            START + 300,
            keccak256(abi.encode(int192(100_000e18 - 1), START + 300))
        );
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
        // An ID that was never created has zero deadlines: without this guard it could be voided early
        // and would later be created already Void.
        vm.warp(START);
        vm.expectRevert(abi.encodeWithSelector(StreamsRoundRegistry.UnknownRound.selector, missing));
        registry.voidRound(missing);
        vm.expectRevert(abi.encodeWithSelector(StreamsRoundRegistry.UnknownRound.selector, missing));
        registry.recordOpening(missing, evidence(100_000, START));
        vm.expectRevert(abi.encodeWithSelector(StreamsRoundRegistry.UnknownRound.selector, missing));
        registry.resolveRound(missing, evidence(100_000, START));
        vm.expectRevert(abi.encodeWithSelector(StreamsRoundRegistry.UnknownRound.selector, missing));
        registry.payoutNumerators(missing);
        (bool ok,) = address(registry).call("");
        assertFalse(ok);
        (ok,) = address(registry).call{value: 1}("");
        assertFalse(ok);
        assertEq(address(registry).balance, 0);
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
        assertEq(round.voidableAfter, round.end + 10 + 1 days);
        assertEq(round.duration, duration);
    }
}

/// @notice The new void and late-resolution rules against the real price cache with the mainnet timing
/// (60 / 150 / 30) and a seven-day void grace; the `PlannedProfile` tests use the planned five-minute grace.
/// Only the native messenger is a fixture.
contract StreamsRoundRegistryCacheTest is Test {
    uint32 internal constant START = 1_800_000_000;
    uint32 internal constant END = START + 300;
    uint32 internal constant VOIDABLE_AFTER = END + 60 + 7 days;
    uint32 internal constant PLANNED_VOIDABLE_AFTER = END + 60 + 5 minutes;
    bytes32 internal constant BTC = bytes32((uint256(3) << 240) | 1);
    bytes32 internal constant ETH = bytes32((uint256(3) << 240) | 2);
    address internal constant PUBLISHER = address(0xBA5E);
    address internal constant LOSER = address(0x105E4);
    NativeMessengerFixture internal messenger;
    HorizenStreamsOracle internal cache;
    StreamsRoundRegistry internal registry;
    bytes32 internal id;

    function setUp() public {
        vm.chainId(26514);
        vm.warp(START - 600);
        messenger = new NativeMessengerFixture();
        messenger.configure(address(0xCAFE));
        cache = new HorizenStreamsOracle(
            StreamsOracleRoute.Config({
                sourceChainId: 8453,
                destinationChainId: 26514,
                sourceMessenger: address(0xCAFE),
                destinationMessenger: address(messenger),
                sourceOracle: address(0x0AC1E),
                publisher: PUBLISHER,
                destinationOracle: vm.computeCreateAddress(address(this), vm.getNonce(address(this))),
                btcFeedId: BTC,
                ethFeedId: ETH,
                btcDecimals: 18,
                ethDecimals: 18,
                observationWindow: 60,
                minimumGasLimit: 600_000
            })
        );
        registry = deploy(7 days);
        id = registry.createRound(StreamsRoundRegistry.Asset.BTC, 300, START);
    }

    function deploy(uint32 voidGrace) internal returns (StreamsRoundRegistry) {
        return StreamsRegistryProxy.deploy(
            StreamsRoundRegistry.Config(
                address(cache), address(new MockCollateral()), BTC, ETH, 18, 18, 60, 150, voidGrace, 30
            ),
            address(this)
        );
    }

    /// @dev The planned mainnet profile: void grace 300 seconds, so voidableAfter is end + 360.
    function usePlannedProfile() internal {
        registry = deploy(5 minutes);
        id = registry.createRound(StreamsRoundRegistry.Asset.BTC, 300, START);
        assertEq(registry.voidGrace(), 300);
        assertEq(registry.getRound(id).voidableAfter, PLANNED_VOIDABLE_AFTER);
    }

    /// @dev Native delivery of a Base-authenticated observation; may happen any time after the boundary.
    function deliver(bytes32 feed, uint32 boundary, int192 price) internal {
        IStreamsBoundaryOracle.Observation memory observation = IStreamsBoundaryOracle.Observation(
            price, boundary, boundary + 1, boundary + 30, keccak256(abi.encode(feed, boundary, price)), 18
        );
        messenger.relay(
            PUBLISHER,
            address(cache),
            abi.encodeCall(
                IStreamsObservationReceiver.receiveObservation,
                (cache.routeHash(), feed, boundary, observation)
            )
        );
    }

    function open() internal {
        vm.warp(START + 24);
        deliver(BTC, START, 100_000e18);
        registry.recordOpening(id, "");
    }

    function assertPhase(StreamsRoundRegistry.Phase expected) internal view {
        assertEq(uint8(registry.phase(id)), uint8(expected));
    }

    function assertPayout(uint8 expectedUp, uint8 expectedDown) internal view {
        (uint8 up, uint8 down, uint8 denominator) = registry.payoutNumerators(id);
        assertEq(up, expectedUp);
        assertEq(down, expectedDown);
        assertEq(denominator, 2);
    }

    function testScheduleUsesSevenDayVoidGrace() public view {
        StreamsRoundRegistry.Round memory round = registry.getRound(id);
        assertEq(round.openingDeadline, START + 210);
        assertEq(round.cutoff, START + 270);
        assertEq(round.voidableAfter, VOIDABLE_AFTER);
        assertEq(registry.voidGrace(), 604_800);
    }

    function testResolvesSixDaysAfterTheEnd() public {
        open();
        vm.warp(END + 25);
        deliver(BTC, END, 100_000e18 - 1);
        vm.warp(END + 6 days);
        assertPhase(StreamsRoundRegistry.Phase.ResolutionPending);
        vm.prank(LOSER);
        vm.expectRevert(StreamsRoundRegistry.TimeoutNotReached.selector);
        registry.voidRound(id);
        registry.resolveRound(id, "");
        assertPhase(StreamsRoundRegistry.Phase.Resolved);
        assertPayout(0, 2);
        assertEq(registry.getRound(id).closing.price, 100_000e18 - 1);
        assertEq(registry.getRound(id).resolvedAt, END + 6 days);
    }

    function testOpenedRoundIsNotVoidableUntilStrictlyAfterVoidableAfter() public {
        open();
        vm.warp(END);
        assertPhase(StreamsRoundRegistry.Phase.ResolutionPending);
        vm.warp(VOIDABLE_AFTER);
        assertPhase(StreamsRoundRegistry.Phase.ResolutionPending);
        vm.expectRevert(StreamsRoundRegistry.TimeoutNotReached.selector);
        registry.voidRound(id);
        vm.warp(VOIDABLE_AFTER + 1);
        assertPhase(StreamsRoundRegistry.Phase.Voidable);
        vm.prank(LOSER);
        registry.voidRound(id);
        assertPhase(StreamsRoundRegistry.Phase.Voided);
        assertPayout(1, 1);
        // A price that arrives after a recorded void cannot reverse it.
        deliver(BTC, END, 100_000e18 + 1);
        vm.expectRevert(StreamsRoundRegistry.AlreadyFinalized.selector);
        registry.resolveRound(id, "");
    }

    function testCachedClosingPriceMustBeResolvedNotVoided() public {
        open();
        vm.warp(END + 25);
        deliver(BTC, END, 100_000e18);
        vm.warp(VOIDABLE_AFTER + 1);
        assertPhase(StreamsRoundRegistry.Phase.ResolutionPending);
        vm.prank(LOSER);
        vm.expectRevert(StreamsRoundRegistry.ClosingEvidenceAvailable.selector);
        registry.voidRound(id);
        vm.warp(VOIDABLE_AFTER + 365 days);
        assertPhase(StreamsRoundRegistry.Phase.ResolutionPending);
        vm.expectRevert(StreamsRoundRegistry.ClosingEvidenceAvailable.selector);
        registry.voidRound(id);
        registry.resolveRound(id, "");
        assertPayout(2, 0);
    }

    function testClosingPriceArrivingAfterVoidableAfterStillDecidesAnUnvoidedRound() public {
        open();
        vm.warp(VOIDABLE_AFTER + 1 days);
        assertPhase(StreamsRoundRegistry.Phase.Voidable);
        vm.expectRevert(HorizenStreamsOracle.MissingObservation.selector);
        registry.resolveRound(id, "");
        deliver(BTC, END, 100_000e18 - 1);
        assertPhase(StreamsRoundRegistry.Phase.ResolutionPending);
        vm.expectRevert(StreamsRoundRegistry.ClosingEvidenceAvailable.selector);
        registry.voidRound(id);
        registry.resolveRound(id, "");
        assertPayout(0, 2);
    }

    /// @dev Audit D4 under the superseded seven-day grace of this contract's configuration: a holder of the losing
    /// side prices out every Base-to-Horizen delivery for five hours and cannot force a void. The retired registry let
    /// anyone void one hour after the end and pay 1/2 + 1/2. Under the planned five-minute grace D4 is an accepted
    /// risk (owner decision 2026-10-06): see testPlannedProfileVoidsOneSecondAfterVoidableAfterWhenNothingIsCached.
    function testSevenDayGraceBlockedDeliveryCannotForceVoidAndLateClosingResolvesTruthfully() public {
        open();
        vm.warp(END + 3661);
        assertPhase(StreamsRoundRegistry.Phase.ResolutionPending);
        vm.expectRevert(HorizenStreamsOracle.MissingObservation.selector);
        registry.resolveRound(id, "");
        vm.prank(LOSER);
        vm.expectRevert(StreamsRoundRegistry.TimeoutNotReached.selector);
        registry.voidRound(id);
        (,, uint8 denominator) = registry.payoutNumerators(id);
        assertEq(denominator, 0);

        // Delivery resumes five hours late. Up won by one atom.
        vm.warp(END + 5 hours);
        deliver(BTC, END, 100_000e18 + 1);
        vm.prank(LOSER);
        vm.expectRevert(StreamsRoundRegistry.TimeoutNotReached.selector);
        registry.voidRound(id);
        registry.resolveRound(id, "");
        assertEq(uint8(registry.getRound(id).outcome), uint8(StreamsRoundRegistry.Outcome.Up));
        assertPayout(2, 0);
        vm.warp(VOIDABLE_AFTER + 1);
        vm.prank(LOSER);
        vm.expectRevert(StreamsRoundRegistry.AlreadyFinalized.selector);
        registry.voidRound(id);
    }

    function testVoidChecksTheRoundsOwnFeedAndEnd() public {
        bytes32 eth = registry.createRound(StreamsRoundRegistry.Asset.ETH, 300, START);
        open();
        deliver(ETH, START, 3_000e18);
        registry.recordOpening(eth, "");
        vm.warp(END + 25);
        // The ETH closing price and the next BTC boundary are cached; the BTC closing price is not.
        deliver(ETH, END, 3_000e18);
        vm.warp(END + 325);
        deliver(BTC, END + 300, 100_000e18);
        vm.warp(VOIDABLE_AFTER + 1);
        assertEq(uint8(registry.phase(eth)), uint8(StreamsRoundRegistry.Phase.ResolutionPending));
        vm.expectRevert(StreamsRoundRegistry.ClosingEvidenceAvailable.selector);
        registry.voidRound(eth);
        assertPhase(StreamsRoundRegistry.Phase.Voidable);
        registry.voidRound(id);
        assertPayout(1, 1);
    }

    /// @dev Accepted risk of the planned profile: six minutes without a cached closing price, for example
    /// because delivery is blocked, and anyone can void the opened round.
    function testPlannedProfileVoidsOneSecondAfterVoidableAfterWhenNothingIsCached() public {
        usePlannedProfile();
        open();
        vm.warp(PLANNED_VOIDABLE_AFTER);
        assertPhase(StreamsRoundRegistry.Phase.ResolutionPending);
        vm.prank(LOSER);
        vm.expectRevert(StreamsRoundRegistry.TimeoutNotReached.selector);
        registry.voidRound(id);
        vm.warp(PLANNED_VOIDABLE_AFTER + 1);
        assertPhase(StreamsRoundRegistry.Phase.Voidable);
        vm.prank(LOSER);
        registry.voidRound(id);
        assertPhase(StreamsRoundRegistry.Phase.Voided);
        assertPayout(1, 1);
    }

    function testPlannedProfileRefusesVoidWhileTheClosingPriceIsCached() public {
        usePlannedProfile();
        open();
        vm.warp(END + 35);
        deliver(BTC, END, 100_000e18 - 1);
        vm.warp(PLANNED_VOIDABLE_AFTER + 1);
        assertPhase(StreamsRoundRegistry.Phase.ResolutionPending);
        vm.prank(LOSER);
        vm.expectRevert(StreamsRoundRegistry.ClosingEvidenceAvailable.selector);
        registry.voidRound(id);
        registry.resolveRound(id, "");
        assertPayout(0, 2);
    }

    function testPlannedProfileStillResolvesALateClosingPrice() public {
        usePlannedProfile();
        open();
        vm.warp(PLANNED_VOIDABLE_AFTER + 1 hours);
        assertPhase(StreamsRoundRegistry.Phase.Voidable);
        deliver(BTC, END, 100_000e18);
        assertPhase(StreamsRoundRegistry.Phase.ResolutionPending);
        vm.prank(LOSER);
        vm.expectRevert(StreamsRoundRegistry.ClosingEvidenceAvailable.selector);
        registry.voidRound(id);
        registry.resolveRound(id, "");
        assertPayout(2, 0);
        assertEq(registry.getRound(id).resolvedAt, PLANNED_VOIDABLE_AFTER + 1 hours);
    }

    /// @dev Whenever the closing price reaches the cache and however long everyone then waits, the round
    /// cannot be voided and resolves to the true comparison.
    function testFuzzCachedClosingAlwaysResolvesAndNeverVoids(uint32 arrival, uint32 wait, uint192 rawClose)
        public
    {
        int192 closing = int192(uint192(bound(rawClose, 1, uint192(type(int192).max))));
        open();
        vm.warp(END + bound(arrival, 1, 40 days));
        deliver(BTC, END, closing);
        vm.warp(block.timestamp + bound(wait, 0, 365 days));
        vm.prank(LOSER);
        vm.expectRevert(
            block.timestamp > VOIDABLE_AFTER
                ? StreamsRoundRegistry.ClosingEvidenceAvailable.selector
                : StreamsRoundRegistry.TimeoutNotReached.selector
        );
        registry.voidRound(id);
        assertPhase(StreamsRoundRegistry.Phase.ResolutionPending);
        registry.resolveRound(id, "");
        if (closing >= 100_000e18) assertPayout(2, 0);
        else assertPayout(0, 2);
    }
}
