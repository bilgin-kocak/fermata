// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MockTIP20} from "./MockTIP20.sol";
import {FermataEscrow} from "../../src/FermataEscrow.sol";

/// @notice Token that re-enters the escrow from inside every transfer and records whether the
/// re-entrant call succeeded (it must not).
contract ReentrantTIP20 is MockTIP20 {
    FermataEscrow public escrow;
    bytes32 public target;
    bool public attack;
    uint256 public reentryAttempts;
    uint256 public reentrySuccesses;

    constructor() MockTIP20("Reentrant", "RE") {}

    function arm(FermataEscrow escrow_, bytes32 callId) external {
        escrow = escrow_;
        target = callId;
        attack = true;
    }

    function _reenter() internal {
        if (!attack || address(escrow) == address(0)) return;
        attack = false; // one attempt per transfer burst, avoid infinite recursion
        reentryAttempts++;
        try escrow.claimTimeout(target) {
            reentrySuccesses++;
        } catch {}
        try escrow.hold(target, bytes32(0), bytes32(uint256(1)), 0, 0, 0, 0) {
            reentrySuccesses++;
        } catch {}
        attack = true;
    }

    function transferWithMemo(address to, uint256 amount, bytes32 memo) external override {
        _reenter();
        _move(msg.sender, to, amount);
        emit TransferWithMemo(msg.sender, to, amount, memo);
    }

    function transferFromWithMemo(address from, address to, uint256 amount, bytes32 memo)
        external
        override
        returns (bool)
    {
        _reenter();
        _spend(from, amount);
        _move(from, to, amount);
        emit TransferWithMemo(from, to, amount, memo);
        return true;
    }
}

/// @notice Token whose transferFromWithMemo reports failure instead of reverting.
contract FalseTIP20 is MockTIP20 {
    constructor() MockTIP20("False", "FALSE") {}

    function transferFromWithMemo(address, address, uint256, bytes32) external pure override returns (bool) {
        return false;
    }
}
