// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";
import {IBoundaryOracle} from "./interfaces/IBoundaryOracle.sol";

/// @notice Immutable adapter to an externally verified Pyth Core deployment with unique historical updates.
/// @dev No Horizen deployment is assumed. A Stork Pyth-shaped adapter lacking the unique method is incompatible.
contract PythBoundaryOracle is IBoundaryOracle, ReentrancyGuard {
    error InvalidVerifier();
    error InvalidWindow();
    error InvalidEvidence();
    error IncorrectFee(uint256 expected, uint256 received);
    error InvalidOracleResponse();

    IPyth public immutable pyth;
    uint256 public constant MAX_EVIDENCE_BYTES = 65_536;
    uint256 public constant MAX_UPDATES = 16;

    constructor(address verifier) {
        if (verifier.code.length == 0) revert InvalidVerifier();
        pyth = IPyth(verifier);
    }

    function version() external pure returns (string memory) {
        return "zedge-pyth-boundary-v1";
    }

    /// @dev Evidence is abi.encode(bytes[] updateData), exactly as consumed by the Pyth Core SDK.
    function quoteFee(bytes calldata evidence) external view returns (uint256) {
        return pyth.getUpdateFee(_decode(evidence));
    }

    function verifyBoundary(bytes32 feedId, uint64 boundary, uint64 maxPublishTime, bytes calldata evidence)
        external
        payable
        nonReentrant
        returns (Observation memory observation)
    {
        if (feedId == bytes32(0) || boundary > maxPublishTime) revert InvalidWindow();
        bytes[] memory updates = _decode(evidence);
        uint256 fee = pyth.getUpdateFee(updates);
        if (msg.value != fee) revert IncorrectFee(fee, msg.value);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = feedId;
        PythStructs.PriceFeed[] memory feeds =
            pyth.parsePriceFeedUpdatesUnique{value: fee}(updates, ids, boundary, maxPublishTime);
        if (feeds.length != 1 || feeds[0].id != feedId) revert InvalidOracleResponse();
        PythStructs.Price memory price = feeds[0].price;
        if (
            price.publishTime < boundary || price.publishTime > maxPublishTime
                || price.publishTime > block.timestamp
        ) revert InvalidOracleResponse();
        // The upper bound is a uint64; this conversion cannot truncate an accepted timestamp.
        observation = Observation(price.price, price.conf, price.expo, uint64(price.publishTime));
    }

    function _decode(bytes calldata evidence) private pure returns (bytes[] memory updates) {
        if (evidence.length == 0 || evidence.length > MAX_EVIDENCE_BYTES) revert InvalidEvidence();
        updates = abi.decode(evidence, (bytes[]));
        if (updates.length == 0 || updates.length > MAX_UPDATES) revert InvalidEvidence();
        for (uint256 i; i < updates.length; ++i) {
            if (updates[i].length == 0) revert InvalidEvidence();
        }
    }
}
