// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC1155} from "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {CollateralizedOutcomeVault} from "../src/CollateralizedOutcomeVault.sol";
import {StreamsRoundRegistry} from "../src/StreamsRoundRegistry.sol";
import {IStreamsBoundaryOracle} from "../src/interfaces/IStreamsBoundaryOracle.sol";
import {MockStreamsBoundaryOracle, StreamsRegistryProxy} from "./mocks/MockStreamsBoundaryOracle.sol";
import {
    OutcomeVaultTokenFixture,
    OutcomeVaultRegistryFixture,
    OutcomeVaultReceiverFixture
} from "./mocks/OutcomeVaultFixtures.sol";

contract CollateralizedOutcomeVaultTest is Test {
    uint32 internal constant START = 1_800_000_000;
    // end + observationWindow + voidGrace of the five-minute round under the fixture rules.
    uint32 internal constant VOIDABLE_AFTER = START + 300 + 10 + 1 days;
    uint256 internal constant LOT = 1000;
    uint256 internal constant UNIT = 1_000_000;
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant CAROL = address(0xCA401);
    OutcomeVaultTokenFixture internal token;
    MockStreamsBoundaryOracle internal oracle;
    StreamsRoundRegistry internal registry;
    CollateralizedOutcomeVault internal vault;
    bytes32 internal id;
    bytes32 internal otherId;
    mapping(bytes32 round => uint256[2] ids) internal _tokenIds;

    function setUp() public {
        vm.warp(START - 600);
        token = new OutcomeVaultTokenFixture(6);
        oracle = new MockStreamsBoundaryOracle();
        registry = StreamsRegistryProxy.deploy(
            StreamsRoundRegistry.Config(
                address(oracle),
                address(token),
                bytes32((uint256(3) << 240) | 1),
                bytes32((uint256(3) << 240) | 2),
                18,
                18,
                10,
                20,
                1 days,
                30
            ),
            address(this)
        );
        id = registry.createRound(StreamsRoundRegistry.Asset.BTC, 300, START);
        otherId = registry.createRound(StreamsRoundRegistry.Asset.ETH, 900, START);
        vault = new CollateralizedOutcomeVault(address(registry), registry.rulesHash());
        _tokenIds[id] = [vault.outcomeTokenId(id, 0), vault.outcomeTokenId(id, 1)];
        _tokenIds[otherId] = [vault.outcomeTokenId(otherId, 0), vault.outcomeTokenId(otherId, 1)];
        token.mint(ALICE, 1e15);
        token.mint(BOB, 1e15);
        token.mint(CAROL, 1e15);
        vm.prank(ALICE);
        token.approve(address(vault), type(uint256).max);
        vm.prank(BOB);
        token.approve(address(vault), type(uint256).max);
        vm.prank(CAROL);
        token.approve(address(vault), type(uint256).max);
    }

    function _evidence(int192 price, uint32 time) internal pure returns (bytes memory) {
        return abi.encode(
            IStreamsBoundaryOracle.Observation(
                price, time, time, time + 30, keccak256(abi.encode(price, time)), 18
            )
        );
    }

    function _open() internal {
        vm.warp(START);
        registry.recordOpening(id, _evidence(100e18, START));
        registry.recordOpening(otherId, _evidence(100e18, START));
    }

    function _mint(address payer, bytes32 round, uint256 amount, address recipient) internal {
        vm.prank(payer);
        vault.mintCompleteSet(round, amount, recipient);
    }

    function _tokenId(bytes32 round, uint8 outcome) internal view returns (uint256) {
        return _tokenIds[round][outcome];
    }

    function _settle(uint8 result) internal {
        if (result == 2) {
            vm.warp(VOIDABLE_AFTER + 1);
            registry.voidRound(id);
        } else {
            vm.warp(START + 300);
            registry.resolveRound(
                id, _evidence(result == 0 ? int192(100e18) : int192(100e18 - 1), START + 300)
            );
        }
    }

    function _assertRound(bytes32 round) internal view {
        (uint8 up, uint8 down, uint8 denominator) = registry.payoutNumerators(round);
        uint256 supplyUp = vault.totalSupply(_tokenId(round, 0));
        uint256 supplyDown = vault.totalSupply(_tokenId(round, 1));
        if (denominator == 0) {
            assertEq(supplyUp, supplyDown);
            assertEq(vault.collateralLocked(round), supplyUp);
        } else {
            assertEq(vault.collateralLocked(round), supplyUp / 2 * up + supplyDown / 2 * down);
        }
        assertEq(vault.totalCollateralLocked(), vault.collateralLocked(id) + vault.collateralLocked(otherId));
        assertGe(token.balanceOf(address(vault)), vault.totalCollateralLocked());
    }

    function testConfigurationAndTokenIdentity() public {
        assertEq(vault.version(), "zedge-public-outcome-vault-v1");
        assertEq(address(vault.registry()), address(registry));
        assertEq(address(vault.collateral()), address(token));
        assertEq(vault.registryRulesHash(), registry.rulesHash());
        assertEq(vault.registryCodeHash(), address(registry).codehash);
        assertTrue(vault.supportsInterface(type(IERC1155).interfaceId));
        assertTrue(vault.supportsInterface(type(IERC165).interfaceId));
        CollateralizedOutcomeVault second =
            new CollateralizedOutcomeVault(address(registry), registry.rulesHash());
        assertTrue(_tokenId(id, 0) != _tokenId(id, 1));
        assertTrue(_tokenId(id, 0) != _tokenId(otherId, 0));
        assertTrue(_tokenId(id, 0) != second.outcomeTokenId(id, 0));
        vm.expectRevert(CollateralizedOutcomeVault.InvalidOutcome.selector);
        vault.outcomeTokenId(id, 2);
    }

    function testConstructorRejectsWrongBindingVersionDecimalsAndNoCode() public {
        vm.expectRevert(CollateralizedOutcomeVault.InvalidConfig.selector);
        new CollateralizedOutcomeVault(address(1), bytes32(uint256(1)));
        vm.expectRevert(CollateralizedOutcomeVault.InvalidConfig.selector);
        new CollateralizedOutcomeVault(address(registry), bytes32(0));
        vm.expectRevert(CollateralizedOutcomeVault.InvalidConfig.selector);
        new CollateralizedOutcomeVault(address(registry), keccak256("wrong rules"));
        OutcomeVaultRegistryFixture fake = new OutcomeVaultRegistryFixture(address(token));
        bytes32 rules = fake.rulesHash();
        fake.configure(block.chainid + 1, rules, "zedge-streams-round-registry-v2");
        vm.expectRevert(CollateralizedOutcomeVault.InvalidConfig.selector);
        new CollateralizedOutcomeVault(address(fake), rules);
        // The retired registry's marker is no longer an accepted binding.
        fake.configure(block.chainid, rules, "zedge-streams-round-registry-v1");
        vm.expectRevert(CollateralizedOutcomeVault.InvalidConfig.selector);
        new CollateralizedOutcomeVault(address(fake), rules);
        fake.configure(block.chainid, rules, "unreviewed-registry-version");
        vm.expectRevert(CollateralizedOutcomeVault.InvalidConfig.selector);
        new CollateralizedOutcomeVault(address(fake), rules);
        fake = new OutcomeVaultRegistryFixture(address(new OutcomeVaultTokenFixture(18)));
        rules = fake.rulesHash();
        vm.expectRevert(CollateralizedOutcomeVault.InvalidConfig.selector);
        new CollateralizedOutcomeVault(address(fake), rules);
        fake = new OutcomeVaultRegistryFixture(address(1));
        rules = fake.rulesHash();
        vm.expectRevert(CollateralizedOutcomeVault.InvalidConfig.selector);
        new CollateralizedOutcomeVault(address(fake), rules);
    }

    function testMintMergeExactFundingAndIndependentRounds() public {
        _open();
        uint256 before = token.balanceOf(ALICE);
        _mint(ALICE, id, 9 * UNIT, ALICE);
        _mint(ALICE, otherId, 3 * UNIT, BOB);
        assertEq(token.balanceOf(ALICE), before - 12 * UNIT);
        assertEq(vault.balanceOf(ALICE, _tokenId(id, 0)), 9 * UNIT);
        assertEq(vault.balanceOf(ALICE, _tokenId(id, 1)), 9 * UNIT);
        vm.prank(ALICE);
        vault.mergeCompleteSet(id, 4 * UNIT, CAROL);
        assertEq(token.balanceOf(CAROL), 1e15 + 4 * UNIT);
        _assertRound(id);
        _assertRound(otherId);
    }

    function testMintOnlyDuringOpenedTradingPhase() public {
        vm.prank(ALICE);
        vm.expectRevert(CollateralizedOutcomeVault.TradingUnavailable.selector);
        vault.mintCompleteSet(id, UNIT, ALICE);
        vm.warp(START);
        vm.prank(ALICE);
        vm.expectRevert(CollateralizedOutcomeVault.TradingUnavailable.selector);
        vault.mintCompleteSet(id, UNIT, ALICE);
        _open();
        _mint(ALICE, id, UNIT, ALICE);
        vm.warp(START + 270);
        vm.prank(ALICE);
        vm.expectRevert(CollateralizedOutcomeVault.TradingUnavailable.selector);
        vault.mintCompleteSet(id, UNIT, ALICE);
        // Complete pairs remain recoverable even while the registry awaits settlement.
        vm.prank(ALICE);
        vault.mergeCompleteSet(id, UNIT, ALICE);
        assertEq(vault.totalCollateralLocked(), 0);
    }

    function testRedeemWinnerAndLoserOnceWithExactTieUp() public {
        _open();
        _mint(ALICE, id, 7 * UNIT, ALICE);
        vm.prank(ALICE);
        vault.safeTransferFrom(ALICE, BOB, _tokenId(id, 1), 7 * UNIT, "");
        _settle(0);
        vm.prank(BOB);
        assertEq(vault.redeem(id, BOB), 0);
        _assertRound(id);
        vm.prank(ALICE);
        assertEq(vault.redeem(id, CAROL), 7 * UNIT);
        _assertRound(id);
        vm.prank(ALICE);
        vm.expectRevert(CollateralizedOutcomeVault.NothingToRedeem.selector);
        vault.redeem(id, ALICE);
    }

    function testRedeemDownForOneOracleAtomDecline() public {
        _open();
        _mint(ALICE, id, UNIT, ALICE);
        vm.prank(ALICE);
        vault.safeTransferFrom(ALICE, BOB, _tokenId(id, 1), UNIT, "");
        _settle(1);
        vm.prank(ALICE);
        assertEq(vault.redeem(id, ALICE), 0);
        vm.prank(BOB);
        assertEq(vault.redeem(id, BOB), UNIT);
        _assertRound(id);
    }

    function testTimeoutRecoveryWithoutOracleOrMatcher() public {
        _open();
        _mint(ALICE, id, 3 * LOT, ALICE);
        vm.prank(ALICE);
        vault.safeTransferFrom(ALICE, BOB, _tokenId(id, 1), 3 * LOT, "");
        oracle.setFailure(true);
        vm.warp(VOIDABLE_AFTER);
        vm.expectRevert(StreamsRoundRegistry.TimeoutNotReached.selector);
        registry.voidRound(id);
        vm.warp(VOIDABLE_AFTER + 1);
        vm.prank(CAROL);
        registry.voidRound(id);
        vm.prank(ALICE);
        assertEq(vault.redeem(id, ALICE), 1500);
        vm.prank(BOB);
        assertEq(vault.redeem(id, BOB), 1500);
        _assertRound(id);
        assertEq(token.balanceOf(address(vault)), 0);
    }

    function testUnsettledAndMissingOpeningCannotRedeemOrMint() public {
        _open();
        _mint(ALICE, id, UNIT, ALICE);
        vm.prank(ALICE);
        vm.expectRevert(CollateralizedOutcomeVault.RoundUnsettled.selector);
        vault.redeem(id, ALICE);
        vm.prank(ALICE);
        vm.expectRevert(CollateralizedOutcomeVault.TradingUnavailable.selector);
        vault.mintCompleteSet(keccak256("unknown"), UNIT, ALICE);
    }

    function testDonationDoesNotCreateClaimsAndIsNotWithdrawable() public {
        _open();
        vm.prank(ALICE);
        token.transfer(address(vault), 33);
        _mint(ALICE, id, UNIT, ALICE);
        vm.prank(ALICE);
        vault.mergeCompleteSet(id, UNIT, ALICE);
        assertEq(vault.totalCollateralLocked(), 0);
        assertEq(token.balanceOf(address(vault)), 33);
        assertEq(vault.totalSupply(), 0);
    }

    function testNoAllowanceOrInventoryCannotCreateOrWithdrawValue() public {
        _open();
        vm.prank(ALICE);
        token.approve(address(vault), 0);
        vm.prank(ALICE);
        vm.expectRevert();
        vault.mintCompleteSet(id, UNIT, ALICE);
        vm.prank(BOB);
        vm.expectRevert();
        vault.mergeCompleteSet(id, UNIT, BOB);
        assertEq(vault.totalCollateralLocked(), 0);
        assertEq(vault.totalSupply(), 0);
        assertEq(token.balanceOf(address(vault)), 0);
    }

    function testInvalidAmountsAndRecipientsRejectAtomically() public {
        _open();
        uint256[4] memory invalid = [uint256(0), 1, 1001, type(uint256).max];
        for (uint256 i; i < invalid.length; ++i) {
            vm.prank(ALICE);
            vm.expectRevert(CollateralizedOutcomeVault.InvalidAmount.selector);
            vault.mintCompleteSet(id, invalid[i], ALICE);
        }
        vm.prank(ALICE);
        vm.expectRevert(CollateralizedOutcomeVault.InvalidRecipient.selector);
        vault.mintCompleteSet(id, UNIT, address(0));
        vm.prank(ALICE);
        vm.expectRevert(CollateralizedOutcomeVault.InvalidRecipient.selector);
        vault.mintCompleteSet(id, UNIT, address(vault));
        _mint(ALICE, id, UNIT, ALICE);
        vm.prank(ALICE);
        vm.expectRevert(CollateralizedOutcomeVault.InvalidRecipient.selector);
        vault.mergeCompleteSet(id, UNIT, address(0));
        vm.prank(ALICE);
        vm.expectRevert(CollateralizedOutcomeVault.InvalidRecipient.selector);
        vault.redeem(id, address(vault));
        _assertRound(id);
    }

    function testTransferLotsBatchAuthorizationAndZeroAmounts() public {
        _open();
        _mint(ALICE, id, UNIT, ALICE);
        uint256 up = _tokenId(id, 0);
        uint256 down = _tokenId(id, 1);
        vm.prank(BOB);
        vm.expectRevert();
        vault.safeTransferFrom(ALICE, BOB, up, LOT, "");
        vm.prank(ALICE);
        vm.expectRevert(CollateralizedOutcomeVault.InvalidAmount.selector);
        vault.safeTransferFrom(ALICE, BOB, up, 1, "");
        vm.prank(ALICE);
        vault.safeTransferFrom(ALICE, BOB, up, 0, "");
        uint256[] memory ids = new uint256[](2);
        ids[0] = up;
        ids[1] = down;
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = LOT;
        amounts[1] = LOT + 1;
        vm.prank(ALICE);
        vm.expectRevert(CollateralizedOutcomeVault.InvalidAmount.selector);
        vault.safeBatchTransferFrom(ALICE, BOB, ids, amounts, "");
        assertEq(vault.balanceOf(BOB, up), 0);
        amounts[1] = LOT;
        vm.prank(ALICE);
        vault.setApprovalForAll(CAROL, true);
        vm.prank(CAROL);
        vault.safeBatchTransferFrom(ALICE, BOB, ids, amounts, "");
        assertEq(vault.balanceOf(BOB, up), LOT);
        assertEq(vault.balanceOf(BOB, down), LOT);
        // Approval permits moving tokens; merge/redeem never take an arbitrary owner's shares.
        vm.prank(CAROL);
        vm.expectRevert();
        vault.mergeCompleteSet(id, LOT, CAROL);
        _assertRound(id);
    }

    function testWrongChainCannotMintTransferMergeOrRedeem() public {
        _open();
        _mint(ALICE, id, UNIT, ALICE);
        uint256 up = _tokenId(id, 0);
        vm.chainId(block.chainid + 1);
        vm.startPrank(ALICE);
        vm.expectRevert(CollateralizedOutcomeVault.WrongChain.selector);
        vault.mintCompleteSet(id, UNIT, ALICE);
        vm.expectRevert(CollateralizedOutcomeVault.WrongChain.selector);
        vault.mergeCompleteSet(id, UNIT, ALICE);
        vm.expectRevert(CollateralizedOutcomeVault.WrongChain.selector);
        vault.redeem(id, ALICE);
        vm.expectRevert(CollateralizedOutcomeVault.WrongChain.selector);
        vault.safeTransferFrom(ALICE, BOB, up, LOT, "");
        vm.stopPrank();
    }

    function testAggregateCapacityRejectsWithoutOverflowOrCrossRoundDilution() public {
        _open();
        uint256 maximum = vault.MAX_TOTAL_COLLATERAL() / LOT * LOT;
        token.mint(ALICE, maximum);
        _mint(ALICE, id, maximum, ALICE);
        vm.prank(BOB);
        vm.expectRevert(CollateralizedOutcomeVault.InvalidAmount.selector);
        vault.mintCompleteSet(otherId, LOT, BOB);
        assertEq(vault.collateralLocked(otherId), 0);
        _assertRound(id);
        vm.prank(ALICE);
        vault.mergeCompleteSet(id, maximum, ALICE);
        assertEq(vault.totalCollateralLocked(), 0);
    }

    function testBatchMismatchDuplicateIdsAndZeroRecipient() public {
        _open();
        _mint(ALICE, id, UNIT, ALICE);
        uint256[] memory ids = new uint256[](2);
        ids[0] = _tokenId(id, 0);
        ids[1] = ids[0];
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = LOT;
        amounts[1] = LOT;
        vm.prank(ALICE);
        vault.safeBatchTransferFrom(ALICE, BOB, ids, amounts, "");
        assertEq(vault.balanceOf(BOB, ids[0]), 2 * LOT);
        amounts[0] = 0;
        amounts[1] = 0;
        vm.prank(ALICE);
        vault.safeBatchTransferFrom(ALICE, BOB, ids, amounts, "");
        vm.prank(ALICE);
        vm.expectRevert();
        vault.safeBatchTransferFrom(ALICE, address(0), ids, amounts, "");
        uint256[] memory wrongLength = new uint256[](1);
        vm.prank(ALICE);
        vm.expectRevert();
        vault.safeBatchTransferFrom(ALICE, BOB, ids, wrongLength, "");
        assertEq(vault.balanceOf(BOB, ids[0]), 2 * LOT);
        _assertRound(id);
    }

    function testNativeEtherCannotBeDepositedForShares() public {
        _open();
        vm.deal(ALICE, 1 ether);
        vm.prank(ALICE);
        (bool accepted,) =
            address(vault).call{value: 1}(abi.encodeCall(vault.mintCompleteSet, (id, UNIT, ALICE)));
        assertFalse(accepted);
        assertEq(vault.totalCollateralLocked(), 0);
    }

    function testFeeSurchargeAndTransferRebaseRejectedOnDeposit() public {
        _open();
        for (uint8 behavior = 1; behavior <= 3; ++behavior) {
            token.configure(behavior, address(0), "");
            vm.prank(ALICE);
            vm.expectRevert(CollateralizedOutcomeVault.NonExactCollateralTransfer.selector);
            vault.mintCompleteSet(id, UNIT, ALICE);
            assertEq(vault.totalSupply(), 0);
            assertEq(vault.totalCollateralLocked(), 0);
            assertEq(token.balanceOf(address(vault)), 0);
            assertEq(token.balanceOf(ALICE), 1e15);
        }
        token.configure(4, address(0), "");
        vm.prank(ALICE);
        vm.expectRevert();
        vault.mintCompleteSet(id, UNIT, ALICE);
        assertEq(vault.totalCollateralLocked(), 0);
    }

    function testNonExactWithdrawalRollsBackBurnAndLiability() public {
        _open();
        _mint(ALICE, id, 2 * UNIT, ALICE);
        for (uint8 behavior = 1; behavior <= 3; ++behavior) {
            token.configure(behavior, address(0), "");
            vm.prank(ALICE);
            vm.expectRevert(CollateralizedOutcomeVault.NonExactCollateralTransfer.selector);
            vault.mergeCompleteSet(id, UNIT, ALICE);
            assertEq(vault.balanceOf(ALICE, _tokenId(id, 0)), 2 * UNIT);
            assertEq(vault.balanceOf(ALICE, _tokenId(id, 1)), 2 * UNIT);
            assertEq(vault.totalCollateralLocked(), 2 * UNIT);
        }
        _settle(0);
        token.configure(1, address(0), "");
        vm.prank(ALICE);
        vm.expectRevert(CollateralizedOutcomeVault.NonExactCollateralTransfer.selector);
        vault.redeem(id, ALICE);
        _assertRound(id);
    }

    function testNegativeRebaseBlocksFirstComeDrainAndNewMint() public {
        _open();
        _mint(ALICE, id, UNIT, ALICE);
        _mint(BOB, otherId, UNIT, BOB);
        token.destroy(address(vault), LOT);
        vm.prank(ALICE);
        vm.expectRevert(CollateralizedOutcomeVault.InsolventCollateral.selector);
        vault.mergeCompleteSet(id, UNIT, ALICE);
        vm.prank(BOB);
        vm.expectRevert(CollateralizedOutcomeVault.InsolventCollateral.selector);
        vault.mintCompleteSet(id, UNIT, BOB);
        _settle(0);
        vm.prank(ALICE);
        vm.expectRevert(CollateralizedOutcomeVault.InsolventCollateral.selector);
        vault.redeem(id, ALICE);
        assertEq(vault.totalCollateralLocked(), 2 * UNIT);
    }

    function testCollateralCallbackCannotReenterMerge() public {
        _open();
        token.configure(0, address(vault), abi.encodeCall(vault.mergeCompleteSet, (id, LOT, ALICE)));
        _mint(ALICE, id, UNIT, ALICE);
        assertFalse(token.reentrySucceeded());
        assertEq(bytes4(token.reentryResult()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        vm.prank(ALICE);
        vault.mergeCompleteSet(id, UNIT, ALICE);
        assertFalse(token.reentrySucceeded());
        _assertRound(id);
    }

    function testERC1155MintReceiverCannotReenterOrKeepRejectedMint() public {
        _open();
        OutcomeVaultReceiverFixture receiver = new OutcomeVaultReceiverFixture();
        receiver.configure(address(vault), abi.encodeCall(vault.mergeCompleteSet, (id, UNIT, ALICE)), false);
        _mint(ALICE, id, UNIT, address(receiver));
        assertFalse(receiver.reentrySucceeded());
        assertEq(bytes4(receiver.reentryResult()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        receiver.configure(address(0), "", true);
        uint256 before = token.balanceOf(ALICE);
        vm.prank(ALICE);
        vm.expectRevert();
        vault.mintCompleteSet(id, UNIT, address(receiver));
        assertEq(token.balanceOf(ALICE), before);
        assertEq(vault.totalCollateralLocked(), UNIT);
        _assertRound(id);
    }

    function testERC1155SingleAndBatchReceiverCannotRedeemDuringTransfer() public {
        _open();
        _mint(ALICE, id, UNIT, ALICE);
        _settle(0);
        OutcomeVaultReceiverFixture receiver = new OutcomeVaultReceiverFixture();
        receiver.configure(address(vault), abi.encodeCall(vault.redeem, (id, ALICE)), false);
        vm.prank(ALICE);
        vault.safeTransferFrom(ALICE, address(receiver), _tokenId(id, 0), LOT, "");
        assertFalse(receiver.reentrySucceeded());
        assertEq(bytes4(receiver.reentryResult()), ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        uint256[] memory ids = new uint256[](2);
        uint256[] memory amounts = new uint256[](2);
        ids[0] = _tokenId(id, 0);
        ids[1] = _tokenId(id, 1);
        amounts[0] = LOT;
        amounts[1] = LOT;
        vm.prank(ALICE);
        vault.safeBatchTransferFrom(ALICE, address(receiver), ids, amounts, "");
        assertFalse(receiver.reentrySucceeded());
        _assertRound(id);
    }

    function testMalformedPayoutCannotBurnOrReleaseCollateral() public {
        OutcomeVaultRegistryFixture fake = new OutcomeVaultRegistryFixture(address(token));
        CollateralizedOutcomeVault candidate = new CollateralizedOutcomeVault(address(fake), fake.rulesHash());
        // This test uses a mutable fake only to exercise defensive payout checks.
        vm.startPrank(ALICE);
        token.approve(address(candidate), UNIT);
        candidate.mintCompleteSet(id, UNIT, ALICE);
        vm.stopPrank();
        uint8[3][5] memory bad =
            [[uint8(2), 2, 2], [uint8(1), 0, 2], [uint8(3), 0, 2], [uint8(2), 0, 1], [uint8(0), 0, 2]];
        for (uint256 i; i < bad.length; ++i) {
            fake.setPayout(bad[i][0], bad[i][1], bad[i][2]);
            vm.prank(ALICE);
            vm.expectRevert(CollateralizedOutcomeVault.InvalidPayout.selector);
            candidate.redeem(id, ALICE);
            assertEq(candidate.totalCollateralLocked(), UNIT);
        }
    }

    function testFuzzArbitrarySplitRedeemAndPostSettlementMerge(
        uint64 raw,
        uint64 splitUp,
        uint64 splitDown,
        uint8 result,
        uint64 mergeRaw,
        bool bobFirst
    ) public {
        uint256 amount = bound(raw, 1, 1e9) * LOT;
        uint256 movedUp = bound(splitUp, 0, amount / LOT) * LOT;
        uint256 movedDown = bound(splitDown, 0, amount / LOT) * LOT;
        _open();
        _mint(ALICE, id, amount, ALICE);
        vm.startPrank(ALICE);
        vault.safeTransferFrom(ALICE, BOB, _tokenId(id, 0), movedUp, "");
        vault.safeTransferFrom(ALICE, BOB, _tokenId(id, 1), movedDown, "");
        vm.stopPrank();
        _settle(result % 3);
        uint256 pair = movedUp < movedDown ? movedUp : movedDown;
        uint256 merge = bound(mergeRaw, 0, pair / LOT) * LOT;
        if (merge != 0) {
            vm.prank(BOB);
            vault.mergeCompleteSet(id, merge, BOB);
            _assertRound(id);
        }
        address first = bobFirst ? BOB : ALICE;
        address second = bobFirst ? ALICE : BOB;
        uint256 payouts = merge;
        if (vault.balanceOf(first, _tokenId(id, 0)) + vault.balanceOf(first, _tokenId(id, 1)) > 0) {
            vm.prank(first);
            payouts += vault.redeem(id, first);
            _assertRound(id);
        }
        if (vault.balanceOf(second, _tokenId(id, 0)) + vault.balanceOf(second, _tokenId(id, 1)) > 0) {
            vm.prank(second);
            payouts += vault.redeem(id, second);
            _assertRound(id);
        }
        assertEq(payouts, amount);
        assertEq(vault.totalCollateralLocked(), 0);
        assertEq(vault.totalSupply(), 0);
        assertEq(token.balanceOf(address(vault)), 0);
    }
}
