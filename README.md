# Rate Radar

A browser-based prototype of a confidential sponsorship deal desk for Solana-native creators and brands. The rate index is a secondary benefit of the eventual private receipt network.

## Run

Node 20+ is sufficient; the application has no runtime dependencies.

```sh
npm run dev
npm test
npm run build
```

Local preview: http://127.0.0.1:4173/ . Static build: `dist/`.

## Working flows

- `#deals`: filter and inspect demo deals; create local drafts; review terms; simulate approval and payment; export demo records.
- `#explore`: filter 48 synthetic rate cohorts; compare offers; save comparisons; search formats; export labeled CSV. Filters also have shareable URL parameters.
- `#studio`: view and delete demo receipts and saved comparisons.
- Receipt contribution: choose a sample, add context, inspect disclosure, save locally.

Records persist in this browser's local storage. They are not synced, signed, or submitted to a service. Google Fonts serves DM Sans and Instrument Serif; no account, wallet, analytics, or payment service is connected.

## Product boundary

This is a design and interaction prototype. All included deals, rates, receipt counts, and payment states are fictional. Simulating a payment does not transfer USDC. A demo receipt is not a transaction proof, signature, attestation of delivery, or legally signed contract.

The eventual production flow is private terms → mutually approved agreement → confidential USDC payment through Helius Rings → a receipt linked to that settlement. Helius's default ring encrypts assets, amounts and balances but exposes sender and recipient addresses. Deposits and withdrawals expose more information. [Primary privacy documentation](https://www.helius.dev/docs/privacy/concepts/encryption).

Production work still required:

- Wallet authentication and counterparty authorization, agreement versions, signatures, and recoverable drafts.
- Live Rings SDK/RPC integration and transaction states; actual settlement confirmation before issuing a receipt.
- A binding between the approved agreement and hidden payment; delivery approval remains a party's attestation.
- Receipt duplicate/collusion controls and independent-counterparty checks.
- Custom proofs and private aggregation for opt-in benchmarks, cohort suppression and inference protections.
- Independent security review before handling real funds. Helius's example escrow programs are not deployable production code.

## Design study

The revised UI prioritizes the workspace, concise labels, consistent controls and a static visual identity. It deliberately excludes autoplay artwork, scroll interception and decorative movement.

- [Jeton on Awwwards](https://www.awwwards.com/sites/jeton) and [Büro's app/web design case study](https://www.burocratik.com/work/jeton): consistent identity across marketing and task-focused app screens. Public sign-in was inspected; authenticated dashboards and private backend were not accessed.
- [Linear's UI redesign](https://linear.app/now/how-we-redesigned-the-linear-ui): hierarchy, alignment and navigation density.
- [Digital Curator on Awwwards](https://www.awwwards.com/sites/digital-curator): query-driven exploration and scoped detail views.
- [Language Explorer's public dataset](https://github.com/google-research/url-nlp/tree/main/linguameta): explicit provenance and honest data coverage.

## Files

- `index.html`: static shell and rate workspace.
- `app.mjs`: navigation, benchmark interactions, dialogs and local records.
- `deals.mjs`: demo deal workflow and draft validation.
- `data.mjs`: fictional cohort summaries and pure comparison functions.
- `data.test.mjs`: quantile, validation, filtering and CSV tests.
- `styles.css`: responsive design system; no animation.

Sites identity and static deployment configuration are in `.openai/hosting.json`.
