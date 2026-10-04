// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IStreamsBoundaryOracle} from "./interfaces/IStreamsBoundaryOracle.sol";

/// @dev Minimal ABI for the subscription-billed verifier. Calls always carry zero ETH and empty fee metadata.
interface IChainlinkStreamsVerifierProxy {
    function verify(bytes calldata payload, bytes calldata parameterPayload) external returns (bytes memory);
}

/// @notice Immutable, exact-precision adapter for two approved schema-v3 Crypto Advanced streams.
/// @dev The external verifier authenticates reports; this contract enforces ZEDGE's boundary policy.
/// Canonical selection relies on the DON's contiguous, nonoverlapping report-window guarantee.
/// Constructor code presence does not establish verifier provenance, feed metadata, or network support.
contract ChainlinkStreamsBoundaryOracle is IStreamsBoundaryOracle, ReentrancyGuard {
    struct ReportV3 {
        bytes32 feedId;
        uint32 validFromTimestamp;
        uint32 observationsTimestamp;
        uint192 nativeFee;
        uint192 linkFee;
        uint32 expiresAt;
        int192 price;
        int192 bid;
        int192 ask;
    }

    error InvalidConfig();
    error UnknownFeed();
    error InvalidWindow();
    error InvalidEvidence();
    error InvalidOracleResponse();

    uint256 public constant MAX_EVIDENCE_BYTES = 16_384;
    uint256 public constant REPORT_BYTES = 9 * 32;
    IChainlinkStreamsVerifierProxy public immutable verifierProxy;
    bytes32 public immutable btcFeedId;
    bytes32 public immutable ethFeedId;
    uint8 public immutable btcDecimals;
    uint8 public immutable ethDecimals;

    constructor(
        address verifier,
        bytes32 btcFeedId_,
        uint8 btcDecimals_,
        bytes32 ethFeedId_,
        uint8 ethDecimals_
    ) {
        if (
            verifier.code.length == 0 || bytes2(btcFeedId_) != bytes2(uint16(3))
                || bytes2(ethFeedId_) != bytes2(uint16(3)) || btcFeedId_ == ethFeedId_ || btcDecimals_ > 18
                || ethDecimals_ > 18
        ) revert InvalidConfig();
        verifierProxy = IChainlinkStreamsVerifierProxy(verifier);
        btcFeedId = btcFeedId_;
        ethFeedId = ethFeedId_;
        btcDecimals = btcDecimals_;
        ethDecimals = ethDecimals_;
    }

    function version() external pure returns (string memory) {
        return "zedge-chainlink-streams-boundary-v1";
    }

    /// @param evidence The complete signed payload from the Streams API, passed unchanged to the verifier.
    /// @dev No confidence value is manufactured from bid/ask, and no price rounding is performed.
    /// Report expiration is inclusive: expiresAt == block.timestamp is accepted; later submission fails.
    function verifyBoundary(bytes32 feedId, uint64 boundary, uint64 maxPublishTime, bytes calldata evidence)
        external
        nonReentrant
        returns (Observation memory observation)
    {
        uint8 decimals = _decimals(feedId);
        if (boundary == 0 || boundary > maxPublishTime || boundary > block.timestamp) revert InvalidWindow();
        if (evidence.length == 0 || evidence.length > MAX_EVIDENCE_BYTES) revert InvalidEvidence();

        // Decode only the authenticated returned body, never caller-supplied unsigned report bytes.
        bytes memory body = verifierProxy.verify(evidence, bytes(""));
        if (body.length != REPORT_BYTES) revert InvalidOracleResponse();
        ReportV3 memory report = abi.decode(body, (ReportV3));
        if (
            report.feedId != feedId || report.price <= 0 || report.validFromTimestamp == 0
                || report.validFromTimestamp > boundary || report.observationsTimestamp < boundary
                || report.observationsTimestamp > maxPublishTime
                || report.observationsTimestamp > block.timestamp
                || report.expiresAt < report.observationsTimestamp || block.timestamp > report.expiresAt
        ) revert InvalidOracleResponse();

        observation = Observation({
            price: report.price,
            validFromTimestamp: report.validFromTimestamp,
            observationsTimestamp: report.observationsTimestamp,
            expiresAt: report.expiresAt,
            reportHash: keccak256(body),
            decimals: decimals
        });
    }

    function _decimals(bytes32 feedId) private view returns (uint8) {
        if (feedId == btcFeedId) return btcDecimals;
        if (feedId == ethFeedId) return ethDecimals;
        revert UnknownFeed();
    }
}
