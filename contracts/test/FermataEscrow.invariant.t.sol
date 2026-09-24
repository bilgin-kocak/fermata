// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {FermataEscrow} from "../src/FermataEscrow.sol";
import {MockTIP20} from "./mocks/MockTIP20.sol";

/// @notice Drives the escrow through random holds, settlements, timeouts, time jumps, fee changes
/// and replay attempts, asserting exact balance deltas on every step and keeping ghost state.
contract EscrowHandler is Test {
    struct Ghost {
        FermataEscrow.Status status;
        address agent;
        bytes32 serviceId;
        bytes32 requestHash;
        MockTIP20 token;
        uint256 price;
        uint16 feeBps;
        uint256 heldAt;
        uint32 window;
    }

    uint256 internal constant VERIFIER_PK = 0xBEEF;
    uint256 internal constant BPS = 10_000;
    bytes32 internal constant PREDICATE = keccak256("predicate.json");
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    FermataEscrow public immutable escrow;
    address public immutable owner = makeAddr("owner");
    address public immutable treasury = makeAddr("treasury");
    address internal immutable relayer = makeAddr("relayer");

    MockTIP20[] public tokens;
    address[] public holders; // every address that can own tokens: agents, payouts, treasury, escrow
    bytes32[] internal services;
    uint256[] internal agentPks;

    bytes32[] public calls; // every callId ever held
    bytes32[] internal open; // callIds currently Held
    mapping(bytes32 callId => Ghost) internal ghost;
    mapping(address token => uint256) public ghostHeld;
    mapping(address token => uint256) public ghostIn;
    mapping(address token => uint256) public ghostOut;

    uint256 public holds;
    uint256 public releases;
    uint256 public refunds;
    uint256 public timeouts;
    uint256 public rejectedReplays;
    uint256 public actions;
    uint256 internal nonce;

    constructor() {
        escrow = new FermataEscrow(owner, treasury, 50);
        tokens.push(new MockTIP20("pathUSD", "pathUSD"));
        tokens.push(new MockTIP20("AlphaUSD", "AlphaUSD"));
        holders.push(address(escrow));
        holders.push(treasury);

        // price 1 and 199 make the fee round to zero at low bps; windows from 30 s to 1 h.
        _register("vendor-a", "quote", tokens[0], 10_000, 60);
        _register("vendor-a", "tiny", tokens[0], 199, 30);
        _register("vendor-b", "bulk", tokens[1], 1_234_567, 120);
        _register("vendor-c", "dust", tokens[1], 1, 3600);

        for (uint256 i = 1; i <= 3; i++) {
            uint256 pk = uint256(keccak256(abi.encode("agent", i)));
            agentPks.push(pk);
            holders.push(vm.addr(pk));
            for (uint256 t = 0; t < tokens.length; t++) {
                tokens[t].mint(vm.addr(pk), 1e15);
            }
        }
    }

    // ------------------------------------------------------------------------------- fuzzed actions

    modifier counted() {
        actions++;
        _;
    }

    function hold(uint256 agentSeed, uint256 serviceSeed) external counted {
        _hold(agentSeed, serviceSeed);
    }

    /// @dev Settles an open call (holding one first if none is open). Outside the window the verdict
    /// must be rejected with WindowClosed.
    function settle(uint256 callSeed, bool delivered) external counted {
        bytes32 callId = _openCall(callSeed);
        Ghost storage g = ghost[callId];
        FermataEscrow.Service memory svc = escrow.getService(g.serviceId);
        (FermataEscrow.Verdict memory v, bytes memory sig) = _verdict(callId, delivered);

        if (block.timestamp > g.heldAt + g.window) {
            try escrow.settle(callId, v, sig) {
                revert("late verdict accepted");
            } catch (bytes memory err) {
                assertEq(bytes4(err), FermataEscrow.WindowClosed.selector, "late settle error");
            }
            return;
        }

        uint256 fee = delivered ? (g.price * g.feeBps) / BPS : 0;
        uint256 payoutBefore = g.token.balanceOf(svc.payout);
        uint256 treasuryBefore = g.token.balanceOf(treasury);
        uint256 agentBefore = g.token.balanceOf(g.agent);

        vm.prank(relayer);
        escrow.settle(callId, v, sig);

        if (delivered) {
            assertEq(g.token.balanceOf(svc.payout), payoutBefore + g.price - fee, "payout delta");
            assertEq(g.token.balanceOf(treasury), treasuryBefore + fee, "fee delta");
            assertEq(g.token.balanceOf(g.agent), agentBefore, "agent paid on release");
            _finalise(callId, FermataEscrow.Status.Released);
            releases++;
        } else {
            assertEq(g.token.balanceOf(g.agent), agentBefore + g.price, "refund delta");
            assertEq(g.token.balanceOf(svc.payout), payoutBefore, "payout paid on refund");
            assertEq(g.token.balanceOf(treasury), treasuryBefore, "fee charged on refund");
            _finalise(callId, FermataEscrow.Status.Refunded);
            refunds++;
        }
    }

    /// @dev Times out an open call: inside the window claimTimeout must fail with WindowOpen, then
    /// time moves past the deadline and anyone can refund the agent.
    function timeout(uint256 callSeed) external counted {
        bytes32 callId = _openCall(callSeed);
        Ghost storage g = ghost[callId];
        uint256 deadline = g.heldAt + g.window;
        if (block.timestamp <= deadline) {
            try escrow.claimTimeout(callId) {
                revert("timeout inside window");
            } catch (bytes memory err) {
                assertEq(bytes4(err), FermataEscrow.WindowOpen.selector, "early timeout error");
            }
            vm.warp(deadline + 1);
        }
        uint256 agentBefore = g.token.balanceOf(g.agent);
        vm.prank(relayer);
        escrow.claimTimeout(callId);
        assertEq(g.token.balanceOf(g.agent), agentBefore + g.price, "timeout refund delta");
        _finalise(callId, FermataEscrow.Status.TimedOut);
        timeouts++;
    }

    function warp(uint256 secs) external counted {
        vm.warp(block.timestamp + _bound(secs, 0, 2 hours));
    }

    function setFeeBps(uint256 bps) external counted {
        vm.prank(owner);
        // forge-lint: disable-next-line(unsafe-typecast) — bounded to [0, 500]
        escrow.setFeeBps(uint16(_bound(bps, 0, 500)));
    }

    /// @dev Any used callId can never be held again; a finalised one can never be settled or timed out.
    function replay(uint256 callSeed) external counted {
        if (calls.length == 0) return;
        bytes32 callId = calls[callSeed % calls.length];
        Ghost storage g = ghost[callId];

        vm.prank(g.agent);
        try escrow.hold(callId, g.serviceId, g.requestHash, block.timestamp, 27, bytes32(0), bytes32(0)) {
            revert("callId reused");
        } catch (bytes memory err) {
            assertEq(bytes4(err), FermataEscrow.CallIdUsed.selector, "reuse error");
        }
        if (g.status == FermataEscrow.Status.Held) return;

        (FermataEscrow.Verdict memory v, bytes memory sig) = _verdict(callId, true);
        try escrow.settle(callId, v, sig) {
            revert("finalised call settled");
        } catch (bytes memory err) {
            assertEq(bytes4(err), FermataEscrow.NotHeld.selector, "replay settle error");
        }
        try escrow.claimTimeout(callId) {
            revert("finalised call timed out");
        } catch (bytes memory err) {
            assertEq(bytes4(err), FermataEscrow.NotHeld.selector, "replay timeout error");
        }
        rejectedReplays++;
    }

    // ------------------------------------------------------------------------------------ views

    function callCount() external view returns (uint256) {
        return calls.length;
    }

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    function holderCount() external view returns (uint256) {
        return holders.length;
    }

    function ghostOf(bytes32 callId) external view returns (Ghost memory) {
        return ghost[callId];
    }

    // -------------------------------------------------------------------------------- internals

    function _register(string memory vendorName, string memory label, MockTIP20 token, uint256 price, uint32 window)
        internal
    {
        address vendor = makeAddr(vendorName);
        address payout = makeAddr(string.concat(vendorName, "-payout-", label));
        bytes32 sid = bytes32(abi.encodePacked(bytes20(vendor), bytes12(bytes(label))));
        vm.prank(vendor);
        escrow.registerService(
            sid, payout, address(token), price, window, vm.addr(VERIFIER_PK), PREDICATE, bytes32(0), bytes32(0)
        );
        services.push(sid);
        holders.push(payout);
    }

    function _hold(uint256 agentSeed, uint256 serviceSeed) internal returns (bytes32 callId) {
        uint256 pk = agentPks[agentSeed % agentPks.length];
        address agent = vm.addr(pk);
        bytes32 sid = services[serviceSeed % services.length];
        FermataEscrow.Service memory svc = escrow.getService(sid);
        MockTIP20 token = MockTIP20(svc.token);

        callId = keccak256(abi.encode("invariant-call", ++nonce));
        bytes32 requestHash = keccak256(abi.encode("request", callId));
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _permit(pk, token, svc.pricePerCall, deadline);
        uint256 agentBefore = token.balanceOf(agent);
        uint256 escrowBefore = token.balanceOf(address(escrow));

        vm.prank(agent);
        escrow.hold(callId, sid, requestHash, deadline, v, r, s);

        assertEq(token.balanceOf(agent), agentBefore - svc.pricePerCall, "hold agent delta");
        assertEq(token.balanceOf(address(escrow)), escrowBefore + svc.pricePerCall, "hold escrow delta");
        ghost[callId] = Ghost({
            status: FermataEscrow.Status.Held,
            agent: agent,
            serviceId: sid,
            requestHash: requestHash,
            token: token,
            price: svc.pricePerCall,
            feeBps: escrow.feeBps(),
            heldAt: block.timestamp,
            window: svc.settlementWindow
        });
        ghostHeld[address(token)] += svc.pricePerCall;
        ghostIn[address(token)] += svc.pricePerCall;
        calls.push(callId);
        open.push(callId);
        holds++;
    }

    function _openCall(uint256 seed) internal returns (bytes32) {
        if (open.length == 0) return _hold(seed, seed >> 128);
        return open[seed % open.length];
    }

    function _finalise(bytes32 callId, FermataEscrow.Status status) internal {
        Ghost storage g = ghost[callId];
        g.status = status;
        ghostHeld[address(g.token)] -= g.price;
        ghostOut[address(g.token)] += g.price;
        for (uint256 i = 0; i < open.length; i++) {
            if (open[i] == callId) {
                open[i] = open[open.length - 1];
                open.pop();
                return;
            }
        }
        revert("finalised call was not open");
    }

    function _verdict(bytes32 callId, bool delivered)
        internal
        view
        returns (FermataEscrow.Verdict memory v, bytes memory sig)
    {
        Ghost storage g = ghost[callId];
        v = FermataEscrow.Verdict({
            callId: callId,
            serviceId: g.serviceId,
            requestHash: g.requestHash,
            predicateHash: PREDICATE,
            outcome: delivered ? 1 : 2,
            presentationHash: keccak256(abi.encode("presentation", callId)),
            responseHash: keccak256(abi.encode("response", callId)),
            issuedAt: uint64(block.timestamp)
        });
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(VERIFIER_PK, escrow.verdictDigest(v));
        sig = abi.encodePacked(r, s, sv);
    }

    function _permit(uint256 pk, MockTIP20 token, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8, bytes32, bytes32)
    {
        address holder = vm.addr(pk);
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, holder, address(escrow), value, token.nonces(holder), deadline));
        return vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)));
    }
}

contract FermataEscrowInvariantTest is Test {
    EscrowHandler internal handler;
    FermataEscrow internal escrow;

    function setUp() public {
        vm.chainId(42431);
        handler = new EscrowHandler();
        escrow = handler.escrow();
        bytes4[] memory selectors = new bytes4[](6);
        selectors[0] = EscrowHandler.hold.selector;
        selectors[1] = EscrowHandler.settle.selector;
        selectors[2] = EscrowHandler.timeout.selector;
        selectors[3] = EscrowHandler.warp.selector;
        selectors[4] = EscrowHandler.setFeeBps.selector;
        selectors[5] = EscrowHandler.replay.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
        targetContract(address(handler));
    }

    /// @notice Per token, the escrow holds exactly the sum of the prices of the calls still Held —
    /// counted both from ghost state and from the escrow's own records.
    function invariant_escrowBalanceEqualsHeld() public view {
        uint256 n = handler.callCount();
        for (uint256 t = 0; t < handler.tokenCount(); t++) {
            MockTIP20 token = handler.tokens(t);
            uint256 heldOnChain;
            for (uint256 i = 0; i < n; i++) {
                FermataEscrow.HoldView memory h = escrow.getHold(handler.calls(i));
                if (h.status == FermataEscrow.Status.Held && escrow.getService(h.serviceId).token == address(token)) {
                    heldOnChain += h.amount;
                }
            }
            assertEq(token.balanceOf(address(escrow)), handler.ghostHeld(address(token)), "escrow != ghost held");
            assertEq(token.balanceOf(address(escrow)), heldOnChain, "escrow != sum of Held records");
        }
    }

    /// @notice Every call's on-chain status equals the ghost status: a final status never changes and
    /// a finalised record keeps no per-call data.
    function invariant_statusesMatchGhost() public view {
        uint256 n = handler.callCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 callId = handler.calls(i);
            EscrowHandler.Ghost memory g = handler.ghostOf(callId);
            FermataEscrow.HoldView memory h = escrow.getHold(callId);
            assertEq(uint8(h.status), uint8(g.status), "status drift");
            assertEq(h.agent, g.agent, "agent drift");
            if (g.status == FermataEscrow.Status.Held) {
                assertEq(h.serviceId, g.serviceId, "serviceId drift");
                assertEq(h.requestHash, g.requestHash, "requestHash drift");
                assertEq(h.amount, g.price, "amount drift");
                assertEq(h.deadline, g.heldAt + g.window, "deadline drift");
                assertEq(h.feeBps, g.feeBps, "fee snapshot drift");
            } else {
                assertEq(h.serviceId, bytes32(0), "serviceId not cleared");
                assertEq(h.requestHash, bytes32(0), "requestHash not cleared");
                assertEq(h.amount, 0, "amount after finalisation");
            }
        }
    }

    /// @notice Money is conserved: everything held is either still held or paid out exactly once, and
    /// no token ever leaves the set of known holders.
    function invariant_conservation() public view {
        for (uint256 t = 0; t < handler.tokenCount(); t++) {
            MockTIP20 token = handler.tokens(t);
            address a = address(token);
            assertEq(handler.ghostIn(a), handler.ghostHeld(a) + handler.ghostOut(a), "held + out != in");
            uint256 sum;
            for (uint256 i = 0; i < handler.holderCount(); i++) {
                sum += token.balanceOf(handler.holders(i));
            }
            assertEq(sum, token.totalSupply(), "tokens escaped the known holders");
        }
    }

    /// @dev Guards against a vacuous campaign. Skipped for short (shrunk or replayed) sequences so a
    /// minimised counterexample reports its real failure.
    function afterInvariant() public view {
        if (handler.actions() < 32) return;
        assertGt(handler.holds(), 0, "no hold happened");
        assertGt(handler.releases() + handler.refunds() + handler.timeouts(), 0, "nothing was finalised");
    }
}
