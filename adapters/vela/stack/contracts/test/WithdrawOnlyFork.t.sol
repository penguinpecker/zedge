// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {BookClockTrigger} from "../src/BookClockTrigger.sol";
import {WithdrawOnlyBookClockTrigger} from "../src/WithdrawOnlyBookClockTrigger.sol";

interface IInboxHighest {
    function highest() external view returns (uint64);
}

/// The live order book's trigger on a local fork of Horizen mainnet, upgraded to WithdrawOnlyBookClockTrigger the way
/// the cutover does it (docs/cutover-politics.md). Nothing is sent to the chain: the fork only reads it. Skipped
/// unless HORIZEN_FORK_RPC is set:
///   HORIZEN_FORK_RPC=https://26514.rpc.thirdweb.com [HORIZEN_FORK_BLOCK=N] forge test --mc WithdrawOnlyFork -vv
contract WithdrawOnlyForkTest is Test {
    bytes32 constant TICK = 0x8af869f39217eabc1718875ec064086a0e0283d1c1ee8a025b687fd40b5e3850;
    bytes32 constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    bytes32 constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;
    BookClockTrigger constant TRIGGER = BookClockTrigger(0x9Ca46470B05350384c31c8b236Af4DF638cBB30D);
    address constant LIVE_IMPLEMENTATION = 0x6F8500186CcB07E3c14FF7BBf1c9b5c05b8ca9A8;
    address constant DEPLOYER = 0x279173ac297aD146bc92f877552C8C2B78334d07;
    address constant ENDPOINT = 0x0A2703d21B27757fDf27AB807EAE9820788010F3;
    address constant REGISTRY = 0x4DD4aacDb7E8D2e6D06c5af38238F3dEAB836744;
    address constant INBOX = 0x7003BAEbdB7D60d63a219294F4ebAD211BBd441d;
    BookClockTrigger.TokenAndAmount[] none;

    function implementation() internal view returns (address) {
        return address(uint160(uint256(vm.load(address(TRIGGER), IMPLEMENTATION_SLOT))));
    }

    /// The guest's tick request asking for deposits from index 1 and about no round: the trigger still reports the
    /// next two slots, so the answer carries both kinds of record.
    function ask() internal returns (bytes memory) {
        bytes32[] memory s = new bytes32[](1);
        bytes[] memory d = new bytes[](1);
        (s[0], d[0]) = (TICK, abi.encodePacked(uint256(7), uint256(1), uint256(0), uint256(0), uint256(0)));
        vm.prank(ENDPOINT);
        return TRIGGER.getTrustProcessPayload(BookClockTrigger.EventData(d, s), true, true, none, none);
    }

    function word(bytes memory p, uint256 i) internal pure returns (uint256 v) {
        assembly {
            v := mload(add(add(p, 32), mul(i, 32)))
        }
    }

    function assertBindings() internal view {
        assertEq(TRIGGER.owner(), DEPLOYER);
        assertEq(TRIGGER.pendingOwner(), address(0));
        assertEq(TRIGGER.processorEndpoint(), ENDPOINT);
        assertEq(TRIGGER.registry(), REGISTRY);
        assertEq(TRIGGER.inbox(), INBOX);
        assertEq(TRIGGER.asset(), 0);
        assertEq(TRIGGER.duration(), 900);
        assertEq(TRIGGER.version(), "1");
        assertEq(vm.load(address(TRIGGER), ADMIN_SLOT), bytes32(0)); // UUPS: no proxy admin
    }

    function test_LiveTriggerBecomesWithdrawOnly() public {
        string memory rpc = vm.envOr("HORIZEN_FORK_RPC", string(""));
        if (bytes(rpc).length == 0) {
            vm.skip(true, "set HORIZEN_FORK_RPC to fork Horizen mainnet");
            return;
        }
        uint256 at = vm.envOr("HORIZEN_FORK_BLOCK", uint256(0));
        if (at == 0) vm.createSelectFork(rpc);
        else vm.createSelectFork(rpc, at);

        // Before: the live proxy runs this source's BookClockTrigger, owned by the deployer.
        assertEq(implementation(), LIVE_IMPLEMENTATION);
        bytes32 live = LIVE_IMPLEMENTATION.codehash;
        deployCodeTo("BookClockTrigger.sol:BookClockTrigger", LIVE_IMPLEMENTATION);
        assertEq(LIVE_IMPLEMENTATION.codehash, live, "the live implementation is built from this source");
        assertBindings();
        uint64 highest = IInboxHighest(INBOX).highest();
        assertGe(highest, 1, "the inbox holds deposit records");

        uint256 snapshot = vm.snapshotState();
        bytes memory full = ask();
        (uint256 n, uint256 d) = (word(full, 6), word(full, 7));
        assertEq(d, highest < 8 ? highest : 8, "before: the deposit records from index 1");
        assertGe(n, 1, "the registry records of the next slots");
        assertEq(full.length, 256 + 608 * n + 96 * d);
        vm.revertToState(snapshot);

        // The upgrade, as the owner sends it.
        address frozen = address(new WithdrawOnlyBookClockTrigger());
        vm.prank(DEPLOYER);
        TRIGGER.upgradeToAndCall(frozen, "");

        // After: the same clock words and registry records byte for byte, no deposit record, the same state.
        bytes memory p = ask();
        assertEq(word(p, 7), 0, "after: no deposit record");
        assembly ("memory-safe") {
            mstore(add(full, 256), 0)
            mstore(full, add(256, mul(608, n)))
        }
        assertEq(keccak256(p), keccak256(full), "clock words and registry records unchanged");
        assertEq(implementation(), frozen);
        assertBindings();
    }
}
