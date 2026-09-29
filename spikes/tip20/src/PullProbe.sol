// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {ITIP20} from "./ITIP20.sol";

/// @notice Probe 3: the escrow's `hold` shape — permit + transferFromWithMemo in one transaction,
/// with the memo (= callId) on the token transfer.
contract PullProbe {
    event Pulled(address indexed token, address indexed from, uint256 amount, bytes32 indexed memo);

    function pull(ITIP20 token, address from, uint256 amount, bytes32 memo, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
    {
        token.permit(from, address(this), amount, deadline, v, r, s);
        bool ok = token.transferFromWithMemo(from, address(this), amount, memo);
        require(ok, "transferFromWithMemo returned false");
        emit Pulled(address(token), from, amount, memo);
    }
}
