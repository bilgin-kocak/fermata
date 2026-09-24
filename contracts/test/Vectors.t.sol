// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {FermataEscrow} from "../src/FermataEscrow.sol";
import {MockTIP20} from "./mocks/MockTIP20.sol";

/// @notice Cross-language vectors. `fixtures/verdict-vector.json` is the output of the Rust signer
/// (`spikes/proof-path` `verify --vector`, k256 + keccak, the code Milestone 2's attestor ports):
/// escrow 0x…0fe1 on chain 42431, verifier key 0x…01, callId 0x11…, serviceId 0x22…, requestHash
/// 0x33…, predicateHash 0x44…, DELIVERED, presentationHash 0x55…, responseHash 0x66…, issuedAt 1.7e9.
contract VectorsTest is Test {
    address internal constant ESCROW = 0x0000000000000000000000000000000000000fe1;
    uint256 internal constant PRICE = 10_000;
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function _verdict(string memory json) internal pure returns (FermataEscrow.Verdict memory v) {
        v.callId = vm.parseJsonBytes32(json, ".verdict.call_id");
        v.serviceId = vm.parseJsonBytes32(json, ".verdict.service_id");
        v.requestHash = vm.parseJsonBytes32(json, ".verdict.request_hash");
        v.predicateHash = vm.parseJsonBytes32(json, ".verdict.predicate_hash");
        v.outcome = uint8(vm.parseJsonUint(json, ".verdict.outcome"));
        v.presentationHash = vm.parseJsonBytes32(json, ".verdict.presentation_hash");
        v.responseHash = vm.parseJsonBytes32(json, ".verdict.response_hash");
        v.issuedAt = uint64(vm.parseJsonUint(json, ".verdict.issued_at"));
    }

    /// @notice A verdict signed by the Rust signer settles on the real contract.
    function test_rustSignedVerdictSettles() public {
        vm.chainId(42431);
        string memory json = vm.readFile("test/fixtures/verdict-vector.json");
        FermataEscrow.Verdict memory v = _verdict(json);
        bytes memory rustSig = vm.parseJsonBytes(json, ".signatureBytes");
        address verifier = vm.parseJsonAddress(json, ".signer");
        assertEq(verifier, vm.addr(1));

        MockTIP20 token = new MockTIP20("pathUSD", "pathUSD");
        deployCodeTo(
            "FermataEscrow.sol:FermataEscrow", abi.encode(makeAddr("owner"), makeAddr("treasury"), uint16(50)), ESCROW
        );
        FermataEscrow escrow = FermataEscrow(ESCROW);
        assertEq(escrow.DOMAIN_SEPARATOR(), vm.parseJsonBytes32(json, ".domainSeparator"), "domain separator");
        assertEq(escrow.hashVerdict(v), vm.parseJsonBytes32(json, ".structHash"), "struct hash");
        assertEq(escrow.verdictDigest(v), vm.parseJsonBytes32(json, ".digest"), "digest");

        // serviceId 0x2222… is owned by address 0x2222…2222 (sender-prefixed ids)
        address vendor = address(bytes20(v.serviceId));
        vm.prank(vendor);
        escrow.registerService(
            v.serviceId,
            makeAddr("payout"),
            address(token),
            PRICE,
            120,
            verifier,
            v.predicateHash,
            bytes32(0),
            bytes32(0)
        );

        _hold(escrow, token, v);

        escrow.settle(v.callId, v, rustSig);
        assertEq(uint8(escrow.getHold(v.callId).status), uint8(FermataEscrow.Status.Released));
        assertEq(token.balanceOf(makeAddr("payout")), PRICE - (PRICE * 50) / 10_000);
    }

    function _hold(FermataEscrow escrow, MockTIP20 token, FermataEscrow.Verdict memory v) internal {
        uint256 agentPk = 0xA11CE;
        address agent = vm.addr(agentPk);
        token.mint(agent, PRICE);
        uint256 deadline = block.timestamp + 600;
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, agent, address(escrow), PRICE, uint256(0), deadline));
        (uint8 pv, bytes32 pr, bytes32 ps) =
            vm.sign(agentPk, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)));
        vm.prank(agent);
        escrow.hold(v.callId, v.serviceId, v.requestHash, deadline, pv, pr, ps);
    }

    /// @notice Foundry's signer produces the same (r, s, v) as the Rust signer (RFC 6979, low-s).
    function test_foundrySignatureEqualsRust() public view {
        string memory json = vm.readFile("test/fixtures/verdict-vector.json");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(1, vm.parseJsonBytes32(json, ".digest"));
        assertEq(r, vm.parseJsonBytes32(json, ".signature.r"));
        assertEq(s, vm.parseJsonBytes32(json, ".signature.s"));
        assertEq(v, vm.parseJsonUint(json, ".signature.v"));
    }

    /// @notice requestHash = sha256(serviceId ‖ METHOD ‖ target ‖ sha256(body)); Rust spike value.
    function test_requestHashMatchesRust() public pure {
        bytes32 serviceId = bytes32(uint256(1));
        bytes memory body = bytes('{"symbol":"BTC-USD"}');
        assertEq(
            sha256(abi.encodePacked(serviceId, "POST", "/v1/quote", sha256(body))),
            0xe8b23a0b9ea8101a4a0173a94062d4c5a197bc08b706e069c58eafccc47444b7
        );
    }
}
