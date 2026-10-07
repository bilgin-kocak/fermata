# X launch thread

Four posts, each under 280 characters (links count as 23). Before posting: check that `@tempo` and
`@colosseum` are the official handles, and attach a 20–40 s demo clip or a dashboard screenshot to
post 1. Then paste the thread's link into the form's go-to-market or traction section.

## 1/

AI agents pay for APIs one call at a time. When the API fails, the money is gone.

I built Fermata: pay on proof. The payment waits in escrow on @tempo and is only released when a TLSNotary proof shows the vendor delivered.

Live on Tempo testnet 👇

## 2/

How it works:
1. The agent pays over MPP; the money is held in escrow
2. TLSNotary records exactly what the vendor's server sent
3. Passes the vendor's on-chain rule → vendor paid
4. Proven failure, or no answer in time → agent refunded, automatically

## 3/

It runs today: 100 paid calls against a vendor failing at random → 96 released, 4 refunded, 0 errors.

It proves the real npm registry too, and Claude can pay for tools through it over MCP.

Anyone can re-check a proof offline: pnpm reverify.

## 4/

Try it, no wallet needed: https://fermata-production-9378.up.railway.app/dashboard/

Built for the @colosseum Crypto World's Fair, Tempo track. Feedback from API vendors welcome 🙏
