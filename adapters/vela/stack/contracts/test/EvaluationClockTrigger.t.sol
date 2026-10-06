// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, Vm, console} from "forge-std/Test.sol";
import {EvaluationClockTrigger} from "../src/EvaluationClockTrigger.sol";
import {EvaluationToken} from "../src/EvaluationToken.sol";
import {StreamsRoundRegistry} from "zedge-contracts/src/StreamsRoundRegistry.sol";
import {IStreamsBoundaryOracle} from "zedge-contracts/src/interfaces/IStreamsBoundaryOracle.sol";
import {
    MockStreamsBoundaryOracle,
    StreamsRegistryProxy
} from "zedge-contracts/test/mocks/MockStreamsBoundaryOracle.sol";

/// A registry upgraded into something that answers every call with 704 bytes of 0xff: the right length,
/// every word out of range.
contract GarbageRegistry {
    fallback() external {
        assembly {
            for { let i := 0 } lt(i, 704) { i := add(i, 32) } { mstore(i, not(0)) }
            return(0, 704)
        }
    }
}

/// EVALUATION ONLY. The trigger contract of adapters/vela/guest/README.md sections 8 and 10, against the
/// StreamsRoundRegistry behind its proxy with the unsigned fixture oracle (both compiled from contracts/), and
/// against registries that revert, burn gas or answer garbage.
contract EvaluationClockTriggerTest is Test {
    bytes32 constant TICK = 0x8af869f39217eabc1718875ec064086a0e0283d1c1ee8a025b687fd40b5e3850;
    bytes32 constant CLOCK_SUBTYPE = 0xfcec946954aa78965de9f0bba32063a87447ec772e05beb1e50c0e36f5f09460;
    bytes32 constant ARCHIVE_SUBTYPE = 0xefe437757209e66cb09e68c2bfe69073f2740c38bea74805a8b00d3b3de3df7a;
    address constant ENDPOINT = 0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9;
    bytes32 constant BTC_FEED = 0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8;
    bytes32 constant ETH_FEED = 0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9;
    bytes32 constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    uint32 constant D = 900;
    uint32 constant S1 = 1_800_000_000; // a 900-second slot boundary
    /// The most a request of any shape costs the trigger with any registry: 2 creates, 2 ID reads and 18 round
    /// reads at their limits, plus the trigger's own work.
    uint256 constant WORST_GAS = 2 * 250_000 + 20 * 60_000 + 100_000;

    StreamsRoundRegistry registry;
    MockStreamsBoundaryOracle oracle;
    EvaluationClockTrigger trigger;
    EvaluationClockTrigger.TokenAndAmount[] none;

    function setUp() public {
        oracle = new MockStreamsBoundaryOracle();
        oracle.configure(BTC_FEED, ETH_FEED, 18, 18, 10, block.chainid);
        StreamsRoundRegistry.Config memory config = StreamsRoundRegistry.Config(
            address(oracle), address(new EvaluationToken()), BTC_FEED, ETH_FEED, 18, 18, 10, 20, 86_400, 5
        );
        registry = StreamsRegistryProxy.deploy(config, address(this));
        trigger = new EvaluationClockTrigger(ENDPOINT, address(registry), 0, D);
        vm.warp(S1 - 1);
        vm.roll(4242);
    }

    // ------------------------------------------------------------------ helpers

    function events(bytes32[] memory subTypes, bytes[] memory data)
        internal
        pure
        returns (EvaluationClockTrigger.EventData memory)
    {
        return EvaluationClockTrigger.EventData(data, subTypes);
    }

    function one(bytes32 subType, bytes memory data) internal pure returns (EvaluationClockTrigger.EventData memory) {
        bytes32[] memory s = new bytes32[](1);
        bytes[] memory d = new bytes[](1);
        (s[0], d[0]) = (subType, data);
        return events(s, d);
    }

    function ask(EvaluationClockTrigger.EventData memory e) internal returns (bytes memory) {
        vm.prank(ENDPOINT);
        return trigger.getTrustProcessPayload(e, true, true, none, none);
    }

    /// The guest's tick request: tick, s, o, then the s scheduled and o open registry round IDs.
    function request(uint256 tick, bytes32[] memory scheduled, bytes32[] memory open)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(tick, scheduled.length, open.length, scheduled, open);
    }

    function askV2(uint256 tick, bytes32[] memory scheduled, bytes32[] memory open) internal returns (bytes memory) {
        return ask(one(TICK, request(tick, scheduled, open)));
    }

    function word(bytes memory p, uint256 i) internal pure returns (uint256 v) {
        assembly {
            v := mload(add(add(p, 32), mul(i, 32)))
        }
    }

    /// The seven header words as the guest decodes them; returns n.
    function header(bytes memory p, uint256 tick) internal view returns (uint256 n) {
        assertEq(word(p, 0), 2, "version");
        assertEq(word(p, 1), block.chainid, "chain");
        assertEq(word(p, 2), uint256(uint160(ENDPOINT)), "endpoint");
        assertEq(word(p, 3), block.number, "block");
        assertEq(word(p, 4), block.timestamp, "timestamp");
        assertEq(word(p, 5), tick, "tick");
        n = word(p, 6);
        assertLe(n, 16, "record count");
        assertEq(p.length, 224 + 608 * n, "length");
    }

    function recordOf(bytes memory p, bytes32 id) internal pure returns (bool found, uint256 at) {
        for (uint256 r; r < word(p, 6); ++r) {
            if (bytes32(word(p, 7 + 19 * r)) == id) return (true, 7 + 19 * r);
        }
    }

    function ids(bytes32 a) internal pure returns (bytes32[] memory x) {
        x = new bytes32[](1);
        x[0] = a;
    }

    function ids(bytes32 a, bytes32 b) internal pure returns (bytes32[] memory x) {
        x = new bytes32[](2);
        (x[0], x[1]) = (a, b);
    }

    function ids(bytes32 a, bytes32 b, bytes32 c) internal pure returns (bytes32[] memory x) {
        x = new bytes32[](3);
        (x[0], x[1], x[2]) = (a, b, c);
    }

    function noIds() internal pure returns (bytes32[] memory) {
        return new bytes32[](0);
    }

    function made(uint256 n, uint256 seed) internal pure returns (bytes32[] memory x) {
        x = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            x[i] = keccak256(abi.encode(seed, i));
        }
    }

    function slot(uint32 start) internal view returns (bytes32) {
        return registry.roundIdFor(StreamsRoundRegistry.Asset.BTC, D, start);
    }

    function observed(uint32 boundary, int192 price) internal pure returns (IStreamsBoundaryOracle.Observation memory) {
        return IStreamsBoundaryOracle.Observation(
            price, boundary - 1, boundary + 1, boundary + 86_400, keccak256(abi.encode(boundary, price)), 18
        );
    }

    /// Every word of a record equals getRound's field for that round.
    function assertRecord(bytes memory p, bytes32 id) internal view {
        (bool found, uint256 at) = recordOf(p, id);
        assertTrue(found, "record present");
        StreamsRoundRegistry.Round memory r = registry.getRound(id);
        assertEq(word(p, at + 1), uint256(r.asset));
        assertEq(word(p, at + 2), r.duration);
        assertEq(word(p, at + 3), r.start);
        assertEq(word(p, at + 4), r.openedAt);
        assertEq(word(p, at + 5), r.resolvedAt);
        assertEq(word(p, at + 6), uint256(r.outcome));
        IStreamsBoundaryOracle.Observation[2] memory o = [r.opening, r.closing];
        for (uint256 k; k < 2; ++k) {
            uint256 b = at + 7 + 6 * k;
            assertEq(int256(word(p, b)), int256(o[k].price));
            assertEq(word(p, b + 1), o[k].validFromTimestamp);
            assertEq(word(p, b + 2), o[k].observationsTimestamp);
            assertEq(word(p, b + 3), o[k].expiresAt);
            assertEq(bytes32(word(p, b + 4)), o[k].reportHash);
            assertEq(word(p, b + 5), o[k].decimals);
        }
    }

    // ------------------------------------------------------------------ version 1 (section 8)

    function test_SubtypesAndMarket() public view {
        assertEq(trigger.TICK_SUBTYPE(), sha256("zedge.vela.tick.v1"));
        assertEq(TICK, sha256("zedge.vela.tick.v1"));
        assertEq(CLOCK_SUBTYPE, sha256("zedge.vela.clock.v1"));
        assertEq(ARCHIVE_SUBTYPE, sha256("zedge.vela.archive.v1"));
        assertEq(trigger.processorEndpoint(), ENDPOINT);
        assertEq(trigger.registry(), address(registry));
        assertEq(trigger.asset(), 0);
        assertEq(trigger.duration(), D);
    }

    /// The version-1 answer is the six words of README section 8.2, unchanged, and reads no registry.
    function test_Version1AnswerIsUnchanged() public {
        vm.chainId(31337);
        vm.warp(1_800_000_123);
        EvaluationClockTrigger.EventData memory e = one(TICK, abi.encode(uint256(7)));
        vm.startPrank(ENDPOINT);
        vm.startStateDiffRecording();
        bytes memory answer = trigger.getTrustProcessPayload(e, true, true, none, none);
        Vm.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();
        vm.stopPrank();
        assertEq(
            answer, abi.encode(uint256(1), uint256(31337), ENDPOINT, uint256(4242), uint256(1_800_000_123), uint256(7))
        );
        assertEq(answer.length, 192);
        for (uint256 i; i < accesses.length; ++i) {
            assertEq(accesses[i].account, address(trigger));
        }
        assertEq(uint256(registry.phase(slot(S1 + D))), uint256(StreamsRoundRegistry.Phase.Missing));
    }

    function testFuzz_Version1TickAmongOtherEvents(
        uint256 tick,
        uint64 blockNumber,
        uint64 time,
        uint8 position,
        uint8 count
    ) public {
        count = uint8(bound(count, 1, 8));
        position = uint8(bound(position, 0, count - 1));
        vm.roll(blockNumber);
        vm.warp(time);
        bytes32[] memory s = new bytes32[](count);
        bytes[] memory d = new bytes[](count);
        for (uint256 i; i < count; ++i) {
            (s[i], d[i]) = (keccak256(abi.encode(i)), abi.encode(i, i));
        }
        (s[position], d[position]) = (TICK, abi.encode(tick));
        bytes memory answer = ask(events(s, d));
        assertEq(answer, abi.encode(uint256(1), block.chainid, ENDPOINT, uint256(blockNumber), uint256(time), tick));
    }

    function test_FirstTickWins() public {
        bytes32[] memory s = new bytes32[](3);
        bytes[] memory d = new bytes[](3);
        (s[0], d[0]) = (TICK, new bytes(31)); // too short to carry a tick: skipped
        (s[1], d[1]) = (TICK, abi.encode(uint256(3)));
        (s[2], d[2]) = (TICK, abi.encode(uint256(4)));
        (,,,,, uint256 k) = abi.decode(ask(events(s, d)), (uint256, uint256, address, uint256, uint256, uint256));
        assertEq(k, 3);
    }

    /// No tick request, no answer: no events, the guest's own clock and archive records (a tick never answers
    /// itself), other subtypes, and a tick request too short to carry a tick number.
    function test_EmptyAnswers() public {
        assertEq(ask(events(new bytes32[](0), new bytes[](0))).length, 0);
        assertEq(
            ask(one(CLOCK_SUBTYPE, abi.encode(uint256(1), uint256(2), uint256(3), uint256(0), uint256(0)))).length, 0
        );
        assertEq(ask(one(ARCHIVE_SUBTYPE, bytes('{"count":1}'))).length, 0);
        assertEq(ask(one(keccak256("other"), abi.encode(uint256(1)))).length, 0);
        assertEq(ask(one(TICK, "")).length, 0);
        assertEq(ask(one(TICK, new bytes(31))).length, 0);
        bytes32[] memory s = new bytes32[](2);
        bytes[] memory d = new bytes[](1); // fewer data entries than subtypes: only the pairs are read
        (s[0], s[1], d[0]) = (CLOCK_SUBTYPE, TICK, abi.encode(uint256(1)));
        assertEq(ask(events(s, d)).length, 0);
    }

    // ------------------------------------------------------------------ version 2 (section 10)

    /// A request with no rounds held creates the market's next two slots in the registry and reports both.
    function test_Version2CreatesTheNextTwoSlots() public {
        bytes memory p = askV2(5, noIds(), noIds());
        assertEq(header(p, 5), 2);
        for (uint32 i; i < 2; ++i) {
            bytes32 id = slot(S1 + i * D);
            assertEq(uint256(registry.phase(id)), uint256(StreamsRoundRegistry.Phase.Scheduled));
            assertRecord(p, id);
        }
        // At a slot boundary the next slot is the following one: the registry creates only future rounds.
        vm.warp(S1);
        p = askV2(6, noIds(), noIds());
        assertEq(header(p, 6), 2);
        assertEq(uint256(registry.phase(slot(S1 + 2 * D))), uint256(StreamsRoundRegistry.Phase.Scheduled));
        (bool found,) = recordOf(p, slot(S1 + 2 * D));
        assertTrue(found);
    }

    /// Records only where the registry is ahead of the engine: an asked scheduled round that opened or ended,
    /// an asked open round that ended, a next slot nobody asked about. Each record is getRound word for word.
    function test_Version2RecordsOnlyWhereTheRegistryIsAhead() public {
        askV2(1, noIds(), noIds());
        (bytes32 r1, bytes32 r2, bytes32 r3, bytes32 r4) = (slot(S1), slot(S1 + D), slot(S1 + 2 * D), slot(S1 + 3 * D));

        bytes memory p = askV2(2, ids(r1), noIds()); // r1 not ahead; r2 is a next slot nobody asked about
        assertEq(header(p, 2), 1);
        assertRecord(p, r2);
        assertEq(header(askV2(3, ids(r1, r2), noIds()), 3), 0); // nothing ahead, both slots asked

        vm.warp(S1 + 2);
        registry.recordOpening(r1, abi.encode(observed(S1, 97_000e18)));
        p = askV2(4, ids(r1, r2), noIds()); // r1 opened; r3 is a new next slot
        assertEq(header(p, 4), 2);
        assertRecord(p, r1);
        assertRecord(p, r3);
        assertEq(header(askV2(5, ids(r2, r3), ids(r1)), 5), 0); // open without an outcome is not ahead

        vm.warp(S1 + D + 3);
        registry.resolveRound(r1, abi.encode(observed(S1 + D, 97_000e18 + 1)));
        p = askV2(6, ids(r2, r3), ids(r1)); // r1 resolved Up; r2 missed its opening but is not voided yet
        assertEq(header(p, 6), 2);
        assertRecord(p, r1);
        assertRecord(p, r4);
        assertEq(word(p, 7 + 6), 1); // r1 sorts first: outcome Up

        vm.warp(S1 + D + 31); // past r2's opening deadline (start + 10 + 20)
        registry.voidRound(r2);
        p = askV2(7, ids(r2, r3, r4), noIds()); // a void comes only from the registry's own record
        assertEq(header(p, 7), 1);
        assertRecord(p, r2);
        assertEq(word(p, 7 + 6), 3);
        assertEq(word(p, 7 + 5), S1 + D + 31);
    }

    /// A request of any other shape is a plain clock tick: n = 0 and no registry call.
    function test_MalformedRequestsGetAPlainClockTick() public {
        bytes[] memory bad = new bytes[](8);
        bad[0] = abi.encodePacked(uint256(9), uint8(0));
        bad[1] = abi.encode(uint256(9), uint256(0));
        bad[2] = abi.encodePacked(uint256(9), uint256(0), uint256(0), uint8(1));
        bad[3] = abi.encode(uint256(9), uint256(1), uint256(0)); // one ID announced, none sent
        bad[4] = abi.encode(uint256(9), uint256(0), uint256(0), bytes32(uint256(1))); // one sent, none announced
        bad[5] = request(9, made(9, 1), made(8, 2)); // 17 IDs
        bad[6] = abi.encode(uint256(9), uint256(1) << 255, uint256(1) << 255); // the counts' sum wraps to 0
        bad[7] = abi.encode(uint256(9), type(uint256).max, uint256(1));
        for (uint256 i; i < bad.length; ++i) {
            assertEq(header(ask(one(TICK, bad[i])), 9), 0);
        }
        assertEq(uint256(registry.phase(slot(S1))), uint256(StreamsRoundRegistry.Phase.Missing));
    }

    /// At most sixteen records: sixteen opened rounds asked about fill the answer, and the two new slots wait.
    function test_RecordCap() public {
        bytes32[] memory asked = new bytes32[](16);
        for (uint32 i; i < 16; ++i) {
            asked[i] = registry.createRound(StreamsRoundRegistry.Asset.BTC, D, S1 + i * D);
        }
        for (uint32 i; i < 16; ++i) {
            vm.warp(S1 + i * D + 2);
            registry.recordOpening(asked[i], abi.encode(observed(S1 + i * D, 97_000e18)));
        }
        bytes memory p = askV2(3, asked, noIds());
        assertEq(header(p, 3), 16);
        assertEq(p.length, 9952);
        for (uint256 i; i < 16; ++i) {
            assertRecord(p, asked[i]);
        }
    }

    /// A registry that reverts, burns all gas, answers the wrong length, answers a large buffer, has no code
    /// or answers garbage of the right length: the clock words are intact, the answer is well formed and the
    /// trigger spends a bounded amount of gas, here with sixteen IDs asked (the most a request may carry).
    function test_HostileRegistries() public {
        bytes[] memory codes = new bytes[](7);
        codes[0] = hex"60006000fd"; // revert
        codes[1] = hex"5b600056"; // loop until out of gas
        codes[2] = hex"6102bf6000f3"; // 703 bytes
        codes[3] = hex"6102c16000f3"; // 705 bytes
        codes[4] = hex"619c406000f3"; // 40,000 bytes
        codes[5] = ""; // no code
        codes[6] = address(new GarbageRegistry()).code;
        uint256[7] memory expected = [uint256(0), 0, 0, 0, 0, 0, 16];
        for (uint256 i; i < codes.length; ++i) {
            uint256 snapshot = vm.snapshotState();
            vm.etch(address(registry), codes[i]);
            uint256 before = gasleft();
            bytes memory p = askV2(11, made(8, 3), made(8, 4));
            uint256 used = before - gasleft();
            console.log("hostile registry", i, "gas", used);
            assertEq(header(p, 11), expected[i]);
            assertLe(used, WORST_GAS);
            vm.revertToState(snapshot);
        }
    }

    /// With a tick request present the trigger never reverts, whatever follows the tick word and whatever the
    /// registry does, and the answer always carries the clock words.
    function testFuzz_NeverRevertsWithATickRequest(uint256 tick, bytes calldata rest, uint8 mode) public {
        _hostile(mode);
        bytes memory p = ask(one(TICK, abi.encodePacked(tick, rest)));
        if (rest.length == 0) assertEq(p.length, 192);
        else header(p, tick);
    }

    function testFuzz_WellFormedRequests(uint256 tick, uint8 scheduled, uint8 open, uint256 seed, uint8 mode) public {
        scheduled = uint8(bound(scheduled, 0, 8));
        open = uint8(bound(open, 0, 8));
        bytes32[] memory s = made(scheduled, seed);
        if (scheduled > 0 && seed % 2 == 0) s[0] = slot(S1); // sometimes a real round
        _hostile(mode);
        uint256 before = gasleft();
        bytes memory p = askV2(tick, s, made(open, ~seed));
        assertLe(before - gasleft(), WORST_GAS);
        header(p, tick);
    }

    function _hostile(uint8 mode) internal {
        mode %= 4;
        if (mode == 1) vm.etch(address(registry), hex"60006000fd");
        if (mode == 2) vm.etch(address(registry), hex"5b600056");
        if (mode == 3) vm.etch(address(registry), address(new GarbageRegistry()).code);
    }

    /// The honest registry's costs, against which CREATE_GAS and READ_GAS are set with a margin of three, and
    /// the cost of the busiest honest answer: eight rounds asked (the guest's cap) and two slots created.
    function test_HonestRegistryCosts() public {
        uint256 before = gasleft();
        bytes32 id = registry.createRound(StreamsRoundRegistry.Asset.BTC, D, S1);
        uint256 create = before - gasleft();
        vm.warp(S1 + 2);
        registry.recordOpening(id, abi.encode(observed(S1, 97_000e18)));
        before = gasleft();
        registry.getRound(id);
        uint256 read = before - gasleft();
        console.log("createRound gas", create, "getRound gas", read);
        assertLt(3 * create, trigger.CREATE_GAS());
        assertLt(3 * read, trigger.READ_GAS());

        bytes32[] memory asked = new bytes32[](8);
        for (uint32 i; i < 8; ++i) {
            asked[i] = registry.createRound(StreamsRoundRegistry.Asset.BTC, D, S1 + (i + 1) * D);
        }
        vm.warp(S1 + 7 * D + 2); // six have started and missed their opening; the seventh opens now
        registry.recordOpening(asked[6], abi.encode(observed(S1 + 7 * D, 97_000e18)));
        before = gasleft();
        bytes memory p = askV2(2, asked, noIds());
        uint256 busiest = before - gasleft();
        console.log("busiest honest answer gas", busiest, "records", header(p, 2));
        assertLt(busiest, 500_000);
    }

    /// The version-2 answer touches the trigger and the registry (its proxy and implementation) only.
    function test_AnswerTouchesOnlyTheRegistry() public {
        address implementation = address(uint160(uint256(vm.load(address(registry), IMPLEMENTATION_SLOT))));
        EvaluationClockTrigger.EventData memory e = one(TICK, request(1, noIds(), noIds()));
        vm.startPrank(ENDPOINT);
        vm.startStateDiffRecording();
        trigger.getTrustProcessPayload(e, false, false, none, none);
        Vm.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();
        vm.stopPrank();
        for (uint256 i; i < accesses.length; ++i) {
            address a = accesses[i].account;
            assertTrue(a == address(trigger) || a == address(registry) || a == implementation);
        }
    }

    // ------------------------------------------------------------------ custody and access

    function test_HoldsAndReturnsNothing() public {
        vm.startPrank(ENDPOINT);
        trigger.execute(one(TICK, abi.encode(uint256(1))));
        (
            EvaluationClockTrigger.TokenAndAmount[] memory returned,
            EvaluationClockTrigger.TokenAndAmount[] memory failed
        ) = trigger.withdraw();
        vm.stopPrank();
        assertEq(returned.length, 0);
        assertEq(failed.length, 0);
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(trigger).call{value: 1}("");
        assertFalse(ok);
        assertEq(address(trigger).balance, 0);
    }

    function test_OnlyTheEndpoint(address caller) public {
        vm.assume(caller != ENDPOINT);
        EvaluationClockTrigger.EventData memory e = one(TICK, abi.encode(uint256(1)));
        vm.startPrank(caller);
        vm.expectRevert(EvaluationClockTrigger.NotProcessorEndpoint.selector);
        trigger.getTrustProcessPayload(e, true, true, none, none);
        vm.expectRevert(EvaluationClockTrigger.NotProcessorEndpoint.selector);
        trigger.execute(e);
        vm.expectRevert(EvaluationClockTrigger.NotProcessorEndpoint.selector);
        trigger.withdraw();
        vm.stopPrank();
    }

    function test_ConstructorRefusals() public {
        vm.expectRevert(EvaluationClockTrigger.ZeroAddress.selector);
        new EvaluationClockTrigger(address(0), address(registry), 0, 900);
        vm.expectRevert(EvaluationClockTrigger.ZeroAddress.selector);
        new EvaluationClockTrigger(ENDPOINT, address(0), 0, 900);
        vm.expectRevert(EvaluationClockTrigger.InvalidMarket.selector);
        new EvaluationClockTrigger(ENDPOINT, address(registry), 2, 900);
        vm.expectRevert(EvaluationClockTrigger.InvalidMarket.selector);
        new EvaluationClockTrigger(ENDPOINT, address(registry), 0, 600);
        assertEq(new EvaluationClockTrigger(ENDPOINT, address(registry), 1, 300).duration(), 300);
    }

    /// The three selectors are the ones a v0.2.0 ProcessorEndpoint calls (ITrigger), and the registry calls
    /// are the StreamsRoundRegistry's own.
    function test_Selectors() public pure {
        assertEq(
            EvaluationClockTrigger.getTrustProcessPayload.selector,
            bytes4(
                keccak256(
                    "getTrustProcessPayload((bytes[],bytes32[]),bool,bool,(address,uint256)[],(address,uint256)[])"
                )
            )
        );
        assertEq(EvaluationClockTrigger.execute.selector, bytes4(keccak256("execute((bytes[],bytes32[]))")));
        assertEq(EvaluationClockTrigger.withdraw.selector, bytes4(keccak256("withdraw()")));
        assertEq(StreamsRoundRegistry.createRound.selector, bytes4(keccak256("createRound(uint8,uint32,uint64)")));
        assertEq(StreamsRoundRegistry.roundIdFor.selector, bytes4(keccak256("roundIdFor(uint8,uint32,uint64)")));
        assertEq(StreamsRoundRegistry.getRound.selector, bytes4(keccak256("getRound(bytes32)")));
    }
}
