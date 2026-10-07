// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {
    Ownable2StepUpgradeable
} from "../node_modules/@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC5267} from "@openzeppelin/contracts/interfaces/IERC5267.sol";
import {INativeOracleMessenger} from "./interfaces/INativeOracleMessenger.sol";

/// @notice ZEDGE custody on Base, behind a UUPS proxy. A user deposits native USDC once (with an EIP-2612 permit, sent
/// by our relayer); each deposit gets the next index and is announced to the Horizen inbox through Horizen's native
/// Base -> Horizen messenger, where the order book's engine credits it exactly once by index. Payouts (withdrawals and
/// refunds) leave only with the payout signer's EIP-712 signature, each (application, ordinal) once, within a per-payout
/// maximum and a daily cap.
/// @dev Trust: the owner can upgrade and change the signer; the signer decides payouts. No rescue, no arbitrary call.
/// USDC sent here without `depositWithPermit` is never credited. Invariant: balance = sum Deposited - sum Paid.
contract BaseCustodyVault is Initializable, UUPSUpgradeable, Ownable2StepUpgradeable, IERC5267 {
    using SafeERC20 for IERC20;

    /// @dev USDC amounts in 6 decimals. maxDeposit 0 halts deposits; a UTC day is block time / 1 days.
    struct Limits {
        uint128 minDeposit;
        uint128 maxDeposit;
        uint128 maxPayout;
        uint128 dailyPayoutCap;
    }

    /// @dev What the payout signer signs. (applicationId, ordinal) is the nonce: paid once, in any order.
    struct Payout {
        uint64 applicationId;
        uint64 ordinal;
        address account;
        address to;
        uint256 amount;
    }

    /// @custom:storage-location erc7201:zedge.storage.BaseCustodyVault
    struct VaultStorage {
        address signer;
        address inbox;
        uint64 depositCount;
        Limits limits;
        mapping(uint64 applicationId => mapping(uint64 ordinal => bool)) paid;
        mapping(uint256 day => uint256) paidOnDay;
    }

    error InvalidConfig();
    error InvalidLimits();
    error AmountOutOfRange();
    error TransferFailed();
    error InvalidRecipient();
    error AlreadyPaid();
    error BadSignature();
    error CapExceeded();
    error RenounceDisabled();

    event Deposited(uint64 indexed index, address indexed account, uint256 amount);
    event Paid(
        uint64 indexed applicationId,
        uint64 indexed ordinal,
        address indexed to,
        address account,
        uint256 amount
    );
    event SignerChanged(address indexed previous, address indexed current);
    event LimitsChanged(Limits limits);

    IERC20 public constant USDC = IERC20(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913);
    INativeOracleMessenger public constant MESSENGER =
        INativeOracleMessenger(0x9F5e33f901ad50B50d6A27f63aDaBEA4c81e953c);
    address public constant HORIZEN_MESSENGER = 0x4200000000000000000000000000000000000007;
    uint32 public constant MIN_GAS_LIMIT = 100_000;
    bytes32 public constant PAYOUT_TYPEHASH =
        keccak256("Payout(uint64 applicationId,uint64 ordinal,address account,address to,uint256 amount)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    // keccak256(abi.encode(uint256(keccak256("zedge.storage.BaseCustodyVault")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION =
        0x1dc441e6ee1e352ce2c6e1b3a538f1d2b52a3850e87ce368d25afa750b02e200;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(address owner_, address signer_, address inbox_, Limits calldata limits_)
        external
        initializer
    {
        // A zero signer is allowed: payouts stay halted until the owner sets one.
        if (inbox_ == address(0) || MESSENGER.otherMessenger() != HORIZEN_MESSENGER) revert InvalidConfig();
        __Ownable_init(owner_);
        VaultStorage storage $ = _vault();
        $.inbox = inbox_;
        _setSigner($, signer_);
        _setLimits($, limits_);
    }

    /// @notice Pulls `amount` USDC from `account` with its permit and announces deposit `index` to the Horizen inbox.
    /// Anyone may send it (our relayer does); the permit binds the owner, the amount and the deadline.
    function depositWithPermit(
        address account,
        uint256 amount,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint64 index) {
        VaultStorage storage $ = _vault();
        Limits memory l = $.limits;
        if (account == address(0) || amount < l.minDeposit || amount > l.maxDeposit) {
            revert AmountOutOfRange();
        }
        index = ++$.depositCount;
        // A permit already used (copied from the mempool, say) left its allowance: continue without it. The pull is from
        // `account` and the deposit is credited to `account` alone, so a caller with no permit can at most move an
        // allowance the account already gave the vault into the account's own balance (as the bridge router did before).
        try IERC20Permit(address(USDC)).permit(account, address(this), amount, deadline, v, r, s) {} catch {}
        if (!USDC.trySafeTransferFrom(account, address(this), amount)) revert TransferFailed();
        MESSENGER.sendMessage(
            $.inbox, abi.encodeCall(IDepositInbox.receiveDeposit, (index, account, amount)), MIN_GAS_LIMIT
        );
        emit Deposited(index, account, amount);
    }

    /// @notice Pays a payout the signer signed. Anyone may send it; each (applicationId, ordinal) pays once.
    function withdraw(Payout calldata p, bytes calldata signature) external {
        VaultStorage storage $ = _vault();
        if (p.to == address(0) || p.to == address(this)) revert InvalidRecipient();
        if (p.amount == 0 || p.amount > $.limits.maxPayout) revert AmountOutOfRange();
        if ($.paid[p.applicationId][p.ordinal]) revert AlreadyPaid();
        // ECDSA only; a malformed or high-s signature reverts inside recoverCalldata. A zero signer matches nothing.
        if (ECDSA.recoverCalldata(_payoutDigest(p), signature) != $.signer) revert BadSignature();
        uint256 day = block.timestamp / 1 days;
        uint256 total = $.paidOnDay[day] + p.amount;
        if (total > $.limits.dailyPayoutCap) revert CapExceeded();
        $.paid[p.applicationId][p.ordinal] = true;
        $.paidOnDay[day] = total;
        emit Paid(p.applicationId, p.ordinal, p.to, p.account, p.amount);
        USDC.safeTransfer(p.to, p.amount);
    }

    /// @notice address(0) halts payouts.
    function setSigner(address signer_) external onlyOwner {
        _setSigner(_vault(), signer_);
    }

    function setLimits(Limits calldata limits_) external onlyOwner {
        _setLimits(_vault(), limits_);
    }

    function depositCount() external view returns (uint64) {
        return _vault().depositCount;
    }

    function signer() external view returns (address) {
        return _vault().signer;
    }

    function inbox() external view returns (address) {
        return _vault().inbox;
    }

    function limits() external view returns (Limits memory) {
        return _vault().limits;
    }

    function paid(uint64 applicationId, uint64 ordinal) external view returns (bool) {
        return _vault().paid[applicationId][ordinal];
    }

    function paidOnDay(uint256 day) external view returns (uint256) {
        return _vault().paidOnDay[day];
    }

    /// @notice The EIP-712 digest the signer signs for `p` (domain "ZEDGE Vault", "1", this chain, this proxy).
    function payoutDigest(Payout calldata p) external view returns (bytes32) {
        return _payoutDigest(p);
    }

    /// @notice EIP-5267: the payout domain (this proxy on this chain).
    function eip712Domain()
        external
        view
        returns (
            bytes1 fields,
            string memory name,
            string memory version_,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        )
    {
        return (hex"0f", "ZEDGE Vault", "1", block.chainid, address(this), bytes32(0), new uint256[](0));
    }

    function version() external pure returns (string memory) {
        return "1";
    }

    function renounceOwnership() public virtual override {
        revert RenounceDisabled();
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function _setSigner(VaultStorage storage $, address signer_) private {
        emit SignerChanged($.signer, signer_);
        $.signer = signer_;
    }

    /// @dev minDeposit > 0 always; maxDeposit 0 halts deposits, otherwise it is at least minDeposit and fits the
    /// inbox's uint96; 0 < maxPayout <= dailyPayoutCap.
    function _setLimits(VaultStorage storage $, Limits calldata l) private {
        if (
            l.minDeposit == 0 || (l.maxDeposit != 0 && l.minDeposit > l.maxDeposit)
                || l.maxDeposit > type(uint96).max || l.maxPayout == 0 || l.maxPayout > l.dailyPayoutCap
        ) revert InvalidLimits();
        $.limits = l;
        emit LimitsChanged(l);
    }

    /// @dev Written out because OpenZeppelin 5.6.1's EIP-712 helpers need Cancun (the build is Paris). Computed at
    /// every call, so the domain is always this proxy's address and the current chain id.
    function _payoutDigest(Payout calldata p) private view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256("ZEDGE Vault"), keccak256("1"), block.chainid, address(this)
            )
        );
        bytes32 structHash =
            keccak256(abi.encode(PAYOUT_TYPEHASH, p.applicationId, p.ordinal, p.account, p.to, p.amount));
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _vault() private pure returns (VaultStorage storage $) {
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }
}

/// @dev The one call the vault sends to Horizen (HorizenDepositInbox.receiveDeposit).
interface IDepositInbox {
    function receiveDeposit(uint64 index, address account, uint256 amount) external;
}
