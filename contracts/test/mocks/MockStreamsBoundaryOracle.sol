// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IStreamsBoundaryOracle} from "../../src/interfaces/IStreamsBoundaryOracle.sol";

/// @dev UNSIGNED fixture. Never used by a deployment or as signature-verification evidence.
contract MockStreamsBoundaryOracle is IStreamsBoundaryOracle {
    bool public failure;
    address public reentryTarget;
    bytes public reentryData;
    bool public reentrySucceeded;
    bytes32 public lastFeed;
    uint64 public lastBoundary;
    uint64 public lastMaximum;

    function version() external pure returns (string memory) {
        return "insecure-streams-test-fixture";
    }

    function setFailure(bool value) external {
        failure = value;
    }

    function setReentry(address target, bytes calldata data) external {
        reentryTarget = target;
        reentryData = data;
    }

    function verifyBoundary(bytes32 feed, uint64 boundary, uint64 maximum, bytes calldata evidence)
        external
        returns (Observation memory)
    {
        require(!failure, "test oracle unavailable");
        lastFeed = feed;
        lastBoundary = boundary;
        lastMaximum = maximum;
        if (reentryTarget != address(0)) {
            (reentrySucceeded,) = reentryTarget.call(reentryData);
        }
        return abi.decode(evidence, (Observation));
    }
}
