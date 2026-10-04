// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IChainlinkStreamsVerifierProxy} from "../../src/ChainlinkStreamsBoundaryOracle.sol";

/// @dev Test double only. It does not validate any DON signature and must never be deployed as an oracle.
contract MockStreamsVerifier is IChainlinkStreamsVerifierProxy {
    error InvalidSignature();

    bytes public body;
    bytes32 public expectedEvidenceHash;
    bool public rejectSignature;
    uint256 public calls;
    bytes public lastParameterPayload;
    address public callbackTarget;
    bytes public callbackData;
    bool public callbackSucceeded;
    bytes public callbackResult;

    function configure(bytes memory evidence, bytes memory verifiedBody) external {
        expectedEvidenceHash = keccak256(evidence);
        body = verifiedBody;
    }

    function setRejectSignature(bool reject) external {
        rejectSignature = reject;
    }

    function setCallback(address target, bytes memory data) external {
        callbackTarget = target;
        callbackData = data;
    }

    function verify(bytes calldata payload, bytes calldata parameterPayload) external returns (bytes memory) {
        if (rejectSignature || keccak256(payload) != expectedEvidenceHash) revert InvalidSignature();
        ++calls;
        lastParameterPayload = parameterPayload;
        if (callbackTarget != address(0)) {
            (callbackSucceeded, callbackResult) = callbackTarget.call(callbackData);
        }
        return body;
    }
}
