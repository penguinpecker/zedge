// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice EVALUATION ONLY: a worthless 6-decimal test token for the local Vela slice on chain 31337.
/// Anyone can mint any amount. It must never be deployed anywhere else or given value.
contract EvaluationToken is ERC20 {
    constructor() ERC20("ZEDGE evaluation token (worthless)", "ZEVAL") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
