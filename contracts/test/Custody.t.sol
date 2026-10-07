// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, Vm} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {
    OwnableUpgradeable
} from "../node_modules/@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {BaseCustodyVault as Vault, IDepositInbox} from "../src/BaseCustodyVault.sol";
import {HorizenDepositInbox as Inbox} from "../src/HorizenDepositInbox.sol";
import {MockMessenger, PermitToken} from "./mocks/MockCustody.sol";

/// @dev Deploys both proxies exactly as planned for mainnet: implementation + ERC1967Proxy(initialize).
library CustodyProxies {
    function vault(address owner, address signer, address inbox_, Vault.Limits memory limits)
        internal
        returns (Vault)
    {
        bytes memory setup = abi.encodeCall(Vault.initialize, (owner, signer, inbox_, limits));
        return Vault(address(new ERC1967Proxy(address(new Vault()), setup)));
    }

    function inbox(address owner, address vault_) internal returns (Inbox) {
        return Inbox(
            address(new ERC1967Proxy(address(new Inbox()), abi.encodeCall(Inbox.initialize, (owner, vault_))))
        );
    }

    /// @dev The planned defaults: 1-500 USDC per deposit, 1,000 USDC per payout, 10,000 USDC of payouts a day.
    function defaults() internal pure returns (Vault.Limits memory) {
        return Vault.Limits(1e6, 500e6, 1000e6, 10_000e6);
    }
}

/// @dev Both sides in one EVM: USDC and the two messengers are mocks placed at their real addresses, so the vault's
/// constants are the mainnet ones. The Horizen messenger relays what the Base one recorded.
abstract contract CustodyBase is Test {
    address internal constant OWNER = address(0x0A11);
    address internal constant RELAYER = address(0x0B22);
    address internal constant BASE_MESSENGER = 0x9F5e33f901ad50B50d6A27f63aDaBEA4c81e953c;
    address internal constant HORIZEN_MESSENGER = 0x4200000000000000000000000000000000000007;
    address internal constant USDC_ADDRESS = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    uint256 internal constant SIGNER_PK = 0x5167;
    uint256 internal constant USER_PK = 0xA11CE;
    uint256 internal constant T0 = 1_791_320_000;
    uint64 internal constant APP = 7_225_536_188_967_924_955;
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 internal constant PAYOUT_TYPEHASH =
        keccak256("Payout(uint64 applicationId,uint64 ordinal,address account,address to,uint256 amount)");

    PermitToken internal usdc;
    MockMessenger internal baseMessenger;
    MockMessenger internal horizenMessenger;
    Vault internal vault;
    Inbox internal inbox;
    address internal signer;
    address internal user;

    function setUp() public virtual {
        vm.warp(T0);
        vm.chainId(8453);
        deployCodeTo("MockCustody.sol:PermitToken", abi.encode("USD Coin"), USDC_ADDRESS);
        deployCodeTo("MockCustody.sol:MockMessenger", abi.encode(HORIZEN_MESSENGER), BASE_MESSENGER);
        deployCodeTo("MockCustody.sol:MockMessenger", abi.encode(BASE_MESSENGER), HORIZEN_MESSENGER);
        usdc = PermitToken(USDC_ADDRESS);
        baseMessenger = MockMessenger(BASE_MESSENGER);
        horizenMessenger = MockMessenger(HORIZEN_MESSENGER);
        signer = vm.addr(SIGNER_PK);
        user = vm.addr(USER_PK);
        // The inbox is created first, naming the vault proxy at its predicted address (two creations later).
        uint64 nonce = vm.getNonce(address(this));
        inbox = CustodyProxies.inbox(OWNER, vm.computeCreateAddress(address(this), nonce + 3));
        vault = CustodyProxies.vault(OWNER, signer, address(inbox), CustodyProxies.defaults());
        assertEq(inbox.vault(), address(vault));
        usdc.mint(user, 10_000e6);
    }

    function permit(uint256 pk, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        address owner = vm.addr(pk);
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, usdc.nonces(owner), deadline));
        return vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", usdc.DOMAIN_SEPARATOR(), structHash)));
    }

    function deposit(uint256 amount) internal returns (uint64) {
        uint256 deadline = block.timestamp + 1200;
        (uint8 v, bytes32 r, bytes32 s) = permit(USER_PK, address(vault), amount, deadline);
        vm.prank(RELAYER);
        return vault.depositWithPermit(user, amount, deadline, v, r, s);
    }

    /// @dev Delivers the n-th message the Base messenger recorded, from its recorded sender, to its recorded target.
    function deliver(uint256 n) internal returns (bool) {
        MockMessenger.Sent memory m = baseMessenger.sent(n);
        return horizenMessenger.relay(m.sender, m.target, m.message);
    }

    function domain(address verifying, uint256 chainId) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256("ZEDGE Vault"),
                keccak256("1"),
                chainId,
                verifying
            )
        );
    }

    function sign(uint256 pk, Vault.Payout memory p, address verifying, uint256 chainId)
        internal
        pure
        returns (bytes memory)
    {
        bytes32 structHash =
            keccak256(abi.encode(PAYOUT_TYPEHASH, p.applicationId, p.ordinal, p.account, p.to, p.amount));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", domain(verifying, chainId), structHash)));
        return abi.encodePacked(r, s, v);
    }

    function signed(Vault.Payout memory p) internal view returns (bytes memory) {
        return sign(SIGNER_PK, p, address(vault), block.chainid);
    }

    function payout(uint64 ordinal, address to, uint256 amount) internal view returns (Vault.Payout memory) {
        return Vault.Payout(APP, ordinal, user, to, amount);
    }
}

contract BaseCustodyVaultTest is CustodyBase {
    function testDepositPullsWithThePermitAndAnnouncesTheIndexToTheInbox() public {
        vm.recordLogs();
        uint64 index = deposit(250e6);
        assertEq(index, 1);
        assertEq(vault.depositCount(), 1);
        assertEq(usdc.balanceOf(address(vault)), 250e6);
        assertEq(usdc.balanceOf(user), 9750e6);
        assertEq(usdc.allowance(user, address(vault)), 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory last = logs[logs.length - 1];
        assertEq(last.emitter, address(vault));
        assertEq(last.topics[0], Vault.Deposited.selector);
        assertEq(last.topics[1], bytes32(uint256(1)));
        assertEq(last.topics[2], bytes32(uint256(uint160(user))));
        assertEq(abi.decode(last.data, (uint256)), 250e6);

        assertEq(baseMessenger.sentCount(), 1);
        MockMessenger.Sent memory m = baseMessenger.sent(0);
        assertEq(m.sender, address(vault));
        assertEq(m.target, address(inbox));
        assertEq(m.minGasLimit, 100_000);
        assertEq(m.message, abi.encodeCall(IDepositInbox.receiveDeposit, (1, user, 250e6)));

        assertTrue(deliver(0));
        (address account, uint96 amount) = inbox.deposits(1);
        assertEq(account, user);
        assertEq(amount, 250e6);
        assertEq(inbox.highest(), 1);
        assertEq(deposit(1e6), 2, "indexes count up by one");
    }

    function testAPermitAlreadyUsedByAnyoneStillDeposits() public {
        uint256 deadline = block.timestamp + 1200;
        (uint8 v, bytes32 r, bytes32 s) = permit(USER_PK, address(vault), 100e6, deadline);
        usdc.permit(user, address(vault), 100e6, deadline, v, r, s); // front-run with the same permit
        vm.prank(RELAYER);
        assertEq(vault.depositWithPermit(user, 100e6, deadline, v, r, s), 1);
        assertEq(usdc.balanceOf(address(vault)), 100e6);
    }

    function testWithoutAPermitOrAllowanceNothingMovesAndNoIndexIsUsed() public {
        uint256 deadline = block.timestamp + 1200;
        (uint8 v, bytes32 r, bytes32 s) = permit(USER_PK, address(vault), 100e6, deadline);
        vm.expectRevert(Vault.TransferFailed.selector); // a permit for another amount does not authorise this one
        vault.depositWithPermit(user, 101e6, deadline, v, r, s);
        vm.warp(deadline + 1);
        vm.expectRevert(Vault.TransferFailed.selector); // expired permit
        vault.depositWithPermit(user, 100e6, deadline, v, r, s);
        assertEq(vault.depositCount(), 0);
        assertEq(baseMessenger.sentCount(), 0);
        assertEq(usdc.balanceOf(address(vault)), 0);
    }

    function testABalanceBelowTheAmountMovesNothing() public {
        address poor = vm.addr(0xB0B);
        usdc.mint(poor, 5e6);
        uint256 deadline = block.timestamp + 1200;
        (uint8 v, bytes32 r, bytes32 s) = permit(0xB0B, address(vault), 6e6, deadline);
        vm.expectRevert(Vault.TransferFailed.selector);
        vault.depositWithPermit(poor, 6e6, deadline, v, r, s);
        assertEq(vault.depositCount(), 0);
    }

    function testDepositsOutsideTheLimitsAreRefused() public {
        vm.expectRevert(Vault.AmountOutOfRange.selector);
        vault.depositWithPermit(user, 1e6 - 1, 0, 0, 0, 0);
        vm.expectRevert(Vault.AmountOutOfRange.selector);
        vault.depositWithPermit(user, 500e6 + 1, 0, 0, 0, 0);
        vm.expectRevert(Vault.AmountOutOfRange.selector);
        vault.depositWithPermit(address(0), 10e6, 0, 0, 0, 0);
        deposit(500e6);
        deposit(1e6);
        // maxDeposit 0 halts deposits.
        vm.prank(OWNER);
        vault.setLimits(Vault.Limits(1e6, 0, 1000e6, 10_000e6));
        vm.expectRevert(Vault.AmountOutOfRange.selector);
        vault.depositWithPermit(user, 1e6, 0, 0, 0, 0);
    }

    function testWithdrawPaysTheSignedPayoutOnce() public {
        deposit(500e6);
        address to = address(0xD00D);
        Vault.Payout memory p = payout(1, to, 120e6);
        vm.expectEmit(address(vault));
        emit Vault.Paid(APP, 1, to, user, 120e6);
        vm.prank(address(0xCAFE)); // anyone may send it
        vault.withdraw(p, signed(p));
        assertEq(usdc.balanceOf(to), 120e6);
        assertEq(usdc.balanceOf(address(vault)), 380e6, "balance = deposited - paid");
        assertTrue(vault.paid(APP, 1));
        assertEq(vault.paidOnDay(T0 / 1 days), 120e6);
        vm.expectRevert(Vault.AlreadyPaid.selector);
        vault.withdraw(p, signed(p));
        // Any order; another application's ordinal 1 is a different payout.
        Vault.Payout memory later = payout(7, to, 1e6);
        vault.withdraw(later, signed(later));
        Vault.Payout memory other = Vault.Payout(APP + 1, 1, user, to, 1e6);
        vault.withdraw(other, signed(other));
        assertEq(usdc.balanceOf(address(vault)), 378e6);
        assertEq(
            vault.payoutDigest(p),
            keccak256(
                abi.encodePacked(
                    "\x19\x01",
                    domain(address(vault), 8453),
                    keccak256(
                        abi.encode(PAYOUT_TYPEHASH, p.applicationId, p.ordinal, p.account, p.to, p.amount)
                    )
                )
            )
        );
    }

    function testOnlyTheSignersSignatureOverExactlyThisPayoutPays() public {
        deposit(500e6);
        Vault.Payout memory p = payout(1, user, 10e6);
        bytes memory good = signed(p);
        vm.expectRevert(Vault.BadSignature.selector);
        vault.withdraw(p, sign(USER_PK, p, address(vault), 8453));
        vm.expectRevert(Vault.BadSignature.selector); // another proxy's domain
        vault.withdraw(p, sign(SIGNER_PK, p, address(0xBEEF), 8453));
        vm.expectRevert(Vault.BadSignature.selector); // another chain's domain
        vault.withdraw(p, sign(SIGNER_PK, p, address(vault), 26514));
        for (uint256 field; field < 5; ++field) {
            Vault.Payout memory q = payout(1, user, 10e6);
            if (field == 0) q.applicationId += 1;
            if (field == 1) q.ordinal += 1;
            if (field == 2) q.account = address(0xA);
            if (field == 3) q.to = address(0xB);
            if (field == 4) q.amount += 1;
            vm.expectRevert(Vault.BadSignature.selector);
            vault.withdraw(q, good);
        }
        // The malleable high-s twin of a valid signature is refused, and so is a 64-byte one.
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, vault.payoutDigest(p));
        assertEq(abi.encodePacked(r, s, v), good);
        bytes32 highS =
            bytes32(0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141 - uint256(s));
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureS.selector, highS));
        vault.withdraw(p, abi.encodePacked(r, highS, v == 27 ? uint8(28) : uint8(27)));
        vm.expectRevert(abi.encodeWithSelector(ECDSA.ECDSAInvalidSignatureLength.selector, 64));
        vault.withdraw(p, abi.encodePacked(r, s));
        vault.withdraw(p, good);
        // A zero signer halts every payout.
        vm.prank(OWNER);
        vault.setSigner(address(0));
        Vault.Payout memory q2 = payout(2, user, 10e6);
        vm.expectRevert(Vault.BadSignature.selector);
        vault.withdraw(q2, signed(q2));
    }

    function testPayoutRecipientAmountAndCaps() public {
        usdc.mint(user, 2_500e6);
        for (uint256 i; i < 25; ++i) {
            deposit(500e6);
        }
        Vault.Payout memory p = payout(1, address(0), 1e6);
        vm.expectRevert(Vault.InvalidRecipient.selector);
        vault.withdraw(p, signed(p));
        p.to = address(vault);
        vm.expectRevert(Vault.InvalidRecipient.selector);
        vault.withdraw(p, signed(p));
        p = payout(1, user, 0);
        vm.expectRevert(Vault.AmountOutOfRange.selector);
        vault.withdraw(p, signed(p));
        p = payout(1, user, 1000e6 + 1);
        vm.expectRevert(Vault.AmountOutOfRange.selector);
        vault.withdraw(p, signed(p));
        // 10 x 1,000 fills the UTC day; the next one waits for midnight.
        for (uint64 i = 1; i <= 10; ++i) {
            p = payout(i, user, 1000e6);
            vault.withdraw(p, signed(p));
        }
        p = payout(11, user, 1);
        vm.expectRevert(Vault.CapExceeded.selector);
        vault.withdraw(p, signed(p));
        vm.warp((T0 / 1 days + 1) * 1 days);
        vault.withdraw(p, signed(p));
        assertEq(usdc.balanceOf(address(vault)), 12_500e6 - 10_000e6 - 1);
    }

    function testInitializeValidatesEverything() public {
        Vault.Limits memory l = CustodyProxies.defaults();
        Vault impl = new Vault();
        bytes[4] memory bad = [
            abi.encodeCall(Vault.initialize, (OWNER, signer, address(0), l)),
            abi.encodeCall(Vault.initialize, (address(0), signer, address(inbox), l)),
            abi.encodeCall(Vault.initialize, (OWNER, signer, address(inbox), Vault.Limits(0, 1, 1, 1))),
            abi.encodeCall(Vault.initialize, (OWNER, signer, address(inbox), Vault.Limits(2, 1, 1, 1)))
        ];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert();
            new ERC1967Proxy(address(impl), bad[i]);
        }
        // The Base messenger must point at Horizen's.
        deployCodeTo("MockCustody.sol:MockMessenger", abi.encode(address(0x1234)), BASE_MESSENGER);
        vm.expectRevert(Vault.InvalidConfig.selector);
        new ERC1967Proxy(address(impl), abi.encodeCall(Vault.initialize, (OWNER, signer, address(inbox), l)));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(OWNER, signer, address(inbox), l);
        // A zero signer is allowed at setup: payouts stay halted until the owner sets one.
        deployCodeTo("MockCustody.sol:MockMessenger", abi.encode(HORIZEN_MESSENGER), BASE_MESSENGER);
        Vault unsigned = CustodyProxies.vault(OWNER, address(0), address(inbox), l);
        assertEq(unsigned.signer(), address(0));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        vault.initialize(OWNER, signer, address(inbox), l);
    }

    function testGettersSettersAndEvents() public {
        assertEq(vault.owner(), OWNER);
        assertEq(vault.signer(), signer);
        assertEq(vault.inbox(), address(inbox));
        assertEq(abi.encode(vault.limits()), abi.encode(CustodyProxies.defaults()));
        assertEq(vault.version(), "1");
        assertEq(address(vault.USDC()), USDC_ADDRESS);
        assertEq(address(vault.MESSENGER()), BASE_MESSENGER);
        assertEq(vault.HORIZEN_MESSENGER(), HORIZEN_MESSENGER);
        assertEq(vault.MIN_GAS_LIMIT(), 100_000);
        assertEq(vault.PAYOUT_TYPEHASH(), PAYOUT_TYPEHASH);
        (bytes1 fields, string memory name, string memory ver, uint256 chainId, address at,,) =
            vault.eip712Domain();
        assertEq(
            abi.encode(fields, name, ver, chainId, at),
            abi.encode(bytes1(0x0f), "ZEDGE Vault", "1", 8453, address(vault))
        );

        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, address(this))
        );
        vault.setSigner(address(1));
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, address(this))
        );
        vault.setLimits(CustodyProxies.defaults());
        vm.startPrank(OWNER);
        vm.expectEmit(address(vault));
        emit Vault.SignerChanged(signer, address(1));
        vault.setSigner(address(1));
        Vault.Limits memory l = Vault.Limits(2e6, 100e6, 50e6, 50e6);
        vm.expectEmit(address(vault));
        emit Vault.LimitsChanged(l);
        vault.setLimits(l);
        assertEq(abi.encode(vault.limits()), abi.encode(l));
        Vault.Limits[5] memory bad = [
            Vault.Limits(0, 100e6, 50e6, 50e6),
            Vault.Limits(101e6, 100e6, 50e6, 50e6),
            Vault.Limits(1, uint128(type(uint96).max) + 1, 50e6, 50e6),
            Vault.Limits(1, 100e6, 0, 50e6),
            Vault.Limits(1, 100e6, 51e6, 50e6)
        ];
        for (uint256 i; i < bad.length; ++i) {
            vm.expectRevert(Vault.InvalidLimits.selector);
            vault.setLimits(bad[i]);
        }
        vm.stopPrank();
    }

    function testUpgradeOnlyByOwnerTwoStepOwnershipNoRenounce() public {
        address next = address(new Vault());
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, address(this))
        );
        vault.upgradeToAndCall(next, "");
        vm.prank(OWNER);
        vm.expectRevert(Vault.RenounceDisabled.selector);
        vault.renounceOwnership();
        vm.prank(OWNER);
        vault.transferOwnership(address(0xBEEF));
        assertEq(vault.owner(), OWNER, "two-step: not moved until accepted");
        vm.prank(address(0xBEEF));
        vault.acceptOwnership();
        assertEq(vault.owner(), address(0xBEEF));
        deposit(10e6);
        vm.prank(address(0xBEEF));
        vault.upgradeToAndCall(next, "");
        assertEq(address(uint160(uint256(vm.load(address(vault), ERC1967Utils.IMPLEMENTATION_SLOT)))), next);
        assertEq(vault.depositCount(), 1, "state survives the upgrade");
        assertEq(vault.signer(), signer);
    }

    function testProxyStorageLayoutIsPinned() public {
        bytes32 base = keccak256(abi.encode(uint256(keccak256("zedge.storage.BaseCustodyVault")) - 1))
            & ~bytes32(uint256(0xff));
        assertEq(base, 0x1dc441e6ee1e352ce2c6e1b3a538f1d2b52a3850e87ce368d25afa750b02e200);
        deposit(10e6);
        Vault.Payout memory p = payout(3, user, 4e6);
        vault.withdraw(p, signed(p));
        uint256 slot = uint256(base);
        assertEq(address(uint160(load(slot))), signer, "slot 0: signer");
        assertEq(
            load(slot + 1),
            uint256(uint160(address(inbox))) | (uint256(1) << 160),
            "slot 1: inbox, depositCount"
        );
        assertEq(load(slot + 2), uint256(500e6) << 128 | 1e6, "slot 2: minDeposit, maxDeposit");
        assertEq(load(slot + 3), uint256(10_000e6) << 128 | 1000e6, "slot 3: maxPayout, dailyPayoutCap");
        bytes32 outer = keccak256(abi.encode(uint256(APP), slot + 4));
        assertEq(
            uint256(vm.load(address(vault), keccak256(abi.encode(uint256(3), outer)))),
            1,
            "slot 4: paid[app][ordinal]"
        );
        assertEq(
            uint256(vm.load(address(vault), keccak256(abi.encode(T0 / 1 days, slot + 5)))),
            4e6,
            "slot 5: paidOnDay"
        );
    }

    function load(uint256 slot) internal view returns (uint256) {
        return uint256(vm.load(address(vault), bytes32(slot)));
    }

    function testFuzzDepositsAndPayoutsKeepTheBalanceEqualToDepositedLessPaid(
        uint32[8] memory amounts,
        bool[8] memory pay
    ) public {
        uint256 deposited;
        uint256 paidOut;
        for (uint256 i; i < 8; ++i) {
            uint256 a = bound(amounts[i], 1e6, 500e6);
            deposit(a);
            deposited += a;
            if (pay[i]) {
                uint256 out = bound(amounts[i], 1, a);
                Vault.Payout memory p = payout(uint64(i + 1), address(0xD00D), out);
                vault.withdraw(p, signed(p));
                paidOut += out;
            }
            assertEq(usdc.balanceOf(address(vault)), deposited - paidOut);
            assertEq(vault.depositCount(), i + 1);
        }
    }

    function testFuzzLimitsValidation(Vault.Limits memory l) public {
        bool ok = l.minDeposit != 0 && (l.maxDeposit == 0 || l.minDeposit <= l.maxDeposit)
            && l.maxDeposit <= type(uint96).max && l.maxPayout != 0 && l.maxPayout <= l.dailyPayoutCap;
        vm.prank(OWNER);
        if (!ok) vm.expectRevert(Vault.InvalidLimits.selector);
        vault.setLimits(l);
    }
}

contract HorizenDepositInboxTest is CustodyBase {
    function receiveAs(address sender, uint64 index, address account, uint256 amount)
        internal
        returns (bool)
    {
        return horizenMessenger.relay(
            sender, address(inbox), abi.encodeCall(Inbox.receiveDeposit, (index, account, amount))
        );
    }

    function testOnlyTheVaultThroughTheMessengerWritesADeposit() public {
        vm.expectRevert(Inbox.UnauthorizedMessenger.selector);
        inbox.receiveDeposit(1, user, 5e6); // not the messenger
        assertFalse(receiveAs(address(0xBAD), 1, user, 5e6), "another Base sender");
        vm.expectEmit(address(inbox));
        emit Inbox.DepositReceived(1, user, 5e6);
        assertTrue(receiveAs(address(vault), 1, user, 5e6));
        assertFalse(receiveAs(address(vault), 1, user, 5e6), "each index once");
        vm.mockCall(
            HORIZEN_MESSENGER, abi.encodeWithSignature("xDomainMessageSender()"), abi.encode(address(vault))
        );
        vm.prank(HORIZEN_MESSENGER);
        vm.expectRevert(abi.encodeWithSelector(Inbox.DepositExists.selector, 1));
        inbox.receiveDeposit(1, user, 5e6);
        vm.clearMockedCalls();
        assertFalse(receiveAs(address(vault), 0, user, 5e6), "index 0");
        assertFalse(receiveAs(address(vault), 2, address(0), 5e6), "no account");
        assertFalse(receiveAs(address(vault), 2, user, 0), "no amount");
        assertFalse(receiveAs(address(vault), 2, user, uint256(type(uint96).max) + 1), "above uint96");
        assertTrue(receiveAs(address(vault), 2, user, type(uint96).max));
    }

    function testRecordsFromIsContiguousAndBounded() public {
        // Out of order: 3 and 1 first, then 2; 5 leaves a gap at 4.
        for (uint64 i = 1; i <= 12; ++i) {
            if (i != 4) {
                assertTrue(
                    receiveAs(
                        address(vault), i == 2 ? 3 : i == 3 ? 2 : i, address(uint160(0x100 + i)), i * 1e6
                    )
                );
            }
        }
        assertEq(inbox.highest(), 12);
        uint256[] memory w = inbox.recordsFrom(1, 8);
        assertEq(w.length, 9, "1..3, stops at the gap at 4");
        assertEq(w[0], 1);
        assertEq(w[1], 0x101);
        assertEq(w[2], 1e6);
        assertEq(w[3], 2);
        assertEq(w[4], 0x103, "index 2 came in the third message");
        assertEq(w[6], 3);
        assertEq(inbox.recordsFrom(4, 8).length, 0);
        assertEq(inbox.recordsFrom(5, 8).length, 24, "8 records at most");
        assertEq(inbox.recordsFrom(5, 2).length, 6);
        assertEq(inbox.recordsFrom(0, 8).length, 0);
        assertEq(inbox.recordsFrom(13, 8).length, 0);
        vm.expectRevert(Inbox.TooMany.selector);
        inbox.recordsFrom(5, 9);
        (address a, uint96 amt) = inbox.deposits(4);
        assertEq(a, address(0));
        assertEq(amt, 0);
    }

    function testInitializeUpgradeOwnershipAndLayout() public {
        Inbox impl = new Inbox();
        vm.expectRevert(Inbox.InvalidConfig.selector);
        new ERC1967Proxy(address(impl), abi.encodeCall(Inbox.initialize, (OWNER, address(0))));
        vm.expectRevert();
        new ERC1967Proxy(address(impl), abi.encodeCall(Inbox.initialize, (address(0), address(vault))));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        inbox.initialize(OWNER, address(vault));
        assertEq(inbox.owner(), OWNER);
        assertEq(inbox.version(), "1");
        assertEq(address(inbox.MESSENGER()), HORIZEN_MESSENGER);
        vm.prank(OWNER);
        vm.expectRevert(Inbox.RenounceDisabled.selector);
        inbox.renounceOwnership();
        vm.expectRevert(
            abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, address(this))
        );
        inbox.upgradeToAndCall(address(impl), "");

        assertTrue(receiveAs(address(vault), 9, user, 7e6));
        bytes32 base = keccak256(abi.encode(uint256(keccak256("zedge.storage.HorizenDepositInbox")) - 1))
            & ~bytes32(uint256(0xff));
        assertEq(base, 0xfbd20bf20924bfc9bc569475d263898c3f42116965c6bce3c578298b4e226f00);
        assertEq(
            uint256(vm.load(address(inbox), base)),
            uint256(uint160(address(vault))) | (uint256(9) << 160),
            "vault, highest"
        );
        assertEq(
            uint256(vm.load(address(inbox), keccak256(abi.encode(uint256(9), uint256(base) + 1)))),
            uint256(uint160(user)) | (uint256(7e6) << 160),
            "deposits[index]: account, amount in one slot"
        );
        vm.prank(OWNER);
        inbox.upgradeToAndCall(address(impl), "");
        (address a, uint96 amt) = inbox.deposits(9);
        assertEq(a, user);
        assertEq(amt, 7e6);
    }

    function testFuzzRecordsMatchWhatWasReceived(uint8 count, uint8 from) public {
        count = uint8(bound(count, 0, 20));
        for (uint64 i = 1; i <= count; ++i) {
            assertTrue(receiveAs(address(vault), i, address(uint160(0x1000 + i)), i));
        }
        uint64 start = uint64(bound(from, 1, 25));
        uint256[] memory w = inbox.recordsFrom(start, 8);
        uint256 expected = start > count ? 0 : count - start + 1 > 8 ? 8 : count - start + 1;
        assertEq(w.length, 3 * expected);
        for (uint256 i; i < expected; ++i) {
            assertEq(w[3 * i], start + i);
            assertEq(w[3 * i + 1], 0x1000 + start + i);
            assertEq(w[3 * i + 2], start + i);
        }
    }
}
