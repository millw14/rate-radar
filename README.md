# Rate Radar

A confidential sponsorship deal desk using **Helius Solana Privacy Rings**. Brands and creators sign the same agreement, pay from private USDC balances, and receive a server-verified settlement record.

[Open Rate Radar](https://www.rateradar.tech) · [Public source](https://github.com/millw14/rate-radar)

## Status

Production runs on **Solana mainnet, capped at 100 USDC per payment**. The funded end-to-end devnet gate passed on November 11, 2026: a 1 test-USDC deposit, 0.05 test-USDC confidential payment with a server-verified finalized receipt, and recipient withdrawal all finalized. Post-activation checks passed for wallet sessions, database persistence, mainnet USDC registration, prover attestation, and scheduled reconciliation. No real mainnet transfer was sent during verification. See the [release verification record](docs/release-verification.md).

Vercel uses Node.js Functions, Turso SQLite, and wallet sessions. The original Sites host uses a Cloudflare Worker and D1. There is no simulated payment action and no client-controlled paid status. Onchain execution requires a Helius API key, funded wallets, version 1 wallet signing support, and a registered Rings asset. This application has not received an independent external security audit.

The rate index remains an explicitly fictional dataset. Real receipts are not automatically contributed to it. Benchmark privacy proofs and aggregation are separate future work.

## Local setup

Requires Node.js 24 LTS and npm.

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
| `HELIUS_API_KEY` | Helius RPC, indexer, and encrypted prover transport for the selected network; server only |
| `RECEIPT_ENCRYPTION_KEY` | Random 32-byte base64 AES-GCM key for pending transaction disclosures and signed transaction recovery |
| `RINGS_NETWORK` | `devnet` by default; `mainnet-beta` is the only other accepted value |
| `RINGS_USDC_MINT` | Must match the canonical USDC mint for the selected network, listed below |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Vercel devnet database credentials; server only |
| `MAINNET_TURSO_DATABASE_URL`, `MAINNET_TURSO_AUTH_TOKEN` | Separate Vercel mainnet database credentials; no fallback to the devnet database |
| `PAYMENT_LIMIT_USDC` | Exact decimal limit per new payment; defaults to 100 USDC on mainnet |
| `PAYMENTS_PAUSED` | `true` pauses new payments; existing payment reconciliation and wallet withdrawals remain available |
| `CRON_SECRET` | Random server-only bearer secret of at least 32 characters for scheduled reconciliation |
| `DB` | D1 binding provisioned by Sites |

`rings-networks.mjs` pins each cluster's Helius origin, wallet chain, TEE policy, genesis hash, and mint. An unsupported network or mismatched mint fails closed. Payment verification also binds the immutable intent to the configured cluster and checks its genesis hash.

| Network | Canonical USDC mint |
| --- | --- |
| `devnet` | `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| `mainnet-beta` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |

The SDK checks the actual mint registry before deposits or payments. An unsupported mint is an error; there is no replacement with another token. On devnet, obtain test USDC from [Circle's faucet](https://faucet.circle.com/) and test SOL from [Solana's faucet](https://faucet.solana.com/). Neither test asset has monetary value. Mainnet USDC represents real funds.

## How it works

1. Connect a Wallet Standard Solana account and sign a short-lived, single-use login challenge. The browser receives an HttpOnly session cookie.
2. Create a deal naming both wallets, amount, deliverable, usage, and due date. The parties sign the exact version and hash of those terms. Once signed, terms cannot be silently changed.
3. Unlock Rings locally by signing its official privacy-role derivation message. Register the privacy identity if necessary and deposit USDC for the selected network. Deposits are public onchain.
4. The payer requests an idempotent payment intent. The browser uses `@heliuslabs/spr@0.9.0-alpha` to select private inputs, encrypt the transfer and intent memo, request an attested encrypted proof, and build the transaction. The wallet signs it.
5. **Before broadcast**, the backend durably stores the signed transaction and transaction-scoped disclosure in encrypted form. Recovery relays the same signed bytes and signature; it never constructs a second payment.
6. The backend reads the finalized Solana transaction. It checks the exact Rings program and instruction, payer, recipient, mint, amount, encrypted intent memo, and UTXO commitment. Only matching evidence issues a receipt. Unknown outcomes remain pending.

Withdrawals return private USDC to the connected public wallet. Before broadcasting, the browser saves the signed transaction, signature, amount, network, and block-height expiry metadata in persistent browser storage. Status checks and resends reuse those same signed bytes. Pending records survive reloads and disconnects; keep browser data until settlement. Recovery records contain no wallet keys or viewing keys. Clearing browser data removes this device's recovery record, so review chain history before attempting another withdrawal. The app clears a record only after finalized success, failure, or conservative expiry checks.

The SDK currently produces Solana transaction version 1. The interface checks the selected wallet's declared support; it does not assume that every wallet or wallet version supports it.

## Privacy and trust

Rings hides transfer assets and amounts onchain. Sender and recipient wallet addresses remain public; deposits and withdrawals expose amounts and assets. Deal terms and negotiated amounts are stored by this service and visible to both participants and its operator.

For payment verification, the payer explicitly discloses a **transaction-scoped viewing key** to the server. It can reveal other outputs in that one transaction, including change. The app never sends its master viewing key or wallet private key to the backend. Pending disclosures use AES-GCM with intent-bound authenticated data. Verified or definitively rejected disclosures are removed; expired transactions requiring manual review retain their encrypted recovery record and permanent payment lock. Expiry never automatically creates a new payment.

The verifier trusts the configured Helius endpoint for finalized chain data. It does not trust a browser's claimed amount, a bare signature, or unanchored indexer plaintext. The decoder is deliberately pinned to the SDK's default confidential transfer format; unsupported formats fail closed. A receipt proves payment, not delivery, a person's legal identity, or the commercial authenticity of a deal.

## Hosting and access

### Vercel

`vercel.json` deploys static assets from `dist/client` and routes `/api/*` to one Node.js Function. The function uses Turso through a D1-compatible adapter so the agreement and payment transaction rules remain unchanged. Configure the server-only runtime values above. Keep production and preview credentials and databases separate.

`server/runtime-config.mjs` selects `TURSO_*` credentials for devnet and `MAINNET_TURSO_*` credentials for mainnet automatically from `RINGS_NETWORK`. Mainnet refuses missing credentials and a database URL matching the devnet database. It never falls back to devnet data. Preserve the original devnet database when activating mainnet; its pending transactions still belong to devnet.

Apply migrations once before releasing a deployment, using an ignored environment file containing the target database credentials:

```sh
npm run db:migrate:vercel -- --env-file .env.vercel.local
```

The migration command uses the literal `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` in the explicitly selected file. For a mainnet migration, prepare a separate ignored file containing the mainnet database credentials under those names; do not assume the CLI applies the runtime prefix selection.

Wallet login verifies a short-lived Ed25519 challenge bound to the browser and origin. Only a verified signature creates an opaque HttpOnly session cookie; the database stores its hash. Sessions expire after seven days and Disconnect revokes the current session. Client-supplied Sites identity headers are discarded. Deal terms and payments still require their own wallet signatures.

The canonical production domain, [www.rateradar.tech](https://www.rateradar.tech), is publicly accessible. Vercel deployment protection remains enabled for preview deployment URLs. Public access to the app does not expose private API data: agreements and receipts require an authenticated participating wallet, and the RPC proxy requires wallet authentication.

The Vercel configuration schedules `/api/cron/reconcile` every minute. The endpoint requires `Authorization: Bearer <CRON_SECRET>`, takes a database lease, and processes at most one saved pending payment per invocation for the selected network. User-triggered reconciliation remains available. A payment pause or lower cap does not stop recovery of an already checkpointed payment. Monitor job failures and pending-payment age; the schedule is not a guarantee of settlement within one minute.

The mainnet pilot cap defaults to **100 USDC per payment**. Set `PAYMENT_LIMIT_USDC=100` explicitly for the pilot. `PAYMENTS_PAUSED=true` blocks new payments and first checkpoints while preserving saved-payment recovery, RPC access, and withdrawals. It does not reverse a signed or broadcast transaction.

For a consistent database snapshot and a restore check into a new local SQLite file:

```sh
npm run db:backup:vercel -- --env-file .env.vercel.ops \
  --output backups/snapshot.json --restore-check backups/restore.sqlite
```

Use fresh filenames. The tool makes no remote writes, refuses existing output files, and validates row counts, foreign keys, and integrity. See the [backup and recovery runbook](docs/backup-recovery.md) for private artifact handling, separate encryption-key backup, and recovery of post-snapshot payment locks before reopening payments.

### Original Sites host

`.openai/hosting.json` preserves this Site's identity and declares its D1 binding. The build emits `dist/client` and `dist/server/index.js`, plus the official Poseidon WASM module for the Worker runtime. Migrations live in `drizzle/`; append migrations rather than editing applied SQL.

Sites supplies the trusted `oai-authenticated-user-id` identity header. Do not place this Worker directly behind an untrusted public origin that lets callers set that header. A different host must supply a real authenticated identity boundary before using these routes.

The GitHub repository is public. The hosted Site's existing owner-private access is preserved. A second participant needs access to the Site before the hosted two-party flow can be used. Public source does not change workspace sharing.

## Validation

```sh
npm test
npm run build
npm run test:worker
```

Tests cover real Ed25519 challenge signatures, SQLite authorization and state transitions, immutable agreement versions, replay/idempotency, actual SDK version 1 signed transaction checkpoints, confidential output decryption and commitment matching, cluster isolation, payment caps and pauses, cron authentication and leases, persistent withdrawal recovery, and database backup/restore. Worker verification checks the official Poseidon implementation against a known SDK output in the actual Workers runtime.

The release test run passed **107 tests**. These tests supplement the funded devnet evidence; they do not constitute an independent security audit.

Browser QA exercises wallet authentication, draft creation, signed approval, server persistence across reload, responsive layouts, and accessibility. The Vercel session flow also passes real browser → API → libSQL login, HttpOnly cookie persistence, agreement signing, and logout revocation; this local integration test uses an isolated SQLite database. Cryptographic fixtures exercise the actual SDK but are not a live network settlement.

Live checks on November 11, 2026 verified the app's Worker proxy against Solana devnet, browser privacy-key unlock, Circle USDC's Rings registry (asset ID 59), signed prover attestation, and all 136 published proving-key pins. Repeat these read-only checks after configuring the server and connecting a wallet in the local app:

```sh
npm run check:live
# For a different local port:
RATE_RADAR_URL=http://127.0.0.1:4174 npm run check:live
```

The funded devnet test completed on November 11, 2026. Deposit and payment retries reused their saved transaction records without duplicate payments. After withdrawal, the recipient's private balance returned to zero and its public USDC balance increased by 0.05. [Finalized transaction evidence and remaining limits](docs/release-verification.md).

Post-activation mainnet verification is read-only: wallet login, unsigned draft cleanup, canonical genesis and USDC registry checks, prover attestation, and 136 key pins. Its result is pending. No real mainnet transfer has been tested, and the application has not received an independent external audit.

## Main files

- `backend.mjs` — authenticated API, agreements, payment checkpoints, RPC proxy, reconciliation.
- `db/schema.ts`, `drizzle/` — D1 schema and migrations.
- `rings-client.mjs` — local privacy roles, wallet signing, deposits and confidential transfers.
- `rings-networks.mjs` — allowlisted cluster, policy, genesis, and mint configuration.
- `rings-verifier.mjs` — finalized chain decoding and payment evidence checks.
- `withdrawal-recovery.mjs` — persistent signed withdrawal records scoped to wallet and network.
- `api/index.mjs`, `server/` — Vercel API, network-specific database selection, wallet sessions, and reconciliation job.
- `scripts/backup-vercel.mjs`, `docs/backup-recovery.md` — bounded read-only backup, local restore validation, and recovery procedure.
- `live-desk.mjs`, `app.mjs`, `styles.css` — deal desk, receipts, and fictional rate index.
- `worker.mjs`, `build.mjs`, `scripts/` — Worker hosting, static assets, local setup and WASM support.

## References

- [Helius Rings SDK](https://www.helius.dev/docs/privacy/sdk), [endpoints](https://www.helius.dev/docs/privacy/endpoints), [wallet integration](https://www.helius.dev/docs/privacy/integration/wallet), [transfer guide](https://www.helius.dev/docs/privacy/guides/transfer).
- [Solana transaction v1 compatibility](https://solana.com/upgrades/larger-transaction-sizes), [official devnet USDC example](https://solana.com/docs/payments/quickstart).
- Design study: [Jeton on Awwwards](https://www.awwwards.com/sites/jeton), [Büro's Jeton app study](https://www.burocratik.com/work/jeton), [Linear's UI redesign](https://linear.app/now/how-we-redesigned-the-linear-ui), and [Digital Curator](https://www.awwwards.com/sites/digital-curator). The interface preserves quiet typography, concise labels, and static layouts.
