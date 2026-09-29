# FACTS.md — verified facts about Tempo, MPP and TLSNotary

All facts checked on **2026-09-23** unless stated otherwise. Each row gives the value, the source,
and a verdict against `PROMPT.md`: **CONFIRMS**, **CONTRADICTS** (see §14) or **UNVERIFIED**.

**How the sources were checked.** The build environment (a Claude Code cloud container) blocks
outbound access to `tempo.xyz`, `docs.tempo.xyz`, `explore.tempo.xyz`, `explore.testnet.tempo.xyz`,
`rpc.moderato.tempo.xyz`, `contracts.tempo.xyz`, `mpp.dev`, `tlsnotary.org`, `notary.pse.dev`,
`docs.chainstack.com`, `docs.stripe.com`, `foundry.paradigm.xyz`, `sh.rustup.rs` and
`dl.filippo.io` (HTTP 403 from the egress proxy). Every URL the prompt names is therefore marked
**not fetched (egress blocked 2026-09-23)** and verified from the *public GitHub source of the
same page*, read over `raw.githubusercontent.com` and pinned to a commit. Bilgin is adding the
hosts to the environment's allow-list; rows marked `[live check pending]` are re-run once the
RPC answers. GitHub sources used:

| Site | Source repository (pinned) |
|---|---|
| tempo.xyz/developers, docs.tempo.xyz | `tempoxyz/docs@main` (its `vercel.json` serves both hosts) |
| Tempo node, precompiles, faucet | `tempoxyz/tempo@main`, `tempoxyz/tempo-std@master` |
| viem Tempo support | `wevm/viem@main` (2.56.8) + npm registry |
| Tempo explorer, contract verification | `tempoxyz/tempo-apps@main` |
| Tempo CLI | `tempoxyz/wallet-cli@main` |
| Chainstack tutorial | `chainstack/dev-portal@main` `docs/tempo-tutorial-first-payment-app.mdx` |
| mpp.dev | `tempoxyz/mpp@635b53c` (site source), `tempoxyz/mpp-specs@08e7dd8` (spec) |
| mppx | `wevm/mppx@c1232cce` = tag `mppx@0.11.0` + npm registry |
| tlsnotary.org | `tlsnotary/website@master` (`docs-mdbook` is archived) |
| TLSNotary | `tlsnotary/tlsn@47aee45b` = tag `v0.1.0-alpha.15` (local clone, built here) |

---

## 1. Build environment and tooling

| Fact | Value | Source | Verdict |
|---|---|---|---|
| Machine | 4 vCPU, 15 GB RAM, ~30 GB free disk, Linux x86_64 | `nproc`, `free`, `df` | — |
| Node / pnpm | Node 22.22.2, pnpm 10.33.0 | `node --version` | — |
| Rust | 1.94.1 stable preinstalled; **1.95.0 installed via rustup** (needed by TLSNotary, §12) | `rustup run 1.95.0 rustc -V` | — |
| Foundry | **1.8.3** installed from the GitHub release tarball `foundry_v1.8.3_linux_amd64.tar.gz`. The `stable` tag points at v1.5.1 (older than the 1.7.0 that added Tempo support, §7); `foundryup` host blocked | `git ls-remote --tags foundry-rs/foundry`; `forge --version` | CONTRADICTS (prompt implies default install) |
| Docker | CLI 29.3.1 present, **no daemon** — `docker-compose.yml` can only be validated on Bilgin's machine | `docker info` | — |
| mkcert | not installed, download host blocked → replaced by an OpenSSL script (`scripts/gen-certs.sh`) | `curl dl.filippo.io` → 403 | CONTRADICTS (prompt says mkcert) |
| tempo CLI | not installed (`tempo.xyz/install` blocked); not needed — faucet via RPC (§4) | — | — |
| Node fetch and the proxy | Node's built-in `fetch` ignores `HTTPS_PROXY`; scripts hitting an RPC need `NODE_USE_ENV_PROXY=1` (Node ≥ 22.21) | Node docs; local test | — |
| Cargo git deps and the proxy | `CARGO_NET_GIT_FETCH_WITH_CLI=true` so git-sourced crates fetch through the proxy-aware git CLI | this build | — |

## 2. Tempo / Moderato network

| Fact | Value | Source | Verdict |
|---|---|---|---|
| Chain | payments-first EVM L1 by Stripe/Paradigm; **mainnet (chain 4217) live since 2026-03-18**; Moderato (42431) is the public testnet | `tempoxyz/docs` `src/pages/docs/index.mdx`, `quickstart/connection-details.mdx` — original https://tempo.xyz/developers not fetched (egress blocked 2026-09-23) | CONFIRMS |
| Testnet chain ID | **42431** (`0xa5bf`) | `connection-details.mdx`; viem `src/chains/definitions/tempoModerato.ts`; node `crates/chainspec/src/spec.rs` (`42431 => MODERATO`) | CONFIRMS |
| RPC | `https://rpc.moderato.tempo.xyz` (WebSocket `wss://rpc.moderato.tempo.xyz`) | same | CONFIRMS |
| Live `eth_chainId` | `[live check pending]` — `curl` returned `CONNECT tunnel failed, response 403` on 2026-09-23; expected `0xa5bf` | — | UNVERIFIED |
| **Explorer** | **`https://explore.testnet.tempo.xyz`** for Moderato. `https://explore.tempo.xyz` is the **mainnet** explorer | `connection-details.mdx`; viem `tempoModerato.ts` `blockExplorers`; `tempo-apps/apps/explorer/src/lib/explorer-network.ts` (`testnet → explore.testnet.tempo.xyz`). The `tempoxyz/tempo` README and the Chainstack tutorial still list `explore.tempo.xyz` (out of date) | **CONTRADICTS** (§14.1) |
| Block time / finality | blocks ≈ every 600 ms (consensus page) / "~0.5 s" (EVM page) / viem assumes 1000 ms; deterministic finality, `finalized` block tag; 4 permissioned validators on testnet | `protocol/blockspace/consensus.mdx`, `quickstart/evm-compatibility.mdx` | CONFIRMS ("well under a second") |
| Hardfork / opcodes | targets **Osaka**; all opcodes supported; all Ethereum JSON-RPC methods work | `evm-compatibility.mdx` | — |

## 3. Fees and the fee token

| Fact | Value | Source | Verdict |
|---|---|---|---|
| No native gas token | "Tempo has no native token. Transaction fees are paid directly in USD-denominated stablecoins." Only TIP-20 tokens with `currency == "USD"` can pay fees | `protocol/fees/spec-fee.mdx` | CONFIRMS |
| Fee separate from amount | "the full amount of the token will be transferred **and** the sender's balance will be reduced by the amount spent in fees." Max fee (`gas_limit × gas_price`) is reserved before execution, unused part refunded; the fee token emits an extra `Transfer(payer → 0xfeec…0000, actualFee)` in the same receipt | `evm-compatibility.mdx`, `spec-fee.mdx` | CONFIRMS |
| Fee token selection (first match wins) | 1. `fee_token` field of a Tempo tx (type 0x76); 2. account preference via **`setUserToken(address)`** on the FeeManager `0xfeec000000000000000000000000000000000000` (read with `userTokens(address)`) — **there is no `setFeeToken`**; 3. the TIP-20 being called, only when the top-level call is `transfer`, `transferWithMemo` or `startReward`; 4. `tokenIn` of a DEX swap; 5. **pathUSD** (node `DEFAULT_FEE_TOKEN = PATH_USD_ADDRESS`) | `guide/payments/pay-fees-in-any-stablecoin.mdx`, `spec-fee.mdx`, node `crates/revm/src/handler.rs` | CONTRADICTS the name only (§14.10) |
| Contracts | "If the user is calling a contract that is not a TIP-20 token, the EVM transaction will default to the pathUSD token." "The fee token for a given transaction cannot be set from Solidity." → the escrow's `hold`/`settle` callers pay fees in their preferred token or pathUSD | same | — |
| Moderato validators' preferred fee token | AlphaUSD; other tokens are swapped through the Fee AMM at a fixed 0.9970 rate (0.3% cost). We keep pathUSD as the escrow currency; the fee-AMM cost is negligible for the demo | `spec-fee.mdx`; explorer `fee-token.ts` | — |
| viem default | none: viem attaches `feeToken` only if set per call, per chain (`tempoModerato.extend({ feeToken })`) or per client; without it a secp256k1 account sends a plain EIP-1559 tx and the ladder above applies. Helpers `Actions.fee.setUserToken/getUserToken`; Foundry `--tempo.fee-token` | viem `src/tempo/actions/fee.ts`, `Client.ts` | CONFIRMS ("let viem/tempo handle the default") |
| Units | gas prices in attodollars; fee = `ceil(base_fee × gas_used / 1e12)` microdollars; a TIP-20 transfer ≈ $0.0006 at the base-fee cap, ≈ $0.00003 at the floor | `spec-fee.mdx` | — |

## 4. Faucet and CLI

| Fact | Value | Source | Verdict |
|---|---|---|---|
| `tempo_fundAddress` | RPC method, **params `[address]` only**, returns an **array of tx hashes** (one `mint` per configured token); amount/tokens are node flags (`--faucet.amount`, `--faucet.address`). Docs table: 1M each of pathUSD, AlphaUSD, BetaUSD, ThetaUSD | node `crates/faucet/src/faucet.rs` (`fn fund_address(&self, address: Address) -> RpcResult<Vec<B256>>`), `crates/faucet/src/args.rs`; `quickstart/faucet.mdx` | CONFIRMS |
| Other faucet routes | `POST https://tempo.xyz/developers/api/faucet {"address": "<lowercase>"}`; viem `Actions.faucet.fund/fundSync(client, { account })` | `faucet.mdx`; viem `src/tempo/actions/faucet.ts` | — |
| CLI install | `curl -fsSL https://tempo.xyz/install \| bash`, update with `tempoup`; commands `wallet login/whoami/keys/fund/transfer/services/sessions`, `request` (paid HTTP via MPP), `node` | `cli/index.mdx`, `cli/wallet.mdx` — original https://tempo.xyz/developers/docs/cli not fetched (egress blocked) | CONFIRMS |
| **`tempo wallet fund`** | opens `https://wallet.tempo.xyz/agent?action=fund` in a browser and waits for the balance to rise; **defaults to mainnet** (`--network testnet`/`moderato` alias); it does not call `tempo_fundAddress`. Scripts: `cast rpc tempo_fundAddress <addr> --rpc-url https://rpc.moderato.tempo.xyz` | `tempoxyz/wallet-cli` `README.md`, `src/commands/fund.ts`, `src/shared/network.ts` | CONTRADICTS (§14.11) |

## 5. TIP-20 (exact signatures)

Five sources agree byte for byte: docs `protocol/tip20/spec.mdx` (original
https://docs.tempo.xyz/protocol/tip20/spec not fetched, egress blocked), `tempoxyz/tempo` `tips/tip-1004.md`,
the precompile `crates/precompiles/src/tip20/mod.rs`, viem `src/tempo/Abis.ts`, and
`tempoxyz/tempo-std` `src/interfaces/ITIP20.sol`.

```solidity
function transferWithMemo(address to, uint256 amount, bytes32 memo) external;              // returns NOTHING
function transferFromWithMemo(address from, address to, uint256 amount, bytes32 memo) external returns (bool);
function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external;
event Transfer(address indexed from, address indexed to, uint256 amount);
event TransferWithMemo(address indexed from, address indexed to, uint256 amount, bytes32 indexed memo);
```

| Fact | Value | Verdict |
|---|---|---|
| Standard | ERC-20 + memos + TIP-403 transfer policies; `decimals()` always 6; tokens are precompiles, not bytecode; memo is a fixed `bytes32` | CONFIRMS |
| `transferWithMemo` return | **none** — a Solidity interface declaring `returns (bool)` reverts decoding empty return data | CONTRADICTS (§14.2) |
| Event parameter name | `amount`, not `value` (the prompt writes `value`); `from`, `to`, `memo` indexed; topic hash unchanged, viem decodes `args.amount` | CONTRADICTS (§14.2) |
| Permit | standard EIP-2612: domain `EIP712Domain(name, version, chainId, verifyingContract)` = (`name()`, `"1"`, `block.chainid`, token address); standard `Permit(...)` typehash. **v must be 27 or 28** (0/1 not normalised); ecrecover only (no ERC-1271, no passkey signatures); **no `eip712Domain()` getter**; works while paused, skips TIP-403; live since T2 (testnet 2026-03-26). viem has no permit action helper | CONFIRMS |
| Token `name()` | genesis sets `name == symbol` for the testnet tokens (e.g. `"pathUSD"`); read `name()` on-chain before signing a permit | — |
| Contracts calling `transferFromWithMemo` | no caller-type restriction. Checks: not paused; recipient not zero and not a TIP-20 address (`InvalidRecipient`); TIP-403 policy allows `from` and `to`; allowance; since T6 (testnet 2026-06-18) the recipient's receive policy | — |
| Receive policies (T6) | a transfer blocked by a receive policy **still succeeds** but credits `ReceivePolicyGuard` at `0xB10C000000000000000000000000000000000000` — confirm the `Transfer` recipient. Genesis tokens start at `transferPolicyId = 1` (always allow), unpaused; "If an address has no receive policy, all transfers and mints are allowed" | — |
| Strict calldata (T11, testnet 2026-09-09) | precompile calls must use exact ABI encoding; trailing bytes are rejected until T12 | — |

## 6. Testnet stablecoins

| Token | Address | Source | Verdict |
|---|---|---|---|
| pathUSD (default currency) | `0x20c0000000000000000000000000000000000000` | `quickstart/faucet.mdx`; explorer "genesis tip20 tokens"; node genesis (`xtask/src/genesis_args.rs`) | CONFIRMS |
| AlphaUSD | `0x20c0000000000000000000000000000000000001` | same | CONFIRMS |
| BetaUSD | `0x20c0000000000000000000000000000000000002` | same | CONFIRMS |
| ThetaUSD | `0x20c0000000000000000000000000000000000003` | same | CONFIRMS |

All 6 decimals. The prompt's "same addresses on testnet and mainnet" comes from Chainstack and is
not backed by Tempo's sources (mainnet tooling uses pathUSD and USDC.e); irrelevant for testnet-only.

## 7. viem, Foundry and EVM differences

| Fact | Value | Source | Verdict |
|---|---|---|---|
| viem Tempo module | `import { Actions, Abis } from 'viem/tempo'` works; also `Account`, `Addresses`, `Chain`, `createClient`, `tempoActions`, `withFeePayer`. viem latest **2.56.8** (2026-09-18); first Tempo support 2.43.0, Moderato 2.44.0 (`tempoTestnet` → `tempoModerato`), `permit` in `Abis.tip20` from 2.47.10, `createClient` 2.53.1, balance `Amount` objects 2.54.0. Docs build on `^2.54.6` | viem `src/tempo/index.ts`, `src/CHANGELOG.md`; npm | CONFIRMS |
| `Actions.token.transferSync` | `(client, { token, to, amount, memo?, from?, feeToken? })`; with `memo` calls `transferWithMemo`, with `from` too `transferFromWithMemo`; a memo shorter than 32 bytes is **left-padded**; returns `{ from, to, amount, receipt }` | viem `src/tempo/actions/token.ts` | CONFIRMS |
| ABIs | `Abis.tip20` exists; **`Abis.TIP20` does not** (the memo guide has that typo, plus `log.args.value` instead of `amount`) | viem `src/tempo/Abis.ts` | CONFIRMS |
| Chains | `import { tempoModerato } from 'viem/chains'` (alias `tempoTestnet`); mainnet `tempo`/`tempoMainnet`. `createClient({ account, testnet: true })` from `viem/tempo` — **defaults to mainnet without `testnet`/`chain`** | viem `src/chains/definitions/tempoModerato.ts`, `src/tempo/Client.ts` | — |
| Memo padding across tools | viem left-pads (`pad(stringToHex(x))`); `toHex(x, { size: 32 })`, ethers, cast, Python/Go examples right-pad. Fermata memos are full 32-byte `callId` hashes, so no ambiguity | viem `src/utils/data/pad.ts`; docs `transfer-memos.mdx` — original https://docs.tempo.xyz/guide/payments/transfer-memos not fetched (egress blocked) | — |
| EVM differences | no ETH: `BALANCE`, `SELFBALANCE`, `CALLVALUE` return 0; non-zero `value` is rejected (`ValueTransferNotAllowed`); `eth_getBalance` returns a placeholder constant. **New storage slot 250,000 gas; new account 250,000; code 1,000 gas/byte; deployments 5–10× Ethereum**; first transfer to a new address ≈ 300k gas. EOAs may be auto-delegated (EIP-7702) to a default account at `0x7702c0…`, so `code.length == 0` does not identify EOAs | `quickstart/evm-compatibility.mdx`; `protocol/transactions/eip-7702.mdx`; repo script `scripts/auto-7702-delegation.sh` (partly verified) | — |
| Tempo transaction type | EIP-2718 type `0x76`: batched `calls`, `fee_token`, fee sponsorship (0x78 domain), parallel/expiring nonces, access keys (`0xAAAAAAAA…`), passkey signatures. Legacy and EIP-1559 txs still work | `protocol/transactions/spec-tempo-transaction.mdx` | — |
| EIP-712 / EIP-2612 / ecrecover | unchanged for secp256k1 accounts; permit uses ecrecover with `block.chainid = 42431`. Passkey signatures verify via the SignatureVerifier precompile `0x5165300000000000000000000000000000000000` | `sdk/foundry/signature-verifier.mdx` | CONFIRMS |
| **Anvil Tempo emulation** (spike finding) | `anvil --chain-id 42431` selects Foundry's built-in `tempo` network config: TIP-20 precompiles are live (`0x20c0…0000` answers `name()="PathUSD"`, `decimals()=6`, `DOMAIN_SEPARATOR()`, `nonces()`, `permit`, `transferWithMemo` emitting `TransferWithMemo`), dev accounts are pre-funded with max balances, fees are deducted in a stablecoin (`Transfer(payer → 0xfeec…0000)` in the receipt; default fee token for dev accounts = AlphaUSD via `userTokens`), `tempo_fundAddress` is not served, `--hardfork` is rejected ("conflicts with network config tempo"). So contract tests can run against real TIP-20 semantics locally; economics numbers still come from Moderato | `spikes/tip20/run.sh`, `spikes/proof-path/run.sh` (2026-09-23) | — |
| Foundry | upstream Foundry supports Tempo from **v1.7.0 (2026-04-28)**; `forge create/script --broadcast --verify` work against Moderato with `--rpc-url https://rpc.moderato.tempo.xyz`; `--tempo.fee-token` optional (a deploy is not a TIP-20 call → pathUSD); deploy with the main key ("Access keys can sign calls but not deployments"); batches: value 0, one creation max. Foundry's support is tx sending; **Anvil does not emulate fee tokens or the Tempo gas schedule** | `sdk/foundry/index.mdx`; Foundry v1.7.0 release notes | — |

## 8. Explorer and contract verification

| Fact | Value | Source |
|---|---|---|
| Explorer | custom app (`tempo-apps/apps/explorer`, Cloudflare Workers, reads Tempo's `tidx` indexer); not Blockscout; no Etherscan-style API documented | `tempo-apps` source |
| Verification | `https://contracts.tempo.xyz`, a Tempo-built Sourcify-compatible service: `POST /v2/verify/{chainId}/{address}`, `GET /v2/contract/{chainId}/{address}`, chains 4217/42431/31318. Foundry: `--verifier sourcify --verifier-url https://contracts.tempo.xyz` | `quickstart/verify-contracts.mdx`; `tempo-apps/apps/contract-verification/README.md` |
| Data API | `GET https://api.tempo.xyz/v1/indexer/query?sql=…` (low-volume public, MPP pay-per-request, or API key) | `api/indexer-api.mdx` |

## 9. MPP (Machine Payments Protocol) — the spec

Sources: `tempoxyz/mpp-specs@08e7dd8` `specs/core/draft-httpauth-payment-01.md` (the IETF draft
`draft-ryan-httpauth-payment`), `specs/intents/*`, `specs/methods/*`, `specs/extensions/draft-payment-discovery-01.md`;
site source `tempoxyz/mpp@635b53c`. Originals https://mpp.dev and https://docs.stripe.com/payments/machine/mpp/quickstart
not fetched (egress blocked 2026-09-23).

| Fact | Value | Verdict |
|---|---|---|
| Authors | co-authored by Tempo (Ryan, Moxey, Meagher) and Stripe (Weinstein, Kaliski) | CONFIRMS |
| Flow | client requests → `402 Payment Required` with `WWW-Authenticate: Payment …` → client pays → retries with `Authorization: Payment …` (or `Payment-Authorization` when the challenge sets `header`) → server verifies, returns the resource + `Payment-Receipt` (SHOULD on 2xx, never on errors) | CONFIRMS |
| Challenge encoding | HTTP auth-params (quoted strings), **not** a base64url blob; only `request` and `opaque` are base64url(JCS-canonical JSON, no padding). Required: `id`, `realm`, `method`, `intent`, `request`; optional `digest`, `expires`, `description`, `header`, `opaque`; unknown params ignored. `id = base64url(HMAC-SHA256(secret, "realm\|method\|intent\|request\|expires\|digest\|opaque"))` (test vectors in the spec) | — |
| Credential encoding | `Payment <base64url(JSON {challenge, payload, source?})>`, no padding | — |
| Errors | RFC 9457 problem details, `type = https://paymentauth.org/problems/{code}`: `payment-required`, `payment-insufficient`, `payment-expired`, `verification-failed`, `method-unsupported`, `malformed-credential`, `invalid-challenge`, `bad-request`, `invalid-payload`, `internal-payment-error`, `payment-action-required` | — |
| **Intents** | formal intent specs: **`charge`** and **`subscription`** only. `session` is registered by method specs (tempo, hedera, lightning, xrpl). `authorize` is not defined anywhere (appears only in an example). mppx `Constants.Intents` = charge, session, subscription | CONTRADICTS (§14.6) |
| Methods | 11 in mpp-specs: card, evm, hedera, lightning, nearintents, solana, stellar, stripe, tempo, usdc, xrpl. mpp.dev also lists monad, redotpay and a "Custom" card. **Namespace is open**: identifier grammar `1*LOWERALPHA`; registry policy "Specification Required"; third parties publish methods (Circle `usdc`, Lightspark `lightning`) → `fermata` is a legal method name | CONFIRMS |
| Multiple challenges | "Servers MAY return multiple Payment challenges in a single 402 response"; clients SHOULD pick one they support and MUST send exactly one credential; `Accept-Payment: method/intent;q=` states preferences; the 402 stays authoritative | CONFIRMS (fallback design works) |
| Receipt | `Payment-Receipt = base64url(JSON {status:"success", method, timestamp, reference, …})`; methods may add fields; **no signature** | — |
| Discovery | optional `GET /openapi.json` with `x-service-info` and per-operation `x-payment-info` (`intent`, `method`, `amount`, …); every paid operation declares a 402; **no `.well-known`** | — |
| Stripe method | `stripe.create({ client, networkId, livemode })`: test mode = pathUSD on Tempo testnet, live = USDC.e on mainnet; the switch is the `livemode` you pass, not detected. Not needed for v1 | CONFIRMS (with nuance) |

## 10. mppx SDK and how to add a custom method

Source: `wevm/mppx` at tag `mppx@0.11.0` = commit `c1232cce1a01b59394c67a48a23d9f688756a005`
(published to npm **2026-09-23T00:09Z**; previous 0.10.1 on 2026-09-15; mpp.dev pins 0.10.1).
Local clone in the scratchpad; file paths below are relative to `src/`.

| Fact | Value / location |
|---|---|
| Exports | `mppx`: `Method, Challenge, Credential, Receipt, Errors, Store, Constants, PaymentRequest, z, evm, x402, Mcp`. `mppx/server`: `Mppx, tempo, stripe, evm, NodeListener, Transport, Store, Expires`. `mppx/client`: `Mppx, tempo, stripe, evm, Fetch, Transport, session…`. Also `mppx/hono`, `mppx/discovery`, `mppx/validation`, `mppx/cli`, `mppx/tempo` (35 export paths) |
| README snippets | server `Mppx.create({ methods: [tempo({ currency, recipient })], secretKey })`, `mppx.charge({ amount: '1' })(request)`, `response.status === 402 → response.challenge`, `response.withReceipt(Response.json(…))` — all as in the prompt. `secretKey` ≥ 32 bytes or `create` throws; `amount` is in human units; **`tempo({ … })` without `testnet: true` targets MAINNET** (chain 4217) — pass `testnet: true` |
| Method type (`Method.ts`) | `Method = { name: string; intent: string; schema: { request: ZodMiniType; credential: { payload: ZodMiniType } }; html? }`. **`name` is an open string** (parser accepts `^[a-z][a-z0-9:_-]*$`, `Challenge.ts`) |
| Server method (`Method.toServer`) | `validate({ credential, request })` (stateless, returns the validated context) + `broadcast({ credential, request })` (performs/settles and **returns the `Receipt`**), or the deprecated single `verify`. Optional hooks: `request` (enriches the request; runs on the 402 and on the paid retry), `respond`, `authorize`, `preflight`, `canOffer`, `onPaymentSuccess`, **`stableBinding`** (which request fields must match between the issued challenge and the route; default compares `amount`, `currency`, `recipient`, `methodDetails.{chainId, memo, …}`), `defaults`, `alias`, `extensions`, `transport` |
| Client method (`Method.toClient`) | `createCredential({ challenge, context }) → Promise<string>` does the payment itself and returns `Credential.serialize({ challenge, payload, source? })`; optional `canHandleChallenge`, zod `context` |
| Registration (`server/Mppx.ts` ~574–630) | `Mppx.create({ methods })` flattens the list, keys handlers by `name/intent`; each method gets `mppx['fermata/charge']`, `mppx.fermata.charge`, `mppx.challenge.fermata.charge`; the bare `mppx.charge` is the single handler or, with several charge methods, an implicit compose that passes the **same options object to every method**. Use `mppx.compose(['tempo/charge', {…}], ['fermata/charge', {…}])` for per-method options. Combined 402s carry one `WWW-Authenticate` value per method, ordered by `Accept-Payment` |
| Generic pipeline (per credential) | HMAC id check → stable-binding check → `expires` (default 5 min) → payload schema → `validate` → `broadcast`/`verify` → `respond` hook → `payment.success` event → `withReceipt`. **Anything thrown that is not a `PaymentError` becomes HTTP 500 `internal-payment-error`**; throw `Errors.VerificationFailedError({ reason })` for a 402 |
| Replay | the core does not track challenge-id reuse (HMAC is stateless); the tempo method claims the **tx hash** with `Store.tryClaim(store, key, expiresMs)` (`Store.ts`, `Store.memory()`); a `fermata` method must claim `callId` itself (the escrow also refuses a duplicate `callId`) |
| Receipt emission (`server/Transport.ts` `respondReceipt`) | `withReceipt(response)` builds a **new `Response`** copying the handler's headers and `set`s `Payment-Receipt: Receipt.serialize(receipt)` (+ `Cache-Control: private`). The receipt object comes from `broadcast`, i.e. **before** the route handler runs. To emit `callId/txHash/presentationHash/outcome` after settlement, the gateway overwrites `Payment-Receipt` on the returned `Response` with `Receipt.serialize({...})` (`Receipt.Schema` is a loose object; extra fields survive `serialize`) |
| Tempo method internals | server `tempo/server/Charge.ts`: `validate` resolves the credential (`{type:'hash'}` push, `{type:'transaction'}` pull, `{type:'proof'}` zero-amount), `broadcast` sends/awaits the tx, `assertTransferLogs` + `assertChallengeBoundMemo`, returns `{ method:'tempo', status:'success', timestamp, reference: txHash }`. Client `tempo/client/Charge.ts`: builds `Actions.token.transfer.call(...)` calls with an **attribution memo** (`tempo/Attribution.ts`: `keccak("mpp")[0..3] ‖ 0x01 ‖ keccak(realm)[0..9] ‖ keccak(clientId)[0..9] ‖ keccak(challengeId)[0..6]`), `prepareTransactionRequest` with `nonceKey: 'expiring'`, signs, returns the credential. 0.11.0 forbids server-supplied memos (`memo: z.optional(z.never())`) — **the tempo memo is not the challenge id** |
| Client selection (`internal/AcceptPayment.ts`) | keeps challenges whose `method/intent` matches a configured client method (and `canHandleChallenge`), drops q=0, sorts MPP before x402, then q, then server order; sends one credential; retries up to 3 times |
| Custom method without a fork | **Confirmed**: mppx's own tests define `mock`/`alpha`/`custom` methods via public imports (`server/Mppx.test.ts`); mpp.dev's "Custom payment methods" guide (`tempoxyz/mpp` `src/pages/payment-methods/custom.mdx`) uses `Method.from/toClient/toServer` and packages a method as an npm module with `mppx` as peer dependency; `@buildonspark/lightning-mpp-sdk` does exactly that. **No fork needed** |

## 11. mppx validator (`npx mppx@latest validate <url>`)

| Fact | Value (source `src/cli/validate/*`, `src/validation/core.ts`) |
|---|---|
| Exists | `bin: mppx → dist/bin.js`; `Cli.create('validate', …)` in `cli/validate/index.ts`; options `--endpoint METHOD:path`, `--body`, `--query`, `--header`, `-v`, `--yes`, `--outputJson` |
| Phases | discovery (`/llms.txt` suggested; **`/openapi.json` effectively required** — missing → "Document found" fails → exit 1), challenge format (402, `Payment ` scheme, `id`/`realm`/`expires`; method-specific field checks only for tempo/stripe/evm), error handling (garbage credential → expect 402 with a fresh challenge; 500 = fail), payment |
| Payment phase | auto-pays a **Tempo testnet** challenge with a fresh faucet-funded wallet (needs the Moderato RPC); then checks `Payment-Receipt`, `status: "success"`, reference format, timestamp, body, `Content-Type` |
| **Custom methods** | `supportedPaymentMethods = {tempo, evm, stripe}`; any other method's challenge is **silently skipped** in the payment phase (no pass/fail line), even if configured in `mppx.config` (`cli/validate/payment.ts` ~262–270). Expect: fermata challenge passes the generic checks, payment tested only via the tempo fallback |
| Quirks | switches to JSON mode automatically when `CLAUDECODE` or `CODEX*` env vars are set (`cli/utils.ts`) |
| Observed (spike, 2026-09-23) | against the probe-2 server: "Challenge parseable (2 methods: tempo/charge, probe/charge)", tempo field checks pass, `probe` gets no payment attempt, "Payment: auto-provision wallet (Failed to create and fund testnet wallet)" while the RPC is blocked; `--endpoint` skips discovery; warnings for a realm ≠ hostname and a missing `llms.txt`/`requestBody` (both fixable server-side). Summary "15 passed, 1 failed" |

## 12. TLSNotary

### 12.1 Release evidence

```
$ git ls-remote --tags https://github.com/tlsnotary/tlsn | grep -v '\^{}' | sed 's|.*refs/tags/||' | sort -V | tail -3
v0.1.0-alpha.13
v0.1.0-alpha.14
v0.1.0-alpha.15
$ git ls-remote https://github.com/tlsnotary/tlsn refs/tags/v0.1.0-alpha.15
47aee45b53e06648c1b2ad3689b367b8c923fdec	refs/tags/v0.1.0-alpha.15
```

| Fact | Value | Source | Verdict |
|---|---|---|---|
| Latest tag | **`v0.1.0-alpha.15`**, commit `47aee45b…`, released 2026-05-21 (pre-release, as all tlsn releases). `main` is `0.1.0-alpha.16-pre` with a TLS-crate reorganisation; README: "For evaluation, we recommend using tagged releases rather than the latest `main`" | `git ls-remote`; GitHub releases atom feed; `README.md` at the tag | CONFIRMS |
| Same pin as WebProof | WebProof (`bilgin-kocak/webproof-solana`) pins the identical commit (`docs/tlsnotary-version.md`) | — | — |
| crates.io | **nothing published** (`cargo info tlsn` → "could not find"; issue tlsnotary/tlsn#1108 open). Consume as git dependencies pinned to the tag; transitive git deps: `privacy-ethereum/mpz` `v0.1.0-alpha.6`, `tlsnotary/tlsn-utils` `64722f7`, `tlsnotary/rs-merkle` `85f3e82` | `Cargo.toml` at the tag (workspace deps) | CONTRADICTS (§14.4) |
| Crates | `tlsn` (re-exports `tlsn_attestation as attestation`, `tlsn_core::{config, connection, hash, transcript, webpki}`), `tlsn-core`, `tlsn-attestation`, `tlsn-formats` (HTTP/JSON parsing, not re-exported), `tlsn-tls-client/core`, `tlsn-mpc-tls`, `tlsn-sdk-core`, `tlsn-wasm`; fixtures `tlsn-server-fixture`, `tlsn-server-fixture-certs`, `tls-server-fixture`; `tlsn-examples` (`publish = false`). **`tlsn-prover`, `tlsn-verifier`, `notary-server`, `notary-client` no longer exist** (removed in alpha.13) | workspace `Cargo.toml`; `cargo metadata` | — |
| Versions in the lock (this build) | tlsn, tlsn-core, tlsn-attestation, tlsn-formats, tlsn-mpc-tls 0.1.0-alpha.15; mpz-core / mpz-fields 0.1.0-alpha.6 (`6ebfe619`); tlsn-mux 0.1.0 (`64722f7`); rs_merkle 1.4.2 (`85f3e82`); bincode 1.3.3; hyper 1.9.0; k256 0.13.4; tokio 1.52.1; rangeset 0.4.0 | `grep -A1 '^name = ' Cargo.lock` after `cargo +1.95.0 build --release` | — |
| Toolchain | **MSRV 1.95**: `mpz` workspace declares `rust-version = "1.95"` (inherited by `mpz-fields`, a dependency of `tlsn-mpc-tls`); tlsn CI pins `RUST_VERSION: 1.95.0`; no `rust-toolchain.toml` at the tag (added on `main` 2026-09-15). Built here with `rustc 1.95.0 (59807616e 2026-04-14)`. Edition 2024 | `privacy-ethereum/mpz@v0.1.0-alpha.6` `Cargo.toml`; `.github/workflows/ci.yml` | — |
| `tlsn` features | default `rayon`, `hash-blake3`; optional `mozilla-certs` (built-in Mozilla roots), `hash-keccak256`, `web` | `crates/tlsn/Cargo.toml` | — |

### 12.2 Notary server — none at this tag

| Fact | Value | Source | Verdict |
|---|---|---|---|
| Removal | alpha.13 release notes: "this release **removes notary-server and notary-client** from the repository … The tlsn-attestation crate will continue to be maintained but will not receive new features." `crates/notary/server` exists at alpha.12 and is 404 from alpha.13 | GitHub release `v0.1.0-alpha.13`; raw path probes | **CONTRADICTS** (§14.3) |
| PSE public notary | `tlsnotary/website` `docs/notary_server.md` (commit "remove notary.pse.dev references", 2026-02-26): "Notary Server (Deprecated) … removed from the TLSNotary project in alpha.13 … The `notary.pse.dev` hosted server and its WebSocket proxy have been **shut down**." Host itself not checked (egress blocked) | `tlsnotary/website@master` | **CONTRADICTS** (§14.3) |
| Docker images | GHCR `ghcr.io/tlsnotary/tlsn/notary-server` tags end at `v0.1.0-alpha.12` | GHCR tags API | — |
| Old repos | `tlsnotary/notary-server` archived 2023-12-20 (pins alpha.2); `tlsnotary/docs-mdbook` archived 2025-05-20 | READMEs | — |
| How the example does it | `crates/examples/attestation/prove.rs` runs the notary **in-process** over `tokio::io::duplex(1 << 23)` (lines 61–63) — the same `Session::new(io)` works over any `AsyncRead + AsyncWrite`, so a stand-alone notary is the example's `notary()` behind a TCP listener | `prove.rs` | — |
| Constraints for a separate notary | prover and notary must run the **identical tlsn version** (`crates/tlsn/src/verifier.rs:88` "prover version does not match with verifier"); clocks within **5 s** (`crates/mpc-tls/src/follower.rs:33` `MAX_TIME_DIFF = 5`) | source | — |
| Fermata decision | `fermata-attest notary --listen …` wraps `notary()` (see `docs/PLAN.md`); "pluggable to PSE's notary" is dropped from README/pitch | — | — |

### 12.3 API at the tag (prove → present → verify)

Examples: `crates/examples/Cargo.toml` declares `attestation_prove` (`attestation/prove.rs`),
`attestation_present`, `attestation_verify`, plus `basic` and `proxy`. Run (from `attestation/README.md`):
`PORT=4000 cargo run --bin tlsn-server-fixture`, then `SERVER_PORT=4000 cargo run --release --example attestation_prove [-- json|html|authenticated]`,
`… attestation_present`, `… attestation_verify`. Output files `example-<type>.{attestation,secrets,presentation}.tlsn`
in the CWD; sizes `MAX_SENT_DATA = 4096`, `MAX_RECV_DATA = 16384` (`crates/examples/src/lib.rs`).

Flow, prover side: `Session::new(socket.compat()).split()` → `handle.new_prover(ProverConfig)` →
`.commit(MpcTlsConfig { max_sent_data, max_recv_data })` → `prover.connect(TlsClientConfig { server_name: ServerName::Dns, root_store }, tcp)`
(synchronous; spawn `prover.into_future()`) → hyper 1.x `http1` request (`Accept-Encoding: identity`, `Connection: close`) →
`HttpTranscript::parse` + `DefaultHttpCommitter::commit_transcript` → `RequestConfig` → `ProveConfig` → `prover.prove()` →
`AttestationRequest::builder(&request_config).server_name(..).handshake_data(HandshakeData { certs, sig, binding }).transcript(..).transcript_commitments(..).build(&CryptoProvider)`
→ bincode over the reclaimed socket → `Attestation` → `request.validate(&attestation, &provider)`.
Notary side: `handle.new_verifier(VerifierConfig { root_store })` → `commit()` → `VerifierCommitStart::{Mpc, Proxy}` → `accept().run()` → `verify().accept()` →
`Attestation::builder(&att_config).accept_request(req).connection_info(..).server_ephemeral_key(..).transcript_commitments(..).build(&provider)`
with `provider.signer.set_signer(Secp256k1Signer / Secp256k1EthSigner)`.
Presentation: `secrets.transcript_proof_builder()` with `reveal_sent/reveal_recv` over `tlsn_formats::http` spans → `attestation.presentation_builder(&provider).identity_proof(..).transcript_proof(..).build()`;
serialised with **bincode 1.3**.
Verification (offline, no network, no `getrandom`): `Presentation::verify(&CryptoProvider { cert: ServerCertVerifier::new(&root_store)?, .. })` →
`PresentationOutput { attestation, server_name: Option<ServerName>, connection_info { time, version, transcript_length }, transcript: Option<PartialTranscript>, extensions }`.
`PartialTranscript` exposes `sent_unsafe()/received_unsafe()` (unrevealed bytes are zero unless `set_unauthed(b'X')`) and
`sent_authed()/received_authed()` `RangeSet<usize>`; `tlsn_formats::http::{parse_request, parse_response}` give spans with byte indices.

| Fact | Value | Source |
|---|---|---|
| Notary key in the presentation | `presentation.verifying_key() → &VerifyingKey { alg: KeyAlgId (K256=1, P256=2), data: SEC1 bytes }`; the notary signs the bcs-encoded attestation header (`id, version, root` = Merkle root of the body). **`verify()` does not judge whether the key is trusted** — compare against a pinned key (`assert_eq!(presentation.verifying_key(), &trusted_key)`) | `crates/attestation/src/presentation.rs:61,66`, `lib.rs` |
| Signature algorithms | `SignatureAlgId::SECP256K1 = 1`, `SECP256R1 = 2`, **`SECP256K1ETH = 3`** (Keccak-prehashed, `r‖s‖v`, `ecrecover`-compatible); signers `Secp256k1Signer`, `Secp256k1EthSigner` (raw 32-byte scalar) | `crates/attestation/src/signing.rs:56–63,121,135` |
| Hash algorithms | `HashAlgId::SHA256 = 1`, `BLAKE3 = 2`, `KECCAK256 = 3`; transcript commitments default BLAKE3; only `TranscriptCommitmentKind::Hash` remains | `crates/core/src/hash.rs`, `transcript/commit.rs` |
| Server identity | `ServerIdentityProof { name, opening(HandshakeData { certs, sig, binding }) }` — the full DER chain is inside the presentation, but only `server_name` is returned; pin the origin by restricting the verifier's root store and comparing `server_name` | `crates/attestation/src/connection.rs` |
| `MpcTlsConfig` | `max_sent_data` and `max_recv_data` **required**; `max_recv_data_online` default 32 (`DEFAULT_MAX_RECV_ONLINE`); `defer_decryption_from_start = true` (received bytes beyond the online window are decrypted after the session, "essentially free in MPC terms"); `ProxyTlsConfig` needs only `server_name` | `crates/core/src/config/tls_commit/mpc.rs:6,26` |

### 12.4 TLS / HTTP constraints (cited from source at the tag)

| Constraint | Value | Source |
|---|---|---|
| TLS version | **TLS 1.2 only**: `ALL_VERSIONS = [ //&TLS13, &TLS12 ]`; `CertBinding` has only `V1_2` | `crates/tls/core/src/versions.rs:28`; `crates/core/src/connection.rs:280–282` |
| Cipher suites | only **`TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256`** and **`TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256`** are enabled; AES-256, ChaCha20 and all TLS 1.3 suites are commented out | `crates/tls/core/src/suites/mod.rs:160–178` |
| Key exchange | **P-256 (secp256r1) only**: `ALL_KX_GROUPS: [&SupportedKxGroup; 1] = [ // &X25519, &SECP256R1, // &SECP384R1 ]` — a server offering only X25519 fails | `crates/tls/client/src/kx.rs:86–90` |
| Server certificate | ECDSA P-256/P-384, Ed25519, RSA PKCS#1 / PSS accepted (`crates/tls/core/src/verify.rs:333–343`); custom/self-signed CA supported via `RootCertStore { roots: vec![CertificateDer(..)] }` on the prover (`TlsClientConfig::root_store`, required), the notary (`VerifierConfig::root_store`) and the verifier (`ServerCertVerifier::new`); `RootCertStore::mozilla()` needs the `mozilla-certs` feature | `crates/core/src/config/tls.rs`, `config/verifier.rs`, `webpki.rs` |
| Server name | `ServerName::Dns(DnsName)` only — **no IP literals**; the prover may connect to `127.0.0.1:port` while presenting SNI `vendor.fermata.test` (example's `SERVER_HOST` vs `SERVER_DOMAIN`) | `crates/core/src/connection.rs:35–37`; `prove.rs:76` |
| HTTP | no ALPN is sent → servers answer **HTTP/1.1**; examples use hyper `http1`; `tlsn-formats` parses HTTP/1.x; **compression unsupported** (`Accept-Encoding: identity`); chunked transfer encoding supported since alpha.15 (release notes) | `crates/tls/client/src/client/client_conn.rs`; `crates/formats/src/http` |
| Clock | prover/notary clock skew ≤ 5 s | `crates/mpc-tls/src/follower.rs:33` |
| Demo vendor consequence | Node `https` server (not http2) with `minVersion`/`maxVersion: 'TLSv1.2'`, `ciphers: 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256'`, `ecdhCurve: 'prime256v1'`, `honorCipherOrder: true`, tickets/compression/renegotiation off, `Content-Length` + `Connection: close`, P-256 ECDSA leaf with SAN `DNS:vendor.fermata.test` from a local CA | — |

### 12.5 Cost and performance (published; localhost numbers in §15)

| Fact | Value | Source |
|---|---|---|
| Bandwidth (MPC mode) | prover upload ≈ 25 MB fixed per session + ≈ 10 MB per KB of **sent** data + ≈ 40 KB per KB of received data | `tlsnotary/website` `docs/faq.md` |
| Latency (MPC vs proxy), 1 KB request / 2 KB response, native | cable 14.5 s vs 1.6 s; 5G 10.4 s vs 1.6 s; fiber 3.6 s vs 1.0 s (Ryzen 9950X) | blog `2026-05-10-blog-proxy-mode` |
| Proving phase vs response size | ≈ 0.3 s at 1 KB → ≈ 3 s at 51 KB when the response is partially hidden; **flat ≈ 0.3 s when the whole response is revealed** (write-key handover, automatic since alpha.13) | blog `2026-05-19-fast-reveal` |
| ≈ 10 KB response | ≈ 5 s native at 100 Mbps / 25 ms (c5.4xlarge) | blog `2026-01-19-alpha14-performance` |
| Design consequence | keep the **request** tiny (every sent byte is MPC-encrypted); reveal the full response (flat proving); responses of a few KB are fine. Proxy mode (alpha.15) is 1–2 s but a different trust model (the verifier relays the encrypted stream) — decision after the spike's numbers | — |
| Prompt's "MPC cost grows with transcript size" | partially: dominated by sent bytes and fixed setup; received bytes are cheap with deferred decryption | — |

### 12.6 Known pitfalls (issues checked 2026-09-23)

`--release` always (MPC is orders of magnitude slower unoptimised; use `[profile.dev.package."*"] opt-level = 3`);
proxy mode deadlocks on a `current_thread` runtime (#1149) → multi-thread runtime; multiplexer cap of 512 streams
can break very large responses or cert chains (#1163, #1171); BrokenPipe on async socket close fixed after alpha.15
(#1170; plain TCP unaffected); `tlsn-formats` "does not verify that redacted data does not contain control
characters" (we reveal everything and require full range coverage); under constrained CPU the in-process MPC can
deadlock — WebProof wraps notarisation in a 120 s timeout and retries once.

## 13. WebProof (bilgin-kocak/webproof-solana @ `609a654`, Apache-2.0)

TLSNotary verification for Solana, already on tlsn `v0.1.0-alpha.15` with the same constraints recorded
(`docs/tlsnotary-version.md`: git-only crates, Rust 1.95, in-process notary, TLS 1.2 only, `Accept-Encoding:
identity`, `--release`). Reusable for Fermata's attestor (ported with attribution headers):

| File | Reuse |
|---|---|
| `crates/tlsn-demo/webproof-tlsn/src/notarize.rs` | prover + notary halves (`NotarizeConfig { server_addr, server_name, uri, extra_headers, server_trust, max_sent_data, max_recv_data, notary_key }`); extend with arbitrary method + body (`Full<Bytes>`), drop the `status == OK` assertion (Fermata must prove 500s), expose the notary half over a socket |
| `.../present.rs` | selective disclosure: request line + target + headers (secret headers by name only) + full response |
| `.../verify.rs` | trusted-notary-key allowlist → `Presentation::verify` → `RangeSet` coverage checks → `parse_request/parse_response`; extend with origin, callId-header and time checks, `requestHash` recomputation, predicate, EIP-712 signing; drop the JSON-body requirement |
| `.../tests/presentation.rs` | attack matrix (untrusted notary, tampered/truncated/garbage artifact, deceptive host) — model for the binding-check negative tests |
| `.../src/fixture.rs` | in-process `tlsn-server-fixture` for tests |
| `crates/tlsn-demo/Cargo.toml` | git-dep pinning pattern, `opt-level = 3` for deps in dev, bincode 1.3 |

Not reused: the Anchor program, Borsh `ClaimV1`, Ed25519 signing, the TypeScript SDK.

## 14. Contradictions with PROMPT.md

1. **Explorer**: Moderato's explorer is `https://explore.testnet.tempo.xyz`; `explore.tempo.xyz` is mainnet (§2).
2. **TIP-20 signatures**: `transferWithMemo` returns nothing (not `bool`); the `TransferWithMemo` value parameter is named `amount`, not `value` (§5).
3. **Notary**: no notary server exists at the latest TLSNotary tag (removed in alpha.13) and PSE's `notary.pse.dev` is shut down; the attestor ships its own notary process (§12.2).
4. **TLSNotary distribution**: crates are not on crates.io; git dependencies on the tag; Rust 1.95 required (§12.1).
5. **TLS/HTTP**: TLS 1.2 + AES-128-GCM + P-256 only; DNS server names only; HTTP/1.1 only, no compression (§12.4).
6. **MPP intents**: formal intents are `charge` and `subscription`; `session` comes from method specs; there is no `authorize` intent (§9).
7. **Tempo memo in mppx**: the built-in `tempo` method's memo is a hash-based attribution value, not the challenge id (affects only the unprotected fallback; Fermata memos are `callId`) (§10).
8. **Validator**: `npx mppx validate` cannot pay a `fermata` challenge (silently skipped) and effectively requires `/openapi.json` (§11).
9. **mppx version**: 0.11.0 shipped on 2026-09-23 with a breaking memo change; pin exactly (§10).
10. **Fee token API**: the account preference is `setUserToken` on the FeeManager, not `setFeeToken`; calls to our contract pay in pathUSD by default (§3).
11. **`tempo wallet fund`**: a browser flow that defaults to mainnet; scripts use the RPC faucet (§4).
12. **Foundry**: the `stable` tag (v1.5.1) predates Tempo support (v1.7.0); use v1.8.3 (§1, §7).
13. **mkcert**: unavailable in the build environment; OpenSSL-generated certs are equivalent for TLSNotary (§1).
14. **Storage cost**: 250,000 gas per new storage slot and 5–10× deployment cost; keep the hold record small (§7).

## 15. Measurements

All on this container: 4 vCPU, 15 GB RAM, rustc 1.95.0, `cargo build --release`, default rayon
thread count (`RAYON_NUM_THREADS` unset = 4), localhost fixture (`tlsn-server-fixture`,
`test-server.io`, `/formats/json`, 722-byte JSON body), in-process notary (upstream example).

| Measurement | Value | Conditions | Date |
|---|---|---|---|
| tlsn release build: examples (prove/present/verify) + fixture | **130 s** wall-clock, 310 crates, ~3 GB target dir | cold cache, git deps fetched with the git CLI | 2026-09-23 |
| `attestation_prove json` wall-clock (MPC-TLS + attestation) | **1.21 s** (first attempt, no retry) | `MAX_SENT_DATA` 4096 / `MAX_RECV_DATA` 16384; request ≈ 200 B, response ≈ 900 B | 2026-09-23 |
| `attestation_present json` | 0.006 s | selective reveal (request line, headers, two JSON fields) | 2026-09-23 |
| `attestation_verify json` | 0.007 s | offline, custom root CA | 2026-09-23 |
| `example-json.attestation.tlsn` / `.secrets.tlsn` / `.presentation.tlsn` | 7,184 B / 13,739 B / **9,819 B** | bincode 1.3.3 | 2026-09-23 |
| Notary key algorithm printed by the verifier | `k256` (SEC1 compressed, 33 bytes) | example's dummy key `[1u8; 32]` | 2026-09-23 |
| **Spike prove-time, MPC mode**: separate TCP notary process, POST body, Node TLS 1.2 vendor | **median 1.1–1.5 s** (runs 0.93–2.5 s) | `spikes/proof-path/run.sh`, 4 vCPU shared by prover + notary, 4096/16384 | 2026-09-23 |
| Spike prove-time, **proxy mode** (notary relays the encrypted stream) | **0.46–0.51 s** | same setup, `--mode proxy` | 2026-09-23 |
| Spike presentation size | **5,162 B** (raw + HTTP-structured commitments); 1,916 B raw-only (malformed-JSON response) | bincode 1.3.3 | 2026-09-23 |
| Spike offline verify + predicate + EIP-712 sign | < 10 ms | `verify` binary | 2026-09-23 |
| `settle` on Anvil (Tempo emulation, chain 42431) | 133,588 gas (Foundry) / 0.0046 AlphaUSD fee observed on Anvil | `SpikeSettle` | 2026-09-23 |
| `permit` + `transferFromWithMemo` via `PullProbe` on Anvil-Tempo | 567,239 gas, fee 5,977 units AlphaUSD (≈ $0.006), EIP-1559 tx | fresh agent, relayer pays | 2026-09-23 |
| 100-call load test: wall-clock, per-call prove time, bandwidth | _Milestone 4_ | | |

### 15.1 FermataEscrow gas on Anvil-Tempo (Milestone 1, 2026-09-24)

Anvil 1.8.3 `--chain-id 42431` (real TIP-20 precompiles, storage credits, stablecoin fees).
Reproduce: `pnpm escrow:e2e:anvil` (deploy + 3-case round trip); the permit/concurrency rows come
from a one-off smoke run with the same contract. Anvil's base fee decays on an idle chain
(1e10 → ~1.6e9 attodollars/gas across a run), so compare **gas**, not fees; Moderato's fee per
gas is still unmeasured (RPC blocked here).

| Operation | Gas | Notes |
|---|---|---|
| deploy (`forge script --network tempo`) | 8,104,657 | 6,955 B runtime; 1,000 gas/byte dominates |
| `registerService` | 2.05–2.30M | 8 new slots; once per service |
| `hold`, fresh agent + fresh escrow | 1,569,957 | 6 new slots: 3 hold slots, agent permit nonce, allowance (0→price→0), escrow balance |
| `hold`, steady state (serial calls) | ~337,600 | 1 full-price slot; 4 slot creations refunded by storage credits |
| `hold`, concurrent (escrow has no credits left) | ~825,300 | 3 full-price hold slots |
| `hold` via an existing allowance (junk permit) | 83,272 | no nonce/allowance slot creation |
| `approve(escrow, 5 × price)` | 527,930 | |
| permit front-run by a third party, then `hold` | 537,274 + 828,916 | permit failure tolerated, allowance used |
| `settle` DELIVERED (2 transfers) | 102–107k | first settle of a new escrow: 357,419 |
| `settle` FAILED | 85–90k | |
| `claimTimeout` | 74,398 | |
| TIP-20 `transfer` to a new / existing address | 280,418 / 31,118 | |

- **Storage credits (TIP-1060) — observed model:** a cleared slot credits its *owner* and later
  slot creations by the same owner cost ~5k instead of 250k. The escrow owns its hold records
  *and* its pathUSD balance slot; the agent owns its allowance slot. Evidence: after one
  finalised hold (2 hold slots + escrow balance cleared) the next hold costs 337k, not 1.3M; with
  two holds open at once the second costs exactly 2 × 245,000 more. Consequence: seeding the
  escrow with 1 base unit saves only ~2k gas → not done.
- The floor per call is **one permanent new slot** (the callId replay marker = hold slot 0).
- Bubbled precompile errors decode by name: expired permit without allowance → `PermitExpired()`,
  junk signature without allowance → `InvalidSignature()` (ITIP20 errors).
- Anvil dev accounts do not share a fee token: dev0 pays in AlphaUSD, dev2 in ThetaUSD, dev4 in
  pathUSD; a fresh account holding only pathUSD pays in pathUSD.
- viem 2.56.8 ships `tempoModerato` in `viem/chains` (id 42431, Tempo transaction formatters,
  expiring-nonce logic). The scripts use a plain `defineChain` with EIP-1559 transactions (proven
  on Anvil); `tempoModerato` is the fallback if Moderato rejects them.
- Spike MPC hang, 2026-09-24: prove 3 of 3 hung twice in one gate run (no output, killed by the
  150 s guard) and passed on every other run (≈ 1.4–2.0 s). The spike now allows 3 attempts of
  30 s each. Milestone 2's attestor must do the same (per-attempt timeout + retry).

Spike caveat: with prover and notary on the same 4-vCPU box, an MPC session occasionally hangs
(one of four runs needed the retry); WebProof documents the same. Never run two MPC sessions
concurrently on this hardware.

Reading: on localhost the published WAN figures (3.6–14.5 s per session) collapse to ≈ 1.2 s
because the ≈ 25–30 MB of MPC setup traffic never leaves the machine. A 100-call sequential run
extrapolates to ≈ 2–3 minutes plus on-chain time (≈ 1 s per hold/settle at 0.6 s blocks), which
fits the video plan; the spike measures the two-process (TCP notary) variant and proxy mode.
