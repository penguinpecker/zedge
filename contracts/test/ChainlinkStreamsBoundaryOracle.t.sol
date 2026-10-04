// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ChainlinkStreamsBoundaryOracle} from "../src/ChainlinkStreamsBoundaryOracle.sol";
import {IStreamsBoundaryOracle} from "../src/interfaces/IStreamsBoundaryOracle.sol";
import {MockStreamsVerifier} from "./mocks/MockStreamsVerifier.sol";

contract ChainlinkStreamsBoundaryOracleTest is Test {
    uint32 internal constant START = 1_800_000_000;
    bytes32 internal constant BTC = bytes32((uint256(3) << 240) | 1);
    bytes32 internal constant ETH = bytes32((uint256(3) << 240) | 2);
    bytes internal evidence = hex"aabbccdd";
    MockStreamsVerifier internal verifier;
    ChainlinkStreamsBoundaryOracle internal oracle;

    function setUp() public {
        vm.warp(START + 5);
        verifier = new MockStreamsVerifier();
        oracle = new ChainlinkStreamsBoundaryOracle(address(verifier), BTC, 18, ETH, 8);
        configure(report());
    }

    function report() internal pure returns (ChainlinkStreamsBoundaryOracle.ReportV3 memory) {
        return ChainlinkStreamsBoundaryOracle.ReportV3({
            feedId: BTC,
            validFromTimestamp: START,
            observationsTimestamp: START + 1,
            nativeFee: 123,
            linkFee: 456,
            expiresAt: START + 30,
            price: 100_000 * 1e18 + 1,
            bid: 99_999 * 1e18,
            ask: 100_001 * 1e18
        });
    }

    function configure(ChainlinkStreamsBoundaryOracle.ReportV3 memory data) internal {
        verifier.configure(evidence, abi.encode(data));
    }

    function verify() internal returns (IStreamsBoundaryOracle.Observation memory) {
        return oracle.verifyBoundary(BTC, START, START + 10, evidence);
    }

    function testImmutableIdentityAndExactPrice() public {
        IStreamsBoundaryOracle.Observation memory observed = verify();
        assertEq(oracle.version(), "zedge-chainlink-streams-boundary-v1");
        assertEq(address(oracle.verifierProxy()), address(verifier));
        assertEq(oracle.btcFeedId(), BTC);
        assertEq(oracle.ethFeedId(), ETH);
        assertEq(oracle.btcDecimals(), 18);
        assertEq(oracle.ethDecimals(), 8);
        assertEq(observed.price, 100_000 * 1e18 + 1);
        assertEq(observed.decimals, 18);
        assertEq(observed.validFromTimestamp, START);
        assertEq(observed.observationsTimestamp, START + 1);
        assertEq(observed.expiresAt, START + 30);
        assertEq(observed.reportHash, keccak256(abi.encode(report())));
        assertTrue(observed.reportHash != keccak256(evidence));
        assertEq(verifier.calls(), 1);
        assertEq(verifier.lastParameterPayload().length, 0);
        assertEq(address(oracle).balance, 0);
        assertEq(address(verifier).balance, 0);
    }

    function testETHUsesItsImmutableDecimals() public {
        ChainlinkStreamsBoundaryOracle.ReportV3 memory data = report();
        data.feedId = ETH;
        data.price = 3_000 * 1e8;
        configure(data);
        IStreamsBoundaryOracle.Observation memory observed =
            oracle.verifyBoundary(ETH, START, START + 10, evidence);
        assertEq(observed.price, 3_000 * 1e8);
        assertEq(observed.decimals, 8);
    }

    function testConstructorRejectsUntrustedShape() public {
        invalidConfig(address(1), BTC, 18, ETH, 8);
        invalidConfig(address(verifier), bytes32(0), 18, ETH, 8);
        invalidConfig(address(verifier), BTC, 18, BTC, 8);
        invalidConfig(address(verifier), bytes32((uint256(2) << 240) | 1), 18, ETH, 8);
        invalidConfig(address(verifier), BTC, 18, bytes32((uint256(4) << 240) | 2), 8);
        invalidConfig(address(verifier), BTC, 19, ETH, 8);
        invalidConfig(address(verifier), BTC, 18, ETH, 255);
    }

    function invalidConfig(address target, bytes32 btc, uint8 btcScale, bytes32 eth, uint8 ethScale)
        internal
    {
        vm.expectRevert(ChainlinkStreamsBoundaryOracle.InvalidConfig.selector);
        new ChainlinkStreamsBoundaryOracle(target, btc, btcScale, eth, ethScale);
    }

    function testRejectUnknownFeedBeforeVerifierCall() public {
        vm.expectRevert(ChainlinkStreamsBoundaryOracle.UnknownFeed.selector);
        oracle.verifyBoundary(bytes32((uint256(3) << 240) | 3), START, START + 10, evidence);
        assertEq(verifier.calls(), 0);
    }

    function testRejectInvalidBoundary() public {
        vm.expectRevert(ChainlinkStreamsBoundaryOracle.InvalidWindow.selector);
        oracle.verifyBoundary(BTC, START + 1, START, evidence);
        vm.expectRevert(ChainlinkStreamsBoundaryOracle.InvalidWindow.selector);
        oracle.verifyBoundary(BTC, 0, START, evidence);
        vm.expectRevert(ChainlinkStreamsBoundaryOracle.InvalidWindow.selector);
        oracle.verifyBoundary(BTC, START + 6, START + 10, evidence);
        assertEq(verifier.calls(), 0);
    }

    function testRejectEmptyOversizedAndForgedEvidence() public {
        vm.expectRevert(ChainlinkStreamsBoundaryOracle.InvalidEvidence.selector);
        oracle.verifyBoundary(BTC, START, START + 10, bytes(""));
        bytes memory large = new bytes(oracle.MAX_EVIDENCE_BYTES() + 1);
        vm.expectRevert(ChainlinkStreamsBoundaryOracle.InvalidEvidence.selector);
        oracle.verifyBoundary(BTC, START, START + 10, large);
        vm.expectRevert(MockStreamsVerifier.InvalidSignature.selector);
        oracle.verifyBoundary(BTC, START, START + 10, hex"aa");
        assertEq(verifier.calls(), 0);
    }

    function testVerifierRevertPropagatesWithoutFallback() public {
        verifier.setRejectSignature(true);
        vm.expectRevert(MockStreamsVerifier.InvalidSignature.selector);
        verify();
    }

    function testEvidenceAtSizeLimitPassesUnchanged() public {
        bytes memory maximum = new bytes(oracle.MAX_EVIDENCE_BYTES());
        maximum[maximum.length - 1] = bytes1(uint8(1));
        verifier.configure(maximum, abi.encode(report()));
        oracle.verifyBoundary(BTC, START, START + 10, maximum);
        assertEq(verifier.calls(), 1);
    }

    function testRejectShortLongAndNonCanonicalReportBody() public {
        verifier.configure(evidence, new bytes(287));
        expectInvalidResponse();
        verifier.configure(evidence, bytes.concat(abi.encode(report()), hex"00"));
        expectInvalidResponse();
        bytes memory malformed = abi.encode(report());
        // The validFromTimestamp word must be a canonical uint32, including its high-byte padding.
        malformed[32] = bytes1(uint8(1));
        verifier.configure(evidence, malformed);
        vm.expectRevert();
        verify();
    }

    function testRejectWrongAuthenticatedFeedAndNonPositivePrice() public {
        ChainlinkStreamsBoundaryOracle.ReportV3 memory data = report();
        data.feedId = ETH;
        reject(data);
        data = report();
        data.price = 0;
        reject(data);
        data.price = -1;
        reject(data);
        data.price = type(int192).min;
        reject(data);
    }

    function testBoundaryMustBeInsideSignedInterval() public {
        ChainlinkStreamsBoundaryOracle.ReportV3 memory data = report();
        data.validFromTimestamp = START + 1;
        reject(data);
        data.validFromTimestamp = START - 2;
        data.observationsTimestamp = START - 1;
        reject(data);
        data = report();
        data.validFromTimestamp = 0;
        reject(data);
        data = report();
        data.validFromTimestamp = START + 2;
        data.observationsTimestamp = START + 1;
        reject(data);
    }

    function testRejectLateOrFutureObservation() public {
        ChainlinkStreamsBoundaryOracle.ReportV3 memory data = report();
        data.observationsTimestamp = START + 11;
        vm.warp(START + 11);
        reject(data);
        data.observationsTimestamp = START + 6;
        vm.warp(START + 5);
        reject(data);
    }

    function testExpirationPolicyAndInclusiveEquality() public {
        ChainlinkStreamsBoundaryOracle.ReportV3 memory data = report();
        data.expiresAt = data.observationsTimestamp - 1;
        reject(data);
        data = report();
        data.expiresAt = START + 4;
        reject(data);
        data.expiresAt = START + 5;
        configure(data);
        verify();
        vm.warp(START + 6);
        expectInvalidResponse();
    }

    function testIntervalEndpointsAndMaximumDelayAreInclusive() public {
        ChainlinkStreamsBoundaryOracle.ReportV3 memory data = report();
        data.observationsTimestamp = START;
        configure(data);
        oracle.verifyBoundary(BTC, START, START, evidence);
        data.validFromTimestamp = START - 1;
        data.observationsTimestamp = START + 10;
        configure(data);
        vm.warp(START + 10);
        verify();
    }

    function testBidAskAndLegacyFeeFieldsDoNotBecomeConfidenceOrFees() public {
        ChainlinkStreamsBoundaryOracle.ReportV3 memory data = report();
        data.bid = type(int192).min;
        data.ask = type(int192).max;
        data.nativeFee = type(uint192).max;
        data.linkFee = type(uint192).max;
        configure(data);
        IStreamsBoundaryOracle.Observation memory observed = verify();
        assertEq(observed.price, data.price);
        assertEq(address(verifier).balance, 0);
    }

    function testNonpayableEntryRejectsETH() public {
        vm.deal(address(this), 1);
        (bool success,) = address(oracle).call{value: 1}(
            abi.encodeCall(IStreamsBoundaryOracle.verifyBoundary, (BTC, START, START + 10, evidence))
        );
        assertFalse(success);
        assertEq(verifier.calls(), 0);
    }

    function testVerifierCannotReenterAdapter() public {
        verifier.setCallback(
            address(oracle),
            abi.encodeCall(IStreamsBoundaryOracle.verifyBoundary, (BTC, START, START + 10, evidence))
        );
        verify();
        assertFalse(verifier.callbackSucceeded());
        assertEq(
            verifier.callbackResult(),
            abi.encodeWithSelector(ReentrancyGuard.ReentrancyGuardReentrantCall.selector)
        );
        assertEq(verifier.calls(), 1);
    }

    function testFuzzExactPositivePriceRetained(int192 candidate) public {
        vm.assume(candidate > 0);
        ChainlinkStreamsBoundaryOracle.ReportV3 memory data = report();
        data.price = candidate;
        configure(data);
        assertEq(verify().price, candidate);
    }

    function testFuzzBoundaryWindowValidation(uint32 from, uint32 observed, uint32 expires) public {
        ChainlinkStreamsBoundaryOracle.ReportV3 memory data = report();
        data.validFromTimestamp = from;
        data.observationsTimestamp = observed;
        data.expiresAt = expires;
        configure(data);
        bool valid = from > 0 && from <= START && observed >= START && observed <= START + 5
            && expires >= observed && expires >= START + 5;
        if (valid) {
            IStreamsBoundaryOracle.Observation memory result = verify();
            assertEq(result.validFromTimestamp, from);
            assertEq(result.observationsTimestamp, observed);
            assertEq(result.expiresAt, expires);
        } else {
            expectInvalidResponse();
        }
    }

    function reject(ChainlinkStreamsBoundaryOracle.ReportV3 memory data) internal {
        configure(data);
        expectInvalidResponse();
    }

    function expectInvalidResponse() internal {
        vm.expectRevert(ChainlinkStreamsBoundaryOracle.InvalidOracleResponse.selector);
        verify();
    }
}
