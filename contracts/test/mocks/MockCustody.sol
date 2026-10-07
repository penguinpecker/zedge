// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "../../node_modules/@openzeppelin/contracts-paris/token/ERC20/ERC20.sol";
import {
    ERC20Permit
} from "../../node_modules/@openzeppelin/contracts-paris/token/ERC20/extensions/ERC20Permit.sol";

/// @dev A 6-decimal EIP-2612 token standing in for Base USDC (OpenZeppelin 5.4.0: Paris-compatible).
contract PermitToken is ERC20Permit {
    constructor(string memory name_) ERC20(name_, "USDC") ERC20Permit(name_) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Stands in for an OP Stack cross-domain messenger at its real address (deployCodeTo): records what is sent
/// and relays a message with a chosen cross-domain sender, as the destination messenger would.
contract MockMessenger {
    struct Sent {
        address sender;
        address target;
        bytes message;
        uint32 minGasLimit;
    }

    address public otherMessenger;
    address private _xSender;
    Sent[] private _sent;

    constructor(address other) {
        otherMessenger = other;
    }

    function sendMessage(address target, bytes calldata message, uint32 minGasLimit) external payable {
        _sent.push(Sent(msg.sender, target, message, minGasLimit));
    }

    function xDomainMessageSender() external view returns (address) {
        require(_xSender != address(0), "xDomainMessageSender is not set");
        return _xSender;
    }

    function relay(address sender, address target, bytes calldata message) external returns (bool ok) {
        _xSender = sender;
        (ok,) = target.call(message);
        _xSender = address(0);
    }

    function sentCount() external view returns (uint256) {
        return _sent.length;
    }

    function sent(uint256 i) external view returns (Sent memory) {
        return _sent[i];
    }
}
