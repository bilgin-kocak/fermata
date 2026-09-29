// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test, Vm} from "forge-std/Test.sol";
import {ITIP20} from "../src/ITIP20.sol";
import {MockTIP20} from "../src/MockTIP20.sol";
import {PullProbe} from "../src/PullProbe.sol";

contract PullProbeTest is Test {
    MockTIP20 token;
    PullProbe probe;
    uint256 constant AGENT_PK = 0xA11CE;
    address agent;
    bytes32 constant CALL_ID = keccak256("call-1");
    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function setUp() public {
        vm.chainId(42431);
        token = new MockTIP20("pathUSD", "pathUSD");
        probe = new PullProbe();
        agent = vm.addr(AGENT_PK);
        token.mint(agent, 1_000_000e6);
    }

    function permitSig(uint256 value, uint256 nonce, uint256 deadline) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, agent, address(probe), value, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(AGENT_PK, digest);
    }

    function test_pull_emits_TransferWithMemo_with_callId() public {
        uint256 amount = 10_000; // 0.01 pathUSD
        (uint8 v, bytes32 r, bytes32 s) = permitSig(amount, 0, block.timestamp + 60);
        vm.recordLogs();
        probe.pull(ITIP20(address(token)), agent, amount, CALL_ID, block.timestamp + 60, v, r, s);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] == ITIP20.TransferWithMemo.selector) {
                assertEq(logs[i].emitter, address(token));
                assertEq(logs[i].topics[1], bytes32(uint256(uint160(agent))));
                assertEq(logs[i].topics[2], bytes32(uint256(uint160(address(probe)))));
                assertEq(logs[i].topics[3], CALL_ID, "memo topic != callId");
                assertEq(abi.decode(logs[i].data, (uint256)), amount);
                found = true;
            }
        }
        assertTrue(found, "no TransferWithMemo log");
        assertEq(token.balanceOf(address(probe)), amount);
        assertEq(token.nonces(agent), 1);
        assertEq(token.allowance(agent, address(probe)), 0);
    }

    function test_reused_permit_reverts() public {
        uint256 amount = 10_000;
        (uint8 v, bytes32 r, bytes32 s) = permitSig(amount, 0, block.timestamp + 60);
        probe.pull(ITIP20(address(token)), agent, amount, CALL_ID, block.timestamp + 60, v, r, s);
        vm.expectRevert(ITIP20.InvalidSignature.selector);
        probe.pull(ITIP20(address(token)), agent, amount, CALL_ID, block.timestamp + 60, v, r, s);
    }

    function test_bad_v_and_expired_revert() public {
        uint256 amount = 10_000;
        (uint8 v, bytes32 r, bytes32 s) = permitSig(amount, 0, block.timestamp + 60);
        vm.expectRevert(ITIP20.InvalidSignature.selector);
        probe.pull(ITIP20(address(token)), agent, amount, CALL_ID, block.timestamp + 60, v - 27, r, s);
        (v, r, s) = permitSig(amount, 0, block.timestamp - 1);
        vm.expectRevert(ITIP20.PermitExpired.selector);
        probe.pull(ITIP20(address(token)), agent, amount, CALL_ID, block.timestamp - 1, v, r, s);
    }
}
