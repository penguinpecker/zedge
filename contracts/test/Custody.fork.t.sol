// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {BaseCustodyVault as Vault, IDepositInbox} from "../src/BaseCustodyVault.sol";
import {HorizenDepositInbox as Inbox} from "../src/HorizenDepositInbox.sol";
import {CustodyProxies} from "./Custody.t.sol";

interface IForkMessenger {
    function otherMessenger() external view returns (address);
    function baseGas(bytes calldata message, uint32 minGasLimit) external pure returns (uint64);
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
    function sendMessage(address target, bytes calldata message, uint32 minGasLimit) external payable;
}

interface IForkUsdc {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
    function nonces(address owner) external view returns (uint256);
}

/// @notice Opt-in two-fork test of the custody route against the REAL Base USDC, the REAL Base -> Horizen messenger
/// and the REAL Horizen messenger: a permit deposit through the vault, its native message relayed into the inbox
/// from the messenger's deposit alias (impersonated LOCALLY: OP derivation and the live relay are not tested), a
/// relay within the gas the message pays for, a forged sender refused, and a signed payout of real USDC.
///   forge test --root contracts --match-contract CustodyForkTest --fork-url https://26514.rpc.thirdweb.com -vv
/// The Base fork is https://base-rpc.publicnode.com (or BASE_RPC_URL). Both at their latest blocks. Horizen is the
/// first fork because Forge 1.7.1 panics running Horizen blocks after an OP-fee (Base) first fork. The
/// proxies are created by the planned deployer at its current nonces on each chain, so their addresses are the
/// planned ones while those nonces hold. Offline runs skip it.
contract CustodyForkTest is Test {
    address private constant OWNER = 0x279173ac297aD146bc92f877552C8C2B78334d07;
    address private constant RELAYER = 0x9336887B575F11dA697f53614d0F2A262DdEd024;
    address private constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address private constant BASE_MESSENGER = 0x9F5e33f901ad50B50d6A27f63aDaBEA4c81e953c;
    address private constant HORIZEN_MESSENGER = 0x4200000000000000000000000000000000000007;
    bytes32 private constant USDC_DOMAIN_SEPARATOR =
        0x02fa7265e7c5d81118673727957699e4d68f74cd74b7db77da710fe8a2c7834f;
    bytes32 private constant SENT_MESSAGE = keccak256("SentMessage(address,address,bytes,uint256,uint256)");
    bytes32 private constant SENT_EXTENSION = keccak256("SentMessageExtension1(address,uint256)");
    bytes32 private constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    uint256 private constant USER_PK = 0xA11CE;
    uint256 private constant SIGNER_PK = 0x5167;
    uint64 private constant APP = 7_225_536_188_967_924_955;

    struct Message {
        uint256 nonce;
        address sender;
        address target;
        uint256 value;
        uint256 minGasLimit;
        bytes data;
    }

    uint256 private baseFork;
    uint256 private horizenFork;
    Vault private vault;
    Inbox private inbox;
    address private user;

    function testForkDepositIsDeliveredOnceAndAPayoutPaysRealUsdc() public {
        vm.skip(block.chainid != 26514, "requires a Horizen fork (--fork-url) and a public Base RPC");
        deployPlanned();
        Message memory m = depositOnBase();
        deliverOnHorizen(m);
        payOnBase();
    }

    function deployPlanned() private {
        horizenFork = vm.activeFork();
        baseFork = vm.createSelectFork(vm.envOr("BASE_RPC_URL", string("https://base-rpc.publicnode.com")));
        assertEq(block.chainid, 8453);
        assertEq(IForkMessenger(BASE_MESSENGER).otherMessenger(), HORIZEN_MESSENGER);
        assertEq(IForkUsdc(USDC).DOMAIN_SEPARATOR(), USDC_DOMAIN_SEPARATOR);
        address vaultAt = vm.computeCreateAddress(OWNER, vm.getNonce(OWNER) + 1);

        vm.selectFork(horizenFork);
        assertEq(IForkMessenger(HORIZEN_MESSENGER).otherMessenger(), BASE_MESSENGER);
        address inboxAt = vm.computeCreateAddress(OWNER, vm.getNonce(OWNER) + 1);
        vm.startPrank(OWNER, OWNER);
        inbox = CustodyProxies.inbox(OWNER, vaultAt);
        vm.stopPrank();
        assertEq(address(inbox), inboxAt, "planned inbox address");
        emit log_named_address("planned inbox (Horizen)", inboxAt);

        vm.selectFork(baseFork);
        vm.startPrank(OWNER, OWNER);
        vault = CustodyProxies.vault(OWNER, vm.addr(SIGNER_PK), inboxAt, CustodyProxies.defaults());
        vm.stopPrank();
        assertEq(address(vault), vaultAt, "planned vault address");
        emit log_named_address("planned vault (Base)", vaultAt);
    }

    /// @dev A permit deposit sent by the relayer: real USDC moves, one native message to the inbox.
    function depositOnBase() private returns (Message memory m) {
        user = vm.addr(USER_PK);
        deal(USDC, user, 300e6);
        uint256 deadline = block.timestamp + 1200;
        bytes32 permitHash = keccak256(
            abi.encode(PERMIT_TYPEHASH, user, address(vault), 250e6, IForkUsdc(USDC).nonces(user), deadline)
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(USER_PK, keccak256(abi.encodePacked("\x19\x01", USDC_DOMAIN_SEPARATOR, permitHash)));
        vm.recordLogs();
        vm.prank(RELAYER, RELAYER);
        uint256 before = gasleft();
        uint64 index = vault.depositWithPermit(user, 250e6, deadline, v, r, s);
        // Execution only: add 21,000 and calldata for the transaction (vm.lastCallGas does not decode on Forge 1.7.1).
        emit log_named_uint("depositWithPermit execution gas", before - gasleft());
        m = sentMessage(vm.getRecordedLogs());
        assertEq(index, 1);
        assertEq(IERC20(USDC).balanceOf(address(vault)), 250e6);
        assertEq(m.sender, address(vault));
        assertEq(m.target, address(inbox));
        assertEq(m.minGasLimit, 100_000);
        assertEq(m.value, 0);
        assertEq(m.data, abi.encodeCall(IDepositInbox.receiveDeposit, (1, user, 250e6)));
    }

    function deliverOnHorizen(Message memory m) private {
        uint64 paysFor = IForkMessenger(BASE_MESSENGER).baseGas(m.data, 100_000);
        emit log_named_uint("Horizen gas the message pays for (baseGas)", paysFor);
        // Another Base sender cannot pass for the vault.
        vm.recordLogs();
        vm.prank(address(0xBAD));
        IForkMessenger(BASE_MESSENGER).sendMessage(address(inbox), m.data, 100_000);
        Message memory forged = sentMessage(vm.getRecordedLogs());

        vm.selectFork(horizenFork);
        relay(forged, 5_000_000);
        assertTrue(IForkMessenger(HORIZEN_MESSENGER).failedMessages(hashOf(forged)));
        assertEq(inbox.highest(), 0);
        // The real delivery has paysFor gas less the deposit transaction's intrinsic cost; relaying with 60,000
        // less still succeeds.
        relay(m, paysFor - 60_000);
        assertTrue(IForkMessenger(HORIZEN_MESSENGER).successfulMessages(hashOf(m)));
        (address account, uint96 amount) = inbox.deposits(1);
        assertEq(account, user);
        assertEq(amount, 250e6);
        uint256[] memory words = inbox.recordsFrom(1, 8);
        assertEq(words.length, 3);
        vm.expectRevert(); // the messenger refuses a second relay of the same message
        relay(m, 5_000_000);
        // What receiveDeposit itself costs, against MIN_GAS_LIMIT (100,000).
        vm.mockCall(
            HORIZEN_MESSENGER, abi.encodeWithSignature("xDomainMessageSender()"), abi.encode(address(vault))
        );
        vm.prank(HORIZEN_MESSENGER);
        uint256 before = gasleft();
        inbox.receiveDeposit(2, user, 1e6);
        uint256 receiveGas = before - gasleft();
        emit log_named_uint("receiveDeposit gas", receiveGas);
        assertLt(receiveGas, 60_000);
        vm.clearMockedCalls();
    }

    /// @dev A payout the signer signed pays real USDC on Base, once.
    function payOnBase() private {
        vm.selectFork(baseFork);
        Vault.Payout memory p = Vault.Payout(APP, 1, user, address(0xD00D), 100e6);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, vault.payoutDigest(p));
        vm.prank(RELAYER, RELAYER);
        uint256 before = gasleft();
        vault.withdraw(p, abi.encodePacked(r, s, v));
        emit log_named_uint("withdraw execution gas", before - gasleft());
        assertEq(IERC20(USDC).balanceOf(address(0xD00D)), 100e6);
        assertEq(IERC20(USDC).balanceOf(address(vault)), 150e6);
        vm.expectRevert(Vault.AlreadyPaid.selector);
        vault.withdraw(p, abi.encodePacked(r, s, v));
    }

    function sentMessage(Vm.Log[] memory logs) private pure returns (Message memory result) {
        uint256 sent;
        for (uint256 i; i < logs.length; ++i) {
            Vm.Log memory item = logs[i];
            if (item.emitter != BASE_MESSENGER || item.topics.length != 2) continue;
            if (item.topics[0] == SENT_MESSAGE) {
                ++sent;
                result.target = address(uint160(uint256(item.topics[1])));
                (result.sender, result.data, result.nonce, result.minGasLimit) =
                    abi.decode(item.data, (address, bytes, uint256, uint256));
            } else if (item.topics[0] == SENT_EXTENSION) {
                result.value = abi.decode(item.data, (uint256));
            }
        }
        require(sent == 1, "expected exactly one native message");
    }

    /// @dev From the Base messenger's deposit alias, as the deposit transaction derived on Horizen would be.
    function relay(Message memory m, uint256 gas) private {
        address alias_;
        unchecked {
            alias_ = address(uint160(BASE_MESSENGER) + uint160(0x1111000000000000000000000000000000001111));
        }
        vm.prank(alias_, alias_);
        IForkMessenger(HORIZEN_MESSENGER).relayMessage{gas: gas}(
            m.nonce, m.sender, m.target, m.value, m.minGasLimit, m.data
        );
    }

    function hashOf(Message memory m) private pure returns (bytes32) {
        return keccak256(
            abi.encodeCall(
                IForkMessenger.relayMessage, (m.nonce, m.sender, m.target, m.value, m.minGasLimit, m.data)
            )
        );
    }
}
