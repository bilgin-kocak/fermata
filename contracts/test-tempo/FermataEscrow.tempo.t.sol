// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {FermataEscrow} from "../src/FermataEscrow.sol";
import {ITIP20} from "../src/interfaces/ITIP20.sol";
import {ITIP403Registry} from "../src/interfaces/ITIP403Registry.sol";

/// @notice Core escrow cases against Tempo's real TIP-20 precompile (pathUSD) and TIP-403 registry.
/// Run with: FOUNDRY_PROFILE=tempo forge test   (the profile sets `network = "tempo"`).
contract FermataEscrowTempoTest is Test {
    ITIP20 internal constant PATH_USD = ITIP20(0x20C0000000000000000000000000000000000000);
    ITIP403Registry internal constant REGISTRY = ITIP403Registry(0x403c000000000000000000000000000000000000);
    address internal constant GUARD = 0xB10C000000000000000000000000000000000000;
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    uint256 internal constant AGENT_PK = 0xA11CE;
    uint256 internal constant VERIFIER_PK = 0xBEEF;
    uint256 internal constant PRICE = 10_000;
    uint32 internal constant WINDOW = 120;
    bytes32 internal constant PREDICATE = keccak256("predicate.json");
    bytes32 internal constant REQUEST = keccak256("POST /v1/quote");

    FermataEscrow internal escrow;
    address internal agent;
    address internal verifier;
    address internal vendor = makeAddr("vendor");
    address internal payout = makeAddr("payout");
    address internal treasury = makeAddr("treasury");
    bytes32 internal serviceId;

    function setUp() public {
        vm.chainId(42431);
        assertGt(address(PATH_USD).code.length, 0, "run with FOUNDRY_PROFILE=tempo (network = tempo)");
        escrow = new FermataEscrow(makeAddr("owner"), treasury, 50);
        agent = vm.addr(AGENT_PK);
        verifier = vm.addr(VERIFIER_PK);
        serviceId = bytes32(abi.encodePacked(bytes20(vendor), bytes12("quote")));
        vm.prank(vendor);
        escrow.registerService(serviceId, payout, address(PATH_USD), PRICE, WINDOW, verifier, PREDICATE, 0, 0);
        // the test contract is pre-funded with pathUSD in Tempo mode; `deal` cannot write precompile storage
        require(PATH_USD.transfer(agent, 1_000e6), "fund agent");
    }

    function _hold(bytes32 callId) internal {
        uint256 deadline = block.timestamp + 600;
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, agent, address(escrow), PRICE, PATH_USD.nonces(agent), deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(AGENT_PK, keccak256(abi.encodePacked("\x19\x01", PATH_USD.DOMAIN_SEPARATOR(), structHash)));
        vm.prank(agent);
        escrow.hold(callId, serviceId, REQUEST, deadline, v, r, s);
    }

    function _verdict(bytes32 callId, uint8 outcome) internal view returns (FermataEscrow.Verdict memory v, bytes memory sig) {
        v = FermataEscrow.Verdict({
            callId: callId,
            serviceId: serviceId,
            requestHash: REQUEST,
            predicateHash: PREDICATE,
            outcome: outcome,
            presentationHash: keccak256(abi.encode("presentation", callId)),
            responseHash: keccak256(abi.encode("response", callId)),
            issuedAt: uint64(block.timestamp)
        });
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(VERIFIER_PK, escrow.verdictDigest(v));
        sig = abi.encodePacked(r, s, vv);
    }

    /// @dev Counts precompile movements of pathUSD whose TransferWithMemo memo equals callId.
    function _memoMovements(Vm.Log[] memory logs, bytes32 callId) internal pure returns (uint256 n) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(PATH_USD)) continue;
            if (logs[i].topics[0] == ITIP20.TransferWithMemo.selector) {
                require(logs[i].topics[3] == callId, "memo != callId");
                require(i > 0 && logs[i - 1].topics[0] == ITIP20.Transfer.selector, "memo without Transfer");
                n++;
            }
        }
    }

    function test_tempo_holdViaPermit_thenDelivered() public {
        bytes32 callId = keccak256("tempo-delivered");
        uint256 agentBefore = PATH_USD.balanceOf(agent);
        vm.recordLogs();
        _hold(callId);
        assertEq(_memoMovements(vm.getRecordedLogs(), callId), 1);
        assertEq(PATH_USD.balanceOf(agent), agentBefore - PRICE);
        assertEq(PATH_USD.balanceOf(address(escrow)), PRICE);

        (FermataEscrow.Verdict memory v, bytes memory sig) = _verdict(callId, 1);
        vm.recordLogs();
        escrow.settle(callId, v, sig);
        assertEq(_memoMovements(vm.getRecordedLogs(), callId), 2);
        assertEq(PATH_USD.balanceOf(payout), PRICE - 50);
        assertEq(PATH_USD.balanceOf(treasury), 50);
        assertEq(PATH_USD.balanceOf(address(escrow)), 0);
    }

    function test_tempo_failedRefund_andTimeout() public {
        bytes32 a = keccak256("tempo-failed");
        bytes32 b = keccak256("tempo-timeout");
        uint256 agentBefore = PATH_USD.balanceOf(agent);
        _hold(a);
        _hold(b);
        (FermataEscrow.Verdict memory v, bytes memory sig) = _verdict(a, 2);
        escrow.settle(a, v, sig);
        vm.warp(block.timestamp + WINDOW + 1);
        vm.recordLogs();
        escrow.claimTimeout(b);
        assertEq(_memoMovements(vm.getRecordedLogs(), b), 1);
        assertEq(PATH_USD.balanceOf(agent), agentBefore);
        assertEq(uint8(escrow.getHold(b).status), uint8(FermataEscrow.Status.TimedOut));
    }

    function test_tempo_frontRunPermit_andApprovePath() public {
        bytes32 callId = keccak256("tempo-frontrun");
        uint256 deadline = block.timestamp + 600;
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, agent, address(escrow), PRICE, uint256(0), deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(AGENT_PK, keccak256(abi.encodePacked("\x19\x01", PATH_USD.DOMAIN_SEPARATOR(), structHash)));
        vm.prank(makeAddr("frontrunner"));
        PATH_USD.permit(agent, address(escrow), PRICE, deadline, v, r, s);
        vm.prank(agent);
        escrow.hold(callId, serviceId, REQUEST, deadline, v, r, s); // precompile permit reverts (used), allowance covers
        assertEq(PATH_USD.balanceOf(address(escrow)), PRICE);

        vm.startPrank(agent);
        require(PATH_USD.approve(address(escrow), PRICE), "approve");
        escrow.hold(keccak256("tempo-approve"), serviceId, REQUEST, 0, 0, 0, 0);
        vm.stopPrank();
        assertEq(PATH_USD.balanceOf(address(escrow)), 2 * PRICE);
    }

    function test_tempo_badPermitBubblesPrecompileError() public {
        vm.prank(agent);
        vm.expectRevert(ITIP20.InvalidSignature.selector);
        escrow.hold(keccak256("tempo-bad"), serviceId, REQUEST, block.timestamp + 60, 27, bytes32(uint256(1)), bytes32(uint256(2)));
    }

    /// @notice A payout that blocks the escrow via a receive policy would silently strand funds in the
    /// ReceivePolicyGuard; the escrow reverts instead, and the hold can still time out to the agent.
    function test_tempo_receivePolicyBlockedPayout_revertsThenTimesOut() public {
        // the hazard: a plain transfer to a blocking receiver succeeds but lands in the guard
        vm.prank(payout);
        REGISTRY.setReceivePolicy(0, 1, address(0)); // reject every sender, accept every token
        uint256 guardBefore = PATH_USD.balanceOf(GUARD);
        require(PATH_USD.transfer(payout, 1), "plain transfer");
        assertEq(PATH_USD.balanceOf(payout), 0, "blocked transfer should not credit the receiver");
        assertEq(PATH_USD.balanceOf(GUARD), guardBefore + 1, "blocked transfer lands in the guard");

        bytes32 callId = keccak256("tempo-blocked");
        _hold(callId);
        (FermataEscrow.Verdict memory v, bytes memory sig) = _verdict(callId, 1);
        vm.expectRevert(
            abi.encodeWithSelector(FermataEscrow.RecipientBlocked.selector, payout, ITIP403Registry.BlockedReason.RECEIVE_POLICY)
        );
        escrow.settle(callId, v, sig);
        assertEq(PATH_USD.balanceOf(address(escrow)), PRICE, "funds stay in escrow");

        uint256 agentBefore = PATH_USD.balanceOf(agent);
        vm.warp(block.timestamp + WINDOW + 1);
        escrow.claimTimeout(callId);
        assertEq(PATH_USD.balanceOf(agent), agentBefore + PRICE);
    }
}
