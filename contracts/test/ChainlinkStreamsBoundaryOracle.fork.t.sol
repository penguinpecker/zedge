// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {ChainlinkStreamsBoundaryOracle} from "../src/ChainlinkStreamsBoundaryOracle.sol";
import {IStreamsBoundaryOracle} from "../src/interfaces/IStreamsBoundaryOracle.sol";
import {BaseStreamsFixtures as Fixture} from "./mocks/BaseStreamsFixtures.sol";

/// @notice Opt-in, real-signature integration tests against the pinned public Base state.
/// @dev Run with --fork-url <public Base RPC> --fork-block-number 52156042.
/// Default local tests explicitly skip these cases. No credentials or transactions are used.
contract ChainlinkStreamsBoundaryOracleForkTest is Test {
    function forkConfigured() internal view returns (bool) {
        return block.chainid == 8453 && block.number == Fixture.BLOCK_NUMBER;
    }

    function newOracle() internal returns (ChainlinkStreamsBoundaryOracle) {
        assertEq(Fixture.VERIFIER.codehash, Fixture.VERIFIER_CODE_HASH);
        return
            new ChainlinkStreamsBoundaryOracle(Fixture.VERIFIER, Fixture.BTC_FEED, 18, Fixture.ETH_FEED, 18);
    }

    function testForkGenuineBTCAndETHPreserveExactSignedBody() public {
        vm.skip(!forkConfigured(), "requires pinned Base fork 8453/52156042");
        ChainlinkStreamsBoundaryOracle oracle = newOracle();
        bytes memory btc = Fixture.btcPayload();
        bytes memory eth = Fixture.ethPayload();
        assertEq(keccak256(btc), Fixture.BTC_PAYLOAD_HASH);
        assertEq(keccak256(eth), Fixture.ETH_PAYLOAD_HASH);
        IStreamsBoundaryOracle.Observation memory observed =
            oracle.verifyBoundary(Fixture.BTC_FEED, Fixture.BTC_TIME, Fixture.BTC_TIME, btc);
        assertEq(observed.price, Fixture.BTC_PRICE);
        assertEq(observed.decimals, 18);
        assertEq(observed.validFromTimestamp, Fixture.BTC_TIME);
        assertEq(observed.observationsTimestamp, Fixture.BTC_TIME);
        assertEq(observed.expiresAt, Fixture.BTC_EXPIRY);
        assertEq(observed.reportHash, keccak256(reportBody(btc)));
        observed = oracle.verifyBoundary(Fixture.ETH_FEED, Fixture.ETH_TIME, Fixture.ETH_TIME, eth);
        assertEq(observed.price, Fixture.ETH_PRICE);
        assertEq(observed.decimals, 18);
        assertEq(observed.validFromTimestamp, Fixture.ETH_TIME);
        assertEq(observed.observationsTimestamp, Fixture.ETH_TIME);
        assertEq(observed.expiresAt, Fixture.ETH_EXPIRY);
        assertEq(observed.reportHash, keccak256(reportBody(eth)));
        assertEq(address(oracle).balance, 0);
    }

    function testForkTamperedPriceCannotAuthenticate() public {
        vm.skip(!forkConfigured(), "requires pinned Base fork 8453/52156042");
        ChainlinkStreamsBoundaryOracle oracle = newOracle();
        bytes memory forged = Fixture.btcPayload();
        // Full payload's report begins at byte256. Alter the low byte of its seventh (price) word.
        // The ABI and positive price remain valid; the genuine DON signatures no longer authenticate it.
        forged[256 + 6 * 32 + 31] ^= bytes1(uint8(1));
        vm.expectRevert();
        oracle.verifyBoundary(Fixture.BTC_FEED, Fixture.BTC_TIME, Fixture.BTC_TIME, forged);
    }

    function testForkTamperedSignatureCannotAuthenticate() public {
        vm.skip(!forkConfigured(), "requires pinned Base fork 8453/52156042");
        ChainlinkStreamsBoundaryOracle oracle = newOracle();
        bytes memory forged = Fixture.ethPayload();
        forged[forged.length - 1] ^= bytes1(uint8(1));
        vm.expectRevert();
        oracle.verifyBoundary(Fixture.ETH_FEED, Fixture.ETH_TIME, Fixture.ETH_TIME, forged);
    }

    function testForkGenuineReportForWrongFeedFails() public {
        vm.skip(!forkConfigured(), "requires pinned Base fork 8453/52156042");
        ChainlinkStreamsBoundaryOracle oracle = newOracle();
        bytes memory eth = Fixture.ethPayload();
        vm.expectRevert(ChainlinkStreamsBoundaryOracle.InvalidOracleResponse.selector);
        oracle.verifyBoundary(Fixture.BTC_FEED, Fixture.ETH_TIME, Fixture.ETH_TIME, eth);
    }

    function testForkReportCannotBeSelectedForDifferentBoundary() public {
        vm.skip(!forkConfigured(), "requires pinned Base fork 8453/52156042");
        ChainlinkStreamsBoundaryOracle oracle = newOracle();
        bytes memory btc = Fixture.btcPayload();
        vm.expectRevert(ChainlinkStreamsBoundaryOracle.InvalidOracleResponse.selector);
        oracle.verifyBoundary(Fixture.BTC_FEED, Fixture.BTC_TIME - 1, Fixture.BTC_TIME + 10, btc);
        vm.expectRevert(ChainlinkStreamsBoundaryOracle.InvalidOracleResponse.selector);
        oracle.verifyBoundary(Fixture.BTC_FEED, Fixture.BTC_TIME + 1, Fixture.BTC_TIME + 10, btc);
    }

    function testForkAuthenticatedButExpiredReportFails() public {
        vm.skip(!forkConfigured(), "requires pinned Base fork 8453/52156042");
        ChainlinkStreamsBoundaryOracle oracle = newOracle();
        bytes memory btc = Fixture.btcPayload();
        vm.warp(uint256(Fixture.BTC_EXPIRY) + 1);
        vm.expectRevert(ChainlinkStreamsBoundaryOracle.InvalidOracleResponse.selector);
        oracle.verifyBoundary(Fixture.BTC_FEED, Fixture.BTC_TIME, Fixture.BTC_TIME, btc);
    }

    function reportBody(bytes memory payload) internal pure returns (bytes memory body) {
        (, body,,,) = abi.decode(payload, (bytes32[3], bytes, bytes32[], bytes32[], bytes32));
    }
}
