// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {RoundRegistry} from "../src/RoundRegistry.sol";
import {IBoundaryOracle} from "../src/interfaces/IBoundaryOracle.sol";
import {MockBoundaryOracle, MockCollateral} from "./mocks/MockBoundaryOracle.sol";

contract RegistryHandler is Test {
    RoundRegistry public registry;
    bytes32[] public ids;
    mapping(bytes32 => int64) public originalOpening;
    mapping(bytes32 => RoundRegistry.Outcome) public terminal;
    uint256 public successfulOpenings;
    uint256 public successfulResolutions;
    uint256 public successfulVoids;

    constructor() {
        MockBoundaryOracle oracle = new MockBoundaryOracle();
        RoundRegistry.Config memory config = RoundRegistry.Config(
            address(oracle),
            address(new MockCollateral()),
            keccak256("TEST-BTC"),
            keccak256("TEST-ETH"),
            -8,
            -8,
            10,
            20,
            60,
            30,
            100
        );
        registry = new RoundRegistry(config);
    }

    function schedule(bool eth, bool fifteen) external {
        if (ids.length >= 12) return;
        uint64 start = uint64((block.timestamp / 900 + 1 + ids.length) * 900);
        ids.push(
            registry.createRound(
                eth ? RoundRegistry.Asset.ETH : RoundRegistry.Asset.BTC, fifteen ? 900 : 300, start
            )
        );
    }

    function advance(uint32 elapsed) external {
        vm.warp(block.timestamp + bound(elapsed, 0, 120));
    }

    function open(uint256 choice, uint64 rawPrice) external {
        if (ids.length == 0) return;
        bytes32 id = ids[choice % ids.length];
        RoundRegistry.Round memory round = registry.getRound(id);
        if (
            round.outcome != RoundRegistry.Outcome.Pending || round.openedAt != 0
                || block.timestamp < round.start || block.timestamp > round.openingDeadline
        ) return;
        int64 price = int64(uint64(bound(rawPrice, 1, uint64(type(int64).max))));
        registry.recordOpening{value: 1}(
            id, abi.encode(IBoundaryOracle.Observation(price, 0, -8, round.start))
        );
        originalOpening[id] = price;
        ++successfulOpenings;
    }

    function resolve(uint256 choice, uint64 rawPrice) external {
        if (ids.length == 0) return;
        bytes32 id = ids[choice % ids.length];
        RoundRegistry.Round memory round = registry.getRound(id);
        if (
            round.outcome != RoundRegistry.Outcome.Pending || round.openedAt == 0
                || block.timestamp < round.end || block.timestamp > round.resolutionDeadline
        ) return;
        int64 price = int64(uint64(bound(rawPrice, 1, uint64(type(int64).max))));
        registry.resolveRound{value: 1}(id, abi.encode(IBoundaryOracle.Observation(price, 0, -8, round.end)));
        terminal[id] = price >= originalOpening[id] ? RoundRegistry.Outcome.Up : RoundRegistry.Outcome.Down;
        ++successfulResolutions;
    }

    function timeout(uint256 choice) external {
        if (ids.length == 0) return;
        bytes32 id = ids[choice % ids.length];
        if (registry.phase(id) != RoundRegistry.Phase.Voidable) return;
        registry.voidRound(id);
        terminal[id] = RoundRegistry.Outcome.Void;
        ++successfulVoids;
    }

    function attemptFinalRewrite(uint256 choice) external {
        if (ids.length == 0) return;
        bytes32 id = ids[choice % ids.length];
        if (terminal[id] == RoundRegistry.Outcome.Pending) return;
        (bool success,) = address(registry).call(abi.encodeCall(registry.voidRound, (id)));
        assertFalse(success);
    }

    function count() external view returns (uint256) {
        return ids.length;
    }
}

contract RoundRegistryInvariantTest is Test {
    RegistryHandler internal handler;
    RoundRegistry internal registry;

    function setUp() public {
        vm.warp(1_800_000_000 - 100);
        handler = new RegistryHandler();
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
            RoundRegistry.Round memory round = registry.getRound(id);
            assertEq(round.opening.price, handler.originalOpening(id));
            assertEq(uint8(round.outcome), uint8(handler.terminal(id)));
            if (round.outcome == RoundRegistry.Outcome.Up) {
                assertGe(round.closing.price, round.opening.price);
            }
            if (round.outcome == RoundRegistry.Outcome.Down) {
                assertLt(round.closing.price, round.opening.price);
            }
        }
    }

    function invariantPayoutConservationAndTradeGate() public view {
        for (uint256 i; i < handler.count(); ++i) {
            bytes32 id = handler.ids(i);
            RoundRegistry.Round memory round = registry.getRound(id);
            (uint8 up, uint8 down, uint8 denominator) = registry.payoutNumerators(id);
            if (round.outcome == RoundRegistry.Outcome.Pending) {
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
