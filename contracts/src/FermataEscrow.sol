// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ITIP20} from "./interfaces/ITIP20.sol";
import {ITIP403Registry} from "./interfaces/ITIP403Registry.sol";

/// @title FermataEscrow — pay on proof
/// @notice Holds an agent's TIP-20 payment for one API call until a registered verifier signs an
/// EIP-712 verdict about a TLSNotary presentation of the vendor's HTTPS response:
/// `hold → release(proof)` pays the vendor (minus a fee), `hold → refund(proof)` returns the money,
/// and with no verdict inside the settlement window anyone can return the money to the agent.
/// Every token movement uses the `…WithMemo` TIP-20 variant with `memo = callId`, so an accountant can
/// reconcile hold, release and refund from `TransferWithMemo` logs alone.
/// @dev Unaudited hackathon code. No upgradeability. The owner can change the fee (≤ 5 %) and the
/// treasury, never held funds. Services are immutable once registered.
contract FermataEscrow {
    // ------------------------------------------------------------------------------------------ types

    /// @notice Life cycle of a call. Anything but `None` is permanent: a callId is usable once, ever.
    enum Status {
        None,
        Held,
        Released,
        Refunded,
        TimedOut
    }

    /// @notice A vendor's paid endpoint. Immutable once registered (the held amount is read from it).
    struct Service {
        address owner;
        uint32 settlementWindow;
        address payout;
        address token;
        address verifier;
        uint256 pricePerCall;
        bytes32 predicateHash;
        bytes32 originHash;
        bytes32 notaryKeyHash;
    }

    /// @dev Storage record of a hold: 3 slots (a new slot costs 250k gas on Tempo). `serviceId` and
    /// `requestHash` are cleared when the hold is finalised, which mints Tempo storage credits that
    /// refund most of the slot-creation cost of later holds (TIP-1060).
    struct HoldRecord {
        address agent;
        uint40 heldAt;
        uint16 feeBps;
        Status status;
        bytes32 serviceId;
        bytes32 requestHash;
    }

    /// @notice Layout-independent view of a hold. After finalisation only `agent`, `heldAt`, `feeBps`
    /// and `status` remain; the full record lives in the `Held`/`Released`/`Refunded` events.
    struct HoldView {
        address agent;
        bytes32 serviceId;
        bytes32 requestHash;
        uint256 amount;
        uint64 heldAt;
        uint64 deadline;
        uint16 feeBps;
        Status status;
    }

    /// @notice The verifier's decision about one call, signed with EIP-712.
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

    // -------------------------------------------------------------------------------------- constants

    uint8 public constant OUTCOME_DELIVERED = 1;
    uint8 public constant OUTCOME_FAILED = 2;
    uint16 public constant MAX_FEE_BPS = 500;
    uint32 public constant MAX_WINDOW = 30 days;

    bytes32 public constant VERDICT_TYPEHASH = keccak256(
        "Verdict(bytes32 callId,bytes32 serviceId,bytes32 requestHash,bytes32 predicateHash,uint8 outcome,bytes32 presentationHash,bytes32 responseHash,uint64 issuedAt)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("Fermata");
    bytes32 private constant VERSION_HASH = keccak256("1");

    uint256 private constant BPS = 10_000;
    /// @dev secp256k1n / 2: signatures with a higher `s` are malleable twins and are rejected.
    uint256 private constant HALF_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;
    /// @dev Tempo reserves this 12-byte prefix for TIP-20 tokens; transfers to such an address revert.
    bytes12 private constant TIP20_PREFIX = 0x20c000000000000000000000;
    /// @dev Tempo's TIP-403 registry precompile (absent on non-Tempo chains, e.g. plain unit tests).
    address private constant TIP403_REGISTRY = 0x403c000000000000000000000000000000000000;

    // ------------------------------------------------------------------------------------------ state

    address public immutable owner;
    address public treasury;
    uint16 public feeBps;

    mapping(bytes32 serviceId => Service) private _services;
    mapping(bytes32 callId => HoldRecord) private _holds;

    // ----------------------------------------------------------------------------------------- events

    event ServiceRegistered(
        bytes32 indexed serviceId,
        address indexed owner,
        address indexed token,
        address payout,
        address verifier,
        uint256 pricePerCall,
        uint32 settlementWindow
    );
    event Held(
        bytes32 indexed callId, bytes32 indexed serviceId, address indexed agent, uint256 amount, bytes32 requestHash
    );
    event Released(
        bytes32 indexed callId,
        bytes32 indexed serviceId,
        address indexed payout,
        uint256 amount,
        uint256 fee,
        bytes32 presentationHash
    );
    /// @notice Refund of a hold. `presentationHash == 0` means a timeout refund (no verdict).
    event Refunded(
        bytes32 indexed callId,
        bytes32 indexed serviceId,
        address indexed agent,
        uint256 amount,
        bytes32 presentationHash
    );
    event FeeBpsUpdated(uint16 feeBps);
    event TreasuryUpdated(address indexed treasury);

    // ----------------------------------------------------------------------------------------- errors

    error NotOwner();
    error ZeroAddress();
    error InvalidRecipient(address recipient);
    error RecipientBlocked(address recipient, ITIP403Registry.BlockedReason reason);
    error FeeTooHigh();
    error InvalidService();
    error ServiceIdNotOwned();
    error ServiceExists();
    error UnknownService();
    error InvalidCall();
    error CallIdUsed();
    error NotHeld();
    error WindowClosed();
    error WindowOpen();
    error CallIdMismatch();
    error ServiceMismatch();
    error RequestMismatch();
    error PredicateMismatch();
    error InvalidOutcome();
    error InvalidPresentation();
    error InvalidSignature();
    error WrongVerifier();
    error TransferFailed();

    // ------------------------------------------------------------------------------------ constructor

    /// @param owner_ Account allowed to change the fee and the treasury.
    /// @param treasury_ Receives the release fee.
    /// @param feeBps_ Release fee in basis points (≤ MAX_FEE_BPS); never charged on refunds.
    // forge-lint: disable-next-line(missing-zero-check) — _checkRecipient rejects the zero address
    constructor(address owner_, address treasury_, uint16 feeBps_) {
        if (owner_ == address(0)) revert ZeroAddress();
        _checkRecipient(treasury_);
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        owner = owner_;
        treasury = treasury_;
        feeBps = feeBps_;
        emit TreasuryUpdated(treasury_);
        emit FeeBpsUpdated(feeBps_);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // ------------------------------------------------------------------------------------- vendor API

    /// @notice Registers an immutable paid service. `serviceId` must start with the caller's address
    /// (20 bytes) followed by a 12-byte label, so nobody can squat another vendor's id.
    /// @param predicateHash sha256 of the delivery-predicate JSON the verifier enforces.
    /// @param originHash Hash of the upstream origin the proof must be against (checked off-chain).
    /// @param notaryKeyHash Hash of the accepted notary key(s) (checked off-chain).
    function registerService(
        bytes32 serviceId,
        address payoutAddress,
        address token,
        uint256 pricePerCall,
        uint32 settlementWindow,
        address verifier,
        bytes32 predicateHash,
        bytes32 originHash,
        bytes32 notaryKeyHash
    ) external {
        if (serviceId == bytes32(0)) revert InvalidService();
        // forge-lint: disable-next-line(unsafe-typecast) — the first 20 bytes are the owner prefix by design
        if (bytes20(serviceId) != bytes20(msg.sender)) revert ServiceIdNotOwned();
        Service storage svc = _services[serviceId];
        if (svc.token != address(0)) revert ServiceExists();
        if (token == address(0) || verifier == address(0)) revert ZeroAddress();
        _checkRecipient(payoutAddress);
        if (pricePerCall == 0 || settlementWindow == 0 || settlementWindow > MAX_WINDOW) revert InvalidService();

        svc.owner = msg.sender;
        svc.settlementWindow = settlementWindow;
        svc.payout = payoutAddress;
        svc.token = token;
        svc.verifier = verifier;
        svc.pricePerCall = pricePerCall;
        svc.predicateHash = predicateHash;
        svc.originHash = originHash;
        svc.notaryKeyHash = notaryKeyHash;

        emit ServiceRegistered(serviceId, msg.sender, token, payoutAddress, verifier, pricePerCall, settlementWindow);
    }

    // -------------------------------------------------------------------------------------- agent API

    /// @notice Holds `pricePerCall` of the service's token from the caller for one call, in one
    /// transaction: EIP-2612 permit, then `transferFromWithMemo(agent → escrow, price, callId)`.
    /// A permit that fails (front-run, already used, or a passkey account that cannot sign one) is
    /// tolerated when an allowance already covers the price; otherwise its revert reason is bubbled.
    /// @param requestHash sha256(serviceId ‖ METHOD ‖ request-target ‖ sha256(body)).
    /// @param deadline Permit deadline.
    function hold(
        bytes32 callId,
        bytes32 serviceId,
        bytes32 requestHash,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        if (callId == bytes32(0) || requestHash == bytes32(0)) revert InvalidCall();
        HoldRecord storage h = _holds[callId];
        if (h.status != Status.None) revert CallIdUsed();
        Service storage svc = _services[serviceId];
        address token = svc.token;
        if (token == address(0)) revert UnknownService();
        uint256 amount = svc.pricePerCall;

        h.agent = msg.sender;
        // forge-lint: disable-next-line(unsafe-typecast) — uint40 seconds last until the year 36812
        h.heldAt = uint40(block.timestamp);
        h.feeBps = feeBps;
        h.status = Status.Held;
        h.serviceId = serviceId;
        h.requestHash = requestHash;
        emit Held(callId, serviceId, msg.sender, amount, requestHash);

        _pull(ITIP20(token), msg.sender, amount, callId, deadline, v, r, s);
    }

    // ------------------------------------------------------------------------------ settlement (anyone)

    /// @notice Settles a hold with the service verifier's EIP-712 verdict. DELIVERED pays the vendor
    /// (price − fee) and the treasury (fee); FAILED refunds the agent in full. Only valid inside the
    /// settlement window — afterwards the only exit is `claimTimeout`.
    function settle(bytes32 callId, Verdict calldata v, bytes calldata sig) external {
        HoldRecord storage h = _holds[callId];
        if (h.status != Status.Held) revert NotHeld();
        bytes32 serviceId = h.serviceId;
        Service storage svc = _services[serviceId];
        // forge-lint: disable-next-line(block-timestamp) — windows are seconds to days; ~1 s skew is harmless
        if (block.timestamp > uint256(h.heldAt) + svc.settlementWindow) revert WindowClosed();
        _checkVerdict(h, svc, callId, v);
        if (_recover(verdictDigest(v), sig) != svc.verifier) revert WrongVerifier();

        if (v.outcome == OUTCOME_DELIVERED) _release(h, svc, callId, v.presentationHash);
        else _refund(h, svc, callId, Status.Refunded, v.presentationHash);
    }

    /// @notice Refunds the agent when no verdict settled the hold inside its window. Callable by
    /// anyone; the money always goes to the agent. Emits `Refunded` with a zero presentationHash.
    function claimTimeout(bytes32 callId) external {
        HoldRecord storage h = _holds[callId];
        if (h.status != Status.Held) revert NotHeld();
        Service storage svc = _services[h.serviceId];
        // forge-lint: disable-next-line(block-timestamp) — windows are seconds to days; ~1 s skew is harmless
        if (block.timestamp <= uint256(h.heldAt) + svc.settlementWindow) revert WindowOpen();
        _refund(h, svc, callId, Status.TimedOut, bytes32(0));
    }

    // -------------------------------------------------------------------------------------- owner API

    function setFeeBps(uint16 newFeeBps) external onlyOwner {
        if (newFeeBps > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = newFeeBps;
        emit FeeBpsUpdated(newFeeBps);
    }

    // forge-lint: disable-next-line(missing-zero-check) — _checkRecipient rejects the zero address
    function setTreasury(address newTreasury) external onlyOwner {
        _checkRecipient(newTreasury);
        treasury = newTreasury;
        emit TreasuryUpdated(newTreasury);
    }

    // ------------------------------------------------------------------------------------------ views

    function getService(bytes32 serviceId) external view returns (Service memory) {
        return _services[serviceId];
    }

    function getHold(bytes32 callId) external view returns (HoldView memory hv) {
        HoldRecord storage h = _holds[callId];
        hv.agent = h.agent;
        hv.serviceId = h.serviceId;
        hv.requestHash = h.requestHash;
        hv.heldAt = h.heldAt;
        hv.feeBps = h.feeBps;
        hv.status = h.status;
        if (h.status == Status.Held) {
            Service storage svc = _services[h.serviceId];
            hv.amount = svc.pricePerCall;
            hv.deadline = uint64(h.heldAt) + svc.settlementWindow;
        }
    }

    /// @notice Last timestamp at which `settle` is accepted for a held call (0 when not held).
    function settlementDeadline(bytes32 callId) external view returns (uint256) {
        HoldRecord storage h = _holds[callId];
        if (h.status != Status.Held) return 0;
        return uint256(h.heldAt) + _services[h.serviceId].settlementWindow;
    }

    /// @notice EIP-712 domain: name "Fermata", version "1", this chain, this contract.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
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

    /// @notice The digest the verifier signs for `v` on this deployment.
    function verdictDigest(Verdict calldata v) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), hashVerdict(v)));
    }

    // -------------------------------------------------------------------------------------- internals

    function _pull(
        ITIP20 token,
        address agent,
        uint256 amount,
        bytes32 callId,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) private {
        try token.permit(agent, address(this), amount, deadline, v, r, s) {}
        catch (bytes memory reason) {
            if (token.allowance(agent, address(this)) < amount) {
                assembly ("memory-safe") {
                    revert(add(reason, 0x20), mload(reason))
                }
            }
        }
        if (!token.transferFromWithMemo(agent, address(this), amount, callId)) revert TransferFailed();
    }

    function _checkVerdict(HoldRecord storage h, Service storage svc, bytes32 callId, Verdict calldata v) private view {
        if (v.callId != callId) revert CallIdMismatch();
        if (v.serviceId != h.serviceId) revert ServiceMismatch();
        if (v.requestHash != h.requestHash) revert RequestMismatch();
        if (v.predicateHash != svc.predicateHash) revert PredicateMismatch();
        if (v.outcome != OUTCOME_DELIVERED && v.outcome != OUTCOME_FAILED) revert InvalidOutcome();
        if (v.presentationHash == bytes32(0)) revert InvalidPresentation();
    }

    function _release(HoldRecord storage h, Service storage svc, bytes32 callId, bytes32 presentationHash) private {
        bytes32 serviceId = h.serviceId;
        uint256 amount = svc.pricePerCall;
        uint256 fee = (amount * h.feeBps) / BPS;
        address payout = svc.payout;
        ITIP20 token = ITIP20(svc.token);

        h.status = Status.Released;
        _clear(h);
        emit Released(callId, serviceId, payout, amount, fee, presentationHash);

        _send(token, payout, amount - fee, callId);
        if (fee != 0) _send(token, treasury, fee, callId);
    }

    function _refund(
        HoldRecord storage h,
        Service storage svc,
        bytes32 callId,
        Status finalStatus,
        bytes32 presentationHash
    ) private {
        bytes32 serviceId = h.serviceId;
        address agent = h.agent;
        uint256 amount = svc.pricePerCall;
        ITIP20 token = ITIP20(svc.token);

        h.status = finalStatus;
        _clear(h);
        emit Refunded(callId, serviceId, agent, amount, presentationHash);

        _send(token, agent, amount, callId);
    }

    /// @dev Zeroes the two per-call slots; on Tempo each clear mints a storage credit (TIP-1060).
    function _clear(HoldRecord storage h) private {
        delete h.serviceId;
        delete h.requestHash;
    }

    /// @dev On Tempo a transfer to a recipient whose receive policy blocks the sender does not revert:
    /// it lands in the ReceivePolicyGuard, claimable only by this contract. Revert instead, so the
    /// hold stays open (DELIVERED can later time out to the agent; the agent can lift its policy).
    function _send(ITIP20 token, address to, uint256 amount, bytes32 callId) private {
        if (TIP403_REGISTRY.code.length != 0) {
            (bool authorized, ITIP403Registry.BlockedReason reason) =
                ITIP403Registry(TIP403_REGISTRY).validateReceivePolicy(address(token), address(this), to);
            if (!authorized) revert RecipientBlocked(to, reason);
        }
        token.transferWithMemo(to, amount, callId);
    }

    function _recover(bytes32 digest, bytes calldata sig) private pure returns (address signer) {
        if (sig.length != 65) revert InvalidSignature();
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (uint256(s) > HALF_ORDER || (v != 27 && v != 28)) revert InvalidSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
    }

    function _checkRecipient(address recipient) private view {
        if (recipient == address(0)) revert ZeroAddress();
        if (recipient == address(this) || bytes12(bytes20(recipient)) == TIP20_PREFIX) {
            revert InvalidRecipient(recipient);
        }
    }
}
