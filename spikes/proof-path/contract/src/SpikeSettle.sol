// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Milestone S probe 1: settle-only contract that accepts a Fermata EIP-712 Verdict signed
/// by one verifier key. Throwaway spike code (hand-rolled EIP-712, no OpenZeppelin).
contract SpikeSettle {
    struct Verdict {
        bytes32 callId;
        bytes32 serviceId;
        bytes32 requestHash;
        bytes32 predicateHash;
        uint8 outcome;
        bytes32 presentationHash;
        bytes32 responseHash;
        uint64 issuedAt;
    }

    bytes32 public constant VERDICT_TYPEHASH = keccak256(
        "Verdict(bytes32 callId,bytes32 serviceId,bytes32 requestHash,bytes32 predicateHash,uint8 outcome,bytes32 presentationHash,bytes32 responseHash,uint64 issuedAt)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    uint8 public constant OUTCOME_DELIVERED = 1;
    uint8 public constant OUTCOME_FAILED = 2;

    address public immutable verifier;
    mapping(bytes32 => uint8) public settled;

    event Settled(bytes32 indexed callId, uint8 outcome, bytes32 presentationHash);

    error AlreadySettled();
    error BadOutcome();
    error BadSignature();
    error WrongVerifier();

    constructor(address verifier_) {
        verifier = verifier_;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("Fermata"), keccak256("1"), block.chainid, address(this))
        );
    }

    function hashVerdict(Verdict calldata v) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                VERDICT_TYPEHASH,
                v.callId,
                v.serviceId,
                v.requestHash,
                v.predicateHash,
                v.outcome,
                v.presentationHash,
                v.responseHash,
                v.issuedAt
            )
        );
    }

    function digest(Verdict calldata v) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), hashVerdict(v)));
    }

    function settle(Verdict calldata v, bytes calldata sig) external {
        if (settled[v.callId] != 0) revert AlreadySettled();
        if (v.outcome != OUTCOME_DELIVERED && v.outcome != OUTCOME_FAILED) revert BadOutcome();
        if (sig.length != 65) revert BadSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 vv = uint8(sig[64]);
        // low-s and v in {27,28}
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSignature();
        if (vv != 27 && vv != 28) revert BadSignature();
        address signer = ecrecover(digest(v), vv, r, s);
        if (signer == address(0)) revert BadSignature();
        if (signer != verifier) revert WrongVerifier();
        settled[v.callId] = v.outcome;
        emit Settled(v.callId, v.outcome, v.presentationHash);
    }
}
