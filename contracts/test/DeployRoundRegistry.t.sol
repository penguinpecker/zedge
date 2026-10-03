// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {DeployRoundRegistry} from "../script/DeployRoundRegistry.s.sol";
import {LocalDryRun} from "../script/LocalDryRun.s.sol";
import {RoundRegistry} from "../src/RoundRegistry.sol";
import {PythBoundaryOracle} from "../src/PythBoundaryOracle.sol";
import {MockUniquePyth} from "./mocks/MockUniquePyth.sol";
import {MockCollateral} from "./mocks/MockBoundaryOracle.sol";

contract DeployRoundRegistryTest is Test {
    DeployRoundRegistry internal deployer;
    DeployRoundRegistry.Input internal input;

    function setUp() public {
        vm.chainId(31337);
        deployer = new DeployRoundRegistry();
        MockUniquePyth verifier = new MockUniquePyth();
        MockCollateral token = new MockCollateral();
        input = DeployRoundRegistry.Input(
            31337,
            address(verifier),
            address(verifier).codehash,
            address(token).codehash,
            RoundRegistry.Config(
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
        );
    }

    function testSimulationConstructsImmutableBindings() public {
        (RoundRegistry registry, PythBoundaryOracle adapter) = deployer.run(input);
        assertEq(address(registry.oracle()), address(adapter));
        assertEq(address(adapter.pyth()), input.verifier);
        assertEq(registry.collateral(), input.config.collateral);
    }

    function testWrongChainVerifierAndTokenPinsReject() public {
        input.expectedChainId = 2651420;
        vm.expectRevert(DeployRoundRegistry.InvalidDeploymentInput.selector);
        deployer.run(input);
        input.expectedChainId = 31337;
        bytes32 validHash = input.verifierCodeHash;
        input.verifierCodeHash = bytes32(0);
        vm.expectRevert(DeployRoundRegistry.InvalidDeploymentInput.selector);
        deployer.run(input);
        input.verifierCodeHash = validHash;
        input.collateralCodeHash = bytes32(0);
        vm.expectRevert(DeployRoundRegistry.InvalidDeploymentInput.selector);
        deployer.run(input);
    }

    function testUnsupportedNetworkRejectsAndLocalFixtureCannotRunOnMainnet() public {
        vm.chainId(1);
        input.expectedChainId = 1;
        vm.expectRevert(DeployRoundRegistry.InvalidDeploymentInput.selector);
        deployer.run(input);
        vm.chainId(26514);
        LocalDryRun local = new LocalDryRun();
        vm.expectRevert("local simulation only");
        local.run();
    }

    function testLocalDryRunUsesOnlyFixtureNetwork() public {
        (RoundRegistry registry, PythBoundaryOracle adapter) = new LocalDryRun().run();
        assertEq(registry.deploymentChainId(), 31337);
        assertEq(address(registry.oracle()), address(adapter));
    }
}
