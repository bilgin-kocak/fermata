// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {SpikeSettle} from "../src/SpikeSettle.sol";

/// Cross-checks the Rust EIP-712 implementation (`verify --vector > vector.json`) against
/// Solidity + Foundry's `vm.sign`, then settles with the Rust-produced signature.
contract VerdictTest is Test {
    uint256 constant PK = 1;
    address constant ESCROW = 0x0000000000000000000000000000000000000fe1;

    function vector() internal view returns (SpikeSettle.Verdict memory v, bytes32 rr, bytes32 ss, uint8 vv, bytes32 d) {
        string memory json = vm.readFile("vector.json");
        v.callId = vm.parseJsonBytes32(json, ".verdict.call_id");
        v.serviceId = vm.parseJsonBytes32(json, ".verdict.service_id");
        v.requestHash = vm.parseJsonBytes32(json, ".verdict.request_hash");
        v.predicateHash = vm.parseJsonBytes32(json, ".verdict.predicate_hash");
        v.outcome = uint8(vm.parseJsonUint(json, ".verdict.outcome"));
        v.presentationHash = vm.parseJsonBytes32(json, ".verdict.presentation_hash");
        v.responseHash = vm.parseJsonBytes32(json, ".verdict.response_hash");
        v.issuedAt = uint64(vm.parseJsonUint(json, ".verdict.issued_at"));
        rr = vm.parseJsonBytes32(json, ".signature.r");
        ss = vm.parseJsonBytes32(json, ".signature.s");
        vv = uint8(vm.parseJsonUint(json, ".signature.v"));
        d = vm.parseJsonBytes32(json, ".digest");
    }

    function deployAtEscrow() internal returns (SpikeSettle c) {
        vm.chainId(42431);
        SpikeSettle impl = new SpikeSettle(vm.addr(PK));
        vm.etch(ESCROW, address(impl).code);
        // immutables live in the code, so the etched copy keeps `verifier`
        c = SpikeSettle(ESCROW);
    }

    function test_digest_and_signature_match_rust() public {
        SpikeSettle c = deployAtEscrow();
        (SpikeSettle.Verdict memory v, bytes32 rr, bytes32 ss, uint8 vv, bytes32 d) = vector();
        bytes32 solDigest = c.digest(v);
        assertEq(solDigest, d, "digest differs from Rust");
        (uint8 fv, bytes32 fr, bytes32 fs) = vm.sign(PK, solDigest);
        assertEq(fr, rr, "r differs");
        assertEq(fs, ss, "s differs");
        assertEq(fv, vv, "v differs");
    }

    function test_settle_accepts_rust_signature_and_rejects_replay() public {
        SpikeSettle c = deployAtEscrow();
        (SpikeSettle.Verdict memory v, bytes32 rr, bytes32 ss, uint8 vv,) = vector();
        bytes memory sig = abi.encodePacked(rr, ss, vv);
        vm.expectEmit(true, false, false, true, address(c));
        emit SpikeSettle.Settled(v.callId, v.outcome, v.presentationHash);
        c.settle(v, sig);
        assertEq(c.settled(v.callId), 1);
        vm.expectRevert(SpikeSettle.AlreadySettled.selector);
        c.settle(v, sig);
    }

    function test_settle_rejects_other_signer_and_other_chain() public {
        SpikeSettle c = deployAtEscrow();
        (SpikeSettle.Verdict memory v, bytes32 rr, bytes32 ss, uint8 vv,) = vector();
        (uint8 ov, bytes32 orr, bytes32 oss) = vm.sign(2, c.digest(v));
        vm.expectRevert(SpikeSettle.WrongVerifier.selector);
        c.settle(v, abi.encodePacked(orr, oss, ov));
        // a signature made for chain 42431 must not verify under another chain id
        vm.chainId(1);
        vm.expectRevert(SpikeSettle.WrongVerifier.selector);
        c.settle(v, abi.encodePacked(rr, ss, vv));
    }
}
