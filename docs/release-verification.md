# Mainnet pilot verification

Release date: November 11, 2026. Mainnet pilot limit: **100 USDC per payment**. The funded devnet release gate, mainnet activation, and post-activation verification are complete.

## Funded devnet evidence

The complete flow used test SOL and test USDC. All three transactions finalized:

| Operation | Amount | Finalized devnet transaction |
| --- | --- | --- |
| Deposit into Rings | 1 test USDC | [Deposit](https://explorer.solana.com/tx/DWFG8EuoNiCFvRj2AWgfUAoiGLpwBiSoX838JwBdLJCmgGuuXFxkddpLqdEDbBhVkcevxqenkZ9YFhYaQQKVkXL?cluster=devnet) |
| Confidential sponsorship payment | 0.05 test USDC | [Payment](https://explorer.solana.com/tx/2W7uD55eSWkR4MA4HdfeCFKJvqDVH5pt6PBN22XgBvfsHhdPF5XnpeYRAmfHkPWHGPD16U1ZHMKkFnpsodo4SnuQ?cluster=devnet) |
| Recipient withdrawal to its public wallet | 0.05 test USDC | [Withdrawal](https://explorer.solana.com/tx/w7xHDE4LQzexBPAiEbauvuHeab2PgMhQro8qwjasvcSPHWkXGbQgywehHyCw8kcPGDB6DJjg1Z9HVsjSw5wMdgY?cluster=devnet) |

The deployed server issued a verified payment receipt after checking finalized chain evidence against the agreed terms, exact amount, mint, payer, recipient, and encrypted intent memo. The confidential amount is validated by that receipt and transaction-scoped disclosure; the public explorer does not expose every private transfer detail.

After withdrawal, the recipient's private balance was zero and its public USDC balance had increased by 0.05. Deposit and payment retries reused the original journaled transactions; no duplicate payments were made.

Release verification uncovered and resolved three blockers: the backend's decoding of actual SDK version 1 transaction headers; conservative withdrawal expiry and recovery checks; and spending received outputs carrying an encrypted memo without changing their commitments or stripping the memo. Regression coverage is included in the **107 passing tests**.

## Mainnet verification and limits

Post-activation verification **passed** on the public production domain. It covered ephemeral wallet login, secure HttpOnly sessions, unsigned draft persistence and cleanup, and logout revocation. Read-only checks through the authenticated production proxy verified the full mainnet genesis hash, canonical USDC registry, signed prover attestation, and all 136 pinned proving keys. The live interface displayed Mainnet. The reconciliation endpoint rejected unauthenticated requests and accepted the server credential with no errors or pending payments.

These checks did not sign a transaction, request a proof, deposit, approve an agreement, or broadcast a payment. The temporary unsigned draft and active session were removed.

No real mainnet transfer has been tested. The application has not received an independent external security audit. Devnet settlement and automated tests establish the tested flows, not an assurance that every production failure mode has been covered.

Mainnet uses a separate database, an explicit payment cap, and a pause control that preserves saved-payment reconciliation and withdrawals. Pending-payment recovery retains the original signed transaction. Database recovery must preserve payment locks and the separately stored disclosure-encryption key; see the [backup and recovery runbook](backup-recovery.md).
