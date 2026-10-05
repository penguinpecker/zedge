// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC1155Holder} from "@openzeppelin/contracts/token/ERC1155/utils/ERC1155Holder.sol";

/// @dev Deliberately mutable, permissionless TEST token. Not a deployment dependency.
contract OutcomeVaultTokenFixture is ERC20 {
    uint8 private immutable _decimals;
    uint8 public behavior;
    address public reentryTarget;
    bytes public reentryData;
    bool public reentrySucceeded;
    bytes public reentryResult;

    constructor(uint8 decimals_) ERC20("Test collateral", "TEST") {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function destroy(address from, uint256 amount) external {
        _burn(from, amount);
    }

    function configure(uint8 behavior_, address target, bytes memory data) external {
        behavior = behavior_;
        reentryTarget = target;
        reentryData = data;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        _reenter();
        if (behavior == 4) return false;
        return super.transfer(to, amount);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        _reenter();
        if (behavior == 4) return false;
        return super.transferFrom(from, to, amount);
    }

    function _reenter() private {
        if (reentryTarget != address(0)) {
            (reentrySucceeded, reentryResult) = reentryTarget.call(reentryData);
        }
    }

    function _update(address from, address to, uint256 amount) internal override {
        if (from == address(0) || to == address(0) || amount == 0) {
            super._update(from, to, amount);
        } else if (behavior == 1) {
            super._update(from, to, amount - 1);
            super._update(from, address(0), 1);
        } else if (behavior == 2) {
            super._update(from, to, amount);
            super._update(from, address(0), 1);
        } else if (behavior == 3) {
            super._update(from, to, amount);
            super._update(address(0), to, 1);
        } else {
            super._update(from, to, amount);
        }
    }
}

/// @dev Deliberately mutable TEST registry for malformed dependency checks only.
contract OutcomeVaultRegistryFixture {
    address public collateral;
    uint256 public deploymentChainId;
    bytes32 public rulesHash = keccak256("test registry rules");
    string public version = "zedge-streams-round-registry-v2";
    uint8 public up;
    uint8 public down;
    uint8 public denominator;

    constructor(address collateral_) {
        collateral = collateral_;
        deploymentChainId = block.chainid;
    }

    function configure(uint256 chainId_, bytes32 rulesHash_, string memory version_) external {
        deploymentChainId = chainId_;
        rulesHash = rulesHash_;
        version = version_;
    }

    function setPayout(uint8 up_, uint8 down_, uint8 denominator_) external {
        up = up_;
        down = down_;
        denominator = denominator_;
    }

    function canTrade(bytes32) external pure returns (bool) {
        return true;
    }

    function payoutNumerators(bytes32) external view returns (uint8, uint8, uint8) {
        return (up, down, denominator);
    }
}

contract OutcomeVaultReceiverFixture is ERC1155Holder {
    address public target;
    bytes public data;
    bool public reject;
    bool public reentrySucceeded;
    bytes public reentryResult;

    function configure(address target_, bytes memory data_, bool reject_) external {
        target = target_;
        data = data_;
        reject = reject_;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes memory)
        public
        override
        returns (bytes4)
    {
        _callback();
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] memory, uint256[] memory, bytes memory)
        public
        override
        returns (bytes4)
    {
        _callback();
        return this.onERC1155BatchReceived.selector;
    }

    function _callback() private {
        require(!reject, "test receiver rejects");
        if (target != address(0)) (reentrySucceeded, reentryResult) = target.call(data);
    }
}
