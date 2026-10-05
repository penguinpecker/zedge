// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, Vm} from "forge-std/Test.sol";
import {EvaluationClockTrigger} from "../src/EvaluationClockTrigger.sol";

/// EVALUATION ONLY. The trigger contract of adapters/vela/guest/README.md section 8.
contract EvaluationClockTriggerTest is Test {
    bytes32 constant CLOCK_SUBTYPE = 0xfcec946954aa78965de9f0bba32063a87447ec772e05beb1e50c0e36f5f09460;
    address constant ENDPOINT = 0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9;

    EvaluationClockTrigger trigger;
    EvaluationClockTrigger.TokenAndAmount[] none;

    function setUp() public {
        trigger = new EvaluationClockTrigger(ENDPOINT);
    }

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

    function test_SubtypesAreTheGuestConstants() public view {
        assertEq(trigger.TICK_SUBTYPE(), sha256("zedge.vela.tick.v1"));
        assertEq(CLOCK_SUBTYPE, sha256("zedge.vela.clock.v1"));
        assertEq(trigger.processorEndpoint(), ENDPOINT);
    }

    /// The answer is the six words of README section 8.2, as the guest decodes them.
    function test_AnswersATickWithTheBlockItRunsIn() public {
        vm.chainId(31337);
        vm.roll(4242);
        vm.warp(1_800_000_123);
        bytes memory answer = ask(one(trigger.TICK_SUBTYPE(), abi.encode(uint256(7))));
        assertEq(answer.length, 192);
        assertEq(
            answer, abi.encode(uint256(1), uint256(31337), ENDPOINT, uint256(4242), uint256(1_800_000_123), uint256(7))
        );
        bytes memory words = abi.encodePacked(
            bytes32(uint256(1)),
            bytes32(uint256(31337)),
            bytes32(uint256(uint160(ENDPOINT))),
            bytes32(uint256(4242)),
            bytes32(uint256(1_800_000_123)),
            bytes32(uint256(7))
        );
        assertEq(answer, words);
    }

    /// With a tick request anywhere among other events, the answer never reverts and carries its number.
    function testFuzz_TickAmongOtherEvents(uint256 tick, uint64 blockNumber, uint64 time, uint8 position, uint8 count)
        public
    {
        count = uint8(bound(count, 1, 8));
        position = uint8(bound(position, 0, count - 1));
        vm.roll(blockNumber);
        vm.warp(time);
        bytes32[] memory s = new bytes32[](count);
        bytes[] memory d = new bytes[](count);
        for (uint256 i; i < count; ++i) {
            (s[i], d[i]) = (keccak256(abi.encode(i)), abi.encode(i, i));
        }
        (s[position], d[position]) = (trigger.TICK_SUBTYPE(), abi.encode(tick));
        bytes memory answer = ask(events(s, d));
        (uint256 v, uint256 chain, address endpoint, uint256 b, uint256 t, uint256 k) =
            abi.decode(answer, (uint256, uint256, address, uint256, uint256, uint256));
        assertEq(answer.length, 192);
        assertEq(v, 1);
        assertEq(chain, block.chainid);
        assertEq(endpoint, ENDPOINT);
        assertEq(b, blockNumber);
        assertEq(t, time);
        assertEq(k, tick);
    }

    function test_FirstTickWins() public {
        bytes32[] memory s = new bytes32[](2);
        bytes[] memory d = new bytes[](2);
        (s[0], d[0]) = (trigger.TICK_SUBTYPE(), abi.encode(uint256(3)));
        (s[1], d[1]) = (trigger.TICK_SUBTYPE(), abi.encode(uint256(4)));
        (,,,,, uint256 k) = abi.decode(ask(events(s, d)), (uint256, uint256, address, uint256, uint256, uint256));
        assertEq(k, 3);
    }

    /// Everything else gets no answer: no events, the guest's clock record (a tick never asks for a tick),
    /// other subtypes, and a tick request whose data is not one word.
    function test_EmptyAnswers() public {
        assertEq(ask(events(new bytes32[](0), new bytes[](0))).length, 0);
        assertEq(ask(one(CLOCK_SUBTYPE, abi.encode(uint256(1), uint256(2), uint256(3)))).length, 0);
        assertEq(ask(one(CLOCK_SUBTYPE, abi.encode(uint256(1)))).length, 0);
        assertEq(ask(one(keccak256("other"), abi.encode(uint256(1)))).length, 0);
        bytes32 tick = trigger.TICK_SUBTYPE();
        assertEq(ask(one(tick, "")).length, 0);
        assertEq(ask(one(tick, new bytes(31))).length, 0);
        assertEq(ask(one(tick, new bytes(33))).length, 0);
        assertEq(ask(one(tick, abi.encode(uint256(1), uint256(2)))).length, 0);
    }

    /// The answer reads no other contract: nothing a registry or token does can stop the clock.
    function test_AnswerTouchesNoOtherAccount() public {
        EvaluationClockTrigger.EventData memory e = one(trigger.TICK_SUBTYPE(), abi.encode(uint256(9)));
        vm.startPrank(ENDPOINT);
        vm.startStateDiffRecording();
        assertEq(trigger.getTrustProcessPayload(e, false, false, none, none).length, 192);
        trigger.execute(e);
        trigger.withdraw();
        Vm.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();
        vm.stopPrank();
        assertGe(accesses.length, 3); // the three calls, plus Foundry's own resume records
        for (uint256 i; i < accesses.length; ++i) {
            assertEq(accesses[i].account, address(trigger));
            assertEq(accesses[i].storageAccesses.length, 0);
            assertFalse(accesses[i].reverted);
        }
    }

    function test_HoldsAndReturnsNothing() public {
        vm.startPrank(ENDPOINT);
        trigger.execute(one(trigger.TICK_SUBTYPE(), abi.encode(uint256(1))));
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
        EvaluationClockTrigger.EventData memory e = one(trigger.TICK_SUBTYPE(), abi.encode(uint256(1)));
        vm.startPrank(caller);
        vm.expectRevert(EvaluationClockTrigger.NotProcessorEndpoint.selector);
        trigger.getTrustProcessPayload(e, true, true, none, none);
        vm.expectRevert(EvaluationClockTrigger.NotProcessorEndpoint.selector);
        trigger.execute(e);
        vm.expectRevert(EvaluationClockTrigger.NotProcessorEndpoint.selector);
        trigger.withdraw();
        vm.stopPrank();
    }

    function test_RefusesTheZeroEndpoint() public {
        vm.expectRevert(EvaluationClockTrigger.ZeroAddress.selector);
        new EvaluationClockTrigger(address(0));
    }

    /// The three selectors are the ones a v0.2.0 ProcessorEndpoint calls (ITrigger).
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
    }
}
