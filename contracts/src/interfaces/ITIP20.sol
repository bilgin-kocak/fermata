// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.13 <0.9.0;

/// @notice Subset of Tempo's ITIP20 (tempoxyz/tempo-std src/interfaces/ITIP20.sol (commit 785c5d1), 2026-09-23),
/// signatures copied verbatim. Note transferWithMemo returns nothing; transferFromWithMemo returns bool.
interface ITIP20 {
    error ContractPaused();
    error InsufficientAllowance();
    error InsufficientBalance(uint256 currentBalance, uint256 expectedBalance, address);
    error InvalidRecipient();
    error PolicyForbids();
    error PermitExpired();
    error InvalidSignature();

    event Approval(address indexed owner, address indexed spender, uint256 amount);
    event Mint(address indexed to, uint256 amount);
    event Transfer(address indexed from, address indexed to, uint256 amount);
    event TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo);

    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external pure returns (uint8);
    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function totalSupply() external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transferFromWithMemo(address from, address to, uint256 amount, bytes32 memo) external returns (bool);
    function transferWithMemo(address to, uint256 amount, bytes32 memo) external;
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
    function nonces(address owner) external view returns (uint256);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}
