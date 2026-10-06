// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice EVALUATION ONLY: the clock trigger of the ZEDGE Vela guest, for the local slice on chain 31337
/// (adapters/vela/guest/README.md sections 8 and 10). An original implementation of the trigger calls a Vela
/// v0.2.0 ProcessorEndpoint makes; no upstream code. Software TEE, no attestation: the enclave cannot check
/// that a payload came from here, so this contract makes the clock checkable, not trusted.
/// @dev It holds nothing and moves nothing. Its only other contract is the round registry, called with a
/// fixed gas limit per call and without Solidity's ABI decoding, so a registry that reverts, burns gas or
/// answers garbage costs a bounded amount of gas and can never stop the clock words.
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

    /// @notice SHA-256("zedge.vela.tick.v1"): the guest's request for a clock tick.
    bytes32 public constant TICK_SUBTYPE = 0x8af869f39217eabc1718875ec064086a0e0283d1c1ee8a025b687fd40b5e3850;
    /// @notice Registry records in one answer, and registry round IDs one request may ask about (section 10).
    uint256 public constant MAX_RECORDS = 16;
    uint256 public constant MAX_ASKED = 16;
    /// @notice Gas for one createRound and for one getRound or roundIdFor call. Measured against the
    /// evaluation registry behind its proxy (EvaluationClockTriggerTest.test_HonestRegistryCosts): about
    /// 69,000 to create a round and 16,000 to read one, so each limit is more than three times the honest cost.
    uint256 public constant CREATE_GAS = 250_000;
    uint256 public constant READ_GAS = 60_000;

    /// @dev getRound's answer: StreamsRoundRegistry.Round is a static struct of 22 words.
    uint256 private constant ROUND_BYTES = 704;
    uint256 private constant RECORD_BYTES = 608; // 19 words
    uint256 private constant HEADER_BYTES = 224; // 7 words
    bytes4 private constant CREATE_ROUND = bytes4(keccak256("createRound(uint8,uint32,uint64)"));
    bytes4 private constant ROUND_ID_FOR = bytes4(keccak256("roundIdFor(uint8,uint32,uint64)"));
    bytes4 private constant GET_ROUND = bytes4(keccak256("getRound(bytes32)"));

    /// @notice The only caller this contract answers.
    address public immutable processorEndpoint;
    /// @notice The StreamsRoundRegistry (its proxy) the deployment mirrors.
    address public immutable registry;
    /// @notice The one market the deployment mirrors: asset 0 BTC or 1 ETH, duration 300 or 900 seconds. It
    /// must equal the guest's `markets` constructor parameter, which the guest cannot check.
    uint8 public immutable asset;
    uint32 public immutable duration;

    error ZeroAddress();
    error InvalidMarket();
    error NotProcessorEndpoint();

    constructor(address endpoint, address roundRegistry, uint8 marketAsset, uint32 marketDuration) {
        if (endpoint == address(0) || roundRegistry == address(0)) revert ZeroAddress();
        if (marketAsset > 1 || (marketDuration != 300 && marketDuration != 900)) revert InvalidMarket();
        processorEndpoint = endpoint;
        registry = roundRegistry;
        asset = marketAsset;
        duration = marketDuration;
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

    /// @notice Answers the first tick request with at least 32 bytes of data. With exactly 32 bytes (the
    /// time-free build) the 192-byte version-1 answer abi.encode(1, block.chainid, endpoint, block.number,
    /// block.timestamp, tick). With more, the version-2 answer of section 10: the same words with version 2,
    /// then n and n registry records. Anything else, including the guest's own clock and archive records, gets
    /// empty bytes, so a tick never answers itself. With a tick request present it cannot revert: the endpoint
    /// would swallow the revert and the tick would be lost.
    function getTrustProcessPayload(
        EventData calldata appEventData,
        bool,
        bool,
        TokenAndAmount[] calldata,
        TokenAndAmount[] calldata
    ) external onlyEndpoint returns (bytes memory) {
        uint256 n = appEventData.subTypes.length;
        if (appEventData.events.length < n) n = appEventData.events.length;
        for (uint256 i; i < n; ++i) {
            bytes calldata data = appEventData.events[i];
            if (appEventData.subTypes[i] != TICK_SUBTYPE || data.length < 32) continue;
            uint256 tick = uint256(bytes32(data[:32]));
            if (data.length == 32) {
                return abi.encode(uint256(1), block.chainid, processorEndpoint, block.number, block.timestamp, tick);
            }
            return _version2(tick, data);
        }
        return "";
    }

    /// @dev The request is `tick, s, o`, then s registry IDs of the engine's scheduled rounds and o of its open
    /// ones. A request of any other shape, or one asking about more than MAX_ASKED rounds, gets n = 0.
    function _version2(uint256 tick, bytes calldata data) private returns (bytes memory out) {
        out = new bytes(HEADER_BYTES + RECORD_BYTES * MAX_RECORDS);
        _put(out, 0, 2);
        _put(out, 1, block.chainid);
        _put(out, 2, uint256(uint160(processorEndpoint)));
        _put(out, 3, block.number);
        _put(out, 4, block.timestamp);
        _put(out, 5, tick);
        uint256 records;
        if (data.length >= 96) {
            uint256 s = uint256(bytes32(data[32:64]));
            uint256 o = uint256(bytes32(data[64:96]));
            if (s <= MAX_ASKED && o <= MAX_ASKED && s + o <= MAX_ASKED && data.length == 96 + 32 * (s + o)) {
                records = _records(out, data[96:], s);
            }
        }
        _put(out, 6, records);
        uint256 length = HEADER_BYTES + RECORD_BYTES * records;
        assembly ("memory-safe") {
            mstore(out, length)
        }
    }

    /// @dev Creates the next two slots of the market (a failure means the round usually exists already),
    /// then writes a record for every round where the registry is ahead of the engine: an asked scheduled
    /// round that has opened or ended, an asked open round that has ended, and a next slot the engine did not
    /// ask about. Every read that fails is skipped.
    function _records(bytes memory out, bytes calldata ids, uint256 scheduled) private returns (uint256 records) {
        uint256 first = (block.timestamp / duration + 1) * duration;
        uint256[2] memory slots = [first, first + duration];
        for (uint256 i; i < 2; ++i) {
            _create(slots[i]);
        }
        uint256 asked = ids.length / 32;
        for (uint256 j; j < asked && records < MAX_RECORDS; ++j) {
            bytes32 id = bytes32(ids[32 * j:32 * j + 32]);
            (bool ok, uint256[22] memory w) = _read(id);
            // Words 7 and 9 of a Round are openedAt and outcome.
            if (ok && (w[9] != 0 || (j < scheduled && w[7] != 0))) records = _record(out, records, id, w);
        }
        for (uint256 i; i < 2 && records < MAX_RECORDS; ++i) {
            (bool known, bytes32 id) = _roundId(slots[i]);
            if (!known || _contains(ids, id)) continue;
            (bool ok, uint256[22] memory w) = _read(id);
            if (ok) records = _record(out, records, id, w);
        }
    }

    /// @dev start goes out as a full word: the registry's own ABI decoding refuses one above uint64.
    function _create(uint256 start) private {
        bytes memory call_ = abi.encodeWithSelector(CREATE_ROUND, asset, duration, start);
        address target = registry;
        assembly ("memory-safe") {
            pop(call(CREATE_GAS, target, 0, add(call_, 32), mload(call_), 0, 0))
        }
    }

    function _roundId(uint256 start) private view returns (bool ok, bytes32 id) {
        bytes memory call_ = abi.encodeWithSelector(ROUND_ID_FOR, asset, duration, start);
        address target = registry;
        assembly ("memory-safe") {
            let at := mload(0x40)
            ok := staticcall(READ_GAS, target, add(call_, 32), mload(call_), at, 32)
            ok := and(ok, eq(returndatasize(), 32))
            id := mload(at)
        }
    }

    /// @dev Copies at most ROUND_BYTES of the answer, so a registry that returns a huge answer costs no
    /// memory here, and accepts only an answer of exactly that length.
    function _read(bytes32 id) private view returns (bool ok, uint256[22] memory w) {
        bytes memory call_ = abi.encodeWithSelector(GET_ROUND, id);
        address target = registry;
        assembly ("memory-safe") {
            ok := staticcall(READ_GAS, target, add(call_, 32), mload(call_), w, ROUND_BYTES)
            ok := and(ok, eq(returndatasize(), ROUND_BYTES))
        }
    }

    /// @dev Record words: roundId, asset, duration, start, openedAt, resolvedAt, outcome, then the opening and
    /// the closing observation (price, validFromTimestamp, observationsTimestamp, expiresAt, reportHash,
    /// decimals), copied word for word from getRound. The guest decodes them and skips any it cannot read.
    function _record(bytes memory out, uint256 index, bytes32 id, uint256[22] memory w) private pure returns (uint256) {
        uint256 at = 7 + 19 * index;
        _put(out, at, uint256(id));
        _put(out, at + 1, w[0]);
        _put(out, at + 2, w[1]);
        _put(out, at + 3, w[2]);
        _put(out, at + 4, w[7]);
        _put(out, at + 5, w[8]);
        _put(out, at + 6, w[9]);
        for (uint256 k; k < 12; ++k) {
            _put(out, at + 7 + k, w[10 + k]);
        }
        return index + 1;
    }

    function _contains(bytes calldata ids, bytes32 id) private pure returns (bool) {
        for (uint256 j; j < ids.length / 32; ++j) {
            if (bytes32(ids[32 * j:32 * j + 32]) == id) return true;
        }
        return false;
    }

    function _put(bytes memory out, uint256 word, uint256 value) private pure {
        assembly ("memory-safe") {
            mstore(add(add(out, 32), mul(word, 32)), value)
        }
    }
}
