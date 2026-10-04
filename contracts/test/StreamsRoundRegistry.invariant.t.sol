// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {StreamsRoundRegistry} from "../src/StreamsRoundRegistry.sol";
import {IStreamsBoundaryOracle} from "../src/interfaces/IStreamsBoundaryOracle.sol";
import {MockStreamsBoundaryOracle} from "./mocks/MockStreamsBoundaryOracle.sol";
import {MockCollateral} from "./mocks/MockBoundaryOracle.sol";

contract StreamsRegistryHandler is Test {
    StreamsRoundRegistry public registry;
    bytes32[] public ids;
    mapping(bytes32 => int192) public originalOpening;
    mapping(bytes32 => StreamsRoundRegistry.Outcome) public terminal;
    uint256 public successfulOpenings;
    uint256 public successfulResolutions;
    uint256 public successfulVoids;

    constructor() {
        MockStreamsBoundaryOracle oracle = new MockStreamsBoundaryOracle();
        StreamsRoundRegistry.Config memory config = StreamsRoundRegistry.Config(
            address(oracle),
            address(new MockCollateral()),
            bytes32((uint256(3) << 240) | 1),
            bytes32((uint256(3) << 240) | 2),
            18,
            18,
            10,
            20,
            60,
            30
        );
        registry = new StreamsRoundRegistry(config);
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

    function open(uint256 choice, uint192 rawPrice) external {
        if (ids.length == 0) return;
        bytes32 id = ids[choice % ids.length];
        StreamsRoundRegistry.Round memory round = registry.getRound(id);
        if (
            round.outcome != StreamsRoundRegistry.Outcome.Pending || round.openedAt != 0
                || block.timestamp < round.start || block.timestamp > round.openingDeadline
        ) return;
        int192 price = int192(uint192(bound(rawPrice, 1, uint192(type(int192).max))));
        registry.recordOpening(
            id,
            abi.encode(
                IStreamsBoundaryOracle.Observation(
                    price,
                    uint32(round.start),
                    uint32(round.start),
                    uint32(round.start + 30),
                    keccak256(abi.encode(price, round.start)),
                    18
                )
            )
        );
        originalOpening[id] = price;
        ++successfulOpenings;
    }

    function resolve(uint256 choice, uint192 rawPrice) external {
        if (ids.length == 0) return;
        bytes32 id = ids[choice % ids.length];
        StreamsRoundRegistry.Round memory round = registry.getRound(id);
        if (
            round.outcome != StreamsRoundRegistry.Outcome.Pending || round.openedAt == 0
                || block.timestamp < round.end || block.timestamp > round.resolutionDeadline
        ) return;
        int192 price = int192(uint192(bound(rawPrice, 1, uint192(type(int192).max))));
        registry.resolveRound(
            id,
            abi.encode(
                IStreamsBoundaryOracle.Observation(
                    price,
                    uint32(round.end),
                    uint32(round.end),
                    uint32(round.end + 30),
                    keccak256(abi.encode(price, round.end)),
                    18
                )
            )
        );
        terminal[id] = price >= originalOpening[id]
            ? StreamsRoundRegistry.Outcome.Up
            : StreamsRoundRegistry.Outcome.Down;
        ++successfulResolutions;
    }

    function timeout(uint256 choice) external {
        if (ids.length == 0) return;
        bytes32 id = ids[choice % ids.length];
        if (registry.phase(id) != StreamsRoundRegistry.Phase.Voidable) return;
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
    }

    function count() external view returns (uint256) {
        return ids.length;
    }
}

contract StreamsRoundRegistryInvariantTest is Test {
    StreamsRegistryHandler internal handler;
    StreamsRoundRegistry internal registry;

    function setUp() public {
        vm.warp(1_800_000_000 - 100);
        handler = new StreamsRegistryHandler();
        vm.deal(address(handler), 100 ether);
        registry = handler.registry();
        handler.schedule(false, false);
        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = handler.schedule.selector;
        selectors[1] = handler.advance.selector;
        selectors[2] = handler.open.selector;
        selectors[3] = handler.resolve.selector;
        selectors[4] = handler.timeout.selector;
        selectors[5] = handler.attemptFinalRewrite.selector;
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
}
