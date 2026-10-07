# fermata-mcp — pay-on-proof tools for MCP agents

Gives an MCP agent (Claude Code, Claude Desktop, any MCP client) paid API tools that are
**released to the vendor only on a TLSNotary proof of delivery, and refunded on a proven failure or
no answer**. Testnet only.

```
Claude ──stdio──▶ fermata-mcp (agent's wallet) ──MCP over HTTP──▶ Fermata gateway /mcp ──▶ vendor API
                  pays with the `fermata` MPP method:              proves the answer (TLSNotary),
                  hold in the escrow on Tempo                      settles: release or refund
```

Two parts:

- **Gateway `POST /mcp`** (`apps/gateway/src/mcp.ts`): every registered service is a paid MCP tool.
  A call without payment gets an MPP challenge for the `fermata` method (JSON-RPC error `-32042`,
  mppx's MCP transport). The agent holds the price in the escrow and retries with the credential in
  `_meta["org.paymentauth/credential"]`. The gateway then runs the same hold → prove → verdict →
  settle pipeline as the HTTP route. The tool result carries the vendor's answer, the outcome, and
  `_meta["org.fermata/call"]` (callId, status, hold/settle tx, presentation hash); the MPP receipt
  goes in `_meta["org.paymentauth/receipt"]`. Four free tools: `fermata_vendor_scores` (each
  vendor's proven delivery record, from the escrow's events), `fermata_call`, `fermata_verify`
  (offline re-verification against the chain), `fermata_reconcile` (TIP-20 movements by memo).
- **`fermata-mcp`** (this package, stdio): the process the agent launches. It holds the agent's
  testnet key, connects to the gateway's `/mcp` with `McpClient.wrap(client, { methods: [fermata({ … })] })`
  from `mppx/mcp/client`, and re-exposes the tools. It adds `fermata_wallet`.

Before any money moves, `fermata-mcp` checks, in the SDK's `fermata()` client:

- the escrow and the verifier against **your own** allow-lists (`FERMATA_ESCROW`,
  `FERMATA_TRUSTED_VERIFIERS`), never against what the gateway claims;
- that the price is the registered price.

It also runs a spending guard: a per-call cap (`FERMATA_MAX_PRICE`) and a per-session budget
(`FERMATA_BUDGET`). A declined payment comes back as a tool error, and no hold is made.

## Use it from Claude Code

One line, no settings: it pays the public live demo on Tempo Moderato testnet from a testnet wallet
it creates in `~/.fermata/agent-key` (readable only by you) and funds from the testnet faucet:

```sh
claude mcp add fermata -- npx -y fermata-mcp
```

Then ask Claude, for example: *"Get the BTC price with get_quote_reliable, then try get_quote_broken,
and verify both calls."* One call is released to the vendor, the other refunded on its proven 500.

Claude Desktop: add to `claude_desktop_config.json`

```json
{ "mcpServers": { "fermata": { "command": "npx", "args": ["-y", "fermata-mcp"] } } }
```

The automatic wallet is only created on chain 42431: Tempo Moderato testnet, or a local Anvil emulation
of it, which has no faucet (set `FERMATA_AGENT_KEY` there). To use your own key, another
gateway, or a local stack, set the variables below (`claude mcp add fermata -e NAME=value … -- npx -y fermata-mcp`).
For example, from this repository against a local stack:

```sh
bash scripts/demo-stack.sh up --chain anvil
claude mcp add fermata \
  -e FERMATA_GATEWAY=http://127.0.0.1:4300 \
  -e FERMATA_AGENT_KEY=0x…                      `# a funded TESTNET key, never a mainnet key` \
  -e TEMPO_RPC_URL=http://127.0.0.1:8549 \
  -e FERMATA_ESCROW=$(jq -r .escrow out/demo/stack.json) \
  -e FERMATA_TRUSTED_VERIFIERS=$(jq -r .verifier out/demo/stack.json) \
  -- "$PWD/node_modules/.bin/tsx" "$PWD/apps/mcp/src/index.ts"
```

For your own gateway on Moderato (`--chain moderato`), set `FERMATA_GATEWAY` and
`FERMATA_TRUSTED_VERIFIERS`; the RPC and `FERMATA_ESCROW` already default to Moderato and its
deployment in `packages/sdk/src/deployments.json`. Claude Desktop takes the same command and env in
its `mcpServers` config.

| Env | Default | |
|---|---|---|
| `FERMATA_GATEWAY` | the live demo | gateway base URL (`/mcp` is appended) |
| `FERMATA_AGENT_KEY` | a testnet wallet in `~/.fermata/agent-key`, created only on chain 42431 (Moderato) and funded from its faucet | the agent's testnet private key |
| `TEMPO_RPC_URL` | `https://rpc.moderato.tempo.xyz` | |
| `FERMATA_ESCROW` | `deployments.json` for `FERMATA_NETWORK` (`moderato`) | escrow(s) you accept, comma-separated |
| `FERMATA_TRUSTED_VERIFIERS` | the live demo's verifier, for the live demo only; otherwise required | verifier address(es) you accept, never taken from the gateway |
| `FERMATA_MAX_PRICE` | `100000` (0.10) | max price per call, token base units |
| `FERMATA_BUDGET` | `1000000` (1.00) | max total held per session |

## A real Claude session (Anvil, 2026-10-02)

This was a headless `claude -p` run with only this MCP server attached and `--allowedTools
"mcp__fermata__*"`. The prompt: *"You have Fermata tools for paid APIs. Check my wallet, then get a
BTC-USD price from the reliable vendor and an ETH-USD price from the broken vendor. For each call
tell me in one line what happened to my money and why. Then verify the proof of the BTC call and
tell me whether it checks out. Be brief."*

```
tool  fermata_wallet {}                              → 0.2 pathUSD, budget 1.0, nothing held
tool  get_quote_reliable {"symbol":"BTC-USD"}        ┐ called in parallel
tool  get_quote_broken   {"symbol":"ETH-USD"}        ┘
      → HTTP 200 {"price":64231.5,…}  Fermata call 0x71e0a506…: DELIVERED → released to the vendor (settle tx 0x…)
      → HTTP 500 {"error":"upstream exploded"}  Fermata call 0x039fdb9d…: FAILED (status 500 not in [200]; …) → refunded to you (tx 0x13dc86c1…)
tool  fermata_verify {"callId":"0x71e0a506…"}        → ok: true, every hash matches the chain

Claude:
  Wallet: 0.2 pathUSD, with a 1.0 session budget and nothing spent yet.
  - BTC-USD (reliable vendor): You paid 0.01, which was released to the vendor, because the
    vendor returned HTTP 200 with a valid price (64,231.5) and the proof passed the delivery check.
  - ETH-USD (broken vendor): The 0.01 was refunded to you, because the vendor returned HTTP 500
    and the response had no `price` or `timestamp`.
  BTC proof: It checks out. fermata_verify returned ok, and all six hashes match the chain
  (presentation, request, origin, notary key, predicate, call ID). The outcome is DELIVERED
  on-chain, and the transcript shows GET /v1/quote?symbol=BTC-USD answered with a 200 and the
  price above.
```

The session took 6 turns and 18 s. (`fermata_verify` actually returns seven checks — six hashes
plus the outcome; Claude's summary rounded that.)

## Scripted: `pnpm demo:mcp`

`pnpm demo:mcp --chain anvil` runs the same flow without an LLM, through this stdio server and a
fresh funded agent. It checks six things and prints a pass/fail table:

- released on a proven delivery;
- refunded on a proven 500;
- proof re-verified offline;
- refund reconciled by memo;
- the spending guard declines a call over budget;
- the agent paid exactly 0.01 plus gas, because the refund came back.

All 6 PASS on Anvil (2026-10-02).
