// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice EVALUATION ONLY: the clock trigger of the ZEDGE Vela guest, for the local slice on chain 31337
/// (adapters/vela/guest/README.md section 8). An original implementation of the trigger calls a Vela v0.2.0
/// ProcessorEndpoint makes; no upstream code. Software TEE, no attestation: the enclave cannot check that a
/// payload came from here, so this contract makes the clock checkable, not trusted.
/// @dev It holds nothing, moves nothing and reads no other contract, so no other contract can stop the clock.
contract EvaluationClockTrigger {
    /// @dev Field order and types match the endpoint's Structs.EventData and Structs.TokenAndAmount, so the
    /// three selectors are the ones the endpoint calls.
    struct EventData {
        bytes[] events;
        bytes32[] subTypes;
    }

    struct TokenAndAmount {
        address token;
        uint256 amount;
    }

    /// @notice SHA-256("zedge.vela.tick.v1"): the guest's request for a clock tick; data is the tick number.
    bytes32 public constant TICK_SUBTYPE = 0x8af869f39217eabc1718875ec064086a0e0283d1c1ee8a025b687fd40b5e3850;
    uint256 public constant PAYLOAD_VERSION = 1;

    /// @notice The only caller this contract answers.
    address public immutable processorEndpoint;

    error ZeroAddress();
    error NotProcessorEndpoint();

    constructor(address endpoint) {
        if (endpoint == address(0)) revert ZeroAddress();
        processorEndpoint = endpoint;
    }

    modifier onlyEndpoint() {
        if (msg.sender != processorEndpoint) revert NotProcessorEndpoint();
        _;
    }

    /// @notice Does nothing.
    function execute(EventData calldata) external view onlyEndpoint {}

    /// @notice Moves nothing: two empty arrays, so the endpoint adds nothing to the application's custody.
    function withdraw()
        external
        view
        onlyEndpoint
        returns (TokenAndAmount[] memory returnedTokens, TokenAndAmount[] memory failedTokens)
    {}

    /// @notice For the first tick request with 32 bytes of data, the 192-byte clock answer
    /// abi.encode(1, block.chainid, endpoint, block.number, block.timestamp, tick); otherwise empty, which
    /// includes the guest's own clock record, so a tick never asks for a tick. With a tick request present it
    /// cannot revert: the endpoint would swallow the revert and the tick would be lost.
    function getTrustProcessPayload(
        EventData calldata appEventData,
        bool,
        bool,
        TokenAndAmount[] calldata,
        TokenAndAmount[] calldata
    ) external view onlyEndpoint returns (bytes memory) {
        uint256 n = appEventData.subTypes.length;
        if (appEventData.events.length < n) n = appEventData.events.length;
        for (uint256 i; i < n; ++i) {
            if (appEventData.subTypes[i] == TICK_SUBTYPE && appEventData.events[i].length == 32) {
                return abi.encode(
                    PAYLOAD_VERSION,
                    block.chainid,
                    processorEndpoint,
                    block.number,
                    block.timestamp,
                    uint256(bytes32(appEventData.events[i]))
                );
            }
        }
        return "";
    }
}
