// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {EvaluationToken} from "../src/EvaluationToken.sol";

/// EVALUATION ONLY. One token base unit is one engine atom, so the guest needs 6 decimals.
contract EvaluationTokenTest is Test {
    EvaluationToken token = new EvaluationToken();

    function test_SixDecimalsAndLabelled() public view {
        assertEq(token.decimals(), 6);
        assertEq(token.symbol(), "ZEVAL");
        assertEq(token.name(), "ZEDGE evaluation token (worthless)");
    }

    function testFuzz_MintTransferFrom(address user, address spender, uint96 amount, uint96 spend) public {
        vm.assume(user != address(0) && spender != address(0) && user != spender);
        spend = uint96(bound(spend, 0, amount));
        token.mint(user, amount);
        assertEq(token.balanceOf(user), amount);
        assertEq(token.totalSupply(), amount);
        vm.prank(user);
        token.approve(spender, spend);
        vm.prank(spender);
        token.transferFrom(user, spender, spend);
        assertEq(token.balanceOf(user), uint256(amount) - spend);
        assertEq(token.balanceOf(spender), spend);
    }
}
