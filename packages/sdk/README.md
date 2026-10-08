# fermata-sdk — pay on proof for AI agents

When an AI agent pays an API per call, the payment is gone even if the API fails. With Fermata the
payment is **held in escrow on [Tempo](https://tempo.xyz)** and **released to the vendor only when a
[TLSNotary](https://github.com/tlsnotary/tlsn) proof of the vendor's HTTPS answer passes a delivery
rule pinned on-chain**. A proven failure refunds the agent; a call with no proof in time is refunded
once its settlement window closes.

This package is the TypeScript side: the `fermata` payment method for [mppx](https://github.com/wevm/mppx)
(the Machine Payments Protocol), for agents and for servers, plus escrow bindings, reconciliation by
memo and vendor scores.

> **Testnet only, unaudited hackathon code.** Use Tempo Moderato testnet keys, never real funds.
> Project, trust model and live demo: <https://github.com/bilgin-kocak/fermata>.

```sh
npm install fermata-sdk mppx@~0.11.0 viem
```

## Agents: pay on proof

Add the `fermata` method to your mppx client. The escrows and verifiers are **your own** allow-lists:
the agent never pays into an escrow, or for a verifier, just because a gateway names it.

```ts
import { Receipt } from 'mppx'
import { Mppx } from 'mppx/client'
import { createPublicClient, createWalletClient, http, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { MODERATO, escrowDeployment, fermata, tempoChain, type FermataReceipt } from 'fermata-sdk'

const chain = tempoChain(MODERATO.rpcUrl)
const wallet = createWalletClient({ account: privateKeyToAccount(process.env.AGENT_KEY as Hex), chain, transport: http() })
const client = createPublicClient({ chain, transport: http() })

const mppx = Mppx.create({
  methods: [
    fermata({
      wallet,
      client,
      escrows: [escrowDeployment('moderato')!.address],
      trustedVerifiers: ['0xb8718ad26e9ae0058b8b1a369295b374d99af599'], // the live demo's verifier
    }),
  ],
  polyfill: false,
})

// The live demo's reliable quote API. On its 402 the client holds the price in escrow, then retries.
const res = await mppx.fetch(
  'https://fermata-production-9378.up.railway.app/s/0x87BefA421a00DaBCf032dE04EF0cDa63F5548EF271756f74652d6f6b00000000/v1/quote?symbol=BTC-USD',
)
const receipt = Receipt.fromResponse(res) as FermataReceipt
console.log(res.status, receipt.outcome, receipt.callId) // 200 DELIVERED 0x…
```

`AGENT_KEY` is a Tempo Moderato testnet key holding testnet pathUSD; the testnet faucet funds one:

```sh
curl -s https://rpc.moderato.tempo.xyz -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tempo_fundAddress","params":["<your address>"]}'
```

Before any money moves, `fermata()` checks the chain, that the escrow is on your list, that the
service is settled by a verifier on your list, that the price is the service's registered price, and
that the price and the settlement window are within your limits: `maxAmount` (no cap by default) and
`maxSettlementWindow` (1 hour by default; an unsettled payment stays held that long). The receipt a
Fermata gateway returns names the call, its outcome (`DELIVERED`, `FAILED`, or `AWAITING_TIMEOUT`
when the vendor never answered and the escrow will refund you) and the settlement transaction. A
gateway lists its services, prices and endpoints at `GET /services`.

If a paid call fails after the money is held (a network error, a gateway that rejects the hold), the
gateway may have no record of it to settle. Pass `onHold` to keep each hold's `callId` and `escrow`;
`reclaim(wallet, client, escrow, callId)` refunds it once its settlement window has passed. When a
gateway challenges the same call again, `fermata()` reuses its hold instead of paying twice.

**Pay only gateways you trust.** A challenge is not bound to the URL you fetched: a server that relays
a Fermata gateway's challenge can make you pay, at a trusted service's registered price, for a
request of its choosing. And a trusted verifier does not vouch for every service that names it:
anyone can register one, which is why the price and the window are capped. Keep `polyfill: false`
and call `mppx.fetch` only on gateway URLs you chose.

Using Claude or another MCP agent instead? See [`fermata-mcp`](https://www.npmjs.com/package/fermata-mcp):
`claude mcp add fermata -- npx -y fermata-mcp`.

## Servers: accept `fermata` payments

`fermataServer()` is the server side of the method, for a gateway or a vendor hosting it:

```ts
import { Mppx } from 'mppx/server'
import { createPublicClient, http } from 'viem'
import { MODERATO, escrowDeployment, fermataServer, tempoChain } from 'fermata-sdk'

const client = createPublicClient({ chain: tempoChain(MODERATO.rpcUrl), transport: http() })
const secretKey = process.env.MPP_SECRET_KEY!
const mppx = Mppx.create({
  secretKey,
  realm: 'api.example.com',
  methods: [fermataServer({ client, escrow: escrowDeployment('moderato')!.address, secretKey })],
})
```

It validates the agent's hold transaction (the `Held` event for this call, service, request and
price on this escrow; the hold still open), claims each call ID once, and tolerates a load-balanced
RPC a block behind. The claims live in `store`, in memory by default: when more than one instance
serves the same escrow, pass a shared mppx `Store.AtomicStore`. Proving and settling are the
gateway's job: see `apps/gateway` in the repository.

## Also in the box

| Export | What it does |
|---|---|
| `reconcile(client, { token, callId, fromBlock, toBlock })` | Every TIP-20 movement whose memo is the call ID, scanned in chunks under the RPC's log-range cap |
| `fetchEscrowLogs`, `aggregateScores`, `wilsonLower` | Vendor scores from the escrow's own events: proven deliveries vs proven failures |
| `getHold`, `getService`, `reclaim` | Escrow reads; `reclaim` sends `claimTimeout` once a hold's window has passed |
| `requestHash`, `serviceId`, `originHash`, `predicateHash`, `notaryKeyHash` | The hashes the escrow and the attestor agree on |
| `escrowDeployment('moderato')`, `tempoChain(rpc)`, `MODERATO`, `TOKENS`, `fermataEscrowAbi` | Network constants and the escrow ABI |

Clients built on `tempoChain()` or on viem's own `tempoModerato` both work.

## What a proof does and does not establish

A TLSNotary presentation shows that a specific HTTPS server, identified by its certificate, sent
specific bytes in reply to specific request bytes. It does not show the data is correct, and it
cannot show that a server never answered (that is what the timeout refund is for). In v1 one
Fermata verifier signs each verdict and Fermata runs the notary: every verdict points at a proof
anyone can re-verify offline, so a dishonest verdict is detectable, not prevented.

MIT licensed.
