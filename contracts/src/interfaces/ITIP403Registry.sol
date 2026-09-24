// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.13 <0.9.0;

/// @notice Subset of Tempo's TIP-403 registry precompile (TIP-1028 receive policies), signatures copied
/// from tempoxyz/tempo-std src/interfaces/ITIP403Registry.sol (commit 785c5d1) and
/// tempoxyz/tempo crates/contracts/src/precompiles/tip403_registry.rs (commit 1f3b3a3).
/// Deployed at 0x403c000000000000000000000000000000000000 on every Tempo chain.
interface ITIP403Registry {
    enum BlockedReason {
        NONE,
        TOKEN_FILTER,
        RECEIVE_POLICY
    }

    /// @notice Whether `receiver`'s receive policy accepts `token` sent by `sender`. A transfer that
    /// fails this check does not revert on Tempo: it is redirected to the ReceivePolicyGuard.
    function validateReceivePolicy(address token, address sender, address receiver)
        external
        view
        returns (bool authorized, BlockedReason blockedReason);

    /// @notice Sets the caller's receive policy (policy id 0 = reject all, 1 = allow all).
    function setReceivePolicy(uint64 senderPolicyId, uint64 tokenFilterId, address recoveryAuthority) external;
}
