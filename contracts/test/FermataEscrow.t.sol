// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Test.sol";
import {FermataEscrow} from "../src/FermataEscrow.sol";
import {ITIP20} from "../src/interfaces/ITIP20.sol";
import {MockTIP20} from "./mocks/MockTIP20.sol";
import {ReentrantTIP20, FalseTIP20} from "./mocks/HostileTIP20.sol";
import {EscrowBase} from "./EscrowBase.sol";

contract FermataEscrowTest is EscrowBase {
    bytes32 internal constant CALL = keccak256("call-1");

    // ================================================================================== 1. register

    function test_register_storesServiceAndEmits() public {
        bytes32 id = sid(vendor, "second");
        vm.expectEmit(true, true, true, true, address(escrow));
        emit FermataEscrow.ServiceRegistered(id, vendor, address(token), payout, verifier, 5_000, 60);
        vm.prank(vendor);
        escrow.registerService(id, payout, address(token), 5_000, 60, verifier, PREDICATE, ORIGIN, NOTARY);

        FermataEscrow.Service memory s = escrow.getService(id);
        assertEq(s.owner, vendor);
        assertEq(s.payout, payout);
        assertEq(s.token, address(token));
        assertEq(s.verifier, verifier);
        assertEq(s.pricePerCall, 5_000);
        assertEq(s.settlementWindow, 60);
        assertEq(s.predicateHash, PREDICATE);
        assertEq(s.originHash, ORIGIN);
        assertEq(s.notaryKeyHash, NOTARY);
    }

    function test_register_revertsOnDuplicate() public {
        vm.prank(vendor);
        vm.expectRevert(FermataEscrow.ServiceExists.selector);
        escrow.registerService(serviceId, payout, address(token), PRICE, WINDOW, verifier, PREDICATE, ORIGIN, NOTARY);
    }

    function test_register_revertsOnZeroId() public {
        vm.prank(vendor);
        vm.expectRevert(FermataEscrow.InvalidService.selector);
        escrow.registerService(bytes32(0), payout, address(token), PRICE, WINDOW, verifier, PREDICATE, ORIGIN, NOTARY);
    }

    function test_register_revertsWhenIdNotPrefixedBySender() public {
        address squatter = makeAddr("squatter");
        // squatting the vendor's future id
        vm.prank(squatter);
        vm.expectRevert(FermataEscrow.ServiceIdNotOwned.selector);
        escrow.registerService(
            sid(vendor, "future"), squatter, address(token), PRICE, WINDOW, squatter, PREDICATE, ORIGIN, NOTARY
        );
    }

    function test_register_revertsOnZeroAddresses() public {
        bytes32 id = sid(vendor, "z");
        vm.startPrank(vendor);
        vm.expectRevert(FermataEscrow.ZeroAddress.selector);
        escrow.registerService(id, address(0), address(token), PRICE, WINDOW, verifier, PREDICATE, ORIGIN, NOTARY);
        vm.expectRevert(FermataEscrow.ZeroAddress.selector);
        escrow.registerService(id, payout, address(0), PRICE, WINDOW, verifier, PREDICATE, ORIGIN, NOTARY);
        vm.expectRevert(FermataEscrow.ZeroAddress.selector);
        escrow.registerService(id, payout, address(token), PRICE, WINDOW, address(0), PREDICATE, ORIGIN, NOTARY);
        vm.stopPrank();
    }

    function test_register_revertsOnBadPriceOrWindow() public {
        bytes32 id = sid(vendor, "w");
        vm.startPrank(vendor);
        vm.expectRevert(FermataEscrow.InvalidService.selector);
        escrow.registerService(id, payout, address(token), 0, WINDOW, verifier, PREDICATE, ORIGIN, NOTARY);
        vm.expectRevert(FermataEscrow.InvalidService.selector);
        escrow.registerService(id, payout, address(token), PRICE, 0, verifier, PREDICATE, ORIGIN, NOTARY);
        vm.expectRevert(FermataEscrow.InvalidService.selector);
        escrow.registerService(id, payout, address(token), PRICE, 30 days + 1, verifier, PREDICATE, ORIGIN, NOTARY);
        escrow.registerService(id, payout, address(token), PRICE, 30 days, verifier, PREDICATE, ORIGIN, NOTARY);
        vm.stopPrank();
    }

    function test_register_revertsOnUnpayablePayout() public {
        bytes32 id = sid(vendor, "p");
        address tip20Like = 0x20C0000000000000000000000000000000000001;
        vm.startPrank(vendor);
        vm.expectRevert(abi.encodeWithSelector(FermataEscrow.InvalidRecipient.selector, address(escrow)));
        escrow.registerService(id, address(escrow), address(token), PRICE, WINDOW, verifier, PREDICATE, ORIGIN, NOTARY);
        vm.expectRevert(abi.encodeWithSelector(FermataEscrow.InvalidRecipient.selector, tip20Like));
        escrow.registerService(id, tip20Like, address(token), PRICE, WINDOW, verifier, PREDICATE, ORIGIN, NOTARY);
        vm.stopPrank();
    }

    // ============================================================================= 2. hold via permit

    function test_hold_viaPermit() public {
        uint256 agentBefore = token.balanceOf(agent);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit FermataEscrow.Held(CALL, serviceId, agent, PRICE, REQUEST);
        vm.recordLogs();
        doHold(CALL);
        assertMemoMovements(vm.getRecordedLogs(), address(token), CALL, 1);

        assertEq(token.balanceOf(agent), agentBefore - PRICE);
        assertEq(token.balanceOf(address(escrow)), PRICE);
        assertEq(token.nonces(agent), 1);
        assertEq(token.allowance(agent, address(escrow)), 0);

        FermataEscrow.HoldView memory h = escrow.getHold(CALL);
        assertEq(h.agent, agent);
        assertEq(h.serviceId, serviceId);
        assertEq(h.requestHash, REQUEST);
        assertEq(h.amount, PRICE);
        assertEq(h.heldAt, block.timestamp);
        assertEq(h.deadline, block.timestamp + WINDOW);
        assertEq(h.feeBps, FEE_BPS);
        assertEq(uint8(h.status), uint8(FermataEscrow.Status.Held));
        assertEq(escrow.settlementDeadline(CALL), block.timestamp + WINDOW);
    }

    // =============================================================================== 3. hold edges

    function test_hold_revertsOnUsedCallId() public {
        doHold(CALL);
        uint256 deadline = block.timestamp + 600;
        (uint8 v, bytes32 r, bytes32 s) = permitSig(AGENT_PK, token, address(escrow), PRICE, deadline);
        vm.prank(agent);
        vm.expectRevert(FermataEscrow.CallIdUsed.selector);
        escrow.hold(CALL, serviceId, REQUEST, deadline, v, r, s);
    }

    function test_hold_revertsOnUnknownService() public {
        vm.prank(agent);
        vm.expectRevert(FermataEscrow.UnknownService.selector);
        escrow.hold(CALL, sid(vendor, "nope"), REQUEST, 0, 0, 0, 0);
    }

    function test_hold_revertsOnZeroCallIdOrRequest() public {
        vm.startPrank(agent);
        vm.expectRevert(FermataEscrow.InvalidCall.selector);
        escrow.hold(bytes32(0), serviceId, REQUEST, 0, 0, 0, 0);
        vm.expectRevert(FermataEscrow.InvalidCall.selector);
        escrow.hold(CALL, serviceId, bytes32(0), 0, 0, 0, 0);
        vm.stopPrank();
    }

    function test_hold_thirdPartyCannotUseAgentsPermit() public {
        uint256 deadline = block.timestamp + 600;
        (uint8 v, bytes32 r, bytes32 s) = permitSig(AGENT_PK, token, address(escrow), PRICE, deadline);
        address thief = makeAddr("thief");
        vm.prank(thief);
        // permit(thief, …) fails signature recovery; thief has no allowance → the real error bubbles
        vm.expectRevert(ITIP20.InvalidSignature.selector);
        escrow.hold(CALL, serviceId, REQUEST, deadline, v, r, s);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(token.nonces(agent), 0);
    }

    function test_hold_revertsWhenPermitValueDiffersFromPrice() public {
        uint256 deadline = block.timestamp + 600;
        (uint8 v, bytes32 r, bytes32 s) = permitSig(AGENT_PK, token, address(escrow), PRICE - 1, deadline);
        vm.prank(agent);
        vm.expectRevert(ITIP20.InvalidSignature.selector);
        escrow.hold(CALL, serviceId, REQUEST, deadline, v, r, s);
    }

    function test_hold_revertsOnExpiredPermitWithRealError() public {
        uint256 deadline = block.timestamp - 1;
        (uint8 v, bytes32 r, bytes32 s) = permitSig(AGENT_PK, token, address(escrow), PRICE, deadline);
        vm.prank(agent);
        vm.expectRevert(ITIP20.PermitExpired.selector);
        escrow.hold(CALL, serviceId, REQUEST, deadline, v, r, s);
    }

    function test_hold_succeedsWhenPermitWasFrontRun() public {
        uint256 deadline = block.timestamp + 600;
        (uint8 v, bytes32 r, bytes32 s) = permitSig(AGENT_PK, token, address(escrow), PRICE, deadline);
        // an observer submits the agent's permit first
        vm.prank(makeAddr("frontrunner"));
        token.permit(agent, address(escrow), PRICE, deadline, v, r, s);
        vm.prank(agent);
        escrow.hold(CALL, serviceId, REQUEST, deadline, v, r, s);
        assertEq(uint8(statusOf(CALL)), uint8(FermataEscrow.Status.Held));
        assertEq(token.balanceOf(address(escrow)), PRICE);
    }

    function test_hold_approvePathWithJunkSignature() public {
        // e.g. a passkey account that cannot sign EIP-2612 permits approves instead
        vm.prank(agent);
        token.approve(address(escrow), type(uint256).max);
        vm.prank(agent);
        escrow.hold(CALL, serviceId, REQUEST, 0, 0, bytes32(0), bytes32(0));
        assertEq(token.balanceOf(address(escrow)), PRICE);
        assertEq(token.allowance(agent, address(escrow)), type(uint256).max); // unlimited not decremented
    }

    function test_hold_revertsWithoutPermitOrAllowance() public {
        vm.prank(agent);
        vm.expectRevert(ITIP20.InvalidSignature.selector);
        escrow.hold(CALL, serviceId, REQUEST, block.timestamp + 1, 27, bytes32(uint256(1)), bytes32(uint256(2)));
    }

    // ======================================================================== 4.–6. settle outcomes

    function test_settle_delivered_paysVendorMinusFee() public {
        doHold(CALL);
        FermataEscrow.Verdict memory v = verdict(CALL, 1);
        bytes memory sig = sign(VERIFIER_PK, v);
        uint256 fee = (PRICE * FEE_BPS) / 10_000;

        vm.expectEmit(true, true, true, true, address(escrow));
        emit FermataEscrow.Released(CALL, serviceId, payout, PRICE, fee, v.presentationHash);
        vm.recordLogs();
        vm.prank(relayer);
        escrow.settle(CALL, v, sig);
        assertMemoMovements(vm.getRecordedLogs(), address(token), CALL, 2);

        assertEq(token.balanceOf(payout), PRICE - fee);
        assertEq(token.balanceOf(treasury), fee);
        assertEq(token.balanceOf(address(escrow)), 0);
        FermataEscrow.HoldView memory h = escrow.getHold(CALL);
        assertEq(uint8(h.status), uint8(FermataEscrow.Status.Released));
        assertEq(h.agent, agent);
        // per-call slots cleared (Tempo storage credits); status kept forever
        assertEq(h.serviceId, bytes32(0));
        assertEq(h.requestHash, bytes32(0));
        assertEq(h.amount, 0);
        assertEq(escrow.settlementDeadline(CALL), 0);
    }

    function test_settle_delivered_feeRoundsToZero_singleTransfer() public {
        bytes32 cheap = sid(vendor, "cheap");
        vm.prank(vendor);
        escrow.registerService(cheap, payout, address(token), 199, WINDOW, verifier, PREDICATE, ORIGIN, NOTARY);
        doHoldFor(AGENT_PK, token, cheap, CALL, 199);
        FermataEscrow.Verdict memory v = verdict(CALL, 1);
        v.serviceId = cheap;
        bytes memory sig = sign(VERIFIER_PK, v);
        vm.recordLogs();
        escrow.settle(CALL, v, sig);
        assertMemoMovements(vm.getRecordedLogs(), address(token), CALL, 1);
        assertEq(token.balanceOf(payout), 199);
        assertEq(token.balanceOf(treasury), 0);
    }

    function test_settle_delivered_zeroFee() public {
        vm.prank(owner);
        escrow.setFeeBps(0);
        doHold(CALL);
        vm.recordLogs();
        settleAs(relayer, CALL, 1);
        assertMemoMovements(vm.getRecordedLogs(), address(token), CALL, 1);
        assertEq(token.balanceOf(payout), PRICE);
        assertEq(token.balanceOf(treasury), 0);
    }

    function test_settle_failed_refundsAgentInFull() public {
        uint256 agentBefore = token.balanceOf(agent);
        doHold(CALL);
        FermataEscrow.Verdict memory v = verdict(CALL, 2);
        bytes memory sig = sign(VERIFIER_PK, v);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit FermataEscrow.Refunded(CALL, serviceId, agent, PRICE, v.presentationHash);
        vm.recordLogs();
        escrow.settle(CALL, v, sig);
        assertMemoMovements(vm.getRecordedLogs(), address(token), CALL, 1);
        assertEq(token.balanceOf(agent), agentBefore);
        assertEq(token.balanceOf(treasury), 0);
        assertEq(token.balanceOf(payout), 0);
        assertEq(uint8(statusOf(CALL)), uint8(FermataEscrow.Status.Refunded));
    }

    // ================================================================================ 7. signatures

    function test_settle_revertsOnWrongVerifier() public {
        doHold(CALL);
        FermataEscrow.Verdict memory v = verdict(CALL, 1);
        bytes memory sig = sign(0xBAD, v);
        vm.expectRevert(FermataEscrow.WrongVerifier.selector);
        escrow.settle(CALL, v, sig);
    }

    function test_settle_revertsOnMalformedSignatures() public {
        doHold(CALL);
        FermataEscrow.Verdict memory v = verdict(CALL, 1);
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(VERIFIER_PK, escrow.verdictDigest(v));
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;

        bytes[6] memory bad = [
            abi.encodePacked(bytes32(0), s, vv), // r = 0 → ecrecover(…) == 0
            abi.encodePacked(r, bytes32(n - uint256(s)), vv == 27 ? uint8(28) : uint8(27)), // high-s twin
            abi.encodePacked(r, s, vv - 27), // v ∈ {0,1}
            abi.encodePacked(r, s), // 64 bytes (EIP-2098 not supported)
            abi.encodePacked(r, s, vv, uint8(0)), // 66 bytes
            bytes("")
        ];
        for (uint256 i = 0; i < bad.length; i++) {
            vm.expectRevert(FermataEscrow.InvalidSignature.selector);
            escrow.settle(CALL, v, bad[i]);
        }
    }

    // =================================================================== 8. binding field mismatches

    function test_settle_revertsOnMismatchedFields() public {
        doHold(CALL);
        FermataEscrow.Verdict memory v;

        v = verdict(CALL, 1);
        v.serviceId = sid(vendor, "other");
        _expectSettleRevert(v, FermataEscrow.ServiceMismatch.selector);

        v = verdict(CALL, 1);
        v.requestHash = keccak256("GET /v1/other");
        _expectSettleRevert(v, FermataEscrow.RequestMismatch.selector);

        v = verdict(CALL, 1);
        v.predicateHash = keccak256("weaker-predicate.json");
        _expectSettleRevert(v, FermataEscrow.PredicateMismatch.selector);

        v = verdict(CALL, 1);
        v.callId = keccak256("another-call");
        _expectSettleRevert(v, FermataEscrow.CallIdMismatch.selector);

        v = verdict(CALL, 0);
        _expectSettleRevert(v, FermataEscrow.InvalidOutcome.selector);
        v = verdict(CALL, 3);
        _expectSettleRevert(v, FermataEscrow.InvalidOutcome.selector);

        v = verdict(CALL, 1);
        v.presentationHash = bytes32(0);
        _expectSettleRevert(v, FermataEscrow.InvalidPresentation.selector);

        // nothing moved
        assertEq(uint8(statusOf(CALL)), uint8(FermataEscrow.Status.Held));
        assertEq(token.balanceOf(address(escrow)), PRICE);
    }

    function _expectSettleRevert(FermataEscrow.Verdict memory v, bytes4 err) internal {
        bytes memory sig = sign(VERIFIER_PK, v);
        vm.expectRevert(err);
        escrow.settle(CALL, v, sig);
    }

    // ============================================================================ 9. other domains

    function test_settle_revertsForVerdictSignedForAnotherEscrow() public {
        doHold(CALL);
        FermataEscrow.Verdict memory v = verdict(CALL, 1);
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(VERIFIER_PK, digestFor(makeAddr("otherEscrow"), 42431, v));
        vm.expectRevert(FermataEscrow.WrongVerifier.selector);
        escrow.settle(CALL, v, abi.encodePacked(r, s, vv));
    }

    function test_settle_revertsForVerdictSignedForAnotherChain() public {
        doHold(CALL);
        FermataEscrow.Verdict memory v = verdict(CALL, 1);
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(VERIFIER_PK, digestFor(address(escrow), 4217, v));
        vm.expectRevert(FermataEscrow.WrongVerifier.selector);
        escrow.settle(CALL, v, abi.encodePacked(r, s, vv));
    }

    function test_digestMatchesIndependentImplementation() public view {
        FermataEscrow.Verdict memory v = verdict(CALL, 1);
        assertEq(escrow.verdictDigest(v), digestFor(address(escrow), block.chainid, v));
    }

    // ======================================================================================= 10. replay

    function test_settle_replayReverts() public {
        doHold(CALL);
        FermataEscrow.Verdict memory v = verdict(CALL, 1);
        bytes memory sig = sign(VERIFIER_PK, v);
        escrow.settle(CALL, v, sig);
        vm.expectRevert(FermataEscrow.NotHeld.selector);
        escrow.settle(CALL, v, sig);
        // a finalised callId can never be held again
        uint256 deadline = block.timestamp + 600;
        (uint8 pv, bytes32 pr, bytes32 ps) = permitSig(AGENT_PK, token, address(escrow), PRICE, deadline);
        vm.prank(agent);
        vm.expectRevert(FermataEscrow.CallIdUsed.selector);
        escrow.hold(CALL, serviceId, REQUEST, deadline, pv, pr, ps);
    }

    function test_settleAfterTimeout_andTimeoutAfterSettle_revert() public {
        bytes32 a = callIdOf(1);
        bytes32 b = callIdOf(2);
        doHold(a);
        doHold(b);
        settleAs(relayer, a, 1);
        vm.warp(block.timestamp + WINDOW + 1);
        vm.expectRevert(FermataEscrow.NotHeld.selector);
        escrow.claimTimeout(a);
        escrow.claimTimeout(b);
        FermataEscrow.Verdict memory v = verdict(b, 2);
        bytes memory sig = sign(VERIFIER_PK, v);
        vm.expectRevert(FermataEscrow.NotHeld.selector);
        escrow.settle(b, v, sig);
    }

    function test_unknownCall_reverts() public {
        vm.expectRevert(FermataEscrow.NotHeld.selector);
        escrow.claimTimeout(CALL);
        FermataEscrow.Verdict memory v = verdict(CALL, 1);
        bytes memory sig = sign(VERIFIER_PK, v);
        vm.expectRevert(FermataEscrow.NotHeld.selector);
        escrow.settle(CALL, v, sig);
    }

    // ======================================================================================= 11. window

    function test_settle_atWindowEndSucceeds() public {
        doHold(CALL);
        vm.warp(block.timestamp + WINDOW);
        settleAs(relayer, CALL, 1);
        assertEq(uint8(statusOf(CALL)), uint8(FermataEscrow.Status.Released));
    }

    function test_settle_afterWindowReverts() public {
        doHold(CALL);
        vm.warp(block.timestamp + WINDOW + 1);
        FermataEscrow.Verdict memory v = verdict(CALL, 1);
        bytes memory sig = sign(VERIFIER_PK, v);
        vm.expectRevert(FermataEscrow.WindowClosed.selector);
        escrow.settle(CALL, v, sig);
    }

    function test_timeout_beforeOrAtWindowEndReverts() public {
        doHold(CALL);
        vm.expectRevert(FermataEscrow.WindowOpen.selector);
        escrow.claimTimeout(CALL);
        vm.warp(block.timestamp + WINDOW);
        vm.expectRevert(FermataEscrow.WindowOpen.selector);
        escrow.claimTimeout(CALL);
    }

    function test_timeout_refundsAgent_calledByStranger() public {
        uint256 agentBefore = token.balanceOf(agent);
        doHold(CALL);
        vm.warp(block.timestamp + WINDOW + 1);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit FermataEscrow.Refunded(CALL, serviceId, agent, PRICE, bytes32(0));
        vm.recordLogs();
        vm.prank(makeAddr("stranger"));
        escrow.claimTimeout(CALL);
        assertMemoMovements(vm.getRecordedLogs(), address(token), CALL, 1);
        assertEq(token.balanceOf(agent), agentBefore);
        assertEq(token.balanceOf(treasury), 0);
        assertEq(uint8(statusOf(CALL)), uint8(FermataEscrow.Status.TimedOut));
    }

    // ================================================================================= 12. owner/admin

    function test_constructor_validation() public {
        vm.expectRevert(FermataEscrow.ZeroAddress.selector);
        new FermataEscrow(address(0), treasury, 50);
        vm.expectRevert(FermataEscrow.ZeroAddress.selector);
        new FermataEscrow(owner, address(0), 50);
        vm.expectRevert(FermataEscrow.FeeTooHigh.selector);
        new FermataEscrow(owner, treasury, 501);
        address tip20Like = 0x20C0000000000000000000000000000000000000;
        vm.expectRevert(abi.encodeWithSelector(FermataEscrow.InvalidRecipient.selector, tip20Like));
        new FermataEscrow(owner, tip20Like, 50);
        FermataEscrow e = new FermataEscrow(owner, treasury, 500);
        assertEq(e.owner(), owner);
        assertEq(e.treasury(), treasury);
        assertEq(e.feeBps(), 500);
    }

    function test_admin_onlyOwner() public {
        vm.expectRevert(FermataEscrow.NotOwner.selector);
        escrow.setFeeBps(10);
        vm.expectRevert(FermataEscrow.NotOwner.selector);
        escrow.setTreasury(makeAddr("t2"));
    }

    function test_admin_setters() public {
        vm.startPrank(owner);
        vm.expectRevert(FermataEscrow.FeeTooHigh.selector);
        escrow.setFeeBps(501);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit FermataEscrow.FeeBpsUpdated(500);
        escrow.setFeeBps(500);
        vm.expectRevert(FermataEscrow.ZeroAddress.selector);
        escrow.setTreasury(address(0));
        vm.expectRevert(abi.encodeWithSelector(FermataEscrow.InvalidRecipient.selector, address(escrow)));
        escrow.setTreasury(address(escrow));
        address t2 = makeAddr("t2");
        vm.expectEmit(true, true, true, true, address(escrow));
        emit FermataEscrow.TreasuryUpdated(t2);
        escrow.setTreasury(t2);
        vm.stopPrank();
        assertEq(escrow.treasury(), t2);
        assertEq(escrow.feeBps(), 500);
    }

    function test_feeSnapshot_changeAfterHoldDoesNotApply() public {
        doHold(CALL);
        vm.prank(owner);
        escrow.setFeeBps(500);
        settleAs(relayer, CALL, 1);
        uint256 fee = (PRICE * FEE_BPS) / 10_000; // the 50 bps in force at hold time
        assertEq(token.balanceOf(treasury), fee);
        assertEq(token.balanceOf(payout), PRICE - fee);
        // a new hold uses the new fee
        bytes32 next = callIdOf(7);
        doHold(next);
        assertEq(escrow.getHold(next).feeBps, 500);
    }

    // ============================================================================= 13. hostile tokens

    function test_reentrantToken_cannotDoubleSpend() public {
        ReentrantTIP20 evil = new ReentrantTIP20();
        bytes32 evilService = sid(vendor, "evil");
        vm.prank(vendor);
        escrow.registerService(evilService, payout, address(evil), PRICE, WINDOW, verifier, PREDICATE, ORIGIN, NOTARY);
        evil.mint(agent, 1e9);
        evil.arm(escrow, CALL);

        doHoldFor(AGENT_PK, evil, evilService, CALL, PRICE); // re-enters hold/claimTimeout during the pull
        FermataEscrow.Verdict memory v = verdict(CALL, 2);
        v.serviceId = evilService;
        bytes memory sig = sign(VERIFIER_PK, v);
        escrow.settle(CALL, v, sig); // re-enters during the refund

        assertGt(evil.reentryAttempts(), 0);
        assertEq(evil.reentrySuccesses(), 0);
        assertEq(evil.balanceOf(address(escrow)), 0);
        assertEq(evil.balanceOf(agent), 1e9);
        assertEq(uint8(statusOf(CALL)), uint8(FermataEscrow.Status.Refunded));
    }

    function test_tokenReturningFalse_reverts() public {
        FalseTIP20 f = new FalseTIP20();
        bytes32 fService = sid(vendor, "false");
        vm.prank(vendor);
        escrow.registerService(fService, payout, address(f), PRICE, WINDOW, verifier, PREDICATE, ORIGIN, NOTARY);
        vm.prank(agent);
        f.approve(address(escrow), PRICE);
        vm.prank(agent);
        vm.expectRevert(FermataEscrow.TransferFailed.selector);
        escrow.hold(CALL, fService, REQUEST, 0, 0, 0, 0);
    }

    function test_holdsAcrossServicesAreIsolated() public {
        MockTIP20 other = new MockTIP20("AlphaUSD", "AlphaUSD");
        bytes32 otherService = sid(vendor, "alpha");
        vm.prank(vendor);
        escrow.registerService(otherService, payout, address(other), 7_000, WINDOW, verifier, PREDICATE, ORIGIN, NOTARY);
        other.mint(agent, 1e9);
        doHold(callIdOf(1));
        doHoldFor(AGENT_PK, other, otherService, callIdOf(2), 7_000);
        assertEq(token.balanceOf(address(escrow)), PRICE);
        assertEq(other.balanceOf(address(escrow)), 7_000);
        FermataEscrow.Verdict memory v = verdict(callIdOf(2), 1);
        v.serviceId = otherService;
        bytes memory sig = sign(VERIFIER_PK, v);
        escrow.settle(callIdOf(2), v, sig);
        assertEq(other.balanceOf(address(escrow)), 0);
        assertEq(token.balanceOf(address(escrow)), PRICE); // untouched
    }

    // ======================================================================================= 15. fuzz

    function testFuzz_feeSplitIsExact(uint256 price, uint16 fee) public {
        price = bound(price, 1, 1e18);
        fee = uint16(bound(fee, 0, 500));
        vm.prank(owner);
        escrow.setFeeBps(fee);
        bytes32 svc = sid(vendor, "fuzz");
        vm.prank(vendor);
        escrow.registerService(svc, payout, address(token), price, WINDOW, verifier, PREDICATE, ORIGIN, NOTARY);
        token.mint(agent, price);
        doHoldFor(AGENT_PK, token, svc, CALL, price);
        FermataEscrow.Verdict memory v = verdict(CALL, 1);
        v.serviceId = svc;
        bytes memory sig = sign(VERIFIER_PK, v);
        escrow.settle(CALL, v, sig);
        assertEq(token.balanceOf(payout) + token.balanceOf(treasury), price);
        assertEq(token.balanceOf(treasury), (price * fee) / 10_000);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function testFuzz_foreignSignerNeverSettles(uint256 pk) public {
        pk = bound(pk, 1, 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140);
        vm.assume(pk != VERIFIER_PK);
        doHold(CALL);
        FermataEscrow.Verdict memory v = verdict(CALL, 1);
        bytes memory sig = sign(pk, v);
        vm.expectRevert(FermataEscrow.WrongVerifier.selector);
        escrow.settle(CALL, v, sig);
    }
}
