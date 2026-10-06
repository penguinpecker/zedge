// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {HorizenStreamsOracle} from "../src/HorizenStreamsOracle.sol";
import {StreamsRoundRegistry} from "../src/StreamsRoundRegistry.sol";
import {IStreamsObservationReceiver} from "../src/interfaces/INativeOracleMessenger.sol";
import {IStreamsBoundaryOracle} from "../src/interfaces/IStreamsBoundaryOracle.sol";
import {StreamsOracleRoute} from "../src/libraries/StreamsOracleRoute.sol";
import {StreamsRegistryProxy} from "./mocks/MockStreamsBoundaryOracle.sol";
import {MockCollateral} from "./mocks/MockBoundaryOracle.sol";
import {NativeMessengerFixture} from "./NativeStreamsRouting.t.sol";

/// @dev Drives the proxied registry against the real price cache; only the native messenger is a fixture.
contract StreamsRegistryHandler is Test {
    bytes32 private constant BTC = bytes32((uint256(3) << 240) | 1);
    bytes32 private constant ETH = bytes32((uint256(3) << 240) | 2);
    address private constant PUBLISHER = address(0xBA5E);
    StreamsRoundRegistry public registry;
    HorizenStreamsOracle public cache;
    NativeMessengerFixture private messenger;
    bytes32[] public ids;
    mapping(bytes32 => int192) public originalOpening;
    mapping(bytes32 => StreamsRoundRegistry.Outcome) public terminal;
    uint256 public successfulOpenings;
    uint256 public successfulResolutions;
    uint256 public successfulVoids;
    uint256 public lateResolutions;
    uint256 public refusedVoids;

    constructor() {
        messenger = new NativeMessengerFixture();
        messenger.configure(address(0xCAFE));
        cache = new HorizenStreamsOracle(
            StreamsOracleRoute.Config({
                sourceChainId: block.chainid + 1,
                destinationChainId: block.chainid,
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
        // The planned mainnet timing (60 / 150 / 300 / 30).
        registry = StreamsRegistryProxy.deploy(
            StreamsRoundRegistry.Config(
                address(cache), address(new MockCollateral()), BTC, ETH, 18, 18, 60, 150, 5 minutes, 30
            ),
            address(0xD00D)
        );
    }

    function schedule(bool eth, bool fifteen) external {
        if (ids.length >= 12) return;
        uint64 start = uint64((block.timestamp / 900 + 1 + ids.length) * 900);
        ids.push(
            registry.createRound(
                eth ? StreamsRoundRegistry.Asset.ETH : StreamsRoundRegistry.Asset.BTC,
                fifteen ? 900 : 300,
                start
            )
        );
    }

    function advance(uint32 elapsed) external {
        vm.warp(block.timestamp + bound(elapsed, 0, 120));
    }

    /// @dev Jump forward to a round's start, end or first voidable second so every phase is reachable.
    function seek(uint256 choice, uint8 mode) external {
        if (ids.length == 0) return;
        StreamsRoundRegistry.Round memory round = registry.getRound(ids[choice % ids.length]);
        uint256 target =
            mode % 3 == 0 ? round.start : mode % 3 == 1 ? round.end : uint256(round.voidableAfter) + 1;
        if (target > block.timestamp) vm.warp(target);
    }

    /// @dev Models the native delivery of one authenticated boundary observation into the cache.
    function deliver(uint256 choice, bool closing, uint192 rawPrice) public {
        if (ids.length == 0) return;
        bytes32 id = ids[choice % ids.length];
        StreamsRoundRegistry.Round memory round = registry.getRound(id);
        uint64 boundary = closing ? round.end : round.start;
        bytes32 feed = feedOf(id);
        if (boundary > block.timestamp || cache.getObservation(feed, boundary).reportHash != bytes32(0)) {
            return;
        }
        int192 price = int192(uint192(bound(rawPrice, 1, uint192(type(int192).max))));
        IStreamsBoundaryOracle.Observation memory observation = IStreamsBoundaryOracle.Observation(
            price,
            uint32(boundary),
            uint32(boundary),
            uint32(boundary) + 30,
            keccak256(abi.encode(feed, boundary, price)),
            18
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

    function open(uint256 choice, uint192 rawPrice) external {
        if (ids.length == 0) return;
        bytes32 id = ids[choice % ids.length];
        StreamsRoundRegistry.Round memory round = registry.getRound(id);
        if (
            round.outcome != StreamsRoundRegistry.Outcome.Pending || round.openedAt != 0
                || block.timestamp < round.start || block.timestamp > round.openingDeadline
        ) return;
        deliver(choice, false, rawPrice);
        registry.recordOpening(id, "");
        originalOpening[id] = cache.getObservation(feedOf(id), round.start).price;
        ++successfulOpenings;
    }

    /// @dev Resolution has no deadline: any time at or after end, from the cached closing observation.
    function resolve(uint256 choice, uint192 rawPrice) external {
        if (ids.length == 0) return;
        bytes32 id = ids[choice % ids.length];
        StreamsRoundRegistry.Round memory round = registry.getRound(id);
        if (
            round.outcome != StreamsRoundRegistry.Outcome.Pending || round.openedAt == 0
                || block.timestamp < round.end
        ) return;
        deliver(choice, true, rawPrice);
        registry.resolveRound(id, "");
        terminal[id] = cache.getObservation(feedOf(id), round.end).price >= originalOpening[id]
            ? StreamsRoundRegistry.Outcome.Up
            : StreamsRoundRegistry.Outcome.Down;
        ++successfulResolutions;
        if (block.timestamp > round.voidableAfter) ++lateResolutions;
    }

    function timeout(uint256 choice) external {
        if (ids.length == 0) return;
        bytes32 id = ids[choice % ids.length];
        if (registry.phase(id) != StreamsRoundRegistry.Phase.Voidable) return;
        StreamsRoundRegistry.Round memory round = registry.getRound(id);
        // An opened round is voided only while its closing price is absent from the cache.
        if (round.openedAt != 0) {
            assertEq(cache.getObservation(feedOf(id), round.end).reportHash, bytes32(0));
        }
        registry.voidRound(id);
        terminal[id] = StreamsRoundRegistry.Outcome.Void;
        ++successfulVoids;
    }

    function attemptFinalRewrite(uint256 choice) external {
        if (ids.length == 0) return;
        bytes32 id = ids[choice % ids.length];
        if (terminal[id] == StreamsRoundRegistry.Outcome.Pending) return;
        (bool success,) = address(registry).call(abi.encodeCall(registry.voidRound, (id)));
        assertFalse(success);
        (success,) = address(registry).call(abi.encodeCall(registry.resolveRound, (id, "")));
        assertFalse(success);
    }

    /// @dev At any time, however late, an opened round whose closing price is cached cannot be voided.
    function attemptVoidAgainstEvidence(uint256 choice) external {
        if (ids.length == 0) return;
        bytes32 id = ids[choice % ids.length];
        StreamsRoundRegistry.Round memory round = registry.getRound(id);
        if (
            round.outcome != StreamsRoundRegistry.Outcome.Pending || round.openedAt == 0
                || cache.getObservation(feedOf(id), round.end).reportHash == bytes32(0)
        ) return;
        (bool success,) = address(registry).call(abi.encodeCall(registry.voidRound, (id)));
        assertFalse(success);
        ++refusedVoids;
    }

    function feedOf(bytes32 id) public view returns (bytes32) {
        return registry.getRound(id).asset == StreamsRoundRegistry.Asset.BTC ? BTC : ETH;
    }

    function count() external view returns (uint256) {
        return ids.length;
    }
}

contract StreamsRoundRegistryInvariantTest is Test {
    StreamsRegistryHandler internal handler;
    StreamsRoundRegistry internal registry;
    HorizenStreamsOracle internal cache;

    function setUp() public {
        vm.warp(1_800_000_000 - 100);
        handler = new StreamsRegistryHandler();
        vm.deal(address(handler), 100 ether);
        registry = handler.registry();
        cache = handler.cache();
        handler.schedule(false, false);
        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = handler.schedule.selector;
        selectors[1] = handler.advance.selector;
        selectors[2] = handler.open.selector;
        selectors[3] = handler.resolve.selector;
        selectors[4] = handler.timeout.selector;
        selectors[5] = handler.attemptFinalRewrite.selector;
        selectors[6] = handler.seek.selector;
        selectors[7] = handler.deliver.selector;
        selectors[8] = handler.attemptVoidAgainstEvidence.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
        targetContract(address(handler));
    }

    function invariantTerminalResultsAndOpeningCannotChange() public view {
        for (uint256 i; i < handler.count(); ++i) {
            bytes32 id = handler.ids(i);
            StreamsRoundRegistry.Round memory round = registry.getRound(id);
            assertEq(round.opening.price, handler.originalOpening(id));
            assertEq(uint8(round.outcome), uint8(handler.terminal(id)));
            if (round.outcome == StreamsRoundRegistry.Outcome.Up) {
                assertGe(round.closing.price, round.opening.price);
            }
            if (round.outcome == StreamsRoundRegistry.Outcome.Down) {
                assertLt(round.closing.price, round.opening.price);
            }
        }
    }

    function invariantPayoutConservationAndTradeGate() public view {
        for (uint256 i; i < handler.count(); ++i) {
            bytes32 id = handler.ids(i);
            StreamsRoundRegistry.Round memory round = registry.getRound(id);
            (uint8 up, uint8 down, uint8 denominator) = registry.payoutNumerators(id);
            if (round.outcome == StreamsRoundRegistry.Outcome.Pending) {
                assertEq(denominator, 0);
            } else {
                assertEq(uint256(up) + down, 2);
                assertEq(denominator, 2);
            }
            if (registry.canTrade(id)) {
                assertEq(uint8(round.outcome), 0);
                assertGt(round.openedAt, 0);
                assertGe(block.timestamp, round.start);
                assertLt(block.timestamp, round.cutoff);
            }
            assertLt(round.openingDeadline, round.cutoff);
            assertLt(round.cutoff, round.end);
        }
        assertEq(address(registry).balance, 0);
    }

    function invariantVoidableNeverWhileClosingPriceIsCached() public view {
        for (uint256 i; i < handler.count(); ++i) {
            bytes32 id = handler.ids(i);
            StreamsRoundRegistry.Round memory round = registry.getRound(id);
            IStreamsBoundaryOracle.Observation memory cached =
                cache.getObservation(handler.feedOf(id), round.end);
            if (registry.phase(id) == StreamsRoundRegistry.Phase.Voidable) {
                if (round.openedAt == 0) {
                    assertGt(block.timestamp, round.openingDeadline);
                } else {
                    assertGt(block.timestamp, round.voidableAfter);
                    assertEq(cached.reportHash, bytes32(0));
                }
            }
            if (
                round.outcome == StreamsRoundRegistry.Outcome.Up
                    || round.outcome == StreamsRoundRegistry.Outcome.Down
            ) {
                // A price result is always the cache's own closing observation, recorded at or after end.
                assertEq(abi.encode(round.closing), abi.encode(cached));
                assertGe(round.resolvedAt, round.end);
            }
        }
    }
}
