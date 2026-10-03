// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IBoundaryOracle} from "../../src/interfaces/IBoundaryOracle.sol";

/// @dev TEST ONLY. Accepts unsigned ABI data. Must never be used as a deployment oracle.
contract MockBoundaryOracle is IBoundaryOracle {
    uint256 public constant FEE = 1;
    bytes32 public lastFeed;
    uint64 public lastBoundary;
    uint64 public lastMaximum;
    bool public fail;
    address public reentryTarget;
    bytes public reentryCall;
    bool public reentrySucceeded;

    function version() external pure returns (string memory) {
        return "INSECURE-TEST-ONLY";
    }

    function quoteFee(bytes calldata) external pure returns (uint256) {
        return FEE;
    }

    function setFailure(bool value) external {
        fail = value;
    }

    function setReentry(address target, bytes calldata payload) external {
        reentryTarget = target;
        reentryCall = payload;
    }

    function verifyBoundary(bytes32 feed, uint64 boundary, uint64 maximum, bytes calldata evidence)
        external
        payable
        returns (Observation memory)
    {
        require(!fail, "test oracle unavailable");
        require(msg.value == FEE, "test fee");
        lastFeed = feed;
        lastBoundary = boundary;
        lastMaximum = maximum;
        if (reentryTarget != address(0)) {
            address target = reentryTarget;
            reentryTarget = address(0);
            // Forward the correct fee so the regression test fails if the guard is removed.
            (reentrySucceeded,) = target.call{value: msg.value}(reentryCall);
        }
        return abi.decode(evidence, (Observation));
    }
}

/// @dev TEST ONLY collateral identity; no token custody is exercised by these contracts.
contract MockCollateral {
    function decimals() external pure returns (uint8) {
        return 6;
    }
}
