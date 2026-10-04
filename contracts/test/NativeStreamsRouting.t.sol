// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {BaseStreamsPublisher} from "../src/BaseStreamsPublisher.sol";
import {HorizenStreamsOracle} from "../src/HorizenStreamsOracle.sol";
import {IStreamsBoundaryOracle} from "../src/interfaces/IStreamsBoundaryOracle.sol";
import {
    INativeOracleMessenger,
    IConfiguredStreamsOracle,
    IStreamsObservationReceiver
} from "../src/interfaces/INativeOracleMessenger.sol";
import {StreamsOracleRoute} from "../src/libraries/StreamsOracleRoute.sol";

contract RoutingOracleFixture is IConfiguredStreamsOracle {
    bytes32 public constant btcFeedId = bytes32((uint256(3) << 240) | 1);
    bytes32 public constant ethFeedId = bytes32((uint256(3) << 240) | 2);
    uint8 public constant btcDecimals = 18;
    uint8 public constant ethDecimals = 8;
    Observation private _observation;
    address private _reentryTarget;
    bytes private _reentryData;
    bool public reentrySucceeded;
    bytes public reentryResult;

    function version() external pure returns (string memory) {
        return "unsigned-routing-test-fixture";
    }

    function setObservation(Observation memory observation) external {
        _observation = observation;
    }

    function setReentry(address target, bytes memory data) external {
        _reentryTarget = target;
        _reentryData = data;
    }

    function verifyBoundary(bytes32, uint64, uint64, bytes calldata) external returns (Observation memory) {
        if (_reentryTarget != address(0)) {
            (reentrySucceeded, reentryResult) = _reentryTarget.call(_reentryData);
        }
        return _observation;
    }
}

contract NativeMessengerFixture is INativeOracleMessenger {
    address public otherMessenger;
    address public xDomainMessageSender;
    address public target;
    bytes public message;
    uint32 public gasLimit;
    bool public failSend;

    function configure(address counterpart) external {
        otherMessenger = counterpart;
    }

    function setFailSend(bool fail) external {
        failSend = fail;
    }

    function sendMessage(address target_, bytes calldata message_, uint32 minGasLimit) external payable {
        require(!failSend, "fixture send failure");
        require(msg.value == 0, "unexpected value");
        target = target_;
        message = message_;
        gasLimit = minGasLimit;
    }

    function relay(address sender, address target_, bytes memory message_) external {
        xDomainMessageSender = sender;
        (bool success, bytes memory result) = target_.call(message_);
        xDomainMessageSender = address(0);
        if (!success) {
            assembly ("memory-safe") {
                revert(add(result, 32), mload(result))
            }
        }
    }
}

contract NativeStreamsRoutingTest is Test {
    uint256 private constant BASE = 8453;
    uint256 private constant HORIZEN = 26514;
    uint64 private constant BOUNDARY = 1000;

    RoutingOracleFixture private source;
    NativeMessengerFixture private parentMessenger;
    NativeMessengerFixture private childMessenger;
    BaseStreamsPublisher private publisher;
    HorizenStreamsOracle private receiver;
    StreamsOracleRoute.Config private route;
    IStreamsBoundaryOracle.Observation private observation;

    function setUp() public {
        vm.chainId(BASE);
        vm.warp(1003);
        source = new RoutingOracleFixture();
        parentMessenger = new NativeMessengerFixture();
        childMessenger = new NativeMessengerFixture();
        parentMessenger.configure(address(childMessenger));
        childMessenger.configure(address(parentMessenger));
        uint64 nextNonce = vm.getNonce(address(this));
        route = StreamsOracleRoute.Config({
            sourceChainId: BASE,
            destinationChainId: HORIZEN,
            sourceMessenger: address(parentMessenger),
            destinationMessenger: address(childMessenger),
            sourceOracle: address(source),
            publisher: vm.computeCreateAddress(address(this), nextNonce + 1),
            destinationOracle: vm.computeCreateAddress(address(this), nextNonce),
            btcFeedId: source.btcFeedId(),
            ethFeedId: source.ethFeedId(),
            btcDecimals: 18,
            ethDecimals: 8,
            observationWindow: 60,
            minimumGasLimit: 600_000
        });
        vm.chainId(HORIZEN);
        receiver = new HorizenStreamsOracle(route);
        vm.chainId(BASE);
        publisher = new BaseStreamsPublisher(route);
        observation = IStreamsBoundaryOracle.Observation({
            price: 97000123456789012345678,
            validFromTimestamp: 999,
            observationsTimestamp: 1002,
            expiresAt: 1010,
            reportHash: keccak256("already authenticated test body"),
            decimals: 18
        });
        source.setObservation(observation);
    }

    function testPublishAndReceiveExactPrecision() public {
        assertEq(publisher.routeHash(), receiver.routeHash());
        publisher.publishBoundary(route.btcFeedId, BOUNDARY, hex"01");
        assertEq(parentMessenger.target(), address(receiver));
        assertEq(parentMessenger.gasLimit(), 600_000);
        vm.chainId(HORIZEN);
        _relay();
        IStreamsBoundaryOracle.Observation memory result =
            receiver.verifyBoundary(route.btcFeedId, BOUNDARY, 1060, "");
        assertEq(abi.encode(result), abi.encode(observation));
    }

    function testDeliveryAndResendRemainValidAfterReportExpiry() public {
        publisher.publishBoundary(route.btcFeedId, BOUNDARY, hex"01");
        vm.warp(1200);
        vm.prank(address(0x1234));
        publisher.resendBoundary(route.btcFeedId, BOUNDARY);
        vm.chainId(HORIZEN);
        _relay();
        assertEq(receiver.verifyBoundary(route.btcFeedId, BOUNDARY, 1060, "").price, observation.price);
        // This proves cached authenticity only. The separate registry must enforce its arrival deadline.
    }

    function testExpiredReportCannotBeFirstPublished() public {
        vm.warp(1011);
        vm.expectRevert(StreamsOracleRoute.InvalidObservation.selector);
        publisher.publishBoundary(route.btcFeedId, BOUNDARY, hex"01");
        assertEq(publisher.getObservation(route.btcFeedId, BOUNDARY).reportHash, bytes32(0));
    }

    function testExactDuplicateIsIdempotentAndConflictRejected() public {
        publisher.publishBoundary(route.btcFeedId, BOUNDARY, hex"01");
        vm.chainId(HORIZEN);
        _relay();
        _relay();
        observation.price += 1;
        bytes memory message = _encode(observation, receiver.routeHash(), route.btcFeedId);
        vm.expectRevert(HorizenStreamsOracle.ConflictingObservation.selector);
        childMessenger.relay(address(publisher), address(receiver), message);
        assertEq(receiver.getObservation(route.btcFeedId, BOUNDARY).price, observation.price - 1);
    }

    function testPublisherCannotOverwriteAuthenticatedObservation() public {
        publisher.publishBoundary(route.btcFeedId, BOUNDARY, hex"01");
        observation.reportHash = keccak256("different authenticated body");
        source.setObservation(observation);
        vm.expectRevert(BaseStreamsPublisher.ConflictingObservation.selector);
        publisher.publishBoundary(route.btcFeedId, BOUNDARY, hex"02");
    }

    function testDirectSenderAndForgedRemotePublisherRejected() public {
        vm.chainId(HORIZEN);
        bytes32 domain = receiver.routeHash();
        vm.expectRevert(HorizenStreamsOracle.UnauthorizedMessenger.selector);
        receiver.receiveObservation(domain, route.btcFeedId, BOUNDARY, observation);
        bytes memory message = _encode(observation, domain, route.btcFeedId);
        vm.expectRevert(HorizenStreamsOracle.UnauthorizedMessenger.selector);
        childMessenger.relay(address(0x1234), address(receiver), message);
        vm.expectRevert(HorizenStreamsOracle.UnauthorizedMessenger.selector);
        parentMessenger.relay(address(publisher), address(receiver), message);
    }

    function testWrongRouteAndUnknownFeedRejected() public {
        vm.chainId(HORIZEN);
        bytes memory message = _encode(observation, bytes32(uint256(123)), route.btcFeedId);
        vm.expectRevert(HorizenStreamsOracle.WrongRoute.selector);
        childMessenger.relay(address(publisher), address(receiver), message);
        message = _encode(observation, receiver.routeHash(), bytes32(uint256(123)));
        vm.expectRevert(HorizenStreamsOracle.UnknownFeed.selector);
        childMessenger.relay(address(publisher), address(receiver), message);
    }

    function testWrongChainFailsClosed() public {
        bytes32 domain = receiver.routeHash();
        vm.chainId(HORIZEN);
        vm.expectRevert(BaseStreamsPublisher.WrongChain.selector);
        publisher.publishBoundary(route.btcFeedId, BOUNDARY, hex"01");
        vm.expectRevert(BaseStreamsPublisher.WrongChain.selector);
        publisher.resendBoundary(route.btcFeedId, BOUNDARY);
        vm.chainId(BASE);
        vm.expectRevert(HorizenStreamsOracle.WrongChain.selector);
        receiver.receiveObservation(domain, route.btcFeedId, BOUNDARY, observation);
        vm.expectRevert(HorizenStreamsOracle.WrongChain.selector);
        receiver.verifyBoundary(route.btcFeedId, BOUNDARY, 1060, "");
    }

    function testLocalUnsignedEvidenceAndMissingResultRejected() public {
        vm.chainId(HORIZEN);
        vm.expectRevert(HorizenStreamsOracle.InvalidEvidence.selector);
        receiver.verifyBoundary(route.btcFeedId, BOUNDARY, 1060, abi.encode(observation));
        vm.expectRevert(HorizenStreamsOracle.MissingObservation.selector);
        receiver.verifyBoundary(route.btcFeedId, BOUNDARY, 1060, "");
        vm.chainId(BASE);
        vm.expectRevert(BaseStreamsPublisher.MissingObservation.selector);
        publisher.resendBoundary(route.btcFeedId, BOUNDARY);
    }

    function testCallerCannotLoosenConfiguredWindowOrUseTighterMismatchingWindow() public {
        publisher.publishBoundary(route.btcFeedId, BOUNDARY, hex"01");
        vm.chainId(HORIZEN);
        _relay();
        vm.expectRevert(StreamsOracleRoute.InvalidObservation.selector);
        receiver.verifyBoundary(route.btcFeedId, BOUNDARY, 1061, "");
        vm.expectRevert(StreamsOracleRoute.InvalidObservation.selector);
        receiver.verifyBoundary(route.btcFeedId, BOUNDARY, 1001, "");
    }

    function testSourceSendFailureRollsBackStoredObservation() public {
        parentMessenger.setFailSend(true);
        vm.expectRevert(bytes("fixture send failure"));
        publisher.publishBoundary(route.btcFeedId, BOUNDARY, hex"01");
        assertEq(publisher.getObservation(route.btcFeedId, BOUNDARY).reportHash, bytes32(0));
    }

    function testEthUsesItsOwnConfiguredDecimals() public {
        observation.decimals = 8;
        observation.price = 324012345678;
        source.setObservation(observation);
        publisher.publishBoundary(route.ethFeedId, BOUNDARY, hex"01");
        vm.chainId(HORIZEN);
        _relay();
        assertEq(receiver.verifyBoundary(route.ethFeedId, BOUNDARY, 1060, "").decimals, 8);
    }

    function testConstructorRejectsCounterpartMismatch() public {
        route.destinationOracle = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        childMessenger.configure(address(0x1234));
        vm.chainId(HORIZEN);
        vm.expectRevert(HorizenStreamsOracle.InvalidConfig.selector);
        new HorizenStreamsOracle(route);
    }

    function testReceiverConstructorRejectsWrongOwnAddress() public {
        vm.chainId(HORIZEN);
        vm.expectRevert(HorizenStreamsOracle.InvalidConfig.selector);
        new HorizenStreamsOracle(route);
    }

    function testReceiverConstructorRejectsWrongChain() public {
        route.destinationOracle = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.expectRevert(HorizenStreamsOracle.InvalidConfig.selector);
        new HorizenStreamsOracle(route);
    }

    function testPublisherConstructorRejectsWrongChain() public {
        route.publisher = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        vm.chainId(HORIZEN);
        vm.expectRevert(BaseStreamsPublisher.InvalidConfig.selector);
        new BaseStreamsPublisher(route);
    }

    function testPublisherConstructorRejectsCounterpartMismatch() public {
        route.publisher = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        parentMessenger.configure(address(0x1234));
        vm.expectRevert(BaseStreamsPublisher.InvalidConfig.selector);
        new BaseStreamsPublisher(route);
    }

    function testConstructorRejectsWrongOwnAddressAndFeedConfig() public {
        vm.expectRevert(BaseStreamsPublisher.InvalidConfig.selector);
        new BaseStreamsPublisher(route);
        route.publisher = vm.computeCreateAddress(address(this), vm.getNonce(address(this)));
        route.btcDecimals = 17;
        vm.expectRevert(BaseStreamsPublisher.InvalidConfig.selector);
        new BaseStreamsPublisher(route);
    }

    function testReentrantOracleCannotPublishOrResend() public {
        source.setReentry(
            address(publisher),
            abi.encodeCall(publisher.publishBoundary, (route.btcFeedId, BOUNDARY, hex"01"))
        );
        publisher.publishBoundary(route.btcFeedId, BOUNDARY, hex"01");
        assertFalse(source.reentrySucceeded());
        assertEq(source.reentryResult(), abi.encodeWithSignature("ReentrancyGuardReentrantCall()"));
        source.setReentry(
            address(publisher), abi.encodeCall(publisher.resendBoundary, (route.btcFeedId, BOUNDARY))
        );
        publisher.publishBoundary(route.btcFeedId, BOUNDARY, hex"01");
        assertFalse(source.reentrySucceeded());
        assertEq(source.reentryResult(), abi.encodeWithSignature("ReentrancyGuardReentrantCall()"));
        assertEq(publisher.getObservation(route.btcFeedId, BOUNDARY).price, observation.price);
    }

    function testDestinationValidationFailureLeavesCacheEmptyAndCanRetry() public {
        publisher.publishBoundary(route.btcFeedId, BOUNDARY, hex"01");
        vm.chainId(HORIZEN);
        // Model a child clock lagging the source: the authenticated observation is still in its future.
        vm.warp(1001);
        bytes memory message = parentMessenger.message();
        vm.expectRevert(StreamsOracleRoute.InvalidObservation.selector);
        childMessenger.relay(address(publisher), address(receiver), message);
        assertEq(receiver.getObservation(route.btcFeedId, BOUNDARY).reportHash, bytes32(0));
        vm.warp(1003);
        childMessenger.relay(address(publisher), address(receiver), message);
        assertEq(receiver.getObservation(route.btcFeedId, BOUNDARY).reportHash, observation.reportHash);
    }

    function testFuzzRouteHashBindsDestination(uint256 otherChain) public view {
        if (otherChain == 0 || otherChain == BASE || otherChain == HORIZEN) return;
        StreamsOracleRoute.Config memory changed = route;
        changed.destinationChainId = otherChain;
        assertNotEq(StreamsOracleRoute.hash(changed), publisher.routeHash());
    }

    function testFuzzNonpositivePriceRejected(int192 price) public {
        price = int192(bound(int256(price), type(int192).min, 0));
        observation.price = price;
        source.setObservation(observation);
        vm.expectRevert(StreamsOracleRoute.InvalidObservation.selector);
        publisher.publishBoundary(route.btcFeedId, BOUNDARY, hex"01");
    }

    function testFuzzDelayedObservationOutsideWindowRejected(uint32 delay) public {
        delay = uint32(bound(delay, 61, 100_000));
        observation.observationsTimestamp = uint32(BOUNDARY) + delay;
        observation.expiresAt = observation.observationsTimestamp + 100;
        vm.warp(observation.observationsTimestamp);
        source.setObservation(observation);
        vm.expectRevert(StreamsOracleRoute.InvalidObservation.selector);
        publisher.publishBoundary(route.btcFeedId, BOUNDARY, hex"01");
    }

    function testFuzzExactInt192PricesSurviveDelivery(uint192 price) public {
        observation.price = int192(int256(bound(price, 1, uint192(type(int192).max))));
        source.setObservation(observation);
        publisher.publishBoundary(route.btcFeedId, BOUNDARY, hex"01");
        vm.chainId(HORIZEN);
        _relay();
        assertEq(receiver.verifyBoundary(route.btcFeedId, BOUNDARY, 1060, "").price, observation.price);
    }

    function _relay() private {
        childMessenger.relay(address(publisher), address(receiver), parentMessenger.message());
    }

    function _encode(IStreamsBoundaryOracle.Observation memory obs, bytes32 domain, bytes32 feed)
        private
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(IStreamsObservationReceiver.receiveObservation, (domain, feed, BOUNDARY, obs));
    }
}
