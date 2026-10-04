// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {ChainlinkStreamsBoundaryOracle} from "../src/ChainlinkStreamsBoundaryOracle.sol";
import {BaseStreamsPublisher} from "../src/BaseStreamsPublisher.sol";
import {HorizenStreamsOracle} from "../src/HorizenStreamsOracle.sol";
import {IStreamsBoundaryOracle} from "../src/interfaces/IStreamsBoundaryOracle.sol";
import {INativeOracleMessenger} from "../src/interfaces/INativeOracleMessenger.sol";
import {StreamsOracleRoute} from "../src/libraries/StreamsOracleRoute.sol";
import {BaseStreamsFixtures as Fixture} from "./mocks/BaseStreamsFixtures.sol";

interface IForkNativeMessenger is INativeOracleMessenger {
    function relayMessage(
        uint256 nonce,
        address sender,
        address target,
        uint256 value,
        uint256 minGasLimit,
        bytes calldata message
    ) external payable;
    function successfulMessages(bytes32 messageHash) external view returns (bool);
    function failedMessages(bytes32 messageHash) external view returns (bool);
}

interface IForkAddressManager {
    function getAddress(string calldata name) external view returns (address);
}

/// @notice Opt-in two-fork ABI/authentication integration, with genuine DON reports and native messenger code.
/// @dev Base: --fork-url https://mainnet.base.org --fork-block-number 52156042.
/// The second fork uses public Horizen RPC at 27704171. The destination deposit's authenticated messenger
/// alias is impersonated LOCALLY: OP derivation, live relay service, latency and finality are NOT tested.
/// Fixture timestamps are not aligned round boundaries, so this is not a complete round lifecycle test.
/// Verified with official Forge 1.4.4. Forge 1.7.1 currently panics in its mixed-fork OP fee executor.
/// Use isolated --out and --cache-path directories when testing with an alternate Foundry version.
contract NativeStreamsRoutingForkTest is Test {
    uint256 private constant HORIZEN_BLOCK = 27_704_171;
    address private constant BASE_MESSENGER = 0x9F5e33f901ad50B50d6A27f63aDaBEA4c81e953c;
    address private constant HORIZEN_MESSENGER = 0x4200000000000000000000000000000000000007;
    address private constant ADDRESS_MANAGER = 0x23E9345926Ef161027292D60f80BE43Ad01bdf8F;
    address private constant BASE_IMPLEMENTATION = 0x5D5a095665886119693F0B41d8DFeE78da033e8B;
    address private constant HORIZEN_IMPLEMENTATION = 0xC0d3c0d3c0D3c0D3C0d3C0D3C0D3c0d3c0d30007;
    bytes32 private constant EIP1967_IMPLEMENTATION =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 private constant SENT_MESSAGE = keccak256("SentMessage(address,address,bytes,uint256,uint256)");
    bytes32 private constant SENT_EXTENSION = keccak256("SentMessageExtension1(address,uint256)");
    uint32 private constant DESTINATION_GAS = 600_000;

    struct Harness {
        uint256 baseFork;
        uint256 horizenFork;
        BaseStreamsPublisher publisher;
        HorizenStreamsOracle receiver;
    }

    struct Message {
        uint256 nonce;
        address sender;
        address target;
        uint256 value;
        uint256 minGasLimit;
        bytes data;
    }

    function testForkRealVerificationNativeSendAndAuthenticatedRelay() public {
        vm.skip(
            block.chainid != 8453 || block.number != Fixture.BLOCK_NUMBER,
            "requires pinned Base fork 8453/52156042 and public Horizen archive RPC"
        );
        Harness memory h = buildRoute();
        vm.recordLogs();
        IStreamsBoundaryOracle.Observation memory original =
            h.publisher.publishBoundary(Fixture.BTC_FEED, Fixture.BTC_TIME, Fixture.btcPayload());
        Message memory first = sentMessage(vm.getRecordedLogs());
        assertEq(first.sender, address(h.publisher));
        assertEq(first.target, address(h.receiver));
        assertEq(first.minGasLimit, DESTINATION_GAS);
        assertEq(first.value, 0);
        assertEq(original.price, Fixture.BTC_PRICE);
        assertEq(original.decimals, 18);

        // A real source-messenger call by another sender cannot masquerade as our publisher.
        vm.recordLogs();
        vm.prank(address(0x1234));
        IForkNativeMessenger(BASE_MESSENGER).sendMessage(first.target, first.data, DESTINATION_GAS);
        Message memory attack = sentMessage(vm.getRecordedLogs());
        assertEq(attack.sender, address(0x1234));

        vm.selectFork(h.horizenFork);
        assertEq(address(h.publisher).code.length, 0, "source contract must not be a destination shadow");
        bytes32 expectedRouteHash = h.receiver.routeHash();
        vm.expectRevert(HorizenStreamsOracle.UnauthorizedMessenger.selector);
        h.receiver.receiveObservation(expectedRouteHash, Fixture.BTC_FEED, Fixture.BTC_TIME, original);
        // A caller without the native deposit's aliased sender cannot introduce a fresh relay.
        vm.expectRevert();
        invokeRelay(first);
        relayFromNativeDepositAlias(attack);
        assertTrue(IForkNativeMessenger(HORIZEN_MESSENGER).failedMessages(messageHash(attack)));
        assertFalse(IForkNativeMessenger(HORIZEN_MESSENGER).successfulMessages(messageHash(attack)));
        assertEq(h.receiver.getObservation(Fixture.BTC_FEED, Fixture.BTC_TIME).reportHash, bytes32(0));

        relayFromNativeDepositAlias(first);
        assertTrue(IForkNativeMessenger(HORIZEN_MESSENGER).successfulMessages(messageHash(first)));
        assertFalse(IForkNativeMessenger(HORIZEN_MESSENGER).failedMessages(messageHash(first)));
        IStreamsBoundaryOracle.Observation memory received =
            h.receiver.verifyBoundary(Fixture.BTC_FEED, Fixture.BTC_TIME, Fixture.BTC_TIME + 60, "");
        assertEq(abi.encode(received), abi.encode(original));

        // Native replay protection rejects the already-successful original message nonce.
        vm.expectRevert();
        relayFromNativeDepositAlias(first);

        vm.selectFork(h.baseFork);
        vm.recordLogs();
        vm.prank(address(0x5678));
        h.publisher.resendBoundary(Fixture.BTC_FEED, Fixture.BTC_TIME);
        Message memory duplicate = sentMessage(vm.getRecordedLogs());
        assertEq(duplicate.sender, first.sender);
        assertEq(duplicate.data, first.data);
        assertGt(duplicate.nonce, first.nonce);
        vm.selectFork(h.horizenFork);
        // A new source nonce may deliver the same authenticated observation; the cache is idempotent.
        relayFromNativeDepositAlias(duplicate);
        assertTrue(IForkNativeMessenger(HORIZEN_MESSENGER).successfulMessages(messageHash(duplicate)));
        received = h.receiver.verifyBoundary(Fixture.BTC_FEED, Fixture.BTC_TIME, Fixture.BTC_TIME + 60, "");
        assertEq(abi.encode(received), abi.encode(original));
        // Finish in the original fork so Foundry applies the original transaction's OP fee context.
        vm.selectFork(h.baseFork);
    }

    function buildRoute() private returns (Harness memory h) {
        h.baseFork = vm.activeFork();
        checkBaseDependencies();
        uint256 sourceTimestamp = block.timestamp;
        ChainlinkStreamsBoundaryOracle source =
            new ChainlinkStreamsBoundaryOracle(Fixture.VERIFIER, Fixture.BTC_FEED, 18, Fixture.ETH_FEED, 18);
        h.horizenFork = vm.createFork("https://horizen.calderachain.xyz/http", HORIZEN_BLOCK);
        // Test contracts are normally persistent; declare this explicitly for nonce/address prediction.
        vm.makePersistent(address(this));
        uint64 nextNonce = vm.getNonce(address(this));
        StreamsOracleRoute.Config memory route = StreamsOracleRoute.Config({
            sourceChainId: 8453,
            destinationChainId: 26514,
            sourceMessenger: BASE_MESSENGER,
            destinationMessenger: HORIZEN_MESSENGER,
            sourceOracle: address(source),
            publisher: vm.computeCreateAddress(address(this), nextNonce + 1),
            destinationOracle: vm.computeCreateAddress(address(this), nextNonce),
            btcFeedId: Fixture.BTC_FEED,
            ethFeedId: Fixture.ETH_FEED,
            btcDecimals: 18,
            ethDecimals: 18,
            observationWindow: 60,
            minimumGasLimit: DESTINATION_GAS
        });
        vm.selectFork(h.horizenFork);
        checkHorizenDependencies();
        assertGe(block.timestamp, sourceTimestamp, "destination snapshot must follow source snapshot");
        assertEq(vm.getNonce(address(this)), nextNonce);
        h.receiver = new HorizenStreamsOracle(route);
        vm.selectFork(h.baseFork);
        assertEq(address(h.receiver).code.length, 0, "destination contract must not be a source shadow");
        h.publisher = new BaseStreamsPublisher(route);
        bytes32 routeHash = h.publisher.routeHash();
        vm.selectFork(h.horizenFork);
        assertEq(h.receiver.routeHash(), routeHash);
        vm.selectFork(h.baseFork);
    }

    function checkBaseDependencies() private view {
        assertEq(Fixture.VERIFIER.codehash, Fixture.VERIFIER_CODE_HASH);
        assertEq(BASE_MESSENGER.codehash, 0x06643e7d44538ba353995b6b77634e1c5bd1282ae7902f2b1aceaec97cf572ed);
        // ResolvedDelegateProxy stores its AddressManager in mapping(address=>address) at slot1.
        assertEq(
            vm.load(BASE_MESSENGER, keccak256(abi.encode(BASE_MESSENGER, uint256(1)))),
            bytes32(uint256(uint160(ADDRESS_MANAGER)))
        );
        bytes memory implementationName = bytes("OVM_L1CrossDomainMessenger");
        assertLt(implementationName.length, 32);
        assertEq(
            vm.load(BASE_MESSENGER, keccak256(abi.encode(BASE_MESSENGER, uint256(0)))),
            bytes32(implementationName) | bytes32(uint256(implementationName.length * 2))
        );
        assertEq(
            IForkAddressManager(ADDRESS_MANAGER).getAddress("OVM_L1CrossDomainMessenger"), BASE_IMPLEMENTATION
        );
        assertEq(
            BASE_IMPLEMENTATION.codehash, 0x13a19b3f05901a5bdae8022c7161f99fd1b8705cbd15b36889ff7b3cea782bdf
        );
        assertEq(IForkNativeMessenger(BASE_MESSENGER).otherMessenger(), HORIZEN_MESSENGER);
    }

    function checkHorizenDependencies() private view {
        assertEq(block.chainid, 26514);
        assertEq(
            HORIZEN_MESSENGER.codehash, 0xfa8c9db6c6cab7108dea276f4cd09d575674eb0852c0fa3187e59e98ef977998
        );
        assertEq(
            vm.load(HORIZEN_MESSENGER, EIP1967_IMPLEMENTATION),
            bytes32(uint256(uint160(HORIZEN_IMPLEMENTATION)))
        );
        assertEq(
            HORIZEN_IMPLEMENTATION.codehash,
            0x76cd7dfa97d24622c7c50b51d58fd3658cf1bb0378b3d217d014a82474d90f5a
        );
        assertEq(IForkNativeMessenger(HORIZEN_MESSENGER).otherMessenger(), BASE_MESSENGER);
    }

    function sentMessage(Vm.Log[] memory logs) private pure returns (Message memory result) {
        uint256 sent;
        uint256 extended;
        address extensionSender;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory item = logs[i];
            if (item.emitter != BASE_MESSENGER || item.topics.length != 2) continue;
            if (item.topics[0] == SENT_MESSAGE) {
                ++sent;
                result.target = address(uint160(uint256(item.topics[1])));
                (result.sender, result.data, result.nonce, result.minGasLimit) =
                    abi.decode(item.data, (address, bytes, uint256, uint256));
            } else if (item.topics[0] == SENT_EXTENSION) {
                ++extended;
                extensionSender = address(uint160(uint256(item.topics[1])));
                result.value = abi.decode(item.data, (uint256));
            }
        }
        require(sent == 1 && extended == 1, "expected exactly one native message");
        require(extensionSender == result.sender, "native event sender mismatch");
        require(result.nonce >> 240 == 1, "expected native message version1");
    }

    function relayFromNativeDepositAlias(Message memory message) private {
        address nativeDepositAlias;
        unchecked {
            nativeDepositAlias =
                address(uint160(BASE_MESSENGER) + uint160(0x1111000000000000000000000000000000001111));
        }
        vm.prank(nativeDepositAlias);
        invokeRelay(message);
    }

    function invokeRelay(Message memory message) private {
        IForkNativeMessenger(HORIZEN_MESSENGER)
            .relayMessage(
                message.nonce,
                message.sender,
                message.target,
                message.value,
                message.minGasLimit,
                message.data
            );
    }

    function messageHash(Message memory message) private pure returns (bytes32) {
        return keccak256(
            abi.encodeCall(
                IForkNativeMessenger.relayMessage,
                (
                    message.nonce,
                    message.sender,
                    message.target,
                    message.value,
                    message.minGasLimit,
                    message.data
                )
            )
        );
    }
}
