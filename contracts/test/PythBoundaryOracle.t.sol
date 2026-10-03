// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import {PythBoundaryOracle} from "../src/PythBoundaryOracle.sol";
import {RoundRegistry} from "../src/RoundRegistry.sol";
import {IBoundaryOracle} from "../src/interfaces/IBoundaryOracle.sol";
import {MockUniquePyth} from "./mocks/MockUniquePyth.sol";
import {MockCollateral} from "./mocks/MockBoundaryOracle.sol";

contract PythBoundaryOracleTest is Test {
    bytes32 internal constant FEED = keccak256("TEST-BTC-USD");
    MockUniquePyth internal pyth;
    PythBoundaryOracle internal adapter;

    function setUp() public {
        vm.warp(1_000);
        vm.deal(address(this), 100 ether);
        pyth = new MockUniquePyth();
        adapter = new PythBoundaryOracle(address(pyth));
    }

    function evidence(bytes32 feedId, int64 value, uint64 publishTime, uint64 previous)
        internal
        pure
        returns (bytes memory)
    {
        PythStructs.Price memory price = PythStructs.Price(value, 1, -8, publishTime);
        bytes[] memory updates = new bytes[](1);
        updates[0] = abi.encode(PythStructs.PriceFeed(feedId, price, price), previous);
        return abi.encode(updates);
    }

    function valid() internal pure returns (bytes memory) {
        return evidence(FEED, 100_000, 1_000, 999);
    }

    function testVerifierIdentityAndExactFeeForwarding() public {
        assertEq(adapter.version(), "zedge-pyth-boundary-v1");
        assertEq(address(adapter.pyth()), address(pyth));
        assertEq(adapter.quoteFee(valid()), 3);
        IBoundaryOracle.Observation memory result =
            adapter.verifyBoundary{value: 3}(FEED, 1000, 1010, valid());
        assertEq(result.price, 100_000);
        assertEq(result.publishTime, 1000);
        assertEq(result.confidence, 1);
        assertEq(result.exponent, -8);
        assertEq(pyth.uniqueCalls(), 1);
        assertEq(address(adapter).balance, 0);
        assertEq(address(pyth).balance, 3);
    }

    function testRejectNoCodeAndInvalidWindow() public {
        vm.expectRevert(PythBoundaryOracle.InvalidVerifier.selector);
        new PythBoundaryOracle(address(0));
        vm.expectRevert(PythBoundaryOracle.InvalidWindow.selector);
        adapter.verifyBoundary{value: 3}(FEED, 1011, 1010, valid());
        vm.expectRevert(PythBoundaryOracle.InvalidWindow.selector);
        adapter.verifyBoundary{value: 3}(bytes32(0), 1000, 1010, valid());
    }

    function testUnderAndOverPaymentRejected() public {
        vm.expectRevert(abi.encodeWithSelector(PythBoundaryOracle.IncorrectFee.selector, 3, 2));
        adapter.verifyBoundary{value: 2}(FEED, 1000, 1010, valid());
        vm.expectRevert(abi.encodeWithSelector(PythBoundaryOracle.IncorrectFee.selector, 3, 4));
        adapter.verifyBoundary{value: 4}(FEED, 1000, 1010, valid());
        assertEq(address(adapter).balance, 0);
        assertEq(address(pyth).balance, 0);
    }

    function testCannotChooseSecondPriceAfterBoundary() public {
        vm.warp(1005);
        vm.expectRevert("not unique boundary");
        adapter.verifyBoundary{value: 3}(FEED, 1000, 1010, evidence(FEED, 200_000, 1005, 1000));
        assertEq(pyth.uniqueCalls(), 0);
    }

    function testRejectProviderWrongFeedLengthAndTimestamp() public {
        for (uint8 i = 1; i <= uint8(MockUniquePyth.Response.AboveWindow); ++i) {
            pyth.setResponse(MockUniquePyth.Response(i));
            vm.expectRevert(PythBoundaryOracle.InvalidOracleResponse.selector);
            adapter.verifyBoundary{value: 3}(FEED, 1000, 1010, valid());
        }
    }

    function testVerifierRevertCannotBecomeUnsignedFallback() public {
        pyth.setFailure(true);
        vm.expectRevert("test verifier unavailable");
        adapter.verifyBoundary{value: 3}(FEED, 1000, 1010, valid());
        assertEq(pyth.uniqueCalls(), 0);
    }

    function testMalformedEmptyAndOversizedEvidenceRejected() public {
        vm.expectRevert(PythBoundaryOracle.InvalidEvidence.selector);
        adapter.quoteFee("");
        bytes[] memory none = new bytes[](0);
        vm.expectRevert(PythBoundaryOracle.InvalidEvidence.selector);
        adapter.quoteFee(abi.encode(none));
        bytes[] memory empty = new bytes[](1);
        vm.expectRevert(PythBoundaryOracle.InvalidEvidence.selector);
        adapter.quoteFee(abi.encode(empty));
        bytes[] memory excess = new bytes[](17);
        vm.expectRevert(PythBoundaryOracle.InvalidEvidence.selector);
        adapter.quoteFee(abi.encode(excess));
        vm.expectRevert(PythBoundaryOracle.InvalidEvidence.selector);
        adapter.quoteFee(new bytes(65_537));
        vm.expectRevert();
        adapter.quoteFee(hex"010203");
    }

    function testCannotChooseWrongFeedOrOutsideWindow() public {
        vm.expectRevert("not unique boundary");
        adapter.verifyBoundary{value: 3}(FEED, 1000, 1010, evidence(bytes32(uint256(5)), 1, 1000, 999));
        vm.expectRevert("outside window");
        adapter.verifyBoundary{value: 3}(FEED, 1000, 1010, evidence(FEED, 1, 999, 998));
    }

    function testRegistryThroughConcreteAdapterWithTestVerifier() public {
        RoundRegistry.Config memory config = RoundRegistry.Config(
            address(adapter),
            address(new MockCollateral()),
            FEED,
            keccak256("TEST-ETH-USD"),
            -8,
            -8,
            10,
            20,
            60,
            30,
            100
        );
        RoundRegistry registry = new RoundRegistry(config);
        bytes32 id = registry.createRound(RoundRegistry.Asset.BTC, 300, 1200);
        vm.warp(1200);
        registry.recordOpening{value: 3}(id, evidence(FEED, 100_000, 1200, 1199));
        vm.warp(1500);
        registry.resolveRound{value: 3}(id, evidence(FEED, 100_001, 1500, 1499));
        assertEq(uint8(registry.getRound(id).outcome), uint8(RoundRegistry.Outcome.Up));
        assertEq(address(registry).balance, 0);
        assertEq(address(adapter).balance, 0);
        assertEq(address(pyth).balance, 6);
    }

    function testFuzzAdapterPreservesExactSignedUnits(int64 price, uint64 confidence) public {
        PythStructs.Price memory observation = PythStructs.Price(price, confidence, -8, 1000);
        bytes[] memory updates = new bytes[](1);
        updates[0] = abi.encode(PythStructs.PriceFeed(FEED, observation, observation), uint64(999));
        IBoundaryOracle.Observation memory result =
            adapter.verifyBoundary{value: 3}(FEED, 1000, 1010, abi.encode(updates));
        // Registry owns positive-price/confidence/exponent policy; adapter never rounds or normalizes.
        assertEq(result.price, price);
        assertEq(result.confidence, confidence);
        assertEq(result.exponent, -8);
    }
}
