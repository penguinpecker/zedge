// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {
    Ownable2StepUpgradeable
} from "../node_modules/@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {INativeOracleMessenger} from "./interfaces/INativeOracleMessenger.sol";

/// @notice Horizen's record of the Base vault's deposits, behind a UUPS proxy. Only the vault, through Horizen's native
/// messenger, can write one; each index is written once. The order book's trigger reads them in order
/// (`recordsFrom`) and the engine credits each index exactly once. Holds no tokens.
/// @dev A message that fails here stays replayable by anyone through the messenger; readers wait at the gap.
contract HorizenDepositInbox is Initializable, UUPSUpgradeable, Ownable2StepUpgradeable {
    struct Deposit {
        address account;
        uint96 amount;
    }

    /// @custom:storage-location erc7201:zedge.storage.HorizenDepositInbox
    struct InboxStorage {
        address vault;
        uint64 highest;
        mapping(uint64 index => Deposit) deposits;
    }

    error InvalidConfig();
    error UnauthorizedMessenger();
    error InvalidDeposit();
    error DepositExists(uint64 index);
    error TooMany();
    error RenounceDisabled();

    event DepositReceived(uint64 indexed index, address indexed account, uint256 amount);

    INativeOracleMessenger public constant MESSENGER =
        INativeOracleMessenger(0x4200000000000000000000000000000000000007);
    uint256 public constant MAX_RECORDS = 8;
    // keccak256(abi.encode(uint256(keccak256("zedge.storage.HorizenDepositInbox")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION =
        0xfbd20bf20924bfc9bc569475d263898c3f42116965c6bce3c578298b4e226f00;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @param vault_ The Base vault proxy (the only sender accepted through the messenger).
    function initialize(address owner_, address vault_) external initializer {
        if (vault_ == address(0)) revert InvalidConfig();
        __Ownable_init(owner_);
        _inbox().vault = vault_;
    }

    function receiveDeposit(uint64 index, address account, uint256 amount) external {
        InboxStorage storage $ = _inbox();
        if (msg.sender != address(MESSENGER) || MESSENGER.xDomainMessageSender() != $.vault) {
            revert UnauthorizedMessenger();
        }
        if (index == 0 || account == address(0) || amount == 0 || amount > type(uint96).max) {
            revert InvalidDeposit();
        }
        if ($.deposits[index].account != address(0)) revert DepositExists(index);
        $.deposits[index] = Deposit(account, uint96(amount));
        if (index > $.highest) $.highest = index;
        emit DepositReceived(index, account, amount);
    }

    function deposits(uint64 index) external view returns (address account, uint96 amount) {
        Deposit storage d = _inbox().deposits[index];
        return (d.account, d.amount);
    }

    /// @notice Up to `max` (at most 8) records [index, account, amount], contiguous from `from`, stopping at the first
    /// index not received yet.
    function recordsFrom(uint64 from, uint256 max) external view returns (uint256[] memory words) {
        if (max > MAX_RECORDS) revert TooMany();
        InboxStorage storage $ = _inbox();
        uint256 n;
        while (
            n < max && from != 0 && from + n <= type(uint64).max
                && $.deposits[uint64(from + n)].account != address(0)
        ) {
            ++n;
        }
        words = new uint256[](3 * n);
        for (uint256 i; i < n; ++i) {
            Deposit storage d = $.deposits[uint64(from + i)];
            words[3 * i] = from + i;
            words[3 * i + 1] = uint256(uint160(d.account));
            words[3 * i + 2] = d.amount;
        }
    }

    function highest() external view returns (uint64) {
        return _inbox().highest;
    }

    function vault() external view returns (address) {
        return _inbox().vault;
    }

    function version() external pure returns (string memory) {
        return "1";
    }

    function renounceOwnership() public virtual override {
        revert RenounceDisabled();
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function _inbox() private pure returns (InboxStorage storage $) {
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }
}
