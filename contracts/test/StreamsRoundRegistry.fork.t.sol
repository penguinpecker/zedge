// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {HorizenStreamsOracle} from "../src/HorizenStreamsOracle.sol";
import {StreamsRoundRegistry} from "../src/StreamsRoundRegistry.sol";
import {IStreamsObservationReceiver} from "../src/interfaces/INativeOracleMessenger.sol";
import {IStreamsBoundaryOracle} from "../src/interfaces/IStreamsBoundaryOracle.sol";
import {BaseStreamsFixtures as Fixture} from "./mocks/BaseStreamsFixtures.sol";
import {StreamsRegistryProxy} from "./mocks/MockStreamsBoundaryOracle.sol";
import {IForkNativeMessenger} from "./NativeStreamsRouting.fork.t.sol";

/// @notice Opt-in: the proxied registry with the planned mainnet configuration against the LIVE Horizen
/// price cache and the live native messenger code.
/// @dev Run alone, once: forge test --match-path test/StreamsRoundRegistry.fork.t.sol
///   --fork-url https://horizen.calderachain.xyz/http --fork-block-number 27708000
/// The Base messenger's deposit alias is impersonated LOCALLY, so the two round prices are test values
/// that no Chainlink report backs; OP derivation, relay latency and finality are NOT tested. Nothing is
/// sent to a real chain. Default offline runs skip this test; a skip is not a passed integration.
contract StreamsRoundRegistryForkTest is Test {
    uint256 private constant FORK_BLOCK = 27_708_000;
    HorizenStreamsOracle private constant CACHE =
        HorizenStreamsOracle(0xc800C3F18D35D492aE6b07655D7f31bFE98A4B6B);
    IForkNativeMessenger private constant MESSENGER =
        IForkNativeMessenger(0x4200000000000000000000000000000000000007);
    address private constant BASE_MESSENGER = 0x9F5e33f901ad50B50d6A27f63aDaBEA4c81e953c;
    address private constant PUBLISHER = 0xA8abACbD25c9795C3Ef0701184B18Aad6F98C006;
    address private constant USDC_E = 0xDF7108f8B10F9b9eC1aba01CCa057268cbf86B6c;
    bytes32 private constant ROUTE_HASH = 0xdd0243acfe5c168f4189af435f907cd3dd4a26085faf228e721ddee4e87ac36b;
    // keccak256(abi.encode(rules version string, 26514, the Config below)); independent of the proxy address.
    bytes32 private constant PLANNED_RULES_HASH =
        0x65e485f8468fda2de9d8681ee9fbbff779acabf1451e29a3d2cb2248b2a30ba6;
    uint32 private constant DELIVERY_GAS = 600_000;
    // Version-1 message nonces far above any the real source messenger has issued.
    uint256 private nextNonce = (uint256(1) << 240) | (uint256(1) << 200);

    function testForkProxiedRegistryOpensAndResolvesFromLiveCache() public {
        vm.skip(
            block.chainid != 26514 || block.number != FORK_BLOCK,
            "requires pinned public Horizen fork 26514/27708000"
        );
        assertEq(address(CACHE).codehash, 0x3996abf69236d59a30795bc2c4262771bf342cd47d76c99c15e4e48d4c50c459);
        assertEq(CACHE.routeHash(), ROUTE_HASH);
        // The genuine smoke observation delivered on 2026-10-04 is readable through the same view.
        assertEq(CACHE.getObservation(Fixture.BTC_FEED, Fixture.BTC_TIME).price, Fixture.BTC_PRICE);

        StreamsRoundRegistry registry = StreamsRegistryProxy.deploy(
            StreamsRoundRegistry.Config(
                address(CACHE), USDC_E, Fixture.BTC_FEED, Fixture.ETH_FEED, 18, 18, 60, 150, 5 minutes, 30
            ),
            address(this)
        );
        assertEq(registry.rulesHash(), PLANNED_RULES_HASH);
        assertEq(address(registry.oracle()), address(CACHE));

        uint32 start = uint32((block.timestamp / 300 + 1) * 300);
        bytes32 id = registry.createRound(StreamsRoundRegistry.Asset.BTC, 300, start);
        vm.warp(start + 24);
        vm.expectRevert(HorizenStreamsOracle.MissingObservation.selector);
        registry.recordOpening(id, "");
        deliver(start, 97_000e18);
        registry.recordOpening(id, "");
        assertTrue(registry.canTrade(id));

        // The closing price is delivered later than the whole five-minute void grace.
        vm.warp(uint256(start) + 300 + 60 + 5 minutes + 1);
        assertEq(uint8(registry.phase(id)), uint8(StreamsRoundRegistry.Phase.Voidable));
        deliver(start + 300, 97_000e18 - 1);
        assertEq(uint8(registry.phase(id)), uint8(StreamsRoundRegistry.Phase.ResolutionPending));
        vm.expectRevert(StreamsRoundRegistry.ClosingEvidenceAvailable.selector);
        registry.voidRound(id);
        registry.resolveRound(id, "");

        StreamsRoundRegistry.Round memory round = registry.getRound(id);
        assertEq(uint8(round.outcome), uint8(StreamsRoundRegistry.Outcome.Down));
        assertEq(round.opening.price, 97_000e18);
        assertEq(round.closing.price, 97_000e18 - 1);
        (uint8 up, uint8 down, uint8 denominator) = registry.payoutNumerators(id);
        assertEq(up, 0);
        assertEq(down, 2);
        assertEq(denominator, 2);
    }

    /// @dev The live L2 messenger relays to the live cache as if the pinned Base publisher had sent it.
    function deliver(uint32 boundary, int192 price) private {
        IStreamsBoundaryOracle.Observation memory observation = IStreamsBoundaryOracle.Observation(
            price, boundary, boundary + 1, boundary + 30, keccak256(abi.encode(boundary, price)), 18
        );
        bytes memory message = abi.encodeCall(
            IStreamsObservationReceiver.receiveObservation,
            (ROUTE_HASH, Fixture.BTC_FEED, boundary, observation)
        );
        uint256 nonce = nextNonce++;
        address nativeDepositAlias;
        unchecked {
            nativeDepositAlias =
                address(uint160(BASE_MESSENGER) + uint160(0x1111000000000000000000000000000000001111));
        }
        vm.prank(nativeDepositAlias);
        MESSENGER.relayMessage(nonce, PUBLISHER, address(CACHE), 0, DELIVERY_GAS, message);
        assertTrue(
            MESSENGER.successfulMessages(
                keccak256(
                    abi.encodeCall(
                        IForkNativeMessenger.relayMessage,
                        (nonce, PUBLISHER, address(CACHE), 0, DELIVERY_GAS, message)
                    )
                )
            )
        );
        assertEq(CACHE.getObservation(Fixture.BTC_FEED, boundary).reportHash, observation.reportHash);
    }
}
