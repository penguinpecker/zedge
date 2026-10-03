// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {console2} from "forge-std/console2.sol";
import {Script} from "forge-std/Script.sol";
import {DeployRoundRegistry} from "./DeployRoundRegistry.s.sol";
import {RoundRegistry} from "../src/RoundRegistry.sol";
import {PythBoundaryOracle} from "../src/PythBoundaryOracle.sol";
import {MockUniquePyth} from "../test/mocks/MockUniquePyth.sol";
import {MockCollateral} from "../test/mocks/MockBoundaryOracle.sol";

/// @dev TEST-ONLY local EVM simulation. Unsigned mock verifier; zero network deployment or assets.
contract LocalDryRun is Script {
    function run() external returns (RoundRegistry registry, PythBoundaryOracle adapter) {
        require(block.chainid == 31337, "local simulation only");
        MockUniquePyth verifier = new MockUniquePyth();
        MockCollateral token = new MockCollateral();
        DeployRoundRegistry.Input memory input = DeployRoundRegistry.Input({
            expectedChainId: 31337,
            verifier: address(verifier),
            verifierCodeHash: address(verifier).codehash,
            collateralCodeHash: address(token).codehash,
            config: RoundRegistry.Config(
                address(0),
                address(token),
                keccak256("TEST-BTC"),
                keccak256("TEST-ETH"),
                -8,
                -8,
                10,
                20,
                60,
                30,
                100
            )
        });
        (registry, adapter) = new DeployRoundRegistry().run(input);
        console2.log("LOCAL SIMULATION ONLY: unsigned fixtures, no broadcast, no network addresses.");
        console2.log("Registry simulation address:", address(registry));
        console2.log("Adapter simulation address:", address(adapter));
    }
}
