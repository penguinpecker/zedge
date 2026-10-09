// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, Vm, console} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {BookClockTrigger} from "../src/BookClockTrigger.sol";
import {WithdrawOnlyBookClockTrigger} from "../src/WithdrawOnlyBookClockTrigger.sol";
import {EvaluationToken} from "../src/EvaluationToken.sol";
import {StreamsRoundRegistry} from "zedge-contracts/src/StreamsRoundRegistry.sol";
import {HorizenDepositInbox} from "zedge-contracts/src/HorizenDepositInbox.sol";
import {IStreamsBoundaryOracle} from "zedge-contracts/src/interfaces/IStreamsBoundaryOracle.sol";
import {
    MockStreamsBoundaryOracle,
    StreamsRegistryProxy
} from "zedge-contracts/test/mocks/MockStreamsBoundaryOracle.sol";

/// Horizen's L2 messenger as the inbox sees it: the sender of the message being relayed.
contract MessengerStub {
    address public xDomainMessageSender;

    function relay(address sender) external {
        xDomainMessageSender = sender;
    }
}

/// An inbox upgraded into something that answers recordsFrom with a fixed, hostile shape.
contract HostileInbox {
    uint256 immutable mode;

    constructor(uint256 mode_) {
        mode = mode_;
    }

    /// Modes: 0 revert; 1 burn all gas; 2 two words, not a whole record; 3 nine records; 4 another offset;
    /// 5 one byte short; 6 a huge answer; anything else one record of arbitrary words.
    fallback() external {
        uint256 m = mode;
        assembly {
            mstore(0, 32)
            switch m
            case 0 { revert(0, 0) }
            case 1 { invalid() }
            case 2 {
                mstore(32, 2)
                mstore(64, 1)
                mstore(96, 2)
                return(0, 128)
            }
            case 3 {
                mstore(32, 27)
                return(0, 928)
            }
            case 4 {
                mstore(0, 64)
                mstore(32, 3)
                return(0, 160)
            }
            case 5 {
                mstore(32, 3)
                return(0, 159)
            }
            case 6 { return(0, 40000) }
            default {
                mstore(32, 3)
                mstore(64, 1)
                mstore(96, 7)
                mstore(128, 9)
                return(0, 160)
            }
        }
    }
}

/// The trigger of the ZEDGE book (adapters/vela/guest/README.md sections 6, 8 and 10) behind its UUPS proxy, against
/// the StreamsRoundRegistry and the HorizenDepositInbox (both compiled from contracts/, read-only), and against
/// registries and inboxes that revert, burn gas or answer garbage.
contract BookClockTriggerTest is Test {
    bytes32 constant TICK = 0x8af869f39217eabc1718875ec064086a0e0283d1c1ee8a025b687fd40b5e3850;
    bytes32 constant CLOCK_SUBTYPE = 0xfcec946954aa78965de9f0bba32063a87447ec772e05beb1e50c0e36f5f09460;
    bytes32 constant SETTLE_SUBTYPE = 0x9724dc1f896290cab5003edb2c481613b0c459f9303c263ec7329d4cb9a96b8a;
    address constant ENDPOINT = 0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9;
    address constant OWNER = 0x279173ac297aD146bc92f877552C8C2B78334d07;
    address constant VAULT = 0x5a5A5a5a5A5a5a5a5a5A5a5A5A5a5a5A5A5A5A5A; // the Base vault proxy (a placeholder here)
    address constant L2_MESSENGER = 0x4200000000000000000000000000000000000007;
    bytes32 constant BTC_FEED = 0x00039d9e45394f473ab1f050a1b963e6b05351e52d71e507509ada0c95ed75b8;
    bytes32 constant ETH_FEED = 0x000362205e10b3a147d02792eccee483dca6c7b44ecce7012cb8c6e0b68b3ae9;
    bytes32 constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    uint32 constant D = 900;
    uint32 constant S1 = 1_800_000_000; // a 900-second slot boundary
    /// The most a request of any shape costs the trigger with any registry and inbox: 2 creates, 2 ID reads, 18
    /// round reads and the inbox call at their limits, plus the trigger's own work.
    uint256 constant WORST_GAS = 2 * 250_000 + 20 * 60_000 + 150_000 + 120_000;

    StreamsRoundRegistry registry;
    HorizenDepositInbox inbox;
    BookClockTrigger trigger;
    BookClockTrigger.TokenAndAmount[] none;

    function setUp() public {
        MockStreamsBoundaryOracle oracle = new MockStreamsBoundaryOracle();
        oracle.configure(BTC_FEED, ETH_FEED, 18, 18, 10, block.chainid);
        StreamsRoundRegistry.Config memory config = StreamsRoundRegistry.Config(
            address(oracle), address(new EvaluationToken()), BTC_FEED, ETH_FEED, 18, 18, 10, 20, 86_400, 5
        );
        registry = StreamsRegistryProxy.deploy(config, address(this));
        vm.etch(L2_MESSENGER, address(new MessengerStub()).code);
        inbox = HorizenDepositInbox(
            address(
                new ERC1967Proxy(
                    address(new HorizenDepositInbox()), abi.encodeCall(HorizenDepositInbox.initialize, (OWNER, VAULT))
                )
            )
        );
        trigger = deploy(address(registry), address(inbox));
        vm.warp(S1 - 1);
        vm.roll(4242);
    }

    // ------------------------------------------------------------------ helpers

    function deploy(address registry_, address inbox_) internal returns (BookClockTrigger) {
        bytes memory init = abi.encodeCall(BookClockTrigger.initialize, (OWNER, ENDPOINT, registry_, inbox_, 0, D));
        return BookClockTrigger(address(new ERC1967Proxy(address(new BookClockTrigger()), init)));
    }

    /// A Base deposit delivered through the messenger, as the vault's message would be.
    function deposit(uint64 index, address account, uint256 amount) internal {
        MessengerStub(L2_MESSENGER).relay(VAULT);
        vm.prank(L2_MESSENGER);
        inbox.receiveDeposit(index, account, amount);
    }

    function one(bytes32 subType, bytes memory data) internal pure returns (BookClockTrigger.EventData memory) {
        bytes32[] memory s = new bytes32[](1);
        bytes[] memory d = new bytes[](1);
        (s[0], d[0]) = (subType, data);
        return BookClockTrigger.EventData(d, s);
    }

    function ask(BookClockTrigger.EventData memory e) internal returns (bytes memory) {
        vm.prank(ENDPOINT);
        return trigger.getTrustProcessPayload(e, true, true, none, none);
    }

    /// The guest's tick request: tick, nextDeposit, s, o, c, then the registry round IDs in that order.
    function request(uint256 tick, uint256 next, bytes32[] memory s, bytes32[] memory o, bytes32[] memory c)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(tick, next, s.length, o.length, c.length, s, o, c);
    }

    function askFor(uint256 tick, uint256 next, bytes32[] memory s, bytes32[] memory o, bytes32[] memory c)
        internal
        returns (bytes memory)
    {
        return ask(one(TICK, request(tick, next, s, o, c)));
    }

    function word(bytes memory p, uint256 i) internal pure returns (uint256 v) {
        assembly {
            v := mload(add(add(p, 32), mul(i, 32)))
        }
    }

    /// The eight header words as the guest decodes them; returns n and d.
    function header(bytes memory p, uint256 tick) internal view returns (uint256 n, uint256 d) {
        assertEq(word(p, 0), 3, "version");
        assertEq(word(p, 1), block.chainid, "chain");
        assertEq(word(p, 2), uint256(uint160(ENDPOINT)), "endpoint");
        assertEq(word(p, 3), block.number, "block");
        assertEq(word(p, 4), block.timestamp, "timestamp");
        assertEq(word(p, 5), tick, "tick");
        (n, d) = (word(p, 6), word(p, 7));
        assertLe(n, 16, "record count");
        assertLe(d, 8, "deposit count");
        assertEq(p.length, 256 + 608 * n + 96 * d, "length");
    }

    function records(bytes memory p, uint256 tick) internal view returns (uint256 n) {
        (n,) = header(p, tick);
    }

    function deposits(bytes memory p, uint256 tick) internal view returns (uint256 d) {
        (, d) = header(p, tick);
    }

    function recordOf(bytes memory p, bytes32 id) internal pure returns (bool found, uint256 at) {
        for (uint256 r; r < word(p, 6); ++r) {
            if (bytes32(word(p, 8 + 19 * r)) == id) return (true, 8 + 19 * r);
        }
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

    /// The deposit records of an answer equal the inbox's, from index `from`.
    function assertDeposits(bytes memory p, uint256 from, uint256 count) internal view {
        (uint256 n, uint256 d) = (word(p, 6), word(p, 7));
        assertEq(d, count, "deposit records");
        for (uint256 k; k < d; ++k) {
            uint256 at = 8 + 19 * n + 3 * k;
            (address account, uint96 amount) = inbox.deposits(uint64(from + k));
            assertEq(word(p, at), from + k);
            assertEq(word(p, at + 1), uint256(uint160(account)));
            assertEq(word(p, at + 2), amount);
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

    // ------------------------------------------------------------------ proxy and owner

    function test_ProxyAndOwner() public {
        assertEq(trigger.owner(), OWNER);
        assertEq(trigger.processorEndpoint(), ENDPOINT);
        assertEq(trigger.registry(), address(registry));
        assertEq(trigger.inbox(), address(inbox));
        assertEq(trigger.asset(), 0);
        assertEq(trigger.duration(), D);
        assertEq(trigger.version(), "1");
        // The implementation behind the proxy can never be initialized itself.
        address implementation = address(uint160(uint256(vm.load(address(trigger), IMPLEMENTATION_SLOT))));
        vm.expectRevert();
        BookClockTrigger(implementation).initialize(OWNER, ENDPOINT, address(registry), address(inbox), 0, D);
        vm.expectRevert();
        trigger.initialize(OWNER, ENDPOINT, address(registry), address(inbox), 0, D);
        // Only the owner upgrades; nobody renounces.
        address next = address(new BookClockTrigger());
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, address(this)));
        trigger.upgradeToAndCall(next, "");
        vm.prank(OWNER);
        vm.expectRevert(BookClockTrigger.RenounceDisabled.selector);
        trigger.renounceOwnership();
        vm.prank(OWNER);
        trigger.upgradeToAndCall(next, "");
        assertEq(address(uint160(uint256(vm.load(address(trigger), IMPLEMENTATION_SLOT)))), next);
        assertEq(trigger.inbox(), address(inbox)); // the state survives the upgrade
        // ERC-7201 slot of the trigger's storage.
        bytes32 location =
            keccak256(abi.encode(uint256(keccak256("zedge.storage.BookClockTrigger")) - 1)) & ~bytes32(uint256(0xff));
        assertEq(address(uint160(uint256(vm.load(address(trigger), location)))), ENDPOINT);
    }

    function test_InitializeRefusals() public {
        address impl = address(new BookClockTrigger());
        bytes[5] memory bad = [
            abi.encodeCall(BookClockTrigger.initialize, (OWNER, address(0), address(registry), address(inbox), 0, D)),
            abi.encodeCall(BookClockTrigger.initialize, (OWNER, ENDPOINT, address(0), address(inbox), 0, D)),
            abi.encodeCall(BookClockTrigger.initialize, (OWNER, ENDPOINT, address(registry), address(0), 0, D)),
            abi.encodeCall(BookClockTrigger.initialize, (OWNER, ENDPOINT, address(registry), address(inbox), 2, D)),
            abi.encodeCall(BookClockTrigger.initialize, (OWNER, ENDPOINT, address(registry), address(inbox), 0, 600))
        ];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert();
            new ERC1967Proxy(impl, bad[i]);
        }
        vm.expectRevert();
        new ERC1967Proxy(
            impl,
            abi.encodeCall(BookClockTrigger.initialize, (address(0), ENDPOINT, address(registry), address(inbox), 0, D))
        );
    }

    // ------------------------------------------------------------------ the clock

    /// No tick request, no answer: no events, the guest's public records (a tick never answers itself), other
    /// subtypes, and a tick request too short to carry a tick number. The first tick request wins.
    function test_EmptyAnswersAndFirstTick() public {
        assertEq(ask(BookClockTrigger.EventData(new bytes[](0), new bytes32[](0))).length, 0);
        assertEq(ask(one(CLOCK_SUBTYPE, request(1, 1, noIds(), noIds(), noIds()))).length, 0);
        assertEq(ask(one(SETTLE_SUBTYPE, request(1, 1, noIds(), noIds(), noIds()))).length, 0);
        assertEq(ask(one(TICK, hex"0102")).length, 0);
        bytes32[] memory s = new bytes32[](3);
        bytes[] memory d = new bytes[](3);
        (s[0], d[0]) = (SETTLE_SUBTYPE, abi.encode(uint256(1)));
        (s[1], d[1]) = (TICK, request(7, 1, noIds(), noIds(), noIds()));
        (s[2], d[2]) = (TICK, request(8, 1, noIds(), noIds(), noIds()));
        assertEq(word(ask(BookClockTrigger.EventData(d, s)), 5), 7);
    }

    /// A request of any other shape is a plain clock tick: n = d = 0 and no registry or inbox call.
    function test_MalformedRequestsGetAPlainClockTick() public {
        deposit(1, address(0xA11CE), 5);
        bytes[] memory bad = new bytes[](9);
        bad[0] = abi.encode(uint256(9)); // the time-free build's request
        bad[1] = abi.encode(uint256(9), uint256(1), uint256(0), uint256(0)); // four words
        bad[2] = abi.encode(uint256(9), uint256(0), uint256(0), uint256(0), uint256(0)); // deposit index 0
        bad[3] = abi.encode(uint256(9), uint256(1) << 64, uint256(0), uint256(0), uint256(0)); // index past uint64
        bad[4] = abi.encode(uint256(9), uint256(1), uint256(1), uint256(0), uint256(0)); // one ID announced, none sent
        bad[5] = abi.encodePacked(request(9, 1, noIds(), noIds(), noIds()), bytes32(uint256(1))); // one sent, none announced
        bad[6] = request(9, 1, made(9, 1), made(4, 2), made(4, 3)); // 17 IDs
        bad[7] = abi.encode(uint256(9), uint256(1), uint256(1) << 255, uint256(1) << 255, uint256(0)); // the sum wraps
        bad[8] = abi.encodePacked(request(9, 1, noIds(), noIds(), noIds()), uint8(1)); // a partial word
        for (uint256 i; i < bad.length; ++i) {
            (uint256 n, uint256 d) = header(ask(one(TICK, bad[i])), 9);
            assertEq(n + d, 0);
        }
        assertEq(uint256(registry.phase(slot(S1))), uint256(StreamsRoundRegistry.Phase.Missing));
    }

    // ------------------------------------------------------------------ registry records (section 10)

    /// A request with no rounds held creates the market's next two slots in the registry and reports both.
    function test_CreatesTheNextTwoSlots() public {
        bytes memory p = askFor(5, 1, noIds(), noIds(), noIds());
        assertEq(records(p, 5), 2);
        for (uint32 i; i < 2; ++i) {
            assertEq(uint256(registry.phase(slot(S1 + i * D))), uint256(StreamsRoundRegistry.Phase.Scheduled));
            assertRecord(p, slot(S1 + i * D));
        }
    }

    /// Records only where the registry is ahead of the engine: an asked scheduled round that opened or ended, an
    /// asked open round that ended, an asked confirmation round that ended, a next slot nobody asked about.
    function test_RecordsOnlyWhereTheRegistryIsAhead() public {
        askFor(1, 1, noIds(), noIds(), noIds());
        (bytes32 r1, bytes32 r2, bytes32 r3, bytes32 r4) = (slot(S1), slot(S1 + D), slot(S1 + 2 * D), slot(S1 + 3 * D));
        assertEq(records(askFor(2, 1, ids(r1, r2), noIds(), noIds()), 2), 0);

        vm.warp(S1 + 2);
        registry.recordOpening(r1, abi.encode(observed(S1, 97_000e18)));
        bytes memory p = askFor(3, 1, ids(r1, r2), noIds(), noIds()); // r1 opened; r3 is a new next slot
        assertEq(records(p, 3), 2);
        assertRecord(p, r1);
        assertRecord(p, r3);
        // An open round, and a round awaiting confirmation, without an outcome are not ahead.
        assertEq(records(askFor(4, 1, ids(r2, r3), noIds(), ids(r1)), 4), 0);
        assertEq(records(askFor(4, 1, ids(r2, r3), ids(r1), noIds()), 4), 0);

        vm.warp(S1 + D + 3);
        registry.resolveRound(r1, abi.encode(observed(S1 + D, 97_000e18 + 1)));
        // The guest settled r1 itself and archived it: it asks only for the registry's confirmation.
        p = askFor(5, 1, ids(r2, r3), noIds(), ids(r1));
        assertEq(records(p, 5), 2);
        assertRecord(p, r1);
        assertRecord(p, r4);
        assertEq(word(p, 8 + 6), 1); // r1 first: outcome Up
    }

    /// At most sixteen records: sixteen ended rounds asked about fill the answer, and the two new slots wait.
    function test_RecordCap() public {
        bytes32[] memory asked = new bytes32[](16);
        for (uint32 i; i < 16; ++i) {
            asked[i] = registry.createRound(StreamsRoundRegistry.Asset.BTC, D, S1 + i * D);
        }
        for (uint32 i; i < 16; ++i) {
            vm.warp(S1 + i * D + 2);
            registry.recordOpening(asked[i], abi.encode(observed(S1 + i * D, 97_000e18)));
        }
        bytes32[] memory s = new bytes32[](6);
        bytes32[] memory o = new bytes32[](5);
        bytes32[] memory c = new bytes32[](5);
        for (uint256 i; i < 16; ++i) {
            if (i < 6) s[i] = asked[i];
            else if (i < 11) o[i - 6] = asked[i];
            else c[i - 11] = asked[i];
        }
        vm.warp(S1 + 16 * D + 5);
        for (uint256 i; i < 16; ++i) {
            if (i < 15) registry.resolveRound(asked[i], abi.encode(observed(S1 + uint32(i + 1) * D, 97_000e18)));
        }
        bytes memory p = askFor(3, 1, s, o, c);
        assertEq(records(p, 3), 16); // fifteen ended rounds and the first new slot; the second waits
        assertEq(p.length, 256 + 16 * 608);
    }

    // ------------------------------------------------------------------ deposit records (section 6)

    /// From the index the guest asks for, up to eight contiguous inbox records, word for word; none past a gap.
    function test_DepositRecords() public {
        for (uint64 i = 1; i <= 10; ++i) {
            deposit(i, address(uint160(0xD000 + i)), 1_000_000 * i);
        }
        deposit(12, address(0xD00C), 12); // after a gap at 11
        bytes memory p = askFor(1, 1, noIds(), noIds(), noIds());
        assertEq(deposits(p, 1), 8);
        assertDeposits(p, 1, 8);
        p = askFor(2, 9, noIds(), noIds(), noIds());
        assertDeposits(p, 9, 2);
        assertEq(deposits(askFor(3, 11, noIds(), noIds(), noIds()), 3), 0);
        p = askFor(4, 12, noIds(), noIds(), noIds());
        assertDeposits(p, 12, 1);
        // Deposit records follow the registry records.
        p = askFor(5, 3, noIds(), noIds(), noIds());
        assertEq(records(p, 5), 2);
        assertDeposits(p, 3, 8);
    }

    /// An inbox that reverts, burns gas or answers anything but whole records: the clock words are intact, the
    /// registry records still come, no deposit record is passed on, and the gas is bounded. The last mode is an
    /// upgraded inbox whose one record the guest is left to judge.
    function test_HostileInboxes() public {
        for (uint256 mode; mode < 8; ++mode) {
            uint256 snapshot = vm.snapshotState();
            vm.etch(address(inbox), address(new HostileInbox(mode)).code);
            uint256 before = gasleft();
            bytes memory p = askFor(11, 1, noIds(), noIds(), noIds());
            uint256 used = before - gasleft();
            console.log("hostile inbox", mode, "gas", used);
            (uint256 n, uint256 d) = header(p, 11);
            assertEq(n, 2);
            assertEq(d, mode == 7 ? 1 : 0);
            assertLe(used, WORST_GAS);
            vm.revertToState(snapshot);
        }
    }

    /// Retiring an application: once the owner upgrades its trigger to WithdrawOnlyBookClockTrigger, the answer in the
    /// same state is the same clock words and registry records byte for byte with d = 0, whatever the inbox holds,
    /// and the proxy's state reads as before. The owner can still upgrade it back.
    function test_WithdrawOnlyUpgrade() public {
        for (uint64 i = 1; i <= 10; ++i) {
            deposit(i, address(uint160(0xD000 + i)), 1_000_000 * i);
        }
        askFor(1, 1, noIds(), noIds(), noIds());
        bytes32 r1 = slot(S1);
        vm.warp(S1 + 2);
        registry.recordOpening(r1, abi.encode(observed(S1, 97_000e18)));
        uint256 snapshot = vm.snapshotState();
        bytes memory full = askFor(2, 3, ids(r1), noIds(), noIds());
        (uint256 n, uint256 d) = header(full, 2);
        assertEq(n, 3); // r1 opened, and the two next slots
        assertEq(d, 8);
        vm.revertToState(snapshot);

        address frozen = address(new WithdrawOnlyBookClockTrigger());
        vm.prank(OWNER);
        trigger.upgradeToAndCall(frozen, "");
        bytes memory p = askFor(2, 3, ids(r1), noIds(), noIds());
        assertEq(deposits(p, 2), 0);
        assembly ("memory-safe") {
            mstore(add(full, 256), 0) // word 7, d
            mstore(full, add(256, mul(608, n))) // without the deposit records
        }
        assertEq(p, full);
        assertEq(address(uint160(uint256(vm.load(address(trigger), IMPLEMENTATION_SLOT)))), frozen);
        assertEq(trigger.owner(), OWNER);
        assertEq(trigger.processorEndpoint(), ENDPOINT);
        assertEq(trigger.registry(), address(registry));
        assertEq(trigger.inbox(), address(inbox));
        assertEq(trigger.asset(), 0);
        assertEq(trigger.duration(), D);

        address book = address(new BookClockTrigger());
        vm.prank(OWNER);
        trigger.upgradeToAndCall(book, "");
        assertEq(deposits(askFor(3, 3, noIds(), noIds(), noIds()), 3), 8);
    }

    /// With a tick request present the trigger never reverts, whatever follows the tick word and whatever the
    /// registry and the inbox do, and the answer always carries the clock words.
    function testFuzz_NeverRevertsWithATickRequest(uint256 tick, bytes calldata rest, uint8 mode) public {
        _hostile(mode);
        header(ask(one(TICK, abi.encodePacked(tick, rest))), tick);
    }

    function testFuzz_WellFormedRequests(uint256 tick, uint64 next, uint8 s, uint8 o, uint8 c, uint256 seed, uint8 mode)
        public
    {
        (s, o, c) = (uint8(bound(s, 0, 8)), uint8(bound(o, 0, 4)), uint8(bound(c, 0, 4)));
        next = uint64(bound(next, 1, type(uint64).max));
        _hostile(mode);
        uint256 before = gasleft();
        bytes memory p = askFor(tick, next, made(s, seed), made(o, ~seed), made(c, seed ^ 1));
        assertLe(before - gasleft(), WORST_GAS);
        header(p, tick);
    }

    function _hostile(uint8 mode) internal {
        mode %= 4;
        if (mode == 1) vm.etch(address(registry), hex"60006000fd");
        if (mode == 2) vm.etch(address(inbox), hex"5b600056");
        if (mode == 3) vm.etch(address(inbox), address(new HostileInbox(3)).code);
    }

    /// The honest inbox's cost for a full page, against which INBOX_GAS is set with a margin of three, and the
    /// cost of the busiest honest answer: sixteen rounds asked, two slots created, eight deposits.
    function test_HonestCosts() public {
        for (uint64 i = 1; i <= 8; ++i) {
            deposit(i, address(uint160(0xD000 + i)), i);
        }
        uint256 before = gasleft();
        inbox.recordsFrom(1, 8);
        uint256 page = before - gasleft();
        console.log("recordsFrom(1, 8) gas", page);
        assertLt(3 * page, trigger.INBOX_GAS());

        bytes32[] memory asked = new bytes32[](8);
        for (uint32 i; i < 8; ++i) {
            asked[i] = registry.createRound(StreamsRoundRegistry.Asset.BTC, D, S1 + (i + 1) * D);
        }
        vm.warp(S1 + 7 * D + 2);
        registry.recordOpening(asked[6], abi.encode(observed(S1 + 7 * D, 97_000e18)));
        before = gasleft();
        bytes memory p = askFor(2, 1, asked, noIds(), made(8, 9));
        uint256 busiest = before - gasleft();
        (uint256 n, uint256 d) = header(p, 2);
        console.log("busiest honest answer gas", busiest, n, d);
        assertEq(d, 8);
        assertLt(busiest, 700_000);
    }

    /// The answer touches the trigger, the registry and the inbox (proxies and implementations) only.
    function test_AnswerTouchesOnlyTheRegistryAndInbox() public {
        address[5] memory allowed = [
            address(trigger),
            address(registry),
            address(uint160(uint256(vm.load(address(registry), IMPLEMENTATION_SLOT)))),
            address(inbox),
            address(uint160(uint256(vm.load(address(inbox), IMPLEMENTATION_SLOT))))
        ];
        BookClockTrigger.EventData memory e = one(TICK, request(1, 1, noIds(), noIds(), noIds()));
        address implementation = address(uint160(uint256(vm.load(address(trigger), IMPLEMENTATION_SLOT))));
        vm.startPrank(ENDPOINT);
        vm.startStateDiffRecording();
        trigger.getTrustProcessPayload(e, false, false, none, none);
        Vm.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();
        vm.stopPrank();
        for (uint256 i; i < accesses.length; ++i) {
            address a = accesses[i].account;
            bool ok = a == implementation;
            for (uint256 k; k < allowed.length; ++k) {
                ok = ok || a == allowed[k];
            }
            assertTrue(ok);
        }
    }

    // ------------------------------------------------------------------ custody and access

    function test_HoldsAndReturnsNothing() public {
        vm.startPrank(ENDPOINT);
        trigger.execute(one(TICK, abi.encode(uint256(1))));
        (BookClockTrigger.TokenAndAmount[] memory returned, BookClockTrigger.TokenAndAmount[] memory failed) =
            trigger.withdraw();
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
        BookClockTrigger.EventData memory e = one(TICK, abi.encode(uint256(1)));
        vm.startPrank(caller);
        vm.expectRevert(BookClockTrigger.NotProcessorEndpoint.selector);
        trigger.getTrustProcessPayload(e, true, true, none, none);
        vm.expectRevert(BookClockTrigger.NotProcessorEndpoint.selector);
        trigger.execute(e);
        vm.expectRevert(BookClockTrigger.NotProcessorEndpoint.selector);
        trigger.withdraw();
        vm.stopPrank();
    }

    /// The three selectors are the ones a v0.2.0 ProcessorEndpoint calls (ITrigger), and the registry and inbox
    /// calls are their own.
    function test_Selectors() public pure {
        assertEq(
            BookClockTrigger.getTrustProcessPayload.selector,
            bytes4(
                keccak256(
                    "getTrustProcessPayload((bytes[],bytes32[]),bool,bool,(address,uint256)[],(address,uint256)[])"
                )
            )
        );
        assertEq(BookClockTrigger.execute.selector, bytes4(keccak256("execute((bytes[],bytes32[]))")));
        assertEq(BookClockTrigger.withdraw.selector, bytes4(keccak256("withdraw()")));
        assertEq(StreamsRoundRegistry.createRound.selector, bytes4(keccak256("createRound(uint8,uint32,uint64)")));
        assertEq(StreamsRoundRegistry.roundIdFor.selector, bytes4(keccak256("roundIdFor(uint8,uint32,uint64)")));
        assertEq(StreamsRoundRegistry.getRound.selector, bytes4(keccak256("getRound(bytes32)")));
        assertEq(HorizenDepositInbox.recordsFrom.selector, bytes4(keccak256("recordsFrom(uint64,uint256)")));
    }
}
