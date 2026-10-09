// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {BookClockTrigger} from "./BookClockTrigger.sol";

/// @notice BookClockTrigger with its deposit records switched off, for retiring an application without stopping it: the
/// owner upgrades the application's trigger proxy to this, and from that block the guest is never handed another Base
/// deposit. Its balances can still be traded, settled and withdrawn; a deposit made afterwards is credited only by the
/// application that replaces it (docs/cutover-politics.md).
/// @dev The clock words and the registry records are BookClockTrigger's, byte for byte: only `_deposits` differs, and
/// every answer carries d = 0. No storage of its own, so the proxy's state (the trigger's ERC-7201 namespace, and
/// Ownable2Step's and Initializable's) reads exactly as before. The owner can still upgrade it.
contract WithdrawOnlyBookClockTrigger is BookClockTrigger {
    function _deposits(address, bytes memory, uint256, uint256) internal pure override returns (uint256) {
        return 0;
    }
}
