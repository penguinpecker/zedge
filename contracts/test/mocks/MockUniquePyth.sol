// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

/// @dev TEST ONLY; models the unique-boundary ABI, NOT Pyth signature/proof verification.
/// SDK 4.3.1 MockPyth currently passes checkUniqueness=false in its unique method;
/// this explicit fixture instead enforces predecessor < boundary in the normal path.
contract MockUniquePyth {
    enum Response {
        Valid,
        WrongFeed,
        Empty,
        Extra,
        Future,
        BelowWindow,
        AboveWindow
    }
    Response public response;
    uint256 public uniqueCalls;
    uint256 public fee = 3;
    bool public fail;

    function setResponse(Response value) external {
        response = value;
    }

    function setFailure(bool value) external {
        fail = value;
    }

    function getUpdateFee(bytes[] calldata) external view returns (uint256) {
        return fee;
    }

    function parsePriceFeedUpdatesUnique(
        bytes[] calldata updates,
        bytes32[] calldata ids,
        uint64 minimum,
        uint64 maximum
    ) external payable returns (PythStructs.PriceFeed[] memory feeds) {
        require(!fail, "test verifier unavailable");
        require(msg.value == fee && ids.length == 1, "test input");
        (PythStructs.PriceFeed memory feed, uint64 previous) =
            abi.decode(updates[0], (PythStructs.PriceFeed, uint64));
        require(feed.id == ids[0] && previous < minimum, "not unique boundary");
        require(feed.price.publishTime >= minimum && feed.price.publishTime <= maximum, "outside window");
        ++uniqueCalls;
        if (response == Response.Empty) return new PythStructs.PriceFeed[](0);
        feeds = new PythStructs.PriceFeed[](response == Response.Extra ? 2 : 1);
        if (response == Response.WrongFeed) feed.id = bytes32(uint256(999));
        if (response == Response.Future) feed.price.publishTime = block.timestamp + 1;
        if (response == Response.BelowWindow) feed.price.publishTime = minimum - 1;
        if (response == Response.AboveWindow) feed.price.publishTime = uint256(maximum) + 1;
        feeds[0] = feed;
    }
}
