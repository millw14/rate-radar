# Rate Radar

A confidential sponsorship deal desk using **Helius Solana Privacy Rings**. Brands and creators sign the same agreement, pay from private USDC balances, and receive a server-verified settlement record.

[Hosted workspace](https://rate-radar-studio.early-clock-9525.chatgpt.site) · [Public source](https://github.com/millw14/rate-radar)

## Status

This release targets **Solana devnet only**. It contains a real Rings SDK integration, a Cloudflare Worker API, and a D1 database. There is no simulated payment action and no client-controlled paid status. A Helius API key, funded devnet wallets, version 1 wallet signing support, and a registered Rings asset are required for onchain execution. Mainnet is intentionally unsupported.

The rate index remains an explicitly fictional dataset. Real receipts are not automatically contributed to it. Benchmark privacy proofs and aggregation are separate future work.

## Local setup

Requires Node.js 24 or newer and npm.

```sh
npm ci
cp .env.example .env.local
# Fill HELIUS_API_KEY in .env.local.
# Generate RECEIPT_ENCRYPTION_KEY with:
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
npm run build
npm run db:migrate
npm run dev
```

Open http://127.0.0.1:4173/. Local development emulates one Sites identity on loopback only; wallet challenge signatures are still verified. The two-party test suite uses separate identities. Never put a wallet seed, private key, or master viewing key in the server environment.

Runtime configuration:

| Key | Purpose |
| --- | --- |
| `HELIUS_API_KEY` | Helius devnet RPC, indexer, and encrypted prover transport; server only |
| `RECEIPT_ENCRYPTION_KEY` | Random 32-byte base64 AES-GCM key for pending transaction disclosures and signed transaction recovery |
| `RINGS_NETWORK` | `devnet` |
| `RINGS_USDC_MINT` | Circle devnet USDC: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| `DB` | D1 binding provisioned by Sites |

The SDK checks the actual mint registry before deposits or payments. An unsupported mint is an error; there is no replacement with another token. Obtain test tokens from [Circle's faucet](https://faucet.circle.com/) and test SOL from [Solana's faucet](https://faucet.solana.com/). Neither test asset has monetary value.

## How it works

1. Sign into the hosted workspace. Link a Wallet Standard Solana account with a short-lived, single-use message signature.
2. Create a deal naming both wallets, amount, deliverable, usage, and due date. The parties sign the exact version and hash of those terms. Once signed, terms cannot be silently changed.
3. Unlock Rings locally by signing its official privacy-role derivation message. Register the privacy identity if necessary and deposit test USDC. Deposits are public onchain.
4. The payer requests an idempotent payment intent. The browser uses `@heliuslabs/spr@0.9.0-alpha` to select private inputs, encrypt the transfer and intent memo, request an attested encrypted proof, and build the transaction. The wallet signs it.
5. **Before broadcast**, the backend durably stores the signed transaction and transaction-scoped disclosure in encrypted form. Recovery relays the same signed bytes and signature; it never constructs a second payment.
6. The backend reads the finalized Solana transaction. It checks the exact Rings program and instruction, payer, recipient, mint, amount, encrypted intent memo, and UTXO commitment. Only matching evidence issues a receipt. Unknown outcomes remain pending.

The SDK currently produces Solana transaction version 1. The interface checks the selected wallet's declared support; it does not assume that every wallet or wallet version supports it.

## Privacy and trust

Rings hides transfer assets and amounts onchain. Sender and recipient wallet addresses remain public; deposits and withdrawals expose amounts and assets. Deal terms and negotiated amounts are stored by this service and visible to both participants and its operator.

For payment verification, the payer explicitly discloses a **transaction-scoped viewing key** to the server. It can reveal other outputs in that one transaction, including change. The app never sends its master viewing key or wallet private key to the backend. Pending disclosures use AES-GCM with intent-bound authenticated data. Verified or definitively rejected disclosures are removed; expired transactions requiring manual review retain their encrypted recovery record and permanent payment lock. Expiry never automatically creates a new payment.

The verifier trusts the configured Helius endpoint for finalized chain data. It does not trust a browser's claimed amount, a bare signature, or unanchored indexer plaintext. The decoder is deliberately pinned to the SDK's default confidential transfer format; unsupported formats fail closed. A receipt proves payment, not delivery, a person's legal identity, or the commercial authenticity of a deal.

## Hosting and access

`.openai/hosting.json` preserves this Site's identity and declares its D1 binding. The build emits `dist/client` and `dist/server/index.js`, plus the official Poseidon WASM module for the Worker runtime. Migrations live in `drizzle/`; append migrations rather than editing applied SQL.

Sites supplies the trusted `oai-authenticated-user-id` identity header. Do not place this Worker directly behind an untrusted public origin that lets callers set that header. A different host must supply a real authenticated identity boundary before using these routes.

The GitHub repository is public. The hosted Site's existing owner-private access is preserved. A second participant needs access to the Site before the hosted two-party flow can be used. Public source does not change workspace sharing.

## Validation

```sh
npm test
npm run build
npm run test:worker
```

Tests cover real Ed25519 challenge signatures, SQLite authorization and state transitions, immutable agreement versions, replay/idempotency, pending/failed payment handling, signed transaction recovery, confidential output decryption and commitment matching, and wallet transport boundaries. Worker verification checks the official Poseidon implementation against a known SDK output in the actual Workers runtime.

Browser QA exercises wallet authentication, draft creation, signed approval, server persistence across reload, responsive layouts, and accessibility. Cryptographic fixtures exercise the actual SDK but are not a live network settlement. A live test needs the configured Helius key and funded compatible devnet wallets.

## Main files

- `backend.mjs` — authenticated API, agreements, payment checkpoints, RPC proxy, reconciliation.
- `db/schema.ts`, `drizzle/` — D1 schema and migrations.
- `rings-client.mjs` — local privacy roles, wallet signing, deposits and confidential transfers.
- `rings-verifier.mjs` — finalized chain decoding and payment evidence checks.
- `live-desk.mjs`, `app.mjs`, `styles.css` — deal desk, receipts, and fictional rate index.
- `worker.mjs`, `build.mjs`, `scripts/` — Worker hosting, static assets, local setup and WASM support.

## References

- [Helius Rings SDK](https://www.helius.dev/docs/privacy/sdk), [endpoints](https://www.helius.dev/docs/privacy/endpoints), [wallet integration](https://www.helius.dev/docs/privacy/integration/wallet), [transfer guide](https://www.helius.dev/docs/privacy/guides/transfer).
- [Solana transaction v1 compatibility](https://solana.com/upgrades/larger-transaction-sizes), [official devnet USDC example](https://solana.com/docs/payments/quickstart).
- Design study: [Jeton on Awwwards](https://www.awwwards.com/sites/jeton), [Büro's Jeton app study](https://www.burocratik.com/work/jeton), [Linear's UI redesign](https://linear.app/now/how-we-redesigned-the-linear-ui), and [Digital Curator](https://www.awwwards.com/sites/digital-curator). The interface preserves quiet typography, concise labels, and static layouts.
