# Mainnet pilot verification

Release date: November 11, 2026. Mainnet pilot limit: **100 USDC per payment**. The funded devnet release gate is complete; mainnet activation and post-activation read-only verification are in progress.

## Funded devnet evidence

The complete flow used test SOL and test USDC. All three transactions finalized:

| Operation | Amount | Finalized devnet transaction |
| --- | --- | --- |
| Deposit into Rings | 1 test USDC | [Deposit](https://explorer.solana.com/tx/DWFG8EuoNiCFvRj2AWgfUAoiGLpwBiSoX838JwBdLJCmgGuuXFxkddpLqdEDbBhVkcevxqenkZ9YFhYaQQKVkXL?cluster=devnet) |
| Confidential sponsorship payment | 0.05 test USDC | [Payment](https://explorer.solana.com/tx/2W7uD55eSWkR4MA4HdfeCFKJvqDVH5pt6PBN22XgBvfsHhdPF5XnpeYRAmfHkPWHGPD16U1ZHMKkFnpsodo4SnuQ?cluster=devnet) |
| Recipient withdrawal to its public wallet | 0.05 test USDC | [Withdrawal](https://explorer.solana.com/tx/w7xHDE4LQzexBPAiEbauvuHeab2PgMhQro8qwjasvcSPHWkXGbQgywehHyCw8kcPGDB6DJjg1Z9HVsjSw5wMdgY?cluster=devnet) |

The deployed server issued a verified payment receipt after checking finalized chain evidence against the agreed terms, exact amount, mint, payer, recipient, and encrypted intent memo. The confidential amount is validated by that receipt and transaction-scoped disclosure; the public explorer does not expose every private transfer detail.

After withdrawal, the recipient's private balance was zero and its public USDC balance had increased by 0.05. Deposit and payment retries reused the original journaled transactions; no duplicate payments were made.

The funded run uncovered and resolved three release blockers: the backend's decoding of actual SDK version 1 transaction headers; conservative withdrawal expiry and recovery checks; and spending received outputs carrying an encrypted memo without changing their commitments or stripping the memo. Regression coverage is included in the **107 passing tests**.

## Mainnet verification and limits

The post-activation check is **pending**. Its scope is read-only chain access through the authenticated production proxy, plus ephemeral wallet login, unsigned draft creation/deletion, and session revocation. It will check the full mainnet genesis hash, canonical USDC registry, signed prover attestation, and 136 pinned proving keys. It will not sign a transaction, request a proof, deposit, approve an agreement, or broadcast a payment.

No real mainnet transfer has been tested. The application has not received an independent external security audit. Devnet settlement and automated tests establish the tested flows, not an assurance that every production failure mode has been covered.

Mainnet uses a separate database, an explicit payment cap, and a pause control that preserves saved-payment reconciliation and withdrawals. Pending-payment recovery retains the original signed transaction. Database recovery must preserve payment locks and the separately stored disclosure-encryption key; see the [backup and recovery runbook](backup-recovery.md).
