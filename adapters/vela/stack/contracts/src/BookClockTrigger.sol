// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

/// @notice The clock trigger of the ZEDGE private book on Vela (adapters/vela/guest/README.md sections 6, 8 and 10),
/// behind a UUPS proxy. It answers the guest's tick request inside the endpoint's own transaction with the block's
/// clock words, the registry records the engine is behind on, and the Base deposit records the Horizen inbox holds
/// from the index the guest asks for. An original implementation of the trigger calls a Vela v0.2.0 ProcessorEndpoint
/// makes; no upstream code. The enclave cannot check that a payload came from here: the guest publishes the payload's
/// hash, which makes the clock checkable, not trusted.
/// @dev It holds nothing and moves nothing. Its other contracts, the round registry and the deposit inbox, are called
/// with a fixed gas limit per call and without Solidity's ABI decoding, so one that reverts, burns gas or answers
/// garbage costs a bounded amount of gas and can never stop the clock words.
contract BookClockTrigger is Initializable, UUPSUpgradeable, Ownable2StepUpgradeable {
    /// @dev Field order and types match the endpoint's Structs.EventData and Structs.TokenAndAmount, so the three
    /// selectors are the ones the endpoint calls.
    struct EventData {
        bytes[] events;
        bytes32[] subTypes;
    }

    struct TokenAndAmount {
        address token;
        uint256 amount;
    }

    /// @custom:storage-location erc7201:zedge.storage.BookClockTrigger
    struct TriggerStorage {
        address endpoint;
        address registry;
        address inbox;
        uint8 asset;
        uint32 duration;
    }

    /// @notice SHA-256("zedge.vela.tick.v1"): the guest's request for a clock tick.
    bytes32 public constant TICK_SUBTYPE = 0x8af869f39217eabc1718875ec064086a0e0283d1c1ee8a025b687fd40b5e3850;
    /// @notice Registry records in one answer, registry round IDs one request may ask about, and deposit records in
    /// one answer (the inbox's own page size).
    uint256 public constant MAX_RECORDS = 16;
    uint256 public constant MAX_ASKED = 16;
    uint256 public constant MAX_DEPOSITS = 8;
    /// @notice Gas for one createRound, for one getRound or roundIdFor call, and for the one recordsFrom call.
    /// More than three times the honest cost of each (BookClockTriggerTest.test_HonestCosts).
    uint256 public constant CREATE_GAS = 250_000;
    uint256 public constant READ_GAS = 60_000;
    uint256 public constant INBOX_GAS = 150_000;

    uint256 private constant ROUND_BYTES = 704; // getRound's answer: a static struct of 22 words
    uint256 private constant RECORD_BYTES = 608; // 19 words
    uint256 private constant DEPOSIT_BYTES = 96; // 3 words
    uint256 private constant HEADER_BYTES = 256; // 8 words
    uint256 private constant ASK_BYTES = 160; // tick, nextDeposit, s, o, c
    uint256 private constant INBOX_BYTES = 832; // offset, length and 3 * MAX_DEPOSITS words
    bytes4 private constant CREATE_ROUND = bytes4(keccak256("createRound(uint8,uint32,uint64)"));
    bytes4 private constant ROUND_ID_FOR = bytes4(keccak256("roundIdFor(uint8,uint32,uint64)"));
    bytes4 private constant GET_ROUND = bytes4(keccak256("getRound(bytes32)"));
    bytes4 private constant RECORDS_FROM = bytes4(keccak256("recordsFrom(uint64,uint256)"));
    // keccak256(abi.encode(uint256(keccak256("zedge.storage.BookClockTrigger")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION = 0x0078527c72a0d0618dc02445bdb1bc6f34a75d7ec8acc78fa22af86a95892f00;

    error ZeroAddress();
    error InvalidMarket();
    error NotProcessorEndpoint();
    error RenounceDisabled();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @param endpoint_ The ProcessorEndpoint, the only caller answered.
    /// @param registry_ The StreamsRoundRegistry proxy the deployment mirrors.
    /// @param inbox_ The HorizenDepositInbox proxy holding the Base vault's deposit records.
    /// @param asset_ The one market: 0 BTC or 1 ETH. With duration_ (300 or 900 s) it must equal the guest's
    /// `markets` constructor parameter, which the guest cannot check.
    function initialize(
        address owner_,
        address endpoint_,
        address registry_,
        address inbox_,
        uint8 asset_,
        uint32 duration_
    ) external initializer {
        if (endpoint_ == address(0) || registry_ == address(0) || inbox_ == address(0)) {
            revert ZeroAddress();
        }
        if (asset_ > 1 || (duration_ != 300 && duration_ != 900)) revert InvalidMarket();
        __Ownable_init(owner_);
        TriggerStorage storage $ = _trigger();
        ($.endpoint, $.registry, $.inbox, $.asset, $.duration) = (endpoint_, registry_, inbox_, asset_, duration_);
    }

    modifier onlyEndpoint() {
        if (msg.sender != _trigger().endpoint) revert NotProcessorEndpoint();
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

    /// @notice Answers the first tick request with the version-3 payload: words 3, block.chainid, endpoint,
    /// block.number, block.timestamp, tick, n, d, then n registry records of 19 words and d deposit records of 3
    /// words. Any other event, including the guest's own public records, gets empty bytes, so a tick never answers
    /// itself. With a tick request present it cannot revert: the endpoint would swallow the revert and the tick
    /// would be lost.
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
            if (appEventData.subTypes[i] == TICK_SUBTYPE && data.length >= 32) return _answer(data);
        }
        return "";
    }

    /// @dev The request is `tick, nextDeposit, s, o, c`, then s registry IDs of the engine's scheduled rounds, o of
    /// its open ones and c of settled rounds awaiting the registry's confirmation. A request of any other shape, or
    /// one asking about more than MAX_ASKED rounds, gets n = d = 0: a plain clock tick.
    function _answer(bytes calldata data) private returns (bytes memory out) {
        TriggerStorage storage $ = _trigger();
        out = new bytes(HEADER_BYTES + RECORD_BYTES * MAX_RECORDS + DEPOSIT_BYTES * MAX_DEPOSITS);
        _put(out, 0, 3);
        _put(out, 1, block.chainid);
        _put(out, 2, uint256(uint160($.endpoint)));
        _put(out, 3, block.number);
        _put(out, 4, block.timestamp);
        _put(out, 5, uint256(bytes32(data[:32])));
        uint256 records;
        uint256 deposits;
        if (data.length >= ASK_BYTES) {
            uint256 next = uint256(bytes32(data[32:64]));
            uint256 s = uint256(bytes32(data[64:96]));
            uint256 o = uint256(bytes32(data[96:128]));
            uint256 c = uint256(bytes32(data[128:160]));
            if (
                next != 0 && next <= type(uint64).max && s <= MAX_ASKED && o <= MAX_ASKED && c <= MAX_ASKED
                    && s + o + c <= MAX_ASKED && data.length == ASK_BYTES + 32 * (s + o + c)
            ) {
                records = _records($, out, data[ASK_BYTES:], s);
                deposits = _deposits($.inbox, out, 8 + 19 * records, next);
            }
        }
        _put(out, 6, records);
        _put(out, 7, deposits);
        uint256 length = HEADER_BYTES + RECORD_BYTES * records + DEPOSIT_BYTES * deposits;
        assembly ("memory-safe") {
            mstore(out, length)
        }
    }

    /// @dev Creates the next two slots of the market (a failure means the round usually exists already), then writes
    /// a record for every round where the registry is ahead of the engine: an asked scheduled round that has opened
    /// or ended, an asked open or confirmation round that has ended, and a next slot the engine did not ask about.
    /// Every read that fails is skipped; past MAX_RECORDS the rest wait for the next tick.
    function _records(TriggerStorage storage $, bytes memory out, bytes calldata ids, uint256 scheduled)
        private
        returns (uint256 records)
    {
        uint256 first = (block.timestamp / $.duration + 1) * $.duration;
        _create($, first);
        _create($, first + $.duration);
        address registry_ = $.registry;
        uint256 asked = ids.length / 32;
        for (uint256 j; j < asked && records < MAX_RECORDS; ++j) {
            bytes32 id = bytes32(ids[32 * j:32 * j + 32]);
            (bool ok, uint256[22] memory w) = _read(registry_, id);
            // Words 7 and 9 of a Round are openedAt and outcome.
            if (ok && (w[9] != 0 || (j < scheduled && w[7] != 0))) records = _record(out, records, id, w);
        }
        records = _slot($, out, ids, records, first);
        records = _slot($, out, ids, records, first + $.duration);
    }

    /// @dev The record of a next slot the engine did not ask about, if there is room and the registry has it.
    function _slot(TriggerStorage storage $, bytes memory out, bytes calldata ids, uint256 records, uint256 start)
        private
        view
        returns (uint256)
    {
        if (records == MAX_RECORDS) return records;
        (bool known, bytes32 id) = _roundId($, start);
        if (!known || _contains(ids, id)) return records;
        (bool ok, uint256[22] memory w) = _read($.registry, id);
        return ok ? _record(out, records, id, w) : records;
    }

    /// @dev Up to MAX_DEPOSITS inbox records from index `next`, copied word for word at word `at` of the answer. The
    /// answer must be exactly an ABI-encoded uint256[] of whole records, else none is passed on.
    function _deposits(address inbox_, bytes memory out, uint256 at, uint256 next) private view returns (uint256 d) {
        // casting to 'uint64' is safe because _answer passes only a next index within uint64
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes memory call_ = abi.encodeWithSelector(RECORDS_FROM, uint64(next), MAX_DEPOSITS);
        bytes memory answer = new bytes(INBOX_BYTES);
        bool ok;
        uint256 size;
        assembly ("memory-safe") {
            ok := staticcall(INBOX_GAS, inbox_, add(call_, 32), mload(call_), add(answer, 32), INBOX_BYTES)
            size := returndatasize()
        }
        if (!ok || size < 64) return 0;
        uint256 words = _word(answer, 1);
        if (_word(answer, 0) != 32 || words % 3 != 0 || words > 3 * MAX_DEPOSITS || size != 64 + 32 * words) return 0;
        for (uint256 k; k < words; ++k) {
            _put(out, at + k, _word(answer, 2 + k));
        }
        return words / 3;
    }

    /// @dev start goes out as a full word: the registry's own ABI decoding refuses one above uint64.
    function _create(TriggerStorage storage $, uint256 start) private {
        bytes memory call_ = abi.encodeWithSelector(CREATE_ROUND, $.asset, $.duration, start);
        address registry_ = $.registry;
        assembly ("memory-safe") {
            pop(call(CREATE_GAS, registry_, 0, add(call_, 32), mload(call_), 0, 0))
        }
    }

    function _roundId(TriggerStorage storage $, uint256 start) private view returns (bool ok, bytes32 id) {
        bytes memory call_ = abi.encodeWithSelector(ROUND_ID_FOR, $.asset, $.duration, start);
        address registry_ = $.registry;
        assembly ("memory-safe") {
            let at := mload(0x40)
            ok := staticcall(READ_GAS, registry_, add(call_, 32), mload(call_), at, 32)
            ok := and(ok, eq(returndatasize(), 32))
            id := mload(at)
        }
    }

    /// @dev Copies at most ROUND_BYTES of the answer, so a registry that returns a huge answer costs no memory here,
    /// and accepts only an answer of exactly that length.
    function _read(address registry_, bytes32 id) private view returns (bool ok, uint256[22] memory w) {
        bytes memory call_ = abi.encodeWithSelector(GET_ROUND, id);
        assembly ("memory-safe") {
            ok := staticcall(READ_GAS, registry_, add(call_, 32), mload(call_), w, ROUND_BYTES)
            ok := and(ok, eq(returndatasize(), ROUND_BYTES))
        }
    }

    /// @dev Record words: roundId, asset, duration, start, openedAt, resolvedAt, outcome, then the opening and the
    /// closing observation (price, validFromTimestamp, observationsTimestamp, expiresAt, reportHash, decimals),
    /// copied word for word from getRound. The guest decodes them and skips any it cannot read.
    function _record(bytes memory out, uint256 index, bytes32 id, uint256[22] memory w) private pure returns (uint256) {
        uint256 at = 8 + 19 * index;
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

    function _word(bytes memory p, uint256 word) private pure returns (uint256 v) {
        assembly ("memory-safe") {
            v := mload(add(add(p, 32), mul(word, 32)))
        }
    }

    function processorEndpoint() external view returns (address) {
        return _trigger().endpoint;
    }

    function registry() external view returns (address) {
        return _trigger().registry;
    }

    function inbox() external view returns (address) {
        return _trigger().inbox;
    }

    function asset() external view returns (uint8) {
        return _trigger().asset;
    }

    function duration() external view returns (uint32) {
        return _trigger().duration;
    }

    function version() external pure returns (string memory) {
        return "1";
    }

    function renounceOwnership() public virtual override {
        revert RenounceDisabled();
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function _trigger() private pure returns (TriggerStorage storage $) {
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }
}
