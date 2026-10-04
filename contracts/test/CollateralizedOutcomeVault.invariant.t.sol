// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {CollateralizedOutcomeVault} from "../src/CollateralizedOutcomeVault.sol";
import {StreamsRoundRegistry} from "../src/StreamsRoundRegistry.sol";
import {IStreamsBoundaryOracle} from "../src/interfaces/IStreamsBoundaryOracle.sol";
import {MockStreamsBoundaryOracle} from "./mocks/MockStreamsBoundaryOracle.sol";
import {OutcomeVaultTokenFixture} from "./mocks/OutcomeVaultFixtures.sol";

contract OutcomeVaultHandler is Test {
    uint32 private constant START = 1_800_000_000;
    uint256 private constant LOT = 1000;
    uint256 public constant INITIAL_CASH = 3e15;
    OutcomeVaultTokenFixture public token;
    StreamsRoundRegistry public registry;
    CollateralizedOutcomeVault public vault;
    address[3] public actors = [address(0xA11CE), address(0xB0B), address(0xCA401)];
    bytes32[2] public rounds;
    uint256[2][2] public tokenIds;
    uint256 public deposited;
    uint256 public withdrawn;
    uint256 public donated;

    constructor() {
        vm.warp(START - 600);
        token = new OutcomeVaultTokenFixture(6);
        MockStreamsBoundaryOracle oracle = new MockStreamsBoundaryOracle();
        registry = new StreamsRoundRegistry(
            StreamsRoundRegistry.Config(
                address(oracle),
                address(token),
                bytes32((uint256(3) << 240) | 1),
                bytes32((uint256(3) << 240) | 2),
                18,
                18,
                10,
                20,
                60,
                30
            )
        );
        rounds[0] = registry.createRound(StreamsRoundRegistry.Asset.BTC, 300, START);
        rounds[1] = registry.createRound(StreamsRoundRegistry.Asset.ETH, 900, START);
        vault = new CollateralizedOutcomeVault(address(registry), registry.rulesHash());
        vm.warp(START);
        for (uint256 round; round < 2; ++round) {
            registry.recordOpening(rounds[round], _evidence(100e18, START));
            tokenIds[round] = [vault.outcomeTokenId(rounds[round], 0), vault.outcomeTokenId(rounds[round], 1)];
        }
        for (uint256 i; i < actors.length; ++i) {
            token.mint(actors[i], 1e15);
            vm.startPrank(actors[i]);
            token.approve(address(vault), type(uint256).max);
            for (uint256 round; round < 2; ++round) {
                vault.mintCompleteSet(rounds[round], 1e8, actors[i]);
                deposited += 1e8;
            }
            vm.stopPrank();
        }
    }

    function _evidence(int192 price, uint32 time) private pure returns (bytes memory) {
        return abi.encode(
            IStreamsBoundaryOracle.Observation(
                price, time, time, time + 30, keccak256(abi.encode(price, time)), 18
            )
        );
    }

    function mint(uint8 roundRaw, uint8 payerRaw, uint8 recipientRaw, uint64 rawAmount) external {
        bytes32 round = rounds[roundRaw % 2];
        if (!registry.canTrade(round)) return;
        address payer = actors[payerRaw % 3];
        uint256 available = token.balanceOf(payer) / LOT;
        if (available == 0) return;
        uint256 amount = bound(rawAmount, 1, available > 1e8 ? 1e8 : available) * LOT;
        vm.prank(payer);
        vault.mintCompleteSet(round, amount, actors[recipientRaw % 3]);
        deposited += amount;
    }

    function move(uint8 roundRaw, uint8 fromRaw, uint8 toRaw, bool up, uint64 rawAmount) external {
        address from = actors[fromRaw % 3];
        uint256 id = tokenIds[roundRaw % 2][up ? 0 : 1];
        uint256 available = vault.balanceOf(from, id) / LOT;
        if (available == 0) return;
        uint256 amount = bound(rawAmount, 0, available) * LOT;
        vm.prank(from);
        vault.safeTransferFrom(from, actors[toRaw % 3], id, amount, "");
    }

    function merge(uint8 roundRaw, uint8 actorRaw, uint8 recipientRaw, uint64 rawAmount) external {
        uint256 round = roundRaw % 2;
        address actor = actors[actorRaw % 3];
        uint256 up = vault.balanceOf(actor, tokenIds[round][0]);
        uint256 down = vault.balanceOf(actor, tokenIds[round][1]);
        uint256 available = (up < down ? up : down) / LOT;
        if (available == 0) return;
        uint256 amount = bound(rawAmount, 1, available) * LOT;
        vm.prank(actor);
        vault.mergeCompleteSet(rounds[round], amount, actors[recipientRaw % 3]);
        withdrawn += amount;
    }

    function redeem(uint8 roundRaw, uint8 actorRaw, uint8 recipientRaw) external {
        uint256 round = roundRaw % 2;
        (,, uint8 denominator) = registry.payoutNumerators(rounds[round]);
        if (denominator == 0) return;
        address actor = actors[actorRaw % 3];
        if (vault.balanceOf(actor, tokenIds[round][0]) + vault.balanceOf(actor, tokenIds[round][1]) == 0) {
            return;
        }
        vm.prank(actor);
        withdrawn += vault.redeem(rounds[round], actors[recipientRaw % 3]);
    }

    function settle(uint8 roundRaw, uint8 result) external {
        bytes32 id = rounds[roundRaw % 2];
        StreamsRoundRegistry.Round memory round = registry.getRound(id);
        if (round.outcome != StreamsRoundRegistry.Outcome.Pending) return;
        if (result % 3 == 2 || block.timestamp > round.resolutionDeadline) {
            if (block.timestamp <= round.resolutionDeadline) vm.warp(round.resolutionDeadline + 1);
            registry.voidRound(id);
        } else {
            if (block.timestamp < round.end) vm.warp(round.end);
            registry.resolveRound(
                id, _evidence(result % 3 == 0 ? int192(100e18) : int192(100e18 - 1), uint32(round.end))
            );
        }
    }

    function advance(uint8 raw) external {
        vm.warp(block.timestamp + bound(raw, 0, 20));
    }

    function donate(uint8 actorRaw, uint32 raw) external {
        address actor = actors[actorRaw % 3];
        uint256 amount = bound(raw, 0, 1e6);
        if (token.balanceOf(actor) < amount) return;
        vm.prank(actor);
        token.transfer(address(vault), amount);
        donated += amount;
    }
}

contract CollateralizedOutcomeVaultInvariantTest is Test {
    OutcomeVaultHandler private handler;
    CollateralizedOutcomeVault private vault;
    StreamsRoundRegistry private registry;
    OutcomeVaultTokenFixture private token;

    function setUp() public {
        handler = new OutcomeVaultHandler();
        vault = handler.vault();
        registry = handler.registry();
        token = handler.token();
        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = handler.mint.selector;
        selectors[1] = handler.move.selector;
        selectors[2] = handler.merge.selector;
        selectors[3] = handler.redeem.selector;
        selectors[4] = handler.settle.selector;
        selectors[5] = handler.advance.selector;
        selectors[6] = handler.donate.selector;
        targetSelector(FuzzSelector(address(handler), selectors));
        targetContract(address(handler));
    }

    function invariantFundedClaimsAndTokenConservation() public view {
        uint256 locked;
        uint256 shares;
        for (uint256 round; round < 2; ++round) {
            bytes32 id = handler.rounds(round);
            uint256 upId = handler.tokenIds(round, 0);
            uint256 downId = handler.tokenIds(round, 1);
            uint256 upSupply = vault.totalSupply(upId);
            uint256 downSupply = vault.totalSupply(downId);
            uint256 ownerUp;
            uint256 ownerDown;
            for (uint256 i; i < 3; ++i) {
                uint256 heldUp = vault.balanceOf(handler.actors(i), upId);
                uint256 heldDown = vault.balanceOf(handler.actors(i), downId);
                assertEq(heldUp % 1000, 0);
                assertEq(heldDown % 1000, 0);
                ownerUp += heldUp;
                ownerDown += heldDown;
            }
            assertEq(upSupply, ownerUp);
            assertEq(downSupply, ownerDown);
            (uint8 up, uint8 down, uint8 denominator) = registry.payoutNumerators(id);
            if (denominator == 0) {
                assertEq(upSupply, downSupply);
                assertEq(vault.collateralLocked(id), upSupply);
            } else {
                assertEq(vault.collateralLocked(id), upSupply / 2 * up + downSupply / 2 * down);
            }
            locked += vault.collateralLocked(id);
            shares += upSupply + downSupply;
        }
        assertEq(vault.totalCollateralLocked(), locked);
        assertEq(vault.totalSupply(), shares);
        assertEq(token.balanceOf(address(vault)), locked + handler.donated());
        assertEq(handler.deposited(), locked + handler.withdrawn());
        uint256 cash = token.balanceOf(address(vault));
        for (uint256 i; i < 3; ++i) {
            cash += token.balanceOf(handler.actors(i));
        }
        assertEq(cash, handler.INITIAL_CASH());
    }
}
