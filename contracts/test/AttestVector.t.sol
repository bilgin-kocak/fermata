// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {FermataEscrow} from "../src/FermataEscrow.sol";
import {MockTIP20} from "./mocks/MockTIP20.sol";

/// @notice Milestone 2 acceptance: verdicts produced by the attestor from *real* TLSNotary
/// presentations of the demo vendor (a 200 quote → DELIVERED, an authenticated 500 → FAILED) settle
/// on the real contract. `fixtures/attest-vector.json` is written by
/// `apps/attestor/tests/attest.rs` (`cargo test --release -- --ignored`), which signs for escrow
/// 0x…fe1a on chain 42431.
contract AttestVectorTest is Test {
    uint256 internal constant PRICE = 10_000;
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    string internal constant TARGET = "/v1/quote?symbol=BTC-USD";

    string internal json;
    FermataEscrow internal escrow;
    MockTIP20 internal token;
    address internal payout = makeAddr("payout");
    uint256 internal agentPk = 0xA11CE;

    function setUp() public {
        json = vm.readFile("test/fixtures/attest-vector.json");
        vm.chainId(vm.parseJsonUint(json, ".chainId"));
        token = new MockTIP20("pathUSD", "pathUSD");
        address at = vm.parseJsonAddress(json, ".escrow");
        deployCodeTo(
            "FermataEscrow.sol:FermataEscrow", abi.encode(makeAddr("owner"), makeAddr("treasury"), uint16(50)), at
        );
        escrow = FermataEscrow(at);
    }

    function _verdict(string memory key) internal view returns (FermataEscrow.Verdict memory v) {
        v.callId = vm.parseJsonBytes32(json, string.concat(key, ".verdict.call_id"));
        v.serviceId = vm.parseJsonBytes32(json, string.concat(key, ".verdict.service_id"));
        v.requestHash = vm.parseJsonBytes32(json, string.concat(key, ".verdict.request_hash"));
        v.predicateHash = vm.parseJsonBytes32(json, string.concat(key, ".verdict.predicate_hash"));
        v.outcome = uint8(vm.parseJsonUint(json, string.concat(key, ".verdict.outcome")));
        v.presentationHash = vm.parseJsonBytes32(json, string.concat(key, ".verdict.presentation_hash"));
        v.responseHash = vm.parseJsonBytes32(json, string.concat(key, ".verdict.response_hash"));
        v.issuedAt = uint64(vm.parseJsonUint(json, string.concat(key, ".verdict.issued_at")));
    }

    /// @dev Registers the case's service exactly as a vendor would (all three hashes the attestor
    /// checked), holds the agent's payment for the verdict's callId/requestHash, returns the verdict.
    function _setupCase(string memory key) internal returns (FermataEscrow.Verdict memory v, bytes memory sig) {
        v = _verdict(key);
        sig = vm.parseJsonBytes(json, string.concat(key, ".signature"));
        vm.prank(address(bytes20(v.serviceId)));
        escrow.registerService(
            v.serviceId,
            payout,
            address(token),
            PRICE,
            120,
            vm.parseJsonAddress(json, ".signer"),
            vm.parseJsonBytes32(json, ".predicateHash"),
            vm.parseJsonBytes32(json, string.concat(key, ".originHash")),
            vm.parseJsonBytes32(json, ".notaryKeyHash")
        );
        address agent = vm.addr(agentPk);
        token.mint(agent, PRICE);
        uint256 deadline = block.timestamp + 600;
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, agent, address(escrow), PRICE, token.nonces(agent), deadline));
        (uint8 pv, bytes32 pr, bytes32 ps) =
            vm.sign(agentPk, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)));
        vm.prank(agent);
        escrow.hold(v.callId, v.serviceId, v.requestHash, deadline, pv, pr, ps);
    }

    function test_requestHashIsTheProvedRequest() public view {
        FermataEscrow.Verdict memory v = _verdict(".delivered");
        assertEq(v.requestHash, sha256(abi.encodePacked(v.serviceId, "GET", TARGET, sha256(""))));
    }

    function test_attestorDeliveredVerdictReleases() public {
        (FermataEscrow.Verdict memory v, bytes memory sig) = _setupCase(".delivered");
        assertEq(v.outcome, 1);
        vm.expectEmit(address(escrow));
        emit FermataEscrow.Released(v.callId, v.serviceId, payout, PRICE, PRICE * 50 / 10_000, v.presentationHash);
        escrow.settle(v.callId, v, sig);
        assertEq(uint8(escrow.getHold(v.callId).status), uint8(FermataEscrow.Status.Released));
        assertEq(token.balanceOf(payout), PRICE - PRICE * 50 / 10_000);
    }

    function test_attestorFailedVerdictRefunds() public {
        (FermataEscrow.Verdict memory v, bytes memory sig) = _setupCase(".failed");
        assertEq(v.outcome, 2);
        escrow.settle(v.callId, v, sig);
        assertEq(uint8(escrow.getHold(v.callId).status), uint8(FermataEscrow.Status.Refunded));
        assertEq(token.balanceOf(vm.addr(agentPk)), PRICE);
    }

    function test_attestorVerdictCannotSettleAnotherCall() public {
        (FermataEscrow.Verdict memory v, bytes memory sig) = _setupCase(".delivered");
        FermataEscrow.Verdict memory other = _verdict(".delivered"); // a copy (memory structs alias)
        other.callId = keccak256("another call");
        vm.expectRevert(FermataEscrow.NotHeld.selector);
        escrow.settle(other.callId, other, sig);
        vm.expectRevert(FermataEscrow.CallIdMismatch.selector);
        escrow.settle(v.callId, other, sig);
    }
}
