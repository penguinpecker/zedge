// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script} from "forge-std/Script.sol";
import {RoundRegistry} from "../src/RoundRegistry.sol";
import {PythBoundaryOracle} from "../src/PythBoundaryOracle.sol";

/// @notice Deployment construction for local simulation ONLY. Deliberately never starts a broadcast.
/// @dev Supported-verifier/network, licensing, admission and custody gates remain external prerequisites.
contract DeployRoundRegistry is Script {
    error InvalidDeploymentInput();

    struct Input {
        uint256 expectedChainId;
        address verifier;
        bytes32 verifierCodeHash;
        bytes32 collateralCodeHash;
        RoundRegistry.Config config;
    }

    function run(Input memory input) public returns (RoundRegistry registry, PythBoundaryOracle adapter) {
        if (
            block.chainid != input.expectedChainId
                || (block.chainid != 31337 && block.chainid != 2651420 && block.chainid != 26514)
                || input.config.oracle != address(0) || input.verifier.code.length == 0
                || input.verifierCodeHash != input.verifier.codehash
                || input.config.collateral.code.length == 0
                || input.collateralCodeHash != input.config.collateral.codehash
        ) revert InvalidDeploymentInput();
        adapter = new PythBoundaryOracle(input.verifier);
        input.config.oracle = address(adapter);
        registry = new RoundRegistry(input.config);
    }
}
