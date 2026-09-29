// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {FermataEscrow} from "../src/FermataEscrow.sol";
import {ITIP20} from "../src/interfaces/ITIP20.sol";
import {MockTIP20} from "./mocks/MockTIP20.sol";

/// @notice Shared fixture: one TIP-20 mock, one escrow (fee 50 bps), one registered service.
abstract contract EscrowBase is Test {
    uint256 internal constant AGENT_PK = 0xA11CE;
    uint256 internal constant VERIFIER_PK = 0xBEEF;
    uint256 internal constant PRICE = 10_000; // 0.01 pathUSD (6 decimals)
    uint32 internal constant WINDOW = 120;
    uint16 internal constant FEE_BPS = 50;
    bytes32 internal constant PREDICATE = keccak256("predicate.json");
    bytes32 internal constant ORIGIN = keccak256("https://vendor.fermata.test:8443");
    bytes32 internal constant NOTARY = keccak256("notary-key");
    bytes32 internal constant REQUEST = keccak256("POST /v1/quote");
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    MockTIP20 internal token;
    FermataEscrow internal escrow;
    address internal owner = makeAddr("owner");
    address internal treasury = makeAddr("treasury");
    address internal vendor = makeAddr("vendor");
    address internal payout = makeAddr("payout");
    address internal relayer = makeAddr("relayer");
    address internal agent;
    address internal verifier;
    bytes32 internal serviceId;

    function setUp() public virtual {
        vm.chainId(42431);
        token = new MockTIP20("pathUSD", "pathUSD");
        escrow = new FermataEscrow(owner, treasury, FEE_BPS);
        agent = vm.addr(AGENT_PK);
        verifier = vm.addr(VERIFIER_PK);
        serviceId = sid(vendor, "quote");
        vm.prank(vendor);
        escrow.registerService(serviceId, payout, address(token), PRICE, WINDOW, verifier, PREDICATE, ORIGIN, NOTARY);
        token.mint(agent, 1_000_000e6);
    }

    // ------------------------------------------------------------------------------------ helpers

    /// @dev serviceId = owner address (20 bytes) ‖ 12-byte label.
    function sid(address who, bytes12 label) internal pure returns (bytes32) {
        return bytes32(abi.encodePacked(bytes20(who), label));
    }

    function callIdOf(uint256 n) internal pure returns (bytes32) {
        return keccak256(abi.encode("call", n));
    }

    function permitSig(uint256 pk, ITIP20 tok, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        address holder = vm.addr(pk);
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, holder, spender, value, tok.nonces(holder), deadline));
        (v, r, s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", tok.DOMAIN_SEPARATOR(), structHash)));
    }

    /// @dev Agent holds PRICE for `callId` on the default service via a fresh permit.
    function doHold(bytes32 callId) internal {
        doHoldFor(AGENT_PK, token, serviceId, callId, PRICE);
    }

    function doHoldFor(uint256 pk, ITIP20 tok, bytes32 service, bytes32 callId, uint256 value) internal {
        uint256 deadline = block.timestamp + 600;
        (uint8 v, bytes32 r, bytes32 s) = permitSig(pk, tok, address(escrow), value, deadline);
        vm.prank(vm.addr(pk));
        escrow.hold(callId, service, REQUEST, deadline, v, r, s);
    }

    function verdict(bytes32 callId, uint8 outcome) internal view returns (FermataEscrow.Verdict memory) {
        return FermataEscrow.Verdict({
            callId: callId,
            serviceId: serviceId,
            requestHash: REQUEST,
            predicateHash: PREDICATE,
            outcome: outcome,
            presentationHash: keccak256(abi.encode("presentation", callId)),
            responseHash: keccak256(abi.encode("response", callId)),
            issuedAt: uint64(block.timestamp)
        });
    }

    function sign(uint256 pk, FermataEscrow.Verdict memory v) internal view returns (bytes memory) {
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(pk, escrow.verdictDigest(v));
        return abi.encodePacked(r, s, vv);
    }

    /// @dev Independent EIP-712 implementation, used to sign for other domains.
    function digestFor(address escrowAddr, uint256 chainId, FermataEscrow.Verdict memory v)
        internal
        pure
        returns (bytes32)
    {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("Fermata"),
                keccak256("1"),
                chainId,
                escrowAddr
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Verdict(bytes32 callId,bytes32 serviceId,bytes32 requestHash,bytes32 predicateHash,uint8 outcome,bytes32 presentationHash,bytes32 responseHash,uint64 issuedAt)"
                ),
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
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function settleAs(address caller, bytes32 callId, uint8 outcome) internal {
        FermataEscrow.Verdict memory v = verdict(callId, outcome);
        bytes memory sig = sign(VERIFIER_PK, v);
        vm.prank(caller);
        escrow.settle(callId, v, sig);
    }

    function statusOf(bytes32 callId) internal view returns (FermataEscrow.Status) {
        return escrow.getHold(callId).status;
    }

    /// @dev Every movement of `tok` in `logs` must be a Transfer immediately followed by a
    /// TransferWithMemo with the same (from, to, amount) and memo == callId. Approval logs (permit)
    /// are ignored. Asserts the exact number of movements.
    function assertMemoMovements(Vm.Log[] memory logs, address tok, bytes32 callId, uint256 expected) internal pure {
        uint256 movements;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != tok) continue;
            bytes32 t0 = logs[i].topics[0];
            if (t0 == ITIP20.Approval.selector) continue;
            require(t0 == ITIP20.Transfer.selector, "unexpected token log (memo-less movement?)");
            require(i + 1 < logs.length, "Transfer without TransferWithMemo");
            Vm.Log memory m = logs[i + 1];
            require(
                m.emitter == tok && m.topics[0] == ITIP20.TransferWithMemo.selector, "Transfer not followed by memo"
            );
            require(m.topics[1] == logs[i].topics[1] && m.topics[2] == logs[i].topics[2], "memo from/to mismatch");
            require(keccak256(m.data) == keccak256(logs[i].data), "memo amount mismatch");
            require(m.topics[3] == callId, "memo != callId");
            movements++;
            i++;
        }
        require(movements == expected, "unexpected number of token movements");
    }
}
